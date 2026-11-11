import { afterEach, expect, it, vi } from 'vitest';
import type { AgentRunRequest, AgentEvent } from '../src/core/providers/types';
const state = vi.hoisted(() => ({ auth: 'chatgpt', native: false, text: '{"ok":true}', tokenCount: 20, requests: [] as Array<{ method: string; params: any }> }));
vi.mock('../src/core/providers/codex/codex-process', () => ({ codexExecutable: () => 'codex-test.exe', codexVersion: () => '0.166.0', executeCodexCommand: vi.fn() }));
vi.mock('../src/core/providers/codex/app-server', () => ({
  isolatedCodexOverrides: async () => ['mcp_servers.personal.enabled=false'], verifyCodexIsolation: vi.fn(async () => {}),
  CodexAppServer: class {
    onNotification: (method: string, params: any) => void = () => {};
    onFailure = () => {};
    async initialize() {}
    async close() {}
    async request(method: string, params: any) {
      state.requests.push({ method, params });
      if (method === 'account/read') return { account: { type: state.auth, email: 'fixture@example.invalid', planType: 'plus' } };
      if (method === 'model/list') return { data: [{ model: 'model-a', displayName: 'Model A' }] };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-123' } };
      if (method === 'turn/start') { setImmediate(() => {
        this.onNotification('thread/tokenUsage/updated', { threadId: 'thread-123', tokenUsage: { total: { inputTokens: state.tokenCount, outputTokens: 2 } } });
        this.onNotification('item/completed', { threadId: 'thread-123', item: { type: state.native ? 'commandExecution' : 'agentMessage', id: 'item-1', text: state.text } });
        this.onNotification('turn/completed', { threadId: 'thread-123', turn: { status: 'completed' } });
      }); return { turn: { id: 'turn-1' } }; }
      return {};
    }
  },
}));
import { CodexProvider } from '../src/core/providers/codex/codex-provider';

afterEach(() => { state.auth = 'chatgpt'; state.native = false; state.text = '{"ok":true}'; state.tokenCount = 20; state.requests.length = 0; });
const request = (): AgentRunRequest => ({ runId: 'fixture', role: 'critic', cwd: process.cwd(), instructions: 'Read only', prompt: 'A synthetic task', modelTier: 'fast', builtinTools: ['read_files'], toolServers: [], permission: async () => ({ allow: false, message: 'Denied' }), signal: new AbortController().signal, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
async function run(extra: Partial<AgentRunRequest> = {}) {
  const events: AgentEvent[] = [];
  for await (const event of new CodexProvider(() => 'model-a').run({ ...request(), ...extra }).events) events.push(event);
  return events.find((e) => e.type === 'completed')!;
}
it('requires explicit non-Astra models', () => {
  expect(() => new CodexProvider().modelForTier('deep')).toThrow(/explicit/);
  expect(() => new CodexProvider(() => 'astra').modelForTier('fast')).toThrow();
  expect(() => new CodexProvider(() => 'default').modelForTier('fast')).toThrow();
});
it('checks structured authentication and refuses API and unknown modes', async () => {
  for (const mode of ['apiKey', 'unknown']) { state.auth = mode; expect((await new CodexProvider().auth()).authenticated).toBe(false); expect(await run()).toMatchObject({ ok: false, errorKind: 'auth' }); }
  expect(state.requests.some((r) => r.method === 'turn/start')).toBe(false);
});
it('runs with native read-only sandbox, validates JSON schema, and reports unknown cost', async () => {
  expect(await run()).toMatchObject({ ok: true, structured: { ok: true }, inputTokens: 20, outputTokens: 2, costKnown: false });
  expect(state.requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', model: 'model-a' });
});
it('rejects invalid output instead of reporting successful structured work', async () => {
  state.text = '{"ok":"wrong type"}'; expect(await run()).toMatchObject({ ok: false, errorKind: 'output_schema' });
});
it('refuses a monetary budget that cannot be guaranteed', async () => {
  expect(await run({ maxBudgetUsd: 1 })).toMatchObject({ ok: false, errorKind: 'budget' });
  expect(state.requests).toHaveLength(0);
});
it('interrupts unexpected native execution and exceeded tokens', async () => {
  state.native = true; expect(await run()).toMatchObject({ ok: false });
  state.native = false; expect(await run({ maxTokens: 1 })).toMatchObject({ ok: false, errorKind: 'budget' });
});
it('does not resume legacy exec sessions or sessions belonging to another account', async () => {
  expect(await run({ resumeSessionId: 'old-thread' })).toMatchObject({ ok: true });
  expect(state.requests.some((r) => r.method === 'thread/resume')).toBe(false);
});
