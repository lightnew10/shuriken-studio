import type { Task } from '@shared/domain';
import { PENDING_LINE, VISUAL_PENDING } from '../orchestrator/visual-checks';

/** How much of a task's objective and result a list carries. */
export const SLIM_TEXT = { objective: 600, result: 300 };

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * A task as the UI's lists read it: title, state, links and a few lines of its objective and result. A big
 * project's full tasks were 4 MB a read (results, checks and acceptance criteria), read again within a quarter
 * second of every task change while agents worked. The task's own page reads it whole (`tasks.get`). A result
 * whose looks are still unseen keeps the line that says so (the Quality container counts them).
 */
export function slimTask(t: Task): Task {
  const result = t.result == null ? null : t.result.includes(VISUAL_PENDING) && t.result.length > SLIM_TEXT.result ? `${cut(t.result, SLIM_TEXT.result)}\n${PENDING_LINE}` : cut(t.result, SLIM_TEXT.result);
  return { ...t, objective: cut(t.objective, SLIM_TEXT.objective), result, acceptanceCriteria: [], verification: [] };
}
