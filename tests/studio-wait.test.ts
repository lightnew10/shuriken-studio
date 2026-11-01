import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { PLAYTEST_LIMITS, PlaytestLease } from '../src/core/roblox/playtest-lease';
import { requiredDataModel, RobloxStudioAdapter, STUDIO_WAIT } from '../src/core/roblox/studio-adapter';
import { detachStudioCaller, withStudioCaller, type StudioCaller } from '../src/core/roblox/studio-context';
import { coreHarness } from './helpers/make-core';

const ok = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });
const fail = (e: string): ExternalCallResult => ({ ok: false, content: [], error: e, durationMs: 1 });
const EDIT = 'Current Studio Mode: Edit\nAvailable DataModels: Edit\nFocused DataModel in the viewport: Edit';
const PLAYING = 'Current Studio Mode: Play\nAvailable DataModels: Client, Server\nFocused DataModel in the viewport: Client';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Studio whose DataModels follow its mode: Edit work is refused in play mode and the reverse, as Studio does. */
class ModalStudio extends RobloxStudioAdapter {
  mode: 'Edit' | 'Play' = 'Edit';
  /** Studio answers get_studio_state this many times as it was before the mode flips (a start in progress). */
  flipAfterStates: number | null = null;
  flipTo: 'Edit' | 'Play' = 'Play';
  sent: Array<{ tool: string; dm: unknown }> = [];
  /** Answers for execute_luau that aren't the mode's: the first n calls get this error. */
  failFirst: { n: number; error: string } | null = null;

  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }

  protected override async callOnce(tool: string, args: Record<string, unknown>): Promise<ExternalCallResult> {
    if (tool === 'get_studio_state') {
      const text = this.mode === 'Edit' ? EDIT : PLAYING;
      if (this.flipAfterStates !== null && --this.flipAfterStates < 0) {
        this.flipAfterStates = null;
        this.mode = this.flipTo;
      }
      return ok(text);
    }
    this.sent.push({ tool, dm: args.datamodel_type });
    if (this.failFirst && this.failFirst.n-- > 0) return fail(this.failFirst.error);
    const dm = args.datamodel_type;
    if (dm === 'Edit' && this.mode === 'Play') return fail('Edit datamodel is not available in Play mode');
    if ((dm === 'Server' || dm === 'Client') && this.mode === 'Edit') return fail(`${dm as string} datamodel is not available in Edit mode`);
    return ok('ran');
  }
}

const agent = (owner: string, extra: Partial<StudioCaller> = {}): StudioCaller => ({ owner, kind: 'agent', ...extra });
const edit = (studio: ModalStudio, who: StudioCaller) => withStudioCaller(who, () => studio.runLuau('return 1', 'Edit'));

const saved = { ...STUDIO_WAIT };
const savedLease = { ...PLAYTEST_LIMITS };
beforeEach(() => {
  Object.assign(STUDIO_WAIT, { maxMs: 3000, pollMs: 15, noteMs: 40, startMs: 300, transitionMs: 150 });
  Object.assign(PLAYTEST_LIMITS, { pollMs: 15 });
});
afterEach(() => {
  Object.assign(STUDIO_WAIT, saved);
  Object.assign(PLAYTEST_LIMITS, savedLease);
});

describe('which DataModel a Studio call needs', () => {
  it('reads it from the call, and knows the tools that only work in Edit', () => {
    expect(requiredDataModel('execute_luau', { datamodel_type: 'Server' })).toBe('Server');
    expect(requiredDataModel('search_game_tree', { datamodel_type: 'Edit' })).toBe('Edit');
    expect(requiredDataModel('multi_edit', {})).toBe('Edit');
    expect(requiredDataModel('screen_capture', {})).toBe('Edit');
    expect(requiredDataModel('get_studio_state', {})).toBeNull();
    expect(requiredDataModel('start_stop_play', { is_start: true })).toBeNull();
  });
});

describe("an Edit call while another agent's playtest holds Studio", () => {
  it('waits for the playtest to end, says what it waits for, then runs', async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_other');
    studio.mode = 'Play';
    const notes: string[] = [];
    const call = edit(studio, agent('run_me', { progress: (m) => notes.push(m) }));
    await sleep(150);
    // Nothing went to Studio while it was in someone else's playtest: no mode error for the agent to see.
    expect(studio.sent).toEqual([]);
    studio.mode = 'Edit';
    lease.release('run_other');
    const r = await call;
    expect(r).toMatchObject({ ok: true, output: 'ran' });
    expect(studio.sent).toEqual([{ tool: 'execute_luau', dm: 'Edit' }]);
    expect(notes[0]).toMatch(/^Waiting for Studio: another agent \(run_other\), in a playtest since \d\d:\d\d:\d\d \(/);
    expect(notes.length).toBeGreaterThan(1);
  });

  it('runs at once for the one that holds play mode, and for calls that belong to no tool call', async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_me');
    expect((await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Server'))).ok).toBe(false); // Edit mode: no playtest yet (see below)
    studio.mode = 'Play';
    expect((await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Server'))).ok).toBe(true);
    // Verification and the app's own views hold Studio on their own account: never held back.
    lease.release('run_me');
    lease.tryAcquire('verifier:t1');
    expect((await detachStudioCaller(() => studio.runLuau('return 1', 'Server'))).ok).toBe(true);
    expect((await studio.runLuau('return 1', 'Server')).ok).toBe(true);
  });

  it('fails only when the wait runs out, saying who holds Studio and since when', async () => {
    STUDIO_WAIT.maxMs = 250;
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('verifier:t7');
    studio.mode = 'Play';
    const t0 = Date.now();
    const r = await edit(studio, agent('run_me'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Studio is still held by Shuriken's verification, in a playtest since \d\d:\d\d:\d\d/);
    expect(r.output).toMatch(/waited .* for it to end/);
    expect(r.output).toMatch(/not a blocker/);
    expect(studio.sent).toEqual([]);
  });

  it('stops waiting when the call is cancelled', async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_other');
    studio.mode = 'Play';
    const ctrl = new AbortController();
    const call = edit(studio, agent('run_me', { signal: ctrl.signal }));
    await sleep(60);
    ctrl.abort();
    const r = await call;
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/cancelled/);
  });

  it('an agent whose client takes no progress notes waits less than the client sits through', async () => {
    // A tool call without a progress token is given up on by the client after about 5 minutes: the wait stays under that.
    STUDIO_WAIT.maxMs = 6 * 60 * 1000;
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_other');
    const ctx = agent('run_me');
    const limit = (studio as unknown as { waitLimit: (c: StudioCaller | null) => number }).waitLimit.bind(studio);
    expect(limit(ctx)).toBe(230_000);
    expect(limit({ ...ctx, progress: () => undefined })).toBe(6 * 60 * 1000);
    expect(limit({ ...ctx, kind: 'ui' })).toBe(6 * 60 * 1000);
  });
});

describe('Studio in play mode that no agent holds', () => {
  it('waits for a playtest started by hand to end (Studio is polled), then runs', async () => {
    const studio = new ModalStudio();
    studio.useLease(new PlaytestLease());
    studio.mode = 'Play';
    studio.flipAfterStates = 3;
    studio.flipTo = 'Edit';
    const notes: string[] = [];
    const r = await edit(studio, agent('run_me', { progress: (m) => notes.push(m) }));
    expect(r).toMatchObject({ ok: true, output: 'ran' });
    // The first ask met Studio's own mode error; the wait polled the mode and asked again.
    expect(studio.sent.map((s) => s.dm)).toEqual(['Edit', 'Edit']);
  });

  it('says so when it never ends', async () => {
    STUDIO_WAIT.maxMs = 200;
    const studio = new ModalStudio();
    studio.useLease(new PlaytestLease());
    studio.mode = 'Play';
    const r = await edit(studio, agent('run_me'));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Studio is in play mode and no agent holds it/);
  });

  it("doesn't make an agent wait for its own playtest: stop it first", async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_me');
    studio.mode = 'Play';
    const t0 = Date.now();
    const r = await edit(studio, agent('run_me'));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.output).toMatch(/your own playtest runs: stop it first \(roblox_playtest action "stop"\)/);
  });
});

describe('a Server or Client call before there is a playtest', () => {
  it("waits for the caller's own playtest to come up", async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_me');
    studio.flipAfterStates = 2;
    const r = await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Server'));
    expect(r).toMatchObject({ ok: true, output: 'ran' });
    expect(studio.sent.map((s) => s.dm)).toEqual(['Server', 'Server']);
  });

  it("doesn't wait for a playtest nobody is starting, and says what to do", async () => {
    const studio = new ModalStudio();
    studio.useLease(new PlaytestLease());
    const t0 = Date.now();
    const r = await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Client'));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Studio is in Edit mode: the Client DataModel only exists during a playtest\. Start one with roblox_playtest/);
  });

  it("says a playtest that was stopped for others is gone", async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.reclaimed.set('run_me', Date.now());
    const r = await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Server'));
    expect(r.output).toMatch(/Your playtest was stopped \(it sat idle while they waited\), so Studio is back in Edit mode/);
    lease.reclaimed.set('run_me', Date.now());
    lease.reclaimReasons.set('run_me', 'crash');
    const crashed = await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Server'));
    expect(crashed.output).toMatch(/Studio closed under it and the place was reopened/);
  });

  it("doesn't ride on another agent's playtest", async () => {
    const lease = new PlaytestLease();
    const studio = new ModalStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_other');
    const r = await withStudioCaller(agent('run_me'), () => studio.runLuau('return 1', 'Server'));
    expect(r.output).toMatch(/belongs to another agent \(run_other\), in a playtest since/);
  });
});

describe('Studio switching modes', () => {
  it('asks again when the target is not reachable, for a while', async () => {
    const studio = new ModalStudio();
    studio.useLease(new PlaytestLease());
    studio.failFirst = { n: 2, error: 'Target is not reachable' };
    expect((await edit(studio, agent('run_me'))).ok).toBe(true);
    expect(studio.sent).toHaveLength(3);
    // Still unreachable after the transition window: the error comes back as it is.
    const stuck = new ModalStudio();
    stuck.useLease(new PlaytestLease());
    stuck.failFirst = { n: 1000, error: 'Target is not reachable' };
    const r = await edit(stuck, agent('run_me'));
    expect(r.ok).toBe(false);
    expect(r.output).toBe('Target is not reachable');
  });

  it('leaves other errors alone', async () => {
    const studio = new ModalStudio();
    studio.useLease(new PlaytestLease());
    studio.failFirst = { n: 1, error: 'attempt to index nil with Parent' };
    const r = await edit(studio, agent('run_me'));
    expect(r.output).toBe('attempt to index nil with Parent');
    expect(studio.sent).toHaveLength(1);
  });
});

describe('a Studio tool call through the tool registry', () => {
  const makeCore = coreHarness();
  const human = (runId: string) => ({ kind: 'agent' as const, runId, taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null });

  it('roblox_run_luau waits out another agent’s playtest, reports progress, then runs', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const sent: string[] = [];
    const studio = core.studio as unknown as { availability: () => unknown; callOnce: (tool: string, args: Record<string, unknown>) => Promise<ExternalCallResult> };
    studio.availability = () => ({ ok: true });
    studio.callOnce = async (tool, args) => {
      sent.push(`${tool}:${String(args.datamodel_type)}`);
      return ok('{"done":true}');
    };
    core.lease.tryAcquire('run_other');
    const notes: string[] = [];
    const call = core.tools.invoke('roblox_run_luau', { code: 'return "x"' }, human('run_me'), undefined, ({ message }) => message && notes.push(message));
    await sleep(150);
    expect(sent).toEqual([]);
    core.lease.release('run_other');
    const r = await call;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(sent).toEqual(['execute_luau:Edit']);
    expect(notes.some((n) => /Waiting for Studio: another agent \(run_other\)/.test(n))).toBe(true);
  });
});
