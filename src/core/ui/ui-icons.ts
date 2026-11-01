import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ICON_NAME, type IconView } from '@shared/icon';
import { DEFAULT_SYNC_MAP, type SyncMap } from '../roblox/luau-toolchain';

/**
 * The game's UI icons (tool ui_icon): pictures of the game's own models (drawn by the app with a transparent
 * background and an outline), line-art glyphs (drawn by the core, core/ui/ui-glyphs.ts) and the images of panel
 * shapes (core/ui/ui-shapes.ts), uploaded to Roblox and listed in generated modules the UI code requires.
 *
 * Why: the UIs the user holds up as the bar (shop cards, currency counters, category tabs, inventory slots) all
 * run on rendered item and currency art. Shuriken's UI agents had no way to make an image: their shops showed
 * text, emoji or `rbxassetid://0`.
 *
 * ui/icons/icons.json lists them, ui/icons/<Name>.png are the pictures, and <shared>/UiIcons.luau maps each name
 * to its image ("" until it is uploaded and its image id is known); <shared>/UiShapes.luau lists each shape's
 * images with its 9-slice (when there are shapes).
 */
export const ICON_DIR = 'ui/icons';
const INDEX = `${ICON_DIR}/icons.json`;

/** A panel shape's images: the fill (role fill) and an outline per stroke (role line, of: the fill's name). */
export interface IconShape {
  role: 'fill' | 'line';
  /** The fill icon a line belongs to. */
  of?: string;
  /** Where it was drawn from: the mockup element. */
  source?: { mockup: string; version: string; path: string };
  /** Design size in points, the margin round it for outer strokes, SliceCenter in image pixels (2 per point). */
  size: [number, number];
  pad: number;
  slice: [number, number, number, number];
  /** The fill's outlines, lowest ZIndex first (on the fill). */
  lines?: string[];
}

export interface UiIcon {
  name: string;
  /** What it is: a model's picture (default), a line-art glyph, or a panel shape's image. */
  kind?: 'model' | 'glyph' | 'shape';
  /** The model (or assembly) it is a picture of. */
  model?: string;
  /** The glyph it draws (Lucide's name) and how. */
  glyph?: string;
  style?: { weight?: number; color?: string; glow?: string };
  shape?: IconShape;
  view?: IconView;
  outline: boolean;
  /** The PNG, relative to the project. */
  file: string;
  /** The Decal asset Open Cloud made, and the image id read from it in Studio (rbxassetid://<imageId>). */
  decalId?: string;
  imageId?: string;
  /** Why the last upload didn't happen. */
  error?: string;
  updatedAt: string;
}

/** Reads an uploaded Decal's image id in Studio (the content id an ImageLabel needs). */
export const decalImageLuau = (decalId: string) => `local ok, model = pcall(function() return game:GetService("InsertService"):LoadAsset(${Number(decalId)}) end)
if not ok then return "error: " .. tostring(model) end
local d = model:FindFirstChildWhichIsA("Decal", true)
local tex = d and d.Texture or ""
model:Destroy()
return tex`;

export class IconLibrary {
  constructor(private readonly root: string) {}

  all(): UiIcon[] {
    const f = join(this.root, INDEX);
    if (!existsSync(f)) return [];
    try {
      const list = JSON.parse(readFileSync(f, 'utf8')) as UiIcon[];
      return Array.isArray(list) ? list.filter((i) => i && ICON_NAME.test(i.name)).sort((a, b) => a.name.localeCompare(b.name)) : [];
    } catch {
      return [];
    }
  }

  get(name: string): UiIcon | null {
    return this.all().find((i) => i.name === name) ?? null;
  }

  private write(list: UiIcon[]): void {
    mkdirSync(join(this.root, ICON_DIR), { recursive: true });
    writeFileSync(join(this.root, INDEX), `${JSON.stringify([...list].sort((a, b) => a.name.localeCompare(b.name)), null, 2)}\n`, 'utf8');
  }

  /** Saves (or replaces) an icon and its picture. A new picture drops the old upload: it shows something else now. */
  save(icon: Omit<UiIcon, 'file' | 'updatedAt'>, png: Buffer): UiIcon {
    if (!ICON_NAME.test(icon.name)) throw new Error('An icon name is letters, digits and _ (starting with a letter), at most 32');
    const file = `${ICON_DIR}/${icon.name}.png`;
    mkdirSync(join(this.root, ICON_DIR), { recursive: true });
    writeFileSync(join(this.root, file), png);
    const saved: UiIcon = { ...icon, file, updatedAt: new Date().toISOString() };
    this.write([...this.all().filter((i) => i.name !== icon.name), saved]);
    return saved;
  }

  update(name: string, patch: Partial<UiIcon>): UiIcon | null {
    const list = this.all();
    const i = list.findIndex((x) => x.name === name);
    if (i < 0) return null;
    list[i] = { ...list[i]!, ...patch, name };
    this.write(list);
    return list[i]!;
  }

  remove(name: string): boolean {
    const e = this.get(name);
    if (!e) return false;
    rmSync(join(this.root, e.file), { force: true });
    this.write(this.all().filter((i) => i.name !== name));
    return true;
  }

  /** Where the generated module lives: beside the game's other shared modules. */
  static moduleLocation(syncMap: SyncMap | undefined): { file: string; requirePath: string } {
    const map = syncMap && Object.keys(syncMap).length ? syncMap : DEFAULT_SYNC_MAP;
    const shared = Object.entries(map).find(([, inst]) => inst === 'ReplicatedStorage' || inst.startsWith('ReplicatedStorage/')) ?? ['src/Shared', 'ReplicatedStorage/Shared'];
    const segs = shared[1].split('/').slice(1);
    return {
      file: `${shared[0].replace(/\/$/, '')}/UiIcons.luau`,
      requirePath: ['game.ReplicatedStorage', ...segs.map((s) => (/^[A-Za-z_]\w*$/.test(s) ? s : `[${JSON.stringify(s)}]`)), 'UiIcons'].join('.').replace(/\.\[/g, '['),
    };
  }

  /** The module's text: every icon by name, "" for one whose image isn't on Roblox yet. */
  moduleSource(): string {
    const what = (i: UiIcon) => i.model ?? (i.glyph ? `glyph ${i.glyph}` : i.shape ? (i.shape.role === 'fill' ? 'shape' : `outline of ${i.shape.of}`) : '');
    const rows = this.all().map((i) => `\t${i.name} = "${i.imageId ? `rbxassetid://${i.imageId}` : ''}", -- ${what(i)}${i.imageId ? '' : ' (not uploaded yet)'}`);
    return [
      '--!strict',
      "-- Generated by Shuriken Studio (ui_icon): icons drawn from the game's own models, line-art glyphs and panel shapes. Don't edit: run ui_icon again.",
      '-- An icon that is "" has not been uploaded yet: show its name until it is.',
      'local Icons: { [string]: string } = {',
      ...rows,
      '}',
      '',
      'return Icons',
      '',
    ].join('\n');
  }

  /** The shapes module's text (null when there are no shapes): each shape's images and how they slice. */
  shapesSource(): string | null {
    const fills = this.all().filter((i) => i.shape?.role === 'fill');
    if (!fills.length) return null;
    const rows = fills.map((i) => {
      const s = i.shape!;
      const lines = (s.lines ?? []).filter((n) => this.get(n)).map((n) => `Icons.${n}`);
      return `\t${i.name} = { fill = Icons.${i.name}, lines = { ${lines.join(', ')} }, slice = Rect.new(${s.slice.join(', ')}), sliceScale = 0.5, pad = ${s.pad}, size = Vector2.new(${s.size.map((v) => Math.round(v * 100) / 100).join(', ')}) },`;
    });
    return [
      '--!strict',
      '-- Generated by Shuriken Studio (ui_icon shapes): panel shapes Roblox has no property for, as 9-sliced images',
      '-- (a white fill and a white outline per stroke, tinted in the game). Build one with Ui.shape(frame, Shapes.<Name>).',
      "-- Don't edit: run ui_icon again.",
      'local Icons = require(script.Parent.UiIcons)',
      '',
      'export type Shape = { fill: string, lines: { string }, slice: Rect, sliceScale: number, pad: number, size: Vector2 }',
      '',
      'local Shapes: { [string]: Shape } = {',
      ...rows,
      '}',
      '',
      'return Shapes',
      '',
    ].join('\n');
  }

  /** Writes the modules when their text changed: the icons module's file (relative), whether anything was written, every file written. */
  writeModule(syncMap: SyncMap | undefined): { file: string; requirePath: string; written: boolean; files: string[] } {
    const loc = IconLibrary.moduleLocation(syncMap);
    const files: string[] = [];
    const put = (rel: string, text: string) => {
      const abs = join(this.root, rel);
      if (existsSync(abs) && readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') === text) return;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, 'utf8');
      files.push(rel);
    };
    put(loc.file, this.moduleSource());
    const shapes = this.shapesSource();
    if (shapes) put(loc.file.replace(/UiIcons\.luau$/, 'UiShapes.luau'), shapes);
    return { ...loc, written: files.length > 0, files };
  }
}
