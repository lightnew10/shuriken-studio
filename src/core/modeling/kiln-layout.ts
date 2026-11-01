import { createHash } from 'node:crypto';
import type { ModelInstance } from './backend';
import type { KilnManifest, Mat4, Vec3 } from './kiln-manifest';
import { fxTable, partFx, PART_ROLES, type PartFx, type PartRole } from './part-traits';

/**
 * A Kiln map (manifest v2, see kiln-manifest.ts) as what Studio must hold: which mesh goes where.
 *
 * The frames, once, because everything here depends on them:
 * - Kiln: scene units, Blender axes, Z up, a model's front faces -Y. A placement's matrix M (4x4 row-major) puts the
 *   piece's own coordinates into the world: world = A p + t (A its upper 3x3, t its translation).
 * - Roblox: studs, Y up, a model's front faces -Z. Shuriken's export (roblox_export.py, TO_RBX) maps Blender
 *   (x, y, z) to Roblox (-x, z, y): a proper rotation T, so nothing is mirrored and windings keep.
 * - A piece is exported from its own project in studs: q = kP T p (kP its project's studs per unit). In the layout it is
 *   seen in the layout's units, so in Roblox: w = kL T (A p + t) = (kL / kP) (T A T^-1) q + kL T t = B q + d.
 * - A MeshPart draws its mesh centred on its box: w = R (S * v) + P for a vertex v of the mesh (relative to the box
 *   centre c, the part's `origin` in its model), with CFrame rotation R, position P and S = Size / the mesh's own size.
 *   So B = R diag(S) (the columns' lengths are the scale; non-uniform scale is fine, it is along the piece's own axes)
 *   and P = B c + d.
 * - Roblox's importer turns every uploaded mesh 180 degrees about Y about its own centre. Shuriken uploads a copy that
 *   is turned first (modeling/glb.ts, `facing: 2`), so such a part arrives as exported and needs nothing here; a legacy
 *   upload gets CFrame * Angles(0, pi, 0) in the Luau (the template's ShurikenTurned attribute). A half turn about Y is
 *   diag(-1, 1, -1): it commutes with diag(S), so the Size is the same either way.
 * - A marker's +Y (Blender, its own axes) is its facing and its +Z its up: the anchor part's LookVector (its -Z) is that
 *   facing, so a car model (front -Z in Roblox) pivoted to the marker's CFrame faces where the marker points.
 */

export type M3 = [Vec3, Vec3, Vec3];

/** Blender (x, y, z) in scene units → Roblox studs (k = studs per unit). */
export const toRoblox = (v: readonly number[], k = 1): Vec3 => [-v[0]! * k, v[2]! * k, v[1]! * k];
/** Roblox studs → Blender (x, y, z) in scene units. */
export const fromRoblox = (v: readonly number[], k = 1): Vec3 => [-v[0]! / k, v[2]! / k, v[1]! / k];

const PERM = [0, 2, 1] as const;
const SIGN = [-1, 1, 1] as const;

export const mul3 = (A: M3, B: M3): M3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[i]![0] * B[0]![j]! + A[i]![1] * B[1]![j]! + A[i]![2] * B[2]![j]!)) as M3;
export const mulV = (A: M3, v: readonly number[]): Vec3 => [0, 1, 2].map((i) => A[i]![0] * v[0]! + A[i]![1] * v[1]! + A[i]![2] * v[2]!) as Vec3;
const transpose = (A: M3): M3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j]![i]!)) as M3;
const det3 = (A: M3): number => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

/** T A T^-1 for the axis change T: a Blender 3x3 as the same map in Roblox axes. */
export const axesToRoblox = (A: readonly (readonly number[])[]): M3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => SIGN[i]! * SIGN[j]! * A[PERM[i]!]![PERM[j]!]!)) as M3;

/** What a placement does to a piece's exported model (Roblox space, studs): w = B q + d. */
export interface Frame {
  B: M3;
  d: Vec3;
}

export const IDENTITY: Frame = { B: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], d: [0, 0, 0] };

/** The frame of a placement: `kLayout` and `kPiece` are the studs per unit of the layout's and the piece's own project. */
export function placementFrame(matrix: Mat4, kLayout: number, kPiece: number = kLayout): Frame {
  const f = kLayout / (kPiece || 1);
  const B = axesToRoblox(matrix).map((row) => row.map((v) => v * f)) as M3;
  return { B, d: toRoblox([matrix[0][3], matrix[1][3], matrix[2][3]], kLayout) };
}

/** The rotation nearest to a nearly orthogonal matrix (its polar factor; Newton's iteration). */
function nearestRotation(X: M3): M3 {
  let R = X;
  for (let i = 0; i < 12; i++) {
    const d = det3(R);
    if (Math.abs(d) < 1e-12) break;
    // the inverse transpose is the cofactor matrix over the determinant
    const c: M3 = [
      [R[1][1] * R[2][2] - R[1][2] * R[2][1], R[1][2] * R[2][0] - R[1][0] * R[2][2], R[1][0] * R[2][1] - R[1][1] * R[2][0]],
      [R[0][2] * R[2][1] - R[0][1] * R[2][2], R[0][0] * R[2][2] - R[0][2] * R[2][0], R[0][1] * R[2][0] - R[0][0] * R[2][1]],
      [R[0][1] * R[1][2] - R[0][2] * R[1][1], R[0][2] * R[1][0] - R[0][0] * R[1][2], R[0][0] * R[1][1] - R[0][1] * R[1][0]],
    ];
    R = R.map((row, a) => row.map((v, b) => (v + c[a]![b]! / d) / 2)) as M3;
  }
  return R;
}

/**
 * A linear map as a MeshPart can show it: a rotation R and a positive scale S per axis of the mesh, B = R diag(S).
 * `mirrored`: the determinant is negative (a Roblox part can't be mirrored). `sheared`: the columns are not at right
 * angles (a non-uniform scale under a rotation): R is then the nearest rotation, an approximation. Null when an axis
 * has collapsed to nothing.
 */
export function decompose(B: M3): { R: M3; S: Vec3; mirrored: boolean; sheared: boolean } | null {
  const S = [0, 1, 2].map((j) => Math.hypot(B[0]![j]!, B[1]![j]!, B[2]![j]!)) as Vec3;
  if (Math.min(...S) < 1e-6 || S.some((s) => !Number.isFinite(s))) return null;
  let R = B.map((row) => row.map((v, j) => v / S[j]!)) as M3;
  const mirrored = det3(R) < 0;
  const g = mul3(transpose(R), R);
  let off = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) off = Math.max(off, Math.abs(g[i]![j]! - (i === j ? 1 : 0)));
  // Kiln rounds matrices to 5 decimals (about 3e-5 off orthogonal); real shear is far above that.
  const sheared = off > 2e-3;
  if (!mirrored && off > 1e-12) R = nearestRotation(R);
  return { R, S, mirrored, sheared };
}

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/** Degrees (x, y, z) with R = Ry(y) Rx(x) Rz(z): what CFrame.fromOrientation(x, y, z) builds (the exporter's _euler_yxz). */
export function eulerYXZ(R: M3): Vec3 {
  const a = Math.asin(Math.max(-1, Math.min(1, -R[1][2])));
  // (+ 0: never a negative zero)
  if (Math.abs(Math.cos(a)) > 1e-6) return [deg(a) + 0, deg(Math.atan2(R[0][2], R[2][2])) + 0, deg(Math.atan2(R[1][0], R[1][1])) + 0];
  return [deg(a) + 0, deg(Math.atan2(-R[2][0], R[0][0])) + 0, 0];
}

/** R = Ry(y) Rx(x) Rz(z) for degrees (x, y, z): CFrame.fromOrientation. */
export function rotationYXZ(d: readonly number[]): M3 {
  const [a, b, c] = [rad(d[0]!), rad(d[1]!), rad(d[2]!)];
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [
    [cb * cc + sb * sa * sc, -cb * sc + sb * sa * cc, sb * ca],
    [ca * sc, ca * cc, -sa],
    [-sb * cc + cb * sa * sc, sb * sc + cb * sa * cc, cb * ca],
  ];
}

/** Where one MeshPart goes: its centre, its orientation (degrees, Y X Z) and its Size relative to the mesh's own size. */
export interface Use {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  sheared?: boolean;
}

/**
 * A part of a piece under a placement: `origin` is the part's box centre in its model, `inst` one use of an instanced
 * part (its own position, turn and scale within the model). Null for what can't be placed (mirrored, or collapsed).
 */
export function partUse(frame: Frame, origin: readonly number[], inst?: ModelInstance): Use | null {
  const centre = inst ? inst.position : origin;
  let B = frame.B;
  if (inst) {
    const Ri = rotationYXZ(inst.rotation);
    B = mul3(B, Ri.map((row) => row.map((v, j) => v * inst.scale[j]!)) as M3);
  }
  const dec = decompose(B);
  if (!dec || dec.mirrored) return null;
  const at = mulV(frame.B, centre);
  return { position: [at[0] + frame.d[0], at[1] + frame.d[1], at[2] + frame.d[2]], rotation: eulerYXZ(dec.R), scale: dec.S, ...(dec.sheared ? { sheared: true } : {}) };
}

/** The pivot of a placement: where the piece's own origin and axes are in the world (its scale left out). */
export function framePivot(frame: Frame): { position: Vec3; rotation: Vec3 } {
  const dec = decompose(frame.B);
  return { position: frame.d, rotation: dec && !dec.mirrored ? eulerYXZ(dec.R) : [0, 0, 0] };
}

/** Roblox-local (X, Y, Z) of an anchor part in the marker's Blender axes: right +X, up +Z, back -Y (so LookVector is its +Y). */
const MARKER_AXES: M3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];

/** A marker as an anchor part: position (studs), orientation (degrees, Y X Z) and the direction it faces (its LookVector). */
export function markerFrame(matrix: Mat4, k: number): { position: Vec3; rotation: Vec3; look: Vec3 } {
  const A = [0, 1, 2].map((i) => [matrix[i]![0], matrix[i]![1], matrix[i]![2]]) as M3;
  const dec = decompose(A);
  // A marker with a collapsed or mirrored transform still marks its spot: it faces Blender +Y.
  const Rb: M3 = dec && !dec.mirrored ? dec.R : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // T Rb C: C takes the part's own axes to the marker's, T takes Blender's to Roblox's.
  const RbC = mul3(Rb, MARKER_AXES);
  const R = [0, 1, 2].map((i) => RbC[PERM[i]!]!.map((v) => SIGN[i]! * v)) as M3;
  return { position: toRoblox([matrix[0][3], matrix[1][3], matrix[2][3]], k), rotation: eulerYXZ(R), look: [-R[0][2], -R[1][2], -R[2][2]] };
}

// ---- Sockets ------------------------------------------------------------------------------------------------------------

/** A frame in a model's Roblox space: where it is (studs) and how it is turned (degrees, Y X Z: CFrame.fromOrientation). */
export interface RobloxFrame {
  position: Vec3;
  rotation: Vec3;
  /** The direction of the socket's +Y (its facing) in the same space: the frame's +Z axis (opposite its LookVector). */
  facing: Vec3;
}

/**
 * A socket of a Kiln model (manifest `models[].sockets[]`, Kiln 0.8.2: a 4x4 row-major matrix in the model's own
 * space, Blender axes, scene units) as a frame relative to the model's pivot in Roblox (studs, Y up): the same axis
 * change every placement goes through (T M T^-1, the translation times the studs per unit), nothing else. The frame's
 * axes are the socket's own, renamed as all geometry is: its +X is the socket's -X, its +Y the socket's +Z (up), its +Z
 * the socket's +Y (the facing). Two mating sockets have one world frame once assembled, so two Attachments made this
 * way are lined up exactly (a RigidConstraint, or part.CFrame = other.WorldCFrame * own.CFrame:Inverse()).
 * A socket matrix that carries a scale is read by its rotation.
 */
export function socketFrame(matrix: Mat4, studsPerUnit: number): RobloxFrame {
  const A = [0, 1, 2].map((i) => [matrix[i]![0], matrix[i]![1], matrix[i]![2]]) as M3;
  const dec = decompose(axesToRoblox(A));
  const R: M3 = dec && !dec.mirrored ? dec.R : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return { position: toRoblox([matrix[0][3], matrix[1][3], matrix[2][3]], studsPerUnit), rotation: eulerYXZ(R), facing: [R[0][2], R[1][2], R[2][2]] };
}

/**
 * `Attachment.CFrame` for a socket on one of its model's MeshParts (an Attachment's CFrame is relative to its part):
 * position and orientation (degrees, Y X Z) to set as CFrame.new(p) * CFrame.fromOrientation(r).
 * - `origin`: the part's box centre relative to the model's pivot, in Roblox space and studs (a part's `origin` in
 *   the model store is in the export's frame: take the model's own origin off first, toRoblox(model.origin, k), when
 *   the model does not sit at the scene's origin).
 * - `legacy`: the part's upload predates the pre-turn (ModelStore.legacyUpload): Shuriken's builders give such a part
 *   CFrame * Angles(0, pi, 0) because Roblox's importer turned its mesh about its own centre, so the Attachment is
 *   expressed in that turned frame (x and z of its position negated, its orientation turned back by the same half turn).
 *   Uploads made now (`facing: 2`) and temporary meshes need nothing.
 */
export function socketAttachment(matrix: Mat4, studsPerUnit: number, part: { origin: readonly number[]; legacy?: boolean }): { position: Vec3; rotation: Vec3 } {
  const f = socketFrame(matrix, studsPerUnit);
  const p: Vec3 = [f.position[0] - part.origin[0]!, f.position[1] - part.origin[1]!, f.position[2] - part.origin[2]!];
  if (!part.legacy) return { position: p, rotation: f.rotation };
  // H^-1 * F with H = Angles(0, pi, 0) = diag(-1, 1, -1): rows 0 and 2 of the rotation and of the position change sign.
  const R = rotationYXZ(f.rotation).map((row, i) => (i === 1 ? row : row.map((v) => -v))) as M3;
  return { position: [-p[0], p[1], -p[2]], rotation: eulerYXZ(R) };
}

// ---- The plan -----------------------------------------------------------------------------------------------------------

/** A part of a model as the layout needs it (from the model store and the export). */
export interface LayoutPart {
  name: string;
  /** Its box centre in its model (Roblox space, studs). */
  origin: Vec3;
  size: Vec3;
  instances?: ModelInstance[];
  role?: PartRole;
  replaced?: boolean;
  box?: boolean;
  fill?: number;
  doubleSided?: boolean;
  transparency?: number;
  color?: string;
  material?: string;
  /** The hash of its mesh and maps (ModelMeta.hash). */
  hash: string;
  /** Its uploaded asset for that hash, or null (a temporary mesh stands in, or it is missing). */
  asset: string | null;
  /** A legacy upload: its mesh arrives turned 180 degrees about Y about its centre. */
  legacy: boolean;
}

export interface PlanTemplate {
  name: string;
  asset: string | null;
  size: Vec3;
  color?: string;
  material?: string;
  fx: PartFx | null;
  turn: boolean;
  /** Changes when the mesh, its asset or its look does: a kit template (and every clone of it) is made again. */
  stamp: string;
}

export interface PlanUse {
  /** Index into `templates`. */
  t: number;
  p: Vec3;
  r: Vec3;
  s: Vec3;
  /** Index + 1 into `fx` (traits that differ from the template's), 0 for none. */
  fx: number;
}

/** One thing in the DataModel: a placement of a piece (a Model when it has several parts), or a part of the layout itself. */
export interface PlanUnit {
  name: string;
  group: 'Static' | 'Pieces';
  /** Its grid cell's folder ("" for Static). */
  cell: string;
  pivot: { p: Vec3; r: Vec3 };
  uses: PlanUse[];
  /** Changes when anything about it does: an unchanged unit is left alone by the next import. */
  fp: string;
}

export interface PlanMarker {
  name: string;
  role: string;
  p: Vec3;
  r: Vec3;
  look: Vec3;
}

export interface PlanPath {
  name: string;
  role: string;
  /** Studs. */
  width: number | null;
  closed: boolean;
  /** Studs, Roblox axes. */
  points: Vec3[];
  length: number;
}

export interface LayoutPlan {
  map: string;
  templates: PlanTemplate[];
  /** Trait tables (Luau) that uses refer to. */
  fx: string[];
  units: PlanUnit[];
  markers: PlanMarker[];
  paths: PlanPath[];
  notes: string[];
  counts: { placements: number; placed: number; parts: number; mirrored: number; sheared: number; missingPieces: number; oversize: number };
}

/** Units are grouped in folders by grid cell of this many studs (see docs/ARCHITECTURE.md: why, and what it does for streaming). */
export const LAYOUT_CELL = 512;
/** A MeshPart is at most this many studs on a side. */
const PART_LIMIT = 2048;

const sha = (text: string, n = 10) => createHash('sha1').update(text).digest('hex').slice(0, n);
// (+ 0: never a negative zero in the numbers sent to Studio)
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;
const v4 = (v: readonly number[]): Vec3 => [r4(v[0]!), r4(v[1]!), r4(v[2]!)];

const asRole = (r: string | undefined): PartRole | undefined => (r && (PART_ROLES as readonly string[]).includes(r) ? (r as PartRole) : undefined);

/** A model instance name that survives a path and a Luau string: Blender's "Tree.001" becomes "Tree_001". */
export const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_\- ]/g, '_').slice(0, 80) || 'Unnamed';

export interface PlanInput {
  map: string;
  manifest: KilnManifest;
  /** The layout project's own geometry (ground, road, one-off buildings), already in Roblox space and studs. */
  own: LayoutPart[];
  /** Piece name → the model its project was exported as, that project's studs per unit, and its parts. */
  pieces: Record<string, { model: string; studsPerUnit: number; parts: LayoutPart[] }>;
  cell?: number;
  /**
   * The templates are temporary meshes (built from mesh.json, not saved with the place), whatever is uploaded: their
   * stamps and the units' fingerprints differ from the uploaded ones, so a later import with uploads replaces them all.
   */
  temporary?: boolean;
}

/**
 * Everything Studio must hold for a map: one kit template per unique mesh, one unit per placement (and per part of the
 * layout itself), the markers and the paths. Pure: no Kiln, no Studio, no files.
 */
export function planLayout(input: PlanInput): LayoutPlan {
  const { manifest } = input;
  const k = manifest.studsPerUnit;
  const cellSize = input.cell ?? LAYOUT_CELL;
  const notes: string[] = [];
  const templates: PlanTemplate[] = [];
  const templateAt = new Map<string, number>();
  const fx: string[] = [];
  const fxAt = new Map<string, number>();
  const counts = { placements: manifest.placements.length, placed: 0, parts: 0, mirrored: 0, sheared: 0, missingPieces: 0, oversize: 0 };

  const template = (part: LayoutPart): number => {
    const have = templateAt.get(part.name);
    if (have !== undefined) return have;
    const traits = partFx(part);
    // A temporary mesh is built from the export as it is: never an asset, never turned by Roblox's importer.
    const asset = input.temporary ? null : part.asset;
    const turn = !input.temporary && part.legacy;
    const t: PlanTemplate = {
      name: part.name,
      asset,
      size: part.size,
      ...(part.color ? { color: part.color } : {}),
      ...(part.material ? { material: part.material } : {}),
      fx: traits,
      turn,
      stamp: sha(JSON.stringify([part.hash, input.temporary ? 'temporary' : asset, part.size, part.color ?? null, part.material ?? null, fxTable(traits), turn])),
    };
    templateAt.set(part.name, templates.length);
    templates.push(t);
    return templates.length - 1;
  };
  /** The traits a use gets when they differ from its template's (a placement's own role, or a collider standing in for it). */
  const override = (part: LayoutPart, role: PartRole | undefined, replaced: boolean): number => {
    if (!role && !replaced) return 0;
    if (part.role === 'collider') return 0; // a piece's own collider keeps colliding, whatever the placement is tagged
    const own = fxTable(partFx(part));
    const now = fxTable(partFx({ ...part, role: role ?? part.role, replaced: replaced || part.replaced }));
    if (now === own || now === 'nil') return 0;
    let at = fxAt.get(now);
    if (at === undefined) {
      at = fx.length;
      fxAt.set(now, at);
      fx.push(now);
    }
    return at + 1;
  };
  const cellOf = (p: readonly number[]) => `c_${Math.floor(p[0]! / cellSize)}_${Math.floor(p[2]! / cellSize)}`;
  const taken = new Set<string>();
  const unique = (group: string, cell: string, name: string): string => {
    let n = name;
    for (let i = 2; taken.has(`${group}/${cell}/${n}`); i++) n = `${name}~${i}`;
    taken.add(`${group}/${cell}/${n}`);
    return n;
  };
  const units: PlanUnit[] = [];
  const unit = (name: string, group: PlanUnit['group'], pivot: { position: Vec3; rotation: Vec3 }, uses: PlanUse[]) => {
    if (!uses.length) return;
    const cell = group === 'Static' ? '' : cellOf(pivot.position);
    const piv = { p: v4(pivot.position), r: v4(pivot.rotation) };
    for (const u of uses) if (Math.max(...u.s.map((s, i) => s * templates[u.t]!.size[i]!)) > PART_LIMIT) counts.oversize++;
    counts.parts += uses.length;
    units.push({ name: unique(group, cell, safeName(name)), group, cell, pivot: piv, uses, fp: sha(JSON.stringify([piv, uses.map((u) => [templates[u.t]!.stamp, u.p, u.r, u.s, u.fx ? fx[u.fx - 1] : 0])])) });
  };
  const use = (part: LayoutPart, u: Use, fxIndex: number): PlanUse => {
    if (u.sheared) counts.sheared++;
    return { t: template(part), p: v4(u.position), r: v4(u.rotation), s: [r5(u.scale[0]), r5(u.scale[1]), r5(u.scale[2])], fx: fxIndex };
  };

  // The layout's own geometry: a part at its origin, or one unit per use of a mesh the layout itself instances.
  for (const part of input.own) {
    if (part.instances?.length) {
      part.instances.forEach((inst, i) => {
        const u = partUse(IDENTITY, part.origin, inst);
        if (u) unit(`${part.name}_${i + 1}`, 'Pieces', { position: u.position, rotation: u.rotation }, [use(part, u, 0)]);
      });
    } else {
      unit(part.name, 'Static', { position: part.origin, rotation: [0, 0, 0] }, [use(part, { position: part.origin, rotation: [0, 0, 0], scale: [1, 1, 1] }, 0)]);
    }
  }

  // Placements: what a collider of the layout stands for doesn't collide itself.
  const stoodFor = new Set(manifest.colliders.map((c) => c.standsFor).filter((s): s is string => !!s));
  const mirroredNames = new Set(manifest.mirroredPlacements);
  const missing = new Map<string, number>();
  for (const pl of manifest.placements) {
    const piece = input.pieces[pl.piece];
    if (!piece || !piece.parts.length) {
      missing.set(pl.piece, (missing.get(pl.piece) ?? 0) + 1);
      continue;
    }
    const frame = placementFrame(pl.matrix, k, piece.studsPerUnit);
    const dec = decompose(frame.B);
    if (!dec || dec.mirrored || mirroredNames.has(pl.name)) {
      counts.mirrored++;
      continue;
    }
    const role = asRole(pl.role);
    const replaced = stoodFor.has(pl.name) || stoodFor.has(pl.piece) || stoodFor.has(`Piece_${pl.piece}`);
    const uses: PlanUse[] = [];
    for (const part of piece.parts) {
      const fxIndex = override(part, role, replaced);
      for (const inst of part.instances?.length ? part.instances : [undefined]) {
        const u = partUse(frame, part.origin, inst);
        if (u) uses.push(use(part, u, fxIndex));
      }
    }
    unit(pl.name, 'Pieces', framePivot(frame), uses);
    counts.placed++;
  }
  counts.missingPieces = [...missing.values()].reduce((a, b) => a + b, 0);
  for (const [name, n] of missing) notes.push(`Piece "${name}" has no exported model: its ${n} placement${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} left out.`);
  if (counts.mirrored) notes.push(`${counts.mirrored} mirrored placement${counts.mirrored === 1 ? ' was' : 's were'} left out: a Roblox part can't be mirrored (give the placement a positive scale in Kiln, or build the mirrored piece as its own project).`);
  if (counts.sheared) notes.push(`${counts.sheared} part${counts.sheared === 1 ? ' is' : 's are'} placed approximately: a non-uniform scale on a placement whose piece turns its own parts is a shear, which a MeshPart can't show (the nearest rotation is used).`);
  if (counts.oversize) notes.push(`${counts.oversize} placed part${counts.oversize === 1 ? ' is' : 's are'} over ${PART_LIMIT.toLocaleString('en-US')} studs on a side after the placement's scale: Roblox clamps a part's size there.`);

  const markers: PlanMarker[] = manifest.markers.map((m) => {
    const f = markerFrame(m.matrix, k);
    return { name: safeName(m.name), role: m.role, p: v4(f.position), r: v4(f.rotation), look: v4(f.look) };
  });
  const paths: PlanPath[] = manifest.paths.map((p) => {
    const points = p.points.map((q) => v4(toRoblox(q, k)));
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1], points[i]![2] - points[i - 1]![2]);
    if (p.closed && points.length > 2) length += Math.hypot(points[0]![0] - points.at(-1)![0], points[0]![1] - points.at(-1)![1], points[0]![2] - points.at(-1)![2]);
    return { name: p.name, role: p.role, width: p.width === null ? null : r4(p.width * k), closed: p.closed, points, length: r4(length) };
  });
  units.sort((a, b) => a.group.localeCompare(b.group) || a.cell.localeCompare(b.cell) || a.name.localeCompare(b.name));
  return { map: input.map, templates, fx, units, markers, paths, notes, counts };
}

/**
 * Units cut into calls: one execute_luau call must neither time out nor carry too much source, so a batch holds at
 * most `maxUses` MeshParts and `maxChars` of rows. Units keep their order (cell by cell).
 */
export function batchUnits<T extends { uses: unknown[] }>(units: T[], opts: { maxUses: number; maxChars?: number; chars?: (u: T) => number }): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let uses = 0;
  let chars = 0;
  for (const u of units) {
    const c = opts.chars ? opts.chars(u) : 0;
    if (cur.length && (uses + u.uses.length > opts.maxUses || (opts.maxChars !== undefined && chars + c > opts.maxChars))) {
      out.push(cur);
      cur = [];
      uses = 0;
      chars = 0;
    }
    cur.push(u);
    uses += u.uses.length;
    chars += c;
  }
  if (cur.length) out.push(cur);
  return out;
}
