---
name: roblox-vfx
description: "Visual effects for Roblox the way a senior VFX artist makes them, with Shuriken's effects workshop and runtime. Read it before making or wiring any effect, ability, projectile, telegraph, aura, weather, ambience, on-screen combat FX or cutscene: the anatomy of an effect (anticipation, impact, follow-through, layers), timing, colour and value, shape language, readability in a fight; effects as timelines (vfx_create tracks: particles, flash, ring, slash, shell, circle, ribbon, beam and lightning, light, sound, shake, hit-stop, highlight, screen, debris, decal, spawn) measured with vfx_measure; textures from parameters (vfx_texture: smoke flipbooks, fire, sparks, rings, slashes, lightning, magic circles; alpha without dark fringes); the Roblox techniques (flipbooks, emission shapes, Beam curves, Trails, LightEmission, LightInfluence and Brightness under Bloom, ZOffset, Highlight, light flashes); the runtime modules (ShurikenEffects, ShurikenCurves motion math with arc-length Bezier and Catmull-Rom paths, ShurikenScreenFX through Motion, ShurikenCutscene, ShurikenWeather); recipes for elemental abilities, projectiles, slashes and combos, area attacks, buffs, hit reactions and damage numbers; environment effects (section 12, for the environment artist too); cutscenes; and the performance rules."
version: 1
tags: [vfx, effects, particles, ability, skill, combat, projectile, slash, explosion, impact, telegraph, aura, buff, elemental, fire, ice, lightning, wind, earth, shadow, holy, energy, beam, trail, flipbook, texture, bezier, catmull-rom, lerp, cutscene, camera, weather, rain, snow, fog, fireflies, ambience, damage-numbers, screenshake, hitstop, juice, performance]
roblox_systems: [ParticleEmitter, Beam, Trail, Attachment, PointLight, SpotLight, Highlight, Decal, BillboardGui, ScreenGui, Lighting, BloomEffect, Workspace, RunService, TweenService, CollectionService, ContextActionService, StarterGui, GuiService, UserGameSettings, RemoteEvent]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [vfx_create, vfx_measure, vfx_texture, vfx_play, vfx_cutscene, vfx_runtime, vfx_list, roblox_screenshot, roblox_playtest, roblox_sync_push]
---
# VFX for Roblox: effects that read, land on the beat and stay cheap

## Purpose
An effect is a sentence the game says to the player: *something hit, it hurt, it is over*. A good one reads
in a fraction of a second from across a busy fight, lands on the exact frame of the animation, and costs
almost nothing. Shuriken makes effects as data and plays them with generated modules, so you design and
the runtime does pooling, budgets, culling and cleanup. Sections 1-5 are the craft, 6-7 the Roblox facts,
8-12 the runtime and recipes, 13-14 the rules and the checks. Facts marked [check in Studio] are what the
code assumes but nobody has confirmed in a playtest yet; everything else is Roblox's documented behaviour.

| Make it with | Play it with (`require(ReplicatedStorage.Shared.<Module>)`) |
|---|---|
| `vfx_create` (a spec: emitters + timeline `tracks`; `example: "FireballImpact"` to start from a worked one; `name` + `set` to change one; `from` + `to` for a colour variant). Its result has the effect's picture | `ShurikenEffects`: `play`, `attach`, `trail`, `beam`, `projectile` + `flightTime`, `lightning`, `chain`, `telegraph`, `flash`, `shake`, `hitStop`, `screen`, `quality`/`setQuality`, `preload`, `stats` |
| `vfx_measure` (cost, readability and the picture, offline: no Studio) | `ShurikenCurves`: lerp/slerp, easing, paths at even speed, arcs, spirals, lobs, homing, noise |
| `vfx_texture` (textures from parameters, uploaded) | `ShurikenScreenFX`: damage numbers, hit marker, flash, vignette, speed lines, banners, combo (through `Motion`) |
| `vfx_cutscene` (cutscenes as data) | `ShurikenCutscene`: `play`, `intro`, `onSignal` |
| `vfx_runtime` (the modules without making an effect) | `ShurikenWeather`: `set`, `zone`, `wind`, `gust` |

Effects are client-side: the server decides (who was hit, when), calls `Effects.play(...)` once, and every
client draws it. `ParticleEmitter:Emit` does not replicate, so never emit on the server yourself.

## 1. Anatomy of an effect
Every strong effect has three beats, each made of layers:
1. **Anticipation** (0.1-0.6 s before the payoff; zero for a plain hit): energy gathering inward (a
   shrinking `circle`, particles with negative speed toward the centre, a dimming light), a telegraph on
   the ground. It tells the player *something is coming* and makes the release feel bigger.
2. **Impact** (frames 0-4, about 0.07 s): the brightest, simplest shape on the first frame: a `flash`
   (white-hot, 0.08-0.12 s), a `ring` or `circle` snapping out with an ease-out, a light flash, a short
   `shake`, `hitstop` on the hit model. Nothing ramps in here: it is there on frame 0.
3. **Follow-through** (0.3-1.5 s): energy leaving: sparks and debris thrown out and falling, smoke rising
   and thinning, embers, a scorch `decal` that fades over seconds. Slower, darker, less saturated, more
   transparent than the impact.

Layers (most effects use three to five): **core** (the flash or shape that says what happened), **form**
(the shell, ring, slash or beam that gives its silhouette), **energy** (sparks, streaks, motes: speed and
direction), **secondary** (debris, smoke, dust: weight and aftermath), **light** (a light flash and the
screen). Read `analysis.timeline` from `vfx_create`: if two layers do the same job, cut one.

```json
{ "name": "FireballImpact", "kind": "burst", "tracks": [
  { "type": "flash", "duration": 0.1, "size": [4, 9], "color": ["#ffffff", "#ffe2a0"], "brightness": 3 },
  { "type": "shell", "shape": "sphere", "duration": 0.35, "size": [6, 6, 6], "scale": { "keys": [[0, 0.3], [0.3, 1], [1, 1.2]], "ease": "quadOut" }, "color": ["#fff4c2", "#ff9a2e", "#c2410c"], "transparency": { "keys": [[0, 0], [0.5, 0.3], [1, 1]] } },
  { "type": "ring", "at": 0.02, "duration": 0.3, "radius": { "keys": [[0, 1], [1, 14]], "ease": "quartOut" }, "color": "#ffd28a" },
  { "type": "particles", "name": "Smoke", "at": 0.08, "texture": "rbxasset://textures/particles/explosion01_smoke_main.dds", "color": ["#a39a92", "#8a8178"], "size": [3, 9], "transparency": [0.55, 0.75, 1], "lifetime": [1.2, 1.8], "speed": [4, 9], "spread": [180, 180], "emit": 10, "drag": 2, "acceleration": [0, 4, 0], "lightInfluence": 1 },
  { "type": "light", "duration": 0.45, "color": "#ffb454", "brightness": { "keys": [[0, 8], [1, 0]], "ease": "quadOut" }, "range": 22 },
  { "type": "shake", "magnitude": 2.2, "duration": 0.35, "radius": 70 } ] }
```
(The whole worked example, with debris and a scorch mark: `vfx_presets {preset: "FireballImpact"}`.)

## 2. Timing
- Count in frames at 60 fps (one frame = 0.017 s). A hit's impact is frame 0, its whole life about 1 s;
  repeated hits under 0.5 s of visible motion, or the next one is lost in the last.
- **Ease out** for anything released (rings, slashes, debris: fast then slow: `quartOut`, `expoOut`).
  **Ease in** for gathering (anticipation: `quadIn`). **Back/elastic** only for magical pops and UI.
  Linear motion looks mechanical; `sineInOut` for camera moves.
- Holds sell weight: a flash that holds 2 frames at full, a hit-stop of 0.04-0.1 s on both fighters.
- Stagger layers by 1-3 frames (`at`: 0, 0.02, 0.05): everything starting together reads as one blob.
- Time effects to animation markers (`Anims.markerTime(move, "Hit")` on the server); the effect is the
  marker's consequence, never a guess.

## 3. Colour and value
- **Value first.** The impact is the brightest thing on screen, the follow-through darker. One white-hot
  core per effect; colour lives at the edges and in the fall-off (`color: ["#ffffff", "#ffd28a", "#ff7a1a"]`).
- **Hue families**, two or three hues: a key colour, a hotter highlight and a darker accent (fire: white →
  yellow → orange → deep red; ice: white → pale cyan → deep blue). Complements read as contrast: violet
  shadow magic on warm ground.
- **Glow is additive.** `lightEmission: 1` adds the particle onto what is behind it: bright colours glow,
  dark colours vanish. Smoke, dust and soot are `lightEmission: 0` with `lightInfluence: 1`, so the scene's
  light shades them.
- **Smoke is light and see-through.** Mid to light grey (`#8a8178` and lighter) starting at transparency
  ≥ 0.55. Dark colours at low transparency on big overlapping puffs stack into an opaque black blob (a real
  mech build's explosion did; `vfx_measure` warns "opaque black blob"). Dark smoke reads at the edges of
  a light one, never as its body.
- **Glow needs something darker behind it.** Added onto a bright sky or sunlit grass, a pale glow has
  little left to add: cyan sheaths vanish against the sky, cyan over grass turns green-white, and glows
  piled on each other burn out to white (all three were found in a real build, in Studio, after the fact).
  The contact sheet shows the effect by day and in the dark, and `analysis.look` says how much of each
  layer shows by day, against a bright sky and in the dark, and how much is burnt to white. Give the form
  a layer that isn't additive (`lightEmission` 0-0.4, a deeper colour, a dark rim) and keep white for the
  small hot core.
- **Bloom**: Lighting's Bloom only blooms pixels brighter than its Threshold. Shuriken keeps a placed
  Bloom gentle (intensity ≤ 0.5, threshold ≥ 1.8), so a glow needs `brightness` above 1 (2-4 for cores) and
  `lightInfluence` below 1 to reach it. Studio's background window doesn't draw Bloom at Automatic editor
  quality: judge glow in a playtest.
- Team and status colours stay the game's (red danger, green heal, gold reward); an enemy's attack never
  uses the player's team colour.

## 4. Shape language
Round and soft reads friendly, magical, healing; sharp and angular reads dangerous, fast, cold; streaks
read speed and direction; billows read mass. Pick the shape, then the texture that has it.

| Element | Shapes | Textures and tracks | Colour | Motion |
|---|---|---|---|---|
| Fire | billows, licks, embers | `fire` flipbook, `smoke`, `spark` | white → yellow → orange → red | rises, flickers (`light` flicker) |
| Ice | shards, crystals, frost | `wedge` shell (Ice material), `debris` shape wedge, `snow` | white → pale cyan → deep blue | snaps, then still; slow mist |
| Lightning | zigzags, forks, flashes | `beam` with `jag`, `electric` flipbook (Random), `flash` | white core, blue/violet glow | instant, re-shapes 15-25×/s, gone in 0.3 s |
| Wind | arcs, swirls, streaks | `ribbon` on `spiral`/`arc`, `wind` streaks | white, pale cyan, low alpha | sweeping, curved, ease out |
| Earth | chunks, cracks, dust | `debris` (Slate), `decal` cracks, `dust` | browns, tan dust | heavy, falls, bounces once |
| Shadow | tendrils, voids, smoke | dark `shell` (SmoothPlastic, not Neon), violet rim `circle`, `smoke` | black core with violet/magenta edges | slow in, sudden burst; dark needs a bright rim to read |
| Holy | pillars, rays, rings | `pillar` shell, `circle`, `star`, motes | white, gold, warm | rises, radiates, soft |
| Energy | orbs, beams, rings | `energy` texture, `beam` scrolling, `ring` | one saturated hue + white | pulses, scrolls |

## 5. Readability in combat
- **Silhouette**: an effect must read as a shape at 60 studs; detail is for close-ups. Test from the
  gameplay camera, not from 6 studs away.
- **Never cover the target.** `vfx_measure`'s coverage is the share of a 70° view filled from 20 studs
  (an area effect that reaches further is judged from where it fits the view) and its centre opacity;
  keep hits under ~25 % coverage and centres under ~80 % opaque. Nothing sits on the crosshair longer
  than a flash.
- **Far away, particles are not drawn.** At automatic graphics quality Roblox stops drawing particles
  somewhere between 200 and 400 studs from the camera (measured in real builds). An effect meant to be
  seen across a map (a beacon, a far explosion, a star where something landed) needs a layer that isn't
  particles: a `shell` (a part or mesh), a `light`, a `beam` or `circle`; for a marker at 500+ studs a
  BillboardGui was the one thing still drawn. `vfx_measure` warns when a far-reaching effect is particles only.
- **Telegraphs** (`Effects.telegraph`): a bright rim, a faint area and a fill that grows until the hit
  lands; the rim pulses. Danger is red/orange for enemies; the fill time is the dodge window (0.6-1.5 s).
- **Consistency**: the same hit always looks the same; the bigger the damage the bigger the effect, never
  the other way round. Big effects for big moments only.
- **Flashes**: full-screen flashes are capped at 60 % by ShurikenScreenFX and can be turned off
  (`Screen.setFlashes(false)`), and shake is off under Reduce Motion: give players both settings.

## 6. Roblox techniques (the facts)
- **ParticleEmitter**: `Texture` multiplied by `Color` (ColorSequence) over each particle's life with `Size`
  and `Transparency` (NumberSequences: up to 20 keypoints, first at 0, last at 1). `Orientation`:
  FacingCamera, FacingCameraWorldUp, VelocityParallel (streaks), VelocityPerpendicular (flat across its
  motion: emit up at speed 0.01 and it lies on the ground: rings, shockwaves, the `ring` and `slash`
  tracks). `Rotation`/`RotSpeed` in degrees. `Drag` slows particles exponentially; `Acceleration` is your
  gravity (particles have none by default). `LockedToPart` moves particles with their attachment (auras,
  a projectile's core); otherwise they stay where they were born (a projectile's wake). `ZOffset` shifts
  the drawn position toward the camera in studs (a flash in front of its smoke). `Squash` (-3..3) doubles
  per unit: negative makes the quad longer along its up axis and narrower (-3: eight times as long, an
  eighth as wide: a thin streak with VelocityParallel), positive flattens it [measured on Studio screenshots]. `TimeScale` slows the simulation (slow motion). `WindAffectsDrag` makes particles drift
  with `workspace.GlobalWind` (needs Drag > 0). Emitters parented to a part emit from its `Shape` (Box,
  Sphere, Cylinder, Disc; `ShapeStyle` Volume or Surface; `ShapeInOut`); on an attachment from a point.
- **Flipbooks**: a texture split into `FlipbookLayout` Grid2x2, Grid4x4 or Grid8x8 cells; `FlipbookMode`
  Loop or PingPong at `FlipbookFramerate`, Random frames, or OneShot (once over each particle's own
  lifetime: give OneShot particles equal lifetimes); `FlipbookStartRandom` desyncs loops. Use square,
  power-of-two textures with each frame inside its cell (what `vfx_texture` makes; frames that touch
  their cell border bleed into each other in mipmaps).
- **Beam**: a strip between `Attachment0` and `Attachment1`, a cubic Bezier whose control points are
  Attachment0 + its X axis × `CurveSize0` and Attachment1 − its X axis × `CurveSize1` (the `beam` track's
  `bend` sets these for you); `Segments` smooths the curve; `Width0`/`Width1`; `Color` and `Transparency`
  run along its length; `Texture` with `TextureMode` (Stretch, Wrap, Static), `TextureLength` and
  `TextureSpeed` (scrolling: energy flowing, waterfalls); `FaceCamera` turns its width toward the camera
  (lasers, light shafts). Four quarter-circle beams make a crisp ring (`circle` track, telegraph rims).
- **Trail**: a ribbon between two attachments drawn as their part moves; `Lifetime`, `MinLength`,
  `WidthScale` along it, `FaceCamera`, `LightEmission`. It records one segment per frame, so a 0.1 s
  swing is a few straight segments: fast slashes look smoother as a `slash` particle, slower sweeps as a
  `ribbon` along an arc.
- **LightEmission** 0..1 (1 = additive), **LightInfluence** 0..1 (0 = ignores the scene's light), and
  **Brightness** (particles, beams, trails: lifts the light they give while LightInfluence is below 1;
  above 1 it reaches Bloom).
- **Lights**: `PointLight`/`SpotLight` `Brightness` and `Range` (at most 60 studs) as a flash that dies in
  0.1-0.5 s; `Shadows` off for effect lights (they cost the most, especially in Future lighting).
- **Highlight**: a fill and outline over a model (`FillTransparency`, `OutlineTransparency`,
  `DepthMode`); Roblox draws at most 31 at once (the runtime keeps 28), so it is a hit flash, not a
  status that stays on everyone.
- **Parts as shapes**: Neon parts glow at any brightness; ForceField material shimmers; a Ball's size is
  its smallest side; a Cylinder's length is its X axis (the `shell` track stands discs and pillars up).
- `ParticleEmitter:Emit(n)` emits where the emitter is at that instant: move one attachment and emit at
  many points in the same frame (rain splashes).

## 7. Textures
Effects look as good as their textures. `vfx_texture {kind, list: true}` shows a kind's parameters with
their defaults and ranges (it makes nothing: read them instead of guessing). `vfx_texture {name, kind,
params, frames}` draws one from parameters, uploads it (as a Decal; the image id is read in Studio [check in Studio: an image still in
moderation may not load]) and effects use it as `"tex:<name>"`; until it is uploaded the place uses a
built-in stand-in of the same family. Kinds: soft, glow, smoke (lit puffs; flipbooks that churn and thin),
fire (flipbook), spark, star, ring, slash (crescent; a flipbook sweeps open), trail (strips for trails and
beams, tiling), electric (bolts; Random flipbook), energy (orb or tiling strip), dust, debris (chips;
Random), magic (circles), gradient, rain, snow, leaf (Random), splash (OneShot), water (waterfall strip),
lightshaft, wind, vignette.
- Textures are **white**: alpha is the shape, brightness the form, `Color` the colour. One texture serves
  every element; a dark texture can only darken.
- Read the **analysis line**: `covers` (how much of the cell is drawn), `edges` (hard 0 … very soft 1),
  `colour under alpha` (white tints cleanly; light grey keeps a shaded puff's volume), `dark fringe
  texels` (must be 0: transparent texels carry the edge colour, never black), `frame-to-frame` (0.9+
  smooth), `loop seam` (close to frame-to-frame for loops), `cell border alpha` (0: frames never bleed).
  Fix every `problems` entry, look at the picture, call again with the same name.
- Set the emitter's `flipbook` to the texture's layout (`frames: 16` → `Grid4x4`).

## 8. Motion math: ShurikenCurves
Paths are re-parameterised by arc length: `path:at(u)` is the point a fraction `u` of the way *along* it,
so moving `u` at a constant rate moves at constant speed, even on a Bezier whose control points bunch up.
`Curves.catmullRom(points)` passes through every point (centripetal: no loops or cusps);
`Curves.bezier(p0, p1, p2, p3)` is pulled toward its handles; `Curves.arc(center, radius, from, to)` turns
about the centre's up axis (0° forward, + left); `Curves.spiral`, `Curves.ballistic(from, to, height)`,
`Curves.launch(from, to, seconds)` (a physics launch velocity), `Curves.steer(...)` (homing),
`Curves.lightning(a, b)` (jagged points), `Curves.noise/fbm/flicker/wobble`. `Curves.slerp(a, b, t)` is
`CFrame:Lerp` (position lerp, rotation along the shortest arc). `Curves.ease(name, t)` has Penner's set;
`Curves.bezierEase(x1, y1, x2, y2)` is CSS cubic-bezier.

Orbiting blades round a caster, evenly spaced and turning (client):
```lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Curves = require(ReplicatedStorage.Shared.ShurikenCurves)

local function orbitBlades(center: BasePart, blades: { BasePart }, radius: number, turnsPerSecond: number): () -> ()
	local started = os.clock()
	local connection = RunService.RenderStepped:Connect(function()
		local t = os.clock() - started
		for i, blade in blades do
			local angle = t * turnsPerSecond * 2 * math.pi + (i - 1) / #blades * 2 * math.pi
			local bob = Curves.noise(t * 0.8, i) * 0.4
			local at = Curves.orbit(center.Position, radius, angle, 1.5 + bob)
			blade.CFrame = CFrame.lookAt(at, center.Position) * CFrame.Angles(0, math.rad(90), 0)
		end
	end)
	return function()
		connection:Disconnect()
	end
end

return orbitBlades
```

## 9. Recipes: abilities and battle effects
Design each for its move; the worked examples (`vfx_presets`) show complete timelines.
- **Hit spark (melee)**: frame 0 a `flash` (size 2→4, 0.08 s), a `circle` or `ring` snapping out
  (0.12-0.2 s, `expoOut`), 8-16 `spark`s flying out along the swing (`direction` from the swing, drag 6),
  `highlight` on the target (white, 0.15 s), `hitstop` 0.05, `shake` 1 on heavy hits. Under 0.5 s.
- **Slash and combos**: a `slash` track tilted into the swing plane (`rotation: [0, 0, 35]`, a `slash`
  texture: `vfx_texture {kind: "slash", frames: 16}` sweeps open with a OneShot flipbook), sparks along
  the arc, played at the attacker's root CFrame on the Hit marker. A combo varies the tilt per hit (35°,
  −35°, then a vertical finisher with a ring, dust, shake and hit-stop: the finisher earns the big effect).
  Weapon trails (`Effects.trail` on the blade, enabled for the swing) for slower weapons.
- **Projectiles**: a persistent **body** effect (a `LockedToPart` core, a wake of particles that stay
  behind, a light) carried by `Effects.projectile({from, to, speed, path, body, impact})`; an **impact**
  burst where it lands (facing out of the surface); paths `straight`, `arc` (a lob), `homing`, `spiral`,
  `wave`. The server times the hit with `Effects.flightTime(opts)` (same maths); clients only draw.
- **Beams and lightning**: `Effects.lightning(a, b)` (a white core in a coloured glow, re-shaped 18×/s,
  forks); `Effects.chain(points)` hops target to target; a held laser is a `beam` track with a scrolling
  `trail`/`energy` texture and a `light` at the end.
- **Area attacks and telegraphs**: `Effects.telegraph(groundCFrame, {radius, seconds, effect})` or
  `{shape: "rect", width, length}` for a line; the server waits the same `seconds` and then applies
  damage; the `effect` is the eruption (pillar shell, debris, ring, dust, shake by distance).
- **Buffs and auras**: persistent effects attached to the root: a looping `circle` at the feet
  (`loop: true`), slow motes rising, a `light` with flicker; under ~60 particles alive (`vfx_measure`
  `peak alive`); the buff's start is a burst (a ring and rising motes), its end a small puff.
- **Hit reactions and damage numbers**: on the attacker's client, `Screen.hitMarker()` and
  `Screen.damage(position, amount, {crit = true})`; on the victim's, `Screen.flash` (light red, 0.2) and
  `Screen.lowHealth(health / max)`; for everyone, `Effects.flash(model)` and the hit effect.
- **Death and explosions**: anticipation (a swelling shell, a flicker), the blast (flash, fireball shell,
  ring, debris, light, shake by radius), light smoke that rises and thins, a scorch decal. Never dark
  opaque smoke.

The server decides, clients draw; one remote message per cue (`ReplicatedStorage.Shared` holds the
modules; the attacker's client already played its own swing and is left out with `except`):
```lua
--!strict
-- Server: a fireball whose hit the server times from the same path the clients draw.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Effects = require(ReplicatedStorage.Shared.ShurikenEffects)
local Cast = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("CastFireball") :: RemoteEvent

local SPEED, RANGE, RADIUS, DAMAGE = 90, 120, 8, 30
local nextCast: { [Player]: number } = {}

Cast.OnServerEvent:Connect(function(player: Player, aim: unknown)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if typeof(aim) ~= "Vector3" or not (root and root:IsA("BasePart")) or os.clock() < (nextCast[player] or 0) then
		return
	end
	nextCast[player] = os.clock() + 1.5
	local from = root.Position + Vector3.new(0, 1.5, 0)
	local offset = aim - from
	local target = from + offset.Unit * math.min(offset.Magnitude, RANGE)
	local shot = { from = from, to = target, speed = SPEED, path = "arc", height = 6, body = "FireBolt", impact = "FireballImpact", ignore = { character } }
	Effects.telegraph(target, { radius = RADIUS, seconds = Effects.flightTime(shot), color = Color3.fromRGB(255, 120, 40) })
	Effects.projectile(shot)
	task.delay(Effects.flightTime(shot), function()
		for _, other in Players:GetPlayers() do
			local otherRoot = other.Character and other.Character:FindFirstChild("HumanoidRootPart")
			local humanoid = other.Character and other.Character:FindFirstChildOfClass("Humanoid")
			if other ~= player and otherRoot and otherRoot:IsA("BasePart") and humanoid and (otherRoot.Position - target).Magnitude <= RADIUS then
				humanoid:TakeDamage(DAMAGE)
			end
		end
	end)
end)

Players.PlayerRemoving:Connect(function(p)
	nextCast[p] = nil
end)
```

## 10. On-screen combat FX: ShurikenScreenFX
Client-side 2D effects, animated through the `Motion` module (skill roblox-ui-motion), so Reduce Motion
behaves as in the game's UI: moves, pops and loops land at once or stay still, fades still play; speed
lines don't show at all; camera shake (`Effects.shake`) is off. Damage numbers are BillboardGuis at the
hit position that pop, arc up along a Catmull-Rom `Motion.path` and fade (at most 24 at once); banners and
the combo counter use the game's display face with a dark outline (`Screen.setFonts(display, bold)`, the
style of skill roblox-ui-showpieces). Layers: vignette, tints, flashes and speed lines under the HUD
(DisplayOrder −1), banners, combo and hit markers over it (25).
```lua
--!strict
-- Client: hit feedback for the local player.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Screen = require(ReplicatedStorage.Shared.ShurikenScreenFX)
local HitConfirmed = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("HitConfirmed") :: RemoteEvent

local hits, lastHit = 0, 0
HitConfirmed.OnClientEvent:Connect(function(position: Vector3, amount: number, crit: boolean)
	Screen.hitMarker()
	Screen.damage(position, amount, { crit = crit })
	hits = if os.clock() - lastHit < 1.8 then hits + 1 else 1
	lastHit = os.clock()
	if hits >= 3 then
		Screen.combo(hits)
	end
end)

local function watch(character: Model)
	local humanoid = character:WaitForChild("Humanoid") :: Humanoid
	humanoid.HealthChanged:Connect(function(health: number)
		Screen.lowHealth(health / humanoid.MaxHealth)
	end)
end
local player = Players.LocalPlayer
if player.Character then
	watch(player.Character)
end
player.CharacterAdded:Connect(watch)
```
From the server, `Effects.screen("banner", { text = "DOUBLE KILL" }, { players = { killer } })`.

## 11. Cutscenes and intros: ShurikenCutscene
A cutscene is data (`vfx_cutscene` saves and builds it; or a table in code): **shots** move the camera along
a Catmull-Rom (or 4-point Bezier, or linear) path of world positions at even speed with an ease, looking at
a point, a moving `{points}` path, `"player"` or an instance path, with `fov` and `roll` curves and a
`drift` (handheld); **events** at times: `effect` + `where`, `sound`, `animation` + `rig`, `line` +
`speaker` (subtitles), `title` + `subtitle`, `fade` in/out, `shake`, `signal` (`Cutscene.onSignal`; with
`always = true` it fires even when skipped). The module holds the game's input (controls off, the game's
actions sunk; GUI buttons still work) and hides the core UI and the game's ScreenGuis, shows a letterbox,
lets the player skip (a button, Space, Enter or gamepad B after 0.6 s) and always restores the camera
(type, subject, FOV), controls and UI, also when the character dies or a frame errors.
Camera grammar: **establishing** (wide, high, slow, 3-5 s), **reveal** (a dolly past foreground to the
subject), **push-in** (FOV 70 → 55 toward a face or boss), **orbit** (a catmullRom ring of points,
`lookAt` the subject); cut on the beat of an event, one idea per shot; 25-60 studs/s reads as a move,
more as a whip (`vfx_cutscene` reports each shot's speed and the camera frames to screenshot).
```lua
--!strict
-- Client: the arena intro the first time a player spawns, and the boss reveal from code as data.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Cutscene = require(ReplicatedStorage.Shared.ShurikenCutscene)

Cutscene.intro({ from = Vector3.new(0, 90, 140), seconds = 3.5, title = "THE FOUNDRY", subtitle = "Round 1" })

-- Data, the same shape vfx_cutscene saves (shots and events mix fields, so they are { any }).
local shots: { any } = {
	{ at = 0, duration = 3, camera = { points = { { 0, 30, 80 }, { 20, 22, 50 }, { 30, 14, 25 } }, ease = "sineInOut" }, lookAt = "Workspace.Arena.BossGate", fov = { 70, 60 } },
	{ at = 3, duration = 2.5, camera = { points = { { 8, 8, 18 }, { 4, 7, 12 } } }, lookAt = "Workspace.Arena.Boss", fov = { 55, 45 }, drift = 0.3 },
}
local events: { any } = {
	{ at = 1.2, effect = "GateBlast", where = "Workspace.Arena.BossGate" },
	{ at = 1.2, shake = 2, seconds = 0.4 },
	{ at = 3.2, title = "IRON WARDEN", subtitle = "Guardian of the Foundry", seconds = 2 },
	{ at = 5.4, signal = "BossStart", always = true },
}
local BOSS_REVEAL = { letterbox = 0.11, shots = shots, events = events }

Cutscene.onSignal("BossStart", function()
	print("the fight begins")
end)

return function()
	return Cutscene.play(BOSS_REVEAL)
end
```

## 12. Environment VFX: ShurikenWeather (for the environment artist too)
Weather and ambience run on each client, follow the camera or live in tagged zones, and know the time of
day and the quality level. The environment artist decides where and why (skill roblox-environment-art,
section 6); this is how.
- **Weather round the camera**: `Weather.set("Rain" | "Storm" | "Snow" | "Blizzard" | "Ash" | "Sandstorm"
  | "Leaves", {intensity 0..2, wind, gusts})`, `Weather.set(nil)` clears. On the server it is set through
  attributes on ReplicatedStorage.ShurikenEffects, so players who join later get it. Rain falls from a box
  above the camera, slanted by the wind, with splashes from a few raycasts a frame, and fades out under a
  roof (a raycast up every 0.5 s); snow and leaves drift with `workspace.GlobalWind`.
- **Zones**: tag a part `ShurikenAmbient` with attribute `Ambient` = Fireflies, Leaves, DustMotes, Mist,
  Embers, Spray, Haze, LightShaft, Waterfall or Steam (and optionally `Intensity` 0..2, `Time` = day,
  night or any). The part's box is the emitter's shape (make it invisible, CanCollide and CanQuery off);
  LightShaft and Waterfall draw beams from its top face to its bottom face (Waterfall adds spray at the
  bottom). Zones bind as they stream in, run only within about 120-280 studs of the camera (by quality),
  and follow the clock: fireflies by night, dust motes and light shafts by day.
- **Wind**: `Weather.wind(Vector3)` sets the steady wind; `Weather.gust(strength, seconds)` swells it
  (storms gust by themselves). Terrain grass, leaves, snow and every `WindAffectsDrag` particle follow.
- **Fog**: depth fog is the environment artist's Atmosphere; `Mist` zones are low banks of very
  transparent puffs (transparency 0.88+) in hollows and over water. Roblox has no screen distortion, so
  `Haze` is faint shimmering wisps, not refraction.
- **Budget**: ambient particles never cover lanes or the crosshair; keep each zone under ~40 alive; the
  quality level scales every rate.
```lua
--!strict
-- world/Ambience.luau (a world builder, run with roblox_run_luau): tags the zones and sets the weather.
local CollectionService = game:GetService("CollectionService")

local ZONES = {
	{ name = "SwampFireflies", ambient = "Fireflies", cframe = CFrame.new(40, 4, -60), size = Vector3.new(50, 8, 50) },
	{ name = "MillShafts", ambient = "LightShaft", cframe = CFrame.new(-12, 18, 30), size = Vector3.new(6, 30, 6) },
	{ name = "FallsSpray", ambient = "Waterfall", cframe = CFrame.new(80, 20, 10), size = Vector3.new(14, 40, 2) },
}

local folder = workspace:FindFirstChild("AmbienceZones") or Instance.new("Folder")
folder.Name = "AmbienceZones"
folder.Parent = workspace
folder:ClearAllChildren()
for _, z in ZONES do
	local part = Instance.new("Part")
	part.Name = z.name
	part.Anchored = true
	part.CanCollide = false
	part.CanQuery = false
	part.CanTouch = false
	part.Transparency = 1
	part.CFrame = z.cframe
	part.Size = z.size
	part:SetAttribute("Ambient", z.ambient)
	CollectionService:AddTag(part, "ShurikenAmbient")
	part.Parent = folder
end
return ("%d ambience zones"):format(#ZONES)
```
Weather for everyone, from a server script: `Weather.set("Rain", { intensity = 0.8, gusts = true })`.

## 13. Performance rules
- **The server never steps effects.** It decides and sends one cue; clients draw. No per-frame server work.
- **Budgets per quality level** (`Effects.quality()`: the game's setting via `Effects.setQuality`, else the
  player's graphics level 1-3 low, 4-7 medium, 8-10 high, else Automatic by measured frame rate):
  particles ×0.35 / ×0.7 / ×1, effects at once 10 / 24 / 40, lights 2 / 4 / 8, culling at 160 / 260 /
  400 studs. Tracks and emitters with `detail: "medium"` or `"high"` drop out below it.
- **Culling**: bursts behind the camera (past 25 studs) or beyond the culling distance aren't drawn;
  over budget, only effects within 40 studs play; `force = true` for the moments that matter.
- **Pooling and cleanup**: parts, attachments and emitter hosts are reused; everything goes back or is
  destroyed when its effect ends; one frame connection runs every effect and exists only while one does.
- **Counts**: hits 20-120 particles, explosions under ~200, auras under ~60 alive, 600 per burst is the
  hard limit; debris under ~10 parts; at most 2 lights per effect; Highlights only as flashes.
- **Persistent effects** belong to the client that holds the handle (`attach` on clients). Started from
  the server they run `opts.seconds` (default 5) and stop by themselves.
- `Effects.preload(names)` on a loading screen avoids the first-hit pop-in of textures.

## 14. Workflow and verification
1. Write the brief: what the move is, how big, its element and palette, where the camera is.
2. `vfx_texture` the textures it needs (one shape each, reused across effects; `list: true` first; read
   the analysis; upload).
3. `vfx_create` the spec. **Look at the picture in its result**: a contact sheet of the effect's frames
   over its time (the first frame, then where it shows most), top row by day over grass, bottom row on a
   dark stage, from a camera behind and beside whoever plays it, drawn as ShurikenEffects plays it. Read
   `analysis`: `line` and `timeline` (cost, timing), `warnings` (fix each, or say why it stands) and
   `look` (how much of each layer shows by day, against a bright sky and in the dark; what is burnt to
   white; the colour it reads as). `vfx_measure {name | spec, times}` is the same without saving, at your
   own moments. This loop needs no Studio: use it for every change.
4. Change, don't resend: `vfx_create {name, set: {"tracks.Core.size": [4, 9], "emitters.Flames.rate": 30,
   "tracks.Dust": null}}` (a track or emitter by its name, or its number from 1; null removes; a new name
   with a whole track adds it). The same effect in another colour is a variant: `{from: "PowerUpCollect",
   name: "PowerUpCollect_Rage", to: "#ff3a28"}` turns every hue so the main colour becomes red and keeps
   white cores white (`palette` for exact swaps, `hue` for degrees); a variant follows its base when the
   base changes. Name tracks and emitters: paths and the look's layer list go by name. A part several
   effects share (a shock ring, a dust kick, a spark burst) is its own small effect, played by the others
   with a `spawn` track (`{"type": "spawn", "effect": "DustKick", "at": 0.05, "offset": [0, -2.5, 0]}`):
   fix it once and every effect that plays it follows.
5. Studio is for the final look on the real map (its lighting, its Bloom), once the picture is right:
   `vfx_play` at a point and `roblox_screenshot` with the camera it suggests, or one playtest. When another
   playtest holds Studio, `vfx_create` does not wait: it saves, measures and pictures (`pending: true`);
   go on with the next effect and run `vfx_build` once before you play them.
6. Wire it (sections 9-12), sync, and check in a playtest: no `[ShurikenEffects]` warnings in the console,
   `Effects.stats()` from a Client probe at the peak matches the measure, and the frame rate holds.
The picture approximates lighting and Bloom and draws Roblox's built-in textures as look-alikes (your own
`tex:` textures are exact); `look.notes` lists what it could not show (sounds, a mesh shell, an image id
it can't read).
Studio checks for the first build of a game [check in Studio]: a burst plays on every client from a server
call; `Effects.stats().effects` returns to 0 after it; a persistent effect stops with `handle.stop()`;
a telegraph's rim is a smooth circle on the ground; a `slash` lies in its tilted plane; a lightning beam
crackles; damage numbers rise and fade; a cutscene restores the camera and controls after a skip.

## Known pitfalls
- Dark smoke at low transparency becomes an opaque black blob (and scene lighting darkens it further).
- Emitting on the server: `Emit` doesn't replicate. Call `Effects.play` there; it relays.
- An effect timed by `task.wait` guesses instead of the animation's Hit marker: use `markerTime`.
- Every layer additive and white: no value contrast, the effect reads as a white smear.
- A `particles`, `flash`, `ring` or `slash` track with `emit` and no `rate` in a `persistent` effect never
  fires (an effect that stays on runs its emitters on rate): give it a rate, or play it as its own burst.
- A particle layer's `offset` (an emitter, or a `particles`, `flash`, `ring` or `slash` track) is not
  scaled by `opts.scale`; sizes, speeds and the other tracks' offsets are. For a ring of dust that must
  grow with the scale, let speed carry the particles out from the centre, or make the big size its own effect.
- A flipbook texture whose frames touch their cell borders flickers in mipmaps; OneShot flipbooks with
  very different lifetimes play at different speeds.
- Highlights left on many models stop drawing past 31.
- `Lighting.Technology` can't be read or set from scripts, so effects never depend on it.

## References
- Shuriken: `docs/ARCHITECTURE.md` §11 (the effects workshop), skills roblox-ui-motion (Motion),
  roblox-ui-showpieces (title style), roblox-combat-feel (hit timing), roblox-environment-art (zones, mood).
- Roblox: ParticleEmitter, Beam, Trail, Highlight, PointLight, BloomEffect, Workspace.GlobalWind,
  UserGameSettings.SavedQualityLevel, GuiService.ReducedMotionEnabled, CollectionService.
