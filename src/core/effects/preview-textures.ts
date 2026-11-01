import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLOW_TEX } from '@shared/fx/mesh';
import { decodePng, encodePng, type RgbaImage } from '../modeling/png';
import { TextureLibrary } from './textures/library';
import { draw, type TextureKind } from './textures/generators';

/**
 * The pictures behind an effect's texture references, for drawing it outside Roblox (the preview in the
 * app, the contact sheets agents look at): the game's generated textures ("tex:<Name>", and their uploaded
 * ids) are their own PNGs; Roblox's built-in particle textures, which Shuriken can't ship, are look-alikes
 * drawn by the texture generator; anything else (an asset id Shuriken didn't make) is a soft glow, and says so.
 */
export interface PreviewTexture {
  image: RgbaImage;
  /** Why this isn't the texture the game shows (absent: it is, or looks like it). */
  note?: string;
  /** The PNG it was read from (the game's own textures). */
  file?: string;
}

const BUILT_IN: Array<[RegExp, TextureKind, Record<string, unknown>]> = [
  [/sparkles_main/, 'star', { points: 4, spikiness: 0.8, glow: 0.7, irregular: 0 }],
  [/fire_sparks_main/, 'spark', {}],
  [/fire_main/, 'fire', { shape: 'ball' }],
  [/explosion01_smoke_main|smoke_main/, 'smoke', {}],
  [/explosion01_core_main|explosion01_implosion_main/, 'glow', {}],
  [/explosion01_shockwave_main/, 'ring', {}],
  [/forcefield_vortex_main/, 'energy', { shape: 'orb' }],
  [/forcefield_glow_main/, 'soft', {}],
];

const generated = new Map<string, RgbaImage>();
function lookAlike(key: string, kind: TextureKind, params: Record<string, unknown>): RgbaImage {
  let img = generated.get(key);
  if (!img) {
    img = draw(kind, params, 128, 1, 1).raster.toImage(1);
    generated.set(key, img);
  }
  return img;
}

function square(): RgbaImage {
  const data = new Uint8Array(16 * 16 * 4).fill(255);
  return { width: 16, height: 16, data };
}

const soft = () => lookAlike('soft', 'soft', {});

export class PreviewTextures {
  private readonly files = new Map<string, { mtime: number; image: RgbaImage }>();
  private readonly lib: TextureLibrary | null;

  /** `root`: the project whose textures "tex:<Name>" names (none: only built-ins resolve). */
  constructor(private readonly root: string | null) {
    this.lib = root ? new TextureLibrary(root) : null;
  }

  private file(rel: string): PreviewTexture | null {
    if (!this.root) return null;
    const f = join(this.root, rel);
    if (!existsSync(f)) return null;
    try {
      const mtime = statSync(f).mtimeMs;
      const hit = this.files.get(f);
      if (hit && hit.mtime === mtime) return { image: hit.image, file: f };
      const image = decodePng(readFileSync(f));
      this.files.set(f, { mtime, image });
      return { image, file: f };
    } catch {
      return null;
    }
  }

  get(ref: string): PreviewTexture {
    if (ref === GLOW_TEX) return { image: soft() };
    if (ref.startsWith('tex:')) {
      const entry = this.lib?.get(ref.slice(4));
      return (entry ? this.file(entry.file) : null) ?? { image: soft(), note: `${ref} has no texture in this project (vfx_texture makes it): a soft glow stands in.` };
    }
    const id = /^rbxassetid:\/\/(\d+)/.exec(ref)?.[1];
    if (id) {
      const entry = this.lib?.all().find((t) => t.imageId === id || t.decalId === id);
      return (entry ? this.file(entry.file) : null) ?? { image: soft(), note: `${ref} is an image on Roblox that can't be read here: a soft glow stands in.` };
    }
    if (/SquareParticle/i.test(ref)) return { image: generated.get('square') ?? (generated.set('square', square()), generated.get('square')!) };
    for (const [re, kind, params] of BUILT_IN) if (re.test(ref)) return { image: lookAlike(String(re), kind, params) };
    return { image: soft(), note: `${ref} can't be read here: a soft glow stands in.` };
  }

  /**
   * The texture as a PNG data URL (for the app's preview) with a stamp that changes when its pixels do;
   * `have`: the stamp the caller holds, and the picture is left out when it still matches.
   */
  dataUrl(ref: string, have?: string): { url?: string; stamp: string; note?: string } {
    const t = this.get(ref);
    const stamp = t.file ? `file:${statSync(t.file).mtimeMs}` : t.note ? 'stand-in' : 'built-in';
    if (have === stamp) return { stamp, ...(t.note ? { note: t.note } : {}) };
    const png = t.file ? readFileSync(t.file) : encodePng(t.image);
    return { url: `data:image/png;base64,${png.toString('base64')}`, stamp, ...(t.note ? { note: t.note } : {}) };
  }
}
