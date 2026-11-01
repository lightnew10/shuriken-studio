import type { RgbaImage } from '../../modeling/png';
import { fillMask, type Pt } from '../ui-raster';

/**
 * The UI Art Forge's canvas: premultiplied RGBA in floats, alpha coverage fields, and the operations a game UI
 * artist's layer styles are made of — Euclidean distance fields (exact, Felzenszwalb) for strokes, bevels and glows
 * that follow any shape (letters included), Gaussian blur (exact for small radii, three running-sum boxes for large
 * ones, so a 40 px shadow costs what a 4 px one does), value noise, compositing in the usual blend modes, and the
 * pixel-art finish (hard alpha, posterised colour with ordered dither, nearest-neighbour upscale). Everything is
 * deterministic: the same recipe draws the same pixels.
 */

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/** A field of one value per pixel (alpha coverage, distance, height). */
export interface Field {
  w: number;
  h: number;
  v: Float32Array;
}

/** Premultiplied RGBA, 0..1. */
export interface Canvas {
  w: number;
  h: number;
  px: Float32Array;
}

export const field = (w: number, h: number, fill = 0): Field => {
  const v = new Float32Array(w * h);
  if (fill) v.fill(fill);
  return { w, h, v };
};
export const canvas = (w: number, h: number): Canvas => ({ w, h, px: new Float32Array(w * h * 4) });

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
};

/** "#rrggbb" or [r, g, b] (0-255) as 0..1. */
export function rgb(c: string | RGB): RGB {
  if (Array.isArray(c)) return [c[0] / 255, c[1] / 255, c[2] / 255];
  const h = c.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Coverage of closed contours (pixel coordinates), anti-aliased. */
export function coverage(contours: Pt[][], w: number, h: number): Field {
  const f = field(w, h);
  const m = fillMask(contours, { x: 0, y: 0, w, h });
  if (!m) return f;
  for (let y = 0; y < m.h; y++) {
    const Y = m.y0 + y;
    if (Y < 0 || Y >= h) continue;
    for (let x = 0; x < m.w; x++) {
      const X = m.x0 + x;
      if (X >= 0 && X < w) f.v[Y * w + X] = Math.min(1, m.a[y * m.w + x]!);
    }
  }
  return f;
}

// ─── Distance fields ──────────────────────────────────────────────────────────────────────────────

const INF = 1e20;

// Scratch rows for the transform, grown as needed (single-threaded, so shared).
let rowF = new Float64Array(0);
let rowD = new Float64Array(0);
let rowV = new Int32Array(0);
let rowZ = new Float64Array(0);
const scratch = (n: number) => {
  if (rowF.length < n) {
    rowF = new Float64Array(n);
    rowD = new Float64Array(n);
    rowV = new Int32Array(n);
    rowZ = new Float64Array(n + 1);
  }
};

/** 1D squared distance transform (Felzenszwalb & Huttenlocher) of rowF[0..n) into rowD. */
function edt1d(n: number): void {
  const f = rowF;
  const d = rowD;
  const v = rowV;
  const z = rowZ;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q]! + q * q;
    let vk = v[k]!;
    let s = (fq - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
    while (s <= z[k]!) {
      k--;
      vk = v[k]!;
      s = (fq - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const vk = v[k]!;
    d[q] = (q - vk) * (q - vk) + f[vk]!;
  }
}

/** Squared Euclidean distance to the nearest seed (0 at seeds, INF elsewhere on entry), in place. */
function edtSquared(grid: Float32Array, w: number, h: number): void {
  scratch(Math.max(w, h));
  for (let x = 0; x < w; x++) {
    let any = false;
    for (let y = 0; y < h; y++) {
      const g = grid[y * w + x]!;
      rowF[y] = g;
      if (g < INF) any = true;
    }
    if (!any) continue;
    edt1d(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = rowD[y]!;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      const g = grid[row + x]!;
      rowF[x] = g;
      if (g < INF) any = true;
    }
    if (!any) continue;
    edt1d(w);
    for (let x = 0; x < w; x++) grid[row + x] = rowD[x]!;
  }
}

/**
 * Signed distance to a shape's edge from its coverage: negative inside, positive outside, in pixels, with the
 * anti-aliased edge kept sub-pixel (coverage 0.5 is the edge).
 */
export function signedDistance(a: Field): Field {
  const { w, h } = a;
  const n = w * h;
  const out = new Float32Array(n);
  const ins = new Float32Array(n);
  const av = a.v;
  for (let i = 0; i < n; i++) {
    const inside = av[i]! >= 0.5;
    out[i] = inside ? 0 : INF;
    ins[i] = inside ? INF : 0;
  }
  edtSquared(out, w, h);
  edtSquared(ins, w, h);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = av[i]!;
    // Pixels next to the edge take their coverage as the edge's sub-pixel position; deeper ones their distance
    // (coverage of 0.9999 deep inside is rounding, not an edge).
    const near = Math.sqrt(c >= 0.5 ? ins[i]! : out[i]!);
    s[i] = near <= 1 ? 0.5 - c : c >= 0.5 ? -(near - 0.5) : near - 0.5;
  }
  return { w, h, v: s };
}

// ─── Blur and noise ───────────────────────────────────────────────────────────────────────────────

/** Box widths (odd) whose three passes approximate a Gaussian of sigma. */
function boxesFor(sigma: number, n = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** One running-sum box pass along rows (zero or clamped past the edges). */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, clampEdge: boolean): void {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row]!;
    const last = src[row + w - 1]!;
    let acc = clampEdge ? first * r : 0;
    for (let i = 0; i <= r; i++) acc += i < w ? src[row + i]! : clampEdge ? last : 0;
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      const add = x + r + 1;
      const drop = x - r;
      acc += add < w ? src[row + add]! : clampEdge ? last : 0;
      acc -= drop >= 0 ? src[row + drop]! : clampEdge ? first : 0;
    }
  }
}

/** One running-sum box pass along columns, row by row (cache friendly). */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, clampEdge: boolean, acc: Float64Array): void {
  const inv = 1 / (2 * r + 1);
  const lastRow = (h - 1) * w;
  for (let x = 0; x < w; x++) acc[x] = clampEdge ? src[x]! * r : 0;
  for (let i = 0; i <= r; i++) {
    const row = i < h ? i * w : clampEdge ? lastRow : -1;
    if (row >= 0) for (let x = 0; x < w; x++) acc[x]! += src[row + x]!;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = acc[x]! * inv;
    const add = y + r + 1;
    const drop = y - r;
    const addRow = add < h ? add * w : clampEdge ? lastRow : -1;
    const dropRow = drop >= 0 ? drop * w : clampEdge ? 0 : -1;
    if (addRow >= 0) for (let x = 0; x < w; x++) acc[x]! += src[addRow + x]!;
    if (dropRow >= 0) for (let x = 0; x < w; x++) acc[x]! -= src[dropRow + x]!;
  }
}

/**
 * Gaussian blur of a field (sigma in pixels): an exact kernel up to sigma 2, three running-sum boxes beyond (cost
 * independent of sigma). Past the edges the field is 0, or the edge value with `clampEdges` (an inverted shape for
 * inner shadows).
 */
export function blur(a: Field, sigma: number, clampEdges = false): Field {
  const { w, h } = a;
  if (sigma <= 0.3 || w === 0 || h === 0) return { w, h, v: a.v.slice() };
  const tmp = new Float32Array(w * h);
  if (sigma < 2) {
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i]! /= sum;
    const src = a.v;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          let xx = x + i;
          if (xx < 0 || xx >= w) {
            if (!clampEdges) continue;
            xx = xx < 0 ? 0 : w - 1;
          }
          acc += src[row + xx]! * k[i + r]!;
        }
        tmp[row + x] = acc;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0 || yy >= h) {
          if (!clampEdges) continue;
          yy = yy < 0 ? 0 : h - 1;
        }
        const kk = k[i + r]!;
        const so = yy * w;
        const doff = y * w;
        for (let x = 0; x < w; x++) out[doff + x]! += tmp[so + x]! * kk;
      }
    return { w, h, v: out };
  }
  let src = a.v.slice();
  let dst = tmp;
  const acc = new Float64Array(w);
  for (const size of boxesFor(sigma)) {
    const r = (size - 1) >> 1;
    boxH(src, dst, w, h, r, clampEdges);
    [src, dst] = [dst, src];
    boxV(src, dst, w, h, r, clampEdges, acc);
    [src, dst] = [dst, src];
  }
  return { w, h, v: src };
}

/** A field moved by whole and fractional pixels (bilinear). */
export function shift(a: Field, dx: number, dy: number): Field {
  const { w, h } = a;
  const out = field(w, h);
  const src = a.v;
  const ix = Math.floor(dx);
  const iy = Math.floor(dy);
  const tx = dx - ix;
  const ty = dy - iy;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  // out(x, y) = bilinear src at (x - dx, y - dy): corners at (x - ix - 1 .. x - ix, y - iy - 1 .. y - iy).
  for (let y = 0; y < h; y++) {
    const sy1 = y - iy;
    const sy0 = sy1 - 1;
    const r1 = sy1 >= 0 && sy1 < h ? sy1 * w : -1;
    const r0 = sy0 >= 0 && sy0 < h ? sy0 * w : -1;
    if (r0 < 0 && r1 < 0) continue;
    const orow = y * w;
    for (let x = 0; x < w; x++) {
      const sx1 = x - ix;
      const sx0 = sx1 - 1;
      const in1 = sx1 >= 0 && sx1 < w;
      const in0 = sx0 >= 0 && sx0 < w;
      let v = 0;
      if (r1 >= 0) v += (in1 ? src[r1 + sx1]! * w00 : 0) + (in0 ? src[r1 + sx0]! * w10 : 0);
      if (r0 >= 0) v += (in1 ? src[r0 + sx1]! * w01 : 0) + (in0 ? src[r0 + sx0]! * w11 : 0);
      out.v[orow + x] = v;
    }
  }
  return out;
}

/** Deterministic hash of integer coordinates and a seed, 0..1. */
export const hash = (x: number, y: number, seed: number): number => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

/** Smooth value noise at a point (cells of size 1), 0..1. */
export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let tx = x - x0;
  let ty = y - y0;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Fractal value noise at a point: octaves halving in size and weight, 0..1. */
export function fbm(x: number, y: number, octaves: number, seed: number): number {
  let amp = 1;
  let total = 0;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    total += amp * valueNoise(x * f, y * f, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return total / norm;
}

/** The noise() field's value at one pixel. */
export function noiseAt(x: number, y: number, scale: number, octaves: number, seed: number, ox = 0, oy = 0): number {
  let amp = 1;
  let total = 0;
  let norm = 0;
  let s = scale;
  for (let o = 0; o < octaves; o++) {
    total += amp * valueNoise((x + ox) / s, (y + oy) / s, seed + o);
    norm += amp;
    amp *= 0.5;
    s /= 2;
  }
  return total / norm;
}

/** Smooth value noise in 0..1 at a scale (pixels per cell), several octaves; (ox, oy) moves the sampling origin. */
export function noise(w: number, h: number, scale: number, octaves = 3, seed = 7, ox = 0, oy = 0): Field {
  const f = field(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f.v[y * w + x] = noiseAt(x, y, scale, octaves, seed, ox, oy);
  return f;
}

// ─── Painting and compositing ─────────────────────────────────────────────────────────────────────

export type Blend = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'softlight' | 'hardlight' | 'lighten' | 'darken' | 'colordodge';

const blendChannel = (mode: Blend, b: number, s: number): number => {
  switch (mode) {
    case 'multiply':
      return b * s;
    case 'screen':
      return 1 - (1 - b) * (1 - s);
    case 'overlay':
      return b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'hardlight':
      return s < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'add':
      return Math.min(1, b + s);
    case 'lighten':
      return Math.max(b, s);
    case 'darken':
      return Math.min(b, s);
    case 'colordodge':
      return s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'softlight':
      return s < 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
    default:
      return s;
  }
};

/** One pixel of paint (colour r, g, b at coverage a) laid on the canvas. */
export function lay(px: Float32Array, i: number, a: number, r: number, g: number, b: number, mode: Blend, clip: boolean): void {
  const o = i * 4;
  const ba = px[o + 3]!;
  if (clip || mode !== 'normal') {
    // A layer clipped to what is under it: recolours the base, never grows it (blend modes need a base too).
    if (ba <= 0) return;
    const inv = 1 / ba;
    const br = px[o]! * inv;
    const bg = px[o + 1]! * inv;
    const bb = px[o + 2]! * inv;
    px[o] = (br + (blendChannel(mode, br, r) - br) * a) * ba;
    px[o + 1] = (bg + (blendChannel(mode, bg, g) - bg) * a) * ba;
    px[o + 2] = (bb + (blendChannel(mode, bb, b) - bb) * a) * ba;
  } else {
    const k = 1 - a;
    px[o] = r * a + px[o]! * k;
    px[o + 1] = g * a + px[o + 1]! * k;
    px[o + 2] = b * a + px[o + 2]! * k;
    px[o + 3] = a + ba * k;
  }
}

/**
 * Paints a colour (one colour, or per pixel from `color`) through `alpha` onto the canvas with a blend mode. The
 * blend applies where the canvas already has paint (as an artist's layer clipped to what is under it); `normal`
 * paints anywhere unless `clipToBase`.
 */
export function paint(c: Canvas, alpha: Field, color: RGB | ((x: number, y: number) => RGB), opacity = 1, mode: Blend = 'normal', clipToBase = false): void {
  const { w, h, px } = c;
  const av = alpha.v;
  const solid = Array.isArray(color) ? color : null;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let a = av[i]! * opacity;
      if (a <= 0) continue;
      if (a > 1) a = 1;
      const col = solid ?? (color as (x: number, y: number) => RGB)(x, y);
      lay(px, i, a, col[0], col[1], col[2], mode, clipToBase);
    }
  }
}

/** Paints per-pixel colours (r, g, b per pixel in `rgbBuf`) through `alpha`. */
export function paintBuffer(c: Canvas, alpha: Field, rgbBuf: Float32Array, opacity = 1, mode: Blend = 'normal', clipToBase = false): void {
  const { w, h, px } = c;
  const av = alpha.v;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    let a = av[i]! * opacity;
    if (a <= 0) continue;
    if (a > 1) a = 1;
    lay(px, i, a, rgbBuf[i * 3]!, rgbBuf[i * 3 + 1]!, rgbBuf[i * 3 + 2]!, mode, clipToBase);
  }
}

/** Erases where `alpha` covers (cut-outs: a knock-out stroke, a slot). */
export function erase(c: Canvas, alpha: Field): void {
  for (let i = 0; i < c.w * c.h; i++) {
    const k = 1 - clamp01(alpha.v[i]!);
    if (k >= 1) continue;
    for (let j = 0; j < 4; j++) c.px[i * 4 + j]! *= k;
  }
}

/** Lays one canvas over another (both premultiplied). */
export function over(dst: Canvas, src: Canvas, dx = 0, dy = 0): void {
  const x0 = Math.max(0, -dx);
  const y0 = Math.max(0, -dy);
  const x1 = Math.min(src.w, dst.w - dx);
  const y1 = Math.min(src.h, dst.h - dy);
  const sp = src.px;
  const dp = dst.px;
  for (let y = y0; y < y1; y++) {
    let s = (y * src.w + x0) * 4;
    let d = ((y + dy) * dst.w + x0 + dx) * 4;
    for (let x = x0; x < x1; x++, s += 4, d += 4) {
      const a = sp[s + 3]!;
      if (a <= 0) continue;
      const k = 1 - a;
      dp[d] = sp[s]! + dp[d]! * k;
      dp[d + 1] = sp[s + 1]! + dp[d + 1]! * k;
      dp[d + 2] = sp[s + 2]! + dp[d + 2]! * k;
      dp[d + 3] = a + dp[d + 3]! * k;
    }
  }
}

// ─── Pixel-art finish ─────────────────────────────────────────────────────────────────────────────

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Pixel art from a low-resolution canvas: alpha snapped to on or off at `threshold`, colour posterised to `levels`
 * per channel (0: kept) with an ordered (Bayer) dither when asked, in place.
 */
export function pixelFinish(c: Canvas, threshold = 0.5, levels = 0, dither = false): void {
  const { w, h, px } = c;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = px[o + 3]!;
      if (a < threshold) {
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
        continue;
      }
      const inv = 1 / a;
      for (let k = 0; k < 3; k++) {
        let v = clamp01(px[o + k]! * inv);
        if (levels > 1) {
          const step = levels - 1;
          const bias = dither ? (BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 - 0.5 : 0;
          v = clamp01(Math.round(v * step + bias) / step);
        }
        px[o + k] = v;
      }
      px[o + 3] = 1;
    }
}

/** A canvas scaled up by a whole factor, each pixel a k × k block (nearest neighbour). */
export function upscaleNearest(c: Canvas, k: number): Canvas {
  const out = canvas(c.w * k, c.h * k);
  for (let y = 0; y < out.h; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < out.w; x++) {
      const s = (sy * c.w + Math.floor(x / k)) * 4;
      const d = (y * out.w + x) * 4;
      out.px[d] = c.px[s]!;
      out.px[d + 1] = c.px[s + 1]!;
      out.px[d + 2] = c.px[s + 2]!;
      out.px[d + 3] = c.px[s + 3]!;
    }
  }
  return out;
}

/** The canvas as straight-alpha 8-bit RGBA (sRGB as painted). */
export function toImage(c: Canvas): RgbaImage {
  const data = new Uint8Array(c.w * c.h * 4);
  for (let i = 0; i < c.w * c.h; i++) {
    const a = clamp01(c.px[i * 4 + 3]!);
    data[i * 4 + 3] = Math.round(a * 255);
    if (a > 0) for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(clamp01(c.px[i * 4 + k]! / a) * 255);
  }
  return { width: c.w, height: c.h, data };
}

/** An image back into a canvas (for compositing previews). */
export function fromImage(img: RgbaImage): Canvas {
  const c = canvas(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    c.px[i * 4 + 3] = a;
    for (let k = 0; k < 3; k++) c.px[i * 4 + k] = (img.data[i * 4 + k]! / 255) * a;
  }
  return c;
}
