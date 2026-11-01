import type { MockMotion, MockNode } from '@shared/ui-mockup';
import { Content, readCurrency, worldOf } from './content';
import { composeScreen, type FormCtx } from './forms';
import { lookOf, type Look } from './look';
import { art, artStates, bar, box, button, currency, group, icon, skinned, tag, text, type Box, type Ctx } from './parts';
import type { Template, TemplateInput, TemplateOutput } from './types';

/**
 * Where Roblox's own touch controls sit on a form's canvas (design points from the bottom corners), from the Lab's
 * layout of TouchJump and DynamicThumbstick on every phone and tablet it knows: the HUD keeps its buttons out of
 * them, and out of the thumbstick's start area (the lower two thirds of the left 40%) where it can.
 */
export function touchKeepOut(f: FormCtx): { jump: { right: [number, number]; bottom: [number, number] }; ring: { left: [number, number]; bottom: [number, number] } } | null {
  if (f.form === 'phone') return { jump: { right: [31, 120], bottom: [24, 114] }, ring: { left: [34, 131], bottom: [22, 119] } };
  if (f.form === 'tablet') return { jump: { right: [60, 216], bottom: [108, 266] }, ring: { left: [70, 260], bottom: [44, 236] } };
  return null;
}

const HEALTH: Record<string, string> = { candy: '#3ee070', ember: '#e2322b', neon: '#3dff9a', parchment: '#c0392b', frost: '#2ccf8a' };
const STAMINA: Record<string, string> = { candy: '#4cb3ff', ember: '#ffcf5a', neon: '#3fe6ff', parchment: '#e8b54a', frost: '#5b7cff' };
const PAD_KEYS = ['X', 'Y', 'B', 'RB'];

/** An ability: its slot art, icon, a key hint on keyboards and pads, and the cooldown's shade and seconds when it is cooling. */
function ability(c: Ctx, name: string, a: { name: string; glyph: string; key: string; cd?: number }, b: Box, o: { ult?: boolean; key?: string } = {}): MockNode {
  const { f, L } = c;
  const s = Math.min(b.w, b.h);
  const corner = L.fill('slot', o.ult ? 'legendary' : 'rare').corner;
  const kids: MockNode[] = [icon(c, 'Icon', a.glyph, box(0, 0, Math.round(s * 0.62), Math.round(s * 0.62), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), o.ult ? 'legendary' : undefined, { z: 3 })];
  if (a.cd) {
    kids.push({ name: 'Cooldown', cls: 'Frame', pos: [0, 0, 1, 0], anchor: [0, 1], size: [1, 0, a.cd, 0], bg: '#000000', bgT: 0.42, corner: [0, corner], z: 4, note: 'Drains as the cooldown runs (the game sets its height)' });
    kids.push(text(c, 'Seconds', (a.cd * 6).toFixed(1), 'num', 'scene', box(0, 0, s, s), { z: 5, textSize: Math.round(s * 0.3) }));
  }
  if (o.key) {
    const k = Math.round(Math.max(f.ts.small + 8, s * 0.3));
    kids.push({ ...skinned(c, 'Frame', 'KeyHint', 'pill', undefined, box(-Math.round(k * 0.2), -Math.round(k * 0.2), Math.round(k * (o.key.length > 1 ? 1.5 : 1.1)), k)), z: 6, note: 'The key or button that fires it (follows the input: keys on a keyboard, pad buttons on a controller)', kids: [text(c, 'Key', o.key, 'small', 'dark', box(0, 0, Math.round(k * (o.key.length > 1 ? 1.5 : 1.1)), k), { z: 7, ...L.font('num'), textSize: Math.max(f.ts.small - 2, Math.round(k * 0.56)) })] });
  }
  return { ...skinned(c, 'ImageButton', name, 'slot', o.ult ? 'legendary' : 'rare', b), states: artStates(c, 'slot', o.ult ? 'legendary' : 'rare', { disabled: true }), note: `${a.name}: fires the ability (the server checks the cooldown)`, kids };
}

/** The score bar: both teams' scores either side of the round timer. */
function matchBar(c: Ctx, b: Box, round: string): MockNode {
  const { f } = c;
  const h = b.h;
  const tw = Math.round(h * 2.6);
  const sw = Math.round(h * 1.6);
  return {
    name: 'Match',
    cls: 'Frame',
    pos: [b.sx ?? 0, b.x, b.sy ?? 0, b.y],
    size: [0, b.w, 0, b.h + Math.round(f.ts.small * 1.4)],
    anchor: [b.ax ?? 0, b.ay ?? 0],
    bgT: 1,
    note: 'Team scores and the round timer (from the server)',
    kids: [
      { ...skinned(c, 'Frame', 'Blue', 'card', 'rare', box(-Math.round(tw / 2 + 6), 0, sw, h, { sx: 0.5, ax: 1 })), kids: [text(c, 'Score', '12', 'num', 'card', box(0, 0, sw, h), { z: 3, scaled: true, textMax: Math.round(h * 0.56), padding: [[0, 6], [0, 6], [0, 6], [0, 6]] })] },
      { ...skinned(c, 'Frame', 'Timer', 'pill', undefined, box(0, 0, tw, h, { sx: 0.5, ax: 0.5 })), kids: [icon(c, 'Clock', 'timer', box(Math.round(h * 0.18), 0, Math.round(h * 0.6), Math.round(h * 0.6), { sy: 0.5, ay: 0.5 }), undefined, { z: 3 }), text(c, 'Time', '02:41', 'num', 'dark', box(Math.round(h * 0.7), 0, tw - Math.round(h * 0.86), h), { z: 3, textSize: Math.round(h * 0.5) })] },
      { ...skinned(c, 'Frame', 'Red', 'card', 'mythic', box(Math.round(tw / 2 + 6), 0, sw, h, { sx: 0.5 })), kids: [text(c, 'Score', '9', 'num', 'card', box(0, 0, sw, h), { z: 3, scaled: true, textMax: Math.round(h * 0.56), padding: [[0, 6], [0, 6], [0, 6], [0, 6]] })] },
      text(c, 'Round', round, 'small', 'scene', box(0, h + 2, b.w, Math.round(f.ts.small * 1.3), { sx: 0.5, ax: 0.5 }), {}),
    ],
  };
}

/** The kill feed: who took out whom, with what (newest on top, the player's own lines lit). */
function killFeed(c: Ctx, b: Box, players: string[], rows: number): MockNode {
  const { f, L } = c;
  const rh = Math.round(f.ts.small * 1.9);
  const lines: Array<[string, string, string, boolean]> = [
    [players[0]!, 'swords', players[3]!, true],
    [players[4]!, 'crosshair', players[1]!, false],
    [players[2]!, 'flame', players[5]!, false],
    [players[6]!, 'skull', players[7]!, false],
  ];
  return {
    name: 'KillFeed',
    cls: 'Frame',
    pos: [b.sx ?? 0, b.x, b.sy ?? 0, b.y],
    size: [0, b.w, 0, rows * (rh + 6)],
    anchor: [b.ax ?? 0, b.ay ?? 0],
    bgT: 1,
    note: 'Kills as they happen: newest on top, 4-5 s each, the player\'s own lines lit',
    kids: lines.slice(0, rows).map(([a, g, v, mine], i) => {
      const w = Math.round(b.w * 0.92);
      const half = Math.round((w - rh * 1.4) / 2);
      return {
        ...skinned(c, 'Frame', `Line${i + 1}`, 'pill', undefined, box(0, i * (rh + 6), w, rh, { sx: 1, ax: 1 })),
        kids: [
          text(c, 'Killer', a, 'small', 'dark', box(8, 0, half - 8, rh), { xAlign: 'Right', z: 3, truncate: true, ...(mine ? { ink: L.ink('gold') } : {}) }),
          icon(c, 'Weapon', g, box(0, 0, Math.round(rh * 0.8), Math.round(rh * 0.8), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), undefined, { z: 3 }),
          text(c, 'Victim', v, 'small', 'dark', box(-8, 0, half - 8, rh, { sx: 1, ax: 1 }), { xAlign: 'Left', z: 3, truncate: true }),
        ],
      };
    }),
  };
}

/** The minimap's frame: the map (a ViewportFrame or image in the game), the player's arrow, north. */
function minimap(c: Ctx, b: Box, kills: string, rank: string): MockNode {
  const { f, L } = c;
  const s = b.w;
  const round = L.base === 'candy' || L.base === 'parchment';
  const chip = Math.round(f.ts.small * 1.9);
  const cw = Math.max(Math.round(s * 0.48), Math.round(chip * 2.3));
  return {
    name: 'Minimap',
    cls: 'Frame',
    pos: [b.sx ?? 0, b.x, b.sy ?? 0, b.y],
    size: [0, s, 0, s + chip + 8],
    anchor: [b.ax ?? 0, b.ay ?? 0],
    bgT: 1,
    note: 'The minimap slot: put a ViewportFrame or a map image in Map',
    kids: [
      { ...art(c, 'Frame', 'iconFrame', box(0, 0, s, s), {}), z: 2 },
      { name: 'Map', cls: 'Frame', ...{ pos: [0.5, 0, 0, Math.round(s / 2)] as [number, number, number, number], size: [0, Math.round(s * 0.8), 0, Math.round(s * 0.8)] as [number, number, number, number], anchor: [0.5, 0.5] as [number, number] }, bg: L.base === 'frost' ? '#cfe3d6' : L.base === 'parchment' ? '#c9b07a' : '#24402c', corner: [round ? 0.5 : 0, round ? 0 : 6], gradient: { rot: 90, colors: [[0, '#ffffff'], [1, '#9aa7a0']] }, z: 3, note: 'The map itself (the game draws it)' },
      icon(c, 'You', 'navigation', box(0, Math.round(s / 2), Math.round(s * 0.2), Math.round(s * 0.2), { sx: 0.5, ax: 0.5, ay: 0.5 }), 'legendary', { z: 5 }),
      text(c, 'North', 'N', 'small', 'scene', box(0, Math.round(s * 0.04), Math.round(s * 0.2), Math.round(f.ts.small * 1.2), { sx: 0.5, ax: 0.5 }), { z: 5 }),
      { ...skinned(c, 'Frame', 'Kills', 'pill', undefined, box(0, s + 8, cw, chip)), kids: [icon(c, 'Icon', 'skull', box(6, 0, Math.round(chip * 0.7), Math.round(chip * 0.7), { sy: 0.5, ay: 0.5 }), undefined, { z: 3 }), text(c, 'Count', kills, 'num', 'dark', box(Math.round(chip * 0.8), 0, cw - Math.round(chip * 0.9), chip), { z: 3, scaled: true, textMax: f.ts.small, padding: [[0, 3], [0, 0], [0, 3], [0, 0]] })] },
      { ...skinned(c, 'Frame', 'Rank', 'pill', undefined, box(cw + 6, s + 8, cw, chip)), kids: [icon(c, 'Icon', 'trophy', box(6, 0, Math.round(chip * 0.7), Math.round(chip * 0.7), { sy: 0.5, ay: 0.5 }), 'legendary', { z: 3 }), text(c, 'Place', rank, 'num', 'dark', box(Math.round(chip * 0.8), 0, cw - Math.round(chip * 0.9), chip), { z: 3, scaled: true, textMax: f.ts.small, padding: [[0, 3], [0, 0], [0, 3], [0, 0]] })] },
    ],
  };
}

/** Health and stamina with the player's level: the vitals. */
function vitals(c: Ctx, b: Box, o: { avatar: boolean; name: string }): MockNode {
  const { f, L } = c;
  const hh = Math.round(f.ts.body * (f.phone ? 1.5 : 1.75));
  const sh = Math.round(hh * 0.5);
  const av = o.avatar ? hh + sh + 14 : 0;
  const bx = av ? av + 10 : 0;
  const kids: MockNode[] = [];
  if (o.avatar) {
    kids.push({ ...art(c, 'Avatar', 'iconFrame', box(0, 0, av, av, { sy: 1, ay: 1 }), {}), z: 2, kids: [icon(c, 'Face', 'user', box(0, 0, Math.round(av * 0.6), Math.round(av * 0.6), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), undefined, { z: 3 })] });
    const lb = Math.round(Math.max(av * 0.5, f.ts.small * 2.2));
    kids.push({ ...art(c, 'Level', 'badge', box(-Math.round(lb * 0.25), -Math.round(lb * 0.1), lb, lb, { sy: 1, ay: 1 }), {}), z: 6, kids: [text(c, 'Value', '23', 'num', 'card', box(0, 0, lb, lb), { z: 7, textSize: f.ts.small, ink: { color: '#ffffff', stroke: { color: '#2b1306', px: 1.5, text: true } } })] });
    kids.push(text(c, 'PlayerName', o.name, 'body', 'scene', box(bx, -(hh + sh + 14) - f.ts.body - 4, b.w - bx, f.ts.body + 4, { sy: 1 }), { xAlign: 'Left', z: 3 }));
  }
  kids.push(bar(c, 'Health', box(bx, -(sh + 8), b.w - bx, hh, { sy: 1, ay: 1 }), 0.86, { accent: HEALTH[L.base], label: '86 / 100', labelRole: 'num', note: 'Health: follows Humanoid.Health, a trail shows each hit', kids: [icon(c, 'Icon', 'heart', box(-Math.round(hh * 0.1), 0, Math.round(hh * 1.1), Math.round(hh * 1.1), { sy: 0.5, ay: 0.5 }), 'mythic', { z: 5 })] }));
  kids.push(bar(c, 'Stamina', box(bx, 0, Math.round((b.w - bx) * 0.8), sh, { sy: 1, ay: 1 }), 0.58, { accent: STAMINA[L.base], note: 'Stamina: drains while sprinting' }));
  return { name: 'Vitals', cls: 'Frame', pos: [b.sx ?? 0, b.x, b.sy ?? 0, b.y], size: [0, b.w, 0, b.h], anchor: [b.ax ?? 0, b.ay ?? 0], bgT: 1, note: 'The player\'s vitals', kids };
}

function combatLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const abilities = content.list('abilities', world.abilities, (x, d) => ({ name: String(x.name ?? d?.name ?? 'Ability'), glyph: String(x.glyph ?? d?.glyph ?? 'zap'), key: String(x.key ?? d?.key ?? '?'), ...(typeof x.cd === 'number' ? { cd: x.cd } : d?.cd !== undefined ? { cd: d.cd } : {}) })).slice(0, 4);
  const ult = { name: content.str('ultimate', 'Ultimate'), glyph: content.str('ultimateGlyph', L.base === 'candy' ? 'star' : L.base === 'neon' ? 'atom' : L.base === 'frost' ? 'sparkles' : 'flame'), key: 'G' };
  const players = content.strs('players', world.players);
  const round = content.str('round', 'Round 3 · first to 15');
  const [il, it, ir, ib] = f.inset;
  const kids: MockNode[] = [];
  const keep = touchKeepOut(f);
  // Top: the score bar in the middle, the minimap on the left, the feed on the right.
  const mh = Math.round(Math.max(f.phone ? 40 : 48, f.ts.num * 1.8));
  kids.push(matchBar(c, box(0, it + 4, Math.round(mh * 6.2), mh, { sx: 0.5, ax: 0.5 }), round));
  const ms = f.phone ? 96 : f.form === 'tablet' ? 140 : 156;
  kids.push(minimap(c, box(il + 6, it + 4, ms, ms), '7', '#3'));
  kids.push(killFeed(c, box(-ir - 6, it + 4, f.phone ? 250 : 400, 0, { sx: 1, ax: 1 }), players, f.phone ? 3 : 4));
  if (keep) {
    // Touch: abilities in an arc left of and above the jump button; vitals at the bottom between the thumbs.
    const s = f.phone ? 62 : 96;
    const gap = f.phone ? 10 : 16;
    const jr = keep.jump.right;
    const jb = keep.jump.bottom;
    const spots: Array<[number, number]> = [
      [jr[1] + gap, jb[0] - 4],
      [jr[1] + gap, jb[0] - 4 + s + gap],
      [jr[0] + Math.round((jr[1] - jr[0] - s) / 2), jb[1] + gap],
    ];
    const moves: MockNode[] = [];
    abilities.slice(0, 3).forEach((a, i) => moves.push(ability(c, `Ability${i + 1}`, a, box(-spots[i]![0], -spots[i]![1], s, s, { sx: 1, sy: 1, ax: 1, ay: 1 }))));
    const us = Math.round(s * 1.16);
    moves.push(ability(c, 'Ultimate', ult, box(-(jr[1] + gap + s + gap), -(jb[0] - 4), us, us, { sx: 1, sy: 1, ax: 1, ay: 1 }), { ult: true }));
    kids.push(group('Abilities', moves, 'The moves: an arc beside the jump button of Roblox'));
    const vw = f.phone ? 270 : 420;
    const left = keep.ring.left[1] + 24;
    const right = jr[1] + gap * 2 + s + us;
    const room = f.w - left - right;
    kids.push(vitals(c, box(left + Math.max(0, Math.round((room - vw) / 2)), -ib - 10, Math.min(vw, room), f.ts.body * 4, { sy: 1, ay: 1 }), { avatar: false, name: '' }));
  } else {
    // Keyboard and controller: vitals bottom-left, abilities bottom-centre with their keys, the weapon bottom-right.
    const s = f.tv ? 104 : 92;
    const gap = f.tv ? 18 : 14;
    const keys = f.tv ? PAD_KEYS : abilities.map((a) => a.key);
    const n = abilities.length;
    const us = Math.round(s * 1.22);
    const total = n * s + (n - 1) * gap + gap * 2 + us;
    const vwFor = f.tv ? 430 : 440;
    // Centred, unless that would run into the vitals on the left.
    const x0 = Math.max(-Math.round(total / 2), il + 10 + vwFor + 30 - Math.round(f.w / 2));
    const moves: MockNode[] = abilities.map((a, i) => ability(c, `Ability${i + 1}`, a, box(x0 + i * (s + gap), -ib - 14, s, s, { sx: 0.5, sy: 1, ay: 1 }), { key: keys[i] }));
    moves.push(ability(c, 'Ultimate', ult, box(x0 + n * (s + gap) + gap, -ib - 14, us, us, { sx: 0.5, sy: 1, ay: 1 }), { ult: true, key: f.tv ? 'RT' : 'G' }));
    kids.push(group('Abilities', moves, 'The moves, bottom-centre with their keys'));
    const vw = vwFor;
    kids.push(vitals(c, box(il + 10, -ib - 14, vw, f.ts.body * 6, { sy: 1, ay: 1 }), { avatar: true, name: players[0]! }));
    // The weapon: its icon, ammo in the clip and in reserve.
    const ww = f.tv ? 300 : 270;
    const wh = Math.round(f.ts.big * 1.5);
    kids.push({
      ...skinned(c, 'Frame', 'Weapon', 'card', 'common', box(-ir - 10, -ib - 14, ww, wh, { sx: 1, sy: 1, ax: 1, ay: 1 })),
      note: 'The equipped weapon and its ammo',
      kids: [
        icon(c, 'Icon', L.base === 'candy' ? 'wand-sparkles' : L.base === 'parchment' ? 'sword' : L.base === 'frost' ? 'camera' : 'crosshair', box(14, 0, Math.round(wh * 0.7), Math.round(wh * 0.7), { sy: 0.5, ay: 0.5 }), 'rare', { z: 3 }),
        text(c, 'Clip', '24', 'big', 'card', box(Math.round(wh * 0.7) + 24, 0, Math.round(ww * 0.36), wh), { xAlign: 'Right', z: 3, textSize: Math.round(wh * 0.5) }),
        text(c, 'Reserve', '/ 120', 'body', 'card', box(-14, 0, Math.round(ww * 0.3), wh, { sx: 1, ax: 1 }), { xAlign: 'Left', z: 3, ink: L.ink('card'), textT: 0.15 }),
      ],
    });
  }
  return kids;
}

export const hudCombat: Template = {
  id: 'hud-combat',
  label: 'Combat HUD',
  for: 'Fighting, shooters, battlegrounds, arenas: health and stamina, abilities with cooldowns and key hints, an ultimate, team scores and the round timer, a kill feed, a minimap slot and ammo — clear of Roblox\'s thumbstick, jump button and top bar on touch screens',
  contentShape: 'abilities [{name, glyph, key, cd 0-1}], ultimate, ultimateGlyph, players [names for the feed], round',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'HUD', forms: ['phone', 'tablet', 'desktop', 'tv'], note: 'The combat HUD (ResetOnSpawn off)', build: (f) => combatLayout(L, f, content) });
    const motion: MockMotion[] = [
      { play: 'enter', target: 'HUD.Match', from: 'down', delay: 0.1 },
      { play: 'enter', target: 'HUD.Vitals', from: 'up', delay: 0.15 },
      { play: 'enter', target: 'HUD.KillFeed', from: 'left', gap: 0.05, when: 'a kill' },
      { play: 'shake', target: 'HUD.Vitals.Health', when: 'damage taken', amount: 4 },
      { play: 'pulse', target: 'HUD.Abilities.Ultimate', when: 'loop', amount: 0.06, seconds: 1.2, note: 'While the ultimate is charged' },
      { play: 'punch', target: 'HUD.Abilities.Ability1', when: 'press', amount: 0.12 },
      { play: 'pulse', target: 'HUD.Match.Timer', when: 'last 10 seconds', amount: 0.08, seconds: 1 },
    ];
    return {
      screens: [screen],
      motion,
      notes: [
        'Touch screens: the abilities sit left of and above Roblox\'s jump button and the vitals between the thumbs; bind them with ContextActionService or as ImageButtons.',
        'Keyboards and controllers: abilities bottom-centre with key hints (Q E R F, or pad buttons on a TV), vitals bottom-left, the weapon bottom-right.',
        'Minimap.Map is a slot for a ViewportFrame or a map image; the player\'s arrow turns with the camera.',
        'Desktop: the minimap shares the top-left with Roblox\'s chat window and the feed the top-right with the player list: turn those off (SetCoreGuiEnabled) in a match if they clash.',
      ],
    };
  },
};

// ─── Simulator ────────────────────────────────────────────────────────────────────────────────────

const MENU: Array<[string, string, string?]> = [['Shop', 'store', '!'], ['Pets', 'paw-print'], ['Rebirth', 'refresh-cw'], ['Quests', 'scroll-text', '3'], ['Codes', 'ticket'], ['Settings', 'settings']];

/** A big square menu button with its label under it and a red count badge. */
function menuButton(c: Ctx, name: string, label: string, glyph: string, b: Box, badge?: string, withLabel = true): MockNode {
  const { f } = c;
  const kids: MockNode[] = [icon(c, 'Icon', glyph, box(0, withLabel ? -Math.round(b.h * 0.08) : 0, Math.round(b.h * 0.6), Math.round(b.h * 0.6), { sx: 0.5, sy: 0.5, ax: 0.5, ay: 0.5 }), undefined, { z: 3 })];
  if (withLabel) kids.push(text(c, 'Label', label, 'small', 'card', box(0, -2, b.w, f.ts.small + 6, { sy: 1, ay: 1 }), { z: 4, ...c.L.font('button'), textSize: f.ts.small }));
  if (badge) {
    const s = Math.round(Math.max(f.ts.small + 8, b.h * 0.34));
    kids.push(tag(c, 'Badge', badge, box(Math.round(s * 0.3), -Math.round(s * 0.3), s, s, { sx: 1, ax: 1 }), { size: Math.round(s * 0.5) }));
  }
  return { ...skinned(c, 'ImageButton', name, 'slot', c.L.base === 'candy' ? 'rare' : 'common', b), states: artStates(c, 'slot', c.L.base === 'candy' ? 'rare' : 'common'), note: `Opens ${label}`, kids };
}

/** An active boost: its icon, what it does, the time left. */
function boost(c: Ctx, name: string, glyph: string, what: string, time: string, b: Box): MockNode {
  const h = b.h;
  return {
    ...skinned(c, 'Frame', name, 'pill', undefined, b),
    note: 'An active boost and the time it has left',
    kids: [
      icon(c, 'Icon', glyph, box(Math.round(h * 0.12), 0, Math.round(h * 0.78), Math.round(h * 0.78), { sy: 0.5, ay: 0.5 }), 'legendary', { z: 3 }),
      text(c, 'What', what, 'small', 'dark', box(Math.round(h * 1.0), 0, Math.round((b.w - h * 1.1) * 0.5), h), { xAlign: 'Left', z: 3, ...c.L.font('num') }),
      text(c, 'Time', time, 'small', 'dark', box(-Math.round(h * 0.25), 0, Math.round((b.w - h * 1.1) * 0.5), h, { sx: 1, ax: 1 }), { xAlign: 'Right', z: 3, ...c.L.font('num'), textT: 0.1 }),
    ],
  };
}

function simLayout(L: Look, f: FormCtx, content: Content): MockNode[] {
  const c: Ctx = { L, f };
  const world = worldOf(L.id);
  const cur = readCurrency(content.obj('currency'), world.currency);
  const gems = readCurrency(content.obj('premium'), world.premium);
  const power = content.str('power', L.base === 'candy' ? 'Strength' : L.base === 'neon' ? 'Power' : L.base === 'parchment' ? 'Might' : L.base === 'frost' ? 'Vibes' : 'Rage');
  const menu = content.list('menu', MENU, (x, d) => [String(x.name ?? d?.[0] ?? 'Menu'), String(x.glyph ?? d?.[1] ?? 'star'), typeof x.badge === 'string' ? x.badge : d?.[2]] as [string, string, string?]).slice(0, 6);
  const [il, it, ir, ib] = f.inset;
  const kids: MockNode[] = [];
  const keep = touchKeepOut(f);
  const ph = f.phone ? 44 : f.tv ? 64 : 60;
  const pw = f.phone ? 180 : f.tv ? 310 : 290;
  // Currencies, top-left.
  const wallet: MockNode[] = [];
  wallet.push({ ...currency(c, 'Coins', cur.glyph, cur.amount, box(il + Math.round(ph * 0.4), it + 6, pw, ph), { plus: true }), note: `${cur.name}: counts up as it changes` });
  wallet.push({ ...currency(c, 'Gems', gems.glyph, gems.amount, box(il + Math.round(ph * 0.4), it + 6 + ph + 10, Math.round(pw * 0.86), ph), { plus: true }), note: `${gems.name}` });
  wallet.push(text(c, 'Rate', `+1.2K/s`, 'small', 'scene', box(il + Math.round(ph * 0.4) + pw + 10, it + 6, f.phone ? 80 : 120, ph), { xAlign: 'Left', note: 'Earned per second', ink: { color: String(L.hue.good), stroke: L.ink('scene').stroke ?? { color: '#000000', px: 1.5, text: true, t: 0.3 } } }));
  kids.push(group('Wallet', wallet, 'The currencies'));
  const menuKids: MockNode[] = [];
  const boosts: MockNode[] = [];
  if (f.phone) {
    // Phones: the menu as a row along the top (out of the thumbstick's area), boosts under it.
    const s = 54;
    const n = Math.min(menu.length, 5);
    const rowW = n * s + (n - 1) * 8;
    menu.slice(0, n).forEach(([label, glyph, badge], i) => menuKids.push(menuButton(c, `Menu${label}`, label, glyph, box(-Math.round(rowW / 2) + i * (s + 8) + 40, it + 6, s, s, { sx: 0.5 }), badge, false)));
    // Boosts in the top-right corner (free on phones: the player list starts hidden there).
    boosts.push(boost(c, 'Boost1', 'coins', 'x2', '14:59', box(-ir - 8, it + 6, 128, 36, { sx: 1, ax: 1 })));
    boosts.push(boost(c, 'Boost2', 'clover', 'x2', '04:12', box(-ir - 8, it + 6 + 44, 128, 36, { sx: 1, ax: 1 })));
  } else {
    // Big screens: the menu as a column of big square buttons with labels, boosts top-centre.
    const s = f.tv ? 116 : 104;
    const cols = 2;
    menu.forEach(([label, glyph, badge], i) => menuKids.push(menuButton(c, `Menu${label}`, label, glyph, box(il + 10 + (i % cols) * (s + 14), Math.round(f.h * 0.22) + Math.floor(i / cols) * (s + 14), s, s, { sy: 0 }), badge)));
    const bw = f.tv ? 230 : 210;
    const bh = Math.round(f.ts.small * 2.3);
    boosts.push(boost(c, 'Boost1', 'coins', 'x2 Coins', '14:59', box(-bw - 6, it + 8, bw, bh, { sx: 0.5 })));
    boosts.push(boost(c, 'Boost2', 'clover', 'x2 Luck', '04:12', box(6, it + 8, bw, bh, { sx: 0.5 })));
  }
  kids.push(group('Menu', menuKids, 'The menu buttons (badges show what is new)'));
  kids.push(group('Boosts', boosts, 'Active boosts and their time left'));
  // The goal: progress to the next rebirth, the rebirth button and auto.
  const gw = f.phone ? 340 : f.tv ? 560 : 520;
  const bh = f.phone ? 22 : Math.round(f.ts.body * 1.4);
  const btnH = f.phone ? 54 : Math.round(f.ts.button * 2.4);
  const goalH = f.ts.small + 8 + bh + 12 + btnH;
  const bottom = keep ? Math.max(ib + 8, 20) : ib + 16;
  kids.push({
    name: 'Goal',
    cls: 'Frame',
    pos: [0.5, f.phone ? -10 : 0, 1, -bottom],
    anchor: [0.5, 1],
    size: [0, gw, 0, goalH],
    bgT: 1,
    note: 'Progress to the next rebirth, and the buttons that act on it',
    kids: [
      text(c, 'Label', `${power} 12.4K / 20K`, 'small', 'scene', box(0, 0, gw, f.ts.small + 6), {}),
      bar(c, 'Progress', box(0, f.ts.small + 8, gw, bh), 0.62, { label: '62%', accent: L.base === 'frost' ? undefined : String(L.hue.gold) }),
      button(c, 'Rebirth', L.base === 'ember' || L.base === 'neon' ? 'Rebirth' : 'REBIRTH', box(0, 0, Math.round(gw * 0.64), btnH, { sy: 1, ay: 1 }), { variant: 'premium', icon: 'refresh-cw', note: 'Rebirths when the bar is full (resets coins for a multiplier)' }),
      button(c, 'Auto', L.base === 'ember' || L.base === 'neon' ? 'Auto' : 'AUTO', box(0, 0, Math.round(gw * 0.32), btnH, { sx: 1, sy: 1, ax: 1, ay: 1 }), { variant: 'secondary', note: 'Toggles auto-collecting' }),
    ],
  });
  // The quest tracker, right side (above the jump button on touch screens).
  const q = world.quests[0]!;
  const qw = f.phone ? 200 : f.tv ? 380 : 340;
  const qh = Math.round(f.ts.body * (f.phone ? 4.6 : 5));
  const qy = keep ? -(keep.jump.bottom[1] + 18) : -Math.round(f.h * 0.5);
  kids.push({
    ...skinned(c, 'Frame', 'Quest', 'card', 'common', box(-ir - 8, qy, qw, qh, { sx: 1, sy: keep ? 1 : 1, ax: 1, ay: keep ? 1 : 0.5 })),
    note: 'The tracked quest',
    kids: [
      icon(c, 'Icon', q.glyph, box(12, 10, Math.round(qh * 0.4), Math.round(qh * 0.4)), 'rare', { z: 3 }),
      text(c, 'Name', q.name, 'small', 'card', box(Math.round(qh * 0.4) + 20, 8, qw - Math.round(qh * 0.4) - 30, f.ts.small + 6), { xAlign: 'Left', z: 3, ...c.L.font('button'), truncate: true }),
      text(c, 'Reward', `+${q.reward}`, 'small', 'card', box(Math.round(qh * 0.4) + 20, 10 + f.ts.small + 6, qw - Math.round(qh * 0.4) - 30, f.ts.small + 4), { xAlign: 'Left', z: 3, ink: L.ink(L.base === 'candy' ? 'gold' : 'accent') }),
      bar(c, 'Progress', box(12, -10, qw - 24, Math.round(f.ts.small * 1.3), { sy: 1, ay: 1 }), q.done / q.of, { label: `${q.done}/${q.of}` }),
    ],
  });
  // Above the tracker: a free gift on a timer and a teleport (the right side's doors).
  const ds = f.phone ? 58 : f.tv ? 104 : 96;
  const lab = f.phone ? 0 : f.ts.small + 6;
  const dy = keep ? qy - qh - 14 : qy - Math.round(qh / 2) - 14;
  const doors: Array<[string, string, string, string?]> = [['Gift', 'gift', f.phone ? '04:59' : 'Free in 04:59', '!'], ['Teleport', 'map', 'Worlds']];
  kids.push(group('Side', doors.slice(0, f.phone ? 1 : 2).map(([name, glyph, label, badge], i) => {
    const btn = menuButton(c, name, label, glyph, box(0, 0, ds, ds), badge, false);
    return {
      name,
      cls: 'Frame',
      pos: [1, -ir - 8 - i * (ds + 18), 1, dy],
      anchor: [1, 1] as [number, number],
      size: [0, ds, 0, ds + lab],
      bgT: 1,
      kids: [{ ...btn, name: 'Button', pos: [0, 0, 0, 0] }, ...(lab ? [text(c, 'Label', label, 'small', 'scene', box(-14, ds + 2, ds + 28, lab), {})] : [])],
    };
  }), 'Doors on the right: a free gift on a timer, the worlds'));
  return kids;
}

export const hudSimulator: Template = {
  id: 'hud-simulator',
  label: 'Simulator HUD',
  for: 'Simulators, tycoons, clickers, pet games: currency counters with +, a column of big menu buttons with badges, active boosts with timers, rebirth progress with Rebirth and Auto, a quest tracker',
  contentShape: 'currency {glyph, amount, name}, premium {glyph, amount, name}, power (the stat that rebirths), menu [{name, glyph, badge}]',
  build(i: TemplateInput): TemplateOutput {
    const L = lookOf(i.direction, i.accent);
    const content = new Content(i.content);
    const screen = composeScreen({ name: 'HUD', forms: ['phone', 'tablet', 'desktop', 'tv'], note: 'The simulator HUD (ResetOnSpawn off)', build: (f) => simLayout(L, f, content) });
    const motion: MockMotion[] = [
      { play: 'enter', target: 'HUD.Wallet.Coins', from: 'left' },
      { play: 'enter', target: 'HUD.Wallet.Gems', from: 'left', delay: 0.05 },
      { play: 'count', target: 'HUD.Wallet.Coins.Amount', from: 0, to: 48250, when: 'coins change', seconds: 0.5 },
      { play: 'fly', target: 'HUD.Wallet.Coins.Coin', to: 'HUD.Wallet.Coins', when: 'coins collected', note: 'Coins fly from the world into the counter' },
      { play: 'punch', target: 'HUD.Wallet.Coins', when: 'coins collected', amount: 0.1 },
      { play: 'pulse', target: 'HUD.Goal.Rebirth', when: 'loop', amount: 0.05, seconds: 1.3, note: 'While a rebirth is ready' },
      { play: 'shimmer', target: 'HUD.Goal.Progress', when: 'loop', seconds: 2.5 },
      { play: 'float', target: 'HUD.Menu.MenuShop', when: 'loop', amount: 3, seconds: 2 },
    ];
    return {
      screens: [screen],
      motion,
      notes: [
        'Currencies count up with Motion count and punch when coins land (Motion fly from the world to HUD.Coins).',
        'Phones put the menu along the top so the thumbstick\'s area stays clear; big screens use a column of labelled buttons.',
        'Badges ("!", "3") show what is new behind a button; clear them when it is opened.',
      ],
    };
  },
};
