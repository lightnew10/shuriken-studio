---
name: roblox-data-persistence
description: "Persist player data safely on Roblox: DataStoreService budgets and failure handling, session locking against item duplication, the ProfileStore pattern (vendored community library), Studio API access, BindToClose, autosave and schema migrations; use for any feature that saves progress, currency or inventory."
version: 2
tags: [datastore, persistence, profilestore, saving, data, sessionlock, migration, playerdata, economy]
roblox_systems: [DataStoreService, Players, DataModel, RunService, MarketplaceService, OrderedDataStore]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_run_luau, roblox_playtest, roblox_console, roblox_sync_push, luau_check, test_register, task_add_evidence, escalate]
---
# Roblox data persistence

## Purpose
Save player progress without losing it and without letting it be duplicated. DataStores are eventually-consistent key-value storage with request budgets and no locking. Scattered `GetAsync`/`SetAsync` calls lose data under throttling and let a player load the same key on two servers at once (fast rejoin or teleport before the old server saved), which is the classic item-duplication exploit. One module owns persistence, uses a session lock, and everything else goes through its API.

## Preconditions
- **ProfileStore** (community library by loleris / MadStudioRoblox, Apache-2.0; not a Roblox API) is vendored at `src/Server/Packages/ProfileStore.luau`: the upstream single ModuleScript copied byte-for-byte below a header comment (`--!nonstrict`, source URL, version or commit, license), with the license file kept in the repo (e.g. `licenses/ProfileStore-LICENSE`). Never edit the vendored code; wrap it.
- DataStores need a **published** experience. In Studio they also need File → Experience Settings → Security → **Enable Studio Access to API Services**. That setting is the user's to turn on, in Studio, so never wait for it: build and test against the mock store, say in your result that saving is untested until it is on, and `escalate` only if the task would also publish the game or spend money (those always wait for the owner, in every mode). With it on, Studio reads and writes the **same** stores as the live game, so Roblox recommends it only on a separate test experience. Without it, ProfileStore quietly falls back to a mock store (`ProfileStore.DataStoreState` is `"NoAccess"`) and nothing persists between playtests.

## Workflow
1. **One owner**: `src/Server/PlayerData.luau` is the only code that touches player persistence. Other services call its API (`get`, typed mutators like `addCoins`) and never cache the data table across sessions.
2. **Template and name**: a typed `TEMPLATE` containing a `version` field and a store name such as `"PlayerData_v1"` (changing the name starts everyone from scratch; treat it as a wipe).
3. **Load on join** (and for players already present when the service starts): `store:StartSessionAsync("Player_" .. userId, {Cancel = function() return player.Parent ~= Players end})`. A `nil` result means the lock could not be acquired or DataStores are down: kick with a clear message rather than letting them play on a profile that will not save.
4. **After load**: `AddUserId(userId)` (data-deletion requests), run **migrations before `Reconcile()`**, then `Reconcile()` to fill new template fields, connect `OnSessionEnd` (kick if the player is still in game: the session moved to another server), and if the player left during loading, `EndSession()` immediately.
5. **Publish** derived, non-secret state for UI and tests: attributes (`Coins`, `DataLoaded = true`), `leaderstats`, or an owner-only remote.
6. **Leave**: on `PlayerRemoving` call `EndSession()`; ProfileStore saves and releases the lock. It also autosaves active profiles every 300 s (`AUTO_SAVE_PERIOD`) and handles `BindToClose` itself, so do not add your own save loops.
7. **Migrations**: bump `Migrations.LATEST`, add a step function that transforms version n-1 into n in place, keep steps forever, and never drop a field in the same release that code still reads.
8. **Purchases** (`MarketplaceService.ProcessReceipt`): make grants idempotent by recording `receipt.PurchaseId` in the profile, and return `PurchaseGranted` only once the grant is safely saved (ProfileStore exposes `LastSavedData` and `OnAfterSave` for this); otherwise return `NotProcessedYet` so Roblox retries.
9. **Non-player data** (tribe registries, global counters): a separate store accessed with `UpdateAsync` (atomic read-modify-write) through one module with `pcall`, retries with backoff and budget checks. Leaderboards use an `OrderedDataStore` with coarse, infrequent writes.

## Known pitfalls
- **Budgets (docs, Sept 2026).** Experience-wide per minute, shared by all servers and Open Cloud: read 300 + 40×CCU, write 300 + 20×CCU, list 300 + 2×CCU, remove 300 + 40×CCU. Per-server defaults: standard read/write/remove 60 + 40×players, list 5 + 2×players; ordered write/remove 30 + 5×players. `UpdateAsync` consumes both a read and a write. Check `DataStoreService:GetRequestBudgetForRequestType` with the **modern** enum values (`StandardRead`, `StandardWrite`, `StandardList`, `StandardRemove`, `Ordered*`); the legacy values (`GetAsync`, `UpdateAsync`, `SetIncrementAsync`, ...) should not be used.
- **Queues**: throttled requests wait in queues of 30; beyond that they fail with errors 301–306 and are dropped.
- **Size**: keys, store names and scopes ≤ 50 characters; one value ≤ 4,194,304 characters; per-key throughput 25 MB/min read, 4 MB/min write.
- **Only JSON-like data**: no Instances, Vector3/CFrame/Color3 (serialize to numbers), functions, mixed tables, sparse arrays, or non-string/non-sequential keys.
- **`UpdateAsync` transform functions must not yield**; return `nil` to cancel the write.
- **Every raw DataStore call can fail**: wrap it in `pcall`, retry with exponential backoff, and give up loudly but once.
- **Migrate before `Reconcile()`**: Reconcile copies `version = LATEST` from the template into old profiles that lack the field, which would skip their migrations.
- **`Profile.Data` is only guaranteed to save while `profile:IsActive()`**; re-check after any yield before mutating.
- **Store sources, not derived values** (store `xp`, compute `level`), so balance changes don't need migrations.
- **Studio behaviour**: `BindToClose` runs when a playtest stops (up to 30 s), which can make stopping slow. Logged DataStore failures other than `StudioAccessToApisNotAllowed` fail Shuriken playtests.
- **Never write player data from several modules or scripts**, and never call `SetAsync` on a player key outside the session owner: that is exactly how duplication and rollbacks happen.

## Verification
Migrations are complete and correct (`luau_assert`, edit; fresh clone of the server folder):
```lua
local fresh = game:GetService("ServerScriptService").Server:Clone()
local ok, result = pcall(function(): string
	local Migrations = require(fresh.Migrations)
	local old: { [string]: any } = { gold = 7, inventory = { "wood", "wood", "stone" } } -- a version-1 profile
	Migrations.run(old)
	if old.version ~= Migrations.LATEST then return `FAIL: version {old.version}, expected {Migrations.LATEST}` end
	if old.coins ~= 7 or old.gold ~= nil then return "FAIL: gold was not renamed to coins" end
	if old.inventory.wood ~= 2 or old.inventory.stone ~= 1 then return "FAIL: inventory not converted to counts" end
	return "PASS"
end)
fresh:Destroy()
return if ok then result else `FAIL: {result}`
```

Profile loads and is published (playtest server probe, duration 5 s):
```lua
local Players = game:GetService("Players")
local deadline = os.clock() + 30
local player = Players:GetPlayers()[1]
while (not player or player:GetAttribute("DataLoaded") ~= true) and os.clock() < deadline do
	task.wait(0.2)
	player = Players:GetPlayers()[1]
end
if not player then return "FAIL: no player joined" end
if player:GetAttribute("DataLoaded") ~= true then return "FAIL: DataLoaded never set (session not started?)" end
if type(player:GetAttribute("Coins")) ~= "number" then return "FAIL: Coins attribute missing" end
return "PASS"
```

Also required: the playtest console shows no DataStore failures and no errors on stop (`EndSession` and `BindToClose` paths). A save/load round trip across two playtests is only meaningful on a test experience with API access enabled; record it as evidence when available.

## Examples
`src/Server/PlayerData.luau`:
```lua
--!strict
local Players = game:GetService("Players")

local ProfileStore = require(script.Parent.Packages.ProfileStore)
local Migrations = require(script.Parent.Migrations)

export type Data = {
	version: number,
	coins: number,
	inventory: { [string]: number },
	stats: { [string]: number },
}

local TEMPLATE: Data = {
	version = Migrations.LATEST,
	coins = 0,
	inventory = {},
	stats = { kills = 0, deaths = 0 },
}

-- The parts of a ProfileStore profile used here (the vendored module is --!nonstrict).
type Profile = {
	Data: Data,
	OnSessionEnd: { Connect: (any, () -> ()) -> any },
	AddUserId: (Profile, number) -> (),
	Reconcile: (Profile) -> (),
	EndSession: (Profile) -> (),
}

local store = ProfileStore.New("PlayerData_v1", TEMPLATE)
local profiles: { [Player]: Profile } = {}

local PlayerData = {}

function PlayerData.get(player: Player): Data?
	local profile = profiles[player]
	return if profile then profile.Data else nil
end

function PlayerData.addCoins(player: Player, amount: number): boolean
	local data = PlayerData.get(player)
	if not data or amount ~= amount or amount <= 0 then
		return false
	end
	data.coins += amount
	player:SetAttribute("Coins", data.coins)
	return true
end

local function load(player: Player)
	local profile: Profile? = store:StartSessionAsync(`Player_{player.UserId}`, {
		Cancel = function(): boolean
			return player.Parent ~= Players
		end,
	}) :: any
	if not profile then
		if player.Parent == Players then
			player:Kick("Could not load your data. Please rejoin in a moment.")
		end
		return
	end
	profile:AddUserId(player.UserId)
	Migrations.run(profile.Data :: any) -- before Reconcile, see pitfalls
	profile:Reconcile()
	profile.OnSessionEnd:Connect(function()
		profiles[player] = nil
		if player.Parent == Players then
			player:Kick("Your data was loaded on another server. Please rejoin.")
		end
	end)
	if player.Parent ~= Players then
		profile:EndSession()
		return
	end
	profiles[player] = profile
	player:SetAttribute("Coins", profile.Data.coins)
	player:SetAttribute("DataLoaded", true)
end

function PlayerData.init() end

function PlayerData.start()
	Players.PlayerAdded:Connect(load)
	for _, player in Players:GetPlayers() do
		task.spawn(load, player)
	end
	Players.PlayerRemoving:Connect(function(player: Player)
		local profile = profiles[player]
		profiles[player] = nil
		if profile then
			profile:EndSession()
		end
	end)
end

return PlayerData
```

`src/Server/Migrations.luau` (pure, unit-testable):
```lua
--!strict
type AnyData = { [string]: any }

local STEPS: { [number]: (AnyData) -> () } = {
	[2] = function(d) -- v1 -> v2: "gold" renamed to "coins"
		d.coins = d.gold or 0
		d.gold = nil
	end,
	[3] = function(d) -- v2 -> v3: inventory list of ids -> { [id]: count }
		local counts: { [string]: number } = {}
		for _, id in d.inventory or {} do
			counts[id] = (counts[id] or 0) + 1
		end
		d.inventory = counts
	end,
}

local Migrations = { LATEST = 3 }

function Migrations.run(d: AnyData)
	local from = if type(d.version) == "number" then d.version else 1
	for step = from + 1, Migrations.LATEST do
		STEPS[step](d)
		d.version = step
	end
end

return Migrations
```

Raw store access for non-player data (`src/Server/GlobalStore.luau`):
```lua
--!strict
local DataStoreService = game:GetService("DataStoreService")

local GlobalStore = {}

function GlobalStore.update(storeName: string, key: string, transform: (any) -> any): (boolean, any)
	local store = DataStoreService:GetDataStore(storeName)
	local lastProblem: any = nil
	for attempt = 1, 3 do
		local ok, result = pcall(function()
			return store:UpdateAsync(key, transform) -- transform must not yield
		end)
		if ok then
			return true, result
		end
		lastProblem = result
		task.wait(2 ^ attempt) -- 2, 4, 8 s backoff
	end
	warn(`[GlobalStore] gave up on {storeName}/{key}: {lastProblem}`)
	return false, lastProblem
end

return GlobalStore
```

## References
- https://create.roblox.com/docs/cloud-services/data-stores
- https://create.roblox.com/docs/cloud-services/data-stores/error-codes-and-limits
- https://create.roblox.com/docs/cloud-services/data-stores/player-data-purchasing
- https://create.roblox.com/docs/reference/engine/classes/DataStoreService
- https://create.roblox.com/docs/reference/engine/enums/DataStoreRequestType
- https://create.roblox.com/docs/reference/engine/classes/DataModel (BindToClose: 30 s limit)
- https://github.com/MadStudioRoblox/ProfileStore (community library) and https://madstudioroblox.github.io/ProfileStore/
