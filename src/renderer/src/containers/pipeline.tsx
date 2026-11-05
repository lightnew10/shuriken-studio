import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play } from 'lucide-react';
import type { AgentRun, Task } from '@shared/domain';
import { useLiveActivity, useOrchestrator, useRuns, useTasks } from '../lib/project';
import { finalReviewCard } from '../lib/pipeline';
import { navigate } from '../lib/nav';
import { ShurikenMark } from '../brand/logo';
import { duration } from '../components/ui';
import { useRoleLabels } from '../lib/roles';
import { rpc } from '../lib/rpc';

const ACTIVE = new Set(['running', 'implemented', 'verifying', 'reviewing']);
const STAGE: Record<string, string> = { running: 'Building', implemented: 'Built', verifying: 'Testing', reviewing: 'In review' };

/** The orchestration at a glance: who is working on what right now, what is next, what is done. */
export function PipelinePanel({ dense = false }: { dense?: boolean }) {
  const roleLabel = useRoleLabels();
  const tasks = useTasks();
  const runs = useRuns(80);
  const live = useLiveActivity();
  const orchestrator = useOrchestrator();
  const [, tick] = useState(0);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  async function changeTask(id: string, action: 'pause' | 'resume'): Promise<void> {
    if (pending.has(id)) return;
    setPending((before) => new Set(before).add(id));
    setActionError(null);
    try {
      await rpc(action === 'pause' ? 'tasks.pause' : 'tasks.resume', { id });
      tasks.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending((before) => {
        const next = new Set(before);
        next.delete(id);
        return next;
      });
    }
  }
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const { working, next, done, failed } = useMemo(() => {
    const all = (tasks.data ?? []).filter((t) => t.kind !== 'objective' && t.status !== 'proposed' && t.status !== 'cancelled');
    return {
      working: all.filter((t) => ACTIVE.has(t.status)),
      // Paused tasks stay visible even when the queue contains dozens of ready tasks.
      next: all.filter((t) => t.status === 'ready' || t.status === 'paused').sort((a, b) => Number(b.status === 'paused') - Number(a.status === 'paused')),
      done: all.filter((t) => t.status === 'done' || t.status === 'verified'),
      failed: all.filter((t) => t.status === 'failed' || t.status === 'escalated' || t.status === 'blocked'),
    };
  }, [tasks.data]);

  // A goal's final review (its regression suite) has no agent run: it gets a card of its own while it runs.
  const review = finalReviewCard(orchestrator.data?.finalCheck);

  const runFor = (t: Task): AgentRun | undefined => (runs.data ?? []).find((r) => r.taskId === t.id && (r.status === 'running' || r.status === 'starting')) ?? (runs.data ?? []).find((r) => r.taskId === t.id);

  if ((tasks.data ?? []).length === 0) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-faint">Agents appear here as soon as the plan has tasks.</div>;
  }

  return (
    <div className="h-full space-y-4 overflow-y-auto px-3.5 py-3">
      <section>
        <div className="mb-2 flex items-center justify-between text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
          <span>Working now</span>
          <span className="tabular normal-case tracking-normal">{working.length + (review ? 1 : 0)}</span>
        </div>
        {working.length === 0 && !review && <div className="text-[12px] text-faint">Nobody is working right now.</div>}
        {actionError && <div role="alert" className="mb-2 rounded-md border border-warn/40 px-2 py-1.5 text-[12px] text-warn">{actionError}</div>}
        <div className="space-y-1.5">
          {review && (
            <motion.button
              layout
              key={`final:${review.objectiveId}`}
              onClick={() => navigate('agents', `task:${review.objectiveId}`)}
              className="flex w-full items-center gap-3 rounded-xl bg-surface2 px-3 py-2.5 text-left ring-1 ring-accent/40 transition-colors hover:ring-accent/60"
            >
              <ShurikenMark size={22} active />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-text">{review.title}</div>
                <div className="truncate text-[11.5px] text-dim">
                  <span className="text-accent2">{review.role}</span> · {review.action}
                  {review.studioMs !== null ? ` · in Studio ${duration(review.studioMs)}` : ''}
                </div>
              </div>
              {!dense && <span className="tabular shrink-0 text-[11px] text-faint">{duration(review.elapsedMs)}</span>}
            </motion.button>
          )}
          {working.map((t) => {
            const run = runFor(t);
            const act = run ? live[run.id] : undefined;
            const since = t.startedAt ? Date.now() - Date.parse(t.startedAt) : 0;
            return (
              <motion.div
                layout
                key={t.id}
                className="flex w-full items-center gap-1 rounded-xl bg-surface2 pr-1 ring-1 ring-line transition-colors hover:ring-accent/40"
              >
                <button
                  type="button"
                  onClick={() => navigate('agents', run ? run.id : `task:${t.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left"
                  title="Open agent activity"
                >
                  <ShurikenMark size={22} active />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text">{t.title}</div>
                    <div className="truncate text-[11.5px] text-dim">
                      <span className="text-accent2">{roleLabel(t.role)}</span> · {act?.action ?? STAGE[t.status] ?? 'Working'}
                    </div>
                  </div>
                  {!dense && <span className="tabular shrink-0 text-[11px] text-faint">{duration(since)}</span>}
                </button>
                <button
                  type="button"
                  title={pending.has(t.id) ? 'Updating…' : 'Pause this agent task'}
                  aria-label={`Pause agent: ${t.title}`}
                  disabled={pending.has(t.id)}
                  onClick={() => void changeTask(t.id, 'pause')}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-white/10 hover:text-text disabled:opacity-40"
                >
                  <Pause size={15} />
                </button>
              </motion.div>
            );
          })}
        </div>
      </section>
      {failed.length > 0 && (
        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-warn uppercase">Needs attention</div>
          {failed.map((t) => (
            <button key={t.id} onClick={() => navigate('agents', `task:${t.id}`)} className="flex w-full items-center gap-2 py-1 text-left text-[12.5px] text-dim hover:text-text">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              <span className="truncate">{t.title}</span>
            </button>
          ))}
        </section>
      )}
      <section>
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
          <span>Up next</span>
          <span className="tabular normal-case tracking-normal">{next.length}</span>
        </div>
        {next.filter((t) => t.status === 'paused').concat(next.filter((t) => t.status !== 'paused').slice(0, Math.max(0, (dense ? 3 : 6) - next.filter((t) => t.status === 'paused').length))).map((t) => (
          <div key={t.id} className="flex min-w-0 items-center gap-2 py-0.5 text-[12.5px] text-dim">
            <ShurikenMark size={14} muted />
            <button
              type="button"
              onClick={() => navigate('agents', `task:${t.id}`)}
              className="min-w-0 flex-1 truncate text-left hover:text-text"
              title={t.title}
            >{t.title}</button>
            {!dense && <span className="max-w-28 shrink-0 truncate text-[11px] text-faint">{roleLabel(t.role)}</span>}
            <button
              type="button"
              title={t.status === 'paused' ? 'Resume this agent task' : 'Pause this queued agent task'}
              aria-label={`${t.status === 'paused' ? 'Resume' : 'Pause'} agent: ${t.title}`}
              disabled={pending.has(t.id)}
              onClick={() => void changeTask(t.id, t.status === 'paused' ? 'resume' : 'pause')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-white/10 hover:text-text disabled:opacity-40"
            >{t.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}</button>
            {t.status === 'paused' && <span className="text-[10px] text-warn">Paused</span>}
          </div>
        ))}
      </section>
      <div className="text-[11.5px] text-faint">
        {done.length} done{failed.length ? ` · ${failed.length} need attention` : ''}
      </div>
    </div>
  );
}
