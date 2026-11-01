import { useEffect, useRef, useState } from 'react';
import { Flame, Loader2, RotateCw, SquareArrowOutUpRight } from 'lucide-react';
import type { KilnStatus } from '../../../preload/api';
import { TopBar } from '../components/topbar';
import { Button, cx } from '../components/ui';
import { useOverlaysOpen } from '../lib/overlays';

/** Kiln's dock state in this project window (connecting, ready, unavailable, undocked). */
export function useKilnStatus(): KilnStatus {
  const [status, setStatus] = useState<KilnStatus>({ state: 'connecting' });
  useEffect(() => window.shuriken.kiln.onStatus(setStatus), []);
  return status;
}

/** The view on screen now: one area at a time holds Kiln (the Kiln page, the dashboard's Kiln container, or its expanded copy). */
let owner = 0;
let nextArea = 1;

/**
 * An area Kiln's own view is laid over (main/kiln-dock.ts puts the native view on the rect this reports):
 * the Kiln page and the dashboard's Kiln container. Only the `active` area reports; `hide` (and any open
 * menu or dialog of Shuriken's) makes the view step aside, showing what is under it instead.
 */
export function KilnView({ project, active = true, hide = false, compact = false }: { project?: string | null; active?: boolean; hide?: boolean; compact?: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const id = useRef(0);
  if (!id.current) id.current = nextArea++;
  const overlays = useOverlaysOpen();
  const status = useKilnStatus();
  const [retry, setRetry] = useState(0);
  const covered = overlays || hide;

  // Tell main where the view goes (again after entrance animations and grid moves settle).
  useEffect(() => {
    const el = area.current;
    if (!active || !el) return;
    owner = id.current;
    const report = () => {
      if (owner !== id.current) return;
      const r = el.getBoundingClientRect();
      // On a dashboard that scrolls, the view is the part of the area still inside it (the view isn't clipped by the page).
      const clip = el.closest('[data-scroll-clip]')?.getBoundingClientRect();
      const top = clip ? Math.max(r.top, clip.top) : r.top;
      const bottom = clip ? Math.min(r.bottom, clip.bottom) : r.bottom;
      window.shuriken.kiln.page({ shown: true, covered, project: project ?? null, rect: { x: r.left, y: top, width: r.width, height: Math.max(0, bottom - top) } });
    };
    report();
    const timers = [250, 600].map((ms) => setTimeout(report, ms));
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    // A scrolling ancestor (the dashboard) moves the area without resizing it.
    window.addEventListener('scroll', report, true);
    return () => {
      for (const t of timers) clearTimeout(t);
      ro.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
    };
  }, [active, covered, project, retry]);
  // Stepping down (unmounted, or another area took over): the view goes out of sight unless another area holds it.
  useEffect(() => {
    if (!active) return;
    const me = id.current;
    return () => {
      if (owner !== me) return;
      owner = 0;
      window.shuriken.kiln.page({ shown: false });
    };
  }, [active]);

  const undocked = status.state === 'undocked';
  const behind = status.state === 'ready' && !covered && active;
  return (
    <div ref={area} className="relative h-full min-h-0 w-full">
      {/* What shows through when the view isn't over it: starting, not found, undocked, or stepped aside. */}
      <div className={cx('absolute inset-0 flex flex-col items-center justify-center gap-3 text-center', compact ? 'px-4' : 'px-8', behind && 'pointer-events-none')}>
        {status.state === 'connecting' && (
          <>
            <Loader2 size={20} className="animate-spin text-accent2" />
            <div className="text-[13px] text-dim">Connecting to Kiln…</div>
          </>
        )}
        {status.state === 'unavailable' && (
          <>
            <Flame size={22} className="text-faint" />
            <div className={cx('leading-relaxed text-dim', compact ? 'max-w-xs text-[12px]' : 'max-w-md text-[13px]')}>{status.detail ?? "Kiln isn't available."}</div>
            <Button size="sm" kind="ghost" icon={<RotateCw size={13} />} onClick={() => setRetry((n) => n + 1)}>
              Try again
            </Button>
          </>
        )}
        {undocked && (
          <>
            <SquareArrowOutUpRight size={20} className="text-faint" />
            <div className="text-[13px] text-dim">Kiln is in its own window.</div>
            <Button size="sm" onClick={() => window.shuriken.kiln.toggleDock()}>
              Dock back
            </Button>
          </>
        )}
        {status.state === 'ready' && (covered || !active) && (
          <>
            <Flame size={22} className="text-accent2" />
            <div className="text-[12.5px] text-dim">Kiln</div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Kiln docked in Shuriken: the page keeps an area free below the top bar and main lays Shuriken's
 * own view onto the user's running Kiln over it (main/kiln-dock.ts). The view steps aside while a
 * menu or dialog of Shuriken's is open, and can be pulled out into its own window and docked back.
 */
export function KilnPage({ project }: { project?: string }) {
  const status = useKilnStatus();
  const undocked = status.state === 'undocked';
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Kiln" back>
        {(status.state === 'ready' || undocked) && (
          <Button size="sm" kind="ghost" icon={<SquareArrowOutUpRight size={13} />} onClick={() => window.shuriken.kiln.toggleDock()} title={undocked ? 'Bring Kiln back into this window' : 'Move Kiln into its own window (another monitor, say); it keeps its place'}>
            {undocked ? 'Dock back' : 'Undock'}
          </Button>
        )}
      </TopBar>
      <div className="relative min-h-0 flex-1">
        <KilnView project={project ?? null} />
      </div>
    </div>
  );
}

/** The slim bar of Kiln's own window (undocked): which project, and Dock back. */
export function KilnWindowHeader() {
  const name = new URLSearchParams(location.search).get('name') ?? '';
  return (
    <div className="drag flex h-10 items-center gap-2 border-b border-line bg-bg2 px-3 text-[12.5px]">
      <Flame size={14} className="text-accent2" />
      <span className="font-semibold text-text">Kiln</span>
      {name && <span className="truncate text-faint">· {name}</span>}
      <div className="flex-1" />
      <div className="no-drag">
        <Button size="sm" kind="ghost" onClick={() => window.shuriken.kiln.toggleDock()} title="Back into its Shuriken window">
          Dock back
        </Button>
      </div>
    </div>
  );
}
