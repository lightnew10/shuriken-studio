import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '../src/core/core';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { ChatService } from '../src/core/director/chat-service';
import { STUDIO_WAIT } from '../src/core/roblox/studio-adapter';
import { STUDIO_RECOVERY, STUDIO_REFRESH, StudioRecovery } from '../src/core/roblox/studio-recovery';
import type { SavePlaceResult, UserActivity } from '../src/core/roblox/studio-window';
import { VERIFY_CLOCK } from '../src/core/verification/verifier';
import { coreHarness, waitFor } from './helpers/make-core';
import type { StudioProcess } from '../src/core/roblox/studio-login-lock';
import { attachSim, type StudioSim } from './helpers/studio-sim';

/**
 * Studio crashed at 01:34 in the user's overnight build: agents asked "may I relaunch it?", the director said yes,
 * an agent relaunched it, and one verification failed against a Studio that was gone. The app reopens the place
 * itself now; nothing here touches a real Studio or a real process list.
 */
const makeCore = coreHarness();
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };

const saved = { rec: { ...STUDIO_RECOVERY }, wait: { ...STUDIO_WAIT }, clock: { ...VERIFY_CLOCK }, refresh: { ...STUDIO_REFRESH } };
beforeEach(() => {
  Object.assign(STUDIO_RECOVERY, { everyMs: 60_000, tries: 3, openMs: 200, retryMs: 10, maxLaunches: 6, windowMs: 60_000 });
  Object.assign(STUDIO_WAIT, { maxMs: 4000, pollMs: 15, noteMs: 40 });
  Object.assign(VERIFY_CLOCK, { secondMs: 5, studioBackMs: 4000 });
});
afterEach(() => {
  Object.assign(STUDIO_RECOVERY, saved.rec);
  Object.assign(STUDIO_WAIT, saved.wait);
  Object.assign(VERIFY_CLOCK, saved.clock);
  Object.assign(STUDIO_REFRESH, saved.refresh);
});

interface World {
  sim: StudioSim;
  /** What Windows says about the place's Studio window. */
  window: 'open' | 'starting' | 'none' | 'unknown';
  working: boolean;
  /** How opening the place goes: how long it takes, and whether Studio comes up. */
  opening: { ms: number; fails: number };
  opened: number;
  checked: number;
  /** What each check after a reopen was told (a crash, or a window that turned into another place). */
  how: unknown[];
  /** A refresh: what the user is doing, how the save goes, and what was done to the place's window, in order. */
  activity: UserActivity | null;
  save: SavePlaceResult;
  did: string[];
}

async function setup() {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const sim = attachSim(h.core);
  writeFileSync(join(h.root, 'place.rbxlx'), '<roblox/>', 'utf8');
  h.ctx.updateExtras({ placeFile: 'place.rbxlx' });
  h.ctx.updateSettings({ robloxStudioMatch: 'place.rbxlx' });
  // Bound without the binding event: that would run the core's Studio health check, which connects to the real Studio MCP.
  (h.core.studio as unknown as { studioMatch: string }).studioMatch = 'place.rbxlx';
  const w: World = { sim, window: 'open', working: true, opening: { ms: 60, fails: 0 }, opened: 0, checked: 0, how: [], activity: { idleMs: 10 * 60_000, foreground: 'RobloxStudioBeta' }, save: { ok: true, message: 'Saved place.rbxlx.' }, did: [] };
  (h.core.studio as unknown as { listStudios: () => Promise<Array<{ id: string; name: string }>> }).listStudios = async () => (sim.gone ? [] : [{ id: 's1', name: 'place.rbxlx' }]);
  const recovery = new StudioRecovery({
    project: () => h.core.project,
    studio: h.core.studio,
    bus: h.core.bus,
    log: h.core.logger.scope('test'),
    working: () => w.working,
    reopened: async (_ctx, how) => {
      w.checked++;
      w.how.push(how);
      return { rebuilt: false, codePushed: true };
    },
    windowState: async () => w.window,
    lease: h.core.lease,
    activity: async () => w.activity,
    save: async () => {
      w.did.push(`save (held by ${h.core.lease.holder?.owner})`);
      return w.save;
    },
    close: async (name) => {
      w.did.push(`close ${name}`);
      sim.gone = true;
      w.window = 'none';
      return 'closed';
    },
    open: async (file) => {
      w.opened++;
      w.did.push('open');
      await sleep(w.opening.ms);
      if (w.opening.fails-- > 0) throw new Error('Studio did not report an instance matching "place.rbxlx" within 0 s.');
      sim.gone = false;
      w.window = 'open';
      return { name: file.replace(/^.*[\\/]/, '') };
    },
  });
  recovery.start();
  const crash = () => {
    sim.gone = true;
    w.window = 'none';
  };
  const chat = () => new ChatService(h.ctx, h.core.bus).list().map((m) => `${m.kind}: ${m.text}`);
  return { ...h, sim, w, recovery, crash, chat };
}

const stop = (core: Core) => core.placeGuard.stop();

describe('Studio closed while a project is being worked on', () => {
  it('leaves a Studio that is there alone, and one that is only slow to connect or was closed while nobody works', async () => {
    const { recovery, sim, w, chat } = await setup();
    expect(await recovery.check()).toBe(true);
    // Not in MCP's list, but Windows shows its window (its MCP server is off) or a Studio that is still loading.
    sim.gone = true;
    w.window = 'open';
    expect(await recovery.check()).toBe(true);
    w.window = 'starting';
    expect(await recovery.check()).toBe(true);
    w.window = 'unknown';
    expect(await recovery.check()).toBe(false);
    // Gone, with nobody working: the user closed it.
    w.window = 'none';
    w.working = false;
    expect(await recovery.check()).toBe(false);
    expect(w.opened).toBe(0);
    expect(chat()).toEqual([]);
    recovery.stop();
  });

  it("takes a crash for one when Roblox's MCP connection went with the Studio (it was the only one)", async () => {
    const { recovery, crash, w, core } = await setup();
    Object.defineProperty(core.studio, 'connected', { configurable: true, get: () => false });
    const listed = core.studio.listStudios;
    (core.studio as unknown as { listStudios: () => Promise<never> }).listStudios = () => Promise.reject(new Error('MCP is not connected'));
    crash();
    try {
      expect(await recovery.check()).toBe(true);
      expect(w.opened).toBe(1);
      // Disconnected with the window still there: MCP's own trouble, nothing to reopen.
      w.window = 'open';
      expect(await recovery.check()).toBe(true);
      expect(w.opened).toBe(1);
    } finally {
      delete (core.studio as unknown as { connected?: boolean }).connected;
      (core.studio as unknown as { listStudios: typeof listed }).listStudios = listed;
      recovery.stop();
    }
  });

  it('reopens the place, binds to it, has the place checked, and says so in one status line', async () => {
    const { core, ctx, recovery, crash, w, chat } = await setup();
    w.opening.ms = 400;
    crash();
    const looking = recovery.check();
    await waitFor(() => core.studio.reopening, 3000);
    expect(core.studio.reopening).toMatchObject({ attempt: 1, tries: 3, place: 'place.rbxlx' });
    expect(chat()[0]).toMatch(/^status: Roblox Studio closed unexpectedly at \d\d:\d\d:\d\d\. Reopening place\.rbxlx \(try 1 of 3\); the agents' Studio work waits/);
    expect(await looking).toBe(true);
    expect(core.studio.reopening).toBeNull();
    expect(w.opened).toBe(1);
    expect(w.checked).toBe(1);
    expect(core.studio.binding).toBe('place.rbxlx');
    const lines = chat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^status: Roblox Studio closed unexpectedly at \d\d:\d\d:\d\d; I reopened place\.rbxlx, reconnected and checked the place\. The team carries on\.$/);
    const events = ctx.audit.timeline({ limit: 20 }).map((e) => e.kind);
    expect(events).toContain('studio.gone');
    expect(events).toContain('studio.reopened');
    recovery.stop();
  });

  it('ends a crashed Studio of the place that is still running without its window, and never one showing a place', async () => {
    const { core, ctx, recovery, crash, w } = await setup();
    const file = join(core.project!.root, 'place.rbxlx');
    const old = Date.now() - 3 * 60 * 60_000;
    const procs: StudioProcess[] = [
      // The crashed one: started with this place, its window gone, its memory still held.
      { pid: 101, startedAt: old, title: '', responding: false, commandLine: `"RobloxStudioBeta.exe" "${file}"` },
      // The user's Studio with another place: never touched.
      { pid: 102, startedAt: old, title: 'other.rbxlx - Roblox Studio', responding: true, commandLine: '"RobloxStudioBeta.exe" "C:\other.rbxlx"' },
      // Started with this place but now showing another one in the same window: never touched.
      { pid: 103, startedAt: old, title: 'sandbox.rbxlx - Roblox Studio', responding: true, commandLine: `"RobloxStudioBeta.exe" "${file}"` },
      // A moment old: it may be the one that is starting.
      { pid: 104, startedAt: Date.now() - 5_000, title: 'Roblox Studio', responding: true, commandLine: `"RobloxStudioBeta.exe" "${file}"` },
    ];
    const ended: number[] = [];
    (recovery as unknown as { d: { procs: () => Promise<StudioProcess[]>; endProc: (pid: number) => boolean } }).d.procs = async () => procs;
    (recovery as unknown as { d: { endProc: (pid: number) => boolean } }).d.endProc = (pid) => (ended.push(pid), true);
    crash();
    expect(await recovery.check()).toBe(true);
    expect(ended).toEqual([101]);
    expect(w.opened).toBe(1);
    expect(ctx.audit.timeline({ limit: 20 }).map((e) => e.kind)).toContain('studio.leftover');
    recovery.stop();
  });

  it('reopens the local file when its window now shows the published game, saying so instead of "closed unexpectedly", and leaves that window alone', async () => {
    const { core, ctx, recovery, crash, w, chat } = await setup();
    const file = join(core.project!.root, 'place.rbxlx');
    const procs: StudioProcess[] = [{ pid: 201, startedAt: Date.now() - 3 * 3600_000, title: 'Voxel Pit - Roblox Studio', responding: true, commandLine: `"RobloxStudioBeta.exe" "${file}"` }];
    const ended: number[] = [];
    (recovery as unknown as { d: { procs: () => Promise<StudioProcess[]> } }).d.procs = async () => procs;
    (recovery as unknown as { d: { endProc: (pid: number) => boolean } }).d.endProc = (pid) => (ended.push(pid), true);
    crash();
    expect(await recovery.check()).toBe(true);
    expect(w.opened).toBe(1);
    expect(ended).toEqual([]);
    const lines = chat();
    expect(lines).toHaveLength(1);
    // Not a crash: said so, and the check after it is told (it rebuilds nothing that is there).
    expect(lines[0]).toMatch(
      /^status: Studio's window of place\.rbxlx now shows "Voxel Pit" \(you published the place from it, or opened another place in it\)\. That is not a crash, so nothing was rebuilt: I reopened place\.rbxlx as it was last saved \(\d\d:\d\d:\d\d\) and put the code back from the files\. The team carries on on your local copy; the "Voxel Pit" window is no longer the team's, so close it when you're done with it\.$/,
    );
    expect(lines.join('\n')).not.toMatch(/closed unexpectedly/);
    expect(w.how).toEqual([{ crashed: false, moved: true, recovered: null }]);
    const kinds = ctx.audit.timeline({ limit: 20 }).map((e) => e.kind);
    expect(kinds).toContain('studio.place.left');
    expect(kinds).not.toContain('studio.gone');
    recovery.stop();
  });

  it('reopens the local file after a publish while nobody works (the team paused), and a Studio the user closed stays closed', async () => {
    const { core, recovery, crash, w } = await setup();
    const file = join(core.project!.root, 'place.rbxlx');
    w.working = false;
    // Closed by the user while nobody works: left closed.
    crash();
    expect(await recovery.check()).toBe(false);
    expect(w.opened).toBe(0);
    // Its window now shows the published game: reopened all the same.
    const procs: StudioProcess[] = [{ pid: 301, startedAt: Date.now() - 3600_000, title: 'Voxel Pit - Roblox Studio', responding: true, commandLine: `"RobloxStudioBeta.exe" "${file}"` }];
    (recovery as unknown as { d: { procs: () => Promise<StudioProcess[]> } }).d.procs = async () => procs;
    expect(await recovery.check()).toBe(true);
    expect(w.opened).toBe(1);
    recovery.stop();
  });

  it('after a publish it was told about (afterMove), it reopens the local file once Studio has settled, even with no process to show for it', async () => {
    const { recovery, crash, w, chat } = await setup();
    w.working = false;
    crash();
    recovery.afterMove('Voxel Pit');
    expect(recovery.moving).toBe(true);
    // Its own look is due LINK_GRACE_MS + 5 s later; any look before then reopens it too (the move was seen).
    expect(await recovery.check()).toBe(true);
    expect(w.opened).toBe(1);
    expect(w.how).toEqual([{ crashed: false, moved: true, recovered: null }]);
    expect(chat()[0]).toMatch(/^status: Studio's window of place\.rbxlx now shows "Voxel Pit" \(you published the place from it, or opened another place in it\)\. That is not a crash/);
    // The move is handled: a Studio that goes later is a crash again.
    expect(recovery.moving).toBe(false);
    w.working = true;
    crash();
    expect(await recovery.check()).toBe(true);
    expect(w.how.at(-1)).toEqual({ crashed: true, recovered: null });
    expect(chat().at(-1)).toMatch(/^status: Roblox Studio closed unexpectedly at /);
    recovery.stop();
  });

  it('a Studio that crashed under a playtest takes the playtest with it: the turn ends and the agent is told', async () => {
    const { core, recovery, crash, w } = await setup();
    core.lease.tryAcquire('run_player');
    crash();
    expect(await recovery.check()).toBe(true);
    expect(w.opened).toBe(1);
    expect(core.lease.holder).toBeNull();
    expect(core.lease.reclaimReasons.get('run_player')).toBe('crash');
    recovery.stop();
  });

  it('ends a hung Studio of the place (Windows says "Not Responding") before opening it again, never one that answers', async () => {
    const { core, recovery, crash, w } = await setup();
    const file = join(core.project!.root, 'place.rbxlx');
    const old = Date.now() - 3600_000;
    const procs: StudioProcess[] = [
      { pid: 401, startedAt: old, title: 'place.rbxlx - Roblox Studio (Not Responding)', responding: false, commandLine: `"RobloxStudioBeta.exe" "${file}"` },
      { pid: 402, startedAt: old, title: 'Voxel Pit - Roblox Studio', responding: true, commandLine: `"RobloxStudioBeta.exe" "${file}"` },
    ];
    const ended: number[] = [];
    (recovery as unknown as { d: { procs: () => Promise<StudioProcess[]>; endProc: (pid: number) => boolean } }).d.procs = async () => procs;
    (recovery as unknown as { d: { endProc: (pid: number) => boolean } }).d.endProc = (pid) => (ended.push(pid), true);
    crash();
    expect(await recovery.check()).toBe(true);
    expect(ended).toEqual([401]);
    expect(w.opened).toBe(1);
    recovery.stop();
  });

  it('tries a bounded number of times, then says what to do and stops trying until Studio shows up again', async () => {
    const { recovery, crash, w, chat, sim } = await setup();
    w.opening.fails = 99;
    crash();
    expect(await recovery.check()).toBe(false);
    expect(w.opened).toBe(3);
    expect(chat()).toHaveLength(1);
    expect(chat()[0]).toMatch(/^error: Roblox Studio closed and I couldn't reopen it \(Studio did not report an instance.*\)\. Open place\.rbxlx in Studio with its MCP server enabled/);
    // Not again on the next look, nor when a call asks.
    expect(await recovery.check()).toBe(false);
    expect(await recovery.check(true)).toBe(false);
    expect(w.opened).toBe(3);
    // The user opens it: all is well, and a later crash is handled again.
    sim.gone = false;
    w.window = 'open';
    expect(await recovery.check()).toBe(true);
    w.opening.fails = 0;
    crash();
    expect(await recovery.check()).toBe(true);
    expect(w.opened).toBe(4);
    recovery.stop();
  });

  it('stops reopening a place that keeps closing Studio', async () => {
    STUDIO_RECOVERY.maxLaunches = 2;
    const { recovery, crash, w, chat } = await setup();
    for (let i = 0; i < 2; i++) {
      crash();
      expect(await recovery.check()).toBe(true);
    }
    crash();
    expect(await recovery.check()).toBe(false);
    expect(w.opened).toBe(2);
    expect(chat().at(-1)).toMatch(/Studio was reopened 2 times in the last 1 minutes and keeps closing/);
    recovery.stop();
  });
});

// One project of a two-build night had no picture for hours. Measured in a scratch place (capture-focus.e2e.ts): a
// capture in flight when its playtest stops kills Studio's capture tool until the place is closed and opened again.
describe("Studio's screen capture is dead", () => {
  const dead = (core: Core) => {
    const studio = core.studio as unknown as { shotDead: { since: number } | null; shotFails: number; shotsPausedUntil: number; screenshot: () => Promise<unknown> };
    studio.shotDead = { since: Date.now() };
    studio.shotFails = 3;
    studio.shotsPausedUntil = Date.now() + 300_000;
    // Whether Studio answers a capture afterwards: it does once the place was opened again.
    studio.screenshot = async () => {
      if (studio.shotDead) throw new Error('still dead');
      return { data: 'x', mimeType: 'image/jpeg' };
    };
    return studio;
  };

  it('saves the place, closes and reopens it inside its own turn in Studio, and says so in one status line', async () => {
    const { core, ctx, recovery, w, chat } = await setup();
    dead(core);
    expect(await recovery.refresh()).toBe('reopened');
    expect(w.did).toEqual(['save (held by refresh)', 'close place.rbxlx', 'open']);
    expect(core.lease.holder).toBeNull();
    expect(core.studio.reopening).toBeNull();
    expect(core.studio.capturesDeadSince).toBeNull();
    expect(core.studio.capturePause()).toBeNull();
    expect(w.checked).toBe(1);
    const lines = chat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^status: Studio's screenshots stopped answering at \d\d:\d\d:\d\d \(a fault in Studio: a capture met a playtest that stopped under it.*\)\. I saved the place and reopened place\.rbxlx: screenshots work again, and the team carries on\.$/);
    expect(ctx.audit.timeline({ limit: 20 }).filter((e) => e.kind === 'studio.refresh').map((e) => e.severity)).toEqual(expect.arrayContaining(['warning', 'success']));
    // Nothing to do when captures work.
    expect(await recovery.refresh()).toBe('skipped');
    expect(w.did).toHaveLength(3);
    recovery.stop();
  });

  it("never closes Studio under someone's hands: says once what is wrong, and does it when they have been away", async () => {
    const { core, recovery, w, chat } = await setup();
    dead(core);
    for (const activity of [{ idleMs: 20_000, foreground: 'RobloxStudioBeta' }, null]) {
      w.activity = activity;
      expect(await recovery.refresh()).toBe('waiting');
    }
    expect(w.did).toEqual([]);
    expect(chat()).toHaveLength(1);
    expect(chat()[0]).toMatch(/I'll save the place and reopen place\.rbxlx myself once nobody has used the PC for a few minutes, or you can save and reopen it in Studio now\. The team works on without pictures meanwhile\.$/);
    w.activity = { idleMs: 4 * 60_000, foreground: 'RobloxStudioBeta' };
    expect(await recovery.refresh()).toBe('reopened');
    expect(w.did).toEqual(['save (held by refresh)', 'close place.rbxlx', 'open']);
    recovery.stop();
  });

  it('leaves Studio open when the place cannot be saved first, and when nobody works on the project', async () => {
    const { core, recovery, w, chat } = await setup();
    dead(core);
    w.working = false;
    expect(await recovery.refresh()).toBe('skipped');
    w.working = true;
    w.save = { ok: false, focus: true, message: 'Windows did not bring the Studio window to the front, so no keys were sent.' };
    expect(await recovery.refresh()).toBe('failed');
    expect(w.did).toEqual(['save (held by refresh)']);
    expect(core.lease.holder).toBeNull();
    expect(core.studio.reopening).toBeNull();
    expect(core.studio.capturesDeadSince).not.toBeNull();
    expect(chat().at(-1)).toMatch(/I couldn't save the place first \(Windows did not bring the Studio window to the front.*\), so I left Studio as it is\./);
    // Not again right away: a refresh waits out its cooldown.
    w.save = { ok: true, message: 'Saved place.rbxlx.' };
    expect(await recovery.refresh()).toBe('skipped');
    STUDIO_REFRESH.cooldownMs = 0;
    expect(await recovery.refresh()).toBe('reopened');
    recovery.stop();
  });

  it("waits its turn behind a playtest, and agents' Studio calls wait for the reopened place", async () => {
    const { core, recovery, w } = await setup();
    dead(core);
    w.opening.ms = 300;
    core.lease.tryAcquire('run_playing');
    const refreshing = recovery.refresh();
    await sleep(80);
    expect(w.did).toEqual([]);
    core.lease.release('run_playing');
    await waitFor(() => core.studio.reopening, 3000);
    expect(core.studio.reopening).toMatchObject({ refresh: true, place: 'place.rbxlx' });
    const notes: string[] = [];
    const call = core.tools.invoke('roblox_run_luau', { code: 'return "x"' }, agent, undefined, ({ message }) => message && notes.push(message));
    expect(await refreshing).toBe('reopened');
    const r = await call;
    expect(r.isError, text(r)).toBeFalsy();
    // What the waiting agent is told: who holds Studio and why (it stands behind the refresh's turn).
    expect(notes.join(' | ')).toMatch(/Waiting for Studio: Shuriken, which is reopening the place to bring Studio's screen capture back, holding Studio since \d\d:\d\d:\d\d/);
    recovery.stop();
  });

  it('the place it closed itself is not taken for a crash: it is opened once', async () => {
    const { core, recovery, w } = await setup();
    dead(core);
    w.opening.ms = 300;
    const refreshing = recovery.refresh();
    await waitFor(() => w.did.includes('close place.rbxlx'), 3000);
    // The watch for a Studio that crashed looks while it is closed, and so does a call that finds no Studio.
    expect(await recovery.check()).toBe(true);
    expect(await recovery.check(true)).toBe(true);
    expect(await refreshing).toBe('reopened');
    expect(w.opened).toBe(1);
    recovery.stop();
  });

  it('reopens once for captures that only time out, and not again when that brought no picture', async () => {
    STUDIO_REFRESH.cooldownMs = 0;
    const { core, recovery, w, chat } = await setup();
    const studio = core.studio as unknown as { shotFails: number; screenshot: () => Promise<unknown>; capturesBack: () => void };
    studio.shotFails = 3;
    studio.capturesBack = () => undefined;
    studio.screenshot = async () => {
      throw new Error('timed out');
    };
    expect(await recovery.refresh()).toBe('reopened');
    expect(chat().at(-1)).toMatch(/I saved the place and reopened place\.rbxlx, but Studio still returns no picture \(is the display off, or Studio minimized\?\)/);
    expect(await recovery.refresh()).toBe('skipped');
    expect(w.opened).toBe(1);
    recovery.stop();
  });
});

describe("agents' Studio calls while Studio is gone", () => {
  it('a call that finds no Studio has it reopened, waits (saying what for) and then runs: no error, nothing to ask', async () => {
    const { core, recovery, crash, sim, w } = await setup();
    w.working = false; // a tool call is work enough
    w.opening.ms = 250;
    crash();
    const notes: string[] = [];
    const r = await core.tools.invoke('roblox_run_luau', { code: 'return "x"' }, agent, undefined, ({ message }) => message && notes.push(message));
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toBe('PASS');
    expect(w.opened).toBe(1);
    expect(notes.some((n) => /^Waiting for Studio: it closed unexpectedly at \d\d:\d\d:\d\d and Shuriken is reopening place\.rbxlx \(try 1 of 3\)\. Your call goes on when it is back\.$/.test(n))).toBe(true);
    expect(sim.luau('Edit').filter((c) => c.code.includes('return "x"'))).toHaveLength(1);
    recovery.stop();
  });

  it('calls that arrive during the reopen wait for it too, and all go on when it is back', async () => {
    const { core, recovery, crash, w } = await setup();
    w.opening.ms = 300;
    crash();
    const looking = recovery.check();
    await waitFor(() => core.studio.reopening, 3000);
    const calls = [1, 2, 3].map((i) => core.tools.invoke('roblox_run_luau', { code: `return "${i}"` }, { ...agent, runId: `run_${i}` }));
    await sleep(100);
    expect(w.opened).toBe(1);
    for (const r of await Promise.all(calls)) expect(r.isError, text(r)).toBeFalsy();
    expect(await looking).toBe(true);
    recovery.stop();
  });

  it('when it cannot be reopened the call says so in words that send the agent on with other work, asking nobody', async () => {
    const { core, recovery, crash, w } = await setup();
    w.opening.fails = 99;
    crash();
    const r = await core.tools.invoke('roblox_run_luau', { code: 'return "x"' }, agent);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Roblox Studio closed and could not be reopened \(the user was told in the chat\)\. Carry on with work that needs no Studio/);
    expect(text(r)).toMatch(/not a question for anyone and not a blocker/);
    recovery.stop();
  });

  it('a wait that runs out says Shuriken is still reopening it', async () => {
    STUDIO_WAIT.maxMs = 150;
    STUDIO_RECOVERY.openMs = 5000;
    const { core, recovery, crash, w } = await setup();
    w.opening.ms = 1200;
    crash();
    const r = await core.tools.invoke('roblox_run_luau', { code: 'return "x"' }, agent);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Roblox Studio closed unexpectedly at \d\d:\d\d:\d\d and is still being reopened \(try 1 of 3\); waited .*Shuriken reopens it by itself/);
    await recovery.check();
    recovery.stop();
  });
});

describe('a verification that meets a Studio that is gone', () => {
  it('waits for the reopen and runs its checks again: the crash is not a failure of the work', async () => {
    const { core, ctx, recovery, crash, w, sim } = await setup();
    stop(core);
    recovery.start();
    w.working = false;
    sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'PASS');
    const task = ctx.tasks.create({ kind: 'implement', title: 'Round loop', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification: [{ kind: 'luau_assert', name: 'round_ready', luau: "return 'PASS'", datamodel: 'edit' }, { kind: 'playtest', name: 'round_runs', durationSec: 2, luau: "return 'PASS'", failOnConsoleErrors: true }] });
    crash();
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    expect(report.passed, report.summary).toBe(true);
    expect(w.opened).toBe(1);
    expect(ctx.tasks.evidence(task.id).some((e) => /^Roblox Studio closed during the verification; it was reopened and the checks were run again/.test(e.title))).toBe(true);
    // Without anyone to reopen it, the failure stands as it is.
    recovery.stop();
    crash();
    const lost = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    expect(lost.passed).toBe(false);
    expect(lost.summary).toMatch(/No open Studio instance matches/);
  });
});
