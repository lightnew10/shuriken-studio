import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { needsUserHands } from '../src/core/permissions/user-hands';
import { LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { CAPABILITY_ERROR, HOSTS_PRESENT, HOSTS_REMOVE, HOSTS_WRITE, HOST_SOURCE, NEEDS_GAME_RIGHTS, NO_HOST, RESTRICTED_PROBE, bridgedProgram } from '../src/core/roblox/probe-bridge';
import { RobloxStudioAdapter } from '../src/core/roblox/studio-adapter';

/**
 * 2026-10-01, 4:17 PM: Roblox switched on FFlagAssistantCapsRestrictDataStore2 and Studio began running MCP code
 * without four script capabilities. A build started at 7:22 PM got no code into Studio; in a scratch place the same
 * evening a probe could not require a module or fire an event either. Probes that need that now run inside the
 * game, through a host script put in before the playtest starts (probe-bridge.ts). The live proof is
 * tests/e2e/sync-create.e2e.ts; here: what goes through the host, and what Studio is asked.
 */

const text = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });

/** A Studio that answers by tool and DataModel, recording what it was asked. */
class Scripted extends RobloxStudioAdapter {
  seen: Array<{ tool: string; dm?: string; code?: string; path?: string }> = [];
  refuses = true;
  playing = false;
  hostInPlay = true;
  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }
  protected override async callOnce(tool: string, args: Record<string, unknown>): Promise<ExternalCallResult> {
    const code = typeof args.code === 'string' ? args.code : undefined;
    this.seen.push({ tool, dm: args.datamodel_type as string | undefined, code, path: args.file_path as string | undefined });
    if (tool === 'start_stop_play') {
      this.playing = !!args.is_start;
      return text('ok');
    }
    if (tool === 'get_studio_state') return text(this.playing ? 'Studio mode: Play\nAvailable datamodels: Client, Server' : 'Studio mode: Edit\nAvailable datamodels: Edit');
    if (tool === 'multi_edit') return text('Created');
    if (code === RESTRICTED_PROBE) return text(this.refuses ? 'restricted' : 'free');
    if (code === HOSTS_PRESENT) return text('[false,false,true,false]');
    if (code === HOSTS_WRITE || code === HOSTS_REMOVE) return text('ok');
    if (code?.includes('host.Job.Source =')) return text(this.hostInPlay ? 'through the host' : NO_HOST);
    return text('direct');
  }
}

describe('what goes through the probe host', () => {
  it('is what a restricted thread is refused: require, firing and invoking, copies, scripts', () => {
    for (const code of [
      'local Lib = require(game.ReplicatedStorage.Shared.Lib)',
      'game.ReplicatedStorage.Remotes.Swing:FireServer(1)',
      'remote:FireClient(player)',
      'ev:Fire()',
      'local v = fn:Invoke(2)',
      'fn:InvokeServer()',
      'local c = template:Clone()',
      'local s = Instance.new("ModuleScript")',
    ])
      expect(NEEDS_GAME_RIGHTS.test(code), code).toBe(true);
    for (const code of ['return workspace:GetAttribute("Round")', 'local p = Instance.new("Part") p.Parent = workspace', 'return #game.Players:GetPlayers()', 'humanoid:TakeDamage(10)', 'print("required")'])
      expect(NEEDS_GAME_RIGHTS.test(code), code).toBe(false);
    for (const e of [
      "The current thread cannot reparent 'Motion' to 'ReplicatedStorage.Shared' since 'ReplicatedStorage.Shared' has additional values for the Capabilities property: LoadUnownedAsset (and 3 more)",
      "The current thread cannot require 'Mod' since 'Mod' has additional values for the Capabilities property: LoadUnownedAsset (and 3 more)",
      "The current thread cannot write 'HttpEnabled' (lacking capability Network)",
    ])
      expect(CAPABILITY_ERROR.test(e)).toBe(true);
  });

  it('keeps the probe on its own lines and carries any code, long brackets included', () => {
    const code = 'local a = [[x]]\nlocal b = [=[y]=]\nreturn require(m)';
    const p = bridgedProgram(code, 'Server', 30);
    // The job module starts with the probe on line 1 (errors name the probe's own lines).
    expect(p).toContain(`pcall(function() ${code}\nend)\nreturn { __ok, __res }`);
    expect(p).toMatch(/host\.Job\.Source = \[==\[\n/);
    expect(p).toContain('game:GetService("ServerScriptService"):FindFirstChild("ShurikenProbeHost")');
    expect(bridgedProgram('return 1', 'Client', 30)).toContain('PlayerScripts');
    expect(p).toContain('os.clock() + 30');
    expect(HOST_SOURCE).toContain('if not game:GetService("RunService"):IsStudio() then return end');
  });

  it.skipIf(!existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene')))('every program of the bridge is valid Luau', async () => {
    const t = new LuauToolchain(tmpdir());
    for (const [name, code] of [
      ['host', HOST_SOURCE],
      ['bridged (server)', bridgedProgram('local Lib = require(game.ReplicatedStorage.Lib)\nreturn Lib.v', 'Server', 20)],
      ['bridged (client)', bridgedProgram('return 1', 'Client', 20)],
      ['restricted probe', RESTRICTED_PROBE],
      ['hosts present', HOSTS_PRESENT],
      ['hosts write', HOSTS_WRITE],
      ['hosts remove', HOSTS_REMOVE],
    ] as const)
      expect(await t.parseErrors(code), name).toEqual([]);
  }, 120_000);
});

describe('a playtest in a Studio that refuses scripts to MCP code', () => {
  it('puts the hosts in before play (only the missing ones through the script tool), runs needy probes through them, and takes them out after', async () => {
    const studio = new Scripted();
    await studio.setPlaying(true);
    const before = studio.seen.findIndex((s) => s.tool === 'start_stop_play');
    const setup = studio.seen.slice(0, before);
    expect(setup.filter((s) => s.tool === 'multi_edit').map((s) => s.path)).toEqual(['game.ServerScriptService.ShurikenProbeHost', 'game.ServerScriptService.ShurikenProbeHost.Job', 'game.StarterPlayer.StarterPlayerScripts.ShurikenProbeHost.Job']);
    expect(setup.some((s) => s.code === HOSTS_WRITE)).toBe(true);

    expect((await studio.runLuau('return require(game.ReplicatedStorage.Lib).v', 'Server')).output).toBe('through the host');
    expect((await studio.runLuau('game.ReplicatedStorage.Swing:FireServer()', 'Client')).output).toBe('through the host');
    // What needs nothing of the kind runs as written, and so does everything in Edit.
    expect((await studio.runLuau('return workspace:GetAttribute("Round")', 'Server')).output).toBe('direct');
    expect((await studio.runLuau('return require(x)', 'Edit')).output).toBe('direct');
    // No host in this playtest (someone else started it): the probe runs as written.
    studio.hostInPlay = false;
    expect((await studio.runLuau('return require(game.ReplicatedStorage.Lib).v', 'Server')).output).toBe('direct');

    studio.seen = [];
    await studio.setPlaying(false);
    expect(studio.seen.at(-1)).toMatchObject({ dm: 'Edit', code: HOSTS_REMOVE });
    // After the stop nothing goes through a host.
    expect((await studio.runLuau('return require(x)', 'Server')).output).toBe('direct');
  });

  it('does none of it in a Studio that allows scripts: one tiny question, then plain calls', async () => {
    const studio = new Scripted();
    studio.refuses = false;
    await studio.setPlaying(true);
    expect(studio.seen.filter((s) => s.tool === 'multi_edit')).toEqual([]);
    expect(studio.seen.filter((s) => s.code === RESTRICTED_PROBE)).toHaveLength(1);
    expect((await studio.runLuau('return require(game.ReplicatedStorage.Lib).v', 'Server')).output).toBe('direct');
    await studio.setPlaying(false);
    await studio.setPlaying(true);
    // Asked once, remembered.
    expect(studio.seen.filter((s) => s.code === RESTRICTED_PROBE)).toHaveLength(1);
    expect(studio.seen.some((s) => s.code === HOSTS_REMOVE)).toBe(false);
  });
});

describe("what only the user's hands can do", () => {
  it('is recognised in the words agents used, and ordinary questions are not', () => {
    for (const q of [
      'Studio refuses all script sync: please restart Roblox Studio',
      'Studio needs a restart: no scripts can be synced',
      'Needed: the user closes and reopens Roblox Studio on roblox-pvp-dungeon-game.rbxlx',
      'Please save the place, close Roblox Studio completely and reopen the project.',
      'You need to sign in to Roblox Studio again',
      'Enable "Allow HTTP requests" in Game Settings',
      'Turn on Enable Studio as MCP server in the Assistant settings',
      'Update Roblox Studio to the latest version',
      'Please restart the PC',
    ])
      expect(needsUserHands(q), q).toBe(true);
    for (const q of [
      'Should the arena be stone or wood?',
      'Which studio lighting preset should the lobby use?',
      'The restart button in the menu: should it reset the round?',
      'Should players sign in with a code to join a private match?',
      'May I close the shop UI automatically after a purchase?',
    ])
      expect(needsUserHands(q), q).toBe(false);
  });
});
