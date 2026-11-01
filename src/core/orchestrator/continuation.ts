import type { Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';

/**
 * Picking up an agent's own provider session instead of starting cold.
 *
 * A fresh run rebuilds everything the agent had learned (it re-reads the files, re-explores Studio,
 * re-derives its plan): in the logged runs a rejected animation took 695 s the second time and a
 * turn-limited environment pass started over from nothing after 30 minutes. When a task comes back —
 * the critic or the checks rejected it, it ran out of turns, or it was interrupted — the next run
 * continues the previous run's conversation with a short brief instead, and the critic re-reviews a
 * repair in its own earlier review session. Anything that makes the session unusable (another account,
 * a missing session, a chain that keeps failing) falls back to a fresh run.
 */

/**
 * A session this old is not worth continuing: the project has moved on. A day covers stopping for a
 * usage limit or the night and carrying on the next day.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Continuations in a row before a task starts fresh again. */
const MAX_CHAIN = 3;

export type ContinuationReason = 'repair' | 'turn_limit' | 'interrupted' | 're_review' | 'finish';

export interface Continuation {
  /** The run whose provider session continues. */
  runId: string;
  sessionId: string;
  reason: ContinuationReason;
  /** The new message in that session. */
  brief: string;
}

interface RunRow {
  id: string;
  role: string;
  provider_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  provider_session_id: string | null;
  error: string | null;
  continues_run_id: string | null;
  app_version: string | null;
}

const FINISH_WORK = 'When done, sync and check your work (roblox_sync_push, luau_check), observe the result, and return your structured result describing the whole task’s work, not only this last part.';
const FINISH_PLAN = 'Check with task_list which tasks you already added (they are running or queued), add only the missing ones, and when the plan is complete return your summary as structured output.';
const FINISH_RESEARCH = 'When done, return your conclusion as structured output, covering the whole research question.';
const finishFor = (task: Task): string => (task.kind === 'plan' ? FINISH_PLAN : task.kind === 'research' ? FINISH_RESEARCH : FINISH_WORK);

function runsOf(p: ProjectContext, taskId: string): RunRow[] {
  return p.store.all<RunRow>(
    'SELECT id, role, provider_id, status, started_at, ended_at, provider_session_id, error, continues_run_id, app_version FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 40',
    [taskId],
  );
}

/**
 * The session of `run` can be continued by `providerId` in this app version (recent, not continued too
 * often already). Another version's session is never continued: its tools and instructions may be gone
 * (a 1.7 modeler's session is all build123d calls that 1.8 no longer has).
 */
function usable(runs: RunRow[], run: RunRow | undefined, providerId: string, appVersion: string | null, now: number): run is RunRow & { provider_session_id: string } {
  if (!run?.provider_session_id || run.provider_id !== providerId) return false;
  if (!appVersion || run.app_version !== appVersion) return false;
  if (now - Date.parse(run.ended_at ?? run.started_at) > MAX_AGE_MS) return false;
  let chain = 0;
  for (let r: RunRow | undefined = run; r?.continues_run_id && chain <= MAX_CHAIN; r = runs.find((x) => x.id === r!.continues_run_id)) chain++;
  return chain < MAX_CHAIN;
}

const TURN_LIMIT_RX = /maximum number of turns|max(imum)?[_ ]turns/i;
/** A run cut off by the account's usage limit (the provider adapter's wording, see claude-runner.ts). */
const USAGE_LIMIT_RX = /rate.?limit|\b429\b|usage limit|overloaded|hit your (session|weekly|usage|daily) limit|(session|weekly) limit|limit reached|resets \d{1,2}(:\d{2})?\s*(am|pm)/i;
/** Failures of a run that finished its work but not its report (see Orchestrator.doWork/checkCompletion). */
const NO_RESULT_RX = /no structured result|\(output_schema\)|returned no conclusion|did not add any tasks/i;

/** Continue the implementer's previous run of `task`, when that is what the task needs next. */
export function implementerContinuation(p: ProjectContext, task: Task, providerId: string, appVersion: string | null, now = Date.now()): Continuation | null {
  const runs = runsOf(p, task.id);
  const last = runs.find((r) => r.role === task.role);
  if (!usable(runs, last, providerId, appVersion, now)) return null;
  const base = { runId: last.id, sessionId: last.provider_session_id };
  const finish = finishFor(task);
  if (last.status === 'interrupted') {
    return {
      ...base,
      reason: 'interrupted',
      brief: `Your run was interrupted (work was paused or stopped, or the app restarted). Continue where you left off. Other agents may have changed the project and Studio meanwhile: check what you depend on (git_diff, the files, Studio) before you change anything, and don't redo finished parts. ${finish}`,
    };
  }
  if (last.status === 'failed' && USAGE_LIMIT_RX.test(last.error ?? '')) {
    return {
      ...base,
      reason: 'interrupted',
      brief: `Your run stopped when the account reached its usage limit; there is room again now. Continue where you left off. Other agents may have changed the project and Studio meanwhile: check what you depend on before you change anything, and don't redo finished parts. ${finish}`,
    };
  }
  if (last.status === 'failed' && TURN_LIMIT_RX.test(last.error ?? '')) {
    return {
      ...base,
      reason: 'turn_limit',
      brief: `You reached this run's turn limit before finishing. Continue exactly where you stopped and finish the remaining work efficiently: batch independent tool calls into one turn and skip anything already done. ${finish}`,
    };
  }
  const failure = p.tasks.failures(task.id).at(-1);
  const afterLast = !!failure && Date.parse(failure.createdAt) >= Date.parse(last.ended_at ?? last.started_at);
  // The work was done but the run ended without its structured result: ask for it, don't redo it.
  if (afterLast && failure!.stage === 'implement' && NO_RESULT_RX.test(failure!.summary)) {
    return {
      ...base,
      reason: 'finish',
      brief: `Your run ended without its structured result (${failure!.summary.slice(0, 200)}). Finish anything still undone, and return the structured result in exactly the required format. ${finish}`,
    };
  }
  if (last.status !== 'completed') return null;
  if (!failure || (failure.stage !== 'review' && failure.stage !== 'verify') || !afterLast) return null;
  const who = failure.stage === 'review' ? 'The independent critic reviewed it' : 'The automated checks ran';
  return {
    ...base,
    reason: 'repair',
    brief: [
      `Your work on this task was checked and is not accepted yet (attempt ${task.attempts} of ${task.maxAttempts}). ${who}:`,
      '',
      failure.summary,
      failure.detail ? `\n${failure.detail.slice(0, 8000)}` : '',
      '',
      `Fix exactly these problems. You already know the task, the files and the game: don't start over or redo parts that passed. Other agents may have changed the project since your last turn, so re-read anything you depend on before changing it. ${finish}`,
    ].join('\n'),
  };
}

/** Continue the critic's own review session to re-review a repair (or an interrupted review). */
export function criticContinuation(p: ProjectContext, task: Task, providerId: string, appVersion: string | null, notes: string, now = Date.now()): Continuation | null {
  const runs = runsOf(p, task.id);
  const last = runs.find((r) => r.role === 'critic');
  if (!usable(runs, last, providerId, appVersion, now)) return null;
  const base = { runId: last.id, sessionId: last.provider_session_id };
  if (last.status === 'interrupted') {
    return { ...base, reason: 'interrupted', brief: `Your review was interrupted. Continue it: judge the work against every acceptance criterion using real evidence, and return your structured review.\n\n${notes}` };
  }
  if (last.status !== 'completed') return null;
  // Only a review that failed the work, followed by the implementer's repair.
  const rejected = p.tasks.evidence(task.id).some((e) => e.kind === 'critic_review' && e.runId === last.id && e.passed === false);
  const repaired = runs.some((r) => r.role === task.role && r.status === 'completed' && Date.parse(r.started_at) > Date.parse(last.ended_at ?? last.started_at));
  if (!rejected || !repaired) return null;
  return {
    ...base,
    reason: 're_review',
    brief: [
      'The implementer has made a repair attempt after your review.',
      '',
      notes,
      '',
      'Re-check every defect you raised and every acceptance criterion against the current state (files, Studio, new evidence), and whether the repair broke anything else. Judge only what is there now, as strictly as before, and return a fresh structured review.',
    ].join('\n'),
  };
}

/**
 * The continued run never got going (no such session for this account, a transcript the API refuses):
 * start fresh instead. Limits, sign-in problems and interruptions are handled as for any run.
 */
export function couldNotContinue(c: { ok: boolean; numTurns: number; errorKind: string | null }, aborted: boolean): boolean {
  if (c.ok || aborted || c.numTurns > 0) return false;
  return !['interrupted', 'rate_limit', 'auth', 'environment'].includes(c.errorKind ?? '');
}
