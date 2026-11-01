import { useMemo, type ReactNode } from 'react';
import { CircleCheck, CircleDashed, CircleX, ListChecks } from 'lucide-react';
import type { Escalation, TestCase } from '@shared/domain';
import { useRpc } from '../lib/rpc';
import { useTasks } from '../lib/project';
import { navigate } from '../lib/nav';
import { decisionRows } from '../lib/decisions';
import { qualitySummary, testsLine } from '../lib/quality';
import { cx, timeAgo } from '../components/ui';

function Section({ title, count, tone, onOpen, children }: { title: string; count?: number; tone?: string; onOpen?: () => void; children: ReactNode }) {
  return (
    <section>
      <button disabled={!onOpen} onClick={onOpen} className="mb-1 flex w-full items-center justify-between text-[11px] font-semibold tracking-[0.12em] text-faint uppercase enabled:hover:text-dim">
        <span>{title}</span>
        {count !== undefined && <span className={cx('tabular-nums normal-case tracking-normal', tone)}>{count}</span>}
      </button>
      {children}
    </section>
  );
}

function Row({ icon, text, meta, title, onClick }: { icon: ReactNode; text: string; meta?: string; title?: string; onClick?: () => void }) {
  return (
    <button disabled={!onClick} onClick={onClick} title={title ?? text} className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] text-dim enabled:hover:bg-white/4 enabled:hover:text-text">
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {meta && <span className="shrink-0 text-[10.5px] text-faint">{meta}</span>}
    </button>
  );
}

/**
 * What to check after an overnight build, in one place: the game's tests (failing first; tests show
 * nowhere else), the finished tasks nobody has looked at because Studio wasn't drawing ("visual check
 * pending"), and what was decided without asking. Each line opens its task, or the decisions, on the
 * Agents page.
 */
export function QualityMini({ expanded = false }: { expanded?: boolean }) {
  const tests = useRpc<TestCase[]>('tests.list', {}, ['task.updated', 'run.updated']);
  const tasks = useTasks();
  const decided = useRpc<Escalation[]>('escalations.list', { status: 'auto_resolved' }, ['escalation.updated']);
  const q = useMemo(() => qualitySummary(tests.data ?? [], tasks.data ?? []), [tests.data, tasks.data]);
  const decisions = useMemo(() => decisionRows(decided.data ?? [], tasks.data ?? [], []), [decided.data, tasks.data]);
  const n = expanded ? 30 : 3;
  const openTask = (id: string | null) => (id ? () => navigate('agents', `task:${id}`) : undefined);
  const failingCount = q.failing.reduce((k, f) => k + f.copies, 0);
  const nothingYet = !tests.data?.length && !q.unseen.length && !decisions.length;

  if (nothingYet)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[12px] leading-snug text-faint">
        <ListChecks size={18} className="opacity-60" />
        {tests.data ? 'The game’s tests, unseen work and the decisions taken for you appear here as the team works.' : 'Loading…'}
      </div>
    );

  return (
    <div className={cx('h-full space-y-3.5 overflow-y-auto px-3 py-2.5', expanded && 'mx-auto max-w-3xl px-6 py-5')}>
      <Section title="Tests">
        <div className={cx('mb-1 text-[12px]', failingCount ? 'text-bad' : q.passing ? 'text-ok' : 'text-faint')} title={q.retired ? `${q.retired} retired test${q.retired === 1 ? '' : 's'} not counted` : undefined}>
          {testsLine(q)}
        </div>
        {q.failing.slice(0, n).map((f) => (
          <Row
            key={f.label}
            icon={<CircleX size={12} className="shrink-0 text-bad" />}
            text={f.label}
            meta={[f.copies > 1 ? `×${f.copies}` : '', f.lastRunAt ? timeAgo(f.lastRunAt) : ''].filter(Boolean).join(' · ')}
            title={`${f.label}: failed its last run${f.taskId ? '\n\nOpen its task on the Agents page' : ''}`}
            onClick={openTask(f.taskId)}
          />
        ))}
        {q.failing.length > n && <div className="px-1 text-[11px] text-faint">+{q.failing.length - n} more</div>}
      </Section>

      <Section title="Not looked at" count={q.unseen.length} tone={q.unseen.length ? 'text-warn' : undefined}>
        {q.unseen.length === 0 ? (
          <Row icon={<CircleCheck size={12} className="shrink-0 text-ok" />} text="All finished work was seen" title="Every finished task had its looks checked in Studio" />
        ) : (
          q.unseen.slice(0, n).map((t) => (
            <Row
              key={t.id}
              icon={<CircleDashed size={12} className="shrink-0 text-warn" />}
              text={t.title}
              meta={t.completedAt ? timeAgo(t.completedAt) : undefined}
              title={`${t.title}\n\nPassed its checks while Studio wasn't drawing: nobody has seen it yet. Its looks are reviewed when Studio can draw again.`}
              onClick={openTask(t.id)}
            />
          ))
        )}
        {q.unseen.length > n && <div className="px-1 text-[11px] text-faint">+{q.unseen.length - n} more</div>}
      </Section>

      <Section title="Decided without asking" count={decisions.length} onOpen={() => navigate('agents', 'decisions')}>
        {decisions.length === 0 ? (
          <div className="px-1 text-[12px] text-faint">Nothing yet</div>
        ) : (
          decisions.slice(0, n).map((d) => (
            <Row
              key={d.id}
              icon={<ListChecks size={12} className="shrink-0 text-accent2" />}
              text={`${d.question} → ${d.decided}`}
              meta={timeAgo(d.at)}
              title={`${d.kindLabel}: ${d.question}\n${d.decided}${d.taskTitle ? `\n\nTask: ${d.taskTitle}` : ''}`}
              onClick={() => navigate('agents', 'decisions')}
            />
          ))
        )}
      </Section>
    </div>
  );
}
