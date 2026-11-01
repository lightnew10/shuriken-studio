/**
 * The Storefront page's reading of `storefront.get` (core storefront/): what each item's status means, which tabs
 * show with the app's Storefront switches, and the thumbnails in the order the judge left them. Pure, tested in
 * tests/renderer.
 */

export type ItemStatus = 'draft' | 'live' | 'changed' | 'offsale';
export type StoreStyle = 'cosmetic' | 'fair' | 'aggressive';

export interface StoreItemView {
  key: string;
  kind: 'pass' | 'product';
  name: string;
  description: string;
  price: number;
  benefit: string;
  icon?: { subject?: string; file?: string; sha?: string };
  roblox?: { id: number; pushedAt: string; forSale: boolean };
  status: ItemStatus;
  /** What the item is now (core itemHash): the Push button sends it with the key, so nothing changed since is pushed unseen. */
  hash?: string;
}

export interface ArtEntry {
  name: string;
  file: string;
  note: string;
  at: string;
  by: string;
}

export interface ThumbPick {
  winner: string;
  rounds: Array<{ out: string; why: string }>;
  why: string;
  at: string;
  byUser?: boolean;
  among: string[];
}

export interface StorefrontView {
  prefs: { monetization: boolean; copy: boolean };
  catalog: { style: StoreStyle; why: string; items: StoreItemView[]; updatedAt: string } | null;
  copy: { title: string; description: string; history: Array<{ field: 'title' | 'description'; text: string; at: string; by: string }>; updatedAt: string } | null;
  art: { thumbs: ArtEntry[]; pick?: ThumbPick; icons: ArtEntry[]; gameIcon?: string; template?: unknown } | null;
  pending: string[];
  module?: string;
  behind?: boolean;
  limits?: { name: number; description: number; title: number; gameDescription: number; priceMin: number };
}

export type StorefrontTab = 'store' | 'pictures' | 'copy';

/** The tabs the app's switches leave: the store with monetization, the words with copy, the pictures with either. */
export function storefrontTabs(prefs: { monetization: boolean; copy: boolean } | undefined): StorefrontTab[] {
  if (!prefs) return [];
  return [...(prefs.monetization ? (['store'] as const) : []), ...(prefs.monetization || prefs.copy ? (['pictures'] as const) : []), ...(prefs.copy ? (['copy'] as const) : [])];
}

/** Each tab's copilot (core copilots/copilot-roles.ts). */
export const TAB_COPILOT: Record<StorefrontTab, 'store' | 'thumbnails' | 'copy'> = { store: 'store', pictures: 'thumbnails', copy: 'copy' };

export const STATUS: Record<ItemStatus, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'info'; hint: string }> = {
  draft: { label: 'Not on Roblox', tone: 'neutral', hint: 'Designed and in the game’s code with Studio test purchases; it goes on Roblox with Push to Roblox.' },
  live: { label: 'On Roblox', tone: 'ok', hint: 'On sale on Roblox: the game’s store module has its id.' },
  changed: { label: 'Changed', tone: 'warn', hint: 'Changed since it was pushed: Push to Roblox sends the change.' },
  offsale: { label: 'Off sale', tone: 'neutral', hint: 'On Roblox but not for sale.' },
};

export const STYLE: Record<StoreStyle, { label: string; hint: string }> = {
  cosmetic: { label: 'Cosmetics & status', hint: 'Looks and status only (skins, effects, VIP): nothing that gives an advantage in a match.' },
  fair: { label: 'Fair', hint: 'Convenience and time saved that never decide a match.' },
  aggressive: { label: 'Built to sell', hint: 'The genre’s strong sellers: boosts, multipliers, extra slots, currency.' },
};

export const kindLabel = (k: 'pass' | 'product'): string => (k === 'pass' ? 'Game pass' : 'Developer product');

/** "42/50", and how close to Roblox's limit it is. */
export function countLine(text: string, max: number): { text: string; tone: 'faint' | 'warn' | 'bad' } {
  const n = [...text].length;
  return { text: `${n}/${max}`, tone: n > max ? 'bad' : n > max * 0.9 ? 'warn' : 'faint' };
}

/**
 * The thumbnails as the judge left them: the pick first, then the last ones standing (the runner-up before the first
 * to fall), then the ones the judge didn't see. `place` is 1 for the pick, 2 for the runner-up…; null when not judged.
 */
export function thumbStandings(thumbs: readonly ArtEntry[], pick: ThumbPick | undefined): Array<ArtEntry & { place: number | null; why: string }> {
  const out = thumbs.map((t) => {
    if (pick && t.name === pick.winner) return { ...t, place: 1, why: pick.byUser ? '' : pick.why };
    const round = pick ? pick.rounds.findIndex((r) => r.out === t.name) : -1;
    // The user's own pick replaces the judge's: the judge's reasons stay, its places no longer add up.
    if (pick && round >= 0) return { ...t, place: pick.byUser ? null : pick.rounds.length - round + 1, why: pick.rounds[round]!.why };
    return { ...t, place: null, why: '' };
  });
  return out.sort((a, b) => (a.place ?? 999) - (b.place ?? 999) || b.at.localeCompare(a.at));
}

/** The Push to Roblox line: what a push would send, by kind. */
export function pushLine(items: readonly StoreItemView[], pending: readonly string[]): string {
  const sending = items.filter((i) => pending.includes(i.key));
  if (!sending.length) return items.length ? 'Everything in the store is on Roblox and up to date.' : '';
  const passes = sending.filter((i) => i.kind === 'pass').length;
  const products = sending.length - passes;
  const parts = [passes ? `${passes} game pass${passes === 1 ? '' : 'es'}` : '', products ? `${products} developer product${products === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const changed = sending.filter((i) => i.status === 'changed').length;
  return `${parts} ${sending.length === 1 ? 'isn’t' : 'aren’t'} on Roblox yet${changed ? ` (${changed} changed since pushed)` : ''}.`;
}
