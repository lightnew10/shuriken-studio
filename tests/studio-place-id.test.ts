import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { RobloxStudioAdapter, SAME_DOC } from '../src/core/roblox/studio-adapter';
import { StudioRecovery } from '../src/core/roblox/studio-recovery';
import { coreHarness } from './helpers/make-core';
import { StudioSim } from './helpers/studio-sim';

/**
 * 2026-10-07: the team's Studio window had the project's place file open and its DataModel was still named after the
 * file, but Studio's MCP server listed it as "Voxel Pit (placeId: 70000000000001)" (the place had been published). For
 * 50 minutes every playtest and screenshot failed with "No open Studio instance matches". The window is found by the
 * project's place id now, and only when the window itself says its place is the bound one: a published copy (named
 * after the game) never is. Each Studio window here is a StudioSim behind a fake MCP connection; no real Studio.
 */
const ok = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });
const fail = (e: string): ExternalCallResult => ({ ok: false, content: [], error: e, durationMs: 1 });

interface Window {
  id: string;
  /** The name Studio's MCP server lists it under. */
  listed: string;
  /** What `game.Name` is in its Edit DataModel. */
  place: string;
  sim: StudioSim;
}

const window = (id: string, listed: string, place: string): Window => {
  const w: Window = { id, listed, place, sim: new StudioSim() };
  w.sim.answer = (code) => (code === 'return game.Name' ? w.place : 'PASS');
  return w;
};

/** Studio's MCP server with several windows open: calls go to the window their studio_id names, as Studio's do. */
class ManyWindows extends RobloxStudioAdapter {
  constructor(readonly open: Window[]) {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
    (this as unknown as { conn: unknown }).conn = {
      state: 'connected',
      lastError: null,
      call: async (tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ExternalCallResult> => {
        if (tool === 'list_roblox_studios') return ok(JSON.stringify({ studios: this.open.map((w) => ({ id: w.id, name: w.listed })) }));
        const w = this.open.find((x) => x.id === args.studio_id);
        return w ? w.sim.callOnce(tool, args, { timeoutMs }) : fail(`Unknown studio_id ${String(args.studio_id)}`);
      },
    };
  }
}

/** The Luau each window was sent (other than the question what its place is), and how often it was asked that. */
const sent = (w: Window) => w.sim.luau().filter((c) => c.code !== 'return game.Name').map((c) => c.code);
const asked = (w: Window) => w.sim.luau().filter((c) => c.code === 'return game.Name').length;

const savedDoc = { ...SAME_DOC };
afterEach(() => Object.assign(SAME_DOC, savedDoc));

const bound = (windows: Window[], placeId: string | null = '731') => {
  const studio = new ManyWindows(windows);
  studio.bind('hypixel.rbxlx');
  studio.projectPlaceId = () => placeId;
  return studio;
};

describe("finding the team's Studio window by the project's place id", () => {
  it('takes the window listed under the published game\'s name when the window says its place is the bound file', async () => {
    const team = window('w1', 'Voxel Pit (placeId: 731)', 'hypixel.rbxlx');
    const other = window('w2', 'other.rbxlx', 'other.rbxlx');
    const studio = bound([other, team]);
    const r = await studio.runLuau('return "x"', 'Edit');
    expect(r).toMatchObject({ ok: true, output: 'PASS' });
    expect(sent(team)).toEqual(['return "x"']);
    expect(sent(other)).toEqual([]);
    // Studio's own tools go there too (play control, state), and the answer is kept for a while: one question.
    expect((await studio.state()).availableDataModels).toEqual(['Edit']);
    await studio.runLuau('return "y"', 'Edit');
    expect(asked(team)).toBe(1);
    expect(team.sim.calls.every((c) => c.args.studio_id === 'w1')).toBe(true);
  });

  it('never takes a published copy: Studio names its place after the game', async () => {
    const copy = window('w1', 'Voxel Pit (placeId: 731)', 'Voxel Pit');
    const studio = bound([copy]);
    const r = await studio.runLuau('return "x"', 'Edit');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/^No open Studio instance matches "hypixel\.rbxlx"\. Open: Voxel Pit \(placeId: 731\)\. "Voxel Pit \(placeId: 731\)" has this project's place id but is another document \(its place is "Voxel Pit", not hypixel\.rbxlx\): a published copy, not the team's place$/);
    expect(sent(copy)).toEqual([]);
  });

  it('of two windows listed alike, takes the one whose place is the file, whichever comes first', async () => {
    const copy = window('w1', 'Voxel Pit (placeId: 731)', 'Voxel Pit');
    const team = window('w2', 'Voxel Pit (placeId: 731)', 'hypixel.rbxlx');
    const studio = bound([copy, team]);
    expect((await studio.runLuau('return "x"', 'Edit')).ok).toBe(true);
    expect(sent(team)).toEqual(['return "x"']);
    expect(sent(copy)).toEqual([]);
  });

  it('takes nothing without the project\'s place id, nor a window of another id; the id Shuriken Link reports counts', async () => {
    const team = window('w1', 'Voxel Pit (placeId: 731)', 'hypixel.rbxlx');
    expect((await bound([team], null).runLuau('return "x"', 'Edit')).ok).toBe(false);
    expect((await bound([team], '999').runLuau('return "x"', 'Edit')).ok).toBe(false);
    expect(asked(team)).toBe(0);
    // The project has no place id recorded, but its Edit session (the plugin) reports one.
    const studio = bound([team], null);
    (studio as unknown as { link: unknown }).link = { has: () => false, place: () => ({ studio: 'abc', place: 'hypixel.rbxlx', placeId: 731, gameId: 9 }) };
    expect((await studio.runLuau('return "x"', 'Edit')).ok).toBe(true);
    expect(sent(team)).toEqual(['return "x"']);
  });

  it('keeps a window proven before through its playtest, takes none never proven while it plays, and drops one whose place became the game', async () => {
    SAME_DOC.freshMs = 0;
    const team = window('w1', 'Voxel Pit (placeId: 731)', 'hypixel.rbxlx');
    const studio = bound([team]);
    expect((await studio.runLuau('return "x"', 'Edit')).ok).toBe(true);
    // In a playtest its Edit DataModel can't be asked: what was proven stands.
    team.sim.mode = 'Play';
    expect(await studio.runLuau('return "server"', 'Server')).toMatchObject({ ok: true, output: 'PASS' });
    expect(sent(team)).toContain('return "server"');
    // Never proven and playing: not taken.
    const playing = window('w9', 'Voxel Pit (placeId: 731)', 'hypixel.rbxlx');
    playing.sim.mode = 'Play';
    expect((await bound([playing]).runLuau('return 1', 'Server')).ok).toBe(false);
    // Back in Edit, Studio reloaded it as the published game: it is not the team's place any more.
    team.sim.mode = 'Edit';
    team.place = 'Voxel Pit';
    const r = await studio.runLuau('return "z"', 'Edit');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/a published copy, not the team's place/);
    expect(sent(team)).not.toContain('return "z"');
  });
});

describe('Studio recovery and a window listed under the game\'s name', () => {
  const makeCore = coreHarness();

  it('does not take the team\'s window for gone (nothing is reopened), but a published copy alone is no place of the team\'s', async () => {
    const { core, ctx, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    writeFileSync(join(root, 'hypixel.rbxlx'), '<roblox/>', 'utf8');
    ctx.updateExtras({ placeFile: 'hypixel.rbxlx' });
    const team = window('w1', 'Voxel Pit (placeId: 731)', 'hypixel.rbxlx');
    const studio = bound([team]);
    let opened = 0;
    const recovery = new StudioRecovery({
      project: () => ctx,
      studio,
      bus: core.bus,
      log: core.logger.scope('test'),
      working: () => true,
      reopened: async () => undefined,
      windowState: async () => 'none',
      procs: async () => [],
      open: async () => {
        opened++;
        studio.open.push(window('w3', 'hypixel.rbxlx', 'hypixel.rbxlx'));
        return { name: 'hypixel.rbxlx' };
      },
    });
    expect(await recovery.check()).toBe(true);
    expect(opened).toBe(0);
    // Reloaded as the published game: the local file is opened for the team.
    team.place = 'Voxel Pit';
    SAME_DOC.freshMs = 0;
    expect(await recovery.check()).toBe(true);
    expect(opened).toBe(1);
    recovery.stop();
  });
});

// 2026-10-08: Shuriken's own open of a new project's place failed (Studio had moved with an update), the user opened the
// place file in Studio by hand, and the project stayed "not linked" for good: only a successful open linked it.
describe("a project's own place opened by hand", () => {
  const unbound = (windows: Window[], own: string | null) => {
    const studio = new ManyWindows(windows);
    studio.projectPlaceFile = () => own;
    const linked: string[] = [];
    studio.onAutoBind = (m) => linked.push(m);
    return { studio, linked };
  };

  it('links the window that has exactly the project\'s place file, and says so once', async () => {
    const mine = window('w1', 'polished-roblox-surf-game.rbxlx', 'polished-roblox-surf-game.rbxlx');
    const other = window('w2', 'rabbit-horde-survival.rbxlx', 'rabbit-horde-survival.rbxlx');
    const { studio, linked } = unbound([other, mine], 'polished-roblox-surf-game.rbxlx');
    expect(await studio.runLuau('return "x"', 'Edit')).toMatchObject({ ok: true, output: 'PASS' });
    expect(studio.binding).toBe('polished-roblox-surf-game.rbxlx');
    expect(linked).toEqual(['polished-roblox-surf-game.rbxlx']);
    expect(sent(mine)).toEqual(['return "x"']);
    expect(sent(other)).toEqual([]);
    await studio.runLuau('return "y"', 'Edit');
    expect(linked).toHaveLength(1);
  });

  it('takes no other place, no place of another project with a longer name, and nothing without a place file', async () => {
    const other = window('w2', 'rabbit-horde-survival.rbxlx', 'rabbit-horde-survival.rbxlx');
    const longer = window('w3', 'my-surf-game.rbxlx', 'my-surf-game.rbxlx');
    expect((await unbound([other, longer], 'surf-game.rbxlx').studio.runLuau('return "x"', 'Edit')).output).toMatch(/^No Studio place is linked to this project yet/);
    const none = unbound([other], null);
    expect((await none.studio.runLuau('return "x"', 'Edit')).ok).toBe(false);
    expect(none.linked).toEqual([]);
    // Two windows of the same file: which is the team's isn't known, so neither is taken.
    const a = window('w4', 'surf.rbxlx', 'surf.rbxlx');
    const b = window('w5', 'surf.rbxlx', 'surf.rbxlx');
    expect((await unbound([a, b], 'surf.rbxlx').studio.runLuau('return "x"', 'Edit')).ok).toBe(false);
    expect([...sent(other), ...sent(longer), ...sent(a), ...sent(b)]).toEqual([]);
  });
});
