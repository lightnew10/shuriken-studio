import { newId, nowIso } from '@shared/ids';
import type { TestCase, TestResult, VerificationMethod } from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';

interface TestRow {
  id: string;
  name: string;
  kind: TestCase['kind'];
  spec: string;
  task_id: string | null;
  enabled: number;
  last_status: TestCase['lastStatus'];
  last_run_at: string | null;
  created_at: string;
  retired_reason: string | null;
  retired_at: string | null;
  retired_by: string | null;
}

/** Who retires a test when the task that registered it is cancelled (and who restores it if the task comes back). */
export const RETIRED_BY_CANCEL = 'system:cancelled';
/** Who retires a test that still fails after its repair task. */
export const RETIRED_BY_QUARANTINE = 'quarantine';

/**
 * Tests are permanent project assets: every automated verification method attached to a task
 * becomes a named test that is re-run as a regression suite before objectives complete.
 *
 * A test can be retired: disabled with a record of why, who and when (its task was cancelled or replaced,
 * an agent or the user retired it because it contradicts the current design, or it was quarantined after a
 * repair failed). Retired tests stay in the list, never run in the suite, and are skipped by the tasks that
 * reference them.
 */
export class TestService {
  constructor(private readonly store: Store) {}

  upsertForTask(taskId: string, method: VerificationMethod): TestCase | null {
    if (method.kind === 'critic' || method.kind === 'manual') return null;
    const name = testName(taskId, method);
    const existing = this.store.get<{ id: string }>('SELECT id FROM tests WHERE name = ?', [name]);
    const kind: TestCase['kind'] = method.kind === 'static_analysis' ? 'static' : method.kind === 'luau_assert' || method.kind === 'cloud_luau' ? 'luau' : method.kind === 'playtest' || method.kind === 'perf' ? 'playtest' : 'acceptance';
    if (existing) {
      this.store.run('UPDATE tests SET spec = ?, kind = ? WHERE id = ?', [j(method), kind, existing.id]);
      return this.get(existing.id);
    }
    const id = newId('test');
    this.store.run('INSERT INTO tests (id, name, kind, spec, task_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', [id, name, kind, j(method), taskId, nowIso()]);
    return this.get(id);
  }

  register(input: { name: string; method: VerificationMethod; taskId?: string | null }): TestCase {
    const existing = this.store.get<{ id: string }>('SELECT id FROM tests WHERE name = ?', [input.name]);
    const kind: TestCase['kind'] = input.method.kind === 'static_analysis' ? 'static' : input.method.kind === 'luau_assert' ? 'luau' : input.method.kind === 'playtest' ? 'playtest' : 'acceptance';
    if (existing) {
      // Registering a test again is a decision to have it: it runs again, whatever retired it before.
      this.store.run('UPDATE tests SET spec = ?, kind = ?, enabled = 1, retired_reason = NULL, retired_at = NULL, retired_by = NULL WHERE id = ?', [j(input.method), kind, existing.id]);
      return this.get(existing.id)!;
    }
    const id = newId('test');
    this.store.run('INSERT INTO tests (id, name, kind, spec, task_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', [id, input.name, kind, j(input.method), input.taskId ?? null, nowIso()]);
    return this.get(id)!;
  }

  get(id: string): TestCase | null {
    const r = this.store.get<TestRow>('SELECT * FROM tests WHERE id = ?', [id]);
    return r ? hydrate(r) : null;
  }

  list(): TestCase[] {
    return this.store.all<TestRow>('SELECT * FROM tests ORDER BY created_at, rowid').map(hydrate);
  }

  /**
   * Tests a reference points at: an id, a registered name, or the check's own name ("road_not_green":
   * every test with that check, since a repair task used to register copies), else a distinctive part of a
   * registered name. Retired tests are included; callers decide what to do with them.
   */
  find(ref: string): TestCase[] {
    const q = ref.trim();
    if (!q) return [];
    const all = this.list();
    const lower = q.toLowerCase();
    const byId = all.find((t) => t.id === q);
    if (byId) return [byId];
    const exact = all.filter((t) => t.name.toLowerCase() === lower);
    if (exact.length) return exact;
    const byCheck = all.filter((t) => checkName(t.spec).toLowerCase() === lower);
    if (byCheck.length) return byCheck;
    return lower.length >= 4 ? all.filter((t) => t.name.toLowerCase().includes(lower)) : [];
  }

  /** Turn a test on or off from the UI. Turning it on clears a retirement record: someone wants it again. */
  setEnabled(id: string, enabled: boolean): void {
    if (enabled) this.store.run('UPDATE tests SET enabled = 1, retired_reason = NULL, retired_at = NULL, retired_by = NULL WHERE id = ?', [id]);
    else this.store.run('UPDATE tests SET enabled = 0 WHERE id = ?', [id]);
  }

  /** Retire a test (idempotent: the first record stays). Returns it, or null when there is no such test. */
  retire(id: string, reason: string, by: string): TestCase | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.retiredAt) return cur;
    this.store.run('UPDATE tests SET enabled = 0, retired_reason = ?, retired_at = ?, retired_by = ? WHERE id = ?', [reason.slice(0, 1000), nowIso(), by, id]);
    return this.get(id);
  }

  /** Retire every enabled test a task registered (the task was cancelled or replaced). Returns the ones retired now. */
  retireForTask(taskId: string, reason: string, by: string): TestCase[] {
    const ids = this.store.all<{ id: string }>('SELECT id FROM tests WHERE task_id = ? AND enabled = 1', [taskId]);
    return ids.map((r) => this.retire(r.id, reason, by)).filter((t): t is TestCase => !!t);
  }

  /** The cancelled task came back: restore the tests its cancellation retired (not ones someone retired on purpose). */
  restoreForTask(taskId: string): TestCase[] {
    const rows = this.store.all<{ id: string }>('SELECT id FROM tests WHERE task_id = ? AND retired_by = ?', [taskId, RETIRED_BY_CANCEL]);
    for (const r of rows) this.setEnabled(r.id, true);
    return rows.map((r) => this.get(r.id)!);
  }

  /**
   * Enabled tests whose task is cancelled (older projects, or a verification that was still running when the
   * task was cancelled): retired now, with the task named in the record. Returns them with their task titles.
   */
  retireOfCancelledTasks(by = RETIRED_BY_CANCEL): Array<{ test: TestCase; taskTitle: string }> {
    const rows = this.store.all<{ id: string; title: string }>("SELECT t.id AS id, k.title AS title FROM tests t JOIN tasks k ON k.id = t.task_id WHERE t.enabled = 1 AND k.status = 'cancelled'");
    const out: Array<{ test: TestCase; taskTitle: string }> = [];
    for (const r of rows) {
      const test = this.retire(r.id, `Its task "${r.title}" was cancelled`, by);
      if (test) out.push({ test, taskTitle: r.title });
    }
    return out;
  }

  recordResult(input: Omit<TestResult, 'id' | 'createdAt'>): TestResult {
    const r: TestResult = { ...input, id: newId('tr'), createdAt: nowIso() };
    this.store.run('INSERT INTO test_results (id, test_id, run_id, task_id, status, output, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      r.id,
      r.testId,
      r.runId,
      r.taskId,
      r.status,
      r.output.slice(0, 20000),
      r.durationMs,
      r.createdAt,
    ]);
    this.store.run('UPDATE tests SET last_status = ?, last_run_at = ? WHERE id = ?', [r.status, r.createdAt, r.testId]);
    return r;
  }

  results(testId: string, limit = 20): TestResult[] {
    return this.store
      .all<{ id: string; test_id: string; run_id: string | null; task_id: string | null; status: TestResult['status']; output: string; duration_ms: number; created_at: string }>(
        'SELECT * FROM test_results WHERE test_id = ? ORDER BY created_at DESC LIMIT ?',
        [testId, limit],
      )
      .map((r) => ({ id: r.id, testId: r.test_id, runId: r.run_id, taskId: r.task_id, status: r.status, output: r.output, durationMs: r.duration_ms, createdAt: r.created_at }));
  }
}

function hydrate(r: TestRow): TestCase {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    spec: pj(r.spec, { kind: 'static_analysis' } as VerificationMethod),
    taskId: r.task_id,
    enabled: r.enabled === 1,
    lastStatus: r.last_status,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
    retiredReason: r.retired_reason ?? null,
    retiredAt: r.retired_at ?? null,
    retiredBy: r.retired_by ?? null,
  };
}

/** A check's own name ("road_not_green"; a nameless method is called by its kind). */
export function checkName(m: VerificationMethod): string {
  return 'name' in m && m.name ? m.name : m.kind;
}

/** The registered name of the test a task's method becomes: the task's id tail, the kind and the check's name. */
export function testName(taskId: string, m: VerificationMethod): string {
  return `${taskId.slice(-8)}:${m.kind}:${checkName(m)}`.slice(0, 160);
}
