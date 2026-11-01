import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ProjectContext } from './project-service';

/**
 * Housekeeping on long builds: the window slowed down as a project's history grew (a three-day build had 742 runs,
 * 44,600 transcript lines, 20,000 tool calls and 337 director messages, most of them status lines), and none of it was
 * ever cleared. What only the history needs leaves the project database for an archive file next to it:
 *   - the full transcripts (every step) of runs whose task is done or cancelled, older than a day and not among the
 *     newest runs; their tool calls keep their rows (tool, status, time, files) with the inputs dropped and the
 *     results cut to their words;
 *   - status lines and plan cards of finished goals in the director's chat, older than three days and beyond the
 *     newest messages.
 * Each batch is written to .shuriken/archive (gzip, one JSON line per run or message) before anything is removed.
 * Never touched: tasks, dependencies, decisions, knowledge, the spec, tests and their results, escalations, assets,
 * evidence, and the runs themselves (cost, time, status, error, session).
 */
export const HOUSEKEEPING = { keepRuns: 50, runAgeMs: 24 * 3600_000, keepChat: 200, chatAgeMs: 3 * 24 * 3600_000, batch: 50, everyMs: 30 * 60_000 };

export interface HousekeepingResult {
  runs: number;
  messages: number;
  toolCalls: number;
  chat: number;
  archive: string | null;
}

const month = (now: number) => new Date(now).toISOString().slice(0, 7);

/** A tool result cut to its words: text kept (500 characters each), pictures dropped. */
export function compactResult(result: string | null): string | null {
  if (!result) return result;
  try {
    const v = JSON.parse(result) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (!Array.isArray(v?.content)) return JSON.stringify(String(result).slice(0, 500));
    return JSON.stringify({ ...v, content: v.content.map((c) => (c.type === 'text' ? { type: 'text', text: String(c.text ?? '').slice(0, 500) } : { type: 'text', text: `[${c.type} archived]` })), archived: true });
  } catch {
    return JSON.stringify(String(result).slice(0, 500));
  }
}

function archiveLines(p: ProjectContext, name: string, rows: unknown[]): string {
  const dir = join(p.dir, 'archive');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  // Each batch is a gzip member of its own: the file stays one valid .gz (gunzip reads the members one after another).
  appendFileSync(file, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')));
  return file;
}

/** One batch of housekeeping; call again while it returns work done (each call is short, so the core stays free). */
export function housekeep(p: ProjectContext, now = Date.now(), limits = HOUSEKEEPING): HousekeepingResult {
  const out: HousekeepingResult = { runs: 0, messages: 0, toolCalls: 0, chat: 0, archive: null };
  const cutoff = new Date(now - limits.runAgeMs).toISOString();
  const runs = p.store.all<{ id: string; task_id: string | null; role: string; started_at: string; ended_at: string }>(
    `SELECT r.id, r.task_id, r.role, r.started_at, r.ended_at FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.ended_at IS NOT NULL AND r.ended_at < ? AND r.status != 'running'
       AND (r.task_id IS NULL OR t.status IN ('done', 'cancelled'))
       AND r.id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT ?)
       AND EXISTS (SELECT 1 FROM run_messages m WHERE m.run_id = r.id)
     ORDER BY r.started_at LIMIT ?`,
    [cutoff, limits.keepRuns, limits.batch],
  );
  if (runs.length) {
    const ids = runs.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const messages = p.store.all<{ run_id: string; seq: number; kind: string; content: string; created_at: string }>(`SELECT run_id, seq, kind, content, created_at FROM run_messages WHERE run_id IN (${marks}) ORDER BY run_id, seq`, ids);
    const calls = p.store.all<{ id: string; run_id: string; tool: string; args: string | null; result: string | null }>(`SELECT id, run_id, tool, args, result FROM tool_calls WHERE run_id IN (${marks}) AND (args IS NOT NULL OR result IS NOT NULL)`, ids);
    const archive = archiveLines(
      p,
      `transcripts-${month(now)}.jsonl.gz`,
      runs.map((r) => ({ run: r, archivedAt: new Date(now).toISOString(), messages: messages.filter((m) => m.run_id === r.id), toolCalls: calls.filter((c) => c.run_id === r.id) })),
    );
    p.store.tx(() => {
      p.store.run(`DELETE FROM run_messages WHERE run_id IN (${marks})`, ids);
      for (const c of calls) p.store.run('UPDATE tool_calls SET args = NULL, result = ? WHERE id = ?', [compactResult(c.result), c.id]);
    });
    Object.assign(out, { runs: runs.length, messages: messages.length, toolCalls: calls.length, archive });
  }
  // The director's chat: status lines, and plan cards of goals that are finished, old and beyond the newest messages.
  const chatCutoff = new Date(now - limits.chatAgeMs).toISOString();
  const old = p.store.all<{ id: string; role: string; kind: string; text: string; data: string | null; created_at: string; channel: string | null }>(
    `SELECT id, role, kind, text, data, created_at, channel FROM chat_messages c
     WHERE c.created_at < ? AND ((c.role = 'system' AND c.kind = 'status') OR c.kind = 'plan')
       AND c.id NOT IN (SELECT id FROM chat_messages c2 WHERE coalesce(c2.channel, '') = coalesce(c.channel, '') ORDER BY created_at DESC LIMIT ?)
     ORDER BY created_at LIMIT ?`,
    [chatCutoff, limits.keepChat, limits.batch * 4],
  );
  const finished = (data: string | null) => {
    try {
      const id = (JSON.parse(data ?? 'null') as { objectiveId?: string } | null)?.objectiveId;
      if (!id) return true;
      const status = p.store.get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
      return !status || status === 'done' || status === 'cancelled';
    } catch {
      return true;
    }
  };
  const chat = old.filter((m) => m.kind !== 'plan' || finished(m.data));
  if (chat.length) {
    const archive = archiveLines(p, `chat-${month(now)}.jsonl.gz`, chat);
    const ids = chat.map((m) => m.id);
    p.store.tx(() => p.store.run(`DELETE FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')})`, ids));
    out.chat = chat.length;
    out.archive ??= archive;
  }
  return out;
}

/** Housekeeping until there is nothing left to do now, yielding between batches (at most `maxBatches`). */
export async function housekeepAll(p: ProjectContext, now = Date.now(), maxBatches = 40): Promise<HousekeepingResult> {
  const total: HousekeepingResult = { runs: 0, messages: 0, toolCalls: 0, chat: 0, archive: null };
  for (let i = 0; i < maxBatches; i++) {
    const r = housekeep(p, now);
    total.runs += r.runs;
    total.messages += r.messages;
    total.toolCalls += r.toolCalls;
    total.chat += r.chat;
    total.archive ??= r.archive;
    if (!r.runs && !r.chat) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return total;
}
