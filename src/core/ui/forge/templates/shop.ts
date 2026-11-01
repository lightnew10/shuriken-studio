import type { MockMotion, MockNode, MockStroke } from '@shared/ui-mockup';
import { amountOf, Content, readCurrency, readItem, worldOf, type Item } from './content';
import { composeScreen, MENU_HIDES, MENU_FORMS, type FormCtx } from './forms';
import { lookOf, type Look } from './look';
import { box, button, fitWindow, icon, place, ribbon, skinned, slotTile, tabButton, tag, text, window, type Box, type Ctx } from './parts';
import type { Template, TemplateInput, TemplateOutput } from './types';

/** Room the cards' art needs round them inside a clipping grid (outlines, bases and shadows). */
export const GRID_PAD = 10;

/** Rarity names on a light card: the rarity's colour, deep enough to read on white or paper. */
export const rarityInk = (r: string): string => ({ common: '#5f6b78', rare: '#1f6fd1', epic: '#7b32d6', legendary: '#b25e00', mythic: '#d81b57' })[r] ?? '#5f6b78';

/** How a rarity's name reads on its card: outlined white on candy's bright cards, the rarity's light hue on dark ones, its deep hue on light ones. */
export function rarityLabel(c: Ctx, r: string): { color: string; stroke?: MockStroke } {
  // By the card's own ink: outlined (bright gradient cards) → outlined white; light text (dark cards) → the rarity's
  // light hue; dark text (light cards) → its deep hue.
  const card = c.L.ink('card');
  if (card.stroke && c.L.base === 'candy') return { color: '#ffffff', stroke: card.stroke };
  const h = String(card.color).replace('#', '');
  const light = (0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16)) / 255 > 0.5;
  return light ? { color: String(c.L.rarity(r)) } : { color: rarityInk(r) };
}

/** A soft halo and a pedestal under a hero's art: what makes an offer's prize the thing to look at. */
function heroStage(c: Ctx, rarity: string, cx: number, top: number, s: number, sx = 0.5): MockNode[] {
  const hue = String(c.L.rarity(rarity));
  const g = Math.round(s * 1.08);
  return [
    { name: 'Glow', cls: 'Frame', ...place(box(cx, top + Math.round(s * 0.5), g, g, { sx, ax: 0.5, ay: 0.5 })), bg: '#ffffff', bgT: 0.5, corner: [0.5, 0], gradient: { rot: 90, colors: [[0, '#ffffff'], [1, hue]], transp: [[0, 0.1], [1, 0.6]] }, shadow: { color: hue, t: 0.15, blur: Math.round(s * 0.4), spread: Math.round(s * 0.08), offset: [0, 0] }, z: 2, note: 'A soft halo in the prize\'s rarity (spins slowly)' },
    { ...skinned(c, 'Frame', 'Pedestal', 'pill', undefined, box(cx, top + Math.round(s * 0.84), Math.round(s * 0.92), Math.round(s * 0.2), { sx, ax: 0.5 })), z: 2, note: 'What the prize stands on' },
  ];
}

export interface CardOpts {
  order?: number;
  buyLabel?: string;
  /** The player's balance: a price above it starts the buy button disabled. */
  balance?: number;
  /** The featured offer leading a phone's grid: its art glows. */
  hero?: boolean;
}

/** A shop card: rarity art, the item's art, its name and rarity, a buy button with the price (or, locked, what unlocks it). */
export function itemCard(c: Ctx, name: string, it: Item & { locked?: string }, w: number, h: number, glyph: string, o: CardOpts = {}): MockNode {
  const { f, L } = c;
  const btnH = Math.max(f.tap - (f.phone ? 0 : 4), Math.round(h * 0.2));
  const pad = Math.round(Math.max(8, w * 0.06));
  const artY = Math.round(h * 0.06);
  // The art takes what the name, the rarity and the button leave.
  const artS = Math.round(Math.max(24, Math.min(w * 0.6, h - artY - 2 - (f.ts.h2 + 4) - (f.ts.small + 6) - btnH - pad - 4)));
  const nameY = artY + artS + 2;
  const locked = !!it.locked;
  const kids: MockNode[] = [];
  if (o.hero) kids.push(...heroStage(c, it.rarity, 0, artY, artS));
  kids.push(icon(c, 'Art', it.glyph, box(0, artY, artS, artS, { sx: 0.5, ax: 0.5 }), it.rarity, { z: 3, ...(locked ? { skin: L.skin('icon', it.glyph, `${it.rarity}:disabled`) } : {}) }));
  kids.push(text(c, 'ItemName', it.name, 'h2', 'card', box(pad, nameY, w - 2 * pad, f.ts.h2 + 6), { z: 3, truncate: true }));
  kids.push(text(c, 'Rarity', it.rarity.toUpperCase(), 'small', 'card', box(pad, nameY + f.ts.h2 + 4, w - 2 * pad, f.ts.small + 4), { z: 3, ink: rarityLabel(c, it.rarity) }));
  if (locked) {
    // Something to aim for: greyed, a padlock on it, what unlocks it on the button.
    const lk = Math.round(artS * 0.42);
    kids.push(icon(c, 'Lock', 'lock', box(0, artY + Math.round(artS * 0.29), lk, lk, { sx: 0.5, ax: 0.5 }), undefined, { z: 4 }));
    kids.push(button(c, 'Buy', it.locked!, box(0, -pad, w - 2 * pad, btnH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 }), { icon: 'lock', disable: true, role: 'small', more: { state: 'disabled' }, note: `Locked until ${it.locked}: something to aim for` }));
  } else {
    const cant = o.balance !== undefined && amountOf(it.price) > o.balance;
    kids.push(button(c, 'Buy', o.buyLabel ?? it.price ?? 'Buy', box(0, -pad, w - 2 * pad, btnH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 }), { coin: glyph, disable: true, ...(cant ? { more: { state: 'disabled' as const } } : {}), note: `Buys ${it.name}: the server checks the price (disabled while the player can't afford it)` }));
  }
  const ts = Math.round(Math.max(f.phone ? 44 : 52, w * 0.27));
  if (it.tag) kids.push(tag(c, 'Tag', it.tag, box(-4, 4, ts, ts, { sx: 1, ax: 1 }), { rot: -12 }));
  return { ...skinned(c, 'Frame', name, 'card', it.rarity, box(0, 0, w, h)), ...(locked ? { skin: L.skin('card', it.rarity, 'disabled') } : {}), ...(o.order !== undefined ? { order: o.order } : {}), kids };
}

/** Tabs side by side (or stacked): every tab lights when selected, the open one starts selected; a count badge on any. */
export function tabs(c: Ctx, names: string[], current: number, o: { x: number; y: number; w: number; h: number; vertical?: boolean; gap?: number; badges?: Array<string | undefined> }): MockNode {
  const gap = o.gap ?? c.f.gap;
  const n = names.length;
  const each = o.vertical ? (o.h - gap * (n - 1)) / n : (o.w - gap * (n - 1)) / n;
  const size = Math.round(c.f.ts.button * c.L.scale('button'));
  return {
    name: 'Tabs',
    cls: 'Frame',
    pos: [0, Math.round(o.x), 0, Math.round(o.y)],
    size: [0, Math.round(o.w), 0, Math.round(o.h)],
    bgT: 1,
    note: 'Categories: ui.setState(path, "selected") switches the open tab; a tap swaps the grid (Motion swap)',
    kids: names.map((t, i) => {
      const b = o.vertical ? box(0, Math.round(i * (each + gap)), o.w, Math.round(each)) : box(Math.round(i * (each + gap)), 0, Math.round(each), o.h);
      const tab = tabButton(c, `Tab${i + 1}`, t, i === current, b, size);
      const badge = o.badges?.[i];
      if (badge) {
        const s = Math.round(Math.max(c.f.ts.small + 6, Math.min(b.h, b.w) * 0.5));
        tab.kids = [...(tab.kids ?? []), tag(c, 'Badge', badge, box(Math.round(s * 0.3), -Math.round(s * 0.35), s, s, { sx: 1, ax: 1 }), { size: Math.round(s * 0.5) })];
      }
      return tab;
    }),
  };
}

/** A grid of cards in a scrolling frame (the game fills it), inset so the cards' art isn't clipped. */
export function cardGrid(name: string, b: { x: number; y: number; w: number; h: number }, cell: [number, number], gap: number, cards: MockNode[], note: string): MockNode {
  const cols = Math.max(1, Math.floor((b.w - 2 * GRID_PAD + gap) / (cell[0] + gap)));
  const rows = Math.ceil(cards.length / cols);
  const contentH = rows * cell[1] + (rows - 1) * gap + 2 * GRID_PAD;
  return {
    name,
    cls: 'ScrollingFrame',
    pos: [0, Math.round(b.x), 0, Math.round(b.y)],
    size: [0, Math.round(b.w), 0, Math.round(b.h)],
    bgT: 1,
    canvas: [0, 0, 0, Math.max(Math.round(b.h), contentH)],
    padding: [[0, GRID_PAD], [0, GRID_PAD], [0, GRID_PAD], [0, GRID_PAD]],
    grid: { cell: [0, cell[0], 0, cell[1]], pad: [0, gap, 0, gap], dir: 'Horizontal', h: 'Center', v: 'Top' },
    note,
    kids: cards.map((k, i) => ({ ...k, order: k.order ?? i })),
  };
}

/** The size of a grid's cells: `cols` across its inner width, at most `rows` rows tall in its height, of an aspect. */
export function cells(w: number, h: number, cols: number, gap: number, aspect: number, rows?: number): [number, number] {
  // A few points of slack: the grid fits columns after the screen's UIScale, where an exact fit can round to one fewer.
  const cw = Math.floor((w - 2 * GRID_PAD - (cols - 1) * gap - 4) / cols);
  const ch = Math.round(cw * aspect);
  return [cw, rows ? Math.min(ch, Math.floor((h - 2 * GRID_PAD - (rows - 1) * gap) / rows)) : ch];
}

type Featured = Item & { blurb: string; was: string; ends: string; boost: string; odds: Array<{ glyph: string; rarity: Item['rarity']; chance: string }> };

/** What can come out of the featured prize: small rarity slots with their chances. */
function odds(c: Ctx, f: Featured, b: Box, label = true): MockNode {
  const { f: form } = c;
  const n = f.odds.length;
  const labelH = label ? form.ts.small + 6 : 0;
  const pctH = form.ts.small + 4;
  const s = Math.floor(Math.min((b.w - (n - 1) * 8) / n, b.h - labelH - pctH - 4, 72));
  const x0 = Math.round((b.w - (n * s + (n - 1) * 8)) / 2);
  return {
    name: 'Odds',
    cls: 'Frame',
    ...place(b),
    bgT: 1,
    note: 'What it can give and the chance of each (from the server\'s loot table)',
    kids: [
      ...(label ? [text(c, 'Label', 'CAN HATCH', 'small', 'card', box(0, 0, b.w, labelH), { z: 3, ...c.L.font('button') })] : []),
      ...f.odds.map((o, i) => {
        const slot = slotTile(c, 'Slot', { glyph: o.glyph, rarity: o.rarity }, s);
        delete slot.states;
        return { name: `Chance${i + 1}`, cls: 'Frame', ...place(box(x0 + i * (s + 8), labelH, s, s + pctH + 2)), bgT: 1, kids: [{ ...slot, cls: 'ImageLabel' }, text(c, 'Chance', o.chance, 'small', 'card', box(-6, s + 2, s + 12, pctH), { z: 3, ...c.L.font('num'), ink: rarityLabel(c, o.rarity) })] };
      }),
    ],
  };
}

/** A small chip with a multiplier ("LUCK x1.5"). */
function boostChip(c: Ctx, word: string, b: Box): MockNode {
  return { ...skinned(c, 'Frame', 'Boost', 'pill', undefined, b), z: 6, note: 'What owning it multiplies', kids: [icon(c, 'Icon', c.L.base === 'neon' ? 'zap' : 'clover', box(Math.round(b.h * 0.12), 0, Math.round(b.h * 0.8), Math.round(b.h * 0.8), { sy: 0.5, ay: 0.5 }), 'legendary', { z: 7 }), text(c, 'Word', word, 'small', 'dark', box(Math.round(b.h * 0.98), 0, b.w - Math.round(b.h * 1.1), b.h), { z: 7, xAlign: 'Left', ...c.L.font('num') })] };
}

/** The featured offer: the prize big on a halo and pedestal, its multiplier, what it can give, the old price, a timer, BUY. */
function featured(c: Ctx, it: Featured, glyph: string, b: { x: number; y: number; w: number; h: number }, wide: boolean): MockNode {
  const { f } = c;
  const pad = Math.round(f.phone ? 12 : 18);
  const kids: MockNode[] = [];
  const btnH = Math.max(f.tap, Math.round(f.ts.button * 2.4));
  const timerH = Math.round(f.ts.small * 1.9);
  const chipH = Math.round(f.ts.small * 1.8);
  const timer = (bx: ReturnType<typeof box>): MockNode => ({
    ...skinned(c, 'Frame', 'Timer', 'pill', undefined, bx),
    note: 'Counts down to the offer\'s end (the end time comes from the server)',
    kids: [icon(c, 'Clock', 'timer', box(Math.round(timerH * 0.2), 0, Math.round(timerH * 0.78), Math.round(timerH * 0.78), { sy: 0.5, ay: 0.5 }), undefined, { z: 3 }), text(c, 'Time', it.ends, 'small', 'dark', box(Math.round(timerH * 1.05), 0, bx.w - Math.round(timerH * 1.25), timerH), { z: 3, ...c.L.font('num') })],
  });
  const buy = `BUY ${it.price ?? ''}`.trim();
  if (wide) {
    // A banner: the prize on the left, then its name, multiplier, odds, and the timer beside BUY.
    const artS = Math.round(Math.min(b.h - 2 * pad - 16, b.w * 0.3));
    const tx = pad * 2 + artS;
    const tw = b.w - tx - pad;
    // Rows: the name; the multiplier and the timer; the odds; BUY across the text column.
    const chipW = Math.round(Math.min(tw * 0.5, f.ts.small * 7.6));
    kids.push(boostChip(c, it.boost, box(tx, pad + f.ts.h1 + 14, chipW, chipH)));
    kids.push(...heroStage(c, it.rarity, pad + Math.round(artS / 2), pad + 6, artS, 0));
    kids.push(icon(c, 'Art', it.glyph, box(pad, pad + 6, artS, artS), it.rarity, { z: 3 }));
    kids.push(text(c, 'ItemName', it.name, 'h1', 'card', box(tx, pad + 4, tw, f.ts.h1 + 6), { xAlign: 'Left', z: 3, truncate: true }));
    const oy = pad + f.ts.h1 + chipH + 22;
    kids.push(odds(c, it, box(tx, oy, tw, Math.max(40, b.h - oy - btnH - pad - 8)), false));
    kids.push(timer(box(tx + chipW + 8, pad + f.ts.h1 + 14 + Math.round((chipH - timerH) / 2), tw - chipW - 8, timerH)));
    kids.push(button(c, 'Buy', buy, box(tx, -pad, tw, btnH, { sy: 1, ay: 1 }), { variant: 'premium', coin: glyph, disable: true, note: `Buys the featured ${it.name}` }));
  } else {
    // Tall: the multiplier, the prize as big as the card allows, its name, what it can give, the old price, the timer, BUY.
    const head = Math.round(f.ts.small * 2.2);
    const oddsH = f.ts.small + 6 + Math.round(Math.min(72, (b.w - 2 * pad) / 4.6)) + f.ts.small + 8;
    const fixed = head + chipH + 8 + (f.ts.h1 + 8) + oddsH + 12 + timerH + 10 + btnH + pad + 10;
    const artS = Math.round(Math.max(b.w * 0.4, Math.min(b.w * 0.62, b.h - fixed)));
    const spare = Math.max(0, b.h - fixed - artS);
    kids.push(boostChip(c, it.boost, box(pad, head, Math.round(Math.min(b.w - 2 * pad, f.ts.small * 7.6)), chipH)));
    let y = head + chipH + 8 + Math.round(spare * 0.3);
    kids.push(...heroStage(c, it.rarity, 0, y, artS));
    kids.push(icon(c, 'Art', it.glyph, box(0, y, artS, artS, { sx: 0.5, ax: 0.5 }), it.rarity, { z: 3, note: 'The prize (a prop: an egg, a chest, a crate)' }));
    y += artS + 4;
    kids.push(text(c, 'ItemName', it.name, 'h1', 'card', box(pad, y, b.w - 2 * pad, f.ts.h1 + 8), { z: 3, truncate: true }));
    y += f.ts.h1 + 8 + Math.round(spare * 0.25);
    kids.push(odds(c, it, box(pad, y, b.w - 2 * pad, oddsH)));
    kids.push(text(c, 'Was', `<s>${it.was}</s>`, 'body', 'card', box(pad, -pad - btnH - 10, Math.round((b.w - 2 * pad) * 0.4), timerH, { sy: 1, ay: 1 }), { z: 3, rich: true, textT: 0.2, xAlign: 'Left', note: 'The price before the deal, struck out' }));
    kids.push(timer(box(-pad, -pad - btnH - 10, Math.round((b.w - 2 * pad) * 0.56), timerH, { sx: 1, sy: 1, ax: 1, ay: 1 })));
    kids.push(button(c, 'Buy', buy, box(0, -pad, b.w - 2 * pad, btnH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 }), { variant: 'premium', coin: glyph, disable: true, note: `Buys the featured ${it.name}` }));
  }
  const rw = Math.round(Math.min(b.w * 0.62, f.ts.small * 9));
  // Tall: across the top; a banner: over the prize's corner, clear of its name.
  kids.push(ribbon(c, 'Ribbon', 'LIMITED', wide ? box(Math.round(pad * 0.5), -Math.round(f.ts.small * 0.7), Math.min(rw, Math.round(Math.min(b.h - 2 * pad - 16, b.w * 0.3) + pad)), Math.round(f.ts.small * 2.2)) : box(0, -Math.round(f.ts.small * 0.7), rw, Math.round(f.ts.small * 2.2), { sx: 0.5, ax: 0.5 })));
  kids.push(tag(c, 'Deal', '-50%', box(Math.round(f.ts.small * 0.5), -Math.round(f.ts.small * 0.9), Math.round(f.ts.small * 3.6), Math.round(f.ts.small * 3.6), { sx: 1, ax: 1 }), { rot: 10, size: f.ts.small - 2 }));
  return { ...skinned(c, 'Frame', 'Featured', 'card', it.rarity, box(b.x, b.y, b.w, b.h)), note: 'The featured offer (a limited deal)', kids };
}

const FEATURED: Record<string, { name: string; glyph: string; boost: string }> = {
  candy: { name: 'Golden Egg', glyph: 'egg', boost: 'LUCK x1.5' },
  ember: { name: 'War Chest', glyph: 'chest', boost: '+25% DMG' },
  neon: { name: 'Supply Drop', glyph: 'chest', boost: 'XP x2' },
  parchment: { name: 'Dragon Egg', glyph: 'egg', boost: 'LUCK x1.5' },
  frost: { name: 'Mystery Box', glyph: 'gift', boost: 'x2 STARS' },
};

function layout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const balance = amountOf(cur.amount);
  const title = content.str('title', world.shop.title);
  const tabList = content.list('tabs', world.shop.tabs.map((t, i) => ({ name: t, badge: i === 1 ? '3' : undefined })), (x, d) => ({ name: String(x.name ?? d?.name ?? 'Tab'), badge: typeof x.badge === 'string' || typeof x.badge === 'number' ? String(x.badge) : d?.badge })).slice(0, 5);
  const tabNames = tabList.map((t) => t.name);
  const badges = tabList.map((t) => t.badge);
  // Stickers and one item to aim for out of the box.
  const defaults = world.shop.items.slice(0, 8).map((it, i) => ({ ...it, ...(i === 3 ? { tag: 'HOT' } : {}), ...(i === 7 ? { locked: 'Rebirth 5' } : {}) }));
  const items = content.list('items', defaults, (x, d) => ({ ...readItem(x, d), ...(typeof x.locked === 'string' ? { locked: x.locked } : {}) })).slice(0, 12) as Array<Item & { locked?: string }>;
  const fx = content.obj('featured');
  const fd = FEATURED[L.base] ?? FEATURED.candy!;
  const pool = world.shop.items;
  const base = { ...world.shop.featured, name: fd.name, glyph: fd.glyph, rarity: 'mythic' as const };
  const feat: Featured = {
    ...base,
    ...readItem(fx, base),
    boost: typeof fx.boost === 'string' ? fx.boost : fd.boost,
    odds: Array.isArray(fx.odds) && fx.odds.length
      ? (fx.odds as Array<Record<string, unknown>>).slice(0, 4).map((o) => ({ glyph: String(o.glyph ?? 'star'), rarity: (['common', 'rare', 'epic', 'legendary', 'mythic'].includes(String(o.rarity)) ? o.rarity : 'common') as Item['rarity'], chance: String(o.chance ?? '') }))
      : [
          { glyph: pool[0]!.glyph, rarity: 'common', chance: '60%' },
          { glyph: pool[1]!.glyph, rarity: 'rare', chance: '30%' },
          { glyph: pool[2]!.glyph, rarity: 'epic', chance: '9%' },
          { glyph: pool[3]!.glyph, rarity: 'legendary', chance: '1%' },
        ],
  };
  const want: [number, number] = f.portrait ? [f.w - 24, f.h - 40] : f.phone ? [f.w, f.h] : f.tv ? [1500, 800] : f.form === 'tablet' ? [1340, 790] : [1300, 780];
  const [W, H] = fitWindow(c, want);
  const win = window(c, { title, w: W, h: H, currency: { glyph: cur.glyph, amount: cur.amount, plus: true }, hints: [['LB RB', 'Tabs']] }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const card = (it: Item & { locked?: string }, i: number, cw: number, ch: number) => itemCard(c, `Item${i + 1}`, it, cw, ch, cur.glyph, { balance });
    if (f.portrait) {
      const th = f.tap;
      kids.push(tabs(c, tabNames, 0, { x: 0, y: 0, w: bw, h: th, gap: 6, badges }));
      const fh = Math.round(Math.min(230, bh * 0.3));
      kids.push(featured(c, feat, cur.glyph, { x: 0, y: th + g + 12, w: bw, h: fh }, true));
      const gy = th + g + 12 + fh + g - GRID_PAD;
      const [cw, ch] = cells(bw, bh - gy, 2, g, 1.24);
      kids.push(cardGrid('Grid', { x: 0, y: gy, w: bw, h: bh - gy }, [cw, ch], g, items.map((it, i) => card(it, i, cw, ch)), 'The items of the current tab (the game fills it from its catalogue)'));
    } else if (f.phone) {
      // Tabs down the left (thumb side), the grid beside them; the featured offer leads the grid.
      const tw = 132;
      kids.push(tabs(c, tabNames, 0, { x: 0, y: 6, w: tw, h: Math.min(bh - 6, tabNames.length * (f.tap + 8) - 8), vertical: true, gap: 8, badges }));
      const gx = tw + 4;
      const gw = bw - gx;
      const [cw, ch] = cells(gw, bh, 3, g, 1.34, 1);
      // The featured offer leads the grid (order -1), listed last so a phone's layout is the others' plus this card.
      const cards = [...items.map((it, i) => ({ ...card(it, i, cw, ch), order: i })), itemCard(c, 'Item0', { ...feat, tag: '-50%' }, cw, ch, cur.glyph, { buyLabel: feat.price, hero: true, order: -1 })];
      kids.push(cardGrid('Grid', { x: gx, y: 0, w: gw, h: bh }, [cw, ch], g, cards, 'The items of the current tab, the featured offer first (the game fills it)'));
    } else {
      const th = Math.round(f.ts.button * 2.2);
      const fw = Math.round(Math.min(bw * 0.28, f.tv ? 400 : 360));
      const gx = fw + Math.round(g * 1.5);
      kids.push(tabs(c, tabNames, 0, { x: gx + GRID_PAD, y: 0, w: Math.min(bw - gx - 2 * GRID_PAD, tabNames.length * (f.tv ? 220 : 190)), h: th, gap: 10, badges }));
      kids.push(featured(c, feat, cur.glyph, { x: 0, y: Math.round(f.ts.small * 1.5), w: fw, h: bh - Math.round(f.ts.small * 1.5) }, false));
      const gw = bw - gx;
      const gy = th + g - GRID_PAD + 4;
      const [cw, ch] = cells(gw, bh - gy, f.tv ? 3 : 4, g, 1.32, 2);
      kids.push(cardGrid('Grid', { x: gx, y: gy, w: gw, h: bh - gy }, [cw, ch], g, items.map((it, i) => card(it, i, cw, ch)), 'The items of the current tab (the game fills it from its catalogue)'));
    }
    return kids;
  });
  return [win];
}

export const shop: Template = {
  id: 'shop',
  label: 'Shop',
  for: 'Any in-game store: category tabs with count badges, a grid of items by rarity with prices (NEW/HOT stickers, one locked to aim for, buys greyed when the player can\'t afford them), the balance with a +, and a featured limited offer — the prize on a halo and pedestal, its multiplier, its odds, a timer and BUY',
  contentShape: 'title, currency {glyph, amount}, tabs [name | {name, badge}], items [{name, glyph, rarity, price, tag, locked}], featured {name, glyph, rarity, price, was, ends, boost, odds [{glyph, rarity, chance}]}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Shop', hides: MENU_HIDES, displayOrder: 10, forms: MENU_FORMS, note: 'The shop: opened from the HUD\'s shop button or a shopkeeper', build: (f) => layout(L, f, content) });
    const motion: MockMotion[] = [
      { play: 'open', target: 'Shop.Window' },
      { play: 'enter', target: 'Shop.Window.Body.Grid', from: 'up', gap: 0.03, delay: 0.05 },
      { play: 'count', target: 'Shop.Window.Balance.Amount', from: 0, to: amountOf(readCurrency(content.obj('currency'), worldOf(L.id).currency).amount) || 0, when: 'coins change', seconds: 0.6 },
      { play: 'pulse', target: 'Shop.Window.Body.Featured.Buy', when: 'loop', amount: 0.05, seconds: 1.4 },
      { play: 'float', target: 'Shop.Window.Body.Featured.Art', when: 'loop', amount: 6, seconds: 2.4 },
      { play: 'spin', target: 'Shop.Window.Body.Featured.Glow', when: 'loop', seconds: 8 },
      { play: 'shimmer', target: 'Shop.Window.Body.Featured', when: 'loop', seconds: 3 },
      { play: 'punch', target: 'Shop.Window.Balance', when: 'purchase', amount: 0.12 },
    ];
    return {
      screens: [{ name: 'ShopDim', insets: 'None', displayOrder: 9, note: 'Dims the game behind Shop; shown and hidden with it', kids: [{ name: 'Dim', cls: 'Frame', size: [1, 0, 1, 0], bg: '#05030a', bgT: 0.45, appear: 'fade' }] }, screen],
      motion,
      notes: [
        'Fill Shop.Window.Body.Grid from the catalogue (one card per item: clone Item1); the tab buttons swap its contents and ui.setState(tab, "selected") moves the open tab.',
        'Buy buttons ask the server, which checks the price and the balance; a buy the player can\'t afford starts disabled (state "disabled"); on success punch the balance and count it down.',
        'A locked item (locked: "Rebirth 5") is greyed with a padlock: something to aim for.',
        'The featured offer, its odds and its timer come from the server (the end time as a timestamp); its Art takes a prop icon ("dir:icon:egg:mythic").',
        'Phones show the tabs down the left and the featured offer as the grid\'s first card; an upright phone shows it as a banner; a TV shows the controller hints.',
      ],
    };
  },
};
