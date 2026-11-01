import type { Task } from '@shared/domain';
import { claimsOf, sharedFolders } from './file-claims';

/**
 * Dependency checks for planned tasks. A dependency costs the user waiting time (agents sit idle while
 * a task waits), so the planner is warned — never refused — when one only adds waiting: a chain deeper
 * than three, an asset task (sounds, effects, animation clips, UI) waiting for gameplay code, QA
 * waiting for other QA. Pure functions over a small node type: the planner's live tool (plan_add_task),
 * the batch path (Orchestrator.addTasks) and the tests share them.
 */

export interface PlanNode {
  /** Task id. */
  id: string;
  /** How the planner names it (its plan key, or the id): what plan_drop_dependency takes. */
  ref: string;
  title: string;
  role: string;
  /** Task status; finished work (done, verified, cancelled) costs no waiting. */
  status?: string;
  /** Ids of the nodes it waits for. */
  deps: readonly string[];
  /** The task's `files` (exact files keep tasks apart, folders are shared: file-claims.ts). */
  files?: readonly string[];
  kind?: string;
  /** The ids among `deps` it waits for strictly (until they are done, not only until their work exists). */
  strict?: readonly string[];
  /** Its agent has finished: the work exists, so it delays only what waits for it strictly. */
  landed?: boolean;
}

export type PlanWarningCode = 'deep-chain' | 'asset-after-code' | 'qa-after-qa' | 'shared-folder' | 'strict-dependency';

export interface PlanWarning {
  code: PlanWarningCode;
  /** The task that waits. */
  task: string;
  /** The dependency to drop (when one is to blame). */
  dependency?: string;
  /** Why it is a problem and what to do, written for the planner. */
  message: string;
}

/** A longer chain than this leaves agents idle while its tail waits. */
export const MAX_CHAIN_DEPTH = 3;
/** Roles whose work is creating assets: they are made independently of the code that plays them. */
export const ASSET_ROLES: ReadonlySet<string> = new Set(['sound-designer', 'vfx-artist', 'animator', 'ui-engineer']);
/** Roles that write the gameplay code and the creature AI. */
export const CODE_ROLES: ReadonlySet<string> = new Set(['roblox-engineer', 'luau-engineer']);
const QA = 'qa-engineer';
const ASSET_NAMES: Record<string, string> = { 'sound-designer': 'sounds', 'vfx-artist': 'effects', animator: 'animation clips', 'ui-engineer': 'UI screens' };
const FINISHED: ReadonlySet<string> = new Set(['done', 'verified', 'cancelled']);

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const waits = (n: PlanNode | undefined): n is PlanNode => !!n && !FINISHED.has(n.status ?? '');
/** Whether `dep` still keeps `by` from starting: it is unfinished, and its work doesn't exist yet or `by` waits for its review. */
const delays = (dep: PlanNode | undefined, by: PlanNode): dep is PlanNode => waits(dep) && !(dep.landed && !by.strict?.includes(dep.id));

/** The nodes of a set of tasks (a plan's tasks), keyed by id; `refs` names the ones the planner knows by key. */
export function planNodes(tasks: readonly (Pick<Task, 'id' | 'title' | 'role' | 'status' | 'dependencies'> & Partial<Pick<Task, 'files' | 'kind' | 'strictDependencies' | 'landedAt'>>)[], refs: ReadonlyMap<string, string> = new Map()): Map<string, PlanNode> {
  return new Map(tasks.map((t) => [t.id, { id: t.id, ref: refs.get(t.id) ?? t.id, title: t.title, role: t.role, status: t.status, deps: t.dependencies, files: t.files ?? [], kind: t.kind, strict: t.strictDependencies ?? [], landed: !!t.landedAt }]));
}

/**
 * The longest chain of unfinished tasks that ends at `id`, itself included, in the order they run.
 * Finished tasks (and unknown ids) cost no waiting and end a chain; so does a dependency whose work
 * exists, unless the task waits for it strictly.
 */
export function longestChain(id: string, nodes: ReadonlyMap<string, PlanNode>): PlanNode[] {
  const memo = new Map<string, PlanNode[]>();
  const visiting = new Set<string>();
  const walk = (k: string): PlanNode[] => {
    const n = nodes.get(k);
    if (!waits(n)) return [];
    const hit = memo.get(k);
    if (hit) return hit;
    // A cycle is rejected where tasks are created; never loop on one here.
    if (visiting.has(k)) return [];
    visiting.add(k);
    let best: PlanNode[] = [];
    for (const d of n.deps) {
      if (!delays(nodes.get(d), n)) continue;
      const c = walk(d);
      if (c.length > best.length) best = c;
    }
    visiting.delete(k);
    const out = [...best, n];
    memo.set(k, out);
    return out;
  };
  return walk(id);
}

/**
 * What is wrong with the dependencies of one task: warnings, not failures (a rare dependency is
 * justified, e.g. a "wire it in" task that really does consume the code). Only dependencies that still
 * cost waiting count: a finished task never delays anything.
 */
export function dependencyWarnings(task: PlanNode, nodes: ReadonlyMap<string, PlanNode>): PlanWarning[] {
  const out: PlanWarning[] = [];
  const drop = (dep: PlanNode) => `plan_drop_dependency {task: "${task.ref}", dependsOn: "${dep.ref}"}`;
  const chain = longestChain(task.id, nodes);
  if (chain.length > MAX_CHAIN_DEPTH) {
    // The dependency that makes it deepest is the one to question first.
    const deepest = task.deps.map((d) => ({ d: nodes.get(d), len: longestChain(d, nodes).length })).filter((x) => delays(x.d, task)).sort((a, b) => b.len - a.len)[0]?.d;
    out.push({
      code: 'deep-chain',
      task: task.id,
      ...(deepest ? { dependency: deepest.id } : {}),
      message: `"${short(task.title, 60)}" waits behind a chain of ${chain.length} tasks (${chain.map((n) => short(n.title, 36)).join(' → ')}). Chains deeper than ${MAX_CHAIN_DEPTH} leave agents idle while the tail waits.${deepest ? ` If it doesn't literally consume the output of "${short(deepest.title, 60)}", drop that dependency (${drop(deepest)}); otherwise merge steps.` : ' Merge steps or cut dependencies that are not a literal input.'}`,
    });
  }
  for (const depId of task.deps) {
    const dep = nodes.get(depId);
    if (!delays(dep, task)) continue;
    if (ASSET_ROLES.has(task.role) && CODE_ROLES.has(dep.role)) {
      out.push({
        code: 'asset-after-code',
        task: task.id,
        dependency: dep.id,
        message: `"${short(task.title, 60)}" (${task.role}) waits for "${short(dep.title, 60)}" (${dep.role}), but ${ASSET_NAMES[task.role] ?? 'assets'} are created independently of code: the code calls them by the names the plan gives them. Drop the dependency (${drop(dep)}) unless this task literally consumes that code's output; hook assets in with a small "wire it in" task that depends on both.`,
      });
    }
    if (task.role === QA && dep.role === QA) {
      out.push({
        code: 'qa-after-qa',
        task: task.id,
        dependency: dep.id,
        message: `"${short(task.title, 60)}" (QA) waits for "${short(dep.title, 60)}" (QA). QA and playtest tasks never queue behind each other: drop the dependency (${drop(dep)}) and split the passes by area so they run side by side.`,
      });
    }
  }
  return out;
}

/**
 * Strict dependencies of a task that is not a final test or QA task. A strict dependency waits for the checks and
 * the review of the other task (the wait that cost 1,650 task-minutes in one build) instead of starting when its
 * work is on disk; only tasks that must run against reviewed work need that.
 */
export function strictWarnings(task: PlanNode, nodes: ReadonlyMap<string, PlanNode>): PlanWarning[] {
  if (task.role === QA || task.kind === 'test') return [];
  const out: PlanWarning[] = [];
  for (const depId of task.strict ?? []) {
    const dep = nodes.get(depId);
    if (!waits(dep) || !task.deps.includes(depId)) continue;
    out.push({
      code: 'strict-dependency',
      task: task.id,
      dependency: dep.id,
      message: `"${short(task.title, 60)}" waits for the checks and the review of "${short(dep.title, 60)}" (a strict dependency), not only for its work. Strict is for final test and QA tasks, which must run against reviewed work; everything else starts when the work is on disk and is told if it changes. Drop the strictness (plan_drop_dependency {task: "${task.ref}", dependsOn: "${dep.ref}", strictOnly: true}).`,
    });
  }
  return out;
}

/**
 * Folders `task` claims that another unfinished task of the plan claims too (the same folder, one inside it or
 * around it). A folder keeps nobody out, so this costs no waiting; it is a warning because both agents then work
 * in the same files unless the plan says whose are whose. One warning per other task.
 */
export function claimWarnings(task: PlanNode, nodes: ReadonlyMap<string, PlanNode>, isDir?: (rel: string) => boolean): PlanWarning[] {
  const mine = claimsOf(task.files ?? [], isDir);
  if (!mine.folders.length) return [];
  const out: PlanWarning[] = [];
  for (const other of nodes.values()) {
    if (other.id === task.id || !waits(other)) continue;
    const shared = sharedFolders(mine, claimsOf(other.files ?? [], isDir));
    if (!shared.length) continue;
    out.push({
      code: 'shared-folder',
      task: task.id,
      message: `"${short(task.title, 60)}" lists the folder ${shared.map((f) => f || '(the project)').join(', ')}, and so does "${short(other.title, 60)}". A folder keeps nobody out: both run at the same time and can end up in the same file. List the exact files each task writes (plan_set_files {task: "${task.ref}", files: [...]}): a wiring task its own files and the hooks it attaches through, never another system's folder. Two tasks that must edit the same file both name that file, and take turns.`,
    });
  }
  return out;
}

/** The warnings of several tasks of one plan (a batch the planner or the director added at once). */
export function planWarnings(tasks: readonly PlanNode[]): PlanWarning[] {
  const nodes = new Map(tasks.map((t) => [t.id, t]));
  return tasks.flatMap((t) => dependencyWarnings(t, nodes));
}
