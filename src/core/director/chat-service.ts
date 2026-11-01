import { newId, nowIso } from '@shared/ids';
import type { ChatMessage } from '@shared/domain';
import { scrubRawErrors } from '@shared/plain-words';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import { j, pj } from '../db/store';

interface ChatRow {
  id: string;
  channel?: string;
  role: ChatMessage['role'];
  kind: ChatMessage['kind'];
  text: string;
  data: string | null;
  created_at: string;
}

/**
 * One of the project's conversations, stored with the project: the director's ("director", the
 * project's main chat) or a dock copilot's ("copilot:animation", "copilot:audio", …).
 */
export class ChatService {
  constructor(
    private readonly project: ProjectContext,
    private readonly bus: EventBus,
    readonly channel = 'director',
  ) {}

  list(limit = 300): ChatMessage[] {
    return this.project.store
      .all<ChatRow>('SELECT * FROM (SELECT rowid AS seq, * FROM chat_messages WHERE channel = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, seq', [this.channel, limit])
      .map(hydrate);
  }

  get(id: string): ChatMessage | null {
    const r = this.project.store.get<ChatRow>('SELECT * FROM chat_messages WHERE id = ?', [id]);
    return r ? hydrate(r) : null;
  }

  add(m: { role: ChatMessage['role']; kind: ChatMessage['kind']; text: string; data?: Record<string, unknown> | null }): ChatMessage {
    const plain = plainLine(m.role, m.kind, m.text, m.data ?? null);
    const msg: ChatMessage = { id: newId('msg'), role: m.role, channel: this.channel, kind: m.kind, text: plain.text, data: plain.data, createdAt: nowIso() };
    this.project.store.run('INSERT INTO chat_messages (id, role, kind, text, data, created_at, channel) VALUES (?, ?, ?, ?, ?, ?, ?)', [msg.id, msg.role, msg.kind, msg.text, msg.data ? j(msg.data) : null, msg.createdAt, this.channel]);
    this.emit(msg);
    return msg;
  }

  update(id: string, patch: { text?: string; data?: Record<string, unknown> | null; kind?: ChatMessage['kind'] }): ChatMessage | null {
    const cur = this.get(id);
    if (!cur) return null;
    const kind = patch.kind ?? cur.kind;
    const plain = patch.text === undefined ? { text: cur.text, data: patch.data === undefined ? cur.data : patch.data } : plainLine(cur.role, kind, patch.text, patch.data === undefined ? cur.data : patch.data);
    const next: ChatMessage = { ...cur, text: plain.text, kind, data: plain.data };
    this.project.store.run('UPDATE chat_messages SET text = ?, kind = ?, data = ? WHERE id = ?', [next.text, next.kind, next.data ? j(next.data) : null, id]);
    this.emit(next);
    return next;
  }

  /** Latest message of a kind whose data matches (e.g. the plan card of an objective). */
  findLatest(kind: ChatMessage['kind'], match: (data: Record<string, unknown>) => boolean): ChatMessage | null {
    const rows = this.project.store.all<ChatRow>('SELECT * FROM chat_messages WHERE kind = ? AND channel = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', [kind, this.channel]).map(hydrate);
    return rows.find((m) => m.data && match(m.data)) ?? null;
  }

  private emit(msg: ChatMessage): void {
    this.bus.emit('chat.message', { ...msg, projectId: this.project.summary.id, projectName: this.project.summary.name });
  }
}

/**
 * Error lines and the system's status lines carry no raw program error ("Orchestrator error: Cannot read properties of
 * undefined (reading 'slice')", "Claude Code native binary not found at C:\…"): it becomes one plain clause, and the
 * line as it was is kept in the message's data (`technical`) next to the log that already has it.
 */
function plainLine(role: ChatMessage['role'], kind: ChatMessage['kind'], text: string, data: Record<string, unknown> | null): { text: string; data: Record<string, unknown> | null } {
  if (kind !== 'error' && !(role === 'system' && kind === 'status')) return { text, data };
  const r = scrubRawErrors(text);
  return r.technical ? { text: r.text, data: { ...(data ?? {}), technical: typeof data?.technical === 'string' ? data.technical : r.technical } } : { text, data };
}

function hydrate(r: ChatRow): ChatMessage {
  return { id: r.id, role: r.role, channel: r.channel ?? 'director', kind: r.kind, text: r.text, data: r.data ? pj<Record<string, unknown> | null>(r.data, null) : null, createdAt: r.created_at };
}
