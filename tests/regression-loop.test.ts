import { describe, expect, it, vi } from 'vitest';
import type { Escalation, Task, TestCase, VerificationMethod } from '../src/shared/domain';
import { GLOBAL_MIGRATIONS, PROJECT_MIGRATIONS } from '../src/core/db/schema';
import { Store } from '../src/core/db/store';
import { ROLES, hiddenToolsFor } from '../src/core/agents/roles';
import { ITERATION_REASON } from '../src/core/orchestrator/orchestrator';
import { FIX_PREFIX, MAX_FIX_TASKS, answerPlan, repairChecks, triageFailures } from '../src/core/orchestrator/regression-policy';
import { REPAIR_TARGETS } from '../src/core/orchestrator/regression-wrapup';
import { RETIRED_BY_CANCEL, RETIRED_BY_QUARANTINE, TestService } from '../src/core/verification/test-service';
import { resolveCheck, type MethodResult, type VerificationReport } from '../src/core/verification/verifier';
import { coreHarness, planArgs, waitFor } from './helpers/make-core';

/**
 * A 4.6 h build: five "Fix regressions (n)" tasks ($11.50, seven user prompts, nothing shipped) for one check
 * (`road_not_green`, needing Workspace.Track) that contradicted a newer one (`map_placed_old_track_gone`,
 * needing it gone). The old check belonged to a replaced task; a frozen copy of it was embedded in every repair
 * task; agents had no way to retire it; the answers "Retire road_not_green" did nothing.
 */
const makeCore = coreHarness();

const luauSpec = (name: string, luau = "return 'PASS'"): VerificationMethod => ({ kind: 'luau_assert', name, luau, datamodel: 'edit' });
const failed = (t: TestCase, output = 'FAIL: Workspace.Track is missing'): MethodResult => ({ kind: t.spec.kind, name: t.name, passed: false, output, evidenceId: null, testIds: [t.id] });
const report = (...results: MethodResult[]): VerificationReport => ({ passed: results.every((r) => r.passed !== false), results, summary: `${results.filter((r) => r.passed === false).length} check(s) failed` });
const passing: VerificationReport = { passed: true, results: [], summary: '0 check(s) passed' };

async function setup() {
  const h = await makeCore({
    respond: async (_req, kind) => {
      if (kind === 'work') return { status: 'implemented', summary: 'ok' };
      if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
      return null;
    },
  });
  h.core.orchestrator.pause();
  const tests = new TestService(h.ctx.store);
  const done = (parentId: string | null, title: string, verification: VerificationMethod[] = []): Task => {
    const t = h.ctx.tasks.create({ parentId, kind: 'implement', title, objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test', verification });
    for (const s of ['running', 'verifying', 'verified', 'done'] as const) h.ctx.tasks.setStatus(t.id, s);
    return h.ctx.tasks.get(t.id)!;
  };
  const goal = (title = 'Griever goal') => h.ctx.tasks.create({ kind: 'objective', title, objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  /** What the suite would answer for the given results (the real suite needs Studio for luau checks). */
  const suite = vi.spyOn(h.core.verifier, 'regression');
  return { ...h, tests, done, goal, suite };
}

const fixTasks = (ctx: { tasks: { list: (o: { parentId: string }) => Task[] } }, objId: string) => ctx.tasks.list({ parentId: objId }).filter((t) => t.title.startsWith(FIX_PREFIX));

describe('triage of a failed suite (pure)', () => {
  const t = (id: string): TestCase => ({ id, name: `${id}:luau_assert:${id}`, kind: 'luau', spec: luauSpec(id), taskId: 'task_x', enabled: true, lastStatus: 'fail', lastRunAt: null, createdAt: '', retiredReason: null, retiredAt: null, retiredBy: null });

  it('sends a first failure to one repair, and quarantines what still fails after a repair', () => {
    const [a, b] = [t('road_not_green'), t('spawn_ok')];
    expect(triageFailures([failed(a), failed(b)], new Set())).toEqual({ quarantine: [], repair: [failed(a), failed(b)], untracked: [] });
    const later = triageFailures([failed(a), failed(b)], new Set([a.id]));
    expect(later.quarantine).toEqual([a.id]);
    expect(later.repair.map((r) => r.name)).toEqual([b.name]);
    // A shared result (identical checks run once) stands for every test behind it.
    const shared: MethodResult = { ...failed(a), testIds: [a.id, 'dup1', 'dup2'] };
    expect(triageFailures([shared], new Set(['dup2'])).quarantine).toEqual([a.id, 'dup1', 'dup2']);
    // Failures that are not registered tests (code sync, Studio access) can't be quarantined.
    const sync: MethodResult = { kind: 'luau_assert', name: 'code sync', passed: false, output: 'x', evidenceId: null };
    expect(triageFailures([sync], new Set()).untracked).toEqual([sync]);
  });

  it('repairs by reference: the failing tests with their ids, one per distinct check, never static analysis', () => {
    const a = t('a');
    const copy = { ...t('b'), spec: luauSpec('a') };
    const sa: TestCase = { ...t('c'), spec: { kind: 'static_analysis' } };
    const checks = repairChecks([a, copy, sa], [failed(a), failed(copy), failed(sa)]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ kind: 'luau_assert', name: 'a', testId: 'a' });
  });

  it('reads "Retire road_not_green" and "Drop it from this task\'s verification" as actions on the right test', () => {
    const road = t('road_not_green');
    const other = t('map_placed_old_track_gone');
    const sa: TestCase = { ...t('static'), name: 'x:static_analysis:static_analysis', spec: { kind: 'static_analysis' } };
    const question = `Repeated failure: Fix regressions (1)\n[${road.name}]\nFAIL: Workspace.Track is missing`;
    expect(answerPlan('Retire road_not_green', [road, other, sa], question)).toMatchObject({ scope: 'global', tests: [{ id: 'road_not_green' }] });
    expect(answerPlan('Please retire the old check road_not_green, the new one is right', [road, other], question)?.tests.map((x) => x.id)).toEqual(['road_not_green']);
    // "it" is whatever the question was about, and "from this task's verification" is task-scoped.
    expect(answerPlan("Drop it from this task's verification", [road, other], question)).toMatchObject({ scope: 'task', tests: [{ id: 'road_not_green' }] });
    expect(answerPlan('retire that test', [road, other], question)?.tests.map((x) => x.id)).toEqual(['road_not_green']);
    // Not an action: no verb, a bare "skip that", something else, a name that is not a test, static analysis.
    expect(answerPlan('Looks fine, retry', [road], question)).toBeNull();
    expect(answerPlan('skip that for now', [road], question)).toBeNull();
    expect(answerPlan('retire the shop button', [road], question)).toBeNull();
    expect(answerPlan('retire static_analysis', [sa], 'x')).toBeNull();
  });
});

describe('retiring tests', () => {
  const store = () => new Store(':memory:', PROJECT_MIGRATIONS);

  it('keeps retired tests with a record of why, who and when; re-enabling clears it', () => {
    const svc = new TestService(store());
    const t = svc.register({ name: 'abc12345:luau_assert:road_not_green', method: luauSpec('road_not_green'), taskId: 'task_a' });
    const dup = svc.register({ name: 'def67890:luau_assert:road_not_green', method: luauSpec('road_not_green'), taskId: 'task_b' });
    // By id, by registered name, by the check's own name (every copy), by a distinctive part.
    expect(svc.find(t.id).map((x) => x.id)).toEqual([t.id]);
    expect(svc.find('ABC12345:luau_assert:road_not_green').map((x) => x.id)).toEqual([t.id]);
    expect(svc.find('road_not_green').map((x) => x.id).sort()).toEqual([t.id, dup.id].sort());
    expect(svc.find('not_green').length).toBe(2);
    expect(svc.find('zz')).toEqual([]);
    const r = svc.retire(t.id, 'Replaced by map_placed_old_track_gone', 'qa-engineer')!;
    expect(r).toMatchObject({ enabled: false, retiredReason: 'Replaced by map_placed_old_track_gone', retiredBy: 'qa-engineer' });
    expect(r.retiredAt).toBeTruthy();
    // The first record stays.
    expect(svc.retire(t.id, 'something else', 'user')!.retiredReason).toBe('Replaced by map_placed_old_track_gone');
    expect(svc.list().filter((x) => x.enabled).map((x) => x.id)).toEqual([dup.id]);
    // Someone wanting it again (the UI, a new registration) clears the record.
    svc.setEnabled(t.id, true);
    expect(svc.get(t.id)).toMatchObject({ enabled: true, retiredReason: null, retiredAt: null, retiredBy: null });
    svc.retire(t.id, 'again', 'user');
    svc.register({ name: t.name, method: luauSpec('road_not_green', "return 'FAIL'"), taskId: 'task_a' });
    expect(svc.get(t.id)).toMatchObject({ enabled: true, retiredAt: null });
    // A manual disable is not a retirement.
    svc.setEnabled(dup.id, false);
    expect(svc.get(dup.id)).toMatchObject({ enabled: false, retiredAt: null });
  });

  it('restores only what a cancellation retired, when the task comes back', () => {
    const s = store();
    const svc = new TestService(s);
    const a = svc.register({ name: 'n1', method: luauSpec('one'), taskId: 'task_a' });
    const b = svc.register({ name: 'n2', method: luauSpec('two'), taskId: 'task_a' });
    svc.retire(b.id, 'by an agent', 'qa-engineer');
    const gone = svc.retireForTask('task_a', 'Task A was cancelled', RETIRED_BY_CANCEL);
    expect(gone.map((x) => x.id)).toEqual([a.id]);
    expect(svc.restoreForTask('task_a').map((x) => x.id)).toEqual([a.id]);
    expect(svc.get(a.id)!.enabled).toBe(true);
    expect(svc.get(b.id)!.enabled).toBe(false);
  });

  it('resolves a task check to its registered test: retired is skipped, a reference runs the current spec', () => {
    const svc = new TestService(store());
    const task = { id: 'task_01aaaaaaaa', verification: [] } as unknown as Task;
    const own = luauSpec('road_not_green');
    const first = resolveCheck(svc, task, own);
    expect(first.skip).toBeUndefined();
    expect(first.test!.name).toBe('aaaaaaaa:luau_assert:road_not_green');
    svc.retire(first.test!.id, 'Replaced by the new map', 'qa-engineer');
    expect(resolveCheck(svc, task, own).skip).toMatch(/retired \(Replaced by the new map\)/);
    // A reference follows the registered test, not the copy it carries.
    const reg = svc.register({ name: 'shared', method: luauSpec('shared', "return 'PASS: new'"), taskId: 'task_other' });
    const ref = { ...luauSpec('shared', "return 'FAIL: frozen'"), testId: reg.id } as VerificationMethod;
    expect((resolveCheck(svc, task, ref).method as { luau: string }).luau).toBe("return 'PASS: new'");
    svc.retire(reg.id, 'contradicts the new design', 'user');
    expect(resolveCheck(svc, task, ref).skip).toMatch(/contradicts the new design/);
    // A deleted test leaves the copy to run.
    expect(resolveCheck(svc, task, { ...luauSpec('x'), testId: 'test_gone' } as VerificationMethod).skip).toBeUndefined();
  });

  it('adds the retirement columns to a project created before them', () => {
    const path = `${process.env.TEMP ?? '.'}/retire-${Date.now()}.db`;
    const old = new Store(path, PROJECT_MIGRATIONS.filter((m) => m.version < 8));
    old.run("INSERT INTO tests (id, name, kind, spec, task_id, enabled, created_at) VALUES ('t1', 'n', 'luau', '{\"kind\":\"static_analysis\"}', NULL, 1, 'x')");
    old.close();
    const upgraded = new Store(path, PROJECT_MIGRATIONS);
    expect(new TestService(upgraded).get('t1')).toMatchObject({ enabled: true, retiredAt: null, retiredReason: null });
    upgraded.close();
    expect(GLOBAL_MIGRATIONS.length).toBeGreaterThan(0);
  });
});

describe('a cancelled or replaced task retires the tests it registered', () => {
  it('records why on the test and on the timeline, and the suite never runs them', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    const g = goal();
    const old = ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'Old road', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test', planKey: 'old_road', verification: [luauSpec('road_not_green')] });
    const road = tests.upsertForTask(old.id, luauSpec('road_not_green'))!;
    const fresh = ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'Imported map', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test', planKey: 'map' });
    const plan = ctx.tasks.create({ parentId: g.id, kind: 'plan', title: 'Update plan', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const planner = { kind: 'agent' as const, runId: 'run_p', taskId: plan.id, role: 'executive', providerId: null, allowedTools: null };
    const r = await core.tools.invoke('plan_cancel_task', { task: 'old_road', reason: 'the imported map replaces the road', replaced_by: 'map' }, planner);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content.map((c) => ('text' in c ? c.text : '')).join(''))).toMatchObject({ cancelled: old.id, retiredTests: 1 });
    const after = tests.get(road.id)!;
    expect(after).toMatchObject({ enabled: false, retiredBy: RETIRED_BY_CANCEL });
    expect(after.retiredReason).toMatch(/Old road.*cancelled.*the imported map replaces the road.*replaced by "Imported map"/);
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'test.retired' && /of the cancelled task "Old road"/.test(e.title))).toBe(true);
    // A dropped task's test that slipped in after the cancellation (its verification was still running) is swept by the suite.
    const late = tests.upsertForTask(old.id, luauSpec('road_late'))!;
    suite.mockRestore();
    const real = await core.verifier.regression(ctx, null);
    expect(real.results.map((x) => x.name)).not.toContain(late.name);
    expect(tests.get(late.id)).toMatchObject({ enabled: false, retiredBy: RETIRED_BY_CANCEL });
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'test.retired' && /of cancelled tasks/.test(e.title))).toBe(true);
    // The task coming back brings its test back.
    ctx.tasks.setStatus(old.id, 'ready', 'Run requested by user', 'user');
    expect(tests.get(road.id)).toMatchObject({ enabled: true, retiredAt: null });
    expect(fresh.status).toBe('ready');
    void done;
  });
});

describe('the wrap-up never loops on a repair', () => {
  it('makes exactly one repair task, by reference, for the tests that failed, and keeps a record of its targets', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    const g = goal();
    const worked = done(g.id, 'Road');
    const road = tests.upsertForTask(worked.id, luauSpec('road_not_green'))!;
    suite.mockResolvedValue(report(failed(road)));
    core.orchestrator.resume();
    const fix = await waitFor(() => fixTasks(ctx, g.id)[0]);
    core.orchestrator.pause();
    expect(fix).toMatchObject({ title: 'Fix regressions (1)', role: 'qa-engineer', status: 'ready' });
    expect(fix.verification.map((m) => m.kind)).toEqual(['static_analysis', 'luau_assert', 'critic']);
    expect(fix.verification[1]).toMatchObject({ name: 'road_not_green', testId: road.id });
    expect(fix.objective).toMatch(/test_retire/);
    expect(ctx.tasks.evidence(fix.id).find((e) => e.title === REPAIR_TARGETS)?.data).toMatchObject({ testIds: [road.id] });
    expect(ctx.tasks.get(g.id)!.status).toBe('ready');
    // The objective doesn't wrap up again, or make another repair, while that one is open.
    core.orchestrator.kick();
    await new Promise((r) => setTimeout(r, 600));
    expect(fixTasks(ctx, g.id)).toHaveLength(1);
  }, 60000);

  it('quarantines a test that still fails after its repair task, says so, and lets the objective finish', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    const g = goal();
    const worked = done(g.id, 'Road');
    const road = tests.upsertForTask(worked.id, luauSpec('road_not_green'))!;
    const other = tests.upsertForTask(worked.id, luauSpec('spawn_ok'))!;
    // A repair task already had its go at road_not_green (and is done); both still fail.
    done(g.id, 'Fix regressions (1)', [{ kind: 'static_analysis' }, { ...luauSpec('road_not_green'), testId: road.id } as VerificationMethod]);
    suite.mockResolvedValue(report(failed(road), failed(other, 'FAIL: no spawn')));
    core.orchestrator.resume();
    // spawn_ok has not had a repair yet: it gets the (single) next repair task; road_not_green is quarantined.
    const fix = await waitFor(() => fixTasks(ctx, g.id).find((t) => t.status === 'ready'));
    core.orchestrator.pause();
    expect(tests.get(road.id)).toMatchObject({ enabled: false, retiredBy: RETIRED_BY_QUARANTINE });
    expect(tests.get(road.id)!.retiredReason).toMatch(/Still failing after the repair task "Fix regressions \(1\)"/);
    expect(tests.get(other.id)!.enabled).toBe(true);
    expect(fix.verification.filter((m) => 'testId' in m && m.testId).map((m) => (m as { testId: string }).testId)).toEqual([other.id]);
    const ev = ctx.audit.timeline({ limit: 100 }).find((e) => e.kind === 'test.quarantined');
    expect(ev?.severity).toBe('warning');
    expect(ev?.title).toMatch(/Quarantined regression test road_not_green/);
    // ...and the chat says so too, in plain words (a quiet status line; the timeline's own words are its detail).
    const line = core.director.chat()!.list().find((m) => m.kind === 'status' && /set aside/.test(m.text))!;
    expect(line.text).toBe('1 automated check ("road not green") still fails after a repair and was set aside so the goal can finish. You can turn it back on from the Tests list once fixed.');
    expect(line.data?.technical).toMatch(/Quarantined regression test road_not_green/);
  }, 60000);

  it('finishes the objective when every failure is a quarantined one, noting it on the objective', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    const g = goal();
    const worked = done(g.id, 'Road');
    const road = tests.upsertForTask(worked.id, luauSpec('road_not_green'))!;
    done(g.id, 'Fix regressions (1)', [{ kind: 'static_analysis' }, { ...luauSpec('road_not_green'), testId: road.id } as VerificationMethod]);
    suite.mockResolvedValue(report(failed(road)));
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(g.id)!.status === 'done');
    expect(fixTasks(ctx, g.id)).toHaveLength(1); // the old one only
    expect(ctx.tasks.get(g.id)!.result).toMatch(/Quarantined \(still failing after their repair, no longer blocking\): .*road_not_green/);
    expect(tests.get(road.id)!.enabled).toBe(false);
  }, 60000);

  it('in autonomous mode quarantines after the cap and finishes, with nothing waiting for the user', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    const g = goal();
    const worked = done(g.id, 'Road');
    const all = ['a_check', 'b_check', 'c_check', 'd_check'].map((n) => tests.upsertForTask(worked.id, luauSpec(n))!);
    for (let i = 0; i < MAX_FIX_TASKS; i++) done(g.id, `Fix regressions (${i + 1})`, [{ kind: 'static_analysis' }, { ...luauSpec(`${all[i]!.id}`), testId: all[i]!.id } as VerificationMethod]);
    suite.mockResolvedValue(report(failed(all[3]!)));
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(g.id)!.status === 'done');
    expect(fixTasks(ctx, g.id)).toHaveLength(MAX_FIX_TASKS);
    expect(tests.get(all[3]!.id)).toMatchObject({ enabled: false, retiredBy: RETIRED_BY_QUARANTINE });
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    const decided = ctx.governance.escalations().find((e) => /keeps failing/.test(e.title));
    expect(decided).toMatchObject({ status: 'auto_resolved', taskId: g.id });
    expect(decided!.detail).toMatch(/d_check/);
  }, 60000);

  it('asks the user after the cap instead of making repair task number four, and a second ask quarantines', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    ctx.updateSettings({ permissionMode: 'ask' });
    const g = goal();
    const worked = done(g.id, 'Road');
    const all = ['a_check', 'b_check', 'c_check', 'd_check'].map((n) => tests.upsertForTask(worked.id, luauSpec(n))!);
    for (let i = 0; i < MAX_FIX_TASKS; i++) done(g.id, `Fix regressions (${i + 1})`, [{ kind: 'static_analysis' }, { ...luauSpec(`${all[i]!.id}`), testId: all[i]!.id } as VerificationMethod]);
    // d_check never had a repair, but the objective already had the maximum.
    suite.mockResolvedValue(report(failed(all[3]!)));
    core.orchestrator.resume();
    const esc = await waitFor(() => ctx.governance.escalations('open').find((e) => /keeps failing/.test(e.title)));
    core.orchestrator.pause();
    expect(esc.taskId).toBe(g.id);
    expect(esc.detail).toMatch(/d_check/);
    expect(ctx.tasks.get(g.id)!.status).toBe('escalated');
    expect(fixTasks(ctx, g.id)).toHaveLength(MAX_FIX_TASKS);
    // "retry" with the check still failing: the user was asked once, so it is quarantined rather than asked again.
    ctx.governance.resolveEscalation(esc.id, 'answered', 'retry');
    expect(ctx.tasks.get(g.id)!.status).toBe('ready');
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(g.id)!.status === 'done');
    expect(tests.get(all[3]!.id)).toMatchObject({ enabled: false, retiredBy: RETIRED_BY_QUARANTINE });
    expect(ctx.governance.escalations('open').filter((e) => /keeps failing/.test(e.title))).toHaveLength(0);
  }, 60000);
});

describe('the wrap-up scope', () => {
  it('shows the final review in the orchestrator state while it runs (the Agents panel card), and clears it after', async () => {
    const { core, ctx, goal, done, suite } = await setup();
    const seen: Array<{ check: string | null; done: number; total: number } | null> = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    suite.mockImplementation(async (_p, _run, opts) => {
      opts?.onProgress?.({ check: null, done: 0, total: 2, studio: true });
      opts?.onProgress?.({ check: 'lobby_spawn_walk', done: 1, total: 2, studio: true });
      seen.push(core.orchestrator.state().finalCheck ?? null);
      await held;
      return passing;
    });
    const g = goal('Hoverboard Racing');
    done(g.id, 'Track');
    core.orchestrator.resume();
    await waitFor(() => seen.length > 0);
    expect(core.orchestrator.state().finalCheck).toMatchObject({ objectiveId: g.id, title: 'Hoverboard Racing', iteration: false, check: 'lobby_spawn_walk', done: 1, total: 2 });
    expect(core.orchestrator.state().finalCheck!.studioSince).toBeTruthy();
    release();
    await waitFor(() => ctx.tasks.get(g.id)!.status === 'done');
    expect(core.orchestrator.state().finalCheck).toBeNull();
  }, 60000);

  it('runs only its own checks for a quick iteration, and the full suite only for the main objective', async () => {
    const { core, ctx, goal, done, tests, suite } = await setup();
    suite.mockResolvedValue(passing);
    const main = goal('Main goal');
    done(main.id, 'Main work');
    const quick = ctx.tasks.create({ kind: 'objective', title: 'Quick tweak', objective: 'x', role: 'executive', reason: ITERATION_REASON, status: 'running', createdBy: 'director' });
    const own = done(quick.id, 'Tweak');
    tests.upsertForTask(own.id, luauSpec('tweak_ok'));
    // Only the iteration is complete: the main objective still has an open task.
    ctx.tasks.create({ parentId: main.id, kind: 'implement', title: 'Main still open', objective: 'x', role: 'roblox-engineer', status: 'paused', createdBy: 'test' });
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(quick.id)!.status === 'done');
    expect(suite).toHaveBeenCalledTimes(1);
    const opts = suite.mock.calls[0]![2] as { taskIds?: Set<string>; skipStatic?: boolean };
    expect([...opts.taskIds!]).toEqual([own.id]);
    expect(opts.skipStatic).toBe(true);
    expect(ctx.tasks.get(main.id)!.status).toBe('running');
    // The main objective's wrap-up is the whole suite.
    ctx.tasks.setStatus(ctx.tasks.list({ parentId: main.id }).find((t) => t.title === 'Main still open')!.id, 'cancelled');
    await waitFor(() => ctx.tasks.get(main.id)!.status === 'done');
    expect((suite.mock.calls[1]![2] as { taskIds?: unknown }).taskIds).toBeUndefined();
  }, 60000);

  it('lets an iteration finish although a global check fails (it is not its check)', async () => {
    const { core, ctx, goal, done, tests } = await setup();
    // The real suite with static analysis: one test of another objective's task fails, the iteration's passes.
    vi.spyOn(core.luau, 'check').mockImplementation(async (_root, _map, o) => {
      const bad = (o?.paths ?? []).includes('bad');
      return { ok: !bad, problems: bad ? [{ tool: 'selene', file: 'bad.luau', line: 1, column: 1, severity: 'error', code: 'x', message: 'broken' }] : [], toolErrors: [], durationMs: 1 };
    });
    const main = goal('Main goal');
    const mainWork = done(main.id, 'Main work');
    tests.upsertForTask(mainWork.id, { kind: 'static_analysis', paths: ['bad'] });
    const quick = ctx.tasks.create({ kind: 'objective', title: 'Quick tweak', objective: 'x', role: 'executive', reason: ITERATION_REASON, status: 'running', createdBy: 'director' });
    const own = done(quick.id, 'Tweak');
    tests.upsertForTask(own.id, { kind: 'static_analysis', paths: ['good'] });
    ctx.tasks.create({ parentId: main.id, kind: 'implement', title: 'Main still open', objective: 'x', role: 'roblox-engineer', status: 'paused', createdBy: 'test' });
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(quick.id)!.status === 'done');
    expect(ctx.tasks.list({ parentId: quick.id }).some((t) => t.title.startsWith(FIX_PREFIX))).toBe(false);
  }, 60000);

  it("waits to run the full suite while another objective's work is in flight in the same place", async () => {
    const { core, ctx, goal, done, suite } = await setup();
    suite.mockResolvedValue(passing);
    const main = goal('Main goal');
    done(main.id, 'Main work');
    const other = goal('Map import');
    const running = ctx.tasks.create({ parentId: other.id, kind: 'implement', title: 'Import the map', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    ctx.tasks.setStatus(running.id, 'running');
    core.orchestrator.resume();
    await new Promise((r) => setTimeout(r, 1500));
    expect(suite).not.toHaveBeenCalled();
    expect(ctx.tasks.get(main.id)!.status).toBe('running');
    expect(core.orchestrator.state().lastDecision).toMatch(/Waiting to run the regression suite for "Main goal": "Import the map" of "Map import" is in progress/);
    for (const s of ['verifying', 'verified', 'done'] as const) ctx.tasks.setStatus(running.id, s);
    await waitFor(() => ctx.tasks.get(main.id)!.status === 'done');
    expect(suite).toHaveBeenCalled();
  }, 60000);
});

describe('answers to a question about a check', () => {
  const escalated = async (answer: string) => {
    const h = await setup();
    const g = h.goal();
    const worked = h.done(g.id, 'Road');
    const road = h.tests.upsertForTask(worked.id, luauSpec('road_not_green'))!;
    const fix = h.ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'Fix regressions (1)', objective: 'x', role: 'qa-engineer', status: 'ready', createdBy: 'executive', verification: [{ kind: 'static_analysis' }, { ...luauSpec('road_not_green'), testId: road.id } as VerificationMethod, { kind: 'critic' }] });
    h.ctx.tasks.setStatus(fix.id, 'running');
    h.ctx.tasks.setStatus(fix.id, 'failed', 'x');
    h.ctx.tasks.setStatus(fix.id, 'escalated', 'x');
    h.tests.recordResult({ testId: road.id, runId: null, taskId: fix.id, status: 'fail', output: 'FAIL', durationMs: 1 });
    const e = h.ctx.governance.escalate({ kind: 'failure', title: 'Repeated failure: Fix regressions (1)', detail: `Failed 3 time(s).\n\n[road_not_green]\nFAIL: Workspace.Track is missing`, taskId: fix.id, options: ['retry', 'cancel'] });
    h.suite.mockResolvedValue(passing);
    h.ctx.governance.resolveEscalation(e.id, 'answered', answer);
    return { ...h, g, fix, road, e };
  };

  it('"Retire road_not_green" retires it, ends the repair task that was only about it, and the objective finishes', async () => {
    const { ctx, g, fix, road, tests, core } = await escalated('Retire road_not_green');
    expect(tests.get(road.id)).toMatchObject({ enabled: false, retiredBy: 'user' });
    expect(tests.get(road.id)!.retiredReason).toMatch(/Retire road_not_green/);
    expect(ctx.tasks.get(fix.id)!.status).toBe('cancelled');
    expect(ctx.audit.timeline({ limit: 100 }).some((x) => x.kind === 'test.retired' && /at your answer/.test(x.title))).toBe(true);
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(g.id)!.status === 'done');
    expect(fixTasks(ctx, g.id)).toHaveLength(1);
  }, 60000);

  it('"Drop it from this task\'s verification" drops the failing check from the task (and ends a repair task that only had it)', async () => {
    const { ctx, fix, road, tests } = await escalated("Drop it from this task's verification");
    expect(ctx.tasks.get(fix.id)!.verification.map((m) => m.kind)).toEqual(['static_analysis', 'critic']);
    expect(ctx.tasks.get(fix.id)!.status).toBe('cancelled');
    expect(tests.get(road.id)!.retiredAt).toBeTruthy();
  }, 60000);

  it('drops a check from an ordinary task without retiring tests it does not own, and re-queues the task', async () => {
    const h = await setup();
    const g = h.goal();
    const t = h.ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'New map', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test', verification: [{ kind: 'static_analysis' }, luauSpec('map_placed_old_track_gone'), luauSpec('spawn_ok'), { kind: 'critic' }] });
    const mine = h.tests.upsertForTask(t.id, luauSpec('map_placed_old_track_gone'))!;
    const keep = h.tests.upsertForTask(t.id, luauSpec('spawn_ok'))!;
    h.ctx.tasks.setStatus(t.id, 'running');
    h.ctx.tasks.setStatus(t.id, 'failed', 'x');
    h.ctx.tasks.setStatus(t.id, 'escalated', 'x');
    const e = h.ctx.governance.escalate({ kind: 'failure', title: 'Repeated failure: New map', detail: 'Verification failed: map_placed_old_track_gone: FAIL', taskId: t.id, options: ['retry', 'cancel'] });
    h.ctx.governance.resolveEscalation(e.id, 'answered', 'Drop map_placed_old_track_gone from this task\'s verification');
    expect(h.ctx.tasks.get(t.id)!.verification.map((m) => ('name' in m ? m.name : m.kind))).toEqual(['static_analysis', 'spawn_ok', 'critic']);
    expect(h.ctx.tasks.get(t.id)!.status).toBe('ready');
    expect(h.tests.get(mine.id)!.retiredAt).toBeTruthy(); // the task's own test goes with the check
    expect(h.tests.get(keep.id)!.enabled).toBe(true);
  });

  it('ignores answers that are not about a test, and "retry" just re-queues', async () => {
    const { ctx, fix, road, tests } = await escalated('retry');
    expect(tests.get(road.id)!.enabled).toBe(true);
    expect(ctx.tasks.get(fix.id)!.status).toBe('ready');
  }, 60000);
});

describe('agents settle contradictions with test_retire and task_update_verification', () => {
  const as = (role: string, taskId: string | null = null) => ({ kind: 'agent' as const, runId: 'run_x', taskId, role, providerId: null, allowedTools: ROLES[role]!.appTools ? new Set(ROLES[role]!.appTools!) : null, hiddenTools: hiddenToolsFor(ROLES[role]!) });
  const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

  it('are visible to the planner and QA only', () => {
    for (const tool of ['test_list', 'test_retire', 'task_update_verification']) {
      expect(ROLES.executive!.appTools, tool).toContain(tool);
      expect(hiddenToolsFor(ROLES['qa-engineer']!)!.has(tool), tool).toBe(false);
      for (const role of ['roblox-engineer', 'luau-engineer', 'level-designer', 'modeler', 'ui-engineer'] as const) expect(hiddenToolsFor(ROLES[role]!)!.has(tool), `${role} ${tool}`).toBe(true);
      expect(ROLES.critic!.appTools, tool).not.toContain(tool);
      expect(ROLES.director!.appTools, tool).not.toContain(tool);
    }
  });

  it('retires a test by the check name with a recorded reason, and the repair task skips it', async () => {
    const { core, ctx, goal, done, tests } = await setup();
    const g = goal();
    const worked = done(g.id, 'Road');
    const road = tests.upsertForTask(worked.id, luauSpec('road_not_green'))!;
    const dup = tests.upsertForTask(done(g.id, 'Road copy').id, luauSpec('road_not_green'))!;
    const fix = ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'Fix regressions (1)', objective: 'x', role: 'qa-engineer', status: 'running', createdBy: 'executive', verification: [{ kind: 'static_analysis' }, { ...luauSpec('road_not_green'), testId: road.id } as VerificationMethod] });
    const short = await core.tools.invoke('test_retire', { test: 'road_not_green', reason: 'too short' }, as('qa-engineer', fix.id));
    expect(short.isError).toBe(true);
    const r = await core.tools.invoke('test_retire', { test: 'road_not_green', reason: 'The imported map has no Workspace.Track by design; map_placed_old_track_gone requires it gone.' }, as('qa-engineer', fix.id));
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Retired 2 tests/);
    for (const t of [road, dup]) expect(tests.get(t.id)).toMatchObject({ enabled: false, retiredBy: 'qa-engineer' });
    expect(tests.get(road.id)!.retiredReason).toMatch(/imported map has no Workspace.Track by design/);
    expect(ctx.audit.timeline({ limit: 50 }).some((e) => e.kind === 'test.retired' && e.role === 'qa-engineer' && /road_not_green/.test(e.title))).toBe(true);
    expect(ctx.tasks.evidence(fix.id).some((e) => /Retired regression test road_not_green/.test(e.title))).toBe(true);
    // Retired again: nothing more to do. Unknown names say how to look.
    expect(text(await core.tools.invoke('test_retire', { test: 'road_not_green', reason: 'again, for the record please' }, as('qa-engineer', fix.id)))).toMatch(/Already retired/);
    expect((await core.tools.invoke('test_retire', { test: 'nope_nothing', reason: 'there is no such test at all' }, as('executive'))).isError).toBe(true);
    // The repair task's verification skips it (note on the task) instead of running a frozen copy.
    const verdict = await core.verifier.verify(ctx, ctx.tasks.get(fix.id)!, null);
    const skipped = verdict.results.find((x) => x.name === 'road_not_green')!;
    expect(skipped).toMatchObject({ passed: null });
    expect(skipped.output).toMatch(/^Skipped: retired/);
    expect(ctx.tasks.evidence(fix.id).some((e) => /skipped: retired/.test(e.title))).toBe(true);
    expect(verdict.passed).toBe(true);
    // test_list shows retired ones on request, with why.
    const list = JSON.parse(text(await core.tools.invoke('test_list', { query: 'road', include_retired: true }, as('qa-engineer')))) as Array<{ check: string; retired?: { reason: string } }>;
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.check === 'road_not_green' && /by design/.test(x.retired!.reason!))).toBe(true);
    expect(JSON.parse(text(await core.tools.invoke('test_list', { query: 'road' }, as('qa-engineer'))))).toEqual([]);
  }, 60000);

  it('changes a task\'s checks: removes by name (retiring its own registered test), adds new ones, keeps static analysis and the critic', async () => {
    const { core, ctx, goal, tests } = await setup();
    const g = goal();
    const t = ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'New map', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test', planKey: 'map', verification: [{ kind: 'static_analysis' }, luauSpec('map_placed_old_track_gone'), luauSpec('spawn_ok'), { kind: 'critic' }] });
    const own = tests.upsertForTask(t.id, luauSpec('map_placed_old_track_gone'))!;
    const plan = ctx.tasks.create({ parentId: g.id, kind: 'plan', title: 'Update plan', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const call = (args: Record<string, unknown>) => core.tools.invoke('task_update_verification', args, as('executive', plan.id));
    const bad = await call({ task: 'map', remove: ['nonexistent'], reason: 'removing something that is not there' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/no check named "nonexistent"/);
    expect((await call({ task: 'map', remove: ['static_analysis'], reason: 'static analysis stays no matter what' })).isError).toBe(true);
    const r = await call({ task: 'map', remove: ['map_placed_old_track_gone'], add: [{ kind: 'luau_assert', name: 'track_replaced', luau: "return 'PASS'" }], reason: 'the imported map keeps a Track folder; assert the replacement instead' });
    expect(r.isError, text(r)).toBeFalsy();
    const now = ctx.tasks.get(t.id)!;
    expect(now.verification.map((m) => ('name' in m ? m.name : m.kind))).toEqual(['static_analysis', 'spawn_ok', 'track_replaced', 'critic']);
    expect(tests.get(own.id)).toMatchObject({ enabled: false, retiredBy: 'executive' });
    expect(ctx.audit.timeline({ limit: 50 }).some((e) => e.kind === 'task.verification' && /removed map_placed_old_track_gone; added track_replaced/.test(e.title))).toBe(true);
    // A finished task's checks no longer matter; an objective has none.
    const fin = done0(ctx, g.id);
    expect((await call({ task: fin.id, remove: ['x'], reason: 'it is finished already, so no' })).isError).toBe(true);
    expect((await call({ task: g.id, remove: ['x'], reason: 'objectives have no checks of their own' })).isError).toBe(true);
    // QA can do it too.
    expect((await core.tools.invoke('task_update_verification', { task: t.id, add: [{ kind: 'luau_assert', name: 'extra', luau: "return 'PASS'" }], reason: 'qa adds a check it needs for the new map' }, as('qa-engineer'))).isError).toBeFalsy();
  }, 60000);

  it('the audit scenario: a replaced task\'s frozen check no longer fails the wrap-up', async () => {
    // road_not_green belongs to the replaced task; the replacement requires the track gone. Cancelling the old task
    // through the planner retires its test, so the suite (real, static checks) has nothing contradictory left to fail.
    const { core, ctx, goal, tests, suite } = await setup();
    suite.mockRestore();
    const g = goal();
    const old = ctx.tasks.create({ parentId: g.id, kind: 'implement', title: 'Old road', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test', planKey: 'old_road' });
    const road = tests.upsertForTask(old.id, { kind: 'static_analysis', paths: ['bad'] })!;
    vi.spyOn(core.luau, 'check').mockImplementation(async (_r, _m, o) => {
      const bad = (o?.paths ?? []).includes('bad');
      return { ok: !bad, problems: bad ? [{ tool: 'selene', file: 'bad.luau', line: 1, column: 1, severity: 'error', code: 'x', message: 'old track is gone' }] : [], toolErrors: [], durationMs: 1 };
    });
    const replacement = done0(ctx, g.id);
    const before = await core.verifier.regression(ctx, null);
    expect(before.passed).toBe(false);
    expect(before.results.find((r) => r.passed === false)?.testIds).toEqual([road.id]);
    core.orchestrator.cancel(old.id, 'the imported map replaces the road', 'executive');
    const after = await core.verifier.regression(ctx, null);
    expect(after.passed).toBe(true);
    expect(tests.get(road.id)!.retiredReason).toMatch(/imported map replaces the road/);
    void replacement;
    void planArgs;
  }, 60000);
});

function done0(ctx: { tasks: { create: (i: never) => Task; setStatus: (id: string, s: never) => Task; get: (id: string) => Task | null } }, parentId: string): Task {
  const t = ctx.tasks.create({ parentId, kind: 'implement', title: 'Finished', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' } as never);
  for (const s of ['running', 'verifying', 'verified', 'done']) ctx.tasks.setStatus(t.id, s as never);
  return ctx.tasks.get(t.id)!;
}

type _Unused = Escalation;
