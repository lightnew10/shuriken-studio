---
name: roblox-onboarding
description: "The hand-held first-time tutorial every new game gets by default, built with the Guide module: each step puts a soft pulsing spotlight on the one thing to press (everything else lightly dimmed and not clickable) or an outline and a marker on the one place to walk to, with a short hint, and waits for the player to do it; a Skip button is always there. Covers the module (Guide.new, step, run, skip), designing the steps (one action each, in the order the first minute is played, the real buttons and places), first time only (saved in the player's data), replay from Settings, phones (touch buttons as targets), gamepads (the target is selected), world steps, the game's own conditions (waitFor), and the Studio checks."
version: 1
tags: [onboarding, tutorial, first time, ftue, new player, guide, spotlight, highlight, dim, hint, coach marks, hand holding, skip, replay]
roblox_systems: [ScreenGui, GuiService, UserInputService, RunService, TweenService, Highlight, BillboardGui, Players]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [luau_check, roblox_sync_push, roblox_playtest, roblox_run_luau, roblox_screenshot, ui_audit]
---
# Onboarding: the guided first-time tutorial (Guide)

## Purpose
A new player is shown the game by doing it, one press or one walk at a time: where they need to click is
highlighted (a pulsing ring, a hint beside it), where they don't is lightly dimmed and can't be clicked, and
the next step comes when they have done this one. Every new game has this by default, unless the user said
otherwise. It is the first thing a new player sees after loading, and it ends in the game's real loop (their
first round, match, run or purchase), never in a menu.

## Where it lives
A ModuleScript in the game's shared code: `src/Shared/Guide.luau` in a new project
(`ReplicatedStorage.Shared.Guide`); in a plugged-in game, beside its other shared modules in ReplicatedStorage.
The tour itself is a LocalScript that requires it (`src/Client/Tutorial.client.luau` or the game's own client
entry). Client only. The module is below ("The module"), lint-clean under strict luau-lsp and selene: copy it unchanged.

## The API
- `Guide.new(options?) -> Tour`. Options, all optional:
  - `dim` (0 to 1, default 0.45): how dark the rest of the screen gets. Keep it light; 0.35 to 0.5.
  - `color` (Color3): the ring, outline and marker colour (default a warm yellow). Use the game's accent.
  - `block` (default true): clicks outside the spotlight go nowhere. Set false only for a step that needs
    the whole screen (and then give that step a `waitFor`).
  - `onSkip()`: called when the player presses Skip (save that the tutorial is done).
  - `skipText` (default "Skip tutorial").
- `tour:step({ target?, text, reach?, seconds?, waitFor? }) -> Tour` (chainable). One step, one action:
  - `target` a GuiObject: spotlight on it, the hint below it (above when there is no room). A GuiButton
    target moves on when it is pressed (`Activated`: mouse, touch and gamepad); with a gamepad connected it
    is selected, so A presses it. The spotlight follows the target every frame (it may move, scale, tween in).
  - `target` a part, model or attachment in the world: no dim (the player must move); an outline through
    walls and a "▼ text" marker over it, the hint at the top of the screen. With `reach = studs` the step
    moves on when the character is that close.
  - no `target`: a message, the whole screen lightly dimmed, the hint in the middle. It moves on after
    `seconds`, on `waitFor`, or (with neither) on a click or tap anywhere, A or Enter ("Tap to continue").
  - `waitFor = function(done) ... end`: the game's own condition, for anything a press or a distance
    can't say ("open the shop", "equip the sword", "win the duel"). Call `done()` once; connect with
    `:Once` so nothing is left connected.
  - `seconds`: moves on by itself after that long.
- `tour:run() -> boolean` (yields): shows the steps in order; true when every step was done, false when
  skipped. The overlay is gone when it returns. Run it once at a time.
- `tour:skip()`: ends the tour now (the Skip button calls it).

## The module
`src/Shared/Guide.luau`:
```lua
--!strict
-- Guide: a hand-held first-time tutorial. Each step puts a spotlight on the one thing to press (a soft pulsing ring,
-- a hint beside it, everything else lightly dimmed and not clickable) or the one place to go in the world (an outline
-- and a marker over it), and waits for the player to do it. A Skip button is always there. Client only.
--
--   local tour = Guide.new({ onSkip = function() ... end })
--   tour:step({ target = playButton, text = "Press Play to start" })                 -- waits for the press
--   tour:step({ target = workspace.Junkyard.Crate, text = "Walk to the crate", reach = 8 })  -- waits until near
--   tour:step({ target = shopButton, text = "Open the shop", waitFor = function(done) shopOpened:Once(done) end })
--   tour:step({ text = "Win the round to rank up" })                                -- a message: a tap moves on
--   tour:step({ text = "You're ready!", seconds = 3 })                              -- or it moves on by itself
--   local finished = tour:run()  -- true when every step was done, false when skipped
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

export type Step = {
	target: Instance?,
	text: string,
	reach: number?,
	seconds: number?,
	waitFor: ((done: () -> ()) -> ())?,
}

export type Options = {
	dim: number?,
	color: Color3?,
	block: boolean?,
	onSkip: (() -> ())?,
	skipText: string?,
}

local Guide = {}
Guide.__index = Guide

export type Tour = typeof(setmetatable(
	{} :: {
		steps: { Step },
		options: Options,
		gui: ScreenGui?,
		skipped: boolean,
		running: boolean,
		cleanup: { () -> () },
		wake: BindableEvent,
	},
	Guide
))

local ACCENT = Color3.fromRGB(255, 214, 92)

local function reduceMotion(): boolean
	local ok, on = pcall(function()
		return GuiService.ReducedMotionEnabled
	end)
	return ok and on == true
end

function Guide.new(options: Options?): Tour
	local self = setmetatable({
		steps = {},
		options = options or {},
		gui = nil,
		skipped = false,
		running = false,
		cleanup = {},
		wake = Instance.new("BindableEvent"),
	}, Guide)
	return self
end

function Guide.step(self: Tour, step: Step): Tour
	table.insert(self.steps, step)
	return self
end

local function frame(parent: Instance, name: string, transparency: number, z: number): Frame
	local f = Instance.new("Frame")
	f.Name = name
	f.BackgroundColor3 = Color3.new(0, 0, 0)
	f.BackgroundTransparency = transparency
	f.BorderSizePixel = 0
	f.ZIndex = z
	f.Parent = parent
	return f
end

-- The overlay: four dim panels around a hole, the ring, the hint and the Skip button.
local function build(self: Tour): ScreenGui
	local player = Players.LocalPlayer
	local gui = Instance.new("ScreenGui")
	gui.Name = "ShurikenGuide"
	-- Edge to edge, under the top bar and a phone's notch too, so nothing outside the spotlight escapes the dim.
	gui.ScreenInsets = Enum.ScreenInsets.None
	gui.IgnoreGuiInset = true
	gui.ResetOnSpawn = false
	gui.DisplayOrder = 1000
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	local dim = 1 - (self.options.dim or 0.45)
	for _, name in { "DimTop", "DimBottom", "DimLeft", "DimRight" } do
		local f = frame(gui, name, dim, 1)
		-- Clicks outside the spotlight land on the dim and go nowhere (unless block = false).
		f.Active = self.options.block ~= false
		f.Visible = false
	end
	local ring = frame(gui, "Ring", 1, 2)
	ring.Visible = false
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 12)
	corner.Parent = ring
	local stroke = Instance.new("UIStroke")
	stroke.Color = self.options.color or ACCENT
	stroke.Thickness = 3
	stroke.Parent = ring
	local hint = Instance.new("TextLabel")
	hint.Name = "Hint"
	hint.AnchorPoint = Vector2.new(0.5, 0)
	hint.Size = UDim2.fromOffset(320, 0)
	hint.AutomaticSize = Enum.AutomaticSize.Y
	hint.BackgroundColor3 = Color3.fromRGB(24, 26, 32)
	hint.BackgroundTransparency = 0.05
	hint.TextColor3 = Color3.new(1, 1, 1)
	hint.TextWrapped = true
	hint.TextSize = 18
	hint.FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Bold)
	hint.ZIndex = 3
	hint.Parent = gui
	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, 10)
	pad.PaddingBottom = UDim.new(0, 10)
	pad.PaddingLeft = UDim.new(0, 14)
	pad.PaddingRight = UDim.new(0, 14)
	pad.Parent = hint
	local hintCorner = Instance.new("UICorner")
	hintCorner.CornerRadius = UDim.new(0, 10)
	hintCorner.Parent = hint
	local skip = Instance.new("TextButton")
	skip.Name = "Skip"
	skip.AnchorPoint = Vector2.new(1, 0)
	-- Clear of Roblox's top bar.
	skip.Position = UDim2.new(1, -16, 0, 64)
	skip.Size = UDim2.fromOffset(120, 44)
	skip.BackgroundColor3 = Color3.fromRGB(24, 26, 32)
	skip.BackgroundTransparency = 0.15
	skip.TextColor3 = Color3.new(1, 1, 1)
	skip.TextSize = 16
	skip.FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.SemiBold)
	skip.Text = self.options.skipText or "Skip tutorial"
	skip.ZIndex = 4
	skip.Parent = gui
	local skipCorner = Instance.new("UICorner")
	skipCorner.CornerRadius = UDim.new(0, 10)
	skipCorner.Parent = skip
	skip.Activated:Connect(function()
		self:skip()
	end)
	gui.Parent = player:WaitForChild("PlayerGui")
	if not reduceMotion() then
		local pulse = TweenService:Create(stroke, TweenInfo.new(0.7, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Thickness = 6, Transparency = 0.35 })
		pulse:Play()
	end
	return gui
end

-- The dim around a rectangle on the screen (in pixels, from the top left), the ring on it and the hint beside it.
local function frameAround(gui: ScreenGui, pos: Vector2?, size: Vector2?, text: string)
	local screen = gui.AbsoluteSize
	local top = gui:FindFirstChild("DimTop") :: Frame
	local bottom = gui:FindFirstChild("DimBottom") :: Frame
	local left = gui:FindFirstChild("DimLeft") :: Frame
	local right = gui:FindFirstChild("DimRight") :: Frame
	local ring = gui:FindFirstChild("Ring") :: Frame
	local hint = gui:FindFirstChild("Hint") :: TextLabel
	hint.Text = text
	if not pos or not size then
		-- No target: the whole screen lightly dimmed, the hint in its middle.
		top.Visible = true
		top.Position = UDim2.fromOffset(0, 0)
		top.Size = UDim2.fromScale(1, 1)
		bottom.Visible = false
		left.Visible = false
		right.Visible = false
		ring.Visible = false
		hint.AnchorPoint = Vector2.new(0.5, 0.5)
		hint.Position = UDim2.fromScale(0.5, 0.5)
		return
	end
	local margin = 8
	local x0 = math.max(0, pos.X - margin)
	local y0 = math.max(0, pos.Y - margin)
	local x1 = math.min(screen.X, pos.X + size.X + margin)
	local y1 = math.min(screen.Y, pos.Y + size.Y + margin)
	top.Visible = true
	top.Position = UDim2.fromOffset(0, 0)
	top.Size = UDim2.fromOffset(screen.X, y0)
	bottom.Visible = true
	bottom.Position = UDim2.fromOffset(0, y1)
	bottom.Size = UDim2.fromOffset(screen.X, screen.Y - y1)
	left.Visible = true
	left.Position = UDim2.fromOffset(0, y0)
	left.Size = UDim2.fromOffset(x0, y1 - y0)
	right.Visible = true
	right.Position = UDim2.fromOffset(x1, y0)
	right.Size = UDim2.fromOffset(screen.X - x1, y1 - y0)
	ring.Visible = true
	ring.Position = UDim2.fromOffset(x0, y0)
	ring.Size = UDim2.fromOffset(x1 - x0, y1 - y0)
	-- The hint below the target when there is room, else above it.
	local below = y1 + 12 + 80 < screen.Y
	hint.AnchorPoint = Vector2.new(0.5, if below then 0 else 1)
	local cx = math.clamp((x0 + x1) / 2, 170, math.max(170, screen.X - 170))
	hint.Position = UDim2.fromOffset(cx, if below then y1 + 12 else y0 - 12)
end

-- A place in the world: an outline on it and a marker over it that says what to do.
local function markWorld(self: Tour, target: Instance, text: string): () -> ()
	local highlight = Instance.new("Highlight")
	highlight.Name = "ShurikenGuideMark"
	highlight.FillColor = self.options.color or ACCENT
	highlight.FillTransparency = 0.75
	highlight.OutlineColor = self.options.color or ACCENT
	highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop
	highlight.Adornee = target
	highlight.Parent = target
	local adornee: BasePart? = if target:IsA("BasePart") then target elseif target:IsA("Model") then target.PrimaryPart or target:FindFirstChildWhichIsA("BasePart", true) else nil
	local board = Instance.new("BillboardGui")
	board.Name = "ShurikenGuideMarker"
	board.Size = UDim2.fromOffset(240, 70)
	board.StudsOffsetWorldSpace = Vector3.new(0, 5, 0)
	board.AlwaysOnTop = true
	if adornee then
		board.Adornee = adornee
	end
	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Text = "▼  " .. text
	label.TextColor3 = self.options.color or ACCENT
	label.TextStrokeTransparency = 0.3
	label.TextScaled = true
	label.FontFace = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Bold)
	label.Parent = board
	board.Parent = Players.LocalPlayer:WaitForChild("PlayerGui")
	return function()
		highlight:Destroy()
		board:Destroy()
	end
end

local function positionOf(target: Instance): Vector3?
	if target:IsA("BasePart") then
		return target.Position
	elseif target:IsA("Model") then
		return target:GetPivot().Position
	elseif target:IsA("Attachment") then
		return target.WorldPosition
	end
	return nil
end

-- One step: shown, then waited for (the press, the place, the player's own condition or the seconds).
local function runStep(self: Tour, step: Step)
	local gui = self.gui :: ScreenGui
	local done = false
	local function finish()
		if not done then
			done = true
			self.wake:Fire()
		end
	end
	local target = step.target
	local conns: { RBXScriptConnection } = {}
	local unmark: (() -> ())? = nil
	if target and target:IsA("GuiObject") then
		-- Every AbsolutePosition is in one space whatever its ScreenGui's insets (measured in Studio: this edge-to-edge
		-- overlay sits at (0, -58) in it under the top bar), so the target's place on the overlay is the difference.
		local function place()
			frameAround(gui, target.AbsolutePosition - gui.AbsolutePosition, target.AbsoluteSize, step.text)
		end
		place()
		-- It follows the target as it moves or the screen turns.
		table.insert(conns, RunService.RenderStepped:Connect(place))
		if target:IsA("GuiButton") then
			table.insert(conns, target.Activated:Connect(finish))
			if UserInputService.GamepadEnabled then
				GuiService.SelectedObject = target
			end
		end
	elseif target then
		-- In the world: no dim, so the player can move; the outline, the marker and the hint at the top.
		for _, n in { "DimTop", "DimBottom", "DimLeft", "DimRight", "Ring" } do
			(gui:FindFirstChild(n) :: Frame).Visible = false
		end
		local hint = gui:FindFirstChild("Hint") :: TextLabel
		hint.Text = step.text
		hint.AnchorPoint = Vector2.new(0.5, 0)
		hint.Position = UDim2.new(0.5, 0, 0, 120)
		unmark = markWorld(self, target, step.text)
		local reach = step.reach
		if reach then
			table.insert(conns, RunService.Heartbeat:Connect(function()
				local character = Players.LocalPlayer.Character
				local root = character and character:FindFirstChild("HumanoidRootPart") :: BasePart?
				local at = positionOf(target)
				if root and at and (root.Position - at).Magnitude <= reach then
					finish()
				end
			end))
		end
	else
		frameAround(gui, nil, nil, step.text)
		if not step.seconds and not step.waitFor then
			-- A message on its own: a click or a tap anywhere, the gamepad's A or Enter moves on.
			(gui:FindFirstChild("Hint") :: TextLabel).Text = step.text .. "\n\nTap to continue"
			local top = gui:FindFirstChild("DimTop") :: Frame
			table.insert(conns, top.InputBegan:Connect(function(input: InputObject)
				if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
					finish()
				end
			end))
			table.insert(conns, UserInputService.InputBegan:Connect(function(input: InputObject)
				if input.KeyCode == Enum.KeyCode.ButtonA or input.KeyCode == Enum.KeyCode.Return then
					finish()
				end
			end))
		end
	end
	local wait = step.waitFor
	if wait then
		task.spawn(wait, finish)
	end
	if step.seconds then
		task.delay(step.seconds, finish)
	end
	while not done and not self.skipped do
		self.wake.Event:Wait()
	end
	for _, c in conns do
		c:Disconnect()
	end
	if unmark then
		unmark()
	end
	if GuiService.SelectedObject == target then
		GuiService.SelectedObject = nil
	end
end

function Guide.run(self: Tour): boolean
	if self.running then
		return false
	end
	self.running = true
	self.skipped = false
	self.gui = build(self)
	for _, step in self.steps do
		if self.skipped then
			break
		end
		runStep(self, step)
	end
	local gui = self.gui
	if gui then
		gui:Destroy()
	end
	self.gui = nil
	self.running = false
	return not self.skipped
end

function Guide.skip(self: Tour)
	if self.skipped then
		return
	end
	self.skipped = true
	self.wake:Fire()
	local onSkip = self.options.onSkip
	if onSkip then
		task.spawn(onSkip)
	end
end

return Guide
```

## Designing the steps (what makes it feel hand-held, not lectured)
1. Write the first minute as the player plays it, then one step per action in that order: press Play,
   pick a mode, walk to the ring, attack (the key or the touch button), win, open the shop, equip.
   Six to ten steps; the tour ends inside the real loop.
2. Every step targets the REAL thing: the game's own Play button, its own touch attack button, its own
   arena. Never a copy of a button made for the tutorial, never a fake world.
3. Hints are an instruction of a few words in the player's language: "Press Play", "Walk into the
   ring", "Tap ⚔ to attack". The control in the hint matches the device: check `UserInputService.TouchEnabled`
   and `GamepadEnabled` and write "Tap", "Press A" or "Click".
4. Nothing to read that the step doesn't need. One message step at most at the start (what the game is in
   one line) and one at the end ("You're ready!", 2 to 3 s).
5. Steps the game drives itself (a countdown, a cutscene, a match being found) are `waitFor` steps on the
   game's own signal, so the tutorial never gets ahead of the game.
6. A phase change the game does itself (to the arena, back to the lobby) happens inside the tutorial too,
   exactly as in a real round: the tour keeps going on the other side (a world step to the next place).
7. In a matchmade game the tutorial's first match is against a bot in the same server (no queue).

## First time only, replayable, skippable
- Save `tutorialDone = true` in the player's data (skill roblox-data-persistence) when `run()` returns,
  whether it finished or was skipped; the server owns the save, so the client fires a remote for it.
- On join: run the tour only when the saved flag is false. Wait for the game's UI to be built first
  (the buttons it targets must exist and be visible).
- The Settings menu has "Replay tutorial", which runs the same tour again.
- Skip is always on screen, from the first step (it never dims). Never stop a player from skipping.

## Example (lint-clean, strict)
```lua
--!strict
-- src/Client/Tutorial.client.luau: the first-time tutorial of a mech arena game.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Guide = require(ReplicatedStorage.Shared.Guide)

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
local remotes = ReplicatedStorage:WaitForChild("Remotes")
local tutorialDone = remotes:WaitForChild("TutorialDone") :: RemoteEvent
local roundStarted = remotes:WaitForChild("RoundStarted") :: RemoteEvent
local roundEnded = remotes:WaitForChild("RoundEnded") :: RemoteEvent

local function verb(): string
	if UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled then
		return "Tap"
	elseif UserInputService.GamepadEnabled and not UserInputService.KeyboardEnabled then
		return "Press"
	end
	return "Click"
end

local function play()
	local lobby = playerGui:WaitForChild("Lobby") :: ScreenGui
	local hud = playerGui:WaitForChild("Hud") :: ScreenGui
	local tour = Guide.new({ color = Color3.fromRGB(255, 140, 60) })
	tour:step({ text = "Pilot a mech. Last one standing wins." })
	tour:step({ target = lobby:WaitForChild("Play"), text = verb() .. " Play" })
	tour:step({
		text = "Get ready…",
		waitFor = function(done)
			roundStarted.OnClientEvent:Once(done)
		end,
	})
	tour:step({ target = workspace:WaitForChild("Arena"):WaitForChild("Center"), text = "Walk to the centre", reach = 12 })
	tour:step({ target = hud:WaitForChild("Attack"), text = verb() .. " to fire" })
	tour:step({
		text = "Knock out the training bot",
		waitFor = function(done)
			roundEnded.OnClientEvent:Once(done)
		end,
	})
	tour:step({ text = "You're ready!", seconds = 2.5 })
	tour:run()
	tutorialDone:FireServer()
end

-- The server sets this attribute from the save before the player spawns; Settings' "Replay tutorial" fires
-- the bindable.
if player:GetAttribute("TutorialDone") ~= true then
	task.spawn(play)
end
local replay = ReplicatedStorage:WaitForChild("ReplayTutorial") :: BindableEvent
replay.Event:Connect(play)
```

## Verification (Studio)
- luau_check clean (strict).
- In a playtest with the flag cleared, step through on the keyboard layout and on a phone layout
  (ui_audit's devices): the ring sits on each target with an 8 px margin (compare the overlay's `Ring`
  AbsolutePosition with the target's: every AbsolutePosition is in one space, whatever its ScreenGui's
  insets), the hint is readable and inside the screen, the Skip button is clear of Roblox's buttons.
- Clicks outside the spotlight do nothing; Skip ends the tour and the flag is saved; a second join does
  not show it again; Replay runs it again.
- A screenshot of the first step for the task's evidence.
- Measured in real Studio (tests/e2e/guide.e2e.ts): the spotlight on a button under the top bar, the
  dim's edges, advancing, the overlay gone after the last step, and Skip.
