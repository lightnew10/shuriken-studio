---
name: roblox-ui-references
description: "The quality bar for Roblox game UI, in numbers: read it before designing or restyling any HUD, menu, shop, inventory, reward, loading or settings screen. A scoring rubric, the design canvas per device (945x415 on a phone), tokens (spacing, radii, type, strokes, UIShadow elevation), contrast-checked palettes and rarity colours, a device matrix with breakpoints (phone either way up, tablet, desktop, TV), a zone map with phone rules, blueprints for 11 genres, component specs, motion and sound tables, accessibility (PreferredInput, Reduce Motion, Preferred Transparency), budgets, a polish checklist, what reads dated versus modern, amateur mistakes, and the 2026 engine features (UIShadow, per-corner UICorner, UI Styling)."
version: 3
tags: [ui, hud, design, tokens, palette, color, contrast, rarity, typography, spacing, shadow, gradient, motion, easing, sound, accessibility, reduce motion, mobile, gamepad, genre, shop, inventory, gacha, killfeed, scoreboard, quest, loading, settings, performance, polish, styling, theme]
roblox_systems: [ScreenGui, UIScale, UIShadow, UICorner, UIStroke, UIGradient, UITextSizeConstraint, CanvasGroup, GuiService, UserInputService, TweenService, StyleSheet, StyleRule, InputActionLabel]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [ui_audit, roblox_screenshot, roblox_playtest, luau_check, store_search]
---
# Roblox UI references: what good looks like, in numbers

Use this beside skill **roblox-ui-design** (the Ui kit and the design process: `Ui.screen`, `window`, `button`, `tabs`, `grid`,
`strip`, `card`, `confirm`, `count`, `device`, `onDevice`, `hint`), **roblox-game-hud** (the Hud kit: `Hud.screen`, `bar`,
`cooldownSlot`, `feed`, `toast`, `floatingText`, `counter`, `device`), **roblox-ui-motion** (the Motion module both kits play
through) and **roblox-ui-showpieces** (loading, title, reward, round end, interaction patterns). They say *how* to build; this
says *what to build and how good it has to be*.
Sizes are design px under `Ui.screen`'s UIScale (1920x1080 reference) unless marked HUD (the Hud kit's 900x900 reference).
**[practice]** = a widely shared genre convention, not an official rule and not re-checked against any game's current build: adapt
it, don't copy it. **[verify]** = from docs or the API dump but not measured in Studio: confirm with a screenshot before depending
on it. Everything else is from Roblox's docs, the engine's API dump, or computed from `ui_audit`'s layout engine (see Sources).

## The bar: what the user's reference games have in common (Oct 2026)
The user sent screens they rate (a mech shooter's lobby and ammo HUD, a case-opening shop, a sniper game's
loading screen and tabs, two simulators' HUDs): "not designs to copy into every build; a testament to the
quality and competence wanted". What they share, and what Shuriken's UIs lacked:

1. **Art in every slot.** Shop cards, inventory slots, currency counters, category tabs and rail buttons each
   show a rendered picture of the thing (the item on a radial burst, a coin, a crate, a crown): never a word
   alone or an emoji. `ui_icon` makes them from the game's models, and HUD symbols from line-art glyphs (`search`).
2. **Type that reads over a moving game.** A heavy display face, white with a dark stroke (UIStroke 2-3 px),
   often italic in action games. The number is the biggest thing in a counter (1.6-2x its label).
3. **Buttons are objects.** A thick dark border, a bright fill with a slight gradient, a darker bottom lip, an
   icon above the label, a `badge` (count or "NEW" ribbon), hover/press/selected `states`; square tiles for the rest.
4. **One hue per thing.** Each tab, category, product and rarity has its own colour, on its header band, its
   border and its button; the panel behind is one dark neutral. Three cards are three hues.
5. **A card's order**: title band, art, one line of what it is, price with the currency's icon, a full-width
   button. What the player lacks is said in place, in red ("Need 100 more gems"); a pill says what is ready;
   a locked item is dimmed art under a padlock.
6. **The HUD lives in rails at the edges.** Left: where to go (shop, index). Right: what you have (inventory,
   upgrades, trade) as icon tiles. A corner: currencies, each with a "+". Top: timers. The centre is the game's.
7. **Frames from the game's world.** Sci-fi and shooters: angular cut corners, thin glowing lines, translucent
   dark fills, a minimal combat HUD (two trapezoids, big numerals, one thin bar). Simulators and tycoons: chunky
   rounded shapes, thick outlines, saturated fills (mockup `shape`, layered `stroke`, `shadow` as a glow). Never one grey box.
8. **The world behind the menu.** Lobbies show the 3D thing itself (the character on a pedestal), UI around it.
9. **A brand moment.** The loading screen is the game's logo (a drawn wordmark), a progress bar and a percentage.
10. **Liveness.** Timers count down, a prize pool ticks, a winners feed scrolls, a discount strikes the old price.

Fails the bar: text-only buttons on flat rounded rectangles, emoji as icons, identical grey cards, no stroke on
text over the game, everything in one centred window, a card stretched over the whole screen with its content
in one corner (a modal is as big as its content, centred on a scrim), no locked/new/can't-afford states. It is a level of
craft, not a template: a horror game takes the hierarchy and the states and leaves the candy colours.

## 0. Facts that change decisions (checked Sept 2026)
- **Most Roblox sessions are on mobile** (official). Design the phone layout first, then let it breathe on desktop.
- **UIShadow** (full release 23 Jun 2026): native drop shadow with `Color`, `Transparency`, `BlurRadius` (UDim, up to 1000; scale =
  the shorter side), `Offset` and `Spread` (UDim2), `ZIndex` (negative only, default -1). It follows the parent's rotation and
  UICorner, costs no layout and beats 9-sliced shadow images; keep about 100 or fewer on screen; jagged on very large radii.
  The docs page lists no text, inset or gradient shadows; the API dump has `Mode` (Shape, or Text), `Inset` and
  `ShowBehindParent` and Studio 740's notes list an "Upgraded UI Shadows" beta: treat text and inset shadows as beta [verify].
  `Ui.shadow(panel, level)` is the kit's elevation helper (nil where UIShadow doesn't exist).
- **UICorner** per-corner radii (`TopLeftRadius` ... `BottomRightRadius`; `CornerRadius` sets all four; Scale 0.5 = a pill).
  **UIGradient** `Type` Linear/Radial/Conical, `Scale`, `TileMode` Clamp/Repeat/Mirror (glows, vignettes, sweeps, reveal rays).
  **UIStroke** `BorderStrokePosition` Inner/Center/Outer, `BorderOffset`, `LineJoinMode`, `StrokeSizingMode` (ScaledSize: relative
  to font size on text), `ZIndex` to stack strokes; never tween `Thickness` on a text stroke (glyphs re-render: flicker).
- **UI Styling** (live 20 Jan 2026): StyleSheet + StyleRule + StyleLink (one sheet per ScreenGui tree) + StyleDerive; tokens are
  attributes referenced as `"$Name"`; selectors: class, `.Tag`, `#Name`, `:Hover`/`:Press`, `>`, `>>`, `,`, `::UICorner` phantom
  instances, `@Query`. Queries (11 May): custom `::StyleQuery` (MinSize/MaxSize/AspectRatioRange) and built-ins
  `@ViewportDisplaySizeSmall/Medium/Large`, `@PreferredInputTouch/Gamepad/KeyboardAndMouse`, `@PreferredTextSizeLarge...`,
  `@ReducedMotionEnabledTrue/False`. Transitions (27 Jul): `StyleRule:SetPropertyTransitions` / `SetDefaultPropertyTransition`,
  engine-native, cheaper than Luau tweens, on styling changes only (tags, hover/press), no keyframes or springs, `RepeatCount`
  and `Reverses` ignored. Styled values override code-set properties (one owner per property); read `StyleRule.SelectorError`;
  a wrong property name fails silently.
- **`UserInputService.PreferredInput`**: `Enum.PreferredInput` KeyboardAndMouse / Gamepad / Touch / **MicroGamepad** (a gamepad
  without a thumbstick, e.g. a TV remote). The official way to pick a layout: `TouchEnabled` is true on touch laptops and
  `GetLastInputType()` thrashes (mouse/keyboard, touch/gamepad) and makes UI flicker. Listen with
  `GetPropertyChangedSignal("PreferredInput")`; treat Gamepad and MicroGamepad as "needs focus navigation".
- **`GuiService`**: `ViewportDisplaySize` (Small phones/tablets, Medium laptops/monitors, Large TVs), `PreferredTextSize`
  (Medium/Large/Larger/Largest), `PreferredTransparency` (1 = as designed, lower = more opaque panels), `ReducedMotionEnabled`,
  `TopbarInset` (the free Rect of the top bar, changes with core UI).
- **`InputActionLabel`** shows the right key or glyph for an `InputAction` and follows the device; `InputBinding.UIButton` makes
  an on-screen button an action's touch input. **`GuiButton.SecondaryActivated`**: right click, touch long-press, gamepad R3,
  Alt+Enter ("details"). **`HapticEffect`** `Type` UIClick/UIHover/UINotification: phone and gamepad feel.
- **Clipping rotated UI**: `ClipsDescendants` now clips rotated children and Path2D (`StarterGui.ClipsDescendantsSupportsRotation`,
  default Enabled from 24 Sep 2026, removal targeted Nov 2026): spinning rays and shaking panels inside a clipping parent are cut
  at its rectangle (still no clipping to UICorner or by a rotated parent), so give them room or an unclipped container.
- **CanvasGroup** costs texture memory, renders blank past the client's cap, wants a static size and only flattens under
  `ZIndexBehavior.Sibling`: short fades, not containers. Flex costs a little; size and aspect constraints override layouts.
  `UITextSizeConstraint.MinTextSize` never below 9; `TextScaled` text ignores the player's text size, `AutomaticSize` grows with it.

## 1. The device math: what a 1920x1080 design really gets
`Ui.screen` fits `clamp(min(w/1920, h/1080), 0.8, 1.5)` of the area inside CoreUISafeInsets (58-pt top bar; 44-pt notch sides on
the audit's phone). `Hud.screen` fits `clamp(min(w, h)/900, 0.6, 1.4)` of the DeviceSafeInsets area (the top bar is **not**
removed). Same math as `ui_audit`:

| Device (audit) | Screen pt | Ui.screen area | Ui scale | **Ui canvas (design px)** | Hud scale | **Hud canvas** |
|---|---|---|---|---|---|---|
| Phone | 844x390 | 756x332 | 0.80 | **945x415** | 0.60 | 1260x650 |
| Phone upright (if the game allows portrait) | 390x844 | 390x705 | 0.80 | **487x881** | 0.60 | 650x1272 |
| Tablet | 1180x820 | 1180x762 | 0.80 | 1475x952 | 0.91 | 1295x900 |
| Laptop | 1366x768 | 1366x710 | 0.80 | 1707x887 | 0.85 | 1601x900 |
| Desktop | 1920x1080 | 1920x1022 | 0.946 | 2029x1080 | 1.20 | 1600x900 |
| TV (10-foot: kits fit x1.25 Ui, x1.2 Hud) | 1920x1080 | 1920x1022 | 1.18 | 1623x864 | 1.44 | 1333x750 |
- **Breakpoints** (`Ui.device` / `Hud.device`, from the points a screen has): **phone** = shorter side under 500 pt (either
  way up), **tablet** = longer side under 1300, **desktop** above, **tv** = `GuiService:IsTenFootInterface()`. Each form gets
  its own layout (`Ui.onDevice` rebuilds on rotation, resize and input change); input (`PreferredInput`) picks hints, focus
  and hover, never the layout. The audit checks every row above (the upright phone when `ScreenOrientation` allows it).

- A phone menu has **945x415 design px**. `Ui.window` there is 907x398 with a 72 header, so its body content is **859x294**: one
  row of 260-high shop cards. On phones make shops a sideways strip or 72-high rows (anything taller scrolls). A left button
  column holds **4 buttons of 72 + 12 gaps (324 of 383)**; the rest go behind "More".
- Minimums under Ui.screen (0.8 on phone): tap target **56** (45 pt), text **15** (12 pt; the audit warns under 11 pt), body
  18-20. Under Hud.screen (0.6 on phone): tap target **74** (44 pt), text **20** (12 pt).
- A HUD on Hud.screen can land **under Roblox's top-bar buttons** (the audit flags the top 58 pt, left 180 pt, right 120 pt):
  top pieces go top-centre, corner pieces start 100 HUD px down (60 pt at 0.6).
- Touch reserves bottom-left (thumbstick) and bottom-right (jump). Place touch action buttons **relative to the JumpButton**
  (`playerGui:FindFirstChild("JumpButton", true)`, wait for `IsLoaded`), not at screen fractions (40% down is reachable on a
  phone, not a tablet). Jump is about 70 pt on small screens (shorter side <= 500), 120 pt otherwise, 20 pt up [verify].

## 2. Quality rubric (score each 0 fail / 1 ok / 2 studio-grade; ship at 20+ of 24 with no 0 in rows 1-4)
| # | Criterion | 2 means |
|---|---|---|
| 1 | Fits and safe | ui_audit clean on the whole matrix (phone, upright phone if allowed, tablet, desktop, TV); a layout per form; nothing under the top bar, thumbstick or jump zones |
| 2 | Readable | body >= 18, nothing < 15 (Ui) / < 20 (Hud); text 4.5:1 (large text and icons 3:1); text over 3D has a stroke or a backing |
| 3 | Hierarchy | one primary (accent) action per view; title, content, footer zones; at most 3 emphasis levels; centre of screen clear in play |
| 4 | Input-complete | `Activated` everywhere; gamepad focus on open (Gamepad/MicroGamepad only); B/Escape closes; bumpers switch tabs; targets >= 44 pt, >= 8 px apart; nothing hover-only |
| 5 | Consistency | one radius family, one stroke recipe, one body + one display face, every colour from tokens |
| 6 | Feedback | hover, pressed, disabled, selected, loading and error states; a click sound; success and failure answered visibly |
| 7 | Motion | opens 0.15-0.25 s, closes <= 0.15 s, rewards 0.3-0.6 s with overshoot; nothing blocks input > 0.4 s; Reduce Motion honoured |
| 8 | Content-proof | long names truncate, 12-digit numbers abbreviate (1.2K/3.4M/5.6B/7.8T), empty states, 50+ items scroll, +40% text width fits |
| 9 | Finish | panels separated from the world (shadow or stroke), crisp icons at 2x, no stretched images, gradients subtle, 4-px grid |
| 10 | Trust | server decides purchases; price with currency icon; owned/equipped states; confirm expensive or irreversible actions |
| 11 | Accessibility | Preferred Transparency, Text Size and Reduce Motion respected; colour never the only signal |
| 12 | Performance | inside the section 10 budgets; no per-frame instance creation; hidden UI disabled, not just transparent |

## 3. Design tokens
**Spacing** (4-px base): `space = { xxs 4, xs 8, sm 12, md 16, lg 24, xl 32, xxl 48, xxxl 64 }`. Button padding x 16-24, card padding
12-16, window padding 24 (phone 16), related items 8-12 apart, groups 24-32, screen-edge margin 24 (phone 16). Every size and
position is a multiple of 4: mixed 5/7/13-px gaps are the quickest tell of amateur UI.
**Radii**: `{ xs 4, sm 8, md 12, lg 16, xl 24, pill = 0.5 scale }`; nested corners stay concentric (**inner = outer - padding**).
Style defaults: cartoony lg/xl, sleek-competitive xs/sm, horror 0-4, fantasy 4-8, minimal md. Per-corner radii: tabs fused to a
panel round only their top corners; bottom sheets only the top. (The kit's buttons are fixed at 10, tabs are pills.)

| Type token | Size | Weight | Use |
|---|---|---|---|
| display | 64-72 | ExtraBold/Heavy | one splash per screen: "LEGENDARY!", "WAVE 12", "VICTORY" |
| h1 / h2 | 40 / 28-32 | Bold | screen titles / window titles (`Ui.window` uses 32), section heads, big counters |
| h3 | 24 | SemiBold | card titles, desktop tabs |
| body | 20 | Regular/Medium | descriptions, list rows |
| label | 18-20 | SemiBold/Bold | buttons, tabs, prices |
| caption / micro | 16 / 14 | Medium / Bold | meta text, secondary prices / badges, key hints (14 is the floor: 11.2 pt on a phone) |
HUD (Hud.screen): numbers 28-40 Heavy, labels 20-22 Bold, feed rows 20.
- Faces: body **BuilderSans** (Roblox's UI face, Regular..ExtraBold) or Gotham; one display face per game: cartoony FredokaOne /
  LuckiestGuy / DenkOne, action Bangers, competitive Oswald / Michroma / TitilliumWeb, horror SpecialElite (Creepster for the logo
  only), fantasy Fondamento / Merriweather, timers RobotoMono (all exist as `Enum.Font`). Line height 1.1-1.25 on paragraphs; ALL
  CAPS only for short labels and splashes; decorative faces for titles and alerts only. `ui_audit` measures text with an estimate
  fitted to BuilderSans: other faces land within roughly 10-15%, so leave slack.

**Strokes, shadows, gradients**
- Hairline edge (sleek, minimal, the kit default): UIStroke Border, Inner, 1 px, transparency 0.5-0.7.
- Cartoon outline: UIStroke 3 px (buttons) / 4 px (panels), Inner, the palette's darkest hue; white text on a saturated fill gets a
  2-3 px Contextual text stroke in that dark (white on a mid blue is 2.9:1: the stroke makes it legible).
- Text over the world: Contextual stroke 1.5-2.5 px black at 0.2-0.4 transparency, or a 0.2-0.35 backing.
- Elevation with `Ui.shadow(panel, level)` (UIShadow; colour black or the palette's darkest hue): level 1 Offset (0,4) Blur 8 T 0.7
  (chips, slots); 2 (0,6) Blur 16 T 0.6 (cards, hovered buttons); 3 (0,12) Blur 32 T 0.5 (windows, popups). Glow: a second
  UIShadow, Offset 0, Spread (0,4,0,4), accent colour, T 0.4. Without UIShadow: a slightly larger, darker Frame behind the panel.
- 3D lip button [practice] (cartoony, simulator): a darker copy of the face 6 px below (or a UIShadow Blur 0, Offset (0,6), T 0);
  pressing moves the face down 4 px and the lip shrinks.
- Gradient shading: Rotation 90, white to 85% grey over the base colour; rainbow only for the top rarity. Shine sweep: a white
  transparency band (T 1 / 0.6 / 1 around 0.5) whose `Offset` tweens (-1,0) to (1,0), Linear 0.7 s, every 3 s on one hero element.

**Palettes** (WCAG ratios computed, text on its fill listed; the kit reads `Ui.theme`: see section 11 to apply one)
| Token | cartoony-simulator | sleek-competitive | dark-horror | fantasy-RPG | clean-minimal (light) |
|---|---|---|---|---|---|
| bg (backdrop tint) @ transp. | 1B1030 @0.45 | 0B0E14 @0.35 | 07070A @0.2 | 0E0A06 @0.4 | 11151C @0.35 |
| surface / raised | FFF6E5 / FFFFFF | 141925 / 1E2433 | 121015 / 1C1820 | 2A1E14 / 3A2A1C | FFFFFF / F1F3F7 |
| stroke | 2A1B3D (3-4 px) | 2E3748 (1 px) | 3A3340 (1 px) | D4A64A (trim) | D5DAE3 (1 px) |
| text (on surface) | 2A1B3D 14.8 | F2F4F8 16.0 | E8E2D6 14.7 | F3E6C8 13.1 | 11151C 18.3 |
| subtext | 6B5A7E 5.8 | 9AA4B8 7.0 | 8F8779 5.3 | BFA982 7.1 | 5B6474 6.0 |
| accent / text on it | FFB300 / 2A1B3D 8.8 | 36E3FF / 031318 12.2 | C8A45A / 120E08 8.2 | D4A64A / 2A1E14 7.2 | 2D5BE3 / FFFFFF 5.6 |
| danger / text on it | FF4D4D / 2A1B3D 4.9 | D12F43 / F2F4F8 4.5 | B3202A / E8E2D6 5.2 | C0392B / F3E6C8 4.4 | E5484D / 11151C 4.7 |
| success / text on it | 3DDC84 / 2A1B3D 8.9 | 3DFFA2 / 031318 14.4 | 6FA37A / 120E08 6.6 | 5FAE55 / 2A1E14 5.9 | 2FA36B / 11151C 5.7 |
| display face | FredokaOne | Oswald | SpecialElite | Fondamento | BuilderSans ExtraBold |
- Danger and success are **fills** (buttons, bars, icons) with the text colour listed. As text on the surface, danger is only
  2.8-3.9:1 on every palette and success 1.7 (cartoony) / 3.2 (minimal): use 24 px+ bold, an icon, or a lighter tint (error text
  on dark FF6B7A 6.4:1; on light D63232 on cream 4.5, C62828 on white 5.6).
- Hairline strokes are decoration (1.4-1.6:1 on every palette): controls read through their fill or a 3:1 edge. `bg` tints your
  own full-screen backdrops (loading, scene fades); the kit's window dim is black through `Ui.alpha(0.45)`.
- Kit default theme (a good sleek-neutral): text 15.6, subtext 7.2, accent text 9.7; its danger label is 3.2:1: keep it 20 px bold.

**Rarity** [practice: WoW/Diablo lineage, near-universal in sims, TD and gacha]
| Tier | Colour | On 141925 | Also show |
|---|---|---|---|
| Common | B8BCC6 grey | 9.2 | tier word |
| Uncommon | 4CD964 green | 9.5 | tier word |
| Rare | 3AA0FF blue | 6.4 | tier word |
| Epic | B266FF purple (A74BFF is only 4.3) | 5.2 | tier word + 1 star |
| Legendary | FFB020 gold | 9.6 | tier word + glow |
| Mythic | FF3B6B red-pink | 5.1 | tier word + glow + particles |
| Secret | animated rainbow UIGradient on the stroke, or black with a white stroke | - | tier word + unique frame |
Rarity is always **colour + word (+ shape/glow)**: a 2-3 px stroke on the slot, the tier word in the detail panel and the reveal;
never colour alone (5%+ of players are colour-blind). On light palettes put the tier word on a dark pill (2A1B3D, 4.6-8.7:1),
not on cream. Semantic extras: coins FFC83D, gems 3FD2FF, XP 7CFF6B, warning FFC247, info 4DA3FF (6.7:1+ on 141925); Robux: the
official icon only.

## 4. Screen zones (desktop 1920x1080 under Ui.screen, CoreUISafeInsets)
```
+--------------------------------------------------------------------------+
| top bar: Roblox's own (CoreUISafeInsets already stays out of it)         |
| TL currencies           TC objective / timer / wave           TR feed    |
| L menu column                                       R quest tracker      |
|              CENTRE: keep clear (crosshair, prompts only)                |
| BL chat/inventory (PC)    BC vitals + hotbar          BR actions         |
| thumbstick zone (touch)                              jump zone (touch)   |
+--------------------------------------------------------------------------+
```
| Piece | Anchor, position | Desktop size | Phone (945x415 canvas) |
|---|---|---|---|
| Currency stack | (0,0) at (0,24,0,16) | 240x56 pills, gap 8 | max 2 rows, abbreviated, 200 wide |
| Menu column | (0,0.5) at (0,24,0.5,0) | 80x80 icon + 16-px label, gap 12 | 72x72, no labels, max 4, rest behind "More" |
| Objective / timer | (0.5,0) at (0.5,0,0,16) | 480x56 | 360 wide, one line |
| Feed / toasts | (1,0) at (1,-24,0,16) | 360 wide, 3-5 rows | 300 wide, 3 rows |
| Quest tracker | (1,0.5) at (1,-24,0.4,0) | 340 wide, 3 quests | a 72 icon with a count |
| Vitals | (0.5,1) at (0.5,0,1,-24) | 420x24 under the hotbar | 320x20 above the hotbar |
| Hotbar | (0.5,1) at (0.5,0,1,-64) | <= 720x96 | bottom, <= 5 slots of 72 (392 wide), clear of both thumbs |
| Touch actions | (1,1), relative to JumpButton | 88-110 | 20 px left of / above the jump button, >= 8 px apart |
| Modal window | (0.5,0.5) | `Ui.window` (0.96 + MaxSize) | fills the screen |
On the Hud kit's canvas (1600x900 desktop, 1260x650 phone) shrink widths about 20%, keep text >= 20 and corners 100 px down.
Contextual beats permanent: an "Open" button only near the chest (ProximityPrompt), the hotbar hidden in menus, the HUD hidden in cutscenes.

## 5. Genre blueprints [practice: conventions to adapt, not rules]
Starting layouts from genre convention, not re-verified against current builds: adapt them to the game's loop, theme and art.
- **Simulator** (pets, clicking, strength): currency pills TL with count-up and abbreviations; left column of big square icon
  buttons (Shop, Pets, Rebirth, Quests, Codes, Settings) with red-dot badges; event/boost timers TC; quest tracker R; nothing
  centre. Pet/item inventory: 5-6 columns of 110-120 square slots, rarity stroke, level/"x2" corner tag, equipped check, capacity
  "27/50", Equip Best, multi-delete (locked items exempt), sort by power/rarity. Egg/crate stands: BillboardGui with price, odds
  and an E/tap prompt, then the gacha sequence. Rebirth: before/after multipliers side by side, a cost bar, one big primary
  button. Look: saturated fills, 3-4 px dark outlines, cartoon display face, 3D lip buttons, Back Out motion.
- **Tycoon**: cash TL large (h2) with a "+$120/s" caption; rebirth progress TC; side buttons (Shop, Rebirth, Settings). Buy pads
  in the world: BillboardGui price tag, green when affordable, grey/red when not; toast "New upgrade available"; pads fade in.
- **Obby**: stage counter TC "Stage 37 / 100" + 600x16 progress bar, small RobotoMono timer under it; Robux skip-stage button
  right-middle (24+ px from the jump button), checkpoint toast, confetti on milestones.
- **Battlegrounds / fighting**: moveset hotbar BC, 4 slots 96x96 (key hint 1-4, name, cooldown sweep, ready flash); ultimate
  meter above it (420x14, pulses when full); health bar with damage trail TL or BC; kill feed TR; combo counter centre-right;
  emote wheel (8 slots, radius 180). Phone: moves become a 2x2 cluster or arc left of the jump button (88-100 pt, InputBinding.UIButton
  or ContextActionService touch buttons), labels gone, cooldown sweep stays.
- **Horror**: near-empty HUD, prompts only at interactables, a 5-slot item bar BC (64 px), stamina only while it drains; lobby
  party panel and pre-run shop live outside the run. Death: fade to black 1.5-2 s, one line, "Play again" (slow 0.4-1.0 s fades are
  right here). Look: dark translucent panels, 0-4 radius, serif or typewriter face, desaturated palette, vignette (radial
  UIGradient on a ScreenInsets None screen), one rare accent (candle gold or blood red).
- **RPG / adventure**: TL portrait + level + HP (320x20) / MP / thin 6-px XP bar; quest tracker R (3 quests: icon 32, title 18 Bold,
  objective 16 "3/10" + 6-px bar); minimap TR (220) or compass TC; hotbar BC 8-10 slots of 72. Dialogue box bottom, 1100x220,
  portrait left, name tab, typewriter via `MaxVisibleGraphemes` (30-45 chars/s, click completes, strip rich-text tags), choices
  stacked right (keys 1-4 / D-pad); stats window with +/- allocation and totals.
- **Shooter**: crosshair centre (bloom), hitmarker X 24x24 for 0.15 s (red on kill), damage-direction arcs; ammo BR "24 / 90"
  (h2 32 + caption) + weapon icon; health/armour BL or BC; score + round timer TC in team colours; killfeed TR (max 5 rows, 32
  high, 4-5 s, killer / weapon icon / victim, your lines highlighted); Tab scoreboard (centre, 1100 wide, 40-px rows, K/D/score,
  you highlighted); kill cam and match summary with an XP count-up. Phone: fire 100-120 pt beside jump, an aim/reload/crouch cluster.
- **Social / roleplay**: side column of labelled icon buttons (72x72); a phone/device frame for apps; full-screen avatar/house
  editors with category tabs and a 3D preview; job/team cards; name tags (BillboardGui, distance-limited). Trading: two panes
  (you / them) of 3x3 slots, status chips (Ready / Accepted), two-step confirm with a 3-5 s countdown that resets on any change,
  a warning on uneven value.
- **Racing**: speedometer BR (arc gauge 260 or a 72-px number + unit), gear, nitro bar; position TL "2/8" (display); lap "2/3" and
  timer TC with green/red split deltas; minimap TR on phone (left thumb steers); 3-2-1-GO punch centre; results with a personal best.
- **Tower defense**: unit deck BC (6 slots 110x130: icon, cost, placed "2/4"), cash above it; wave "12/30" + base HP TC; speed
  1x/2x/3x and auto-skip TR; placement ghost with a range circle (green valid / red invalid, T 0.6). Unit panel R (340 wide):
  level, next-level deltas in green (+15% DMG), targeting (First / Last / Strongest / Closest), Upgrade (primary, shows cost),
  Sell (danger, shows refund). Summon banner: art left, rates and pity "Mythic in 43" right, x1 / x10 buttons with costs.
- **Gacha / crates / eggs** (the sequence matters more than the art): 1 confirm: cost, currency, x1/x3/x10, Auto, odds visible
  before paying. 2 anticipation 0.6-1.2 s: the egg shakes with growing amplitude (Sine InOut) or a case strip decelerates (Quint
  Out, 4-6 s) under a rising pitch. 3 reveal: 0.08 s white flash, rarity-coloured rays rotating behind (Linear 360 deg / 6 s), item
  UIScale 0 to 1 Back Out 0.35-0.45 s, tier word in display type, "NEW!" tag, a tier sound (bigger tier, longer tail). 4 skip after
  0.3 s; multi-open: a results grid staggered 60 ms, highest tier last. Paid random items must disclose odds on Roblox [policy:
  confirm the current text before shipping].

## 6. Component specs
- **Window**: `Ui.window` (header 72, title 32 Bold, close 56, body padding 24/16). One primary action, bottom-right;
  destructive left or in a menu. Phone: fills the screen, tabs become a scrollable pill row or icon tabs.
- **Shop**: tabs (Featured, Currency, Passes, Items); a featured banner (full width x 220); cards 200x260 (4 columns in a 980-wide
  `Ui.window`, a one-row sideways strip on phone): icon 55%, name 18 Bold truncated, price row (24-px currency icon + number),
  primary Buy. States: affordable, unaffordable (price in danger colour; tap offers "Need 300 more" with a jump to the currency
  shop), owned (secondary "Equip"), equipped (check + "Equipped"). After purchase: success flash on the card, a sound, the
  currency counts down. Robux items show the Robux icon and use MarketplaceService prompts; the grant happens on the server.
- **Inventory**: 96-120 slots; detail panel right (360 wide) on desktop, a bottom sheet (45% height) on phone; sort and filter
  chips; capacity; lock, equip, multi-select, delete-with-confirm; an empty state with an action ("No pets yet - open an egg").
- **Reward popup**: backdrop 0.45; card 520x560; rays behind a 200-px icon; tier word in display type in the tier colour; primary
  "Claim" 280x72; big rewards never auto-dismiss; several rewards queue one after another.
- **Daily rewards**: 7 cards 120x150 in a row (phone 4 + 3), claimed ones checked and dimmed, today pulsing, "Next in 13:42:10"
  countdown; day 7 bigger and gold.
- **Quest tracker**: completion flashes the row, then a "Claim" pill; max 3 visible, the rest behind "+2".
- **Notifications**: big moments as a top-centre banner (`Hud.toast`); minor ones as a stack (`Hud.feed`, max 3, 3-4 s, newest on
  top, repeats merged "x3"). Badges: 14-16 px red dot on the menu button, a count from 2, "9+".
- **Loading screen** (built in roblox-ui-showpieces): ReplicatedFirst, `RemoveDefaultLoadingScreen()`, ScreenInsets None; mark, tip,
  real progress (join, `PreloadAsync` on the first screen's assets, the player's data); 2 s min, 25 s max, Skip once loaded,
  failed assets never block; a 0.5 s handoff into the title screen.
- **Settings**: Audio (Music / SFX / UI sliders), Graphics, Controls (sensitivity), Accessibility (reduce-motion override, UI scale
  0.8-1.2 multiplying the fit); 64x36 pill toggles, slider tracks driven by `UIDragDetector`; saved through the server.
- **3D preview (garage, character or pet select, an item you inspect)**: a preview bigger than about a quarter of the screen is
  a **stage in the world**, not a ViewportFrame. Build a small set (floor or turntable, backdrop, 2-3 SpotLights: warm key, cool
  fill, a rim from behind) away from the map or inside a closed bay, created on the client so streaming never removes it; set
  `CurrentCamera.CameraType = Scriptable` and orbit the CAMERA around the model (`CFrame.lookAt`, about one turn in 25-30 s; drag
  to spin with inertia; scroll or pinch to zoom); draw the menu around it and leave the middle of the screen empty. The model then
  gets the engine's real rendering: shadows, PBR, Neon glow and bloom, particles, anti-aliasing, at full resolution. Restore
  the camera on leaving. A ViewportFrame has none of that (its own Ambient/LightColor only, no shadows, no post effects, no
  particles) and redraws its whole content every frame something in it or its camera moves: a mech of many meshes orbiting
  in one is blurry and slow, and a second stacked ViewportFrame for a "rim light" doubles the cost.
- **Tooltips**: hover after 0.3 s (mouse), `SecondaryActivated` long-press (touch), on selection (gamepad); max 320 wide,
  AutomaticSize Y. **Confirm**: `Ui.confirm`; destructive: danger-coloured button, gamepad focus starts on Cancel.

## 7. Motion spec (TweenInfo per interaction)
| Interaction | Time (s) | EasingStyle, Direction | What moves |
|---|---|---|---|
| Hover in / out | 0.08-0.12 | Quad Out | colour, UIScale 1.03-1.05 |
| Press / release | 0.06-0.08 / 0.12-0.15 | Quad Out / Back Out | UIScale 0.94-0.96 and back (or lip face down 4 px) |
| Window open / close | 0.18-0.25 / 0.10-0.15 | Back Out / Quad In | UIScale 0.9 to 1 / to 0.92, backdrop fade |
| Side panel / drawer | 0.25 in / 0.18 out | Quint Out / Quad In | Position (AnchorPoint set) |
| Tab / page switch | 0.15-0.2 | Quint Out | UIPageLayout TweenTime, or a content fade |
| Toast in / hold / out | 0.3 / 2.5-4 / 0.25 | Back Out / - / Quad In | Position + transparency |
| Reward pop | 0.35-0.45 | Back Out | UIScale 0 to 1, then an idle bob (Sine InOut 1.2 s) |
| Count-up | 0.4-0.8 (cap 1.2) | Quad Out | NumberValue feeding the label (`Ui.count`) |
| Bar change | 0.12-0.2 (+0.35 trail) | Quad Out | fill, then the damage trail |
| List stagger | 0.02-0.04 each, 0.3 total | Quad Out | fade/slide 8-12 px |
| Error shake | 0.25-0.3 total | Sine | +/- 6 px or +/- 4 deg, 3-4 swings |
| Attention pulse | 0.6 loop | Sine InOut | UIScale 1 to 1.06, one element at a time |
| Countdown digit | 0.4 each | Back Out | UIScale 1.6 to 1 + fade |
| Scene fade | 0.25-0.4 each way | Quad InOut | a full-screen frame's transparency |
Tween UIScale, Position, Rotation, colours and transparency; never the Size of TextScaled labels or the Thickness of text
strokes. Horror is the one genre where 0.5-1 s fades fit. **Reduce Motion** (`GuiService.ReducedMotionEnabled`, or the game's own
switch): snap or swap moves and scales for fades; no shakes, pulses or spinning rays. **Motion** (skill roblox-ui-motion) does it
for every call and has these rows as `Motion.T` tokens; loops live in scopes that stop when the screen closes.

## 8. Sound cues (UI SoundGroup, skill roblox-audio)
| Event | Character | Level |
|---|---|---|
| Button click / tab switch / hover (desktop, optional) | soft click-pop / lighter click / faint tick | 0.4 / 0.3 / 0.15 |
| Window open / close | soft whoosh up / down | 0.3 |
| Purchase success / error | coin "cha-ching" / low dull bonk | 0.6 / 0.4 |
| Reward reveal | tiered: higher tier = higher pitch, longer tail, extra sparkle | 0.6-0.9 |
| Level up / rank up | 1-2 s fanfare | 0.8 |
| Countdown / notification | ticks then a bright "go" / soft ping, max one per 0.5 s | 0.5 / 0.35 |
Debounce UI sounds (one per 50 ms), vary pitch +/-5% on repeats, and never convey anything by sound alone.

## 9. Input rules
- Choose layouts from `PreferredInput` and re-layout on its change signal (not on every input event); the kit's `Ui.onGamepad()`
  is that check (Gamepad or MicroGamepad; older Studios fall back to the last input type).
- **TV / console (10-foot)**: read from 3 m: body text >= 24 design px, labels >= 20, no dense grids (<= 5 columns), text and
  buttons inside the middle 90% (some TVs crop the edges), every control reachable with the D-pad and shown with its glyph
  (`Ui.hint`), B always backs out, no hover-only or pointer-only control. The kits fit 25% (Ui) / 20% (Hud) bigger there.
- **VR** (`VRService.VREnabled`): ScreenGuis show on a flat panel floating in front of the player: keep menus few, large and
  centred, HUD corners don't read; diegetic UI (SurfaceGui on parts) reads better. Not checked by ui_audit.
- Gamepad: select the first button on open only when `Ui.onGamepad()`; `SelectionGroup = true` on grids and panels; explicit
  `NextSelectionLeft/Right/Up/Down` where grid order misleads; A confirms, B closes, L1/R1 switch tabs, X/Y for secondary actions
  (Equip Best, Sell); a `SelectionImageObject` in the accent colour.
- While a menu is open, an `InputContext` for navigation with `Sink` (or ContextActionService binds) keeps gameplay keys quiet.
- Key hints beside actions: `InputActionLabel` (no code) or `GetImageForKeyCode` / `GetStringForKeyCode`.
- Touch: 44 pt minimum, 8 px apart, nothing hover-only; long-press (`SecondaryActivated`) for details; `HapticEffect` UIClick on
  important presses. Keyboard: Escape closes, Enter confirms, 1-9 hotbar, Tab scoreboard, the key shown on the button.

## 10. Accessibility, localization, performance budgets
- **Preferred Transparency**: `panel.BackgroundTransparency = base * GuiService.PreferredTransparency` (official recipe): `Ui.alpha`
  / `Hud.alpha` do it when a panel is built; a panel that lives all session also re-applies on
  `GuiService:GetPropertyChangedSignal("PreferredTransparency")` (disconnect on `Destroying`).
- **Text size**: AutomaticSize + TextWrapped containers so larger text reflows; no TextScaled body text (it ignores the setting);
  MinTextSize >= 9; test at Largest.
- **Reduce Motion**: section 7. **Contrast**: 4.5:1 text, 3:1 large text (24 px regular / 18.7 px bold up) and UI components;
  `ui_audit` warns below 3:1.
- **Localization**: text auto-translates when players enable it; plan about 40% extra width [practice] (AutomaticSize X, flex,
  truncation), no words baked into images, `AutoLocalize = false` on player names, formatted numbers and brand names.

| Budget | Limit |
|---|---|
| HUD GuiObjects | <= 300 |
| An open menu | <= 1500; grids over about 100 items paginate or pool rows |
| UIShadow on screen | <= 100 (Roblox's guidance) |
| CanvasGroup | only during transitions, <= 2 alive, static size |
| ViewportFrame | small and still: one item up to ~256 px that doesn't spin by itself; big or moving previews are a world stage (§6); icons in grids are images [practice] |
| Concurrent tweens | a few dozen; hover states can be styling transitions (native) |
| Label updates | counters at <= 10-20 Hz, never rebuilt per frame |
| Images | upload at 2x display size, reuse spritesheets (ImageRectOffset/Size), preload key art |
Hidden menus: `Visible = false` or `ScreenGui.Enabled = false` (disabled screens neither render nor update).

## 11. Extending the kits
Apply a palette (section 3) to `Ui.theme` before building anything (the kit reads the theme as it builds). `bold` is the face for
titles and buttons, so the display face goes there; the kit's buttons keep their radius of 10. The examples need kit v2 or
later (`Ui.play`, `Ui.shadow`, `Ui.alpha`): replace an older copy in the game first.
```lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Ui = require(ReplicatedStorage.Shared.Ui)

local PALETTES: { [string]: { [string]: string } } = {
	cartoony = { bg = "1B1030", surface = "FFF6E5", raised = "FFFFFF", stroke = "2A1B3D", text = "2A1B3D", subtext = "6B5A7E", accent = "FFB300", accentText = "2A1B3D", danger = "FF4D4D", success = "3DDC84" },
	competitive = { bg = "0B0E14", surface = "141925", raised = "1E2433", stroke = "2E3748", text = "F2F4F8", subtext = "9AA4B8", accent = "36E3FF", accentText = "031318", danger = "D12F43", success = "3DFFA2" },
	horror = { bg = "07070A", surface = "121015", raised = "1C1820", stroke = "3A3340", text = "E8E2D6", subtext = "8F8779", accent = "C8A45A", accentText = "120E08", danger = "B3202A", success = "6FA37A" },
	rpg = { bg = "0E0A06", surface = "2A1E14", raised = "3A2A1C", stroke = "D4A64A", text = "F3E6C8", subtext = "BFA982", accent = "D4A64A", accentText = "2A1E14", danger = "C0392B", success = "5FAE55" },
	minimal = { bg = "11151C", surface = "FFFFFF", raised = "F1F3F7", stroke = "D5DAE3", text = "11151C", subtext = "5B6474", accent = "2D5BE3", accentText = "FFFFFF", danger = "E5484D", success = "2FA36B" },
}
local DISPLAY: { [string]: Enum.Font } = { cartoony = Enum.Font.FredokaOne, competitive = Enum.Font.Oswald, horror = Enum.Font.SpecialElite, rpg = Enum.Font.Fondamento, minimal = Enum.Font.BuilderSansExtraBold }
local RADIUS: { [string]: number } = { cartoony = 16, competitive = 6, horror = 2, rpg = 8, minimal = 12 }

local function usePalette(name: string)
	local theme = Ui.theme :: any
	for key, hex in PALETTES[name] do
		theme[key] = Color3.fromHex(hex)
	end
	theme.bold = Font.fromEnum(DISPLAY[name])
	theme.radius = RADIUS[name]
end
usePalette("cartoony")
```
Reward reveals, loading and title screens, round ends and interaction patterns (sliding tabs, snap carousel, drag and drop
with touch and gamepad alternatives, sheets) are complete in skill **roblox-ui-showpieces**: start there for those.
Styling for big games with many screens [verify in Studio: `SelectorError` empty, the slot hovers]: tokens, a tag rule, a phantom
UICorner and a hover transition in one StyleSheet, so slots need no per-instance colour or corner code. One owner per property:
don't style what the Ui kit already tweens (its buttons) and don't restyle the same property in code. Built-in queries nest like
the Creator Hub's css-comparisons examples (a rule `@ReducedMotionEnabledTrue Frame` parented to the `Frame` rule).
```lua
--!strict
local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local sheet = Instance.new("StyleSheet")
sheet.Name = "GameStyle"
sheet:SetAttribute("Raised", Color3.fromHex("1E2433")) -- tokens are attributes, referenced as "$Raised"
sheet:SetAttribute("RaisedHover", Color3.fromHex("2A3247"))
sheet:SetAttribute("Radius", UDim.new(0, 12))
local slotRule = Instance.new("StyleRule")
slotRule.Selector = ".Slot" -- every instance tagged "Slot"
slotRule:SetProperties({ BackgroundColor3 = "$Raised", AutoButtonColor = false })
slotRule:SetPropertyTransitions({ BackgroundColor3 = TweenInfo.new(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out) })
slotRule.Parent = sheet
local cornerRule = Instance.new("StyleRule")
cornerRule.Selector = "::UICorner" -- a phantom UICorner on every match
cornerRule:SetProperty("CornerRadius", "$Radius")
cornerRule.Parent = slotRule
local hoverRule = Instance.new("StyleRule")
hoverRule.Selector = ".Slot:Hover"
hoverRule:SetProperty("BackgroundColor3", "$RaisedHover")
hoverRule.Parent = sheet
assert(slotRule.SelectorError == "" and cornerRule.SelectorError == "" and hoverRule.SelectorError == "", "bad selector")
sheet.Parent = ReplicatedStorage

local screen = Players.LocalPlayer:WaitForChild("PlayerGui"):WaitForChild("Inventory") :: ScreenGui
local link = Instance.new("StyleLink")
link.StyleSheet = sheet
link.Parent = screen -- one StyleSheet per tree
for _, d in screen:GetDescendants() do
	if d:IsA("GuiButton") and d.Name == "Slot" then
		CollectionService:AddTag(d, "Slot")
	end
end
```

## 12. Polish checklist (before ui_audit and the screenshots)
- [ ] Palette, radius family, stroke recipe and fonts chosen once (section 3); every colour from `Ui.theme`.
- [ ] Every form has its own layout (phone 945x415, upright 487x881 if allowed, tablet, desktop, TV) and the audit is clean on each.
- [ ] Phone canvas (945x415) checked: nothing needs more; left column <= 4 buttons; windows scroll inside.
- [ ] One primary action per view in the accent; secondary neutral; destructive danger-coloured and confirmed.
- [ ] Every interactive piece has hover, press, disabled and selected states, a click sound, HapticEffect on key presses.
- [ ] Every open/close, toast, reward and count animates within the motion table; Reduce Motion snaps.
- [ ] Panels have depth (`Ui.shadow` level 2/3 or a stroke); text over the world has a stroke or a backing.
- [ ] Icons are real images at 2x, ScaleType Fit, one family; no emoji as icons; nothing stretched.
- [ ] Numbers abbreviate and use separators; timers in a monospaced face; names truncate with "...".
- [ ] Empty, loading (server call pending: button disabled + spinner/dots), error and success states exist.
- [ ] Gamepad / TV: first button selected on open, B closes, bumpers switch tabs, the selection highlight is visible, glyph hints.
- [ ] Touch: targets >= 44 pt, action buttons placed relative to the jump button, nothing in the thumb zones.
- [ ] Preferred Transparency and Text Size respected; rarity, team and state never colour-only.
- [ ] Top bar clear (CoreUISafeInsets); a HUD on DeviceSafeInsets keeps its corners below 58 pt.
- [ ] Tried: 20-character names, 999,999,999,999 coins, 0 items, 60 items, German-length strings, a dark and a bright sky behind
      the HUD, death and respawn with menus open.

## 13. Dated or modern (what makes a Roblox menu read 2016 or 2026)
| Dated | Modern |
|---|---|
| Arial/Gotham everywhere, ALL CAPS buttons, TextScaled labels of random sizes | BuilderSans + one display face, a fixed type scale under UIScale, sentence-case labels |
| 2-3 px black borders on every frame (BorderSizePixel) | a hairline Inner UIStroke (or none) and elevation from UIShadow |
| Flat mid-grey or saturated panels, glossy gradients on everything | surfaces from one palette, one accent for the primary action, subtle white-to-85% gradients |
| Square corners, or a different radius per panel | one radius family, nested corners concentric |
| A wall of text buttons; a giant opaque shop over the whole game | icons with short labels; tabs, a detail sheet, the world visible as a stage behind translucent panels |
| Red "X" buttons in every corner | a neutral close, B/Escape, a tap outside; red only for destroying something |
| Instant pop-in, or slow bounces on everything | 0.15-0.25 s ease-out entrances, springs on press and drag, fast exits, one ambient loop |
| One 1080p layout shrunk onto phones; hover-only tooltips | a layout per form (a strip or sheet on phones), long-press and focus show details |
| Numbers jump; a purchase just changes text | numbers count, coins fly into the counter, success and failure answered |

## 14. Amateur mistakes (beyond roblox-ui-design's list)
- Designing on a 1920x1080 monitor only: a 6-button column and a 720-wide hotbar that don't fit a 945x415 phone canvas.
- Shrinking the desktop layout onto a phone with one UIScale fit (a three-column menu at 0.5 scale): text and tap targets fall under 44 pt. A phone gets its own layout (stacked panels, a bottom sheet, one column), built and audited at 945x415 for every screen.
- Mixed spacing (5, 7, 13 px), mixed radii, three display fonts, several accents, all-caps paragraphs.
- Gradients, strokes, glows and shadows on everything: depth for elevation only, glow for the top rarity only.
- Emoji or text glyphs as icons; low-res or stretched icons; icons from different sets side by side.
- Rarity by colour alone; white text on bright fills without a stroke (under 3:1); red or green words as small text.
- Bouncy Back/Elastic easing on everything, including closes and errors; transitions over 0.4 s that block input; or none at all.
- Notification spam (a toast per coin, no queue, merge or cap); permanent buttons for rare actions instead of contextual prompts.
- Hover-only information; close buttons under 44 pt; buttons touching each other on phones; menus with no way out.
- A big spinning model in a ViewportFrame (or two stacked for lighting): low-res, unshadowed and slow; use a world stage (§6).
- CanvasGroup around whole menus for the whole session (memory, blurry text, blank when over the cap).
- `TouchEnabled` as "is a phone" (true on touch laptops) or layouts keyed on `GetLastInputType()`; ignoring Reduce Motion.
- Client-side purchase maths, prices hard-coded in UI scripts, "Owned" shown before the server answered.

## Sources
- Creator Hub (https://create.roblox.com/docs/...): production/game-design/ui-ux-design, ui/styling, ui/styling/css-comparisons,
  ui/appearance-modifiers, ui/position-and-size, ui/animation, production/publishing/accessibility, production/publishing/
  adaptive-design, projects/cross-platform, input, input/mobile, input/gamepad, input/input-action-system; reference/engine/
  classes/{UIShadow, StyleRule, GuiService, UserInputService, InputActionLabel}, enums/{PreferredInput, ApplyShadowMode}.
- DevForum (https://devforum.roblox.com/t/...): full-release-ui-styling-is-officially-released/4275082,
  full-release-stylequery-more-styling-features/4566519, full-release-new-ui-capabilities-shadows-individual-corners/4636263,
  full-release-styling-transitions/4646870, release-notes-for-740/4888724, opt-in-phase-introducing-clipping-support-for-rotated-elements-path2d/4737864.
- Also: the Sept 2026 API dump (UIShadow Mode/Inset/ShowBehindParent, GuiService preferences); device canvases from `ui_audit`'s
  layout engine (src/shared/ui-layout.ts); contrast with the WCAG 2.1 formula. Not verified against live games: every [practice] item.
