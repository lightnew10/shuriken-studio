/**
 * Drafts in the docks, without the DOM: where something a copilot (or the user) made stands — a draft to try
 * out in Shuriken, or in the game — what its Add to game button calls and says, and what the chat shows for
 * what a copilot's reply made. Tested in tests/renderer.
 */

/** The docks whose drafts are added with one call (the UI's mockups are built by its copilot instead). */
export type DraftDock = 'animation' | 'audio' | 'effects';

/** Something a copilot's reply made or changed (core/copilots/copilot-service.ts: `data.drafts`). */
export interface DraftRef {
  name: string;
  draft?: boolean;
  /** The game's item a draft is a new take of. */
  of?: string;
}

export const DRAFT_DOCKS: Record<DraftDock, { thing: string; list: string; key: string; use: string; events: string[] }> = {
  animation: { thing: 'animation', list: 'animations.list', key: 'animations', use: 'animations.use', events: ['animations.changed', 'project.changed'] },
  audio: { thing: 'sound', list: 'audio.list', key: 'sounds', use: 'audio.use', events: ['assets.changed', 'project.changed'] },
  effects: { thing: 'effect', list: 'effects.list', key: 'effects', use: 'effects.use', events: ['effects.changed', 'project.changed'] },
};

export const isDraftDock = (dock: string): dock is DraftDock => dock in DRAFT_DOCKS;

/** What a reply's `data.drafts` holds, read defensively (it comes from stored chat data). */
export function draftRefs(x: unknown): DraftRef[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((r): r is DraftRef => !!r && typeof r === 'object' && typeof (r as DraftRef).name === 'string' && !!(r as DraftRef).name)
    .map((r) => ({ name: r.name, ...(r.draft ? { draft: true } : {}), ...(typeof r.of === 'string' && r.of ? { of: r.of } : {}) }))
    .slice(0, 6);
}

/** A dock's items by name with whether each is a draft, from its list RPC's answer (null until it has answered). */
export function dockItems(dock: DraftDock, data: unknown): Map<string, { draft: boolean; of?: string }> | null {
  const rows = data && typeof data === 'object' ? (data as Record<string, unknown>)[DRAFT_DOCKS[dock].key] : null;
  if (!Array.isArray(rows)) return null;
  const out = new Map<string, { draft: boolean; of?: string }>();
  for (const r of rows as Array<{ name?: unknown; draft?: unknown; draftOf?: unknown }>) {
    if (typeof r?.name === 'string') out.set(r.name, { draft: r.draft === true, ...(typeof r.draftOf === 'string' ? { of: r.draftOf } : {}) });
  }
  return out;
}

export type Standing = 'draft' | 'in-game' | 'gone';

/**
 * Where what a reply made stands now: still a draft, in the game (added since, or made there), or gone (removed,
 * or put in under another name). Before the dock's list has answered, what the reply recorded.
 */
export function standing(ref: DraftRef, items: Map<string, { draft: boolean }> | null): Standing {
  if (!items) return ref.draft ? 'draft' : 'in-game';
  const now = items.get(ref.name);
  return !now ? 'gone' : now.draft ? 'draft' : 'in-game';
}

/** The line under the name on a draft's card. */
export function standingLine(dock: DraftDock, ref: DraftRef, state: Standing): string {
  if (state === 'in-game') return 'In the game';
  if (state === 'gone') return ref.of ? `No longer a draft (it replaced ${ref.of}, or was removed)` : 'No longer here (removed or renamed)';
  return ref.of ? `Draft · a new take of ${ref.of} · not in the game` : `Draft ${DRAFT_DOCKS[dock].thing} · not in the game`;
}

export interface DraftAction {
  label: string;
  title: string;
  params: { name: string; as?: string };
  primary: boolean;
}

/**
 * What a draft offers: Add to game under its own name, and — when it is a new take of something in the game
 * that is still there — Replace it, which comes first because that is what the user was changing.
 */
export function draftActions(dock: DraftDock, ref: { name: string; of?: string }, inGame: (name: string) => boolean = () => true): DraftAction[] {
  const thing = DRAFT_DOCKS[dock].thing;
  const add: DraftAction = { label: 'Add to game', title: `Put this ${thing} in your game as ${ref.name}`, params: { name: ref.name }, primary: true };
  if (!ref.of || !inGame(ref.of)) return [add];
  return [
    { label: `Replace ${ref.of}`, title: `Put this take in your game in place of ${ref.of}`, params: { name: ref.name, as: ref.of }, primary: true },
    { ...add, label: 'Add as new', primary: false },
  ];
}

/** What a dock's copilot says before the first message: its drafts stay here until the user adds them. */
export function dockIntro(dock: 'animation' | 'audio' | 'ui' | 'effects' | 'store' | 'copy' | 'thumbnails'): string {
  if (dock === 'store')
    return 'Ask about what the game sells: the store’s design changes here as a draft, goes into your game only when you press Put it in the game or say so, and onto Roblox only when you press Push to Roblox.';
  if (dock === 'copy') return 'Ask for a title, a description or the store’s texts: they are written here for you to copy to Roblox (the store’s texts go up with Push to Roblox).';
  if (dock === 'thumbnails') return 'Ask for thumbnails, the game’s icon or the store’s icons: they are made here for you to save and upload to Roblox yourself.';
  if (dock === 'ui') return 'Ask for a design: it is mocked up on the UI page first, on every device, and goes into your game only when you say “put it in the game”.';
  if (dock === 'audio') return 'Ask for music or a sound: it is made as a draft to listen to here, and goes into your game only when you press Add to game or say “put it in the game”.';
  if (dock === 'effects') return 'Ask for an effect: it is made as a draft that plays in the preview here, and goes into your game only when you press Add to game or say “put it in the game”.';
  return 'Ask for a move: it is made as a draft that plays on the mannequin here, and goes into your game only when you press Add to game or say “put it in the game”.';
}

/**
 * What an Add to game call came to, for the page: an error, a note (it is in the game's files but Studio wasn't
 * there to build it into, or a texture still shows its stand-in), or nothing to say.
 */
export function addOutcome(r: { ok: boolean; text: string; data?: unknown } | null | undefined): { ok: boolean; note: string | null } {
  if (!r) return { ok: false, note: 'No answer.' };
  if (!r.ok) return { ok: false, note: r.text.slice(0, 600) };
  const out = (r.data && typeof r.data === 'object' ? r.data : {}) as { note?: unknown; built?: unknown; standInTextures?: unknown; replaced?: unknown };
  const notes: string[] = [];
  if (out.built === false && typeof out.note === 'string') notes.push(out.note);
  if (Array.isArray(out.standInTextures) && out.standInTextures.length) notes.push(`Not uploaded yet, so the game shows a stand-in: ${out.standInTextures.join('; ')}`);
  return { ok: true, note: notes.length ? notes.join(' ').slice(0, 600) : null };
}
