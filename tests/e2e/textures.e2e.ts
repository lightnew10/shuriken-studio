/**
 * Live check of textured models on temporary meshes (no model calls, no uploads):
 *
 *   E2E=textures STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/textures.e2e.ts
 *
 * Models props in Blender with Kiln's texture helpers (a PBR stone block, a pixel-art sign, a plain
 * box), places them in the scratch place as temporary meshes, and checks in Studio: each textured part
 * has UVs and a SurfaceAppearance whose maps are EditableImages with the exported pixels (the sign's
 * top-left pixel red); the plain part has none. Placing again reuses the maps already in Studio. A
 * rigged bug in Kiln's chitin gets a preview rig (rig_build, temporary meshes) whose parts all wear its maps.
 * Saves a screenshot when Studio can draw (SHOT=<file.png>). Needs Blender. Refuses a published place.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { findBlender } from '../../src/core/blender/bridge';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';

const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');
const agent: CallerContext = { kind: 'agent', runId: 'run_tex', taskId: null, role: 'modeler', providerId: null, allowedTools: null };

// The same scene as tests/blender.test.ts (TEXTURED), with Kiln's usual 512 px maps.
const src = readFileSync(resolve(__dirname, '..', 'blender.test.ts'), 'utf8');
const TEXTURED = /const TEXTURED = `([\s\S]*?)`;/.exec(src)![1]!.replace('kiln.noise(64, 4, seed=3)', 'kiln.noise(512, 5, seed=3)');
// The rigged test bug from tests/blender.test.ts in Kiln's chitin (image maps) with box UVs.
const BUG = /const BUG = `([\s\S]*?)`;/
  .exec(src)![1]!
  .replace('shell = kiln.mat("Shell", base="#3f5a2a", roughness=0.6)', 'shell = kiln.material("Shell", "chitin", color="#3f5a2a", size=256)')
  .replace('kiln.anim.gait(', 'for ob in list(bpy.context.scene.objects):\n    if ob.type == "MESH":\n        kiln.uv_box(ob, 0.5)\nkiln.anim.gait(');

const PROBE = `local HttpService = game:GetService("HttpService")
local model = workspace:FindFirstChild("TexturedProps")
if not model then return HttpService:JSONEncode({ error = "not placed" }) end
local out = {}
for _, mp in model:GetChildren() do
  if mp:IsA("MeshPart") then
    local info = { temporary = mp:GetAttribute("ShurikenTemporaryMesh") == true }
    local ok, em = pcall(function() return mp.MeshContent.Object end)
    if ok and em then
      local okUv, uvs = pcall(function() return em:GetUVs() end)
      info.uvs = if okUv then #uvs else -1
    end
    local sa = mp:FindFirstChildOfClass("SurfaceAppearance")
    if sa then
      info.maps = {}
      for _, prop in { "ColorMapContent", "NormalMapContent", "RoughnessMapContent", "MetalnessMapContent" } do
        local c = sa[prop]
        if c.SourceType == Enum.ContentSourceType.Object and c.Object then
          local img = c.Object
          info.maps[prop] = { img.Size.X, img.Size.Y }
          if prop == "ColorMapContent" then
            local px = img:ReadPixelsBuffer(Vector2.zero, Vector2.new(1, 1))
            info.topLeft = { buffer.readu8(px, 0), buffer.readu8(px, 1), buffer.readu8(px, 2) }
          end
        end
      end
    end
    out[mp.Name] = info
  end
end
return HttpService:JSONEncode(out)`;

const CLEAN = `local m = workspace:FindFirstChild("TexturedProps") if m then m:Destroy() end
local b = workspace:FindFirstChild("TexturedBug") if b then b:Destroy() end
local rigs = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenRigs")
if rigs then
  local r = rigs:FindFirstChild("Bug") if r then r:Destroy() end
  local st = rigs:FindFirstChild("_Staging")
  local sb = st and st:FindFirstChild("Bug") if sb then sb:Destroy() end
  if st and #st:GetChildren() == 0 then st:Destroy() end
  if #rigs:GetChildren() == 0 then rigs:Destroy() end
end
shared.ShurikenTextures = nil
shared.ShurikenTexUpload = nil
return "clean"`;

describe.runIf(process.env.E2E === 'textures')('textured models in Studio (live)', () => {
  it('puts Kiln texture maps on temporary meshes as SurfaceAppearances', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const blender = findBlender(process.env.SHURIKEN_BLENDER || null);
    if (!blender) throw new Error('Needs Blender (set SHURIKEN_BLENDER).');
    process.env.SHURIKEN_BLENDER = blender;
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-tex-e2e-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-tex-project-'));
    try {
      const ctx = core.openProject(core.createProject({ name: 'Textures E2E', rootPath: projectDir }).id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');

      const made = await core.tools.invoke('blender_python', { model: 'Props', code: TEXTURED }, agent);
      expect(made.isError, text(made)).toBeFalsy();
      const t0 = Date.now();
      const placed = await core.tools.invoke('model_place', { name: 'Props', instance_name: 'TexturedProps', position: [0, 0, -30], temporary: true }, agent);
      const firstMs = Date.now() - t0;
      console.log(text(placed));
      expect(placed.isError, text(placed)).toBeFalsy();
      expect(text(placed)).toMatch(/texture maps show/);

      const probe = await core.studio.runLuau(PROBE, 'Edit', 30_000);
      const parts = JSON.parse(probe.output.trim()) as Record<string, { temporary: boolean; uvs?: number; maps?: Record<string, [number, number]>; topLeft?: number[] }>;
      console.log(JSON.stringify(parts));
      expect(parts.Props_Stone!.maps).toEqual({ ColorMapContent: [512, 512], NormalMapContent: [512, 512], RoughnessMapContent: [128, 128], MetalnessMapContent: [4, 4] });
      expect(parts.Props_Stone!.uvs).toBeGreaterThan(0);
      // The pixel art arrives as painted: its top-left pixel is red (1024 px sent at 512).
      expect(parts.Props_Sign!.maps!.ColorMapContent).toEqual([512, 512]);
      expect(parts.Props_Sign!.topLeft).toEqual([255, 0, 0]);
      expect(parts.Props_Plain!.maps).toBeUndefined();

      // Placing again sends no maps: Studio still has them.
      const t1 = Date.now();
      const again = await core.tools.invoke('model_place', { name: 'Props', instance_name: 'TexturedProps', position: [0, 0, -30], temporary: true }, agent);
      const secondMs = Date.now() - t1;
      expect(again.isError, text(again)).toBeFalsy();
      const probe2 = JSON.parse((await core.studio.runLuau(PROBE, 'Edit', 30_000)).output.trim()) as typeof parts;
      expect(probe2.Props_Sign!.topLeft).toEqual([255, 0, 0]);
      console.log(`placed in ${firstMs} ms, again in ${secondMs} ms`);

      // A rigged creature in Kiln's chitin: its preview rig (temporary meshes) wears the maps too.
      const bug = await core.tools.invoke('blender_python', { model: 'Bug', code: BUG }, agent);
      expect(bug.isError, text(bug)).toBeFalsy();
      const rig = await core.tools.invoke('rig_build', { model: 'Bug', place: { position: [8, 0, -30], name: 'TexturedBug' } }, agent);
      expect(rig.isError, text(rig)).toBeFalsy();
      const rigProbe = await core.studio.runLuau(
        `local HttpService = game:GetService("HttpService")
local out = {}
for _, where in { game:GetService("ReplicatedStorage").ShurikenRigs.Bug, workspace.TexturedBug } do
  local n, mapped = 0, 0
  for _, d in where:GetDescendants() do
    if d:IsA("MeshPart") then
      n += 1
      local sa = d:FindFirstChildOfClass("SurfaceAppearance")
      if sa and sa.ColorMapContent.SourceType == Enum.ContentSourceType.Object and sa.NormalMapContent.SourceType == Enum.ContentSourceType.Object then mapped += 1 end
    end
  end
  table.insert(out, { parts = n, mapped = mapped })
end
return HttpService:JSONEncode(out)`,
        'Edit',
        30_000,
      );
      const [template, copy] = JSON.parse(rigProbe.output.trim()) as Array<{ parts: number; mapped: number }>;
      console.log(`rig template ${JSON.stringify(template)}, placed copy ${JSON.stringify(copy)}`);
      expect(template!.parts).toBeGreaterThan(4);
      expect(template!.mapped).toBe(template!.parts);
      expect(copy!.mapped).toBe(copy!.parts);

      if (process.env.SHOT) {
        const shot = await core.studio.screenshot({ camera: [6, 5, -20], lookAt: [0, 1, -30] }).catch((e: Error) => {
          console.log(`no screenshot: ${e.message}`);
          return null;
        });
        if (shot) writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
      }
    } finally {
      if (!process.env.KEEP) await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 15 * 60 * 1000);
});
