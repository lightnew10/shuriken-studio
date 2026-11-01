import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { freshNotes, recordClips, recordParts } from '../modeling/publish';
import type { ExecResult, ExportedPart, ModelingBackend, ModelingWorkspace, SceneIssues, SceneSummary, WorkspaceInfo } from '../modeling/backend';
import { BlenderBridge, findBlender, type BridgeReply } from './bridge';
import type { ClipImport } from '../animation/kiln-clips';

export type { ExecResult, ExportedPart, SceneIssues, SceneSummary, WorkspaceInfo } from '../modeling/backend';

const KEEP_HISTORY = 20;
const IDLE_CLOSE_MS = 5 * 60_000;
/** A model's owner keeps it while their run lasts, or this long after their last change. */
const OWNER_GRACE_MS = 10 * 60_000;
const pad = (n: number) => String(n).padStart(6, '0');

/**
 * One model being worked on in its own headless Blender: models/<Name>.blend is the scene (the source
 * of truth), every change is saved as an undoable version and exported to Roblox MeshParts (one per
 * material) in the project's model store, so the Models page, model_view, uploads and placement see
 * it straight away.
 */
export class ModelWorkspace implements ModelingWorkspace {
  bridge: BlenderBridge | null = null;
  owner: string | null = null;
  by: string | null = null;
  step: string | null = null;
  busy = 0;
  starting = false;
  lastUsed = Date.now();
  version = 0;
  private fingerprint: string | null = null;
  /** Export notes already told for this model (each is listed once, see freshNotes). */
  private seenNotes = new Set<string>();
  summary: SceneSummary | null = null;
  parts: ExportedPart[] = [];
  /** What the last export did with the model's clips (a Kiln-rigged model's animations). */
  clips: ClipImport | null = null;

  constructor(
    readonly root: string,
    readonly name: string,
    private readonly svc: BlenderModeling,
  ) {
    mkdirSync(this.historyDir, { recursive: true });
    const snaps = this.snapshots();
    this.version = snaps.length ? Number(/v(\d+)/.exec(snaps.at(-1)!)?.[1] ?? 0) : 0;
    try {
      this.parts = JSON.parse(readFileSync(this.partsFile, 'utf8')) as ExportedPart[];
    } catch {
      this.parts = [];
    }
  }

  get blend(): string {
    return join(this.root, 'models', `${this.name}.blend`);
  }

  private get dir(): string {
    return join(this.root, '.shuriken', 'blender', this.name);
  }

  private get historyDir(): string {
    return join(this.dir, 'history');
  }

  private get partsFile(): string {
    return join(this.dir, 'parts.json');
  }

  private snapshots(): string[] {
    try {
      return readdirSync(this.historyDir)
        .filter((f) => /^v\d+\.blend$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  get canUndo(): boolean {
    return this.snapshots().length > 1;
  }

  /** Its Blender (from the pool), with the model loaded. */
  private async ready(): Promise<BlenderBridge> {
    if (this.bridge?.alive) return this.bridge;
    this.starting = true;
    this.svc.changed();
    try {
      const b = await this.svc.bridgeFor(this);
      b.restorePath = () => (existsSync(this.blend) ? this.blend : null);
      await b.start();
      // A spare was warmed with an empty scene: load this model into it.
      const r = existsSync(this.blend) ? await b.call('open', { path: this.blend }) : await b.call('scene');
      if (!r.ok) throw new Error(r.error ?? 'Blender could not load the model');
      this.fingerprint = (r.fingerprint as string) ?? null;
      this.summary = (r.summary as SceneSummary) ?? null;
      this.bridge = b;
      return b;
    } finally {
      this.starting = false;
      this.svc.changed();
    }
  }

  private async call(op: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<BridgeReply> {
    this.busy++;
    this.lastUsed = Date.now();
    this.svc.changed();
    try {
      const b = await this.ready();
      return await b.call(op, payload, timeoutMs);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
      this.svc.changed();
    }
  }

  /** Runs Python in the model's scene; a change is saved, versioned and exported to Roblox parts. */
  async exec(code: string, timeoutMs: number, step?: string): Promise<ExecResult> {
    const t0 = Date.now();
    this.step = step ?? null;
    const r = await this.call('exec', { code, check: true, previous: this.fingerprint }, timeoutMs);
    let changed = false;
    let size: [number, number, number] | null = null;
    let notes: string[] = [];
    if (r.fingerprint && r.fingerprint !== this.fingerprint) {
      this.fingerprint = r.fingerprint as string;
      this.summary = (r.summary as SceneSummary) ?? null;
      const saved = await this.commit();
      size = saved.size;
      notes = saved.notes;
      changed = true;
    } else if (r.timedOut) {
      const s = await this.call('scene');
      if (s.ok) {
        this.fingerprint = (s.fingerprint as string) ?? null;
        this.summary = (s.summary as SceneSummary) ?? null;
      }
    }
    return {
      ok: r.ok,
      error: (r.error as string | null) ?? null,
      output: (r.output as string) ?? '',
      added: (r.added as string[]) ?? [],
      removed: (r.removed as string[]) ?? [],
      summary: (r.summary as SceneSummary) ?? this.summary,
      issues: (r.issues as SceneIssues | null) ?? null,
      changed,
      version: this.version,
      parts: this.parts,
      size,
      ms: Date.now() - t0,
      ...(notes.length ? { notes } : {}),
    };
  }

  /** Save + snapshot + export to Roblox parts (the model store) as a new version. */
  private async commit(): Promise<{ size: [number, number, number] | null; notes: string[] }> {
    this.version++;
    mkdirSync(join(this.root, 'models'), { recursive: true });
    const save = await this.call('save', { path: this.blend });
    if (save.ok) {
      copyFileSync(this.blend, join(this.historyDir, `v${pad(this.version)}.blend`));
      for (const old of this.snapshots().slice(0, -KEEP_HISTORY)) rmSync(join(this.historyDir, old), { force: true });
    }
    return this.publish();
  }

  async republish(): Promise<void> {
    await this.publish();
  }

  /** Exports the scene to Roblox MeshParts and records them in the model store (stale parts go). */
  async publish(): Promise<{ size: [number, number, number] | null; notes: string[] }> {
    const r = await this.call('roblox', { dir: join(this.root, 'models'), name: this.name });
    if (!r.ok) {
      this.svc.log.warn(`Exporting ${this.name} for Roblox failed`, r.error);
      return { size: null, notes: [] };
    }
    const parts = (r.parts as ExportedPart[]) ?? [];
    recordParts(this.root, this.name, parts, this.parts, this.svc.bus);
    this.parts = parts;
    writeFileSync(this.partsFile, JSON.stringify(parts));
    this.clips = recordClips(this.root, this.name, this.svc.bus);
    const told = freshNotes(r.notes, this.seenNotes);
    this.seenNotes = told.seen;
    return { size: (r.size as [number, number, number]) ?? null, notes: told.notes };
  }

  scene(limit = 300): Promise<BridgeReply> {
    return this.call('scene', { limit });
  }

  /** Renders (a contact sheet of) views; the file goes into the project's evidence folder. */
  async render(opts: { views?: string[]; quality?: string; size?: number; focus?: string[]; frames?: number[]; player?: boolean }): Promise<{ ok: boolean; error?: string; file?: string; views?: string[] }> {
    const dir = join(this.root, '.shuriken', 'evidence');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `blender-${this.name}-${Date.now().toString(36)}.png`);
    const r = await this.call('render', { path: file, ...opts }, opts.quality === 'pretty' ? 300_000 : 120_000);
    if (!r.ok) return { ok: false, error: r.error ?? 'render failed' };
    return { ok: true, file, views: r.views as string[] };
  }

  /** The full scene check; with fix, clashing parts are nudged apart (a new version). */
  async check(fix: boolean): Promise<BridgeReply> {
    const r = await this.call('check', { fix });
    if (r.ok && r.fingerprint && r.fingerprint !== this.fingerprint) {
      this.fingerprint = r.fingerprint as string;
      this.summary = (r.summary as SceneSummary) ?? null;
      await this.commit();
    }
    return r;
  }

  /** Steps back to the previous version. */
  async undo(): Promise<boolean> {
    const snaps = this.snapshots();
    if (snaps.length < 2) return false;
    const prev = join(this.historyDir, snaps.at(-2)!);
    const r = await this.call('open', { path: prev });
    if (!r.ok) return false;
    rmSync(join(this.historyDir, snaps.at(-1)!), { force: true });
    copyFileSync(prev, this.blend);
    this.fingerprint = (r.fingerprint as string) ?? null;
    this.summary = (r.summary as SceneSummary) ?? null;
    this.version = Number(/v(\d+)/.exec(snaps.at(-2)!)?.[1] ?? this.version);
    await this.publish();
    return true;
  }

  /** Lets its Blender go (the model is saved on disk and reopens on the next call). */
  close(): void {
    this.bridge?.stop();
    this.bridge = null;
    this.svc.changed();
  }

  info(project: string): WorkspaceInfo {
    return {
      project,
      name: this.name,
      by: this.by,
      state: this.starting ? 'starting' : this.busy ? 'working' : this.bridge?.alive ? 'idle' : 'closed',
      step: this.step,
      version: this.version,
      tris: this.summary?.tris ?? 0,
      parts: this.parts.length,
      lastUsed: new Date(this.lastUsed).toISOString(),
    };
  }
}

/**
 * The modeling workspaces: each model an agent works on gets its own headless Blender, so several
 * modelers build at the same time without waiting on each other. At most `max` Blenders run at once
 * (an idle one gives way to a new one; its model is saved and reopens when needed), one spare is kept
 * warm while modeling goes on, and Blenders idle for five minutes close.
 */
export class BlenderModeling implements ModelingBackend {
  private readonly workspaces = new Map<string, ModelWorkspace>();
  private spare: BlenderBridge | null = null;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly opts: { resourcesDir: string | null; configured: () => { path: string; max: number } },
    readonly bus: EventBus,
    readonly log: ScopedLogger,
  ) {
    this.timer = setInterval(() => this.closeIdle(), 60_000);
    this.timer.unref();
  }

  get script(): string | null {
    const s = this.opts.resourcesDir ? join(this.opts.resourcesDir, 'blender', 'bridge.py') : null;
    return s && existsSync(s) ? s : null;
  }

  exe(): string | null {
    return findBlender(this.opts.configured().path || null);
  }

  status(): { ready: boolean; exe: string | null; version: string | null; max: number; running: number; detail: string } {
    const exe = this.exe();
    const running = [...this.workspaces.values()].filter((w) => w.bridge?.alive).length;
    const version = exe ? (/blender-(\d+\.\d+(?:\.\d+)?)/i.exec(exe)?.[1] ?? null) : null;
    return {
      ready: !!exe && !!this.script,
      exe,
      version,
      max: this.max,
      running,
      detail: !exe
        ? 'Blender isn’t installed where Shuriken looks (Desktop\\Blender, Program Files\\Blender Foundation, Steam). Install Blender 4.2 or newer, or set its path in Settings → Agents.'
        : !this.script
          ? 'The Blender bridge script is missing from this install.'
          : `Blender${version ? ` ${version}` : ''} · up to ${this.max} models at once`,
    };
  }

  get max(): number {
    return Math.max(1, Math.min(8, Math.round(this.opts.configured().max || 5)));
  }

  private key(root: string, name: string): string {
    return `${root.toLowerCase()}|${name}`;
  }

  /**
   * The workspace for a model, for an agent (or the UI). A model belongs to the run working on it:
   * another agent gets a clear refusal instead of editing the same scene at the same time.
   */
  workspace(root: string, name: string, who: { runId: string | null; role: string | null }): ModelWorkspace {
    const k = this.key(root, name);
    let ws = this.workspaces.get(k);
    if (!ws) {
      ws = new ModelWorkspace(root, name, this);
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

  /** A run ended: its models are free for others. */
  releaseRun(runId: string): void {
    for (const ws of this.workspaces.values()) if (ws.owner === runId) ws.owner = null;
  }

  /**
   * Shuriken's Roblox export of a finished file that is no model of ours (Kiln's baked roblox.blend): a copy is
   * opened in a Blender of its own (none of the workspaces, nothing is modeled or saved) and exported like any
   * model (the parts, rig and clips go into `dir`).
   */
  async exportBaked(blend: string, dir: string, name: string, prepare?: string): Promise<{ ok: boolean; error?: string | null; [key: string]: unknown }> {
    const exe = this.exe();
    const script = this.script;
    if (!exe || !script) return { ok: false, error: this.status().detail };
    const work = join(tmpdir(), `shuriken-baked-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.blend`);
    const b = new BlenderBridge(exe, script);
    try {
      copyFileSync(blend, work);
      const open = await b.call('open', { path: work }, 180_000);
      if (!open.ok) return { ok: false, error: `Blender couldn't open Kiln's baked file: ${open.error ?? 'error'}` };
      mkdirSync(dir, { recursive: true });
      if (!prepare) return await b.call('roblox', { dir, name }, 300_000);
      // One model of a family: `prepare` keeps only its objects in this copy (kiln-family.ts); nothing is exported when it fails.
      const prep = await b.call('exec', { code: prepare }, 120_000);
      const prepared = String(prep.output ?? '');
      if (!prep.ok) return { ok: false, error: String(prep.error ?? 'preparing the scene failed'), prepared };
      return { ...(await b.call('roblox', { dir, name }, 300_000)), prepared };
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

  /** A Blender for a workspace: the warm spare, or a new one; when `max` already run, an idle one gives way. */
  async bridgeFor(ws: ModelWorkspace): Promise<BlenderBridge> {
    const exe = this.exe();
    const script = this.script;
    if (!exe || !script) throw new Error(this.status().detail);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const alive = [...this.workspaces.values()].filter((w) => w !== ws && (w.bridge?.alive || w.starting));
      if (alive.length < this.max) break;
      const idle = alive.filter((w) => !w.busy && !w.starting).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) {
        idle.close();
        break;
      }
      if (Date.now() > deadline) throw new Error(`All ${this.max} modeling workspaces stayed busy for 5 minutes; try again shortly.`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const b = this.spare?.alive ? this.spare : new BlenderBridge(exe, script);
    this.spare = null;
    // Keep one warm for the next model while modeling goes on.
    this.warmTimer ??= setTimeout(() => {
      this.warmTimer = null;
      this.warm();
    }, 2000);
    this.warmTimer.unref();
    return b;
  }

  private warmTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private warm(): void {
    if (this.stopped) return;
    const exe = this.exe();
    const script = this.script;
    if (!exe || !script || this.spare) return;
    const alive = [...this.workspaces.values()].filter((w) => w.bridge?.alive || w.starting).length;
    if (alive >= this.max) return;
    const b = new BlenderBridge(exe, script);
    this.spare = b;
    b.start().catch(() => {
      if (this.spare === b) this.spare = null;
    });
  }

  list(root?: string): WorkspaceInfo[] {
    return [...this.workspaces.values()]
      .filter((w) => !root || w.root.toLowerCase() === root.toLowerCase())
      .filter((w) => w.bridge?.alive || w.starting || w.busy || Date.now() - w.lastUsed < OWNER_GRACE_MS)
      .map((w) => w.info(w.root))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Tells the UI the workspaces changed (throttled to one event per 300 ms). */
  private pendingEvent: NodeJS.Timeout | null = null;
  changed(): void {
    if (this.pendingEvent) return;
    this.pendingEvent = setTimeout(() => {
      this.pendingEvent = null;
      this.bus.emit('blender.workspaces', {});
    }, 300);
  }

  private closeIdle(): void {
    const now = Date.now();
    for (const ws of this.workspaces.values()) if (ws.bridge?.alive && !ws.busy && now - ws.lastUsed > IDLE_CLOSE_MS) ws.close();
    const anyAlive = [...this.workspaces.values()].some((w) => w.bridge?.alive);
    if (!anyAlive && this.spare) {
      this.spare.stop();
      this.spare = null;
    }
  }

  stop(): void {
    // Nothing may start a Blender (or read settings) after the app has shut its database.
    this.stopped = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    clearInterval(this.timer);
    for (const ws of this.workspaces.values()) ws.close();
    this.spare?.stop();
    this.spare = null;
  }
}
