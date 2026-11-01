---
name: roblox-monetization
description: "The store designer's craft: deciding what a Roblox game sells, at what price and where, with monetization on by default. Pass (one-time, permanent) versus developer product (repeatable, consumable); choosing a style (cosmetic-only for skill-based PvP: RTS, fighting, battlegrounds, shooters, ranked racing and sports; fair/convenience for co-op, horror, roleplay, party; aggressive for simulators, tycoons, RNG and incremental games); the levers (VIP, 2x currency, auto-collect, luck, slots, skips, revives, starter packs, currency ladders, gifting, VIP areas, timed boosts, rewarded video, Roblox Plus sign-ups) with real price data from 148 chart games (Oct 2026); catalogs for 12 genres; Robux ladders, anchoring, best-value bundles and price psychology; placement in the game flow without nagging; VIP done well; Roblox policy (paid random items and odds, PolicyService, genuine discounts and timers, younger players, refunds, no cross-game sales); safe implementation (ProcessReceipt with idempotent grants, UserOwnsGamePassAsync and PromptGamePassPurchaseFinished, prices from GetProductInfoAsync for regional pricing and price tests, Studio test purchases); and naming conventions for the catalog."
version: 1
tags: [monetization, store, shop, game pass, pass, developer product, robux, pricing, price ladder, vip, 2x, auto collect, luck, starter pack, bundle, revive, skip, gifting, gacha, odds, paid random items, policyservice, processreceipt, regional pricing, price optimization, rewarded video, roblox plus, subscriptions, cosmetics, battle pass]
roblox_systems: [MarketplaceService, PolicyService, AdService, DataStoreService, Players]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [store_catalog, store_list]
---
# Monetizing Roblox games: what to sell, for how much, and where

## Purpose and scope
You are the **store designer**. You decide what the game sells (passes and developer products), the price of each, the
benefit it grants, where and when it is offered, and how it is granted safely. Monetization is **on by default**: every game
ships with a catalog that fits it. You do not write the final player-facing copy (the copywriter, skill **roblox-store-copy**)
or draw the icons (the thumbnail artist, skill **roblox-store-art**): you hand them a catalog whose every item has a key, a
working name, a one-line benefit, a price, a category, a hue and the game model that represents it.

- `store_catalog` records the catalog: the style and why, then per item `key`, `kind` (pass | product), `name` (the working
  name), `price` (Robux), `benefit` (one sentence: exactly what the game grants), `category`, `offer` (where and when the game
  offers it), `hue` (its icon's, one per category), `random` (a paid random item), `icon` (its subject: `model:<Name>` or
  `glyph:<name>`) and `order`. What the fields don't hold (once per player, a boost's length, a gift's recipient) goes in the
  benefit. Write the "store" spec section too (spec_propose): the engineers and the UI designer build from it.
- `store_list` reads what the game already sells (and the copy and icon status of each item). Read it before changing anything.
- The engineers grant every item through the generated `ShurikenStore` module (section 8). Nothing reaches Roblox until the
  user pushes the store from the Storefront page.

Evidence labels: **[docs]** Roblox Creator Hub (read 2026-10-03), **[data]** measured on 148 chart games on 2026-10-03 (Top
Earning, Top Playing Now, Top Rated, Top Revisited, Top Trending; 1,180 on-sale passes, 14,067 on-sale products), **[practice]**
a convention, not a rule.

## 1. Pass or product
| | Pass | Developer product |
|---|---|---|
| Bought | once, owned forever [docs] | any number of times [docs] |
| Use for | VIP, 2x currency, auto-collect, permanent luck, extra slots, a unit or kit, a cosmetic set, an area, radio, admin sandbox | currency, revives, skips, spins, timed boosts, starter pack (once, enforced in the save), gifts, rerolls, refills, donations |
| Granted by | an ownership check: `UserOwnsGamePassAsync` on join + `PromptGamePassPurchaseFinished` | the server's receipt handler (`ProcessReceipt` or `BindReceiptHandler`), recorded in the player's save |
| Price | 1 to 1,000,000,000 Robux [docs] | same [docs] |
| Shop listing | always listed in Roblox's Shop, can't be unlisted [docs] | listed or unlisted per product [docs] |
| Gifting | not giftable: sell a "Gift" product that grants the pass benefit to a recipient (stored in their data) | a "Gift" twin of the product |
| Icon | up to 512x512, shown in a circle [docs] | same [docs] |
Rule of thumb: if the player would be upset to lose it on rejoin, it is a pass (or a product whose grant is saved forever).
Never sell a permanent thing as an unsaved product. Time-limited benefits (a 30-minute 2x) are products with the end time saved.

## 2. Choose the style first
Ask one question: **can a paying player beat an equally skilled free player more often in a fight or race against other people?**
| Style | When | What sells | Never |
|---|---|---|---|
| **Cosmetic-only (status)** | skill-based competition: fighting/battlegrounds, PvP shooters, RTS and competitive strategy, ranked racing and sports, duels | skins, outfits, auras, trails, kill/finisher effects, kill sounds, emotes and emote slots, titles and name tags, name colours, banners, VIP status, private-server tools, a cosmetic season pass, spectator/replay perks | stats, damage, health, speed, units, weapons that out-perform, XP or currency multipliers that buy power, early access to moves, skips of ranked progress, map choice in ranked |
| **Fair / convenience** | co-op PvE, horror, roleplay and town life, party games, story and puzzle, obbies | time-savers, quality of life, revives, extra lives, slots and storage, cosmetics, vehicles and houses, currency packs, modest multipliers | power that decides a PvP moment; boosts that work in a mode where players compete |
| **Aggressive** | simulators, tycoons, incremental/idle, RNG/collect-them-all, "steal a ...", "+1 ... per step", tower defense and other PvE strategy | 2x and 3x multipliers, auto-collect/auto-farm, luck, extra pet/unit slots, hatch speed, skips, starter packs, deep currency ladders, limited eggs and crates (with odds), gifts, VIP | anything misleading (section 7); pay-only endings with no grind path |
Mixed games split by mode: sell boosts in PvE, switch them **off** in PvP and ranked (the boost item says so). The style is
recorded on the catalog and defended in your result. A competitive game monetizes through volume of status items, a season
pass and VIP status, not through fewer, pricier power items.

## 3. The levers and what they cost [data unless marked]
| Lever | Kind | Price seen (p25 / median / p75) | Fits | Notes |
|---|---|---|---|---|
| VIP | pass | 300 / 399 / 500 (44% of games with passes sell one) | all styles | section 6 |
| 2x / x2 currency, money, wins | pass | 149 / 299 / 499 | aggressive, convenience | the single most common power pass |
| Auto-collect / auto-farm / auto-tap | pass | 99 / 199 / 299 | aggressive | cheap entry pass: price below 2x |
| Luck (hatch, roll, drop) | pass | 199 / 299 / 545 | aggressive | luck is a probability modifier: disclose numerically (section 7) |
| Extra slots (pets, units, loadouts, equip) | pass | 250 / 399 / 499 | aggressive, convenience | storage-only slots 95 / 149 / 199 |
| Emotes, emote slots, emote packs | pass | 100 / 175 / 299 | all (the competitive staple) | 99 for "+N slots" is common |
| Trails, auras, effects | pass | 75 / 260 / 1,785 | all | a cosmetic ladder can run 19 to 2,600 |
| Radio / boombox | pass | 15-475 | social, roleplay | copyrighted music warning in the copy |
| Admin panel / commands sandbox | pass | 299 / 499 / 1,199 (one at 7,999) | horror, sims | must not grant progress (DOORS' admin panel earns no currency) |
| Private-server tools | pass | 149 / 499 / 525 | all | change settings only in the owner's private server |
| Skip (stage, timer, quest, tier) | product | 49 / 149 / 459 | convenience, aggressive | Roblox: timers players pay to remove are unpopular [docs]: keep timers short and skips cheap |
| Revive / extra life | product | 25 / 49 / 119 | horror, survival, obby | revive-a-friend about 1.5-2x self, revive-everyone about 4x |
| Spin / crate / egg / key | product | 99 / 299 / 799 | aggressive, cosmetic crates | paid random: odds + PolicyService |
| Starter pack (once per account) | product | 39 / 99 / 299 (47% of games) | all | offer from the second session, never on the first loading screen [docs] |
| Timed boost (2x for 15 min to 8 h) | product | 79 / 179 / 399 | aggressive, PvE | e.g. 25 for 15 min, 99 for 1 h; save the end time |
| Currency pack | product | ladder, section 4 | all with a soft or premium currency | |
| Gift twin of a pass or product | product | same price as the original (58% of games sell gifts) | all | grants to a chosen player in the server |
| Rewarded video ad | product granted by an ad | reward worth 3-10 Robux [docs] | all | section 5 |
| Roblox Plus sign-up prompt | Roblox subscription | creator earns 250 Robux/month for 3 months, up to 750 per new subscriber [docs] | all | reward the subscriber in game; verify on the server |
| Subscription (monthly) | subscription | in Robux or local currency [docs] | live games with a daily loop | distinct benefits, not tiers; honour the full term [docs] |
| Donation | product | 1-100,000 | any, in-game only | cross-game pass and product sales are disabled from 30 May 2026 [docs]; person-to-person gifts use Robux transfers |
Catalog size at launch [data]: on-sale passes per game median 6 (p25 2, p75 11); products median 66 (p25 20, p75 139; the
top 30 earners median 88). Start with **5-8 passes and 8-15 products**, then add one themed item per content update.

## 4. Prices that convert
**What players hold.** Robux are bought in packs; the common ones are about 80 for $0.99, 400 (app) to 500 (web) for $4.99, 800
to 1,000 for $9.99, 1,700 for $19.99, 4,500 for $49.99 and 10,000 for $99.99 (platform-dependent; web and gift cards give more
than the app) [practice, third-party price lists]. Design so that: an impulse item fits inside the smallest pack (<= 79), the
core passes fit one $4.99 pack (<= 399-499), the premium tier fits a $9.99 pack (<= 799), and only whale items need more.

**Observed ladders [data].** Pass prices: p10 75, p25 149, median 300, p75 500, p90 1,199. The most common pass prices, in order:
399, 199, 299, 99, 499, 149, 799, 1,249, 300, 350. Product prices: p25 125, median 399, p75 999, p90 2,249; most common 199,
399, 99, 799, 499, 299, 999, 49. 59% of pass prices end in 9, 24% in 0, 12% in 5.
| Tier | Pass ladder | Product ladder | Role |
|---|---|---|---|
| Impulse | 49-99 | 9-49 (revive, skip, small boost) | the first purchase; low regret |
| Core | 149-399 | 99-199 | 2x, auto, emote slots, VIP at 299-399 |
| Premium | 499-799 | 399-799 | luck tiers, big slot packs, VIP+ |
| Whale | 1,249-2,499 | 999-2,499 | top luck, best unit, mega bundle |
| Aspirational | 3,000+ (one item) | 4,000-10,000 (top currency pack) | anchors everything below it |

**Currency packs: 5-7 tiers with a rising bonus.** Price the smallest pack as the base rate and give each larger pack more per
Robux. A good curve: 49 (base), 99 (+5%), 199 (+15%), 399 (+25%), 799 (+40%), 1,799 (+60%), 4,499 (+80%). Seen [data]: DOORS'
coin packs climb to about +75% per Robux at the top, Arsenal's to about +35%, Restaurant Tycoon 2's to about +100%; one horror
game's packs are flat yet the largest is labelled "best deal": never do that. Mark exactly one pack **Best value** (the one
with the highest units per Robux, usually the second largest or the largest) and, if you like, one **Most popular** (true
only from sales data; until then, don't). Show units, the bonus ("+25% bonus") and the price; never a fake "was" price.

**Bundles and anchoring.** A bundle is 3-6 items worth 1.4-1.7x its price at their single prices ("Includes ... worth 1,240"):
only when each part is sold separately at that price. Order a shop page from the anchor down: the aspirational bundle first,
the best-value item highlighted beside it, the impulse items last, so the core item looks reasonable. Three options (small,
best-value, large) convert better than one or ten [practice]. Price passes that complement each other (e.g. 2x pollen and 2x
conversion) side by side and suggest the second after the first [docs: complementary purchases].

**Price psychology [practice].** End in 9 for value items (99, 199, 399), use round numbers for status (300, 500, 1,000 VIP).
Keep one price per perk tier across the game (all emote packs 175, all kits 399; BedWars sells over 40 kit passes, all at
399): consistency reads as fair. A cheap first offer (one obby sells its first revive at 9, the regular one at 19) is a
genuine discount only if it really is the first purchase and ends after it.

**Let Roblox tune it.** Managed pricing [docs] combines regional pricing (each region pays 30-100% of your default price; passes
on by default, products opt in; new games and items are enrolled by default) and price optimization (A/B tests of about 3 weeks,
at least every 90 days, applied only if revenue rises; usually needs about 60,000 transactions in 30 days). Both require prices
read at runtime, never hard-coded (section 8). Roblox Plus subscribers pay 10% less (20% from their third month), subsidised by
Roblox: you still earn 70 of every 100 Robux of price [docs].

## 5. Placement: offer at the moment of need, never nag
Roblox's own Shop lists every pass and listed product and can show a global Shop button in the top-left; it is off by default
and worth enabling [docs]. Your in-game shop is still the main storefront. Then the contextual moments [docs: contextual purchases]:
| Moment | Offer | Rule |
|---|---|---|
| Lobby / hub | a shop NPC or 3D display of the featured items; VIP area visible from the hub | the display opens the full shop |
| Pre-play (elevator, queue, round intermission) | consumables for the next run (revives, boosts, kits) | the shop states what each item does in the run |
| Failure | revive / extra life at death; skip after 3 fails on the same stage | pause the timer: the Buy Robux flow takes several seconds [docs]; give 10+ s |
| Progress wall | the slot, storage or multiplier the player just ran out of | show the free path beside the paid one ("Earn 300 more" / "Buy") |
| Reward reveal | luck pass or more spins after a near-miss | odds on screen; no "almost!" theatre on paid spins |
| After a win, level-up or rebirth | the next tier's multiplier, the season pass | once per milestone |
| Second session onwards | starter pack card | not on the first loading screen [docs]; once per account |
| Natural breaks (menus, lobby, between rounds) | a rewarded video for a 3-10 Robux reward | never while the character can be harmed [docs] |
Anti-nag rules [practice]: never open a purchase prompt without a tap; at most one unsolicited offer card every 10 minutes and
none in the first 5 minutes; no stacked modals [docs]; after two "No thanks" on an offer, hide it for 24 hours; no offers
during combat, a timed puzzle or a cutscene; on phones the offer card is a bottom sheet the thumb can dismiss. A HUD "+" next
to each currency opens the currency page. Tycoons put Robux buttons on the base beside the cash buttons, clearly marked with
the Robux icon. Wording on buttons: "View item", "See price", "Open shop", not "GET IT NOW" [docs].

**Rewarded video [docs].** Full-screen 6-30 s ads the player chooses to watch; the reward must be a developer product (not
Robux, not random), worth about 3-10 Robux (a 15-minute 2x, a revive, a small currency drop). Requirements: you 13+ and ID
verified, a public game with at least 2,000 unique visitors a month. Client: `AdService:GetAdAvailabilityNowAsync()` right
before showing the button; server: `AdService:CreateAdRewardFromDevProductId(id)` then `AdService:ShowRewardedVideoAdAsync(player,
reward)`; the grant arrives through the receipt handler like any product. Track each button with a placement ID.

**Roblox's Buy Robux page [docs].** One pass can be put in the bonus pool and given free to players who buy a Robux pack, who
are then invited into the game: make a pass for it (priced 50-800 if on sale, with an icon, not random): a strong acquisition lever.

## 6. VIP done well
- A **pass**, 299-499 (median 399 [data]); in a competitive game 199-399 and status only.
- **Status**: a VIP chat tag, a name colour, an overhead title, a VIP-only cosmetic (a sword skin, a hoverboard, a cape), an
  arrival line ("A VIP has joined"), a VIP corner of the hub with a visible door (others see it and the perk advertises itself).
- **Comfort** (PvE and convenience games only): +10-25% currency or XP (stacks honestly with other boosts: say so), a free
  daily gift, auto-skip of waves or intermissions, map voting in co-op.
- **A one-time welcome bundle** worth 1-2x the price in soft currency.
- Never: VIP damage, VIP-only servers that split a small player base, VIP powers that annoy others (server-wide music,
  announcements), a VIP area holding content free players need.
- Add perks over time and say so; never remove a perk someone paid for. A **VIP+** or second tier is a separate pass at
  1.5-2.5x VIP with clearly different perks.

## 7. Fairness and Roblox policy (check before every catalog)
**Paid random items** (eggs, crates, spins, gacha, random rerolls, keys and tickets that open them, anything bought with a
currency that can be bought with Robux) [docs: paid random items, clarified 26 May 2026]:
- Before purchase, show every possible outcome and its odds as a **percentage**; all outcomes sum to exactly 100%. Long decimals
  may be rounded to 4+ places below the first non-zero digit with the note "Probabilities are rounded; total of displayed
  individual probabilities may not equal 100%". Large lists sit behind a labelled "Details"/"Info" button (not an icon alone).
- Luck boosts, pity and rate-up items state their effect numerically, and the shown odds update while they are active; if an
  outcome can be obtained only once, the remaining odds update for that player.
- `PolicyService:GetPolicyInfoForPlayerAsync(player)`: when `ArePaidRandomItemsRestricted` is true, give that player an earnable
  path, a fixed order, a direct purchase of the item, or hide/block the paid random purchase. When `IsPaidItemTradingAllowed`
  is false, they cannot trade paid random outcomes. Fail closed if the call errors.
- Declare paid random items and paid item trading in the Maturity & Compliance questionnaire. Paid random items can't be
  promoted passes, sold outside the game, or rewarded by video ads [docs].
- Free random rewards (a chest found by playing) need no odds [docs]; show them anyway in kids' games [practice].
**Honest presentation** [docs: monetization guidelines]: a discount is not genuine if the item is always on sale; not fair if
it lasts only a very short time to pressure; no false "almost out of stock" or "only today"; no countdown that is inaccurate or
restarts for the same item. Limited items are limited (record the end date in the catalog and keep it).
**Younger players** [docs]: games rated Minimal or Mild can reach Roblox Kids (5-8) and Roblox Select (9-15), Moderate reaches
Select and 16+; parents see spending up to 18. Keep the core prices a parent approves without a second look (under 400), no
pushy language, no paid random item as the main way to progress, no "pay or lose your streak" mechanics [practice].
**Refunds**: Roblox generally does not refund in-experience purchases [help centre], so the game must deliver: grant reliably
(section 8), never revoke, and if you rework or remove a paid item, give owners an equivalent and say so in the update.
**Also**: no cross-game sales (disabled from 30 May 2026; in-game gifting products are unaffected) [docs, DevForum]; subscriptions keep their benefits for
the full term and never send players to buy elsewhere [docs]; metadata that leads with Robux or giveaways is demoted [docs].

## 8. Implementing purchases safely
**Prices and names come from Roblox at runtime** (regional pricing, Plus discounts and price tests make them differ per player):
`MarketplaceService:GetProductInfoAsync(Store.items.<Key>.id, Enum.InfoType.GamePass | Enum.InfoType.Product)` on the client
once the item is pushed (its id is 0 before: show `Store.items.<Key>.price`, the designed price), `PriceInRobux` for the label (`PriceDiscountDetails` explains a Plus discount); `GetDeveloperProductsAsync()` lists every product. Cache per
session; never type a price into UI code. The receipt's `CurrencySpent` is what the player actually paid.

**The generated module does Roblox's side.** Shuriken writes `ShurikenStore` into the game's shared code (e.g.
`ReplicatedStorage.Shared.ShurikenStore`) from the catalog: every item with its Roblox id (0 until the user pushes the store),
the game's only `ProcessReceipt`, the pass checks on join and on purchase, and Studio test purchases for items not on Roblox
yet. Never write another `ProcessReceipt`, another ownership loop or a second catalog module: the engineers write the grants
against its API.
| Call | Where | Does |
|---|---|---|
| `Store.items.<Key>` | both | `{key, kind, id, price, name}`; id 0 until pushed |
| `Store.owns(player, key)` / `Store.owns(nil, key)` | server / client | the player owns the pass (an attribute the server sets) |
| `Store.onPass(key, fn)` | server | `fn(player)` when a player has the pass: on join, on purchase, and at once for players already in |
| `Store.onProduct(key, fn)` | server | `fn(player, receipt) -> true` once granted; each purchase is granted once |
| `Store.useLedger(has, add)` | server | the purchase ledger in the player's save; `add` returns false when it couldn't save |
| `Store.prompt(key)` / `Store.prompt(player, key)` | client / server | offers the item (a Studio test purchase while its id is 0) |
| `Store.changed:Connect(fn)` | both | `fn(player, key)` when a player gets a pass |
| `Store.otherReceipts(fn)` | server | a game that sold products before keeps its handler: `fn(receipt)` answers the receipts of products not in this store |
Facts the receipt flow is designed around [docs: MarketplaceService.ProcessReceipt, player data guide]: it is called after a
purchase, when a purchase prompt succeeds, and when the player joins; a `NotProcessedYet` is retried only on their next
purchase or next join (no timer); the same receipt can run on two servers at once; without a handler, receipts are
auto-acknowledged and lost. So grants are idempotent and the ledger lives in the player's session-locked save:
```lua
--!strict
-- src/Server/Store.server.luau: the store's grants, exactly as the catalog's benefits say.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Store = require(ReplicatedStorage.Shared.ShurikenStore)
local PlayerData = require(script.Parent.PlayerData) -- session-locked saves (skill roblox-data-persistence)

-- Each purchase is granted once: its id is kept in the player's save, and confirmed only once saved.
Store.useLedger(function(player: Player, purchaseId: string): boolean
	local data = PlayerData.get(player)
	return data ~= nil and data.receipts[purchaseId] ~= nil
end, function(player: Player, purchaseId: string): boolean?
	local data = PlayerData.get(player)
	if not data then
		return false
	end
	data.receipts[purchaseId] = os.time() -- keep at least the newest 200
	return PlayerData.saveNowAsync(player) -- false: Roblox asks again on their next purchase or join
end)

Store.onPass("VIP", function(player: Player)
	player:SetAttribute("VipTag", true) -- the tag, the chat colour and the lounge door read it on the server
end)

Store.onProduct("Coins1000", function(player: Player, _receipt: { [string]: any }): boolean
	local data = PlayerData.get(player)
	if not data then
		return false -- not loaded yet, or they left: Roblox asks again
	end
	data.coins += 1000
	return true
end)
```
On the client: `Store.prompt("VIP")` from the offer's button, `Store.owns(nil, "VIP")` to show "Owned", `Store.changed` to
update the shop. Benefits are applied on the server (a 2x multiplies on the server, an area door checks the attribute on the
server). Never grant from `PromptProductPurchaseFinished`: it does not mean a purchase happened [docs]. Gift products put the
recipient's id in a pending server table before prompting; the grant writes to the recipient's data (or to a pending-gifts
store if they left) and both players see a message. A pass bought outside the game during a session shows on the player's
next join (`UserOwnsGamePassAsync` is cached [docs]).

**Paid random gating** (server, once per player at join; the client hides what the server refuses):
```lua
--!strict
local PolicyService = game:GetService("PolicyService")

local function paidRandomPolicy(player: Player): (boolean, boolean)
	local ok, policy = pcall(PolicyService.GetPolicyInfoForPlayerAsync, PolicyService, player)
	if not ok then
		return false, false -- fail closed: no paid random items, no trading of their outcomes
	end
	return policy.ArePaidRandomItemsRestricted ~= true, policy.IsPaidItemTradingAllowed == true
end

return paidRandomPolicy
```
**Testing.** In Studio, an item that isn't on Roblox yet (id 0) is bought through `Store.prompt` as a test purchase and granted
by the same handlers (no Robux, no dialog). Once pushed, Studio's purchases are mock purchases: no Robux are charged,
`ProcessReceipt` runs, and nothing persists between sessions [DevForum]. Test a grant, a duplicate receipt (call the handler twice with the same `PurchaseId`), a failed save, a
player leaving mid-grant, a pass bought mid-session, and a restricted policy (make `paidRandomPolicy` return false). Selling
products on the game page needs the External Purchase **test mode**, which charges real Robux: use a 1-Robux product [docs].
Managed pricing's Dynamic Price Check (up to 5 test accounts) shows any hard-coded price that failed to change [docs].

## 9. Naming conventions
- **Keys** (code and `store_catalog`): PascalCase letters and digits, 2-32 characters, starting with a letter, stable forever
  (`store_catalog` refuses anything else): `VIP`, `DoubleCoins`, `AutoCollect`, `LuckyPlus`, `Coins1000`, `Revive`,
  `SkipStage`, `Boost2x30m`, `StarterPack`, `GiftVIP`. The kind is its own field; the key never contains a price.
- **IDs live only in the generated `ShurikenStore`** (written from the catalog; a push writes the Roblox ids into it). Grants
  live in server code through `Store.onPass` and `Store.onProduct`; the client asks Roblox for the live price with the id.
- **Working display names** (the copywriter finalises them): benefit first, 12-20 characters, Title Case, digits for numbers
  and one multiplier style per game ("2x Coins", "+15 Pet Slots", "Auto Collect", "1,000 Coins", "Revive", "VIP"); gift twins
  "Gift: VIP"; timed items carry the duration ("2x Coins (30 min)"). Median pass name length on the charts is 14 [data].
  Every item gets a one-line benefit the copywriter can turn into a description (a third of chart passes have none [data]).
- **Categories** (`category`; Roblox's Shop and yours): Featured, Passes, Currency, Boosts, Cosmetics, Gifts. One `hue` per
  category for the icon artist (currency gold, luck green, speed cyan, VIP gold-purple, revive red, skip blue, cosmetics pink, gifts magenta).

## 10. Genre catalogs (starting points; adapt to the game's loop) [data where a game is named]
**Simulators / incremental / RNG (aggressive).** Passes: 2x Coins 299-399, Auto Collect/Tap 149-199, Lucky 275-299, Super Lucky
799, Hatch/Roll Speed 199-349, +Pet/Unit Slots 375-499, Storage 149, VIP 399, a top luck pass 1,600-3,250 (PS99's ladder runs
175 to 3,250). Products: Starter Pack 49-99 (once), currency ladder (6 tiers), 2x boost 30 min 79 / 2 h 199, instant hatch
9-49, luck potion 49-99, egg x1 / x3 / x10 (odds!), rebirth skip 99-199, gifts. Rewarded video: 15-minute 2x.
**Tycoons (aggressive).** Passes: 2x Cash 299, Auto Collect 149-249, extra worker or soldier 99-499, faster build 179-199,
bigger plot 120-320, a signature vehicle or machine 399-1,999, VIP 399. Products: cash packs, 10-min to 8-h boosts (40-800 in
Restaurant Tycoon 2), skip upgrade 49, missile/airstrike consumables in war tycoons, gifts. Robux buttons on the base.
**Obbies (convenience).** Products: Skip Stage 20-35 (cheaper early, rising late), Skip to the end, Revive at checkpoint 19,
2x Coins (session). Passes: Speed / Gravity coil 99-199, Double Jump 99, 2x Coins 195, trails 49-299, VIP 299. Tower of Hell
sells memberships of a week (35) and a month (120) and stock refreshes 15-200.
**Horror (convenience).** Pre-run shop with soft currency; products: Revive 40-99 (5 for 145), currency packs 49-1,799, run
boosts 59-129, extra save slot 50-99. Passes: cosmetic light/flashlight bundles 299, admin sandbox 499 (no progress), VIP 599-
699 (cosmetic + small XP). Revive-a-friend and revive-everyone at 2-4x self. Never sell a way to skip the scares' content.
**Roleplay / town life (convenience).** Passes: VIP 480-749, Premium 300, premium houses/estates 180-599, vehicle packs 299-599,
house pets 599, music 199, customization 299, bigger plot 250, multiple floors 360, chat colour/title. Products: currency or
ticket packs, gift twins of every pass (Brookhaven, Bloxburg and Adopt Me sell them), save slots 50-150, prop limits 80,
one-off party effects 9-50. A free-to-earn path for every house (slower).
**RPG / dungeon (convenience, power is fine in PvE).** Passes: 2x XP or mastery 450, 2x drops 350, fast mount or boat 350,
extra character slots 900, storage, a loot notifier (Blox Fruits 2,700), a signature weapon 1,200. Products: XP boost 25 (15 min)
/ 99 (1 h), stat reset 75, rerolls (random: odds), currency, spins 75. PvP zones ignore boosts.
**Battlegrounds / fighting (cosmetic-only).** Passes: VIP 299 (tag, cape, arrival line, hide-kills option), extra emote slots
99, emote pack 125-399, kill sound 199, awakening outfit 99-149, private-server settings 499. Products: random emote 25 (odds),
cosmetic spins 79 (odds), season pass tiers, gifts. No early access to movesets (The Strongest Battlegrounds sells it at 299:
not under this skill's rule).
**Shooters (cosmetic-only).** Weapon skins and wraps, charms, kill effects and finishers, skin cases 249-289 (odds shown),
daily skin offers 299-449, a cosmetic battle pass 499-799 with a free track, VIP 299 (tag, banner, cosmetic sword), emotes,
private servers. Weapons are earned by playing; if weapons are sold at all they are exact sidegrades unlocked by play too.
**RTS / competitive strategy (cosmetic-only).** Commander and unit skins, faction banners and base themes, emotes and voice
lines, map-editor or custom-lobby tools 199-499, replay and spectator tools, VIP status 299, a cosmetic season pass. Tower
defense and other PvE strategy are aggressive-allowed: units/towers 300-2,249, speed control 600, auto-skip in VIP, revives
(tickets 29 for 3), crates with odds.
**Racing.** Ranked or competitive races: cosmetics only (paint, rims, underglow 99-199, plates 79, horns, exhaust sounds, garage
slots 89) and spec classes so bought cars don't win races. Free-roam car games (Driving Empire, Drag Drive Simulator) are
convenience: 2x cash 499, car classes and luxury access 399-450, VIP 500, car radio 15-29.
**Party / minigames (cosmetic + light social).** Coins 2x 299, cosmetic pets and effects 99-149, minigame choice 9-27 per round
(fun, not power), starter pack 99, VIP 499 (tag, effects), private-server powers 899, chests of cosmetics (odds).
**Survival (co-op; convenience).** Self revive 45-55, revive teammate 67-95, revive everyone 200-230, class reroll 99-400 (odds
if random), starter survival kit 149-299, single-life weapons 40-148, storage +5 95, currency ladder, a decorator or base pass 199.
**Sports (cosmetic-only in ranked).** Style slots 149-499, cosmetic slots 299, emote slots 150, goal and celebration sounds 149,
VIP 399 (tag, ball skin, 2x soft currency for cosmetics), spin skipping 49, a premium season pass 100 with tiers at 39 each.
(Volleyball Legends also sells ability slots and style rerolls: power in ranked, so not under this skill's rule.)

## Checklist (before handing the catalog over)
- [ ] Style chosen and written down; in competitive modes nothing bought changes an outcome (the "equal-skill" test).
- [ ] 5-8 passes, 8-15 products, every price on the ladder, one Best value pack whose units-per-Robux really are the highest.
- [ ] A free path exists for every paid power item; time gates are short; skips are cheap.
- [ ] Each item has key, kind, working name, one-line benefit, price, category, offer, hue, icon subject (a game model or glyph).
- [ ] Paid random items: odds table, luck effects numeric, PolicyService gating, questionnaire answered.
- [ ] No fake discounts, timers or scarcity; limited items have a real end date; button words are calm.
- [ ] Grants through `ShurikenStore` only (`Store.onPass`, `Store.onProduct` returning true once granted, `Store.useLedger` on
  the saved profile); nothing else sets `ProcessReceipt`.
- [ ] Prices and names read with `GetProductInfoAsync` once pushed; no price typed into UI code; Managed pricing left on.
- [ ] Offers follow section 5 (moment of need, no nagging, nothing on the first loading screen, no stacked modals).
- [ ] Studio mock purchases tested (duplicate receipt, failed save, mid-session pass, restricted policy).
