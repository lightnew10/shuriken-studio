import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexProvider } from '../src/core/providers/codex/codex-provider';
import type { AgentRunRequest } from '../src/core/providers/types';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

type ChildStub = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };

function fakeChild(lines: unknown[], exitCode = 0): ChildStub {
  const child = new EventEmitter() as ChildStub;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', 1); return true; });
  setImmediate(() => {
    for (const item of lines) child.stdout.write(JSON.stringify(item) + '\n');
    child.stdout.end();
    child.emit('close', exitCode);
  });
  return child;
}

const mockedSpawn = vi.mocked(spawn);
afterEach(() => vi.resetAllMocks());

describe('Codex provider', () => {
  it('is registered as an independent subscription provider without automatic model selection', () => {
    const p = new CodexProvider();
    expect(p.id).toBe('codex');
    expect(p.modelForTier('deep')).toBe('default');
    expect(p.declaredCapabilities().mcp).toBe(true);
    expect(p.declaredCapabilities().approvalWorkflow).toBe(false);
  });

  it('accepts a ChatGPT Codex CLI sign-in and refuses API-key billing in subscription mode', async () => {
    mockedSpawn.mockReturnValueOnce(fakeChild([{ type: 'noop' }]) as never);
    // commandOutput looks at CLI text rather than JSON for authentication.
    const api = fakeChild([]);
    api.stdout.write('Logged in using an API key\n');
    mockedSpawn.mockReturnValueOnce(api as never);
    expect((await new CodexProvider().auth()).authenticated).toBe(false);
  });

  it('translates JSONL lifecycle, file changes and usage into Shuriken run events', async () => {
    const cli = fakeChild([
      { type: 'thread.started', thread_id: 'test-session-123' },
      { type: 'item.completed', item: { id: 'change-1', type: 'file_change', status: 'completed', changes: [{ path: 'src/hello.luau', kind: 'add' }] } },
      { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '{"ok":true}' } },
      { type: 'turn.completed', usage: { input_tokens: 123, output_tokens: 45 } },
    ]);
    mockedSpawn.mockReturnValueOnce(cli as never);
    const request: AgentRunRequest = {
      runId: 'run-1',
      role: 'implementer',
      instructions: 'Stay in the workspace',
      prompt: 'Create a small test file',
      cwd: process.cwd(),
      modelTier: 'balanced',
      toolServers: [],
      builtinTools: ['read_files', 'edit_files'],
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      permission: async () => ({ allow: true }),
      signal: new AbortController().signal,
    };
    const handle = new CodexProvider().run(request);
    const received = [];
    for await (const evt of handle.events) received.push(evt);
    expect(received.find((e) => e.type === 'started')).toMatchObject({ providerSessionId: 'test-session-123' });
    expect(received.find((e) => e.type === 'tool_call')).toMatchObject({ toolClass: 'edit_files', input: { changes: [{ path: 'src/hello.luau', kind: 'add' }] } });
    expect(received.find((e) => e.type === 'completed')).toMatchObject({
      ok: true, inputTokens: 123, outputTokens: 45, structured: { ok: true },
    });
    expect(mockedSpawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['exec', '--json', '--sandbox', 'workspace-write']), expect.any(Object));
  });
});
