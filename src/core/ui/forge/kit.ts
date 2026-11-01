import type { ForgeLayer, ForgeSpec } from './forge';
import { darken, lighten, mapStyleColors, saturate, type Color, type LayerStyle } from './style';

/**
 * What every art direction shares: the element kinds and variants a design asks for, the request, the Direction
 * contract (palette, fonts, text inks per surface, a recipe per element), rarity colours, and the generic states —
 * hover (lit up), pressed (the face sunk onto its base: lower, darker, no base, a shadow along its top) and disabled
 * (greyed, flat) — that a direction gets for free and may refine.
 */

export const ELEMENT_KINDS = ['window', 'header', 'button', 'tab', 'card', 'slot', 'badge', 'ribbon', 'barTrack', 'barFill', 'pill', 'iconFrame', 'close', 'title', 'divider', 'tooltip', 'icon', 'coin'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'premium' | 'active' | 'inactive' | 'pressed' | 'disabled' | 'hover' | 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
/** An interactive element's state (buttons, tabs, close, slots, cards): hover lights it, pressed sinks it, disabled greys it, selected rings it. */
export type ElementState = 'normal' | 'hover' | 'pressed' | 'disabled' | 'selected';
export const ELEMENT_STATES: readonly ElementState[] = ['normal', 'hover', 'pressed', 'disabled', 'selected'];

export interface ElementRequest {
  kind: ElementKind;
  variant?: Variant;
  /** Design points. */
  size: [number, number];
  /** Title text (title kind), or a label baked in (rarely: big numbers stay live TextLabels). */
  text?: string;
  /** A line-art glyph's name for icon and coin kinds (coins, gem, sword, shield, heart, zap, crown, star, trophy…). */
  glyph?: string;
  /** The state to draw (with any variant: a danger button pressed). Variants hover/pressed/disabled mean the primary one in that state. */
  state?: ElementState;
}

export type ButtonRole = 'primary' | 'secondary' | 'danger' | 'success' | 'premium';
export const BUTTON_ROLES: readonly ButtonRole[] = ['primary', 'secondary', 'danger', 'success', 'premium'];

/** A text colour with its outline (a live TextLabel's TextColor3 and UIStroke) and the font it goes with. */
export interface TextInk {
  color: Color;
  stroke?: Color;
  /** UIStroke thickness in points (0: none). */
  strokePx?: number;
  font?: string;
  weight?: number;
  /**
   * The smallest text size (points) this ink is drawn for. Display faces carry one (titles, big numbers, large buttons);
   * inkFor with a smaller size swaps to the direction's body face at its weight.
   */
  minSize?: number;
}

export interface Direction {
  id: string;
  label: string;
  /** What it suits, for the designer choosing one. */
  for: string;
  palette: Record<string, Color>;
  /** Roblox fonts that go with it: display (titles, numbers), body (labels). */
  fonts: { display: string; body: string; weightDisplay?: number; weightBody?: number };
  /**
   * Text over its surfaces. `color`/`stroke` are body text on windows; `onButton`/`onButtonStroke` on primary buttons.
   * Then an ink per surface: title (a live title over the header), button, tabOn/tabOff (active and inactive tabs),
   * onCard (item names on cards), onPill (currency amounts), muted (secondary text), disabled (text on disabled buttons),
   * and buttons: the label ink for each button role (each reads at 4.5:1 or better on its face, counting a 2 pt+ outline).
   * inkFor picks the right one for any element.
   */
  text: {
    color: Color;
    stroke?: Color;
    strokePx?: number;
    onButton: Color;
    onButtonStroke?: Color;
    title: TextInk;
    button: TextInk;
    tabOn: TextInk;
    tabOff: TextInk;
    onCard: TextInk;
    onPill: TextInk;
    muted: TextInk;
    disabled: TextInk;
    buttons: Record<ButtonRole, TextInk>;
  };
  /** A backdrop colour its previews read well on. */
  backdrop: Color;
  element(r: ElementRequest, accent?: Color): ForgeSpec;
}

/** Rarity colours: [light, deep]. */
export const RARITY: Record<string, [Color, Color]> = {
  common: ['#c9d1d9', '#8b96a3'],
  rare: ['#6fd0ff', '#2a7fe0'],
  epic: ['#d38bff', '#8a3fe0'],
  legendary: ['#ffe066', '#ff9a1a'],
  mythic: ['#ff7ab8', '#ff2e5e'],
};
/** Rarity colours for dark bases: saturated enough to stay clean over near-black glass, steel or velvet (no olive yellows). */
export const RARITY_VIVID: Record<string, [Color, Color]> = {
  common: ['#d6dde6', '#7d8896'],
  rare: ['#4cc3ff', '#1e6fe0'],
  epic: ['#c470ff', '#7a2ae0'],
  legendary: ['#ffc928', '#ff8a00'],
  mythic: ['#ff5fa2', '#ff1f4f'],
};
export const RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
export const isRarity = (v: Variant | undefined): v is (typeof RARITIES)[number] => !!v && (RARITIES as readonly string[]).includes(v);

export const one = (shape: ForgeLayer['shape'], style: LayerStyle, at?: ForgeLayer['at']): ForgeLayer => ({ shape, style, ...(at ? { at } : {}) });

/** The role (primary, secondary, danger, success, premium) and state a request asks for. */
export function roleOf(r: ElementRequest): { role: 'primary' | 'secondary' | 'danger' | 'success' | 'premium'; state: ElementState } {
  const v = r.variant;
  const role = v === 'secondary' || v === 'danger' || v === 'success' || v === 'premium' ? v : 'primary';
  const state: ElementState = r.state ?? (v === 'hover' || v === 'pressed' || v === 'disabled' ? v : 'normal');
  return { role, state };
}

/** Options for the generic states. */
export interface StateLook {
  /** How far a pressed face sinks (points) when nothing in the art is extruded (default 3). */
  press?: number;
  /** Hover: how much lighter (0..1, default 0.12). */
  lift?: number;
  /** Disabled: the grey it fades towards, and how far (0..1, default 0.5 when a grey is given). */
  grey?: Color;
  greyMix?: number;
  /** Selected: the ring of light round it (default white). */
  ring?: Color;
}

const scaleOpacity = (o: number | undefined, k: number, base: number) => Math.min(1, (o ?? base) * k);

/**
 * A spec in a state: hover lightens and lifts the gloss and glow; pressed sinks every layer by the base's depth (or
 * `press`), drops the base, darkens, adds a shadow along the top and tightens the drop shadow; disabled greys every
 * colour, flattens the gloss and turns glows and sparkles off. The content box follows the pressed face.
 */
export function withState(spec: ForgeSpec, state: ElementState, look: StateLook = {}): ForgeSpec {
  if (state === 'normal') return spec;
  const [W, H] = spec.size;
  if (state === 'selected') {
    // Lit a little, ringed in light: a bright edge just inside the first layer and a glow round it (a thin ring
    // alone is lost at phone size, beside the unselected ones).
    const lit = withState(spec, 'hover', { ...look, lift: (look.lift ?? 0.12) * 0.6 });
    const ring = look.ring ?? '#ffffff';
    const edge = Math.max(2, Math.min(4, Math.min(W, H) * 0.04));
    return { ...lit, layers: lit.layers.map((l, i) => (i === 0 ? { ...l, style: { ...l.style, outerGlow: { color: ring, opacity: 1, size: 7, spread: 3 }, strokes: [...(l.style.strokes ?? []), { width: edge, paint: ring, position: 'inside', opacity: 0.9 }] } } : l)) };
  }
  if (state === 'hover') {
    const lift = look.lift ?? 0.12;
    return {
      ...spec,
      layers: spec.layers.map((l) => {
        const s = mapStyleColors(l.style, (c) => [c[0] + (1 - c[0]) * lift, c[1] + (1 - c[1]) * lift, c[2] + (1 - c[2]) * lift]);
        return {
          ...l,
          style: {
            ...s,
            ...(s.gloss ? { gloss: { ...s.gloss, opacity: scaleOpacity(s.gloss.opacity, 1.25, 0.45) } } : {}),
            ...(s.outerGlow ? { outerGlow: { ...s.outerGlow, opacity: scaleOpacity(s.outerGlow.opacity, 1.35, 0.8) } } : {}),
            ...(s.rim ? { rim: { ...s.rim, opacity: scaleOpacity(s.rim.opacity, 1.3, 0.6) } } : {}),
          },
        };
      }),
    };
  }
  if (state === 'pressed') {
    const depth = Math.max(0, ...spec.layers.map((l) => (l.style.extrude && (!l.at || l.at[2] >= W * 0.6) ? l.style.extrude.depth : 0)));
    const d = depth > 0 ? depth : (look.press ?? 3);
    // The biggest layer is the face that sits in its socket.
    const area = (l: ForgeLayer) => (l.at ? l.at[2] * l.at[3] : W * H);
    const main = spec.layers.reduce((best, l, i) => (area(l) > area(spec.layers[best]!) ? i : best), 0);
    return {
      ...spec,
      content: [0, d, W, H],
      layers: spec.layers.map((l, i) => {
        const at = l.at ?? [0, 0, W, H];
        const s = mapStyleColors(l.style, (c) => [c[0] * 0.86, c[1] * 0.86, c[2] * 0.86]);
        const { extrude: _e, ...rest } = s;
        const style: LayerStyle = {
          ...rest,
          ...(s.gloss ? { gloss: { ...s.gloss, opacity: (s.gloss.opacity ?? 0.45) * 0.55 } } : {}),
          ...(s.outerGlow ? { outerGlow: { ...s.outerGlow, opacity: (s.outerGlow.opacity ?? 0.8) * 0.55 } } : {}),
          ...(s.dropShadow ? { dropShadow: { ...s.dropShadow, opacity: (s.dropShadow.opacity ?? 0.5) * 0.6, offset: [s.dropShadow.offset?.[0] ?? 0, Math.min(2, s.dropShadow.offset?.[1] ?? 2)], blur: Math.min(s.dropShadow.blur, 3) } } : {}),
          // The face gets a shadow along its top edge: it sits in its socket.
          ...(i === main ? { innerShadow: s.innerShadow ? { ...s.innerShadow, offset: [0, Math.max(2.5, Math.abs(s.innerShadow.offset?.[1] ?? 2))], opacity: Math.max(0.4, s.innerShadow.opacity ?? 0.5) } : { color: '#000000', opacity: 0.35, size: 7, offset: [0, 3] } } : {}),
        };
        return { ...l, at: [at[0], at[1] + d, at[2], at[3]], style };
      }),
    };
  }
  // Disabled: every colour greyed (its lightness kept) and pulled towards the direction's grey.
  const grey = look.grey ? rgbOf(look.grey) : null;
  const k = look.greyMix ?? (grey ? 0.5 : 0);
  return {
    ...spec,
    layers: spec.layers.map((l) => {
      const s = mapStyleColors(l.style, (c) => {
        const L = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
        const g = 0.08 + L * 0.84;
        const d: [number, number, number] = [g + (c[0] - L) * 0.1, g + (c[1] - L) * 0.1, g + (c[2] - L) * 0.1];
        return grey ? [d[0] * (1 - k) + grey[0] * k, d[1] * (1 - k) + grey[1] * k, d[2] * (1 - k) + grey[2] * k] : d;
      });
      const { outerGlow: _g, sparkles: _s, sheen: _sh, ...rest } = s;
      return { ...l, style: { ...rest, ...(s.gloss ? { gloss: { ...s.gloss, opacity: (s.gloss.opacity ?? 0.45) * 0.5 } } : {}) } };
    }),
  };
}

const rgbOf = (c: Color): [number, number, number] => {
  if (Array.isArray(c)) return [c[0] / 255, c[1] / 255, c[2] / 255];
  const n = parseInt(c.replace('#', '').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/**
 * The text ink for live text on an element of a direction (a button's label by its role and state, a tab's by active or
 * not…); with the text's size, a display face too big for it gives way to the body face.
 */
export function inkFor(d: Direction, r: Pick<ElementRequest, 'kind' | 'variant' | 'state'>, size?: number): TextInk {
  const ink = inkOf(d, r);
  if (size !== undefined && ink.minSize !== undefined && size < ink.minSize) {
    const { minSize: _m, ...rest } = ink;
    return { ...rest, font: d.fonts.body, weight: d.fonts.weightBody ?? 700 };
  }
  return ink;
}

function inkOf(d: Direction, r: Pick<ElementRequest, 'kind' | 'variant' | 'state'>): TextInk {
  const t = d.text;
  const body: TextInk = { color: t.color, ...(t.stroke ? { stroke: t.stroke } : {}), ...(t.strokePx ? { strokePx: t.strokePx } : {}), font: d.fonts.body, ...(d.fonts.weightBody ? { weight: d.fonts.weightBody } : {}) };
  switch (r.kind) {
    case 'button':
    case 'close': {
      const { role, state } = roleOf(r as ElementRequest);
      return state === 'disabled' ? t.disabled : t.buttons[role];
    }
    case 'tab':
      return r.variant === 'active' || r.state === 'selected' ? t.tabOn : r.state === 'disabled' ? t.disabled : t.tabOff;
    case 'card':
    case 'slot':
    case 'iconFrame':
      return t.onCard;
    case 'pill':
    case 'barTrack':
    case 'barFill':
      return t.onPill;
    case 'title':
    case 'header':
    case 'ribbon':
      return t.title;
    case 'badge':
      return t.buttons.danger;
    default:
      return body;
  }
}

/** WCAG contrast ratio of two colours (1 to 21). */
export function contrastRatio(a: Color, b: Color): number {
  const lum = (c: Color) => {
    const v = rgbOf(c).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * How well an ink reads on a face colour: plain text by its own contrast; outlined text (2 pt or more) by the weaker of
 * outline-on-face and text-on-outline, or plain contrast when that is better.
 */
export function inkContrast(ink: TextInk, face: Color): number {
  const plain = contrastRatio(ink.color, face);
  if (!ink.stroke || (ink.strokePx ?? 0) < 2) return plain;
  return Math.max(plain, Math.min(contrastRatio(ink.stroke, face), contrastRatio(ink.color, ink.stroke)));
}

/** A rarity's colours, tinted by the accent when one is given. */
export const rarityOf = (v: Variant | undefined): [Color, Color] => RARITY[v ?? 'common'] ?? RARITY.common!;
/** A rarity's vivid colours (for dark bases). */
export const rarityVivid = (v: Variant | undefined): [Color, Color] => RARITY_VIVID[v ?? 'common'] ?? RARITY_VIVID.common!;

export { darken, lighten, saturate };
