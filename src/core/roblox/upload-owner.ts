import { robloxId } from '@shared/roblox-keys';

/**
 * Who owns what Shuriken uploads to Roblox (sounds, animations, icons, effect textures, meshes). Communities are the
 * standard: a game published under a community needs its animations owned by that community (Roblox plays only
 * animations the experience's owner owns) and its sounds owned by it or granted to it, and a community keeps a team's
 * assets, revenue and access out of one person's account. In order:
 *   1. the community or account set for this project (before it started, or in its window's Settings);
 *   2. the owner of the published game, read from Studio (a game published under a community uploads to it, one
 *      published under a person to that person: a community-owned animation won't play in a person's game);
 *   3. the default community set in Settings;
 *   4. the person signed in to Studio (or the creator id set in Settings), as before.
 * A project's own Open Cloud key (roblox/project-keys.ts) goes with its own owner: a community's uploads need one of
 * that community's keys.
 */
export type UploadOwner =
  | { kind: 'group'; id: string; source: 'project' | 'game' | 'default' }
  /** id: an account other than the default one, set for this project (unset: the default person). */
  | { kind: 'user'; id?: string; source: 'project' | 'game' | 'user' };

/** The owner as a short key stored with each upload (an upload made for another owner is not reused). */
export const ownerKey = (o: UploadOwner | null | undefined): string => (!o ? 'u' : o.kind === 'group' ? `g:${o.id}` : o.id ? `u:${o.id}` : 'u');

/** Uploads stored before owners were recorded were made for the person. */
export const LEGACY_OWNER = 'u';

/** Luau (Edit) that reads the published game's owner: "Group|123" or "User|456"; "…|0" when the place is unpublished. */
export const GAME_OWNER_LUAU = 'return game.CreatorType.Name .. "|" .. tostring(game.CreatorId)';

export function parseGameOwner(output: string): { type: 'Group' | 'User'; id: string } | null {
  const m = /^\s*"?(Group|User)\|(\d+)"?\s*$/.exec(output);
  if (!m || m[2] === '0') return null;
  return { type: m[1] as 'Group' | 'User', id: m[2]! };
}

/** A community id as typed in Settings: digits only ('' or null: none). */
export const communityId = robloxId;

export async function resolveUploadOwner(d: {
  projectGroup: () => string | null;
  gameOwner: () => Promise<{ type: 'Group' | 'User'; id: string } | null>;
  defaultGroup: () => string | null;
  /** The account set for this project (its community wins when both are set). */
  projectUser?: () => string | null;
  /** The default account (Settings, or found from Studio): a project naming it needs no id of its own. */
  defaultUser?: () => string | null;
}): Promise<UploadOwner> {
  const own = communityId(d.projectGroup());
  if (own) return { kind: 'group', id: own, source: 'project' };
  const person = robloxId(d.projectUser?.() ?? null);
  if (person) return person === robloxId(d.defaultUser?.() ?? null) ? { kind: 'user', source: 'project' } : { kind: 'user', id: person, source: 'project' };
  const game = await d.gameOwner().catch(() => null);
  if (game?.type === 'Group') return { kind: 'group', id: game.id, source: 'game' };
  if (game?.type === 'User') return { kind: 'user', source: 'game' };
  const fallback = communityId(d.defaultGroup());
  if (fallback) return { kind: 'group', id: fallback, source: 'default' };
  return { kind: 'user', source: 'user' };
}

/** In words, for Settings and results: where uploads go now. */
export function ownerLine(o: UploadOwner): string {
  if (o.kind === 'user') {
    if (o.source === 'project') return o.id ? `account ${o.id} (set for this project)` : 'your account (set for this project)';
    return o.source === 'game' ? 'your account (the game is published under it)' : 'your account';
  }
  const where = o.source === 'project' ? 'set for this project' : o.source === 'game' ? 'the published game belongs to it' : 'the default in Settings';
  return `community ${o.id} (${where})`;
}

/** What a refused upload to a community needs. */
export const COMMUNITY_KEY_HINT =
  'Uploads go to a community, so the Open Cloud key must be one of that community\'s keys (create.roblox.com → switch to the community → Open Cloud → API Keys) with Assets read and write; pushing the store also needs Game Passes and Developer Products write for the game. Save it as this project\'s own key (Settings → Roblox & Studio → This project) to keep your personal key as the default.';
