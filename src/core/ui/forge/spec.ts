import type { UiNode } from '@shared/ui-layout';
import { DIRECTIONS, ELEMENT_KINDS, type ElementKind, type ElementRequest, type ElementState, type Variant } from './directions';
import type { ForgeSpec } from './forge';
import { FX_KINDS, fxSpec, type FxKind } from './fx';

/**
 * Skin specs: how a design asks for forged art, as one readable string an agent writes on any element —
 *
 *   "candy:button:primary"         a direction's element in a variant
 *   "ember:button:danger:pressed"  … in a state (hover, pressed, disabled, selected): a state's art
 *   "ember:icon:sword:epic"        an icon: its glyph, then a variant (rarity or role)
 *   "candy:title:PET SHOP"         a title plate with its text
 *   "neon:coin:cpu"                a currency coin with its glyph
 *   "candy:card:legendary#ff7ab8"  any spec with an accent colour after #
 *
 * The art is forged on demand at the element's own size (offsets in its UDim2; a nominal size for scale-sized ones,
 * which 9-slicing stretches without changing corners) and cached by spec and size.
 */

export interface SkinSpec {
  direction: string;
  kind: ElementKind;
  variant?: Variant;
  glyph?: string;
  text?: string;
  accent?: string;
  state?: ElementState;
}

const KIND_ALIASES: Record<string, string> = { bar: 'barTrack', track: 'barTrack', progress: 'barTrack', progressbar: 'barTrack', fill: 'barFill', panel: 'window', frame: 'window', dialog: 'window', popup: 'window', modal: 'window', chip: 'pill', label: 'pill', sticker: 'badge', item: 'card', heading: 'title', banner: 'ribbon', x: 'close' };

/** The states a spec may end with (a variant named like one means the primary element in it). */
const STATES = new Set<string>(['hover', 'pressed', 'disabled', 'selected']);

const VARIANTS = new Set<string>(['primary', 'secondary', 'danger', 'success', 'premium', 'active', 'inactive', 'pressed', 'disabled', 'hover', 'common', 'rare', 'epic', 'legendary', 'mythic']);

/** Parses a skin spec; null with a reason when it can't be. */
export function parseSkin(spec: string): { spec: SkinSpec } | { error: string } {
  const [body, accent] = spec.split('#');
  const parts = (body ?? '').split(':');
  const [direction, said, ...rest] = parts;
  // The names designers reach for first.
  const kind = said ? (KIND_ALIASES[said.toLowerCase()] ?? said) : said;
  // Light and effects in any colour, for every direction: "fx:glow#ffd23f".
  if (direction === 'fx') {
    if (!kind || !(FX_KINDS as readonly string[]).includes(kind)) return { error: `"${spec}": no effect "${kind}" (fx: ${FX_KINDS.join(', ')})` };
    return { spec: { direction, kind: kind as unknown as ElementKind, ...(accent ? { accent: `#${accent.replace(/[^0-9a-f]/gi, '').slice(0, 6)}` } : {}) } };
  }
  if (!direction || !DIRECTIONS[direction]) return { error: `"${spec}": no art direction "${direction}" (directions: ${Object.keys(DIRECTIONS).join(', ')})` };
  if (!kind || !(ELEMENT_KINDS as readonly string[]).includes(kind)) return { error: `"${spec}": no element "${kind}" (elements: ${ELEMENT_KINDS.join(', ')})` };
  const out: SkinSpec = { direction, kind: kind as ElementKind, ...(accent ? { accent: `#${accent.replace(/[^0-9a-f]/gi, '').slice(0, 6)}` } : {}) };
  if (kind === 'title') out.text = rest.join(':') || undefined;
  else if (kind === 'icon' || kind === 'coin') {
    if (rest[0]) out.glyph = rest[0];
    if (rest[1] && VARIANTS.has(rest[1])) out.variant = rest[1] as Variant;
    if (rest[2] && STATES.has(rest[2])) out.state = rest[2] as ElementState;
  } else if (rest[0]) {
    if (!VARIANTS.has(rest[0])) return { error: `"${spec}": no variant "${rest[0]}" (variants: ${[...VARIANTS].join(', ')})` };
    out.variant = rest[0] as Variant;
    if (rest[1]) {
      if (!STATES.has(rest[1])) return { error: `"${spec}": no state "${rest[1]}" (states: ${[...STATES].join(', ')})` };
      out.state = rest[1] as ElementState;
    }
  }
  return { spec: out };
}

/** Nominal sizes for elements sized by scale (9-sliced art keeps its corners at any size). */
const NOMINAL: Record<ElementKind, [number, number]> = {
  window: [720, 480], header: [560, 78], button: [200, 56], tab: [150, 48], card: [180, 220], slot: [96, 96], badge: [48, 48], ribbon: [160, 40], barTrack: [240, 26], barFill: [240, 26], pill: [190, 46], iconFrame: [72, 72], close: [52, 52], title: [340, 90], divider: [320, 6], tooltip: [260, 90], icon: [96, 96], coin: [40, 40],
};

/** The size to forge an element at: its own offset size where it has one, else the kind's nominal size in that axis. */
export function forgeSize(kind: ElementKind, size?: UiNode['size']): [number, number] {
  const [nw, nh] = NOMINAL[kind] ?? [240, 240];
  if (!size) return [nw, nh];
  const w = size[0] === 0 && size[1] > 0 ? size[1] : nw;
  const h = size[2] === 0 && size[3] > 0 ? size[3] : nh;
  return [Math.max(8, Math.min(1600, w)), Math.max(4, Math.min(1200, h))];
}

/** The element request a spec and size make. */
export function requestOf(s: SkinSpec, size: [number, number]): ElementRequest {
  return { kind: s.kind, size, ...(s.variant ? { variant: s.variant } : {}), ...(s.glyph ? { glyph: s.glyph } : {}), ...(s.text ? { text: s.text } : {}), ...(s.state ? { state: s.state } : {}) };
}

/** The forge recipe for a parsed spec at a size: a direction's element, or an effect. */
export function elementSpec(s: SkinSpec, size: [number, number]): ForgeSpec {
  if (s.direction === 'fx') return fxSpec(s.kind as unknown as FxKind, size, s.accent);
  return DIRECTIONS[s.direction]!.element(requestOf(s, size), s.accent);
}

/** The key suffix of art forged to be 9-sliced (a narrow centre that only stretches). */
export const SLICED = '~9';
/** Whether a skin's key is 9-sliced art (else it is drawn stretched at the size it was forged at). */
export const isSliced = (key: string): boolean => key.endsWith(SLICED) || key.startsWith('custom:');

/** A cache key: the spec and the size forged at. */
export const skinKey = (spec: string, size: [number, number]): string => `${spec}@${Math.round(size[0])}x${Math.round(size[1])}`;

/** A file-safe name for a cache key. */
export const skinFile = (key: string): string => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `${key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${(h >>> 0).toString(36)}`;
};
