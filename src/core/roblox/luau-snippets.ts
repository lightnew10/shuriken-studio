/**
 * Luau programs Shuriken runs inside Studio through `execute_luau`. Each returns a JSON string.
 * Placeholders (__PATH__, __ROOTS__, __MAX__) are replaced with JSON-encoded values before use.
 * Known limitation: dot-separated paths are ambiguous for instances whose names contain dots.
 */
import { PART_FLAG } from '@shared/viewer';

const RESOLVE = `
local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")
local function resolve(path)
  if path == nil or path == "" or path == "game" then return game end
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
local function pathOf(inst)
  if inst == game then return "game" end
  local parts = {}
  local cur = inst
  while cur and cur ~= game do
    table.insert(parts, 1, cur.Name)
    cur = cur.Parent
  end
  return table.concat(parts, ".")
end
local function enc(v)
  local t = typeof(v)
  if t == "Vector3" then return { math.round(v.X * 1000) / 1000, math.round(v.Y * 1000) / 1000, math.round(v.Z * 1000) / 1000 }
  elseif t == "Vector2" then return { v.X, v.Y }
  elseif t == "Color3" then return v:ToHex()
  elseif t == "CFrame" then
    local rx, ry, rz = v:ToOrientation()
    return { pos = enc(v.Position), rot = { math.round(math.deg(rx) * 100) / 100, math.round(math.deg(ry) * 100) / 100, math.round(math.deg(rz) * 100) / 100 } }
  elseif t == "UDim2" then return { v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset }
  elseif t == "UDim" then return { v.Scale, v.Offset }
  elseif t == "EnumItem" then return tostring(v)
  elseif t == "Instance" then return pathOf(v)
  elseif t == "BrickColor" then return v.Name
  elseif t == "number" or t == "string" or t == "boolean" or t == "nil" then return v
  else return tostring(v) end
end
local function fnv(s)
  local h = 2166136261
  for i = 1, #s do
    h = bit32.bxor(h, string.byte(s, i))
    h = (h * 16777619) % 4294967296
  end
  return string.format("%08x", h)
end
`;

export const LUAU_TREE = `${RESOLVE}
local root = resolve(__PATH__)
if root == nil then return HttpService:JSONEncode({ error = "not found", path = __PATH__ }) end
local children = {}
local list = root:GetChildren()
if root == game then
  list = {}
  for _, name in ipairs({ "Workspace", "Players", "Lighting", "MaterialService", "ReplicatedFirst", "ReplicatedStorage",
    "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "Teams", "SoundService",
    "TextChatService", "CollectionService" }) do
    local ok, svc = pcall(function() return game:GetService(name) end)
    if ok and svc then table.insert(list, svc) end
  end
end
for i, c in ipairs(list) do
  if i > 500 then break end
  table.insert(children, { name = c.Name, className = c.ClassName, path = pathOf(c), childCount = #c:GetChildren() })
end
table.sort(children, function(a, b) return a.name:lower() < b.name:lower() end)
return HttpService:JSONEncode({ path = pathOf(root), className = root.ClassName, total = #list, children = children })
`;

export const LUAU_DETAIL = `${RESOLVE}
local inst = resolve(__PATH__)
if inst == nil then return HttpService:JSONEncode({ error = "not found", path = __PATH__ }) end
local props = {}
local candidates = { "Name", "ClassName", "Archivable",
  "Position", "Size", "Orientation", "CFrame", "Anchored", "CanCollide", "CanTouch", "CanQuery", "Transparency", "Reflectance",
  "Color", "Material", "MaterialVariant", "Shape", "CastShadow", "Massless", "CollisionGroup",
  "PrimaryPart", "WorldPivot", "ModelStreamingMode",
  "Enabled", "RunContext", "Disabled",
  "Value", "Text", "TextColor3", "TextSize", "Font", "BackgroundColor3", "BackgroundTransparency", "Visible", "ZIndex",
  "AnchorPoint", "LayoutOrder", "Image", "ResetOnSpawn", "IgnoreGuiInset", "DisplayOrder",
  "SoundId", "Volume", "Looped", "Playing", "AnimationId", "MeshId", "TextureID", "Texture",
  "Brightness", "Range", "Rate", "Lifetime", "Speed",
  "Health", "MaxHealth", "WalkSpeed", "JumpPower", "RespawnLocation", "TeamColor", "AutoAssignable",
  "ClockTime", "Ambient", "OutdoorAmbient", "Technology", "StreamingEnabled", "Gravity" }
for _, name in ipairs(candidates) do
  local ok, v = pcall(function() return inst[name] end)
  if ok and v ~= nil and typeof(v) ~= "RBXScriptSignal" and typeof(v) ~= "function" then props[name] = enc(v) end
end
local attrs = {}
for k, v in pairs(inst:GetAttributes()) do attrs[k] = enc(v) end
local out = { path = pathOf(inst), className = inst.ClassName, properties = props, attributes = attrs,
  tags = CollectionService:GetTags(inst), childCount = #inst:GetChildren() }
if inst:IsA("LuaSourceContainer") then
  local ok, src = pcall(function() return inst.Source end)
  if ok and src then out.source = string.sub(src, 1, 20000); out.sourceLength = #src; out.sourceHash = fnv(src) end
end
return HttpService:JSONEncode(out)
`;

/**
 * One page of a DataModel snapshot for before/after comparisons (see RobloxStudioAdapter.snapshot, which
 * asks for page after page and joins them). Studio cuts an execute_luau result at about 100,000
 * characters, so a place's snapshot never comes back in one piece: every call walks the roots in the same
 * depth-first order, skips the first __FROM__ nodes (the earlier pages') and writes records until the
 * __BUDGET__ characters are used, then says where the next page starts (`next`, -1 when the walk is done).
 * `count` is every node the walk saw (at most __MAX__; `truncated` when there were more): the pages of one
 * snapshot agree on it, which is how a place that changed between two calls is noticed.
 * Keys are "path#ClassName"; a record is the node's signature (see sig).
 */
export const LUAU_SNAPSHOT = `${RESOLVE}
local roots = HttpService:JSONDecode(__ROOTS__)
local FROM, BUDGET, MAX = __FROM__, __BUDGET__, __MAX__
local nodes = {}
local size, emitted, total = 0, 0, 0
local nextFrom = -1
local truncated = false
-- Long strings (attributes, values) keep their head, length and hash: a change still shows, one huge value can't fill a page.
local function clip(v)
  if type(v) == "string" and #v > 160 then return string.sub(v, 1, 120) .. "~" .. #v .. "~" .. fnv(v) end
  return v
end
local function sig(inst)
  local s = { c = inst.ClassName }
  if inst:IsA("BasePart") then
    s.p = enc(inst.Position); s.s = enc(inst.Size); s.o = enc(inst.Orientation)
    s.a = inst.Anchored; s.cc = inst.CanCollide; s.t = inst.Transparency; s.col = inst.Color:ToHex(); s.m = tostring(inst.Material)
    if inst:IsA("Part") then s.sh = tostring(inst.Shape) end
  elseif inst:IsA("LuaSourceContainer") then
    local ok, src = pcall(function() return inst.Source end)
    if ok and src then s.h = fnv(src); s.len = #src end
  elseif inst:IsA("ValueBase") then
    local ok, v = pcall(function() return inst.Value end)
    if ok then s.v = clip(enc(v)) end
  elseif inst:IsA("GuiObject") then
    s.p = enc(inst.Position); s.s = enc(inst.Size); s.vis = inst.Visible
  end
  local attrs = inst:GetAttributes()
  if next(attrs) ~= nil then
    local a = {}
    for k, v in pairs(attrs) do a[k] = clip(enc(v)) end
    s.at = a
  end
  local tags = CollectionService:GetTags(inst)
  if #tags > 0 then table.sort(tags); s.tg = tags end
  return s
end
local function visit(inst)
  if truncated then return end
  if total >= MAX then truncated = true; return end
  total += 1
  if total > FROM and nextFrom < 0 then
    local key = pathOf(inst) .. "#" .. inst.ClassName
    local s = sig(inst)
    local ok, json = pcall(function() return HttpService:JSONEncode(s) end)
    if not ok then
      -- A property JSON can't hold (NaN): keep the node, not its numbers.
      s = { c = inst.ClassName, bad = true }
      json = HttpService:JSONEncode(s)
    end
    local cost = #key + #json + 4
    if emitted > 0 and size + cost > BUDGET then
      nextFrom = total - 1
    else
      nodes[key] = s
      size += cost
      emitted += 1
    end
  end
  for _, c in ipairs(inst:GetChildren()) do visit(c) end
end
for _, r in ipairs(roots) do
  local inst = resolve(r)
  if inst then visit(inst) end
end
return HttpService:JSONEncode({ roots = roots, count = total, truncated = truncated, from = FROM, emitted = emitted, next = nextFrom, nodes = nodes })
`;

/**
 * Asset analysis for the instance at __PATH__: geometry, materials, textures, polycount (EditableMesh,
 * only for meshes this user may load — others are reported as unmeasured, never estimated), collision,
 * LOD, referenced asset ids, scripts with risk markers, procedural parameters (root attributes) and
 * compatibility findings. __MAXPOLY__ caps how many distinct meshes are loaded.
 */
export const LUAU_ASSET_ANALYZE = `${RESOLVE}
local AssetService = game:GetService("AssetService")
local root = resolve(__PATH__)
if root == nil then return HttpService:JSONEncode({ error = "not found", path = __PATH__ }) end
local MAXPOLY = __MAXPOLY__
local NL = string.char(10)
local list = root:GetDescendants()
table.insert(list, 1, root)
local counts, materials, variants, textures, depMap, depOrder = {}, {}, {}, {}, {}, {}
local meshes, scripts, findings, fidelity, render = {}, {}, {}, {}, {}
local parts, anchored, collide, precise, mass, maxDim, lights, emitters, sounds = 0, 0, 0, 0, 0, 0, 0, 0, 0
local minV, maxV = nil, nil
local function prop(inst, name)
  local ok, v = pcall(function() return inst[name] end)
  if ok then return v end
  return nil
end
local function dep(kind, id)
  if typeof(id) ~= "string" or id == "" then return end
  local key = string.match(id, "%d+") or id
  local e = depMap[key]
  if e == nil then e = { id = id, kinds = {} }; depMap[key] = e; table.insert(depOrder, key) end
  if not table.find(e.kinds, kind) then table.insert(e.kinds, kind) end
end
local function finding(severity, message) table.insert(findings, { severity = severity, message = message }) end
for _, d in ipairs(list) do
  counts[d.ClassName] = (counts[d.ClassName] or 0) + 1
  if d:IsA("BasePart") and not d:IsA("Terrain") then
    parts += 1
    materials[d.Material.Name] = (materials[d.Material.Name] or 0) + 1
    if d.MaterialVariant ~= "" then variants[d.MaterialVariant] = true end
    if d.Anchored then anchored += 1 end
    if d.CanCollide then collide += 1 end
    local s = d.Size
    maxDim = math.max(maxDim, s.X, s.Y, s.Z)
    local okm, m = pcall(function() return d:GetMass() end)
    if okm then mass += m end
    local lo, hi = d.Position - s / 2, d.Position + s / 2
    if minV == nil then minV, maxV = lo, hi else minV = minV:Min(lo); maxV = maxV:Max(hi) end
    if d:IsA("MeshPart") then
      dep("mesh", d.MeshId); dep("texture", d.TextureID)
      local cf, rf = d.CollisionFidelity.Name, d.RenderFidelity.Name
      fidelity[cf] = (fidelity[cf] or 0) + 1
      render[rf] = (render[rf] or 0) + 1
      if d.CollisionFidelity == Enum.CollisionFidelity.PreciseConvexDecomposition then precise += 1 end
      table.insert(meshes, { path = pathOf(d), meshId = d.MeshId, textureId = d.TextureID, size = enc(d.Size), meshSize = enc(d.MeshSize), collision = cf, render = rf })
    end
  elseif d:IsA("Decal") or d:IsA("Texture") then
    dep("image", d.Texture)
    if d.Texture ~= "" then textures[d.Texture] = true end
  elseif d:IsA("SurfaceAppearance") then
    for _, n in ipairs({ "ColorMap", "MetalnessMap", "NormalMap", "RoughnessMap" }) do
      local v = prop(d, n)
      if typeof(v) == "string" and v ~= "" then dep("surface", v); textures[v] = true end
    end
  elseif d:IsA("SpecialMesh") then
    dep("mesh", d.MeshId); dep("texture", d.TextureId)
  elseif d:IsA("Sound") then sounds += 1; dep("audio", d.SoundId)
  elseif d:IsA("Animation") then dep("animation", d.AnimationId)
  elseif d:IsA("ParticleEmitter") or d:IsA("Beam") or d:IsA("Trail") then emitters += 1; dep("image", prop(d, "Texture"))
  elseif d:IsA("Light") then lights += 1
  elseif d:IsA("LuaSourceContainer") then
    local src = prop(d, "Source") or ""
    local _, nl = string.gsub(src, NL, "")
    local longest = 0
    for line in string.gmatch(src, "[^" .. NL .. "]+") do longest = math.max(longest, #line) end
    local risk = {}
    if string.find(src, "require%s*%(%s*%d") then table.insert(risk, "require by asset id") end
    if string.find(src, "getfenv") or string.find(src, "setfenv") then table.insert(risk, "getfenv/setfenv") end
    if string.find(src, "loadstring") then table.insert(risk, "loadstring") end
    if string.find(src, "HttpService") then table.insert(risk, "HttpService") end
    if string.find(src, "TeleportService") then table.insert(risk, "TeleportService") end
    if string.find(src, "MarketplaceService") then table.insert(risk, "MarketplaceService") end
    if longest > 2000 then table.insert(risk, "very long line (possible obfuscation)") end
    local enabled = prop(d, "Enabled")
    table.insert(scripts, { path = pathOf(d), class = d.ClassName, lines = nl + 1, enabled = enabled ~= false, risk = risk })
  end
end
-- Polycount: distinct mesh ids, loaded through EditableMesh where the asset permissions allow it.
local poly = { triangles = 0, measuredMeshes = 0, unmeasuredMeshes = 0, reason = nil }
local faces, order = {}, {}
for _, m in ipairs(meshes) do
  if m.meshId ~= "" and faces[m.meshId] == nil then faces[m.meshId] = false; table.insert(order, m.meshId) end
end
-- A permission refusal applies to the whole asset (and Studio logs one warning per attempt), so stop at
-- the first one instead of trying every mesh.
local denied = false
for i, id in ipairs(order) do
  if i > MAXPOLY or denied then poly.unmeasuredMeshes += 1; poly.reason = poly.reason or "measurement cap reached"
  else
    local ok, res = pcall(function()
      local em = AssetService:CreateEditableMeshAsync(Content.fromUri(id))
      local n = #em:GetFaces()
      em:Destroy()
      return n
    end)
    if ok then
      faces[id] = res
      poly.measuredMeshes += 1
    else
      poly.unmeasuredMeshes += 1
      poly.reason = tostring(res)
      if string.find(poly.reason, "permission") then denied = true end
    end
  end
end
for _, m in ipairs(meshes) do
  local f = faces[m.meshId]
  if f then m.triangles = f; poly.triangles += f end
end
local bbox = Vector3.zero
if root:IsA("Model") then
  local okb, _, size = pcall(function() return root:GetBoundingBox() end)
  if okb and size then bbox = size end
elseif minV then bbox = maxV - minV end
local params = {}
for k, v in pairs(root:GetAttributes()) do params[k] = enc(v) end
if #scripts > 0 then
  if root:GetAttribute("RBX_AI_GENERATED") == true then
    finding("info", #scripts .. " generator script(s) from Roblox AI generation (they rebuild the model from its attributes)")
  else
    finding("warn", #scripts .. " script(s) inside: inserted scripts run with game privileges; review them before shipping")
  end
end
for _, s in ipairs(scripts) do
  for _, r in ipairs(s.risk) do
    if r == "require by asset id" or r == "getfenv/setfenv" or r == "loadstring" or string.find(r, "obfuscation") then
      finding("high", s.path .. ": " .. r .. " (common backdoor pattern)")
    end
  end
end
if root:IsDescendantOf(workspace) and parts > anchored then finding("info", (parts - anchored) .. " unanchored part(s) will simulate physics") end
if parts > 1000 then finding("warn", parts .. " parts in one asset (heavy)") end
if poly.triangles > 50000 then finding("warn", poly.triangles .. " triangles measured (heavy)") end
if precise > 0 then finding("info", precise .. " MeshPart(s) use PreciseConvexDecomposition collision (costly); prefer Hull or Box where exact collision is not needed") end
if maxDim > 2048 then finding("warn", "a part exceeds the 2048-stud size limit") end
if #meshes > 0 and poly.unmeasuredMeshes > 0 then finding("info", poly.unmeasuredMeshes .. " mesh(es) could not be measured: " .. tostring(poly.reason)) end
local depList = {}
for i, k in ipairs(depOrder) do if i <= 200 then table.insert(depList, depMap[k]) end end
local function keys(t) local r = {} for k in pairs(t) do table.insert(r, k) end table.sort(r) return r end
local meshOut = {}
for i, m in ipairs(meshes) do if i <= 40 then table.insert(meshOut, m) end end
local scriptOut = {}
for i, s in ipairs(scripts) do if i <= 50 then table.insert(scriptOut, s) end end
return HttpService:JSONEncode({
  path = pathOf(root), className = root.ClassName, name = root.Name, instanceCount = #list,
  counts = counts, parts = parts, anchored = anchored, mass = math.round(mass * 100) / 100,
  bbox = enc(bbox), maxDim = maxDim,
  materials = materials, materialVariants = keys(variants), textures = keys(textures),
  meshCount = #meshes, meshes = meshOut, polycount = poly,
  collision = { canCollide = collide, preciseDecomposition = precise, fidelity = fidelity },
  lod = { renderFidelity = render, modelStreaming = root:IsA("Model") and root.ModelStreamingMode.Name or nil, levelOfDetail = root:IsA("Model") and root.LevelOfDetail.Name or nil },
  dependencies = depList, dependencyCount = #depOrder,
  scripts = scriptOut, scriptCount = #scripts, lights = lights, particles = emitters, sounds = sounds,
  parameters = params, tags = CollectionService:GetTags(root),
  sandboxed = prop(root, "Sandboxed"),
  findings = findings,
})
`;

/** Debug ids -> paths of the children of each root in __ROOTS__ (a JSON array), to diff insertions. */
export const LUAU_CHILD_IDS = `${RESOLVE}
local out = {}
for _, p in ipairs(HttpService:JSONDecode(__ROOTS__)) do
  local inst = resolve(p)
  local ids = { ["_"] = true }
  if inst then for _, c in ipairs(inst:GetChildren()) do ids[c:GetDebugId(0)] = pathOf(c) end end
  out[p] = ids
end
return HttpService:JSONEncode(out)
`;

/** Paths of every instance carrying one of the CollectionService tags in __TAGS__ (a JSON array). */
export const LUAU_TAGGED = `${RESOLVE}
local paths = {}
for _, t in ipairs(HttpService:JSONDecode(__TAGS__)) do
  for _, inst in ipairs(CollectionService:GetTagged(t)) do
    local p = pathOf(inst)
    if not table.find(paths, p) then table.insert(paths, p) end
  end
end
return HttpService:JSONEncode({ paths = paths, n = #paths })
`;

/** Adds the tag __TAG__ to each instance in __PATHS__ (a JSON array); returns the paths it tagged. */
export const LUAU_TAG_ADD = `${RESOLVE}
local done = {}
for _, p in ipairs(HttpService:JSONDecode(__PATHS__)) do
  local inst = resolve(p)
  if inst then CollectionService:AddTag(inst, __TAG__); table.insert(done, pathOf(inst)) end
end
return HttpService:JSONEncode({ tagged = done, n = #done })
`;

/** Clones __PATH__ under __PARENT__ (tags are kept, so usage tracking follows the copy); returns the new path. */
export const LUAU_ASSET_CLONE = `${RESOLVE}
local src = resolve(__PATH__)
local parent = resolve(__PARENT__)
if src == nil then return HttpService:JSONEncode({ error = "source not found", path = __PATH__ }) end
if parent == nil then return HttpService:JSONEncode({ error = "parent not found", path = __PARENT__ }) end
local c = src:Clone()
if c == nil then return HttpService:JSONEncode({ error = "instance is not Archivable" }) end
if __NAME__ ~= "" then c.Name = __NAME__ end
c.Parent = parent
local offset = HttpService:JSONDecode(__OFFSET__)
if c:IsA("PVInstance") and #offset == 3 then c:PivotTo(c:GetPivot() + Vector3.new(offset[1], offset[2], offset[3])) end
return HttpService:JSONEncode({ path = pathOf(c) })
`;

/**
 * Viewer: Workspace BaseParts as compact rows, paged to stay under Studio's 100,000-character result
 * limit. Rows are ";"-separated, fields ","-separated:
 *   classIdx,shape,px,py,pz,sx,sy,sz,rx,ry,rz,colorHex,materialIdx,transparency,name,hasTexture,reflectance,
 *   model,parentIdx,flags,specialMesh
 * with `classes`, `materials` and `parents` as legends. `model` is the project model (models/<name>) a
 * part shows: the ShurikenModel attribute of a MeshPart, and for a Part drawn through a SpecialMesh FileMesh
 * (the usual workaround for the 2048-stud size cap) the attribute of the part or its mesh, else the project
 * model whose MeshPart has the same MeshId, else the model of the same name (__KNOWN__, a JSON array of the
 * project's model names; a read without it still works). `flags` sums @shared/viewer's PART_FLAG bits
 * (ShurikenTurned, has a colour map, FileMesh Part, temporary mesh); `specialMesh` is "sx|sy|sz|ox|oy|oz",
 * the SpecialMesh's Scale and Offset. The first page also carries lighting and Studio's camera.
 * `next` is the offset of the following page, or null when done.
 */
export const LUAU_VIEW_PARTS = `${RESOLVE}
local OFFSET = __OFFSET__
local BUDGET = 84000
-- The project's model names (a JSON array), for Part + SpecialMesh pieces that carry no attribute.
local KNOWN = {}
pcall(function()
  for _, n in ipairs(HttpService:JSONDecode([==[__KNOWN__]==])) do KNOWN[n] = true end
end)
local rows, classes, classIdx, mats, matIdx = {}, {}, {}, {}, {}
local parents, parentIdx, parentsSize = {}, {}, 0
local size, count, total, nextOffset = 0, 0, 0, nil
local function r(x) return math.round(x * 100) / 100 end
local function idx(list, map, key)
  local i = map[key]
  if i == nil then list[#list + 1] = key; i = #list - 1; map[key] = i end
  return i
end
-- The part's folder/model path under Workspace for the viewer's Explorer ("Map/Arena/Pillars"),
-- at most 4 levels deep and within a size budget (deeper or late paths fall back to their top level).
local function parentKey(d)
  local segs = {}
  local p = d.Parent
  while p and p ~= workspace do
    table.insert(segs, 1, (string.gsub(string.sub(p.Name, 1, 24), "[,;/]", " ")))
    p = p.Parent
  end
  while #segs > 4 do table.remove(segs) end
  local path = table.concat(segs, "/")
  if parentIdx[path] == nil and parentsSize + #path > 8000 then path = segs[1] or "" end
  if parentIdx[path] == nil then parentsSize += #path + 3 end
  return idx(parents, parentIdx, path)
end
-- MeshId -> project model, from the MeshParts that carry a ShurikenModel (built on first use).
local meshModels = nil
local function modelOfMeshId(id)
  if meshModels == nil then
    meshModels = {}
    for _, x in ipairs(workspace:GetDescendants()) do
      if x:IsA("MeshPart") and x.MeshId ~= "" then
        local m = x:GetAttribute("ShurikenModel")
        if typeof(m) == "string" and m ~= "" then meshModels[x.MeshId] = m end
      end
    end
  end
  return meshModels[id]
end
local function modelAttr(inst)
  local m = inst:GetAttribute("ShurikenModel")
  if typeof(m) == "string" then return m end
  return ""
end
for _, d in ipairs(workspace:GetDescendants()) do
  if d:IsA("BasePart") and not d:IsA("Terrain") then
    total += 1
    if total > OFFSET and nextOffset == nil then
      local cf = d.CFrame
      local rx, ry, rz = cf:ToOrientation()
      local shape = ""
      if d.ClassName == "Part" then shape = d.Shape.Name
      elseif d:IsA("WedgePart") then shape = "Wedge"
      elseif d:IsA("CornerWedgePart") then shape = "CornerWedge"
      elseif d:IsA("TrussPart") then shape = "Truss" end
      local s, p = d.Size, cf.Position
      local tex = 0
      if d:IsA("MeshPart") and d.TextureID ~= "" then tex = 1 end
      local name = string.gsub(string.sub(d.Name, 1, 24), "[,;]", " ")
      -- Meshes Shuriken modeled (Blender): the viewer draws their real geometry. A MeshPart names its model
      -- by attribute; a Part drawn through a SpecialMesh FileMesh (a piece over the 2048-stud cap) by its own
      -- or its mesh's attribute, the model whose MeshPart shares the MeshId, or its name.
      local model, flags, sm = "", 0, ""
      if d:IsA("MeshPart") then
        model = modelAttr(d)
        if d:FindFirstChildOfClass("SurfaceAppearance") ~= nil or d.TextureID ~= "" then flags += ${PART_FLAG.colorMap} end
      elseif d.ClassName == "Part" then
        local mesh = d:FindFirstChildOfClass("SpecialMesh")
        if mesh ~= nil and mesh.MeshType == Enum.MeshType.FileMesh and mesh.MeshId ~= "" then
          flags += ${PART_FLAG.fileMesh}
          local sc, off = mesh.Scale, mesh.Offset
          sm = table.concat({ r(sc.X), r(sc.Y), r(sc.Z), r(off.X), r(off.Y), r(off.Z) }, "|")
          model = modelAttr(d)
          if model == "" then model = modelAttr(mesh) end
          if model == "" then model = modelOfMeshId(mesh.MeshId) or "" end
          if model == "" and KNOWN[d.Name] then model = d.Name end
          if mesh.TextureId ~= "" or d:FindFirstChildOfClass("SurfaceAppearance") ~= nil then flags += ${PART_FLAG.colorMap} end
        end
      end
      model = string.gsub(string.sub(model, 1, 48), "[,;|]", "")
      if d:GetAttribute("ShurikenTurned") == true then flags += ${PART_FLAG.turned} end
      if d:GetAttribute("ShurikenTemporaryMesh") == true then flags += ${PART_FLAG.temporary} end
      local row = table.concat({ idx(classes, classIdx, d.ClassName), shape, r(p.X), r(p.Y), r(p.Z), r(s.X), r(s.Y), r(s.Z),
        r(math.deg(rx)), r(math.deg(ry)), r(math.deg(rz)), d.Color:ToHex(), idx(mats, matIdx, d.Material.Name), r(d.Transparency), name, tex, r(d.Reflectance), model, parentKey(d), flags, sm }, ",")
      if size + #row + 1 > BUDGET then
        nextOffset = total - 1
      else
        rows[#rows + 1] = row
        size += #row + 1
        count += 1
      end
    end
  end
end
local lighting, camera = nil, nil
if OFFSET == 0 then
  local L = game:GetService("Lighting")
  local atm = L:FindFirstChildOfClass("Atmosphere")
  local cc = L:FindFirstChildOfClass("ColorCorrectionEffect")
  local bloom = L:FindFirstChildOfClass("BloomEffect")
  lighting = {
    clock = L.ClockTime, lat = L.GeographicLatitude, brightness = L.Brightness,
    ambient = L.Ambient:ToHex(), outdoor = L.OutdoorAmbient:ToHex(),
    -- Technology is not readable from every script context.
    tech = (function() local ok, v = pcall(function() return L.Technology.Name end) return ok and v or nil end)(),
    fogColor = L.FogColor:ToHex(), fogStart = L.FogStart, fogEnd = L.FogEnd, shiftTop = L.ColorShift_Top:ToHex(),
    atmosphere = atm and { density = atm.Density, offset = atm.Offset, color = atm.Color:ToHex(), decay = atm.Decay:ToHex(), glare = atm.Glare, haze = atm.Haze } or nil,
    cc = (cc and cc.Enabled) and { brightness = cc.Brightness, contrast = cc.Contrast, saturation = cc.Saturation, tint = cc.TintColor:ToHex() } or nil,
    bloom = (bloom and bloom.Enabled) and { intensity = bloom.Intensity, size = bloom.Size, threshold = bloom.Threshold } or nil,
    sky = L:FindFirstChildOfClass("Sky") ~= nil,
    exposure = L.ExposureCompensation,
    clouds = (function()
      local c = workspace.Terrain:FindFirstChildOfClass("Clouds")
      return (c and c.Enabled) and { cover = c.Cover, density = c.Density, color = c.Color:ToHex() } or nil
    end)(),
  }
  -- Lights (torches, lamps, glowing props): position, color, brightness, range; the brightest 64.
  local lights = {}
  for _, d in ipairs(workspace:GetDescendants()) do
    if d:IsA("Light") and d.Enabled and d.Brightness > 0 then
      local parent = d.Parent
      local pos = nil
      if parent and parent:IsA("BasePart") then pos = parent.Position
      elseif parent and parent:IsA("Attachment") then pos = parent.WorldPosition end
      if pos then
        local range = (d:IsA("PointLight") or d:IsA("SpotLight") or d:IsA("SurfaceLight")) and d.Range or 8
        lights[#lights + 1] = { p = { r(pos.X), r(pos.Y), r(pos.Z) }, c = d.Color:ToHex(), b = r(d.Brightness), rg = r(range), k = string.sub(d.ClassName, 1, 1) }
      end
    end
  end
  table.sort(lights, function(a, b) return a.b * a.rg > b.b * b.rg end)
  while #lights > 64 do table.remove(lights) end
  lighting.lights = lights
  local cam = workspace.CurrentCamera
  if cam then
    local c = cam.CFrame
    local look = c.Position + c.LookVector * 60
    camera = { pos = { r(c.X), r(c.Y), r(c.Z) }, look = { r(look.X), r(look.Y), r(look.Z) }, fov = cam.FieldOfView }
  end
end
return HttpService:JSONEncode({ total = total, offset = OFFSET, count = count, next = nextOffset, classes = classes, materials = mats,
  parents = parents, rows = table.concat(rows, ";"), lighting = lighting, camera = camera })
`;

/**
 * Viewer terrain: a heightmap from downward raycasts that hit only Terrain (water included), over an
 * N×N grid of the given bounds, rows Z0..Z1 (inclusive) so large grids can be paged. Heights are
 * integers in half-studs joined by ",", "x" for holes; materials are one character per sample
 * ("0" = hole, then "1".. as indexes into `names`). `colors` are the terrain's own material colors.
 */
export const LUAU_VIEW_TERRAIN = `${RESOLVE}
local MINX, MINZ, MAXX, MAXZ, N, Z0, Z1 = __MINX__, __MINZ__, __MAXX__, __MAXZ__, __N__, __Z0__, __Z1__
local terrain = workspace.Terrain
local params = RaycastParams.new()
params.FilterType = Enum.RaycastFilterType.Include
params.FilterDescendantsInstances = { terrain }
params.IgnoreWater = false
local CODES = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
local names, index, colors = {}, {}, {}
local function code(mat)
  local m = mat.Name
  if index[m] == nil then
    names[#names + 1] = m
    index[m] = #names
    local ok, col = pcall(function() return terrain:GetMaterialColor(mat) end)
    colors[#colors + 1] = ok and col:ToHex() or "808080"
  end
  return string.sub(CODES, index[m], index[m])
end
local sx, sz = (MAXX - MINX) / (N - 1), (MAXZ - MINZ) / (N - 1)
local cols = {}
local hits = 0
for iz = Z0, Z1 do
  local zc = MINZ + iz * sz
  -- This row's vertical extent, from one ray per cell each way (voxels are read only in that band).
  local top, bottom = -math.huge, math.huge
  for ix = 0, N - 1 do
    local x = MINX + ix * sx
    local d = workspace:Raycast(Vector3.new(x, 4000, zc), Vector3.new(0, -8000, 0), params)
    if d then top = math.max(top, d.Position.Y) end
    local u = workspace:Raycast(Vector3.new(x, -4000, zc), Vector3.new(0, 8000, 0), params)
    if u then bottom = math.min(bottom, u.Position.Y) end
  end
  if top == -math.huge then
    for ix = 0, N - 1 do cols[#cols + 1] = "" end
  else
    if bottom == math.huge then bottom = top - 64 end
    local ymin = math.max(-2048, math.floor((math.min(bottom, top - 8) - 12) / 4) * 4)
    local ymax = math.min(4096, math.ceil((top + 12) / 4) * 4)
    local region = Region3.new(Vector3.new(MINX - 4, ymin, zc - 2), Vector3.new(MAXX + 4, ymax, zc + 2)):ExpandToGrid(4)
    local mats, occ = terrain:ReadVoxels(region, 4)
    local size = occ.Size
    local x0, y0 = region.CFrame.Position.X - region.Size.X / 2, region.CFrame.Position.Y - region.Size.Y / 2
    for ix = 0, N - 1 do
      local vx = math.clamp(math.floor((MINX + ix * sx - x0) / 4) + 1, 1, size.X)
      local parts = {}
      local inside, kind, t, m = false, nil, 0, nil
      for vy = size.Y, 1, -1 do
        local o = occ[vx][vy][1]
        local mat = mats[vx][vy][1]
        local solid = o >= 0.5 and mat ~= Enum.Material.Air
        local k = solid and (mat == Enum.Material.Water and "w" or "s") or nil
        if k ~= kind then
          if inside then
            -- leaving an interval: its bottom is the top of this voxel
            parts[#parts + 1] = string.format("%d,%d,%s", t, math.round((y0 + vy * 4) * 2), m)
            inside = false
          end
          if k then
            inside, kind = true, k
            t = math.round((y0 + (vy - 1) * 4 + math.clamp(o, 0.5, 1) * 4) * 2)
            m = code(mat)
          else
            kind = nil
          end
        end
        if #parts >= 3 then break end
      end
      if inside and #parts < 3 then parts[#parts + 1] = string.format("%d,%d,%s", t, math.round(y0 * 2), m) end
      if #parts > 0 then hits += 1 end
      cols[#cols + 1] = table.concat(parts, "|")
    end
  end
end
return HttpService:JSONEncode({ n = N, z0 = Z0, z1 = Z1, minX = MINX, minZ = MINZ, maxX = MAXX, maxZ = MAXZ, hits = hits,
  cols = table.concat(cols, ";"), names = names, colors = colors,
  waterColor = terrain.WaterColor:ToHex(), waterTransparency = terrain.WaterTransparency })
`;

/**
 * Reads a model at __PATH__ back into geometry-spec form: primitive parts (Part shapes, WedgePart,
 * CornerWedgePart) relative to the model pivot (yaw-only pivots keep their rotation), plus "opaque"
 * items (unions, meshes, other BaseParts) that a spec cannot recreate.
 */
export const LUAU_GEOMETRY_READ = `${RESOLVE}
local root = resolve(__PATH__)
if root == nil then return HttpService:JSONEncode({ error = "not found", path = __PATH__ }) end
local pivot = CFrame.new()
if root:IsA("Model") then pivot = root:GetPivot() elseif root:IsA("BasePart") then pivot = root.CFrame end
local prx, pry, prz = pivot:ToOrientation()
local yaw = 0
local frame = CFrame.new(pivot.Position)
if math.abs(prx) < 1e-4 and math.abs(prz) < 1e-4 then
  yaw = math.deg(pry)
  frame = CFrame.new(pivot.Position) * CFrame.Angles(0, pry, 0)
end
local function r(n) return math.round(n * 1000) / 1000 end
local function groupOf(inst)
  local segs = {}
  local cur = inst.Parent
  while cur and cur ~= root do
    table.insert(segs, 1, cur.Name)
    cur = cur.Parent
  end
  return table.concat(segs, "/")
end
local parts, opaque = {}, {}
local list = root:GetDescendants()
if root:IsA("BasePart") then table.insert(list, 1, root) end
for _, d in ipairs(list) do
  if d:IsA("BasePart") and not d:IsA("Terrain") then
    local rel = frame:ToObjectSpace(d.CFrame)
    local rx, ry, rz = rel:ToOrientation()
    local shape = nil
    if d.ClassName == "WedgePart" then shape = "Wedge"
    elseif d.ClassName == "CornerWedgePart" then shape = "CornerWedge"
    elseif d.ClassName == "Part" then shape = d.Shape.Name end
    local entry = {
      name = d.Name, size = { r(d.Size.X), r(d.Size.Y), r(d.Size.Z) }, pos = { r(rel.X), r(rel.Y), r(rel.Z) },
      rot = { r(math.deg(rx)), r(math.deg(ry)), r(math.deg(rz)) }, color = d.Color:ToHex(), material = d.Material.Name,
      transparency = r(d.Transparency), anchored = d.Anchored, canCollide = d.CanCollide,
    }
    if d.MaterialVariant ~= "" then entry.materialVariant = d.MaterialVariant end
    local g = groupOf(d)
    if g ~= "" then entry.group = g end
    if shape ~= nil and (shape == "Block" or shape == "Ball" or shape == "Cylinder" or shape == "Wedge" or shape == "CornerWedge") then
      entry.shape = shape
      table.insert(parts, entry)
    else
      entry.class = d.ClassName
      table.insert(opaque, entry)
    end
  end
end
local attrs = {}
for k, v in pairs(root:GetAttributes()) do if string.sub(k, 1, 3) ~= "RBX" and k ~= "ShurikenGeometry" then attrs[k] = enc(v) end end
local p = root.Parent
return HttpService:JSONEncode({
  name = root.Name, parent = p and pathOf(p) or "Workspace", pivot = { r(pivot.X), r(pivot.Y), r(pivot.Z) }, yaw = r(yaw),
  attributes = attrs, parts = parts, opaque = opaque, builtFromSpec = root:GetAttribute("ShurikenGeometry"),
})
`;

/**
 * Run in an agent's playtest client (1.16.1, studio-adapter.ts agentPlay). A game with a shoulder or first-person camera
 * sets MouseBehavior.LockCenter every frame, and Studio applies that lock to the user's real cursor even when its window
 * is behind others (measured 2026-10-26: the cursor pinned to the middle of the screen for 22-27 s per agent playtest).
 * While the server sets ReplicatedStorage's ShurikenMouseFree attribute (the user is at the PC, in another window: the
 * focus guard's FREE), the mouse is put back to Default after the game's camera each frame and whenever it changes.
 */
export const LUAU_MOUSE_FREE_CLIENT = `
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local flag = game:GetService("ReplicatedStorage")
local function letGo()
	if flag:GetAttribute("ShurikenMouseFree") == true and UserInputService.MouseBehavior ~= Enum.MouseBehavior.Default then
		UserInputService.MouseBehavior = Enum.MouseBehavior.Default
	end
end
pcall(function()
	RunService:UnbindFromRenderStep("ShurikenMouseFree")
end)
RunService:BindToRenderStep("ShurikenMouseFree", Enum.RenderPriority.Last.Value + 100, letGo)
-- One watch per playtest client (an attribute set here stays on the client).
if not flag:GetAttribute("ShurikenMouseWatch") then
	flag:SetAttribute("ShurikenMouseWatch", true)
	UserInputService:GetPropertyChangedSignal("MouseBehavior"):Connect(letGo)
end
return "mouse watch on"
`;

/** Run in an agent's playtest server: sets or clears the flag LUAU_MOUSE_FREE_CLIENT follows. */
export const luauMouseFree = (free: boolean): string => `game:GetService("ReplicatedStorage"):SetAttribute("ShurikenMouseFree", ${free ? 'true' : 'false'})
return "ok"`;
