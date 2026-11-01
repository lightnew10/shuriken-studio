import type { RgbaImage } from '../modeling/png';

/**
 * A small 2D rasteriser for UI pictures drawn in the core (no browser, no GPU), like the effects contact sheets
 * (core/effects/render.ts): filled outlines with exact anti-aliased coverage (signed-area accumulation, as font
 * renderers do it), strokes as bands round an outline, soft shadows as blurred masks, and painting a mask with a
 * colour, a per-pixel shader or an image. Colours blend in sRGB, as Roblox and browsers do. Deterministic: the
 * same calls draw the same pixels.
 */

export type Pt = [number, number];
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An opaque picture: r, g, b per pixel, 0..1. */
export interface Raster {
  w: number;
  h: number;
  rgb: Float32Array;
}

/** How much of a shape covers each pixel of a region (0..1). */
export interface Mask {
  x0: number;
  y0: number;
  w: number;
  h: number;
  a: Float32Array;
}

export function newRaster(w: number, h: number, fill: [number, number, number] = [0, 0, 0]): Raster {
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set(fill, i * 3);
  return { w, h, rgb };
}

/** The pixel box of points, inside `bounds` (null when nothing of it is). */
function pixelBox(contours: Pt[][], bounds: Rect): Rect | null {
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
  const bx0 = Math.max(Math.floor(x0), Math.floor(bounds.x));
  const by0 = Math.max(Math.floor(y0), Math.floor(bounds.y));
  const bx1 = Math.min(Math.ceil(x1), Math.ceil(bounds.x + bounds.w));
  const by1 = Math.min(Math.ceil(y1), Math.ceil(bounds.y + bounds.h));
  if (!(bx1 > bx0 && by1 > by0)) return null;
  return { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
}

/**
 * The coverage of closed outlines (nonzero, as long as overlapping parts wind the same way; holes wind the
 * other way). `bounds` limits the region (a canvas, a clip).
 */
export function fillMask(contours: Pt[][], bounds: Rect): Mask | null {
  const box = pixelBox(contours, bounds);
  if (!box) return null;
  const { x: ox, y: oy, w, h } = box;
  const stride = w + 2;
  const acc = new Float32Array(stride * h + 2);
  const line = (ax: number, ay: number, bx: number, by: number) => {
    if (ay === by) return;
    let dir = 1;
    let x0 = ax - ox;
    let y0 = ay - oy;
    let x1 = bx - ox;
    let y1 = by - oy;
    if (y0 > y1) {
      dir = -1;
      [x0, y0, x1, y1] = [x1, y1, x0, y0];
    }
    // Left of the region the area all lands in its first column: clamping x keeps every pixel inside right.
    x0 = Math.min(w, Math.max(0, x0));
    x1 = Math.min(w, Math.max(0, x1));
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) x -= y0 * dxdy;
    const yStart = Math.max(0, Math.floor(y0));
    const yEnd = Math.min(h, Math.ceil(y1));
    for (let y = yStart; y < yEnd; y++) {
      const row = y * stride;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = Math.min(x, xnext);
      const xb = Math.max(x, xnext);
      const xaFloor = Math.floor(xa);
      const xai = xaFloor;
      const xbCeil = Math.ceil(xb);
      const xbi = xbCeil;
      if (xbi <= xai + 1) {
        const xmf = 0.5 * (x + xnext) - xaFloor;
        acc[row + xai] = acc[row + xai]! + d - d * xmf;
        acc[row + xai + 1] = acc[row + xai + 1]! + d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const xaf = xa - xaFloor;
        const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
        const xbf = xb - xbCeil + 1;
        const am = 0.5 * s * xbf * xbf;
        acc[row + xai] = acc[row + xai]! + d * a0;
        if (xbi === xai + 2) acc[row + xai + 1] = acc[row + xai + 1]! + d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - xaf);
          acc[row + xai + 1] = acc[row + xai + 1]! + d * (a1 - a0);
          for (let xi = xai + 2; xi < xbi - 1; xi++) acc[row + xi] = acc[row + xi]! + d * s;
          const a2 = a1 + (xbi - xai - 3) * s;
          acc[row + xbi - 1] = acc[row + xbi - 1]! + d * (1 - a2 - am);
        }
        acc[row + xbi] = acc[row + xbi]! + d * am;
      }
      x = xnext;
    }
  };
  for (const c of contours)
    for (let i = 0; i < c.length; i++) {
      const p = c[i]!;
      const q = c[(i + 1) % c.length]!;
      line(p[0], p[1], q[0], q[1]);
    }
  const a = new Float32Array(w * h);
  let any = false;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += acc[y * stride + x]!;
      const v = Math.min(1, Math.abs(sum));
      if (v > 0.001) {
        a[y * w + x] = v;
        any = true;
      }
    }
  }
  return any ? { x0: ox, y0: oy, w, h, a } : null;
}

const area = (c: Pt[]): number => {
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i]!;
    const q = c[(i + 1) % c.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
};
/** The same contour turning the given way (positive: clockwise on a y-down picture). */
export const wound = (c: Pt[], sign: 1 | -1): Pt[] => (Math.sign(area(c)) === sign || area(c) === 0 ? c : [...c].reverse());

/** A circle as a polygon. */
export function circle(cx: number, cy: number, r: number, sign: 1 | -1 = 1): Pt[] {
  const n = Math.max(8, Math.min(48, Math.ceil(r * 1.5)));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push([cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r]);
  return wound(out, sign);
}

/**
 * The band of width `2 * half` centred on closed outlines: a quad along each side and a disc at each turn
 * (round joins), all wound one way so where they overlap they stay covered.
 */
export function strokeOutline(contours: Pt[][], half: number, closed = true): Pt[][] {
  const out: Pt[][] = [];
  if (half <= 0) return out;
  for (const c of contours) {
    const n = c.length;
    if (n < 2) continue;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p = c[i]!;
      const q = c[(i + 1) % n]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-6) continue;
      const nx = (-(q[1] - p[1]) / len) * half;
      const ny = ((q[0] - p[0]) / len) * half;
      out.push(
        wound(
          [
            [p[0] + nx, p[1] + ny],
            [q[0] + nx, q[1] + ny],
            [q[0] - nx, q[1] - ny],
            [p[0] - nx, p[1] - ny],
          ],
          1,
        ),
      );
    }
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) {
        out.push(circle(c[i]![0], c[i]![1], half));
        continue;
      }
      // A disc only where the outline turns enough for the quads to leave a gap.
      const a = c[(i - 1 + n) % n]!;
      const b = c[i]!;
      const d = c[(i + 1) % n]!;
      const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const t2 = Math.atan2(d[1] - b[1], d[0] - b[0]);
      let turn = Math.abs(t2 - t1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn * half > 0.35) out.push(circle(b[0], b[1], half));
    }
  }
  return out;
}

/** A rounded rectangle (radii per corner: top left, top right, bottom right, bottom left), clockwise. */
export function roundedRect(x: number, y: number, w: number, h: number, radii: [number, number, number, number] = [0, 0, 0, 0]): Pt[] {
  const lim = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(lim, r))) as [number, number, number, number];
  const out: Pt[] = [];
  const arc = (cx: number, cy: number, r: number, from: number) => {
    const n = Math.max(3, Math.min(24, Math.ceil(r / 1.5)));
    for (let i = 0; i <= n; i++) {
      const t = from + (i / n) * (Math.PI / 2);
      out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
  };
  if (tl < 0.01) out.push([x, y]);
  else arc(x + tl, y + tl, tl, Math.PI);
  if (tr < 0.01) out.push([x + w, y]);
  else arc(x + w - tr, y + tr, tr, -Math.PI / 2);
  if (br < 0.01) out.push([x + w, y + h]);
  else arc(x + w - br, y + h - br, br, 0);
  if (bl < 0.01) out.push([x, y + h]);
  else arc(x + bl, y + h - bl, bl, Math.PI / 2);
  return out;
}

/** Coverage a × b where both are (null: nothing). */
export function maskTimes(m: Mask, other: Mask | null, invert = false): Mask {
  const a = new Float32Array(m.a.length);
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      let o = 0;
      if (other) {
        const ox = m.x0 + x - other.x0;
        const oy = m.y0 + y - other.y0;
        if (ox >= 0 && oy >= 0 && ox < other.w && oy < other.h) o = other.a[oy * other.w + ox]!;
      }
      a[i] = m.a[i]! * (invert ? 1 - o : o);
    }
  return { ...m, a };
}

/** A mask blurred like a gaussian of `sigma` pixels (three box blurs), grown to hold the blur, inside `bounds`. */
export function blurMask(m: Mask, sigma: number, bounds: Rect): Mask {
  const r = Math.max(1, Math.round(sigma));
  const pad = 3 * r;
  const w = m.w + 2 * pad;
  const h = m.h + 2 * pad;
  let buf = new Float32Array(w * h);
  for (let y = 0; y < m.h; y++) buf.set(m.a.subarray(y * m.w, (y + 1) * m.w), (y + pad) * w + pad);
  let tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++)
    for (const horizontal of [true, false]) {
      const n = horizontal ? w : h;
      const lines = horizontal ? h : w;
      for (let l = 0; l < lines; l++) {
        const at = (i: number) => (horizontal ? l * w + i : i * w + l);
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += i >= 0 && i < n ? buf[at(i)]! : 0;
        for (let i = 0; i < n; i++) {
          tmp[at(i)] = sum / (2 * r + 1);
          const add = i + r + 1;
          const drop = i - r;
          sum += (add < n ? buf[at(add)]! : 0) - (drop >= 0 ? buf[at(drop)]! : 0);
        }
      }
      [buf, tmp] = [tmp, buf];
    }
  // Cut to the bounds.
  const x0 = Math.max(m.x0 - pad, Math.floor(bounds.x));
  const y0 = Math.max(m.y0 - pad, Math.floor(bounds.y));
  const x1 = Math.min(m.x0 - pad + w, Math.ceil(bounds.x + bounds.w));
  const y1 = Math.min(m.y0 - pad + h, Math.ceil(bounds.y + bounds.h));
  const ow = Math.max(0, x1 - x0);
  const oh = Math.max(0, y1 - y0);
  const a = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) a[y * ow + x] = buf[(y0 + y - (m.y0 - pad)) * w + (x0 + x - (m.x0 - pad))]!;
  return { x0, y0, w: ow, h: oh, a };
}

/** A shifted copy of a mask. */
export const moveMask = (m: Mask, dx: number, dy: number): Mask => ({ ...m, x0: m.x0 + Math.round(dx), y0: m.y0 + Math.round(dy) });

export type Shader = (x: number, y: number, out: Float32Array) => void;

/**
 * Paints a mask: a solid colour with an alpha, or a shader writing [r, g, b, a] for a pixel centre. Pixels
 * outside `clip` (a rectangle in the picture) are left alone.
 */
export function paint(c: Raster, m: Mask, src: [number, number, number, number] | Shader, clip?: Rect | null): void {
  const px = new Float32Array(4);
  const solid = typeof src === 'function' ? null : src;
  const cx0 = clip ? Math.max(0, Math.floor(clip.x)) : 0;
  const cy0 = clip ? Math.max(0, Math.floor(clip.y)) : 0;
  const cx1 = clip ? Math.min(c.w, Math.ceil(clip.x + clip.w)) : c.w;
  const cy1 = clip ? Math.min(c.h, Math.ceil(clip.y + clip.h)) : c.h;
  for (let y = 0; y < m.h; y++) {
    const py = m.y0 + y;
    if (py < cy0 || py >= cy1) continue;
    for (let x = 0; x < m.w; x++) {
      const cov = m.a[y * m.w + x]!;
      if (cov <= 0.001) continue;
      const pxx = m.x0 + x;
      if (pxx < cx0 || pxx >= cx1) continue;
      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (solid) [r, g, b, a] = solid;
      else {
        (src as Shader)(pxx + 0.5, py + 0.5, px);
        [r, g, b, a] = [px[0]!, px[1]!, px[2]!, px[3]!];
      }
      const k = Math.max(0, Math.min(1, a * cov));
      if (k <= 0) continue;
      const i = (py * c.w + pxx) * 3;
      c.rgb[i] = c.rgb[i]! * (1 - k) + r * k;
      c.rgb[i + 1] = c.rgb[i + 1]! * (1 - k) + g * k;
      c.rgb[i + 2] = c.rgb[i + 2]! * (1 - k) + b * k;
    }
  }
}

// ─── Images ───────────────────────────────────────────────────────────────────────────────────────

interface Mips {
  levels: Array<{ w: number; h: number; data: Float32Array }>;
}
const mipCache = new WeakMap<RgbaImage, Mips>();

/** The image premultiplied, with halved copies for drawing it small. */
function mipsOf(img: RgbaImage): Mips {
  const hit = mipCache.get(img);
  if (hit) return hit;
  let w = img.width;
  let h = img.height;
  let data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    data[i * 4] = (img.data[i * 4]! / 255) * a;
    data[i * 4 + 1] = (img.data[i * 4 + 1]! / 255) * a;
    data[i * 4 + 2] = (img.data[i * 4 + 2]! / 255) * a;
    data[i * 4 + 3] = a;
  }
  const levels = [{ w, h, data }];
  while (w > 2 && h > 2) {
    const nw = w >> 1;
    const nh = h >> 1;
    const next = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++)
        for (let k = 0; k < 4; k++) next[(y * nw + x) * 4 + k] = (data[(2 * y * w + 2 * x) * 4 + k]! + data[(2 * y * w + 2 * x + 1) * 4 + k]! + data[((2 * y + 1) * w + 2 * x) * 4 + k]! + data[((2 * y + 1) * w + 2 * x + 1) * 4 + k]!) / 4;
    levels.push({ w: nw, h: nh, data: next });
    w = nw;
    h = nh;
    data = next;
  }
  const mips = { levels };
  mipCache.set(img, mips);
  return mips;
}

/**
 * A sampler for an image drawn `scale` image pixels per picture pixel: (u, v) in 0..1 of the image → straight
 * (not premultiplied) [r, g, b, a], bilinear on the right level, clamped at the edges.
 */
export function sampler(img: RgbaImage, scale: number): (u: number, v: number, out: Float32Array) => void {
  const mips = mipsOf(img);
  const level = mips.levels[Math.max(0, Math.min(mips.levels.length - 1, Math.floor(Math.log2(Math.max(1, scale)))))]!;
  const { w, h, data } = level;
  return (u, v, out) => {
    const fx = Math.min(w - 1, Math.max(0, u * w - 0.5));
    const fy = Math.min(h - 1, Math.max(0, v * h - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const f00 = (1 - tx) * (1 - ty);
    const f10 = tx * (1 - ty);
    const f01 = (1 - tx) * ty;
    const f11 = tx * ty;
    const i00 = (y0 * w + x0) * 4;
    const i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4;
    const i11 = (y1 * w + x1) * 4;
    const a = data[i00 + 3]! * f00 + data[i10 + 3]! * f10 + data[i01 + 3]! * f01 + data[i11 + 3]! * f11;
    for (let k = 0; k < 3; k++) {
      const pre = data[i00 + k]! * f00 + data[i10 + k]! * f10 + data[i01 + k]! * f01 + data[i11 + k]! * f11;
      out[k] = a > 1e-6 ? pre / a : 0;
    }
    out[3] = a;
  };
}

/** The picture as 8-bit RGBA. */
export function toRgba(c: Raster): RgbaImage {
  const data = new Uint8Array(c.w * c.h * 4);
  for (let i = 0; i < c.w * c.h; i++) {
    data[i * 4] = Math.round(Math.max(0, Math.min(1, c.rgb[i * 3]!)) * 255);
    data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, c.rgb[i * 3 + 1]!)) * 255);
    data[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, c.rgb[i * 3 + 2]!)) * 255);
    data[i * 4 + 3] = 255;
  }
  return { width: c.w, height: c.h, data };
}

// ─── Labels in a tiny pixel font (rulers and captions when no system font is there) ───────────────

const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
  '5': '111100111001111', '6': '111100111101111', '7': '111001001001001', '8': '111101111101111', '9': '111101111001111',
  '.': '000000000000010', ' ': '000000000000000', '×': '000101010101000', ',': '000000000010100', '-': '000000111000000',
};

/** Small numbers in a 3×5 pixel font (`scale` pixels per dot). */
export function pixelText(c: Raster, text: string, x0: number, y0: number, color: [number, number, number], scale = 1): void {
  [...text].forEach((ch, n) => {
    const g = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let i = 0; i < 15; i++)
      if (g[i] === '1')
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const x = x0 + (n * 4 + (i % 3)) * scale + dx;
            const y = y0 + Math.floor(i / 3) * scale + dy;
            if (x >= 0 && y >= 0 && x < c.w && y < c.h) c.rgb.set(color, (y * c.w + x) * 3);
          }
  });
}
