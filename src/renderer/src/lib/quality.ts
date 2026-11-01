import type { Task, TestCase } from '@shared/domain';

/**
 * The dashboard's Quality container, without React: the game's tests (passing, failing, not run yet),
 * the finished tasks nobody has looked at (Studio wasn't drawing when they were reviewed), for the user
 * who comes back to an overnight build. Tested in tests/renderer.
 */

/** The line a task's result carries while its looks are unseen (core/orchestrator/visual-checks.ts PENDING_LINE). */
export const VISUAL_PENDING = 'Visual check pending:';
const COMPLETE = new Set(['done', 'verified']);

export interface FailingTest {
  /** The check's own name in words ("mech spawns and stands"). */
  label: string;
  /** The task it belongs to (the Agents page opens on it). */
  taskId: string | null;
  lastRunAt: string | null;
  /** Registered copies of the same check failing too. */
  copies: number;
}

export interface QualitySummary {
  /** Tests that run (enabled), by their last result. */
  passing: number;
  failing: FailingTest[];
  notRun: number;
  /** Retired tests (cancelled task, quarantined, retired by an agent or the user): not counted above. */
  retired: number;
  /** Finished tasks whose looks nobody has seen yet, newest first. */
  unseen: Task[];
}

/** "kn6jxzv2:playtest:mech_spawns_and_stands" or "mech_spawns_and_stands" → "mech spawns and stands". */
export function testLabel(name: string): string {
  const check = name.split(':').at(-1) ?? name;
  return check.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

export function qualitySummary(tests: readonly TestCase[], tasks: readonly Task[]): QualitySummary {
  const on = tests.filter((t) => t.enabled);
  const failing = new Map<string, FailingTest>();
  for (const t of on
    .filter((x) => x.lastStatus === 'fail' || x.lastStatus === 'error')
    .sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''))) {
    const label = testLabel(t.name);
    const seen = failing.get(label);
    if (seen) seen.copies++;
    else failing.set(label, { label, taskId: t.taskId, lastRunAt: t.lastRunAt, copies: 1 });
  }
  return {
    passing: on.filter((t) => t.lastStatus === 'pass').length,
    failing: [...failing.values()],
    notRun: on.filter((t) => t.lastStatus === null || t.lastStatus === 'skipped').length,
    retired: tests.length - on.length,
    unseen: tasks
      .filter((t) => COMPLETE.has(t.status) && (t.result ?? '').includes(VISUAL_PENDING))
      .sort((a, b) => (b.completedAt ?? b.updatedAt ?? '').localeCompare(a.completedAt ?? a.updatedAt ?? '')),
  };
}

/** The container's headline: "110 passing · 3 failing · 23 not run yet". */
export function testsLine(q: Pick<QualitySummary, 'passing' | 'failing' | 'notRun'>): string {
  const failing = q.failing.reduce((n, f) => n + f.copies, 0);
  const parts = [`${q.passing} passing`, ...(failing ? [`${failing} failing`] : []), ...(q.notRun ? [`${q.notRun} not run yet`] : [])];
  return q.passing + failing + q.notRun === 0 ? 'No tests yet' : parts.join(' · ');
}
