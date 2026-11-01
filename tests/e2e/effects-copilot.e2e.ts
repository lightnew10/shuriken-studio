/**
 * Live check of the effects copilot with the real model (two turns, costs a little usage):
 *
 *   E2E=effects-copilot STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/effects-copilot.e2e.ts
 *
 * In a throwaway project bound to the scratch place, asks the effects copilot for a fiery sword-hit
 * burst. Expects a DRAFT: saved in the project, nothing of it in Studio or the game's code, and no
 * playtest, Luau, sync or file edit by the copilot. Then "put it in the game": the effect is built into
 * Studio (ShurikenEffects), still with none of those. Refuses a published place. Removes what it built.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { EffectStore } from '../../src/core/effects/effects-service';

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
const ROLE = 'copilot-effects';

const CLEAN = `for _, p in { {"ReplicatedStorage", "Shared"}, {"ServerScriptService", "Server"}, {"StarterPlayer", "StarterPlayerScripts", "Client"}, {"ReplicatedStorage", "ShurikenEffects"} } do
  local inst = game:GetService(p[1])
  for i = 2, #p do inst = inst and inst:FindFirstChild(p[i]) end
  if inst and inst ~= game:GetService(p[1]) then inst:Destroy() end
end
for _, d in workspace:GetChildren() do
  if d:GetAttribute("ShurikenEffectPreview") or string.find(d.Name, "EffectPreview") then d:Destroy() end
end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
return "clean"`;

describe.runIf(process.env.E2E === 'effects-copilot')('the effects copilot with the real model (live)', () => {
  it('makes a hit effect as a draft, and builds it into Studio only when told to', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-fxcopilot-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-fxcopilot-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    core.prefs.set({ uploadAssets: false });
    await core.studio.start();
    try {
      const summary = core.createProject({ name: 'Effects Copilot E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');
      core.orchestrator.pause();

      const chat = core.copilots.chat('effects')!;
      const replies = () => chat.list().filter((m) => m.role === 'copilot');
      const inStudio = async () => (await core.studio.runLuau(`local f = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenEffects") return f and tostring(#f:GetChildren()) or "missing"`, 'Edit')).output.trim();
      const wait = async (n: number) => {
        const t = Date.now();
        while (replies().length < n) {
          if (Date.now() - t > 20 * 60_000) throw new Error('No copilot reply within 20 minutes');
          await new Promise((r) => setTimeout(r, 3000));
        }
      };
      const t0 = Date.now();
      core.copilots.send('effects', 'Make a fiery impact burst for sword hits.', { page: 'effects' });
      await wait(1);
      const draft = replies()[0]!;
      log('draft turn after', Math.round((Date.now() - t0) / 1000), 's:', draft.text, JSON.stringify(draft.data));
      // A draft: in the project, marked as one, and nothing of it in Studio.
      expect(draft.data?.mode).toBe('draft');
      const drafts = new EffectStore(projectDir).all();
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.every((e) => e.draft)).toBe(true);
      expect(await inStudio()).toBe('missing');
      expect(String(draft.text)).not.toMatch(/\b(?:is|it's|are) (?:now )?in (?:the|your) game\b/i);

      core.copilots.send('effects', 'Put it in the game.');
      await wait(2);
      const reply = replies()[1]!;
      log('import turn after', Math.round((Date.now() - t0) / 1000), 's:', reply.text);
      expect(reply.data?.mode).toBe('import');
      const runs = core.runner.listRuns(ctx, { limit: 5 }).filter((r) => r.role === 'copilot-effects');
      log('runs:', JSON.stringify(runs.map((r) => ({ status: r.status, cost: (r as { costUsd?: number }).costUsd }))));
      expect(runs.every((r) => r.status === 'completed')).toBe(true);
      const effects = new EffectStore(projectDir).all();
      log('effects:', effects.map((e) => `${e.effect.name} (${e.effect.kind}${e.preset ? `, from ${e.preset}` : ""})`).join('; '));
      expect(effects.some((e) => !e.draft)).toBe(true);
      const built = await inStudio();
      log('ShurikenEffects children:', built);
      expect(Number(built)).toBeGreaterThan(0);
      const called = (ctx.store.all<{ tool: string }>("SELECT tool FROM tool_calls WHERE role = ?", [ROLE]) ?? []).map((r) => r.tool.replace(/^mcp__shuriken__/, ''));
      log('tools called:', [...new Set(called)].join(', '));
      for (const never of ['roblox_playtest', 'roblox_run_luau', 'roblox_sync_push', 'roblox_call', 'Write', 'Edit', 'Bash']) expect(called, `the copilot stays in its field: ${never}`).not.toContain(never);
    } finally {
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 30 * 60 * 1000);
});
