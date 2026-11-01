import type { Task } from '@shared/domain';

/**
 * A finish-time estimate from the work that is left, for the director to quote. "Tasks left × minutes
 * each ÷ agents at once" (what the director used to compute) is wildly optimistic: tasks that wait for
 * each other cannot run side by side, so the longest chain of remaining tasks sets the pace, however
 * many agents there are. Pure and tested; `activitySummary` puts it in the director's state.
 */

export interface Eta {
  /** Unfinished tasks counted. */
  left: number;
  /** Tasks in the longest chain of remaining work, and their titles in order. */
  chain: number;
  chainTitles: string[];
  /** Minutes one task has taken so far (measured), or the default when none has finished. */
  typical: number;
  measured: boolean;
  /** Minutes: the critical path (or the work shared between the agents, when that is longer) and a margin for rework. */
  low: number;
  high: number;
  /** Tasks that cannot move until the user answers (escalated, blocked, failed for good). */
  stuck: number;
  /** Plan updates still being planned: more tasks may follow. */
  planning: number;
}

/** Minutes per task when none has finished yet (a task is about 15-40 minutes with its checks and review). */
export const DEFAULT_TASK_MINUTES = 25;
/** What a failed check or a critic's rework adds, as a share of the estimate (rework is in the measured pace, too). */
const MARGIN = 1.6;
/**
 * The share of a task's time that is its agent's work; the rest is checks and review. What waits for a task starts
 * when that work exists, not when the review ends (measured in the first A–Z build: 1,658 of 2,158 task-minutes, 77%).
 */
export const WORK_SHARE = 0.75;
const LANDED = new Set(['implemented', 'verifying', 'reviewing']);
const STUCK = new Set(['cancelled', 'escalated', 'blocked']);
const ACTIVE = new Set(['running', 'implemented', 'verifying', 'reviewing']);
const FINISHED = new Set(['done', 'verified', 'cancelled']);

const minutes = (a: string | null, b: number) => (a ? (b - Date.parse(a)) / 60000 : 0);
const round5 = (m: number) => Math.max(5, Math.round(m / 5) * 5);

/**
 * The estimate for `tasks` (every task of the project), or null when nothing is left to run. `agents` is
 * how many can work at once; it can only help where the work is wide.
 */
export function estimateRemaining(tasks: readonly Task[], now: number, agents: number): Eta | null {
  const work = tasks.filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && t.status !== 'proposed');
  const left = work.filter((t) => !FINISHED.has(t.status));
  const planning = tasks.filter((t) => t.kind === 'plan' && (t.status === 'ready' || t.status === 'running')).length;
  if (left.length === 0 && planning === 0) return null;
  const done = work.filter((t) => t.status === 'done' && t.startedAt && t.completedAt && t.kind !== 'research');
  const measured = done.length > 0;
  const typical = measured ? Math.max(1, done.reduce((s, t) => s + minutes(t.startedAt, Date.parse(t.completedAt!)), 0) / done.length) : DEFAULT_TASK_MINUTES;
  // What each unfinished task still needs: a whole task, or what is left of the one under way.
  const need = (t: Task) => (ACTIVE.has(t.status) ? Math.max(0.25 * typical, typical - minutes(t.startedAt, now)) : typical);
  // Until its work exists (what waits for it then starts): nothing once its agent has finished, else all but the review.
  const landed = (t: Task) => LANDED.has(t.status) || (!!t.landedAt && !STUCK.has(t.status));
  const toLand = (t: Task) => (landed(t) ? 0 : Math.max(0, need(t) - (1 - WORK_SHARE) * typical));
  const byId = new Map(left.map((t) => [t.id, t]));
  // For each task: when it starts (after the work of its dependencies exists; after their review when strict) and
  // the chain of tasks that sets that time.
  const memo = new Map<string, { start: number; chain: Task[] }>();
  const visiting = new Set<string>();
  const begin = (t: Task): { start: number; chain: Task[] } => {
    const hit = memo.get(t.id);
    if (hit) return hit;
    // A cycle cannot be created; never loop on one.
    if (visiting.has(t.id)) return { start: 0, chain: [] };
    visiting.add(t.id);
    let before = { start: 0, chain: [] as Task[] };
    for (const d of t.dependencies) {
      const dep = byId.get(d);
      if (!dep) continue;
      const b = begin(dep);
      const ready = b.start + (t.strictDependencies?.includes(d) ? need(dep) : toLand(dep));
      if (ready > before.start) before = { start: ready, chain: [...b.chain, dep] };
    }
    visiting.delete(t.id);
    memo.set(t.id, before);
    return before;
  };
  let critical = { minutes: 0, chain: [] as Task[] };
  for (const t of left) {
    const b = begin(t);
    const f = { minutes: b.start + need(t), chain: [...b.chain, t] };
    if (f.minutes > critical.minutes) critical = f;
  }
  const total = left.reduce((s, t) => s + need(t), 0);
  // Agents shorten wide work, never a chain.
  const low = round5(Math.max(critical.minutes, total / Math.max(1, agents)));
  return {
    left: left.length,
    chain: critical.chain.length,
    chainTitles: critical.chain.map((t) => t.title),
    typical,
    measured,
    low,
    high: Math.max(low + 5, round5(low * MARGIN + typical * 0.5)),
    stuck: left.filter((t) => t.status === 'escalated' || t.status === 'blocked' || (t.status === 'failed' && t.attempts >= t.maxAttempts)).length,
    planning,
  };
}

/** The estimate as the line the director quotes: a range, called an estimate, with what it leaves out. */
export function estimateLine(e: Eta): string {
  const chain = e.chain > 1 ? ` The longest chain of remaining tasks is ${e.chain} long (${e.chainTitles.slice(0, 4).map((t) => `"${t.slice(0, 40)}"`).join(' → ')}${e.chain > 4 ? ' → …' : ''}): tasks that wait for each other don't run side by side, so more agents don't shorten it.` : '';
  const basis = e.measured ? `about ${Math.round(e.typical)} min per task so far` : `no task has finished yet, so about ${Math.round(e.typical)} min per task is a guess`;
  const leaves = [
    e.planning ? 'a plan update still running (it may add tasks, so this can grow)' : '',
    e.stuck ? `${e.stuck} task${e.stuck === 1 ? '' : 's'} waiting for the user's answer` : '',
    'usage limits',
  ].filter(Boolean);
  return `Estimate to finish what is planned: about ${e.low}-${e.high} min (an estimate, not a promise; ${basis}, rework margin included).${chain} Not counted: ${leaves.join('; ')}.`;
}
