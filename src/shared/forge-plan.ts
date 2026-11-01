import type { Color, CoverageBitmap, ForgeLayer, Forged, ForgeSpec, Gradient, LayerStyle, PackedContours, PixelArt, Pt, ShapeSpec } from './forge-types';

/**
 * A forge plan: everything of an element the GPU needs, laid out the way the CPU's `forge` lays it out
 * (src/core/ui/forge/forge.ts) — the canvas, each layer's region of it (its box and the reach of its effects), its
 * style in pixels and its shape cut into contours there, the pixel-art finish, and what `Forged` reports (margin,
 * scale, 9-slice). Cutting shapes needs the core (fonts and glyphs are files), so the core makes plans and the GPU
 * draws them (src/renderer/src/lib/forge-gl): `planForge(spec, cut)` with
 * `cut = (s, x, y, w, h, k) => shapeContours(scaleShape(s, k), x, y, w, h)`. Pure and plain data: a plan crosses
 * process boundaries as JSON once its contours are packed (planToWire), and the picture comes back as bytes.
 */

export const MAX_IMAGE = 1024;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanLayer {
  /** Where the layer is drawn on the canvas: [x, y, w, h] in whole pixels. */
  region: [number, number, number, number];
  /** The shape's box inside the region (pixels). */
  box: Box;
  /** The style in pixels (scaleStyle). */
  style: LayerStyle;
  /** The shape in region pixels: contours, or a coverage bitmap the region's size. */
  shape: PackedContours | CoverageBitmap;
  /** A solid glyph: the spaces its lines close in are filled (style.ts fillHoles). */
  fillHoles?: boolean;
}

export interface ForgePlan {
  /** The canvas drawn (before a pixel-art upscale), pixels. */
  width: number;
  height: number;
  layers: PlanLayer[];
  /** Pixel art: the finish on the canvas and the nearest-neighbour factor after it. */
  pixel: { threshold: number; levels: number; dither: boolean; k: number } | null;
  /** Everything Forged reports but the image. */
  meta: Omit<Forged, 'image'>;
}

/** Cuts a shape into contours: `shapeContours(scaleShape(shape, k), x, y, w, h)` in the core. */
export type Cut = (shape: ShapeSpec, x: number, y: number, w: number, h: number, k: number) => Pt[][];

/** "#rrggbb" or [r, g, b] (0-255) as 0..1 (canvas.ts rgb). */
export function rgb(c: Color): [number, number, number] {
  if (Array.isArray(c)) return [c[0] / 255, c[1] / 255, c[2] / 255];
  const h = c.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ─── style.ts and forge.ts bookkeeping ─────────────────────────────────────────────────────────────

/** How far the style's effects reach outside the shape (style.ts styleMargin). */
export function styleMargin(s: LayerStyle): number {
  const outer = Math.max(0, ...(s.strokes ?? []).map((k) => ((k.position ?? 'outside') === 'outside' ? k.width : (k.position ?? 'outside') === 'center' ? k.width / 2 : 0)));
  const glow = s.outerGlow ? s.outerGlow.size * 1.6 + (s.outerGlow.spread ?? 0) : 0;
  const shadow = s.dropShadow ? s.dropShadow.blur * 2.2 + Math.max(Math.abs(s.dropShadow.offset?.[0] ?? 0), Math.abs(s.dropShadow.offset?.[1] ?? 0)) + (s.dropShadow.spread ?? 0) : 0;
  const ex = s.extrude ? s.extrude.depth + (s.extrude.stroke?.width ?? 0) : 0;
  const rough = s.roughen ? s.roughen.amount : 0;
  const spark = s.sparkles?.area === 'around' ? (s.sparkles.size ?? 6) * 1.8 : 0;
  return Math.ceil(Math.max(outer + ex, glow, shadow + outer, spark, 0) + rough + 2);
}

/** A layer style with every length times `k` (forge.ts scaleStyle). */
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

/** How far into a layer its corners and edge effects reach (forge.ts cornerReach). */
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

/** Contours grouped into parts whose boxes, grown by `pad`, don't touch (forge.ts clusters). */
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

function squeezeBox(b: [number, number, number, number], fx: (v: number) => number, fy: (v: number) => number): [number, number, number, number] {
  const x0 = fx(b[0]);
  const y0 = fy(b[1]);
  return [x0, y0, fx(b[0] + b[2]) - x0, fy(b[1] + b[3]) - y0];
}

/** An element's plan: forge.ts's layout, step for step, with each layer's contours cut by `cut`. */
export function planForge(spec: ForgeSpec, cut: Cut): ForgePlan {
  const [W, H] = spec.size;
  const sliced = spec.slice !== false;
  const pix: PixelArt | null = spec.pixel === undefined ? null : typeof spec.pixel === 'number' ? { size: spec.pixel } : spec.pixel;
  const p = pix ? Math.max(0.25, pix.size) : 0;

  const unit = spec.layers.map((l) => {
    const [lx, ly, lw, lh] = l.at ?? [0, 0, W, H];
    return boundsOf(cut(l.shape, lx, ly, lw, lh, 1));
  });
  let marginPt = 0;
  spec.layers.forEach((l, i) => {
    const b = unit[i];
    const over = b ? Math.max(0, -b[0], b[2] - W, -b[1], b[3] - H) : 0;
    marginPt = Math.max(marginPt, styleMargin(l.style) + over);
  });
  marginPt = Math.ceil(marginPt);
  if (p) marginPt = Math.ceil(marginPt / p) * p;

  let reachX = 4;
  let reachY = 4;
  spec.layers.forEach((l) => {
    if (l.shape.kind === 'text') return;
    const [lx, ly, lw, lh] = l.at ?? [0, 0, W, H];
    const r = cornerReach(l, lw, lh);
    if (lw >= W * 0.5) reachX = Math.max(reachX, Math.max(lx, W - lx - lw) + r);
    // A small decoration at an end (a leaf cluster, hazard stripes, a stud) belongs to that end: kept whole.
    else if (lx + lw <= W * 0.42) reachX = Math.max(reachX, lx + lw + 2);
    else if (lx >= W * 0.58) reachX = Math.max(reachX, W - lx + 2);
    if (lh >= H * 0.5) reachY = Math.max(reachY, Math.max(ly, H - ly - lh) + r);
    else if (ly + lh <= H * 0.42) reachY = Math.max(reachY, ly + lh + 2);
    else if (ly >= H * 0.58) reachY = Math.max(reachY, H - ly + 2);
  });
  reachX = Math.min(reachX, W / 2 - 1);
  reachY = Math.min(reachY, H / 2 - 1);

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
  const squeeze = (L: number, D: number, reach: number) => {
    if (D >= L) return (v: number) => v;
    const a = Math.min(reach, D / 2 - 1);
    const k = (D - 2 * a) / Math.max(1e-6, L - 2 * a);
    return (v: number) => (v <= a ? v : v >= L - a ? v - (L - D) : a + (v - a) * k);
  };
  const fx = squeeze(W, dW, reachX);
  const fy = squeeze(H, dH, reachY);
  const narrowed = dW < W || dH < H;

  const rs = p ? 1 / p : scale;
  const cw = p ? Math.ceil((dW + 2 * marginPt) / p) : Math.ceil((dW + 2 * marginPt) * scale);
  const ch = p ? Math.ceil((dH + 2 * marginPt) / p) : Math.ceil((dH + 2 * marginPt) * scale);
  const layers: PlanLayer[] = [];
  for (const l of spec.layers) {
    const at = l.at ?? [0, 0, W, H];
    const [lx, ly, lw, lh] = narrowed ? squeezeBox(at, fx, fy) : at;
    const box = { x: (lx + marginPt) * rs, y: (ly + marginPt) * rs, w: lw * rs, h: lh * rs };
    const contours = cut(l.shape, box.x, box.y, box.w, box.h, rs);
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
      layers.push({ region: [rx, ry, rx1 - rx, ry1 - ry], box: { x: box.x - rx, y: box.y - ry, w: box.w, h: box.h }, style, shape: packContours(part, -rx, -ry), ...(l.shape.kind === 'glyph' && l.shape.solid ? { fillHoles: true } : {}) });
    }
  }
  let k = 1;
  if (p && pix) k = Math.round(scale * p);

  let slice: Forged['slice'] = null;
  if (sliced) {
    const toPx = (v: number) => (p ? Math.round(v / p) * k : Math.round(v * scale));
    const sx = marginPt + Math.min(reachX, dW / 2 - 1);
    const sy = marginPt + Math.min(reachY, dH / 2 - 1);
    slice = [toPx(sx), toPx(sy), Math.max(toPx(sx) + 1, toPx(dW + 2 * marginPt - sx)), Math.max(toPx(sy) + 1, toPx(dH + 2 * marginPt - sy))];
  }
  return {
    width: cw,
    height: ch,
    layers,
    pixel: p && pix ? { threshold: pix.threshold ?? 0.5, levels: pix.levels ?? 0, dither: !!pix.dither, k } : null,
    meta: { size: [W, H], margin: marginPt, scale, slice, ...(narrowed ? { drawn: [dW, dH] as [number, number] } : {}), ...(spec.content ? { content: spec.content } : {}) },
  };
}

/**
 * style.ts fillHoles: coverage below 0.5 that the canvas border can't reach (4-connected) becomes solid, except
 * the anti-aliased pixels next to what it can reach. In place; w × h values.
 */
export function fillHoles(v: Float32Array, w: number, h: number): void {
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

// ─── Contours ──────────────────────────────────────────────────────────────────────────────────────

/** Contours as two flat arrays (moved by dx, dy). */
export function packContours(contours: Pt[][], dx = 0, dy = 0): PackedContours {
  let n = 0;
  for (const c of contours) n += c.length;
  const points = new Float32Array(n * 2);
  const counts = new Uint32Array(contours.length);
  let k = 0;
  contours.forEach((c, i) => {
    counts[i] = c.length;
    for (const [x, y] of c) {
      points[k++] = x + dx;
      points[k++] = y + dy;
    }
  });
  return { points, counts };
}

export const isCoverage = (s: PackedContours | CoverageBitmap): s is CoverageBitmap => 'coverage' in s;

/** The closed contours' edges (x0, y0, x1, y1); horizontal ones add no area and are left out. */
export function edgesOf(s: PackedContours): Float32Array {
  const out = new Float32Array(s.points.length * 2);
  let k = 0;
  let o = 0;
  for (const n of s.counts) {
    for (let i = 0; i < n; i++) {
      const a = (o + i) * 2;
      const b = (o + ((i + 1) % n)) * 2;
      if (s.points[a + 1] === s.points[b + 1]) continue;
      out[k++] = s.points[a]!;
      out[k++] = s.points[a + 1]!;
      out[k++] = s.points[b]!;
      out[k++] = s.points[b + 1]!;
    }
    o += n;
  }
  return out.subarray(0, k);
}

/** A fingerprint of numbers (two FNV-style hashes over their bits), for caching fields by shape. */
export function fingerprint(a: Float32Array | Uint8Array, salt: ReadonlyArray<number | string>): string {
  const u = a instanceof Float32Array ? new Uint32Array(a.buffer, a.byteOffset, a.length) : a;
  let h1 = 2166136261;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i]!, 16777619);
    h2 = Math.imul(h2 ^ (u[i]! >>> 7), 2246822519) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${a.length}.${salt.join(',')}`;
}

// ─── Gradients (style.ts gradientOf) ───────────────────────────────────────────────────────────────

export const LUT = 1024;

const mixRgb = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A gradient's 1024-entry lookup table (r, g, b, a). */
export function gradientLut(stops0: Gradient['stops']): Float32Array {
  const stops = stops0.map(([t, c, a]) => ({ t, c: rgb(c), a: a ?? 1 })).sort((a, b) => a.t - b.t);
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
          c = mixRgb(s0.c, s1.c, f);
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
  return lut;
}

/** A gradient's geometry for the shaders: type (1 linear, 2 radial, 3 conic, 4 reflected, 5 diamond) and numbers. */
export function gradientGeom(p: Gradient, box: Box): { type: number; box: [number, number, number, number]; a: [number, number, number, number]; b: [number, number, number, number] } {
  const ang = ((p.angle ?? 90) * Math.PI) / 180;
  const [cx, cy] = p.center ?? [0.5, 0.5];
  const bw = Math.max(1, box.w);
  const bh = Math.max(1, box.h);
  const big = Math.max(bw, bh);
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const span = Math.abs(dx * bw) / 2 + Math.abs(dy * bh) / 2 || 1;
  const type = p.type === 'radial' ? 2 : p.type === 'conic' ? 3 : p.type === 'reflected' ? 4 : p.type === 'diamond' ? 5 : 1;
  return { type, box: [box.x, box.y, bw, bh], a: [cx, cy, big, p.scale ?? 1], b: [dx, dy, span, ang] };
}

// ─── Base64 (requests reach the hidden render page as JSON) ────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = (() => {
  const v = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) v[B64.charCodeAt(i)] = i;
  return v;
})();

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 3 * 4096) {
    let out = '';
    const end = Math.min(bytes.length, start + 3 * 4096);
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
    }
    if (i < end) {
      const n = (bytes[i]! << 16) | ((i + 1 < end ? bytes[i + 1]! : 0) << 8);
      out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < end ? B64[(n >> 6) & 63]! : '=') + '=';
    }
    parts.push(out);
  }
  return parts.join('');
}

export function fromBase64(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  const val = (i: number) => (i < len ? B64_VALUE[s.charCodeAt(i) & 127]! : 0);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** A plan as JSON-safe data (contours and bitmaps as base64), and back. */
export interface WirePlan extends Omit<ForgePlan, 'layers'> {
  layers: Array<Omit<PlanLayer, 'shape'> & { shape: { points: string; counts: number[] } | { coverage: string; bytes: boolean; width: number; height: number } }>;
}

export function planToWire(p: ForgePlan): WirePlan {
  return {
    ...p,
    layers: p.layers.map((l) => ({
      ...l,
      shape: isCoverage(l.shape)
        ? { coverage: toBase64(new Uint8Array(l.shape.coverage.buffer, l.shape.coverage.byteOffset, l.shape.coverage.byteLength)), bytes: l.shape.coverage instanceof Uint8Array, width: l.shape.width, height: l.shape.height }
        : { points: toBase64(new Uint8Array(l.shape.points.buffer, l.shape.points.byteOffset, l.shape.points.byteLength)), counts: Array.from(l.shape.counts) },
    })),
  };
}

export function planFromWire(w: WirePlan): ForgePlan {
  return {
    ...w,
    layers: w.layers.map((l) => {
      const s = l.shape;
      if ('coverage' in s) {
        const b = fromBase64(s.coverage);
        return { ...l, shape: { coverage: s.bytes ? b : new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2), width: s.width, height: s.height } };
      }
      const b = fromBase64(s.points);
      return { ...l, shape: { points: new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2), counts: Uint32Array.from(s.counts) } };
    }),
  };
}

// ─── The render page's request (core → main → the hidden render page) ─────────────────────────────

export interface ForgeGLRequest {
  plans: WirePlan[];
}

/** One plan's picture (straight RGBA, rows top first) and what Forged reports, or why the GPU couldn't draw it. */
export type ForgeGLItem = ({ width: number; height: number; rgba: Uint8Array } & Omit<Forged, 'image'>) | { error: string };

export interface ForgeGLResponse {
  /** The GPU that drew them, or null with every item an error (no WebGL2 there). */
  gpu: string | null;
  items: ForgeGLItem[];
  ms: number;
}

// ─── forge.plans: skins planned by the core, drawn by a page's own GPU forge ──────────────────────

export interface ForgePlansParams {
  /** Skin specs ("candy:button:primary", "ember:icon:sword:epic#ff7a1a") at element sizes (points); scale: art pixels per point (default the game's 2). */
  skins: Array<{ spec: string; size: [number, number]; scale?: number }>;
}

export type ForgePlanItem = { spec: string; size: [number, number]; plan: WirePlan } | { spec: string; size: [number, number]; error: string };

export interface ForgePlansResult {
  items: ForgePlanItem[];
  /** The core's share (layout and contours), ms. */
  ms: number;
}

// ─── What the GPU forge knows ──────────────────────────────────────────────────────────────────────

const KNOWN: Record<string, readonly string[]> = {
  style: ['fill', 'fillOpacity', 'patterns', 'textures', 'grain', 'overlays', 'extrude', 'bevel', 'innerShadow', 'innerGlow', 'wear', 'gloss', 'sheen', 'rim', 'strokes', 'sparkles', 'cutouts', 'outerGlow', 'dropShadow', 'roughen'],
  gradient: ['type', 'angle', 'stops', 'center', 'scale'],
  pattern: ['kind', 'color', 'opacity', 'size', 'angle', 'blend', 'duty', 'seed', 'offset'],
  texture: ['kind', 'scale', 'angle', 'seed', 'opacity', 'blend', 'color', 'ramp', 'contrast', 'invert', 'density', 'relief'],
  grain: ['amount', 'scale', 'blend'],
  overlay: ['paint', 'blend', 'opacity'],
  extrude: ['depth', 'color', 'angle', 'stroke'],
  extrudeStroke: ['width', 'color'],
  bevel: ['size', 'depth', 'angle', 'altitude', 'highlight', 'highlightOpacity', 'shadow', 'shadowOpacity', 'style', 'specular'],
  innerShadow: ['color', 'opacity', 'size', 'offset'],
  innerGlow: ['color', 'opacity', 'size', 'blend'],
  wear: ['amount', 'color', 'width', 'scale', 'seed', 'opacity'],
  gloss: ['opacity', 'height', 'inset', 'color', 'curve', 'style'],
  sheen: ['opacity', 'angle', 'width', 'at', 'color'],
  rim: ['width', 'color', 'opacity', 'angle', 'falloff', 'shade', 'shadeOpacity', 'hard'],
  stroke: ['width', 'paint', 'position', 'opacity'],
  sparkles: ['count', 'size', 'color', 'opacity', 'seed', 'area', 'glow'],
  outerGlow: ['color', 'opacity', 'size', 'spread'],
  dropShadow: ['color', 'opacity', 'offset', 'blur', 'spread'],
  roughen: ['amount', 'scale', 'seed'],
  spec: ['size', 'layers', 'scale', 'slice', 'pixel', 'content'],
  layer: ['shape', 'style', 'at'],
};
const ENUMS: Record<string, ReadonlyArray<string | undefined>> = {
  gradientType: [undefined, 'linear', 'radial', 'conic', 'reflected', 'diamond'],
  blend: [undefined, 'normal', 'multiply', 'screen', 'overlay', 'add', 'softlight', 'hardlight', 'lighten', 'darken', 'colordodge'],
  pattern: ['stripes', 'dots', 'checker', 'grid', 'hex', 'diamonds', 'waves', 'bricks', 'scales', 'bubbles', 'stars', 'hearts', 'chevron', 'crosshatch', 'plaid', 'confetti', 'studs', 'scanlines', 'zigzag', 'triangles', 'sparkles'],
  texture: ['noise', 'clouds', 'wood', 'brushed', 'stone', 'cells', 'fabric', 'marble', 'scratches', 'rust', 'camo', 'carbon', 'caustics', 'paper', 'leather', 'hammered', 'speckle', 'pixels'],
  bevelStyle: [undefined, 'smooth', 'chisel', 'pillow', 'round'],
  glossStyle: [undefined, 'arc', 'band', 'spot', 'glass'],
  position: [undefined, 'outside', 'inside', 'center'],
  area: [undefined, 'inside', 'top', 'edge', 'around'],
};

/**
 * Anything in a spec or its styles the GPU forge doesn't draw (a field or kind the CPU engine gained since it was
 * ported): its name, or null. Such an element is forged on the CPU, so a new effect never draws differently, only
 * slower until it is ported (and the parity run, scripts/forge-gl-parity, says what changed).
 */
export function unknownInSpec(spec: ForgeSpec): string | null {
  const extra = (o: unknown, kind: string): string | null => {
    if (!o || typeof o !== 'object') return null;
    const k = Object.keys(o).find((key) => !KNOWN[kind]!.includes(key) && (o as Record<string, unknown>)[key] !== undefined);
    return k ? `${kind}.${k}` : null;
  };
  const oneOf = (list: string, v: unknown, what: string): string | null => (ENUMS[list]!.includes(v as string | undefined) ? null : `${what} "${String(v)}"`);
  const paint = (p: unknown): string | null => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return extra(p, 'gradient') ?? oneOf('gradientType', (p as Gradient).type, 'gradient type');
  };
  const first = (...xs: Array<string | null>): string | null => xs.find((x) => x !== null) ?? null;
  const style = (s: LayerStyle): string | null =>
    first(
      extra(s, 'style'),
      paint(s.fill),
      ...[...(s.patterns ?? []), ...(s.cutouts ?? [])].map((p) => first(extra(p, 'pattern'), oneOf('pattern', p.kind, 'pattern'), oneOf('blend', p.blend, 'blend'))),
      ...(s.textures ?? []).map((t) => first(extra(t, 'texture'), oneOf('texture', t.kind, 'texture'), oneOf('blend', t.blend, 'blend'))),
      extra(s.grain, 'grain'),
      oneOf('blend', s.grain?.blend, 'blend'),
      ...(s.overlays ?? []).map((o) => first(extra(o, 'overlay'), paint(o.paint), oneOf('blend', o.blend, 'blend'))),
      extra(s.extrude, 'extrude'),
      extra(s.extrude?.stroke, 'extrudeStroke'),
      paint(s.extrude?.color),
      extra(s.bevel, 'bevel'),
      oneOf('bevelStyle', s.bevel?.style, 'bevel style'),
      extra(s.innerShadow, 'innerShadow'),
      extra(s.innerGlow, 'innerGlow'),
      oneOf('blend', s.innerGlow?.blend, 'blend'),
      extra(s.wear, 'wear'),
      extra(s.gloss, 'gloss'),
      oneOf('glossStyle', s.gloss?.style, 'gloss style'),
      extra(s.sheen, 'sheen'),
      extra(s.rim, 'rim'),
      ...(s.strokes ?? []).map((k) => first(extra(k, 'stroke'), paint(k.paint), oneOf('position', k.position, 'stroke position'))),
      extra(s.sparkles, 'sparkles'),
      oneOf('area', s.sparkles?.area, 'sparkles area'),
      extra(s.outerGlow, 'outerGlow'),
      extra(s.dropShadow, 'dropShadow'),
      extra(s.roughen, 'roughen'),
    );
  return first(extra(spec, 'spec'), ...spec.layers.map((l) => first(extra(l, 'layer'), style(l.style))));
}
