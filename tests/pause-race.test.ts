import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/shared/domain';
import type { VerificationReport } from '../src/core/verification/verifier';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * A 4.6 h build: the user paused at 22:10:11 and stopped at 22:10:32, yet at 22:10:53 the objective
 * finalizer still made a "Fix regressions" task and at 22:11:17 three agents (re)started. Orchestrator.tick()
 * had computed "manual" once, then awaited the regression suite for minutes, then scheduled on the stale value.
 */
const makeCore = coreHarness();

const failing: VerificationReport = {
  passed: false,
  summary: '1 check(s) failed: road_not_green: FAIL: no track',
  results: [{ kind: 'luau_assert', name: 'road_not_green', passed: false, output: 'FAIL: no track', evidenceId: null }],
};
const passing: VerificationReport = { passed: true, summary: '1 check(s) passed', results: [{ kind: 'luau_assert', name: 'road_not_green', passed: true, output: 'PASS', evidenceId: null }] };

async function setup() {
  const h = await makeCore({
    respond: async (_req, kind) => {
      if (kind === 'work') return { status: 'implemented', summary: 'ok' };
      if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
      return null;
    },
  });
  const { core, ctx } = h;
  core.orchestrator.pause();
  // A goal whose tasks are all complete: the next tick runs its regression suite.
  const goal = ctx.tasks.create({ kind: 'objective', title: 'Finished goal', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const done = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Finished work', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
  for (const s of ['running', 'verifying', 'verified', 'done'] as const) ctx.tasks.setStatus(done.id, s);
  // Another goal's task that becomes ready while the suite runs (the scheduler would start it as soon as the tick
  // came back): it must wait for the user too. (Made later: a ready task already there would hold the suite back.)
  const other = ctx.tasks.create({ kind: 'objective', title: 'Other goal', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  let waiting: Task | null = null;
  const addWaiting = () => (waiting = ctx.tasks.create({ parentId: other.id, kind: 'implement', title: 'Waiting work', objective: 'y', role: 'roblox-engineer', status: 'ready', createdBy: 'test' }));
  let result: VerificationReport = failing;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  let sawSignal: AbortSignal | undefined;
  vi.spyOn(core.verifier, 'regression').mockImplementation(async (_p, _run, opts) => {
    entered = true;
    sawSignal = opts?.signal;
    await Promise.race([gate, new Promise<void>((r) => opts?.signal?.addEventListener('abort', () => r(), { once: true }))]);
    return opts?.signal?.aborted ? { ...result, aborted: true } : result;
  });
  return { ...h, goal, addWaiting, waiting: () => waiting!, entered: () => entered, signal: () => sawSignal, release: () => release(), set: (r: VerificationReport) => (result = r) };
}

const workRuns = (provider: { runs: Array<{ outputSchema?: unknown }> }) => provider.runs.filter((r) => 'status' in ((r.outputSchema as { properties?: object } | undefined)?.properties ?? {}));

describe('pausing while the regression suite runs', () => {
  it('creates no repair task and starts no agent when the suite comes back after the pause', async () => {
    const t = await setup();
    t.core.orchestrator.resume();
    await waitFor(() => t.entered());
    expect(t.ctx.tasks.get(t.goal.id)!.status).toBe('verifying');
    t.addWaiting();
    t.core.orchestrator.pause();
    t.release();
    await waitFor(() => t.ctx.tasks.get(t.goal.id)!.status === 'ready');
    // Let the scheduler tick a few times: nothing may be created or started while paused.
    await new Promise((r) => setTimeout(r, 800));
    t.core.orchestrator.kick();
    await new Promise((r) => setTimeout(r, 400));
    expect(t.ctx.tasks.list({ parentId: t.goal.id }).map((c) => c.title)).toEqual(['Finished work']);
    expect(t.ctx.tasks.get(t.waiting().id)!.status).toBe('ready');
    expect(workRuns(t.provider)).toHaveLength(0);
    expect(t.core.orchestrator.state()).toMatchObject({ paused: true, activeRuns: 0 });
    // The finding is recorded, and the objective says why it went back.
    expect(t.ctx.tasks.evidence(t.goal.id).some((e) => e.kind === 'test_result' && e.passed === false)).toBe(true);
    // Resuming picks everything up again (the suite passes this time).
    t.set(passing);
    t.core.orchestrator.resume();
    await waitFor(() => t.ctx.tasks.get(t.goal.id)!.status === 'done');
    await waitFor(() => t.ctx.tasks.get(t.waiting().id)!.status === 'done');
  }, 60000);

  it('abandons the suite when the user stops, and the suite runs again on resume', async () => {
    const t = await setup();
    t.core.orchestrator.resume();
    await waitFor(() => t.entered());
    t.addWaiting();
    await t.core.orchestrator.stop();
    expect(t.signal()?.aborted).toBe(true);
    await waitFor(() => t.ctx.tasks.get(t.goal.id)!.status === 'ready');
    await new Promise((r) => setTimeout(r, 800));
    expect(t.ctx.tasks.list({ parentId: t.goal.id }).map((c) => c.title)).toEqual(['Finished work']);
    // Partial results from a stopped suite are not evidence of anything.
    expect(t.ctx.tasks.evidence(t.goal.id).some((e) => e.kind === 'test_result')).toBe(false);
    expect(t.ctx.tasks.get(t.waiting().id)!.status).toBe('ready');
    expect(workRuns(t.provider)).toHaveLength(0);
    t.set(passing);
    t.release();
    t.core.orchestrator.resume();
    await waitFor(() => t.ctx.tasks.get(t.goal.id)!.status === 'done');
  }, 60000);

  it('does not let a failing suite that finished before the pause be acted on once paused later in the same tick', async () => {
    // The pause lands after the suite returned but before the scheduler picks tasks: nothing starts.
    const t = await setup();
    t.set(passing);
    t.core.orchestrator.resume();
    await waitFor(() => t.entered());
    t.addWaiting();
    t.core.orchestrator.pause();
    t.release();
    await waitFor(() => t.ctx.tasks.get(t.goal.id)!.status === 'done');
    await new Promise((r) => setTimeout(r, 800));
    expect(t.ctx.tasks.get(t.waiting().id)!.status).toBe('ready');
    expect(workRuns(t.provider)).toHaveLength(0);
  }, 60000);
});
