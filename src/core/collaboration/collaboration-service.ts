import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { EventBus } from '../events';
import { makeGreeting, pairSecret, SecureChannel, verifyGreeting, type PairGreeting } from './secure-channel';
import {
  COLLAB_MAX_CHAT_HISTORY, COLLAB_RECONNECT_MS, COLLAB_VERSION, COOP_INVITE_MS,
  collabInvitation, parseCollabInvitation, parseCollabPayload,
  truncateCollabHistory, validChatText, validCollabName, validRelayUrl,
  type CollabChatEntry, type CollabConnection, type CollabPayload, type CollabPeer,
  type CollabRole, type CollabServerFrame, type CollabClientFrame, type CoopClientFrame, type CoopServerFrame,
  type CollabTaskSummary, type CollabDirectorSummary, type CollabHeaderStatus, type CollabProjectSummary,
  type CollabRequestReceipt, type CollabPendingRequest, type CollabRunSummary, type CollabRunActivity,
} from '@shared/collaboration';

type Session = {
  relay: string; room: string; name: string; role: CollabRole;
  secret: string; joinSecret?: string; invitation: string | null;
  pairKey?: string; expires?: number; identity?: string; resume?: string; used?: boolean;
  projectId?: string;
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
  remoteProject: CollabProjectSummary | null;
  remoteTasks: CollabTaskSummary[];
  remoteDirector: CollabDirectorSummary[];
  remoteRuns: CollabRunSummary[];
  remoteActivity: CollabRunActivity[];
  directorTyping: boolean;
  requests: CollabPendingRequest[];
  guestRequestsEnabled: boolean;
  hostOnline: boolean;
  reconnectSeconds: number | null;
  error: string | null;
  /** Remote code execution and cross-user subscription pooling are not enabled in C1. */
  remoteAgentsEnabled: boolean;
  pendingAdmission: string | null;
  inviteExpires: number | null;
}
export interface CollaborationDeps {
  bus: EventBus;
  getRelay: () => string | null;
  saveRelay: (relay: string) => void;
  getName: () => string | null;
  saveName: (name: string) => void;
  localProject: () => CollabProjectSummary;
  localTasks: () => CollabTaskSummary[];
  localDirector: () => CollabDirectorSummary[];
  localRuns: () => CollabRunSummary[];
  getAllowGuestRequests: () => boolean;
  saveAllowGuestRequests: (enabled: boolean) => void;
  /** Invoked exclusively in the host core after relay-authenticated requests pass admission checks. */
  onGuestRequest: (sender: CollabPeer, id: string, text: string) => void;
  secure?: boolean;
  onSecurePayload?: (payload: unknown) => void;
  onSecureState?: (ready: boolean) => void;
  onHostState?: (projectId: string, enabled: boolean) => void;
  loadPairing?: (slot: string) => Promise<string | null>;
  savePairing?: (slot: string, value: string | null) => Promise<boolean>;
}

/**
 * Session client in the Node core. The Electron vault can retain pairing state across restarts.
 * Provider credentials are outside the collaboration protocol.
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
  private remoteRuns: CollabRunSummary[] = [];
  private remoteActivity: CollabRunActivity[] = [];
  private directorTyping = false;
  private recentGuestRequestTimes: number[] = [];
  private lastActivityAt = new Map<string, number>();
  private requests: CollabPendingRequest[] = [];
  private hostReceipts = new Map<string, CollabRequestReceipt>();
  private guestAccess = false;
  private lastError: string | null = null;
  private lostAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private opening: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private stopped = true;
  private retry = 0;
  private channel: SecureChannel | null = null;
  private remote: CollabPeer | null = null;
  private candidate: { peer: CollabPeer; greeting: PairGreeting } | null = null;
  private challenge: string | null = null;

  constructor(private readonly deps: CollaborationDeps) {}

  private pairingSlot(role: CollabRole, projectId?: string): string {
    return role === 'host' ? `coop-session:host:${projectId ?? this.deps.localProject().projectId ?? ''}` : 'coop-session:guest';
  }

  private async persist(): Promise<void> {
    const session = this.session;
    if (session?.pairKey) await this.deps.savePairing?.(this.pairingSlot(session.role, session.projectId), JSON.stringify({ session, requests: this.requests }));
  }

  async restore(role: CollabRole): Promise<CollaborationStatus> {
    this.requireInactive();
    if (role !== 'host' && role !== 'guest') throw new Error('Invalid collaboration role');
    const raw = await this.deps.loadPairing?.(this.pairingSlot(role));
    if (!raw) throw new Error('No saved collaboration session for this role');
    const saved = JSON.parse(raw) as { session: Session; requests: CollabPendingRequest[] };
    const session = saved.session;
    if (session.role !== role || !/^[a-f0-9]{64}$/.test(session.pairKey ?? '') ||
        (role === 'host' && session.projectId !== this.deps.localProject().projectId)) throw new Error('Saved pairing does not match this project');
    validRelayUrl(session.relay);
    this.session = session;
    this.startState();
    this.requests = saved.requests.slice(-120);
    await this.connect();
    if (role === 'host') this.deps.onHostState?.(session.projectId!, true);
    return this.status();
  }

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
      invitation: this.session?.role === 'host' && (!this.session.expires || Date.now() < this.session.expires) ? this.session.invitation : null,
      peers: [...this.peers], selfId: this.selfId, messages: [...this.chat],
      remoteProject: this.session?.role === 'host' ? this.deps.localProject() : this.remoteProject,
      remoteTasks: this.session?.role === 'host' ? this.deps.localTasks().slice(-200) : [...this.remoteTasks],
      remoteDirector: [...this.remoteDirector],
      remoteRuns: this.session?.role === 'host' ? this.deps.localRuns().slice(0, 100) : [...this.remoteRuns],
      remoteActivity: [...this.remoteActivity],
      directorTyping: this.directorTyping,
      requests: [...this.requests],
      guestRequestsEnabled: this.session?.role === 'host' ? this.deps.getAllowGuestRequests() : this.guestAccess,
      hostOnline: this.state === 'connected' && this.peers.some((peer) => peer.role === 'host'),
      reconnectSeconds: this.lostAt === null ? null : Math.max(0, Math.ceil((COLLAB_RECONNECT_MS - (Date.now() - this.lostAt)) / 1000)),
      error: this.lastError, remoteAgentsEnabled: !!this.channel,
      pendingAdmission: this.candidate?.peer.name ?? null,
      inviteExpires: this.session?.expires ?? null,
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
    // No consent is silently inherited from an earlier collaboration session.
    this.deps.saveAllowGuestRequests(false);
    const relay = validRelayUrl(this.deps.getRelay() ?? '');
    const name = validCollabName(this.deps.getName() ?? '');
    const secret = randomBytes(32).toString('hex');
    const joinSecret = randomBytes(32).toString('hex');
    const room = createHash('sha256').update(secret).digest('hex').slice(0, 32);
    const projectId = this.deps.localProject().projectId;
    if (this.deps.secure && !projectId) throw new Error('Open the host project before inviting a collaborator');
    const pairKey = this.deps.secure ? pairSecret() : undefined;
    this.session = { relay, room, secret, joinSecret, name, role: 'host',
      invitation: collabInvitation(relay, room, joinSecret) + (pairKey ? '&pair=' + pairKey : ''),
      ...(pairKey ? { pairKey, expires: Date.now() + COOP_INVITE_MS, projectId: projectId! } : {}) };
    this.startState();
    await this.connect();
    if (pairKey) this.deps.onHostState?.(projectId!, true);
    await this.persist();
    return this.status();
  }

  async join(invitation: string): Promise<CollaborationStatus> {
    this.requireInactive();
    const name = validCollabName(this.deps.getName() ?? '');
    const url = new URL(invitation.trim());
    const pairKey = new URLSearchParams(url.hash.slice(1)).get('pair');
    if (this.deps.secure && !/^[a-f0-9]{64}$/.test(pairKey ?? '')) throw new Error('This invitation requires the encrypted collaboration protocol');
    if (pairKey) url.hash = 'join=' + (new URLSearchParams(url.hash.slice(1)).get('join') ?? '');
    const { relay, room, inviteSecret } = parseCollabInvitation(url.toString());
    this.session = { relay, room, secret: inviteSecret, name, role: 'guest', invitation: null,
      ...(pairKey ? { pairKey, identity: randomUUID(), resume: pairSecret() } : {}) };
    this.startState();
    await this.connect();
    await this.persist();
    return this.status();
  }

  /** Explicit logout never grants 10 minutes of continued access. */
  leave(keepProjectMode = false): CollaborationStatus {
    const session = this.session;
    if (!keepProjectMode && session?.role === 'host' && this.channel) {
      try { this.sendCoop({ kind: 'revoked' }); } catch { /* already offline */ }
    }
    if (!keepProjectMode && session?.role === 'host' && session.projectId) this.deps.onHostState?.(session.projectId, false);
    if (!keepProjectMode && session?.pairKey) void this.deps.savePairing?.(this.pairingSlot(session.role, session.projectId), null).catch(() => {});
    this.clearChannel();
    if (!keepProjectMode && this.session?.role === 'host') this.deps.saveAllowGuestRequests(false);
    this.stopped = true;
    this.clearRetry();
    this.finishOpening(new Error('Session left by user'));
    const old = this.socket;
    this.socket = null;
    if (old?.readyState === WebSocket.OPEN) {
      try { if (!keepProjectMode) old.send(JSON.stringify({ v: session?.pairKey ? 2 : COLLAB_VERSION, type: 'leave' })); } catch { /* disconnected */ }
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
    this.remoteRuns = [];
    this.remoteActivity = [];
    this.directorTyping = false;
    this.recentGuestRequestTimes = [];
    this.lastActivityAt.clear();
    this.requests = [];
    this.guestAccess = false;
    this.hostReceipts.clear();
    this.lastError = null;
    this.changed();
    return this.status();
  }

  /** Host opt-in: one authorization for ordinary collaborator requests, not a prompt per file edit. */
  setGuestRequests(enabled: boolean): CollaborationStatus {
    if (this.session?.role === 'guest') throw new Error('Only the host can authorize guest Director requests.');
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean permission.');
    this.deps.saveAllowGuestRequests(enabled);
    this.changed();
    if (this.session?.role === 'host' && this.state === 'connected') this.shareProject();
    return this.status();
  }

  admit(): CollaborationStatus {
    const session = this.session, candidate = this.candidate;
    if (session?.role !== 'host' || !session.pairKey || !candidate || session.identity || Date.now() >= (session.expires ?? 0))
      throw new Error('There is no valid collaboration request to admit');
    this.acceptPair(candidate.peer, candidate.greeting);
    this.deps.saveAllowGuestRequests(true);
    this.shareProject();
    return this.status();
  }

  secureRole(): CollabRole | null { return this.session?.pairKey ? this.session.role : null; }
  roomId(): string | null { return this.session?.pairKey ? this.session.room : null; }
  ready(): boolean { return !!this.channel && this.state === 'connected'; }
  boundProject(): string | undefined { return this.session?.projectId; }

  sendCoop(payload: unknown): void {
    if (!this.channel || !this.remote) throw new Error('Your collaborator is offline');
    this.sendSecure(this.remote.id, this.channel.seal({ kind: 'coop-data', payload }));
  }

  private clearChannel(): void {
    const hadChannel = !!this.channel;
    this.channel = null;
    this.remote = null;
    this.candidate = null;
    this.challenge = null;
    this.guestAccess = false;
    if (hadChannel) this.deps.onSecureState?.(false);
  }

  private sendSecure(to: string, packet: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Collaboration connection is offline');
    const frame: CoopClientFrame = { v: 2, type: 'secure', to, packet };
    this.socket.send(JSON.stringify(frame));
  }

  private requestPair(): void {
    const session = this.session, host = this.peers.find((peer) => peer.role === 'host');
    if (session?.role !== 'guest' || !session.pairKey || !host || this.channel || this.challenge) return;
    this.challenge = pairSecret();
    this.sendSecure(host.id, JSON.stringify(makeGreeting(session.pairKey, session.room, session.identity!, this.challenge, undefined, session.name)));
  }

  private acceptPair(peer: CollabPeer, greeting: PairGreeting): void {
    const session = this.session!;
    const hostChallenge = pairSecret();
    this.sendSecure(peer.id, JSON.stringify(makeGreeting(session.pairKey!, session.room, greeting.identity, greeting.challenge, hostChallenge, session.name)));
    session.identity = greeting.identity;
    session.invitation = null;
    this.channel = new SecureChannel(session.pairKey!, session.room, greeting.challenge, hostChallenge, 'host');
    this.remote = peer;
    this.candidate = null;
    void this.persist().catch(() => {});
    this.deps.onSecureState?.(true);
    this.changed();
  }

  private receiveSecure(from: CollabPeer, packet: string): void {
    const session = this.session;
    if (!session?.pairKey || from.role === session.role || !this.peers.some((peer) => peer.id === from.id && peer.role === from.role)) return;
    if (packet.startsWith('{')) {
      if (packet.length > 800) return;
      const greeting = verifyGreeting(session.pairKey, session.room, JSON.parse(packet));
      if (!greeting) return;
      const peer = { ...from, name: validCollabName(greeting.name) };
      if (session.role === 'host' && greeting.kind === 'join') {
        if (this.channel) return;
        if (session.identity === greeting.identity) this.acceptPair(peer, greeting);
        else if (!session.identity && Date.now() < (session.expires ?? 0)) {
          this.candidate = { peer, greeting };
          this.changed();
        }
      } else if (session.role === 'guest' && greeting.kind === 'accept' && !this.channel &&
          greeting.identity === session.identity && greeting.challenge === this.challenge) {
        this.channel = new SecureChannel(session.pairKey, session.room, greeting.challenge, greeting.hostChallenge, 'guest');
        this.remote = peer;
        this.deps.onSecureState?.(true);
        this.transmit({ kind: 'sync-request' });
        this.retryRequests();
        this.changed();
      }
      return;
    }
    if (!this.channel || this.remote?.id !== from.id) return;
    const data = this.channel.open(packet);
    if (data && typeof data === 'object' && (data as { kind?: string }).kind === 'coop-data') {
      const payload = (data as { payload?: unknown }).payload;
      if (session.role === 'guest' && (payload as { kind?: string } | null)?.kind === 'revoked') this.leave();
      else this.deps.onSecurePayload?.(payload);
      return;
    }
    this.handle({ v: 1, type: 'payload', from: { ...this.remote, id: from.role === 'guest' ? session.identity! : from.id }, data: data as CollabPayload });
  }

  /** A guest asks the host Director to perform work. No remote file, terminal or MCP access. */
  requestDirector(input: string): CollabPendingRequest {
    if (this.session?.role !== 'guest' || this.state !== 'connected' || !this.peers.some((p) => p.role === 'host'))
      throw new Error('The host must be connected before you can request a change.');
    if (!this.guestAccess) throw new Error('The host has not enabled guest requests.');
    const text = validChatText(input);
    const request: CollabPendingRequest = { id: randomUUID(), text, status: 'pending', at: new Date().toISOString() };
    this.requests = [...this.requests, request].slice(-120);
    try { this.transmit({ kind: 'director-request', id: request.id, text }); }
    catch (e) { this.requests = this.requests.filter((r) => r.id !== request.id); throw e; }
    void this.persist().catch(() => {});
    this.changed();
    return request;
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
  shareRun(run: CollabRunSummary): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'run-batch', runs: [run] });
  }
  shareTyping(typing: boolean): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'director-typing', typing });
  }
  shareActivity(activity: CollabRunActivity): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    const now = Date.now();
    if (now - (this.lastActivityAt.get(activity.runId) ?? 0) < 750) return;
    this.lastActivityAt.set(activity.runId, now);
    if (this.lastActivityAt.size > 200) this.lastActivityAt.delete(this.lastActivityAt.keys().next().value!);
    this.transmit({ kind: 'run-activity', activity });
  }
  /** An authoritative snapshot, sent on join/rejoin and when the host switches projects. */
  shareSnapshot(to?: string): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    const tasks = this.deps.localTasks().slice(-200);
    const messages = this.deps.localDirector().slice(-60);
    const runs = this.deps.localRuns().slice(-100);
    this.transmit({ kind: 'task-batch', tasks: [], reset: true }, to);
    for (let i = 0; i < tasks.length; i += 6)
      this.transmit({ kind: 'task-batch', tasks: tasks.slice(i, i + 6) }, to);
    this.transmit({ kind: 'director-batch', messages: [], reset: true }, to);
    for (let i = 0; i < messages.length; i += 3)
      this.transmit({ kind: 'director-batch', messages: messages.slice(i, i + 3) }, to);
    this.transmit({ kind: 'run-batch', runs: [], reset: true }, to);
    for (let i = 0; i < runs.length; i += 30)
      this.transmit({ kind: 'run-batch', runs: runs.slice(i, i + 30) }, to);
  }

  /** Host advertises the project metadata, never file paths or credentials. */
  shareProject(): void {
    if (this.session?.role !== 'host' || this.state !== 'connected') return;
    this.transmit({ kind: 'project-status', ...this.deps.localProject(),
      guestRequestsEnabled: this.deps.getAllowGuestRequests() });
  }

  private requireInactive(): void {
    if (this.session) throw new Error('Leave your current collaboration session first.');
  }
  private startState(): void {
    this.clearChannel();
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
    this.remoteRuns = [];
    this.remoteActivity = [];
    this.directorTyping = false;
    this.recentGuestRequestTimes = [];
    this.lastActivityAt.clear();
    this.requests = [];
    this.guestAccess = false;
    this.hostReceipts.clear();
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
      const hello: (CollabClientFrame & { joinSecret?: string }) | CoopClientFrame = session.pairKey ? {
        v: 2, type: 'hello', role: session.role, name: session.name, secret: session.used ? session.resume! : session.secret,
        ...(session.role === 'host' ? { joinSecret: session.joinSecret } : { resume: session.resume }),
      } : {
        v: 1, type: 'hello', role: session.role, name: session.name, secret: session.secret,
        ...(session.role === 'host' ? { joinSecret: session.joinSecret } : {}),
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (this.socket !== socket || this.stopped || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as CollabServerFrame | CoopServerFrame;
        if (session.pairKey) {
          if (message?.v !== 2) {
            socket.close(1002, 'Relay does not support encrypted collaboration v2');
            return;
          }
          if (message.type === 'secure') this.receiveSecure(message.from, message.packet);
          else {
            if (message.type === 'welcome' && session.role === 'guest') session.used = true;
            this.handle({ ...message, v: 1 });
          }
        } else if (message?.v === COLLAB_VERSION) this.handle(message);
      } catch { /* Invalid or replayed frames are ignored. */ }
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket || this.stopped) return;
      this.lastError = 'Collaboration relay connection failed';
      this.changed();
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      this.clearChannel();
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
    this.clearChannel();
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
    if (this.session?.pairKey) {
      if (!this.channel || !this.remote) {
        if (this.session.role === 'guest') throw new Error('Wait for the host to admit you');
        return;
      }
      if (data.kind === 'chat') this.addMessage(data.message);
      this.sendSecure(this.remote.id, this.channel.seal(data));
      return;
    }
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
  private retryRequests(): void {
    if (this.session?.role !== 'guest' || this.state !== 'connected' ||
        !this.peers.some((peer) => peer.role === 'host')) return;
    for (const r of this.requests.filter((entry) => entry.status === 'pending'))
      this.transmit({ kind: 'director-request', id: r.id, text: r.text });
  }

  private receiveGuestRequest(sender: CollabPeer, id: string, text: string): void {
    const previous = this.hostReceipts.get(id);
    if (previous) {
      this.transmit({ kind: 'director-receipt', receipt: previous }, sender.id);
      return;
    }
    let receipt: CollabRequestReceipt;
    const now = Date.now();
    this.recentGuestRequestTimes = this.recentGuestRequestTimes.filter((time) => now - time < 60_000);
    if (!this.deps.getAllowGuestRequests()) receipt = { id, status: 'rejected', reason: 'Guest requests are disabled by the host.' };
    else if (this.recentGuestRequestTimes.length >= 8)
      receipt = { id, status: 'rejected', reason: 'Too many guest requests. Try again in a minute.' };
    else {
      this.recentGuestRequestTimes.push(now);
      try {
        this.deps.onGuestRequest(sender, id, text);
        receipt = { id, status: 'accepted' };
      } catch (e) {
        receipt = { id, status: 'rejected', reason: (e instanceof Error ? e.message : 'Request refused').slice(0, 160) };
      }
    }
    this.hostReceipts.set(id, receipt);
    if (this.hostReceipts.size > 500) this.hostReceipts.delete(this.hostReceipts.keys().next().value!);
    this.transmit({ kind: 'director-receipt', receipt }, sender.id);
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
      if (this.session.pairKey) {
        if (this.session.role === 'guest') this.requestPair();
      } else if (this.session.role === 'guest') {
        this.transmit({ kind: 'sync-request' });
        this.retryRequests();
      } else this.shareProject();
      return;
    }
    if (frame.type === 'presence') {
      if (!Array.isArray(frame.peers) || frame.peers.length > 16) return;
      const hadHost = this.peers.some((peer) => peer.role === 'host');
      this.peers = frame.peers;
      if (this.session?.pairKey) {
        if ((this.remote && !this.peers.some((peer) => peer.id === this.remote!.id)) || (this.candidate && !this.peers.some((peer) => peer.id === this.candidate!.peer.id))) this.clearChannel();
        if (!this.peers.some((peer) => peer.role === 'host')) this.challenge = null;
        this.requestPair();
        this.changed();
        return;
      }
      this.changed();
      if (this.session?.role === 'guest' && this.state === 'connected' &&
          !hadHost && frame.peers.some((peer) => peer.role === 'host')) {
        this.transmit({ kind: 'sync-request' });
        this.retryRequests();
      }
      return;
    }
    if (frame.type !== 'payload') return;
    const sourceHost = frame.from?.role === 'host';
    const data = parseCollabPayload(frame.data, sourceHost);
    if (!data) return;
    if (data.kind === 'chat') {
      // Relay overwrites sender fields; a stale or duplicated event is ignored.
      this.addMessage(this.session?.pairKey ? { ...data.message, sender: frame.from.name, from: frame.from.id } : data.message);
    } else if (data.kind === 'project-status' && sourceHost && this.session?.role === 'guest') {
      this.remoteProject = data;
      this.guestAccess = data.guestRequestsEnabled === true;
      this.changed();
    } else if (data.kind === 'sync-request' && this.session?.role === 'host' && frame.from?.role === 'guest') {
      // Send bounded batches; a single 400-message history frame would exceed relay limits.
      const history = this.chat.slice(-COLLAB_MAX_CHAT_HISTORY);
      for (let offset = 0; offset < history.length; offset += 5)
        this.transmit({ kind: 'history', messages: history.slice(offset, offset + 5) }, frame.from.id);
      this.shareProject();
      this.shareSnapshot(frame.from.id);
    } else if (data.kind === 'director-request' && this.session?.role === 'host' && frame.from?.role === 'guest') {
      this.receiveGuestRequest(frame.from, data.id, data.text);
    } else if (data.kind === 'director-receipt' && sourceHost && this.session?.role === 'guest') {
      this.requests = this.requests.map((request) => request.id === data.receipt.id ?
        { ...request, status: data.receipt.status, ...(data.receipt.reason ? { reason: data.receipt.reason } : {}) } : request);
      void this.persist().catch(() => {});
      this.changed();
    } else if (data.kind === 'director-typing' && sourceHost && this.session?.role === 'guest') {
      this.directorTyping = data.typing;
      this.changed();
    } else if (data.kind === 'run-activity' && sourceHost && this.session?.role === 'guest') {
      const activity = this.remoteActivity.filter((item) => item.runId !== data.activity.runId);
      this.remoteActivity = [...activity, data.activity].slice(-80);
      this.changed();
    } else if (data.kind === 'run-batch' && sourceHost && this.session?.role === 'guest') {
      const map = new Map((data.reset ? [] : this.remoteRuns).map((run) => [run.id, run]));
      for (const run of data.runs) map.set(run.id, run);
      this.remoteRuns = [...map.values()].slice(-150);
      this.changed();
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
