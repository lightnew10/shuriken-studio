import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECTIONS } from './directions';
import { resourcesDir } from './shapes';

/**
 * Genres: for the kinds of Roblox game players know (pet simulators, tycoons, horror escapes, racing…), the art
 * direction and accent that suit them and believable content — currencies, items with rarities and icons, tabs, the
 * screens such a game has — so a template starts as that genre's game (`resources/ui-glyphs/genres.json`).
 */

export interface Genre {
  label: string;
  examples?: string;
  direction: string;
  alt?: string;
  accent?: string;
  currencies: Array<{ name: string; icon: string }>;
  items: Array<{ name: string; icon: string; rarity: string }>;
  tabs: string[];
  screens: string[];
}

let cache: Record<string, Genre> | null = null;

/** The bundled resources the glyphs come from (the app's, set by the core), else the repo's. */
const resources = (): string | null => {
  const dir = resourcesDir();
  return dir && existsSync(join(dir, 'ui-glyphs', 'genres.json')) ? dir : null;
};

/** Every genre by id (none when the catalogue isn't there). */
export function genres(): Record<string, Genre> {
  if (cache) return cache;
  const dir = resources();
  // Not found (yet): asked again later, once the core has said where the resources are.
  if (!dir) return {};
  try {
    const raw = dir ? (JSON.parse(readFileSync(join(dir, 'ui-glyphs', 'genres.json'), 'utf8')) as { genres?: Record<string, Genre> }) : {};
    cache = Object.fromEntries(Object.entries(raw.genres ?? {}).filter(([, g]) => !!DIRECTIONS[g.direction]));
  } catch {
    cache = {};
  }
  return cache;
}

const PRICE: Record<string, string> = { common: '250', rare: '1,200', epic: '4,800', legendary: '12K', mythic: '50K' };
const RANK = ['common', 'rare', 'epic', 'legendary', 'mythic'];

/** Titles for the templates whose own default names another genre's screen ("PET SHOP", "ARMORY"). */
const TITLES: Record<string, string> = { shop: 'SHOP', inventory: 'INVENTORY', collection: 'COLLECTION' };

/** A template's content for a genre (the game's own content goes over it). */
export function genreContent(g: Genre, template?: string): Record<string, unknown> {
  const items = g.items.map((it) => ({ name: it.name, glyph: it.icon, rarity: RANK.includes(it.rarity) ? it.rarity : 'common', price: PRICE[it.rarity] ?? '500' }));
  const best = [...items].sort((a, b) => RANK.indexOf(b.rarity) - RANK.indexOf(a.rarity))[0];
  const [cur, prem] = g.currencies;
  return {
    ...(template && TITLES[template] ? { title: TITLES[template] } : {}),
    ...(cur ? { currency: { name: cur.name, glyph: cur.icon } } : {}),
    ...(prem ? { premium: { name: prem.name, glyph: prem.icon } } : {}),
    tabs: g.tabs,
    items,
    ...(best ? { featured: { name: best.name, glyph: best.glyph, rarity: best.rarity } } : {}),
  };
}
