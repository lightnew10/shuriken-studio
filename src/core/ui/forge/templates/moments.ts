import type { MockMotion, MockNode } from '@shared/ui-mockup';
import { Content, readCurrency, worldOf } from './content';
import { composeScreen, MENU_HIDES, HUD_FORMS, MENU_FORMS, type FormCtx } from './forms';
import { lookOf, type Look } from './look';
import { art, bar, box, button, coin, fitWindow, group, icon, iconButton, menuScreens, place, skinned, slotTile, text, toggle, window, type Ctx } from './parts';
import type { Template, TemplateInput, TemplateOutput } from './types';

/** A screen-wide shade on its own ScreenGui (insets None, so it covers the top bar and notch too): a vignette or a dim. */
function shade(name: string, order: number, gradient: NonNullable<MockNode['gradient']>, note: string): MockNode {
  return { name, insets: 'None', displayOrder: order, note, kids: [{ name: 'Shade', cls: 'Frame', size: [1, 0, 1, 0], bg: '#04020a', bgT: 0, gradient }] };
}

// ─── Title and loading ────────────────────────────────────────────────────────────────────────────

function titleLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const name = content.str('title', world.game.name);
  const tagline = content.str('tagline', world.game.tagline);
  const loading = content.str('state', 'menu') === 'loading';
  const tip = content.str('tip', L.base === 'candy' ? 'Tip: rebirth to multiply every coin you earn!' : L.base === 'ember' ? 'Tip: block just before a hit to stagger your foe.' : L.base === 'neon' ? 'Tip: EMP drones before they swarm you.' : L.base === 'parchment' ? 'Tip: the Ferryman trades in moonherbs.' : 'Tip: double-tap a friend to wave.');
  const { inset } = f;
  const logoH = f.phone ? 104 : f.portrait ? 120 : f.tv ? 210 : 200;
  const logoW = Math.round(Math.min(f.w - inset[0] - inset[2] - 20, logoH * 4.6));
  const btnH = f.phone ? 64 : f.tv ? 100 : 92;
  const playW = Math.round(btnH * 3.9);
  const small = f.phone ? 56 : f.tv ? 84 : 76;
  const g = f.gap;
  const labelH = f.ts.small + 6;
  const menuH = btnH + g * 2 + small + labelH;
  const loadH = f.ts.small + 8 + Math.round(f.ts.body * 1.5) + 8 + f.ts.small + 6;
  const total = logoH + f.ts.h1 + 10 + (f.phone ? 16 : 40) + menuH;
  let y = inset[1] + Math.max(f.phone ? 4 : 24, Math.round((f.h - inset[1] - inset[3] - total - (f.phone ? 0 : loadH)) / 2));
  const kids: MockNode[] = [];
  kids.push(art(c, 'Logo', 'title', box(0, y, logoW, logoH, { sx: 0.5, ax: 0.5 }), { text: name }, { z: 5, note: 'The game\'s name: its logo (a forged plate; an uploaded logo image fits the same box)' }));
  y += logoH;
  const tagSize = Math.round(f.ts.h1 * (f.phone ? 1.05 : 1.35));
  kids.push(text(c, 'Tagline', tagline, 'h1', 'scene', box(0, y + 4, logoW, tagSize + 10, { sx: 0.5, ax: 0.5 }), { z: 4, textSize: tagSize }));
  y += tagSize + 14 + (f.phone ? 10 : 40);
  // The menu: Play, and a row of smaller doors under it.
  const doors: Array<[string, string]> = [['Shop', 'store'], ['Settings', 'settings'], ['Codes', 'ticket']];
  const rowW = doors.length * small + (doors.length - 1) * (g * 2);
  const menu: MockNode[] = [
    button(c, 'Play', 'PLAY', box(0, 0, playW, btnH, { sx: 0.5, ax: 0.5 }), { variant: L.go, icon: 'play', textSize: Math.round(btnH * 0.48), note: 'Starts the game (hands over to the HUD with a transition)' }),
    ...doors.map(([label, glyph], i) => ({
      name: label,
      cls: 'Frame',
      ...place(box(-Math.round(rowW / 2) + i * (small + g * 2), btnH + g * 2, small, small + labelH, { sx: 0.5 })),
      bgT: 1,
      kids: [iconButton(c, 'Button', glyph, box(0, 0, small, small), { note: `Opens ${label}` }), text(c, 'Label', label, 'small', 'scene', box(-10, small + 2, small + 20, labelH), {})],
    })),
  ];
  kids.push({ name: 'Menu', cls: 'Frame', ...place(box(0, y, Math.max(playW, rowW + 20), menuH, { sx: 0.5, ax: 0.5 })), bgT: 1, ...(loading ? { visible: false } : {}), note: 'The title menu (hidden while loading)', kids: menu });
  // Loading: the bar, what it is doing, a tip (shown first, then swapped for the menu).
  const lw = Math.round(Math.min(f.w * 0.62, f.phone ? 520 : 760));
  kids.push({
    name: 'Loading',
    cls: 'Frame',
    ...place(box(0, -inset[3] - (f.phone ? 6 : 30), lw, loadH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 })),
    bgT: 1,
    ...(loading ? {} : { visible: false }),
    note: 'Shown while the game loads (ReplicatedFirst), then swapped for the menu',
    kids: [
      text(c, 'Status', 'Loading the world… 64%', 'small', 'scene', box(0, 0, lw, f.ts.small + 6), {}),
      bar(c, 'Bar', box(0, f.ts.small + 8, lw, Math.round(f.ts.body * 1.5)), 0.64, { note: 'ContentProvider progress' }),
      text(c, 'Tip', tip, 'small', 'scene', box(0, f.ts.small + 16 + Math.round(f.ts.body * 1.5), lw, f.ts.small + 6), { textT: 0.1 }),
    ],
  });
  // The version, out of the way (phones keep that corner for the jump button).
  if (!f.phone) kids.push(text(c, 'Version', 'v1.4 · Update 7', 'small', 'scene', box(-inset[2] - 12, -inset[3] - 8, 220, f.ts.small + 4, { sx: 1, sy: 1, ax: 1, ay: 1 }), { xAlign: 'Right', textT: 0.3 }));
  return kids;
}

export const title: Template = {
  id: 'title',
  label: 'Title & loading screen',
  for: 'The first thing a player sees: the game\'s logo and tagline over the world, a big Play, doors to the shop, settings and codes, and the loading bar with a tip (shown while it loads)',
  contentShape: 'title (the game\'s name), tagline, tip, state "menu" | "loading"',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Title', hides: MENU_HIDES, displayOrder: 30, forms: MENU_FORMS, note: 'The title screen (ResetOnSpawn off); Play hides it', build: (f) => titleLayout(L, f, content) });
    return {
      screens: [shade('TitleBackdrop', 29, { rot: 90, colors: [[0, '#ffffff'], [1, '#ffffff']], transp: [[0, 0.55], [0.45, 0.85], [1, 0.25]] }, 'Darkens the top and bottom of the world behind the title (a vignette)'), screen],
      motion: [
        { play: 'enter', target: 'Title.Logo', from: 'pop', delay: 0.15 },
        { play: 'float', target: 'Title.Logo', when: 'loop', amount: 6, seconds: 3 },
        { play: 'enter', target: 'Title.Tagline', from: 'up', delay: 0.3 },
        { play: 'enter', target: 'Title.Menu', from: 'up', gap: 0.06, delay: 0.4 },
        { play: 'pulse', target: 'Title.Menu.Play', when: 'loop', amount: 0.05, seconds: 1.4 },
        { play: 'shimmer', target: 'Title.Logo', when: 'loop', seconds: 4 },
        { play: 'transition', style: 'iris', seconds: 0.5, when: 'Play pressed' },
      ],
      notes: ['Build the loading part from ReplicatedFirst (RemoveDefaultLoadingScreen), fill the bar from ContentProvider, then swap Loading for Menu.', 'Play hides the title with a transition and shows the HUD; the camera can pan the world behind it.'],
    };
  },
};

// ─── Dialogue ─────────────────────────────────────────────────────────────────────────────────────

function dialogueLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const npc = { ...world.npc, name: content.str('name', world.npc.name), role: content.str('role', world.npc.role), glyph: content.str('glyph', world.npc.glyph), line: content.str('line', world.npc.line) };
  const choices = content.strs('choices', world.npc.choices).slice(0, 4);
  const { inset } = f;
  const g = f.gap;
  const W = Math.round(Math.min(f.w - inset[0] - inset[2] - 16, f.phone ? (f.portrait ? f.w : 820) : f.tv ? 1340 : 1240));
  const btnH = f.phone ? 54 : Math.max(f.tap, Math.round(f.ts.button * 2.2));
  const portrait = f.portrait;
  const choicesW = portrait ? W - 40 : Math.round(W * (f.phone ? 0.36 : 0.32));
  const choicesH = choices.length * btnH + (choices.length - 1) * 8;
  // The line reads a size up from body text: it is what the player is here for.
  const lineSize = f.phone ? f.ts.body : Math.round(f.ts.h2 * 1.1);
  const textH = Math.round(lineSize * 1.3 * (f.phone ? 4 : 3.2));
  const plateH = Math.round(f.ts.h1 * 2.2);
  const H = portrait ? plateH * 0.6 + textH + choicesH + 70 : Math.max(choicesH + 36, textH + plateH * 0.6 + 40);
  const port = Math.round(Math.min(f.phone ? 120 : 210, H * 0.9));
  const kids: MockNode[] = [];
  const bodyX = portrait ? 24 : Math.round(port * 0.9) + 16;
  const textW = portrait ? W - 48 : W - bodyX - choicesW - 44;
  const boxKids: MockNode[] = [
    { ...skinned(c, 'Frame', 'Nameplate', 'header', undefined, box(bodyX - 6, -Math.round(plateH * 0.55), Math.round(Math.min(textW + 20, f.ts.h1 * 12)), plateH)), z: 4, note: 'Who is speaking', kids: [text(c, 'NpcName', npc.name, 'h1', 'header', box(18, Math.round(plateH * 0.06), Math.round(Math.min(textW, f.ts.h1 * 12)) - 36, Math.round(plateH * 0.56)), { xAlign: 'Left', z: 5 }), text(c, 'Role', npc.role, 'small', 'header', box(18, Math.round(plateH * 0.56), Math.round(Math.min(textW, f.ts.h1 * 12)) - 36, Math.round(plateH * 0.36)), { xAlign: 'Left', z: 5, textT: 0.1 })] },
    text(c, 'Line', npc.line, 'body', 'panel', box(bodyX + 8, Math.round(plateH * 0.55) + 10, textW, textH), { xAlign: 'Left', yAlign: 'Top', wrapped: true, z: 3, lineHeight: 1.1, textSize: lineSize, note: 'The line: typed out (MaxVisibleGraphemes, 30-45 a second; a tap completes it)' }),
    icon(c, 'Next', 'chevrons-down', box(bodyX + textW - 20, -14, f.ts.body * 1.4, f.ts.body * 1.4, { sy: 1, ay: 1 }), undefined, { z: 3, note: 'Shown when the line is done (more to say)' }),
    {
      name: 'Choices',
      cls: 'Frame',
      ...place(portrait ? box(0, -18, choicesW, choicesH, { sx: 0.5, sy: 1, ax: 0.5, ay: 1 }) : box(-30, 0, choicesW, choicesH, { sx: 1, sy: 0.5, ax: 1, ay: 0.5 })),
      bgT: 1,
      note: 'The answers (keys 1-4 or the D-pad pick one)',
      kids: choices.map((ch, i) => button(c, `Choice${i + 1}`, ch, box(0, i * (btnH + 8), choicesW, btnH), { variant: i === choices.length - 1 ? 'secondary' : 'primary', role: f.phone ? 'small' : 'button', textSize: Math.round(Math.min(f.ts.button, btnH * 0.36)), note: i === choices.length - 1 ? 'Leaves the conversation' : 'An answer' })),
    },
  ];
  const portraitNode: MockNode = { ...art(c, 'Portrait', 'iconFrame', box(portrait ? 22 : -Math.round(port * 0.12), -Math.round(port * (portrait ? 0.62 : 0.42)), port, port), {}), z: 6, note: 'The speaker (an icon, or a ViewportFrame of the NPC)', kids: [icon(c, 'Face', npc.glyph, box(0, 0, Math.round(port * 0.6), Math.round(port * 0.6), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), 'legendary', { z: 7 })] };
  if (portrait) {
    boxKids[0] = { ...boxKids[0]!, pos: [0, port + 34, 0, -Math.round(plateH * 0.55)] };
    (boxKids[1] as MockNode).pos = [0, 24, 0, Math.round(plateH * 0.55) + port * 0.42];
  }
  kids.push({ ...skinned(c, 'Frame', 'Box', 'window', undefined, box(0, -inset[3] - (f.phone ? 6 : 24), W, Math.round(H), { sx: 0.5, sy: 1, ax: 0.5, ay: 1 })), note: 'The conversation box', kids: [portraitNode, ...boxKids] });
  return kids;
}

export const dialogue: Template = {
  id: 'dialogue',
  label: 'Dialogue',
  for: 'Talking to an NPC: their portrait and name plate, the line typed out, and the player\'s answers as buttons',
  contentShape: 'name, role, glyph (the NPC\'s portrait), line, choices [up to 4]',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Dialogue', hides: MENU_HIDES, displayOrder: 15, forms: MENU_FORMS, note: 'A conversation (the HUD hides while it shows)', build: (f) => dialogueLayout(L, f, content) });
    return {
      screens: [shade('DialogueShade', 14, { rot: 90, colors: [[0, '#ffffff'], [1, '#ffffff']], transp: [[0, 1], [0.45, 0.9], [1, 0.35]] }, 'Darkens the bottom of the world so the box reads'), screen],
      motion: [
        { play: 'enter', target: 'Dialogue.Box', from: 'up', amount: 40 },
        { play: 'enter', target: 'Dialogue.Box.Portrait', from: 'pop', delay: 0.1 },
        { play: 'enter', target: 'Dialogue.Box.Choices', from: 'right', gap: 0.06, delay: 0.25 },
        { play: 'float', target: 'Dialogue.Box.Next', when: 'loop', amount: 4, seconds: 1 },
        { play: 'punch', target: 'Dialogue.Box.Portrait', when: 'a new line', amount: 0.06 },
      ],
      notes: ['Type each line with MaxVisibleGraphemes (strip rich-text tags first); a tap or key completes it, the next tap advances.', 'Answers are buttons (keys 1-4 and the D-pad on a pad); the last one leaves.', 'On touch screens turn the touch controls off while it shows (GuiService.TouchControlsEnabled = false): the box spans the bottom of a phone where the thumbstick and jump button live.'],
    };
  },
};

// ─── Toasts ───────────────────────────────────────────────────────────────────────────────────────

function toastsLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const { inset } = f;
  const g = f.gap;
  const tw = f.phone ? 330 : f.tv ? 560 : 520;
  const th = f.phone ? 66 : Math.round(f.ts.body * 4.4);
  const ic = Math.round(th * 0.7);
  const toast = (name: string, variant: string, glyph: string, isCoin: boolean, head: string, sub: string, action?: string): MockNode => ({
    ...skinned(c, 'Frame', name, 'card', variant, box(0, 0, tw, th)),
    note: 'A toast: slides in, stays 4 s, slides out (newest on top)',
    kids: [
      isCoin ? coin(c, 'Icon', glyph, box(Math.round(th * 0.14), 0, ic, ic, { sy: 0.5, ay: 0.5 }), { z: 3 }) : { ...art(c, 'IconFrame', 'iconFrame', box(Math.round(th * 0.14), 0, ic, ic, { sy: 0.5, ay: 0.5 }), {}), z: 2, kids: [icon(c, 'Icon', glyph, box(0, 0, Math.round(ic * 0.62), Math.round(ic * 0.62), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), variant, { z: 3 })] },
      text(c, 'Head', head, 'h2', 'card', box(Math.round(th * 0.14) + ic + 14, Math.round(th * 0.12), tw - ic - (action ? Math.round(tw * 0.3) : 30) - 20, Math.round(th * 0.42)), { xAlign: 'Left', z: 3, truncate: true }),
      text(c, 'Sub', sub, 'small', 'card', box(Math.round(th * 0.14) + ic + 14, Math.round(th * 0.54), tw - ic - (action ? Math.round(tw * 0.3) : 30) - 20, Math.round(th * 0.34)), { xAlign: 'Left', z: 3, truncate: true }),
      ...(action ? [button(c, 'Action', action, box(-Math.round(th * 0.16), 0, Math.round(tw * 0.24), Math.max(f.phone ? 46 : 44, Math.round(th * 0.6)), { sx: 1, sy: 0.5, ax: 1, ay: 0.5 }), { variant: 'success', role: 'small', note: 'Acts on it (joins the friend)' })] : []),
    ],
  });
  const stack = [
    toast('Achievement', 'legendary', 'trophy', false, content.str('achievement', 'Achievement unlocked!'), content.str('achievementDetail', world.quests[0]!.name), undefined),
    toast('Reward', 'rare', cur.glyph, true, `+500 ${cur.name}`, 'Daily quest complete'),
    toast('Friend', 'common', 'user-plus', false, `${world.players[1]} joined`, 'Your friend is in this server', 'Join'),
  ];
  const n = f.phone ? 2 : 3;
  const x = f.phone ? -inset[2] - 6 : -inset[2] - 16;
  const y0 = f.phone ? inset[1] + 4 : Math.round(f.h * 0.28);
  const kids: MockNode[] = [];
  kids.push(group('Stack', stack.slice(0, n).map((t, i) => ({ ...t, pos: [1, x, 0, y0 + i * (th + g)], anchor: [1, 0] as [number, number] })), 'Toasts, newest on top (a script keeps 3 at most)'));
  // A big banner across the middle for moments that matter (an event starting).
  const bw = Math.round(Math.min(f.w * 0.6, f.phone ? 420 : 760));
  const bh = f.phone ? 58 : Math.round(f.ts.h1 * 3);
  kids.push({
    ...skinned(c, 'Frame', 'Banner', 'ribbon', undefined, box(0, f.phone ? Math.round(f.h * 0.3) : Math.round(f.h * 0.12), bw, bh, { sx: 0.5, ax: 0.5 })),
    note: 'A moment that matters (an event, a boss): stays 3 s',
    kids: [
      text(c, 'Headline', content.str('banner', L.base === 'candy' ? 'DOUBLE COINS!' : L.base === 'ember' ? 'BLOOD MOON RISES' : L.base === 'neon' ? 'SYSTEM BREACH' : L.base === 'parchment' ? 'The Dragon wakes' : 'Party time!'), 'big', 'header', box(0, Math.round(bh * 0.06), bw, Math.round(bh * 0.56)), { z: 3, textSize: Math.round(bh * 0.44) }),
      text(c, 'Detail', 'for the next 15:00', 'small', 'header', box(0, Math.round(bh * 0.6), bw, Math.round(bh * 0.32)), { z: 3 }),
    ],
  });
  return kids;
}

export const toasts: Template = {
  id: 'toasts',
  label: 'Notification toasts',
  for: 'What just happened: a stack of toasts (an achievement, a reward, a friend joining with Join) and a big banner for moments that matter',
  contentShape: 'achievement, achievementDetail, banner, currency {glyph, name}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Toasts', displayOrder: 25, forms: HUD_FORMS, note: 'Notifications over the HUD', build: (f) => toastsLayout(L, f, content) });
    return {
      screens: [screen],
      motion: [
        { play: 'enter', target: 'Toasts.Stack', from: 'right', gap: 0.08, amount: 60 },
        { play: 'enter', target: 'Toasts.Banner', from: 'pop', delay: 0.2 },
        { play: 'punch', target: 'Toasts.Banner', amount: 0.12, delay: 0.45 },
        { play: 'shimmer', target: 'Toasts.Stack.Achievement', when: 'loop', seconds: 2 },
        { play: 'close', target: 'Toasts.Stack.Reward', when: 'after 4 s' },
      ],
      notes: ['Clone a toast per event into Stack (newest on top, 3 at most, 4 s each); the Banner shows for 3 s.', 'Phones show two toasts in the top-right corner (Roblox\'s player list starts hidden there).'],
    };
  },
};

// ─── Confirm ──────────────────────────────────────────────────────────────────────────────────────

function confirmLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const item = world.shop.items[3]!;
  const what = content.str('item', item.name);
  const price = content.str('price', item.price ?? '99K');
  const [W, H] = fitWindow(c, f.portrait ? [f.w - 24, 560] : f.phone ? [600, f.h] : f.tv ? [820, 560] : [720, 500]);
  const titleText = content.str('title', L.base === 'parchment' ? 'Are you sure?' : L.base === 'frost' ? 'Confirm' : 'ARE YOU SURE?');
  const win = window(c, { title: titleText, w: W, h: H }, (bw, bh) => {
    const kids: MockNode[] = [];
    const btnH = Math.max(f.tap, Math.round(f.ts.button * 2.4));
    const s = Math.round(Math.min(bh - btnH - 40, f.phone ? 120 : 180, bw * 0.34));
    const top = Math.round((bh - btnH - 16 - s) / 2);
    kids.push({ ...slotTile(c, 'Item', { glyph: item.glyph, rarity: item.rarity }, s), pos: [0, f.portrait ? Math.round((bw - s) / 2) : 10, 0, top], note: 'What it is about' });
    const tx = f.portrait ? 0 : s + 30;
    const tw = bw - tx;
    const ty = f.portrait ? top + s + 10 : top;
    kids.push(text(c, 'Question', content.str('question', `Buy ${what}?`), 'h1', 'panel', box(tx, ty, tw, f.ts.h1 + 10), { xAlign: f.portrait ? 'Center' : 'Left', z: 3 }));
    kids.push({ name: 'Price', cls: 'Frame', ...place(box(tx, ty + f.ts.h1 + 14, tw, f.ts.num * 1.8)), bgT: 1, note: 'What it costs', kids: [coin(c, 'Coin', cur.glyph, box(f.portrait ? Math.round(tw / 2 - f.ts.num * 3) : 0, 0, Math.round(f.ts.num * 1.6), Math.round(f.ts.num * 1.6), { sy: 0.5, ay: 0.5 }), { z: 3 }), text(c, 'Amount', price, 'num', 'panel', box((f.portrait ? Math.round(tw / 2 - f.ts.num * 3) : 0) + Math.round(f.ts.num * 1.6) + 8, 0, Math.round(tw * 0.6), f.ts.num * 1.8), { xAlign: 'Left', z: 3, textSize: Math.round(f.ts.num * 1.2) })] });
    if (!f.portrait) kids.push(text(c, 'Detail', content.str('detail', `You have ${cur.amount} ${cur.name}`), 'small', 'muted', box(tx, ty + f.ts.h1 + 18 + f.ts.num * 1.8, tw, f.ts.small + 6), { xAlign: 'Left', z: 3 }));
    if (!f.phone) {
      const tgH = Math.round(f.ts.small * 1.6);
      kids.push({ name: 'DontAsk', cls: 'Frame', ...place(box(tx, ty + f.ts.h1 + 30 + f.ts.num * 1.8 + f.ts.small, tw, Math.max(tgH, f.ts.small + 8))), bgT: 1, kids: [toggle(c, 'Toggle', false, box(0, 0, Math.round(tgH * 1.9), tgH, { sy: 0.5, ay: 0.5 }), 'Skips this question next time'), text(c, 'Label', 'Don\'t ask again', 'small', 'muted', box(Math.round(tgH * 1.9) + 10, 0, tw - Math.round(tgH * 1.9) - 10, Math.max(tgH, f.ts.small + 8)), { xAlign: 'Left', z: 3 })] });
    }
    const half = Math.round((bw - 16) / 2);
    kids.push(button(c, 'Cancel', 'Cancel', box(0, 0, half, btnH, { sy: 1, ay: 1 }), { variant: 'secondary', note: 'Closes without doing it (also Back / B)' }));
    kids.push(button(c, 'Confirm', `BUY ${price}`, box(0, 0, half, btnH, { sx: 1, sy: 1, ax: 1, ay: 1 }), { variant: L.go, coin: cur.glyph, disable: true, note: 'Does it (the server checks again); disabled when the player can\'t afford it' }));
    return kids;
  });
  return [win];
}

export const confirmDialog: Template = {
  id: 'confirm-dialog',
  label: 'Confirm dialog',
  for: 'Asking before something that costs or can\'t be undone: what it is about, the question, the price and the balance, Cancel and Confirm',
  contentShape: 'title, item, price, question, detail, currency {glyph, name, amount}',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'Confirm', hides: MENU_HIDES, forms: MENU_FORMS, note: 'A confirm dialog over everything (DisplayOrder above the menus)', build: (f) => confirmLayout(L, f, content) });
    return {
      screens: menuScreens('Confirm', screen, 40),
      motion: [
        { play: 'open', target: 'Confirm.Window' },
        { play: 'enter', target: 'Confirm.Window.Body.Item', from: 'pop', delay: 0.08 },
        { play: 'float', target: 'Confirm.Window.Body.Item', when: 'loop', amount: 4, seconds: 2.2 },
        { play: 'shake', target: 'Confirm.Window.Body.Price', when: 'the player can\'t afford it', amount: 5 },
      ],
      notes: ['Opens over any menu (DisplayOrder 40); Cancel, Back or B closes it; Confirm asks the server, which checks again.', 'Gamepad focus starts on Cancel for anything that can\'t be undone (set GuiService.SelectedObject).'],
    };
  },
};
