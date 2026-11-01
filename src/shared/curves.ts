/**
 * The motion math of the generated ShurikenCurves module, in TypeScript: the same easings, data curves and
 * arc-length paths, so Shuriken can measure an effect, frame a cutscene's camera and check a path offline
 * exactly as the game will play it. Keep the two in step (tests compare known values).
 */
import type { ColorCurve, Curve, Ease } from './effects';

export type Vec3 = [number, number, number];

const PI = Math.PI;
const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
const C4 = (2 * PI) / 3;

const powIn = (p: number) => (t: number) => t ** p;
const powOut = (p: number) => (t: number) => 1 - (1 - t) ** p;
const powInOut = (p: number) => (t: number) => (t < 0.5 ? 2 ** (p - 1) * t ** p : 1 - (-2 * t + 2) ** p / 2);
function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

export const EASE_FUNCTIONS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  step: (t) => (t < 1 ? 0 : 1),
  sineIn: (t) => 1 - Math.cos((t * PI) / 2),
  sineOut: (t) => Math.sin((t * PI) / 2),
  sineInOut: (t) => -(Math.cos(PI * t) - 1) / 2,
  quadIn: powIn(2),
  quadOut: powOut(2),
  quadInOut: powInOut(2),
  cubicIn: powIn(3),
  cubicOut: powOut(3),
  cubicInOut: powInOut(3),
  quartIn: powIn(4),
  quartOut: powOut(4),
  quartInOut: powInOut(4),
  quintIn: powIn(5),
  quintOut: powOut(5),
  quintInOut: powInOut(5),
  expoIn: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  expoOut: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  expoInOut: (t) => (t <= 0 || t >= 1 ? t : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  circIn: (t) => 1 - Math.sqrt(1 - t * t),
  circOut: (t) => Math.sqrt(1 - (t - 1) ** 2),
  circInOut: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
  backIn: (t) => C3 * t * t * t - C1 * t * t,
  backOut: (t) => 1 + C3 * (t - 1) ** 3 + C1 * (t - 1) ** 2,
  backInOut: (t) => (t < 0.5 ? ((2 * t) ** 2 * ((C2 + 1) * 2 * t - C2)) / 2 : ((2 * t - 2) ** 2 * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2),
  elasticIn: (t) => (t <= 0 || t >= 1 ? t : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * C4)),
  elasticOut: (t) => (t <= 0 || t >= 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1),
  bounceIn: (t) => 1 - bounceOut(1 - t),
  bounceOut,
};

/** CSS cubic-bezier(x1, y1, x2, y2) as an easing (Newton's method on x, as ShurikenCurves.bezierEase). */
export function bezierEase(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (t: number, a: number, b: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  const slope = (t: number, a: number, b: number) => {
    const u = 1 - t;
    return 3 * a * u * u + 6 * (b - a) * u * t + 3 * (1 - b) * t * t;
  };
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - (at(t, x1, x2) - x) / d));
    }
    return at(t, y1, y2);
  };
}

export function easer(ease: Ease | undefined): (t: number) => number {
  if (Array.isArray(ease) && ease.length === 4) return bezierEase(ease[0], ease[1], ease[2], ease[3]);
  if (typeof ease === 'string' && EASE_FUNCTIONS[ease]) return EASE_FUNCTIONS[ease]!;
  return EASE_FUNCTIONS.linear!;
}

function keysOf<T>(curve: T | T[] | { keys: Array<[number, T]>; ease?: Ease }): { keys: Array<[number, T]>; ease?: Ease } {
  if (Array.isArray(curve)) return { keys: curve.map((v, i) => [curve.length > 1 ? i / (curve.length - 1) : 0, v] as [number, T]) };
  if (curve && typeof curve === 'object' && 'keys' in (curve as object)) return curve as { keys: Array<[number, T]>; ease?: Ease };
  return { keys: [[0, curve as T]] };
}

/** A number curve at t (0..1): Curves.sample. */
export function sampleCurve(curve: Curve | undefined, t: number, fallback = 0): number {
  if (curve === undefined) return fallback;
  if (typeof curve === 'number') return curve;
  const { keys, ease } = keysOf<number>(curve);
  if (!keys.length) return fallback;
  if (keys.length === 1 || t <= keys[0]![0]) return keys[0]![1];
  if (t >= keys[keys.length - 1]![0]) return keys[keys.length - 1]![1];
  const f = easer(ease);
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i]!;
    const [t1, v1] = keys[i + 1]!;
    if (t <= t1) return v0 + (v1 - v0) * f(t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  }
  return keys[keys.length - 1]![1];
}

export const hexToRgb = (h: string): Vec3 => {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
};
export const rgbToHex = (c: Vec3): string => `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

/** A colour curve at t, as RGB 0..1. */
export function sampleColor(curve: ColorCurve | undefined, t: number, fallback = '#ffffff'): Vec3 {
  if (curve === undefined) return hexToRgb(fallback);
  if (typeof curve === 'string') return hexToRgb(curve);
  const { keys, ease } = keysOf<string>(curve);
  if (!keys.length) return hexToRgb(fallback);
  if (keys.length === 1 || t <= keys[0]![0]) return hexToRgb(keys[0]![1]);
  if (t >= keys[keys.length - 1]![0]) return hexToRgb(keys[keys.length - 1]![1]);
  const f = easer(ease);
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, c0] = keys[i]!;
    const [t1, c1] = keys[i + 1]!;
    if (t <= t1) {
      const k = f(t1 > t0 ? (t - t0) / (t1 - t0) : 1);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return hexToRgb(keys[keys.length - 1]![1]);
}

/** A curve as at most 20 [t, value] keypoints (what a NumberSequence holds). */
export function curveKeys(curve: Curve, scale = 1): Array<[number, number]> {
  if (typeof curve === 'number') return [[0, curve * scale]];
  if (Array.isArray(curve)) return curve.slice(0, 20).map((v, i, a) => [a.length > 1 ? i / (a.length - 1) : 0, v * scale]);
  // Keyed with an easing: sampled so the sequence follows the eased shape.
  const n = !curve.ease || curve.ease === 'linear' ? 0 : 16;
  if (!n) return curve.keys.slice(0, 20).map(([t, v]) => [t, v * scale]);
  return Array.from({ length: n }, (_, i) => [i / (n - 1), sampleCurve(curve, i / (n - 1)) * scale] as [number, number]);
}

/** A colour curve as at most 20 [t, hex] keypoints (a ColorSequence). */
export function colorKeys(curve: ColorCurve): Array<[number, string]> {
  if (typeof curve === 'string') return [[0, curve]];
  if (Array.isArray(curve)) return curve.slice(0, 20).map((c, i, a) => [a.length > 1 ? i / (a.length - 1) : 0, c]);
  const n = !curve.ease || curve.ease === 'linear' ? 0 : 12;
  if (!n) return curve.keys.slice(0, 20);
  return Array.from({ length: n }, (_, i) => [i / (n - 1), rgbToHex(sampleColor(curve, i / (n - 1)))] as [number, string]);
}

// ─── Paths (arc-length parameterised) ─────────────────────────────────────────

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export interface Path {
  length: number;
  /** u 0..1 by distance along the path. */
  at(u: number): Vec3;
  tangent(u: number): Vec3;
  raw(s: number): Vec3;
  param(u: number): number;
}

export function fromFunction(f: (s: number) => Vec3, samples = 64): Path {
  const n = Math.min(4000, Math.max(2, Math.floor(samples)));
  const cum = new Float64Array(n + 1);
  let prev = f(0);
  for (let i = 1; i <= n; i++) {
    const p = f(i / n);
    cum[i] = cum[i - 1]! + len(sub(p, prev));
    prev = p;
  }
  const total = cum[n]!;
  const param = (u: number) => {
    const k = Math.min(1, Math.max(0, u));
    if (total <= 1e-9) return k;
    const target = k * total;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < target) lo = mid;
      else hi = mid;
    }
    const span = cum[hi]! - cum[lo]!;
    return (lo + (span > 0 ? (target - cum[lo]!) / span : 0)) / n;
  };
  const h = 0.5 / n;
  const tangentAt = (s: number): Vec3 => {
    const d = sub(f(Math.min(1, s + h)), f(Math.max(0, s - h)));
    const l = len(d);
    return l > 1e-9 ? mul(d, 1 / l) : [0, 0, 1];
  };
  return { length: total, at: (u) => f(param(u)), tangent: (u) => tangentAt(param(u)), raw: (s) => f(Math.min(1, Math.max(0, s))), param };
}

export function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): Path {
  return fromFunction((t) => {
    const u = 1 - t;
    return add(add(mul(p0, u * u * u), mul(p1, 3 * u * u * t)), add(mul(p2, 3 * u * t * t), mul(p3, t * t * t)));
  }, 96);
}

export function quadratic(p0: Vec3, p1: Vec3, p2: Vec3): Path {
  return fromFunction((t) => {
    const u = 1 - t;
    return add(add(mul(p0, u * u), mul(p1, 2 * u * t)), mul(p2, t * t));
  }, 64);
}

export function polyline(points: Vec3[]): Path {
  const pts = points.length >= 2 ? points : [points[0] ?? [0, 0, 0], points[0] ?? [0, 0, 0]];
  const segments = pts.length - 1;
  return fromFunction((s) => {
    const scaled = Math.min(1, Math.max(0, s)) * segments;
    const i = Math.min(Math.floor(scaled), segments - 1);
    return lerp3(pts[i]!, pts[i + 1]!, scaled - i);
  }, segments * 8);
}

/** Centripetal Catmull-Rom through the points (alpha 0.5), as ShurikenCurves.catmullRom. */
export function catmullRom(points: Vec3[], alpha = 0.5, closed = false): Path {
  const count = points.length;
  if (count < 2) return polyline(points);
  const segments = closed ? count : count - 1;
  const get = (i: number): Vec3 => {
    if (closed) return points[(((i - 1) % count) + count) % count]!;
    if (i < 1) return add(points[0]!, sub(points[0]!, points[1]!));
    if (i > count) return add(points[count - 1]!, sub(points[count - 1]!, points[count - 2]!));
    return points[i - 1]!;
  };
  const knot = (p: Vec3, q: Vec3) => Math.max(len(sub(q, p)) ** alpha, 1e-4);
  const segment = (i: number, t: number): Vec3 => {
    const [p0, p1, p2, p3] = [get(i - 1), get(i), get(i + 1), get(i + 2)];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const x = t1 + (t2 - t1) * t;
    const a1 = add(mul(p0, (t1 - x) / (t1 - t0)), mul(p1, (x - t0) / (t1 - t0)));
    const a2 = add(mul(p1, (t2 - x) / (t2 - t1)), mul(p2, (x - t1) / (t2 - t1)));
    const a3 = add(mul(p2, (t3 - x) / (t3 - t2)), mul(p3, (x - t2) / (t3 - t2)));
    const b1 = add(mul(a1, (t2 - x) / (t2 - t0)), mul(a2, (x - t0) / (t2 - t0)));
    const b2 = add(mul(a2, (t3 - x) / (t3 - t1)), mul(a3, (x - t1) / (t3 - t1)));
    return add(mul(b1, (t2 - x) / (t2 - t1)), mul(b2, (x - t1) / (t2 - t1)));
  };
  return fromFunction((s) => {
    const scaled = Math.min(1, Math.max(0, s)) * segments;
    const i = Math.min(Math.floor(scaled), segments - 1);
    return segment(i + 1, scaled - i);
  }, Math.min(48 * segments, 4000));
}

/** An arc about the Y axis at the origin: 0° = -Z (forward), positive angles turn left (toward -X). */
export function arc(radius: number, fromDeg: number, toDeg: number): Path {
  const a0 = (fromDeg * PI) / 180;
  const a1 = (toDeg * PI) / 180;
  // CFrame.Angles(0, a, 0) * (0, 0, -r) = (-r sin a, 0, -r cos a).
  return fromFunction((s) => {
    const a = a0 + (a1 - a0) * s;
    return [-radius * Math.sin(a), 0, -radius * Math.cos(a)];
  }, Math.min(720, Math.max(8, Math.ceil(Math.abs(toDeg - fromDeg) / 3))));
}

/** A helix about the Y axis (ShurikenCurves.spiral at the origin). */
export function spiral(r0: number, r1: number, turns: number, height: number): Path {
  return fromFunction((s) => {
    const a = s * turns * 2 * PI;
    const r = r0 + (r1 - r0) * s;
    return [Math.sin(a) * r, height * s, -Math.cos(a) * r];
  }, Math.min(4000, Math.max(16, Math.ceil(turns * 64))));
}

/** A lob whose apex is `height` above the higher end (ShurikenCurves.ballistic). */
export function ballistic(from: Vec3, to: Vec3, height: number): Path {
  const top = Math.max(from[1], to[1]) + Math.max(height, 0);
  const mid = lerp3(from, to, 0.5);
  return quadratic(from, [mid[0], 2 * top - (from[1] + to[1]) / 2, mid[2]], to);
}
