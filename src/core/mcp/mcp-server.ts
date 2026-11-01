import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { CallerContext, ToolRegistry } from '../capabilities/tool-registry';
import type { ScopedLogger } from '../log';
import type { ToolServerRef } from '../providers/types';

export interface McpStaticResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  read: (caller: CallerContext) => Promise<string>;
}

export interface McpTemplateResource {
  name: string;
  template: string;
  title: string;
  description: string;
  mimeType: string;
  list?: (caller: CallerContext) => Promise<Array<{ uri: string; name: string }>>;
  read: (vars: Record<string, string>, caller: CallerContext) => Promise<string>;
}

export interface McpPromptDef {
  name: string;
  title: string;
  description: string;
  args: z.ZodRawShape;
  build: (args: Record<string, string>, caller: CallerContext) => Promise<string>;
}

export interface McpContentProvider {
  resources(): McpStaticResource[];
  templates(): McpTemplateResource[];
  prompts(): McpPromptDef[];
  instructions(caller: CallerContext): string;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenHash: string;
  caller: CallerContext;
  createdAt: number;
}

interface TokenEntry {
  caller: CallerContext;
  expiresAt: number | null;
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Shuriken's MCP server (Streamable HTTP on loopback). Every agent run gets its own bearer token,
 * so each tool call is attributed to a run/task/role and filtered by that role's tool set. The
 * underlying implementation can change freely; agents only see this stable tool/resource surface.
 */
export class ShurikenMcpServer {
  private http: Server | null = null;
  private port = 0;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly sessions = new Map<string, Session>();
  private readonly nonceWaiters = new Map<string, Array<() => void>>();
  private readonly seenNonces = new Set<string>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly content: McpContentProvider,
    private readonly log: ScopedLogger,
    private readonly info: { name: string; version: string },
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get running(): boolean {
    return this.http !== null;
  }

  async start(preferredPort = 0): Promise<void> {
    if (this.http) return;
    const server = createServer((req, res) => {
      // An agent that goes away mid-request (its run was stopped) is routine, and a socket error on the way out
      // must not become an uncaught exception: nobody is left to answer.
      req.on('error', () => {});
      res.on('error', () => {});
      this.handle(req, res).catch((e) => {
        if (req.destroyed || res.destroyed || res.writableEnded) {
          this.log.debug(`MCP request dropped: the client went away (${e instanceof Error ? e.message : String(e)})`);
          return;
        }
        this.log.error('MCP request failed', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        }
      });
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(preferredPort);
    } catch (e) {
      if (preferredPort === 0) throw e;
      this.log.warn(`MCP port ${preferredPort} unavailable, using a random port`, e);
      await listen(0);
    }
    this.port = (server.address() as AddressInfo).port;
    this.http = server;
    this.log.info(`MCP server listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) {
      await s.transport.close().catch(() => {});
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
  }

  /** Issue a bearer token bound to a caller context. */
  issueToken(caller: CallerContext, ttlMs: number | null = 12 * 60 * 60 * 1000): string {
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(hash(token), { caller, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    return token;
  }

  /** Register a persistent token (e.g. for the user's own MCP clients). */
  registerPersistentToken(token: string, caller: CallerContext): void {
    this.tokens.set(hash(token), { caller, expiresAt: null });
  }

  revokeToken(token: string): void {
    const h = hash(token);
    this.tokens.delete(h);
    for (const [id, s] of this.sessions) {
      if (s.tokenHash === h) {
        this.sessions.delete(id);
        // The run is over: end its connection. Closing the transport also aborts the tool calls still running
        // for it (the SDK stops their handlers from sending anything), so nothing writes to the dead stream.
        s.transport.close().catch(() => {});
        s.server.close().catch(() => {});
      }
    }
  }

  refFor(token: string, name = 'shuriken'): ToolServerRef {
    return { name, url: this.url, headers: { Authorization: `Bearer ${token}` } };
  }

  /** Probe support: the probe tool calls `observeNonce`, health checks wait on it. */
  observeNonce(nonce: string): void {
    this.seenNonces.add(nonce);
    for (const w of this.nonceWaiters.get(nonce) ?? []) w();
    this.nonceWaiters.delete(nonce);
  }

  waitForNonce(nonce: string, timeoutMs: number): Promise<boolean> {
    if (this.seenNonces.has(nonce)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      const arr = this.nonceWaiters.get(nonce) ?? [];
      arr.push(() => {
        clearTimeout(t);
        resolve(true);
      });
      this.nonceWaiters.set(nonce, arr);
    });
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: this.info.name, version: this.info.version, sessions: this.sessions.size }));
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // DNS-rebinding protection: only loopback Host headers are accepted.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      res.writeHead(403).end('Forbidden origin');
      return;
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const tokenHash = token ? hash(token) : '';
    const entry = tokenHash ? this.tokens.get(tokenHash) : undefined;
    if (!entry || (entry.expiresAt !== null && entry.expiresAt < Date.now())) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    let body: unknown = undefined;
    if (req.method === 'POST') body = await readJson(req);

    if (sid) {
      const s = this.sessions.get(sid);
      if (!s || s.tokenHash !== tokenHash) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
      await s.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(body)) {
      const caller = entry.caller;
      const server = this.buildServer(caller);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { transport, server, tokenHash, caller, createdAt: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null }));
  }

  private buildServer(caller: CallerContext): McpServer {
    const server = new McpServer(
      { name: this.info.name, version: this.info.version },
      { capabilities: { logging: {} }, instructions: this.content.instructions(caller) },
    );
    for (const def of this.tools.visibleTo(caller)) {
      server.registerTool(
        def.name,
        // A strict tool refuses arguments it doesn't name (the SDK would drop them before the registry sees them).
        { title: def.title, description: def.description, inputSchema: def.strict ? z.strictObject(def.input) : def.input, annotations: def.annotations },
        async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
          // A client that sent a progress token gets progress notifications from tools that report any
          // (each one counts as a sign of life: a call that is quiet for minutes would be given up on).
          const token = extra._meta?.progressToken;
          let ticks = 0;
          const progress =
            token === undefined
              ? undefined
              : ({ message }: { message?: string }) => {
                  void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, ...(message ? { message } : {}) } }).catch(() => undefined);
                };
          const out = await this.tools.invoke(def.name, args, caller, extra.signal, progress);
          return { content: out.content, isError: out.isError ?? false };
        },
      );
    }
    if (caller.kind !== 'probe') {
      for (const r of this.content.resources()) {
        server.registerResource(r.name, r.uri, { title: r.title, description: r.description, mimeType: r.mimeType }, async (uri) => ({
          contents: [{ uri: uri.href, mimeType: r.mimeType, text: await r.read(caller) }],
        }));
      }
      for (const t of this.content.templates()) {
        const template = new ResourceTemplate(t.template, {
          list: t.list
            ? async () => ({
                resources: (await t.list!(caller)).map((x) => ({ uri: x.uri, name: x.name, mimeType: t.mimeType })),
              })
            : undefined,
        });
        server.registerResource(t.name, template, { title: t.title, description: t.description, mimeType: t.mimeType }, async (uri, vars) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: t.mimeType,
              text: await t.read(Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])), caller),
            },
          ],
        }));
      }
      for (const p of this.content.prompts()) {
        server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.args as any }, async (args: Record<string, string>) => ({
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: await p.build(args, caller) } }],
        }));
      }
    }
    return server;
  }
}

function readJson(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
