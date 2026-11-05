import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { EventBus } from '../events';
import {
  COLLAB_MAX_CHAT_HISTORY, COLLAB_RECONNECT_MS, COLLAB_VERSION,
  collabInvitation, parseCollabInvitation, parseCollabPayload,
  truncateCollabHistory, validChatText, validCollabName, validRelayUrl,
  type CollabChatEntry, type CollabConnection, type CollabPayload, type CollabPeer,
  type CollabRole, type CollabServerFrame, type CollabClientFrame,
  type CollabTaskSummary, type CollabDirectorSummary, type CollabHeaderStatus,
} from '@shared/collaboration';

type Session = {
  relay: string; room: string; name: string; role: CollabRole;
  secret: string; joinSecret?: string; invitation: string | null;
};
export interface CollaborationStatus {
  connection: CollabConnection;
  role: CollabRole | null;
  relay: string;
  name: string;
  invitation: string | null;
  peers: CollabPeer[];
  selfId: string | null;
  messages: CollabChatEntry[];
  remoteProject: { name: string; projectId: string | null; taskCount: number } | null;
  remoteTasks: CollabTaskSummary[];
  remoteDirector: CollabDirectorSummary[];
  hostOnline: boolean;
  reconnectSeconds: number | null;
  error: string | null;
  /** Remote code execution and cross-user subscription pooling are not enabled in C1. */
  remoteAgentsEnabled: false;
}
export interface CollaborationDeps {
  bus: EventBus;
  getRelay: () => string | null;
  saveRelay: (relay: string) => void;
  getName: () => string | null;
  saveName: (name: string) => void;
  localProject: () => { name: string; projectId: string | null; taskCount: number };
  localTasks: () => CollabTaskSummary[];
  localDirector: () => CollabDirectorSummary[];
}

/**
 * C1 session client. Runs only in the core (Node), never in the renderer.
 * Stores no remote OAuth/auth profiles. Temporary host and guest secrets exist only in memory.
 */
export class CollaborationService {
  private session: Session | null = null;
  private socket: WebSocket | null = null;
  private state: CollabConnection = 'offline';
  private peers: CollabPeer[] = [];
  private selfId: string | null = null;
  private chat: CollabChatEntry[] = [];
  private remoteProject: CollaborationStatus['remoteProject'] = null;
  private remoteTasks: CollabTaskSummary[] = [];
  private remoteDirector: CollabDirectorSummary[] = [];
  private lastError: string | null = null;
  private lostAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private opening: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private stopped = true;
  private retry = 0;

  constructor(private readonly deps: CollaborationDeps) {}

  /** Called frequently by the global header, intentionally excludes messages, tasks and invite keys. */
  headerStatus(): CollabHeaderStatus {
    return {
      role: this.session?.role ?? null,
      connection: this.state,
      peers: [...this.peers],
      selfId: this.selfId,
      hostOnline: this.state === 'connected' && this.peers.some((peer) => peer.role === 'host'),
    };
  }

  status(): CollaborationStatus {
    return {
      connection: this.state, role: this.session?.role ?? null,
      relay: this.deps.getRelay() ?? '',
      name: this.deps.getName() ?? '',
      invitation: this.session?.role === 'host' ? this.session.invitation : null,
      peers: [...this.peers], selfId: this.selfId, messages: [...this.chat],
      remoteProject: this.remoteProject,
      remoteTasks: [...this.remoteTasks],
      remoteDirector: [...this.remoteDirector],
      hostOnline: this.state === 'connected' && this.peers.some((peer) => peer.role === 'host'),
      reconnectSeconds: this.lostAt === null ? null : Math.max(0, Math.ceil((COLLAB_RECONNECT_MS - (Date.now() - this.lostAt)) / 1000)),
      error: this.lastError, remoteAgentsEnabled: false,
    };
  }

  configure(input: { relay: string; name: string }): CollaborationStatus {
    if (this.session) throw new Error('Leave the current session before changing your collaboration profile.');
    const relay = validRelayUrl(input.relay);
    const name = validCollabName(input.name);
    this.deps.saveRelay(relay);
    this.deps.saveName(name);
    this.changed();
    return this.status();
  }

  async host(): Promise<CollaborationStatus> {
    this.requireInactive();
    const relay = validRelayUrl(this.deps.getRelay() ?? '');
    const name = validCollabName(this.deps.getName() ?? '');
    const secret = randomBytes(32).toString('hex');
    const joinSecret = randomBytes(32).toString('hex');
    const room = createHash('sha256').update(secret).digest('hex').slice(0, 32);
    this.session = { relay, room, secret, joinSecret, name, role: 'host',
      invitation: collabInvitation(relay, room, joinSecret) };
    this.startState();
    await this.connect();
    return this.status();
  }

  async join(invitation: string): Promise<CollaborationStatus> {
    this.requireInactive();
    const name = validCollabName(this.deps.getName() ?? '');
    const { relay, room, inviteSecret } = parseCollabInvitation(invitation);
    this.session = { relay, room, secret: inviteSecret, name, role: 'guest', invitation: null };
    this.startState();
    await this.connect();
    return this.status();
  }

  /** Explicit logout never grants 10 minutes of continued access. */
  leave(): CollaborationStatus {
    this.stopped = true;
    this.clearRetry();
    this.finishOpening(new Error('Session left by user'));
    const old = this.socket;
    this.socket = null;
    if (old?.readyState === WebSocket.OPEN) {
      try { old.send(JSON.stringify({ v: COLLAB_VERSION, type: 'leave' })); } catch { /* disconnected */ }
    }
    try { old?.close(1000, 'User left'); } catch { /* disconnected */ }
    this.session = null;
    this.state = 'offline';
    this.peers = [];
    this.selfId = null;
    this.lostAt = null;
    this.retry = 0;
    this.chat = [];
    this.remoteProject = null;
    this.remoteTasks = [];
    this.remoteDirector = [];
    this.lastError = null;
    this.changed();
    return this.status();
  }

  sendChat(input: string): CollabChatEntry {
    if (!this.session || this.state !== 'connected' || !this.selfId)
      throw new Error('Join a connected collaboration session before sending messages.');
    if (this.session.role === 'guest' && !this.peers.some((peer) => peer.role === 'host'))
      throw new Error('The host is offline. Wait for the host to reconnect before sending a message.');
    const message: CollabChatEntry = {
      id: randomUUID(), from: this.selfId, sender: this.session.name,
      text: validChatText(input), at: new Date().toISOString(),
    };
    this.transmit({ kind: 'chat', message });
    return message;
  }

  /** Share read-only task status; guests cannot mutate host tasks with this protocol. */
  shareTask(task: CollabTaskSummary): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'task-batch', tasks: [task] });
  }
  removeTask(id: string): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'task-remove', id });
  }
  /** Only visible Director chat text. Never tool arguments, attachments or provider credentials. */
  shareDirector(message: CollabDirectorSummary): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'director-batch', messages: [message] });
  }
  /** An authoritative snapshot, sent on join/rejoin and when the host switches projects. */
  shareSnapshot(to?: string): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    const tasks = this.deps.localTasks().slice(-200);
    const messages = this.deps.localDirector().slice(-60);
    this.transmit({ kind: 'task-batch', tasks: [], reset: true }, to);
    for (let i = 0; i < tasks.length; i += 30)
      this.transmit({ kind: 'task-batch', tasks: tasks.slice(i, i + 30) }, to);
    this.transmit({ kind: 'director-batch', messages: [], reset: true }, to);
    for (let i = 0; i < messages.length; i += 12)
      this.transmit({ kind: 'director-batch', messages: messages.slice(i, i + 12) }, to);
  }

  /** Host advertises the project metadata, never file paths or credentials. */
  shareProject(): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'project-status', ...this.deps.localProject() });
  }

  private requireInactive(): void {
    if (this.session) throw new Error('Leave your current collaboration session first.');
  }
  private startState(): void {
    this.stopped = false;
    this.lastError = null;
    this.state = 'connecting';
    this.lostAt = null;
    this.retry = 0;
    this.chat = [];
    this.peers = [];
    this.remoteProject = null;
    this.remoteTasks = [];
    this.remoteDirector = [];
    this.changed();
  }
  private changed(): void { this.deps.bus.emit('collaboration.changed', {}); }
  private clearRetry(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  private finishOpening(error?: Error): void {
    const pending = this.opening;
    if (!pending) return;
    this.opening = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private connect(): Promise<void> {
    const session = this.session;
    if (!session || this.stopped) return Promise.reject(new Error('No active session.'));
    this.clearRetry();
    const wsUrl = session.relay.replace(/^http/, 'ws') + '/room/' + session.room;
    let socket: WebSocket;
    try { socket = new WebSocket(wsUrl); } catch (err) {
      this.disconnected(err instanceof Error ? err.message : String(err));
      return Promise.reject(err);
    }
    this.socket = socket;
    this.state = this.lostAt === null ? 'connecting' : 'reconnecting';
    this.changed();

    socket.addEventListener('open', () => {
      if (this.stopped || this.socket !== socket) return;
      const hello: CollabClientFrame & { joinSecret?: string } = {
        v: 1, type: 'hello', role: session.role, name: session.name, secret: session.secret,
        ...(session.role === 'host' ? { joinSecret: session.joinSecret } : {}),
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (this.socket !== socket || this.stopped || typeof event.data !== 'string') return;
      let message: CollabServerFrame;
      try { message = JSON.parse(event.data) as CollabServerFrame; } catch { return; }
      if (message?.v !== COLLAB_VERSION) return;
      this.handle(message);
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket || this.stopped) return;
      this.lastError = 'Collaboration relay connection failed';
      this.changed();
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      if (event.code === 1008 || event.code === 1002 || event.code === 4001) {
        this.lastError = 'Session refused or replaced by the relay: ' + (event.reason || event.code);
        this.stopped = true;
        this.state = 'offline';
        this.finishOpening(new Error(this.lastError));
        this.changed();
        return;
      }
      this.disconnected(event.reason || 'Connection lost');
    });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.socket === socket && this.state !== 'connected') {
          this.finishOpening(new Error('Collaboration relay did not authenticate within 15 seconds'));
          socket.close(1000, 'Handshake timeout');
        }
      }, 15_000);
      this.opening = { resolve, reject, timer };
    });
  }

  private disconnected(reason: string): void {
    if (this.stopped || !this.session) return;
    this.lastError = reason;
    this.peers = [];
    this.selfId = null;
    if (this.lostAt === null) this.lostAt = Date.now();
    this.state = 'reconnecting';
    this.finishOpening(new Error(reason));
    this.changed();
    if (Date.now() - this.lostAt >= COLLAB_RECONNECT_MS) {
      this.stopped = true;
      this.state = 'offline';
      this.session = null;
      this.lastError = 'The 10-minute reconnect window expired. Join the session again.';
      this.changed();
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.retry++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private transmit(data: CollabPayload, to?: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.state !== 'connected')
      throw new Error('Collaboration connection is offline.');
    const frame: CollabClientFrame = { v: 1, type: 'payload', data, ...(to ? { to } : {}) };
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024)
      throw new Error('Collaboration message too large.');
    this.socket.send(encoded);
  }
  private addMessage(message: CollabChatEntry): void {
    if (this.chat.some((item) => item.id === message.id)) return;
    this.chat = truncateCollabHistory([...this.chat, message]);
    this.changed();
  }
  private handle(frame: CollabServerFrame): void {
    if (frame.type === 'error') {
      this.lastError = frame.reason.slice(0, 250);
      this.changed();
      return;
    }
    if (frame.type === 'welcome') {
      if (!this.session || frame.self.role !== this.session.role) return;
      this.state = 'connected';
      this.selfId = frame.self.id;
      this.peers = frame.peers;
      this.retry = 0;
      this.lostAt = null;
      this.lastError = null;
      this.finishOpening();
      this.changed();
      if (this.session.role === 'guest') this.transmit({ kind: 'sync-request' });
      else this.shareProject();
      return;
    }
    if (frame.type === 'presence') {
      if (!Array.isArray(frame.peers) || frame.peers.length > 16) return;
      const hadHost = this.peers.some((peer) => peer.role === 'host');
      this.peers = frame.peers;
      this.changed();
      if (this.session?.role === 'guest' && this.state === 'connected' &&
          !hadHost && frame.peers.some((peer) => peer.role === 'host'))
        this.transmit({ kind: 'sync-request' });
      return;
    }
    if (frame.type !== 'payload') return;
    const sourceHost = frame.from?.role === 'host';
    const data = parseCollabPayload(frame.data, sourceHost);
    if (!data) return;
    if (data.kind === 'chat') {
      // Relay overwrites sender fields; a stale or duplicated event is ignored.
      this.addMessage(data.message);
    } else if (data.kind === 'project-status' && sourceHost && this.session?.role === 'guest') {
      this.remoteProject = data;
      this.changed();
    } else if (data.kind === 'sync-request' && this.session?.role === 'host' && frame.from?.role === 'guest') {
      // Send bounded batches; a single 400-message history frame would exceed relay limits.
      const history = this.chat.slice(-COLLAB_MAX_CHAT_HISTORY);
      for (let offset = 0; offset < history.length; offset += 20)
        this.transmit({ kind: 'history', messages: history.slice(offset, offset + 20) }, frame.from.id);
      this.shareProject();
      this.shareSnapshot(frame.from.id);
    } else if (data.kind === 'task-batch' && sourceHost && this.session?.role === 'guest') {
      const map = new Map((data.reset ? [] : this.remoteTasks).map((t) => [t.id, t]));
      for (const task of data.tasks) map.set(task.id, task);
      this.remoteTasks = [...map.values()].slice(-200);
      this.changed();
    } else if (data.kind === 'task-remove' && sourceHost && this.session?.role === 'guest') {
      this.remoteTasks = this.remoteTasks.filter((task) => task.id !== data.id);
      this.changed();
    } else if (data.kind === 'director-batch' && sourceHost && this.session?.role === 'guest') {
      const map = new Map((data.reset ? [] : this.remoteDirector).map((m) => [m.id, m]));
      for (const message of data.messages) map.set(message.id, message);
      this.remoteDirector = [...map.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-80);
      this.changed();
    } else if (data.kind === 'history' && sourceHost && this.session?.role === 'guest') {
      for (const message of data.messages) this.addMessage(message);
      this.chat.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      this.changed();
    }
  }
}
