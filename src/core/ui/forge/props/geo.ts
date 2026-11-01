import type { ShapeSpec } from '../shapes';

/**
 * Geometry for props, drawn in a 100 × 100 unit frame (y down, light from the upper left): a piece is a Forge shape
 * and the box it fills in that frame. Polygons are given as points in the frame and normalised to their own box (the
 * Forge's polygon points are 0..1 of the layer's box), so a recipe can rotate, bend and sweep outlines freely.
 */

export type P2 = [number, number];
export type Box = [x: number, y: number, w: number, h: number];
export interface Piece {
  shape: ShapeSpec;
  /** The piece's box in the unit frame. */
  at: Box;
}

const TAU = Math.PI * 2;
const rad = (deg: number) => (deg * Math.PI) / 180;

export const ell = (cx: number, cy: number, rx: number, ry = rx): Piece => ({ shape: { kind: 'ellipse' }, at: [cx - rx, cy - ry, rx * 2, ry * 2] });
export const circ = (cx: number, cy: number, r: number): Piece => ell(cx, cy, r, r);
/** A rounded box (radius in units, or per corner: top-left, top-right, bottom-right, bottom-left). */
export const box = (x: number, y: number, w: number, h: number, radius: number | [number, number, number, number] = 0): Piece => ({ shape: { kind: 'rect', radius }, at: [x, y, w, h] });
export const pill = (x: number, y: number, w: number, h: number): Piece => ({ shape: { kind: 'pill' }, at: [x, y, w, h] });
export const ringP = (cx: number, cy: number, rx: number, ry: number, thickness: number): Piece => ({ shape: { kind: 'ring', thickness }, at: [cx - rx, cy - ry, rx * 2, ry * 2] });
export const starP = (cx: number, cy: number, r: number, o: { points?: number; inner?: number; round?: number } = {}): Piece => ({ shape: { kind: 'star', points: o.points ?? 5, inner: o.inner ?? 0.48, round: o.round ?? r * 0.08 }, at: [cx - r, cy - r, r * 2, r * 2] });
export const sparkleP = (cx: number, cy: number, r: number, pinch = 0.6): Piece => ({ shape: { kind: 'sparkle', pinch }, at: [cx - r, cy - r, r * 2, r * 2] });
export const heartP = (cx: number, cy: number, w: number, h: number): Piece => ({ shape: { kind: 'heart' }, at: [cx - w / 2, cy - h / 2, w, h] });
export const glyphP = (name: string, cx: number, cy: number, size: number, weight = 3, solid = false): Piece => ({ shape: { kind: 'glyph', name, weight, solid }, at: [cx - size / 2, cy - size / 2, size, size] });
export const shieldP = (x: number, y: number, w: number, h: number, radius?: number, point?: number): Piece => ({ shape: { kind: 'shield', ...(radius !== undefined ? { radius } : {}), ...(point !== undefined ? { point } : {}) }, at: [x, y, w, h] });
/** A leaf (pointed oval) len long and wid wide at its widest, turned by angle (degrees) round its centre. */
export const leafP = (cx: number, cy: number, len: number, wid: number, angle: number): Piece => {
  // The Forge's leaf lies along its box's longer side (its width the shorter side), turned round the box's centre.
  const w = Math.max(len, wid * 1.0001);
  return { shape: { kind: 'leaf', angle }, at: [cx - w / 2, cy - wid / 2, w, Math.min(wid, w * 0.9999)] };
};

/** A polygon through points in the unit frame (rounded corners in units). */
export function poly(raw: P2[], round = 0): Piece {
  // Repeated points (a path closing on its start) are dropped: rounding a corner divides by its edges' lengths.
  const pts = raw.filter((p, i) => {
    const q = raw[(i + raw.length - 1) % raw.length]!;
    return raw.length < 2 || Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
  });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const w = Math.max(1e-3, x1 - x0);
  const h = Math.max(1e-3, y1 - y0);
  return { shape: { kind: 'polygon', points: pts.map(([x, y]) => [(x - x0) / w, (y - y0) / h] as [number, number]), round }, at: [x0, y0, w, h] };
}

/** Points turned by deg (clockwise on screen) round (cx, cy). */
export const rot = (pts: P2[], deg: number, cx = 50, cy = 50): P2[] => {
  const a = rad(deg);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};
export const scalePts = (pts: P2[], k: number, cx = 50, cy = 50): P2[] => pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);

/** Points round an ellipse (turned by deg), from a0 to a1 degrees (0 = right, 90 = down). */
export function ellPts(cx: number, cy: number, rx: number, ry: number, o: { rot?: number; a0?: number; a1?: number; n?: number } = {}): P2[] {
  const a0 = rad(o.a0 ?? 0);
  const a1 = rad(o.a1 ?? 360);
  const full = Math.abs(a1 - a0) >= TAU - 1e-9;
  const n = o.n ?? 48;
  const pts: P2[] = [];
  for (let i = 0; i < (full ? n : n + 1); i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return o.rot ? rot(pts, o.rot, cx, cy) : pts;
}

/** A turned ellipse as a polygon. */
export const ellR = (cx: number, cy: number, rx: number, ry: number, deg: number): Piece => poly(ellPts(cx, cy, rx, ry, { rot: deg, n: 56 }));

/** A ring sector (an arc band) between radii r0 and r1 from a0 to a1 degrees. */
export function arcBand(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, n = 40): P2[] {
  return [...ellPts(cx, cy, r1, r1, { a0, a1, n }), ...ellPts(cx, cy, r0, r0, { a0: a1, a1: a0, n })];
}

/** A quadratic Bézier from p0 through control c to p1. */
export function quad(p0: P2, c: P2, p1: P2, n = 16): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

/** A cubic Bézier. */
export function cubic(p0: P2, c0: P2, c1: P2, p1: P2, n = 20): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0], u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1]]);
  }
  return out;
}

/** Joins point runs, dropping a point that repeats the previous run's last. */
export function path(...runs: P2[][]): P2[] {
  const out: P2[] = [];
  for (const r of runs)
    for (const p of r) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
      out.push(p);
    }
  return out;
}

/**
 * A thick line along a smooth open path as one outline: both sides offset by half the width, round caps. Bends must be
 * gentler than the half width (the inside of a sharp bend would fold over).
 */
export function strokePts(pts: P2[], width: number, caps: 'round' | 'flat' = 'round'): P2[] {
  const h = width / 2;
  const n = pts.length;
  const normal = (i: number): P2 => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(n - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const left: P2[] = [];
  const right: P2[] = [];
  for (let i = 0; i < n; i++) {
    const [nx, ny] = normal(i);
    const p = pts[i]!;
    left.push([p[0] + nx * h, p[1] + ny * h]);
    right.push([p[0] - nx * h, p[1] - ny * h]);
  }
  const cap = (p: P2, from: P2, k = 10): P2[] => {
    if (caps === 'flat') return [];
    // A half circle round p starting at `from`.
    const a0 = Math.atan2(from[1] - p[1], from[0] - p[0]);
    const out: P2[] = [];
    for (let i = 1; i < k; i++) {
      const a = a0 - (Math.PI * i) / k;
      out.push([p[0] + Math.cos(a) * h, p[1] + Math.sin(a) * h]);
    }
    return out;
  };
  return [...left, ...cap(pts[n - 1]!, left[n - 1]!), ...right.reverse(), ...cap(pts[0]!, right[right.length - 1]!)];
}

/**
 * A thick line along a smooth open path with round ends bulging outwards (a rod, a strap, a straw, a fork leg): both
 * sides offset by half the width, joined by a half circle at each end. Bends must be gentler than the half width.
 */
export function rodPts(pts: P2[], width: number, k = 10): P2[] {
  const h = width / 2;
  const sides = strokePts(pts, width, 'flat');
  const n = pts.length;
  const left = sides.slice(0, n);
  const right = sides.slice(n);
  // A half circle round p from `from`, turning away from the line (outwards).
  const cap = (p: P2, from: P2): P2[] => {
    const a0 = Math.atan2(from[1] - p[1], from[0] - p[0]);
    return Array.from({ length: k - 1 }, (_, i) => {
      const a = a0 - (Math.PI * (i + 1)) / k;
      return [p[0] + Math.cos(a) * h, p[1] + Math.sin(a) * h] as P2;
    });
  };
  return [...left, ...cap(pts[n - 1]!, left[n - 1]!), ...right, ...cap(pts[0]!, right[right.length - 1]!)];
}

/** A rounded rectangle (centre, size) turned by deg, as a polygon. */
export function rbox(cx: number, cy: number, w: number, h: number, deg: number, r = 0): Piece {
  return poly(rot([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], deg, cx, cy), r);
}

/** An egg's outline: narrower above, fuller below. */
export function eggPts(cx: number, cy: number, rx: number, ry: number, k = 0.14, n = 72): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    const s = Math.sin(t);
    pts.push([cx + Math.cos(t) * rx * (1 + k * s), cy + s * ry]);
  }
  return pts;
}

/** Shrinks a closed outline towards its centroid (an inset copy for an inner face). */
export function inset(pts: P2[], k: number): P2[] {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return scalePts(pts, k, cx, cy);
}

/** Mirrors points across the vertical line x = cx. */
export const mirror = (pts: P2[], cx = 50): P2[] => pts.map(([x, y]) => [2 * cx - x, y] as P2).reverse();

/** The part of a closed outline where a·x + b·y + c ≥ 0 (Sutherland–Hodgman against one line). */
export function clipHalf(pts: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [];
  const side = (p: P2) => a * p[0] + b * p[1] + c;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if (sp >= 0 !== sq >= 0) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** The part of a closed outline below y (a liquid in its vessel). */
export const clipBelow = (pts: P2[], y: number): P2[] => clipHalf(pts, 0, 1, -y);

/** A stroke along a path whose width runs from w0 to w1 (0: a point) — horns, manes, feathers, flames. */
export function taper(pts: P2[], w0: number, w1: number): P2[] {
  const n = pts.length;
  let total = 0;
  const at: number[] = [0];
  for (let i = 1; i < n; i++) at.push((total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])));
  const left: P2[] = [];
  const right: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(n - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const h = (w0 + (w1 - w0) * (at[i]! / (total || 1))) / 2;
    const p = pts[i]!;
    left.push([p[0] - (dy / l) * h, p[1] + (dx / l) * h]);
    right.push([p[0] + (dy / l) * h, p[1] - (dx / l) * h]);
  }
  return [...left, ...right.reverse()];
}

/** A heart's outline as points (so it can turn): point down at angle 0. */
export function heartPts(cx: number, cy: number, s: number, deg: number): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    const hx = 16 * Math.sin(t) ** 3;
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + (hx / 34) * s, cy - ((hy + 2) / 30) * s]);
  }
  return rot(pts, deg, cx, cy);
}

/** A regular polygon (n sides) round (cx, cy), first corner at deg. */
export const ngon = (cx: number, cy: number, r: number, n: number, deg = -90, ry = r): P2[] => Array.from({ length: n }, (_, i) => [cx + Math.cos(((deg + (360 * i) / n) * Math.PI) / 180) * r, cy + Math.sin(((deg + (360 * i) / n) * Math.PI) / 180) * ry] as P2);
