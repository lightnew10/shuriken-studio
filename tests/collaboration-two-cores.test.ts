import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationService } from '../src/core/collaboration/collaboration-service';
import { EventBus } from '../src/core/events';
import { parseCollabPayload, type CollabPeer, type CollabDirectorSummary } from '../src/shared/collaboration';

const active = new Set<LoopbackSocket>();
let nextMemberId = 0;
let sharedGuestSecret: string | null = null;
class LoopbackSocket {
  static readonly OPEN = 1;
  readyState = 0;
  peer: CollabPeer | null = null;
  private handlers = new Map<string, Array<(ev: any) => void>>();
  constructor(readonly url: string) {
    active.add(this);
    queueMicrotask(() => { this.readyState = 1; this.notify('open', {}); });
  }
  addEventListener(name: string, fn: (ev: any) => void): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
  }
  private notify(name: string, data: unknown): void {
    for (const fn of this.handlers.get(name) ?? []) fn(data);
  }
  private frame(frame: unknown): void { this.notify('message', { data: JSON.stringify(frame) }); }
  private presence(): void {
    const peers = [...active].flatMap((s) => s.peer ? [s.peer] : []);
    for (const member of active) if (member.peer)
      member.frame({ v: 1, type: 'presence', peers });
  }
  send(raw: string): void {
    const input = JSON.parse(raw) as Record<string, any>;
    if (input.type === 'hello') {
      if (input.role === 'host') sharedGuestSecret = input.joinSecret;
      else if (input.secret !== sharedGuestSecret) throw new Error('Invalid test invitation');
      this.peer = { id: 'member-' + ++nextMemberId, name: input.name, role: input.role };
      this.frame({ v: 1, type: 'welcome', self: this.peer,
        peers: [...active].flatMap((s) => s.peer ? [s.peer] : []) });
      this.presence();
      return;
    }
    if (input.type === 'leave') { this.close(); return; }
    if (input.type !== 'payload' || !this.peer) return;
    const data = parseCollabPayload(input.data, this.peer.role === 'host');
    if (!data) { this.frame({ v: 1, type: 'error', reason: 'Invalid event' }); return; }
    if (data.kind === 'chat') {
      data.message.from = this.peer.id;
      data.message.sender = this.peer.name;
    }
    const recipients = [...active].filter((s) => !!s.peer &&
      (data.kind === 'director-request' ? s.peer?.role === 'host' :
        input.to ? input.to === s.peer?.id : true));
    for (const socket of recipients)
      socket.frame({ v: 1, type: 'payload', from: this.peer, data });
  }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    active.delete(this);
    this.notify('close', { code, reason });
    this.presence();
  }
}
const nativeSocket = globalThis.WebSocket;
afterEach(() => {
  for (const socket of [...active]) socket.close();
  active.clear();
  nextMemberId = 0;
  sharedGuestSecret = null;
  vi.stubGlobal('WebSocket', nativeSocket);
});

function factory(name: string, onGuestRequest: (peer: CollabPeer, id: string, text: string) => void) {
  const bus = new EventBus();
  let relay: string | null = 'https://collab.example.workers.dev';
  let displayName: string | null = name;
  let allowed = false;
  return new CollaborationService({
    bus, getRelay: () => relay, saveRelay: (value) => { relay = value; },
    getName: () => displayName, saveName: (value) => { displayName = value; },
    getAllowGuestRequests: () => allowed, saveAllowGuestRequests: (value) => { allowed = value; },
    onGuestRequest,
    localProject: () => ({ name: 'Impulse Simulator', projectId: 'game', taskCount: 1 }),
    localTasks: () => [{ id: 'task-1', title: 'Arena setup', role: 'builder', status: 'running', updatedAt: new Date().toISOString() }],
    localDirector: () => [{ id: 'msg-1', role: 'director', kind: 'text', text: 'Building an arena', createdAt: new Date().toISOString() }] as CollabDirectorSummary[],
    localRuns: () => [{ id: 'run-1', taskId: 'task-1', role: 'builder', status: 'running', startedAt: new Date().toISOString(), endedAt: null }],
  });
}

describe('two independent Shuriken collaboration cores', () => {
  it('routes a guest request to the host once and mirrors host Director, tasks and agent state', async () => {
    vi.stubGlobal('WebSocket', LoopbackSocket);
    const executed: Array<{ peer: string; id: string; text: string }> = [];
    let host: CollaborationService;
    host = factory('Owner', (peer, id, text) => {
      executed.push({ peer: peer.name, id, text });
      host.shareDirector({ id: 'msg-guest-' + id, role: 'user', kind: 'text', text,
        sender: peer.name, createdAt: new Date().toISOString() });
    });
    await host.host();
    const invite = host.status().invitation!;
    const guest = factory('Friend', () => { throw new Error('Guest may not execute Director'); });
    await guest.join(invite);
    expect(guest.status().remoteProject?.name).toBe('Impulse Simulator');
    expect(guest.status().remoteTasks[0]?.title).toBe('Arena setup');
    expect(guest.status().remoteRuns[0]?.role).toBe('builder');
    expect(guest.status().guestRequestsEnabled).toBe(false);
    expect(() => guest.requestDirector('Create a Roblox UI')).toThrow('not enabled');
    host.setGuestRequests(true);
    expect(guest.status().guestRequestsEnabled).toBe(true);

    const req = guest.requestDirector('Create a Roblox UI');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ peer: 'Friend', id: req.id, text: 'Create a Roblox UI' });
    expect(guest.status().requests[0]?.status).toBe('accepted');
    expect(guest.status().remoteDirector.find((m) => m.text === 'Create a Roblox UI')?.sender).toBe('Friend');

    const participant = [...active].find((socket) => socket.peer?.role === 'guest')!;
    participant.send(JSON.stringify({ v: 1, type: 'payload', data: {
      kind: 'director-request', id: req.id, text: 'Create a Roblox UI',
    } }));
    expect(executed).toHaveLength(1);

    host.shareTyping(true);
    expect(guest.status().directorTyping).toBe(true);
    host.shareActivity({ runId: 'run-1', taskId: 'task-1', kind: 'tool-use', at: new Date().toISOString() });
    expect(guest.status().remoteActivity[0]?.kind).toBe('tool-use');
    // An unexpected network loss keeps the room, and the existing host automatically
    // re-authenticates; the guest resynchronizes without creating a second Studio.
    const hostSocket = [...active].find((socket) => socket.peer?.role === 'host')!;
    hostSocket.close(1006, 'network outage');
    expect(host.status().connection).toBe('reconnecting');
    expect(guest.status().hostOnline).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    expect(host.status().connection).toBe('connected');
    expect(guest.status().hostOnline).toBe(true);
    expect(guest.status().remoteTasks[0]?.title).toBe('Arena setup');

    host.setGuestRequests(false);
    expect(guest.status().guestRequestsEnabled).toBe(false);
    guest.leave();
    host.leave();
  });
});
