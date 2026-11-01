import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { CHARACTER_WAIT, CharacterHistory, awaitCharacterLuau, characterLine } from '../src/core/roblox/playtest-character';
import { coreHarness } from './helpers/make-core';
import { attachSim, type StudioSim } from './helpers/studio-sim';

/**
 * The user's game opens in a garage: no character until the player deploys. 103 of its 262 playtests waited the
 * full 15 s for one and then said "is Players.CharacterAutoLoads off, or does spawning fail?".
 */
const makeCore = coreHarness();
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
/** One second of the game's clock in the stand-in Studio. */
const SEC = 20;

interface World {
  /** Players.CharacterAutoLoads. */
  autoLoads: boolean;
  /** When the character appears after the server starts (null: never). */
  spawnsAfter: number | null;
  /** What the last wait was asked: expect and skip, as the Luau got them. */
  asked: Array<{ expect: boolean | null; skip: boolean }>;
  /** How long each wait took on the game's clock (seconds). */
  waited: number[];
}

/** The wait's Luau, mirrored: the same decisions on the same inputs, in the stand-in's time. */
function play(sim: StudioSim, world: World): void {
  sim.answer = async (code) => {
    if (code.includes('GetLogHistory')) return '{"ok":true,"errors":[]}';
    if (!code.includes('CharacterAutoLoads')) return 'PASS';
    const e = /local expect = (nil|true|false)/.exec(code)![1]!;
    const expect = e === 'nil' ? null : e === 'true';
    const skip = /local skip = (true|false)/.exec(code)![1] === 'true';
    world.asked.push({ expect, skip });
    const wants = expect !== null ? expect : world.autoLoads && !skip;
    const joined = 0.2;
    const until = wants ? CHARACTER_WAIT.characterSec : expect === false || !world.autoLoads ? joined : joined + CHARACTER_WAIT.graceSec;
    const character = world.spawnsAfter !== null && world.spawnsAfter <= until;
    const waited = character ? world.spawnsAfter! : until;
    world.waited.push(waited);
    await new Promise((r) => setTimeout(r, waited * SEC));
    return JSON.stringify({ character, player: true, autoLoads: world.autoLoads, waited });
  };
}

async function setup(world: Partial<World> = {}) {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const sim = attachSim(h.core);
  const w: World = { autoLoads: true, spawnsAfter: 0.4, asked: [], waited: [], ...world };
  play(sim, w);
  const run = async (args: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const r = await h.core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0, luau: 'return "PASS"', ...args }, agent);
    return { r, out: text(r), ms: Date.now() - t0 };
  };
  return { ...h, sim, world: w, run };
}

const saved = { ...CHARACTER_WAIT };
beforeEach(() => Object.assign(CHARACTER_WAIT, saved));
afterEach(() => Object.assign(CHARACTER_WAIT, saved));

describe('roblox_playtest "run" and the player\'s character', () => {
  it('waits for the character in a game that spawns one, and says nothing about it', async () => {
    const { run, ctx } = await setup();
    const { out, r } = await run();
    expect(r.isError, out).toBeFalsy();
    expect(out).toMatch(/^Played 0 s after the character spawned\.\nServer probe: PASS/);
    expect(out).not.toMatch(/character on join|No player character/);
    expect(new CharacterHistory(ctx.dir).misses()).toBe(0);
  });

  it("doesn't pay the wait in a game that opens in a menu (CharacterAutoLoads off), and says so plainly", async () => {
    const { run, world } = await setup({ autoLoads: false, spawnsAfter: null });
    const { out } = await run();
    expect(out).toMatch(/^This game doesn't spawn a character on join \(Players\.CharacterAutoLoads is off\); probes ran without one\. Pass expect_character: true/);
    expect(out).toMatch(/\nPlayed 0 s\.\nServer probe: PASS/);
    expect(out).not.toMatch(/does spawning fail|No player character appeared/);
    expect(world.asked).toEqual([{ expect: null, skip: false }]);
    // The full wait would be 15 s of the game's clock: it only waited for the player to join.
    expect(world.waited).toEqual([0.2]);
  });

  it("learns it from the project's own playtests when the game doesn't say: one full wait, then none", async () => {
    const { run, world, ctx } = await setup({ autoLoads: true, spawnsAfter: null });
    const first = await run();
    expect(first.out).toMatch(/^No player character appeared within 15 s, although Players\.CharacterAutoLoads is on: either the game holds the player in a menu and removes the character, or spawning fails\. The next playtests of this project don't wait for one/);
    expect(world.waited.at(-1)).toBe(CHARACTER_WAIT.characterSec);
    expect(new CharacterHistory(ctx.dir).misses()).toBe(1);
    const second = await run();
    expect(second.out).toMatch(/^This game doesn't spawn a character on join \(none appeared in its last 1 playtest\); probes ran without one\./);
    expect(world.waited.at(-1)).toBe(0.2 + CHARACTER_WAIT.graceSec);
    expect(world.asked.at(-1)).toEqual({ expect: null, skip: true });
    expect((await run()).out).toMatch(/none appeared in its last 2 playtests/);
    expect(JSON.parse(readFileSync(join(ctx.dir, 'playtest.json'), 'utf8'))).toEqual({ noCharacter: 3 });
    // The game starts spawning one (an auto-deploy hook was added): seen in the short grace, and the waits are back.
    world.spawnsAfter = 0.5;
    const hooked = await run();
    expect(hooked.out).toMatch(/^Played 0 s after the character spawned\./);
    expect(new CharacterHistory(ctx.dir).misses()).toBe(0);
    await run();
    expect(world.asked.at(-1)).toEqual({ expect: null, skip: false });
  });

  it('expect_character says it outright: true waits for one whatever the game says, false never waits', async () => {
    const { run, world, ctx } = await setup({ autoLoads: false, spawnsAfter: 6 });
    const waited = await run({ expect_character: true });
    expect(waited.out).toMatch(/^Played 0 s after the character spawned\./);
    expect(world.asked.at(-1)).toEqual({ expect: true, skip: false });
    world.spawnsAfter = null;
    const none = await run({ expect_character: true });
    expect(none.out).toMatch(/^No player character appeared within 15 s although one was expected \(expect_character\)/);
    world.autoLoads = true;
    world.spawnsAfter = 3;
    const skipped = await run({ expect_character: false });
    expect(skipped.out).toMatch(/^Probes ran without a character \(expect_character: false\)\.\nPlayed 0 s\./);
    expect(world.waited.at(-1)).toBe(0.2);
    // Saying "don't wait" teaches the project nothing about the game.
    expect(new CharacterHistory(ctx.dir).misses()).toBe(1);
  });

  it('says what it could when the server never answered the wait', () => {
    expect(characterLine(null, null, false, 0)).toMatch(/got no answer from the server/);
    expect(characterLine({ character: true, player: true, autoLoads: true, waited: 1 }, null, false, 0)).toBeNull();
    expect(characterLine({ character: false, player: false, autoLoads: false, waited: 5 }, null, false, 0)).toMatch(/probes ran without one \(the player had not joined yet either\)/);
  });

  it.skipIf(!existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene')))("the wait's Luau parses", async () => {
    const t = new LuauToolchain(tmpdir());
    for (const [want, skip] of [[null, false], [null, true], [true, false], [false, true]] as const) expect(await t.parseErrors(awaitCharacterLuau(want, skip)), `${want} ${skip}`).toEqual([]);
  });
});
