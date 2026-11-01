---
name: roblox-environment-art
description: "The craft of a senior environment artist for Roblox, and how to check it without eyes. Read it before lighting, materials, terrain or dressing any area: a visual brief from the genre and references; composition (value structure, landmarks, silhouettes, leading lines, framing, readable lanes and sightlines, cover that reads as cover, scale against the player); lighting (Technology and LightingStyle, sun and sky, Atmosphere density, haze and glare, environment diffuse and specular, exposure, ColorCorrection, Bloom, SunRays, DepthOfField, local lights and their shadow cost, time of day) from lighting_set's presets as code on disk; materials and terrain (MaterialService and MaterialVariants, terrain materials and colours, painting without changing height, water); set dressing at scale with Kiln kits, families and the game's style sheet (when Kiln, when parts), clutter that tells a story; the hand-off to the VFX artist (skill roblox-vfx); screenshots at gameplay camera height measured with look_analyze; performance (streaming, part and triangle budgets, instancing, RenderFidelity, CastShadow, light counts, collision by role) checked with map_audit."
version: 6
tags: [environment, art, map, level, visuals, polish, lighting, atmosphere, fog, haze, terrain, materials, materialvariant, water, foliage, props, dressing, kit, kiln, scatter, palette, mood, composition, landmark, cover, readability, look, screenshot, performance, streaming, beautiful, quality]
roblox_systems: [Lighting, Atmosphere, Sky, Clouds, BloomEffect, ColorCorrectionEffect, SunRaysEffect, DepthOfFieldEffect, MaterialService, MaterialVariant, Terrain, PointLight, SpotLight, SurfaceLight, PhysicsService, CollectionService, Workspace, Model, MeshPart]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [lighting_set, look_analyze, map_audit, roblox_screenshot, world_rebuild, kiln_request, kiln_builds, kiln_layout_import, model_place, model_view, store_search, roblox_run_luau, task_add_evidence]
---
# Environment art: a place players read at a glance and want to screenshot

## Purpose
Players judge a game from the spawn view in five seconds, then play it by reading the space: where to go,
where the enemy is, what is cover, what is danger. Environment art serves both. A correct map with default
lighting and grey parts reads as unfinished; a beautiful map where targets vanish in the haze or players
snag on clutter is broken. This skill is the craft and the checks. `roblox-world-building` covers builders,
tags and audits; `kiln-briefs` covers briefing Kiln; `roblox-vfx` covers weather and effects.

What went wrong in the run of 2026-10-01 (a mech arena at dusk), all avoidable with what follows: every
frame was 77-92% one orange hue (warm sun + ochre haze + warm grade + rust on everything); the "mech
readable at 250 studs" screenshot showed a container 10 studs from the camera and passed review; terrain
patches made with FillCylinder raised the floor into 2-stud plateaus; tyre-stack cover let mechs walk
through it; scaffolding boxes were left standing in the lanes; reviews passed on numbers nobody had looked at.

## The process (one task)
1. **Brief** (below): six lines before building anything.
2. **Blockout with the level designer**: they own the playable layout (lanes, cover positions, spawns,
   heights); you own how it looks and reads. Never move gameplay geometry; ask for changes.
3. **Lighting pass** with `lighting_set` (a preset adapted to the brief), first: it changes every colour.
4. **The map's pieces**: everything players see is built by Kiln in separate pieces (buildings, the
   setting's kit, ground tiles, rock, props) on the style sheet; you assemble them on the graybox.
   Roblox materials and Terrain (section 4) only when the user asked for terrain or a classic look.
5. **Assembly and dressing**: pieces on their footprints, ground tiles on the grid, props in clusters,
   by builder code; the graybox hidden.
6. **VFX hand-off**: weather and ambient effects are the VFX artist's (skill `roblox-vfx`).
7. **Look**: screenshots at gameplay camera height, measured with `look_analyze`; fix, repeat.
8. **Performance and correctness**: `map_audit` until no finding is left without a reason.

## 1. The visual brief
Write it in your evidence (and the spec's art section if there is none) before building:
- **References**: two or three real games or films and what you take from each ("Titanfall's readable
  industrial lanes; Mad Max's dust, not its orange").
- **Mood** in three words, and the **time of day** (a `lighting_set` preset).
- **Palette**: 3-4 world colours with a role each (ground, structure, trim) plus one accent; the
  gameplay colours (teams, pickups, danger) are **reserved** and never used by the world. Take materials
  and colours from the game's style sheet when Kiln has one (spec section "Art style sheet").
- **Material family**: which Roblox materials (or variants) for ground, structure, metal, accents.
- **Shape language**: chunky and rounded (the default cartoon style), angular and worn, organic...
- **What must read, and how**: players and targets (in value against the ground), cover (one family of
  shapes and one material), objectives and hazards (the accent), the hero landmark.

Starting points by genre [convention, adapt to the brief]:
| Genre | Preset | The world's job |
|---|---|---|
| Competitive shooter, arena | clear_day (or dusk_haze with low haze) | Targets read at the longest sightline; calm ground; cover reads as cover |
| Obby, simulator, tycoon | sunny_cartoon | Bright, saturated, the path obvious; props chunky and playful |
| Horror | interior_dark, misty_morning, night_moon | Hide the distance, light the path in pools, black never where the player acts |
| Racing | clear_day, golden_hour | The road and its edges read at speed; no clutter near the racing line |
| Adventure, RPG | golden_hour, misty_morning | Landmarks pull the player; each region its own colour |
| Survival | overcast, misty_morning | Muted, readable resources (they carry the accent) |
| Sci-fi, cyberpunk | neon_night | Two accent hues in Neon trims; dark, clean ground |

## 2. Composition: reading the space
- **Value first.** Squint: a frame should fall into two or three masses (dark, mid, light). The play
  space must differ from the background in value before colour [convention: ΔL* 15 or more; look_analyze
  reports ground against background and value groups]. Players and targets are read by value against
  the ground: keep floors mid-value (L* 35-60) [convention] so characters of any colour separate.
- **Landmarks**: one hero landmark seen from every spawn (orientation; `map_audit` reports the tallest),
  and one secondary landmark per zone. Silhouettes against the sky read from far: keep the skyline above
  the play space clean of clutter.
- **Zones by colour**: give each area its own colour accent or material ("the Container Maze is teal,
  the Crane Yard is yellow") so players know where they are; callouts in the HUD can use the names.
- **Leading lines**: paths, rails, cables, kerbs, light rows and floor markings point at objectives.
  Lights brighter toward the goal pull players.
- **Framing**: gates, arches, cranes and overhangs frame the objective from the approach.
- **Readable lanes**: lanes plain and calm, clutter at their edges, rest spaces between fights. Long
  sightlines need low haze and calm backgrounds; break them on purpose with cover, never by accident.
- **Cover that reads as cover**: one family of shapes, heights and material, so players learn it at a
  glance [convention: low cover about waist height of the character, high cover above the head].
  Its collision must match what it looks like: a Humanoid collides with its root part, which floats
  HipHeight over the ground and steps up small ledges, so collision lower than about its hip height
  doesn't stop it (mechs with HipHeight 4.95 walked through 6-stud tyre stacks). Give cover a `Cover` attribute ("Low"/"High"), add a blocker for big characters (Examples), and
  run `map_audit {area, step}` with step = the characters' root bottom height + 1 (default 3, R15).
- **Scale against the player**: an R15 player is about 5.2 studs (model_view stands models beside one);
  doors 7-8 studs, ceilings 12+, lanes at least three character widths [convention]. For bigger
  characters, scale everything to them, not to the default avatar.
- **Edges**: the player never sees the world end. A ring of silhouettes (hills, buildings, cranes) at the
  edge, Atmosphere to soften it, invisible walls behind; never a 2048-stud slab or huge terrain balls far
  past the play space (they cost streaming and memory and nobody sees them).

## 3. Lighting
**Technology and style.** `Lighting.Technology` (Future, ShadowMap, Voxel...) can't be read or set from
scripts: it is the place's setting in Studio's Properties, and builders that touch it fail. Under Future
every local light can cast shadows; under ShadowMap only the sun does. `Lighting.LightingStyle`
(Realistic or Soft) is settable from a builder (observed: map_audit read Realistic after the arena's
builder set it); `PrioritizeLightingQuality` is set inside a pcall (unverified from scripts). If the place
isn't on Future and the brief needs lit night scenes, say so in your result: the user switches it.

**Start from a preset, as code.** `lighting_set {preset, adjust}` writes `world/Lighting.json` and a
generated `world/Lighting.luau` (world_rebuild re-runs it) and builds it. `lighting_set {list: true}` shows
each preset's intent, what to adapt and what look_analyze should roughly measure. Refine with adjust
alone (earlier adjustments stay): `{"atmosphere": {"Density": 0.22, "Haze": 0.8}, "colorCorrection":
{"TintColor": [250, 248, 246]}}`. Only sunny_cartoon was checked in Studio; treat the others' targets as
starting points and measure.

What each property does (adjust in this order: sun, fill, air, grade):
- **Sun**: `ClockTime` (0-24) and `GeographicLatitude` place the sun; a low sun gives long shadows and
  warm light. Light across the main lanes, not along them, so shadows shape the forms [convention].
  `Brightness` is the sun's (and moon's) intensity. `ColorShift_Top` tints sunlit faces;
  `ColorShift_Bottom` tints faces turned away (a cool bounce).
- **Fill**: `OutdoorAmbient` lights everything in outdoor shadow; `Ambient` lights what the sky can't
  reach (interiors). They decide how dark shadows are: crushed blacks mean they are too low.
  `EnvironmentDiffuseScale` (0-1) adds ambient light from the sky; `EnvironmentSpecularScale` (0-1)
  adds sky reflections (metal and wet surfaces look dead at 0). A bright orange sunset skybox at full
  diffuse floods the ground orange (the arena ran 0.22).
- **Exposure**: `ExposureCompensation` (-3 to 3, in stops) brightens or darkens the whole image after
  lighting: the right tool for "too dark", not Brightness.
- **Air**: `Atmosphere` gives depth. `Density` is how much air (distance fades faster), `Offset` raises
  where the haze sits so distant silhouettes separate from the sky, `Color` and `Decay` tint it (toward
  and away from the sun), `Haze` makes the distance and low sky milky, `Glare` is the glow around the sun
  (only visible with Haze above 0). With an Atmosphere, `Lighting.FogStart/FogEnd/FogColor` are ignored.
  Tune Density against the longest sightline: a target at that distance must still read (measure it).
- **Grade**: `ColorCorrectionEffect` (Brightness, Contrast, Saturation, TintColor) is the final grade:
  keep TintColor near white when the light is already coloured (a warm grade on a warm sun is how frames
  go monochrome). `BloomEffect` (Intensity, Size, Threshold): only pixels brighter than Threshold glow;
  Neon is emissive, so a low threshold makes Neon bloom; too low and the sky and white surfaces wash out.
  `SunRaysEffect` (Intensity, Spread) shows when looking toward the sun: subtle (0.03-0.12) [convention].
  `DepthOfFieldEffect` blurs by distance: menus, cutscenes and photo modes, never competitive gameplay.
  Post effects in Lighting apply to everyone; parented to `workspace.CurrentCamera` they are local to that
  client (a menu blur, a damage flash).
- **Local lights**: `PointLight`, `SpotLight` (Angle, Face), `SurfaceLight`; `Range` up to 60 studs,
  `Brightness`, `Color`, `Shadows`. Each shadow-casting light costs every frame it is in range: shadows
  only on a few hero lights [convention: a dozen or two in view at once; map_audit counts them],
  fill and decorative lights without. Fake small lights with a Neon part (and Bloom) instead of a light.
  Light guides: brighter and warmer toward objectives, pools along night paths.
- **Time of day as mood**: noon is neutral and readable; golden hour warm and heroic; dusk dramatic and
  hard to read into the sun; overcast calm and flat; night tense, carried by local lights. A night scene
  still keeps the playable ground readable [convention: median L* 15-35].

## 4. Materials and terrain
- **Hierarchy of noise**: big surfaces calm (Concrete, Slate, Ground, Asphalt, SmoothPlastic with colour),
  mid surfaces medium, accents busy (CorrodedMetal, DiamondPlate, Rust-coloured trims). Busy materials on
  big surfaces shimmer and swallow silhouettes; look_analyze calls it "speckled". The arena's rust on
  every surface read as one orange camouflage blob.
- **Colour and value per role**: ground mid-value, structures a step darker or lighter than the ground,
  trims and accents from the palette. Never default grey (map_audit's grey-plastic finding).
- **MaterialVariants** (`MaterialService`): a `MaterialVariant` (BaseMaterial, ColorMap, NormalMap,
  RoughnessMap, MetalnessMap, `StudsPerTile`, Pattern) parented to MaterialService, used by a part's
  `MaterialVariant` name; set as the material override in Studio's Material Manager it replaces that base
  material across the place, terrain included. `StudsPerTile` larger calms a noisy texture on big
  surfaces. Variants need uploaded texture maps: ask Kiln for the material set (it owns textures and the
  style sheet's materials) rather than inventing asset ids.
- **Terrain**: `FillBlock`, `FillBall`, `FillCylinder`, `FillWedge`, carve with `Enum.Material.Air`;
  voxels are 4 studs. Two to four ground materials, blended at the edges. `Terrain:SetMaterialColor`
  recolours a material to the palette. **Paint, don't fill**: a Fill* call with a new material raises the
  ground where it overlaps; to change only the material keep the occupancy (`ReadVoxels`/`WriteVoxels`,
  Examples) or use `Terrain:ReplaceMaterial(region, 4, from, to)` for square patches.
- **Grass blades** are Terrain's Decoration setting in Studio's Properties; scripts can't set it.
- **Water**: terrain `Water` material plus `Terrain.WaterColor`, `WaterTransparency`, `WaterReflectance`,
  `WaterWaveSize`, `WaterWaveSpeed`. Calm, dark water reflects the sky and reads as depth.
- **Stains and decals tell traffic**: oil under machines and at lane bends, tyre tracks along the lanes,
  wear on the edges people touch; never evenly sprinkled blobs.

## 5. Set dressing at scale: kits, layouts, Kiln
Think in **kits** and **layouts**. A kit is a family of pieces that share a grid, sockets and the style
sheet (wall, corner, doorway, cover set, clutter set); a layout is where they go. Kits keep a game
consistent and cheap (each mesh uploads once and is reused).

| Need | Make it with |
|---|---|
| A map or district | NOT one request: its pieces from Kiln (the rows below), assembled by your builder code on the level designer's graybox. (A map that already exists in Kiln as a layout project comes in with `kiln_layout_import`.) |
| A building or landmark players recognise (shop, bank, altar, forge) | its own `kiln_request {model, footprint: [w, d], parts: ["Door"]}`; enterable ones in one request with their interior |
| Ground | tiling ground pieces from Kiln (16 or 32 studs, 3-4 variants, edge pieces), or flat-coloured ground meshes for hills and cliffs. Not Roblox Terrain. |
| Modular pieces that must fit (walls, cover set, pipes, fences) | `kiln_request {family, models, sockets, style}`: one Kiln project, each piece its own model |
| A set of props in the game's look (crates, barrels, signs, machines) | `kiln_request {family: "ScrapClutter", models: [...]}` queued with `wait: false`, then `kiln_builds {wait: true}` |
| A hero set piece (a crane, a wrecked titan, a shrine) | its own `kiln_request` (or the modeler's task when it is planned there) |
| Blockout, invisible colliders, blockers, trims, floor paint, simple slabs | parts in a builder (`geometry_apply` or Luau) |
| Rocks, trees, foliage | Kiln, as a small family in the game's style (the Creator Store only when the user asks for a named asset) |

Brief kits as results (skill `kiln-briefs`): what they are, where they are seen, the style paragraph,
sockets as names. Then place them with code: a layout of positions for structure kits, a scatter for
clutter, `model_place` only for one-offs. Check each piece beside the player with `model_view`.

**Clutter that tells a story**: every cluster answers "what happened here" (a mechanic's corner: tyres,
a jack, an oil drum on its side, a stain; a crashed load under a crane). One large piece, two or three
medium, several small [convention: clusters of 3-7]; vary rotation and scale (±20%); dense at walls and
corners, sparse in lanes, nothing on spawns. Small clutter has no collision (CanCollide, CanTouch and
CanQuery off, CastShadow off when under 2 studs); what players should bump into gets a simple box
collider. Snap everything to the ground by raycast; nothing floats, nothing is buried more than it would
be. Delete scaffolding and reference boxes when done (map_audit lists tiny colliders and loose parts).

## 6. Weather and environment effects: the VFX artist's
Rain, snow, embers, fog banks, fireflies, falling leaves, dust motes, steam and smoke plumes are the VFX
artist's craft (skill `roblox-vfx`). You decide where and why: give them anchor parts or tagged positions
(the crusher's exhaust, a steam vent, the dusty zones), the mood, the palette and how readable the play
space must stay. Ambient particles never cover the crosshair or the lanes, and their cost counts in the
same budget as your lights.

## 7. Look: screenshots at gameplay height, measured
- **Where**: the spawn view; each lane looking both ways, including into the sun; one overview; and a
  target at the longest engagement distance (place a stand-in of the character's size there). The camera
  at the player's eye (about 4.5-5 studs over the ground for R15) or the game's own camera (a mech's
  shoulder camera), never only from the sky.
- **Measure every shot**: `look_analyze {view: "gameplay", mood, regions}`. Give the target's box as a
  region: ΔL* and ΔE against its surroundings say whether it reads [convention for something a player must
  spot: ΔL* 15+ or ΔE 25+], and a region that matches its surroundings exactly means the target isn't in
  the frame at all (the arena's "readability" shot was a container wall).
- **Read it**: Monochrome → neutral TintColor and Atmosphere.Color, a cool OutdoorAmbient, accent hues.
  Strong cast → the same, or the skybox. Flat / no darks → less Atmosphere or Ambient. Dark → exposure, not
  more sun. Crushed → more fill. Blown highlights → Bloom threshold up, Neon down. Haze swallows the
  distance → Density or Haze down, Offset up. Ground grey / colourless → palette and material colours.
  Speckled or busy → calmer materials on big surfaces, clutter into clusters. The play space doesn't
  separate → ground value against sky value.
- **When Studio isn't drawing**: look_analyze the newest screenshots there are, run map_audit, and say in
  your result that nobody has looked at the new look yet ("visual check pending"); never claim a look you
  didn't measure or see.

## 8. Performance
- **Streaming** (`Workspace.StreamingEnabled`, on by default in new places): clients hold what is near
  them. Big set pieces stream as whole models (`ModelStreamingMode` Atomic); keep distant silhouettes few
  and simple; don't make Persistent what isn't needed everywhere.
- **Budgets** [convention, for phones too]: a small map under about 8-10k parts; props in Kiln's `tris`
  budget (a background prop a few hundred triangles, a hero piece a few thousand); reuse meshes (the same
  MeshId many times is cheaper than many meshes: Kiln's layouts instance repeated pieces).
- **RenderFidelity**: Automatic (detail drops with distance) for props; Precise only for hero pieces seen
  up close.
- **CastShadow** off on small parts and on distant scenery; shadows from big shapes only.
- **Lights**: few shadowed; Neon for the small ones.
- **CollisionFidelity by role**: walkable ground Default or PreciseConvexDecomposition; props Box or Hull;
  decor no collision at all. Precise collision on small props costs physics for nothing (map_audit
  flags it).
- `map_audit {area}`: the area's materials, ground, landmark and lighting, plus cover, loose parts, tiny
  colliders, precise small props, shadowed lights, small shadow casters and z-fighting faces. Fix each
  finding or say why it doesn't apply; put its numbers in your evidence.

## Known pitfalls
- **Monochrome by stacking**: warm sun, warm haze, warm grade, rust everywhere. One warm source is enough.
- **Claiming what the frame doesn't show**: measure the target region; look at the shot.
- **Fill* to paint**: raises the ground. Paint with WriteVoxels or ReplaceMaterial.
- **Cover that only looks solid**: no collision, or collision below the character's step; shots through
  invisible parts. map_audit with the right step.
- **Scaffolding left in**: reference boxes, test parts, stand-ins in lanes. Builders own their folders and
  rebuild them; delete the rest.
- **The world's end**: floating outskirts, a visible terrain edge, a giant slab out to 1024 studs.
- **Properties scripts can't touch**: `Lighting.Technology`, `Terrain.Decoration` (one such line fails
  the whole builder).
- **Default everything**: default lighting, grey SmoothPlastic, one ground material, a baseplate edge.
- **Over-saturation**: ColorCorrection Saturation above ~0.3, Neon walls, Bloom washing out the sky.
- **Too dark to play**: the pretty dark frame isn't the playable one; check at normal exposure.

## Verification
Before finishing: screenshots from the spawn, each lane both ways (one into the sun), an overview and a
target at range, each measured with `look_analyze` (fix its problems or state why the brief wants it);
`map_audit` on each area with the characters' step; the builders re-run cleanly with `world_rebuild`
(idempotent: a second run gives the same counts). Attach shots, look lines and audit numbers as evidence.

## Examples
Paint terrain material in a soft circle without moving the ground (`world/GroundPaint.luau`):
```lua
local Terrain = workspace.Terrain
local VOXEL = 4

-- Changes only the material of solid voxels inside a circle; the occupancy (the ground's shape) is kept.
local function paint(center: Vector3, radius: number, material: Enum.Material, only: Enum.Material?)
	local half = Vector3.new(radius + VOXEL, 8, radius + VOXEL)
	local region = Region3.new(center - half, center + half):ExpandToGrid(VOXEL)
	local materials, occupancies = Terrain:ReadVoxels(region, VOXEL)
	local origin = region.CFrame.Position - region.Size / 2
	for x = 1, #materials do
		for y = 1, #materials[x] do
			for z = 1, #materials[x][y] do
				local p = origin + Vector3.new(x - 0.5, y - 0.5, z - 0.5) * VOXEL
				local d = Vector2.new(p.X - center.X, p.Z - center.Z).Magnitude
				local solid = occupancies[x][y][z] > 0
				if solid and d <= radius and (only == nil or materials[x][y][z] == only) then
					materials[x][y][z] = material
				end
			end
		end
	end
	Terrain:WriteVoxels(region, VOXEL, materials, occupancies)
end

local rng = Random.new(21) -- fixed seed: the builder stays idempotent
for _ = 1, 24 do -- mud at the lane bends, irregular because the circles overlap
	local at = Vector3.new(rng:NextNumber(-180, 180), 0, rng:NextNumber(-180, 180))
	for k = 1, 3 do
		paint(at + Vector3.new(k * 5, 0, rng:NextNumber(-4, 4)), rng:NextNumber(6, 12), Enum.Material.Mud, Enum.Material.Ground)
	end
end
Terrain:SetMaterialColor(Enum.Material.Mud, Color3.fromRGB(86, 72, 60))
return "ground painted"
```

Clusters that tell a story, with collision by role (`world/Dressing.luau`; kit models in `ServerStorage.Kit`):
```lua
local Kit = game:GetService("ServerStorage"):FindFirstChild("Kit")
if not Kit then
	return "no ServerStorage.Kit yet: bring the kit in first (kiln_request family, then model_place or the import)"
end
local old = workspace:FindFirstChild("Dressing")
if old then
	old:Destroy()
end
local out = Instance.new("Folder")
out.Name = "Dressing"
local rng = Random.new(42)
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Exclude
params.FilterDescendantsInstances = { out }

-- Decor never snags or blocks shots; a big piece gets one invisible box collider instead of mesh collision.
local function settle(m: Model, solid: boolean)
	local cf, size = m:GetBoundingBox()
	for _, p in m:GetDescendants() do
		if p:IsA("BasePart") then
			p.Anchored = true
			p.CanCollide = false
			p.CanTouch = false
			p.CanQuery = false
			p.CastShadow = p.Size.Magnitude >= 3.5
		end
	end
	if solid then
		local box = Instance.new("Part")
		box.Name = "Collider"
		box.Size = size
		box.CFrame = cf
		box.Transparency = 1
		box.Anchored = true
		box.CastShadow = false
		box.Parent = m
	end
end

local function drop(name: string, at: Vector3, scale: number, solid: boolean): boolean
	local template = Kit:FindFirstChild(name)
	if not (template and template:IsA("Model")) then
		return false
	end
	local hit = workspace:Raycast(at + Vector3.new(0, 100, 0), Vector3.new(0, -200, 0), params)
	if not hit or hit.Normal.Y < 0.8 then
		return false -- walls and slopes: skip
	end
	local m = template:Clone()
	m:ScaleTo(scale)
	local box, size = m:GetBoundingBox()
	local lift = m:GetPivot().Position.Y - (box.Position.Y - size.Y / 2)
	m:PivotTo(CFrame.new(hit.Position + Vector3.new(0, lift - 0.1, 0)) * CFrame.Angles(0, rng:NextNumber(0, math.pi * 2), 0))
	settle(m, solid)
	m.Parent = out
	return true
end

-- Each cluster is a little story: one large piece, a few medium, several small, against a wall.
local STORIES = {
	{ at = Vector3.new(-190, 0, 60), large = "TyreStack", medium = { "Drum", "Jack" }, small = { "Tyre", "Wrench", "Can" } },
	{ at = Vector3.new(150, 0, -170), large = "CrushedCar", medium = { "Drum", "Pallet" }, small = { "Can", "Plank" } },
}
local placed = 0
for _, s in STORIES do
	placed += if drop(s.large, s.at, rng:NextNumber(0.9, 1.1), true) then 1 else 0
	for i = 1, 3 do
		local a = rng:NextNumber(0, math.pi * 2)
		local off = Vector3.new(math.cos(a), 0, math.sin(a)) * rng:NextNumber(4, 8)
		placed += if drop(s.medium[(i - 1) % #s.medium + 1], s.at + off, rng:NextNumber(0.85, 1.15), false) then 1 else 0
	end
	for _ = 1, 5 do
		local a = rng:NextNumber(0, math.pi * 2)
		local off = Vector3.new(math.cos(a), 0, math.sin(a)) * rng:NextNumber(5, 12)
		placed += if drop(s.small[rng:NextInteger(1, #s.small)], s.at + off, rng:NextNumber(0.8, 1.2), false) then 1 else 0
	end
end
out.Parent = workspace
return "placed " .. placed
```

A blocker that stops big characters at low cover while shots still hit the visible cover
(`world/CoverBlockers.luau`; game code puts the characters' root parts in the "Characters" group):
```lua
local PhysicsService = game:GetService("PhysicsService")
local CollectionService = game:GetService("CollectionService")
local GROUP, CHARACTERS = "CoverBlocker", "Characters"
local HEIGHT = 12 -- above the cover's base: up to the characters' chest

for _, name in { GROUP, CHARACTERS } do
	if not PhysicsService:IsCollisionGroupRegistered(name) then
		PhysicsService:RegisterCollisionGroup(name)
	end
end
-- Only characters collide with blockers. CanQuery is ignored on a colliding part, so the group is what lets
-- raycasts (RaycastParams.CollisionGroup "Default") pass through to the visible cover.
for _, g in PhysicsService:GetRegisteredCollisionGroups() do
	PhysicsService:CollisionGroupSetCollidable(GROUP, g.name, g.name == CHARACTERS)
end

for _, b in CollectionService:GetTagged("CoverBlocker") do
	b:Destroy()
end
local made = 0
for _, cover in workspace:GetDescendants() do
	if cover:GetAttribute("Cover") == "Low" and (cover:IsA("Model") or cover:IsA("BasePart")) then
		local cf: CFrame, size: Vector3
		if cover:IsA("Model") then
			cf, size = cover:GetBoundingBox()
		else
			cf, size = (cover :: BasePart).CFrame, (cover :: BasePart).Size
		end
		local base = cf.Position.Y - size.Y / 2
		local blocker = Instance.new("Part")
		blocker.Name = "MechBlocker"
		blocker.Size = Vector3.new(size.X + 0.5, HEIGHT, size.Z + 0.5)
		blocker.CFrame = CFrame.new(cf.Position.X, base + HEIGHT / 2, cf.Position.Z) * cf.Rotation
		blocker.Anchored = true
		blocker.Transparency = 1
		blocker.CastShadow = false
		blocker.CanTouch = false
		blocker.CollisionGroup = GROUP
		blocker:AddTag("CoverBlocker")
		blocker.Parent = cover
		made += 1
	end
end
return "blockers: " .. made
```

A row of lamp posts: every one lights the lane, only a few cast shadows (`world/Lamps.luau`):
```lua
local function lamp(at: Vector3, shadows: boolean): Model
	local m = Instance.new("Model")
	m.Name = "Lamp"
	local pole = Instance.new("Part")
	pole.Size = Vector3.new(0.8, 18, 0.8)
	pole.CFrame = CFrame.new(at + Vector3.new(0, 9, 0))
	pole.Material = Enum.Material.Metal
	pole.Color = Color3.fromRGB(58, 60, 64)
	pole.Anchored = true
	pole.Parent = m
	local head = Instance.new("Part")
	head.Size = Vector3.new(2.4, 0.5, 1.4)
	head.CFrame = CFrame.new(at + Vector3.new(0, 18.2, 0))
	head.Material = Enum.Material.Neon -- the glow reads even without a light (Bloom picks it up)
	head.Color = Color3.fromRGB(255, 196, 120)
	head.CastShadow = false
	head.Anchored = true
	head.Parent = m
	local light = Instance.new("SpotLight")
	light.Face = Enum.NormalId.Bottom
	light.Angle = 80
	light.Range = 40
	light.Brightness = 2
	light.Color = Color3.fromRGB(255, 190, 130)
	light.Shadows = shadows
	light.Parent = head
	m.PrimaryPart = pole
	return m
end

local old = workspace:FindFirstChild("Lamps")
if old then
	old:Destroy()
end
local folder = Instance.new("Folder")
folder.Name = "Lamps"
for i = 0, 7 do
	-- Every lamp lights the lane; only every fourth casts shadows.
	lamp(Vector3.new(-140 + i * 40, 0, -60), i % 4 == 0).Parent = folder
end
folder.Parent = workspace
return "lamps: 8, shadowed: 2"
```

## References
- Shuriken: `lighting_set` (presets, `world/Lighting.json`), `look_analyze` (screenshot measurements),
  `map_audit`, `world_rebuild`, skills `roblox-world-building`, `kiln-briefs`, `roblox-vfx`.
- https://create.roblox.com/docs/environment/lighting
- https://create.roblox.com/docs/environment/atmosphere
- https://create.roblox.com/docs/environment/post-processing-effects
- https://create.roblox.com/docs/effects/light-sources
- https://create.roblox.com/docs/parts/materials (MaterialService, MaterialVariant)
- https://create.roblox.com/docs/parts/terrain (ReadVoxels, WriteVoxels, ReplaceMaterial, water)
- https://create.roblox.com/docs/workspace/streaming
- https://create.roblox.com/docs/workspace/collisions (collision groups, CollisionFidelity)
- https://create.roblox.com/docs/performance-optimization/improve
