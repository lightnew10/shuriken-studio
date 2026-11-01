import type { MockupSummary } from '@shared/ui-mockup';
import { turnMode, type TurnMode } from './intent';

/**
 * What a message to the UI copilot asks for (copilots/intent.ts decides, for every copilot): a draft turn
 * answers with mockups in Shuriken and nothing in Studio or the code changes; an import turn ("put it in the
 * game", "build it", "apply B", the UI page's Put it in the game button, a plain yes to the copilot's offer)
 * builds a mockup into the game. This file finds which mockup and version is meant.
 */

/** The kind of turn a message to the UI copilot gets; `offered`: its last reply made or changed a mockup. */
export function uiTurnMode(text: string, opts: { offered?: boolean } = {}): TurnMode {
  return turnMode(text, { ...opts, versions: true });
}

export interface MockupRef {
  name: string;
  version: string;
}

/** "mockup:<name>" or "mockup:<name>@<version>" (the UI page's dock context, the copilot's show buttons). */
export function parseMockupItem(item: string | undefined | null): { name: string; version: string | null } | null {
  const m = /^mockup:([a-z0-9][a-z0-9-]*)(?:@([A-Z]{1,2}))?$/.exec(item?.trim() ?? '');
  return m ? { name: m[1]!, version: m[2] ?? null } : null;
}

/**
 * The mockup a "put it in the game" means: one the message names (by title, with a version letter if it
 * gives one), else the one the user is looking at, else the one the copilot made last in this conversation.
 * The version: the one named, else the one on screen, else the user's pick, else the copilot's latest.
 */
export function applyTarget(text: string, looking: string | undefined | null, last: MockupRef | null, mockups: MockupSummary[]): MockupRef | null {
  const lower = text.toLowerCase();
  const named = [...mockups].sort((a, b) => b.title.length - a.title.length).find((m) => lower.includes(m.title.toLowerCase()) || new RegExp(`\\b${m.name}\\b`).test(lower));
  const onScreen = parseMockupItem(looking);
  const name = named?.name ?? onScreen?.name ?? last?.name ?? null;
  const m = name ? mockups.find((x) => x.name === name) : undefined;
  if (!m) return null;
  const ids = new Set(m.versions.map((v) => v.id));
  const said = /\bversion\s+([a-z]{1,2})\b/i.exec(text)?.[1]?.toUpperCase() ?? /\b(?:[Bb]uild|[Aa]pply|[Ss]hip|[Uu]se|[Pp]ut|[Ii]mplement)\s+([A-Z]{1,2})\b/.exec(text)?.[1];
  const version =
    (said && ids.has(said) ? said : null) ??
    (onScreen?.name === m.name && onScreen.version && ids.has(onScreen.version) ? onScreen.version : null) ??
    (m.chosen && ids.has(m.chosen) ? m.chosen : null) ??
    (last?.name === m.name && ids.has(last.version) ? last.version : null) ??
    m.versions[m.versions.length - 1]?.id ??
    null;
  return version ? { name: m.name, version } : null;
}
