import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso } from '@shared/ids';
import type { SyncMap } from '../roblox/luau-toolchain';
import { sharedModuleLocation } from '../roblox/shared-module';
import { STORE_RUNTIME_VERSION, storeModule } from './store-luau';

/**
 * The Storefront (1.15): what a game sells and how its page on Roblox sells the game. Three separate experts work
 * here, each on its own part and with its own skill: the store designer (the catalog: game passes and developer
 * products, their prices and what they grant), the copywriter (the game's title and description, and the name and
 * description of everything sold) and the thumbnail artist (the game's thumbnails and icon, and one consistent set of
 * icons for what is sold). Kept with the project in .shuriken/storefront/:
 * - catalog.json: the items, drafted and built into the game (ShurikenStore), and once pushed their Roblox ids;
 * - copy.json: the title and description, with the versions before them;
 * - art/: thumbnails (candidates and the pick), the icon, the items' icons.
 * Nothing here is published by itself: items go to Roblox only on the Storefront page's button or when the user tells
 * the director (its storePush, checked against their own words); the thumbnails, the icon and the copy are the user's to put on Roblox.
 */

export type StoreKind = 'pass' | 'product';
/**
 * How the game makes money (skill roblox-monetization). cosmetic: looks and status only, never an advantage (a
 * skill-based competitive game: an RTS, a fighting game). fair: convenience and time savers that never decide a
 * match. aggressive: the genre's strong sellers (multipliers, luck, skips, extra slots), for games built around them.
 */
export type StoreStyle = 'cosmetic' | 'fair' | 'aggressive';
export const STORE_STYLES: readonly StoreStyle[] = ['cosmetic', 'fair', 'aggressive'];

export interface StoreItem {
  /** Its name in the game's code (Store.items.VIP): a Luau identifier, kept when the shown name changes. */
  key: string;
  kind: StoreKind;
  /** The name players see on Roblox and in the shop. */
  name: string;
  description: string;
  /** Robux. */
  price: number;
  /** What owning or buying it gives the player, as the game's code grants it (for the engineers and the copy). */
  benefit: string;
  /** The icon: its subject ("model:<Name>" from the game's models, "glyph:<name>" line art), the drawn file and its content's hash (a redrawn icon is a change to push). */
  icon?: { subject?: string; file?: string; sha?: string };
  /** Shown order in the shop. */
  order?: number;
  /** The shop's category ("Passes", "Currency", "Boosts", "Cosmetics", "Gifts"), for the shop UI and the icon hue. */
  category?: string;
  /** Where and when the game offers it (the moment of need, never a nag), for the engineers and the UI designer. */
  offer?: string;
  /** The icon's hue ("#FFC83D"): one per category, the store icon template's {hue}. */
  hue?: string;
  /** A paid random item (an egg, a crate, a spin): the game shows its odds before purchase and asks PolicyService. */
  random?: boolean;
  /** Once pushed: the item on Roblox (in the game `universeId`), and the hash of what was pushed (a later change shows as not pushed yet). */
  roblox?: { id: number; iconAssetId?: number | null; pushedAt: string; hash: string; forSale: boolean; universeId?: number };
}

export interface StoreCatalog {
  style: StoreStyle;
  /** Why this style and these items, for the user and the team. */
  why: string;
  items: StoreItem[];
  updatedAt: string;
}

export interface StoreCopy {
  title: string;
  description: string;
  /** The versions before the current ones (newest first, a few each). */
  history: Array<{ field: 'title' | 'description'; text: string; at: string; by: string }>;
  updatedAt: string;
}

/** Roblox's limits (the creator docs; skill roblox-store-copy). */
export const STORE_LIMITS = { name: 50, description: 1000, title: 50, gameDescription: 1000, priceMin: 1, priceMax: 1_000_000_000, keyMax: 32, items: 60 };

/** Where an item stands: a draft (only here), on Roblox and up to date, changed since it was pushed, or off sale. */
export type ItemStatus = 'draft' | 'live' | 'changed' | 'offsale';

export const itemHash = (i: StoreItem): string =>
  createHash('sha1')
    .update(JSON.stringify([i.kind, i.name, i.description, i.price, i.icon?.file ?? null, ...(i.icon?.sha ? [i.icon.sha] : [])]))
    .digest('hex')
    .slice(0, 12);

export function itemStatus(i: StoreItem): ItemStatus {
  if (!i.roblox) return 'draft';
  if (!i.roblox.forSale) return 'offsale';
  return i.roblox.hash === itemHash(i) ? 'live' : 'changed';
}

/** Luau's reserved words: not a key (Store.items.<key> must be valid code). */
const LUAU_RESERVED = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'export', 'type', 'typeof']);

/** Words that sell an advantage: a cosmetic store's item that says one of these is pointed out. */
const ADVANTAGE = /\b(\d+(\.\d+)?x|double|triple|faster|speed|damage|health|hp|armou?r|luck|lucky|skip|revive|extra (?:life|lives|slots?)|boost(?:s|ed)?|stronger|power(?:ful)?|auto[- ]?(?:collect|farm|click))\b/i;

/** Problems that stop a catalog change (errors) and things worth a second look (warnings). */
export function checkCatalog(c: StoreCatalog): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!STORE_STYLES.includes(c.style)) errors.push(`style: one of ${STORE_STYLES.join(', ')}`);
  if (c.items.length > STORE_LIMITS.items) errors.push(`${c.items.length} items: keep a store under ${STORE_LIMITS.items}`);
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const i of c.items) {
    const at = `${i.key || '(no key)'}`;
    if (!/^[A-Za-z][A-Za-z0-9]{1,31}$/.test(i.key ?? '')) errors.push(`${at}: key must be a code name of 2-32 letters and digits, starting with a letter ("VIP", "Coins500")`);
    else if (LUAU_RESERVED.has(i.key)) errors.push(`${at}: a word Luau keeps for itself; pick another key ("${i.key}Pass")`);
    if (keys.has(i.key)) errors.push(`${at}: two items share this key`);
    keys.add(i.key);
    if (i.kind !== 'pass' && i.kind !== 'product') errors.push(`${at}: kind is "pass" (bought once, kept) or "product" (bought again and again)`);
    if (!i.name?.trim()) errors.push(`${at}: needs a name`);
    else if (i.name.length > STORE_LIMITS.name) errors.push(`${at}: name is ${i.name.length} characters; Roblox allows ${STORE_LIMITS.name}`);
    if (names.has(i.name?.toLowerCase())) warnings.push(`${at}: another item has the same name`);
    names.add(i.name?.toLowerCase());
    if ((i.description ?? '').length > STORE_LIMITS.description) errors.push(`${at}: description is ${i.description.length} characters; Roblox allows ${STORE_LIMITS.description}`);
    if (!Number.isInteger(i.price) || i.price < STORE_LIMITS.priceMin || i.price > STORE_LIMITS.priceMax) errors.push(`${at}: price must be a whole number of Robux, ${STORE_LIMITS.priceMin} or more`);
    if (!i.benefit?.trim()) errors.push(`${at}: say what it gives the player (benefit): the engineers build exactly that`);
    if (c.style === 'cosmetic' && ADVANTAGE.test(`${i.name} ${i.description} ${i.benefit}`)) warnings.push(`${at}: the store is cosmetic-only, and this item reads like an advantage ("${ADVANTAGE.exec(`${i.name} ${i.description} ${i.benefit}`)?.[0]}"): looks and status only in a skill-based game`);
    if (/(?:https?:|www\.|\.com\b|discord|youtube|tiktok|twitter|instagram|@\w)/i.test(`${i.name} ${i.description}`)) errors.push(`${at}: nothing may point players off Roblox (links, handles, other platforms)`);
    if (i.hue !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(i.hue)) errors.push(`${at}: hue is a colour like "#FFC83D"`);
    if (i.random && i.description && !/\bodds\b|\bchances?\b|%/i.test(i.description)) warnings.push(`${at}: a paid random item: its description should say the odds are shown before buying (and the game must show them)`);
  }
  return { errors, warnings };
}

/** Problems with the game's title and description (errors stop the change). */
export function checkCopy(field: 'title' | 'description', text: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const max = field === 'title' ? STORE_LIMITS.title : STORE_LIMITS.gameDescription;
  if (!text.trim()) errors.push(`${field}: empty`);
  if (text.length > max) errors.push(`${field}: ${text.length} characters; Roblox allows ${max}`);
  if (/(?:https?:|www\.|\.com\b|discord|youtube|tiktok|twitter|instagram|\btwitch\b)/i.test(text)) errors.push(`${field}: nothing may point players off Roblox (links, handles, other platforms)`);
  if (field === 'title' && /[\p{Extended_Pictographic}]/u.test(text) && (text.match(/[\p{Extended_Pictographic}]/gu) ?? []).length > 2) warnings.push('title: more than two emoji read as spam in search');
  if (field === 'description' && text.length < 150) warnings.push('description: under 150 characters says little in search and on the page');
  return { errors, warnings };
}

/** The Storefront in a few lines, for the director's state. */
export function storefrontLines(root: string, prefs: { monetization: boolean; copy: boolean }, art: { thumbs: number; picked: string | null; icon: string | null }): string[] {
  if (!prefs.monetization && !prefs.copy) return [];
  const sf = new Storefront(root);
  const c = sf.catalog();
  const copy = sf.copy();
  const by = (s: ItemStatus) => c.items.filter((i) => itemStatus(i) === s).length;
  return [
    'Storefront (the page the user opens with show page "storefront"):',
    ...(prefs.monetization
      ? [
          c.items.length
            ? `- Store (${c.style}): ${c.items.length} item(s): ${by('draft')} draft (not on Roblox yet), ${by('live')} on Roblox, ${by('changed')} changed since pushed, ${by('offsale')} off sale. ${c.items.map((i) => `${i.key} R$${i.price}`).join(', ')}. Pushed only when the user asks (storePush) or presses Push.`
            : '- Store: nothing designed yet.',
        ]
      : ['- Monetization is off: no store.']),
    ...(prefs.copy ? [`- Copy: title ${copy.title ? `"${copy.title}"` : 'not written'}; description ${copy.description ? `${copy.description.length} characters` : 'not written'}.`] : []),
    `- Pictures: ${art.thumbs} thumbnail(s)${art.picked ? `, the pick: ${art.picked}` : ''}; game icon ${art.icon ?? 'not made'}. The user downloads them on the Storefront page.`,
  ];
}

/** The project's Storefront files. */
export class Storefront {
  constructor(private readonly root: string) {}

  dir(): string {
    return join(this.root, '.shuriken', 'storefront');
  }
  artDir(): string {
    return join(this.dir(), 'art');
  }

  private read<T>(name: string, fallback: T): T {
    try {
      const f = join(this.dir(), name);
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fallback;
    } catch {
      return fallback;
    }
  }
  private write(name: string, data: unknown): void {
    mkdirSync(this.dir(), { recursive: true });
    const f = join(this.dir(), name);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, f);
  }

  catalog(): StoreCatalog {
    return this.read<StoreCatalog>('catalog.json', { style: 'fair', why: '', items: [], updatedAt: '' });
  }

  /**
   * Saves the catalog (after checkCatalog). `apply` says whose changes go into the game: 'all' (the default: the store
   * put in the game), the keys a writer changed (the team, the user's own edit, a push), or none (a copilot's draft
   * turn, or nothing the module shows). The game's module is written from what is applied (applied.json), so a draft
   * stays out of the game until it is put in, also when someone else changes another item meanwhile.
   */
  saveCatalog(c: StoreCatalog, syncMap?: SyncMap, opts: { apply?: readonly string[] | 'all' } = {}): { file: string; written: boolean } {
    const before = this.catalog();
    let applied = this.readApplied() ?? before.items;
    const next = { ...c, items: [...c.items].sort((a, b) => (a.order ?? 999) - (b.order ?? 999)), updatedAt: nowIso() };
    this.write('catalog.json', next);
    const apply = opts.apply ?? 'all';
    if (apply === 'all') applied = next.items;
    else
      for (const key of apply) {
        const now = next.items.find((i) => i.key === key);
        applied = [...applied.filter((i) => i.key !== key), ...(now ? [now] : [])];
      }
    this.write('applied.json', applied);
    if (apply !== 'all' && apply.length === 0) return { file: Storefront.moduleLocation(syncMap).file, written: false };
    return { ...this.writeModule(syncMap), written: true };
  }

  /** The items as last put in the game (null before the first save that kept them). */
  private readApplied(): StoreItem[] | null {
    return this.read<StoreItem[] | null>('applied.json', null);
  }

  /** What the game's module holds: the applied items in the catalog's order, each with its Roblox id as it is now. */
  appliedItems(): StoreItem[] {
    const c = this.catalog();
    const applied = this.readApplied() ?? c.items;
    const order = new Map(c.items.map((i, n) => [i.key, n]));
    return [...applied]
      .sort((a, b) => (order.get(a.key) ?? 1e6) - (order.get(b.key) ?? 1e6))
      .map((i) => {
        const now = c.items.find((x) => x.key === i.key);
        return now?.roblox ? { ...i, roblox: now.roblox } : i;
      });
  }

  copy(): StoreCopy {
    return this.read<StoreCopy>('copy.json', { title: '', description: '', history: [], updatedAt: '' });
  }

  saveCopy(patch: { title?: string; description?: string }, by: string): StoreCopy {
    const now = this.copy();
    const history = [...now.history];
    for (const field of ['title', 'description'] as const) {
      const v = patch[field];
      if (v === undefined || v === now[field]) continue;
      if (now[field]) history.unshift({ field, text: now[field], at: now.updatedAt || nowIso(), by });
    }
    // A few versions of each are kept to go back to.
    const kept = [...history.filter((h) => h.field === 'title').slice(0, 5), ...history.filter((h) => h.field === 'description').slice(0, 5)];
    const next: StoreCopy = { title: patch.title ?? now.title, description: patch.description ?? now.description, history: kept, updatedAt: nowIso() };
    this.write('copy.json', next);
    return next;
  }

  /** Where the game's store module lives (with its other shared code). */
  static moduleLocation(syncMap: SyncMap | undefined): { file: string; requirePath: string } {
    return sharedModuleLocation(syncMap, 'ShurikenStore');
  }

  /** The game's store module from what is applied: its items with their Roblox ids (0 until pushed) and the runtime. */
  writeModule(syncMap?: SyncMap): { file: string } {
    const loc = Storefront.moduleLocation(syncMap);
    const path = join(this.root, loc.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, storeModule(this.appliedItems()), 'utf8');
    return { file: loc.file };
  }

  /** The whole store as designed, put in the game. */
  applyAll(syncMap?: SyncMap): { file: string } {
    this.write('applied.json', this.catalog().items);
    return this.writeModule(syncMap);
  }

  /** Whether the game's store module differs from the catalog (a draft change not put in the game yet, or an older runtime). */
  moduleBehind(syncMap?: SyncMap): boolean {
    const items = this.catalog().items;
    const path = join(this.root, Storefront.moduleLocation(syncMap).file);
    if (!existsSync(path)) return items.length > 0;
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== storeModule(items).replace(/\r\n/g, '\n');
  }

  /** Whether the game's store module is older than the runtime this app writes. */
  moduleStale(syncMap?: SyncMap): boolean {
    const path = join(this.root, Storefront.moduleLocation(syncMap).file);
    if (!existsSync(path)) return this.catalog().items.length > 0;
    const m = /^-- ShurikenStore v(\d+)/m.exec(readFileSync(path, 'utf8'));
    return !m || Number(m[1]) < STORE_RUNTIME_VERSION;
  }
}
