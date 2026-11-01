import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type { StripState, TabInfo } from '../../../preload/api';
import { ShurikenMark } from '../brand/logo';
import { cx } from './ui';

/** The bar's height (main's STRIP; the window controls are as tall). */
const BAR = 36;

/** Each project window's light: needs your answer, working, paused, idle (a start page has none). */
const LIGHT: Record<TabInfo['state'], string> = {
  input: 'bg-warn shadow-[0_0_0_3px_rgba(245,185,66,0.2),0_0_10px_rgba(245,185,66,0.8)]',
  working: 'animate-pulse bg-accent shadow-[0_0_8px_color-mix(in_srgb,var(--color-accent)_85%,transparent)]',
  paused: 'border-[1.5px] border-dim',
  idle: 'bg-[#5d544c]',
  start: '',
};

type Centers = Window & { __stripCenters?: () => number[] };

/**
 * The bar along the top of an app window, read like an application's title bar: the Projects menu at
 * the far left, then the project windows docked here, each filling the bar's height with its light
 * (needs your answer / working / paused / idle). Click the window in front for its options (another
 * window, its own app window or docked back, close). Drag one along the bar to reorder it, off the
 * bar to pull it out into an app window of its own, onto another app window's bar to dock it there.
 * Middle-click closes. The window's own controls sit at the right.
 */
export function TabStrip() {
  const [s, setS] = useState<StripState>({ tabs: [], main: true, others: 0 });
  const [drag, setDrag] = useState<{ id: number; dx: number; out: boolean } | null>(null);
  const segs = useRef(new Map<number, HTMLDivElement>());

  const centers = (except?: number) =>
    [...segs.current.entries()]
      .filter(([id]) => id !== except)
      .map(([, el]) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      })
      .sort((a, b) => a - b);

  useEffect(() => {
    void window.shuriken.tabs.list().then(setS);
    // Where the windows sit on this bar, for one dragged in from another app window.
    (window as Centers).__stripCenters = () => centers();
    return window.shuriken.tabs.onChanged(setS);
  }, []);

  const offBar = (x: number, y: number) => y < -28 || y > BAR + 28 || x < 0 || x > window.innerWidth;

  const press = (e: ReactPointerEvent<HTMLDivElement>, t: TabInfo) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    const wasFront = t.active;
    if (!wasFront) void window.shuriken.tabs.select(t.id);
    let dragging = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      if (!dragging && Math.hypot(dx, ev.clientY - start.y) < 6) return;
      dragging = true;
      setDrag({ id: t.id, dx, out: offBar(ev.clientX, ev.clientY) });
    };
    const end = (ev: PointerEvent | null) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      setDrag(null);
      if (!ev) return;
      if (!dragging) {
        // A click on the window in front: its options.
        if (wasFront) window.shuriken.tabs.menu({ kind: 'window', x: el.getBoundingClientRect().left });
        return;
      }
      if (offBar(ev.clientX, ev.clientY)) void window.shuriken.tabs.drop(t.id, ev.clientX, ev.clientY);
      else void window.shuriken.tabs.move(t.id, centers(t.id).filter((c) => c < ev.clientX).length);
    };
    const up = (ev: PointerEvent) => end(ev);
    const cancel = () => end(null);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  };

  return (
    <div
      className="drag flex h-[36px] items-stretch overflow-hidden bg-strip pr-[150px] select-none"
      // A press anywhere else on the bar closes a menu open below it.
      onPointerDown={(e) => !(e.target as HTMLElement).closest('[data-menu-trigger]') && window.shuriken.tabs.menu({ kind: 'none' })}
    >
      <button
        data-menu-trigger=""
        onClick={() => window.shuriken.tabs.menu({ kind: 'projects' })}
        title="Projects: open one, open blank, start a new game"
        className="no-drag flex shrink-0 items-center gap-2 border-r border-[#1d1916] pr-3 pl-3.5 text-[12.5px] font-medium text-dim transition-colors hover:bg-white/[0.04] hover:text-text"
      >
        <ShurikenMark size={17} active={s.tabs.some((t) => t.state === 'working')} />
        Projects
        <ChevronDown size={13} className="opacity-60" />
      </button>
      {s.tabs.map((t) => {
        const dragged = drag?.id === t.id ? drag : null;
        return (
          <div
            key={t.id}
            ref={(el) => {
              if (el) segs.current.set(t.id, el);
              else segs.current.delete(t.id);
            }}
            data-seg=""
            data-state={t.state}
            data-menu-trigger={t.active ? '' : undefined}
            role="tab"
            aria-selected={t.active}
            title={`${t.title} — ${t.detail}${t.active ? ' · click for options' : ''}`}
            onPointerDown={(e) => press(e, t)}
            onAuxClick={(e) => e.button === 1 && void window.shuriken.tabs.close(t.id)}
            style={dragged ? { transform: `translateX(${dragged.dx}px)`, zIndex: 10 } : undefined}
            className={cx(
              'no-drag relative flex max-w-[240px] min-w-[88px] flex-1 cursor-default items-center gap-2.5 border-r border-[#1d1916] px-3.5 text-[12.5px] transition-colors',
              t.active ? 'bg-bg text-text' : 'text-faint hover:bg-white/[0.035] hover:text-dim',
              dragged && 'bg-surface2 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]',
              dragged?.out && 'opacity-70',
            )}
          >
            {t.active && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
            {t.state !== 'start' && <span className={cx('h-[7px] w-[7px] shrink-0 rounded-full', LIGHT[t.state])} />}
            <span className="min-w-0 flex-1 truncate">{dragged?.out ? (s.tabs.length > 1 ? 'Let go: its own window' : 'Let go on a bar to dock') : t.title}</span>
            {t.active && <ChevronDown size={12} className="shrink-0 opacity-45" />}
          </div>
        );
      })}
    </div>
  );
}
