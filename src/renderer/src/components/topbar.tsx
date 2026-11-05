import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, ChevronDown, Clock3, Film, Flame, LayoutGrid, Pause, Pencil, Play, Receipt, Settings2, Square, Users } from 'lucide-react';
import type { OrchestratorState } from '@shared/events';
import type { CollabHeaderStatus } from '@shared/collaboration';
import { NO_READING_HINT, clockText, formatAccountUsage, limitingUsage } from '@shared/usage';
import { COST_NOTE, usdText, type BuildCost } from '@shared/costs';
import { goBack, navigate } from '../lib/nav';
import { useBusy, useCurrentProject, useOrchestrator } from '../lib/project';
import { rpc, useRpc } from '../lib/rpc';
import { IconButton, cx } from './ui';
import { useOverlay } from '../lib/overlays';
import { KilnBuildsBadge } from './kiln-builds';

interface UsageWindow {
  utilization: number | null;
  resetsAt?: number | null;
}

interface AccountsInfo {
  accounts: Array<{ id: string; label: string; plan: string | null; signedIn: boolean; builtin?: boolean; eligible?: boolean; usage: { blocked: boolean; blockedUntil: number | null; windows: Record<string, UsageWindow> } }>;
  activeId: string | null;
  /** The app-wide default (Settings), and this window's own choice (null: it follows the default). */
  defaultId?: string | null;
  windowId?: string | null;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Popover({ open, children, align = 'left', width = 280 }: { open: boolean; children: ReactNode; align?: 'left' | 'right'; width?: number }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -3, scale: 0.98 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          style={{ width }}
          className={cx('card absolute top-9 z-50 p-1.5', align === 'left' ? 'left-0 origin-top-left' : 'right-0 origin-top-right')}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const menuItem = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-text transition-colors hover:bg-white/5 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';
/** An account row: the label and its usage lines stack, the check and the right-hand badge line up with the label. */
const accountItem = menuItem.replace('items-center', 'items-start');

/** Shared top bar of the dashboard and detail pages. The window's own controls sit at the far right. */
export function TopBar({ title, back, children }: { title?: string; back?: boolean; children?: ReactNode }) {
  const project = useCurrentProject();
  const busy = useBusy();
  const orch = useOrchestrator();
  const accounts = useRpc<AccountsInfo>('accounts.list', undefined, ['accounts.changed', 'usage.observed', 'usage.changed']);
  const state = orch.data;
  const statusText = !state
    ? ''
    : state.held
      ? 'On hold since you opened it · Resume to carry on'
      : state.paused
      ? `Paused${state.pausedUntil ? ` · resumes ${clock(Date.parse(state.pausedUntil))}` : ''}${state.activeRuns > 0 ? ` · ${state.activeRuns} finishing` : ''}`
      : state.activeRuns > 0
        ? // Why this many: "12 running: 14 ready, usage 41% of the 5-hour window" (the scheduler's own explanation).
          state.agents?.why
          ? `${state.activeRuns} running: ${state.agents.why}`
          : `${state.activeRuns} agent${state.activeRuns === 1 ? '' : 's'} working`
        : state.waiting
          ? state.waiting
          : state.queued > 0
            ? 'Starting…'
            : 'Idle';

  return (
    // relative + z-40: menus open over the dashboard's containers, never under them.
    <div className="drag overlay-pad relative z-40 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-bg/80 pl-3 backdrop-blur">
      {back && (
        <IconButton title="Back" onClick={goBack}>
          <ArrowLeft size={16} />
        </IconButton>
      )}
      {/* The Projects menu lives at the far left of the bar above; here, the project's name. */}
      <ProjectName name={project.data?.name ?? null} />
      {title && (
        <>
          <span className="text-faint">/</span>
          <span className="text-[13px] font-medium whitespace-nowrap text-dim">{title}</span>
        </>
      )}
      <div className="no-drag ml-2 flex items-center gap-2 text-[12px]">
        <span className={cx('h-1.5 w-1.5 rounded-full', busy ? 'bg-accent shadow-[0_0_8px_color-mix(in_srgb,var(--color-accent)_90%,transparent)]' : state?.paused ? 'bg-warn' : 'bg-faint')} />
        <span className={cx('max-w-[380px] truncate', busy ? 'text-accent2' : state?.waiting && !state.paused ? 'text-warn' : 'text-faint')} title={statusText}>
          {statusText}
        </span>
        {project.data && state && <WorkControl state={state} />}
        {project.data && <KilnBuildsBadge />}
      </div>
      <div className="flex-1" />
      {children}
      <CollaborationHeader />
      {project.data && <CostChip />}
      {accounts.data && <AccountMenu info={accounts.data} reload={accounts.reload} />}
      <IconButton title="Kiln (3D modeling, docked)" onClick={() => navigate('kiln')}>
        <Flame size={16} />
      </IconButton>
      {project.data && (
        <IconButton title="References (gameplay footage and pictures to build from)" onClick={() => navigate('references')}>
          <Film size={16} />
        </IconButton>
      )}
      <IconButton title="Dashboard" onClick={() => navigate('dashboard')}>
        <LayoutGrid size={16} />
      </IconButton>
      <IconButton title="Settings" onClick={() => navigate('settings')}>
        <Settings2 size={16} />
      </IconButton>
    </div>
  );
}

/** Minimal participation badge, shared by host and guests in every project header. */
function CollaborationHeader() {
  // The full collaboration.status includes chat and task histories. Keep this global UI lightweight.
  const session = useRpc<CollabHeaderStatus>('collaboration.header', undefined, ['collaboration.changed']);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const data = session.data;
  if (!data?.role) return null;

  const online = data.connection === 'connected' && (data.role === 'host' || data.hostOnline);
  const status = online ? 'En ligne' : data.connection === 'reconnecting' ? 'Reconnexion' :
    data.connection === 'connecting' ? 'Connexion' : data.role === 'guest' && !data.hostOnline ? 'Hôte absent' : 'Hors ligne';
  const others = data.peers.filter((peer) => peer.id !== data.selfId);
  const participants = data.peers.length;
  const user = others[0]?.name ?? '';
  const role = data.role === 'host' ? 'Hôte' : 'Invité';

  return (
    <div ref={ref} className="no-drag relative shrink-0">
      <button
        type="button"
        aria-label={`Collaboration · ${status} · ${participants} participant${participants === 1 ? '' : 's'} · ouvrir les détails`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Collaboration · ${status} · ${data.peers.map((peer) => peer.name).join(', ') || role}`}
        onClick={() => setOpen((was) => !was)}
        className={cx(
          'inline-flex h-7 max-w-[210px] items-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-medium transition-colors',
          open ? 'border-accent/35 bg-accent/12 text-accent2' : 'border-line2 bg-surface2/60 text-dim hover:bg-white/5 hover:text-text',
        )}
      >
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', online ? 'bg-ok' : 'bg-warn')} />
        <span className="hidden sm:inline">Collab</span>
        <span className={cx('text-[10.5px]', online ? 'text-text' : 'text-warn')}>{status}</span>
        <span className="mx-0.5 h-3 w-px bg-line2" />
        <Users size={12} className="shrink-0 text-faint" />
        <span className="tabular-nums text-text">{participants}</span>
        {online && user && <span className="hidden max-w-[64px] truncate text-faint 2xl:inline" title={user}>· {user}</span>}
      </button>

      <Popover open={open} align="right" width={264}>
        <div className="px-2.5 pt-2 pb-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-text">Session collaborative</span>
            <span className={cx('text-[10.5px] font-medium', online ? 'text-ok' : 'text-warn')}>{status}</span>
          </div>
          <p className="mt-1 text-[11px] text-faint">{role} · {participants} participant{participants === 1 ? '' : 's'} connecté{participants === 1 ? '' : 's'}</p>
        </div>
        <div className="mx-2 border-t border-line" />
        <div className="max-h-52 overflow-y-auto px-1 py-1">
          {data.peers.map((peer) => (
            <div key={peer.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-[11px] font-semibold text-accent2">
                {peer.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-text" title={peer.name}>
                {peer.name}{peer.id === data.selfId ? ' (vous)' : ''}
              </span>
              <span className="shrink-0 text-[10.5px] text-faint">{peer.role === 'host' ? 'Hôte' : 'Invité'}</span>
            </div>
          ))}
          {!data.peers.length && <p className="px-2 py-2 text-[11px] text-faint">En attente de la connexion…</p>}
        </div>
        <div className="mx-2 border-t border-line" />
        <button className={menuItem} onClick={() => { setOpen(false); navigate('collaboration'); }}>
          <Users size={13} className="text-faint" /> Ouvrir l'espace partagé
        </button>
        <button className={menuItem} onClick={() => { setOpen(false); navigate('settings', 'collaboration'); }}>
          <Settings2 size={13} className="text-faint" /> Gérer la collaboration
        </button>
      </Popover>
    </div>
  );
}

/** The open project's name: opens the dashboard; the pencil renames it in place (Enter saves, Escape cancels). */
function ProjectName({ name }: { name: string | null }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = async () => {
    const next = text.trim();
    if (!next || next === name) return setEditing(false);
    try {
      await rpc('project.rename', { name: next });
      window.shuriken.journal('project.rename', { name: next });
      setEditing(false);
      setProblem(null);
    } catch (e) {
      setProblem(String((e as Error).message ?? e).replace(/^Error invoking remote method 'rpc': Error: /, ''));
    }
  };
  if (!name) return <span className="px-1.5 text-[13px] font-medium text-faint">No project open</span>;
  if (editing)
    return (
      <input
        ref={input}
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        title={problem ?? 'Enter saves, Escape cancels'}
        className={cx('no-drag w-[260px] rounded-lg bg-surface2 px-2 py-1 text-[13px] font-medium text-text ring-1 outline-none', problem ? 'ring-bad/60' : 'ring-accent/50')}
      />
    );
  return (
    <div className="no-drag group flex min-w-0 items-center">
      <button onClick={() => navigate('dashboard')} title="Dashboard" className="max-w-[280px] truncate rounded-lg px-1.5 py-1 text-[13px] font-medium text-text transition-colors hover:bg-white/5">
        {name}
      </button>
      <button
        onClick={() => {
          setText(name);
          setProblem(null);
          setEditing(true);
        }}
        title="Rename the project"
        aria-label="Rename the project"
        className="flex h-6 w-6 items-center justify-center rounded-md text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/5 hover:text-text focus:opacity-100"
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

/**
 * Pause (running agents finish, nothing new starts) — now, for a while, or until the account's 5-hour
 * window resets — then resume, or stop now (interrupt running agents).
 */
function WorkControl({ state }: { state: OrchestratorState }) {
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useDismiss(menu, () => setMenu(false));
  const usage = useRpc<{ fiveHourResetsAt: number | null; windows: Record<string, UsageWindow> }>(menu ? 'usage.current' : null, undefined, ['usage.observed', 'usage.changed']);
  const act = (method: string, params?: Record<string, unknown>) => {
    setPending(true);
    setMenu(false);
    setError(null);
    window.shuriken.journal('work.control', { action: method.replace('orchestrator.', ''), ...(params ?? {}) });
    void rpc(method, params)
      .catch((e: Error) => setError(e.message.replace(/^Error invoking remote method 'rpc': Error: /, '')))
      .finally(() => setPending(false));
  };
  const pill = 'flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium ring-1 transition-colors disabled:opacity-40';
  if (state.paused) {
    return (
      <div className="flex items-center gap-1">
        <button disabled={pending} onClick={() => act('orchestrator.resume')} title="Continue the plan now" className={cx(pill, 'bg-accent/15 text-accent2 ring-accent/40 hover:bg-accent/25')}>
          <Play size={11} fill="currentColor" /> Resume
        </button>
        {state.activeRuns > 0 && (
          <button disabled={pending} onClick={() => act('orchestrator.stop')} title="Interrupt the agents still running. Their tasks pick up where they left off when you resume." className={cx(pill, 'text-dim ring-line hover:bg-white/5 hover:text-text')}>
            <Square size={10} fill="currentColor" /> Stop now
          </button>
        )}
      </div>
    );
  }
  if (state.activeRuns === 0 && state.queued === 0) return null;
  const reset = usage.data?.fiveHourResetsAt ?? null;
  const used = usage.data ? limitingUsage(usage.data.windows, Date.now()) : null;
  return (
    <div ref={ref} className="relative flex items-center">
      <button disabled={pending} onClick={() => act('orchestrator.pause')} title="Running agents finish their current task; nothing new starts until you resume" className={cx(pill, 'rounded-r-none text-dim ring-line hover:bg-white/5 hover:text-text')}>
        <Pause size={11} fill="currentColor" /> Pause
      </button>
      <button disabled={pending} onClick={() => setMenu((m) => !m)} title="Pause for a while" className={cx(pill, '-ml-px rounded-l-none px-1 text-dim ring-line hover:bg-white/5 hover:text-text')}>
        <ChevronDown size={12} />
      </button>
      {error && <span className="ml-2 max-w-[260px] truncate text-[11px] text-bad" title={error}>{error}</span>}
      <Popover open={menu} width={300}>
        <div className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">Pause, then resume by itself</div>
        {[30, 60, 120].map((m) => (
          <button key={m} className={menuItem} onClick={() => act('orchestrator.pauseUntil', { minutes: m })}>
            <Clock3 size={13} className="text-faint" /> For {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}
            <span className="ml-auto text-[11px] text-faint">{clock(Date.now() + m * 60_000)}</span>
          </button>
        ))}
        <button className={menuItem} disabled={!reset} onClick={() => act('orchestrator.pauseUntil', { untilReset: true })} title={reset ? undefined : 'Known after the first agent run on this account'}>
          <Clock3 size={13} className="text-faint" /> Until my 5-hour limit resets
          <span className="ml-auto text-[11px] text-faint">{reset ? clock(reset) : 'not known yet'}</span>
        </button>
        {used && used.percent > 0 && (
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint">
            This account has used about {used.percent}% of its {used.name}.
          </div>
        )}
      </Popover>
    </div>
  );
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');

/**
 * What this build has cost at API prices (core/costs/build-cost.ts): every agent run, Kiln's models and the small
 * calls. Opens the breakdown by kind of work and by goal. Read again when a run or a Kiln build changes.
 */
function CostChip() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const cost = useRpc<BuildCost | null>('costs.build', undefined, ['run.updated', 'kiln.builds']);
  const c = cost.data;
  if (!c) return null;
  const top = Math.max(...c.categories.map((x) => x.usd), 0.0001);
  const goals = c.goals.filter((g) => g.usd >= 0.005);
  const inGoals = goals.reduce((a, g) => a + g.usd, 0);
  const outside = c.totalUsd - inGoals;
  const span = c.since ? (day(c.since) === day(c.until) ? day(c.since) : `${day(c.since)} – ${day(c.until)}`) : '';
  return (
    <div ref={ref} className="no-drag relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="API-equivalent cost of this build"
        aria-label={`API-equivalent cost of this build: ${usdText(c.totalUsd)}`}
        className="tabular flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] whitespace-nowrap text-dim ring-1 ring-line transition-colors hover:bg-white/5 hover:text-text"
      >
        <Receipt size={13} className="text-faint" />
        {usdText(c.totalUsd)}
      </button>
      <Popover open={open} align="right" width={360}>
        <div className="max-h-[70vh] overflow-y-auto px-2.5 py-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">API-equivalent cost</span>
            {span && <span className="text-[11px] text-faint">{span}</span>}
          </div>
          <div className="tabular mt-1 text-[22px] leading-tight font-medium text-text">{usdText(c.totalUsd)}</div>
          {c.categories.length > 0 ? (
            <div className="mt-3 space-y-2">
              {c.categories.map((x) => (
                <div key={x.id} title={`${x.runs} ${x.id === 'helpers' ? 'call' : 'run'}${x.runs === 1 ? '' : 's'}`}>
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="truncate text-dim">{x.label}</span>
                    <span className="tabular shrink-0 text-text">{usdText(x.usd)}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round((x.usd / top) * 100))}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-[12px] text-faint">Nothing has run in this project yet.</div>
          )}
          {goals.length > 0 && (
            <>
              <div className="mt-4 mb-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">By goal</div>
              <div className="space-y-1">
                {goals.map((g) => (
                  <div key={g.id} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className={cx('truncate', g.status === 'done' ? 'text-dim' : 'text-text')} title={`${g.title}${g.status === 'done' ? ' (finished)' : ''}`}>
                      {g.status === 'done' && <Check size={11} className="mr-1 inline text-ok" />}
                      {g.title}
                    </span>
                    <span className="tabular shrink-0 text-dim">{usdText(g.usd)}</span>
                  </div>
                ))}
                {outside >= 0.005 && (
                  <div className="flex items-baseline justify-between gap-3 text-[12px]" title="The director's chat, copilots, research and small helpers that worked for no one goal">
                    <span className="truncate text-faint">Outside any goal</span>
                    <span className="tabular shrink-0 text-faint">{usdText(outside)}</span>
                  </div>
                )}
              </div>
            </>
          )}
          <div className="mt-3 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">{COST_NOTE}</div>
        </div>
      </Popover>
    </div>
  );
}

/**
 * The Claude account new work uses. Switching is graceful: agents already running finish on the account
 * they started with (each run keeps its own sign-in); only new work moves to the chosen account.
 */
function AccountMenu({ info, reload }: { info: AccountsInfo; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useDismiss(open, () => setOpen(false));
  const orch = useOrchestrator();
  const active = info.accounts.find((a) => a.id === info.activeId) ?? null;
  // Which window limits work now, named ("5 h 42%", "Week 100% · until Sun 9:00 AM"): a bare percent once read 100% for days.
  const now = Date.now();
  const lim = active ? limitingUsage(active.usage.windows, now) : null;
  const pill = !active
    ? null
    : active.usage.blocked && !lim?.atLimit
      ? `at limit${active.usage.blockedUntil ? ` · until ${clockText(active.usage.blockedUntil, now)}` : ''}`
      : lim && lim.percent > 0
        ? lim.text
        : null;
  const lines = active ? formatAccountUsage(active.usage.windows, now) : null;
  const fallback = info.accounts.find((a) => a.id === info.defaultId) ?? null;
  // This menu chooses for this window only (null: follow the default that Settings sets).
  const choose = async (id: string | null) => {
    const from = active?.label ?? null;
    const to = (id ? info.accounts.find((a) => a.id === id)?.label : fallback?.label) ?? 'that account';
    await rpc('accounts.setActive', { id });
    window.shuriken.journal('account.switch', { from, to });
    reload();
    const running = orch.data?.activeRuns ?? 0;
    setNote(running > 0 && from ? `New work in this window uses ${to}. ${running} running agent${running === 1 ? '' : 's'} finish${running === 1 ? 'es' : ''} on ${from}.` : `New work in this window uses ${to}.`);
    window.setTimeout(() => setNote(null), 6000);
  };
  return (
    <div ref={ref} className="no-drag relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={['Claude account for new work', lines?.fiveHour.text, lines?.weekly?.text].filter(Boolean).join('\n')}
        className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12px] whitespace-nowrap text-dim ring-1 ring-line transition-colors hover:bg-white/5 hover:text-text"
      >
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', !active ? 'bg-faint' : active.usage.blocked || lim?.atLimit ? 'bg-bad' : (lim?.percent ?? 0) > 85 ? 'bg-warn' : 'bg-ok')} />
        {active ? active.label : "This PC's Claude login"}
        {pill && <span className="tabular text-faint">{pill}</span>}
        <ChevronDown size={12} className="opacity-60" />
      </button>
      {note && <div className="card absolute top-10 right-0 z-50 w-[280px] px-3 py-2 text-[12px] leading-relaxed text-dim">{note}</div>}
      <Popover open={open} align="right" width={360}>
        <div className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">Claude account for this window</div>
        <button className={accountItem} onClick={() => void choose(null).finally(() => setOpen(false))} title="Use the default account that Settings sets">
          <span className="flex h-[18px] w-4 items-center justify-center">{!info.windowId && <Check size={13} className="text-accent2" />}</span>
          <span className="min-w-0 flex-1">Same as Settings{fallback ? ` (${fallback.label})` : ''}</span>
        </button>
        {info.accounts.map((a) => {
          const u = limitingUsage(a.usage.windows, Date.now());
          // This account's own windows (its usage key is its own), read at the time the menu draws.
          const shown = formatAccountUsage(a.usage.windows, Date.now());
          return (
            <button key={a.id} className={accountItem} disabled={!a.signedIn || a.eligible === false} onClick={() => void choose(a.id).finally(() => setOpen(false))} title={!a.signedIn ? 'Sign in to this account in Settings first' : a.eligible === false ? 'Same subscription as an account you added' : undefined}>
              <span className="flex h-[18px] w-4 items-center justify-center">{a.id === info.windowId && <Check size={13} className="text-accent2" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block">
                  {a.label}
                  {a.plan && <span className="ml-1.5 text-[11px] text-faint">{a.plan}</span>}
                </span>
                <span className="tabular mt-0.5 block text-[11px] leading-snug text-faint" title={shown.fiveHour.known ? undefined : NO_READING_HINT}>
                  {shown.fiveHour.text}
                </span>
                {shown.weekly && <span className="tabular block text-[11px] leading-snug text-faint">{shown.weekly.text}</span>}
              </span>
              <span className="text-[11px] leading-[18px] text-faint">{!a.signedIn ? 'not signed in' : a.usage.blocked ? `at limit${a.usage.blockedUntil ? ` · ${clockText(a.usage.blockedUntil, Date.now())}` : ''}` : u && u.percent > 0 ? `${u.label} ${u.percent}%` : ''}</span>
            </button>
          );
        })}
        <div className="px-2.5 pt-1 pb-1.5 text-[11px] leading-relaxed text-faint">This window only; Settings sets the default for the others. Switching never interrupts anything: agents already running finish on the account they started with.</div>
        <button className={cx(menuItem, 'text-dim')} onClick={() => navigate('settings', 'accounts')}>
          Manage accounts…
        </button>
      </Popover>
    </div>
  );
}
