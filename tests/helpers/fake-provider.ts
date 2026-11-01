import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ModelTier } from '../../src/shared/domain';
import type {
  AgentEvent,
  CompletionErrorKind,
  AgentRunHandle,
  AgentRunRequest,
  IAgentProvider,
  ProviderAuthStatus,
  ProviderCapabilities,
  ProviderDetection,
} from '../../src/core/providers/types';
import { AsyncQueue } from '../../src/core/util/async';

export interface FakeScript {
  /** Called per run; return the structured output (or throw to simulate a failure). */
  respond: (req: AgentRunRequest, kind: 'plan' | 'research' | 'work' | 'review' | 'other', call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>;
}

/**
 * Deterministic provider for tests. It exercises the real contract: it connects to the Shuriken
 * MCP server with the run's bearer token (like a real agent), can call tools, writes files through
 * the permission callback, and returns structured output.
 */
export class FakeProvider implements IAgentProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake provider';
  readonly adapterVersion = 'test';
  readonly testedVersions = ['test'];
  readonly runs: AgentRunRequest[] = [];

  constructor(private readonly script: FakeScript) {}

  async detect(): Promise<ProviderDetection> {
    return { installed: true, version: '1.0.0', executable: null, detail: 'fake' };
  }
  async auth(): Promise<ProviderAuthStatus> {
    return { authenticated: true, method: 'fake', account: 'test', plan: null, detail: 'ok' };
  }
  declaredCapabilities(): ProviderCapabilities {
    return {
      toolUse: true, mcp: true, mcpHttp: true, subagents: false, parallelAgents: true, fileEditing: true, terminal: false, streaming: true,
      backgroundExecution: false, contextCompaction: false, longRunningSessions: false, structuredOutput: true, approvalWorkflow: true,
      sessionPersistence: false, imageInput: false, imageOutput: false, interruption: true, webResearch: false, costReporting: true, rateLimitReporting: false,
    };
  }
  diagnostics() {
    return {
      quickChecks: async () => [{ id: 'fake.ok', name: 'fake', status: 'healthy' as const, message: 'ok', durationMs: 0 }],
      deepChecks: async () => [],
    };
  }
  modelForTier(tier: ModelTier): string {
    return `fake-${tier}`;
  }

  run(req: AgentRunRequest): AgentRunHandle {
    this.runs.push(req);
    const q = new AsyncQueue<AgentEvent>();
    const schema = req.outputSchema as { properties?: Record<string, unknown> } | undefined;
    const props = schema?.properties ?? {};
    const kind = 'tasks' in props ? 'plan' : 'findings' in props ? 'research' : 'verdict' in props ? 'review' : 'status' in props ? 'work' : 'other';
    (async () => {
      const t0 = Date.now();
      let client: Client | null = null;
      try {
        q.push({ type: 'started', providerSessionId: `s-${req.runId}`, model: this.modelForTier(req.modelTier), providerVersion: '1.0.0', tools: [], toolServers: req.toolServers.map((s) => ({ name: s.name, status: 'connected' })), authSource: 'fake' });
        const server = req.toolServers[0];
        const call = async (tool: string, args: Record<string, unknown>) => {
          if (!server) throw new Error('no tool server');
          if (!client) {
            client = new Client({ name: 'fake-agent', version: '1' });
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
          }
          const id = `tu_${Math.random().toString(36).slice(2)}`;
          q.push({ type: 'tool_call', id, tool: `mcp__${server.name}__${tool}`, toolClass: 'mcp', input: args, parentId: null });
          const res = await client.callTool({ name: tool, arguments: args });
          q.push({ type: 'tool_result', id, isError: !!res.isError, output: res.content, parentId: null });
          return res;
        };
        const structured = await this.script.respond(req, kind, call);
        q.push({ type: 'text', text: 'done', partial: false });
        q.push({ type: 'completed', ok: true, resultText: 'done', structured, costUsd: 0.001, inputTokens: 100, outputTokens: 50, numTurns: 1, durationMs: Date.now() - t0, stopReason: 'end_turn', error: null, errorKind: null });
      } catch (e) {
        q.push({ type: 'completed', ok: false, resultText: null, structured: null, costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: Date.now() - t0, stopReason: null, error: String(e), errorKind: (e as { errorKind?: CompletionErrorKind }).errorKind ?? 'execution' });
      } finally {
        await (client as Client | null)?.close().catch(() => {});
        q.close();
      }
    })();
    return { events: q, interrupt: async () => q.close() };
  }
}

/** Simulate a built-in Write tool call going through the permission callback. */
export async function fakeWrite(req: AgentRunRequest, relPath: string, content: string): Promise<boolean> {
  const file = join(req.cwd, relPath);
  const decision = await req.permission({ tool: 'Write', toolClass: 'edit_files', input: { file_path: file, content } });
  if (!decision.allow) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return true;
}
