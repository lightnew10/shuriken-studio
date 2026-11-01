/**
 * Live check of a creature made with Kiln's rig and animation system, all the way into real Studio (no
 * model calls, no uploads):
 *
 *   E2E=kiln-rig STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/kiln-rig.e2e.ts
 *
 * Builds the "Skitter" recipe from skill blender-creatures in Shuriken's own Blender (33-joint armature),
 * generates Kiln clips with kiln_clip, then rig_build without uploads (a preview rig from temporary
 * meshes), animation_build and animation_check on the rig in Studio, and Send to Studio of the walk.
 * Needs Blender. Refuses a published place (only a local scratch file, PlaceId 0). Cleans up.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { findBlender } from '../../src/core/blender/bridge';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';
import { AnimationStore } from '../../src/core/animation/animation-service';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');
const agent: CallerContext = { kind: 'agent', runId: 'run_e2e', taskId: null, role: 'animator', providerId: null, allowedTools: null };

const recipe = readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', 'blender-creatures', 'SKILL.md'), 'utf8');
const SKITTER = /```python\n(k = kiln[\s\S]*?)print\(k\.rig\.check\(\)/.exec(recipe)?.[1] ?? '';

const CLEAN = `local rs = game:GetService("ReplicatedStorage")
for _, n in { "ShurikenRigs", "ShurikenAnimations" } do
  local f = rs:FindFirstChild(n)
  if f then f:Destroy() end
end
local shared = rs:FindFirstChild("Shared")
if shared then
  for _, m in shared:GetChildren() do
    if m.Name:match("^Shuriken") then m:Destroy() end
  end
  if #shared:GetChildren() == 0 then shared:Destroy() end
end
for _, c in workspace:GetChildren() do
  if c:GetAttribute("ShurikenRig") or c:GetAttribute("ShurikenPreview") then c:Destroy() end
end
return "clean"`;

describe.runIf(process.env.E2E === 'kiln-rig')('a Kiln-rigged creature in Studio (live)', () => {
  it('builds, animates, rigs without uploads and checks a creature in Studio', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const blender = findBlender(process.env.SHURIKEN_BLENDER || null);
    if (!blender) throw new Error('Blender is needed');
    process.env.SHURIKEN_BLENDER = blender;
    expect(SKITTER).toMatch(/k\.tentacle\('Tail'/);
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-kilnrig-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-kilnrig-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    core.prefs.set({ uploadAssets: false });
    await core.studio.start();
    try {
      const summary = core.createProject({ name: 'Kiln rig E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place (${pid.output}): this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');

      let t0 = Date.now();
      const made = await core.tools.invoke('blender_python', { model: 'Skitter', code: SKITTER }, agent);
      expect(made.isError, text(made)).toBeFalsy();
      for (const [clip, generator, params] of [
        ['Walk', 'gait', { style: 'walk' }],
        ['Sting', 'attack', { kind: 'sting' }],
      ] as const) {
        const g = await core.tools.invoke('kiln_clip', { model: 'Skitter', clip, action: 'generate', generator, params }, agent);
        expect(g.isError, text(g)).toBeFalsy();
      }
      const store = new AnimationStore(projectDir);
      expect(store.get('SkitterWalk')?.source?.speed).toBeGreaterThan(0);
      log('model + clips', `${Date.now() - t0} ms`);

      t0 = Date.now();
      const rig = await core.tools.invoke('rig_build', { model: 'Skitter', place: { position: [0, 0, -30], name: 'SkitterE2E' } }, agent);
      log('rig_build', `${Date.now() - t0} ms`, text(rig).slice(0, 500));
      expect(rig.isError, text(rig)).toBeFalsy();
      const built = JSON.parse(text(rig)) as { temporary?: string; joints: string[]; placed: unknown };
      expect(built.temporary).toMatch(/temporary meshes/);
      expect(built.joints).toHaveLength(33);
      const inStudio = await core.studio.luauJson<{ parts: number; motors: number; temp: boolean; anchoredRoot: boolean }>(
        `local m = workspace:FindFirstChild("SkitterE2E")
local parts, motors = 0, 0
for _, d in m:GetDescendants() do
  if d:IsA("MeshPart") then parts += 1 end
  if d:IsA("Motor6D") then motors += 1 end
end
return game:GetService("HttpService"):JSONEncode({ parts = parts, motors = motors, temp = m:GetAttribute("ShurikenTemporaryMesh") == true, anchoredRoot = m.PrimaryPart.Anchored })`,
        'Edit',
      );
      log('in Studio', JSON.stringify(inStudio));
      expect(inStudio.motors).toBe(33);
      expect(inStudio.parts).toBeGreaterThanOrEqual(30);

      t0 = Date.now();
      const b = await core.tools.invoke('animation_build', {}, agent);
      expect(b.isError, text(b)).toBeFalsy();
      const chk = await core.tools.invoke('animation_check', { name: 'SkitterSting' }, agent);
      log('animation_check', `${Date.now() - t0} ms`, text(chk).slice(0, 900));
      expect(chk.isError, text(chk)).toBeFalsy();

      const sent = await core.send.animation('SkitterWalk');
      log('send', JSON.stringify(sent));
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
    } finally {
      if (!process.env.KEEP) await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 15 * 60 * 1000);
});
