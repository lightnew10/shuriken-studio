import { JOINTS, type AnimationClip, type ClipKey, type Easing, type EasingDir, type JointPose, type Priority } from '@shared/animation';
import type { RigSpec } from '@shared/rig';

/**
 * A game's own Roblox animations as Shuriken clips, so they can be edited: a KeyframeSequence read in
 * Studio (an Animation Editor save under a rig's AnimSaves, a KeyframeSequence anywhere, an Animation
 * instance or an asset id through KeyframeSequenceProvider) becomes keys per joint. A Pose's CFrame is
 * the joint's Motor6D.Transform, which is exactly how Shuriken's clips are defined (rotation as
 * CFrame.Angles degrees, position in the parent's frame), so the conversion is exact for R15 and for
 * rig_build rigs.
 */

export interface RawPose {
  name: string;
  /** CFrame components: x, y, z, then the rotation matrix row by row. */
  cf: number[];
  style: string;
  dir: string;
  weight: number;
}

export interface RawSequence {
  name: string;
  loop: boolean;
  priority: string;
  keyframes: Array<{ t: number; poses: RawPose[]; markers: Array<{ name: string; value: string }> }>;
}

/** Luau: the KeyframeSequence at a DataModel path (a KeyframeSequence, or an Animation's asset), or of an asset id, as JSON. */
export function readKeyframesLuau(source: { path?: string; assetId?: string }): string {
  return `local HttpService = game:GetService("HttpService")
local KSP = game:GetService("KeyframeSequenceProvider")
local function resolve(path)
  local inst = game
  for _, seg in string.split((string.gsub(path, "%.", "/")), "/") do
    if seg ~= "" and seg ~= "game" then
      local nxt = inst:FindFirstChild(seg)
      if not nxt and inst == game then
        local ok, svc = pcall(function() return game:GetService(seg) end)
        if ok then nxt = svc end
      end
      inst = nxt
      if not inst then return nil end
    end
  end
  return inst
end
local seq
local path = ${source.path ? JSON.stringify(source.path) : 'nil'}
local assetId = ${source.assetId ? JSON.stringify(source.assetId) : 'nil'}
if path then
  local inst = resolve(path)
  if not inst then return HttpService:JSONEncode({ error = "nothing at " .. path }) end
  if inst:IsA("KeyframeSequence") then seq = inst
  elseif inst:IsA("Animation") then assetId = inst.AnimationId
  else return HttpService:JSONEncode({ error = path .. " is a " .. inst.ClassName .. ", not a KeyframeSequence or an Animation" }) end
end
if not seq then
  local id = tostring(assetId or "")
  if not id:match("^rbxassetid://") then id = "rbxassetid://" .. id:gsub("%D", "") end
  local ok, res = pcall(function() return KSP:GetKeyframeSequenceAsync(id) end)
  if not ok then return HttpService:JSONEncode({ error = "Roblox didn't give the animation " .. id .. ": " .. tostring(res) .. " (only animations the user or their group owns can be read)" }) end
  seq = res
end
local out = { name = seq.Name, loop = seq.Loop, priority = seq.Priority.Name, keyframes = {} }
for _, kf in seq:GetKeyframes() do
  local poses, markers = {}, {}
  for _, p in kf:GetDescendants() do
    if p:IsA("Pose") then
      local c = { p.CFrame:GetComponents() }
      table.insert(poses, { name = p.Name, cf = c, style = p.EasingStyle.Name, dir = p.EasingDirection.Name, weight = p.Weight })
    end
  end
  for _, m in kf:GetMarkers() do table.insert(markers, { name = m.Name, value = m.Value }) end
  table.insert(out.keyframes, { t = kf.Time, poses = poses, markers = markers })
end
return HttpService:JSONEncode(out)`;
}

const EASINGS = new Set<Easing>(['Linear', 'Constant', 'Cubic', 'Elastic', 'Bounce', 'CubicV2']);
const DIRS = new Set<EasingDir>(['In', 'Out', 'InOut']);
const PRIORITIES = new Set<Priority>(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Degrees (x, y, z) with R = Rx(x)·Ry(y)·Rz(z), i.e. CFrame.Angles(x, y, z); R row by row. */
export function eulerXYZ(r: number[]): [number, number, number] {
  const deg = (v: number) => (v * 180) / Math.PI;
  const b = Math.asin(Math.max(-1, Math.min(1, r[2]!)));
  if (Math.abs(Math.cos(b)) > 1e-6) return [deg(Math.atan2(-r[5]!, r[8]!)), deg(b), deg(Math.atan2(-r[1]!, r[0]!))];
  return [deg(Math.atan2(r[7]!, r[4]!)), deg(b), 0];
}

/**
 * A read KeyframeSequence as a clip for R15 (no rig) or a rig_build rig: poses of the rig's joints
 * (weight 0 poses only hold the tree together and are skipped), easing kept, markers at their frames.
 */
export function sequenceToClip(name: string, raw: RawSequence, rig?: RigSpec | null): { clip: AnimationClip; skipped: string[] } {
  const joints = new Set<string>(rig ? rig.joints.map((j) => j.name) : JOINTS);
  const skipped = new Set<string>();
  const frames = [...raw.keyframes].sort((a, b) => a.t - b.t);
  const keys: ClipKey[] = [];
  const markers: NonNullable<AnimationClip['markers']> = [];
  for (const kf of frames) {
    const poses: ClipKey['poses'] = {};
    for (const p of kf.poses) {
      if (!joints.has(p.name)) {
        if (p.name !== 'HumanoidRootPart' && p.weight > 0) skipped.add(p.name);
        continue;
      }
      if (p.weight <= 0 || p.cf.length < 12) continue;
      const rot = eulerXYZ(p.cf.slice(3)).map(r3) as [number, number, number];
      const pos = [p.cf[0]!, p.cf[1]!, p.cf[2]!].map(r3) as [number, number, number];
      const pose: JointPose = { rot };
      if (pos.some((v) => Math.abs(v) > 1e-3)) pose.pos = pos;
      if (EASINGS.has(p.style as Easing)) pose.ease = p.style as Easing;
      if (DIRS.has(p.dir as EasingDir)) pose.dir = p.dir as EasingDir;
      poses[p.name] = pose;
    }
    keys.push({ t: r3(kf.t), poses });
    for (const m of kf.markers) markers.push({ t: r3(kf.t), name: m.name, ...(m.value ? { value: m.value } : {}) });
  }
  // Shuriken clips start with a key at 0 (Roblox holds the first pose until then).
  if (keys.length && keys[0]!.t > 0) keys.unshift({ t: 0, poses: structuredClone(keys[0]!.poses) });
  if (keys.length === 1) keys.push({ t: Math.max(0.1, ...markers.map((m) => m.t)), poses: structuredClone(keys[0]!.poses) });
  return {
    clip: {
      name,
      description: `Imported from the game's own animation ${raw.name}`,
      ...(rig ? { rig: rig.model } : {}),
      loop: !!raw.loop,
      priority: PRIORITIES.has(raw.priority as Priority) ? (raw.priority as Priority) : 'Action',
      keys,
      ...(markers.length ? { markers } : {}),
    },
    skipped: [...skipped],
  };
}
