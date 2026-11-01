/**
 * Live check of bringing a game's own animation in for editing (no model calls, no uploads):
 *
 *   E2E=anim-import STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/anim-import.e2e.ts
 *
 * Makes an Animation Editor style save (a KeyframeSequence under a rig's AnimSaves) in the scratch place,
 * imports it with animation_import, and checks the clip reproduces its poses; then builds it back into
 * the place and measures it with animation_check. Refuses a published place. Cleans up.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';
import { AnimationStore } from '../../src/core/animation/animation-service';

const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');
const agent: CallerContext = { kind: 'agent', runId: 'run_import', taskId: null, role: 'animator', providerId: null, allowedTools: null };

const SEED = `local dummy = Instance.new("Model")
dummy.Name = "ImportDummy"
dummy:SetAttribute("ImportE2E", true)
dummy.Parent = workspace
local saves = Instance.new("Model")
saves.Name = "AnimSaves"
saves.Parent = dummy
local ks = Instance.new("KeyframeSequence")
ks.Name = "OldSlash"
ks.Loop = false
ks.Priority = Enum.AnimationPriority.Action
ks.Parent = saves
local function key(t, arm, hips, marker)
  local kf = Instance.new("Keyframe")
  kf.Time = t
  kf.Parent = ks
  local hrp = Instance.new("Pose") hrp.Name = "HumanoidRootPart" hrp.Weight = 0 hrp.Parent = kf
  local lt = Instance.new("Pose") lt.Name = "LowerTorso" lt.CFrame = hips lt.Parent = hrp
  local ut = Instance.new("Pose") ut.Name = "UpperTorso" ut.Weight = 0 ut.Parent = lt
  local ra = Instance.new("Pose") ra.Name = "RightUpperArm" ra.CFrame = arm ra.EasingStyle = Enum.PoseEasingStyle.Cubic ra.EasingDirection = Enum.PoseEasingDirection.Out ra.Parent = ut
  if marker then local m = Instance.new("KeyframeMarker") m.Name = marker m.Parent = kf end
end
key(0, CFrame.Angles(math.rad(40), 0, math.rad(20)), CFrame.new(0, -0.1, 0))
key(0.25, CFrame.Angles(math.rad(120), math.rad(-15), math.rad(60)), CFrame.new(0, -0.3, -0.4) * CFrame.Angles(math.rad(-10), 0, 0), "Hit")
key(0.6, CFrame.Angles(math.rad(-20), 0, math.rad(10)), CFrame.new())
return "seeded"`;

const CLEAN = `local d = workspace:FindFirstChild("ImportDummy") if d then d:Destroy() end
local rs = game:GetService("ReplicatedStorage")
local a = rs:FindFirstChild("ShurikenAnimations") if a then a:Destroy() end
local s = rs:FindFirstChild("Shared") if s then for _, m in s:GetChildren() do if m.Name:match("^Shuriken") then m:Destroy() end end if #s:GetChildren() == 0 then s:Destroy() end end
return "clean"`;

describe.runIf(process.env.E2E === 'anim-import')("bringing in a game's own animation (live)", () => {
  it('imports an Animation Editor save as an exact, editable clip', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-import-e2e-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-import-project-'));
    try {
      const ctx = core.openProject(core.createProject({ name: 'Import E2E', rootPath: projectDir }).id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');
      expect((await core.studio.runLuau(SEED, 'Edit')).output).toContain('seeded');

      const r = await core.tools.invoke('animation_import', { name: 'OldSlash', path: 'Workspace.ImportDummy.AnimSaves.OldSlash' }, agent);
      console.log(text(r));
      expect(r.isError, text(r)).toBeFalsy();
      const clip = new AnimationStore(projectDir).get('OldSlash')!.clip;
      expect(clip.keys.map((k) => k.t)).toEqual([0, 0.25, 0.6]);
      expect(clip.markers).toEqual([{ t: 0.25, name: 'Hit' }]);
      const hit = clip.keys[1]!.poses;
      expect(hit.RightUpperArm!.rot!.map((v) => Math.round(v))).toEqual([120, -15, 60]);
      expect(hit.RightUpperArm).toMatchObject({ ease: 'Cubic', dir: 'Out' });
      expect(hit.LowerTorso!.pos).toEqual([0, -0.3, -0.4]);
      expect(hit.LowerTorso!.rot!.map((v) => Math.round(v))).toEqual([-10, 0, 0]);
      expect(hit.UpperTorso).toBeUndefined();

      // It builds back into the place and plays on a rig there.
      const b = await core.tools.invoke('animation_build', {}, agent);
      expect(b.isError, text(b)).toBeFalsy();
      const chk = await core.tools.invoke('animation_check', { name: 'OldSlash' }, agent);
      console.log(text(chk).slice(0, 600));
      expect(chk.isError, text(chk)).toBeFalsy();
      expect(text(chk)).toMatch(/"length": ?0\.6/);
    } finally {
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 10 * 60 * 1000);
});
