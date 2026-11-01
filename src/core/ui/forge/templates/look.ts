import type { MockColor, MockStroke } from '@shared/ui-mockup';
import { DIRECTIONS, type Direction, type ElementKind, type TextInk, type Variant } from '../directions';
import { inkFor } from '../kit';
import { darken, lighten } from '../style';

/**
 * A template's look in one art direction: the skin specs its elements wear, the live text over each kind of surface
 * (colour and outline, in the direction's Roblox fonts), and a plain fill under every skin that stands for the art
 * where it isn't forged (the Lab judges contrast against it; a skin hides it).
 */

export type Surface = 'panel' | 'muted' | 'card' | 'dark' | 'scene' | 'header' | 'tooltip' | 'accent' | 'good' | 'bad' | 'gold';
export type Role = 'h1' | 'h2' | 'body' | 'small' | 'button' | 'num' | 'big';
/** How the window's title sits: a plate over the top edge (candy), inside a header bar (ember, neon), on a ribbon (parchment), clean (frost). */
export type Idiom = 'plate' | 'header' | 'ribbon' | 'clean';

export interface Ink {
  color: MockColor;
  stroke?: MockStroke;
  /** The face the direction gives this ink (a button's label face, a card's name face). */
  font?: { font: string; bold?: boolean };
}

export interface Look {
  id: string;
  /** The hand-tuned look it follows (candy, ember, neon, parchment, frost): a direction without its own follows the nearest. */
  base: string;
  d: Direction;
  accent?: string;
  idiom: Idiom;
  /** A skin spec: "dir:kind[:variant|glyph[:variant]]#accent". */
  skin(kind: ElementKind, variant?: string, extra?: string): string;
  /** The plain fill standing for a skin (and its UICorner). */
  fill(kind: ElementKind, variant?: string): { bg: MockColor; corner: number };
  ink(s: Surface): Ink;
  /** Text on a button of a variant (and on tabs: "active", "inactive"; "disabled"), as the direction inks that face. */
  onButton(variant?: string): Ink;
  /** The direction's ink for text on any element's face, in a variant and state. */
  inkOn(kind: ElementKind, variant?: string, state?: string): Ink;
  font(role: Role): { font: string; bold?: boolean };
  /** How much bigger (or smaller) a role's text is drawn than the form's size, for faces that run small or wide. */
  scale(role: Role): number;
  /** Rarity colours (for names, glows and stripes). */
  rarity(r: string): MockColor;
  /** The button variant for a go-ahead (Play, Claim, Buy, Redeem): green in most directions, ember's own fire, motorsport's race orange (or the game's colour). */
  go: string;
  /** A plain row inside a window (settings, list lines): its fill, transparency and edge. */
  row: { bg: MockColor; bgT: number; stroke?: MockStroke; corner: number };
  /** The direction's own colours for highlights (gold, good, bad, hot). */
  hue: { gold: MockColor; good: MockColor; bad: MockColor; hot: MockColor; xp: MockColor };
}

const hex = (c: string | [number, number, number]): string => {
  if (typeof c === 'string') {
    const h = c.replace('#', '');
    return `#${(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6)).toLowerCase()}`;
  }
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
};

export const RARITY_HUE: Record<string, string> = { common: '#c9d1d9', rare: '#6fd0ff', epic: '#d38bff', legendary: '#ffe066', mythic: '#ff7ab8' };
const RARITY_DEEP: Record<string, string> = { common: '#8b96a3', rare: '#2a7fe0', epic: '#8a3fe0', legendary: '#ff9a1a', mythic: '#ff2e5e' };

interface LookDef {
  idiom: Idiom;
  fonts: { display: string; displayBold?: boolean; body: string; bodyBold?: boolean; displayScale?: number; bodyScale?: number };
  ink: Record<Surface, Ink>;
  button: (variant: string, accent?: string) => Ink;
  fill: (kind: ElementKind, variant: string, accent?: string) => [string, number];
  rarityText?: (r: string) => string;
  hue: Look['hue'];
  row: Look['row'];
}

const stroke = (color: string, px: number, t = 0): MockStroke => ({ color, px, text: true, ...(t ? { t } : {}) });

const DEFS: Record<string, LookDef> = {
  candy: {
    idiom: 'plate',
    fonts: { display: 'FredokaOne', body: 'FredokaOne' },
    ink: {
      panel: { color: '#2b1b47' },
      muted: { color: '#6e5b8f' },
      card: { color: '#ffffff', stroke: stroke('#2b1b47', 2.5) },
      dark: { color: '#ffffff', stroke: stroke('#2b1b47', 2) },
      scene: { color: '#ffffff', stroke: stroke('#2b1b47', 3) },
      header: { color: '#ffffff', stroke: stroke('#2b1b47', 2.5) },
      tooltip: { color: '#2b1b47' },
      accent: { color: '#ff7ab8', stroke: stroke('#2b1b47', 2) },
      good: { color: '#3ee070', stroke: stroke('#2b1b47', 2.5) },
      bad: { color: '#ff4d5e', stroke: stroke('#2b1b47', 2.5) },
      gold: { color: '#ffd23f', stroke: stroke('#2b1b47', 2.5) },
    },
    button: () => ({ color: '#ffffff', stroke: stroke('#2b1b47', 2.5) }),
    fill: (kind, v, acc) => {
      const RAR = RARITY_HUE[v];
      switch (kind) {
        case 'window':
          return ['#fff2dc', 26];
        case 'header':
          return [acc ?? '#4cb3ff', 20];
        case 'button':
          return [v === 'secondary' ? '#4cb3ff' : v === 'danger' ? '#ff4d5e' : v === 'premium' ? '#ffc93c' : v === 'disabled' ? '#b9b2c4' : (acc ?? '#36d96a'), 14];
        case 'tab':
          return [v === 'active' ? '#ffc93c' : '#cdbfe3', 14];
        case 'card':
        case 'slot':
          return [RAR ?? '#c9d1d9', 16];
        case 'pill':
          return ['#3d2a63', 99];
        case 'barTrack':
          return ['#4a3a63', 99];
        case 'barFill':
          return [acc ?? '#36d96a', 99];
        case 'iconFrame':
          return [acc ?? '#ffc93c', 99];
        case 'close':
          return ['#ff4d5e', 14];
        case 'tooltip':
          return ['#ffffff', 14];
        case 'badge':
          return ['#ff4d5e', 99];
        case 'ribbon':
          return [acc ?? '#ff4d5e', 6];
        case 'divider':
          return ['#e6cfa6', 99];
        default:
          return ['#fff2dc', 12];
      }
    },
    hue: { gold: '#ffd23f', good: '#36d96a', bad: '#ff4d5e', hot: '#ff7ab8', xp: '#4cb3ff' },
    row: { bg: '#ffe9c9', bgT: 0, stroke: { color: '#2b1b47', px: 2.5, t: 0.82 }, corner: 16 },
  },
  ember: {
    idiom: 'header',
    fonts: { display: 'Sarpanch', body: 'GothamBold', displayBold: true, displayScale: 1.06 },
    ink: {
      panel: { color: '#ffe9d6' },
      muted: { color: '#c2a891' },
      card: { color: '#ffe9d6' },
      dark: { color: '#ffe9d6' },
      scene: { color: '#fff3e6', stroke: stroke('#140804', 2) },
      header: { color: '#ffe9d6' },
      tooltip: { color: '#ffe9d6' },
      accent: { color: '#ffb347' },
      good: { color: '#7dff8a' },
      bad: { color: '#ff5a4a' },
      gold: { color: '#ffcf5a' },
    },
    button: (v) => (v === 'secondary' || v === 'inactive' || v === 'disabled' ? { color: '#e8d4c2' } : { color: '#fff6ea', stroke: stroke('#2a0f05', 1, 0.15) }),
    fill: (kind, v, acc) => {
      const edge = acc ?? '#ff7a1a';
      switch (kind) {
        case 'window':
          return ['#1d1714', 6];
        case 'header':
          return ['#2e1a10', 4];
        case 'button':
          return [v === 'danger' ? '#c2281f' : v === 'secondary' || v === 'disabled' || v === 'inactive' ? '#2c231e' : hex(darken(edge, 0.12)), 4];
        case 'tab':
          return [v === 'active' ? '#4a1f0e' : '#2c231e', 4];
        case 'card':
        case 'slot':
          return ['#2a211c', 4];
        case 'pill':
          return ['#2c231e', 6];
        case 'barTrack':
          return ['#0b0807', 4];
        case 'barFill':
          return [acc ?? '#e2322b', 4];
        case 'iconFrame':
          return ['#2c231e', 6];
        case 'close':
          return ['#2c231e', 6];
        case 'tooltip':
          return ['#2c231e', 6];
        case 'badge':
          return [edge, 4];
        case 'ribbon':
          return [edge, 2];
        case 'divider':
          return [edge, 0];
        default:
          return ['#1d1714', 4];
      }
    },
    hue: { gold: '#ffcf5a', good: '#7dff8a', bad: '#ff3b2f', hot: '#ff7a1a', xp: '#ffb347' },
    row: { bg: '#2a211c', bgT: 0.1, stroke: { color: '#4a3528', px: 1.5 }, corner: 3 },
  },
  neon: {
    idiom: 'header',
    fonts: { display: 'Michroma', body: 'Jura', bodyBold: true, displayScale: 0.94, bodyScale: 1.1 },
    ink: {
      panel: { color: '#d8f8ff' },
      muted: { color: '#86b9c9' },
      card: { color: '#d8f8ff' },
      dark: { color: '#d8f8ff' },
      scene: { color: '#e8fdff', stroke: stroke('#021018', 2, 0.15) },
      header: { color: '#e8fdff' },
      tooltip: { color: '#d8f8ff' },
      accent: { color: '#3fe6ff' },
      good: { color: '#3dff9a' },
      bad: { color: '#ff5ad9' },
      gold: { color: '#ffc040' },
    },
    button: (v) => (v === 'secondary' || v === 'inactive' || v === 'disabled' ? { color: '#bfeaf5' } : { color: '#ffffff', stroke: stroke('#03161d', 1.5, 0.35) }),
    fill: (kind, v, acc) => {
      const line = acc ?? '#3fe6ff';
      switch (kind) {
        case 'window':
          return ['#0b1824', 4];
        case 'header':
          return ['#0d2c38', 4];
        case 'button':
          return [v === 'danger' ? '#8f2470' : v === 'success' ? '#1b8a55' : v === 'premium' ? '#8f6418' : v === 'secondary' || v === 'disabled' || v === 'inactive' ? '#0f2233' : hex(darken(line, 0.5)), 4];
        case 'tab':
          return [v === 'active' ? hex(darken(line, 0.6)) : '#0c1b28', 4];
        case 'card':
        case 'slot':
          return ['#0f2233', 4];
        case 'pill':
          return ['#0f2233', 4];
        case 'barTrack':
          return ['#050b11', 2];
        case 'barFill':
          return [line, 2];
        case 'iconFrame':
          return ['#0f2233', 4];
        case 'close':
          return ['#0f2233', 4];
        case 'tooltip':
          return ['#0f2233', 4];
        case 'badge':
          return ['#ff3fd2', 4];
        case 'ribbon':
          return [hex(darken(line, 0.3)), 2];
        case 'divider':
          return [line, 0];
        default:
          return ['#0b1824', 4];
      }
    },
    hue: { gold: '#ffb020', good: '#3dff9a', bad: '#ff3fd2', hot: '#3fe6ff', xp: '#3fe6ff' },
    row: { bg: '#0f2a3a', bgT: 0.25, stroke: { color: '#3fe6ff', px: 1, t: 0.65 }, corner: 2 },
  },
  parchment: {
    idiom: 'ribbon',
    fonts: { display: 'GrenzeGotisch', body: 'Merriweather', displayScale: 1.28, bodyScale: 0.96 },
    ink: {
      panel: { color: '#3b2312' },
      muted: { color: '#7a5a3a' },
      card: { color: '#3b2312' },
      dark: { color: '#fff3d6' },
      scene: { color: '#fff3d6', stroke: stroke('#2a1606', 2) },
      header: { color: '#fff3d6', stroke: stroke('#3b1208', 1.5) },
      tooltip: { color: '#3b2312' },
      accent: { color: '#a8231c' },
      good: { color: '#2f7a2a' },
      bad: { color: '#a8231c' },
      gold: { color: '#8a5a12' },
    },
    button: (v) => (v === 'active' || v === 'inactive' ? { color: '#3b2312' } : { color: '#fff3d6', stroke: stroke('#2a1606', 1.5) }),
    fill: (kind, v, acc) => {
      const wax = acc ?? '#a8231c';
      switch (kind) {
        case 'window':
          return ['#f3e2b8', 12];
        case 'header':
          return [wax, 4];
        case 'button':
          return [v === 'secondary' ? '#2c3e8f' : v === 'success' ? '#3f8a3a' : v === 'disabled' ? '#8a7d6a' : v === 'danger' ? '#a8231c' : wax, 8];
        case 'tab':
          return [v === 'active' ? '#f3e2b8' : '#c9a86e', 10];
        case 'card':
        case 'slot':
          return ['#f0dcae', 8];
        case 'pill':
          return ['#3f2812', 99];
        case 'barTrack':
          return ['#3b2312', 99];
        case 'barFill':
          return [acc ?? '#3f8a3a', 99];
        case 'iconFrame':
          return ['#f3e2b8', 99];
        case 'close':
          return ['#a8231c', 99];
        case 'tooltip':
          return ['#f3e2b8', 8];
        case 'badge':
          return ['#a8231c', 99];
        case 'ribbon':
          return ['#2c3e8f', 4];
        case 'divider':
          return ['#c9973a', 99];
        default:
          return ['#f3e2b8', 8];
      }
    },
    hue: { gold: '#e8b54a', good: '#3f8a3a', bad: '#a8231c', hot: '#a8231c', xp: '#2c3e8f' },
    row: { bg: '#ead2a0', bgT: 0, stroke: { color: '#b8913f', px: 1.5, t: 0.2 }, corner: 6 },
  },
  frost: {
    idiom: 'clean',
    fonts: { display: 'BuilderSansExtraBold', body: 'BuilderSansBold' },
    ink: {
      panel: { color: '#1d2433' },
      muted: { color: '#5b6478' },
      card: { color: '#1d2433' },
      dark: { color: '#1d2433' },
      scene: { color: '#ffffff', stroke: stroke('#1d2433', 1.5, 0.35) },
      header: { color: '#ffffff' },
      tooltip: { color: '#ffffff' },
      accent: { color: '#3d5ef0' },
      good: { color: '#13a86a' },
      bad: { color: '#e5394b' },
      gold: { color: '#c98a00' },
    },
    button: (v) => (v === 'secondary' || v === 'inactive' || v === 'disabled' || v === 'premium' ? { color: '#1d2433' } : { color: '#ffffff' }),
    fill: (kind, v, acc) => {
      const a = acc ?? '#5b7cff';
      switch (kind) {
        case 'window':
          return ['#f4f6fb', 28];
        case 'header':
          return [a, 28];
        case 'button':
          return [v === 'danger' ? '#ff5d6c' : v === 'success' ? '#2ccf8a' : v === 'premium' ? '#ffbf3c' : v === 'disabled' ? '#a8b0c2' : v === 'secondary' || v === 'inactive' ? '#ffffff' : a, 99];
        case 'tab':
          return [v === 'active' ? a : '#eef1f8', 99];
        case 'card':
        case 'slot':
          return ['#ffffff', 20];
        case 'pill':
          return ['#ffffff', 99];
        case 'barTrack':
          return ['#e3e7f0', 99];
        case 'barFill':
          return [a, 99];
        case 'iconFrame':
          return [hex(lighten(a, 0.78)), 18];
        case 'close':
          return ['#e9ecf3', 99];
        case 'tooltip':
          return ['#1d2433', 14];
        case 'badge':
          return ['#ff5d6c', 99];
        case 'ribbon':
          return [a, 99];
        case 'divider':
          return ['#dfe3ec', 0];
        default:
          return ['#ffffff', 16];
      }
    },
    hue: { gold: '#ffbf3c', good: '#2ccf8a', bad: '#ff5d6c', hot: '#5b7cff', xp: '#5b7cff' },
    row: { bg: '#ffffff', bgT: 0.05, stroke: { color: '#1d2433', px: 1, t: 0.9 }, corner: 16 },
  },
};

/** A Roblox font name (an Enum.Font where one says the weight) and bold for a family at a weight. */
export function fontName(family: string, weight = 400): { font: string; bold?: boolean } {
  const f = family.replace(/s+/g, '');
  if (/^GothamSSm$|^Gotham$/i.test(f)) return { font: weight >= 900 ? 'GothamBlack' : weight >= 700 ? 'GothamBold' : weight >= 500 ? 'GothamMedium' : 'Gotham' };
  if (/^BuilderSans$/i.test(f)) return { font: weight >= 800 ? 'BuilderSansExtraBold' : weight >= 600 ? 'BuilderSansBold' : weight >= 500 ? 'BuilderSansMedium' : 'BuilderSans' };
  return { font: f, ...(weight >= 600 ? { bold: true } : {}) };
}

const hexOf = (c: unknown): string => (typeof c === 'string' ? hex(c) : Array.isArray(c) ? hex(c as [number, number, number]) : '#ffffff');

/** A direction's text ink as a live text's colour and outline. */
export function inkOf(t: TextInk | undefined): Ink | undefined {
  if (!t) return undefined;
  return { color: hexOf(t.color), ...(t.stroke && (t.strokePx ?? 0) > 0 ? { stroke: { color: hexOf(t.stroke), px: t.strokePx!, text: true } } : {}), ...(t.font ? { font: fontName(t.font, t.weight ?? 400) } : {}) };
}

/** The directions templates know (every art direction). */
/** The hand-tuned looks (each with its idiom, fills, rows and hues). */
export const TUNED_LOOKS = Object.keys(DEFS).filter((id) => DIRECTIONS[id]);
/** Every art direction a template can be built in: the tuned ones, and every other direction by its nearest tuned look. */
export const LOOK_IDS = Object.keys(DIRECTIONS);

/** The nearest tuned look for a direction that has none of its own (by its kind of surfaces and type). */
const BASE_OF: Record<string, string> = { toybox: 'candy', kawaii: 'candy', aqua: 'candy', pixel: 'neon', forest: 'parchment', royal: 'parchment', grunge: 'ember', tactical: 'ember', motorsport: 'neon' };
const IDIOM_OF: Record<string, Idiom> = { toybox: 'plate', kawaii: 'plate', aqua: 'plate', pixel: 'header', forest: 'ribbon', royal: 'ribbon', grunge: 'header', tactical: 'header', motorsport: 'header' };
/** Faces that run wide or small for their size. */
const SCALE_OF: Record<string, [number, number]> = { pixel: [0.76, 0.76], grunge: [1.1, 1.04], tactical: [1.04, 1], royal: [1, 0.96], motorsport: [1.06, 1] };

const lum = (c: unknown): number => {
  const h = hexOf(c).slice(1);
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
};

/** A look for a direction without its own: the nearest tuned one, its surfaces as light or dark as the direction's text asks. */
function derive(id: string, d: Direction): { def: LookDef; base: string } {
  const base = BASE_OF[id] ?? (lum(d.text?.color ?? '#000000') > 0.5 ? 'ember' : 'candy');
  const b = DEFS[base]!;
  const lightText = lum(d.text?.color ?? '#000000') > 0.5;
  const baseLightText = lum(b.ink.panel.color) > 0.5;
  const [ds, bs] = SCALE_OF[id] ?? [1, 1];
  const fonts = { ...b.fonts, displayScale: ds, bodyScale: bs, displayBold: false, bodyBold: false };
  const p = (k: string) => (d.palette?.[k] !== undefined ? hexOf(d.palette[k]) : undefined);
  const accent = p('accent') ?? p('primary') ?? '#ffb020';
  if (lightText === baseLightText) return { def: { ...b, idiom: IDIOM_OF[id] ?? b.idiom, fonts, ink: { ...b.ink, panel: { color: hexOf(d.text.color) } } }, base };
  // The surfaces flip: plain fills and rows in the direction's darkness, so live text over them reads.
  const dark = lightText;
  const fill: LookDef['fill'] = (kind, v, acc) => {
    const own = b.fill(kind, v, acc);
    if (kind === 'button' || kind === 'tab' || kind === 'barFill' || kind === 'badge' || kind === 'ribbon' || kind === 'close') return own;
    if (kind === 'card' || kind === 'slot') return [dark ? '#24222b' : '#fbf8f2', own[1]];
    if (kind === 'barTrack') return [dark ? '#0c0b10' : '#d9d4ca', own[1]];
    return [dark ? '#1b1a20' : '#f4f0e6', own[1]];
  };
  return {
    def: { ...b, idiom: IDIOM_OF[id] ?? b.idiom, fonts, fill, ink: { ...b.ink, panel: { color: hexOf(d.text.color) }, card: dark ? { color: '#f2eee6' } : { color: '#2a2622' }, dark: dark ? { color: '#f2eee6' } : { color: '#2a2622' }, accent: { color: accent } }, row: dark ? { bg: '#000000', bgT: 0.55, stroke: { color: '#ffffff', px: 1, t: 0.85 }, corner: 6 } : { bg: '#ffffff', bgT: 0.4, stroke: { color: '#000000', px: 1, t: 0.88 }, corner: 12 } },
    base,
  };
}

/** A direction's look, re-tinted by an accent ("#rrggbb"). */
export function lookOf(direction: string, accent?: string): Look {
  const d = DIRECTIONS[direction];
  if (!d) throw new Error(`No art direction "${direction}" for templates (directions: ${LOOK_IDS.join(', ')})`);
  const tuned = DEFS[direction];
  const { def, base } = tuned ? { def: tuned, base: direction } : derive(direction, d);
  const acc = accent && /^#?[0-9a-f]{6}$/i.test(accent) ? hex(accent) : undefined;
  const tail = acc ? `#${acc.slice(1)}` : '';
  return {
    id: direction,
    base,
    d,
    accent: acc,
    idiom: def.idiom,
    skin: (kind, variant, extra) => `${direction}:${kind}${variant ? `:${variant}` : ''}${extra ? `:${extra}` : ''}${tail}`,
    fill: (kind, variant) => {
      const [bg, corner] = def.fill(kind, variant ?? '', acc);
      return { bg: hex(bg), corner };
    },
    // The direction's own inks for the surfaces it names (its fixes reach every template); the template's for the rest.
    ink: (s) => {
      const t = d.text;
      const own = s === 'card' ? inkOf(t?.onCard) : s === 'dark' ? inkOf(t?.onPill) : s === 'muted' ? inkOf(t?.muted) : s === 'header' ? inkOf(inkFor(d, { kind: 'header' })) : s === 'panel' && t ? { color: hexOf(t.color) } : undefined;
      return own ?? def.ink[s];
    },
    inkOn: (kind, variant, state) => inkOf(inkFor(d, { kind, ...(variant ? { variant: variant as Variant } : {}), ...(state ? { state: state as never } : {}) })) ?? def.ink.panel,
    onButton: (v) => {
      const variant = v ?? 'primary';
      if (variant === 'active' || variant === 'inactive') return inkOf(inkFor(d, { kind: 'tab', variant })) ?? def.button(variant, acc);
      if (variant === 'disabled') return inkOf(inkFor(d, { kind: 'button', variant: 'primary', state: 'disabled' })) ?? def.button(variant, acc);
      return inkOf(inkFor(d, { kind: 'button', variant: variant as Variant })) ?? def.button(variant, acc);
    },
    font: (role) => {
      const display = role === 'h1' || role === 'button' || role === 'num' || role === 'big';
      const f = d.fonts;
      // The direction's faces; a template that wants a heavier cut for legibility (neon's thin Jura) says so.
      if (f) return display ? fontName(f.display, Math.max(f.weightDisplay ?? 400, def.fonts.displayBold ? 700 : 0)) : fontName(f.body, Math.max(f.weightBody ?? 400, def.fonts.bodyBold ? 700 : 0));
      return display ? { font: def.fonts.display, ...(def.fonts.displayBold ? { bold: true } : {}) } : { font: def.fonts.body, ...(def.fonts.bodyBold ? { bold: true } : {}) };
    },
    scale: (role) => (role === 'h1' || role === 'button' || role === 'num' || role === 'big' ? (def.fonts.displayScale ?? 1) : (def.fonts.bodyScale ?? 1)),
    rarity: (r) => RARITY_HUE[r] ?? RARITY_HUE.common!,
    hue: def.hue,
    row: def.row,
    go: direction === 'ember' || direction === 'motorsport' ? 'primary' : 'success',
  };
}

export const rarityDeep = (r: string): string => RARITY_DEEP[r] ?? RARITY_DEEP.common!;
export type { Variant };
