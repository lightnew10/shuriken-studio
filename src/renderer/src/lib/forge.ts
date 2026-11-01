import { FORGE_DEVICES, isForgeDevice, normalizeAccent, type ForgeDevice } from '@shared/ui-forge';

/**
 * The Forge view's logic (pages/forge/): what the user picked (a look, an accent, a screen, a device), links into
 * it, how big to ask for a picture, and the message that hands the pick to the UI copilot.
 */

export type ForgeStage = 'preview' | 'sheet';

export interface ForgePick {
  direction: string;
  accent: string | null;
  /** "sample" (the look's own sample screen) or a template id. */
  screen: string;
  device: ForgeDevice;
  stage: ForgeStage;
  /** Roblox's own controls over the preview. */
  roblox: boolean;
  backdrop: 'look' | 'game';
  /** A genre whose items, currencies and tabs fill the templates (null: the look's own sample content). */
  genre: string | null;
}

export const FORGE_DEFAULT: ForgePick = { direction: 'candy', accent: null, screen: 'sample', device: 'phone', stage: 'preview', roblox: true, backdrop: 'look', genre: null };

/** A pick read back from storage: anything missing or wrong falls back to the default. */
export function readPick(raw: unknown): ForgePick {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const word = (v: unknown) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/i.test(v) ? v : null);
  return {
    direction: word(r.direction) ?? FORGE_DEFAULT.direction,
    accent: normalizeAccent(r.accent),
    screen: word(r.screen) ?? FORGE_DEFAULT.screen,
    device: isForgeDevice(r.device) ? r.device : FORGE_DEFAULT.device,
    stage: r.stage === 'sheet' ? 'sheet' : 'preview',
    roblox: r.roblox !== false,
    backdrop: r.backdrop === 'game' ? 'game' : 'look',
    genre: word(r.genre),
  };
}

/**
 * A link into the Forge, from the UI page's item: "forge", "forge.ember" (a look), "forge.ember.sheet" (its
 * elements), "forge.neon.shop" (a template in it), "forge.neon.shop.phone" (on a device). Null when it isn't one.
 */
export function forgeLink(item: string | undefined): Partial<ForgePick> | null {
  const m = /^forge(?:[.:]([a-z0-9-]+))?(?:[.:]([a-z0-9-]+))?(?:[.:]([a-zA-Z]+))?$/.exec(item ?? '');
  if (!m) return null;
  const out: Partial<ForgePick> = {};
  if (m[1]) out.direction = m[1];
  if (m[2] === 'sheet') out.stage = 'sheet';
  else if (m[2]) {
    out.screen = m[2];
    out.stage = 'preview';
  }
  if (m[3] && isForgeDevice(m[3])) out.device = m[3];
  return out;
}

/** Points wide over points high: the sample is laid out on a 1366×768 laptop, templates on each device. */
export const SAMPLE_ASPECT = 1366 / 768;
export const DEVICE_ASPECT: Record<ForgeDevice, number> = { phone: 844 / 390, tablet: 1180 / 820, desktop: 1920 / 1080, tv: 1920 / 1080 };
export const deviceLabel = (d: ForgeDevice): string => FORGE_DEVICES.find((x) => x.id === d)?.label ?? d;

/**
 * The width in pixels to ask a picture for, to fill a box of CSS pixels at an aspect on this screen: in steps of 64
 * (a box resized a little reuses the picture it has), 192 to 1792.
 */
export function pictureWidth(box: { w: number; h: number }, aspect: number, dpr = 1): number {
  const fit = Math.max(0, Math.min(box.w, box.h * aspect));
  const px = fit * Math.max(1, Math.min(2, dpr || 1));
  return Math.max(192, Math.min(1792, Math.ceil(px / 64) * 64));
}

/** A direction's "for" line ("simulators, pets: thick outlines, …") as the games it suits and how it looks, each a sentence. */
export function lookFor(text: string): { games: string; looks: string } {
  const i = text.indexOf(':');
  const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  const end = (s: string) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);
  if (i < 0) return { games: '', looks: end(cap(text.trim())) };
  return { games: end(`For ${text.slice(0, i).trim()}`), looks: end(cap(text.slice(i + 1).trim())) };
}

/** Black or white, whichever reads on a colour. */
export function inkOn(hex: string): '#000000' | '#ffffff' {
  const h = normalizeAccent(hex) ?? '#000000';
  const lin = (i: number) => {
    const c = parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
  return l > 0.36 ? '#000000' : '#ffffff';
}

/**
 * What "Ask the designer" sends the UI copilot: the user's words, then the pick they make it from (the look, its
 * accent, the screen and device) and how to wear the look (its skin specs), the context the dock shows, and the
 * name of the preview attached.
 */
export function designerMessage(o: { direction: string; name: string; tagline: string; accent: string | null; screen: string; screenLabel: string; device: ForgeDevice; text: string }): { text: string; item: string; note: string; picture: string } {
  const accent = o.accent ? `, accent ${o.accent}` : '';
  const on = o.screen === 'sample' ? 'on a laptop' : `on a ${deviceLabel(o.device).toLowerCase()}`;
  const ask = o.text.trim() || (o.screen === 'sample' ? `Design my game's UI in this look.` : o.screen === 'game' ? `Dress my game's UI in this look and polish it.` : `Make me a ${o.screenLabel.toLowerCase()} for my game in this look.`);
  const what = o.screen === 'sample' ? 'its sample screen' : o.screen === 'game' ? "the game's own UI (as last read) dressed in it" : `the ${o.screenLabel} template`;
  const spec = `${o.direction}:button:primary${o.accent ?? ''}`;
  return {
    text: `${ask}\n\nFrom the Forge: the ${o.name} art direction (${o.tagline})${accent}, ${what} ${on} (the picture attached). Wear the look with its skins: "${o.direction}:<element>[:variant]${o.accent ?? ''}", e.g. "${spec}"${o.screen === 'game' ? `; a version with from "game" and reskin {direction: "${o.direction}"${o.accent ? `, accent: "${o.accent}"` : ''}} dresses the game's UI in one step` : ''}.`,
    item: `forge:${o.direction}${o.accent ?? ''}:${o.screen}`,
    note: `the Forge: the ${o.name} look${o.accent ? ` tinted ${o.accent}` : ''}, ${o.screen === 'sample' ? 'its sample screen' : `${o.screenLabel} ${on}`}`,
    picture: `forge-${o.direction}-${o.screen}.png`,
  };
}
