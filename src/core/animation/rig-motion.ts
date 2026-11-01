import { readFileSync } from 'node:fs';
import { clipDuration, ease, sampleClip, type AnimationClip, type Easing, type EasingDir, type JointPose, type Priority } from '@shared/animation';
import { anglesMatrix, jointOrder, type RigClipMetrics, type RigJoint, type RigSpec, type Vec3, type Xform } from '@shared/rig';

export type { RigClipMetrics };
import { ModelStore } from '../modeling/model-store';

/**
 * Custom rigs in motion, offline: a rigged model's geometry at rest, forward kinematics that match its
 * Motor6Ds in Studio (see @shared/rig), a small IK solver for its legs and chains, the checks run on its
 * clips (ground, planted feet, limits, reach at markers) and the procedural generators agents use instead
 * of keying frames: gaits for any number of legs, slither, idle, lunge, sting, slam, hit react and death.
 */

// ─── Geometry ────────────────────────────────────────────────────────────────

/** A rigged model at rest: its rig, and sample points of its surface per segment (model space, studs). */
export interface RigBody {
  rig: RigSpec;
  /** Segment (joint) name → flat [x, y, z, x, y, z, …]. */
  points: Record<string, number[]>;
}

/** The rigged model's rig and its parts' vertices (a sample of each mesh, extremes always kept). */
export function loadRigBody(root: string, model: string): RigBody | null {
  const store = new ModelStore(root);
  const rig = store.rig(model);
  if (!rig) return null;
  const names = new Set(rig.joints.map((j) => j.name));
  const points: Record<string, number[]> = {};
  for (const p of store.parts(model)) {
    const seg = p.segment && names.has(p.segment) ? p.segment : rig.root;
    const o = p.origin ?? [0, 0, 0];
    const out = (points[seg] ??= []);
    let v: number[] = [];
    try {
      v = (JSON.parse(readFileSync(store.paths(p.name).mesh, 'utf8')) as { v?: number[] }).v ?? [];
    } catch {
      v = [];
    }
    const n = Math.floor(v.length / 3);
    if (n) {
      const keep = new Set<number>();
      const step = Math.max(1, Math.ceil(n / 1200));
      for (let i = 0; i < n; i += step) keep.add(i);
      for (let a = 0; a < 3; a++) {
        let lo = 0;
        let hi = 0;
        for (let i = 1; i < n; i++) {
          if (v[i * 3 + a]! < v[lo * 3 + a]!) lo = i;
          if (v[i * 3 + a]! > v[hi * 3 + a]!) hi = i;
        }
        keep.add(lo).add(hi);
      }
      for (const i of keep) out.push(v[i * 3]! + o[0], v[i * 3 + 1]! + o[1], v[i * 3 + 2]! + o[2]);
    } else {
      // No mesh on disk: the part's box corners.
      const [hx, hy, hz] = p.size.map((x) => x / 2) as Vec3;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(o[0] + sx * hx, o[1] + sy * hy, o[2] + sz * hz);
    }
  }
  return { rig, points };
}

// ─── Small rigid-body math (row-major 3×3) ───────────────────────────────────

type M3 = number[];
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];
const ID: Xform = { r: I3, t: ZERO };
const RAD = Math.PI / 180;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mulS = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? mulS(a, 1 / l) : [0, 0, 0];
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mix = (a: number, b: number, f: number) => a + (b - a) * f;

function mul3(a: M3, b: M3): M3 {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return o;
}
const tr3 = (a: M3): M3 => [a[0]!, a[3]!, a[6]!, a[1]!, a[4]!, a[7]!, a[2]!, a[5]!, a[8]!];
const mv = (a: M3, v: Vec3): Vec3 => [a[0]! * v[0] + a[1]! * v[1] + a[2]! * v[2], a[3]! * v[0] + a[4]! * v[1] + a[5]! * v[2], a[6]! * v[0] + a[7]! * v[1] + a[8]! * v[2]];
const xp = (x: Xform, v: Vec3): Vec3 => add(mv(x.r, v), x.t);

/** Rotation by `deg` about the unit axis u. */
function axisAngle(u: Vec3, deg: number): M3 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  const k = 1 - c;
  const [x, y, z] = u;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/** CFrame.Angles order (Rx·Ry·Rz) angles of a rotation, in degrees. */
function euler(r: M3): Vec3 {
  const sy = clamp(r[2]!, -1, 1);
  if (Math.abs(sy) > 0.99999) return [Math.atan2(r[7]!, r[4]!) / RAD, sy > 0 ? 90 : -90, 0];
  return [Math.atan2(-r[5]!, r[8]!) / RAD, Math.asin(sy) / RAD, Math.atan2(-r[1]!, r[0]!) / RAD];
}

/** The rotation vector (axis × angle, degrees). */
function rotVec(r: M3): Vec3 {
  const c = clamp((r[0]! + r[4]! + r[8]! - 1) / 2, -1, 1);
  const th = Math.acos(c);
  if (th < 1e-6) return [0, 0, 0];
  const s = Math.sin(th);
  if (s < 1e-6) {
    // 180°: the axis from the diagonal.
    const ax = unit([Math.sqrt(Math.max(0, (r[0]! + 1) / 2)), Math.sqrt(Math.max(0, (r[4]! + 1) / 2)), Math.sqrt(Math.max(0, (r[8]! + 1) / 2))]);
    return mulS(ax, 180);
  }
  return mulS([(r[7]! - r[5]!) / (2 * s), (r[2]! - r[6]!) / (2 * s), (r[3]! - r[1]!) / (2 * s)], th / RAD);
}

/** The smallest rotation taking direction a to direction b, at most `maxDeg`. */
function rotBetween(a: Vec3, b: Vec3, maxDeg: number): M3 {
  const ua = unit(a);
  const ub = unit(b);
  const ax = cross(ua, ub);
  const s = len(ax);
  const c = dot(ua, ub);
  if (s < 1e-9) return I3;
  return axisAngle(mulS(ax, 1 / s), Math.min(maxDeg, Math.atan2(s, c) / RAD));
}

// ─── The rig in use ──────────────────────────────────────────────────────────

interface JointState {
  R: M3;
  pos: Vec3;
  /** A hinge's angle about its axis (degrees). */
  angle?: number;
}
type Pose = Map<string, JointState>;

interface Leg {
  index: number;
  chain: RigJoint[];
  foot: string;
  /** Where the foot meets the ground at rest. */
  sole: Vec3;
  /** -1 left, 1 right, 0 middle. */
  side: -1 | 0 | 1;
  /** Hip to sole at rest (studs), and the hip's height over the sole. */
  span: number;
  height: number;
  /**
   * A flat foot on its own joint (wider than tall, like a paw or a boot): the leg plants its ankle and
   * keeps the foot level. Otherwise the foot's lowest point is the contact (a spider's leg tip).
   */
  flat: boolean;
}

interface Ctx {
  rig: RigSpec;
  order: RigJoint[];
  byName: Map<string, RigJoint>;
  points: Record<string, number[]>;
  ground: number;
  top: number;
  /** Rest extents: front is -Z. */
  front: number;
  back: number;
  width: number;
  length: number;
  height: number;
  /** The root joint's height over the ground at rest (a body's own scale, without tails or horns). */
  bodyH: number;
  root: RigJoint;
  legs: Leg[];
  legJoints: Set<string>;
  /** Centre of each segment's points at rest. */
  centre: Map<string, Vec3>;
}

function context(body: RigBody): Ctx {
  const rig = body.rig;
  const order = jointOrder(rig);
  const byName = new Map(rig.joints.map((j) => [j.name, j]));
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const centre = new Map<string, Vec3>();
  for (const [seg, pts] of Object.entries(body.points)) {
    let c: Vec3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i += 3) {
      const p: Vec3 = [pts[i]!, pts[i + 1]!, pts[i + 2]!];
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
      c = add(c, p);
    }
    if (pts.length) centre.set(seg, mulS(c, 3 / pts.length));
  }
  if (!Number.isFinite(lo[0])) {
    // No geometry: the pivots stand in.
    for (const j of rig.joints) {
      lo = [Math.min(lo[0], j.pivot[0]), Math.min(lo[1], j.pivot[1]), Math.min(lo[2], j.pivot[2])];
      hi = [Math.max(hi[0], j.pivot[0]), Math.max(hi[1], j.pivot[1]), Math.max(hi[2], j.pivot[2])];
    }
  }
  const root = byName.get(rig.root) ?? order[0]!;
  const width = Math.max(0.1, hi[0] - lo[0]);
  const legs: Leg[] = [];
  const legJoints = new Set<string>();
  rig.legs.forEach((l, index) => {
    const chain = l.joints.map((n) => byName.get(n)).filter((j): j is RigJoint => !!j);
    if (!chain.length) return;
    const foot = byName.has(l.foot) ? l.foot : chain[chain.length - 1]!.name;
    const pts = body.points[foot] ?? [];
    let sole: Vec3;
    if (pts.length) {
      let minY = Infinity;
      for (let i = 1; i < pts.length; i += 3) minY = Math.min(minY, pts[i]!);
      const tol = 0.02 + 0.03 * (hi[1] - lo[1]);
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (let i = 0; i < pts.length; i += 3) {
        if (pts[i + 1]! <= minY + tol) {
          sx += pts[i]!;
          sz += pts[i + 2]!;
          n++;
        }
      }
      sole = [sx / n, minY, sz / n];
    } else {
      const fj = byName.get(foot)!;
      sole = [fj.pivot[0], lo[1], fj.pivot[2]];
    }
    const hip = chain[0]!.pivot;
    for (const j of chain) legJoints.add(j.name);
    legJoints.add(foot);
    const fj = byName.get(foot)!;
    let flat = false;
    if (pts.length && fj.parent && chain.some((j) => j.name === fj.parent) && chain[0]!.name !== foot) {
      const ext = [0, 1, 2].map((a) => {
        let a0 = Infinity;
        let a1 = -Infinity;
        for (let i = a; i < pts.length; i += 3) {
          a0 = Math.min(a0, pts[i]!);
          a1 = Math.max(a1, pts[i]!);
        }
        return a1 - a0;
      });
      flat = Math.max(ext[0]!, ext[2]!) > 1.5 * ext[1]! && fj.pivot[1] - sole[1] < 0.5 * (hip[1] - sole[1]);
    }
    legs.push({ index, chain, foot, sole, side: sole[0] > 0.12 * width ? 1 : sole[0] < -0.12 * width ? -1 : 0, span: Math.max(0.1, len(sub(hip, sole))), height: Math.max(0.05, hip[1] - sole[1]), flat });
  });
  return { rig, order, byName, points: body.points, ground: lo[1], top: hi[1], front: lo[2], back: hi[2], width, length: Math.max(0.1, hi[2] - lo[2]), height: Math.max(0.1, hi[1] - lo[1]), bodyH: Math.max(0.3, root.pivot[1] - lo[1]), root, legs, legJoints, centre };
}

const restState = (): JointState => ({ R: I3, pos: ZERO });

function restPose(ctx: Ctx): Pose {
  return new Map(ctx.rig.joints.map((j) => [j.name, restState()]));
}

const clonePose = (p: Pose): Pose => new Map([...p].map(([k, v]) => [k, { ...v }]));

/** Every segment's transform from rest to posed (model space), as its Motor6D moves it. */
function fk(ctx: Ctx, pose: Pose): Map<string, Xform> {
  const out = new Map<string, Xform>();
  for (const j of ctx.order) {
    const par = j.parent ? out.get(j.parent)! : ID;
    const s = pose.get(j.name) ?? restState();
    const rp = mv(s.R, j.pivot);
    const local: Vec3 = [j.pivot[0] + s.pos[0] - rp[0], j.pivot[1] + s.pos[1] - rp[1], j.pivot[2] + s.pos[2] - rp[2]];
    out.set(j.name, { r: mul3(par.r, s.R), t: add(mv(par.r, local), par.t) });
  }
  return out;
}

const hingeAxis = (j: RigJoint): Vec3 => unit(j.axis ?? [1, 0, 0]);

function hingeRange(j: RigJoint): [number, number] {
  const l = j.limits;
  if (l?.min.length === 1) return [l.min[0]!, l.max[0]!];
  return [-90, 90];
}

function ballRange(j: RigJoint): { min: number[]; max: number[] } {
  const l = j.limits;
  if (l?.min.length === 3) return l;
  if (l?.min.length === 1) return { min: [l.min[0]!, l.min[0]!, l.min[0]!], max: [l.max[0]!, l.max[0]!, l.max[0]!] };
  return { min: [-60, -60, -60], max: [60, 60, 60] };
}

/** A joint turned by `deg` about a model axis, as far as the joint allows (hinges only about their own axis). */
function turn(j: RigJoint, s: JointState, axis: Vec3, deg: number): JointState {
  if (j.kind === 'fixed' || !deg) return s;
  if (j.kind === 'hinge') {
    const h = hingeAxis(j);
    const along = dot(h, unit(axis));
    if (Math.abs(along) < 0.35) return s;
    const [lo, hi] = hingeRange(j);
    const angle = clamp((s.angle ?? dot(rotVec(s.R), h)) + deg * along, lo, hi);
    return { ...s, R: axisAngle(h, angle), angle };
  }
  return clampBall(j, { ...s, R: mul3(axisAngle(unit(axis), deg), s.R) });
}

function clampBall(j: RigJoint, s: JointState): JointState {
  const { min, max } = ballRange(j);
  const e = euler(s.R);
  const c: Vec3 = [clamp(e[0], min[0]!, max[0]!), clamp(e[1], min[1]!, max[1]!), clamp(e[2], min[2]!, max[2]!)];
  return c[0] === e[0] && c[1] === e[1] && c[2] === e[2] ? s : { ...s, R: anglesMatrix(c) };
}

/**
 * Cyclic coordinate descent: turns the chain's joints (end first) so the effector — a point at rest on
 * segment `seg` — reaches the target, within each joint's kind and limits. Returns the distance left.
 */
function reach(ctx: Ctx, pose: Pose, chain: RigJoint[], seg: string, eff: Vec3, target: Vec3, iterations = 24): number {
  const at = () => xp(fk(ctx, pose).get(seg)!, eff);
  let err = len(sub(target, at()));
  if (err <= 0.004) return err;
  // A hinge resting against one of its limits (a straight knee that only bends one way) is eased into its
  // range first, or the solver would never try bending it the way it can go.
  for (const j of chain) {
    if (j.kind !== 'hinge') continue;
    const s = pose.get(j.name) ?? restState();
    const [lo, hi] = hingeRange(j);
    const angle = s.angle ?? dot(rotVec(s.R), hingeAxis(j));
    const nudge = Math.min(15, (hi - lo) / 4);
    const next = angle >= hi - 1 && hi - lo > 2 ? angle - nudge : angle <= lo + 1 && hi - lo > 2 ? angle + nudge : angle;
    if (next !== angle) pose.set(j.name, { ...s, R: axisAngle(hingeAxis(j), next), angle: next });
  }
  // A straight chain pointed at a nearer target never bends (coordinate descent stalls there): first set
  // the knee (its first hinge after the base) so the base-to-effector distance is right, nearest the
  // knee's current angle, then aim the chain.
  const knee = chain.slice(1).find((j) => j.kind === 'hinge');
  if (knee && chain.length >= 2) {
    const X = fk(ctx, pose);
    const b0 = chain[0]!;
    const base = xp(b0.parent ? X.get(b0.parent)! : ID, add(b0.pivot, (pose.get(b0.name) ?? restState()).pos));
    const want = len(sub(target, base));
    const s = pose.get(knee.name) ?? restState();
    const h = hingeAxis(knee);
    const [lo, hi] = hingeRange(knee);
    const current = s.angle ?? dot(rotVec(s.R), h);
    const dist = (angle: number) => {
      pose.set(knee.name, { ...s, R: axisAngle(h, angle), angle });
      return len(sub(xp(fk(ctx, pose).get(seg)!, eff), base));
    };
    let best = current;
    let bestScore = Math.abs(dist(current) - want);
    for (let a = lo; a <= hi + 1e-9; a += 3) {
      const score = Math.abs(dist(a) - want) + 0.002 * Math.abs(a - current);
      if (score < bestScore) [best, bestScore] = [a, score];
    }
    for (const step of [1.5, 0.5, 0.15]) {
      for (const a of [best - step, best + step]) {
        if (a < lo || a > hi) continue;
        const score = Math.abs(dist(a) - want) + 0.002 * Math.abs(a - current);
        if (score < bestScore) [best, bestScore] = [a, score];
      }
    }
    pose.set(knee.name, { ...s, R: axisAngle(h, best), angle: best });
  }
  for (let it = 0; it < iterations && err > 0.004; it++) {
    for (let c = chain.length - 1; c >= 0; c--) {
      const j = chain[c]!;
      if (j.kind === 'fixed') continue;
      const X = fk(ctx, pose);
      const e = xp(X.get(seg)!, eff);
      if (len(sub(target, e)) < 0.004) break;
      const par = j.parent ? X.get(j.parent)! : ID;
      const s = pose.get(j.name) ?? restState();
      const pivot = xp(par, add(j.pivot, s.pos));
      const back = tr3(par.r);
      const aL = mv(back, sub(e, pivot));
      const bL = mv(back, sub(target, pivot));
      if (j.kind === 'hinge') {
        const h = hingeAxis(j);
        const a = sub(aL, mulS(h, dot(h, aL)));
        const b = sub(bL, mulS(h, dot(h, bL)));
        if (len(a) < 1e-6 || len(b) < 1e-6) continue;
        const phi = clamp(Math.atan2(dot(h, cross(a, b)), dot(a, b)) / RAD, -30, 30);
        const [lo, hi] = hingeRange(j);
        const angle = clamp((s.angle ?? dot(rotVec(s.R), h)) + phi, lo, hi);
        pose.set(j.name, { ...s, R: axisAngle(h, angle), angle });
      } else {
        pose.set(j.name, clampBall(j, { ...s, R: mul3(rotBetween(aL, bL, 30), s.R) }));
      }
    }
    err = len(sub(target, at()));
  }
  return err;
}

/** Turns a foot joint so its segment is level (as at rest), as far as the joint allows. */
function level(ctx: Ctx, pose: Pose, j: RigJoint): void {
  if (j.kind === 'fixed') return;
  const par = j.parent ? fk(ctx, pose).get(j.parent)! : ID;
  const want = tr3(par.r);
  const s = pose.get(j.name) ?? restState();
  if (j.kind === 'hinge') {
    const h = hingeAxis(j);
    const [lo, hi] = hingeRange(j);
    const angle = clamp(dot(rotVec(want), h), lo, hi);
    pose.set(j.name, { ...s, R: axisAngle(h, angle), angle });
  } else pose.set(j.name, clampBall(j, { ...s, R: want }));
}

/** Puts a leg's foot at its rest spot moved by `offset` (flat feet: the ankle there, the foot level). */
function plantLeg(ctx: Ctx, pose: Pose, leg: Leg, offset: Vec3): number {
  if (!leg.flat) return reach(ctx, pose, leg.chain, leg.foot, leg.sole, add(leg.sole, offset));
  const ankle = ctx.byName.get(leg.foot)!;
  const err = reach(
    ctx,
    pose,
    leg.chain.filter((j) => j.name !== ankle.name),
    ankle.parent!,
    ankle.pivot,
    add(ankle.pivot, offset),
  );
  level(ctx, pose, ankle);
  return err;
}

/** The lowest point of the posed model (and the segment it's on). */
function lowest(ctx: Ctx, X: Map<string, Xform>): { y: number; seg: string } {
  let best = { y: Infinity, seg: '' };
  for (const [seg, pts] of Object.entries(ctx.points)) {
    const x = X.get(seg);
    if (!x) continue;
    const [r3, r4, r5] = [x.r[3]!, x.r[4]!, x.r[5]!];
    for (let i = 0; i < pts.length; i += 3) {
      const y = r3 * pts[i]! + r4 * pts[i + 1]! + r5 * pts[i + 2]! + x.t[1];
      if (y < best.y) best = { y, seg };
    }
  }
  return best;
}

/** How far the posed model reaches forward (smallest z). */
function frontMost(ctx: Ctx, X: Map<string, Xform>): number {
  let z = Infinity;
  for (const [seg, pts] of Object.entries(ctx.points)) {
    const x = X.get(seg);
    if (!x) continue;
    for (let i = 0; i < pts.length; i += 3) z = Math.min(z, x.r[6]! * pts[i]! + x.r[7]! * pts[i + 1]! + x.r[8]! * pts[i + 2]! + x.t[2]);
  }
  return z;
}

/** Chains that aren't legs: from the root outwards to each tip (tails, necks, antennae, arms). */
function limbChains(ctx: Ctx): RigJoint[][] {
  const kids = new Map<string, RigJoint[]>();
  for (const j of ctx.rig.joints) if (j.parent) kids.set(j.parent, [...(kids.get(j.parent) ?? []), j]);
  const out: RigJoint[][] = [];
  const walk = (j: RigJoint, path: RigJoint[]) => {
    const next = (kids.get(j.name) ?? []).filter((k) => !ctx.legJoints.has(k.name));
    if (!next.length) {
      if (path.length) out.push(path);
      return;
    }
    for (const k of next) walk(k, [...path, k]);
  };
  walk(ctx.root, []);
  return out;
}

const tipOf = (ctx: Ctx, chain: RigJoint[]): Vec3 => ctx.centre.get(chain[chain.length - 1]!.name) ?? chain[chain.length - 1]!.pivot;
const isTail = (ctx: Ctx, chain: RigJoint[]) => tipOf(ctx, chain)[2] > ctx.root.pivot[2] + 0.1 * ctx.length && Math.abs(tipOf(ctx, chain)[0] - ctx.root.pivot[0]) < 0.35 * ctx.width;
const isHead = (ctx: Ctx, chain: RigJoint[]) => tipOf(ctx, chain)[2] < ctx.root.pivot[2] - 0.1 * ctx.length && Math.abs(tipOf(ctx, chain)[0] - ctx.root.pivot[0]) < 0.35 * ctx.width;

/** The chain a motion uses: the one asked for (by joint names, root side first), or the best match. */
function pickChain(ctx: Ctx, names: string[] | undefined, prefer: (c: RigJoint[]) => number, what: string): RigJoint[] {
  if (names?.length) {
    const chain = names.map((n) => ctx.byName.get(n));
    const missing = names.filter((_, i) => !chain[i]);
    if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not a joint of ${ctx.rig.model} (joints: ${ctx.rig.joints.map((j) => j.name).join(', ')})`);
    return chain as RigJoint[];
  }
  const chains = limbChains(ctx).map((c) => ({ c, score: prefer(c) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!chains.length) throw new Error(`${ctx.rig.model} has no ${what}: pass chain with its joints (root side first)`);
  return chains[0]!.c;
}

/** A point on the chain's last segment to steer: an attachment on it, else its far end. */
function chainTip(ctx: Ctx, chain: RigJoint[]): Vec3 {
  const last = chain[chain.length - 1]!;
  const att = ctx.rig.attachments.find((a) => a.part === last.name);
  if (att) return att.position;
  const pts = ctx.points[last.name] ?? [];
  let best: Vec3 = last.pivot;
  let far = -1;
  for (let i = 0; i < pts.length; i += 3) {
    const p: Vec3 = [pts[i]!, pts[i + 1]!, pts[i + 2]!];
    const d = len(sub(p, last.pivot));
    if (d > far) {
      far = d;
      best = p;
    }
  }
  return best;
}

/**
 * The axis that curls a chain up and over the body: across the side of the body it hangs from (a tail
 * behind curls forward over the back, a neck in front rears up and back, an arm at the side lifts).
 */
function curlAxis(ctx: Ctx, chain: RigJoint[]): Vec3 {
  const from = sub(chain[0]!.pivot, ctx.root.pivot);
  let side = unit([from[0], 0, from[2]]);
  if (len(side) < 0.5) {
    const d = sub(chainTip(ctx, chain), chain[0]!.pivot);
    side = unit([d[0], 0, d[2]]);
  }
  if (len(side) < 0.5) side = [0, 0, 1];
  return unit(cross(side, [0, 1, 0]));
}

/** How far a chain reaches: joint to joint, then to its tip. */
function chainLength(chain: RigJoint[], tip: Vec3): number {
  let l = 0;
  for (let i = 1; i < chain.length; i++) l += len(sub(chain[i]!.pivot, chain[i - 1]!.pivot));
  return l + len(sub(tip, chain[chain.length - 1]!.pivot));
}

// ─── Clip assembly ───────────────────────────────────────────────────────────

interface Frame {
  t: number;
  pose: Pose;
  /** Easing from this key to the next. */
  ease?: [Easing, EasingDir];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const lerp3 = (a: Vec3, b: Vec3, f: number): Vec3 => [mix(a[0], b[0], f), mix(a[1], b[1], f), mix(a[2], b[2], f)];

function toClip(ctx: Ctx, name: string, frames: Frame[], driven: string[], o: { loop: boolean; priority: Priority; markers?: AnimationClip['markers']; description: string }): AnimationClip {
  const keys = frames.map((f) => ({
    t: r3(f.t),
    poses: Object.fromEntries(
      driven.map((n) => {
        const s = f.pose.get(n) ?? restState();
        const e = euler(s.R);
        const pose: JointPose = { rot: [r2(e[0]), r2(e[1]), r2(e[2])] };
        if (s.pos[0] || s.pos[1] || s.pos[2]) pose.pos = [r3(s.pos[0]), r3(s.pos[1]), r3(s.pos[2])];
        if (f.ease) [pose.ease, pose.dir] = f.ease;
        return [n, pose];
      }),
    ),
  }));
  return { name, description: o.description, rig: ctx.rig.model, loop: o.loop, priority: o.priority, keys, ...(o.markers?.length ? { markers: o.markers.map((m) => ({ ...m, t: r3(m.t) })) } : {}) };
}

/** Plants every leg's foot at its rest spot (or moved by `shift`) for the pose's body; the worst miss. */
function plantLegs(ctx: Ctx, pose: Pose, shift?: (leg: Leg) => Vec3): number {
  let worst = 0;
  for (const leg of ctx.legs) worst = Math.max(worst, plantLeg(ctx, pose, leg, shift?.(leg) ?? ZERO));
  return worst;
}

function setRoot(ctx: Ctx, pose: Pose, rot: Vec3, pos: Vec3): void {
  pose.set(ctx.root.name, { R: anglesMatrix(rot), pos });
}

/** Joint names a clip keys: the root, the legs (and their feet), and the given chains. */
function drivenOf(ctx: Ctx, chains: RigJoint[][]): string[] {
  const s = new Set<string>([ctx.root.name]);
  for (const l of ctx.legs) {
    for (const j of l.chain) s.add(j.name);
    if (l.flat) s.add(l.foot);
  }
  for (const c of chains) for (const j of c) s.add(j.name);
  return ctx.order.map((j) => j.name).filter((n) => s.has(n) && ctx.byName.get(n)!.kind !== 'fixed');
}

/** Between two joint states (through their angles; fine for the in-betweens used here). */
function blendState(a: JointState, b: JointState, f: number): JointState {
  if (f <= 0) return { ...a };
  if (f >= 1) return { ...b };
  const ea = euler(a.R);
  const eb = euler(b.R);
  return {
    R: anglesMatrix(lerp3(ea, eb, f)),
    pos: lerp3(a.pos, b.pos, f),
    ...(a.angle !== undefined || b.angle !== undefined ? { angle: mix(a.angle ?? 0, b.angle ?? 0, f) } : {}),
  };
}

function blendPose(ctx: Ctx, a: Pose, b: Pose, f: number): Pose {
  return new Map(ctx.rig.joints.map((j) => [j.name, blendState(a.get(j.name) ?? restState(), b.get(j.name) ?? restState(), f)]));
}

/** One moment of a one-shot motion; what it leaves out is at rest (feet planted where they stand). */
interface Ctl {
  t: number;
  root?: { rot: Vec3; pos: Vec3 };
  /** Where each foot goes, as an offset from where it stands at rest. */
  feet?: (leg: Leg) => Vec3;
  /** Non-leg joints (tails, necks, arms) at this moment. */
  chains?: Pose;
  /** The legs posed (curled up, dead) instead of planted. */
  legs?: Pose;
  /** Easing to the next moment. */
  ease?: [Easing, EasingDir];
}

/**
 * Samples a one-shot motion at 30 keys a second: the body, chains and feet eased between its moments,
 * the feet planted by IK at every key (so they stay put between keys too, not just at the moments).
 */
function render(ctx: Ctx, ctls: Ctl[], o: { fps?: number; ground?: boolean } = {}): { frames: Frame[]; miss: number } {
  const fps = o.fps ?? 30;
  const D = ctls[ctls.length - 1]!.t;
  const n = Math.max(ctls.length - 1, Math.round(D * fps));
  const frames: Frame[] = [];
  const pose = restPose(ctx);
  const rest = { rot: ZERO, pos: ZERO };
  let miss = 0;
  for (let i = 0; i <= n; i++) {
    const t = (D * i) / n;
    let s = 0;
    while (s < ctls.length - 2 && ctls[s + 1]!.t <= t) s++;
    const a = ctls[s]!;
    const b = ctls[s + 1]!;
    const f = b.t > a.t ? ease(a.ease?.[0] ?? 'Linear', a.ease?.[1] ?? 'InOut', clamp((t - a.t) / (b.t - a.t), 0, 1)) : 1;
    const ra = a.root ?? rest;
    const rb = b.root ?? rest;
    setRoot(ctx, pose, lerp3(ra.rot, rb.rot, f), lerp3(ra.pos, rb.pos, f));
    for (const name of new Set([...(a.chains?.keys() ?? []), ...(b.chains?.keys() ?? [])])) pose.set(name, blendState(a.chains?.get(name) ?? restState(), b.chains?.get(name) ?? restState(), f));
    for (const leg of ctx.legs) {
      if (!a.legs || !b.legs) miss = Math.max(miss, plantLeg(ctx, pose, leg, lerp3(a.feet?.(leg) ?? ZERO, b.feet?.(leg) ?? ZERO, f)));
      if (a.legs || b.legs) {
        const planted = clonePose(pose);
        for (const j of new Set([...leg.chain, ctx.byName.get(leg.foot)!])) {
          const sa = a.legs ? (a.legs.get(j.name) ?? restState()) : (planted.get(j.name) ?? restState());
          const sb = b.legs ? (b.legs.get(j.name) ?? restState()) : (planted.get(j.name) ?? restState());
          pose.set(j.name, blendState(sa, sb, f));
        }
      }
    }
    if (o.ground) {
      // Nothing goes through the floor: the body rides up over whatever touches it first (a fall tips
      // over its feet instead of sinking them).
      const low = lowest(ctx, fk(ctx, pose)).y;
      const r = pose.get(ctx.root.name)!;
      if (low < ctx.ground) pose.set(ctx.root.name, { ...r, pos: [r.pos[0], r.pos[1] + ctx.ground - low, r.pos[2]] });
    }
    frames.push({ t, pose: clonePose(pose) });
  }
  return { frames, miss };
}

/** A chain turned about a model axis, the turn spread over its joints. */
function chainTurn(chain: RigJoint[], axis: Vec3, deg: number, into: Pose = new Map()): Pose {
  for (const j of chain) into.set(j.name, turn(j, into.get(j.name) ?? restState(), axis, deg / chain.length));
  return into;
}

// ─── Generators ──────────────────────────────────────────────────────────────

export const RIG_MOTIONS = ['walk', 'run', 'slither', 'idle', 'lunge', 'sting', 'slam', 'hit', 'death'] as const;
export type RigMotion = (typeof RIG_MOTIONS)[number];

export interface RigMotionParams {
  /** 0.5–1.5: smaller or bigger motion. */
  intensity?: number;
  /** walk/run/slither: studs per second the model moves while it plays (the feet match it). */
  speed?: number;
  /** walk/run: studs a foot travels per step; lift: how high it lifts. */
  stride?: number;
  lift?: number;
  /** walk/run: "alternate" (trot, tripod, tetrapod) or "wave" (legs ripple back to front on each side). */
  gait?: 'alternate' | 'wave';
  /** walk/run: each leg's phase 0–1 in rig.json's legs order (overrides gait). */
  phases?: number[];
  /** Loops: seconds per cycle. */
  period?: number;
  /** One-shots: total seconds. */
  duration?: number;
  /** sting/slam/slither: the joints to use, root side first (default: the best-fitting chain). */
  chain?: string[];
  /** lunge: studs forward. slam: studs the body rises. */
  distance?: number;
  height?: number;
  /** slither: sideways sway (studs) and waves along the body. */
  amplitude?: number;
  waves?: number;
  /** hit: where the blow comes from. */
  from?: 'front' | 'back' | 'left' | 'right';
  /** death: which side it falls to ("none": collapses where it stands, legs curled). */
  side?: 'left' | 'right' | 'none';
}

export interface GeneratedRigClip {
  clip: AnimationClip;
  /** walk/run/slither: the speed (studs/s) to move the model at while it plays. */
  groundSpeed?: number;
  notes: string[];
}

export const RIG_MOTION_GUIDE: Record<RigMotion, string> = {
  walk: 'Looping gait for any number of legs (rig.json legs): feet planted while down, lifted in an arc between; flat feet stay level. speed (studs/s), stride, lift, gait ("alternate": trot/tripod/tetrapod; "wave": ripple back to front), phases, period. Markers "Step" (value: the feet landing) at each touchdown.',
  run: 'Faster gait: shorter ground contact, higher lift, forward lean. Same parameters as walk.',
  slither: 'Looping travelling wave along a chain (snake, worm, eel): amplitude (studs), waves, period or speed, chain. Hinges across the body wave up and down (caterpillar) instead.',
  idle: 'Looping breathe: the body rises and settles, head and tail drift, feet stay planted. period (default 3.2 s).',
  lunge: 'Anticipation back, then the body lunges forward with the feet planted, and recovers. distance (studs), duration. Marker "Hit" at full extension.',
  sting: 'A tail (or any chain) cocks back, snaps forward over the body to a point in front of it, and recovers. chain, duration. Marker "Hit" at the strike; an attachment named like Sting/Stinger/Barb/Tail… on the tip is the point that lands.',
  slam: 'The body rears up (front legs lifted) and slams down; a two-legged rig stomps; with chain, that chain (tail, arm) whips down to the ground. height, duration. Marker "Hit" at impact.',
  hit: 'A quick flinch away from the blow and back: from ("front", "back", "left", "right"). Priority Action2, so it plays over attacks.',
  death: 'Stagger, fall and lie still: side ("left", "right", or "none" to collapse in place with legs curled; default none for 6+ legs). Markers "Impact" and "Dead" (pause there to keep the pose: track:AdjustSpeed(0)). Priority Action4.',
};

export function generateRigClip(body: RigBody, motion: RigMotion, name: string, params: RigMotionParams = {}): GeneratedRigClip {
  const ctx = context(body);
  const k = clamp(params.intensity ?? 1, 0.5, 1.5);
  switch (motion) {
    case 'walk':
    case 'run':
      return gait(ctx, name, motion === 'run', params, k);
    case 'slither':
      return slither(ctx, name, params, k);
    case 'idle':
      return idle(ctx, name, params, k);
    case 'lunge':
      return lunge(ctx, name, params, k);
    case 'sting':
      return sting(ctx, name, params, k);
    case 'slam':
      return params.chain?.length ? chainSlam(ctx, name, params, k) : bodySlam(ctx, name, params, k);
    case 'hit':
      return hitReact(ctx, name, params, k);
    case 'death':
      return death(ctx, name, params, k);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Each leg's phase: "alternate" pairs diagonals (trot, tripod, tetrapod); "wave" ripples hind to front. */
function legPhases(ctx: Ctx, gaitKind: 'alternate' | 'wave'): number[] {
  const phases = new Array<number>(ctx.legs.length).fill(0);
  for (const side of [-1, 1] as const) {
    const legs = ctx.legs.filter((l) => l.side === side).sort((a, b) => a.sole[2] - b.sole[2]);
    legs.forEach((l, i) => {
      const n = legs.length;
      const base = side === 1 ? 0.5 : 0;
      phases[ctx.legs.indexOf(l)] = gaitKind === 'wave' ? (base + ((n - 1 - i) / n) * 0.5) % 1 : (base + (i % 2) * 0.5) % 1;
    });
  }
  // Legs down the middle (a single hopping leg, a tripod's tail) step with the left front.
  return phases;
}

function footOffset(u: number, duty: number, stride: number, lift: number): Vec3 {
  if (u < duty) return [0, 0, -stride / 2 + (stride * u) / duty];
  const s = (u - duty) / (1 - duty);
  const e = s * s * (3 - 2 * s);
  return [0, lift * Math.sin(Math.PI * s), stride / 2 - stride * e];
}

function gait(ctx: Ctx, name: string, run: boolean, p: RigMotionParams, k: number): GeneratedRigClip {
  if (!ctx.legs.length) throw new Error(`${ctx.rig.model} has no legs in its rig: record them with kiln.rig.leg([hip, knee, ankle], foot) (kiln.limb(..., rig=True) records its limb as a leg), or move it with "slither".`);
  const notes: string[] = [];
  const span = mean(ctx.legs.map((l) => l.span));
  const legH = mean(ctx.legs.map((l) => l.height));
  const duty = run ? 0.4 : ctx.legs.length >= 6 ? 0.6 : 0.65;
  let stride = p.stride ?? span * (run ? 0.75 : 0.5) * k;
  let period = p.period ?? clamp(0.95 * Math.sqrt(Math.max(legH, 0.4) / 2.5), 0.45, 1.6) * (run ? 0.62 : 1);
  if (p.speed && p.speed > 0) {
    period = stride / (duty * p.speed);
    if (period < 0.3 || period > 3) {
      period = clamp(period, 0.3, 3);
      stride = p.speed * duty * period;
    }
  }
  if (stride > span * 1.4) {
    notes.push(`stride ${stride.toFixed(2)} is more than these legs reach; used ${(span * 1.4).toFixed(2)}`);
    stride = span * 1.4;
  }
  const lift = p.lift ?? Math.max(0.12 * span, legH * (run ? 0.35 : 0.22)) * k;
  const phases = p.phases?.length === ctx.legs.length ? p.phases.map((x) => ((x % 1) + 1) % 1) : legPhases(ctx, p.gait ?? 'alternate');
  const K = run ? 16 : 20;
  const bob = (run ? 0.07 : 0.03) * legH * k;
  const roll = (ctx.legs.length <= 2 ? (run ? 3 : 2) : 1) * k;
  const lean = run ? -4 * k : 0;
  const chains = limbChains(ctx);
  const tails = chains.filter((c) => isTail(ctx, c));
  const heads = chains.filter((c) => isHead(ctx, c));
  const frames: Frame[] = [];
  const pose = restPose(ctx);
  let worst = 0;
  // Twice around the cycle: the second pass starts where the first ended, so the loop closes smoothly.
  for (let pass = 0; pass < 2; pass++) {
    frames.length = 0;
    worst = 0;
    for (let i = 0; i < K; i++) {
      const u = i / K;
      setRoot(ctx, pose, [lean, 0, roll * Math.sin(2 * Math.PI * u)], [0, -bob * Math.cos(4 * Math.PI * u), 0]);
      for (const [c, chain] of tails.entries()) chain.forEach((j, d) => pose.set(j.name, turn(j, restState(), [0, 1, 0], (run ? 7 : 4) * k * Math.sin(2 * Math.PI * (u - 0.08 * (d + 1)) + c))));
      for (const chain of heads) chain.forEach((j, d) => pose.set(j.name, turn(j, restState(), [0, 1, 0], -1.5 * k * Math.sin(2 * Math.PI * (u - 0.05 * d)))));
      ctx.legs.forEach((leg, li) => {
        const ul = (((u - phases[li]!) % 1) + 1) % 1;
        worst = Math.max(worst, plantLeg(ctx, pose, leg, footOffset(ul, duty, stride, lift)));
      });
      frames.push({ t: u * period, pose: clonePose(pose) });
    }
  }
  frames.push({ t: period, pose: clonePose(frames[0]!.pose) });
  if (worst > 0.15 * span) notes.push(`some feet miss their steps by up to ${worst.toFixed(2)} studs (the legs can't reach): shorten stride or lower lift`);
  // Touchdowns, one marker per moment (legs that land together share it).
  const steps = new Map<number, string[]>();
  ctx.legs.forEach((leg, li) => {
    const t = r3(phases[li]! * period);
    steps.set(t, [...(steps.get(t) ?? []), leg.foot]);
  });
  const markers = [...steps].sort((a, b) => a[0] - b[0]).map(([t, feet]) => ({ t, name: 'Step', value: feet.join(',') }));
  const groundSpeed = stride / (duty * period);
  const clip = toClip(ctx, name, frames, drivenOf(ctx, [...tails, ...heads]), {
    loop: true,
    priority: 'Movement',
    markers,
    description: `${run ? 'Run' : 'Walk'} cycle for ${ctx.rig.model} (${ctx.legs.length} legs): ${r2(groundSpeed)} studs/s, stride ${r2(stride)}, ${r2(period)} s per cycle.`,
  });
  return { clip, groundSpeed: r2(groundSpeed), notes };
}

function slither(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const notes: string[] = [];
  // The body line: the root and the chains through it (front to back), unless one is given.
  const spine = p.chain?.length
    ? pickChain(ctx, p.chain, () => 1, 'chain')
    : [ctx.root, ...limbChains(ctx).filter((c) => isTail(ctx, c) || isHead(ctx, c)).flat()].filter((j, i, a) => a.indexOf(j) === i);
  if (spine.length < 3) throw new Error(`${ctx.rig.model} has no chain of joints to slither with (${spine.map((j) => j.name).join(', ')}): rig its body as a chain (kiln.rig.joint per segment), or pass chain`);
  const zs = spine.map((j) => (ctx.centre.get(j.name) ?? j.pivot)[2]);
  const z0 = Math.min(...zs);
  const L = Math.max(0.5, Math.max(...zs) - z0);
  const waves = clamp(p.waves ?? 1.25, 0.5, 3);
  const A = (p.amplitude ?? 0.1 * L) * k;
  const kw = (2 * Math.PI * waves) / L;
  const period = p.period ?? (p.speed && p.speed > 0 ? clamp((0.6 * L) / (waves * p.speed), 0.4, 4) : 1.2);
  // Hinges across the body wave up and down (a caterpillar); anything else sways sideways.
  const hinges = spine.filter((j) => j.kind === 'hinge');
  const upDown = hinges.length > spine.length / 2 && hinges.every((j) => Math.abs(hingeAxis(j)[1]) < 0.5);
  const axis: Vec3 = upDown ? [1, 0, 0] : [0, 1, 0];
  const K = 16;
  const frames: Frame[] = [];
  for (let i = 0; i < K; i++) {
    const u = i / K;
    const pose = restPose(ctx);
    const heading = (z: number) => Math.atan(-A * kw * Math.cos(2 * Math.PI * u - kw * (z - z0))) / RAD;
    const abs = (n: number) => heading(zs[n]!) * (spine[n] === ctx.root ? 0.5 : 1);
    spine.forEach((j, n) => {
      const parentIdx = spine.findIndex((q) => q.name === j.parent);
      pose.set(j.name, turn(j, restState(), axis, abs(n) - (parentIdx >= 0 ? abs(parentIdx) : 0)));
    });
    frames.push({ t: u * period, pose });
  }
  frames.push({ t: period, pose: clonePose(frames[0]!.pose) });
  const groundSpeed = (0.6 * L) / (waves * period);
  if (upDown) notes.push('its joints hinge across the body, so it waves up and down (a caterpillar crawl)');
  const clip = toClip(ctx, name, frames, spine.map((j) => j.name).filter((n) => ctx.byName.get(n)!.kind !== 'fixed'), {
    loop: true,
    priority: 'Movement',
    description: `Slither for ${ctx.rig.model}: ${waves} waves, ${r2(A)} studs of sway, ${r2(period)} s per cycle.`,
  });
  return { clip, groundSpeed: r2(groundSpeed), notes };
}

function idle(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const period = clamp(p.period ?? 3.2, 1, 12);
  const chains = limbChains(ctx);
  const tails = chains.filter((c) => isTail(ctx, c));
  const heads = chains.filter((c) => isHead(ctx, c));
  const breath = 0.015 * ctx.bodyH * k;
  const K = 12;
  const frames: Frame[] = [];
  const pose = restPose(ctx);
  for (let i = 0; i < K; i++) {
    const u = i / K;
    const w = 2 * Math.PI * u;
    setRoot(ctx, pose, [0.8 * k * Math.sin(w), 0, 0], [0, breath * Math.sin(w), 0]);
    for (const chain of heads) chain.forEach((j, d) => pose.set(j.name, turn(j, turn(j, restState(), [0, 1, 0], (5 * k * Math.sin(w + 0.6)) / chain.length), [1, 0, 0], (1.5 * k * Math.sin(2 * w + d * 0.3)) / chain.length)));
    for (const chain of tails) chain.forEach((j, d) => pose.set(j.name, turn(j, restState(), [0, 1, 0], 4 * k * Math.sin(w - 0.5 * (d + 1)))));
    plantLegs(ctx, pose);
    frames.push({ t: u * period, pose: clonePose(pose) });
  }
  frames.push({ t: period, pose: clonePose(frames[0]!.pose) });
  const clip = toClip(ctx, name, frames, drivenOf(ctx, [...heads, ...tails]), { loop: true, priority: 'Idle', description: `Idle breathing for ${ctx.rig.model}, ${r2(period)} s per breath.` });
  return { clip, notes: [] };
}

function lunge(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const D = clamp(p.duration ?? 0.8, 0.35, 3);
  const span = ctx.legs.length ? mean(ctx.legs.map((l) => l.span)) : ctx.length;
  const dist = (p.distance ?? Math.min(0.35 * ctx.length, 0.45 * span)) * k;
  const heads = limbChains(ctx).filter((c) => isHead(ctx, c));
  const head = (deg: number) => {
    const pose: Pose = new Map();
    for (const c of heads) chainTurn(c, [1, 0, 0], deg, pose);
    return pose;
  };
  const h = ctx.bodyH;
  const { frames, miss } = render(ctx, [
    { t: 0, ease: ['Cubic', 'InOut'] },
    { t: 0.3 * D, root: { rot: [5 * k, 0, 0], pos: [0, -0.05 * h * k, 0.15 * dist] }, chains: head(6 * k), ease: ['Cubic', 'In'] },
    { t: 0.45 * D, root: { rot: [-6 * k, 0, 0], pos: [0, -0.03 * h, -dist] }, chains: head(-12 * k), ease: ['Cubic', 'Out'] },
    { t: 0.65 * D, root: { rot: [-4 * k, 0, 0], pos: [0, -0.02 * h, -0.85 * dist] }, chains: head(-8 * k), ease: ['Cubic', 'InOut'] },
    { t: D },
  ]);
  const notes = miss > 0.25 ? [`the feet can't stay planted through the lunge (off by up to ${miss.toFixed(2)} studs): use a shorter distance`] : [];
  const clip = toClip(ctx, name, frames, drivenOf(ctx, heads), { loop: false, priority: 'Action', markers: [{ t: 0.45 * D, name: 'Hit' }], description: `Lunge for ${ctx.rig.model}: ${r2(dist)} studs forward, hit at ${r2(0.45 * D)} s.` });
  return { clip, notes };
}

function sting(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const notes: string[] = [];
  const D = clamp(p.duration ?? 1, 0.4, 3);
  // The striking point: a sting or barb first, then a tail tip (not a mandible's or a leg's tip).
  const rank = (n: string) => (/sting/i.test(n) ? 4 : /barb/i.test(n) ? 3 : /tail/i.test(n) ? 2 : 0);
  const named = ctx.rig.attachments.filter((a) => rank(a.name) > 0 && !ctx.legJoints.has(a.part)).sort((a, b) => rank(b.name) - rank(a.name))[0];
  const chain = pickChain(ctx, p.chain, (c) => (named && c.some((j) => j.name === named.part) ? 100 + c.length : isTail(ctx, c) ? c.length : 0), 'tail to sting with');
  const onChain = named && chain.some((j) => j.name === named.part);
  const tip = onChain ? named.position : chainTip(ctx, chain);
  const seg = onChain ? named.part : chain[chain.length - 1]!.name;
  const axis = curlAxis(ctx, chain);
  // Anticipation: the tail cocks back (away from the body), then snaps forward over it.
  const coil = chainTurn(chain, axis, -35 * k);
  // The strike: from the coil, the tip over the body to a point above and in front of its front (or as
  // far toward it as the chain reaches).
  const strikeRoot = { rot: [-5 * k, 0, 0] as Vec3, pos: [0, -0.03 * ctx.bodyH, -0.06 * ctx.length] as Vec3 };
  const trial = restPose(ctx);
  setRoot(ctx, trial, strikeRoot.rot, strikeRoot.pos);
  for (const [n, st] of coil) trial.set(n, { ...st });
  const base = xp(fk(ctx, trial).get(chain[0]!.parent ?? ctx.root.name) ?? ID, chain[0]!.pivot);
  const top = (() => {
    const pts = ctx.points[ctx.root.name] ?? [];
    let y = ctx.root.pivot[1];
    for (let i = 1; i < pts.length; i += 3) y = Math.max(y, pts[i]!);
    return y;
  })();
  let target: Vec3 = [ctx.root.pivot[0], top + 0.15 * ctx.bodyH, ctx.front - 0.1 * ctx.length * k];
  const reachable = 0.92 * chainLength(chain, tip);
  const far = len(sub(target, base));
  if (far > reachable) target = add(base, mulS(sub(target, base), reachable / far));
  const missed = reach(ctx, trial, chain, seg, tip, target, 60);
  if (missed > 0.15 * ctx.length) notes.push(`the tip stops ${missed.toFixed(2)} studs short of the strike point in front of the body: its joints' limits don't let it reach over`);
  const strike: Pose = new Map(chain.map((j) => [j.name, { ...trial.get(j.name)! }]));
  const recover: Pose = new Map(chain.map((j) => [j.name, blendState(coil.get(j.name) ?? restState(), restState(), 0.5)]));
  const { frames } = render(ctx, [
    { t: 0, ease: ['Cubic', 'InOut'] },
    { t: 0.35 * D, chains: coil, ease: ['Cubic', 'In'] },
    { t: 0.5 * D, root: strikeRoot, chains: strike, ease: ['Cubic', 'Out'] },
    { t: 0.72 * D, chains: recover, ease: ['Cubic', 'InOut'] },
    { t: D },
  ]);
  const clip = toClip(ctx, name, frames, drivenOf(ctx, [chain]), { loop: false, priority: 'Action', markers: [{ t: 0.5 * D, name: 'Hit' }], description: `Sting for ${ctx.rig.model} with ${chain.map((j) => j.name).join(' → ')}: cocks back, strikes in front at ${r2(0.5 * D)} s, recovers.` });
  return { clip, notes };
}

function bodySlam(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const D = clamp(p.duration ?? 1.1, 0.5, 3);
  const legH = ctx.legs.length ? mean(ctx.legs.map((l) => l.height)) : ctx.bodyH;
  const L = ctx.length;
  const h = ctx.bodyH;
  // Front legs, when there are legs behind them too (a biped's two feet are neither).
  const zs = ctx.legs.map((l) => l.sole[2]);
  const mid = (Math.min(...zs) + Math.max(...zs)) / 2;
  const fronts = zs.length && Math.max(...zs) - Math.min(...zs) > 0.25 * L ? ctx.legs.filter((l) => l.sole[2] < mid) : [];
  let ctls: Ctl[];
  if (fronts.length) {
    // Rear up on the hind legs, then come down hard on the front ones.
    const rise = (p.height ?? 0.4 * legH) * k;
    const front = (l: Leg) => fronts.includes(l);
    ctls = [
      { t: 0, ease: ['Cubic', 'Out'] },
      { t: 0.4 * D, root: { rot: [18 * k, 0, 0], pos: [0, rise, 0.06 * L] }, feet: (l) => (front(l) ? [0, rise * 2, -0.05 * L] : ZERO), ease: ['Cubic', 'In'] },
      { t: 0.55 * D, root: { rot: [-4 * k, 0, 0], pos: [0, -0.05 * h, -0.04 * L] }, feet: (l) => (front(l) ? [0, 0, -0.1 * L] : ZERO), ease: ['Cubic', 'Out'] },
      { t: 0.75 * D, root: { rot: [-2 * k, 0, 0], pos: [0, -0.03 * h, -0.03 * L] }, feet: (l) => (front(l) ? [0, 0, -0.1 * L] : ZERO), ease: ['Cubic', 'InOut'] },
      { t: D, feet: (l) => (front(l) ? [0, 0, -0.1 * L] : ZERO) },
    ];
  } else {
    // Nothing in front to rear up on (a biped, a snail): lift one foot and stomp.
    const stomper = [...ctx.legs].sort((a, b) => b.sole[0] - a.sole[0])[0];
    const lift = (p.height ?? 0.35 * legH) * k;
    ctls = [
      { t: 0, ease: ['Cubic', 'Out'] },
      { t: 0.4 * D, root: { rot: [4 * k, 0, stomper ? 3 * k : 0], pos: [0, 0, 0] }, feet: (l) => (l === stomper ? [0, lift, -0.1 * legH] : ZERO), ease: ['Cubic', 'In'] },
      { t: 0.55 * D, root: { rot: [-4 * k, 0, 0], pos: [0, -0.06 * h, 0] }, feet: (l) => (l === stomper ? [0, 0, -0.15 * legH] : ZERO), ease: ['Cubic', 'Out'] },
      { t: 0.75 * D, root: { rot: [-2 * k, 0, 0], pos: [0, -0.04 * h, 0] }, feet: (l) => (l === stomper ? [0, 0, -0.15 * legH] : ZERO), ease: ['Cubic', 'InOut'] },
      { t: D, feet: (l) => (l === stomper ? [0, 0, -0.15 * legH] : ZERO) },
    ];
  }
  const { frames, miss } = render(ctx, ctls);
  const notes = miss > 0.3 ? [`some feet can't follow the body (off by up to ${miss.toFixed(2)} studs): a lower height helps`] : [];
  const clip = toClip(ctx, name, frames, drivenOf(ctx, []), { loop: false, priority: 'Action', markers: [{ t: 0.55 * D, name: 'Hit' }], description: `${fronts.length ? 'Body slam' : 'Stomp'} for ${ctx.rig.model}, landing at ${r2(0.55 * D)} s.` });
  return { clip, notes };
}

function chainSlam(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const notes: string[] = [];
  const D = clamp(p.duration ?? 1, 0.4, 3);
  const chain = pickChain(ctx, p.chain, () => 1, 'chain');
  const tip = chainTip(ctx, chain);
  const seg = chain[chain.length - 1]!.name;
  const raised = chainTurn(chain, curlAxis(ctx, chain), 80 * k);
  // Down onto the ground a little beyond where the tip rests.
  const out = unit([tip[0] - chain[0]!.pivot[0], 0, tip[2] - chain[0]!.pivot[2]]);
  const target: Vec3 = [tip[0] + out[0] * 0.1 * ctx.length, ctx.ground + 0.05, tip[2] + out[2] * 0.1 * ctx.length];
  const trial = restPose(ctx);
  for (const [n, st] of raised) trial.set(n, { ...st });
  const missed = reach(ctx, trial, chain, seg, tip, target, 60);
  if (missed > 0.25) notes.push(`the chain's tip stops ${missed.toFixed(2)} studs from the ground`);
  const hit: Pose = new Map(chain.map((j) => [j.name, { ...trial.get(j.name)! }]));
  const { frames } = render(ctx, [
    { t: 0, ease: ['Cubic', 'Out'] },
    { t: 0.4 * D, chains: raised, ease: ['Cubic', 'In'] },
    { t: 0.55 * D, chains: hit, ease: ['Cubic', 'InOut'] },
    { t: 0.75 * D, chains: new Map(chain.map((j) => [j.name, blendState(hit.get(j.name)!, restState(), 0.3)])), ease: ['Cubic', 'InOut'] },
    { t: D },
  ]);
  const clip = toClip(ctx, name, frames, drivenOf(ctx, [chain]), { loop: false, priority: 'Action', markers: [{ t: 0.55 * D, name: 'Hit' }], description: `${seg} slam for ${ctx.rig.model}: raised, then down to the ground at ${r2(0.55 * D)} s.` });
  return { clip, notes };
}

function hitReact(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const D = clamp(p.duration ?? 0.45, 0.2, 1.5);
  const from = p.from ?? 'front';
  const push: Vec3 = from === 'front' ? [0, 0, 0.06 * ctx.length] : from === 'back' ? [0, 0, -0.06 * ctx.length] : from === 'left' ? [0.06 * ctx.width, 0, 0] : [-0.06 * ctx.width, 0, 0];
  const tilt: Vec3 = from === 'front' ? [7, 0, 0] : from === 'back' ? [-5, 0, 0] : from === 'left' ? [0, 0, -6] : [0, 0, 6];
  const chains = limbChains(ctx).filter((c) => isTail(ctx, c) || isHead(ctx, c));
  const lag = (f: number) => {
    const pose: Pose = new Map();
    for (const c of chains) chainTurn(c, [1, 0, 0], f * 10 * k * (isHead(ctx, c) ? -1 : 1), pose);
    return pose;
  };
  const { frames } = render(ctx, [
    { t: 0, ease: ['Cubic', 'Out'] },
    { t: 0.22 * D, root: { rot: mulS(tilt, k), pos: mulS(push, k) }, chains: lag(0.5), ease: ['Cubic', 'InOut'] },
    { t: 0.5 * D, root: { rot: mulS(tilt, -0.25 * k), pos: mulS(push, -0.25 * k) }, chains: lag(1), ease: ['Cubic', 'InOut'] },
    { t: D },
  ]);
  const clip = toClip(ctx, name, frames, drivenOf(ctx, chains), { loop: false, priority: 'Action2', description: `Hit reaction for ${ctx.rig.model}, struck from the ${from}.` });
  return { clip, notes: [] };
}

function death(ctx: Ctx, name: string, p: RigMotionParams, k: number): GeneratedRigClip {
  const D = clamp(p.duration ?? 1.6, 0.6, 5);
  const side = p.side ?? (ctx.legs.length >= 6 ? 'none' : 'right');
  const roll = (side === 'right' ? -80 : side === 'left' ? 80 : 0) * Math.min(1, k);
  // Each leg joint folds the way that draws its foot in under the body (a dead spider's crumple), most of
  // the way to its limit.
  const curled = restPose(ctx);
  const under: Vec3 = [ctx.root.pivot[0], ctx.root.pivot[1] - 0.25 * ctx.bodyH, ctx.root.pivot[2]];
  const tuck = (p: Vec3) => -len(sub(p, under));
  for (const leg of ctx.legs) {
    for (const j of leg.chain) {
      if (j.kind === 'fixed') continue;
      let best: JointState = restState();
      let bestY = tuck(xp(fk(ctx, curled).get(leg.foot)!, leg.sole));
      const axes: Vec3[] = j.kind === 'hinge' ? [hingeAxis(j)] : [[1, 0, 0], [0, 0, 1]];
      for (const ax of axes) {
        for (const sign of [-1, 1]) {
          const lim = j.kind === 'hinge' ? Math.abs(hingeRange(j)[sign > 0 ? 1 : 0]) : 50;
          const s = turn(j, restState(), ax, sign * Math.min(lim, 110) * 0.8 * k);
          const trial = clonePose(curled);
          trial.set(j.name, s);
          const y = tuck(xp(fk(ctx, trial).get(leg.foot)!, leg.sole));
          if (y > bestY + 1e-4) {
            bestY = y;
            best = s;
          }
        }
      }
      curled.set(j.name, best);
    }
  }
  // Lying on the ground: the body lowered (or raised) until its lowest point touches it.
  const lying = clonePose(curled);
  setRoot(ctx, lying, [0, 0, roll], ZERO);
  const drop = ctx.ground - lowest(ctx, fk(ctx, lying)).y;
  const legs = new Map([...curled].filter(([n]) => ctx.legJoints.has(n)));
  const halfLegs = new Map([...legs].map(([n, st]) => [n, blendState(restState(), st, 0.5)]));
  const h = ctx.bodyH;
  const { frames } = render(ctx, [
    { t: 0, ease: ['Cubic', 'Out'] },
    { t: 0.18 * D, root: { rot: [6 * k, 0, 0], pos: [0, 0.02 * h, 0.04 * ctx.length] }, ease: ['Cubic', 'In'] },
    { t: 0.5 * D, root: { rot: [3 * k, 0, roll / 2], pos: [0, Math.max(drop / 2, drop + 0.25 * h), 0.02 * ctx.length] }, legs: halfLegs, ease: ['Cubic', 'In'] },
    { t: 0.72 * D, root: { rot: [0, 0, roll], pos: [0, drop, 0] }, legs, ease: ['Cubic', 'Out'] },
    { t: 0.85 * D, root: { rot: [0, 0, roll], pos: [0, drop + 0.03 * h, 0] }, legs, ease: ['Cubic', 'InOut'] },
    { t: D, root: { rot: [0, 0, roll], pos: [0, drop, 0] }, legs },
  ], { ground: true });
  const clip = toClip(ctx, name, frames, drivenOf(ctx, []), {
    loop: false,
    priority: 'Action4',
    markers: [
      { t: 0.72 * D, name: 'Impact' },
      { t: D, name: 'Dead' },
    ],
    description: `Death for ${ctx.rig.model}: staggers, ${side === 'none' ? 'collapses with its legs curled' : `falls onto its ${side} side`}, lies still.`,
  });
  return { clip, notes: [] };
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/** Measures a rig clip against its rig and says what looks wrong. */
export function checkRigClip(body: RigBody, clip: AnimationClip): { metrics: RigClipMetrics; findings: string[] } {
  const ctx = context(body);
  const findings: string[] = [];
  const dur = clipDuration(clip);
  const N = clamp(Math.ceil(dur * 30), 24, 240);
  const poseAt = (t: number): Pose => {
    const s = sampleClip(clip, t);
    const pose = restPose(ctx);
    for (const [n, v] of Object.entries(s)) if (v && ctx.byName.has(n)) pose.set(n, { R: anglesMatrix(v.rot), pos: v.pos });
    return pose;
  };
  let sink: RigClipMetrics['sink'] = null;
  // On the ground: close enough not to be flying (air time); planted: right on it (contact and sliding).
  const nearTol = 0.06 + 0.02 * ctx.height;
  const plantTol = 0.03 + 0.01 * ctx.bodyH;
  const feet = ctx.legs.map((l) => ({ leg: l, pos: [] as Vec3[], near: [] as boolean[], on: [] as boolean[] }));
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * dur;
    const X = fk(ctx, poseAt(t));
    const low = lowest(ctx, X);
    const depth = ctx.ground - low.y;
    if (depth > 0.02 && (!sink || depth > sink.depth)) sink = { depth: r2(depth), segment: low.seg, t: r2(t) };
    for (const f of feet) {
      const p = xp(X.get(f.leg.foot)!, f.leg.sole);
      f.pos.push(p);
      f.near.push(p[1] - ctx.ground < nearTol);
      f.on.push(p[1] - ctx.ground < plantTol);
    }
  }
  const dt = dur / N;
  let airborne: number | null = null;
  if (feet.length) {
    let run = 0;
    let longest = 0;
    for (let i = 0; i <= N; i++) {
      run = feet.some((f) => f.near[i]) ? 0 : run + 1;
      longest = Math.max(longest, run);
    }
    airborne = r2(longest * dt);
  }
  // Planted feet: their backward speed while down (a loop's ground speed) and how much it wanders.
  const speeds: number[] = [];
  for (const f of feet) for (let i = 0; i < N; i++) if (f.on[i] && f.on[i + 1]) speeds.push((f.pos[i + 1]![2] - f.pos[i]![2]) / dt);
  speeds.sort((a, b) => a - b);
  const groundSpeed = clip.loop && speeds.length ? r2(speeds[Math.floor(speeds.length / 2)]!) : null;
  const feetOut = feet.map((f) => {
    const dev: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!(f.on[i] && f.on[i + 1])) continue;
      const v = mulS(sub(f.pos[i + 1]!, f.pos[i]!), 1 / dt);
      dev.push(Math.hypot(v[0], v[2] - (groundSpeed ?? 0)));
    }
    return { foot: f.leg.foot, contact: r2(f.on.filter(Boolean).length / f.on.length), slide: r2(mean(dev)) };
  });
  const markers = (clip.markers ?? []).map((m) => {
    const X = fk(ctx, poseAt(m.t));
    const attachments: Record<string, [number, number, number]> = {};
    for (const a of ctx.rig.attachments) {
      const x = X.get(a.part);
      if (!x) continue;
      const w = sub(xp(x, a.position), ctx.root.pivot);
      attachments[a.name] = [r2(w[0]), r2(w[1]), r2(-w[2])];
    }
    return { name: m.name, t: m.t, attachments, reach: r2(ctx.front - frontMost(ctx, X)) };
  });
  // Findings.
  if (sink && sink.depth > 0.08 + 0.02 * ctx.bodyH) findings.push(`${sink.segment} sinks ${sink.depth} studs into the ground at ${sink.t} s`);
  const moving = clip.loop && /walk|run|trot|gallop|crawl|scuttle|stride|sprint|jog/i.test(clip.name);
  if (moving && groundSpeed !== null) {
    const sliding = feetOut.filter((f) => f.slide > Math.max(0.4, 0.25 * Math.abs(groundSpeed)));
    if (sliding.length) findings.push(`feet slide while planted (${sliding.map((f) => `${f.foot} ${f.slide} studs/s`).join(', ')}): planted feet should move back at one steady speed`);
    if (Math.abs(groundSpeed) < 0.05) findings.push('the planted feet do not travel backward: the model would skate when it moves');
  }
  if (!clip.loop && airborne !== null && airborne > 0.25 && !/jump|leap|pounce|hop|death|die|fall|flip/i.test(clip.name)) findings.push(`no foot touches the ground for ${airborne} s`);
  // An attack aimed forward should land in front of the body (slams and stomps land where they stand).
  const forward = !/slam|stomp|pound|smash|quake|roar|death|die|hit ?react|flinch|stagger/i.test(clip.name);
  if (forward)
    for (const m of markers)
      if (/hit|strike|sting|bite|stab/i.test(m.name) && m.reach < 0.25 && !Object.values(m.attachments).some((a) => a[2] > ctx.root.pivot[2] - ctx.front - 0.1)) findings.push(`at "${m.name}" (${m.t} s) nothing reaches past the front of the body: the attack won't land in front`);
  findings.push(...limitProblems(ctx, clip));
  if (clip.loop) {
    const first = clip.keys[0]!;
    const last = clip.keys[clip.keys.length - 1]!;
    let jump = 0;
    let at = '';
    for (const [n, a] of Object.entries(first.poses)) {
      const b = last.poses[n];
      if (!a?.rot || !b?.rot) continue;
      const d = len(rotVec(mul3(tr3(anglesMatrix(a.rot)), anglesMatrix(b.rot))));
      if (d > jump) [jump, at] = [d, n];
    }
    if (jump > 3) findings.push(`the loop jumps: ${at} ends ${r2(jump)}° away from where it starts`);
  }
  return { metrics: { duration: dur, sink, airborne, groundSpeed, feet: feetOut, markers }, findings };
}

/** Keyed poses that turn a joint the way it can't: past its limits, a hinge off its axis, a fixed joint at all. */
function limitProblems(ctx: Ctx, clip: AnimationClip): string[] {
  const out = new Map<string, string>();
  for (const key of clip.keys) {
    for (const [n, p] of Object.entries(key.poses)) {
      const j = ctx.byName.get(n);
      if (!j || !p?.rot || out.has(n)) continue;
      const R = anglesMatrix(p.rot);
      const w = rotVec(R);
      if (j.kind === 'fixed') {
        if (len(w) > 2) out.set(n, `${n} is a fixed joint but turns ${r2(len(w))}° at ${key.t} s`);
        continue;
      }
      if (j.kind === 'hinge') {
        const h = hingeAxis(j);
        const along = dot(w, h);
        const off = len(sub(w, mulS(h, along)));
        if (off > 8) out.set(n, `${n} is a hinge about [${h.map(r2).join(', ')}] but turns ${r2(off)}° about another axis at ${key.t} s`);
        else if (j.limits?.min.length === 1 && (along < j.limits.min[0]! - 2 || along > j.limits.max[0]! + 2)) out.set(n, `${n} bends ${r2(along)}° at ${key.t} s, past its limits (${j.limits.min[0]}° to ${j.limits.max[0]}°)`);
        continue;
      }
      if (j.limits?.min.length === 3) {
        const bad = [0, 1, 2].filter((i) => p.rot![i]! < j.limits!.min[i]! - 2 || p.rot![i]! > j.limits!.max[i]! + 2);
        if (bad.length) out.set(n, `${n} turns [${p.rot.map(r2).join(', ')}]° at ${key.t} s, past its limits on ${bad.map((i) => 'xyz'[i]).join(', ')} (${bad.map((i) => `${j.limits!.min[i]}…${j.limits!.max[i]}`).join(', ')})`);
      }
    }
  }
  return [...out.values()].slice(0, 8);
}
