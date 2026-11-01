import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, hiddenToolsFor } from '../src/core/agents/roles';
import { DEFAULT_MODE, MatchSetup, checkMatchConfig, type MatchMode } from '../src/core/match/match-config';
import { MATCH_RUNTIME_VERSION, matchModule } from '../src/core/match/match-luau';
import { coreHarness } from './helpers/make-core';

/**
 * Matchmade games (1.15.2): one place, two roles. Public servers are the lobby; the generated ShurikenMatch module
 * queues players in MemoryStore, reserves private servers of the same place for the matches and sends them back.
 * In Studio a queue starts a test match in the same server. The Luau itself is checked with selene and luau-lsp.
 */
const mode = (over: Partial<MatchMode> = {}): MatchMode => ({ key: 'Duel', name: '1v1 Duel', teams: 2, teamSize: 1, ...DEFAULT_MODE, ...over });
const config = (modes: MatchMode[]) => ({ modes, startTimeoutSec: 30, rejoin: true, updatedAt: '' });

describe('the match setup', () => {
  it('takes modes a matchmaker can fill, and refuses the rest', () => {
    expect(checkMatchConfig(config([mode(), mode({ key: 'Squads', name: '3v3', teamSize: 3 })])).errors).toEqual([]);
    expect(checkMatchConfig(config([])).errors.join()).toMatch(/at least one mode/);
    expect(checkMatchConfig(config([mode({ key: 'duel' })])).errors.join()).toMatch(/PascalCase/);
    expect(checkMatchConfig(config([mode(), mode()])).errors.join()).toMatch(/share this key/);
    expect(checkMatchConfig(config([mode({ teams: 10, teamSize: 10 })])).errors.join()).toMatch(/100 players in a match/);
    expect(checkMatchConfig(config([mode({ botsAfterSec: 2 })])).errors.join()).toMatch(/botsAfterSec is 5-900/);
    expect(checkMatchConfig({ ...config([mode()]), startTimeoutSec: 5 }).errors.join()).toMatch(/startTimeoutSec/);
    expect(checkMatchConfig(config([mode({ teams: 1, teamSize: 1 })])).warnings.join()).toMatch(/a match of one player/);
    expect(checkMatchConfig(config([mode({ ratingWindow: 50 })])).warnings.join()).toMatch(/isn't ranked does nothing/);
  });

  it('writes a module that tells lobby from match by the reserved server, and keeps the match in MemoryStore', () => {
    const src = matchModule(config([mode({ ranked: true }), mode({ key: 'Squads', name: '3v3', teamSize: 3, botsAfterSec: 45 })]));
    expect(src.startsWith(`--!strict\n-- ShurikenMatch v${MATCH_RUNTIME_VERSION} `)).toBe(true);
    expect(src).toContain('["Duel"] = { key = "Duel", name = "1v1 Duel", teams = 2, teamSize = 1, ranked = true,');
    expect(src).toContain('botsAfterSec = 45 } :: Mode');
    expect(src).toContain('botsAfterSec = nil } :: Mode');
    expect(src).toContain('return game.PrivateServerId ~= "" and game.PrivateServerOwnerId == 0');
    // Private servers of this same place, and the match read from MemoryStore, never from what a client could send.
    expect(src).toContain('TeleportService:ReserveServerAsync(game.PlaceId)');
    expect(src).toContain('matches():GetAsync("m" .. mid)');
    expect(src).toContain('MemoryStoreService:GetSortedMap("ShurikenQueue_" .. mode .. "_" .. PLATFORM)');
    // A lost match message is caught up with from MemoryStore; a teleport that fails after it started is tried again.
    expect(src).toContain('(rec.at or 0) >= e.since');
    expect(src).toContain('TeleportService.TeleportInitFailed:Connect(');
    // One matchmaker at a time, by a lock that runs out when its server goes.
    expect(src).toMatch(/UpdateAsync\("leader"/);
    // In Studio a queue makes a test match in the same server.
    expect(src).toContain('task.delay(STUDIO_GATHER, studioGather, modeKey)');
  });
});

describe('the tools', () => {
  const makeCore = coreHarness();
  it('match_setup writes the module with the shared code, and match_get reads it back', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const agent = { kind: 'agent' as const, runId: 'run_m', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
    const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');
    const bad = await core.tools.invoke('match_setup', { modes: [{ key: 'duel', name: 'Duel', teams: 2, teamSize: 1 }] }, agent);
    expect(bad.isError).toBe(true);
    const made = await core.tools.invoke('match_setup', { modes: [{ key: 'Duel', name: '1v1 Duel', teams: 2, teamSize: 1, ranked: true }, { key: 'Brawl', name: 'Free for all', teams: 6, teamSize: 1, botsAfterSec: 30 }] }, agent);
    expect(made.isError, text(made)).toBeFalsy();
    expect(text(made)).toMatch(/src\/Shared\/ShurikenMatch\.luau written: Duel \(1v1 Duel: 2 teams of 1, ranked\); Brawl \(Free for all: 6 teams of 1, bots after 30 s\)/);
    const file = join(ctx.root, 'src/Shared/ShurikenMatch.luau');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('["Brawl"] = { key = "Brawl"');
    const got = await core.tools.invoke('match_get', {}, agent);
    expect(text(got)).toContain('"require": "game.ReplicatedStorage.Shared.ShurikenMatch"');
    expect(new MatchSetup(ctx.root).moduleStale()).toBe(false);
  });

  it('is the gameplay engineer\'s to set up, and everyone may read it', () => {
    expect(hiddenToolsFor(ROLES['roblox-engineer']!)?.has('match_setup')).toBe(false);
    expect(hiddenToolsFor(ROLES['ui-engineer']!)?.has('match_setup')).toBe(true);
    expect(hiddenToolsFor(ROLES['ui-engineer']!)?.has('match_get')).toBe(false);
  });
});
