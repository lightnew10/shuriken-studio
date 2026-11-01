import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UI_DEVICES, type UiDevice, type UiNode, type UiStateName } from '@shared/ui-layout';
import { resolveVersion, versionLabel, type MockVersion, type Mockup } from '@shared/ui-mockup';
import { decodePng, encodePng, type RgbaImage } from '../modeling/png';
import { decodeImage } from '../look/look-analysis';
import { ICON_DIR } from './ui-icons';
import { drawGlyph, glyphName, glyphSet } from './ui-glyphs';
import { renderUi, sideBySide, type Backdrop, type UiRender } from './ui-render';
import type { ToolContent } from '../capabilities/tool-registry';
import { hasSkins, prepareSkins, skinForgeFor, type SkinForge } from './forge/resolve';
import { robloxFontPicker } from './lab/lab-text';
import { robloxMeasure } from './lab/roblox-fonts';

/** Text in pictures as Roblox draws it: its own fonts and TextBounds (stand-ins only where Studio isn't installed). */
const ROBLOX_TEXT = { measure: robloxMeasure, fonts: robloxFontPicker };

/** Screens with their forged skins worn, and images that draw them before the project's own. */
export function wearSkins(screens: UiNode[], images: (ref: string, px: number) => RgbaImage | null, sf?: SkinForge): { screens: UiNode[]; images: (ref: string, px: number) => RgbaImage | null; errors: string[] } {
  if (!hasSkins(screens)) return { screens, images, errors: [] };
  const p = prepareSkins(screens, sf ?? skinForgeFor(null));
  return { screens: p.screens, images: (ref, px) => p.images(ref) ?? images(ref, px), errors: p.errors };
}

/**
 * Pictures of mockups for agents (the mockup tools return them): a version drawn on a device by the core's UI
 * renderer, with the project's images (cached Roblox thumbnails, its icons, line-art glyphs), and the sheets
 * built from those pictures (an element in each of its states).
 */

const decoded = new Map<string, { at: number; img: RgbaImage | null }>();
function readImage(path: string): RgbaImage | null {
  if (!existsSync(path)) return null;
  const at = statSync(path).mtimeMs;
  const hit = decoded.get(path);
  if (hit && hit.at === at) return hit.img;
  let img: RgbaImage | null = null;
  try {
    img = decodeImage(readFileSync(path));
  } catch {
    img = null;
  }
  decoded.set(path, { at, img });
  return img;
}

const glyphCache = new Map<string, RgbaImage>();

/**
 * The images a project's UI shows, for the renderer: uploaded images from the thumbnails ui_audit and the UI page
 * cached (.shuriken/ui/images), the project's icons (ui/icons), and glyphs drawn at the size they show at.
 */
export function projectImages(root: string, resourcesDir: string | null): (ref: string, px: number) => RgbaImage | null {
  return (ref, px) => {
    const id = /(?:rbxassetid:\/\/|[?&]id=)(\d+)/i.exec(ref)?.[1];
    if (id) return readImage(join(root, '.shuriken', 'ui', 'images', `${id}.png`));
    const icon = /^icon:([A-Za-z][A-Za-z0-9_]{0,31})$/.exec(ref)?.[1];
    if (icon) return readImage(join(root, ICON_DIR, `${icon}.png`));
    const glyph = /^glyph:([a-z0-9-]+)$/.exec(ref)?.[1];
    if (glyph) {
      const set = glyphSet(resourcesDir);
      const name = set ? glyphName(set, glyph) : null;
      if (!set || !name) return null;
      const size = Math.max(32, Math.min(512, 2 ** Math.ceil(Math.log2(Math.max(16, px)))));
      const key = `${name}@${size}`;
      let img = glyphCache.get(key);
      if (!img) {
        img = drawGlyph(set.icons[name]!, size);
        glyphCache.set(key, img);
      }
      return img;
    }
    return null;
  };
}

/** A picture as a tool result's image. */
export const pngContent = (img: RgbaImage): ToolContent => ({ type: 'image', data: encodePng(img).toString('base64'), mimeType: 'image/png' });

/** The project's latest viewer picture (the UI page's backdrop), when there is one. */
export function gameBackdrop(projectDir: string): RgbaImage | null {
  return readImage(join(projectDir, 'thumbnail.jpg'));
}

export interface VersionPicture extends UiRender {
  device: UiDevice;
  form: string;
  unknown: string[];
  caption: string;
}

/** A version on a device as a picture, with a caption saying what it is. */
export function renderVersion(m: Pick<Mockup, 'name' | 'title'>, v: MockVersion, device: UiDevice, o: { images: (ref: string, px: number) => RgbaImage | null; backdrop?: Backdrop; focus?: string; states?: Record<string, UiStateName>; show?: string[]; scale?: number; /** No rulers or caption: the screen alone. */ bare?: boolean; /** Where forged skins are cached (the project's). */ skins?: SkinForge }): VersionPicture {
  const resolved = resolveVersion(v, device);
  const worn = wearSkins(resolved.screens as UiNode[], o.images, o.skins);
  const r = { ...resolved, screens: worn.screens };
  o = { ...o, images: worn.images };
  const dev = UI_DEVICES[device];
  const layouts = [...new Set(Object.values(r.layouts).filter(Boolean))];
  const caption = `${m.title} ${versionLabel(v)} · ${dev.label} ${dev.w}×${dev.h} pt${layouts.length ? ` · ${layouts.join(', ')} layout` : ''}${o.focus ? ` · ${o.focus}` : ''}${o.states && Object.keys(o.states).length ? ` · ${Object.entries(o.states).map(([p, s]) => `${p.split('.').pop()} ${s}`).join(', ')}` : ''}`;
  const pic = renderUi(r.screens as UiNode[], device, { ...ROBLOX_TEXT, images: o.images, backdrop: o.backdrop, focus: o.focus, states: o.states, show: o.show, scale: o.scale, ...(o.bare ? { rulers: false } : { caption }) });
  // A skin that didn't forge says why (it draws as the element's own fill meanwhile).
  return { ...pic, notes: [...worn.errors.map((e) => `skin ${e}`), ...pic.notes], device, form: r.form, caption };
}

/**
 * An element in each of its states (normal, then hover, press, selected, disabled as it has them), side by side,
 * drawn big: how the button answers the player.
 */
export function statesSheet(m: Pick<Mockup, 'name' | 'title'>, v: MockVersion, device: UiDevice, path: string, images: (ref: string, px: number) => RgbaImage | null, backdrop?: Backdrop): { image: RgbaImage; states: UiStateName[] } | null {
  const resolved = resolveVersion(v, device);
  const worn = wearSkins(resolved.screens as UiNode[], images);
  const r = { ...resolved, screens: worn.screens };
  images = worn.images;
  let node: UiNode | null = null;
  const walk = (n: UiNode, p: string) => {
    if (p === path) node = n;
    for (const c of n.kids ?? []) walk(c, `${p}.${c.name}`);
  };
  for (const s of r.screens) walk(s, s.name);
  if (!node) return null;
  const states = Object.keys((node as UiNode).states ?? {}) as UiStateName[];
  // Every state in the frame of the normal one, so a press that shrinks it shows as smaller.
  const normal = renderUi(r.screens, device, { ...ROBLOX_TEXT, images, backdrop, focus: path, rulers: false, guides: false });
  const items = [{ label: 'normal', image: normal.image }];
  for (const s of states) items.push({ label: s, image: renderUi(r.screens, device, { ...ROBLOX_TEXT, images, backdrop, region: normal.region, scale: normal.scale, rulers: false, guides: false, states: { [path]: s } }).image });
  return { image: sideBySide(items), states };
}

/** The elements of a version that answer the player (have states), for a states sheet. */
export function statefulPaths(v: MockVersion, device: UiDevice): string[] {
  const r = resolveVersion(v, device);
  const out: string[] = [];
  const walk = (n: UiNode, p: string) => {
    if (n.states && Object.keys(n.states).length) out.push(p);
    for (const c of n.kids ?? []) walk(c, `${p}.${c.name}`);
  };
  for (const s of r.screens) walk(s, s.name);
  return out;
}

/** The device whose shape is nearest a picture's (for drawing a mockup beside a reference). */
export function deviceLike(width: number, height: number, devices: UiDevice[] = ['phone', 'phonePortrait', 'tablet', 'desktop']): UiDevice {
  const a = width / Math.max(1, height);
  return [...devices].sort((x, y) => Math.abs(Math.log(UI_DEVICES[x].w / UI_DEVICES[x].h / a)) - Math.abs(Math.log(UI_DEVICES[y].w / UI_DEVICES[y].h / a)))[0]!;
}

/** Decodes a PNG or JPEG file (an attachment, a screenshot). */
export function readPicture(path: string): RgbaImage {
  const buf = readFileSync(path);
  if (buf[0] === 0x89) return decodePng(buf);
  return decodeImage(buf);
}

