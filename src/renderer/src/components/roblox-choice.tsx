import { KeyRound, Users } from 'lucide-react';
import { projectOpenCloudKey, robloxId, type ProjectRobloxChoice } from '@shared/roblox-keys';
import { cx } from './ui';

/**
 * A new game's Roblox side, chosen before it starts (start page, Open a game): where its uploads and store go (the
 * defaults in Settings, a community, or another account) and, optionally, an Open Cloud key of its own. The key never
 * goes through the core: the renderer saves it encrypted by the project's id once the project exists.
 */
export type RobloxMode = 'default' | 'community' | 'account';
export interface RobloxDraft {
  mode: RobloxMode;
  id: string;
  key: string;
}
export const EMPTY_ROBLOX: RobloxDraft = { mode: 'default', id: '', key: '' };

const MODES: ReadonlyArray<readonly [RobloxMode, string]> = [
  ['default', 'Defaults'],
  ['community', 'A community'],
  ['account', 'Another account'],
];

/** What the draft asks the core for, or why it can't be used yet. */
export function robloxChoice(d: RobloxDraft): { choice?: ProjectRobloxChoice; problem?: string } {
  if (d.mode === 'default') return {};
  const id = robloxId(d.id);
  if (!id) return { problem: d.mode === 'community' ? "Type the community's id (the digits in its address on roblox.com), or choose Defaults." : "Type the account's user id (the digits in its profile address on roblox.com), or choose Defaults." };
  return { choice: d.mode === 'community' ? { groupId: id } : { userId: id } };
}

/** Saves the new project's own key, once it exists (nothing when none was typed: it uses the default). */
export async function saveProjectKey(projectId: string | undefined, key: string): Promise<void> {
  const k = key.trim();
  if (projectId && k) await window.shuriken.secrets.set(projectOpenCloudKey(projectId), k);
}

/** One line for the start page's closed chip. */
export function robloxSummary(d: RobloxDraft): string {
  const id = robloxId(d.id);
  const who = d.mode === 'community' ? (id ? `community ${id}` : 'a community') : d.mode === 'account' ? (id ? `account ${id}` : 'another account') : 'your defaults';
  return `Roblox: ${who}${d.key.trim() ? ', own key' : ''}`;
}

export function modeHint(mode: RobloxMode): string {
  if (mode === 'community')
    return "Uploads and the store go to this community, so its game plays them. Its key must be one of the community's own (create.roblox.com → switch to the community → Open Cloud → API Keys: Assets read and write, plus Game Passes and Developer Products write for the store).";
  if (mode === 'account') return "Uploads and the store go to this account instead of your default one. Use that account's own Open Cloud key.";
  return 'Your account, default community and key from Settings (a game published under a community still uploads to it).';
}

/**
 * The fields. `tone` "dark" sits on the start page's black field; "app" in dialogs and Settings.
 */
export function RobloxChoiceFields({ value, onChange, tone = 'app', disabled }: { value: RobloxDraft; onChange: (d: RobloxDraft) => void; tone?: 'dark' | 'app'; disabled?: boolean }) {
  const dark = tone === 'dark';
  const input = dark
    ? 'w-full rounded-xl bg-black/35 px-3 py-2 text-[13px] text-white outline-none ring-1 ring-white/14 placeholder:text-white/40 focus:ring-white/30'
    : 'w-full rounded-xl bg-bg2 px-3 py-2 text-[13px] text-text outline-none ring-1 ring-line placeholder:text-faint focus:ring-accent/50';
  const hint = dark ? 'text-white/55' : 'text-faint';
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Where this game's uploads go">
        {MODES.map(([m, label]) => {
          const on = value.mode === m;
          return (
            <button
              key={m}
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange({ ...value, mode: m })}
              className={cx(
                'no-drag rounded-xl px-3 py-1.5 text-[12.5px] ring-1 transition-colors disabled:opacity-50',
                dark ? (on ? 'bg-white/18 text-white ring-white/30' : 'text-white/70 ring-white/12 hover:bg-white/8') : on ? 'bg-accent/15 text-accent2 ring-accent/50' : 'text-dim ring-line hover:bg-white/4',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      {value.mode !== 'default' && (
        <label className="flex items-center gap-2">
          <Users size={14} className={cx('shrink-0', hint)} />
          <input
            className={cx(input, 'no-drag max-w-xs tabular-nums')}
            inputMode="numeric"
            disabled={disabled}
            placeholder={value.mode === 'community' ? 'Community (group) id' : 'Roblox user id'}
            value={value.id}
            onChange={(e) => onChange({ ...value, id: e.target.value.replace(/\D/g, '') })}
          />
        </label>
      )}
      <label className="flex items-center gap-2">
        <KeyRound size={14} className={cx('shrink-0', hint)} />
        <input
          type="password"
          autoComplete="off"
          className={cx(input, 'no-drag max-w-md')}
          disabled={disabled}
          placeholder="This game's own Open Cloud key (optional)"
          value={value.key}
          onChange={(e) => onChange({ ...value, key: e.target.value })}
        />
      </label>
      <div className={cx('text-[11.5px] leading-snug', hint)}>
        {modeHint(value.mode)} {value.key.trim() ? 'The key is kept encrypted on this PC for this game alone.' : 'No key here: the default key from Settings.'} You can change all of it later in Settings.
      </div>
    </div>
  );
}
