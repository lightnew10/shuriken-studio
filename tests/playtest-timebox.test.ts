import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { PLAYTEST_LIMITS, PlaytestLease, type LeaseExpiry } from '../src/core/roblox/playtest-lease';
import { ENFORCE, PLAY_START, RobloxStudioAdapter, STUDIO_WAIT } from '../src/core/roblox/studio-adapter';
import { withStudioCaller } from '../src/core/roblox/studio-context';
import { coreHarness } from './helpers/make-core';

const ok = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });
const fail = (e: string): ExternalCallResult => ({ ok: false, content: [], error: e, durationMs: 1 });
const EDIT = 'Current Studio Mode: Edit\nAvailable DataModels: Edit\nFocused DataModel in the viewport: Edit';
const PLAYING = 'Current Studio Mode: Play\nAvailable DataModels: Client, Server\nFocused DataModel in the viewport: Client';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Studio that really stops when asked to: Edit work is refused in play mode, start_stop_play flips the mode. `hang`
 * makes it never answer a start or a stop (a Studio that hung, as on 2026-10-06).
 */
class PlayableStudio extends RobloxStudioAdapter {
  mode: 'Edit' | 'Play' = 'Edit';
  stops = 0;
  hang: { start?: boolean; stop?: boolean } = {};

  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }

  protected override async callOnce(tool: string, args: Record<string, unknown>): Promise<ExternalCallResult> {
    if (tool === 'get_studio_state') return ok(this.mode === 'Edit' ? EDIT : PLAYING);
    if (tool === 'start_stop_play') {
      if ((args.is_start && this.hang.start) || (args.is_start === false && this.hang.stop)) return new Promise<ExternalCallResult>(() => undefined);
      if (args.is_start === false) this.stops++;
      this.mode = args.is_start ? 'Play' : 'Edit';
      return ok(args.is_start ? 'Game Started' : 'Game Stopped');
    }
    if (args.datamodel_type === 'Edit' && this.mode === 'Play') return fail('Edit datamodel is not available in Play mode');
    return ok('ran');
  }
}

const savedLimits = { ...PLAYTEST_LIMITS };
const savedWait = { ...STUDIO_WAIT };
const savedEnforce = { ...ENFORCE };
const savedStart = { ...PLAY_START };
beforeEach(() => {
  Object.assign(PLAYTEST_LIMITS, { playMs: 150, loadMs: 150, maxHoldMs: 150, idleMs: 60, pollMs: 15 });
  Object.assign(STUDIO_WAIT, { maxMs: 4000, pollMs: 15, noteMs: 40 });
});
afterEach(() => {
  Object.assign(PLAYTEST_LIMITS, savedLimits);
  Object.assign(STUDIO_WAIT, savedWait);
  Object.assign(ENFORCE, savedEnforce);
  Object.assign(PLAY_START, savedStart);
});

/** Back-dates the holder's last Studio call. */
const quietFor = (lease: PlaytestLease, ms: number) => ((lease as unknown as { lastActive: number }).lastActive = Date.now() - ms);
const editCall = (studio: PlayableStudio, owner: string) => withStudioCaller({ owner, kind: 'agent' }, () => studio.runLuau('return 1', 'Edit'));

describe('the play cap', () => {
  it("gives an agent's playtest 60 s once it is up, counts no loading, and is never extended", () => {
    Object.assign(PLAYTEST_LIMITS, { playMs: 60_000, loadMs: 5 * 60_000 });
    const lease = new PlaytestLease();
    expect(lease.overdue()).toBeNull();
    expect(lease.tryAcquire('run_a')).toBe(true);
    const since = lease.holder!.since;
    // Loading: only the load allowance applies.
    expect(lease.expiresAt()).toBe(since + 5 * 60_000);
    expect(lease.overdue(since + 4 * 60_000)).toBeNull();
    expect(lease.overdue(since + 5 * 60_000)).toBe('long');
    expect(lease.describe()).toMatch(/its playtest still loading/);
    // Up after 2 minutes of loading: 60 s from there.
    lease.markPlaying('run_b', since + 1000); // not the holder: no effect
    expect(lease.expiresAt()).toBe(since + 5 * 60_000);
    lease.markPlaying('run_a', since + 120_000);
    expect(lease.expiresAt()).toBe(since + 180_000);
    expect(lease.overdue(since + 179_000)).toBeNull();
    expect(lease.overdue(since + 180_000)).toBe('long');
    // Asking again for what it holds doesn't start the clock over.
    expect(lease.tryAcquire('run_a')).toBe(true);
    expect(lease.holder!.since).toBe(since);
    expect(lease.expiresAt()).toBe(since + 180_000);
    expect(lease.extend('run_b', 'because I want to').ok).toBe(false); // not the holder
    const asked = lease.extend('run_a', 'the boss fight still has to play out');
    expect(asked.ok).toBe(false);
    expect(asked.message).toMatch(/not extended: one plays 60 s once it is up \(loading is not counted\)/);
    // The next holder starts with a fresh box, loading again.
    lease.release('run_a');
    lease.tryAcquire('run_c');
    expect(lease.expiresAt()).toBe(lease.holder!.since + 5 * 60_000);
    expect(lease.playingSince).toBe(0);
  });

  it("an agent's playtest that went quiet gives way sooner, but only while someone waits and once it is up", () => {
    Object.assign(PLAYTEST_LIMITS, { playMs: 60_000, loadMs: 5 * 60_000, idleMs: 45_000 });
    const lease = new PlaytestLease();
    lease.tryAcquire('run_a');
    quietFor(lease, 50_000);
    // Still loading: a slow load isn't idleness.
    expect(lease.overdue(Date.now(), true)).toBeNull();
    lease.markPlaying('run_a');
    quietFor(lease, 50_000);
    expect(lease.overdue(Date.now(), false)).toBeNull();
    expect(lease.overdue(Date.now(), true)).toBe('idle');
    lease.touch('run_a');
    expect(lease.overdue(Date.now(), true)).toBeNull();
    // A user's or a system owner's turn isn't an agent's: only its time box applies.
    lease.release('run_a');
    lease.tryAcquire('ui:user');
    quietFor(lease, 50_000);
    expect(lease.overdue(Date.now(), true)).toBeNull();
  });

  it("Shuriken's own checks keep Studio as long as they take, up to the ceiling; others have their time box and shields", () => {
    Object.assign(PLAYTEST_LIMITS, { maxHoldMs: 3 * 60_000, ceilingMs: 15 * 60_000 });
    const lease = new PlaytestLease();
    lease.tryAcquire('verifier:task1');
    const since = lease.holder!.since;
    expect(lease.expiresAt()).toBe(since + 15 * 60_000);
    expect(lease.overdue(since + 14 * 60_000, true)).toBeNull();
    expect(lease.overdue(since + 15 * 60_000, true)).toBe('long');
    expect(lease.extend('verifier:task1', '').ok).toBe(true);
    lease.release('verifier:task1');
    // The user's playtest from the app: three minutes, longer while a slow load shields it, never past the ceiling.
    lease.tryAcquire('ui:user');
    const u = lease.holder!.since;
    expect(lease.expiresAt()).toBe(u + 3 * 60_000);
    lease.shield('ui:user', 5 * 60_000);
    expect(lease.expiresAt()!).toBeGreaterThan(u + 3 * 60_000);
    lease.shield('ui:user', 60 * 60_000);
    expect(lease.expiresAt()).toBe(u + 15 * 60_000);
  });

  // 2026-10-07: a rebuild from 35 build scripts took 13 minutes; it was cut at 3 and agents playtested a half-built map.
  it("the world's rebuild and a reopening of the place keep Studio until they are done, up to a limit of their own", () => {
    Object.assign(PLAYTEST_LIMITS, { maxHoldMs: 3 * 60_000, ceilingMs: 15 * 60_000, healMs: 30 * 60_000 });
    const lease = new PlaytestLease();
    for (const owner of ['healer', 'refresh']) {
      expect(lease.tryAcquire(owner)).toBe(true);
      const since = lease.holder!.since;
      expect(lease.expiresAt()).toBe(since + 30 * 60_000);
      // With agents waiting, 13 minutes in and past the verification's ceiling: not cut.
      expect(lease.overdue(since + 13 * 60_000, true)).toBeNull();
      expect(lease.overdue(since + 20 * 60_000, true)).toBeNull();
      // A rebuild that is stuck still ends.
      expect(lease.overdue(since + 30 * 60_000, true)).toBe('long');
      expect(lease.describe()).toMatch(/holding Studio since .*stopped at \d\d:\d\d:\d\d at the latest/);
      lease.release(owner);
    }
    // A save keeps the usual box.
    lease.tryAcquire('saver');
    expect(lease.expiresAt()).toBe(lease.holder!.since + 3 * 60_000);
  });

  it('is taken from whoever holds it when Studio crashes or the user frees it, and the agent is told why', () => {
    const lease = new PlaytestLease();
    expect(lease.forfeit('crash')).toBeNull();
    lease.tryAcquire('run_a');
    expect(lease.forfeit('crash')).toBe('run_a');
    expect(lease.holder).toBeNull();
    expect(lease.reclaimReasons.get('run_a')).toBe('crash');
    lease.tryAcquire('verifier:t1');
    expect(lease.forfeit('freed')).toBe('verifier:t1');
    expect(lease.holder).toBeNull();
    expect(lease.reclaimed.has('verifier:t1')).toBe(false);
  });
});

describe('a playtest past its time box', () => {
  it('is stopped by the Edit work waiting behind it, which then runs', async () => {
    PLAYTEST_LIMITS.idleMs = 60_000; // only the time box applies here
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    const reclaimed: Array<{ owner: string; reason: LeaseExpiry }> = [];
    studio.useLease(lease, (r) => reclaimed.push(r));
    lease.tryAcquire('run_other');
    lease.markPlaying('run_other');
    studio.mode = 'Play';
    const t0 = Date.now();
    const r = await editCall(studio, 'run_me');
    expect(r).toMatchObject({ ok: true, output: 'ran' });
    // Played its 150 ms, then stopped: well before the 4 s the waiter would have waited.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(studio.stops).toBe(1);
    expect(studio.mode).toBe('Edit');
    expect(lease.holder).toBeNull();
    expect(lease.reclaimed.has('run_other')).toBe(true);
    expect(lease.reclaimReasons.get('run_other')).toBe('long');
    expect(reclaimed).toEqual([{ owner: 'run_other', reason: 'long' }]);
  });

  it('counts its 60 s from the moment Studio has it up, not from when it took Studio', async () => {
    PLAYTEST_LIMITS.idleMs = 60_000;
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_other');
    // A start that took Studio 120 ms (here) to bring up: setPlaying marks the playtest up when it is.
    await sleep(120);
    await studio.setPlaying(true);
    expect(lease.playingSince).toBeGreaterThanOrEqual(lease.holder!.since + 100);
    expect(lease.expiresAt()).toBe(lease.playingSince + 150);
  });

  it("stops an agent's idle playtest as soon as someone waits, long before its box ends", async () => {
    PLAYTEST_LIMITS.playMs = 60_000;
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_idle');
    lease.markPlaying('run_idle');
    quietFor(lease, 500);
    studio.mode = 'Play';
    // Nobody waits: it is left alone.
    expect(await studio.enforceLease()).toBeNull();
    expect(lease.holder?.owner).toBe('run_idle');
    const t0 = Date.now();
    const r = await editCall(studio, 'run_me');
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(lease.reclaimReasons.get('run_idle')).toBe('idle');
  });

  it("leaves a verification alone, so the waiter runs out of patience instead and is told who holds Studio", async () => {
    STUDIO_WAIT.maxMs = 400;
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('verifier:t1');
    studio.mode = 'Play';
    const r = await editCall(studio, 'run_me');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Studio is still held by Shuriken's verification/);
    expect(studio.stops).toBe(0);
    expect(lease.holder?.owner).toBe('verifier:t1');
  });

  it("an agent's Edit work waits behind the world's rebuild past the usual box and runs once it is done; a stuck rebuild still ends", async () => {
    PLAYTEST_LIMITS.healMs = 60_000;
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('healer');
    let done = false;
    const call = editCall(studio, 'run_me').then((r) => {
      done = true;
      return r;
    });
    // Well past maxHoldMs (150 ms here), with someone waiting: the rebuild keeps Studio.
    await sleep(500);
    expect(await studio.enforceLease({ waiting: true })).toBeNull();
    expect(done).toBe(false);
    expect(lease.holder?.owner).toBe('healer');
    expect(studio.stops).toBe(0);
    lease.release('healer');
    expect(await call).toMatchObject({ ok: true, output: 'ran' });

    // Stuck: its own limit ends it, and the waiting work runs.
    PLAYTEST_LIMITS.healMs = 300;
    lease.tryAcquire('healer');
    const t0 = Date.now();
    expect(await editCall(studio, 'run_me')).toMatchObject({ ok: true, output: 'ran' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(lease.holder).toBeNull();
  });

  it('is stopped once even when several wait', async () => {
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_other');
    lease.markPlaying('run_other');
    studio.mode = 'Play';
    const calls = await Promise.all([editCall(studio, 'run_a'), editCall(studio, 'run_b'), editCall(studio, 'run_c')]);
    expect(calls.every((c) => c.ok)).toBe(true);
    expect(studio.stops).toBe(1);
  });

  it('gives Studio to the others when the stop is never answered, and stops the next one past its time all the same', async () => {
    PLAYTEST_LIMITS.idleMs = 60_000;
    ENFORCE.stopMs = 200;
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_stuck');
    lease.markPlaying('run_stuck');
    studio.mode = 'Play';
    studio.hang.stop = true;
    await sleep(170);
    const t0 = Date.now();
    const first = await studio.enforceLease();
    expect(first).toEqual({ owner: 'run_stuck', reason: 'long' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(lease.holder).toBeNull();
    // The enforcer is free again: the next playtest past its time is stopped too (it used to wait forever on the first).
    studio.hang.stop = false;
    studio.resetPlayLine(); // the hung stop's turn ends
    lease.tryAcquire('run_next');
    lease.markPlaying('run_next');
    await sleep(170);
    expect(await studio.enforceLease()).toEqual({ owner: 'run_next', reason: 'long' });
  });

  it('a start whose Studio hung holds no stop behind it once Studio went, and its own call ends', async () => {
    Object.assign(PLAY_START, { minMs: 5000, maxMs: 5000 });
    const lease = new PlaytestLease();
    const studio = new PlayableStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_a');
    studio.hang.start = true;
    const start = studio.setPlaying(true).then(
      () => 'up',
      (e: Error) => e.message,
    );
    await sleep(50);
    // Studio went (StudioRecovery reopened the place): the line is reset.
    studio.hang.start = false;
    studio.resetPlayLine();
    expect(await start).toMatch(/Studio went \(or was freed\)/);
    const t0 = Date.now();
    await studio.setPlaying(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Edit work is no longer kept out by the start that never ended.
    expect(lease.beginEdit('run_b')).toBe(false); // run_a still holds Studio here (the recovery forfeits it)
    lease.forfeit('crash');
    expect(lease.beginEdit('run_b')).toBe(true);
    lease.endEdit();
  });

  it('a start or stop never takes longer than its turn, even when Studio never answers', async () => {
    Object.assign(PLAY_START, { minMs: 50, maxMs: 50 });
    Object.assign(ENFORCE, { requestMs: 50, settleMs: 50 });
    const studio = new PlayableStudio();
    studio.useLease(new PlaytestLease());
    studio.hang.start = true;
    const t0 = Date.now();
    await expect(studio.setPlaying(true)).rejects.toThrow(/Studio did not bring the playtest up within/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('roblox_playtest and the time box', () => {
  const makeCore = coreHarness();
  const agent = (runId: string) => ({ kind: 'agent' as const, runId, taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null });
  const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');

  it('"extend" says there is no extension, to the caller’s own playtest', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    (core.studio as unknown as { availability: () => unknown }).availability = () => ({ ok: true });
    core.lease.tryAcquire('run_me');
    const none = await core.tools.invoke('roblox_playtest', { action: 'extend', reason: 'one more round of the match' }, agent('run_other'));
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/not yours/);
    const asked = await core.tools.invoke('roblox_playtest', { action: 'extend', reason: 'one more round of the match' }, agent('run_me'));
    expect(asked.isError).toBe(true);
    expect(text(asked)).toMatch(/Playtests are not extended/);
  });

  it('tells an agent whose playtest ran past its box, crashed or was freed why it is gone', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    (core.studio as unknown as { availability: () => unknown }).availability = () => ({ ok: true });
    const said = async (reason: LeaseExpiry) => {
      core.lease.reclaimed.set('run_me', Date.now());
      core.lease.reclaimReasons.set('run_me', reason);
      return text(await core.tools.invoke('roblox_playtest', { action: 'stop' }, agent('run_me')));
    };
    expect(await said('long')).toMatch(/it ran past its time box \(every playtest \(a "run" too\) plays at most 60 s once it is up/);
    expect(core.lease.reclaimed.has('run_me')).toBe(false);
    expect(await said('crash')).toMatch(/Roblox Studio closed under it/);
    expect(await said('freed')).toMatch(/the user freed Studio/);
  });

  it('lets go of a leaked playtest when its run ends, even when Studio never answers the stop', async () => {
    ENFORCE.stopMs = 100;
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const stops: boolean[] = [];
    (core.studio as unknown as { setPlaying: (s: boolean) => Promise<unknown> }).setPlaying = (s) => {
      stops.push(s);
      return new Promise(() => undefined);
    };
    core.lease.tryAcquire('run_gone');
    core.bus.emit('run.updated', { id: 'run_gone', status: 'interrupted' } as never);
    for (let i = 0; i < 50 && core.lease.holder; i++) await sleep(20);
    expect(core.lease.holder).toBeNull();
    expect(stops).toEqual([false]);
  });

  it('the user (or the director for them) frees Studio from a playtest that is stuck', async () => {
    ENFORCE.freeMs = 50;
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    (core.studio as unknown as { setPlaying: () => Promise<unknown> }).setPlaying = () => new Promise(() => undefined);
    expect(await core.freeStudio('user')).toMatch(/already free/);
    core.lease.tryAcquire('run_stuck');
    expect(core.studioHolder()).toMatchObject({ owner: 'run_stuck' });
    const said = await core.freeStudio('director');
    expect(said).toMatch(/^Freed Studio from another agent \(run_stuck\)/);
    expect(core.lease.holder).toBeNull();
    expect(core.lease.reclaimReasons.get('run_stuck')).toBe('freed');
    expect(core.studioHolder()).toBeNull();
  });
});
