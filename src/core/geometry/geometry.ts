import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Structured geometry: agents describe primitive-based models as data (parts, parametric generators,
 * CSG operations) instead of prose or hand-written coordinates. Shuriken validates and expands the
 * spec, compiles it into an idempotent builder script under world/ (so the world stays rebuildable
 * from the repository), runs it in Studio, and can read existing models back into the same format.
 */

export const MATERIALS = [
  'Plastic', 'SmoothPlastic', 'Neon', 'Wood', 'WoodPlanks', 'Marble', 'Slate', 'Concrete', 'Granite', 'Brick', 'Pebble',
  'Cobblestone', 'CorrodedMetal', 'DiamondPlate', 'Foil', 'Metal', 'Grass', 'LeafyGrass', 'Sand', 'Fabric', 'Snow', 'Mud',
  'Ground', 'Asphalt', 'Salt', 'Ice', 'Glacier', 'Glass', 'ForceField', 'Basalt', 'CrackedLava', 'Rock', 'Sandstone',
  'Limestone', 'Pavement', 'Cardboard', 'Carpet', 'CeramicTiles', 'ClayRoofTiles', 'RoofShingles', 'Leather', 'Plaster', 'Rubber',
] as const;

export const MAX_PARTS = 2000;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}$/;
const GROUP = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}){0,7}$/;

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const size3 = z.tuple([z.number().positive().max(2048), z.number().positive().max(2048), z.number().positive().max(2048)]);
const name = z.string().regex(NAME, 'names: letters, digits, _ - and spaces, max 64');
const color = z.union([z.string().regex(/^#?[0-9a-fA-F]{6}$/), z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)])]);
const attrValue = z.union([z.string().max(200), num, z.boolean()]);
const attrs = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/).refine((k) => !k.startsWith('RBX'), 'attribute names cannot start with RBX'), attrValue);
const tags = z.array(z.string().regex(/^[A-Za-z0-9_:.-]{1,100}$/)).max(10);

const look = {
  shape: z.enum(['Block', 'Ball', 'Cylinder', 'Wedge', 'CornerWedge']).optional(),
  rot: vec3.optional().describe('Orientation in degrees (Roblox order: Y, then X, then Z)'),
  color: color.optional().describe('"#RRGGBB" or [r, g, b] 0-255'),
  material: z.enum(MATERIALS).optional(),
  materialVariant: z.string().max(100).optional(),
  transparency: z.number().min(0).max(1).optional(),
  reflectance: z.number().min(0).max(1).optional(),
  anchored: z.boolean().optional(),
  canCollide: z.boolean().optional(),
  castShadow: z.boolean().optional(),
  group: z.string().regex(GROUP).optional().describe('Sub-model path inside the root, "/"-separated (e.g. "Walls/North")'),
  attributes: attrs.optional(),
  tags: tags.optional(),
};

export const partSchema = z.object({ name, size: size3, pos: vec3.describe('Position relative to the pivot (studs)'), ...look });
/** Part template for generators: position and name come from the generator. */
const templateSchema = z.object({ size: size3.optional(), ...look });

const generatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('array'), name, part: templateSchema.extend({ size: size3 }), count: z.number().int().min(1).max(500), start: vec3, step: vec3, rotStep: vec3.optional() }),
  z.object({ kind: z.literal('grid'), name, part: templateSchema.extend({ size: size3 }), countX: z.number().int().min(1).max(100), countZ: z.number().int().min(1).max(100), start: vec3, spacing: z.tuple([num, num]) }),
  z.object({
    kind: z.literal('ring'),
    name,
    part: templateSchema.extend({ size: size3 }),
    count: z.number().int().min(1).max(500),
    center: vec3,
    radius: z.number().positive().max(4096),
    startAngle: num.optional().describe('Degrees from +X toward +Z'),
    faceCenter: z.boolean().optional().describe("Turn each part so its front (-Z) faces the ring's center"),
  }),
  z.object({
    kind: z.literal('stairs'),
    name,
    steps: z.number().int().min(1).max(200),
    width: z.number().positive().max(2048),
    rise: z.number().positive().max(100),
    run: z.number().positive().max(100),
    start: vec3.describe('Bottom-center of the first step\'s front edge'),
    yaw: num.optional().describe('Climb direction in degrees; 0 climbs toward +Z'),
    part: templateSchema.optional(),
  }),
  z.object({
    kind: z.literal('arch'),
    name,
    span: z.number().positive().max(2048).describe('Inner width at the springline'),
    thickness: z.number().positive().max(512),
    depth: z.number().positive().max(2048),
    segments: z.number().int().min(3).max(64),
    center: vec3.describe('Ground point under the middle of the arch'),
    pillarHeight: z.number().min(0).max(2048).optional().describe('Pillars under both ends; the arch starts at this height'),
    yaw: num.optional(),
    part: templateSchema.optional(),
  }),
  z.object({
    kind: z.literal('wall'),
    name,
    from: z.tuple([num, num]).describe('[x, z] start'),
    to: z.tuple([num, num]).describe('[x, z] end'),
    y: num.describe('Base height'),
    height: z.number().positive().max(2048),
    thickness: z.number().positive().max(512),
    openings: z
      .array(z.object({ at: z.number().min(0).describe('Distance of the opening center from `from`'), width: z.number().positive(), height: z.number().positive(), bottom: z.number().min(0).optional() }))
      .max(50)
      .optional(),
    part: templateSchema.optional(),
  }),
]);

const csgSchema = z.object({
  op: z.enum(['subtract', 'union', 'intersect']),
  target: name,
  with: z.array(name).min(1).max(50),
  name: name.optional().describe('Name of the result (defaults to the target name)'),
  collision: z.enum(['Default', 'Hull', 'Box', 'PreciseConvexDecomposition']).optional(),
});

export const geometrySpecSchema = z.object({
  name: name.describe('Model name; also the world/ file name'),
  parent: z.string().regex(/^[A-Za-z][A-Za-z0-9_ .-]{0,200}$/).optional().describe('Instance path of the parent (default Workspace)'),
  pivot: vec3.optional().describe('World position of the model origin'),
  yaw: num.optional().describe('Model rotation about Y in degrees'),
  defaults: templateSchema.omit({ size: true }).optional().describe('Look applied to every part unless overridden'),
  parts: z.array(partSchema).max(MAX_PARTS).optional(),
  generators: z.array(generatorSchema).max(200).optional(),
  csg: z.array(csgSchema).max(100).optional(),
  attributes: attrs.optional().describe('Model attributes (tunable parameters)'),
  tags: tags.optional(),
});

export type GeometrySpec = z.infer<typeof geometrySpecSchema>;
type Template = z.infer<typeof templateSchema>;

/** A fully resolved part, as embedded in the builder. */
export interface BuiltPart {
  name: string;
  shape: 'Block' | 'Ball' | 'Cylinder' | 'Wedge' | 'CornerWedge';
  size: [number, number, number];
  pos: [number, number, number];
  rot: [number, number, number];
  color: string;
  material: string;
  materialVariant?: string;
  transparency: number;
  reflectance: number;
  anchored: boolean;
  canCollide: boolean;
  castShadow: boolean;
  group?: string;
  attributes?: Record<string, string | number | boolean>;
  tags?: string[];
}

export interface ExpandedGeometry {
  name: string;
  parent: string;
  pivot: [number, number, number];
  yaw: number;
  parts: BuiltPart[];
  csg: Array<z.infer<typeof csgSchema>>;
  attributes: Record<string, string | number | boolean>;
  tags: string[];
  hash: string;
}

const round = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
};
const r3 = (v: readonly number[]): [number, number, number] => [round(v[0]!), round(v[1]!), round(v[2]!)];
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function hex(c: z.infer<typeof color> | undefined, fallback: string): string {
  if (c === undefined) return fallback;
  if (Array.isArray(c)) return c.map((n) => n.toString(16).padStart(2, '0')).join('');
  return c.replace(/^#/, '').toLowerCase();
}

/** Rotates a local offset about +Y by `yaw` degrees, like CFrame.Angles(0, yaw, 0). */
export function rotateY([x, y, z]: readonly number[], yawDeg: number): [number, number, number] {
  const t = rad(yawDeg);
  return [x! * Math.cos(t) + z! * Math.sin(t), y!, -x! * Math.sin(t) + z! * Math.cos(t)];
}

const add = (a: readonly number[], b: readonly number[]): [number, number, number] => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];

/** Validates and expands a spec: generators become parts, defaults are applied, names and CSG references are checked. */
export function expandGeometry(input: unknown): ExpandedGeometry {
  const spec = geometrySpecSchema.parse(input);
  const d = spec.defaults ?? {};
  const out: BuiltPart[] = [];
  const make = (partName: string, t: Template, size: readonly number[], pos: readonly number[], rot?: readonly number[]): void => {
    const shape = t.shape ?? d.shape ?? 'Block';
    out.push({
      name: partName,
      shape,
      size: r3(size),
      pos: r3(pos),
      rot: r3(rot ?? t.rot ?? d.rot ?? [0, 0, 0]),
      color: hex(t.color ?? d.color, 'a3a2a5'),
      material: t.material ?? d.material ?? 'SmoothPlastic',
      ...((t.materialVariant ?? d.materialVariant) ? { materialVariant: t.materialVariant ?? d.materialVariant } : {}),
      transparency: t.transparency ?? d.transparency ?? 0,
      reflectance: t.reflectance ?? d.reflectance ?? 0,
      anchored: t.anchored ?? d.anchored ?? true,
      canCollide: t.canCollide ?? d.canCollide ?? true,
      castShadow: t.castShadow ?? d.castShadow ?? true,
      ...((t.group ?? d.group) ? { group: t.group ?? d.group } : {}),
      ...(t.attributes || d.attributes ? { attributes: { ...(d.attributes ?? {}), ...(t.attributes ?? {}) } } : {}),
      ...(t.tags || d.tags ? { tags: [...new Set([...(d.tags ?? []), ...(t.tags ?? [])])] } : {}),
    });
  };

  for (const p of spec.parts ?? []) make(p.name, p, p.size, p.pos, p.rot);

  for (const g of spec.generators ?? []) {
    switch (g.kind) {
      case 'array':
        for (let i = 0; i < g.count; i++) {
          const rot = add(g.part.rot ?? [0, 0, 0], (g.rotStep ?? [0, 0, 0]).map((v) => v * i));
          make(`${g.name}_${i + 1}`, g.part, g.part.size, add(g.start, g.step.map((v) => v * i)), rot);
        }
        break;
      case 'grid':
        for (let ix = 0; ix < g.countX; ix++)
          for (let iz = 0; iz < g.countZ; iz++) make(`${g.name}_${ix + 1}_${iz + 1}`, g.part, g.part.size, add(g.start, [ix * g.spacing[0], 0, iz * g.spacing[1]]));
        break;
      case 'ring':
        for (let i = 0; i < g.count; i++) {
          const a = (g.startAngle ?? 0) + (360 * i) / g.count;
          const pos = add(g.center, [g.radius * Math.cos(rad(a)), 0, g.radius * Math.sin(rad(a))]);
          const base = g.part.rot ?? [0, 0, 0];
          // LookVector of Orientation (0, ry, 0) is (-sin ry, 0, -cos ry); facing the center needs ry = 90 - a.
          const rot: [number, number, number] = g.faceCenter ? [base[0], 90 - a + base[1], base[2]] : [base[0], base[1], base[2]];
          make(`${g.name}_${i + 1}`, g.part, g.part.size, pos, rot);
        }
        break;
      case 'stairs': {
        const yaw = g.yaw ?? 0;
        for (let i = 0; i < g.steps; i++) {
          const h = g.rise * (i + 1);
          const local: [number, number, number] = [0, h / 2, g.run * i + g.run / 2];
          make(`${g.name}_${i + 1}`, g.part ?? {}, [g.width, h, g.run], add(g.start, rotateY(local, yaw)), [0, yaw, 0]);
        }
        break;
      }
      case 'arch': {
        const yaw = g.yaw ?? 0;
        const inner = g.span / 2;
        const rc = inner + g.thickness / 2;
        const ph = g.pillarHeight ?? 0;
        const step = 180 / g.segments;
        // Chord at the outer edge plus a little overlap so segments close without gaps.
        const len = 2 * (inner + g.thickness) * Math.sin(rad(step / 2)) * 1.02;
        for (let k = 0; k < g.segments; k++) {
          const a = step * (k + 0.5);
          const local: [number, number, number] = [rc * Math.cos(rad(a)), ph + rc * Math.sin(rad(a)), 0];
          make(`${g.name}_${k + 1}`, g.part ?? {}, [len, g.thickness, g.depth], add(g.center, rotateY(local, yaw)), [0, yaw, a + 90]);
        }
        if (ph > 0) {
          for (const [i, sx] of [-1, 1].entries()) {
            make(`${g.name}_Pillar${i + 1}`, g.part ?? {}, [g.thickness, ph, g.depth], add(g.center, rotateY([sx * rc, ph / 2, 0], yaw)), [0, yaw, 0]);
          }
        }
        break;
      }
      case 'wall': {
        const [x1, z1] = g.from;
        const [x2, z2] = g.to;
        const dx = x2 - x1;
        const dz = z2 - z1;
        const L = Math.hypot(dx, dz);
        if (L < 0.05) throw new Error(`wall ${g.name}: from and to are the same point`);
        // Local +X of Orientation (0, θ, 0) is (cos θ, 0, -sin θ); align it with the wall direction.
        const theta = deg(Math.atan2(-dz, dx));
        const seg = (label: string, s0: number, s1: number, bottom: number, height: number) => {
          if (s1 - s0 < 0.01 || height < 0.01) return;
          const c = (s0 + s1) / 2;
          make(`${g.name}_${label}`, g.part ?? {}, [s1 - s0, height, g.thickness], [x1 + (dx / L) * c, g.y + bottom + height / 2, z1 + (dz / L) * c], [0, theta, 0]);
        };
        const openings = [...(g.openings ?? [])].sort((a, b) => a.at - b.at);
        let cursor = 0;
        openings.forEach((o, i) => {
          const s0 = o.at - o.width / 2;
          const s1 = o.at + o.width / 2;
          const bottom = o.bottom ?? 0;
          if (s0 < cursor - 1e-6 || s1 > L + 1e-6) throw new Error(`wall ${g.name}: opening ${i + 1} overlaps another opening or the wall ends`);
          if (bottom + o.height > g.height + 1e-6) throw new Error(`wall ${g.name}: opening ${i + 1} is taller than the wall`);
          seg(`Seg${i + 1}`, cursor, s0, 0, g.height);
          seg(`Sill${i + 1}`, s0, s1, 0, bottom);
          seg(`Lintel${i + 1}`, s0, s1, bottom + o.height, g.height - bottom - o.height);
          cursor = s1;
        });
        seg(`Seg${openings.length + 1}`, cursor, L, 0, g.height);
        break;
      }
    }
  }

  if (out.length === 0) throw new Error('The spec has no parts: add parts or generators');
  if (out.length > MAX_PARTS) throw new Error(`The spec expands to ${out.length} parts; the limit is ${MAX_PARTS}. Split it into several models.`);
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const p of out) (seen.has(p.name) ? dup : seen).add(p.name);
  if (dup.size) throw new Error(`Duplicate part names: ${[...dup].slice(0, 10).join(', ')}. Names must be unique (CSG refers to parts by name).`);
  const csg = spec.csg ?? [];
  const alive = new Set(seen);
  for (const op of csg) {
    for (const n of [op.target, ...op.with]) if (!alive.has(n)) throw new Error(`CSG ${op.op}: no part named "${n}" at that point (operands are consumed by earlier operations)`);
    if (op.with.includes(op.target)) throw new Error(`CSG ${op.op}: "${op.target}" cannot be both target and operand`);
    for (const n of [op.target, ...op.with]) alive.delete(n);
    alive.add(op.name ?? op.target);
  }
  const expanded = {
    name: spec.name,
    parent: spec.parent ?? 'Workspace',
    pivot: r3(spec.pivot ?? [0, 0, 0]),
    yaw: round(spec.yaw ?? 0),
    parts: out,
    csg,
    attributes: spec.attributes ?? {},
    tags: spec.tags ?? [],
  };
  const hash = createHash('sha1').update(JSON.stringify(expanded)).digest('hex').slice(0, 16);
  return { ...expanded, hash };
}

/** File stem for the world/ files of a model. */
export function geometryFileStem(modelName: string): string {
  return modelName.replace(/[^A-Za-z0-9_-]+/g, '_');
}

export const GEOMETRY_MARKER = '-- shuriken:geometry';

/** The builder script: a fixed interpreter plus the expanded spec as data. Idempotent. */
export function compileGeometry(g: ExpandedGeometry, specFile: string): string {
  const json = JSON.stringify(g);
  if (json.includes(']==]')) throw new Error('Spec contains the sequence ]==], which cannot be embedded');
  return `--!nocheck
${GEOMETRY_MARKER} ${g.hash}
-- Generated by Shuriken from ${specFile}. Edit the spec and apply it with geometry_apply; do not edit this file.
-- Idempotent: running it again replaces the model with a fresh build.
local HttpService = game:GetService("HttpService")
local GeometryService = game:GetService("GeometryService")
local CollectionService = game:GetService("CollectionService")
local SPEC = HttpService:JSONDecode([==[${json}]==])
local REPLACE_FOREIGN = __REPLACE__

local function resolve(path)
  local inst = game
  for seg in string.gmatch(path, "[^%.]+") do
    if not (inst == game and seg == "game") then
      local nxt = inst:FindFirstChild(seg)
      if nxt == nil and inst == game then
        local ok, svc = pcall(function() return game:GetService(seg) end)
        if ok then nxt = svc end
      end
      if nxt == nil then return nil end
      inst = nxt
    end
  end
  return inst
end

local parent = resolve(SPEC.parent)
assert(parent, "geometry: parent not found: " .. SPEC.parent)
local old = parent:FindFirstChild(SPEC.name)
if old then
  if old:GetAttribute("ShurikenGeometry") == nil and not REPLACE_FOREIGN then
    error("geometry: " .. old:GetFullName() .. " exists and was not built from a geometry spec; rename the spec or pass replace_existing")
  end
  old:Destroy()
end

local root = Instance.new("Model")
root.Name = SPEC.name
local base = CFrame.new(SPEC.pivot[1], SPEC.pivot[2], SPEC.pivot[3]) * CFrame.Angles(0, math.rad(SPEC.yaw), 0)
local groups = {}
local function groupOf(path)
  if path == nil or path == "" then return root end
  if groups[path] then return groups[path] end
  local cur = root
  for seg in string.gmatch(path, "[^/]+") do
    local nxt = cur:FindFirstChild(seg)
    if nxt == nil then
      nxt = Instance.new("Model")
      nxt.Name = seg
      nxt.Parent = cur
    end
    cur = nxt
  end
  groups[path] = cur
  return cur
end

local parts = {}
for _, s in ipairs(SPEC.parts) do
  local p
  if s.shape == "Wedge" then
    p = Instance.new("WedgePart")
  elseif s.shape == "CornerWedge" then
    p = Instance.new("CornerWedgePart")
  else
    p = Instance.new("Part")
    p.Shape = Enum.PartType[s.shape]
  end
  p.Name = s.name
  p.Size = Vector3.new(s.size[1], s.size[2], s.size[3])
  p.CFrame = base * CFrame.new(s.pos[1], s.pos[2], s.pos[3]) * CFrame.fromOrientation(math.rad(s.rot[1]), math.rad(s.rot[2]), math.rad(s.rot[3]))
  p.Color = Color3.fromHex(s.color)
  p.Material = Enum.Material[s.material]
  if s.materialVariant then p.MaterialVariant = s.materialVariant end
  p.Transparency = s.transparency
  p.Reflectance = s.reflectance
  p.Anchored = s.anchored
  p.CanCollide = s.canCollide
  p.CastShadow = s.castShadow
  p.TopSurface = Enum.SurfaceType.Smooth
  p.BottomSurface = Enum.SurfaceType.Smooth
  if s.attributes then for k, v in pairs(s.attributes) do p:SetAttribute(k, v) end end
  if s.tags then for _, t in ipairs(s.tags) do CollectionService:AddTag(p, t) end end
  p.Parent = groupOf(s.group)
  parts[s.name] = p
end

for _, op in ipairs(SPEC.csg) do
  local target = parts[op.target]
  local others = {}
  for _, n in ipairs(op.with) do table.insert(others, parts[n]) end
  local method = op.op == "subtract" and "SubtractAsync" or (op.op == "intersect" and "IntersectAsync" or "UnionAsync")
  local results = GeometryService[method](GeometryService, target, others, {
    SplitApart = false,
    CollisionFidelity = Enum.CollisionFidelity[op.collision or "Default"],
  })
  local u = results[1]
  assert(u, "geometry: " .. op.op .. " of " .. op.target .. " produced no result")
  u.Name = op.name or op.target
  u.Anchored = target.Anchored
  u.Parent = target.Parent
  target:Destroy()
  for _, o in ipairs(others) do o:Destroy() end
  for _, n in ipairs(op.with) do parts[n] = nil end
  parts[op.target] = nil
  parts[u.Name] = u
end

root.WorldPivot = base
for k, v in pairs(SPEC.attributes) do root:SetAttribute(k, v) end
root:SetAttribute("ShurikenGeometry", SPEC.hash)
CollectionService:AddTag(root, "ShurikenGeometry_" .. string.gsub(SPEC.name, "[^%w_%-]", "_"))
for _, t in ipairs(SPEC.tags) do CollectionService:AddTag(root, t) end
root.Parent = parent

local count = 0
for _, d in ipairs(root:GetDescendants()) do
  if d:IsA("BasePart") then count += 1 end
end
return HttpService:JSONEncode({ path = root:GetFullName(), parts = count, hash = SPEC.hash })
`;
}

/** Usage tag the builder puts on the model root. */
export function geometryTag(modelName: string): string {
  return `ShurikenGeometry_${modelName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
