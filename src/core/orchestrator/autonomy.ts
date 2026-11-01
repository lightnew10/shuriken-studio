import type { Escalation, PermissionMode, Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { TERMINAL } from '../tasks/task-graph';
import { ROLES, type RoleDefinition } from '../agents/roles';
import type { AgentRunner } from './agent-runner';

/**
 * Autonomous permission mode: what used to wait for the app's user is decided by the AI system, logged, and
 * shown as a plain status line in the director's chat (docs/ARCHITECTURE.md, "Permission modes"). Spending money
 * and publishing the game are not here: they always ask (permissions/owner-gate.ts).
 *
 * A stuck task (an agent reported `blocked`, or the attempts ran out) goes to the planner as a small decision
 * task — a plan-update style task under the same objective — which retries it with a different approach, replaces
 * it or drops it. The escalation row is recorded as `auto_resolved` from the start and its response says what was
 * decided once the planner has.
 */

/** Title prefix of the planner task that settles what a stuck task needs. */
export const DECISION_PREFIX = 'Decide: ';
/** Decision runs per task before the task is simply dropped (a task that keeps getting stuck is not worth more). */
export const MAX_AUTO_DECISIONS = 2;
/** Milestones started one after another with no one asking, per project. */
export const MAX_AUTO_MILESTONES = 8;
/** The note on a task the user moved to the front of the queue. */
export const USER_FIRST = 'Put first by the user';

/**
 * Whether a task is the user's: they asked for it directly (a side task, a quick change) or moved it to the front. A
 * decision never drops one of these: on 2026-10-06 the user's prioritised sign fix spent its last attempt in one second
 * with Studio disconnected and was "dropped; the work carries on without it".
 */
export function usersOwn(p: ProjectContext, task: Task): boolean {
  if (task.createdBy === 'user' || task.createdBy === 'director') return true;
  return p.tasks.evidence(task.id).some((e) => e.kind === 'note' && e.title === USER_FIRST);
}

/** Prefix of the objective an automatic "next milestone" starts. */
export const NEXT_MILESTONE_PREFIX = 'Next milestone after';
/** How the brief of a "next milestone" objective begins: it is known by this once its plan has named it. */
export const NEXT_MILESTONE_BRIEF = 'Plan and execute the NEXT milestone of this project';

/** An objective an automatic "next milestone" started (by its title until its plan names it, by its brief after). */
export const isNextMilestone = (t: Pick<Task, 'title' | 'objective'>): boolean => t.title.startsWith(NEXT_MILESTONE_PREFIX) || t.objective.startsWith(NEXT_MILESTONE_BRIEF);

/**
 * The title of the goal after `doneTitle`, never nested: a chain of milestones was titled `Next milestone after "Next
 * milestone after "…""`. The goal is renamed after the milestone its plan names (director/narration.ts).
 */
export function nextMilestoneTitle(doneTitle: string): string {
  let t = doneTitle.replace(/^Milestone \d+:\s*/i, '').trim();
  for (let i = 0; i < 20; i++) {
    const m = /^Next milestone after "(.*)"$/.exec(t);
    if (!m) break;
    t = m[1]!.trim();
  }
  return `${NEXT_MILESTONE_PREFIX} "${t}"`;
}

/** The planner at decision size: a few turns, medium effort, no plan to write. */
export const DECISION_ROLE: RoleDefinition = { ...ROLES.executive!, maxTurns: 14, effort: 'medium', ownEffort: true };

/** What the orchestrator and the agent tools use to answer without a person (see app-tools `escalate`). */
export interface AutonomyHooks {
  mode: () => PermissionMode;
  /** The executive's answer to an agent's question, from the user's request; null when it can't answer. */
  answer: (q: { title: string; detail: string; options?: string[]; role: string | null; taskId: string | null }, signal: AbortSignal) => Promise<string | null>;
}

export const isDecisionTask = (t: Task): boolean => t.kind === 'plan' && t.title.startsWith(DECISION_PREFIX);

/** The task and escalation a decision task settles, from its plan key (`decide:<taskId>:<escalationId>`). */
export function decisionLink(p: ProjectContext, task: Task): { targetId: string; escalationId: string } | null {
  const key = p.store.get<{ plan_key: string | null }>('SELECT plan_key FROM tasks WHERE id = ?', [task.id])?.plan_key ?? '';
  const m = /^decide:([^:]+):([^:]+)$/.exec(key);
  return m ? { targetId: m[1]!, escalationId: m[2]! } : null;
}

/** Decision tasks created for `targetId` so far. */
export function priorDecisions(p: ProjectContext, targetId: string): number {
  return p.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE plan_key LIKE ?', [`decide:${targetId}:%`])?.n ?? 0;
}

/** The objective a task belongs to (itself when it is one), or null. */
export function objectiveOf(p: ProjectContext, task: Task): Task | null {
  let cur: Task | null = task;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.kind === 'objective') return cur;
    cur = cur.parentId ? p.tasks.get(cur.parentId) : null;
  }
  return null;
}

const clip = (s: string | null | undefined, n: number): string => (s ?? '').trim().slice(0, n);

export type HandOffReason = 'blocked' | 'failure';

export interface HandOff {
  reason: HandOffReason;
  /** Short statement of what happened (the agent's summary, or the last failure). */
  summary: string;
  detail: string | null;
  runId: string | null;
}

/** The planner's brief for a decision task. */
export function decisionBrief(task: Task, h: HandOff, attempts: number): string {
  const what = h.reason === 'blocked' ? `An agent reported it is blocked and can't go on` : `It failed ${attempts} time(s) and has no attempts left`;
  return [
    'Nobody is available to ask: the owner has the team work on its own. A task needs a decision, and you make it now, from the user\'s request (your objective and the spec).',
    '',
    `Task: "${task.title}" (id ${task.id}, ${task.role}). ${what}.`,
    'What it was asked to do:',
    clip(task.objective, 1800),
    '',
    'What happened:',
    clip(h.summary, 800),
    h.detail ? clip(h.detail, 2400) : '',
    '',
    'Settle it with exactly ONE of these:',
    '1. RETRY with a different approach (the usual answer; no tools needed): end with a summary stating the different approach (what it should do instead, any answer it was waiting for). The task then runs again with your summary added to its brief.',
    `2. REPLACE it: add the replacement with plan_add_task (another way to the same goal; tasks that waited for the old one then wait for the new one), then plan_cancel_task the old task (${task.id}) with replaced_by.`,
    `3. DROP it, only when the goals of the objective don't need it: plan_cancel_task ${task.id} with the reason; the tasks that waited for it carry on without it.`,
    'Anything it was waiting on a person for (a choice, a name, a style, a number) is yours to decide: take the most reasonable option for the user\'s game and say what you assumed. Never decide to spend money (Robux or paid services) or to publish the game: those only the owner decides, and the task should work without them.',
    'Your summary is shown to the user as a single status line: what you decided and why, in one or two plain sentences, no internal names.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** What a hand-off came to: the planner is deciding, or it was settled without one. */
export interface HandOffResult {
  escalationId: string;
  decisionTaskId: string | null;
  outcome: 'deciding' | 'retried' | 'dropped';
}

/**
 * A stuck task goes to the AI system instead of the user. The escalation is recorded as auto-resolved, the task is
 * parked as `escalated` (not runnable; what waits for it waits) and a decision task is created under its objective.
 * With no objective to hang the decision on, or after MAX_AUTO_DECISIONS decisions about this task, the answer is
 * settled right here: retry once with a note, then drop.
 */
export function handOff(p: ProjectContext, task: Task, h: HandOff): HandOffResult {
  const blocked = h.reason === 'blocked';
  const cur = p.tasks.require(task.id);
  const esc = p.governance.autoResolve({
    kind: blocked ? 'capability_missing' : 'failure',
    title: `${blocked ? 'Blocked' : 'Repeated failure'}: ${task.title}`,
    detail: `${blocked ? 'The agent reported a blocker' : `Failed ${cur.attempts} time(s)`}: ${clip(h.summary, 800)}\n\n${clip(h.detail, 3000)}`.trim(),
    taskId: task.id,
    runId: h.runId,
    options: [],
    response: 'The planner is deciding what to do: retry it a different way, replace it or drop it.',
  });
  if (cur.status !== 'escalated') p.tasks.setStatus(task.id, 'escalated', blocked ? 'Blocked: the planner is deciding what to do (autonomous mode)' : 'Attempts exhausted: the planner is deciding what to do (autonomous mode)', 'executive');
  const prior = priorDecisions(p, task.id);
  const objective = objectiveOf(p, cur);
  if (objective && objective.id !== task.id && prior < MAX_AUTO_DECISIONS) {
    const decision = p.tasks.create({
      parentId: objective.id,
      kind: 'plan',
      title: `${DECISION_PREFIX}${task.title}`.slice(0, 120),
      objective: decisionBrief(cur, h, cur.attempts),
      reason: 'A task is stuck and nobody is available to ask: the planner decides (autonomous mode).',
      role: 'executive',
      status: 'ready',
      priority: 97,
      acceptanceCriteria: ['The stuck task is retried with a different approach, replaced or dropped, and the decision is stated'],
      createdBy: 'executive',
      maxAttempts: 2,
      planKey: `decide:${task.id}:${esc.id}`,
    });
    return { escalationId: esc.id, decisionTaskId: decision.id, outcome: 'deciding' };
  }
  if (prior === 0) {
    retryTask(p, task.id, 'No one is available to answer, so decide for yourself from the user\'s request and the spec, take a different approach from the failed one, and note what you assumed.');
    p.governance.setAutoResolution(esc.id, 'Retrying it with a different approach, deciding the open questions itself.');
    return { escalationId: esc.id, decisionTaskId: null, outcome: 'retried' };
  }
  dropTask(p, task.id, `it got stuck again after ${prior} automatic decision(s)`);
  p.governance.setAutoResolution(esc.id, `Dropped: it got stuck again after ${prior} automatic decision(s); the work carries on without it.`);
  return { escalationId: esc.id, decisionTaskId: null, outcome: 'dropped' };
}

/** Run a stuck task again with a note on what to do differently (two attempts at most: it has had its chances). */
export function retryTask(p: ProjectContext, taskId: string, note: string): void {
  const cur = p.tasks.require(taskId);
  p.tasks.update(cur.id, { objective: `${cur.objective}\n\n[Decision, autonomous mode] ${note}`, maxAttempts: Math.min(cur.maxAttempts, 2) });
  // A failure record, so a fresh run sees the decision under "Previous attempts" (and does not continue the failed session).
  p.tasks.addFailure({ taskId: cur.id, runId: null, attempt: cur.attempts, stage: 'capability', summary: `Decision: ${note}`.slice(0, 1000), detail: null });
  p.tasks.resetAttempts(cur.id);
  if (cur.status !== 'ready') p.tasks.setStatus(cur.id, 'ready', `Retrying after a decision: ${note}`.slice(0, 300), 'executive');
}

/** The tasks that waited for `taskId` stop waiting for it (it is gone) and are told. */
export function releaseDependents(p: ProjectContext, taskId: string): string[] {
  const gone = p.tasks.get(taskId);
  const freed: string[] = [];
  for (const t of p.tasks.list()) {
    if (!t.dependencies.includes(taskId) || TERMINAL.has(t.status)) continue;
    p.tasks.removeDependency(t.id, taskId);
    p.tasks.update(t.id, { objective: `${t.objective}\n\n[Note] The prerequisite task "${gone?.title ?? taskId}" was dropped; work without it, or do the part you need yourself.` });
    if (t.status === 'blocked') p.tasks.setStatus(t.id, 'ready', 'A prerequisite was dropped; carrying on without it', 'executive');
    freed.push(t.title);
  }
  return freed;
}

/** Drop a task for good (cancelled), and let what waited for it go on. */
export function dropTask(p: ProjectContext, taskId: string, why: string): void {
  const cur = p.tasks.require(taskId);
  if (cur.status !== 'cancelled' && cur.status !== 'done') p.tasks.setStatus(cur.id, 'cancelled', `Dropped: ${why}`.slice(0, 300), 'executive');
  releaseDependents(p, cur.id);
}

/**
 * The planner has decided (its summary is the decision). If it replaced or dropped the task with its plan tools the
 * task is cancelled already; otherwise the task is retried with the decision in its brief. Returns the chat sentence.
 */
export function applyDecision(p: ProjectContext, decisionTask: Task, summary: string): string {
  const link = decisionLink(p, decisionTask);
  const text = clip(summary, 600) || 'Trying it again with a different approach.';
  if (!link) return text;
  const target = p.tasks.get(link.targetId);
  let verb: string;
  if (!target) verb = 'Settled';
  else if (target.status === 'cancelled') {
    releaseDependents(p, target.id);
    verb = 'Replaced or dropped';
  } else if (target.status === 'escalated' || target.status === 'blocked' || target.status === 'failed') {
    retryTask(p, target.id, text);
    verb = 'Retrying with a different approach';
  } else verb = 'Already handled';
  const line = `${verb}: ${text}`;
  p.governance.setAutoResolution(link.escalationId, line);
  return line;
}

/**
 * The decision run failed twice: settle it deterministically, the same way a hand-off with no planner does (retry
 * once with a note, then drop).
 */
export function decisionFailed(p: ProjectContext, decisionTask: Task, why: string): void {
  const link = decisionLink(p, decisionTask);
  if (!link || !p.tasks.get(link.targetId)) return;
  const target = p.tasks.require(link.targetId);
  if (target.status === 'cancelled' || target.status === 'done') return;
  const prior = priorDecisions(p, link.targetId);
  if (prior >= MAX_AUTO_DECISIONS) {
    dropTask(p, target.id, `the planner could not settle it (${clip(why, 120)})`);
    p.governance.setAutoResolution(link.escalationId, 'Dropped: the planner could not settle it, and it got stuck again; the work carries on without it.');
  } else {
    retryTask(p, target.id, 'The planner could not settle this, so decide for yourself from the user\'s request and the spec, take a different approach from the failed one, and note what you assumed.');
    p.governance.setAutoResolution(link.escalationId, 'Retrying it with a different approach, deciding the open questions itself.');
  }
}

/** The plain status line the director's chat shows for something settled without asking (no question card). */
export function autoResolvedLine(e: Pick<Escalation, 'kind' | 'title' | 'response'>): string {
  const title = e.title.replace(/\s+/g, ' ').trim();
  const said = (e.response ?? '').replace(/\s+/g, ' ').trim();
  const prefix = e.kind === 'approval' ? 'Went ahead without asking: ' : e.kind === 'spec_change' ? 'Spec change approved automatically: ' : e.kind === 'question' ? 'Decided without asking you: ' : '';
  const head = `${prefix}${e.kind === 'spec_change' ? title.replace(/^Spec change:\s*/, '') : title}`;
  // A question keeps its question mark ("…holds it? Yes: …", not "…holds it?. Yes").
  const asked = head.replace(/[.:]$/, '');
  return said ? `${asked}${/[?!]$/.test(asked) ? '' : '.'} ${said}` : head;
}

// ─── Questions ───────────────────────────────────────────────────────────────

/** What the team knows about what the user wants: the goals they asked for and their latest messages. */
function userIntent(p: ProjectContext): string {
  const goals = p.tasks
    .list({ kinds: ['objective'] })
    .slice(-6)
    .map((o) => `- ${o.title}: ${clip(o.objective, 500)}`);
  const said = p.store
    .all<{ text: string }>("SELECT text FROM chat_messages WHERE channel = 'director' AND role = 'user' ORDER BY created_at DESC LIMIT 8")
    .map((m) => `- ${clip(m.text, 400)}`)
    .reverse();
  const spec = p.governance
    .spec()
    .filter((s) => s.body.trim())
    .map((s) => `## ${s.title}\n${clip(s.body, 700)}`)
    .slice(0, 8);
  return [`The user's goals:\n${goals.join('\n') || '(none yet)'}`, `What the user said lately:\n${said.join('\n') || '(nothing)'}`, spec.length ? `The spec so far:\n${spec.join('\n\n')}` : ''].filter(Boolean).join('\n\n');
}

/**
 * An agent asked the owner a question and nobody is there to answer: the director answers from what the user asked
 * for (a small run, a few turns). Null when it can't (no answer in time); the asking agent then decides for itself.
 */
export async function answerQuestion(runner: AgentRunner, p: ProjectContext, q: { title: string; detail: string; options?: string[]; role: string | null; taskId: string | null }, signal: AbortSignal): Promise<string | null> {
  const task = q.taskId ? p.tasks.get(q.taskId) : null;
  const outcome = await runner.run({
    project: p,
    role: ROLES.director!,
    task: null,
    output: null,
    // Two minutes bound it; a dollar cap would stop it on any big project, whose first pass alone costs about $1.
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    directive: [
      "This is not a chat message: a team member asked the user a question, the user is not available, and you answer for them from what they asked for. Reply with the decision only, in one to three plain sentences (no intent, no JSON). Pick the most reasonable option for the user's game; if they gave options, choose one of them. Never decide to spend money (Robux or paid services) or publish the game.",
      '',
      `Asked by: ${q.role ?? 'an agent'}${task ? ` while working on "${task.title}"` : ''}`,
      `Question: ${q.title}`,
      clip(q.detail, 2500),
      q.options?.length ? `Options: ${q.options.join(' | ')}` : '',
    ]
      .filter((l) => l !== '')
      .join('\n'),
    contextText: userIntent(p),
  });
  const text = outcome.completion.ok ? (outcome.completion.resultText ?? '').trim() : '';
  return text ? text.slice(0, 1500) : null;
}

/** Shown to an agent whose question could not be answered in time. */
export const DECIDE_YOURSELF = "Nobody is available to answer, and the user wants the team to work on its own: decide it yourself from the user's request and the spec, take the most reasonable option, and note what you assumed in your result (decision_record when it shapes the game).";
