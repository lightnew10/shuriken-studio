import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import type { ExecResult, ExportedPart, ModelingBackend, ModelingReply, ModelingWorkspace, SceneIssues, SceneSummary, WorkspaceInfo } from './backend';
import { freshNotes, recordClips, recordParts } from './publish';
import type { ClipImport } from '../animation/kiln-clips';
import { ModelStore } from './model-store';
import { kilnContentProblems } from '../roblox/content-rules';
import { lightingHash, type KilnLighting } from './kiln-lighting';
import { KilnLauncher, kilnStartForbidden, type KilnStarted } from './kiln-launch';
import { parseManifest, type Mat4 } from './kiln-manifest';
import { Gate, KILN_BUILDS_DEFAULT, KILN_GPU_GATE_VERSION, KILN_GPU_JOBS_UNGATED, KilnBuildQueue } from './kiln-queue';
import { KILN_RESULTS_VERSION, kilnAtLeast, versionParts } from './kiln-version';
import { familyOfModel, familyOfProject, familyProblems, listFamilies, memberPrepare, modelSockets, parseChecks, parsePrepared, readSockets, readStyleSheet, socketSpread, styleId, writeFamily, writeStyleSheet, type FamilyRecord, type KilnCheckResult, type KilnFit, type MarkerIn, type MemberBox, type MemberRead, type StyleSheet } from './kiln-family';

/**
 * Modeling in the user's Kiln app (their headless-Blender workspace with a live 3D viewer), behind the
 * same seam as Shuriken's own Blender (backend.ts). When Kiln is running and the setting allows it,
 * each model an agent works on becomes a Kiln project in studs: the agents' Blender Python runs there
 * (with Kiln's newer helpers: terrain, scatter, trees, rocks, blobs, the building kit), the user can
 * watch it being built in Kiln's viewer, and after every change the scene is exported to Roblox
 * MeshParts by Shuriken's own export (resources/blender/roblox_export.py, loaded into Kiln's Blender
 * through Kiln's "ext" op) and recorded in the model store like any other model. The .blend is copied
 * back to models/<Name>.blend after each change, so when Kiln isn't running (or closes) the same model
 * carries on in Shuriken's own Blender without losing anything.
 *
 * Kiln is found through %APPDATA%\Kiln\runtime.json (port and token of its local API; KILN_RUNTIME
 * overrides the path). Everything degrades to the fallback engine; errors come back as values.
 */

interface Runtime {
  port: number;
  token: string;
  version: string;
  pid: number;
}

interface Health {
  ok: boolean;
  version: string | null;
  blender: string | null;
  detail: string;
  at: number;
}

const OWNER_GRACE_MS = 10 * 60_000;
const HEALTH_TTL_MS = 8_000;
/** Kiln closes a project nobody watches after five idle minutes; count it open until then. */
const KILN_IDLE_MS = 5 * 60_000;
/** How long a lock in Kiln lasts without a refresh (each step refreshes it). */
const LOCK_SECONDS = 120;
const mtime = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

export function kilnRuntimeFile(): string {
  if (process.env.KILN_RUNTIME) return process.env.KILN_RUNTIME;
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Kiln', 'runtime.json');
}

export { KILN_RESULTS_VERSION, kilnAtLeast, versionParts };

/** Kiln answered with an HTTP error (409: its copilot is working). */
export class KilnHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Kiln's local API (token-protected, 127.0.0.1 only). */
export class KilnClient {
  private runtime: Runtime | null = null;
  health: Health = { ok: false, version: null, blender: null, detail: 'Kiln has not been checked yet', at: 0 };

  constructor(private readonly runtimeFile: () => string = kilnRuntimeFile) {}

  private readRuntime(): Runtime | null {
    try {
      const r = JSON.parse(readFileSync(this.runtimeFile(), 'utf8')) as Partial<Runtime>;
      if (!r.port || !r.token) return null;
      return { port: r.port, token: r.token, version: String(r.version ?? ''), pid: Number(r.pid ?? 0) };
    } catch {
      return null;
    }
  }

  /** Whether Kiln answers (re-checked at most every few seconds). */
  async check(force = false): Promise<Health> {
    if (!force && Date.now() - this.health.at < HEALTH_TTL_MS) return this.health;
    const rt = this.readRuntime();
    if (!rt) {
      this.runtime = null;
      this.health = { ok: false, version: null, blender: null, detail: 'Kiln is not running', at: Date.now() };
      return this.health;
    }
    this.runtime = rt;
    try {
      const app = (await this.get('/api/v1/app', 2500)) as { version?: string; blender?: { path?: string | null } };
      const blender = app.blender?.path ?? null;
      this.health = blender
        ? { ok: true, version: app.version ?? rt.version, blender, detail: `Kiln ${app.version ?? rt.version}`, at: Date.now() }
        : { ok: false, version: app.version ?? rt.version, blender: null, detail: 'Kiln is running but has no Blender', at: Date.now() };
    } catch {
      this.health = { ok: false, version: null, blender: null, detail: 'Kiln is not running', at: Date.now() };
    }
    return this.health;
  }

  /** Whether Kiln answered at the last check and is at least this version. */
  supports(min: string = KILN_RESULTS_VERSION): boolean {
    return this.health.ok && kilnAtLeast(this.health.version, min);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60_000, retried = false): Promise<unknown> {
    const rt = this.runtime ?? this.readRuntime();
    if (!rt) throw new Error('Kiln is not running');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${rt.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${rt.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok && res.status !== 500) throw new KilnHttpError(String(data.error ?? `Kiln answered ${res.status}`), res.status);
      return data;
    } catch (e) {
      // A refused connection or a rejected token: Kiln quit (runtime.json is removed) or a newer Kiln took over (0.8 steps aside: its port and
      // token change). Read runtime.json again: gone is "not running"; a different port or token is tried once.
      const gone = !(e instanceof KilnHttpError) ? !ctl.signal.aborted : e.status === 401 || e.status === 403;
      if (gone && !retried) {
        const fresh = this.readRuntime();
        if (!fresh) {
          this.runtime = null;
          this.health = { ok: false, version: null, blender: null, detail: 'Kiln is not running', at: Date.now() };
          throw new Error('Kiln is not running');
        }
        if (fresh.port !== rt.port || fresh.token !== rt.token) {
          this.runtime = fresh;
          return this.request(method, path, body, timeoutMs, true);
        }
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path: string, timeoutMs?: number): Promise<unknown> {
    return this.request('GET', path, undefined, timeoutMs);
  }

  post(path: string, body: unknown = {}, timeoutMs?: number): Promise<unknown> {
    return this.request('POST', path, body, timeoutMs);
  }
}

/** .shuriken/kiln/<Model>.json: how a model is linked to its Kiln project. */
interface LinkFile {
  projectId?: string;
  blendMtime?: number;
  animFp?: string | null;
  mapsFp?: string | null;
  targetFp?: string;
  /** A member of a family: its Kiln project is the family's (see kiln-family.ts). */
  family?: string;
}

/** What importing a family brought in: each member as a model, with what was read back. */
export interface FamilyImport {
  family: string;
  models: Record<string, MemberRead>;
  /** Members asked for that aren't in Kiln's scene as their own object. */
  missing: string[];
  /** How far apart each socket sits across the members (studs; 0 = the same place on all). */
  spread: Record<string, number | null>;
  /** What the build still owes the game, as lines for a fix brief. */
  problems: string[];
  /** Kiln's own check of the socket pairings, and of the brief's requirements (0.8.2). */
  fit?: KilnFit | null;
  checks?: KilnCheckResult[];
}

/** What a turn's delivery says beyond the manifest (Kiln 0.8.2): the brief's requirements as checked, and the fit. */
export interface DeliveryFacts {
  checks?: unknown;
  fit?: unknown;
}

/** One model as a Kiln project. */
export class KilnWorkspace implements ModelingWorkspace {
  owner: string | null = null;
  by: string | null = null;
  step: string | null = null;
  busy = 0;
  lastUsed = Date.now();
  version = 0;
  parts: ExportedPart[] = [];
  /** What the last export did with the model's clips (a Kiln-rigged model's animations). */
  clips: ClipImport | null = null;
  summary: SceneSummary | null = null;
  /** Export notes already told for this model (each is listed once, see freshNotes). */
  private seenNotes = new Set<string>();
  projectId: string | null = null;
  /** Its Kiln project is (probably) open, holding a Blender. */
  get open(): boolean {
    return !!this.projectId && (this.busy > 0 || Date.now() - this.lastUsed < KILN_IDLE_MS);
  }

  constructor(
    readonly root: string,
    readonly name: string,
    private readonly svc: KilnModeling,
  ) {
    mkdirSync(this.dir, { recursive: true });
    try {
      this.parts = JSON.parse(readFileSync(this.partsFile, 'utf8')) as ExportedPart[];
    } catch {
      this.parts = [];
    }
  }

  private get dir(): string {
    return join(this.root, '.shuriken', 'kiln');
  }

  private get linkFile(): string {
    return join(this.dir, `${this.name}.json`);
  }

  /** The same parts list Shuriken's own engine keeps, so a switch back to it continues cleanly. */
  private get partsFile(): string {
    const d = join(this.root, '.shuriken', 'blender', this.name);
    mkdirSync(d, { recursive: true });
    return join(d, 'parts.json');
  }

  get blend(): string {
    return join(this.root, 'models', `${this.name}.blend`);
  }

  private readLink(): LinkFile {
    try {
      return JSON.parse(readFileSync(this.linkFile, 'utf8')) as LinkFile;
    } catch {
      return {};
    }
  }

  /** What was last sent to this model's Kiln project as its Roblox target: "<project id>|<lighting hash, or - for none>". */
  get targetFp(): string | null {
    return this.readLink().targetFp ?? null;
  }

  setTargetFp(fp: string): void {
    this.writeLink({ targetFp: fp });
  }

  /** The animation fingerprint (clips and joints) Shuriken last brought in from Kiln. */
  get animFp(): string | null {
    return this.readLink().animFp ?? null;
  }

  private writeLink(patch: LinkFile) {
    writeFileSync(this.linkFile, JSON.stringify({ ...this.readLink(), ...patch }, null, 2));
  }

  /**
   * The Kiln project for this model: the linked one, or a new one (seeded from models/<Name>.blend). On
   * Kiln 0.7.3 it is a Roblox-target project and has the place's lighting (see KilnModeling.syncTarget).
   */
  private async project(): Promise<string> {
    if (this.projectId) return this.projectId;
    const id = await this.resolveProject();
    await this.svc.syncTarget(this.root, this.name, id);
    return id;
  }

  private async resolveProject(): Promise<string> {
    const k = this.svc.kiln;
    const saved = this.readLink();
    try {
      if (saved.projectId) {
        const st = (await k.get(`/api/v1/projects/${saved.projectId}/state`)) as { scene?: { version?: number } };
        if (st.scene) {
          this.projectId = saved.projectId;
          this.version = st.scene.version ?? this.version;
          // Shuriken's own Blender carried on while Kiln was away: bring Kiln up to date first.
          const now = mtime(this.blend);
          if (now && saved.blendMtime && now > saved.blendMtime + 1000) {
            const r = (await k.post(`/api/v1/projects/${saved.projectId}/import`, { path: this.blend }, 120_000)) as { ok?: boolean; error?: string };
            if (r.ok) this.writeLink({ blendMtime: now });
            else this.svc.log.warn(`Kiln could not take ${this.name}'s newer .blend`, r.error);
          }
          return this.projectId;
        }
      }
    } catch {
      /* no link yet, or the Kiln project was deleted */
    }
    // Kiln 0.7.3 builds for Roblox when told so, and lights its previews like the place.
    const roblox = this.svc.kiln.supports();
    const lighting = roblox ? await this.svc.readLighting() : null;
    const meta = (await k.post('/api/v1/projects', { title: this.name, units: 'studs', linked: { app: 'Shuriken Studio', model: this.name, project: this.root }, ...(roblox ? { target: 'roblox', ...(lighting ? { lighting } : {}) } : {}) })) as { id: string };
    this.projectId = meta.id;
    this.writeLink({ projectId: meta.id, blendMtime: mtime(this.blend) });
    if (roblox) this.svc.noteTargetSent(meta.id, lighting, this.root, this.name);
    if (existsSync(this.blend)) {
      const r = (await k.post(`/api/v1/projects/${meta.id}/import`, { path: this.blend }, 120_000)) as { ok?: boolean; error?: string };
      if (!r.ok) this.svc.log.warn(`Kiln could not open ${this.name}.blend`, r.error);
    }
    return meta.id;
  }

  private async run<T>(fn: (id: string) => Promise<T>): Promise<T> {
    await this.svc.makeRoom(this);
    this.busy++;
    this.lastUsed = Date.now();
    this.svc.changed();
    try {
      const id = await this.project();
      // While Shuriken works on it, Kiln's own chat and undo on this model wait (the lock expires by itself).
      await this.svc.kiln.post(`/api/v1/projects/${id}/lock`, { by: 'Shuriken Studio', seconds: LOCK_SECONDS }, 5000).catch(() => undefined);
      return await fn(id);
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
      this.svc.changed();
    }
  }

  /**
   * Export to Roblox parts through Shuriken's export, record them, copy the .blend home. On Kiln 0.7.3 the
   * export runs on Kiln's baked Roblox copy of the model (one atlas per material, see KilnModeling.exportBaked),
   * in Shuriken's own Blender; older Kiln, or a bake that isn't available, exports the live scene inside Kiln's Blender.
   */
  private async publish(id: string): Promise<{ size: [number, number, number] | null; notes: string[] }> {
    const k = this.svc.kiln;
    mkdirSync(join(this.root, 'models'), { recursive: true });
    try {
      const f = (await k.get(`/api/v1/projects/${id}/file`)) as { scene?: string; version?: number };
      if (f.scene && existsSync(f.scene)) {
        copyFileSync(f.scene, this.blend);
        this.writeLink({ blendMtime: mtime(this.blend) });
      }
      if (typeof f.version === 'number') this.version = f.version;
    } catch (e) {
      this.svc.log.warn(`Copying ${this.name}.blend from Kiln failed`, (e as Error).message);
    }
    if (!this.svc.exportDir) return { size: null, notes: [] };
    type Exported = { ok?: boolean; error?: string; parts?: ExportedPart[]; size?: [number, number, number]; anim_fp?: string | null; notes?: string[]; maps_fp?: string };
    let r: Exported | null = null;
    let bakeNote: string | null = null;
    let manifest: Record<string, unknown> | null = null;
    if (k.supports()) {
      const baked = await this.svc.exportBaked(id, this.root, this.name);
      if (baked.ok) {
        r = baked.reply as Exported;
        manifest = baked.manifest ?? null;
        const flagged = kilnContentProblems(manifest);
        if (flagged.length) r.notes = [...(r.notes ?? []), ...flagged];
        // What syncClips compares Kiln's live clips with is Kiln's own fingerprint of them (GET anim), not the baked copy's.
        const live = (await k.get(`/api/v1/projects/${id}/anim`, 5000).catch(() => null)) as { anim?: string | null } | null;
        if (live?.anim) r.anim_fp = live.anim;
      } else {
        bakeNote = `Kiln's baked Roblox export wasn't available (${baked.error}); this is Shuriken's export of the live scene (procedural materials and coats are not baked)`;
        this.svc.log.warn(`Kiln's baked Roblox export of ${this.name} failed; exporting the live scene`, baked.error);
      }
    }
    r ??= (await k.post(`/api/v1/projects/${id}/ext`, { dir: this.svc.exportDir, module: 'roblox_export', func: 'export', args: { dir: join(this.root, 'models'), name: this.name } }, 180_000)) as Exported;
    if (!r.ok) {
      this.svc.log.warn(`Exporting ${this.name} for Roblox (in Kiln) failed`, r.error);
      return { size: null, notes: [] };
    }
    if (bakeNote) r.notes = [bakeNote, ...(r.notes ?? [])];
    const done = this.recordExport(r);
    // A model with sockets (a family of one): where Kiln put them, read back for the game's spec.
    this.svc.readBackSingle(this.root, this.name, manifest, r);
    return done;
  }

  /** Records an export of this model: its Roblox parts, clips and fingerprints. */
  recordExport(r: { parts?: ExportedPart[]; size?: [number, number, number]; anim_fp?: string | null; notes?: string[]; maps_fp?: string }): { size: [number, number, number] | null; notes: string[] } {
    const parts = r.parts ?? [];
    recordParts(this.root, this.name, parts, this.parts, this.svc.bus);
    this.parts = parts;
    writeFileSync(this.partsFile, JSON.stringify(parts));
    this.clips = recordClips(this.root, this.name, this.svc.bus);
    // The textures' pixels as exported: a later change to them under the same names is noticed (see mapsChanged).
    this.writeLink({ animFp: r.anim_fp ?? null, ...(r.maps_fp ? { mapsFp: r.maps_fp } : {}) });
    const told = freshNotes(r.notes, this.seenNotes);
    this.seenNotes = told.seen;
    return { size: r.size ?? null, notes: told.notes };
  }

  /**
   * Whether the model's textures changed since its last export although Kiln didn't call it a change: a
   * texture retuned under the same names is a change Kiln's own fingerprint may not see (it reads the
   * scene's nodes, not their images' pixels), so Shuriken asks its export for a hash of the pixels
   * (roblox_export.maps_fp, run in Kiln's Blender) and compares it with the one of the last export. The
   * first look just remembers. Only a model whose last export had textured parts is asked (a new texture
   * is a change Kiln does see: a new node), and a slow answer isn't waited for. Best effort: an old Kiln or an
   * error says "no change".
   */
  private async mapsChanged(id: string): Promise<boolean> {
    if (!this.svc.exportDir || !this.parts.some((p) => p.textures)) return false;
    try {
      const r = (await this.svc.kiln.post(`/api/v1/projects/${id}/ext`, { dir: this.svc.exportDir, module: 'roblox_export', func: 'maps_fp', args: {} }, 20_000)) as { ok?: boolean; fp?: string };
      if (!r.ok || !r.fp) return false;
      const known = this.readLink().mapsFp;
      if (!known) {
        this.writeLink({ mapsFp: r.fp });
        return false;
      }
      return known !== r.fp;
    } catch {
      return false;
    }
  }

  async exec(code: string, timeoutMs: number, step?: string): Promise<ExecResult> {
    const t0 = Date.now();
    this.step = step ?? null;
    try {
      return await this.run(async (id) => {
        const r = (await this.svc.kiln.post(`/api/v1/projects/${id}/python`, { code, timeout_s: Math.round(timeoutMs / 1000) }, timeoutMs + 120_000)) as {
          ok: boolean; error: string | null; output: string; added: string[]; removed: string[]; summary: SceneSummary | null; changed: boolean; version: number; issues: Record<string, unknown> | null;
        };
        this.summary = r.summary ?? this.summary;
        this.version = r.version ?? this.version;
        let size: [number, number, number] | null = null;
        let notes: string[] = [];
        // Kiln's own change flag, or a texture retuned under the same names (which that flag may not see).
        const changed = !!r.changed || (r.ok && (await this.mapsChanged(id)));
        if (changed) {
          const published = await this.publish(id);
          size = published.size;
          notes = published.notes;
        }
        return {
          ok: r.ok,
          error: r.error ?? null,
          output: r.output ?? '',
          added: r.added ?? [],
          removed: r.removed ?? [],
          summary: r.summary ?? this.summary,
          issues: toIssues(r.issues),
          changed,
          version: this.version,
          parts: this.parts,
          size,
          ms: Date.now() - t0,
          ...(notes.length ? { notes } : {}),
        };
      });
    } catch (e) {
      return { ok: false, error: `Kiln: ${(e as Error).message}`, output: '', added: [], removed: [], summary: this.summary, issues: null, changed: false, version: this.version, parts: this.parts, size: null, ms: Date.now() - t0 };
    }
  }

  async scene(limit = 300): Promise<ModelingReply> {
    try {
      return await this.run(async (id) => (await this.svc.kiln.get(`/api/v1/projects/${id}/scene?limit=${limit}`)) as ModelingReply);
    } catch (e) {
      return { ok: false, error: `Kiln: ${(e as Error).message}` };
    }
  }

  async render(opts: { views?: string[]; quality?: string; size?: number; focus?: string[]; frames?: number[]; player?: boolean }): Promise<{ ok: boolean; error?: string; file?: string; views?: string[] }> {
    try {
      return await this.run(async (id) => {
        // Kiln's person for scale, at a default Roblox character's 5.2 studs.
        // Through the gate: several agents' renders at once are GPU work Kiln (before 0.8.2) doesn't hold back.
        const r = (await this.svc.gpu.run(() => this.svc.kiln.post(`/api/v1/projects/${id}/render`, { views: opts.views, quality: opts.quality, size: opts.size, focus: opts.focus, frames: opts.frames, figure: !!opts.player, figure_height: 5.2 }, opts.quality === 'pretty' ? 330_000 : 150_000))) as { ok: boolean; error?: string; file?: string; views?: string[] };
        if (!r.ok || !r.file) return { ok: false, error: r.error ?? 'render failed' };
        const dir = join(this.root, '.shuriken', 'evidence');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `kiln-${this.name}-${Date.now().toString(36)}.png`);
        copyFileSync(r.file, file);
        return { ok: true, file, views: r.views };
      });
    } catch (e) {
      return { ok: false, error: `Kiln: ${(e as Error).message}` };
    }
  }

  async check(fix: boolean): Promise<ModelingReply> {
    try {
      return await this.run(async (id) => {
        const before = this.version;
        const r = (await this.svc.kiln.post(`/api/v1/projects/${id}/check`, { fix }, 180_000)) as ModelingReply & { moved?: unknown[] };
        const st = (await this.svc.kiln.get(`/api/v1/projects/${id}/file`)) as { version?: number };
        if ((st.version ?? before) !== before) await this.publish(id);
        return { ...r, ...(toIssues(r as unknown as Record<string, unknown>) ?? {}) };
      });
    } catch (e) {
      return { ok: false, error: `Kiln: ${(e as Error).message}` };
    }
  }

  async undo(): Promise<boolean> {
    try {
      return await this.run(async (id) => {
        const r = (await this.svc.kiln.post(`/api/v1/projects/${id}/undo`)) as { ok?: boolean };
        if (!r.ok) return false;
        await this.publish(id);
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * A project the user made in Kiln becomes this model: imported into this model's own studs project
   * (scaled from Kiln's meters), so agents can keep editing it here, then published as Roblox parts.
   * `sourceId` null: the project already is this model's (a linked one): just published.
   */
  async importFrom(source: { id: string; scene: string; units: string | null } | null): Promise<{ ok: boolean; error?: string; parts?: number; clips?: ClipImport }> {
    try {
      return await this.run(async (id) => {
        const k = this.svc.kiln;
        if (source && source.id !== id) {
          const r = (await k.post(`/api/v1/projects/${id}/import`, { path: source.scene }, 120_000)) as { ok?: boolean; error?: string };
          if (!r.ok) return { ok: false, error: `Kiln couldn't copy that model: ${r.error ?? 'import failed'}` };
          if (source.units !== 'studs') {
            // Kiln's own projects are in meters; Roblox parts are made 1 unit = 1 stud (0.28 m).
            const s = (await k.post(`/api/v1/projects/${id}/python`, { code: METERS_TO_STUDS, timeout_s: 60 }, 180_000)) as { ok?: boolean; error?: string | null };
            if (!s.ok) return { ok: false, error: `Scaling to studs failed: ${s.error ?? 'error'}` };
          }
        }
        await this.publish(id);
        return this.parts.length ? { ok: true, parts: this.parts.length, clips: this.clips ?? undefined } : { ok: false, error: 'The model has no visible geometry to turn into Roblox parts' };
      });
    } catch (e) {
      return { ok: false, error: `Kiln: ${(e as Error).message}` };
    }
  }

  /**
   * The user animated this model in Kiln: bring its rig and clips in (only those, unless its joints
   * changed, which needs the parts too). Skipped while an agent works on the model here.
   */
  async refreshClips(projectId: string): Promise<ClipImport | null> {
    if (this.busy || !this.svc.exportDir) return null;
    this.busy++;
    this.step = 'Bringing in clips from Kiln';
    this.svc.changed();
    try {
      this.projectId ??= projectId;
      const before = new ModelStore(this.root).rig(this.name)?.joints.map((j) => j.name).join(',') ?? '';
      const r = (await this.svc.kiln.post(`/api/v1/projects/${projectId}/ext`, { dir: this.svc.exportDir, module: 'roblox_export', func: 'export_rig_clips', args: { dir: join(this.root, 'models'), name: this.name } }, 120_000)) as { ok?: boolean; error?: string; rig?: { joints: string[] } | null; anim_fp?: string | null };
      if (!r.ok) {
        this.svc.log.warn(`Bringing ${this.name}'s clips in from Kiln failed`, r.error);
        return null;
      }
      if ((r.rig?.joints ?? []).join(',') !== before) {
        await this.publish(projectId);
        return this.clips;
      }
      this.clips = recordClips(this.root, this.name, this.svc.bus);
      this.writeLink({ animFp: r.anim_fp ?? null });
      return this.clips;
    } finally {
      this.busy--;
      this.step = null;
      this.lastUsed = Date.now();
      this.svc.changed();
    }
  }

  async republish(): Promise<void> {
    await this.run((id) => this.publish(id));
  }

  /** This model's Kiln project id (made, linked and seeded from its .blend when it has none yet). */
  ensureProject(): Promise<string> {
    return this.project();
  }

  /** Makes an existing linked Kiln project this model's (it was built for it). */
  adopt(projectId: string, family?: string): void {
    this.projectId = projectId;
    this.writeLink({ projectId, blendMtime: mtime(this.blend), ...(family ? { family } : {}) });
  }

  /** Lets Kiln close this model's project (its Blender) now; it reopens on the next step. */
  async release(): Promise<void> {
    if (!this.projectId || this.busy) return;
    await this.svc.kiln.post(`/api/v1/projects/${this.projectId}/lock`, { by: 'Shuriken Studio', seconds: 0 }, 5000).catch(() => undefined);
    await this.svc.kiln.post(`/api/v1/projects/${this.projectId}/close`, {}, 10_000).catch(() => undefined);
    this.lastUsed = 0;
  }

  async unlock(): Promise<void> {
    if (!this.projectId) return;
    await this.svc.kiln.post(`/api/v1/projects/${this.projectId}/lock`, { by: 'Shuriken Studio', seconds: 0 }, 5000).catch(() => undefined);
  }

  info(): WorkspaceInfo {
    return {
      project: this.root,
      name: this.name,
      by: this.by,
      state: this.busy ? 'working' : 'idle',
      step: this.step,
      version: this.version,
      tris: this.summary?.tris ?? 0,
      parts: this.parts.length,
      lastUsed: new Date(this.lastUsed).toISOString(),
      kilnProject: this.projectId,
    };
  }
}

/** The chat's one line about models that Kiln isn't building. */
export function fallbackLine(models: string[], why: string): string {
  const names = models.length > 8 ? `${models.slice(0, 8).join(', ')} and ${models.length - 8} more` : models.join(', ');
  return `Kiln isn't building ${names} (${why.replace(/[.\s]+$/, '')}): the 3D modeler is building ${models.length === 1 ? 'it' : 'them'} in Shuriken's own Blender instead.`;
}

/** Kiln's own projects are in meters: top-level objects scale by 1/0.28 (children, rig joints and bound segments follow). */
const METERS_TO_STUDS = `s = 1 / 0.28
for o in bpy.context.scene.objects:
    if o.parent is None:
        o.location *= s
        o.scale *= s`;

/** A Kiln project title as a model name (letters, digits and _; starting with a letter): "Stone lantern" → StoneLantern. */
export function modelNameFrom(title: string): string {
  const words = title.normalize('NFKD').replace(/[^A-Za-z0-9 _-]/g, ' ').split(/[\s_-]+/).filter(Boolean);
  let name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('').slice(0, 40);
  if (!/^[A-Za-z]/.test(name)) name = `Model${name}`;
  return name || 'KilnModel';
}

/** Kiln's check report in the shape Shuriken's tools read (studs instead of Kiln's meters labels). */
function toIssues(i: Record<string, unknown> | null | undefined): SceneIssues | null {
  if (!i) return null;
  const floating = (i.floating as Array<{ object: string; gap_below_m?: number; gap_below?: number }> | undefined) ?? [];
  const below = (i.below_ground as Array<{ object: string; top_z?: number; lowest_z?: number }> | undefined) ?? [];
  const moved = (i.moved as Array<{ object: string; by_mm?: number; by_studs?: number }> | undefined) ?? undefined;
  return {
    zfight: (i.zfight as SceneIssues['zfight']) ?? [],
    zfight_pairs: Number(i.zfight_pairs ?? 0),
    floating: floating.map((f) => ({ object: f.object, gap_below: f.gap_below ?? f.gap_below_m ?? 0 })),
    below_ground: below.map((b) => ({ object: b.object, lowest_z: b.lowest_z ?? b.top_z ?? 0 })),
    ...(moved ? { moved: moved.map((m) => ({ object: m.object, by_studs: m.by_studs ?? (m.by_mm ?? 0) / 1000 })) } : {}),
    ...(typeof i.faces_checked === 'number' ? { faces_checked: i.faces_checked } : {}),
  };
}

/**
 * Models in Kiln when it runs (and the setting allows it), in Shuriken's own Blender otherwise. A model
 * already open in one engine stays there while that engine is available; if Kiln goes away, its models
 * continue in the fallback from their saved .blend.
 */
export class KilnModeling implements ModelingBackend {
  readonly kiln: KilnClient;
  /** Kiln builds (kiln_request) waiting and running, first in first out (kiln-queue.ts). */
  readonly builds: KilnBuildQueue;
  /**
   * Shuriken's own GPU work through Kiln (the Roblox bake, renders): two at a time against a Kiln that
   * doesn't gate GPU work itself (before 0.8.2), where a burst of them can freeze the PC.
   */
  readonly gpu: Gate;
  private readonly bakeMs = new Map<string, number>();
  private readonly launcher: KilnLauncher | null;
  private readonly workspaces = new Map<string, KilnWorkspace>();
  private readonly timer: NodeJS.Timeout;
  private pendingEvent: NodeJS.Timeout | null = null;

  constructor(
    private readonly fallback: ModelingBackend,
    private readonly opts: {
      enabled: () => boolean;
      resourcesDir: string | null;
      runtimeFile?: () => string;
      /** The place's Lighting from Studio (null when Studio isn't connected or can't be read). */
      lighting?: () => Promise<KilnLighting | null>;
      /** How long a bake waits for Kiln's copilot to finish (409), in ms (tests shorten it). */
      bakeWaitMs?: number;
      /** Starting Kiln when a build needs a model and it isn't running (absent: never started, e.g. tests). */
      launch?: { configured: () => string; allowed: () => boolean; spawn?: (exe: string) => void; timeoutMs?: number; pollMs?: number };
      /** A short status line in the project's chat (`id`: the line to rewrite instead of adding one); returns the line's id. */
      note?: (text: string, id?: string | null) => string | null;
      /** `kilnBuildsAtOnce` from Settings: how many Kiln builds run at once (the rest queue). */
      buildsAtOnce?: () => number;
      /** What was read back from Kiln's builds changed (sizes and sockets per model): written into the game's spec and code. */
      onSockets?: (root: string, families: FamilyRecord[]) => void;
    },
    readonly bus: EventBus,
    readonly log: ScopedLogger,
  ) {
    this.kiln = new KilnClient(opts.runtimeFile);
    this.gpu = new Gate(() => (this.kiln.supports(KILN_GPU_GATE_VERSION) ? 64 : KILN_GPU_JOBS_UNGATED));
    this.builds = new KilnBuildQueue({
      setting: () => opts.buildsAtOnce?.() ?? KILN_BUILDS_DEFAULT,
      kilnVersion: () => (this.kiln.health.ok ? this.kiln.health.version : null),
      onChange: () => this.buildsChanged(),
      say: (line) => void opts.note?.(line),
    });
    this.launcher = opts.launch
      ? new KilnLauncher({ runtimeFile: opts.runtimeFile ?? kilnRuntimeFile, check: () => this.kiln.check(true), log: (m) => this.log.info(m), ...opts.launch })
      : null;
    // Keep the health fresh for status() (which is synchronous) without blocking anyone.
    void this.kiln.check(true);
    this.timer = setInterval(() => void this.kiln.check(true).then(() => this.watchLoad()), 15_000);
    this.timer.unref();
  }

  /** Where Shuriken's Roblox export module lives (loaded into Kiln's Blender). */
  get exportDir(): string | null {
    const d = this.opts.resourcesDir ? join(this.opts.resourcesDir, 'blender') : null;
    return d && existsSync(join(d, 'roblox_export.py')) ? d : null;
  }

  private get useKiln(): boolean {
    return this.opts.enabled() && this.kiln.health.ok && !!this.exportDir;
  }

  status(): { ready: boolean; exe: string | null; version: string | null; max: number; running: number; detail: string } {
    const own = this.fallback.status();
    if (!this.useKiln) {
      const why = !this.opts.enabled() ? '' : this.kiln.health.ok ? ' (Kiln is running, but the Roblox export module is missing)' : '';
      return { ...own, detail: `${own.detail}${why}` };
    }
    const running = [...this.workspaces.values()].filter((w) => w.busy).length;
    return {
      ready: true,
      exe: this.kiln.health.blender,
      version: own.version,
      max: own.max,
      running,
      detail: `in the Kiln app (${this.kiln.health.version ?? 'Kiln'}): each model is a Kiln project the user can watch live, exported to Roblox parts after every change`,
    };
  }

  private key(root: string, name: string): string {
    return `${root.toLowerCase()}|${name}`;
  }

  workspace(root: string, name: string, who: { runId: string | null; role: string | null }): ModelingWorkspace {
    const k = this.key(root, name);
    let ws = this.workspaces.get(k);
    if (!this.useKiln) {
      // Kiln isn't there (any more): the model carries on in Shuriken's own Blender from its .blend.
      if (ws) this.workspaces.delete(k);
      return this.fallback.workspace(root, name, who);
    }
    if (!ws) {
      ws = new KilnWorkspace(root, name, this);
      this.workspaces.set(k, ws);
    }
    if (who.runId && ws.owner && ws.owner !== who.runId && Date.now() - ws.lastUsed < OWNER_GRACE_MS) {
      throw new Error(`${name} is being modeled by ${ws.by ?? 'another agent'} right now. Give yours a different name (or wait until they finish).`);
    }
    if (who.runId) {
      ws.owner = who.runId;
      ws.by = who.role;
    }
    return ws;
  }

  list(root?: string): WorkspaceInfo[] {
    const mine = [...this.workspaces.values()]
      .filter((w) => !root || w.root.toLowerCase() === root.toLowerCase())
      .filter((w) => w.busy || Date.now() - w.lastUsed < OWNER_GRACE_MS)
      .map((w) => w.info());
    const names = new Set(mine.map((w) => w.name));
    return [...mine, ...this.fallback.list(root).filter((w) => !names.has(w.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The place's Lighting, or null: never throws, a place that can't be read is no reason to fail a request. */
  async readLighting(): Promise<KilnLighting | null> {
    try {
      return (await this.opts.lighting?.()) ?? null;
    } catch {
      return null;
    }
  }

  /** What was last sent as each Kiln project's Roblox target ("-" for no lighting), in memory; the model's link file keeps it across runs. */
  private readonly targetSent = new Map<string, string>();

  noteTargetSent(projectId: string, lighting: KilnLighting | null, root?: string, model?: string | null): void {
    const fp = lighting ? lightingHash(lighting) : '-';
    this.targetSent.set(projectId, fp);
    if (root && model) this.kilnWorkspace(root, model).setTargetFp(`${projectId}|${fp}`);
  }

  private targetFpOf(projectId: string, root?: string, model?: string | null): string | undefined {
    const mem = this.targetSent.get(projectId);
    if (mem !== undefined) return mem;
    const saved = root && model ? this.kilnWorkspace(root, model).targetFp : null;
    return saved?.startsWith(`${projectId}|`) ? saved.slice(projectId.length + 1) : undefined;
  }

  /**
   * Tells a Kiln 0.7.3 project that it is built for Roblox and what the place's lighting is
   * (POST /projects/:id/target; the project isn't opened). Sent once, and again only when the place's
   * Lighting changed since it was last sent; a lighting that can't be read changes nothing. Best effort: it
   * never fails the caller. Returns whether it sent.
   */
  async syncTarget(root: string, model: string | null, projectId: string): Promise<boolean> {
    if (!this.kiln.supports()) return false;
    try {
      const lighting = await this.readLighting();
      const known = this.targetFpOf(projectId, root, model);
      const fp = lighting ? lightingHash(lighting) : null;
      if (known !== undefined && (fp === null || known === fp)) return false;
      const r = (await this.kiln.post(`/api/v1/projects/${projectId}/target`, { target: 'roblox', ...(lighting ? { lighting } : {}) }, 15_000)) as { error?: string };
      if (r.error) throw new Error(r.error);
      this.noteTargetSent(projectId, lighting, root, model);
      return true;
    } catch (e) {
      this.log.warn('Telling Kiln the Roblox target failed', (e as Error).message);
      return false;
    }
  }

  /** Kiln doesn't answer, but a request would bring it up: it is starting, or it is installed and Shuriken may start it. */
  get startable(): boolean {
    return !this.kiln.health.ok && !!this.launcher?.startable(false);
  }

  /** Kiln can take a brief: it answers, or Shuriken starts it for the first one. */
  get reachable(): boolean {
    return !kilnStartForbidden() && (this.kiln.health.ok || this.startable);
  }

  /**
   * Kiln answering, for a build that needs a model: as it is, or started in the background when it is
   * installed but not running (a Kiln that is starting is waited for, never started twice).
   */
  async ensureRunning(): Promise<KilnStarted> {
    const h = await this.kiln.check(true);
    if (h.ok) return { ok: true, launched: false };
    if (!this.launcher) return { ok: false, reason: h.detail };
    const r = await this.launcher.ensure();
    if (r.ok && r.launched) {
      this.log.info('Kiln was not running: started it for a model build');
      this.opts.note?.("Kiln wasn't running, so I started it in the background to build the models.");
    }
    return r;
  }

  /** Models built by hand in Blender because Kiln couldn't be reached or couldn't build them: by project, then by reason (one chat line each). */
  private readonly fallbacks = new Map<string, Map<string, { names: string[]; noteId: string | null }>>();

  /**
   * Hand-modeling `model` is the fallback now (Kiln can't be reached, or failed on it): blender_python
   * takes it, and the chat says so in one plain line (one line per reason, which grows with the models).
   */
  fallbackTo(root: string, model: string, why: string): void {
    if (this.isFallback(root, model)) return;
    const k = root.toLowerCase();
    const reasons = this.fallbacks.get(k) ?? new Map<string, { names: string[]; noteId: string | null }>();
    this.fallbacks.set(k, reasons);
    const f = reasons.get(why) ?? { names: [], noteId: null };
    reasons.set(why, f);
    f.names.push(model);
    this.log.warn(`Kiln is not building ${model}: ${why}`);
    f.noteId = this.opts.note?.(fallbackLine(f.names, why), f.noteId) ?? f.noteId;
  }

  private isFallback(root: string, model: string): boolean {
    return [...(this.fallbacks.get(root.toLowerCase())?.values() ?? [])].some((f) => f.names.includes(model));
  }

  /**
   * Kiln first: why an agent's blender_python on `model` is refused (Kiln can be reached, and the
   * model is a new one that Kiln should build), or null when Blender may take it: Kiln can't be reached
   * (then the chat is told, see fallbackTo), Kiln failed on it, or the model already lives in Shuriken's
   * own Blender (a hand-built model of an older build keeps being edited there).
   */
  kilnFirst(root: string, model: string): string | null {
    if (kilnStartForbidden() || this.isFallback(root, model)) return null;
    if (this.linkedProject(root, model) || existsSync(join(root, 'models', `${model}.blend`))) return null;
    if (!this.reachable) {
      // No Kiln on this PC at all is not an outage to report with every model.
      if (this.launcher?.installed) this.fallbackTo(root, model, this.launcher.whyNot() ?? this.kiln.health.detail);
      return null;
    }
    return `Kiln builds this game's models, and it ${this.kiln.health.ok ? 'is running' : 'starts with the first request'}: ask it for ${model} with kiln_request {model: "${model}", kind: "new", text: what it is, what it is for in the game, how it is seen, and the must-haves the code depends on}, never the method. blender_python is the fallback for when Kiln can't be reached or fails on a model (kiln_request says so, and opens blender_python for that model).`;
  }

  /** Whether this model lives in a Kiln project that Kiln (0.7.3) owns: its changes are asked for with kiln_request, not made by Shuriken. */
  kilnOwns(root: string, model: string): boolean {
    return this.kiln.supports() && !!this.linkedProject(root, model);
  }

  /** Whether the app setting lets Shuriken's modeler work inside Kiln's Blender (off by default). */
  get modelsInKiln(): boolean {
    return this.opts.enabled();
  }

  /**
   * Kiln's baked Roblox export of a project (POST /roblox: one atlas per material; an export of the current
   * scene version is reused) run through Shuriken's exporter (roblox_export.py) in Shuriken's own Blender on
   * a copy of its roblox.blend, so nothing is modeled or exported inside the project's live Blender. A 409
   * (its copilot is working) is waited out for a while.
   */
  async exportBaked(projectId: string, root: string, name: string): Promise<{ ok: boolean; error?: string; reply?: Record<string, unknown>; cached?: boolean; manifest?: Record<string, unknown> }> {
    const run = this.fallback.exportBaked;
    if (!run) return { ok: false, error: "Shuriken's own Blender isn't available to run the export" };
    const baked = await this.bake(projectId);
    if (!baked.ok) return { ok: false, error: baked.error };
    const reply = await run.call(this.fallback, baked.blend, join(root, 'models'), name);
    return reply.ok ? { ok: true, reply, cached: baked.cached, manifest: baked.manifest } : { ok: false, error: String(reply.error ?? 'the export failed') };
  }

  /**
   * Kiln's bake of a project's Roblox copy (POST /roblox): the manifest and the baked .blend. A 409 (its
   * copilot is working) is waited out for a while.
   */
  bake(projectId: string): Promise<{ ok: true; blend: string; manifest: Record<string, unknown>; cached: boolean } | { ok: false; error: string }> {
    return this.gpu.run(async () => {
      const t0 = Date.now();
      const r = await this.bakeNow(projectId);
      // How long Kiln's GPU took: the queue reads it as a sign of load (a cached bake says nothing).
      if (r.ok && !r.cached) this.bakeMs.set(projectId, Date.now() - t0);
      else this.bakeMs.delete(projectId);
      return r;
    });
  }

  /** How long the last bake of a project took (ms), when it really baked. */
  lastBakeMs(projectId: string): number | undefined {
    return this.bakeMs.get(projectId);
  }

  private async bakeNow(projectId: string): Promise<{ ok: true; blend: string; manifest: Record<string, unknown>; cached: boolean } | { ok: false; error: string }> {
    const deadline = Date.now() + (this.opts.bakeWaitMs ?? 3 * 60_000);
    let baked: { ok?: boolean; error?: string; cached?: boolean; manifest?: { blend?: string } & Record<string, unknown> };
    for (;;) {
      try {
        baked = (await this.kiln.post(`/api/v1/projects/${projectId}/roblox`, {}, 20 * 60_000)) as typeof baked;
        break;
      } catch (e) {
        if (e instanceof KilnHttpError && e.status === 409 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(2_500, Math.max(50, (this.opts.bakeWaitMs ?? 3 * 60_000) / 10))));
          continue;
        }
        return { ok: false, error: (e as Error).message };
      }
    }
    const blend = baked.manifest?.blend;
    if (!baked.ok || !blend) return { ok: false, error: baked.error ?? 'Kiln gave no baked file' };
    if (!existsSync(blend)) return { ok: false, error: `Kiln's baked file isn't there (${blend})` };
    return { ok: true, blend, manifest: baked.manifest as Record<string, unknown>, cached: !!baked.cached };
  }

  /**
   * Kiln 0.8.2 lets 3 renders or bakes run at once and makes the rest wait: while several builds run, its
   * load (GET /api/v1/load) tells the queue whether they are queuing for the graphics card.
   */
  async watchLoad(): Promise<void> {
    if (this.builds.running <= 1 || !this.kiln.supports(KILN_GPU_GATE_VERSION)) return;
    const load = (await this.kiln.get('/api/v1/load', 5000).catch(() => null)) as { gpu?: { waiting?: number; waitedMs?: number } } | null;
    if (load?.gpu) this.builds.observeLoad({ waiting: Number(load.gpu.waiting) || 0, waitedMs: Number(load.gpu.waitedMs) || 0 });
  }

  /** The id of this game's style sheet in Kiln, and whether Kiln has the sheet yet (0.8.2; the first build's copilot proposes and saves it). */
  async styleSheet(root: string): Promise<{ id: string; sheet: StyleSheet | null }> {
    const id = styleId(root);
    if (!this.kiln.supports(KILN_GPU_GATE_VERSION)) return { id, sheet: readStyleSheet(root) };
    try {
      const sheet = (await this.kiln.get(`/api/v1/styles/${encodeURIComponent(id)}`, 8000)) as StyleSheet & { error?: string };
      if (sheet && typeof sheet.id === 'string' && !sheet.error) {
        // The project keeps a copy, so agents and the UI designer see the palette and the materials (the spec section).
        if (writeStyleSheet(root, sheet)) this.socketsChanged(root);
        return { id, sheet };
      }
    } catch {
      /* 404 until a build has saved it */
    }
    return { id, sheet: null };
  }

  /** Told when what was read back from Kiln changed (core writes the game's spec section and the sockets module). */
  private socketsChanged(root: string): void {
    try {
      this.opts.onSockets?.(root, listFamilies(root));
    } catch (e) {
      this.log.warn("Writing the models' sockets into the spec failed", (e as Error).message);
    }
  }

  /**
   * A single model that was asked for with sockets (a family of one): its sockets from the manifest's
   * markers, or from its rig's attach points, into its record.
   */
  readBackSingle(root: string, model: string, manifest: Record<string, unknown> | null, r: { parts?: ExportedPart[]; size?: [number, number, number] }): void {
    const rec = familyOfModel(root, model);
    if (!rec || rec.family !== model) return;
    const parsed = manifest ? parseManifest(manifest, typeof manifest.blend === 'string' ? dirname(manifest.blend) : null).manifest : null;
    const box: MemberBox = { origin: [0, 0, 0], lo: [0, 0, 0], hi: [0, 0, 0] };
    const k = parsed?.studsPerUnit ?? 1;
    // Kiln 0.8.2 lists the project's models with their sockets (in each model's own space); the whole scene was exported about the scene's origin.
    const kmodels = parsed?.models ?? [];
    const own = kmodels.find((m) => m.name === model) ?? (kmodels.length === 1 ? kmodels[0]! : null);
    const sockets = own ? modelSockets(own, k, own.origin) : {};
    // The project is this one model: a socket Kiln lists under another entry of it (the part that carries it:
    // "Handle.Grip" on a sword) is this model's socket too. Reading only the entry named like the model lost every
    // weapon's Grip in two builds: Kiln's check said "all present: Grip", the record said none, and model_gear failed.
    for (const km of kmodels) if (km !== own) for (const [name, s] of Object.entries(modelSockets(km, k, km.origin))) sockets[name] ??= s;
    const marked = readSockets((parsed?.markers ?? []) as MarkerIn[], { [model]: box }, rec.sockets.map((s) => s.name), k)[model] ?? {};
    for (const [name, s] of Object.entries(marked)) sockets[name] ??= s;
    for (const a of new ModelStore(root).rig(model)?.attachments ?? []) sockets[a.name] ??= { position: a.position, rotation: [0, 0, 0], from: 'rig' };
    const parts = r.parts ?? [];
    const fit = parsed?.fit ?? null;
    rec.read = {
      at: new Date().toISOString(),
      members: { [model]: { size: r.size ?? [0, 0, 0], tris: parts.reduce((t, p) => t + p.triangles, 0), parts: parts.length, sockets, ...(own ? { originAt: own.originAt, ...(own.groundGap !== null ? { groundGap: own.groundGap * k } : {}) } : {}) } },
      missing: [],
      ...(fit ? { fit } : {}),
      ...(this.pendingChecks.has(rec.projectId) ? { checks: this.pendingChecks.get(rec.projectId)! } : {}),
    };
    this.pendingChecks.delete(rec.projectId);
    writeFamily(root, rec);
    this.socketsChanged(root);
  }

  /**
   * A family's Kiln project into the game: Kiln bakes the scene once, each member is exported from a copy
   * that holds only its objects (its own model, pivot at the bottom centre of its box), and the sockets
   * are read back into each member's own space. A member that isn't its own object in the scene is
   * reported, never guessed.
   */
  /** The brief's requirements as Kiln checked them at the end of a turn, kept for the import that follows (by Kiln project). */
  private readonly pendingChecks = new Map<string, KilnCheckResult[]>();

  /** What a turn delivered beyond the scene, for the import of its project that comes next. */
  noteDelivery(projectId: string, facts: DeliveryFacts | null | undefined): void {
    const checks = parseChecks(facts?.checks);
    if (checks.length) this.pendingChecks.set(projectId, checks);
    else this.pendingChecks.delete(projectId);
  }

  async importFamily(root: string, rec: FamilyRecord): Promise<{ ok: boolean; error?: string; parts?: number; family?: FamilyImport }> {
    const run = this.fallback.exportBaked;
    if (!run) return { ok: false, error: "Shuriken's own Blender isn't available to run the export" };
    const baked = await this.bake(rec.projectId);
    if (!baked.ok) return { ok: false, error: `Kiln's baked Roblox export of ${rec.family} wasn't available (${baked.error})` };
    const { manifest } = parseManifest(baked.manifest, dirname(baked.blend));
    const names = rec.members.map((m) => m.name);
    const boxes: Record<string, MemberBox> = {};
    const read: Record<string, MemberRead> = {};
    const missing: string[] = [];
    const markers = new Map<string, MarkerIn>(manifest.markers.map((m) => [m.name, m as MarkerIn]));
    // Kiln 0.8.2 names each model's meshes and its origin itself: the model is exported about that origin.
    const kmodels = new Map(manifest.models.map((m) => [m.name, m]));
    let total = 0;
    for (const name of names) {
      const own = kmodels.get(name);
      const reply = (await run.call(this.fallback, baked.blend, join(root, 'models'), name, memberPrepare(name, names, own?.objects.length ? { objects: own.objects, origin: own.origin } : undefined))) as { ok: boolean; error?: string | null; prepared?: string; parts?: ExportedPart[]; size?: [number, number, number] };
      const prep = parsePrepared(reply.prepared);
      if (prep?.rigged) return { ok: false, error: `${rec.family} has a rig in Kiln: a rigged model is its own Kiln project (ask for it with kiln_request {model}), a family holds rigid parts.` };
      if (!reply.ok || !prep?.found || !prep.origin) {
        missing.push(name);
        this.log.warn(`${name} of ${rec.family} wasn't exported`, reply.error ?? 'not found in the baked scene');
        continue;
      }
      // The scene's own markers say which member they hang on (their parent or collection); the manifest gives the rest.
      for (const mk of prep.markers ?? []) if (mk.matrix?.length >= 3) markers.set(mk.name, { name: mk.name, role: String(mk.role).toLowerCase(), matrix: mk.matrix as Mat4, member: mk.member });
      const ws = this.kilnWorkspace(root, name);
      ws.adopt(rec.projectId, rec.family);
      ws.recordExport(reply);
      const parts = reply.parts ?? [];
      total += parts.length;
      boxes[name] = { origin: prep.origin, lo: prep.lo ?? prep.origin, hi: prep.hi ?? prep.origin };
      read[name] = {
        size: reply.size ?? [0, 0, 0],
        tris: parts.reduce((t, p) => t + p.triangles, 0),
        parts: parts.length,
        sockets: own ? modelSockets(own, manifest.studsPerUnit) : {},
        ...(own ? { originAt: own.originAt, ...(own.groundGap !== null ? { groundGap: own.groundGap * manifest.studsPerUnit } : {}) } : {}),
      };
    }
    // Kiln before 0.8.2 has no socket list: markers with role "socket" are the sockets (and fill in whatever a model's own list lacks).
    const marked = readSockets([...markers.values()], boxes, rec.sockets.map((s) => s.name), manifest.studsPerUnit);
    for (const [name, found] of Object.entries(marked)) for (const [socket, s] of Object.entries(found)) if (read[name]) read[name].sockets[socket] ??= s;
    const fit = manifest.fit;
    const checks = this.pendingChecks.get(rec.projectId);
    this.pendingChecks.delete(rec.projectId);
    rec.read = { at: new Date().toISOString(), members: read, missing, ...(fit ? { fit } : {}), ...(checks ? { checks } : {}) };
    writeFamily(root, rec);
    this.socketsChanged(root);
    // The family's scene comes home too, so a lost Kiln project can be seeded from it again.
    try {
      const f = (await this.kiln.get(`/api/v1/projects/${rec.projectId}/file`)) as { scene?: string };
      if (f.scene && existsSync(f.scene)) {
        mkdirSync(join(root, 'models'), { recursive: true });
        copyFileSync(f.scene, join(root, 'models', `${rec.family}.blend`));
      }
    } catch {
      /* the models are in; the scene stays in Kiln */
    }
    const info: FamilyImport = { family: rec.family, models: read, missing, spread: Object.fromEntries(rec.sockets.map((s) => [s.name, socketSpread(read, s.name)])), problems: familyProblems(rec), ...(fit ? { fit } : {}), ...(checks ? { checks } : {}) };
    if (!total) return { ok: false, error: `None of ${names.join(', ')} is its own top-level object in Kiln's scene of ${rec.family}`, family: info };
    return { ok: true, parts: total, family: info };
  }

  /** The Kiln project of one of this project's models (made, linked and seeded from its .blend when it has none). */
  async projectFor(root: string, model: string): Promise<string> {
    await this.kiln.check(true);
    if (!this.kiln.health.ok) throw new Error(`Kiln isn't reachable (${this.kiln.health.detail})`);
    return this.kilnWorkspace(root, model).ensureProject();
  }

  /**
   * Keeps a project's Kiln-linked models' clips current while the user animates them in Kiln: for each
   * linked model whose Kiln project is open (and its copilot idle), a changed animation fingerprint
   * brings the rig and clips in. Reads Kiln's /anim (from memory: it never opens a project, never
   * calls Blender and doesn't keep a project alive). Returns the models refreshed.
   */
  async syncClips(root: string): Promise<string[]> {
    if (!this.exportDir || !(await this.kiln.check()).ok) return [];
    const dir = join(root, '.shuriken', 'kiln');
    if (!existsSync(dir)) return [];
    const families = new Set(listFamilies(root).filter((f) => f.members.length > 1).map((f) => f.projectId));
    const links = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.slice(0, -5), this.linkedProject(root, f.slice(0, -5))] as const)
      .filter((x): x is readonly [string, string] => !!x[1])
      // A family's project holds rigid parts: nothing to animate, and its members share one project.
      .filter(([, id]) => !families.has(id));
    if (!links.length) return [];
    const refreshed: string[] = [];
    for (const [model, id] of links) {
      const a = (await this.kiln.get(`/api/v1/projects/${id}/anim`, 5000).catch(() => null)) as { open?: boolean; working?: boolean; anim?: string | null } | null;
      if (!a?.open || a.working || !a.anim) continue;
      const ws = this.kilnWorkspace(root, model);
      if (ws.busy || (ws.owner && Date.now() - ws.lastUsed < OWNER_GRACE_MS)) continue;
      if (a.anim === ws.animFp) continue;
      if (await ws.refreshClips(id)) refreshed.push(model);
    }
    return refreshed;
  }

  /** The Kiln project a model is linked to, if any (.shuriken/kiln/<Model>.json). */
  linkedProject(root: string, model: string): string | null {
    try {
      return (JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', `${model}.json`), 'utf8')) as { projectId?: string }).projectId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A model the game no longer has (a variant that lost, a model that was replaced): its Kiln project of its own goes
   * to Kiln's trash and the link is dropped. A family's project is left alone (its other members live there), and so
   * is a project Kiln has open or is working in (409). Returns what happened, or null when there was nothing to do.
   */
  async discard(root: string, model: string): Promise<string | null> {
    const file = join(root, '.shuriken', 'kiln', `${model}.json`);
    const id = this.linkedProject(root, model);
    if (!id) return null;
    if (familyOfModel(root, model)) return null;
    try {
      rmSync(file, { force: true });
    } catch {
      /* the link stays: harmless */
    }
    if (!this.kiln.health.ok) return `its Kiln project ${id} was left in Kiln (Kiln isn't reachable)`;
    try {
      await this.kiln.post(`/api/v1/projects/${id}/delete`, {}, 15_000);
      return `its Kiln project ${id} went to Kiln's trash`;
    } catch (e) {
      return `its Kiln project ${id} was left in Kiln (${e instanceof KilnHttpError && e.status === 409 ? 'it is open or being worked on there' : (e as Error).message})`;
    }
  }

  async importFromKiln(root: string, kilnProjectId: string, name: string): Promise<{ ok: boolean; error?: string; name?: string; parts?: number; clips?: ClipImport; family?: FamilyImport }> {
    await this.kiln.check(true);
    if (!this.kiln.health.ok) return { ok: false, error: `Kiln isn't reachable (${this.kiln.health.detail})` };
    if (!this.exportDir) return { ok: false, error: 'The Roblox export module is missing from this Shuriken install' };
    let st: { project?: { title?: string; units?: string; linked?: { model?: string; project?: string } } };
    try {
      st = (await this.kiln.get(`/api/v1/projects/${kilnProjectId}/state`)) as typeof st;
    } catch (e) {
      return { ok: false, error: `Kiln doesn't know that project (${(e as Error).message})` };
    }
    const fam = familyOfProject(root, kilnProjectId);
    if (fam && (fam.members.length > 1 || fam.members[0]?.name !== fam.family)) {
      const r = await this.importFamily(root, fam);
      return { ok: r.ok, error: r.error, name: fam.family, parts: r.parts, family: r.family };
    }
    const linked = st.project?.linked;
    // Already one of this Shuriken project's models (built here, opened in Kiln): publish it as it is.
    if (linked?.model && linked.project && linked.project.toLowerCase() === root.toLowerCase()) {
      const ws = this.adopt(root, linked.model, kilnProjectId);
      const r = await ws.importFrom(null);
      return { ...r, name: linked.model };
    }
    const model = modelNameFrom(name || st.project?.title || 'KilnModel');
    let scene: string | undefined;
    try {
      scene = ((await this.kiln.get(`/api/v1/projects/${kilnProjectId}/file`)) as { scene?: string }).scene;
    } catch (e) {
      return { ok: false, error: `Kiln couldn't hand over the model's file (${(e as Error).message})` };
    }
    if (!scene) return { ok: false, error: 'That Kiln project has no saved scene yet' };
    // Taken in Kiln even with "Model in Kiln" off: the user chose Kiln's "Use in this game".
    const ws = this.kilnWorkspace(root, model);
    if (ws.owner && Date.now() - ws.lastUsed < OWNER_GRACE_MS) return { ok: false, error: `${model} is being modeled by ${ws.by ?? 'an agent'} right now; try again when they finish, or use another name` };
    ws.by = 'you (from Kiln)';
    const r = await ws.importFrom({ id: kilnProjectId, scene, units: st.project?.units ?? null });
    return { ...r, name: model };
  }

  /** A model's Kiln workspace, whatever the settings say (Kiln's own "Use in this game"). */
  private kilnWorkspace(root: string, name: string): KilnWorkspace {
    const k = this.key(root, name);
    let ws = this.workspaces.get(k);
    if (!ws) {
      ws = new KilnWorkspace(root, name, this);
      this.workspaces.set(k, ws);
    }
    return ws;
  }

  /** The workspace of a model whose Kiln project already exists. */
  private adopt(root: string, name: string, projectId: string): KilnWorkspace {
    const ws = this.kilnWorkspace(root, name);
    ws.adopt(projectId);
    return ws;
  }

  releaseRun(runId: string): void {
    for (const ws of this.workspaces.values()) {
      if (ws.owner !== runId) continue;
      ws.owner = null;
      void ws.unlock();
    }
    this.fallback.releaseRun(runId);
  }

  /**
   * Keeps the number of models open in Kiln within Shuriken's "models at once" setting: before a model
   * starts a step, the longest-idle other model's Kiln project is closed when the limit is reached.
   */
  async makeRoom(ws: KilnWorkspace): Promise<void> {
    const max = Math.max(1, this.fallback.status().max);
    for (;;) {
      const open = [...this.workspaces.values()].filter((w) => w !== ws && w.open);
      if (open.length < max || ws.open) return;
      const idle = open.filter((w) => !w.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      await idle.release();
    }
  }

  private pendingBuilds: NodeJS.Timeout | null = null;

  /** The build queue changed: told to the UI a moment later, once. */
  private buildsChanged(): void {
    if (this.pendingBuilds) return;
    this.pendingBuilds = setTimeout(() => {
      this.pendingBuilds = null;
      this.bus.emit('kiln.builds', {});
    }, 200);
    this.pendingBuilds.unref?.();
  }

  changed(): void {
    if (this.pendingEvent) return;
    this.pendingEvent = setTimeout(() => {
      this.pendingEvent = null;
      this.bus.emit('blender.workspaces', {});
    }, 300);
  }

  stop(): void {
    clearInterval(this.timer);
    this.fallback.stop();
  }
}
