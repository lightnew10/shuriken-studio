import type { MockMotion, MockNode } from '@shared/ui-mockup';
import { Content, readItem, worldOf, type Item } from './content';
import { composeScreen, MENU_HIDES, MENU_FORMS, type FormCtx } from './forms';
import { lookOf, type Look } from './look';
import { bar, box, button, currency, fitWindow, icon, iconButton, menuScreens, skinned, slotTile, statLine, text, window, type Ctx } from './parts';
import { cardGrid, cells, rarityLabel, tabs } from './shop';
import type { Template, TemplateInput, TemplateOutput } from './types';

const STAT_GLYPHS = ['coins', 'zap', 'clover', 'heart', 'shield'];

/** The selected item, big: its art, name, rarity, stats, and what can be done with it. */
function details(c: Ctx, it: Item, stats: Array<[string, string]>, b: { x: number; y: number; w: number; h: number }, wide: boolean): MockNode {
  const { f } = c;
  const pad = f.phone ? 12 : 18;
  const kids: MockNode[] = [];
  const btnH = Math.max(f.tap, Math.round(f.ts.button * 2.2));
  const small = Math.max(f.tap, Math.round(btnH));
  // What fits above the buttons at the bottom: rows that would sit under them are left out (a big display face on a
  // short panel has room for fewer).
  const room = b.h - pad - btnH - 8;
  if (wide) {
    const art = Math.round(Math.min(b.h - 2 * pad, b.w * 0.3));
    const tx = pad * 2 + art;
    const tw = b.w - tx - pad;
    kids.push(icon(c, 'Art', it.glyph, box(pad, 0, art, art, { sy: 0.5, ay: 0.5 }), it.rarity, { z: 3 }));
    kids.push(text(c, 'ItemName', it.name, 'h1', 'card', box(tx, pad, tw, f.ts.h1 + 6), { xAlign: 'Left', z: 3 }));
    kids.push(text(c, 'Rarity', it.rarity.toUpperCase(), 'small', 'card', box(tx, pad + f.ts.h1 + 4, tw, f.ts.small + 4), { xAlign: 'Left', z: 3, ink: rarityLabel(c, it.rarity) }));
    const sy = pad + f.ts.h1 + f.ts.small + 14;
    stats.slice(0, 2).forEach(([k, v], i) => {
      const top = sy + i * (f.ts.h2 + 10);
      if (top + f.ts.h2 + 4 <= room) kids.push(statLine(c, `Stat${i + 1}`, STAT_GLYPHS[i]!, k, v, box(tx, top, tw, f.ts.h2 + 4)));
    });
    kids.push(button(c, 'Equip', 'Equip', box(tx, -pad, tw - small - 10, btnH, { sy: 1, ay: 1 }), { note: 'Equips the selected item (the server checks the slots)' }));
    kids.push(iconButton(c, 'Lock', 'lock', box(-pad, -pad, small, small, { sx: 1, sy: 1, ax: 1, ay: 1 }), { variant: 'secondary', note: 'Locks it against selling and deleting' }));
  } else {
    const art = Math.round(Math.min(b.w * 0.66, b.h * 0.34));
    let y = pad + (f.phone ? 0 : Math.round(b.h * 0.03));
    kids.push(icon(c, 'Art', it.glyph, box(0, y, art, art, { sx: 0.5, ax: 0.5 }), it.rarity, { z: 3 }));
    y += art + 4;
    kids.push(text(c, 'ItemName', it.name, 'h1', 'card', box(pad, y, b.w - 2 * pad, f.ts.h1 + 8), { z: 3 }));
    y += f.ts.h1 + 6;
    kids.push(text(c, 'Rarity', it.rarity.toUpperCase(), 'small', 'card', box(pad, y, b.w - 2 * pad, f.ts.small + 4), { z: 3, ink: rarityLabel(c, it.rarity) }));
    y += f.ts.small + (f.phone ? 10 : 18);
    const rh = f.ts.h2 + (f.phone ? 6 : 14);
    const rows = Math.max(0, Math.min(f.phone ? 2 : stats.length, Math.floor((room - y + 8) / (rh + 8))));
    stats.slice(0, rows).forEach(([k, v], i) => kids.push(statLine(c, `Stat${i + 1}`, STAT_GLYPHS[i]!, k, v, box(pad, y + i * (rh + 8), b.w - 2 * pad, rh))));
    const ly = y + rows * (rh + 8) + 10;
    if (!f.phone && ly + f.ts.small + 10 + Math.round(f.ts.small * 1.5) <= room) {
      // Its level: the experience it has towards the next.
      kids.push(text(c, 'LevelLabel', 'Level 22', 'small', 'card', box(pad, ly, b.w - 2 * pad, f.ts.small + 6), { xAlign: 'Left', z: 3 }));
      kids.push(bar(c, 'Level', box(pad, ly + f.ts.small + 10, b.w - 2 * pad, Math.round(f.ts.small * 1.5)), 0.64, { label: '640 / 1,000 XP', note: 'Experience to its next level' }));
    }
    kids.push(button(c, 'Equip', 'Equip', box(pad, -pad, b.w - 3 * pad - small, btnH, { sy: 1, ay: 1 }), { note: 'Equips the selected item (the server checks the slots)' }));
    kids.push(iconButton(c, 'Delete', 'trash-2', box(-pad, -pad, small, small, { sx: 1, sy: 1, ax: 1, ay: 1 }), { variant: 'danger', note: 'Deletes it after a confirm dialog' }));
  }
  return { ...skinned(c, 'Frame', 'Details', 'card', it.rarity, box(b.x, b.y, b.w, b.h)), note: 'The selected item: tapping a slot shows it here', kids };
}

function layout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const title = content.str('title', world.inventory.title);
  // A bag holds duplicates: the defaults repeat the world's items to a full-looking bag.
  const base = content.list('items', world.inventory.items, readItem);
  const items = (content.list('items', [], readItem).length ? base : Array.from({ length: 24 }, (_, i) => base[(i * 5) % base.length]!)).slice(0, 30);
  const stats = content.list('stats', world.inventory.stats, (x, d) => [String(x.name ?? x.label ?? d?.[0] ?? ''), String(x.value ?? d?.[1] ?? '')] as [string, string]);
  const filters = content.strs('tabs', ['All', 'Equipped', 'Best']);
  const capacity = content.str('capacity', `${items.length}/50`);
  const equipped = new Set([1, 3, 4]);
  const selected = 3;
  const want: [number, number] = f.portrait ? [f.w - 24, f.h - 40] : f.phone ? [f.w, f.h] : f.tv ? [1480, 790] : f.form === 'tablet' ? [1340, 780] : [1280, 760];
  const [W, H] = fitWindow(c, want);
  const sel = items[selected]!;
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const slots = (size: number) => items.map((it, i) => slotTile(c, `Slot${i + 1}`, { glyph: it.glyph, rarity: it.rarity, level: it.count !== undefined ? `x${it.count}` : `Lv ${(i * 7) % 30 + 1}`, equipped: equipped.has(i), selected: i === selected, locked: i === 4 }, size, { note: i === 0 ? 'One slot per item the player owns (the game clones it)' : undefined }));
    if (f.portrait) {
      const dh = Math.round(Math.min(230, bh * 0.3));
      kids.push(details(c, sel, stats, { x: 0, y: 0, w: bw, h: dh }, true));
      const ty = dh + g;
      kids.push(tabs(c, filters, 0, { x: 0, y: ty, w: bw, h: f.tap - 4, gap: 6 }));
      const gy = ty + f.tap + g;
      const cols = 4;
      const [s] = cells(bw, 0, cols, g, 1);
      kids.push(cardGrid('Grid', { x: 0, y: gy, w: bw, h: bh - gy }, [s, s], g, slots(s), 'Every item the player owns'));
    } else {
      const dw = Math.round(bw * (f.phone ? 0.36 : 0.3));
      const lw = bw - dw - g * 1.5;
      const th = f.phone ? f.tap - 6 : Math.round(f.ts.button * 2);
      // The row over the grid: filter tabs, and how full the bag is.
      // Details first in every layout (an upright phone puts it on top), so the forms differ only by changes.
      kids.push(details(c, sel, stats, { x: bw - dw, y: 0, w: dw, h: bh }, false));
      kids.push(tabs(c, filters, 0, { x: 0, y: 0, w: Math.min(lw * 0.62, filters.length * (f.phone ? 104 : 160)), h: th, gap: 8 }));
      kids.push(currency(c, 'Capacity', 'backpack', capacity, box(-(dw + g * 1.5), Math.round((th - Math.round(th * 0.8)) / 2), Math.round(Math.min(lw * 0.3, f.phone ? 120 : 190)), Math.round(th * 0.8), { sx: 1, ax: 1 }), { icon: true, note: 'Items owned of the most the bag holds' }));
      const gy = th + g;
      const cols = f.phone ? 4 : f.tv ? 5 : 6;
      const [s] = cells(lw, 0, cols, g, 1);
      kids.push(cardGrid('Grid', { x: 0, y: gy, w: lw, h: bh - gy }, [s, s], g, slots(s), 'Every item the player owns'));
    }
    return kids;
  });
  return [win];
}

export const inventory: Template = {
  id: 'inventory',
  label: 'Inventory',
  for: 'Pets, weapons, gear or items the player owns: a grid of rarity slots (equipped, locked, levels), filter tabs, the bag\'s capacity, and the selected item in a details panel with Equip',
  contentShape: 'title, tabs [filters], capacity "24/50", items [{name, glyph, rarity, count}], stats [{name, value}] (of the selected item)',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Inventory', hides: MENU_HIDES, forms: MENU_FORMS, note: 'The inventory: opened from the HUD\'s bag button', build: (f) => layout(L, f, content) });
    const motion: MockMotion[] = [
      { play: 'open', target: 'Inventory.Window' },
      { play: 'enter', target: 'Inventory.Window.Body.Grid', from: 'pop', gap: 0.02, delay: 0.05 },
      { play: 'float', target: 'Inventory.Window.Body.Details.Art', when: 'loop', amount: 5, seconds: 2.6 },
      { play: 'punch', target: 'Inventory.Window.Body.Details', when: 'a slot is picked', amount: 0.06 },
      { play: 'punch', target: 'Inventory.Window.Body.Details.Equip', when: 'equipped', amount: 0.1 },
    ];
    return {
      screens: menuScreens('Inventory', screen),
      motion,
      notes: [
        'Clone Slot1 per owned item into Inventory.Window.Body.Grid; a tap moves the Selected ring and fills Details.',
        'Equip and Delete go through the server; the Equipped check shows on equipped slots.',
        'The filter tabs re-sort the grid (All, Equipped, Best); Capacity reads owned/max.',
        'Phones keep the details panel beside the grid; an upright phone puts it on top as a banner.',
      ],
    };
  },
};

/** The collection: what the player has found of a set, the rest as silhouettes, and the prize for finishing it. */
function indexLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const title = content.str('title', L.base === 'candy' ? 'PET INDEX' : L.base === 'ember' ? 'BESTIARY' : L.base === 'neon' ? 'DATABASE' : L.base === 'parchment' ? 'Compendium' : 'Collection');
  const sets = content.strs('tabs', L.base === 'candy' ? ['Spawn', 'Candy', 'Lava', 'Space'] : L.base === 'ember' ? ['Pit', 'Forge', 'Ashlands', 'Abyss'] : L.base === 'neon' ? ['Sector 1', 'Sector 2', 'Orbit', 'Core'] : L.base === 'parchment' ? ['Shire', 'Marsh', 'Peaks', 'Crypt'] : ['Basics', 'Street', 'Party', 'Rare']);
  const known = content.list('items', world.shop.items, readItem);
  const found = Math.min(content.num('found', 9), known.length);
  const total = Math.max(found, content.num('total', 24));
  const items = Array.from({ length: Math.min(total, 40) }, (_, i) => known[i % known.length]!);
  const reward = content.str('reward', L.base === 'candy' ? 'x2 Luck' : L.base === 'ember' ? '+10% DMG' : L.base === 'neon' ? 'Gold decal' : L.base === 'parchment' ? 'Royal title' : 'Gold frame');
  const want: [number, number] = f.portrait ? [f.w - 24, f.h - 40] : f.phone ? [f.w, f.h] : f.tv ? [1480, 790] : f.form === 'tablet' ? [1340, 780] : [1280, 760];
  const [W, H] = fitWindow(c, want);
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    // The progress strip: found of total, and the prize for finishing.
    const ph = Math.round(Math.max(f.tap, f.ts.h1 * 2.4));
    const rewardW = Math.round(Math.min(bw * (f.portrait ? 0.42 : 0.3), f.phone ? 230 : 360));
    const pw = bw - rewardW - g;
    kids.push({
      ...skinned(c, 'Frame', 'Progress', 'card', 'common', box(0, 0, pw, ph)),
      note: 'How much of the set the player has found',
      kids: [
        text(c, 'Found', `${found} / ${total} found`, 'h2', 'card', box(16, 6, pw - 32, Math.round(ph * 0.42)), { xAlign: 'Left', z: 3 }),
        bar(c, 'Bar', box(16, -Math.round(ph * 0.16), pw - 32, Math.round(Math.max(16, ph * 0.28)), { sy: 1, ay: 1 }), found / total, { label: `${Math.round((found / total) * 100)}%`, labelRole: 'small' }),
      ],
    });
    kids.push({
      ...skinned(c, 'Frame', 'Prize', 'card', 'legendary', box(-0, 0, rewardW, ph, { sx: 1, ax: 1 })),
      note: 'The prize for finding every one',
      kids: [
        icon(c, 'Icon', 'gift', box(10, 0, Math.round(ph * 0.72), Math.round(ph * 0.72), { sy: 0.5, ay: 0.5 }), 'legendary', { z: 3 }),
        text(c, 'Label', 'Complete for', 'small', 'card', box(Math.round(ph * 0.72) + 18, Math.round(ph * 0.1), rewardW - Math.round(ph * 0.72) - 26, Math.round(ph * 0.36)), { xAlign: 'Left', z: 3 }),
        text(c, 'Reward', reward, 'h2', 'card', box(Math.round(ph * 0.72) + 18, Math.round(ph * 0.46), rewardW - Math.round(ph * 0.72) - 26, Math.round(ph * 0.42)), { xAlign: 'Left', z: 3, ...c.L.font('num') }),
      ],
    });
    const ty = ph + g;
    const th = f.phone ? f.tap - 6 : Math.round(f.ts.button * 2);
    kids.push(tabs(c, sets, 0, { x: 0, y: ty, w: Math.min(bw, sets.length * (f.phone ? (f.portrait ? 106 : 128) : 190)), h: th, gap: 8 }));
    const gy = ty + th + g;
    const cols = f.portrait ? 4 : f.phone ? 6 : 7;
    const [s] = cells(bw, 0, cols, g, 1);
    const tiles = items.map((it, i) => slotTile(c, `Entry${i + 1}`, { glyph: it.glyph, rarity: it.rarity, hidden: i >= found, ...(i < found ? { level: `#${i + 1}` } : {}) }, s, { note: i === 0 ? 'One per creature of the set: found ones in colour, the rest a silhouette' : undefined }));
    kids.push(cardGrid('Grid', { x: 0, y: gy, w: bw, h: bh - gy }, [s, s], g, tiles, 'The set, in index order'));
    return kids;
  });
  return [win];
}

export const collection: Template = {
  id: 'collection',
  label: 'Collection index',
  for: 'A pet index, bestiary or set to complete: found entries in colour, the rest as silhouettes, progress to the prize for finishing, a tab per world',
  contentShape: 'title, tabs [worlds], items [{name, glyph, rarity}], found, total, reward',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Index', hides: MENU_HIDES, forms: MENU_FORMS, note: 'The collection index', build: (f) => indexLayout(L, f, content) });
    return {
      screens: menuScreens('Index', screen),
      motion: [
        { play: 'open', target: 'Index.Window' },
        { play: 'enter', target: 'Index.Window.Body.Grid', from: 'pop', gap: 0.015, delay: 0.05 },
        { play: 'shimmer', target: 'Index.Window.Body.Prize', when: 'loop', seconds: 3.2 },
        { play: 'punch', target: 'Index.Window.Body.Progress', when: 'a new entry is found', amount: 0.08 },
      ],
      notes: ['Fill Index.Window.Body.Grid from the set: found entries show their art and number, the rest stay "?".', 'The progress bar and Found count come from the player\'s data; the prize is claimed when the set is complete.'],
    };
  },
};
