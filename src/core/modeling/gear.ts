import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vec3 } from '@shared/rig';
import { BLOOM_FN, isNeon, ModelStore, PLACE_FN, type ModelMeta } from './model-store';

/**
 * Gear: models players hold or wear — weapons and tools as Roblox Tools, armour, hats and shields as
 * Accessories — for R15 characters (players stay R15; creatures have their own rigs).
 *
 * Measured in Studio on a default R15 standing on the floor at the origin, facing −Z (5.457 studs tall;
 * the HumanoidRootPart at y 3.192): its body attachments' rest positions below, and how a Tool is held —
 * the hand's RightGripAttachment takes the Handle exactly (Handle = grip · Tool.Grip⁻¹), and in the default
 * hold (ToolNoneAnim) that grip frame is upright and faces where the character faces (+Y up, −Z forward,
 * 1.93 studs in front, 1.4 to the right, 0.53 above the root). So a weapon modeled upright, its front
 * facing where the character looks, is held exactly as modeled when Tool.Grip is just the offset from
 * the Handle to the grip point.
 */

export const GEAR_FILE = 'models/gear.json';
export const GEAR_BUILDER_REL = 'world/Gear.luau';

/** A default R15's attachment points at rest (Roblox space: x right, y up, z back; feet on y = 0). */
export const R15_ATTACHMENTS: Record<string, { part: string; pos: Vec3; rot?: Vec3 }> = {
  HatAttachment: { part: 'Head', pos: [0, 5.456, 0] },
  HairAttachment: { part: 'Head', pos: [0, 5.456, 0] },
  FaceFrontAttachment: { part: 'Head', pos: [0, 4.866, -0.581] },
  FaceCenterAttachment: { part: 'Head', pos: [0, 4.772, 0] },
  NeckAttachment: { part: 'UpperTorso', pos: [0, 4.29, 0] },
  BodyFrontAttachment: { part: 'UpperTorso', pos: [0, 3.229, -0.502] },
  BodyBackAttachment: { part: 'UpperTorso', pos: [0, 3.229, 0.502] },
  LeftCollarAttachment: { part: 'UpperTorso', pos: [-0.972, 4.29, 0] },
  RightCollarAttachment: { part: 'UpperTorso', pos: [0.972, 4.29, 0] },
  LeftShoulderAttachment: { part: 'LeftUpperArm', pos: [-1.472, 4.241, 0] },
  RightShoulderAttachment: { part: 'RightUpperArm', pos: [1.472, 4.241, 0] },
  WaistFrontAttachment: { part: 'LowerTorso', pos: [0, 2.192, -0.5] },
  WaistBackAttachment: { part: 'LowerTorso', pos: [0, 2.192, 0.5] },
  WaistCenterAttachment: { part: 'LowerTorso', pos: [0, 2.192, 0] },
  LeftGripAttachment: { part: 'LeftHand', pos: [-1.472, 2.169, 0], rot: [-90, 0, 0] },
  RightGripAttachment: { part: 'RightHand', pos: [1.472, 2.169, 0], rot: [-90, 0, 0] },
  LeftFootAttachment: { part: 'LeftFoot', pos: [-0.482, -0.004, -0.05] },
  RightFootAttachment: { part: 'RightFoot', pos: [0.482, -0.004, -0.05] },
};

/** A default R15's body parts at rest (centre and size; Roblox space as above): the reference to fit armour on. */
export const R15_PARTS: Record<string, { pos: Vec3; size: Vec3 }> = {
  Head: { pos: [0, 4.866, 0], size: [1.159, 1.182, 1.161] },
  UpperTorso: { pos: [0, 3.441, 0], size: [1.943, 1.698, 1.004] },
  LowerTorso: { pos: [0, 2.392, 0], size: [1.991, 0.401, 1.004] },
  LeftUpperArm: { pos: [-1.472, 3.62, 0], size: [1.001, 1.242, 1.002] },
  LeftLowerArm: { pos: [-1.472, 2.99, 0], size: [1.001, 1.118, 1.002] },
  LeftHand: { pos: [-1.472, 2.327, 0], size: [0.984, 0.316, 1.028] },
  RightUpperArm: { pos: [1.472, 3.62, 0], size: [1.001, 1.242, 1.002] },
  RightLowerArm: { pos: [1.472, 2.99, 0], size: [1.001, 1.118, 1.002] },
  RightHand: { pos: [1.472, 2.327, 0], size: [0.984, 0.316, 1.028] },
  LeftUpperLeg: { pos: [-0.5, 1.721, 0], size: [0.993, 1.363, 0.973] },
  LeftLowerLeg: { pos: [-0.5, 0.859, 0], size: [0.993, 1.301, 0.973] },
  LeftFoot: { pos: [-0.5, 0.156, 0], size: [1.009, 0.312, 1.001] },
  RightUpperLeg: { pos: [0.5, 1.721, 0], size: [0.993, 1.363, 0.973] },
  RightLowerLeg: { pos: [0.5, 0.859, 0], size: [0.993, 1.301, 0.973] },
  RightFoot: { pos: [0.5, 0.156, 0], size: [1.009, 0.312, 1.001] },
};

/** Blender coordinates (studs, Z up, front −Y) → Roblox's (Y up, front −Z), as the export turns them. */
export const blenderToRoblox = (v: Vec3): Vec3 => [-v[0], v[2], v[1]];
export const robloxToBlender = (v: Vec3): Vec3 => [-v[0], v[2], v[1]];

/**
 * Python for blender_python: the default R15 as boxes around the origin (hidden from the export: their
 * names start with "_"), to model armour, hats and shields on. Remove with kiln.clear() or delete them.
 */
export function referenceCharacterPython(): string {
  const rows = Object.entries(R15_PARTS).map(([n, p]) => {
    const c = robloxToBlender(p.pos);
    const s: Vec3 = [p.size[0], p.size[2], p.size[1]];
    return `    ("${n}", (${c.map((x) => x.toFixed(3)).join(', ')}), (${s.map((x) => x.toFixed(3)).join(', ')})),`;
  });
  return `import bpy, bmesh
coll = bpy.data.collections.get("_Reference") or bpy.data.collections.new("_Reference")
if coll.name not in bpy.context.scene.collection.children:
    bpy.context.scene.collection.children.link(coll)
ghost = bpy.data.materials.get("_RefGhost") or bpy.data.materials.new("_RefGhost")
ghost.diffuse_color = (0.44, 0.53, 0.61, 1.0)
for name, centre, size in [
${rows.join('\n')}
]:
    ob = bpy.data.objects.get("_Ref_" + name)
    if ob is None:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        me = bpy.data.meshes.new("_Ref_" + name)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new("_Ref_" + name, me)
        coll.objects.link(ob)
        me.materials.append(ghost)
    ob.location = centre
    ob.scale = size
bpy.context.view_layer.update()
print("reference R15 at the origin, facing -Y:", len(coll.objects), "parts")`;
}

export type GearKind = 'tool' | 'accessory';

/** models/gear.json: what each gear item is made of and how it's held or worn. */
export interface GearSpec {
  /** The Tool/Accessory's name in the game. */
  name: string;
  /** The model (one part, or every part of a multi-part model by its name). */
  model: string;
  kind: GearKind;
  /** Accessory: the character attachment it's worn on (HatAttachment, BodyBackAttachment, LeftGripAttachment…). */
  attachTo?: string;
  /** Where the hand holds it (tool) or where it meets the body (accessory), in the model (Roblox space). */
  point: Vec3;
  /** Where the built gear goes (default ServerStorage.ShurikenGear; StarterPack gives it to everyone). */
  into: string;
}

export class GearStore {
  constructor(private readonly root: string) {}

  private file(): string {
    return join(this.root, GEAR_FILE);
  }

  all(): GearSpec[] {
    try {
      return (JSON.parse(readFileSync(this.file(), 'utf8')) as { gear?: GearSpec[] }).gear ?? [];
    } catch {
      return [];
    }
  }

  save(spec: GearSpec): void {
    const gear = [...this.all().filter((g) => g.name !== spec.name), spec].sort((a, b) => a.name.localeCompare(b.name));
    mkdirSync(join(this.root, 'models'), { recursive: true });
    writeFileSync(this.file(), `${JSON.stringify({ gear }, null, 2)}\n`, 'utf8');
  }

  remove(name: string): boolean {
    const all = this.all();
    if (!all.some((g) => g.name === name)) return false;
    writeFileSync(this.file(), `${JSON.stringify({ gear: all.filter((g) => g.name !== name) }, null, 2)}\n`, 'utf8');
    return true;
  }
}

/** A model's parts as gear is made of them: one part, or every part of a multi-part model. */
export function gearParts(store: ModelStore, model: string): ModelMeta[] {
  const one = store.get(model);
  return one ? [one] : store.parts(model);
}

/** The part a hand or body attachment takes: the one whose box holds the point, else the nearest. */
export function handleOf(parts: ModelMeta[], point: Vec3): ModelMeta {
  const dist = (m: ModelMeta) => {
    const o = m.origin ?? [0, 0, 0];
    const out = [0, 1, 2].map((i) => Math.max(0, Math.abs(point[i]! - o[i]!) - m.size[i]! / 2));
    return Math.hypot(...out) * 1000 + Math.hypot(point[0] - o[0], point[1] - o[1], point[2] - o[2]);
  };
  return [...parts].sort((a, b) => dist(a) - dist(b))[0]!;
}

const n = (v: number) => String(Math.round(v * 10000) / 10000);
const v3 = (v: readonly number[]) => `{${v.map(n).join(',')}}`;

/**
 * Luau that builds gear from uploaded meshes: each item a Tool (Handle = the part the hand holds, the
 * rest welded on, Tool.Grip = the grip point's offset from the Handle) or an Accessory (Handle with an
 * Attachment named like the character's, at the point where it meets the body), massless and
 * non-colliding, into its container (replacing an older build of the same item). Idempotent.
 */
export function gearBuilder(items: Array<{ spec: GearSpec; parts: ModelMeta[]; assets: Record<string, string> }>): string {
  const neon = items.some((it) => it.parts.some((p) => isNeon(p.material)));
  const rows = items.map(({ spec, parts, assets }) => {
    const handle = handleOf(parts, spec.point);
    const att = spec.attachTo ? R15_ATTACHMENTS[spec.attachTo] : undefined;
    const meshes = parts
      .map((p) => `{name=${JSON.stringify(p.name)},asset=${assets[p.name]},origin=${v3(p.origin ?? [0, 0, 0])},size=${v3(p.size)}${p.color ? `,color=${JSON.stringify(p.color)}` : ''}${p.material ? `,material=${JSON.stringify(p.material)}` : ''}${p.transparency ? `,transparency=${n(p.transparency)}` : ''}${ModelStore.legacyUpload(p) ? ',turn=true' : ''}${p.name === handle.name ? ',handle=true' : ''}}`)
      .join(',');
    return `  {name=${JSON.stringify(spec.name)},kind=${JSON.stringify(spec.kind)},into=${JSON.stringify(spec.into)},point=${v3(spec.point)}${spec.attachTo ? `,attachTo=${JSON.stringify(spec.attachTo)},attRot=${v3(att?.rot ?? [0, 0, 0])}` : ''},parts={${meshes}}},`;
  });
  return `-- Generated by Shuriken Studio from ${GEAR_FILE}. Do not edit: make gear with model_gear.
local InsertService = game:GetService("InsertService")
local HttpService = game:GetService("HttpService")
local GEAR = {
${rows.join('\n')}
}
${PLACE_FN}
${neon ? `${BLOOM_FN}\n` : ''}local function v(t) return Vector3.new(t[1], t[2], t[3]) end
-- A legacy upload (made before the importer's 180° turn was compensated, see glb.ts) arrives turned about its
-- own centre: its part is turned back, and when it is the Handle the grip / attachment frame is turned with it.
local TURN = CFrame.Angles(0, math.pi, 0)
local function build(g)
  local item = Instance.new(if g.kind == "tool" then "Tool" else "Accessory")
  item.Name = g.name
  local handle
  local handleTurn = false
  local made = {}
  for _, p in g.parts do
    local mp = meshOf(p.asset):Clone()
    mp.Name = if p.handle then "Handle" else p.name
    mp.Size = v(p.size)
    mp.CFrame = CFrame.new(v(p.origin)) * (if p.turn then TURN else CFrame.new())
    if p.color then mp.Color = Color3.fromHex(p.color) end
    if p.material then mp.Material = Enum.Material[p.material] end
    if p.transparency then mp.Transparency = p.transparency end
    mp.Anchored = false
    mp.CanCollide = false
    mp.CanTouch = true
    mp.Massless = true
    mp:SetAttribute("ShurikenModel", p.name)
    if p.handle then
      handle = mp
      handleTurn = p.turn == true
    end
    table.insert(made, mp)
  end
  for _, mp in made do
    if mp ~= handle then
      local w = Instance.new("WeldConstraint")
      w.Part0 = handle
      w.Part1 = mp
      w.Parent = mp
    end
    mp.Parent = item
  end
  local offset = handle.CFrame:PointToObjectSpace(v(g.point))
  if g.kind == "tool" then
    -- Held as modeled: the grip point in the hand, upright, facing where the character faces.
    item.Grip = CFrame.new(offset) * (if handleTurn then TURN else CFrame.new())
    item.CanBeDropped = false
  else
    local a = Instance.new("Attachment")
    a.Name = g.attachTo
    a.CFrame = CFrame.new(offset) * (if handleTurn then TURN else CFrame.new()) * CFrame.fromOrientation(math.rad(g.attRot[1]), math.rad(g.attRot[2]), math.rad(g.attRot[3]))
    a.Parent = handle
  end
  item:SetAttribute("ShurikenGear", g.name)
  return item
end
local built, failed = {}, {}
for _, g in GEAR do
  local ok, result = pcall(build, g)
  if ok then
    local into = resolveParent(g.into)
    local old = into:FindFirstChild(g.name)
    if old and old:GetAttribute("ShurikenGear") == g.name then old:Destroy() end
    result.Parent = into
    table.insert(built, g.name)
  else
    table.insert(failed, { name = g.name, error = tostring(result) })
  end
end
${neon ? '-- Neon glows through Bloom: keep it from blinding.\nlocal bloom = tameBloom()\n' : ''}return HttpService:JSONEncode({ built = built, failed = failed${neon ? ', bloom = bloom' : ''} })
`;
}

/** Rewrites world/Gear.luau from models/gear.json (only items whose parts are all uploaded). */
export function writeGearBuilder(root: string): { file: string | null; built: string[]; waiting: string[] } {
  const store = new ModelStore(root);
  const ready: Array<{ spec: GearSpec; parts: ModelMeta[]; assets: Record<string, string> }> = [];
  const waiting: string[] = [];
  for (const spec of new GearStore(root).all()) {
    const parts = gearParts(store, spec.model);
    const assets = Object.fromEntries(parts.map((p) => [p.name, ModelStore.assetId(p)]).filter((x): x is [string, string] => !!x[1]));
    if (parts.length && Object.keys(assets).length === parts.length) ready.push({ spec, parts, assets });
    else waiting.push(spec.name);
  }
  const file = join(root, GEAR_BUILDER_REL);
  if (!ready.length) {
    if (existsSync(file)) rmSync(file);
    return { file: null, built: [], waiting };
  }
  mkdirSync(join(root, 'world'), { recursive: true });
  writeFileSync(file, gearBuilder(ready), 'utf8');
  return { file, built: ready.map((r) => r.spec.name), waiting };
}
