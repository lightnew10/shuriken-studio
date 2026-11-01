import { randomBytes } from 'node:crypto';
import { serverProof, sessionKey, type LinkDm } from '../../src/core/roblox/link/link-server';
import { LINK_VERSION } from '../../src/core/roblox/link/plugin';

/**
 * The Studio plugin's side of Shuriken Link, in TypeScript: the same requests the Luau makes (hello with a nonce,
 * the server's proof checked before anything else is sent, then polls and results under the session's key). The
 * Luau itself is proven live (tests/e2e/link.e2e.ts); this drives the core's end.
 */
export interface FakePluginOptions {
  port: number;
  key: string;
  dm: LinkDm;
  studio: string;
  place?: string;
  placeId?: number;
  gameId?: number;
  prev?: string | null;
  /** What "running" code gives (default: echoes the code). */
  exec?: (code: string) => Promise<{ ok: boolean; text: string }> | { ok: boolean; text: string };
}

export class FakePlugin {
  session: { id: string; key: string } | null = null;
  ran: string[] = [];
  cancelled: string[] = [];
  place: string;
  placeId: number;
  private stopped = false;
  private polling: AbortController | null = null;
  done: Promise<void> = Promise.resolve();

  constructor(private readonly o: FakePluginOptions) {
    this.place = o.place ?? 'arena.rbxlx';
    this.placeId = o.placeId ?? 0;
  }

  private post(path: string, body: unknown, bearer?: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.o.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body), signal });
  }

  /** The handshake. False when the core doesn't claim the place; throws when its proof is wrong. */
  async hello(): Promise<boolean> {
    const nonce = randomBytes(12).toString('hex');
    const res = await this.post('/link/hello', { v: LINK_VERSION, dm: this.o.dm, studio: this.o.studio, nonce, place: this.place, placeId: this.placeId, gameId: this.o.gameId ?? 0, ...(this.o.prev ? { prev: this.o.prev } : {}) });
    const r = (await res.json()) as { claimed?: boolean; session?: string; nonce?: string; proof?: string };
    if (!r.claimed || !r.session || !r.nonce) return false;
    if (r.proof !== serverProof(this.o.key, nonce, r.nonce, this.o.port)) throw new Error('the server did not prove it holds the key');
    this.session = { id: r.session, key: sessionKey(this.o.key, nonce, r.nonce, r.session) };
    return true;
  }

  /** One poll (held by the server until there is something). */
  async poll(): Promise<{ status: number; commands: Array<{ id: string; code: string }>; cancel: string[]; bye: boolean }> {
    this.polling = new AbortController();
    const res = await this.post('/link/poll', { session: this.session!.id, place: this.place, placeId: this.placeId, gameId: this.o.gameId ?? 0 }, this.session!.key, this.polling.signal);
    if (res.status !== 200) return { status: res.status, commands: [], cancel: [], bye: false };
    const r = (await res.json()) as { commands?: Array<{ id: string; code: string }>; cancel?: string[]; bye?: boolean };
    return { status: 200, commands: r.commands ?? [], cancel: r.cancel ?? [], bye: r.bye === true };
  }

  async result(id: string, ok: boolean, text: string): Promise<number> {
    return (await this.post('/link/result', { session: this.session!.id, id, ok, text }, this.session!.key)).status;
  }

  /** Says hello and serves commands until stopped or let go, as the plugin's loop does. */
  async start(): Promise<boolean> {
    if (!(await this.hello())) return false;
    this.done = (async () => {
      while (!this.stopped) {
        let p: Awaited<ReturnType<FakePlugin['poll']>>;
        try {
          p = await this.poll();
        } catch {
          break;
        }
        if (p.status !== 200) break;
        this.cancelled.push(...p.cancel);
        for (const cmd of p.commands) {
          void (async () => {
            this.ran.push(cmd.code);
            const r = await (this.o.exec ?? ((code: string) => ({ ok: true, text: `ran: ${code}` })))(cmd.code);
            if (!this.stopped) await this.result(cmd.id, r.ok, r.text).catch(() => 0);
          })();
        }
        if (p.bye) break;
      }
    })();
    // The first poll is what makes the session live.
    await new Promise((r) => setTimeout(r, 30));
    return true;
  }

  /** Studio closed, or the playtest ended: the held poll is dropped without a word. */
  stop(): void {
    this.stopped = true;
    this.polling?.abort();
  }
}
