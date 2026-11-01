import type { ForgeLayer, ForgeSpec } from '../forge';
import { RARITY, isRarity, type ElementRequest, type Variant } from '../kit';
import { rgb } from '../canvas';
import { scaleShape } from '../shapes';
import { blend, darken, lighten, saturate, type Color, type LayerStyle, type Paint, type Stop, type StrokeStyle, type Texture } from '../style';
import { poly, type Piece } from './geo';
import { unionOutline } from './silhouette';

/**
 * The props kit: how a prop recipe (an object drawn as parts in a 100 × 100 frame) becomes Forge layers in an art
 * direction's style. A part is a shape, a material (glossy paint, metal, gem, glass, liquid, wood, paper, matte, flat,
 * glowing, and shine and shade decals) and a tone (highlight, base, shadow). The builder draws it the way a game icon
 * artist does: first every silhouette part as the direction's outline (with its base and drop shadow), so the object
 * has one clean outer edge, then each part's face — gradient, inner shadow, bounce light, bevel, gloss — with a thin
 * inner line where parts meet. Tints come from the request: a rarity (common grey to mythic magenta with a holographic
 * shimmer), a role (danger red, success green, premium gold) or the accent; a part that asks for `c.main(...)` wears it.
 */

export interface Tone {
  hi: Color;
  mid: Color;
  lo: Color;
  /** Mythic: a holographic shimmer over it. */
  holo?: boolean;
  /** Legendary and up: glints on it. */
  glint?: boolean;
}

/** A tone round a base colour (k scales how far the highlight and shadow reach). */
export const tone = (mid: Color, k = 1): Tone => ({ hi: lighten(mid, 0.5 * k), mid, lo: darken(mid, 0.42 * k) });
/** A tone from a light and a deep colour (a rarity pair). */
export const pair = (light: Color, deep: Color): Tone => ({ hi: lighten(light, 0.45), mid: blend(light, deep, 0.45), lo: darken(deep, 0.32) });
/** A tone made lighter (k > 0, towards white) or darker (k < 0). */
export const shift = (t: Tone, k: number): Tone => {
  const f = (c: Color) => (k >= 0 ? lighten(c, k) : darken(c, -k));
  return { ...t, hi: f(t.hi), mid: f(t.mid), lo: f(t.lo) };
};
/** A tone mixed towards another (t = 0: a, 1: b). */
export const mixTone = (a: Tone, b: Tone, t: number): Tone => ({ ...a, hi: blend(a.hi, b.hi, t), mid: blend(a.mid, b.mid, t), lo: blend(a.lo, b.lo, t) });

/** Natural colours for props. */
export const T = {
  gold: { hi: '#fff6b0', mid: '#ffc72c', lo: '#c46a00' } as Tone,
  silver: { hi: '#ffffff', mid: '#c8d2dc', lo: '#6c7a8a' } as Tone,
  steel: { hi: '#f4f9ff', mid: '#b4c4d4', lo: '#5d6f84' } as Tone,
  iron: { hi: '#a8b0bc', mid: '#6b7482', lo: '#363c48' } as Tone,
  bronze: { hi: '#ffd2a0', mid: '#d0843c', lo: '#7a3e12' } as Tone,
  wood: { hi: '#d9944e', mid: '#a5612c', lo: '#5a2e10' } as Tone,
  woodDark: { hi: '#a8683a', mid: '#74401c', lo: '#3c1c08' } as Tone,
  paper: { hi: '#fffaf0', mid: '#f4e3bc', lo: '#c9a46a' } as Tone,
  bone: { hi: '#ffffff', mid: '#efe7d6', lo: '#b3a48a' } as Tone,
  white: { hi: '#ffffff', mid: '#f2f4fa', lo: '#b9c2d6' } as Tone,
  cream: { hi: '#ffffff', mid: '#fff1d6', lo: '#e0b77c' } as Tone,
  red: { hi: '#ff9d9d', mid: '#f0303f', lo: '#9a0f22' } as Tone,
  orange: { hi: '#ffd08a', mid: '#ff8a1c', lo: '#c04800' } as Tone,
  yellow: { hi: '#fffbc0', mid: '#ffd83a', lo: '#e08a00' } as Tone,
  green: { hi: '#b8ff9a', mid: '#3fcf4a', lo: '#1a7a2a' } as Tone,
  leaf: { hi: '#c4f37a', mid: '#5fbf2a', lo: '#2a6e14' } as Tone,
  teal: { hi: '#a8fff0', mid: '#22c9b4', lo: '#0a6e6a' } as Tone,
  cyan: { hi: '#d4fbff', mid: '#3fd2ff', lo: '#0a6ac0' } as Tone,
  blue: { hi: '#a8d8ff', mid: '#3a8cff', lo: '#1438a8' } as Tone,
  purple: { hi: '#e4b8ff', mid: '#a64dff', lo: '#4e1a9a' } as Tone,
  pink: { hi: '#ffd0e8', mid: '#ff6eb4', lo: '#b8236e' } as Tone,
  brown: { hi: '#e0a670', mid: '#a8642e', lo: '#5a2a0c' } as Tone,
  leather: { hi: '#b0704a', mid: '#7a3e22', lo: '#3c1a0a' } as Tone,
  dark: { hi: '#6a7088', mid: '#363a4e', lo: '#14162a' } as Tone,
  ink: { hi: '#4a4060', mid: '#2a2238', lo: '#0e0a18' } as Tone,
  hole: { hi: '#3a2a20', mid: '#24160e', lo: '#100804' } as Tone,
  glass: { hi: '#ffffff', mid: '#e4f4ff', lo: '#9ec4e4' } as Tone,
  shine: { hi: '#ffffff', mid: '#ffffff', lo: '#ffffff' } as Tone,
  shadow: { hi: '#000000', mid: '#1a1028', lo: '#000000' } as Tone,
  flame: { hi: '#fff4a0', mid: '#ff9a1a', lo: '#e0300a' } as Tone,
  meat: { hi: '#f0a070', mid: '#c0562a', lo: '#6a2410' } as Tone,
  skin: { hi: '#ffe0c0', mid: '#f4b080', lo: '#b0683a' } as Tone,
} as const;

export type Mat = 'gloss' | 'matte' | 'metal' | 'gem' | 'glass' | 'liquid' | 'wood' | 'paper' | 'flat' | 'glow' | 'shine' | 'shade';

export interface Part extends Piece {
  mat: Mat;
  tone: Tone;
  /** The thin inner line round it (× the direction's inner width); 0: none. Default 1 (0 for decals). */
  line?: number;
  /** Its line in another colour (light facet edges on a gem). */
  lineColor?: Color;
  /** Part of the outer silhouette (drawn first as the outline and base). Default: yes, except decals. */
  sil?: boolean;
  /** Casts the drop shadow (default: the first silhouette part). */
  shadow?: boolean;
  /** Decals: how opaque. */
  opacity?: number;
  /** The direction its light comes from for gradients (degrees, default 90: from above). */
  angle?: number;
  /** Shares one vertical gradient over this span of the frame (y0, y1) with other parts: pieces read as one surface. */
  span?: [number, number];
  /** No effects beyond its fill and line (tiny pieces). */
  plain?: boolean;
  /** Effects merged over the material's. */
  fx?: Partial<LayerStyle>;
}

/** An art direction's way of finishing props. */
export interface PropLook {
  /** Strokes round the whole silhouette for an outline `w` points wide (outermost widest). Empty: no outline. */
  outline: (w: number) => StrokeStyle[];
  /** The outline width as a fraction of the prop's side, and its bounds in points. */
  line: number;
  lineMin?: number;
  lineMax?: number;
  /** Inner lines: their width (× the outline) and colour ('tone': a darker shade of each part). */
  inner: number;
  ink: Color | 'tone';
  /** The outline in each part's own darker shade (moulded plastic) instead of `outline`'s colours. */
  inkTone?: number;
  /** A 3D base under the silhouette (fraction of the side), in this colour (default: the ink). */
  base?: number;
  baseColor?: Color;
  shadow: { color: Color; opacity: number; blur: number; y: number } | null;
  gloss: 'band' | 'arc' | 'spot' | 'glass' | null;
  glossOpacity?: number;
  bevel: 'round' | 'pillow' | 'chisel' | 'smooth';
  specular: number;
  /** Inner shading strength (0..1.5). */
  shade?: number;
  /** Colour transform for the whole palette (grime, khaki, pastel). */
  tone?: (c: Color) => Color;
  /** Surface textures over the big parts (by material). */
  textures?: (mat: Mat) => Texture[] | undefined;
  roughen?: number;
  /** A glow round the silhouette: its colour for a request (null: none), opacity and size (fraction of the side). */
  glow?: (c: PropCtx) => Color | null;
  glowOpacity?: number;
  glowSize?: number;
  /** Holograms: translucent faces with bright edges and a glow (neon). */
  holo?: boolean;
  /** Pixel art: design points per art pixel. */
  pixel?: number;
  /** Below this side (points) the direction's own icon is drawn instead (a prop needs room to read). */
  minSide?: number;
  /** Extra glints on metal and gems. */
  glints?: boolean;
  /** Disabled art fades towards this grey. */
  grey?: Color;
}

export interface PropCtx {
  /** The element's size (points). */
  size: [number, number];
  /** The prop's side (points) and points per unit of its 100 × 100 frame. */
  side: number;
  u: number;
  /** Where the frame's origin is in the element (points). */
  ox: number;
  oy: number;
  /** 0 small (under 64 pt: silhouettes and big shapes only), 1 medium, 2 large (120 pt and up: every detail). */
  detail: 0 | 1 | 2;
  variant?: Variant;
  rarity: 'common' | 'rare' | 'epic' | 'legendary' | 'mythic' | null;
  /** The variant's tone (a rarity, a role or the accent), or null: the prop's own colours. */
  tint: Tone | null;
  accent?: Color;
  /** The glyph the request named (an emblem for coins). */
  glyph?: string;
  look: PropLook;
  /** The tone a tintable part wears: the variant's when one is asked for, else its own. */
  main(natural: Tone): Tone;
  /** A part that keeps its own colour whatever the variant (food, wood), with the variant's glints. */
  own(natural: Tone): Tone;
}

export interface PropDef {
  /** What it draws (for agents and the sheet). */
  about: string;
  /** A currency or payment item: coin skins draw it in place of a coin. */
  currency?: boolean;
  /** Keeps its own colours (food): a variant shows as a glow in its colour round the silhouette, and its glints. */
  aura?: boolean;
  /**
   * Wide art (vehicles side on): in an element wider than it is tall, the art's own bounds fill the element instead of
   * the frame's centred square (a car in a garage card spans the card).
   */
  wide?: boolean;
  /** The colour of its 3D base where a look draws one (default: its biggest part's; a vehicle stands on dark tyres). */
  base?: Tone;
  draw(c: PropCtx): Array<Part | false | null | undefined>;
}

export const part = (g: Piece, mat: Mat, t: Tone, o: Omit<Part, keyof Piece | 'mat' | 'tone'> = {}): Part => ({ ...g, mat, tone: t, ...o });
/** A part inside the silhouette (no outline pass). */
export const inner = (g: Piece, mat: Mat, t: Tone, o: Omit<Part, keyof Piece | 'mat' | 'tone'> = {}): Part => ({ ...g, mat, tone: t, sil: false, ...o });
/** A white highlight. */
export const shine = (g: Piece, opacity = 0.85): Part => ({ ...g, mat: 'shine', tone: T.shine, opacity, sil: false, line: 0 });
/** A dark shading decal. */
export const shade = (g: Piece, t: Tone = T.shadow, opacity = 0.28): Part => ({ ...g, mat: 'shade', tone: t, opacity, sil: false, line: 0 });

// ─── Variant colours ───────────────────────────────────────────────────────────────────────────────

const ROLE: Record<string, Tone> = {
  danger: pair('#ff7a86', '#e0213c'),
  success: pair('#7cf08a', '#1fae45'),
  premium: T.gold,
  secondary: pair('#86d4ff', '#2a86e8'),
};

/** The tone a request's variant (and accent) asks for, or null for the prop's own colours. */
export function variantTone(v: Variant | undefined, accent?: Color): Tone | null {
  if (isRarity(v)) {
    const [a, b] = RARITY[v]!;
    const t: Tone = v === 'legendary' ? { ...T.gold, glint: true } : pair(a, b);
    if (v === 'mythic') return { hi: '#ffd6f6', mid: '#f03cd0', lo: '#6a128a', holo: true, glint: true };
    if (v === 'common') return { hi: '#ffffff', mid: '#c4ccd6', lo: '#6e7a8a' };
    return t;
  }
  if (v && ROLE[v]) return ROLE[v]!;
  if (accent) return tone(accent);
  return null;
}

// ─── Building ─────────────────────────────────────────────────────────────────────────────────────

/** Samples a gradient's stops at t. */
function sampleStops(stops: Array<[number, Color]>, t: number): Color {
  if (t <= stops[0]![0]) return stops[0]![1];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [t0, c0] = stops[i]!;
    const [t1, c1] = stops[i + 1]!;
    if (t <= t1) return blend(c0, c1, (t - t0) / (t1 - t0 || 1));
  }
  return stops[stops.length - 1]![1];
}

/** A vertical gradient over the frame span (y0, y1) as seen inside a part's own box (by, bh). */
function spanGradient(stops: Array<[number, Color]>, span: [number, number], by: number, bh: number): Paint {
  const [y0, y1] = span;
  const g = (lt: number) => (by + lt * bh - y0) / Math.max(1e-6, y1 - y0);
  const local: Stop[] = [];
  for (let i = 0; i <= 8; i++) local.push([i / 8, sampleStops(stops, g(i / 8))]);
  return { angle: 90, stops: local };
}

/** Mythic's shimmer: bands of hue across the face. */
const RAINBOW: Stop[] = [[0, '#ff5ad0'], [0.18, '#ffa04a'], [0.34, '#fff070'], [0.5, '#5cffa8'], [0.66, '#4ac8ff'], [0.82, '#a05cff'], [1, '#ff5ad0']];

export interface BuildOptions {
  /** No glints or shimmer (sheets that compare shapes only). */
  plainVariants?: boolean;
}

/** The layers of a prop in a direction's look. */
export function propLayers(def: PropDef, c: PropCtx): ForgeLayer[] {
  const L = c.look;
  const parts = def.draw(c).filter((p): p is Part => !!p);
  const tf = L.tone ?? ((x: Color) => x);
  const toneOf = (t: Tone): Tone => ({ ...t, hi: tf(t.hi), mid: tf(t.mid), lo: tf(t.lo) });
  const S = c.side;
  const outerW = Math.max(L.lineMin ?? 0, Math.min(L.lineMax ?? Infinity, S * L.line));
  const innerW = Math.max(L.pixel ? L.pixel : 0.55, outerW * L.inner);
  const at = (p: Piece): [number, number, number, number] => [c.ox + p.at[0] * c.u, c.oy + p.at[1] * c.u, p.at[2] * c.u, p.at[3] * c.u];
  const decal = (p: Part) => p.mat === 'shine' || p.mat === 'shade';
  const isSil = (p: Part) => p.sil ?? !decal(p);
  const sils = parts.filter(isSil);
  const shadowed = new Set(sils.filter((p) => p.shadow));
  if (!shadowed.size && sils[0]) shadowed.add(sils[0]);
  const glow = L.glow?.(c) ?? (def.aura && c.tint && c.rarity !== 'common' ? c.tint.mid : null);
  const out: ForgeLayer[] = [];

  // The outline pass: the silhouette as the direction's outline (with its base, drop shadow and glow) under the faces, so
  // the object has one clean outer edge. The silhouette parts are merged into one traced outline (one layer, one
  // shadow); rings (which hold holes), a union with a hole and moulded looks whose outline follows each part's own
  // colour are drawn part by part.
  const strokes = L.outline(outerW);
  const inkColor: Color = L.ink !== 'tone' ? L.ink : '#000000';
  if (strokes.length || L.holo) {
    const base = L.base ? Math.max(L.pixel ?? 1, S * L.base) : 0;
    const rings = sils.filter((p) => p.shape.kind === 'ring');
    const rest = sils.filter((p) => p.shape.kind !== 'ring');
    const loops = rest.length > 1 && L.inkTone === undefined ? unionOutline(rest, Math.min(5, Math.max(1.5, S / 60))) : null;
    const big = rest.reduce<Part | undefined>((b, p) => (!b || p.at[2] * p.at[3] > b.at[2] * b.at[3] ? p : b), undefined);
    const backs: Array<{ piece: Piece; tone: Tone; shadow: boolean }> =
      loops && big ? [...loops.map((l) => ({ piece: poly(l), tone: big.tone, shadow: true })), ...rings.map((p) => ({ piece: p as Piece, tone: p.tone, shadow: shadowed.has(p) }))] : sils.map((p) => ({ piece: p as Piece, tone: p.tone, shadow: shadowed.has(p) }));
    for (const b of backs) {
      const t = toneOf(b.tone);
      const ink = L.inkTone !== undefined ? darken(t.mid, L.inkTone) : null;
      const st: StrokeStyle[] = ink ? [{ width: outerW, paint: ink, position: 'outside' }] : strokes;
      const style: LayerStyle = L.holo
        ? { fill: t.mid, fillOpacity: 0, outerGlow: { color: t.mid, opacity: 0.55, size: S * 0.06 } }
        : {
            fill: ink ?? inkColor,
            strokes: st,
            ...(base ? { extrude: { depth: base, color: ink ? darken(t.mid, (L.inkTone ?? 0.5) + 0.1) : (L.baseColor ?? darken((def.base ? toneOf(def.base) : t).lo, 0.45)), stroke: { width: outerW, color: ink ?? inkColor } } } : {}),
            ...(b.shadow && L.shadow ? { dropShadow: { color: L.shadow.color, opacity: L.shadow.opacity, blur: Math.max(L.pixel ? 0 : 0.6, S * L.shadow.blur), offset: [0, Math.max(L.pixel ?? 1, S * L.shadow.y + base)] } } : {}),
            ...(glow ? { outerGlow: { color: glow, opacity: L.glowOpacity ?? 0.7, size: S * (L.glowSize ?? 0.07) } } : {}),
            ...(L.roughen ? { roughen: { amount: L.roughen * (S / 96), scale: 2, seed: 3 } } : {}),
          };
      out.push({ shape: scaleShape(b.piece.shape, c.u), at: at(b.piece), style });
    }
  }

  // The faces.
  for (const p of parts) {
    const t = toneOf(p.tone);
    const box = at(p);
    const style = faceStyle(p, t, box[2], box[3], c, innerW, shadowed.has(p) && !strokes.length && !L.holo);
    out.push({ shape: scaleShape(p.shape, c.u), at: box, style });
  }
  return out;
}

/** A part's face in the direction's look. */
function faceStyle(p: Part, t: Tone, w: number, h: number, c: PropCtx, innerW: number, castShadow: boolean): LayerStyle {
  const L = c.look;
  const m = Math.min(w, h);
  const S = c.side;
  const k = L.shade ?? 1;
  const tiny = p.plain || m < S * 0.06 || !!L.pixel;
  const ang = p.angle ?? 90;
  const lin = (stops: Array<[number, Color]>): Paint => (p.span ? spanGradient(stops, p.span, p.at[1], p.at[3]) : { angle: ang, stops });
  const lineK = p.line ?? (p.mat === 'shine' || p.mat === 'shade' || p.mat === 'glow' ? 0 : 1);
  const lineInk = p.lineColor ?? (L.ink === 'tone' || L.inkTone !== undefined ? darken(t.mid, 0.5) : L.ink);
  const strokes: StrokeStyle[] = lineK > 0 && !L.holo ? [{ width: innerW * lineK, paint: lineInk, position: 'outside' }] : [];
  const gloss = (o = 1): Partial<LayerStyle> =>
    L.gloss && !tiny ? { gloss: { style: L.gloss, opacity: (L.glossOpacity ?? 0.42) * o, height: L.gloss === 'spot' ? 0.55 : 0.5, inset: Math.max(0.6, m * 0.07), curve: 0.35 } } : {};
  const bevel = (size: number, hi: number, sh: number, spec = L.specular): Partial<LayerStyle> => (tiny ? {} : { bevel: { size: Math.max(0.6, m * size), style: L.bevel, highlightOpacity: hi, shadowOpacity: sh * k, specular: spec, angle: 120, altitude: 42 } });
  const under = (o: number): Partial<LayerStyle> => (tiny ? {} : { innerShadow: { color: darken(t.lo, 0.35), opacity: o * k, size: Math.max(0.8, m * 0.22), offset: [-m * 0.04, -m * 0.08] } });
  const bounce = (o: number): Partial<LayerStyle> => (tiny ? {} : { rim: { width: Math.max(0.8, m * 0.1), angle: -60, color: t.hi, opacity: o } });
  let s: LayerStyle;
  switch (p.mat) {
    case 'gloss':
      s = {
        fill: p.span ? lin([[0, t.hi], [0.5, t.mid], [1, t.lo]]) : { type: 'radial', center: [0.36, 0.28], scale: 1.3, stops: [[0, t.hi], [0.45, t.mid], [1, t.lo]] },
        ...under(0.35),
        ...bounce(0.3),
        ...bevel(0.12, 0.45, 0.25),
        ...gloss(),
      };
      break;
    case 'matte':
      s = { fill: p.span ? lin([[0, t.hi], [0.45, t.mid], [1, t.lo]]) : { type: 'radial', center: [0.38, 0.3], scale: 1.4, stops: [[0, t.hi], [0.5, t.mid], [1, t.lo]] }, ...under(0.3), ...bounce(0.18), ...bevel(0.12, 0.3, 0.2, 0) };
      break;
    case 'metal':
      s = {
        fill: lin([[0, t.hi], [0.4, t.mid], [0.56, blend(t.mid, t.lo, 0.55)], [0.8, t.mid], [1, blend(t.mid, t.hi, 0.35)]]),
        ...bevel(0.16, 0.65, 0.4, Math.max(L.specular, 0.7)),
        ...under(0.22),
        ...gloss(0.7),
      };
      break;
    case 'gem':
      s = { fill: { angle: p.angle ?? 120, stops: [[0, t.hi], [0.5, t.mid], [1, t.lo]] }, ...bevel(0.1, 0.5, 0.3, Math.max(L.specular, 0.6)), ...(tiny ? {} : { innerGlow: { color: t.hi, opacity: 0.35, size: m * 0.12 } }) };
      break;
    case 'glass':
      s = {
        fill: lin([[0, lighten(t.hi, 0.4)], [0.6, blend(t.mid, '#ffffff', 0.35)], [1, t.mid]]),
        ...(tiny ? {} : { innerGlow: { color: t.lo, opacity: 0.45, size: m * 0.12, blend: 'multiply' as const } }),
        ...gloss(1.1),
      };
      break;
    case 'liquid':
      s = {
        fill: p.span ? lin([[0, t.hi], [0.4, t.mid], [1, t.lo]]) : { type: 'radial', center: [0.42, 0.3], scale: 1.25, stops: [[0, t.hi], [0.5, t.mid], [1, t.lo]] },
        ...(tiny ? {} : { innerGlow: { color: t.hi, opacity: 0.35, size: m * 0.18 } }),
        ...under(0.25),
      };
      break;
    case 'wood':
      s = {
        fill: lin([[0, t.hi], [0.55, t.mid], [1, blend(t.mid, t.lo, 0.6)]]),
        ...(tiny ? {} : { textures: [{ kind: 'wood', scale: Math.max(2, S * 0.05), angle: p.angle === undefined ? 0 : p.angle - 90, color: t.lo, opacity: 0.45, seed: 4 }] }),
        ...under(0.3),
        ...bevel(0.1, 0.35, 0.25, 0),
      };
      break;
    case 'paper':
      s = { fill: lin([[0, t.hi], [0.6, t.mid], [1, blend(t.mid, t.lo, 0.4)]]), ...(tiny ? {} : { textures: [{ kind: 'paper', scale: Math.max(1.5, S * 0.02), opacity: 0.35, blend: 'multiply' }], innerGlow: { color: t.lo, opacity: 0.4, size: m * 0.14, blend: 'multiply' as const } }) };
      break;
    case 'flat':
      s = { fill: tiny ? t.mid : lin([[0, t.mid], [1, blend(t.mid, t.lo, 0.5)]]) };
      break;
    case 'glow':
      s = { fill: { type: 'radial', center: [0.5, 0.55], scale: 1.1, stops: [[0, t.hi], [0.6, t.mid], [1, t.lo]] }, ...(L.pixel ? {} : { outerGlow: { color: t.mid, opacity: 0.5, size: Math.max(1, m * 0.25) } }) };
      break;
    case 'shine':
      s = { fill: t.mid, fillOpacity: p.opacity ?? 0.85 };
      break;
    case 'shade':
      s = { fill: t.mid, fillOpacity: p.opacity ?? 0.28 };
      break;
  }
  if (L.holo && p.mat !== 'shine' && p.mat !== 'shade') {
    // Dark colours are lifted (a hologram is light); parts on the object are more solid than its shell.
    const [r0, g0, b0] = rgb(t.mid);
    const lum = 0.3 * r0 + 0.59 * g0 + 0.11 * b0;
    const fill = lighten(saturate(t.mid, 1.3), lum < 0.35 ? 0.45 : 0.15);
    const solid = p.sil === false ? 0.85 : 0.55;
    s = {
      fill: { angle: 90, stops: [[0, fill, solid], [1, lum < 0.35 ? fill : t.mid, solid * 0.4]] },
      patterns: [{ kind: 'scanlines', color: lighten(fill, 0.5), opacity: 0.25, size: Math.max(1.5, S * 0.03) }],
      strokes: [{ width: Math.max(0.8, S * 0.014), paint: lighten(fill, 0.6), position: 'inside' }],
      ...(p.sil === false ? {} : { outerGlow: { color: fill, opacity: 0.6, size: Math.max(1, S * 0.04) } }),
    };
    return s;
  }
  if (L.pixel && p.mat !== 'shine' && p.mat !== 'shade') {
    // Pixel art: banded light and shadow, a hard one-pixel highlight edge.
    const px = L.pixel;
    s = { fill: { angle: 90, stops: [[0, t.hi], [0.3, t.hi], [0.3001, t.mid], [0.72, t.mid], [0.7201, t.lo], [1, t.lo]] }, rim: { width: px, color: '#ffffff', opacity: 0.4, angle: 135, hard: true } };
  }
  const tex = !tiny && p.mat !== 'shine' && p.mat !== 'shade' && p.mat !== 'glow' ? L.textures?.(p.mat) : undefined;
  if (tex) s.textures = [...(s.textures ?? []), ...tex];
  if (!tiny && !L.pixel && (t.holo || t.glint) && p.mat !== 'shine' && p.mat !== 'shade') {
    if (t.holo) s.overlays = [...(s.overlays ?? []), { paint: { angle: 35, stops: RAINBOW }, blend: 'overlay', opacity: 0.75 }];
    if (m > S * 0.3) s.sparkles = { count: t.holo ? 3 : 2, size: Math.max(2, m * 0.14), area: 'inside', opacity: 0.95 };
  }
  if (L.glints && !tiny && (p.mat === 'metal' || p.mat === 'gem') && m > S * 0.25 && !s.sparkles) s.sparkles = { count: 1, size: Math.max(2, m * 0.16), area: 'inside', opacity: 0.9 };
  if (strokes.length) s.strokes = [...(s.strokes ?? []), ...strokes];
  if (castShadow && L.shadow) s.dropShadow = { color: L.shadow.color === 'tone' ? t.lo : L.shadow.color, opacity: L.shadow.opacity, blur: S * L.shadow.blur, offset: [0, S * L.shadow.y] };
  return { ...s, ...p.fx };
}

/** Where a prop sits in an element: the largest centred square. */
export function propFrame(size: [number, number]): { side: number; u: number; ox: number; oy: number } {
  const side = Math.min(size[0], size[1]);
  return { side, u: side / 100, ox: (size[0] - side) / 2, oy: (size[1] - side) / 2 };
}

/** Where wide art sits in an element: its bounds (in the unit frame, x0 y0 x1 y1) as large as fit, centred. */
export function wideFrame(size: [number, number], b: [number, number, number, number]): { side: number; u: number; ox: number; oy: number } {
  const u = Math.min(size[0] / (b[2] - b[0]), size[1] / (b[3] - b[1]));
  return { side: 100 * u, u, ox: (size[0] - (b[0] + b[2]) * u) / 2, oy: (size[1] - (b[1] + b[3]) * u) / 2 };
}

/** The bounds of a prop's parts in the unit frame (x0, y0, x1, y1), padded. */
function artBounds(def: PropDef, c: PropCtx, pad = 1.5): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of def.draw(c)) {
    if (!p || p.sil === false) continue;
    x0 = Math.min(x0, p.at[0]);
    y0 = Math.min(y0, p.at[1]);
    x1 = Math.max(x1, p.at[0] + p.at[2]);
    y1 = Math.max(y1, p.at[1] + p.at[3]);
  }
  return Number.isFinite(x0) ? [x0 - pad, y0 - pad, x1 + pad, y1 + pad] : [0, 0, 100, 100];
}

/** A prop context for a request in a look (and, for wide art in a wide element, framed by the art's own bounds). */
export function propCtx(r: Pick<ElementRequest, 'size' | 'variant' | 'glyph'>, look: PropLook, accent?: Color, def?: PropDef): PropCtx {
  const c = squareCtx(r, look, accent);
  if (!def?.wide || r.size[0] <= r.size[1] * 1.1) return c;
  const f = wideFrame(r.size, artBounds(def, { ...c, detail: 2 }));
  // Never smaller than the square frame would draw it.
  return f.u > c.u ? { ...c, ...f, detail: f.side < 64 ? 0 : f.side < 120 ? 1 : 2 } : c;
}

function squareCtx(r: Pick<ElementRequest, 'size' | 'variant' | 'glyph'>, look: PropLook, accent?: Color): PropCtx {
  const f = propFrame(r.size);
  const tint = variantTone(r.variant, accent);
  return {
    size: r.size,
    ...f,
    detail: f.side < 64 ? 0 : f.side < 120 ? 1 : 2,
    ...(r.variant ? { variant: r.variant } : {}),
    rarity: isRarity(r.variant) ? r.variant : null,
    tint,
    ...(accent ? { accent } : {}),
    ...(r.glyph ? { glyph: r.glyph } : {}),
    look,
    main: (natural: Tone) => tint ?? natural,
    own: (natural: Tone) => (tint?.glint ? { ...natural, glint: true } : natural),
  };
}

/** A prop as a whole Forge spec (not stretched: icons are drawn at their size). */
export function propSpec(def: PropDef, c: PropCtx): ForgeSpec {
  return { size: c.size, slice: false, layers: propLayers(def, c), ...(c.look.pixel ? { pixel: { size: c.look.pixel } } : {}) };
}
