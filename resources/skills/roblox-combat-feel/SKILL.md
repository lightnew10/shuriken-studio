---
name: roblox-combat-feel
description: "Make melee combat feel good with Shuriken's workshops: animations (animation_create presets with Hit markers), effects (vfx_create) and sounds (audio_sfx / store audio) wired into client input and server-authoritative hits — responsive wind-ups, hits timed to the Hit marker, sparks and clangs at the contact point, reactions, hit-stop, trails and screen shake. Read before building or polishing any weapon, attack, block or hit."
version: 4
tags: [combat, melee, sword, unarmed, punch, kick, dodge, dash, roll, animation, vfx, sfx, gamefeel, juice, hitstop, screenshake, parry, block, trail]
roblox_systems: [Animator, AnimationTrack, KeyframeMarker, ParticleEmitter, Trail, Sound, RemoteEvent, Workspace, RunService, UserInputService, ContextActionService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [animation_presets, animation_create, animation_view, animation_check, vfx_create, vfx_play, audio_sfx, audio_add, store_search, roblox_sync_push, roblox_playtest, roblox_screenshot]
---
# Combat feel: animations, effects and sounds that land together

## Purpose
A swing feels good when four things line up on the same frame: the blade reaching the target in the
animation, the hit registering, a spark at the contact point and a sound. Shuriken makes each piece as
data and generates modules that play them by name, so gameplay code stays short:

| Piece | Make it with | Play it with (require from ReplicatedStorage.Shared) |
|---|---|---|
| Moves | `animation_create` (presets — sword: SwordSlash1–3, SwordHeavy, SwordBlock, SwordParry, SwordGuardBreak, SwordEquip, SwordIdle; unarmed: FistIdle, FistBlock, PunchJab, PunchCross, PunchHook, PunchUppercut, Kick; reactions: HitLight, HitHeavy, Land; movement: Idle, Walk, Run, Sprint, Jump, Fall, Climb; agility: Dash, DodgeRoll, DodgeLeft, DodgeRight) | `ShurikenAnimations`: `play(character, name)`, `onMarker(track, "Hit", fn)`, `markerTime(name, "Hit")`, `length(name)`, `hitStop(character, seconds)`, `stop`, `useMovement` |
| Effects | `vfx_create` (HitSpark, BlockSpark, PunchImpact, Shockwave, ImpactDust, DashBurst, SlashTrail, …) | `ShurikenEffects`: `burst(name, position)`, `trail(name, bladePart)`, `attach(name, part)`, `shake(degrees, seconds, player?)` |
| Sounds | `store_search` (Audio) + `audio_add`, or `audio_sfx` (combat presets: swing, whoosh, hit, clang, punch, block, slam) / `audio_music` | `ShurikenAudio`: `play(name, position?)`, `music(name)` |

## Preconditions
- The moves, effects and sounds you use exist (`animation_list`, `vfx_list`, `audio_list`). Create
  missing ones first; names are the contract between the pieces.
- Generated sounds are silent until uploaded (needs the user's Open Cloud key). If `audio_list` shows
  `assetId: null`, prefer a licensed Creator Store sound via `audio_add`, or say so in your result.
- Animations play in Studio immediately; the published game needs them uploaded (the module warns
  once and returns nil there — code must tolerate a nil track).

## Workflow
1. **Pick timing first.** `animation_presets` lists each move's duration and markers. The server's hit
   check happens at `Anims.markerTime(move, "Hit")` after the attack starts; the client plays the same
   move, so both agree without sending timestamps.
2. **Client (LocalScript): responsiveness.** Bind the attack with `ContextActionService` (mouse,
   gamepad and an on-screen touch button share one handler — never treat raw touches as attacks, a
   camera drag is a touch). On input, check the local cooldown, play the move and the swing sound at
   once (2D, it's the player's own action), enable the blade trail, and fire the remote with the move
   name. Never wait for the server to start the animation.
3. **Server (Script): authority.** The server owns the combo: which step comes next (continue within
   the window, restart after it), how fast swings may come (a request a little early waits for the
   current swing; more is spam), alive / not stunned / not ragdolled. The client's move name only
   says whether the two agree; when they don't, the server's step is used and the client is told to
   re-align (otherwise punches play and nothing lands). Then `task.delay(markerTime, check)`: spatial
   query in front of the attacker (GetPartBoundsInBox or a shapecast along the blade arc), filter to
   other humanoids, apply damage through ONE damage function, then at the contact point:
   `Effects.burst("HitSpark", pos)` (relayed to every client), `Audio.play("SwordHit", pos)` (3D), and
   the target's reaction `Anims.play(targetCharacter, "HitLight")`.
4. **Blocks and parries.** Holding block plays `SwordBlock` (loops) and sets a server-side state; a hit
   on a blocking target plays `BlockSpark` + a metal clang instead of damage; a parry window
   (`SwordParry`'s "Parry" marker to ~0.2 s after) staggers the attacker with `SwordGuardBreak`.
5. **Juice, in moderation.** Hit-stop: on the attacker's client, when the server confirms a hit,
   `Anims.hitStop(character, 0.06)` (heavier hits 0.1; overlapping calls extend it). Screen shake:
   from the server `Effects.shake(1.5, 0.2, victimPlayer)` for the one hit, `Effects.shake(3, 0.35)`
   (everyone) for a slam; on a client `Effects.shake(...)` shakes that player's camera. Landing a
   jump: `Land` + `ImpactDust` + a thud.
6. **Movement set.** When the sword is equipped, `Anims.useMovement(character, { idle = "SwordIdle",
   walk = "Walk", run = "Run", jump = "Jump", fall = "Fall", climb = "Climb" })`; restore the defaults
   when unequipped (call it with Roblox's ids or respawn the Animate script). Unarmed fighters use
   `FistIdle` as idle.
7. **Unarmed (battlegrounds-style M1s).** A 4-hit combo `PunchJab` → `PunchCross` → `PunchHook` →
   `PunchUppercut`, `FistBlock` held while blocking (the finisher knocks back — use skill `roblox-ragdoll-knockback`: current R15 rigs
   have AnimationConstraint joints, so Motor6D ragdoll code does nothing), `Kick` as a heavy. Same client/server split as swords;
   the jab and hook land with the LEFT hand, so hit boxes sit in front of the chest, not the right side.
8. **Dodges.** `Dash`, `DodgeRoll`, `DodgeLeft`/`DodgeRight` are the pose only: on the client play the
   move and push the character (`root.AssemblyLinearVelocity = dir * 60` once, or a LinearVelocity for
   0.2 s), send the dodge to the server, which grants i-frames (ignore hits) for the roll's duration
   and enforces the cooldown.
9. **Verify.** `animation_view` each move and judge the filmstrip like a player (a readable wind-up, the
   blade or fist landing on the Hit frame, follow-through, weight in the legs), then `animation_check` each move (the striking hand or foot must be in front at "Hit"), `vfx_play` +
   `roblox_screenshot` each effect, then a playtest: attack a dummy, watch the console for warnings
   ("isn't uploaded yet", "no effect named"), and capture a screenshot mid-swing.

## Known pitfalls
- **Trusting the client's choice of move.** Accepting any allowed move name lets a modified client send
  the finisher (or the opener, which "always restarts the combo") on repeat: a critic worked out 4.7×
  the fair damage per second and a victim stun-locked forever. The server decides the step and the
  pace; test it by firing the remote faster than a human can click.
- **Rejecting requests that arrive a hair early** (network jitter) makes fair players drop swings:
  let a request up to ~0.25 s early wait for the current swing instead.
- **Every touch is an attack** (`UserInputType.Touch` in InputBegan): mobile players punch whenever
  they turn the camera. Use `ContextActionService:BindAction(name, fn, true, …)` for the button.
- Starting the animation on the server only: the attacker sees a delay of one round trip. Play it on
  the client too (the server's copy replicates to others).
- Hit checks on `.Touched` of the blade: misses fast swings and fires on the wind-up. Use the marker
  time and a spatial query.
- Emitting particles on the server: `ParticleEmitter:Emit` doesn't replicate. `Effects.burst` on the
  server already relays to clients; don't clone emitters yourself.
- Every hit playing the same sound at the same pitch sounds robotic: generated sounds have takes and
  ±6 % pitch; for store sounds pass `pitch_variation` to `audio_add`.
- Effects that cover the screen or last > 0.5 s on every hit tire players. Keep bursts short; scale
  down (`scale` 0.6–0.8) on mobile-heavy games.
- Changing a move's timing (speed) moves its markers: re-read `markerTime` at runtime rather than
  hardcoding numbers.
- The moves are R15. If players spawn as R6 (`Humanoid.RigType` in a playtest), nothing plays and the
  module warns once: the game's avatar type must be R15 (Game Settings → Avatar) — tell the user.
  Scripts can't read that setting (`StarterPlayer.GameSettingsAvatar` needs a capability they don't
  have): check a spawned character's `Humanoid.RigType` in a playtest instead.

## Verification
- `animation_check` on every attack: the striking hand (`markers[Hit].rightHand`/`leftHand`, third
  value = forward) ≥ 1.2 studs in front (kicks: check the foot in a playtest) and no `footSink` finding.
- Playtest: one attack on a dummy produces exactly one damage event, one HitSpark near the dummy and
  one hit sound; blocking produces BlockSpark and no damage; console free of ShurikenAnimations /
  ShurikenEffects / ShurikenAudio warnings (or report which assets need uploading).
- Abuse probe (from a Client `roblox_run_luau`): fire the attack remote with the strongest move 40
  times in 2 s — the damage must not exceed what the normal combo does in 2 s; fire the combo at a
  fair pace — every step lands.

## Examples
Client — `src/Client/Combat.client.luau`:
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ContextActionService = game:GetService("ContextActionService")
local Anims = require(ReplicatedStorage.Shared.ShurikenAnimations)
local Effects = require(ReplicatedStorage.Shared.ShurikenEffects)
local Audio = require(ReplicatedStorage.Shared.ShurikenAudio)
local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local Attack = Remotes:WaitForChild("Attack") :: RemoteEvent
local Resync = Remotes:WaitForChild("AttackResync") :: RemoteEvent

local COMBO = { "SwordSlash1", "SwordSlash2", "SwordSlash3" }
local WINDOW = 0.9 -- a click within this many seconds continues the combo (the server uses the same)
local player = Players.LocalPlayer
local step, lastAttack, busyUntil = 0, 0, 0
local trail: Trail? = nil

local function blade(): BasePart?
  local tool = player.Character and player.Character:FindFirstChildOfClass("Tool")
  return tool and tool:FindFirstChild("Blade") :: BasePart?
end

local function attack()
  local now = os.clock()
  local character = player.Character
  if not character or now < busyUntil then return end
  step = if now - lastAttack < WINDOW then step % #COMBO + 1 else 1
  lastAttack = now
  local move = COMBO[step]
  busyUntil = now + (Anims.length(move) or 0.5) * 0.8
  Anims.play(character, move)
  Audio.play("SwordSwing")
  local b = blade()
  if b then
    trail = trail or Effects.trail("SlashTrail", b)
    if trail then
      trail.Enabled = true
      task.delay(0.3, function()
        if trail then
          trail.Enabled = false
        end
      end)
    end
  end
  Attack:FireServer(move)
end

-- Mouse, gamepad and touch share one handler; `true` adds an on-screen button on touch devices.
ContextActionService:BindAction("Attack", function(_, state)
  if state == Enum.UserInputState.Begin then
    attack()
  end
  return Enum.ContextActionResult.Pass
end, true, Enum.UserInputType.MouseButton1, Enum.KeyCode.ButtonR2)
ContextActionService:SetTitle("Attack", "Attack")

-- The server owns the combo; when it disagrees about the step, carry on from its step.
Resync.OnClientEvent:Connect(function(serverStep: number)
  step = serverStep
end)
```

Server — `src/Server/Combat.server.luau` (combo order and pace, hit timing and effects; damage goes
through your single damage module):
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Anims = require(ReplicatedStorage.Shared.ShurikenAnimations)
local Effects = require(ReplicatedStorage.Shared.ShurikenEffects)
local Audio = require(ReplicatedStorage.Shared.ShurikenAudio)
local Damage = require(script.Parent.Damage) -- your one entry point for damage

local Remotes = ReplicatedStorage.Remotes
local Attack = Remotes.Attack :: RemoteEvent
local Resync = Remotes.AttackResync :: RemoteEvent

local COMBO = { "SwordSlash1", "SwordSlash2", "SwordSlash3" }
local DAMAGE = { 12, 12, 20 }
local WINDOW = 0.9 -- same as the client
local EARLY = 0.25 -- a request this early waits for the current swing (jitter); earlier is spam

type State = { step: number, lastAt: number, readyAt: number, waiting: boolean }
local states: { [Player]: State } = {}

Attack.OnServerEvent:Connect(function(player, requested)
  local character = player.Character
  local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
  local humanoid = character and character:FindFirstChildOfClass("Humanoid")
  if typeof(requested) ~= "string" or not (character and root and humanoid and humanoid.Health > 0) then
    return
  end
  local state = states[player]
  if not state then
    state = { step = 0, lastAt = 0, readyAt = 0, waiting = false }
    states[player] = state
  end
  -- Pace: one swing at a time. A request a little early waits for the current swing; earlier ones, and
  -- anything arriving while one waits, are spam (letting those through starts two swings at once).
  local early = state.readyAt - os.clock()
  if early > EARLY or state.waiting then
    return
  end
  if early > 0 then
    state.waiting = true
    task.wait(early)
    state.waiting = false
  end
  local now = os.clock()
  if humanoid.Health <= 0 or character:GetAttribute("Ragdolled") or (humanoid:GetAttribute("StunnedUntil") or 0) > now then
    return
  end
  -- Order: the server decides the step. The client's move only says whether the two agree.
  local step = if now - state.lastAt <= WINDOW + 0.1 then state.step % #COMBO + 1 else 1
  local move = COMBO[step]
  if requested ~= move then
    Resync:FireClient(player, step)
  end
  state.step, state.lastAt = step, now
  state.readyAt = now + (Anims.length(move) or 0.5) * 0.8 -- the client's busy time
  local dmg = DAMAGE[step]
  task.delay(Anims.markerTime(move, "Hit") or 0.2, function()
    -- Hit during the wind-up (stunned or knocked down before the Hit marker): the swing is cancelled.
    -- StunnedUntil is set on the server as os.clock() + seconds by whatever stuns (your damage module).
    if not root.Parent or humanoid.Health <= 0 or character:GetAttribute("Ragdolled") or (humanoid:GetAttribute("StunnedUntil") or 0) > os.clock() then
      return
    end
    local params = OverlapParams.new()
    params.FilterDescendantsInstances = { character }
    params.FilterType = Enum.RaycastFilterType.Exclude
    local box = root.CFrame * CFrame.new(0, 0, -3.5)
    local hit: { [Humanoid]: BasePart } = {}
    for _, part in workspace:GetPartBoundsInBox(box, Vector3.new(6, 5, 5), params) do
      local target = part.Parent and part.Parent:FindFirstChildOfClass("Humanoid")
      if target and target.Health > 0 and not hit[target] then
        hit[target] = part
      end
    end
    for target, part in hit do
      local at = part.Position:Lerp(root.Position, 0.35)
      if target:GetAttribute("Blocking") then
        Effects.burst("BlockSpark", at)
        Audio.play("SwordClang", at)
      else
        Damage.apply(target, dmg, player)
        Effects.burst("HitSpark", at)
        Audio.play("SwordHit", at)
        Anims.play(target.Parent :: Instance, if dmg >= 20 then "HitHeavy" else "HitLight")
      end
    end
  end)
end)

Players.PlayerRemoving:Connect(function(p)
  states[p] = nil
end)
```
(Create `Remotes.Attack` and `Remotes.AttackResync` in a server bootstrap or a world builder.)
Checked in a playtest (Sept 2026): a fair combo landed 12, 12, 20; 40 finisher requests in 2 s were
held to the normal pace (one swing per 0.4 s, steps in order, the client told to re-align); a combo
whose requests arrived 0.12 s early landed every hit.

Dodge roll with i-frames — client plays the move and pushes, the server owns the invulnerability
(`src/Client/Dodge.client.luau` and a few lines in the server combat script):
```lua
--!strict
-- Client: Q rolls the way you're moving (or forward).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local Anims = require(ReplicatedStorage.Shared.ShurikenAnimations)
local Effects = require(ReplicatedStorage.Shared.ShurikenEffects)
local Dodge = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Dodge") :: RemoteEvent

local player = Players.LocalPlayer
local ready = 0

UserInputService.InputBegan:Connect(function(input, processed)
  if processed or input.KeyCode ~= Enum.KeyCode.Q or os.clock() < ready then
    return
  end
  local character = player.Character
  local humanoid = character and character:FindFirstChildOfClass("Humanoid")
  local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
  if not (character and humanoid and root) then
    return
  end
  ready = os.clock() + 1.2
  local dir = if humanoid.MoveDirection.Magnitude > 0.1 then humanoid.MoveDirection.Unit else root.CFrame.LookVector
  root.CFrame = CFrame.lookAt(root.Position, root.Position + dir)
  Anims.play(character, "DodgeRoll", { fadeTime = 0.05 })
  Effects.burst("DashBurst", root.CFrame)
  root.AssemblyLinearVelocity = dir * 55 + Vector3.new(0, root.AssemblyLinearVelocity.Y, 0)
  Dodge:FireServer()
end)
```
```lua
--!strict
-- Server: a short invulnerability window, checked by the one damage function.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Dodge = ReplicatedStorage.Remotes.Dodge :: RemoteEvent
local nextDodge: { [Player]: number } = {}

Dodge.OnServerEvent:Connect(function(player)
  local now = os.clock()
  local humanoid = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
  if not humanoid or now < (nextDodge[player] or 0) then
    return
  end
  nextDodge[player] = now + 1.1
  humanoid:SetAttribute("InvulnerableUntil", now + 0.35) -- Damage.apply skips hits while os.clock() < this
end)

Players.PlayerRemoving:Connect(function(p)
  nextDodge[p] = nil
end)
```

## References
- Shuriken docs: `docs/ARCHITECTURE.md` §11 (workshops, measured Roblox facts).
- Roblox: AnimationTrack:GetMarkerReachedSignal, Animator, WorldRoot:GetPartBoundsInBox, ParticleEmitter:Emit.
