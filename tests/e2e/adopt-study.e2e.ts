/**
 * Live check of plugging in a game WITH the real analyst (one Claude run, costs a little usage):
 *
 *   E2E=adopt-study STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/adopt-study.e2e.ts
 *
 * Seeds a small coin game into the scratch place (leaderstats, a coin remote that trusts the client, a
 * free-model kill brick with a require(<asset id>) backdoor, a HUD), plugs it in through Core.adoptGame
 * as the user would from "Open a game…", and waits for the director's greeting. Expects a complete study
 * that names the exploit and the backdoor. Refuses a published place. Cleans up the place.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

const SEED = `local function mk(class, name, parent, props)
  local i = Instance.new(class)
  i.Name = name
  for k, v in props or {} do i[k] = v end
  i:SetAttribute("StudyE2E", true)
  i.Parent = parent
  return i
end
local sss = game:GetService("ServerScriptService")
local rs = game:GetService("ReplicatedStorage")
local remotes = mk("Folder", "Remotes", rs)
mk("RemoteEvent", "CollectCoin", remotes)
mk("ModuleScript", "CoinConfig", rs, { Source = "return { CoinValue = 1, RespawnSeconds = 8, Coins = 12 }\\n" })
mk("Script", "Leaderstats", sss, { Source = [[
local Players = game:GetService("Players")
Players.PlayerAdded:Connect(function(player)
	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"
	stats.Parent = player
	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Parent = stats
end)
]] })
mk("Script", "CoinServer", sss, { Source = [[
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(ReplicatedStorage.CoinConfig)
local remote = ReplicatedStorage.Remotes.CollectCoin
-- The client tells us how many coins it collected.
remote.OnServerEvent:Connect(function(player, amount)
	player.leaderstats.Coins.Value += amount
end)
local folder = workspace:WaitForChild("Coins")
for i = 1, Config.Coins do
	local c = Instance.new("Part")
	c.Name = "Coin" .. i
	c.Shape = Enum.PartType.Cylinder
	c.Size = Vector3.new(0.4, 2, 2)
	c.Anchored = true
	c.CanCollide = false
	c.Position = Vector3.new(math.cos(i) * 20, 3, math.sin(i) * 20)
	c.Parent = folder
end
]] })
mk("Folder", "Coins", workspace)
local sps = game:GetService("StarterPlayer"):WaitForChild("StarterPlayerScripts")
mk("LocalScript", "CoinClient", sps, { Source = [[
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local player = Players.LocalPlayer
local remote = ReplicatedStorage.Remotes.CollectCoin
for _, coin in workspace:WaitForChild("Coins"):GetChildren() do
	coin.Touched:Connect(function(hit)
		if hit.Parent == player.Character and coin.Transparency == 0 then
			coin.Transparency = 1
			remote:FireServer(1)
			task.wait(8)
			coin.Transparency = 0
		end
	end)
end
]] })
local lava = mk("Part", "LavaBrick", workspace, { Anchored = true, Size = Vector3.new(8, 1, 8), Position = Vector3.new(0, 0.5, 30), Material = Enum.Material.Neon })
mk("Script", "Kill", lava, { Source = [[
script.Parent.Touched:Connect(function(hit)
	local h = hit.Parent:FindFirstChildOfClass("Humanoid")
	if h then h.Health = 0 end
end)
local ok = pcall(function() require(4812309182) end)
]], Enabled = false }) -- read by the analyst, never run: a playtest must not load a stranger's module
local gui = mk("ScreenGui", "CoinHUD", game:GetService("StarterGui"), { ResetOnSpawn = false })
mk("TextLabel", "CoinCount", gui, { Size = UDim2.fromOffset(200, 50), Position = UDim2.fromOffset(10, 10), Text = "Coins: 0", TextScaled = true })
return "seeded"`;

const CLEAN = `for _, d in game:GetDescendants() do
  local ok, v = pcall(function() return d:GetAttribute("StudyE2E") end)
  if ok and v and d.Parent then d:Destroy() end
end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
return "clean"`;

describe.runIf(process.env.E2E === 'adopt-study')('plugging in a game with the real analyst (live)', () => {
  it('pulls, studies and greets', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    process.env.SHURIKEN_PROJECTS_DIR = mkdtempSync(join(tmpdir(), 'shuriken-study-projects-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-study-e2e-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    core.studio.bind(match);
    const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
    if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
    if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
    try {
      await core.studio.runLuau(CLEAN, 'Edit');
      expect((await core.studio.runLuau(SEED, 'Edit')).output).toContain('seeded');
      const t0 = Date.now();
      const summary = await core.adoptGame({ studio: match });
      const ctx = core.project!;
      expect(ctx.summary.id).toBe(summary.id);
      const chat = core.director.chat()!;
      for (;;) {
        const msgs = chat.list();
        const greet = msgs.find((m) => m.role === 'director' && (m.data?.study === true || m.kind === 'error'));
        if (greet) break;
        if (Date.now() - t0 > 20 * 60_000) throw new Error('No greeting within 20 minutes');
        await new Promise((r) => setTimeout(r, 3000));
      }
      log('adopted and studied in', Math.round((Date.now() - t0) / 1000), 's');
      for (const m of chat.list()) log(`[${m.role}/${m.kind}]`, m.text.slice(0, 1500), m.data ? JSON.stringify(m.data).slice(0, 300) : '');
      const brief = readFileSync(join(ctx.dir, 'dossier.md'), 'utf8');
      log('dossier.md:\n' + brief);
      const d = JSON.parse(readFileSync(join(ctx.dir, 'dossier.json'), 'utf8')) as { complete: boolean; risks: string[]; systems: unknown[] };
      expect(d.complete).toBe(true);
      expect(d.systems.length).toBeGreaterThan(0);
      const risks = d.risks.join('\n');
      expect(risks).toMatch(/client|amount|exploit|trust/i);
      expect(risks).toMatch(/require|backdoor|4812309182/i);
      const run = core.runner.listRuns(ctx, { limit: 5 }).find((r) => r.role === 'analyst');
      log('analyst run:', JSON.stringify({ status: run?.status, cost: (run as { costUsd?: number } | undefined)?.costUsd }));
    } finally {
      core.studio.bind(match);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 30 * 60 * 1000);
});
