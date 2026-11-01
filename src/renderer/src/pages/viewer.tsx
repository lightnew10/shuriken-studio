import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Braces, Camera, ChevronDown, ChevronRight, Folder, Hammer, ListTree, Save, ScrollText, SquareTerminal, X } from 'lucide-react';
import { TopBar } from '../components/topbar';
import { SceneView, type ViewerApi, type ViewerStatus } from '../components/scene/scene-view';
import { ScriptView } from '../components/scene/script-view';
import type { ScenePart } from '../components/scene/engine';
import { Button, ErrorNote, Toggle } from '../components/ui';
import { rpc, useAction, useRpc } from '../lib/rpc';

/**
 * `selectedId`: a Workspace folder path ("Arena" or "Map/Arena") to select and frame once the place
 * loads, "script:<file>" to open a project script, or "output" for Studio's Output.
 */
export function ViewerPage({ selectedId }: { selectedId?: string } = {}) {
  const [shots, setShots] = useState(true);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const [picked, setPicked] = useState<ScenePart | null>(null);
  const [group, setGroup] = useState<{ path: string; parts: ScenePart[] } | null>(null);
  const [parts, setParts] = useState<ScenePart[]>([]);
  const api = useRef<ViewerApi | null>(null);
  const rebuild = useAction(() => rpc('roblox.rebuildWorld', {}));
  const save = useAction(() => rpc<{ ok: boolean; message: string }>('roblox.savePlace', {}));
  const [saved, setSaved] = useState<string | null>(null);
  // "viewer@output" opens Studio's Output right away.
  const [output, setOutput] = useState(selectedId === 'output');
  // Scripts: the project's code (the source of truth Studio is synced from) and the world builders,
  // opened read-only in tabs like Studio's script editor.
  const code = useRpc<{ files: ScriptInfo[] }>('code.index', undefined, ['roblox.changed']);
  const builders = useRpc<{ files: string[] }>('roblox.worldBuilders', undefined, ['roblox.changed']);
  const [tabs, setTabs] = useState<string[]>([]);
  const [tab, setTab] = useState<string | null>(null);
  const [jump, setJump] = useState<{ file: string; line: number; seq: number } | null>(null);
  const [script, setScript] = useState<ScriptInfo | null>(null);
  const openScript = (file: string, line?: number) => {
    setTabs((t) => (t.includes(file) ? t : [...t, file]));
    setTab(file);
    setJump(line ? { file, line, seq: Date.now() } : null);
  };
  const closeTab = (file: string) => {
    const left = tabs.filter((f) => f !== file);
    setTabs(left);
    if (tab === file) setTab(left[left.length - 1] ?? null);
  };
  const selectScript = (f: ScriptInfo, line?: number) => {
    setScript(f);
    setPicked(null);
    setGroup(null);
    openScript(f.file, line);
  };

  // The Explorer follows the scene: refresh its tree whenever the replica (re)loads.
  useEffect(() => {
    if (status?.state === 'ready') setParts(api.current?.parts() ?? []);
  }, [status?.state, status?.loaded]);

  // Deep link (the view "viewer@Arena"): select and frame that folder the first time it is there.
  const linked = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === 'output' || selectedId.startsWith('script:') || linked.current === selectedId || !parts.length) return;
    const inside = parts.filter((p) => p.parent === selectedId || p.parent?.startsWith(`${selectedId}/`));
    if (!inside.length) return;
    linked.current = selectedId;
    setGroup({ path: selectedId, parts: inside });
    setPicked(null);
    api.current?.select(inside, true);
  }, [selectedId, parts]);

  const pick = (p: ScenePart | null) => {
    setPicked(p);
    setGroup(null);
    setScript(null);
  };
  const scriptFiles = code.data?.files ?? [];
  // Deep link "viewer@script:src/Server/Combat.server.luau": open it (with its properties once indexed).
  const linkedScript = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId?.startsWith('script:') || linkedScript.current === selectedId) return;
    const file = selectedId.slice('script:'.length).replace(/\\/g, '/');
    const info = scriptFiles.find((f) => f.file === file || f.instancePath === file);
    if (!info && (code.loading || code.data === undefined) && !code.error) return;
    linkedScript.current = selectedId;
    if (info) selectScript(info);
    else openScript(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, scriptFiles, code.loading, code.error]);
  const builderFiles = builders.data?.files ?? [];
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Studio viewer" back>
        <span className="no-drag mr-1 text-[12px] text-faint">{status?.state === 'ready' ? `${status.parts.toLocaleString()} parts` : ''}</span>
      </TopBar>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 && (
            <div className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-bg2 px-2">
              <EditorTab active={tab === null} onClick={() => setTab(null)} icon={<Box size={12} />} label="Place" title="The 3D view" />
              {tabs.map((f) => (
                <EditorTab key={f} active={tab === f} onClick={() => setTab(f)} onClose={() => closeTab(f)} icon={scriptIcon(scriptFiles.find((x) => x.file === f)?.className)} label={baseName(f)} title={f} />
              ))}
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <SceneView studioShots={shots} onStatus={setStatus} onPick={pick} onApi={(a) => (api.current = a)} />
            {tab && (
              <div className="absolute inset-0 z-10">
                <ScriptView key={tab} file={tab} jump={jump?.file === tab ? jump : null} />
              </div>
            )}
            {!output && !tab && (
              <button
                onClick={() => setOutput(true)}
                className="absolute bottom-3 left-20 flex h-8 items-center gap-1.5 rounded-lg bg-surface/70 px-2.5 text-[12px] text-dim backdrop-blur hover:text-text"
                title="Studio's Output window: prints, warnings and errors from the place"
              >
                <SquareTerminal size={13} /> Output
              </button>
            )}
          </div>
          {output && <OutputPanel onClose={() => setOutput(false)} />}
        </div>
        <aside className="flex w-80 shrink-0 flex-col border-l border-line">
          <div className="flex max-h-[46%] min-h-[140px] flex-col border-b border-line">
            <div className="flex items-center gap-1.5 px-4 pt-3 pb-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
              <ListTree size={12} /> Explorer
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {parts.length ? (
                <Explorer
                  parts={parts}
                  active={group?.path ?? null}
                  activePart={picked}
                  onFolder={(path, list) => {
                    setGroup({ path, parts: list });
                    setPicked(null);
                    setScript(null);
                    setTab(null);
                    api.current?.select(list, true);
                  }}
                  onPart={(p) => {
                    setPicked(p);
                    setGroup(null);
                    setScript(null);
                    setTab(null);
                    api.current?.select([p], true);
                  }}
                />
              ) : (
                <div className="px-2 text-[12px] text-faint">
                  {!status || status.state === 'loading' ? 'Reading the place…' : status.state === 'ready' ? 'Nothing in Workspace yet.' : 'Studio isn’t reachable right now.'}
                </div>
              )}
              {(scriptFiles.length > 0 || builderFiles.length > 0) && (
                <ScriptTree
                  files={scriptFiles}
                  builders={builderFiles}
                  active={tab}
                  onScript={(f) => selectScript(f)}
                  onBuilder={(file) => {
                    setScript(null);
                    openScript(`world/${file}`);
                  }}
                />
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
                <Camera size={12} /> Properties
              </div>
              {script && !picked && !group ? (
                <ScriptProperties
                  f={script}
                  all={scriptFiles}
                  onOpen={(f, line) => (f === script ? openScript(f.file, line) : selectScript(f, line))}
                />
              ) : picked ? (
                <dl className="space-y-1.5 text-[12px]">
                  <Row k="Name" v={picked.name} />
                  <Row k="Class" v={`${picked.cls}${picked.shape ? ` · ${picked.shape}` : ''}`} />
                  <Row k="Parent" v={picked.parent ? `Workspace/${picked.parent}` : 'Workspace'} />
                  <Row k="Material" v={picked.material} />
                  <Row
                    k="Color"
                    v={
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-3 w-3 rounded-sm ring-1 ring-white/20" style={{ background: `#${picked.color}` }} />#{picked.color}
                      </span>
                    }
                  />
                  <Row k="Size" v={picked.size.map((n) => Math.round(n * 10) / 10).join(' × ')} />
                  <Row k="Position" v={picked.pos.map((n) => Math.round(n * 10) / 10).join(', ')} />
                  <Row k="Rotation" v={picked.rot.map((n) => Math.round(n)).join('°, ') + '°'} />
                  {picked.transparency > 0 && <Row k="Transp." v={picked.transparency} />}
                  {picked.reflectance > 0 && <Row k="Reflect." v={picked.reflectance} />}
                  {picked.model && <Row k="Model" v={`${picked.model} (3D workshop)`} />}
                </dl>
              ) : group ? (
                <dl className="space-y-1.5 text-[12px]">
                  <Row k="Folder" v={group.path ? `Workspace/${group.path}` : 'Workspace'} />
                  <Row k="Parts" v={group.parts.length.toLocaleString()} />
                  <Row k="Materials" v={topMaterials(group.parts)} />
                  <div className="pt-1 text-[11.5px] text-faint">Outlined in the view; press F there to frame it again.</div>
                </dl>
              ) : (
                <div className="text-[12px] text-faint">Click something in the view or the Explorer (scripts open read-only in tabs).</div>
              )}
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">View</div>
              <Toggle checked={shots} onChange={setShots} label="Studio shots" hint="When the camera rests, show Studio's own render from the same angle." />
              <div className="mt-1 text-[12px] leading-relaxed text-faint">Controls match Roblox Studio: right-drag to look around, WASD to fly, Q/E down/up, Shift for precise moves, wheel to zoom, middle-drag to pan, F to focus. Click a part to inspect it.</div>
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Place</div>
              <div className="flex flex-col gap-2">
                <Button
                  icon={<Save size={14} />}
                  disabled={save.busy}
                  onClick={() => void save.run().then((r) => r && setSaved(r.message))}
                  title="Saves the place through Studio's File menu"
                >
                  {save.busy ? 'Saving…' : 'Save place in Studio'}
                </Button>
                <Button icon={<Hammer size={14} />} disabled={rebuild.busy} onClick={() => void rebuild.run()} title="Run the world builders again">
                  {rebuild.busy ? 'Rebuilding…' : 'Rebuild world'}
                </Button>
                {saved && <div className="text-[12px] text-dim">{saved}</div>}
                <ErrorNote error={save.error ?? rebuild.error} />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-faint">{k}</dt>
      <dd className="min-w-0 flex-1 break-words text-text">{v}</dd>
    </div>
  );
}

function topMaterials(parts: ScenePart[]): string {
  const n = new Map<string, number>();
  for (const p of parts) n.set(p.material, (n.get(p.material) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m, c]) => `${m} ${Math.round((c / parts.length) * 100)}%`)
    .join(', ');
}

// ─── Explorer: Workspace as Studio shows it (folders and models, then parts) ──────────────────

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  parts: ScenePart[];
  total: number;
}

function buildTree(parts: ScenePart[]): TreeNode {
  const root: TreeNode = { name: 'Workspace', path: '', children: new Map(), parts: [], total: 0 };
  for (const p of parts) {
    let node = root;
    node.total++;
    for (const seg of p.parent ? p.parent.split('/') : []) {
      let c = node.children.get(seg);
      if (!c) {
        c = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, children: new Map(), parts: [], total: 0 };
        node.children.set(seg, c);
      }
      node = c;
      node.total++;
    }
    node.parts.push(p);
  }
  return root;
}

const allUnder = (n: TreeNode): ScenePart[] => [...n.parts, ...[...n.children.values()].flatMap(allUnder)];

/** Parts listed per folder before "… more" (big maps have folders of thousands). */
const PART_ROWS = 80;

function Explorer({
  parts,
  active,
  activePart,
  onFolder,
  onPart,
}: {
  parts: ScenePart[];
  active: string | null;
  activePart: ScenePart | null;
  onFolder: (path: string, parts: ScenePart[]) => void;
  onPart: (p: ScenePart) => void;
}) {
  const tree = useMemo(() => buildTree(parts), [parts]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']));
  const [more, setMore] = useState<Set<string>>(() => new Set());
  const list = useRef<HTMLDivElement>(null);
  // Like Studio: a part picked in the view opens its folders and scrolls into sight in the Explorer.
  useEffect(() => {
    if (!activePart) return;
    const segs = activePart.parent ? activePart.parent.split('/') : [];
    const paths = ['', ...segs.map((_, i) => segs.slice(0, i + 1).join('/'))];
    setOpen((s) => (paths.every((x) => s.has(x)) ? s : new Set([...s, ...paths])));
    // Only list a whole folder when the part is past the first rows (big folders hold thousands).
    const folder = activePart.parent ?? '';
    let node: TreeNode | undefined = tree;
    for (const seg of segs) node = node?.children.get(seg);
    const rank = node ? [...node.parts].sort((a, b) => a.name.localeCompare(b.name)).indexOf(activePart) : -1;
    if (rank >= PART_ROWS) setMore((s) => (s.has(folder) ? s : new Set(s).add(folder)));
    const id = window.setTimeout(() => list.current?.querySelector('[data-active-part="true"]')?.scrollIntoView({ block: 'nearest' }), 60);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePart]);
  const toggle = (path: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const rows: React.ReactNode[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const isOpen = open.has(node.path);
    const hasKids = node.children.size > 0 || node.parts.length > 0;
    rows.push(
      <div
        key={`f:${node.path}`}
        className={`group flex h-6 cursor-default items-center gap-1 rounded-md pr-2 text-[12px] ${active === node.path ? 'bg-accent/20 text-text' : 'text-dim hover:bg-white/5'}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => onFolder(node.path, allUnder(node))}
        title={`${node.total.toLocaleString()} part${node.total === 1 ? '' : 's'} — click to select and frame`}
      >
        <button
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            if (hasKids) toggle(node.path);
          }}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {hasKids ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </button>
        <Folder size={12} className="shrink-0 text-accent/80" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-faint">{node.total.toLocaleString()}</span>
      </div>,
    );
    if (!isOpen) return;
    for (const c of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) walk(c, depth + 1);
    const sorted = [...node.parts].sort((a, b) => a.name.localeCompare(b.name));
    const shown = more.has(node.path) ? sorted : sorted.slice(0, PART_ROWS);
    for (const [i, p] of shown.entries()) {
      rows.push(
        <div
          key={`p:${node.path}:${i}`}
          data-active-part={activePart === p ? 'true' : undefined}
          className={`flex h-6 cursor-default items-center gap-1 rounded-md pr-2 text-[12px] ${activePart === p ? 'bg-accent/20 text-text' : 'text-dim hover:bg-white/5'}`}
          style={{ paddingLeft: 4 + (depth + 1) * 12 + 16 }}
          onClick={() => onPart(p)}
          title={`${p.cls} · ${p.material}`}
        >
          <Box size={12} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate">{p.name || p.cls}</span>
        </div>,
      );
    }
    if (sorted.length > shown.length)
      rows.push(
        <button
          key={`m:${node.path}`}
          className="h-6 rounded-md text-left text-[11.5px] text-faint hover:text-text"
          style={{ paddingLeft: 4 + (depth + 1) * 12 + 16 }}
          onClick={() => setMore((s) => new Set(s).add(node.path))}
        >
          … {(sorted.length - shown.length).toLocaleString()} more
        </button>,
      );
  };
  walk(tree, 0);
  return (
    <div ref={list} className="flex flex-col">
      {rows}
    </div>
  );
}

// ─── Output: Studio's console, like Studio's Output window ───────────────────────────────────

/** Lines that look like problems (Studio's console text carries no levels). */
const PROBLEM = /error|exception|attempt to|stack begin|failed|invalid|is not a valid member|nil value/i;
const WARNING = /warn|deprecated|isn't uploaded|no effect named|not uploaded/i;

function OutputPanel({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = problemsOnly ? lines.filter((l) => PROBLEM.test(l) || WARNING.test(l)) : lines;
  useEffect(() => {
    let alive = true;
    const load = () =>
      rpc<string>('roblox.console')
        .then((text) => {
          if (!alive) return;
          setError(null);
          setLines(text.split(/\r?\n/).filter((l) => l.trim()).slice(-300));
        })
        .catch((e) => alive && setError(String((e as Error).message ?? e)));
    void load();
    const id = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, problemsOnly]);
  return (
    <div className="flex h-[32%] min-h-[140px] shrink-0 flex-col border-t border-line bg-bg2">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
        <SquareTerminal size={12} /> Output
        <span className="ml-auto font-normal tracking-normal normal-case">{error ? 'Studio not reachable' : `${shown.length} ${problemsOnly ? 'problems' : 'lines'} · refreshes every few seconds`}</span>
        <button
          onClick={() => setProblemsOnly((v) => !v)}
          className={`rounded px-1.5 py-0.5 font-normal tracking-normal normal-case ${problemsOnly ? 'bg-warn/15 text-warn' : 'text-faint hover:text-text'}`}
          title="Show only errors and warnings"
        >
          Problems only
        </button>
        <button onClick={onClose} className="rounded p-0.5 text-faint hover:text-text" aria-label="Close output">
          <X size={13} />
        </button>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed"
      >
        {error ? (
          <div className="text-faint">{error}</div>
        ) : shown.length === 0 ? (
          <div className="text-faint">{problemsOnly ? 'No errors or warnings.' : 'Nothing printed yet.'}</div>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={PROBLEM.test(l) ? 'text-bad' : WARNING.test(l) ? 'text-warn' : 'text-dim'}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Scripts: the project's code by where it lives in the place ──────────────────────────────

interface ScriptInfo {
  file: string;
  instancePath: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  context: 'server' | 'client' | 'shared';
  lines: number;
  requires: Array<{ expr: string; target: string | null; line: number }>;
  symbols: Array<{ name: string; kind: 'function' | 'method' | 'type' | 'constant'; line: number; exported: boolean }>;
  remotes: Array<{ name: string; kind: string; role: string; line: number }>;
}

const baseName = (f: string) => f.split('/').pop() ?? f;

function scriptIcon(cls: string | undefined, size = 12) {
  if (cls === 'ModuleScript') return <Braces size={size} className="shrink-0 text-[#b58cff]" />;
  if (cls === 'LocalScript') return <ScrollText size={size} className="shrink-0 text-info" />;
  if (cls === 'Script') return <ScrollText size={size} className="shrink-0 text-ok" />;
  return <Hammer size={size} className="shrink-0 text-faint" />;
}

function EditorTab({ active, onClick, onClose, icon, label, title }: { active: boolean; onClick: () => void; onClose?: () => void; icon: React.ReactNode; label: string; title: string }) {
  return (
    <div
      onClick={onClick}
      onAuxClick={(e) => e.button === 1 && onClose?.()}
      title={title}
      className={`flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-t-md px-2.5 text-[12px] ${active ? 'bg-surface2 text-text' : 'text-faint hover:text-dim'}`}
    >
      {icon}
      <span className="max-w-44 truncate">{label}</span>
      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="rounded p-0.5 text-faint hover:text-text"
          aria-label={`Close ${label}`}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/** Services in the order Studio's Explorer lists them. */
const SERVICE_ORDER = ['Workspace', 'Players', 'Lighting', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'SoundService', 'TextChatService'];

interface ScriptNode {
  name: string;
  path: string;
  children: Map<string, ScriptNode>;
  script?: ScriptInfo;
}

function buildScriptTree(files: ScriptInfo[]): ScriptNode {
  const root: ScriptNode = { name: '', path: '', children: new Map() };
  for (const f of files) {
    let node = root;
    for (const seg of f.instancePath.split('/')) {
      let c = node.children.get(seg);
      if (!c) {
        c = { name: seg, path: node.path ? `${node.path}/${seg}` : seg, children: new Map() };
        node.children.set(seg, c);
      }
      node = c;
    }
    node.script = f;
  }
  return root;
}

function ScriptTree({ files, builders, active, onScript, onBuilder }: { files: ScriptInfo[]; builders: string[]; active: string | null; onScript: (f: ScriptInfo) => void; onBuilder: (file: string) => void }) {
  const tree = useMemo(() => buildScriptTree(files), [files]);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const order = (a: ScriptNode, b: ScriptNode) => {
    const ia = SERVICE_ORDER.indexOf(a.name);
    const ib = SERVICE_ORDER.indexOf(b.name);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    // Folders before scripts, then by name (as Studio sorts).
    if (!a.script !== !b.script) return a.script ? 1 : -1;
    return a.name.localeCompare(b.name);
  };
  const rows: React.ReactNode[] = [];
  const row = (key: string, depth: number, isOpen: boolean | null, icon: React.ReactNode, label: string, onClick: () => void, on: boolean, title: string, onToggle?: () => void) =>
    rows.push(
      <div
        key={key}
        className={`flex h-6 cursor-default items-center gap-1 rounded-md pr-2 text-[12px] ${on ? 'bg-accent/20 text-text' : 'text-dim hover:bg-white/5'}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={onClick}
        title={title}
      >
        <button
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen === null ? null : isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>,
    );
  const walk = (node: ScriptNode, depth: number) => {
    const kids = [...node.children.values()].sort(order);
    const isOpen = !closed.has(node.path);
    const f = node.script;
    if (f) row(`s:${node.path}`, depth, kids.length ? isOpen : null, scriptIcon(f.className), node.name, () => onScript(f), active === f.file, `${f.className} · ${f.file} · ${f.lines} lines`, () => toggle(node.path));
    else row(`d:${node.path}`, depth, kids.length ? isOpen : null, <Folder size={12} className="shrink-0 text-faint" />, node.name, () => toggle(node.path), false, node.path, () => toggle(node.path));
    if (isOpen) for (const c of kids) walk(c, depth + 1);
  };
  for (const c of [...tree.children.values()].sort(order)) walk(c, 0);
  if (builders.length) {
    const isOpen = !closed.has('world/');
    row('b:', 0, isOpen, <Hammer size={12} className="shrink-0 text-faint" />, 'World builders', () => toggle('world/'), false, 'world/*.luau: scripts that build the place in edit mode (Rebuild world runs them again)', () => toggle('world/'));
    if (isOpen) for (const b of builders) row(`b:${b}`, 1, null, <ScrollText size={12} className="shrink-0 text-faint" />, b.replace(/\.luau$/, ''), () => onBuilder(b), active === `world/${b}`, `world/${b}`);
  }
  return <div className="mt-1 flex flex-col border-t border-line pt-1">{rows}</div>;
}

const ROLE: Record<string, string> = {
  defines: 'creates',
  fires_server: 'fires to server',
  fires_client: 'fires to clients',
  handles_server: 'handles on server',
  handles_client: 'handles on client',
  invokes_server: 'invokes server',
  handles_invoke: 'answers invoke',
  references: 'uses',
};

function ScriptProperties({ f, all, onOpen }: { f: ScriptInfo; all: ScriptInfo[]; onOpen: (f: ScriptInfo, line?: number) => void }) {
  const fns = f.symbols.filter((x) => x.kind === 'function' || x.kind === 'method');
  const required = f.requires.map((r) => ({ r, to: r.target ? all.find((x) => x.file === r.target) : undefined }));
  const usedBy = all.filter((x) => x.requires.some((r) => r.target === f.file));
  const remotes = [...new Map(f.remotes.filter((r) => !r.name.startsWith('(')).map((r) => [`${r.name}:${r.role}`, r])).values()];
  const link = 'text-left text-accent2 hover:underline';
  return (
    <div className="space-y-3">
      <dl className="space-y-1.5 text-[12px]">
        <Row k="Name" v={baseName(f.instancePath)} />
        <Row k="Class" v={<span className="flex items-center gap-1.5">{scriptIcon(f.className)}{f.className}</span>} />
        <Row k="Parent" v={f.instancePath.split('/').slice(0, -1).join('/')} />
        <Row k="File" v={<span className="font-mono text-[11px]">{f.file}</span>} />
        <Row k="Runs on" v={`${f.context} · ${f.lines.toLocaleString()} lines`} />
        {required.length > 0 && (
          <Row
            k="Requires"
            v={
              <span className="flex flex-col items-start">
                {required.map(({ r, to }, i) =>
                  to ? (
                    <button key={i} className={link} onClick={() => onOpen(to)} title={to.file}>
                      {baseName(to.instancePath)} <span className="text-faint">{to.context}</span>
                    </button>
                  ) : (
                    <span key={i} className="text-dim" title={r.expr}>
                      {/(\w+)["']?\)?\s*$/.exec(r.expr)?.[1] ?? r.expr.slice(0, 40)}
                    </span>
                  ),
                )}
              </span>
            }
          />
        )}
        {usedBy.length > 0 && (
          <Row
            k="Used by"
            v={
              <span className="flex flex-col items-start">
                {usedBy.map((u) => (
                  <button key={u.file} className={link} onClick={() => onOpen(u)} title={u.file}>
                    {baseName(u.instancePath)} <span className="text-faint">{u.context}</span>
                  </button>
                ))}
              </span>
            }
          />
        )}
        {remotes.length > 0 && (
          <Row
            k="Remotes"
            v={
              <span className="flex flex-col items-start">
                {remotes.slice(0, 12).map((r) => (
                  <button key={`${r.name}:${r.role}`} className={link} onClick={() => onOpen(f, r.line)}>
                    {r.name} <span className="text-faint">{ROLE[r.role] ?? r.role}</span>
                  </button>
                ))}
              </span>
            }
          />
        )}
      </dl>
      {fns.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-faint">Functions</div>
          <div className="flex flex-col items-start gap-0.5 font-mono text-[11.5px]">
            {fns.slice(0, 40).map((x) => (
              <button key={`${x.name}:${x.line}`} className="max-w-full truncate text-left text-[#fdfbac]/90 hover:underline" onClick={() => onOpen(f, x.line)} title={`line ${x.line}`}>
                {x.name}
              </button>
            ))}
            {fns.length > 40 && <span className="text-faint">… {fns.length - 40} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
