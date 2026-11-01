import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CHANGELOG } from '../lib/changelog';
import { Modal, cx } from './ui';

/** A quiet version label in the bottom-left corner; clicking it shows what changed recently. */
export function VersionBadge() {
  const [open, setOpen] = useState(false);
  // After an update, show what changed once (remembered per PC; never blocks the app if storage fails).
  useEffect(() => {
    if (new URLSearchParams(location.search).has('smoke')) return;
    try {
      const seen = localStorage.getItem('shuriken.changelog.seen');
      // Also after upgrading from a version before this existed (the app has stored things before).
      if (seen ? seen !== __APP_VERSION__ : localStorage.length > 0) setOpen(true);
      localStorage.setItem('shuriken.changelog.seen', __APP_VERSION__);
    } catch {
      /* ignore */
    }
  }, []);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          window.shuriken.journal('changelog.open', {});
        }}
        title="What's new"
        className="no-drag fixed bottom-2 left-2 z-50 rounded-md bg-black/40 px-1.5 py-0.5 font-mono text-[10.5px] tracking-wide text-white/60 ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white"
      >
        v{__APP_VERSION__}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="What's new" width={620}>
        <Changelog />
      </Modal>
    </>
  );
}

/** One line per version (its headline); a version opens to its details. The newest is open. */
function Changelog() {
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(CHANGELOG.slice(0, 1).map((e) => e.version)));
  const toggle = (v: string) =>
    setOpened((s) => {
      const next = new Set(s);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  return (
    <div className="max-h-[62vh] overflow-y-auto pr-1">
      {CHANGELOG.map((e, i) => {
        const isOpen = opened.has(e.version);
        return (
          <section key={e.version} className="border-b border-line/70 last:border-b-0">
            <button onClick={() => toggle(e.version)} aria-expanded={isOpen} className="group flex w-full items-start gap-2 py-2.5 text-left">
              <ChevronRight size={14} className={cx('mt-[3px] shrink-0 text-faint transition-transform group-hover:text-dim', isOpen && 'rotate-90')} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[14px] font-semibold text-text">{e.version}</span>
                  {i === 0 && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] font-semibold text-accent2 ring-1 ring-accent/30">Latest</span>}
                  <span className="text-[11.5px] text-faint">{e.date}</span>
                </span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-dim">{e.headline}</span>
              </span>
            </button>
            {isOpen && (
              <ul className="space-y-1.5 pb-3 pl-6">
                {e.changes.map((c) => (
                  <li key={c} className="flex gap-2 text-[12.5px] leading-relaxed text-text/85">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent/70" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
