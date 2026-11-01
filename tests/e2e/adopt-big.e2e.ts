/**
 * Live stress check of plugging in a game the size of a real one (no model calls):
 *
 *   E2E=adopt-big STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/adopt-big.e2e.ts
 *
 * Seeds about 420 scripts into the scratch place (every code service, nested folders, NPC scripts in
 * Workspace models, three modules of 6,000 lines, names with spaces, dots and accents, a duplicate
 * pair, a client-context Script), pulls them with the adoption code, and checks that a sync right after
 * finds every pulled script identical to Studio (no false edits), that an edit to a long script goes
 * back to Studio exactly, and how long it all takes. Refuses a published place. Cleans up.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { pullScripts } from '../../src/core/projects/game-study';

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

const SEED = `local function body(tag, lines)
  local t = table.create(lines)
  for i = 1, lines do
    t[i] = string.format("local v%d = %d -- %s line %d: string.format('%%s', \\"quoted\\") \\\\ back", i, i * 7, tag, i)
  end
  return table.concat(t, "\\n")
end
local n = 0
local SES = game:GetService("ScriptEditorService")
local function script(class, name, parent, lines)
  local s = Instance.new(class)
  s.Name = name
  -- Script.Source takes under 200,000 characters; the script editor takes more (as the sync writes).
  local src = body(name, lines)
  SES:UpdateSourceAsync(s, function() return src end)
  s:SetAttribute("AdoptBigE2E", true)
  s.Parent = parent
  n += 1
  return s
end
local function folder(name, parent, class)
  local f = Instance.new(class or "Folder")
  f.Name = name
  f:SetAttribute("AdoptBigE2E", true)
  f.Parent = parent
  return f
end
local sss = game:GetService("ServerScriptService")
local rs = game:GetService("ReplicatedStorage")
local ss = game:GetService("ServerStorage")
local sps = game:GetService("StarterPlayer"):WaitForChild("StarterPlayerScripts")
local sg = game:GetService("StarterGui")
local root = folder("BigGameServer", sss)
for f = 1, 15 do
  local d = folder("Systems" .. f, root)
  for i = 1, 10 do script("Script", "Service" .. f .. "_" .. i, d, 120) end
end
local shared = folder("BigGameShared", rs)
for a = 1, 5 do
  local d1 = folder("Area" .. a, shared)
  for b = 1, 4 do
    local d2 = folder("Zone" .. b, d1)
    local d3 = folder("Deep", d2)
    for i = 1, 6 do script("ModuleScript", "Module" .. i, if i % 2 == 0 then d3 else d2, 150) end
  end
end
for i = 1, 3 do script("ModuleScript", "Huge" .. i, shared, 6000) end
local client = folder("BigGameClient", sps)
for i = 1, 60 do script("LocalScript", "Client" .. i, client, 90) end
for i = 1, 20 do
  local gui = folder("BigGameGui" .. i, sg, "ScreenGui")
  script("LocalScript", "Controller", gui, 80)
end
local npcs = folder("BigGameNPCs", workspace)
for i = 1, 40 do
  local m = folder("NPC" .. i, npcs, "Model")
  script("Script", "Brain", m, 100)
end
local store = folder("BigGameStore", ss)
for i = 1, 30 do script("ModuleScript", "Data" .. i, store, 110) end
local odd = folder("BigGameOdd", sss)
script("Script", "Weapon Handler", odd, 40)
script("ModuleScript", "Data.Store", odd, 40)
script("ModuleScript", "Ünïcode Modül", odd, 40)
script("Script", "Twin", odd, 10)
script("Script", "Twin", odd, 12)
local clientCtx = script("Script", "ClientContext", odd, 30)
clientCtx.RunContext = Enum.RunContext.Client
return "seeded " .. n`;

const CLEAN = `for _, d in game:GetDescendants() do
  local ok, v = pcall(function() return d:GetAttribute("AdoptBigE2E") end)
  if ok and v and d.Parent and not d.Parent:GetAttribute("AdoptBigE2E") then d:Destroy() end
end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
return "clean"`;

describe.runIf(process.env.E2E === 'adopt-big')('plugging in a big game (live)', () => {
  it('pulls ~420 scripts exactly and syncs without false edits', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-adoptbig-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-adoptbig-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    core.studio.bind(match);
    const placeId = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
    if (placeId.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
    try {
      await core.studio.runLuau(CLEAN, 'Edit');
      const seeded = await core.studio.runLuau(SEED, 'Edit', 120_000);
      log(seeded.output);
      expect(seeded.output).toMatch(/seeded \d+/);
      const total = Number(/seeded (\d+)/.exec(seeded.output)![1]);
      const summary = core.createProject({ name: 'Adopt Big E2E', rootPath: projectDir, template: 'adopted' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);

      const t0 = Date.now();
      const pull = await pullScripts(ctx, core.studio);
      const pullMs = Date.now() - t0;
      const mine = pull.pulled.filter((f) => /BigGame|Huge/.test(f));
      const skippedMine = pull.skipped.filter((s) => /BigGame/.test(s.path));
      log(`pull: ${mine.length} of ${total} seeded scripts in ${pullMs} ms; skipped: ${JSON.stringify(skippedMine)}`);
      // Everything but the duplicate pair (an ambiguous path can't be a file).
      expect(skippedMine.map((s) => s.path).sort()).toEqual(['ServerScriptService/BigGameOdd/Twin', 'ServerScriptService/BigGameOdd/Twin']);
      expect(mine.length).toBe(total - 2);
      expect(mine).toEqual(expect.arrayContaining(['src/ServerScriptService/BigGameOdd/Weapon Handler.server.luau', 'src/ServerScriptService/BigGameOdd/Data.Store.luau', 'src/ServerScriptService/BigGameOdd/Ünïcode Modül.luau', 'src/ServerScriptService/BigGameOdd/ClientContext.server.luau']));
      const huge = readFileSync(join(projectDir, 'src/ReplicatedStorage/BigGameShared/Huge2.luau'), 'utf8');
      expect(huge.split('\n')).toHaveLength(6000);
      expect(huge).toContain(`local v6000 = 42000 -- Huge2 line 6000: string.format('%s', "quoted") \\ back`);
      ctx.updateExtras({ syncMap: pull.syncMap, syncMode: 'shuriken' });

      // A sync straight after finds every script identical to Studio: nothing written either way.
      const t1 = Date.now();
      const r0 = await core.sync.push(projectDir, pull.syncMap);
      const pushMs = Date.now() - t1;
      log(`no-op sync in ${pushMs} ms: ${r0.unchanged.length} unchanged, ${JSON.stringify({ created: r0.created.length, updated: r0.updated.length, fromStudio: r0.fromStudio.length, conflicts: r0.conflicts.length, errors: r0.errors.slice(0, 3) })}`);
      expect(r0.errors).toEqual([]);
      expect(r0.created).toEqual([]);
      expect(r0.updated).toEqual([]);
      expect(r0.fromStudio).toEqual([]);
      expect(r0.conflicts).toEqual([]);

      // An edit at the end of a 6,000-line module goes to Studio exactly; the client-context Script keeps its RunContext.
      const hugeFile = join(projectDir, 'src/ReplicatedStorage/BigGameShared/Huge2.luau');
      writeFileSync(hugeFile, `${huge}\nreturn "edited by the team"`, 'utf8');
      writeFileSync(join(projectDir, 'src/ServerScriptService/BigGameOdd/ClientContext.server.luau'), 'print("client context")', 'utf8');
      const r1 = await core.sync.push(projectDir, pull.syncMap);
      log(`edit sync: ${JSON.stringify({ updated: r1.updated, errors: r1.errors })}`);
      expect(r1.errors).toEqual([]);
      expect(r1.updated.sort()).toEqual(['ReplicatedStorage/BigGameShared/Huge2', 'ServerScriptService/BigGameOdd/ClientContext'].sort());
      const check = await core.studio.runLuau(
        `local h = game:GetService("ReplicatedStorage").BigGameShared.Huge2
local c = game:GetService("ServerScriptService").BigGameOdd.ClientContext
local src = game:GetService("ScriptEditorService"):GetEditorSource(h)
return #string.split(src, "\\n") .. "|" .. string.sub(src, -27) .. "|" .. c.RunContext.Name`,
        'Edit',
      );
      log(`studio after: ${check.output}`);
      expect(check.output.trim()).toBe('6001|return "edited by the team"|Client');
    } finally {
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 20 * 60 * 1000);
});
