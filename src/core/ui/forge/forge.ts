import type { RgbaImage } from '../../modeling/png';
import type { Pt } from '../ui-raster';
import { canvas, over, pixelFinish, toImage, upscaleNearest, type Canvas } from './canvas';
import { scaleShape, shapeContours, type ShapeSpec } from './shapes';
import { renderStyled, styleMargin, type LayerStyle } from './style';

/**
 * One piece of UI art: a shape with layer styles (several layers stack, bottom first: a plate under a face, a face
 * under its title), rendered at `scale` pixels per design point, with the margin its effects need and the 9-slice
 * centre that keeps its corners, bevels and strokes the same size however the element is stretched (SliceScale
 * 1/scale in the game). Text layers make title plates and big numbers in Roblox's own fonts. Every length in a spec —
 * shapes and effects — is in design points.
 *
 * Roblox draws images at most 1024 px a side, so art never comes out bigger: big art is forged at a lower scale
 * (down to 1), and art still too big at scale 1 is forged with a narrower stretchable centre when it is 9-sliced
 * (the slice stretches it back; corners and insets unchanged) or at a scale below 1 when it is not.
 *
 * Each layer is drawn only over its own box and the reach of its effects, so a small badge on a big window costs
 * what a small badge costs.
 */

/** Roblox's largest image side (bigger uploads are downscaled, which breaks a 9-slice's borders). */
export const MAX_IMAGE = 1024;

/** Bumped when the look of forged art changes (caches keyed on it go stale). */
export const FORGE_VERSION = 4;

export interface ForgeLayer {
  shape: ShapeSpec;
  style: LayerStyle;
  /** The layer's box inside the element, in design points (default: the whole element). */
  at?: [x: number, y: number, w: number, h: number];
}

/** Pixel art: drawn with one art pixel per `size` design points, hard edges, then scaled up nearest-neighbour. */
export interface PixelArt {
  size: number;
  /** Colour levels per channel (0: unposterised). */
  levels?: number;
  /** An ordered dither across the posterised steps (retro gradients). */
  dither?: boolean;
  /** Alpha at or above this is solid, below is clear (default 0.5). */
  threshold?: number;
}

export interface ForgeSpec {
  /** Design points. */
  size: [number, number];
  layers: ForgeLayer[];
  /** Pixels per design point (default 2; lowered for art that would pass 1024 px). */
  scale?: number;
  /** false: the art is drawn at its size and not meant to stretch (title plates, badges). Default true. */
  slice?: boolean;
  /** Pixel art: art pixels this many design points wide (or the full options). */
  pixel?: number | PixelArt;
  /** Where content (a label, a grid) sits in this art, in design points of the element (a pressed button's face moves down). */
  content?: [x: number, y: number, w: number, h: number];
}

export interface Forged {
  image: RgbaImage;
  /** The element's design size and the margin (points) round it the image holds for shadows, glows and strokes. */
  size: [number, number];
  margin: number;
  /** Image pixels per design point. */
  scale: number;
  /** SliceCenter in image pixels, or null when the art isn't meant to stretch. */
  slice: [number, number, number, number] | null;
  /** The design size the art was drawn at when its centre was narrowed to fit 1024 px (the 9-slice stretches it back to `size`). */
  drawn?: [number, number];
  /** Where content sits (design points of the element), when the art says. */
  content?: [number, number, number, number];
}

/** How far into a layer its corners and edge effects reach (points): what a 9-slice must keep unstretched. */
function cornerReach(l: ForgeLayer, w: number, h: number): number {
  const s = l.shape;
  const st = l.style;
  const m = Math.min(w, h);
  let r = 0;
  switch (s.kind) {
    case 'rect':
      r = Math.max(...(Array.isArray(s.radius) ? s.radius : [s.radius ?? 0]));
      break;
    case 'cut':
      r = Math.max(...(Array.isArray(s.cut) ? s.cut : [s.cut])) + Math.max(0, ...(s.slant ?? [0, 0]).map(Math.abs));
      break;
    case 'tab':
      r = s.radius ?? m * 0.3;
      break;
    case 'shield':
      r = s.radius ?? m * 0.12;
      break;
    case 'pill':
    case 'ellipse':
      r = m / 2;
      break;
    case 'hex':
      r = s.point ?? h / 2;
      break;
    case 'ribbon':
      r = s.notch ?? h * 0.35;
      break;
    case 'bubble':
      r = (s.radius ?? m * 0.2) + (s.tail?.[2] ?? m * 0.3);
      break;
    case 'scallop':
      r = (s.radius ?? 0) + (s.scallop ?? Math.max(8, w / 10));
      break;
    case 'frame':
      r = Math.max(s.radius ?? 0, s.thickness);
      break;
    case 'brackets':
      r = (s.length ?? m * 0.22) + (s.inset ?? 0);
      break;
    case 'rivets':
      r = (s.inset ?? (s.radius ?? m * 0.035) * 2.4) + (s.radius ?? m * 0.035) * 2;
      break;
    case 'puffy':
      r = (s.bump ?? m * 0.14) * 2.4 + (s.radius ?? 0);
      break;
    case 'torn':
      r = (s.rough ?? m * 0.04) * 2 + (s.radius ?? 0);
      break;
    case 'wave':
      r = (s.amplitude ?? Math.min(h * 0.12, 8)) * 2 + (s.radius ?? 0);
      break;
    case 'drip':
      r = s.radius ?? 0;
      break;
    case 'stairs':
      r = s.step * ((s.steps ?? 2) + 1);
      break;
    case 'polygon':
      r = m * 0.3;
      break;
    default:
      r = m / 2;
  }
  const inner = Math.max(0, ...(st.strokes ?? []).filter((k) => (k.position ?? 'outside') !== 'outside').map((k) => k.width));
  return r + Math.max(st.bevel?.size ?? 0, st.innerGlow?.size ?? 0, st.rim?.width ?? 0, inner) + 2;
}

const boundsOf = (contours: Pt[][]): [number, number, number, number] | null => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of contours)
    for (const [x, y] of c) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return x1 >= x0 ? [x0, y0, x1, y1] : null;
};

/** Contours grouped into parts whose boxes, grown by `pad`, don't touch (one part when they all overlap). */
function clusters(contours: Pt[][], pad: number): Pt[][][] {
  if (contours.length < 2) return [contours];
  const boxes = contours.map((c) => boundsOf([c]));
  const parent = contours.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const near = (a: [number, number, number, number], b: [number, number, number, number]) => a[0] - pad <= b[2] + pad && b[0] - pad <= a[2] + pad && a[1] - pad <= b[3] + pad && b[1] - pad <= a[3] + pad;
  for (let i = 0; i < contours.length; i++)
    for (let j = i + 1; j < contours.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a && b && find(i) !== find(j) && near(a, b)) parent[find(i)] = find(j);
    }
  const groups = new Map<number, Pt[][]>();
  contours.forEach((c, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });
  return [...groups.values()];
}

/** A layer's box (points) moved through the narrowing of a sliced element's centre on each axis. */
function squeezeBox(b: [number, number, number, number], fx: (v: number) => number, fy: (v: number) => number): [number, number, number, number] {
  const x0 = fx(b[0]);
  const y0 = fy(b[1]);
  return [x0, y0, fx(b[0] + b[2]) - x0, fy(b[1] + b[3]) - y0];
}

export function forge(spec: ForgeSpec): Forged {
  const [W, H] = spec.size;
  const sliced = spec.slice !== false;
  const pix: PixelArt | null = spec.pixel === undefined ? null : typeof spec.pixel === 'number' ? { size: spec.pixel } : spec.pixel;
  const p = pix ? Math.max(0.25, pix.size) : 0;

  // Each layer's contours at a scale of 1 with no margin (shape lengths are points), to measure what pokes out.
  const unit = spec.layers.map((l) => {
    const [lx, ly, lw, lh] = l.at ?? [0, 0, W, H];
    return boundsOf(shapeContours(l.shape, lx, ly, lw, lh));
  });
  let marginPt = 0;
  spec.layers.forEach((l, i) => {
    const b = unit[i];
    const over = b ? Math.max(0, -b[0], b[2] - W, -b[1], b[3] - H) : 0;
    marginPt = Math.max(marginPt, styleMargin(l.style) + over);
  });
  marginPt = Math.ceil(marginPt);
  if (p) marginPt = Math.ceil(marginPt / p) * p;

  // The 9-slice's corner zones (points from each edge).
  let reachX = 4;
  let reachY = 4;
  spec.layers.forEach((l) => {
    if (l.shape.kind === 'text') return;
    const [lx, ly, lw, lh] = l.at ?? [0, 0, W, H];
    const r = cornerReach(l, lw, lh);
    if (lw >= W * 0.5) reachX = Math.max(reachX, Math.max(lx, W - lx - lw) + r);
    // A small decoration at an end (a leaf cluster, hazard stripes, a stud) belongs to that end: keep it whole.
    else if (lx + lw <= W * 0.42) reachX = Math.max(reachX, lx + lw + 2);
    else if (lx >= W * 0.58) reachX = Math.max(reachX, W - lx + 2);
    if (lh >= H * 0.5) reachY = Math.max(reachY, Math.max(ly, H - ly - lh) + r);
    else if (ly + lh <= H * 0.42) reachY = Math.max(reachY, ly + lh + 2);
    else if (ly >= H * 0.58) reachY = Math.max(reachY, H - ly + 2);
  });
  reachX = Math.min(reachX, W / 2 - 1);
  reachY = Math.min(reachY, H / 2 - 1);

  // Scale and drawn size under Roblox's 1024 px cap.
  const want = spec.scale ?? 2;
  let scale = want;
  let dW = W;
  let dH = H;
  const fitScale = (w: number, h: number) => Math.floor((MAX_IMAGE / Math.max(w + 2 * marginPt, h + 2 * marginPt)) * 1000) / 1000;
  if (p) {
    const k = Math.max(1, Math.round(want * p));
    let lw = Math.ceil((W + 2 * marginPt) / p);
    let lh = Math.ceil((H + 2 * marginPt) / p);
    if (Math.max(lw, lh) > MAX_IMAGE && sliced) {
      dW = Math.min(W, MAX_IMAGE * p - 2 * marginPt - p);
      dH = Math.min(H, MAX_IMAGE * p - 2 * marginPt - p);
      lw = Math.ceil((dW + 2 * marginPt) / p);
      lh = Math.ceil((dH + 2 * marginPt) / p);
    }
    scale = Math.max(1, Math.min(k, Math.floor(MAX_IMAGE / Math.max(lw, lh)))) / p;
  } else if (fitScale(W, H) < want) {
    const s1 = fitScale(W, H);
    if (s1 >= 1 || !sliced) scale = Math.min(want, s1);
    else {
      scale = Math.min(want, 1);
      const most = Math.floor(MAX_IMAGE / scale) - 2 * marginPt - 1;
      dW = Math.min(W, most);
      dH = Math.min(H, most);
    }
  }
  // Narrowing the centre: points inside the corner zones keep their place, the middle is compressed.
  const squeeze = (L: number, D: number, reach: number) => {
    if (D >= L) return (v: number) => v;
    const a = Math.min(reach, D / 2 - 1);
    const k = (D - 2 * a) / Math.max(1e-6, L - 2 * a);
    return (v: number) => (v <= a ? v : v >= L - a ? v - (L - D) : a + (v - a) * k);
  };
  const fx = squeeze(W, dW, reachX);
  const fy = squeeze(H, dH, reachY);
  const narrowed = dW < W || dH < H;

  // Drawing resolution: pixel art draws one canvas pixel per art pixel.
  const rs = p ? 1 / p : scale;
  const cw = p ? Math.ceil((dW + 2 * marginPt) / p) : Math.ceil((dW + 2 * marginPt) * scale);
  const ch = p ? Math.ceil((dH + 2 * marginPt) / p) : Math.ceil((dH + 2 * marginPt) * scale);
  let out: Canvas = canvas(cw, ch);
  for (const l of spec.layers) {
    const at = l.at ?? [0, 0, W, H];
    const [lx, ly, lw, lh] = narrowed ? squeezeBox(at, fx, fy) : at;
    const box = { x: (lx + marginPt) * rs, y: (ly + marginPt) * rs, w: lw * rs, h: lh * rs };
    const contours = shapeContours(scaleShape(l.shape, rs), box.x, box.y, box.w, box.h);
    // Effects are given in design points: scale them to pixels.
    const style = scaleStyle(l.style, rs);
    const pad = styleMargin(style) + 2;
    // Parts far apart (rivets at the corners, studs, flourishes) are drawn each over its own small region.
    for (const part of clusters(contours, pad)) {
      const b = boundsOf(part);
      if (!b) continue;
      const rx = Math.max(0, Math.floor(b[0] - pad));
      const ry = Math.max(0, Math.floor(b[1] - pad));
      const rx1 = Math.min(cw, Math.ceil(b[2] + pad));
      const ry1 = Math.min(ch, Math.ceil(b[3] + pad));
      if (rx1 <= rx || ry1 <= ry) continue;
      const local = part.map((c) => c.map(([x, y]) => [x - rx, y - ry] as Pt));
      const layer = renderStyled(local, rx1 - rx, ry1 - ry, { x: box.x - rx, y: box.y - ry, w: box.w, h: box.h }, style, { fillHoles: l.shape.kind === 'glyph' && !!l.shape.solid });
      over(out, layer, rx, ry);
    }
  }
  let k = 1;
  if (p && pix) {
    pixelFinish(out, pix.threshold ?? 0.5, pix.levels ?? 0, !!pix.dither);
    k = Math.round(scale * p);
    if (k > 1) out = upscaleNearest(out, k);
  }

  let slice: Forged['slice'] = null;
  if (sliced) {
    // In drawn points, then pixels (pixel art: whole art pixels).
    const toPx = (v: number) => (p ? Math.round(v / p) * k : Math.round(v * scale));
    const sx = marginPt + Math.min(reachX, dW / 2 - 1);
    const sy = marginPt + Math.min(reachY, dH / 2 - 1);
    slice = [toPx(sx), toPx(sy), Math.max(toPx(sx) + 1, toPx(dW + 2 * marginPt - sx)), Math.max(toPx(sy) + 1, toPx(dH + 2 * marginPt - sy))];
  }
  return {
    image: toImage(out),
    size: [W, H],
    margin: marginPt,
    scale,
    slice,
    ...(narrowed ? { drawn: [dW, dH] as [number, number] } : {}),
    ...(spec.content ? { content: spec.content } : {}),
  };
}

/** A layer style with every length (stroke widths, blurs, offsets, bevel sizes, pattern cells, textures) times `k`. */
export function scaleStyle(s: LayerStyle, k: number): LayerStyle {
  const o = <T extends [number, number] | undefined>(v: T) => (v ? ([v[0] * k, v[1] * k] as T) : v);
  return {
    ...s,
    ...(s.patterns ? { patterns: s.patterns.map((p) => ({ ...p, size: (p.size ?? 12) * k, ...(p.offset ? { offset: o(p.offset) } : {}) })) } : {}),
    ...(s.cutouts ? { cutouts: s.cutouts.map((p) => ({ ...p, size: (p.size ?? 12) * k, ...(p.offset ? { offset: o(p.offset) } : {}) })) } : {}),
    ...(s.textures ? { textures: s.textures.map((t) => ({ ...t, scale: (t.scale ?? 12) * k })) } : {}),
    ...(s.grain ? { grain: { ...s.grain, scale: (s.grain.scale ?? 3) * k } } : {}),
    ...(s.extrude ? { extrude: { ...s.extrude, depth: s.extrude.depth * k, ...(s.extrude.stroke ? { stroke: { ...s.extrude.stroke, width: s.extrude.stroke.width * k } } : {}) } } : {}),
    ...(s.bevel ? { bevel: { ...s.bevel, size: s.bevel.size * k } } : {}),
    ...(s.innerShadow ? { innerShadow: { ...s.innerShadow, size: s.innerShadow.size * k, offset: o(s.innerShadow.offset) } } : {}),
    ...(s.innerGlow ? { innerGlow: { ...s.innerGlow, size: s.innerGlow.size * k } } : {}),
    ...(s.wear ? { wear: { ...s.wear, width: (s.wear.width ?? 8) * k, scale: (s.wear.scale ?? 4) * k } } : {}),
    ...(s.gloss ? { gloss: { ...s.gloss, ...(s.gloss.inset !== undefined ? { inset: s.gloss.inset * k } : {}) } } : {}),
    ...(s.rim ? { rim: { ...s.rim, width: s.rim.width * k } } : {}),
    ...(s.sparkles ? { sparkles: { ...s.sparkles, size: (s.sparkles.size ?? 6) * k } } : {}),
    ...(s.strokes ? { strokes: s.strokes.map((st) => ({ ...st, width: st.width * k })) } : {}),
    ...(s.outerGlow ? { outerGlow: { ...s.outerGlow, size: s.outerGlow.size * k, spread: (s.outerGlow.spread ?? 0) * k } } : {}),
    ...(s.dropShadow ? { dropShadow: { ...s.dropShadow, blur: s.dropShadow.blur * k, spread: (s.dropShadow.spread ?? 0) * k, offset: o(s.dropShadow.offset) } } : {}),
    ...(s.roughen ? { roughen: { ...s.roughen, amount: s.roughen.amount * k, scale: (s.roughen.scale ?? 6) * k } } : {}),
  };
}
