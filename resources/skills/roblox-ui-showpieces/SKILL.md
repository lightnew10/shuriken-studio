---
name: roblox-ui-showpieces
description: "Worked, lint-clean Roblox UI screens built with the Motion module and the Ui kit, each laid out per device (landscape and portrait phone, tablet, desktop, TV) and honouring Reduce Motion: a ReplicatedFirst loading screen (real progress from ContentProvider:PreloadAsync, minimum and maximum time, failed assets, Skip, a handoff), a title screen and main menu over the game's world, a reward reveal (anticipation, flash, rays, coins flying into the HUD counter), a round-end screen with a level-up, and interaction patterns: tabs with a sliding indicator, a snap carousel, drag and drop with touch and gamepad alternatives, a bottom sheet that becomes a side panel. Read it before building any of these."
version: 1
tags: [ui, loading, loading screen, title, intro, main menu, menu, reward, reveal, gacha, egg, crate, round end, results, victory, level up, xp, tabs, carousel, drag, drop, inventory, sheet, panel, motion, mobile, console, gamepad]
roblox_systems: [ReplicatedFirst, ContentProvider, ScreenGui, UIPageLayout, UIListLayout, UIStroke, UIGradient, GuiService, ContextActionService, UserInputService, TweenService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [luau_check, roblox_sync_push, roblox_playtest, roblox_screenshot, ui_audit]
---
# Showpiece screens and interaction patterns

## Purpose
The screens players remember (the loading screen, the title, the reward, the round end) and the interactions
that make a menu feel good (tabs, carousels, drag and drop, sheets), as complete code to adapt rather than
re-derive. Every one is built on **Motion** (skill roblox-ui-motion) and the **Ui kit** (skill
roblox-ui-design, which needs Motion beside it), takes its colours from `Ui.theme` (apply the game's palette
first: skill roblox-ui-references), lays itself out per form factor, and keeps working with Reduce Motion on.
Adapt the names, the palette, the copy and the data; keep the structure, the timings and the device rules.

## Loading screen
**What it must do**: replace Roblox's screen at once (`ReplicatedFirst:RemoveDefaultLoadingScreen()` in a
LocalScript in ReplicatedFirst, which runs before the rest of the game arrives); show real progress, not a
timer: joining (an easing estimate while the game replicates: its size isn't known), then the key assets
counted as `ContentProvider:PreloadAsync` reports each one, then the player's data when the server says so;
stay up at least ~2 s (a screen that flashes looks broken) and never more than ~25 s (then let them in); offer
Skip once the game itself has loaded; report failed assets once and never block on them; hand over smoothly
(the title screen starts under it on `LoadingScreenDone`, the mark pushes toward the player as everything
fades). Preload only what the first screen shows (its logo, key icons, UI sounds): preloading the whole game
makes the wait longer for nothing.
**Where it lives**: a Shuriken project syncs src/Server, src/Shared and src/Client, not ReplicatedFirst, so a
server Script copies the screen into ReplicatedFirst as the server starts (before anyone joins), with a copy
of Motion inside it (ReplicatedStorage arrives after ReplicatedFirst). A plugged-in game whose sync covers
ReplicatedFirst can keep the LocalScript there directly (still give it a Motion child).
**Per device**: a phone (shorter side under 500 points, either way up) gets a smaller mark higher up and a
narrower footer near the bottom; a TV the 10-foot fit. Its own ScreenGui covers the notch and top bar
(ScreenInsets None), so its text stays in the middle of the screen. Reduce Motion: no sheen or drift, the
mark fades in, the handoff is a 0.25 s fade.

`src/Server/LoadingScreen/init.server.luau`:
```lua
--!strict
-- src/Server/LoadingScreen/init.server.luau: puts the loading screen into ReplicatedFirst as the server starts,
-- before any player joins, with a copy of Motion inside it (ReplicatedStorage arrives after ReplicatedFirst, so
-- the screen can't require Motion from there). Its sibling Screen.client.luau is the screen itself; a LocalScript
-- doesn't run in ServerScriptService, only in the copy.
local ReplicatedFirst = game:GetService("ReplicatedFirst")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local screen = script:WaitForChild("Screen"):Clone()
screen.Name = "LoadingScreen"
ReplicatedStorage:WaitForChild("Shared"):WaitForChild("Motion"):Clone().Parent = screen
screen.Parent = ReplicatedFirst
```
`src/Server/LoadingScreen/Screen.client.luau`:
```lua
--!strict
-- src/Server/LoadingScreen/Screen.client.luau, running as ReplicatedFirst.LoadingScreen: the game's own loading
-- screen. It replaces Roblox's at once, shows real progress (joining, then the key assets, then the player's
-- data when READY_ATTRIBUTE is set), stays up at least MIN_SECONDS and never more than MAX_SECONDS, offers Skip
-- once the game itself has loaded, and hands over by fading out and setting the local player's attribute
-- LoadingScreenDone (the title screen starts its intro on it). Assets that fail to load are reported once and
-- never block. Its own layout per form (phone either way up, tablet, desktop, TV); Reduce Motion fades only.
local ContentProvider = game:GetService("ContentProvider")
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local ReplicatedFirst = game:GetService("ReplicatedFirst")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

local Motion = require(script:WaitForChild("Motion"))

local TITLE = "SCRAPYARD TITANS" -- shown when there is no LOGO
local LOGO = "" -- "rbxassetid://..." of the logo: a transparent PNG at twice its display size
local PRELOAD = { LOGO } -- the first screen's key images and sounds (content ids or Instances)
local PRELOAD_FOLDER = "UiAssets" -- a ReplicatedStorage folder of key Decals, Sounds and Images, if the game has one
local READY_ATTRIBUTE: string? = nil -- e.g. "DataLoaded": the server sets it true on the player once their data loaded
local MIN_SECONDS = 2 -- long enough for the reveal: a loading screen that flashes looks broken
local MAX_SECONDS = 25 -- never trap a player: after this they go in anyway
local SKIP_AFTER = 8 -- a Skip button once the game has loaded and this long has passed
local TIPS = {
	"Heavier legs carry bigger guns, but turn slower.",
	"Scrap from every round unlocks new parts in the garage.",
	"Overheating locks your weapons: watch the heat gauge.",
}
local C = {
	bg = Color3.fromHex("0B0E14"),
	bg2 = Color3.fromHex("1B2233"),
	accent = Color3.fromHex("36E3FF"),
	text = Color3.fromHex("F2F4F8"),
	subtext = Color3.fromHex("9AA4B8"),
}
local DISPLAY = Font.fromEnum(Enum.Font.Oswald) -- the game's display face (skill roblox-ui-references, palettes)
local BODY = Font.fromEnum(Enum.Font.BuilderSans)
local BOLD = Font.fromEnum(Enum.Font.BuilderSansBold)

ReplicatedFirst:RemoveDefaultLoadingScreen()
local started = os.clock()
local deadline = started + MAX_SECONDS
local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "Loading"
gui.IgnoreGuiInset = true
gui.ScreenInsets = Enum.ScreenInsets.None -- covers the notch and the top bar too
gui.DisplayOrder = 1000
gui.ResetOnSpawn = false
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
local fit = Instance.new("UIScale")
fit:SetAttribute("FitReference", Vector2.new(1920, 1080))
fit:SetAttribute("FitRange", NumberRange.new(0.8, 1.5))
fit:SetAttribute("FitTenFoot", 1.25)
fit.Parent = gui
local fx = Motion.scope(gui)

local backdrop = Instance.new("Frame")
backdrop.Name = "Backdrop"
backdrop.BackgroundColor3 = Color3.new(1, 1, 1)
backdrop.BorderSizePixel = 0
backdrop.Size = UDim2.fromScale(1, 1)
backdrop.Parent = gui
local shade = Instance.new("UIGradient")
shade.Rotation = 90
shade.Color = ColorSequence.new(C.bg2, C.bg)
shade.Parent = backdrop

local function text(parent: Instance, name: string, size: number, font: Font, color: Color3): TextLabel
	local t = Instance.new("TextLabel")
	t.Name = name
	t.BackgroundTransparency = 1
	t.FontFace = font
	t.TextSize = size
	t.TextColor3 = color
	t.Text = ""
	t.AutomaticSize = Enum.AutomaticSize.XY
	t.Parent = parent
	return t
end

-- The mark: the logo image, or the title in the display face. Its holder sits where the layout puts it; the
-- mark itself animates inside (scale, transparency, a sheen across it).
local holder = Instance.new("Frame")
holder.Name = "Mark"
holder.BackgroundTransparency = 1
holder.AnchorPoint = Vector2.new(0.5, 0.5)
holder.AutomaticSize = Enum.AutomaticSize.XY
holder.Parent = backdrop
local mark: GuiObject
if LOGO ~= "" then
	local image = Instance.new("ImageLabel")
	image.Name = "Logo"
	image.BackgroundTransparency = 1
	image.Image = LOGO
	image.ScaleType = Enum.ScaleType.Fit
	image.ImageTransparency = 1
	image.Parent = holder
	mark = image
else
	local title = text(holder, "Title", 96, DISPLAY, C.text)
	title.Text = TITLE
	title.TextTransparency = 1
	local outline = Instance.new("UIStroke")
	outline.Color = C.bg
	outline.Thickness = 3
	outline.Transparency = 0.3
	outline.Parent = title
	mark = title
end
local markScale = Instance.new("UIScale")
markScale.Parent = mark
local sheen = Instance.new("UIGradient") -- a band of light across the mark: the rest a touch darker
sheen.Rotation = 20
sheen.Color = ColorSequence.new({
	ColorSequenceKeypoint.new(0, Color3.new(0.88, 0.88, 0.88)),
	ColorSequenceKeypoint.new(0.45, Color3.new(0.88, 0.88, 0.88)),
	ColorSequenceKeypoint.new(0.5, Color3.new(1, 1, 1)),
	ColorSequenceKeypoint.new(0.55, Color3.new(0.88, 0.88, 0.88)),
	ColorSequenceKeypoint.new(1, Color3.new(0.88, 0.88, 0.88)),
})
sheen.Offset = Vector2.new(-1, 0)
sheen.Parent = mark

-- The footer: status and percent over the bar, a tip under it, Skip under that.
local footer = Instance.new("Frame")
footer.Name = "Footer"
footer.BackgroundTransparency = 1
footer.AnchorPoint = Vector2.new(0.5, 1)
footer.AutomaticSize = Enum.AutomaticSize.Y
footer.Parent = backdrop
local column = Instance.new("UIListLayout")
column.HorizontalAlignment = Enum.HorizontalAlignment.Center
column.Padding = UDim.new(0, 12)
column.SortOrder = Enum.SortOrder.LayoutOrder
column.Parent = footer
local row = Instance.new("Frame")
row.Name = "Status"
row.BackgroundTransparency = 1
row.Size = UDim2.new(1, 0, 0, 24)
row.LayoutOrder = 1
row.Parent = footer
local status = text(row, "Text", 18, BODY, C.subtext)
local percent = text(row, "Percent", 18, Font.fromEnum(Enum.Font.RobotoMono), C.text)
percent.AnchorPoint = Vector2.new(1, 0)
percent.Position = UDim2.fromScale(1, 0)
local track = Instance.new("Frame")
track.Name = "Bar"
track.BackgroundColor3 = C.text
track.BackgroundTransparency = 0.85
track.BorderSizePixel = 0
track.LayoutOrder = 2
track.Parent = footer
local fill = Instance.new("Frame")
fill.Name = "Fill"
fill.BackgroundColor3 = C.accent
fill.BorderSizePixel = 0
fill.Size = UDim2.fromScale(0, 1)
fill.Parent = track
for _, bar in { track, fill } do
	local round = Instance.new("UICorner")
	round.CornerRadius = UDim.new(0.5, 0)
	round.Parent = bar
end
local tip = text(footer, "Tip", 20, BODY, C.text)
tip.AutomaticSize = Enum.AutomaticSize.Y
tip.TextWrapped = true
tip.LayoutOrder = 3
tip.Text = TIPS[math.random(#TIPS)]
local skip = Instance.new("TextButton")
skip.Name = "Skip"
skip.AutoButtonColor = false
skip.BackgroundColor3 = C.bg2
skip.BackgroundTransparency = 0.2
skip.FontFace = BOLD
skip.Text = "Skip"
skip.TextSize = 18
skip.TextColor3 = C.text
skip.Size = UDim2.fromOffset(140, 56)
skip.LayoutOrder = 4
skip.Visible = false
local skipRound = Instance.new("UICorner")
skipRound.CornerRadius = UDim.new(0.5, 0)
skipRound.Parent = skip
skip.Parent = footer

-- A layout per form: a phone (shorter side under 500 points, either way up) gets a smaller mark higher up
-- and a narrower footer nearer the bottom; a TV gets the 10-foot fit (everything 25% bigger).
local function place()
	local points = gui.AbsoluteSize
	if points.X <= 0 or points.Y <= 0 then
		return
	end
	local k = math.clamp(math.min(points.X / 1920, points.Y / 1080), 0.8, 1.5) * (if GuiService:IsTenFootInterface() then 1.25 else 1)
	fit.Scale = k
	local canvas = points / k
	local phone = math.min(points.X, points.Y) < 500
	local width = math.min(if phone then 560 else 760, canvas.X - 64)
	holder.Position = UDim2.fromScale(0.5, if phone then 0.36 else 0.42)
	if mark:IsA("ImageLabel") then
		mark.Size = if phone then UDim2.fromOffset(360, 140) else UDim2.fromOffset(640, 240)
	elseif mark:IsA("TextLabel") then
		mark.TextSize = if phone then 64 else 104
	end
	footer.Position = UDim2.new(0.5, 0, 1, if phone then -28 else -72)
	footer.Size = UDim2.fromOffset(width, 0)
	track.Size = UDim2.new(1, 0, 0, if phone then 10 else 12)
	tip.Size = UDim2.fromScale(1, 0)
	tip.TextSize = if phone then 18 else 20
end
gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(place)
gui.Parent = player:WaitForChild("PlayerGui")
place()

-- The reveal: the mark settles in on a long soft curve, the footer follows, then a sheen every few seconds and a
-- slow drift in the backdrop while it waits. Reduce Motion: everything is simply there.
local soft = Motion.bezier(0.16, 1, 0.3, 1)
local fadeProp = if mark:IsA("ImageLabel") then "ImageTransparency" else "TextTransparency"
TweenService:Create(mark, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { [fadeProp] = 0 }):Play()
fx:keyframes(markScale, { Scale = { { at = 0, value = 0.86 }, { at = 0.9, value = 1, ease = soft } } })
Motion.enter({ footer }, { from = "up", delay = 0.35, distance = 16 })
fx:keyframes(sheen, { Offset = { { at = 0, value = Vector2.new(-1, 0) }, { at = 1.2, value = Vector2.new(-1, 0) }, { at = 2, value = Vector2.new(1, 0), ease = Enum.EasingStyle.Quad, direction = Enum.EasingDirection.InOut }, { at = 4.5, value = Vector2.new(1, 0) } } }, { loop = true })
fx:loop(shade, TweenInfo.new(5, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Offset = Vector2.new(0, 0.12) })

-- Tips change every 5 s with a short fade (a fade, so it stays under Reduce Motion).
local tipThread = task.spawn(function()
	local i = table.find(TIPS, tip.Text) or 1
	while true do
		task.wait(5)
		TweenService:Create(tip, TweenInfo.new(0.2), { TextTransparency = 1 }):Play()
		task.wait(0.2)
		i = i % #TIPS + 1
		tip.Text = TIPS[i]
		TweenService:Create(tip, TweenInfo.new(0.25), { TextTransparency = 0 }):Play()
	end
end)
fx:add(function()
	task.cancel(tipThread)
end)

local shown = 0
local function progress(p: number, what: string)
	if p > shown then
		shown = math.min(p, 1)
		Motion.tween(fill, TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Size = UDim2.fromScale(shown, 1) })
		percent.Text = string.format("%d%%", math.floor(shown * 100))
	end
	status.Text = what
end

local skipped = false
skip.Activated:Connect(function()
	skipped = true
end)
local function waitUntil(done: () -> boolean, skippable: boolean)
	while not done() and os.clock() < deadline and not (skippable and skipped) do
		task.wait(0.1)
	end
end

-- 1. Joining: the game replicates. Its real size isn't known, so the bar eases toward 45% meanwhile.
while not game:IsLoaded() and os.clock() < deadline do
	progress(0.45 * (1 - math.exp(-(os.clock() - started) / 4)), "Joining the server")
	task.wait(0.1)
end
progress(0.5, "Loading assets")
task.delay(math.max(0, SKIP_AFTER - (os.clock() - started)), function()
	if gui.Parent then
		skip.Visible = true
		if UserInputService.GamepadEnabled and GuiService.SelectedObject == nil then
			GuiService.SelectedObject = skip
		end
	end
end)

-- 2. The key assets, counted as each one arrives. A failed asset never blocks: it is reported once.
local list: { any } = {}
for _, id in PRELOAD do
	if id ~= "" then
		table.insert(list, id)
	end
end
local folder = ReplicatedStorage:FindFirstChild(PRELOAD_FOLDER)
if folder then
	table.insert(list, folder)
end
local loaded, failed, preloaded = 0, {} :: { string }, #list == 0
if #list > 0 then
	task.spawn(function()
		ContentProvider:PreloadAsync(list, function(contentId: string, fetch: Enum.AssetFetchStatus)
			loaded += 1
			if fetch ~= Enum.AssetFetchStatus.Success then
				table.insert(failed, contentId)
			end
			local total = math.max(#list, loaded + ContentProvider.RequestQueueSize)
			progress(0.5 + 0.45 * loaded / total, string.format("Loading assets %d/%d", loaded, total))
		end)
		preloaded = true
	end)
end
waitUntil(function()
	return preloaded
end, true)
if #failed > 0 then
	warn(string.format("Loading screen: %d asset(s) didn't load; the game goes on without them: %s", #failed, table.concat(failed, ", ", 1, math.min(#failed, 5))))
end

-- 3. The player's data, when the game says when it is ready.
local ready = READY_ATTRIBUTE
if ready then
	progress(0.95, "Loading your progress")
	waitUntil(function()
		return player:GetAttribute(ready) == true
	end, true)
end
progress(1, if os.clock() >= deadline then "Taking longer than usual: in you go" else "Ready")
local rest = MIN_SECONDS - (os.clock() - started)
if rest > 0 then
	task.wait(rest)
end

-- 4. The handoff: the title screen starts underneath, the mark pushes toward the player as everything fades.
if GuiService.SelectedObject == skip then
	GuiService.SelectedObject = nil
end
player:SetAttribute("LoadingScreenDone", true)
fx:stop()
local out = TweenInfo.new(if Motion.reduced() then 0.25 else 0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.InOut)
Motion.tween(markScale, out, { Scale = 1.12 })
for _, d in gui:GetDescendants() do
	if d:IsA("TextLabel") or d:IsA("TextButton") then
		TweenService:Create(d, out, { TextTransparency = 1, BackgroundTransparency = 1 }):Play()
	elseif d:IsA("ImageLabel") then
		TweenService:Create(d, out, { ImageTransparency = 1 }):Play()
	elseif d:IsA("Frame") and d.BackgroundTransparency < 1 then
		TweenService:Create(d, out, { BackgroundTransparency = 1 }):Play()
	elseif d:IsA("UIStroke") then
		TweenService:Create(d, out, { Transparency = 1 }):Play()
	end
end
task.wait(out.Time + 0.05)
gui:Destroy()
```

## Title screen and main menu
**The look**: the game's own world behind the menu (a scripted camera drifting between two shots of the map:
a stage, not a picture; skill roblox-ui-references, 3D previews), a vignette so the menu reads on any part of
the map, the logo, few buttons (Play is the one primary), the version in a corner. **Per device**: a column on
the left on desktop, tablet and TV (Play 80 high, others 60, a key hint beside Play); a row along the bottom
on a landscape phone (the 945x415 canvas has no room for a column under a logo), with the touch controls
off while the menu shows (`GuiService.TouchControlsEnabled`); a centred column at the bottom on a phone held
upright. Gamepad: Play is selected; B closes Settings. **Motion**: built under the loading screen, the intro
plays on its handoff: the vignette rises, the logo rises and settles (0.7 s Quint), the buttons follow
staggered from 0.35 s, the camera drifts (18 s Sine), Play's glow ring breathes from 1.2 s. Play cuts to the
game with an iris transition. Settings holds the game's own Reduce Motion switch (`Motion.setReduced`).

`src/Client/UI/Title.client.luau`:
```lua
--!strict
-- src/Client/UI/Title.client.luau: the title screen and main menu. The game's own world is the backdrop (the
-- camera drifts slowly between two shots of the map: a stage, not a picture), with the logo and a menu laid
-- out per form: a column on the left on desktop, tablet and TV; a row along the bottom on a landscape phone (the
-- touch controls are off while the menu shows); a centred column on a phone held upright. It is built under
-- the loading screen and plays its intro when the loading screen hands over (LoadingScreenDone). Play cuts to
-- the game with an iris; Settings has the game's own Reduce Motion switch (Motion.setReduced).
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Motion = require(Shared:WaitForChild("Motion"))
local Ui = require(Shared:WaitForChild("Ui"))

local LOGO = "" -- "rbxassetid://..." of the logo; without one the title is set in the display face
local TITLE = "SCRAPYARD TITANS"
local VERSION = "v1.0"
-- Two shots of the map the camera drifts between (one full drift takes 18 s each way).
local SHOTS = {
	CFrame.lookAt(Vector3.new(80, 34, 60), Vector3.new(0, 12, 0)),
	CFrame.lookAt(Vector3.new(-50, 28, 84), Vector3.new(0, 14, 0)),
}

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera
local screen = Ui.screen("Title", 10, player:WaitForChild("PlayerGui"))
local fx = Motion.scope(screen) -- the camera drift and the Play halo stop when the screen goes
local t = Ui.theme

-- A soft vignette over the world so the menu reads on any part of the map (ScreenInsets None: edge to edge).
local vignetteScreen = Instance.new("ScreenGui")
vignetteScreen.Name = "TitleVignette"
vignetteScreen.IgnoreGuiInset = true
vignetteScreen.ScreenInsets = Enum.ScreenInsets.None
vignetteScreen.DisplayOrder = 9
vignetteScreen.ResetOnSpawn = false
vignetteScreen.Parent = screen.Parent
local vignette = Instance.new("Frame")
vignette.BackgroundColor3 = t.bg
vignette.BorderSizePixel = 0
vignette.Size = UDim2.fromScale(1, 1)
vignette.BackgroundTransparency = 1
vignette.Parent = vignetteScreen
local falloff = Instance.new("UIGradient")
falloff.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0.15), NumberSequenceKeypoint.new(0.55, 0.75), NumberSequenceKeypoint.new(1, 1) })
falloff.Parent = vignette

local leaving = false
local settings: Ui.Window? = nil

local function openSettings()
	local window = settings or Ui.window(screen, "Settings", Vector2.new(640, 360))
	if not settings then
		settings = window
		local row = Instance.new("Frame")
		row.BackgroundTransparency = 1
		row.Size = UDim2.new(1, 0, 0, 56)
		local layout = Instance.new("UIListLayout")
		layout.FillDirection = Enum.FillDirection.Horizontal
		layout.VerticalAlignment = Enum.VerticalAlignment.Center
		layout.Padding = UDim.new(0, 16)
		layout.SortOrder = Enum.SortOrder.LayoutOrder
		layout.Parent = row
		local name = Instance.new("TextLabel")
		name.BackgroundTransparency = 1
		name.FontFace = t.font
		name.TextSize = 20
		name.TextColor3 = t.text
		name.TextXAlignment = Enum.TextXAlignment.Left
		name.Text = "Reduce motion"
		name.Size = UDim2.fromScale(0, 1)
		name.LayoutOrder = 1
		local grow = Instance.new("UIFlexItem")
		grow.FlexMode = Enum.UIFlexMode.Fill
		grow.Parent = name
		name.Parent = row
		local toggle = Ui.button(row, if Motion.reduced() then "On" else "Off", "secondary")
		toggle.Name = "ReduceMotion"
		toggle.AutomaticSize = Enum.AutomaticSize.None
		toggle.Size = UDim2.fromOffset(96, 56)
		toggle.LayoutOrder = 2
		toggle.Activated:Connect(function()
			-- The game's own switch (saved with the player's settings in a real game); the player's Roblox
			-- setting still counts when this is off.
			Motion.setReduced(if Motion.reduced() then nil else true)
			toggle.Text = if Motion.reduced() then "On" else "Off"
		end)
		row.Parent = window.body
	end
	window.open()
end

local function play()
	if leaving then
		return
	end
	leaving = true
	Motion.transition(function()
		fx:stop()
		screen.Enabled = false
		vignetteScreen.Enabled = false
		camera.CameraType = Enum.CameraType.Custom
		GuiService.TouchControlsEnabled = true
		local remotes = ReplicatedStorage:FindFirstChild("Remotes")
		local remote = if remotes then remotes:FindFirstChild("Play") else nil
		if remote and remote:IsA("RemoteEvent") then
			remote:FireServer() -- the server spawns the character, puts the player in a round...
		end
	end, { style = "iris", color = t.bg })
end

-- The menu, data-driven: add Shop, Codes or Credits here (four on a phone at most).
local MENU: { { name: string, kind: Ui.ButtonKind, action: () -> () } } = {
	{ name = "Play", kind = "primary", action = play },
	{ name = "Settings", kind = "secondary", action = openSettings },
}

local content: Frame? = nil
local playButton: TextButton? = nil

-- One layout per form. Rebuilt when the form, orientation or input changes (a rotated phone, a gamepad
-- picked up); the intro plays once, so a rebuild just shows the new layout.
local function build(device: Ui.Device)
	if content then
		content:Destroy()
	end
	local phone = device.form == "phone"
	local upright = phone and device.portrait
	local frame = Instance.new("Frame")
	frame.Name = "Menu"
	frame.BackgroundTransparency = 1
	frame.Size = UDim2.fromScale(1, 1)
	content = frame

	local mark: GuiObject
	if LOGO ~= "" then
		local image = Instance.new("ImageLabel")
		image.BackgroundTransparency = 1
		image.Image = LOGO
		image.ScaleType = Enum.ScaleType.Fit
		image.Size = if phone then UDim2.fromOffset(360, 120) else UDim2.fromOffset(600, 200)
		mark = image
	else
		local title = Instance.new("TextLabel")
		title.BackgroundTransparency = 1
		title.AutomaticSize = Enum.AutomaticSize.XY
		title.FontFace = t.bold
		title.TextSize = if phone then 56 else 88
		title.TextColor3 = t.text
		title.Text = TITLE
		local outline = Instance.new("UIStroke")
		outline.Color = t.bg
		outline.Thickness = 3
		outline.Transparency = 0.2
		outline.Parent = title
		mark = title
	end
	mark.Name = "Logo"
	mark.AnchorPoint = if upright then Vector2.new(0.5, 0) else Vector2.new(0, 0)
	mark.Position = if upright then UDim2.new(0.5, 0, 0, 48) elseif phone then UDim2.fromOffset(40, 24) else UDim2.new(0, 96, 0.16, 0)
	mark.Parent = frame

	local column = Instance.new("Frame")
	column.Name = "Buttons"
	column.BackgroundTransparency = 1
	column.AutomaticSize = if phone and not upright then Enum.AutomaticSize.X else Enum.AutomaticSize.Y
	local list = Instance.new("UIListLayout")
	list.Padding = UDim.new(0, if phone then 12 else 16)
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.FillDirection = if phone and not upright then Enum.FillDirection.Horizontal else Enum.FillDirection.Vertical
	list.Parent = column
	if upright then
		column.AnchorPoint = Vector2.new(0.5, 1)
		column.Position = UDim2.new(0.5, 0, 1, -48)
		column.Size = UDim2.new(1, -64, 0, 0)
	elseif phone then
		column.AnchorPoint = Vector2.new(0, 1)
		column.Position = UDim2.new(0, 40, 1, -28)
		column.Size = UDim2.fromOffset(0, 72)
	else
		column.AnchorPoint = Vector2.new(0, 0.5)
		column.Position = UDim2.new(0, 96, 0.6, 0)
		column.Size = UDim2.fromOffset(360, 0)
	end
	column.Parent = frame
	local buttons: { Instance } = {}
	for i, item in MENU do
		local b = Ui.button(column, item.name, item.kind)
		b.LayoutOrder = i
		b.AutomaticSize = Enum.AutomaticSize.None
		local primary = item.kind == "primary"
		b.Size = if phone and not upright then UDim2.fromOffset(if primary then 240 else 180, 72) elseif primary then UDim2.new(1, 0, 0, 80) else UDim2.new(1, 0, 0, 60)
		b.TextSize = if primary then 26 else 20
		b.Activated:Connect(item.action)
		table.insert(buttons, b)
		if primary then
			playButton = b
		end
	end
	-- A key hint beside Play: "Enter" on a keyboard, the A glyph on a gamepad, nothing on touch.
	if not phone then
		local hint = Ui.hint(frame, Enum.KeyCode.Return, Enum.KeyCode.ButtonA)
		hint.AnchorPoint = Vector2.new(0, 0.5)
		hint.Position = UDim2.new(0, 96 + 360 + 16, 0.6, -((#MENU - 1) * 76) / 2)
	end
	local version = Instance.new("TextLabel")
	version.Name = "Version"
	version.BackgroundTransparency = 1
	version.AutomaticSize = Enum.AutomaticSize.XY
	version.AnchorPoint = Vector2.new(1, 1)
	version.Position = UDim2.new(1, -24, 1, -16)
	version.FontFace = t.font
	version.TextSize = 15
	version.TextColor3 = t.subtext
	version.Text = VERSION
	version.Parent = frame
	frame.Parent = screen
	if device.input == "gamepad" and playButton then
		GuiService.SelectedObject = playButton
	end
	return mark, column, buttons
end

-- The stage: a scripted camera over the map; the touch controls stay hidden while the menu shows.
camera.CameraType = Enum.CameraType.Scriptable
camera.CFrame = SHOTS[1]
GuiService.TouchControlsEnabled = false

-- The layout on screen now, and whether the intro has played (a layout built before it waits hidden for it).
type Layout = { mark: GuiObject, column: Frame, buttons: { Instance } }
local current: Layout? = nil
local introDone = false

Ui.onDevice(screen, function(device: Ui.Device)
	local mark, column, buttons = build(device)
	-- The vignette darkens behind the menu: the left side, or the bottom on a phone held upright.
	falloff.Rotation = if device.form == "phone" and device.portrait then 270 else 0
	current = { mark = mark, column = column, buttons = buttons }
	if not introDone then
		mark.Visible = false
		column.Visible = false
	end
end)

-- The intro, once the loading screen hands over (a game without one waits at most 30 s): the world comes up
-- under the vignette, the logo rises and settles, the buttons follow in order, then the camera drifts and
-- Play's glow breathes. Reduce Motion: all of it is simply there.
task.spawn(function()
	local waited = os.clock()
	while not player:GetAttribute("LoadingScreenDone") and os.clock() - waited < 30 do
		task.wait(0.1)
	end
	introDone = true
	local now = current
	if not now or leaving then
		return
	end
	TweenService:Create(vignette, TweenInfo.new(0.6), { BackgroundTransparency = 0 }):Play()
	now.mark.Visible = true
	now.column.Visible = true
	Motion.enter({ now.mark }, { from = "up", distance = 40, info = TweenInfo.new(0.7, Enum.EasingStyle.Quint, Enum.EasingDirection.Out) })
	Motion.enter(now.buttons, { delay = 0.35, gap = 0.06 })
	fx:loop(camera, TweenInfo.new(18, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { CFrame = SHOTS[2] })
	-- Play breathes: a glow ring around it (its own size belongs to the press spring).
	task.delay(1.2, function()
		local target = playButton
		if target and not leaving then
			local glow = Instance.new("UIStroke")
			glow.Name = "Glow"
			glow.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
			glow.BorderStrokePosition = Enum.BorderStrokePosition.Outer
			glow.Color = t.accent
			glow.Thickness = 4
			glow.Transparency = 0.25
			glow.Parent = target
			fx:loop(glow, TweenInfo.new(0.9, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Transparency = 0.85 })
			fx:add(function()
				glow:Destroy()
			end)
		end
	end)
end)
```

## Reward reveal
**The sequence** (skill roblox-ui-references, gacha): a silhouette shakes harder and harder (0.8 s), a white
flash (0.3 s), the item pops in (Back Out 0.4 s) over rays spinning in its tier colour, the tier word lands
(colour + word: never colour alone), NEW! punches in, Claim arrives 0.3 s later. A tap or a key during the
anticipation skips to the reveal. Claim flies the coins into the HUD's counter (`Motion.fly` into a
`Hud.counter`'s icon; the counter counts as each one lands) while the reveal fades. **Per device**: the icon
is 150 design px on a phone (the column fits the 415-high canvas: icon, word, name, Claim) and 240 elsewhere.
**Reduce Motion**: no shake, flash, rays or flight; the result fades in and the coins count at once.

`src/Client/UI/RewardReveal.luau`:
```lua
--!strict
-- src/Client/UI/RewardReveal.luau: the reward reveal (an egg, a crate, a daily reward, a battle-pass tier). The
-- sequence matters more than the art: anticipation (the silhouette shakes harder and harder), a flash, the
-- reveal (the item pops in over spinning rays in its tier colour, the tier word lands, NEW), then Claim, which
-- flies the coins into the HUD's counter. A tap or a key during the anticipation skips to the reveal. The
-- column is sized per form (phone, tablet, desktop, TV). Reduce Motion: no shake, flash, rays or flight; the
-- result fades in and the coins count at once.
--   local Reveal = require(script.Parent.RewardReveal)
--   Reveal.show(screen, { name = "Golden Sword", icon = "rbxassetid://...", tier = "Legendary", coins = 250,
--     isNew = true }, { flyTo = coins.icon, onCoins = coins.add })   -- coins: a Hud.counter
local ContextActionService = game:GetService("ContextActionService")
local GuiService = game:GetService("GuiService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Motion = require(Shared:WaitForChild("Motion"))
local Ui = require(Shared:WaitForChild("Ui"))

local Reveal = {}

-- Rarity is colour + word (+ glow): never colour alone (skill roblox-ui-references, Rarity).
local TIER: { [string]: Color3 } = {
	Common = Color3.fromHex("B8BCC6"),
	Uncommon = Color3.fromHex("4CD964"),
	Rare = Color3.fromHex("3AA0FF"),
	Epic = Color3.fromHex("B266FF"),
	Legendary = Color3.fromHex("FFB020"),
	Mythic = Color3.fromHex("FF3B6B"),
}
local COIN = "" -- "rbxassetid://..." of the coin icon that flies into the counter

export type Item = { name: string, icon: string, tier: string, coins: number?, isNew: boolean? }
export type Options = {
	flyTo: GuiObject?, -- the counter's icon the coins fly into (a Hud.counter's .icon)
	onCoins: ((amount: number) -> ())?, -- adds coins to the counter as they land (a Hud.counter's .add)
	onDone: (() -> ())?,
}

-- Rays from frames: bars through the centre in the tier colour, fading toward their ends, in a holder that
-- spins (no image needed; a sunburst image from store_search works too).
local function rays(parent: Instance, size: number, color: Color3): Frame
	local holder = Instance.new("Frame")
	holder.Name = "Rays"
	holder.BackgroundTransparency = 1
	holder.AnchorPoint = Vector2.new(0.5, 0.5)
	holder.Position = UDim2.fromScale(0.5, 0.5)
	holder.Size = UDim2.fromOffset(size, size)
	for i = 0, 7 do
		local bar = Instance.new("Frame")
		bar.BackgroundColor3 = color
		bar.BorderSizePixel = 0
		bar.AnchorPoint = Vector2.new(0.5, 0.5)
		bar.Position = UDim2.fromScale(0.5, 0.5)
		bar.Size = UDim2.new(0, math.floor(size * 0.09), 1, 0)
		bar.Rotation = i * 22.5
		local fade = Instance.new("UIGradient")
		fade.Rotation = 90
		fade.Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 1), NumberSequenceKeypoint.new(0.5, 0.35), NumberSequenceKeypoint.new(1, 1) })
		fade.Parent = bar
		bar.Parent = holder
	end
	holder.Parent = parent
	return holder
end

local function textLabel(parent: Instance, text: string, size: number, font: Font, color: Color3, order: number): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.AutomaticSize = Enum.AutomaticSize.XY
	l.FontFace = font
	l.TextSize = size
	l.TextColor3 = color
	l.Text = text
	l.LayoutOrder = order
	l.Parent = parent
	return l
end

--- Shows the reveal on `screen` (a Ui.screen at DisplayOrder 20) and cleans up after Claim.
function Reveal.show(screen: ScreenGui, item: Item, opts: Options?)
	local o: Options = opts or {}
	local t = Ui.theme
	local device = Ui.device(screen)
	local small = device.form == "phone"
	local iconSize = if small then 150 else 240
	local color = TIER[item.tier] or t.text
	local reduced = Motion.reduced()

	local backdrop = Instance.new("TextButton") -- takes taps: one during the anticipation skips it
	backdrop.Name = "RewardBackdrop"
	backdrop.Text = ""
	backdrop.AutoButtonColor = false
	backdrop.Selectable = false
	backdrop.BackgroundColor3 = Color3.new(0, 0, 0)
	backdrop.BackgroundTransparency = 1
	backdrop.Size = UDim2.fromScale(1, 1)
	backdrop.ZIndex = 10
	backdrop.Parent = screen
	local fx = Motion.scope(backdrop)
	TweenService:Create(backdrop, TweenInfo.new(0.2), { BackgroundTransparency = Ui.alpha(0.35) }):Play()

	local column = Instance.new("Frame")
	column.Name = "Reward"
	column.BackgroundTransparency = 1
	column.AnchorPoint = Vector2.new(0.5, 0.5)
	column.Position = UDim2.fromScale(0.5, 0.5)
	column.AutomaticSize = Enum.AutomaticSize.XY
	local list = Instance.new("UIListLayout")
	list.HorizontalAlignment = Enum.HorizontalAlignment.Center
	list.Padding = UDim.new(0, if small then 8 else 14)
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.Parent = column
	column.Parent = backdrop

	-- The icon sits in a slot the list lays out; the icon itself shakes, pops and glows inside it.
	local slot = Instance.new("Frame")
	slot.Name = "Slot"
	slot.BackgroundTransparency = 1
	slot.Size = UDim2.fromOffset(iconSize, iconSize)
	slot.LayoutOrder = 1
	slot.Parent = column
	local glow = rays(slot, iconSize * 1.9, color)
	glow.Visible = false
	local icon = Instance.new("ImageLabel")
	icon.Name = "Icon"
	icon.BackgroundTransparency = 1
	icon.AnchorPoint = Vector2.new(0.5, 0.5)
	icon.Position = UDim2.fromScale(0.5, 0.5)
	icon.Size = UDim2.fromScale(1, 1)
	icon.ScaleType = Enum.ScaleType.Fit
	icon.Image = item.icon
	icon.ImageColor3 = Color3.new(0, 0, 0) -- a silhouette until the reveal
	icon.Parent = slot
	local pop = Instance.new("UIScale")
	pop.Parent = icon

	local word = textLabel(column, string.upper(item.tier) .. "!", if small then 48 else 72, t.bold, color, 2)
	local wordStroke = Instance.new("UIStroke")
	wordStroke.Color = Color3.new(0, 0, 0)
	wordStroke.Thickness = 3
	wordStroke.Transparency = 0.2
	wordStroke.Parent = word
	local name = textLabel(column, item.name, if small then 20 else 26, t.font, t.text, 3)
	local claim = Ui.button(column, if item.coins then string.format("Claim %s", Motion.commas(item.coins)) else "Claim", "primary")
	claim.Name = "Claim"
	claim.AutomaticSize = Enum.AutomaticSize.None
	claim.Size = UDim2.fromOffset(if small then 240 else 300, if small then 64 else 72)
	claim.LayoutOrder = 4
	word.Visible = false
	name.Visible = false
	claim.Visible = false
	local newTag: TextLabel? = nil
	if item.isNew then
		local tag = textLabel(slot, "NEW!", if small then 18 else 22, t.bold, t.accentText, 0)
		tag.BackgroundTransparency = 0
		tag.BackgroundColor3 = t.accent
		tag.AnchorPoint = Vector2.new(1, 0)
		tag.Position = UDim2.fromScale(1, 0)
		tag.Rotation = 8
		tag.Visible = false
		local tagPad = Instance.new("UIPadding")
		tagPad.PaddingLeft = UDim.new(0, 10)
		tagPad.PaddingRight = UDim.new(0, 10)
		tagPad.Parent = tag
		local round = Instance.new("UICorner")
		round.CornerRadius = UDim.new(0, 6)
		round.Parent = tag
		newTag = tag
	end

	local revealed = false
	local finished = false
	local function reveal()
		if revealed then
			return
		end
		revealed = true
		fx:stop() -- ends the anticipation shake
		icon.Rotation = 0
		TweenService:Create(icon, TweenInfo.new(0.15), { ImageColor3 = Color3.new(1, 1, 1) }):Play()
		if not reduced then
			local flash = Instance.new("Frame")
			flash.BackgroundColor3 = Color3.new(1, 1, 1)
			flash.BackgroundTransparency = 0.25
			flash.Size = UDim2.fromScale(1, 1)
			flash.ZIndex = 20
			flash.Parent = backdrop
			local out = TweenService:Create(flash, TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { BackgroundTransparency = 1 })
			out.Completed:Once(function()
				flash:Destroy()
			end)
			out:Play()
			pop.Scale = 0.4
			Motion.tween(pop, Motion.T.pop, { Scale = 1 })
			glow.Visible = true
			fx:spin(glow, 8)
			-- Then an idle bob while the player reads (after the pop: a new tween on Scale would cut it short).
			task.delay(Motion.T.pop.Time, function()
				if not finished then
					fx:loop(pop, TweenInfo.new(1.2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Scale = 1.04 })
				end
			end)
		end
		word.Visible = true
		name.Visible = true
		Motion.enter({ word }, { from = "pop", delay = 0.1 })
		Motion.enter({ name }, { delay = 0.2 })
		local tag = newTag
		if tag then
			task.delay(0.35, function()
				tag.Visible = true
				Motion.punch(tag, 0.3)
			end)
		end
		task.delay(if reduced then 0 else 0.3, function()
			claim.Visible = true
			Motion.enter({ claim }, { delay = 0 })
			if Ui.onGamepad() then
				GuiService.SelectedObject = claim
			end
		end)
	end

	-- Anticipation: a growing shake on a silhouette (0.8 s), then the reveal. Skipped by a tap or a key.
	if reduced then
		reveal()
	else
		fx:keyframes(icon, {
			Rotation = {
				{ at = 0, value = 0 },
				{ at = 0.15, value = -3, ease = Enum.EasingStyle.Sine },
				{ at = 0.3, value = 4, ease = Enum.EasingStyle.Sine },
				{ at = 0.45, value = -6, ease = Enum.EasingStyle.Sine },
				{ at = 0.6, value = 8, ease = Enum.EasingStyle.Sine },
				{ at = 0.72, value = -10, ease = Enum.EasingStyle.Sine },
				{ at = 0.8, value = 0, ease = Enum.EasingStyle.Sine },
			},
		}, { onDone = reveal })
		fx:keyframes(pop, { Scale = { { at = 0, value = 0.9 }, { at = 0.8, value = 0.82, ease = Enum.EasingStyle.Quad, direction = Enum.EasingDirection.In } } })
	end
	backdrop.Activated:Connect(reveal)

	local action = "RewardClaim"
	local function finish()
		if finished then
			return
		end
		finished = true
		ContextActionService:UnbindAction(action)
		if GuiService.SelectedObject == claim then
			GuiService.SelectedObject = nil
		end
		local coins = item.coins or 0
		local target = o.flyTo
		if coins > 0 and target then
			local count = math.clamp(math.floor(coins / 25), 4, 10)
			local each = math.floor(coins / count)
			Motion.fly({
				from = icon,
				to = target,
				image = if COIN ~= "" then COIN else item.icon,
				count = count,
				onEach = function(i: number)
					if o.onCoins then
						o.onCoins(if i == count then coins - each * (count - 1) else each)
					end
				end,
			})
		elseif coins > 0 and o.onCoins then
			o.onCoins(coins)
		end
		local out = TweenInfo.new(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.In)
		TweenService:Create(backdrop, out, { BackgroundTransparency = 1 }):Play()
		for _, d in column:GetDescendants() do
			if d:IsA("TextLabel") or d:IsA("TextButton") then
				TweenService:Create(d, out, { TextTransparency = 1, BackgroundTransparency = 1 }):Play()
			elseif d:IsA("ImageLabel") then
				TweenService:Create(d, out, { ImageTransparency = 1 }):Play()
			elseif d:IsA("Frame") and d.BackgroundTransparency < 1 then
				TweenService:Create(d, out, { BackgroundTransparency = 1 }):Play()
			elseif d:IsA("UIStroke") then
				TweenService:Create(d, out, { Transparency = 1 }):Play()
			end
		end
		task.delay(out.Time + 0.05, function()
			backdrop:Destroy()
			if o.onDone then
				o.onDone()
			end
		end)
	end
	claim.Activated:Connect(finish)
	-- Keys: Enter, Space or gamepad A/B skip the anticipation, then claim.
	ContextActionService:BindAction(action, function(_: string, state: Enum.UserInputState): Enum.ContextActionResult
		if state == Enum.UserInputState.Begin then
			if revealed and claim.Visible then
				finish()
			else
				reveal()
			end
		end
		return Enum.ContextActionResult.Sink
	end, false, Enum.KeyCode.Return, Enum.KeyCode.Space, Enum.KeyCode.ButtonA, Enum.KeyCode.ButtonB)
end

return Reveal
```

## Round end and level up
**The sequence**: VICTORY (or DEFEAT) slams in (scale 1.8 to 1 in 0.22 s Quad In, then a shake), rises to the
top (0.35 s Quint), the results panel comes up (0.24 s), the top three arrive row by row (80 ms apart), your
numbers count up, the XP bar fills; a level up fills it to the end, LEVEL UP! lands, the level ticks over and
the bar fills again from zero; then Play again (primary) and Lobby, with a countdown. **Per device**: the panel
on a landscape phone is about 315 design px high, so the board and your numbers sit side by side; a phone
held upright and every bigger screen stack them in one column (760 wide on desktop). **Reduce Motion**: the
final state at once.

`src/Client/UI/RoundEnd.luau`:
```lua
--!strict
-- src/Client/UI/RoundEnd.luau: the round-end screen with a level-up. VICTORY (or DEFEAT) slams in and rises
-- to the top, the results panel comes up, the top three arrive row by row, your numbers count up, the XP bar
-- fills (on a level up: it fills, LEVEL UP! lands, the level ticks over and the bar fills again from zero),
-- then Play again and Lobby, with a countdown. A landscape phone gets two columns side by side (the panel is
-- only about 315 design px high there); everything else one column. Reduce Motion: the final state, no slam.
--   local RoundEnd = require(script.Parent.RoundEnd)
--   RoundEnd.show(screen, { won = true, reason = "Kill limit reached", top = { { name = "Nova", score = 12 } },
--     stats = { { label = "Kills", value = 7 }, { label = "Scrap", value = 340 } },
--     xp = { level = 4, from = 120, gained = 380 } }, { onPlayAgain = ..., onLobby = ... })
local GuiService = game:GetService("GuiService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Motion = require(Shared:WaitForChild("Motion"))
local Ui = require(Shared:WaitForChild("Ui"))

local RoundEnd = {}

export type Result = {
	won: boolean,
	reason: string?,
	top: { { name: string, score: number } }, -- the best three, best first
	stats: { { label: string, value: number } }, -- your numbers (two or three)
	xp: { level: number, from: number, gained: number }?, -- XP into the current level before the round, and gained
	returnAt: number?, -- workspace:GetServerTimeNow() when the server sends everyone back
}
export type Options = { onPlayAgain: (() -> ())?, onLobby: (() -> ())? }

--- XP a level takes (the game's own curve goes here).
function RoundEnd.need(level: number): number
	return 100 + 50 * level
end

local function label(parent: Instance, text: string, size: number, font: Font, color: Color3, order: number?): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.AutomaticSize = Enum.AutomaticSize.XY
	l.FontFace = font
	l.TextSize = size
	l.TextColor3 = color
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = text
	l.LayoutOrder = order or 0
	l.Parent = parent
	return l
end

local function stack(parent: Instance, name: string, gap: number, order: number): Frame
	local f = Instance.new("Frame")
	f.Name = name
	f.BackgroundTransparency = 1
	f.AutomaticSize = Enum.AutomaticSize.Y
	f.Size = UDim2.fromScale(1, 0)
	f.LayoutOrder = order
	local list = Instance.new("UIListLayout")
	list.Padding = UDim.new(0, gap)
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.Parent = f
	f.Parent = parent
	return f
end

--- Shows the round end on `screen` (a Ui.screen, DisplayOrder 20). Returns a function that closes it.
function RoundEnd.show(screen: ScreenGui, result: Result, opts: Options?): () -> ()
	local o: Options = opts or {}
	local t = Ui.theme
	local device = Ui.device(screen)
	local phone = device.form == "phone"
	local sideBySide = phone and not device.portrait
	local reduced = Motion.reduced()

	local root = Instance.new("Frame")
	root.Name = "RoundEnd"
	root.BackgroundColor3 = Color3.new(0, 0, 0)
	root.BackgroundTransparency = Ui.alpha(0.4)
	root.Size = UDim2.fromScale(1, 1)
	root.Parent = screen
	local fx = Motion.scope(root)

	-- The splash: big, then up to the top to make room.
	local splash = label(root, if result.won then "VICTORY" else "DEFEAT", if phone then 64 else 112, t.bold, if result.won then t.accent else t.text)
	splash.AnchorPoint = Vector2.new(0.5, 0.5)
	splash.Position = UDim2.fromScale(0.5, 0.42)
	local splashStroke = Instance.new("UIStroke")
	splashStroke.Thickness = 4
	splashStroke.Transparency = 0.15
	splashStroke.Parent = splash
	local splashScale = Instance.new("UIScale")
	splashScale.Parent = splash
	local top = UDim2.new(0.5, 0, 0, if phone then 30 else 70)

	-- The panel: one column, or two side by side on a landscape phone.
	local panel = Instance.new("Frame")
	panel.Name = "Results"
	panel.BackgroundColor3 = t.surface
	panel.AnchorPoint = Vector2.new(0.5, 1)
	panel.Position = UDim2.new(0.5, 0, 1, if phone then -12 else -48)
	panel.Size = if sideBySide then UDim2.new(1, -32, 1, -84) elseif phone then UDim2.new(1, -24, 0.78, 0) else UDim2.fromOffset(760, 0)
	panel.AutomaticSize = if sideBySide or phone then Enum.AutomaticSize.None else Enum.AutomaticSize.Y
	local round = Instance.new("UICorner")
	round.CornerRadius = UDim.new(0, t.radius)
	round.Parent = panel
	Ui.shadow(panel, 3)
	local padding = Instance.new("UIPadding")
	for _, side in { "PaddingLeft", "PaddingRight", "PaddingTop", "PaddingBottom" } do
		(padding :: any)[side] = UDim.new(0, if phone then 16 else 28)
	end
	padding.Parent = panel
	local flow = Instance.new("UIListLayout")
	flow.FillDirection = if sideBySide then Enum.FillDirection.Horizontal else Enum.FillDirection.Vertical
	flow.Padding = UDim.new(0, if phone then 16 else 24)
	flow.SortOrder = Enum.SortOrder.LayoutOrder
	flow.Parent = panel
	panel.Visible = false
	panel.Parent = root
	local left = stack(panel, "Board", 8, 1)
	local right = stack(panel, "You", if phone then 10 else 16, 2)
	if sideBySide then
		left.Size = UDim2.fromScale(0.46, 1)
		right.Size = UDim2.new(0.54, -16, 1, 0)
		left.AutomaticSize = Enum.AutomaticSize.None
		right.AutomaticSize = Enum.AutomaticSize.None
	end

	-- The board: why the round ended, then the best three.
	label(left, string.upper(result.reason or "Round over"), 16, t.bold, t.subtext, 0)
	local rows: { Instance } = {}
	for i, entry in result.top do
		if i > 3 then
			break
		end
		local row = Instance.new("Frame")
		row.Name = "Row" .. i
		row.BackgroundColor3 = t.raised
		row.Size = UDim2.new(1, 0, 0, if phone then 40 else 48)
		row.LayoutOrder = i
		local rowRound = Instance.new("UICorner")
		rowRound.CornerRadius = UDim.new(0, 8)
		rowRound.Parent = row
		local place = label(row, tostring(i), 22, t.bold, if i == 1 then t.accent else t.subtext)
		place.Position = UDim2.new(0, 14, 0.5, 0)
		place.AnchorPoint = Vector2.new(0, 0.5)
		local who = label(row, entry.name, 20, t.font, t.text)
		who.AutomaticSize = Enum.AutomaticSize.None
		who.Size = UDim2.new(1, -130, 1, 0)
		who.Position = UDim2.fromOffset(48, 0)
		who.TextTruncate = Enum.TextTruncate.AtEnd
		local score = label(row, Motion.commas(entry.score), 20, t.bold, t.text)
		score.AnchorPoint = Vector2.new(1, 0.5)
		score.Position = UDim2.new(1, -14, 0.5, 0)
		row.Parent = left
		table.insert(rows, row)
	end

	-- You: your numbers (tiles in a row), the XP bar, the buttons and the countdown.
	local tiles = Instance.new("Frame")
	tiles.Name = "Stats"
	tiles.BackgroundTransparency = 1
	tiles.Size = UDim2.new(1, 0, 0, if phone then 64 else 84)
	tiles.LayoutOrder = 1
	local tileRow = Instance.new("UIListLayout")
	tileRow.FillDirection = Enum.FillDirection.Horizontal
	tileRow.HorizontalFlex = Enum.UIFlexAlignment.Fill
	tileRow.Padding = UDim.new(0, 12)
	tileRow.SortOrder = Enum.SortOrder.LayoutOrder
	tileRow.Parent = tiles
	tiles.Parent = right
	local counters: { { label: TextLabel, value: number } } = {}
	for i, stat in result.stats do
		local tile = Instance.new("Frame")
		tile.Name = stat.label
		tile.BackgroundColor3 = t.raised
		tile.Size = UDim2.fromScale(0, 1)
		tile.LayoutOrder = i
		local tileRound = Instance.new("UICorner")
		tileRound.CornerRadius = UDim.new(0, 10)
		tileRound.Parent = tile
		local caption = label(tile, string.upper(stat.label), 15, t.bold, t.subtext)
		caption.Position = UDim2.fromOffset(14, 8)
		local number = label(tile, "0", if phone then 26 else 34, t.bold, t.text)
		number.AnchorPoint = Vector2.new(0, 1)
		number.Position = UDim2.new(0, 14, 1, -6)
		tile.Parent = tiles
		table.insert(counters, { label = number, value = stat.value })
	end

	local xpRow = stack(right, "XP", 6, 2)
	local levelText = label(xpRow, "", 18, t.bold, t.text, 1)
	local track = Instance.new("Frame")
	track.Name = "Bar"
	track.BackgroundColor3 = t.raised
	track.Size = UDim2.new(1, 0, 0, if phone then 14 else 18)
	track.LayoutOrder = 2
	local fill = Instance.new("Frame")
	fill.Name = "Fill"
	fill.BackgroundColor3 = Color3.fromHex("7CFF6B") -- XP green (semantic colour)
	fill.Size = UDim2.fromScale(0, 1)
	fill.Parent = track
	for _, bar in { track, fill } do
		local pill = Instance.new("UICorner")
		pill.CornerRadius = UDim.new(0.5, 0)
		pill.Parent = bar
	end
	track.Parent = xpRow
	local badge = label(xpRow, "LEVEL UP!", if phone then 22 else 28, t.bold, t.accent, 3)
	badge.Visible = false

	local buttons = Instance.new("Frame")
	buttons.Name = "Buttons"
	buttons.BackgroundTransparency = 1
	buttons.Size = UDim2.new(1, 0, 0, if phone then 56 else 64)
	buttons.LayoutOrder = 3
	local buttonRow = Instance.new("UIListLayout")
	buttonRow.FillDirection = Enum.FillDirection.Horizontal
	buttonRow.HorizontalFlex = Enum.UIFlexAlignment.Fill
	buttonRow.Padding = UDim.new(0, 12)
	buttonRow.SortOrder = Enum.SortOrder.LayoutOrder
	buttonRow.Parent = buttons
	buttons.Parent = right
	local lobby = Ui.button(buttons, "Lobby", "secondary")
	lobby.LayoutOrder = 1
	local again = Ui.button(buttons, "Play again", "primary")
	again.LayoutOrder = 2
	for _, b in { lobby, again } do
		b.AutomaticSize = Enum.AutomaticSize.None
		b.Size = UDim2.fromScale(0, 1)
	end
	buttons.Visible = false
	local footer = label(right, "", 16, t.font, t.subtext, 4)

	local closed = false
	local function close()
		if closed then
			return
		end
		closed = true
		if GuiService.SelectedObject and GuiService.SelectedObject:IsDescendantOf(root) then
			GuiService.SelectedObject = nil
		end
		root:Destroy() -- its scope stops with it
	end
	again.Activated:Connect(function()
		close()
		if o.onPlayAgain then
			o.onPlayAgain()
		end
	end)
	lobby.Activated:Connect(function()
		close()
		if o.onLobby then
			o.onLobby()
		end
	end)

	-- The XP bar, level by level: fill to the end, LEVEL UP!, tick the level, refill from zero.
	local function runXp(startAt: number)
		local xp = result.xp
		if not xp then
			xpRow.Visible = false
			return
		end
		local level, into, left = xp.level, xp.from, xp.gained
		local function show()
			levelText.Text = string.format("Level %d  ·  %s / %s XP", level, Motion.commas(into), Motion.commas(RoundEnd.need(level)))
		end
		show()
		fill.Size = UDim2.fromScale(math.clamp(into / RoundEnd.need(level), 0, 1), 1)
		local at = startAt
		local steps: { Motion.Step } = {}
		while left > 0 do
			local need = RoundEnd.need(level)
			local take = math.min(left, need - into)
			local seconds = math.clamp(take / need * 1.2, 0.25, 1.2)
			local target = (into + take) / need
			local nextInto = into + take
			table.insert(steps, { at = at, target = fill :: Instance, info = TweenInfo.new(seconds, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), goal = { Size = UDim2.fromScale(target, 1) } })
			left -= take
			at += seconds
			if nextInto >= need then
				local newLevel = level + 1
				table.insert(steps, {
					at = at,
					call = function()
						level, into = newLevel, 0
						show()
						badge.Visible = true
						Motion.punch(badge, 0.25)
						fill.Size = UDim2.fromScale(0, 1)
					end,
				})
				at += 0.35
				level, into = newLevel, 0
			else
				local landed = nextInto
				table.insert(steps, {
					at = at,
					call = function()
						into = landed
						show()
					end,
				})
				into = nextInto
			end
		end
		-- Replay from the start values: the steps above ran the numbers ahead to build the timeline.
		level, into = xp.level, xp.from
		show()
		fx:timeline(steps)
	end

	-- The sequence.
	local function panelIn(at: number)
		fx:timeline({
			{
				at = at,
				call = function()
					panel.Visible = true
					Motion.enter({ panel }, { from = "up", distance = 40 })
					Motion.enter(rows, { delay = 0.15, gap = 0.08 })
					for _, c in counters do
						task.delay(0.3, function()
							Motion.count(c.label, 0, c.value)
						end)
					end
				end,
			},
			{
				at = at + 1.4,
				call = function()
					buttons.Visible = true
					Motion.enter({ again, lobby }, {})
					if Ui.onGamepad() then
						GuiService.SelectedObject = again
					end
				end,
			},
		})
		runXp(at + 0.5)
	end
	if reduced then
		splash.Position = top
		splashScale.Scale = if phone then 0.8 else 0.6
		panelIn(0)
	else
		splashScale.Scale = 1.8
		splash.TextTransparency = 1
		splashStroke.Transparency = 1
		TweenService:Create(splash, TweenInfo.new(0.15), { TextTransparency = 0 }):Play()
		TweenService:Create(splashStroke, TweenInfo.new(0.15), { Transparency = 0.15 }):Play()
		local slam = TweenInfo.new(0.22, Enum.EasingStyle.Quad, Enum.EasingDirection.In)
		Motion.tween(splashScale, slam, { Scale = 1 })
		fx:timeline({
			{
				at = slam.Time,
				call = function()
					Motion.shake(splash, 3)
				end,
			},
			{ at = 0.9, target = splash, info = TweenInfo.new(0.35, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), goal = { Position = top } },
			{ at = 0.9, target = splashScale, info = TweenInfo.new(0.35, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), goal = { Scale = if phone then 0.8 else 0.6 } },
		})
		panelIn(1.0)
	end

	-- The countdown back to the lobby (a text change each second: no motion).
	local returnAt = result.returnAt
	if returnAt then
		local ticking = task.spawn(function()
			while not closed do
				footer.Text = string.format("Back to the lobby in %d", math.max(0, math.ceil(returnAt - workspace:GetServerTimeNow())))
				task.wait(0.25)
			end
		end)
		fx:add(function()
			task.cancel(ticking)
		end)
	end
	return close
end

return RoundEnd
```

## Interaction patterns
Tabs with a sliding indicator (the indicator is a sibling of the row so the layout never moves it; it follows
the tab on a spring; L1/R1 and Q/E switch only while the window is open):
```lua
--!strict
-- Tabs with a sliding indicator: an accent pill that springs to the chosen tab (it sits beside the row, so the
-- row's UIListLayout never lays it out), labels that change colour, and L1/R1 or Q/E to switch while the
-- window is open. Keep it to 5 tabs on a phone (short words), 7 on desktop.
local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)

local function slidingTabs(window: Ui.Window, names: { string }, onSelect: (index: number) -> ()): (index: number) -> ()
	local t = Ui.theme
	local bar = Instance.new("Frame")
	bar.Name = "Tabs"
	bar.BackgroundColor3 = t.raised
	bar.Size = UDim2.new(1, 0, 0, 60)
	local barRound = Instance.new("UICorner")
	barRound.CornerRadius = UDim.new(0.5, 0)
	barRound.Parent = bar
	local indicator = Instance.new("Frame")
	indicator.Name = "Indicator"
	indicator.BackgroundColor3 = t.accent
	indicator.Position = UDim2.fromOffset(4, 4)
	indicator.Size = UDim2.fromOffset(0, 52)
	local pill = Instance.new("UICorner")
	pill.CornerRadius = UDim.new(0.5, 0)
	pill.Parent = indicator
	indicator.Parent = bar
	local row = Instance.new("Frame")
	row.Name = "Row"
	row.BackgroundTransparency = 1
	row.Position = UDim2.fromOffset(4, 4)
	row.Size = UDim2.new(1, -8, 0, 52)
	row.ZIndex = 2 -- labels over the indicator
	local list = Instance.new("UIListLayout")
	list.FillDirection = Enum.FillDirection.Horizontal
	list.HorizontalFlex = Enum.UIFlexAlignment.Fill -- equal shares of the bar
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.Parent = row
	row.Parent = bar
	local buttons: { TextButton } = {}
	local current = 1
	-- The indicator follows the chosen tab's place in the row, in design px (the row is 52 tall, so its
	-- height gives the UIScale above it). Called again whenever the layout moves the tab.
	local function place()
		local b = buttons[current]
		local k = row.AbsoluteSize.Y / 52
		if b and k > 0 then
			local x = (b.AbsolutePosition.X - row.AbsolutePosition.X) / k
			Motion.spring(indicator, { Position = UDim2.fromOffset(4 + x, 4), Size = UDim2.fromOffset(b.AbsoluteSize.X / k, 52) }, 5, 0.8)
		end
	end
	local function choose(index: number)
		current = math.clamp(index, 1, #buttons)
		place()
		for i, other in buttons do
			Ui.play(other, Motion.T.hover, { TextColor3 = if i == current then t.accentText else t.subtext })
		end
		onSelect(current)
	end
	for i, name in names do
		local b = Instance.new("TextButton")
		b.Name = name
		b.AutoButtonColor = false
		b.BackgroundTransparency = 1
		b.FontFace = t.bold
		b.Text = name
		b.TextSize = 18
		b.TextColor3 = t.subtext
		b.Size = UDim2.fromScale(0, 1)
		b.LayoutOrder = i
		b.Activated:Connect(function()
			choose(i)
		end)
		for _, prop in { "AbsolutePosition", "AbsoluteSize" } do
			b:GetPropertyChangedSignal(prop):Connect(function()
				if i == current then
					place()
				end
			end)
		end
		b.Parent = row
		table.insert(buttons, b)
	end
	bar.Parent = window.body
	choose(1)
	-- Bumpers and Q/E switch tabs only while the window is open (they are gameplay keys otherwise).
	local action = "SlidingTabs_" .. window.root.Name
	window.opened.Event:Connect(function()
		ContextActionService:BindAction(action, function(_: string, state: Enum.UserInputState, input: InputObject): Enum.ContextActionResult
			if state == Enum.UserInputState.Begin then
				local back = input.KeyCode == Enum.KeyCode.ButtonL1 or input.KeyCode == Enum.KeyCode.Q
				choose(if back then current - 1 else current + 1)
			end
			return Enum.ContextActionResult.Sink
		end, false, Enum.KeyCode.ButtonL1, Enum.KeyCode.ButtonR1, Enum.KeyCode.Q, Enum.KeyCode.E)
	end)
	window.closed.Event:Connect(function()
		ContextActionService:UnbindAction(action)
	end)
	return choose
end

local screen = Ui.screen("Inventory", 10, Players.LocalPlayer:WaitForChild("PlayerGui"))
local window = Ui.window(screen, "Inventory", Vector2.new(980, 680))
slidingTabs(window, { "Weapons", "Armor", "Pets", "Items" }, function(_: number) end)
window.open()
```
A snap carousel: UIPageLayout swipes and snaps natively (touch, wheel, gamepad); neighbours peek; the current
card's face grows on a spring (the layout owns the holder, the face inside it scales):
```lua
--!strict
-- A snap carousel (a map vote, character select, battle-pass tiers): UIPageLayout does the swipe and the snap
-- natively (touch swipes, the scroll wheel, gamepad selection); the neighbours peek in at the sides; the
-- current card grows on a spring. Each card is a holder the layout places and a face inside it that scales
-- (the layout owns the holder's size). Arrows and dots for mouse players; L1/R1 for gamepads while it shows.
local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)

local function carousel(parent: GuiObject, count: number, build: (face: Frame, index: number) -> ()): UIPageLayout
	local t = Ui.theme
	local view = Instance.new("Frame")
	view.Name = "Carousel"
	view.BackgroundTransparency = 1
	view.ClipsDescendants = true
	view.Size = UDim2.new(1, 0, 1, -64)
	local pages = Instance.new("UIPageLayout")
	pages.FillDirection = Enum.FillDirection.Horizontal
	pages.HorizontalAlignment = Enum.HorizontalAlignment.Center -- the current card in the middle, neighbours peek
	pages.Padding = UDim.new(0, 24)
	pages.SortOrder = Enum.SortOrder.LayoutOrder
	pages.Animated = not Motion.reduced()
	pages.TweenTime = 0.3
	pages.EasingStyle = Enum.EasingStyle.Quint
	pages.EasingDirection = Enum.EasingDirection.Out
	pages.TouchInputEnabled = true
	pages.ScrollWheelInputEnabled = true
	pages.GamepadInputEnabled = true
	pages.Parent = view
	local faces: { [Instance]: UIScale } = {}
	local cards: { Frame } = {}
	for i = 1, count do
		local holder = Instance.new("Frame")
		holder.Name = "Card" .. i
		holder.BackgroundTransparency = 1
		holder.Size = UDim2.fromScale(0.42, 1)
		holder.LayoutOrder = i
		local face = Instance.new("Frame")
		face.Name = "Face"
		face.BackgroundColor3 = t.raised
		face.AnchorPoint = Vector2.new(0.5, 0.5)
		face.Position = UDim2.fromScale(0.5, 0.5)
		face.Size = UDim2.fromScale(1, 1)
		local round = Instance.new("UICorner")
		round.CornerRadius = UDim.new(0, t.radius)
		round.Parent = face
		local scale = Instance.new("UIScale")
		scale.Scale = 0.86
		scale.Parent = face
		face.Parent = holder
		holder.Parent = view
		faces[holder] = scale
		table.insert(cards, holder)
		build(face, i)
	end
	view.Parent = parent

	-- Arrows and dots under it.
	local controls = Instance.new("Frame")
	controls.Name = "Controls"
	controls.BackgroundTransparency = 1
	controls.AnchorPoint = Vector2.new(0.5, 1)
	controls.Position = UDim2.fromScale(0.5, 1)
	controls.AutomaticSize = Enum.AutomaticSize.X
	controls.Size = UDim2.fromOffset(0, 56)
	local row = Instance.new("UIListLayout")
	row.FillDirection = Enum.FillDirection.Horizontal
	row.VerticalAlignment = Enum.VerticalAlignment.Center
	row.Padding = UDim.new(0, 12)
	row.SortOrder = Enum.SortOrder.LayoutOrder
	row.Parent = controls
	local back = Ui.button(controls, "<", "secondary")
	back.LayoutOrder = 0
	local dots: { Frame } = {}
	for i = 1, count do
		local dot = Instance.new("Frame")
		dot.BackgroundColor3 = t.subtext
		dot.Size = UDim2.fromOffset(10, 10)
		dot.LayoutOrder = i
		local pill = Instance.new("UICorner")
		pill.CornerRadius = UDim.new(0.5, 0)
		pill.Parent = dot
		dot.Parent = controls
		table.insert(dots, dot)
	end
	local forward = Ui.button(controls, ">", "secondary")
	forward.LayoutOrder = count + 1
	controls.Parent = parent
	back.Activated:Connect(function()
		pages:Previous()
	end)
	forward.Activated:Connect(function()
		pages:Next()
	end)

	local function focus()
		for holder, scale in faces do
			Motion.spring(scale, { Scale = if holder == pages.CurrentPage then 1 else 0.86 }, 4, 0.7)
		end
		for i, dot in dots do
			Ui.play(dot, Motion.T.hover, { BackgroundColor3 = if cards[i] == pages.CurrentPage then t.accent else t.subtext })
		end
	end
	pages:GetPropertyChangedSignal("CurrentPage"):Connect(focus)
	task.defer(focus)

	-- Bumpers while the carousel is on screen.
	local action = "Carousel_" .. parent.Name
	local function bind(on: boolean)
		if on then
			ContextActionService:BindAction(action, function(_: string, state: Enum.UserInputState, input: InputObject): Enum.ContextActionResult
				if state == Enum.UserInputState.Begin then
					if input.KeyCode == Enum.KeyCode.ButtonL1 then
						pages:Previous()
					else
						pages:Next()
					end
				end
				return Enum.ContextActionResult.Sink
			end, false, Enum.KeyCode.ButtonL1, Enum.KeyCode.ButtonR1)
		else
			ContextActionService:UnbindAction(action)
		end
	end
	parent:GetPropertyChangedSignal("Visible"):Connect(function()
		bind(parent.Visible)
	end)
	bind(parent.Visible)
	return pages
end

local screen = Ui.screen("MapVote", 10, Players.LocalPlayer:WaitForChild("PlayerGui"))
local window = Ui.window(screen, "Vote for the next map", Vector2.new(980, 680))
carousel(window.body, 5, function(face: Frame, index: number)
	local name = Instance.new("TextLabel")
	name.BackgroundTransparency = 1
	name.Size = UDim2.fromScale(1, 1)
	name.FontFace = Ui.theme.bold
	name.TextSize = 28
	name.TextColor3 = Ui.theme.text
	name.Text = "Map " .. index
	name.Parent = face
end)
window.open()
```
Drag and drop with an alternative for every input (drag; or tap the item, then the slot; or A, A; B cancels),
one `drop` for all of them:
```lua
--!strict
-- Drag and drop, with an alternative for every input: drag an item onto a hotbar slot with a mouse or a
-- finger (a ghost follows the pointer on a spring and the slot under it lights up; on touch hold 0.3 s first,
-- so a quick swipe still scrolls the list), OR tap the item and then
-- tap the slot (touch players' default: no precision needed), OR on a gamepad press A on the item and A on the
-- slot (B cancels). Every way ends in the same drop(item, slot), which asks the server.
local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)

local function dragAndDrop(overlay: ScreenGui, items: { ImageButton }, slots: { GuiButton }, drop: (item: ImageButton, slot: GuiButton) -> ()): () -> ()
	local t = Ui.theme
	local picked: ImageButton? = nil -- tapped or A-pressed, waiting for a slot
	local pressed: ImageButton? = nil -- held by a mouse button or a finger
	local pressedAt = Vector2.zero
	local pressedTouch = false
	local pressedTime = 0
	local frozen: ScrollingFrame? = nil -- the list the drag started in: it doesn't scroll while dragging
	local ghost: ImageLabel? = nil
	local lit: GuiButton? = nil
	local justDragged = false
	local connections: { RBXScriptConnection } = {}

	local function edge(o: GuiObject): UIStroke
		local s = o:FindFirstChild("DropEdge")
		if s and s:IsA("UIStroke") then
			return s
		end
		local made = Instance.new("UIStroke")
		made.Name = "DropEdge"
		made.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
		made.Color = t.accent
		made.Thickness = 3
		made.Transparency = 1
		made.Parent = o
		return made
	end
	local function light(slot: GuiButton?)
		if lit == slot then
			return
		end
		if lit then
			Ui.play(edge(lit), Motion.T.hover, { Transparency = 1 })
		end
		lit = slot
		if slot then
			Ui.play(edge(slot), Motion.T.hover, { Transparency = 0 })
		end
	end
	-- The ghost: a copy of the item's picture that follows the pointer, on the overlay above everything.
	local function makeGhost(item: ImageButton): ImageLabel
		local g = Instance.new("ImageLabel")
		g.Name = "Ghost"
		g.BackgroundTransparency = 1
		g.Image = item.Image
		g.ImageTransparency = 0.15
		g.AnchorPoint = Vector2.new(0.5, 0.5)
		g.Size = UDim2.fromOffset(item.AbsoluteSize.X, item.AbsoluteSize.Y)
		local start = pressedAt - overlay.AbsolutePosition
		g.Position = UDim2.fromOffset(start.X, start.Y)
		g.Parent = overlay
		ghost = g
		return g
	end
	local function slotAt(p: Vector2): GuiButton?
		for _, slot in slots do
			local a, s = slot.AbsolutePosition, slot.AbsoluteSize
			if p.X >= a.X and p.X <= a.X + s.X and p.Y >= a.Y and p.Y <= a.Y + s.Y then
				return slot
			end
		end
		return nil
	end
	local function unpick()
		local item = picked
		picked = nil
		if item then
			Ui.play(edge(item), Motion.T.hover, { Transparency = 1 })
		end
		for _, slot in slots do
			Ui.play(edge(slot), Motion.T.hover, { Transparency = 1 })
		end
		ContextActionService:UnbindAction("DropCancel")
	end
	local function pick(item: ImageButton)
		unpick()
		picked = item
		Ui.play(edge(item), Motion.T.hover, { Transparency = 0 })
		for _, slot in slots do -- every slot shows it can take it
			Ui.play(edge(slot), Motion.T.hover, { Transparency = 0.6 })
		end
		ContextActionService:BindAction("DropCancel", function(_: string, state: Enum.UserInputState): Enum.ContextActionResult
			if state == Enum.UserInputState.Begin then
				unpick()
			end
			return Enum.ContextActionResult.Sink
		end, false, Enum.KeyCode.ButtonB, Enum.KeyCode.Escape)
	end

	for _, item in items do
		item.Activated:Connect(function() -- a tap, a click or A
			if justDragged then
				justDragged = false
			elseif picked == item then
				unpick()
			else
				pick(item)
				Motion.punch(item, 0.08)
			end
		end)
		item.InputBegan:Connect(function(input: InputObject)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
				pressed = item
				pressedAt = Vector2.new(input.Position.X, input.Position.Y)
				pressedTouch = input.UserInputType == Enum.UserInputType.Touch
				pressedTime = os.clock()
			end
		end)
	end
	for _, slot in slots do
		slot.Activated:Connect(function()
			local item = picked
			if item then
				unpick()
				drop(item, slot)
			end
		end)
	end

	table.insert(connections, UserInputService.InputChanged:Connect(function(input: InputObject)
		local item = pressed
		if not item or (input.UserInputType ~= Enum.UserInputType.MouseMovement and input.UserInputType ~= Enum.UserInputType.Touch) then
			return
		end
		local at = Vector2.new(input.Position.X, input.Position.Y)
		if not ghost then
			if (at - pressedAt).Magnitude < 10 then
				return -- still a tap
			end
			if pressedTouch and os.clock() - pressedTime < 0.3 then
				pressed = nil -- a swipe: the list scrolls
				return
			end
			unpick()
			local list = item:FindFirstAncestorOfClass("ScrollingFrame")
			if list then
				list.ScrollingEnabled = false
				frozen = list
			end
		end
		local g: ImageLabel = ghost or makeGhost(item)
		local p = at - overlay.AbsolutePosition -- InputObject.Position and AbsolutePosition share a space
		Motion.spring(g, { Position = UDim2.fromOffset(p.X, p.Y) }, 9, 0.9)
		light(slotAt(at))
	end))
	table.insert(connections, UserInputService.InputEnded:Connect(function(input: InputObject)
		local item = pressed
		if not item or (input.UserInputType ~= Enum.UserInputType.MouseButton1 and input.UserInputType ~= Enum.UserInputType.Touch) then
			return
		end
		pressed = nil
		local list = frozen
		if list then
			list.ScrollingEnabled = true
			frozen = nil
		end
		local g = ghost
		if g then
			ghost = nil
			justDragged = true -- the click that ends a drag is not a pick
			task.delay(0.1, function()
				justDragged = false
			end)
			local slot = slotAt(Vector2.new(input.Position.X, input.Position.Y))
			light(nil)
			g:Destroy()
			if slot then
				drop(item, slot)
			end
		end
	end))
	return function()
		for _, c in connections do
			c:Disconnect()
		end
		unpick()
	end
end

-- The demo: four items in a grid, three hotbar slots; the server equips (here it just shows the item).
local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
local screen = Ui.screen("Backpack", 10, playerGui)
local overlay = Ui.screen("BackpackDrag", 25, playerGui) -- above the backpack: the ghost travels here
local window = Ui.window(screen, "Backpack", Vector2.new(980, 680))
local grid = Ui.grid(window.body, Vector2.new(96, 96))
grid.Size = UDim2.new(1, 0, 1, -120)
local items: { ImageButton } = {}
for i = 1, 4 do
	local b = Instance.new("ImageButton")
	b.Name = "Item" .. i
	b.BackgroundColor3 = Ui.theme.raised
	b.Image = "rbxassetid://0"
	b.LayoutOrder = i
	b.Parent = grid
	table.insert(items, b)
end
local bar = Instance.new("Frame")
bar.Name = "Hotbar"
bar.BackgroundTransparency = 1
bar.AnchorPoint = Vector2.new(0.5, 1)
bar.Position = UDim2.fromScale(0.5, 1)
bar.Size = UDim2.fromOffset(3 * 96 + 2 * 12, 96)
local row = Instance.new("UIListLayout")
row.FillDirection = Enum.FillDirection.Horizontal
row.Padding = UDim.new(0, 12)
row.Parent = bar
bar.Parent = window.body
local slots: { GuiButton } = {}
for i = 1, 3 do
	local slot = Instance.new("ImageButton")
	slot.Name = "Slot" .. i
	slot.BackgroundColor3 = Ui.theme.surface
	slot.Size = UDim2.fromOffset(96, 96)
	slot.LayoutOrder = i
	slot.Parent = bar
	table.insert(slots, slot)
end
dragAndDrop(overlay, items, slots, function(item: ImageButton, slot: GuiButton)
	if slot:IsA("ImageButton") then
		slot.Image = item.Image -- in a game: ask the server, then show its answer
	end
end)
window.open()
```
A detail panel per device: a bottom sheet on a phone (thumb reach, swipe down to close), a side panel elsewhere:
```lua
--!strict
-- A detail panel that fits the device: a bottom sheet on a phone (in thumb reach; swipe it down, tap outside
-- or press B to close), a side panel on a tablet, desktop or TV (slides in from the right, the world stays
-- visible). Same content, two containers: Ui.onDevice rebuilds the container when the form changes.
local ContextActionService = game:GetService("ContextActionService")
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)

export type Panel = { open: () -> (), close: () -> () }

local function detailPanel(screen: ScreenGui, fill: (body: Frame) -> ()): Panel
	local t = Ui.theme
	local backdrop = Instance.new("TextButton")
	backdrop.Name = "PanelBackdrop"
	backdrop.Text = ""
	backdrop.AutoButtonColor = false
	backdrop.Selectable = false
	backdrop.BackgroundColor3 = Color3.new(0, 0, 0)
	backdrop.BackgroundTransparency = 1
	backdrop.Size = UDim2.fromScale(1, 1)
	backdrop.ZIndex = 5
	backdrop.Visible = false
	backdrop.Parent = screen
	local panel: Frame? = nil
	local isOpen = false
	local sheet = false
	local shown, hidden = UDim2.new(), UDim2.new()
	local closeLater: () -> () = function() end -- close(), defined below

	local function build(device: Ui.Device)
		if panel then
			panel:Destroy()
		end
		sheet = device.form == "phone"
		local p = Instance.new("Frame")
		p.Name = "Panel"
		p.BackgroundColor3 = t.surface
		p.ZIndex = 6
		local round = Instance.new("UICorner")
		round.CornerRadius = UDim.new(0, if sheet then 20 else t.radius)
		round.Parent = p
		Ui.shadow(p, 3)
		local body = Instance.new("Frame")
		body.Name = "Body"
		body.BackgroundTransparency = 1
		body.Size = UDim2.fromScale(1, 1)
		local padding = Instance.new("UIPadding")
		padding.PaddingLeft = UDim.new(0, 20)
		padding.PaddingRight = UDim.new(0, 20)
		padding.PaddingTop = UDim.new(0, if sheet then 28 else 20)
		padding.PaddingBottom = UDim.new(0, if sheet then 32 else 20)
		padding.Parent = body
		body.Parent = p
		if sheet then
			-- Bottom sheet: full width, 60% high (55% upright), its bottom corners tucked under the screen edge.
			p.AnchorPoint = Vector2.new(0.5, 0)
			p.Size = UDim2.new(1, -16, if device.portrait then 0.55 else 0.6, 12)
			shown = UDim2.fromScale(0.5, if device.portrait then 0.45 else 0.4)
			hidden = UDim2.fromScale(0.5, 1)
			local grip = Instance.new("Frame")
			grip.Name = "Grip"
			grip.BackgroundColor3 = t.subtext
			grip.AnchorPoint = Vector2.new(0.5, 0)
			grip.Position = UDim2.new(0.5, 0, 0, 10)
			grip.Size = UDim2.fromOffset(48, 5)
			local pill = Instance.new("UICorner")
			pill.CornerRadius = UDim.new(0.5, 0)
			pill.Parent = grip
			grip.Parent = p
			-- Swipe down to close: follow the finger, let go past 80 px to close, else spring back.
			p.InputBegan:Connect(function(input: InputObject)
				if input.UserInputType ~= Enum.UserInputType.Touch then
					return
				end
				local startY = input.Position.Y
				local fit = screen:FindFirstChildOfClass("UIScale") -- screen pixels per design px
				local k = if fit and fit.Scale > 0 then fit.Scale else 1
				local moved: RBXScriptConnection
				moved = input.Changed:Connect(function()
					local dy = math.max(0, input.Position.Y - startY)
					if input.UserInputState == Enum.UserInputState.End then
						moved:Disconnect()
						if dy > 80 then
							closeLater()
						else
							Motion.spring(p, { Position = shown }, 5, 0.8)
						end
						return
					end
					p.Position = shown + UDim2.fromOffset(0, dy / k)
				end)
			end)
		else
			-- Side panel: 420 wide on the right, full height less a margin.
			p.AnchorPoint = Vector2.new(1, 0.5)
			p.Size = UDim2.new(0, 420, 1, -32)
			shown = UDim2.new(1, -16, 0.5, 0)
			hidden = UDim2.new(1, 440, 0.5, 0)
		end
		p.Position = if isOpen then shown else hidden
		p.Visible = isOpen
		p.Parent = screen
		panel = p
		fill(body)
	end

	local function close()
		local p = panel
		if not isOpen or not p then
			return
		end
		isOpen = false
		ContextActionService:UnbindAction("DetailPanelClose")
		if GuiService.SelectedObject and GuiService.SelectedObject:IsDescendantOf(p) then
			GuiService.SelectedObject = nil
		end
		Ui.play(backdrop, Motion.T.slideOut, { BackgroundTransparency = 1 })
		Motion.tween(p, Motion.T.slideOut, { Position = hidden }).Completed:Once(function()
			if not isOpen then
				p.Visible = false
				backdrop.Visible = false
			end
		end)
	end

	local function open()
		local p = panel
		if isOpen or not p then
			return
		end
		isOpen = true
		backdrop.Visible = true
		p.Visible = true
		Ui.play(backdrop, Motion.T.slideIn, { BackgroundTransparency = if sheet then Ui.alpha(0.5) else 1 })
		Motion.tween(p, Motion.T.slideIn, { Position = shown })
		ContextActionService:BindAction("DetailPanelClose", function(_: string, state: Enum.UserInputState): Enum.ContextActionResult
			if state == Enum.UserInputState.Begin then
				close()
			end
			return Enum.ContextActionResult.Sink
		end, false, Enum.KeyCode.ButtonB, Enum.KeyCode.Escape)
		if Ui.onGamepad() then
			for _, d in p:GetDescendants() do
				if d:IsA("GuiButton") and d.Selectable then
					GuiService.SelectedObject = d
					break
				end
			end
		end
	end

	closeLater = close
	backdrop.Activated:Connect(close)
	Ui.onDevice(screen, build)
	return { open = open, close = close }
end

local screen = Ui.screen("Details", 15, Players.LocalPlayer:WaitForChild("PlayerGui"))
local details = detailPanel(screen, function(body: Frame)
	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.AutomaticSize = Enum.AutomaticSize.XY
	title.FontFace = Ui.theme.bold
	title.TextSize = 28
	title.TextColor3 = Ui.theme.text
	title.Text = "Golden Sword"
	title.Parent = body
	local equip = Ui.button(body, "Equip", "primary")
	equip.AnchorPoint = Vector2.new(0, 1)
	equip.Position = UDim2.fromScale(0, 1)
end)
details.open()
```

## Verification
- `luau_check` clean. In a playtest: the loading screen leaves within its limits (a `print(os.clock())` at
  LoadingScreenDone), the title intro plays after it, Play reaches the game.
- `ui_audit` (it reads the playing client's PlayerGui) on every screen here: no problems on the phone, the
  tablet, the desktop and the TV (and the portrait phone when the game allows portrait); no "looping
  animations still running" warnings after a screen closes.
- Look at each on a phone-sized and a desktop-sized view (roblox_screenshot in a playtest; the user can check
  the feel in Studio's Device emulator), then again with `Motion.setReduced(true)`: nothing important lost.
