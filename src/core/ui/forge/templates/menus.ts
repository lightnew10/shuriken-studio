import type { MockMotion, MockNode } from '@shared/ui-mockup';
import { Content, readCurrency, worldOf } from './content';
import { composeScreen, MENU_HIDES, MENU_FORMS, type FormCtx } from './forms';
import { lookOf, type Look } from './look';
import { art, bar, box, button, fitRows, coin, fitWindow, icon, menuScreens, place, skinned, slider, slotTile, tabButton, text, toggle, window, type Box, type Ctx } from './parts';
import { rarityLabel, tabs } from './shop';
import type { Template, TemplateInput, TemplateOutput } from './types';

const by = (L: Look, names: Record<string, string>, def: string) => names[L.base] ?? def;
const WANT = (f: FormCtx, desk: [number, number]): [number, number] => (f.portrait ? [f.w - 24, f.h - 60] : f.phone ? [f.w, f.h] : f.tv ? [Math.round(desk[0] * 1.14), Math.round(desk[1] * 1.06)] : f.form === 'tablet' ? [Math.round(desk[0] * 1.04), desk[1]] : desk);

/** A plain row inside a window (the look's row: a soft fill and edge). */
function row(c: Ctx, name: string, b: Box, kids: MockNode[], more: Partial<MockNode> = {}): MockNode {
  const r = c.L.row;
  return { name, cls: 'Frame', ...place(b), bg: r.bg, bgT: r.bgT, corner: [0, r.corner], ...(r.stroke ? { stroke: r.stroke } : {}), kids, ...more };
}

/** A vertical list in a scrolling frame (rows given their order). */
function list(name: string, b: Box, rows: MockNode[], rowH: number, gap: number, note: string): MockNode {
  const h = rows.length * (rowH + gap);
  return { name, cls: 'ScrollingFrame', ...place(b), bgT: 1, canvas: [0, 0, 0, Math.max(b.h, h)], list: { dir: 'Vertical', h: 'Center', v: 'Top', pad: [0, gap] }, padding: [[0, 2], [0, 6], [0, 2], [0, 2]], note, kids: rows.map((r, i) => ({ ...r, order: i })) };
}

// ─── Quest log ────────────────────────────────────────────────────────────────────────────────────

function questLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const title = content.str('title', by(L, { candy: 'QUESTS', ember: 'CONTRACTS', neon: 'MISSIONS', parchment: 'Quest Log', frost: 'Challenges' }, 'QUESTS'));
  const quests = content.list('quests', world.quests, (x, d) => ({ name: String(x.name ?? d?.name ?? 'Quest'), detail: String(x.detail ?? d?.detail ?? ''), glyph: String(x.glyph ?? d?.glyph ?? 'star'), done: Number(x.done ?? d?.done ?? 0), of: Number(x.of ?? d?.of ?? 1), reward: String(x.reward ?? d?.reward ?? '100') })).slice(0, 8);
  const [W, H] = fitWindow(c, WANT(f, [1120, 700]));
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const th = f.phone ? f.tap - 6 : Math.round(f.ts.button * 2);
    const tabW = Math.min(bw * (f.portrait ? 1 : 0.5), (f.portrait ? 150 : f.phone ? 116 : 170) * 3);
    kids.push(tabs(c, content.strs('tabs', ['Daily', 'Weekly', 'Story']), 0, { x: 0, y: 0, w: tabW, h: th, gap: 8 }));
    // Claim all at the right of the tab row (an upright phone puts it under the tabs), the reset time beside it.
    const caW = Math.round(Math.min(f.portrait ? bw : bw * 0.26, f.phone ? 170 : 260));
    const caH = Math.max(f.tap, th);
    const caY = f.portrait ? th + g : Math.round((th - caH) / 2);
    kids.push(button(c, 'ClaimAll', 'Claim all', box(0, caY, caW, caH, { sx: 1, ax: 1 }), { variant: L.go, icon: 'gift', disable: true, note: 'Claims every finished quest' }));
    const restW = f.portrait ? bw - caW - g : bw - tabW - caW - 2 * g;
    if (restW > f.ts.small * 7) kids.push({ name: 'Resets', cls: 'Frame', ...place(box(f.portrait ? 0 : tabW + g, caY, restW, caH)), bgT: 1, note: 'Time until the quests reset', kids: [icon(c, 'Clock', 'timer', box(0, 0, Math.round(th * 0.56), Math.round(th * 0.56), { sy: 0.5, ay: 0.5 }), undefined, { z: 3 }), text(c, 'Time', f.phone ? '05:12:44' : 'Resets in 05:12:44', 'small', 'muted', box(Math.round(th * 0.56) + 8, 0, restW - Math.round(th * 0.56) - 8, caH), { xAlign: 'Left', z: 3 })] });
    const ly = (f.portrait ? caY + caH : th) + g;
    const lh = bh - ly;
    const rh = fitRows(quests.length, lh - 4, f.phone ? (f.portrait ? 150 : 76) : Math.round(f.ts.body * 4.6), Math.round(g * 0.75), f.phone ? f.tap : undefined);
    const rows = quests.map((q, i) => {
      const done = q.done >= q.of;
      const ic = Math.round(rh * (f.portrait ? 0.42 : 0.7));
      const btnW = f.phone ? (f.portrait ? 120 : 118) : Math.round(f.ts.button * 6);
      const btnH = Math.max(f.tap - (f.phone ? 0 : 6), Math.round(rh * 0.5));
      const rewardW = f.phone ? 92 : Math.round(f.ts.num * 5.2);
      const tx = ic + 24;
      const right = btnW + rewardW + 34;
      const tw = bw - 12 - tx - (f.portrait ? 16 : right);
      const fmt = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}K` : String(v));
      const detailH = f.phone && !f.portrait ? 0 : f.ts.small + 4;
      const barH = Math.round(f.ts.small * 1.15);
      const stackH = f.ts.h2 + 6 + detailH + 6 + barH;
      const stackY = f.portrait ? 10 : Math.max(4, Math.round((rh - stackH) / 2));
      const kidsRow: MockNode[] = [
        { ...art(c, 'IconFrame', 'iconFrame', box(12, f.portrait ? 12 : 0, ic, ic, { sy: f.portrait ? 0 : 0.5, ay: f.portrait ? 0 : 0.5 }), {}), z: 2, kids: [icon(c, 'Icon', q.glyph, box(0, 0, Math.round(ic * 0.6), Math.round(ic * 0.6), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), done ? 'legendary' : 'rare', { z: 3 })] },
        // Name, what to do, the bar: stacked and centred in the row (an upright phone keeps its reward and button below).
        text(c, 'QuestName', q.name, 'h2', 'panel', box(tx, stackY, tw, f.ts.h2 + 6), { xAlign: 'Left', z: 3, truncate: true }),
        ...(f.phone && !f.portrait ? [] : [text(c, 'Detail', q.detail, 'small', 'muted', box(tx, stackY + f.ts.h2 + 6, tw, f.ts.small + 4), { xAlign: 'Left', z: 3, truncate: true })]),
        bar(c, 'Progress', box(tx, stackY + f.ts.h2 + 6 + detailH + 6, Math.min(tw, f.portrait ? tw : 420), barH), Math.min(1, q.done / q.of), { label: `${fmt(Math.min(q.done, q.of))} / ${fmt(q.of)}`, note: 'How far along the quest is' }),
        { name: 'Reward', cls: 'Frame', ...place(f.portrait ? box(tx, stackY + stackH + 8, rewardW + 20, Math.min(btnH, rh - stackY - stackH - 16)) : box(-(btnW + 22), 0, rewardW, rh, { sx: 1, ax: 1 })), bgT: 1, note: 'What finishing it pays', kids: [coin(c, 'Coin', cur.glyph, box(0, 0, Math.round(f.ts.num * 1.5), Math.round(f.ts.num * 1.5), { sy: 0.5, ay: 0.5 }), { z: 3 }), text(c, 'Amount', q.reward, 'num', 'panel', box(Math.round(f.ts.num * 1.5) + 6, 0, rewardW - Math.round(f.ts.num * 1.5) - 6, rh > btnH && !f.portrait ? rh : btnH), { xAlign: 'Left', z: 3, scaled: true, textMax: f.ts.num, padding: [[0, 4], [0, 0], [0, 4], [0, 0]] })] },
        done ? button(c, 'Claim', 'Claim', box(-12, f.portrait ? -12 : 0, btnW, btnH, { sx: 1, sy: f.portrait ? 1 : 0.5, ax: 1, ay: f.portrait ? 1 : 0.5 }), { variant: L.go, note: 'Claims the reward' }) : button(c, 'Track', 'Track', box(-12, f.portrait ? -12 : 0, btnW, btnH, { sx: 1, sy: f.portrait ? 1 : 0.5, ax: 1, ay: f.portrait ? 1 : 0.5 }), { variant: 'secondary', note: 'Shows it in the HUD\'s tracker' }),
      ];
      return done ? { ...skinned(c, 'Frame', `Quest${i + 1}`, 'card', 'legendary', box(0, 0, bw - 12, rh)), note: 'A finished quest, ready to claim', kids: kidsRow } : row(c, `Quest${i + 1}`, box(0, 0, bw - 12, rh), kidsRow, { note: 'A quest in progress' });
    });
    kids.push(list('List', box(0, ly, bw, lh), rows, rh, Math.round(g * 0.75), 'The quests of the tab: finished ones lit and claimable'));
    return kids;
  });
  return [win];
}

export const questLog: Template = {
  id: 'quest-log',
  label: 'Quest log',
  for: 'Daily, weekly and story quests: each with its icon, what to do, progress, the reward and Claim or Track, the time to the reset, Claim all',
  contentShape: 'title, tabs [names], quests [{name, detail, glyph, done, of, reward}], currency {glyph}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Quests', hides: MENU_HIDES, forms: MENU_FORMS, note: 'The quest log', build: (f) => questLayout(L, f, content) });
    return {
      screens: menuScreens('Quests', screen),
      motion: [
        { play: 'open', target: 'Quests.Window' },
        { play: 'enter', target: 'Quests.Window.Body.List', from: 'left', gap: 0.05, delay: 0.08 },
        { play: 'pulse', target: 'Quests.Window.Body.ClaimAll', when: 'loop', amount: 0.04, seconds: 1.3 },
        { play: 'shimmer', target: 'Quests.Window.Body.List.Quest2', when: 'loop', seconds: 2.6 },
        { play: 'punch', target: 'Quests.Window.Body.List.Quest2.Claim', when: 'claimed', amount: 0.15 },
      ],
      notes: ['One row per quest (clone Quest1): finished ones swap to the lit card and Claim; the bar and count come from the player\'s progress.', 'The tabs switch the list; the reset timer counts to the server\'s reset time.'],
    };
  },
};

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────────

type Setting = { name: string; glyph: string; kind: 'toggle' | 'slider' | 'choice'; value: number | boolean | string; detail: string; choices?: string[] };
const SETTINGS: Setting[] = [
  { name: 'Music', glyph: 'music', kind: 'slider', value: 0.7, detail: 'Background music volume' },
  { name: 'Sound effects', glyph: 'volume-2', kind: 'slider', value: 0.85, detail: 'Hits, coins, buttons' },
  { name: 'Damage numbers', glyph: 'hash', kind: 'toggle', value: true, detail: 'Numbers over hits' },
  { name: 'Reduce motion', glyph: 'waves', kind: 'toggle', value: false, detail: 'Calmer menus and effects' },
  { name: 'Camera shake', glyph: 'vibrate', kind: 'toggle', value: true, detail: 'Shake on big hits' },
  { name: 'Graphics', glyph: 'monitor', kind: 'choice', value: 'Medium', detail: 'Lower runs faster', choices: ['Low', 'Medium', 'High'] },
  { name: 'Show other pets', glyph: 'eye', kind: 'toggle', value: true, detail: 'Hide them for more FPS' },
];

function settingsLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const title = content.str('title', by(L, { candy: 'SETTINGS', ember: 'SETTINGS', neon: 'SYSTEM', parchment: 'Options', frost: 'Settings' }, 'SETTINGS'));
  const cats = content.strs('tabs', ['General', 'Audio', 'Graphics', 'Controls']);
  const items = SETTINGS;
  const [W, H] = fitWindow(c, WANT(f, [1060, 700]));
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    let lx = 0;
    if (f.portrait) {
      kids.push(tabs(c, cats, 0, { x: 0, y: 0, w: bw, h: f.tap - 4, gap: 6 }));
    } else {
      const rw = f.phone ? 132 : Math.round(f.ts.button * 9);
      const n = cats.length;
      const resetH = f.tap;
      // The rail and Reset share the body's height: the tabs give way on a short screen.
      const tabH = Math.min(f.phone ? f.tap - 2 : Math.round(f.ts.button * 2.4), Math.floor((bh - resetH - 16 - (n - 1) * 8) / n));
      kids.push(tabs(c, cats, 0, { x: 0, y: 0, w: rw, h: n * (tabH + 8) - 8, vertical: true, gap: 8 }));
      kids.push(button(c, 'Reset', 'Reset', box(0, 0, rw, resetH, { sy: 1, ay: 1 }), { variant: 'secondary', icon: 'rotate-ccw', note: 'Puts every setting back to its default (asks first)' }));
      lx = rw + g + 4;
    }
    const ly = f.portrait ? f.tap + g : 0;
    const lw = bw - lx;
    const rh = fitRows(items.length, bh - ly - 4, f.phone ? (f.portrait ? 92 : 62) : Math.round(f.ts.body * 3.6), Math.round(g * 0.6), f.phone ? f.tap : undefined);
    const ctlW = f.phone ? (f.portrait ? lw - 32 : 220) : Math.round(lw * 0.42);
    const rows = items.map((s, i) => {
      const ic = Math.round(Math.min(rh * 0.56, f.phone ? 34 : 44));
      const tx = 16 + ic + 14;
      const tw = f.portrait ? lw - tx - 24 : lw - tx - ctlW - 40;
      const ch = f.phone ? 34 : Math.round(f.ts.body * 1.7);
      const cb = f.portrait ? box(16, -12, ctlW, ch, { sy: 1, ay: 1 }) : box(-16, 0, ctlW, ch, { sx: 1, sy: 0.5, ax: 1, ay: 0.5 });
      let ctl: MockNode;
      if (s.kind === 'toggle') {
        const tw2 = Math.round(ch * 1.9);
        ctl = toggle(c, 'Toggle', s.value as boolean, f.portrait ? box(-16, -12, tw2, ch, { sx: 1, sy: 1, ax: 1, ay: 1 }) : box(-16, 0, tw2, ch, { sx: 1, sy: 0.5, ax: 1, ay: 0.5 }));
      } else if (s.kind === 'slider') {
        const sh = Math.max(20, Math.round(ch * 0.5));
        const vw = Math.round(f.ts.num * 2.6);
        ctl = {
          name: 'Control',
          cls: 'Frame',
          ...place(cb),
          bgT: 1,
          kids: [slider(c, 'Slider', s.value as number, box(Math.round(sh * 0.8), 0, ctlW - vw - Math.round(sh * 1.6), sh, { sy: 0.5, ay: 0.5 })), text(c, 'Value', `${Math.round((s.value as number) * 100)}`, 'num', 'panel', box(0, 0, vw, ch, { sx: 1, ax: 1 }), { xAlign: 'Right' })],
        };
      } else {
        const opts = s.choices ?? [];
        const ow = Math.floor((ctlW - (opts.length - 1) * 6) / opts.length);
        const oh = Math.max(ch, f.phone ? 40 : f.tap - 8);
        ctl = {
          name: 'Choice',
          cls: 'Frame',
          ...place(f.portrait ? box(16, -12, ctlW, oh, { sy: 1, ay: 1 }) : box(-16, 0, ctlW, oh, { sx: 1, sy: 0.5, ax: 1, ay: 0.5 })),
          bgT: 1,
          note: 'One of a few: the current one lit',
          kids: opts.map((o, k) => {
            return tabButton(c, `Option${k + 1}`, o, o === s.value, box(k * (ow + 6), 0, ow, oh), Math.round(f.ts.small * c.L.scale('button')));
          }),
        };
      }
      return row(c, `Setting${i + 1}`, box(0, 0, lw - 12, rh), [
        icon(c, 'Icon', s.glyph, box(16, f.portrait ? 12 : 0, ic, ic, f.portrait ? {} : { sy: 0.5, ay: 0.5 }), undefined, { z: 3 }),
        text(c, 'Label', s.name, 'h2', 'panel', box(tx, f.portrait ? 10 : f.phone ? 0 : Math.round(rh * 0.14), tw, f.phone && !f.portrait ? rh : f.ts.h2 + 6), { xAlign: 'Left', z: 3 }),
        ...(f.phone && !f.portrait ? [] : [text(c, 'Detail', s.detail, 'small', 'muted', box(tx, f.portrait ? 12 + f.ts.h2 + 4 : Math.round(rh * 0.14) + f.ts.h2 + 6, tw, f.ts.small + 4), { xAlign: 'Left', z: 3, truncate: true })]),
        { ...ctl, z: 3 },
      ]);
    });
    kids.push(list('List', box(lx, ly, lw, bh - ly), rows, rh, Math.round(g * 0.6), 'The settings of the tab (saved for the player on change)'));
    return kids;
  });
  return [win];
}

export const settings: Template = {
  id: 'settings',
  label: 'Settings',
  for: 'A settings window: category tabs, rows with an icon, a name and a line about it, and the right control — toggles, sliders with their value, a choice of a few — and Reset',
  contentShape: 'title, tabs [categories]',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Settings', hides: MENU_HIDES, forms: MENU_FORMS, note: 'Settings: saved per player', build: (f) => settingsLayout(L, f, content) });
    return {
      screens: menuScreens('Settings', screen),
      motion: [
        { play: 'open', target: 'Settings.Window' },
        { play: 'enter', target: 'Settings.Window.Body.List', from: 'up', gap: 0.03, delay: 0.06 },
        { play: 'swap', target: 'Settings.Window.Body.List', when: 'a tab is picked' },
      ],
      notes: ['Save each change to the player\'s data (and apply it at once: volumes, Reduce Motion through Motion.reducedMotion).', 'Toggles slide their knob; sliders drag; the choice lights the picked option.'],
    };
  },
};

// ─── Leaderboard ──────────────────────────────────────────────────────────────────────────────────

function leaderLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const title = content.str('title', by(L, { candy: 'TOP PLAYERS', ember: 'HALL OF FAME', neon: 'RANKINGS', parchment: 'Hall of Heroes', frost: 'Leaderboard' }, 'LEADERBOARD'));
  const stat = content.str('stat', L.base === 'candy' ? 'Coins' : L.base === 'frost' ? 'Likes' : L.base === 'parchment' ? 'Renown' : 'Kills');
  const players = content.strs('players', world.players);
  const scores = ['1.2M', '984K', '870K', '612K', '544K', '501K', '470K', '433K', '398K', '351K'];
  const [W, H] = fitWindow(c, WANT(f, [1180, 720]));
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const th = f.phone ? f.tap - 6 : Math.round(f.ts.button * 2);
    kids.push(tabs(c, content.strs('tabs', ['Global', 'Friends', 'Weekly']), 0, { x: 0, y: 0, w: Math.min(bw * (f.portrait ? 1 : 0.55), (f.portrait ? 140 : 170) * 3), h: th, gap: 8 }));
    const top = th + g;
    const youH = f.phone ? 54 : Math.round(f.ts.body * 3);
    const podium = !f.phone || f.portrait;
    const pw = f.portrait ? bw : Math.round(bw * 0.44);
    const ph = f.portrait ? Math.round(Math.min(250, bh * 0.32)) : bh - top;
    if (podium) {
      // The top three: first in the middle and tallest.
      const order = [1, 0, 2];
      const cw = Math.floor((pw - 2 * g) / 3);
      const rar = ['legendary', 'common', 'epic'];
      kids.push({
        name: 'Podium',
        cls: 'Frame',
        ...place(box(0, top, pw, ph)),
        bgT: 1,
        note: 'The top three',
        kids: order.map((r, k) => {
          const hh = Math.round(ph * (r === 0 ? 1 : r === 1 ? 0.86 : 0.76));
          const av = Math.round(Math.min(cw * 0.62, hh * 0.36));
          const medal = Math.round(Math.max(f.ts.num * 1.8, av * 0.5));
          return {
            ...skinned(c, 'Frame', `Place${r + 1}`, 'card', rar[r], box(k * (cw + g), 0, cw, hh, { sy: 1, ay: 1 })),
            pos: [0, k * (cw + g), 1, 0],
            anchor: [0, 1],
            kids: [
              { ...art(c, 'Avatar', 'iconFrame', box(0, Math.round(hh * 0.1), av, av, { sx: 0.5, ax: 0.5 }), {}), z: 2, kids: [icon(c, 'Face', r === 0 ? 'crown' : 'user', box(0, 0, Math.round(av * 0.6), Math.round(av * 0.6), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), r === 0 ? 'legendary' : undefined, { z: 3 })] },
              { ...art(c, 'Medal', 'badge', box(-Math.round(medal * 0.1), Math.round(hh * 0.1) + av - Math.round(medal * 0.6), medal, medal, { sx: 0.5 }), {}), z: 6, kids: [text(c, 'Rank', String(r + 1), 'num', 'card', box(0, 0, medal, medal), { z: 7, ink: { color: '#ffffff', stroke: { color: '#2b1306', px: 1.5, text: true } } })] },
              text(c, 'PlayerName', players[r]!, 'h2', 'card', box(8, Math.round(hh * 0.1) + av + 14, cw - 16, f.ts.h2 + 6), { z: 3, truncate: true }),
              text(c, 'Score', scores[r]!, 'num', 'card', box(8, Math.round(hh * 0.1) + av + 18 + f.ts.h2, cw - 16, f.ts.num + 6), { z: 3, ink: rarityLabel(c, rar[r]!) }),
              text(c, 'Stat', stat, 'small', 'card', box(8, Math.round(hh * 0.1) + av + 24 + f.ts.h2 + f.ts.num, cw - 16, f.ts.small + 4), { z: 3 }),
            ],
          };
        }),
      });
    }
    // The rest of the board, and the player's own line pinned under it.
    const lx = podium && !f.portrait ? pw + g * 1.5 : 0;
    const ly = f.portrait ? top + ph + g : top;
    const lw = bw - lx;
    const lh = bh - ly - youH - g;
    const rh = fitRows(10 - (podium ? 3 : 0), lh - 4, f.phone ? 46 : Math.round(f.ts.body * 2.5), Math.round(g * 0.5), f.phone ? 38 : undefined);
    const start = podium ? 3 : 0;
    const line = (rank: number, name: string, score: string, you: boolean): MockNode => {
      const kidsRow: MockNode[] = [
        text(c, 'Rank', `#${rank}`, 'num', you ? 'card' : 'panel', box(10, 0, Math.round(f.ts.num * 3), you ? youH : rh), { xAlign: 'Left', z: 3, ...(rank <= 3 && !you ? { ink: { color: String(rank === 1 ? L.hue.gold : rank === 2 ? '#9aa3ad' : '#c9773a'), ...(L.ink('card').stroke ? { stroke: L.ink('card').stroke } : {}) } } : {}) }),
        { ...art(c, 'Avatar', 'iconFrame', box(Math.round(f.ts.num * 3) + 14, 0, Math.round((you ? youH : rh) * 0.72), Math.round((you ? youH : rh) * 0.72), { sy: 0.5, ay: 0.5 }), {}), z: 2, kids: [icon(c, 'Face', 'user', box(0, 0, Math.round((you ? youH : rh) * 0.44), Math.round((you ? youH : rh) * 0.44), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), undefined, { z: 3 })] },
        text(c, 'PlayerName', name, 'h2', you ? 'card' : 'panel', box(Math.round(f.ts.num * 3) + 24 + Math.round((you ? youH : rh) * 0.72), 0, Math.round(lw * 0.48), you ? youH : rh), { xAlign: 'Left', z: 3, truncate: true }),
        text(c, 'Score', score, 'num', you ? 'card' : 'panel', box(-16, 0, Math.round(lw * 0.3), you ? youH : rh, { sx: 1, ax: 1 }), { xAlign: 'Right', z: 3 }),
      ];
      return you ? { ...skinned(c, 'Frame', 'You', 'card', 'rare', box(lx, 0, lw, youH, { sy: 1, ay: 1 })), note: 'The player\'s own place, always shown', kids: kidsRow } : row(c, `Rank${rank}`, box(0, 0, lw - 12, rh), kidsRow);
    };
    const rows = players.slice(start, 10).map((p, i) => line(start + i + 1, p, scores[start + i]!, false));
    kids.push(list('List', box(lx, ly, lw, lh), rows, rh, Math.round(g * 0.5), 'Ranks after the podium (the game fills it from an OrderedDataStore)'));
    kids.push(line(128, 'You', '12,400', true));
    return kids;
  });
  return [win];
}

export const leaderboard: Template = {
  id: 'leaderboard',
  label: 'Leaderboard',
  for: 'Rankings: global, friends, weekly tabs, the top three on a podium, the ranks below, and the player\'s own place pinned at the bottom',
  contentShape: 'title, stat (what is ranked), tabs [names], players [names]',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Leaderboard', hides: MENU_HIDES, forms: MENU_FORMS, note: 'The leaderboard', build: (f) => leaderLayout(L, f, content) });
    return {
      screens: menuScreens('Leaderboard', screen),
      motion: [
        { play: 'open', target: 'Leaderboard.Window' },
        { play: 'enter', target: 'Leaderboard.Window.Body.Podium', from: 'up', gap: 0.08, delay: 0.1 },
        { play: 'enter', target: 'Leaderboard.Window.Body.List', from: 'right', gap: 0.03, delay: 0.2 },
        { play: 'shimmer', target: 'Leaderboard.Window.Body.Podium.Place1', when: 'loop', seconds: 2.8 },
        { play: 'float', target: 'Leaderboard.Window.Body.Podium.Place1.Avatar', when: 'loop', amount: 4, seconds: 2.4 },
      ],
      notes: ['Read the board from an OrderedDataStore on the server (top 50, refreshed every minute); the player\'s own rank comes from their entry.', 'Phones show the list with the top three first; the podium shows on bigger screens and an upright phone.'],
    };
  },
};

// ─── Codes ────────────────────────────────────────────────────────────────────────────────────────

function codesLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const title = content.str('title', by(L, { candy: 'CODES', ember: 'CODES', neon: 'REDEEM', parchment: 'Secret Words', frost: 'Codes' }, 'CODES'));
  const used = content.list('redeemed', [{ code: 'RELEASE', reward: '500' }, { code: 'THANKYOU', reward: '250' }, { code: 'UPDATE7', reward: '1,000' }], (x, d) => ({ code: String(x.code ?? d?.code ?? 'CODE'), reward: String(x.reward ?? d?.reward ?? '') })).slice(0, 4);
  const [W, H] = fitWindow(c, f.portrait ? [f.w - 24, Math.min(f.h - 60, 720)] : f.phone ? [Math.min(f.w, 720), f.h] : f.tv ? [920, 700] : [820, 640]);
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const fh = Math.max(f.tap, Math.round(f.ts.button * 2.4));
    kids.push(text(c, 'Prompt', content.str('prompt', 'Enter a code for free rewards!'), 'h2', 'panel', box(0, 0, bw, f.ts.h2 + 10), {}));
    const fy = f.ts.h2 + 10 + g;
    const rw = Math.round(Math.min(bw * 0.34, f.phone ? 170 : 220));
    kids.push({
      ...skinned(c, 'Frame', 'Field', 'barTrack', undefined, box(0, fy, bw - rw - g, fh)),
      note: 'The code box',
      kids: [
        icon(c, 'Icon', 'ticket', box(14, 0, Math.round(fh * 0.5), Math.round(fh * 0.5), { sy: 0.5, ay: 0.5 }), undefined, { z: 3 }),
        { name: 'Input', cls: 'TextBox', ...place(box(Math.round(fh * 0.5) + 24, 0, bw - rw - g - Math.round(fh * 0.5) - 34, fh)), bgT: 1, text: 'SUMMER2026', ...L.font('num'), textSize: Math.round(f.ts.h2 * L.scale('num')), textColor: L.base === 'frost' ? '#1d2433' : '#ffffff', xAlign: 'Left', z: 3, note: 'Where the player types the code (PlaceholderText "Enter code")' },
      ],
    });
    kids.push(button(c, 'Redeem', 'Redeem', box(0, fy, rw, fh, { sx: 1, ax: 1 }), { variant: L.go, note: 'Sends the code to the server, which checks it once per player' }));
    const sy = fy + fh + 10;
    kids.push({ name: 'Status', cls: 'Frame', ...place(box(0, sy, bw, f.ts.body + 12)), bgT: 1, note: 'What happened: redeemed (and the reward), already used, or not a code', kids: [icon(c, 'Icon', 'circle-check', box(0, 0, f.ts.body + 6, f.ts.body + 6, { sy: 0.5, ay: 0.5 }), 'success', { z: 3 }), text(c, 'Message', `Redeemed! +500 ${cur.name}`, 'body', 'panel', box(f.ts.body + 14, 0, bw - f.ts.body - 14, f.ts.body + 12), { xAlign: 'Left', z: 3, ink: L.ink('good') })] });
    // Codes already used, and where new ones are posted.
    const ly = sy + f.ts.body + 12 + g;
    const footH = Math.round(f.ts.small * 2.6);
    const rh = f.phone ? 44 : Math.round(f.ts.body * 2.4);
    const n = Math.max(1, Math.min(used.length, Math.floor((bh - ly - footH - g - f.ts.small - 10) / (rh + 6))));
    kids.push(text(c, 'UsedLabel', 'Redeemed', 'small', 'muted', box(0, ly, bw, f.ts.small + 6), { xAlign: 'Left' }));
    used.slice(0, n).forEach((u, i) => kids.push(row(c, `Used${i + 1}`, box(0, ly + f.ts.small + 10 + i * (rh + 6), bw, rh), [
      text(c, 'Code', u.code, 'num', 'panel', box(14, 0, Math.round(bw * 0.5), rh), { xAlign: 'Left', z: 3 }),
      coin(c, 'Coin', cur.glyph, box(-Math.round(bw * 0.22), 0, Math.round(rh * 0.62), Math.round(rh * 0.62), { sx: 1, sy: 0.5, ay: 0.5 }), { z: 3 }),
      text(c, 'Reward', u.reward, 'num', 'panel', box(-Math.round(bw * 0.22) + Math.round(rh * 0.7), 0, Math.round(bw * 0.18), rh, { sx: 1 }), { xAlign: 'Left', z: 3 }),
      icon(c, 'Check', 'check', box(-12, 0, Math.round(rh * 0.5), Math.round(rh * 0.5), { sx: 1, sy: 0.5, ax: 1, ay: 0.5 }), 'success', { z: 3 }),
    ])));
    kids.push({ name: 'Where', cls: 'Frame', ...place(box(0, 0, bw, footH, { sy: 1, ay: 1 })), bgT: 1, kids: [icon(c, 'Icon', 'bell', box(0, 0, Math.round(footH * 0.6), Math.round(footH * 0.6), { sy: 0.5, ay: 0.5 }), 'legendary', { z: 3 }), text(c, 'Text', content.str('where', 'New codes in our group and at every update'), 'small', 'muted', box(Math.round(footH * 0.6) + 10, 0, bw - Math.round(footH * 0.6) - 10, footH), { xAlign: 'Left', z: 3 })] });
    return kids;
  });
  return [win];
}

export const codes: Template = {
  id: 'codes',
  label: 'Codes',
  for: 'Redeeming codes: a code box with Redeem, what happened (redeemed and the reward, used, not a code), the codes already used, where new ones are posted',
  contentShape: 'title, prompt, where, redeemed [{code, reward}], currency {glyph, name}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Codes', hides: MENU_HIDES, forms: MENU_FORMS, note: 'Codes: redeem rewards', build: (f) => codesLayout(L, f, content) });
    return {
      screens: menuScreens('Codes', screen),
      motion: [
        { play: 'open', target: 'Codes.Window' },
        { play: 'shake', target: 'Codes.Window.Body.Field', when: 'a code is refused', amount: 6 },
        { play: 'punch', target: 'Codes.Window.Body.Status', when: 'a code is redeemed', amount: 0.15 },
        { play: 'enter', target: 'Codes.Window.Body.Status', from: 'pop', when: 'a code is redeemed' },
      ],
      notes: ['The server keeps the codes and who used them (a DataStore per player); the client only sends the text.', 'Status shows the answer: green and the reward, or why it was refused (shake the field).'],
    };
  },
};

// ─── Profile ──────────────────────────────────────────────────────────────────────────────────────

function profileLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const name = content.str('name', world.players[0]!);
  const rank = content.str('rank', L.base === 'candy' ? 'Pet Legend' : L.base === 'ember' ? 'Warlord' : L.base === 'neon' ? 'Ace Pilot' : L.base === 'parchment' ? 'Knight of Ash' : 'Trendsetter');
  const stats = content.list('stats', world.stats, (x, d) => [String(x.name ?? d?.[0] ?? ''), String(x.value ?? d?.[1] ?? ''), String(x.glyph ?? d?.[2] ?? 'star')] as [string, string, string]).slice(0, 6);
  const badges: Array<[string, string]> = [['trophy', 'legendary'], ['flame', 'mythic'], ['star', 'epic'], ['shield', 'rare'], ['crown', 'legendary'], ['zap', 'epic'], ['heart', 'rare'], ['gem', 'common']];
  const [W, H] = fitWindow(c, WANT(f, [1180, 700]));
  const title = content.str('title', by(L, { candy: 'PROFILE', ember: 'WARRIOR', neon: 'PILOT FILE', parchment: 'Chronicle', frost: 'Profile' }, 'PROFILE'));
  const win = window(c, { title, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const g = f.gap;
    const cw = f.portrait ? bw : Math.round(bw * (f.phone ? 0.36 : 0.34));
    const ch = f.portrait ? Math.round(Math.min(300, bh * 0.38)) : bh;
    // The player's card.
    const av = Math.round(Math.min(cw * 0.46, ch * (f.portrait ? 0.5 : 0.26)));
    const btnH = Math.max(f.tap, Math.round(f.ts.button * 2.2));
    const card: MockNode[] = [];
    if (f.portrait) {
      card.push({ ...art(c, 'Avatar', 'iconFrame', box(18, 18, av, av), {}), z: 2, kids: [icon(c, 'Face', 'user', box(0, 0, Math.round(av * 0.62), Math.round(av * 0.62), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), undefined, { z: 3 })] });
      const tx = av + 34;
      card.push(text(c, 'PlayerName', name, 'h1', 'card', box(tx, 22, cw - tx - 14, f.ts.h1 + 8), { xAlign: 'Left', z: 3, truncate: true }));
      card.push(text(c, 'Rank', rank, 'body', 'card', box(tx, 26 + f.ts.h1 + 4, cw - tx - 14, f.ts.body + 6), { xAlign: 'Left', z: 3, ink: rarityLabel(c, 'legendary') }));
      card.push(bar(c, 'Level', box(tx, 34 + f.ts.h1 + f.ts.body + 10, cw - tx - 18, Math.round(f.ts.small * 1.6)), 0.64, { label: 'Lv 42 · 64%' }));
      card.push(button(c, 'AddFriend', 'Add friend', box(18, -16, Math.round((cw - 46) / 2), btnH, { sy: 1, ay: 1 }), { icon: 'user-plus', note: 'Sends a friend request' }));
      card.push(button(c, 'Trade', 'Trade', box(-18, -16, Math.round((cw - 46) / 2), btnH, { sx: 1, sy: 1, ax: 1, ay: 1 }), { variant: 'secondary', icon: 'arrow-left-right', note: 'Asks to trade' }));
    } else {
      let y = Math.round(ch * 0.05);
      card.push({ ...art(c, 'Avatar', 'iconFrame', box(0, y, av, av, { sx: 0.5, ax: 0.5 }), {}), z: 2, kids: [icon(c, 'Face', 'user', box(0, 0, Math.round(av * 0.62), Math.round(av * 0.62), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), undefined, { z: 3 })] });
      const lb = Math.round(Math.max(f.ts.num * 2, av * 0.34));
      card.push({ ...art(c, 'LevelBadge', 'badge', box(Math.round(av * 0.32), y + av - Math.round(lb * 0.8), lb, lb, { sx: 0.5, ax: 0.5 }), {}), z: 6, kids: [text(c, 'Value', '42', 'num', 'card', box(0, 0, lb, lb), { z: 7, ink: { color: '#ffffff', stroke: { color: '#2b1306', px: 1.5, text: true } } })] });
      y += av + 8;
      card.push(text(c, 'PlayerName', name, 'h1', 'card', box(10, y, cw - 20, f.ts.h1 + 8), { z: 3, truncate: true }));
      y += f.ts.h1 + 8;
      card.push(text(c, 'Rank', rank, 'body', 'card', box(10, y, cw - 20, f.ts.body + 6), { z: 3, ink: rarityLabel(c, 'legendary') }));
      y += f.ts.body + (f.phone ? 10 : 18);
      card.push(bar(c, 'Level', box(16, y, cw - 32, Math.round(f.ts.small * 1.6)), 0.64, { label: 'Level 42 · 64%', note: 'XP into the level' }));
      // What they have on: three equipped slots between the level and the buttons (when the card has room).
      const eqTop = y + Math.round(f.ts.small * 1.6) + 18;
      const eqRoom = ch - (btnH * 2 + 38) - eqTop;
      const es = Math.min(Math.round((cw - 32 - 2 * 10) / 3), eqRoom - f.ts.small - 10);
      if (!f.phone && es >= 56) {
        card.push(text(c, 'EquippedLabel', 'EQUIPPED', 'small', 'card', box(16, eqTop, cw - 32, f.ts.small + 4), { z: 3, ...c.L.font('button') }));
        const worldItems = worldOf(L.id).inventory.items;
        card.push({ name: 'Equipped', cls: 'Frame', ...place(box(0, eqTop + f.ts.small + 8, 3 * es + 20, es, { sx: 0.5, ax: 0.5 })), bgT: 1, note: 'What the player has equipped', kids: [0, 3, 4].map((k, i) => ({ ...slotTile(c, `Slot${i + 1}`, { glyph: worldItems[k]!.glyph, rarity: worldItems[k]!.rarity }, es), pos: [0, i * (es + 10), 0, 0] as [number, number, number, number] })) });
      }
      card.push(button(c, 'AddFriend', 'Add friend', box(0, -(btnH + 24), cw - 32, btnH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 }), { icon: 'user-plus', note: 'Sends a friend request' }));
      card.push(button(c, 'Trade', 'Trade', box(0, -14, cw - 32, btnH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 }), { variant: 'secondary', icon: 'arrow-left-right', note: 'Asks to trade' }));
      if (f.phone) card.splice(card.findIndex((k) => k.name === 'AddFriend'), 1);
    }
    kids.push({ ...skinned(c, 'Frame', 'Card', 'card', 'legendary', box(0, 0, cw, ch)), note: 'Who the player is', kids: card });
    // Stats and badges.
    const sx = f.portrait ? 0 : cw + g * 1.5;
    const sy = f.portrait ? ch + g : 0;
    const sw = bw - sx;
    const cols = f.portrait ? 2 : 3;
    const rowsN = Math.ceil(stats.length / cols);
    const badgeH = f.phone ? (f.portrait ? 64 : 54) : Math.round(f.ts.body * 4);
    const labelH = f.ts.small + 8;
    const sh = Math.floor((bh - sy - labelH * 2 - badgeH - g * 3 - (rowsN - 1) * g) / rowsN);
    const scw = Math.floor((sw - (cols - 1) * g) / cols);
    kids.push(text(c, 'StatsLabel', 'Stats', 'small', 'muted', box(sx, sy, sw, labelH), { xAlign: 'Left' }));
    kids.push({
      name: 'Stats',
      cls: 'Frame',
      ...place(box(sx, sy + labelH + 4, sw, rowsN * (sh + g) - g)),
      bgT: 1,
      note: 'Lifetime stats (from the player\'s data)',
      kids: stats.map(([label, value, glyph], i) => {
        const ic = Math.round(Math.min(sh * 0.5, scw * 0.3));
        return row(c, `Stat${i + 1}`, box((i % cols) * (scw + g), Math.floor(i / cols) * (sh + g), scw, sh), [
          icon(c, 'Icon', glyph, box(12, 0, ic, ic, { sy: 0.5, ay: 0.5 }), i % 2 ? 'rare' : 'epic', { z: 3 }),
          text(c, 'Value', value, 'big', 'panel', box(ic + 22, Math.round(sh * 0.08), scw - ic - 30, Math.round(sh * 0.5)), { xAlign: 'Left', z: 3, scaled: true, textMax: Math.round(Math.min(sh * 0.4, f.ts.big * 0.72)), padding: [[0, 2], [0, 0], [0, 2], [0, 0]] }),
          text(c, 'Label', label, 'small', 'muted', box(ic + 22, Math.round(sh * 0.58), scw - ic - 30, Math.round(sh * 0.32)), { xAlign: 'Left', z: 3, truncate: true }),
        ]);
      }),
    });
    const by2 = sy + labelH + 4 + rowsN * (sh + g) - g + g;
    kids.push(text(c, 'BadgesLabel', 'Badges 12 / 40', 'small', 'muted', box(sx, by2, sw, labelH), { xAlign: 'Left' }));
    const nb = Math.max(4, Math.min(badges.length, Math.floor((sw + g) / (badgeH + g))));
    kids.push({ name: 'Badges', cls: 'Frame', ...place(box(sx, by2 + labelH + 4, sw, badgeH)), bgT: 1, note: 'Badges earned (tap one for what it is)', kids: badges.slice(0, nb).map(([gl, r], i) => ({ ...slotTile(c, `Badge${i + 1}`, { glyph: gl, rarity: r }, badgeH), pos: [0, i * (badgeH + g), 0, 0] })) });
    return kids;
  });
  return [win];
}

export const profile: Template = {
  id: 'profile',
  label: 'Profile & stats',
  for: 'A player\'s profile: avatar, level and rank, Add friend and Trade, lifetime stats in tiles, and the badges they have earned',
  contentShape: 'name, rank, stats [{name, value, glyph}] x6',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Profile', hides: MENU_HIDES, forms: MENU_FORMS, note: 'A player\'s profile (theirs or another player\'s)', build: (f) => profileLayout(L, f, content) });
    return {
      screens: menuScreens('Profile', screen),
      motion: [
        { play: 'open', target: 'Profile.Window' },
        { play: 'enter', target: 'Profile.Window.Body.Stats', from: 'up', gap: 0.04, delay: 0.1 },
        { play: 'enter', target: 'Profile.Window.Body.Badges', from: 'pop', gap: 0.04, delay: 0.2 },
        { play: 'count', target: 'Profile.Window.Body.Stats.Stat1.Value', from: 0, to: 1284, seconds: 0.7, delay: 0.15 },
        { play: 'shimmer', target: 'Profile.Window.Body.Card', when: 'loop', seconds: 3.2 },
      ],
      notes: ['Avatar is a slot for the player\'s headshot (Players:GetUserThumbnailAsync) as an ImageLabel inside Card.Avatar.', 'Shown for the player or for anyone they tap; Add friend and Trade hide on their own profile.'],
    };
  },
};

