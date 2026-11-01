import type { MockColor, MockNode } from '@shared/ui-mockup';
import { DIRECTIONS, inkFor, type ElementKind, type Variant } from './directions';

/**
 * Reskin: a design (the game's UI as read, or any mockup version) dressed in an art direction in one step. Each
 * element is read for what it is — a window, its header, a title, buttons by the role their colour says, a row of tabs
 * (the first starts selected), a close button, cards in a grid, a progress bar, a currency pill, item slots — and
 * given that piece's skin with its pressed/selected/disabled art; what the art replaces (its fill's strokes, glows,
 * gradients, hand-set text colours) is cleared so the direction's own ink and outline show. Everything else (layout,
 * text, images, motion) stays, so the result is the same screen, forged.
 */

export interface ReskinOptions {
  direction: string;
  /** "#rrggbb": tints the direction. */
  accent?: string;
  /** The version's colour tokens ("$panel"), to read roles from. */
  theme?: Record<string, MockColor>;
}

type RGB = [number, number, number];

const rgbOf = (c: MockColor | undefined, theme: ReskinOptions['theme']): RGB | null => {
  if (!c) return null;
  if (Array.isArray(c)) return [c[0], c[1], c[2]];
  if (typeof c === 'string' && c.startsWith('$')) return rgbOf(theme?.[c.slice(1)], undefined);
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) {
    const v = parseInt(c.replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return null;
};

/**
 * The colour an element shows: its fill, or its gradient's middle when the fill is white (a gradient tints a white
 * fill), or a grey when neither says.
 */
function colourOf(n: MockNode, theme: ReskinOptions['theme']): RGB | null {
  const bg = rgbOf(n.bg as MockColor | undefined, theme);
  const stops = (n.gradient as { colors?: Array<unknown[]> } | undefined)?.colors ?? [];
  const mids = stops.map((st) => (st.length === 4 ? ([st[1], st[2], st[3]] as RGB) : rgbOf(st[1] as MockColor, theme))).filter((c): c is RGB => !!c);
  const white = !bg || (bg[0] > 235 && bg[1] > 235 && bg[2] > 235);
  if (white && mids.length) {
    const m = mids[Math.floor(mids.length / 2)]!;
    return bg ? [(m[0] * bg[0]) / 255, (m[1] * bg[1]) / 255, (m[2] * bg[2]) / 255] : m;
  }
  return bg;
}

/** A button's role from its colour: green succeeds, red is danger, gold is premium, grey or dark is secondary. */
function roleOf(c: RGB | null): 'primary' | 'secondary' | 'danger' | 'success' | 'premium' {
  if (!c) return 'primary';
  const [r, g, b] = c.map((v) => v / 255) as RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.22 || max < 0.25) return 'secondary';
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 18 || h >= 335) return 'danger';
  if (h < 62) return 'premium';
  if (h < 165) return 'success';
  return 'primary';
}

const RARITY = /\b(common|uncommon|rare|epic|legendary|mythic(al)?)\b/i;
const isButton = (n: MockNode) => n.cls === 'TextButton' || n.cls === 'ImageButton';
const isText = (n: MockNode) => n.cls === 'TextLabel' || n.cls === 'TextButton' || n.cls === 'TextBox';
/** Offset size in points, when the node gives one (scale parts count as unknown). */
const offsetSize = (n: MockNode): [number, number] | null => (n.size && n.size[0] === 0 && n.size[2] === 0 ? [n.size[1], n.size[3]] : null);
/** How much of its parent's width an element spans (scale, or offsets against an offset-sized parent). */
const widthShare = (n: MockNode, parent: MockNode): number => {
  if (!n.size) return 0;
  const ps = offsetSize(parent);
  return n.size[0] + (ps && ps[0] > 0 ? n.size[1] / ps[0] : 0);
};
const textOf = (n: MockNode): string => (typeof n.text === 'string' ? n.text : '');
const allText = (n: MockNode): string => [textOf(n), ...(n.kids ?? []).map(allText)].join(' ');

/** What the art replaces on a skinned element (null removes it). */
const CLEAR = { stroke: null, gradient: null, shadow: null, corner: null, corners: null, shape: null } as const;
/** Text colours the direction's ink should take over. */
const CLEAR_TEXT = { textColor: null, strokeColor: null, strokeT: null } as const;

export function reskinScreens(screens: MockNode[], o: ReskinOptions): { screens: MockNode[]; notes: string[] } {
  if (!DIRECTIONS[o.direction]) throw new Error(`no art direction "${o.direction}" (directions: ${Object.keys(DIRECTIONS).join(', ')})`);
  const d = o.direction;
  const a = o.accent ? (o.accent.startsWith('#') ? o.accent : `#${o.accent}`) : '';
  const counts = new Map<string, number>();
  const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const skinned = (n: MockNode, skin: string, extra: Record<string, unknown> = {}, text = true): MockNode => {
    const out: Record<string, unknown> = { ...n, ...CLEAR, ...(text && isText(n) ? CLEAR_TEXT : {}), skin: `${skin}${a}`, ...extra };
    for (const [k, v] of Object.entries(out)) if (v === null) delete out[k];
    return out as MockNode;
  };
  /** Labels sitting on a piece's art take that surface's ink (a pill's amount, a card's name). */
  const inked = (n: MockNode, kind: ElementKind, variant?: Variant): MockNode => {
    if (!n.kids?.length) return n;
    const ink = inkFor(DIRECTIONS[d]!, { kind, ...(variant ? { variant } : {}) });
    const hex = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? `#${c.slice(0, 3).map((v: number) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : undefined);
    return {
      ...n,
      kids: n.kids.map((k) => {
        if (k.cls !== 'TextLabel' || k.skin) return k;
        const out: Record<string, unknown> = { ...k, textColor: hex(ink.color) };
        if (ink.stroke && (ink.strokePx ?? 0) > 0) out.stroke = { color: hex(ink.stroke), px: ink.strokePx, text: true };
        else delete out.stroke;
        delete out.strokeColor;
        delete out.strokeT;
        return out as MockNode;
      }),
    };
  };
  /**
   * Text lying straight on a panel's art (no fill of its own between) takes the panel's ink: a dark window turned to
   * parchment must not keep its pale text.
   */
  const onPanel = (n: MockNode, kind: ElementKind): MockNode => {
    const ink = inkFor(DIRECTIONS[d]!, { kind });
    const hex = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? `#${c.slice(0, 3).map((v: number) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : undefined);
    const painted = (k: MockNode) => !!k.skin || (k.bg !== undefined && (k.bgT ?? 0) < 0.6) || k.cls === 'ImageLabel' || k.cls === 'ImageButton';
    const walkText = (k: MockNode): MockNode => {
      if (k.cls === 'TextLabel' && !k.skin && !(k.bg !== undefined && (k.bgT ?? 0) < 0.6)) {
        const out: Record<string, unknown> = { ...k, textColor: hex(ink.color) };
        if (ink.stroke && (ink.strokePx ?? 0) > 0) out.stroke = { color: hex(ink.stroke), px: ink.strokePx, text: true };
        return out as MockNode;
      }
      if (painted(k) || !k.kids?.length) return k;
      return { ...k, kids: k.kids.map(walkText) };
    };
    return n.kids?.length ? { ...n, kids: n.kids.map(walkText) } : n;
  };
  const buttonStates = (base: string) => ({ press: { skin: `${base}:pressed${a}`, scale: 0.97 }, hover: { skin: `${base}:hover${a}`, scale: 1.03 } });

  const walk = (n: MockNode, parent: MockNode | null, depth: number, screenArea: number): MockNode => {
    let out: MockNode = n;
    const sz = offsetSize(n);
    const area = sz ? sz[0] * sz[1] : n.size ? n.size[0] * n.size[2] * screenArea : 0;
    const siblings = parent?.kids ?? [];
    // A row of buttons along a list (across the top, or down a side rail) is a set of tabs.
    const rowOfButtons = !!parent?.list && siblings.length >= 2 && siblings.filter(isButton).length >= 2 && siblings.filter(isButton).length >= siblings.length - 1;
    if (!n.skin && depth > 0) {
      const t = textOf(n).trim();
      if (isButton(n)) {
        const small = sz && sz[0] <= 64 && sz[1] <= 64;
        if (/^(x|✕|×|✖|close)$/i.test(t) || (small && !t && /close|exit/i.test(n.name ?? ''))) {
          // The close art draws its own X: the button's letter would double it.
          out = skinned(n, `${d}:close`, { textT: 1, states: { press: { skin: `${d}:close:primary:pressed${a}` }, hover: { skin: `${d}:close:primary:hover${a}` } } });
          count('close buttons');
        } else if ((sz && sz[1] >= 140 && sz[0] >= 120) || (n.kids?.length ?? 0) >= 4) {
          // A big pressable card (an item, a slot of a loadout): card art that sinks a little when pressed.
          const rarity = RARITY.exec(allText(n))?.[1]?.toLowerCase().replace('mythical', 'mythic') ?? 'common';
          const rc = (rarity === 'uncommon' ? 'common' : rarity) as Variant;
          out = inked(skinned(n, `${d}:card:${rc}`, { states: { press: { scale: 0.98 }, hover: { scale: 1.02 } } }), 'card', rc);
          count('cards');
        } else if (rowOfButtons && sz && sz[1] <= 110) {
          const first = siblings.filter(isButton)[0] === n;
          out = skinned(n, `${d}:tab:inactive`, { states: { selected: { skin: `${d}:tab:active${a}` }, press: { skin: `${d}:tab:inactive:pressed${a}` } }, ...(first ? { state: 'selected' } : {}) });
          count('tabs');
        } else {
          const role = roleOf(colourOf(n, o.theme));
          const base = `${d}:button:${role}`;
          out = inked(skinned(n, base, { states: { ...buttonStates(base), disabled: { skin: `${base}:disabled${a}` } } }), 'button', role);
          count('buttons');
        }
      } else if (n.cls === 'Frame' || n.cls === 'ScrollingFrame' || n.cls === 'CanvasGroup') {
        const kids = n.kids ?? [];
        const fill = kids.length === 1 && kids[0]!.cls === 'Frame' && !!kids[0]!.size && kids[0]!.size[0] > 0 && kids[0]!.size[0] < 1 && !kids[0]!.kids?.length;
        const visible = (n.bgT ?? 0) < 0.9;
        if (fill && sz && sz[0] > sz[1] * 3) {
          out = { ...skinned(n, `${d}:barTrack`), kids: [skinned(kids[0]!, `${d}:barFill`)] };
          count('bars');
          return out;
        }
        if (visible && (area >= 0.1 * screenArea || (sz && sz[0] >= 360 && sz[1] >= 220)) && kids.length >= 2 && depth <= 2) {
          out = onPanel(skinned(n, `${d}:window`), 'window');
          count('windows');
        } else if (visible && parent && n.size && n.size[2] === 0 && n.size[3] >= 36 && n.size[3] <= 96 && (n.pos?.[2] ?? 0) === 0 && (n.pos?.[3] ?? 0) <= 12 && widthShare(n, parent) >= 0.85) {
          out = skinned(n, `${d}:header`);
          count('headers');
        } else if (visible && parent?.grid && kids.length >= 1) {
          const rarity = RARITY.exec(allText(n))?.[1]?.toLowerCase().replace('mythical', 'mythic') ?? 'common';
          const r = (rarity === 'uncommon' ? 'common' : rarity) as Variant;
          out = inked(skinned(n, `${d}:card:${r}`), 'card', r);
          count('cards');
        } else if (visible && sz && sz[1] <= 56 && sz[0] >= sz[1] * 2.4 && kids.some(isText)) {
          out = inked(skinned(n, `${d}:pill`), 'pill');
          count('pills');
        } else if (visible && sz && Math.abs(sz[0] - sz[1]) <= 8 && sz[0] >= 56 && sz[0] <= 120 && (parent?.grid || parent?.list) && kids.some((k) => k.cls === 'ImageLabel')) {
          out = skinned(n, `${d}:slot`);
          count('slots');
        }
      } else if (n.cls === 'TextLabel' && t && t.length <= 24 && (n.textSize ?? 0) >= 34 && depth <= 3) {
        // A big heading becomes a title plate (its text is in the art).
        out = skinned(n, `${d}:title:${t.toUpperCase()}`, { textT: 1 }, false);
        count('titles');
      }
    }
    if (out.kids?.length) out = { ...out, kids: out.kids.map((k) => walk(k, out, depth + 1, screenArea)) };
    return out;
  };
  const SCREEN = 1920 * 1080;
  // Every device's layout too (a version's forms), so the screen looks the same on all of them.
  const result = screens.map((s) => {
    const out = walk(s, null, 0, SCREEN);
    if (!s.forms) return out;
    const forms: Record<string, unknown> = {};
    for (const [form, lay] of Object.entries(s.forms as Record<string, { kids?: MockNode[]; set?: Record<string, unknown> } | undefined>)) {
      if (!lay) continue;
      forms[form] = lay.kids ? { ...lay, kids: lay.kids.map((k) => walk(k, out, 1, SCREEN)) } : lay;
    }
    return { ...out, forms } as MockNode;
  });
  const notes = counts.size ? [`reskinned in ${d}: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}`] : [`nothing recognisable to reskin in ${d}: add skin to elements by hand`];
  return { screens: result, notes };
}
