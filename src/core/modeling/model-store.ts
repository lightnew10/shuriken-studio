import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRig, type RigSpec } from '@shared/rig';
import type { Emission, ModelInstance, TextureMaps } from './backend';
import { GLB_FACING } from './glb';
import { FX_FN, fxTable, partFx, type PartFx, type PartRole } from './part-traits';

export const MODEL_DIR = 'models';
export const MODELS_BUILDER_REL = 'world/Models.luau';

export interface ModelPlacement {
  /** Instance name in Studio. */
  name: string;
  parent: string;
  position: [number, number, number];
  /** Orientation in degrees (like Part.Orientation). */
  rotation: [number, number, number];
  /** Scale on top of the modeled size. */
  scale: number;
  color?: string;
  material?: string;
  /** Part of a whole model placed as one Roblox Model: the last segment of `parent` is that Model. */
  group?: boolean;
}

/** A default Roblox character is about this many studs tall (models are judged against it). */
export const PLAYER_STUDS = 5.2;

/** models/<Name>.model.json: what a build produced and where the model is placed. */
export interface ModelMeta {
  name: string;
  description?: string;
  /** Hash of the script + settings that produced the mesh. */
  hash: string;
  size: [number, number, number];
  triangles: number;
  vertices: number;
  volume: number | null;
  faces: number;
  solids: number;
  valid: boolean | null;
  tolerance: number | null;
  /**
   * Roblox asset (a Model holding the MeshPart) once uploaded, for the current hash. `operation`: Roblox
   * took the upload and is still processing it (the Open Cloud operation id): the next model_place /
   * rig_build / model_gear resolves it instead of uploading the part again. `facing`: the upload pipeline that
   * made it — 2 is an upload of a GLB turned 180° about Y first (Roblox's importer turns it back, see glb.ts);
   * a record without it is a legacy upload whose mesh arrives turned about its own centre, which the builders
   * Shuriken generates turn back (`ModelStore.legacyUpload`).
   */
  upload?: { assetId: string; hash: string; at: string; facing?: number } | { error: string; at: string; hash: string } | { operation: string; at: string; hash: string; facing?: number };
  placements: ModelPlacement[];
  asset?: string;
  /** How it looks (hex colour, Enum.Material name, Transparency): the preview, and model_place's default. */
  color?: string;
  material?: string;
  transparency?: number;
  /** Where it came from: a Blender scene (models/<blend>) or, before Blender, a build123d script. */
  source?: 'blender' | 'build123d';
  blend?: string;
  /** The asset this is one part of (parts with the same name show together, each at its origin). */
  assembly?: string;
  /** Where its centre sits within the assembly (Y-up studs). */
  origin?: [number, number, number];
  /** A rigged model's part: the segment (joint) of models/<assembly>.rig.json it moves with. */
  segment?: string;
  /** A part the game's code finds by name (kiln_part in the scene): its own MeshPart, named <assembly>_<own>. */
  own?: string;
  /** Its material's image maps (PNG files in models/): its mesh has UVs, Roblox gets a SurfaceAppearance. */
  textures?: TextureMaps;
  /** How a textured part glows (the SurfaceAppearance's emissive strength and tint). */
  emission?: Emission;
  /**
   * The export found it open (a sheet: leaf cards, road strips) or paper-thin, or flat and facing down: Roblox draws
   * a face only from its front, so the generated Luau sets MeshPart.DoubleSided (see part-traits.ts).
   */
  doubleSided?: boolean;
  /** Flat objects whose faces point down (invisible from above): the names the export listed (the check tools say so). */
  facesDown?: string[];
  /**
   * What the part is for (the objects' custom property kiln_role, or a guess from their names and materials; see
   * part-traits.ts): the generated Luau sets its collision from it. A part holds objects of one role only.
   */
  role?: PartRole;
  /** The role was guessed (no kiln_role property on its objects). */
  roleInferred?: boolean;
  /** A collider part stands in for it: it doesn't collide itself. */
  replaced?: boolean;
  /** Its mesh is exactly a box (in its own frame): collision Box is exact. */
  box?: boolean;
  /** The share of its box a closed mesh fills (0-1): a chunky barrier collides as a hull. */
  fill?: number;
  /**
   * Where each use of this mesh sits (see ExportedPart.instances): the part is uploaded once and the generated Luau clones its
   * MeshPart per use. model_place / world/Models.luau then place the model's pivot once and each use relative to it.
   */
  instances?: ModelInstance[];
  updatedAt: string;
}

/**
 * A model's file: pretty-printed JSON, except that an instanced part's `instances` (hundreds of uses, three short arrays each)
 * go one use per line, so a mesh placed a thousand times is a file of a thousand lines, not of twelve thousand.
 */
export function metaJson(m: ModelMeta): string {
  const { instances, ...rest } = m;
  const text = JSON.stringify(rest, null, 2);
  if (!instances?.length) return `${text}\n`;
  const rows = instances.map((i) => `    ${JSON.stringify(i)}`).join(',\n');
  return `${text.slice(0, -2)},\n  "instances": [\n${rows}\n  ]\n}\n`;
}

export const modelHash = (code: string, tolerance: number | null | undefined) => createHash('sha1').update(`${tolerance ?? ''}\n${code}`).digest('hex').slice(0, 12);

/**
 * Model files as last read, by path, while their time and size are unchanged. A big game has 800+ models, and the
 * Models container and the suggestion digest read them all: 400 ms of the core's one thread each time.
 */
const META_CACHE = new Map<string, { stamp: string; meta: ModelMeta }>();

export class ModelStore {
  constructor(private readonly root: string) {}

  dir(): string {
    return join(this.root, MODEL_DIR);
  }

  paths(name: string) {
    const d = this.dir();
    return { code: join(d, `${name}.py`), glb: join(d, `${name}.glb`), mesh: join(d, `${name}.mesh.json`), meta: join(d, `${name}.model.json`) };
  }

  names(): string[] {
    if (!existsSync(this.dir())) return [];
    return readdirSync(this.dir())
      .filter((f) => f.endsWith('.model.json'))
      .map((f) => f.slice(0, -'.model.json'.length))
      .sort((a, b) => a.localeCompare(b));
  }

  get(name: string): ModelMeta | null {
    const f = this.paths(name).meta;
    let stamp: string;
    try {
      const st = statSync(f);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
    const known = META_CACHE.get(f);
    // A copy: callers may change what they get.
    if (known?.stamp === stamp) return structuredClone(known.meta);
    try {
      const meta = JSON.parse(readFileSync(f, 'utf8')) as ModelMeta;
      if (META_CACHE.size > 20_000) META_CACHE.clear();
      META_CACHE.set(f, { stamp, meta });
      return structuredClone(meta);
    } catch {
      return null;
    }
  }

  code(name: string): string | null {
    const f = this.paths(name).code;
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }

  /** The parts of an assembly (models built with that assembly name), by name. */
  parts(assembly: string): ModelMeta[] {
    return this.all().filter((m) => m.assembly === assembly);
  }

  all(): ModelMeta[] {
    return this.names()
      .map((n) => this.get(n))
      .filter((m): m is ModelMeta => !!m);
  }

  writeCode(name: string, code: string): void {
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(this.paths(name).code, code.endsWith('\n') ? code : `${code}\n`, 'utf8');
  }

  /** `deferBuilder`: the caller saves many parts and writes world/Models.luau once afterwards (writeBuilder reads every model). */
  save(meta: Omit<ModelMeta, 'updatedAt'>, opts: { deferBuilder?: boolean } = {}): ModelMeta {
    mkdirSync(this.dir(), { recursive: true });
    const m: ModelMeta = { ...meta, updatedAt: new Date().toISOString() };
    writeFileSync(this.paths(meta.name).meta, metaJson(m), 'utf8');
    if (!opts.deferBuilder) this.writeBuilder();
    return m;
  }

  remove(name: string): boolean {
    const p = this.paths(name);
    if (!existsSync(p.meta)) return false;
    for (const f of Object.values(p)) rmSync(f, { force: true });
    this.writeBuilder();
    return true;
  }

  /** Removes models by part name, or every part of a multi-part model by its name (and its rig). */
  removeMany(names: string[]): { removed: string[]; missing: string[] } {
    const removed: string[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const whole = !this.get(n);
      const targets = whole ? this.parts(n).map((m) => m.name) : [n];
      if (!targets.length) missing.push(n);
      for (const t of targets) if (this.remove(t)) removed.push(t);
      if (whole && targets.length) rmSync(this.rigFile(n), { force: true });
    }
    return { removed, missing };
  }

  /** models/<Model>.rig.json: the rig of a model rigged with kiln.rig (see @shared/rig). */
  rigFile(model: string): string {
    return join(this.dir(), `${model}.rig.json`);
  }

  rig(model: string): RigSpec | null {
    try {
      const r = parseRig(JSON.parse(readFileSync(this.rigFile(model), 'utf8')));
      return typeof r === 'string' ? null : r;
    } catch {
      return null;
    }
  }

  /** Every rigged model's rig, by model name. */
  rigs(): Record<string, RigSpec> {
    const out: Record<string, RigSpec> = {};
    if (!existsSync(this.dir())) return out;
    for (const f of readdirSync(this.dir())) {
      const m = /^(.+)\.rig\.json$/.exec(f);
      if (!m) continue;
      const r = this.rig(m[1]!);
      if (r) out[m[1]!] = r;
    }
    return out;
  }

  /** The uploaded asset id, when it matches the current build. */
  static assetId(m: ModelMeta): string | null {
    return m.upload && 'assetId' in m.upload && m.upload.hash === m.hash ? m.upload.assetId : null;
  }

  /**
   * An upload made before the importer's turn was compensated (its record has no facing marker): its mesh
   * arrives in Roblox turned 180° about Y around its own centre, so the Luau Shuriken generates turns such a
   * part back (CFrame.Angles(0, math.pi, 0) about its centre). Temporary meshes and marked uploads need nothing.
   */
  static legacyUpload(m: ModelMeta): boolean {
    return ModelStore.assetId(m) !== null && !(m.upload && 'facing' in m.upload && (m.upload.facing ?? 0) >= GLB_FACING);
  }

  /** The Open Cloud operation of an upload Roblox is still processing for the current build, if any. */
  static pendingOperation(m: ModelMeta): string | null {
    return m.upload && 'operation' in m.upload && m.upload.hash === m.hash ? m.upload.operation : null;
  }

  /** world/Models.luau: re-places every uploaded model where it was placed (idempotent). */
  writeBuilder(): string {
    const placedModels = this.all().filter((m) => ModelStore.assetId(m) && m.placements.length);
    const neon = placedModels.some((m) => m.placements.some((q) => isNeon(q.material ?? m.material)));
    const rows = placedModels
      .map((m) => `  {model=${JSON.stringify(m.name)},asset=${ModelStore.assetId(m)},size={${m.size.join(',')}}${ModelStore.legacyUpload(m) ? ',turn=true' : ''}${partFx(m) ? `,fx=${fxTable(partFx(m))}` : ''}${m.instances?.length ? `,inst=${instancesTable(m.instances)}` : ''},placements={${m.placements.map(placementTable).join(',')}}},`);
    const path = join(this.root, MODELS_BUILDER_REL);
    if (!rows.length) {
      if (existsSync(path)) rmSync(path);
      return '';
    }
    const code = `-- Generated by Shuriken Studio from models/*.model.json. Do not edit: place models with model_place.
local InsertService = game:GetService("InsertService")
local HttpService = game:GetService("HttpService")
local MODELS = {
${rows.join('\n')}
}
${PLACE_FN}
${neon ? `${BLOOM_FN}
` : ''}local placed, failed = 0, {}
for _, m in MODELS do
  for _, p in m.placements do
    if m.turn then p.turn = true end
    if m.fx and not p.fx then p.fx = m.fx end
    local ok, err
    if m.inst then
      ok, err = pcall(placeInstances, m.model, m.asset, m.size, m.inst, p)
    else
      ok, err = pcall(place, m.model, m.asset, m.size, p)
    end
    if ok then placed += 1 else table.insert(failed, m.model .. ": " .. tostring(err)) end
  end
end
${neon ? `-- Neon glows through Bloom: keep it from blinding.
local bloom = tameBloom()
` : ''}return HttpService:JSONEncode({ placed = placed, failed = failed${neon ? ', bloom = bloom' : ''} })
`;
    mkdirSync(join(this.root, 'world'), { recursive: true });
    writeFileSync(path, code, 'utf8');
    return code;
  }
}

/**
 * Bloom that keeps neon glowing without blinding. Studio's Baseplate template ships Lighting.Bloom at
 * intensity 1, size 24, threshold 2 (a new BloomEffect: 0.4, 24, 0.95 — measured); with emissive
 * (Neon) models in view that reads as blinding, so once neon is placed the bloom is brought within these
 * bounds: its intensity at most 0.5 (else 0.4), its threshold at least 1.8 (else 2: only glowing things
 * bloom, not the sky or white walls), its size at most 28 (else 18). A disabled Bloom stays off; the
 * values it had are kept in its ShurikenBloomWas attribute.
 */
export const BLOOM = { intensity: 0.4, size: 18, threshold: 2, maxIntensity: 0.5, minThreshold: 1.8, maxSize: 28 } as const;

export const isNeon = (material: string | undefined | null) => (material ?? '').toLowerCase() === 'neon';

/** Luau: tameBloom() applies BLOOM to Lighting's Bloom (adding one when there's none); returns what changed ("" if nothing). */
export const BLOOM_FN = `local function tameBloom()
  local L = game:GetService("Lighting")
  local b = L:FindFirstChildOfClass("BloomEffect")
  local function vals(x) return string.format("intensity %g, size %g, threshold %g", x.Intensity, x.Size, x.Threshold) end
  if not b then
    b = Instance.new("BloomEffect")
    b.Name = "Bloom"
    b.Intensity, b.Size, b.Threshold = ${BLOOM.intensity}, ${BLOOM.size}, ${BLOOM.threshold}
    b:SetAttribute("ShurikenBloomWas", "none")
    b.Parent = L
    return "added a gentle Lighting.Bloom for the neon (" .. vals(b) .. ")"
  end
  if not b.Enabled then return "" end
  local was = vals(b)
  local changed = false
  if b.Intensity > ${BLOOM.maxIntensity} then b.Intensity = ${BLOOM.intensity} changed = true end
  if b.Threshold < ${BLOOM.minThreshold} then b.Threshold = ${BLOOM.threshold} changed = true end
  if b.Size > ${BLOOM.maxSize} then b.Size = ${BLOOM.size} changed = true end
  if not changed then return "" end
  if b:GetAttribute("ShurikenBloomWas") == nil then b:SetAttribute("ShurikenBloomWas", was) end
  return "toned Lighting.Bloom down so the neon doesn't blind (" .. was .. " -> " .. vals(b) .. ")"
end`;

/** Luau: an instanced part's uses as one flat array, nine numbers each (x, y, z, rx, ry, rz in degrees, sx, sy, sz). */
export function instancesTable(list: ModelInstance[]): string {
  const n = (x: number) => String(Math.round(x * 10000) / 10000);
  return `{${list.map((i) => [...i.position, ...i.rotation, ...i.scale].map(n).join(',')).join(',\n')}}`;
}

function placementTable(p: ModelPlacement): string {
  return `{name=${JSON.stringify(p.name)},parent=${JSON.stringify(p.parent)},pos={${p.position.join(',')}},rot={${p.rotation.join(',')}},scale=${p.scale}${p.color ? `,color=${JSON.stringify(p.color)}` : ''}${p.material ? `,material=${JSON.stringify(p.material)}` : ''}${p.group ? ',group=true' : ''}}`;
}

/**
 * Luau: place(modelName, assetId, size, placement) — loads the uploaded asset once, finds its MeshPart,
 * and puts a copy at the placement (replacing an earlier copy with the same name under the parent).
 */
/**
 * Luau: settle(mp, onGround) — optionally rests the part (or a whole Model, by its bounding box) on the
 * highest upward-facing surface that is at most 1 stud above its top (so roofs and canopies overhead
 * are ignored, a model sunk into a dais rises onto it, a floating one drops), then lists what it still
 * overlaps. Returns JSON-able info.
 */
export const SETTLE_FN = `local function settle(mp, mode)
  if mode == true then mode = "ground" elseif mode ~= "wall" and mode ~= "ground" then mode = "none" end
  local info = { notes = {} }
  local isPart = mp:IsA("BasePart")
  local function box()
    if isPart then return mp.CFrame, mp.Size end
    return mp:GetBoundingBox()
  end
  -- Put the box at \`to\` (a Model moves by its pivot, keeping its parts' arrangement).
  local function moveBox(from, to)
    if isPart then mp.CFrame = to else mp:PivotTo(to * from:Inverse() * mp:GetPivot()) end
  end
  local cf, s = box()
  local half = (math.abs(cf.RightVector.Y) * s.X + math.abs(cf.UpVector.Y) * s.Y + math.abs(cf.LookVector.Y) * s.Z) / 2
  if mode == "wall" then
    -- Against the wall behind it (its back, -LookVector), or the nearest wall around it, facing out.
    local params = RaycastParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = { mp }
    local function wallAlong(dir)
      local hit = workspace:Raycast(cf.Position, dir * 16, params)
      if hit and math.abs(hit.Normal.Y) < 0.5 and (hit.Instance == workspace.Terrain or hit.Instance.CanCollide) then return hit end
      return nil
    end
    local back = Vector3.new(-cf.LookVector.X, 0, -cf.LookVector.Z)
    local found = if back.Magnitude > 0.01 then wallAlong(back.Unit) else nil
    if not found then
      for i = 0, 7 do
        local a = i * math.pi / 4
        local hit = wallAlong(Vector3.new(math.cos(a), 0, math.sin(a)))
        if hit and (not found or hit.Distance < found.Distance) then found = hit end
      end
    end
    if found then
      local n = Vector3.new(found.Normal.X, 0, found.Normal.Z).Unit
      local center = Vector3.new(found.Position.X, cf.Position.Y, found.Position.Z) + n * (s.Z / 2 + 0.02)
      moveBox(cf, CFrame.lookAt(center, center + n))
      table.insert(info.notes, string.format("mounted on %s, facing away from it", found.Instance:GetFullName()))
    else
      table.insert(info.notes, "no wall within 16 studs: left where it was")
    end
  end
  if mode == "ground" then
    local params = RaycastParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    local ignore = { mp }
    local origin = cf.Position + Vector3.new(0, half + 1, 0)
    local rest = nil
    for _ = 1, 12 do
      params.FilterDescendantsInstances = ignore
      local hit = workspace:Raycast(origin, Vector3.new(0, -1000, 0), params)
      if not hit then break end
      if hit.Normal.Y > 0.5 and (hit.Instance == workspace.Terrain or hit.Instance.CanCollide) then
        rest = hit
        break
      end
      table.insert(ignore, hit.Instance)
    end
    if rest then
      moveBox(cf, cf + Vector3.new(0, rest.Position.Y + half - cf.Position.Y, 0))
      table.insert(info.notes, string.format("rests on %s (surface at y=%.2f)", rest.Instance:GetFullName(), rest.Position.Y))
    else
      table.insert(info.notes, "nothing solid below it: left where it was")
    end
  end
  local op = OverlapParams.new()
  op.FilterType = Enum.RaycastFilterType.Exclude
  op.FilterDescendantsInstances = { mp }
  local inset = Vector3.new(0.3, 0.3, 0.3)
  local names = {}
  local bcf, bs = box()
  for _, h in workspace:GetPartBoundsInBox(bcf, bs - inset, op) do
    if h ~= workspace.Terrain and h.CanCollide and #names < 6 then table.insert(names, h:GetFullName()) end
  end
  if #names > 0 then table.insert(info.notes, "overlaps " .. table.concat(names, ", ") .. " — move it or make room") end
  local at = if isPart then mp.CFrame else mp:GetPivot()
  local p = at.Position
  info.position = { math.round(p.X * 100) / 100, math.round(p.Y * 100) / 100, math.round(p.Z * 100) / 100 }
  local rx, ry, rz = at:ToOrientation()
  info.rotation = { math.round(math.deg(rx) * 10) / 10, math.round(math.deg(ry) * 10) / 10, math.round(math.deg(rz) * 10) / 10 }
  info.path = mp:GetFullName()
  return info
end`;

export const PLACE_FN = `${FX_FN}
local cache = {}
-- The last segment may be created as a Model (an assembly's parts live in one).
local function resolveParent(path, lastClass)
  local inst = game
  local segs = string.split(path, ".")
  for i, seg in segs do
    local nxt = inst:FindFirstChild(seg)
    if not nxt and inst == game then
      local ok, svc = pcall(function() return game:GetService(seg) end)
      if ok then nxt = svc end
    end
    if not nxt then
      nxt = Instance.new(if i == #segs and lastClass then lastClass else "Folder")
      nxt.Name = seg
      nxt.Parent = inst
    end
    inst = nxt
  end
  return inst
end
local function meshOf(assetId)
  if cache[assetId] then return cache[assetId] end
  local container = InsertService:LoadAsset(assetId)
  local mesh = container:FindFirstChildWhichIsA("MeshPart", true)
  if not mesh then
    container:Destroy()
    error("asset " .. assetId .. " has no MeshPart (still processing?)")
  end
  mesh.Parent = nil
  container:Destroy()
  cache[assetId] = mesh
  return mesh
end
-- The copies placed before, wherever they are now and whatever they are called: a later builder may have grouped,
-- renamed or turned them (in one build every unit template held its art twice after a rerun, the parts a finishing
-- builder had renamed "PlugBot_Team" → "Team" placed anew beside them, hiding the team colour). Each part carries the
-- name it was placed under (ShurikenPart); only this model's own go.
local function clearOld(parent, name, modelName)
  local old = parent:FindFirstChild(name)
  if old and old:GetAttribute("ShurikenModel") == modelName then old:Destroy() end
  for _, d in parent:GetDescendants() do
    if d.Parent and d:GetAttribute("ShurikenModel") == modelName and (d:GetAttribute("ShurikenPart") == name or d.Name == name) then d:Destroy() end
  end
end
function place(modelName, assetId, size, p)
  local parent = resolveParent(p.parent, p.group and "Model" or nil)
  clearOld(parent, p.name, modelName)
  local mp = meshOf(assetId):Clone()
  mp.Name = p.name
  mp.Anchored = true
  mp.Size = Vector3.new(size[1], size[2], size[3]) * (p.scale or 1)
  mp.CFrame = CFrame.new(p.pos[1], p.pos[2], p.pos[3]) * CFrame.fromOrientation(math.rad(p.rot[1]), math.rad(p.rot[2]), math.rad(p.rot[3]))
  -- A legacy upload (made before the importer's 180° turn was compensated, see glb.ts) arrives turned about its
  -- own centre: turn it back. Marked uploads and temporary meshes need nothing.
  if p.turn then
    mp.CFrame = mp.CFrame * CFrame.Angles(0, math.pi, 0)
    mp:SetAttribute("ShurikenTurned", true)
  end
  if p.color then mp.Color = Color3.fromHex(p.color) end
  if p.material then mp.Material = Enum.Material[p.material] end
  applyFx(mp, p.fx)
  mp:SetAttribute("ShurikenModel", modelName)
  mp:SetAttribute("ShurikenPart", p.name)
  mp.Parent = parent
  return mp
end
-- A mesh used many times (see ModelMeta.instances): one MeshPart per use, cloned from the one uploaded mesh. inst holds nine
-- numbers per use (position, orientation in degrees, scale); they are relative to the placement's pivot (p.pos / p.rot), which
-- p.scale scales. The uses go into one Folder named p.name.
function placeInstances(modelName, assetId, size, inst, p)
  local parent = resolveParent(p.parent, p.group and "Model" or nil)
  clearOld(parent, p.name, modelName)
  local base = meshOf(assetId)
  local folder = Instance.new("Folder")
  folder.Name = p.name
  folder:SetAttribute("ShurikenModel", modelName)
  folder:SetAttribute("ShurikenPart", p.name)
  folder:SetAttribute("ShurikenInstances", #inst // 9)
  local k = p.scale or 1
  local pivot = CFrame.new(p.pos[1], p.pos[2], p.pos[3]) * CFrame.fromOrientation(math.rad(p.rot[1]), math.rad(p.rot[2]), math.rad(p.rot[3]))
  local color = if p.color then Color3.fromHex(p.color) else nil
  for i = 1, #inst, 9 do
    local mp = base:Clone()
    mp.Name = p.name .. "_" .. ((i + 8) // 9)
    mp.Anchored = true
    mp.Size = Vector3.new(size[1] * inst[i + 6], size[2] * inst[i + 7], size[3] * inst[i + 8]) * k
    local cf = pivot * (CFrame.new(inst[i] * k, inst[i + 1] * k, inst[i + 2] * k) * CFrame.fromOrientation(math.rad(inst[i + 3]), math.rad(inst[i + 4]), math.rad(inst[i + 5])))
    -- A legacy upload arrives turned 180° about its own centre (glb.ts): turned back, as place() does.
    if p.turn then cf = cf * CFrame.Angles(0, math.pi, 0) end
    mp.CFrame = cf
    if color then mp.Color = color end
    if p.material then mp.Material = Enum.Material[p.material] end
    applyFx(mp, p.fx)
    mp:SetAttribute("ShurikenModel", modelName)
    mp.Parent = folder
  end
  folder.Parent = parent
  return folder
end`;

/** The mesh JSON's normals when it has one per vertex (Blender's corner normals, split where the shading breaks). */
export const meshNormals = (mesh: { v: number[]; n?: number[] }): number[] | null => (mesh.n && mesh.n.length > 0 && mesh.n.length === mesh.v.length ? mesh.n : null);

/**
 * Luau: setNormals(em, faces, N, T) gives an EditableMesh the normals the model was exported with: N holds
 * three numbers per vertex (the mesh JSON's "n"), T the triangles' vertex indices, faces the face id
 * AddTriangle made for each triangle. Without them EditableMesh computes its own per vertex, and the
 * vertices split along every UV seam are shaded from their own side only (a visible line). Guarded: a Studio
 * without AddNormal / SetFaceNormals still builds the mesh, shaded its own way.
 */
export const NORMALS_FN = `local function setNormals(em, faces, N, T)
  pcall(function()
    local ids = table.create(#N // 3)
    for i = 1, #N, 3 do
      ids[(i + 2) // 3] = em:AddNormal(Vector3.new(N[i], N[i + 1], N[i + 2]))
    end
    for k, face in faces do
      local i = (k - 1) * 3 + 1
      em:SetFaceNormals(face, { ids[T[i] + 1], ids[T[i + 1] + 1], ids[T[i + 2] + 1] })
    end
  end)
end`;

/** Luau that builds an EditableMesh from triangles (and the MeshPart `mp0`/`em` from it): the part both temporary placements share. */
function editableMeshLuau(mesh: { v: number[]; t: number[]; uv?: number[]; n?: number[] }, meshPart: string): string {
  const r = (x: number) => String(Math.round(x * 1000) / 1000);
  const u = (x: number) => String(Math.round(x * 100000) / 100000);
  const n = meshNormals(mesh);
  return `local AssetService = game:GetService("AssetService")
${NORMALS_FN}
local V = {${mesh.v.map(r).join(',')}}
local T = {${mesh.t.join(',')}}
local U = ${mesh.uv ? `{${mesh.uv.map(u).join(',')}}` : 'nil'}
local N = ${n ? `{${n.map(r).join(',')}}` : 'nil'}
local em = AssetService:CreateEditableMesh()
local ids = table.create(#V // 3)
for i = 1, #V, 3 do
  ids[(i + 2) // 3] = em:AddVertex(Vector3.new(V[i], V[i + 1], V[i + 2]))
end
local uvs = nil
if U then
  uvs = table.create(#U // 2)
  for i = 1, #U, 2 do
    uvs[(i + 1) // 2] = em:AddUV(Vector2.new(U[i], U[i + 1]))
  end
end
local faces = {}
for i = 1, #T, 3 do
  local f = em:AddTriangle(ids[T[i] + 1], ids[T[i + 1] + 1], ids[T[i + 2] + 1])
  if uvs then em:SetFaceUVs(f, { uvs[T[i] + 1], uvs[T[i + 1] + 1], uvs[T[i + 2] + 1] }) end
  faces[#faces + 1] = f
end
if N then setNormals(em, faces, N, T) end
local ${meshPart} = AssetService:CreateMeshPartAsync(Content.fromObject(em))`;
}

/**
 * Luau that places every use of an instanced part as a temporary MeshPart (not saved with the place; for checking the look when
 * uploading isn't possible): the mesh is built once with EditableMesh, then cloned per use into a Folder named p.name under p.parent.
 * p.position / p.rotation are the pivot the uses are relative to (p.scale scales them), as in placeInstances.
 */
export function temporaryInstancesLuau(modelName: string, mesh: { v: number[]; t: number[]; uv?: number[]; n?: number[] }, instances: ModelInstance[], p: ModelPlacement, surface = '', fx: PartFx | null = null): string {
  const r = (x: number) => String(Math.round(x * 1000) / 1000);
  return `local InsertService = game:GetService("InsertService")
${PLACE_FN}
${editableMeshLuau(mesh, 'mp')}
local inst = ${instancesTable(instances)}
local parent = resolveParent(${JSON.stringify(p.parent)}, ${p.group ? '"Model"' : 'nil'})
local old = parent:FindFirstChild(${JSON.stringify(p.name)})
if old and old:GetAttribute("ShurikenModel") == ${JSON.stringify(modelName)} then old:Destroy() end
mp.Anchored = true
mp:SetAttribute("ShurikenModel", ${JSON.stringify(modelName)})
mp:SetAttribute("ShurikenTemporaryMesh", true)
${p.color ? `mp.Color = Color3.fromHex(${JSON.stringify(p.color)})` : ''}
${p.material ? `mp.Material = Enum.Material[${JSON.stringify(p.material)}]` : ''}
${surface}
applyFx(mp, ${fxTable(fx)})
local native = mp.Size
local folder = Instance.new("Folder")
folder.Name = ${JSON.stringify(p.name)}
folder:SetAttribute("ShurikenModel", ${JSON.stringify(modelName)})
folder:SetAttribute("ShurikenInstances", #inst // 9)
local k = ${r(p.scale)}
local pivot = CFrame.new(${p.position.map(r).join(', ')}) * CFrame.fromOrientation(math.rad(${r(p.rotation[0])}), math.rad(${r(p.rotation[1])}), math.rad(${r(p.rotation[2])}))
for i = 1, #inst, 9 do
  local c = mp:Clone()
  c.Name = ${JSON.stringify(p.name)} .. "_" .. ((i + 8) // 9)
  c.Size = Vector3.new(native.X * inst[i + 6], native.Y * inst[i + 7], native.Z * inst[i + 8]) * k
  c.CFrame = pivot * (CFrame.new(inst[i] * k, inst[i + 1] * k, inst[i + 2] * k) * CFrame.fromOrientation(math.rad(inst[i + 3]), math.rad(inst[i + 4]), math.rad(inst[i + 5])))
  c.Parent = folder
end
folder.Parent = parent
return game:GetService("HttpService"):JSONEncode({ instances = #inst // 9 })`;
}

/** Luau that builds a temporary MeshPart from triangles with EditableMesh (not saved with the place). */
export function temporaryMeshLuau(modelName: string, mesh: { v: number[]; t: number[]; uv?: number[]; n?: number[] }, p: ModelPlacement, onGround: boolean | 'wall' = false, surface = '', fx: PartFx | null = null): string {
  const r = (x: number) => String(Math.round(x * 1000) / 1000);
  const u = (x: number) => String(Math.round(x * 100000) / 100000);
  const n = meshNormals(mesh);
  return `local AssetService = game:GetService("AssetService")
${NORMALS_FN}
local V = {${mesh.v.map(r).join(',')}}
local T = {${mesh.t.join(',')}}
local U = ${mesh.uv ? `{${mesh.uv.map(u).join(',')}}` : 'nil'}
local N = ${n ? `{${n.map(r).join(',')}}` : 'nil'}
local em = AssetService:CreateEditableMesh()
local ids = table.create(#V // 3)
for i = 1, #V, 3 do
  ids[(i + 2) // 3] = em:AddVertex(Vector3.new(V[i], V[i + 1], V[i + 2]))
end
local uvs = nil
if U then
  uvs = table.create(#U // 2)
  for i = 1, #U, 2 do
    uvs[(i + 1) // 2] = em:AddUV(Vector2.new(U[i], U[i + 1]))
  end
end
local faces = {}
for i = 1, #T, 3 do
  local f = em:AddTriangle(ids[T[i] + 1], ids[T[i + 1] + 1], ids[T[i + 2] + 1])
  if uvs then em:SetFaceUVs(f, { uvs[T[i] + 1], uvs[T[i + 1] + 1], uvs[T[i + 2] + 1] }) end
  faces[#faces + 1] = f
end
if N then setNormals(em, faces, N, T) end
local mp = AssetService:CreateMeshPartAsync(Content.fromObject(em))
local inst = game
for _, seg in string.split(${JSON.stringify(p.parent)}, ".") do
  local nxt = inst:FindFirstChild(seg)
  if not nxt and inst == game then
    local ok, svc = pcall(function() return game:GetService(seg) end)
    if ok then nxt = svc end
  end
  if not nxt then
    nxt = Instance.new("Folder")
    nxt.Name = seg
    nxt.Parent = inst
  end
  inst = nxt
end
local old = inst:FindFirstChild(${JSON.stringify(p.name)})
if old and old:GetAttribute("ShurikenModel") == ${JSON.stringify(modelName)} then old:Destroy() end
mp.Name = ${JSON.stringify(p.name)}
mp.Anchored = true
mp.Size = mp.Size * ${r(p.scale)}
mp.CFrame = CFrame.new(${p.position.map(r).join(', ')}) * CFrame.fromOrientation(math.rad(${r(p.rotation[0])}), math.rad(${r(p.rotation[1])}), math.rad(${r(p.rotation[2])}))
${p.color ? `mp.Color = Color3.fromHex(${JSON.stringify(p.color)})` : ''}
${p.material ? `mp.Material = Enum.Material[${JSON.stringify(p.material)}]` : ''}
mp:SetAttribute("ShurikenModel", ${JSON.stringify(modelName)})
mp:SetAttribute("ShurikenTemporaryMesh", true)
${surface}
${fx ? `${FX_FN}
applyFx(mp, ${fxTable(fx)})` : ''}
mp.Parent = inst
${SETTLE_FN}
return game:GetService("HttpService"):JSONEncode(settle(mp, ${onGround === 'wall' ? '"wall"' : onGround ? 'true' : 'false'}))`;
}
