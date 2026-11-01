---
name: roblox-store-art
description: "The thumbnail artist's craft for a Roblox game's storefront: five 16:9 thumbnail candidates staged in Studio from the game's own models (thumb_shot) and finished with text, gradients, glows and outlines drawn as Roblox UI draws them (thumb_compose), then judged by elimination (thumb_pick); the 512x512 game icon; and one consistent icon set for every pass and developer product (store_icons: same frame, background, light and treatment, the subject a game model drawn with an outline or a line-art glyph, safe inside the circle Roblox crops to). What the chart thumbnails and icons did on 2026-10-03 (one focal subject, scale contrast, emotion, value numbers, 0-4 words, outlines, measured saturation, brightness and contrast, countdown icons), the sizes and safe areas (1920x1080, bottom kept clear of the player-count overlay, icons shown down to 150 px, pass icons in a circle), Roblox's rules on misleading thumbnails and videos, thumbnail personalization (2-5 active), composition recipes for 12 genres, and the judge's elimination criteria (honesty, readability at 160x90, focal clarity, genre clarity, contrast, consistency)."
version: 1
tags: [thumbnail, icon, game icon, pass icon, product icon, store art, key art, composition, camera, lighting, text, outline, glow, gradient, contrast, color, readability, personalization, a/b test, genre, judge, elimination, safe area, circle crop]
roblox_systems: [Camera, Lighting, Atmosphere, ColorCorrectionEffect, BloomEffect, DepthOfFieldEffect, UIStroke, UIGradient, UIShadow]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [thumb_shot, thumb_compose, thumb_pick, store_icons, store_list]
---
# Store art for Roblox games: thumbnails, the icon, and the item icon set

## Purpose and workflow
You are the **thumbnail artist**. You make the game's thumbnails (five candidates, the best picked by elimination), its icon,
and the icons of every pass and developer product as **one consistent set**. You don't decide what is sold (skill
**roblox-monetization**) or write the store text (skill **roblox-store-copy**); you read both through `store_list`.
1. `store_list`: the catalog (each item's category, hue and icon subject) and the title; the game's genre and its current
   update are in your context (the project and its spec).
2. `thumb_shot` x 5+: staged Studio captures (camera position, look-at, `fov`, `outline` on the subjects, UI hidden) of the
   game's real models and places.
3. `thumb_compose`: layer each shot with text, gradients, glows and outlines, drawn the way Roblox UI draws them (UIStroke,
   UIGradient, UIShadow-style glows, Roblox fonts), so nothing on the image is something the engine couldn't show.
4. `thumb_pick`: a judge eliminates candidates round by round (section 9). Keep the winner and the runner-ups.
5. The icon (section 10), then `store_icons` for the item set from one shared template (section 11).
Evidence labels: **[docs]** Roblox Creator Hub (read 2026-10-03), **[data]** observed on chart games on 2026-10-03 (36 thumbnails
and icons looked at, 120 thumbnails measured, 12 games' pass-icon sets), **[practice]** a convention, not a rule.

## 1. Sizes, formats and safe areas
| Asset | Size | Rules |
|---|---|---|
| Thumbnail (image) | **16:9, 1920x1080** ideal; other ratios are stretched to 16:9 [docs] | .jpg .gif .png .tga .bmp; **under 3 MB** for Home personalization [docs]; up to 10 images or videos per game [docs]; each has alt text [docs] |
| Safe area | keep faces, text and the subject out of the **bottom 20%** and 4% from each side [practice] | Roblox: essential text or elements at the bottom "may" be covered by metadata such as the player count [docs] |
| Thumbnail video | gameplay capture | 3 uploads a month; real gameplay only; not shown on Xbox, PlayStation or VR [docs]; rules in section 3 |
| Game icon | **512x512** square [docs] | scaled down to 150x150 and smaller in places: preview it small [docs]; one per locale [docs]; tiles round its corners [practice] |
| Pass / product icon | **up to 512x512**, .jpg .png .bmp [docs] | shown in a **circle**: nothing important outside it [docs]; required for promoted passes and externally sold products [docs] |
| Event thumbnail | 16:9 | a unique event image beats reusing the game's (falls back to the primary thumbnail) [docs] |
Test every thumbnail at **160x90** (a phone's home tile) and **320x180** (a desktop tile) [practice], and every icon at 150 and
48 px. Upload PNG for hard edges and text [practice].

**Personalization [docs].** With 2+ active thumbnails Roblox shows each to random players, then gives each group of players the
one that earns the best qualified play-through rate (players who click and stay); averages +8.5% (some +50%); Roblox staff
measured +12% on average in Feb 2025. Keep **2-5 active**, test a new set with each major update, don't change it again for at
least 7 days, and make the candidates differ in motivation, not in small details [DevForum staff tips, Feb 2025]. Play-through
rate is the most important Home recommendation signal and quick bounces count against the game [docs]: a thumbnail that
over-promises loses on both.

## 2. What the chart thumbnails did [data, 2026-10-03]
1. **One focal subject, big**: a character with one object (an egg, a weapon, a fish), or one creature, filling 35-60% of the
   height, on a third, facing into the frame. No collages.
2. **A second element for scale or story**: a tiny avatar under a giant egg, a boat under a whale's jaws, a sleeper beside a
   fire with a monster behind, a forge turning +1 into +1T. Cause and effect readable left to right, often with a curved arrow.
3. **Emotion on a face**: shocked, smug, terrified or determined avatars; open mouths; exclamation marks over a head.
4. **Value numbers in simulators**: a huge money-per-second figure, "1 in 9,342,584" odds, "+1" pop-ups, "SECRET" rarity labels.
   At 160x90 those numbers stop reading; the subject still has to carry the tile.
5. **0-4 words or a logo wordmark**: "NEW", "SOLD", "IN COMBAT", a title logo; white or yellow text with a thick dark stroke and
   a top-to-bottom gradient; logos sit in a corner. Many put the logo low, despite the bottom-overlay warning.
6. **Outlines and rim light** separate the subject from the background: white or black outlines on simulator art, coloured rim
   light on action art; motion lines, impact flashes and particles for action.
7. **Measured colour** (HSV mean of the whole image): top-earning thumbnails saturation median 0.44 (p25 0.31, p75 0.56),
   brightness 0.64 (0.48-0.78); up-and-coming (new) games are brighter and more saturated (0.60 saturation, 0.75 brightness);
   luminance standard deviation (contrast) 0.23 in every group (p25 0.20, p75 0.27). Horror sits darker, never flat.
8. **Genre at a glance**: shooters show the gun or two duelists on clean, high-key maps; battlegrounds and anime RPGs use
   illustrated, anime-graded fighters; horror is one warm light in darkness; simulators are blue sky, green grass, yellow-orange
   hero objects.

## 3. Honesty and Roblox's rules
- **Show the game**: thumbnails must be relevant and match what players get; mismatched metadata and content is not recommended
  and ranks lower in search, and misleading videos are rejected [docs]; the Community Standards also bar misleading metadata
  used to drive discovery or spending (read through a search summary). A thumbnail of dinosaurs on a game without dinosaurs is
  the docs' own example. Use `thumb_shot` of the real build, then add only overlays.
- **Videos** may use cinematic cameras, highlight sequences, light brightness/contrast and the game's logo; they may not show
  mechanics or UI that don't exist, enhance graphics beyond what players see, use outside footage, voice-over, narration or
  music with lyrics, or ad text and subjective claims ("50% off", "Free UGC!") [docs].
- **Never**: Robux icons or promises, "free", giveaways (metadata leading with monetary rewards is demoted) [docs]; fake buttons
  or play icons; other games' characters or look-alike art (non-unique metadata is demoted) [docs]; real brands, logos of other
  platforms, real people; realistic violence, blood or crude humour (uploaded images are moderated for these whatever the game's
  maturity label [docs: content maturity]; even a Restricted game's public page and thumbnails must suit all ages [help centre,
  Restricted Content Policy]); a rarest item shown as if guaranteed.
- **Allowed** [docs/practice]: free-camera angles (Shift+P in a solo playtest), post-processing that doesn't fake fidelity
  (ColorCorrection, Bloom, DepthOfField), staged poses and arranged scenes of real assets, the game's logo, a few words.

## 4. Staging a shot (thumb_shot)
- **Hide everything that isn't the scene**: UI, nameplates, chat bubbles, leaderboards, debug parts.
- **Camera** (`fov`): 30-45 for heroes and close-ups (flattering, little distortion), 50-70 for worlds, 80+ only for speed. Hero
  shots from slightly below (camera at waist height, 10-20 deg up); bases and armies from 30-45 deg above; horror at eye level.
  `look-at` the subject's face or the object's centre; put it on a third, not dead centre (icons are the exception).
- **Pose**: the peak frame of the core action (top of a jump, the swing's contact, the hatch's flash), never a T-pose or idle.
  Faces: the most expressive face the avatar can wear (surprised, laughing, scared); characters look toward the action.
- **Light**: a key light 45 deg from the camera side, a rim from behind in a contrasting hue (warm key / cool rim or the reverse),
  Lighting.Brightness up 10-20% for bright genres; Atmosphere for depth; ColorCorrection Saturation +0.1 to +0.2 at most.
- **Depth**: foreground element out of focus (DepthOfField near), subject sharp, background lighter or hazier.
- **Outline** (`outline`: the subjects' instance paths, `outline_color`): a Highlight on each subject for this picture only,
  white for bright scenes, near-black 1C1C2E for light backgrounds. It is the shot's outline; compose adds none.
- Take 3-5 angles of each candidate idea; keep the cleanest.

## 5. Composing (thumb_compose)
Layer stack, bottom to top: the shot -> grade (vignette 15-35% for depth, never a fake filter) -> a radial glow (UIShadow-style,
the accent hue, 30-50% opacity) behind the subject (outlined in the shot by `thumb_shot`'s `outline`) -> effects (speed
lines, sparkles, arrows) -> text.
- **Text**: 0-4 words, upper half, on the side opposite the subject. Cap height >= 11% of the image height (>= 120 px at 1080) so
  it survives a 320x180 tile; numbers bigger still, and accept they vanish at 160x90.
  Fill white or a 2-stop UIGradient (light top, saturated bottom: FFF6A8 -> FFB300); UIStroke Contextual 8-14 px in a dark hue
  of the palette (2A1B3D, 1C1C2E); an offset shadow (0, 6-10 px) at 40-60%; rotate -4 to -8 deg for energy in action and
  simulator art. Fonts that Roblox renders: FredokaOne, LuckiestGuy, DenkOne (simulators, tycoons, party), Bangers (action,
  battlegrounds), Oswald or Michroma (shooters, racing, sci-fi), SpecialElite or Creepster (horror, sparingly), Fondamento (fantasy).
- **Logo**: the game's wordmark only if it reads at 320x180; 18-28% of the width, upper-left or upper-right.
- **Contrast**: subject vs background luminance contrast >= 3:1 where they meet [practice from WCAG]; image luminance standard
  deviation >= 0.18 (charts: 0.20-0.27).
- **Never inside the bottom 20%** for anything that must be read (section 1).

## 6. The five candidates: five motivations
Make each candidate answer a different "why would I click?", as Roblox's staff advise for personalization [DevForum]:
| # | Motivation | The picture |
|---|---|---|
| 1 | **Hero action** | the player doing the core verb at its peak frame (the jump, the swing, the drift) |
| 2 | **Reward / value** | the rarest real item, pet or car glowing, with its value or rarity ("SECRET", "1 in 50,000", "$1.2M/s") |
| 3 | **Threat / challenge** | the boss, monster or hardest stage, big, with an avatar reacting |
| 4 | **Social** | 3-5 avatars together or against each other in one funny or tense moment |
| 5 | **World / update** | the newest area or event theme, wide, with the update word if it is true ("NEW WORLD") |
For a horror game, 2 becomes "the mystery" (a half-seen thing); for a competitive game, 2 becomes "status" (the rarest skin).

## 7. Composition recipes by genre
| Genre | Camera and subject | Light and palette | Text / type |
|---|---|---|---|
| Simulator / RNG | low 3/4 hero holding or riding an oversized rarest pet/egg; a tiny rival or crowd for scale; an arrow from action to reward | high-key sky blue, grass green, a yellow-orange hero object; white 10 px outlines; sparkles | a giant value number or rarity word; FredokaOne / LuckiestGuy |
| Tycoon | 30-45 deg aerial of the base at its richest stage; the owner in the front corner celebrating in a rain of cash | warm gold and green; clean daylight | "+$" counter or one word; DenkOne |
| Obby | wide view down a long colourful course; the avatar at the top of a jump over lava or void | neon parts against a deep sky; strong diagonal | "STAGE 100" or none; LuckiestGuy |
| Horror | eye-level; a frightened avatar lit by one warm source (flashlight, fire); the monster large in the shadow on the other third | brightness 0.2-0.4, cool desaturated with one warm accent; vignette 35% | 0-2 words, off-white or blood red; SpecialElite; no emoji-bright colours |
| Roleplay / town | golden-hour shot of the dream house or car with 2-3 styled avatars posing in front | warm, soft, aspirational; lifestyle colours | logo only, small; FredokaOne |
| RPG / dungeon | hero and boss on a diagonal with an elemental clash between them | opposing rim lights (orange vs blue), particles, haze | title only; Fondamento or Bangers |
| Battlegrounds / fighting | two fighters at the impact frame, Dutch angle 10-15 deg, white impact flash and speed lines | anime grading, high contrast, saturated skill VFX | the logo; Bangers |
| Shooter | first-person signature weapon firing (lower right) with muzzle flash, or two duelists facing off | clean high-key map, team colours (red vs blue), crisp shadows | none or one word; Oswald / Michroma |
| RTS / strategy / TD | 40 deg overview of two coloured armies or a tower line; one giant unit or tower in the foreground | clear colour coding per side; readable silhouettes | "WAVE 50" or none; Oswald |
| Racing | low front 3/4 of the car at speed, background motion blur, drift smoke, headlights | night neon city or sunset canyon; car paint saturated | none or the car class; Michroma |
| Party / minigames | 4-6 avatars mid-chaos (falling, laughing) around the minigame's object | primary colours, bright, round shapes | "60 MINIGAMES" if true; FredokaOne |
| Survival (co-op) | the group around a campfire or barricade at dusk; the threat at the edge of the light | warm centre, cold edges | title only; Bangers or SpecialElite |
Sports follow racing (the athlete mid-action, low angle, the ball close to the lens).

## 8. Small-size truths [data + practice]
- At 160x90 only the subject's silhouette, the largest word and the dominant colour survive: design for that.
- One idea per tile: two subjects of equal size read as none.
- Faces read; hands and weapons read; tiny UI, small numbers and thin outlines don't.
- A tile is seen beside 6-12 others: a hue that differs from the genre's usual palette stands out (check against chart neighbours).

## 9. Judging by elimination (thumb_pick)
The judge looks at the five finished candidates and eliminates, round by round, writing one reason per elimination.
**Round 0, gates (any failure is out, however good it looks)**: shows only things in the game; no fake UI, Robux, "free",
brands, real people, other games' characters or links; 16:9 at 1920x1080; nothing essential in the bottom 20%; text <= 4 words.
**Round 1, tiny (160x90, then greyscale)**: can the subject be named in one second? Is its silhouette clear without colour? Is
luminance contrast >= 0.18? Eliminate the two weakest.
**Round 2, medium (320x180, as if beside the genre's chart thumbnails)**: is the genre obvious to a 10-year-old? Does it stand
out from its neighbours? Is the text readable? Eliminate one.
**Round 3, full size**: emotion and action, a story in one glance (cause -> effect), polish (clean cut-outs and outlines, no
artefacts), consistency with the icon and the game's colours. The better one wins.
Scores per criterion: 0 fails, 1 ok, 2 strong. Ties break in this order: focal clarity > honesty > genre clarity > contrast >
emotion > consistency. Upload the winner as the first thumbnail and keep the runner-ups active for personalization (2-5 in all).

## 10. The game icon (512x512)
- **One thing, close**: the mascot's or hero's face, or the signature object, filling 70-85% of the square; plain or radial
  background in the brand colour; the same subject style and outline as the thumbnails.
- **Words**: none, or the logo / a 1-2 word title if it reads at 150 px. Test at 150 and 48 px and in greyscale.
- **Distinct**: a hue and silhouette unlike the chart neighbours in the same genre; keep it recognisable across seasons (same
  mascot and colour, seasonal props added).
- **Live icon [data]**: 8 of the 36 chart icons on 2026-10-03 were update countdowns (an hourglass, most with "12 HOURS",
  "24 HOURS", "6 HOURS" or "SOON"), three more carried "NEW", "LIVE" or "CHAPTER 2". Use a countdown only for a real, scheduled update with the
  true time left, switch to "NEW" at launch, and return to the brand icon within about two weeks [practice].

## 11. The pass and product icon set (store_icons)
Strong sets on the charts share one template and vary only the subject and hue [data]: one shows a glossy object on a radial
burst in a per-item hue, another a gold ring on violet with a coin motif, another a badge seal with a curved label, another a
black disc with a bold yellow glyph, another an object with an "x2" corner chip. Weak sets are text-only discs or scene
screenshots: unreadable at shop size.
**Template (512x512, everything inside the inscribed circle)**:
| Layer | Spec |
|---|---|
| Background disc | radial gradient in the item's category hue: centre +15% lightness, edge -25%; or a 12-16 ray sunburst at 8-12% contrast |
| Frame ring | 16-24 px; an 8 px dark outer line + a bright inner band (gold for premium and VIP, white for the rest); identical on every item |
| Subject | centred in a 300-360 px box (60-70%); key light from the upper left, rim from the right; outline 8-12 px white + 4 px dark outside it |
| Modifier chip (optional) | "x2", "+15", "∞", "1,000" at the 4-5 o'clock position inside the circle, 120-150 px, display font, dark stroke |
| Text | none besides the chip; the name is beside the icon in every shop |
Safe zone: the subject and chip stay inside a **400 px circle** (78%); the ring may touch the 512 circle; corners are cut [docs].
**Subjects.** Things the player can see in the game (pets, weapons, cars, eggs, coins, houses) are **the game's own models**,
rendered by `store_icons` with the outline. Abstract perks get **line-art glyphs**: auto-collect = circular arrows, luck = clover,
skip = fast-forward, revive = heart with a plus, slots = grid of squares, speed = lightning or a gauge, emotes = a dancing hand,
radio = boombox, VIP = crown, private server = key or door, admin = gavel, timed boost = hourglass with the multiplier chip.
**Hues** come from the store designer's categories: each item's `hue` in `store_list` (or given to `store_icons`), placed by
the template wherever it says "{hue}" (the disc's gradient, the chip) (currency gold FFC83D, luck green 3DDC84, speed cyan 36E3FF, VIP gold with
violet, revive red FF4D4D, skip blue 4DA3FF, cosmetics pink, gifts magenta, boosts orange).
**Families**: a currency ladder grows its subject (a pile, a bag, a chest, a vault) with the amount on the chip; a timed boost
repeats the pass's icon with an hourglass chip; a gift twin repeats the original with a ribbon; a random egg or crate shows the
egg itself with a "?" glow, never the rarest prize as if guaranteed.
**Acceptance (all must pass)**: same ring, background type and light direction on every icon; outline width within 10%;
subject scale within 10%; one hue per category; every icon readable at 100 px and distinguishable from every other at 48 px
(silhouette, hue or chip); nothing outside the 400 px circle except the ring.

## 12. Worked example: a pet simulator ("Hatch Heroes", invented)
Candidate 2 (reward), end to end:
```
thumb_shot   camera: 6 studs in front of the avatar, 1.2 studs above the floor; fov: 38
             outline: the griffin and the avatar (white)
             look-at: the Golden Griffin pet's chest (the rarest real pet, scaled x3 by its in-game "Huge" variant)
             scene: the avatar on the left third, arms up, surprised face; the griffin rising on the right third out of a
                    cracked egg; hatch flash particles at peak; Lighting.Brightness +15%; rim light cool cyan from behind
             UI hidden; 3 angles; keep the one where the griffin's wings make a clear V silhouette
thumb_compose
  grade      vignette 20%; ColorCorrection saturation +0.12 (already in the shot)
  glow       radial, FFB300 at 45%, behind the griffin, radius 40% of the height
  effect     curved arrow from the egg to the griffin, white with dark stroke; 12 sparkles
  text       "HUGE GRIFFIN" upper-right, cap height 13%, FredokaOne, gradient FFF6A8 -> FFB300, stroke 12 px 2A1B3D, rotate -6 deg
  check      bottom 20% empty of text and faces; luminance sd 0.24; saturation 0.52
```
The other four: the avatar mid-sprint on a speed lane with "+1" pops (hero action); a giant boss-egg towering over four players
(threat, scale); four friends trading with pets between them (social); the new volcano world wide with "NEW WORLD" (update).
An illustrative judgement: the trading scene falls at 160x90 (four equal subjects), the speed lane at 320x180 (it looks like
three chart games beside it), the boss-egg in the final round (no face, less emotion); the griffin wins and the volcano stays
active beside it for personalization.

## 13. Refresh cadence
- New set of candidates with every major update or event (Roblox staff: a fresh thumbnail alongside new gameplay boosts
  discovery) [DevForum]; keep the evergreen winner active beside the new ones.
- The event thumbnail (Events & Updates) is its own image, not the game's [docs]; the countdown icon only while a real countdown runs.
- Seasonal dressing (snow, pumpkins) is added to the real scene in Studio before `thumb_shot`, never painted on afterwards.
- Item icons: a new item reuses the template the same day; a template change re-renders the whole set at once.

## 14. Common failures
- A screenshot of the spawn area with the HUD on; a T-pose; a character facing away; the subject in the dead centre and small.
- Two to four subjects of equal size; a collage of features; text over the subject's face; five words or a sentence.
- Thin outlines and small numbers that vanish at 160x90; text or the logo in the bottom 20%.
- Painted art that shows things the game doesn't have (demoted, and the bounce rate punishes it anyway) [docs].
- A brown-grey or uniformly dark image with luminance sd under 0.15; a palette identical to the genre's top game.
- Item icons that are screenshots, text-only discs, mixed styles from different sources, or important parts outside the circle.

## Checklist
- [ ] `store_list` read: genre, catalog hues and subjects, current update; the style matches the game's maturity and tone.
- [ ] Five candidates, five different motivations, all from real `thumb_shot` captures; UI hidden; peak-frame poses.
- [ ] Composed text <= 4 words, cap height >= 11% of the height, dark stroke, upper half, nothing essential in the bottom 20%.
- [ ] Colour: luminance contrast >= 0.18, subject separated by outline or rim light, palette right for the genre.
- [ ] `thumb_pick` gates passed (honesty, policy, size), rounds at 160x90, 320x180 beside chart neighbours, and full size.
- [ ] Winner uploaded first, 2-5 kept active for personalization; no change for 7 days.
- [ ] Icon: one close subject, readable at 150 and 48 px, brand colour; countdowns only when true.
- [ ] Item icons from one `store_icons` template, inside the 400 px circle, one hue per category, all pass the acceptance list.
