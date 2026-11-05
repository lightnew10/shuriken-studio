/**
 * Collaboration wire protocol v1. Content is relayed in real time, not stored at Cloudflare.
 * Never send provider OAuth tokens, account profiles, or arbitrary MCP requests in this protocol.
 */
export const COLLAB_VERSION = 1 as const;
export const COLLAB_RECONNECT_MS = 10 * 60_000;
export const COLLAB_MAX_FRAME_BYTES = 64 * 1024;
export const COLLAB_MAX_CHAT_CHARS = 2_000;
export const COLLAB_MAX_NAME_CHARS = 48;
export const COLLAB_MAX_CHAT_HISTORY = 400;
export const COLLAB_MAX_PEERS = 12;
export const COLLAB_MAX_DIRECTOR_CHARS = 2_000;
export const COLLAB_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type CollabRole = 'host' | 'guest';
export type CollabConnection = 'offline' | 'connecting' | 'connected' | 'reconnecting';
export interface CollabPeer {
  id: string;
  name: string;
  role: CollabRole;
}
/** Lightweight header status: never transports chat history, invite tokens or AI credentials. */
export interface CollabHeaderStatus {
  role: CollabRole | null;
  connection: CollabConnection;
  peers: CollabPeer[];
  selfId: string | null;
  hostOnline: boolean;
}
export interface CollabChatEntry {
  id: string;
  from: string;
  sender: string;
  text: string;
  at: string;
}
export interface CollabTaskSummary {
  id: string;
  title: string;
  role: string;
  status: string;
  updatedAt: string;
}
export interface CollabDirectorSummary {
  id: string;
  role: 'user' | 'director' | 'system';
  kind: string;
  text: string;
  createdAt: string;
  /** Display only; set by the authoritative host on a guest-initiated Director message. */
  sender?: string;
}
export interface CollabRunSummary {
  id: string;
  taskId: string | null;
  role: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
}
export interface CollabRequestReceipt {
  id: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}
export interface CollabPendingRequest {
  id: string;
  text: string;
  status: 'pending' | 'accepted' | 'rejected';
  reason?: string;
  at: string;
}
export type CollabPayload =
  | { kind: 'chat'; message: CollabChatEntry }
  | { kind: 'sync-request' }
  | { kind: 'history'; messages: CollabChatEntry[] }
  | { kind: 'project-status'; name: string; projectId: string | null; taskCount: number; guestRequestsEnabled?: boolean }
  | { kind: 'task-batch'; tasks: CollabTaskSummary[]; reset?: boolean }
  | { kind: 'task-remove'; id: string }
  | { kind: 'director-batch'; messages: CollabDirectorSummary[]; reset?: boolean }
  | { kind: 'director-request'; id: string; text: string }
  | { kind: 'director-receipt'; receipt: CollabRequestReceipt }
  | { kind: 'run-batch'; runs: CollabRunSummary[]; reset?: boolean };
export type CollabClientFrame =
  | { v: 1; type: 'hello'; role: CollabRole; secret: string; name: string }
  | { v: 1; type: 'leave' }
  | { v: 1; type: 'payload'; data: CollabPayload; to?: string };
export type CollabServerFrame =
  | { v: 1; type: 'welcome'; self: CollabPeer; peers: CollabPeer[] }
  | { v: 1; type: 'presence'; peers: CollabPeer[] }
  | { v: 1; type: 'payload'; from: CollabPeer; data: CollabPayload }
  | { v: 1; type: 'error'; reason: string };

export function validRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')))
    throw new Error('Collaboration relay must use HTTPS (HTTP only for local development).');
  if (url.username || url.password || url.search || url.hash) throw new Error('Relay URL may not include credentials or query parameters.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Use the base Cloudflare Worker URL.');
  return url.origin;
}
export function validCollabName(value: string): string {
  const name = value.trim();
  if (!name || name.length > COLLAB_MAX_NAME_CHARS || /[\x00-\x1f\x7f]/.test(name))
    throw new Error('Enter a display name of 1–48 printable characters.');
  return name;
}
export function validChatText(value: string): string {
  const text = value.trim();
  if (!text || text.length > COLLAB_MAX_CHAT_CHARS || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new Error('Message must contain 1–2,000 characters without control characters.');
  return text;
}
export function validRoomId(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}
export function validRoomSecret(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
/** Invitation secret is in the fragment, and is not sent by a normal HTTP link fetch. */
export function parseCollabInvitation(value: string): { relay: string; room: string; inviteSecret: string } {
  const url = new URL(value.trim());
  const relay = validRelayUrl(url.origin);
  const match = /^\/room\/([a-f0-9]{32})$/.exec(url.pathname);
  if (!match) throw new Error('Not a Shuriken collaboration invitation.');
  const secret = new URLSearchParams(url.hash.slice(1)).get('join') ?? '';
  if (!validRoomSecret(secret)) throw new Error('Invitation does not contain a valid join key.');
  return { relay, room: match[1]!, inviteSecret: secret };
}
export function collabInvitation(relay: string, room: string, secret: string): string {
  if (!validRoomId(room) || !validRoomSecret(secret)) throw new Error('Invalid collaboration session keys.');
  return validRelayUrl(relay) + '/room/' + room + '#join=' + secret;
}
/** Strict runtime validation prevents peers from sending arbitrary protocol objects. */
export function parseCollabPayload(input: unknown, senderIsHost: boolean): CollabPayload | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.kind === 'sync-request') return { kind: 'sync-request' };
  if (!senderIsHost && value.kind === 'director-request') {
    if (typeof value.id !== 'string' || !COLLAB_REQUEST_ID.test(value.id) ||
        typeof value.text !== 'string' || value.text.length > COLLAB_MAX_DIRECTOR_CHARS) return null;
    try { return { kind: 'director-request', id: value.id, text: validChatText(value.text) }; }
    catch { return null; }
  }
  if (value.kind === 'chat') {
    const m = value.message;
    if (!m || typeof m !== 'object') return null;
    const msg = m as Record<string, unknown>;
    if (typeof msg.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(msg.id) ||
      typeof msg.text !== 'string' || typeof msg.at !== 'string' || typeof msg.sender !== 'string' || typeof msg.from !== 'string') return null;
    try {
      const text = validChatText(msg.text);
      const sender = validCollabName(msg.sender);
      if (msg.from.length > 80 || !Number.isFinite(Date.parse(msg.at))) return null;
      return { kind: 'chat', message: { id: msg.id, from: msg.from, sender, text, at: msg.at } };
    } catch { return null; }
  }
  if (!senderIsHost) return null;
  if (value.kind === 'task-batch' && Array.isArray(value.tasks) && value.tasks.length <= 40) {
    const tasks: CollabTaskSummary[] = [];
    for (const task of value.tasks) {
      if (!task || typeof task !== 'object') return null;
      const t = task as Record<string, unknown>;
      if (typeof t.id !== 'string' || t.id.length > 100 || !t.id ||
          typeof t.title !== 'string' || t.title.length > 250 ||
          typeof t.role !== 'string' || t.role.length > 100 ||
          typeof t.status !== 'string' || t.status.length > 48 ||
          typeof t.updatedAt !== 'string' || !Number.isFinite(Date.parse(t.updatedAt))) return null;
      tasks.push({ id: t.id, title: t.title, role: t.role, status: t.status, updatedAt: t.updatedAt });
    }
    return { kind: 'task-batch', tasks, ...(value.reset === true ? { reset: true } : {}) };
  }
  if (value.kind === 'task-remove' && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 100)
    return { kind: 'task-remove', id: value.id };
  if (value.kind === 'director-batch' && Array.isArray(value.messages) && value.messages.length <= 15) {
    const messages: CollabDirectorSummary[] = [];
    for (const message of value.messages) {
      if (!message || typeof message !== 'object') return null;
      const m = message as Record<string, unknown>;
      if (typeof m.id !== 'string' || m.id.length > 100 || !m.id ||
          !['user', 'director', 'system'].includes(String(m.role)) ||
          typeof m.kind !== 'string' || m.kind.length > 48 ||
          typeof m.text !== 'string' || m.text.length > 3_000 ||
          typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt))) return null;
      if (m.sender !== undefined && (typeof m.sender !== 'string' || m.sender.length > COLLAB_MAX_NAME_CHARS)) return null;
      messages.push({ id: m.id, role: m.role as CollabDirectorSummary['role'], kind: m.kind,
        text: m.text, createdAt: m.createdAt, ...(typeof m.sender === 'string' ? { sender: m.sender } : {}) });
    }
    return { kind: 'director-batch', messages, ...(value.reset === true ? { reset: true } : {}) };
  }
  if (value.kind === 'director-receipt') {
    const r = value.receipt;
    if (!r || typeof r !== 'object') return null;
    const receipt = r as Record<string, unknown>;
    if (typeof receipt.id !== 'string' || !COLLAB_REQUEST_ID.test(receipt.id) ||
        (receipt.status !== 'accepted' && receipt.status !== 'rejected') ||
        (receipt.reason !== undefined && (typeof receipt.reason !== 'string' || receipt.reason.length > 160))) return null;
    return { kind: 'director-receipt', receipt: {
      id: receipt.id, status: receipt.status,
      ...(typeof receipt.reason === 'string' ? { reason: receipt.reason } : {}),
    } };
  }
  if (value.kind === 'run-batch' && Array.isArray(value.runs) && value.runs.length <= 35) {
    const runs: CollabRunSummary[] = [];
    for (const r of value.runs) {
      if (!r || typeof r !== 'object') return null;
      const x = r as Record<string, unknown>;
      if (typeof x.id !== 'string' || !x.id || x.id.length > 100 ||
          (x.taskId !== null && (typeof x.taskId !== 'string' || x.taskId.length > 100)) ||
          typeof x.role !== 'string' || x.role.length > 100 ||
          !['starting', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(String(x.status)) ||
          typeof x.startedAt !== 'string' || !Number.isFinite(Date.parse(x.startedAt)) ||
          (x.endedAt !== null && (typeof x.endedAt !== 'string' || !Number.isFinite(Date.parse(x.endedAt))))) return null;
      runs.push({ id: x.id, taskId: x.taskId as string | null, role: x.role,
        status: x.status as CollabRunSummary['status'], startedAt: x.startedAt, endedAt: x.endedAt as string | null });
    }
    return { kind: 'run-batch', runs, ...(value.reset === true ? { reset: true } : {}) };
  }
  if (value.kind === 'history') {
    if (!Array.isArray(value.messages) || value.messages.length > COLLAB_MAX_CHAT_HISTORY) return null;
    const messages: CollabChatEntry[] = [];
    for (const m of value.messages) {
      const item = parseCollabPayload({ kind: 'chat', message: m }, false);
      if (!item || item.kind !== 'chat') return null;
      messages.push(item.message);
    }
    return { kind: 'history', messages };
  }
  if (value.kind === 'project-status' && typeof value.name === 'string' && value.name.length <= 150 &&
      (value.projectId === null || typeof value.projectId === 'string' && value.projectId.length <= 100) &&
      typeof value.taskCount === 'number' && Number.isSafeInteger(value.taskCount) && value.taskCount >= 0)
    return { kind: 'project-status', name: value.name, projectId: value.projectId as string | null, taskCount: value.taskCount,
      guestRequestsEnabled: value.guestRequestsEnabled === true };
  return null;
}
export function truncateCollabHistory(messages: CollabChatEntry[]): CollabChatEntry[] {
  return messages.slice(-COLLAB_MAX_CHAT_HISTORY);
}
