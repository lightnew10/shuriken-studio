import { newId, nowIso } from '@shared/ids';
import type { Severity, TimelineEvent, ToolCallRecord, RunMessage } from '@shared/domain';
import type { Store } from '../db/store';
import { clip, j, pj } from '../db/store';
import type { EventBus } from '../events';

interface EventRow {
  id: string;
  ts: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: string | null;
  run_id: string | null;
  task_id: string | null;
  role: string | null;
}

interface ToolCallRow {
  id: string;
  run_id: string | null;
  task_id: string | null;
  role: string | null;
  provider_id: string | null;
  source: ToolCallRecord['source'];
  tool: string;
  capability: string | null;
  args: string | null;
  result: string | null;
  status: ToolCallRecord['status'];
  error: string | null;
  duration_ms: number | null;
  started_at: string;
  files_changed: string;
}

export interface TimelineInput {
  kind: string;
  title: string;
  severity?: Severity;
  detail?: unknown;
  runId?: string | null;
  taskId?: string | null;
  role?: string | null;
}

/**
 * Persistent execution history: the timeline (meaningful events), tool-call audit records and
 * normalized run transcripts. Everything the user can inspect about "what happened and why".
 */
export class AuditService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {}

  event(input: TimelineInput): TimelineEvent {
    const ev: TimelineEvent = {
      id: newId('ev'),
      ts: nowIso(),
      kind: input.kind,
      severity: input.severity ?? 'info',
      title: input.title,
      detail: input.detail ?? null,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      role: input.role ?? null,
    };
    this.store.run(
      `INSERT INTO events (id, ts, kind, severity, title, detail, run_id, task_id, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ev.id, ev.ts, ev.kind, ev.severity, ev.title, j(clip(ev.detail)), ev.runId, ev.taskId, ev.role],
    );
    this.bus.emit('timeline', ev);
    return ev;
  }

  timeline(opts: { limit?: number; before?: string; taskId?: string; runId?: string } = {}): TimelineEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.before) {
      where.push('ts < ?');
      params.push(opts.before);
    }
    if (opts.taskId) {
      where.push('task_id = ?');
      params.push(opts.taskId);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    params.push(opts.limit ?? 300);
    const rows = this.store.all<EventRow>(
      `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      detail: pj(r.detail, null),
      runId: r.run_id,
      taskId: r.task_id,
      role: r.role,
    }));
  }

  beginToolCall(input: Omit<ToolCallRecord, 'id' | 'startedAt' | 'status' | 'result' | 'error' | 'durationMs' | 'filesChanged'>): string {
    const id = newId('tc');
    this.store.run(
      `INSERT INTO tool_calls (id, run_id, task_id, role, provider_id, source, tool, capability, args, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, input.runId, input.taskId, input.role, input.providerId, input.source, input.tool, input.capability, j(clip(input.args)), nowIso()],
    );
    return id;
  }

  endToolCall(
    id: string,
    outcome: { status: 'ok' | 'error' | 'denied'; result?: unknown; error?: string | null; durationMs: number; filesChanged?: string[] },
  ): void {
    this.store.run(
      `UPDATE tool_calls SET status = ?, result = ?, error = ?, duration_ms = ?, files_changed = ? WHERE id = ?`,
      [outcome.status, j(clip(outcome.result ?? null)), outcome.error ?? null, Math.round(outcome.durationMs), j(outcome.filesChanged ?? []), id],
    );
  }

  /** Record a tool call observed after the fact (e.g. a provider's built-in Edit tool). */
  recordToolCall(input: Omit<ToolCallRecord, 'id'>): string {
    const id = newId('tc');
    this.store.run(
      `INSERT INTO tool_calls (id, run_id, task_id, role, provider_id, source, tool, capability, args, result, status, error, duration_ms, started_at, files_changed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.runId,
        input.taskId,
        input.role,
        input.providerId,
        input.source,
        input.tool,
        input.capability,
        j(clip(input.args)),
        j(clip(input.result)),
        input.status,
        input.error,
        input.durationMs,
        input.startedAt,
        j(input.filesChanged),
      ],
    );
    return id;
  }

  toolCalls(opts: { runId?: string; taskId?: string; limit?: number } = {}): ToolCallRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.taskId) {
      where.push('task_id = ?');
      params.push(opts.taskId);
    }
    params.push(opts.limit ?? 500);
    return this.store
      .all<ToolCallRow>(
        `SELECT * FROM tool_calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ?`,
        params,
      )
      .map(rowToToolCall);
  }

  toolCall(id: string): ToolCallRecord | null {
    const r = this.store.get<ToolCallRow>('SELECT * FROM tool_calls WHERE id = ?', [id]);
    return r ? rowToToolCall(r) : null;
  }

  appendRunMessage(runId: string, seq: number, kind: RunMessage['kind'], content: unknown): void {
    this.store.run(
      `INSERT INTO run_messages (id, run_id, seq, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [newId('rm'), runId, seq, kind, j(clip(content, 40000)), nowIso()],
    );
  }

  runMessages(runId: string): RunMessage[] {
    return this.store
      .all<{ id: string; run_id: string; seq: number; kind: RunMessage['kind']; content: string; created_at: string }>(
        'SELECT * FROM run_messages WHERE run_id = ? ORDER BY seq',
        [runId],
      )
      .map((r) => ({ id: r.id, runId: r.run_id, seq: r.seq, kind: r.kind, content: pj(r.content, null), createdAt: r.created_at }));
  }
}

function rowToToolCall(r: ToolCallRow): ToolCallRecord {
  return {
    id: r.id,
    runId: r.run_id,
    taskId: r.task_id,
    role: r.role,
    providerId: r.provider_id,
    source: r.source,
    tool: r.tool,
    capability: r.capability,
    args: pj(r.args, null),
    result: pj(r.result, null),
    status: r.status,
    error: r.error,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
    filesChanged: pj(r.files_changed, []),
  };
}
