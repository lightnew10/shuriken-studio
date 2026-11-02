import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelTier } from '@shared/domain';
import type {
  AgentEvent,
  AgentRunHandle,
  AgentRunRequest,
  IAgentProvider,
  IProviderDiagnostics,
  ProbeContext,
  ProbeResult,
  ProviderAuthStatus,
  ProviderCapabilities,
  ProviderDetection,
} from '../types';
import { runClaude } from './claude-runner';
import { carryClaudeSession } from './session-carry';
import { withTimeout } from '../../util/async';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

export interface ClaudeProviderSettings {
  /** 'bundled' uses the binary shipped with the Agent SDK; 'path' uses `claude` on PATH; otherwise an absolute path. */
  executable: 'bundled' | 'path' | string;
  models: Record<ModelTier, string>;
  appVersion: string;
}

export const DEFAULT_CLAUDE_SETTINGS: Omit<ClaudeProviderSettings, 'appVersion'> = {
  executable: 'bundled',
  models: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
};

/**
 * Claude Code via the Claude Agent SDK. Authentication uses whatever the local Claude Code
 * installation is logged in with (subscription login or API key); the adapter never handles
 * credentials itself.
 */
export class ClaudeProvider implements IAgentProvider {
  readonly id = 'claude';
  readonly displayName = 'Claude (Claude Code)';
  readonly adapterVersion = '1.0.0';
  readonly testedVersions = ['agent-sdk 0.3.284', 'claude-code 2.1.283–2.1.284'];
  private resolvedExe: string | null | undefined;

  constructor(private readonly settings: ClaudeProviderSettings) {}

  sdkVersion(): string | null {
    // The package's `exports` map hides package.json, so resolve the entry and walk up to it.
    try {
      let dir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
      for (let i = 0; i < 4; i++) {
        const pkg = join(dir, 'package.json');
        if (existsSync(pkg)) {
          const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
          if (parsed.name === '@anthropic-ai/claude-agent-sdk') return parsed.version ?? null;
        }
        dir = dirname(dir);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Path of the Claude Code executable the SDK will spawn, or null for the SDK default. */
  private async executable(): Promise<string | null> {
    // A path found earlier still has to be there: the program once renamed itself away while the app ran.
    if (this.resolvedExe !== undefined && (this.resolvedExe === null || existsSync(this.resolvedExe) || restoreMovedBinary(this.resolvedExe))) return this.resolvedExe;
    const s = this.settings.executable;
    if (s === 'bundled') {
      this.resolvedExe = bundledBinary();
    } else if (s === 'path') {
      this.resolvedExe = await whichClaude();
    } else {
      this.resolvedExe = existsSync(s) ? s : null;
    }
    return this.resolvedExe;
  }

  async detect(): Promise<ProviderDetection> {
    const exe = (await this.executable()) ?? (await whichClaude());
    if (!exe) {
      return { installed: false, version: null, executable: null, detail: 'No Claude Code executable found (bundled SDK binary missing and `claude` not on PATH).' };
    }
    try {
      const { stdout } = await execFileP(exe, ['--version'], { timeout: 20000, windowsHide: true });
      const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? stdout.trim();
      return { installed: true, version, executable: exe, detail: `Claude Code ${version} · Agent SDK ${this.sdkVersion() ?? '?'}` };
    } catch (e) {
      return { installed: false, version: null, executable: exe, detail: `Executable found but failed to run: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Claude Code keeps credentials in its config directory; one directory per account keeps logins apart. */
  accountEnv(accountDir: string): Record<string, string> {
    return { ...NO_SELF_UPDATE, CLAUDE_CONFIG_DIR: accountDir };
  }

  /** A session that another account's run left is copied to this account, so a continued run finds it (session-carry.ts). */
  carrySession(sessionId: string, toAccountDir: string, fromAccountDirs: string[]): 'there' | 'carried' | 'missing' {
    return carryClaudeSession(sessionId, toAccountDir, fromAccountDirs);
  }

  /** Claude Code's own login flow, run interactively for one account directory. */
  async signInCommand(accountDir: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> {
    const exe = (await this.executable()) ?? (await whichClaude());
    if (!exe) return null;
    // No folder: Claude Code's own default profile on this PC.
    return { command: exe, args: [], env: { ...NO_SELF_UPDATE, ...(accountDir ? { CLAUDE_CONFIG_DIR: accountDir } : {}) } };
  }

  async auth(): Promise<ProviderAuthStatus> {
    return this.authFor(null);
  }

  /** Reads account info through the SDK control channel without making a model call. */
  async authFor(accountDir: string | null): Promise<ProviderAuthStatus> {
    const abort = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* idle() {
      await gate; // never yields a user message; keeps the process alive for control requests
    }
    const exe = await this.executable();
    const q = query({
      prompt: idle(),
      options: {
        abortController: abort,
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        persistSession: false,
        env: { ...process.env, ...NO_SELF_UPDATE, CLAUDE_AGENT_SDK_CLIENT_APP: `shuriken/${this.settings.appVersion}`, ...(accountDir ? { CLAUDE_CONFIG_DIR: accountDir } : {}) },
        ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
      },
    });
    try {
      const init = await withTimeout(q.initializationResult(), 45000, 'Claude initialization');
      const acct = init.account ?? {};
      const authenticated = hasClaudeLogin(acct);
      return {
        authenticated,
        method: acct.apiKeySource && acct.apiKeySource !== 'none' ? `api key (${acct.apiKeySource})` : acct.tokenSource ?? acct.apiProvider ?? null,
        account: acct.email ?? acct.organization ?? null,
        plan: acct.subscriptionType ?? null,
        detail: authenticated
          ? `Signed in${acct.email ? ` as ${acct.email}` : ''}${acct.subscriptionType ? ` (${acct.subscriptionType})` : ''}. ${init.models?.length ?? 0} models available.`
          : 'Claude Code is not signed in. Run `claude` in a terminal and log in.',
      };
    } catch (e) {
      return { authenticated: false, method: null, account: null, plan: null, detail: `Auth check failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      release();
      try {
        q.close();
      } catch {
        abort.abort();
      }
    }
  }

  declaredCapabilities(): ProviderCapabilities {
    return {
      toolUse: true,
      mcp: true,
      mcpHttp: true,
      subagents: true,
      parallelAgents: true,
      fileEditing: true,
      terminal: true,
      streaming: true,
      backgroundExecution: true,
      contextCompaction: true,
      longRunningSessions: true,
      structuredOutput: true,
      approvalWorkflow: true,
      sessionPersistence: true,
      imageInput: true,
      imageOutput: false,
      interruption: true,
      webResearch: true,
      costReporting: true,
      rateLimitReporting: true,
    };
  }

  modelForTier(tier: ModelTier): string {
    return this.settings.models[tier];
  }

  run(req: AgentRunRequest): AgentRunHandle {
    // Never leave the path to the SDK: in a packaged app it resolves inside app.asar, where nothing can be spawned.
    if (this.resolvedExe === undefined) {
      const s = this.settings.executable;
      this.resolvedExe = s === 'bundled' || s === 'path' ? bundledBinary() : existsSync(s) ? s : bundledBinary();
    }
    const exe = this.resolvedExe ?? bundledBinary();
    return runClaude(req, {
      executablePath: exe,
      clientApp: `shuriken/${this.settings.appVersion}`,
      modelForTier: (t) => this.modelForTier(t),
    });
  }

  diagnostics(): IProviderDiagnostics {
    return {
      quickChecks: async () => {
        const t0 = Date.now();
        const det = await this.detect();
        const results: ProbeResult[] = [
          {
            id: 'claude.executable',
            name: 'Claude Code executable',
            status: det.installed ? 'healthy' : 'unavailable',
            message: det.detail,
            durationMs: Date.now() - t0,
            data: { executable: det.executable, version: det.version },
          },
        ];
        const sdk = this.sdkVersion();
        results.push({
          id: 'claude.sdk',
          name: 'Agent SDK package',
          status: sdk ? 'healthy' : 'unavailable',
          message: sdk ? `@anthropic-ai/claude-agent-sdk ${sdk} (adapter tested with ${this.testedVersions.join(', ')})` : 'Agent SDK package missing',
          durationMs: 0,
        });
        return results;
      },
      deepChecks: (ctx) => this.deepChecks(ctx),
    };
  }

  private async deepChecks(ctx: ProbeContext): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    const t0 = Date.now();
    const auth = await this.auth();
    results.push({
      id: 'claude.auth',
      name: 'Authentication',
      status: auth.authenticated ? 'healthy' : 'needs_configuration',
      message: auth.detail,
      durationMs: Date.now() - t0,
      data: { plan: auth.plan, method: auth.method },
    });
    if (!auth.authenticated) return results;

    // End-to-end probe: a tiny fast-model run that must call the probe MCP tool with a nonce and
    // return it as structured output. Verifies spawn, streaming, MCP, tool use, structured output.
    const nonce = `n${Math.random().toString(36).slice(2, 10)}`;
    const t1 = Date.now();
    const seen = { started: false, partial: false, toolCall: false, mcpConnected: false, rateLimit: false, cost: false, structured: false, subagentTool: false };
    let completion: Extract<AgentEvent, { type: 'completed' }> | null = null;
    let startedInfo: Extract<AgentEvent, { type: 'started' }> | null = null;
    const handle = this.run({
      runId: `probe-${nonce}`,
      role: 'probe',
      instructions: 'You are running an automated integration self-test. Follow the user instructions exactly and do nothing else.',
      prompt: ctx.probeServer
        ? `Call the tool "probe_submit" (from the MCP server "${ctx.probeServer.name}") exactly once with nonce "${nonce}". Then finish, returning the nonce in the structured output.`
        : `Return the nonce "${nonce}" in the structured output.`,
      cwd: ctx.cwd,
      modelTier: 'fast',
      toolServers: ctx.probeServer ? [ctx.probeServer] : [],
      builtinTools: [],
      maxTurns: 4,
      outputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false },
      permission: async () => ({ allow: true }),
      signal: ctx.signal,
    });
    try {
      for await (const ev of handle.events) {
        if (ev.type === 'started') {
          seen.started = true;
          startedInfo = ev;
          seen.mcpConnected = ev.toolServers.some((s) => s.status === 'connected');
        } else if (ev.type === 'text' && ev.partial) seen.partial = true;
        else if (ev.type === 'tool_call' && ev.tool.endsWith('probe_submit')) seen.toolCall = true;
        else if (ev.type === 'rate_limit') seen.rateLimit = true;
        else if (ev.type === 'completed') completion = ev;
      }
    } catch (e) {
      results.push({ id: 'claude.e2e', name: 'End-to-end run', status: 'unavailable', message: String(e), durationMs: Date.now() - t1 });
      return results;
    }
    const nonceObserved = ctx.waitForProbeNonce ? await ctx.waitForProbeNonce(nonce, 5000) : false;
    const comp = completion as Extract<AgentEvent, { type: 'completed' }> | null;
    seen.cost = !!comp && comp.costUsd > 0;
    seen.structured = !!comp && (comp.structured as { nonce?: string } | null)?.nonce === nonce;
    const si = startedInfo as Extract<AgentEvent, { type: 'started' }> | null;
    seen.subagentTool = !!si?.tools.some((t) => t === 'Agent' || t === 'Task');
    const ok = !!comp?.ok;
    results.push({
      id: 'claude.e2e',
      name: 'End-to-end run (fast model)',
      status: ok ? 'healthy' : 'unavailable',
      message: ok
        ? `Completed in ${comp!.durationMs} ms, cost $${comp!.costUsd.toFixed(4)}, model ${si?.model ?? '?'}`
        : `Failed: ${comp?.error ?? 'no completion'}`,
      durationMs: Date.now() - t1,
      verified: { streaming: seen.partial, structuredOutput: seen.structured, costReporting: seen.cost, rateLimitReporting: seen.rateLimit || undefined },
      data: { providerVersion: si?.providerVersion, authSource: si?.authSource, toolServers: si?.toolServers },
    });
    if (ctx.probeServer) {
      const mcpOk = seen.mcpConnected && seen.toolCall && nonceObserved;
      results.push({
        id: 'claude.mcp',
        name: 'MCP tool invocation (HTTP)',
        status: mcpOk ? 'healthy' : seen.mcpConnected ? 'degraded' : 'unavailable',
        message: mcpOk
          ? 'Agent connected to the Shuriken MCP server and invoked a tool; the server observed the call.'
          : `connected=${seen.mcpConnected} toolCall=${seen.toolCall} serverObserved=${nonceObserved}`,
        durationMs: 0,
        verified: { mcp: mcpOk, mcpHttp: seen.mcpConnected, toolUse: seen.toolCall },
      });
    }
    return results;
  }
}

/**
 * Claude Code updates itself: started interactively (the sign-in terminal) it renamed the app's own claude.exe to
 * "claude.exe.old.<time>" and put nothing in its place, so every agent failed with "native binary not found" until
 * the app was reinstalled (1.11.1 and 1.12, minutes after a sign-in). The program Shuriken ships is the one it
 * was tested with: it is told not to update itself, and a copy it moved away is put back.
 */
export const NO_SELF_UPDATE: Record<string, string> = { DISABLE_AUTOUPDATER: '1' };

/**
 * Whether what Claude Code reports at startup is a login. With none it still answers, with
 * { tokenSource: 'none', apiProvider: 'firstParty' }, so a fresh install read as signed in.
 */
export function hasClaudeLogin(acct: { email?: string; apiKeySource?: string; tokenSource?: string; apiProvider?: string }): boolean {
  const real = (v?: string) => !!v && v !== 'none';
  return !!acct.email || real(acct.apiKeySource) || real(acct.tokenSource) || (!!acct.apiProvider && acct.apiProvider !== 'firstParty');
}

/** Puts back a bundled program that renamed itself away (see NO_SELF_UPDATE). True when `exe` is there afterwards. */
export function restoreMovedBinary(exe: string): boolean {
  if (existsSync(exe)) return true;
  try {
    const dir = dirname(exe);
    const prefix = `${basename(exe)}.old.`;
    const moved = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    if (!moved.length) return false;
    copyFileSync(join(dir, moved[0]!), exe);
    return existsSync(exe);
  } catch {
    return false;
  }
}

function bundledBinary(): string | null {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  try {
    const dir = dirname(require.resolve(pkg));
    const exe = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const unpacked = exe.replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`);
    if (unpacked !== exe && restoreMovedBinary(unpacked)) return unpacked;
    if (existsSync(unpacked)) return unpacked;
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

async function whichClaude(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { timeout: 10000, windowsHide: true });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && (s.endsWith('.exe') || process.platform !== 'win32'));
    return first ?? null;
  } catch {
    return null;
  }
}
