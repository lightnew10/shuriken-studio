import { useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, AlertTriangle, Check, CheckCircle2, Gamepad2, LayoutPanelTop, Loader2, MessageSquarePlus, Minimize2, Play, Sparkles, Wand2 } from 'lucide-react';
import { UI_DEVICES, type UiDevice, type UiNode } from '@shared/ui-layout';
import { auditVersion, MOCK_DEVICES, motionOf, PREVIEWED_MOTION, versionLabel, type MockColor, type Mockup, type MockupSummary, type MockVersion } from '@shared/ui-mockup';
import { Button, Empty, Pill, cx, timeAgo } from '../components/ui';
import { useUiImages } from '../components/ui/ui-canvas';
import { FORM_LABEL, MockupBoard, useResolved } from '../components/ui/mockup-board';
import { useWornSkins } from '../components/ui/worn-skins';
import { applyMessage, NOT_PREVIEWED } from '../lib/mockup-board';
import { rpc, useRpc } from '../lib/rpc';
import { useCurrentProject } from '../lib/project';
import { setCopilotDraft, setDockContext } from '../containers/copilot-chat';

const DEVICES_KEY = 'shuriken.ui.mockupDevices';
const LAST_KEY = 'shuriken.ui.mockup';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* a per-viewer convenience */
  }
}

/** "mockup:<name>" or "mockup:<name>@<version>" from a link (a copilot's show button, the dashboard). */
export function mockupLink(item: string | undefined): { name: string; version: string | null } | null {
  const m = /^mockup:([a-z0-9][a-z0-9-]*)(?:@([A-Z]{1,2}))?$/.exec(item ?? '');
  return m ? { name: m[1]!, version: m[2] ?? null } : null;
}

const hex = (c: MockColor | undefined): string => (Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : typeof c === 'string' && c.startsWith('#') ? c : '#888');

/** Who made a version, in words. */
const maker = (by?: string): string => (!by ? '' : by === 'copilot-ui' ? 'the UI copilot' : by === 'ui-engineer' ? 'the UI designer agent' : by === 'user' ? 'you' : by.replace(/-/g, ' '));

/**
 * The UI page's mockups: designs the UI copilot made in Shuriken, not in the game. A mockup's versions (A,
 * B, C…) as tabs, each shown side by side on a phone both ways up, a tablet, a desktop and a TV with its
 * own layout per form and its motion played; the audit per device; pick one, or put it in the game (the
 * copilot builds it for real).
 */
export function MockupsView({ selectedId, mockups, onAskCopilot }: { selectedId?: string; mockups: MockupSummary[]; onAskCopilot: () => void }) {
  const project = useCurrentProject();
  const link = mockupLink(selectedId);
  const [name, setName] = useState<string | null>(() => link?.name ?? readJson<string | null>(LAST_KEY, null));
  const [versionId, setVersionId] = useState<string | null>(link?.version ?? null);
  useEffect(() => {
    if (!link) return;
    setName(link.name);
    setVersionId(link.version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  const current = name && mockups.some((m) => m.name === name) ? name : (mockups[0]?.name ?? null);
  const full = useRpc<Mockup | null>(current ? 'ui.mockup' : null, { name: current }, ['ui.mockups'], [current]);
  const m = full.data && full.data.name === current ? full.data : null;
  // The version on show: the one clicked, else the newest that isn't retired (what the copilot just made).
  const v: MockVersion | undefined = m ? (m.versions.find((x) => x.id === versionId) ?? [...m.versions].reverse().find((x) => !x.retired) ?? m.versions[m.versions.length - 1]) : undefined;
  const [showRetired, setShowRetired] = useState(false);
  const retiredCount = m ? m.versions.filter((x) => x.retired).length : 0;
  const motion = useMemo(() => (v ? motionOf(v) : []), [v]);

  const [devices, setDevicesState] = useState<UiDevice[]>(() => readJson<UiDevice[]>(DEVICES_KEY, MOCK_DEVICES).filter((d) => MOCK_DEVICES.includes(d)));
  const setDevices = (d: UiDevice[]) => {
    const next = MOCK_DEVICES.filter((x) => d.includes(x));
    setDevicesState(next.length ? next : ['phone']);
    writeJson(DEVICES_KEY, next.length ? next : ['phone']);
  };
  const [focus, setFocus] = useState<UiDevice | null>(null);
  const [selected, setSelected] = useState<{ path: string; device: UiDevice } | null>(null);
  const [play, setPlay] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [sending, setSending] = useState(false);

  const choose = (n: string) => {
    setName(n);
    setVersionId(null);
    setSelected(null);
    setFocus(null);
    writeJson(LAST_KEY, n);
  };

  // Forged skins worn as in the game (the art 9-sliced on the canvases), once the core has them.
  const worn = useWornSkins(m?.name, v);
  const resolved = useResolved(v, MOCK_DEVICES, worn.screens);
  const audit = useMemo(() => (v ? auditVersion(v) : { findings: [], devices: [] }), [v]);
  const allScreens = useMemo(() => Object.values(resolved).flatMap((r) => (r?.screens ?? []) as UiNode[]), [resolved]);
  const gameImages = useUiImages(allScreens);
  const images = useMemo(() => ({ ...gameImages, ...worn.images }), [gameImages, worn.images]);
  const backdrop = useRpc<string | null>('project.thumbnail', undefined, []);

  // The copilot hears what the user is looking at: this mockup and version (and an element, when one is picked).
  useEffect(() => {
    if (!m || !v) return setDockContext('ui', undefined);
    setDockContext('ui', `mockup:${m.name}@${v.id}`, `the "${m.title}" mockup, version ${v.id}${v.label ? ` (${v.label})` : ''}${selected ? `; element ${selected.path} selected on the ${UI_DEVICES[selected.device].label.toLowerCase()}` : ''}${focus ? `; showing the ${UI_DEVICES[focus].label.toLowerCase()} only` : ''}`);
  }, [m, v, selected, focus]);

  const putInGame = async () => {
    if (!m || !v || sending) return;
    setSending(true);
    onAskCopilot();
    window.shuriken.journal('ui.mockup.apply', { name: m.name, version: v.id });
    try {
      await rpc('chat.send', { channel: 'copilot:ui', text: applyMessage(m.title, v.id), context: { page: 'ui', item: `mockup:${m.name}@${v.id}` } });
    } finally {
      setSending(false);
    }
  };
  const retire = async (on: boolean) => {
    if (!m || !v) return;
    await rpc('ui.mockup.retire', { name: m.name, versions: [v.id], retired: on });
    if (on) setVersionId(null);
    full.reload();
  };
  const pick = async () => {
    if (!m || !v) return;
    await rpc('ui.mockup.choose', { name: m.name, version: m.chosen === v.id ? null : v.id });
    full.reload();
  };
  const ask = () => {
    const id = project.data?.id;
    if (!id || !m || !v) return;
    setCopilotDraft(id, 'ui', selected ? `In the "${m.title}" mockup, version ${v.id}, ${selected.path}: ` : `In the "${m.title}" mockup, version ${v.id}: `);
  };

  if (!mockups.length) {
    return (
      <Empty icon={<Wand2 size={20} />}>
        <div className="text-[13px] text-dim">No mockups yet.</div>
        <div className="mt-1">
          Ask the UI copilot for a design (“show me three shop layouts for phones”): it makes mockups here, laid out the way Roblox would on a phone, a tablet, a desktop and a TV. Nothing goes into your game until you say “put it in the game”.
        </div>
        <Button className="mt-3" size="sm" icon={<Sparkles size={13} />} onClick={onAskCopilot}>
          Talk to the UI copilot
        </Button>
      </Empty>
    );
  }

  const skipped = motion.filter((x) => !PREVIEWED_MOTION.has(x.play));
  const selBox = selected ? resolved[selected.device]?.boxes.find((b) => b.path === selected.path) : undefined;
  const selFindings = selected ? audit.findings.filter((f) => f.path === selected.path) : [];
  const problems = audit.findings.filter((f) => f.severity === 'problem').length;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-line px-2 py-3">
        <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Mockups</div>
        {mockups.map((s) => (
          <button key={s.name} onClick={() => choose(s.name)} className={cx('flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left', s.name === current ? 'bg-accent/10' : 'hover:bg-white/4')}>
            <span className="flex w-full items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">{s.title}</span>
              {s.applied && <Gamepad2 size={12} className="shrink-0 text-ok" />}
            </span>
            <span className="text-[10.5px] text-faint">
              {s.versions.length} version{s.versions.length === 1 ? '' : 's'}
              {s.chosen ? ` · ${s.chosen} picked` : ''}
              {s.applied ? ` · ${s.applied.version} in the game` : ''} · {timeAgo(s.updatedAt)}
            </span>
          </button>
        ))}
        {v && m && (
          <div className="mt-4 px-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
              Version {versionLabel(v)}
              {m.chosen === v.id && <Pill tone="accent">picked</Pill>}
              {m.applied?.version === v.id && <Pill tone="ok">in the game</Pill>}
              {v.retired && <Pill>retired</Pill>}
            </div>
            {v.label && <div className="mt-1 text-[13px] text-text">{v.label}</div>}
            <div className="mt-0.5 text-[12px] leading-snug text-dim">{v.note}</div>
            <div className="mt-1 text-[10.5px] text-faint">
              {[v.from ? (v.from.startsWith('game') ? 'from the game’s UI' : `from ${v.from}`) : null, maker(v.by) ? `by ${maker(v.by)}` : null, timeAgo(v.createdAt), v.rev && v.rev > 1 && v.revisedAt ? `fixed ${timeAgo(v.revisedAt)} (revision ${v.rev})` : null].filter(Boolean).join(' · ')}
            </div>
            {v.theme && Object.keys(v.theme).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(v.theme).map(([k, c]) => (
                  <span key={k} title={`$${k}`} className="flex items-center gap-1 rounded-md bg-white/4 px-1.5 py-0.5 text-[10px] text-faint">
                    <span className="h-2.5 w-2.5 rounded-sm ring-1 ring-white/15" style={{ background: hex(c) }} />
                    {k}
                  </span>
                ))}
              </div>
            )}
            {motion.length > 0 && (
              <>
                <div className="mt-4 pb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Motion</div>
                {motion.map((x, i) => (
                  <div key={i} className="flex items-start gap-1.5 py-0.5 text-[11.5px] leading-snug">
                    <span className={cx('mt-0.5 shrink-0', PREVIEWED_MOTION.has(x.play) ? 'text-accent2' : 'text-faint')}>{PREVIEWED_MOTION.has(x.play) ? <Play size={10} /> : <Gamepad2 size={10} />}</span>
                    <span className="min-w-0">
                      <span className="text-text">{x.play}</span>
                      {typeof x.from === 'string' ? ` from ${x.from}` : ''} <span className="text-faint">{x.target ?? 'the screen'}</span>
                      {x.when && x.when !== 'open' ? <span className="text-faint"> · {x.when}</span> : null}
                      {!PREVIEWED_MOTION.has(x.play) && <span className="block text-[10.5px] text-faint">plays in the game only</span>}
                    </span>
                  </div>
                ))}
              </>
            )}
            <div className="mt-4 flex items-center gap-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
              Checks
              {audit.findings.length ? <span className={cx('rounded-full px-1.5 py-px text-[10px] tracking-normal normal-case', problems ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn')}>{problems ? `${problems} problem${problems === 1 ? '' : 's'}` : `${audit.findings.length} warning${audit.findings.length === 1 ? '' : 's'}`}</span> : null}
            </div>
            {!audit.findings.length ? (
              <div className="flex items-center gap-1.5 text-[12px] text-ok">
                <CheckCircle2 size={13} /> Fits every device.
              </div>
            ) : (
              <div className="-mx-2 space-y-0.5">
                {audit.findings.slice(0, 30).map((f, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const d = f.devices[0] ?? 'phone';
                      setFocus(f.devices.length ? d : null);
                      setSelected({ path: f.path, device: d });
                    }}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left hover:bg-white/4"
                  >
                    <AlertTriangle size={11} className={cx('mt-0.5 shrink-0', f.severity === 'problem' ? 'text-bad' : 'text-warn')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-text">{f.path}</span>
                      <span className="block text-[10.5px] leading-snug text-dim">{f.message}</span>
                      {f.devices.length > 0 && <span className="block text-[10px] text-faint">{f.devices.map((d) => UI_DEVICES[d].label).join(', ')}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      <main className="relative flex min-h-0 flex-col">
        {m && v ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
              <div className="min-w-0">
                <div className="font-display truncate text-[17px] leading-tight text-text">{m.title}</div>
                {m.brief && <div className="max-w-[46ch] truncate text-[11.5px] text-faint" title={m.brief}>{m.brief}</div>}
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {m.versions
                  .filter((x) => showRetired || !x.retired || x.id === v.id)
                  .map((x) => (
                  <button
                    key={x.id}
                    onClick={() => {
                      setVersionId(x.id);
                      setSelected(null);
                    }}
                    title={`${x.label ? `${x.label}: ` : ''}${x.note}`}
                    className={cx('flex max-w-[160px] items-center gap-1 rounded-lg px-2 py-1 text-[12px] ring-1 transition-colors', x.id === v.id ? 'bg-accent/15 text-text ring-accent/40' : 'text-dim ring-line hover:text-text', x.retired && 'opacity-60')}
                  >
                    <span className="font-semibold">{versionLabel(x)}</span>
                    {x.label && <span className="truncate">{x.label}</span>}
                    {m.chosen === x.id && <Check size={11} className="shrink-0 text-accent2" />}
                    {m.applied?.version === x.id && <Gamepad2 size={11} className="shrink-0 text-ok" />}
                  </button>
                ))}
                {retiredCount > 0 && (
                  <button onClick={() => setShowRetired((s) => !s)} className="rounded-lg px-2 py-1 text-[11px] text-faint hover:text-text" title="Versions moved out of the way (kept)">
                    {showRetired ? 'Hide retired' : `${retiredCount} retired`}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {v.retired ? (
                  <Button size="sm" kind="ghost" icon={<ArchiveRestore size={13} />} onClick={() => void retire(false)} title="Show this version with the others again">
                    Restore
                  </Button>
                ) : (
                  m.chosen !== v.id &&
                  m.applied?.version !== v.id &&
                  m.versions.filter((x) => !x.retired).length > 1 && (
                    <Button size="sm" kind="ghost" icon={<Archive size={13} />} onClick={() => void retire(true)} title="Move this version out of the way (it is kept, and can be restored)">
                      Retire
                    </Button>
                  )
                )}
                <Button size="sm" kind="ghost" icon={<MessageSquarePlus size={13} />} onClick={ask} title="Ask the UI copilot to change this version (a fix keeps its letter; a new idea gets a new one)">
                  Change it
                </Button>
                <Button size="sm" icon={<Check size={13} />} onClick={() => void pick()} title={m.chosen === v.id ? 'Unpick it' : 'Mark it as the one you want (the copilot builds this one when you say so)'}>
                  {m.chosen === v.id ? 'Picked' : 'Pick this one'}
                </Button>
                <Button size="sm" kind="primary" icon={<Gamepad2 size={13} />} disabled={sending} onClick={() => void putInGame()} title={`Asks the UI copilot to build version ${v.id} into your game for real, with the kits, and check it in Studio`}>
                  Put it in the game
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 pt-2.5">
              <div className="flex rounded-lg bg-surface2 p-0.5 ring-1 ring-line">
                {MOCK_DEVICES.map((d) => {
                  const on = focus ? focus === d : devices.includes(d);
                  return (
                    <button
                      key={d}
                      onClick={() => (focus ? setFocus(d) : setDevices(on ? devices.filter((x) => x !== d) : [...devices, d]))}
                      className={cx('rounded-md px-2.5 py-1 text-[12px] transition-colors', on ? 'bg-accent/20 text-accent2' : 'text-dim hover:text-text')}
                      title={`${UI_DEVICES[d].w}×${UI_DEVICES[d].h} points${focus ? '' : on ? ' · click to hide' : ' · click to show'}`}
                    >
                      {UI_DEVICES[d].label}
                    </button>
                  );
                })}
              </div>
              {focus && (
                <Button size="sm" kind="ghost" icon={<Minimize2 size={13} />} onClick={() => setFocus(null)}>
                  All devices
                </Button>
              )}
              <div className="flex-1" />
              {worn.loading && (
                <span className="flex items-center gap-1.5 text-[11.5px] text-faint">
                  <Loader2 size={12} className="animate-spin" />
                  Forging its skins…
                </span>
              )}
              {motion.length > 0 && (
                <>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-faint" title="What players with Reduce Motion on see: moves land at once, fades still play">
                    <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} className="accent-accent" />
                    Reduce Motion
                  </label>
                  <Button size="sm" kind="ghost" icon={<Play size={13} />} onClick={() => setPlay((n) => n + 1)}>
                    Play motion
                  </Button>
                </>
              )}
            </div>
            <div className="relative min-h-0 flex-1 px-4 py-3">
              <MockupBoard
                version={v}
                devices={devices}
                resolved={resolved}
                images={images}
                backdrop={backdrop.data}
                audit={audit}
                focus={focus}
                onFocus={setFocus}
                selected={selected?.path ?? null}
                onSelect={(path, device) => setSelected(path ? { path, device } : null)}
                play={play}
                reduced={reduced}
              />
            </div>
            {selected && selBox && (
              <div className="flex items-center gap-3 border-t border-line px-4 py-1.5 text-[11.5px]">
                <span className="truncate text-text">{selected.path}</span>
                <span className="text-faint">{selBox.node.cls}</span>
                <span className="text-faint tabular-nums">
                  {UI_DEVICES[selected.device].label}: {Math.round(selBox.x)}, {Math.round(selBox.y)} · {Math.round(selBox.w)}×{Math.round(selBox.h)}
                </span>
                {selFindings.length > 0 && <span className="truncate text-warn">{selFindings[0]!.message}</span>}
                <span className="flex-1" />
                <Button size="sm" kind="ghost" icon={<MessageSquarePlus size={13} />} onClick={ask}>
                  Ask about it
                </Button>
              </div>
            )}
            <div className="border-t border-line px-4 py-1.5 text-[10.5px] leading-snug text-faint">
              A mockup, not in your game. Laid out by the same engine as the UI audit (it matches Roblox within 2 points); fonts are close stand-ins for Roblox’s and images show as placeholders when they can’t be fetched. Point at and press the buttons that have states to see them answer; panel shapes, glows and outlines are drawn as Roblox will (the game builds shapes from generated images), and forged skins are 9-sliced as the game draws them
              {skipped.length ? `, as do ${[...new Set(skipped.map((x) => NOT_PREVIEWED[x.play] ?? x.play))].join(', ')}` : ''}.
            </div>
          </>
        ) : (
          <Empty icon={<LayoutPanelTop size={20} />}>{full.loading ? 'Loading the mockup…' : 'Pick a mockup at the left.'}</Empty>
        )}
      </main>
    </div>
  );
}
