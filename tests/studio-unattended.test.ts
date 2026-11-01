import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { PlaceGuard } from '../src/core/roblox/place-guard';
import { PlaytestLease } from '../src/core/roblox/playtest-lease';
import { RobloxStudioAdapter, ScreenshotUnavailableError, SHOT_RETRY } from '../src/core/roblox/studio-adapter';
import { AUDIO_HELPER_SOURCE, findStudioWindow, IdleTracker, titleKey, UNATTENDED, WIN_HELPER_SOURCE, type RaisedWindow, type SavePlaceResult, type UserActivity } from '../src/core/roblox/studio-window';
import { withStudioCaller } from '../src/core/roblox/studio-context';
import { coreHarness } from './helpers/make-core';
import { fakePicture } from './helpers/studio-sim';

/**
 * Nobody at the PC: in the user's overnight build 25 of 137 screenshots failed because Studio wasn't drawing
 * (covered by another window, or the display asleep) and Ctrl+S saves failed for hours. When the user has been
 * idle for a few minutes Shuriken may put Studio's window on top for a capture, and in the foreground for a save,
 * and puts things back. When someone is there it never touches their focus. No real window is touched here.
 */
const picture = (): ExternalCallResult => ({ ok: true, content: [{ type: 'image', data: fakePicture(), mimeType: 'image/jpeg' }], durationMs: 1 });
const timeout = (): ExternalCallResult => ({ ok: false, content: [], error: 'screen_capture timed out', durationMs: 1 });
const MIN = 60_000;

/** A Studio whose window the adapter may handle, with every window call recorded instead of made. */
class WindowedStudio extends RobloxStudioAdapter {
  seen: string[] = [];
  activity: UserActivity | null = { idleMs: 0, foreground: 'chrome' };
  answers: ExternalCallResult[] = [picture()];
  raisable = true;

  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
    this.windows = {
      idle: new IdleTracker(async () => this.activity),
      raise: async (needle, wake) => {
        this.seen.push(`raise ${needle}${wake ? ' +wake' : ''}`);
        return this.raisable ? ({ hwnd: '100', above: '200', wasMinimized: false } satisfies RaisedWindow) : null;
      },
      lower: async (r) => {
        this.seen.push(`lower ${r.hwnd} under ${r.above}`);
      },
      unminimize: async (needle) => {
        this.seen.push(`unminimize ${needle}`);
        return 'visible';
      },
      guard: async (needle) => {
        this.seen.push(`guard ${needle}`);
        return true;
      },
      play: async (needle, on) => {
        this.seen.push(`play ${needle} ${on ? 'on' : 'off'}`);
        return true;
      },
      opening: async (needle) => {
        this.seen.push(`opening ${needle}`);
        return true;
      },
    };
  }

  protected override async windowNeedle(): Promise<string | null> {
    return 'arena.rbxlx';
  }

  protected override async callOnce(tool: string): Promise<ExternalCallResult> {
    this.seen.push(tool);
    return this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
  }
}

const saved = { shot: { ...SHOT_RETRY }, un: { ...UNATTENDED } };
beforeEach(() => {
  Object.assign(SHOT_RETRY, { delayMs: 5, timeoutMs: 50, firstTimeoutMs: 50, pauseMs: 60_000, quickTimeoutMs: 50, raisedMs: 1, wokenMs: 1, restoredMs: 1 });
  Object.assign(UNATTENDED, { idleMs: 3 * MIN, cacheMs: 0 });
});
afterEach(() => {
  Object.assign(SHOT_RETRY, saved.shot);
  Object.assign(UNATTENDED, saved.un);
});

describe('a capture, with someone at the PC and with nobody there', () => {
  it("never moves Studio's window over the user's while they are active: a minimized one is only restored behind them", async () => {
    const studio = new WindowedStudio();
    for (const activity of [{ idleMs: 4000, foreground: 'chrome' }, { idleMs: 3 * MIN - 1, foreground: 'Code' }, null]) {
      studio.seen = [];
      studio.activity = activity;
      expect(await studio.screenshot()).toMatchObject({ mimeType: 'image/jpeg' });
      expect(studio.seen).toEqual(['unminimize arena.rbxlx', 'screen_capture']);
    }
  });

  it('with nobody there for a few minutes, puts Studio on top for the capture (no focus taken) and back afterwards', async () => {
    const studio = new WindowedStudio();
    studio.activity = { idleMs: 3 * MIN, foreground: 'chrome' };
    expect(await studio.screenshot()).not.toBeNull();
    expect(studio.seen).toEqual(['raise arena.rbxlx', 'screen_capture', 'lower 100 under 200']);
  });

  it('wakes a sleeping display for it only when "Keep the screen on" is set, and its own wake is not the user coming back', async () => {
    const studio = new WindowedStudio();
    studio.activity = { idleMs: 40 * MIN, foreground: 'explorer' };
    studio.keepScreenOn = () => true;
    await studio.screenshot();
    expect(studio.seen).toEqual(['raise arena.rbxlx +wake', 'screen_capture', 'lower 100 under 200']);
    // Windows now says the last input was a moment ago: it was the wake. The next capture is still unattended.
    studio.seen = [];
    studio.activity = { idleMs: 30, foreground: 'explorer' };
    await studio.screenshot();
    expect(studio.seen[0]).toBe('raise arena.rbxlx +wake');
    // The user really comes back (input long after the wake): hands off again.
    await new Promise((r) => setTimeout(r, 30));
    (studio.windows.idle as unknown as { own: { at: number } }).own.at -= 10_000;
    studio.seen = [];
    studio.activity = { idleMs: 500, foreground: 'chrome' };
    await studio.screenshot();
    expect(studio.seen).toEqual(['unminimize arena.rbxlx', 'screen_capture']);
  });

  it('puts the window back when the capture fails too, and the failure stays the environment condition it is', async () => {
    const studio = new WindowedStudio();
    studio.activity = { idleMs: 10 * MIN, foreground: 'chrome' };
    studio.answers = [timeout()];
    await expect(studio.screenshot()).rejects.toBeInstanceOf(ScreenshotUnavailableError);
    expect(studio.seen).toEqual(['raise arena.rbxlx', 'screen_capture', 'lower 100 under 200', 'raise arena.rbxlx', 'screen_capture', 'lower 100 under 200']);
    // No Studio window to raise: nothing to put back either.
    const none = new WindowedStudio();
    none.activity = { idleMs: 10 * MIN, foreground: 'chrome' };
    none.raisable = false;
    await none.screenshot();
    expect(none.seen).toEqual(['raise arena.rbxlx', 'screen_capture']);
  });

  // Three simultaneous builds: one project's window never drew for hours, three captures asked together each waited
  // out both timeouts, and a window restored from minimized was captured before it had drawn.
  it('captures one at a time, so the ones behind a timeout answer at once, and says what it found at the window', async () => {
    const studio = new WindowedStudio();
    studio.activity = { idleMs: 2000, foreground: 'chrome' };
    studio.answers = [timeout()];
    const all = await Promise.all([1, 2, 3].map(() => studio.screenshot().catch((e: Error) => e.message)));
    expect(studio.seen.filter((s) => s === 'screen_capture')).toHaveLength(2);
    expect(all[0]).toMatch(/timed out on both tries \(someone is at the PC, so the window was left where it is\)/);
    expect(all[1]).toMatch(/failed a moment ago, so no new one was tried/);
    expect(all[2]).toMatch(/failed a moment ago, so no new one was tried/);
    // No window with the place's title: the message names what was looked for.
    const none = new WindowedStudio();
    none.windows.unminimize = async () => 'nowindow';
    none.answers = [timeout()];
    expect(await none.screenshot().catch((e: Error) => e.message)).toMatch(/no Studio window titled "arena\.rbxlx" was found/);
  });

  // The user's 12-agent build, twice in its first half hour: an agent's screenshot waited for a verification's
  // playtest to end while it held the captures' line, the verification's own picture stood behind it, and both
  // (with ten other Studio calls) waited out the six-minute limit.
  it("a capture that waits for a playtest to end doesn't hold up the pictures taken in that playtest", async () => {
    const lease = new PlaytestLease();
    const studio = new WindowedStudio();
    studio.useLease(lease);
    lease.tryAcquire('verifier:t1');
    const agents = ['run_a', 'run_b'].map((owner) => withStudioCaller({ owner, kind: 'agent' }, () => studio.screenshot()));
    await new Promise((r) => setTimeout(r, 40));
    expect(studio.seen).not.toContain('screen_capture');
    // The verification's picture of its own playtest (it belongs to no tool call), and the playtest's agent's.
    const t0 = Date.now();
    expect(await studio.screenshot({ quick: true })).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    // A playtest's own agent takes its picture at once too (it holds Studio; Studio answers what it answers).
    lease.release('verifier:t1');
    expect(await Promise.all(agents)).toHaveLength(2);
    expect(studio.seen.filter((s) => s === 'screen_capture')).toHaveLength(3);
    expect(lease.holder).toBeNull();
  });

  // A screenshot of the Edit scene takes a turn in Studio's line and holds Edit mode while it draws (it used to
  // race the next playtest's start: 22 s each on average, 72 minutes of a 12-agent build). It goes ahead of the
  // playtests that wait: a second of drawing stood 159 to 209 s behind five queued playtests on 1.13.1.
  it('a screenshot waits for the playtest that runs, then draws ahead of the playtests that wait, holding Edit mode', async () => {
    const lease = new PlaytestLease();
    const studio = new WindowedStudio();
    studio.useLease(lease);
    lease.tryAcquire('run_playing');
    // What Studio saw, in order: a capture when a screenshot's turn came, a mark when the later playtest got play mode.
    const order = () => studio.seen.filter((x) => x === 'screen_capture' || x === 'run_later plays');
    const shot = (owner: string) => withStudioCaller({ owner, kind: 'agent' }, () => studio.screenshot());
    const a = shot('run_a');
    await new Promise((r) => setTimeout(r, 20));
    // A playtest asked for after the first screenshot, and a second screenshot asked for after that playtest.
    const play = lease.acquire('run_later', 5000).then((ok) => {
      studio.seen.push('run_later plays');
      return ok;
    });
    await new Promise((r) => setTimeout(r, 20));
    const b = shot('run_b');
    await new Promise((r) => setTimeout(r, 20));
    expect(order()).toEqual([]);
    lease.release('run_playing');
    await a;
    await b;
    expect(await play).toBe(true);
    // Both pictures were drawn before the waiting playtest got Studio, and never during a playtest.
    expect(order()).toEqual(['screen_capture', 'screen_capture', 'run_later plays']);
    lease.release('run_later');
    expect(lease.holder).toBeNull();
    // Several pictures inside one turn stand in line once.
    const many = await withStudioCaller({ owner: 'run_c', kind: 'agent' }, () => studio.inEditTurn(async () => [await studio.screenshot(), await studio.screenshot(), lease.holder?.owner]));
    expect(many[2]).toBe('shot:run_c');
    expect(lease.holder).toBeNull();
  });

  it("behind a capture whose first try timed out, the others wait for its second try instead of timing out themselves", async () => {
    const studio = new WindowedStudio();
    studio.answers = [timeout(), picture()];
    const all = await Promise.all([1, 2, 3].map(() => studio.screenshot().then((p) => (p ? 'picture' : 'none'), (e: Error) => e.message)));
    // One timeout (the display was asleep), then three pictures: nobody was told Studio isn't drawing.
    expect(all).toEqual(['picture', 'picture', 'picture']);
    expect(studio.seen.filter((s) => s === 'screen_capture')).toHaveLength(4);
  });

  // Two builds side by side: each project window has its own tracker. One window's display wake, its Ctrl+S save
  // and the keys it sent into a playtest read as "someone is at the PC" to the other for three minutes, which then
  // left its Studio window covered by the other project's: captures timed out after 25-41 s, inside playtests.
  it("another Shuriken window's own input is not the user coming back", async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'shuriken-idle-')), 'own-input.json');
    IdleTracker.shared = file;
    try {
      let idle = 10 * MIN;
      const a = new IdleTracker(async () => ({ idleMs: idle, foreground: 'RobloxStudioBeta' }));
      const b = new IdleTracker(async () => ({ idleMs: idle, foreground: 'RobloxStudioBeta' }));
      expect(await b.unattended()).toBe(true);
      // Window A sends keys into its playtest: Windows now says the last input was a moment ago.
      await a.ownInput(async () => {
        idle = 0;
      });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ idleBefore: 10 * MIN });
      idle = 40;
      expect(await a.unattended()).toBe(true);
      // Window B reads the same clock and knows whose input it was.
      const seen = await b.activity();
      expect(seen!.idleMs).toBeGreaterThanOrEqual(10 * MIN);
      expect(await b.unattended()).toBe(true);
      // The user really comes back (input long after Shuriken's): everyone keeps their hands off.
      writeFileSync(file, JSON.stringify({ at: Date.now() - 60_000, idleBefore: 10 * MIN }));
      const c = new IdleTracker(async () => ({ idleMs: 500, foreground: 'chrome' }));
      expect(await c.unattended()).toBe(false);
    } finally {
      IdleTracker.shared = null;
    }
  });

  // A two-build night: one project's captures timed out for over an hour. Every two minutes one took 25 s, 3 s
  // and 15 s inside Studio's line, which twelve agents waited behind (13 of 15 playtests gave up in ten minutes).
  it('a Studio that stays that way is asked less and less: one short try after each pause, and the pause grows', async () => {
    const studio = new WindowedStudio();
    Object.assign(SHOT_RETRY, { pauseMs: 60_000, pauseMaxMs: 5 * MIN });
    const inner = studio as unknown as { shotsPausedUntil: number };
    const captures = () => studio.seen.filter((s) => s === 'screen_capture').length;
    const pause = () => Math.round((inner.shotsPausedUntil - Date.now()) / 1000);
    const pauseEnds = () => (inner.shotsPausedUntil = Date.now() - 1);
    studio.answers = [timeout()];
    await expect(studio.screenshot()).rejects.toThrow(/timed out on both tries/);
    expect([captures(), pause()]).toEqual([2, 60]);
    // Meanwhile nothing is tried, and whoever would wait for Studio first can ask.
    expect(studio.capturePause()?.message).toMatch(/failed a moment ago, so no new one was tried/);
    // After the pause: one try, and twice the pause; then up to the limit.
    for (const [n, seconds] of [[3, 120], [4, 240], [5, 300], [6, 300]] as const) {
      pauseEnds();
      expect(studio.capturePause()).toBeNull();
      await expect(studio.screenshot()).rejects.toThrow(/its screen capture timed out again \(someone is at the PC/);
      expect([captures(), pause()]).toEqual([n, seconds]);
    }
    // A picture ends it: the next timeout is a first one again (two tries, the short pause).
    pauseEnds();
    studio.answers = [picture()];
    expect(await studio.screenshot()).not.toBeNull();
    studio.answers = [timeout()];
    await expect(studio.screenshot()).rejects.toThrow(/timed out on both tries/);
    expect([captures(), pause()]).toEqual([9, 60]);
    // And a timeout long ago says nothing about now: both tries again.
    inner.shotsPausedUntil = Date.now() - 6 * MIN;
    await expect(studio.screenshot()).rejects.toThrow(/timed out on both tries/);
    expect([captures(), pause()]).toEqual([11, 60]);
  });

  it("a screenshot that would not be tried doesn't stand in Studio's line first", async () => {
    const lease = new PlaytestLease();
    const studio = new WindowedStudio();
    studio.useLease(lease);
    studio.answers = [timeout()];
    await expect(studio.screenshot()).rejects.toBeInstanceOf(ScreenshotUnavailableError);
    lease.tryAcquire('run_playing');
    const t0 = Date.now();
    const told = await withStudioCaller({ owner: 'run_a', kind: 'agent' }, () => studio.screenshot()).catch((e: Error) => e.message);
    expect(told).toMatch(/failed a moment ago, so no new one was tried/);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(lease.holder?.owner).toBe('run_playing');
  });

  // Measured in a scratch place (capture-focus.e2e.ts): a capture in flight when its playtest stops is answered
  // "Target is closed", and that Studio answers no capture after it until the place is opened again. One project of
  // a two-build night had no picture for hours.
  it("a playtest's start or stop never meets a capture: each waits for the other", async () => {
    class Slow extends WindowedStudio {
      protected override async callOnce(tool: string): Promise<ExternalCallResult> {
        this.seen.push(`${tool} begins`);
        await new Promise((r) => setTimeout(r, 60));
        this.seen.push(`${tool} ends`);
        return tool === 'screen_capture' ? picture() : { ok: true, content: [{ type: 'text', text: '{}' }], durationMs: 1 };
      }
    }
    const studio = new Slow();
    const order = () => studio.seen.filter((x) => /^(screen_capture|start_stop_play) /.test(x));
    const shot = studio.screenshot();
    await new Promise((r) => setTimeout(r, 25));
    await Promise.all([shot, studio.setPlaying(false)]);
    expect(order()).toEqual(['screen_capture begins', 'screen_capture ends', 'start_stop_play begins', 'start_stop_play ends']);
    studio.seen = [];
    const stop = studio.setPlaying(false);
    await new Promise((r) => setTimeout(r, 25));
    await Promise.all([stop, studio.screenshot()]);
    expect(order()).toEqual(['start_stop_play begins', 'start_stop_play ends', 'screen_capture begins', 'screen_capture ends']);
  });

  it('a capture whose playtest stopped under it leaves Studio answering none: said as it is, and whoever can reopen the place is told', async () => {
    const studio = new WindowedStudio();
    const inner = studio as unknown as { shotsPausedUntil: number };
    const captures = () => studio.seen.filter((x) => x === 'screen_capture').length;
    let told = 0;
    studio.onCaptureDead = () => told++;
    studio.answers = [{ ok: false, content: [], error: 'Target is closed (HOST_INVOKE_ScreenCaptureTool_CaptureScreen_ToRequester, Client)', durationMs: 1 }, timeout()];
    const first = await studio.screenshot().catch((e: Error) => e);
    expect(first).toBeInstanceOf(ScreenshotUnavailableError);
    expect((first as Error).message).toMatch(/Studio's screen capture stopped answering at .+ no capture is answered after that until the place is closed and opened again/);
    expect((first as Error).message).toMatch(/not a failure of the work/);
    expect([captures(), told]).toEqual([1, 1]);
    expect(studio.capturesDeadSince).not.toBeNull();
    // None is tried for the long pause, and everyone is told why at once.
    expect(Math.round((inner.shotsPausedUntil - Date.now()) / MIN)).toBe(5);
    expect(await studio.screenshot().catch((e: Error) => e.message)).toMatch(/stopped answering/);
    expect(captures()).toBe(1);
    // A look after the pause: one short try; still dead, and said again to whoever reopens the place.
    inner.shotsPausedUntil = Date.now() - 1;
    expect(await studio.screenshot().catch((e: Error) => e.message)).toMatch(/stopped answering/);
    expect([captures(), told]).toEqual([2, 2]);
    // The place was opened again: pictures as usual.
    studio.capturesBack();
    studio.answers = [picture()];
    expect(await studio.screenshot()).not.toBeNull();
    expect(studio.capturesDeadSince).toBeNull();
  });

  it('three rounds of captures that only time out are taken for the same thing', async () => {
    const studio = new WindowedStudio();
    const inner = studio as unknown as { shotsPausedUntil: number };
    let told = 0;
    studio.onCaptureDead = () => told++;
    studio.answers = [timeout()];
    for (const expected of [0, 0, 1, 2]) {
      inner.shotsPausedUntil = Date.now() - 1;
      await expect(studio.screenshot()).rejects.toThrow(/timed out/);
      expect(told).toBe(expected);
    }
    expect(studio.captureFailRounds).toBe(4);
    expect(studio.capturesDeadSince).toBeNull();
  });

  it('gives a window it just restored time to draw before the capture', async () => {
    const studio = new WindowedStudio();
    studio.windows.unminimize = async () => 'restored';
    SHOT_RETRY.restoredMs = 80;
    const t0 = Date.now();
    await studio.screenshot();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
    studio.windows.unminimize = async () => 'visible';
    const t1 = Date.now();
    await studio.screenshot();
    expect(Date.now() - t1).toBeLessThan(60);
  });

  it('touches no window at all without a real Studio (tests, other platforms)', async () => {
    class Plain extends RobloxStudioAdapter {
      touched = 0;
      constructor() {
        super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
        const count = async () => {
          this.touched++;
          return null as never;
        };
        this.windows = { idle: new IdleTracker(count), raise: count, lower: count, unminimize: count, guard: count, play: count, opening: count };
      }
      protected override async callOnce(): Promise<ExternalCallResult> {
        return picture();
      }
    }
    const studio = new Plain();
    await studio.screenshot();
    expect(studio.touched).toBe(0);
  });
});

describe('telling whether anybody is at the PC', () => {
  it('asks Windows at most once in a while, and says "someone may be there" when it cannot tell', async () => {
    UNATTENDED.cacheMs = 10_000;
    let reads = 0;
    let answer: UserActivity | null = { idleMs: 5 * MIN, foreground: 'chrome' };
    const idle = new IdleTracker(async () => {
      reads++;
      return answer;
    });
    expect(await idle.unattended()).toBe(true);
    expect(await idle.unattended()).toBe(true);
    expect(reads).toBe(1);
    UNATTENDED.cacheMs = 0;
    answer = null;
    expect(await idle.unattended()).toBe(false);
    answer = { idleMs: 2 * MIN, foreground: 'chrome' };
    expect(await idle.unattended()).toBe(false);
    const broken = new IdleTracker(async () => {
      throw new Error('no PowerShell');
    });
    expect(await broken.unattended()).toBe(false);
  });
});

describe('saving the place, with someone at the PC and with nobody there', () => {
  const makeCore = coreHarness();

  async function guard(activity: () => UserActivity | null) {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    writeFileSync(join(ctx.root, 'arena.rbxlx'), '<roblox/>');
    ctx.updateExtras({ placeFile: 'arena.rbxlx' });
    const saves: boolean[] = [];
    const state = { answer: { ok: true, message: 'Saved arena.rbxlx.' } as SavePlaceResult };
    const g = new PlaceGuard({
      project: () => ctx,
      studio: { connected: true, binding: 'arena.rbxlx' } as never,
      lease: new PlaytestLease(),
      bus: core.bus,
      log: core.log,
      autoSave: () => true,
      pushCode: async () => undefined,
      hold: () => undefined,
      autoSavesDir: mkdtempSync(join(tmpdir(), 'shuriken-autosaves-')),
      save: async (_file, unattended) => {
        saves.push(unattended);
        return state.answer;
      },
      activity: async () => activity(),
    });
    return { g, saves, state };
  }

  it("waits while the user works in another app, and saves without the foreground tricks while they are in Studio or Shuriken", async () => {
    let act: UserActivity | null = { idleMs: 2000, foreground: 'chrome' };
    const { g, saves } = await guard(() => act);
    expect((await g.saveNow('periodic')).message).toMatch(/Waiting: saving would pull Studio in front of the app you are using/);
    expect(saves).toEqual([]);
    act = { idleMs: 2000, foreground: 'RobloxStudioBeta' };
    expect((await g.saveNow('periodic')).ok).toBe(true);
    // Away for a minute, not yet "nobody there": a plain save, as before.
    act = { idleMs: 90_000, foreground: 'chrome' };
    expect((await g.saveNow('periodic')).ok).toBe(true);
    expect(saves).toEqual([false, false]);
  });

  it('with nobody there for a few minutes, saves the unattended way (Studio to the foreground, then the window in front put back)', async () => {
    const { g, saves } = await guard(() => ({ idleMs: 6 * MIN, foreground: 'chrome' }));
    expect((await g.saveNow('checkpoint')).ok).toBe(true);
    expect(saves).toEqual([true]);
  });

  // The user came back and played the game in Studio: the periodic save pressed Ctrl+S into their playtest (keys
  // into the game, nothing saved) and reported "Could not save the place".
  it("presses no keys into a playtest the user started: the save waits for Edit mode", async () => {
    const { g, saves } = await guard(() => ({ idleMs: 2000, foreground: 'RobloxStudioBeta' }));
    const studio = (g as unknown as { d: { studio: Record<string, unknown> } }).d.studio;
    studio.state = async () => ({ mode: 'Play', availableDataModels: ['Edit', 'Server', 'Client'], focused: 'Client', raw: '' });
    expect((await g.saveNow('periodic')).message).toMatch(/^Waiting: Studio is in a playtest that is not the team's; the save waits until it is back in Edit mode\.$/);
    expect((await g.saveNow('user', true)).message).toBe('Studio is in a playtest: stop it in Studio, then save.');
    expect(saves).toEqual([]);
    studio.state = async () => ({ mode: 'Edit', availableDataModels: ['Edit'], focused: 'Edit', raw: '' });
    expect((await g.saveNow('periodic')).ok).toBe(true);
    expect(saves).toEqual([false]);
  });

  it('a refusal met while the user was there does not hold back the first unattended try', async () => {
    let act: UserActivity = { idleMs: 90_000, foreground: 'chrome' };
    const { g, saves, state } = await guard(() => act);
    state.answer = { ok: false, focus: true, message: 'Windows did not bring the Studio window to the front, so no keys were sent.' };
    expect((await g.saveNow('periodic')).focus).toBe(true);
    expect((await g.saveNow('periodic')).message).toMatch(/Waiting: Windows wouldn't bring Studio to the front a moment ago/);
    expect(saves).toEqual([false]);
    act = { idleMs: 5 * MIN, foreground: 'chrome' };
    state.answer = { ok: true, message: 'Saved arena.rbxlx.' };
    expect((await g.saveNow('periodic')).ok).toBe(true);
    expect(saves).toEqual([false, true]);
    // Refused even unattended: then it does wait.
    state.answer = { ok: false, focus: true, message: 'Windows did not bring the Studio window to the front, so no keys were sent.' };
    expect((await g.saveNow('periodic')).focus).toBe(true);
    expect((await g.saveNow('periodic')).message).toMatch(/Waiting/);
    expect(saves).toEqual([false, true, true]);
  });
});

describe("finding the place's Studio window", () => {
  it('compares letters and digits when the punctuation differs, and takes the only Studio window there is', () => {
    expect(titleKey("BuilderFan's Place: 10012026_4")).toBe('builderfansplace100120264');
    const script = findStudioWindow("BuilderFan's Place: 10012026_4");
    expect(script).toContain("-like '*BuilderFan''s Place: 10012026_4 - Roblox Studio'");
    expect(script).toContain(".Contains('builderfansplace100120264')");
    expect(script).toContain('if (-not $p -and $all.Count -eq 1) { $p = $all[0] }');
    // A name with nothing to compare (two characters) is only matched exactly, or as the only window.
    expect(findStudioWindow('ab')).not.toContain('.Contains(');
  });

  it.skipIf(process.platform !== 'win32')('runs in PowerShell and picks the right title out of several (no window is touched)', () => {
    // The same search over made-up processes: the place's own punctuation, a different one, and no match among two.
    const pick = (titles: string[], needle: string) => {
      const fake = `function Get-Process { ${titles.map((t) => `[pscustomobject]@{ MainWindowTitle = '${t.replace(/'/g, "''")}' }`).join('; ')} }`;
      const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${fake}\n${findStudioWindow(needle)}\nif ($p) { Write-Output "FOUND $($p.MainWindowTitle)" } else { Write-Output 'NONE' }`], { encoding: 'utf8', windowsHide: true });
      expect(r.stderr.trim()).toBe('');
      return r.stdout.trim();
    };
    const needle = "BuilderFan's Place: 10012026_4";
    expect(pick(['arena.rbxlx - Roblox Studio', `${needle} - Roblox Studio`], needle)).toBe(`FOUND ${needle} - Roblox Studio`);
    expect(pick(['arena.rbxlx - Roblox Studio', 'BuilderFans Place - 10012026 4 - Roblox Studio'], needle)).toBe('FOUND BuilderFans Place - 10012026 4 - Roblox Studio');
    expect(pick(['arena.rbxlx - Roblox Studio', 'city.rbxlx - Roblox Studio'], needle)).toBe('NONE');
    expect(pick(['Place1 - Roblox Studio'], needle)).toBe('FOUND Place1 - Roblox Studio');
  }, 90_000);
});

describe('the window helper', () => {
  it.skipIf(process.platform !== 'win32')('compiles, and its read-only calls answer (nothing is moved, raised or activated)', () => {
    const script = `${WIN_HELPER_SOURCE}\nWrite-Output "FG $([ShurikenWin]::Foreground()) $([ShurikenWin]::ForegroundPid())"\nWrite-Output "DIALOGS[$([ShurikenWin]::Dialogs(0, 0))]"\nWrite-Output "FRONT $([ShurikenWin]::Front(0))"\nWrite-Output "GUARD[$([ShurikenWin]::GuardStep(0, $true))]"`;
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
    expect(r.stderr.trim()).toBe('');
    expect(r.stdout).toMatch(/FG -?\d+ \d+/);
    expect(r.stdout).toContain('DIALOGS[]');
    // A window that doesn't exist is not brought anywhere.
    expect(r.stdout).toContain('FRONT False');
    // The focus guard with no Studio window only follows the window in front.
    expect(r.stdout).toContain('GUARD[]');
  }, 60_000);

  // 1.16.1: an agent's playtest and the user's mouse and sound; a Studio opened in the background.
  it.skipIf(process.platform !== 'win32')('its playtest and open steps answer, and the sound helper compiles (nothing is muted with no playtest)', () => {
    const script = `${WIN_HELPER_SOURCE}
${AUDIO_HELPER_SOURCE()}
Write-Output "FREE[$([ShurikenWin]::FreeStep(0, 180000))]"
Write-Output "MUTE $([ShurikenWin]::WantMute(0))"
Write-Output "OPEN[$([ShurikenWin]::OpenStep())]"
Write-Output "BUTTON $([ShurikenWin]::AnyButtonDown())"
Write-Output "AUDIO $([ShurikenAudio]::SetMute(0, $false)) $([ShurikenAudio]::SetMute($PID, $false))"`;
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
    expect(r.stderr.trim()).toBe('');
    // No agent playtest: the mouse is the game's ("FREE 0", said once), nothing is muted, no open is watched.
    expect(r.stdout).toContain('FREE[FREE 0]');
    expect(r.stdout).toContain('MUTE False');
    expect(r.stdout).toContain('OPEN[]');
    expect(r.stdout).toMatch(/BUTTON (True|False)/);
    // A process with no sound session (this PowerShell) has nothing to mute.
    expect(r.stdout).toContain('AUDIO 0 0');
  }, 60_000);
});
