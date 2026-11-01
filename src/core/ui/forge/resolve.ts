import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UiNode } from '@shared/ui-layout';
import { decodePng, encodePng, type RgbaImage } from '../../modeling/png';
import { DIRECTIONS, inkFor, type TextInk } from './directions';
import type { Color } from './style';
import { forge, FORGE_VERSION, type Forged, type ForgeSpec } from './forge';
import { applySkins } from './skins';
import { elementSpec, forgeSize, parseSkin, requestOf, skinFile, skinKey, SLICED, type SkinSpec } from './spec';

/**
 * Skins forged on demand: a design's `skin` specs are parsed, forged at each element's size, cached in memory and
 * (when given a folder) on disk, and worn — the screens come back with every skin as its "Skin" art child and an image
 * source for the renderer ("skin:<spec>@<w>x<h>"). Unknown specs are reported, never thrown.
 */
export class SkinForge {
  private readonly mem = new Map<string, Forged>();
  /** Stretch keys whose art had to be narrowed (shown 9-sliced instead). */
  private readonly sliceOnly = new Set<string>();

  /**
   * `scale`: art pixels per point when not the game's (previews forge smaller, faster art); such a forge keeps its art
   * in memory or in a folder of its own, never in the project's skin cache (its keys don't carry the scale).
   */
  constructor(
    private readonly dir: string | null = null,
    private readonly scale?: number,
  ) {}

  /**
   * The forged art for a spec at a size (cached). `fit` is how the element shows it: "stretch" for an element drawn
   * at this size (offsets, scaled only uniformly by UIScale: the art is exact), "slice" for one whose size changes
   * (a bar's fill, a scale-sized box). Sliced art is forged with a narrow centre that only ever stretches — measured
   * in Studio: Roblox never shrinks a 9-slice's centre, it crops it — so its key ends in "~9".
   */
  get(spec: string, size: [number, number], fit: 'stretch' | 'slice' = 'slice'): { key: string; forged: Forged } | { error: string } {
    const key = skinKey(spec, size) + (fit === 'slice' ? SLICED : '');
    // Stretched art that had to be narrowed to fit 1024 px is shown 9-sliced (found once per session).
    if (fit === 'stretch' && this.sliceOnly.has(key)) return this.get(spec, size, 'slice');
    const hit = this.mem.get(key) ?? this.fromDisk(key);
    if (hit) {
      this.mem.set(key, hit);
      return { key, forged: hit };
    }
    const p = parseSkin(spec);
    if ('error' in p) return { error: p.error };
    let forged: Forged;
    try {
      const make = (s: [number, number], scale?: number) => {
        const spec = elementSpec(p.spec, s);
        return forge(scale ? { ...spec, scale } : spec);
      };
      forged = make(size, this.scale);
      // Roblox loads images at most 1024 px a side (bigger ones are scaled down and a 9-slice loses its far edges):
      // lower the scale, then for sliced art forge a smaller stretchable middle (the slices keep the corners).
      for (let i = 0; i < 6 && Math.max(forged.image.width, forged.image.height) > MAX_IMAGE_PX; i++) {
        const over = Math.max(forged.image.width, forged.image.height) / MAX_IMAGE_PX;
        if (forged.scale > 1.01) forged = make(size, Math.max(1, forged.scale / over - 0.01));
        else if (forged.slice) {
          const k = 1 / over - 0.02;
          forged = make([Math.max(32, Math.floor(forged.size[0] * (forged.image.width > MAX_IMAGE_PX ? k : 1))), Math.max(32, Math.floor(forged.size[1] * (forged.image.height > MAX_IMAGE_PX ? k : 1)))], 1);
        } else forged = make(size, Math.max(0.25, forged.scale / over - 0.01));
      }
    } catch (e) {
      return { error: `"${spec}": ${e instanceof Error ? e.message : String(e)}` };
    }
    // Art narrowed to fit 1024 px can only be shown 9-sliced.
    if (fit === 'stretch' && forged.drawn) {
      this.sliceOnly.add(key);
      return this.get(spec, size, 'slice');
    }
    if (fit === 'slice' && forged.slice) {
      try {
        const narrow = narrowSize(forged);
        if (narrow[0] < forged.size[0] - 0.5 || narrow[1] < forged.size[1] - 0.5) {
          const spec2 = elementSpec(p.spec, narrow);
          const n = forge({ ...spec2, scale: forged.scale });
          if (n.slice) forged = { ...n, drawn: narrow };
        }
      } catch {
        /* the full-size art, sliced as it is */
      }
    }
    this.mem.set(key, forged);
    this.toDisk(key, forged);
    return { key, forged };
  }

  /**
   * Forges what `items` need and the cache lacks in two batches through the registered batch renderer (the GPU): the
   * art, then sliced art's narrow versions. Without one, or for any item it can't draw, `get` forges on the CPU later.
   */
  async warm(items: Array<{ spec: string; size: [number, number]; fit: 'stretch' | 'slice' }>): Promise<void> {
    const batch = forgeBatch;
    if (!batch) return;
    type Job = { spec: string; size: [number, number]; fit: 'stretch' | 'slice'; key: string; s: SkinSpec };
    const jobs: Job[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const key = skinKey(it.spec, it.size) + (it.fit === 'slice' ? SLICED : '');
      if (seen.has(key) || this.sliceOnly.has(key) || this.mem.has(key) || this.fromDisk(key)) continue;
      seen.add(key);
      const p = parseSkin(it.spec);
      if ('error' in p) continue;
      jobs.push({ ...it, key, s: p.spec });
    }
    if (!jobs.length) return;
    const specOf = (j: Job, size: [number, number], scale?: number): ForgeSpec => {
      const f = elementSpec(j.s, size);
      const k = scale ?? this.scale;
      return k ? { ...f, scale: k } : f;
    };
    let first: Array<Forged | null>;
    try {
      first = await batch(jobs.map((j) => specOf(j, j.size)));
    } catch {
      return;
    }
    const narrowJobs: Array<{ j: Job; key: string; narrow: [number, number]; full: Forged }> = [];
    jobs.forEach((j, i) => {
      const f = first[i];
      // Missing, or over Roblox's 1024 px: the CPU path (it lowers the scale) handles it.
      if (!f || Math.max(f.image.width, f.image.height) > MAX_IMAGE_PX) return;
      if (j.fit === 'stretch' && !f.drawn) return this.keep(j.key, f);
      const key = j.fit === 'stretch' ? skinKey(j.spec, j.size) + SLICED : j.key;
      if (j.fit === 'stretch') this.sliceOnly.add(j.key);
      if (!f.slice) return this.keep(key, f);
      const narrow = narrowSize(f);
      if (narrow[0] < f.size[0] - 0.5 || narrow[1] < f.size[1] - 0.5) narrowJobs.push({ j, key, narrow, full: f });
      else this.keep(key, f);
    });
    if (!narrowJobs.length) return;
    let second: Array<Forged | null> = [];
    try {
      second = await batch(narrowJobs.map((x) => specOf(x.j, x.narrow, x.full.scale)));
    } catch {
      /* the full-size art, sliced as it is */
    }
    narrowJobs.forEach((x, i) => {
      const n = second[i];
      this.keep(x.key, n?.slice ? { ...n, drawn: x.narrow } : x.full);
    });
  }

  private keep(key: string, f: Forged): void {
    this.mem.set(key, f);
    this.toDisk(key, f);
  }

  /** A recipe of the designer's own, worn as skin "custom:<name>" (kept with the project's skins). */
  saveCustom(name: string, f: Forged, _recipe: unknown): void {
    const key = `custom:${name}`;
    this.mem.set(key, f);
    this.toDisk(key, f);
  }

  image(key: string): RgbaImage | null {
    return (this.mem.get(key) ?? this.fromDisk(key))?.image ?? null;
  }

  forged(key: string): Forged | null {
    return this.mem.get(key) ?? this.fromDisk(key);
  }

  private fromDisk(key: string): Forged | null {
    if (!this.dir) return null;
    const base = join(this.dir, skinFile(key));
    if (!existsSync(`${base}.json`) || !existsSync(`${base}.png`)) return null;
    try {
      const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as Omit<Forged, 'image'> & { key: string; v: number };
      if (meta.key !== key || meta.v !== FORGE_CACHE_VERSION) return null;
      const f: Forged = { image: decodePng(readFileSync(`${base}.png`)), size: meta.size, margin: meta.margin, scale: meta.scale, slice: meta.slice, ...(meta.content ? { content: meta.content } : {}), ...(meta.drawn ? { drawn: meta.drawn } : {}) };
      this.mem.set(key, f);
      return f;
    } catch {
      return null;
    }
  }

  private toDisk(key: string, f: Forged): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const base = join(this.dir, skinFile(key));
      writeFileSync(`${base}.png`, encodePng(f.image));
      writeFileSync(`${base}.json`, JSON.stringify({ key, v: FORGE_CACHE_VERSION, size: f.size, margin: f.margin, scale: f.scale, slice: f.slice, content: f.content, drawn: f.drawn }));
    } catch {
      /* a cache that can't be written is only slower */
    }
  }
}

/** The smallest size whose art keeps every corner: the corners' reach plus a centre of 2 points. */
function narrowSize(f: Forged): [number, number] {
  const [x0, y0, x1, y1] = f.slice!;
  const s = f.scale;
  const W = f.image.width / s;
  const H = f.image.height / s;
  const m = f.margin;
  const reachX = x0 / s - m + (W - x1 / s - m);
  const reachY = y0 / s - m + (H - y1 / s - m);
  return [Math.min(f.size[0], Math.ceil(reachX + 2)), Math.min(f.size[1], Math.ceil(reachY + 2))];
}

/** Bump when the engine or directions change how art looks, so cached art is forged again. */
export const FORGE_CACHE_VERSION = 8 * 1000 + FORGE_VERSION;

/** The largest image side Roblox loads without scaling it down. */
export const MAX_IMAGE_PX = 1024;

/** Draws many forge specs at once (the GPU, through the app's render window); null entries are drawn on the CPU. */
export type ForgeBatch = (specs: ForgeSpec[]) => Promise<Array<Forged | null>>;
let forgeBatch: ForgeBatch | null = null;
/** Registers the batch renderer (or none: everything is forged on the CPU as it is asked for). */
export function setForgeBatch(fn: ForgeBatch | null): void {
  forgeBatch = fn;
}

/** Every skin the screens wear (base art and state art, at the size and fit `prepareSkins` will ask for). */
export function skinsNeeded(screens: UiNode[]): Array<{ spec: string; size: [number, number]; fit: 'stretch' | 'slice' }> {
  const out: Array<{ spec: string; size: [number, number]; fit: 'stretch' | 'slice' }> = [];
  const add = (spec: string, at: { size: UiNode['size']; fit: 'stretch' | 'slice' }) => {
    if (spec.startsWith('custom:') || spec.includes('@')) return;
    const p = parseSkin(spec);
    if ('error' in p) return;
    out.push({ spec, size: forgeSize(p.spec.kind, at.size), fit: at.fit });
  };
  const walk = (n: UiNode, parent: UiNode | null) => {
    if (n.skin) {
      const at = fitOf(n, parent);
      add(n.skin, at);
      for (const p of Object.values(n.states ?? {})) if (p?.skin) add(p.skin, at);
    }
    n.kids?.forEach((k) => walk(k, n));
  };
  screens.forEach((s) => walk(s, null));
  return out;
}

/** Forges every skin the screens need in batches (the GPU when registered), so wearing them after is all cache hits. */
export async function warmSkins(screens: UiNode[], sf: SkinForge = skinForgeFor(null)): Promise<void> {
  await sf.warm(skinsNeeded(screens));
}

/** One forge per cache folder (and one in memory for callers without a project). */
const forges = new Map<string, SkinForge>();
export function skinForgeFor(dir: string | null): SkinForge {
  const k = dir ?? '';
  let f = forges.get(k);
  if (!f) forges.set(k, (f = new SkinForge(dir)));
  return f;
}

/** A project's skin cache folder. */
export const skinCacheDir = (root: string): string => join(root, '.shuriken', 'ui', 'skin-cache');

export interface PreparedSkins {
  screens: UiNode[];
  /** Images for the renderer: "skin:<key>" refs, else null (chain it with the project's images). */
  images: (ref: string) => RgbaImage | null;
  /** The forged art used, by key (for building and uploading). */
  used: Map<string, Forged>;
  errors: string[];
}

/**
 * How an element shows its art: at its own size (offsets only, scaled uniformly by UIScale — a grid's cell decides its
 * children's size) the art is forged at that size and stretched, exactly; an element whose size changes (scale,
 * automatic size, flex, a list that fills, a size or aspect constraint) gets art that 9-slices.
 */
function fitOf(n: UiNode, parent: UiNode | null): { size: UiNode['size']; fit: 'stretch' | 'slice' } {
  const size = parent?.grid ? parent.grid.cell : n.size;
  const filled = !!parent?.list && (parent.list.hFlex === 'Fill' || parent.list.vFlex === 'Fill' || parent.list.itemAlign === 'Stretch');
  const fixed = !!size && size[0] === 0 && size[2] === 0 && !n.auto && !n.flex && !n.sizeMin && !n.sizeMax && !n.aspect && !filled;
  return { size, fit: fixed ? 'stretch' : 'slice' };
}

const rgb255 = (c: Color): [number, number, number] => {
  if (Array.isArray(c)) return [c[0], c[1], c[2]];
  const v = parseInt(c.replace('#', '').slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** The direction's ink for a skinned element's text where the design leaves it unset (colour, outline, font). */
function inked(n: UiNode, ink: TextInk): UiNode {
  if ((n.cls !== 'TextButton' && n.cls !== 'TextLabel') || !n.text || n.textColor !== undefined) return n;
  const out: UiNode = { ...n, textColor: rgb255(ink.color) };
  const hasTextStroke = (n.stroke?.text ?? false) || (n.strokes ?? []).some((s) => s.text);
  if (ink.stroke && (ink.strokePx ?? 0) > 0 && !hasTextStroke) out.stroke = { color: rgb255(ink.stroke), t: 0, px: ink.strokePx!, text: true };
  if (ink.font && !n.font) out.font = ink.font;
  if (ink.weight && n.weight === undefined && !n.bold) out.weight = ink.weight;
  return out;
}

/** Screens with every `skin` forged and worn (as each element's "Skin" child). */
export function prepareSkins(screens: UiNode[], sf: SkinForge = skinForgeFor(null)): PreparedSkins {
  const errors: string[] = [];
  const used = new Map<string, Forged>();
  /** A spec forged at an element's size: its key, or null (the reason recorded). */
  const keyOf = (spec: string, size: UiNode['size'], fit: 'stretch' | 'slice'): string | null => {
    if (spec.startsWith('custom:')) {
      const f = sf.forged(spec);
      if (!f) {
        errors.push(`"${spec}": no such custom skin (make it with ui_forge {action: "custom"})`);
        return null;
      }
      used.set(spec, f);
      return spec;
    }
    if (spec.includes('@')) return spec;
    const p = parseSkin(spec);
    if ('error' in p) {
      errors.push(p.error);
      return null;
    }
    const got = sf.get(spec, forgeSize(p.spec.kind, size), fit);
    if ('error' in got) {
      errors.push(got.error);
      return null;
    }
    used.set(got.key, got.forged);
    return got.key;
  };
  /** States that wear other art (a pressed button, an active tab): forged at the element's size too. */
  const keyedStates = (n: UiNode, at: { size: UiNode['size']; fit: 'stretch' | 'slice' }): UiNode => {
    if (!n.states || !Object.values(n.states).some((p) => p?.skin)) return n;
    const states: NonNullable<UiNode['states']> = {};
    for (const [name, p] of Object.entries(n.states) as Array<[keyof NonNullable<UiNode['states']>, NonNullable<UiNode['states']>[keyof NonNullable<UiNode['states']>]]>) {
      if (!p) continue;
      if (!p.skin) {
        states[name] = p;
        continue;
      }
      const { skin, ...rest } = p;
      if (!n.skin) {
        errors.push(`${n.name}: its ${name} state wears "${skin}" but the element wears no skin (give it one)`);
        states[name] = rest;
        continue;
      }
      const key = keyOf(skin, at.size, at.fit);
      // A state's art has its own ink (a disabled button's grey text) where the design didn't colour the text.
      const sp = n.textColor === undefined && n.text ? parseSkin(skin) : null;
      const ink = sp && 'spec' in sp && DIRECTIONS[sp.spec.direction] ? inkFor(DIRECTIONS[sp.spec.direction]!, requestOf(sp.spec, [1, 1])) : null;
      states[name] = key ? { ...rest, skin: key, ...(ink && rest.textColor === undefined ? { textColor: rgb255(ink.color) } : {}) } : rest;
    }
    return { ...n, states };
  };
  const keyed = (n: UiNode, parent: UiNode | null = null): UiNode => {
    const at = fitOf(n, parent);
    let out = keyedStates(n.kids ? { ...n, kids: n.kids.map((k) => keyed(k, n)) } : n, at);
    if (n.skin && n.skin.startsWith('custom:')) {
      const f = sf.forged(n.skin);
      if (!f) {
        errors.push(`"${n.skin}": no such custom skin (make it with ui_forge {action: "custom"})`);
        const { skin: _s, ...rest } = out;
        return rest;
      }
      used.set(n.skin, f);
      return out;
    }
    if (n.skin && !n.skin.includes('@')) {
      const p = parseSkin(n.skin);
      if ('error' in p) {
        errors.push(p.error);
        const { skin: _s, ...rest } = out;
        return rest;
      }
      const got = sf.get(n.skin, forgeSize(p.spec.kind, at.size), at.fit);
      if ('error' in got) {
        errors.push(got.error);
        const { skin: _s, ...rest } = out;
        return rest;
      }
      used.set(got.key, got.forged);
      const d = DIRECTIONS[p.spec.direction];
      out = { ...(d ? inked(out, inkFor(d, requestOf(p.spec, [1, 1]))) : out), skin: got.key };
    }
    return out;
  };
  const withKeys = screens.map((s) => keyed(s));
  const { screens: worn } = applySkins(withKeys, (key) => {
    const f = used.get(key) ?? sf.forged(key);
    return f ? { margin: f.margin, scale: f.scale, slice: f.slice, size: f.size, ...(f.content ? { content: f.content } : {}) } : null;
  });
  return {
    screens: worn,
    images: (ref) => (ref.startsWith('skin:') ? (used.get(ref.slice(5))?.image ?? sf.image(ref.slice(5))) : null),
    used,
    errors: [...new Set(errors)],
  };
}

/** Whether any node of the screens wears a skin. */
export function hasSkins(screens: UiNode[]): boolean {
  const walk = (n: UiNode): boolean => !!n.skin || (n.kids ?? []).some(walk);
  return screens.some(walk);
}
