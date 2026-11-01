import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AppWindow, ArrowDownToLine, SquareArrowOutUpRight, X } from 'lucide-react';
import type { StripMenu } from '../../../preload/api';
import { ProjectsPanel } from './projects-menu';
import { useOverlay } from '../lib/overlays';

/**
 * The bar's menus, shown in the page of the project window in front right under the bar (the bar's
 * own page is only as tall as the bar): the Projects menu, and the options of the window in front.
 * The bar opens, toggles and closes them; a click elsewhere in the page or Escape closes them too.
 */
export function StripMenus() {
  const [menu, setMenu] = useState<StripMenu | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(!!menu);
  useEffect(() => window.shuriken.tabs.onMenu((m) => setMenu((cur) => (m.kind === 'none' || cur?.kind === m.kind ? null : m))), []);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  const close = () => setMenu(null);
  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          ref={ref}
          key={menu.kind}
          data-strip-menu={menu.kind}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          // no-drag: the page's own top bar under it is a window-drag region.
          className="no-drag fixed top-1.5 z-[200] origin-top-left"
          style={{ left: menu.kind === 'projects' ? 8 : Math.max(8, Math.min(menu.x, window.innerWidth - 268)) }}
        >
          {menu.kind === 'projects' ? <ProjectsPanel onClose={close} /> : <WindowMenu m={menu} onClose={close} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const item = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-text transition-colors hover:bg-white/5';
const key = 'text-[11px] text-faint';

/** The window in front's options: another window, pull it out or dock it back, close it. */
function WindowMenu({ m, onClose }: { m: StripMenu; onClose: () => void }) {
  const run = (fn: () => unknown) => {
    onClose();
    void fn();
  };
  return (
    <div className="card w-[260px] p-1.5">
      <div className="truncate px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">{m.title}</div>
      <button className={item} onClick={() => run(() => window.shuriken.tabs.create())}>
        <AppWindow size={14} className="text-dim" />
        <span className="flex-1">Open another window</span>
        <span className={key}>Ctrl+T</span>
      </button>
      {m.canDetach && (
        <button className={item} onClick={() => run(() => window.shuriken.tabs.detach(m.id))} title="Or drag it off the bar">
          <SquareArrowOutUpRight size={14} className="text-dim" />
          <span className="flex-1">Move to its own window</span>
        </button>
      )}
      {m.canDock && (
        <button className={item} onClick={() => run(() => window.shuriken.tabs.dock(m.id))} title="Or drag it onto another window's bar">
          <ArrowDownToLine size={14} className="text-dim" />
          <span className="flex-1">{m.main ? 'Dock into the other window' : 'Dock into the main window'}</span>
        </button>
      )}
      <div className="mx-1 my-1 h-px bg-line" />
      <button className={item} onClick={() => run(() => window.shuriken.tabs.close(m.id))}>
        <X size={14} className="text-dim" />
        <span className="flex-1">Close window</span>
        <span className={key}>Ctrl+W</span>
      </button>
    </div>
  );
}
