---
name: roblox-pvp-combat
description: "Build server-authoritative arena PvP in the style of Hypixel Pit: server-validated melee and ranged hits, cooldowns and i-frames, a single damage entry point, kill credit with assists, killstreaks and bounties, safe zones, anti-exploit basics, network ownership pitfalls and many-player performance."
version: 1
tags: [pvp, combat, melee, ranged, damage, killstreak, bounty, arena, hitdetection, anticheat]
roblox_systems: [Humanoid, Players, RemoteEvent, UnreliableRemoteEvent, WorldRoot, RaycastParams, ForceField, CollectionService, BasePart]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_run_luau, roblox_playtest, roblox_console, roblox_screenshot, roblox_sync_push, luau_check, test_register, task_add_evidence]
---
# Arena PvP combat (Pit-style)

## Purpose
A Pit-style game is a persistent free-for-all: players spawn on a safe platform, drop into the arena, and earn gold and XP per kill, with streak bonuses and bounties on players who keep winning. Every number that matters (damage, reach, cooldown, reward) is decided on the server; clients only say "I swung" or "I fired this way" and render feedback. This skill gives the validation pipeline, the damage/credit core and the traps.

## Preconditions
- roblox-networking-security (Net, Guard, Remote.listen) and luau-module-architecture (services, Data modules) are in place; rewards persist through roblox-data-persistence.
- Map: a spawn platform whose parts are tagged `SafeZone`, and an arena below. The server knows each player's equipped weapon (its own loadout state, never a client-sent id).

## Workflow
1. **Data first.** `Shared/Data/Weapons.luau` (kind, damage, reach/range, cooldown, facing arc) and `Shared/Data/Rewards.luau` (kill gold/XP, assist share, streak bonus, bounty step). Tuning never lives inside system code.
2. **Intents only.** Melee: `Swing(look: Vector3)` (unit camera direction). Ranged: `Shoot(direction: Vector3)`. The server takes the origin, weapon, damage and target selection from its own state.
3. **Server pipeline for every swing or shot:** rate limit (wrapper) → `Guard.vector3(look, 1.01)` → attacker alive, not in a safe zone, has that weapon kind equipped → server cooldown (`os.clock()`) → pick or validate the target with server positions: within reach plus a latency tolerance, inside the facing arc, clear line of sight, target alive, not in a safe zone, not on the attacker's team.
4. **One damage entry point**: `Combat.damage(victim, amount, attacker)` applies i-frames (a short per-victim window that ignores further hits), armor, `Humanoid:TakeDamage` (which respects `ForceField` spawn protection), records the hit in the victim's damage log, and broadcasts a small cosmetic event on an UnreliableRemoteEvent.
5. **Deaths**: connect `humanoid.Died:Once(...)` on `CharacterAdded`. Credit the kill to the most recent attacker within a window (e.g. 10 s), assists to others who dealt at least a share of max health in that window, then pay rewards, bump the killer's streak, pay out and reset the victim's bounty, and reset the victim's streak. Publish `Streak` and `Bounty` as player attributes for UI and tests; `leaderstats` for the player list.
6. **Ranged**: hitscan with `workspace:Raycast` / `Spherecast` from a server origin (head or HumanoidRootPart plus offset) along the validated direction; for travel-time projectiles simulate on the server in short raycast segments per `Heartbeat` and let clients draw the visuals from a broadcast.
7. **Safe zones and spawn protection**: server-side point-in-box tests against `SafeZone` parts; optionally a short `ForceField` on spawn. Attacks from or into a safe zone do nothing.
8. **Knockback**: the victim's client owns its character, so the server sends the victim a knockback event and the victim's client applies the velocity (server-set velocities on client-owned assemblies get overwritten).
9. **Movement sanity**: a low-rate server loop compares each root's displacement with what its WalkSpeed allows (plus slack and a grace period after server teleports) and rubber-bands obvious speed or teleport hacks instead of kicking on the first strike.
10. **Verify** (below), then `luau_check`, sync and register tests.

## Known pitfalls
- **Never accept client damage, targets, weapon ids, cooldown timestamps or hit positions as truth.** A client-proposed target is only a hint the server re-validates.
- **Server positions lag clients** by about their ping: allow a few studs of reach tolerance (`Player:GetNetworkPing()` is round-trip seconds) but keep it bounded; unbounded tolerance is a reach hack.
- **`Touched` on weapon handles** is unreliable and exploitable (clients can fake touches on parts they own). Use server spatial queries.
- **Shapecasts** (`Spherecast`, `Blockcast`, `Shapecast`) ignore parts the shape starts inside and travel at most 1024 studs; `Raycast` has neither restriction.
- **Raycast filters**: exclude the attacker's character (accessories included), and resolve hits with `hit.Instance:FindFirstAncestorOfClass("Model")` then `FindFirstChildOfClass("Humanoid")`, because hats and tools are hit too.
- **Setting `Humanoid.Health` directly bypasses `ForceField`**; use `TakeDamage` for anything spawn protection should block.
- **`Died` can race with respawn and leave**: guard credit logic so it runs once per death (`Once`, clear the log first), and drop logs for players who left.
- **Network ownership**: players own their characters, so speed and teleport exploits move them for real. NPCs and physics projectiles must be server-owned (`SetNetworkOwner(nil)` once in Workspace), or a nearby client can fling or freeze them.
- **Performance with many players**: per attack, iterate players once (O(n)); never all-pairs every frame. Use `GetPartBoundsInRadius` with an `OverlapParams` include-list for area damage, keep cosmetic payloads to a few numbers on an UnreliableRemoteEvent (payloads over 1000 bytes are dropped), and let clients spawn effects.
- **Combat logging**: a player who leaves shortly after being hit should still award the kill to the last attacker; otherwise leaving becomes a strategy.
- **Streaks and bounties are session state**; persist only lifetime stats and currency.

## Verification
Pure rules (`luau_assert`, edit; fresh clone because of the require cache):
```lua
local fresh = game:GetService("ReplicatedStorage").Shared:Clone()
local ok, result = pcall(function(): string
	local Rules = require(fresh.CombatRules)
	local origin, look = Vector3.zero, Vector3.new(0, 0, -1)
	if Rules.meleeReason(origin, look, Vector3.new(0, 0, -6), 7, 0.3) ~= nil then return "FAIL: target 6 studs ahead rejected" end
	if Rules.meleeReason(origin, look, Vector3.new(0, 0, -20), 7, 0.3) ~= "out of reach" then return "FAIL: 20 studs accepted" end
	if Rules.meleeReason(origin, look, Vector3.new(0, 0, 6), 7, 0.3) ~= "not facing" then return "FAIL: target behind accepted" end
	if Rules.cooldownReady(10, 0.5, 10.2) then return "FAIL: cooldown not enforced" end
	return "PASS"
end)
fresh:Destroy()
return if ok then result else `FAIL: {result}`
```

End-to-end (interactive, then record evidence): start a playtest; in a `Server` probe spawn a dummy 5 studs in front of the player (roblox-playtest-verification skill) and note its Health; run `roblox_run_luau` in `Client` firing `Swing` with the camera look vector; then a `Server` probe asserts the dummy's Health dropped by the weapon's damage, a second immediate swing did nothing (cooldown), and `roblox_console` is clean.

Durable runtime check (playtest server probe): combat state is published.
```lua
local player = game:GetService("Players"):GetPlayers()[1]
local deadline = os.clock() + 20
while not (player and player:GetAttribute("Streak") ~= nil) and os.clock() < deadline do
	task.wait(0.2)
	player = game:GetService("Players"):GetPlayers()[1]
end
if not player then return "FAIL: no player" end
if player:GetAttribute("Streak") ~= 0 or player:GetAttribute("Bounty") ~= 0 then
	return `FAIL: fresh player has Streak={player:GetAttribute("Streak")} Bounty={player:GetAttribute("Bounty")}`
end
return "PASS"
```

## Examples
`src/Shared/CombatRules.luau` (pure, so it is testable anywhere):
```lua
--!strict
local CombatRules = {}

CombatRules.REACH_TOLERANCE = 3 -- studs of forgiveness for server-side position lag

function CombatRules.meleeReason(from: Vector3, look: Vector3, target: Vector3, reach: number, arc: number): string?
	local offset = target - from
	if offset.Magnitude > reach + CombatRules.REACH_TOLERANCE then
		return "out of reach"
	end
	local flat = Vector3.new(offset.X, 0, offset.Z)
	local flatLook = Vector3.new(look.X, 0, look.Z)
	if flat.Magnitude > 1.5 and flatLook.Magnitude > 1e-3 and flatLook.Unit:Dot(flat.Unit) < arc then
		return "not facing"
	end
	return nil
end

function CombatRules.cooldownReady(lastUse: number?, cooldown: number, now: number): boolean
	return lastUse == nil or now - lastUse >= cooldown * 0.9 -- 10% allowance for jitter
end

return CombatRules
```

Damage, credit, streaks and bounties (`src/Server/Combat.luau`, core only):
```lua
--!strict
local Players = game:GetService("Players")
local PlayerData = require(script.Parent.PlayerData)

local CREDIT_WINDOW, ASSIST_SHARE, IFRAMES = 10, 0.25, 0.25
local KILL_GOLD, ASSIST_GOLD, BOUNTY_EVERY, BOUNTY_STEP = 10, 4, 5, 100

type Hit = { amount: number, at: number }
local logs: { [Humanoid]: { [Player]: Hit } } = {}
local hurtUntil: { [Humanoid]: number } = {}

local Combat = {}

function Combat.damage(victim: Humanoid, amount: number, attacker: Player?)
	local now = os.clock()
	if victim.Health <= 0 or (hurtUntil[victim] or 0) > now then
		return
	end
	hurtUntil[victim] = now + IFRAMES
	if attacker then
		local log: { [Player]: Hit } = logs[victim] or {}
		logs[victim] = log
		local hit: Hit = log[attacker] or { amount = 0, at = now }
		hit.amount += amount
		hit.at = now
		log[attacker] = hit
	end
	victim:TakeDamage(amount)
end

local function onDeath(victimPlayer: Player, humanoid: Humanoid)
	local log: { [Player]: Hit } = logs[humanoid] or {}
	logs[humanoid], hurtUntil[humanoid] = nil, nil
	local now = os.clock()
	local killer: Player? = nil
	for player, hit in log do
		if now - hit.at <= CREDIT_WINDOW and player.Parent == Players and (killer == nil or hit.at > log[killer].at) then
			killer = player
		end
	end
	local bounty = tonumber(victimPlayer:GetAttribute("Bounty")) or 0
	victimPlayer:SetAttribute("Streak", 0)
	victimPlayer:SetAttribute("Bounty", 0)
	if killer then
		local streak = (tonumber(killer:GetAttribute("Streak")) or 0) + 1
		killer:SetAttribute("Streak", streak)
		if streak % BOUNTY_EVERY == 0 then
			killer:SetAttribute("Bounty", (tonumber(killer:GetAttribute("Bounty")) or 0) + BOUNTY_STEP)
		end
		PlayerData.addCoins(killer, KILL_GOLD + bounty)
	end
	for player, hit in log do
		if player ~= killer and player.Parent == Players and now - hit.at <= CREDIT_WINDOW and hit.amount >= humanoid.MaxHealth * ASSIST_SHARE then
			PlayerData.addCoins(player, ASSIST_GOLD)
		end
	end
end

local function watchCharacter(player: Player, character: Model)
	local found = character:WaitForChild("Humanoid", 10)
	if found and found:IsA("Humanoid") then
		local humanoid: Humanoid = found
		humanoid.Died:Once(function()
			onDeath(player, humanoid)
		end)
	end
end

local function onPlayer(player: Player)
	player:SetAttribute("Streak", 0)
	player:SetAttribute("Bounty", 0)
	player.CharacterAdded:Connect(function(character: Model)
		watchCharacter(player, character)
	end)
	local current = player.Character
	if current then
		task.spawn(watchCharacter, player, current)
	end
end

function Combat.start()
	Players.PlayerAdded:Connect(onPlayer)
	for _, player in Players:GetPlayers() do
		task.spawn(onPlayer, player)
	end
end

return Combat
```

Server hitscan for ranged weapons (inside the `Shoot` handler, after validation):
```lua
local function hitscan(shooter: Model, origin: Vector3, direction: Vector3, range: number): (Humanoid?, Vector3)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { shooter }
	local result = workspace:Raycast(origin, direction.Unit * range, params)
	if not result then
		return nil, origin + direction.Unit * range
	end
	local model = result.Instance:FindFirstAncestorOfClass("Model")
	local humanoid = if model then model:FindFirstChildOfClass("Humanoid") else nil
	return humanoid, result.Position
end
```

Safe-zone test (server):
```lua
local CollectionService = game:GetService("CollectionService")

local function inSafeZone(position: Vector3): boolean
	for _, zone in CollectionService:GetTagged("SafeZone") do
		if zone:IsA("BasePart") then
			local p = zone.CFrame:PointToObjectSpace(position)
			local half = zone.Size / 2
			-- inside the footprint, from the zone's bottom face up to 8 studs above its top (standing on it counts)
			if math.abs(p.X) <= half.X and math.abs(p.Z) <= half.Z and p.Y >= -half.Y and p.Y <= half.Y + 8 then
				return true
			end
		end
	end
	return false
end
```

## References
- https://create.roblox.com/docs/scripting/security/security-tactics
- https://create.roblox.com/docs/workspace/raycasting
- https://create.roblox.com/docs/reference/engine/classes/WorldRoot
- https://create.roblox.com/docs/reference/engine/classes/Humanoid
- https://create.roblox.com/docs/physics/network-ownership
- https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent
- https://create.roblox.com/docs/reference/engine/classes/Player (GetNetworkPing)
