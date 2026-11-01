import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { COST_CATEGORIES, EMPTY_BUILD_COST, type BuildCost, type CostCategoryId } from '@shared/costs';
import { ROLES } from '../agents/roles';

/**
 * One API-equivalent cost per build. Every agent run is a row of the project's `runs` with the cost the Claude SDK
 * reported (an API-price figure on a subscription too), Kiln's builds are runs with role "kiln" (their cost from Kiln's
 * own transcript, capabilities/kiln-tools.ts), and the small fixed-model calls of a project (plain words, the thumbnail
 * judge: `AgentRunner.quick`) are booked in `cost_entries`. Added up here, grouped by what the money did and by goal.
 * Only the start page's idea writer is app-level and belongs to no build.
 */

const PLANNING = new Set(['executive', 'architect']);
const REVIEWS = new Set(['critic', 'image-checker', 'ui-phone-reviewer', 'thumb-judge']);
const DIRECTOR = new Set(['director', 'suggester']);
const RESEARCH = new Set(['researcher', 'reference-analyst', 'analyst']);

/** The group a run's role (or a booked call's source) counts in. */
export function costCategory(role: string): CostCategoryId {
  if (role === 'kiln') return 'kiln';
  if (role.startsWith('copilot')) return 'copilots';
  if (PLANNING.has(role) || /(?:^|-)plan(?:ner|ning)?(?:-|$)/.test(role)) return 'planning';
  if (REVIEWS.has(role)) return 'reviews';
  if (DIRECTOR.has(role) || role.startsWith('director')) return 'director';
  if (RESEARCH.has(role)) return 'research';
  // Every specialist the planner can give a task to (roles.ts `worker`): a new one counts here without a change.
  if (ROLES[role]?.output === 'work') return 'building';
  return 'helpers';
}

/** What the sums need from a database: the project's own Store, or a read-only connection to another project's. */
export interface CostRows {
  all<T>(sql: string): T[];
}

interface RunRow {
  role: string;
  task_id: string | null;
  cost: number;
  first: string | null;
  last: string | null;
}
interface TaskRow {
  id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  status: string;
  created_at: string;
}

/** A query whose table may not be there (a project from before the table, a folder that isn't one): no rows. */
function rows<T>(db: CostRows, sql: string): T[] {
  try {
    return db.all<T>(sql);
  } catch {
    return [];
  }
}

const cents4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The build's cost from its database (the open project's Store, or a read-only connection: see buildCost). */
export function costOf(db: CostRows): BuildCost {
  // One row per run; the booked calls the same shape (a call with a task counts toward that task's goal).
  const runs = rows<RunRow>(db, 'SELECT role, task_id, COALESCE(cost_usd, 0) AS cost, started_at AS first, COALESCE(ended_at, started_at) AS last FROM runs');
  const booked = rows<RunRow>(db, 'SELECT source AS role, task_id, COALESCE(cost_usd, 0) AS cost, at AS first, at AS last FROM cost_entries');
  const all = [...runs, ...booked];
  if (!all.length) return { ...EMPTY_BUILD_COST, goals: goalsOf(db, new Map()) };

  const byCat = new Map<CostCategoryId, { usd: number; runs: number }>();
  const byTask = new Map<string, number>();
  let total = 0;
  let since: string | null = null;
  let until: string | null = null;
  for (const r of all) {
    const usd = Number.isFinite(r.cost) && r.cost > 0 ? r.cost : 0;
    total += usd;
    const cat = costCategory(String(r.role ?? ''));
    const c = byCat.get(cat) ?? { usd: 0, runs: 0 };
    c.usd += usd;
    c.runs += 1;
    byCat.set(cat, c);
    if (r.task_id && usd > 0) byTask.set(r.task_id, (byTask.get(r.task_id) ?? 0) + usd);
    if (r.first && (!since || r.first < since)) since = r.first;
    if (r.last && (!until || r.last > until)) until = r.last;
  }
  const order = new Map(COST_CATEGORIES.map((c, i) => [c.id, i]));
  const categories = COST_CATEGORIES.filter((c) => byCat.has(c.id))
    .map((c) => ({ id: c.id, label: c.label, usd: cents4(byCat.get(c.id)!.usd), runs: byCat.get(c.id)!.runs }))
    .sort((a, b) => b.usd - a.usd || order.get(a.id)! - order.get(b.id)!);
  return { totalUsd: cents4(total), categories, goals: goalsOf(db, byTask), kilnUsd: cents4(byCat.get('kiln')?.usd ?? 0), since, until };
}

/** Each objective with what the runs of its tasks cost: a run's task is followed up its parents to the objective. */
function goalsOf(db: CostRows, byTask: Map<string, number>): BuildCost['goals'] {
  const tasks = rows<TaskRow>(db, 'SELECT id, parent_id, kind, title, status, created_at FROM tasks');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const goalOf = (id: string): string | null => {
    let t = byId.get(id);
    // A parent chain is a few levels deep; the bound only guards against a loop in a damaged database.
    for (let i = 0; t && i < 50; i++) {
      if (t.kind === 'objective') return t.id;
      t = t.parent_id ? byId.get(t.parent_id) : undefined;
    }
    return null;
  };
  const sums = new Map<string, number>();
  for (const [taskId, usd] of byTask) {
    const g = goalOf(taskId);
    if (g) sums.set(g, (sums.get(g) ?? 0) + usd);
  }
  return tasks
    .filter((t) => t.kind === 'objective')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((t) => ({ id: t.id, title: t.title, usd: cents4(sums.get(t.id) ?? 0), status: t.status }));
}

/**
 * The cost of the build in a project folder, read from `<root>/.shuriken/project.db` through a read-only connection:
 * nothing is written, and a project another window has open is read as it stands (SQLite's WAL lets a reader in
 * beside the writer). No database, or one that can't be opened, is a build that cost nothing yet.
 */
export function buildCost(root: string): BuildCost {
  const file = join(root, '.shuriken', 'project.db');
  if (!root || !existsSync(file)) return { ...EMPTY_BUILD_COST };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const conn = db;
    return costOf({ all: <T>(sql: string) => conn.prepare(sql).all() as T[] });
  } catch {
    return { ...EMPTY_BUILD_COST };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
