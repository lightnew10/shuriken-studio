import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
vi.mock('../src/core/providers/codex/codex-process', () => ({ codexExecutable: () => 'codex-test.exe', codexEnvironment: () => ({}), stopCodexProcess: async (child: { kill: () => void }) => { child.kill(); } }));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { codexModelOptions, isAllowedCodexModel, loadCodexModels } from '../src/core/providers/codex/codex-models';

const mockedSpawn = vi.mocked(spawn);
afterEach(() => mockedSpawn.mockReset());

describe('Codex model tier catalogue', () => {
  it('filters Astra and hidden models while preserving catalog order', () => {
    expect(codexModelOptions({
      data: [
        { id: 'fast-model', model: 'fast-model', displayName: 'Fast', hidden: false },
        { id: 'astra', model: 'astra', displayName: 'Astra Pro', hidden: false },
        { id: 'invisible', model: 'invisible', displayName: 'Hidden', hidden: true },
        { id: 'balanced-model', model: 'balanced-model', displayName: 'Balanced', hidden: false, isDefault: true },
        { id: 'fast-model', model: 'fast-model', displayName: 'Fast duplicate', hidden: false },
      ],
    })).toEqual([
      { id: 'fast-model', name: 'Fast', isDefault: false },
      { id: 'balanced-model', name: 'Balanced', isDefault: true },
    ]);
    expect(isAllowedCodexModel('astra-special')).toBe(false);
    expect(isAllowedCodexModel('model-42', 'Astra Experimental')).toBe(false);
    expect(isAllowedCodexModel('not a safe model id')).toBe(false);
  });

  it('initializes the official app-server protocol and loads visible models without an inference turn', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => { child.emit('close', 0); return true; });
    const calls: Array<{ id?: number; method?: string }> = [];
    let buffer = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end = 0;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const request = JSON.parse(line) as { id?: number; method?: string };
        calls.push({ id: request.id, method: request.method });
        if (request.id === 1) {
          setImmediate(() => child.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'codex' } }) + '\n'));
        } else if (request.id === 2) {
          setImmediate(() => child.stdout.write(JSON.stringify({
            id: 2, result: { data: [
              { model: 'mini-model', displayName: 'Mini', hidden: false },
              { model: 'astra', displayName: 'Astra', hidden: false },
              { model: 'pro-model', displayName: 'Pro', hidden: false },
            ], nextCursor: null },
          }) + '\n'));
        }
      }
    });
    mockedSpawn.mockReturnValueOnce(child as never);
    expect(await loadCodexModels()).toEqual([
      { id: 'mini-model', name: 'Mini', isDefault: false },
      { id: 'pro-model', name: 'Pro', isDefault: false },
    ]);
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'initialized', 'model/list']);
    expect(mockedSpawn).toHaveBeenCalledWith('codex-test.exe', expect.arrayContaining(['app-server', '--listen', 'stdio://']), expect.objectContaining({ shell: false }));
    expect(child.kill).toHaveBeenCalled();
  });
});
