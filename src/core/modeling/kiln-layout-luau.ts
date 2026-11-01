import { FX_FN, fxTable } from './part-traits';
import { NORMALS_FN, meshNormals } from './model-store';
import type { LayoutPlan, PlanMarker, PlanPath, PlanTemplate, PlanUnit } from './kiln-layout';

/**
 * The Luau a map import runs in Studio (see layout-import.ts for the order and docs/ARCHITECTURE.md for why it is cut
 * this way). Every program is small, idempotent and answers with a short JSON line, because one execute_luau call must
 * not time out and its result is cut at about 100,000 characters:
 * - kitLuau: one template MeshPart per unique mesh under ServerStorage.ShurikenMapKit.<Map> (the asset is loaded once,
 *   its look and collision set once); a template whose stamp is unchanged is kept.
 * - unitsLuau: a batch of units (placements, the layout's own parts), each cloned from its templates into
 *   Workspace.<Map>.<Static | Pieces.<cell>>; a unit whose fingerprint is unchanged is kept, a changed one replaced.
 * - sweepLuau: what an earlier import placed and this one no longer has is removed (units by the run stamp, templates
 *   by name).
 * - markersLuau: the markers as invisible anchor parts (also written as a world builder).
 */

const q = (s: string) => JSON.stringify(s);
const n = (x: number) => String(x);

/** Storage of the map's templates, and the folder of the map itself. */
export const MAP_KIT = 'ShurikenMapKit';

const FOLDER_FN = `local function folderIn(parent, name)
  local f = parent:FindFirstChild(name)
  if not f then
    f = Instance.new("Folder")
    f.Name = name
    f.Parent = parent
  end
  return f
end`;

/** One template row: name, asset id, stamp, size, colour, material, traits, legacy turn. */
function kitRow(t: PlanTemplate): string {
  return `{${q(t.name)},${t.asset ?? 'nil'},${q(t.stamp)},{${t.size.map(n).join(',')}},${t.color ? q(t.color) : 'nil'},${t.material ? q(t.material) : 'nil'},${fxTable(t.fx)},${t.turn ? 'true' : 'false'}}`;
}

const KIT_FINISH = `local function finish(mesh, r, old)
  mesh.Name = r[1]
  mesh.Anchored = true
  mesh.Size = Vector3.new(r[4][1], r[4][2], r[4][3])
  if r[5] then mesh.Color = Color3.fromHex(r[5]) end
  if r[6] then pcall(function() mesh.Material = Enum.Material[r[6]] end) end
  applyFx(mesh, r[7])
  mesh:SetAttribute("ShurikenModel", r[1])
  mesh:SetAttribute("ShurikenStamp", r[3])
  -- A legacy upload arrives turned 180 degrees about its own centre (modeling/glb.ts): its clones are turned back.
  if r[8] then mesh:SetAttribute("ShurikenTurned", true) end
  if old then old:Destroy() end
  mesh.Parent = kit
end`;

/** Templates from uploaded assets (InsertService:LoadAsset once per mesh). */
export function kitLuau(map: string, templates: PlanTemplate[]): string {
  return `local InsertService = game:GetService("InsertService")
local ServerStorage = game:GetService("ServerStorage")
local HttpService = game:GetService("HttpService")
${FX_FN}
${FOLDER_FN}
local kit = folderIn(folderIn(ServerStorage, ${q(MAP_KIT)}), ${q(map)})
${KIT_FINISH}
-- name, asset, stamp, size, colour, material, traits, legacy turn
local ROWS = {
${templates.map(kitRow).join(',\n')}
}
local made, kept, failed, failures = 0, 0, 0, {}
for _, r in ROWS do
  local old = kit:FindFirstChild(r[1])
  if old and old:GetAttribute("ShurikenStamp") == r[3] then
    kept += 1
  else
    local ok, err = pcall(function()
      local container = InsertService:LoadAsset(r[2])
      local mesh = container:FindFirstChildWhichIsA("MeshPart", true)
      if not mesh then
        container:Destroy()
        error("asset " .. tostring(r[2]) .. " has no MeshPart (still processing?)")
      end
      mesh.Parent = nil
      container:Destroy()
      finish(mesh, r, old)
    end)
    if ok then
      made += 1
    else
      failed += 1
      if #failures < 12 then table.insert(failures, r[1] .. ": " .. string.sub(tostring(err), 1, 160)) end
    end
  end
end
return HttpService:JSONEncode({ made = made, kept = kept, failed = failed, failures = failures })`;
}

/** Templates as temporary meshes (EditableMesh from mesh.json; not saved with the place): for a look without uploads. */
export function kitTemporaryLuau(map: string, rows: Array<{ template: PlanTemplate; mesh: { v: number[]; t: number[]; n?: number[] } }>): string {
  const r3 = (x: number) => String(Math.round(x * 1000) / 1000);
  const body = rows
    .map(({ template, mesh }) => {
      const normals = meshNormals(mesh);
      return `{${kitRow(template)},{${mesh.v.map(r3).join(',')}},{${mesh.t.join(',')}},${normals ? `{${normals.map(r3).join(',')}}` : 'nil'}}`;
    })
    .join(',\n');
  return `local AssetService = game:GetService("AssetService")
local ServerStorage = game:GetService("ServerStorage")
local HttpService = game:GetService("HttpService")
${FX_FN}
${NORMALS_FN}
${FOLDER_FN}
local kit = folderIn(folderIn(ServerStorage, ${q(MAP_KIT)}), ${q(map)})
${KIT_FINISH}
-- the template row, then its vertices, triangles and normals
local ROWS = {
${body}
}
local made, kept, failed, failures = 0, 0, 0, {}
for _, row in ROWS do
  local r, V, T, N = row[1], row[2], row[3], row[4]
  local old = kit:FindFirstChild(r[1])
  if old and old:GetAttribute("ShurikenStamp") == r[3] then
    kept += 1
  else
    local ok, err = pcall(function()
      local em = AssetService:CreateEditableMesh()
      local ids = table.create(#V // 3)
      for i = 1, #V, 3 do
        ids[(i + 2) // 3] = em:AddVertex(Vector3.new(V[i], V[i + 1], V[i + 2]))
      end
      local faces = {}
      for i = 1, #T, 3 do
        faces[#faces + 1] = em:AddTriangle(ids[T[i] + 1], ids[T[i + 1] + 1], ids[T[i + 2] + 1])
      end
      if N then setNormals(em, faces, N, T) end
      local mesh = AssetService:CreateMeshPartAsync(Content.fromObject(em))
      mesh:SetAttribute("ShurikenTemporaryMesh", true)
      finish(mesh, r, old)
    end)
    if ok then
      made += 1
    else
      failed += 1
      if #failures < 12 then table.insert(failures, r[1] .. ": " .. string.sub(tostring(err), 1, 160)) end
    end
  end
end
return HttpService:JSONEncode({ made = made, kept = kept, failed = failed, failures = failures })`;
}

/** Numbers of one unit row after its four strings: the pivot (6), then 11 per MeshPart. */
const UNIT_HEAD = 10;
const PER_USE = 11;

/**
 * One unit as a flat Luau array: name, fingerprint, group, cell, the pivot (x, y, z, rx, ry, rz) and, per MeshPart, the
 * index of its template in the batch's list, its position, orientation (degrees), scale and trait override (0 = none).
 */
function unitRow(u: PlanUnit, local: Map<number, number>, fxLocal: Map<number, number>): string {
  const parts = u.uses.map((x) => [local.get(x.t)!, ...x.p, ...x.r, ...x.s, x.fx ? fxLocal.get(x.fx)! : 0].map(n).join(','));
  return `{${q(u.name)},${q(u.fp)},${q(u.group)},${q(u.cell)},${[...u.pivot.p, ...u.pivot.r].map(n).join(',')},${parts.join(',')}}`;
}

/** About how many characters a unit takes in a batch (for cutting batches). */
export const unitChars = (u: PlanUnit): number => 60 + u.name.length + u.uses.length * 90;

/**
 * Places a batch of units. `run` stamps everything this import has seen (kept or made), so the sweep after the last
 * batch can tell what is left over from an earlier import.
 */
export function unitsLuau(plan: Pick<LayoutPlan, 'map' | 'templates' | 'fx'>, run: string, units: PlanUnit[]): string {
  // Only the templates and trait tables this batch uses, renumbered from 1.
  const local = new Map<number, number>();
  const fxLocal = new Map<number, number>();
  for (const u of units)
    for (const x of u.uses) {
      if (!local.has(x.t)) local.set(x.t, local.size + 1);
      if (x.fx && !fxLocal.has(x.fx)) fxLocal.set(x.fx, fxLocal.size + 1);
    }
  const names = [...local.keys()].map((i) => q(plan.templates[i]!.name));
  const traits = [...fxLocal.keys()].map((i) => plan.fx[i - 1]!);
  return `local ServerStorage = game:GetService("ServerStorage")
local HttpService = game:GetService("HttpService")
${FX_FN}
${FOLDER_FN}
local MAP, RUN = ${q(plan.map)}, ${q(run)}
local kitRoot = ServerStorage:FindFirstChild(${q(MAP_KIT)})
local kit = kitRoot and kitRoot:FindFirstChild(MAP)
if not kit then error("the map's kit (ServerStorage.${MAP_KIT}." .. MAP .. ") is missing: run the import again") end
local root = folderIn(workspace, MAP)
root:SetAttribute("ShurikenLayout", MAP)
local T = {${names.join(',')}}
local FX = {${traits.join(',')}}
local tpl = table.create(#T)
for i, name in T do tpl[i] = kit:FindFirstChild(name) end
local HALF = CFrame.Angles(0, math.pi, 0)
local function frame(u, i)
  return CFrame.new(u[i], u[i + 1], u[i + 2]) * CFrame.fromOrientation(math.rad(u[i + 3]), math.rad(u[i + 4]), math.rad(u[i + 5]))
end
-- One MeshPart of a unit: a clone of its template at its CFrame, its Size the template's times the scale.
local function part(u, i, name, pivot)
  local t = tpl[u[i]]
  if not t then error("its mesh " .. T[u[i]] .. " is not in the kit") end
  local mp = t:Clone()
  mp.Name = name
  mp.Size = Vector3.new(t.Size.X * u[i + 7], t.Size.Y * u[i + 8], t.Size.Z * u[i + 9])
  local cf = frame(u, i + 1)
  if t:GetAttribute("ShurikenTurned") then cf = cf * HALF end
  mp.CFrame = cf
  -- Its pivot is the placement's own origin and facing, whatever the mesh's box centre is.
  mp.PivotOffset = cf:ToObjectSpace(pivot)
  if u[i + 10] > 0 then applyFx(mp, FX[u[i + 10]]) end
  return mp
end
-- name, fingerprint, group, cell, pivot (x, y, z, rx, ry, rz), then per part: template, x, y, z, rx, ry, rz, sx, sy, sz, traits
local U = {
${units.map((u) => unitRow(u, local, fxLocal)).join(',\n')}
}
local folders = {}
local function folderOf(group, cell)
  local key = group .. "/" .. cell
  local f = folders[key]
  if not f then
    f = folderIn(root, group)
    if cell ~= "" then f = folderIn(f, cell) end
    folders[key] = f
  end
  return f
end
local placed, kept, replaced, failed, failures = 0, 0, 0, 0, {}
for _, u in U do
  local folder = folderOf(u[3], u[4])
  local old = folder:FindFirstChild(u[1])
  if old and old:GetAttribute("ShurikenFp") == u[2] then
    old:SetAttribute("ShurikenRun", RUN)
    kept += 1
  else
    local ok, err = pcall(function()
      local count = (#u - ${UNIT_HEAD}) // ${PER_USE}
      local pivot = frame(u, 5)
      local made
      if count == 1 then
        made = part(u, ${UNIT_HEAD + 1}, u[1], pivot)
      else
        -- A piece of several parts is one Model that streams in whole (a tree never shows without its leaves).
        made = Instance.new("Model")
        made.Name = u[1]
        for k = 1, count do
          local i = ${UNIT_HEAD + 1} + (k - 1) * ${PER_USE}
          part(u, i, T[u[i]], pivot).Parent = made
        end
        made.WorldPivot = pivot
        pcall(function() made.ModelStreamingMode = Enum.ModelStreamingMode.Atomic end)
      end
      made:SetAttribute("ShurikenLayout", MAP)
      made:SetAttribute("ShurikenFp", u[2])
      made:SetAttribute("ShurikenRun", RUN)
      if old then old:Destroy() end
      made.Parent = folder
    end)
    if ok then
      if old then replaced += 1 else placed += 1 end
    else
      failed += 1
      if #failures < 12 then table.insert(failures, u[1] .. ": " .. string.sub(tostring(err), 1, 160)) end
    end
  end
end
return HttpService:JSONEncode({ placed = placed, kept = kept, replaced = replaced, failed = failed, failures = failures })`;
}

/** Removes the units this run did not see and the kit templates the map no longer uses; empty cell folders go too. */
export function sweepLuau(map: string, run: string, templates: string[]): string {
  return `local ServerStorage = game:GetService("ServerStorage")
local HttpService = game:GetService("HttpService")
local MAP, RUN = ${q(map)}, ${q(run)}
local KEEP = {${templates.map((t) => `[${q(t)}]=true`).join(',')}}
local removed, templates = 0, 0
local root = workspace:FindFirstChild(MAP)
local function sweep(folder)
  for _, c in folder:GetChildren() do
    if c:GetAttribute("ShurikenFp") ~= nil then
      if c:GetAttribute("ShurikenRun") ~= RUN then
        c:Destroy()
        removed += 1
      end
    elseif c:IsA("Folder") then
      sweep(c)
      if #c:GetChildren() == 0 then c:Destroy() end
    end
  end
end
if root then
  for _, group in { "Static", "Pieces" } do
    local g = root:FindFirstChild(group)
    if g then sweep(g) end
  end
end
local kitRoot = ServerStorage:FindFirstChild(${q(MAP_KIT)})
local kit = kitRoot and kitRoot:FindFirstChild(MAP)
if kit then
  for _, c in kit:GetChildren() do
    if not KEEP[c.Name] then
      c:Destroy()
      templates += 1
    end
  end
end
return HttpService:JSONEncode({ removed = removed, templates = templates })`;
}

/** The tag every marker carries, and the tag of one role ("MapMarker_spawn"). */
export const MARKER_TAG = 'MapMarker';
export const markerTag = (role: string): string => `${MARKER_TAG}_${role.replace(/[^A-Za-z0-9_]/g, '_')}`;

/**
 * The map's markers as invisible, anchored parts in Workspace.<Map>.Markers (a Model that is always streamed in, so
 * client code finds them whatever the player is near): named after the marker, tagged MapMarker and MapMarker_<role>,
 * with the role as an attribute. A marker's LookVector is the way it faces. Idempotent: the Markers model is rebuilt.
 */
export function markersLuau(map: string, markers: PlanMarker[]): string {
  return `-- Generated by Shuriken Studio from the Kiln layout ${q(map)} (kiln_layout_import). Do not edit: import the layout again.
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local MAP = ${q(map)}
-- name, role, position, orientation (degrees)
local MARKERS = {
${markers.map((m) => `  {${q(m.name)},${q(m.role)},${[...m.p, ...m.r].map(n).join(',')}}`).join(',\n')}
}
local root = workspace:FindFirstChild(MAP)
if not root then
  root = Instance.new("Folder")
  root.Name = MAP
  root:SetAttribute("ShurikenLayout", MAP)
  root.Parent = workspace
end
local old = root:FindFirstChild("Markers")
if old then old:Destroy() end
local holder = Instance.new("Model")
holder.Name = "Markers"
pcall(function() holder.ModelStreamingMode = Enum.ModelStreamingMode.Persistent end)
for _, m in MARKERS do
  local p = Instance.new("Part")
  p.Name = m[1]
  p.Size = Vector3.new(1, 1, 1)
  p.Anchored = true
  p.Transparency = 1
  p.CanCollide = false
  p.CanQuery = false
  p.CanTouch = false
  p.CastShadow = false
  p.CFrame = CFrame.new(m[3], m[4], m[5]) * CFrame.fromOrientation(math.rad(m[6]), math.rad(m[7]), math.rad(m[8]))
  p:SetAttribute("Role", m[2])
  p:SetAttribute("ShurikenLayout", MAP)
  CollectionService:AddTag(p, ${q(MARKER_TAG)})
  CollectionService:AddTag(p, ${q(`${MARKER_TAG}_`)} .. string.gsub(m[2], "[^%w_]", "_"))
  p.Parent = holder
end
holder.Parent = root
return HttpService:JSONEncode({ markers = #MARKERS })`;
}

/** A Luau identifier-safe module name for a map ("Drift Circuit" → "DriftCircuit"). */
export const mapModuleName = (map: string): string => {
  const s = map.replace(/[^A-Za-z0-9_]/g, '');
  return /^[A-Za-z_]/.test(s) ? s : `Map${s}`;
};

/**
 * The data module game code requires for a map: its paths (the road's centre line for checkpoints, AI and minimaps:
 * points in studs, width, closed, length) and its markers (name, role, CFrame; also in the place as anchor parts).
 * Strict Luau: it lives in the project's synced code and passes the same checks agents' code does.
 */
export function mapDataModule(map: string, paths: PlanPath[], markers: PlanMarker[], info: { studsPerUnit: number; root: string }): string {
  const path = (p: PlanPath) =>
    `\t{ name = ${q(p.name)}, role = ${q(p.role)}, width = ${p.width === null ? 0 : n(p.width)}, closed = ${p.closed ? 'true' : 'false'}, length = ${n(p.length)}, points = points({ ${p.points.map((v) => v.map(n).join(', ')).join(', ')} }) },`;
  const marker = (m: PlanMarker) => `\t{ name = ${q(m.name)}, role = ${q(m.role)}, cframe = at(${[...m.p, ...m.r].map(n).join(', ')}) },`;
  return `--!strict
-- Generated by Shuriken Studio from the Kiln layout ${q(map)} (kiln_layout_import). Do not edit: import the layout again.
-- Paths and markers of the map, in studs and Roblox axes. The markers are in the place too, as invisible anchor
-- parts under ${info.root}.Markers tagged "${MARKER_TAG}" and "${MARKER_TAG}_<role>" (CollectionService).

export type MapPath = {
	name: string,
	role: string,
	-- 0 when the path has no width of its own
	width: number,
	closed: boolean,
	length: number,
	points: { Vector3 },
}
export type MapMarker = {
	name: string,
	role: string,
	-- its LookVector is the way the marker faces
	cframe: CFrame,
}

${
    paths.length
      ? `
local function points(flat: { number }): { Vector3 }
	local out = table.create(#flat // 3)
	for i = 1, #flat, 3 do
		out[(i + 2) // 3] = Vector3.new(flat[i], flat[i + 1], flat[i + 2])
	end
	return out
end
`
      : ''
  }${
    markers.length
      ? `
local function at(x: number, y: number, z: number, rx: number, ry: number, rz: number): CFrame
	return CFrame.new(x, y, z) * CFrame.fromOrientation(math.rad(rx), math.rad(ry), math.rad(rz))
end
`
      : ''
  }
local Map = {}

Map.name = ${q(map)}
Map.studsPerUnit = ${n(info.studsPerUnit)}

local paths: { MapPath } = {
${paths.map(path).join('\n')}
}
Map.paths = paths

local markers: { MapMarker } = {
${markers.map(marker).join('\n')}
}
Map.markers = markers

-- The first path of a role ("road_centerline"), or nil.
function Map.path(role: string): MapPath?
	for _, p in paths do
		if p.role == role then
			return p
		end
	end
	return nil
end

-- Every marker of a role ("spawn", "start_grid", "checkpoint", "camera"), in name order.
function Map.markersOf(role: string): { MapMarker }
	local out: { MapMarker } = {}
	for _, m in markers do
		if m.role == role then
			table.insert(out, m)
		end
	end
	table.sort(out, function(a: MapMarker, b: MapMarker): boolean
		return a.name < b.name
	end)
	return out
end

return Map
`;
}
