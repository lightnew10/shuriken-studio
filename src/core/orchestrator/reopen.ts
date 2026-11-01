import type { Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';

/**
 * A finished task the user says is still broken comes back, and its next attempt has to show the failure before it
 * changes anything. In the Pit build the touch bow's aiming passed its checks five times ("checks and review passed",
 * proven through a test hook in Studio) while the user reported it broken five times; each report became a new task
 * that started from the same assumptions and fixed something next to the problem. Reproducing first is what makes a
 * fix answer the report: a check that fails now and passes after, or recorded evidence of the failure.
 */

/** Title of the note a reopened task carries: the user's report, when, and what the task had said it did. */
export const REOPENED_NOTE = 'Reopened: the user reports it is still broken';
/** How the acceptance criterion a reopen adds begins (one per task: a later reopen replaces it). */
export const REPRODUCE_FIRST = 'Reproduce first:';
/** The failure a reopen records, so the next run sees the report under "Previous attempts" (and in its continuation brief). */
export const REOPEN_FAILURE = 'Reported still broken by the user';
/** The failure when the work came back without showing the reported problem first. */
export const NOT_REPRODUCED = 'Reproduce first: the reported problem was not shown in Studio before the fix';

/** The acceptance criterion a reopened task gets, first in its list. */
export function reproduceCriterion(report: string): string {
  return `${REPRODUCE_FIRST} before changing any code, show in Studio the problem the user reported ("${report.trim().slice(0, 300)}"): a check that fails now (task_run_checks with a check that fails before the fix and passes after it), or the failure recorded with task_add_evidence (passed: false) from a playtest or probe. Then fix it, and show the same check passing.`;
}

/** What the reopened task's agent is told before it starts (the directive and a continued session's brief). */
export function reopenBrief(report: string): string {
  return [
    `This task was finished and the user reports it is STILL BROKEN: "${report.trim().slice(0, 1200)}"`,
    'Your earlier work passed its checks in Studio, so those checks did not catch this. Reproduce first: before you change any code, make the failure happen in Studio and record it — add a check that fails now (task_update_verification, then task_run_checks shows it failing) or record what you saw with task_add_evidence (passed: false). Only then fix it, and show the same check passing.',
    "If you can't make it fail in Studio (it only happens on a real device, say), record that with task_add_evidence (passed: false) describing what you tried, say so in your result, and fix what the report describes.",
  ].join('\n');
}

/** The open reopen of a task (its latest report since it was last done), or null. */
export function openReopen(p: ProjectContext, task: Pick<Task, 'id' | 'completedAt' | 'status'>): { at: string; report: string } | null {
  const note = p.tasks
    .evidence(task.id)
    .filter((e) => e.kind === 'note' && e.title.startsWith(REOPENED_NOTE))
    .at(-1);
  if (!note) return null;
  // Done again since the report: that reopen is settled.
  if (task.status === 'done' && task.completedAt && task.completedAt >= note.createdAt) return null;
  const report = String((note.data as { report?: unknown } | null)?.report ?? '').trim();
  return { at: note.createdAt, report };
}

/**
 * Whether the failure was shown after the reopen: a failing result an agent recorded on the task (a playtest, a probe,
 * task_add_evidence passed: false, the failing run of task_run_checks a reopened task records), not the reviewer's.
 */
export function reproduced(p: ProjectContext, taskId: string, since: string): boolean {
  return p.tasks.evidence(taskId).some((e) => e.createdAt >= since && e.passed === false && e.kind !== 'critic_review' && !e.title.startsWith(REOPENED_NOTE));
}
