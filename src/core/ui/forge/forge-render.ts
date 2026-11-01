import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UiDevice, UiNode } from '@shared/ui-layout';
import { resolveVersion, type MockColor, type MockNode } from '@shared/ui-mockup';
import type { RgbaImage } from '../../modeling/png';
import { decodeImage } from '../../look/look-analysis';
import { renderLab } from '../lab/core-overlays';
import { labDevice } from '../lab/devices';
import { formDevice } from '../lab/lab';
import { robloxFontPicker } from '../lab/lab-text';
import { robloxMeasure } from '../lab/roblox-fonts';
import { projectImages } from '../ui-pictures';
import { DIRECTIONS } from './directions';
import { forge, type Forged } from './forge';
import { setForgeResources } from './shapes';
import { prepareSkins, SkinForge, warmSkins } from './resolve';
import { parseSkin, requestOf, skinFile } from './spec';

/**
 * The Forge page's pictures, drawn by the CPU engine: a design's screens on a device with every skin forged at a
 * preview scale (a gallery card forges at half a pixel per point, the stage at about its own scale) and worn, or a
 * direction's elements one by one for its sheet. Pure work on plain data, so it runs the same in the core's thread
 * and in the Forge's worker; `pause` is awaited between pieces so a run in the core's thread lets other calls in.
 */

export type PreviewBackdrop = { kind: 'look'; direction: string } | { kind: 'dark' } | { kind: 'image'; bytes: Uint8Array };

export interface ScreenJob {
  kind: 'screen';
  screens: MockNode[];
  theme?: Record<string, MockColor>;
  /** A UI Lab device id, or ui_audit's name for one (phone, tablet, laptop, desktop). */
  device: string;
  /** Picture pixels per point. */
  scale: number;
  /** Art pixels per point. */
  forgeScale: number;
  backdrop: PreviewBackdrop;
  /** Roblox's own controls drawn over the game (top bar, thumbstick, jump; chat and the player list left out), or nothing. */
  roblox: 'controls' | 'none';
  /** False: every skin forged on the CPU even when the GPU forge is there (to measure one against the other). */
  gpu?: boolean;
  resources: string | null;
}

export interface ElementsJob {
  kind: 'elements';
  items: Array<{ spec: string; size: [number, number] }>;
  forgeScale: number;
  /** The app's resources (the glyph set icons are cut from). */
  resources: string | null;
}

/**
 * A mockup version's screens on devices with every skin worn as the game wears it (resolve.ts prepareSkins, the
 * project's skin cache), for the UI page's canvases to draw: art forged at the game's scale, 9-sliced by the page.
 */
export interface WornJob {
  kind: 'worn';
  screens: MockNode[];
  theme?: Record<string, MockColor>;
  /** ui_audit's device names (phone, phonePortrait, tablet, desktop, tv). */
  devices: UiDevice[];
  /** The project's skin cache (skinCacheDir), where forged art is kept as PNG files. */
  cacheDir: string | null;
  resources: string | null;
}

export type ForgeJob = ScreenJob | ElementsJob | WornJob;

export interface ScreenResult {
  kind: 'screen';
  png: Uint8Array;
  w: number;
  h: number;
  errors: string[];
  notes: string[];
  ms: number;
  /** Where the time went: forging and wearing the skins, then drawing and encoding the picture. */
  timings: { skins: number; draw: number };
}

export interface ElementResult {
  spec: string;
  png: Uint8Array | null;
  /** Picture size in pixels, and the margin (points) round the element its shadows and glows take. */
  w: number;
  h: number;
  margin: number;
  error?: string;
}

export interface ElementsResult {
  kind: 'elements';
  items: ElementResult[];
  ms: number;
}

export interface WornResult {
  kind: 'worn';
  screens: Partial<Record<UiDevice, UiNode[]>>;
  /** The art worn, by key: its size, and its PNG when the skin cache has no file for it. */
  skins: Array<{ key: string; w: number; h: number; png: Uint8Array | null }>;
  errors: string[];
  ms: number;
}

export type ForgeResult = ScreenResult | ElementsResult | WornResult;

// ─── Forged art, kept between jobs ─────────────────────────────────────────────────────────────────

/** The element sheet's art by its recipe and scale: an accent that doesn't touch an element keeps its art. */
const forgedArt = new Map<string, Forged>();
let forgedBytes = 0;
const ART_BYTES = 96 * 1024 * 1024;

function forgeCached(spec: string, size: [number, number], scale: number): Forged {
  const p = parseSkin(spec);
  if ('error' in p) throw new Error(p.error);
  const recipe = DIRECTIONS[p.spec.direction]!.element(requestOf(p.spec, size), p.spec.accent);
  const key = `${scale}|${JSON.stringify(recipe)}`;
  const hit = forgedArt.get(key);
  if (hit) {
    forgedArt.delete(key);
    forgedArt.set(key, hit);
    return hit;
  }
  const f = forge({ ...recipe, scale });
  forgedArt.set(key, f);
  forgedBytes += f.image.data.length;
  for (const [k, v] of forgedArt) {
    if (forgedBytes <= ART_BYTES) break;
    forgedArt.delete(k);
    forgedBytes -= v.image.data.length;
  }
  return f;
}

/** Preview forges by scale (memory only), started afresh now and then so a worker doesn't keep every skin it made. */
const previewForges = new Map<number, SkinForge>();
let previewJobs = 0;
function previewForge(scale: number): SkinForge {
  if (++previewJobs % 40 === 0) previewForges.clear();
  let sf = previewForges.get(scale);
  if (!sf) previewForges.set(scale, (sf = new SkinForge(null, scale)));
  return sf;
}

/**
 * Screens with every skin forged at `scale` and worn exactly as the game wears them (resolve.ts prepareSkins: art at
 * an element's own size stretched, resizable ones 9-sliced with a narrow centre, states' art, labels), and the art
 * by its image ref.
 */
export async function wearAt(screens: UiNode[], scale: number, pause: () => Promise<void>, gpu = true): Promise<{ screens: UiNode[]; art: Map<string, RgbaImage>; errors: string[] }> {
  await pause();
  // A CPU-only run forges in a forge of its own, so the GPU's art can't stand in for it.
  const sf = gpu ? previewForge(scale) : new SkinForge(null, scale);
  // Every skin in batches first (on the GPU when there is one), so wearing them is all cache hits.
  if (gpu) await warmSkins(screens, sf);
  const p = prepareSkins(screens, sf);
  const art = new Map<string, RgbaImage>();
  for (const [k, f] of p.used) art.set(`skin:${k}`, f.image);
  return { screens: p.screens, art, errors: p.errors };
}

// ─── Backdrops ─────────────────────────────────────────────────────────────────────────────────────

const backdrops = new Map<string, RgbaImage>();

/** A scene-like backdrop in a direction's mood (sky for candy, a forge's glow for ember, a grid at night for neon…). */
export function lookBackdrop(direction: string): RgbaImage {
  const hit = backdrops.get(direction);
  if (hit) return hit;
  const W = 640;
  const H = 360;
  const data = new Uint8Array(W * H * 4);
  const mix = (a: number[], b: number[], t: number) => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const look: Record<string, { top: string; bottom: string; glow: string; glowAt: [number, number]; grid?: string; specks?: string }> = {
    candy: { top: '#4fb9ff', bottom: '#bff0ff', glow: '#ffffff', glowAt: [0.3, 0.25] },
    ember: { top: '#140b08', bottom: '#4a1a0a', glow: '#ff6a1a', glowAt: [0.5, 1.05], specks: '#ffb347' },
    neon: { top: '#050b14', bottom: '#0c1f33', glow: '#ff3fd2', glowAt: [0.5, 1.1], grid: '#3fe6ff' },
    parchment: { top: '#1f130a', bottom: '#4a2f17', glow: '#ffcf7a', glowAt: [0.5, 0.35] },
    frost: { top: '#c9d6ee', bottom: '#eef3fb', glow: '#ffffff', glowAt: [0.7, 0.2] },
    // A night garage: blue-black, a floor of tiles, a car's orange under-glow.
    motorsport: { top: '#04060c', bottom: '#0e1729', glow: '#ff5a1a', glowAt: [0.5, 1.12], grid: '#4a78c8' },
  };
  // A look without a scene of its own: its backdrop colour, darker above, with a soft light.
  const own = DIRECTIONS[direction]?.backdrop;
  const ownHex = typeof own === 'string' ? own : Array.isArray(own) ? `#${own.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : '#1b2230';
  const shade = (h: string, k: number) => `#${[1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('')}`;
  const L = look[direction] ?? { top: shade(ownHex, 0.55), bottom: ownHex, glow: shade(ownHex, 1.9), glowAt: [0.5, 0.3] as [number, number] };
  const top = hex(L.top);
  const bottom = hex(L.bottom);
  const glow = hex(L.glow);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      let c = mix(top, bottom, v);
      const d = Math.hypot((u - L.glowAt[0]) * 1.6, v - L.glowAt[1]);
      c = mix(c, glow, Math.max(0, 0.55 - d) * 0.9);
      if (L.grid) {
        // A floor grid in perspective below the horizon.
        const hz = 0.62;
        if (v > hz) {
          const depth = (v - hz) / (1 - hz);
          const gx = Math.abs((((u - 0.5) / Math.max(0.05, depth)) * 6) % 1);
          const gy = Math.abs(((1 / Math.max(0.05, depth)) * 1.5) % 1);
          const line = Math.max(gx < 0.04 || gx > 0.96 ? 1 : 0, gy < 0.08 ? 1 : 0) * depth;
          c = mix(c, hex(L.grid), line * 0.35);
        }
      }
      if (L.specks) {
        const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const r = h - Math.floor(h);
        if (r > 0.9985) c = mix(c, hex(L.specks), 0.9 * v);
      }
      // A soft vignette.
      const vig = Math.hypot(u - 0.5, v - 0.5) * 1.25;
      c = mix(c, [0, 0, 0], Math.max(0, vig - 0.45) * 0.6);
      const o = (y * W + x) * 4;
      data[o] = Math.round(c[0]!);
      data[o + 1] = Math.round(c[1]!);
      data[o + 2] = Math.round(c[2]!);
      data[o + 3] = 255;
    }
  const img = { width: W, height: H, data };
  backdrops.set(direction, img);
  return img;
}

// ─── PNG with row filters (pictures of screens are mostly gradients: filtering halves them) ─────────

let crcTable: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG bytes: RGB when every pixel is opaque, each row with the Sub or Up filter that suits it. */
export function encodePreviewPng(img: RgbaImage): Uint8Array {
  const { width: w, height: h, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  const ch = opaque ? 3 : 4;
  const stride = w * ch;
  const raw = new Uint8Array(stride * h);
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < ch; k++) raw[o++] = data[(y * w + x) * 4 + k]!;
  const rows = new Uint8Array((stride + 1) * h);
  const sub = new Uint8Array(stride);
  const up = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const r = y * stride;
    let sumSub = 0;
    let sumUp = 0;
    for (let i = 0; i < stride; i++) {
      const a = raw[r + i]!;
      const s = (a - (i >= ch ? raw[r + i - ch]! : 0)) & 255;
      const u = (a - (y > 0 ? raw[r - stride + i]! : 0)) & 255;
      sub[i] = s;
      up[i] = u;
      sumSub += s < 128 ? s : 256 - s;
      sumUp += u < 128 ? u : 256 - u;
    }
    const o = y * (stride + 1);
    if (sumUp < sumSub) {
      rows[o] = 2;
      rows.set(up, o + 1);
    } else {
      rows[o] = 1;
      rows.set(sub, o + 1);
    }
  }
  const be = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (kind: string, body: Uint8Array): Uint8Array[] => {
    const k = new Uint8Array([...kind].map((c) => c.charCodeAt(0)));
    return [be(body.length), k, body, be(crc32([k, body]))];
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(be(w), 0);
  ihdr.set(be(h), 4);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunk('IHDR', ihdr), ...chunk('IDAT', new Uint8Array(deflateSync(rows, { level: 6 }))), ...chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ─── Jobs ──────────────────────────────────────────────────────────────────────────────────────────

/** Draws a job. Errors in a design come back in the result; a job that can't run at all throws. */
export async function runForgeJob(job: ForgeJob, pause: () => Promise<void> = async () => {}): Promise<ForgeResult> {
  const t0 = Date.now();
  if (job.resources) setForgeResources(job.resources);
  if (job.kind === 'worn') {
    // A forge of its own: the art is kept on disk, and a worker doesn't hold every skin it ever forged in memory.
    const sf = new SkinForge(job.cacheDir);
    const screens: WornResult['screens'] = {};
    const used = new Map<string, Forged>();
    const errors = new Set<string>();
    const byDevice = job.devices.map((device) => ({ device, screens: resolveVersion({ screens: job.screens, ...(job.theme ? { theme: job.theme } : {}) }, device).screens }));
    // Every device's skins in batches first (on the GPU when there is one).
    await warmSkins(byDevice.flatMap((x) => x.screens), sf);
    for (const { device, screens: resolved } of byDevice) {
      await pause();
      const p = prepareSkins(resolved, sf);
      screens[device] = p.screens;
      for (const [k, f] of p.used) used.set(k, f);
      for (const e of p.errors) errors.add(e);
    }
    const skins = [...used].map(([key, f]) => ({ key, w: f.image.width, h: f.image.height, png: job.cacheDir && existsSync(join(job.cacheDir, `${skinFile(key)}.png`)) ? null : encodePreviewPng(f.image) }));
    return { kind: 'worn', screens, skins, errors: [...errors], ms: Date.now() - t0 };
  }
  if (job.kind === 'elements') {
    const items: ElementResult[] = [];
    for (const it of job.items) {
      await pause();
      try {
        const f = forgeCached(it.spec, it.size, job.forgeScale);
        items.push({ spec: it.spec, png: encodePreviewPng(f.image), w: f.image.width, h: f.image.height, margin: f.margin });
      } catch (e) {
        items.push({ spec: it.spec, png: null, w: 0, h: 0, margin: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { kind: 'elements', items, ms: Date.now() - t0 };
  }
  const dev = labDevice(job.device);
  if (!dev) throw new Error(`No device "${job.device}"`);
  const resolved = resolveVersion({ screens: job.screens, ...(job.theme ? { theme: job.theme } : {}) }, formDevice(dev)).screens;
  const worn = await wearAt(resolved, job.forgeScale, pause, job.gpu !== false);
  const tSkins = Date.now() - t0;
  await pause();
  const glyphs = projectImages('', job.resources);
  const images = (ref: string, px: number): RgbaImage | null => worn.art.get(ref) ?? glyphs(ref, px);
  const backdrop = job.backdrop.kind === 'look' ? lookBackdrop(job.backdrop.direction) : job.backdrop.kind === 'image' ? decodeImage(job.backdrop.bytes) : 'dark';
  const view = renderLab(worn.screens, dev, { images, roblox: job.roblox, core: { chat: false, playerList: false }, backdrop, scale: job.scale, rulers: false, measure: robloxMeasure, fonts: robloxFontPicker });
  await pause();
  const png = encodePreviewPng(view.image);
  // Notes about sizes Roblox would shrink are about the game's art, not this preview's.
  const ms = Date.now() - t0;
  return { kind: 'screen', png, w: view.image.width, h: view.image.height, errors: worn.errors, notes: view.notes.filter((n) => !/^skin:/.test(n)), ms, timings: { skins: tSkins, draw: ms - tSkins } };
}
