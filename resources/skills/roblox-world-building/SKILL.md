---
name: roblox-world-building
description: "Build and audit Roblox maps from code in Studio: idempotent builder programs, anchored parts, Models with PrimaryPart and pivots, CollectionService tags and attributes for game logic, overlap audits, terrain, lighting, StreamingEnabled implications, generation tools and vetting Creator Store models before use."
version: 1
tags: [world, building, map, level, terrain, lighting, parts, models, tags, assets, streaming, audit]
roblox_systems: [Workspace, Part, Model, Terrain, Lighting, Atmosphere, CollectionService, SpawnLocation, MaterialService, ServerStorage]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_run_luau, roblox_snapshot, roblox_screenshot, roblox_explore, roblox_inspect, roblox_search, roblox_call, roblox_console, roblox_status, task_add_evidence, test_register]
---
# World building from code

> **What players see is not built here.** Parts from builders are the graybox (collision, lanes, footprints),
> colliders, triggers and markers. Buildings, kits, ground, rock and props are Kiln's pieces (skill
> `kiln-briefs`, Map pieces), placed by builder code on the graybox. Terrain (step 6), Creator Store models
> (step 10) and generated models (step 11) are for when the user asks for them.

## Purpose
Build maps that are correct, reproducible and machine-checkable: every structure comes from a builder program on disk, every gameplay-relevant object carries tags and attributes that systems read, nothing overlaps or floats, and every third-party asset is inspected before it can run. The place (not git) stores the result, so builders and audits are what make it reviewable.

## Preconditions
- `roblox_status` shows Edit mode (no playtest running).
- A layout plan: `Workspace.Map` subfolders such as `Ground`, `Structures`, `Nodes`, `Spawns`, `Props`, plus the project's grid unit (e.g. 4 studs) and coordinate conventions.
- Builder programs live on disk under `world/` (outside the sync map, e.g. `world/*.luau`); you read them and pass their text to `roblox_run_luau`.

## Workflow
1. **Snapshot first**: `roblox_snapshot {roots: ["Workspace.Map"]}` so the change can be diffed.
2. **Write an idempotent builder**: it owns exactly one folder or model, destroys it and rebuilds it, so re-running never duplicates. It sets properties before `Parent` (parent last, per model), uses `Anchored = true` for anything static, and returns a JSON summary (counts, bounds, names).
3. **Group and pivot**: each logical object is a `Model` with a `PrimaryPart` (or an explicit `WorldPivot`); move models with `PivotTo`/`GetPivot` (`SetPrimaryPartCFrame` is deprecated). Use `Model:GetBoundingBox()` for footprints.
4. **Game logic via tags and attributes**: tags say what an object is (`ResourceNode`, `SafeZone`, `Workbench`, `LootChest`), attributes carry parameters (`NodeType = "Tree"`, `Tier = 2`). Systems find them with `CollectionService:GetTagged` plus added/removed signals; never by name paths or a script inside each object.
5. **Collision and query flags**: decorative parts get `CanCollide`, `CanTouch` and `CanQuery` set to false where possible (cheaper physics and cleaner raycasts); triggers are `CanCollide = false`, `CanTouch = true`, invisible.
6. **Terrain** (`workspace.Terrain`): `FillBlock`, `FillBall`, `FillCylinder`, `FillWedge`, `FillRegion`; carve with `Enum.Material.Air`; voxels are 4 studs, so align terrain edges to a 4-stud grid. Never place parts inside terrain.
7. **Lighting**: set `ClockTime`, `Brightness`, `Ambient`, `OutdoorAmbient`, `EnvironmentDiffuseScale`, `EnvironmentSpecularScale`, and add an `Atmosphere` and a `Sky`. `Lighting.Technology` is deprecated; check `LightingStyle` with `roblox_inspect Lighting` instead of assuming a technology.
8. **Audit** every change: run the overlap audit (0 overlapping pairs), an unanchored-part count, and tag/attribute coverage (Verification). Fix and re-run until clean.
9. **Look at it**: `roblox_screenshot` from an overview camera and from player eye height at the spawn (`camera` and `look_at` in world coordinates). Screenshots are saved as evidence; describe what they show in your result.
10. **Third-party models**: `roblox_call search_asset` (`scope: "creator_store"`, `verifiedCreatorsOnly: true`, `priceFilter: "free"`), then `roblox_call insert_asset` with `parentPath: "game.ServerStorage.Quarantine"` and `assetName`, then run the vetting program (Examples). Use the model only if it is clean; strip all scripts from purely visual models; move it into `Workspace.Map` with `PivotTo`; record asset id and creator in your result.
11. **Generated models**: `roblox_call generate_procedural_model {prompt, async: true}` (limit 50 per rolling 24 h) or `generate_mesh {textPrompt, size, maxTriangles}` (12–20000 triangles, at most 8 parts), then `wait_job_finished {jobId}` with `timeout_sec` above 600. Anchor, scale and place the result, then audit it like hand-built parts.
12. **Report**: list every world change in `robloxChanges` and remind the user to save or publish; the place is not in git.

## Known pitfalls
- **Non-idempotent builders** duplicate geometry on every run, which creates overlaps and z-fighting.
- **Unanchored map parts** fall, get flung, and become client-owned physics near players. Anchor everything static.
- **Overlapping coplanar faces z-fight** and look broken. `GetPartBoundsInBox` compares bounding boxes and reports mere neighbours, so filter candidates with an exact oriented-box test that tolerates touching faces. The audit treats every part as a box: wedges, cylinders and meshes need an `AllowOverlap` attribute if they intentionally intersect.
- **Parenting before setting properties** replicates and simulates every intermediate state; build the model off-DataModel, then parent it once.
- **Part budgets**: thousands of tiny parts cost memory and streaming time; merge into larger parts or MeshParts where it doesn't hurt gameplay.
- **Streaming (on by default in new places)**: clients only hold nearby content (`StreamingMinRadius` 64, `StreamingTargetRadius` 1024 by default), so client code must tolerate missing instances. Use `ModelStreamingMode = Atomic` for models that must arrive whole, `Persistent` sparingly for small always-needed models, and `Player:RequestStreamAroundAsync` before teleports. The server always has everything.
- **Scripts in synced folders**: never put builder-created parts, remotes or other non-script instances inside Script Sync folders, and never tag or attribute scripts.
- **Creator Store assets can carry backdoors**: `require(<assetId>)`, `loadstring`, `getfenv`/`setfenv`, obfuscated strings, stray RemoteEvents, scripts hidden deep inside parts or disabled. `insert_asset` sandboxes inserted scripts, which limits damage but is not a review. `insert_asset` defaults to Workspace, where scripts would run at the next playtest: always pass a quarantine `parentPath`.
- **Packages** (`PackageLink`) auto-update from their source; convert to a plain model before editing.
- **Generation quotas and moderation**: procedural models 50 per rolling 24 h, at most 5 concurrent generation jobs; prompts can be rejected silently. Don't retry blindly.
- **Team Create**: other people may be editing; keep builders scoped to their own folder.

## Verification
Overlap audit (`luau_assert`, edit):
```lua
local TOL = 0.05 -- studs; touching faces are fine
local roots = { workspace:FindFirstChild("Map") }
if #roots == 0 then return "FAIL: Workspace.Map missing" end

local function obbOverlap(a: BasePart, b: BasePart): boolean
	local A = { a.CFrame.RightVector, a.CFrame.UpVector, a.CFrame.LookVector }
	local B = { b.CFrame.RightVector, b.CFrame.UpVector, b.CFrame.LookVector }
	local ea, eb = a.Size / 2, b.Size / 2
	local d = b.Position - a.Position
	local axes = table.clone(A)
	for _, v in B do table.insert(axes, v) end
	for _, u in A do
		for _, v in B do
			local c = u:Cross(v)
			if c.Magnitude > 1e-4 then table.insert(axes, c.Unit) end
		end
	end
	for _, axis in axes do
		local ra = ea.X * math.abs(A[1]:Dot(axis)) + ea.Y * math.abs(A[2]:Dot(axis)) + ea.Z * math.abs(A[3]:Dot(axis))
		local rb = eb.X * math.abs(B[1]:Dot(axis)) + eb.Y * math.abs(B[2]:Dot(axis)) + eb.Z * math.abs(B[3]:Dot(axis))
		if math.abs(d:Dot(axis)) >= ra + rb - TOL then return false end
	end
	return true
end

local params = OverlapParams.new()
params.FilterType = Enum.RaycastFilterType.Include
params.FilterDescendantsInstances = roots
local seen: { [BasePart]: { [BasePart]: boolean } } = {}
local found: { string } = {}
for _, part in roots[1]:GetDescendants() do
	if part:IsA("BasePart") and not part:GetAttribute("AllowOverlap") then
		for _, other in workspace:GetPartBoundsInBox(part.CFrame, part.Size, params) do
			if other ~= part and not other:GetAttribute("AllowOverlap") and not (seen[other] and seen[other][part]) then
				seen[part] = seen[part] or {}
				seen[part][other] = true
				if obbOverlap(part, other) then
					table.insert(found, `{part:GetFullName()} x {other:GetFullName()}`)
				end
			end
		end
	end
end
return if #found == 0 then "PASS" else `FAIL: {#found} overlapping pairs: {table.concat(found, "; ", 1, math.min(#found, 10))}`
```

Structure and logic coverage (`luau_assert`, edit):
```lua
local CollectionService = game:GetService("CollectionService")
local map = workspace:FindFirstChild("Map")
if not map then return "FAIL: Workspace.Map missing" end
local loose = 0
for _, p in map:GetDescendants() do
	if p:IsA("BasePart") and not p.Anchored then loose += 1 end
end
if loose > 0 then return `FAIL: {loose} unanchored parts under Workspace.Map` end
if #CollectionService:GetTagged("SafeZone") == 0 then return "FAIL: no SafeZone-tagged part" end
for _, node in CollectionService:GetTagged("ResourceNode") do
	if not (node:IsA("Model") and node.PrimaryPart and node:GetAttribute("NodeType")) then
		return `FAIL: {node:GetFullName()} needs to be a Model with PrimaryPart and NodeType`
	end
end
return "PASS"
```

## Examples
Idempotent builder with tags, attributes and a pivot (Edit):
```lua
--!strict
local HttpService = game:GetService("HttpService")

local map = workspace:FindFirstChild("Map") or Instance.new("Folder")
map.Name = "Map"
map.Parent = workspace
local nodes = map:FindFirstChild("Nodes") or Instance.new("Folder")
nodes.Name = "Nodes"
nodes.Parent = map
for _, old in nodes:GetChildren() do
	if old:GetAttribute("BuiltBy") == "trees.luau" then
		old:Destroy()
	end
end

local function tree(position: Vector3): Model
	local model = Instance.new("Model")
	model.Name = "Tree"
	local trunk = Instance.new("Part")
	trunk.Name = "Trunk"
	trunk.Anchored = true
	trunk.Size = Vector3.new(4, 16, 4)
	trunk.CFrame = CFrame.new(position + Vector3.new(0, 8, 0))
	trunk.Material = Enum.Material.Wood
	trunk.Parent = model
	local crown = Instance.new("Part")
	crown.Name = "Crown"
	crown.Anchored = true
	crown.Size = Vector3.new(12, 8, 12)
	crown.CFrame = CFrame.new(position + Vector3.new(0, 20, 0))
	crown.Material = Enum.Material.Grass
	crown.Parent = model
	model.PrimaryPart = trunk
	model.ModelStreamingMode = Enum.ModelStreamingMode.Atomic
	model:SetAttribute("NodeType", "Tree")
	model:SetAttribute("BuiltBy", "trees.luau")
	model:AddTag("ResourceNode")
	model.Parent = nodes -- parent last
	return model
end

local count = 0
for x = -2, 2 do
	for z = -2, 2 do
		tree(Vector3.new(x * 24, 0, z * 24 + 80))
		count += 1
	end
end
return HttpService:JSONEncode({ trees = count, folder = nodes:GetFullName() })
```

Terrain and lighting (Edit):
```lua
local terrain = workspace.Terrain
terrain:FillBlock(CFrame.new(0, -8, 0), Vector3.new(512, 16, 512), Enum.Material.Grass)
terrain:FillBlock(CFrame.new(96, -4, 96), Vector3.new(64, 8, 64), Enum.Material.Air) -- carve a basin
terrain:FillBlock(CFrame.new(96, -6, 96), Vector3.new(64, 4, 64), Enum.Material.Water)

local Lighting = game:GetService("Lighting")
Lighting.ClockTime = 14
Lighting.Brightness = 2
Lighting.Ambient = Color3.fromRGB(70, 70, 80)
Lighting.OutdoorAmbient = Color3.fromRGB(120, 120, 130)
local atmosphere = Lighting:FindFirstChildOfClass("Atmosphere") or Instance.new("Atmosphere")
atmosphere.Density = 0.3
atmosphere.Haze = 1
atmosphere.Parent = Lighting
return "PASS: terrain and lighting set"
```

Vet a quarantined asset (Edit; returns findings as JSON):
```lua
local HttpService = game:GetService("HttpService")
local quarantine = game:GetService("ServerStorage"):FindFirstChild("Quarantine")
if not quarantine then return HttpService:JSONEncode({ error = "ServerStorage.Quarantine missing" }) end
local PATTERNS = {
	{ "require%s*%(%s*%d", "require(assetId)" }, { "loadstring", "loadstring" },
	{ "getfenv", "getfenv" }, { "setfenv", "setfenv" }, { "HttpService", "HttpService" },
	{ "MarketplaceService", "MarketplaceService" }, { "TeleportService", "TeleportService" },
	{ "InsertService", "InsertService" }, { "\\%d%d%d", "decimal escapes" }, { "\\x%x%x", "hex escapes" },
}
local report = { scripts = 0, remotes = 0, flagged = {} }
for _, d in quarantine:GetDescendants() do
	if d:IsA("BaseRemoteEvent") or d:IsA("RemoteFunction") then
		report.remotes += 1
		table.insert(report.flagged, { path = d:GetFullName(), hits = { "remote object" } })
	elseif d:IsA("LuaSourceContainer") then
		report.scripts += 1
		local src, hits = d.Source, {}
		for _, pattern in PATTERNS do
			if string.find(src, pattern[1]) then table.insert(hits, pattern[2]) end
		end
		for line in string.gmatch(src, "[^\n]+") do
			if #line > 800 then
				table.insert(hits, "very long line (obfuscation?)")
				break
			end
		end
		if #hits > 0 then table.insert(report.flagged, { path = d:GetFullName(), hits = hits }) end
	end
end
return HttpService:JSONEncode(report)
```
Strip scripts from a visual-only model once reviewed: `for _, d in model:GetDescendants() do if d:IsA("LuaSourceContainer") then d:Destroy() end end`.

## References
- https://create.roblox.com/docs/parts/models
- https://create.roblox.com/docs/parts/terrain
- https://create.roblox.com/docs/reference/engine/classes/Lighting
- https://create.roblox.com/docs/reference/engine/classes/CollectionService
- https://create.roblox.com/docs/reference/engine/classes/WorldRoot (GetPartBoundsInBox vs GetPartsInPart)
- https://create.roblox.com/docs/workspace/streaming
- https://create.roblox.com/docs/production/creator-store
- https://create.roblox.com/docs/parts/procedural-models
- https://create.roblox.com/docs/studio/mcp
