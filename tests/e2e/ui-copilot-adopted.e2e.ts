/**
 * Live check of the UI copilot on a plugged-in game (one turn with the real model, costs a little usage):
 *
 *   E2E=ui-copilot-adopted STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-copilot-adopted.e2e.ts
 *
 * Seeds the small coin game from tests/e2e/adopt-study.e2e.ts (its HUD is one static "Coins: 0" label in
 * StarterGui), plugs it in the way adoption does (scripts pulled into the adopted folder layout, no
 * analyst run), and asks the UI copilot for a live, phone-ready coin counter. Expects its new code in
 * folders the adopted sync map covers (so it reaches Studio), the counter following the Coins
 * leaderstat, and a clean audit. Refuses a published place. Cleans up.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';
import { pullScripts } from '../../src/core/projects/game-study';
import type { UiFinding } from '../../src/shared/ui-layout';

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');
const tester: CallerContext = { kind: 'agent', runId: 'run_uiadopted_check', taskId: null, role: 'critic', providerId: null, allowedTools: null };

const study = readFileSync(resolve(__dirname, 'adopt-study.e2e.ts'), 'utf8');
// The fixture's source text as its template literals evaluate (a doubled backslash is one).
const literal = (raw: string) => raw.replace(/\\\\/g, '\\');
const SEED = literal(/const SEED = `([\s\S]*?)`;/.exec(study)![1]!);
const CLEAN_STUDY = literal(/const CLEAN = `([\s\S]*?)`;/.exec(study)![1]!);

function files(dir: string, root = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, root, out);
    else if (/\.luau$/.test(n)) out.push(relative(root, f).replaceAll('\\', '/'));
  }
  return out;
}

describe.runIf(process.env.E2E === 'ui-copilot-adopted')('the UI copilot on a plugged-in game (live)', () => {
  it("rebuilds the game's coin counter with its code where the game's sync reaches", async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-uiadopted-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-uiadopted-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    core.prefs.set({ uploadAssets: false });
    await core.studio.start();
    core.studio.bind(match);
    const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
    if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
    let before: string[] = [];
    try {
      await core.studio.runLuau(CLEAN_STUDY, 'Edit');
      expect((await core.studio.runLuau(SEED, 'Edit')).output).toContain('seeded');
      // Everything in the place now, so the copilot's additions can be told apart and removed.
      before = JSON.parse((await core.studio.runLuau(`local out = {} for _, d in game:GetDescendants() do if d:IsA("LuaSourceContainer") or d:IsA("ScreenGui") then table.insert(out, d:GetFullName()) end end return game:GetService("HttpService"):JSONEncode(out)`, 'Edit')).output.trim()) as string[];

      const summary = core.createProject({ name: 'Coin Game', rootPath: projectDir, template: 'adopted' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pull = await pullScripts(ctx, core.studio);
      ctx.updateExtras({ syncMap: pull.syncMap, syncMode: 'shuriken', adopted: { from: 'studio', place: match, placeId: null, at: new Date().toISOString(), pulled: pull.pulled.length } });
      log('pulled', pull.pulled.length, 'scripts; sync map', JSON.stringify(pull.syncMap));
      core.orchestrator.pause();

      const chat = core.copilots.chat('ui')!;
      const replies = () => chat.list().filter((m) => m.role === 'copilot');
      const t0 = Date.now();
      core.copilots.send('ui', 'The coin counter in my game is just a plain label that never changes. Make it look great, update live with the Coins leaderstat, and work on phones. Just make it.', { page: 'ui' });
      while (!replies().length) {
        if (Date.now() - t0 > 20 * 60_000) throw new Error('No copilot reply within 20 minutes');
        await new Promise((r) => setTimeout(r, 3000));
      }
      log('reply after', Math.round((Date.now() - t0) / 1000), 's:', replies()[0]!.text);
      const runs = core.runner.listRuns(ctx, { limit: 5 }).filter((r) => r.role === 'copilot-ui');
      log('runs:', JSON.stringify(runs.map((r) => ({ status: r.status, cost: (r as { costUsd?: number }).costUsd }))));
      expect(runs.every((r) => r.status === 'completed')).toBe(true);

      // Its code lives where the adopted sync map reaches, and reached Studio.
      const all = files(join(projectDir, 'src'));
      const mapped = (f: string) => Object.keys(pull.syncMap).some((dir) => `src/${f}`.startsWith(`${dir}/`));
      log('files:', all.join(', '));
      expect(all.filter((f) => !mapped(f))).toEqual([]);
      const added = JSON.parse((await core.studio.runLuau(`local out = {} for _, d in game:GetDescendants() do if d:IsA("LuaSourceContainer") then table.insert(out, d:GetFullName()) end end return game:GetService("HttpService"):JSONEncode(out)`, 'Edit')).output.trim()) as string[];
      const fresh = added.filter((p) => !before.includes(p));
      log('new scripts in Studio:', fresh.join(', '));
      expect(fresh.length).toBeGreaterThan(0);
      const sources = all.map((f) => readFileSync(join(projectDir, 'src', f), 'utf8')).join('\n');
      expect(sources).toMatch(/leaderstats/);
      expect(sources).toMatch(/Coins/);

      const audit = await core.tools.invoke('ui_audit', { source: 'playtest' }, tester);
      log('audit:', text(audit).split('\n')[0]);
      const findings = ((audit.data as { findings?: UiFinding[] } | undefined)?.findings ?? []);
      log(findings.map((f) => `${f.severity} ${f.devices.join('/')} ${f.path}: ${f.message}`).join('\n') || 'no findings');
      expect(audit.isError, text(audit)).toBeFalsy();
      expect(findings.filter((f) => f.severity === 'problem')).toEqual([]);
    } finally {
      await core.studio.setPlaying(false).catch(() => undefined);
      // The copilot's additions (anything not there before), then the seeded game.
      await core.studio
        .runLuau(
          `local keep = {} for _, p in game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify(before))}) do keep[p] = true end
for _, d in game:GetDescendants() do
  if d.Parent and (d:IsA("LuaSourceContainer") or d:IsA("ScreenGui") or d:IsA("RemoteEvent") or d:IsA("RemoteFunction")) and not keep[d:GetFullName()] then d:Destroy() end
end
local sh = game:GetService("ReplicatedStorage"):FindFirstChild("Shared")
if sh and #sh:GetChildren() == 0 then sh:Destroy() end
return "ok"`,
          'Edit',
        )
        .catch(() => undefined);
      await core.studio.runLuau(CLEAN_STUDY, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 30 * 60 * 1000);
});
