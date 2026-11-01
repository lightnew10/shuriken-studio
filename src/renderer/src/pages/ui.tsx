import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Image as ImageIcon, LayoutPanelTop, Loader2, MessageSquarePlus, MousePointerClick, PanelsTopLeft, Play, RefreshCw, Square, Type } from 'lucide-react';
import { layoutScreen, UI_DEVICES, walkUi, type UiBox, type UiDevice, type UiFinding, type UiNode, type UiSnapshot } from '@shared/ui-layout';
import type { MockupSummary } from '@shared/ui-mockup';
import { TopBar } from '../components/topbar';
import { Button, Empty, Pill, cx, timeAgo } from '../components/ui';
import { UiCanvas, measureCss, useUiImages } from '../components/ui/ui-canvas';
import { rpc, useRpc } from '../lib/rpc';
import { useCurrentProject } from '../lib/project';
import { CopilotToggle, WithCopilot, setCopilotDraft, setDockContext, useCopilotOpen } from '../containers/copilot-chat';
import { MockupsView, mockupLink } from './ui-mockups';
import { ForgeView } from './forge/forge-view';
import { forgeLink } from '../lib/forge';

const DEVICE_KEY = 'shuriken.ui.device';
const MODE_KEY = 'shuriken.ui.mode';
type UiMode = 'game' | 'mockups' | 'forge';
const loadDevice = (): UiDevice => {
  try {
    const d = localStorage.getItem(DEVICE_KEY);
    return d && d in UI_DEVICES ? (d as UiDevice) : 'phone';
  } catch {
    return 'phone';
  }
};

const fmtUDim2 = (u?: [number, number, number, number]) => (u ? `{${u[0]}, ${u[1]}}, {${u[2]}, ${u[3]}}` : '—');
const r = Math.round;

function classIcon(n: UiNode): ReactNode {
  if (n.cls === 'TextButton' || n.cls === 'ImageButton') return <MousePointerClick size={12} />;
  if (n.cls === 'TextLabel' || n.cls === 'TextBox') return <Type size={12} />;
  if (n.cls === 'ImageLabel') return <ImageIcon size={12} />;
  if (n.cls === 'ScreenGui') return <PanelsTopLeft size={12} />;
  return <Square size={12} />;
}

/**
 * The UI workshop, two views. In the game: the game's screens (ScreenGuis) drawn the way Roblox lays them
 * out on a phone, a tablet, a laptop, a desktop or a TV, over the map's latest picture; every element to
 * inspect, hidden menus to preview, and the audit the UI designer and the critic run (things off the
 * screen, overlapping or tiny buttons, cut-off or low-contrast text), each finding one click from its
 * element. Mockups: designs the UI copilot made in Shuriken (pages/ui-mockups.tsx), not in the game until
 * the user puts one in.
 */
export function UiPage({ selectedId, embedded = false }: { selectedId?: string; embedded?: boolean }) {
  const mockups = useRpc<MockupSummary[]>('ui.mockups', undefined, ['ui.mockups', 'project.changed']);
  const [mode, setModeState] = useState<UiMode>(() => {
    if (mockupLink(selectedId)) return 'mockups';
    if (forgeLink(selectedId)) return 'forge';
    try {
      const m = localStorage.getItem(MODE_KEY);
      return m === 'mockups' || m === 'forge' ? m : 'game';
    } catch {
      return 'game';
    }
  });
  const setMode = (m: UiMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* not remembered */
    }
  };
  // A link to a mockup (the copilot's show button, the dashboard) opens the mockups.
  useEffect(() => {
    if (mockupLink(selectedId)) setModeState('mockups');
    else if (forgeLink(selectedId)) setModeState('forge');
    else if (selectedId) setModeState('game');
  }, [selectedId]);
  const [device, setDeviceState] = useState<UiDevice>(loadDevice);
  const setDevice = (d: UiDevice) => {
    setDeviceState(d);
    try {
      localStorage.setItem(DEVICE_KEY, d);
    } catch {
      /* not remembered */
    }
  };
  const [copilotOpen, setCopilotOpen] = useCopilotOpen('ui');
  const count = mockups.data?.length ?? 0;

  const controls = (
        <div className="no-drag flex items-center gap-2">
          <div className="flex rounded-lg bg-surface2 p-0.5 ring-1 ring-line">
            {(['game', 'mockups', 'forge'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setMode(k)}
                className={cx('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors', mode === k ? 'bg-accent/20 text-accent2' : 'text-dim hover:text-text')}
                title={k === 'game' ? 'The UI in your game, as read from Studio' : k === 'mockups' ? 'Designs the UI copilot made here, not in your game' : 'Art directions, their elements and screen templates: pick a look and make a mockup from it'}
              >
                {k === 'game' ? 'In the game' : k === 'mockups' ? 'Mockups' : 'Forge'}
                {k === 'mockups' && count > 0 && <span className="rounded-full bg-white/8 px-1.5 text-[10.5px] tabular-nums">{count}</span>}
              </button>
            ))}
          </div>
          {mode === 'game' && (
            <div className="flex rounded-lg bg-surface2 p-0.5 ring-1 ring-line">
              {(Object.keys(UI_DEVICES) as UiDevice[]).map((d) => (
                <button key={d} onClick={() => setDevice(d)} className={cx('rounded-md px-2.5 py-1 text-[12px] transition-colors', device === d ? 'bg-accent/20 text-accent2' : 'text-dim hover:text-text')} title={`${UI_DEVICES[d].w}×${UI_DEVICES[d].h} points`}>
                  {UI_DEVICES[d].label}
                </button>
              ))}
            </div>
          )}
        </div>
  );
  // A mockup the Forge made opens in Mockups (the view reads the last one shown when it mounts).
  const openMockup = (name: string) => {
    try {
      localStorage.setItem('shuriken.ui.mockup', JSON.stringify(name));
    } catch {
      /* the newest is shown */
    }
    mockups.reload();
    setMode('mockups');
  };
  const content =
    mode === 'game' ? (
      <GameView selectedId={mockupLink(selectedId) || forgeLink(selectedId) ? undefined : selectedId} device={device} setDevice={setDevice} />
    ) : mode === 'forge' ? (
      <ForgeView link={forgeLink(selectedId)} mockups={mockups.data ?? []} onOpenMockup={openMockup} onAskCopilot={() => setCopilotOpen(true)} />
    ) : (
      <MockupsView selectedId={selectedId} mockups={mockups.data ?? []} onAskCopilot={() => setCopilotOpen(true)} />
    );
  // Expanded on the dashboard: the whole workshop (screens list, selection, devices, mockups) in the container itself.
  if (embedded)
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg">
        <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">{controls}</div>
        {content}
      </div>
    );
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="UI" back>
        {controls}
        <CopilotToggle dock="ui" open={copilotOpen} onChange={setCopilotOpen} />
      </TopBar>
      <WithCopilot dock="ui" open={copilotOpen} onClose={() => setCopilotOpen(false)}>
        {content}
      </WithCopilot>
    </div>
  );
}

/** The game's own UI, as last read from Studio. */
function GameView({ selectedId, device, setDevice }: { selectedId?: string; device: UiDevice; setDevice: (d: UiDevice) => void }) {
  const project = useCurrentProject();
  const snap = useRpc<UiSnapshot | null>('ui.get', undefined, ['ui.changed']);
  const backdrop = useRpc<string | null>('project.thumbnail', undefined, []);
  const [reading, setReading] = useState<'auto' | 'playtest' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Screens drawn in the preview (by default the enabled ones), and hidden elements shown anyway.
  const [screenOn, setScreenOn] = useState<Record<number, boolean>>({});
  const [show, setShow] = useState<Set<number>>(new Set());

  const data = snap.data ?? null;
  const screens = data?.screens ?? [];
  const images = useUiImages(screens);
  const drawn = screens.filter((s) => screenOn[s.id] ?? s.enabled !== false);
  const byPath = useMemo(() => {
    const m = new Map<string, UiNode>();
    const walk = (n: UiNode, path: string) => {
      m.set(path, n);
      n.kids?.forEach((c) => walk(c, `${path}.${c.name}`));
    };
    screens.forEach((s) => walk(s, s.name));
    return m;
  }, [screens]);
  const screenOf = useMemo(() => {
    const m = new Map<number, UiNode>();
    for (const s of screens) for (const n of walkUi(s)) m.set(n.id, s);
    return m;
  }, [screens]);

  // A director link can open a screen by name.
  useEffect(() => {
    if (!selectedId || !screens.length) return;
    const s = screens.find((x) => x.name.toLowerCase() === selectedId.toLowerCase());
    if (s) {
      setScreenOn((o) => ({ ...o, [s.id]: true }));
      setSelected(s.id);
    }
  }, [selectedId, screens]);

  const read = async (source: 'auto' | 'playtest') => {
    setReading(source);
    setError(null);
    window.shuriken.journal('ui.read', { source });
    try {
      await rpc('ui.capture', { source });
      snap.reload();
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': Error: /, ''));
    } finally {
      setReading(null);
    }
  };

  const dev = UI_DEVICES[device];
  const selNode = selected != null ? (screens.flatMap((s) => [...walkUi(s)]).find((n) => n.id === selected) ?? null) : null;
  const selScreen = selNode ? (screenOf.get(selNode.id) ?? null) : null;
  const selBox: UiBox | null = useMemo(() => {
    if (!selNode || !selScreen) return null;
    return layoutScreen(selScreen, dev, { measure: measureCss, show }).find((b) => b.node.id === selNode.id) ?? null;
  }, [selNode, selScreen, dev, show]);
  const selPath = selBox?.path ?? (selNode && selScreen && selNode === selScreen ? selScreen.name : null);
  const findings = data?.findings ?? [];
  const mine = selPath ? findings.filter((f) => f.path === selPath) : [];
  const problems = findings.filter((f) => f.severity === 'problem').length;

  const goFinding = (f: UiFinding) => {
    const n = byPath.get(f.path);
    if (!n) return;
    const s = screenOf.get(n.id);
    if (s) setScreenOn((o) => ({ ...o, [s.id]: true }));
    // Hidden ancestors are shown so the element can be seen.
    const parts = f.path.split('.');
    setShow((cur) => {
      const next = new Set(cur);
      for (let i = 2; i <= parts.length; i++) {
        const a = byPath.get(parts.slice(0, i).join('.'));
        if (a && a.visible === false) next.add(a.id);
      }
      return next;
    });
    // Show it on a device it happens on (this one if it does).
    if (f.devices.length && !f.devices.includes(device)) setDevice(f.devices[0]!);
    setSelected(n.id);
  };

  // The UI copilot takes requests about an element right here (the director's chat is for the rest).
  const ask = () => {
    const id = project.data?.id;
    if (!id || !selPath) return;
    setCopilotDraft(id, 'ui', `In the UI, ${selPath}: `);
    window.shuriken.journal('ui.ask', { path: selPath });
  };
  useEffect(() => setDockContext('ui', selPath ?? undefined, `seen on the ${device} layout`), [selPath, device]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_320px]">
      <aside className="min-h-0 overflow-y-auto border-r border-line px-2 py-3">
        <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Screens</div>
        {!screens.length && <div className="px-2 text-[12px] leading-snug text-faint">{data ? 'No ScreenGuis were found.' : 'Not read from Studio yet.'}</div>}
        {screens.map((s) => {
          const on = screenOn[s.id] ?? s.enabled !== false;
          let count = -1;
          for (const _ of walkUi(s)) count++;
          return (
            <div key={s.id} className={cx('group flex items-center gap-1.5 rounded-lg px-1.5 py-1', selScreen?.id === s.id && 'bg-accent/10')}>
              <button onClick={() => setScreenOn((o) => ({ ...o, [s.id]: !on }))} title={on ? 'Hide in the preview' : 'Show in the preview'} className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-white/5', on ? 'text-accent2' : 'text-faint')}>
                {on ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button onClick={() => setSelected(s.id)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-[12.5px] text-text">{s.name}</div>
                <div className="text-[10.5px] text-faint">
                  {count} element{count === 1 ? '' : 's'}
                  {s.enabled === false ? ' · shown by a script' : ''}
                </div>
              </button>
            </div>
          );
        })}
        {selScreen && (
          <>
            <div className="mt-4 px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">{selScreen.name}</div>
            <Tree node={selScreen} depth={0} selected={selected} show={show} onSelect={setSelected} onToggle={(id) => setShow((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : new Set([...cur, id])))} />
          </>
        )}
      </aside>

      <main className="relative flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12px] text-faint">
          <LayoutPanelTop size={13} className="text-accent2" />
          {data ? (
            <span className="min-w-0 flex-1 truncate">
              Read from {data.source === 'PlayerGui' ? 'a playtest (the player’s PlayerGui)' : 'StarterGui'} · {timeAgo(data.capturedAt)} · {data.count} elements{data.truncated ? ' (more not shown)' : ''} · {dev.label} {dev.w}×{dev.h}
            </span>
          ) : (
            <span className="flex-1">The game’s screens, laid out the way Roblox does on each device.</span>
          )}
          <Button size="sm" kind="ghost" icon={reading === 'playtest' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} disabled={!!reading} onClick={() => void read('playtest')} title="For UI that scripts build when a player joins: a short playtest reads the player's PlayerGui">
            From a playtest
          </Button>
          <Button size="sm" icon={reading === 'auto' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} disabled={!!reading} onClick={() => void read('auto')}>
            {data ? 'Read again' : 'Read from Studio'}
          </Button>
        </div>
        {error && <div className="border-b border-bad/25 bg-bad/8 px-4 py-2 text-[12px] leading-snug text-bad">{error}</div>}
        <div className="relative min-h-0 flex-1">
          {data && drawn.length > 0 ? (
            <UiCanvas screens={drawn} device={dev} show={show} images={images} backdrop={backdrop.data} selected={selected} onSelect={(b) => setSelected(b?.node.id ?? null)} />
          ) : (
            <Empty icon={<LayoutPanelTop size={20} />}>
              {!data
                ? 'Read the game’s UI from Studio to see it here on a phone, a tablet and a desktop. The UI designer’s audits show up here too.'
                : !screens.length
                  ? 'No ScreenGuis in StarterGui. If the game builds its UI with scripts when a player joins, read it from a playtest.'
                  : 'Every screen is switched off: turn one on at the left.'}
            </Empty>
          )}
        </div>
      </main>

      <aside className="min-h-0 overflow-y-auto border-l border-line px-4 py-4">
        {selNode ? (
          <div className="mb-5">
            <div className="flex items-center gap-2 text-faint">
              {classIcon(selNode)}
              <span className="text-[11px] tracking-wide uppercase">{selNode.cls}</span>
            </div>
            <div className="font-display mt-0.5 truncate text-[20px] leading-tight text-text" title={selPath ?? ''}>
              {selNode.name}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-faint" title={selPath ?? ''}>
              {selPath}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selNode.visible === false && <Pill tone="warn">hidden until a script shows it</Pill>}
              {selNode.enabled === false && <Pill tone="warn">disabled until a script enables it</Pill>}
              {mine.length === 0 ? <Pill tone="ok">no findings</Pill> : <Pill tone="bad">{mine.length} finding{mine.length === 1 ? '' : 's'}</Pill>}
            </div>
            <div className="mt-3 space-y-1.5 text-[12px]">
              {selBox && <Row k={`On ${dev.label}`} v={`${r(selBox.x)}, ${r(selBox.y)} · ${r(selBox.w)}×${r(selBox.h)}`} />}
              {selNode.size && <Row k="Size" v={fmtUDim2(selNode.size)} />}
              {selNode.pos && <Row k="Position" v={fmtUDim2(selNode.pos)} />}
              {selNode.anchor && (selNode.anchor[0] || selNode.anchor[1]) ? <Row k="AnchorPoint" v={`${selNode.anchor[0]}, ${selNode.anchor[1]}`} /> : null}
              {selNode.text !== undefined && <Row k="Text" v={selNode.text || '(empty)'} />}
              {selBox && selBox.fontSize > 0 && <Row k="Text size" v={`${r(selBox.fontSize)}${selNode.scaled ? ' (scaled to fit)' : ''} · ${selNode.font ?? ''}`} />}
              {selNode.image && <Row k="Image" v={selNode.image} />}
              {selNode.list && <Row k="Layout" v={`List, ${selNode.list.dir.toLowerCase()}`} />}
              {selNode.grid && <Row k="Layout" v="Grid" />}
              {selNode.aspect && <Row k="Aspect ratio" v={String(selNode.aspect.ratio)} />}
            </div>
            {mine.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {mine.map((f, i) => (
                  <div key={i} className={cx('rounded-lg px-2.5 py-1.5 text-[11.5px] leading-snug', f.severity === 'problem' ? 'bg-bad/10 text-bad' : 'bg-warn/10 text-warn')}>
                    {f.message}
                    {f.devices.length > 0 && f.devices.length < (data?.audited?.length ?? 3) && <span className="opacity-75"> · {f.devices.map((d) => UI_DEVICES[d].label).join(', ')}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selNode.visible === false && (
                <Button size="sm" kind="ghost" icon={show.has(selNode.id) ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((cur) => (cur.has(selNode.id) ? new Set([...cur].filter((x) => x !== selNode.id)) : new Set([...cur, selNode.id])))}>
                  {show.has(selNode.id) ? 'Hide again' : 'Show it here'}
                </Button>
              )}
              <Button size="sm" icon={<MessageSquarePlus size={13} />} onClick={ask} disabled={!selPath}>
                Ask the UI copilot
              </Button>
            </div>
          </div>
        ) : (
          data && <div className="mb-5 text-[12px] leading-relaxed text-faint">Click an element in the preview (or in the list at the left) to see how it is set up and where it lands on each device.</div>
        )}
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
          Audit
          {data && (findings.length ? <span className={cx('rounded-full px-1.5 py-px text-[10px] tracking-normal normal-case', problems ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn')}>{problems ? `${problems} problem${problems === 1 ? '' : 's'}` : `${findings.length} warning${findings.length === 1 ? '' : 's'}`}</span> : null)}
        </div>
        {!data ? (
          <div className="text-[12px] leading-snug text-faint">Runs on phone, tablet and desktop whenever the UI is read.</div>
        ) : !findings.length ? (
          <div className="flex items-center gap-1.5 text-[12px] text-ok">
            <CheckCircle2 size={13} /> Nothing a player would trip over.
          </div>
        ) : (
          <div className="space-y-1">
            {findings.map((f, i) => (
              <button key={i} onClick={() => goFinding(f)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/4">
                <AlertTriangle size={12} className={cx('mt-0.5 shrink-0', f.severity === 'problem' ? 'text-bad' : 'text-warn')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11.5px] text-text">{f.path}</span>
                  <span className="block text-[11px] leading-snug text-dim">{f.message}</span>
                </span>
                <span className="shrink-0 text-right text-[10px] leading-tight text-faint">
                  {f.devices.length >= (data?.audited?.length ?? 3) ? 'All' : f.devices.map((d) => UI_DEVICES[d].label).join(', ')}
                  {f.whenShown && <span className="block text-faint/80">when shown</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-faint">{k}</span>
      <span className="min-w-0 truncate text-right tabular-nums" title={v}>
        {v}
      </span>
    </div>
  );
}

/** A ScreenGui's elements, to pick one (hidden ones too, which can be shown for the preview). */
function Tree({ node, depth, selected, show, onSelect, onToggle }: { node: UiNode; depth: number; selected: number | null; show: Set<number>; onSelect: (id: number) => void; onToggle: (id: number) => void }) {
  if (depth > 8) return null;
  return (
    <>
      {(node.kids ?? []).map((c) => (
        <div key={c.id}>
          <div className={cx('group flex items-center gap-1 rounded-md py-0.5 pr-1', selected === c.id ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4')} style={{ paddingLeft: 6 + depth * 12 }}>
            <button onClick={() => onSelect(c.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <span className={cx('shrink-0', c.visible === false && !show.has(c.id) ? 'text-faint/60' : 'text-accent2/80')}>{classIcon(c)}</span>
              <span className={cx('truncate text-[12px]', c.visible === false && !show.has(c.id) && 'text-faint')}>{c.name}</span>
            </button>
            {c.visible === false && (
              <button onClick={() => onToggle(c.id)} title={show.has(c.id) ? 'Hide again' : 'Hidden until a script shows it: show it in the preview'} className="shrink-0 text-faint hover:text-text">
                {show.has(c.id) ? <Eye size={11} /> : <EyeOff size={11} />}
              </button>
            )}
          </div>
          <Tree node={c} depth={depth + 1} selected={selected} show={show} onSelect={onSelect} onToggle={onToggle} />
        </div>
      ))}
    </>
  );
}
