/**
 * Live check of Shuriken Link, the Studio plugin (roblox/link), against real Roblox Studio — no model calls:
 *
 *   E2E=link npx vitest run -c vitest.e2e.config.ts tests/e2e/link.e2e.ts
 *
 * Writes the plugin into Studio's Plugins folder (an existing ShurikenLink.rbxmx is put back afterwards), opens a
 * throwaway place in a new Studio window, and proves through the real plugin: the handshake (the plugin's own
 * SHA-256 against Node's), Luau in Edit with a plugin's rights (creates scripts, requires a module, fires an event —
 * what Studio refuses its MCP path since 2026-10-01), a first code sync with no script-tool calls, a playtest whose
 * server and client run probes through the plugin (the client's relayed by the server instance), reading a
 * script's source in the playtest, errors with their line, the sessions ending with the playtest, and a second
 * playtest that needs no probe hosts. Closes the Studio window it opened.
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

const PLACE = 'shuriken-link-e2e.rbxlx';
const FILES: Record<string, string> = {
  'src/Shared/LinkLib.luau': 'local Lib = { version = 3 }\nreturn Lib\n',
  'src/Server/LinkMain.server.luau':
    'local Lib = require(game.ReplicatedStorage.Shared.LinkLib)\nlocal remote = Instance.new("RemoteEvent")\nremote.Name = "LinkRemote"\nremote.Parent = game.ReplicatedStorage\nremote.OnServerEvent:Connect(function(_, x) workspace:SetAttribute("LinkRemoteGot", x) end)\nworkspace:SetAttribute("LinkMainRan", Lib.version)\n',
  'src/Client/LinkInput.client.luau': 'print("input")\n',
};

describe.runIf(process.env.E2E === 'link')('Shuriken Link against real Studio', () => {
  it('links a place through the plugin and runs Luau with a plugin’s rights in Edit and in a playtest', async () => {
    refuseWhileShurikenRuns();
    const plugins = studioPluginsDir();
    if (!plugins) throw new Error('Windows with Roblox Studio only.');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-link-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-link-project-'));
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
    const viaLink = () => studio.linkStats.calls;
    try {
      // The plugin file first: a Studio window loads the plugins it finds when it starts.
      await link.start();
      expect(link.status()).toMatchObject({ installed: true });
      studio.link = link;
      await studio.start();
      const place = join(projectDir, PLACE);
      writeFileSync(place, sandboxPlaceXml('Shuriken Link E2E'), 'utf8');
      closeStudio();
      const summary = core.createProject({ name: 'Link E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      const t0 = Date.now();
      await studio.openPlace(place, PLACE);
      ctx.updateSettings({ robloxStudioMatch: PLACE });
      studio.bind(PLACE);
      expect(await link.waitFor('Edit', 60_000), 'the plugin did not link (is the Plugins folder the one Studio reads?)').toBe(true);
      console.log(`linked ${Math.round((Date.now() - t0) / 100) / 10} s after asking Studio to open the place; port ${link.status().port}`);

      // What Studio's MCP path is refused, done through the plugin in Edit.
      const restricted = await studio.scriptsRestricted();
      console.log("Studio's MCP path restricted:", restricted);
      const made = await studio.runLuau(
        'local m = Instance.new("ModuleScript")\nm.Name = "LinkMade"\nm.Source = "return { n = 41 }"\nm.Parent = game.ReplicatedStorage\nlocal b = Instance.new("BindableEvent")\nlocal got\nb.Event:Connect(function(x) got = x end)\nb:Fire(1)\ntask.wait()\nreturn tostring(require(m).n + got)',
        'Edit',
      );
      console.log('edit:', JSON.stringify(made));
      expect(made).toMatchObject({ ok: true, output: '42' });
      expect(viaLink()).toBeGreaterThan(0);
      const failing = await studio.runLuau('local x = 1\nerror("boom " .. x)', 'Edit');
      expect(failing.ok).toBe(false);
      expect(failing.output).toMatch(/:2: boom 1/);
      const bad = await studio.runLuau('return +', 'Edit');
      expect(bad.ok).toBe(false);
      expect(bad.output).toMatch(/Failed to parse command code/);
      expect((await studio.runLuau('return { a = 1, list = { 1, 2 } }', 'Edit')).output).toBe('{"a":1,"list":[1,2]}');
      expect((await studio.runLuau('return string.rep("x", 250000)', 'Edit')).output.length).toBe(250000);
      // Through the agents' own tool: a runtime error still names its line, a syntax error its place.
      const agent = { kind: 'agent' as const, runId: 'run_link_e2e', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
      const said = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      const runtime = await core.tools.invoke('roblox_run_luau', { code: 'local a = 1\nlocal t = nil\nreturn t.b', datamodel: 'Edit' }, agent);
      console.log('tool runtime error:', said(runtime).slice(0, 200));
      expect(said(runtime)).toMatch(/\(line 3\)/);
      const syntax = await core.tools.invoke('roblox_run_luau', { code: 'local a = 1\nreturn a +', datamodel: 'Edit' }, agent);
      console.log('tool syntax error:', said(syntax).slice(0, 200));
      expect(syntax.isError).toBe(true);
      expect(said(syntax)).toMatch(/line 2/i);
      const fine = await core.tools.invoke('roblox_run_luau', { code: 'return require(game.ReplicatedStorage.LinkMade).n', datamodel: 'Edit' }, agent);
      expect(said(fine)).toContain('41');
      // Many small calls: the plugin answers in milliseconds.
      const t1 = Date.now();
      for (let i = 0; i < 20; i++) expect((await studio.runLuau(`return ${i}`, 'Edit')).output).toBe(String(i));
      console.log(`20 calls in ${Date.now() - t1} ms`);

      // A first push: every script created by Luau itself (no refusal, so no script-tool calls).
      for (const [f, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(projectDir, f)), { recursive: true });
        writeFileSync(join(projectDir, f), text, 'utf8');
      }
      const before = viaLink();
      const push = await core.sync.push(projectDir, ctx.extras().syncMap);
      console.log('push:', JSON.stringify({ created: push.created, errors: push.errors, ms: push.durationMs }));
      expect(push.errors.filter((e) => /Link/.test(e.path))).toEqual([]);
      for (const p of ['ReplicatedStorage/Shared/LinkLib', 'ServerScriptService/Server/LinkMain', 'StarterPlayer/StarterPlayerScripts/Client/LinkInput']) expect(push.created).toContain(p);
      expect(viaLink()).toBeGreaterThan(before);

      // A playtest: its server and client instances link, and probes run with the plugin's rights.
      await studio.setPlaying(true);
      expect(await link.waitFor('Server', 20_000), "the playtest's server did not link").toBe(true);
      const server = await studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.LinkLib)\nreturn "v" .. Lib.version .. " main=" .. tostring(workspace:GetAttribute("LinkMainRan"))', 'Server');
      console.log('server:', JSON.stringify(server));
      expect(server).toMatchObject({ ok: true, output: 'v3 main=3' });
      // The plugin may read a script's source in a playtest (the probe host could not).
      expect((await studio.runLuau('return tostring(#game.ServerScriptService.Server.LinkMain.Source > 50)', 'Server')).output).toBe('true');
      const serverError = await studio.runLuau('local Lib = require(game.ReplicatedStorage.Shared.LinkLib)\nerror("bad " .. Lib.version)', 'Server');
      expect(serverError.ok).toBe(false);
      expect(serverError.output).toMatch(/:2: bad 3/);
      expect((await studio.runLuau('return +', 'Server')).output).toMatch(/Failed to parse command code/);
      const serverTool = await core.tools.invoke('roblox_run_luau', { code: 'local Lib = require(game.ReplicatedStorage.Shared.LinkLib)\nlocal t = nil\nreturn t.b .. Lib.version', datamodel: 'Server' }, agent);
      console.log('tool runtime error (server):', said(serverTool).slice(0, 200));
      expect(said(serverTool)).toMatch(/\(line 3\)/);
      expect(await link.waitFor('Client', 30_000), "the playtest's client did not link").toBe(true);
      const client = await studio.runLuau(
        'game.ReplicatedStorage:WaitForChild("LinkRemote"):FireServer(77)\nreturn "client v" .. require(game.ReplicatedStorage.Shared.LinkLib).version .. " " .. tostring(game.Players.LocalPlayer ~= nil)',
        'Client',
      );
      console.log('client:', JSON.stringify(client));
      expect(client).toMatchObject({ ok: true, output: 'client v3 true' });
      let got = '';
      for (let i = 0; i < 20 && got !== '77'; i++) got = (await studio.runLuau('return tostring(workspace:GetAttribute("LinkRemoteGot"))', 'Server')).output;
      expect(got).toBe('77');
      expect(link.status().linked.sort()).toEqual(['Client', 'Edit', 'Server']);
      expect(link.playProven).toBe(true);

      await studio.setPlaying(false);
      expect([link.has('Server'), link.has('Client'), link.has('Edit')]).toEqual([false, false, true]);
      // The plugin has been seen in a playtest: the next one gets no probe hosts.
      await studio.setPlaying(true);
      expect(await link.waitFor('Server', 20_000)).toBe(true);
      expect((await studio.runLuau('return tostring(game:GetService("ServerScriptService"):FindFirstChild("ShurikenProbeHost") ~= nil)', 'Server')).output).toBe('false');
      await studio.setPlaying(false);
      console.log(`Luau calls through the plugin: ${studio.linkStats.calls} (${studio.linkStats.failed} failed, as the test meant)`);
    } finally {
      await studio.setPlaying(false).catch(() => undefined);
      closeStudio();
      await link.stop();
      // Studio's Plugins folder as it was.
      if (had) restorePlugin(backup, pluginFile);
      else rmSync(pluginFile, { force: true });
      await core.shutdown();
    }
  }, 420_000);
});
