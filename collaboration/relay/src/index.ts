import { DurableObject } from 'cloudflare:workers';
import {
  COLLAB_MAX_FRAME_BYTES, COLLAB_MAX_PEERS, COLLAB_RECONNECT_MS, COOP_INVITE_MS,
  parseCollabPayload, validCollabName, validRoomSecret, validRoomId,
  type CollabClientFrame, type CollabPeer, type CollabServerFrame, type CoopClientFrame, type CoopServerFrame,
} from '../../../src/shared/collaboration';

export interface Env { COLLAB_ROOMS: DurableObjectNamespace<CollabRoom> }
type Auth = { hostHash: string; guestHash: string; lostHostAt: number | null };
type CoopAuth = Auth & { expires: number; resumeHash: string | null };
type SocketMember = (CollabPeer & { protocol?: 2 }) | { id: ''; name: ''; role: 'pending' };
const encoder = new TextEncoder();
const hash = async (value: string): Promise<string> => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');
const send = (ws: WebSocket, frame: CollabServerFrame | CoopServerFrame) => {
  try { ws.send(JSON.stringify(frame)); } catch { /* disconnected */ }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET')
      return Response.json({ service: 'shuriken-collaboration', version: 1, coopVersion: 2, ok: true });
    const room = /^\/room\/([a-f0-9]{32})$/.exec(path)?.[1];
    if (!room || !validRoomId(room) || request.method !== 'GET') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Open this invitation in Shuriken Studio', { status: 426 });
    if (request.headers.has('Origin')) return new Response('Browser clients disabled', { status: 403 });
    return env.COLLAB_ROOMS.getByName(room).fetch(request);
  },
};

export class CollabRoom extends DurableObject<Env> {
  private room: string | null = null;

  private members(protocol: 1 | 2 = 1): Array<{ ws: WebSocket; info: CollabPeer }> {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const att = ws.deserializeAttachment() as SocketMember | null;
      return (att?.role === 'host' || att?.role === 'guest') && (att.protocol ?? 1) === protocol
        ? [{ ws, info: { id: att.id, role: att.role, name: att.name } }] : [];
    });
  }
  private broadcast(frame: CollabServerFrame, recipient?: string): void {
    for (const { ws, info } of this.members()) if (!recipient || recipient === info.id) send(ws, frame);
  }
  private presence(): void {
    this.broadcast({ v: 1, type: 'presence', peers: this.members().map(({ info }) => info) });
  }
  private async endSession(): Promise<void> {
    await this.ctx.storage.delete(['auth', 'coop-auth']);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, 'Host ended the session'); } catch { /* disconnected */ }
    }
  }

  private coopPresence(): void {
    const members = this.members(2);
    for (const { ws } of members) send(ws, { v: 2, type: 'presence', peers: members.map(({ info }) => info) });
  }

  private async coopMessage(ws: WebSocket, member: SocketMember | null, msg: CoopClientFrame): Promise<void> {
    if (!member || member.role === 'pending') {
      if (msg.type !== 'hello' || !['host', 'guest'].includes(msg.role) || !validRoomSecret(msg.secret) || typeof msg.name !== 'string')
        return void ws.close(1008, 'Authentication required');
      let name: string;
      try { name = validCollabName(msg.name); } catch { return void ws.close(1008, 'Invalid name'); }
      const encoded = await hash(msg.secret);
      const resumeHash = validRoomSecret(msg.resume ?? '') ? await hash(msg.resume!) : null;
      const invitationHash = validRoomSecret(msg.joinSecret ?? '') ? await hash(msg.joinSecret!) : null;
      const accepted = await this.ctx.storage.transaction(async (tx) => {
        let auth = await tx.get<CoopAuth>('coop-auth');
        if (msg.role === 'host') {
          if (encoded.slice(0, 32) !== (this.ctx.id.name ?? this.room) || (auth && auth.hostHash !== encoded) || (!auth && !invitationHash)) return false;
          auth ??= { hostHash: encoded, guestHash: invitationHash!, expires: Date.now() + COOP_INVITE_MS, resumeHash: null, lostHostAt: null };
          auth.lostHostAt = null;
        } else {
          if (!auth || !resumeHash || (auth.lostHostAt !== null && Date.now() - auth.lostHostAt >= COLLAB_RECONNECT_MS)) return false;
          if (auth.resumeHash) {
            if (encoded !== auth.resumeHash && !(encoded === auth.guestHash && resumeHash === auth.resumeHash)) return false;
          } else {
            if (encoded !== auth.guestHash || Date.now() >= auth.expires) return false;
            auth.resumeHash = resumeHash;
          }
        }
        await tx.put('coop-auth', auth);
        return true;
      });
      if (!accepted) return void ws.close(1008, 'Invitation invalid, expired or already used');
      for (const peer of this.members(2)) if (peer.info.role === msg.role) peer.ws.close(4001, 'Authenticated peer reconnected');
      const self: CollabPeer = { id: crypto.randomUUID(), name, role: msg.role };
      ws.serializeAttachment({ ...self, protocol: 2 });
      send(ws, { v: 2, type: 'welcome', self, peers: this.members(2).map(({ info }) => info) });
      this.coopPresence();
      return;
    }
    if (member.protocol !== 2) return void ws.close(1002, 'Protocol mismatch');
    if (msg.type === 'leave') {
      if (member.role === 'host') await this.endSession();
      else { ws.close(1000, 'Guest left'); this.coopPresence(); }
      return;
    }
    if (msg.type !== 'secure' || typeof msg.to !== 'string' || typeof msg.packet !== 'string') return void ws.close(1008, 'Encrypted frames required');
    const peer = this.members(2).find(({ info }) => info.id === msg.to && info.role !== member.role);
    if (peer) send(peer.ws, { v: 2, type: 'secure', from: { id: member.id, name: member.name, role: member.role }, packet: msg.packet });
  }

  async fetch(request: Request): Promise<Response> {
    const room = /^\/room\/([a-f0-9]{32})$/.exec(new URL(request.url).pathname)?.[1];
    if (!room) return new Response('Invalid room', { status: 400 });
    this.room = room;
    if (this.ctx.getWebSockets().length >= COLLAB_MAX_PEERS + 3)
      return new Response('Room at capacity', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: 'pending', id: '', name: '' } satisfies SocketMember);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || encoder.encode(raw).byteLength > COLLAB_MAX_FRAME_BYTES)
      return void ws.close(1009, 'Frame too large');
    let msg: (CollabClientFrame & { joinSecret?: string }) | CoopClientFrame;
    try { msg = JSON.parse(raw) as typeof msg; } catch { return void ws.close(1007, 'Invalid JSON'); }
    const member = ws.deserializeAttachment() as SocketMember | null;
    if (msg?.v === 2) return this.coopMessage(ws, member, msg);
    if (msg?.v !== 1 || typeof msg.type !== 'string' || (member?.role !== 'pending' && member?.protocol === 2)) return void ws.close(1002, 'Protocol mismatch');
    if (!member || member.role === 'pending') {
      if (msg.type !== 'hello' || (msg.role !== 'host' && msg.role !== 'guest') ||
        !validRoomSecret(msg.secret) || typeof msg.name !== 'string') return void ws.close(1008, 'Authentication required');
      let name: string;
      try { name = validCollabName(msg.name); } catch { return void ws.close(1008, 'Invalid name'); }
      const encoded = await hash(msg.secret);
      let auth = await this.ctx.storage.get<Auth>('auth');
      if (msg.role === 'host') {
        // Durable Objects may hibernate between messages; instance fields are not durable.
        // Reconstruct the room name from the Durable Object ID on every host handshake.
        if (encoded.slice(0, 32) !== (this.ctx.id.name ?? this.room) || (auth && auth.hostHash !== encoded))
          return void ws.close(1008, 'Host token rejected');
        if (!auth) {
          if (!validRoomSecret(msg.joinSecret ?? '')) return void ws.close(1008, 'Missing guest invitation key');
          auth = { hostHash: encoded, guestHash: await hash(msg.joinSecret!), lostHostAt: null };
        }
        for (const peer of this.members()) if (peer.info.role === 'host')
          peer.ws.close(4001, 'New authenticated host connection');
        auth.lostHostAt = null;
        await this.ctx.storage.put('auth', auth);
      } else {
        if (!auth || encoded !== auth.guestHash ||
          (auth.lostHostAt !== null && Date.now() - auth.lostHostAt >= COLLAB_RECONNECT_MS))
          return void ws.close(1008, 'Invitation invalid or expired');
      }
      const identity: CollabPeer = { id: crypto.randomUUID(), name, role: msg.role };
      ws.serializeAttachment(identity);
      send(ws, { v: 1, type: 'welcome', self: identity, peers: this.members().map(({ info }) => info) });
      this.presence();
      return;
    }
    if (msg.type === 'leave') {
      if (member.role === 'host') await this.endSession();
      else { ws.close(1000, 'Guest left'); this.presence(); }
      return;
    }
    if (msg.type !== 'payload') return void ws.close(1008, 'Invalid operation');
    if (member.role === 'guest' && !this.members().some(({ info }) => info.role === 'host'))
      return send(ws, { v: 1, type: 'error', reason: 'Host is offline; wait for reconnection.' });
    const data = parseCollabPayload(msg.data, member.role === 'host');
    if (!data) return send(ws, { v: 1, type: 'error', reason: 'Unauthorized or invalid event' });
    if (msg.to && (member.role !== 'host' || typeof msg.to !== 'string')) return void ws.close(1008, 'Only host may address peers');
    if (data.kind === 'chat') {
      // Override untrusted sender fields. All peers see the server-attested author.
      data.message.from = member.id;
      data.message.sender = member.name;
      data.message.at = new Date().toISOString();
    }
    // Instructions from a guest are delivered ONLY to the authenticated host.
    // Other guests see the accepted user message through host-originated Director events,
    // not unvalidated commands from another participant.
    if (data.kind === 'director-request') {
      const host = this.members().find(({ info }) => info.role === 'host');
      if (!host) return send(ws, { v: 1, type: 'error', reason: 'Host unavailable' });
      send(host.ws, { v: 1, type: 'payload', from: member, data });
      return;
    }
    this.broadcast({ v: 1, type: 'payload', from: member, data }, msg.to);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const member = ws.deserializeAttachment() as SocketMember | null;
    if (member?.role !== 'pending' && member?.protocol === 2) {
      if (member.role === 'host' && !this.members(2).some(({ ws: other, info }) => other !== ws && info.role === 'host')) {
        const auth = await this.ctx.storage.get<CoopAuth>('coop-auth');
        if (auth) {
          auth.lostHostAt = Date.now();
          await this.ctx.storage.put('coop-auth', auth);
          await this.ctx.storage.setAlarm(auth.lostHostAt + COLLAB_RECONNECT_MS);
        }
      }
      this.coopPresence();
      return;
    }
    if (member?.role === 'host' && !this.members().some(({ ws: peer, info }) => info.role === 'host' && peer !== ws)) {
      const auth = await this.ctx.storage.get<Auth>('auth');
      if (auth) {
        auth.lostHostAt = Date.now();
        await this.ctx.storage.put('auth', auth);
        await this.ctx.storage.setAlarm(Date.now() + COLLAB_RECONNECT_MS);
      }
    }
    this.presence();
  }

  async alarm(): Promise<void> {
    const coop = await this.ctx.storage.get<CoopAuth>('coop-auth');
    if (coop && !this.members(2).some(({ info }) => info.role === 'host') && coop.lostHostAt !== null && Date.now() - coop.lostHostAt >= COLLAB_RECONNECT_MS) await this.endSession();
    if (this.members().some(({ info }) => info.role === 'host')) return;
    const auth = await this.ctx.storage.get<Auth>('auth');
    if (auth && auth.lostHostAt !== null && Date.now() - auth.lostHostAt >= COLLAB_RECONNECT_MS)
      await this.endSession();
  }
}
