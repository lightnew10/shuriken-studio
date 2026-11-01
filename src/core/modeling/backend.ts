/**
 * The seam between the agents' 3D modeling and the engine that does it.
 *
 * Today's engine is headless Blender driven by Shuriken's port of Kiln's bridge (core/blender/:
 * BlenderModeling, one Blender per model). The tools (capabilities/blender-tools.ts), the Models page
 * (models.* RPCs) and the core only use this contract, so another engine — for instance the user's
 * Kiln app itself, once it is the better one to build with — can replace BlenderModeling in core.ts
 * without touching them. A backend's job: a workspace per model (owned by one run at a time), running
 * the agents' Blender Python, and after every change saving an undoable version and exporting the model
 * as Roblox MeshParts (one per material) into the project's ModelStore (models/<Part>.glb/.mesh.json/
 * .model.json with look and assembly origins), which is what the rest of Shuriken reads.
 */

/** What the scene looked like after a change. */

export interface SceneSummary {
  objects: number;
  tris: number;
  verts: number;
  list: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown>>;
  bounds?: { min: number[]; max: number[]; size: number[] };
  truncated?: boolean;
}

/** The automatic check after a change: flickering coincident surfaces, floating parts, parts under the floor. */
export interface SceneIssues {
  zfight: Array<{ a: string; b: string; faces: number; where: number[] }>;
  zfight_pairs: number;
  floating: Array<{ object: string; gap_below: number }>;
  below_ground: Array<{ object: string; lowest_z: number }>;
  moved?: Array<{ object: string; by_studs: number }>;
  faces_checked?: number;
}

/** One Roblox MeshPart the model exported to (one per material). */
export interface ExportedPart {
  name: string;
  blender_material: string | null;
  color: string;
  material: string;
  transparency: number;
  origin: [number, number, number];
  size: [number, number, number];
  triangles: number;
  vertices: number;
  /** A rigged model's parts: the segment (joint) it moves with (see @shared/rig). */
  segment?: string;
  /** A part the game's code finds by name (the object's custom property kiln_part): kept as its own MeshPart, never merged by material. */
  own?: string;
  /** A textured material's maps (PNG files in models/, shared by the parts made of it); the mesh has UVs. */
  textures?: TextureMaps;
  /** One piece [n, of] of a material too big for one MeshPart: a tile of the grid it was cut into and/or a slab (cut along its longest side). */
  piece?: [number, number];
  /** The grid cell [x, y, z] (Roblox axes) of a material wider than a part can be (2,048 studs): it is cut into tiles of at most 2,000. */
  tile?: [number, number, number];
  /** A textured material that glows: SurfaceAppearance EmissiveStrength and EmissiveTint (the mask is the emissive map). */
  emission?: Emission;
  /** Open (a sheet), paper-thin, or flat and facing down: it needs MeshPart.DoubleSided or it vanishes seen from behind. */
  doubleSided?: boolean;
  /** The flat objects of this part whose faces point down (invisible from above). */
  facesDown?: string[];
  /**
   * Objects that share a mesh (linked duplicates, collection instances; at least 4 uses) are exported as ONE part, in the mesh's own
   * frame, plus where each use sits: the part uploads once and the generated Luau clones the MeshPart per use (set CFrame and Size).
   * `origin` is the first use's position.
   */
  instances?: ModelInstance[];
  /** What the part is for (kiln_role, or guessed from names): drivable, ground, barrier, decor or collider; its collision follows it. */
  role?: 'drivable' | 'ground' | 'barrier' | 'decor' | 'collider';
  roleInferred?: boolean;
  /** A collider stands in for it: it doesn't collide. */
  replaced?: boolean;
  /** Its mesh is exactly an axis-aligned box. */
  box?: boolean;
  /** The share of its box a closed mesh fills (0-1). */
  fill?: number;
}

/**
 * One use of an instanced part's mesh: where its box centre goes in the model (Roblox space, studs), how it is turned
 * (degrees, the order CFrame.fromOrientation / ToOrientation use: Y, X, Z) and its scale per axis of the mesh (the part's Size
 * relative to the mesh's own size; always positive: a mirrored use got a mirrored mesh of its own).
 */
export interface ModelInstance {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface Emission {
  strength: number;
  /** '#rrggbb' */
  tint: string;
}

/** SurfaceAppearance-style maps: colour (sRGB), normal (OpenGL, +Y), roughness and metalness (gray). */
export interface TextureMaps {
  color?: string;
  normal?: string;
  roughness?: string;
  metalness?: string;
  /** Where it glows (gray: brightness of the emission image, or all white for one glowing colour). */
  emissive?: string;
}

export interface ExecResult {
  ok: boolean;
  error: string | null;
  output: string;
  added: string[];
  removed: string[];
  summary: SceneSummary | null;
  issues: SceneIssues | null;
  changed: boolean;
  version: number;
  parts: ExportedPart[];
  size: [number, number, number] | null;
  ms: number;
  /**
   * What this change's export to Roblox leaves out or approximates (a clear coat folded into the roughness
   * map, a Sheen or Subsurface Roblox can't show, a Bump without a normal map…): each note is listed when it
   * first appears, not on every change.
   */
  notes?: string[];
}

/** A modeling workspace as the UI lists it. */
export interface WorkspaceInfo {
  project: string;
  name: string;
  by: string | null;
  state: 'starting' | 'working' | 'idle' | 'closed';
  step: string | null;
  version: number;
  tris: number;
  parts: number;
  lastUsed: string;
  /** The Kiln project it is being built in, when Kiln builds it (Watch in Kiln). */
  kilnProject?: string | null;
}

/** A reply of the engine for inspection calls (scene listings, checks): ok/error plus its data. */
export interface ModelingReply {
  ok: boolean;
  error?: string | null;
  [key: string]: unknown;
}

/** One model being worked on. */
export interface ModelingWorkspace {
  readonly name: string;
  /** Who works on it (the role shown on the Models page). */
  readonly by: string | null;
  /** The saved version the model is at. */
  readonly version: number;
  /** The Roblox MeshParts its last export produced. */
  readonly parts: ExportedPart[];
  /** Run the agent's Python against the model; a change is saved, versioned, checked and exported. */
  exec(code: string, timeoutMs: number, step?: string): Promise<ExecResult>;
  /** Export to Roblox again (parts, rig, clips) even when the scene looks unchanged. */
  republish?(): Promise<void>;
  /** Objects, materials, triangle counts (up to `limit` objects). */
  scene(limit?: number): Promise<ModelingReply>;
  /** Pictures of the model (a contact sheet of views) saved into the project's evidence folder. */
  render(opts: { views?: string[]; quality?: string; size?: number; focus?: string[]; frames?: number[]; player?: boolean }): Promise<{ ok: boolean; error?: string; file?: string; views?: string[] }>;
  /** The full clash / floating / under-the-floor check; with fix, clashing parts are nudged apart. */
  check(fix: boolean): Promise<ModelingReply>;
  /** Back to the previous version (false when there is none). */
  undo(): Promise<boolean>;
}

/** The modeling engine: workspaces per model, their owners, and the engine's own health. */
export interface ModelingBackend {
  /** Whether modeling can run, and a line about it for the agents and the UI. */
  status(): { ready: boolean; exe: string | null; version: string | null; max: number; running: number; detail: string };
  /** The model's workspace for this caller (throws when another run owns it or the engine is missing). */
  workspace(root: string, name: string, who: { runId: string | null; role: string | null }): ModelingWorkspace;
  /** Workspaces (of one project) as the Models page lists them. */
  list(root?: string): WorkspaceInfo[];
  /** A run ended: its models are free for others. */
  releaseRun(runId: string): void;
  /**
   * A project the user made in Kiln becomes this Shuriken project's model `name` (its Roblox parts),
   * where the engine can reach Kiln (Kiln's "Use in this game").
   */
  importFromKiln?(root: string, kilnProjectId: string, name: string): Promise<{ ok: boolean; error?: string; name?: string; parts?: number; clips?: import('../animation/kiln-clips').ClipImport }>;
  /**
   * Shuriken's Roblox export of a finished .blend file that is not a model of this engine's own (Kiln's
   * baked roblox.blend): run on a copy in a Blender of its own, so it models nothing and touches no
   * workspace. Writes the parts, rig and clips into `dir` (a project's models/) and returns the export's reply.
   */
  exportBaked?(blend: string, dir: string, name: string, prepare?: string): Promise<{ ok: boolean; error?: string | null; [key: string]: unknown }>;
  /** Close every engine process (app shutdown). */
  stop(): void;
}
