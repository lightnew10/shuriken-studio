import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationService } from '../src/core/collaboration/collaboration-service';
import { EventBus } from '../src/core/events';
import { collabInvitation } from '../src/shared/collaboration';

const sockets: FakeSocket[] = [];
class FakeSocket {
  static readonly OPEN = 1;
  readonly url: string;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(event: any) => void>>();
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.emit('open', {}); });
  }
  addEventListener(type: string, cb: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  private emit(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
  send(payload: string): void {
    const frame = JSON.parse(payload) as Record<string, any>;
    this.sent.push(frame);
    if (frame.type === 'hello') queueMicrotask(() => this.receive({
      v: 1, type: 'welcome',
      self: { id: 'member_123', name: frame.name, role: frame.role },
      peers: [{ id: 'member_123', name: frame.name, role: frame.role }],
    }));
    if (frame.type === 'payload' && frame.data.kind === 'chat')
      queueMicrotask(() => this.receive({
        v: 1, type: 'payload', from: { id: 'member_123', name: 'Tester', role: 'host' }, data: frame.data,
      }));
  }
  receive(frame: unknown): void { this.emit('message', { data: JSON.stringify(frame) }); }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}
const originalSocket = globalThis.WebSocket;
afterEach(() => {
  vi.stubGlobal('WebSocket', originalSocket);
  sockets.length = 0;
});

describe('CollaborationService (no AI account sharing)', () => {
  function service(initialName = 'Host') {
    let relay: string | null = 'https://relay.example.workers.dev';
    let name: string | null = initialName;
    const bus = new EventBus();
    const changed = vi.fn();
    bus.on('collaboration.changed', changed);
    return {
      manager: new CollaborationService({
        bus,
        getRelay: () => relay,
        saveRelay: (r) => { relay = r; },
        getName: () => name,
        saveName: (n) => { name = n; },
        localProject: () => ({ name: 'Impulse Simulator', projectId: 'game01', taskCount: 12 }),
        localTasks: () => [{ id: 'task-01', title: 'Build combat', role: 'roblox-engineer', status: 'running', updatedAt: new Date().toISOString() }],
        localDirector: () => [{ id: 'msg-01', role: 'director', kind: 'text', text: 'Building the combat system', createdAt: new Date().toISOString() }],
      }),
      changed,
    };
  }
  it('hosts with separate host and guest keys and no credentials in the WebSocket URL', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { manager, changed } = service();
    const state = await manager.host();
    expect(state.connection).toBe('connected');
    expect(state.role).toBe('host');
    expect(state.invitation).toContain('#join=');
    expect(manager.headerStatus()).toMatchObject({
      role: 'host', connection: 'connected', hostOnline: true,
      peers: [{ id: 'member_123', name: 'Host', role: 'host' }],
      selfId: 'member_123',
    });
    expect(JSON.stringify(manager.headerStatus())).not.toContain('join=');
    expect(JSON.stringify(manager.headerStatus())).not.toContain('chat');
    const socket = sockets[0]!;
    expect(socket.url).toMatch(/^wss:\/\/relay\.example\.workers\.dev\/room\/[a-f0-9]{32}$/);
    const hello = socket.sent.find((p) => p.type === 'hello')!;
    expect(hello.role).toBe('host');
    expect(hello.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(hello.joinSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(hello.secret).not.toBe(hello.joinSecret);
    expect(socket.url).not.toContain(hello.secret);
    expect(socket.url).not.toContain(hello.joinSecret);
    manager.sendChat('Hello friend');
    await new Promise((r) => setImmediate(r));
    expect(manager.status().messages).toMatchObject([{ text: 'Hello friend' }]);
    expect(changed).toHaveBeenCalled();
    const left = manager.leave();
    expect(left.connection).toBe('offline');
    expect(left.invitation).toBeNull();
    expect(left.messages).toHaveLength(0);
    expect(manager.headerStatus()).toEqual({
      role: null, connection: 'offline', peers: [], selfId: null, hostOnline: false,
    });
    expect(socket.sent.some((p) => p.type === 'leave')).toBe(true);
  });

  it('joins from invite with a local owner only, not a copied ChatGPT login', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { manager } = service('Guest');
    const invite = collabInvitation('https://host.workers.dev', 'a'.repeat(32), 'b'.repeat(64));
    const state = await manager.join(invite);
    expect(state.connection).toBe('connected');
    expect(state.role).toBe('guest');
    expect(state.invitation).toBeNull();
    expect(sockets[0]!.url).toBe('wss://host.workers.dev/room/' + 'a'.repeat(32));
    const hello = sockets[0]!.sent.find((p) => p.type === 'hello')!;
    expect(hello.secret).toBe('b'.repeat(64));
    expect(hello.joinSecret).toBeUndefined();
    expect(sockets[0]!.sent.find((p) => p.type === 'payload' && (p.data as { kind?: string }).kind === 'sync-request')).toBeDefined();
    manager.leave();
  });

  it('rejects remote provider instructions, preserving the chat-only C1 boundary', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { manager } = service();
    await manager.host();
    sockets[0]!.receive({
      v: 1, type: 'payload', from: { id: 'other', name: 'Guest', role: 'guest' },
      data: { kind: 'provider-exec', provider: 'codex', command: 'read tokens' },
    });
    expect(manager.status().remoteAgentsEnabled).toBe(false);
    expect(manager.status().messages).toHaveLength(0);
    manager.leave();
  });
});
