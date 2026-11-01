import { useEffect, useState } from 'react';
import { CircleDashed, Plus, Replace } from 'lucide-react';
import { rpc } from '../lib/rpc';
import { DRAFT_DOCKS, addOutcome, draftActions, type DraftDock } from '../lib/workshop-drafts';
import { Button, cx } from './ui';

/**
 * A draft's banner on its page (an effect, an animation): it is only in Shuriken until the user adds it, and
 * the buttons that put it in the game — under its own name, or in place of the game's one it is a new take of.
 */
export function AddToGame({ dock, name, of, inGame, onAdded, className }: { dock: DraftDock; name: string; of?: string; inGame?: (name: string) => boolean; onAdded?: (nameInGame: string) => void; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setSaid(null), [dock, name]);
  const thing = DRAFT_DOCKS[dock].thing;
  const add = async (label: string, params: { name: string; as?: string }) => {
    setBusy(label);
    setSaid(null);
    window.shuriken.journal('draft.add', { dock, name: params.name, as: params.as ?? null });
    try {
      const out = addOutcome(await rpc<{ ok: boolean; text: string; data?: unknown }>(DRAFT_DOCKS[dock].use, params));
      if (out.note) setSaid({ ok: out.ok, text: out.note });
      if (out.ok) onAdded?.(params.as ?? params.name);
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={cx('rounded-xl border border-line bg-bg2 px-3.5 py-3 text-[12.5px] leading-relaxed text-dim', className)}>
      <div className="flex items-start gap-2.5">
        <CircleDashed size={15} className="mt-0.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1">
          A draft to try out: this {thing} is only here in Shuriken, not in your game{of ? ` (a new take of ${of})` : ''}, until you add it.
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {draftActions(dock, { name, of }, inGame).map((a) => (
          <Button key={a.label} size="sm" kind={a.primary ? 'primary' : 'secondary'} icon={a.params.as ? <Replace size={13} /> : <Plus size={13} />} disabled={!!busy} onClick={() => void add(a.label, a.params)} title={a.title}>
            {busy === a.label ? 'Adding…' : a.label}
          </Button>
        ))}
      </div>
      {said && <div className={cx('mt-2 text-[11.5px] leading-snug', said.ok ? 'text-faint' : 'text-bad')}>{said.text}</div>}
    </div>
  );
}
