---
name: roblox-ragdoll-knockback
description: "Knock characters back and ragdoll them the way current Roblox rigs need: R15 characters now use AnimationConstraint joints with built-in ball sockets (not Motor6Ds), so old ragdoll scripts do nothing. A tested server module (knockback, timed ragdoll, restore; works on both joint kinds, NPCs and players) and its client half, with the network-ownership rules for launching players."
version: 2
tags: [ragdoll, knockback, launch, combat, battlegrounds, pvp, physics, stun, finisher, uppercut, slam, death]
roblox_systems: [Humanoid, AnimationConstraint, BallSocketConstraint, Motor6D, RemoteEvent, BasePart]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_run_luau, roblox_playtest, roblox_sync_push, luau_check, task_add_evidence]
---
# Knockback and ragdolls

## Purpose
Finishers, uppercuts and slams feel right when the victim flies and flops, then gets back up. Two
facts make this harder than tutorials suggest, both measured in Studio (September 2026):
- **R15 rigs join their parts with `AnimationConstraint`s** (kinematic, `MaxTorque` 3000) and already
  carry 14 limited `BallSocketConstraint`s — player characters and `CreateHumanoidModelFromDescription`
  rigs alike. There are no Motor6Ds to disable, so Motor6D ragdoll code silently does nothing.
  Disabling the animation joints (not the root) lets the built-in sockets take over.
- **A player's character is simulated by that player's client.** A velocity or Humanoid state set on
  the server is overwritten; the owning client has to apply it. NPCs are the server's (give their root
  `SetNetworkOwner(nil)`).
- **A launch has to move the right parts.** While limp, every limb is its own assembly (only the root
  and lower torso stay together): a velocity on the root alone dragged the body 4 studs, the same
  velocity on every part threw it 28–29. Upright, the Humanoid eats a velocity set once (1 stud); a
  `LinearVelocity` on the root for 0.2 s pushes it 14–16 studs and it stays on its feet. Measured at
  45 studs/s forward + 25 up, NPCs and players alike.

## Preconditions
- One server damage/combat module decides hits (see `roblox-combat-feel`, `roblox-pvp-combat`).
- R15 characters (R6 rigs use Motor6Ds; the module handles those too).

## Workflow
1. Add the module as `src/Server/Ragdoll.luau` and the client script as
   `src/Client/Ragdoll.client.luau` (Examples). The module creates `ReplicatedStorage.Remotes.Ragdoll`.
2. On a heavy hit: `Ragdoll.knockback(victimCharacter, direction * 45 + Vector3.yAxis * 25, 0.8)` —
   launch plus a 0.8 s ragdoll that restores itself; a second hit extends it. Without the seconds it's
   a push that keeps the victim standing (staggers, shoves, blocked heavies).
3. While `character:GetAttribute("Ragdolled")` is true, treat the victim as stunned (no attacks, no
   blocking) and decide whether combos can continue (most games give a short knockdown immunity).
4. Deaths: set `Humanoid.BreakJointsOnDeath = false` on spawn and call `Ragdoll.ragdoll(character)` in
   `Died` — the body stays limp until respawn (restore refuses dead characters).
5. Verify in a playtest with a server-owned dummy (Verification).

## Known pitfalls
- **Motor6D-only ragdoll scripts** (from older tutorials or the toolbox) do nothing on current rigs.
- **Anchored NPC roots** (common for training dummies) can't be launched or ragdolled: unanchor them
  and give the server network ownership, or skip knockback for anchored targets.
- **Setting the victim player's velocity on the server** gets overwritten by their client: send it to
  that client (the module does).
- **Launching only the HumanoidRootPart of a ragdoll** barely moves it (the limbs are separate
  assemblies and drag it back); **setting the velocity of a standing character once** is cancelled by
  the Humanoid within a frame. The module launches every part when limp and pushes with a short
  `LinearVelocity` otherwise.
- **Limbs through the floor**: limbs must collide while limp (the module turns collisions on and puts
  them back on restore).
- **Humanoid getting up mid-ragdoll**: the owner disables the GettingUp state while ragdolled (client
  script) and re-enables it on restore.
- **Knockback into walls or out of the map**: clamp the launch speed, and keep an out-of-bounds reset.

## Verification
Server probe in a playtest (edit the position to open floor):
- Spawn an R15 dummy (`Players:CreateHumanoidModelFromDescription`), wait 1.5 s, call
  `Ragdoll.knockback(dummy, Vector3.new(0, 25, 45), 1.6)`.
- Right after: 14 `AnimationConstraint`s disabled (the root one stays on), `Humanoid:GetState()` is
  `Physics`, the head drops toward the root within 0.5 s; after 1.5 s the root is 20+ studs away.
- After 2 s: all 15 joints enabled again, state `Running`, root upright (`UpVector.Y` ≈ 1).
- A push (`Ragdoll.knockback(dummy, Vector3.new(0, 25, 45))`) moves it 10+ studs and it stays upright.
(Measured: head 1.67 studs above the root standing, 0.3 while limp, 1.67 again after restoring.)

## Examples
Server module — `src/Server/Ragdoll.luau`:
```lua
--!strict
-- Ragdoll and knockback for R15 characters and NPCs, server side.
--   Ragdoll.knockback(victim, velocity, seconds?)  -- launch; ragdolls for `seconds` when given
--   Ragdoll.ragdoll(victim, seconds?) / Ragdoll.restore(victim)
-- Joints go limp on ball sockets (limbs flop but stay attached): current R15 rigs (AnimationConstraint
-- joints, ball sockets built in) and older Motor6D rigs alike; joints are disabled, not destroyed, so
-- restoring puts the rig back exactly. Player characters are simulated by their own client, so the
-- server also tells that client (Remotes.Ragdoll) to switch the Humanoid to Physics and apply velocity.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Ragdoll = {}

local function remote(): RemoteEvent
	local folder = ReplicatedStorage:FindFirstChild("Remotes")
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = "Remotes"
		folder.Parent = ReplicatedStorage
	end
	local r = folder:FindFirstChild("Ragdoll")
	if not (r and r:IsA("RemoteEvent")) then
		r = Instance.new("RemoteEvent")
		r.Name = "Ragdoll"
		r.Parent = folder
	end
	return r :: RemoteEvent
end
local Remote = remote()

local restoreAt: { [Model]: number } = {}

local function isRagdolled(character: Model): boolean
	return character:GetAttribute("Ragdolled") == true
end

function Ragdoll.ragdoll(character: Model, seconds: number?)
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid then
		return
	end
	if not isRagdolled(character) then
		character:SetAttribute("Ragdolled", true)
		-- Current R15 rigs join parts with AnimationConstraints and already carry limited ball sockets:
		-- disabling the animation joints lets them flop. Older rigs (Motor6D) get ball sockets made from
		-- their C0/C1. The root joint stays, so the body keeps its HumanoidRootPart.
		local hasSocket: { [Instance]: boolean } = {}
		for _, d in character:GetDescendants() do
			if d:IsA("BallSocketConstraint") and d.Attachment1 then
				hasSocket[d.Attachment1] = true
			end
		end
		for _, joint in character:GetDescendants() do
			if joint.Name == "Root" then
				continue
			end
			if joint:IsA("AnimationConstraint") and joint.Enabled then
				local a1 = joint.Attachment1
				if a1 and not hasSocket[a1] and joint.Attachment0 then
					local socket = Instance.new("BallSocketConstraint")
					socket.Name = "RagdollSocket"
					socket.Attachment0 = joint.Attachment0
					socket.Attachment1 = a1
					socket.LimitsEnabled = true
					socket.UpperAngle = 45
					socket.Parent = a1.Parent
				end
				joint:SetAttribute("RagdollOff", true)
				joint.Enabled = false
			elseif joint:IsA("Motor6D") and joint.Enabled and joint.Part0 and joint.Part1 then
				local a0 = Instance.new("Attachment")
				a0.Name = "RagdollA0"
				a0.CFrame = joint.C0
				a0.Parent = joint.Part0
				local a1 = Instance.new("Attachment")
				a1.Name = "RagdollA1"
				a1.CFrame = joint.C1
				a1.Parent = joint.Part1
				local socket = Instance.new("BallSocketConstraint")
				socket.Name = "RagdollSocket"
				socket.Attachment0 = a0
				socket.Attachment1 = a1
				socket.LimitsEnabled = true
				socket.UpperAngle = if joint.Name == "Neck" or joint.Name == "Waist" then 30 else 70
				socket.TwistLimitsEnabled = true
				socket.TwistLowerAngle = -45
				socket.TwistUpperAngle = 45
				socket.Parent = joint.Part0
				joint:SetAttribute("RagdollOff", true)
				joint.Enabled = false
			end
		end
		-- Limbs collide while floppy (otherwise they sink through the floor); the root doesn't.
		for _, part in character:GetDescendants() do
			if part:IsA("BasePart") and part.Name ~= "HumanoidRootPart" then
				part:SetAttribute("RagdollCanCollide", part.CanCollide)
				part.CanCollide = true
			end
		end
		humanoid.PlatformStand = true
		humanoid.AutoRotate = false
		local player = Players:GetPlayerFromCharacter(character)
		if player then
			Remote:FireClient(player, "ragdoll")
		else
			humanoid:ChangeState(Enum.HumanoidStateType.Physics)
		end
	end
	if seconds then
		local endsAt = os.clock() + seconds
		restoreAt[character] = math.max(restoreAt[character] or 0, endsAt)
		task.delay(seconds, function()
			if restoreAt[character] and os.clock() >= restoreAt[character] - 0.01 then
				Ragdoll.restore(character)
			end
		end)
	end
end

function Ragdoll.restore(character: Model)
	restoreAt[character] = nil
	if not isRagdolled(character) or not character.Parent then
		return
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if humanoid and humanoid.Health <= 0 then
		return -- stay down: the death ragdoll ends with the respawn
	end
	for _, d in character:GetDescendants() do
		local made = (d:IsA("BallSocketConstraint") and d.Name == "RagdollSocket") or (d:IsA("Attachment") and (d.Name == "RagdollA0" or d.Name == "RagdollA1"))
		if made then
			d:Destroy()
		elseif (d:IsA("Motor6D") or d:IsA("AnimationConstraint")) and d:GetAttribute("RagdollOff") then
			(d :: any).Enabled = true
			d:SetAttribute("RagdollOff", nil)
		elseif d:IsA("BasePart") then
			local was = d:GetAttribute("RagdollCanCollide")
			if typeof(was) == "boolean" then
				d.CanCollide = was
				d:SetAttribute("RagdollCanCollide", nil)
			end
		end
	end
	character:SetAttribute("Ragdolled", false)
	if humanoid then
		humanoid.PlatformStand = false
		humanoid.AutoRotate = true
		local player = Players:GetPlayerFromCharacter(character)
		if player then
			Remote:FireClient(player, "restore")
		else
			humanoid:ChangeState(Enum.HumanoidStateType.GettingUp)
		end
	end
end

--- How long a push without a ragdoll lasts. A velocity set once is cancelled by the standing Humanoid;
--- a LinearVelocity carries the push and leaves the character on its feet.
local PUSH_SECONDS = 0.2

--- Apply a launch where the character is simulated. While limp every limb is its own assembly, so all
--- of them get the velocity (the root alone moves the body ~4 studs instead of ~28).
function Ragdoll.launch(character: Model, velocity: Vector3, limp: boolean)
	local root = character:FindFirstChild("HumanoidRootPart")
	if not (root and root:IsA("BasePart")) then
		return
	end
	if limp then
		for _, part in character:GetDescendants() do
			if part:IsA("BasePart") then
				part.AssemblyLinearVelocity = velocity
			end
		end
		return
	end
	local attachment = Instance.new("Attachment")
	attachment.Name = "KnockbackAttachment"
	attachment.Parent = root
	local push = Instance.new("LinearVelocity")
	push.Name = "Knockback"
	push.Attachment0 = attachment
	push.RelativeTo = Enum.ActuatorRelativeTo.World
	push.MaxForce = math.huge
	push.VectorVelocity = velocity
	push.Parent = root
	task.delay(PUSH_SECONDS, function()
		push:Destroy()
		attachment:Destroy()
	end)
end

--- Knock a character back (velocity in studs/s, world space). With `seconds` it ragdolls for that long
--- and flies limp; without, it's a push that keeps it standing.
function Ragdoll.knockback(character: Model, velocity: Vector3, seconds: number?)
	local root = character:FindFirstChild("HumanoidRootPart")
	if not (root and root:IsA("BasePart")) then
		return
	end
	if seconds then
		Ragdoll.ragdoll(character, seconds)
	end
	local limp = isRagdolled(character)
	local player = Players:GetPlayerFromCharacter(character)
	if player then
		-- The victim's client owns its physics: a velocity set here would be overwritten.
		Remote:FireClient(player, "launch", velocity, limp)
	else
		root:SetNetworkOwner(nil)
		Ragdoll.launch(character, velocity, limp)
	end
end

return Ragdoll
```

Client — `src/Client/Ragdoll.client.luau`:
```lua
--!strict
-- Client: the character's owner switches its Humanoid to Physics while ragdolled and applies launches
-- (a player's own client simulates its character, so these must happen here).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remote = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Ragdoll") :: RemoteEvent
local player = Players.LocalPlayer

--- Limp: every limb flies (each is its own assembly). Standing: a short LinearVelocity push, because the
--- Humanoid cancels a velocity set once.
local function launch(character: Model, root: BasePart, velocity: Vector3, limp: boolean)
	if limp then
		for _, part in character:GetDescendants() do
			if part:IsA("BasePart") then
				part.AssemblyLinearVelocity = velocity
			end
		end
		return
	end
	local attachment = Instance.new("Attachment")
	attachment.Parent = root
	local push = Instance.new("LinearVelocity")
	push.Attachment0 = attachment
	push.RelativeTo = Enum.ActuatorRelativeTo.World
	push.MaxForce = math.huge
	push.VectorVelocity = velocity
	push.Parent = root
	task.delay(0.2, function()
		push:Destroy()
		attachment:Destroy()
	end)
end

Remote.OnClientEvent:Connect(function(action: string, velocity: Vector3?, limp: boolean?)
	local character = player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not (humanoid and root and root:IsA("BasePart")) then
		return
	end
	if action == "ragdoll" then
		humanoid:SetStateEnabled(Enum.HumanoidStateType.GettingUp, false)
		humanoid:ChangeState(Enum.HumanoidStateType.Physics)
	elseif action == "restore" then
		humanoid:SetStateEnabled(Enum.HumanoidStateType.GettingUp, true)
		humanoid:ChangeState(Enum.HumanoidStateType.GettingUp)
	elseif action == "launch" and typeof(velocity) == "Vector3" and character then
		launch(character, root, velocity, limp == true)
	end
end)
```

Use in a finisher (server):
```lua
local Ragdoll = require(script.Parent.Ragdoll)
local function launch(attackerRoot: BasePart, victim: Model)
  local away = (victim:GetPivot().Position - attackerRoot.Position) * Vector3.new(1, 0, 1)
  local dir = if away.Magnitude > 0.1 then away.Unit else attackerRoot.CFrame.LookVector
  Ragdoll.knockback(victim, dir * 45 + Vector3.yAxis * 25, 0.8)
end
return launch
```

## References
- Roblox: AnimationConstraint, BallSocketConstraint, Humanoid state machine (Physics, GettingUp),
  network ownership of characters.
- Shuriken: `roblox-combat-feel` (hit timing, effects, sounds), `roblox-pvp-combat` (server authority).
