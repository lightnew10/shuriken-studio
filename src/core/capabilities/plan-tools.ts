import { DEFAULT_POLISH, followUpRoom, readFollowUpCounts, triageKind, type PolishLevel } from '../orchestrator/proposal-triage';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import { ROLES } from '../agents/roles';
import { normalizeVerification } from '../orchestrator/orchestrator';
import type { Task } from '@shared/domain';
import { claimWarnings, dependencyWarnings, planNodes, strictWarnings } from '../orchestrator/plan-checks';
import { dirTest } from '../orchestrator/file-claims';
import { COMPLETE, STUCK, dependencyMet } from '../tasks/task-graph';
import { TestService } from '../verification/test-service';
import { lintChecks } from '../verification/probe-lint';
import { errorOutput, jsonOutput, textOutput, type ToolRegistry } from './tool-registry';
import { appendPlannerNote, readPlannerNotes, rewritePlannerNotes } from '../orchestrator/planner-notes';
import { isDecisionTask, usersOwn } from '../orchestrator/autonomy';

export interface PlanToolDeps {
  project: () => ProjectContext | null;
  bus: EventBus;
  /** Wake the scheduler so a task whose dependencies are met starts right away. */
  kick: () => void;
  /** Stops the agent working on a task now and cancels the task (work the user's change replaces). */
  stop?: (taskId: string, reason: string) => void;
  /** How much work a goal's follow-ups may add to its plan (orchestrator/proposal-triage.ts FOLLOW_UP_BUDGET). */
  polish?: () => PolishLevel;
}

const verification = z.array(z.record(z.string(), z.unknown()));

/**
 * Live planning: the planner adds tasks (independent ones together, in one turn) and each starts as
 * soon as its dependencies are met, instead of the whole plan waiting for the planner to finish. Keys
 * are scoped to the objective, so later plan steps (and amendments) can depend on earlier ones.
 */
/** Whether `text` refers to plan key `key` as a task (not as an ordinary word). */
export function explicitTaskReference(text: string, key: string): boolean {
  const e = key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const quoted = new RegExp(`["'\`]${e}["'\`]`, 'i');
  const named = new RegExp(`\\btask\\s+["'\`]?${e}\\b|\\b${e}["'\`]?\\s+task\\b`, 'i');
  const distinctive = /[-_0-9]/.test(key) && new RegExp(`(^|[^\\w-])${e}([^\\w-]|$)`, 'i').test(text);
  return quoted.test(text) || named.test(text) || distinctive;
}

/** The dependencies that still keep `task` from starting, by title: "(reviewed)" marks one it waits to be done for. */
function waitsFor(p: ProjectContext, task: Task): string[] {
  return task.dependencies
    .map((id) => ({ dep: p.tasks.get(id), strict: task.strictDependencies?.includes(id) ?? false }))
    .filter((x) => x.dep && !dependencyMet(x.dep, x.strict))
    .map((x) => `${x.dep!.title}${x.strict ? ' (reviewed)' : ''}`);
}

export function registerPlanTools(reg: ToolRegistry, d: PlanToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open');
    return p;
  };

  // The planner's notes for the whole project (orchestrator/planner-notes.ts): read, add a note, or rewrite them.
  reg.register({
    name: 'planner_notes',
    title: "The planner's notes",
    description:
      "Your notes for this whole project (every planning job reads them): the user's standing instructions and the decisions worth keeping. action \"read\" returns them; \"add\" appends one plain sentence (a decision you made that later jobs must respect, something the user wants from now on); \"rewrite\" replaces them with `text` (merge and drop what no longer holds; never drop a user's instruction they haven't withdrawn). Keep them short: they go into every planning job.",
    capability: 'app.tasks',
    permission: 'read',
    input: { action: z.enum(['read', 'add', 'rewrite']), text: z.string().max(8000).optional() },
    handler: async ({ args }) => {
      const p = d.project();
      if (!p) return errorOutput('No project is open');
      if (args.action === 'read') return textOutput(readPlannerNotes(p) || '(no notes yet)');
      if (!args.text?.trim()) return errorOutput('Give the note in "text".');
      if (args.action === 'add') return textOutput(`Noted: ${appendPlannerNote(p, 'planner', args.text)}`);
      return textOutput(`Your notes now read:\n${rewritePlannerNotes(p, args.text)}`);
    },
  });

  reg.register({
    name: 'plan_add_task',
    title: 'Add a task to the plan',
    description:
      "Add one task to the plan of the objective you are planning. Add tasks in dependency order: dependsOn lists keys of tasks you already added (or ids of existing tasks) and is only for tasks whose output this one literally consumes. Tasks that do not depend on each other can be added in the same turn (parallel calls). A task starts as soon as the work of its dependencies exists (their agents finished; their checks and review still run), while you continue planning; strictDependsOn names the dependencies it must wait to be reviewed (done) for: only final test and QA tasks. Returns the task id and when it starts. When a dependency only adds waiting (a chain deeper than 3, an asset task — sounds, effects, clips, UI — waiting for code, QA waiting for QA) the result carries a WARNING: the task is added anyway; drop the dependency with plan_drop_dependency unless the task really consumes that output. files: the exact files the task writes (two tasks naming the same file take turns; a folder keeps nobody out, and a folder another task also lists comes back under FILES: fix it with plan_set_files).",
    capability: 'app.tasks',
    permission: 'read',
    input: {
      key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'short key: letters, digits, _ or -'),
      title: z.string().min(3).max(120),
      kind: z.enum(['implement', 'research', 'test', 'document']).optional(),
      role: z.string(),
      objective: z.string().min(20),
      reason: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).min(1),
      verification,
      dependsOn: z.array(z.string()),
      strictDependsOn: z.array(z.string()).optional().describe('The entries of dependsOn that must be done (checked and reviewed) before this task starts. Only for final test and QA tasks; everything else starts when the work exists.'),
      files: z.array(z.string()).optional(),
      robloxSystems: z.array(z.string()).optional(),
      requiredSkills: z.array(z.string()).optional(),
      priority: z.number().min(0).max(100).optional(),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const planTask = caller.taskId ? p.tasks.get(caller.taskId) : null;
      const objectiveId = planTask?.kind === 'plan' ? planTask.parentId : null;
      if (!objectiveId) return errorOutput('plan_add_task is only available while planning an objective.');
      if (p.tasks.byPlanKey(objectiveId, args.key)) return errorOutput(`Key "${args.key}" is already used in this plan; pick another.`);
      // A triage run adds no more than its goal's budget for follow-ups allows (this call is counted already: it
      // is recorded as pending while it runs, so calls made side by side see each other).
      const triage = triageKind(planTask!.title);
      if (triage) {
        const room = followUpRoom(readFollowUpCounts(p.store, objectiveId), d.polish?.() ?? DEFAULT_POLISH);
        const used = triage === 'polish' ? room.polish : room.defects;
        const budget = triage === 'polish' ? room.budget.polish : room.budget.defects;
        if (used > budget) {
          return errorOutput(
            triage === 'polish'
              ? `Not added: this goal's polish budget is used (${budget} task${budget === 1 ? '' : 's'} for a plan of ${room.planned}). Cancel the remaining proposals with plan_cancel_task (reason: polish budget used) and finish.`
              : `Not added: this goal's tasks for reported defects are used up (${budget} for a plan of ${room.planned}). Cancel the remaining reports with plan_cancel_task (reason: budget used) and finish; if one of them makes the game unplayable, say so in your summary.`,
          );
        }
      }
      const role = ROLES[args.role] ? args.role : null;
      const NOT_FOR_TASKS = ['director', 'executive', 'critic', 'suggester', 'ideas', 'thumb-judge', 'ui-phone-reviewer', 'plain-words'];
      if (!role || NOT_FOR_TASKS.includes(role)) {
        return errorOutput(`Unknown role "${args.role}". Use one of: ${Object.keys(ROLES).filter((r) => !NOT_FOR_TASKS.includes(r)).join(', ')}.`);
      }
      // QA passes off for this window (Settings → Agents): no task whose whole job is testing other tasks.
      if (role === 'qa-engineer' && p.settings().autoQa === false) {
        return errorOutput('Not added: this window has QA passes turned off. Every task keeps its own checks and the critic; plan without a separate QA task.');
      }
      const deps: string[] = [];
      /** How the planner named each task it depends on (for the hint that drops one). */
      const refs = new Map<string, string>();
      for (const ref of args.dependsOn) {
        const byKey = p.tasks.byPlanKey(objectiveId, ref);
        const byId = byKey ?? p.tasks.get(ref);
        if (!byId || (byId.parentId !== objectiveId && byId.id !== objectiveId)) {
          return errorOutput(`dependsOn "${ref}" is not a task of this plan. Add dependencies before the tasks that need them.`);
        }
        if (byId.status === 'cancelled') return errorOutput(`dependsOn "${ref}" was cancelled (it can never complete); depend on the task that replaced it, or on nothing.`);
        deps.push(byId.id);
        refs.set(byId.id, ref);
      }
      const strict: string[] = [];
      for (const ref of args.strictDependsOn ?? []) {
        const i = args.dependsOn.indexOf(ref);
        if (i < 0) return errorOutput(`strictDependsOn "${ref}" is not in dependsOn: it marks which of the dependencies must be reviewed first, so list it in both.`);
        strict.push(deps[i]!);
      }
      // A task may NAME another task without waiting for it: side-by-side tasks work from the shared spec and wire
      // up when both exist. (An objective that mentioned another task used to be refused until it depended on it:
      // seven refused calls in the user's three builds, each one pushing the planner to chain tasks.)
      const kind = args.kind ?? 'implement';
      // A probe that runs on a side where what it uses doesn't exist could never pass: refused, with where it belongs.
      const refused = lintChecks(normalizeVerification(args.verification as never, kind));
      if (refused) return errorOutput(`${refused} The task was not added: fix the check and add it again.`);
      const created = p.tasks.create({
        parentId: objectiveId,
        kind,
        title: args.title,
        objective: args.objective,
        reason: args.reason ?? '',
        role,
        status: 'ready',
        priority: Math.round(args.priority ?? 50),
        acceptanceCriteria: args.acceptanceCriteria,
        verification: normalizeVerification(args.verification as never, kind),
        requiredSkills: args.requiredSkills ?? [],
        files: args.files ?? [],
        robloxSystems: args.robloxSystems ?? [],
        dependencies: deps,
        strictDependencies: strict,
        createdBy: 'executive',
        maxAttempts: p.settings().maxAttemptsPerTask,
        planKey: args.key,
      });
      d.kick();
      const waitingOn = waitsFor(p, created);
      // Dependencies that only add waiting: the task stays (a few are justified), the planner is told why.
      refs.set(created.id, args.key);
      const nodes = planNodes(p.tasks.list({ parentId: objectiveId }), refs);
      const warnings = [...dependencyWarnings(nodes.get(created.id)!, nodes), ...strictWarnings(nodes.get(created.id)!, nodes)].map((w) => w.message);
      // A folder another task also claims: nobody waits, but the two agents share its files.
      const shared = claimWarnings(nodes.get(created.id)!, nodes, dirTest(p.root)).map((w) => w.message);
      return jsonOutput({
        id: created.id,
        key: args.key,
        starts: waitingOn.length ? `after: ${waitingOn.join(', ')}` : 'now',
        ...(warnings.length ? { WARNING: `The task was added, but its dependencies only add waiting:\n- ${warnings.join('\n- ')}` } : {}),
        ...(shared.length ? { FILES: `The task was added, but it shares a folder:\n- ${shared.join('\n- ')}` } : {}),
      });
    },
  });

  reg.register({
    name: 'plan_set_files',
    title: "Set a planned task's files",
    description:
      "Replace the files of a task of this plan that has not started: use it when plan_add_task answered that the task shares a folder with another task. List the exact files the task writes. Two tasks that name the same file take turns; a folder keeps nobody out.",
    capability: 'app.tasks',
    permission: 'read',
    input: {
      task: z.string().describe('Task key or id'),
      files: z.array(z.string()),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const planTask = caller.taskId ? p.tasks.get(caller.taskId) : null;
      const objectiveId = planTask?.kind === 'plan' ? planTask.parentId : null;
      if (!objectiveId) return errorOutput('plan_set_files is only available while planning an objective.');
      const t = p.tasks.byPlanKey(objectiveId, args.task) ?? p.tasks.get(args.task);
      if (!t || t.parentId !== objectiveId) return errorOutput(`No task "${args.task}" in this plan.`);
      if (!['ready', 'proposed', 'blocked', 'paused'].includes(t.status)) return errorOutput(`"${t.title}" is ${t.status}: only a task that has not started can change its files.`);
      p.tasks.update(t.id, { files: args.files });
      d.kick();
      const nodes = planNodes(p.tasks.list({ parentId: objectiveId }), new Map([[t.id, args.task]]));
      const shared = claimWarnings(nodes.get(t.id)!, nodes, dirTest(p.root)).map((w) => w.message);
      return jsonOutput({ task: t.id, title: t.title, files: args.files, ...(shared.length ? { FILES: `It still shares a folder:\n- ${shared.join('\n- ')}` } : {}) });
    },
  });

  reg.register({
    name: 'plan_drop_dependency',
    title: 'Drop a dependency of a planned task',
    description:
      "Remove one dependency from a task of this plan that has not started: use it when plan_add_task warned that the dependency only adds waiting (the task does not literally consume the other task's output). The task starts as soon as the work of its remaining dependencies exists. strictOnly: keep the dependency and drop only its strictness (the task then starts when that work exists instead of after its review).",
    capability: 'app.tasks',
    permission: 'read',
    input: {
      task: z.string().describe('Task key or id'),
      dependsOn: z.string().describe('Key or id of the dependency to drop'),
      strictOnly: z.boolean().optional().describe('Keep the dependency; only stop waiting for its review.'),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const planTask = caller.taskId ? p.tasks.get(caller.taskId) : null;
      const objectiveId = planTask?.kind === 'plan' ? planTask.parentId : null;
      if (!objectiveId) return errorOutput('plan_drop_dependency is only available while planning an objective.');
      const t = p.tasks.byPlanKey(objectiveId, args.task) ?? p.tasks.get(args.task);
      if (!t || t.parentId !== objectiveId) return errorOutput(`No task "${args.task}" in this plan.`);
      const dep = p.tasks.byPlanKey(objectiveId, args.dependsOn) ?? p.tasks.get(args.dependsOn);
      if (!dep || !t.dependencies.includes(dep.id)) return errorOutput(`"${t.title}" does not wait for "${args.dependsOn}".`);
      if (!['ready', 'proposed', 'blocked', 'paused'].includes(t.status)) return errorOutput(`"${t.title}" is ${t.status}: only a task that has not started can lose a dependency.`);
      if (args.strictOnly) {
        p.tasks.setDependencyStrict(t.id, dep.id, false);
        d.kick();
        const waits = waitsFor(p, p.tasks.require(t.id));
        return jsonOutput({ task: t.id, title: t.title, noLongerStrict: dep.title, starts: waits.length ? `after: ${waits.join(', ')}` : 'now' });
      }
      p.tasks.removeDependency(t.id, dep.id);
      const left = t.dependencies.filter((id) => id !== dep.id).map((id) => p.tasks.get(id));
      // A task that was blocked only because of that dependency (cancelled, escalated) is free again.
      if (t.status === 'blocked' && !left.some((x) => !x || STUCK.has(x.status))) p.tasks.setStatus(t.id, 'ready', `Dependency "${dep.title}" dropped by the planner`, 'executive');
      d.kick();
      const waitingOn = waitsFor(p, p.tasks.require(t.id));
      return jsonOutput({ task: t.id, title: t.title, dropped: dep.title, starts: waitingOn.length ? `after: ${waitingOn.join(', ')}` : 'now' });
    },
  });

  reg.register({
    name: 'plan_cancel_task',
    title: 'Cancel a planned task',
    description:
      "Cancel a task of this objective that the user's change makes obsolete. A task that hasn't started is simply cancelled. One that is running or in review now is cancelled with stop: true when the change replaces what it is building (the user wants it redone, reworked or dropped): its agent stops at once so the new version starts now instead of after it — what it made so far stays for the new task to build on. replaced_by (the new task's id or plan key): tasks that waited for the cancelled one wait for its replacement instead. Finished tasks stay.",
    capability: 'app.tasks',
    permission: 'read',
    input: {
      task: z.string().describe('Task id or plan key'),
      reason: z.string(),
      stop: z.boolean().optional().describe('Also stop and cancel it when it is running or in review (work the change replaces).'),
      replaced_by: z.string().optional().describe('The task that replaces it (id or plan key): its dependents wait for that one instead.'),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const planTask = caller.taskId ? p.tasks.get(caller.taskId) : null;
      const objectiveId = planTask?.kind === 'plan' ? planTask.parentId : null;
      if (!objectiveId) return errorOutput('plan_cancel_task is only available while planning an objective.');
      const t = p.tasks.byPlanKey(objectiveId, args.task) ?? p.tasks.get(args.task);
      if (!t || t.parentId !== objectiveId) return errorOutput(`No task "${args.task}" in this plan.`);
      const next = args.replaced_by ? (p.tasks.byPlanKey(objectiveId, args.replaced_by) ?? p.tasks.get(args.replaced_by)) : null;
      if (args.replaced_by && (!next || next.parentId !== objectiveId)) return errorOutput(`No task "${args.replaced_by}" in this plan to replace it with (add the new task first).`);
      // A decision about a stuck task never drops one the user asked for or put first: it retries it differently, or it
      // replaces it with a task that does the same job; otherwise the user is asked (autonomy.ts usersOwn).
      if (planTask && isDecisionTask(planTask) && usersOwn(p, t) && !next) {
        return errorOutput(`Not dropped: "${t.title}" is a task the user asked for (or put first). Retry it with a different approach (your summary states it), or replace it with plan_add_task + plan_cancel_task replaced_by; if neither can work, say in your summary that it needs the user.`);
      }
      const inWork = ['running', 'implemented', 'verifying', 'reviewing'].includes(t.status);
      if (inWork) {
        if (!args.stop) return errorOutput(`"${t.title}" is ${t.status}. If the user's change replaces what it is building, cancel it with stop: true (its agent stops now and the new version starts at once); otherwise leave it running.`);
        if (!d.stop) return errorOutput("Running tasks can't be stopped from here.");
        d.stop(t.id, `Replaced by the user's change: ${args.reason}${next ? ` (replaced by "${next.title}")` : ''}`);
      } else if (['ready', 'proposed', 'blocked', 'paused', 'failed', 'escalated'].includes(t.status)) {
        p.tasks.setStatus(t.id, 'cancelled', `Cancelled by the planner: ${args.reason}${next ? ` (replaced by "${next.title}")` : ''}`, 'executive');
      } else return errorOutput(`"${t.title}" is ${t.status}: finished work stays.`);
      // What waited for it waits for its replacement (the replacement itself no longer waits for it).
      const moved: string[] = [];
      if (next)
        for (const x of p.tasks.list({ parentId: objectiveId })) {
          if (!x.dependencies.includes(t.id) || ['done', 'cancelled'].includes(x.status)) continue;
          p.tasks.removeDependency(x.id, t.id);
          try {
            // A dependency that waited for the old task's review waits for the new one's.
            if (x.id !== next.id) p.tasks.addDependency(x.id, next.id, x.strictDependencies?.includes(t.id) ?? false);
          } catch {
            /* the replacement already waits for it: no cycle */
          }
          moved.push(x.title);
        }
      d.kick();
      const retired = new TestService(p.store).list().filter((x) => x.taskId === t.id && x.retiredAt).length;
      return jsonOutput({ cancelled: t.id, title: t.title, ...(inWork ? { stopped: true } : {}), ...(next ? { replacedBy: next.id, nowWaitFor: moved } : {}), ...(retired ? { retiredTests: retired } : {}) });
    },
  });
}
