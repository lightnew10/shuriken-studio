---
name: roblox-creature-ai
description: "PvE creatures on custom rigs (rig_build templates: no Humanoid) in Roblox: spawning from ReplicatedStorage.ShurikenRigs, a server-side state machine (idle, patrol, chase, attack, hit, dead), physics movement with AlignPosition/AlignOrientation matched to the walk clip's ground speed, ground following, attacks that land on the clip's Hit marker from its attachment points (stinger, bite, claw), hit reactions, death that holds its pose, health, networking and performance. Verified pattern (server-owned movement and replicated animation) with the code to start from."
version: 2
tags: [npc, mob, enemy, creature, monster, boss, ai, pve, spawn, chase, patrol, attack, aggro, pathfinding, wave, dungeon]
roblox_systems: [AnimationController, Animator, AlignPosition, AlignOrientation, PathfindingService, Attachment]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [rig_build, animation_presets, animation_list, animation_check, roblox_playtest]
---
# PvE creatures on custom rigs

## Purpose
Enemies and creatures that move with weight and hit where they look like they hit. The rig comes from
`rig_build` (skill "blender-creatures"), its clips from Kiln's animation (`kiln_clip`, `kiln.anim`, or
Kiln's copilot: they arrive as `<Model><Clip>`, e.g. GrieverWalk); this skill is the game side: spawn,
think, move, attack, react, die. Players stay R15 (PvP and the player's own moves
use the R15 skills); creatures are their own rigs.

## What you start from
- `ReplicatedStorage.ShurikenRigs.<Model>`: a Model with an invisible **HumanoidRootPart** (its
  PrimaryPart, anchored in the template), invisible segment parts named like the joints, the MeshParts
  (massless, CanCollide off, CanQuery on — raycasts and overlap queries find them), Attachments at its
  named points (`Stinger_Tip`, `Bite_Point`, `Hitbox_Body`, …) and an **AnimationController + Animator**.
  No Humanoid: nothing moves it but you.
- Its clips (`animation_list`, `animation_presets {rig}`), played with the ShurikenAnimations module:
  `Anims.play(creature, "SkitterWalk")` returns the AnimationTrack; `Anims.onMarker(track, "Hit", fn)`.
  Priorities as generated: idle `Idle`, walk/run/slither `Movement`, attacks `Action`, hit `Action2`,
  death `Action4`, so a hit plays over an attack and death over everything.
  Events are KeyframeMarkers: `Hit` (and `Strike`) on attacks, `Step_<leg>` on each footfall of a gait,
  `Impact` on a hit reaction, `Dead` when a death lands.
- The walk/run clip's **speed** (studs/s: `speed` on Kiln clips in animation_list and on the Animation
  page, `groundSpeed` from animation_check): the speed its planted feet travel. Move at that speed, or
  scale the track: `track:AdjustSpeed(speed / clipSpeed)`.

## Verified pattern: server-owned physics movement (checked in a playtest)
Unanchor the root, hold and steer it with AlignPosition + AlignOrientation, and give the server
ownership: it walks at MaxVelocity, keeps its height (everything is CanCollide off, the constraint
holds it up), and the animation played on the server's Animator replicates to every client.
```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Anims = require(ReplicatedStorage.Shared.ShurikenAnimations)

local function spawnCreature(modelName: string, at: CFrame)
	local c = ReplicatedStorage.ShurikenRigs[modelName]:Clone()
	c:PivotTo(at)
	c.Parent = workspace.Creatures
	local hrp = c.HumanoidRootPart
	local att = Instance.new("Attachment")
	att.Parent = hrp
	local ap = Instance.new("AlignPosition")
	ap.Mode = Enum.PositionAlignmentMode.OneAttachment
	ap.Attachment0 = att
	ap.MaxForce = math.huge
	ap.MaxVelocity = 8 -- studs/s: its walk speed
	ap.Responsiveness = 50
	ap.Position = hrp.Position
	ap.Parent = hrp
	local ao = Instance.new("AlignOrientation")
	ao.Mode = Enum.OrientationAlignmentMode.OneAttachment
	ao.Attachment0 = att
	ao.MaxTorque = math.huge
	ao.Responsiveness = 30
	ao.CFrame = hrp.CFrame.Rotation
	ao.Parent = hrp
	hrp.Anchored = false
	hrp:SetNetworkOwner(nil) -- the server simulates it; clients only watch
	c:SetAttribute("Health", 100)
	c:SetAttribute("MaxHealth", 100)
	return { model = c, hrp = hrp, ap = ap, ao = ao, home = at.Position }
end
```
- **Height over the ground**: the root sits at its rest height above the feet. Measure it once from
  the template (`hrp.Position.Y` minus the lowest MeshPart bottom) and raycast down at each target
  (`workspace:Raycast(target + Vector3.new(0, 10, 0), Vector3.new(0, -40, 0), params)`, excluding
  creatures) to keep `ap.Position.Y = hit.Position.Y + height` on slopes and steps.
- **Facing**: its front is −Z, so `ao.CFrame = CFrame.lookAt(hrp.Position, flatTarget).Rotation` with
  the target at the root's height (a flat look, no pitching into the ground).
- **Walls**: nothing collides, so don't steer straight through geometry: use PathfindingService for
  anything but open arenas (`PathfindingService:CreatePath({AgentRadius = …, AgentHeight = …})`,
  feed `ap.Position` waypoint by waypoint), and push creatures apart from each other a little.

## The brain (server)
One Heartbeat loop for every creature; decisions 5–10 times a second, staggered (don't re-think every
creature on the same frame).
- **idle / patrol**: idle clip; wander between points near `home`.
- **chase**: nearest player within aggro range (and line of sight by raycast); walk clip playing,
  `track:AdjustSpeed(ap.MaxVelocity / clipSpeed)`; give up past a leash distance from home.
- **attack**: in range and off cooldown → stop (`ap.Position = hrp.Position`), face the target, play the
  attack; `Anims.onMarker(track, "Hit", strike)`; back to chase when the track ends.
- **hit**: on damage, play the hit clip (it plays over the attack; a heavy hit may cancel the attack).
- **dead**: see below. Keep state on the creature table, and its health in attributes (they replicate:
  health bars read them on the client).

## Attacks that land where they look
At the Hit marker, take the strike point from the rig, not from a guess:
```lua
local function strike(c, radius: number, damage: number)
	local point = c.model:FindFirstChild("Stinger_Tip", true) -- or Bite_Point, Claw_R …
	local params = OverlapParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { workspace.Creatures }
	local hitHumanoids = {}
	for _, part in workspace:GetPartBoundsInRadius(point.WorldPosition, radius, params) do
		local hum = part.Parent and part.Parent:FindFirstChildOfClass("Humanoid")
		if hum and not hitHumanoids[hum] and hum.Health > 0 then
			hitHumanoids[hum] = true
			hum:TakeDamage(damage)
		end
	end
end
```
animation_check (and animation_list {name}'s metrics) list every attachment's position at each marker:
the radius and range come from those numbers (a sting that lands 2.2 studs in front of the root needs
the player within about that distance when the attack starts). Effects and sounds go on the same
marker at the same point (skill "roblox-combat-feel").

## Death
```lua
for _, t in c.model.AnimationController.Animator:GetPlayingAnimationTracks() do t:Stop(0.1) end
c.ap.Position = c.hrp.Position
local track = Anims.play(c.model, "SkitterDeath")
Anims.onMarker(track, "Dead", function() track:AdjustSpeed(0) end) -- hold the final pose
task.delay(4, function() c.model:Destroy() end) -- after a fade (tween the MeshParts' Transparency)
```
The death clip already lowers the body onto the ground and folds the legs.

## Players hitting creatures
Their MeshParts answer raycasts and overlap queries: a weapon's hit test finds the creature with
`part:FindFirstAncestorWhichIsA("Model")` carrying the `ShurikenRig` attribute; damage its Health
attribute on the server (validate range and cooldown there, skill "roblox-networking-security").

## Performance
- Few, meaningful creatures: every one is a simulated assembly and a set of MeshParts (the template
  has one per segment and material). Cap the live count; despawn far from players.
- With StreamingEnabled, set the creature Model's `ModelStreamingMode = Atomic` so a rig never arrives
  half built.
- Don't raycast every frame for every creature: decisions at 5–10 Hz, ground height when the target
  changes.

## Verify
A playtest: spawn one, watch it walk (feet shouldn't skate: speed matches the clip's speed), let it attack a
player standing at the Hit distance (it takes damage exactly on the strike), hit it, kill it (it holds
its death pose, then goes). `animation_check {name}` measures the clips on the rig in Studio.
