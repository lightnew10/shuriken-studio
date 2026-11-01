---
name: roblox-ui-design
description: "Design and build Roblox game UI that looks made by a studio and works on every device: menus, shops, inventories, dialogs, settings, tabs and lists. How a UI designer works (direction, tokens, hierarchy, a layout per form factor, interaction, motion, checking against the device matrix), devices and platforms (landscape and upright phones, tablets, desktop, console/TV 10-foot UI, breakpoints, PreferredInput hints, Studio's Device emulator vs ui_audit), screen setup (ScreenInsets, DisplayOrder, ZIndexBehavior), modern layout (UIListLayout flex, UIFlexItem, UIGridLayout, UIPageLayout, AutomaticSize, scrolling lists), typography (FontFace weights, BuilderSans), styling (UICorner, UIStroke positions, UIGradient, shadows, CanvasGroup fades), states and motion, gamepad/keyboard/touch input, and a lint-clean component kit (screen, window, button, tabs, grid, strip, shop card, confirm dialog, counter, device forms, key hints, and what a mockup's pieces build: gradients, layered strokes, glows, badges, panel shapes, states) on the Motion module that honours Reduce Motion, Background Transparency, PreferredInput and the 10-foot interface; building a mockup, with a worked example. APIs checked in Studio 0.740."
version: 3
tags: [ui, gui, menu, shop, store, inventory, dialog, modal, popup, settings, tabs, layout, flex, grid, scrolling, list, gamepad, controller, mobile, phone, tablet, console, tv, portrait, device, touch, typography, font, style, theme, animation, tween, design process]
roblox_systems: [ScreenGui, Frame, TextButton, TextLabel, ImageLabel, ScrollingFrame, UIListLayout, UIFlexItem, UIGridLayout, UIPageLayout, UIPadding, UICorner, UIStroke, UIGradient, UIScale, UIShadow, CanvasGroup, TweenService, GuiService, ContextActionService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [ui_audit, roblox_screenshot, roblox_playtest, roblox_sync_push, luau_check]
---
# Roblox UI that looks designed

## Purpose
Players judge a game in seconds by its UI. Studio defaults (grey boxes, Arial, pixel offsets, UI under
the top bar) read as amateur, and UI that only fits the developer's monitor breaks for the half of
players on phones. This skill is how to plan, lay out, style and animate menus, shops, inventories and
dialogs so they look intentional and work on a phone either way up, a tablet, a desktop and a TV, with a
kit to build from. For in-game HUDs (health, cooldowns, feeds) use skill "roblox-game-hud" alongside; for
the look (tokens, palettes, genre layouts, the motion table, the rubric, the polish checklist) skill
"roblox-ui-references"; for animation skill "roblox-ui-motion" (the Motion module the kits play through);
for loading, title, reward and round-end screens and interaction patterns, skill "roblox-ui-showpieces".

## How a UI designer works (every screen, a mockup or the real one)
The same loop whether the screen is a mockup or the game's own UI: both are a ScreenGui tree built in code,
read back and checked the same way.
1. **Direction.** From the game's genre, art style and mood, write four lines before building: the palette
   (roblox-ui-references, section 3), the display face, the radius family, the motion personality (snappy
   and bouncy for a simulator, tight and fast for a shooter, slow fades for horror). The UI belongs to the
   game's world, not to a default theme.
2. **Tokens first.** Apply the palette to `Ui.theme`, use the spacing and type scales; no one-off colours,
   sizes or radii.
3. **Content and hierarchy.** What the screen shows, what the player does there, in order of importance: one
   primary action, at most three levels of emphasis, and the empty, loading, error and success states.
4. **A layout per form** (Devices and platforms, below): zones for a landscape phone first (945x415 design
   px), then desktop, tablet, TV, and an upright phone if the game allows portrait. Each is its own
   arrangement (`Ui.onDevice`), not the desktop one scaled down.
5. **Interaction.** Every control: hover (mouse only), press, focus (gamepad), disabled. The whole screen
   works with a gamepad alone and with a thumb alone; anything that needs precision (drag, hover) has a
   tap or button alternative; key hints follow the input (`Ui.hint`).
6. **Motion last** (skill roblox-ui-motion): order, timing, one ambient loop, Reduce Motion.
7. **Check against the device matrix.** `ui_audit` lays the UI out on every form (phone, upright phone when
   the game allows it, tablet, desktop, TV) and lists what doesn't fit or read: fix every problem.
   `roblox_screenshot` in a playtest shows the look at the size of Studio's window (an agent can't resize
   it): critique it against the rubric (roblox-ui-references, section 2), score each row honestly, fix the
   lowest first. Studio's **Device emulator** (Test tab, Device) is how a person previews a screen as a
   given phone, tablet or console: it sets the viewport to that device's resolution and orientation and
   emulates touch (clicks act as touches, the thumbstick and jump button appear). Agents can't switch it
   on; their per-device check is ui_audit (sizes, positions, text and tap sizes per form) and their look
   check is the screenshot. For screens that matter, ask the user to try them in the emulator or on a real
   phone (thumb reach, touch feel).
8. **Iterate** until the rubric reads 20+ of 24 with no 0 in rows 1-4, then the polish checklist. Try
   20-character names, 12-digit numbers, empty lists, 60 items, and Reduce Motion on.

## Devices and platforms
| Form (`Ui.device`) | Ui canvas (design px) | Layout | Input to expect |
|---|---|---|---|
| phone, landscape | 834x396 on an iPhone SE (the smallest: design here first), 945x415 on a notch phone | one column or a sideways strip (`Ui.strip`); windows fill the screen; <= 4 nav buttons; details in a bottom sheet | touch: 54-px targets (44 pt), 8 apart; clear of thumbstick and jump |
| phone, upright (only if `ScreenOrientation` allows it) | 487x881 | one column; navigation and actions in the bottom half (thumb reach); grids of 2 | touch |
| tablet | 1475x952 | two panes (a list and a side panel), desktop-like | mostly touch: phone-size targets, no hover |
| desktop | 1707x887 (laptop) to 2029x1080 | several panes, hover states, shortcuts shown | mouse and keyboard |
| tv (console, 10-foot) | 1623x864 (the kit fits it 25% bigger) | fewer, bigger things: body >= 24, grids <= 5 columns, text and buttons inside the middle 90% | gamepad: focus on open, the D-pad reaches everything, glyph hints |
- **Form is not input.** Layout follows `Ui.device(screen).form` (from the space the screen has: phone when
  its shorter side is under 500 points, tablet under 1300 on the longer side, desktop above, tv on a
  10-foot interface); hints, hover and focus follow `.input` (PreferredInput: "touch", "gamepad", "mouse").
  A tablet may have a keyboard, a laptop a touch screen, a PC a gamepad: `TouchEnabled` is not "a phone".
- `Ui.onDevice(screen, build)` calls build now and again when the form, the orientation or the input
  changes; build clears the screen's content and lays out that form (the example after the kit).
- **Orientation**: `StarterGui.ScreenOrientation` LandscapeSensor (the default) keeps phones sideways;
  Portrait or Sensor lets them stand up, and then every screen needs its upright layout (ui_audit adds it).
- **Safe areas**: CoreUISafeInsets for anything interactive (clear of the top bar and the notch: 44 pt sides
  on a landscape phone, a 47-pt status bar and 34-pt home bar upright), DeviceSafeInsets for HUD pieces,
  None for backgrounds and fades. Full-screen menus can hide the touch controls while they show
  (`GuiService.TouchControlsEnabled = false`, back on when they close).
- **Phones first.** Most players are on a phone, and blind judges marked designs down on phones more than
  anywhere else. Design the landscape phone first, on the iPhone SE (834x396 design px under the top bar, at the
  kit's 0.8 scale), then widen it. What judges named, and what to do instead (design px under kit "ui"):
  - *Text that reads tiny*: names, prices, levels and button words 20+ (16 pt), every other word 18+ (14 pt);
    secondary lines in a colour that still reads, not faint grey on a dark panel.
  - *The phone drops what things are*: tiles keep their item names, swatches their caption, buttons their word
    (shorter or smaller, never gone). Leave out a whole part if it must go (a stats panel), not its labels.
  - *A list that looks empty*: 3+ whole rows on the SE (rows of 54-70, two columns, or more of the screen for
    the list), in a ScrollingFrame no bigger than its panel. Never AutomaticSize on a ScrollingFrame: it grows
    instead of scrolling and its rows draw below the window.
  - *Crowding and edges*: 8+ between tappable things; frames 8+ pt inside the safe area (the home indicator, the
    notch); a title with room above it in its card; no badge over a word.
  - The templates' phone forms follow all of this: start from one when it fits. `ui_lab_check` draws the SE
    and notch phone big first, `ui_lab_view {inHand: true}` shows a phone as sharp as the player sees it, and
    `ui_lab_review` has a reviewer look at the phones like a player.
- **TV**: the 10-foot interface (`GuiService:IsTenFootInterface()`) is read from across a room: the kits fit
  it bigger, everything is reachable with the D-pad (`SelectionGroup`, `NextSelection*` where the grid
  order misleads), B always backs out, nothing is hover- or pointer-only. VR: roblox-ui-references, section 9.

## Screen setup (checked in Studio)
`Instance.new("ScreenGui")` starts with ScreenInsets = CoreUISafeInsets, ZIndexBehavior = Global,
ResetOnSpawn = true. For game UI set:
- `ResetOnSpawn = false` (menus and HUDs outlive the character),
- `ZIndexBehavior = Enum.ZIndexBehavior.Sibling` (children draw above parents; ZIndex only orders siblings),
- `DisplayOrder` by layer: HUD 0, menus 10, dialogs 20, toasts 30, fades/transitions 100,
- `ScreenInsets`: **CoreUISafeInsets** (default) keeps content clear of Roblox's top-bar buttons and the
  notch — use it for everything interactive; **TopbarSafeInsets** is the top-bar strip itself (small
  buttons beside Roblox's); **DeviceSafeInsets** only avoids notches (content may sit beside the top bar);
  **None** covers the whole screen, for backgrounds, vignettes and fades only.
Build UI from a LocalScript under StarterPlayerScripts into `Players.LocalPlayer.PlayerGui`, not by
hand in StarterGui (code is reviewable, rebuildable and data-driven).

## Layout: sizes that survive every screen
- **Reference size + UIScale**: design at 1920×1080 in offsets and put one UIScale on the ScreenGui
  set to `clamp(min(area.X / 1920, area.Y / 1080), 0.8, 1.5)` of the ScreenGui's AbsoluteSize, updated
  when it changes. Measured in Studio: a ScreenGui's UIScale multiplies every offset below it (scale
  sizes still take fractions of the real screen), and UISizeConstraint limits count in design units
  (before the UIScale). The 0.8 floor keeps phones usable (20-pt body text reads at 16, a 56-pt button
  is 45 points to a thumb); pure proportional scaling would make a phone 0.3 and everything unreadable.
  Give that UIScale `FitReference` (Vector2, the reference size) and `FitRange` (NumberRange, the clamp)
  attributes: ui_audit then redoes the fit for each device instead of reusing Studio's window size.
  The kit's `Ui.screen` does all of this.
- **Windows fit every screen**: `Size = UDim2.fromScale(0.96, 0.96)` with a `UISizeConstraint` whose
  MaxSize is the design size (980×680): full size on a desktop, the whole screen on a phone. Centre with
  `AnchorPoint = (0.5, 0.5)`, `Position = UDim2.fromScale(0.5, 0.5)`. Content inside scrolls rather
  than assuming the design height. Offsets-only windows bigger than 1000×300 design points hang off
  phones.
- **UIListLayout** is the workhorse: FillDirection, Padding, alignment, and flex (checked):
  `HorizontalFlex` / `VerticalFlex` = None | Fill | SpaceBetween | SpaceAround | SpaceEvenly;
  `Wraps = true` flows children onto new lines; `ItemLineAlignment` = Automatic | Start | Center | End |
  Stretch. A **UIFlexItem** child of an item controls it: `FlexMode` = None | Grow | Shrink | Fill |
  Custom (GrowRatio / ShrinkRatio). Header pattern: `[title: UIFlexItem Grow] [close button]`.
- **UIGridLayout** for item grids (CellSize, CellPadding, FillDirectionMaxCells) inside a
  **ScrollingFrame** with `AutomaticCanvasSize = Y`, `CanvasSize = UDim2.new()`, a thin
  `ScrollBarThickness` (4–6) and `ScrollingDirection = Y`.
- **AutomaticSize** (X, Y or XY) for anything sized by its text: buttons that fit their label, tooltips,
  chat bubbles — with a UIPadding so text never touches the edge.
- **UIPageLayout** for tabs and carousels (`Animated`, `TweenTime`, `EasingStyle`, `:JumpTo(page)`).
- Give every child of a layout an explicit `LayoutOrder` (SortOrder = LayoutOrder): with equal orders
  Roblox doesn't promise creation order (a window's close button was measured landing left of its title).
- Nothing important within ~60 px of the bottom-right on touch devices (jump button) or the
  bottom-left (thumbstick); Roblox's leaderboard and menus live top-right and top-left.

## Typography
- `FontFace` with real weights: `Font.fromEnum(Enum.Font.BuilderSans)` (Roblox's own UI face; also
  BuilderSansMedium, BuilderSansBold, BuilderSansExtraBold) or
  `Font.new("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Bold)`. Weights:
  Thin … Regular, Medium, SemiBold, Bold, ExtraBold, Heavy.
- One body face (BuilderSans or Gotham) plus at most one display face for titles that fits the game:
  FredokaOne or LuckiestGuy (cartoony, simulators, obbies), Bangers (comic, action), Oswald (condensed
  headings, shooters), RobotoMono (timers and stats that shouldn't jitter).
- Sizes at 1080p reference: titles 34–44, section heads 24–28, body 18–20, captions 14–16. Fixed
  TextSize + UIScale beats TextScaled; when TextScaled is unavoidable, add a UITextSizeConstraint
  (MaxTextSize) so short labels don't balloon, and never TextScaled on paragraphs.
- `RichText = true` for emphasis and inline colour (`<b>`, `<font color="#ffb020">`); `TextTruncate =
  AtEnd` for names; `TextWrapped` for descriptions; `LineHeight` 1.1–1.2 for paragraphs.
- Text over the 3D world gets a UIStroke (ApplyStrokeMode Contextual, 2–3 px, dark, 0.2–0.4 transparency).

## Styling
- A **theme**: background, surface, raised surface, stroke, text, subtext, one accent (+ its text colour),
  danger, success. Every element takes its colours from it (the kit's `Ui.theme`). Accent for the one
  primary action per view; everything else neutral.
- **UICorner** 8–16 px on panels and buttons (pill buttons: 0.5 scale). Keep radii consistent. Per-corner radii
  exist (`TopLeftRadius` … `BottomRightRadius`): tabs fused to a panel round only their top corners.
- **UIStroke** on panels: ApplyStrokeMode Border, `BorderStrokePosition = Inner` (crisp edge that
  doesn't grow the element; Outer/Center also exist), 1–2 px, 0.4–0.7 transparency.
- **UIGradient** for depth: a vertical gradient (Rotation 90) from slightly lighter to the base colour on
  buttons and headers; a transparency gradient for fades at list edges.
- **Shadows**: use `UIShadow` (full release June 2026: Color, Transparency, Offset, BlurRadius, Spread; native,
  no layout cost; keep about 100 or fewer on screen). The kit's `Ui.shadow(panel, level)` adds one (level 1
  chips, 2 cards, 3 windows; `Ui.window` already has level 3) and returns nil where UIShadow doesn't exist
  (older Studio): then use the fallback, a slightly larger, darker Frame behind the panel (Transparency
  0.6–0.8, same corner radius). A ScrollingFrame clips a shadow at its edge.
- **CanvasGroup** fades a whole window with `GroupTransparency`, but renders to a texture (costly;
  text can soften when scaled): use it for short open/close fades, not for everything.
- Icons: pictures of the game's own things, made with `ui_icon {icons: [{name, model}]}` (the model drawn
  alone, transparent, outlined, 512 px; uploaded; listed in the generated `UiIcons` module:
  `local Icons = require(<Shared>.UiIcons)`, `image.Image = Icons.Coin`). Every currency, item, category
  and rail button gets one; a missing model (a coin, a gem, a chest) is a quick Kiln build to ask the
  modeler for. An icon that is still "" shows its name until its upload is known. Never text alone, an
  emoji or `rbxassetid://0` where an icon belongs. `ImageLabel.ScaleType = Fit`; monochrome glyph sets
  (settings, close, arrows) may be Creator Store decals tinted with ImageColor3.

## States and motion
- Every button: idle, hover (mouse players only: a tap fires MouseEnter without MouseLeave), pressed (a
  spring on its UIScale to 0.95 and back with a small overshoot), focused (gamepad selection: the hover
  colour and an accent ring, `SelectionImageObject`), disabled (`Interactable = false`, lower contrast),
  and `Activated` for the action (fires for mouse, touch and gamepad). `Ui.button` does all of it.
- Motion is fast: open 0.15–0.2 s (UIScale 0.92→1 with Back Out, fade in), close 0.1–0.12 s (Quad In),
  hovers 0.08–0.12 s; stagger list items 20–30 ms. Tween UIScale, Position (with AnchorPoint set) and
  transparency — never Size of TextScaled labels (it jitters).
- Counters count up to their new value (`Motion.count`; separators, or 1.2K/3.4M); gains punch the icon
  and flash green, spends red. All animation goes through Motion (skill roblox-ui-motion): entrances,
  springs, loops in a scope that stops when the screen closes, transitions, flights to a counter.
- A click sound on every button (skill "roblox-audio": Audio.play("Click")), a softer one for tabs.
- Player settings: **Reduce Motion** (`GuiService.ReducedMotionEnabled`) and **Background Transparency**
  (`GuiService.PreferredTransparency`). The kit follows both (Reduce Motion through Motion, which also takes
  the game's own switch: `Motion.setReduced`): tweens land at once, windows open and close at once, the
  backdrop's dim goes through `Ui.alpha`. Play your own tweens with `Ui.play` or Motion and give
  translucent backgrounds `Ui.alpha(base)`; text size is the player's too, so let containers grow
  (AutomaticSize, TextWrapped) instead of fixing their height.

## Input: mouse, touch, gamepad, keyboard
- When a menu opens for a gamepad player (`Ui.onGamepad()`: `UserInputService.PreferredInput` is Gamepad or
  MicroGamepad, which stays steady where `GetLastInputType()` flips with every stray mouse move; older
  Studios fall back to the last input type), set
  `GuiService.SelectedObject` to its first button so they can act at once, and clear it on close. Don't
  select for mouse or touch players: it draws a selection box around a button they never navigate to
  (and setting it the moment a playtest starts crashed Studio 0.741 twice in testing). Mark item
  containers `SelectionGroup = true`; buttons are Selectable.
- Close windows with Escape and gamepad B through ContextActionService (bind on open, unbind on close).
- Touch targets at least 44 points on a phone: at the kit's 0.8 phone scale that is 56 design px for
  buttons, 52 for tabs; 8+ px apart; nothing important only on hover.
- Number keys or bumpers switch tabs; Enter/A confirms the focused dialog button.

## Data and trust
- UI shows state and asks; the server decides. Purchases: the client sends "buy <item id>" to a
  RemoteFunction/RemoteEvent; the server checks price, currency and ownership, then answers; the UI
  updates from the server's answer or attributes, never from its own arithmetic.
- Robux: `MarketplaceService:PromptProductPurchase / PromptGamePassPurchase` from the client is fine; the
  grant happens in the server's `ProcessReceipt` (developer products) or ownership checks (passes).
- Prices, names and icons come from one config module shared by server and client.

## The kit
A ModuleScript in the game's shared code, used from the client: `src/Shared/Ui.luau` in a new
project (`ReplicatedStorage.Shared.Ui`); in a plugged-in game, beside its other shared modules in
ReplicatedStorage (the study and project_overview show its folders) — require it from there. It needs **Motion**
(skill roblox-ui-motion, `src/Shared/Motion.luau`) in the same folder: put that in first. Lint-clean under strict
luau-lsp and selene. A game that already holds an older copy (no "Kit v4" line in its header, no `Ui.react`) should
replace it with this one (and add Motion): the older functions work the same. New in v4: what a mockup's pieces build
(section "Building a mockup"): `Ui.gradient`, `Ui.stroke` (layered, Inner/Center/Outer, round the letters), `Ui.glow`,
`Ui.badge`, `Ui.shape` (panel shapes from ui_icon {shapes}) and `Ui.react` (hover, press, selected and disabled
states). In v3: `Ui.input`, `Ui.device`, `Ui.onDevice` (a layout per form factor), `Ui.hint` (key hints that follow the
input), `Ui.strip` (a sideways row for phones), `window.opened` and `window.motion`, spring press feedback and an accent
focus ring for gamepads.
```lua
--!strict
-- Ui: menus, shops and dialogs in code (skill roblox-ui-design). Colours and fonts come from Ui.theme.
-- Kit v4: needs Motion (skill roblox-ui-motion) in the same folder: tweens, springs and Reduce Motion come
-- from there (Ui.play, Ui.reducedMotion, Ui.count). Device forms and input (Ui.device, Ui.onDevice,
-- Ui.input, Ui.hint): build a layout per form (phone, tablet, desktop, tv), not one layout scaled. Follows
-- PreferredInput, Background Transparency (Ui.alpha) and the 10-foot interface (a bigger fit on a TV);
-- Ui.shadow adds a UIShadow; windows have a motion scope that stops when they close. A mockup's pieces: Ui.gradient,
-- Ui.stroke, Ui.glow, Ui.badge, Ui.shape and Ui.react (states).
local ContextActionService = game:GetService("ContextActionService")
local GuiService = game:GetService("GuiService")
local UserInputService = game:GetService("UserInputService")

local Motion = require(script.Parent.Motion)

local Ui = {}

export type Theme = {
	bg: Color3,
	surface: Color3,
	raised: Color3,
	stroke: Color3,
	text: Color3,
	subtext: Color3,
	accent: Color3,
	accentText: Color3,
	danger: Color3,
	success: Color3,
	font: Font,
	bold: Font,
	radius: number,
}

Ui.theme = {
	bg = Color3.fromRGB(12, 14, 20),
	surface = Color3.fromRGB(24, 27, 36),
	raised = Color3.fromRGB(36, 40, 52),
	stroke = Color3.fromRGB(88, 96, 120),
	text = Color3.fromRGB(242, 244, 250),
	subtext = Color3.fromRGB(160, 168, 188),
	accent = Color3.fromRGB(255, 176, 32),
	accentText = Color3.fromRGB(34, 22, 0),
	danger = Color3.fromRGB(236, 84, 84),
	success = Color3.fromRGB(92, 204, 124),
	font = Font.fromEnum(Enum.Font.BuilderSans),
	bold = Font.fromEnum(Enum.Font.BuilderSansBold),
	radius = 12,
} :: Theme

export type Input = "touch" | "gamepad" | "mouse"

--- The player's input right now: "touch", "gamepad" (Gamepad, or MicroGamepad: a TV remote) or "mouse"
--- (keyboard and mouse). PreferredInput stays steady where the last raw input flips with every stray mouse
--- move; Studios without it fall back to the last input type.
function Ui.input(): Input
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

--- Whether the player is on a gamepad right now (menus then select a button for them).
function Ui.onGamepad(): boolean
	return Ui.input() == "gamepad"
end

--- Whether motion is reduced (the player's Reduce Motion setting, or the game's toggle: Motion.setReduced).
function Ui.reducedMotion(): boolean
	return Motion.reduced()
end

--- A BackgroundTransparency adjusted by the player's Background Transparency setting (1 = as designed,
--- lower = more opaque): use it for translucent panels. Returns `base` where the setting doesn't exist.
function Ui.alpha(base: number): number
	local ok, preferred = pcall(function()
		return GuiService.PreferredTransparency
	end)
	return if ok then math.clamp(base * preferred, 0, 1) else base
end

local QUICK = TweenInfo.new(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local OPEN = TweenInfo.new(0.18, Enum.EasingStyle.Back, Enum.EasingDirection.Out)
local CLOSE = TweenInfo.new(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.In)

--- Plays a tween and returns it (Motion.tween): with Reduce Motion it lands at once.
function Ui.play(target: Instance, info: TweenInfo, goal: { [string]: any }): Tween
	return Motion.tween(target, info, goal)
end

local ELEVATION = { { 4, 8, 0.7 }, { 6, 16, 0.6 }, { 12, 32, 0.5 } } -- offset, blur, transparency

--- A native drop shadow (UIShadow) under a panel: level 1 chips, 2 cards, 3 windows (keep about 100 or
--- fewer on screen). Returns nil where UIShadow doesn't exist (older Studio): the stroke carries the edge.
function Ui.shadow(target: GuiObject, level: number?): UIShadow?
	local e = ELEVATION[math.clamp(level or 2, 1, 3)]
	local ok, shadow = pcall(function()
		local s = Instance.new("UIShadow")
		s.Color = Color3.new(0, 0, 0)
		s.Offset = UDim2.fromOffset(0, e[1])
		s.BlurRadius = UDim.new(0, e[2])
		s.Transparency = e[3]
		s.Parent = target
		return s
	end)
	return if ok then shadow else nil
end

local function corner(parent: GuiObject, radius: number?)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius or Ui.theme.radius)
	c.Parent = parent
end

local function outline(parent: GuiObject, color: Color3, thickness: number, transparency: number)
	local s = Instance.new("UIStroke")
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.BorderStrokePosition = Enum.BorderStrokePosition.Inner
	s.Color = color
	s.Thickness = thickness
	s.Transparency = transparency
	s.Parent = parent
end

local function pad(parent: GuiObject, x: number, y: number)
	local p = Instance.new("UIPadding")
	p.PaddingLeft = UDim.new(0, x)
	p.PaddingRight = UDim.new(0, x)
	p.PaddingTop = UDim.new(0, y)
	p.PaddingBottom = UDim.new(0, y)
	p.Parent = parent
end

local function label(parent: Instance, text: string, size: number, bold: boolean?): TextLabel
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.FontFace = if bold then Ui.theme.bold else Ui.theme.font
	t.Text = text
	t.TextSize = size
	t.TextColor3 = Ui.theme.text
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.AutomaticSize = Enum.AutomaticSize.XY
	t.Parent = parent
	return t
end

-- What a mockup's pieces build (section "Building a mockup"): gradients, strokes, glows, badges, panel shapes and
-- states, so a screen built from a mockup matches its pictures.

export type GradientSpec = {
	color: ColorSequence?, -- multiplies the element's colours: ColorSequence.new(top, bottom), or keys from 0 to 1
	transparency: NumberSequence?, -- fades: NumberSequence.new(0, 1) fades out along the gradient
	rotation: number?,
	kind: string?, -- "Linear" (default), "Radial" or "Conical"
}

--- A UIGradient: its colours multiply what the element draws, its transparency fades it (a strip that fades to the
--- right: transparency = NumberSequence.new(0, 1)). Keys run from time 0 to 1, at most 20.
function Ui.gradient(target: Instance, spec: GradientSpec): UIGradient
	local g = Instance.new("UIGradient")
	if spec.color then
		g.Color = spec.color
	end
	if spec.transparency then
		g.Transparency = spec.transparency
	end
	g.Rotation = spec.rotation or 0
	local kind = spec.kind
	if kind and kind ~= "Linear" then
		pcall(function()
			(g :: any).Type = kind
		end)
	end
	g.Parent = target
	return g
end

export type StrokeSpec = {
	color: Color3,
	thickness: number?,
	transparency: number?,
	position: string?, -- "Outer" (default), "Inner" or "Center"
	text: boolean?, -- round the letters (a text outline) instead of the box
	z: number?, -- several stack by ZIndex: a wide faint stroke under a thin bright one is a glowing edge
	gradient: GradientSpec?,
}

--- A UIStroke round the box (Outer unless position says Inner or Center) or round the letters (text = true).
function Ui.stroke(target: GuiObject, spec: StrokeSpec): UIStroke
	local s = Instance.new("UIStroke")
	s.ApplyStrokeMode = if spec.text then Enum.ApplyStrokeMode.Contextual else Enum.ApplyStrokeMode.Border
	s.BorderStrokePosition = if spec.position == "Inner"
		then Enum.BorderStrokePosition.Inner
		elseif spec.position == "Center" then Enum.BorderStrokePosition.Center
		else Enum.BorderStrokePosition.Outer
	s.Color = spec.color
	s.Thickness = spec.thickness or 1
	s.Transparency = spec.transparency or 0
	local z = spec.z
	if z then
		pcall(function()
			(s :: any).ZIndex = z
		end)
	end
	local gradient = spec.gradient
	if gradient then
		Ui.gradient(s, gradient)
	end
	s.Parent = target
	return s
end

--- A glow round a box: a UIShadow with no offset in a bright colour (it follows UICorner; never text or a
--- shape). Returns nil where UIShadow doesn't exist.
function Ui.glow(target: GuiObject, color: Color3, blur: number?, transparency: number?, spread: number?): UIShadow?
	local ok, glow = pcall(function()
		local s = Instance.new("UIShadow")
		s.Color = color
		s.Offset = UDim2.new()
		s.BlurRadius = UDim.new(0, blur or 12)
		s.Transparency = transparency or 0.4
		s.Spread = UDim2.fromOffset(spread or 0, spread or 0)
		s.Parent = target
		return s
	end)
	return if ok then glow else nil
end

export type BadgeOptions = {
	style: string?, -- "pill" (default: a count or a word), "dot", or "ribbon" (a tag across the top edge or a corner)
	color: Color3?,
	textColor: Color3?,
	at: string?, -- "tr" (default), "tl", "br", "bl", or "top" (a ribbon's default)
	size: number?,
}

local BADGE_RED = Color3.fromRGB(229, 57, 53)

--- A notification badge over a corner of `parent`, named "Badge" (what a mockup's badge builds): set its Text to
--- change the count, Visible to hide it.
function Ui.badge(parent: GuiObject, text: string?, opts: BadgeOptions?): GuiObject
	local o: BadgeOptions = opts or {}
	local style = o.style or "pill"
	local s = o.size or (if style == "dot" then 12 else 22)
	local at = o.at or (if style == "ribbon" then "top" else "tr")
	local inset = math.round(s * 0.2)
	local pos = if at == "tl"
		then UDim2.fromOffset(inset, inset)
		elseif at == "br" then UDim2.new(1, -inset, 1, -inset)
		elseif at == "bl" then UDim2.new(0, inset, 1, -inset)
		elseif at == "top" then UDim2.fromScale(0.5, 0)
		else UDim2.new(1, -inset, 0, inset)
	local function round(target: GuiObject, radius: UDim)
		local c = Instance.new("UICorner")
		c.CornerRadius = radius
		c.Parent = target
	end
	if style == "dot" then
		local dot = Instance.new("Frame")
		dot.Name = "Badge"
		dot.AnchorPoint = Vector2.new(0.5, 0.5)
		dot.Position = pos
		dot.Size = UDim2.fromOffset(s, s)
		dot.BackgroundColor3 = o.color or BADGE_RED
		dot.ZIndex = 10
		round(dot, UDim.new(0.5, 0))
		Ui.stroke(dot, { color = Color3.new(1, 1, 1), thickness = 2 })
		dot.Parent = parent
		return dot
	end
	local b = Instance.new("TextLabel")
	b.Name = "Badge"
	b.AnchorPoint = Vector2.new(0.5, 0.5)
	b.Position = pos
	b.Size = UDim2.fromOffset(s, s)
	b.AutomaticSize = Enum.AutomaticSize.X
	b.BackgroundColor3 = o.color or BADGE_RED
	b.ZIndex = 10
	b.Text = text or ""
	b.TextColor3 = o.textColor or Color3.new(1, 1, 1)
	b.TextSize = math.round(s * 0.62)
	b.FontFace = Font.fromEnum(Enum.Font.BuilderSansExtraBold)
	local side = math.round(s * (if style == "ribbon" then 0.45 else 0.3))
	local p = Instance.new("UIPadding")
	p.PaddingLeft = UDim.new(0, side)
	p.PaddingRight = UDim.new(0, side)
	p.Parent = b
	if style == "ribbon" then
		b.Rotation = if at == "tr" or at == "br" then 30 elseif at == "tl" or at == "bl" then -30 else -4
		round(b, UDim.new(0, 3))
		Ui.stroke(b, { color = Color3.new(0, 0, 0), thickness = 2, transparency = 0.35, z = 0 })
		Ui.stroke(b, { color = Color3.new(0, 0, 0), thickness = 1.5, transparency = 0.3, text = true, z = 1 })
	else
		round(b, UDim.new(0.5, 0))
		Ui.stroke(b, { color = Color3.new(1, 1, 1), thickness = 2 })
	end
	b.Parent = parent
	return b
end

export type Shape = { fill: string, lines: { string }, slice: Rect, sliceScale: number, pad: number, size: Vector2 }
export type ShapeLine = { color: Color3, transparency: number? }

--- A panel shape made with ui_icon {shapes} (require <Shared>.UiShapes: Shapes.<Name>): its 9-sliced images under
--- `target`, the fill tinted with the target's BackgroundColor3 and BackgroundTransparency (its UIGradient moves
--- onto the fill) and each outline in its colour (`lines`, in the order of the mockup's strokes). The images draw
--- the background from then on. A shape whose images aren't uploaded yet ("") leaves a plain box. Returns the fill.
function Ui.shape(target: GuiObject, shape: Shape, lines: { ShapeLine }?): ImageLabel?
	if shape.fill == "" then
		return nil
	end
	local function image(name: string, id: string): ImageLabel
		local img = Instance.new("ImageLabel")
		img.Name = name
		img.BackgroundTransparency = 1
		img.Image = id
		img.ScaleType = Enum.ScaleType.Slice
		img.SliceCenter = shape.slice
		img.SliceScale = shape.sliceScale
		img.Position = UDim2.fromOffset(-shape.pad, -shape.pad)
		img.Size = UDim2.new(1, shape.pad * 2, 1, shape.pad * 2)
		img.ZIndex = 0 -- under the target's other children
		img.Parent = target
		return img
	end
	local fill = image("ShapeFill", shape.fill)
	fill.ImageColor3 = target.BackgroundColor3
	fill.ImageTransparency = target.BackgroundTransparency
	local gradient = target:FindFirstChildOfClass("UIGradient")
	if gradient then
		gradient.Parent = fill
	end
	target.BackgroundTransparency = 1
	local colors = lines or {}
	for i, id in shape.lines do
		local line = image("ShapeLine" .. i, id)
		local l = colors[i]
		line.ImageColor3 = if l then l.color else Color3.new(1, 1, 1)
		line.ImageTransparency = if l and l.transparency then l.transparency else 0
	end
	return fill
end

export type StatePatch = { [string]: any } -- properties that change (BackgroundColor3, TextColor3, ImageColor3, Rotation…) and Scale
export type States = { hover: StatePatch?, press: StatePatch?, selected: StatePatch?, disabled: StatePatch? }
export type Reaction = { setSelected: (on: boolean) -> (), setDisabled: (on: boolean) -> (), disconnect: () -> () }

--- Makes an element answer the player as its mockup's states say: hover (mouse only, and gamepad focus), press (a
--- spring on its UIScale), selected (setSelected: the current tab) and disabled (setDisabled: Interactable off).
--- Each state is the properties that change, Scale for the UIScale; leaving it goes back to how the element was.
--- A shaped element's background colour is its ShapeFill's. In a list, a scale moves the neighbours: give the
--- states to a child that fills a fixed slot when they must stay put.
function Ui.react(target: GuiObject, states: States): Reaction
	local fill = target:FindFirstChild("ShapeFill")
	local function owner(prop: string): (Instance, string)
		if fill and fill:IsA("ImageLabel") then
			if prop == "BackgroundColor3" then
				return fill, "ImageColor3"
			elseif prop == "BackgroundTransparency" then
				return fill, "ImageTransparency"
			end
		end
		return target, prop
	end
	local scale = target:FindFirstChildOfClass("UIScale")
	if not scale then
		local made = Instance.new("UIScale")
		made.Parent = target
		scale = made
	end
	local base: { [string]: any } = {}
	for _, patch in { states.hover, states.press, states.selected, states.disabled } do
		if patch then
			for prop in patch do
				if prop ~= "Scale" and base[prop] == nil then
					local o, p = owner(prop)
					base[prop] = (o :: any)[p]
				end
			end
		end
	end
	local hovering, pressing, selected, disabled = false, false, false, false
	local function apply()
		local goal: { [string]: any } = table.clone(base)
		local size = 1
		local function layer(patch: StatePatch?)
			if patch then
				for prop, v in patch do
					if prop == "Scale" then
						size = v
					else
						goal[prop] = v
					end
				end
			end
		end
		if selected then
			layer(states.selected)
		end
		if hovering and not disabled then
			layer(states.hover)
		end
		if pressing and not disabled then
			layer(states.press)
		end
		if disabled then
			layer(states.disabled)
		end
		for prop, v in goal do
			local o, p = owner(prop)
			Ui.play(o, QUICK, { [p] = v })
		end
		Motion.spring(scale :: UIScale, { Scale = size }, if pressing then 9 else 5, if pressing then 1 else 0.45)
	end
	local connections = {
		target.MouseEnter:Connect(function()
			if Ui.input() == "mouse" then -- a tap fires MouseEnter without MouseLeave
				hovering = true
				apply()
			end
		end),
		target.MouseLeave:Connect(function()
			hovering, pressing = false, false
			apply()
		end),
		target.SelectionGained:Connect(function()
			hovering = true
			apply()
		end),
		target.SelectionLost:Connect(function()
			hovering = false
			apply()
		end),
		target.InputBegan:Connect(function(input: InputObject)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch or input.KeyCode == Enum.KeyCode.ButtonA then
				pressing = true
				apply()
			end
		end),
		target.InputEnded:Connect(function(input: InputObject)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch or input.KeyCode == Enum.KeyCode.ButtonA then
				pressing = false
				apply()
			end
		end),
	}
	return {
		setSelected = function(on: boolean)
			selected = on
			apply()
		end,
		setDisabled = function(on: boolean)
			disabled = on
			pcall(function()
				(target :: any).Interactable = not on
			end)
			apply()
		end,
		disconnect = function()
			for _, c in connections do
				c:Disconnect()
			end
		end,
	}
end

local REFERENCE = Vector2.new(1920, 1080)
local FIT = NumberRange.new(0.8, 1.5)
local TEN_FOOT = 1.25 -- a TV is read from across the room: everything 25% bigger

--- A ScreenGui for a layer of UI (HUD 0, menus 10, dialogs 20, toasts 30) with a UIScale that keeps a
--- 1920x1080 design readable on phones, big monitors and TVs (its rule declared for ui_audit).
function Ui.screen(name: string, displayOrder: number, parent: Instance): ScreenGui
	local old = parent:FindFirstChild(name)
	if old then
		old:Destroy()
	end
	local gui = Instance.new("ScreenGui")
	gui.Name = name
	gui.ResetOnSpawn = false
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets
	gui.DisplayOrder = displayOrder
	local scale = Instance.new("UIScale")
	scale:SetAttribute("FitReference", REFERENCE)
	scale:SetAttribute("FitRange", FIT)
	scale:SetAttribute("FitTenFoot", TEN_FOOT)
	scale.Parent = gui
	local boost = if GuiService:IsTenFootInterface() then TEN_FOOT else 1
	local function fit()
		local area = gui.AbsoluteSize
		if area.X > 0 and area.Y > 0 then
			scale.Scale = math.clamp(math.min(area.X / REFERENCE.X, area.Y / REFERENCE.Y), FIT.Min, FIT.Max) * boost
		end
	end
	gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(fit)
	gui.Parent = parent
	fit()
	return gui
end

export type Form = "phone" | "tablet" | "desktop" | "tv"

export type Device = {
	form: Form, -- the layout to build: phone (compact), tablet, desktop (wide), tv (10-foot, gamepad)
	portrait: boolean,
	input: Input, -- hints, prompts and focus follow it, not the form
	canvas: Vector2, -- design px the screen has under its UIScale (a landscape phone: about 945x415)
	points: Vector2, -- the screen's own size in points, inside its insets
}

--- The form factor of a screen right now, from the space it has (points inside its insets): "phone" when
--- the shorter side is under 500 points (every phone, either way up), "tablet" when the longer side is under
--- 1300 (tablets, small windows), "desktop" above, "tv" on a 10-foot interface (consoles).
function Ui.device(screen: ScreenGui): Device
	local points = screen.AbsoluteSize
	local scale = screen:FindFirstChildOfClass("UIScale")
	local k = if scale and scale.Scale > 0 then scale.Scale else 1
	local short, long = math.min(points.X, points.Y), math.max(points.X, points.Y)
	local form: Form = if GuiService:IsTenFootInterface() then "tv" elseif short < 500 then "phone" elseif long < 1300 then "tablet" else "desktop"
	return { form = form, portrait = points.Y > points.X, input = Ui.input(), canvas = points / k, points = points }
end

--- Calls build(device) now and again whenever the screen's form, orientation or input changes (a phone
--- rotated, a window resized past a breakpoint, a gamepad picked up): build the layout for that form there.
--- Returns a function that stops listening.
function Ui.onDevice(screen: ScreenGui, build: (device: Device) -> ()): () -> ()
	local last = ""
	local function check()
		local d = Ui.device(screen)
		local key = d.form .. (if d.portrait then "/portrait/" else "/landscape/") .. d.input
		if key ~= last and d.points.X > 0 then
			last = key
			build(d)
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

local focusRing: Frame? = nil

-- The gamepad selection highlight: an accent ring (one template for every button; the engine draws it).
local function ring(): Frame
	local made = focusRing
	if made then
		return made
	end
	local frame = Instance.new("Frame")
	frame.Name = "FocusRing"
	frame.BackgroundTransparency = 1
	frame.Size = UDim2.fromScale(1, 1)
	corner(frame, 12)
	local s = Instance.new("UIStroke")
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.Color = Ui.theme.accent
	s.Thickness = 3
	s.Parent = frame
	focusRing = frame
	return frame
end

export type ButtonKind = "primary" | "secondary" | "danger"

--- A button sized by its label, with hover, press (a spring), gamepad focus (hover colour and an accent
--- ring) and disabled states. Use .Activated for the action.
function Ui.button(parent: Instance, text: string, kind: ButtonKind?): TextButton
	local t = Ui.theme
	local base = if kind == "primary" then t.accent elseif kind == "danger" then t.danger else t.raised
	local hover = base:Lerp(Color3.new(1, 1, 1), 0.12)
	local b = Instance.new("TextButton")
	b.Name = text -- readable paths in audits and scripts; rename freely
	b.AutoButtonColor = false
	b.BackgroundColor3 = base
	b.FontFace = t.bold
	b.Text = text
	b.TextSize = 20
	b.TextColor3 = if kind == "primary" then t.accentText else t.text
	b.AutomaticSize = Enum.AutomaticSize.X
	b.Size = UDim2.fromOffset(120, 56)
	b.SelectionImageObject = ring()
	corner(b, 10)
	pad(b, 20, 0)
	if kind ~= "primary" then
		outline(b, t.stroke, 1, 0.6)
	end
	local press = Instance.new("UIScale")
	press.Parent = b
	local function lit(on: boolean)
		Ui.play(b, QUICK, { BackgroundColor3 = if on then hover else base })
	end
	b.MouseEnter:Connect(function()
		if Ui.input() == "mouse" then -- a tap fires MouseEnter without MouseLeave: no sticky hover on touch
			lit(true)
		end
	end)
	b.MouseLeave:Connect(function()
		lit(false)
		Motion.spring(press, { Scale = 1 }, 5, 0.5)
	end)
	b.SelectionGained:Connect(function()
		lit(true)
	end)
	b.SelectionLost:Connect(function()
		lit(false)
	end)
	b.MouseButton1Down:Connect(function()
		Motion.spring(press, { Scale = 0.95 }, 9, 1)
	end)
	b.MouseButton1Up:Connect(function()
		Motion.spring(press, { Scale = 1 }, 5, 0.45) -- a small overshoot on release
	end)
	b.Activated:Connect(function(input: InputObject)
		if string.sub(input.UserInputType.Name, 1, 7) == "Gamepad" then
			Motion.spring(press, { Scale = 0.95 }, 9, 1) -- A pressed: the same dip, then back
			task.delay(0.08, function()
				Motion.spring(press, { Scale = 1 }, 5, 0.45)
			end)
		end
	end)
	b:GetPropertyChangedSignal("Interactable"):Connect(function()
		b.BackgroundTransparency = if b.Interactable then 0 else 0.5
		b.TextTransparency = if b.Interactable then 0 else 0.4
	end)
	b.Parent = parent
	return b
end

local KEYS: { [string]: string } = { Return = "Enter", Escape = "Esc", LeftShift = "Shift", Space = "Space", Tab = "Tab" }

--- A key hint beside an action that follows the player's input: the key on keyboard ("E"), the button's
--- glyph on a gamepad (ButtonX), nothing on touch (the button itself is the target). Returns its frame.
function Ui.hint(parent: Instance, key: Enum.KeyCode, button: Enum.KeyCode?): Frame
	local t = Ui.theme
	local chip = Instance.new("Frame")
	chip.Name = "Hint"
	chip.BackgroundColor3 = t.bg
	chip.BackgroundTransparency = Ui.alpha(0.3)
	chip.AutomaticSize = Enum.AutomaticSize.X
	chip.Size = UDim2.fromOffset(32, 32)
	corner(chip, 6)
	outline(chip, t.stroke, 1, 0.4)
	local text = label(chip, "", 16, true)
	text.AutomaticSize = Enum.AutomaticSize.X
	text.Size = UDim2.fromScale(0, 1)
	text.TextXAlignment = Enum.TextXAlignment.Center
	pad(chip, 8, 0)
	local glyph = Instance.new("ImageLabel")
	glyph.BackgroundTransparency = 1
	glyph.Size = UDim2.fromScale(1, 1)
	glyph.ScaleType = Enum.ScaleType.Fit
	glyph.Parent = chip
	local function refresh()
		local input = Ui.input()
		chip.Visible = input ~= "touch"
		local image = if input == "gamepad" and button then UserInputService:GetImageForKeyCode(button) else ""
		glyph.Image = image
		glyph.Visible = image ~= ""
		text.Visible = image == ""
		local name = UserInputService:GetStringForKeyCode(key)
		text.Text = KEYS[key.Name] or (if name ~= "" then string.upper(name) else key.Name)
	end
	pcall(function()
		local changed = UserInputService:GetPropertyChangedSignal("PreferredInput"):Connect(refresh)
		chip.Destroying:Connect(function()
			changed:Disconnect()
		end)
	end)
	refresh()
	chip.Parent = parent
	return chip
end

export type Window = {
	root: Frame,
	body: Frame,
	open: () -> (),
	close: () -> (),
	closed: BindableEvent,
	opened: BindableEvent, -- after it opens: play the content's entrance here
	motion: Motion.Scope, -- loops and timelines of the window: stopped when it closes
}

--- A centred window over a dimmed backdrop: a header (title, close button) and a body to fill. It is
--- `size` (design px) on big screens and shrinks to the screen on phones. Escape or gamepad B closes it;
--- opening on a gamepad selects its first button (mouse and touch players get no selection box).
function Ui.window(screen: ScreenGui, title: string, size: Vector2): Window
	local t = Ui.theme
	local backdrop = Instance.new("TextButton")
	backdrop.Name = title .. "Backdrop"
	backdrop.Text = ""
	backdrop.AutoButtonColor = false
	backdrop.BackgroundColor3 = Color3.new(0, 0, 0)
	backdrop.BackgroundTransparency = 1
	backdrop.Size = UDim2.fromScale(1, 1)
	backdrop.ZIndex = 10 -- an open window covers the rest of its screen (buttons made after it too)
	backdrop.Visible = false
	backdrop.Selectable = false
	backdrop.Parent = screen

	local root = Instance.new("Frame")
	root.Name = title
	root.AnchorPoint = Vector2.new(0.5, 0.5)
	root.Position = UDim2.fromScale(0.5, 0.5)
	root.Size = UDim2.fromScale(0.96, 0.96)
	root.BackgroundColor3 = t.surface
	local cap = Instance.new("UISizeConstraint")
	cap.MaxSize = size
	cap.Parent = root
	corner(root)
	outline(root, t.stroke, 1, 0.5)
	Ui.shadow(root, 3)
	local grow = Instance.new("UIScale")
	grow.Parent = root
	root.Parent = backdrop

	local column = Instance.new("UIListLayout")
	column.FillDirection = Enum.FillDirection.Vertical
	column.SortOrder = Enum.SortOrder.LayoutOrder
	column.Parent = root

	local header = Instance.new("Frame")
	header.Name = "Header"
	header.BackgroundTransparency = 1
	header.Size = UDim2.new(1, 0, 0, 72)
	header.LayoutOrder = 1
	pad(header, 24, 0)
	local row = Instance.new("UIListLayout")
	row.FillDirection = Enum.FillDirection.Horizontal
	row.VerticalAlignment = Enum.VerticalAlignment.Center
	row.Padding = UDim.new(0, 12)
	row.SortOrder = Enum.SortOrder.LayoutOrder
	row.Parent = header
	local heading = label(header, title, 32, true)
	heading.AutomaticSize = Enum.AutomaticSize.None
	heading.Size = UDim2.fromScale(0, 1)
	heading.LayoutOrder = 1
	local flex = Instance.new("UIFlexItem")
	flex.FlexMode = Enum.UIFlexMode.Fill
	flex.Parent = heading
	local closeButton = Ui.button(header, "X", "secondary")
	closeButton.Name = "Close"
	closeButton.AutomaticSize = Enum.AutomaticSize.None
	closeButton.Size = UDim2.fromOffset(56, 56)
	closeButton.LayoutOrder = 2
	header.Parent = root

	local body = Instance.new("Frame")
	body.Name = "Body"
	body.BackgroundTransparency = 1
	body.Size = UDim2.new(1, 0, 1, -72)
	body.LayoutOrder = 2
	pad(body, 24, 16)
	body.Parent = root

	local closed = Instance.new("BindableEvent")
	local opened = Instance.new("BindableEvent")
	local motion = Motion.scope(backdrop) -- the backdrop hides on close: its loops stop with it
	local action = "UiClose_" .. title

	local function close()
		if not backdrop.Visible then
			return
		end
		ContextActionService:UnbindAction(action)
		if GuiService.SelectedObject and GuiService.SelectedObject:IsDescendantOf(backdrop) then
			GuiService.SelectedObject = nil
		end
		local function finish()
			backdrop.Visible = false
			closed:Fire()
		end
		if Motion.reduced() then
			backdrop.BackgroundTransparency = 1
			finish()
			return
		end
		Motion.tween(backdrop, CLOSE, { BackgroundTransparency = 1 })
		Motion.tween(grow, CLOSE, { Scale = 0.92 }).Completed:Once(finish)
	end

	local function open()
		backdrop.Visible = true
		if Motion.reduced() then
			grow.Scale = 1
			backdrop.BackgroundTransparency = Ui.alpha(0.45)
		else
			grow.Scale = 0.92
			Motion.tween(backdrop, OPEN, { BackgroundTransparency = Ui.alpha(0.45) })
			Motion.tween(grow, OPEN, { Scale = 1 })
		end
		ContextActionService:BindAction(action, function(_: string, state: Enum.UserInputState): Enum.ContextActionResult
			if state == Enum.UserInputState.Begin then
				close()
			end
			return Enum.ContextActionResult.Sink
		end, false, Enum.KeyCode.Escape, Enum.KeyCode.ButtonB)
		if Ui.onGamepad() then
			for _, d in body:GetDescendants() do
				if d:IsA("GuiButton") and d.Selectable then
					GuiService.SelectedObject = d
					break
				end
			end
		end
		opened:Fire()
	end

	closeButton.Activated:Connect(close)
	return { root = root, body = body, open = open, close = close, closed = closed, opened = opened, motion = motion }
end

--- Tabs across the top of a container; returns the function that selects a tab by index.
function Ui.tabs(parent: Instance, names: { string }, onSelect: (index: number) -> ()): (index: number) -> ()
	local t = Ui.theme
	local bar = Instance.new("Frame")
	bar.Name = "Tabs"
	bar.BackgroundTransparency = 1
	bar.Size = UDim2.new(1, 0, 0, 60)
	local row = Instance.new("UIListLayout")
	row.FillDirection = Enum.FillDirection.Horizontal
	row.Padding = UDim.new(0, 8)
	row.SortOrder = Enum.SortOrder.LayoutOrder
	row.Parent = bar
	local buttons: { TextButton } = {}
	local function choose(index: number)
		for i, b in buttons do
			Ui.play(b, QUICK, { BackgroundColor3 = if i == index then t.accent else t.raised, TextColor3 = if i == index then t.accentText else t.subtext })
		end
		onSelect(index)
	end
	for i, name in names do
		local b = Instance.new("TextButton")
		b.Name = name
		b.AutoButtonColor = false
		b.BackgroundColor3 = t.raised
		b.TextColor3 = t.subtext
		b.FontFace = t.bold
		b.Text = name
		b.TextSize = 18
		b.AutomaticSize = Enum.AutomaticSize.X
		b.Size = UDim2.fromOffset(0, 52)
		b.SelectionImageObject = ring()
		corner(b, 26)
		pad(b, 18, 0)
		b.LayoutOrder = i
		b.Activated:Connect(function()
			choose(i)
		end)
		b.Parent = bar
		table.insert(buttons, b)
	end
	bar.Parent = parent
	choose(1)
	return choose
end

local function scroller(parent: Instance, name: string, direction: Enum.ScrollingDirection): ScrollingFrame
	local s = Instance.new("ScrollingFrame")
	s.Name = name
	s.BackgroundTransparency = 1
	s.BorderSizePixel = 0
	s.Size = UDim2.fromScale(1, 1)
	s.CanvasSize = UDim2.new()
	s.AutomaticCanvasSize = if direction == Enum.ScrollingDirection.X then Enum.AutomaticSize.X else Enum.AutomaticSize.Y
	s.ScrollingDirection = direction
	s.ScrollBarThickness = 5
	s.ScrollBarImageColor3 = Ui.theme.stroke
	s.SelectionGroup = true
	s.Parent = parent
	return s
end

--- A scrolling grid of cells (shops, inventories): children added to the returned frame line up.
function Ui.grid(parent: Instance, cell: Vector2, gap: number?): ScrollingFrame
	local s = scroller(parent, "Grid", Enum.ScrollingDirection.Y)
	local layout = Instance.new("UIGridLayout")
	layout.CellSize = UDim2.fromOffset(cell.X, cell.Y)
	layout.CellPadding = UDim2.fromOffset(gap or 12, gap or 12)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = s
	return s
end

--- A sideways strip of cells that scrolls left-right: a shop or inventory on a landscape phone, where
--- the window's body is about 294 design px high (one row of cards).
function Ui.strip(parent: Instance, cell: Vector2, gap: number?): ScrollingFrame
	local s = scroller(parent, "Strip", Enum.ScrollingDirection.X)
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.Padding = UDim.new(0, gap or 12)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = s
	s:SetAttribute("CellSize", cell) -- read by Ui.card: cards in a strip take this size
	return s
end

export type CardInfo = { name: string, price: number, icon: string?, owned: boolean?, rarity: Color3? }

--- A shop card: icon, name, price (or Owned) and a buy button. Wire card.Buy.Activated to a server request.
--- In a Ui.grid the grid sizes it; in a Ui.strip it takes the strip's cell size.
function Ui.card(grid: Instance, info: CardInfo): Frame
	local t = Ui.theme
	local card = Instance.new("Frame")
	card.Name = info.name
	card.BackgroundColor3 = t.raised
	local cell = grid:GetAttribute("CellSize")
	if typeof(cell) == "Vector2" then
		card.Size = UDim2.fromOffset(cell.X, cell.Y)
	end
	corner(card)
	outline(card, info.rarity or t.stroke, if info.rarity then 2 else 1, if info.rarity then 0.1 else 0.6)
	pad(card, 12, 12)
	local column = Instance.new("UIListLayout")
	column.FillDirection = Enum.FillDirection.Vertical
	column.HorizontalAlignment = Enum.HorizontalAlignment.Center
	column.VerticalFlex = Enum.UIFlexAlignment.SpaceBetween
	column.SortOrder = Enum.SortOrder.LayoutOrder
	column.Parent = card
	local icon = Instance.new("ImageLabel")
	icon.BackgroundTransparency = 1
	icon.Image = info.icon or ""
	icon.ScaleType = Enum.ScaleType.Fit
	icon.Size = UDim2.fromScale(1, 0.55)
	icon.LayoutOrder = 1
	icon.Parent = card
	local name = label(card, info.name, 18, true)
	name.TextXAlignment = Enum.TextXAlignment.Center
	name.TextTruncate = Enum.TextTruncate.AtEnd
	name.AutomaticSize = Enum.AutomaticSize.Y
	name.Size = UDim2.fromScale(1, 0)
	name.LayoutOrder = 2
	local buy = Ui.button(card, if info.owned then "Owned" else string.format("%d coins", info.price), if info.owned then "secondary" else "primary")
	buy.Name = "Buy"
	buy.AutomaticSize = Enum.AutomaticSize.None
	buy.Size = UDim2.new(1, 0, 0, 56)
	buy.TextSize = 18
	buy.Interactable = not info.owned
	buy.LayoutOrder = 3
	card.Parent = grid
	return card
end

--- A small yes/no dialog above everything; calls onAnswer(true) for yes.
function Ui.confirm(screen: ScreenGui, question: string, onAnswer: (yes: boolean) -> ())
	local window = Ui.window(screen, "Confirm", Vector2.new(520, 260))
	local text = label(window.body, question, 20)
	text.TextWrapped = true
	text.AutomaticSize = Enum.AutomaticSize.Y
	text.Size = UDim2.fromScale(1, 0)
	local row = Instance.new("Frame")
	row.BackgroundTransparency = 1
	row.AnchorPoint = Vector2.new(1, 1)
	row.Position = UDim2.fromScale(1, 1)
	row.Size = UDim2.new(1, 0, 0, 56)
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Right
	layout.Padding = UDim.new(0, 12)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = row
	local no = Ui.button(row, "Cancel", "secondary")
	no.LayoutOrder = 1
	local yes = Ui.button(row, "Confirm", "primary")
	yes.LayoutOrder = 2
	row.Parent = window.body
	local answered = false
	local function answer(value: boolean)
		if answered then
			return
		end
		answered = true
		window.close()
		onAnswer(value)
	end
	yes.Activated:Connect(function()
		answer(true)
	end)
	no.Activated:Connect(function()
		answer(false)
	end)
	window.closed.Event:Once(function()
		answer(false)
	end)
	window.open()
	if Ui.onGamepad() then
		GuiService.SelectedObject = yes
	end
end

--- Counts a label up (or down) to a number with thousands separators (Motion.count).
function Ui.count(target: TextLabel, from: number, to: number, seconds: number?)
	Motion.count(target, from, to, { seconds = seconds })
end

return Ui
```

Example: a shop window opened by a button, buying through the server.
```lua
--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Ui = require(ReplicatedStorage.Shared.Ui)

local ITEMS = {
	{ id = "sword_iron", name = "Iron Sword", price = 150, icon = "rbxassetid://0" },
	{ id = "sword_gold", name = "Golden Sword", price = 900, icon = "rbxassetid://0", rarity = Color3.fromRGB(255, 196, 0) },
}

local player = Players.LocalPlayer
local screen = Ui.screen("Shop", 10, player:WaitForChild("PlayerGui"))
local window = Ui.window(screen, "Shop", Vector2.new(980, 680))
local grid = Ui.grid(window.body, Vector2.new(200, 260))
local buy = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Buy") :: RemoteFunction

for i, item in ITEMS do
	local card = Ui.card(grid, { name = item.name, price = item.price, icon = item.icon, rarity = item.rarity })
	card.LayoutOrder = i
	local button = card:FindFirstChild("Buy") :: TextButton
	button.Activated:Connect(function()
		Ui.confirm(screen, string.format("Buy %s for %d coins?", item.name, item.price), function(yes: boolean)
			if yes then
				-- The server checks the price, the coins and ownership; the UI shows its answer.
				local ok = buy:InvokeServer(item.id) :: boolean
				button.Text = if ok then "Owned" else "Not enough"
				button.Interactable = not ok
			end
		end)
	end)
end

local open = Ui.button(screen, "Shop", "primary")
open.AnchorPoint = Vector2.new(0, 1)
open.Position = UDim2.new(0, 24, 1, -24)
open.Activated:Connect(window.open)
```

The same shop with a layout per form (`Ui.onDevice`): what a phone, an upright phone, a tablet, a desktop and a
TV each get.
```lua
--!strict
-- The same shop with a layout per form: a sideways strip on a landscape phone (the window's body is about
-- 294 design px high there: one row of cards), two columns on a phone held upright, a grid on tablet and
-- desktop, bigger cards on a TV. The cards arrive staggered each time the window opens.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)

local ITEMS = {
	{ name = "Iron Sword", price = 150, icon = "rbxassetid://0" },
	{ name = "Golden Sword", price = 900, icon = "rbxassetid://0" },
	{ name = "Ice Bow", price = 1200, icon = "rbxassetid://0" },
}

local screen = Ui.screen("Shop", 10, Players.LocalPlayer:WaitForChild("PlayerGui"))
local window = Ui.window(screen, "Shop", Vector2.new(980, 680))
local content: Frame? = nil
local list: ScrollingFrame? = nil

Ui.onDevice(screen, function(device: Ui.Device)
	if content then
		content:Destroy()
	end
	local holder = Instance.new("Frame")
	holder.Name = "Content"
	holder.BackgroundTransparency = 1
	holder.Size = UDim2.fromScale(1, 1)
	holder.Parent = window.body
	content = holder
	local cards: ScrollingFrame
	if device.form == "phone" and not device.portrait then
		cards = Ui.strip(holder, Vector2.new(180, 240))
	elseif device.form == "tv" then
		cards = Ui.grid(holder, Vector2.new(240, 300), 20)
	else
		cards = Ui.grid(holder, Vector2.new(200, 260)) -- an upright phone fits two columns of these
	end
	for i, item in ITEMS do
		local card = Ui.card(cards, { name = item.name, price = item.price, icon = item.icon })
		card.LayoutOrder = i
	end
	list = cards
end)

window.opened.Event:Connect(function()
	local cards = list
	if cards then
		Motion.enter(cards:GetChildren(), { delay = 0.06 })
	end
end)

local open = Ui.button(screen, "Shop", "primary")
open.AnchorPoint = Vector2.new(0, 1)
open.Position = UDim2.new(0, 24, 1, -24)
open.Activated:Connect(window.open)
```

## Building a mockup: the format, the pictures, the build
A mockup (ui_mockup_create) is the screen in the layout engine's own terms; its whole format is in the tool's
description and `ui_mockup_list {format: true}` explains how each piece behaves. Anything outside the format, or in
the wrong place, is refused with the field and where it belongs: read the error, it says what to write.
- **Look at it.** Every create and update returns pictures (a phone and a desktop) drawn by the audit's own layout
  engine, with rulers in points: crowding, text running out of its box, weak contrast and a missing glow show there.
  `ui_mockup_render` draws more: any device, `focus` (one element big: an icon, a stroke, a badge), `states: true`
  (each element that has states, in each), `show` (a hidden menu), `backdrop: "bright"` (over a sunny game).
- **Fix in place.** A version that missed is fixed with `revise: [{version: "C", set: {…}}]` (C becomes C·2, the one
  before is kept); a new idea is a new letter. `retire` puts superseded versions away. `check: true` draws and checks
  without saving.
- **A reference.** When the user attaches a picture of a UI they like, `ui_reference {latest: true}` samples its
  colours and accents, suggests a theme and lists the fonts by look; with `mockup` it draws yours beside it and says
  where they differ. Take its level of craft, not its pixels.

Every piece is something Roblox builds, and the kit builds it the same way:
| Mockup | In Roblox | Kit |
|---|---|---|
| `gradient {colors, transp, rot, type}` | UIGradient (colours multiply the element's: for a coloured fill set bg white) | `Ui.gradient(o, {color = ColorSequence, transparency = NumberSequence, rotation, kind})` |
| `stroke` (one or a list) `{color, t, px, pos, text, z, gradient}` | UIStroke, several by ZIndex, Border or Contextual (letters) | `Ui.stroke(o, {color, thickness, transparency, position, text, z, gradient})` |
| `shadow {color, t, blur, spread, offset}` (offset 0 = a glow) | UIShadow (boxes and corners only) | `Ui.glow(o, color, blur, t, spread)` or `Ui.shadow` |
| `corners [tl, tr, br, bl]` | UICorner TopLeftRadius… | a UICorner with the four radii |
| `badge {text, style, color, at}` | a child "Badge" (TextLabel or Frame) | `Ui.badge(o, text, {style, color, at})` |
| `shape {cut, slant}` | 9-sliced images made by `ui_icon {shapes}` (UiShapes), tinted | `Ui.shape(o, Shapes.<Name>, lines)` |
| `states {hover, press, selected, disabled}` | property changes and a UIScale spring | `Ui.react(o, {hover = {Scale = 1.04}, …})` |
| `appear` | Motion.enter as the screen opens | `Motion.enter({o}, {from = …})` |
| `image "glyph:rocket"` / `"icon:Name"` | an uploaded image | `ui_icon {icons: [{name, glyph}]}`, then `Icons.<Name>` |

A worked example, a sci-fi weapon panel and one of a row of menu buttons (the theme has `panel` and `cyan`):
```json
{"name": "Combat", "kit": "hud", "kids": [
  {"name": "Weapon", "cls": "Frame", "anchor": [1, 1], "pos": [1, -24, 1, -24], "size": [0, 330, 0, 120],
   "bg": "$panel", "bgT": 0.3, "shape": {"slant": [30, 0], "cut": [0, 16, 0, 0]},
   "gradient": {"rot": 90, "transp": [[0, 0], [1, 0.45]]},
   "stroke": [{"color": "$cyan", "px": 7, "t": 0.8, "z": 0}, {"color": "$cyan", "px": 1.5, "pos": "Inner", "z": 1}],
   "kids": [
     {"name": "Ammo", "cls": "TextLabel", "anchor": [1, 0], "pos": [1, -24, 0, 8], "size": [0, 120, 0, 64], "bgT": 1,
      "text": "24", "textSize": 64, "font": "Michroma", "xAlign": "Right", "textColor": "#ffffff",
      "stroke": {"color": "$cyan", "px": 1, "t": 0.5, "text": true}},
     {"name": "Missile", "cls": "ImageLabel", "pos": [0, 54, 0, 22], "size": [0, 76, 0, 76], "bgT": 1,
      "image": "glyph:rocket", "imageColor": "$cyan", "rot": 45}]}],
 "forms": {"phonePortrait": {"set": {"Weapon": {"size": [0, 280, 0, 110]}}}}}
{"name": "Shop", "cls": "ImageButton", "size": [0, 168, 0, 150], "bg": "#ffffff", "corner": [0, 10],
 "gradient": {"rot": 90, "colors": [[0, "#d0507a"], [1, "#1c1820"]]}, "stroke": {"color": "#d0507a", "px": 1, "pos": "Inner"},
 "badge": {"text": "3"}, "states": {"hover": {"scale": 1.04}, "press": {"scale": 0.95}, "selected": {"stroke": {"color": "#ffffff", "px": 2, "pos": "Inner"}}},
 "appear": "pop",
 "kids": [
   {"name": "Lip", "cls": "Frame", "anchor": [0, 1], "pos": [0, 0, 1, 0], "size": [1, 0, 0, 6], "bg": "#d0507a"},
   {"name": "Icon", "cls": "ImageLabel", "anchor": [0.5, 0], "pos": [0.5, 0, 0, 18], "size": [0, 64, 0, 64], "bgT": 1, "image": "glyph:store"},
   {"name": "Label", "cls": "TextLabel", "anchor": [0.5, 1], "pos": [0.5, 0, 1, -16], "size": [1, -12, 0, 36], "bgT": 1,
    "text": "SHOP", "textSize": 24, "font": "LuckiestGuy", "textColor": "#ffffff", "stroke": {"color": "#1a0f08", "px": 3, "text": true}}]}
```
And built with the kit, element by element with the mockup's names (so `ui_mockup_audit {compare: true}` matches it):
```lua
--!strict
-- The worked example built: the weapon panel (a slanted shape with a faint wide stroke under a bright thin one, a
-- fade, a glyph icon, an outlined number) and the shop button (a gradient tinted by its colour, an inner border, a
-- lip, an outlined label, a count badge, hover, press and selected states, a pop as the menu opens).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Motion = require(ReplicatedStorage.Shared.Motion)
local Ui = require(ReplicatedStorage.Shared.Ui)
local Icons = require(ReplicatedStorage.Shared.UiIcons) -- ui_icon {icons: [{name: "Missile", glyph: "rocket"}, …]}
local Shapes = require(ReplicatedStorage.Shared.UiShapes) -- ui_icon {shapes: [{name: "WeaponPanel", mockup, path: "Combat.Weapon"}]}

local CYAN = Color3.fromRGB(63, 224, 255)
local PINK = Color3.fromRGB(208, 80, 122)
local gui = Players.LocalPlayer:WaitForChild("PlayerGui")

local function text(parent: Instance, name: string, value: string, size: number, font: Enum.Font): TextLabel
	local t = Instance.new("TextLabel")
	t.Name = name
	t.BackgroundTransparency = 1
	t.Text = value
	t.TextSize = size
	t.FontFace = Font.fromEnum(font)
	t.TextColor3 = Color3.new(1, 1, 1)
	t.Parent = parent
	return t
end

local combat = Ui.screen("Combat", 0, gui) -- a HUD would use Hud.screen (its 900x900 fit), as the mockup's kit "hud" says
local weapon = Instance.new("Frame")
weapon.Name = "Weapon"
weapon.AnchorPoint = Vector2.new(1, 1)
weapon.Position = UDim2.new(1, -24, 1, -24)
weapon.Size = UDim2.fromOffset(330, 120)
weapon.BackgroundColor3 = Color3.fromRGB(10, 24, 34)
weapon.BackgroundTransparency = 0.3
Ui.gradient(weapon, { rotation = 90, transparency = NumberSequence.new(0, 0.45) })
weapon.Parent = combat
-- The shape's images, outlines in the mockup's stroke order; until they are uploaded, strokes on the box.
if not Ui.shape(weapon, Shapes.WeaponPanel, { { color = CYAN, transparency = 0.8 }, { color = CYAN, transparency = 0 } }) then
	Ui.stroke(weapon, { color = CYAN, thickness = 7, transparency = 0.8, z = 0 })
	Ui.stroke(weapon, { color = CYAN, thickness = 1.5, position = "Inner", z = 1 })
end
local ammo = text(weapon, "Ammo", "24", 64, Enum.Font.Michroma)
ammo.AnchorPoint = Vector2.new(1, 0)
ammo.Position = UDim2.new(1, -24, 0, 8)
ammo.Size = UDim2.fromOffset(120, 64)
ammo.TextXAlignment = Enum.TextXAlignment.Right
Ui.stroke(ammo, { color = CYAN, thickness = 1, transparency = 0.5, text = true })
local missile = Instance.new("ImageLabel")
missile.Name = "Missile"
missile.Position = UDim2.fromOffset(54, 22)
missile.Size = UDim2.fromOffset(76, 76)
missile.Rotation = 45
missile.BackgroundTransparency = 1
missile.Image = Icons.Missile
missile.ImageColor3 = CYAN
missile.Parent = weapon

local menu = Ui.screen("Menu", 10, gui)
local shop = Instance.new("ImageButton")
shop.Name = "Shop"
shop.Size = UDim2.fromOffset(168, 150)
shop.BackgroundColor3 = Color3.new(1, 1, 1) -- the gradient carries the colour: it multiplies the background
local round = Instance.new("UICorner")
round.CornerRadius = UDim.new(0, 10)
round.Parent = shop
Ui.gradient(shop, { rotation = 90, color = ColorSequence.new(PINK, Color3.fromRGB(28, 24, 32)) })
local edge = Ui.stroke(shop, { color = PINK, position = "Inner" })
local lip = Instance.new("Frame")
lip.Name = "Lip"
lip.AnchorPoint = Vector2.new(0, 1)
lip.Position = UDim2.fromScale(0, 1)
lip.Size = UDim2.new(1, 0, 0, 6)
lip.BackgroundColor3 = PINK
lip.Parent = shop
local icon = Instance.new("ImageLabel")
icon.Name = "Icon"
icon.AnchorPoint = Vector2.new(0.5, 0)
icon.Position = UDim2.new(0.5, 0, 0, 18)
icon.Size = UDim2.fromOffset(64, 64)
icon.BackgroundTransparency = 1
icon.Image = Icons.Shop
icon.Parent = shop
local label = text(shop, "Label", "SHOP", 24, Enum.Font.LuckiestGuy)
label.AnchorPoint = Vector2.new(0.5, 1)
label.Position = UDim2.new(0.5, 0, 1, -16)
label.Size = UDim2.new(1, -12, 0, 36)
Ui.stroke(label, { color = Color3.fromRGB(26, 15, 8), thickness = 3, text = true })
local badge = Ui.badge(shop, "3")
shop.Parent = menu
-- Its states: hover and press scale it; selected (the open tab) brightens its edge.
local reaction = Ui.react(shop, { hover = { Scale = 1.04 }, press = { Scale = 0.95 } })
shop.Activated:Connect(function()
	reaction.setSelected(true)
	edge.Color = Color3.new(1, 1, 1)
	edge.Thickness = 2
	badge.Visible = false
end)
Motion.enter({ shop }, { from = "pop" }) -- appear: "pop"
```
`selected` changes a stroke, which is not a property of the button: set it where the selection happens, as above
(`Ui.react` plays properties of the element itself and its UIScale). Shapes and icons are images: in a design turn
`ui_icon` saves their pictures; they are uploaded and written into UiIcons and UiShapes when the design goes in.

## Game UI art: the Forge
Flat boxes with strokes are a wireframe; the games players love wear painted art — bevelled, glossy windows on a 3D
base, buttons that sink when pressed, rarity cards, title plates in display type. `ui_forge` draws that art in the
app (no model call, nothing uploaded while you design), 9-sliced so it keeps its corners at any size:
- **Pick one art direction for the game** (`ui_forge {action: "directions"}`; look at one with `{action: "sheet",
  direction, accent}`): it sets the palette, the Roblox fonts and the text colour on each surface. `ui_reference`
  ranks the directions nearest a reference picture's colours. An accent `#rrggbb` tints it to the game's palette.
  Pick by the genre's feel, not the nearest colours: a cartoon simulator direction on a racer or a horror game
  reads as "a simulator" to players.
- **Frames in your brand colour**: windows, headers, tabs and titles wear the direction's own colour (candy is
  purple) until they carry your game's accent (`"candy:window#d62828"`); a burger tycoon in a purple frame is
  off-theme. Rarities, coins and roles keep their colours.
- **Texture on the frame, calm inside**: grime, rust, wood or carbon belongs on window and rim; the wells that
  hold items and text stay dark and plain, lit by rarity, or every slot reads the same and nothing leads the eye.
- **What the player can't do yet looks it**: a REBIRTH at 24% or an UPGRADE they can't afford starts in its
  disabled art (`state: "disabled"` with `states: {disabled: {skin: "…:disabled"}}`), with what it needs on it.
- **Skin the pieces**: `skin: "<direction>:<kind>[:<variant>[:<state>]]"` on windows, headers, buttons, tabs,
  cards (by rarity), slots, bars, pills, badges, close buttons; icons and coins `"dir:icon:<glyph or game
  word>[:<rarity>]"`; a title plate `"dir:title:<TEXT>"`. The element's own fill turns off and its text sits over
  the art in the direction's ink (keep the text live: prices, names and counts change).
- **Light is art too**: `skin: "fx:glow#ffd23f"` (also rays, halo, sparkles, shine, vignette, spotlight) on an ImageLabel behind a hero item gives the round glow a radial UIGradient can't (Roblox draws those as linear).
- **States wear their own art**: `states: {press: {skin: "dir:button:primary:pressed"}, selected: {skin:
  "dir:tab:active"}, disabled: {skin: "dir:button:primary:disabled"}}` — the face sinks and the text with it.
- **Start from a template** for a whole screen (`ui_forge {action: "templates"}`: shop, inventory, collection, HUDs,
  daily rewards, battle pass, round end): a mockup version `{note, template: {id, direction, accent, content}}`
  filled with the game's own items and numbers, then `set` what should differ. Two directions as two versions
  show the user real choices.
- **Reskin what exists**: a mockup version `{from: "game:Shop", reskin: {direction: "candy"}}` reads each element of
  the game's UI (or of any version) for what it is and dresses it — windows, headers, titles, buttons by colour role,
  tabs with the open one selected, close buttons, cards by rarity, bars, pills, slots — with state art; `set` then
  fixes what it read wrong.
- **Menus own the screen**: a full-screen shop or inventory hides Roblox's chat, player list and touch controls while open — `hides: "chat playerList touch"` on its ScreenGui (the build turns them off and back on).
- **It ships as designed**: `ui_lab_build` saves the art under `ui/skins`, uploads it when uploads are on (until then
  it shows in Studio on this PC only) and the builder swaps state art by itself. A skinned button's text is in its
  child `Label`. Panel shapes (cut corners, leaning sides) ship too: they are forged as art with their fill,
  gradient and outlines, and a state that recolours one wears its own. States' strokes, gradients and shadows play
  in the game as in the pictures; TextSize stops at 100 (bigger type: TextScaled, a UIScale or a forged title).

## Mistakes that make Roblox UI look amateur
- Flat rectangles with a stroke where the genre expects painted art (the Forge draws it).
- Default grey and Arial; five colours fighting; every button accent-coloured.
- Offsets without UIScale (tiny on 4K, huge on phones) or everything TextScaled (mismatched sizes).
- UI under the top bar or the jump button; windows that can't be closed with B/Escape.
- Instant pop-in with no motion, or slow (> 0.3 s) animations that make the game feel laggy.
- One layout for every device: the desktop menu shrunk onto a phone, or a phone layout stretched across a TV.
- Scrolling lists with a fixed CanvasSize that clips items; grids that overflow the window.
- Shops that deduct currency on the client, or trust the client's price.
