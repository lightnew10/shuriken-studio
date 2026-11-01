import type { Vec3 } from '../curves';

/**
 * The small vector and rotation math the effect player shares with its renderers. Rotations are 3x3
 * matrices (row-major) with Roblox's conventions: x right, y up, -z forward, and
 * CFrame.Angles(rx, ry, rz) = Rx * Ry * Rz.
 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** A placement: a position and a rotation (a CFrame). */
export interface Xf {
  p: Vec3;
  r: Mat3;
}

export const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const rad = (deg: number) => (deg * Math.PI) / 180;

export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 => {
  const l = vlen(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
};
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const mmul = (a: Mat3, b: Mat3): Mat3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
  a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
  a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
  a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
  a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
  a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
  a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
export const mapply = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** CFrame.Angles in degrees. */
export const angles = (deg: Vec3 | undefined): Mat3 => (deg ? mmul(mmul(rotX(rad(deg[0])), rotY(rad(deg[1]))), rotZ(rad(deg[2]))) : I3);
/** CFrame.Angles in radians. */
export const anglesRad = (x: number, y: number, z: number): Mat3 => mmul(mmul(rotX(x), rotY(y)), rotZ(z));

/** A rotation from its three axes (CFrame.fromMatrix): columns right, up, back. */
export const fromAxes = (right: Vec3, up: Vec3, back: Vec3): Mat3 => [right[0], up[0], back[0], right[1], up[1], back[1], right[2], up[2], back[2]];

/** CFrame.lookAt's rotation: -z along `dir`, y as close to `up` as it gets. */
export function lookRotation(dir: Vec3, up: Vec3 = [0, 1, 0]): Mat3 {
  const d = vnorm(dir, [0, 0, -1]);
  let u = up;
  if (Math.abs(vdot(d, vnorm(u))) > 0.999) u = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const right = vnorm(vcross(d, u), [1, 0, 0]);
  return fromAxes(right, vcross(right, d), vmul(d, -1));
}

export const xf = (p: Vec3 = [0, 0, 0], r: Mat3 = I3): Xf => ({ p, r });
export const xfMul = (a: Xf, b: Xf): Xf => ({ p: vadd(a.p, mapply(a.r, b.p)), r: mmul(a.r, b.r) });
export const xfPoint = (a: Xf, v: Vec3): Vec3 => vadd(a.p, mapply(a.r, v));

/** A small seeded generator (mulberry32): the same seed plays the same effect. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (n: number, seed: number) => {
  const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Smooth noise in -1..1 over t (value noise; stands in for Roblox's math.noise). */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return (hash(i, seed) + (hash(i + 1, seed) - hash(i, seed)) * u) * 2 - 1;
}
