---
name: roblox-playtest-verification
description: "Write reliable automated checks for Roblox work in Shuriken: luau_assert programs, playtest server probes that wait for the player and character, teleport-triggered interactions, polling with deadlines, console and screenshot evidence, and durable regression tests via test_register."
version: 2
tags: [testing, verification, playtest, qa, assert, probe, regression, evidence, tests]
roblox_systems: [Players, Humanoid, RunService, CollectionService, StudioTestService, HumanoidDescription]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_run_luau, roblox_playtest, roblox_console, roblox_screenshot, roblox_status, roblox_call, test_register, task_add_evidence]
---
# Playtest verification

## Purpose
A task is done when its acceptance criteria are demonstrably met, not when code exists. This skill turns criteria into checks Shuriken can run unattended and re-run forever as regression tests: `luau_assert` programs, `playtest` runs with a server probe, console scans and screenshots.

## Preconditions
Know exactly how Shuriken executes each method:
- **luau_assert** `{kind, name, luau, datamodel}` runs `luau` through `execute_luau` in the given DataModel (default `edit`) with a 60 s timeout. It passes only if the code did not throw **and** the returned string starts with `PASS` (case-insensitive, leading spaces allowed). Anything else fails, so return `"FAIL: expected X, got Y"`.
- **playtest** `{kind, name, durationSec, luau?, failOnConsoleErrors}` records the console, starts Play Solo (the Studio user joins and spawns), waits `durationSec` (clamped to 2–120 s), runs `luau` on the **Server** DataModel (60 s timeout), takes a best-effort screenshot, stops play, then scans only the new console lines. A line matching `error`, `Stack Begin`, `attempt to index|call|perform|compare|concatenate`, `is not a valid member`, `Infinite yield possible` or `exception` (case-insensitive) fails the run. Ignored: sound load failures, `HTTP 4xx`, lines containing `Plugin`, and DataStore `StudioAccessToApisNotAllowed`.
- In `shuriken` sync mode Shuriken pushes code before Studio methods run; a sync error fails verification at once.
- DataModel spelling differs: `roblox_run_luau` takes `Edit` / `Server` / `Client`; `test_register` takes `edit` / `server` / `client`. A registered `luau_assert` with `server` or `client` only works while a playtest happens to be running (the regression runner does not start one), so durable asserts use `edit` and runtime checks use `playtest`.

## Workflow
1. **Make the system observable before testing it.** Server code publishes state where probes can read it: player attributes (`Coins`, `Kills`, `Streak`), `leaderstats` values, attributes on world instances (`Health` on a resource node), a state object (e.g. `ReplicatedStorage.RoundState` attributes), and a readiness flag set at the end of server startup: `workspace:SetAttribute("ServerReady", true)`.
2. **Choose the check type:**
   - structure, data tables, tags and attributes placed at edit time → `luau_assert` (edit);
   - runtime behaviour (spawning, rewards, damage, respawn timers, round flow) → `playtest` + server probe;
   - visuals and UI → `roblox_screenshot` evidence plus a `screenshot` method for the critic;
   - real client input → interactive checks only (step 5).
3. **Write the probe** from the skeleton in Examples: wrap everything in `pcall`, wait for conditions with deadlines instead of fixed sleeps, and return `PASS` or `FAIL: reason`.
4. **Dry-run it yourself** in one call: `roblox_playtest {action:"run", seconds, luau:"<probe>"}` plays, runs the probe in the Server DataModel, returns its output with any errors from the output, and stops. Then prove it can fail: temporarily assert a wrong expected value (or run against the unfixed build) and confirm you get `FAIL:`. A check that cannot fail is not evidence.
5. **Interactive client checks** (development only): during a playtest use `roblox_call` with `character_navigation`, `user_keyboard_input` or `user_mouse_input` (all `datamodel_type: "Client"`), or `roblox_run_luau` in `Client` to fire a RemoteEvent as the real client, then assert the outcome with a `Server` probe.
6. **Record evidence**: `task_add_evidence {kind:"test_result", title, passed, data:{output}}`. Screenshots from `roblox_screenshot` are attached to the task automatically.
7. **Register durable tests** with `test_register` (Examples). Name them by behaviour ("coin pad pays 10 coins"), not by task, so a regression failure explains itself.

## Known pitfalls
- **Never print the words "error" or "exception" in normal output**, including `warn`; the console scan fails the playtest. Fix every `Infinite yield possible` warning (a `WaitForChild` that waited over 5 s): pass a timeout or make sure the instance exists.
- **Probes run in a separate VM.** `require` inside a probe returns a fresh module: calling a service function acts on empty state, and calling its `start()` would connect everything twice. Only pure modules (formulas, validators, data tables) are safe to require from a probe.
- **Stale Edit cache.** In `edit` asserts, require a clone of the module tree (shuriken-studio-workflow skill).
- **Time budget.** The probe has 60 s in total, and `durationSec` elapses before it starts. Keep all probe deadlines within ~45 s.
- **Characters.** The player may still be loading, `Players.CharacterAutoLoads` may be off, and the character can die and respawn mid-test. Wait for `player.Character` and its `HumanoidRootPart`, and re-fetch after a respawn.
- **Teleports.** Move characters from the server with `character:PivotTo(cf)`, about 3 studs above a surface. The client owns its character, so `Touched` fires only after the move replicates and the client simulates a step: poll for the effect for several seconds. Server-side zone checks (`GetPartBoundsInBox` on a timer) are more deterministic than `Touched` and easier to test.
- **One player.** Play Solo has exactly one real player. For PvP targets spawn a server-owned dummy in the probe (`Players:CreateHumanoidModelFromDescriptionAsync`; the non-Async name is deprecated). `StudioTestService:ExecuteMultiplayerTestAsync` (up to 8 clients) exists but yields until the test ends, takes over Studio and is not wired into Shuriken's playtest method.
- **Randomness makes flaky tests.** Let systems read optional tuning attributes (e.g. a respawn time or seed), and assert ranges instead of exact random outcomes.
- **DataStores in Studio** need "Enable Studio Access to API Services"; without it ProfileStore silently uses a mock store. Don't write tests that need persistence across playtests unless the project is a dedicated test experience.
- **Console history.** `roblox_console` returns the tail of the whole log, including old runs. Print a unique marker (`print("[probe] 7f3a start")`) and only read lines after it.
- **Screenshots** taken in play can miss BillboardGuis and ProximityPrompt UI. Capture after the scene settles, with explicit `camera` and `look_at`.
- **Always stop the playtest**, including after a failure: a Studio left in Play blocks every Edit tool for the next agent.

## Verification
Before registering a test, it must pass twice in a row on the working build, fail with a specific `FAIL:` message when the behaviour is broken, finish in well under 60 s, and leave no console errors. Record the pass and the deliberate failure as evidence.

## Examples
Server probe skeleton (the `luau` of a `playtest` test):
```lua
--!strict
local Players = game:GetService("Players")

local function waitFor<T>(what: string, timeout: number, get: () -> T?): T
	local deadline = os.clock() + timeout
	while os.clock() < deadline do
		local value = get()
		if value ~= nil then
			return value
		end
		task.wait(0.1)
	end
	error(`timed out after {timeout}s waiting for {what}`, 0)
end

local ok, result = pcall(function(): string
	waitFor("ServerReady", 15, function(): boolean?
		return if workspace:GetAttribute("ServerReady") == true then true else nil
	end)
	local player = waitFor("player", 15, function(): Player?
		return Players:GetPlayers()[1]
	end)
	local character = waitFor("character", 15, function(): Model?
		return player.Character
	end)
	waitFor("HumanoidRootPart", 10, function(): Instance?
		return character:FindFirstChild("HumanoidRootPart")
	end)
	local stats = player:FindFirstChild("leaderstats")
	if not (stats and stats:FindFirstChild("Kills")) then
		return "FAIL: leaderstats.Kills missing"
	end
	return "PASS"
end)
return if ok then result else `FAIL: {result}`
```

Teleport onto a trigger and wait for the reward (continues inside the `pcall` above):
```lua
local map = workspace:FindFirstChild("Map")
local pad = map and map:FindFirstChild("CoinPad")
if not (pad and pad:IsA("BasePart")) then
	return "FAIL: Workspace.Map.CoinPad missing"
end
local before = tonumber(player:GetAttribute("Coins")) or 0
character:PivotTo(pad.CFrame + Vector3.new(0, 3, 0))
local after = waitFor("Coins to increase", 8, function(): number?
	local coins = player:GetAttribute("Coins")
	return if type(coins) == "number" and coins > before then coins else nil
end)
if after - before ~= 10 then
	return `FAIL: expected +10 coins, got +{after - before}`
end
```

Server-owned dummy target for combat tests (inside the `pcall`, after `character` is known):
```lua
local root = character:FindFirstChild("HumanoidRootPart") :: BasePart
local dummy = Players:CreateHumanoidModelFromDescriptionAsync(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
dummy.Name = "TestDummy"
dummy:PivotTo(root.CFrame * CFrame.new(0, 0, -5)) -- 5 studs in front of the player
dummy.Parent = workspace
local dummyRoot = dummy:FindFirstChild("HumanoidRootPart")
if dummyRoot and dummyRoot:IsA("BasePart") then
	dummyRoot:SetNetworkOwner(nil) -- only valid once it is in Workspace
end
```

Fire a remote as the real client (interactive; `roblox_run_luau` datamodel `Client` during a playtest):
```lua
local remotes = game:GetService("ReplicatedStorage"):WaitForChild("Remotes", 5)
local swing = remotes and remotes:FindFirstChild("Swing")
if not (swing and swing:IsA("RemoteEvent")) then
	return "FAIL: Remotes.Swing not replicated"
end
swing:FireServer(Vector3.new(0, 0, -1))
return "PASS: fired"
```

Edit-mode data assert (register as `luau_assert`, datamodel `edit`):
```lua
local fresh = game:GetService("ReplicatedStorage").Shared:Clone()
local ok, result = pcall(function(): string
	local Items = require(fresh.Data.Items)
	local Recipes = require(fresh.Data.Recipes)
	for id, recipe in Recipes do
		if not Items[recipe.output.item] then return `FAIL: recipe {id} outputs unknown item {recipe.output.item}` end
		for input in recipe.inputs do
			if not Items[input] then return `FAIL: recipe {id} needs unknown item {input}` end
		end
	end
	return "PASS"
end)
fresh:Destroy()
return if ok then result else `FAIL: {result}`
```

Registering and recording:
```json
{"name": "coin pad pays 10 coins", "kind": "playtest", "duration_sec": 5, "luau": "<probe source>"}
{"name": "recipes reference existing items", "kind": "luau_assert", "datamodel": "edit", "luau": "<assert source>"}
{"kind": "test_result", "title": "Coin pad probe", "passed": true, "data": {"output": "PASS"}}
```
The first two are `test_register` arguments, the last is `task_add_evidence`.

## References
- https://create.roblox.com/docs/studio/testing-modes
- https://create.roblox.com/docs/reference/engine/classes/StudioTestService
- https://create.roblox.com/docs/reference/engine/classes/Players
- https://create.roblox.com/docs/physics/network-ownership
- https://create.roblox.com/docs/studio/mcp
- https://github.com/Roblox/jest-roblox (official unit-test framework for larger pure-logic suites)
- https://devforum.roblox.com/t/4849810 (community: separate VM and fresh `require` in play DataModels)
