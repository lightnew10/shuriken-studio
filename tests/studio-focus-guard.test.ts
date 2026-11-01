import { describe, expect, it } from 'vitest';
import { FOCUS_GUARD, StudioFocusGuard } from '../src/core/roblox/studio-window';
import { LUAU_MOUSE_FREE_CLIENT } from '../src/core/roblox/luau-snippets';
import { coreHarness } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * Studio brings its own window to the front when play starts or stops. On 2026-10-26, with three builds open, six of
 * six starts and stops agents asked for in one project's Studio took the foreground from the user, who was playing
 * another project in their own Studio; a game that locks the mouse then pins the cursor to the middle of the screen.
 * An agent's start or stop arms the focus guard. No real window is touched here; the guard's give-back was checked
 * live on Windows (a stand-in window pulled to the front was handed back to the user's window in about 30 ms).
 */
const makeCore = coreHarness();

async function setup() {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const sim = attachSim(h.core);
  const armed: Array<{ needle: string; ms: number; mode: string }> = [];
  const played: Array<{ needle: string; on: boolean }> = [];
  const opened: Array<{ needle: string; ms: number }> = [];
  (h.core.studio as unknown as { windowNeedle: () => Promise<string | null> }).windowNeedle = async () => 'arena.rbxlx';
  h.core.studio.windows.guard = async (needle, ms) => {
    armed.push({ needle, ms, mode: sim.mode });
    return true;
  };
  h.core.studio.windows.play = async (needle, on) => {
    played.push({ needle, on });
    return true;
  };
  h.core.studio.windows.opening = async (needle, ms) => {
    opened.push({ needle, ms });
    return true;
  };
  return { ...h, sim, armed, played, opened };
}

describe("Studio's window taking the foreground as play starts or stops", () => {
  it("an agent's start and stop arm the guard before the request and for a moment after Studio answered", async () => {
    const { core, sim, armed } = await setup();
    expect(core.lease.tryAcquire('run_a')).toBe(true);
    await core.studio.setPlaying(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sim.mode).toBe('Play');
    expect(armed).toHaveLength(2);
    // Armed while Studio was still in Edit, for the whole start; then once more, for the moments after it.
    expect(armed[0]).toMatchObject({ needle: 'arena.rbxlx', mode: 'Edit' });
    expect(armed[0]!.ms).toBeGreaterThan(FOCUS_GUARD.settleMs);
    expect(armed[1]).toMatchObject({ ms: FOCUS_GUARD.settleMs, mode: 'Play' });
    await core.studio.setPlaying(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(armed.map((a) => a.mode)).toEqual(['Edit', 'Play', 'Play', 'Edit']);
  });

  it("the user's own playtest from the app is not guarded: Studio comes forward for them to play", async () => {
    const { core, sim, armed } = await setup();
    expect(core.lease.tryAcquire('ui:play')).toBe(true);
    await core.studio.setPlaying(true);
    expect(sim.mode).toBe('Play');
    expect(armed).toEqual([]);
  });

  it('a guard that cannot be armed changes nothing about the start', async () => {
    const { core, sim } = await setup();
    core.studio.windows.guard = async () => {
      throw new Error('no PowerShell');
    };
    expect(core.lease.tryAcquire('run_a')).toBe(true);
    await core.studio.setPlaying(true);
    expect(sim.mode).toBe('Play');
  });
});

describe('the focus guard', () => {
  it('starts nothing with Studio switched off (every test run): it would watch the Studio windows the user has open', async () => {
    const guard = new StudioFocusGuard();
    const t = Date.now();
    expect(await guard.arm('arena.rbxlx', 1000)).toBe(false);
    expect(Date.now() - t).toBeLessThan(100);
    guard.close();
  });
});

// 1.16.1: the user works at the same PC while builds run. An agent's playtest may not hold their mouse while they use
// another window, and stays silent while its Studio isn't in front (the guard's FreeStep and sound step, checked live
// with tests/e2e/studio-quiet.e2e.ts).
describe("an agent's playtest and the user's mouse and sound", () => {
  const said = (core: { studio: unknown }, what: string) => (core.studio as { focusGuardSaid: (w: string) => void }).focusGuardSaid(what);

  it("tells the guard when an agent's playtest is up and over, and sets up the mouse watch in its client", async () => {
    const { core, sim, played } = await setup();
    expect(core.lease.tryAcquire('run_a')).toBe(true);
    await core.studio.setPlaying(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(played).toEqual([{ needle: 'arena.rbxlx', on: true }]);
    expect(sim.luau('Client').some((c) => c.code === LUAU_MOUSE_FREE_CLIENT)).toBe(true);
    // The user moved to another window: the playtest is told to let go of the mouse, and when they come back, not to.
    said(core, 'FREE 1');
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.luau('Server').at(-1)?.code).toMatch(/SetAttribute\("ShurikenMouseFree", true\)/);
    said(core, 'FREE 0');
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.luau('Server').at(-1)?.code).toMatch(/SetAttribute\("ShurikenMouseFree", false\)/);
    await core.studio.setPlaying(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(played.at(-1)).toEqual({ needle: 'arena.rbxlx', on: false });
    // No playtest: nothing is sent.
    const before = sim.luau().length;
    said(core, 'FREE 1');
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.luau().length).toBe(before);
  });

  it("leaves the user's own playtest from the app alone", async () => {
    const { core, sim, played } = await setup();
    expect(core.lease.tryAcquire('ui:play')).toBe(true);
    await core.studio.setPlaying(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(played).toEqual([]);
    expect(sim.luau('Client').some((c) => c.code === LUAU_MOUSE_FREE_CLIENT)).toBe(false);
  });

  it('a reopen after a crash and a build’s own open come up behind; an open the user asked for does not', async () => {
    const { core, opened } = await setup();
    const studio = core.studio as unknown as { openPlaceOnce: () => Promise<unknown> };
    studio.openPlaceOnce = async () => ({ id: 's1', name: 'arena.rbxlx' });
    await core.studio.openPlace('C:\\games\\arena.rbxlx', 'arena', 60_000, { background: true });
    expect(opened).toEqual([{ needle: 'arena.rbxlx', ms: 60_000 }]);
    await core.studio.openPlace('C:\\games\\arena.rbxlx', 'arena');
    expect(opened).toHaveLength(1);
  });
});
