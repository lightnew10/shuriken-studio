import { encodePng, type RgbaImage } from '../../modeling/png';

/**
 * A float RGBA image for drawing VFX textures, kept PREMULTIPLIED (colour already multiplied by alpha):
 * blurring, compositing and averaging premultiplied values never pulls the black of transparent pixels
 * into an edge. Writing the PNG unpremultiplies and then BLEEDS colour outward into the transparent
 * texels, so the GPU's bilinear filtering and mipmaps (which mix a texel with its transparent neighbours)
 * find the edge's own colour there instead of black — the dark fringe that turned a light smoke texture
 * into a dark blob. Colour is linear while drawing and sRGB in the file.
 */
export class Raster {
  readonly data: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Float32Array(w * h * 4);
  }

  /** Composites a straight-alpha colour over the pixel ("over", premultiplied). */
  over(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const k = 1 - a;
    d[i] = r * a + d[i]! * k;
    d[i + 1] = g * a + d[i + 1]! * k;
    d[i + 2] = b * a + d[i + 2]! * k;
    d[i + 3] = a + d[i + 3]! * k;
  }

  /** Adds light (glows on glows): colour adds, alpha combines like "screen". */
  add(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    d[i] = Math.min(1, d[i]! + r * a);
    d[i + 1] = Math.min(1, d[i + 1]! + g * a);
    d[i + 2] = Math.min(1, d[i + 2]! + b * a);
    d[i + 3] = Math.min(1, d[i + 3]! + a - d[i + 3]! * a);
  }

  /** Sets a straight-alpha colour (stored premultiplied). */
  set(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const i = (y * this.w + x) * 4;
    this.data[i] = r * a;
    this.data[i + 1] = g * a;
    this.data[i + 2] = b * a;
    this.data[i + 3] = a;
  }

  alpha(x: number, y: number): number {
    return this.data[(y * this.w + x) * 4 + 3]!;
  }

  /**
   * Fills a cell (or the whole image) from a function of (u, v) in 0..1 across the cell, returning a
   * straight-alpha [r, g, b, a]; `ss` samples per pixel side (antialiasing).
   */
  paint(fn: (u: number, v: number) => [number, number, number, number], cell?: { x: number; y: number; w: number; h: number }, ss = 1): void {
    const c = cell ?? { x: 0, y: 0, w: this.w, h: this.h };
    for (let py = 0; py < c.h; py++) {
      for (let px = 0; px < c.w; px++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < ss; sy++)
          for (let sx = 0; sx < ss; sx++) {
            const [cr, cg, cb, ca] = fn((px + (sx + 0.5) / ss) / c.w, (py + (sy + 0.5) / ss) / c.h);
            const al = Math.min(1, Math.max(0, ca));
            r += cr * al;
            g += cg * al;
            b += cb * al;
            a += al;
          }
        const n = ss * ss;
        const i = ((c.y + py) * this.w + c.x + px) * 4;
        this.data[i] = r / n;
        this.data[i + 1] = g / n;
        this.data[i + 2] = b / n;
        this.data[i + 3] = a / n;
      }
    }
  }

  /** Separable box blur (premultiplied, so edges stay clean), `passes` times ≈ a gaussian. */
  blur(radius: number, passes = 2, cell?: { x: number; y: number; w: number; h: number }): void {
    const r = Math.max(0, Math.round(radius));
    if (!r) return;
    const c = cell ?? { x: 0, y: 0, w: this.w, h: this.h };
    const line = new Float32Array(Math.max(c.w, c.h) * 4);
    for (let p = 0; p < passes; p++) {
      for (const horizontal of [true, false]) {
        const n = horizontal ? c.w : c.h;
        const lines = horizontal ? c.h : c.w;
        for (let l = 0; l < lines; l++) {
          const idx = (k: number) => (horizontal ? ((c.y + l) * this.w + c.x + k) * 4 : ((c.y + k) * this.w + c.x + l) * 4);
          for (let k = 0; k < n; k++) for (let ch = 0; ch < 4; ch++) line[k * 4 + ch] = this.data[idx(k) + ch]!;
          for (let k = 0; k < n; k++) {
            const sum = [0, 0, 0, 0];
            let count = 0;
            for (let j = k - r; j <= k + r; j++) {
              if (j < 0 || j >= n) continue;
              for (let ch = 0; ch < 4; ch++) sum[ch]! += line[j * 4 + ch]!;
              count++;
            }
            for (let ch = 0; ch < 4; ch++) this.data[idx(k) + ch] = sum[ch]! / count;
          }
        }
      }
    }
  }

  /** Multiplies alpha (and premultiplied colour) by a factor per pixel. */
  mask(fn: (x: number, y: number) => number): void {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const k = Math.min(1, Math.max(0, fn(x, y)));
        const i = (y * this.w + x) * 4;
        for (let ch = 0; ch < 4; ch++) this.data[i + ch]! *= k;
      }
  }

  /**
   * The 8-bit straight-alpha image: unpremultiplied, colour bled into transparent texels (within each
   * flipbook cell when `grid` > 1, so frames never take a neighbour's colour), sRGB-encoded.
   */
  toImage(grid = 1): RgbaImage {
    const { w, h } = this;
    const out = new Uint8Array(w * h * 4);
    const rgb = new Float32Array(w * h * 3);
    const known = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const a = this.data[p * 4 + 3]!;
      if (a > 1 / 512) {
        for (let ch = 0; ch < 3; ch++) rgb[p * 3 + ch] = Math.min(1, this.data[p * 4 + ch]! / a);
        known[p] = 1;
      }
    }
    // Bleed: each pass gives unknown texels the mean colour of their known neighbours (same cell).
    const cw = Math.floor(w / grid);
    const chh = Math.floor(h / grid);
    const cellOf = (x: number, y: number) => Math.min(grid - 1, Math.floor(x / cw)) + Math.min(grid - 1, Math.floor(y / chh)) * grid;
    let frontier = true;
    for (let pass = 0; pass < 24 && frontier; pass++) {
      frontier = false;
      const next: Array<[number, number, number, number]> = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (known[p]) continue;
          const cell = cellOf(x, y);
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h || cellOf(nx, ny) !== cell) continue;
              const q = ny * w + nx;
              if (!known[q]) continue;
              r += rgb[q * 3]!;
              g += rgb[q * 3 + 1]!;
              b += rgb[q * 3 + 2]!;
              n++;
            }
          if (n) next.push([p, r / n, g / n, b / n]);
        }
      for (const [p, r, g, b] of next) {
        rgb[p * 3] = r;
        rgb[p * 3 + 1] = g;
        rgb[p * 3 + 2] = b;
        known[p] = 1;
        frontier = true;
      }
    }
    // Whatever the bleed didn't reach takes the image's mean visible colour (never black).
    let mr = 0;
    let mg = 0;
    let mb = 0;
    let ma = 0;
    for (let p = 0; p < w * h; p++) {
      const a = this.data[p * 4 + 3]!;
      mr += this.data[p * 4]!;
      mg += this.data[p * 4 + 1]!;
      mb += this.data[p * 4 + 2]!;
      ma += a;
    }
    const mean = ma > 0 ? [mr / ma, mg / ma, mb / ma] : [1, 1, 1];
    const srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    for (let p = 0; p < w * h; p++) {
      for (let ch = 0; ch < 3; ch++) out[p * 4 + ch] = srgb(Math.min(1, Math.max(0, known[p] ? rgb[p * 3 + ch]! : mean[ch]!)));
      out[p * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, this.data[p * 4 + 3]!)));
    }
    return { width: w, height: h, data: out };
  }

  toPng(grid = 1): Buffer {
    return encodePng(this.toImage(grid));
  }
}

// ─── Noise ────────────────────────────────────────────────────────────────────

/** A seeded random stream (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Improved Perlin noise in 3D (seeded), about -1..1. */
export function perlin3(seed: number): (x: number, y: number, z: number) => number {
  const r = rng(seed);
  const p = new Uint8Array(512);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255]!;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const grad = (h: number, x: number, y: number, z: number) => {
    const hh = h & 15;
    const u = hh < 8 ? x : y;
    const v = hh < 4 ? y : hh === 12 || hh === 14 ? x : z;
    return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? v : -v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = p[X]! + Y;
    const AA = p[A]! + Z;
    const AB = p[A + 1]! + Z;
    const B = p[X + 1]! + Y;
    const BA = p[B]! + Z;
    const BB = p[B + 1]! + Z;
    return lerp(
      lerp(lerp(grad(p[AA]!, x, y, z), grad(p[BA]!, x - 1, y, z), u), lerp(grad(p[AB]!, x, y - 1, z), grad(p[BB]!, x - 1, y - 1, z), u), v),
      lerp(lerp(grad(p[AA + 1]!, x, y, z - 1), grad(p[BA + 1]!, x - 1, y, z - 1), u), lerp(grad(p[AB + 1]!, x, y - 1, z - 1), grad(p[BB + 1]!, x - 1, y - 1, z - 1), u), v),
      w,
    );
  };
}

/** Fractal noise: `octaves` of Perlin, each twice the frequency and half the weight. About -1..1. */
export function fbm3(noise: (x: number, y: number, z: number) => number, x: number, y: number, z: number, octaves = 4, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq, z * freq + i * 17.1) * amp;
    norm += amp;
    amp *= gain;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Cellular (Worley) distance to the nearest of seeded feature points, 0 at a point; `scale` cells across 0..1. */
export function worley(seed: number, scale: number): (u: number, v: number) => number {
  const hash = (i: number, j: number) => {
    const r = rng((i * 73856093) ^ (j * 19349663) ^ seed);
    return [r(), r()];
  };
  return (u, v) => {
    const x = u * scale;
    const y = v * scale;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let best = 9;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const [ox, oy] = hash(ix + dx, iy + dy);
        const d = Math.hypot(ix + dx + ox! - x, iy + dy + oy! - y);
        if (d < best) best = d;
      }
    return best;
  };
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smoothstep = (e0: number, e1: number, v: number) => {
  const t = clamp01((v - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
