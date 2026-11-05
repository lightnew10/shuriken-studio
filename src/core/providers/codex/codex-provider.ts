import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncQueue } from '../../util/async';
import type { ModelTier } from '@shared/domain';
import type {
  AgentEvent, AgentRunHandle, AgentRunRequest, CompletionErrorKind,
  IAgentProvider, IProviderDiagnostics, ProbeResult, ProviderAuthStatus,
  ProviderCapabilities, ProviderDetection,
} from '../types';

const RATE_LIMIT = /rate.?limit|usage limit|too many requests|quota|(?:session|weekly) limit|limit reached|\b429\b/i;
const AUTH_ERROR = /not logged in|not authenticated|please run.*login|unauthorized|authentication required/i;
const SHELL_ERROR = /not recognized as an internal or external command|command not found|ENOENT|spawn .* failed/i;

type CliEvent = {
  type: string;
  thread_id?: string;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
  item?: {
    id?: string; type?: string; text?: string; status?: string;
    command?: string; changes?: Array<{ path?: string; kind?: string }>;
    server?: string; tool?: string; arguments?: unknown; result?: unknown;
    error?: { message?: string }; output?: unknown;
  };
};

/** Codex CLI uses ChatGPT OAuth by default. No API key is created or stored by Shuriken. */
export class CodexProvider implements IAgentProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex (ChatGPT)';
  readonly adapterVersion = '0.1.0';
  readonly testedVersions: string[] = [];

  private cli(programArgs: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): ChildProcessWithoutNullStreams {
    // On Windows, npm installs codex.cmd; use the command shell for that shim.
    // The prompt is delivered via stdin, never interpolated into a shell command.
    return spawn('codex', programArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });
  }

  private async commandOutput(args: string[], env?: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = this.cli(args, { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim() });
      };
      child.on('error', (e) => { stderr += '\n' + e.message; done(false); });
      child.on('close', (code) => done(code === 0));
      const timeout = setTimeout(() => { child.kill(); done(false); }, 15_000);
      child.on('close', () => clearTimeout(timeout));
      child.on('error', () => clearTimeout(timeout));
      child.stdin.on('error', () => undefined);
      child.stdin.end();
    });
  }

  async detect(): Promise<ProviderDetection> {
    const r = await this.commandOutput(['--version']);
    const version = /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null;
    return {
      installed: r.ok && !!version,
      version,
      executable: r.ok ? 'codex' : null,
      detail: r.ok ? r.stdout : 'Codex CLI unavailable. Install @openai/codex and run codex login on this PC. ' + r.stderr,
    };
  }

  async auth(): Promise<ProviderAuthStatus> {
    return this.authFor(null);
  }

  async authFor(accountDir: string | null): Promise<ProviderAuthStatus> {
    const env = accountDir ? { CODEX_HOME: accountDir } : undefined;
    const result = await this.commandOutput(['login', 'status'], env);
    return {
      authenticated: result.ok && !/api key/i.test(result.stdout),
      method: result.ok ? (/api key/i.test(result.stdout) ? 'api key (not permitted in subscription mode)' : 'Codex CLI login') : null,
      account: null,
      plan: null,
      detail: result.ok && /api key/i.test(result.stdout)
        ? 'Codex is using a paid API key. Run codex logout and sign in with a ChatGPT subscription instead.'
        : result.ok ? result.stdout : 'Run codex login with your ChatGPT subscription. ' + (result.stderr || result.stdout),
    };
  }

  async signInCommand(accountDir: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> {
    const d = await this.detect();
    if (!d.installed) return null;
    // Use the existing Codex CLI OAuth flow. A separate CODEX_HOME isolates extra accounts.
    return { command: 'codex', args: ['login'], env: accountDir ? { CODEX_HOME: accountDir } : {} };
  }

  accountEnv(accountDir: string): Record<string, string> {
    return { CODEX_HOME: accountDir };
  }

  declaredCapabilities(): ProviderCapabilities {
    return {
      toolUse: true, mcp: true, mcpHttp: true,
      subagents: false, parallelAgents: false,
      fileEditing: true, terminal: true, streaming: true,
      backgroundExecution: true, contextCompaction: false,
      longRunningSessions: true, structuredOutput: true,
      approvalWorkflow: false, sessionPersistence: true,
      imageInput: true, imageOutput: false, interruption: true,
      webResearch: true, costReporting: false, rateLimitReporting: false,
    };
  }

  modelForTier(_tier: ModelTier): string {
    // Let the signed-in Codex CLI select its supported default model for this plan.
    return 'default';
  }

  diagnostics(): IProviderDiagnostics {
    return {
      quickChecks: async (): Promise<ProbeResult[]> => {
        const start = Date.now();
        const installed = await this.detect();
        if (!installed.installed) return [{ id: 'codex.executable', name: 'Codex CLI', status: 'unavailable', message: installed.detail, durationMs: Date.now() - start }];
        const auth = await this.auth();
        return [
          { id: 'codex.executable', name: 'Codex CLI', status: 'healthy', message: installed.detail, durationMs: Date.now() - start, data: { version: installed.version } },
          { id: 'codex.auth', name: 'Codex login', status: auth.authenticated ? 'healthy' : 'needs_configuration', message: auth.detail, durationMs: Date.now() - start },
        ];
      },
      // Live tool-use probes are intentionally not automatic: they spend the user's quota.
      deepChecks: async () => [],
    };
  }

  run(req: AgentRunRequest): AgentRunHandle {
    const events = new AsyncQueue<AgentEvent>();
    let child: ChildProcessWithoutNullStreams | null = null;
    let interrupted = false;
    const abort = () => {
      interrupted = true;
      child?.kill();
    };
    req.signal.addEventListener('abort', abort, { once: true });
    const execute = async () => {
      let temporary: string | null = null;
      let started = false;
      let finalText = '';
      let completed = false;
      let error: string | null = null;
      let sessionId: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let toolCount = 0;
      const startedAt = Date.now();
      const startedEvent = () => {
        if (started) return;
        started = true;
        events.push({ type: 'started', providerSessionId: sessionId, model: req.model || null, providerVersion: null, tools: [], toolServers: [], authSource: 'Codex CLI login' });
      };
      try {
        if (req.signal.aborted) { interrupted = true; throw new Error('Run interrupted'); }
        temporary = mkdtempSync(join(tmpdir(), 'shuriken-codex-'));
        const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', req.providerSandbox ?? 'read-only'];
        // Shuriken MCP is a per-run, short-lived server token. Its bearer is in
        // the child environment, never in shell arguments, logs or persisted files.
        const extraEnv: Record<string, string> = { ...(req.env ?? {}) };
        for (let i = 0; i < req.toolServers.length; i++) {
          const server = req.toolServers[i]!;
          if (!/^[a-zA-Z][\w-]*$/.test(server.name)) throw new Error('Unsafe MCP server identifier');
          const header = Object.entries(server.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
          const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
          const variable = 'SHURIKEN_CODEX_MCP_TOKEN_' + i;
          if (token) extraEnv[variable] = token;
          args.push('-c', 'mcp_servers.' + server.name + '.url=' + JSON.stringify(server.url));
          if (token) args.push('-c', 'mcp_servers.' + server.name + '.bearer_token_env_var=' + JSON.stringify(variable));
        }
        // The local Shuriken MCP endpoint needs loopback HTTP access. Codex's
        // workspace-write sandbox remains enabled; this also enables network access.
        if (req.toolServers.length) args.push('-c', 'sandbox_workspace_write.network_access=true');
        if (req.model && req.model !== 'default') {
          if (!/^[a-zA-Z0-9._:-]+$/.test(req.model)) throw new Error('Invalid Codex model identifier');
          args.push('--model', req.model);
        }
        if (req.outputSchema) {
          const schema = join(temporary, 'result-schema.json');
          writeFileSync(schema, JSON.stringify(req.outputSchema), 'utf8');
          args.push('--output-schema', schema);
        }
        for (let i = 0; i < (req.images ?? []).length; i++) {
          const im = req.images![i]!;
          const extension = im.mediaType.split('/')[1] === 'jpeg' ? 'jpg' : im.mediaType.split('/')[1];
          const image = join(temporary, 'reference-' + i + '.' + extension);
          writeFileSync(image, Buffer.from(im.data, 'base64'));
          args.push('--image', image);
        }
        if (req.resumeSessionId) {
          if (!/^[a-zA-Z0-9_-]{6,128}$/.test(req.resumeSessionId)) throw new Error('Invalid Codex session ID');
          args.push('resume', req.resumeSessionId);
        }
        // The actual task lives in stdin: no prompt/shell injection.
        args.push('-');
        const prompt = [req.instructions, req.prompt].filter(Boolean).join('\n\n');
        // The URL comes from Shuriken's loopback MCP server, not arbitrary external endpoints.
        child = this.cli(args, { cwd: req.cwd, env: extraEnv });
        let partial = '';
        let stderr = '';
        const record = (line: string) => {
          let evt: CliEvent;
          try { evt = JSON.parse(line) as CliEvent; } catch { return; }
          if (evt.type === 'thread.started' && evt.thread_id) {
            sessionId = evt.thread_id;
            startedEvent();
          } else if (evt.type === 'item.started' || evt.type === 'item.completed') {
            const item = evt.item;
            if (!item) return;
            const isDone = evt.type === 'item.completed';
            if (item.type === 'agent_message' && isDone && item.text) {
              finalText = item.text;
              events.push({ type: 'text', text: item.text, partial: false });
            } else if (item.type === 'reasoning' && isDone && item.text) {
              // Codex reports a high-level reasoning summary, never hidden reasoning.
              events.push({ type: 'thinking', text: item.text });
            } else if (item.type === 'command_execution' && item.id) {
              if (!isDone) { toolCount++; events.push({ type: 'tool_call', id: item.id, tool: 'Codex command', toolClass: 'shell', input: { command: item.command ?? '' }, parentId: null }); }
              else events.push({ type: 'tool_result', id: item.id, isError: item.status === 'failed', output: item.output ?? item, parentId: null });
            } else if (item.type === 'mcp_tool_call' && item.id) {
              const toolName = 'mcp__' + (item.server ?? 'unknown') + '__' + (item.tool ?? 'unknown');
              if (!isDone) { toolCount++; events.push({ type: 'tool_call', id: item.id, tool: toolName, toolClass: 'mcp', input: item.arguments ?? {}, parentId: null }); }
              else events.push({ type: 'tool_result', id: item.id, isError: item.status === 'failed' || !!item.error, output: item.result ?? item.error ?? null, parentId: null });
            } else if (item.type === 'file_change' && isDone) {
              const id = item.id ?? 'codex-file-' + toolCount++;
              events.push({ type: 'tool_call', id, tool: 'Codex patch', toolClass: 'edit_files', input: { changes: item.changes ?? [] }, parentId: null });
              events.push({ type: 'tool_result', id, isError: item.status === 'failed', output: item.changes ?? [], parentId: null });
            }
          } else if (evt.type === 'turn.completed') {
            completed = true;
            inputTokens = evt.usage?.input_tokens ?? 0;
            outputTokens = evt.usage?.output_tokens ?? 0;
          } else if (evt.type === 'turn.failed' || evt.type === 'error') {
            error = evt.error?.message ?? evt.message ?? 'Codex failed';
          }
        };
        child.stdout.on('data', (buf: Buffer) => {
          partial += buf.toString('utf8');
          let end: number;
          while ((end = partial.indexOf('\n')) !== -1) {
            const line = partial.slice(0, end).trim();
            partial = partial.slice(end + 1);
            if (line) record(line);
          }
        });
        child.stderr.on('data', (buf: Buffer) => { stderr = (stderr + buf.toString('utf8')).slice(-10000); });
        child.stdin.on('error', () => undefined);
        child.stdin.end(prompt);
        const code = await new Promise<number>((resolve) => {
          child!.on('close', (c) => resolve(c ?? 1));
          child!.on('error', (e) => { error = e.message; resolve(1); });
        });
        if (partial.trim()) record(partial.trim());
        startedEvent();
        if (code !== 0 || !completed) error ??= stderr.trim() || 'Codex CLI did not complete the turn';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        startedEvent();
      } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
        req.signal.removeEventListener('abort', abort);
        const errorKind: CompletionErrorKind | null = !error ? null : interrupted ? 'interrupted' : RATE_LIMIT.test(error) ? 'rate_limit' : AUTH_ERROR.test(error) ? 'auth' : SHELL_ERROR.test(error) ? 'environment' : 'execution';
        if (error && errorKind === 'rate_limit') events.push({ type: 'rate_limit', status: 'rejected', window: null, utilization: null, resetsAt: null, raw: { message: error } });
        let structured: unknown = null;
        if (req.outputSchema && finalText) {
          try { structured = JSON.parse(finalText); } catch { /* The orchestrator reports invalid structured output. */ }
        }
        events.push({
          type: 'completed', ok: !error && completed && !interrupted, resultText: finalText || null,
          structured, costUsd: 0, inputTokens, outputTokens,
          numTurns: toolCount + (completed ? 1 : 0), durationMs: Date.now() - startedAt,
          stopReason: completed ? 'turn_completed' : null,
          error: interrupted ? 'Run interrupted' : error,
          errorKind,
        });
        events.close();
      }
    };
    void execute();
    return { events, interrupt: async () => abort() };
  }
}
