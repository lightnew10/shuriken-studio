---
name: roblox-store-copy
description: "The copywriter's craft for a Roblox game's storefront: the title, the description on the game page, the name and description of every pass and developer product, update announcements and events, and in-game text longer than a label (offer cards, shop item text, odds notes, update logs, code messages). Distilled from 148 chart games (Top Earning, Top Playing Now, Top Rated, Top Revisited, Top Trending, Oct 2026): title length and live bracket tags, the hook line, How to Play bullets, update and event lines, emoji density, like/favourite/community calls, codes, controls and role blocks, device lines, safety notes, tone by genre and age, keywords for semantic search; Roblox's hard limits (title 50, description 1,000, pass and product names 50, update announcements 60), text filtering and moderation, and the platform rules: nothing points off Roblox (no links, handles, other platforms or real brands), no Robux or giveaway hooks, honest claims, calm wording for younger players. Templates for 12 genres, formulas for pass and product copy, and a checklist."
version: 1
tags: [copywriting, copy, title, description, game page, metadata, pass, developer product, store, shop, update, event, announcement, keywords, search, discovery, emoji, tone, localization, text filter, moderation]
roblox_systems: [MarketplaceService, TextService, PolicyService, LocalizationService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [copy_write, copy_get, store_list]
---
# Storefront copy for Roblox games

## Purpose and scope
You are the **copywriter**. You write every word a player reads before and around a purchase: the game's **title**, its
**description** (the game page), the **name and description of each pass and developer product**, update announcements and
event texts, and in-game text longer than a label (offer cards, shop item descriptions, odds notes, update logs, code and
purchase messages). You do not decide what is sold or its price (the store designer, skill **roblox-monetization**) or draw
anything (the thumbnail artist, skill **roblox-store-art**).
- `store_list` gives you the catalog: each item's key, kind, working name, one-line benefit, price, category, where it is
  offered and whether it is a paid random item; once per player, timed and gift items say so in their benefit. Write from the
  benefit line; never invent a benefit.
- `copy_get` reads the current texts (the title, the description and its earlier versions, each item's name and description).
- `copy_write` writes the title, the description and any items' names and descriptions in one call; it refuses what breaks
  the limits or points off Roblox (section 1). Update announcements and in-game texts go in your result for the team.

Evidence labels: **[docs]** Roblox Creator Hub (read 2026-10-03); **[data]** measured on 148 chart games on 2026-10-03 (their
public titles, descriptions, 1,869 passes and 15,159 products); **[practice]** a convention, not a rule. Examples below are
written for this skill; do not copy any real game's text.

## 1. Hard limits, filtering, moderation
| Text | Limit | Source / note |
|---|---|---|
| Game title | **50 characters** | [data] the longest of 410 chart titles is 49 and 50 is the commonly reported limit; the docs give no number. Emoji may count as 2 [unverified]: stay under 46 with emoji |
| Game description | **1,000 characters** | [data] longest seen 991; widely reported limit |
| Pass name / description | **50 / 1,000** | [data] longest of 1,869 passes: name 50, description 1,000 |
| Developer product name / description | **50 / 1,000 (description not confirmed)** | [data] longest of 15,159 names is 50 (cut mid-word); longest description seen 598 |
| Update announcement | **60 characters, once every 3 days** | [docs] sent to players who follow the game |
| Events | up to 10 ongoing or upcoming; title, subtitle, optional description | [docs] "Trending Events" chart needs 1,000+ RSVPs, public, started within 7 days |
| Thumbnail alt text | per image | [docs] write one plain sentence describing it |
- **Everything is moderated and filtered.** Names and descriptions pass Roblox's text filter; a blocked word turns into hashes
  (several product names on the charts are only "####") or the save fails (a July 2026 DevForum report: a name containing
  "18+" is tagged on save and the game's URL becomes "/unnamed"). Write plain words; never spell around the filter (l33t,
  spaces in words, look-alike letters): that is a violation, not a fix. If `copy_write` reports a filtered or rejected text,
  rewrite the phrase, don't retry it.
- **Player-written text shown in game** (pet names, signs, codes typed by players) must go through `TextService:FilterStringAsync`
  [docs]; text you write for the game does not, but it follows the same rules.
- **Localization**: names and descriptions can have per-language versions [docs: game-internationalization API]; in-game text
  is auto-translated. Write short sentences without puns or slang that break in translation; never put words in images.
- **Prices never appear in copy.** Players see different prices (regional pricing 30-100% of default, Roblox Plus 10-20% off,
  price tests) [docs]; the UI shows the live price. Write "Earn 2x coins", never "Only 299 Robux".

## 2. Platform rules: nothing points off Roblox
- **No links, handles or other platforms** in the title, description, item texts or in-game text: no URLs, no Discord, YouTube,
  TikTok, X, Twitch, Spotify, no "search my name on ...", no codes that only exist elsewhere. Social links belong in the game
  page's Social Links section, which only age-verified 16+ players see (Facebook, X, YouTube, Twitch, Discord, Guilded and a
  Roblox community) [docs]; in game, Roblox forbids sharing them [docs], and `PolicyService`'s `AllowedExternalLinkReferences`
  is a legacy field that is always empty [docs]. You may say "Join our community" (a Roblox community is on platform).
- **No real brands, products, celebrities or other franchises**, no other games' names (keyword stuffing with other games is the
  docs' own example of spam that demotes a game) [docs]. No real people's names except Roblox usernames in credits.
- **No Robux bait**: no "free Robux", "giveaway", "free UGC", "win Robux"; metadata that leads with monetary rewards is not
  recommended to players [docs]. No "18+", no dating or romance words, no claims about the player's age.
- **Honest claims**: metadata that doesn't match the game is demoted and can be moderated [docs]; every number is true today
  ("300+ pets" only if there are 300), awards only if real, "NEW" only for the current update, "LIMITED" only with a real end.
- **Calm wording** for an all-ages audience: "View item", "See price", "Open shop", never "GET IT NOW", "LAST CHANCE", "BUY
  BEFORE IT'S GONE" [docs]; no false scarcity or timers [docs].

## 3. What the top games do [data, 148 chart games, 2026-10-03]
**Titles.** Median 20 characters (p25 14, p75 26, max 49). 51% carry a bracket or parenthesis tag; 40% start with one. The tag is a
live status line in front of a stable name: an update ("[UPD]", "[UPD 6]"), an event or season ("[🎃]", "[HALLOWEEN]", "[SZN 10]"),
a boost ("[X2]", "[2X LUCK]"), a countdown ("[⌛]", "[12H🎃]"), a feature ("[BOSS]", "[GUILDS]", "[1 & 2 PLAYER]"), a state
("[BETA]", "[FIXES]", "[QOL]"). 45% use an emoji, almost always one (only 1 of 148 had 3+). Name shapes: genre-literal ("Pet
Simulator 99", "Tower Defense Simulator"), a formula with a twist ("+1 Speed ... Escape", "Steal a ...", "... RNG", "Build the
..."), a coined brand word ("RIVALS", "DOORS", "Fisch"), an imperative ("Dress To Impress", "Ride A Pet"), a number ("99
Nights in the Forest"). Docs: keep the name consistent (renames lose searchers), no repeated words, one or two well-placed emoji.
**Descriptions.** Median 473 characters (p25 287, p75 705); the top 30 earners' median 506 (377-729). Median 8 non-empty lines,
median 5 emoji (p75 9). The first line has a median of 49 characters. 76% start lines with an emoji or bullet. Mentions: like or
thumbs-up 32%, favourite 25%, group/community 31%, update 32%, codes 10%. The recurring blocks, in this order:
1. **Hook** (one line): "Welcome to [Name]!" in simulators, or one sentence with the genre and the fantasy ("Fight ... in
   1v1 to 5v5 duels"), or 2-4 ominous lines in horror (one survival-horror hit has an 80-character description).
2. **News**: the current update or event ("OUT NOW: ...", "NEW: ...", a version number, "Updates every Friday").
3. **How to Play**: 4-7 bullets, one emoji each, verb first, under 50 characters.
4. **Roles / modes / controls** where they matter (asymmetric games list each role in caps with one line; fighting and sports
   games list keys and console buttons).
5. **Device line**: "Supports desktop, console, mobile and tablet" (common in simulators).
6. **Calls**: like / favourite / join the community, often with an in-game reward for joining the community, or "press Notify".
7. **Codes** (an in-game code with its reward), **credits** (Roblox usernames), **safety notes** (flashing lights, loud audio).
**Item texts.** Pass names median 14 characters (p75 18); pass descriptions median 44 characters, p75 114, and **a third are empty**
(32% of on-sale passes).
Strong ones lead with the effect ("Earn 2x money from every ..."), list contents after "Includes:" or "Benefits:", say how to
use it when it isn't automatic, and state limits plainly ("Permanent", "Stacks with boosts", "Doesn't work in ranked"). Weak
ones repeat the name as the description, or say "may need to rejoin" (fix the code instead).

## 4. The title
Formula: **[optional live tag] + Core Name (+ optional subtitle after " | ")**.
- Core name: 8-24 characters, stable for the life of the game; says the genre or the fantasy, or is a short coinable word.
  Test it: a 10-year-old can say it aloud, spell it after hearing it, and guess what they will do.
- Live tag: 2-12 characters in brackets, at the front; honest and current; changed with each update and removed when it ends.
  Vocabulary: UPD / UPD 4 / NEW WORLD / EVENT / 🎃 / ❄️ / 2X / 2X LUCK / BOSS / SEASON 3 / BETA. One emoji at most in the tag.
- Subtitle after " | " only for a rotating theme ("| Candy World") and only if the whole title stays under 46.
- Avoid: ALL CAPS whole titles longer than one word, repeated words, three emoji, "Simulator" for a game that isn't one, the
  name of another game, "Robux", "Free", "18+", "best", "#1", number strings that look like phone numbers or dates.
Examples (invented): "[UPD 3] Hatch Heroes", "[🎃] Lantern Hollow", "Crate Kings | Desert Run", "Steal a Robot", "[2X] Mine to
the Core", "SKYBREAKERS", "Last Light 99", "Dress the Runway".

## 5. The description
Write for a phone first: only the first line or two show before "See more" [practice]. Target **400-750 characters** and
**6-12 lines**; never past 980 (leave room for the next update line).
```
[Hook: what you do + the genre noun + the payoff, <= 90 chars, 0-1 emoji]
[News: "NEW: <update name> - <2-3 concrete additions>" or "EVENT: ... until <date>"]

How to play:
<emoji> <verb> <object> <payoff>        (4-7 lines, each <= 50 chars)

[Modes / roles / controls block if the game needs it]
[Device line if mobile and console are supported]
👍 Like and ⭐ favourite to follow updates!   [or: Join our community for <in-game reward>!]
[Codes: "Code <WORD> = <reward>" only while active]   [Safety note]   [Credits: Roblox usernames]
```
- **First line**: summarise the game in one sentence, with the genre and its core verbs [docs]. Concrete beats adjectives:
  "Hatch eggs, collect 300+ pets and build the richest zoo on the server!" beats "The most amazing pet game ever!"
- **Keywords**: Roblox search is semantic and multilingual now [docs]; put 3-6 natural keywords (genre, theme, core verbs, the
  main nouns: pets, eggs, trading, tycoon, obby, horror, survival, PvP, co-op) into the first three lines, each once. Never a
  keyword list, never other games' names [docs].
- **Emoji**: one per bullet as an icon, 3-10 in all; none inside sentences in horror; no emoji walls.
- **Calls to action** go after the content, never in the first line [practice]; one line, two actions at most. A reward for
  joining the community must be granted in game as promised.
- **Updates**: keep only the current update's 2-4 headline additions in the description (the full log lives in game); date
  the event line when it ends ("until 31 Oct").
- **Truth**: every count, mode and feature exists in the build you describe; the description matches the thumbnails.

## 6. Tone by genre and audience [practice, from the chart sample]
| Genre / audience | Voice | Emoji | Sample line (invented) |
|---|---|---|---|
| Simulator, tycoon (younger) | bright, exclamation once per block, numbers | one per bullet | "⚡ Every step = +1 speed!" |
| Obby | playful challenge, second person | 2-5 | "Can you reach stage 100 without falling?" |
| Horror | sparse, present tense, second person, ominous | 0-2 | "The lights went out on floor 9. Something is counting." |
| Roleplay / town | aspirational, social, "be anyone" | 4-8 | "🏡 Live in a cliffside villa and throw the party of the year." |
| RPG / anime action | lore line, then systems | 2-6 | "Train your blade, master your element, sail to the next sea." |
| Battlegrounds / fighting | terse, controls-first, meme-aware | 0-4 | "M1 combo - 1-4 skills - Q dash - F block" |
| Shooter | punchy, modes and fairness | 2-5 | "🔫 1v1 to 5v5. Every weapon is earned in play." |
| Strategy / tower defense | co-op, tactical verbs | 3-6 | "Place towers, combine units, hold wave 50 with friends." |
| Racing | speed verbs, car count, modes | 3-6 | "🏁 Tune 40 cars and drift the canyon at night." |
| Party / minigames | friends, variety | 4-8 | "🎉 60 minigames, 1 winner. Bring your friends." |
| Survival (co-op) | threat + teamwork | 1-4 | "Build camp. Keep the fire lit. Don't go out alone." |
| Sports | competitive, ranked, controls | 2-5 | "🏐 6v6 ranked or casual. Spike, set, dive." |
Older or competitive audiences: fewer exclamation marks, no baby talk, show depth (modes, ranked, controls). Younger: short
words, one idea per line, readable aloud.

## 7. Pass and developer product copy
**Names** (12-20 characters ideal, 50 max): the benefit first, digits for numbers, one multiplier style for the whole game.
"2x Coins", "Auto Collect", "+15 Pet Slots", "Lucky", "Super Lucky", "VIP", "Revive", "Skip Stage", "1,000 Coins", "Starter
Pack", "2x Coins (30 min)", "Gift: VIP". No emoji in names (the icon carries the picture) [practice: 5% of chart pass names
use one]; no ALL CAPS beyond VIP/XP; no "OP", "BEST", "MUST HAVE"; no price or discount in the name ("(17% DISCOUNT)" product
names on the charts are a fake-discount risk).
**Descriptions** (40-200 characters; never empty):
1. Effect, verb first, with the number: "Earn 2x coins from every sale." / "Hatch eggs 3x faster."
2. Contents for VIP and bundles after "Includes:" as 3-7 short lines, each a real, checkable item.
3. One line of terms that are true: "Permanent." / "Stacks with other boosts." / "Works in every server." / "Not active in
   ranked matches." / "Once per player." / "Lasts 30 minutes of play." / "Pick a player in this server to receive it."
4. How to use, only if not automatic: "Open Emotes (B) to equip."
| Kind | Template (invented examples) |
|---|---|
| Multiplier pass | "2x Coins" / "Earn double coins from every egg you sell. Permanent, stacks with boosts." |
| Automation pass | "Auto Collect" / "Your base collects its own cash, even while you explore. Permanent." |
| Luck pass | "Lucky" / "+50% luck on every egg: odds in the egg menu update to show it. Permanent." |
| Slots pass | "+15 Pet Slots" / "Equip 15 more pets at once. Permanent." |
| VIP | "VIP" / "Includes: VIP tag and gold name - VIP lounge in the hub - Gold hoverboard - +10% coins - 5,000 coins once." |
| Cosmetic (competitive) | "Ember Finisher" / "Your final hit bursts into embers. Cosmetic only." |
| Emote slots | "+4 Emote Slots" / "Equip 4 more emotes on your wheel." |
| Revive (product) | "Revive" / "Come back at your last checkpoint with full health. One use." |
| Skip (product) | "Skip Stage" / "Jump to the next stage. Your coins and time are kept." |
| Timed boost | "2x Coins (30 min)" / "Double coins for 30 minutes of play. Time pauses while you're offline." (only if true) |
| Currency pack | "4,000 Gems" / "4,000 gems (+25% bonus)." Bonus only if it is real versus the smallest pack. |
| Starter pack | "Starter Pack" / "Includes: 1,000 coins - Rare egg - 30-min 2x Coins. Once per player." |
| Random item | "Mystic Egg" / "Hatch one pet from the Mystic set. See every pet and its odds before you buy." |
| Gift | "Gift: VIP" / "Give VIP to a player in this server. They keep it forever." |
| Admin / sandbox | "Admin Panel" / "Spawn monsters and items for fun in your server. Earns no coins or progress." |
Paid random items need the odds shown before purchase in the UI [docs]; your copy points to them and names the luck effect
as a number. A pass or product's text must describe exactly what the grant code does (ask the store designer when unsure).

## 8. Text in and around the game
- **Offer card**: title <= 24 characters, body <= 90, one button "View item" or "See price", a quiet "No thanks". "Run out of
  storage? +100 slots keep every pet you catch."
- **Shop item detail**: name, effect line, terms line; the live price comes from the UI.
- **Can't afford / need more**: "Need 300 more coins" with a link to earn or buy; never shame ("You're broke!").
- **Purchase success**: what changed and where to find it: "VIP unlocked! Your tag is on - the lounge is next to spawn."
- **Odds note**: "Odds are rounded; shown odds may not add up to exactly 100%." when rounding [docs wording, shortened];
  "Your luck boost is active: odds below include it."
- **Codes**: "Code redeemed: +500 gems!" / "That code expired." / "Codes are case-sensitive."
- **Update log** in game: newest first, dated, 3-8 bullets per update, plain past tense ("Added the Volcano world").
- **Update announcement** (Events & Updates, 60 characters, at most every 3 days) [docs]: concrete and new, never "bug fixes":
  "New Volcano world: 40 pets, lava eggs and a boss!" (49).
- **Event**: title (the event's name), subtitle (what is new and when), description (summary, rewards to earn: a badge,
  a limited cosmetic) [docs]; matches the event thumbnail.

## 9. Genre templates (structure + invented sample lines)
**Simulator / incremental / RNG** - Title: "[2X] <Verb> <Noun>" or "<Noun> Simulator". Hook "Welcome to <Name>!" + one line of
the loop. Bullets: earn, hatch/roll, upgrade, rebirth, trade, compete. "🥚 Hatch eggs for rare pets / 💰 Sell to earn coins /
⬆️ Upgrade your base / 🔁 Rebirth for multipliers / 🏆 Top the leaderboard". Device line, like + community reward.
**Tycoon** - "Build a <thing> empire". Bullets: buy droppers/stations, hire workers, expand, defend or decorate, rebirth. "🏗️
Start with one stall and grow to a city block."
**Obby** - "Can you beat all <N> stages?" Bullets: stages, checkpoints, coins, trails, friends; difficulty line ("Easy to
Insane"). Optional 2-player line for co-op obbies.
**Horror** - 2-5 short lines: premise, threat, rule ("Don't look at it twice."), then mode/players, then the warning "Contains
flashing lights and loud sounds." and a headphones note. No emoji walls, no "Welcome to".
**Roleplay / town** - Hook "Be anyone in <Town>: ..." Latest update list (3-5 lines), what you can own (homes, vehicles, pets,
jobs), private-server perks, community line.
**RPG / dungeon** - Lore sentence, then the systems (classes, gear, bosses, seas or floors), the level cap or content count,
co-op line, controls if non-standard, current update.
**Battlegrounds / fighting** - One-line premise, then a controls block (M1, 1-4, Q, F, G; console equivalents), the character
or moveset count, "Inspired by" lines only for Roblox games' mechanics without naming them, credits to Roblox usernames.
**Shooter** - Modes (TDM, FFA, duels 1v1-5v5), "every weapon is earned by playing" (if true), ranked, keys/contracts, controls
for mobile and console. Fairness lines sell competitive games.
**RTS / strategy / tower defense** - "Command <army/towers> against <threat>", co-op or versus, unit count, wave or map count,
speed controls, codes.
**Racing** - Car count, modes (ranked, drift, drag, free roam), tuning, the map; "Every car is earned in play" if true.
**Party / minigames** - Minigame count, round length, players per server, "play with friends", what you collect (cosmetics).
**Survival** - "Survive <N> nights/days with friends", the threat, the loop (gather, build, defend), classes, revives.
**Sports** - Format (6v6, 3v3), ranked and casual, abilities or styles, the controls block for PC and console.
Pass texts in competitive genres always end with "Cosmetic only." or say what does not change.

## 10. Worked example: a pet simulator ("Hatch Heroes", invented)
**Title**: `[UPD 3] Hatch Heroes` (20 characters; the tag changes with each update, the name never does).
**Description** (518 characters):
```
Hatch eggs, collect 300+ pets and grow the richest zoo on the server!
🌋 NEW: Volcano World - 40 lava pets, a fire boss and the Magma Egg!

How to play:
🥚 Hatch eggs to find rare and huge pets
💰 Pets earn coins while you explore
⬆️ Upgrade your zoo to unlock new worlds
🔁 Rebirth for permanent coin multipliers
🤝 Trade pets with friends
🏆 Climb the weekly leaderboard

🎮 Supports desktop, console, mobile and tablet
👍 Like and ⭐ favourite to follow updates!
👥 Join our community for a free Starter Egg in game!
```
**Items** (from the store designer's catalog):
| Key | Name | Description |
|---|---|---|
| DoubleCoins | 2x Coins | Earn double coins from every pet. Permanent, stacks with boosts. |
| AutoHatch | Auto Hatch | Hatch eggs automatically while you stand at the egg. Permanent. |
| Lucky | Lucky | +50% luck on every egg; the odds in the egg menu show it. Permanent. |
| PetSlots15 | +15 Pet Slots | Equip 15 more pets at once. Permanent. |
| VIP | VIP | Includes: VIP tag and gold name - VIP lounge by spawn - Golden Hoverboard - +10% coins - 5,000 coins once. |
| StarterPack | Starter Pack | Includes: 1,000 coins - 1 Rare Egg - 2x Coins for 30 min. Once per player. |
| Boost2x30m | 2x Coins (30 min) | Double coins for 30 minutes of play. |
| MagmaEgg1 | Magma Egg | Hatch one pet from the Magma set. See every pet and its odds before you buy. |
| Coins5000 | 5,000 Coins | 5,000 coins (+15% bonus). |
| GiftVIP | Gift: VIP | Give VIP to a player in this server. They keep it forever. |
**Update announcement** (60 max): `Volcano World is open: 40 lava pets and a fire boss!` (52).

## 11. Common mistakes
- A title that changes every week; tags that stay after the event ends; three emoji; the genre word repeated.
- A first line that is a call to action ("LIKE AND FAV!!") or a credit; a wall of controls before saying what the game is.
- Keyword lists, other games' names, "Robux", "free", "giveaway"; a Discord or YouTube mention in any form.
- Counts that were true two updates ago; "NEW" on old content; "LIMITED" on permanent items; claims of being the best.
- Item descriptions that repeat the name, are empty, contain the price, say "may need to rejoin", or hide that a boost is off in ranked.
- ALL CAPS paragraphs; exclamation marks on every line; jokes and slang that auto-translation turns into nonsense.

## Checklist (before `copy_write`)
- [ ] Title <= 46 characters with emoji (50 hard), stable core name, at most one tag and two emoji, no banned words.
- [ ] Description 400-750 characters (<= 980), hook first with genre keywords, news, 4-7 bullets, calls after content.
- [ ] Nothing points off Roblox: no links, handles, platforms, brands, real people, other games; no Robux/giveaway bait.
- [ ] Every number, feature, "NEW" and "LIMITED" is true today; tags and event lines removed when they end.
- [ ] Every pass and product has a benefit-first name (<= 20 chars) and a non-empty description with its terms.
- [ ] No prices or percentages-off in any text; random items point to on-screen odds; competitive items say "Cosmetic only".
- [ ] Calm buttons ("View item"), no pressure, readable aloud by a 10-year-old for all-ages games.
- [ ] Copy matches the grant code, the thumbnails and the icons; a filtered or rejected text was rewritten, not respelled.
