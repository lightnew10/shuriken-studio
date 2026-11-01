import type { UiDevice, UiNode } from './ui-layout';

/**
 * The UI page's Forge (core/ui/forge/forge-rpc.ts, pages/forge/): what its RPCs take and give. Art directions with
 * their palettes, screen templates, previews drawn by the CPU engine as PNG data URLs, a direction's element sheet,
 * and a mockup made from a template in a direction and an accent.
 */

/** The devices a template is previewed on (UI Lab devices: a notch phone, an iPad, a 1080p desktop, a console TV). */
export const FORGE_DEVICES = [
  { id: 'phone', label: 'Phone' },
  { id: 'tablet', label: 'Tablet' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'tv', label: 'TV' },
] as const;
export type ForgeDevice = (typeof FORGE_DEVICES)[number]['id'];
export const isForgeDevice = (d: unknown): d is ForgeDevice => FORGE_DEVICES.some((x) => x.id === d);

export interface ForgeDirectionInfo {
  id: string;
  /** "Candy". */
  name: string;
  /** "chunky glossy simulator". */
  tagline: string;
  /** The games it suits and how it looks. */
  for: string;
  palette: Array<{ name: string; hex: string }>;
  fonts: { display: string; body: string };
  /** Accents that suit it, its own first. */
  swatches: string[];
  /** Its sample screen's title ("PET SHOP"). */
  sampleTitle: string;
  /** A backdrop colour its art reads well on ("#rrggbb"). */
  backdrop: string;
}

/** A game genre (forge.genres): the look and accent that suit it; a template made in it carries its content. */
export interface ForgeGenreInfo {
  id: string;
  label: string;
  direction: string;
  accent: string | null;
}

export interface ForgeTemplateInfo {
  id: string;
  label: string;
  for: string;
  /** The content keys it reads. */
  contentShape: string;
  /** The art directions it is drawn in. */
  looks: string[];
}

export interface ForgePreviewParams {
  /** The direction's sample screen, a template built in the direction, or the game's own UI dressed in it. */
  what: 'sample' | 'template' | 'game';
  direction: string;
  /** "#rrggbb" re-tints the direction; absent or null keeps its own colours. */
  accent?: string | null;
  template?: string;
  /** A genre (forge.genres) whose currencies, items and tabs a template is filled with. */
  genre?: string | null;
  device?: ForgeDevice;
  /** The picture's width in pixels (it is drawn at about this size; 160-1800). */
  width?: number;
  /** Roblox's own controls over the game (top bar, thumbstick, jump). */
  roblox?: boolean;
  /** Behind the UI: a scene in the direction's mood, or the game's latest picture. */
  backdrop?: 'look' | 'game';
  /** A newer request in the same slot replaces this one while it still waits. */
  slot?: string;
  priority?: 'high' | 'low';
  /** "cpu": forge every skin on the CPU even when the GPU forge is there (to measure one against the other). */
  engine?: 'cpu';
}

export interface ForgePreview {
  /** data:image/png;base64,… (empty when superseded). */
  png: string;
  w: number;
  h: number;
  /** Milliseconds the drawing took (0 from the cache). */
  ms: number;
  cached: boolean;
  /** Skins that couldn't be forged. */
  errors: string[];
  notes: string[];
  /** A newer request in its slot took its place before it was drawn. */
  superseded?: boolean;
  /** Where the time went (not from the cache): forging and wearing the skins, drawing the picture. */
  timings?: { skins: number; draw: number };
}

export interface ForgeSheetItem {
  /** The skin spec an element of a design wears to get this art ("candy:button:primary#ff7ab8"). */
  spec: string;
  label: string;
  /** Design size in points. */
  size: [number, number];
  png: string | null;
  /** Picture size in pixels, and its margin in points (shadows and glows outside the element). */
  w: number;
  h: number;
  margin: number;
  /** Pixels per point it was forged at. */
  scale: number;
  error?: string;
}

export interface ForgeSheet {
  direction: string;
  accent: string | null;
  groups: Array<{ id: string; label: string; items: ForgeSheetItem[] }>;
  ms: number;
  cached: boolean;
}

export interface ForgeMakeParams {
  /** A template id, "sample" for the direction's sample screen, or "game" for the game's own UI dressed in it. */
  template: string;
  direction: string;
  accent?: string | null;
  /** A genre (forge.genres) whose currencies, items and tabs a template is filled with. */
  genre?: string | null;
  title?: string;
  /** Add it as a new version of this mockup instead of making a new one. */
  into?: string;
}

/** A mockup version drawn by the Forge with its skins worn (forge.mockup). */
export interface ForgeMockupParams {
  name: string;
  /** Its letter; absent: the one the user picked, else the newest. */
  version?: string;
  /** A UI Lab device id or ui_audit's name for one (phone, phonePortrait, tablet, laptop, desktop, tv). */
  device?: string;
  width?: number;
  roblox?: boolean;
  backdrop?: 'look' | 'game';
  slot?: string;
  priority?: 'high' | 'low';
}

/** A mockup version's screens with its skins worn (forge.worn), for the UI page's canvases. */
export interface ForgeWornParams {
  name: string;
  /** Its letter; absent: the one the user picked, else the newest. */
  version?: string;
  /** ui_audit's device names (default: every mockup device). */
  devices?: string[];
  /** Image refs ("skin:<key>") the page already has: not sent again. */
  have?: string[];
  priority?: 'high' | 'low';
  /** Only forge (and keep) it, send nothing back: a mockup just made, before it is shown. */
  warm?: boolean;
}

export interface ForgeWorn {
  /** False when the version wears no skins (the page lays out its own screens). */
  skinned: boolean;
  /** Per device, the screens as the layout engine takes them, each skin worn as its element's "Skin" child. */
  screens: Partial<Record<UiDevice, UiNode[]>>;
  /** The art the page didn't have: "skin:<key>" → its PNG and size in pixels. */
  images: Record<string, { url: string; w: number; h: number }>;
  errors: string[];
}

/** The game's UI as last read from Studio (null: not read yet). */
export interface ForgeGame {
  /** Its ScreenGuis' names. */
  screens: string[];
  source: 'StarterGui' | 'PlayerGui';
  capturedAt: string;
  /** The project's name ("<name> UI in Candy"). */
  name: string;
}

/** "Dress my game's UI": a mockup of the game's UI dressed in a direction. */
export interface ForgeDressParams {
  direction: string;
  accent?: string | null;
  /** One ScreenGui by name; absent: all of them. */
  screen?: string;
  title?: string;
  /** A mockup to add it to as a version (default: the one with the same title, when there is one). */
  into?: string;
}

export interface ForgeMade {
  name: string;
  title: string;
  version: string;
  warnings: string[];
}

export interface ForgeStatus {
  /** Where pictures are drawn: worker threads, or the core's own thread a piece at a time. */
  engine: 'worker' | 'thread' | 'starting';
  workers: number;
  queued: number;
  running: number;
}

/** "#rrggbb" in lower case, from "#RGB", "rrggbb" or "#rrggbb"; null for anything else. */
export function normalizeAccent(a: unknown): string | null {
  if (typeof a !== 'string') return null;
  const h = a.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) return `#${h.split('').map((c) => c + c).join('')}`.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(h)) return `#${h}`.toLowerCase();
  return null;
}

/**
 * The scales a preview is drawn at for a picture `width` pixels wide of a screen `deviceWidth` points wide: the
 * picture's own (in steps of 0.02) and the art's, a little sharper, in quarter steps from 0.25 to 2 (the game forges
 * at 2): small pictures forge small art, which is what keeps them fast.
 */
export function previewScales(width: number, deviceWidth: number): { scale: number; forgeScale: number } {
  const w = Math.max(160, Math.min(1800, Math.round(width || 0) || 640));
  const scale = Math.max(0.08, Math.min(2, Math.round((w / Math.max(1, deviceWidth)) * 50) / 50));
  const forgeScale = Math.max(0.25, Math.min(2, Math.ceil(scale * 4 - 1e-6) / 4));
  return { scale, forgeScale };
}
