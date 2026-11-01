/**
 * Custom rigs (creatures, machines, anything that isn't an R15 character): a model's
 * models/<Model>.rig.json, written by the modeling export for models rigged with kiln.rig.
 *
 * Everything is in Roblox space at rest: studs, Y up, the model's front facing -Z (so +X is its right).
 * Each joint moves one segment (a group of the model's parts, `part`, which is also the joint's name),
 * turning about its `pivot`. Clips for a rig name its joints; a pose's rotation is degrees about the
 * model's axes at rest (x right, y up, z back), applied like CFrame.Angles(x, y, z), and its position
 * (studs) moves the joint in its parent segment. In Studio, rig_build makes one invisible part per
 * segment at its pivot (the model's parts welded to it) joined by Motor6Ds whose C0/C1 are axis-aligned
 * at rest, so a Pose's CFrame is exactly that rotation about the pivot.
 */

export type Vec3 = [number, number, number];

export interface RigJoint {
  name: string;
  /** The joint whose segment this one hangs from (null: the root). */
  parent: string | null;
  /** The segment it moves (same as name in rigs from kiln.rig). */
  part: string;
  pivot: Vec3;
  /** A hinge's axis (unit vector, Roblox space). */
  axis?: Vec3 | null;
  kind: 'hinge' | 'ball' | 'fixed';
  /**
   * Degrees. A hinge's angle about its axis ([min], [max]); a ball's per axis (x, y, z) about the
   * model's axes, like a clip's rot. Absent: unlimited.
   */
  limits?: { min: number[]; max: number[] } | null;
}

export interface RigLeg {
  /** Hip to ankle, in order. */
  joints: string[];
  /** The segment that touches the ground. */
  foot: string;
}

export interface RigAttachment {
  name: string;
  part: string;
  position: Vec3;
}

export interface RigSpec {
  version: number;
  model: string;
  root: string;
  joints: RigJoint[];
  legs: RigLeg[];
  attachments: RigAttachment[];
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Joint limits as rig.json gives them. Kiln's export writes kiln.rig's own values: a hinge's [min, max]
 * (degrees about its axis, which the export already turned into Roblox space) and a ball's
 * [[min x, y, z], [max x, y, z]] about Blender's axes, which become Roblox's here (Roblox x is Blender -x,
 * so that range flips; y is Blender z; z is Blender y). An object {min, max} is taken as Roblox axes.
 */
export function parseLimits(raw: unknown): { min: number[]; max: number[] } | null {
  const nums = (v: unknown): number[] | null => (typeof v === 'number' && Number.isFinite(v) ? [v] : isVec3(v) ? [...v] : null);
  let min: number[] | null = null;
  let max: number[] | null = null;
  if (Array.isArray(raw) && raw.length === 2) {
    min = nums(raw[0]);
    max = nums(raw[1]);
    if (min?.length === 3 && max?.length === 3) [min, max] = [[-max[0]!, min[2]!, min[1]!], [-min[0]!, max[2]!, max[1]!]];
  } else if (raw && typeof raw === 'object') {
    min = nums((raw as { min?: unknown }).min);
    max = nums((raw as { max?: unknown }).max);
  }
  if (!min || !max || min.length !== max.length) return null;
  const lo = min;
  const hi = max;
  return { min: lo.map((a, i) => Math.min(a, hi[i]!)), max: hi.map((b, i) => Math.max(b, lo[i]!)) };
}

/** A rig.json read into a RigSpec, or what is wrong with it. */
export function parseRig(raw: unknown): RigSpec | string {
  const o = raw as Partial<RigSpec> | null;
  if (!o || typeof o !== 'object') return 'not an object';
  if (!Array.isArray(o.joints) || !o.joints.length) return 'no joints';
  const joints: RigJoint[] = [];
  for (const j of o.joints as Array<Partial<RigJoint>>) {
    if (!j || typeof j.name !== 'string' || !j.name) return 'a joint has no name';
    if (!isVec3(j.pivot)) return `joint ${j.name} has no pivot`;
    joints.push({
      name: j.name,
      parent: typeof j.parent === 'string' && j.parent ? j.parent : null,
      part: typeof j.part === 'string' && j.part ? j.part : j.name,
      pivot: j.pivot,
      axis: isVec3(j.axis) ? j.axis : null,
      kind: j.kind === 'ball' || j.kind === 'fixed' ? j.kind : 'hinge',
      limits: parseLimits(j.limits),
    });
  }
  const names = new Set(joints.map((j) => j.name));
  for (const j of joints) if (j.parent && !names.has(j.parent)) return `joint ${j.name}'s parent ${j.parent} is not a joint`;
  const roots = joints.filter((j) => !j.parent);
  if (roots.length !== 1) return `a rig needs exactly one root joint (found ${roots.length})`;
  const root = typeof o.root === 'string' && names.has(o.root) ? o.root : roots[0]!.name;
  // No cycles: every joint reaches the root.
  const parentOf = new Map(joints.map((j) => [j.name, j.parent]));
  for (const j of joints) {
    let at: string | null = j.name;
    for (let n = 0; at && n <= joints.length; n++) at = parentOf.get(at) ?? null;
    if (at) return `joint ${j.name} is part of a loop`;
  }
  const legs = (Array.isArray(o.legs) ? o.legs : [])
    .filter((l): l is RigLeg => !!l && Array.isArray(l.joints) && l.joints.every((x) => names.has(x)) && typeof l.foot === 'string')
    .map((l) => ({ joints: [...l.joints], foot: l.foot }));
  const attachments = (Array.isArray(o.attachments) ? o.attachments : [])
    .filter((a): a is RigAttachment => !!a && typeof a.name === 'string' && typeof a.part === 'string' && isVec3(a.position))
    .map((a) => ({ name: a.name, part: a.part, position: a.position }));
  return { version: Number(o.version ?? 1), model: String(o.model ?? ''), root, joints, legs, attachments };
}

/** Joints from the root outwards (every joint after its parent). */
export function jointOrder(rig: RigSpec): RigJoint[] {
  const out: RigJoint[] = [];
  const byParent = new Map<string | null, RigJoint[]>();
  for (const j of rig.joints) byParent.set(j.parent, [...(byParent.get(j.parent) ?? []), j]);
  const walk = (parent: string | null) => {
    for (const j of byParent.get(parent) ?? []) {
      out.push(j);
      walk(j.name);
    }
  };
  walk(null);
  return out;
}

// ─── A little rigid-body math (column vectors; 3×4 matrices as [r00..r22, tx, ty, tz]) ───────────

/** A rigid transform: rotation matrix (row-major 3×3) and translation. */
export interface Xform {
  r: number[];
  t: Vec3;
}

export const IDENTITY: Xform = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** CFrame.Angles(x, y, z) in degrees: Rx · Ry · Rz. */
export function anglesMatrix(deg: Vec3): number[] {
  const [a, b, c] = deg.map((d) => (d * Math.PI) / 180) as Vec3;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // Rx(a) * Ry(b) * Rz(c)
  return [
    cb * cc, -cb * sc, sb,
    sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb,
    -ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb,
  ];
}

export function compose(a: Xform, b: Xform): Xform {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a.r[i * 3]! * b.r[j]! + a.r[i * 3 + 1]! * b.r[3 + j]! + a.r[i * 3 + 2]! * b.r[6 + j]!;
  return { r, t: apply(a, b.t) };
}

export function apply(x: Xform, p: Vec3): Vec3 {
  return [
    x.r[0]! * p[0] + x.r[1]! * p[1] + x.r[2]! * p[2] + x.t[0],
    x.r[3]! * p[0] + x.r[4]! * p[1] + x.r[5]! * p[2] + x.t[1],
    x.r[6]! * p[0] + x.r[7]! * p[1] + x.r[8]! * p[2] + x.t[2],
  ];
}

export interface SegmentPose {
  rot?: Vec3;
  pos?: Vec3;
}

/**
 * Where every segment is for a set of joint poses: for each joint, the transform that takes its
 * segment from rest to posed (model space). A joint turns about its pivot: parent · T(pivot + pos) ·
 * R · T(−pivot), exactly what its Motor6D does with axis-aligned C0/C1.
 */
export function forwardKinematics(rig: RigSpec, poses: Record<string, SegmentPose | undefined>): Map<string, Xform> {
  const out = new Map<string, Xform>();
  for (const j of jointOrder(rig)) {
    const parent = j.parent ? (out.get(j.parent) ?? IDENTITY) : IDENTITY;
    const p = poses[j.name];
    const rot = p?.rot ?? [0, 0, 0];
    const pos = p?.pos ?? [0, 0, 0];
    const toPivot: Xform = { r: IDENTITY.r, t: [j.pivot[0] + pos[0], j.pivot[1] + pos[1], j.pivot[2] + pos[2]] };
    const turn: Xform = { r: anglesMatrix(rot), t: [0, 0, 0] };
    const back: Xform = { r: IDENTITY.r, t: [-j.pivot[0], -j.pivot[1], -j.pivot[2]] };
    out.set(j.name, compose(parent, compose(toPivot, compose(turn, back))));
  }
  return out;
}

/** What checkRigClip measured on a custom rig's clip (the Animation page shows it). */
export interface RigClipMetrics {
  duration: number;
  /** Deepest the model goes into the ground (studs below its rest ground), where and when. */
  sink: { depth: number; segment: string; t: number } | null;
  /** Legged rigs: the longest stretch with no foot on the ground (s). */
  airborne: number | null;
  /** Legged loops: how fast planted feet travel backward — move the model at this speed (studs/s). */
  groundSpeed: number | null;
  /** Per foot: share of the clip on the ground, and how unevenly it moves while planted (studs/s). */
  feet: Array<{ foot: string; contact: number; slide: number }>;
  /** At each marker: attachments (x right, y up, f forward; studs from the root joint at rest) and how far the front reaches past its rest front. */
  markers: Array<{ name: string; t: number; attachments: Record<string, [number, number, number]>; reach: number }>;
}
