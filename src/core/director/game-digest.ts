import type { Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { roleLabel } from '../agents/roles';
import { DEFECT_REASON } from '../orchestrator/proposal-triage';
import { VISUAL_DONE, VISUAL_PENDING } from '../orchestrator/visual-checks';
import { RETIRED_BY_QUARANTINE, checkName } from '../verification/test-service';

/**
 * The game as built, for the director: what every finished task delivered (one line each, by specialist), what
 * nobody has verified or seen, the open problems, and how the regression suite stands. The director used to see
 * only the tasks of the goal in progress, so with a finished build behind it ("are there touch controls?") it
 * answered from general knowledge. Read from the project database in a few queries and kept until the tasks,
 * the tests or the visual-check notes change, so it costs nothing on most messages.
 */

/** A task whose work is finished (its checks may still run): what "built" means for the digest and the bubbles. */
const BUILT: ReadonlySet<string> = new Set(['done', 'verified']);

/** Finished work items, oldest first (plans, goals and research are not things the game has). */
export function finishedWork(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && t.kind !== 'research' && BUILT.has(t.status));
}

export interface BuiltDigest {
  /** Finished tasks, oldest first. */
  built: Array<{ id: string; title: string; role: string; delivered: string }>;
  /** Finished tasks whose review ran without a look at the result (Studio wasn't drawing, and no picture was taken since). */
  unseen: string[];
  /** Regression checks switched off because they still failed after their repair. */
  quarantined: string[];
  /** Defects agents reported that the planner hasn't looked at yet. */
  defects: string[];
  /** Optional follow-ups still waiting. */
  polish: number;
  /** Tasks that are stuck (failed, blocked or waiting for the user), with their last problem. */
  stuck: Array<{ title: string; status: string; problem: string }>;
  tests: { enabled: number; pass: number; fail: number; neverRun: number; retired: number; lastRunAt: string | null; failing: Array<{ name: string; task: string | null }> };
  /** Goals that haven't closed (a goal closes when its final regression suite passes). */
  openGoals: Array<{ title: string; status: string }>;
}

const MAX_BUILT = 60;
const firstLine = (s: string | null, max: number) => (s ?? '').split('\n').find((l) => l.trim())?.replace(/\s+/g, ' ').trim().slice(0, max) ?? '';
const NOT_DRAWING = 'studio_not_drawing';

function compute(p: ProjectContext): BuiltDigest {
  const all = p.tasks.list({});
  const byId = new Map(all.map((t) => [t.id, t]));
  const done = finishedWork(all);

  // A review without a look: the last sign on the task is "Studio isn't drawing" (or the pending note), not a picture.
  const signs = p.store.all<{ task_id: string; kind: string; title: string }>(
    `SELECT task_id, kind, title FROM task_evidence WHERE kind = 'screenshot' OR (kind = 'note' AND (title IN (?, ?) OR data LIKE '%${NOT_DRAWING}%')) ORDER BY created_at, rowid`,
    [VISUAL_PENDING, VISUAL_DONE],
  );
  const blind = new Map<string, boolean>();
  for (const s of signs) blind.set(s.task_id, s.kind === 'note' && s.title !== VISUAL_DONE);
  const unseen = done.filter((t) => blind.get(t.id)).map((t) => t.title);

  const tests = p.store.all<{ name: string; spec: string; task_id: string | null; enabled: number; last_status: string | null; last_run_at: string | null; retired_at: string | null; retired_by: string | null }>(
    'SELECT name, spec, task_id, enabled, last_status, last_run_at, retired_at, retired_by FROM tests ORDER BY created_at, rowid',
  );
  const label = (t: { name: string; spec: string }) => {
    try {
      return checkName(JSON.parse(t.spec)) || t.name;
    } catch {
      return t.name;
    }
  };
  const live = tests.filter((t) => t.enabled && !t.retired_at);
  const failing = live.filter((t) => t.last_status === 'fail' || t.last_status === 'error');

  return {
    built: done.map((t) => ({ id: t.id, title: t.title, role: t.role, delivered: firstLine(t.result, 240) })),
    unseen,
    quarantined: tests.filter((t) => t.retired_by === RETIRED_BY_QUARANTINE).map(label),
    defects: all.filter((t) => t.status === 'proposed' && t.reason.startsWith(DEFECT_REASON)).map((t) => t.title),
    polish: all.filter((t) => t.status === 'proposed' && !t.reason.startsWith(DEFECT_REASON)).length,
    stuck: all
      .filter((t) => t.kind !== 'objective' && (t.status === 'failed' || t.status === 'blocked' || t.status === 'escalated'))
      .map((t) => ({ title: t.title, status: t.status, problem: firstLine(t.failureSummary, 200) })),
    tests: {
      enabled: live.length,
      pass: live.filter((t) => t.last_status === 'pass').length,
      fail: failing.length,
      neverRun: live.filter((t) => !t.last_status).length,
      retired: tests.length - live.length,
      lastRunAt: tests.reduce<string | null>((m, t) => (t.last_run_at && (!m || t.last_run_at > m) ? t.last_run_at : m), null),
      // A repair task may register a second copy of a check: one line per check and task.
      failing: [...new Map(failing.map((t) => [`${label(t)}|${t.task_id}`, { name: label(t), task: (t.task_id && byId.get(t.task_id)?.title) || null }])).values()],
    },
    openGoals: all.filter((t) => t.kind === 'objective' && t.status !== 'done' && t.status !== 'cancelled').map((t) => ({ title: t.title, status: t.status })),
  };
}

const cache = new WeakMap<ProjectContext, { key: string; value: BuiltDigest }>();

/** What changes the digest: the tasks, the tests, and the notes and pictures that say whether work was seen. */
function fingerprint(p: ProjectContext): string {
  const r = p.store.get<{ k: string }>(
    `SELECT (SELECT count(*) || ':' || coalesce(max(updated_at), '') FROM tasks) || '|' ||
            (SELECT count(*) || ':' || coalesce(max(last_run_at), '') || ':' || coalesce(sum(enabled), 0) FROM tests) || '|' ||
            (SELECT count(*) FROM task_evidence WHERE kind IN ('note', 'screenshot')) AS k`,
  );
  return r?.k ?? '';
}

/** The game as built (cached until the project's tasks, tests or visual-check notes change). */
export function builtDigest(p: ProjectContext): BuiltDigest {
  const key = fingerprint(p);
  const hit = cache.get(p);
  if (hit?.key === key) return hit.value;
  const value = compute(p);
  cache.set(p, { key, value });
  return value;
}

const list = (items: readonly string[], max: number) => `${items.slice(0, max).map((x) => `"${x.slice(0, 90)}"`).join(', ')}${items.length > max ? `, and ${items.length - max} more` : ''}`;

/**
 * The digest as lines of the director's state. `ids` adds each finished task's id (the looking pass opens tasks
 * by id; the quick pass has no use for them).
 */
export function builtLines(d: BuiltDigest, opts: { ids?: boolean; now?: number } = {}): string[] {
  const out: string[] = [];
  if (d.built.length) {
    const shown = d.built.slice(-MAX_BUILT);
    out.push('', `Built so far (${d.built.length} finished task${d.built.length === 1 ? '' : 's'}, every goal; each line is what the task delivered, in its agent's words):`);
    if (shown.length < d.built.length) out.push(`(the ${d.built.length - shown.length} earliest are left out)`);
    const roles = [...new Set(shown.map((t) => t.role))];
    for (const role of roles) {
      out.push(`${roleLabel(role)}:`);
      for (const t of shown.filter((x) => x.role === role)) out.push(`- ${t.title}${t.delivered ? ` — ${t.delivered}` : ''}${opts.ids ? ` id:${t.id}` : ''}`);
    }
  }
  const unchecked: string[] = [];
  if (d.unseen.length) unchecked.push(`- Reviewed without a look at the result (Studio wasn't drawing when the review ran, so no picture could be taken; measured, not seen): ${list(d.unseen, 10)}`);
  if (d.quarantined.length) unchecked.push(`- Checks switched off because they still failed after their repair (what they tested is unproven): ${list(d.quarantined, 8)}`);
  if (unchecked.length) out.push('', 'Not verified:', ...unchecked);
  const problems: string[] = [];
  for (const s of d.stuck.slice(0, 8)) problems.push(`- [${s.status}] ${s.title.slice(0, 90)}${s.problem ? `: ${s.problem}` : ''}`);
  if (d.defects.length) problems.push(`- Defects agents reported that the planner hasn't looked at yet (${d.defects.length}): ${list(d.defects, 8)}`);
  if (d.polish) problems.push(`- ${d.polish} optional follow-up${d.polish === 1 ? '' : 's'} agents suggested are waiting to be triaged.`);
  if (problems.length) out.push('', 'Open problems:', ...problems);
  const t = d.tests;
  if (t.enabled || t.retired) {
    const when = t.lastRunAt ? `; the last check ran ${new Date(t.lastRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
    out.push('', `Regression suite (every task's automated checks, kept and run again in full before a goal closes): ${t.enabled} checks on: ${t.pass} passed, ${t.fail} failed, ${t.neverRun} never run${when}; ${t.retired} retired.`);
    if (t.failing.length) out.push(`- Failing now: ${t.failing.slice(0, 8).map((f) => `${f.name}${f.task ? ` (from "${f.task.slice(0, 60)}")` : ''}`).join(', ')}${t.failing.length > 8 ? `, and ${t.failing.length - 8} more` : ''}`);
    if (d.openGoals.length) out.push(`- Not closed yet, so its full suite has not passed since its last change: ${d.openGoals.slice(0, 4).map((g) => `"${g.title.slice(0, 70)}" (${g.status})`).join(', ')}`);
  }
  return out;
}
