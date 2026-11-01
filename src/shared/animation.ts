/**
 * Animation clips for Roblox R15 characters, shared by the core (validation, KeyframeSequence export)
 * and the renderer (the live preview mannequin).
 *
 * Rotations are degrees about the joint's own axes, applied like CFrame.Angles(x, y, z), measured on
 * the default R15 rig (it faces -Z; +X is its right, +Y up):
 * - shoulders (…UpperArm): +X raises the arm forward; +Z swings the right arm out to the side (the
 *   left arm goes out with -Z); Y twists the arm.
 * - elbows (…LowerArm): +X bends. Wrists (…Hand): +X tilts the hand up/forward.
 * - hips (…UpperLeg): +X lifts the thigh forward, -X swings it back; +Z moves the right leg out.
 * - knees (…LowerLeg): -X bends. Ankles (…Foot): +X lifts the toes, -X points them.
 * - waist (UpperTorso): -X leans forward, +Y twists left (right shoulder forward), +Z leans left.
 * - neck (Head): +X looks up, +Y looks left, +Z tilts left.
 * - root (LowerTorso, relative to HumanoidRootPart): -X pitches the body forward; pos moves the
 *   hips (bob with pos Y, lunge with pos Z < 0 = forward).
 */

export const JOINTS = [
  'LowerTorso', 'UpperTorso', 'Head',
  'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot',
] as const;
export type Joint = (typeof JOINTS)[number];

/** Pose parents in a KeyframeSequence (the part each joint's pose sits under). */
export const R15_PARENT: Record<Joint, Joint | 'HumanoidRootPart'> = {
  LowerTorso: 'HumanoidRootPart',
  UpperTorso: 'LowerTorso',
  Head: 'UpperTorso',
  LeftUpperArm: 'UpperTorso',
  LeftLowerArm: 'LeftUpperArm',
  LeftHand: 'LeftLowerArm',
  RightUpperArm: 'UpperTorso',
  RightLowerArm: 'RightUpperArm',
  RightHand: 'RightLowerArm',
  LeftUpperLeg: 'LowerTorso',
  LeftLowerLeg: 'LeftUpperLeg',
  LeftFoot: 'LeftLowerLeg',
  RightUpperLeg: 'LowerTorso',
  RightLowerLeg: 'RightUpperLeg',
  RightFoot: 'RightLowerLeg',
};

/** The default R15 rig, measured in Studio: part sizes and joints (attachment on the parent, on the child). */
export const R15_RIG = {
  sizes: {
    HumanoidRootPart: [2, 2, 1], LowerTorso: [1.991, 0.401, 1.004], UpperTorso: [1.943, 1.698, 1.004], Head: [1.159, 1.182, 1.161],
    LeftUpperArm: [1.001, 1.242, 1.002], LeftLowerArm: [1.001, 1.118, 1.002], LeftHand: [0.984, 0.316, 1.028],
    RightUpperArm: [1.001, 1.242, 1.002], RightLowerArm: [1.001, 1.118, 1.002], RightHand: [0.984, 0.316, 1.028],
    LeftUpperLeg: [0.993, 1.363, 0.973], LeftLowerLeg: [0.993, 1.301, 0.973], LeftFoot: [1.009, 0.312, 1.001],
    RightUpperLeg: [0.993, 1.363, 0.973], RightLowerLeg: [0.993, 1.301, 0.973], RightFoot: [1.009, 0.312, 1.001],
  } as Record<Joint | 'HumanoidRootPart', [number, number, number]>,
  joints: {
    LowerTorso: { at: [0, -1, 0], child: [0, -0.2, 0] },
    UpperTorso: { at: [0, 0.2, 0], child: [0, -0.849, 0] },
    Head: { at: [0, 0.849, 0], child: [0, -0.576, 0] },
    LeftUpperArm: { at: [-0.972, 0.598, 0], child: [0.501, 0.419, 0] },
    LeftLowerArm: { at: [0, -0.355, 0], child: [0, 0.275, 0] },
    LeftHand: { at: [0, -0.532, 0], child: [0, 0.132, 0] },
    RightUpperArm: { at: [0.972, 0.598, 0], child: [-0.501, 0.419, 0] },
    RightLowerArm: { at: [0, -0.355, 0], child: [0, 0.275, 0] },
    RightHand: { at: [0, -0.532, 0], child: [0, 0.132, 0] },
    LeftUpperLeg: { at: [-0.5, -0.2, 0], child: [0, 0.471, 0] },
    LeftLowerLeg: { at: [0, -0.449, 0], child: [0, 0.413, 0] },
    LeftFoot: { at: [0, -0.596, 0], child: [0, 0.106, 0] },
    RightUpperLeg: { at: [0.5, -0.2, 0], child: [0, 0.471, 0] },
    RightLowerLeg: { at: [0, -0.449, 0], child: [0, 0.413, 0] },
    RightFoot: { at: [0, -0.596, 0], child: [0, 0.106, 0] },
  } as Record<Joint, { at: [number, number, number]; child: [number, number, number] }>,
};

/** Roblox PoseEasingStyle / PoseEasingDirection. */
export type Easing = 'Linear' | 'Constant' | 'Cubic' | 'Elastic' | 'Bounce' | 'CubicV2';

/** TweenService style names mapped to the nearest pose easing (poses only have the six above). */
export const EASING_ALIASES: Record<string, Easing> = {
  Sine: 'Cubic', Quad: 'Cubic', Quart: 'Cubic', Quint: 'Cubic', Exponential: 'Cubic', Circular: 'Cubic', Back: 'Cubic', Smooth: 'Cubic',
  Ease: 'Cubic', EaseInOut: 'Cubic', Snap: 'Constant', Step: 'Constant', Spring: 'Elastic',
};
export type EasingDir = 'In' | 'Out' | 'InOut';

export interface JointPose {
  /** Degrees (see the conventions above). */
  rot?: [number, number, number];
  /** Studs, in the parent joint's frame. */
  pos?: [number, number, number];
  /** Easing from this key to the next one that has this joint (directions like TweenService: In starts slow). */
  ease?: Easing;
  dir?: EasingDir;
  /**
   * Hands only: point a held weapon (x right, y up, f forward from the character) instead of giving
   * the wrist angles; resolveAims() turns it into rot for the arm pose at that key.
   */
  aim?: [number, number, number];
  /**
   * Hands only: where the hand should be, in studs from the root (x right, y up, f forward; the head
   * is around [0, 1.6, 0], shoulders at y ≈ 1). resolveAims() solves the shoulder and elbow to put it
   * there (elbow kept low), before any aim.
   */
  reach?: [number, number, number];
  /** With reach: which way the elbow points (default low). */
  elbow?: ElbowHint;
}

export interface ClipKey {
  t: number;
  /** R15 joints (see JOINTS), or a custom rig's joint names when the clip has `rig`. */
  poses: Partial<Record<Joint, JointPose>> & Partial<Record<string, JointPose>>;
}

export type Priority = 'Core' | 'Idle' | 'Movement' | 'Action' | 'Action2' | 'Action3' | 'Action4';

export interface AnimationClip {
  name: string;
  description?: string;
  /**
   * A custom rig's model (its models/<Model>.rig.json): the clip moves that rig's joints, about its
   * pivots (see @shared/rig). Absent: an R15 character.
   */
  rig?: string;
  loop: boolean;
  priority: Priority;
  keys: ClipKey[];
  /** Named moments (e.g. "Hit"): AnimationTrack:GetMarkerReachedSignal(name) fires there. */
  markers?: Array<{ t: number; name: string; value?: string }>;
}

export function clipDuration(c: AnimationClip): number {
  return Math.max(0, ...c.keys.map((k) => k.t), ...(c.markers ?? []).map((m) => m.t));
}

/** Joints a clip moves (others are left to lower-priority animations, e.g. legs keep walking). */
export function clipJoints(c: AnimationClip): Joint[] {
  const s = new Set<Joint>();
  for (const k of c.keys) for (const j of Object.keys(k.poses) as Joint[]) s.add(j);
  return JOINTS.filter((j) => s.has(j));
}

/** Every joint name a clip moves, R15 or a custom rig's (in the order they first appear). */
export function clipJointNames(c: AnimationClip): string[] {
  if (!c.rig) return clipJoints(c);
  const s = new Set<string>();
  for (const k of c.keys) for (const j of Object.keys(k.poses)) s.add(j);
  return [...s];
}

/**
 * Problems that would make the clip unusable (empty list = fine). A clip for a custom rig (`rig`) is
 * checked against that rig's joints (pass the rig; without it the clip can't be checked).
 */
export function validateClip(c: AnimationClip, rig?: { joints: Array<{ name: string }> } | null): string[] {
  const p: string[] = [];
  if (c.rig && !rig) p.push(`the rig ${c.rig} has no rig.json (rig the model with kiln.rig in Blender first)`);
  const rigJoints = rig ? new Set(rig.joints.map((j) => j.name)) : null;
  const maxPos = c.rig ? 60 : 12;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(c.name)) p.push('name must be letters, digits and _ (start with a letter, ≤ 48 chars)');
  if (c.keys.length < 2) p.push('needs at least 2 keys');
  let last = -1;
  for (const k of c.keys) {
    if (!(k.t >= 0) || k.t > 30) p.push(`key time ${k.t} must be between 0 and 30 s`);
    if (k.t < last) p.push('keys must be in time order');
    last = k.t;
    for (const [j, pose] of Object.entries(k.poses)) {
      if (c.rig) {
        if (rigJoints && !rigJoints.has(j)) p.push(`unknown joint "${j}" (${c.rig}'s joints: ${[...rigJoints].join(', ')})`);
      } else if (!(JOINTS as readonly string[]).includes(j)) p.push(`unknown joint "${j}" (R15 joints: ${JOINTS.join(', ')})`);
      if (pose?.rot && pose.rot.some((v) => !Number.isFinite(v) || Math.abs(v) > 360)) p.push(`${j} at ${k.t}s: rotation must be within ±360°`);
      if (pose?.pos && pose.pos.some((v) => !Number.isFinite(v) || Math.abs(v) > maxPos)) p.push(`${j} at ${k.t}s: position must be within ±${maxPos} studs`);
    }
  }
  if (c.keys[0] && c.keys[0].t !== 0) p.push('the first key must be at 0 s');
  const d = clipDuration(c);
  if (d <= 0) p.push('duration must be above 0');
  for (const m of c.markers ?? []) if (!(m.t >= 0 && m.t <= d)) p.push(`marker "${m.name}" at ${m.t}s is outside the clip`);
  return [...new Set(p)];
}

/** The joints above the waist and from the hips down (the root, LowerTorso, goes with the legs). */
export const UPPER_BODY: readonly Joint[] = ['UpperTorso', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightLowerArm', 'RightHand'];
export const LOWER_BODY: readonly Joint[] = ['LowerTorso', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot'];

/**
 * Only the upper (or lower) body's poses. Roblox layers animations joint by joint (measured in Studio):
 * a higher-priority track overrides only the joints it keys, so an upper-body attack at Action
 * priority plays over a walk or run whose legs carry on. Keys keep their times; markers stay.
 */
export function bodyPartClip(c: AnimationClip, part: 'upper' | 'lower'): AnimationClip {
  const keep = new Set<string>(part === 'upper' ? UPPER_BODY : LOWER_BODY);
  return { ...c, keys: c.keys.map((k) => ({ t: k.t, poses: Object.fromEntries(Object.entries(k.poses).filter(([j]) => keep.has(j))) })) };
}

const MIRROR: Record<string, string> = {};
for (const j of JOINTS) MIRROR[j] = j.startsWith('Left') ? j.replace('Left', 'Right') : j.startsWith('Right') ? j.replace('Right', 'Left') : j;

/** The clip for the other hand/side: left and right swap, and sideways rotations and moves flip. */
export function mirrorClip(c: AnimationClip, name = `${c.name}Mirrored`): AnimationClip {
  return {
    ...c,
    name,
    keys: c.keys.map((k) => ({
      t: k.t,
      poses: Object.fromEntries(
        Object.entries(k.poses).map(([j, p]) => [
          MIRROR[j]!,
          {
            ...p,
            rot: p!.rot ? [p!.rot[0], -p!.rot[1], -p!.rot[2]] : undefined,
            pos: p!.pos ? [-p!.pos[0], p!.pos[1], p!.pos[2]] : undefined,
            ...(p!.aim ? { aim: [-p!.aim[0], p!.aim[1], p!.aim[2]] } : {}),
            ...(p!.reach ? { reach: [-p!.reach[0], p!.reach[1], p!.reach[2]] } : {}),
          },
        ]),
      ) as ClipKey['poses'],
    })),
  };
}

/**
 * Easing between two keys (a 0..1 progress → eased 0..1), as Roblox plays it (measured in Studio):
 * directions work like TweenService ("In" starts slow; Cubic is exported as CubicV2 to get that), and
 * Constant jumps to the next key's pose at once.
 */
export function ease(style: Easing | undefined, dir: EasingDir | undefined, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  if (style === 'Constant') return t > 0 ? 1 : 0;
  const inFn = (v: number): number => {
    switch (style ?? 'Linear') {
      case 'Cubic':
      case 'CubicV2':
        return v * v * v;
      case 'Elastic': {
        if (v === 0 || v === 1) return v;
        return -Math.pow(2, 10 * v - 10) * Math.sin((v * 10 - 10.75) * ((2 * Math.PI) / 3));
      }
      case 'Bounce':
        return 1 - bounceOut(1 - v);
      default:
        return v;
    }
  };
  switch (dir ?? 'InOut') {
    case 'In':
      return inFn(t);
    case 'Out':
      return 1 - inFn(1 - t);
    default:
      return t < 0.5 ? inFn(t * 2) / 2 : 1 - inFn((1 - t) * 2) / 2;
  }
}

function bounceOut(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

/**
 * The pose of every joint the clip moves at time t (rotations in degrees). Between two keys that have
 * the joint, values follow the earlier key's easing; outside them the nearest key holds.
 */
export function sampleClip(c: AnimationClip, time: number): Partial<Record<Joint, { rot: [number, number, number]; pos: [number, number, number] }>> & Partial<Record<string, { rot: [number, number, number]; pos: [number, number, number] }>> {
  const d = clipDuration(c);
  const t = c.loop && d > 0 ? ((time % d) + d) % d : Math.min(Math.max(0, time), d);
  const out: Partial<Record<string, { rot: [number, number, number]; pos: [number, number, number] }>> = {};
  for (const j of clipJointNames(c)) {
    const keys = c.keys.filter((k) => k.poses[j]);
    let a = keys[0]!;
    let b = keys[0]!;
    for (const k of keys) {
      if (k.t <= t) a = k;
      if (k.t >= t) {
        b = k;
        break;
      }
      b = k;
    }
    const pa = a.poses[j]!;
    const pb = b.poses[j]!;
    const span = b.t - a.t;
    const f = span > 0 ? ease(pa.ease, pa.dir, (t - a.t) / span) : 0;
    const ra = pa.rot ?? [0, 0, 0];
    const rb = pb.rot ?? [0, 0, 0];
    const qa = pa.pos ?? [0, 0, 0];
    const qb = pb.pos ?? [0, 0, 0];
    out[j] = {
      rot: blendAngles(ra, rb, f, (pa.ease ?? 'Linear') === 'Linear'),
      pos: [qa[0] + (qb[0] - qa[0]) * f, qa[1] + (qb[1] - qa[1]) * f, qa[2] + (qb[2] - qa[2]) * f],
    };
  }
  return out;
}

type Quat = [number, number, number, number];
const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisQuat = (axis: 0 | 1 | 2, deg: number): Quat => {
  const h = (deg * Math.PI) / 360;
  const q: Quat = [0, 0, 0, Math.cos(h)];
  q[axis] = Math.sin(h);
  return q;
};
/** CFrame.Angles(x, y, z) (= Rx·Ry·Rz) as a quaternion [x, y, z, w]. */
const quatXYZ = (deg: readonly number[]): Quat => quatMul(quatMul(axisQuat(0, deg[0]!), axisQuat(1, deg[1]!)), axisQuat(2, deg[2]!));

/**
 * Rotation between two keys the way Roblox plays it, as XYZ angles again — measured in Studio: along
 * the shorter arc, as a normalized linear blend of the quaternions (nlerp) for Linear poses and at a
 * constant rate (slerp) for eased ones. Returns the keys' own angles at the ends so authored values survive.
 */
function blendAngles(ra: readonly number[], rb: readonly number[], f: number, linear: boolean): [number, number, number] {
  if (f === 0 || (ra[0] === rb[0] && ra[1] === rb[1] && ra[2] === rb[2])) return [ra[0]!, ra[1]!, ra[2]!];
  if (f === 1) return [rb[0]!, rb[1]!, rb[2]!];
  const a = quatXYZ(ra);
  let b = quatXYZ(rb);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    b = b.map((v) => -v) as Quat;
    dot = -dot;
  }
  let q: Quat;
  if (linear || dot > 0.9995) q = a.map((v, i) => v + (b[i]! - v) * f) as Quat;
  else {
    // Eased styles (Elastic, Bounce) overshoot past 0..1: slerp extrapolates along the same arc.
    const th = Math.acos(Math.min(1, dot));
    const s = Math.sin(th);
    const wa = Math.sin((1 - f) * th) / s;
    const wb = Math.sin(f * th) / s;
    q = a.map((v, i) => v * wa + b[i]! * wb) as Quat;
  }
  const n = Math.hypot(...q);
  if (n < 1e-9) return f < 0.5 ? [ra[0]!, ra[1]!, ra[2]!] : [rb[0]!, rb[1]!, rb[2]!];
  const [x, y, z, w] = q.map((v) => v / n) as Quat;
  // Rotation matrix entries of Rx·Ry·Rz: m02 = sin y, m12 = -sin x cos y, m22 = cos x cos y, m01 = -cos y sin z, m00 = cos y cos z.
  const m02 = 2 * (x * z + w * y);
  const deg = (r: number) => (r * 180) / Math.PI;
  if (Math.abs(m02) > 0.99999) {
    const m21 = 2 * (y * z + w * x);
    const m11 = 1 - 2 * (x * x + z * z);
    return [deg(Math.atan2(m21, m11)), m02 > 0 ? 90 : -90, 0];
  }
  const m12 = 2 * (y * z - w * x);
  const m22 = 1 - 2 * (x * x + y * y);
  const m01 = 2 * (x * y - w * z);
  const m00 = 1 - 2 * (y * y + z * z);
  return [deg(Math.atan2(-m12, m22)), deg(Math.asin(m02)), deg(Math.atan2(-m01, m00))];
}

// ─── Forward kinematics (matches Roblox: Part1 = Part0 * C0 * Transform * C1⁻¹) ────────────────

type M3 = [number, number, number, number, number, number, number, number, number];
export type V3 = [number, number, number];
/** A rigid transform (row-major rotation + position), like a CFrame. */
export interface Xf {
  r: M3;
  p: V3;
}

const IDENTITY: Xf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: [0, 0, 0] };

function mulR(a: M3, b: M3): M3 {
  const o = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return o;
}
const apply = (r: M3, v: V3): V3 => [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
export const xfMul = (a: Xf, b: Xf): Xf => {
  const q = apply(a.r, b.p);
  return { r: mulR(a.r, b.r), p: [a.p[0] + q[0], a.p[1] + q[1], a.p[2] + q[2]] };
};
export const xfPoint = (a: Xf, v: V3): V3 => {
  const q = apply(a.r, v);
  return [a.p[0] + q[0], a.p[1] + q[1], a.p[2] + q[2]];
};
const translate = (v: V3): Xf => ({ r: IDENTITY.r, p: v });

/** CFrame.Angles(x, y, z) in degrees (= Rx · Ry · Rz). */
export function anglesXYZ(deg: V3): M3 {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180) as V3;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mulR(mulR(rx, ry), rz);
}

export type RigPose = Partial<Record<Joint, { rot?: V3; pos?: V3 }>>;
export type RigFrames = Record<Joint | 'HumanoidRootPart', Xf>;

/** Every R15 part's transform relative to the HumanoidRootPart for a pose (unposed joints at rest). */
export function solveRig(pose: RigPose): RigFrames {
  const out = { HumanoidRootPart: IDENTITY } as RigFrames;
  for (const j of JOINTS) {
    const parent = out[R15_PARENT[j]];
    const { at, child } = R15_RIG.joints[j];
    const p = pose[j];
    const local: Xf = { r: anglesXYZ(p?.rot ?? [0, 0, 0]), p: p?.pos ?? [0, 0, 0] };
    out[j] = xfMul(xfMul(xfMul(parent, translate(at)), local), translate([-child[0], -child[1], -child[2]]));
  }
  return out;
}

/** Lowest point of the feet, or of one foot (studs, relative to the root); about -3.19 at rest. */
export function footLow(frames: RigFrames, side?: 'Left' | 'Right'): number {
  let low = Infinity;
  for (const f of side ? ([`${side}Foot`] as const) : (['LeftFoot', 'RightFoot'] as const)) {
    const [sx, sy, sz] = R15_RIG.sizes[f].map((v) => v / 2) as V3;
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) low = Math.min(low, xfPoint(frames[f], [a * sx, b * sy, c * sz])[1]);
  }
  return low;
}

export const REST_FOOT_LOW = footLow(solveRig({}));

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const addRot = (p: { rot?: V3 } | undefined, dx: number): V3 => {
  const r = p?.rot ?? [0, 0, 0];
  return [round3(r[0] + dx), r[1], r[2]];
};

export interface GroundOptions {
  /** Clips that never leave the ground: hips also come down when both feet float. */
  plant?: boolean;
  /**
   * How a sinking foot is fixed: "legs" (default, poses keep their crouch) bends that leg more — a
   * squat for a leg in front, a knee bend for a leg behind — and moves the hips only when the legs
   * can't bend enough; "hips" (locomotion) moves the hips.
   */
  fix?: 'legs' | 'hips';
}

/**
 * Keeps a clip's feet on the ground. In game the root stays at hip height, so a pose whose feet reach
 * below the rest height pushes them into the floor. Keys are fixed first; then fast motions that dip
 * through the floor between keys get in-between keys (up to 6). Tolerance 0.03 studs at keys, 0.06
 * between them.
 */
export function groundClip(c: AnimationClip, opts: GroundOptions = {}): AnimationClip {
  const TOL = 0.03;
  const fixPose = (pose: RigPose, k: ClipKey): { poses: ClipKey['poses']; changed: boolean } => {
    const poses = { ...k.poses };
    const gapOf = (side?: 'Left' | 'Right') => footLow(solveRig(pose), side) - REST_FOOT_LOW;
    let changed = false;
    if (opts.fix !== 'hips') {
      for (const side of ['Left', 'Right'] as const) {
        if (gapOf(side) >= -TOL) continue;
        const up = `${side}UpperLeg` as const;
        const low = `${side}LowerLeg` as const;
        const foot = `${side}Foot` as const;
        const base = { up: pose[up], low: pose[low], foot: pose[foot] };
        const behind = (base.up?.rot?.[0] ?? 0) < -2;
        const bend = (d: number) => {
          pose[up] = { ...base.up, rot: addRot(base.up, behind ? 0 : d / 2) };
          pose[low] = { ...base.low, rot: addRot(base.low, -d) };
          pose[foot] = { ...base.foot, rot: addRot(base.foot, behind ? d : d / 2) };
        };
        let lo = 0;
        let hi = 70;
        bend(hi);
        if (gapOf(side) >= -0.005) {
          for (let i = 0; i < 18; i++) {
            const mid = (lo + hi) / 2;
            bend(mid);
            if (gapOf(side) >= -0.005) hi = mid;
            else lo = mid;
          }
        }
        bend(hi);
        for (const j of [up, low, foot]) poses[j] = { ...poses[j], ease: k.poses[j]?.ease ?? k.poses.LowerTorso?.ease, dir: k.poses[j]?.dir ?? k.poses.LowerTorso?.dir, rot: pose[j]!.rot };
        changed = true;
      }
    }
    const gap = gapOf();
    const fix = gap < -TOL ? -gap : opts.plant && gap > TOL ? -gap : 0;
    if (fix) {
      const lt = poses.LowerTorso ?? { rot: pose.LowerTorso?.rot, pos: pose.LowerTorso?.pos, ease: k.poses[Object.keys(k.poses)[0] as Joint]?.ease };
      const pos = lt.pos ?? [0, 0, 0];
      poses.LowerTorso = { ...lt, pos: [pos[0], round3(pos[1] + fix), pos[2]] };
      pose.LowerTorso = { ...pose.LowerTorso, pos: poses.LowerTorso.pos };
      changed = true;
    }
    return { poses, changed };
  };

  let out: AnimationClip = {
    ...c,
    keys: c.keys.map((k) => {
      if (!k.poses.LowerTorso && !Object.keys(k.poses).some((j) => /Leg|Foot/.test(j))) return k;
      const r = fixPose({ ...(sampleClip(c, k.t) as RigPose) }, k);
      return r.changed ? { ...k, poses: r.poses } : k;
    }),
  };
  // In-betweens where a fast move dips through the floor.
  const d = clipDuration(out);
  for (let pass = 0; pass < 8; pass++) {
    let worst = { t: -1, gap: -0.06 };
    for (let t = 1 / 60; t < d; t += 1 / 60) {
      if (out.keys.some((k) => Math.abs(k.t - t) < 0.012)) continue;
      const gap = footLow(solveRig(sampleClip({ ...out, loop: false }, t))) - REST_FOOT_LOW;
      if (gap < worst.gap) worst = { t, gap };
    }
    if (worst.t < 0) break;
    const t = round3(worst.t);
    const sampled = sampleClip({ ...out, loop: false }, t) as RigPose;
    const prev = [...out.keys].reverse().find((k) => k.t < t);
    const full: ClipKey = { t, poses: {} };
    for (const [j, v] of Object.entries(sampled) as Array<[Joint, { rot: V3; pos: V3 }]>) {
      const src = prev?.poses[j];
      full.poses[j] = { rot: v.rot.map(round3) as V3, ...(j === 'LowerTorso' ? { pos: v.pos.map(round3) as V3 } : {}), ease: src?.ease ?? 'Linear', dir: src?.dir ?? 'InOut' };
    }
    const r = fixPose({ ...sampled }, full);
    out = { ...out, keys: [...out.keys, { t, poses: r.poses }].sort((a, b) => a.t - b.t) };
  }
  return out;
}

export interface ClipMetrics {
  /** Feet relative to their rest height (negative = in the floor). */
  footSink: number;
  footLift: number;
  /** Furthest the hands get in front of the root (studs). */
  rightHandForward: number;
  leftHandForward: number;
  /** The limb that gets furthest in front (a jab's left hand, a kick's right foot) and how far. */
  reach: { limb: StrikeLimb; forward: number };
  /**
   * Hand, foot and head positions at each marker: x right, y up, z forward (studs from the root), and
   * the striking limb there (the one furthest forward).
   */
  markers: Array<{ name: string; t: number; rightHand: V3; leftHand: V3; rightFoot: V3; leftFoot: V3; head: V3; strike: { limb: StrikeLimb; at: V3 } }>;
}

export type StrikeLimb = 'RightHand' | 'LeftHand' | 'RightFoot' | 'LeftFoot';
const LIMBS: StrikeLimb[] = ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot'];
/** A foot well off the floor (about knee height or more). */
const kicking = (f: RigFrames, l: StrikeLimb) => f[l].p[1] - REST_FOOT_LOW > 0.8;

const r2 = (v: number) => Math.round(v * 100) / 100;
const fwd = (p: V3): V3 => [r2(p[0]), r2(p[1]), r2(-p[2])];

/** Measures a clip on the default rig (the same numbers animation_check gets from Studio). */
export function clipMetrics(c: AnimationClip): ClipMetrics {
  const d = clipDuration(c);
  let sink = 0, lift = 0;
  const most = Object.fromEntries(LIMBS.map((l) => [l, -Infinity])) as Record<StrikeLimb, number>;
  for (let t = 0; t <= d + 1e-9; t += 1 / 60) {
    const f = solveRig(sampleClip({ ...c, loop: false }, t));
    const g = footLow(f) - REST_FOOT_LOW;
    sink = Math.min(sink, g);
    lift = Math.max(lift, g);
    // Feet only count when they come up off the floor (a kick), not when a stance puts one forward.
    for (const l of LIMBS) if (!l.endsWith('Foot') || kicking(f, l)) most[l] = Math.max(most[l], -f[l].p[2]);
  }
  const top = LIMBS.reduce((a, b) => (most[b] > most[a] ? b : a));
  return {
    footSink: r2(sink),
    footLift: r2(lift),
    rightHandForward: r2(most.RightHand),
    leftHandForward: r2(most.LeftHand),
    reach: { limb: top, forward: r2(most[top]) },
    markers: (c.markers ?? []).map((m) => {
      const f = solveRig(sampleClip({ ...c, loop: false }, m.t));
      const score = (l: StrikeLimb) => (l.endsWith('Foot') && !kicking(f, l) ? -Infinity : -f[l].p[2]);
      const strike = LIMBS.reduce((a, b) => (score(b) > score(a) ? b : a));
      return { name: m.name, t: m.t, rightHand: fwd(f.RightHand.p), leftHand: fwd(f.LeftHand.p), rightFoot: fwd(f.RightFoot.p), leftFoot: fwd(f.LeftFoot.p), head: fwd(f.Head.p), strike: { limb: strike, at: fwd(f[strike].p) } };
    }),
  };
}

/**
 * The wrist rotation that points a held weapon (along the hand's -Z, like a Roblox tool grip) in a
 * direction, given the rest of the pose: x right, y up, f forward from the character. Keeps the
 * hand's roll (Z). Used to author sword moves by where the blade should point.
 */
export function aimHand(pose: RigPose, side: 'Left' | 'Right', dir: [number, number, number]): V3 {
  const frames = solveRig(pose);
  const r = frames[`${side}LowerArm`].r;
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  // Rig space faces -Z: forward f is -z.
  const w: V3 = [dir[0] / len, dir[1] / len, -dir[2] / len];
  // Into the forearm's frame (transpose of a rotation = inverse).
  const d: V3 = [r[0] * w[0] + r[3] * w[1] + r[6] * w[2], r[1] * w[0] + r[4] * w[1] + r[7] * w[2], r[2] * w[0] + r[5] * w[1] + r[8] * w[2]];
  // Rx(x)·Ry(y)·(0,0,-1) = (-sin y, cos y·sin x, -cos y·cos x)
  const y = Math.asin(Math.max(-1, Math.min(1, -d[0])));
  const x = Math.atan2(d[1], -d[2]);
  const roll = pose[`${side}Hand`]?.rot?.[2] ?? 0;
  const deg = (v: number) => Math.round((v * 180) / Math.PI * 10) / 10;
  return [deg(x), deg(y), roll];
}

/** Which way the elbow points when a hand reaches somewhere: down (punches, guards), out to the side, or up (hooks). */
export type ElbowHint = 'low' | 'out' | 'high';

/**
 * Shoulder and elbow rotations that put a hand (its centre) at `target` (x right, y up, f forward from
 * the root), given the rest of the pose: a small numeric IK on the rig's own kinematics. Among the ways
 * to reach it, it keeps the elbow low and stays close to the arm's current angles. Unreachable targets
 * get the nearest point along the reach.
 */
export function reachHand(pose: RigPose, side: 'Left' | 'Right', target: [number, number, number], elbow: ElbowHint = 'low'): { upper: V3; lower: V3; error: number } {
  const up = `${side}UpperArm` as const;
  const low = `${side}LowerArm` as const;
  const goal: V3 = [target[0], target[1], -target[2]];
  const lowerRest = pose[low]?.rot ?? [0, 0, 0];
  const out = side === 'Right' ? 1 : -1;
  // Only the arm moves: its chain from the (fixed) torso frame.
  const torso = solveRig(pose).UpperTorso;
  const link = (parent: Xf, j: Joint, rot: V3, pos?: V3): Xf => {
    const { at, child } = R15_RIG.joints[j];
    return xfMul(xfMul(xfMul(parent, translate(at)), { r: anglesXYZ(rot), p: pos ?? [0, 0, 0] }), translate([-child[0], -child[1], -child[2]]));
  };
  const handRot = pose[`${side}Hand`]?.rot ?? [0, 0, 0];
  const arm = (p: number[]) => {
    const u = link(torso, up, [p[0]!, p[1]!, p[2]!], pose[up]?.pos);
    const l = link(u, low, [p[3]!, lowerRest[1], lowerRest[2]], pose[low]?.pos);
    return { l, h: link(l, `${side}Hand`, handRot, pose[`${side}Hand`]?.pos) };
  };
  const cost = (p: number[]): number => {
    const { l, h: hf } = arm(p);
    const h = hf.p;
    const e = l.p;
    const d2 = (h[0] - goal[0]) ** 2 + (h[1] - goal[1]) ** 2 + (h[2] - goal[2]) ** 2;
    const bend = p[3]! < 0 ? p[3]! ** 2 : p[3]! > 150 ? (p[3]! - 150) ** 2 : 0;
    const twist = Math.abs(p[1]!) > 90 ? (Math.abs(p[1]!) - 90) ** 2 : 0;
    const lean = elbow === 'low' ? e[1] : elbow === 'high' ? -e[1] : -out * e[0];
    // Of the ways to reach the point, stay near the arm's current angles (smooth blends between keys).
    let drift = 0;
    for (let i = 0; i < 4; i++) drift += (p[i]! - here[i]!) ** 2;
    return d2 + (elbow === 'low' ? 0.002 : 0.008) * lean + 1e-3 * (bend + twist) + (posed ? 2e-7 * drift : 0);
  };
  const now = pose[up]?.rot ?? [0, 0, 0];
  const here = [now[0], now[1], now[2], lowerRest[0]];
  const posed = !!pose[up]?.rot;
  const starts = [
    [now[0], now[1], now[2], pose[low]?.rot?.[0] ?? 0],
    [60, 0, 10 * out, 60],
    [90, 0, 0, 10],
    [140, 0, 20 * out, 40],
    [30, 0, -20 * out, 110],
  ];
  let best = { p: starts[0]!, c: Infinity };
  for (const s of starts) {
    let p = [...s];
    let c = cost(p);
    for (const step of [24, 12, 6, 3, 1.5, 0.75, 0.3, 0.1]) {
      for (let improved = true, guard = 0; improved && guard < 40; guard++) {
        improved = false;
        for (let i = 0; i < 4; i++) {
          for (const dir of [1, -1]) {
            const q = [...p];
            q[i] = q[i]! + dir * step;
            const qc = cost(q);
            if (qc < c) {
              p = q;
              c = qc;
              improved = true;
            }
          }
        }
      }
    }
    if (c < best.c) best = { p, c };
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const h = arm(best.p).h.p;
  return {
    upper: [r1(best.p[0]!), r1(best.p[1]!), r1(best.p[2]!)],
    lower: [r1(best.p[3]!), lowerRest[1], lowerRest[2]],
    error: Math.hypot(h[0] - goal[0], h[1] - goal[1], h[2] - goal[2]),
  };
}

/**
 * Hip and knee rotations that put a foot (its centre) at `target` (x right, y up, f forward from the
 * root) with the least change to the leg's current angles: plants a foot while the hips turn or dip.
 */
export function reachFoot(pose: RigPose, side: 'Left' | 'Right', target: [number, number, number]): { upper: V3; lower: V3; error: number } {
  const up = `${side}UpperLeg` as const;
  const low = `${side}LowerLeg` as const;
  const goal: V3 = [target[0], target[1], -target[2]];
  const hips = solveRig(pose).LowerTorso;
  const link = (parent: Xf, j: Joint, rot: V3, pos?: V3): Xf => {
    const { at, child } = R15_RIG.joints[j];
    return xfMul(xfMul(xfMul(parent, translate(at)), { r: anglesXYZ(rot), p: pos ?? [0, 0, 0] }), translate([-child[0], -child[1], -child[2]]));
  };
  const footRot = pose[`${side}Foot`]?.rot ?? [0, 0, 0];
  const lowerRest = pose[low]?.rot ?? [0, 0, 0];
  const foot = (p: number[]) => link(link(link(hips, up, [p[0]!, p[1]!, p[2]!], pose[up]?.pos), low, [p[3]!, lowerRest[1], lowerRest[2]], pose[low]?.pos), `${side}Foot`, footRot, pose[`${side}Foot`]?.pos).p;
  const start = [...(pose[up]?.rot ?? [0, 0, 0]), lowerRest[0]];
  const cost = (p: number[]): number => {
    const f = foot(p);
    const d2 = (f[0] - goal[0]) ** 2 + (f[1] - goal[1]) ** 2 + (f[2] - goal[2]) ** 2;
    const knee = p[3]! > 0 ? p[3]! ** 2 : p[3]! < -150 ? (p[3]! + 150) ** 2 : 0;
    let drift = 0;
    for (let i = 0; i < 4; i++) drift += (p[i]! - start[i]!) ** 2;
    return d2 + 1e-3 * knee + 1e-6 * drift;
  };
  let p = [...start];
  let c = cost(p);
  for (const step of [8, 4, 2, 1, 0.5, 0.25, 0.1]) {
    for (let improved = true, guard = 0; improved && guard < 60; guard++) {
      improved = false;
      for (let i = 0; i < 4; i++) {
        for (const dir of [1, -1]) {
          const q = [...p];
          q[i] = q[i]! + dir * step;
          const qc = cost(q);
          if (qc < c) {
            p = q;
            c = qc;
            improved = true;
          }
        }
      }
    }
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const f = foot(p);
  return { upper: [r1(p[0]!), r1(p[1]!), r1(p[2]!)], lower: [r1(p[3]!), lowerRest[1], lowerRest[2]], error: Math.hypot(f[0] - goal[0], f[1] - goal[1], f[2] - goal[2]) };
}

/**
 * Hands that don't end up where the authored clip's `reach` asked (measured on the final clip, after
 * grounding): out of the arm's reach, behind the body, or moved by the hips.
 */
export function reachMisses(authored: AnimationClip, final: AnimationClip, tol = 0.15): Array<{ t: number; hand: 'LeftHand' | 'RightHand'; target: V3; got: V3; miss: number }> {
  const out: Array<{ t: number; hand: 'LeftHand' | 'RightHand'; target: V3; got: V3; miss: number }> = [];
  for (const k of authored.keys) {
    for (const side of ['Left', 'Right'] as const) {
      const target = k.poses[`${side}Hand`]?.reach;
      if (!target) continue;
      const p = solveRig(sampleClip({ ...final, loop: false }, k.t))[`${side}Hand`].p;
      const got: V3 = [r2(p[0]), r2(p[1]), r2(-p[2])];
      const miss = Math.hypot(got[0] - target[0], got[1] - target[1], got[2] - target[2]);
      if (miss > tol) out.push({ t: k.t, hand: `${side}Hand`, target, got, miss: r2(miss) });
    }
  }
  return out;
}

/** XYZ angles (degrees, like CFrame.Angles) of a rotation matrix. */
export function eulerXYZ(r: M3): V3 {
  const deg = (v: number) => Math.round(((v * 180) / Math.PI) * 10) / 10;
  if (Math.abs(r[2]) > 0.99999) return [deg(Math.atan2(r[7], r[4])), r[2] > 0 ? 90 : -90, 0];
  return [deg(Math.atan2(-r[5], r[8])), deg(Math.asin(r[2])), deg(Math.atan2(-r[1], r[0]))];
}

/**
 * Plants a foot exactly as it stands in `stance` (the same place and angle) whatever the hips do:
 * the hip and knee put the ankle back where it was and the ankle turns the foot flat again.
 */
export function plantFoot(pose: RigPose, side: 'Left' | 'Right', stance: RigFrames): { upper: V3; lower: V3; foot: V3; error: number } {
  const ankle = xfPoint(stance[`${side}LowerLeg`], R15_RIG.joints[`${side}Foot`].at);
  const sol = reachFootJoint(pose, side, ankle);
  const legPose: RigPose = { ...pose, [`${side}UpperLeg`]: { ...pose[`${side}UpperLeg`], rot: sol.upper }, [`${side}LowerLeg`]: { ...pose[`${side}LowerLeg`], rot: sol.lower } };
  const rl = solveRig(legPose)[`${side}LowerLeg`].r;
  const rf = stance[`${side}Foot`].r;
  // Ankle rotation = Rlowerᵀ · Rfoot: the stance's foot angle seen from the new shin.
  const m = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = rl[i]! * rf[j]! + rl[3 + i]! * rf[3 + j]! + rl[6 + i]! * rf[6 + j]!;
  return { upper: sol.upper, lower: sol.lower, foot: eulerXYZ(m), error: sol.error };
}

/** Hip and knee rotations that put the ankle joint at a point (rig space: x right, y up, z back). */
function reachFootJoint(pose: RigPose, side: 'Left' | 'Right', ankle: V3): { upper: V3; lower: V3; error: number } {
  const up = `${side}UpperLeg` as const;
  const low = `${side}LowerLeg` as const;
  const hips = solveRig(pose).LowerTorso;
  const link = (parent: Xf, j: Joint, rot: V3, pos?: V3): Xf => {
    const { at, child } = R15_RIG.joints[j];
    return xfMul(xfMul(xfMul(parent, translate(at)), { r: anglesXYZ(rot), p: pos ?? [0, 0, 0] }), translate([-child[0], -child[1], -child[2]]));
  };
  const lowerRest = pose[low]?.rot ?? [0, 0, 0];
  const ankleAt = R15_RIG.joints[`${side}Foot`].at;
  const joint = (p: number[]) => xfPoint(link(link(hips, up, [p[0]!, p[1]!, p[2]!], pose[up]?.pos), low, [p[3]!, lowerRest[1], lowerRest[2]], pose[low]?.pos), ankleAt);
  const start = [...(pose[up]?.rot ?? [0, 0, 0]), lowerRest[0]];
  const cost = (p: number[]): number => {
    const a = joint(p);
    const d2 = (a[0] - ankle[0]) ** 2 + (a[1] - ankle[1]) ** 2 + (a[2] - ankle[2]) ** 2;
    const knee = p[3]! > 0 ? p[3]! ** 2 : p[3]! < -150 ? (p[3]! + 150) ** 2 : 0;
    let drift = 0;
    for (let i = 0; i < 4; i++) drift += (p[i]! - start[i]!) ** 2;
    return d2 + 1e-3 * knee + 1e-6 * drift;
  };
  let p = [...start];
  let c = cost(p);
  for (const step of [8, 4, 2, 1, 0.5, 0.25, 0.1]) {
    for (let improved = true, guard = 0; improved && guard < 60; guard++) {
      improved = false;
      for (let i = 0; i < 4; i++) {
        for (const dir of [1, -1]) {
          const q = [...p];
          q[i] = q[i]! + dir * step;
          const qc = cost(q);
          if (qc < c) {
            p = q;
            c = qc;
            improved = true;
          }
        }
      }
    }
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const a = joint(p);
  return { upper: [r1(p[0]!), r1(p[1]!), r1(p[2]!)], lower: [r1(p[3]!), lowerRest[1], lowerRest[2]], error: Math.hypot(a[0] - ankle[0], a[1] - ankle[1], a[2] - ankle[2]) };
}

/**
 * Replaces hand `reach`es with the shoulder/elbow rotations that achieve them, then hand `aim`s with
 * the wrist rotations that achieve them (poses sampled at each key).
 */
export function resolveAims(c: AnimationClip): AnimationClip {
  if (!c.keys.some((k) => k.poses.LeftHand?.aim || k.poses.RightHand?.aim || k.poses.LeftHand?.reach || k.poses.RightHand?.reach)) return c;
  // Reaches first: sample without them so every key sees the body pose it will have.
  if (c.keys.some((k) => k.poses.LeftHand?.reach || k.poses.RightHand?.reach)) {
    const plain: AnimationClip = { ...c, keys: c.keys.map((k) => ({ ...k, poses: Object.fromEntries(Object.entries(k.poses).map(([j, p]) => [j, p?.reach ? { ...p, reach: undefined } : p])) as ClipKey['poses'] })) };
    c = {
      ...c,
      keys: c.keys.map((k) => {
        const poses = { ...k.poses };
        for (const side of ['Left', 'Right'] as const) {
          const hand = poses[`${side}Hand`];
          if (!hand?.reach) continue;
          const pose = sampleClip({ ...plain, loop: false }, k.t) as RigPose;
          const sol = reachHand(pose, side, hand.reach, hand.elbow);
          const { reach, elbow, ...rest } = hand;
          void reach;
          void elbow;
          poses[`${side}Hand`] = rest;
          poses[`${side}UpperArm`] = { ease: rest.ease, dir: rest.dir, ...poses[`${side}UpperArm`], rot: sol.upper };
          poses[`${side}LowerArm`] = { ease: rest.ease, dir: rest.dir, ...poses[`${side}LowerArm`], rot: sol.lower };
        }
        return { ...k, poses };
      }),
    };
  }
  if (!c.keys.some((k) => k.poses.LeftHand?.aim || k.poses.RightHand?.aim)) return c;
  // Sample without the aims first so every key sees the arm pose it will have.
  const plain: AnimationClip = { ...c, keys: c.keys.map((k) => ({ ...k, poses: Object.fromEntries(Object.entries(k.poses).map(([j, p]) => [j, p?.aim ? { ...p, aim: undefined } : p])) as ClipKey['poses'] })) };
  return {
    ...c,
    keys: c.keys.map((k) => {
      const poses = { ...k.poses };
      for (const side of ['Left', 'Right'] as const) {
        const hand = poses[`${side}Hand`];
        if (!hand?.aim) continue;
        const pose = sampleClip({ ...plain, loop: false }, k.t) as RigPose;
        pose[`${side}Hand`] = { rot: hand.rot ?? pose[`${side}Hand`]?.rot, pos: hand.pos };
        const { aim, ...rest } = hand;
        poses[`${side}Hand`] = { ...rest, rot: aimHand(pose, side, aim) };
      }
      return { ...k, poses };
    }),
  };
}
