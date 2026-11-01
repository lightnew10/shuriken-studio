import type { Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { readPlannerNotes } from './planner-notes';

/**
 * One planner per project, with one conversation for the whole project (1.15.8). Every planning job — the plan, the
 * user's plan updates, triage, decisions — runs one at a time (Orchestrator.tick) and continues the planner's last
 * provider session, so the planner keeps what it learned about the project (why tasks exist, what failed, what the user
 * wants) instead of rebuilding it from a 28,000-token package every time. Each job's message says what changed since the
 * planner's last turn.
 *
 * The session is a cache, never the record (CONTRIBUTING.md, rule 4): the tasks, the spec, the decisions and the planner's notes
 * (planner-notes.ts) are the truth, and a fresh run rebuilds everything from them. A new session starts when there is
 * none to continue, after an app update, after `maxAgeMs`, after `maxRuns` jobs in one conversation (the SDK compacts a
 * long one, and compaction loses detail the notes keep), or when continuing fails (Orchestrator.continueRun falls back).
 */
export const PLANNER_SESSION = { maxRuns: 25, maxAgeMs: 48 * 60 * 60 * 1000 };

interface RunRow {
  id: string;
  provider_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  provider_session_id: string | null;
  continues_run_id: string | null;
  app_version: string | null;
}

export interface PlannerSession {
  /** The run whose provider session continues. */
  runId: string;
  sessionId: string;
  /** When that run ended: what changed after it goes into the next job's message. */
  since: string;
  /** Jobs in this conversation so far. */
  length: number;
}

/** The planner's conversation to continue in this project, or null when a fresh one starts (see PLANNER_SESSION). */
export function plannerSession(p: ProjectContext, providerId: string, appVersion: string | null, now = Date.now()): PlannerSession | null {
  if (!appVersion) return null;
  const rows = p.store.all<RunRow>(
    "SELECT id, provider_id, status, started_at, ended_at, provider_session_id, continues_run_id, app_version FROM runs WHERE role = 'executive' ORDER BY started_at DESC LIMIT 80",
  );
  const last = rows.find((r) => r.status !== 'running' && r.status !== 'starting');
  if (!last?.provider_session_id || last.provider_id !== providerId || last.app_version !== appVersion) return null;
  // A run that ended in an error a resume can't fix (the session itself failed) starts the next one fresh.
  if (last.status === 'failed' && !last.ended_at) return null;
  const ended = Date.parse(last.ended_at ?? last.started_at);
  if (now - ended > PLANNER_SESSION.maxAgeMs) return null;
  let length = 1;
  for (let r: RunRow | undefined = last; r?.continues_run_id && length <= PLANNER_SESSION.maxRuns; r = rows.find((x) => x.id === r!.continues_run_id)) length++;
  if (length >= PLANNER_SESSION.maxRuns) return null;
  return { runId: last.id, sessionId: last.provider_session_id, since: last.ended_at ?? last.started_at, length };
}

/**
 * The message that opens a planning job in the planner's ongoing conversation: the job (its task, in full), the planner's
 * notes as they are now, and what changed in the project since its last turn (the user's messages, tasks finished, failed,
 * cancelled or added, cards waiting), then what to do. Short on purpose: the planner reads the rest with its tools.
 */
export function plannerBrief(p: ProjectContext, task: Task, directive: string, since: string): string {
  const parent = task.parentId ? p.tasks.get(task.parentId) : null;
  const all = p.tasks.list({});
  const changed = (pick: (t: Task) => boolean) => all.filter((t) => t.kind !== 'objective' && t.id !== task.id && t.updatedAt > since && pick(t));
  const list = (ts: Task[]) => ts.slice(0, 12).map((t) => `"${t.title.slice(0, 90)}"`).join(', ') + (ts.length > 12 ? ` and ${ts.length - 12} more` : '');
  const done = changed((t) => t.status === 'done');
  const failed = changed((t) => t.status === 'failed' || t.status === 'escalated' || t.status === 'blocked');
  const cancelled = changed((t) => t.status === 'cancelled');
  const added = all.filter((t) => t.kind !== 'objective' && t.id !== task.id && t.createdAt > since && t.status !== 'cancelled');
  const said = p.store
    .all<{ text: string; created_at: string }>("SELECT text, created_at FROM chat_messages WHERE role = 'user' AND kind = 'text' AND created_at > ? ORDER BY created_at ASC LIMIT 8", [since])
    .map((m) => `- "${m.text.replace(/\s+/g, ' ').slice(0, 1500)}"`);
  const cards = p.governance.escalations('open').map((e) => `- ${e.title.slice(0, 120)}`);
  const notes = readPlannerNotes(p);
  return [
    'A new planning job. You keep one conversation for the whole project, so what you worked out before still holds unless the project changed. The project did change since your last turn (below): check task_list for the current plan before you add anything.',
    '',
    `## The job: ${task.title}`,
    parent ? `Goal: ${parent.title}` : '',
    task.objective,
    task.acceptanceCriteria.length ? `Done when: ${task.acceptanceCriteria.join('; ')}` : '',
    '',
    `## Your notes (planner_notes; the user's standing instructions are in them)`,
    notes || '(none yet)',
    '',
    '## Since your last turn',
    said.length ? `The user wrote:\n${said.join('\n')}` : 'The user wrote nothing new.',
    done.length ? `Finished: ${list(done)}.` : '',
    failed.length ? `Failed, blocked or waiting: ${list(failed)}.` : '',
    cancelled.length ? `Cancelled: ${list(cancelled)}.` : '',
    added.length ? `Added by others: ${list(added)}.` : '',
    cards.length ? `Cards waiting for the user:\n${cards.join('\n')}` : '',
    '',
    '## What to do',
    directive,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
