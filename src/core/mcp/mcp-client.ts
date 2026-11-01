import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { sleep } from '../util/async';

export interface ExternalToolInfo {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export interface ExternalCallResult {
  ok: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string; [k: string]: unknown }>;
  structured?: unknown;
  error?: string;
  durationMs: number;
}

export interface StdioServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';

/**
 * Resilient MCP client over stdio. Reconnects with backoff when the server process exits,
 * refreshes tool lists on `tools/list_changed`, and never throws from `call` (errors are values).
 */
export class McpStdioConnection {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: ExternalToolInfo[] = [];
  private stderrTail: string[] = [];
  private stopping = false;
  private reconnectAttempt = 0;
  private connectPromise: Promise<void> | null = null;
  state: ConnectionState = 'disconnected';
  lastError: string | null = null;
  serverInfo: { name: string; version: string } | null = null;
  instructions: string | null = null;

  constructor(
    readonly id: string,
    private readonly resolveSpec: () => Promise<StdioServerSpec | null>,
    private readonly log: ScopedLogger,
    private readonly onChange: (conn: McpStdioConnection) => void,
    /** forbidden: true while this server must not be reached at all (tests and smoke runs: SHURIKEN_NO_STUDIO). */
    private readonly opts: { clientName: string; clientVersion: string; autoReconnect: boolean; forbidden?: () => boolean },
  ) {}

  listTools(): ExternalToolInfo[] {
    return this.tools;
  }

  stderr(): string {
    return this.stderrTail.join('');
  }

  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    // A run that must not reach this server never connects, however a call got here (the guard used to be checked only
    // by some callers: a smoke run's viewer listed and read the user's open Studio).
    if (this.opts.forbidden?.()) {
      this.lastError = 'switched off for this run';
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;
    this.stopping = false;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.setState('connecting');
    const spec = await this.resolveSpec();
    if (!spec) {
      this.lastError = 'Server executable not found';
      this.setState('failed');
      return;
    }
    try {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
        cwd: spec.cwd,
        stderr: 'pipe',
        // Screenshots can exceed the SDK's 10 MB default; an oversized line would close the transport.
        maxBufferSize: 64 * 1024 * 1024,
      } as ConstructorParameters<typeof StdioClientTransport>[0]);
      transport.stderr?.on('data', (d: Buffer) => {
        this.stderrTail.push(d.toString('utf8'));
        if (this.stderrTail.length > 60) this.stderrTail.shift();
      });
      const client = new Client({ name: this.opts.clientName, version: this.opts.clientVersion }, { capabilities: {} });
      client.onclose = () => this.handleClose();
      client.onerror = (e) => {
        this.lastError = errorMessage(e);
        this.log.warn(`${this.id} MCP error`, this.lastError);
      };
      await client.connect(transport, { timeout: 30000 });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this.refreshTools();
      });
      this.client = client;
      this.transport = transport;
      const v = client.getServerVersion();
      this.serverInfo = v ? { name: v.name, version: v.version } : null;
      this.instructions = client.getInstructions() ?? null;
      await this.refreshTools();
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.setState('connected');
      this.log.info(`${this.id} connected`, { server: this.serverInfo, tools: this.tools.length });
    } catch (e) {
      this.lastError = `${errorMessage(e)}${this.stderrTail.length ? ` | stderr: ${this.stderr().slice(-500)}` : ''}`;
      this.log.warn(`${this.id} connect failed`, this.lastError);
      await this.teardown();
      this.setState('failed');
      this.scheduleReconnect();
    }
  }

  async refreshTools(): Promise<void> {
    if (!this.client) return;
    // SDK 1.31 does not auto-paginate.
    const all: Array<{ name: string; title?: string; description?: string; inputSchema: unknown; annotations?: unknown }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: 30000 });
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = all.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
      annotations: t.annotations as Record<string, unknown> | undefined,
    }));
    this.onChange(this);
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 120000, signal?: AbortSignal): Promise<ExternalCallResult> {
    const t0 = Date.now();
    if (this.state !== 'connected' || !this.client) {
      await this.connect();
      if (this.state !== 'connected' || !this.client) {
        return { ok: false, content: [], error: `${this.id} is not connected: ${this.lastError ?? 'unknown'}`, durationMs: Date.now() - t0 };
      }
    }
    try {
      const res = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal, resetTimeoutOnProgress: true })) as {
        content?: ExternalCallResult['content'];
        isError?: boolean;
        structuredContent?: unknown;
      };
      const content = res.content ?? [];
      const ok = !res.isError;
      return {
        ok,
        content,
        structured: res.structuredContent,
        error: ok ? undefined : content.map((c) => c.text ?? '').join('\n').slice(0, 4000) || 'Tool reported an error',
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      return { ok: false, content: [], error: errorMessage(e), durationMs: Date.now() - t0 };
    }
  }

  private handleClose(): void {
    if (this.state === 'disconnected') return;
    this.log.warn(`${this.id} connection closed`, this.stderr().slice(-500));
    this.client = null;
    this.transport = null;
    this.setState(this.stopping ? 'disconnected' : 'failed');
    if (!this.stopping) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.opts.autoReconnect || this.stopping) return;
    const delay = Math.min(60000, 2000 * 2 ** this.reconnectAttempt++);
    sleep(delay)
      .then(() => {
        if (!this.stopping && this.state !== 'connected') return this.connect();
      })
      .catch(() => {});
  }

  private async teardown(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.transport = null;
    try {
      await c?.close();
    } catch {
      /* ignore */
    }
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    await this.teardown();
    this.setState('disconnected');
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.onChange(this);
  }
}
