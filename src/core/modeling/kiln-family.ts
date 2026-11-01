import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProjectContext } from '../projects/project-service';
import { AnimationStore } from '../animation/animation-service';
import type { ManifestFit, ManifestModel, Mat4, Vec3 } from './kiln-manifest';
import { socketFrame, toRoblox } from './kiln-layout';
import type { MemberSpec, SocketSpec } from './kiln-brief';

/**
 * Parts that must fit together (a mech's torsos, legs, arms, weapons). Kiln's advice (2026-10-01): ONE Kiln
 * project per interface family, every variant a separately named object in it, later families fitted against
 * the earlier project; sockets are named and constrained by the game and placed by Kiln. Shuriken's side:
 *
 * - a family record per Kiln project (.shuriken/kiln/families/<Family>.json): its members, sockets, what
 *   it is fitted against, and what was read back from the last build;
 * - each member exported from Kiln's baked scene as its own model (memberPrepare isolates it in a copy);
 * - sizes and sockets read back into each model's own space, so the game's spec and a generated module
 *   carry Kiln's numbers and code and models agree.
 *
 * Kiln 0.8.2 says what the models are itself (`models` in the delivery and the manifest: each top-level
 * object with its origin, size, triangles and sockets as frames in its own space) and checks the fit
 * (`fit`, `checks`): Shuriken reads those. Kiln 0.8.1 has no such list: there the member is found by its
 * name in the scene, its pivot is the bottom centre of its box, and sockets are markers with role "socket".
 * A model that isn't part of a family but has sockets is a family of one.
 */

export const FAMILY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** A socket as read back: where it is in its model (Roblox space, studs, from the model's pivot) and which way it faces. */
export interface SocketRead {
  position: Vec3;
  /** Degrees, the order CFrame.fromOrientation takes (X, Y, Z of a Y-X-Z turn). The frame's +Z is the socket's facing (kiln-layout.ts socketFrame). */
  rotation: Vec3;
  /** Where it was read from: Kiln's own model list (0.8.2), a marker of the scene, or a rig's attach point. */
  from: 'model' | 'marker' | 'rig';
  /** The sockets it joins on other models (Kiln 0.8.2 `mates`). */
  mates?: string[];
}

export interface MemberRead {
  /** Studs, Roblox axes: [X, Y up, Z]. */
  size: Vec3;
  tris: number;
  parts: number;
  sockets: Record<string, SocketRead>;
  /** What the model's origin coincides with (Kiln 0.8.2): bottom_centre, centre, socket:<name> or elsewhere. */
  originAt?: string;
  /** How far its lowest point is above the ground, studs (negative: sunk). */
  groundGap?: number;
}

/** Kiln's check of the declared socket pairings (0.8.2 `fit`, read by kiln-manifest.ts). */
export type KilnFit = ManifestFit;

/** One requirement of the brief as Kiln checked it when the turn ended (0.8.2 `delivery.checks`). */
export interface KilnCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface FamilyRecord {
  family: string;
  projectId: string;
  members: MemberSpec[];
  /** Families (or models) of this game it is fitted against. */
  fits: string[];
  sockets: SocketSpec[];
  tris?: number;
  /** What the last build delivered, per member. */
  read?: { at: string; members: Record<string, MemberRead>; missing: string[]; fit?: KilnFit | null; checks?: KilnCheckResult[] };
}

const dir = (root: string) => join(root, '.shuriken', 'kiln', 'families');

export function readFamily(root: string, family: string): FamilyRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir(root), `${family}.json`), 'utf8')) as FamilyRecord;
  } catch {
    return null;
  }
}

export function writeFamily(root: string, rec: FamilyRecord): void {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(join(dir(root), `${rec.family}.json`), JSON.stringify(rec, null, 2));
}

export function listFamilies(root: string): FamilyRecord[] {
  if (!existsSync(dir(root))) return [];
  return readdirSync(dir(root))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => readFamily(root, f.slice(0, -5)))
    .filter((r): r is FamilyRecord => !!r && typeof r.family === 'string' && Array.isArray(r.members))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** The family a Kiln project holds, if it is one. */
export const familyOfProject = (root: string, projectId: string): FamilyRecord | null => listFamilies(root).find((f) => f.projectId === projectId) ?? null;

/** The family a model belongs to (as a member, or the family's own name). */
export const familyOfModel = (root: string, model: string): FamilyRecord | null => listFamilies(root).find((f) => f.family === model || f.members.some((m) => m.name === model)) ?? null;

// ---- The game's style ------------------------------------------------------------------------------------------------------

/** A game's style sheet as Kiln 0.8.2 keeps it (GET /api/v1/styles/:id): a copy lives in the project for agents and the UI designer. */
export interface StyleSheet {
  id: string;
  title?: string;
  palette?: string[];
  materials?: Array<{ name: string; color?: string; roughness?: number; metallic?: number; roblox_material?: string; emission?: unknown; use?: string }>;
  bevel?: unknown;
  texel_density?: unknown;
  budgets?: Record<string, unknown>;
  wear?: string;
  notes?: string;
  updatedAt?: string;
}

interface StyleFile {
  /** The look as the game's tasks state it, one paragraph. */
  text?: string;
  /** The id of the game's style sheet in Kiln. */
  id?: string;
  sheet?: StyleSheet | null;
  at?: string;
}

const styleFile = (root: string) => join(dir(root), '_style.json');

function readStyleFile(root: string): StyleFile {
  try {
    return JSON.parse(readFileSync(styleFile(root), 'utf8')) as StyleFile;
  } catch {
    return {};
  }
}

function writeStyleFile(root: string, patch: StyleFile): void {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(styleFile(root), JSON.stringify({ ...readStyleFile(root), ...patch, at: new Date().toISOString() }, null, 2));
}

/** The game's shared look as its tasks state it, one paragraph every new build carries (.shuriken/kiln/families/_style.json). */
export function readStyle(root: string): string | null {
  const s = readStyleFile(root).text;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

export function writeStyle(root: string, text: string): void {
  writeStyleFile(root, { text: text.trim() });
}

/** The id of this game's style sheet in Kiln (0.8.2): one per project, the same on every brief ("shuriken-scrapyard-titans-3fa91c"). */
export function styleId(root: string): string {
  const have = readStyleFile(root).id;
  if (typeof have === 'string' && have) return have;
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
  const id = `shuriken-${slug}-${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 6)}`;
  writeStyleFile(root, { id });
  return id;
}

/** The project's copy of the game's style sheet (null until a build's copilot has saved one in Kiln). */
export const readStyleSheet = (root: string): StyleSheet | null => readStyleFile(root).sheet ?? null;

/** Keeps a copy of Kiln's sheet; returns whether it changed. */
export function writeStyleSheet(root: string, sheet: StyleSheet): boolean {
  const before = JSON.stringify(readStyleFile(root).sheet ?? null);
  if (before === JSON.stringify(sheet)) return false;
  writeStyleFile(root, { sheet });
  return true;
}

// ---- Which member an object or a marker belongs to -----------------------------------------------------------------------

const SEPARATORS = '._- /:';

/** The member a name belongs to ("Torso_Light", "Torso_Light.LegSocket", "Torso_Light_Plate"): the longest member name it starts with. */
export function memberOf(name: string, members: string[]): string | null {
  let best: string | null = null;
  for (const m of members) {
    if (name !== m && !(name.startsWith(m) && SEPARATORS.includes(name[m.length]!))) continue;
    if (!best || m.length > best.length) best = m;
  }
  return best;
}

/** Blender's ".001" on a duplicated name. */
const undup = (name: string) => name.replace(/\.\d{3}$/, '');

/**
 * Python for Shuriken's own Blender on a COPY of Kiln's baked scene: keeps only `member`'s objects, moves
 * them so the member's pivot is the origin, and prints "KILN_MEMBER {json}": found, origin (scene units,
 * Blender axes), box, the objects kept, and every marker of the scene with the member it hangs on.
 *
 * With `exact` (Kiln 0.8.2 names each model's meshes and origin itself) those objects are kept and that
 * origin is the pivot. Without it (0.8.1) the member is a top-level object of that name with everything
 * under it, a collection of that name, or objects named "<member>…", and its pivot is the bottom centre
 * of its box. A rigged scene or a member that isn't there raises, so nothing is exported under the wrong name.
 */
export function memberPrepare(member: string, members: string[], exact?: { objects: string[]; origin: Vec3 }): string {
  return `import bpy, json
from mathutils import Matrix, Vector
_want = ${JSON.stringify(member)}
_names = ${JSON.stringify(members)}
_exact = ${exact ? JSON.stringify(exact.objects) : 'None'}
_exact_origin = ${exact ? JSON.stringify(exact.origin) : 'None'}
_sc = bpy.context.scene
_SEP = ${JSON.stringify(SEPARATORS)}
def _owner(text):
    best = None
    for n in _names:
        if text == n or (text.startswith(n) and text[len(n)] in _SEP):
            if best is None or len(n) > len(best):
                best = n
    return best
_by_coll = {}
for _c in bpy.data.collections:
    _m = _owner(_c.name)
    if _m:
        for _o in _c.all_objects:
            _by_coll.setdefault(_o.name, _m)
def _member(o):
    chain = []
    p = o
    while p is not None:
        chain.append(p.name)
        p = p.parent
    for name in reversed(chain):
        m = _owner(name)
        if m:
            return m
    return _by_coll.get(o.name)
_MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
_kept, _markers = [], []
for _o in list(_sc.objects):
    _m = _member(_o)
    if _o.type == "EMPTY" and (_o.get("kiln_role") or _o.get("kiln_attach")):
        _markers.append({"name": _o.name, "role": str(_o.get("kiln_role") or "attach"), "member": _m, "matrix": [[round(v, 5) for v in r] for r in _o.matrix_world]})
    if (_exact is not None and _o.name in _exact) or (_exact is None and _m == _want):
        _kept.append(_o)
_mesh = [o for o in _kept if o.type in _MESHLIKE and o.visible_get() and not o.name.startswith("_")]
if any(o.type == "ARMATURE" for o in _sc.objects):
    print("KILN_MEMBER " + json.dumps({"found": False, "rigged": True}))
    raise ValueError("KILN_MEMBER_RIGGED: this scene has a rig; a rigged model is its own Kiln project")
if not _mesh:
    print("KILN_MEMBER " + json.dumps({"found": False, "top": sorted(o.name for o in _sc.objects if o.parent is None)[:40]}))
    raise ValueError("KILN_MEMBER_MISSING: no object named " + _want + " in the scene")
_lo = Vector((1e18, 1e18, 1e18))
_hi = Vector((-1e18, -1e18, -1e18))
for _o in _mesh:
    for _corner in _o.bound_box:
        _w = _o.matrix_world @ Vector(_corner)
        _lo = Vector((min(_lo.x, _w.x), min(_lo.y, _w.y), min(_lo.z, _w.z)))
        _hi = Vector((max(_hi.x, _w.x), max(_hi.y, _w.y), max(_hi.z, _w.z)))
_origin = Vector(_exact_origin) if _exact_origin is not None else Vector(((_lo.x + _hi.x) / 2, (_lo.y + _hi.y) / 2, _lo.z))
_keep = set(_kept)
for _o in _kept:
    if _o.parent is not None and _o.parent not in _keep:
        _mw = _o.matrix_world.copy()
        _o.parent = None
        _o.matrix_world = _mw
for _o in list(_sc.objects):
    if _o not in _keep:
        bpy.data.objects.remove(_o, do_unlink=True)
bpy.context.view_layer.update()
for _o in _kept:
    if _o.parent is None:
        _o.matrix_world = Matrix.Translation(-_origin) @ _o.matrix_world
bpy.context.view_layer.update()
print("KILN_MEMBER " + json.dumps({"found": True, "origin": list(_origin), "lo": list(_lo), "hi": list(_hi), "objects": sorted(o.name for o in _mesh), "markers": _markers}))
`;
}

/** What memberPrepare printed. */
export interface PreparedMember {
  found: boolean;
  rigged?: boolean;
  /** Top-level objects of the scene, when the member wasn't found. */
  top?: string[];
  origin?: Vec3;
  lo?: Vec3;
  hi?: Vec3;
  objects?: string[];
  markers?: Array<{ name: string; role: string; member: string | null; matrix: number[][] }>;
}

export function parsePrepared(output: string | null | undefined): PreparedMember | null {
  const line = (output ?? '').split('\n').find((l) => l.startsWith('KILN_MEMBER '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('KILN_MEMBER '.length)) as PreparedMember;
  } catch {
    return null;
  }
}

// ---- Kiln 0.8.2: the models, their sockets and the fit, as Kiln says them -------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The brief's requirements as Kiln checked them (`delivery.checks`); entries that can't be read are left out. */
export function parseChecks(raw: unknown): KilnCheckResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => (isObj(c) && typeof c.name === 'string' ? [{ name: c.name, ok: c.ok === true, detail: typeof c.detail === 'string' ? c.detail : '' }] : []));
}

const round = (v: number, d = 3) => {
  const k = 10 ** d;
  return Math.round(v * k) / k + 0;
};

/**
 * A Kiln 0.8.2 model's sockets (the manifest's `models[].sockets`) as Roblox frames in the exported model's
 * space. `k`: studs per scene unit. `about`: where the export's origin is relative to the model's own (a
 * family member is exported about its origin: zero; a project exported whole keeps the scene's origin, so
 * the model's origin is added).
 */
export function modelSockets(m: ManifestModel, k = 1, about: Vec3 = [0, 0, 0]): Record<string, SocketRead> {
  const out: Record<string, SocketRead> = {};
  const shift = toRoblox(about, k);
  for (const s of m.sockets) {
    const f = socketFrame(s.matrix, k);
    out[s.name] = { position: [round(f.position[0] + shift[0]), round(f.position[1] + shift[1]), round(f.position[2] + shift[2])], rotation: [round(f.rotation[0], 2), round(f.rotation[1], 2), round(f.rotation[2], 2)], from: 'model', ...(s.mates.length ? { mates: s.mates } : {}) };
  }
  return out;
}

// ---- Kiln 0.8.1: sockets from markers --------------------------------------------------------------------------------------

export interface MarkerIn {
  name: string;
  role: string;
  matrix: Mat4;
  /** The member the scene says it hangs on (its parent or collection), when known. */
  member?: string | null;
}

export interface MemberBox {
  /** The member's pivot in the scene (scene units, Blender axes): what its export subtracted. */
  origin: Vec3;
  lo: Vec3;
  hi: Vec3;
}

/**
 * Markers of a family's scene as sockets of its members, each in its own model's space. A marker belongs
 * to the member its name starts with ("Torso_Light.LegSocket"), else the member it hangs on, else the
 * member whose box holds it (or is nearest). Its socket is the wanted socket its name ends with, else its
 * own name. Markers with another role than "socket" count only when they are named like a wanted socket.
 * `k`: studs per scene unit.
 */
export function readSockets(markers: MarkerIn[], members: Record<string, MemberBox>, wanted: string[], k = 1): Record<string, Record<string, SocketRead>> {
  const names = Object.keys(members);
  const out: Record<string, Record<string, SocketRead>> = Object.fromEntries(names.map((n) => [n, {}]));
  const want = new Map(wanted.map((w) => [w.toLowerCase(), w]));
  const seen = new Set<string>();
  for (const mk of markers) {
    const full = undup(mk.name);
    const at: Vec3 = [mk.matrix[0][3], mk.matrix[1][3], mk.matrix[2][3]];
    const named = memberOf(full, names);
    const rest = named && full.length > named.length ? full.slice(named.length + 1) : full;
    const socket = want.get(rest.toLowerCase()) ?? want.get(full.toLowerCase()) ?? (mk.role === 'socket' ? rest : null);
    if (!socket) continue;
    const owner = named ?? (mk.member && members[mk.member] ? mk.member : null) ?? nearest(at, members);
    if (!owner || seen.has(`${owner}|${socket}`)) continue;
    seen.add(`${owner}|${socket}`);
    const f = socketFrame(mk.matrix, k);
    const o = toRoblox(members[owner]!.origin, k);
    out[owner]![socket] = { position: [round(f.position[0] - o[0]), round(f.position[1] - o[1]), round(f.position[2] - o[2])], rotation: [round(f.rotation[0], 2), round(f.rotation[1], 2), round(f.rotation[2], 2)], from: 'marker' };
  }
  return out;
}

function nearest(at: Vec3, members: Record<string, MemberBox>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [name, b] of Object.entries(members)) {
    // Distance to the box (0 inside it).
    const d = Math.hypot(...[0, 1, 2].map((i) => Math.max(b.lo[i]! - at[i]!, 0, at[i]! - b.hi[i]!)));
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** How far apart one socket sits across the members that have it (studs): 0 means every member has it in the same place. */
export function socketSpread(members: Record<string, MemberRead>, socket: string): number | null {
  const pts = Object.values(members).flatMap((m) => (m.sockets[socket] ? [m.sockets[socket]!.position] : []));
  if (pts.length < 2) return null;
  let worst = 0;
  for (const a of pts) for (const b of pts) worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  return round(worst);
}

/**
 * What a build still owes the game, in plain lines for a fix brief (or an interjection while the turn
 * still runs): models that weren't built, sockets that are missing, a budget that is exceeded, and, from
 * Kiln 0.8.2, the brief's requirements Kiln itself found unmet and socket pairings that don't fit.
 */
export function familyProblems(rec: FamilyRecord): string[] {
  const out: string[] = [];
  const read = rec.read;
  if (!read) return out;
  const checked = new Set((read.checks ?? []).map((c) => c.name));
  if (read.missing.length) out.push(`Not found as its own top-level object in Kiln's scene: ${read.missing.join(', ')}.`);
  for (const [name, m] of Object.entries(read.members)) {
    const lacking = rec.sockets.map((s) => s.name).filter((s) => !m.sockets[s]);
    if (lacking.length) out.push(`${name} has no ${lacking.join(', ')} socket${lacking.length === 1 ? '' : 's'} to read back.`);
    // Kiln's own check of the budget and the size speaks for them when it made one.
    if (rec.tris && m.tris > rec.tris && !checked.has('tris')) out.push(`${name} has ${m.tris.toLocaleString('en-US')} triangles, over the budget of ${rec.tris.toLocaleString('en-US')}.`);
    const want = rec.members.find((x) => x.name === name)?.size;
    if (want && !checked.has('size') && want.some((w, i) => w > 0 && (m.size[i]! > w * 1.5 || m.size[i]! < w / 1.5))) out.push(`${name} is ${m.size.map((v) => round(v, 1)).join(' × ')} studs, far from the ${want.join(' × ')} asked for.`);
  }
  for (const c of read.checks ?? []) if (!c.ok) out.push(`Kiln's ${c.name} check failed${c.detail ? `: ${c.detail.trim().replace(/[.\s]+$/, '')}` : ''}.`);
  if (read.fit && !read.fit.ok && !(read.checks ?? []).some((c) => c.name === 'fit' && !c.ok)) {
    const bad = read.fit.pairs.filter((p) => !p.ok);
    out.push(bad.length ? `These don't fit: ${bad.map((p) => `${p.child}.${p.mate} on ${p.parent}.${p.socket}${p.problem ? ` (${p.problem})` : ''}`).join('; ')}.` : `The fit check failed${read.fit.summary ? `: ${read.fit.summary}` : ''}.`);
  }
  return out;
}

// ---- Into the game's spec and code -----------------------------------------------------------------------------------------

export const SOCKETS_SPEC_KEY = 'model-sockets';
export const SOCKETS_SPEC_TITLE = 'Model sizes and sockets (read back from Kiln)';
export const STYLE_SPEC_KEY = 'model-style';
export const STYLE_SPEC_TITLE = 'Art style sheet (from Kiln)';

const v3 = (v: Vec3) => `(${v.map((x) => round(x, 2)).join(', ')})`;

/** The spec section: every family's models with the sizes and socket positions Kiln delivered. */
export function socketsSpec(families: FamilyRecord[]): string {
  const built = families.filter((f) => f.read && Object.keys(f.read.members).length);
  if (!built.length) return '';
  const lines = [
    "Read back from Kiln's builds, not typed by anyone: code and builders take sizes and socket positions from here (or from the generated ShurikenSockets module), never from a task's text. Studs, in each model's own space from its pivot: X right, Y up, -Z front. A socket's frame points out of its joint, the same way on both parts, so two mating sockets share one frame once assembled: line them up exactly (ShurikenSockets.mate does). Rewritten whenever a model is built again.",
  ];
  for (const f of built) {
    lines.push('', `### ${f.family}${f.fits.length ? ` (fitted against ${f.fits.join(', ')})` : ''}`);
    for (const s of f.sockets) {
      const spread = socketSpread(f.read!.members, s.name);
      const mates = [...new Set(Object.values(f.read!.members).flatMap((m) => m.sockets[s.name]?.mates ?? []))];
      lines.push(`- ${s.name}: joins ${s.joins.trim().replace(/[.\s]+$/, '')}${s.where ? ` (${s.where.trim().replace(/[.\s]+$/, '')})` : ''}${mates.length ? `; mates with ${mates.join(', ')}` : ''}${spread !== null ? `; ${spread === 0 ? 'the same position on every model' : `positions differ by up to ${spread} studs between models`}` : ''}.`);
    }
    for (const [name, m] of Object.entries(f.read!.members)) {
      const sockets = Object.entries(m.sockets).map(([n, s]) => `${n} ${v3(s.position)}`);
      lines.push(`- ${name}: ${m.size.map((x) => round(x, 2)).join(' × ')} studs, ${m.tris.toLocaleString('en-US')} triangles${m.originAt ? `, pivot at its ${m.originAt.replace(/_/g, ' ')}` : ''}${sockets.length ? `; ${sockets.join(', ')}` : ''}.`);
    }
    if (f.read!.fit) lines.push(`- Fit (Kiln's check): ${f.read!.fit.ok ? 'every pairing fits' : 'NOT fitting'}${f.read!.fit.summary ? ` — ${f.read!.fit.summary.trim().replace(/[.\s]+$/, '')}` : ''}.`);
    const problems = familyProblems(f);
    if (problems.length) lines.push(`- Open: ${problems.join(' ')}`);
  }
  return lines.join('\n');
}

/** The spec section about the game's look: the palette and the materials by name, as Kiln's style sheet has them. */
export function styleSpec(sheet: StyleSheet | null, text: string | null): string {
  if (!sheet) return '';
  const lines = [`The game's style sheet, kept in Kiln as "${sheet.id}" and followed by every model Kiln builds. UI, effects and environment art take their colours and materials from it, so the game looks like one thing.`];
  if (text) lines.push('', `The look: ${text.replace(/[.\s]+$/, '')}.`);
  if (sheet.palette?.length) lines.push('', `Palette: ${sheet.palette.join(', ')}.`);
  if (sheet.materials?.length) {
    lines.push('', 'Materials:');
    for (const m of sheet.materials) lines.push(`- ${m.name}: ${[m.color, m.roblox_material ? `Roblox ${m.roblox_material}` : '', typeof m.roughness === 'number' ? `roughness ${m.roughness}` : '', m.metallic ? 'metal' : '', m.emission ? 'glows' : ''].filter(Boolean).join(', ')}${m.use ? ` — ${m.use.replace(/[.\s]+$/, '')}` : ''}.`);
  }
  if (sheet.wear) lines.push('', `Wear: ${sheet.wear.replace(/[.\s]+$/, '')}.`);
  if (sheet.notes) lines.push('', sheet.notes.trim());
  return lines.join('\n');
}

export const SOCKETS_MODULE = 'ShurikenSockets';

const luaKey = (name: string) => (/^[A-Za-z_]\w*$/.test(name) ? name : `[${JSON.stringify(name)}]`);

/**
 * The module game code requires instead of copying numbers: each model's size and its sockets as CFrames
 * in the model's own space, plus the two things code does with them (a socket's place in the world, and
 * mating one model's socket onto another's so the two frames coincide).
 */
export function socketsLuau(families: FamilyRecord[]): string {
  const lines = [
    '--!strict',
    `-- ${SOCKETS_MODULE}: sizes and sockets of the models Kiln built, read back by Shuriken. Generated: do not edit (it is rewritten when a model is rebuilt).`,
    "-- A socket is a CFrame in its model's own space, from the model's pivot. It points out of its joint, the same way on both parts, so two mating sockets",
    '-- share one frame once assembled. Sockets.mate lines them up exactly; Sockets.world gives a socket of a placed model for an Attachment or a weld.',
    'export type ModelInfo = { family: string, size: Vector3, sockets: { [string]: CFrame } }',
    '',
    'local Sockets = {}',
    '',
    'Sockets.models = {',
  ];
  for (const f of families) {
    for (const [name, m] of Object.entries(f.read?.members ?? {})) {
      lines.push(`\t${luaKey(name)} = {`, `\t\tfamily = ${JSON.stringify(f.family)},`, `\t\tsize = Vector3.new(${m.size.map((x) => round(x, 3)).join(', ')}),`, '\t\tsockets = {');
      for (const [sn, s] of Object.entries(m.sockets)) lines.push(`\t\t\t${luaKey(sn)} = CFrame.new(${s.position.join(', ')}) * CFrame.fromOrientation(math.rad(${s.rotation[0]}), math.rad(${s.rotation[1]}), math.rad(${s.rotation[2]})),`);
      lines.push('\t\t},', '\t},');
    }
  }
  lines.push(
    '} :: { [string]: ModelInfo }',
    '',
    "-- A socket's frame in a model's own space; errors when the model or the socket isn't known (a rebuild changed it).",
    'function Sockets.frame(name: string, socket: string): CFrame',
    '\tlocal info = Sockets.models[name]',
    '\tlocal frame = if info then info.sockets[socket] else nil',
    '\tif not frame then',
    '\t\terror(`ShurikenSockets: {name} has no socket {socket}`)',
    '\tend',
    '\treturn frame',
    'end',
    '',
    '-- Where a socket of a placed model is in the world (the instance is the model named `name`, placed at scale 1).',
    'function Sockets.world(instance: PVInstance, name: string, socket: string): CFrame',
    '\treturn instance:GetPivot() * Sockets.frame(name, socket)',
    'end',
    '',
    "-- Moves `child` so its socket sits exactly on the parent's: the two frames coincide.",
    'function Sockets.mate(parent: PVInstance, parentName: string, parentSocket: string, child: PVInstance, childName: string, childSocket: string)',
    '\tchild:PivotTo(Sockets.world(parent, parentName, parentSocket) * Sockets.frame(childName, childSocket):Inverse())',
    'end',
    '',
    'return Sockets',
    '',
  );
  return lines.join('\n');
}

/**
 * What was read back, into the game: the spec sections (rewritten only when they changed, keeping their
 * status) and the module next to the other generated modules in the shared code folder (roblox_sync_push
 * takes it to Studio like any code file). Returns what it wrote.
 */
export function publishSockets(project: ProjectContext, families: FamilyRecord[]): { spec: boolean; module: string | null; requirePath: string | null } {
  const section = (key: string, title: string, body: string): boolean => {
    if (!body) return false;
    const cur = project.governance.spec().find((s) => s.key === key);
    if (cur?.body === body) return false;
    project.governance.updateSpec(key, body, 'kiln', cur?.status ?? 'draft', title);
    return true;
  };
  const spec = section(SOCKETS_SPEC_KEY, SOCKETS_SPEC_TITLE, socketsSpec(families));
  section(STYLE_SPEC_KEY, STYLE_SPEC_TITLE, styleSpec(readStyleSheet(project.root), readStyle(project.root)));
  const built = families.filter((f) => Object.keys(f.read?.members ?? {}).length);
  if (!built.length) return { spec, module: null, requirePath: null };
  const anim = AnimationStore.runtimeLocation(project.extras().syncMap);
  const rel = `${anim.file.slice(0, anim.file.lastIndexOf('/'))}/${SOCKETS_MODULE}.luau`;
  const requirePath = anim.requirePath.replace(/ShurikenAnimations$/, SOCKETS_MODULE);
  const file = join(project.root, rel);
  const code = socketsLuau(built);
  let had: string | null = null;
  try {
    had = readFileSync(file, 'utf8');
  } catch {
    had = null;
  }
  if (had === code) return { spec, module: null, requirePath };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, code, 'utf8');
  return { spec, module: rel, requirePath };
}
