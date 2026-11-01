/// <reference types="electron-vite/node" />
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { MOCK_DEVICES, currentVersion, fromCapture, mockupName, type MockColor, type MockMotion, type MockNode } from '@shared/ui-mockup';
import { UI_DEVICES, type UiDevice, type UiNode } from '@shared/ui-layout';
import { normalizeAccent, previewScales, isForgeDevice, type ForgeDirectionInfo, type ForgeGenreInfo, type ForgeMade, type ForgeMakeParams, type ForgeMockupParams, type ForgePreview, type ForgePreviewParams, type ForgeSheet, type ForgeSheetItem, type ForgeStatus, type ForgeTemplateInfo, type ForgeWorn, type ForgeWornParams, type ForgeGame, type ForgeDressParams } from '@shared/ui-forge';
import { labDevice } from '../lab/devices';
import { MockupStore } from '../ui-mockups';
import { UiStore } from '../ui-workshop';
import { reskinScreens } from './reskin';
import { genreContent, genres } from './genres';
import { DIRECTIONS, ELEMENT_KINDS, type ElementRequest, type Variant } from './directions';
import { SAMPLE_DEVICE, sampleOf, sampleScreens } from './forge-sample';
import { runForgeJob, type ElementsResult, type ForgeJob, type ForgeResult, type PreviewBackdrop, type ScreenResult, type WornResult } from './forge-render';
import { relayForgeGpu, type ForgeGpuTransport } from './gpu-batch';
import { FORGE_CACHE_VERSION, skinCacheDir } from './resolve';
import { skinFile } from './spec';
import { setForgeResources } from './shapes';
import { TEMPLATES } from './templates';
import { LOOK_IDS } from './templates/look';

/**
 * The Forge on the UI page (pages/forge/): the art directions to choose from, the screen templates, previews of a
 * direction's sample screen or a template on a device drawn by the CPU engine (PNG data URLs), a direction's element
 * sheet, and a mockup made from a template in a direction (MockupStore, the same mockups the UI page lists).
 *
 * Pictures are drawn in worker threads (electron-vite's `?nodeWorker`); where there are none (tests, scripts) in the
 * core's thread a piece at a time. Each is cached by everything that makes it (the design, the direction's recipes,
 * the device, the scales, the backdrop) in memory and on disk in the app's cache, so a look seen once comes back at
 * once. Waiting requests in the same slot are replaced by newer ones (an accent dragged across the picker draws once).
 */

export interface ForgeHost {
  dataDir: string;
  resourcesDir: string | null;
  appVersion: string;
  project(): { root: string; dir: string; summary?: { name?: string } } | null;
  /** A mockup was made or given a version (the UI page lists them again). */
  mockupsChanged(name: string): void;
  /** The GPU forge on the app's render page: the workers' skins are drawn there (the CPU forges what it can't). */
  forgeGpu?: ForgeGpuTransport;
}

/** Bump when the pictures change for the same inputs (the preview pipeline, the sample screen). */
const PREVIEW_VERSION = 2;
const DISK_FILES = 500;
const MEMORY_BYTES = 96 * 1024 * 1024;

// ─── Directions and templates ──────────────────────────────────────────────────────────────────────

const hexOf = (c: unknown): string | null => {
  if (Array.isArray(c) && c.length >= 3) return `#${c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0')).join('')}`;
  return normalizeAccent(c);
};

/** Bright accents that read on any of the directions, after each direction's own. */
const GENERAL_SWATCHES = ['#ff4d6d', '#ff7a1a', '#ffc93c', '#36d96a', '#22c7b8', '#3fa9ff', '#5b7cff', '#9b5cff', '#ff5ad1'];
/** The palette entries that make good accents, by direction, in order. */
const OWN_ACCENTS: Record<string, string[]> = {
  candy: ['accent', 'primary', 'secondary', 'premium', 'danger'],
  ember: ['edge', 'accent', 'hot', 'blood'],
  neon: ['line', 'hot', 'ok', 'warn'],
  parchment: ['gold', 'wax', 'royal', 'leaf'],
  frost: ['accent', 'ok', 'gold', 'bad'],
  motorsport: ['hot', 'nitro', 'green', 'gold', 'red'],
};

function rgbDistance(a: string, b: string): number {
  const p = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return Math.hypot(p(a, 0) - p(b, 0), p(a, 1) - p(b, 1), p(a, 2) - p(b, 2));
}

export function directionInfo(id: string): ForgeDirectionInfo | null {
  const d = DIRECTIONS[id];
  if (!d) return null;
  const m = /^([^(]+?)\s*\((.+)\)\s*$/.exec(d.label);
  const palette = Object.entries(d.palette)
    .map(([name, c]) => ({ name, hex: hexOf(c) }))
    .filter((x): x is { name: string; hex: string } => !!x.hex);
  const swatches: string[] = [];
  // Its own accents first: named ones for the looks that have them, else its most colourful palette entries.
  const chroma = (h: string) => {
    const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    return Math.max(...v) - Math.min(...v);
  };
  const own = OWN_ACCENTS[id]?.map((k) => hexOf(d.palette[k])) ?? palette.map((x) => x.hex).filter((h) => chroma(h) > 70).slice(0, 4);
  for (const h of [...own, ...GENERAL_SWATCHES]) {
    if (h && swatches.length < 12 && !swatches.some((s) => rgbDistance(s, h) < 48)) swatches.push(h);
  }
  return { id, name: m?.[1] ?? d.label, tagline: m?.[2] ?? '', for: d.for, palette, fonts: { display: d.fonts.display, body: d.fonts.body }, swatches, sampleTitle: sampleOf(id).title, backdrop: hexOf(d.backdrop) ?? '#1b2230' };
}

export const forgeTemplates = (): ForgeTemplateInfo[] => Object.values(TEMPLATES).map((t) => ({ id: t.id, label: t.label, for: t.for, contentShape: t.contentShape, looks: [...LOOK_IDS] }));

const nameOf = (direction: string) => directionInfo(direction)?.name ?? direction;

export const forgeGenres = (): ForgeGenreInfo[] => Object.entries(genres()).map(([id, g]) => ({ id, label: g.label, direction: g.direction, accent: g.accent ?? null }));

/** The screens a preview or a mockup is made of (a template filled with a genre's content when one is given). */
function screensFor(what: 'sample' | 'template', direction: string, accent: string | null, template?: string, genre?: string | null): { screens: MockNode[]; motion: MockMotion[]; device: string; label: string; for?: string } {
  if (!DIRECTIONS[direction]) throw new Error(`No art direction "${direction}" (directions: ${Object.keys(DIRECTIONS).join(', ')})`);
  if (what === 'sample' || template === 'sample') return { screens: sampleScreens(direction, accent ?? undefined), motion: [], device: SAMPLE_DEVICE, label: `${sampleOf(direction).title} sample` };
  const t = template ? TEMPLATES[template] : undefined;
  if (!t) throw new Error(`No screen template "${template}" (templates: ${Object.keys(TEMPLATES).join(', ') || 'none yet'})`);
  const g = genre ? genres()[genre] : undefined;
  const out = t.build({ direction, ...(accent ? { accent } : {}), ...(g ? { content: genreContent(g, t.id) } : {}) });
  return { screens: out.screens, motion: out.motion ?? [], device: 'desktop', label: t.label, for: t.for };
}

// ─── The element sheet ─────────────────────────────────────────────────────────────────────────────

interface SheetEntry {
  label: string;
  kind: (typeof ELEMENT_KINDS)[number];
  size: [number, number];
  variant?: Variant;
  glyph?: string;
  text?: string;
}

const RARITIES: Variant[] = ['common', 'rare', 'epic', 'legendary', 'mythic'];

/** A direction's whole kit, grouped the way a designer reads it. */
export function sheetEntries(direction: string): Array<{ id: string; label: string; items: SheetEntry[] }> {
  const c = sampleOf(direction);
  return [
    { id: 'titles', label: 'Title', items: [{ label: 'title', kind: 'title', size: [340, 90], text: c.title }] },
    {
      id: 'buttons',
      label: 'Buttons',
      items: (['primary', 'secondary', 'danger', 'premium', 'pressed', 'disabled'] as Variant[]).map((v) => ({ label: v, kind: 'button', variant: v, size: [200, 56] })),
    },
    {
      id: 'tabs',
      label: 'Tabs and close',
      items: [
        { label: 'tab active', kind: 'tab', variant: 'active', size: [150, 48] },
        { label: 'tab inactive', kind: 'tab', variant: 'inactive', size: [150, 48] },
        { label: 'close', kind: 'close', size: [52, 52] },
      ],
    },
    { id: 'cards', label: 'Cards by rarity', items: RARITIES.map((v) => ({ label: v, kind: 'card', variant: v, size: [150, 184] })) },
    { id: 'slots', label: 'Item slots', items: RARITIES.map((v) => ({ label: v, kind: 'slot', variant: v, size: [88, 88] })) },
    { id: 'icons', label: 'Icons', items: c.items.slice(0, 6).map(([, glyph, rarity]) => ({ label: `${glyph} · ${rarity}`, kind: 'icon', glyph, variant: rarity as Variant, size: [80, 80] })) },
    {
      id: 'currency',
      label: 'Currency and labels',
      items: [
        { label: `coin · ${c.currency}`, kind: 'coin', glyph: c.currency, size: [52, 52] },
        { label: 'coin · gem', kind: 'coin', glyph: 'gem', size: [52, 52] },
        { label: 'balance pill', kind: 'pill', size: [190, 46] },
        { label: 'badge', kind: 'badge', size: [52, 52] },
        { label: 'ribbon', kind: 'ribbon', size: [190, 44] },
        { label: 'icon frame', kind: 'iconFrame', size: [76, 76] },
      ],
    },
    {
      id: 'bars',
      label: 'Bars',
      items: [
        { label: 'bar track', kind: 'barTrack', size: [260, 26] },
        { label: 'bar fill', kind: 'barFill', size: [180, 26] },
        { label: 'divider', kind: 'divider', size: [260, 6] },
      ],
    },
    {
      id: 'panels',
      label: 'Panels',
      items: [
        { label: 'header', kind: 'header', size: [420, 78] },
        { label: 'tooltip', kind: 'tooltip', size: [260, 90] },
        { label: 'window', kind: 'window', size: [420, 260] },
      ],
    },
  ];
}

/** The skin spec that asks for an entry ("candy:icon:sword:epic#ff7ab8"). */
export function entrySpec(direction: string, e: SheetEntry, accent: string | null): string {
  const tail = e.kind === 'title' ? `:${e.text ?? ''}` : e.kind === 'icon' || e.kind === 'coin' ? `:${e.glyph ?? 'star'}${e.variant ? `:${e.variant}` : ''}` : e.variant ? `:${e.variant}` : '';
  return `${direction}:${e.kind}${tail}${accent ?? ''}`;
}

// ─── Cache keys ────────────────────────────────────────────────────────────────────────────────────

const recipePrints = new Map<string, string>();

/** A fingerprint of a direction's recipes (an element of every kind and variant): art that changed is drawn again. */
function recipePrint(direction: string): string {
  const hit = recipePrints.get(direction);
  if (hit) return hit;
  const d = DIRECTIONS[direction]!;
  const h = createHash('sha1');
  h.update(JSON.stringify([d.palette, d.fonts, d.text]));
  for (const kind of ELEMENT_KINDS)
    for (const variant of [undefined, 'primary', 'secondary', 'active', 'epic'] as Array<Variant | undefined>) {
      const r: ElementRequest = { kind, size: [160, 64], ...(variant ? { variant } : {}), ...(kind === 'icon' || kind === 'coin' ? { glyph: 'star' } : {}), ...(kind === 'title' ? { text: 'TITLE' } : {}) };
      try {
        h.update(JSON.stringify(d.element(r, '#3fa9ff')));
      } catch (e) {
        h.update(String(e));
      }
    }
  const out = h.digest('hex').slice(0, 16);
  recipePrints.set(direction, out);
  return out;
}

const keyOf = (parts: unknown): string => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

// ─── The engine: workers, a queue, the caches ──────────────────────────────────────────────────────

interface Pending {
  key: string;
  job: ForgeJob;
  slot?: string;
  high: boolean;
  waiters: Array<{ resolve: (r: ForgeResult | null) => void; reject: (e: Error) => void }>;
}

interface Lane {
  worker: Worker | null;
  busy: Pending | null;
}

type WorkerFactory = (o: WorkerOptions) => Worker;

class ForgeEngine {
  /** The GPU forge, relayed to every worker (they draw their skins there). */
  constructor(private readonly gpu?: ForgeGpuTransport) {}

  private lanes: Lane[] = [];
  private queue: Pending[] = [];
  private byKey = new Map<string, Pending>();
  private mode: ForgeStatus['engine'] = 'starting';
  private starting: Promise<void> | null = null;
  private seq = 0;
  private failures = 0;
  private replies = new Map<number, Pending>();

  /** Whether pictures are drawn off the core's thread (started first when it isn't yet). */
  async workers(): Promise<boolean> {
    await this.start();
    return this.mode === 'worker';
  }

  status(): ForgeStatus {
    return { engine: this.mode, workers: this.lanes.filter((l) => l.worker).length, queued: this.queue.length, running: this.lanes.filter((l) => l.busy).length };
  }

  /** Runs a job (or joins the same one already waiting); null when a newer job in its slot replaced it. */
  run(key: string, job: ForgeJob, o: { slot?: string; high?: boolean } = {}): Promise<ForgeResult | null> {
    return new Promise((resolve, reject) => {
      const same = this.byKey.get(key);
      if (same) {
        same.waiters.push({ resolve, reject });
        if (o.high && !same.high) {
          same.high = true;
          this.sort();
        }
        return;
      }
      if (o.slot)
        for (const old of this.queue.filter((p) => p.slot === o.slot)) {
          this.queue.splice(this.queue.indexOf(old), 1);
          this.byKey.delete(old.key);
          for (const w of old.waiters) w.resolve(null);
        }
      const p: Pending = { key, job, ...(o.slot ? { slot: o.slot } : {}), high: !!o.high, waiters: [{ resolve, reject }] };
      this.byKey.set(key, p);
      this.queue.push(p);
      this.sort();
      void this.pump();
    });
  }

  private sort(): void {
    // High first, each in the order it came (sort is stable).
    this.queue.sort((a, b) => Number(b.high) - Number(a.high));
  }

  private async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let factory: WorkerFactory | null = null;
      try {
        // electron-vite builds the worker and gives a function that starts it; elsewhere this is the plain module.
        const mod = (await import('./forge-worker?nodeWorker')) as { default?: unknown };
        factory = typeof mod.default === 'function' ? (mod.default as WorkerFactory) : null;
      } catch {
        factory = null;
      }
      const n = factory ? Math.max(1, Math.min(2, cpus().length - 2)) : 0;
      for (let i = 0; i < n; i++) {
        try {
          this.lanes.push({ worker: this.spawn(factory!), busy: null });
        } catch {
          break;
        }
      }
      if (!this.lanes.length) this.lanes.push({ worker: null, busy: null });
      this.mode = this.lanes.some((l) => l.worker) ? 'worker' : 'thread';
    })();
    return this.starting;
  }

  private spawn(factory: WorkerFactory): Worker {
    const w = factory({ workerData: { shurikenForge: true, forgeGpu: !!this.gpu }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    w.unref();
    if (this.gpu) relayForgeGpu(w, this.gpu);
    w.on('message', (msg: { id?: number; result?: ForgeResult; error?: string }) => {
      // A job's answer; the GPU relay's messages carry no id.
      if (typeof msg?.id !== 'number') return;
      const p = this.replies.get(msg.id);
      if (!p) return;
      this.replies.delete(msg.id);
      this.finish(p, msg.result ?? null, msg.error ? new Error(msg.error) : null);
    });
    const lost = () => {
      const lane = this.lanes.find((l) => l.worker === w);
      if (!lane) return;
      this.failures++;
      lane.worker = this.failures < 3 ? (() => {
        try {
          return this.spawn(factory);
        } catch {
          return null;
        }
      })() : null;
      if (!this.lanes.some((l) => l.worker)) this.mode = 'thread';
      const p = lane.busy;
      lane.busy = null;
      if (p) {
        for (const [id, q] of this.replies) if (q === p) this.replies.delete(id);
        // Drawn again (in the core's thread when the workers are gone): a lost worker isn't the design's fault.
        this.queue.unshift(p);
      }
      void this.pump();
    };
    w.on('error', () => lost());
    w.on('exit', (code) => code !== 0 && lost());
    return w;
  }

  private finish(p: Pending, result: ForgeResult | null, error: Error | null): void {
    const lane = this.lanes.find((l) => l.busy === p);
    if (lane) lane.busy = null;
    this.byKey.delete(p.key);
    for (const w of p.waiters) error || !result ? w.reject(error ?? new Error('The Forge drew nothing')) : w.resolve(result);
    void this.pump();
  }

  private async pump(): Promise<void> {
    await this.start();
    for (const lane of this.lanes) {
      if (lane.busy || !this.queue.length) continue;
      const p = this.queue.shift()!;
      lane.busy = p;
      if (lane.worker) {
        const id = ++this.seq;
        this.replies.set(id, p);
        lane.worker.postMessage({ id, job: p.job });
      } else {
        // The core's own thread: a piece at a time, letting other calls in between.
        const pause = () => new Promise<void>((r) => setImmediate(r));
        void runForgeJob(p.job, pause).then(
          (r) => this.finish(p, r, null),
          (e: unknown) => this.finish(p, null, e instanceof Error ? e : new Error(String(e))),
        );
      }
    }
  }
}

/** Pictures by key: recent ones in memory, all on disk (the newest DISK_FILES). */
class PreviewCache {
  private mem = new Map<string, { value: unknown; bytes: number }>();
  private memBytes = 0;
  private writes = 0;

  constructor(private readonly dir: string) {}

  get<T>(key: string): T | null {
    const hit = this.mem.get(key);
    if (hit) {
      this.mem.delete(key);
      this.mem.set(key, hit);
      return hit.value as T;
    }
    try {
      const file = join(this.dir, `${key}.json`);
      if (!existsSync(file)) return null;
      const value = JSON.parse(readFileSync(file, 'utf8')) as T;
      this.remember(key, value);
      return value;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.remember(key, value);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(value));
      if (++this.writes % 50 === 1) this.prune();
    } catch {
      /* a cache that can't be written is only slower */
    }
  }

  private remember(key: string, value: unknown): void {
    const bytes = JSON.stringify(value).length;
    this.mem.delete(key);
    this.mem.set(key, { value, bytes });
    this.memBytes += bytes;
    for (const [k, v] of this.mem) {
      if (this.memBytes <= MEMORY_BYTES) break;
      this.mem.delete(k);
      this.memBytes -= v.bytes;
    }
  }

  private prune(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, at: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const { f } of files.slice(DISK_FILES)) unlinkSync(join(this.dir, f));
    } catch {
      /* best effort */
    }
  }
}

/** One engine per core process (its workers and art outlive a project switch). */
let engine: ForgeEngine | null = null;

const dataUrl = (png: Uint8Array): string => `data:image/png;base64,${Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64')}`;

// ─── The RPCs ──────────────────────────────────────────────────────────────────────────────────────

export function forgeRpc(host: ForgeHost): Record<string, (params: any) => unknown> {
  setForgeResources(host.resourcesDir);
  const cache = new PreviewCache(join(host.dataDir, 'cache', 'forge'));
  const forgeEngine = (): ForgeEngine => (engine ??= new ForgeEngine(host.forgeGpu));

  /** Draws screens on a device (from the cache when it has them): the Forge's previews and forged pictures of mockups. */
  const draw = async (o: { screens: MockNode[]; theme?: Record<string, MockColor>; device: string; width: number; mood: string; params: Pick<ForgePreviewParams, 'roblox' | 'backdrop' | 'slot' | 'priority' | 'engine'> }): Promise<ForgePreview> => {
    const dev = labDevice(o.device);
    if (!dev) throw new Error(`No device "${o.device}"`);
    const { scale, forgeScale } = previewScales(o.width, dev.w);
    let backdrop: PreviewBackdrop = { kind: 'look', direction: o.mood };
    let backdropKey: unknown = backdrop;
    if (o.params?.backdrop === 'game') {
      const proj = host.project();
      const file = proj ? join(proj.dir, 'thumbnail.jpg') : null;
      if (file && existsSync(file)) {
        const st = statSync(file);
        backdrop = { kind: 'image', bytes: new Uint8Array(readFileSync(file)) };
        backdropKey = { game: file, at: st.mtimeMs, size: st.size };
      }
    }
    const roblox = o.params?.roblox === false ? 'none' : 'controls';
    const cpu = o.params?.engine === 'cpu';
    const job: ForgeJob = { kind: 'screen', screens: o.screens, ...(o.theme ? { theme: o.theme } : {}), device: o.device, scale, forgeScale, backdrop, roblox, resources: host.resourcesDir, ...(cpu ? { gpu: false } : {}) };
    // Every direction the screens wear goes into the key: a recipe that changed draws again.
    const worn = [...new Set([...JSON.stringify(o.screens).matchAll(/"skin":"([a-z0-9]+):/g)].map((m) => m[1]!))].filter((d) => DIRECTIONS[d]).sort();
    const key = keyOf({ v: PREVIEW_VERSION, f: FORGE_CACHE_VERSION, app: host.appVersion, r: worn.map(recipePrint), s: o.screens, t: o.theme ?? null, device: o.device, scale, forgeScale, b: backdropKey, roblox, ...(cpu ? { cpu } : {}) });
    const hit = cache.get<Omit<ForgePreview, 'cached' | 'ms'>>(key);
    if (hit) return { ...hit, ms: 0, cached: true };
    const r = (await forgeEngine().run(key, job, { ...(o.params?.slot ? { slot: String(o.params.slot) } : {}), high: o.params?.priority === 'high' })) as ScreenResult | null;
    if (!r) return { png: '', w: 0, h: 0, ms: 0, cached: false, errors: [], notes: [], superseded: true };
    const out = { png: dataUrl(r.png), w: r.w, h: r.h, errors: r.errors, notes: r.notes };
    cache.set(key, out);
    return { ...out, ms: r.ms, timings: r.timings, cached: false };
  };

  /** The game's UI as last read from Studio (the UI page's In the game). */
  const gameScreens = (): MockNode[] | null => {
    const proj = host.project();
    const snap = proj ? new UiStore(proj.root).get() : null;
    return snap?.screens?.length ? snap.screens.map(fromCapture) : null;
  };
  const game = (): ForgeGame | null => {
    const proj = host.project();
    const snap = proj ? new UiStore(proj.root).get() : null;
    if (!snap?.screens?.length) return null;
    return { screens: snap.screens.map((x) => x.name), source: snap.source, capturedAt: snap.capturedAt, name: proj?.summary?.name?.trim() || 'Game' };
  };
  /** The game's UI dressed in a direction (reskin.ts: every window, button, tab, card, bar and pill given its skin). */
  const dressed = (direction: string, accent: string | null): MockNode[] => {
    const screens = gameScreens();
    if (!screens) throw new Error("The game's UI hasn't been read yet: read it on the UI page (In the game) first.");
    if (!DIRECTIONS[direction]) throw new Error(`No art direction "${direction}"`);
    return reskinScreens(screens, { direction, ...(accent ? { accent } : {}) }).screens;
  };

  const preview = async (params: ForgePreviewParams): Promise<ForgePreview> => {
    const direction = String(params?.direction ?? '');
    const accent = normalizeAccent(params?.accent);
    if (params?.what === 'game') return draw({ screens: dressed(direction, accent), device: isForgeDevice(params?.device) ? params.device : 'desktop', width: Number(params?.width ?? 0), mood: direction, params });
    const what = params?.what === 'template' ? 'template' : 'sample';
    const made = screensFor(what, direction, accent, params?.template, params?.genre);
    const device = what === 'template' && isForgeDevice(params?.device) ? params.device : made.device;
    return draw({ screens: made.screens, device, width: Number(params?.width ?? 0), mood: direction, params });
  };

  /** A mockup version drawn with its skins forged (the Mockups view's own canvas draws their plain fills). */
  const mockupPicture = async (params: ForgeMockupParams): Promise<ForgePreview> => {
    const proj = host.project();
    if (!proj) throw new Error('No project is open');
    const m = new MockupStore(proj.root).get(String(params?.name ?? ''));
    if (!m) throw new Error(`No mockup "${params?.name}"`);
    const v = params?.version ? m.versions.find((x) => x.id === String(params.version).toUpperCase()) : currentVersion(m);
    if (!v) throw new Error(`"${m.title}" has no version ${params?.version}`);
    const device = typeof params?.device === 'string' && labDevice(params.device) ? params.device : 'desktop';
    const mood = /"skin":"([a-z0-9]+):/.exec(JSON.stringify(v.screens))?.[1] ?? 'neon';
    return draw({ screens: v.screens, ...(v.theme ? { theme: v.theme } : {}), device, width: Number(params?.width ?? 0), mood: DIRECTIONS[mood] ? mood : 'neon', params: { ...params, priority: params?.priority ?? 'high' } });
  };

  /** Worn screens by version (the art itself is read from the project's skin cache, or kept here when it isn't there). */
  const wornScreens = new Map<string, { screens: Partial<Record<UiDevice, UiNode[]>>; skins: Array<{ key: string; w: number; h: number }>; errors: string[] }>();
  const loose = new Map<string, string>();
  const skinUrl = (dir: string, key: string): string | null => {
    const kept = loose.get(key);
    if (kept) return kept;
    try {
      return `data:image/png;base64,${readFileSync(join(dir, `${skinFile(key)}.png`)).toString('base64')}`;
    } catch {
      return null;
    }
  };

  /**
   * A mockup version's screens with its skins worn, per device, for the Mockups view to draw: each skinned element's
   * art as its "Skin" child (9-sliced), its text in a "Label", its states' art as skinArt; and the PNGs of the art the
   * page doesn't have yet (`have`), each sent once.
   */
  const worn = async (params: ForgeWornParams): Promise<ForgeWorn> => {
    const proj = host.project();
    if (!proj) return { skinned: false, screens: {}, images: {}, errors: [] };
    const m = new MockupStore(proj.root).get(String(params?.name ?? ''));
    if (!m) throw new Error(`No mockup "${params?.name}"`);
    const v = params?.version ? m.versions.find((x) => x.id === String(params.version).toUpperCase()) : currentVersion(m);
    if (!v) throw new Error(`"${m.title}" has no version ${params?.version}`);
    const json = JSON.stringify(v.screens);
    if (!/"skin":"/.test(json)) return { skinned: false, screens: {}, images: {}, errors: [] };
    const devices = (Array.isArray(params?.devices) ? params.devices : MOCK_DEVICES).filter((d): d is UiDevice => typeof d === 'string' && d in UI_DEVICES);
    const dirs = [...new Set([...json.matchAll(/"skin":"([a-z0-9]+):/g)].map((x) => x[1]!))].filter((d) => DIRECTIONS[d]).sort();
    const cacheDir = skinCacheDir(proj.root);
    // One job per device: the workers forge two devices at once, and a device seen before comes back at once.
    const perDevice = await Promise.all(
      devices.map(async (device) => {
        const key = keyOf({ v: PREVIEW_VERSION, f: FORGE_CACHE_VERSION, r: dirs.map(recipePrint), s: v.screens, t: v.theme ?? null, device, root: proj.root });
        const hit = wornScreens.get(key);
        if (hit) return hit;
        const r = (await forgeEngine().run(key, { kind: 'worn', screens: v.screens, ...(v.theme ? { theme: v.theme } : {}), devices: [device], cacheDir, resources: host.resourcesDir }, { high: params?.priority !== 'low' })) as WornResult | null;
        if (!r) throw new Error('The drawing was replaced by a newer one');
        for (const x of r.skins) if (x.png) loose.set(x.key, dataUrl(x.png));
        const out = { screens: r.screens, skins: r.skins.map(({ key: k, w, h }) => ({ key: k, w, h })), errors: r.errors };
        wornScreens.set(key, out);
        while (wornScreens.size > 60) wornScreens.delete(wornScreens.keys().next().value!);
        while (loose.size > 200) loose.delete(loose.keys().next().value!);
        return out;
      }),
    );
    const skins = new Map<string, { key: string; w: number; h: number }>();
    for (const g of perDevice) for (const x of g.skins) skins.set(x.key, x);
    const got = { screens: Object.assign({}, ...perDevice.map((g) => g.screens)) as Partial<Record<UiDevice, UiNode[]>>, skins: [...skins.values()], errors: [...new Set(perDevice.flatMap((g) => g.errors))] };
    if (params?.warm) return { skinned: true, screens: {}, images: {}, errors: got.errors };
    const have = new Set(Array.isArray(params?.have) ? params.have.map(String) : []);
    const images: ForgeWorn['images'] = {};
    for (const s of got.skins) {
      const ref = `skin:${s.key}`;
      if (have.has(ref)) continue;
      const url = skinUrl(cacheDir, s.key);
      if (url) images[ref] = { url, w: s.w, h: s.h };
    }
    return { skinned: true, screens: got.screens, images, errors: got.errors };
  };

  const sheet = async (params: { direction: string; accent?: string | null; px?: number; slot?: string }): Promise<ForgeSheet> => {
    const direction = String(params?.direction ?? '');
    if (!DIRECTIONS[direction]) throw new Error(`No art direction "${direction}"`);
    const accent = normalizeAccent(params?.accent);
    const scale = Number(params?.px) >= 1.5 ? 2 : 1;
    const groups = sheetEntries(direction);
    const items = groups.flatMap((g) => g.items.map((e) => ({ spec: entrySpec(direction, e, accent), size: e.size })));
    const key = keyOf({ v: PREVIEW_VERSION, f: FORGE_CACHE_VERSION, app: host.appVersion, r: recipePrint(direction), sheet: items, scale });
    const hit = cache.get<Omit<ForgeSheet, 'cached' | 'ms'>>(key);
    if (hit) return { ...hit, ms: 0, cached: true };
    const r = (await forgeEngine().run(key, { kind: 'elements', items, forgeScale: scale, resources: host.resourcesDir }, { ...(params?.slot ? { slot: String(params.slot) } : {}), high: true })) as ElementsResult | null;
    if (!r) return { direction, accent, groups: [], ms: 0, cached: false };
    let i = 0;
    const out: Omit<ForgeSheet, 'cached' | 'ms'> = {
      direction,
      accent,
      groups: groups.map((g) => ({
        id: g.id,
        label: g.label,
        items: g.items.map((e): ForgeSheetItem => {
          const got = r.items[i++]!;
          return { spec: got.spec, label: e.label, size: e.size, png: got.png ? dataUrl(got.png) : null, w: got.w, h: got.h, margin: got.margin, scale, ...(got.error ? { error: got.error } : {}) };
        }),
      })),
    };
    cache.set(key, out);
    return { ...out, ms: r.ms, cached: false };
  };

  /** Its skins forged now, in the workers, so the Mockups view has them when it opens. */
  const prewarm = (name: string, version: string): void => {
    void forgeEngine()
      .workers()
      .then((off) => (off ? worn({ name, version, priority: 'low', warm: true }) : null))
      .catch(() => {});
  };

  /**
   * "Dress my game's UI": a mockup of the game's UI as last read, dressed in a direction (a version with from "game" and
   * reskin, so the mockup records how it was made). Dressing it again in the same look adds a version to that mockup.
   */
  const dress = (params: ForgeDressParams): ForgeMade => {
    const proj = host.project();
    if (!proj) throw new Error('Open a project first: mockups are kept with the project.');
    const direction = String(params?.direction ?? '');
    if (!DIRECTIONS[direction]) throw new Error(`No art direction "${direction}"`);
    const accent = normalizeAccent(params?.accent);
    const g = new UiStore(proj.root).get();
    if (!g?.screens?.length) throw new Error("The game's UI hasn't been read yet: read it on the UI page (In the game) first.");
    const screen = params?.screen ? String(params.screen) : null;
    const look = nameOf(direction);
    const gameName = proj.summary?.name?.trim() || 'Game';
    const title = String(params?.title ?? '').trim() || `${gameName} UI in ${look}`;
    const version = {
      label: `${look}${accent ? ` ${accent}` : ''}`.slice(0, 40),
      note: `The game's UI${screen ? ` (${screen})` : ''} as read from ${g.source === 'PlayerGui' ? 'a playtest' : 'Studio'}, dressed in the ${look} art direction${accent ? `, tinted ${accent}` : ''} in the Forge.`,
      from: screen ? `game:${screen}` : 'game',
      reskin: { direction, ...(accent ? { accent } : {}) },
    };
    const store = new MockupStore(proj.root);
    const into = params?.into ? store.get(String(params.into)) : store.get(mockupName(title));
    const r = into ? store.addVersions(into.name, [version], 'user', g.screens) : store.create({ title, brief: `${gameName}'s own UI dressed in an art direction in the Forge: the same screens and layout, every window, button, tab, card, bar and pill wearing the look's skins.`, versions: [version], by: 'user', game: g.screens });
    if (!r.mockup || !r.added[0]) throw new Error(r.errors.join('; ') || 'The mockup could not be made');
    host.mockupsChanged(r.mockup.name);
    prewarm(r.mockup.name, r.added[0].id);
    return { name: r.mockup.name, title: r.mockup.title, version: r.added[0].id, warnings: r.warnings };
  };

  const make = (params: ForgeMakeParams): ForgeMade => {
    if (params?.template === 'game') return dress({ direction: params.direction, ...(params.accent ? { accent: params.accent } : {}), ...(params.title ? { title: params.title } : {}), ...(params.into ? { into: params.into } : {}) });
    const proj = host.project();
    if (!proj) throw new Error('Open a project first: mockups are kept with the project.');
    const direction = String(params?.direction ?? '');
    const accent = normalizeAccent(params?.accent);
    const template = String(params?.template ?? 'sample');
    const made = screensFor(template === 'sample' ? 'sample' : 'template', direction, accent, template, params?.genre);
    const genre = params?.genre ? genres()[params.genre] : undefined;
    const look = nameOf(direction);
    const version = {
      label: `${look}${accent ? ` ${accent}` : ''}`.slice(0, 40),
      note: `The ${made.label} in the ${look} art direction${accent ? `, tinted ${accent}` : ''}${genre && template !== 'sample' ? `, filled as a ${genre.label.toLowerCase()} game` : ''}, made in the Forge.`,
      screens: made.screens,
      ...(made.motion.length ? { motion: made.motion } : {}),
    };
    const store = new MockupStore(proj.root);
    const into = params?.into ? store.get(String(params.into)) : null;
    const r = into
      ? store.addVersions(into.name, [version], 'user')
      : store.create({ title: String(params?.title ?? '').trim() || `${made.label} (${look})`, brief: `Made in the Forge from the ${made.label}${made.for ? `: ${made.for}` : ''}.`, versions: [version], by: 'user' });
    if (!r.mockup || !r.added[0]) throw new Error(r.errors.join('; ') || 'The mockup could not be made');
    host.mockupsChanged(r.mockup.name);
    prewarm(r.mockup.name, r.added[0].id);
    return { name: r.mockup.name, title: r.mockup.title, version: r.added[0].id, warnings: r.warnings };
  };

  return {
    'forge.directions': (): ForgeDirectionInfo[] => Object.keys(DIRECTIONS).map((id) => directionInfo(id)!),
    'forge.templates': (): ForgeTemplateInfo[] => forgeTemplates(),
    'forge.genres': (): ForgeGenreInfo[] => forgeGenres(),
    'forge.preview': (params: ForgePreviewParams) => preview(params),
    'forge.mockup': (params: ForgeMockupParams) => mockupPicture(params),
    'forge.worn': (params: ForgeWornParams) => worn(params),
    'forge.sheet': (params: { direction: string; accent?: string | null; px?: number; slot?: string }) => sheet(params),
    'forge.make': (params: ForgeMakeParams) => make(params),
    'forge.game': (): ForgeGame | null => game(),
    'forge.dress': (params: ForgeDressParams) => dress(params),
    'forge.status': (): ForgeStatus => forgeEngine().status(),
  };
}
