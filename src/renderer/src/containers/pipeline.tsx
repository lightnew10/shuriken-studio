import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { AgentRun, Task } from '@shared/domain';
import { useLiveActivity, useOrchestrator, useRuns, useTasks } from '../lib/project';
import { finalReviewCard } from '../lib/pipeline';
import { navigate } from '../lib/nav';
import { ShurikenMark } from '../brand/logo';
import { duration } from '../components/ui';
import { useRoleLabels } from '../lib/roles';

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
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const { working, next, done, failed } = useMemo(() => {
    const all = (tasks.data ?? []).filter((t) => t.kind !== 'objective' && t.status !== 'proposed' && t.status !== 'cancelled');
    return {
      working: all.filter((t) => ACTIVE.has(t.status)),
      next: all.filter((t) => t.status === 'ready' || t.status === 'paused'),
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
              <motion.button
                layout
                key={t.id}
                onClick={() => navigate('agents', run ? run.id : `task:${t.id}`)}
                className="flex w-full items-center gap-3 rounded-xl bg-surface2 px-3 py-2.5 text-left ring-1 ring-line transition-colors hover:ring-accent/40"
              >
                <ShurikenMark size={22} active />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-text">{t.title}</div>
                  <div className="truncate text-[11.5px] text-dim">
                    <span className="text-accent2">{roleLabel(t.role)}</span> · {act?.action ?? STAGE[t.status] ?? 'Working'}
                  </div>
                </div>
                {!dense && <span className="tabular shrink-0 text-[11px] text-faint">{duration(since)}</span>}
              </motion.button>
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
        {next.slice(0, dense ? 3 : 6).map((t) => (
          <div key={t.id} className="flex items-center gap-2.5 py-1 text-[12.5px] text-dim">
            <ShurikenMark size={14} muted />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="shrink-0 text-[11px] text-faint">{roleLabel(t.role)}</span>
          </div>
        ))}
      </section>
      <div className="text-[11.5px] text-faint">
        {done.length} done{failed.length ? ` · ${failed.length} need attention` : ''}
      </div>
    </div>
  );
}
