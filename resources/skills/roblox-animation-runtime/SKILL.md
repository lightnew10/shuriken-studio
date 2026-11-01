---
name: roblox-animation-runtime
description: "Make animations play right in a Roblox game: where to play them (client or server, what replicates), priorities and joint-by-joint layering (upper-body attacks over running), weights and fades, speed and markers (Hit timing, server hit windows), root motion (animations never move the HumanoidRootPart: dashes, rolls and lunges move it with physics), loops and held poses, the Animate script's default movement, loading and track limits, R6 vs R15, uploads and ownership, IKControl polish, and a debugging checklist. Layering, fades, speed, markers and root motion measured in Studio 0.741."
version: 1
tags: [animation, animator, animationtrack, priority, blend, layer, layering, upper body, partial, marker, hit, timing, root motion, dash, roll, lunge, knockback, animate, walk, run, idle, replication, upload, ownership, ikcontrol, look at, debug, combo]
roblox_systems: [Animator, AnimationTrack, Animation, KeyframeSequence, KeyframeMarker, Humanoid, AnimationController, IKControl, LinearVelocity, ContentProvider, ContextActionService]
version_applicability: "Roblox Studio 0.741 (Sept 2026)"
required_tools: [animation_create, animation_list, animation_check, animation_view, code_query, roblox_playtest, roblox_sync_push]
---
# Animations in the game: playing, layering and wiring them right

## Purpose
A good clip still looks broken in a game when it's played on the wrong machine, at the wrong priority,
fighting the Animate script, gliding over the ground, or landing its hit at the wrong moment. This is
how Roblox really plays and layers animations (the rules marked *measured* were measured in Studio
0.741 on an R15 rig) and how to wire Shuriken's clips with the ShurikenAnimations module
(`Anims.play`, `Anims.onMarker`, `Anims.markerTime`, `Anims.length`, `Anims.hitStop`,
`Anims.useMovement`) so they read in the game. Pair it with skill roblox-combat-feel (attacks, effects,
sounds) and roblox-creature-ai (creatures on custom rigs).

## Where to play them
- **The local player's character: on the client** (a LocalScript), started straight from the input:
  no network delay, and the Animator replicates it to the server and every other player. The server
  doesn't play player moves.
- **NPCs and creatures: on the server**, which owns them, so everyone sees the same thing. An NPC
  animated from one client shows only on that client.
- Use the Humanoid's (or AnimationController's) existing Animator. `Anims.play` finds it, and only
  creates one when there is none (for NPCs do that on the server).
- **Damage is the server's call.** The client plays the move and asks. The server works out when the
  hit happens from the clip (`Anims.markerTime(name, "Hit")`) and checks range and cooldown then. A
  client's marker event only drives effects and sounds.

## Priorities and layering (*measured*)
Core < Idle < Movement < Action < Action2 < Action3 < Action4. Core is the lowest.
- **Joint by joint**: a higher-priority track overrides only the joints it keys. An attack that keys
  only the torso, head and arms plays over a run, and the legs keep running (*measured*: the arm came
  from the attack and the leg from the walk).
  - Make these with `animation_create {preset, body_part = "upper"}` (or Body: Upper on the Animation
    page) and play them at Action. Attacks, blocks, casts, reloads and throws on the move all work
    this way.
- **Whole-body moves** (lunges, spins, slams, rolls) take the legs too. Play them when grounded, and
  slow or lock movement for their length, or the legs pose while the body slides.
- **Same priority blends by weight**: two Movement tracks at weight 1 average their poses. At 3 to 1
  the result is 75/25 (*measured*: 73° from 20° and 90°). Two attacks at the same priority fighting
  look mushy: stop the old one, or give the new one a higher priority.
- **A higher-priority track at weight 0.5 blends 50/50** with what's under it (*measured*). Use
  `AdjustWeight` for partial effects: a lean into a turn, a flinch that doesn't take over.
- Where things go:
  - Idle: breathing, fidgets.
  - Movement: walk, run, jump, fall.
  - Action: attacks and abilities.
  - Action2: hit reactions over attacks.
  - Action3: stuns and grabs.
  - Action4: deaths and cutscene moments.

## Fades, speed, loops, holds
- `Play(fadeTime, weight, speed)`: the fade defaults to 0.1 s (*measured*: fully in by 0.15 s).
  - Snappy attacks use 0.03–0.06; idle and walk changes 0.2–0.3.
  - `Stop(fadeTime)` fades out the same way.
- **Combos**: start the next move with a short fade before stopping the last, so the poses cross-blend
  instead of popping. Open the combo window on a marker (e.g. "ComboWindow") rather than at the end.
- `AdjustSpeed(s)` changes playback speed: at 2 the clip runs twice as fast, and markers still fire
  (*measured*). For a walk, set the speed so the feet don't slide at the character's WalkSpeed.
  Custom-rig and Kiln gaits report the groundSpeed they were made for: speed = WalkSpeed / groundSpeed.
- `Looped` overrides the clip's own loop setting (*measured*: `Looped = false` stops a looping clip at
  its end). A non-looping track ends on its own and fires `Stopped` (*measured*).
- **Holding a final pose** (a death, a guard, a victory pose): freeze it deliberately. Put a marker
  near the end, and there call `track:AdjustSpeed(0)`. Don't rely on what remains after the track
  stops, because the idle or other tracks take the joints back.
- **Hit-stop**: `Anims.hitStop(character, 0.06)` freezes the attacker's tracks for a beat on impact.

## Root motion: animations never move the character (*measured*)
A clip that moves the LowerTorso 5 studs forward leaves the HumanoidRootPart exactly where it was. The
visible body leaves its collision capsule while the camera and hitbox stay behind, and it snaps back
when the track ends. So:
- Walks and runs are in place. The Humanoid moves the character; the clip only animates it (Kiln
  gaits: `in_place`).
- **Dashes, rolls, lunges and knockbacks** keep the clip in place and move the HumanoidRootPart with
  physics for the clip's length. Use a `LinearVelocity` with `ForceLimitMode = PerAxis` and
  `MaxAxesForce` only on X and Z, so gravity still works: velocity = direction × distance ÷ duration.
  For a burst, `ApplyImpulse`.
- Where to push it: the player's own character from the client (it owns its physics); NPCs from the
  server.

## Default movement: the Animate script
- Every player character has an `Animate` LocalScript that plays idle, walk, run, jump, fall, climb
  and swim from the Animation objects under it. To change them, replace those animations:
  `Anims.useMovement(character, { idle = "...", walk = "...", run = "..." })` on CharacterAdded. The
  Animate script picks up the change. Don't play your own walk on top, or both fight over the legs.
- Shuriken's character clips are R15. Set the game's avatar type to R15 (Game Settings > Avatar);
  `Anims` warns when a character is R6.

## Loading, limits, uploads
- A track's `Length` is 0 until the animation has loaded (*measured* right after `LoadAnimation`).
  Take timings from the clip (`Anims.length`, `Anims.markerTime`), not from a fresh track.
- Load once per character and reuse the track (`Anims` caches per Animator). An Animator refuses more
  than 256 loaded tracks, and loading on every attack leaks.
- Preload a character's animations when it spawns (`ContentProvider:PreloadAsync` on the Animation
  objects) so the first swing doesn't hitch.
- **Studio plays clips from their KeyframeSequence** (registered on the fly, with no upload). Those ids
  work only in Studio.
  - A live game plays uploaded animation assets that the game's owner owns: the user, or the group if a
    group owns the game.
  - `animation_upload` uploads with the user's Open Cloud key. "It plays in Studio but not in the live
    game" is nearly always a missing upload or the wrong owner.

## Runtime polish: IKControl
- `IKControl` (Type LookAt, Position, Rotation or Transform; ChainRoot, EndEffector, Target, Pole,
  Weight, and SmoothTime, 0.05 by default) adjusts a chain after the animations. Uses:
  - heads and torsos that track a target: LookAt with ChainRoot UpperTorso and EndEffector Head,
    Weight 0.3–0.7;
  - a hand kept on a two-handed weapon;
  - feet planted on slopes: Position on each leg chain toward a raycast hit.
- It solves in the running game's animation step, not in Edit. Stepping animations in Edit left the
  head unmoved (*measured*), so check IK in a playtest.

## Debugging: "the animation doesn't play or looks wrong"
1. **Nothing plays.** Check whether `Anims.play` returned nil, and read its warning. Causes: an R6
   character, a clip not built in this place (animation_list), or, outside Studio, one not uploaded
   or owned by someone else.
2. **Plays for me, not for others.** An NPC animated from a client, or a second Animator made on the
   client.
3. **Half of it plays, or it jitters.** Another track at the same or a higher priority keys the same
   joints: the Animate script's walk, an idle played at Action priority, a move that was never
   stopped. List what's playing with `Animator:GetPlayingAnimationTracks()` and check priorities.
4. **Feet slide.** The character moves at a different speed than the clip's feet; adjust `AdjustSpeed`
   or WalkSpeed.
5. **The body snaps back after a dash.** The clip has root motion. Make it in place and move the body
   with physics.
6. **The hit lands early or late.** The server uses `Anims.markerTime`, not a guess; effects use
   `Anims.onMarker` on the client.
7. **Pops between moves.** A fade of 0, or poses too far apart. Use 0.05–0.15 fades, or add a
   transition key.

## Examples
Client (StarterPlayerScripts): an attack on the move (an upper-body clip over the run), and a dash that
moves the body with physics while an in-place clip plays.
```lua
--!strict
local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Anims = require(ReplicatedStorage.Shared.ShurikenAnimations)

local player = Players.LocalPlayer
local remotes = ReplicatedStorage:WaitForChild("Remotes")
local attackRemote = remotes:WaitForChild("Attack") :: RemoteEvent

local DASH_DISTANCE = 18
local busy = false

local function rootOf(character: Model): BasePart?
	local root = character:FindFirstChild("HumanoidRootPart")
	return if root and root:IsA("BasePart") then root else nil
end

-- "SlashOnTheMove" was made with animation_create {preset = "SwordSlash1", body_part = "upper"}: at
-- Action priority it keys only the torso, head and arms, so the legs keep running under it.
local function attack(_: string, state: Enum.UserInputState): Enum.ContextActionResult
	local character = player.Character
	if state ~= Enum.UserInputState.Begin or busy or not character then
		return Enum.ContextActionResult.Pass
	end
	local track = Anims.play(character, "SlashOnTheMove", { fadeTime = 0.05 })
	if not track then
		return Enum.ContextActionResult.Pass
	end
	busy = true
	attackRemote:FireServer() -- the server times the hit from the clip itself
	Anims.onMarker(track, "Hit", function()
		-- sparks and the swing sound here; damage is the server's call
	end)
	track.Stopped:Once(function()
		busy = false
	end)
	return Enum.ContextActionResult.Sink
end

-- "Dash" is an in-place clip; the HumanoidRootPart is pushed for exactly its length.
local function dash(_: string, state: Enum.UserInputState): Enum.ContextActionResult
	local character = player.Character
	local root = if character then rootOf(character) else nil
	if state ~= Enum.UserInputState.Begin or busy or not character or not root then
		return Enum.ContextActionResult.Pass
	end
	local length: number = Anims.length("Dash") or 0.35
	busy = true
	Anims.play(character, "Dash", { fadeTime = 0.05 })
	local flat = root.CFrame.LookVector * Vector3.new(1, 0, 1)
	local direction = if flat.Magnitude > 0.01 then flat.Unit else Vector3.new(0, 0, -1)
	local attachment = Instance.new("Attachment")
	attachment.Parent = root
	local push = Instance.new("LinearVelocity")
	push.Attachment0 = attachment
	push.ForceLimitMode = Enum.ForceLimitMode.PerAxis
	push.MaxAxesForce = Vector3.new(1e6, 0, 1e6) -- no vertical force: gravity still works
	push.VectorVelocity = direction * (DASH_DISTANCE / length)
	push.Parent = root
	task.delay(length, function()
		push:Destroy()
		attachment:Destroy()
		busy = false
	end)
	return Enum.ContextActionResult.Sink
end

ContextActionService:BindAction("Attack", attack, true, Enum.UserInputType.MouseButton1, Enum.KeyCode.ButtonR2)
ContextActionService:BindAction("Dash", dash, true, Enum.KeyCode.Q, Enum.KeyCode.ButtonB)
```

Server (ServerScriptService): the hit happens when the clip says, with the server's own checks.
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Anims = require(ReplicatedStorage.Shared.ShurikenAnimations)

local attackRemote = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Attack") :: RemoteEvent

local RANGE = 7
local DAMAGE = 20
local lastAttack: { [Player]: number } = {}

local function rootOf(character: Model?): BasePart?
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	return if root and root:IsA("BasePart") then root else nil
end

attackRemote.OnServerEvent:Connect(function(player: Player)
	local length: number = Anims.length("SlashOnTheMove") or 0.5
	local now = os.clock()
	if now - (lastAttack[player] or 0) < length * 0.9 then
		return -- faster than the move can be played
	end
	lastAttack[player] = now
	local hitAt: number = Anims.markerTime("SlashOnTheMove", "Hit") or length * 0.5
	task.delay(hitAt, function()
		local root = rootOf(player.Character)
		if not root then
			return
		end
		for _, other in Players:GetPlayers() do
			local target = if other ~= player then other.Character else nil
			local targetRoot = rootOf(target)
			local humanoid = if target then target:FindFirstChildOfClass("Humanoid") else nil
			if targetRoot and humanoid and humanoid.Health > 0 then
				local offset = targetRoot.Position - root.Position
				-- In reach and in front of the attacker at the moment the swing lands.
				if offset.Magnitude <= RANGE and root.CFrame.LookVector:Dot(offset.Unit) > 0.3 then
					humanoid:TakeDamage(DAMAGE)
				end
			end
		end
	end)
end)

Players.PlayerRemoving:Connect(function(player: Player)
	lastAttack[player] = nil
end)
```

## Verify
- `animation_view` for the pose. `animation_check` for the clip on a real rig in Studio.
- A playtest: move and attack together (the legs keep running), dash (the body and the camera stay
  together, no snap-back), and watch the hit land on the Hit frame.
