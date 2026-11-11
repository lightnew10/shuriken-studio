// Diagnostic reproductions only. Passing assertions below demonstrate current defects,
// not acceptance criteria for the application. No real provider or Studio is called.
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { CodexProvider } from '../../../src/core/providers/codex/codex-provider';
import { filesEditedBy, filesInFlight } from '../../../src/core/roblox/code-sync';
import { editsInFlight } from '../../../src/core/orchestrator/file-claims';
import { CollaborationService } from '../../../src/core/collaboration/collaboration-service';
import { EventBus } from '../../../src/core/events';
import { KilnWorkspace } from '../../../src/core/modeling/kiln-modeling';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { AgentRunRequest } from '../../../src/core/providers/types';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
import { spawn } from 'node:child_process';

function child(lines: unknown[], stdout = '', stderr = '') {
  const c = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  setImmediate(() => {
    c.stdout.write(stdout + lines.map((l) => JSON.stringify(l) + '\n').join(''));
    c.stderr.write(stderr);
    c.emit('close', 0);
  });
  return c;
}
afterEach(() => vi.resetAllMocks());

it('AUD-01: Codex executes beyond maxTurns without asking the supplied permission callback', async () => {
  vi.mocked(spawn).mockReturnValueOnce(child([
    { type: 'thread.started', thread_id: 'audit-thread' },
    ...[1, 2, 3].flatMap((i) => [
      { type: 'item.started', item: { type: 'command_execution', id: String(i), command: 'echo audit' } },
      { type: 'item.completed', item: { type: 'command_execution', id: String(i), status: 'completed' } },
    ]),
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ]) as never);
  const permission = vi.fn(async () => ({ allow: false, message: 'Denied' }));
  const req: AgentRunRequest = {
    runId: 'audit', role: 'critic', instructions: '', prompt: 'synthetic probe', cwd: process.cwd(),
    modelTier: 'fast', toolServers: [], builtinTools: ['read_files'], maxTurns: 1,
    maxBudgetUsd: 0.01, permission, signal: new AbortController().signal,
  };
  const events = [];
  for await (const ev of new CodexProvider().run(req).events) events.push(ev);
  expect(permission).not.toHaveBeenCalled();
  expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(3);
  expect(events.find((e) => e.type === 'completed')).toMatchObject({ ok: true, numTurns: 4 });
});

it('AUD-02: in-flight file protection ignores the actual Codex patch audit shape', () => {
  const project = {
    root: process.cwd(),
    store: { all: () => [{ id: 'run-a', task_id: 'task-a' }] },
    audit: { toolCalls: () => [{ tool: 'Codex patch', args: { changes: [{ path: 'src/Server/Combat.luau', kind: 'update' }] } }] },
  } as any;
  expect(filesEditedBy(project, 'run-a')).toEqual([]);
  expect(filesInFlight(project, 'run-b')).toEqual([]);
  expect(editsInFlight(project, 'task-b').size).toBe(0);
  // Control: the same helper does find a Claude edit.
  project.audit.toolCalls = () => [{ tool: 'Edit', args: { file_path: 'src/Server/Combat.luau' } }];
  expect(filesEditedBy(project, 'run-a')).toEqual(['src/Server/Combat.luau']);
});

it('AUD-03: 500 rejected requests evict a receipt and let an accepted instruction run twice', () => {
  let allow = true;
  const work = vi.fn();
  const service = new CollaborationService({
    bus: new EventBus(), getRelay: () => '', saveRelay: () => {}, getName: () => 'Audit', saveName: () => {},
    localProject: () => ({ name: 'Audit', projectId: null, taskCount: 0 }),
    localTasks: () => [], localDirector: () => [], localRuns: () => [],
    getAllowGuestRequests: () => allow, saveAllowGuestRequests: (v) => { allow = v; }, onGuestRequest: work,
  });
  const internal = service as any;
  internal.transmit = vi.fn(); // no socket is opened
  const peer = { id: randomUUID(), role: 'guest', name: 'Audit' };
  const original = randomUUID();
  internal.receiveGuestRequest(peer, original, 'Original instruction');
  allow = false;
  for (let i = 0; i < 500; i++) internal.receiveGuestRequest(peer, randomUUID(), 'Rejected filler');
  allow = true;
  internal.receiveGuestRequest(peer, original, 'Original instruction');
  expect(work).toHaveBeenCalledTimes(2);
});

it('AUD-04: login status reporting API-key mode on stderr is accepted as subscription auth', async () => {
  vi.mocked(spawn).mockReturnValueOnce(child([], '', 'Logged in using an API key\n') as never);
  const status = await new CodexProvider().auth();
  expect(status.authenticated).toBe(true);
  expect(status.method).toBe('Codex CLI login');
});

it('AUD-05: a failed Roblox model export is returned as a successful Kiln execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-kiln-export-'));
  try {
    const ws = Object.create(KilnWorkspace.prototype) as any;
    Object.assign(ws, {
      root, name: 'Audit', parts: [{ name: 'OldPart' }], version: 1,
      run: (fn: (id: string) => unknown) => fn('audit'),
      svc: {
        exportDir: root,
        kiln: { get: async () => ({}), supports: () => false, post: async (path: string) => path.endsWith('/python')
          ? { ok: true, changed: true, version: 2, output: 'Python succeeded' }
          : { ok: false, error: 'Synthetic export failure' } },
        log: { warn: vi.fn() },
      },
    });
    const result = await ws.exec('# synthetic', 1000);
    expect(ws.svc.log.warn).toHaveBeenCalledWith(expect.stringContaining('failed'), 'Synthetic export failure');
    expect(result).toMatchObject({ ok: true, error: null, changed: true, parts: [{ name: 'OldPart' }], size: null });
    expect(result.notes).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('AUD-06: malformed or incomplete performance JSON is marked within budget', () => {
  // Execute the original private pure function verbatim, without exposing/changing app source.
  const source = readFileSync('src/core/verification/verifier.ts', 'utf8');
  const begin = source.indexOf('function judgePerf(');
  const end = source.indexOf('/** The text of a playtest', begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const code = stripTypeScriptTypes(source.slice(begin, end));
  const judge = runInNewContext(code + '\njudgePerf', { MEMORY_NOT_JUDGED: '' });
  expect(judge({ maxHeartbeatMs: 16 }, 'not JSON', 'broken probe')).toMatchObject({ passed: true, stats: {} });
  expect(judge({ maxHeartbeatMs: 16 }, '{}', 'missing metric')).toMatchObject({ passed: true, stats: {} });
});

it('AUD-09: the original Electron navigation guard admits a foreign localhost-prefixed hostname', () => {
  const source = readFileSync('src/main/index.ts', 'utf8');
  const predicate = /if \((!url\.startsWith\('http:\/\/localhost'\).*?)\) e\.preventDefault\(\)/.exec(source)?.[1];
  expect(predicate).toBeTruthy();
  const blocked = new Function('url', 'return ' + predicate);
  expect(blocked('http://localhost.attacker.invalid/page')).toBe(false);
  expect(blocked('https://attacker.invalid/page')).toBe(true);
});
