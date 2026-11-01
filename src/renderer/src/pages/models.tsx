import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Boxes, CheckCircle2, CloudOff, Flame, Grid3x3, Loader2, PersonStanding, Settings2, Trash2 } from 'lucide-react';
import { assembledSize } from '@shared/render';
import { TopBar } from '../components/topbar';
import { Button, Empty, Pill, cx, timeAgo } from '../components/ui';
import { rpc, useRpc } from '../lib/rpc';
import { ModelView, PLAYER_HEIGHT } from '../components/models/model-view';
import { navigate } from '../lib/nav';
import { SendToStudio } from '../components/send-to-studio';

/** Blender for modeling (the models.env RPC). */
interface EnvStatus {
  ready: boolean;
  exe: string | null;
  version: string | null;
  max: number;
  running: number;
  detail: string;
}

/** A model being worked on in its own Blender (the models.workspaces RPC). */
interface Workspace {
  name: string;
  by: string | null;
  state: 'starting' | 'working' | 'idle' | 'closed';
  step: string | null;
  version: number;
  tris: number;
  parts: number;
  lastUsed: string;
  /** Being built in Kiln: its Kiln project (Watch in Kiln). */
  kilnProject?: string | null;
}

interface ModelRow {
  name: string;
  description?: string;
  size: [number, number, number];
  triangles: number;
  vertices: number;
  volume: number | null;
  solids: number;
  valid: boolean | null;
  assetId: string | null;
  /** error: the last upload failed; operation: Roblox took it and is still processing it. */
  upload?: { error?: string; operation?: string };
  placements: Array<{ name: string; parent: string; position: [number, number, number] }>;
  updatedAt: string;
  color?: string;
  material?: string;
  assembly?: string;
  origin?: [number, number, number];
  /** A mesh used many times: where each use sits (position, rotation in degrees, scale). */
  instances?: Array<{ position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }>;
  /** Made in Blender, or (before Blender) from a build123d script. */
  source?: 'blender' | 'build123d';
}

/** An assembly's selection key (a model's is its name). */
const ASM = 'asm:';

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));

/** How big a model is against a player: its longest side, as tall (standing up) or as long. */
const vsPlayer = ([x, y, z]: [number, number, number]): string => {
  const longest = Math.max(x, y, z);
  const r = longest / PLAYER_HEIGHT;
  return `${r.toFixed(r < 1 ? 2 : 1)}× as ${y >= longest ? 'tall' : 'long'}`;
};

// Whether the viewer shows a player beside the model (remembered on this machine).
const PLAYER_KEY = 'shuriken.models.player';
const playerPref = (): boolean => {
  try {
    return localStorage.getItem(PLAYER_KEY) !== 'off';
  } catch {
    return true;
  }
};

function EnvCard({ env }: { env: EnvStatus | undefined }) {
  if (!env) return null;
  if (env.ready) return <div className="mx-2 mt-2 flex items-center gap-1.5 text-[11.5px] text-ok"><CheckCircle2 size={12} /> {env.detail}</div>;
  return (
    <div className="mx-2 mt-3 rounded-xl border border-line bg-bg2 px-3 py-2.5 text-[12px] leading-snug text-dim">
      <div>{env.detail}</div>
      <Button size="sm" className="mt-2" icon={<Settings2 size={13} />} onClick={() => navigate('settings', 'models')}>
        Set Blender’s path
      </Button>
    </div>
  );
}

/**
 * Models workshop: the props agents model in Blender (each model in its own headless Blender, several
 * at once), previewed in 3D in their Roblox colours and materials, assembled from their parts, with
 * their size against a player, triangle budget, upload state and placements.
 */
export function ModelsPage({ selectedId }: { selectedId?: string }) {
  const list = useRpc<{ models: ModelRow[] }>('models.list', {}, ['assets.changed', 'project.changed']);
  const env = useRpc<EnvStatus>('models.env', {}, ['blender.workspaces']).data;
  const models = list.data?.models ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  // Removing a model asks once more (a model can be a lot of work).
  const [removing, setRemoving] = useState<'ask' | 'busy' | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  useEffect(() => {
    setRemoving(null);
    setRemoveError(null);
  }, [sel]);
  const [wire, setWire] = useState(false);
  const [player, setPlayer] = useState(playerPref);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const detail = useRpc<ModelRow & { code: string | null }>(sel && !sel.startsWith(ASM) ? 'models.get' : null, sel && !sel.startsWith(ASM) ? { name: sel } : undefined, ['assets.changed']);
  // Multi-part assets: parts built with the same assembly name show together, each at its origin.
  const assemblies = useMemo(() => {
    const m = new Map<string, ModelRow[]>();
    for (const r of models) if (r.assembly) m.set(r.assembly, [...(m.get(r.assembly) ?? []), r]);
    return m;
  }, [models]);
  const keyFor = (name: string | undefined) => (!name ? null : assemblies.has(name) ? `${ASM}${name}` : models.some((m) => m.name === name) ? name : null);
  // Models being worked on right now, each in its own Blender (several at once).
  const workspaces = useRpc<Workspace[]>('models.workspaces', {}, ['blender.workspaces', 'models.building']);


  useEffect(() => {
    const k = keyFor(selectedId);
    if (k) setSel(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, models.length]);

  useEffect(() => {
    if (sel && (sel.startsWith(ASM) ? assemblies.has(sel.slice(ASM.length)) : models.some((m) => m.name === sel))) return;
    const newest = [...models].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    setSel(keyFor(selectedId) ?? (newest ? (newest.assembly ? `${ASM}${newest.assembly}` : newest.name) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, sel, selectedId, assemblies]);

  useEffect(() => {
    if (!host.current) return;
    const v = new ModelView(host.current, { interactive: true, player: playerPref() });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, []);

  const parts = sel?.startsWith(ASM) ? (assemblies.get(sel.slice(ASM.length)) ?? []) : [];
  const current: (ModelRow & { parts?: ModelRow[] }) | null = sel?.startsWith(ASM)
    ? parts.length
      ? {
          name: sel.slice(ASM.length),
          description: `${parts.length} part${parts.length === 1 ? '' : 's'}, shown assembled in their own colours.`,
          size: assembledSize(parts),
          triangles: parts.reduce((t, q) => t + q.triangles, 0),
          vertices: parts.reduce((t, q) => t + q.vertices, 0),
          volume: parts.every((q) => q.volume !== null) ? parts.reduce((t, q) => t + (q.volume ?? 0), 0) : null,
          solids: parts.reduce((t, q) => t + q.solids, 0),
          valid: parts.some((q) => q.valid === false) ? false : parts.every((q) => q.valid) ? true : null,
          assetId: parts.every((q) => q.assetId) ? `all ${parts.length} parts` : null,
          placements: parts.flatMap((q) => q.placements),
          updatedAt: parts.map((q) => q.updatedAt).sort().at(-1)!,
          parts,
        }
      : null
    : (models.find((m) => m.name === sel) ?? null);
  const shown = current?.parts ?? (current ? [current] : []);
  const kilnLink = useRpc<string | null>(current ? 'models.kilnProject' : null, current ? { name: current.parts ? current.name : (current.assembly ?? current.name) } : undefined, ['blender.workspaces'], [current?.name]);
  const kilnProject = kilnLink.data ?? null;
  const stamp = shown.map((q) => `${q.name}@${q.updatedAt}`).join('|');
  useEffect(() => {
    if (!shown.length) {
      void view.current?.load(null);
      return;
    }
    let cancelled = false;
    const asm = !!current?.parts;
    void Promise.all(shown.map((q) => rpc<string>('models.glb', { name: q.name }).then((url) => ({ url, color: q.color, material: q.material, origin: asm ? q.origin : undefined, instances: q.instances }))))
      .then((ps) => {
        if (!cancelled) void view.current?.loadParts(ps);
      })
      .catch(() => view.current?.load(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Models" back />
      <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)_300px]">
        <aside className="min-h-0 overflow-y-auto border-r border-line px-2 py-3">
          {(workspaces.data?.length ?? 0) > 0 && (
            <div className="mb-3">
              <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Being modeled</div>
              {workspaces.data!.map((w) => (
                <button key={w.name} onClick={() => setSel(keyFor(w.name) ?? sel)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-dim hover:bg-white/4" title={`Version ${w.version} · ${w.tris.toLocaleString()} triangles · last change ${new Date(w.lastUsed).toLocaleTimeString()}`}>
                  {w.state === 'working' || w.state === 'starting' ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent2" /> : <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-text">{w.name}</span>
                    <span className="block truncate text-[10.5px] text-faint">{w.state === 'starting' ? 'Starting Blender…' : w.step ?? (w.state === 'working' ? 'Working…' : `Version ${w.version}`)}</span>
                  </span>
                  <span className="shrink-0 text-[10.5px] text-faint">{w.by}</span>
                  {w.kilnProject && (
                    <span
                      role="button"
                      title="Watch it being built in Kiln"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate('kiln', w.kilnProject!);
                      }}
                      className="-mr-1 shrink-0 rounded-md p-0.5 text-faint hover:bg-white/8 hover:text-accent2"
                    >
                      <Flame size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Modeled for this game</div>
          {models.length === 0 && <div className="px-2 text-[12px] leading-snug text-faint">None yet. The 3D modeler builds custom props here in Blender when free models won't do.</div>}
          {[...[...assemblies.keys()].map((a) => ({ key: `${ASM}${a}`, name: a })), ...models.filter((m) => !m.assembly).map((m) => ({ key: m.name, name: m.name }))]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => {
              const group = e.key.startsWith(ASM) ? (assemblies.get(e.name) ?? []) : null;
              const row = (key: string, name: string, tris: number, icon: ReactNode, color?: string, nested = false) => (
                <button
                  key={key}
                  onClick={() => setSel(key)}
                  className={cx('flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors', nested ? 'pl-7' : 'pl-2', sel === key ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
                >
                  {color ? <span className="h-3 w-3 shrink-0 rounded-[3px] ring-1 ring-white/15" style={{ background: color }} /> : icon}
                  <span className={cx('min-w-0 flex-1 truncate', nested ? 'text-[12px]' : 'text-[12.5px]')}>{name}</span>
                  <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{tris.toLocaleString()}△</span>
                </button>
              );
              if (!group) {
                const m = models.find((x) => x.name === e.name)!;
                return row(m.name, m.name, m.triangles, <Box size={13} className="shrink-0 text-accent2" />, m.color);
              }
              return (
                <div key={e.key}>
                  {row(e.key, `${e.name} · ${group.length} parts`, group.reduce((t, q) => t + q.triangles, 0), <Boxes size={13} className="shrink-0 text-accent2" />)}
                  {group.map((q) => row(q.name, q.name.startsWith(`${e.name}_`) ? q.name.slice(e.name.length + 1) : q.name, q.triangles, <Box size={12} className="shrink-0 text-faint" />, q.color, true))}
                </div>
              );
            })}
          <EnvCard env={env} />
        </aside>

        <main className="relative min-h-0">
          <div ref={host} className="absolute inset-0" />
          {!current && (
            <div className="pointer-events-none absolute inset-0">
              <Empty icon={<Box size={20} />}>Models appear here in 3D as they're built.</Empty>
            </div>
          )}
          {current && (
            <div className="absolute top-3 right-3 flex gap-1.5">
              <button
                onClick={() => {
                  setPlayer(!player);
                  view.current?.setPlayer(!player);
                  try {
                    localStorage.setItem(PLAYER_KEY, player ? 'off' : 'on');
                  } catch {
                    // Not remembered; the toggle still works.
                  }
                }}
                className={cx('flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] backdrop-blur transition-colors', player ? 'bg-accent/20 text-accent2' : 'bg-surface/70 text-dim hover:text-text')}
                title={`A player (${PLAYER_HEIGHT} studs tall) standing beside it, for scale`}
              >
                <PersonStanding size={13} /> Player
              </button>
              <button
                onClick={() => {
                  setWire(!wire);
                  view.current?.setWireframe(!wire);
                }}
                className={cx('flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] backdrop-blur transition-colors', wire ? 'bg-accent/20 text-accent2' : 'bg-surface/70 text-dim hover:text-text')}
                title="Show the triangles"
              >
                <Grid3x3 size={13} /> Wireframe
              </button>
            </div>
          )}
        </main>

        <aside className="min-h-0 overflow-y-auto border-l border-line px-4 py-4">
          {current && (
            <>
              <div className="font-display text-[22px] leading-tight text-text">{current.name}</div>
              {current.description && <div className="mt-1 text-[12.5px] leading-relaxed text-dim">{current.description}</div>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {current.assetId ? <Pill tone="ok">in Roblox · {current.assetId}</Pill> : <Pill tone="warn"><CloudOff size={11} /> not uploaded</Pill>}
                {current.valid === false && <Pill tone="bad">invalid solid</Pill>}
                <Pill>{current.placements.length} placed</Pill>
              </div>
              <div className="mt-4 space-y-1.5 text-[12.5px]">
                <div className="flex justify-between">
                  <span className="text-faint">Size (studs)</span>
                  <span className="tabular-nums">{current.size.map(fmt).join(' × ')}</span>
                </div>
                <div className="flex justify-between" title={`Its longest side against a default Roblox character, about ${PLAYER_HEIGHT} studs tall`}>
                  <span className="text-faint">Next to a player</span>
                  <span className="tabular-nums">{vsPlayer(current.size)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-faint">Triangles</span>
                  <span className={cx('tabular-nums', current.triangles > 8000 && 'text-warn')}>{current.triangles.toLocaleString()}</span>
                </div>
                {current.volume !== null && (
                  <div className="flex justify-between">
                    <span className="text-faint">Volume</span>
                    <span className="tabular-nums">{fmt(current.volume)} studs³</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-faint">Updated</span>
                  <span>{timeAgo(current.updatedAt)}</span>
                </div>
              </div>
              {!current.assetId && current.upload?.error && <div className="mt-2 text-[11.5px] leading-snug text-warn">{current.upload.error}</div>}
              {!current.assetId && current.upload?.operation && <div className="mt-2 text-[11.5px] leading-snug text-faint">Roblox is still processing its upload; the next placement or rig build picks it up.</div>}
              {current.placements.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Placed</div>
                  {/* The name first: an assembly's parts share a long parent path, which cut off the part that differs. */}
                  {current.placements.map((pl, i) => (
                    <div key={`${pl.parent}.${pl.name}:${i}`} className="truncate text-[12px] text-dim" title={`${pl.parent}.${pl.name}`}>
                      <span className="text-text">{pl.name}</span> <span className="text-faint tabular-nums">({pl.position.map((x) => x.toFixed(0)).join(', ')})</span> <span className="text-faint">in {pl.parent}</span>
                    </div>
                  ))}
                </div>
              )}
              {detail.data?.code && (
                <>
                  <button onClick={() => setShowCode(!showCode)} className="mt-5 text-[12px] text-dim hover:text-text">
                    {showCode ? 'Hide' : 'Show'} the build123d script (from before Blender)
                  </button>
                  {showCode && <pre className="mt-2 max-h-96 overflow-auto rounded-xl border border-line bg-bg2 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-dim">{detail.data.code}</pre>}
                </>
              )}
              {current.parts && (
                <div className="mt-4">
                  <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Parts</div>
                  {current.parts.map((q) => (
                    <button key={q.name} onClick={() => setSel(q.name)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] text-dim hover:bg-white/4 hover:text-text">
                      <span className="h-3 w-3 shrink-0 rounded-[3px] ring-1 ring-white/15" style={{ background: q.color ?? '#d8cdc2' }} />
                      <span className="min-w-0 flex-1 truncate">{q.name}</span>
                      <span className="shrink-0 text-[10.5px] text-faint">{q.material ?? ''}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-6 flex flex-wrap items-start gap-2 border-t border-line pt-4">
                {!removing && <SendToStudio method="models.sendToStudio" params={{ name: current.name }} title="Place it on the surface Studio's camera is looking at, and select it there" />}
                {kilnProject && !removing && (
                  <Button size="sm" icon={<Flame size={13} />} onClick={() => navigate('kiln', kilnProject)} title="Open this model's Kiln project on the Kiln page">
                    {workspaces.data?.some((w) => w.kilnProject === kilnProject && (w.state === 'working' || w.state === 'starting')) ? 'Watch in Kiln' : 'Open in Kiln'}
                  </Button>
                )}
                {removing ? (
                  <div className="rounded-xl bg-bad/8 px-3 py-2.5 ring-1 ring-bad/25">
                    <div className="text-[12px] leading-snug text-text">
                      Remove {current.name}{current.parts ? ` and its ${current.parts.length} parts` : ''} from the Models page?{' '}
                      {shown.some((q) => q.source === 'blender') ? 'Its Blender scene stays in the project’s models folder, so it can be brought back.' : 'Its files leave the project.'}
                      {current.placements.length ? ' Copies already placed in Studio stay.' : ''}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        kind="danger"
                        icon={<Trash2 size={13} />}
                        disabled={removing === 'busy'}
                        onClick={() => {
                          setRemoving('busy');
                          rpc('models.remove', { names: [current.name] })
                            .then(() => setSel(null))
                            .catch((e: Error) => {
                              setRemoving('ask');
                              setRemoveError(e.message);
                            });
                        }}
                      >
                        {removing === 'busy' ? 'Removing…' : 'Remove'}
                      </Button>
                      <Button size="sm" kind="ghost" disabled={removing === 'busy'} onClick={() => setRemoving(null)}>
                        Cancel
                      </Button>
                    </div>
                    {removeError && <div className="mt-2 text-[11.5px] text-bad">{removeError}</div>}
                  </div>
                ) : (
                  <Button size="sm" kind="ghost" icon={<Trash2 size={13} />} onClick={() => setRemoving('ask')} title="Remove this model from the project">
                    Remove
                  </Button>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
