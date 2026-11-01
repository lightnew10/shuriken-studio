---
name: roblox-game-hud
description: "Build polished game HUDs in code: a tested kit (theme, safe-area screen with UIScale, bar with a damage trail, cooldown slots, feed, toast, floating world text, a currency counter that counts and pops) on the Motion module that follows the player's Reduce Motion and Background Transparency settings, plus a HUD layout per device (phone either way up, tablet, desktop, TV) and key hints that follow the input, a style guide, mobile buttons through ContextActionService, and the mistakes that make Roblox UI look amateur."
version: 4
tags: [ui, hud, gui, interface, health, healthbar, cooldown, hotbar, killfeed, toast, damage, numbers, mobile, touch, layout, style]
roblox_systems: [ScreenGui, Frame, TextLabel, TextButton, UIScale, UICorner, UIStroke, UIGradient, UIListLayout, BillboardGui, TweenService, ContextActionService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [roblox_sync_push, roblox_playtest, roblox_screenshot, ui_audit, luau_check, task_add_evidence]
---
# Game HUDs in code

## Purpose
Players read the HUD every second: health, cooldowns, what just happened. A good one is small,
consistent and readable on a phone. This skill gives a lint-clean kit (checked in a playtest: bars,
slots, feed caps and cleanup) so UI tasks start from solid pieces and spend their time on the game's
look, not on re-deriving tween code. For the look itself (tokens, palettes, genre layouts, zone sizes,
the polish checklist) use skill "roblox-ui-references".

## Preconditions
- UI lives in client code (`src/Client/UI/...`) built at runtime; state comes from attributes and
  remotes the systems publish (health from the Humanoid, cooldowns as attributes, events as remotes).
- The kit module sits in shared code: `src/Shared/Hud.luau` in a new project (Examples); in a
  plugged-in game, beside its other shared modules in ReplicatedStorage — require it from there. It needs
  **Motion** (skill roblox-ui-motion, `src/Shared/Motion.luau`) in the same folder: put that in first. A game
  that already holds an older copy (no "Kit v4" line in its header, no `Hud.device`) should replace it with
  this one (and add Motion): the older functions work the same. New in v4: `Hud.input`, `Hud.device`,
  `Hud.onDevice` (move pieces per form factor), `Hud.counter` (a currency pill that counts and pops: the
  target for `Motion.fly`), cooldown key hints that follow the input (`button` = the gamepad key), a 20%
  bigger fit on a TV.

## Workflow
1. **Screen**: `Hud.screen("GameHud")` — ResetOnSpawn off, inside the device safe area
   (`ScreenInsets = DeviceSafeInsets`), and a UIScale keyed to the shorter screen side so the same
   offsets work on phones (scale ~0.6) and big monitors (~1.4).
2. **Layout by zones**: vitals bottom-center, abilities just above them, feed top-right, objective and
   timers top-center, minimap/score top-left. Keep the bottom-right thumb zone empty on touch devices
   (the jump button lives there) and leave room for mobile action buttons.
   **Per device** (`Hud.onDevice(screen, place)` moves the pieces when the form, orientation or input
   changes; HUD canvas in design px): a **landscape phone** (1260x650) puts abilities in a 2x2 cluster left
   of the jump button (no key hints: touch), vitals smaller above the hotbar, the feed down to 3 rows and
   counters abbreviated; an **upright phone** (650x1272, only if the game allows portrait) stacks vitals
   at the top, abilities above the thumbs; **tablet** and **desktop** (about 1300-1600 x 900) use the zones
   above with key hints; a **TV** (1333x750, the kit fits it 20% bigger) keeps everything 5% in from the
   edges and shows gamepad glyphs (`cooldownSlot`'s `button`). Input changes hints, never the layout.
3. **Pieces**: `Hud.bar` (health/stamina with a trail that shows the size of each hit), `Hud.cooldownSlot`
   (key hint, name, shade that drains, seconds left, a flash when ready), `Hud.feed` (kills, pickups;
   capped and fading), `Hud.toast` (round starts, checkpoints), `Hud.floatingText` (damage numbers at the
   contact point), `Hud.counter` (coins, gems: counts to each value and pops its icon; reward icons fly into
   `counter.icon` with `Motion.fly`). A HUD built from a mockup gets its look from the Ui kit's helpers (skill
   roblox-ui-design, "Building a mockup": require Ui beside Hud): `Ui.gradient` fades (a timer strip fading
   out to the right), `Ui.stroke` layered edges and outlined numbers, `Ui.glow`, `Ui.badge` (count badges on
   rail buttons), `Ui.shape` (angled sci-fi panels from `ui_icon {shapes}`), `Ui.react` (button states);
   line-art symbols (a missile, a bolt, a timer) are `ui_icon {icons: [{name, glyph}]}`.
4. **Wire to state**: `humanoid.HealthChanged` → `bar.set`; cooldown attributes (a server timestamp) →
   `slot.start(remaining)`; remotes → `feed.push` / `Hud.floatingText`. Re-hook on `CharacterAdded`.
5. **Touch**: bind actions once with `ContextActionService:BindAction(name, handler, true, inputs…)`
   — `true` creates a touch button; position it with `SetPosition` and label with `SetTitle`, so mouse,
   keyboard, gamepad and touch share one handler.
6. **Check it**: `ui_audit` on every form of the device matrix (skill roblox-ui-design, Devices and
   platforms), screenshots in a playtest, long names and big numbers, and while the character dies and
   respawns. Animation beyond the kit's own goes through Motion (skill roblox-ui-motion).

## Known pitfalls
- **Offset-only sizes** look tiny on 4K and huge on phones: use the UIScale (or Scale sizes).
- **Text without a stroke or backing** disappears over bright skies; the kit strokes every label.
- **TextScaled without a max size** grows absurdly on big screens: the kit adds UITextSizeConstraint.
- **ResetOnSpawn = true** (the default) wipes the HUD on every death and double-connects events.
- **Creating instances every frame** (numbers, bars) leaks: create once, update properties; floating
  text is cleaned up with Debris.
- **Covering the center** of the screen with panels; players aim there.
- **Inconsistent style**: one font family (two weights), one corner radius, 3–4 colors from the theme.
- **Tweens only run while the window renders**: in Studio with the display asleep, tweens and
  RenderStepped freeze (headless probes see start values); check visuals with the display on.
- **Ignoring player settings**: Reduce Motion and Background Transparency are accessibility settings. The
  kit snaps bar tweens, skips the toast slide and the damage-number float (`Hud.reducedMotion()`, which is
  Motion's: the player's setting or the game's own switch), and
  builds panels with `Hud.alpha(base)`. The cooldown sweep keeps running: it shows the time left.
- **Top-bar overlap**: `Hud.screen` uses DeviceSafeInsets, so its top corners can sit under Roblox's
  top-bar buttons (the audit flags the top 58 pt, the left 180 pt and the right 120 pt): put pieces
  top-centre, or start corner pieces about 100 HUD px down (60 pt on a phone).

## Verification
- Playtest probe (client): create the screen and pieces, `bar.set(60, 100)` shows "60 / 100";
  `slot.start(1)` makes `ready()` false, then true after a second; pushing 5 feed rows with `max = 3`
  leaves 3 rows.
- `ui_audit` lays the UI out on a phone (844×390, notch insets), a tablet and a desktop the way Roblox
  does, reading PlayerGui from a short playtest when scripts build the UI (as this kit does): no
  "problem" left (off the screen, buttons covering each other, pieces running into each other), and
  the warnings fixed or explained (tap targets under 44 points on a phone, text under 12 points, cut
  off or low contrast, buttons under Roblox's top bar). Menus a script opens later are checked as if
  shown. The user sees the same result in the UI panel.
- Screenshots at phone and desktop sizes show nothing clipped or overlapping, text readable over the sky.
- No console errors when the character dies and respawns.

## Examples
Kit — `src/Shared/Hud.luau`:
```lua
--!strict
-- A small HUD kit for game UI built in code: one theme, safe-area aware screens, and the pieces most
-- games need — a bar with a damage trail, cooldown slots, a feed (kills, pickups), toasts and
-- floating world text. Everything scales from phone to desktop (sizes in Scale + UIScale).
-- Kit v4: needs Motion (skill roblox-ui-motion) in the same folder: tweens and Reduce Motion come from there
-- (Hud.reducedMotion). Device forms (Hud.device, Hud.onDevice: a HUD layout per phone, tablet, desktop, tv),
-- key hints that follow the input, a currency counter (Hud.counter), Background Transparency (Hud.alpha) and
-- a bigger fit on a TV (the 10-foot interface).
--   local Hud = require(game.ReplicatedStorage.Shared.Hud)
--   local screen = Hud.screen("GameHud")
--   local health = Hud.bar(screen, { position = UDim2.new(0.5, 0, 1, -24), anchor = Vector2.new(0.5, 1), color = Hud.theme.bad })
--   health.set(humanoid.Health, humanoid.MaxHealth)
local Players = game:GetService("Players")
local GuiService = game:GetService("GuiService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")
local Debris = game:GetService("Debris")

local Motion = require(script.Parent.Motion)

local Hud = {}

Hud.theme = {
	panel = Color3.fromRGB(20, 18, 24),
	panelAlpha = 0.25, -- BackgroundTransparency of panels
	text = Color3.fromRGB(245, 242, 236),
	dim = Color3.fromRGB(170, 164, 156),
	accent = Color3.fromRGB(255, 176, 64),
	good = Color3.fromRGB(96, 214, 128),
	bad = Color3.fromRGB(235, 76, 76),
	info = Color3.fromRGB(96, 170, 255),
	stroke = Color3.fromRGB(0, 0, 0),
	font = Font.fromEnum(Enum.Font.GothamBold),
	heavy = Font.fromEnum(Enum.Font.GothamBlack),
	corner = UDim.new(0, 10),
}

--- Whether motion is reduced (the player's Reduce Motion setting, or the game's toggle: Motion.setReduced).
function Hud.reducedMotion(): boolean
	return Motion.reduced()
end

--- A panel's BackgroundTransparency adjusted by the player's Background Transparency setting (1 = as
--- designed, lower = more opaque). Returns `base` where the setting doesn't exist.
function Hud.alpha(base: number): number
	local ok, preferred = pcall(function()
		return GuiService.PreferredTransparency
	end)
	return if ok then math.clamp(base * preferred, 0, 1) else base
end

--- Plays a tween (Motion.tween); with Reduce Motion on it lands at once.
local function play(target: Instance, info: TweenInfo, goal: { [string]: any }): Tween
	return Motion.tween(target, info, goal)
end

export type Input = "touch" | "gamepad" | "mouse"

--- The player's input right now (PreferredInput; the last input type where it doesn't exist).
function Hud.input(): Input
	local ok, preferred = pcall(function()
		return UserInputService.PreferredInput
	end)
	if ok then
		if preferred == Enum.PreferredInput.Gamepad or preferred == Enum.PreferredInput.MicroGamepad then
			return "gamepad"
		end
		return if preferred == Enum.PreferredInput.Touch then "touch" else "mouse"
	end
	local last = UserInputService:GetLastInputType()
	if last == Enum.UserInputType.Touch then
		return "touch"
	end
	return if string.sub(last.Name, 1, 7) == "Gamepad" then "gamepad" else "mouse"
end

local function corner(parent: Instance, radius: UDim?)
	local c = Instance.new("UICorner")
	c.CornerRadius = radius or Hud.theme.corner
	c.Parent = parent
end

local function stroke(parent: Instance, thickness: number, transparency: number?)
	local s = Instance.new("UIStroke")
	s.Color = Hud.theme.stroke
	s.Thickness = thickness
	s.Transparency = transparency or 0.2
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual
	s.Parent = parent
end

local function label(parent: Instance, text: string, size: UDim2, font: Font?): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Size = size
	l.FontFace = font or Hud.theme.font
	l.Text = text
	l.TextColor3 = Hud.theme.text
	l.TextScaled = true
	l.Parent = parent
	local limit = Instance.new("UITextSizeConstraint")
	limit.MaxTextSize = 28
	limit.Parent = l
	stroke(l, 1.5, 0.35)
	return l
end

--- A ScreenGui for the local player that stays across respawns, inside the device's safe area, and
--- scales with the screen (a UIScale keyed to the shorter side: 1 at 900 px).
function Hud.screen(name: string): ScreenGui
	local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
	local old = playerGui:FindFirstChild(name)
	if old then
		old:Destroy()
	end
	local gui = Instance.new("ScreenGui")
	gui.Name = name
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = false
	gui.ScreenInsets = Enum.ScreenInsets.DeviceSafeInsets
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	local scale = Instance.new("UIScale")
	-- The fitting rule, declared so ui_audit can lay the HUD out per device (a TV gets 20% more).
	scale:SetAttribute("FitReference", Vector2.new(900, 900))
	scale:SetAttribute("FitRange", NumberRange.new(0.6, 1.4))
	scale:SetAttribute("FitTenFoot", 1.2)
	scale.Parent = gui
	local boost = if GuiService:IsTenFootInterface() then 1.2 else 1
	local function fit()
		local size = gui.AbsoluteSize
		scale.Scale = math.clamp(math.min(size.X, size.Y) / 900, 0.6, 1.4) * boost
	end
	gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(fit)
	gui.Parent = playerGui
	fit()
	return gui
end

export type Form = "phone" | "tablet" | "desktop" | "tv"

export type Device = { form: Form, portrait: boolean, input: Input, points: Vector2 }

--- The HUD's form factor now (the same breakpoints as Ui.device): "phone" when the shorter side is under
--- 500 points, "tablet" when the longer side is under 1300, "desktop" above, "tv" on a 10-foot interface.
function Hud.device(screen: ScreenGui): Device
	local points = screen.AbsoluteSize
	local short, long = math.min(points.X, points.Y), math.max(points.X, points.Y)
	local form: Form = if GuiService:IsTenFootInterface() then "tv" elseif short < 500 then "phone" elseif long < 1300 then "tablet" else "desktop"
	return { form = form, portrait = points.Y > points.X, input = Hud.input(), points = points }
end

--- Calls place(device) now and whenever the form, orientation or input changes: move the HUD's pieces
--- there (a phone puts abilities in a cluster left of the jump button, a TV keeps 5% from the edges).
--- Returns a function that stops listening.
function Hud.onDevice(screen: ScreenGui, place: (device: Device) -> ()): () -> ()
	local last = ""
	local function check()
		local d = Hud.device(screen)
		local key = d.form .. (if d.portrait then "/portrait/" else "/landscape/") .. d.input
		if key ~= last and d.points.X > 0 then
			last = key
			place(d)
		end
	end
	local connections = { screen:GetPropertyChangedSignal("AbsoluteSize"):Connect(check) }
	pcall(function()
		table.insert(connections, UserInputService:GetPropertyChangedSignal("PreferredInput"):Connect(check))
	end)
	check()
	return function()
		for _, c in connections do
			c:Disconnect()
		end
	end
end

export type Bar = { frame: Frame, set: (value: number, max: number) -> () }

--- A bar (health, stamina, guard) with a white trail that catches up after a hit.
function Hud.bar(parent: Instance, opts: { position: UDim2, anchor: Vector2?, size: UDim2?, color: Color3?, label: boolean? }): Bar
	local frame = Instance.new("Frame")
	frame.Name = "Bar"
	frame.AnchorPoint = opts.anchor or Vector2.new(0.5, 1)
	frame.Position = opts.position
	frame.Size = opts.size or UDim2.fromOffset(360, 26)
	frame.BackgroundColor3 = Hud.theme.panel
	frame.BackgroundTransparency = Hud.alpha(Hud.theme.panelAlpha)
	corner(frame, UDim.new(0, 8))
	stroke(frame, 2)
	local trail = Instance.new("Frame")
	trail.Name = "Trail"
	trail.BackgroundColor3 = Color3.new(1, 1, 1)
	trail.BackgroundTransparency = 0.15
	trail.Size = UDim2.fromScale(1, 1)
	trail.Parent = frame
	corner(trail, UDim.new(0, 8))
	local fill = Instance.new("Frame")
	fill.Name = "Fill"
	fill.BackgroundColor3 = opts.color or Hud.theme.good
	fill.Size = UDim2.fromScale(1, 1)
	fill.ZIndex = 2
	fill.Parent = frame
	corner(fill, UDim.new(0, 8))
	local gradient = Instance.new("UIGradient")
	gradient.Color = ColorSequence.new(Color3.new(1, 1, 1), Color3.fromRGB(200, 200, 200))
	gradient.Rotation = 90
	gradient.Parent = fill
	local text = if opts.label == false then nil else label(frame, "", UDim2.fromScale(1, 0.9))
	if text then
		text.ZIndex = 3
	end
	local shown = 1
	local function set(value: number, max: number)
		local k = if max > 0 then math.clamp(value / max, 0, 1) else 0
		play(fill, TweenInfo.new(0.12, Enum.EasingStyle.Quad), { Size = UDim2.fromScale(k, 1) })
		if k < shown then
			-- The trail waits a moment, then slides down: the size of the hit stays readable.
			task.delay(0.35, function()
				play(trail, TweenInfo.new(0.35, Enum.EasingStyle.Quad), { Size = UDim2.fromScale(k, 1) })
			end)
		else
			trail.Size = UDim2.fromScale(k, 1)
		end
		shown = k
		if text then
			text.Text = string.format("%d / %d", math.ceil(value), math.ceil(max))
		end
	end
	frame.Parent = parent
	return { frame = frame, set = set }
end

export type Slot = { button: TextButton, start: (seconds: number) -> (), ready: () -> boolean }

--- An ability slot: key hint, name, a cooldown sweep with seconds left, and a flash when ready. The key
--- hint follows the input: the key on keyboard, `button`'s glyph on a gamepad, none on touch.
function Hud.cooldownSlot(parent: Instance, opts: { key: string, name: string, size: UDim2?, layoutOrder: number?, button: Enum.KeyCode? }): Slot
	local button = Instance.new("TextButton")
	button.Name = opts.name
	button.Size = opts.size or UDim2.fromOffset(72, 72)
	button.LayoutOrder = opts.layoutOrder or 0
	button.AutoButtonColor = true
	button.Text = ""
	button.BackgroundColor3 = Hud.theme.panel
	button.BackgroundTransparency = Hud.alpha(Hud.theme.panelAlpha)
	corner(button)
	stroke(button, 2)
	local name = label(button, opts.name, UDim2.new(1, -8, 0.32, 0), Hud.theme.font)
	name.Position = UDim2.new(0, 4, 0.64, 0)
	local key = label(button, opts.key, UDim2.fromScale(0.34, 0.3), Hud.theme.heavy)
	key.Position = UDim2.fromOffset(4, 2)
	key.TextColor3 = Hud.theme.accent
	local glyph = Instance.new("ImageLabel")
	glyph.Name = "Glyph"
	glyph.BackgroundTransparency = 1
	glyph.Position = UDim2.fromOffset(4, 2)
	glyph.Size = UDim2.fromScale(0.34, 0.34)
	glyph.ScaleType = Enum.ScaleType.Fit
	glyph.Visible = false
	glyph.Parent = button
	local function hint()
		local input = Hud.input()
		local image = if input == "gamepad" and opts.button then UserInputService:GetImageForKeyCode(opts.button) else ""
		glyph.Image = image
		glyph.Visible = image ~= ""
		key.Visible = input == "mouse" or (input == "gamepad" and image == "")
	end
	pcall(function()
		local changed = UserInputService:GetPropertyChangedSignal("PreferredInput"):Connect(hint)
		button.Destroying:Connect(function()
			changed:Disconnect()
		end)
	end)
	hint()
	local shade = Instance.new("Frame")
	shade.Name = "Cooldown"
	shade.AnchorPoint = Vector2.new(0, 1)
	shade.Position = UDim2.fromScale(0, 1)
	shade.Size = UDim2.fromScale(1, 0)
	shade.BackgroundColor3 = Color3.new(0, 0, 0)
	shade.BackgroundTransparency = 0.35
	shade.ZIndex = 4
	shade.Parent = button
	corner(shade)
	local secs = label(button, "", UDim2.fromScale(1, 0.5), Hud.theme.heavy)
	secs.Position = UDim2.fromScale(0, 0.18)
	secs.ZIndex = 5
	local readyAt = 0
	local run = 0
	local function start(seconds: number)
		run += 1
		local mine = run
		readyAt = os.clock() + seconds
		shade.Size = UDim2.fromScale(1, 1)
		-- The sweep shows the time left, so it keeps running under Reduce Motion.
		TweenService:Create(shade, TweenInfo.new(seconds, Enum.EasingStyle.Linear), { Size = UDim2.fromScale(1, 0) }):Play()
		task.spawn(function()
			while mine == run and os.clock() < readyAt do
				secs.Text = string.format("%.1f", readyAt - os.clock())
				task.wait(0.1)
			end
			if mine ~= run then
				return
			end
			secs.Text = ""
			local s = button:FindFirstChildOfClass("UIStroke")
			if s then
				s.Color = Hud.theme.accent
				TweenService:Create(s, TweenInfo.new(0.5), { Color = Hud.theme.stroke }):Play()
			end
		end)
	end
	button.Parent = parent
	return { button = button, start = start, ready = function()
		return os.clock() >= readyAt
	end }
end

export type Feed = { frame: Frame, push: (text: string, color: Color3?) -> () }

--- A stack of short messages (kill feed, pickups) that fade after a few seconds; newest at the top.
function Hud.feed(parent: Instance, opts: { position: UDim2, anchor: Vector2?, width: number?, max: number?, seconds: number? }): Feed
	local frame = Instance.new("Frame")
	frame.Name = "Feed"
	frame.AnchorPoint = opts.anchor or Vector2.new(1, 0)
	frame.Position = opts.position
	frame.Size = UDim2.fromOffset(opts.width or 320, 200)
	frame.BackgroundTransparency = 1
	local list = Instance.new("UIListLayout")
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.Padding = UDim.new(0, 4)
	list.HorizontalAlignment = Enum.HorizontalAlignment.Right
	list.Parent = frame
	frame.Parent = parent
	local order = 0
	local function push(text: string, color: Color3?)
		order -= 1
		local row = Instance.new("TextLabel")
		row.Name = "Line" .. -order -- unique, so each line has its own path
		row.LayoutOrder = order
		row.AutomaticSize = Enum.AutomaticSize.X
		row.Size = UDim2.fromOffset(0, 32)
		row.BackgroundColor3 = Hud.theme.panel
		row.BackgroundTransparency = Hud.alpha(Hud.theme.panelAlpha)
		row.FontFace = Hud.theme.font
		row.TextSize = 20 -- 12 points on a phone (the HUD's 0.6 scale there)
		row.TextColor3 = color or Hud.theme.text
		row.Text = text
		local pad = Instance.new("UIPadding")
		pad.PaddingLeft = UDim.new(0, 10)
		pad.PaddingRight = UDim.new(0, 10)
		pad.Parent = row
		corner(row, UDim.new(0, 6))
		row.Parent = frame
		local rows = {}
		for _, c in frame:GetChildren() do
			if c:IsA("TextLabel") then
				table.insert(rows, c)
			end
		end
		table.sort(rows, function(a, b)
			return a.LayoutOrder > b.LayoutOrder
		end)
		while #rows > (opts.max or 5) do
			local oldest = table.remove(rows, 1)
			if oldest then
				oldest:Destroy()
			end
		end
		task.delay(opts.seconds or 4, function()
			if row.Parent then
				local fade = TweenService:Create(row, TweenInfo.new(0.4), { BackgroundTransparency = 1, TextTransparency = 1 })
				fade:Play()
				fade.Completed:Once(function()
					row:Destroy()
				end)
			end
		end)
	end
	return { frame = frame, push = push }
end

--- A banner that drops in at the top, holds, and slides away ("CHECKPOINT 7", "ROUND 2").
function Hud.toast(parent: Instance, text: string, color: Color3?, seconds: number?)
	local banner = label(parent, text, UDim2.fromOffset(520, 64), Hud.theme.heavy)
	banner.Name = "Toast"
	banner.AnchorPoint = Vector2.new(0.5, 0)
	banner.TextColor3 = color or Hud.theme.accent
	banner.ZIndex = 20
	local reduced = Hud.reducedMotion() -- no slide: it appears in place and goes at once
	banner.Position = if reduced then UDim2.new(0.5, 0, 0, 24) else UDim2.new(0.5, 0, 0, -80)
	if not reduced then
		TweenService:Create(banner, TweenInfo.new(0.35, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Position = UDim2.new(0.5, 0, 0, 24) }):Play()
	end
	task.delay(seconds or 1.6, function()
		if reduced then
			banner:Destroy()
			return
		end
		local out = TweenService:Create(banner, TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { Position = UDim2.new(0.5, 0, 0, -80), TextTransparency = 1 })
		out:Play()
		out.Completed:Once(function()
			banner:Destroy()
		end)
	end)
end

export type Counter = { frame: Frame, icon: ImageLabel, value: TextLabel, set: (value: number) -> (), add: (delta: number) -> (), get: () -> number }

--- A currency pill (coins, gems, XP): an icon and a number that counts to each new value (abbreviated from
--- 100K: 1.2M) and pops its icon on a gain. `counter.icon` is where Motion.fly sends reward icons. Without an
--- image the icon is a dot in `color`.
function Hud.counter(parent: Instance, opts: { position: UDim2, anchor: Vector2?, icon: string?, color: Color3?, value: number? }): Counter
	local frame = Instance.new("Frame")
	frame.Name = "Counter"
	frame.AnchorPoint = opts.anchor or Vector2.new(0, 0)
	frame.Position = opts.position
	frame.Size = UDim2.fromOffset(0, 56)
	frame.AutomaticSize = Enum.AutomaticSize.X
	frame.BackgroundColor3 = Hud.theme.panel
	frame.BackgroundTransparency = Hud.alpha(Hud.theme.panelAlpha)
	corner(frame, UDim.new(0.5, 0))
	stroke(frame, 2)
	local padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, 8)
	padding.PaddingRight = UDim.new(0, 18)
	padding.Parent = frame
	local row = Instance.new("UIListLayout")
	row.FillDirection = Enum.FillDirection.Horizontal
	row.VerticalAlignment = Enum.VerticalAlignment.Center
	row.Padding = UDim.new(0, 10)
	row.SortOrder = Enum.SortOrder.LayoutOrder
	row.Parent = frame
	-- The icon sits in a slot the list lays out, so its own pop never moves the number.
	local slot = Instance.new("Frame")
	slot.Name = "IconSlot"
	slot.BackgroundTransparency = 1
	slot.Size = UDim2.fromOffset(40, 40)
	slot.LayoutOrder = 1
	slot.Parent = frame
	local icon = Instance.new("ImageLabel")
	icon.Name = "Icon"
	icon.AnchorPoint = Vector2.new(0.5, 0.5)
	icon.Position = UDim2.fromScale(0.5, 0.5)
	icon.Size = UDim2.fromScale(1, 1)
	icon.ScaleType = Enum.ScaleType.Fit
	icon.Image = opts.icon or ""
	icon.BackgroundColor3 = opts.color or Hud.theme.accent
	icon.BackgroundTransparency = if opts.icon then 1 else 0
	if not opts.icon then
		corner(icon, UDim.new(0.5, 0))
	end
	icon.Parent = slot
	local value = Instance.new("TextLabel")
	value.Name = "Value"
	value.BackgroundTransparency = 1
	value.AutomaticSize = Enum.AutomaticSize.X
	value.Size = UDim2.fromOffset(0, 40)
	value.FontFace = Hud.theme.heavy
	value.TextSize = 32
	value.TextColor3 = Hud.theme.text
	value.TextXAlignment = Enum.TextXAlignment.Left
	value.LayoutOrder = 2
	stroke(value, 1.5, 0.35)
	value.Parent = frame
	local shown = opts.value or 0
	local function format(n: number): string
		return if math.abs(n) >= 100000 then Motion.short(n) else Motion.commas(n)
	end
	value.Text = format(shown)
	local function set(n: number)
		if n == shown then
			return
		end
		Motion.count(value, shown, n, { format = format })
		if n > shown then
			Motion.punch(icon, 0.18)
		end
		shown = n
	end
	frame.Parent = parent
	return {
		frame = frame,
		icon = icon,
		value = value,
		set = set,
		add = function(delta: number)
			set(shown + delta)
		end,
		get = function(): number
			return shown
		end,
	}
end

--- Text that pops up at a world position and floats away (damage numbers, "+10").
function Hud.floatingText(at: Vector3, text: string, color: Color3?)
	local anchor = Instance.new("Attachment")
	anchor.WorldPosition = at
	anchor.Parent = workspace.Terrain
	local gui = Instance.new("BillboardGui")
	gui.Size = UDim2.fromOffset(120, 48)
	gui.AlwaysOnTop = true
	gui.LightInfluence = 0
	gui.StudsOffsetWorldSpace = Vector3.new((math.random() - 0.5) * 1.2, 0.5, 0)
	gui.Parent = anchor
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Size = UDim2.fromScale(1, 1)
	l.FontFace = Hud.theme.heavy
	l.TextScaled = true
	l.Text = text
	l.TextColor3 = color or Hud.theme.text
	l.Parent = gui
	stroke(l, 2, 0.1)
	if not Hud.reducedMotion() then -- the float is movement; the fade stays
		local info = TweenInfo.new(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
		TweenService:Create(gui, info, { StudsOffsetWorldSpace = gui.StudsOffsetWorldSpace + Vector3.new(0, 2.2, 0) }):Play()
	end
	TweenService:Create(l, TweenInfo.new(0.6, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { TextTransparency = 1 }):Play()
	Debris:AddItem(anchor, 0.7)
end

return Hud
```

Health and ability hotbar — `src/Client/UI/Hud.client.luau`:
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Hud = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Hud"))

local screen = Hud.screen("GameHud")
local health = Hud.bar(screen, { position = UDim2.new(0.5, 0, 1, -20), color = Hud.theme.bad })
local row = Instance.new("Frame")
row.BackgroundTransparency = 1
row.AnchorPoint = Vector2.new(0.5, 1)
row.Position = UDim2.new(0.5, 0, 1, -60)
row.Size = UDim2.fromOffset(420, 80)
local layout = Instance.new("UIListLayout")
layout.FillDirection = Enum.FillDirection.Horizontal
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
layout.Padding = UDim.new(0, 8)
layout.Parent = row
row.Parent = screen
local slots: { [string]: Hud.Slot } = {
  Dash = Hud.cooldownSlot(row, { key = "Q", name = "Dash", layoutOrder = 1 }),
  Slam = Hud.cooldownSlot(row, { key = "1", name = "Slam", layoutOrder = 2 }),
}

local function hook(character: Model)
  local humanoid = character:WaitForChild("Humanoid") :: Humanoid
  health.set(humanoid.Health, humanoid.MaxHealth)
  humanoid.HealthChanged:Connect(function(hp)
    health.set(hp, humanoid.MaxHealth)
  end)
  -- Cooldowns: the server sets attribute "CD_<Name>" to workspace:GetServerTimeNow() + seconds.
  for name, slot in slots do
    character:GetAttributeChangedSignal("CD_" .. name):Connect(function()
      local readyAt = character:GetAttribute("CD_" .. name)
      if typeof(readyAt) == "number" then
        slot.start(math.max(0, readyAt - workspace:GetServerTimeNow()))
      end
    end)
  end
end

local player = Players.LocalPlayer
player.CharacterAdded:Connect(hook)
if player.Character then
  hook(player.Character)
end
```

## References
- Roblox: ScreenGui.ScreenInsets, UIScale, UITextSizeConstraint, UIStroke, TweenService,
  ContextActionService:BindAction (touch buttons), BillboardGui.
- Shuriken: `roblox-combat-feel` (hit feedback), `roblox-pvp-combat` (kill credit, streaks).
