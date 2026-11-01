import type { Escalation, Task, VerificationMethod } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { VerificationReport } from '../verification/verifier';
import { RETIRED_BY_QUARANTINE, TestService, checkName } from '../verification/test-service';
import { retireOwnTests, splitChecks } from '../verification/check-edits';
import { ACTIVE, TERMINAL, dependenciesMet } from '../tasks/task-graph';
import { FIX_PREFIX, MAX_FIX_TASKS, STUCK_TITLE, answerPlan, checkRef, isFixTask, repairChecks, triageFailures } from './regression-policy';

/** Title of the note on a repair task that records which tests it was created for (survives edits to its checks). */
export const REPAIR_TARGETS = 'Repair targets';

/**
 * Another objective's (or a stand-alone task's) work is in flight in the same place, or a plan change is
 * being made: the full regression suite would test a place that is mid-change (a frozen check of a replaced
 * task once failed against a map import still running). Returns what is going on, or null.
 */
export function otherWorkInFlight(p: ProjectContext, objectiveId: string): string | null {
  const all = p.tasks.list();
  const byId = new Map(all.map((t) => [t.id, t]));
  const titleOf = (t: Task) => {
    const parent = t.parentId ? byId.get(t.parentId) : null;
    return `"${t.title}"${parent ? ` of "${parent.title}"` : ''}`;
  };
  for (const t of all) {
    if (t.kind === 'objective' || t.parentId === objectiveId) continue;
    if (t.kind === 'plan' && (t.status === 'ready' || t.status === 'running')) return `a plan change (${titleOf(t)}) is under way`;
    if (ACTIVE.has(t.status)) return `${titleOf(t)} is in progress`;
    const runnable = t.status === 'ready' && dependenciesMet(t, (d) => byId.get(d));
    if (runnable) return `${titleOf(t)} is about to start`;
  }
  return null;
}

export interface FailureOutcome {
  /** 'repair': one repair task was created; 'escalated': the user was asked; 'proceed': every failure was quarantined. */
  action: 'repair' | 'escalated' | 'proceed';
  /** Registered names of the tests quarantined by this call. */
  quarantined: string[];
}

/** What the objective wrap-up does about a failed suite (see regression-policy.ts for the rules). */
export function handleRegressionFailure(p: ProjectContext, obj: Task, children: readonly Task[], report: VerificationReport, maxAttempts: number, autonomous = false): FailureOutcome {
  const tests = new TestService(p.store);
  const failing = report.results.filter((r) => r.passed === false);
  const fixes = children.filter(isFixTask);
  const repaired = new Set<string>();
  for (const f of fixes) {
    for (const m of f.verification) {
      const ref = checkRef(m);
      if (ref) repaired.add(ref);
    }
    for (const ev of p.tasks.evidence(f.id)) if (ev.title === REPAIR_TARGETS) for (const id of (ev.data as { testIds?: string[] } | null)?.testIds ?? []) repaired.add(id);
  }
  const triage = triageFailures(failing, repaired);
  const lastFix = fixes[fixes.length - 1];
  const quarantined = quarantine(p, tests, triage.quarantine, lastFix ? `Still failing after the repair task "${lastFix.title}"` : 'Still failing after its repair task');

  const stuck = fixes.length > 0 && triage.untracked.length > 0;
  const exhausted = fixes.length >= MAX_FIX_TASKS && triage.repair.length > 0;
  const needsRepair = triage.repair.length > 0 || (fixes.length === 0 && triage.untracked.length > 0);
  if (!needsRepair && !stuck) return { action: 'proceed', quarantined };

  if (stuck || exhausted) {
    const asked = p.governance.escalations().some((e) => e.taskId === obj.id && e.title.startsWith(STUCK_TITLE));
    if (asked && !stuck) {
      // The user was asked once and said carry on, and these checks still fail: quarantine them rather than loop.
      const ids = triage.repair.flatMap((r) => r.testIds ?? []);
      quarantined.push(...quarantine(p, tests, ids, `Still failing after ${fixes.length} repair task${fixes.length === 1 ? '' : 's'} and your answer`));
      return { action: 'proceed', quarantined };
    }
    const left = [...triage.repair, ...triage.untracked];
    if (autonomous) {
      // Autonomous mode never parks on the user: what still fails is quarantined, recorded, and the objective goes on.
      quarantined.push(...quarantine(p, tests, left.flatMap((r) => r.testIds ?? []), `Still failing after ${fixes.length} repair task${fixes.length === 1 ? '' : 's'}`));
      p.governance.autoResolve({
        kind: 'failure',
        title: `${STUCK_TITLE}: "${obj.title}"`,
        detail: [
          `${fixes.length} repair task${fixes.length === 1 ? '' : 's'} later, the regression suite still fails for ${left.map((r) => r.name).join(', ')}.`,
          '',
          ...left.map((r) => `[${r.name}]\n${r.output.slice(0, 600)}`),
        ].join('\n').slice(0, 8000),
        taskId: obj.id,
        response: 'Quarantined the checks that still fail and carried on. Turn one back on from the Tests list once its cause is fixed.',
      });
      return { action: 'proceed', quarantined };
    }
    p.governance.escalate({
      kind: 'failure',
      title: `${STUCK_TITLE}: "${obj.title}"`,
      detail: [
        `${fixes.length} repair task${fixes.length === 1 ? '' : 's'} later, the regression suite still fails for ${left.map((r) => r.name).join(', ')}.`,
        'If a check no longer applies (it tests work that was replaced, or contradicts another check), answer "retire <its name>"; a retired check stops running and the suite runs again. "retry" runs the suite again as it is.',
        '',
        ...left.map((r) => `[${r.name}]\n${r.output.slice(0, 600)}`),
      ].join('\n').slice(0, 8000),
      taskId: obj.id,
      options: ['retry', 'cancel'],
    });
    return { action: 'escalated', quarantined };
  }

  // Exactly one repair task per objective is open at a time (the wrap-up only runs when none is).
  if (fixes.some((f) => !TERMINAL.has(f.status))) return { action: 'repair', quarantined };
  const targets = [...triage.repair, ...(fixes.length === 0 ? triage.untracked : [])];
  const fix = p.tasks.create({
    parentId: obj.id,
    kind: 'implement',
    title: `${FIX_PREFIX} (${targets.length})`,
    objective: [
      "The regression suite failed after completing the objective's tasks. Fix the failures without breaking verified behavior.",
      '',
      targets.map((f) => `[${f.name}]\n${f.output}`).join('\n\n').slice(0, 6000),
      '',
      'This is the only repair task this objective gets for these checks: a check that still fails afterwards is quarantined. A check that no state of the game can pass (it tests work that was replaced or dropped, or it contradicts another check) is not yours to loop on: retire it with test_retire (test_list finds it), or change a task\'s checks with task_update_verification, and say in your result what you retired and why.',
    ].join('\n'),
    reason: 'Recurring regressions are not allowed.',
    // QA owns the tests, so this role can settle a contradiction between checks (test_retire / task_update_verification).
    role: 'qa-engineer',
    status: 'ready',
    priority: 99,
    acceptanceCriteria: [
      'All previously passing tests pass again',
      'No new console errors during playtests',
      'A failing check that encodes an outdated assumption or contradicts another check is retired with a recorded reason (test_retire), not satisfied by breaking the design',
    ],
    // The repair is verified by the very checks that failed, by reference: their current spec runs, and a retired one is skipped.
    verification: [{ kind: 'static_analysis' }, ...repairChecks(tests.list(), targets), { kind: 'critic' }],
    createdBy: 'executive',
    maxAttempts,
  });
  p.tasks.addEvidence({ taskId: fix.id, runId: null, kind: 'note', title: REPAIR_TARGETS, passed: null, data: { testIds: targets.flatMap((r) => r.testIds ?? []), checks: targets.map((r) => r.name) }, path: null });
  return { action: 'repair', quarantined };
}

/** Disables tests that still fail after their repair, with a note on the timeline (and the chat, see Director). */
function quarantine(p: ProjectContext, tests: TestService, ids: readonly string[], why: string): string[] {
  const done = [...new Set(ids)].map((id) => tests.retire(id, `${why}: quarantined so it no longer blocks the objective. Turn it back on from the Tests list once its cause is fixed.`, RETIRED_BY_QUARANTINE)).filter((t): t is NonNullable<typeof t> => !!t);
  if (done.length) {
    const label = [...new Set(done.map((t) => checkName(t.spec)))];
    p.audit.event({
      kind: 'test.quarantined',
      severity: 'warning',
      title: `Quarantined ${label.length === 1 ? `regression test ${label[0]}` : `${label.length} regression tests (${label.slice(0, 3).join(', ')}${label.length > 3 ? ', …' : ''})`}: still failing after its repair, so it no longer blocks the objective`,
      role: 'executive',
      detail: { why, tests: done.map((t) => ({ id: t.id, name: t.name, task: t.taskId })) },
    });
  }
  return done.map((t) => t.name);
}

// ─── Answers ─────────────────────────────────────────────────────────────────

export interface AnswerEffect {
  /** The answer retired or dropped something. */
  acted: boolean;
  /** The task the question was about has nothing left to do (a repair task whose checks are all retired). */
  moot: boolean;
}

/**
 * The user answered a question about a failing check ("Retire road_not_green", "Drop it from this task's
 * verification"): do it, instead of just re-queueing the task into the same failure. A named test is retired
 * (with the answer as the reason); "from this task's verification" drops the check from that task only (and for
 * a repair task, whose only job was that check, retires it too).
 */
export function applyTestAnswer(p: ProjectContext, e: Escalation, task: Task): AnswerEffect {
  const none = { acted: false, moot: false };
  const response = (e.response ?? '').trim();
  if (!response || e.status !== 'answered') return none;
  const svc = new TestService(p.store);
  const plan = answerPlan(response, svc.list(), `${e.title}\n${e.detail}\n${task.title}`);
  if (!plan) return none;
  const reason = `The user answered "${response.slice(0, 200)}" to "${e.title}"`;
  const fix = isFixTask(task);
  const retired = plan.scope === 'global' || fix || task.kind === 'objective' ? plan.tests.map((t) => svc.retire(t.id, reason, 'user')).filter((t): t is NonNullable<typeof t> => !!t) : [];
  let dropped: VerificationMethod[] = [];
  let current = task;
  if (task.kind !== 'objective') {
    const split = splitChecks(task, plan.tests.flatMap((t) => [t.id, t.name, checkName(t.spec)]));
    if (split.dropped.length) {
      dropped = split.dropped;
      current = p.tasks.update(task.id, { verification: split.kept });
      if (!fix) retireOwnTests(p, task, dropped, reason, 'user');
    }
  }
  if (retired.length) {
    p.audit.event({ kind: 'test.retired', severity: 'info', title: `Retired regression test ${[...new Set(retired.map((t) => checkName(t.spec)))].join(', ')} at your answer`, taskId: task.id, role: 'user', detail: { reason, tests: retired.map((t) => ({ id: t.id, name: t.name })) } });
  }
  if (dropped.length) {
    p.audit.event({ kind: 'task.verification', severity: 'info', title: `Dropped ${dropped.map(checkName).join(', ')} from the checks of "${task.title}" at your answer`, taskId: task.id, role: 'user', detail: { reason } });
  }
  if (!retired.length && !dropped.length) return none;
  const left = current.verification.filter((m) => m.kind !== 'critic' && m.kind !== 'static_analysis');
  const moot = fix && left.every((m) => {
    const ref = checkRef(m);
    return !!ref && !!svc.get(ref)?.retiredAt;
  });
  return { acted: true, moot };
}
