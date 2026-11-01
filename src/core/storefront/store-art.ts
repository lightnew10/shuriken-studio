import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkVersion, readShorthands, resolveVersion, type MockColor, type MockNode } from '@shared/ui-mockup';
import type { UiNode } from '@shared/ui-layout';
import { decodeImage } from '../look/look-analysis';
import type { RgbaImage } from '../modeling/png';
import { projectImages } from '../ui/ui-pictures';
import { renderUi } from '../ui/ui-render';

/**
 * The Storefront's pictures, drawn by the core's UI renderer (the one UI mockups use, so a composition has everything
 * a Roblox UI has: images, outlined text, gradients and fades, glows and shadows, cut and slanted shapes): the game's
 * thumbnails (16:9, 1920x1080), its icon (512x512) and the icons of what it sells (512x512, seen as circles on Roblox).
 * A composition is a list of screens in the UI mockup format, laid out on a 1920x1080 canvas; images are Studio shots
 * ("shot:<name>", thumb_shot), the game's icons ("icon:<Name>", ui_icon or store_icons) and line-art glyphs.
 */

export const ART_SIZES = { thumbnail: { w: 1920, h: 1080 }, icon: { w: 512, h: 512 } } as const;
export type ArtSize = keyof typeof ART_SIZES;
/** Thumbnails made per round, from which the best is picked by elimination. */
export const THUMB_CANDIDATES = 5;

export const SHOT_DIR = (root: string) => join(root, '.shuriken', 'storefront', 'art', 'shots');

const cache = new Map<string, { at: number; img: RgbaImage | null }>();
function readImage(path: string): RgbaImage | null {
  if (!existsSync(path)) return null;
  const at = statSync(path).mtimeMs;
  const hit = cache.get(path);
  if (hit && hit.at === at) return hit.img;
  let img: RgbaImage | null = null;
  try {
    img = decodeImage(readFileSync(path));
  } catch {
    img = null;
  }
  cache.set(path, { at, img });
  return img;
}

/** The images a composition can show: Studio shots and Storefront art first, then the project's UI images. */
export function artImages(root: string, resourcesDir: string | null): (ref: string, px: number) => RgbaImage | null {
  const ui = projectImages(root, resourcesDir);
  return (ref, px) => {
    const shot = /^shot:([A-Za-z0-9_-]{1,40})$/.exec(ref)?.[1];
    if (shot) return readImage(join(SHOT_DIR(root), `${shot}.png`));
    const art = /^art:([A-Za-z0-9_./-]{1,80})$/.exec(ref)?.[1];
    if (art && !art.includes('..')) return readImage(join(root, '.shuriken', 'storefront', 'art', art));
    return ui(ref, px);
  };
}

export interface Composition {
  image: RgbaImage;
  errors: string[];
  warnings: string[];
  /** Fonts drawn as stand-ins, images that were missing. */
  notes: string[];
}

/**
 * Draws a composition at its size. The screens are checked like a mockup's (anything the format doesn't know is
 * refused), and drawn with no top bar, rulers or guides: the picture is the canvas alone.
 */
/** The Storefront's own pictures: "shot:<name>" (thumb_shot) and "art:<file>" (a model drawn for an icon), as artImages reads them. */
const LOCAL_IMAGE = /^(?:shot:[A-Za-z0-9_-]{1,40}|art:[A-Za-z0-9_./-]{1,80})$/;

export function compose(screens: MockNode[], size: ArtSize, images: (ref: string, px: number) => RgbaImage | null, theme?: Record<string, MockColor>): Composition {
  const read = readShorthands(screens).map((s) => ({ ...s, ignoreInset: true }));
  // Its own pictures (a Studio shot, a model drawn for an icon) are images here, though no Roblox UI could show them.
  const check = checkVersion({ screens: read, ...(theme ? { theme } : {}) }, { localImage: (ref) => LOCAL_IMAGE.test(ref) });
  const blank: RgbaImage = { width: 1, height: 1, data: new Uint8Array(4) };
  if (check.errors.length) return { image: blank, errors: check.errors, warnings: check.warnings, notes: [] };
  const r = resolveVersion({ screens: read, ...(theme ? { theme } : {}) }, 'desktop');
  const { w, h } = ART_SIZES[size];
  const missing: string[] = [];
  const pic = renderUi(r.screens as UiNode[], 'desktop', {
    scale: 1,
    region: { x: 0, y: 0, w, h },
    guides: false,
    rulers: false,
    backdrop: 'dark',
    images: (ref, px) => {
      const img = images(ref, px);
      if (!img) missing.push(ref);
      return img;
    },
  });
  const notes = [...pic.notes, ...[...new Set(missing)].map((m) => `no image ${m}: drawn as a placeholder`)];
  return { image: pic.image, errors: [], warnings: check.warnings, notes };
}

/**
 * A pass or product icon from the set's template: the template's screens with "{subject}" replaced by the item's
 * subject image, "{text}" by its text and "{hue}" by its hue, so every icon in the set shares one frame, background
 * and light.
 */
export function iconFromTemplate(template: MockNode[], subject: string, text: string, hue = '#808080'): MockNode[] {
  return template.map((n) => fillTemplate(n, subject, text, hue) as MockNode);
}

/** A template's placeholders filled in anywhere in it: "{subject}" (an image), "{text}", and "{hue}" in any colour (fills, strokes, gradients, a theme). */
export function fillTemplate(v: unknown, subject: string, text: string, hue: string): unknown {
  if (typeof v === 'string') return v === '{subject}' ? subject : v.replace(/\{text\}/g, text).replace(/\{hue\}/g, hue);
  if (Array.isArray(v)) return v.map((x) => fillTemplate(x, subject, text, hue));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillTemplate(x, subject, text, hue)]));
  return v;
}

/** Whether a template has the subject's place ({subject}) somewhere. */
export function templateHasSubject(template: MockNode[]): boolean {
  const has = (n: MockNode): boolean => n.image === '{subject}' || (n.kids ?? []).some(has);
  return template.some(has);
}

/** The judge's ruling on thumbnail candidates (the order they fell out in, and the winner). */
export interface ThumbRuling {
  rounds: Array<{ out: string; why: string }>;
  winner: string;
  why: string;
}

/** The judge's prompt: the game in a few lines, and the candidates by letter (their pictures come with it). */
export function judgePrompt(game: string, letters: string[]): string {
  return [
    `Judge the thumbnails of this Roblox game, shown in order: ${letters.join(', ')}.`,
    '',
    game,
    '',
    'Eliminate one candidate per round, the weakest of those left, until one remains: that is the winner. Judge as a player',
    'scrolling the Discover page, where a thumbnail is about 300 pixels wide: does it read at that size (one clear focal',
    'subject, a silhouette, contrast against the background), does it say the genre at a glance, is it honest to the game',
    '(what it shows is in the game), does its text (if any) read in a blink, does it make you want to click. For each',
    'round, one plain sentence on why that one goes.',
  ].join('\n');
}
