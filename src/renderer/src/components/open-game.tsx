import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown, FileUp, FolderOpen, Gamepad2, MonitorPlay, RefreshCw } from 'lucide-react';
import { rpc } from '../lib/rpc';
import { useCurrentProject, useOrchestrator } from '../lib/project';
import { navigate } from '../lib/nav';
import { Button, Modal, cx } from './ui';
import { EMPTY_ROBLOX, RobloxChoiceFields, robloxChoice, robloxSummary, saveProjectKey, type RobloxDraft } from './roblox-choice';

interface StudioPlace {
  name: string;
  placeId: string | null;
  project: { id: string; name: string } | null;
}

const clean = (m: string) => m.replace(/^Error invoking remote method '[^']+': Error: /, '');

// One dialog per window, opened from the Projects menu or the start page.
let shown = false;
const listeners = new Set<() => void>();
export function openGameDialog(): void {
  shown = true;
  for (const l of listeners) l();
}
function closeGameDialog(): void {
  shown = false;
  for (const l of listeners) l();
}

/** Mounted once at the app's root: the "Open a game" dialog whenever something asks for it. */
export function OpenGameHost() {
  const open = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown,
  );
  return <OpenGameDialog open={open} onClose={closeGameDialog} />;
}

/**
 * "Open a game…": plug in a game Shuriken didn't build — a place open in Roblox Studio right now, or a
 * place file. Its scripts come in as files, the director reads the game, then the user says what to
 * change. A place plugged in before opens its project again.
 */
export function OpenGameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [places, setPlaces] = useState<StudioPlace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The plugged-in game's community or account and its own key (closed: your defaults from Settings).
  const [roblox, setRoblox] = useState<RobloxDraft>(EMPTY_ROBLOX);
  const [showRoblox, setShowRoblox] = useState(false);
  const current = useCurrentProject();
  const orch = useOrchestrator(open && !!current.data);

  const load = async () => {
    setLoading(true);
    setProblem(null);
    try {
      setPlaces(await rpc<StudioPlace[]>('games.studioPlaces'));
    } catch (e) {
      setPlaces([]);
      setProblem(`Couldn't reach Roblox Studio: ${clean((e as Error).message)}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (open) void load();
    else {
      setBusy(null);
      setProblem(null);
      setRoblox(EMPTY_ROBLOX);
      setShowRoblox(false);
    }
  }, [open]);

  const adopt = async (game: { studio?: string; file?: string }, label: string) => {
    const picked = robloxChoice(roblox);
    if (picked.problem) {
      setShowRoblox(true);
      return setProblem(picked.problem);
    }
    setBusy(label);
    setProblem(null);
    window.shuriken.journal('game.adopt', { from: game.studio ? 'studio' : 'file', roblox: roblox.mode, ownKey: !!roblox.key.trim() });
    try {
      const r = await window.shuriken.windows.adopt({ ...game, ...(picked.choice ? { roblox: picked.choice } : {}) });
      if (r.error) {
        setProblem(clean(r.error));
        setBusy(null);
        return;
      }
      await saveProjectKey(r.id, roblox.key).catch(() => undefined);
      onClose();
      if (r.here) navigate('dashboard');
    } catch (e) {
      setProblem(clean((e as Error).message));
      setBusy(null);
    }
  };

  const openProject = async (p: { id: string; name: string }) => {
    onClose();
    // Agents working on this window's project carry on: the other one opens in a window of its own.
    if (current.data && (orch.data?.activeRuns ?? 0) > 0) return void window.shuriken.windows.open(p.id);
    const r = await rpc<{ openedIn?: string } | null>('projects.open', { id: p.id }).catch(() => null);
    if (r && typeof r === 'object' && 'openedIn' in r) return;
    navigate('dashboard');
  };

  const pickFile = async () => {
    const file = await window.shuriken.openPlaceFile();
    if (file) await adopt({ file }, file);
  };

  // A Shuriken project folder (from another session or PC): listed, then opened here or in a new window.
  const pickFolder = async () => {
    const dir = await window.shuriken.openDirectory('Open a Shuriken project folder');
    if (!dir) return;
    setBusy('folder');
    setProblem(null);
    try {
      const p = await rpc<{ id: string; name: string }>('projects.register', { rootPath: dir });
      window.shuriken.journal('project.register', { name: p.name });
      onClose();
      if (current.data) await window.shuriken.windows.open(p.id);
      else {
        await rpc('projects.open', { id: p.id });
        navigate('dashboard');
      }
    } catch (e) {
      setProblem(clean((e as Error).message));
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Open a game" width={560}>
      <div className="flex flex-col gap-5">
        <p className="text-[13px] leading-relaxed text-dim">
          Plug in a game Shuriken didn’t build — yours, someone else’s, or one from another session. Its scripts come in as files that stay in sync with Studio both ways, the director reads the whole game, and then you tell it what to change.
        </p>

        <section className="flex flex-col gap-2">
          <button onClick={() => setShowRoblox((v) => !v)} aria-expanded={showRoblox} className="flex items-center gap-1.5 self-start text-[11px] font-semibold tracking-[0.12em] text-faint uppercase hover:text-dim">
            {robloxSummary(roblox)} (for a game you plug in) <ChevronDown size={12} className={cx('transition-transform', showRoblox && 'rotate-180')} />
          </button>
          {showRoblox && <RobloxChoiceFields value={roblox} onChange={setRoblox} disabled={!!busy} />}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Open in Roblox Studio now</span>
            <button onClick={() => void load()} disabled={loading} title="Look again" className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-dim hover:bg-white/5 hover:text-text disabled:opacity-40">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
          {places && places.length === 0 && !problem && (
            <div className="rounded-xl bg-bg2 px-3.5 py-3 text-[12.5px] leading-snug text-faint ring-1 ring-line">
              Nothing is open in Studio. Open your game in Roblox Studio (with its MCP server on: Assistant → Manage MCP Servers), then refresh.
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {(places ?? []).map((p) => (
              <div key={p.name} className="flex items-center gap-3 rounded-xl bg-bg2 px-3.5 py-2.5 ring-1 ring-line">
                <MonitorPlay size={16} className="shrink-0 text-accent2" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-text">{p.name}</div>
                  <div className="truncate text-[11.5px] text-faint">{p.project ? `Already in Shuriken as “${p.project.name}”` : p.placeId ? `Roblox place ${p.placeId}` : 'A local place file'}</div>
                </div>
                {p.project ? (
                  <Button size="sm" onClick={() => void openProject(p.project!)} disabled={!!busy}>
                    Open project
                  </Button>
                ) : (
                  <Button size="sm" kind="primary" icon={<Gamepad2 size={13} />} disabled={!!busy} onClick={() => void adopt({ studio: p.name }, p.name)}>
                    {busy === p.name ? 'Plugging in…' : 'Plug in'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">From a place file</span>
          <div className="flex items-center gap-3">
            <Button icon={<FileUp size={14} />} disabled={!!busy} onClick={() => void pickFile()}>
              {busy && busy !== 'folder' && !(places ?? []).some((p) => p.name === busy) ? 'Plugging in…' : 'Choose a .rbxl or .rbxlx…'}
            </Button>
            <span className="text-[11.5px] leading-snug text-faint">Studio opens it; the file stays where it is (a copy of it as it was is kept with the project).</span>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">A Shuriken project</span>
          <div className="flex items-center gap-3">
            <Button icon={<FolderOpen size={14} />} disabled={!!busy} onClick={() => void pickFolder()}>
              {busy === 'folder' ? 'Opening…' : 'Choose its folder…'}
            </Button>
            <span className="text-[11.5px] leading-snug text-faint">A project from another session or PC (its folder has a .shuriken folder): it opens with everything it had.</span>
          </div>
        </section>

        {problem && <div className="rounded-lg bg-bad/10 px-3 py-2 text-[12px] leading-snug text-bad">{problem}</div>}
      </div>
    </Modal>
  );
}
