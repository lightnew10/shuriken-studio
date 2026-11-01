import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationMethod } from '../src/shared/domain';
import { LINE_ORDER, PlaytestLease } from '../src/core/roblox/playtest-lease';
import { REPLAY_NOTE, playtestTurnMs } from '../src/core/capabilities/app-tools';
import { REHEARSAL_REUSE, VERIFY_CLOCK, checkTurnMs } from '../src/core/verification/verifier';
import { DEFAULT_APP_PREFS } from '../src/core/app-prefs';
import { coreHarness } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * 1.13.8: play windows dropped, Studio plays one game at a time, made faster. In the two 14-hour builds playtest calls
 * averaged 108-113 s and check runs 175-268 s, nearly all of it in Studio's line: short ones behind long ones, an
 * environment artist's one-second screenshot behind whole check runs (90 s on average), and a third of all playtests
 * played the same game again right after the same agent's previous one.
 */
const saved = { order: { ...LINE_ORDER }, reuse: { ...REHEARSAL_REUSE }, clock: { ...VERIFY_CLOCK }, replay: { ...REPLAY_NOTE } };
afterEach(() => {
  Object.assign(LINE_ORDER, saved.order);
  Object.assign(REHEARSAL_REUSE, saved.reuse);
  Object.assign(VERIFY_CLOCK, saved.clock);
  Object.assign(REPLAY_NOTE, saved.replay);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the line for Studio goes shortest first (pure)', () => {
  it('serves the shortest turn first, the earlier of equal ones, and a long one that has waited long enough before them', async () => {
    const lease = new PlaytestLease();
    lease.tryAcquire('run_playing');
    lease.want('run_big', 240_000);
    await sleep(5);
    lease.want('run_quick', 12_000);
    await sleep(5);
    lease.want('run_also_quick', 12_000);
    lease.want('run_unknown');
    expect(lease.next()).toBe('run_quick');
    lease.release('run_playing');
    expect(lease.tryAcquire('run_big')).toBe(false);
    expect(lease.tryAcquire('run_also_quick')).toBe(false);
    expect(lease.tryAcquire('run_quick')).toBe(true);
    lease.unwant('run_quick');
    lease.release('run_quick');
    // Of two equal ones, the one that came first; a turn of unknown length counts as LINE_ORDER.unknownMs.
    expect(lease.next()).toBe('run_also_quick');
    lease.unwant('run_also_quick');
    expect(lease.next()).toBe('run_unknown');
    // Waited LINE_ORDER.agingMs: goes before anything shorter that came later.
    LINE_ORDER.agingMs = 0;
    lease.want('run_tiny', 1000);
    expect(lease.next()).toBe('run_big');
    expect(lease.isNext('run_big')).toBe(true);
  });

  it('a check run, which finishes a task, ages after a minute instead of three', async () => {
    const lease = new PlaytestLease();
    lease.tryAcquire('run_playing');
    lease.want('verifier:t1', 90_000);
    await sleep(5);
    lease.want('run_quick', 8000);
    expect(lease.next()).toBe('run_quick');
    LINE_ORDER.checkAgingMs = 0;
    expect(lease.next()).toBe('verifier:t1');
    // A playtest that has waited its own (longer) aging still goes first among the aged: it came earlier.
    LINE_ORDER.checkAgingMs = 60_000;
    LINE_ORDER.agingMs = 0;
    lease.want('run_old', 5000);
    expect(lease.next()).toBe('run_quick');
    expect(saved.order.checkAgingMs).toBe(60_000);
  });

  it('of those that have waited their aging, a check run goes first, however long the playtests have waited', async () => {
    const lease = new PlaytestLease();
    lease.tryAcquire('run_playing');
    lease.want('run_waited_long', 5000);
    lease.want('run_waited_too', 5000);
    await sleep(5);
    lease.want('verifier:t2', 120_000);
    await sleep(5);
    lease.want('verifier:t3', 30_000);
    LINE_ORDER.agingMs = 0;
    LINE_ORDER.checkAgingMs = 0;
    expect(lease.next()).toBe('verifier:t2');
    lease.unwant('verifier:t2');
    expect(lease.next()).toBe('verifier:t3');
    lease.unwant('verifier:t3');
    expect(lease.next()).toBe('run_waited_long');
  });

  it('a screenshot still goes ahead of every playtest', () => {
    const lease = new PlaytestLease();
    lease.want('run_quick', 5000);
    lease.want('shot:run_artist');
    expect(lease.tryAcquire('run_quick')).toBe(false);
    expect(lease.tryAcquire('shot:run_artist')).toBe(true);
  });

  it('estimates how long a playtest call and a check hold Studio', () => {
    expect(playtestTurnMs({ action: 'run' })).toBe(8000);
    expect(playtestTurnMs({ action: 'run', seconds: 1, luau: 'x', steps: [{ keys: [{ action: 'keyPress' }, { action: 'wait', wait_time_ms: 250 }] }, { wait: 0.4 }, { client_luau: 'y' }, { screenshot: true }] })).toBe(5000 + 1000 + 1000 + 50 + 250 + 400 + 1000 + 2000);
    expect(playtestTurnMs({ action: 'start' })).toBe(90_000);
    expect(checkTurnMs({ kind: 'playtest', name: 'p', durationSec: 10, failOnConsoleErrors: false })).toBe(18_000);
    expect(checkTurnMs({ kind: 'luau_assert', name: 'a', luau: 'x', datamodel: 'server' })).toBe(12_000);
    expect(checkTurnMs({ kind: 'luau_assert', name: 'a', luau: 'x' })).toBe(2000);
  });
});

describe('a long turn lets screenshots in (pure)', () => {
  it('hands Studio to the screenshots that wait, keeps every playtest out meanwhile, and takes it back first', async () => {
    const lease = new PlaytestLease();
    expect(lease.tryAcquire('verifier:t1')).toBe(true);
    // Nothing waits: nothing is handed over.
    expect(await lease.yieldToShots('verifier:t1')).toBe(true);
    expect(lease.holder?.owner).toBe('verifier:t1');
    // A playtest and two screenshots wait.
    lease.want('run_next', 5000);
    const order: string[] = [];
    const shot = async (name: string) => {
      expect(await lease.acquire(name, 5000)).toBe(true);
      order.push(name);
      await sleep(30);
      lease.release(name);
    };
    const shots = Promise.all([shot('shot:run_a'), shot('shot:run_b')]);
    await sleep(10);
    const back = lease.yieldToShots('verifier:t1');
    // The waiting playtest may not slip in while the screenshots draw.
    const sneaked = (async () => {
      for (let i = 0; i < 20; i++) {
        if (lease.tryAcquire('run_next')) return true;
        await sleep(5);
      }
      return false;
    })();
    expect(await back).toBe(true);
    await shots;
    expect(order.sort()).toEqual(['shot:run_a', 'shot:run_b']);
    expect(await sneaked).toBe(false);
    expect(lease.holder?.owner).toBe('verifier:t1');
    lease.release('verifier:t1');
    expect(lease.tryAcquire('run_next')).toBe(true);
  });
});

describe('verification with one Studio', () => {
  const makeCore = coreHarness();
  const MAP = { 'src/Server': 'ServerScriptService/Server' };
  const play = (name: string): VerificationMethod => ({ kind: 'playtest', name, durationSec: 2, luau: "return 'PASS'", failOnConsoleErrors: false });
  beforeEach(() => void (VERIFY_CLOCK.secondMs = 20));

  async function setup(verification: VerificationMethod[]) {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    h.ctx.updateExtras({ syncMode: 'shuriken', syncMap: MAP });
    mkdirSync(join(h.root, 'src/Server'), { recursive: true });
    writeFileSync(join(h.root, 'src/Server/Round.server.luau'), 'print("round v1")\n', 'utf8');
    const sim = attachSim(h.core);
    sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'PASS');
    const task = h.ctx.tasks.create({ kind: 'implement', title: 'Round loop', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification });
    const scope = ['src/Server/Round.server.luau'];
    const rehearse = () => h.core.verifier.rehearse(h.ctx, h.ctx.tasks.get(task.id)!, 'run_me', scope);
    return { ...h, sim, task, rehearse };
  }

  it('a screenshot that waits draws between two of a check run’s playtests, not after the whole run', async () => {
    const { core, rehearse, sim } = await setup([play('first'), play('second'), play('third')]);
    const events: string[] = [];
    const lease = core.lease;
    const realStarts = () => sim.starts;
    const run = rehearse();
    // Once the run holds Studio and has started its first playtest, a screenshot asks for its turn.
    for (let i = 0; i < 200 && realStarts() < 1; i++) await sleep(10);
    expect(lease.holder?.owner).toMatch(/^verifier:/);
    const shot = (async () => {
      expect(await lease.acquire('shot:run_artist', 10_000)).toBe(true);
      events.push(`shot after ${realStarts()} playtests`);
      lease.release('shot:run_artist');
    })();
    const report = await run;
    await shot;
    expect(report.passed, report.summary).toBe(true);
    expect(sim.starts).toBe(3);
    // It drew after the first playtest, not after the third.
    expect(events).toEqual(['shot after 1 playtests']);
  });

  it('a worker that runs its checks again with nothing changed gets its passes back, and they keep their age', async () => {
    const { rehearse, sim } = await setup([play('round_runs')]);
    expect((await rehearse()).passed).toBe(true);
    expect(sim.starts).toBe(1);
    const again = await rehearse();
    expect(again.passed).toBe(true);
    expect(sim.starts).toBe(1);
    expect(again.results.find((r) => r.name === 'round_runs')!.output).toMatch(/This check passed \d+ s ago when you ran these checks, and the task's files have not changed since: it was not played again\. Change something and run them again to play it again\./);
    // The pass is as old as when it was played: past the window it is played again.
    REHEARSAL_REUSE.maxAgeMs = 0;
    await sleep(5);
    expect((await rehearse()).passed).toBe(true);
    expect(sim.starts).toBe(2);
  });

  it('reuses a pass for ten minutes', () => {
    expect(saved.reuse.maxAgeMs).toBe(10 * 60_000);
  });
});

describe('a playtest of the same game right after the last one', () => {
  const makeCore = coreHarness();
  it('says that nothing changed and that the questions belong in one run; not after a change', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.setPlaying = async (start: boolean) => ({ mode: start ? 'play' : 'edit', availableDataModels: start ? ['Server', 'Client'] : ['Edit'] });
    studio.runLuau = async (code: string) => ({ ok: true, output: code.includes('GetLogHistory') ? JSON.stringify({ ok: true, errors: [] }) : 'ok', durationMs: 1 });
    const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
    const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');
    const play = () => core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0, luau: 'return 1' }, agent);
    expect(text(await play())).not.toMatch(/nothing in the place changed/);
    expect(text(await play())).toMatch(/Note: nothing in the place changed since your previous playtest \d+ s ago, so this played the same game again\. Ask a game everything you want to know in ONE run/);
    // A change in between (a sync): no note.
    core.bus.emit('roblox.changed', { reason: 'sync' });
    expect(text(await play())).not.toMatch(/nothing in the place changed/);
    // Another agent's first playtest: no note.
    expect(text(await core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0 }, { ...agent, runId: 'run_other' }))).not.toMatch(/nothing in the place changed/);
  });
});

describe('play windows are gone', () => {
  const makeCore = coreHarness();
  it('an old setting for them is forgotten, and the app has none', async () => {
    const { core } = await makeCore({ respond: async () => null });
    expect('playWindows' in DEFAULT_APP_PREFS).toBe(false);
    // As 1.13.3-1.13.7 stored it.
    const store = (core as unknown as { global: { run: (sql: string, args: unknown[]) => void } }).global;
    store.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app.prefs', ?, 'x')", [JSON.stringify({ playWindows: 3, polish: 'standard' })]);
    expect('playWindows' in core.prefs.get()).toBe(false);
    expect(core.prefs.get().polish).toBe('standard');
    expect('playWindows' in core).toBe(false);
  });
});

describe('a playtest driven by hand while Studio is busy', () => {
  const makeCore = coreHarness();
  it('is refused when two others use or wait for Studio, and allowed when it is quiet', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.setPlaying = async (start: boolean) => ({ mode: start ? 'play' : 'edit', availableDataModels: start ? ['Server', 'Client'] : ['Edit'] });
    const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'ui-engineer', providerId: null, allowedTools: null };
    const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');
    // Another agent plays, and a third waits for it.
    expect(core.lease.tryAcquire('run_other')).toBe(true);
    const waiter = core.lease.acquire('run_third', 2000);
    await sleep(30);
    const refused = await core.tools.invoke('roblox_playtest', { action: 'start' }, agent);
    expect(text(refused)).toMatch(/Not started: 2 others are using or waiting for Studio[\s\S]*ONE "run"/);
    core.lease.release('run_other');
    expect(await waiter).toBe(true);
    core.lease.release('run_third');
    // Quiet: it starts.
    const started = await core.tools.invoke('roblox_playtest', { action: 'start' }, agent);
    expect(text(started)).toMatch(/play mode is yours/);
  });
});
