import { decodePng, type RgbaImage } from '../modeling/png';
import { decodeJpeg, isJpeg } from './jpeg-decode';

/**
 * Look analysis: what an art director checks on a screenshot, as measurements, for agents that can't see
 * Studio (a hidden or sleeping screen) or whose own eyes passed a monochrome, washed-out frame. Like the
 * audio engine's analysis tells a sound designer what it hears, this says what the picture measures as and
 * which numbers point at a likely problem. It never judges beauty: the thresholds are conventions of
 * readable game images (noted where they are), and every finding is a measurement and a suggestion.
 *
 * Values are CIE L* (0 black … 100 white, perceptually even: "value" as painters use it); colour is CIE
 * Lab (D65) from sRGB; chroma is C* = √(a²+b²). The image is analysed at about 320 px wide (the busy work),
 * exposure and clipping at full size.
 */

export type LookView = 'gameplay' | 'overview' | 'ui';
export type LookMood = 'day' | 'golden' | 'dusk' | 'night' | 'interior' | 'overcast' | 'stylized';

export interface LookRegion {
  name: string;
  /** Fractions of the frame: [x0, y0, x1, y1], top left is 0,0. */
  box: [number, number, number, number];
}

export interface LookOptions {
  /** gameplay (default): a camera at play height; overview: looking down at an area; ui: a screen of UI. */
  view?: LookView;
  /** The intended mood, so a night scene isn't called underexposed and a sunset not "warm cast". */
  mood?: LookMood;
  /** Parts of the frame to measure against their surroundings (a mech at 250 studs, a door, a pickup). */
  regions?: LookRegion[];
}

export interface LookAnalysis {
  width: number;
  height: number;
  /** One flat colour: Studio wasn't drawing, or the camera is inside a part. */
  blank: boolean;
  exposure: {
    meanL: number;
    p1: number;
    p5: number;
    p50: number;
    p95: number;
    p99: number;
    /** % of pixels at L* ≥ 97 (blown to white). */
    clipped: number;
    /** % of the frame below the horizon that is clipped (objects and ground, not the sky). */
    clippedBelow: number;
    /** % of pixels at L* ≤ 3 (crushed to black). */
    crushed: number;
    key: 'low' | 'mid' | 'high';
    /** % of pixels per L* decile, 0-10 … 90-100. */
    histogram: number[];
  };
  contrast: { range: number; std: number };
  values: { groups: { L: number; share: number }[]; separation: number };
  colour: {
    meanChroma: number;
    p90Chroma: number;
    /** % of pixels with C* > 70 (loud). */
    loud: number;
    /** 30° hue families needed to hold 80% of the colour (chroma-weighted). */
    families: number;
    dominant: { name: string; share: number } | null;
    castA: number;
    castB: number;
    /** Correlated colour temperature of the average light in the frame (McCamy), K. */
    kelvin: number | null;
    shadowsB: number | null;
    highlightsB: number | null;
    palette: { hex: string; share: number }[];
  };
  /** The strongest horizontal boundary (y: fraction from the top; strength: ΔE across it). */
  horizon: { y: number; strength: number } | null;
  /**
   * Contrast (std of L*) in a band under the horizon (far) and at the bottom (near); the far band's ΔE from the sky;
   * the ground (below the horizon) against the background (sky and the far band) and the ground's mean chroma.
   */
  depth: { near: number; far: number; ratio: number; farToSky: number | null; groundToBack: number; groundToBackL: number; groundChroma: number } | null;
  balance: { x: number; y: number; peak: [number, number] };
  /** edges: % of pixels on a visible boundary at 320 px; noise: fine texture (see fineNoise), whole frame and play area. */
  detail: { edges: number; edgesPlay: number; noise: number; noisePlay: number };
  regions: { name: string; L: number; surroundL: number; dL: number; dE: number }[];
}

// ─── Colour ────────────────────────────────────────────────────────────────

const LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();
const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const Lstar = (Y: number) => 116 * fLab(Y) - 16;

function lab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r]!;
  const G = LIN[g]!;
  const B = LIN[b]!;
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fLab(X);
  const fy = fLab(Y);
  const fz = fLab(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToHex(L: number, a: number, b: number): string {
  const fy = (L + 16) / 116;
  const inv = (f: number) => (f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27));
  const X = inv(fy + a / 500) * 0.95047;
  const Y = inv(fy);
  const Z = inv(fy - b / 200) * 1.08883;
  const lin = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
  return `#${lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0')).join('')}`;
}

/** Colour families by CIE Lab hue angle (sRGB red sits near 40°, yellow 102°, green 136°, cyan 196°, blue 306°). */
function hueName(h: number): string {
  if (h < 25 || h >= 345) return 'pink-red';
  if (h < 50) return 'red';
  if (h < 80) return 'orange';
  if (h < 115) return 'yellow';
  if (h < 165) return 'green';
  if (h < 225) return 'teal';
  if (h < 315) return 'blue';
  return 'purple';
}

// ─── Decoding ──────────────────────────────────────────────────────────────

/** A screenshot from bytes: Studio's JPEGs, or a PNG (Kiln renders, the viewer). */
export function decodeImage(buf: Uint8Array): RgbaImage {
  if (isJpeg(buf)) return decodeJpeg(buf);
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePng(buf);
  throw new Error('not a JPEG or PNG image');
}

/** Box-filtered copy at most `max` px wide (never enlarged). */
function shrink(img: RgbaImage, max: number): RgbaImage {
  const s = Math.max(1, img.width / max);
  if (s <= 1) return img;
  const w = Math.max(1, Math.round(img.width / s));
  const h = Math.max(1, Math.round(img.height / s));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          r += img.data[o]!;
          g += img.data[o + 1]!;
          b += img.data[o + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
function quantile(sorted: Float32Array | number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)))]!;
}
function meanStd(v: ArrayLike<number>, idx: number[]): { mean: number; std: number } {
  if (!idx.length) return { mean: 0, std: 0 };
  let s = 0;
  for (const i of idx) s += v[i]!;
  const mean = s / idx.length;
  let q = 0;
  for (const i of idx) q += (v[i]! - mean) ** 2;
  return { mean, std: Math.sqrt(q / idx.length) };
}

/** k-means on rows of `dims` numbers (deterministic: seeds spread through the data sorted by the first dim). */
function kmeans(points: Float32Array, dims: number, k: number, iters = 10): { centers: number[][]; counts: number[] } {
  const n = points.length / dims;
  const order = [...Array(n).keys()].sort((a, b) => points[a * dims]! - points[b * dims]!);
  const centers = Array.from({ length: k }, (_, j) => {
    const p = order[Math.min(n - 1, Math.floor(((j + 0.5) / k) * n))]!;
    return Array.from({ length: dims }, (_, d) => points[p * dims + d]!);
  });
  const assign = new Int32Array(n);
  const counts = new Array<number>(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const sums = centers.map(() => new Array<number>(dims).fill(0));
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        let dd = 0;
        for (let d = 0; d < dims; d++) dd += (points[i * dims + d]! - centers[j]![d]!) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = j;
        }
      }
      assign[i] = best;
      counts[best]!++;
      for (let d = 0; d < dims; d++) sums[best]![d]! += points[i * dims + d]!;
    }
    for (let j = 0; j < k; j++) if (counts[j]) centers[j] = sums[j]!.map((s) => s / counts[j]!);
  }
  return { centers, counts };
}

// ─── Analysis ──────────────────────────────────────────────────────────────

export function analyzeLook(img: RgbaImage, o: LookOptions = {}): LookAnalysis {
  const view = o.view ?? 'gameplay';
  // Full size: the L* histogram, clipping and crushing (a few blown pixels vanish in a shrunk copy).
  const hist = new Float64Array(101);
  const total = img.width * img.height;
  const fullL = new Uint8Array(total);
  for (let i = 0, o4 = 0; i < total; i++, o4 += 4) {
    const Y = 0.2126 * LIN[img.data[o4]!]! + 0.7152 * LIN[img.data[o4 + 1]!]! + 0.0722 * LIN[img.data[o4 + 2]!]!;
    const L = Math.max(0, Math.min(100, Math.round(Lstar(Y))));
    fullL[i] = L;
    hist[L]!++;
  }
  const qL = (q: number) => {
    let acc = 0;
    for (let L = 0; L <= 100; L++) {
      acc += hist[L]!;
      if (acc >= q * total) return L;
    }
    return 100;
  };
  let sumL = 0;
  for (let L = 0; L <= 100; L++) sumL += L * hist[L]!;
  let clipped = 0;
  let crushed = 0;
  for (let L = 97; L <= 100; L++) clipped += hist[L]!;
  for (let L = 0; L <= 3; L++) crushed += hist[L]!;
  const deciles = new Array<number>(10).fill(0);
  for (let L = 0; L <= 100; L++) deciles[Math.min(9, Math.floor(L / 10))]! += hist[L]!;

  // Working copy: Lab per pixel.
  const s = shrink(img, 320);
  const W = s.width;
  const H = s.height;
  const N = W * H;
  const Lv = new Float32Array(N);
  const Av = new Float32Array(N);
  const Bv = new Float32Array(N);
  const C = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const [L, a, b] = lab(s.data[i * 4]!, s.data[i * 4 + 1]!, s.data[i * 4 + 2]!);
    Lv[i] = L;
    Av[i] = a;
    Bv[i] = b;
    C[i] = Math.hypot(a, b);
  }
  const all = [...Array(N).keys()];
  const { mean: meanL, std: stdL } = meanStd(Lv, all);
  const p5 = qL(0.05);
  const p95 = qL(0.95);
  const blank = stdL < 1.5 && p95 - p5 < 4;

  // Value groups: three masses (dark, mid, light), as a painter squints at a frame.
  const vk = kmeans(Float32Array.from(Lv), 1, 3);
  const groups = vk.centers.map((c, j) => ({ L: c[0]!, share: vk.counts[j]! / N })).sort((a, b) => a.L - b.L);
  let within = 0;
  for (let i = 0; i < N; i++) within += Math.min(...groups.map((g) => (Lv[i]! - g.L) ** 2));
  const withinStd = Math.sqrt(within / N) || 1;
  // The widest gap between neighbouring groups (each over 5% of the frame) in units of the spread inside them:
  // two masses well apart read even when k-means splits one of them in two.
  const gaps = groups.slice(1).map((g, j) => (groups[j]!.share > 0.05 && g.share > 0.05 ? g.L - groups[j]!.L : 0));
  const separation = Math.max(0, ...gaps);

  // Colour: chroma, hue families, cast and temperature, palette.
  const sortedC = Float32Array.from(C).sort();
  let meanC = 0;
  let loud = 0;
  const hueW = new Float64Array(12);
  const hue10 = new Float64Array(36);
  let hueTotal = 0;
  for (let i = 0; i < N; i++) {
    meanC += C[i]!;
    if (C[i]! > 70) loud++;
    if (C[i]! > 8) {
      const h = ((Math.atan2(Bv[i]!, Av[i]!) * 180) / Math.PI + 360) % 360;
      hueW[Math.floor(h / 30) % 12]! += C[i]!;
      hue10[Math.floor(h / 10) % 36]! += C[i]!;
      hueTotal += C[i]!;
    }
  }
  meanC /= N;
  let families = 0;
  let dominant: LookAnalysis['colour']['dominant'] = null;
  if (hueTotal > 0) {
    const bins = [...hueW.keys()].sort((a, b) => hueW[b]! - hueW[a]!);
    let acc = 0;
    for (const bIdx of bins) {
      acc += hueW[bIdx]!;
      families++;
      if (acc >= 0.8 * hueTotal) break;
    }
    // The dominant family: the strongest 50° window of hue (sliding in 10° steps, so a hue on a bin edge isn't split),
    // named by its chroma-weighted mean hue.
    let best = 0;
    let bestW = -1;
    for (let b0 = 0; b0 < 36; b0++) {
      let w = 0;
      for (let k = 0; k < 5; k++) w += hue10[(b0 + k) % 36]!;
      if (w > bestW) {
        bestW = w;
        best = b0;
      }
    }
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < N; i++) {
      if (C[i]! <= 8) continue;
      const h = ((Math.atan2(Bv[i]!, Av[i]!) * 180) / Math.PI + 360) % 360;
      if ((Math.floor(h / 10) - best + 36) % 36 < 5) {
        sa += Av[i]!;
        sb += Bv[i]!;
      }
    }
    dominant = { name: hueName(((Math.atan2(sb, sa) * 180) / Math.PI + 360) % 360), share: Math.min(1, bestW / hueTotal) };
  }
  const mid = all.filter((i) => Lv[i]! >= 20 && Lv[i]! <= 95);
  const castA = meanStd(Av, mid).mean;
  const castB = meanStd(Bv, mid).mean;
  // Average light: mean linear RGB of the mid tones → xy → McCamy's CCT (meaningful near the Planckian locus).
  let kelvin: number | null = null;
  if (mid.length) {
    let R = 0;
    let G = 0;
    let B = 0;
    for (const i of mid) {
      R += LIN[s.data[i * 4]!]!;
      G += LIN[s.data[i * 4 + 1]!]!;
      B += LIN[s.data[i * 4 + 2]!]!;
    }
    const X = 0.4124 * R + 0.3576 * G + 0.1805 * B;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
    const sum = X + Y + Z;
    if (sum > 0) {
      const x = X / sum;
      const y = Y / sum;
      const n = (x - 0.332) / (0.1858 - y);
      const cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
      if (Number.isFinite(cct) && cct > 1000 && cct < 25000) kelvin = Math.round(cct / 100) * 100;
    }
  }
  const shadows = all.filter((i) => Lv[i]! > 3 && Lv[i]! < 35);
  const lights = all.filter((i) => Lv[i]! > 65 && Lv[i]! < 97);
  const pts = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pts[i * 3] = Lv[i]!;
    pts[i * 3 + 1] = Av[i]!;
    pts[i * 3 + 2] = Bv[i]!;
  }
  const pk = kmeans(pts, 3, 5, 8);
  const palette = pk.centers
    .map((c, j) => ({ hex: labToHex(c[0]!, c[1]!, c[2]!), share: pk.counts[j]! / N }))
    .filter((p) => p.share >= 0.02)
    .sort((a, b) => b.share - a.share);

  // Horizon: the strongest horizontal boundary (row means of Lab above against below), with its tilt.
  const rowMean = (x0: number, x1: number) => {
    const rows: [number, number, number][] = [];
    for (let y = 0; y < H; y++) {
      let l = 0;
      let a = 0;
      let b = 0;
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        l += Lv[i]!;
        a += Av[i]!;
        b += Bv[i]!;
      }
      const n = x1 - x0;
      rows.push([l / n, a / n, b / n]);
    }
    return rows;
  };
  const boundary = (rows: [number, number, number][], lo: number, hi: number) => {
    const win = Math.max(2, Math.round(H * 0.06));
    let best = -1;
    let bestD = 0;
    for (let y = Math.max(win, lo); y <= Math.min(H - win, hi); y++) {
      const m = (from: number, to: number) => {
        const acc = [0, 0, 0];
        for (let k = from; k < to; k++) for (let d = 0; d < 3; d++) acc[d]! += rows[k]![d]!;
        return acc.map((v) => v / (to - from));
      };
      const up = m(y - win, y);
      const dn = m(y, y + win);
      const dE = Math.hypot(up[0]! - dn[0]!, up[1]! - dn[1]!, up[2]! - dn[2]!);
      if (dE > bestD) {
        bestD = dE;
        best = y;
      }
    }
    return { y: best, dE: bestD };
  };
  // (No tilt: Studio's cameras don't roll, and in a cluttered frame the halves' strongest boundaries are
  // different objects, so a measured tilt was noise in 3 of 4 gameplay shots.)
  let horizon: LookAnalysis['horizon'] = null;
  if (view !== 'ui' && H >= 24) {
    const whole = boundary(rowMean(0, W), Math.round(H * 0.04), Math.round(H * 0.96));
    if (whole.y > 0 && whole.dE >= 6) horizon = { y: whole.y / H, strength: whole.dE };
  }

  // Depth: contrast (std of L*) in a far band just under the horizon against the near band at the bottom,
  // and how close the far band's colour is to the sky's (aerial perspective, or haze swallowing things).
  const band = (y0: number, y1: number) => {
    const idx: number[] = [];
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) for (let x = 0; x < W; x++) idx.push(y * W + x);
    return idx;
  };
  const labMean = (idx: number[]): [number, number, number] => [meanStd(Lv, idx).mean, meanStd(Av, idx).mean, meanStd(Bv, idx).mean];
  const dE = (p: [number, number, number], q: [number, number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  let depth: LookAnalysis['depth'] = null;
  if (view !== 'ui') {
    const hy = horizon && horizon.y > 0.08 && horizon.y < 0.8 ? horizon.y * H : null;
    const farIdx = hy !== null ? band(hy, hy + H * 0.12) : band(0, H * 0.3);
    const nearIdx = band(H * 0.75, H);
    const skyIdx = hy !== null ? band(0, hy - H * 0.02) : [];
    const groundIdx = hy !== null ? band(hy, H) : band(H * 0.35, H);
    const backIdx = hy !== null ? band(0, hy + H * 0.06) : band(0, H * 0.2);
    const far = meanStd(Lv, farIdx).std;
    const near = meanStd(Lv, nearIdx).std;
    const ground = labMean(groundIdx);
    const back = labMean(backIdx);
    depth = {
      near,
      far,
      ratio: near > 0.5 ? far / near : 1,
      farToSky: skyIdx.length ? dE(labMean(farIdx), labMean(skyIdx)) : null,
      groundToBack: dE(ground, back),
      groundToBackL: ground[0] - back[0],
      groundChroma: meanStd(C, groundIdx).mean,
    };
  }

  // Edges (structure, clutter) on the working copy; noise: fine texture at twice the resolution.
  const grad = new Float32Array(N);
  let edges = 0;
  let edgesPlay = 0;
  let playN = 0;
  const playTop = horizon ? Math.floor(horizon.y * H) : Math.floor(H * 0.3);
  const EDGE = 6; // L* per pixel at 320 px wide: a visible boundary, not texture grain
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = Lv[i - W + 1]! + 2 * Lv[i + 1]! + Lv[i + W + 1]! - Lv[i - W - 1]! - 2 * Lv[i - 1]! - Lv[i + W - 1]!;
      const gy = Lv[i + W - 1]! + 2 * Lv[i + W]! + Lv[i + W + 1]! - Lv[i - W - 1]! - 2 * Lv[i - W]! - Lv[i - W + 1]!;
      const g = Math.hypot(gx, gy) / 8;
      grad[i] = g;
      const e = g > EDGE ? 1 : 0;
      edges += e;
      if (y >= playTop) {
        edgesPlay += e;
        playN++;
      }
    }
  }
  const noise = fineNoise(img, horizon ? horizon.y : view === 'ui' ? 0 : 0.3);

  // Visual weight: local contrast + colour + distance from the mean value; its centre and its peak.
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  const cells = new Float64Array(36);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const w = grad[i]! + 0.25 * C[i]! + 0.25 * Math.abs(Lv[i]! - meanL);
      wx += w * (x + 0.5);
      wy += w * (y + 0.5);
      wsum += w;
      cells[Math.min(5, Math.floor((y / H) * 6)) * 6 + Math.min(5, Math.floor((x / W) * 6))]! += w;
    }
  }
  let peakCell = 0;
  for (let c = 1; c < 36; c++) if (cells[c]! > cells[peakCell]!) peakCell = c;

  // Regions against their surroundings (a ring as wide as half the region on every side).
  const regions = (o.regions ?? []).map((r) => {
    const [x0, y0, x1, y1] = r.box.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number];
    const inside: number[] = [];
    const ring: number[] = [];
    const mx = (x1 - x0) / 2;
    const my = (y1 - y0) / 2;
    for (let y = Math.floor(Math.max(0, y0 - my) * H); y < Math.ceil(Math.min(1, y1 + my) * H); y++) {
      for (let x = Math.floor(Math.max(0, x0 - mx) * W); x < Math.ceil(Math.min(1, x1 + mx) * W); x++) {
        const fx = (x + 0.5) / W;
        const fy = (y + 0.5) / H;
        (fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1 ? inside : ring).push(y * W + x);
      }
    }
    const a = labMean(inside);
    const b = labMean(ring);
    return { name: r.name, L: r1(a[0]), surroundL: r1(b[0]), dL: r1(a[0] - b[0]), dE: r1(inside.length && ring.length ? dE(a, b) : 0) };
  });

  // Clipping below the horizon (objects, ground), so a bright sky isn't counted against the scene.
  let clippedBelow = 0;
  if (horizon) {
    const from = Math.floor(horizon.y * img.height) * img.width;
    let n = 0;
    for (let i = from; i < total; i++, n++) if (fullL[i]! >= 97) clippedBelow++;
    clippedBelow = n ? (clippedBelow / n) * 100 : 0;
  }

  const p50 = qL(0.5);
  return {
    width: img.width,
    height: img.height,
    blank,
    exposure: {
      meanL: r1(sumL / total),
      p1: qL(0.01),
      p5,
      p50,
      p95,
      p99: qL(0.99),
      clipped: r1((clipped / total) * 100),
      clippedBelow: r1(clippedBelow),
      crushed: r1((crushed / total) * 100),
      key: p50 < 35 ? 'low' : p50 > 68 ? 'high' : 'mid',
      histogram: deciles.map((v) => r0((v / total) * 100)),
    },
    contrast: { range: p95 - p5, std: r1(stdL) },
    values: { groups: groups.map((g) => ({ L: r0(g.L), share: r2(g.share) })), separation: Number.isFinite(separation) ? r1(separation / withinStd) : 0 },
    colour: {
      meanChroma: r1(meanC),
      p90Chroma: r1(quantile(sortedC, 0.9)),
      loud: r1((loud / N) * 100),
      families,
      dominant: dominant ? { name: dominant.name, share: r2(dominant.share) } : null,
      castA: r1(castA),
      castB: r1(castB),
      kelvin,
      shadowsB: shadows.length > N * 0.03 ? r1(meanStd(Bv, shadows).mean) : null,
      highlightsB: lights.length > N * 0.03 ? r1(meanStd(Bv, lights).mean) : null,
      palette: palette.map((p) => ({ hex: p.hex, share: r2(p.share) })),
    },
    horizon: horizon ? { y: r2(horizon.y), strength: r1(horizon.strength) } : null,
    depth: depth
      ? { near: r1(depth.near), far: r1(depth.far), ratio: r2(depth.ratio), farToSky: depth.farToSky === null ? null : r1(depth.farToSky), groundToBack: r1(depth.groundToBack), groundToBackL: r1(depth.groundToBackL), groundChroma: r1(depth.groundChroma) }
      : null,
    balance: { x: r2(wsum ? wx / wsum / W - 0.5 : 0), y: r2(wsum ? wy / wsum / H - 0.5 : 0), peak: [r2(((peakCell % 6) + 0.5) / 6), r2((Math.floor(peakCell / 6) + 0.5) / 6)] },
    detail: { edges: r1(W > 2 && H > 2 ? (edges / ((W - 2) * (H - 2))) * 100 : 0), edgesPlay: r1(playN ? (edgesPlay / playN) * 100 : 0), noise: r1(noise.all), noisePlay: r1(noise.play) },
    regions,
  };
}

/**
 * Fine texture: the mean absolute difference of L* from its 3×3 neighbourhood mean at about 960 px wide, over the
 * frame and over the part below `playTop` (a fraction of the height). Measured on Studio screenshots: a baseplate
 * 0.4, stylized or calm realistic scenes 0.9-1.6, a road of speckled asphalt 3.0 (4.7 on the road itself).
 */
function fineNoise(img: RgbaImage, playTop: number): { all: number; play: number } {
  const s = shrink(img, 960);
  const W = s.width;
  const H = s.height;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = Lstar(0.2126 * LIN[s.data[i * 4]!]! + 0.7152 * LIN[s.data[i * 4 + 1]!]! + 0.0722 * LIN[s.data[i * 4 + 2]!]!);
  let sum = 0;
  let n = 0;
  let playSum = 0;
  let playN = 0;
  const top = Math.floor(playTop * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += L[i + dy * W + dx]!;
      const r = Math.abs(L[i]! - m / 9);
      sum += r;
      n++;
      if (y >= top) {
        playSum += r;
        playN++;
      }
    }
  }
  return { all: n ? sum / n : 0, play: playN ? playSum / playN : 0 };
}

// ─── Findings ──────────────────────────────────────────────────────────────

const pct = (n: number) => `${r0(n)}%`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${r1(n)}`;
const where = (x: number, y: number) => `${y < 0.34 ? 'top' : y > 0.66 ? 'bottom' : 'middle'} ${x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'centre'}`;

/**
 * One compact line of what the picture measures as, and the likely problems with what to change (Roblox terms).
 * Thresholds are conventions for readable game frames, not laws; a stated mood moves them.
 */
export function critiqueLook(a: LookAnalysis, o: LookOptions = {}): { seen: string; problems: string[] } {
  const view = o.view ?? 'gameplay';
  const mood = o.mood;
  const dark = mood === 'night' || mood === 'interior';
  const warmMood = mood === 'golden' || mood === 'dusk';
  const e = a.exposure;
  const c = a.colour;
  if (a.blank) {
    return { seen: `one flat colour (L* ${e.p50}): nothing to measure`, problems: ["The picture is one flat colour: Studio wasn't drawing, the camera is inside a part, or the view is covered. Take it again (another camera position); don't judge the look from it."] };
  }
  const scene = view !== 'ui';
  // A horizon the depth and readability checks can lean on: some sky above, some ground below.
  const horizon = scene && a.horizon && a.horizon.y > 0.1 && a.horizon.y < 0.7 ? a.horizon : null;
  const cast = Math.hypot(c.castA, c.castB);
  const castHue = ((Math.atan2(c.castB, c.castA) * 180) / Math.PI + 360) % 360;
  const castName = castHue >= 30 && castHue < 110 ? 'warm (orange-yellow)' : castHue >= 110 && castHue < 200 ? 'green' : castHue >= 200 && castHue < 320 ? 'cool (blue)' : 'magenta-red';

  const parts: string[] = [];
  parts.push(`${e.key}-key: L* median ${e.p50} (5-95%: ${e.p5}-${e.p95}), clipped ${e.clipped}%${a.horizon ? ` (${e.clippedBelow}% below the horizon)` : ''}, crushed ${e.crushed}%`);
  parts.push(`values ${a.values.groups.map((g) => `${pct(g.share * 100)}@${g.L}`).join(' / ')} (separation ${a.values.separation})`);
  parts.push(
    `colour: chroma ${c.meanChroma} (p90 ${c.p90Chroma}), ${c.families} hue famil${c.families === 1 ? 'y holds' : 'ies hold'} 80%${c.dominant ? `, ${c.dominant.name} ${pct(c.dominant.share * 100)}` : ''}; cast a*${signed(c.castA)} b*${signed(c.castB)}${c.kelvin ? ` (≈${c.kelvin} K)` : ''}${c.shadowsB !== null && c.highlightsB !== null ? `, shadows b*${signed(c.shadowsB)} / lights b*${signed(c.highlightsB)}` : ''}`,
  );
  parts.push(`palette ${c.palette.map((p) => `${p.hex} ${pct(p.share * 100)}`).join(', ')}`);
  if (scene) parts.push(a.horizon ? `horizon ${pct(a.horizon.y * 100)} from the top` : 'no clear horizon');
  if (a.depth) parts.push(`depth: far contrast ${pct(a.depth.ratio * 100)} of near${a.depth.farToSky !== null ? `, far band ΔE ${a.depth.farToSky} from the sky` : ''}; ground vs background ΔE ${a.depth.groundToBack} (ΔL* ${signed(a.depth.groundToBackL)}), ground chroma ${a.depth.groundChroma}`);
  parts.push(`detail: edges ${a.detail.edges}%${scene ? ` (play area ${a.detail.edgesPlay}%)` : ''}, fine texture ${a.detail.noise}${scene ? ` (play area ${a.detail.noisePlay})` : ''}`);
  parts.push(`weight centre ${signed(a.balance.x * 100)}% x, ${signed(a.balance.y * 100)}% y, strongest at ${where(a.balance.peak[0], a.balance.peak[1])}`);
  for (const r of a.regions) parts.push(`${r.name}: L* ${r.L} against ${r.surroundL} around it (ΔL* ${signed(r.dL)}, ΔE ${r.dE})`);

  const p: string[] = [];
  // Exposure (a dark UI theme is a style, so a UI frame is only checked for clipping and flatness).
  const flat = a.contrast.range < 35 && mood !== 'overcast';
  if (flat) {
    const why = e.p5 > 35 ? `washed out (even the darkest 5% are L* ${e.p5}): usually too much Atmosphere (Density, Haze), too-bright Ambient/OutdoorAmbient or EnvironmentDiffuseScale lifting the shadows` : e.p95 < 55 ? `muddy (the brightest 5% are only L* ${e.p95}): a weak sun, dark materials on lit surfaces` : 'everything is mid-grey';
    p.push(`Flat: values span only ${a.contrast.range} L* (5-95%), ${why}. Shapes won't separate: darker shadows (lower OutdoorAmbient), a stronger sun, less Atmosphere, or ColorCorrection.Contrast 0.05-0.15.`);
  }
  if (scene && !dark && e.p50 < (warmMood ? 22 : 28)) p.push(`Dark: the median value is L* ${e.p50}. A ${mood ?? 'day'} scene this dark makes players squint (convention: median L* 35-60 for day scenes, 25+ at dusk). Raise Lighting.ExposureCompensation (+0.3 to +0.7) or Brightness, lift OutdoorAmbient/Ambient, or lower Atmosphere.Density.`);
  if (scene && dark && e.p50 < 10) p.push(`Too dark even for ${mood}: the median value is L* ${e.p50}. A night scene still keeps the playable ground readable (convention: median L* 15-35): raise OutdoorAmbient a little (cool blue-grey), add local lights along paths, or ExposureCompensation +0.3.`);
  if (scene && !flat && !dark && e.p95 < 55) p.push(`No highlights: the brightest 5% are only L* ${e.p95}, so the frame looks muddy. More sun (Brightness), lighter materials on lit surfaces, or ColorCorrection.Contrast 0.05-0.15.`);
  if (scene && !flat && e.p5 > 35) p.push(`No darks: even the darkest 5% are L* ${e.p5}, so the frame looks washed out. Usually too much Atmosphere (Density or Haze), too-bright Ambient/OutdoorAmbient, or EnvironmentDiffuseScale lifting the shadows. Let something reach L* 15-25.`);
  if (scene && e.crushed > 8) p.push(`Crushed blacks: ${e.crushed}% of the frame is near black (L* ≤ 3), where nothing can be read. Lift Ambient/OutdoorAmbient, add fill lights, or lower ColorCorrection.Contrast.`);
  if (a.horizon ? e.clippedBelow > 2 : e.clipped > 3) p.push(`Blown highlights: ${a.horizon ? e.clippedBelow : e.clipped}% of the ${a.horizon ? 'scene below the horizon' : 'frame'} is clipped white. Raise Bloom.Threshold, lower Bloom.Intensity or ExposureCompensation, or tone down big Neon or white surfaces.`);
  else if (a.horizon && e.clipped > 25) p.push(`The sky is blown out (${e.clipped}% of the frame is clipped white). Lower ExposureCompensation, Atmosphere.Glare or Haze, or use a darker skybox.`);
  // Value grouping.
  const big = a.values.groups.reduce((m, g) => (g.share > m.share ? g : m), a.values.groups[0]!);
  if (!flat && a.values.separation < 1.5 && big.share > 0.6) p.push(`One value mass: ${pct(big.share * 100)} of the frame sits around L* ${big.L} and no two value groups are far apart (separation ${a.values.separation}; the readable frames measured 2.5 or more). Foreground, play space and background need different values: a darker or lighter ground, a lighter sky or darker silhouettes.`);
  // Readability of the play space against the background, and depth.
  if (a.depth && horizon && view === 'gameplay' && a.depth.groundToBack < 10 && Math.abs(a.depth.groundToBackL) < 8) p.push(`The play space doesn't separate from the background: ground and sky/distance differ by ΔE ${a.depth.groundToBack} (ΔL* ${signed(a.depth.groundToBackL)}). Separate them in value first (convention: ΔL* 15 or more), then in colour: the ground's material colour or the haze colour.`);
  const veiled = a.depth && a.depth.ratio < 0.25 && a.depth.near > 6 && mood !== 'overcast';
  if (veiled && horizon && (a.depth!.farToSky ?? 99) < 12) p.push(`Haze swallows the distance: contrast just under the horizon is ${pct(a.depth!.ratio * 100)} of the foreground's and that band is only ΔE ${a.depth!.farToSky} from the sky. Targets at range will vanish. Lower Atmosphere.Density or Haze (or raise Offset), or move the haze colour away from the sky's.`);
  else if (veiled && !a.horizon && view === 'gameplay') p.push(`Haze swallows the distance: there is no horizon to see, and the upper part of the frame has ${pct(a.depth!.ratio * 100)} of the foreground's contrast (or the camera faces a plain wall). Targets at range will vanish. Lower Atmosphere.Density or Haze (or raise Offset).`);
  if (a.depth && horizon && view === 'gameplay' && a.depth.groundChroma < 4 && mood !== 'overcast') p.push(`The ground is grey (chroma ${a.depth.groundChroma}): it reads as a default baseplate or untextured plastic. Terrain with 2-4 materials and palette MaterialColors, or coloured textured materials.`);
  // Colour.
  if (c.dominant && c.dominant.share > 0.8 && c.meanChroma > 10) p.push(`Monochrome: ${pct(c.dominant.share * 100)} of the colour is ${c.dominant.name}${c.families <= 1 ? ' (one hue family holds 80%)' : ''}. Everything reads as one colour, so team colours, pickups and hazards stop standing out. Neutralize the light (ColorCorrection.TintColor, ColorShift_Top, Atmosphere.Color nearer grey) and give the scene a contrasting accent (a complementary colour in signs, lights or shadows).`);
  if (scene && c.meanChroma < 6 && mood !== 'overcast') p.push(`Colourless: mean chroma ${c.meanChroma}, close to grey. Unless a grey look is the brief, apply the palette (material colours, terrain MaterialColors) and a little ColorCorrection.Saturation (0.05-0.2).`);
  if (c.loud > 25) p.push(`Loud: ${c.loud}% of the frame is at very high chroma (C* > 70). Keep the strongest colours for accents and gameplay signals; lower ColorCorrection.Saturation or the material colours' saturation.`);
  const castLimit = warmMood && castName.startsWith('warm') ? 40 : 25;
  if (scene && cast > castLimit) p.push(`Strong ${castName} cast: the mid-tones average a*${signed(c.castA)} b*${signed(c.castB)}${warmMood && castName.startsWith('warm') ? ` even for ${mood}` : ''}, so neutral surfaces take that colour and team colours shift. Pull ColorCorrection.TintColor, Lighting.ColorShift_Top, OutdoorAmbient or Atmosphere.Color toward neutral, or check the skybox.`);
  // Framing.
  if (view === 'gameplay' && a.horizon && a.horizon.y > 0.65) p.push(`The camera looks mostly at the sky (${pct(a.horizon.y * 100)} of the frame above the strongest horizontal boundary). Aim lower so the shot shows the play space.`);
  // Clutter and texture.
  const speckled = scene ? a.detail.noisePlay > 3 : a.detail.noise > 3;
  if (speckled) p.push(`Speckled: fine texture ${scene ? a.detail.noisePlay : a.detail.noise} in the ${scene ? 'play area' : 'frame'} (calm scenes measure 0.9-1.6). A busy material on a big surface (CorrodedMetal, Pebble, Asphalt, Sand) or a noisy texture makes the ground shimmer and swallows silhouettes. Calm materials or a MaterialVariant with a larger StudsPerTile on big surfaces; keep the noisy ones for accents.`);
  else if (scene && a.detail.edgesPlay > 30) p.push(`Busy: ${a.detail.edgesPlay}% of the play area is edges. Silhouettes of players and targets get lost. Group clutter into clusters with calm ground between them, and keep the lanes plain.`);
  if (view === 'ui' && a.detail.edges > 30) p.push(`Busy: ${a.detail.edges}% of the screen is edges. Fewer panels and outlines, more spacing.`);
  if (view === 'gameplay' && horizon && a.detail.edgesPlay < 2 && a.detail.noisePlay < 0.8) p.push(`Bare: below the horizon there are almost no edges (${a.detail.edgesPlay}%) and no texture (${a.detail.noisePlay}), so the play space reads as an empty plane. Add relief, material breakup and clustered props, or say why open space is the point.`);
  // Regions.
  for (const r of a.regions) {
    if (Math.abs(r.dL) < 8 && r.dE < 12) p.push(`${r.name} doesn't separate from what is around it (ΔL* ${signed(r.dL)}, ΔE ${r.dE}; convention for something a player must spot: ΔL* 15+ or ΔE 25+). Change its value or the background's, add a rim or an emissive accent, or check it is in the frame at all.`);
  }
  return { seen: parts.join('; '), problems: p };
}
