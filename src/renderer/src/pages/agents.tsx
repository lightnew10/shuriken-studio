import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, CircleMinus, CircleX, FileCode2, Image as ImageIcon, ListChecks, MonitorPlay, Square } from 'lucide-react';
import type { AgentRun, Escalation, RunMessage, Task, TaskEvidence } from '@shared/domain';
import { TopBar } from '../components/topbar';
import { PipelinePanel } from '../containers/pipeline';
import { useRoleLabels } from '../lib/roles';
import { ShurikenMark } from '../brand/logo';
import { Button, Empty, Markdown, Pill, Segmented, cx, duration, timeAgo } from '../components/ui';
import { describeTool, useRuns, useTasks } from '../lib/project';
import { autoResolved, decidedAt, decisionDays, decisionsSummary, type DecisionDay } from '../lib/decisions';
import { useRoute } from '../lib/nav';
import { rpc, useCoreEvent, useRpc } from '../lib/rpc';

interface RunDetail {
  run: AgentRun;
  messages: RunMessage[];
  changes: { files: string[]; studioWrites: Array<{ id: string; tool: string; status: string; startedAt: string }>; datamodel: { summary: string } | null };
  evidence: TaskEvidence[];
  result: unknown;
  /** Steps older than the ones sent (the page gets the newest of a long run). */
  olderSteps?: number;
}

/**
 * Who holds Studio's playtest turn right now, and a button to free it (Core.freeStudio): a playtest that is stuck keeps
 * every agent's Studio work waiting, and the user can end it from here instead of restarting the app.
 */
function StudioTurn() {
  const holder = useRpc<{ owner: string; text: string; since: number } | null>('studio.holder', undefined, ['roblox.changed', 'run.updated']);
  const [freeing, setFreeing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // The holder's clock ("since … ago") moves while it holds Studio.
  useEffect(() => {
    if (!holder.data) return;
    const t = window.setInterval(() => holder.reload(), 5000);
    return () => window.clearInterval(t);
  }, [!!holder.data]);
  const held = holder.data;
  return (
    <div className="shrink-0 px-2 pt-2.5">
      <div className="flex items-start gap-2.5 rounded-lg px-2 py-2">
        <MonitorPlay size={15} className={cx('mt-0.5 shrink-0', held ? 'text-warn' : 'text-faint')} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-text">{held ? "Studio's playtest turn" : 'Studio is free'}</div>
          <div className="text-[11px] leading-snug text-faint">{held ? held.text : (said ?? 'Nobody is playtesting.')}</div>
        </div>
        {held && (
          <Button
            size="sm"
            disabled={freeing}
            onClick={() => {
              setFreeing(true);
              void rpc<string>('studio.free')
                .then((t) => setSaid(t))
                .finally(() => {
                  setFreeing(false);
                  holder.reload();
                });
            }}
          >
            {freeing ? 'Freeing…' : 'Free Studio'}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Every agent run, readable by a person: what it was asked, the steps it took in plain words, what
 * it changed, the proof it left, and how it ended. Raw details stay one click away.
 */
export function AgentsPage({ runId }: { runId?: string }) {
  const roleLabel = useRoleLabels();
  const runs = useRuns(200);
  const tasks = useTasks();
  const [selected, setSelected] = useState<string | null>(null);
  // What the system decided without asking (autonomous mode) has its own view next to the runs.
  const decided = useRpc<Escalation[]>('escalations.list', { status: 'auto_resolved' }, ['escalation.updated']);
  const [view, setView] = useState<'runs' | 'decisions'>(runId === 'decisions' ? 'decisions' : 'runs');
  // Every navigation here (a task in the pipeline, a link) says which view it wants, even to the same run twice.
  // Only navigations to this page: the page stays mounted while it fades out, and switching to the runs view then
  // (on a link to another page's item, "Manage accounts…" say) left the fade unfinished and the window blank.
  const route = useRoute();
  useEffect(() => {
    if (route.page === 'agents' && route.id) setView(route.id === 'decisions' ? 'decisions' : 'runs');
  }, [route.seq]);

  // The run a link asked for is selected once per navigation: the list refreshes with every run update, and
  // re-selecting then took the user back from whatever run they had clicked since. A task that has no run (yet)
  // says so instead of showing another task's run.
  const [noRunFor, setNoRunFor] = useState<string | null>(null);
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (runId && runId !== 'decisions' && route.page === 'agents' && applied.current !== route.seq) {
      if (runId.startsWith('task:')) {
        if (!runs.data) return;
        const taskId = runId.slice(5);
        const r = runs.data.find((x) => x.taskId === taskId);
        setSelected(r?.id ?? null);
        setNoRunFor(r ? null : taskId);
      } else {
        setSelected(runId);
        setNoRunFor(null);
      }
      applied.current = route.seq;
      return;
    }
    // Nothing asked for: the run working now, else the newest.
    if (!selected && !noRunFor && runs.data?.length) setSelected(runs.data.find((r) => r.status === 'running')?.id ?? runs.data[0]!.id);
  }, [runId, runs.data, route.seq, selected, noRunFor]);

  const taskById = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
  const latestDecision = autoResolved(decided.data ?? [])[0];

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Agents" back />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[360px] shrink-0 flex-col border-r border-line">
          {(tasks.data ?? []).length > 0 && (
            <div className="max-h-[45%] shrink-0 border-b border-line">
              <PipelinePanel dense />
            </div>
          )}
          <StudioTurn />
          <div className="shrink-0 px-2 pt-2.5">
            <button onClick={() => setView('decisions')} className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors', view === 'decisions' ? 'bg-accent/12' : 'hover:bg-white/4')}>
              <ListChecks size={15} className="shrink-0 text-accent2" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-text">Decided without asking</div>
                <div className="truncate text-[11px] text-faint">
                  {decisionsSummary(decided.data ?? [])}
                  {latestDecision ? ` · ${timeAgo(decidedAt(latestDecision))}` : ''}
                </div>
              </div>
              <ChevronRight size={14} className="text-faint" />
            </button>
          </div>
          <div className="px-3.5 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">All runs</div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {(runs.data ?? []).map((r) => {
              const t = r.taskId ? taskById.get(r.taskId) : undefined;
              const running = r.status === 'running' || r.status === 'starting';
              return (
                <button
                  key={r.id}
                  onClick={() => {
                    setSelected(r.id);
                    setNoRunFor(null);
                    setView('runs');
                  }}
                  className={cx('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors', selected === r.id && view === 'runs' ? 'bg-accent/12' : 'hover:bg-white/4')}
                >
                  {running ? (
                    <ShurikenMark size={16} active />
                  ) : r.status === 'completed' ? (
                    <CheckCircle2 size={15} className="shrink-0 text-ok" />
                  ) : r.status === 'failed' ? (
                    <CircleX size={15} className="shrink-0 text-bad/80" />
                  ) : (
                    <CircleMinus size={15} className="shrink-0 text-faint" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-text">{t?.title ?? (r.role === 'director' || r.role.startsWith('copilot-') ? 'Chat reply' : roleLabel(r.role))}</div>
                    <div className="truncate text-[11px] text-faint">
                      {roleLabel(r.role)} · {timeAgo(r.startedAt)}
                    </div>
                  </div>
                  <ChevronRight size={14} className="text-faint" />
                </button>
              );
            })}
            {runs.data?.length === 0 && <Empty>No agent has run yet.</Empty>}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {view === 'decisions' ? (
            <DecisionsView
              days={decisionDays(decided.data ?? [], tasks.data ?? [], runs.data ?? [], Date.now())}
              onOpenRun={(id) => {
                setSelected(id);
                setNoRunFor(null);
                setView('runs');
              }}
            />
          ) : noRunFor ? (
            <Empty>{`No agent has worked on “${taskById.get(noRunFor)?.title ?? 'this task'}” yet${runs.data && runs.data.length >= 200 ? ', or its runs are older than the 200 listed here' : ''}.`}</Empty>
          ) : selected ? (
            <RunView id={selected} task={undefined} taskById={taskById} />
          ) : (
            <Empty>{runs.data?.length ? 'Select a run.' : 'Tell the director what to build: every agent shows up here with each step it takes, what it changed and its proof.'}</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the planner and director settled for the user instead of asking, newest first, with the task each belongs to. */
function DecisionsView({ days, onOpenRun }: { days: DecisionDay[]; onOpenRun: (runId: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <div className="text-[15px] font-semibold text-text">Decided without asking</div>
        <div className="mt-0.5 text-[12px] text-faint">What the planner and director settled for you instead of asking, newest first.</div>
      </div>
      {days.length === 0 ? (
        <div className="min-h-0 flex-1">
          <Empty>Nothing has been decided for you yet.</Empty>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {days.map((day) => (
            <section key={day.key} className="mb-6">
              <div className="mb-2 flex items-center justify-between text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
                <span>{day.label}</span>
                <span className="tabular normal-case tracking-normal">{day.rows.length}</span>
              </div>
              <div className="space-y-2.5">
                {day.rows.map((r) => (
                  <div key={r.id} className="card px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Pill>{r.kindLabel}</Pill>
                      <span className="tabular text-[11.5px] text-faint">{r.time}</span>
                      <div className="flex-1" />
                      {r.detail && (
                        <button onClick={() => setOpen(open === r.id ? null : r.id)} className="text-[11.5px] text-faint transition-colors hover:text-dim">
                          {open === r.id ? 'Hide details' : 'Details'}
                        </button>
                      )}
                    </div>
                    <div className="mt-1.5 text-[13px] font-medium text-text">{r.question}</div>
                    <div className="mt-1 text-[12.5px] leading-relaxed text-dim">
                      <span className="text-faint">Decided: </span>
                      {r.decided}
                    </div>
                    {r.taskTitle &&
                      (r.runId ? (
                        <button onClick={() => onOpenRun(r.runId!)} className="mt-2 max-w-full truncate text-left text-[11.5px] text-accent2 hover:underline">
                          Task: {r.taskTitle}
                        </button>
                      ) : (
                        <div className="mt-2 truncate text-[11.5px] text-faint">Task: {r.taskTitle}</div>
                      ))}
                    {open === r.id && <pre className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-bg2 px-3 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-dim">{r.detail.slice(0, 3000)}</pre>}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function RunView({ id, taskById }: { id: string; task?: Task; taskById: Map<string, Task> }) {
  const roleLabel = useRoleLabels();
  const d = useRpc<RunDetail | null>('runs.get', { id, lean: true }, ['run.updated'], [id]);
  const [tab, setTab] = useState<'steps' | 'changes' | 'raw'>('steps');
  // A working run's steps come in as it works: run.updated only fires when a run starts or ends.
  const pending = useRef(0);
  useCoreEvent(['run.stream'], (_c, p) => {
    if ((p as { runId?: string }).runId !== id || pending.current) return;
    pending.current = window.setTimeout(() => {
      pending.current = 0;
      d.reload();
    }, 1500);
  });
  useEffect(() => () => window.clearTimeout(pending.current), []);
  // Another run's details stay until this one's arrive: show it loading rather than under this run's name.
  if (!d.data || d.data.run.id !== id) return <Empty>Loading…</Empty>;
  const { run, messages, changes, evidence } = d.data;
  const task = run.taskId ? taskById.get(run.taskId) : undefined;
  const running = run.status === 'running' || run.status === 'starting';
  const ms = (run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt);
  const steps = messages.filter((m) => m.kind === 'tool_use' || m.kind === 'text');
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <div className="flex items-start gap-3">
          <ShurikenMark size={28} active={running} muted={!running && run.status !== 'completed'} />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-text">{task?.title ?? roleLabel(run.role)}</div>
            <div className="mt-0.5 text-[12px] text-faint">
              {roleLabel(run.role)} · {run.model ?? '—'} · {duration(ms)} · {run.numTurns} steps{run.continuesRunId ? ' · carried on from its earlier session' : ''}
            </div>
          </div>
          <Pill tone={running ? 'accent' : run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'bad' : 'neutral'}>{running ? 'Working' : (RUN_STATUS[run.status] ?? run.status)}</Pill>
          {running && (
            <Button size="sm" kind="danger" icon={<Square size={11} />} onClick={() => void rpc('runs.interrupt', { id })}>
              Stop
            </Button>
          )}
        </div>
        {task && <div className="mt-3 line-clamp-3 max-w-3xl text-[12.5px] leading-relaxed text-dim">{task.objective}</div>}
        <div className="mt-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'steps', label: 'Steps' },
              { value: 'changes', label: `Changes & proof (${changes.files.length + evidence.length})` },
              { value: 'raw', label: 'Details' },
            ]}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === 'steps' && !!d.data.olderSteps && <div className="mb-2 text-[12px] text-faint">{d.data.olderSteps} earlier step{d.data.olderSteps === 1 ? '' : 's'} not shown: this is a long run (its full record stays in the project).</div>}
        {tab === 'steps' && (
          <ol className="relative space-y-2 border-l border-line pl-5">
            {steps.map((m) => (
              <li key={m.id} className="relative">
                <span className="absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full bg-surface3 ring-2 ring-bg" />
                {m.kind === 'tool_use' ? (
                  <div className="text-[13px] text-text">{describeTool(`${(m.content as { tool: string }).tool} ${JSON.stringify((m.content as { input: unknown }).input ?? '').slice(0, 300)}`)}</div>
                ) : (
                  <div className="rounded-xl bg-surface2 px-3.5 py-2.5 text-[13px] text-dim ring-1 ring-line">
                    {isPayload(String(m.content)) ? <span className="text-faint">Its result, as data for the app (Details has it in full).</span> : <Markdown text={clip(String(m.content), 2000)} />}
                  </div>
                )}
              </li>
            ))}
            {running && (
              <li className="relative flex items-center gap-2 text-[12.5px] text-accent2">
                <span className="absolute top-1.5 -left-[25px] h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
                Working…
              </li>
            )}
            {!running && run.resultSummary && (
              <li className="relative">
                <span className="absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full bg-ok" />
                <div className="rounded-xl bg-ok/6 px-3.5 py-2.5 text-[13px] text-text ring-1 ring-ok/20">
                  {summaryText(run.resultSummary) === null ? <span className="text-dim">Its result, as data for the app (Details has it in full).</span> : <Markdown text={summaryText(run.resultSummary)!} />}
                </div>
              </li>
            )}
            {run.error && <li className="text-[13px] text-bad">{run.error}</li>}
          </ol>
        )}
        {tab === 'changes' && (
          <div className="space-y-5">
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Files changed</div>
              {changes.files.length === 0 && <div className="text-[12.5px] text-faint">None.</div>}
              {changes.files.map((f) => (
                <div key={f} className="flex items-center gap-2 py-0.5 font-mono text-[12px] text-dim">
                  <FileCode2 size={13} className="text-faint" /> {f}
                </div>
              ))}
            </div>
            {changes.datamodel && (
              <div>
                <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">World changes</div>
                <div className="text-[12.5px] text-dim">{changes.datamodel.summary}</div>
              </div>
            )}
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Proof</div>
              {evidence.length === 0 && <div className="text-[12.5px] text-faint">No evidence recorded on this run.</div>}
              <div className="grid grid-cols-2 gap-3">
                {evidence.map((e) => (
                  <EvidenceCard key={e.id} e={e} />
                ))}
              </div>
            </div>
          </div>
        )}
        {tab === 'raw' && (
          <pre className="text-[11.5px] leading-relaxed whitespace-pre-wrap text-dim">{JSON.stringify({ run: d.data.run, result: d.data.result }, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

/** A run's outcome in words (the pill on a finished run). */
const RUN_STATUS: Record<string, string> = { completed: 'Done', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', starting: 'Starting' };

/** A step's text that is a JSON result for the app (suggestion bubbles, a structured output), not words for a person. */
const isPayload = (s: string): boolean => {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    // Cut off by the store: still data when it reads like a JSON object or list.
    return /^[[{]\s*"/.test(t);
  }
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** A run's result summary in words: a JSON result shows the reply it carries (a copilot's), else null (nothing to read). */
const summaryText = (s: string): string | null => {
  if (!isPayload(s)) return s;
  try {
    const o = JSON.parse(s.trim()) as Record<string, unknown>;
    for (const k of ['copilotReply', 'reply', 'summary']) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  } catch {
    // Cut off: no reply to show.
  }
  return null;
};

function EvidenceCard({ e }: { e: TaskEvidence }) {
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    if (e.path && /\.(png|jpe?g|webp)$/i.test(e.path)) void window.shuriken.readImage(e.path).then(setImg);
  }, [e.path]);
  return (
    <div className="card overflow-hidden">
      {img && <img src={img} alt="" className="aspect-video w-full object-cover" />}
      <div className="flex items-start gap-2 px-3 py-2.5">
        {img ? <ImageIcon size={14} className="mt-0.5 shrink-0 text-faint" /> : e.passed === false ? <CircleX size={14} className="mt-0.5 shrink-0 text-bad" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />}
        <div className="min-w-0 text-[12px] leading-snug text-dim">{e.title}</div>
      </div>
    </div>
  );
}
