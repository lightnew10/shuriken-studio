/**
 * Live check of skill roblox-onboarding's Guide module in real Roblox Studio — no model calls:
 *
 *   E2E=guide npx vitest run -c vitest.e2e.config.ts tests/e2e/guide.e2e.ts
 *
 * A throwaway place in a new Studio window (through Shuriken Link; the plugin file is put back afterwards). In a
 * playtest's client: a tour whose first step spotlights a button in a ScreenGui under Roblox's top bar. The ring and the
 * hole in the dim must sit on the button (measured), clicks outside are taken by the dim, the step advances when it is
 * done, a message step follows, and the overlay is gone at the end; a second tour is skipped. Closes the window.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { LINK_PLUGIN_FILE } from '../../src/core/roblox/link/plugin';
import { refuseWhileShurikenRuns, restorePlugin } from './link-guard';
import { StudioLink, studioPluginsDir } from '../../src/core/roblox/link/studio-link';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';

const PLACE = 'shuriken-guide-e2e.rbxlx';
// The module exactly as the skill gives it (its first Luau block).
const GUIDE = [...readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', 'roblox-onboarding', 'SKILL.md'), 'utf8').matchAll(/```lua\n([\s\S]*?)```/g)].map((m) => m[1]!)[0]!;

describe.runIf(process.env.E2E === 'guide')('the Guide in real Studio', () => {
  it('spotlights a button exactly, takes the clicks outside it, advances and cleans up; Skip ends a tour', async () => {
    refuseWhileShurikenRuns();
    const plugins = studioPluginsDir();
    if (!plugins) throw new Error('Windows with Roblox Studio only.');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-guide-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-guide-project-'));
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
    try {
      await link.start();
      studio.link = link;
      await studio.start();
      const place = join(projectDir, PLACE);
      writeFileSync(place, sandboxPlaceXml('Shuriken Guide E2E'), 'utf8');
      closeStudio();
      const summary = core.createProject({ name: 'Guide E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      await studio.openPlace(place, PLACE);
      ctx.updateSettings({ robloxStudioMatch: PLACE });
      studio.bind(PLACE);
      expect(await link.waitFor('Edit', 90_000), 'the plugin did not link').toBe(true);
      const file = join(projectDir, 'src/Shared/Guide.luau');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, GUIDE, 'utf8');
      const push = await core.sync.push(projectDir, ctx.extras().syncMap);
      expect(push.errors).toEqual([]);
      await studio.setPlaying(true);
      expect(await link.waitFor('Client', 40_000), "the playtest's client did not link").toBe(true);
      const client = (code: string) => studio.runLuau(code, 'Client');
      const start = await client(`local Guide = require(game.ReplicatedStorage.Shared.Guide)
local pg = game.Players.LocalPlayer:WaitForChild("PlayerGui")
local sg = Instance.new("ScreenGui")
sg.Name = "TestUI"
sg.Parent = pg
local b = Instance.new("TextButton")
b.Size = UDim2.fromOffset(200, 60)
b.Position = UDim2.fromOffset(300, 200)
b.Parent = sg
local tour = Guide.new()
tour:step({ target = b, text = "Press it", waitFor = function(done) _G.GuideNext = done end })
tour:step({ text = "Well done", seconds = 0.6 })
_G.GuideResult = "running"
task.spawn(function()
	_G.GuideResult = tostring(tour:run())
end)
task.wait(0.5)
local g = pg:FindFirstChild("ShurikenGuide")
local ring = g:FindFirstChild("Ring")
local top = g:FindFirstChild("DimTop")
local left = g:FindFirstChild("DimLeft")
-- AbsolutePosition is one space for every ScreenGui, whatever its insets (the overlay itself sits at 0, -58 in it).
return string.format("ring=%d,%d,%d,%d button=%d,%d,%d,%d dimTopBottom=%d leftRight=%d active=%s hint=%s", ring.AbsolutePosition.X, ring.AbsolutePosition.Y, ring.AbsoluteSize.X, ring.AbsoluteSize.Y, b.AbsolutePosition.X, b.AbsolutePosition.Y, b.AbsoluteSize.X, b.AbsoluteSize.Y, top.AbsolutePosition.Y + top.AbsoluteSize.Y, left.AbsolutePosition.X + left.AbsoluteSize.X, tostring(top.Active), g.Hint.Text)`);
      console.log('spotlight:', JSON.stringify(start));
      expect(start.ok, start.output).toBe(true);
      const m = /ring=(\d+),(\d+),(\d+),(\d+) button=(\d+),(\d+),(\d+),(\d+) dimTopBottom=(\d+) leftRight=(\d+) active=(\w+) hint=(.*)/.exec(start.output)!;
      const [rx, ry, rw, rh, bx, by, bw, bh, dimTop, dimLeft] = m.slice(1, 11).map(Number);
      // The ring is the button with an 8 px margin on every side; the dim stops where the ring begins.
      expect([rx, ry, rw, rh]).toEqual([bx! - 8, by! - 8, bw! + 16, bh! + 16]);
      expect(dimTop).toBe(ry);
      expect(dimLeft).toBe(rx);
      expect(m[11]).toBe('true');
      expect(m[12]).toBe('Press it');
      const done = await client('_G.GuideNext()\ntask.wait(1.2)\nlocal pg = game.Players.LocalPlayer.PlayerGui\nreturn _G.GuideResult .. " overlay=" .. tostring(pg:FindFirstChild("ShurikenGuide") ~= nil)');
      console.log('after:', JSON.stringify(done));
      expect(done.output).toBe('true overlay=false');
      const skipped = await client(`local Guide = require(game.ReplicatedStorage.Shared.Guide)
local tour = Guide.new({ onSkip = function() _G.Skipped = true end })
tour:step({ text = "Never ends", waitFor = function() end })
local result = "running"
task.spawn(function()
	result = tostring(tour:run())
end)
task.wait(0.3)
tour:skip()
task.wait(0.3)
return result .. " skipped=" .. tostring(_G.Skipped) .. " overlay=" .. tostring(game.Players.LocalPlayer.PlayerGui:FindFirstChild("ShurikenGuide") ~= nil)`);
      console.log('skip:', JSON.stringify(skipped));
      expect(skipped.output).toBe('false skipped=true overlay=false');
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
