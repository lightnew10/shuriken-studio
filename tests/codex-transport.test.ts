import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/core/providers/codex/codex-process', () => ({ codexExecutable: () => 'test.exe', codexEnvironment: () => ({}), stopCodexProcess: vi.fn(async () => {}) }));
import { spawn } from 'node:child_process';
import { CodexAppServer } from '../src/core/providers/codex/app-server';
const servers: CodexAppServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); vi.resetAllMocks(); });
function setup() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  const server = new CodexAppServer(); servers.push(server); return { server, child };
}
it('correlates out-of-order responses and ignores already-settled duplicates', async () => {
  const { server, child } = setup();
  const a = server.request('a'), b = server.request('b');
  child.stdout.write('{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n{"id":1,"result":"duplicate"}\n');
  expect(await Promise.all([a, b])).toEqual(['first', 'second']);
});
it('bounds request time and handles late responses', async () => {
  const { server, child } = setup();
  await expect(server.request('slow', {}, 5)).rejects.toThrow(/timed out/);
  child.stdout.write('{"id":1,"result":{}}\n');
});
it('rejects pending requests on malformed or oversized frames and crashes', async () => {
  for (const mode of ['json', 'size', 'crash']) {
    const { server, child } = setup(), pending = server.request('pending');
    const failed = expect(pending).rejects.toThrow();
    if (mode === 'crash') child.emit('close', 1);
    else child.stdout.write(mode === 'json' ? 'not JSON\n' : 'x'.repeat(8 * 1024 * 1024 + 1));
    await failed;
  }
});
it('denies unknown approval requests rather than granting a native action', () => {
  const { child } = setup(); let output = '';
  child.stdin.on('data', (b: Buffer) => { output += b.toString(); });
  child.stdout.write('{"id":"approval-1","method":"item/permissions/requestApproval","params":{}}\n');
  expect(JSON.parse(output)).toMatchObject({ id: 'approval-1', error: { code: -32601 } });
});
