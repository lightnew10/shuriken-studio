import type { AgentRun, Escalation, Task } from '@shared/domain';
import { plainText } from '@shared/plain-words';

/**
 * "Decided without asking" on the Agents page: what the AI system settled for the user in autonomous mode
 * (escalations with status auto_resolved), newest first and grouped by day, each tied to its task.
 * No React here: tests/renderer covers it.
 */

export const DECISION_KIND_LABEL: Record<Escalation['kind'], string> = {
  approval: 'Went ahead',
  question: 'Question',
  failure: 'Kept failing',
  capability_missing: 'Blocked',
  spec_change: 'Spec change',
};

/** Shown for a decision that carries no words of its own. */
export const NO_WORDS = 'Handled automatically.';

export interface DecisionRow {
  id: string;
  kind: Escalation['kind'];
  kindLabel: string;
  /** What came up: the question or the thing that needed approval. */
  question: string;
  /** What was decided. */
  decided: string;
  /** The longer description of what came up, for the expanded row. */
  detail: string;
  /** When it was decided (ISO). */
  at: string;
  /** The time of day, in the user's own format. */
  time: string;
  taskId: string | null;
  /** Null when the escalation names no task, or the task is gone. */
  taskTitle: string | null;
  /** A run to open for the task; null when it never ran (an objective, say). */
  runId: string | null;
}

export interface DecisionDay {
  /** Local date, `YYYY-MM-DD`. */
  key: string;
  /** "Today", "Yesterday" or "Mon, Sep 28". */
  label: string;
  rows: DecisionRow[];
}

const tidy = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** When it was settled: the decision's own time (it is rewritten once the planner has decided), else when it came up. */
export const decidedAt = (e: Pick<Escalation, 'createdAt' | 'resolvedAt'>): string => e.resolvedAt ?? e.createdAt;

const pad = (n: number): string => String(n).padStart(2, '0');
/** The local calendar day of a time. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function dayLabel(ms: number, now: number): string {
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const timeOfDay = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Only the decisions the system made itself, newest first (by the time they were decided). */
export function autoResolved(list: readonly Escalation[]): Escalation[] {
  return list
    .filter((e) => e.status === 'auto_resolved')
    .sort((a, b) => Date.parse(decidedAt(b)) - Date.parse(decidedAt(a)) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
}

export function decisionRows(list: readonly Escalation[], tasks: readonly Task[], runs: readonly AgentRun[]): DecisionRow[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Runs come newest first; the first one found for a task is its latest.
  const runByTask = new Map<string, string>();
  for (const r of runs) if (r.taskId && !runByTask.has(r.taskId)) runByTask.set(r.taskId, r.id);
  return autoResolved(list).map((e) => {
    const at = decidedAt(e);
    const ms = Date.parse(at);
    const task = e.taskId ? taskById.get(e.taskId) : undefined;
    return {
      id: e.id,
      kind: e.kind,
      kindLabel: DECISION_KIND_LABEL[e.kind] ?? 'Decision',
      // What came up and what was decided in plain words (the detail below keeps the team's own).
      question: plainText(tidy(e.title)) || 'A decision',
      decided: plainText(tidy(e.response)) || NO_WORDS,
      detail: (e.detail ?? '').trim(),
      at,
      time: Number.isNaN(ms) ? '' : timeOfDay(ms),
      taskId: e.taskId,
      taskTitle: task?.title ?? null,
      runId: e.taskId ? (runByTask.get(e.taskId) ?? null) : null,
    };
  });
}

/** The decisions grouped by the day they were made (newest day first, newest decision first within it). */
export function decisionDays(list: readonly Escalation[], tasks: readonly Task[], runs: readonly AgentRun[], now: number): DecisionDay[] {
  const days: DecisionDay[] = [];
  for (const row of decisionRows(list, tasks, runs)) {
    const ms = Date.parse(row.at);
    const key = Number.isNaN(ms) ? 'unknown' : dayKey(ms);
    let day = days.find((d) => d.key === key);
    if (!day) {
      day = { key, label: Number.isNaN(ms) ? 'Earlier' : dayLabel(ms, now), rows: [] };
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}

/** The pinned entry's second line on the Agents page. */
export function decisionsSummary(list: readonly Escalation[]): string {
  const n = autoResolved(list).length;
  return n === 0 ? 'Nothing yet' : n === 1 ? '1 decision' : `${n} decisions`;
}
