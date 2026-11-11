import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AsyncQueue } from '../../util/async';
import type { ModelTier } from '@shared/domain';
import { codexModelOptions, effectiveCodexEffort, isAllowedCodexModel, type ModelListResponse } from './codex-models';
import { CodexAppServer, isolatedCodexOverrides, verifyCodexIsolation } from './app-server';
import { codexExecutable, codexVersion, executeCodexCommand } from './codex-process';
import { restoreOptionalFields, strictCodexSchema } from './structured';
import type { AgentEvent, AgentRunHandle, AgentRunRequest, CompletionErrorKind, IAgentProvider, IProviderDiagnostics, ProviderAuthStatus, ProviderCapabilities, ProviderDetection, ProviderSessionMetadata } from '../types';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ADAPTER = 'codex-appserver-2';
export const CODEX_RUN_LIMITS = { durationMs: 20 * 60_000, maxTokens: 200_000, stopGraceMs: 1500 };

/** Codex manages the existing ChatGPT credentials; Shuriken never reads/copies auth.json. */
export class CodexProvider implements IAgentProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex (ChatGPT)';
  readonly adapterVersion = '2.0.0';
  readonly testedVersions = ['0.166.0'];
  executeCommand = executeCodexCommand;
  constructor(private readonly selectedModel: (tier: ModelTier) => string = () => '', private readonly limits: () => { maxDurationMs: number; maxTokens: number } = () => ({ maxDurationMs: CODEX_RUN_LIMITS.durationMs, maxTokens: CODEX_RUN_LIMITS.maxTokens }), private readonly observeProcess?: (pid: number) => void) {}
  async usage(): Promise<unknown> {
    const server = new CodexAppServer();
    try { await server.initialize(); return (await server.request('account/rateLimits/read')).rateLimits ?? null; }
    finally { await server.close(); }
  }
  async detect(): Promise<ProviderDetection> {
    try { const executable = codexExecutable(); return { installed: true, executable, version: codexVersion(executable), detail: 'Codex App Server available' }; }
    catch (e) { return { installed: false, executable: null, version: null, detail: (e as Error).message }; }
  }
  async auth(): Promise<ProviderAuthStatus> { return this.authFor(null); }
  async authFor(accountDir: string | null): Promise<ProviderAuthStatus> {
    if (accountDir) return { authenticated: false, method: null, account: null, plan: null, detail: 'Shuriken uses the existing ChatGPT login on this PC.' };
    const server = new CodexAppServer();
    try {
      await server.initialize();
      const { account } = await server.request('account/read', { refreshToken: false });
      return { authenticated: account?.type === 'chatgpt', method: account?.type ?? null, account: account?.type === 'chatgpt' ? account.email ?? null : null, plan: account?.planType ?? null,
        detail: account?.type === 'chatgpt' ? 'Existing ChatGPT login' : 'A ChatGPT login is required; API and unknown modes are refused.' };
    } finally { await server.close(); }
  }
  async signInCommand(accountDir: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> { return accountDir ? null : { command: codexExecutable(), args: ['login'], env: {} }; }
  modelForTier(tier: ModelTier): string {
    const model = this.selectedModel(tier);
    if (!model || model === 'default' || !isAllowedCodexModel(model)) throw new Error('Select an explicit non-Astra Codex model in Settings.');
    return model;
  }
  declaredCapabilities(): ProviderCapabilities {
    return { toolUse: true, mcp: true, mcpHttp: true, subagents: false, parallelAgents: false, fileEditing: true, terminal: true, streaming: true, backgroundExecution: true, contextCompaction: false, longRunningSessions: true, structuredOutput: true, approvalWorkflow: true, sessionPersistence: true, imageInput: true, imageOutput: false, interruption: true, webResearch: false, costReporting: false, rateLimitReporting: true };
  }
  diagnostics(): IProviderDiagnostics {
    return { quickChecks: async () => {
      const start = Date.now(), d = await this.detect();
      if (!d.installed) return [{ id: 'codex.executable', name: 'Codex CLI', status: 'unavailable', message: d.detail, durationMs: Date.now() - start }];
      const auth = await this.auth();
      let terminal = false;
      if (process.platform === 'win32') {
        const server = new CodexAppServer();
        try {
          await server.initialize();
          const { config } = await server.request('config/read', { includeLayers: false }, 4000);
          terminal = config?.windows?.sandbox === 'elevated' && (await server.request('windowsSandbox/readiness', {}, 4000)).status === 'ready';
        } catch { /* An unknown sandbox must not be reported available. */ }
        finally { await server.close(); }
      }
      return [
        { id: 'codex.executable', name: 'Codex App Server', status: 'healthy', message: d.detail, durationMs: Date.now() - start, data: { version: d.version }, available: { terminal } },
        { id: 'codex.auth', name: 'ChatGPT login', status: auth.authenticated ? 'healthy' : 'needs_configuration', message: auth.detail, durationMs: Date.now() - start },
      ];
    }, deepChecks: async (ctx) => {
      const start = Date.now(), nonce = randomUUID();
      const probeServer = ctx.probeServer;
      if (!probeServer || !ctx.waitForProbeNonce) return [];
      let streamed = false, completed: Extract<AgentEvent, { type: 'completed' }> | undefined;
      const run = this.run({
        runId: `probe-${nonce}`, role: 'probe', cwd: ctx.cwd, modelTier: 'fast', effort: 'low',
        instructions: 'Run only the Shuriken connection check.',
        prompt: `Call the Shuriken MCP tool probe_submit with nonce "${nonce}". Then return the nonce as JSON.`,
        builtinTools: [], toolServers: [{ ...probeServer, name: 'shuriken' }],
        outputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false },
        permission: async () => ({ allow: false, message: 'Only the probe tool is allowed.' }),
        signal: ctx.signal, maxDurationMs: 60_000,
      });
      for await (const event of run.events) {
        if (event.type === 'text' && event.partial) streamed = true;
        if (event.type === 'completed') completed = event;
      }
      const structured = !!completed?.ok && (completed.structured as { nonce?: string } | null)?.nonce === nonce;
      const observed = !!completed?.ok && await ctx.waitForProbeNonce(nonce, 3000);
      return [{ id: 'codex.e2e', name: 'Codex MCP round trip', status: structured && observed ? 'healthy' : 'degraded', message: structured && observed ? 'Shuriken received the probe and Codex returned it as structured output' : completed?.error ?? 'Probe result could not be verified', durationMs: Date.now() - start, verified: { streaming: streamed, structuredOutput: structured, toolUse: observed, mcp: observed, mcpHttp: observed } }];
    } };
  }
  run(req: AgentRunRequest): AgentRunHandle {
    const events = new AsyncQueue<AgentEvent>();
    let server: CodexAppServer | null = null, threadId: string | null = null, turnId: string | null = null;
    let interrupted = false, errorKind: CompletionErrorKind | null = null;
    let settle: ((error?: Error) => void) | null = null;
    let stopping: Promise<void> | null = null;
    const abort = () => stopping ??= (async () => {
      interrupted = true;
      req.stopTools?.();
      if (server && threadId && turnId) await server.request('turn/interrupt', { threadId, turnId }, CODEX_RUN_LIMITS.stopGraceMs).catch(() => {});
      await server?.close(); settle?.(new Error('Run interrupted'));
    })();
    const onAbort = () => { void abort(); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    const startedAt = Date.now();
    void (async () => {
      let error: string | null = null, text = '', structured: unknown = null, completed = false;
      let inputTokens = 0, outputTokens = 0, baseInput = 0, baseOutput = 0, metadata: ProviderSessionMetadata | undefined;
      let temporary: string | null = null;
      const tools = new Set<string>();
      const reported = new Set<string>();
      const limits = this.limits();
      const timeout = setTimeout(() => { errorKind = 'interrupted'; void abort(); }, req.maxDurationMs ?? limits.maxDurationMs);
      try {
        if (req.signal.aborted || interrupted) throw new Error('Run interrupted');
        if (req.maxBudgetUsd !== undefined) { errorKind = 'budget'; throw new Error('A strict USD budget cannot be guaranteed by a ChatGPT subscription.'); }
        const model = req.model ?? this.modelForTier(req.modelTier);
        if (!model || model === 'default' || !isAllowedCodexModel(model)) throw new Error('An explicit non-Astra model is required');
        const version = codexVersion(), overrides = await isolatedCodexOverrides(undefined, req.cwd);
        const allowedServers: Array<{ name: string; url: string; bearer: string }> = [], env: Record<string, string> = {};
        for (const [index, s] of req.toolServers.entries()) {
          if (s.name !== 'shuriken') throw new Error('Only Shuriken MCP is allowed');
          // Stable namespace across resumes; isolation is provided by the process and run bearer.
          const name = index === 0 ? 'shuriken_controlled' : `shuriken_controlled_${index}`, url = new URL(s.url);
          if (overrides.includes(`mcp_servers.${name}.enabled=false`)) throw new Error('The reserved Shuriken MCP server name is already configured in Codex');
          if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Shuriken MCP must use loopback');
          const token = Object.entries(s.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]?.replace(/^Bearer\s+/i, '');
          if (!token) throw new Error('Shuriken MCP bearer missing');
          const variable = `SHURIKEN_CODEX_TOKEN_${index}`;
          env[variable] = token; allowedServers.push({ name, url: s.url, bearer: variable });
          // Only this authenticated loopback server handles approvals, before any tool effect.
          overrides.push(`mcp_servers.${name}.url=${JSON.stringify(s.url)}`, `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(variable)}`, `mcp_servers.${name}.enabled=true`, `mcp_servers.${name}.required=true`, `mcp_servers.${name}.default_tools_approval_mode="approve"`);
        }
        if (interrupted) throw new Error('Run interrupted');
        server = new CodexAppServer({ env, overrides, cwd: req.cwd });
        if (server.pid) this.observeProcess?.(server.pid);
        await server.initialize(); await verifyCodexIsolation(server, allowedServers);
        const { account } = await server.request('account/read', { refreshToken: false });
        if (account?.type !== 'chatgpt') { errorKind = 'auth'; throw new Error('Only an existing ChatGPT subscription login is permitted'); }
        const catalog: ModelListResponse = await server.request('model/list', { limit: 100, includeHidden: false });
        if (!codexModelOptions(catalog).some((m) => m.id === model)) throw new Error('Selected Codex model is unavailable or excluded');
        metadata = { adapter: ADAPTER, account: digest([account.email, account.planType]), policy: digest([version, req.cwd, req.role, req.builtinTools, req.providerSandbox, model, req.instructions, req.permissionFingerprint]) };
        const compatible = !!(req.resumeSessionId && req.sessionMetadata?.adapter === metadata.adapter && req.sessionMetadata.account === metadata.account && req.sessionMetadata.policy === metadata.policy);
        if (compatible) { baseInput = req.sessionMetadata?.inputTokens ?? 0; baseOutput = req.sessionMetadata?.outputTokens ?? 0; }
        if (req.resumeSessionId && !compatible) events.push({ type: 'notice', level: 'info', message: 'Codex session incompatible; rebuilding context from Shuriken.' });
        const common = { model, modelProvider: 'openai', cwd: req.cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: req.instructions + '\nUse ONLY Shuriken MCP workspace_read_file, workspace_search, workspace_write_file and workspace_exec for files and commands. Native shell, apply_patch, browsers and delegation are unavailable. Never bypass these controls. Use expectedSha256 from a read, or absent for a new file.', config: { web_search: 'disabled' } };
        const started = compatible ? await server.request('thread/resume', { ...common, threadId: req.resumeSessionId, excludeTurns: true }) : await server.request('thread/start', common);
        threadId = started.thread.id;
        if (!threadId) throw new Error('Codex did not return a thread ID');
        const toolNames: string[] = [];
        for (const { name: serverName } of allowedServers) {
          const inventory = await server.request('mcpServerStatus/list', { threadId, serverName, detail: 'toolsAndAuthOnly' });
          const status = inventory.data?.find((entry: { name: string }) => entry.name === serverName);
          if (!status || status.toolsError) throw new Error('Codex could not discover the Shuriken MCP tools');
          toolNames.push(...Object.keys(status.tools ?? {}));
        }
        if (allowedServers.length && !toolNames.length) throw new Error('Codex discovered no authorized Shuriken MCP tools');
        events.push({ type: 'started', providerSessionId: threadId, model, providerVersion: version, tools: toolNames, toolServers: allowedServers.map(({ name }) => ({ name, status: 'connected' })), authSource: 'ChatGPT', sessionMetadata: metadata });
        let resolveTurn!: () => void, rejectTurn!: (e: Error) => void;
        const finished = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        void finished.catch(() => {});
        settle = (e) => e ? rejectTurn(e) : resolveTurn(); server.onFailure = rejectTurn;
        server.onNotification = (method, p) => {
          if (p?.threadId && p.threadId !== threadId) return;
          if (method === 'turn/started') turnId = p.turn.id;
          if (method === 'item/started' && p.item?.type === 'mcpToolCall' && !tools.has(p.item.id)) {
            tools.add(p.item.id); events.push({ type: 'tool_call', id: p.item.id, tool: 'mcp__shuriken__' + p.item.tool, toolClass: 'mcp', input: p.item.arguments ?? {}, parentId: null });
          }
          if (method === 'item/completed') {
            const item = p.item;
            if (item?.type === 'agentMessage') { text = item.text ?? ''; events.push({ type: 'text', text, partial: false }); }
            if (item?.type === 'mcpToolCall' && !reported.has(item.id)) {
              reported.add(item.id);
              events.push({ type: 'tool_result', id: item.id, isError: item.status !== 'completed' || !!item.error || !!item.result?.isError, output: item.result ?? item.error, parentId: null });
            }
            if (item?.type === 'fileChange' || item?.type === 'commandExecution') { errorKind = 'execution'; void abort(); }
          }
          if (method === 'item/agentMessage/delta') events.push({ type: 'text', text: p.delta ?? '', partial: true });
          if (method === 'account/rateLimits/updated') {
            const primary = p.rateLimits?.primary;
            if (primary) events.push({ type: 'rate_limit', status: primary.usedPercent >= 100 ? 'rejected' : 'allowed', window: 'primary', utilization: primary.usedPercent / 100, resetsAt: primary.resetsAt ?? null, raw: {} });
          }
          if (method === 'thread/tokenUsage/updated') {
            const u = p.tokenUsage?.total;
            inputTokens = Math.max(0, (u?.inputTokens ?? 0) - baseInput);
            outputTokens = Math.max(0, (u?.outputTokens ?? 0) - baseOutput);
            if (inputTokens + outputTokens >= (req.maxTokens ?? limits.maxTokens)) { errorKind = 'budget'; void abort(); }
          }
          if (method === 'turn/completed') { completed = p.turn?.status === 'completed'; if (completed) resolveTurn(); else rejectTurn(new Error(p.turn?.error?.message ?? `Codex turn ${p.turn?.status}`)); }
        };
        const input: unknown[] = [{ type: 'text', text: toolNames.length ? `Shuriken MCP tools available for this run: ${toolNames.join(', ')}. Discover them under the Shuriken MCP namespace before concluding a tool is missing.\n\n${req.prompt}` : req.prompt }];
        if (req.images?.length) {
          temporary = mkdtempSync(join(tmpdir(), 'shuriken-codex-'));
          for (const [i, image] of req.images.entries()) {
            const path = join(temporary, `reference-${i}.${image.mediaType.split('/')[1]}`); writeFileSync(path, Buffer.from(image.data, 'base64'));
            if (image.caption) input.push({ type: 'text', text: image.caption }); input.push({ type: 'localImage', path });
          }
        }
        const effort = effectiveCodexEffort(catalog.data?.find((entry) => (entry.model || entry.id) === model), req.effort);
        if (req.effort && effort !== req.effort) events.push({ type: 'notice', level: 'info', message: `Codex reasoning effort: ${effort} (${req.effort} is unavailable for ${model})` });
        const response = await server.request('turn/start', { threadId, input, model, ...(effort ? { effort } : {}), ...(req.outputSchema ? { outputSchema: strictCodexSchema(req.outputSchema) } : {}) });
        turnId = response.turn.id; if (interrupted) await abort(); await finished;
        if (req.outputSchema) {
          try { structured = restoreOptionalFields(JSON.parse(text), req.outputSchema); if (!z.fromJSONSchema(req.outputSchema).safeParse(structured).success) throw new Error('Schema mismatch'); }
          catch { errorKind = 'output_schema'; throw new Error('Codex returned invalid structured output'); }
        }
      } catch (e) {
        error = (e as Error).message;
        errorKind ??= interrupted ? 'interrupted' : /quota|rate.?limit|usage limit|429/i.test(error) ? 'rate_limit' : /\b401\b|unauthori[sz]ed|login required|token.*expired/i.test(error) ? 'auth' : 'execution';
      } finally {
        clearTimeout(timeout); await stopping; await server?.close();
        if (temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch {} } req.signal.removeEventListener('abort', onAbort);
        if (metadata) metadata = { ...metadata, inputTokens: baseInput + inputTokens, outputTokens: baseOutput + outputTokens };
        events.push({ type: 'completed', ok: completed && !error && !interrupted, resultText: text || null, structured, costUsd: 0, costKnown: false, inputTokens, outputTokens, numTurns: turnId ? tools.size + 1 : 0, durationMs: Date.now() - startedAt, stopReason: completed ? 'turn_completed' : null, error, errorKind, sessionMetadata: metadata });
        events.close();
      }
    })();
    return { events, interrupt: abort };
  }
}
