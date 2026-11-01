---
name: roblox-networking-security
description: "Design and audit Roblox client-server networking: RemoteEvent, RemoteFunction and UnreliableRemoteEvent usage, server authority, validating every argument, per-player rate limits, replication facts and a typed remote wrapper module; use for any feature that sends data between client and server."
version: 1
tags: [networking, security, remotes, validation, exploits, ratelimit, server, anticheat, replication]
roblox_systems: [RemoteEvent, RemoteFunction, UnreliableRemoteEvent, ReplicatedStorage, Players, TextService, BasePart]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [luau_check, roblox_sync_push, roblox_run_luau, roblox_playtest, roblox_console, test_register, task_add_evidence]
---
# Roblox networking and security

## Purpose
Every client is potentially an exploiter with full control of its own machine: it can fire any remote with any arguments at any rate, read everything replicated to it (including ModuleScript source in ReplicatedStorage), and move its own character anywhere. This skill makes the server the only authority and gives a standard shape to every message: declared once, rate limited, validated, authorized, then acted on.

## Preconditions
- Layout (luau-module-architecture skill): `src/Shared/Net.luau` declares remotes, `src/Shared/Guard.luau` holds pure validators, `src/Server/Remote.luau` is the only place that connects `OnServerEvent`.
- You know which state is authoritative on the server (inventory, currency, health, cooldowns, positions used for checks) and how it replicates back (attributes, leaderstats, owner-only events).

## Workflow
1. **Model messages as intents.** The client asks ("swing", "craft recipe X", "buy item Y"); it never states results ("deal 30 damage", "set coins 500", "I hit player Z for 40"). Keep arguments minimal: ids, a unit aim direction, an Instance the server can check.
2. **Pick the remote type.**
   - `RemoteEvent`: default for both directions.
   - `UnreliableRemoteEvent`: cosmetic or continuously replaced data (hit sparks, aim previews). Unordered, lost events are not resent, and payloads over 1000 bytes are dropped.
   - `RemoteFunction`: client→server request/response only (e.g. shop query). Never `InvokeClient`.
3. **Declare remotes once** in `Net.luau`: the server creates them in `ReplicatedStorage.Remotes` when the module is first required; clients `WaitForChild` them. Never put remotes inside synced script folders.
4. **Listen through the wrapper.** `Remote.listen(remote, perSecond, burst, handler)` applies a per-player token bucket and catches handler errors. The engine throttles FireServer at roughly 500 requests per second per client (shared across remotes of the same type); your limits should be ~2–20/s depending on the action.
5. **Validate every argument** with `Guard` functions that take `unknown` and return a typed value or `nil`: `typeof` checks for Roblox types, NaN (`x ~= x`) and infinity rejected, numeric ranges, string length and valid UTF-8, lookups of ids in server-side data tables, `IsA` + ancestry + tag checks for Instances.
6. **Authorize against server state**: the player is alive and in the right phase, owns the item or structure, is within range measured from **server** positions (plus a small latency tolerance), and the server-side cooldown has elapsed. Recompute every consequence (damage, price, reward) from server data.
7. **Act, then replicate.** Mutate server state, then publish: attributes or values for durable state (late joiners and streamed-in clients get it automatically), `FireClient` for owner-only updates, `FireAllClients` or an UnreliableRemoteEvent for cosmetic broadcasts.
8. **Filter user text** that other players will see (names, signs, messages) with `TextService:FilterStringAsync` on the server before displaying it.
9. **Test adversarially** during a playtest (Verification), then `luau_check`, and register durable tests.

## Known pitfalls
- **FilteringEnabled is always on.** Client changes to the DataModel do not replicate to the server, with two important exceptions: physics of assemblies the client owns (its character and unanchored parts the engine assigned to it) and animations played on its own character. Client-owned parts can also produce fake `Touched` events.
- **Argument rules (docs).** Functions arrive as `nil`, metatables are stripped, mixed array/dictionary tables are unsupported, non-string keys become strings, and Instances the receiver can't see arrive as `nil`. With StreamingEnabled a client can only send Instances it currently has.
- **`RemoteFunction:InvokeClient`**: if the client errors, the server errors; if it disconnects, the call errors; if it never returns, the server thread hangs forever. Exploiters can do all three on purpose.
- **Server positions lag** the client by about the player's ping. Use a tolerance (a few studs) rather than exact distances; `Player:GetNetworkPing()` returns round-trip latency in seconds.
- **Never trust client time.** Cooldowns use `os.clock()` or `workspace:GetServerTimeNow()` on the server; a client timestamp, if used for lag compensation at all, must be clamped to a short window.
- **Instance arguments** can be anything the client can see, including other players' tools and characters. Check class, ancestry (`IsDescendantOf(workspace.Nodes)`), tags and ownership before use.
- **Strings as keys** must be looked up in server tables (`Items[id]`), never used for `FindFirstChild` on sensitive containers, `loadstring`, or indexing `game`.
- **Handler errors spam the console** and fail Shuriken playtests. Validate before indexing; the wrapper's `pcall` is a safety net, not validation.
- **Remote events are not replayed** for players who join later or stream an area in later; durable state belongs in attributes or instances.
- **Per-player tables leak** unless cleared on `PlayerRemoving` (rate buckets, cooldowns, pending requests).
- **ReplicatedStorage is readable.** Server logic, secrets, loot tables that must stay hidden and admin lists belong in ServerScriptService or ServerStorage.
- **Free models can carry backdoors**: stray RemoteEvents or scripts calling `require(<assetId>)`. Audit for remotes outside `ReplicatedStorage.Remotes` (Verification).
- **`OnServerInvoke` holds one callback**; assigning it twice silently replaces the first.

## Verification
Static audit (Edit, `luau_assert`): no `InvokeClient`, and every `OnServerEvent` connection goes through `Remote.luau`:
```lua
local root = game:GetService("ServerScriptService"):FindFirstChild("Server")
if not root then return "FAIL: ServerScriptService.Server missing" end
for _, s in root:GetDescendants() do
	if s:IsA("LuaSourceContainer") then
		local src = s.Source
		if string.find(src, "InvokeClient", 1, true) then return `FAIL: {s:GetFullName()} uses InvokeClient` end
		if s.Name ~= "Remote" and string.find(src, "OnServerEvent", 1, true) then
			return `FAIL: {s:GetFullName()} connects OnServerEvent outside Remote.listen`
		end
	end
end
return "PASS"
```

Runtime audit (playtest server probe): remotes exist and nothing else in the game is a remote (backdoor check):
```lua
local RS = game:GetService("ReplicatedStorage")
local folder = RS:WaitForChild("Remotes", 10)
if not folder then return "FAIL: ReplicatedStorage.Remotes not created" end
for _, name in { "Swing", "Craft", "Inventory", "HitFx" } do
	if not folder:FindFirstChild(name) then return `FAIL: remote {name} missing` end
end
for _, container in { workspace, RS, game:GetService("StarterGui"), game:GetService("StarterPack") } do
	for _, d in container:GetDescendants() do
		if (d:IsA("BaseRemoteEvent") or d:IsA("RemoteFunction")) and d.Parent ~= folder then
			return `FAIL: unexpected remote {d:GetFullName()}`
		end
	end
end
return "PASS"
```

Adversarial run (interactive): start a playtest, run the Client example below with `roblox_run_luau` datamodel `Client`, then a `Server` probe asserting that state did not change (e.g. `Coins` attribute unchanged, no item granted), and read `roblox_console`: there must be no handler failures. Record the outputs with `task_add_evidence`. Unit-test `Guard` through a fresh require in an Edit assert (e.g. `Guard.number(0/0, 0, 10) == nil`).

## Examples
`src/Shared/Net.luau`: every remote in one place.
```lua
--!strict
-- The server creates the remotes when this module is first required; clients wait for them.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local IS_SERVER = RunService:IsServer()
local folder: Instance
if IS_SERVER then
	folder = Instance.new("Folder")
	folder.Name = "Remotes"
	folder.Parent = ReplicatedStorage
else
	folder = ReplicatedStorage:WaitForChild("Remotes")
end

local function event(name: string): RemoteEvent
	if IS_SERVER then
		local remote = Instance.new("RemoteEvent")
		remote.Name = name
		remote.Parent = folder
		return remote
	end
	return folder:WaitForChild(name) :: RemoteEvent
end

local function unreliable(name: string): UnreliableRemoteEvent
	if IS_SERVER then
		local remote = Instance.new("UnreliableRemoteEvent")
		remote.Name = name
		remote.Parent = folder
		return remote
	end
	return folder:WaitForChild(name) :: UnreliableRemoteEvent
end

return {
	Swing = event("Swing"), -- client -> server (look: Vector3) unit look direction
	Craft = event("Craft"), -- client -> server (recipeId: string)
	Inventory = event("Inventory"), -- server -> owner ({ [itemId]: count })
	HitFx = unreliable("HitFx"), -- server -> all (at: Vector3, amount: number), cosmetic
}
```

`src/Shared/Guard.luau`: pure validators, `unknown` in, typed value or `nil` out.
```lua
--!strict
local Guard = {}

function Guard.number(v: unknown, min: number, max: number): number? -- v == v is false for NaN
	return if type(v) == "number" and v == v and v >= min and v <= max then v else nil
end

function Guard.vector3(v: unknown, maxMagnitude: number): Vector3?
	if typeof(v) == "Vector3" then
		local m = v.Magnitude
		if m == m and m <= maxMagnitude then -- m is NaN if any component is NaN
			return v
		end
	end
	return nil
end

function Guard.text(v: unknown, maxLength: number): string? -- utf8.len is nil for invalid UTF-8
	return if type(v) == "string" and #v <= maxLength and utf8.len(v) ~= nil then v else nil
end

function Guard.key<T>(v: unknown, map: { [string]: T }): string? -- only ids that exist server-side
	return if type(v) == "string" and #v <= 64 and map[v] ~= nil then v else nil
end

function Guard.instance(v: unknown, className: string, ancestor: Instance): Instance?
	return if typeof(v) == "Instance" and v:IsA(className) and v:IsDescendantOf(ancestor) then v else nil
end

return Guard
```

`src/Server/Remote.luau`: the only place that listens to clients.
```lua
--!strict
local Players = game:GetService("Players")

export type Handler = (player: Player, ...unknown) -> ()
type Bucket = { tokens: number, at: number }

local Remote = {}

function Remote.listen(remote: RemoteEvent, perSecond: number, burst: number, handler: Handler)
	local buckets: { [Player]: Bucket } = {}
	Players.PlayerRemoving:Connect(function(player: Player)
		buckets[player] = nil
	end)
	remote.OnServerEvent:Connect(function(player: Player, ...: unknown)
		local now = os.clock()
		local bucket: Bucket = buckets[player] or { tokens = burst, at = now }
		buckets[player] = bucket
		bucket.tokens = math.min(burst, bucket.tokens + (now - bucket.at) * perSecond)
		bucket.at = now
		if bucket.tokens < 1 then
			return -- over budget: drop silently
		end
		bucket.tokens -= 1
		local ok, problem = pcall(handler :: any, player, ...) -- cast: pcall's type drops the error value for () -> ()
		if not ok then
			warn(`[Remote] {remote.Name} handler failed for {player.UserId}: {problem}`)
		end
	end)
end

return Remote
```

A handler (server): intent in, everything else decided by the server.
```lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Guard = require(ReplicatedStorage.Shared.Guard)
local Net = require(ReplicatedStorage.Shared.Net)
local Recipes = require(ReplicatedStorage.Shared.Data.Recipes)
local Remote = require(script.Parent.Remote)
local Crafting = require(script.Parent.Crafting)

Remote.listen(Net.Craft, 4, 8, function(player: Player, rawId: unknown)
	local recipeId = Guard.key(rawId, Recipes)
	if not recipeId then
		return
	end
	Crafting.craft(player, recipeId) -- checks station range and ingredients against server inventory
end)
```

Hostile client payloads (interactive, `roblox_run_luau` datamodel `Client`):
```lua
local remotes = game:GetService("ReplicatedStorage"):WaitForChild("Remotes", 5)
local craft = remotes and remotes:FindFirstChild("Craft")
if not (craft and craft:IsA("RemoteEvent")) then return "FAIL: Craft remote missing" end
local payloads = { 0 / 0, math.huge, -1, "", string.rep("x", 10000), {}, workspace, Vector3.new(0 / 0, 0, 0), "not_a_recipe" }
for _, value in payloads do
	craft:FireServer(value)
end
for _ = 1, 200 do
	craft:FireServer("plank") -- spam: the rate limit must cap how many are processed
end
return `PASS: sent {#payloads + 200} hostile requests`
```

## References
- https://create.roblox.com/docs/scripting/security/security-tactics
- https://create.roblox.com/docs/scripting/events/remote
- https://create.roblox.com/docs/reference/engine/classes/RemoteEvent
- https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent
- https://create.roblox.com/docs/reference/engine/classes/RemoteFunction
- https://create.roblox.com/docs/physics/network-ownership
- https://create.roblox.com/docs/reference/engine/classes/TextService
- https://create.roblox.com/docs/reference/engine/classes/Player (GetNetworkPing)
