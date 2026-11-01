import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LINK_PORTS, LINK_VERSION } from './plugin';

/**
 * The end of Shuriken Link inside a core: what the Studio plugin (plugin.ts) calls. Loopback only. It takes three
 * requests, all from the plugin: hello (does one of this core's places match, and both proofs), poll (commands for a
 * session, held until there are some) and result. Luau reaches Studio only from inside the core (`run`); nothing
 * that arrives over HTTP is ever run here, and nothing arrives that a web page could send: requests with an Origin,
 * a foreign Host or no session key are refused.
 */

export type LinkDm = 'Edit' | 'Server' | 'Client';

export interface LinkPlace {
  /** The Studio window (the Edit instance's id; a playtest's instances carry it). */
  studio: string;
  /** DataModel.Name: the place file's name, or a published place's name. */
  place: string;
  placeId: number;
  gameId: number;
}

export interface LinkRunResult {
  ok: boolean;
  text: string;
  durationMs: number;
}

export interface LinkServerOptions {
  /** The key the plugin file was written with (hex). */
  key: () => string;
  /**
   * Is this place one this core works on? Asked for an Edit instance's hello; `previous` is the studio id the place
   * carried from an earlier link (the same place under a new name after a publish).
   */
  claims: (place: LinkPlace, previous: string | null) => boolean;
  /** A linked place now has another name or id (it was published, or saved as another file). */
  renamed?: (before: LinkPlace, now: LinkPlace) => void;
  /** Sessions came or went. */
  changed?: () => void;
  /** An Edit session of a claimed place said hello and never polled: its plugin could not check this core's proof (it holds another key). */
  unproven?: (place: LinkPlace) => void;
  ports?: readonly number[];
  log?: (line: string) => void;
  now?: () => number;
}

/** How long a poll is held, how long a session lives without one, and how long a hello waits for its first poll. */
export const LINK_TIMING = { holdMs: 25_000, deadMs: 40_000, pendingMs: 15_000, goneMs: 2500, maxBody: 8_000_000 };

interface Command {
  id: string;
  code: string;
  resolve: (r: LinkRunResult) => void;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  sent: boolean;
}

interface Session {
  id: string;
  key: string;
  dm: LinkDm;
  place: LinkPlace;
  /** Its first authenticated poll has arrived (a hello alone links nothing). */
  live: boolean;
  createdAt: number;
  lastSeen: number;
  queue: Command[];
  running: Command | null;
  cancel: string[];
  /** The poll being held; `finish(false)` answers it without handing out a command (a newer poll took its place). */
  waiter: { finish: (dispatch?: boolean) => void; timer: NodeJS.Timeout } | null;
  bye: boolean;
  goneTimer: NodeJS.Timeout | null;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** The proof a core gives a plugin: it covers the port, so a proof obtained from one port is no use on another. */
export const serverProof = (key: string, pluginNonce: string, serverNonce: string, port: number) => sha(`${key}|server|${pluginNonce}|${serverNonce}|${port}`);
/** The key of one session, derived on both sides and never sent before the server's proof was checked. */
export const sessionKey = (key: string, pluginNonce: string, serverNonce: string, session: string) => sha(`${key}|client|${pluginNonce}|${serverNonce}|${session}`);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What a command answers when its Studio stopped answering (it froze, or closed): the plugin links again when it is back. */
export const LINK_LOST = /stopped answering through Shuriken Link/;

export class LinkServer {
  private server: Server | null = null;
  private listening: number | null = null;
  private readonly sessions = new Map<string, Session>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private readonly o: LinkServerOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  get port(): number | null {
    return this.listening;
  }

  /** Listens on the first free port of the range (127.0.0.1 only). False when every port is taken. */
  async start(): Promise<boolean> {
    if (this.server) return true;
    for (const port of this.o.ports ?? LINK_PORTS) {
      const server = createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, { error: 'failed' })));
      const ok = await new Promise<boolean>((done) => {
        server.once('error', () => done(false));
        server.listen(port, '127.0.0.1', () => done(true));
      });
      if (ok) {
        this.server = server;
        // Port 0 (tests) lets the system choose: what counts is where it listens.
        const at = server.address();
        this.listening = at && typeof at === 'object' ? at.port : port;
        // A long-poll may be held: never let the server close it for being slow.
        server.keepAliveTimeout = 70_000;
        server.headersTimeout = 75_000;
        this.sweep = setInterval(() => this.reap(), 5000);
        this.sweep.unref?.();
        this.o.log?.(`Shuriken Link listens on 127.0.0.1:${this.listening}`);
        return true;
      }
      server.close();
    }
    this.o.log?.('Shuriken Link found no free port');
    return false;
  }

  async stop(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    for (const s of [...this.sessions.values()]) this.drop(s, 'Shuriken closed');
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  // ─── What the core asks ─────────────────────────────────────────────────────

  /** The live sessions (one per Studio window and DataModel). */
  list(): Array<{ dm: LinkDm; place: LinkPlace; busy: boolean; ageMs: number }> {
    return [...this.sessions.values()].filter((s) => s.live).map((s) => ({ dm: s.dm, place: s.place, busy: !!s.running || s.queue.length > 0, ageMs: this.now() - s.createdAt }));
  }

  private find(match: (p: LinkPlace) => boolean, dm: LinkDm): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) if (s.live && !s.bye && s.dm === dm && match(s.place) && (!best || s.createdAt > best.createdAt)) best = s;
    return best;
  }

  /** Is there a live session for this DataModel of a place `match` accepts? */
  has(match: (p: LinkPlace) => boolean, dm: LinkDm): boolean {
    return !!this.find(match, dm);
  }

  /** The place a live Edit session of `match` reports (its current name and ids). */
  place(match: (p: LinkPlace) => boolean): LinkPlace | null {
    return this.find(match, 'Edit')?.place ?? null;
  }

  /** Waits (at most `maxMs`) for the session of a playtest's DataModel: its plugin instance starts with the playtest. */
  async waitFor(match: (p: LinkPlace) => boolean, dm: LinkDm, maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (!this.find(match, dm)) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  /**
   * Runs Luau in a DataModel of the place through the plugin. Null when no session serves it (the caller takes
   * another way). Commands of one session run one after another, in order; sessions run side by side.
   */
  run(match: (p: LinkPlace) => boolean, dm: LinkDm, code: string, timeoutMs: number, signal?: AbortSignal): Promise<LinkRunResult> | null {
    const s = this.find(match, dm);
    if (!s) return null;
    return new Promise<LinkRunResult>((resolve) => {
      const cmd: Command = { id: randomBytes(9).toString('base64url'), code, resolve, startedAt: this.now(), timer: null, sent: false };
      let settled = false;
      const settle = (r: Omit<LinkRunResult, 'durationMs'>, finished: boolean) => {
        if (settled) return;
        settled = true;
        if (cmd.timer) clearTimeout(cmd.timer);
        cmd.timer = null;
        signal?.removeEventListener('abort', onAbort);
        const at = s.queue.indexOf(cmd);
        if (at >= 0) s.queue.splice(at, 1);
        if (s.running === cmd) {
          s.running = null;
          // Given up while the plugin's thread may still be running it: have it stopped.
          if (cmd.sent && !finished) s.cancel.push(cmd.id);
          this.pump(s);
        }
        resolve({ ...r, durationMs: this.now() - cmd.startedAt });
      };
      const onAbort = () => settle({ ok: false, text: 'The call was cancelled.' }, false);
      cmd.resolve = (r) => settle(r, true);
      cmd.timer = setTimeout(() => settle({ ok: false, text: `execute_luau timed out after ${Math.round(timeoutMs / 1000)} s (through Shuriken Link)` }, false), Math.max(1000, timeoutMs));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      s.queue.push(cmd);
      this.pump(s);
    });
  }

  /** A playtest ended: its server and client sessions are over (their DataModels are gone). */
  endPlay(match: (p: LinkPlace) => boolean): void {
    for (const s of [...this.sessions.values()]) if (s.dm !== 'Edit' && match(s.place)) this.drop(s, "The playtest ended while this ran, so there's no result.");
  }

  /** Lets go of a place (its project closed): the plugin looks for another core. */
  release(match: (p: LinkPlace) => boolean): void {
    for (const s of this.sessions.values()) {
      if (!match(s.place)) continue;
      s.bye = true;
      s.waiter?.finish();
    }
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  private pump(s: Session): void {
    if (s.running || !s.queue.length) {
      if (s.cancel.length) s.waiter?.finish();
      return;
    }
    s.waiter?.finish();
  }

  private drop(s: Session, why: string): void {
    if (!this.sessions.delete(s.id)) return;
    if (s.goneTimer) clearTimeout(s.goneTimer);
    s.waiter?.finish();
    const all = [...(s.running ? [s.running] : []), ...s.queue];
    s.running = null;
    s.queue = [];
    for (const c of all) c.resolve({ ok: false, text: why, durationMs: 0 });
    if (s.live) this.o.changed?.();
  }

  private reap(): void {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      if (!s.live && now - s.createdAt > LINK_TIMING.pendingMs) {
        this.drop(s, 'never polled');
        if (s.dm === 'Edit') this.o.unproven?.(s.place);
      }
      else if (s.live && !s.waiter && now - s.lastSeen > LINK_TIMING.deadMs) {
        // Silent because it is busy: the command it was handed has not answered yet. Luau that builds for a minute
        // or two without yielding (a heavy project's world builder) keeps the plugin from asking again, and the
        // session used to be dropped after 40 s of that: the build was answered "Studio stopped answering",
        // everything queued behind it failed with it, and the plugin linked again when the build was done (all night,
        // in one project). The command's own timeout decides; the silence counts again once it is over.
        if (s.running?.sent) continue;
        this.drop(s, 'Studio stopped answering through Shuriken Link.');
      }
    }
  }

  // ─── HTTP ───────────────────────────────────────────────────────────────────

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.writableEnded) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > LINK_TIMING.maxBody) return null;
      chunks.push(c as Buffer);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the plugin calls: a browser page sends an Origin, and a rebound DNS name another Host.
    const host = String(req.headers.host ?? '');
    if (req.method !== 'POST' || req.headers.origin !== undefined || req.headers.referer !== undefined || (host !== `127.0.0.1:${this.listening}` && host !== `localhost:${this.listening}`)) return this.send(res, 403, { error: 'refused' });
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return this.send(res, 403, { error: 'refused' });
    const body = await this.body(req);
    if (!body) return this.send(res, 400, { error: 'bad request' });
    if (req.url === '/link/hello') return this.hello(body, res);
    const s = typeof body.session === 'string' ? this.sessions.get(body.session) : undefined;
    const bearer = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!s || !bearer || !same(bearer, s.key)) return this.send(res, 401, { error: 'unknown session' });
    if (req.url === '/link/poll') return this.poll(s, body, res);
    if (req.url === '/link/result') return this.result(s, body, res);
    return this.send(res, 404, { error: 'unknown' });
  }

  private hello(body: Record<string, unknown>, res: ServerResponse): void {
    const dm = body.dm === 'Edit' || body.dm === 'Server' || body.dm === 'Client' ? body.dm : null;
    const studio = typeof body.studio === 'string' && /^[\w-]{8,64}$/.test(body.studio) ? body.studio : null;
    const nonce = typeof body.nonce === 'string' && /^[\w-]{8,64}$/.test(body.nonce) ? body.nonce : null;
    if (!dm || !studio || !nonce || body.v !== LINK_VERSION || this.listening === null) return this.send(res, 200, { claimed: false, ...(body.v !== LINK_VERSION ? { version: LINK_VERSION } : {}) });
    let place: LinkPlace;
    if (dm === 'Edit') {
      place = { studio, place: String(body.place ?? '').slice(0, 300), placeId: Number(body.placeId) || 0, gameId: Number(body.gameId) || 0 };
      const previous = typeof body.prev === 'string' && /^[\w-]{8,64}$/.test(body.prev) ? body.prev : null;
      let mine = false;
      try {
        mine = this.o.claims(place, previous);
      } catch {
        mine = false;
      }
      if (!mine) return this.send(res, 200, { claimed: false });
    } else {
      // A playtest's instance: linked only through its window's Edit session.
      const edit = [...this.sessions.values()].find((x) => x.live && x.dm === 'Edit' && x.place.studio === studio);
      if (!edit) return this.send(res, 200, { claimed: false });
      place = edit.place;
    }
    const key = this.o.key();
    const serverNonce = randomBytes(16).toString('hex');
    const id = randomBytes(16).toString('hex');
    const now = this.now();
    this.sessions.set(id, { id, key: sessionKey(key, nonce, serverNonce, id), dm, place, live: false, createdAt: now, lastSeen: now, queue: [], running: null, cancel: [], waiter: null, bye: false, goneTimer: null });
    this.send(res, 200, { claimed: true, session: id, nonce: serverNonce, proof: serverProof(key, nonce, serverNonce, this.listening) });
  }

  private poll(s: Session, body: Record<string, unknown>, res: ServerResponse): void {
    s.lastSeen = this.now();
    if (s.goneTimer) clearTimeout(s.goneTimer);
    s.goneTimer = null;
    if (!s.live) {
      s.live = true;
      // The newest instance of a window's DataModel is the one: an older session of it is over.
      for (const old of [...this.sessions.values()]) if (old !== s && old.live && old.dm === s.dm && old.place.studio === s.place.studio) this.drop(old, 'Studio reloaded the plugin.');
      this.o.log?.(`Shuriken Link: ${s.dm} of "${s.place.place}" is linked`);
      this.o.changed?.();
    }
    // The Edit instance says what its place is called with every poll: a publish renames it.
    if (s.dm === 'Edit' && typeof body.place === 'string') {
      const now: LinkPlace = { studio: s.place.studio, place: body.place.slice(0, 300), placeId: Number(body.placeId) || 0, gameId: Number(body.gameId) || 0 };
      if (now.place !== s.place.place || now.placeId !== s.place.placeId) {
        const before = s.place;
        s.place = now;
        for (const other of this.sessions.values()) if (other.place.studio === now.studio) other.place = now;
        try {
          this.o.renamed?.(before, now);
        } catch {
          /* the core's own business */
        }
      }
    }
    // One poll at a time: an older one still held was given up by the plugin, so it gets nothing to run.
    s.waiter?.finish(false);
    const answer = (dispatch = true) => {
      const commands: Array<{ id: string; code: string }> = [];
      if (dispatch && !s.running && s.queue.length && !s.bye) {
        const cmd = s.queue.shift()!;
        s.running = cmd;
        cmd.sent = true;
        commands.push({ id: cmd.id, code: cmd.code });
      }
      const cancel = dispatch ? s.cancel.splice(0) : [];
      this.send(res, 200, { commands, ...(cancel.length ? { cancel } : {}), ...(dispatch && s.bye ? { bye: true } : {}) });
      if (dispatch && s.bye) this.drop(s, 'The project let go of this place.');
    };
    if ((!s.running && s.queue.length) || s.cancel.length || s.bye) return answer();
    const timer = setTimeout(() => waiter.finish(), LINK_TIMING.holdMs);
    const waiter = {
      timer,
      finish: (dispatch = true) => {
        if (s.waiter !== waiter) return;
        s.waiter = null;
        clearTimeout(timer);
        s.lastSeen = this.now();
        answer(dispatch);
      },
    };
    s.waiter = waiter;
    // The request went away while it was held: Studio closed, the playtest stopped, or the plugin was reloaded.
    // (The response's close, not the request's: a request closes as soon as its body has been read.)
    res.on('close', () => {
      if (s.waiter !== waiter || res.writableEnded) return;
      s.waiter = null;
      clearTimeout(timer);
      s.goneTimer = setTimeout(() => this.drop(s, s.dm === 'Edit' ? 'Studio closed, or its Shuriken Link plugin stopped.' : "The playtest ended while this ran, so there's no result."), LINK_TIMING.goneMs);
    });
  }

  private result(s: Session, body: Record<string, unknown>, res: ServerResponse): void {
    s.lastSeen = this.now();
    const cmd = s.running;
    if (cmd && body.id === cmd.id) cmd.resolve({ ok: body.ok === true, text: typeof body.text === 'string' ? body.text : String(body.text ?? ''), durationMs: 0 });
    this.send(res, 200, { ok: true });
  }
}
