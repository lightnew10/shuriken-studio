/**
 * Live check that a project's code reaches Studio when Studio refuses scripts made in Luau (no model calls):
 *
 *   E2E=sync-create STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/sync-create.e2e.ts
 *
 * On 2026-10-01 Studio began running MCP code without four script capabilities: a script created in Luau can't be
 * parented anywhere, so every first push failed. The push now creates such scripts through Studio's own script
 * tool and writes their source as before. This pushes a new project (a module, a server script, a client script,
 * a module inside a script, one in a new folder), checks every source in Studio, pushes again (nothing to do),
 * changes a file (updated) and a class (replaced). It passes on a Studio that allows Luau to create scripts too.
 * Only a local scratch file (PlaceId 0). Cleans up what it made.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';

const FILES: Record<string, string> = {
  'src/Shared/SyncCreateLib.luau': 'local Lib = { version = 1 }\nreturn Lib\n',
  'src/Shared/SyncCreateKit/Deep/Leaf.luau': 'return "leaf"\n',
  'src/Server/SyncCreateMain.server.luau': 'local Lib = require(game.ReplicatedStorage.Shared.SyncCreateLib)\nworkspace:SetAttribute("SyncCreateRan", Lib.version)\n',
  'src/Client/SyncCreateInput.client.luau': 'print("input")\n',
};
const PATHS = ['ReplicatedStorage/Shared/SyncCreateLib', 'ReplicatedStorage/Shared/SyncCreateKit/Deep/Leaf', 'ServerScriptService/Server/SyncCreateMain', 'StarterPlayer/StarterPlayerScripts/Client/SyncCreateInput'];

const CLEAN = `for _, d in game:GetDescendants() do
  if string.find(d.Name, "^SyncCreate") and d.Parent then pcall(function() d:Destroy() end) end
end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
workspace:SetAttribute("SyncCreateRan", nil)
return "clean"`;

const READ = `local out = {}
for _, p in { ${PATHS.map((p) => JSON.stringify(p)).join(', ')} } do
  local inst = game
  for _, seg in string.split(p, "/") do
    local nxt = inst and inst:FindFirstChild(seg)
    if not nxt and inst == game then nxt = game:GetService(seg) end
    inst = nxt
  end
  out[p] = inst and { class = inst.ClassName, source = inst.Source } or false
end
return game:GetService("HttpService"):JSONEncode(out)`;

describe.runIf(process.env.E2E === 'sync-create')('a first push into a Studio that refuses scripts made in Luau (live)', () => {
  it('creates every script, with its source, and keeps syncing afterwards', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-synccreate-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-synccreate-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    core.studio.bind(match);
    const placeId = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
    expect(placeId.ok, placeId.output).toBe(true);
    if (placeId.output.trim() !== '0') throw new Error(`"${match}" is a published place (${placeId.output}): this test only runs on a local scratch file.`);
    try {
      await core.studio.runLuau(CLEAN, 'Edit');
      const refuses = await core.studio.runLuau('local ok, e = pcall(function() local m = Instance.new("ModuleScript") m.Parent = game.ReplicatedStorage m:Destroy() end) return ok and "allows" or tostring(e)', 'Edit');
      console.log(`Studio ${refuses.output.includes('allows') ? 'lets Luau create scripts' : `refuses: ${refuses.output.slice(0, 160)}`}`);
      const summary = core.createProject({ name: 'Sync create E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const map = ctx.extras().syncMap;
      console.log('sync map', JSON.stringify(map));
      for (const [f, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(projectDir, f)), { recursive: true });
        writeFileSync(join(projectDir, f), text, 'utf8');
      }

      const t0 = Date.now();
      const r0 = await core.sync.push(projectDir, map);
      console.log(`push 0 (${Date.now() - t0} ms):`, JSON.stringify({ created: r0.created, updated: r0.updated, classChanged: r0.classChanged, errors: r0.errors }));
      expect(r0.errors.filter((e) => /SyncCreate/.test(e.path))).toEqual([]);
      for (const p of PATHS) expect(r0.created, p).toContain(p);
      const read = JSON.parse((await core.studio.runLuau(READ, 'Edit')).output) as Record<string, { class: string; source: string } | false>;
      expect(read[PATHS[0]!]).toEqual({ class: 'ModuleScript', source: FILES['src/Shared/SyncCreateLib.luau'] });
      expect(read[PATHS[1]!]).toEqual({ class: 'ModuleScript', source: FILES['src/Shared/SyncCreateKit/Deep/Leaf.luau'] });
      expect(read[PATHS[2]!]).toEqual({ class: 'Script', source: FILES['src/Server/SyncCreateMain.server.luau'] });
      expect(read[PATHS[3]!]).toEqual({ class: 'LocalScript', source: FILES['src/Client/SyncCreateInput.client.luau'] });

      // Again: nothing to do.
      const r1 = await core.sync.push(projectDir, map);
      console.log('push 1:', JSON.stringify({ created: r1.created, updated: r1.updated, unchanged: r1.unchanged.length, errors: r1.errors }));
      expect(r1.created.filter((p) => /SyncCreate/.test(p))).toEqual([]);
      expect(r1.updated.filter((p) => /SyncCreate/.test(p))).toEqual([]);
      expect(r1.errors.filter((e) => /SyncCreate/.test(e.path))).toEqual([]);

      // A changed file is written into the script that is there.
      writeFileSync(join(projectDir, 'src/Shared/SyncCreateLib.luau'), 'local Lib = { version = 2 }\nreturn Lib\n', 'utf8');
      const r2 = await core.sync.push(projectDir, map);
      console.log('push 2:', JSON.stringify({ created: r2.created, updated: r2.updated, errors: r2.errors }));
      expect(r2.updated).toContain(PATHS[0]);
      expect(r2.errors.filter((e) => /SyncCreate/.test(e.path))).toEqual([]);

      // The game's own scripts run with everything they need: the server script requires the module in a playtest.
      await core.studio.setPlaying(true);
      let ran = '';
      for (let i = 0; i < 40 && ran !== '2'; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        ran = (await core.studio.runLuau('return tostring(workspace:GetAttribute("SyncCreateRan"))', 'Server')).output.trim();
      }
      expect(ran).toBe('2');

      // Probes that need the game's rights (require, events) run through the host; the rest run as written.
      const restricted = await core.studio.scriptsRestricted();
      console.log('restricted:', restricted);
      const req = await core.studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.SyncCreateLib)\nreturn "v" .. Lib.version', 'Server');
      console.log('server require:', JSON.stringify(req));
      expect(req).toMatchObject({ ok: true, output: 'v2' });
      const table = await core.studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.SyncCreateLib)\nreturn { version = Lib.version, list = { 1, 2 } }', 'Server');
      expect(JSON.parse(table.output)).toEqual({ version: 2, list: [1, 2] });
      const failing = await core.studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.SyncCreateLib)\nerror("boom " .. Lib.version)', 'Server');
      console.log('server error:', JSON.stringify(failing));
      expect(failing.ok).toBe(false);
      expect(failing.output).toMatch(/boom 2/);
      const bad = await core.studio.runLuau('local x = require(game.ReplicatedStorage.Shared.SyncCreateLib) return x +', 'Server');
      console.log('server syntax error:', JSON.stringify(bad));
      expect(bad.ok).toBe(false);
      const event = await core.studio.runLuau(
        'local b = Instance.new("BindableEvent")\nlocal got\nb.Event:Connect(function(x) got = x end)\nb:Fire(9)\ntask.wait()\nreturn tostring(got)',
        'Server',
      );
      expect(event).toMatchObject({ ok: true, output: '9' });
      const client = await core.studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.SyncCreateLib)\nreturn "client v" .. Lib.version .. " " .. tostring(game:GetService("Players").LocalPlayer ~= nil)', 'Client');
      console.log('client require:', JSON.stringify(client));
      expect(client).toMatchObject({ ok: true, output: 'client v2 true' });
      const big = await core.studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.SyncCreateLib)\nreturn string.rep("x", 90000)', 'Server');
      expect(big.output.length).toBe(90000);
      const plain = await core.studio.runLuau('return tostring(workspace:GetAttribute("SyncCreateRan")) .. " " .. tostring(#game:GetService("ServerScriptService"):GetChildren() > 0)', 'Server');
      expect(plain).toMatchObject({ ok: true, output: '2 true' });
      const hostsInPlay = await core.studio.runLuau('return tostring(game:GetService("ServerScriptService"):FindFirstChild("ShurikenProbeHost") ~= nil)', 'Server');
      expect(hostsInPlay.output).toBe(String(restricted));

      await core.studio.setPlaying(false);
      // The hosts are gone from the place again.
      const left = await core.studio.runLuau('local n = 0 for _, d in game:GetDescendants() do if d.Name == "ShurikenProbeHost" then n += 1 end end return tostring(n)', 'Edit');
      expect(left.output).toBe('0');
    } finally {
      await core.studio.setPlaying(false).catch(() => undefined);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown();
    }
  }, 300_000);
});
