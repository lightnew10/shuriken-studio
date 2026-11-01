import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UiNode } from '@shared/ui-layout';
import { encodePng, type RgbaImage } from '../../modeling/png';
import { findRobloxFonts } from '../lab/roblox-fonts';
import type { Forged } from './forge';
import { prepareSkins, type SkinForge } from './resolve';
import { SKIN_DIR } from './skins';

/**
 * Forged skins on their way into the game. A design's screens are worn (each skin forged at its element's size), the
 * art is packed into atlases (`ui/skins/atlas-<hash>.png`, at most 1024 px a side, listed in atlases.json with their
 * upload ids) and every "skin:<key>" image becomes a sprite of one: the uploaded atlas ("rbxassetid://…") with its
 * ImageRectOffset/Size — measured in Studio: a 9-slice's SliceCenter is relative to the rect — or, until it is
 * uploaded, a Studio preview ("rbxasset://shuriken-forge/…", the PNG copied into this PC's Studio content folder;
 * Studio loads it there, players never see it). One upload per atlas instead of one per piece of art.
 */

/** The folder of Studio's content that holds previews (inside the newest Studio version; an update clears it). */
export const PREVIEW_FOLDER = 'shuriken-forge';
/** Roblox's largest image side (bigger ones are shrunk on load). */
const ATLAS_MAX = 1024;
/** Space round each sprite: a 1-px copy of its edge (bilinear sampling at the edge reads it), then 1 px clear. */
const PAD = 2;

export interface AtlasRecord {
  file: string;
  size: [number, number];
  /** The uploaded image, once it is on Roblox. */
  imageId?: string;
  decalId?: string;
  error?: string;
}

export interface Placement {
  atlas: string;
  /** ImageRectOffset and ImageRectSize, in the atlas's pixels. */
  rect: [number, number, number, number];
}

export interface Packed {
  atlases: Array<{ hash: string; image: RgbaImage }>;
  placements: Map<string, Placement>;
}

/** FNV-1a over the pixels and size: an atlas's name, so the same art is the same file (and the same upload). */
function hashImage(img: RgbaImage): string {
  let h = 2166136261 ^ img.width ^ (img.height << 16);
  const d = img.data;
  for (let i = 0; i < d.length; i += 3) h = Math.imul(h ^ d[i]!, 16777619);
  return (h >>> 0).toString(36);
}

/** Shelf-packs the art (tallest first) into as few atlases as fit 1024 px a side; each sprite's edge is extruded. */
export function packAtlases(items: Array<{ key: string; image: RgbaImage }>): Packed {
  const order = [...items].sort((a, b) => b.image.height - a.image.height || b.image.width - a.image.width || a.key.localeCompare(b.key));
  type Sheet = { w: number; h: number; x: number; y: number; row: number; put: Array<{ key: string; image: RgbaImage; x: number; y: number }> };
  const sheets: Sheet[] = [];
  const newSheet = (): Sheet => {
    const s: Sheet = { w: 0, h: 0, x: 0, y: 0, row: 0, put: [] };
    sheets.push(s);
    return s;
  };
  for (const it of order) {
    const w = it.image.width + 2 * PAD;
    const h = it.image.height + 2 * PAD;
    let placed = false;
    for (const s of sheets) {
      if (s.x + w > ATLAS_MAX) {
        s.x = 0;
        s.y += s.row;
        s.row = 0;
      }
      if (s.y + h <= ATLAS_MAX && s.x + w <= ATLAS_MAX) {
        s.put.push({ ...it, x: s.x + PAD, y: s.y + PAD });
        s.x += w;
        s.row = Math.max(s.row, h);
        s.w = Math.max(s.w, s.x);
        s.h = Math.max(s.h, s.y + s.row);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const s = newSheet();
      s.put.push({ ...it, x: PAD, y: PAD });
      s.x = Math.min(ATLAS_MAX, w);
      s.row = h;
      s.w = s.x;
      s.h = Math.min(ATLAS_MAX, h);
    }
  }
  const atlases: Packed['atlases'] = [];
  const placements = new Map<string, Placement>();
  for (const s of sheets) {
    const W = Math.min(ATLAS_MAX, s.w);
    const H = Math.min(ATLAS_MAX, s.h);
    const data = new Uint8Array(W * H * 4);
    for (const p of s.put) {
      const { image: im, x: ox, y: oy } = p;
      // The sprite, then its edge pixels copied one pixel out (clamped sampling at the rect's edge).
      for (let y = -1; y <= im.height; y++) {
        const sy = Math.min(im.height - 1, Math.max(0, y));
        const ty = oy + y;
        if (ty < 0 || ty >= H) continue;
        for (let x = -1; x <= im.width; x++) {
          const sx = Math.min(im.width - 1, Math.max(0, x));
          const tx = ox + x;
          if (tx < 0 || tx >= W) continue;
          const si = (sy * im.width + sx) * 4;
          data.set(im.data.subarray(si, si + 4), (ty * W + tx) * 4);
        }
      }
    }
    const image = { width: W, height: H, data };
    const hash = hashImage(image);
    atlases.push({ hash, image });
    for (const p of s.put) placements.set(p.key, { atlas: hash, rect: [p.x, p.y, p.image.width, p.image.height] });
  }
  return { atlases, placements };
}

/** The project's atlases (ui/skins/atlases.json) and their upload ids. */
export class AtlasStore {
  constructor(private readonly root: string) {}

  private get dir(): string {
    return join(this.root, SKIN_DIR);
  }

  all(): Record<string, AtlasRecord> {
    try {
      return (JSON.parse(readFileSync(join(this.dir, 'atlases.json'), 'utf8')) as { atlases: Record<string, AtlasRecord> }).atlases ?? {};
    } catch {
      return {};
    }
  }

  /** Writes the atlases' PNGs (keeping what is known of ones already there: the same pixels are the same upload). */
  save(packed: Packed): Record<string, AtlasRecord> {
    mkdirSync(this.dir, { recursive: true });
    const all = this.all();
    for (const a of packed.atlases) {
      const file = `atlas-${a.hash}.png`;
      if (!existsSync(join(this.dir, file))) writeFileSync(join(this.dir, file), encodePng(a.image));
      all[a.hash] = { ...(all[a.hash] ?? {}), file, size: [a.image.width, a.image.height] };
    }
    this.write(all);
    return all;
  }

  update(hash: string, patch: Partial<Pick<AtlasRecord, 'imageId' | 'decalId' | 'error'>>): void {
    const all = this.all();
    const r = all[hash];
    if (!r) return;
    all[hash] = { ...r, ...patch };
    for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (patch[k] === undefined) delete all[hash]![k];
    this.write(all);
  }

  file(hash: string): string {
    return join(this.dir, this.all()[hash]?.file ?? `atlas-${hash}.png`);
  }

  private write(all: Record<string, AtlasRecord>): void {
    writeFileSync(join(this.dir, 'atlases.json'), JSON.stringify({ atlases: all }, null, 1));
  }
}

/** What uploading needs from the app (Open Cloud, the creator, the content check, Studio to read an image id). */
export interface AtlasUploadDeps {
  /** The Roblox user the decals are made by, or null when unknown. */
  creator: () => Promise<string | null>;
  upload: (file: string, name: string, description: string, userId: string) => Promise<{ ok: boolean; assetId?: string; error?: string }>;
  /** Why the picture must not be uploaded (Roblox removes such images), or null. */
  blocked: (file: string) => string | null;
  /** The image id of an uploaded decal (read in Studio), or undefined while it isn't known (moderation). */
  imageId: (decalId: string) => Promise<string | undefined>;
}

/**
 * Uploads the atlases among `hashes` that aren't on Roblox yet, one decal each, and records their image ids; an atlas
 * uploaded before whose image id wasn't readable is read again. Short lines saying what happened.
 */
export async function uploadSkinAtlases(root: string, hashes: string[], d: AtlasUploadDeps): Promise<string[]> {
  const store = new AtlasStore(root);
  const all = store.all();
  const todo = [...new Set(hashes)].filter((h) => all[h] && !all[h]!.imageId);
  if (!todo.length) return [];
  const who = await d.creator();
  if (!who) return ['not uploaded: uploading needs the Roblox creator (sign in to Studio, or set the creator id in Settings)'];
  const out: string[] = [];
  let uploaded = 0;
  for (const h of todo) {
    let decalId = all[h]!.decalId;
    if (!decalId) {
      const file = store.file(h);
      const why = d.blocked(file);
      if (why) {
        store.update(h, { error: why });
        out.push(`atlas ${h} NOT uploaded: it has ${why}`);
        continue;
      }
      const r = await d.upload(file, `UI art atlas ${h}`, 'Game UI art (a sprite sheet), forged with Shuriken Studio', who);
      if (!r.ok || !r.assetId) {
        store.update(h, { error: r.error ?? 'unknown error' });
        out.push(`atlas ${h} not uploaded: ${r.error ?? 'unknown error'}`);
        continue;
      }
      decalId = r.assetId;
      store.update(h, { decalId, error: undefined });
    }
    const imageId = await d.imageId(decalId);
    if (imageId) {
      store.update(h, { imageId });
      uploaded++;
    } else out.push(`atlas ${h} uploaded as decal ${decalId}; its image id isn't readable yet (moderation): build again later`);
  }
  if (uploaded) out.unshift(`${uploaded} atlas${uploaded === 1 ? '' : 'es'} uploaded`);
  return out;
}

/** Every form's screens with their skins worn, and the art they use (forged once across the forms). */
export function forgeForBuild(forms: Record<string, UiNode[]>, sf: SkinForge): { worn: Record<string, UiNode[]>; art: Map<string, Forged>; errors: string[] } {
  const worn: Record<string, UiNode[]> = {};
  const art = new Map<string, Forged>();
  const errors = new Set<string>();
  for (const [form, screens] of Object.entries(forms)) {
    const p = prepareSkins(screens, sf);
    p.errors.forEach((e) => errors.add(e));
    worn[form] = p.screens;
    for (const [key, forged] of p.used) if (!art.has(key)) art.set(key, forged);
  }
  return { worn, art, errors: [...errors] };
}

/** Copies atlases into Studio's content folder for a preview on this PC; the folder, or null when Studio isn't installed. */
export function copyPreviews(root: string, hashes: string[]): string | null {
  const install = findRobloxFonts();
  if (!install) return null;
  const dir = join(dirname(install.fonts), PREVIEW_FOLDER);
  const store = new AtlasStore(root);
  try {
    mkdirSync(dir, { recursive: true });
    for (const h of hashes) {
      const f = store.file(h);
      copyFileSync(f, join(dir, f.split(/[\\/]/).pop()!));
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * The screens with every "skin:<key>" image a sprite of its atlas: the uploaded atlas, or a Studio preview of it. Also
 * the art states swap to. `previews`: the atlases shown as previews only (not uploaded).
 */
export function pointSkins(forms: Record<string, UiNode[]>, placements: Map<string, Placement>, atlases: Record<string, AtlasRecord>): { forms: Record<string, UiNode[]>; previews: string[] } {
  const previews = new Set<string>();
  const sprite = (image: string): { image: string; rect: [number, number, number, number] } | null => {
    const p = image.startsWith('skin:') ? placements.get(image.slice(5)) : undefined;
    if (!p) return null;
    const a = atlases[p.atlas];
    if (!a?.imageId) previews.add(p.atlas);
    return { image: a?.imageId ? `rbxassetid://${a.imageId}` : `rbxasset://${PREVIEW_FOLDER}/${a?.file ?? `atlas-${p.atlas}.png`}`, rect: p.rect };
  };
  const walk = (n: UiNode): UiNode => {
    let out = n.kids ? { ...n, kids: n.kids.map(walk) } : n;
    const s = n.image ? sprite(n.image) : null;
    if (s) out = { ...out, image: s.image, rect: s.rect };
    if (n.states && Object.values(n.states).some((p) => p?.skinArt)) {
      const states: NonNullable<UiNode['states']> = {};
      for (const [st, p] of Object.entries(n.states)) {
        if (!p) continue;
        const sa = p.skinArt ? sprite(p.skinArt.image) : null;
        states[st as keyof typeof states] = p.skinArt && sa ? { ...p, skinArt: { ...p.skinArt, image: sa.image, rect: sa.rect } } : p;
      }
      out = { ...out, states };
    }
    return out;
  };
  const outForms: Record<string, UiNode[]> = {};
  for (const [form, screens] of Object.entries(forms)) outForms[form] = screens.map(walk);
  return { forms: outForms, previews: [...previews] };
}
