import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import GridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { Box, Clapperboard, Expand, Flame, GripVertical, LayoutPanelTop, MessagesSquare, Minimize2, Music2, Pause, Play, Plus, RotateCcw, Rows3, Pencil, ShieldCheck, Sparkles, SquareArrowOutUpRight, Store, Workflow, Check, X } from 'lucide-react';
import { TopBar } from '../components/topbar';
import { SceneView } from '../components/scene/scene-view';
import { ChatPanel } from '../containers/chat';
import { PipelinePanel } from '../containers/pipeline';
import { ModelsMini, AudioMini, AnimationMini, UiMini } from '../containers/workshops';
import { EffectsMini } from '../containers/effects-mini';
import { QualityMini } from '../containers/quality';
import { StorefrontMini } from '../containers/storefront-mini';
import { KilnView, useKilnStatus } from './kiln';
import { navigate, type Page } from '../lib/nav';
import { useRpc } from '../lib/rpc';
import { useBusy } from '../lib/project';
import { addContainer, applyChoices, isShown, loadSaved, removeCell, DEFAULT_LAYOUT, type Cell, type Choices, type ContainerId, type Places } from '../lib/dashboard-layout';
import { ShurikenMark } from '../brand/logo';
import { Button, IconButton, cx } from '../components/ui';
import { setCalmDashboard, useCalmDashboard } from '../lib/appearance';
import { UiPage } from './ui';

const ROWS = 20;
const STORE = 'shuriken.dashboard.layout.v1';
/** The user's own choices of which containers show (Edit layout); a container without one follows its default. */
const SHOWN = 'shuriken.dashboard.shown.v1';
/** Where a container was when the user hid it, so showing it again puts it back there. */
const PLACES = 'shuriken.dashboard.places.v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-viewer convenience only */
  }
}

function loadLayout(choices: Choices, places: Places): Layout {
  try {
    return loadSaved(readJson<Cell[] | null>(STORE, null), choices, places);
  } catch {
    return applyChoices(DEFAULT_LAYOUT, choices, places);
  }
}

const META: Record<ContainerId, { title: string; icon: ReactNode; page?: Page; item?: string }> = {
  viewer: { title: 'Studio viewer', icon: <Box size={14} />, page: 'viewer' },
  chat: { title: 'Director', icon: <MessagesSquare size={14} /> },
  pipeline: { title: 'Agents', icon: <Workflow size={14} />, page: 'agents' },
  models: { title: 'Models', icon: <Rows3 size={14} />, page: 'models' },
  audio: { title: 'Audio', icon: <Music2 size={14} />, page: 'audio' },
  animation: { title: 'Animation', icon: <Clapperboard size={14} />, page: 'animation' },
  ui: { title: 'UI', icon: <LayoutPanelTop size={14} />, page: 'ui' },
  effects: { title: 'Effects', icon: <Sparkles size={14} />, page: 'animation', item: 'effects' },
  quality: { title: 'Quality', icon: <ShieldCheck size={14} />, page: 'agents' },
  storefront: { title: 'Storefront', icon: <Store size={14} />, page: 'storefront' },
  kiln: { title: 'Kiln', icon: <Flame size={14} />, page: 'kiln' },
};

/**
 * The dashboard: the Studio viewer, the director chat, the agents and the workshops as containers you
 * can move, resize, hide and show again ("Edit layout"); Kiln (the user's own Kiln, live) is one more
 * the user can turn on there. A container's title opens its full page; the expand button fills the
 * dashboard with it.
 */
export function DashboardPage() {
  const [choices, setChoices] = useState<Choices>(() => readJson(SHOWN, {}));
  const [places, setPlaces] = useState<Places>(() => readJson(PLACES, {}));
  const [layout, setLayout] = useState<Layout>(() => loadLayout(choices, places));
  const [editing, setEditing] = useState(false);
  const [focus, setFocus] = useState<ContainerId | null>(null);
  const { width, containerRef, mounted } = useContainerWidth();
  const [height, setHeight] = useState(800);
  const busy = useBusy();
  const kilnOn = isShown('kiln', choices);
  // The Storefront's container shows while monetization or copy is on (Settings); with both off it gives its room back.
  const prefs = useRpc<{ monetization?: boolean; copy?: boolean }>('app.prefs', undefined, ['storefront.changed']);
  const storeOn = !prefs.data || prefs.data.monetization !== false || prefs.data.copy !== false;
  const effective = useCallback((c: Choices): Choices => (storeOn ? c : { ...c, storefront: false }), [storeOn]);
  // Kiln's container follows the model being built in Kiln right now (else it stays where it is).
  const workspaces = useRpc<Array<{ state: string; kilnProject?: string | null; lastUsed: string }>>(kilnOn ? 'models.workspaces' : null, {}, ['blender.workspaces', 'models.building']);
  const following = useMemo(
    () => [...(workspaces.data ?? [])].filter((w) => w.kilnProject && (w.state === 'working' || w.state === 'starting')).sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))[0]?.kilnProject ?? null,
    [workspaces.data],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Leave a thin strip at the bottom for the version badge.
    const measure = () => setHeight(Math.max(200, el.clientHeight - 14));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [containerRef]);

  // A short window gets tighter gaps, and rows never shorter than a container can use: when they don't all fit,
  // the dashboard scrolls (it used to cut the bottom row off).
  const margin = height < 700 ? 8 : 12;
  const rowHeight = Math.max(22, (height - margin * (ROWS + 1)) / ROWS);
  // An expanded container covers the dashboard as it shows: from its top, with nothing to scroll under it.
  useEffect(() => {
    if (focus && containerRef.current) containerRef.current.scrollTop = 0;
  }, [focus, containerRef]);

  const onLayoutChange = useCallback((l: Layout) => {
    setLayout(l);
    writeJson(
      STORE,
      l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    );
  }, []);

  useEffect(() => {
    setLayout((l) => {
      const next = applyChoices(l, effective(choices), places) as Layout;
      writeJson(
        STORE,
        next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
      );
      return next;
    });
    // Only when the Storefront's switches change; the user's own choices apply through setShown and reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeOn]);

  /** Hide or show a container (Edit layout): its room goes to its neighbours, and comes back with it. */
  const setShown = (id: ContainerId, on: boolean) => {
    const cell = layout.find((c) => c.i === id);
    const nextPlaces: Places = !on && cell ? { ...places, [id]: { x: cell.x, y: cell.y, w: cell.w, h: cell.h } } : places;
    const nextChoices: Choices = { ...choices, [id]: on };
    setChoices(nextChoices);
    setPlaces(nextPlaces);
    writeJson(SHOWN, nextChoices);
    writeJson(PLACES, nextPlaces);
    if (!on && focus === id) setFocus(null);
    onLayoutChange(on ? addContainer(layout, id, nextPlaces) : removeCell(layout, id));
  };

  const reset = () => {
    setChoices({});
    setPlaces({});
    writeJson(SHOWN, {});
    writeJson(PLACES, {});
    onLayoutChange(applyChoices(DEFAULT_LAYOUT, effective({}), {}));
  };

  const body = (id: ContainerId, focused = false): ReactNode => {
    switch (id) {
      case 'kiln':
        // Kiln's own view lies over the container: it steps aside while the layout is edited or another container is expanded.
        return focused ? <KilnView project={following} /> : <KilnView project={following} active={focus !== 'kiln'} hide={editing || focus !== null} compact />;
      case 'viewer':
        return <SceneView compact={false} thumbnail />;
      case 'chat':
        return <ChatPanel />;
      case 'pipeline':
        return <PipelinePanel />;
      case 'models':
        return <ModelsMini />;
      case 'audio':
        return <AudioMini />;
      case 'animation':
        return <AnimationMini />;
      case 'ui':
        // Expanded: the whole UI workshop, so the game's screens can be browsed, selected and checked per device.
        return focused ? <UiPage embedded /> : <UiMini />;
      case 'effects':
        return <EffectsMini expanded={focused} />;
      case 'quality':
        return <QualityMini expanded={focused} />;
      case 'storefront':
        return <StorefrontMini expanded={focused} />;
    }
  };

  const items = useMemo(() => layout.filter((l) => l.i in META), [layout]);
  const hidden = (Object.keys(META) as ContainerId[]).filter((id) => !items.some((l) => l.i === id) && (id !== 'storefront' || storeOn));

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar>
        {editing ? (
          <div className="no-drag flex min-w-0 items-center gap-1.5">
            {hidden.map((id) => (
              <Button key={id} size="sm" kind="ghost" icon={<Plus size={13} />} onClick={() => setShown(id, true)} title={`Show the ${META[id].title} container again`}>
                {META[id].title}
              </Button>
            ))}
            {hidden.length > 0 && <div className="mx-1 h-4 w-px bg-line2" />}
            <Button size="sm" kind="ghost" icon={<RotateCcw size={13} />} onClick={reset} title="Back to the default containers and layout">
              Reset
            </Button>
            <Button size="sm" kind="primary" icon={<Check size={13} />} onClick={() => setEditing(false)}>
              Done
            </Button>
          </div>
        ) : (
          <div className="no-drag flex items-center gap-1">
            <CalmSwitch />
            <IconButton title="Edit layout: move, resize, hide or add containers" onClick={() => setEditing(true)}>
              <Pencil size={15} />
            </IconButton>
          </div>
        )}
      </TopBar>
      <div ref={containerRef} data-scroll-clip className={cx('relative min-h-0 flex-1 overflow-x-hidden', focus ? 'overflow-y-hidden' : 'overflow-y-auto')}>
        {mounted && (
          <GridLayout
            width={width}
            layout={items}
            gridConfig={{ cols: 12, rowHeight, margin: [margin, margin], containerPadding: [margin, margin], maxRows: ROWS }}
            dragConfig={{ enabled: editing, handle: '.drag-handle', cancel: '.no-drag-cell', bounded: true, threshold: 3 }}
            resizeConfig={{ enabled: editing, handles: ['se', 'e', 's'] }}
            onLayoutChange={onLayoutChange}
          >
            {items.map((l) => {
              const id = l.i as ContainerId;
              return (
                <div key={id}>
                  <Frame id={id} editing={editing} busy={busy && (id === 'pipeline' || id === 'chat')} onFocus={() => setFocus(id)} onHide={() => setShown(id, false)}>
                    {body(id)}
                  </Frame>
                </div>
              );
            })}
          </GridLayout>
        )}
        <AnimatePresence>
          {focus && (
            <motion.div
              className="absolute inset-3 z-30"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <Frame id={focus} editing={false} busy={busy} focused onFocus={() => setFocus(null)}>
                {body(focus, true)}
              </Frame>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Frame({ id, editing, busy, focused, onFocus, onHide, children }: { id: ContainerId; editing: boolean; busy: boolean; focused?: boolean; onFocus: () => void; onHide?: () => void; children: ReactNode }) {
  const meta = META[id];
  return (
    <div className={cx('card flex h-full flex-col overflow-hidden transition-shadow', editing && 'ring-1 ring-accent/30')}>
      <div className={cx('flex h-10 shrink-0 items-center gap-2 border-b border-line px-3', editing && 'drag-handle cursor-move')}>
        {editing && <GripVertical size={14} className="text-faint" />}
        <span className="text-faint">{meta.icon}</span>
        <button
          disabled={!meta.page || editing}
          onClick={() => meta.page && navigate(meta.page, meta.item)}
          className={cx('text-[12.5px] font-semibold tracking-wide text-text', meta.page && !editing && 'hover:text-accent2')}
          title={meta.page ? `Open ${meta.title}` : undefined}
        >
          {meta.title}
        </button>
        {busy && <ShurikenMark size={14} active />}
        <div className="flex-1" />
        {id === 'kiln' && !editing && <KilnUndock />}
        {editing && onHide && (
          <IconButton title={`Hide the ${meta.title} container (Edit layout brings it back)`} onClick={onHide} className="no-drag-cell h-7 w-7">
            <X size={14} />
          </IconButton>
        )}
        {!editing && (
          <IconButton title={focused ? 'Back to dashboard' : 'Expand'} onClick={onFocus} className="h-7 w-7">
            {focused ? <Minimize2 size={14} /> : <Expand size={14} />}
          </IconButton>
        )}
      </div>
      <div className={cx('relative min-h-0 flex-1', editing && 'pointer-events-none opacity-80')}>{children}</div>
    </div>
  );
}

/** Moves Kiln into its own window (another monitor) and back. */
function KilnUndock() {
  const status = useKilnStatus();
  if (status.state !== 'ready' && status.state !== 'undocked') return null;
  const undocked = status.state === 'undocked';
  return (
    <IconButton title={undocked ? 'Bring Kiln back into this window' : 'Move Kiln into its own window (another monitor, say)'} onClick={() => window.shuriken.kiln.toggleDock()} className="h-7 w-7">
      <SquareArrowOutUpRight size={14} />
    </IconButton>
  );
}

/** Calm dashboard: the previews hold still (the same switch is in Settings, Appearance). */
function CalmSwitch() {
  const calm = useCalmDashboard();
  return (
    <IconButton
      title={calm ? 'The previews hold still. Click to let them play again.' : 'Calm the dashboard: effects, animations and models hold still'}
      onClick={() => {
        setCalmDashboard(!calm);
        window.shuriken.journal('dashboard.calm', { on: !calm });
      }}
    >
      {calm ? <Play size={15} /> : <Pause size={15} />}
    </IconButton>
  );
}
