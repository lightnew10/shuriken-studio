/**
 * Live check of plugging in a game and the drift-safe sync against real Roblox Studio (no model calls):
 *
 *   E2E=adopt STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/adopt.e2e.ts
 *
 * Seeds a small "game" into the scratch place (scripts in several services, a script with children,
 * two same-named parts, a Send-to-Studio preview), pulls it into a throwaway project, then proves the
 * sync keeps Studio's side: an edit made in Studio comes back into its file, edits on both sides merge,
 * a new script gets a file, a deleted one loses its file. Refuses to run on a published place (a real
 * game): only a local place file (PlaceId 0). Cleans up what it made.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { SyncBase } from '../../src/core/roblox/code-sync';
import { pullScripts, SURVEY_LUAU, type PlaceSurvey } from '../../src/core/projects/game-study';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

const SEED = `local function script(class, name, parent, src)
  local s = Instance.new(class)
  s.Name = name
  s.Source = src
  s.Parent = parent
  s:SetAttribute("AdoptE2E", true)
  return s
end
local function folder(class, name, parent)
  local f = Instance.new(class)
  f.Name = name
  f.Parent = parent
  f:SetAttribute("AdoptE2E", true)
  return f
end
local sss = game:GetService("ServerScriptService")
local rs = game:GetService("ReplicatedStorage")
local sps = game:GetService("StarterPlayer"):WaitForChild("StarterPlayerScripts")
local root = folder("Folder", "AdoptE2E", sss)
script("Script", "Main", root, "local Lib = require(game.ReplicatedStorage.AdoptE2ELib)\\nprint('main', Lib.version)\\nfor i = 1, 10 do\\n  print('line', i)\\nend\\n")
local lib = script("ModuleScript", "AdoptE2ELib", rs, "local Lib = { version = 1 }\\nreturn Lib\\n")
script("ModuleScript", "Util", lib, "return { add = function(a, b) return a + b end }\\n")
script("LocalScript", "AdoptE2EInput", sps, "print('input')\\n")
local lava = folder("Part", "AdoptE2ELava", workspace)
lava.Anchored = true
script("Script", "Kill", lava, "require(123456789)\\n")
for i = 1, 2 do
  local door = folder("Part", "AdoptE2EDoor", workspace)
  door.Anchored = true
  script("Script", "Open", door, "print('door " .. i .. "')\\n")
end
local preview = folder("Model", "AdoptE2EPreview", workspace)
preview:SetAttribute("ShurikenPreview", "x")
script("Script", "ShurikenPreview", preview, "print('preview')\\n")
return "seeded"`;

const CLEAN = `for _, d in game:GetDescendants() do
  local ok, v = pcall(function() return d:GetAttribute("AdoptE2E") end)
  if ok and v and d.Parent then d:Destroy() end
end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
return "clean"`;

const edit = (path: string, find: string, replace: string) => `local inst = game
for _, seg in string.split(${JSON.stringify(path)}, "/") do
  local nxt = inst:FindFirstChild(seg)
  if not nxt and inst == game then nxt = game:GetService(seg) end
  inst = nxt
end
local SES = game:GetService("ScriptEditorService")
SES:UpdateSourceAsync(inst, function(old) return (string.gsub(old, ${JSON.stringify(find)}, ${JSON.stringify(replace)})) end)
return SES:GetEditorSource(inst)`;

describe.runIf(process.env.E2E === 'adopt')('plugging in a game (live Studio)', () => {
  it('pulls a place into files and keeps Studio edits through syncs', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-adopt-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-adopt-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    core.studio.bind(match);
    const placeId = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
    expect(placeId.ok).toBe(true);
    if (placeId.output.trim() !== '0') throw new Error(`"${match}" is a published place (${placeId.output}): this test only runs on a local scratch file.`);
    try {
      await core.studio.runLuau(CLEAN, 'Edit');
      expect((await core.studio.runLuau(SEED, 'Edit')).output).toContain('seeded');
      const summary = core.createProject({ name: 'Adopt E2E', rootPath: projectDir, template: 'adopted' });
      const ctx = core.openProject(summary.id);
      // Opening a project binds its own place (none yet): link the scratch place, as plugging in does.
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);

      const t0 = Date.now();
      const pull = await pullScripts(ctx, core.studio);
      log('pull:', pull.pulled.length, 'files,', pull.skipped.length, 'skipped', `(${Date.now() - t0} ms)`);
      const mine = pull.pulled.filter((f) => /AdoptE2E/.test(f));
      expect(mine.sort()).toEqual(
        [
          'src/ReplicatedStorage/AdoptE2ELib/Util.luau',
          'src/ReplicatedStorage/AdoptE2ELib/init.luau',
          'src/ServerScriptService/AdoptE2E/Main.server.luau',
          'src/StarterPlayer/StarterPlayerScripts/AdoptE2EInput.client.luau',
          'src/Workspace/AdoptE2ELava/Kill.server.luau',
        ].sort(),
      );
      expect(pull.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(['Workspace/AdoptE2EDoor/Open']));
      expect(pull.pulled.some((f) => f.includes('AdoptE2EPreview'))).toBe(false);
      const marker = await core.studio.runLuau('return tostring(game:GetService("ServerStorage"):GetAttribute("ShurikenSync"))', 'Edit');
      expect(marker.output.trim()).toBe(new SyncBase(projectDir).marker);
      ctx.updateExtras({ syncMap: pull.syncMap, syncMode: 'shuriken' });

      // Nothing changed: the first sync writes nothing and finds no orphans.
      const r0 = await core.sync.push(projectDir, pull.syncMap);
      log('push 0:', JSON.stringify({ created: r0.created, updated: r0.updated, orphans: r0.orphans, errors: r0.errors }));
      expect(r0.created).toEqual([]);
      expect(r0.updated).toEqual([]);
      expect(r0.orphans).toEqual([]);
      expect(r0.errors).toEqual([]);

      // The user edits Main in Studio: the next sync brings it into the file and leaves Studio alone.
      const MAIN = 'ServerScriptService/AdoptE2E/Main';
      const mainFile = join(projectDir, 'src/ServerScriptService/AdoptE2E/Main.server.luau');
      await core.studio.runLuau(edit(MAIN, "print%('line', i%)", "print('user line', i)"), 'Edit');
      const r1 = await core.sync.push(projectDir, pull.syncMap);
      log('push 1:', JSON.stringify({ fromStudio: r1.fromStudio, updated: r1.updated, errors: r1.errors }));
      expect(r1.fromStudio).toEqual([MAIN]);
      expect(readFileSync(mainFile, 'utf8')).toContain("print('user line', i)");

      // Both sides change lines apart from each other: merged into the file and into Studio. (Changes on
      // the same or adjacent lines are a conflict, as in git's diff3.)
      writeFileSync(mainFile, readFileSync(mainFile, 'utf8').replace("print('main', Lib.version)", "print('main (agent)', Lib.version)"), 'utf8');
      await core.studio.runLuau(edit(MAIN, 'end\n$', "end\nprint('done')\n"), 'Edit');
      const r2 = await core.sync.push(projectDir, pull.syncMap);
      log('push 2:', JSON.stringify({ merged: r2.merged, conflicts: r2.conflicts, errors: r2.errors }));
      expect(r2.merged).toEqual([MAIN]);
      const inStudio = await core.studio.runLuau(`return game:GetService("ScriptEditorService"):GetEditorSource(game.ServerScriptService.AdoptE2E.Main)`, 'Edit');
      for (const text of [readFileSync(mainFile, 'utf8'), inStudio.output]) {
        expect(text).toContain("print('main (agent)', Lib.version)");
        expect(text).toContain("print('done')");
      }

      // A script made in Studio gets a file; one deleted there loses its (unchanged) file.
      await core.studio.runLuau(`local s = Instance.new("ModuleScript") s.Name = "Made" s.Source = "return 42" s:SetAttribute("AdoptE2E", true) s.Parent = game.ServerScriptService.AdoptE2E return "ok"`, 'Edit');
      await core.studio.runLuau('game.StarterPlayer.StarterPlayerScripts.AdoptE2EInput:Destroy() return "ok"', 'Edit');
      const r3 = await core.sync.push(projectDir, pull.syncMap);
      log('push 3:', JSON.stringify({ added: r3.added, removed: r3.removed, errors: r3.errors }));
      expect(r3.added).toEqual(['ServerScriptService/AdoptE2E/Made']);
      expect(readFileSync(join(projectDir, 'src/ServerScriptService/AdoptE2E/Made.luau'), 'utf8')).toBe('return 42');
      expect(r3.removed).toEqual(['StarterPlayer/StarterPlayerScripts/AdoptE2EInput']);
      expect(existsSync(join(projectDir, 'src/StarterPlayer/StarterPlayerScripts/AdoptE2EInput.client.luau'))).toBe(false);

      // An agent's change to a file goes into Studio as before.
      const lib = join(projectDir, 'src/ReplicatedStorage/AdoptE2ELib/init.luau');
      writeFileSync(lib, readFileSync(lib, 'utf8').replace('version = 1', 'version = 2'), 'utf8');
      const r4 = await core.sync.push(projectDir, pull.syncMap);
      expect(r4.updated).toEqual(['ReplicatedStorage/AdoptE2ELib']);
      expect((await core.studio.runLuau('return require(game.ReplicatedStorage.AdoptE2ELib).version', 'Edit')).output.trim()).toBe('2');
      expect((await core.studio.runLuau('return game.ReplicatedStorage.AdoptE2ELib.Source', 'Edit')).output).toContain('version = 2');

      const survey = await core.studio.luauJson<PlaceSurvey>(SURVEY_LUAU, 'Edit', 120_000);
      log('survey:', JSON.stringify(survey).slice(0, 600));
      expect(survey.services.ServerScriptService!.scripts).toBeGreaterThanOrEqual(2);
      expect(survey.map.some((m) => m.name === 'AdoptE2ELava')).toBe(true);
    } finally {
      core.studio.bind(match);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 10 * 60 * 1000);
});
