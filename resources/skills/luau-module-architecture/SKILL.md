---
name: luau-module-architecture
description: "Structure Roblox game code as strict-typed Luau modules: folder layout per the sync map, one entry script per side, service and controller modules with explicit init and start ordering, exported types, data-driven content modules and no circular requires; use when creating or reorganizing systems."
version: 1
tags: [luau, architecture, modules, types, strict, services, controllers, data, config, structure]
roblox_systems: [ModuleScript, Script, LocalScript, ReplicatedStorage, ServerScriptService, StarterPlayer, ServerStorage]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [luau_check, roblox_sync_push, roblox_run_luau, roblox_playtest, roblox_console, git_diff, test_register]
---
# Luau module architecture

## Purpose
Keep a growing game understandable and verifiable: every piece of code has one obvious home, dependencies flow one way, startup order is explicit, types catch typos and nil access before runtime, and content (items, recipes, weapons, rewards) is data that systems read rather than code that must be edited.

## Preconditions
- `.luaurc` sets `"languageMode": "strict"`; `selene.toml` uses `std = "roblox"`; `luau_check` runs selene and luau-lsp with a sourcemap Shuriken builds from the sync map, so `require(script.Parent.X)` and `ReplicatedStorage.Shared.X` paths resolve to typed modules.
- Sync map (default): `src/Server` → `ServerScriptService.Server`, `src/Shared` → `ReplicatedStorage.Shared`, `src/Client` → `StarterPlayer.StarterPlayerScripts.Client`.

## Workflow
1. **Place code by trust boundary.**
   - `src/Server/`: authority. Services, persistence, validation, anything secret. Never replicated to clients.
   - `src/Shared/`: `Net.luau` (remotes), `Guard.luau` (validators), `Types.luau` (types used on both sides), `Data/*.luau` (content tables), pure logic (formulas, ballistics). Replicated, so readable by exploiters: no secrets, no server-only rules.
   - `src/Client/`: controllers for input, UI, camera, effects. Presentation only; it sends intents.
   - Vendored libraries: `src/Server/Packages/` (or `src/Shared/Packages/`), unmodified, with `--!nonstrict` and a header naming source, version and license; exclude `**/Packages/**` from selene and keep the license file in the repo.
2. **One entry script per side**: `src/Server/Main.server.luau` and `src/Client/Main.local.luau`. Everything else is a ModuleScript. Entry scripts only require modules and call their lifecycle functions in a fixed, written-down order.
3. **Module shape**: `--!strict`, services, requires, types, constants, private state, public functions, `return Module`. Requiring a module must not start work: no connections, no loops, no yields at top level (the one accepted exception is `Net`, which creates or waits for remotes).
4. **Lifecycle contract** for services (server) and controllers (client):
   - `init(deps?)`: build internal state, receive callbacks from `Main`; no yielding, no calls into other services.
   - `start()`: connect events, spawn loops, call other services.
   - `Main` calls every `init` in order, then every `start` in order, then sets `workspace:SetAttribute("ServerReady", true)` so tests and clients know startup finished.
5. **Dependencies flow downward**: Data ← pure Shared logic ← services ← Main. A service may require services below it. When a lower service must notify a higher one (Combat telling Round about a kill), pass a callback through `init` instead of requiring upward.
6. **Types**: `export type` lives in the module that owns the concept; consumers write `local Inventory = require(path)` and use `Inventory.Stack`. Types used by both sides go in `Shared/Types.luau`. Remote payload shapes are documented next to each remote in `Net.luau`.
7. **Content is data.** Each `Shared/Data/*.luau` returns a frozen, typed table keyed by stable string ids. Adding an item, recipe or weapon must require only a new row. Systems look rows up by id and handle unknown ids. Write a `luau_assert` that checks referential integrity (every id referenced exists).
8. **Check and sync**: `luau_check` until there are no errors, `roblox_sync_push`, then a playtest whose console stays clean.

## Known pitfalls
- **Circular requires** fail at runtime with "Requested module was required recursively". Fix the dependency direction (move shared types to `Types.luau`, pass callbacks through `init`); requiring inside a function to dodge the cycle hides the problem.
- **Module state is per VM.** Server and client each get their own copy of a Shared module; state set on the server is not visible to clients. Every requirer on the same side shares one instance.
- **Top-level yields deadlock startup**: a `WaitForChild` at the top of a server module waiting for something `start()` creates will hang `Main`, and after 5 s logs "Infinite yield possible", which fails Shuriken playtests.
- **`.client.luau` under StarterPlayerScripts**: with Studio Script Sync it becomes a Script with RunContext Client, which runs twice in Starter containers. Name client entry points `Main.local.luau`.
- **Never tag or attribute scripts** in Script Sync projects; configuration belongs in Data modules.
- **Strict-mode friction**: `FindFirstChild` returns `Instance?`, so check for nil and narrow with `IsA`; `WaitForChild` returns `Instance`, so cast (`:: RemoteEvent`); `GetAttribute` returns `any`, so check `type(v)` first.
- **Map lookups are not typed optional**: indexing a `{ [string]: Item }` yields `Item`, not `Item?`. Always nil-check lookups of ids that came from clients or other data.
- **Globals**: no `_G`, `shared`, `getfenv`/`setfenv` or `loadstring` (`ServerScriptService.LoadStringEnabled` is off by default; leave it off).
- **Duplicated tuning**: the same number in two modules drifts. Put it in a Data module and read it from both sides.
- **Oversized modules**: split a file once it holds more than one responsibility (e.g. `Combat` validation vs credit/rewards), keeping the public API in one module.

## Verification
- `luau_check` reports 0 errors (the `static_analysis` method).
- Data integrity (`luau_assert`, edit): see Examples.
- No shared code reaches for server-only services (`luau_assert`, edit):
```lua
local shared = game:GetService("ReplicatedStorage"):FindFirstChild("Shared")
if not shared then return "FAIL: ReplicatedStorage.Shared missing" end
for _, s in shared:GetDescendants() do
	if s:IsA("ModuleScript") and not s:FindFirstAncestor("Packages") then
		local src = s.Source
		for _, needle in { "ServerScriptService", "ServerStorage", "DataStoreService" } do
			if string.find(src, needle, 1, true) then return `FAIL: {s:GetFullName()} references {needle}` end
		end
	end
end
return "PASS"
```
- Startup completes (playtest server probe, duration 5 s):
```lua
local deadline = os.clock() + 20
while workspace:GetAttribute("ServerReady") ~= true and os.clock() < deadline do
	task.wait(0.2)
end
return if workspace:GetAttribute("ServerReady") == true then "PASS" else "FAIL: ServerReady never set; a service init/start threw or yielded"
```

## Examples
`src/Server/Main.server.luau`: explicit lifecycle.
```lua
--!strict
local PlayerData = require(script.Parent.PlayerData)
local Inventory = require(script.Parent.Inventory)
local Combat = require(script.Parent.Combat)
local Round = require(script.Parent.Round)

PlayerData.init()
Inventory.init()
Combat.init({ onKill = Round.onKill }) -- upward notification via callback, not a require
Round.init()

PlayerData.start()
Inventory.start()
Combat.start()
Round.start()

workspace:SetAttribute("ServerReady", true)
```

A service with private state and an exported type (`src/Server/Round.luau`):
```lua
--!strict
local Players = game:GetService("Players")

export type Phase = "Lobby" | "Fighting" | "Ended"

local Round = {}

local phase: Phase = "Lobby"
local kills: { [Player]: number } = {}

function Round.init()
	phase = "Lobby"
end

function Round.start()
	Players.PlayerRemoving:Connect(function(player: Player)
		kills[player] = nil
	end)
end

function Round.onKill(killer: Player, _victim: Player?)
	kills[killer] = (kills[killer] or 0) + 1
	killer:SetAttribute("RoundKills", kills[killer])
end

function Round.phase(): Phase
	return phase
end

return Round
```

Content module (`src/Shared/Data/Items.luau`):
```lua
--!strict
export type Kind = "resource" | "tool" | "food" | "weapon" | "structure"
export type Item = {
	id: string,
	name: string,
	kind: Kind,
	stack: number,
	tier: number?, -- tools: harvesting tier
	power: number?, -- tools and weapons: damage per hit
	food: number?, -- food: hunger restored
}

local list: { Item } = {
	{ id = "wood", name = "Wood", kind = "resource", stack = 100 },
	{ id = "stone", name = "Stone", kind = "resource", stack = 100 },
	{ id = "stone_axe", name = "Stone Axe", kind = "tool", stack = 1, tier = 1, power = 4 },
	{ id = "berry", name = "Bloodberry", kind = "food", stack = 50, food = 12 },
}

local byId: { [string]: Item } = {}
for _, item in list do
	assert(byId[item.id] == nil, `duplicate item id {item.id}`)
	byId[item.id] = table.freeze(item)
end

return table.freeze(byId)
```

Client entry (`src/Client/Main.local.luau`):
```lua
--!strict
local Hud = require(script.Parent.Hud)
local Input = require(script.Parent.Input)

Hud.init()
Input.init({ onUse = Hud.flashHotbar })
Hud.start()
Input.start()
```

Data integrity assert (Edit; requires a fresh clone so the check sees the synced code):
```lua
local fresh = game:GetService("ReplicatedStorage").Shared:Clone()
local ok, result = pcall(function(): string
	local Items = require(fresh.Data.Items)
	for id, item in Items do
		if item.id ~= id then return `FAIL: key {id} holds item {item.id}` end
		if item.stack < 1 then return `FAIL: {id} has stack {item.stack}` end
		if item.kind == "tool" and item.tier == nil then return `FAIL: tool {id} has no tier` end
	end
	return "PASS"
end)
fresh:Destroy()
return if ok then result else `FAIL: {result}`
```

## References
- https://luau.org/types
- https://create.roblox.com/docs/reference/engine/classes/ModuleScript
- https://create.roblox.com/docs/scripting/locations
- https://create.roblox.com/docs/scripting/sync
- https://github.com/JohnnyMorganz/luau-lsp
- https://kampfkarren.github.io/selene/
