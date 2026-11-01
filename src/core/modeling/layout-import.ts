import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BlenderBridge } from '../blender/bridge';
import type { EventBus } from '../events';
import type { ExportedPart } from './backend';
import { KilnHttpError, modelNameFrom } from './kiln-modeling';
import { LAYOUT_CELL, batchUnits, planLayout, type LayoutPart, type LayoutPlan, type PlanTemplate, type PlanUnit } from './kiln-layout';
import { MAP_KIT, MARKER_TAG, kitLuau, kitTemporaryLuau, mapDataModule, mapModuleName, markersLuau, sweepLuau, unitChars, unitsLuau } from './kiln-layout-luau';
import { parseCheck, parseManifest, sortProblems, type KilnCheck, type KilnManifest, type Vec3 } from './kiln-manifest';
import { ModelStore, type ModelMeta } from './model-store';
import type { PartUpload, UploadProgress } from './model-uploads';
import { recordParts } from './publish';

/**
 * Brings a whole Kiln map into the game (docs/ARCHITECTURE.md, "Kiln maps"): the layout project's own geometry and
 * every piece's project are exported once each (Kiln's baked roblox.blend through Shuriken's exporter), each unique
 * mesh is uploaded once, and Studio gets one template per mesh and one clone per placement, in batches.
 *
 * Every step is resumable, because a big map does not fit one tool call: exports are skipped while the Kiln project's
 * fingerprint and the parts on disk are what they were, uploads belong to their parts (model-uploads.ts), and in
 * Studio a template with the same stamp and a unit with the same fingerprint are left alone. A second call does what
 * the first did not get to and changes only what changed.
 */

/** What Kiln's API answers, as far as the import needs it. */
export interface LayoutKiln {
  get(path: string, timeoutMs?: number): Promise<unknown>;
  post(path: string, body?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface LayoutStudio {
  readonly connected: boolean;
  runLuau(code: string, datamodel?: 'Edit', timeoutMs?: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string; durationMs: number }>;
  waitForLease(): Promise<{ ok: boolean; message?: string }>;
}

export interface ExportReply {
  ok: boolean;
  error?: string | null;
  parts?: ExportedPart[];
  notes?: string[];
  [key: string]: unknown;
}

export interface LayoutImportDeps {
  kiln: LayoutKiln;
  /** Shuriken's Roblox export of a baked .blend into `dir` (a project's models/); `prepare` is Python run on the copy first. */
  exportBlend: (blend: string, dir: string, name: string, prepare: string | null) => Promise<ExportReply>;
  /** The parts' uploads (the queue model_place and rig_build share), or null where nothing can upload. */
  uploader: { ensureMany(root: string, parts: ModelMeta[], opts: { budgetMs?: number; signal?: AbortSignal; onProgress?: (p: UploadProgress) => void }): Promise<{ results: PartUpload[]; stillUploading: string[] }> } | null;
  studio: LayoutStudio;
  bus: EventBus;
  /** This project's models linked to Kiln projects: Kiln project id → model name. */
  linked: (root: string) => Record<string, string>;
  /** Where the data module goes (the synced folder that maps into ReplicatedStorage) and how game code requires it. */
  dataLocation?: (root: string, module: string) => { file: string; requirePath: string };
  /** Pushes that file into Studio; returns a word about how it went. */
  pushFile?: (root: string, file: string) => Promise<string>;
  /** How long a bake waits for Kiln's copilot to finish (409), in ms. */
  bakeWaitMs?: number;
  /** The gate every Kiln render and bake goes through (KilnModeling.gpu): too many at once can freeze the PC. */
  gpu?: { run<T>(fn: () => Promise<T>): Promise<T> };
  /** The clock the call's time budget is measured with (tests). */
  now?: () => number;
}

export interface LayoutImportOptions {
  /** The Kiln project of the layout. */
  project: string;
  /** The model (and the folder in Workspace) the map becomes; default: the model linked to the project, else its title. */
  name?: string;
  /** Import although Kiln's check lists problems with how the map will look in Roblox. */
  acceptProblems?: boolean;
  /** Only read Kiln's check and the manifest: nothing is exported, uploaded or placed. */
  checkOnly?: boolean;
  /** Place temporary meshes (not saved with the place) instead of uploading. */
  temporary?: boolean;
  /** Export again even where nothing seems to have changed. */
  refresh?: boolean;
  /** How long this call may take; what is not done by then is done by the next call. */
  budgetMs?: number;
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

/** What an import did (and did not get to): the tool returns it as it is. */
export interface LayoutImportResult {
  ok: boolean;
  /** Everything is in Studio as the manifest says. */
  done: boolean;
  error?: string;
  map?: string;
  kilnProject: string;
  /** Kiln's own check: `ready` false means nothing was imported. */
  check?: { ready: boolean; summary: string; blocking: string[]; look: string[]; handledByShuriken: string[]; notes: string[] };
  manifest?: { version: number; units: string; studsPerUnit: number; plain: boolean; meshes: number; materials: { total: number; plain: number; robloxMaterial: number; textured: number }; pieces: number; placements: number; markers: number; paths: number; roles: number; colliders: number };
  models?: { exported: string[]; unchanged: string[]; failed: Array<{ model: string; why: string }> };
  uploads?: { parts: number; uploaded: number; reused: number; stillUploading: string[]; failed: Array<{ name: string; why: string }>; needsUser?: boolean };
  studio?: {
    placed: boolean;
    why?: string;
    temporary?: boolean;
    templates?: { made: number; kept: number; failed: number };
    units?: { total: number; placed: number; kept: number; replaced: number; failed: number; waiting: number; removed: number; parts: number; calls: number };
    markers?: number;
    failures?: string[];
  };
  where?: { root: string; static: string; pieces: string; markers: string; kit: string; cellStuds: number };
  data?: { file: string; require: string; sync: string; markerTag: string; paths: Array<{ name: string; role: string; points: number; length: number }> } | null;
  notes: string[];
  next?: string;
}

interface ModelState {
  project: string;
  /** The fingerprint of the Kiln scene the parts were exported from (the manifest's source_fingerprint). */
  fingerprint: string | null;
  plain: boolean;
  studsPerUnit: number;
  /** Kiln projects whose placements were left out of this export (they are placed as clones). */
  dropped: string[];
  /** Each part's box centre in the model (a lone part's record keeps none). */
  origins: Record<string, Vec3>;
  /** A hash of the parts' names and mesh hashes as recorded: another export of the model since changes it. */
  partsFp: string;
  /**
   * The Kiln project's `updatedAt` when the parts were last known to be current: what tells "unchanged" for a project
   * Kiln's app listing leaves out (it lists the 48 most recent, with fingerprints; the storage listing has every
   * project, without).
   */
  updatedAt?: string | null;
  at: string;
}

/** What Kiln's listings say of a project: its scene's fingerprint (the app listing) and when it last changed. */
interface Seen {
  title?: string;
  fingerprint: string | null;
  updatedAt: string | null;
}

interface MapState {
  map: string;
  project: string;
  /** Piece name → model. */
  pieces: Record<string, string>;
  lastRun?: { at: string; run: string; units: number; parts: number; templates: number; done: boolean };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Temporary meshes over this many triangles can't be built (EditableMesh); the model needs its upload. */
const MAX_TEMP_TRIS = 12_000;

/**
 * Python for the copy of a baked file, before Shuriken's exporter runs on it: placements of the pieces that are
 * placed as clones are taken out (Kiln leaves them in roblox.blend as collection instances, which the exporter would
 * otherwise bake into the layout), and a scene in meters is brought to studs (the exporter's unit: 1 = 1 stud).
 */
export function prepareCode(studsPerUnit: number, dropProjects: string[]): string | null {
  const scale = Math.abs(studsPerUnit - 1) > 1e-9;
  if (!scale && !dropProjects.length) return null;
  return `import json
import bpy
from mathutils import Matrix
_drop = set(json.loads(${JSON.stringify(JSON.stringify(dropProjects))}))
_s = ${studsPerUnit}
for _o in list(bpy.context.scene.objects):
    _c = _o.instance_collection if _o.instance_type == "COLLECTION" else None
    if _c is not None and _c.get("kiln_piece") in _drop:
        bpy.data.objects.remove(_o, do_unlink=True)
if abs(_s - 1.0) > 1e-9:
    for _o in bpy.context.scene.objects:
        if _o.parent is None:
            _o.matrix_world = Matrix.Scale(_s, 4) @ _o.matrix_world
bpy.context.view_layer.update()
`;
}

/**
 * Shuriken's Roblox export of a baked .blend that is no model of the engine's own, in a Blender of its own on a copy
 * (nothing is modeled or saved): open, run `prepare`, export. What BlenderModeling.exportBaked does, plus the prepare step.
 */
export async function exportBakedBlend(exe: string | null, script: string | null, blend: string, dir: string, name: string, prepare: string | null): Promise<ExportReply> {
  if (!exe || !script) return { ok: false, error: !exe ? 'Blender was not found (set its path in Settings → Agents)' : 'the Blender bridge script is missing from this install' };
  const work = join(tmpdir(), `shuriken-layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.blend`);
  const b = new BlenderBridge(exe, script);
  try {
    copyFileSync(blend, work);
    const open = await b.call('open', { path: work }, 300_000);
    if (!open.ok) return { ok: false, error: `Blender couldn't open Kiln's baked file: ${open.error ?? 'error'}` };
    if (prepare) {
      const p = await b.call('exec', { code: prepare }, 300_000);
      if (!p.ok) return { ok: false, error: `preparing Kiln's baked file failed: ${String(p.error ?? 'error').slice(0, 400)}` };
    }
    mkdirSync(dir, { recursive: true });
    return (await b.call('roblox', { dir, name }, 900_000)) as unknown as ExportReply;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    b.stop();
    setTimeout(() => {
      try {
        rmSync(work, { force: true });
      } catch {
        /* still in use: the temp folder takes it */
      }
    }, 5_000).unref();
  }
}

/**
 * What Kiln's manifest says about the materials, on the exported parts: a plain material is its colour (no texture is
 * written or uploaded for it), and one left to Roblox's own material is that Enum.Material tinted with the colour.
 * Returns how many parts it set.
 */
export function applyManifestLook(parts: ExportedPart[], manifest: KilnManifest): number {
  const by = new Map(manifest.materials.map((m) => [m.name, m]));
  let n = 0;
  for (const p of parts) {
    const m = p.blender_material ? by.get(p.blender_material) : undefined;
    if (!m || !m.plain || p.role === 'collider') continue;
    if (m.color) p.color = m.color;
    if (m.robloxMaterial) p.material = m.robloxMaterial;
    if (m.transparency > 0) p.transparency = m.transparency;
    delete p.textures;
    delete p.emission;
    n++;
  }
  return n;
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

/**
 * .shuriken/kiln/<Model>.json links (model → Kiln project) turned round: Kiln project → model. A project several models
 * are linked to (a family: variants built side by side in one project) is left out: the whole project as a map piece is
 * none of those models, and exporting it under one of their names would replace that model's parts.
 */
export function linkedByProject(root: string): Record<string, string> {
  const dir = join(root, '.shuriken', 'kiln');
  const out: Record<string, string> = {};
  const shared = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const id = readJson<{ projectId?: string }>(join(dir, f), {}).projectId;
    if (!id) continue;
    if (out[id]) shared.add(id);
    else out[id] = f.slice(0, -5);
  }
  for (const id of shared) delete out[id];
  return out;
}

export class LayoutImporter {
  constructor(private readonly d: LayoutImportDeps) {}

  private dir(root: string): string {
    return join(root, '.shuriken', 'layouts');
  }

  /** .shuriken/layouts/models.json, read once per importer (a map of hundreds of pieces asks for it thousands of times). */
  private readonly modelStates = new Map<string, Record<string, ModelState>>();

  private models(root: string): Record<string, ModelState> {
    let all = this.modelStates.get(root);
    if (!all) this.modelStates.set(root, (all = readJson<Record<string, ModelState>>(join(this.dir(root), 'models.json'), {})));
    return all;
  }

  private saveModel(root: string, model: string, state: ModelState): void {
    const all = this.models(root);
    all[model] = state;
    mkdirSync(this.dir(root), { recursive: true });
    writeFileSync(join(this.dir(root), 'models.json'), JSON.stringify(all, null, 1));
  }

  private mapState(root: string, map: string): MapState | null {
    return readJson<MapState | null>(join(this.dir(root), `${map}.json`), null);
  }

  private saveMap(root: string, state: MapState): void {
    mkdirSync(this.dir(root), { recursive: true });
    writeFileSync(join(this.dir(root), `${state.map}.json`), JSON.stringify(state, null, 1));
  }

  /**
   * A model's parts as the store has them now (an assembly's parts, or the one part named like the model). A model this
   * importer exported is read by its parts' names (the store's own listing reads every model of the project: with
   * hundreds of pieces that is hundreds of thousands of file reads); `scan` asks the store itself.
   */
  private metas(root: string, model: string, scan = false): ModelMeta[] {
    const store = new ModelStore(root);
    const mine = (m: ModelMeta | null): m is ModelMeta => !!m && (m.assembly === model || (m.name === model && m.source === 'blender'));
    const known = scan ? undefined : this.models(root)[model];
    if (known) return Object.keys(known.origins).map((n) => store.get(n)).filter((m): m is ModelMeta => !!m);
    // The exporter names a model's parts <Model> or <Model>_<...>: only those records are opened.
    return store.names().filter((n) => n === model || n.startsWith(`${model}_`)).map((n) => store.get(n)).filter(mine);
  }

  private partsFp(root: string, model: string): string {
    const known = this.models(root)[model];
    // Every part recorded then must still be there: a missing one makes it another set of parts.
    return sha(`${known ? Object.keys(known.origins).length : ''}|${this.metas(root, model).map((m) => `${m.name}:${m.hash}`).sort().join('|')}`);
  }

  /** Kiln's baked export of a project (POST /roblox; an export of the current scene is reused by Kiln). A 409 (its copilot works) is waited out. */
  private async bake(project: string, plain: boolean, signal?: AbortSignal): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; error: string }> {
    const wait = this.d.bakeWaitMs ?? 3 * 60_000;
    const deadline = Date.now() + wait;
    for (;;) {
      try {
        const post = () => this.d.kiln.post(`/api/v1/projects/${project}/roblox`, plain ? { plain: true } : {}, 20 * 60_000);
        const r = (await (this.d.gpu ? this.d.gpu.run(post) : post())) as { ok?: boolean; error?: string; manifest?: Record<string, unknown> };
        if (!r.ok || !r.manifest) return { ok: false, error: r.error ?? 'Kiln gave no manifest' };
        return { ok: true, raw: r.manifest };
      } catch (e) {
        if (e instanceof KilnHttpError && e.status === 409 && Date.now() < deadline && !signal?.aborted) {
          await sleep(Math.min(2_500, Math.max(50, wait / 10)));
          continue;
        }
        return { ok: false, error: e instanceof KilnHttpError && e.status === 409 ? "Kiln's copilot is still working on that project: import when its turn ends" : (e as Error).message };
      }
    }
  }

  /** Shuriken's exporter on a baked manifest's file; the parts are recorded in the model store and what they came from is remembered. */
  private async exportModel(root: string, model: string, project: string, manifest: KilnManifest, drop: string[], updatedAt: string | null = null): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
    if (!manifest.blend || !existsSync(manifest.blend)) return { ok: false, error: `Kiln's baked file isn't there (${manifest.blend || 'the manifest names none'})` };
    const reply = await this.d.exportBlend(manifest.blend, join(root, 'models'), model, prepareCode(manifest.studsPerUnit, drop));
    if (!reply.ok) return { ok: false, error: String(reply.error ?? 'the export failed') };
    const parts = reply.parts ?? [];
    applyManifestLook(parts, manifest);
    // What the store has of this model now, whoever exported it last (another export path may have written other parts).
    const before = this.metas(root, model, true).map((m) => ({ name: m.name }) as ExportedPart);
    // world/Models.luau is written once, after the last export of this call (see run).
    recordParts(root, model, parts, before, this.d.bus, { deferBuilder: true });
    this.builderStale.add(root);
    const state: ModelState = { project, fingerprint: manifest.sourceFingerprint, plain: manifest.plain, studsPerUnit: manifest.studsPerUnit, dropped: [...drop].sort(), origins: Object.fromEntries(parts.map((p) => [p.name, p.origin])), partsFp: '', updatedAt, at: new Date().toISOString() };
    this.saveModel(root, model, state);
    this.saveModel(root, model, { ...state, partsFp: this.partsFp(root, model) });
    return { ok: true, notes: (reply.notes ?? []).filter((n): n is string => typeof n === 'string') };
  }

  /** Whether a model's parts on disk are still the export of this Kiln scene (so nothing needs exporting). */
  private fresh(root: string, model: string, project: string, seen: { fingerprint?: string | null; updatedAt?: string | null } | undefined, plain: boolean, drop: string[]): boolean {
    const s = this.models(root)[model];
    if (!s || !seen || s.project !== project || s.plain !== plain) return false;
    // The scene's fingerprint when Kiln gives one, else the project's last change (a superset: any change of it counts).
    if (seen.fingerprint ? s.fingerprint !== seen.fingerprint : !seen.updatedAt || s.updatedAt !== seen.updatedAt) return false;
    if (s.dropped.join('|') !== [...drop].sort().join('|')) return false;
    // The parts recorded then are the parts in the store now (another export of the model since would have changed them).
    return s.partsFp === this.partsFp(root, model);
  }

  private layoutParts(root: string, model: string): LayoutPart[] {
    const origins = this.models(root)[model]?.origins ?? {};
    return this.metas(root, model).map((m) => ({
      name: m.name,
      origin: m.origin ?? origins[m.name] ?? [0, 0, 0],
      size: m.size,
      ...(m.instances?.length ? { instances: m.instances } : {}),
      ...(m.role ? { role: m.role } : {}),
      ...(m.replaced ? { replaced: true } : {}),
      ...(m.box ? { box: true } : {}),
      ...(m.fill !== undefined ? { fill: m.fill } : {}),
      ...(m.doubleSided ? { doubleSided: true } : {}),
      ...(m.transparency ? { transparency: m.transparency } : {}),
      ...(m.color ? { color: m.color } : {}),
      ...(m.material ? { material: m.material } : {}),
      hash: m.hash,
      asset: ModelStore.assetId(m),
      legacy: ModelStore.legacyUpload(m),
    }));
  }

  /** Projects whose world/Models.luau waits to be written (models were recorded with deferBuilder). */
  private readonly builderStale = new Set<string>();

  async run(root: string, o: LayoutImportOptions): Promise<LayoutImportResult> {
    try {
      return await this.import(root, o);
    } finally {
      if (this.builderStale.delete(root)) new ModelStore(root).writeBuilder();
    }
  }

  private async import(root: string, o: LayoutImportOptions): Promise<LayoutImportResult> {
    const now = this.d.now ?? Date.now;
    const t0 = now();
    const budget = o.budgetMs ?? 230_000;
    const left = () => budget - (now() - t0);
    const say = (m: string) => {
      try {
        o.progress?.(m);
      } catch {
        // progress is a courtesy
      }
    };
    const notes: string[] = [];
    const base = { kilnProject: o.project, notes };
    const again = 'Call kiln_layout_import again with the same arguments: it goes on where this call stopped (what is exported, uploaded or placed already is left alone).';

    // 1. Kiln's projects (version and fingerprint of each saved scene; no project is opened for this).
    say('Reading the map from Kiln');
    type Listed = { id: string; title?: string; updatedAt?: string; fingerprint?: string | null };
    const app = (await this.d.kiln.get('/api/v1/app', 10_000).catch(() => null)) as { version?: string; projects?: Listed[] } | null;
    if (!app) return { ...base, ok: false, done: false, error: "Kiln isn't answering (start it from the Kiln page)." };
    const projects = new Map<string, Seen>((app.projects ?? []).map((p) => [p.id, { title: p.title, fingerprint: p.fingerprint ?? null, updatedAt: p.updatedAt ?? null }]));
    /**
     * The app listing holds Kiln's 48 most recent projects; a map of many pieces has more. The storage listing has every
     * project (no fingerprints, and it takes a few seconds: it measures folders), so it is read only when one is missing.
     * `all`: every project Kiln has is in `projects` now, so one that is not there is gone.
     */
    let all = false;
    const storage = async (): Promise<Map<string, Seen> | null> => {
      const s = (await this.d.kiln.get('/api/v1/storage', 60_000).catch(() => null)) as { projects?: Listed[] } | null;
      return Array.isArray(s?.projects) ? new Map(s.projects.map((p) => [p.id, { title: p.title, fingerprint: null, updatedAt: p.updatedAt ?? null }])) : null;
    };
    const lookUp = async (ids: string[]): Promise<void> => {
      if (all || ids.every((id) => projects.has(id))) return;
      const listed = await storage();
      if (!listed) return;
      for (const [id, s] of listed) if (!projects.has(id)) projects.set(id, s);
      all = true;
    };
    await lookUp([o.project]);
    const linked = this.d.linked(root);
    const map = o.name ?? linked[o.project] ?? modelNameFrom(projects.get(o.project)?.title ?? o.project);

    // 2. Kiln's own check and its last export of the layout.
    let got: { check?: unknown; export?: unknown; current?: boolean };
    try {
      got = (await this.d.kiln.get(`/api/v1/projects/${o.project}/roblox`, 180_000)) as typeof got;
    } catch (e) {
      return { ...base, ok: false, done: false, map, error: `Kiln doesn't have that project, or couldn't check it (${(e as Error).message}).` };
    }
    const check: KilnCheck = parseCheck(got.check);
    const sorted = sortProblems(check.problems);
    const ready = !sorted.blocking.length && (!sorted.look.length || !!o.acceptProblems);
    const checkOut = { ready, summary: check.summary, blocking: sorted.blocking, look: sorted.look, handledByShuriken: sorted.handled, notes: check.notes.slice(0, 40) };
    if (!ready && !o.checkOnly) {
      return {
        ...base,
        ok: true,
        done: false,
        map,
        check: checkOut,
        next: sorted.blocking.length
          ? "Kiln says the map is not ready, and nothing was imported: a mirrored placement can't exist in Roblox. Ask Kiln to fix it (kiln_request {kiln_project, kind: \"fix\", text: the blocking problems as they are}), then import again."
          : 'Kiln says the map will not look in Roblox as it does in Kiln, and nothing was imported. Either ask Kiln to fix the problems (kiln_request {kiln_project, kind: "fix", text: the look problems as they are}) and import again, or import it as it is with accept_problems: true and say so in your result.',
      };
    }

    // 3. The layout's manifest: Kiln's last export when it is of the scene as it is now, else a new bake.
    let manifest: KilnManifest | null = null;
    const adopt = (raw: unknown) => {
      const blend = (raw as { blend?: unknown } | null)?.blend;
      const parsed = parseManifest(raw, typeof blend === 'string' && blend ? dirname(blend) : null);
      for (const n of parsed.notes) if (!notes.includes(n)) notes.push(n);
      return parsed.manifest;
    };
    if (got.export && got.current && (got.export as { plain?: unknown }).plain === true) manifest = adopt(got.export);
    if (!manifest && o.checkOnly && got.export) {
      manifest = adopt(got.export);
      notes.push(got.current ? "Kiln's last export was made without plain materials: the import bakes it again (one-colour materials stay untextured)." : "Kiln's last export is of an older version of the scene: the numbers below are that export's; the import bakes the scene as it is now.");
    }
    if (!manifest && !o.checkOnly) {
      say("Asking Kiln for the map's baked export");
      const b = await this.bake(o.project, true, o.signal);
      if (!b.ok) return { ...base, ok: false, done: false, map, check: checkOut, error: `Kiln's Roblox export of the map failed: ${b.error}` };
      manifest = adopt(b.raw);
    }
    const summary = manifest
      ? {
          version: manifest.version,
          units: manifest.units,
          studsPerUnit: manifest.studsPerUnit,
          plain: manifest.plain,
          meshes: Object.keys(manifest.meshes).length,
          materials: { total: manifest.materials.length, plain: manifest.materials.filter((m) => m.plain).length, robloxMaterial: manifest.materials.filter((m) => m.robloxMaterial).length, textured: manifest.materials.filter((m) => !m.plain).length },
          pieces: Object.values(manifest.pieces).filter((p) => p.placements > 0).length,
          placements: manifest.placements.length,
          markers: manifest.markers.length,
          paths: manifest.paths.length,
          roles: Object.keys(manifest.roles).length,
          colliders: manifest.colliders.length,
        }
      : undefined;
    if (o.checkOnly || !manifest) {
      return { ...base, ok: true, done: false, map, check: checkOut, ...(summary ? { manifest: summary } : {}), next: manifest ? (ready ? 'Nothing was imported (check_only). Call again without check_only to bring it in.' : 'Nothing was imported (check_only), and Kiln lists problems: fix them through kiln_request (kind "fix"), or import with accept_problems: true.') : 'Kiln has no Roblox export of this map yet: call again without check_only to bake and import it.' };
    }
    const stale = Object.entries(manifest.pieces).filter(([, p]) => p.stale && p.placements > 0).map(([n]) => n);
    if (stale.length) notes.push(`${stale.length === 1 ? 'Piece' : 'Pieces'} ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ` and ${stale.length - 8} more` : ''} changed in ${stale.length === 1 ? 'its' : 'their'} own project since the map brought ${stale.length === 1 ? 'it' : 'them'} in: the game gets the newer piece (Kiln's view of the map shows the older one until kiln.piece is run again there).`);

    // 4. The pieces: each is its own Kiln project, exported once, and only when that project changed.
    const prev = this.mapState(root, map);
    const state: MapState = { map, project: o.project, pieces: {} };
    const used = Object.entries(manifest.pieces).filter(([name]) => manifest!.placements.some((p) => p.piece === name));
    const exported: string[] = [];
    const unchanged: string[] = [];
    const failed: Array<{ model: string; why: string }> = [];
    /** Pieces that have a model to clone: piece name → its model. */
    const pieceModel: Record<string, string> = {};
    const takenNames = new Map(Object.entries(this.models(root)).map(([model, s]) => [model, s.project]));
    takenNames.set(map, o.project);
    const modelFor = (piece: string, project: string): string => {
      const known = linked[project] ?? Object.entries(this.models(root)).find(([, s]) => s.project === project)?.[0] ?? (prev?.pieces[piece] && this.models(root)[prev.pieces[piece]!]?.project === project ? prev.pieces[piece] : undefined);
      if (known) return known;
      let name = modelNameFrom(piece);
      // A name another project's model (or the map itself) has: told apart by the project.
      if ((takenNames.has(name) && takenNames.get(name) !== project) || (new ModelStore(root).parts(name).length > 0 && !this.models(root)[name])) name = `${name.slice(0, 32)}_${sha(project).slice(0, 4)}`;
      takenNames.set(name, project);
      return name;
    };
    await lookUp(used.map(([, info]) => info.project));
    /** Models whose project was baked in this call: a bake may count as a change of the project, so its `updatedAt` is read again afterwards. */
    const baked: Array<{ model: string; project: string }> = [];
    for (const [i, [piece, info]] of used.entries()) {
      if (o.signal?.aborted) return { ...base, ok: false, done: false, map, check: checkOut, manifest: summary, error: 'The import was cancelled.' };
      const model = modelFor(piece, info.project);
      state.pieces[piece] = model;
      const meta = projects.get(info.project);
      if (!o.refresh && this.fresh(root, model, info.project, meta, true, [])) {
        unchanged.push(model);
        // Known unchanged by its fingerprint: remember when it last changed too, for the day the app listing no longer has it.
        const s = this.models(root)[model];
        if (s && meta?.fingerprint && meta.updatedAt && s.updatedAt !== meta.updatedAt) this.saveModel(root, model, { ...s, updatedAt: meta.updatedAt });
      } else if (left() < 45_000) {
        this.saveMap(root, { ...state, pieces: { ...(prev?.pieces ?? {}), ...state.pieces } });
        return { ...base, ok: true, done: false, map, check: checkOut, manifest: summary, models: { exported, unchanged, failed }, next: `${used.length - i} of ${used.length} pieces are still to export. ${again}` };
      } else {
        say(`Exporting piece ${i + 1} of ${used.length}: ${piece}`);
        // A project no listing has is gone; one the listings could not be read for is tried (Kiln says if it is gone).
        const b = meta || !all ? await this.bake(info.project, true, o.signal) : ({ ok: false, error: 'Kiln no longer has that project' } as const);
        if (!b.ok) failed.push({ model, why: b.error });
        else {
          const pm = parseManifest(b.raw, typeof b.raw.blend === 'string' ? dirname(b.raw.blend) : null).manifest;
          baked.push({ model, project: info.project });
          // Kiln's bake is of the scene the parts were exported from (a project whose listing carries no fingerprint): nothing to export.
          if (!o.refresh && this.fresh(root, model, info.project, { fingerprint: pm.sourceFingerprint }, pm.plain, [])) unchanged.push(model);
          else {
            const r = await this.exportModel(root, model, info.project, pm, [], meta?.updatedAt ?? null);
            if (r.ok) exported.push(model);
            else failed.push({ model, why: r.error });
          }
        }
      }
      if (this.metas(root, model).length && this.models(root)[model] && !failed.some((f) => f.model === model)) pieceModel[piece] = model;
    }
    // Those projects' last change as it is after the bakes (a bake may count as one): the next import then knows them
    // unchanged from the listing alone, without opening them in Kiln.
    if (baked.length) {
      const after = await storage();
      for (const b of baked) {
        const s = this.models(root)[b.model];
        const at = after?.get(b.project)?.updatedAt;
        if (s && at && s.updatedAt !== at) this.saveModel(root, b.model, { ...s, updatedAt: at });
      }
    }
    for (const f of failed) notes.push(`Piece model ${f.model} could not be exported from its own project (${f.why}): its placements stay part of the map's own geometry, as the map's copy of the piece.`);

    // 5. The layout's own geometry, without the placements that are placed as clones.
    const drop = [...new Set(used.filter(([name]) => pieceModel[name]).map(([, info]) => info.project))].sort();
    if (!o.refresh && this.fresh(root, map, o.project, { fingerprint: manifest.sourceFingerprint ?? projects.get(o.project)?.fingerprint }, manifest.plain, drop)) {
      unchanged.push(map);
    } else if (left() < 45_000) {
      this.saveMap(root, state);
      return { ...base, ok: true, done: false, map, check: checkOut, manifest: summary, models: { exported, unchanged, failed }, next: `The map's own geometry is still to export. ${again}` };
    } else {
      say(`Exporting the map's own geometry (${manifest.objects} objects, ${Object.keys(manifest.meshes).length} unique meshes)`);
      const r = await this.exportModel(root, map, o.project, manifest, drop);
      if (!r.ok) return { ...base, ok: false, done: false, map, check: checkOut, manifest: summary, models: { exported, unchanged, failed }, error: `Exporting the map's own geometry failed: ${r.error}` };
      exported.push(map);
      for (const n of r.notes.slice(0, 6)) notes.push(n);
    }
    this.saveMap(root, state);
    const models = { exported, unchanged, failed };

    // 6. Uploads: one per unique mesh, joined to the queue every other tool uses.
    const names = [map, ...new Set(Object.values(pieceModel))];
    const metas = names.flatMap((m) => this.metas(root, m));
    let uploads: LayoutImportResult['uploads'];
    if (!o.temporary) {
      if (!this.d.uploader) {
        uploads = { parts: metas.length, uploaded: 0, reused: 0, stillUploading: [], failed: [{ name: '*', why: 'uploading is not available here' }] };
      } else {
        const need = metas.filter((m) => !ModelStore.assetId(m)).length;
        if (need) say(`Uploading ${need} of ${metas.length} meshes to Roblox`);
        const up = await this.d.uploader.ensureMany(root, metas, { budgetMs: Math.max(250, left() - 40_000), signal: o.signal, onProgress: (p) => say(p.message) });
        const bad = up.results.filter((r) => !r.assetId);
        uploads = { parts: metas.length, uploaded: up.results.filter((r) => r.assetId && !r.reused).length, reused: up.results.filter((r) => r.reused).length, stillUploading: up.stillUploading, failed: bad.slice(0, 20).map((r) => ({ name: r.name, why: r.why ?? 'not uploaded' })), ...(bad.some((r) => r.needsUser) ? { needsUser: true } : {}) };
        if (up.stillUploading.length) {
          return { ...base, ok: true, done: false, map, check: checkOut, manifest: summary, models, uploads, next: `${up.stillUploading.length} of ${metas.length} meshes are still uploading to Roblox (up to six at a time; each upload carries on by itself). ${again}` };
        }
        if (bad.length === metas.length && metas.length) {
          return { ...base, ok: true, done: false, map, check: checkOut, manifest: summary, models, uploads, next: `None of the ${metas.length} meshes could be uploaded (${bad[0]!.why ?? 'not uploaded'}), so nothing was placed. ${bad.some((r) => r.needsUser) ? 'That is the user\'s to fix (Settings → Roblox: an Open Cloud key with the Assets permission); tell them. ' : ''}To look at the map in Studio meanwhile, call again with temporary: true (temporary meshes are not saved with the place).` };
        }
      }
    }

    // 7. The plan, and Studio.
    // (the parts are read now: the uploads above gave them their asset ids). Placements of a piece that has no model
    // are in the map's own geometry already.
    const pieces = Object.fromEntries(Object.entries(pieceModel).map(([piece, model]) => [piece, { model, studsPerUnit: this.models(root)[model]!.studsPerUnit, parts: this.layoutParts(root, model) }]));
    const plan = planLayout({ map, manifest: { ...manifest, placements: manifest.placements.filter((p) => pieces[p.piece]) }, own: this.layoutParts(root, map), pieces, temporary: !!o.temporary });
    for (const n of plan.notes) notes.push(n);
    const where = { root: `Workspace.${map}`, static: `Workspace.${map}.Static`, pieces: `Workspace.${map}.Pieces.c_<x>_<z>`, markers: `Workspace.${map}.Markers`, kit: `ServerStorage.${MAP_KIT}.${map}`, cellStuds: LAYOUT_CELL };
    const data = await this.writeData(root, plan, manifest);
    if (!this.d.studio.connected) {
      return { ...base, ok: true, done: false, map, check: checkOut, manifest: summary, models, uploads, studio: { placed: false, why: 'Studio is not connected' }, where, data, next: `The map is exported${o.temporary ? '' : ' and uploaded'}; Studio is not connected, so nothing was placed. ${again}` };
    }
    const lease = await this.d.studio.waitForLease();
    if (!lease.ok) return { ...base, ok: true, done: false, map, check: checkOut, manifest: summary, models, uploads, studio: { placed: false, why: lease.message ?? 'Studio is busy' }, where, data, next: `Placing needs Studio in Edit mode. ${again}` };
    const studio = await this.place(root, plan, { temporary: !!o.temporary, signal: o.signal, say, left });
    const done = studio.placed && !studio.units!.failed && !studio.units!.waiting && !studio.templates!.failed && !studio.why;
    this.saveMap(root, { ...state, lastRun: { at: new Date().toISOString(), run: studio.run, units: plan.units.length, parts: plan.counts.parts, templates: plan.templates.length, done } });
    this.d.bus.emit('roblox.changed', { reason: 'luau' });
    const { run: _run, ...studioOut } = studio;
    return {
      ...base,
      ok: true,
      done,
      map,
      check: checkOut,
      manifest: summary,
      models,
      uploads,
      studio: studioOut,
      where,
      data,
      ...(done
        ? { next: `The map is in Studio under ${where.root}${o.temporary ? ' as temporary meshes (not saved with the place: import again without temporary once uploading works)' : ''}. Look at it (roblox_screenshot from above and from a spawn marker), then save the place.` }
        : { next: `${studio.why ?? 'Some of it is not placed yet'}. ${again}` }),
    };
  }

  /** The data module (paths and markers for game code) and the markers' world builder, written when they changed. */
  private async writeData(root: string, plan: LayoutPlan, manifest: KilnManifest): Promise<LayoutImportResult['data']> {
    const module = mapModuleName(plan.map);
    const builder = join(root, 'world', `${module}Markers.luau`);
    if (plan.markers.length) {
      mkdirSync(join(root, 'world'), { recursive: true });
      const code = `${markersLuau(plan.map, plan.markers)}\n`;
      if (readJsonText(builder) !== code) writeFileSync(builder, code, 'utf8');
    } else if (existsSync(builder)) rmSync(builder, { force: true });
    if (!plan.paths.length && !plan.markers.length) return null;
    const loc = this.d.dataLocation?.(root, module) ?? { file: `src/Shared/ShurikenMaps/${module}.luau`, requirePath: `game.ReplicatedStorage.Shared.ShurikenMaps.${module}` };
    const file = join(root, loc.file);
    const code = mapDataModule(plan.map, plan.paths, plan.markers, { studsPerUnit: manifest.studsPerUnit, root: `Workspace.${plan.map}` });
    let sync = 'up to date';
    if (readJsonText(file) !== code) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, code, 'utf8');
      sync = 'written';
    }
    if (this.d.pushFile) sync = await this.d.pushFile(root, loc.file).catch((e: Error) => `not pushed: ${e.message}`);
    return { file: loc.file, require: loc.requirePath, sync, markerTag: MARKER_TAG, paths: plan.paths.map((p) => ({ name: p.name, role: p.role, points: p.points.length, length: p.length })) };
  }

  /** Templates, then units in batches, then markers, then the sweep: each call small, each resumable. */
  private async place(root: string, plan: LayoutPlan, o: { temporary: boolean; signal?: AbortSignal; say: (m: string) => void; left: () => number }): Promise<NonNullable<LayoutImportResult['studio']> & { run: string }> {
    const run = `r${Date.now().toString(36)}`;
    const failures: string[] = [];
    const fail = (list: unknown) => {
      for (const f of Array.isArray(list) ? list : []) if (typeof f === 'string' && failures.length < 16) failures.push(f.slice(0, 220));
    };
    const call = async <T>(code: string, timeoutMs: number): Promise<{ ok: true; data: T; ms: number } | { ok: false; error: string }> => {
      const r = await this.d.studio.runLuau(code, 'Edit', timeoutMs, o.signal).catch((e: Error) => ({ ok: false, output: e.message, durationMs: 0 }));
      if (!r.ok) return { ok: false, error: r.output.slice(0, 400) };
      try {
        return { ok: true, data: JSON.parse(r.output.trim()) as T, ms: r.durationMs };
      } catch {
        return { ok: false, error: `unexpected answer from Studio: ${r.output.slice(0, 200)}` };
      }
    };
    const templates = { made: 0, kept: 0, failed: 0 };
    const units = { total: plan.units.length, placed: 0, kept: 0, replaced: 0, failed: 0, waiting: 0, removed: 0, parts: plan.counts.parts, calls: 0 };
    const out = (why?: string) => ({ placed: !why || units.placed + units.kept + units.replaced > 0, ...(why ? { why } : {}), ...(o.temporary ? { temporary: true } : {}), templates, units, ...(failures.length ? { failures } : {}), run });
    const outOfTime = () => o.left() < 25_000 || !!o.signal?.aborted;

    // The kit: one template per unique mesh. Uploaded meshes are loaded 20 a call to begin with (each is a network
    // load in Studio), temporary ones by the size of their mesh data.
    type KitOut = { made: number; kept: number; failed: number; failures?: string[] };
    const ready = new Set<number>();
    const store = new ModelStore(root);
    const wanted = plan.templates.map((t, i) => ({ t, i }));
    const kitDone = (list: Array<{ t: PlanTemplate; i: number }>, r: KitOut) => {
      templates.made += r.made;
      templates.kept += r.kept;
      templates.failed += r.failed;
      fail(r.failures);
      const bad = new Set((r.failures ?? []).map((f) => f.split(':')[0]));
      // More failed than were listed: none of this batch can be trusted to be there.
      if (r.failed > (r.failures?.length ?? 0)) return;
      for (const x of list) if (!bad.has(x.t.name)) ready.add(x.i);
    };
    if (o.temporary) {
      let batch: Array<{ t: PlanTemplate; i: number; mesh: { v: number[]; t: number[]; n?: number[] } }> = [];
      let size = 0;
      const flush = async (): Promise<string | null> => {
        if (!batch.length) return null;
        const list = batch;
        batch = [];
        size = 0;
        const r = await call<KitOut>(kitTemporaryLuau(plan.map, list.map((x) => ({ template: x.t, mesh: x.mesh }))), 240_000);
        units.calls++;
        if (!r.ok) return r.error;
        kitDone(list, r.data);
        return null;
      };
      for (const x of wanted) {
        if (outOfTime()) return out('This call ran out of time while building the temporary meshes');
        const mesh = readJson<{ v: number[]; t: number[]; n?: number[] } | null>(store.paths(x.t.name).mesh, null);
        if (!mesh || mesh.t.length / 3 > MAX_TEMP_TRIS) {
          templates.failed++;
          if (failures.length < 16) failures.push(`${x.t.name}: ${mesh ? `${mesh.t.length / 3} triangles is too many for a temporary mesh (upload it)` : 'its mesh file is missing (export the model again)'}`);
          continue;
        }
        const est = mesh.v.length * 8 + mesh.t.length * 6 + (mesh.n?.length ?? 0) * 7;
        if (batch.length && size + est > 170_000) {
          const err = await flush();
          if (err) return out(`Building the temporary meshes failed in Studio (${err})`);
        }
        batch.push({ ...x, mesh });
        size += est;
        o.say(`Building temporary meshes in Studio: ${ready.size} of ${wanted.length}`);
      }
      const err = await flush();
      if (err) return out(`Building the temporary meshes failed in Studio (${err})`);
    } else {
      const have = wanted.filter((x) => x.t.asset);
      let per = 20;
      for (let at = 0; at < have.length; ) {
        if (outOfTime()) return out(`This call ran out of time while loading the meshes into Studio (${ready.size} of ${have.length} are in)`);
        const list = have.slice(at, at + per);
        o.say(`Loading meshes into Studio: ${at} of ${have.length}`);
        const r = await call<KitOut>(kitLuau(plan.map, list.map((x) => x.t)), 240_000);
        units.calls++;
        if (!r.ok) {
          // A call that failed whole (a timeout, Studio left Edit): once more with fewer, then give up for this call.
          if (per > 4) {
            per = Math.max(4, Math.floor(per / 4));
            continue;
          }
          return out(`Loading the meshes into Studio failed (${r.error})`);
        }
        kitDone(list, r.data);
        at += list.length;
        per = r.ms < 15_000 ? Math.min(60, per * 2) : r.ms > 90_000 ? Math.max(4, Math.floor(per / 2)) : per;
      }
    }

    // Units whose every mesh is in the kit are placed; the others wait for their mesh (the next import places them).
    const sendable: PlanUnit[] = [];
    const missing = new Set<string>();
    for (const u of plan.units) {
      const lacks = u.uses.filter((x) => !ready.has(x.t));
      if (lacks.length) {
        units.waiting++;
        for (const x of lacks) missing.add(plan.templates[x.t]!.name);
      } else sendable.push(u);
    }
    type UnitsOut = { placed: number; kept: number; replaced: number; failed: number; failures?: string[] };
    let maxUses = 300;
    let stopped: string | null = null;
    for (let at = 0; at < sendable.length; ) {
      if (outOfTime()) {
        stopped = `This call ran out of time after ${at} of ${sendable.length} placements`;
        break;
      }
      const batch = batchUnits(sendable.slice(at, at + maxUses), { maxUses, maxChars: 150_000, chars: unitChars })[0]!;
      o.say(`Placing the map in Studio: ${at} of ${sendable.length} placements`);
      const r = await call<UnitsOut>(unitsLuau(plan, run, batch), 180_000);
      units.calls++;
      if (!r.ok) {
        if (maxUses > 25) {
          maxUses = Math.max(25, Math.floor(maxUses / 4));
          continue;
        }
        stopped = `Placing failed in Studio (${r.error})`;
        break;
      }
      units.placed += r.data.placed;
      units.kept += r.data.kept;
      units.replaced += r.data.replaced;
      units.failed += r.data.failed;
      fail(r.data.failures);
      at += batch.length;
      maxUses = r.ms < 4_000 ? Math.min(1200, maxUses * 2) : r.ms > 25_000 ? Math.max(25, Math.floor(maxUses / 2)) : maxUses;
    }
    let markers: number | undefined;
    if (!stopped) {
      const m = await call<{ markers: number }>(markersLuau(plan.map, plan.markers), 60_000);
      units.calls++;
      if (m.ok) markers = m.data.markers;
      else stopped = `The markers could not be placed (${m.error})`;
    }
    // What an earlier import placed and this map no longer has goes, once everything of this one is in.
    if (!stopped && !units.failed && !units.waiting) {
      const s = await call<{ removed: number; templates: number }>(sweepLuau(plan.map, run, plan.templates.map((t) => t.name)), 120_000);
      units.calls++;
      if (s.ok) units.removed = s.data.removed;
    }
    const why = stopped ?? (units.waiting ? `${units.waiting} placement${units.waiting === 1 ? ' waits' : 's wait'} for ${missing.size} mesh${missing.size === 1 ? '' : 'es'} that ${missing.size === 1 ? 'is' : 'are'} not in Studio yet (${[...missing].slice(0, 6).join(', ')}${missing.size > 6 ? ', …' : ''})` : units.failed ? `${units.failed} placement${units.failed === 1 ? '' : 's'} failed in Studio` : undefined);
    return { ...out(why), ...(markers !== undefined ? { markers } : {}) };
  }
}

function readJsonText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
