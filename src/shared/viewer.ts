/**
 * The Studio viewer's contract between the Luau that reads the place (`LUAU_VIEW_PARTS`), the core (the
 * `viewer.*` RPCs) and the renderer's scene: the row flags, the orientation rule for uploaded meshes, the
 * size of a SpecialMesh piece and how a failed read is told from a place that is switching modes.
 */

export type V3 = [number, number, number];

/** A part's row flags (the `flags` field of a `viewer.parts` row; a sum of these). */
export const PART_FLAG = {
  /** Shuriken's builder turned this mesh back (the `ShurikenTurned` attribute): it came from a legacy upload. */
  turned: 1,
  /** It shows an image in Studio: a SurfaceAppearance, a MeshPart TextureID or a SpecialMesh texture. */
  colorMap: 2,
  /** A Part drawn through a SpecialMesh whose MeshType is FileMesh (its mesh, not the Part, sets the look). */
  fileMesh: 4,
  /** A temporary mesh (an EditableMesh Shuriken built from mesh.json, the `ShurikenTemporaryMesh` attribute). */
  temporary: 8,
} as const;

export const hasFlag = (flags: number, flag: number): boolean => (flags & flag) !== 0;

/** Anything wider than this is backdrop, not the map: a stand-in that wide is drawn as a faint wire box. */
export const VIEWER_HUGE = 900;

/** Roblox's importer fits an uploaded mesh inside this many studs per axis. */
export const MESH_CAP = 2048;

/**
 * Whether the viewer must turn a modeled mesh's own geometry half a turn about Y (about its centre) before
 * placing it at the part's CFrame.
 *
 * Roblox's glTF importer turns every mesh 180° about Y. Meshes uploaded before Shuriken compensated for that
 * (their model record has no `facing` marker, `legacy` here) arrive in Studio as turn180(GLB), and whatever
 * CFrame the part was given — the compensating half-turn of Shuriken's builders, which also mark the part
 * `ShurikenTurned`, or a HALF_TURN a hand-written builder (world/Map.luau) applies — Studio draws
 * turn180(GLB) at it. The GLB in the project is the un-turned original, so the viewer draws it turned the
 * same way: this reproduces Studio exactly instead of guessing which CFrames were compensated. A part placed
 * from a marked upload shows the original at its CFrame; a temporary EditableMesh is never turned by Roblox.
 * `ShurikenTurned` wins over the model's current record: a model uploaded again since the part was placed
 * still has the legacy mesh in Studio until it is placed again.
 */
export function meshTurned(flags: number, legacy: boolean): boolean {
  if (hasFlag(flags, PART_FLAG.temporary)) return false;
  if (hasFlag(flags, PART_FLAG.turned)) return true;
  return legacy;
}

const logRatio = (a: number, b: number) => Math.abs(Math.log(Math.max(1e-6, a) / Math.max(1e-6, b)));

/**
 * What a Part with a SpecialMesh FileMesh draws: the mesh's own size times SpecialMesh.Scale (the Part's
 * Size does not matter). The mesh's own size is the model's size, except that Roblox fits a mesh
 * bigger than 2048 studs back into the cap, so a model over it has two readings: its size or the fitted one.
 * The usual workaround for the cap (a Scale that restores the size the model was authored at) lands on the
 * model's own size under either reading, so the reading closer to it wins; a Scale somebody chose for another
 * reason is kept as it is.
 */
export function specialMeshDrawSize(modelSize: V3, scale: V3): V3 {
  const raw = modelSize.map((v, i) => v * scale[i]!) as V3;
  const big = Math.max(...modelSize);
  if (!(big > MESH_CAP)) return raw;
  const f = MESH_CAP / big;
  const fitted = modelSize.map((v, i) => v * f * scale[i]!) as V3;
  const off = (s: V3) => s.reduce((acc, v, i) => acc + logRatio(v, modelSize[i]!), 0);
  return off(fitted) < off(raw) ? fitted : raw;
}

/**
 * A read of the place that failed because Studio is switching between Edit and Play (the server
 * datamodel appears and disappears, the target is rebuilt): worth retrying quietly, not worth an error.
 */
export function isStudioModeFlip(message: string): boolean {
  return /not available in (?:edit|play|run|client|server)|datamodel is not available|not reachable|switching (?:mode|to)|changed mode/i.test(message);
}

/** What the core sends for one modeled mesh (`viewer.model`). */
export interface ViewerModel {
  /** A GLB (data URL) with the mesh's geometry only: positions, normals, UVs, indices. */
  glb: string;
  /** The colour map, at most 256 px (PNG data URL), when the model has one. */
  texture: string | null;
  /** Whether the colour map has transparent texels (leaf cards, fences): drawn as cut-outs. */
  textureAlpha: boolean;
  /** Its upload predates the importer-turn compensation (see meshTurned). */
  legacy: boolean;
  /** The model's size in studs (the mesh export's size). */
  size: V3;
  triangles: number;
}
