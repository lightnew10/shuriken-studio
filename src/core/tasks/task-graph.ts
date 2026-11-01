import { newId, nowIso } from '@shared/ids';
import type { Task, TaskEvidence, TaskFailure, TaskKind, TaskStatus, VerificationMethod } from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';
import type { AuditService } from '../audit/audit-service';
import { RETIRED_BY_CANCEL, TestService } from '../verification/test-service';

interface TaskRow {
  id: string;
  parent_id: string | null;
  kind: TaskKind;
  title: string;
  objective: string;
  reason: string;
  role: string;
  status: TaskStatus;
  priority: number;
  acceptance_criteria: string;
  verification: string;
  required_skills: string;
  required_knowledge: string;
  tools: string;
  files: string;
  roblox_systems: string;
  attempts: number;
  max_attempts: number;
  result: string | null;
  failure_summary: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  landed_at?: string | null;
}

export interface NewTask {
  parentId?: string | null;
  kind: TaskKind;
  title: string;
  objective: string;
  reason?: string;
  role: string;
  status?: TaskStatus;
  priority?: number;
  acceptanceCriteria?: string[];
  verification?: VerificationMethod[];
  requiredSkills?: string[];
  requiredKnowledge?: string[];
  tools?: string[];
  files?: string[];
  robloxSystems?: string[];
  dependencies?: string[];
  /** The dependencies (ids, a subset of `dependencies`) that must be done before this task starts. */
  strictDependencies?: string[];
  maxAttempts?: number;
  createdBy: string;
  /** Key the planner gave the task (unique under its objective); lets later plan steps depend on it. */
  planKey?: string | null;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'objective'
    | 'reason'
    | 'role'
    | 'priority'
    | 'acceptanceCriteria'
    | 'verification'
    | 'requiredSkills'
    | 'requiredKnowledge'
    | 'tools'
    | 'files'
    | 'robloxSystems'
    | 'maxAttempts'
    | 'result'
    | 'failureSummary'
  >
>;

/** Allowed status transitions. Anything else is a bug in the caller and is rejected. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ['ready', 'cancelled', 'blocked', 'paused'],
  ready: ['running', 'paused', 'cancelled', 'blocked', 'escalated', 'done'],
  running: ['implemented', 'failed', 'paused', 'cancelled', 'escalated', 'ready', 'verifying', 'done'],
  implemented: ['verifying', 'failed', 'ready', 'cancelled', 'paused', 'escalated'],
  verifying: ['reviewing', 'verified', 'failed', 'ready', 'escalated', 'paused', 'cancelled'],
  reviewing: ['verified', 'failed', 'ready', 'escalated', 'paused', 'cancelled'],
  verified: ['done', 'ready', 'reviewing'],
  done: ['ready'],
  failed: ['ready', 'escalated', 'cancelled', 'blocked', 'paused'],
  blocked: ['ready', 'cancelled', 'escalated', 'paused'],
  escalated: ['ready', 'cancelled', 'blocked', 'done', 'paused'],
  paused: ['ready', 'cancelled', 'verifying', 'proposed'],
  cancelled: ['ready', 'proposed'],
};

/** Statuses of finished, reviewed work: they satisfy any dependency, strict ones included. */
export const COMPLETE: ReadonlySet<TaskStatus> = new Set(['done', 'verified']);
/** Statuses where the task is finished one way or another. */
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);
/** Statuses where work is in flight. */
export const ACTIVE: ReadonlySet<TaskStatus> = new Set(['running', 'implemented', 'verifying', 'reviewing']);
/** Statuses of a dependency that cannot complete as things stand: what waits for it is blocked, not started. */
export const STUCK: ReadonlySet<TaskStatus> = new Set(['cancelled', 'escalated', 'blocked']);

/**
 * Whether a dependency lets the task that waits for it start. By default a dependent starts when the work
 * EXISTS: the dependency's agent finished and its result is on disk (`landedAt`), while its verification and review
 * go on — and it stays startable while a rejected dependency is reworked (the earlier version is still there; the
 * dependent is told what changed when the rework lands). A strict dependency needs reviewed work (`done`): final
 * test and QA tasks. A dependency that is cancelled or stuck unlocks nothing.
 */
export function dependencyMet(dep: Pick<Task, 'status' | 'landedAt'> | null | undefined, strict: boolean): boolean {
  if (!dep) return false;
  if (COMPLETE.has(dep.status)) return true;
  return !strict && !!dep.landedAt && !STUCK.has(dep.status);
}

/** Whether every dependency of `task` lets it start (`byId`: the tasks it may depend on). */
export function dependenciesMet(task: Pick<Task, 'dependencies' | 'strictDependencies'>, byId: (id: string) => Pick<Task, 'status' | 'landedAt'> | null | undefined): boolean {
  return task.dependencies.every((d) => dependencyMet(byId(d), task.strictDependencies?.includes(d) ?? false));
}

export class TaskGraph {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
  ) {}

  create(input: NewTask): Task {
    const id = newId('task');
    const ts = nowIso();
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO tasks (id, parent_id, kind, title, objective, reason, role, status, priority, acceptance_criteria,
          verification, required_skills, required_knowledge, tools, files, roblox_systems, max_attempts, created_by,
          created_at, updated_at, sort_order, plan_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.parentId ?? null,
          input.kind,
          input.title,
          input.objective,
          input.reason ?? '',
          input.role,
          input.status ?? 'proposed',
          input.priority ?? 50,
          j(input.acceptanceCriteria ?? []),
          j(input.verification ?? []),
          j(input.requiredSkills ?? []),
          j(input.requiredKnowledge ?? []),
          j(input.tools ?? []),
          j(input.files ?? []),
          j(input.robloxSystems ?? []),
          input.maxAttempts ?? 3,
          input.createdBy,
          ts,
          ts,
          Date.now(),
          input.planKey ?? null,
        ],
      );
      const strict = new Set(input.strictDependencies ?? []);
      for (const dep of input.dependencies ?? []) this.addDependencyUnchecked(id, dep, strict.has(dep));
      this.assertAcyclic(id);
    });
    const task = this.get(id)!;
    this.bus.emit('task.updated', task);
    this.audit.event({ kind: 'task.created', title: `Task created: ${task.title}`, taskId: id, role: input.createdBy, detail: { kind: task.kind, role: task.role } });
    return task;
  }

  get(id: string): Task | null {
    const fresh = this.fresh();
    if (fresh) {
      const t = fresh.byId.get(id);
      return t ? { ...t } : null;
    }
    const row = this.store.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id]);
    return row ? this.hydrate(row) : null;
  }

  /**
   * Every task as last read, kept while nothing has written the tasks or their links since: a temp trigger counts
   * every write on this connection (the tests' own SQL too; a rolled-back write takes its count back with it). A big
   * project's scheduling pass read all 1,250 tasks from SQLite five times, about a second of the core's one thread,
   * and every state report once more. Callers get copies; a filtered read of a stale list goes to SQLite as before.
   */
  private cached: { gen: string; all: Task[]; byId: Map<string, Task> } | null = null;

  /** This connection's writes to the tasks, and (data_version) another connection's commits to the file. */
  private writes(): string | null {
    // Inside a transaction the count can still be taken back: nothing is kept from there.
    if (this.store.db.isTransaction) return null;
    const read = () => {
      const n = this.store.get<{ n: number }>('SELECT n FROM temp.task_writes')?.n;
      const v = this.store.get<{ data_version: number }>('PRAGMA data_version')?.data_version;
      return n == null || v == null ? null : `${n}:${v}`;
    };
    try {
      return read();
    } catch {
      try {
        const triggers = ['tasks', 'task_deps'].flatMap((t) =>
          ['INSERT', 'UPDATE', 'DELETE'].map((op) => `CREATE TEMP TRIGGER IF NOT EXISTS task_writes_${t}_${op.toLowerCase()} AFTER ${op} ON main.${t} BEGIN UPDATE task_writes SET n = n + 1; END;`),
        );
        this.store.exec(
          `CREATE TEMP TABLE IF NOT EXISTS task_writes (n INTEGER NOT NULL);
           INSERT INTO task_writes SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM task_writes);
           ${triggers.join('\n')}`,
        );
        return read();
      } catch {
        return null;
      }
    }
  }

  /** The kept list, when nothing has changed since it was read. */
  private fresh(): { all: Task[]; byId: Map<string, Task> } | null {
    const gen = this.cached ? this.writes() : null;
    return gen !== null && this.cached?.gen === gen ? this.cached : null;
  }

  /** Every task, read once per change. */
  private everything(): Task[] {
    const fresh = this.fresh();
    if (fresh) return fresh.all;
    const gen = this.writes();
    const rows = this.store.all<TaskRow>('SELECT * FROM tasks ORDER BY sort_order, created_at');
    const deps = this.allDependencies();
    const all = rows.map((r) => this.hydrate(r, deps));
    this.cached = gen === null ? null : { gen, all, byId: new Map(all.map((t) => [t.id, t])) };
    return all;
  }

  /** The task a planner created under `parentId` with this key, if any. */
  byPlanKey(parentId: string, key: string): Task | null {
    const row = this.store.get<TaskRow>('SELECT * FROM tasks WHERE parent_id = ? AND plan_key = ?', [parentId, key]);
    return row ? this.hydrate(row) : null;
  }

  require(id: string): Task {
    const t = this.get(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  }

  list(opts: { parentId?: string | null; statuses?: TaskStatus[]; kinds?: TaskKind[] } = {}): Task[] {
    const filtered = opts.parentId !== undefined || !!opts.statuses?.length || !!opts.kinds?.length;
    const fresh = this.fresh();
    if (fresh || !filtered) {
      const all = fresh ? fresh.all : this.everything();
      const keep = (t: Task) =>
        (opts.parentId === undefined || t.parentId === opts.parentId) && (!opts.statuses?.length || opts.statuses.includes(t.status)) && (!opts.kinds?.length || opts.kinds.includes(t.kind));
      return (filtered ? all.filter(keep) : all).map((t) => ({ ...t }));
    }
    const where: string[] = [];
    const params: string[] = [];
    if (opts.parentId !== undefined) {
      if (opts.parentId === null) where.push('parent_id IS NULL');
      else {
        where.push('parent_id = ?');
        params.push(opts.parentId);
      }
    }
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
      params.push(...opts.kinds);
    }
    const rows = this.store.all<TaskRow>(
      `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order, created_at`,
      params,
    );
    const deps = this.allDependencies();
    return rows.map((r) => this.hydrate(r, deps));
  }

  /** Every descendant of a task (depth-first), excluding the task itself. */
  descendants(id: string): Task[] {
    const out: Task[] = [];
    const walk = (pid: string) => {
      for (const child of this.list({ parentId: pid })) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  update(id: string, patch: TaskPatch): Task {
    const map: Record<string, [string, (v: any) => unknown]> = {
      title: ['title', (v) => v],
      objective: ['objective', (v) => v],
      reason: ['reason', (v) => v],
      role: ['role', (v) => v],
      priority: ['priority', (v) => v],
      acceptanceCriteria: ['acceptance_criteria', j],
      verification: ['verification', j],
      requiredSkills: ['required_skills', j],
      requiredKnowledge: ['required_knowledge', j],
      tools: ['tools', j],
      files: ['files', j],
      robloxSystems: ['roblox_systems', j],
      maxAttempts: ['max_attempts', (v) => v],
      result: ['result', (v) => v],
      failureSummary: ['failure_summary', (v) => v],
    };
    const sets: string[] = [];
    const params: any[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const m = map[key];
      if (!m || value === undefined) continue;
      sets.push(`${m[0]} = ?`);
      params.push(m[1](value));
    }
    if (sets.length === 0) return this.require(id);
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    this.store.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    const task = this.require(id);
    this.bus.emit('task.updated', task);
    return task;
  }

  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return from === to || TRANSITIONS[from].includes(to);
  }

  setStatus(id: string, to: TaskStatus, reason?: string, actor = 'system'): Task {
    const current = this.require(id);
    if (current.status === to) return current;
    if (!this.canTransition(current.status, to)) {
      throw new Error(`Illegal task transition ${current.status} → ${to} for ${id}`);
    }
    const ts = nowIso();
    const extra: string[] = [];
    const params: any[] = [to, ts];
    if (to === 'running') {
      extra.push('started_at = COALESCE(started_at, ?)', 'attempts = attempts + 1');
      params.push(ts);
    }
    if (to === 'done' || to === 'cancelled') {
      extra.push('completed_at = ?');
      params.push(ts);
    }
    if (to === 'ready' && (current.status === 'done' || current.status === 'cancelled')) {
      extra.push('completed_at = NULL');
    }
    // The work exists from the moment its agent finished (what waits for it may start: see dependencyMet); a task
    // that is cancelled or stuck no longer vouches for what it left behind.
    if (to === 'implemented') {
      extra.push('landed_at = ?');
      params.push(ts);
    }
    if (STUCK.has(to)) extra.push('landed_at = NULL');
    params.push(id);
    this.store.run(`UPDATE tasks SET status = ?, updated_at = ?${extra.length ? ', ' + extra.join(', ') : ''} WHERE id = ?`, params);
    const task = this.require(id);
    this.bus.emit('task.updated', task);
    this.audit.event({
      kind: 'task.status',
      title: `${task.title}: ${current.status} → ${to}`,
      severity: to === 'failed' || to === 'escalated' ? 'warning' : to === 'done' || to === 'verified' ? 'success' : 'info',
      taskId: id,
      role: actor,
      detail: reason ? { reason } : null,
    });
    // Work that was dropped or replaced must not keep failing the regression suite with its old assumptions.
    if (to === 'cancelled') this.retireTests(task, reason ?? '');
    else if (current.status === 'cancelled') this.restoreTests(task);
    return task;
  }

  /** The regression tests a cancelled task registered are retired, with the reason recorded (and on the timeline). */
  private retireTests(task: Task, reason: string): void {
    const retired = new TestService(this.store).retireForTask(task.id, `Task "${task.title}" was cancelled${reason ? `: ${reason}` : ''}`, RETIRED_BY_CANCEL);
    if (!retired.length) return;
    this.audit.event({
      kind: 'test.retired',
      title: `Retired ${retired.length} regression test${retired.length === 1 ? '' : 's'} of the cancelled task "${task.title}"`,
      taskId: task.id,
      role: 'system',
      detail: { reason, tests: retired.map((t) => ({ id: t.id, name: t.name })) },
    });
  }

  private restoreTests(task: Task): void {
    const restored = new TestService(this.store).restoreForTask(task.id);
    if (!restored.length) return;
    this.audit.event({ kind: 'test.restored', title: `Restored ${restored.length} regression test${restored.length === 1 ? '' : 's'} of "${task.title}" (it is back)`, taskId: task.id, role: 'system', detail: { tests: restored.map((t) => ({ id: t.id, name: t.name })) } });
  }

  /**
   * The finished implementation run a task can resume from: set once the implementer's work is done,
   * cleared when a new attempt starts or the task completes. A restart during verification or review
   * then re-checks that work instead of re-implementing it.
   */
  setResumeRun(id: string, runId: string | null): void {
    this.store.run('UPDATE tasks SET resume_run_id = ? WHERE id = ?', [runId, id]);
  }

  resumeRun(id: string): string | null {
    return this.store.get<{ resume_run_id: string | null }>('SELECT resume_run_id FROM tasks WHERE id = ?', [id])?.resume_run_id ?? null;
  }

  /** Give back one attempt: the run was interrupted from outside (crash, restart), it did not fail. */
  refundAttempt(id: string): void {
    this.store.run('UPDATE tasks SET attempts = MAX(0, attempts - 1), updated_at = ? WHERE id = ?', [nowIso(), id]);
  }

  /** Reset the attempt counter (used when the user explicitly retries after escalation). */
  resetAttempts(id: string): Task {
    this.store.run('UPDATE tasks SET attempts = 0, updated_at = ? WHERE id = ?', [nowIso(), id]);
    const t = this.require(id);
    this.bus.emit('task.updated', t);
    return t;
  }

  addDependency(taskId: string, dependsOnId: string, strict = false): void {
    this.store.tx(() => {
      this.addDependencyUnchecked(taskId, dependsOnId, strict);
      this.assertAcyclic(taskId);
    });
    this.bus.emit('task.updated', this.require(taskId));
  }

  /** Make an existing dependency strict (the task waits until it is done) or plain (until its work exists). */
  setDependencyStrict(taskId: string, dependsOnId: string, strict: boolean): void {
    this.store.run('UPDATE task_deps SET strict = ? WHERE task_id = ? AND depends_on_id = ?', [strict ? 1 : 0, taskId, dependsOnId]);
    this.bus.emit('task.updated', this.require(taskId));
  }

  /** A task that ran out of attempts no longer vouches for its work: what has not started waits for the retry. */
  clearLanded(id: string): void {
    this.store.run('UPDATE tasks SET landed_at = NULL WHERE id = ?', [id]);
  }

  removeDependency(taskId: string, dependsOnId: string): void {
    this.store.run('DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?', [taskId, dependsOnId]);
    this.bus.emit('task.updated', this.require(taskId));
  }

  private addDependencyUnchecked(taskId: string, dependsOnId: string, strict = false): void {
    if (taskId === dependsOnId) throw new Error('A task cannot depend on itself');
    if (!this.store.get('SELECT 1 FROM tasks WHERE id = ?', [dependsOnId])) {
      throw new Error(`Dependency ${dependsOnId} does not exist`);
    }
    this.store.run('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id, strict) VALUES (?, ?, ?)', [taskId, dependsOnId, strict ? 1 : 0]);
  }

  private assertAcyclic(start: string): void {
    const deps = this.allDependencies();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Dependency cycle detected involving ${id}`);
      visiting.add(id);
      for (const d of deps.get(id) ?? []) visit(d);
      visiting.delete(id);
    };
    visit(start);
  }

  /** Every task's dependencies (task id → ids it waits for), and which of them are strict. */
  private allDependencies(): Map<string, string[]> & { strict: Map<string, string[]> } {
    const map = Object.assign(new Map<string, string[]>(), { strict: new Map<string, string[]>() });
    for (const r of this.store.all<{ task_id: string; depends_on_id: string; strict: number }>('SELECT task_id, depends_on_id, strict FROM task_deps')) {
      const arr = map.get(r.task_id) ?? [];
      arr.push(r.depends_on_id);
      map.set(r.task_id, arr);
      if (r.strict) map.strict.set(r.task_id, [...(map.strict.get(r.task_id) ?? []), r.depends_on_id]);
    }
    return map;
  }

  /**
   * Tasks whose status is `ready` and whose dependencies let them start (their work exists; a strict one is
   * done: see dependencyMet), highest priority first.
   */
  runnable(): Task[] {
    // Only the ready tasks in full; their dependencies' checks read status and landing alone (every state report asks).
    const fresh = this.fresh();
    const lookup: (id: string) => Pick<Task, 'status' | 'landedAt'> | undefined = fresh
      ? (id) => fresh.byId.get(id)
      : ((light) => (id: string) => light.get(id))(
          new Map(this.store.all<{ id: string; status: TaskStatus; landed_at: string | null }>('SELECT id, status, landed_at FROM tasks').map((r) => [r.id, { status: r.status, landedAt: r.landed_at ?? null }])),
        );
    return this.list({ statuses: ['ready'] })
      .filter((t) => t.kind !== 'objective')
      .filter((t) => dependenciesMet(t, lookup))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }

  /** Tasks blocked forever because a dependency was cancelled/failed permanently. */
  deadlocked(): Task[] {
    const all = this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    return all.filter(
      (t) =>
        (t.status === 'ready' || t.status === 'proposed') &&
        t.dependencies.some((d) => {
          const s = byId.get(d)?.status;
          return s === undefined || s === 'cancelled' || s === 'escalated' || s === 'blocked';
        }),
    );
  }

  /** Blocked tasks whose dependencies can all complete again (e.g. an escalation the user retried). */
  unblockable(): Task[] {
    const all = this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    return all.filter(
      (t) =>
        t.status === 'blocked' &&
        t.kind !== 'objective' &&
        t.dependencies.length > 0 &&
        t.dependencies.every((d) => {
          const s = byId.get(d)?.status;
          return s !== undefined && s !== 'cancelled' && s !== 'escalated' && s !== 'blocked';
        }),
    );
  }

  addEvidence(input: Omit<TaskEvidence, 'id' | 'createdAt'>): TaskEvidence {
    const ev: TaskEvidence = { ...input, id: newId('evd'), createdAt: nowIso() };
    this.store.run(
      `INSERT INTO task_evidence (id, task_id, run_id, kind, title, passed, data, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ev.id, ev.taskId, ev.runId, ev.kind, ev.title, ev.passed === null ? null : ev.passed ? 1 : 0, j(ev.data), ev.path, ev.createdAt],
    );
    return ev;
  }

  evidence(taskId: string): TaskEvidence[] {
    return this.store
      .all<{ id: string; task_id: string; run_id: string | null; kind: TaskEvidence['kind']; title: string; passed: number | null; data: string; path: string | null; created_at: string }>(
        'SELECT * FROM task_evidence WHERE task_id = ? ORDER BY created_at',
        [taskId],
      )
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        runId: r.run_id,
        kind: r.kind,
        title: r.title,
        passed: r.passed === null ? null : r.passed === 1,
        data: pj(r.data, null),
        path: r.path,
        createdAt: r.created_at,
      }));
  }

  addFailure(input: Omit<TaskFailure, 'id' | 'createdAt'>): TaskFailure {
    const f: TaskFailure = { ...input, id: newId('fail'), createdAt: nowIso() };
    this.store.run(
      `INSERT INTO task_failures (id, task_id, run_id, attempt, stage, summary, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, f.taskId, f.runId, f.attempt, f.stage, f.summary, f.detail, f.createdAt],
    );
    this.store.run('UPDATE tasks SET failure_summary = ?, updated_at = ? WHERE id = ?', [f.summary, f.createdAt, f.taskId]);
    return f;
  }

  failures(taskId: string): TaskFailure[] {
    return this.store
      .all<{ id: string; task_id: string; run_id: string | null; attempt: number; stage: TaskFailure['stage']; summary: string; detail: string | null; created_at: string }>(
        'SELECT * FROM task_failures WHERE task_id = ? ORDER BY created_at',
        [taskId],
      )
      .map((r) => ({ id: r.id, taskId: r.task_id, runId: r.run_id, attempt: r.attempt, stage: r.stage, summary: r.summary, detail: r.detail, createdAt: r.created_at }));
  }

  delete(id: string): void {
    this.store.run('DELETE FROM tasks WHERE id = ?', [id]);
    this.bus.emit('task.deleted', { id });
  }

  private hydrate(r: TaskRow, deps?: Map<string, string[]> & { strict: Map<string, string[]> }): Task {
    const own = deps ? null : this.store.all<{ depends_on_id: string; strict: number }>('SELECT depends_on_id, strict FROM task_deps WHERE task_id = ?', [r.id]);
    const dependencies = own ? own.map((d) => d.depends_on_id) : (deps!.get(r.id) ?? []);
    const strictDependencies = own ? own.filter((d) => d.strict).map((d) => d.depends_on_id) : (deps!.strict.get(r.id) ?? []);
    return {
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind,
      title: r.title,
      objective: r.objective,
      reason: r.reason,
      role: r.role,
      status: r.status,
      priority: r.priority,
      acceptanceCriteria: pj(r.acceptance_criteria, []),
      verification: pj(r.verification, []),
      requiredSkills: pj(r.required_skills, []),
      requiredKnowledge: pj(r.required_knowledge, []),
      tools: pj(r.tools, []),
      files: pj(r.files, []),
      robloxSystems: pj(r.roblox_systems, []),
      dependencies,
      strictDependencies,
      landedAt: r.landed_at ?? null,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      result: r.result,
      failureSummary: r.failure_summary,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    };
  }
}
