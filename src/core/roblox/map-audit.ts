/**
 * map_audit: measures a built area in Studio and turns the numbers into plain findings, so agents and
 * the critic judge maps by more than a glance (test 3: "we need more map-building competence").
 * The Luau runs in the Edit DataModel in a few milliseconds (a grid of raycasts and radius queries).
 * Since the run of 2026-10-01 (mechs walked through 6-stud tyre stacks) it also checks what a builder gets wrong
 * without seeing it: cover that doesn't stop a character, unanchored parts, tiny parts that snag, precise collision
 * on small props, shadowed lights, small shadow casters and coplanar faces that z-fight.
 */

export interface MapAudit {
  area: string;
  parts: number;
  size: [number, number];
  surface: { plainPlastic: number; grey: number; greyPlastic?: number; materials: string[] };
  ground: { samples: number; void: number; terrain: number; materials: number; heightSpread: number; empty: number; radius: number };
  landmark: number;
  giantFlatParts: string[];
  lighting: { style: string; clockTime: number; atmosphere?: number | null; sky: boolean; colorCorrection: boolean; bloom: boolean; sunRays: boolean };
  /** What falls, snags and costs (absent from audits made before these were measured). */
  build?: {
    loose: number;
    looseNames: string[];
    tinyColliding: number;
    tinyNames: string[];
    invisibleColliders: number;
    preciseSmall: number;
    preciseNames: string[];
    smallShadows: number;
    meshParts: number;
    uniqueMeshes: number;
    renderPrecise: number;
    lights: number;
    shadowLights: number;
    streaming: boolean;
    zFighting: number;
    zNames: string[];
    zChecked: number;
  };
  /** Pieces with a Cover attribute or tag: walk-through (no collision), low (collision under step), shot-through (nothing raycasts hit). */
  cover?: { pieces: number; step: number; walkThrough: number; walkNames: string[]; low: number; lowNames: string[]; shotThrough: number; shotNames: string[] };
  error?: string;
}

/** The audit script: `area` is a Workspace path ("Arena", "Map/Arena"; "" = the whole Workspace). */
export function mapAuditLuau(area: string, grid = 12, radius = 12, step = DEFAULT_STEP): string {
  const path = JSON.stringify(area.replace(/^Workspace[/.]?/i, '').replace(/\./g, '/'));
  return MAP_AUDIT.replace('__ROOT__', () => path)
    .replace('__GRID__', String(Math.round(grid)))
    .replace('__RADIUS__', String(Math.round(radius)))
    .replace('__STEP__', String(Math.round(step * 10) / 10));
}

/**
 * Collision a character can't step over, in studs above the cover's base: about an R15 character's HipHeight (2) plus
 * a stud. Bigger characters pass their own (in the run of 2026-10-01 mechs with HipHeight 4.95 walked through
 * 6-stud tyre stacks whose collision their root box cleared).
 */
export const DEFAULT_STEP = 3;

/** Plain findings from the numbers; empty when nothing stands out. Thresholds are deliberately lenient. */
export function mapFindings(m: MapAudit): string[] {
  const out: string[] = [];
  const span = Math.max(m.size[0], m.size[1]);
  if (m.parts < 30 && span > 100) out.push(`Only ${m.parts} parts across ${span} studs: this is still a blockout.`);
  if (m.ground.void > 15) out.push(`${m.ground.void}% of the area has no ground under it (holes or unfinished edges).`);
  // Coloured plastic is a style (the default cartoon look); grey plastic is Roblox's unfinished default.
  if ((m.surface.greyPlastic ?? 0) > 35) out.push(`${m.surface.greyPlastic}% of the surface is grey plastic — Roblox's unfinished default. Colour it from the palette, or use textured materials where the style is realistic.`);
  if (m.surface.grey > 50) out.push(`${m.surface.grey}% of the surface is grey or uncoloured. Apply the palette (a restrained set of colours plus one accent).`);
  if (m.ground.materials <= 1) out.push('The ground is one material. Blend 2–4: paths, patches and edges in neighbouring materials.');
  if (m.ground.heightSpread < 1 && span > 80) out.push(`The ground is flat (under a stud of height change across ${span} studs). Add relief: terrain hills, steps, plateaus, raised edges.`);
  if (m.ground.empty > 70) out.push(`${m.ground.empty}% of the ground has nothing within ${m.ground.radius} studs. Dress it with clustered props, foliage and lights — except where open space is the point (an arena floor, a race lane).`);
  if (m.landmark < 20 && span > 150) out.push(`Nothing rises more than ${m.landmark} studs above the ground. Add a landmark players can see from the spawn (a tower, a giant tree, a gate).`);
  if (m.giantFlatParts.length) out.push(`Giant flat parts used as ground (${m.giantFlatParts.slice(0, 3).join(', ')}). Use Terrain for ground.`);
  if (m.lighting.atmosphere == null) out.push('No Atmosphere in Lighting: add one (density 0.25–0.4) for depth.');
  if (!m.lighting.sky) out.push('No Sky in Lighting.');
  if (!m.lighting.colorCorrection && !m.lighting.bloom) out.push('No post effects: a subtle ColorCorrection and Bloom finish the look.');
  const names = (n: number, list: string[]) => `${list.slice(0, 3).join(', ')}${n > list.length ? ` and ${n - list.length} more` : ''}`;
  const c = m.cover;
  if (c?.walkThrough) out.push(`${c.walkThrough} cover piece(s) have no collision at all, so players walk through them: ${names(c.walkThrough, c.walkNames)}. Give them a collidable part or an invisible blocker.`);
  if (c?.low) out.push(`${c.low} cover piece(s) look ${c.step}+ studs tall but collide lower than ${c.step} studs over their base, so characters step over or through them: ${names(c.low, c.lowNames)}. Add an anchored invisible blocker (Transparency 1, CanCollide on, CastShadow off) up to the characters' chest, in a collision group that only the characters' group collides with: CanQuery is ignored on a part that collides, so the group is what lets rays and shots (RaycastParams.CollisionGroup "Default") pass it and hit the visible cover. For bigger characters run the audit with step = their root part's bottom height + 1.`);
  if (c?.shotThrough) out.push(`${c.shotThrough} cover piece(s) have no visible part that raycasts can hit (CanQuery and CanCollide off everywhere), so shots pass through them: ${names(c.shotThrough, c.shotNames)}.`);
  const b = m.build;
  if (b?.loose) out.push(`${b.loose} unanchored part(s) not held by anything anchored will fall or be flung at the first playtest: ${names(b.loose, b.looseNames)}. Anchor dressing and structures (weld moving parts to an anchored base only where they must move).`);
  if (b?.zFighting) out.push(`${b.zFighting} pair(s) of block faces lie in the same plane with different colours or materials, so they flicker (z-fighting): ${names(b.zFighting, b.zNames)}. Lift the top one 0.02-0.05 studs, or remove the hidden one.`);
  if (b && b.tinyColliding > 20) out.push(`${b.tinyColliding} tiny visible parts (under 1.5 studs) collide, so characters snag and stutter on clutter: ${names(b.tinyColliding, b.tinyNames)}. Small dressing gets CanCollide, CanTouch and CanQuery off (an invisible box collider where the shape matters).`);
  if (b && b.preciseSmall > 10) out.push(`${b.preciseSmall} small colliding meshes (under 4 studs) use PreciseConvexDecomposition, the most expensive collision: ${names(b.preciseSmall, b.preciseNames)}. Box or Hull for props; precise only for ground and things players stand on.`);
  if (b && b.shadowLights > 24) out.push(`${b.shadowLights} local lights cast shadows (${b.lights} lights in all). Each shadowed light costs every frame it is in range; keep shadows for a few key lights (a convention: a dozen or two in view at once) and turn Shadows off on fill and decorative lights.`);
  else if (b && b.lights > 150) out.push(`${b.lights} lights in the area: fake the small ones with Neon or SurfaceAppearance emissive parts and keep real lights where they light the play space (a convention, not an engine limit).`);
  if (b && b.smallShadows > 400) out.push(`${b.smallShadows} small parts (under 2 studs) cast shadows. Turn CastShadow off on small dressing: it costs shadow-map time and adds noise.`);
  return out;
}

const MAP_AUDIT = `local HttpService = game:GetService("HttpService")
local Lighting = game:GetService("Lighting")
local ROOT = __ROOT__
local GRID = __GRID__
local RADIUS = __RADIUS__
local STEP = __STEP__

local function resolve(path: string): Instance?
	if path == "" then
		return workspace
	end
	local inst: Instance? = workspace
	for seg in string.gmatch(path, "[^/]+") do
		inst = inst and inst:FindFirstChild(seg)
	end
	return inst
end
local root = resolve(ROOT)
if not root then
	return HttpService:JSONEncode({ error = "No Workspace/" .. ROOT })
end

-- Every part under the area (characters, the camera and terrain aside); the visible ones are measured for looks.
local everything: { BasePart } = {}
local function add(d: Instance)
	if d:IsA("BasePart") and not d:IsA("Terrain") then
		table.insert(everything, d)
	end
end
if root == workspace then
	for _, c in workspace:GetChildren() do
		if not c:IsA("Camera") and not c:IsA("Terrain") and not (c:IsA("Model") and c:FindFirstChildOfClass("Humanoid")) then
			add(c)
			for _, d in c:GetDescendants() do
				add(d)
			end
		end
	end
else
	add(root)
	for _, d in root:GetDescendants() do
		add(d)
	end
end
local parts: { BasePart } = {}
for _, p in everything do
	if p.Transparency < 0.95 then
		table.insert(parts, p)
	end
end

-- Surface by material and colour (a box's surface, so big walls weigh more than bolts).
local total, plain, grey, greyPlastic = 0, 0, 0, 0
local materials: { [string]: number } = {}
local giant: { string } = {}
local xs, zs = {}, {}
local top = -math.huge
for _, p in parts do
	local s = p.Size
	local area = 2 * (s.X * s.Y + s.Y * s.Z + s.X * s.Z)
	total += area
	local m = p.Material.Name
	materials[m] = (materials[m] or 0) + area
	if p.Material == Enum.Material.SmoothPlastic or p.Material == Enum.Material.Plastic then
		plain += area
	end
	local _, sat, val = p.Color:ToHSV()
	if sat < 0.12 and val > 0.25 then
		grey += area
		if p.Material == Enum.Material.SmoothPlastic or p.Material == Enum.Material.Plastic then
			greyPlastic += area
		end
	end
	if math.max(s.X, s.Z) > 400 and s.Y < 8 then
		table.insert(giant, p:GetFullName())
	end
	-- Both edges, so a big floor under a few props counts at its full size.
	table.insert(xs, p.Position.X - s.X / 2)
	table.insert(xs, p.Position.X + s.X / 2)
	table.insert(zs, p.Position.Z - s.Z / 2)
	table.insert(zs, p.Position.Z + s.Z / 2)
	top = math.max(top, p.Position.Y + s.Y / 2)
end
if #parts == 0 then
	return HttpService:JSONEncode({ error = "No visible parts under Workspace/" .. ROOT })
end

-- The area: the middle 90 % of part edges (a far skybox or a stray part shouldn't stretch it).
table.sort(xs)
table.sort(zs)
local function pct(t: { number }, q: number): number
	return t[math.clamp(math.floor(#t * q + 0.5), 1, #t)]
end
local x0, x1, z0, z1 = pct(xs, 0.05), pct(xs, 0.95), pct(zs, 0.05), pct(zs, 0.95)
if x1 - x0 < 8 then
	x0, x1 = x0 - 4, x1 + 4
end
if z1 - z0 < 8 then
	z0, z1 = z0 - 4, z1 + 4
end

-- Ground samples on a grid: what is underfoot, how high, and what stands nearby.
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.FilterDescendantsInstances = {}
-- Ground is what you stand on: zones and triggers (CanCollide off) and invisible walls don't count.
params.RespectCanCollide = true
local skip: { Instance } = {}
local function castDown(origin: Vector3): RaycastResult?
	for _ = 1, 8 do
		local r = workspace:Raycast(origin, Vector3.new(0, -2000, 0), params)
		if not r then
			return nil
		end
		local inst = r.Instance
		if inst:IsA("BasePart") and not inst:IsA("Terrain") and inst.Transparency >= 0.9 then
			table.insert(skip, inst)
			params.FilterDescendantsInstances = skip
		else
			return r
		end
	end
	return nil
end
local overlap = OverlapParams.new()
local hits, voids, terrainHits, empty = 0, 0, 0, 0
local heights: { number } = {}
local groundMats: { [string]: number } = {}
local startY = top + 50
for i = 0, GRID - 1 do
	for j = 0, GRID - 1 do
		local x = x0 + (x1 - x0) * (i + 0.5) / GRID
		local z = z0 + (z1 - z0) * (j + 0.5) / GRID
		local r = castDown(Vector3.new(x, startY, z))
		if not r then
			voids += 1
		else
			hits += 1
			table.insert(heights, r.Position.Y)
			local mat = r.Material.Name
			groundMats[mat] = (groundMats[mat] or 0) + 1
			if r.Instance:IsA("Terrain") then
				terrainHits += 1
			end
			-- Dressing: anything nearby that isn't the floor itself (smaller than a room, above the ground).
			local near = 0
			for _, q in workspace:GetPartBoundsInRadius(r.Position + Vector3.new(0, 3, 0), RADIUS, overlap) do
				local qs = q.Size
				if q ~= r.Instance and not q:IsA("Terrain") and q.Transparency < 0.95 and math.max(qs.X, qs.Y, qs.Z) < RADIUS * 3 and q.Position.Y + qs.Y / 2 > r.Position.Y + 0.5 then
					near += 1
				end
			end
			if near == 0 then
				empty += 1
			end
		end
	end
end
table.sort(heights)
local median = #heights > 0 and heights[math.max(1, math.floor(#heights / 2))] or 0
local spread = #heights > 1 and (pct(heights, 0.9) - pct(heights, 0.1)) or 0
local nGroundMats = 0
for _ in groundMats do
	nGroundMats += 1
end

-- Build and performance: what falls, what snags, what costs.
local function inCharacter(p: Instance): boolean
	local m = p:FindFirstAncestorOfClass("Model")
	while m do
		if m:FindFirstChildOfClass("Humanoid") then
			return true
		end
		m = m:FindFirstAncestorOfClass("Model")
	end
	return false
end
local function note(list: { string }, p: Instance)
	if #list < 3 then
		table.insert(list, p:GetFullName())
	end
end
local loose, tiny, invisibleColliders, preciseSmall, smallShadows, meshParts, uniqueMeshes, renderPrecise = 0, 0, 0, 0, 0, 0, 0, 0
local looseNames: { string } = {}
local tinyNames: { string } = {}
local preciseNames: { string } = {}
local meshIds: { [string]: boolean } = {}
for _, p in everything do
	local s = p.Size
	local maxDim = math.max(s.X, s.Y, s.Z)
	local character = inCharacter(p)
	if not p.Anchored and not character and not p:IsGrounded() then
		loose += 1
		note(looseNames, p)
	end
	if p.CanCollide and not character then
		if p.Transparency >= 0.95 then
			invisibleColliders += 1
		elseif maxDim < 1.5 then
			tiny += 1
			note(tinyNames, p)
		end
	end
	if p.CastShadow and p.Transparency < 0.95 and maxDim < 2 then
		smallShadows += 1
	end
	if p:IsA("MeshPart") then
		meshParts += 1
		local id = p.MeshId
		if id ~= "" and not meshIds[id] then
			meshIds[id] = true
			uniqueMeshes += 1
		end
		local ok, fidelity = pcall(function()
			return p.CollisionFidelity
		end)
		if ok and p.CanCollide and maxDim < 4 and fidelity == Enum.CollisionFidelity.PreciseConvexDecomposition then
			preciseSmall += 1
			note(preciseNames, p)
		end
		local okR, render = pcall(function()
			return p.RenderFidelity
		end)
		if okR and render == Enum.RenderFidelity.Precise then
			renderPrecise += 1
		end
	end
end

-- Lights: how many, and how many cast shadows (each shadowed local light costs every frame it is near).
local lights, shadowLights = 0, 0
local function countLight(d: Instance)
	if d:IsA("Light") then
		lights += 1
		if d.Shadows and d.Enabled then
			shadowLights += 1
		end
	end
end
countLight(root)
for _, d in root:GetDescendants() do
	countLight(d)
end

-- Cover: anything with a Cover attribute or tag (the outermost one of a nested group). Does it block a character
-- (collision above STEP over its base), can shots hit it (a visible part that raycasts see)?
local function isCover(d: Instance): boolean
	return d:GetAttribute("Cover") ~= nil or d:HasTag("Cover")
end
local coverPieces = 0
local walkThrough: { string } = {}
local lowCover: { string } = {}
local shotThrough: { string } = {}
local nWalk, nLow, nShot = 0, 0, 0
local function coverCheck(c: Instance)
	local a = c.Parent
	while a and a ~= workspace do
		if isCover(a) then
			return
		end
		a = a.Parent
	end
	local own: { BasePart } = {}
	if c:IsA("BasePart") then
		table.insert(own, c)
	end
	for _, d in c:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(own, d)
		end
	end
	if #own == 0 then
		return
	end
	coverPieces += 1
	local base, seenTop, solidTop = math.huge, -math.huge, -math.huge
	local hittable = false
	for _, p in own do
		local cf, size = p.CFrame, p.Size
		local halfY = (math.abs(cf.RightVector.Y) * size.X + math.abs(cf.UpVector.Y) * size.Y + math.abs(cf.LookVector.Y) * size.Z) / 2
		if p.Transparency < 0.95 then
			base = math.min(base, cf.Position.Y - halfY)
			seenTop = math.max(seenTop, cf.Position.Y + halfY)
			-- CanQuery is ignored on a part that collides (measured in the run of 2026-10-01: rays still hit it).
			if p.CanQuery or p.CanCollide then
				hittable = true
			end
		end
		if p.CanCollide then
			solidTop = math.max(solidTop, cf.Position.Y + halfY)
		end
	end
	if base == math.huge then
		return
	end
	if solidTop == -math.huge then
		nWalk += 1
		note(walkThrough, c)
	elseif solidTop - base < STEP and seenTop - base >= STEP then
		nLow += 1
		note(lowCover, c)
	end
	if not hittable then
		nShot += 1
		note(shotThrough, c)
	end
end
if isCover(root) then
	coverCheck(root)
end
for _, d in root:GetDescendants() do
	if isCover(d) then
		coverCheck(d)
	end
end
-- Z-fighting: two visible block faces in the same plane, facing the same way, overlapping, and not the same look.
type Face = { c: Vector3, n: Vector3, u: Vector3, v: Vector3, hu: number, hv: number }
local function faces(p: BasePart): { Face }
	local cf, h = p.CFrame, p.Size / 2
	local r, u, l, o = cf.RightVector, cf.UpVector, cf.LookVector, cf.Position
	return {
		{ c = o + r * h.X, n = r, u = u, v = l, hu = h.Y, hv = h.Z },
		{ c = o - r * h.X, n = -r, u = u, v = l, hu = h.Y, hv = h.Z },
		{ c = o + u * h.Y, n = u, u = r, v = l, hu = h.X, hv = h.Z },
		{ c = o - u * h.Y, n = -u, u = r, v = l, hu = h.X, hv = h.Z },
		{ c = o + l * h.Z, n = l, u = r, v = u, hu = h.X, hv = h.Y },
		{ c = o - l * h.Z, n = -l, u = r, v = u, hu = h.X, hv = h.Y },
	}
end
local function coplanarOverlap(a: Face, b: Face): number
	if a.n:Dot(b.n) < 0.999 or math.abs((b.c - a.c):Dot(a.n)) > 0.02 then
		return 0
	end
	local d = b.c - a.c
	local du, dv = d:Dot(a.u), d:Dot(a.v)
	local bu, bv = b.hu, b.hv
	if math.abs(b.u:Dot(a.u)) > 0.999 then
		bu, bv = b.hu, b.hv
	elseif math.abs(b.u:Dot(a.v)) > 0.999 then
		bu, bv = b.hv, b.hu
	else
		-- Turned in the plane: count it when the other face's centre lies on this one.
		return if math.abs(du) < a.hu and math.abs(dv) < a.hv then 1 else 0
	end
	local ou = math.min(a.hu, du + bu) - math.max(-a.hu, du - bu)
	local ov = math.min(a.hv, dv + bv) - math.max(-a.hv, dv - bv)
	return if ou > 0.05 and ov > 0.05 then ou * ov else 0
end
local blocks: { Part } = {}
for _, p in parts do
	if p:IsA("Part") and p.Shape == Enum.PartType.Block and p.Transparency < 0.5 then
		table.insert(blocks, p)
	end
end
local zPairs, zChecked = 0, math.min(#blocks, 6000)
local zNames: { string } = {}
local zParams = OverlapParams.new()
zParams.FilterType = Enum.RaycastFilterType.Include
zParams.FilterDescendantsInstances = { root }
local zSeen: { [BasePart]: boolean } = {}
for k = 1, zChecked do
	local a = blocks[k]
	zSeen[a] = true
	local fas = faces(a)
	for _, q in workspace:GetPartBoundsInBox(a.CFrame, a.Size + Vector3.new(0.1, 0.1, 0.1), zParams) do
		if q ~= a and not zSeen[q] and q:IsA("Part") and q.Shape == Enum.PartType.Block and q.Transparency < 0.5 and (q.Color ~= a.Color or q.Material ~= a.Material) then
			local found = false
			local fbs = faces(q)
			for _, fa in fas do
				for _, fb in fbs do
					if coplanarOverlap(fa, fb) > 0.25 then
						found = true
						break
					end
				end
				if found then
					break
				end
			end
			if found then
				zPairs += 1
				if #zNames < 3 then
					table.insert(zNames, a:GetFullName() .. " x " .. q:GetFullName())
				end
			end
		end
	end
end

local function has(className: string): boolean
	return Lighting:FindFirstChildOfClass(className) ~= nil
end
local atmosphere = Lighting:FindFirstChildOfClass("Atmosphere") :: Atmosphere?
local topMaterials: { { name: string, area: number } } = {}
for m, a in materials do
	table.insert(topMaterials, { name = m, area = a })
end
table.sort(topMaterials, function(a, b)
	return a.area > b.area
end)
local mats: { string } = {}
for k = 1, math.min(6, #topMaterials) do
	table.insert(mats, string.format("%s %d%%", topMaterials[k].name, math.floor(topMaterials[k].area / total * 100 + 0.5)))
end

return HttpService:JSONEncode({
	area = ROOT == "" and "Workspace" or ROOT,
	parts = #parts,
	size = { math.floor(x1 - x0), math.floor(z1 - z0) },
	surface = {
		plainPlastic = math.floor(plain / total * 100 + 0.5),
		grey = math.floor(grey / total * 100 + 0.5),
		greyPlastic = math.floor(greyPlastic / total * 100 + 0.5),
		materials = mats,
	},
	ground = {
		samples = GRID * GRID,
		void = math.floor(voids / (GRID * GRID) * 100 + 0.5),
		terrain = hits > 0 and math.floor(terrainHits / hits * 100 + 0.5) or 0,
		materials = nGroundMats,
		heightSpread = math.floor(spread * 10 + 0.5) / 10,
		empty = hits > 0 and math.floor(empty / hits * 100 + 0.5) or 0,
		radius = RADIUS,
	},
	landmark = math.floor(top - median + 0.5),
	giantFlatParts = giant,
	build = {
		loose = loose,
		looseNames = looseNames,
		tinyColliding = tiny,
		tinyNames = tinyNames,
		invisibleColliders = invisibleColliders,
		preciseSmall = preciseSmall,
		preciseNames = preciseNames,
		smallShadows = smallShadows,
		meshParts = meshParts,
		uniqueMeshes = uniqueMeshes,
		renderPrecise = renderPrecise,
		lights = lights,
		shadowLights = shadowLights,
		streaming = workspace.StreamingEnabled,
		zFighting = zPairs,
		zNames = zNames,
		zChecked = zChecked,
	},
	cover = {
		pieces = coverPieces,
		step = STEP,
		walkThrough = nWalk,
		walkNames = walkThrough,
		low = nLow,
		lowNames = lowCover,
		shotThrough = nShot,
		shotNames = shotThrough,
	},
	lighting = {
		style = tostring(Lighting.LightingStyle),
		clockTime = Lighting.ClockTime,
		atmosphere = atmosphere and atmosphere.Density or nil,
		sky = has("Sky"),
		colorCorrection = has("ColorCorrectionEffect"),
		bloom = has("BloomEffect"),
		sunRays = has("SunRaysEffect"),
	},
})
`;
