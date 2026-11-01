---
name: roblox-gathering-crafting
description: "Build Booga-Booga-style survival loops on Roblox: resource nodes with server-owned health and respawn, tool tiers, validated harvesting, a server-authoritative inventory, data-driven crafting recipes, drops and pickups, hunger and health, and tribe basics."
version: 1
tags: [survival, gathering, crafting, inventory, resources, harvesting, hunger, tribes, recipes, drops]
roblox_systems: [CollectionService, RemoteEvent, ProximityPrompt, Humanoid, Players, ServerStorage, Model]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_run_luau, roblox_playtest, roblox_console, roblox_screenshot, roblox_sync_push, luau_check, test_register, task_add_evidence]
---
# Gathering, inventory and crafting (survival)

## Purpose
The survival loop is: hit trees and rocks with better and better tools, collect resources, craft tools and structures, eat to keep hunger up, team up in tribes and fight other tribes. Everything valuable (node health, yields, inventory, recipes, hunger) is decided and stored on the server; clients request actions and display state. Content (items, nodes, recipes) is data, so adding a new ore or recipe is a data row, not new code.

## Preconditions
- roblox-networking-security (Net, Guard, Remote.listen), luau-module-architecture (services, `Shared/Data`), roblox-data-persistence (inventory lives in the saved profile).
- World (roblox-world-building): each node is a Model under `Workspace.Nodes` tagged `ResourceNode`, with a `NodeType` attribute and a `PrimaryPart`; crafting stations are tagged `Workbench` (or similar); a `Workspace.Drops` folder exists.

## Workflow
1. **Data tables** in `src/Shared/Data`: `Items` (id, name, kind, stack, tool `tier`/`power`, `food`), `Nodes` (per NodeType: max health, minimum tool tier, respawn seconds, drop table), `Recipes` (inputs `{[itemId]: count}`, output `{item, count}`, optional station tag). Referential integrity is enforced by a `luau_assert`.
2. **Nodes service** (one service for all nodes, never a script per node): on start, for `CollectionService:GetTagged("ResourceNode")` and `GetInstanceAddedSignal`, set `Health` to the type's max and watch `GetAttributeChangedSignal("Health")`. The `Health` attribute **is** the state: only the server writes it, clients read it for health bars, and tests can drive it.
3. **Harvest request** `Harvest(node: Model)` → `Remote.listen` rate limit → `Guard.instance(raw, "Model", workspace.Nodes)` + `HasTag("ResourceNode")` → node alive → character alive and within reach of the node's bounding box (server positions) → equipped tool from the server's loadout (bare hands = tier 0) → tier ≥ node's `minTier` → per-player swing cooldown → subtract tool power from `Health` → roll drops into the inventory; overflow spawns a ground drop.
4. **Depletion and respawn**: when `Health` reaches 0, move the model to `ServerStorage` (clients see it vanish; nothing is destroyed) and `task.delay` its return with full health. Read the delay from the data table, with an optional `workspace` attribute override for tests.
5. **Inventory service** (server-authoritative counts in `PlayerData` profile data): `count`, `add` (returns overflow), and all-or-nothing `take(cost)`. After a change, mirror counts as player attributes (`Inv_<id>`) and batch one `Inventory` snapshot per frame to the owner with `task.defer`.
6. **Crafting** `Craft(recipeId: string)`: `Guard.key` against `Recipes` → station check (a tagged station within range of the server position) → room for the output → `take(inputs)` → `add(output)`. Check everything before removing anything, so a failed craft never eats ingredients.
7. **Drops and pickups**: server-spawned parts in `Workspace.Drops` with `ItemId`, `Count` and `DespawnAt` attributes and a `ProximityPrompt` (`Triggered` fires on the server with the player). On pickup: re-check distance, claim the drop (attribute or destroy) before adding to the inventory so two players can't both take it, and return overflow to the ground. One despawn sweep loop, not a thread per drop.
8. **Hunger and health**: one server loop per second over all players: drain `Hunger`, damage with `TakeDamage` when it hits 0, regenerate health only while well fed. Eating is a `UseItem` intent validated against the inventory and the item's `food` value. The default character `Health` script also regenerates health; if hunger owns regeneration, replace it (a Script named `Health` directly in `StarterCharacterScripts` overrides the default; community-documented behaviour).
9. **Tribes**: a server registry `{id, name, leader, members}` with create / invite / accept / leave / kick intents (validated: leader-only actions, invite expiry, member cap). Publish `TribeId` as a player attribute; combat skips damage between members; structures carry an `OwnerTribe` attribute. Persist tribes in their own store through a single `UpdateAsync`-based module, never inside individual player profiles.
10. **Verify** (below), `luau_check`, sync, register tests.

## Known pitfalls
- **Client-computed yields, damage or recipe results** are exploits. The client sends the node or recipe id; the server decides the outcome.
- **Distance to the node's pivot is wrong for big trees**; measure from the bounding box (`Model:GetBoundingBox()`) or a per-node radius attribute, with a small tolerance for latency.
- **Check-then-act must not yield in between**: a `task.wait` or DataStore call between "has 3 wood" and "remove 3 wood" lets two requests pass the check. Keep inventory mutations synchronous.
- **Double pickups and double crafts**: claim first, then grant; `take` is all-or-nothing.
- **Inventory replication spam**: many small changes per frame should produce one snapshot (`task.defer` batching), not one remote call each.
- **StreamingEnabled**: clients only have nearby nodes. Use `ModelStreamingMode = Atomic` for node models so a node arrives whole, and build client UI from `CollectionService` added/removed signals rather than assuming `Workspace.Nodes` is complete. The server always has every node.
- **Per-node or per-player `while true` threads** leak and cost scheduler time; use one loop per system and clean per-player tables on `PlayerRemoving`.
- **Arrays with holes and mixed tables** break DataStore saves; keep inventory as `{[itemId]: count}` or a dense slot array, and never rename an item id without a migration.
- **Unanchored drops near players** become client-owned (they can be flung or teleported by that client); anchor drops or set `SetNetworkOwner(nil)`.
- **ProximityPrompt limits are client-side conveniences**; still re-check distance and state on the server in `Triggered`.

## Verification
Data integrity (`luau_assert`, edit):
```lua
local fresh = game:GetService("ReplicatedStorage").Shared:Clone()
local ok, result = pcall(function(): string
	local Items = require(fresh.Data.Items)
	local Nodes = require(fresh.Data.Nodes)
	local Recipes = require(fresh.Data.Recipes)
	for nodeType, node in Nodes do
		for _, drop in node.drops do
			if not Items[drop.item] then return `FAIL: node {nodeType} drops unknown item {drop.item}` end
		end
	end
	for id, recipe in Recipes do
		if not Items[recipe.output.item] then return `FAIL: recipe {id} outputs unknown item {recipe.output.item}` end
		for input in recipe.inputs do
			if not Items[input] then return `FAIL: recipe {id} needs unknown item {input}` end
		end
	end
	for _, model in game:GetService("CollectionService"):GetTagged("ResourceNode") do
		local nodeType = model:GetAttribute("NodeType")
		if type(nodeType) ~= "string" or not Nodes[nodeType] then return `FAIL: {model:GetFullName()} has bad NodeType {nodeType}` end
	end
	return "PASS"
end)
fresh:Destroy()
return if ok then result else `FAIL: {result}`
```

Depletion and respawn (playtest server probe, duration 3 s):
```lua
local nodes = workspace:FindFirstChild("Nodes")
local node = nodes and nodes:FindFirstChildWhichIsA("Model")
if not node then return "FAIL: no node under Workspace.Nodes" end
local max = node:GetAttribute("Health")
if type(max) ~= "number" or max <= 0 then return `FAIL: node Health not initialised ({max})` end
workspace:SetAttribute("TestRespawnSeconds", 2) -- tuning override read by the Nodes service
node:SetAttribute("Health", 0)
local deadline = os.clock() + 3
while node:IsDescendantOf(workspace) and os.clock() < deadline do task.wait(0.1) end
if node:IsDescendantOf(workspace) then return "FAIL: depleted node stayed in Workspace" end
deadline = os.clock() + 8
while not node:IsDescendantOf(workspace) and os.clock() < deadline do task.wait(0.2) end
if not node:IsDescendantOf(workspace) then return "FAIL: node did not respawn within 8 s" end
if node:GetAttribute("Health") ~= max then return `FAIL: respawned with Health {node:GetAttribute("Health")}, expected {max}` end
return "PASS"
```

End-to-end harvest (interactive): in a playtest, a `Server` probe teleports the character next to a Tree (`character:PivotTo`), `roblox_run_luau` in `Client` fires `Remotes.Harvest:FireServer(node)` a few times with `task.wait(0.6)` between, then a `Server` probe asserts `player:GetAttribute("Inv_wood")` increased and the node's `Health` dropped. Record both outputs with `task_add_evidence`.

## Examples
`src/Shared/Data/Nodes.luau` and `Recipes.luau`:
```lua
--!strict
export type Drop = { item: string, min: number, max: number, chance: number }
export type Node = { maxHealth: number, minTier: number, respawn: number, drops: { Drop } }

return table.freeze({
	Tree = { maxHealth = 60, minTier = 0, respawn = 90, drops = { { item = "wood", min = 1, max = 2, chance = 1 } } },
	Rock = { maxHealth = 90, minTier = 1, respawn = 120, drops = { { item = "stone", min = 1, max = 2, chance = 1 } } },
	IronOre = { maxHealth = 150, minTier = 2, respawn = 240, drops = { { item = "iron", min = 1, max = 1, chance = 1 } } },
} :: { [string]: Node })
```
```lua
--!strict
export type Recipe = { inputs: { [string]: number }, output: { item: string, count: number }, station: string? }

return table.freeze({
	stone_axe = { inputs = { wood = 3, stone = 3 }, output = { item = "stone_axe", count = 1 } },
	iron_pick = { inputs = { wood = 2, iron = 4 }, output = { item = "iron_pick", count = 1 }, station = "Workbench" },
} :: { [string]: Recipe })
```

Inventory core (`src/Server/Inventory.luau`, excerpt):
```lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Items = require(ReplicatedStorage.Shared.Data.Items)
local Net = require(ReplicatedStorage.Shared.Net)
local PlayerData = require(script.Parent.PlayerData)

local Inventory = {}
local pending: { [Player]: boolean } = {}

local function setCount(player: Player, inv: { [string]: number }, id: string, count: number)
	if count > 0 then
		inv[id] = count
	else
		inv[id] = nil
	end
	player:SetAttribute(`Inv_{id}`, if count > 0 then count else nil)
	if not pending[player] then
		pending[player] = true
		task.defer(function() -- one snapshot per frame, however many changes
			pending[player] = nil
			local data = PlayerData.get(player)
			if data and player.Parent then
				Net.Inventory:FireClient(player, data.inventory)
			end
		end)
	end
end

function Inventory.count(player: Player, id: string): number
	local data = PlayerData.get(player)
	return if data then data.inventory[id] or 0 else 0
end

-- Adds up to n (one stack per item type); returns how many did not fit.
function Inventory.add(player: Player, id: string, n: number): number
	local item = Items[id]
	local data = PlayerData.get(player)
	if not (item and data) or n <= 0 then
		return n
	end
	local have = data.inventory[id] or 0
	local added = math.min(n, item.stack - have)
	if added > 0 then
		setCount(player, data.inventory, id, have + added)
	end
	return n - math.max(added, 0)
end

-- All or nothing: removes every listed item, or nothing at all.
function Inventory.take(player: Player, cost: { [string]: number }): boolean
	local data = PlayerData.get(player)
	if not data then
		return false
	end
	for id, n in cost do
		if (data.inventory[id] or 0) < n then
			return false
		end
	end
	for id, n in cost do
		setCount(player, data.inventory, id, (data.inventory[id] or 0) - n)
	end
	return true
end

return Inventory
```

Crafting handler (server, inside the Crafting service's `start`):
```lua
local STATION_RANGE = 12

local function nearStation(root: BasePart, tag: string): boolean
	for _, station in CollectionService:GetTagged(tag) do
		if station:IsA("PVInstance") and (station:GetPivot().Position - root.Position).Magnitude <= STATION_RANGE then
			return true
		end
	end
	return false
end

Remote.listen(Net.Craft, 4, 8, function(player: Player, rawId: unknown)
	local id = Guard.key(rawId, Recipes)
	local character = player.Character
	local root = character and character.PrimaryPart
	if not (id and root) then
		return
	end
	local recipe = Recipes[id]
	if recipe.station and not nearStation(root, recipe.station) then
		return
	end
	local out = recipe.output
	if Inventory.count(player, out.item) + out.count > Items[out.item].stack then
		return -- no room: refuse before taking anything
	end
	if Inventory.take(player, recipe.inputs) then
		Inventory.add(player, out.item, out.count)
	end
end)
```

## References
- https://create.roblox.com/docs/reference/engine/classes/CollectionService
- https://create.roblox.com/docs/reference/engine/classes/ProximityPrompt
- https://create.roblox.com/docs/reference/engine/classes/Model (GetBoundingBox, PivotTo)
- https://create.roblox.com/docs/workspace/streaming
- https://create.roblox.com/docs/scripting/security/security-tactics
- https://create.roblox.com/docs/physics/network-ownership
- https://devforum.roblox.com/t/remove-roblox-default-health-regeneration/2779300 (community: overriding the default Health script)
