/**
 * Live check of the UI copilot with the real model (one turn, costs a little usage):
 *
 *   E2E=ui-copilot STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-copilot.e2e.ts
 *
 * In a throwaway project bound to the scratch place, asks the UI copilot for a sword shop that works on
 * phones with purchases checked by the server. Expects the game's code to use the Ui kit (skill
 * roblox-ui-design), the scripts synced into Studio, and — audited again here in a playtest — no
 * problems on phone, tablet or desktop. Refuses a published place. Removes what it built in the place.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';
import type { UiFinding } from '../../src/shared/ui-layout';

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');
const tester: CallerContext = { kind: 'agent', runId: 'run_uicopilot_check', taskId: null, role: 'critic', providerId: null, allowedTools: null };

function files(dir: string, root = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, root, out);
    else if (/\.luau$/.test(n)) out.push(relative(root, f).replaceAll('\\', '/'));
  }
  return out;
}

// What the default sync map puts in the place (a new project's folders).
const CLEAN = `for _, p in { {"ReplicatedStorage", "Shared"}, {"ServerScriptService", "Server"}, {"StarterPlayer", "StarterPlayerScripts", "Client"}, {"ReplicatedStorage", "Remotes"}, {"ReplicatedStorage", "ShurikenAudio"} } do
  local inst = game:GetService(p[1])
  for i = 2, #p do inst = inst and inst:FindFirstChild(p[i]) end
  if inst and inst ~= game:GetService(p[1]) then inst:Destroy() end
end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
return "clean"`;

describe.runIf(process.env.E2E === 'ui-copilot')('the UI copilot with the real model (live)', () => {
  it('builds a phone-ready shop with the UI kit, synced to Studio, with a clean audit', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-uicopilot-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-uicopilot-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    core.prefs.set({ uploadAssets: false });
    await core.studio.start();
    try {
      const summary = core.createProject({ name: 'UI Copilot E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');
      core.orchestrator.pause();

      const chat = core.copilots.chat('ui')!;
      const replies = () => chat.list().filter((m) => m.role === 'copilot');
      const t0 = Date.now();
      core.copilots.send(
        'ui',
        'Add a sword shop to my game: a Shop button that opens a window with three swords — Iron Sword 150, Golden Sword 900, Obsidian Blade 2500 coins. It has to work well on phones. Players have a Coins leaderstat (make it if the game has none, starting at 1000); the server checks every purchase. Just make it.',
        { page: 'ui' },
      );
      while (!replies().length) {
        if (Date.now() - t0 > 20 * 60_000) throw new Error('No copilot reply within 20 minutes');
        await new Promise((r) => setTimeout(r, 3000));
      }
      const reply = replies()[0]!;
      log('reply after', Math.round((Date.now() - t0) / 1000), 's:', reply.text);
      const runs = core.runner.listRuns(ctx, { limit: 5 }).filter((r) => r.role === 'copilot-ui');
      log('runs:', JSON.stringify(runs.map((r) => ({ status: r.status, cost: (r as { costUsd?: number }).costUsd, turns: (r as { turns?: number }).turns }))));
      expect(runs.every((r) => r.status === 'completed')).toBe(true);

      // The game's code uses the kit: a module with Ui.screen / Ui.window, and scripts that require it.
      const code = files(join(projectDir, 'src'));
      log('files:', code.join(', '));
      const sources = code.map((f) => readFileSync(join(projectDir, 'src', f), 'utf8'));
      expect(sources.some((s) => /function Ui\.window/.test(s) && /FitReference/.test(s))).toBe(true);
      expect(sources.some((s) => /Ui\.window\(|Ui\.screen\(/.test(s) && /require\(/.test(s))).toBe(true);
      expect(sources.some((s) => /OnServerInvoke|OnServerEvent/.test(s))).toBe(true);

      // Synced into Studio.
      const inStudio = await core.studio.runLuau(
        `local n = 0 for _, d in game:GetDescendants() do if d:IsA("LuaSourceContainer") and string.find(d.Source, "Ui.", 1, true) then n += 1 end end return tostring(n)`,
        'Edit',
      );
      log('scripts in Studio using the kit:', inStudio.output);
      expect(Number(inStudio.output.trim())).toBeGreaterThan(0);

      // Audited here in a playtest (the shop is built by a LocalScript), on phone, tablet and desktop.
      const audit = await core.tools.invoke('ui_audit', { source: 'playtest' }, tester);
      log('audit:', text(audit).split('\n')[0]);
      expect(audit.isError, text(audit)).toBeFalsy();
      const findings = (audit.data as { findings: UiFinding[] }).findings;
      log(findings.map((f) => `${f.severity} ${f.devices.join('/')} ${f.path}: ${f.message}`).join('\n') || 'no findings');
      expect(findings.filter((f) => f.severity === 'problem')).toEqual([]);
    } finally {
      await core.studio.setPlaying(false).catch(() => undefined);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 30 * 60 * 1000);
});
