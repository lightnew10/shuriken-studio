import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { codexEnvironment, codexExecutable, stopCodexProcess } from './codex-process';

export const CODEX_DISABLED_FEATURES = ['apps', 'plugins', 'hooks', 'shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode', 'code_mode_host_grpc', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'image_generation', 'memories', 'remote_plugin', 'skill_search', 'skill_mcp_dependency_install', 'goals'];
const ISOLATION_OVERRIDES = ['features.code_mode_host=true', 'features.skip_host_skill_discovery=true', 'features.omit_skill_descriptions=true', 'project_doc_max_bytes=0', 'web_search="disabled"'];
const MAX_FRAME = 8 * 1024 * 1024;
type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private buffer = '';
  private stopped = false;
  private closing: Promise<void> | null = null;
  get pid(): number | undefined { return this.child.pid; }
  onNotification: (method: string, params: any) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(options: { executable?: string; env?: Record<string, string>; overrides?: string[]; cwd?: string } = {}) {
    // ChatGPT models on 0.166 route MCP through the local Code Mode host.
    const args = ['app-server', '--listen', 'stdio://', ...CODEX_DISABLED_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]), ...[...ISOLATION_OVERRIDES, ...(options.overrides ?? [])].flatMap((value) => ['-c', value])];
    this.child = spawn(options.executable ?? codexExecutable(), args, { cwd: options.cwd, env: codexEnvironment(options.env), windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: 'pipe' });
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', (bytes: Buffer) => {
      this.buffer += decoder.write(bytes);
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) return this.fail(new Error('Codex RPC frame exceeded 8 MiB'));
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        let message: RpcMessage;
        try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid Codex JSON-RPC')); return; }
        if (!message || typeof message !== 'object') { this.fail(new Error('Invalid Codex RPC message')); return; }
        if (message.method && message.id !== undefined) {
          // Unknown approvals/elicitation never grant access. Controlled Shuriken MCP handles effects.
          this.send({ id: message.id, error: { code: -32601, message: 'Shuriken does not authorize native requests' } });
        } else if (message.method) {
          try { this.onNotification(message.method, message.params); }
          catch { this.fail(new Error('Invalid Codex notification payload')); return; }
        }
        else if (typeof message.id === 'number') {
          const waiter = this.pending.get(message.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer); this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message ?? 'Codex RPC error'));
          else if (Object.hasOwn(message, 'result')) waiter.resolve(message.result);
          else { waiter.reject(new Error('Invalid Codex RPC response')); this.fail(new Error('Invalid Codex RPC response')); }
        }
      }
    });
    this.child.stderr.on('data', () => {}); // Drain, but never persist provider diagnostics containing credentials.
    this.child.stdin.on('error', (e) => this.fail(e));
    this.child.on('error', (e) => this.fail(e));
    this.child.on('close', () => { if (!this.stopped) this.fail(new Error('Codex App Server closed unexpectedly')); });
  }

  private send(value: RpcMessage): void {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Codex App Server stopped'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'shuriken_studio', title: 'Shuriken Studio', version: '2.0.0' } });
    this.send({ method: 'initialized', params: {} });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.onFailure(error);
    void this.close(error);
  }

  close(error = new Error('Codex App Server stopped')): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const w of this.pending.values()) { clearTimeout(w.timer); w.reject(error); }
    this.pending.clear();
    this.closing = (async () => {
      // Give the server a chance to flush session history on stdio EOF.
      await new Promise<void>((resolve) => {
        if (this.child.exitCode !== null || !this.child.pid) { resolve(); return; }
        const done = () => { clearTimeout(timer); this.child.off('close', done); resolve(); };
        const timer = setTimeout(done, 600);
        this.child.once('close', done);
        this.child.stdin.end();
      });
      await stopCodexProcess(this.child);
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    })();
    return this.closing;
  }
}

/** Empty TOML tables MERGE with user config. Enumerate and explicitly disable every inherited server. */
export async function isolatedCodexOverrides(env?: Record<string, string>, cwd?: string): Promise<string[]> {
  const discovery = new CodexAppServer({ env, cwd });
  try {
    await discovery.initialize();
    const { config } = await discovery.request('config/read', { includeLayers: false });
    return Object.keys(config?.mcp_servers ?? {}).map((name) => {
      // CLI overrides split on dots; quoting a segment creates a different entry.
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Cannot safely disable an inherited MCP server identifier');
      return `mcp_servers.${name}.enabled=false`;
    });
  } finally { await discovery.close(); }
}

export async function verifyCodexIsolation(server: CodexAppServer, allowed: Array<{ name: string; url: string; bearer: string }> = []): Promise<void> {
  const { config } = await server.request('config/read', { includeLayers: false });
  for (const { name, url, bearer } of allowed) {
    const entry = config?.mcp_servers?.[name];
    if (!entry || entry.enabled !== true || entry.required !== true || entry.default_tools_approval_mode !== 'approve' || entry.url !== url ||
        entry.bearer_token_env_var !== bearer || entry.command || entry.http_headers_helper || entry.http_headers || entry.env_http_headers) {
      throw new Error('Shuriken MCP transport or approval configuration differs from the expected loopback setup');
    }
  }
  for (const [name, entry] of Object.entries(config?.mcp_servers ?? {}) as Array<[string, any]>) {
    if (entry.enabled !== false && !allowed.some((server) => server.name === name)) throw new Error('Inherited MCP server is still enabled');
  }
  for (const feature of CODEX_DISABLED_FEATURES) if (config?.features?.[feature] !== false) throw new Error(`Codex isolation failed: ${feature}`);
  if (config?.web_search !== 'disabled' || config?.project_doc_max_bytes !== 0 || config?.model_instructions_file ||
      config?.features?.skip_host_skill_discovery !== true || config?.features?.omit_skill_descriptions !== true) {
    throw new Error('Codex inherited instructions, skills or web search are not isolated');
  }
}
