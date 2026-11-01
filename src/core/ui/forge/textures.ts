import { clamp01, fbm, field, hash, smoothstep, type Blend, type Field } from './canvas';

/**
 * Surface textures and repeating patterns for the Forge's layer styles, as value fields (0..1 per pixel) a style
 * paints through a colour, a ramp of colours or a grey blend: wood grain, brushed metal, stone, fabric, marble,
 * scratches, rust, camouflage, carbon fibre, water caustics, paper fibre, leather, hammered metal, speckle, pixels —
 * and patterns from stripes and dots to bricks, fish scales, bubbles, stars, hearts, chevrons, plaid, studs and
 * scanlines. Textures are anchored to the layer's own box (u, v from its top-left) so a texture never moves when
 * the canvas round it grows, and everything is seeded: the same recipe draws the same grain.
 */

type Color = string | [number, number, number];
type Stop = [t: number, color: Color] | [t: number, color: Color, alpha: number];

export type TextureKind =
  | 'noise'
  | 'clouds'
  | 'wood'
  | 'brushed'
  | 'stone'
  | 'cells'
  | 'fabric'
  | 'marble'
  | 'scratches'
  | 'rust'
  | 'camo'
  | 'carbon'
  | 'caustics'
  | 'paper'
  | 'leather'
  | 'hammered'
  | 'speckle'
  | 'pixels';

export const TEXTURE_KINDS: readonly TextureKind[] = ['noise', 'clouds', 'wood', 'brushed', 'stone', 'cells', 'fabric', 'marble', 'scratches', 'rust', 'camo', 'carbon', 'caustics', 'paper', 'leather', 'hammered', 'speckle', 'pixels'];

export interface Texture {
  kind: TextureKind;
  /** Feature size in design points (a wood ring's spacing, a stone's cell, a weave's thread). */
  scale?: number;
  /** Degrees: the grain's direction (wood, brushed metal, scratches, fabric). */
  angle?: number;
  seed?: number;
  /** 0..1 (default 0.5). */
  opacity?: number;
  blend?: Blend;
  /** One colour laid where the texture is high (alpha follows the value). */
  color?: Color;
  /** Colours along the texture's value, 0 to 1 (alpha per stop): the material itself (wood light to dark, camo bands). */
  ramp?: Stop[];
  /** Contrast round 0.5 (1 = as is). */
  contrast?: number;
  invert?: boolean;
  /** Density 0..1 for sparse kinds (scratches, speckle). */
  density?: number;
  /** Raised relief: the texture's slopes lit from above like a bevel (0..2). */
  relief?: number;
}

export type PatternKind =
  | 'stripes'
  | 'dots'
  | 'checker'
  | 'grid'
  | 'hex'
  | 'diamonds'
  | 'waves'
  | 'bricks'
  | 'scales'
  | 'bubbles'
  | 'stars'
  | 'hearts'
  | 'chevron'
  | 'crosshatch'
  | 'plaid'
  | 'confetti'
  | 'studs'
  | 'scanlines'
  | 'zigzag'
  | 'triangles'
  | 'sparkles';

export interface Pattern {
  kind: PatternKind;
  color: Color;
  opacity?: number;
  /** Cell size in design points. */
  size?: number;
  angle?: number;
  blend?: Blend;
  /** How much of each cell the mark fills, 0..1 (stripes, scanlines, chevrons, grid lines, dots). */
  duty?: number;
  seed?: number;
  /** Shift of the pattern in design points. */
  offset?: [number, number];
}

// ─── Cellular noise ───────────────────────────────────────────────────────────────────────────────

/** Distances to the nearest and second-nearest feature point (cells of size 1, one jittered point each). */
function worley(x: number, y: number, seed: number, jitter = 0.9): [number, number] {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const px = gx + 0.5 + (hash(gx, gy, seed) - 0.5) * jitter;
      const py = gy + 0.5 + (hash(gx, gy, seed + 1) - 0.5) * jitter;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  return [f1, f2];
}

// ─── Textures ─────────────────────────────────────────────────────────────────────────────────────

/** A texture's raw value at (u, v): pixels from the layer box's corner, already rotated; s = feature size in px. */
function textureAt(kind: TextureKind, u: number, v: number, s: number, seed: number, density: number): number {
  switch (kind) {
    case 'noise':
      return fbm(u / s, v / s, 4, seed);
    case 'clouds': {
      const n = fbm(u / s, v / s, 5, seed);
      return smoothstep(0.25, 0.75, n);
    }
    case 'wood': {
      // Rings along the grain, bent by slow noise, with fine fibres stretched along u and a knot here and there.
      const warp = fbm(u / (s * 9), v / (s * 2.2), 3, seed) * 2.2;
      const g = v / s + warp;
      const ring = 0.5 + 0.5 * Math.sin(g * Math.PI * 2);
      const late = Math.pow(ring, 2.5);
      const fibre = fbm(u / (s * 6), v / (s * 0.18), 3, seed + 5);
      return clamp01(0.62 * late + 0.38 * fibre);
    }
    case 'brushed': {
      const streak = fbm(u / (s * 30), v / (s * 0.35), 3, seed);
      const fine = hash(Math.floor(u / (s * 14)), Math.floor(v), seed + 3);
      return clamp01(0.7 * streak + 0.3 * fine);
    }
    case 'stone': {
      const w = 0.35 * (fbm(u / (s * 0.7), v / (s * 0.7), 2, seed + 9) - 0.5);
      const [f1, f2] = worley(u / s + w, v / s + w, seed);
      const crack = smoothstep(0.02, 0.09, f2 - f1);
      const mottle = fbm(u / (s * 0.35), v / (s * 0.35), 3, seed + 4);
      return clamp01(crack * (0.55 + 0.45 * mottle) - (1 - crack) * 0.1);
    }
    case 'cells': {
      const [f1] = worley(u / s, v / s, seed);
      return clamp01(1 - f1 / 0.75);
    }
    case 'fabric': {
      const tx = u / s;
      const ty = v / s;
      const cx = Math.floor(tx);
      const cy = Math.floor(ty);
      const fx = tx - cx;
      const fy = ty - cy;
      const overWarp = (cx + cy) % 2 === 0;
      const thread = overWarp ? Math.sin(Math.PI * fx) : Math.sin(Math.PI * fy);
      const shade = overWarp ? 0.9 + 0.1 * Math.sin(Math.PI * fy) : 0.8 + 0.1 * Math.sin(Math.PI * fx);
      const slub = 0.88 + 0.24 * hash(cx, cy, seed);
      return clamp01(Math.pow(Math.max(0, thread), 0.55) * shade * slub);
    }
    case 'marble': {
      const t = Math.abs(Math.sin((u / s + v / (s * 3)) * Math.PI * 0.5 + 5 * fbm(u / (s * 2), v / (s * 2), 5, seed)));
      const vein = smoothstep(0, 0.22, t);
      const cloud = fbm(u / (s * 1.4), v / (s * 1.4), 3, seed + 7);
      return clamp01(vein * (0.82 + 0.18 * cloud));
    }
    case 'rust': {
      const b = fbm(u / s, v / s, 5, seed);
      const blot = smoothstep(0.45 - 0.25 * density, 0.6 - 0.25 * density, b);
      const pit = hash(Math.floor(u / 1.5), Math.floor(v / 1.5), seed + 2) > 0.93 ? 0.6 : 0;
      return clamp01(Math.max(blot * (0.6 + 0.4 * fbm(u / (s * 0.25), v / (s * 0.25), 2, seed + 4)), pit * blot + pit * 0.3));
    }
    case 'camo': {
      const wx = fbm(u / (s * 1.3), v / (s * 1.3), 2, seed + 11) - 0.5;
      const wy = fbm(u / (s * 1.3) + 7.1, v / (s * 1.3) + 3.3, 2, seed + 13) - 0.5;
      return fbm(u / s + wx * 1.6, v / (s * 0.8) + wy * 1.6, 3, seed);
    }
    case 'carbon': {
      // 2×2 twill: tows alternate direction along diagonals, each with a soft cylindrical highlight.
      const tx = u / s;
      const ty = v / s;
      const cx = Math.floor(tx);
      const cy = Math.floor(ty);
      const fx = tx - cx;
      const fy = ty - cy;
      const along = Math.floor((cx + cy) / 2) % 2 === 0;
      const prof = Math.sin(Math.PI * (along ? fy : fx));
      return clamp01(0.15 + 0.85 * Math.pow(Math.max(0, prof), 1.5) * (along ? 1 : 0.7));
    }
    case 'caustics': {
      const wx = fbm(u / (s * 2), v / (s * 2), 2, seed + 3) - 0.5;
      const wy = fbm(u / (s * 2) + 4.7, v / (s * 2) + 1.9, 2, seed + 5) - 0.5;
      const [f1, f2] = worley(u / s + wx * 1.6, v / s + wy * 1.6, seed);
      const web = 1 - smoothstep(0, 0.2, f2 - f1);
      return clamp01(web * web * (0.75 + 0.5 * fbm(u / s, v / s, 2, seed + 9)));
    }
    case 'paper': {
      const a = fbm(u / (s * 0.4), v / (s * 3), 3, seed);
      const b = fbm(u / (s * 3), v / (s * 0.4), 3, seed + 1);
      const c = fbm(u / s, v / s, 4, seed + 2);
      return clamp01(0.3 * a + 0.3 * b + 0.4 * c);
    }
    case 'leather': {
      const [f1, f2] = worley(u / s, v / s, seed, 1);
      const crease = smoothstep(0.0, 0.08, f2 - f1);
      return clamp01(crease * (0.7 + 0.3 * fbm(u / (s * 0.3), v / (s * 0.3), 2, seed + 6)));
    }
    case 'hammered': {
      const [f1] = worley(u / s, v / s, seed, 0.8);
      return clamp01(1 - (f1 * f1) / 0.45);
    }
    case 'speckle': {
      const cx = Math.floor(u / s);
      const cy = Math.floor(v / s);
      if (hash(cx, cy, seed) > density) return 0;
      const px = (cx + 0.2 + 0.6 * hash(cx, cy, seed + 1)) * s;
      const py = (cy + 0.2 + 0.6 * hash(cx, cy, seed + 2)) * s;
      const r = s * (0.08 + 0.14 * hash(cx, cy, seed + 3));
      return 1 - smoothstep(r - 0.6, r + 0.6, Math.hypot(u - px, v - py));
    }
    case 'pixels':
      return hash(Math.floor(u / s), Math.floor(v / s), seed);
    case 'scratches':
      return 0;
  }
}

/** Kinds that are smooth enough to evaluate on a coarser grid and interpolate. */
const SMOOTH: Partial<Record<TextureKind, number>> = { noise: 6, clouds: 6, marble: 5, rust: 8, camo: 6, paper: 4, cells: 5, caustics: 4, hammered: 5 };

/**
 * A texture's value field (0..1) over a w × h region whose layer box starts at (ox, oy); only where `mask` (when
 * given) is above zero. Lengths in pixels.
 */
export function textureField(t: Texture, w: number, h: number, ox: number, oy: number, mask?: Field): Field {
  const f = field(w, h);
  const s = Math.max(0.5, t.scale ?? 12);
  const seed = t.seed ?? 3;
  const density = t.density ?? 0.5;
  const a = ((t.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // The mask's rows and columns in use.
  let x0 = 0;
  let x1 = w;
  let y0 = 0;
  let y1 = h;
  if (mask) {
    x0 = w;
    x1 = 0;
    y0 = h;
    y1 = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (mask.v[y * w + x]! > 0) {
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
    if (x1 <= x0) return f;
  }
  if (t.kind === 'scratches') scratches(f, s, ca, sa, seed, density, ox, oy, x0, y0, x1, y1);
  else {
    const coarse = SMOOTH[t.kind] ? Math.max(1, Math.min(4, Math.floor(s / SMOOTH[t.kind]!))) : 1;
    const at = (x: number, y: number) => {
      const px = x - ox;
      const py = y - oy;
      return textureAt(t.kind, px * ca + py * sa, -px * sa + py * ca, s, seed, density);
    };
    if (coarse === 1) {
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) if (!mask || mask.v[y * w + x]! > 0) f.v[y * w + x] = at(x + 0.5, y + 0.5);
    } else {
      // A coarse lattice, then bilinear in between.
      const gw = Math.ceil((x1 - x0) / coarse) + 2;
      const gh = Math.ceil((y1 - y0) / coarse) + 2;
      const g = new Float32Array(gw * gh);
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) g[j * gw + i] = at(x0 + i * coarse, y0 + j * coarse);
      for (let y = y0; y < y1; y++) {
        const gy = (y + 0.5 - y0) / coarse;
        const j = Math.min(gh - 2, Math.floor(gy));
        const ty = gy - j;
        for (let x = x0; x < x1; x++) {
          if (mask && mask.v[y * w + x]! <= 0) continue;
          const gx = (x + 0.5 - x0) / coarse;
          const i = Math.min(gw - 2, Math.floor(gx));
          const tx = gx - i;
          const k = j * gw + i;
          f.v[y * w + x] = (g[k]! * (1 - tx) + g[k + 1]! * tx) * (1 - ty) + (g[k + gw]! * (1 - tx) + g[k + gw + 1]! * tx) * ty;
        }
      }
    }
  }
  const contrast = t.contrast ?? 1;
  if (contrast !== 1 || t.invert)
    for (let i = 0; i < w * h; i++) {
      let v = f.v[i]!;
      if (contrast !== 1) v = clamp01(0.5 + (v - 0.5) * contrast);
      if (t.invert) v = 1 - v;
      f.v[i] = v;
    }
  return f;
}

/** Thin random strokes (scratches, scuffs) along the grain angle, drawn into f. */
function scratches(f: Field, s: number, ca: number, sa: number, seed: number, density: number, ox: number, oy: number, x0: number, y0: number, x1: number, y1: number): void {
  const cell = s * 3;
  // Cells over the region in box coordinates (unrotated: scratches pick their own angle near the grain).
  const c0x = Math.floor((x0 - ox) / cell) - 1;
  const c1x = Math.ceil((x1 - ox) / cell) + 1;
  const c0y = Math.floor((y0 - oy) / cell) - 1;
  const c1y = Math.ceil((y1 - oy) / cell) + 1;
  for (let cy = c0y; cy <= c1y; cy++)
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let k = 0; k < 2; k++) {
        if (hash(cx, cy, seed + k * 17) > density) continue;
        const px = ox + (cx + hash(cx, cy, seed + 1 + k * 17)) * cell;
        const py = oy + (cy + hash(cx, cy, seed + 2 + k * 17)) * cell;
        const len = s * (1.5 + 5 * hash(cx, cy, seed + 3 + k * 17));
        const turn = (hash(cx, cy, seed + 4 + k * 17) - 0.5) * 0.9;
        const dx = ca * Math.cos(turn) - sa * Math.sin(turn);
        const dy = sa * Math.cos(turn) + ca * Math.sin(turn);
        const width = 0.35 + 0.6 * hash(cx, cy, seed + 5 + k * 17);
        const strength = 0.45 + 0.55 * hash(cx, cy, seed + 6 + k * 17);
        const ax = px - (dx * len) / 2;
        const ay = py - (dy * len) / 2;
        const bx = px + (dx * len) / 2;
        const by = py + (dy * len) / 2;
        const lx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - 2));
        const lx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + 2));
        const ly0 = Math.max(y0, Math.floor(Math.min(ay, by) - 2));
        const ly1 = Math.min(y1, Math.ceil(Math.max(ay, by) + 2));
        for (let y = ly0; y < ly1; y++)
          for (let x = lx0; x < lx1; x++) {
            const qx = x + 0.5 - ax;
            const qy = y + 0.5 - ay;
            const t = clamp01((qx * dx + qy * dy) / len);
            const d = Math.hypot(qx - dx * len * t, qy - dy * len * t);
            // Tapered at both ends.
            const taper = Math.sin(Math.PI * t);
            const v = (1 - smoothstep(width * taper - 0.5, width * taper + 0.6, d)) * strength;
            const i = y * f.w + x;
            if (v > f.v[i]!) f.v[i] = v;
          }
      }
    }
}

// ─── Patterns ─────────────────────────────────────────────────────────────────────────────────────

const frac = (x: number) => x - Math.floor(x);

/** Signed distance to a unit heart (Inigo Quilez), centred near the origin. */
function heartSd(px: number, py: number): number {
  const x = Math.abs(px);
  const y = py + 0.5;
  if (x + y > 1) return Math.hypot(x - 0.25, y - 0.75) - Math.SQRT2 / 4;
  const a = Math.hypot(x, y - 1);
  const m = 0.5 * Math.max(x + y, 0);
  const b = Math.hypot(x - m, y - m);
  return Math.sqrt(Math.min(a * a, b * b)) * Math.sign(x - y);
}

/** A 5-point star's signed distance (unit outer radius). */
function starSd(px: number, py: number, inner = 0.45): number {
  const n = 5;
  const an = Math.PI / n;
  let a = Math.atan2(px, -py);
  a = ((a % (2 * an)) + 2 * an) % (2 * an) - an;
  const r = Math.hypot(px, py);
  const qx = Math.abs(Math.sin(a)) * r;
  const qy = Math.cos(a) * r;
  // Edge from the tip (0, 1) to the inner vertex.
  const ix = Math.sin(an) * inner;
  const iy = Math.cos(an) * inner;
  const ex = ix;
  const ey = iy - 1;
  const t = clamp01((qx * ex + (qy - 1) * ey) / (ex * ex + ey * ey));
  const d = Math.hypot(qx - ex * t, qy - 1 - ey * t);
  const side = (qx * -ey + (qy - 1) * ex) > 0 ? 1 : -1;
  return d * side;
}

/** A 4-point sparkle's brightness (concave star with a soft core) at (x, y), radius r. */
export function sparkleAt(x: number, y: number, r: number): number {
  const ax = Math.abs(x) / r;
  const ay = Math.abs(y) / r;
  const d = Math.sqrt(ax) + Math.sqrt(ay);
  const star = 1 - smoothstep(0.85, 1.05, d);
  const core = Math.exp(-(ax * ax + ay * ay) * 9);
  return clamp01(Math.max(star, core));
}

/** A pattern's coverage field over w × h (box starts at ox, oy); lengths in pixels. */
export function patternField(pt: Pattern, w: number, h: number, ox = 0, oy = 0, mask?: Field): Field {
  const f = field(w, h);
  const s = pt.size ?? 12;
  const a = ((pt.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const duty = pt.duty;
  const seed = pt.seed ?? 5;
  const [offX, offY] = pt.offset ?? [0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (mask && mask.v[y * w + x]! <= 0) continue;
      const X = x + 0.5 - ox - offX;
      const Y = y + 0.5 - oy - offY;
      const u = X * ca + Y * sa;
      const v = -X * sa + Y * ca;
      let m = 0;
      switch (pt.kind) {
        case 'stripes': {
          const d = duty ?? 0.5;
          // Distance into the stripe band (period s, the mark `d` of it).
          const p = frac(u / s) * s;
          const edge = Math.min(p, d * s - p);
          m = d >= 1 ? 1 : smoothstep(-0.6, 0.6, edge);
          break;
        }
        case 'scanlines': {
          const d = duty ?? 0.35;
          const p = frac(v / s) * s;
          m = smoothstep(-0.5, 0.5, Math.min(p, d * s - p));
          break;
        }
        case 'dots': {
          const du = frac(u / s) * s - s / 2;
          const dv = frac(v / s) * s - s / 2;
          const r = s * (duty ?? 0.22);
          m = 1 - smoothstep(r - 0.7, r + 0.7, Math.hypot(du, dv));
          break;
        }
        case 'studs': {
          // Raised round studs: a ring of light on top, darker below (read as a stud even in one colour).
          const du = frac(u / s) * s - s / 2;
          const dv = frac(v / s) * s - s / 2;
          const r = s * (duty ?? 0.3);
          const d = Math.hypot(du, dv);
          m = (1 - smoothstep(r - 0.7, r + 0.7, d)) * (0.55 + 0.45 * clamp01(-dv / r + 0.3));
          break;
        }
        case 'checker':
          m = (Math.floor(u / s) + Math.floor(v / s)) % 2 === 0 ? 1 : 0;
          break;
        case 'grid': {
          const du = Math.abs(frac(u / s) * s - s / 2);
          const dv = Math.abs(frac(v / s) * s - s / 2);
          const lw = (duty ?? 0.08) * s;
          m = 1 - smoothstep(lw / 2 - 0.4, lw / 2 + 0.6, s / 2 - Math.max(du, dv));
          break;
        }
        case 'crosshatch': {
          const lw = (duty ?? 0.15) * s;
          const d1 = Math.abs(frac((u + v) / (s * Math.SQRT2)) - 0.5) * s * Math.SQRT2;
          const d2 = Math.abs(frac((u - v) / (s * Math.SQRT2)) - 0.5) * s * Math.SQRT2;
          m = Math.max(1 - smoothstep(lw / 2 - 0.4, lw / 2 + 0.6, d1 - 0), 1 - smoothstep(lw / 2 - 0.4, lw / 2 + 0.6, d2));
          break;
        }
        case 'diamonds': {
          const du = Math.abs(frac(u / s) * s - s / 2);
          const dv = Math.abs(frac(v / s) * s - s / 2);
          m = 1 - smoothstep(s * 0.3 - 0.7, s * 0.3 + 0.7, du + dv);
          break;
        }
        case 'hex': {
          // Lines of a honeycomb: the offset to the nearest hexagon centre, then the distance to its edge.
          const qx = u / s;
          const qy = v / s;
          const ax = frac(qx) - 0.5;
          const ay = frac(qy / 1.732) * 1.732 - 0.866;
          const bx = frac(qx - 0.5) - 0.5;
          const by = frac((qy - 0.866) / 1.732) * 1.732 - 0.866;
          const [gx, gy] = ax * ax + ay * ay < bx * bx + by * by ? [ax, ay] : [bx, by];
          const ex = Math.abs(gx);
          const ey = Math.abs(gy);
          const hexDist = Math.max(ex * 0.5 + ey * 0.866, ex);
          const edge = (0.5 - hexDist) * s;
          const lw = (duty ?? 0.06) * s;
          m = 1 - smoothstep(lw / 2 - 0.5, lw / 2 + 0.6, edge);
          break;
        }
        case 'waves':
          m = smoothstep(-0.8, 0.8, Math.sin((u / s) * Math.PI * 2 + Math.sin((v / s) * Math.PI) * 1.2) * s * 0.3);
          break;
        case 'zigzag': {
          const p = frac(u / s);
          const tri = Math.abs(p - 0.5) * 2 * s * 0.5;
          const d = frac((v - tri) / s) * s;
          const lw = (duty ?? 0.3) * s;
          m = smoothstep(-0.6, 0.6, Math.min(d, lw - d));
          break;
        }
        case 'chevron': {
          const p = Math.abs(frac(u / s) - 0.5) * s;
          const d = frac((v + p) / s) * s;
          const lw = (duty ?? 0.4) * s;
          m = smoothstep(-0.6, 0.6, Math.min(d, lw - d));
          break;
        }
        case 'bricks': {
          const bh = s * 0.5;
          const row = Math.floor(v / bh);
          const uu = u + (row % 2 ? s / 2 : 0);
          const du = Math.abs(frac(uu / s) * s - s / 2);
          const dv = Math.abs(frac(v / bh) * bh - bh / 2);
          const mortar = (duty ?? 0.08) * s;
          // The mortar lines (1 on them).
          m = 1 - smoothstep(-0.5, 0.7, Math.min(s / 2 - du, bh / 2 - dv) - mortar / 2);
          break;
        }
        case 'scales': {
          // Overlapping half-discs (fish scales, roof shingles): rings at each scale's rim.
          const row = Math.floor(v / (s * 0.5));
          const uu = u + (row % 2 ? s / 2 : 0);
          const cx = (Math.floor(uu / s) + 0.5) * s;
          const cy = row * s * 0.5;
          const d = Math.hypot(uu - cx, v - cy);
          const r = s * 0.5;
          const lw = (duty ?? 0.12) * s;
          m = 1 - smoothstep(lw / 2 - 0.5, lw / 2 + 0.5, Math.abs(d - r + lw / 2));
          break;
        }
        case 'triangles': {
          const row = Math.floor(v / s);
          const p = frac(u / s + (row % 2) * 0.5);
          const q = frac(v / s);
          m = smoothstep(-0.04, 0.04, q - Math.abs(p - 0.5) * 2) * 1;
          break;
        }
        case 'plaid': {
          const bandA = Math.abs(frac(u / s) - 0.5) < (duty ?? 0.18) ? 1 : 0;
          const bandB = Math.abs(frac(v / s) - 0.5) < (duty ?? 0.18) ? 1 : 0;
          const thin = Math.abs(frac(u / s + 0.5) - 0.5) < 0.03 || Math.abs(frac(v / s + 0.5) - 0.5) < 0.03 ? 0.7 : 0;
          m = Math.max(0.55 * (bandA + bandB), thin);
          break;
        }
        case 'bubbles':
        case 'confetti':
        case 'stars':
        case 'hearts':
        case 'sparkles': {
          // One mark per cell, placed, sized (and for confetti turned) by the cell's hash.
          const cx = Math.floor(u / s);
          const cy = Math.floor(v / s);
          const keep = duty ?? (pt.kind === 'bubbles' ? 0.7 : 0.55);
          if (hash(cx, cy, seed) > keep) break;
          const px = (cx + 0.25 + 0.5 * hash(cx, cy, seed + 1)) * s;
          const py = (cy + 0.25 + 0.5 * hash(cx, cy, seed + 2)) * s;
          const size = 0.45 + 0.55 * hash(cx, cy, seed + 3);
          const dx = u - px;
          const dy = v - py;
          if (pt.kind === 'bubbles') {
            const r = s * 0.28 * size;
            const d = Math.hypot(dx, dy);
            const rim = 1 - smoothstep(0.5, 1.4, Math.abs(d - r) - s * 0.02);
            const glint = 1 - smoothstep(r * 0.12, r * 0.12 + 0.8, Math.hypot(dx + r * 0.38, dy + r * 0.38));
            const body = (1 - smoothstep(r - 0.6, r + 0.6, d)) * 0.18;
            m = Math.max(rim, glint, body);
          } else if (pt.kind === 'confetti') {
            const ang = hash(cx, cy, seed + 4) * Math.PI;
            const qx = dx * Math.cos(ang) + dy * Math.sin(ang);
            const qy = -dx * Math.sin(ang) + dy * Math.cos(ang);
            const hw = s * 0.16 * size;
            const hh = s * 0.06 * size;
            m = (1 - smoothstep(-0.6, 0.6, Math.abs(qx) - hw)) * (1 - smoothstep(-0.6, 0.6, Math.abs(qy) - hh));
          } else if (pt.kind === 'stars') {
            const r = s * 0.3 * size;
            m = 1 - smoothstep(-0.7, 0.7, starSd(dx / r, dy / r) * r);
          } else if (pt.kind === 'hearts') {
            const r = s * 0.3 * size;
            m = 1 - smoothstep(-0.7, 0.7, heartSd(dx / r, -dy / r + 0.1) * r);
          } else m = sparkleAt(dx, dy, s * 0.3 * size);
          break;
        }
      }
      f.v[y * w + x] = m;
    }
  return f;
}
