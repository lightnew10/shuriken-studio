import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { roundedRect, strokeOutline, wound, type Pt } from '../ui-raster';
import { glyphSet, glyphShapes, glyphName } from '../ui-glyphs';
import { placeLine, robloxFaceFor } from '../lab/roblox-fonts';

/** The app's resources (the bundled glyph set): set by the core; scripts and tests find the repo's. */
let resources: string | null = null;
export function setForgeResources(dir: string | null): void {
  resources = dir;
}
// __dirname is undefined when this runs as an ES module (scripts under tsx).
const here = typeof __dirname === 'string' ? __dirname : null;
/** Where the bundled resources are (the core sets it; scripts and tests find the repo's). */
export const resourcesDir = (): string | null => resources ?? process.env.SHURIKEN_RESOURCES ?? [...(here ? [join(here, '..', '..', '..', '..', 'resources')] : []), join(process.cwd(), 'resources')].find((d) => existsSync(join(d, 'ui-glyphs'))) ?? null;

/**
 * The Forge's shapes as closed contours in pixels (y down), at an origin and size: what game UI art is cut from —
 * rounded and per-corner boxes, pills, cut and slanted panels, shields, hexagons, bursts, ribbons with forked ends,
 * tabs, speech bubbles, scalloped edges, stars and sparkles, hearts, clouds, torn and dripping edges, waves, toy studs,
 * leaves, rings, pixel stair corners, arrows, any polygon — and text in Roblox's own fonts (for title plates and big
 * numbers). Overlapping contours of the same winding add up to their union. Lengths in a spec are design points;
 * `scaleShape` turns them into pixels for a scale.
 */

export type ShapeSpec =
  | { kind: 'rect'; radius?: number | [number, number, number, number] }
  | { kind: 'pill' }
  | { kind: 'ellipse' }
  | { kind: 'cut'; cut: number | [number, number, number, number]; slant?: [number, number] }
  | { kind: 'shield'; radius?: number; point?: number }
  | { kind: 'hex'; point?: number }
  | { kind: 'burst'; points?: number; inner?: number; round?: number }
  | { kind: 'ribbon'; notch?: number; fold?: number }
  | { kind: 'tab'; radius?: number }
  | { kind: 'bubble'; radius?: number; tail?: [number, number, number] }
  | { kind: 'scallop'; radius?: number; scallop?: number; side?: 'bottom' | 'top' }
  | { kind: 'cross'; thickness?: number; radius?: number }
  /** A line-art glyph (Lucide, 1,800 icons: coins, sword, shield, heart, zap, crown, gem…) as filled shapes, its lines this thick (of 24); solid: the spaces its lines close in filled too (a silhouette for sticker icons). */
  | { kind: 'glyph'; name: string; weight?: number; solid?: boolean }
  /** Four L-shaped corner brackets (sci-fi frames, targeting marks). */
  | { kind: 'brackets'; length?: number; thickness?: number; inset?: number }
  /** Round rivets or studs at the corners (and along long edges when `spacing` is set). */
  | { kind: 'rivets'; radius?: number; inset?: number; spacing?: number }
  /** A faceted gem (diamond cut). */
  | { kind: 'gem' }
  /** A hollow frame: the box with a hole `thickness` in from its edge (radius for both). */
  | { kind: 'frame'; thickness: number; radius?: number }
  /** A star: points (5), inner radius (0..1 of the outer), rounded tips. */
  | { kind: 'star'; points?: number; inner?: number; round?: number }
  /** A four- (or eight-) point sparkle with concave sides; pinch 0..1 (how thin its rays are). */
  | { kind: 'sparkle'; points?: 4 | 8; pinch?: number }
  | { kind: 'heart' }
  /** Any polygon, its points in 0..1 of the box, corners rounded by round. */
  | { kind: 'polygon'; points: Array<[number, number]>; round?: number }
  /** A cloud: a rounded box whose outline is a row of round bumps. */
  | { kind: 'puffy'; bump?: number; radius?: number }
  /** Torn or rough-cut: the box's outline pushed in and out by smooth noise. */
  | { kind: 'torn'; rough?: number; seed?: number; radius?: number; detail?: number }
  /** A box whose bottom edge drips (paint, slime, blood): drips (count), length (0..1 of the height). */
  | { kind: 'drip'; drips?: number; length?: number; seed?: number; radius?: number }
  /** A box with a wavy top, bottom or both (water, frosting). */
  | { kind: 'wave'; amplitude?: number; period?: number; side?: 'top' | 'bottom' | 'both'; radius?: number }
  /** A grid of round studs filling the box (the top of a toy brick); radius as a fraction of the cell. */
  | { kind: 'studs'; cols?: number; rows?: number; radius?: number }
  /** A leaf (pointed oval), turned by angle (degrees). */
  | { kind: 'leaf'; angle?: number }
  /** A hollow ellipse (a coin's rim, a halo). */
  | { kind: 'ring'; thickness: number }
  /** A box with stair-stepped corners (pixel-art rounding): steps of step each. */
  | { kind: 'stairs'; step: number; steps?: number }
  /** An arrow pointing a way (next / back / up). head: 0..1 of the length; shaft: 0..1 of the thickness. */
  | { kind: 'arrow'; dir?: 'right' | 'left' | 'up' | 'down'; head?: number; shaft?: number }
  /** A line of text; snap: whole-pixel glyph positions and a size that is a multiple of snap (pixel fonts). */
  | { kind: 'text'; text: string; font?: string; weight?: number; italic?: boolean; size?: number; tracking?: number; snap?: number };

const TAU = Math.PI * 2;
const ring = (cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = TAU, n = 64): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
};

const hash01 = (i: number, seed: number) => {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

/** Clockwise (y down) with positive area, as fillMask expects for a solid. */
const cw = (pts: Pt[]): Pt[] => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a < 0 ? [...pts].reverse() : pts;
};

/** A polygon with each corner rounded by up to `r` (fillets along the two edges). */
function rounded(poly: Pt[], r: number): Pt[] {
  if (r <= 0) return poly;
  const out: Pt[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!;
    const a = poly[(i - 1 + n) % n]!;
    const b = poly[(i + 1) % n]!;
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const rr = Math.min(r, la / 2, lb / 2);
    const pa: Pt = [p[0] + ((a[0] - p[0]) / la) * rr, p[1] + ((a[1] - p[1]) / la) * rr];
    const pb: Pt = [p[0] + ((b[0] - p[0]) / lb) * rr, p[1] + ((b[1] - p[1]) / lb) * rr];
    // A quadratic from pa through the corner to pb.
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      out.push([u * u * pa[0] + 2 * u * t * p[0] + t * t * pb[0], u * u * pa[1] + 2 * u * t * p[1] + t * t * pb[1]]);
    }
  }
  return out;
}

/** Contours of a shape filling the box (x, y, w, h). */
export function shapeContours(s: ShapeSpec, x: number, y: number, w: number, h: number): Pt[][] {
  switch (s.kind) {
    case 'rect': {
      const r = s.radius ?? 0;
      const radii: [number, number, number, number] = Array.isArray(r) ? r : [r, r, r, r];
      const m = Math.min(w, h) / 2;
      return [cw(roundedRect(x, y, w, h, radii.map((v) => Math.min(v, m)) as [number, number, number, number]))];
    }
    case 'pill':
      return [cw(roundedRect(x, y, w, h, [h / 2, h / 2, h / 2, h / 2].map((v) => Math.min(v, w / 2)) as [number, number, number, number]))];
    case 'ellipse':
      return [cw(ring(x + w / 2, y + h / 2, w / 2, h / 2, 0, TAU, 96))];
    case 'cut': {
      const [a, b, c, d] = Array.isArray(s.cut) ? s.cut : [s.cut, s.cut, s.cut, s.cut];
      const [sl, sr] = s.slant ?? [0, 0];
      const lt = x + Math.max(0, sl);
      const lb = x + Math.max(0, -sl);
      const rt = x + w - Math.max(0, sr);
      const rb = x + w - Math.max(0, -sr);
      const left = (yy: number) => lt + ((lb - lt) * (yy - y)) / h;
      const right = (yy: number) => rt + ((rb - rt) * (yy - y)) / h;
      return [cw([[left(y + a), y + a], [lt + a, y], [rt - b, y], [right(y + b), y + b], [right(y + h - c), y + h - c], [rb - c, y + h], [lb + d, y + h], [left(y + h - d), y + h - d]])];
    }
    case 'shield': {
      const r = s.radius ?? Math.min(w, h) * 0.12;
      const p = s.point ?? h * 0.32;
      const pts: Pt[] = [];
      pts.push(...roundedRect(x, y, w, h - p, [r, r, 0, 0]).filter(([, py]) => py <= y + r + 1e-6));
      // Down the right side and a curve into the point, then back up the left.
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        pts.push([x + w - (w / 2) * t * t, y + h - p + p * Math.sin((t * Math.PI) / 2)]);
      }
      for (let i = 1; i <= 24; i++) {
        const t = 1 - i / 24;
        pts.push([x + (w / 2) * t * t, y + h - p + p * Math.sin((t * Math.PI) / 2)]);
      }
      return [cw(pts)];
    }
    case 'hex': {
      const p = s.point ?? h / 2;
      return [cw([[x + p, y], [x + w - p, y], [x + w, y + h / 2], [x + w - p, y + h], [x + p, y + h], [x, y + h / 2]])];
    }
    case 'burst': {
      const n = s.points ?? 14;
      const inner = s.inner ?? 0.82;
      const pts: Pt[] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const rr = i % 2 ? inner : 1;
        pts.push([x + w / 2 + (Math.cos(a) * w * rr) / 2, y + h / 2 + (Math.sin(a) * h * rr) / 2]);
      }
      return [cw(rounded(pts, s.round ?? Math.min(w, h) * 0.03))];
    }
    case 'ribbon': {
      const notch = s.notch ?? h * 0.35;
      return [cw([[x, y], [x + w, y], [x + w - notch, y + h / 2], [x + w, y + h], [x, y + h], [x + notch, y + h / 2]])];
    }
    case 'tab': {
      const r = s.radius ?? Math.min(w, h) * 0.3;
      return [cw(roundedRect(x, y, w, h, [r, r, 0, 0]))];
    }
    case 'bubble': {
      const r = s.radius ?? Math.min(w, h) * 0.2;
      const [tx, tw, th] = s.tail ?? [0.25, Math.min(w, h) * 0.3, Math.min(w, h) * 0.3];
      const body = cw(roundedRect(x, y, w, h - th, [r, r, r, r]));
      const bx = x + w * tx;
      return [body, cw([[bx, y + h - th - 1], [bx + tw, y + h - th - 1], [bx + tw * 0.15, y + h]])];
    }
    case 'scallop': {
      const r = s.radius ?? 0;
      const sc = s.scallop ?? Math.max(8, w / 10);
      const n = Math.max(2, Math.round(w / (sc * 2)));
      const d = w / n;
      const out: Pt[][] = [];
      if ((s.side ?? 'bottom') === 'bottom') {
        out.push(cw(roundedRect(x, y, w, h - d / 2, [r, r, 0, 0])));
        for (let i = 0; i < n; i++) out.push(cw(ring(x + d * i + d / 2, y + h - d / 2 - 1, d / 2, d / 2, 0, Math.PI, 32).concat([[x + d * i, y + h - d / 2 - 2]])));
      } else {
        out.push(cw(roundedRect(x, y + d / 2, w, h - d / 2, [0, 0, r, r])));
        for (let i = 0; i < n; i++) out.push(cw(ring(x + d * i + d / 2, y + d / 2 + 1, d / 2, d / 2, Math.PI, TAU, 32).concat([[x + d * i + d, y + d / 2 + 2]])));
      }
      return out;
    }
    case 'cross': {
      // Two rounded bars crossing at the centre (a close mark).
      const t = (s.thickness ?? 0.24) * Math.min(w, h);
      const len = Math.min(w, h) * 1.1;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const bar = (deg: number): Pt[] => {
        const a = (deg * Math.PI) / 180;
        const base = roundedRect(-len / 2, -t / 2, len, t, [t / 2, t / 2, t / 2, t / 2].map((v) => Math.min(v, s.radius ?? v)) as [number, number, number, number]);
        return cw(base.map(([px, py]) => [cx + px * Math.cos(a) - py * Math.sin(a), cy + px * Math.sin(a) + py * Math.cos(a)] as Pt));
      };
      return [bar(45), bar(-45)];
    }
    case 'glyph': {
      const set = glyphSet(resourcesDir());
      const name = set ? glyphName(set, s.name) : null;
      if (!set || !name) return [];
      const { lines, fills } = glyphShapes(set.icons[name]!);
      const k = Math.min(w, h) / 24;
      const ox = x + (w - 24 * k) / 2;
      const oy = y + (h - 24 * k) / 2;
      const to = (p: Pt): Pt => [ox + p[0] * k, oy + p[1] * k];
      const half = ((s.weight ?? 2.6) * k) / 2;
      const out: Pt[][] = [];
      for (const l of lines) out.push(...strokeOutline([l.pts.map(to)], half, l.closed));
      for (const f of fills) out.push(wound(f.map(to), 1));
      return out;
    }
    case 'brackets': {
      const len = s.length ?? Math.min(w, h) * 0.22;
      const t = s.thickness ?? Math.max(2, Math.min(w, h) * 0.035);
      const i = s.inset ?? 0;
      const L = (cx: number, cy: number, sx: number, sy: number): Pt[] => cw([[cx, cy], [cx + sx * len, cy], [cx + sx * len, cy + sy * t], [cx + sx * t, cy + sy * t], [cx + sx * t, cy + sy * len], [cx, cy + sy * len]]);
      return [L(x + i, y + i, 1, 1), L(x + w - i, y + i, -1, 1), L(x + w - i, y + h - i, -1, -1), L(x + i, y + h - i, 1, -1)];
    }
    case 'rivets': {
      const r = s.radius ?? Math.min(w, h) * 0.035;
      const i = s.inset ?? r * 2.4;
      const pts: Array<[number, number]> = [[x + i, y + i], [x + w - i, y + i], [x + w - i, y + h - i], [x + i, y + h - i]];
      if (s.spacing)
        for (const [ax, ay, bx, by] of [[x + i, y + i, x + w - i, y + i], [x + i, y + h - i, x + w - i, y + h - i]] as Array<[number, number, number, number]>) {
          const n = Math.floor(Math.hypot(bx - ax, by - ay) / s.spacing);
          for (let j = 1; j < n; j++) pts.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
        }
      return pts.map(([cx, cy]) => cw(ring(cx, cy, r, r, 0, TAU, 24)));
    }
    case 'gem':
      return [cw([[x + w * 0.25, y], [x + w * 0.75, y], [x + w, y + h * 0.32], [x + w / 2, y + h], [x, y + h * 0.32]])];
    case 'frame': {
      const r = s.radius ?? 0;
      const t = s.thickness;
      const outer = cw(roundedRect(x, y, w, h, [r, r, r, r].map((v) => Math.min(v, w / 2, h / 2)) as [number, number, number, number]));
      const ir = Math.max(0, r - t);
      const inner = [...cw(roundedRect(x + t, y + t, w - 2 * t, h - 2 * t, [ir, ir, ir, ir].map((v) => Math.min(v, (w - 2 * t) / 2, (h - 2 * t) / 2)) as [number, number, number, number]))].reverse();
      return [outer, inner];
    }
    case 'star': {
      const n = Math.max(3, s.points ?? 5);
      const inner = s.inner ?? 0.48;
      const pts: Pt[] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const rr = i % 2 ? inner : 1;
        pts.push([x + w / 2 + (Math.cos(a) * w * rr) / 2, y + h / 2 + (Math.sin(a) * h * rr) / 2]);
      }
      return [cw(rounded(pts, s.round ?? Math.min(w, h) * 0.04))];
    }
    case 'sparkle': {
      // An astroid-like star: each ray's sides curve inwards (|x|^e + |y|^e = 1 with e < 1).
      const e = 1 / (1 + 2.2 * (s.pinch ?? 0.6));
      const ray = (rx: number, ry: number, rot: number): Pt[] => {
        const pts: Pt[] = [];
        for (let i = 0; i < 96; i++) {
          const t = (i / 96) * TAU;
          const c = Math.cos(t);
          const sn = Math.sin(t);
          const px = Math.sign(c) * Math.pow(Math.abs(c), 1 / e) * rx;
          const py = Math.sign(sn) * Math.pow(Math.abs(sn), 1 / e) * ry;
          pts.push([x + w / 2 + px * Math.cos(rot) - py * Math.sin(rot), y + h / 2 + px * Math.sin(rot) + py * Math.cos(rot)]);
        }
        return cw(pts);
      };
      const out = [ray(w / 2, h / 2, 0)];
      if (s.points === 8) out.push(ray(w * 0.3, h * 0.3, Math.PI / 4));
      return out;
    }
    case 'heart': {
      const pts: Pt[] = [];
      for (let i = 0; i < 120; i++) {
        const t = (i / 120) * TAU;
        const hx = 16 * Math.sin(t) ** 3;
        const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
        pts.push([x + w / 2 + (hx / 34) * w, y + h * 0.4 - (hy / 30) * h]);
      }
      return [cw(pts)];
    }
    case 'polygon':
      return [cw(rounded(s.points.map(([u, v]) => [x + u * w, y + v * h] as Pt), s.round ?? 0))];
    case 'puffy': {
      const r = Math.min(s.bump ?? Math.min(w, h) * 0.14, Math.min(w, h) / 2);
      const ix = x + r;
      const iy = y + r;
      const iw = Math.max(0, w - 2 * r);
      const ih = Math.max(0, h - 2 * r);
      const out: Pt[][] = [cw(roundedRect(ix - r * 0.4, iy - r * 0.4, iw + r * 0.8, ih + r * 0.8, [r, r, r, r]))];
      // Bumps along the inset box's outline, spaced so neighbours overlap.
      const along = (len: number) => Math.max(1, Math.round(len / (r * 1.3)));
      const nx = along(iw);
      const ny = along(ih);
      for (let i = 0; i <= nx; i++) {
        out.push(cw(ring(ix + (iw * i) / nx, iy, r, r, 0, TAU, 28)));
        out.push(cw(ring(ix + (iw * i) / nx, iy + ih, r, r, 0, TAU, 28)));
      }
      for (let j = 1; j < ny; j++) {
        out.push(cw(ring(ix, iy + (ih * j) / ny, r, r, 0, TAU, 28)));
        out.push(cw(ring(ix + iw, iy + (ih * j) / ny, r, r, 0, TAU, 28)));
      }
      return out;
    }
    case 'torn': {
      const rough = s.rough ?? Math.min(w, h) * 0.04;
      const step = Math.max(1.5, s.detail ?? rough * 0.9);
      const seed = s.seed ?? 4;
      const r = s.radius ?? 0;
      const base = roundedRect(x + rough, y + rough, w - 2 * rough, h - 2 * rough, [r, r, r, r]);
      // Resample the outline evenly, then push each point along its normal by smooth noise.
      const even: Pt[] = [];
      for (let i = 0; i < base.length; i++) {
        const a = base[i]!;
        const b = base[(i + 1) % base.length]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = Math.max(1, Math.ceil(len / step));
        for (let j = 0; j < k; j++) even.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
      }
      const n = even.length;
      const pts: Pt[] = even.map((pt, i) => {
        const a = even[(i - 1 + n) % n]!;
        const b = even[(i + 1) % n]!;
        const tx = b[0] - a[0];
        const ty = b[1] - a[1];
        const l = Math.hypot(tx, ty) || 1;
        const t = i / 3.5;
        const t0 = Math.floor(t);
        const f = t - t0;
        const h0 = hash01(t0, seed);
        const h1 = hash01(t0 + 1, seed);
        const v = (h0 + (h1 - h0) * f * f * (3 - 2 * f)) * 0.75 + hash01(i, seed + 7) * 0.25;
        const off = (v - 0.5) * 2 * rough;
        return [pt[0] + (ty / l) * off, pt[1] - (tx / l) * off] as Pt;
      });
      return [cw(pts)];
    }
    case 'drip': {
      const n = Math.max(1, s.drips ?? Math.max(3, Math.round(w / 40)));
      const len = (s.length ?? 0.35) * h;
      const seed = s.seed ?? 6;
      const r = s.radius ?? 0;
      const bodyH = h - len;
      const out: Pt[][] = [cw(roundedRect(x, y, w, bodyH, [r, r, 0, 0]))];
      for (let i = 0; i < n; i++) {
        const cx = x + ((i + 0.25 + 0.5 * hash01(i, seed)) / n) * w;
        const dw = Math.max(3, (w / n) * (0.18 + 0.22 * hash01(i, seed + 1)));
        const dl = len * (0.3 + 0.7 * hash01(i, seed + 2));
        // A column from the body down ending in a round drop, with a fillet where it leaves the edge.
        out.push(cw(roundedRect(cx - dw / 2, y + bodyH - 1, dw, Math.max(1, dl - dw * 0.4), [0, 0, dw / 2, dw / 2])));
        out.push(cw(ring(cx, y + bodyH + dl - dw * 0.62, dw * 0.62, dw * 0.62, 0, TAU, 24)));
        out.push(cw([[cx - dw * 1.3, y + bodyH - 1], [cx + dw * 1.3, y + bodyH - 1], [cx + dw / 2, y + bodyH + dw * 0.7], [cx - dw / 2, y + bodyH + dw * 0.7]]));
      }
      return out;
    }
    case 'wave': {
      const amp = s.amplitude ?? Math.min(h * 0.12, 8);
      const period = s.period ?? Math.max(24, w / 6);
      const side = s.side ?? 'top';
      const top = side === 'top' || side === 'both';
      const bot = side === 'bottom' || side === 'both';
      const r = Math.min(s.radius ?? 0, w / 4);
      const n = Math.max(16, Math.ceil(w / 2));
      const pts: Pt[] = [];
      for (let i = 0; i <= n; i++) {
        const px = x + (w * i) / n;
        pts.push([px, top ? y + amp + Math.sin(((px - x) / period) * TAU) * amp : y]);
      }
      if (!bot && r > 0) {
        for (const [cx, a0] of [[x + w - r, 0], [x + r, Math.PI / 2]] as Array<[number, number]>)
          for (let i = 0; i <= 8; i++) {
            const a = a0 + (i / 8) * (Math.PI / 2);
            pts.push([cx + Math.cos(a) * r, y + h - r + Math.sin(a) * r]);
          }
      } else
        for (let i = n; i >= 0; i--) {
          const px = x + (w * i) / n;
          pts.push([px, bot ? y + h - amp + Math.sin(((px - x) / period) * TAU + Math.PI) * amp : y + h]);
        }
      return [cw(pts)];
    }
    case 'studs': {
      const cols = Math.max(1, s.cols ?? Math.max(1, Math.round(w / h)));
      const rows = Math.max(1, s.rows ?? 1);
      const cwid = w / cols;
      const chei = h / rows;
      const r = (s.radius ?? 0.36) * Math.min(cwid, chei);
      const out: Pt[][] = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push(cw(ring(x + cwid * (i + 0.5), y + chei * (j + 0.5), r, r, 0, TAU, 40)));
      return out;
    }
    case 'leaf': {
      const a = ((s.angle ?? 0) * Math.PI) / 180;
      const len = Math.max(w, h) / 2;
      const wid = Math.min(w, h) * 0.5;
      const pts: Pt[] = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        pts.push([-len + 2 * len * t, -Math.sin(Math.PI * t) * wid * (1 - 0.3 * t)]);
      }
      for (let i = 39; i > 0; i--) {
        const t = i / 40;
        pts.push([-len + 2 * len * t, Math.sin(Math.PI * t) * wid * (1 - 0.3 * t)]);
      }
      const k = w >= h ? 1 : 0;
      const turn = a + (k ? 0 : Math.PI / 2);
      return [cw(pts.map(([px, py]) => [x + w / 2 + px * Math.cos(turn) - py * Math.sin(turn), y + h / 2 + px * Math.sin(turn) + py * Math.cos(turn)] as Pt))];
    }
    case 'ring': {
      const t = s.thickness;
      return [cw(ring(x + w / 2, y + h / 2, w / 2, h / 2, 0, TAU, 96)), [...cw(ring(x + w / 2, y + h / 2, Math.max(0.5, w / 2 - t), Math.max(0.5, h / 2 - t), 0, TAU, 96))].reverse()];
    }
    case 'stairs': {
      const st = Math.max(0.5, s.step);
      const n = Math.max(0, Math.min(s.steps ?? 2, Math.floor(Math.min(w, h) / (2 * st)) - 1));
      const pts: Pt[] = [[x, y + n * st]];
      for (let i = 0; i < n; i++) pts.push([x + (i + 1) * st, y + (n - i) * st], [x + (i + 1) * st, y + (n - i - 1) * st]);
      pts.push([x + w - n * st, y]);
      for (let i = 0; i < n; i++) pts.push([x + w - (n - i) * st, y + (i + 1) * st], [x + w - (n - i - 1) * st, y + (i + 1) * st]);
      pts.push([x + w, y + h - n * st]);
      for (let i = 0; i < n; i++) pts.push([x + w - (i + 1) * st, y + h - (n - i) * st], [x + w - (i + 1) * st, y + h - (n - i - 1) * st]);
      pts.push([x + n * st, y + h]);
      for (let i = 0; i < n; i++) pts.push([x + (n - i) * st, y + h - (i + 1) * st], [x + (n - i - 1) * st, y + h - (i + 1) * st]);
      return [cw(pts)];
    }
    case 'arrow': {
      const head = s.head ?? 0.45;
      const shaft = s.shaft ?? 0.45;
      // Pointing right in a unit box, then turned.
      const u: Array<[number, number]> = [[0, 0.5 - shaft / 2], [1 - head, 0.5 - shaft / 2], [1 - head, 0], [1, 0.5], [1 - head, 1], [1 - head, 0.5 + shaft / 2], [0, 0.5 + shaft / 2]];
      const dir = s.dir ?? 'right';
      const map = ([a, b]: [number, number]): Pt => (dir === 'right' ? [x + a * w, y + b * h] : dir === 'left' ? [x + (1 - a) * w, y + b * h] : dir === 'down' ? [x + b * w, y + a * h] : [x + b * w, y + (1 - a) * h]);
      return [cw(rounded(u.map(map), Math.min(w, h) * 0.04))];
    }
    case 'text':
      return textContours(s, x, y, w, h).contours;
  }
}

/**
 * A line of text in Roblox's own font as contours, fitted to the box (as big as fits, centred), with tracking.
 * Returns the contours and the size used.
 */
export function textContours(s: Extract<ShapeSpec, { kind: 'text' }>, x: number, y: number, w: number, h: number): { contours: Pt[][]; size: number } {
  const face = robloxFaceFor(s.font ?? 'FredokaOne', (s.weight ?? 400) >= 600, !!s.italic, s.weight);
  if (!face) return { contours: [], size: 0 };
  const tracking = s.tracking ?? 0;
  const measure = (size: number) => {
    const line = placeLine(face, s.text, size, { pixels: false });
    return { line, width: line.width + tracking * size * Math.max(0, line.cps.length - 1) };
  };
  // The size whose line fits the box: the font's ascender−descender fills the TextSize.
  let size = s.size ?? h;
  for (let i = 0; i < 40 && measure(size).width > w; i++) size *= 0.95;
  const snap = s.snap ?? 0;
  if (snap > 0) {
    size = Math.max(snap, Math.floor(size / snap) * snap);
    for (let i = 0; i < 8 && measure(size).width > w && size > snap; i++) size -= snap;
  }
  const { line, width } = measure(size);
  const k = face.pxPerUnit(size);
  let baseline = y + (h - size) / 2 + face.ascender * k;
  let x0 = x + (w - width) / 2;
  if (snap > 0) {
    baseline = Math.round(baseline);
    x0 = Math.round(x0);
  }
  const out: Pt[][] = [];
  const slant = s.italic && face.synthItalic ? 0.2 : 0;
  line.cps.forEach((cp, i) => {
    const g = face.glyph(cp);
    const gx0 = x0 + line.x[i]! + tracking * size * i;
    const gx = snap > 0 ? Math.round(gx0) : gx0;
    for (const c of g.contours) out.push(c.map(([px, py]) => [gx + px * k + py * k * slant, baseline - py * k] as Pt));
  });
  return { contours: out, size };
}

/** A shape spec with its lengths (radii, cuts, strokes of brackets, bumps, steps…) times k: design points to pixels. */
export function scaleShape(s: ShapeSpec, k: number): ShapeSpec {
  if (k === 1) return s;
  const m = (v: number | undefined) => (v === undefined ? undefined : v * k);
  switch (s.kind) {
    case 'rect':
      return { ...s, ...(s.radius !== undefined ? { radius: Array.isArray(s.radius) ? (s.radius.map((v) => v * k) as [number, number, number, number]) : s.radius * k } : {}) };
    case 'cut':
      return { ...s, cut: Array.isArray(s.cut) ? (s.cut.map((v) => v * k) as [number, number, number, number]) : s.cut * k, ...(s.slant ? { slant: [s.slant[0] * k, s.slant[1] * k] as [number, number] } : {}) };
    case 'shield':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}), ...(s.point !== undefined ? { point: m(s.point) } : {}) };
    case 'hex':
      return { ...s, ...(s.point !== undefined ? { point: m(s.point) } : {}) };
    case 'burst':
    case 'star':
      return { ...s, ...(s.round !== undefined ? { round: m(s.round) } : {}) };
    case 'ribbon':
      return { ...s, ...(s.notch !== undefined ? { notch: m(s.notch) } : {}), ...(s.fold !== undefined ? { fold: m(s.fold) } : {}) };
    case 'tab':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}) };
    case 'bubble':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}), ...(s.tail ? { tail: [s.tail[0], s.tail[1] * k, s.tail[2] * k] as [number, number, number] } : {}) };
    case 'scallop':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}), ...(s.scallop !== undefined ? { scallop: m(s.scallop) } : {}) };
    case 'cross':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}) };
    case 'brackets':
      return { ...s, ...(s.length !== undefined ? { length: m(s.length) } : {}), ...(s.thickness !== undefined ? { thickness: m(s.thickness) } : {}), ...(s.inset !== undefined ? { inset: m(s.inset) } : {}) };
    case 'rivets':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}), ...(s.inset !== undefined ? { inset: m(s.inset) } : {}), ...(s.spacing !== undefined ? { spacing: m(s.spacing) } : {}) };
    case 'frame':
      return { ...s, thickness: s.thickness * k, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}) };
    case 'polygon':
      return { ...s, ...(s.round !== undefined ? { round: m(s.round) } : {}) };
    case 'puffy':
      return { ...s, ...(s.bump !== undefined ? { bump: m(s.bump) } : {}), ...(s.radius !== undefined ? { radius: m(s.radius) } : {}) };
    case 'torn':
      return { ...s, ...(s.rough !== undefined ? { rough: m(s.rough) } : {}), ...(s.radius !== undefined ? { radius: m(s.radius) } : {}), ...(s.detail !== undefined ? { detail: m(s.detail) } : {}) };
    case 'drip':
      return { ...s, ...(s.radius !== undefined ? { radius: m(s.radius) } : {}) };
    case 'wave':
      return { ...s, ...(s.amplitude !== undefined ? { amplitude: m(s.amplitude) } : {}), ...(s.period !== undefined ? { period: m(s.period) } : {}), ...(s.radius !== undefined ? { radius: m(s.radius) } : {}) };
    case 'ring':
      return { ...s, thickness: s.thickness * k };
    case 'stairs':
      return { ...s, step: s.step * k };
    case 'text':
      return { ...s, ...(s.size !== undefined ? { size: m(s.size) } : {}) };
    default:
      return s;
  }
}
