import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The game's generated VFX textures: effects/textures/<Name>.tex.json (the parameters it was made from, its
 * analysis, its upload) beside the image in assets/vfx/<Name>.png. Effects use one as "tex:<Name>"; until
 * it is uploaded (and its image id known), the builder uses the closest texture that ships with Roblox.
 */
export const TEX_DIR = 'effects/textures';
export const TEX_ASSET_DIR = 'assets/vfx';

export interface TextureEntry {
  name: string;
  kind: string;
  params: Record<string, unknown>;
  /** Pixels on a side. */
  size: number;
  /** Flipbook cells per side (2, 4 or 8) when it is a flipbook. */
  grid?: number;
  /** The PNG, relative to the project. */
  file: string;
  /** The analysis line from when it was made. */
  analysis?: string;
  /** The Image asset id effects use (rbxassetid://<imageId>). */
  imageId?: string;
  /** The Decal asset Open Cloud made (its image id is resolved in Studio). */
  decalId?: string;
  upload?: { operation?: string; error?: string; at: string };
  /** A built-in Roblox texture of the same family, used until it is uploaded. */
  fallback: string;
  createdBy?: string;
  updatedAt: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

export class TextureLibrary {
  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, TEX_DIR);
  }

  names(): string[] {
    if (!existsSync(this.dir())) return [];
    return readdirSync(this.dir())
      .filter((f) => f.endsWith('.tex.json'))
      .map((f) => f.slice(0, -'.tex.json'.length))
      .sort((a, b) => a.localeCompare(b));
  }

  get(name: string): TextureEntry | null {
    const f = join(this.dir(), `${name}.tex.json`);
    if (!existsSync(f)) return null;
    try {
      const e = JSON.parse(readFileSync(f, 'utf8')) as TextureEntry;
      return { ...e, updatedAt: e.updatedAt ?? statSync(f).mtime.toISOString() };
    } catch {
      return null;
    }
  }

  all(): TextureEntry[] {
    return this.names()
      .map((n) => this.get(n))
      .filter((e): e is TextureEntry => !!e);
  }

  save(entry: Omit<TextureEntry, 'updatedAt'>, png?: Buffer): TextureEntry {
    if (!NAME.test(entry.name)) throw new Error('A texture name is letters, digits and _ (starting with a letter)');
    mkdirSync(this.dir(), { recursive: true });
    if (png) {
      mkdirSync(join(this.root, TEX_ASSET_DIR), { recursive: true });
      writeFileSync(join(this.root, entry.file), png);
    }
    const saved: TextureEntry = { ...entry, updatedAt: new Date().toISOString() };
    writeFileSync(join(this.dir(), `${entry.name}.tex.json`), `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
    return saved;
  }

  update(name: string, patch: Partial<TextureEntry>): TextureEntry | null {
    const e = this.get(name);
    if (!e) return null;
    return this.save({ ...e, ...patch });
  }

  remove(name: string): boolean {
    const e = this.get(name);
    if (!e) return false;
    rmSync(join(this.dir(), `${name}.tex.json`), { force: true });
    rmSync(join(this.root, e.file), { force: true });
    return true;
  }

  /** What an effect's "tex:<Name>" becomes in the place: the uploaded image, else the built-in stand-in. */
  resolve(name: string): { id: string; uploaded: boolean } | null {
    const e = this.get(name);
    if (!e) return null;
    return e.imageId ? { id: `rbxassetid://${e.imageId}`, uploaded: true } : { id: e.fallback, uploaded: false };
  }
}
