import type { MockMotion, MockNode } from '@shared/ui-mockup';
import { Content, readCurrency, worldOf } from './content';
import { composeScreen, MENU_HIDES, MENU_FORMS, type FormCtx } from './forms';
import { lookOf, type Look } from './look';
import { art, bar, box, button, coin, fitWindow, icon, menuScreens, place, ribbon, skinned, slotTile, tag, text, window, type Box, type Ctx } from './parts';
import type { Template, TemplateInput, TemplateOutput } from './types';

const TITLES: Record<string, Record<string, string>> = {
  daily: { candy: 'DAILY GIFTS', ember: 'DAILY SPOILS', neon: 'DAILY CACHE', parchment: 'Daily Tribute', frost: 'Daily Rewards' },
  pass: { candy: 'SEASON PASS', ember: 'WAR PASS', neon: 'BATTLE PASS', parchment: 'Royal Pass', frost: 'Season Pass' },
};

interface Day {
  amount: string;
  glyph: string;
  coin: boolean;
}

/** One day of the calendar: claimed (checked, dimmed), today (lit, claimable), or still to come. */
function dayCard(c: Ctx, i: number, d: Day, state: 'claimed' | 'today' | 'later', b: Box, big: boolean): MockNode {
  const { f, L } = c;
  const variant = big ? 'mythic' : state === 'today' ? 'legendary' : state === 'claimed' ? 'common' : 'rare';
  const head = Math.round(f.ts.h2 + 8);
  const ic = Math.round(Math.min(b.w * (big ? 0.36 : 0.5), b.h - head - f.ts.num - 34));
  const kids: MockNode[] = [
    text(c, 'Day', `Day ${i + 1}`, 'h2', 'card', box(0, state === 'today' ? Math.round(f.ts.small * 0.5) + 6 : 6, b.w, head), { z: 3, ...L.font('button') }),
    d.coin ? coin(c, 'Reward', d.glyph, box(0, Math.round(head / 2 + 2), ic, ic, { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), { z: 3 }) : icon(c, 'Reward', d.glyph, box(0, Math.round(head / 2 + 2), ic, ic, { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), big ? 'mythic' : 'epic', { z: 3 }),
    text(c, 'Amount', d.amount, 'num', 'card', box(0, -8, b.w, f.ts.num + 6, { sy: 1, ay: 1 }), { z: 3 }),
  ];
  if (state === 'claimed') {
    kids.push({ name: 'Claimed', cls: 'Frame', size: [1, 0, 1, 0], bg: '#000000', bgT: 0.5, corner: [0, L.fill('card', variant).corner], z: 5, note: 'Over a day already claimed' });
    kids.push(icon(c, 'Check', 'circle-check', box(0, 0, Math.round(Math.min(b.w, b.h) * 0.42), Math.round(Math.min(b.w, b.h) * 0.42), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), 'success', { z: 6 }));
  }
  if (state === 'today') kids.push(ribbon(c, 'Today', 'TODAY', box(0, -Math.round(f.ts.small * 1.5), Math.round(Math.min(b.w * 0.9, f.ts.small * 6.5)), Math.round(f.ts.small * 1.9), { sx: 0.5, ax: 0.5 })));
  if (big) kids.push(tag(c, 'Jackpot', 'BIG', box(Math.round(f.ts.small * 0.5), -Math.round(f.ts.small * 0.8), Math.round(f.ts.small * 3.4), Math.round(f.ts.small * 3.4), { sx: 1, ax: 1 }), { rot: 12 }));
  return { ...skinned(c, 'Frame', `Day${i + 1}`, 'card', variant, b), note: state === 'today' ? 'Today\'s reward: claimable' : state === 'claimed' ? 'Claimed' : 'Still to come', kids };
}

function dailyLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const gems = readCurrency(content.obj('premium'), world.premium);
  const title = content.str('title', TITLES.daily![L.base] ?? 'DAILY REWARDS');
  const today = Math.max(0, Math.min(6, content.num('today', 3) - 1));
  const days: Day[] = content.list('days', [
    { amount: '100', glyph: cur.glyph, coin: true },
    { amount: '250', glyph: cur.glyph, coin: true },
    { amount: '5', glyph: gems.glyph, coin: true },
    { amount: '500', glyph: cur.glyph, coin: true },
    { amount: 'x2 Boost', glyph: 'zap', coin: false },
    { amount: '25', glyph: gems.glyph, coin: true },
    { amount: L.base === 'candy' || L.base === 'parchment' ? 'Mythic Egg' : L.base === 'frost' ? 'Gift Box' : 'Loot Chest', glyph: L.base === 'candy' ? 'egg' : L.base === 'ember' ? 'chest' : L.base === 'neon' ? 'chest' : L.base === 'parchment' ? 'crown' : 'gift', coin: false },
  ], (x, d) => ({ amount: String(x.amount ?? d?.amount ?? ''), glyph: String(x.glyph ?? d?.glyph ?? 'gift'), coin: typeof x.coin === 'boolean' ? x.coin : (d?.coin ?? false) })).slice(0, 7);
  const want: [number, number] = f.portrait ? [f.w - 24, f.h - 60] : f.phone ? [f.w, f.h] : f.tv ? [1400, 760] : f.form === 'tablet' ? [1240, 720] : [1180, 700];
  const [W, H] = fitWindow(c, want);
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const btnH = Math.max(f.tap, Math.round(f.ts.button * 2.4));
    const footH = btnH;
    const gridH = bh - footH - g - 4;
    const state = (i: number) => (i < today ? 'claimed' : i === today ? 'today' : 'later');
    const cards: MockNode[] = [];
    if (f.phone && !f.portrait) {
      // One row of seven.
      const cw = Math.floor((bw - 6 * g) / 7);
      days.forEach((d, i) => cards.push(dayCard(c, i, d, state(i), box(i * (cw + g), 10, cw, gridH - 10), i === 6)));
    } else {
      // Rows: four, then two and the big seventh day (two cells wide); three a row upright.
      const cols = f.portrait ? 3 : 4;
      const rows = f.portrait ? 3 : 2;
      const cw = Math.floor((bw - (cols - 1) * g) / cols);
      const ch = Math.floor((gridH - 12 - (rows - 1) * g) / rows);
      days.forEach((d, i) => {
        const big = i === 6;
        const col = i % cols;
        const row = Math.floor(i / cols);
        const w = big ? (f.portrait ? bw : cw * 2 + g) : cw;
        const x = big && f.portrait ? 0 : col * (cw + g);
        cards.push(dayCard(c, i, d, state(i), box(x, 12 + row * (ch + g), w, ch), big));
      });
    }
    kids.push({ name: 'Days', cls: 'Frame', size: [1, 0, 0, gridH], bgT: 1, note: 'The seven days: claimed, today, still to come (a streak resets after a missed day)', kids: cards });
    // The footer: the streak, the time to the next reward, Claim.
    const claimW = Math.round(Math.min(bw * 0.4, f.portrait ? bw * 0.5 : 360));
    const fy = -0;
    kids.push({
      name: 'Footer',
      cls: 'Frame',
      pos: [0, 0, 1, fy],
      anchor: [0, 1],
      size: [1, 0, 0, footH],
      bgT: 1,
      kids: [
        icon(c, 'Flame', 'flame', box(0, 0, Math.round(footH * 0.62), Math.round(footH * 0.62), { sy: 0.5, ay: 0.5 }), 'mythic', { z: 3 }),
        text(c, 'Streak', `${today}-day streak`, 'h2', 'panel', box(Math.round(footH * 0.62) + 8, 4, bw - claimW - footH - 20, Math.round(footH * 0.5)), { xAlign: 'Left', z: 3, note: 'Days in a row' }),
        text(c, 'Next', 'Next gift in 14:22:09', 'small', 'muted', box(Math.round(footH * 0.62) + 8, Math.round(footH * 0.52), bw - claimW - footH - 20, Math.round(footH * 0.44)), { xAlign: 'Left', z: 3, note: 'Counts down to the next day\'s reward' }),
        button(c, 'Claim', 'CLAIM', box(0, 0, claimW, btnH, { sx: 1, ax: 1 }), { variant: L.go, icon: 'gift', note: 'Claims today\'s reward (the server checks the day)' }),
      ],
    });
    return kids;
  });
  return [win];
}

export const dailyRewards: Template = {
  id: 'daily-rewards',
  label: 'Daily rewards',
  for: 'A seven-day login calendar: claimed days checked, today lit with Claim, a big seventh-day prize, the streak and the time to the next gift',
  contentShape: 'title, today (1-7), days [{amount, glyph, coin}] x7, currency {glyph}, premium {glyph}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Daily', hides: MENU_HIDES, forms: MENU_FORMS, note: 'Daily rewards: opens on join when a gift is waiting', build: (f) => dailyLayout(L, f, content) });
    const today = Math.max(1, Math.min(7, content.num('today', 3)));
    return {
      screens: menuScreens('Daily', screen),
      motion: [
        { play: 'open', target: 'Daily.Window' },
        { play: 'enter', target: 'Daily.Window.Body.Days', from: 'pop', gap: 0.05, delay: 0.1 },
        { play: 'pulse', target: `Daily.Window.Body.Days.Day${today}`, when: 'loop', amount: 0.05, seconds: 1.2 },
        { play: 'pulse', target: 'Daily.Window.Body.Footer.Claim', when: 'loop', amount: 0.04, seconds: 1.2 },
        { play: 'float', target: 'Daily.Window.Body.Days.Day7.Reward', when: 'loop', amount: 6, seconds: 2.2 },
        { play: 'punch', target: `Daily.Window.Body.Days.Day${today}`, when: 'claimed', amount: 0.15 },
        { play: 'fly', target: `Daily.Window.Body.Days.Day${today}.Reward`, to: 'Daily.Window.Body.Footer.Claim', when: 'claimed', note: 'Then into the HUD\'s counter' },
      ],
      notes: ['The server keeps the streak and the last claim time; the window opens on join when a gift is waiting.', 'Claimed days get the Claimed shade and check; today gets the TODAY ribbon and pulses.'],
    };
  },
};

// ─── Battle pass ──────────────────────────────────────────────────────────────────────────────────

const PASS_REWARDS: Array<[string, string, string, boolean]> = [
  ['coins', '500', 'common', true], ['gem', '10', 'rare', true], ['zap', 'x2 XP', 'rare', false], ['coins', '1K', 'common', true], ['chest', 'Crate', 'epic', false], ['gem', '25', 'rare', true], ['sparkles', 'Aura', 'epic', false], ['coins', '2.5K', 'common', true], ['crown', 'Title', 'legendary', false], ['gem', '50', 'epic', true], ['flame', 'Trail', 'legendary', false], ['star', 'Skin', 'mythic', false],
];

function passLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const gems = readCurrency(content.obj('premium'), world.premium);
  const title = content.str('title', TITLES.pass![L.base] ?? 'BATTLE PASS');
  const tier = content.num('tier', 6);
  const tiers = Math.max(8, Math.min(40, content.num('tiers', 12)));
  const want: [number, number] = f.portrait ? [f.w - 24, f.h - 60] : f.phone ? [f.w, f.h] : f.tv ? [1480, 790] : f.form === 'tablet' ? [1340, 760] : [1300, 740];
  const [W, H] = fitWindow(c, want);
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    // The season strip: the tier badge, XP to the next tier, the season's end, and Premium.
    const sh = Math.round(f.phone ? 58 : f.ts.h1 * 3.1);
    const badge = sh;
    const premW = Math.round(Math.min(bw * 0.32, f.phone ? 210 : 330));
    const xpX = badge + 14;
    const xpW = bw - xpX - premW - g * 1.5;
    kids.push({ ...art(c, 'Tier', 'badge', box(0, 0, badge, badge), {}), z: 4, note: 'The player\'s tier', kids: [text(c, 'Value', String(tier), 'big', 'card', box(0, 0, badge, badge), { z: 5, textSize: Math.round(badge * 0.42), ink: { color: '#ffffff', stroke: { color: '#2b1306', px: 2, text: true } } })] });
    kids.push(text(c, 'Season', f.phone ? `Tier ${tier}` : `Tier ${tier} · Season 4`, 'h2', 'panel', box(xpX, 0, Math.round(xpW * 0.6), Math.round(sh * 0.42)), { xAlign: 'Left', z: 3 }));
    kids.push(text(c, 'Ends', f.phone ? '12d left' : 'Ends in 12d 04h', 'small', 'muted', box(xpX + Math.round(xpW * 0.6), 0, Math.round(xpW * 0.4), Math.round(sh * 0.42)), { xAlign: 'Right', z: 3, note: 'Time left in the season' }));
    kids.push(bar(c, 'XP', box(xpX, Math.round(sh * 0.5), xpW, Math.round(sh * 0.38)), 0.62, { label: '1,240 / 2,000 XP', labelRole: 'small', note: 'XP to the next tier' }));
    kids.push(button(c, 'Premium', f.phone ? 'BUY 499' : 'PREMIUM 499', box(0, Math.round((sh - Math.max(f.tap, Math.round(sh * 0.86))) / 2), premW, Math.max(f.tap, Math.round(sh * 0.86)), { sx: 1, ax: 1 }), { variant: 'premium', coin: gems.glyph, note: `Unlocks the premium track for 499 ${gems.name} (or a game pass for Robux)` }));
    // The track: tier numbers along a line, the free row and the premium row.
    const ty = sh + g;
    const th = bh - ty;
    const labelW = f.phone ? 92 : f.tv ? 170 : 150;
    const pillH = Math.round(f.ts.small * 2);
    const most = Math.floor(Math.min((th - pillH - 3 * g - 8) / 2, f.phone ? 92 : f.tv ? 190 : 176));
    // Whole tiers and a clear peek of the next (never a tier cut in half at the edge): n columns and 40% of one more.
    const trackW = bw - labelW - g;
    const shown = Math.max(2, Math.ceil(trackW / (most + g) - 0.4));
    const slot = Math.floor(trackW / (shown + 0.4) - g);
    const colW = slot + g;
    const rowY = [pillH + g, pillH + g + slot + g];
    // Row labels.
    kids.push({ ...skinned(c, 'Frame', 'FreeLabel', 'card', 'common', box(0, ty + rowY[0]!, labelW, slot)), kids: [text(c, 'Text', 'FREE', 'h2', 'card', box(0, 0, labelW, slot), { z: 3, ...L.font('button') })] });
    kids.push({ ...skinned(c, 'Frame', 'PremiumLabel', 'card', 'legendary', box(0, ty + rowY[1]!, labelW, slot)), kids: [icon(c, 'Crown', 'crown', box(0, Math.round(slot * 0.14), Math.round(slot * 0.36), Math.round(slot * 0.36), { sx: 0.5, ax: 0.5 }), 'legendary', { z: 3 }), text(c, 'Text', 'PREMIUM', 'small', 'card', box(0, -Math.round(slot * 0.12), labelW, f.ts.small + 6, { sy: 1, ay: 1 }), { z: 3, ...L.font('button') })] });
    const tx = labelW + g;
    const tw = trackW;
    const cols: MockNode[] = [];
    for (let i = 0; i < tiers; i++) {
      const n = i + 1;
      const [fg, fa, fr, fc] = PASS_REWARDS[(i * 2) % PASS_REWARDS.length]!;
      const [pg, pa, pr] = PASS_REWARDS[(i * 2 + 1) % PASS_REWARDS.length]!;
      const claimed = n < tier;
      const current = n === tier;
      const free = slotTile(c, 'Free', { glyph: fg, rarity: fr, level: fa, equipped: claimed, selected: current }, slot);
      const prem = slotTile(c, 'Premium', { glyph: pg, rarity: pr === 'common' ? 'rare' : pr, level: pa, locked: true }, slot);
      if (fc) free.kids = [coin(c, 'Coin', fg === 'gem' ? gems.glyph : world.currency.glyph, box(0, -Math.round(slot * 0.05), Math.round(slot * 0.5), Math.round(slot * 0.5), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), { z: 3 }), ...(free.kids ?? []).filter((k) => k.name !== 'Icon')];
      cols.push({
        name: `Tier${n}`,
        cls: 'Frame',
        pos: [0, i * colW, 0, 0],
        size: [0, slot, 1, 0],
        bgT: 1,
        kids: [
          { ...skinned(c, 'Frame', 'Number', 'pill', undefined, box(0, 0, Math.round(slot * 0.7), pillH, { sx: 0.5, ax: 0.5 })), z: 4, kids: [text(c, 'Value', String(n), 'small', 'dark', box(0, 0, Math.round(slot * 0.7), pillH), { z: 5, ...L.font('num') })] },
          { ...free, pos: [0, 0, 0, rowY[0]!] },
          { ...prem, pos: [0, 0, 0, rowY[1]!] },
        ],
      });
    }
    const lineW = tiers * colW;
    // What the rows leave under them shows the season's big prize (bigger screens).
    const used = rowY[1]! + slot + 10;
    const spare = th - used - g;
    const showcase = spare >= (f.tv ? 150 : 120);
    kids.push({
      name: 'Track',
      cls: 'ScrollingFrame',
      pos: [0, tx, 0, ty],
      size: [0, tw, 0, showcase ? used : th],
      bgT: 1,
      canvas: [0, lineW + 8, 0, 0],
      note: 'The tiers, scrolled to the current one (claimed: checked; premium: locked until bought)',
      kids: [
        // A thin connector under the tier numbers: plain fills (art needs more height than a line has).
        { name: 'Line', cls: 'Frame', ...place(box(Math.round(slot / 2), Math.round(pillH / 2) - 4, lineW - colW, 8)), bg: L.fill('barTrack').bg, corner: [0.5, 0], z: 1, kids: [{ name: 'Fill', cls: 'Frame', size: [(tier - 1) / (tiers - 1), 0, 1, 0], bg: L.fill('barFill').bg, corner: [0.5, 0], z: 2 }] },
        ...cols,
      ],
    });
    if (showcase) {
      const sh2 = spare;
      const ic = Math.round(sh2 * 0.78);
      const prize = L.base === 'candy' ? ['Rainbow Dragon', 'flame'] : L.base === 'ember' ? ['Inferno Blade', 'sword'] : L.base === 'neon' ? ['Titan Frame', 'rocket'] : L.base === 'parchment' ? ['Crown of Ash', 'crown'] : ['Aurora Wings', 'wings'];
      const bw2 = Math.round(Math.min(bw * 0.3, 340));
      kids.push({
        ...skinned(c, 'Frame', 'Showcase', 'card', 'legendary', box(0, ty + used + g, bw, sh2)),
        note: "The season's big prize, at its last tier (premium)",
        kids: [
          icon(c, 'Art', prize[1]!, box(18, 0, ic, ic, { sy: 0.5, ay: 0.5 }), 'mythic', { z: 3 }),
          text(c, 'Label', `SEASON PRIZE · TIER ${tiers}`, 'small', 'card', box(ic + 36, Math.round(sh2 * 0.16), bw - ic - bw2 - 70, f.ts.small + 6), { xAlign: 'Left', z: 3, ...L.font('button') }),
          text(c, 'Prize', prize[0]!, 'big', 'card', box(ic + 36, Math.round(sh2 * 0.16) + f.ts.small + 8, bw - ic - bw2 - 70, Math.round(f.ts.big * 1.1)), { xAlign: 'Left', z: 3, textSize: Math.round(Math.min(f.ts.big, sh2 * 0.32)) }),
          text(c, 'ToGo', `${tiers - tier} tiers to go`, 'small', 'card', box(ic + 36, -Math.round(sh2 * 0.14), bw - ic - bw2 - 70, f.ts.small + 6, { sy: 1, ay: 1 }), { xAlign: 'Left', z: 3, ink: rarityLabelInk(c) }),
          button(c, 'ClaimTier', `CLAIM TIER ${tier}`, box(-18, 0, bw2, Math.max(f.tap, Math.round(f.ts.button * 2.4)), { sx: 1, sy: 0.5, ax: 1, ay: 0.5 }), { variant: L.go, icon: 'gift', note: "Claims the current tier's free reward" }),
        ],
      });
    }
    return kids;
  });
  return [win];
}

/** Secondary text on a legendary card: the card's own ink, a little quieter. */
const rarityLabelInk = (c: Ctx) => ({ ...c.L.ink('card'), color: c.L.ink('card').color });

export const battlePass: Template = {
  id: 'battle-pass',
  label: 'Battle pass',
  for: 'A season pass: the tier and XP to the next, a scrolling track of tiers with a free row and a premium row (claimed, current, locked), the season\'s end and Get Premium',
  contentShape: 'title, tier, tiers (8-40), premium {glyph, name}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Pass', hides: MENU_HIDES, forms: MENU_FORMS, note: 'The season pass', build: (f) => passLayout(L, f, content) });
    const tier = content.num('tier', 6);
    return {
      screens: menuScreens('Pass', screen),
      motion: [
        { play: 'open', target: 'Pass.Window' },
        { play: 'enter', target: 'Pass.Window.Body.Track', from: 'right', gap: 0.03, delay: 0.1 },
        { play: 'pulse', target: 'Pass.Window.Body.Premium', when: 'loop', amount: 0.04, seconds: 1.5 },
        { play: 'shimmer', target: 'Pass.Window.Body.PremiumLabel', when: 'loop', seconds: 2.8 },
        { play: 'punch', target: 'Pass.Window.Body.Tier', when: 'tier up', amount: 0.2 },
        { play: 'pulse', target: `Pass.Window.Body.Track.Tier${tier}.Free`, when: 'loop', amount: 0.05, seconds: 1.2 },
      ],
      notes: ['Scroll the track so the current tier shows; claimed rewards get the check, premium ones stay locked until the pass is bought.', 'The XP bar and tier come from the player\'s data; Get Premium prompts a developer product or game pass.'],
    };
  },
};

// ─── Round end ────────────────────────────────────────────────────────────────────────────────────

function roundLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const win = content.str('result', 'victory') !== 'defeat';
  const headline = content.str('title', win ? (L.base === 'parchment' ? 'Victory!' : L.base === 'frost' ? 'You won!' : 'VICTORY!') : L.base === 'parchment' ? 'Defeat' : L.base === 'frost' ? 'Good game' : 'DEFEAT');
  const sub = content.str('subtitle', win ? '1st place · your team wins' : '4th place · so close');
  const stats = content.list('stats', [['Kills', '12', 'skull'], ['Damage', '8.2K', 'swords'], ['Time', '4:21', 'timer'], ['Accuracy', '61%', 'target']] as Array<[string, string, string]>, (x, d) => [String(x.name ?? d?.[0] ?? ''), String(x.value ?? d?.[1] ?? ''), String(x.glyph ?? d?.[2] ?? 'star')] as [string, string, string]).slice(0, 4);
  const rewards: Array<[string, string, boolean, string]> = [[cur.glyph, `+${win ? '1,250' : '400'}`, true, cur.name], ['star', `+${win ? 340 : 120} XP`, false, 'Experience'], ['chest', win ? 'Rare Chest' : 'Chest', false, 'Loot']];
  const { inset } = f;
  const g = f.gap;
  const W = Math.min(f.w - inset[0] - inset[2] - 20, f.phone ? 760 : f.portrait ? f.w - 24 : 1100);
  const titleH = f.phone ? 64 : f.portrait ? 78 : f.tv ? 128 : 120;
  const cols = f.portrait ? 2 : 4;
  const sw = Math.floor((W - (cols - 1) * g) / cols);
  const sh = f.phone ? 62 : Math.round(f.ts.big * 1.9);
  const statsH = Math.ceil(stats.length / cols) * (sh + g) - g;
  const rh = f.phone ? 64 : Math.round(f.ts.big * 2.2);
  const rcols = f.portrait ? 1 : 3;
  const rw = Math.floor((W - (rcols - 1) * g) / rcols);
  const rewardsH = Math.ceil(rewards.length / rcols) * (rh + g) - g;
  const lvH = f.phone ? 0 : Math.round(f.ts.body * 1.6) + f.ts.small + 8;
  const btnH = Math.max(f.tap, Math.round(f.ts.button * 2.5));
  const space = f.phone ? 6 : f.portrait ? 18 : 26;
  const subH = f.ts.h1 + 8;
  const total = titleH + subH + space + statsH + space + rewardsH + (lvH ? space + lvH : 0) + space + btnH;
  // The whole stack centred in the safe area (the title plate's overhang above it).
  let y = inset[1] + Math.max(f.phone ? 2 : 12, Math.round((f.h - inset[1] - inset[3] - total) / 2));
  const kids: MockNode[] = [];
  kids.push(art(c, 'Headline', 'title', box(0, y, Math.round(Math.min(W, titleH * 5.2)), titleH, { sx: 0.5, ax: 0.5 }), { text: headline }, { z: 5, note: 'Victory or defeat: the title plate (punches in)' }));
  y += titleH;
  kids.push(text(c, 'Subtitle', sub, 'h1', 'scene', box(0, y, W, subH, { sx: 0.5, ax: 0.5 }), { z: 4 }));
  y += subH + space;
  kids.push({
    name: 'Stats',
    cls: 'Frame',
    pos: [0.5, 0, 0, y],
    anchor: [0.5, 0],
    size: [0, W, 0, statsH],
    bgT: 1,
    note: 'The match stats of the player (count up as the screen opens)',
    kids: stats.map(([label, value, glyph], i) => ({
      ...skinned(c, 'Frame', `Stat${i + 1}`, 'card', 'common', box((i % cols) * (sw + g), Math.floor(i / cols) * (sh + g), sw, sh)),
      kids: [
        icon(c, 'Icon', glyph, box(Math.round(sh * 0.16), 0, Math.round(sh * 0.56), Math.round(sh * 0.56), { sy: 0.5, ay: 0.5 }), 'rare', { z: 3 }),
        text(c, 'Value', value, 'big', 'card', box(Math.round(sh * 0.82), Math.round(sh * 0.08), sw - Math.round(sh * 0.9), Math.round(sh * 0.54)), { xAlign: 'Left', z: 3, textSize: Math.round(sh * (f.phone ? 0.4 : 0.42)) }),
        text(c, 'Label', label, 'small', 'card', box(Math.round(sh * 0.82), Math.round(sh * 0.58), sw - Math.round(sh * 0.9), Math.round(sh * 0.32)), { xAlign: 'Left', z: 3 }),
      ],
    })),
  });
  y += statsH + space;
  kids.push({
    name: 'Rewards',
    cls: 'Frame',
    pos: [0.5, 0, 0, y],
    anchor: [0.5, 0],
    size: [0, W, 0, rewardsH],
    bgT: 1,
    note: 'What the match earned: they pop in one by one and fly to the HUD',
    kids: rewards.map(([glyph, amount, isCoin, what], i) => ({
      ...skinned(c, 'Frame', `Reward${i + 1}`, 'card', i === 0 ? 'legendary' : i === 1 ? 'rare' : 'epic', box((i % rcols) * (rw + g), Math.floor(i / rcols) * (rh + g), rw, rh)),
      kids: [
        isCoin ? coin(c, 'Icon', glyph, box(Math.round(rh * 0.14), 0, Math.round(rh * 0.64), Math.round(rh * 0.64), { sy: 0.5, ay: 0.5 }), { z: 3 }) : icon(c, 'Icon', glyph, box(Math.round(rh * 0.14), 0, Math.round(rh * 0.7), Math.round(rh * 0.7), { sy: 0.5, ay: 0.5 }), i === 1 ? 'rare' : 'epic', { z: 3 }),
        text(c, 'Amount', amount, 'big', 'card', box(Math.round(rh * 0.96), Math.round(rh * 0.08), rw - Math.round(rh * 1.06), Math.round(rh * 0.52)), { xAlign: 'Left', z: 3, scaled: true, textMax: Math.round(rh * 0.36) }),
        text(c, 'What', what, 'small', 'card', box(Math.round(rh * 0.96), Math.round(rh * 0.58), rw - Math.round(rh * 1.06), Math.round(rh * 0.3)), { xAlign: 'Left', z: 3 }),
      ],
    })),
  });
  y += rewardsH + space;
  if (lvH) {
    // The level the XP lands in: the bar fills by what this match earned.
    const lw = Math.round(W * 0.62);
    kids.push({
      name: 'Level',
      cls: 'Frame',
      pos: [0.5, 0, 0, y],
      anchor: [0.5, 0],
      size: [0, lw, 0, lvH],
      bgT: 1,
      note: 'The level of the player: the bar fills by the XP this match earned (Motion count on the label)',
      kids: [
        text(c, 'From', 'Level 23', 'small', 'scene', box(0, 0, Math.round(lw / 2), f.ts.small + 4), { xAlign: 'Left' }),
        text(c, 'Gain', `+${win ? 340 : 120} XP`, 'small', 'scene', box(0, 0, Math.round(lw / 2), f.ts.small + 4, { sx: 1, ax: 1 }), { xAlign: 'Right', ink: { color: String(L.hue.gold), stroke: L.ink('scene').stroke ?? { color: '#000000', px: 1.5, text: true } } }),
        bar(c, 'Bar', box(0, f.ts.small + 8, lw, Math.round(f.ts.body * 1.6)), 0.72, { label: '1,440 / 2,000', note: 'XP into the level' }),
      ],
    });
    y += lvH + space;
  }
  // Play again, back to the lobby.
  const bw = Math.round(Math.min(W * 0.36, f.phone ? 230 : 330));
  kids.push({
    name: 'Actions',
    cls: 'Frame',
    pos: [0.5, 0, 0, y],
    anchor: [0.5, 0],
    size: [0, bw * 2 + g * 2, 0, btnH],
    bgT: 1,
    kids: [
      button(c, 'Lobby', 'Lobby', box(0, 0, bw, btnH), { variant: 'secondary', icon: 'house', note: 'Back to the lobby' }),
      button(c, 'PlayAgain', 'Play again', box(0, 0, bw, btnH, { sx: 1, ax: 1 }), { variant: win ? L.go : 'primary', icon: 'rotate-ccw', note: 'Queues the next match' }),
    ],
  });
  // One container: the stack's pieces sit close (their art's glows touch), they belong together.
  return [{ name: 'Results', cls: 'Frame', size: [1, 0, 1, 0], bgT: 1, note: 'The results, as one stack', kids }];
}

export const roundEnd: Template = {
  id: 'round-end',
  label: 'Round end',
  for: 'The end of a match or round: victory or defeat as a title plate, placement, the player\'s stats, the rewards earned, Play again and Lobby',
  contentShape: 'result "victory" | "defeat", title, subtitle, stats [{name, value, glyph}] x4, currency {glyph, name}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'RoundEnd', hides: MENU_HIDES, displayOrder: 20, forms: MENU_FORMS, note: 'Shown when the round ends; hides the HUD', build: (f) => roundLayout(L, f, content) });
    return {
      screens: [{ name: 'RoundEndDim', insets: 'None', displayOrder: 19, note: 'Darkens the game behind the results', kids: [{ name: 'Dim', cls: 'Frame', size: [1, 0, 1, 0], bg: '#04020a', bgT: 0.3, gradient: { rot: 90, colors: [[0, '#ffffff'], [1, '#ffffff']], transp: [[0, 0.35], [0.5, 0.15], [1, 0.05]] } }] }, screen],
      motion: [
        { play: 'transition', style: 'fade', seconds: 0.3 },
        { play: 'enter', target: 'RoundEnd.Results.Headline', from: 'pop', delay: 0.1 },
        { play: 'punch', target: 'RoundEnd.Results.Headline', amount: 0.15, delay: 0.35 },
        { play: 'enter', target: 'RoundEnd.Results.Subtitle', from: 'up', delay: 0.3 },
        { play: 'enter', target: 'RoundEnd.Results.Stats', from: 'up', gap: 0.06, delay: 0.4 },
        { play: 'count', target: 'RoundEnd.Results.Stats.Stat1.Value', from: 0, to: 12, seconds: 0.6, delay: 0.5 },
        { play: 'enter', target: 'RoundEnd.Results.Rewards', from: 'pop', gap: 0.12, delay: 0.7 },
        { play: 'fly', target: 'RoundEnd.Results.Rewards.Reward1.Icon', to: 'RoundEnd.Results.Rewards.Reward1', when: 'rewards granted', note: 'Then into the HUD\'s counter' },
        { play: 'enter', target: 'RoundEnd.Results.Actions', from: 'up', delay: 1 },
        { play: 'pulse', target: 'RoundEnd.Results.Actions.PlayAgain', when: 'loop', amount: 0.04, seconds: 1.4 },
      ],
      notes: ['result "defeat" swaps the headline and greys the mood; the stats count up and the rewards pop in one by one.', 'The server decides the rewards; the screen only shows them. Play again requeues; Lobby teleports back.'],
    };
  },
};

