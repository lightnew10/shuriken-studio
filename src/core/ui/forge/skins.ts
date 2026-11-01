import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkinArt, UDim2, UiNode } from '@shared/ui-layout';
import { decodePng, encodePng, type RgbaImage } from '../../modeling/png';
import { DIRECTIONS, type ElementRequest } from './directions';
import { forge, type Forged, type ForgeSpec } from './forge';
import { isSliced } from './spec';
import type { Color } from './style';

/**
 * Skins: forged UI art saved in the project (ui/skins/<name>.png, listed in skins.json with its design size, the
 * margin its shadows and glows take, its scale and 9-slice centre), and worn by any element of a design through
 * `skin: "<name>"`: the element gets a child ImageLabel "Skin" under its content that holds the art, 9-sliced at
 * SliceScale 1/scale and grown by the margin so shadows and glows fall outside the element's box. Text on a skinned
 * button moves into a child "Label" so it draws over the art (a parent's own text draws under its children).
 */

export const SKIN_DIR = join('ui', 'skins');

export interface SkinEntry {
  name: string;
  file: string;
  size: [number, number];
  margin: number;
  scale: number;
  slice: [number, number, number, number] | null;
  /** How it was made: an art direction's element, or a custom recipe. */
  made: { direction?: string; element?: ElementRequest; accent?: Color; custom?: ForgeSpec; spec?: string };
  /** The uploaded image, once it is on Roblox. */
  imageId?: string;
  /** The uploaded decal (its image id is read in Studio). */
  decalId?: string;
  /** Why its upload failed. */
  error?: string;
}

export class SkinLibrary {
  constructor(private readonly root: string) {}

  private get dir(): string {
    return join(this.root, SKIN_DIR);
  }

  all(): Record<string, SkinEntry> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'skins.json'), 'utf8')) as Record<string, SkinEntry>;
    } catch {
      return {};
    }
  }

  get(name: string): SkinEntry | null {
    return this.all()[name] ?? null;
  }

  save(name: string, f: Forged, made: SkinEntry['made']): SkinEntry {
    mkdirSync(this.dir, { recursive: true });
    const file = `${name}.png`;
    writeFileSync(join(this.dir, file), encodePng(f.image));
    const all = this.all();
    const prev = all[name];
    const entry: SkinEntry = { name, file, size: f.size, margin: f.margin, scale: f.scale, slice: f.slice, made, ...(prev?.imageId && JSON.stringify(prev.made) === JSON.stringify(made) ? { imageId: prev.imageId, ...(prev.decalId ? { decalId: prev.decalId } : {}) } : {}) };
    all[name] = entry;
    writeFileSync(join(this.dir, 'skins.json'), JSON.stringify(all, null, 1));
    return entry;
  }

  update(name: string, patch: Partial<Pick<SkinEntry, 'imageId' | 'decalId' | 'error'>>): void {
    const all = this.all();
    const e = all[name];
    if (!e) return;
    all[name] = { ...e, ...patch };
    for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (patch[k] === undefined) delete all[name]![k];
    writeFileSync(join(this.dir, 'skins.json'), JSON.stringify(all, null, 1));
  }

  image(name: string): RgbaImage | null {
    const e = this.get(name);
    if (!e) return null;
    const p = join(this.dir, e.file);
    return existsSync(p) ? decodePng(readFileSync(p)) : null;
  }
}

/** Forges one element of an art direction. */
export function forgeElement(direction: string, r: ElementRequest, accent?: Color): Forged {
  const d = DIRECTIONS[direction];
  if (!d) throw new Error(`No art direction "${direction}" (directions: ${Object.keys(DIRECTIONS).join(', ')})`);
  return forge(d.element(r, accent));
}

/** What `applySkins` needs of a skin: its margin, scale and slice. */
export type SkinLookup = (name: string) => (Pick<SkinEntry, 'margin' | 'scale' | 'slice'> & { size?: [number, number]; content?: [number, number, number, number] }) | null;

/** Where the text sits in an element whose art says (a pressed face is lower): the Label's position and size. */
function labelBox(s: ReturnType<SkinLookup>): { pos: [number, number, number, number]; size: [number, number, number, number] } | null {
  if (!s?.content || !s.size) return null;
  const [x, y, w, h] = s.content;
  const right = s.size[0] - (x + w);
  const bottom = s.size[1] - (y + h);
  if (Math.abs(x) + Math.abs(y) + Math.abs(right) + Math.abs(bottom) < 0.5) return null;
  return { pos: [0, x, 0, y], size: [1, -(x + right), 1, -(y + bottom)] };
}
const TEXT_PATCH = ['textColor', 'textT'] as const;

const TEXT_KEYS = ['text', 'textColor', 'textT', 'textSize', 'scaled', 'wrapped', 'truncate', 'lineHeight', 'font', 'bold', 'weight', 'italic', 'xAlign', 'yAlign', 'strokeT', 'strokeColor', 'rich', 'textMin', 'textMax'] as const;

/** The "Skin" child's art for a skin: grown by its margin so shadows and glows fall outside the box, 9-sliced at 1/scale. */
export function skinArtOf(key: string, s: Pick<SkinEntry, 'margin' | 'scale' | 'slice'>, pad?: UiNode['padding']): SkinArt {
  return { image: `skin:${key}`, ...fullBox(pad, s.margin), ...(s.slice && isSliced(key) ? { scaleType: 'Slice' as const, slice: s.slice, sliceScale: 1 / s.scale } : { scaleType: 'Stretch' as const }) };
}

/**
 * A child's position and size covering its parent's whole box grown by `m` on every side, through the parent's
 * UIPadding (Roblox pads every child: without this a padded button's art would shrink into its padding).
 */
function fullBox(pad: UiNode['padding'], m: number): { pos: UDim2; size: UDim2 } {
  const axis = (lo: [number, number], hi: [number, number]): [number, number, number, number] => {
    const D = Math.max(0.05, 1 - lo[0] - hi[0]);
    const o = lo[1] + hi[1];
    // [pos scale, pos offset, size scale, size offset]
    return [-lo[0] / D, -lo[0] * (o / D) - lo[1] - m, 1 / D, o / D + 2 * m];
  };
  const [t, r, b, l] = pad ?? [[0, 0], [0, 0], [0, 0], [0, 0]];
  const x = axis(l, r);
  const y = axis(t, b);
  const c = (v: number) => Math.round(v * 1e4) / 1e4;
  return { pos: [c(x[0]), c(x[1]), c(y[0]), c(y[1])], size: [c(x[2]), c(x[3]), c(y[2]), c(y[3])] };
}

/** The screens with every `skin` worn: the art as a child "Skin" under the content (and text moved above it). */
export function applySkins(screens: UiNode[], lookup: SkinLookup): { screens: UiNode[]; unknown: string[] } {
  const unknown = new Set<string>();
  let ids = 9_000_000;
  const walk = (n: UiNode): UiNode => {
    let out: UiNode = n.kids ? { ...n, kids: n.kids.map(walk) } : n;
    const name = n.skin;
    if (!name) return out;
    const s = lookup(name);
    if (!s) {
      unknown.add(name);
      return out;
    }
    const art: UiNode = { id: ids++, name: 'Skin', cls: 'ImageLabel', bgT: 1, z: 0, decor: true, ...skinArtOf(name, s, n.padding), ...(name.startsWith('pixel:') ? { resample: 'Pixelated' as const } : {}) };
    const kids = [art, ...(out.kids ?? [])];
    const { skin: _skin, ...rest } = out;
    out = { ...rest, bgT: 1, kids, skinned: s.margin };
    // States wearing other art: the Skin child's image, slice and reach for each.
    if (out.states && Object.values(out.states).some((p) => p?.skin)) {
      const states: NonNullable<UiNode['states']> = {};
      for (const [st, p] of Object.entries(out.states) as Array<[keyof NonNullable<UiNode['states']>, NonNullable<NonNullable<UiNode['states']>[keyof NonNullable<UiNode['states']>]>]>) {
        if (!p?.skin) {
          if (p) states[st] = p;
          continue;
        }
        const { skin: key, ...patch } = p;
        const a = lookup(key);
        if (!a) {
          unknown.add(key);
          states[st] = patch;
          continue;
        }
        const box = labelBox(a) ?? (labelBox(s) ? { pos: [0, 0, 0, 0] as [number, number, number, number], size: [1, 0, 1, 0] as [number, number, number, number] } : null);
        states[st] = { ...patch, skinArt: skinArtOf(key, a, n.padding), ...(box ? { label: box } : {}) };
      }
      out = { ...out, states };
    }
    // Text above the art: a parent's own text draws under its children.
    if ((n.cls === 'TextButton' || n.cls === 'TextLabel') && n.text) {
      const label: UiNode = { id: ids++, name: 'Label', cls: 'TextLabel', pos: [0, 0, 0, 0], size: [1, 0, 1, 0], ...(labelBox(s) ?? {}), bgT: 1, z: 2 };
      for (const k of TEXT_KEYS) if (n[k] !== undefined) (label as unknown as Record<string, unknown>)[k] = n[k];
      if (n.stroke?.text) label.stroke = n.stroke;
      const stripped = { ...out } as unknown as Record<string, unknown>;
      for (const k of TEXT_KEYS) delete stripped[k];
      stripped.text = '';
      // A state's text colours go to the Label, where the text now is.
      if (out.states) {
        const states: NonNullable<UiNode['states']> = {};
        for (const [st, p] of Object.entries(out.states)) {
          if (!p) continue;
          const moved: Record<string, unknown> = {};
          const kept = { ...p } as Record<string, unknown>;
          for (const k of TEXT_PATCH) if (p[k] !== undefined) (moved[k] = p[k]), delete kept[k];
          // The text's outline (a stroke round the letters) goes too; a border stroke stays on the element.
          const all = p.strokes ?? (p.stroke ? [p.stroke] : []);
          const letters = all.filter((x) => x.text);
          if (letters.length) {
            moved.stroke = letters[0];
            if (letters.length > 1) moved.strokes = letters;
            const rest = all.filter((x) => !x.text);
            delete kept.stroke;
            delete kept.strokes;
            if (rest.length) (kept.stroke = rest[0]), rest.length > 1 && (kept.strokes = rest);
          }
          states[st as keyof typeof states] = Object.keys(moved).length ? { ...(kept as typeof p), label: { ...p.label, ...moved } } : p;
        }
        stripped.states = states;
      }
      out = { ...(stripped as unknown as UiNode), kids: [art, label, ...(n.kids ?? []).map(walk)] };
    }
    // An element that lays out its children (a list, a grid, pages) would lay its art and text out with them: they go
    // in a Folder "Art", which Roblox draws in the element's area and leaves out of the layout (measured).
    if (n.list || n.grid || n.pages) {
      const extra = new Set(['Skin', 'Label']);
      const own = (out.kids ?? []).filter((k) => extra.has(k.name) && (k.decor || k.cls === 'TextLabel') && (k.name === 'Skin' ? k.decor : k.id >= 9_000_000));
      if (own.length) out = { ...out, kids: [{ id: ids++, name: 'Art', cls: 'Folder', kids: own }, ...(out.kids ?? []).filter((k) => !own.includes(k))] };
    }
    return out;
  };
  return { screens: screens.map(walk), unknown: [...unknown] };
}

/** A lookup over a project's skins. */
export const libraryLookup = (lib: SkinLibrary): SkinLookup => {
  const all = lib.all();
  return (name) => all[name] ?? null;
};
