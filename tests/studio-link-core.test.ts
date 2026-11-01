import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { studioRightsLine } from '../src/core/roblox/probe-bridge';
import { DEFAULT_APP_PREFS } from '../src/core/app-prefs';
import { studioLinkLine, type StudioLinkInfo } from '../src/renderer/src/lib/studio-link';
import { coreHarness } from './helpers/make-core';

/**
 * Shuriken Link in the core: tests have no link (nothing is written into Studio's Plugins folder, no port is
 * opened), the project follows a place that was published, and agents and the user are told what holds.
 */
const makeCore = coreHarness();

describe('the link in the core', () => {
  it('does not exist in tests, is on by default, and says so in its status', async () => {
    const { core } = await makeCore({ respond: async () => null });
    expect(core.studioLink).toBeNull();
    expect(core.studio.link).toBeNull();
    expect(DEFAULT_APP_PREFS.studioLink).toBe(true);
    expect(core.prefs.set({ studioLink: false }).studioLink).toBe(false);
    expect(core.studioLinkStatus()).toMatchObject({ available: false, enabled: false, installed: false, port: null, linked: [], calls: 0, failed: 0 });
    // The setting can be applied with no link at all.
    await core.applyStudioLink();
  });

  // The user published their place while the team built: Studio reloaded it as "Untitled 13", Shuriken took that
  // for a crash, reopened the file in a second window and built there while the user tested the first.
  it('stays on the local file after a publish: records the published game, says so once, and keeps saving the file', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    writeFileSync(join(ctx.root, 'simple-drift-game.rbxlx'), '<roblox/>');
    ctx.updateExtras({ placeFile: 'simple-drift-game.rbxlx' });
    ctx.updateSettings({ robloxStudioMatch: 'simple-drift-game.rbxlx' });
    core.studio.bind('simple-drift-game.rbxlx');
    const follow = (core as unknown as { followPlace: (display: string, now: unknown, before: unknown) => void }).followPlace.bind(core);
    // The local file is opened again for the team after a publish and after a move (StudioRecovery.afterMove).
    let reopens = 0;
    (core as unknown as { placeGuard: { recovery: { afterMove: () => void } } }).placeGuard.recovery.afterMove = () => void reopens++;
    const published = { studio: 's2', place: 'Place2', placeId: 70000000000001, gameId: 7000000001 };
    follow('Place2 (placeId: 70000000000001)', published, { studio: 's1', place: 'simple-drift-game.rbxlx', placeId: 0, gameId: 0 });
    // The team stays on the local file (saved, backed up, reopened after a crash); the game it was published as is kept.
    expect(ctx.settings().robloxStudioMatch).toBe('simple-drift-game.rbxlx');
    expect(core.studio.binding).toBe('simple-drift-game.rbxlx');
    expect(ctx.extras()).toMatchObject({ placeFile: 'simple-drift-game.rbxlx', cloud: { universeId: '7000000001', placeId: '70000000000001' } });
    const said = () => core.director.chat()!.list().filter((m) => m.role === 'system' && m.kind === 'status').map((m) => m.text);
    expect(said()).toContain(`You published simple-drift-game.rbxlx to Roblox. The team keeps working on simple-drift-game.rbxlx, your local copy (saved, backed up and reopened after a crash), and I'm opening it again in Studio. The window you published from is now the published game: close it when you're done with it. Publish from the local file again whenever players should get the changes.`);
    expect(reopens).toBe(1);
    // The published window's plugin can link again: said once.
    follow('Place2 (placeId: 70000000000001)', published, null);
    expect(said().filter((t) => t.startsWith('You published'))).toHaveLength(1);
    // Saved under another file name, or another place opened in the window (no place id): the project keeps its own
    // file and opens it again; it used to follow the window there and lose its saves, backups and crash recovery.
    follow('arena-v2.rbxlx', { studio: 's3', place: 'arena-v2.rbxlx', placeId: 0, gameId: 0 }, null);
    expect(ctx.settings().robloxStudioMatch).toBe('simple-drift-game.rbxlx');
    expect(ctx.extras()).toMatchObject({ placeFile: 'simple-drift-game.rbxlx', cloud: { universeId: '7000000001', placeId: '70000000000001' } });
    expect(said().at(-1)).toMatch(/^Studio's window of simple-drift-game\.rbxlx now shows "arena-v2\.rbxlx"\. The team keeps working on simple-drift-game\.rbxlx/);
    expect(reopens).toBe(2);
  });

  it('follows a published place when the project has no local file of its own (a game plugged in from Roblox)', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    ctx.updateExtras({ placeFile: null });
    ctx.updateSettings({ robloxStudioMatch: 'Untitled 13' });
    core.studio.bind('Untitled 13');
    const follow = (core as unknown as { followPlace: (display: string, now: unknown, before: unknown) => void }).followPlace.bind(core);
    follow('Untitled 13 (placeId: 120000000000001)', { studio: 's2', place: 'Untitled 13', placeId: 120000000000001, gameId: 7000000002 }, { studio: 's1', place: 'Untitled 13', placeId: 0, gameId: 0 });
    expect(ctx.settings().robloxStudioMatch).toBe('Untitled 13 (placeId: 120000000000001)');
    expect(ctx.extras()).toMatchObject({ placeFile: null, cloud: { universeId: '7000000002', placeId: '120000000000001' } });
  });
});

describe('what agents and the user are told', () => {
  it('agents: the plugin’s rights when it is linked, the restriction when Studio’s own path was found to refuse, nothing when unknown', () => {
    expect(studioRightsLine(true, true)).toMatch(/^Studio code runs through Shuriken's Studio plugin: roblox_run_luau and playtest probes may create, copy and move scripts, require modules and fire events/);
    expect(studioRightsLine(true, null)).toContain('key presses and clicks go through roblox_input');
    expect(studioRightsLine(false, true)).toMatch(/^Studio runs your Luau without script capabilities \(Roblox, since 2026-10-01/);
    expect(studioRightsLine(false, true)).toContain('restarting Studio changes nothing, so don’t ask for it');
    expect(studioRightsLine(false, false)).toBe('');
    expect(studioRightsLine(false, null)).toBe('');
  });

  it('the user: one plain line for each state of the plugin', () => {
    const base: StudioLinkInfo = { available: true, enabled: true, installed: true, pluginFile: 'C:\\Users\\me\\AppData\\Local\\Roblox\\Plugins\\ShurikenLink.rbxmx', port: 47811, linked: [], calls: 0, failed: 0 };
    expect(studioLinkLine(undefined)).toBe('');
    expect(studioLinkLine({ ...base, available: false })).toBe('Not used in this run.');
    expect(studioLinkLine({ ...base, enabled: false })).toMatch(/^Off: the plugin file is removed/);
    expect(studioLinkLine({ ...base, installed: false })).toMatch(/^The plugin file could not be written \(C:\\Users\\me/);
    expect(studioLinkLine({ ...base, port: null })).toMatch(/no free port/);
    expect(studioLinkLine(base)).toMatch(/^Installed\. Not linked to this project’s place yet: a Studio window loads the plugin when it opens/);
    expect(studioLinkLine({ ...base, linked: ['Edit', 'Server', 'Client'], calls: 1234, failed: 3 })).toBe('Linked to this project’s place (Edit, Server, Client) · 1,234 calls through it, 3 with an error from the code.');
    expect(studioLinkLine({ ...base, linked: ['Edit'], calls: 12 })).toBe('Linked to this project’s place (Edit) · 12 calls through it.');
  });
});
