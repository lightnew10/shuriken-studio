/**
 * Live check of the generated ShurikenMatch module in real Roblox Studio — no model calls:
 *
 *   E2E=match npx vitest run -c vitest.e2e.config.ts tests/e2e/match.e2e.ts
 *
 * Opens a throwaway place in a new Studio window (through Shuriken Link, like tests/e2e/link.e2e.ts: the plugin file
 * is put back afterwards), writes the module with match_setup and a game script that runs a match in Match.onStart,
 * and plays the loop the way a game is tested in Studio: the player queues from the client, a test match starts in
 * the same server with the empty place as a bot, the game finishes it, the player is back in the lobby and the
 * client's state is idle again; a second queue while queued is refused. Teleports between servers only happen once a
 * game is published, so the live path (MemoryStore, reserved servers) is not exercised here. Closes the window.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { LINK_PLUGIN_FILE } from '../../src/core/roblox/link/plugin';
import { refuseWhileShurikenRuns, restorePlugin } from './link-guard';
import { StudioLink, studioPluginsDir } from '../../src/core/roblox/link/studio-link';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';

const PLACE = 'shuriken-match-e2e.rbxlx';
const GAME = `--!strict
local Match = require(game.ReplicatedStorage.Shared.ShurikenMatch)
Match.queued:Connect(function(_player: Player, mode: string)
	workspace:SetAttribute("Queued", mode)
end)
Match.found:Connect(function(players: { Player }, info: any)
	workspace:SetAttribute("Found", info.mode .. ":" .. #players)
end)
Match.onStart(function(match: Match.MatchInfo)
	workspace:SetAttribute("MatchMode", match.mode)
	workspace:SetAttribute("MatchTest", match.test)
	workspace:SetAttribute("MatchBots", match.bots)
	workspace:SetAttribute("MatchTeams", #match.teams[1] .. "," .. #match.teams[2])
	workspace:SetAttribute("MatchRole", Match.role)
	task.delay(1.5, function()
		Match.finish(match, { winner = 1 })
	end)
end)
Match.returned:Connect(function(players: { Player }, results: any)
	workspace:SetAttribute("Returned", #players)
	workspace:SetAttribute("Winner", results and results.winner or 0)
	workspace:SetAttribute("InMatchAfter", Match.current() ~= nil)
end)
`;

describe.runIf(process.env.E2E === 'match')('ShurikenMatch in real Studio', () => {
  it('queues, plays a test match in the same server with a bot in the empty place, and comes back to the lobby', async () => {
    refuseWhileShurikenRuns();
    const plugins = studioPluginsDir();
    if (!plugins) throw new Error('Windows with Roblox Studio only.');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-match-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-match-project-'));
    const pluginFile = join(plugins, LINK_PLUGIN_FILE);
    const backup = join(dataDir, 'plugin.backup');
    const had = existsSync(pluginFile);
    if (had) copyFileSync(pluginFile, backup);
    const closeStudio = () => {
      try {
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${PLACE}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
      } catch {
        /* none open */
      }
    };
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const link = new StudioLink({ dataDir, pluginsDir: plugins, enabled: () => true, binding: () => core.studio.binding, log: core.logger.scope('link') });
    const studio = core.studio;
    const agent = { kind: 'agent' as const, runId: 'run_match_e2e', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
    const said = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    try {
      await link.start();
      studio.link = link;
      await studio.start();
      const place = join(projectDir, PLACE);
      writeFileSync(place, sandboxPlaceXml('Shuriken Match E2E'), 'utf8');
      closeStudio();
      const summary = core.createProject({ name: 'Match E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      await studio.openPlace(place, PLACE);
      ctx.updateSettings({ robloxStudioMatch: PLACE });
      studio.bind(PLACE);
      expect(await link.waitFor('Edit', 90_000), 'the plugin did not link').toBe(true);

      // The module, as an engineer sets it up, and a game script that runs a match.
      const setup = await core.tools.invoke('match_setup', { modes: [{ key: 'Duel', name: '1v1 Duel', teams: 2, teamSize: 1, ranked: true }, { key: 'Squads', name: '3v3', teams: 2, teamSize: 3, botsAfterSec: 30 }] }, agent);
      expect(setup.isError, said(setup)).toBeFalsy();
      const game = join(projectDir, 'src/Server/Game.server.luau');
      mkdirSync(dirname(game), { recursive: true });
      writeFileSync(game, GAME, 'utf8');
      const push = await core.sync.push(projectDir, ctx.extras().syncMap);
      console.log('push:', JSON.stringify({ created: push.created, errors: push.errors }));
      expect(push.errors).toEqual([]);

      await studio.setPlaying(true);
      expect(await link.waitFor('Server', 30_000), "the playtest's server did not link").toBe(true);
      expect(await link.waitFor('Client', 30_000), "the playtest's client did not link").toBe(true);
      const server = (code: string) => studio.runLuau(code, 'Server');
      const client = (code: string) => studio.runLuau(code, 'Client');

      // The client asks; the server's own module (the game script's) answers.
      const asked = await client('local Match = require(game.ReplicatedStorage.Shared.ShurikenMatch)\nMatch.queue("Duel")\ntask.wait(0.6)\nMatch.queue("Duel")\nreturn Match.currentState()');
      console.log('client asked:', JSON.stringify(asked));
      expect(asked.ok, asked.output).toBe(true);
      let state = '';
      for (let i = 0; i < 40 && !/returned=1/.test(state); i++) {
        await new Promise((r) => setTimeout(r, 250));
        const r = await server(
          'local w = workspace\nreturn string.format("queued=%s found=%s mode=%s test=%s bots=%s teams=%s role=%s returned=%s winner=%s after=%s", tostring(w:GetAttribute("Queued")), tostring(w:GetAttribute("Found")), tostring(w:GetAttribute("MatchMode")), tostring(w:GetAttribute("MatchTest")), tostring(w:GetAttribute("MatchBots")), tostring(w:GetAttribute("MatchTeams")), tostring(w:GetAttribute("MatchRole")), tostring(w:GetAttribute("Returned")), tostring(w:GetAttribute("Winner")), tostring(w:GetAttribute("InMatchAfter")))',
        );
        state = r.output;
      }
      console.log('server:', state);
      expect(state).toBe('queued=Duel found=Duel:1 mode=Duel test=true bots=1 teams=1,0 role=lobby returned=1 winner=1 after=false');
      const back = await client('return require(game.ReplicatedStorage.Shared.ShurikenMatch).currentState()');
      console.log('client after:', JSON.stringify(back));
      expect(back.output).toBe('idle');
      // The remote the module made, and nothing of the live path in Studio.
      expect((await server('return tostring(game.ReplicatedStorage:FindFirstChild("ShurikenMatchRemote") ~= nil)')).output).toBe('true');
      await studio.setPlaying(false);
    } finally {
      await studio.setPlaying(false).catch(() => undefined);
      closeStudio();
      await link.stop();
      if (had) restorePlugin(backup, pluginFile);
      else rmSync(pluginFile, { force: true });
      await core.shutdown();
    }
  }, 420_000);
});
