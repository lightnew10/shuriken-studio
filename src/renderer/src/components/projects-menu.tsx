import { useEffect, useState } from 'react';
import { AppWindow, ExternalLink, FilePlus2, FolderOpen, Gamepad2, Plus, Trash2 } from 'lucide-react';
import type { ProjectSummary } from '@shared/domain';
import { rpc, useCoreEvent, useRpc } from '../lib/rpc';
import { navigate } from '../lib/nav';
import { useOrchestrator } from '../lib/project';
import { cx, timeAgo } from './ui';
import { openGameDialog } from './open-game';

export interface RecentProject extends ProjectSummary {
  thumbnail: string | null;
  current: boolean;
}

/**
 * The Projects menu (opened from the far left of the bar, shown right under it): recent projects with
 * thumbnails of their viewers, Open blank (a project straight into its workspace, nothing started),
 * a new window, and a new game from the start page.
 */
export function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const setOpen = (open: boolean) => !open && onClose();
  const recent = useRpc<RecentProject[]>('projects.recent', { limit: 12 }, ['project.changed', 'windows.changed']);
  // Projects open in the app's other windows: clicking one brings that window forward.
  const [elsewhere, setElsewhere] = useState<Set<string>>(new Set());
  const loadWindows = () =>
    void window.shuriken.windows
      .projects()
      .then((list) => setElsewhere(new Set(list.filter((w) => !w.mine).map((w) => w.projectId))))
      .catch(() => {});
  useEffect(loadWindows, []);
  useCoreEvent(['windows.changed', 'project.changed'], () => loadWindows());

  // Agents working on this window's project: switching it to another one stops them, so the card asks first.
  const orch = useOrchestrator();
  const working = orch.data?.activeRuns ?? 0;
  const currentName = recent.data?.find((x) => x.current)?.name;
  const [asking, setAsking] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  // The menu stays open until the project is: a refusal (open in another app, its folder unreachable) shows here,
  // where it used to vanish with the menu and leave the click doing nothing.
  const openProject = async (p: RecentProject, confirmed = false) => {
    if (switching) return;
    if (!p.current) {
      setProblem(null);
      if (working > 0 && !confirmed && !elsewhere.has(p.id)) return setAsking(p.id);
      setAsking(null);
      setSwitching(p.id);
      try {
        const r = await rpc<{ openedIn?: string } | null>('projects.open', { id: p.id });
        if (r && typeof r === 'object' && 'openedIn' in r) return setOpen(false); // it was open in another window, which is now in front
      } catch (e) {
        setProblem(String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': Error: /, ''));
        return;
      } finally {
        setSwitching(null);
      }
    }
    setOpen(false);
    window.shuriken.journal('project.open', { name: p.name });
    navigate('dashboard');
  };

  // Deleting: which card asks for confirmation, and what went wrong last time.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const remove = async (p: RecentProject, files: boolean) => {
    setDeleting(true);
    setProblem(null);
    try {
      if (!files) {
        await rpc('projects.archive', { id: p.id });
      } else {
        const r = await rpc<{ rootPath: string }>('projects.delete', { id: p.id });
        const t = await window.shuriken.trashProject(r.rootPath);
        if (!t.ok) setProblem(`${p.name} is gone from Shuriken, but its folder stayed: ${t.error ?? 'it could not be moved'}`);
      }
      window.shuriken.journal('project.delete', { name: p.name, files });
      setConfirming(null);
      recent.reload();
      if (p.current) navigate('start');
    } catch (e) {
      setProblem(String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': Error: /, ''));
    } finally {
      setDeleting(false);
    }
  };

  const openInNewWindow = (p: RecentProject | null) => {
    setOpen(false);
    window.shuriken.journal('tab.new', { project: p?.name ?? null });
    void window.shuriken.windows.open(p?.id ?? null);
  };

  const openBlank = () => {
    setOpen(false);
    window.shuriken.journal('project.blank.open');
    void window.shuriken.windows.blank().catch((e: Error) => setProblem(String(e.message ?? e).replace(/^Error invoking remote method '[^']+': Error: /, '')));
  };

  return (
    <div className="card w-[580px] max-w-[calc(100vw-16px)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-semibold tracking-[0.12em] whitespace-nowrap text-faint uppercase">Recent projects</span>
        <div className="flex items-center gap-1 whitespace-nowrap">
          <button
            onClick={() => {
              setOpen(false);
              openGameDialog();
            }}
            title="Plug in a game Shuriken didn't build: a place open in Roblox Studio, or a place file"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-dim hover:bg-white/5 hover:text-text"
          >
            <Gamepad2 size={13} /> Open a game…
          </button>
          <button onClick={openBlank} title="A new project straight into its workspace: no prompt, nothing starts and Studio stays closed. Tell the director your game idea whenever you like." className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-dim hover:bg-white/5 hover:text-text">
            <FilePlus2 size={13} /> Open blank
          </button>
          <button onClick={() => openInNewWindow(null)} title="Another window on the bar, on the start page (Ctrl+T)" className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-dim hover:bg-white/5 hover:text-text">
            <AppWindow size={13} /> New window
          </button>
          <button
            onClick={() => {
              setOpen(false);
              navigate('start');
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-accent2 hover:bg-accent/10"
          >
            <Plus size={13} /> New game
          </button>
        </div>
      </div>
      {problem && <div className="mb-2 rounded-lg bg-bad/10 px-3 py-2 text-[12px] leading-snug text-bad">{problem}</div>}
      {recent.data && recent.data.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[12.5px] text-faint">
          <FolderOpen size={22} className="opacity-60" />
          Nothing yet. Describe a game on the start page, or open a blank project, and it appears here.
        </div>
      )}
      <div className="grid max-h-[420px] grid-cols-2 gap-2.5 overflow-auto p-0.5">
        {(recent.data ?? []).map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => void openProject(p)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && void openProject(p)}
            className={cx('group relative cursor-pointer overflow-hidden rounded-xl text-left ring-1 transition-all hover:-translate-y-0.5', p.current ? 'ring-accent/60' : 'ring-line hover:ring-line2')}
          >
            <div className="relative aspect-[16/9] w-full overflow-hidden bg-bg2">
              {p.thumbnail ? (
                <img src={p.thumbnail} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(ellipse_at_30%_20%,color-mix(in_srgb,var(--color-accent)_35%,transparent),transparent_60%),radial-gradient(ellipse_at_80%_90%,rgba(224,72,15,0.3),transparent_55%)]">
                  <span className="font-display text-[28px] font-semibold text-white/80 italic">{p.name.slice(0, 1)}</span>
                </div>
              )}
              {p.current && <span className="absolute top-2 left-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-on-accent">This window</span>}
              {!p.current && elsewhere.has(p.id) && <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-accent2 ring-1 ring-accent/40 backdrop-blur">Open in another window</span>}
              <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                {!elsewhere.has(p.id) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setProblem(null);
                      setConfirming(p.id);
                    }}
                    title="Delete this project"
                    aria-label={`Delete ${p.name}`}
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/55 text-white/80 ring-1 ring-white/15 backdrop-blur hover:text-bad"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                {!p.current && !elsewhere.has(p.id) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openInNewWindow(p);
                    }}
                    title="Open in a new window"
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/55 text-white/80 ring-1 ring-white/15 backdrop-blur hover:text-white"
                  >
                    <ExternalLink size={13} />
                  </button>
                )}
              </div>
              {confirming === p.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="absolute inset-0 z-10 flex flex-col justify-center gap-1.5 bg-black/80 p-2.5 backdrop-blur-sm"
                >
                  <div className="text-[12px] leading-snug text-white">Delete “{p.name}”?</div>
                  <button
                    disabled={deleting}
                    onClick={() => void remove(p, true)}
                    title={`Removes it from Shuriken and moves ${p.rootPath} to the Recycle Bin`}
                    className="rounded-md bg-bad/85 px-2 py-1 text-[11.5px] font-medium text-white hover:bg-bad disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete (folder to Recycle Bin)'}
                  </button>
                  <div className="flex gap-1.5">
                    <button disabled={deleting} onClick={() => void remove(p, false)} title="Hides it from this list; its folder stays" className="flex-1 rounded-md bg-white/10 px-2 py-1 text-[11.5px] text-white/90 hover:bg-white/15 disabled:opacity-50">
                      Just hide it
                    </button>
                    <button disabled={deleting} onClick={() => setConfirming(null)} className="flex-1 rounded-md bg-white/10 px-2 py-1 text-[11.5px] text-white/90 hover:bg-white/15 disabled:opacity-50">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {asking === p.id && working > 0 && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="absolute inset-0 z-10 flex flex-col justify-center gap-1.5 bg-black/80 p-2.5 backdrop-blur-sm"
                >
                  <div className="text-[12px] leading-snug text-white">
                    {working === 1 ? 'An agent is' : `${working} agents are`} working on “{currentName ?? 'this project'}”. Switching stops {working === 1 ? 'it' : 'them'}; the work picks up where it left off when you open it again.
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => void openProject(p, true)} className="flex-1 rounded-md bg-accent/85 px-2 py-1 text-[11.5px] font-medium text-on-accent hover:bg-accent">
                      Switch
                    </button>
                    <button onClick={() => openInNewWindow(p)} title="Leaves the agents working here" className="flex-1 rounded-md bg-white/10 px-2 py-1 text-[11.5px] text-white/90 hover:bg-white/15">
                      New window
                    </button>
                    <button onClick={() => setAsking(null)} className="flex-1 rounded-md bg-white/10 px-2 py-1 text-[11.5px] text-white/90 hover:bg-white/15">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {switching === p.id && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 text-[12px] text-white/90 backdrop-blur-sm">{working > 0 ? 'Stopping the agents…' : 'Opening…'}</div>
              )}
            </div>
            <div className="px-2.5 py-2">
              <div className="truncate text-[13px] font-medium text-text">{p.name}</div>
              <div className="text-[11px] text-faint">{timeAgo(p.lastOpenedAt ?? p.updatedAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
