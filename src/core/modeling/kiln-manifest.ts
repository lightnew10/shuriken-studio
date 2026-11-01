import { dirname, isAbsolute, join } from 'node:path';

/**
 * Kiln's Roblox manifest (`roblox.json`, written next to `roblox.blend` by `POST /projects/:id/roblox`) as a typed
 * structure. Version 2 (Kiln 0.8) describes a MAP: a layout project with its own geometry (ground, road, one-off
 * buildings) plus pieces built in their own projects, each placed many times, and the points and lines the game's code
 * needs. Kiln's docs/INTEGRATION.md ("Roblox target", "Maps") is the contract.
 *
 * Everything is in scene units and Blender axes (Z up, models face -Y); lengths times `studsPerUnit` are studs. A
 * matrix is 4x4 row-major: world = matrix @ (x, y, z, 1).
 *
 * Reading degrades: an older manifest (version 1 has none of the map fields), a missing field or a malformed entry
 * becomes a note and a default, never an exception, so a map with one bad marker still imports.
 */

export type Mat4 = [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]];
export type Vec3 = [number, number, number];

export interface ManifestMaterial {
  name: string;
  /** Untextured: the part is coloured with `color` (and uses `robloxMaterial` when set); it has no maps. */
  plain: boolean;
  /** "#rrggbb" of a plain material. */
  color: string | null;
  /** One of Roblox's own materials (an Enum.Material name) the material is left to: always plain. */
  robloxMaterial: string | null;
  /** Atlas size in pixels (0 for a plain material). */
  size: number;
  /** PNG files: color, normal, roughness, metalness, emissive (absolute paths). */
  maps: Record<string, string>;
  roughness: number | null;
  metallic: number | null;
  emissiveStrength: number;
  emissiveTint: string | null;
  transparency: number;
  tris: number;
  objects: number;
}

export interface ManifestPiece {
  /** The piece's own Kiln project (its folder name). */
  project: string;
  /** That project's version and fingerprint when the layout brought it in. */
  version: number;
  fingerprint: string;
  tris: number;
  placements: number;
  /** The piece's project has changed since the layout brought it in. */
  stale: boolean;
}

export interface ManifestPlacement {
  name: string;
  piece: string;
  project: string;
  matrix: Mat4;
  role?: string;
}

export interface ManifestMarker {
  name: string;
  /** spawn, start_grid, checkpoint, camera, or any word the game uses. */
  role: string;
  /** Its +Y is its facing. */
  matrix: Mat4;
}

export interface ManifestPath {
  name: string;
  role: string;
  points: Vec3[];
  width: number | null;
  closed: boolean;
}

/** A named attachment frame on a model (kiln.socket, Kiln 0.8.2), in the model's own space: relative to its origin, Blender axes, scene units. */
export interface ManifestSocket {
  name: string;
  /** The socket names it joins on other models. Mating sockets share one world frame once assembled. */
  mates: string[];
  position: Vec3;
  /** The socket's +Y: from the carrying part toward the carried part. */
  facing: Vec3;
  matrix: Mat4;
}

/** One model of a project (Kiln 0.8.2): a top-level object with everything under it; variants and kit parts are separate models. */
export interface ManifestModel {
  name: string;
  /** Its meshes in roblox.blend. */
  objects: string[];
  /** The root object's world position (scene units, Blender axes): the model is exported about it. */
  origin: Vec3;
  /** What the origin coincides with: "bottom_centre", "centre", "socket:<name>" or "elsewhere". */
  originAt: string;
  min: Vec3 | null;
  max: Vec3 | null;
  size: Vec3 | null;
  /** How far its lowest point is above z = 0 (negative: sunk into the ground). */
  groundGap: number | null;
  tris: number;
  materials: Array<{ name: string; color: string | null; robloxMaterial: string | null }>;
  sockets: ManifestSocket[];
  rigged: boolean;
}

/** Kiln's fit check between mating sockets (0.8.2): every declared pairing, the child's socket placed on the parent's. */
export interface ManifestFit {
  ok: boolean;
  summary: string;
  pairs: Array<{ parent: string; socket: string; child: string; mate: string; ok: boolean; gap: number | null; buried: number | null; problem: string | null }>;
  /** Sockets that name a mate no model in the scene has ("Model.Socket"). */
  unpaired: string[];
}

export interface KilnManifest {
  version: number;
  plain: boolean;
  /** The baked scene (absolute). */
  blend: string;
  units: string;
  studsPerUnit: number;
  sourceVersion: number | null;
  sourceFingerprint: string | null;
  materials: ManifestMaterial[];
  /** Unique meshes: the objects under one entry share that mesh in the .blend (upload once, clone). */
  meshes: Record<string, { objects: string[]; tris: number }>;
  roles: Record<string, string>;
  colliders: Array<{ name: string; standsFor: string | null }>;
  pieces: Record<string, ManifestPiece>;
  placements: ManifestPlacement[];
  mirroredPlacements: string[];
  markers: ManifestMarker[];
  paths: ManifestPath[];
  /** The project's models with their sockets (Kiln 0.8.2; empty from an older Kiln). */
  models: ManifestModel[];
  /** The fit check between mating sockets (Kiln 0.8.2; null from an older Kiln, or when none was made). */
  fit: ManifestFit | null;
  objects: number;
  tris: number;
}

/** Kiln's own Roblox check (`GET /projects/:id/roblox` → `check`). */
export interface KilnCheck {
  problems: string[];
  notes: string[];
  summary: string;
  meshes: number | null;
  layout: { pieces: number; placements: number; markers: number; paths: number; roles: number; colliders: number } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
/**
 * A material's colour as "#rrggbb": Kiln writes the hex string; an [r, g, b] list is read too (0-255 numbers, or
 * 0-1 when none is above 1; sRGB either way), as Kiln 0.8.7's plain materials were first described.
 */
export function colorOf(v: unknown): string | null {
  if (typeof v === 'string') return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  if (!Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return null;
  const rgb = v.slice(0, 3) as number[];
  const scale = rgb.every((x) => x <= 1) ? 255 : 1;
  return `#${rgb.map((x) => Math.round(Math.min(255, x * scale)).toString(16).padStart(2, '0')).join('')}`;
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A 4x4 row-major matrix of finite numbers (3 rows are enough: the last is 0 0 0 1), or null. */
export function parseMat4(v: unknown): Mat4 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const rows: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const row = v[r] as unknown;
    if (!Array.isArray(row) || row.length < 4) return null;
    const out = row.slice(0, 4).map(num);
    if (out.some((x) => x === null)) return null;
    rows.push(out as number[]);
  }
  return [...rows, [0, 0, 0, 1]] as Mat4;
}

function parseVec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out = v.slice(0, 3).map(num);
  return out.some((x) => x === null) ? null : (out as Vec3);
}

/**
 * The manifest as Shuriken uses it, plus what could not be read (`notes`). `dir` is the folder of roblox.json: a `blend`
 * or map path that is only a file name (Kiln's reference fixture) is resolved against it; a real export gives absolute paths.
 */
export function parseManifest(raw: unknown, dir?: string | null): { manifest: KilnManifest; notes: string[] } {
  const notes: string[] = [];
  const o = isObj(raw) ? raw : {};
  if (!isObj(raw)) notes.push('The manifest is not an object: read as empty.');
  const resolve = (p: string | null): string => (!p ? '' : isAbsolute(p) || !dir ? p : join(dir, p));
  const version = num(o.version) ?? 1;
  if (version < 2) notes.push(`Manifest version ${version} (before Kiln 0.8): it has no map data (pieces, placements, markers, paths, roles, colliders), so only the scene's own geometry is imported.`);
  else if (version > 2) notes.push(`Manifest version ${version} is newer than this Shuriken knows (2): the fields it knows are read, anything new is ignored.`);
  const units = str(o.units) ?? 'studs';
  let studsPerUnit = num(o.studs_per_unit);
  if (studsPerUnit === null || studsPerUnit <= 0) {
    studsPerUnit = units === 'studs' ? 1 : 1 / 0.28;
    if (version >= 2) notes.push(`studs_per_unit is missing: taken as ${Math.round(studsPerUnit * 10000) / 10000} from units "${units}".`);
  }
  const bad: Record<string, number> = {};
  const skip = (what: string) => void (bad[what] = (bad[what] ?? 0) + 1);

  const materials: ManifestMaterial[] = [];
  for (const m of Array.isArray(o.materials) ? o.materials : []) {
    if (!isObj(m) || !str(m.name)) {
      skip('material');
      continue;
    }
    const maps: Record<string, string> = {};
    if (isObj(m.maps)) for (const [k, v] of Object.entries(m.maps)) if (typeof v === 'string' && v) maps[k] = resolve(v);
    const robloxMaterial = str(m.roblox_material);
    const color = colorOf(m.color);
    materials.push({
      name: m.name as string,
      // A material left to Roblox's own material is always plain, and so is one with a colour and no maps.
      plain: m.plain === true || !!robloxMaterial || (!!color && !Object.keys(maps).length && num(m.size) === 0),
      color,
      robloxMaterial,
      size: num(m.size) ?? 0,
      maps,
      roughness: num(m.roughness),
      metallic: num(m.metallic),
      emissiveStrength: num(m.emissive_strength) ?? 0,
      emissiveTint: str(m.emissive_tint),
      transparency: Math.max(0, Math.min(1, num(m.transparency) ?? 0)),
      tris: num(m.tris) ?? 0,
      objects: num(m.objects) ?? 0,
    });
  }

  const meshes: KilnManifest['meshes'] = {};
  if (isObj(o.meshes)) for (const [k, v] of Object.entries(o.meshes)) if (isObj(v)) meshes[k] = { objects: strings(v.objects), tris: num(v.tris) ?? 0 };

  const roles: Record<string, string> = {};
  if (isObj(o.roles)) for (const [k, v] of Object.entries(o.roles)) if (typeof v === 'string' && v) roles[k] = v.toLowerCase();

  const colliders: KilnManifest['colliders'] = [];
  for (const c of Array.isArray(o.colliders) ? o.colliders : []) {
    if (!isObj(c) || !str(c.name)) skip('collider');
    else colliders.push({ name: c.name as string, standsFor: str(c.stands_for) });
  }

  const pieces: Record<string, ManifestPiece> = {};
  if (isObj(o.pieces))
    for (const [k, v] of Object.entries(o.pieces)) {
      if (!isObj(v) || !str(v.project)) {
        skip('piece');
        continue;
      }
      pieces[k] = { project: v.project as string, version: num(v.version) ?? 0, fingerprint: str(v.fingerprint) ?? '', tris: num(v.tris) ?? 0, placements: num(v.placements) ?? 0, stale: v.stale === true };
    }

  const placements: ManifestPlacement[] = [];
  for (const p of Array.isArray(o.placements) ? o.placements : []) {
    const matrix = isObj(p) ? parseMat4(p.matrix) : null;
    if (!isObj(p) || !str(p.name) || !str(p.piece) || !matrix) {
      skip('placement');
      continue;
    }
    const role = str(p.role);
    placements.push({ name: p.name as string, piece: p.piece as string, project: str(p.project) ?? pieces[p.piece as string]?.project ?? '', matrix, ...(role ? { role: role.toLowerCase() } : {}) });
  }

  const markers: ManifestMarker[] = [];
  for (const m of Array.isArray(o.markers) ? o.markers : []) {
    const matrix = isObj(m) ? parseMat4(m.matrix) : null;
    if (!isObj(m) || !str(m.name) || !matrix) skip('marker');
    else markers.push({ name: m.name as string, role: (str(m.role) ?? 'marker').toLowerCase(), matrix });
  }

  const paths: ManifestPath[] = [];
  for (const p of Array.isArray(o.paths) ? o.paths : []) {
    const points = isObj(p) && Array.isArray(p.points) ? p.points.map(parseVec3).filter((x): x is Vec3 => !!x) : [];
    if (!isObj(p) || !str(p.name) || points.length < 2) skip('path');
    else paths.push({ name: p.name as string, role: (str(p.role) ?? 'path').toLowerCase(), points, width: num(p.width), closed: p.closed === true });
  }

  const models = parseModels(o.models, skip);
  const fit = parseFit(o.fit);

  for (const [what, n] of Object.entries(bad)) notes.push(`${n} ${what}${n === 1 ? '' : 's'} in the manifest could not be read (a missing name, matrix or points) and ${n === 1 ? 'was' : 'were'} left out.`);
  const blend = resolve(str(o.blend));
  if (!blend) notes.push('The manifest names no baked file (blend).');
  return {
    manifest: {
      version,
      plain: o.plain === true,
      blend,
      units,
      studsPerUnit,
      sourceVersion: num(o.source_version),
      sourceFingerprint: str(o.source_fingerprint),
      materials,
      meshes,
      roles,
      colliders,
      pieces,
      placements,
      mirroredPlacements: strings(o.mirrored_placements),
      markers,
      paths,
      models,
      fit,
      objects: num(o.objects) ?? 0,
      tris: num(o.tris) ?? 0,
    },
    notes,
  };
}

/**
 * Kiln 0.8.2's `models` (also a turn's `delivery.models` and `GET /projects/:id/parts`): the models of a project with
 * their sockets. Anything that isn't a list reads as none; an entry without a name, or a socket without a name or a
 * matrix, is left out (`skip` counts them).
 */
export function parseModels(raw: unknown, skip: (what: string) => void = () => undefined): ManifestModel[] {
  const out: ManifestModel[] = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!isObj(m) || !str(m.name)) {
      skip('model');
      continue;
    }
    const sockets: ManifestSocket[] = [];
    for (const s of Array.isArray(m.sockets) ? m.sockets : []) {
      const matrix = isObj(s) ? parseMat4(s.matrix) : null;
      if (!isObj(s) || !str(s.name) || !matrix) {
        skip('socket');
        continue;
      }
      // Position and facing are in the matrix too (its translation, its +Y): an entry that leaves them out still reads.
      const y = Math.hypot(matrix[0][1], matrix[1][1], matrix[2][1]) || 1;
      sockets.push({
        name: s.name as string,
        mates: typeof s.mates === 'string' ? [s.mates] : strings(s.mates),
        position: parseVec3(s.position) ?? [matrix[0][3], matrix[1][3], matrix[2][3]],
        facing: parseVec3(s.facing) ?? [matrix[0][1] / y, matrix[1][1] / y, matrix[2][1] / y],
        matrix,
      });
    }
    const materials: ManifestModel['materials'] = [];
    for (const x of Array.isArray(m.materials) ? m.materials : []) if (isObj(x) && str(x.name)) materials.push({ name: x.name as string, color: str(x.color), robloxMaterial: str(x.roblox_material) });
    out.push({
      name: m.name as string,
      objects: strings(m.objects),
      origin: parseVec3(m.origin) ?? [0, 0, 0],
      originAt: str(m.origin_at) ?? 'elsewhere',
      min: parseVec3(m.min),
      max: parseVec3(m.max),
      size: parseVec3(m.size),
      groundGap: num(m.ground_gap),
      tris: num(m.tris) ?? 0,
      materials,
      sockets,
      rigged: m.rigged === true,
    });
  }
  return out;
}

/** Kiln 0.8.2's `fit`, or null when there is none. */
export function parseFit(raw: unknown): ManifestFit | null {
  if (!isObj(raw)) return null;
  const pairs: ManifestFit['pairs'] = [];
  for (const p of Array.isArray(raw.pairs) ? raw.pairs : []) {
    if (!isObj(p)) continue;
    pairs.push({ parent: str(p.parent) ?? '', socket: str(p.socket) ?? '', child: str(p.child) ?? '', mate: str(p.mate) ?? '', ok: p.ok === true, gap: num(p.gap), buried: num(p.buried), problem: str(p.problem) });
  }
  return { ok: raw.ok !== false && pairs.every((p) => p.ok), summary: str(raw.summary) ?? '', pairs, unpaired: strings(raw.unpaired) };
}

/** The folder a manifest file lives in (for parseManifest's `dir`). */
export const manifestDir = (file: string): string => dirname(file);

/** Kiln's check, whatever its age: missing lists are empty. */
export function parseCheck(raw: unknown): KilnCheck {
  const o = isObj(raw) ? raw : {};
  const l = isObj(o.layout) ? o.layout : null;
  const count = (v: unknown): number => (isObj(v) ? Object.keys(v).length : (num(v) ?? 0));
  return {
    problems: strings(o.problems),
    notes: strings(o.notes),
    summary: str(o.summary) ?? '',
    meshes: num(o.meshes),
    layout: l ? { pieces: count(l.pieces), placements: count(l.placements), markers: count(l.markers), paths: count(l.paths), roles: count(l.roles), colliders: count(l.colliders) } : null,
  };
}

/**
 * Kiln's check problems sorted by what they mean for an import. `blocking`: the map would come in wrong (a mirrored
 * placement can't be made in Roblox). `handled`: Shuriken's exporter deals with it (a part over 2,048 studs is cut into
 * tiles, a mesh over the triangle limit into slabs). `look`: the map imports, but will not look in Roblox as it does in
 * Kiln (metalness between 0 and 1, see-through textured materials, very glossy surfaces…): Kiln's copilot should fix those.
 */
export function sortProblems(problems: string[]): { blocking: string[]; handled: string[]; look: string[] } {
  const out = { blocking: [] as string[], handled: [] as string[], look: [] as string[] };
  for (const p of problems) {
    if (/^Mirrored placements?\b/i.test(p)) out.blocking.push(p);
    else if (/^Too big for one Roblox part\b|^Too many triangles for one Roblox part\b/i.test(p)) out.handled.push(p);
    else out.look.push(p);
  }
  return out;
}
