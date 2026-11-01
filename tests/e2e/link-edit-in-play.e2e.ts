/**
 * Live measurement, against real Roblox Studio, of what Shuriken Link's Edit session can do WHILE a playtest runs
 * (no model calls):
 *
 *   E2E=link-play npx vitest run -c vitest.e2e.config.ts tests/e2e/link-edit-in-play.e2e.ts
 *
 * Studio's MCP server refuses Edit work in play mode ("Edit datamodel is not available in Play mode"), which is why
 * every agent's Edit work waits behind every playtest. The plugin's Edit instance keeps running during a playtest,
 * so this asks it directly: does Luau run in the Edit DataModel during play, do script and instance changes made
 * there stay out of the running game, are they still there when play stops, and does the next playtest have them?
 * Same set-up as link.e2e.ts: its own plugin file (the existing one is put back), a throwaway place in a new Studio
 * window, which it closes.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { LINK_PLUGIN_FILE } from '../../src/core/roblox/link/plugin';
import { refuseWhileShurikenRuns, restorePlugin } from './link-guard';
import { StudioLink, studioPluginsDir } from '../../src/core/roblox/link/studio-link';
import { withStudioCaller } from '../../src/core/roblox/studio-context';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';

const PLACE = 'shuriken-link-play-e2e.rbxlx';

describe.runIf(process.env.E2E === 'link-play')('Edit work through the plugin during a playtest', () => {
  it('measures what the Edit session does while Studio plays', async () => {
    refuseWhileShurikenRuns();
    const plugins = studioPluginsDir();
    if (!plugins) throw new Error('Windows with Roblox Studio only.');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-linkplay-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-linkplay-project-'));
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
    /** Straight to the plugin's Edit instance, past the adapter's "Edit waits for play to end". */
    const edit = async (code: string) => {
      const t0 = Date.now();
      const running = link.run('Edit', code, 30_000);
      if (!running) return { ok: false, text: 'no Edit session', ms: 0 };
      const r = await running;
      return { ok: r.ok, text: r.text, ms: Date.now() - t0 };
    };
    const findings: Record<string, unknown> = {};
    try {
      await link.start();
      studio.link = link;
      await studio.start();
      const place = join(projectDir, PLACE);
      writeFileSync(place, sandboxPlaceXml('Shuriken Link Play E2E'), 'utf8');
      closeStudio();
      const summary = core.createProject({ name: 'Link Play E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      await studio.openPlace(place, PLACE);
      ctx.updateSettings({ robloxStudioMatch: PLACE });
      studio.bind(PLACE);
      expect(await link.waitFor('Edit', 60_000), 'the plugin did not link').toBe(true);

      // Before play: a script the game runs, and a module it requires.
      const seeded = await edit(
        'local m = Instance.new("ModuleScript")\nm.Name = "PlayLib"\nm.Source = "return { v = 1 }"\nm.Parent = game.ReplicatedStorage\n' +
          'local s = Instance.new("Script")\ns.Name = "PlayMain"\ns.Source = "workspace:SetAttribute(\\"LibV\\", require(game.ReplicatedStorage.PlayLib).v)"\ns.Parent = game.ServerScriptService\nreturn "seeded"',
      );
      expect(seeded).toMatchObject({ ok: true, text: 'seeded' });

      // The playtest belongs to another agent, as in a build.
      expect(core.lease.tryAcquire('run_other')).toBe(true);
      await studio.setPlaying(true);
      expect(await link.waitFor('Server', 20_000), "the playtest's server did not link").toBe(true);
      findings.editLinkedDuringPlay = link.has('Edit');

      // 1. Does Luau run in the Edit DataModel while Studio plays?
      const alive = await edit('return "edit alive, running=" .. tostring(game:GetService("RunService"):IsRunning()) .. " edit=" .. tostring(game:GetService("RunService"):IsEdit())');
      findings.luauInEditDuringPlay = alive;

      // 2. Changes in Edit during play: a script's source, a new script, a new part, a property.
      const changed = await edit(
        'local out = {}\n' +
          'local ok1, e1 = pcall(function() game.ReplicatedStorage.PlayLib.Source = "return { v = 2 }" end)\nout.setSource = ok1 and "ok" or tostring(e1)\n' +
          'local ok2, e2 = pcall(function() local m = Instance.new("ModuleScript") m.Name = "MadeInPlay" m.Source = "return 7" m.Parent = game.ReplicatedStorage end)\nout.newScript = ok2 and "ok" or tostring(e2)\n' +
          'local ok3, e3 = pcall(function() local p = Instance.new("Part") p.Name = "MadeInPlayPart" p.Anchored = true p.Parent = workspace end)\nout.newPart = ok3 and "ok" or tostring(e3)\n' +
          'local ok4, e4 = pcall(function() game:GetService("ScriptEditorService"):UpdateSourceAsync(game.ServerScriptService.PlayMain, function(old) return old .. "\\n-- edited in play" end) end)\nout.updateSourceAsync = ok4 and "ok" or tostring(e4)\n' +
          'local ok5, e5 = pcall(function() game:GetService("Lighting").ClockTime = 3 end)\nout.property = ok5 and "ok" or tostring(e5)\n' +
          'return out',
      );
      findings.changesInEditDuringPlay = changed;
      const readBack = await edit('return { lib = game.ReplicatedStorage.PlayLib.Source, made = game.ReplicatedStorage:FindFirstChild("MadeInPlay") ~= nil, part = workspace:FindFirstChild("MadeInPlayPart") ~= nil, main = game.ServerScriptService.PlayMain.Source, clock = game:GetService("Lighting").ClockTime }');
      findings.editReadBackDuringPlay = readBack;

      // 3. The running game is the copy made when play started: untouched by those changes.
      const game = await studio.runLuau(
        'return game:GetService("HttpService"):JSONEncode({ libV = workspace:GetAttribute("LibV"), made = game.ReplicatedStorage:FindFirstChild("MadeInPlay") ~= nil, part = workspace:FindFirstChild("MadeInPlayPart") ~= nil, clock = game:GetService("Lighting").ClockTime })',
        'Server',
      );
      findings.runningGameDuringPlay = game.output;

      // 4. Speed of Edit calls during play.
      const t1 = Date.now();
      for (let i = 0; i < 20; i++) await edit(`return ${i}`);
      findings.twentyEditCallsDuringPlayMs = Date.now() - t1;

      // 5. Studio's own MCP path, for the record.
      const mcp = await studio.call('execute_luau', { code: 'return 1', datamodel_type: 'Edit' }, { mcpOnly: true, timeoutMs: 15_000 });
      findings.mcpEditDuringPlay = mcp.ok ? 'ok' : mcp.error;

      // 5b. The app's own way in, as an agent's tools go while another agent plays: a code sync and Edit Luau.
      const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
      mkdirSync(join(projectDir, 'src', 'Server'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'Server', 'DuringPlay.server.luau'), 'workspace:SetAttribute("PushedDuringPlay", true)\n', 'utf8');
      const tp = Date.now();
      const push = await withStudioCaller({ owner: 'run_me', kind: 'agent' }, () => core.sync.push(projectDir, ctx.extras().syncMap));
      findings.syncDuringPlay = { created: push.created, errors: push.errors, busy: (push as { busy?: unknown }).busy ?? null, ms: Date.now() - tp };
      expect(push.errors).toEqual([]);
      expect(push.created).toContain('ServerScriptService/Server/DuringPlay');
      const tl = Date.now();
      const tool = await core.tools.invoke('roblox_run_luau', { code: 'return tostring(game.ServerScriptService.Server:FindFirstChild("DuringPlay") ~= nil)', datamodel: 'Edit' }, agent);
      findings.toolLuauDuringPlay = { text: tool.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').slice(0, 200), ms: Date.now() - tl };
      expect(tool.isError).toBeFalsy();
      expect(String((findings.toolLuauDuringPlay as { text: string }).text)).toContain('true');
      findings.stillPlaying = (await studio.state()).mode;

      await studio.setPlaying(false);
      core.lease.release('run_other');
      // 6. After play: are the Edit changes still there?
      const after = await edit('return { lib = game.ReplicatedStorage.PlayLib.Source, made = game.ReplicatedStorage:FindFirstChild("MadeInPlay") ~= nil, part = workspace:FindFirstChild("MadeInPlayPart") ~= nil, main = game.ServerScriptService.PlayMain.Source, clock = game:GetService("Lighting").ClockTime }');
      findings.editAfterPlay = after;

      // 7. The next playtest runs what was edited during the last one.
      await studio.setPlaying(true);
      expect(await link.waitFor('Server', 20_000)).toBe(true);
      let next = '';
      for (let i = 0; i < 20 && !/"libV":2/.test(next); i++) next = (await studio.runLuau('return game:GetService("HttpService"):JSONEncode({ libV = workspace:GetAttribute("LibV"), made = game.ReplicatedStorage:FindFirstChild("MadeInPlay") ~= nil, part = workspace:FindFirstChild("MadeInPlayPart") ~= nil, pushed = workspace:GetAttribute("PushedDuringPlay") == true })', 'Server')).output;
      expect(next).toMatch(/"pushed":true/);
      findings.nextPlaytest = next;
      await studio.setPlaying(false);
    } finally {
      console.log('FINDINGS ' + JSON.stringify(findings, null, 1));
      if (process.env.FINDINGS_OUT) writeFileSync(process.env.FINDINGS_OUT, JSON.stringify(findings, null, 1), 'utf8');
      await studio.setPlaying(false).catch(() => undefined);
      closeStudio();
      await link.stop();
      if (had) restorePlugin(backup, pluginFile);
      else rmSync(pluginFile, { force: true });
      await core.shutdown();
    }
  }, 420_000);
});
