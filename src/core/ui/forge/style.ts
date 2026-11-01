import type { Pt } from '../ui-raster';
import { blur, canvas, clamp01, coverage, erase, field, fbm, hash, lay, mix, noiseAt, paint, rgb, shift, signedDistance, smoothstep, type Blend, type Canvas, type Field, type RGB } from './canvas';
import { patternField, sparkleAt, textureField, type Pattern, type Texture } from './textures';

export type { Pattern, PatternKind, Texture, TextureKind } from './textures';

/**
 * Layer styles, as a game UI artist sets them in Photoshop or Figma, as data an agent can write: a fill (solid or
 * gradient), patterns, surface textures (wood, brushed metal, stone, fabric, marble, scratches, rust, camo…) and grain,
 * gradient overlays, a base extrusion (the chunky 3D "lip" under simulator buttons), bevel and emboss lit from a
 * direction, inner shadow and glow, edge wear, a gloss highlight, a sheen band, a rim light, stacked strokes inside,
 * centred or outside (any colour or gradient), star sparkles, cut-outs, outer glow and drop shadow, and a roughened
 * edge. Every effect follows the shape's distance field, so it hugs rounded corners, cut panels and letters alike.
 */

export type Color = string | [number, number, number];
export type Stop = [t: number, color: Color] | [t: number, color: Color, alpha: number];

export interface Gradient {
  /** reflected: the first stop on the centre line, the last at both ends; diamond: like radial with square falloff. */
  type?: 'linear' | 'radial' | 'conic' | 'reflected' | 'diamond';
  /** Degrees; 90 runs top to bottom. */
  angle?: number;
  stops: Stop[];
  /** Radial centre (0..1 of the box) and its reach. */
  center?: [number, number];
  scale?: number;
}

export type Paint = Color | Gradient;

export interface StrokeStyle {
  width: number;
  paint: Paint;
  position?: 'outside' | 'inside' | 'center';
  opacity?: number;
}

export interface LayerStyle {
  fill: Paint;
  fillOpacity?: number;
  patterns?: Pattern[];
  /** Surface textures over the fill, in order: wood grain, brushed metal, stone, fabric, marble, scratches, rust… */
  textures?: Texture[];
  /** Film grain or a rough texture: amount 0..1, scale in points. */
  grain?: { amount: number; scale?: number; blend?: Blend };
  /** Colour or gradient laid over the face with a blend (shading a textured surface, a vignette). */
  overlays?: Array<{ paint: Paint; blend?: Blend; opacity?: number }>;
  /** A copy of the shape pushed down (or any way) under it: the chunky base of a candy button, the depth of 3D type. */
  extrude?: { depth: number; color: Paint; angle?: number; stroke?: { width: number; color: Color } };
  bevel?: {
    size: number;
    depth?: number;
    /** Light direction in degrees (120: from the upper left, 90: from above). */
    angle?: number;
    altitude?: number;
    highlight?: Color;
    highlightOpacity?: number;
    shadow?: Color;
    shadowOpacity?: number;
    /** smooth: rounded slope; chisel: hard flat facets; pillow: a dome; round: a quarter-round moulding. */
    style?: 'smooth' | 'chisel' | 'pillow' | 'round';
    /** 0..1: a tighter, brighter specular highlight on the slopes facing the light (glossy plastic, polished metal). */
    specular?: number;
  };
  innerShadow?: { color: Color; opacity?: number; size: number; offset?: [number, number] };
  innerGlow?: { color: Color; opacity?: number; size: number; blend?: Blend };
  /** Chipped paint near the edges showing `color` (bare metal, wood): amount 0..1 of the edge band. */
  wear?: { amount: number; color: Color; width?: number; scale?: number; seed?: number; opacity?: number };
  /**
   * A highlight over the top of the shape: arc (soft, its lower edge bowing down: glossy plastic), band (a crisp
   * top-half highlight: simulator buttons), spot (a soft oval top-left: bubbles, gems), glass (a diagonal reflection).
   */
  gloss?: { opacity?: number; height?: number; inset?: number; color?: Color; curve?: number; style?: 'arc' | 'band' | 'spot' | 'glass' };
  /** A diagonal light band across the face (a metal or glass sheen). */
  sheen?: { opacity?: number; angle?: number; width?: number; at?: number; color?: Color };
  /** Light catching the inside of the edge that faces it (and optionally shade on the opposite edge): depth on any shape. hard: an exact band, all or nothing (pixel-art bevels). */
  rim?: { width: number; color?: Color; opacity?: number; angle?: number; falloff?: number; shade?: Color; shadeOpacity?: number; hard?: boolean };
  strokes?: StrokeStyle[];
  /** Four-point star glints: inside the face, along its top, on its edge, or around it. */
  sparkles?: { count?: number; size?: number; color?: Color; opacity?: number; seed?: number; area?: 'inside' | 'top' | 'edge' | 'around'; glow?: number };
  /** Patterns cut out of the finished layer (stencil bridges, perforations). */
  cutouts?: Pattern[];
  outerGlow?: { color: Color; opacity?: number; size: number; spread?: number };
  dropShadow?: { color: Color; opacity?: number; offset?: [number, number]; blur: number; spread?: number };
  /** A torn, rough or rusted edge: the outline pushed in and out by noise, `amount` points either way. */
  roughen?: { amount: number; scale?: number; seed?: number };
}

// ─── Paint sources ─────────────────────────────────────────────────────────────────────────────────

const LUT = 1024;

/** A gradient as a lookup table (r, g, b, a per entry) and the position along it of each pixel. */
function gradientOf(p: Gradient, box: { x: number; y: number; w: number; h: number }): { lut: Float32Array; t: (x: number, y: number) => number; affine?: [number, number, number] } {
  const stops = p.stops.map(([t, c, a]) => ({ t, c: rgb(c), a: a ?? 1 })).sort((a, b) => a.t - b.t);
  const lut = new Float32Array(LUT * 4);
  for (let i = 0; i < LUT; i++) {
    const t = i / (LUT - 1);
    let c = stops[0]!.c;
    let a = stops[0]!.a;
    if (t > stops[0]!.t) {
      c = stops[stops.length - 1]!.c;
      a = stops[stops.length - 1]!.a;
      for (let k = 0; k + 1 < stops.length; k++) {
        const s0 = stops[k]!;
        const s1 = stops[k + 1]!;
        if (t <= s1.t) {
          const f = (t - s0.t) / (s1.t - s0.t || 1);
          c = mix(s0.c, s1.c, f);
          a = s0.a + (s1.a - s0.a) * f;
          break;
        }
      }
    }
    lut[i * 4] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = a;
  }
  const ang = ((p.angle ?? 90) * Math.PI) / 180;
  const [cx, cy] = p.center ?? [0.5, 0.5];
  const bw = Math.max(1, box.w);
  const bh = Math.max(1, box.h);
  const big = Math.max(bw, bh);
  const scale = p.scale ?? 1;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const span = Math.abs(dx * bw) / 2 + Math.abs(dy * bh) / 2 || 1;
  const type = p.type ?? 'linear';
  const t = (x: number, y: number): number => {
    const u = (x - box.x) / bw;
    const v = (y - box.y) / bh;
    switch (type) {
      case 'radial':
        return (Math.hypot((u - cx) * (bw / big), (v - cy) * (bh / big)) * 2) / scale;
      case 'diamond':
        return ((Math.abs(u - cx) * (bw / big) + Math.abs(v - cy) * (bh / big)) * 2) / scale;
      case 'conic':
        return ((((Math.atan2(v - cy, u - cx) - ang) / (2 * Math.PI)) % 1) + 1) % 1;
      case 'reflected': {
        const l = 0.5 + ((u - 0.5) * dx * bw + (v - 0.5) * dy * bh) / (2 * span);
        return Math.abs(l - 0.5) * 2;
      }
      default:
        return 0.5 + ((u - 0.5) * dx * bw + (v - 0.5) * dy * bh) / (2 * span);
    }
  };
  // Linear: t is affine in x and y.
  const affine: [number, number, number] | undefined = type === 'linear' ? [dx / (2 * span), dy / (2 * span), 0.5 - ((box.x / bw + 0.5) * dx * bw + (box.y / bh + 0.5) * dy * bh) / (2 * span)] : undefined;
  return { lut, t, ...(affine ? { affine } : {}) };
}

/** A paint as a colour per pixel, over the box (x, y, w, h); alpha from stops multiplies coverage. */
export function painter(p: Paint, box: { x: number; y: number; w: number; h: number }): { color: (x: number, y: number) => RGB; alpha: (x: number, y: number) => number } {
  if (typeof p === 'string' || Array.isArray(p)) {
    const c = rgb(p as Color);
    return { color: () => c, alpha: () => 1 };
  }
  const g = gradientOf(p, box);
  const idx = (x: number, y: number) => Math.round(clamp01(g.t(x, y)) * (LUT - 1)) * 4;
  return { color: (x, y) => { const i = idx(x, y); return [g.lut[i]!, g.lut[i + 1]!, g.lut[i + 2]!]; }, alpha: (x, y) => g.lut[idx(x, y) + 3]! };
}

/** Paints a paint (colour or gradient over `box`) through `alpha`. */
function paintPaint(c: Canvas, alpha: Field, p: Paint, box: { x: number; y: number; w: number; h: number }, opacity = 1, mode: Blend = 'normal', clip = false): void {
  if (typeof p === 'string' || Array.isArray(p)) {
    paint(c, alpha, rgb(p as Color), opacity, mode, clip);
    return;
  }
  const g = gradientOf(p, box);
  const { w, h, px } = c;
  const av = alpha.v;
  const lut = g.lut;
  const lin = g.affine;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a0 = av[i]! * opacity;
      if (a0 <= 0) continue;
      const t = lin ? lin[0] * x + lin[1] * y + lin[2] : g.t(x, y);
      const k = Math.round((t < 0 ? 0 : t > 1 ? 1 : t) * (LUT - 1)) * 4;
      const a = Math.min(1, a0 * lut[k + 3]!);
      if (a <= 0) continue;
      lay(px, i, a, lut[k]!, lut[k + 1]!, lut[k + 2]!, mode, clip);
    }
}

// ─── Rendering a styled shape ─────────────────────────────────────────────────────────────────────

/** How far the style's effects reach outside the shape (the margin a canvas needs around it). */
export function styleMargin(s: LayerStyle): number {
  const outer = Math.max(0, ...(s.strokes ?? []).map((k) => ((k.position ?? 'outside') === 'outside' ? k.width : (k.position ?? 'outside') === 'center' ? k.width / 2 : 0)));
  const glow = s.outerGlow ? s.outerGlow.size * 1.6 + (s.outerGlow.spread ?? 0) : 0;
  const shadow = s.dropShadow ? s.dropShadow.blur * 2.2 + Math.max(Math.abs(s.dropShadow.offset?.[0] ?? 0), Math.abs(s.dropShadow.offset?.[1] ?? 0)) + (s.dropShadow.spread ?? 0) : 0;
  const ex = s.extrude ? s.extrude.depth + (s.extrude.stroke?.width ?? 0) : 0;
  const rough = s.roughen ? s.roughen.amount : 0;
  const spark = s.sparkles?.area === 'around' ? (s.sparkles.size ?? 6) * 1.8 : 0;
  return Math.ceil(Math.max(outer + ex, glow, shadow + outer, spark, 0) + rough + 2);
}

/** Moves the max of `src` shifted by (dx, dy) into `dst` (integer steps exact, fractional bilinear). */
function maxShifted(dst: Field, src: Field, dx: number, dy: number): void {
  const { w, h } = src;
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  if (Math.abs(dx - rx) < 1e-4 && Math.abs(dy - ry) < 1e-4) {
    const y0 = Math.max(0, ry);
    const y1 = Math.min(h, h + ry);
    const x0 = Math.max(0, rx);
    const x1 = Math.min(w, w + rx);
    for (let y = y0; y < y1; y++) {
      const so = (y - ry) * w - rx;
      const d = y * w;
      for (let x = x0; x < x1; x++) {
        const v = src.v[so + x]!;
        if (v > dst.v[d + x]!) dst.v[d + x] = v;
      }
    }
    return;
  }
  const m = shift(src, dx, dy);
  for (let i = 0; i < w * h; i++) if (m.v[i]! > dst.v[i]!) dst.v[i] = m.v[i]!;
}

/**
 * A shape (contours in pixels on a w × h canvas) drawn with a layer style. `box` is the shape's own box (gradients,
 * textures and gloss are laid out over it). Order, bottom to top: drop shadow, outer glow, extrusion, outside strokes,
 * fill, patterns, textures, grain, overlays, inner shadow, inner glow, wear, bevel, gloss, sheen, rim, centre and
 * inside strokes, sparkles, cut-outs.
 */
export function renderStyled(contours: Pt[][], w: number, h: number, box: { x: number; y: number; w: number; h: number }, s: LayerStyle, opts: { fillHoles?: boolean } = {}): Canvas {
  const c = canvas(w, h);
  const n = w * h;
  let shape = coverage(contours, w, h);
  if (opts.fillHoles) fillHoles(shape);
  let sd = signedDistance(shape);
  if (s.roughen && s.roughen.amount > 0) {
    const r = s.roughen;
    const sc = Math.max(1, r.scale ?? 6);
    const seed = r.seed ?? 21;
    const reach = 1.2 * r.amount + 1;
    const rough = field(w, h);
    // Noise only where it can move the edge; elsewhere the pixel stays in or out.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const d = sd.v[i]!;
        rough.v[i] = d < -reach ? 1 : d > reach ? 0 : clamp01(0.5 - (d + (noiseAt(x, y, sc, 3, seed, -box.x, -box.y) - 0.5) * 2.4 * r.amount));
      }
    shape = rough;
    sd = signedDistance(shape);
  }
  const sdv = sd.v;
  const band = (from: number, to: number): Field => {
    // Coverage of the distance band (from, to] with a one-pixel anti-aliased edge.
    const f = field(w, h);
    for (let i = 0; i < n; i++) {
      const d = sdv[i]!;
      const a = Math.min(d - from + 0.5, to - d + 0.5);
      f.v[i] = a <= 0 ? 0 : a >= 1 ? 1 : a;
    }
    return f;
  };
  const grow = (by: number): Field => (by <= 0 ? shape : band(-1e9, by));
  const inside = (f: Field): Field => {
    for (let i = 0; i < n; i++) f.v[i]! *= shape.v[i]!;
    return f;
  };
  const stroke = (k: StrokeStyle) => {
    const pos = k.position ?? 'outside';
    const f = pos === 'outside' ? band(0, k.width) : pos === 'inside' ? band(-k.width, 0) : band(-k.width / 2, k.width / 2);
    paintPaint(c, f, k.paint, { x: box.x - k.width, y: box.y - k.width, w: box.w + 2 * k.width, h: box.h + 2 * k.width }, k.opacity ?? 1);
  };

  if (s.dropShadow) {
    const ds = s.dropShadow;
    const base = shift(blur(grow(ds.spread ?? 0), ds.blur), ds.offset?.[0] ?? 0, ds.offset?.[1] ?? 4);
    paint(c, base, rgb(ds.color), ds.opacity ?? 0.5);
  }
  if (s.outerGlow) {
    const g = s.outerGlow;
    paint(c, blur(grow(g.spread ?? 0), g.size), rgb(g.color), g.opacity ?? 0.8);
  }
  const outsideStrokes = (s.strokes ?? []).filter((k) => (k.position ?? 'outside') === 'outside').sort((a, b) => b.width - a.width);
  if (s.extrude && s.extrude.depth > 0) {
    // The shape (with its outside strokes) repeated down to depth: the base under the face.
    const e = s.extrude;
    const reach = Math.max(0, ...outsideStrokes.map((k) => k.width));
    const a = ((e.angle ?? 90) * Math.PI) / 180;
    const steps = Math.max(1, Math.ceil(e.depth));
    const stackOf = (sil: Field): Field => {
      const st = field(w, h);
      for (let i = 1; i <= steps; i++) maxShifted(st, sil, (Math.cos(a) * e.depth * i) / steps, (Math.sin(a) * e.depth * i) / steps);
      return st;
    };
    if (e.stroke && e.stroke.width > 0) paint(c, stackOf(grow(reach + e.stroke.width)), rgb(e.stroke.color));
    paintPaint(c, stackOf(grow(reach)), e.color, { x: box.x, y: box.y, w: box.w, h: box.h + e.depth });
  }
  for (const k of outsideStrokes) stroke(k);

  // The face.
  paintPaint(c, shape, s.fill, box, s.fillOpacity ?? 1);
  for (const pt of s.patterns ?? []) paint(c, inside(patternField(pt, w, h, box.x, box.y, shape)), rgb(pt.color), pt.opacity ?? 0.15, pt.blend ?? 'normal', true);
  for (const t of s.textures ?? []) texture(c, t, shape, box);
  if (s.grain) {
    const gs = s.grain.scale ?? 3;
    const amt = s.grain.amount;
    const mode = s.grain.blend ?? 'overlay';
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = shape.v[i]! * amt;
        if (a <= 0) continue;
        const v = noiseAt(x, y, gs, 3, 11, -box.x, -box.y);
        lay(c.px, i, Math.min(1, a), v, v, v, mode, true);
      }
  }
  for (const o of s.overlays ?? []) paintPaint(c, shape, o.paint, box, o.opacity ?? 1, o.blend ?? 'normal', true);
  if (s.innerShadow) {
    const k = s.innerShadow;
    // Light blocked at the edges: the inverted shape, blurred and moved, seen through the face.
    const inv = field(w, h);
    for (let i = 0; i < n; i++) inv.v[i] = 1 - shape.v[i]!;
    const b = shift(blur(inv, k.size / 2, true), k.offset?.[0] ?? 0, k.offset?.[1] ?? 2);
    // Past the canvas the inverted shape is solid: a shift must not pull in nothing from there.
    const ox = k.offset?.[0] ?? 0;
    const oy = k.offset?.[1] ?? 2;
    if (ox || oy)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) if (x - ox < 0 || x - ox >= w || y - oy < 0 || y - oy >= h) b.v[y * w + x] = 1;
    paint(c, inside(b), rgb(k.color), k.opacity ?? 0.5, 'normal', true);
  }
  if (s.innerGlow) {
    const k = s.innerGlow;
    const g = field(w, h);
    for (let i = 0; i < n; i++) g.v[i] = shape.v[i]! * (1 - smoothstep(0, k.size, -sdv[i]!));
    paint(c, g, rgb(k.color), k.opacity ?? 0.6, k.blend ?? 'screen', true);
  }
  if (s.wear && s.wear.amount > 0) {
    const k = s.wear;
    const width = k.width ?? 8;
    const sc = Math.max(1, k.scale ?? 4);
    const seed = k.seed ?? 31;
    const f = field(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (shape.v[i]! <= 0) continue;
        const zone = 1 - smoothstep(0, width, -sdv[i]!);
        if (zone <= 0) continue;
        const v = fbm((x - box.x) / sc, (y - box.y) / sc, 3, seed) * (0.45 + 0.55 * zone) + zone * 0.25;
        f.v[i] = smoothstep(1 - k.amount * 0.75, 1 - k.amount * 0.75 + 0.06, v) * shape.v[i]!;
      }
    paint(c, f, rgb(k.color), k.opacity ?? 1, 'normal', true);
  }
  if (s.bevel) bevel(c, s.bevel, shape, sd);
  if (s.gloss) gloss(c, s.gloss, shape, sd, box);
  if (s.sheen) {
    const k = s.sheen;
    const a = ((k.angle ?? 60) * Math.PI) / 180;
    const width = (k.width ?? 0.18) * Math.max(box.w, box.h);
    const cx = box.x + box.w * (k.at ?? 0.35);
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const f = field(w, h);
    const den = 2 * (width / 2.5) ** 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (shape.v[i]! <= 0) continue;
        const d = (x - cx) * sa - (y - box.y - box.h / 2) * ca;
        f.v[i] = shape.v[i]! * Math.exp(-(d * d) / den);
      }
    paint(c, f, rgb(k.color ?? '#ffffff'), k.opacity ?? 0.25, 'screen', true);
  }
  if (s.rim) rim(c, s.rim, shape, sd);
  for (const k of (s.strokes ?? []).filter((k) => (k.position ?? 'outside') !== 'outside')) stroke(k);
  if (s.sparkles) sparkles(c, s.sparkles, shape, sd, box);
  for (const pt of s.cutouts ?? []) erase(c, patternField(pt, w, h, box.x, box.y));
  return c;
}

/** Fills the spaces a shape closes in (pixels the outside cannot reach), keeping the outer edge anti-aliased. */
export function fillHoles(f: Field): void {
  const { w, h, v } = f;
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!out[i] && v[i]! < 0.5) {
      out[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  for (let i = 0; i < w * h; i++) {
    if (out[i]) continue;
    const x = i % w;
    const edge = (x > 0 && out[i - 1]) || (x < w - 1 && out[i + 1]) || (i >= w && out[i - w]) || (i < w * (h - 1) && out[i + w]);
    if (!edge) v[i] = 1;
  }
}

/** A texture laid on the face: through a ramp of colours, one colour, or as grey with a blend; raised if asked. */
function texture(c: Canvas, t: Texture, shape: Field, box: { x: number; y: number; w: number; h: number }): void {
  const { w, h } = c;
  const n = w * h;
  const v = textureField(t, w, h, box.x, box.y, shape);
  const op = t.opacity ?? 0.5;
  if (t.ramp) {
    const g = gradientOf({ stops: t.ramp }, { x: 0, y: 0, w: 1, h: 1 });
    const mode = t.blend ?? 'normal';
    for (let i = 0; i < n; i++) {
      const s = shape.v[i]!;
      if (s <= 0) continue;
      const k = Math.round(clamp01(v.v[i]!) * (LUT - 1)) * 4;
      const a = Math.min(1, s * op * g.lut[k + 3]!);
      if (a > 0) lay(c.px, i, a, g.lut[k]!, g.lut[k + 1]!, g.lut[k + 2]!, mode, true);
    }
  } else if (t.color !== undefined) {
    const col = rgb(t.color);
    const mode = t.blend ?? 'normal';
    for (let i = 0; i < n; i++) {
      const a = Math.min(1, shape.v[i]! * v.v[i]! * op);
      if (a > 0) lay(c.px, i, a, col[0], col[1], col[2], mode, true);
    }
  } else {
    const mode = t.blend ?? 'overlay';
    for (let i = 0; i < n; i++) {
      const a = Math.min(1, shape.v[i]! * op);
      const g = v.v[i]!;
      if (a > 0) lay(c.px, i, a, g, g, g, mode, true);
    }
  }
  if (t.relief) {
    // The value as a height: its slopes lit from the upper left.
    const k = t.relief * 2.2;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const s = shape.v[i]!;
        if (s <= 0) continue;
        const gx = (v.v[i + 1]! - v.v[i - 1]!) * 0.5;
        const gy = (v.v[i + w]! - v.v[i - w]!) * 0.5;
        const lit = (-gx * -0.6 + -gy * -0.8) * k;
        if (lit > 0) lay(c.px, i, Math.min(1, lit * s), 1, 1, 1, 'screen', true);
        else if (lit < 0) lay(c.px, i, Math.min(1, -lit * s), 0, 0, 0, 'multiply', true);
      }
  }
}

function bevel(c: Canvas, b: NonNullable<LayerStyle['bevel']>, shape: Field, sd: Field): void {
  const { w, h } = c;
  const n = w * h;
  const size = Math.max(1, b.size);
  // Height from the distance inside the edge; its slope lit from a direction.
  const hgt = field(w, h);
  for (let i = 0; i < n; i++) {
    const d = -sd.v[i]!;
    if (d <= 0) continue;
    const t = d >= size ? 1 : d / size;
    hgt.v[i] = b.style === 'chisel' ? t : b.style === 'pillow' ? Math.sin((t * Math.PI) / 2) : b.style === 'round' ? Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))) : smoothstep(0, 1, t) * 0.6 + t * 0.4;
  }
  const smooth = blur(hgt, b.style === 'chisel' ? 0.5 : Math.max(0.6, size / 6));
  const az = (((b.angle ?? 120) - 90) * Math.PI) / 180;
  const alt = ((b.altitude ?? 40) * Math.PI) / 180;
  const L0 = Math.cos(alt) * Math.cos(az + Math.PI / 2);
  const L1 = -Math.cos(alt) * Math.sin(az + Math.PI / 2);
  const L2 = Math.sin(alt);
  const depth = (b.depth ?? 1) * size * 0.9;
  const hc = rgb(b.highlight ?? '#ffffff');
  const sc = rgb(b.shadow ?? '#000000');
  const ho = b.highlightOpacity ?? 0.75;
  const so = b.shadowOpacity ?? 0.6;
  const spec = b.specular ?? 0;
  const sv = smooth.v;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const cov = shape.v[i]!;
      if (cov <= 0) continue;
      const gx = (sv[i + 1]! - sv[i - 1]!) * 0.5 * depth;
      const gy = (sv[i + w]! - sv[i - w]!) * 0.5 * depth;
      if (gx === 0 && gy === 0) continue;
      const len = Math.sqrt(gx * gx + gy * gy + 1);
      const ndl = (-gx * L0 - gy * L1 + L2) / len;
      const lit = ndl - L2;
      if (lit > 0) {
        let a = Math.min(1, lit * 2.2) * ho;
        if (spec > 0) a = Math.min(1, a + Math.pow(Math.max(0, ndl), 24) * spec * 1.4);
        lay(c.px, i, a * cov, hc[0], hc[1], hc[2], 'screen', true);
      } else if (lit < 0) lay(c.px, i, Math.min(1, -lit * 2.2) * so * cov, sc[0], sc[1], sc[2], 'multiply', true);
    }
}

function gloss(c: Canvas, g: NonNullable<LayerStyle['gloss']>, shape: Field, sd: Field, box: { x: number; y: number; w: number; h: number }): void {
  const { w, h } = c;
  const inset = g.inset ?? Math.max(2, box.h * 0.06);
  const height = (g.height ?? 0.48) * box.h;
  const col = rgb(g.color ?? '#ffffff');
  const f = field(w, h);
  const curve = g.curve ?? 0.35;
  const style = g.style ?? 'arc';
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = sd.v[i]!;
      if (d > -inset + 1.5 || shape.v[i]! <= 0) continue;
      const edgeIn = smoothstep(-inset + 1.5, -inset - 1.5, d);
      const u = (x - box.x) / box.w - 0.5;
      const v = (y - box.y) / Math.max(1, box.h);
      let a = 0;
      if (style === 'spot') {
        const sx = (u + 0.2) / 0.26;
        const sy = (v - 0.24) / Math.max(0.05, (g.height ?? 0.48) * 0.36);
        a = 1 - smoothstep(0.55, 1, Math.hypot(sx, sy));
      } else if (style === 'glass') {
        // A crisp diagonal: light above the line from the left at `height` to the right near the top.
        const line = (g.height ?? 0.48) * (1 - (u + 0.5) * 0.65);
        const t = v - line;
        a = (1 - smoothstep(-0.006, 0.006, t)) * (0.55 + 0.45 * (1 - v / Math.max(0.05, line)));
      } else {
        // A highlight whose lower edge bows down in the middle.
        const edge = box.y + height * (1 - curve * 4 * u * u * 0.5);
        const t = (y - box.y) / Math.max(1, edge - box.y);
        if (t < 0 || t > 1.05) continue;
        a = style === 'band' ? (1 - smoothstep(0.93, 1.0, t)) * (1 - 0.45 * t) : 1 - smoothstep(0.35, 1, t);
      }
      f.v[i] = a * edgeIn;
    }
  paint(c, f, col, g.opacity ?? 0.45, 'screen', true);
}

function rim(c: Canvas, r: NonNullable<LayerStyle['rim']>, shape: Field, sd: Field): void {
  const { w, h } = c;
  const ang = ((r.angle ?? 90) * Math.PI) / 180;
  const lx = Math.cos(ang);
  const ly = -Math.sin(ang);
  const pw = r.falloff ?? 1.5;
  const hi = field(w, h);
  const lo = r.shade ? field(w, h) : null;
  const sv = sd.v;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const cov = shape.v[i]!;
      if (cov <= 0) continue;
      const d = -sv[i]!;
      if (d > r.width + 1) continue;
      const zone = r.hard ? (d < r.width ? 1 : 0) : 1 - smoothstep(r.width * 0.45, r.width + 0.5, d);
      if (zone <= 0) continue;
      // Outward normal from the distance field's slope.
      const nx = sv[i + 1]! - sv[i - 1]!;
      const ny = sv[i + w]! - sv[i - w]!;
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) continue;
      const facing = (nx * lx + ny * ly) / len;
      if (r.hard) {
        if (facing > 0.3) hi.v[i] = zone * cov;
        else if (lo && facing < -0.3) lo.v[i] = zone * cov;
      } else if (facing > 0) hi.v[i] = zone * Math.pow(facing, pw) * cov;
      else if (lo) lo.v[i] = zone * Math.pow(-facing, pw) * cov;
    }
  paint(c, hi, rgb(r.color ?? '#ffffff'), r.opacity ?? 0.6, 'screen', true);
  if (lo) paint(c, lo, rgb(r.shade!), r.shadeOpacity ?? 0.4, 'multiply', true);
}

function sparkles(c: Canvas, k: NonNullable<LayerStyle['sparkles']>, shape: Field, sd: Field, box: { x: number; y: number; w: number; h: number }): void {
  const { w, h } = c;
  const count = k.count ?? 3;
  const size = k.size ?? 6;
  const seed = k.seed ?? 9;
  const area = k.area ?? 'inside';
  const f = field(w, h);
  const glow = k.glow ?? 0.35;
  let placed = 0;
  const spots: Array<[number, number, number]> = [];
  for (let tries = 0; tries < count * 40 && placed < count; tries++) {
    // Round the shape: candidates over the box grown by the sparkles' reach.
    const g = area === 'around' ? size * 1.6 : 0;
    const px = box.x - g + hash(tries, 1, seed) * (box.w + 2 * g);
    const py = box.y - g + hash(tries, 2, seed) * (box.h + 2 * g) * (area === 'top' ? 0.5 : 1);
    const r = size * (0.55 + 0.45 * hash(tries, 3, seed));
    const xi = Math.round(px);
    const yi = Math.round(py);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
    const d = sd.v[yi * w + xi]!;
    const ok = area === 'around' ? d > r * 0.2 && d < r * 1.2 : area === 'edge' ? d > -r * 0.5 && d < r * 0.1 : d < -r * 0.6;
    if (!ok) continue;
    // Keep them apart.
    if (spots.some(([sx, sy, sr]) => Math.hypot(sx - px, sy - py) < (sr + r) * 1.4)) continue;
    spots.push([px, py, r]);
    placed++;
  }
  for (const [px, py, r] of spots) {
    const reach = Math.ceil(r * 1.2);
    for (let y = Math.max(0, Math.floor(py - reach)); y < Math.min(h, Math.ceil(py + reach)); y++)
      for (let x = Math.max(0, Math.floor(px - reach)); x < Math.min(w, Math.ceil(px + reach)); x++) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        const v = Math.max(sparkleAt(dx, dy, r), glow * Math.exp(-(dx * dx + dy * dy) / (2 * (r * 0.35) ** 2)));
        const i = y * w + x;
        if (v > f.v[i]!) f.v[i] = v;
      }
  }
  const col = rgb(k.color ?? '#ffffff');
  if (area === 'around') paint(c, f, col, k.opacity ?? 0.95);
  else paint(c, f, col, k.opacity ?? 0.95, 'screen', true);
}

/** Every colour in a style mapped (states: a disabled button greyed, a hovered one brightened). */
export function mapStyleColors(s: LayerStyle, fn: (c: RGB) => RGB): LayerStyle {
  const col = (c: Color): Color => {
    const v = fn(rgb(c));
    return [Math.round(clamp01(v[0]) * 255), Math.round(clamp01(v[1]) * 255), Math.round(clamp01(v[2]) * 255)];
  };
  const pnt = (p: Paint): Paint => (typeof p === 'string' || Array.isArray(p) ? col(p as Color) : { ...p, stops: p.stops.map((st) => [st[0], col(st[1]), ...(st.length > 2 ? [st[2]] : [])] as Stop) });
  const out: LayerStyle = { ...s, fill: pnt(s.fill) };
  if (s.patterns) out.patterns = s.patterns.map((p) => ({ ...p, color: col(p.color) }));
  if (s.textures) out.textures = s.textures.map((t) => ({ ...t, ...(t.color !== undefined ? { color: col(t.color) } : {}), ...(t.ramp ? { ramp: t.ramp.map((st) => [st[0], col(st[1]), ...(st.length > 2 ? [st[2]] : [])] as Stop) } : {}) }));
  if (s.overlays) out.overlays = s.overlays.map((o) => ({ ...o, paint: pnt(o.paint) }));
  if (s.extrude) out.extrude = { ...s.extrude, color: pnt(s.extrude.color), ...(s.extrude.stroke ? { stroke: { ...s.extrude.stroke, color: col(s.extrude.stroke.color) } } : {}) };
  if (s.innerShadow) out.innerShadow = { ...s.innerShadow, color: col(s.innerShadow.color) };
  if (s.innerGlow) out.innerGlow = { ...s.innerGlow, color: col(s.innerGlow.color) };
  if (s.wear) out.wear = { ...s.wear, color: col(s.wear.color) };
  if (s.strokes) out.strokes = s.strokes.map((k) => ({ ...k, paint: pnt(k.paint) }));
  if (s.outerGlow) out.outerGlow = { ...s.outerGlow, color: col(s.outerGlow.color) };
  if (s.rim?.shade) out.rim = { ...s.rim, shade: col(s.rim.shade) };
  return out;
}

/** The effects' palette as a quick lookup for recipes. */
export const darken = (c: Color, t: number): [number, number, number] => {
  const v = rgb(c);
  return [Math.round(v[0] * (1 - t) * 255), Math.round(v[1] * (1 - t) * 255), Math.round(v[2] * (1 - t) * 255)];
};
export const lighten = (c: Color, t: number): [number, number, number] => {
  const v = rgb(c);
  return [Math.round((v[0] + (1 - v[0]) * t) * 255), Math.round((v[1] + (1 - v[1]) * t) * 255), Math.round((v[2] + (1 - v[2]) * t) * 255)];
};
/** A colour with its saturation scaled (0: grey, 1: as is, >1: richer). */
export const saturate = (c: Color, k: number): [number, number, number] => {
  const v = rgb(c);
  const l = 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
  return [Math.round(clamp01(l + (v[0] - l) * k) * 255), Math.round(clamp01(l + (v[1] - l) * k) * 255), Math.round(clamp01(l + (v[2] - l) * k) * 255)];
};
/** Two colours mixed (t = 0: a, 1: b). */
export const blend = (a: Color, b: Color, t: number): [number, number, number] => {
  const m = mix(rgb(a), rgb(b), t);
  return [Math.round(m[0] * 255), Math.round(m[1] * 255), Math.round(m[2] * 255)];
};

