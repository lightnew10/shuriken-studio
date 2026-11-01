---
name: roblox-ui-motion
description: "2D animation for Roblox UI and on-screen effects in code: the Motion module (tweens that follow Reduce Motion, custom easing curves and cubic-bezier, keyframe tracks, timelines, staggered entrances, springs for press/drag/hover, punch and shake, count-ups, sprite-sheet flipbooks, path and arc motion, reward icons flying to a counter, page swaps and full-screen transitions, looping pulse/float/spin/shimmer) with scopes that stop everything when a screen closes and cost nothing when idle. The Ui and Hud kits play through it. Read it before animating any menu, HUD, loading or title screen, reward, cutscene overlay or 2D effect."
version: 1
tags: [ui, motion, animation, tween, easing, bezier, keyframes, timeline, spring, stagger, transition, flipbook, spritesheet, sprite, loading, intro, title, reward, count, cutscene, fx, reduce motion]
roblox_systems: [TweenService, TweenInfo, GuiService, RunService, UIScale, UIGradient, ImageLabel, ScreenGui, NumberValue]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [luau_check, roblox_sync_push, roblox_playtest, roblox_screenshot, ui_audit]
---
# Motion: 2D animation for Roblox UI

## Purpose
Roblox UI has no animation timeline: every menu that moves is hand-written TweenService code, and most of it
is either missing (instant pop-in), too slow, ignores the player's Reduce Motion setting, or keeps looping
after the screen closed. Motion is one module for all of it, built on native tweens: the Ui kit (skill
roblox-ui-design) and the Hud kit (skill roblox-game-hud) play through it, and game code calls it for
entrances, rewards, loading and title screens, cutscene overlays and on-screen effects. Worked screens built
with it (loading, title, reward reveal, round end, interactive patterns): skill **roblox-ui-showpieces**.

## Where it lives
A ModuleScript in the game's shared code: `src/Shared/Motion.luau` in a new project
(`ReplicatedStorage.Shared.Motion`); in a plugged-in game, beside its other shared modules in
ReplicatedStorage. The Ui and Hud kits require it from the same folder (`require(script.Parent.Motion)`),
so it goes in first. It runs on the client only (UI). Lint-clean under strict luau-lsp and selene.

## The API (stable: other code builds on these names)
| Call | What it does | Per frame? |
|---|---|---|
| `Motion.T.hover/press/open/close/slideIn/slideOut/page/enter/pop/fade/bob` | timing tokens (TweenInfo) from the motion spec | - |
| `Motion.reduced()` / `Motion.setReduced(on?)` | Reduce Motion now (the game's toggle, else the player's setting); a toggle on stops every loop | - |
| `Motion.tween(target, info, goal) -> Tween` | a tween; under Reduce Motion the goal lands at once (Completed still fires) | no |
| `Motion.curve(target, seconds, goal, ease, onDone?) -> stop` | a tween with any easing function | while it runs |
| `Motion.bezier(x1, y1, x2, y2) -> ease` | a CSS cubic-bezier easing for curve and keyframes | - |
| `Motion.path(target, points, seconds, ease?, onDone?) -> stop` | Position through UDim2 points on a smooth curve | while it runs |
| `Motion.spring(target, goal, frequency?, damping?)` | moves toward a goal that may change mid-way, keeping speed (press, drag, hover) | while it moves |
| `Motion.punch(target, amount?)` / `Motion.shake(target, degrees?)` | a bounce in size / an error wobble in rotation | while it moves |
| `Motion.count(label, from, to, opts?)`, `Motion.commas(n)`, `Motion.short(n)` | count-up (format: separators, or 1.2K/3.4M) | no (NumberValue tween) |
| `Motion.enter(items, opts?)` | staggered entrance: up/down/left/right/pop/fade; layout children fade | no |
| `Motion.swap(old, new, direction?)` | slides one page out and the next in (tabs, carousels, steps) | no |
| `Motion.fly(opts)` | icons burst from a point (element, world position or screen point) and arc into a counter | no |
| `Motion.transition(swap, opts?)` | covers the screen (fade, wipe, iris), calls swap, uncovers | no |
| `Motion.scope(owner?) -> Scope` | a group that stops together, by itself when owner hides or is destroyed | - |
| `scope:tween / timeline / keyframes / loop / pulse / float / spin / shimmer / flipbook / add / stop` | the same in a scope; loops, keyframes, shimmer and flipbooks only exist in scopes | flipbooks only |
| `Motion.stats()` | springs, flipbooks, curves and loops running, and whether the frame step is connected | - |

`goal` is a property table like TweenService's (`{ Position = ..., BackgroundTransparency = 0 }`). Springs,
curves and keyframes animate numbers, Vector2, UDim2, UDim and Color3.

## Rules that keep motion cheap and correct
- **Native first.** TweenService interpolates in the engine: tweens, loops (`RepeatCount = -1`), entrances,
  count-ups, flights, transitions and keyframes (one tween per segment) cost no Luau per frame. Only springs,
  flipbooks, `curve` and `path` run on the frame step, and the step's one connection exists only while one of
  them runs (`Motion.stats().stepping` is false when idle). Never write your own RenderStepped animation loop.
- **Scopes end what they start.** Anything that loops or runs long (a pulse, a shimmer, a flipbook, a looping
  keyframe track, a timeline) goes in a scope tied to its screen: `Motion.scope(screenGui)` stops when the
  screen is disabled or destroyed, `Motion.scope(frame)` when the frame is hidden. `Ui.window` gives each
  window one (`window.motion`, stopped on close). Stopping puts loops back where they started, and a stopped
  scope takes new work, so start the loops again when the screen reopens. Loops mark their element
  (attribute `MotionLoops`): `ui_audit` warns about loops still running in a hidden screen.
- **Layouts own Position and size.** Children of a UIListLayout/UIGridLayout/UIPageLayout can't slide (the
  layout sets their Position), and scaling one changes the space the layout gives it [verify]: `Motion.enter`
  fades layout children; punch an icon inside a slot, not the slot; float and slide free elements only.
  Rotation never moves a layout (`Motion.shake` wobbles in rotation for that reason).
- **Reduce Motion** (`GuiService.ReducedMotionEnabled`, or the game's own toggle through `Motion.setReduced`):
  moves, scales, springs, loops, flipbooks, flights and shakes land at once or don't run; fades and colour
  changes still play (a transition becomes a 0.15 s fade). Motion does this for every call; code that skips
  an effect for Reduce Motion checks `Motion.reduced()`. Information carried by motion (a cooldown sweep, a
  progress bar) keeps moving.
- **Animate cheap properties**: UIScale, Position (with AnchorPoint set), Rotation, transparency, colours,
  UIGradient Offset/Rotation, ImageRectOffset. Never Size of TextScaled text (it re-fits every frame and
  jitters) or the Thickness of a text stroke (glyphs re-render and flicker).
- **Nothing blocks input for long**: a transition's cover takes clicks for its 0.6 s; entrances never disable
  buttons; long reveals are skippable after 0.3 s.

## Designing motion (what a motion designer decides)
1. **Purpose first.** Every animation says something: where a window came from, what changed (a number
   counting), what to look at (one pulse), that the press registered (a spring), that something failed (a
   shake). Decoration-only motion goes on one hero element per screen at most.
2. **Hierarchy in time.** The container first, then its title, then its content, then the call to action:
   0 / 0.05 / 0.1-0.3 (staggered) / 0.3 s. The eye follows the order; the primary button lands last.
3. **Enter slow, leave fast.** Opens 0.18-0.25 s with an ease-out or a small Back overshoot; closes 0.1-0.15 s
   ease-in, no overshoot. Exits never bounce.
4. **Stagger budgets.** 25-40 ms between items, the whole list in under 0.4 s (12 items at 35 ms = 0.39 s);
   past 12 items stagger the first 12 and show the rest at once.
5. **Easing vocabulary.** Quint/Quad Out: things arriving and settling. Back Out: playful arrivals (buttons,
   rewards, badges) - not windows in a serious game. Sine InOut: loops and breathing. Quad In: leaving.
   Linear: rotation and progress only. Springs: anything the player drags or presses. `Motion.bezier(0.2, 0.8,
   0.2, 1)` (a long soft landing) for hero moments.
6. **Anticipation, action, follow-through** for rewards and big moments: a 0.1-0.2 s wind-up (a squash to 0.9,
   a shake that grows), a fast main move, an overshoot that settles (punch, Back Out), then idle motion
   (a bob or a slow ray spin) so the screen stays alive while the player reads.
7. **Distance and size**: slides travel 16-40 px (not the whole screen) unless they change context (a page
   swap, a drawer); scales start at 0.9-0.95 for windows, 0.6 for pops, 0 only for icons and particles.
8. **One loop per area.** Two things pulsing next to each other fight for attention; ambient loops are slow
   (1.2-6 s cycles) and small (scale 1.04-1.06, 4-8 px float).
9. **Check it**: play it at 0.25 speed in your head step by step (or with Studio's tween times multiplied
   for a test), then on a phone layout: motion that crosses a 945x415 canvas feels twice as fast as on a
   monitor. Then turn on Reduce Motion (`Motion.setReduced(true)` in a playtest) and check that nothing
   important is lost.

## The module
`src/Shared/Motion.luau`:
```lua
--!strict
-- Motion: 2D animation for Roblox UI (skill roblox-ui-motion). The Ui and Hud kits play through it; game
-- code calls it directly. One-shots finish by themselves: tween, curve (any easing curve, Motion.bezier),
-- path (through points), spring, punch, shake, count, enter, swap, fly, transition. Ambient and long motion
-- runs in a scope that stops all of it at once, and by itself when its owner hides or is destroyed: loop,
-- pulse, float, spin, shimmer, flipbook, timeline, keyframes.
-- Reduce Motion (the player's setting, or the game's own toggle: Motion.setReduced): moves, scales and
-- loops land at once or stay still; fades and colour changes still play. Idle it costs nothing: TweenService
-- does the interpolation natively, and the one per-frame connection (springs, flipbooks) exists only while
-- one of them runs.
--   local Motion = require(game.ReplicatedStorage.Shared.Motion)
--   Motion.enter(grid:GetChildren(), { from = "up" })   -- staggered entrance
--   local fx = Motion.scope(window.root)                -- stops when the window hides
--   fx:pulse(claimHalo)
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local Motion = {}

export type Goal = { [string]: any }

local Quad, Quint, Back, Sine = Enum.EasingStyle.Quad, Enum.EasingStyle.Quint, Enum.EasingStyle.Back, Enum.EasingStyle.Sine
local In, Out, InOut = Enum.EasingDirection.In, Enum.EasingDirection.Out, Enum.EasingDirection.InOut

--- Timing tokens (the motion spec in skill roblox-ui-references): use these, not new TweenInfos.
Motion.T = {
	hover = TweenInfo.new(0.1, Quad, Out), -- colour and lift on hover or gamepad selection
	press = TweenInfo.new(0.07, Quad, Out),
	open = TweenInfo.new(0.2, Back, Out), -- windows and popups: UIScale 0.92 -> 1
	close = TweenInfo.new(0.12, Quad, In),
	slideIn = TweenInfo.new(0.25, Quint, Out), -- drawers, sheets, toasts
	slideOut = TweenInfo.new(0.18, Quad, In),
	page = TweenInfo.new(0.2, Quint, Out), -- tab and page switches
	enter = TweenInfo.new(0.24, Quint, Out), -- list items arriving
	pop = TweenInfo.new(0.4, Back, Out), -- rewards, badges, splash words
	fade = TweenInfo.new(0.3, Quad, InOut), -- scene fades
	bob = TweenInfo.new(1.2, Sine, InOut), -- idle loops (half a cycle)
}

------------------------------------------------------------------------------------------- Reduce Motion
local override: boolean? = nil
local live: { [any]: () -> () } = {} -- running loops, shimmers and flipbooks: key -> stop

--- Whether motion is reduced: the game's own toggle when set (Motion.setReduced), else the player's Roblox
--- setting (false where it doesn't exist).
function Motion.reduced(): boolean
	if override ~= nil then
		return override
	end
	local ok, reduced = pcall(function()
		return GuiService.ReducedMotionEnabled
	end)
	return ok and reduced
end

local function stopLoopsIfReduced()
	if not Motion.reduced() then
		return
	end
	local stops = {}
	for _, stop in live do
		table.insert(stops, stop)
	end
	for _, stop in stops do
		stop()
	end
end

--- The game's own Reduce Motion toggle (a settings menu): true or false overrides the player's setting,
--- nil follows it again. Turning it on stops every running loop at once.
function Motion.setReduced(on: boolean?)
	override = on
	stopLoopsIfReduced()
end

pcall(function()
	GuiService:GetPropertyChangedSignal("ReducedMotionEnabled"):Connect(stopLoopsIfReduced)
end)

------------------------------------------------------------------------------------------------- Tweens
local SNAP = TweenInfo.new(0)

-- Properties by name (Luau types can't index an Instance with a string).
local function put(target: Instance, prop: string, value: any)
	local t: any = target
	t[prop] = value
end

local function get(target: Instance, prop: string): any
	local t: any = target
	return t[prop]
end

local function set(target: Instance, goal: Goal)
	for prop, value in goal do
		put(target, prop, value)
	end
end

--- Plays a tween and returns it. With Reduce Motion the goal lands at once (the tween still completes, so
--- .Completed fires).
function Motion.tween(target: Instance, info: TweenInfo, goal: Goal): Tween
	local reduced = Motion.reduced()
	if reduced then
		set(target, goal)
	end
	local tween = TweenService:Create(target, if reduced then SNAP else info, goal)
	tween:Play()
	return tween
end

local function scaleOf(target: GuiObject): UIScale
	local scale = target:FindFirstChildOfClass("UIScale")
	if scale then
		return scale
	end
	local made = Instance.new("UIScale")
	made.Parent = target
	return made
end

-------------------------------------------------------------------- Springs and flipbooks: the frame step
type Spring = { kind: string, x: { number }, v: { number }, goal: { number }, w: number, z: number }

export type Sheet = {
	frame: Vector2, -- one frame's size in the sheet image, in pixels
	count: number, -- frames
	columns: number, -- frames per row
	fps: number?, -- default 24
	loop: boolean?, -- default true; false plays once and holds the last frame
	origin: Vector2?, -- where frame 1 starts in the image (default 0, 0)
	still: number?, -- the frame shown under Reduce Motion (0-based, default 0)
}

type Book = { image: ImageLabel | ImageButton, sheet: Sheet, t: number, shown: number, onDone: (() -> ())?, finish: () -> () }

-- A tween whose easing is a Luau function (Motion.curve, Motion.path): sampled on the frame step.
type Clip = { target: Instance, t: number, seconds: number, ease: (number) -> number, apply: (number) -> (), onDone: (() -> ())? }

local springs: { [Instance]: { [string]: Spring } } = {}
local books: { [Book]: boolean } = {}
local clips: { [Clip]: boolean } = {}
local stepper: RBXScriptConnection? = nil
local SUBSTEP = 1 / 120

local function pack(value: any): ({ number }, string)
	local kind = typeof(value)
	if kind == "number" then
		return { value }, kind
	elseif kind == "Vector2" then
		return { value.X, value.Y }, kind
	elseif kind == "UDim2" then
		return { value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset }, kind
	elseif kind == "UDim" then
		return { value.Scale, value.Offset }, kind
	elseif kind == "Color3" then
		return { value.R, value.G, value.B }, kind
	end
	error("Motion can't spring a " .. kind)
end

local function build(c: { number }, kind: string): any
	if kind == "number" then
		return c[1]
	elseif kind == "Vector2" then
		return Vector2.new(c[1], c[2])
	elseif kind == "UDim2" then
		return UDim2.new(c[1], c[2], c[3], c[4])
	elseif kind == "UDim" then
		return UDim.new(c[1], c[2])
	end
	return Color3.new(math.clamp(c[1], 0, 1), math.clamp(c[2], 0, 1), math.clamp(c[3], 0, 1))
end

-- Semi-implicit Euler in substeps of 1/120 s: stable for any frame time. False once it has settled.
local function advance(s: Spring, dt: number): boolean
	local n = math.max(1, math.ceil(dt / SUBSTEP))
	local h = dt / n
	local moving = false
	for i, goal in s.goal do
		local x, v = s.x[i], s.v[i]
		for _ = 1, n do
			v += (-s.w * s.w * (x - goal) - 2 * s.z * s.w * v) * h
			x += v * h
		end
		if math.abs(x - goal) > 1e-3 or math.abs(v) > 1e-2 then
			moving = true
		end
		s.x[i], s.v[i] = x, v
	end
	if not moving then
		for i, goal in s.goal do
			s.x[i], s.v[i] = goal, 0
		end
	end
	return moving
end

local function showFrame(book: Book, index: number)
	local s = book.sheet
	book.shown = index
	put(book.image, "ImageRectSize", s.frame)
	put(book.image, "ImageRectOffset", (s.origin or Vector2.zero) + Vector2.new((index % s.columns) * s.frame.X, math.floor(index / s.columns) * s.frame.Y))
end

local function step(dt: number)
	dt = math.min(dt, 0.1)
	for target, props in springs do
		if target.Parent == nil then
			springs[target] = nil
			continue
		end
		for prop, s in props do
			local moving = advance(s, dt)
			put(target, prop, build(s.x, s.kind))
			if not moving then
				props[prop] = nil
			end
		end
		if next(props) == nil then
			springs[target] = nil
		end
	end
	for book in books do
		if book.image.Parent == nil then
			book.finish()
			continue
		end
		book.t += dt
		local index = math.floor(book.t * (book.sheet.fps or 24))
		if index >= book.sheet.count then
			if book.sheet.loop == false then
				showFrame(book, book.sheet.count - 1)
				book.finish()
				local done = book.onDone
				if done then
					task.spawn(done)
				end
				continue
			end
			index %= book.sheet.count
		end
		if index ~= book.shown then
			showFrame(book, index)
		end
	end
	for clip in clips do
		if clip.target.Parent == nil then
			clips[clip] = nil
			continue
		end
		clip.t += dt
		local k = math.min(clip.t / clip.seconds, 1)
		clip.apply(clip.ease(k))
		if k >= 1 then
			clips[clip] = nil
			local done = clip.onDone
			if done then
				task.spawn(done)
			end
		end
	end
	local idle = next(springs) == nil and next(books) == nil and next(clips) == nil
	local connection = stepper
	if idle and connection then
		connection:Disconnect()
		stepper = nil
	end
end

local function wake()
	if not stepper then
		stepper = RunService.RenderStepped:Connect(step)
	end
end

--- Moves properties toward `goal` like a spring. Call it again while it moves and it bends toward the new
--- goal keeping its speed: press, release, hover, drag, a panel following a finger. frequency in Hz (2
--- gentle, 4 default, 8 snappy); damping 1 settles without overshoot, 0.4-0.6 bounces. Animates numbers,
--- Vector2, UDim2, UDim and Color3. With Reduce Motion the goal lands at once.
function Motion.spring(target: Instance, goal: Goal, frequency: number?, damping: number?)
	local props: { [string]: Spring } = springs[target] or {}
	if Motion.reduced() then
		for prop, value in goal do
			props[prop] = nil
			put(target, prop, value)
		end
		return
	end
	springs[target] = props
	local w = 2 * math.pi * (frequency or 4)
	local z = damping or 0.75
	for prop, value in goal do
		local g, kind = pack(value)
		local s = props[prop]
		if s and s.kind == kind then
			s.goal, s.w, s.z = g, w, z
		else
			local x = pack(get(target, prop))
			props[prop] = { kind = kind, x = x, v = table.create(#x, 0), goal = g, w = w, z = z }
		end
	end
	wake()
end

-- Starting speed that makes an underdamped spring at rest swing out to `peak` before it settles.
local function speedFor(peak: number, frequency: number, damping: number): number
	local root = math.sqrt(1 - damping * damping)
	return peak * 2 * math.pi * frequency * math.exp(damping * math.atan2(root, damping) / root)
end

-- Throws a number property off its rest with a speed; it swings and settles back (punch, shake).
local function kick(target: Instance, prop: string, peak: number, frequency: number, damping: number)
	local props: { [string]: Spring } = springs[target] or {}
	springs[target] = props
	local s = props[prop]
	local speed = speedFor(peak, frequency, damping)
	if s and s.kind == "number" then
		s.v[1] = speed -- a fresh kick, not added: six coins landing in a row don't add up to a huge bounce
		s.w, s.z = 2 * math.pi * frequency, damping
	else
		local rest = get(target, prop) :: number
		props[prop] = { kind = "number", x = { rest }, v = { speed }, goal = { rest }, w = 2 * math.pi * frequency, z = damping }
	end
	wake()
end

--- A quick bounce in size: a counter that received coins, a slot that got an item, a button pressed from a
--- gamepad. Punch something whose size no layout reads (an icon inside a slot), not a UIListLayout item.
function Motion.punch(target: GuiObject, amount: number?)
	if not Motion.reduced() then
		kick(scaleOf(target), "Scale", amount or 0.12, 4, 0.35)
	end
end

--- An error shake: a short wobble in rotation (rotation never moves a layout). degrees: the first swing.
function Motion.shake(target: GuiObject, degrees: number?)
	if not Motion.reduced() then
		kick(target, "Rotation", degrees or 5, 7, 0.25)
	end
end

------------------------------------------------------------------------------------- Curves and paths
--- An easing curve like CSS cubic-bezier(x1, y1, x2, y2) (x1 and x2 within 0-1): for Motion.curve and
--- keyframes. Motion.bezier(0.2, 0.8, 0.2, 1) is a long soft landing; y values past 0-1 overshoot.
function Motion.bezier(x1: number, y1: number, x2: number, y2: number): (number) -> number
	local function at(t: number, a: number, b: number): number
		local u = 1 - t
		return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
	end
	local function slope(t: number, a: number, b: number): number
		local u = 1 - t
		return 3 * a * u * u + 6 * (b - a) * u * t + 3 * (1 - b) * t * t
	end
	return function(x: number): number
		if x <= 0 then
			return 0
		elseif x >= 1 then
			return 1
		end
		local t = x
		for _ = 1, 8 do -- Newton's method: the t whose x is `x`
			local d = slope(t, x1, x2)
			if math.abs(d) < 1e-6 then
				break
			end
			t = math.clamp(t - (at(t, x1, x2) - x) / d, 0, 1)
		end
		return at(t, y1, y2)
	end
end

local function lerp(a: { number }, b: { number }, k: number): { number }
	local out = table.create(#a, 0)
	for i, v in a do
		out[i] = v + (b[i] - v) * k
	end
	return out
end

local function playClip(target: Instance, seconds: number, ease: (number) -> number, apply: (number) -> (), onDone: (() -> ())?): () -> ()
	local clip: Clip = { target = target, t = 0, seconds = math.max(seconds, 1e-3), ease = ease, apply = apply, onDone = onDone }
	clips[clip] = true
	wake()
	return function()
		clips[clip] = nil
	end
end

--- A tween with any easing curve (a Luau function from 0-1 to progress, e.g. Motion.bezier): for curves
--- TweenService has no EasingStyle for. Sampled every frame while it runs (TweenService does the stock
--- styles natively: use Motion.tween for those). Returns a function that stops it where it is. Reduce
--- Motion: the goal lands at once.
function Motion.curve(target: Instance, seconds: number, goal: Goal, ease: (number) -> number, onDone: (() -> ())?): () -> ()
	if Motion.reduced() then
		set(target, goal)
		if onDone then
			task.defer(onDone)
		end
		return function() end
	end
	local tracks: { { prop: string, kind: string, from: { number }, to: { number } } } = {}
	for prop, value in goal do
		local to, kind = pack(value)
		table.insert(tracks, { prop = prop, kind = kind, from = (pack(get(target, prop))), to = to })
	end
	return playClip(target, seconds, ease, function(k: number)
		for _, track in tracks do
			put(target, track.prop, build(lerp(track.from, track.to, k), track.kind))
		end
	end, onDone)
end

--- Moves an element's Position through points (UDim2s; the first is usually where it is now) on a smooth
--- Catmull-Rom curve in `seconds`: a reward icon's swoop, a title that drifts in on an arc, a cursor in a
--- tutorial. ease defaults to an ease-in-out curve. Returns a function that stops it. Reduce Motion: it
--- lands on the last point.
function Motion.path(target: GuiObject, points: { UDim2 }, seconds: number, ease: ((number) -> number)?, onDone: (() -> ())?): () -> ()
	local last = points[#points]
	if Motion.reduced() or #points < 2 then
		if last then
			target.Position = last
		end
		if onDone then
			task.defer(onDone)
		end
		return function() end
	end
	local p: { { number } } = {}
	for i, point in points do
		p[i] = (pack(point))
	end
	local n = #p - 1
	return playClip(target, seconds, ease or Motion.bezier(0.42, 0, 0.58, 1), function(k: number)
		local s = math.clamp(k, 0, 1) * n
		local i = math.min(math.floor(s), n - 1) + 1
		local u = s - (i - 1)
		local p0, p1, p2 = p[math.max(i - 1, 1)], p[i], p[i + 1]
		local p3 = p[math.min(i + 2, #p)]
		local c = table.create(4, 0)
		for j = 1, 4 do
			local a, b, d, e = p0[j], p1[j], p2[j], p3[j]
			c[j] = 0.5 * (2 * b + (d - a) * u + (2 * a - 5 * b + 4 * d - e) * u * u + (3 * b - a - 3 * d + e) * u * u * u)
		end
		target.Position = UDim2.new(c[1], c[2], c[3], c[4])
	end, onDone)
end

---------------------------------------------------------------------------------------------- Numbers
--- 1234567 -> "1,234,567" (rounded; big numbers stay exact up to 2^53).
function Motion.commas(n: number): string
	local digits = string.format("%.0f", math.abs(n))
	local grouped = (digits:reverse():gsub("(%d%d%d)", "%1,"):reverse():gsub("^,", ""))
	return (if n <= -0.5 then "-" else "") .. grouped
end

local SUFFIXES = { "K", "M", "B", "T", "Qa", "Qi" }

--- 1234 -> "1.2K", 3400000 -> "3.4M", up to Qi; under 1000 as is. Truncates, so 999,999 never reads "1000K".
function Motion.short(n: number): string
	local a = math.abs(n)
	local sign = if n <= -0.5 then "-" else ""
	if a < 1000 then
		return sign .. string.format("%.0f", a)
	end
	local tier = math.min(math.floor(math.log10(a) / 3), #SUFFIXES)
	local v = a / 10 ^ (tier * 3)
	local text = if v < 100 then string.format("%.1f", math.floor(v * 10) / 10) else string.format("%.0f", math.floor(v))
	return sign .. (text:gsub("%.0$", "")) .. SUFFIXES[tier]
end

export type CountOptions = {
	seconds: number?, -- default: 0.4-1.2 s, longer for bigger jumps
	format: ((value: number) -> string)?, -- default Motion.commas; Motion.short for currencies past 100K
	prefix: string?,
	suffix: string?,
}

local counting: { [Instance]: Tween } = setmetatable({}, { __mode = "k" }) :: any

--- Counts a label from one number to another (Quad Out), writing only when the shown number changes. A new
--- count on the same label takes over from the old one. Reduce Motion writes the end value at once.
function Motion.count(label: TextLabel | TextButton, from: number, to: number, opts: CountOptions?)
	local o: CountOptions = opts or {}
	local format = o.format or Motion.commas
	local prefix, suffix = o.prefix or "", o.suffix or ""
	local function show(n: number)
		put(label, "Text", prefix .. format(n) .. suffix)
	end
	local running = counting[label]
	if running then
		counting[label] = nil
		running:Cancel()
	end
	if Motion.reduced() or from == to then
		show(to)
		return
	end
	local value = Instance.new("NumberValue")
	value.Value = from
	local shown = math.floor(from + 0.5)
	show(shown)
	value.Changed:Connect(function(v: number)
		local n = math.floor(v + 0.5)
		if n ~= shown then
			shown = n
			show(n)
		end
	end)
	local seconds = o.seconds or math.clamp(0.35 + 0.12 * math.log10(math.abs(to - from) + 1), 0.4, 1.2)
	local tween = TweenService:Create(value, TweenInfo.new(seconds, Quad, Out), { Value = to })
	counting[label] = tween
	tween.Completed:Once(function(state: Enum.PlaybackState)
		if state == Enum.PlaybackState.Completed then
			show(to)
		end
		if counting[label] == tween then
			counting[label] = nil
		end
		value:Destroy()
	end)
	tween:Play()
end

------------------------------------------------------------------------------------- Entrances and pages
-- Designed values of everything mid-entrance, so an entrance that starts over another lands on the design,
-- not on a half-faded value. Cleared when the last entrance of an instance ends.
local designed: { [Instance]: Goal } = setmetatable({}, { __mode = "k" }) :: any
local pending: { [Instance]: number } = setmetatable({}, { __mode = "k" }) :: any

local function remember(o: Instance, prop: string): any
	local memo = designed[o] or {}
	designed[o] = memo
	local value = memo[prop]
	if value == nil then
		value = get(o, prop)
		memo[prop] = value
	end
	return value
end

local function hold(o: Instance, seconds: number)
	pending[o] = (pending[o] or 0) + 1
	task.delay(seconds, function()
		local left = (pending[o] or 1) - 1
		if left > 0 then
			pending[o] = left
		else
			pending[o] = nil
			designed[o] = nil
		end
	end)
end

local function fadeProps(o: Instance): { string }
	if o:IsA("TextLabel") or o:IsA("TextButton") or o:IsA("TextBox") then
		return { "BackgroundTransparency", "TextTransparency", "TextStrokeTransparency" }
	elseif o:IsA("ImageLabel") or o:IsA("ImageButton") then
		return { "BackgroundTransparency", "ImageTransparency" }
	elseif o:IsA("GuiObject") then
		return { "BackgroundTransparency" }
	end
	return { "Transparency" } -- UIStroke, UIShadow
end

-- Fades an element and up to 40 of its parts in from invisible to their designed transparency.
local function fadeIn(item: GuiObject, info: TweenInfo, delay: number)
	local parts: { Instance } = { item }
	for _, d in item:GetDescendants() do
		if #parts >= 40 then
			break
		end
		if d:IsA("GuiObject") or d:IsA("UIStroke") or d:IsA("UIShadow") then
			table.insert(parts, d)
		end
	end
	local timed = TweenInfo.new(info.Time, info.EasingStyle, info.EasingDirection, 0, false, delay)
	for _, o in parts do
		for _, prop in fadeProps(o) do
			local value = remember(o, prop)
			if typeof(value) == "number" and value < 1 then
				put(o, prop, 1)
				TweenService:Create(o, timed, { [prop] = value }):Play()
			end
		end
		hold(o, delay + info.Time + 0.05)
	end
end

export type EnterOptions = {
	from: string?, -- "up" (default: rises into place), "down", "left", "right", "pop", "fade"
	distance: number?, -- px a slide travels (default 24)
	gap: number?, -- seconds between items (default 0.035; keep the whole entrance under ~0.4 s)
	delay: number?, -- before the first item
	info: TweenInfo?, -- default Motion.T.enter (Motion.T.pop for "pop")
}

--- Plays the entrance of one or more elements, staggered in their visual order (LayoutOrder in a layout).
--- Slides and pops change Position and UIScale, which a UIListLayout/UIGridLayout owns: children of a
--- layout always fade instead. Reduce Motion: they are simply there.
function Motion.enter(items: { Instance }, opts: EnterOptions?)
	local o: EnterOptions = opts or {}
	local list: { GuiObject } = {}
	for _, item in items do
		if item:IsA("GuiObject") and item.Visible then
			table.insert(list, item)
		end
	end
	if #list == 0 or Motion.reduced() then
		return
	end
	local first = list[1]
	local parent = first.Parent
	local laidOut = parent ~= nil and parent:FindFirstChildWhichIsA("UIGridStyleLayout") ~= nil
	if laidOut then
		local index: { [GuiObject]: number } = {}
		for i, item in list do
			index[item] = i
		end
		table.sort(list, function(a, b)
			if a.LayoutOrder ~= b.LayoutOrder then
				return a.LayoutOrder < b.LayoutOrder
			end
			return (index[a] or 0) < (index[b] or 0)
		end)
	end
	local from = if laidOut then "fade" else (o.from or "up")
	local distance = o.distance or 24
	local gap = o.gap or 0.035
	local info = o.info or (if from == "pop" then Motion.T.pop else Motion.T.enter)
	for i, item in list do
		local delay = (o.delay or 0) + (i - 1) * gap
		local timed = TweenInfo.new(info.Time, info.EasingStyle, info.EasingDirection, 0, false, delay)
		if from == "pop" then
			local scale = scaleOf(item)
			local rest = remember(scale, "Scale")
			scale.Scale = rest * 0.6
			TweenService:Create(scale, timed, { Scale = rest }):Play()
			hold(scale, delay + info.Time + 0.05)
		elseif from ~= "fade" then
			local home = remember(item, "Position") :: UDim2
			local dx = if from == "left" then -distance elseif from == "right" then distance else 0
			local dy = if from == "up" then distance elseif from == "down" then -distance else 0
			item.Position = home + UDim2.fromOffset(dx, dy)
			TweenService:Create(item, timed, { Position = home }):Play()
			hold(item, delay + info.Time + 0.05)
		end
		fadeIn(item, if from == "pop" then Motion.T.enter else info, delay)
	end
end

local homes: { [GuiObject]: UDim2 } = setmetatable({}, { __mode = "k" }) :: any
local turns: { [GuiObject]: number } = setmetatable({}, { __mode = "k" }) :: any

local function homeOf(page: GuiObject): UDim2
	local home = homes[page]
	if not home then
		home = page.Position
		homes[page] = home
	end
	return home
end

--- Switches pages inside one parent (tabs, a carousel, the steps of a flow): the new page slides in, the
--- old one out and hides. direction 1 = the new page comes from the right, -1 from the left. Give the
--- parent ClipsDescendants = true. A page's resting Position is read the first time it swaps.
function Motion.swap(old: GuiObject?, new: GuiObject, direction: number?)
	if old == new then
		return
	end
	local dir = direction or 1
	local newHome = homeOf(new)
	turns[new] = (turns[new] or 0) + 1
	new.Visible = true
	if Motion.reduced() then
		new.Position = newHome
	else
		new.Position = newHome + UDim2.fromScale(dir, 0)
		TweenService:Create(new, Motion.T.page, { Position = newHome }):Play()
	end
	if not old then
		return
	end
	local leaving: GuiObject = old
	local oldHome = homeOf(leaving)
	turns[leaving] = (turns[leaving] or 0) + 1
	local mine = turns[leaving]
	local function hide()
		if turns[leaving] == mine then
			leaving.Visible = false
			leaving.Position = oldHome
		end
	end
	if Motion.reduced() then
		hide()
	else
		TweenService:Create(leaving, Motion.T.page, { Position = oldHome - UDim2.fromScale(dir, 0) }):Play()
		task.delay(Motion.T.page.Time, hide)
	end
end

--------------------------------------------------------------------------------------- Flights and cuts
-- A screen above the menus (DisplayOrder 90, below transitions) for things that fly between screens.
local function flightLayer(near: GuiObject): ScreenGui?
	local gui = near:FindFirstAncestorWhichIsA("LayerCollector")
	local home = if gui then gui.Parent else nil
	if not home then
		return nil
	end
	local found = home:FindFirstChild("MotionLayer")
	if found and found:IsA("ScreenGui") then
		return found
	end
	local layer = Instance.new("ScreenGui")
	layer.Name = "MotionLayer"
	layer.ResetOnSpawn = false
	layer.IgnoreGuiInset = true
	pcall(function()
		layer.ScreenInsets = Enum.ScreenInsets.None
	end)
	layer.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	layer.DisplayOrder = 90
	layer.Parent = home
	return layer
end

local function centre(o: GuiObject, layer: ScreenGui): Vector2
	return o.AbsolutePosition + o.AbsoluteSize / 2 - layer.AbsolutePosition
end

export type FlyOptions = {
	from: GuiObject | Vector3 | Vector2, -- an element, a world position, or a point in AbsolutePosition space
	to: GuiObject, -- where they land: the counter's icon (it gets a punch on each arrival)
	image: string,
	count: number?, -- icons (default 6; keep it under ~12)
	size: number?, -- icon size in pixels (default: the target's height, 24-72)
	color: Color3?,
	spread: number?, -- burst radius in pixels (default 70)
	seconds: number?, -- flight time (default 0.55)
	onEach: ((index: number) -> ())?, -- an icon arrived: tick the counter, play the sound
	onDone: (() -> ())?,
}

local rng = Random.new()

--- Reward icons that burst from a point and fly on a curve into a counter (coins from a chest, XP into the
--- bar). Flights are native tweens: the icon's holder moves across with Quad Out while the icon moves up or
--- down with Back In, which bends the path. Reduce Motion: no flight; onEach runs for every icon at once.
function Motion.fly(opts: FlyOptions)
	local count = opts.count or 6
	local layer = flightLayer(opts.to)
	local function finishAll()
		for i = 1, count do
			if opts.onEach then
				opts.onEach(i)
			end
		end
		if opts.onDone then
			opts.onDone()
		end
	end
	if Motion.reduced() or not layer then
		finishAll()
		return
	end
	local flyLayer: ScreenGui = layer
	local from = opts.from
	local start: Vector2
	if typeof(from) == "Vector3" then
		local p = workspace.CurrentCamera:WorldToScreenPoint(from)
		start = Vector2.new(p.X, p.Y) - flyLayer.AbsolutePosition
	elseif typeof(from) == "Vector2" then
		start = from - flyLayer.AbsolutePosition
	else
		start = centre(from :: GuiObject, flyLayer)
	end
	local px = opts.size or math.clamp(opts.to.AbsoluteSize.Y, 24, 72)
	local spread = opts.spread or 70
	local seconds = opts.seconds or 0.55
	local burst = TweenInfo.new(0.25, Back, Out)
	local across = TweenInfo.new(seconds, Quad, Out)
	local upDown = TweenInfo.new(seconds, Back, In)
	local arrived = 0
	for i = 1, count do
		local holder = Instance.new("Frame")
		holder.Name = "Flight"
		holder.BackgroundTransparency = 1
		holder.Size = UDim2.new()
		holder.Position = UDim2.fromOffset(start.X, start.Y)
		local icon = Instance.new("ImageLabel")
		icon.BackgroundTransparency = 1
		icon.AnchorPoint = Vector2.new(0.5, 0.5)
		icon.Size = UDim2.fromOffset(px, px)
		icon.Image = opts.image
		icon.ImageColor3 = opts.color or Color3.new(1, 1, 1)
		icon.ScaleType = Enum.ScaleType.Fit
		local grow = Instance.new("UIScale")
		grow.Scale = 0.3
		grow.Parent = icon
		icon.Parent = holder
		holder.Parent = flyLayer
		local angle = rng:NextNumber(0, 2 * math.pi)
		local out = start + Vector2.new(math.cos(angle), math.sin(angle)) * spread * rng:NextNumber(0.4, 1)
		TweenService:Create(holder, burst, { Position = UDim2.fromOffset(out.X, out.Y) }):Play()
		TweenService:Create(grow, burst, { Scale = 1 }):Play()
		task.delay(0.3 + (i - 1) * 0.05, function()
			if not holder.Parent then
				return
			end
			local goal = centre(opts.to, flyLayer) -- read now: the target may have moved
			TweenService:Create(holder, across, { Position = UDim2.fromOffset(goal.X, out.Y) }):Play()
			TweenService:Create(icon, upDown, { Position = UDim2.fromOffset(0, goal.Y - out.Y) }):Play()
			TweenService:Create(grow, across, { Scale = 0.7 }):Play()
			task.delay(seconds, function()
				holder:Destroy()
				Motion.punch(opts.to, 0.1)
				if opts.onEach then
					opts.onEach(i)
				end
				arrived += 1
				if arrived == count and opts.onDone then
					opts.onDone()
				end
			end)
		end)
	end
end

export type TransitionOptions = {
	style: string?, -- "fade" (default), "wipe" (a panel sweeps across), "iris" (a circle grows to cover)
	color: Color3?, -- default black
	seconds: number?, -- each way (default 0.3)
	parent: Instance?, -- default the local player's PlayerGui
	onDone: (() -> ())?,
}

--- Covers the screen, calls `swap` once it is covered (change screens, move the camera, teleport), then
--- uncovers. The cover takes clicks while it is up. Reduce Motion: a short fade whatever the style.
function Motion.transition(swap: () -> (), opts: TransitionOptions?)
	local o: TransitionOptions = opts or {}
	local playerGui = Players.LocalPlayer and Players.LocalPlayer:FindFirstChildOfClass("PlayerGui")
	local parent = o.parent or playerGui
	local function swapSafely()
		local ok, err = pcall(function()
			swap()
			return true
		end)
		if not ok then
			warn("Motion.transition: swap failed: " .. tostring(err))
		end
	end
	if not parent then
		swapSafely()
		if o.onDone then
			o.onDone()
		end
		return
	end
	local reduced = Motion.reduced()
	local style = if reduced then "fade" else (o.style or "fade")
	local half = if reduced then math.min(o.seconds or 0.3, 0.15) else (o.seconds or 0.3)
	local gui = Instance.new("ScreenGui")
	gui.Name = "MotionTransition"
	gui.DisplayOrder = 100
	gui.IgnoreGuiInset = true
	gui.ResetOnSpawn = false
	pcall(function()
		gui.ScreenInsets = Enum.ScreenInsets.None
	end)
	local cover = Instance.new("TextButton") -- a button, so clicks during the cut don't reach the game's UI
	cover.Name = "Cover"
	cover.Text = ""
	cover.AutoButtonColor = false
	cover.Selectable = false
	cover.BorderSizePixel = 0
	cover.BackgroundColor3 = o.color or Color3.new(0, 0, 0)
	local inInfo = TweenInfo.new(half, Quad, In)
	local outInfo = TweenInfo.new(half, Quad, Out)
	local coverGoal: Goal, uncoverGoal: Goal
	if style == "wipe" then
		cover.Size = UDim2.fromScale(1, 1)
		cover.Position = UDim2.fromScale(-1, 0)
		coverGoal, uncoverGoal = { Position = UDim2.fromScale(0, 0) }, { Position = UDim2.fromScale(1, 0) }
	elseif style == "iris" then
		local diagonal = workspace.CurrentCamera.ViewportSize.Magnitude + 8
		local round = Instance.new("UICorner")
		round.CornerRadius = UDim.new(0.5, 0)
		round.Parent = cover
		cover.AnchorPoint = Vector2.new(0.5, 0.5)
		cover.Position = UDim2.fromScale(0.5, 0.5)
		cover.Size = UDim2.new()
		coverGoal, uncoverGoal = { Size = UDim2.fromOffset(diagonal, diagonal) }, { Size = UDim2.new() }
	else
		cover.Size = UDim2.fromScale(1, 1)
		cover.BackgroundTransparency = 1
		coverGoal, uncoverGoal = { BackgroundTransparency = 0 }, { BackgroundTransparency = 1 }
	end
	cover.Parent = gui
	gui.Parent = parent
	TweenService:Create(cover, inInfo, coverGoal):Play()
	task.delay(half, function()
		swapSafely()
		TweenService:Create(cover, outInfo, uncoverGoal):Play()
		task.delay(half, function()
			gui:Destroy()
			if o.onDone then
				o.onDone()
			end
		end)
	end)
end

------------------------------------------------------------------------------------------------- Scopes
export type Step = {
	at: number, -- seconds from the start
	target: Instance?, -- tween this ...
	info: TweenInfo?, -- (default Motion.T.enter)
	goal: Goal?,
	call: (() -> ())?, -- ... and/or call this
}

export type Key = {
	at: number, -- seconds from the start
	value: any, -- the property's value at that moment
	ease: (Enum.EasingStyle | (number) -> number)?, -- how it gets here from the key before (default Quad)
	direction: Enum.EasingDirection?, -- for an EasingStyle (default Out)
}

export type KeyframeOptions = {
	loop: boolean?, -- start over after the last key (an idle, a logo's breathing); stops with the scope
	onDone: (() -> ())?, -- after the last key (not called for loops)
}

export type Scope = {
	tween: (self: Scope, target: Instance, info: TweenInfo, goal: Goal) -> Tween,
	timeline: (self: Scope, steps: { Step }) -> (),
	keyframes: (self: Scope, target: Instance, tracks: { [string]: { Key } }, opts: KeyframeOptions?) -> (),
	loop: (self: Scope, target: Instance, info: TweenInfo, goal: Goal) -> (),
	pulse: (self: Scope, target: GuiObject, amount: number?, seconds: number?) -> (),
	float: (self: Scope, target: GuiObject, pixels: number?, seconds: number?) -> (),
	spin: (self: Scope, target: GuiObject | UIGradient, secondsPerTurn: number?) -> (),
	shimmer: (self: Scope, target: GuiObject, every: number?) -> (),
	flipbook: (self: Scope, image: ImageLabel | ImageButton, sheet: Sheet, onDone: (() -> ())?) -> (),
	add: (self: Scope, cleanup: () -> ()) -> (),
	stop: (self: Scope) -> (),
	jobs: { [any]: () -> () },
}

-- Ambient motion marks the element it runs on (attribute MotionLoops: how many run there), so ui_audit can
-- flag loops still running in a hidden screen.
local function mark(target: Instance, delta: number)
	local host = if target:IsA("GuiObject") then target else target.Parent
	if host then
		local n = host:GetAttribute("MotionLoops")
		local count = (if typeof(n) == "number" then n else 0) + delta
		host:SetAttribute("MotionLoops", if count > 0 then count else nil)
	end
end

-- Runs `cleanup` once, when the scope stops, Reduce Motion turns on, or the target is destroyed.
local function ambient(self: Scope, target: Instance, cleanup: () -> ())
	local key = {}
	local stopped = false
	local destroying: RBXScriptConnection
	local function stop()
		if stopped then
			return
		end
		stopped = true
		self.jobs[key] = nil
		live[key] = nil
		destroying:Disconnect()
		cleanup()
		mark(target, -1)
	end
	destroying = target.Destroying:Connect(stop)
	mark(target, 1)
	self.jobs[key] = stop
	live[key] = stop
	return stop
end

local function scopeTween(self: Scope, target: Instance, info: TweenInfo, goal: Goal): Tween
	local tween = Motion.tween(target, info, goal)
	local key = {}
	self.jobs[key] = function()
		tween:Cancel()
	end
	tween.Completed:Once(function()
		self.jobs[key] = nil
	end)
	return tween
end

local function scopeTimeline(self: Scope, steps: { Step })
	local reduced = Motion.reduced()
	for _, s in steps do
		local function run()
			if s.call then
				s.call()
			end
			if s.target and s.goal then
				self:tween(s.target, s.info or Motion.T.enter, s.goal)
			end
		end
		if reduced or s.at <= 0 then
			run()
		else
			local key = {}
			local thread = task.delay(s.at, function()
				self.jobs[key] = nil
				run()
			end)
			self.jobs[key] = function()
				task.cancel(thread)
			end
		end
	end
end

-- Keyframe tracks: every segment between two keys is one native tween (or a curve for a function easing),
-- started on time by one thread; a loop starts over from the first keys.
local function scopeKeyframes(self: Scope, target: Instance, tracks: { [string]: { Key } }, opts: KeyframeOptions?)
	local o: KeyframeOptions = opts or {}
	type Segment = { at: number, prop: string, seconds: number, to: any, ease: (Enum.EasingStyle | (number) -> number)?, direction: Enum.EasingDirection? }
	local segments: { Segment } = {}
	local first: Goal, final: Goal = {}, {}
	local length = 0
	for prop, keys in tracks do
		local sorted = table.clone(keys)
		table.sort(sorted, function(a, b)
			return a.at < b.at
		end)
		if #sorted == 0 then
			continue
		end
		-- A track whose first key is later than 0 starts from the property's current value.
		first[prop] = if sorted[1].at <= 0 then sorted[1].value else get(target, prop)
		final[prop] = sorted[#sorted].value
		local fromAt = if sorted[1].at <= 0 then sorted[1].at else 0
		for i, key in sorted do
			if i == 1 and key.at <= 0 then
				continue
			end
			local before = if i == 1 then fromAt else sorted[i - 1].at
			table.insert(segments, { at = before, prop = prop, seconds = key.at - before, to = key.value, ease = key.ease, direction = key.direction })
			length = math.max(length, key.at)
		end
	end
	table.sort(segments, function(a, b)
		return a.at < b.at
	end)
	if Motion.reduced() then
		set(target, final)
		if o.onDone then
			task.defer(o.onDone)
		end
		return
	end
	local running: { [string]: () -> () } = {}
	local key = {}
	local function halt(prop: string)
		local stop = running[prop]
		if stop then
			running[prop] = nil
			stop()
		end
	end
	local thread = task.spawn(function()
		repeat
			local started = os.clock()
			set(target, first)
			for _, seg in segments do
				local wait = seg.at - (os.clock() - started)
				if wait > 0 then
					task.wait(wait)
				end
				halt(seg.prop)
				local ease = seg.ease
				if typeof(ease) == "function" then
					running[seg.prop] = Motion.curve(target, seg.seconds, { [seg.prop] = seg.to }, ease)
				else
					local style = if typeof(ease) == "EnumItem" then ease else Quad
					local tween = TweenService:Create(target, TweenInfo.new(seg.seconds, style, seg.direction or Out), { [seg.prop] = seg.to })
					tween:Play()
					running[seg.prop] = function()
						tween:Cancel()
					end
				end
			end
			local rest = length - (os.clock() - started)
			if rest > 0 then
				task.wait(rest)
			end
		until not o.loop
		self.jobs[key] = nil
		if o.onDone then
			o.onDone()
		end
	end)
	local function cancel()
		if coroutine.status(thread) == "suspended" then
			task.cancel(thread)
		end
		for prop in running do
			halt(prop)
		end
	end
	if o.loop then
		ambient(self, target, function()
			cancel()
			set(target, first)
		end)
	elseif coroutine.status(thread) ~= "dead" then
		self.jobs[key] = cancel
	end
end

local function scopeLoop(self: Scope, target: Instance, info: TweenInfo, goal: Goal)
	if Motion.reduced() then
		return
	end
	local start: Goal = {}
	for prop in goal do
		start[prop] = get(target, prop)
	end
	local forever = TweenInfo.new(info.Time, info.EasingStyle, info.EasingDirection, if info.RepeatCount == 0 then -1 else info.RepeatCount, info.Reverses, info.DelayTime)
	local tween = TweenService:Create(target, forever, goal)
	tween:Play()
	ambient(self, target, function()
		tween:Cancel()
		set(target, start)
	end)
end

local function scopePulse(self: Scope, target: GuiObject, amount: number?, seconds: number?)
	local scale = scaleOf(target)
	self:loop(scale, TweenInfo.new((seconds or 1.2) / 2, Sine, InOut, -1, true), { Scale = scale.Scale * (1 + (amount or 0.06)) })
end

local function scopeFloat(self: Scope, target: GuiObject, pixels: number?, seconds: number?)
	self:loop(target, TweenInfo.new((seconds or 2.4) / 2, Sine, InOut, -1, true), { Position = target.Position - UDim2.fromOffset(0, pixels or 6) })
end

local function scopeSpin(self: Scope, target: GuiObject | UIGradient, secondsPerTurn: number?)
	local rotation = get(target, "Rotation") :: number
	self:loop(target, TweenInfo.new(secondsPerTurn or 6, Enum.EasingStyle.Linear, In, -1), { Rotation = rotation + 360 })
end

local function scopeShimmer(self: Scope, target: GuiObject, every: number?)
	if Motion.reduced() then
		return
	end
	local shine = Instance.new("Frame")
	shine.Name = "Shine"
	shine.BackgroundColor3 = Color3.new(1, 1, 1)
	shine.BorderSizePixel = 0
	shine.Size = UDim2.fromScale(1, 1)
	shine.ZIndex = 50 -- over the element's own children (ZIndexBehavior Sibling)
	local round = target:FindFirstChildOfClass("UICorner")
	if round then
		round:Clone().Parent = shine
	end
	local band = Instance.new("UIGradient")
	band.Rotation = 20
	band.Transparency = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 1),
		NumberSequenceKeypoint.new(0.4, 1),
		NumberSequenceKeypoint.new(0.5, 0.6),
		NumberSequenceKeypoint.new(0.6, 1),
		NumberSequenceKeypoint.new(1, 1),
	})
	band.Offset = Vector2.new(-1, 0)
	band.Parent = shine
	shine.Parent = target
	local sweep = TweenInfo.new(0.7, Quad, InOut)
	local thread = task.spawn(function()
		while true do
			band.Offset = Vector2.new(-1, 0)
			TweenService:Create(band, sweep, { Offset = Vector2.new(1, 0) }):Play()
			task.wait(sweep.Time + (every or 3))
		end
	end)
	ambient(self, target, function()
		task.cancel(thread)
		shine:Destroy()
	end)
end

local function scopeFlipbook(self: Scope, image: ImageLabel | ImageButton, sheet: Sheet, onDone: (() -> ())?)
	local book: Book = { image = image, sheet = sheet, t = 0, shown = -1, onDone = onDone, finish = function() end }
	if Motion.reduced() then
		showFrame(book, sheet.still or 0)
		if onDone and sheet.loop == false then
			task.defer(onDone)
		end
		return
	end
	showFrame(book, 0)
	books[book] = true
	book.finish = ambient(self, image, function()
		books[book] = nil
	end)
	wake()
end

local function scopeAdd(self: Scope, cleanup: () -> ())
	self.jobs[{}] = cleanup
end

local function scopeStop(self: Scope)
	local jobs = {}
	for _, job in self.jobs do
		table.insert(jobs, job)
	end
	table.clear(self.jobs)
	for _, job in jobs do
		local ok, err = pcall(function()
			job()
			return true
		end)
		if not ok then
			warn("Motion: a cleanup failed: " .. tostring(err))
		end
	end
end

--- A group of animations that stop together: scope:stop(), or by itself when `owner` is destroyed, hidden
--- (a GuiObject's Visible = false) or disabled (a ScreenGui's Enabled = false). Stopping cancels its
--- tweens and timeline steps and puts every loop back where it started. A stopped scope can be used again
--- (start the loops again when the screen reopens).
function Motion.scope(owner: Instance?): Scope
	local self: Scope = {
		tween = scopeTween,
		timeline = scopeTimeline,
		keyframes = scopeKeyframes,
		loop = scopeLoop,
		pulse = scopePulse,
		float = scopeFloat,
		spin = scopeSpin,
		shimmer = scopeShimmer,
		flipbook = scopeFlipbook,
		add = scopeAdd,
		stop = scopeStop,
		jobs = {},
	}
	if owner then
		owner.Destroying:Connect(function()
			self:stop()
		end)
		if owner:IsA("LayerCollector") then
			local gui = owner
			gui:GetPropertyChangedSignal("Enabled"):Connect(function()
				if not gui.Enabled then
					self:stop()
				end
			end)
		elseif owner:IsA("GuiObject") then
			local element = owner
			element:GetPropertyChangedSignal("Visible"):Connect(function()
				if not element.Visible then
					self:stop()
				end
			end)
		end
	end
	return self
end

--- What runs now: springs, flipbooks and curves on the frame step, ambient loops, and whether the per-frame
--- connection exists (false when nothing needs it: idle costs nothing).
function Motion.stats(): { springs: number, flipbooks: number, curves: number, loops: number, stepping: boolean }
	local s, f, c, l = 0, 0, 0, 0
	for _, props in springs do
		for _ in props do
			s += 1
		end
	end
	for _ in books do
		f += 1
	end
	for _ in clips do
		c += 1
	end
	for _ in live do
		l += 1
	end
	return { springs = s, flipbooks = f, curves = c, loops = l, stepping = stepper ~= nil }
end

return Motion
```

## Recipes
A window whose content arrives in order, with one ambient element that stops when it closes:
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)

local screen = Ui.screen("Quests", 10, Players.LocalPlayer:WaitForChild("PlayerGui"))
local window = Ui.window(screen, "Daily quests", Vector2.new(720, 520))
local list = Instance.new("Frame")
list.BackgroundTransparency = 1
list.Size = UDim2.fromScale(1, 1)
local column = Instance.new("UIListLayout")
column.Padding = UDim.new(0, 12)
column.SortOrder = Enum.SortOrder.LayoutOrder
column.Parent = list
list.Parent = window.body
for i, quest in { "Win 3 rounds", "Collect 500 coins", "Open an egg" } do
	local row = Ui.button(list, quest, "secondary")
	row.AutomaticSize = Enum.AutomaticSize.None
	row.Size = UDim2.new(1, 0, 0, 64)
	row.LayoutOrder = i
end
local claim = Ui.button(window.body, "Claim all", "primary")
claim.AnchorPoint = Vector2.new(1, 1)
claim.Position = UDim2.fromScale(1, 1)

window.opened.Event:Connect(function()
	Motion.enter(list:GetChildren(), { delay = 0.08 }) -- rows of a list fade in, staggered
	Motion.enter({ claim }, { from = "pop", delay = 0.2 }) -- the call to action lands last
	window.motion:pulse(claim, 0.04, 1.6) -- stops by itself when the window closes
end)
window.open()
```
Keyframes and curves: a logo that drops in, squashes on landing and settles, then breathes while the title
screen is up (the loop stops with the screen):
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)

local gui = Players.LocalPlayer:WaitForChild("PlayerGui"):WaitForChild("Title") :: ScreenGui
local logo = gui:WaitForChild("Logo") :: ImageLabel
local scale = logo:FindFirstChildOfClass("UIScale") or Instance.new("UIScale")
scale.Parent = logo
local fx = Motion.scope(gui)
local home = logo.Position
local soft = Motion.bezier(0.2, 0.8, 0.2, 1)
fx:keyframes(logo, {
	Position = {
		{ at = 0, value = home - UDim2.fromOffset(0, 120) },
		{ at = 0.35, value = home, ease = Enum.EasingStyle.Quad, direction = Enum.EasingDirection.In },
	},
	ImageTransparency = { { at = 0, value = 1 }, { at = 0.2, value = 0 } },
	Rotation = { { at = 0, value = -6 }, { at = 0.6, value = 0, ease = soft } },
}, {
	onDone = function()
		fx:keyframes(scale, {
			Scale = { { at = 0, value = 1 }, { at = 1.6, value = 1.04, ease = Enum.EasingStyle.Sine, direction = Enum.EasingDirection.InOut }, { at = 3.2, value = 1, ease = Enum.EasingStyle.Sine, direction = Enum.EasingDirection.InOut } },
		}, { loop = true })
	end,
})
-- The landing squash: 0.35 s in, a quick spring dip and back.
task.delay(0.35, function()
	Motion.spring(scale, { Scale = 0.92 }, 9, 1)
	task.delay(0.06, function()
		Motion.spring(scale, { Scale = 1 }, 4, 0.4)
	end)
end)
```
Sprite-sheet flipbook (a 4x4 sheet of 256-px frames, at most 1024x1024: Roblox shrinks bigger uploads), a
rainbow stroke for the top rarity, a path swoop and a scene cut:
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)

local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
local gui = playerGui:WaitForChild("Shop") :: ScreenGui
local fx = Motion.scope(gui)

-- A looping sprite animation (fire, a spinning coin) on an ImageLabel whose Image is the sheet.
local flame = gui:WaitForChild("Flame") :: ImageLabel
fx:flipbook(flame, { frame = Vector2.new(256, 256), count = 16, columns = 4, fps = 20 })

-- An animated rainbow edge: a UIStroke with a UIGradient child, the gradient spinning.
local mythic = gui:WaitForChild("MythicSlot") :: Frame
local edge = Instance.new("UIStroke")
edge.Thickness = 3
edge.Color = Color3.new(1, 1, 1)
edge.Parent = mythic
local rainbow = Instance.new("UIGradient")
rainbow.Color = ColorSequence.new({
	ColorSequenceKeypoint.new(0, Color3.fromHex("FF3B6B")),
	ColorSequenceKeypoint.new(0.33, Color3.fromHex("FFB020")),
	ColorSequenceKeypoint.new(0.66, Color3.fromHex("3AA0FF")),
	ColorSequenceKeypoint.new(1, Color3.fromHex("FF3B6B")),
})
rainbow.Parent = edge
fx:spin(rainbow, 3)
fx:shimmer(mythic, 2.5)

-- A tutorial hand that swoops along a curve to the button it points at.
local hand = gui:WaitForChild("Hand") :: ImageLabel
fx:add(Motion.path(hand, { hand.Position, UDim2.fromScale(0.4, 0.3), UDim2.fromScale(0.62, 0.55) }, 0.9))

-- A cut to another screen: cover, swap, uncover.
Motion.transition(function()
	gui.Enabled = false
	local hud = playerGui:FindFirstChild("GameHud")
	if hud and hud:IsA("ScreenGui") then
		hud.Enabled = true
	end
end, { style = "wipe" })
```

## Verification
- `luau_check` clean; in a playtest (roblox_playtest "run" with a client probe): after a scope's screen is
  disabled, `Motion.stats().loops` is 0 for it and its elements have no `MotionLoops` attribute; once every
  spring and flipbook has settled, `Motion.stats().stepping` is false.
- `Motion.setReduced(true)` in the probe, then open the screen again: everything lands at once, nothing loops,
  and the screen still reads (nothing important was only in the motion).
- `ui_audit` shows no "loops still run while hidden" warnings.
