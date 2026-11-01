/**
 * The Audio page's list of sounds, without the DOM: how sounds are grouped, where the arrow keys move
 * the selection, which keys the page takes, and where each sound stands. Tested in tests/renderer.
 */

export type SoundKind = 'music' | 'sfx' | 'ambience';

/** The groups top to bottom, as the page lists them. */
export const KIND_ORDER: SoundKind[] = ['music', 'sfx', 'ambience'];
export const KIND_LABEL: Record<SoundKind, string> = { music: 'Music', sfx: 'Sound effects', ambience: 'Ambience' };

export interface SoundGroup<T> {
  kind: SoundKind;
  sounds: T[];
}

/** The non-empty groups in page order; a sound keeps its place in the library inside its group. */
export function groupSounds<T extends { kind: SoundKind }>(sounds: readonly T[]): SoundGroup<T>[] {
  return KIND_ORDER.map((kind) => ({ kind, sounds: sounds.filter((s) => s.kind === kind) })).filter((g) => g.sounds.length > 0);
}

/** A sound with a file Shuriken can play here (a Creator Store sound only plays in Studio and the game). */
export function canPlay(s: { source: string; file?: string }): boolean {
  return s.source !== 'store' && !!s.file;
}

/** Where a sound stands: a draft to try out, in the game (its code plays it), only in the library, or waiting to upload. */
export function soundState(s: { assetId: string | null; draft?: boolean; playedBy?: string[] }): { label: string; tone: string; title: string } {
  if (s.draft) return { label: 'draft', tone: 'text-faint', title: 'Made in the Audio dock to try out: not in the game until you add it' };
  if (!s.assetId) return { label: 'not uploaded', tone: 'text-warn', title: 'In the game but silent until it is uploaded to Roblox' };
  if (s.playedBy?.length) return { label: 'in game', tone: 'text-ok', title: `Played by ${s.playedBy.join(', ')}` };
  return { label: 'unused', tone: 'text-faint', title: "In the game's sound library, but no script plays it yet" };
}

/** "0.42 s", "12 s", "1:32". */
export function soundLength(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return '';
  if (sec < 10) return `${sec.toFixed(2)} s`;
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The mastering gate's line (`check` in the sound's entry: "ok: -12 LUFS-M (target -12), -1.6 dBTP, …;
 * issue; issue") in words: nothing to report, or the issues it found.
 */
export function checkWords(check: string | undefined): string | null {
  if (!check) return null;
  if (/^ok\b/.test(check)) return 'Measured clean: right loudness, no clipping, clicks or silence at the start.';
  const issues = check.split(';').slice(1).map((x) => x.trim()).filter(Boolean);
  return issues.length ? `Measured: ${issues.join('; ')}.` : null;
}

export type NavAction = 'up' | 'down' | 'left' | 'right' | 'first' | 'last' | 'toggle';

/** What had focus when a key was pressed, as far as the key rules care. */
export interface KeyTarget {
  /** The element's tag (BODY when nothing has focus). */
  tag: string;
  /** contenteditable, or a role that types or adjusts (textbox, slider, spinbutton, combobox). */
  editable: boolean;
  /** Inside the sounds' area (the list and the selected sound), not the copilot, the top bar or a dialog. */
  inSounds: boolean;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const KEYS: Record<string, NavAction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'first', End: 'last', ' ': 'toggle', Enter: 'toggle' };

/**
 * The page's keys: arrows move between sounds, Home/End jump, Space or Enter plays/stops. They are left
 * alone while the user types anywhere (the copilot's box, a name field), with a modifier held, while a
 * menu or dialog is open, outside the sounds' area, and Space/Enter on a button (which presses it).
 */
export function navAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean }, t: KeyTarget, overlayOpen = false): NavAction | null {
  const action = KEYS[e.key];
  if (!action || overlayOpen || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (TYPING_TAGS.has(t.tag) || t.editable) return null;
  if (t.tag !== 'BODY' && t.tag !== 'HTML' && !t.inSounds) return null;
  if (action === 'toggle' && (t.tag === 'BUTTON' || t.tag === 'A' || t.tag === 'SUMMARY')) return null;
  // Holding Space would start and stop the sound over and over.
  if (action === 'toggle' && e.repeat) return null;
  return action;
}

/**
 * Where the selection goes: Up/Down one sound through the whole list (no wrap), Left/Right to the first
 * sound of the previous/next group (staying put at either end), Home/End to the first/last sound. With
 * nothing selected (or a sound that is gone), any move lands on the first sound (End on the last).
 */
export function moveSelection<T extends { name: string }>(groups: readonly SoundGroup<T>[], current: string | null, action: NavAction): string | null {
  const flat = groups.flatMap((g) => g.sounds.map((s) => s.name));
  if (!flat.length) return null;
  const at = current === null ? -1 : flat.indexOf(current);
  if (action === 'toggle') return at >= 0 ? current : null;
  if (action === 'last') return flat[flat.length - 1]!;
  if (at < 0 || action === 'first') return flat[0]!;
  if (action === 'up') return flat[Math.max(0, at - 1)]!;
  if (action === 'down') return flat[Math.min(flat.length - 1, at + 1)]!;
  const gi = groups.findIndex((g) => g.sounds.some((s) => s.name === current));
  const to = groups[action === 'left' ? gi - 1 : gi + 1];
  return to ? to.sounds[0]!.name : current;
}
