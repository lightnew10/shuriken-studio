import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorkspaceTools, workspacePath } from '../src/core/capabilities/workspace-tools';
import { ToolRegistry, type CallerContext } from '../src/core/capabilities/tool-registry';
import { Logger } from '../src/core/log';
import { DEFAULT_ESCALATION } from '../src/core/permissions/policy';
import { reserveMutation, releaseMutations } from '../src/core/orchestrator/mutations';
import { judgePerf } from '../src/core/verification/verifier';
import { trustedMainFrame, trustedRendererUrl } from '../src/main/trusted-url';
import { KilnWorkspace } from '../src/core/modeling/kiln-modeling';
import { ModelStore } from '../src/core/modeling/model-store';
import { approvalSignature } from '../src/core/permissions/policy';
import { coreHarness } from './helpers/make-core';
import { ROLES } from '../src/core/agents/roles';
const makeCore = coreHarness();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { releaseMutations(root, 'a'); rmSync(root, { recursive: true, force: true }); } });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-security-')); roots.push(root);
  const reg = new ToolRegistry({ rules: () => DEFAULT_ESCALATION, requestApproval: async () => false, notify: () => {} }, { record: () => {} }, new Logger(null, null).scope('test'));
  registerWorkspaceTools(reg, () => ({ root }) as never);
  const caller: CallerContext = { kind: 'agent', runId: 'a', taskId: null, role: 'critic', providerId: 'codex', allowedTools: null, builtinTools: ['read_files'], builtinPermission: async () => ({ allow: true }) };
  return { root, reg, caller };
}
it('hides and refuses writes/shell for a reader before permission or filesystem effects', async () => {
  const { root, reg, caller } = setup();
  expect(reg.visibleTo(caller).map((t) => t.name)).toEqual(['workspace_read_file', 'workspace_search']);
  expect((await reg.invoke('workspace_write_file', { path: 'new.luau', content: 'wrong', expectedSha256: 'absent' }, caller)).isError).toBe(true);
  expect(() => readFileSync(join(root, 'new.luau'))).toThrow();
});
it('checks hashes, paths with spaces, protected paths, cancellation and cross-run ownership', async () => {
  const { root, reg, caller } = setup(); caller.builtinTools = ['read_files', 'edit_files'];
  expect((await reg.invoke('workspace_write_file', { path: 'file with spaces.luau', content: 'return 1', expectedSha256: 'absent' }, caller)).isError).toBeUndefined();
  expect((await reg.invoke('workspace_write_file', { path: 'file with spaces.luau', content: 'return 2', expectedSha256: 'absent' }, caller)).isError).toBe(true);
  expect(() => workspacePath(root, '../escape.luau', true)).toThrow();
  expect(() => workspacePath(root, '.GIT/config', true)).toThrow();
  const release = reserveMutation(root, 'b', ['file with spaces.luau']);
  const out = await reg.invoke('workspace_write_file', { path: 'file with spaces.luau', content: 'overwrite', expectedSha256: 'absent' }, caller); expect(out.isError).toBe(true); release();
  const abort = new AbortController(); abort.abort();
  expect((await reg.invoke('workspace_write_file', {}, caller, abort.signal)).isError).toBe(true);
});
it('contains junctions and refuses stale metrics and foreign renderer origins', () => {
  const { root } = setup(); const outside = mkdtempSync(join(tmpdir(), 'outside-')); roots.push(outside);
  symlinkSync(outside, join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => workspacePath(root, 'junction/write.luau', true)).toThrow();
  for (const value of ['{}', 'null', '[]', 'bad JSON', '{"heartbeatMs":"100"}', '{"heartbeatMs":null}', '{"heartbeatMs":-1}']) expect(judgePerf({ kind: 'perf', name: 'fixture', maxHeartbeatMs: 16 }, value, '').passed).toBe(false);
  expect(judgePerf({ kind: 'perf', name: 'fixture', maxHeartbeatMs: 16 }, '{"heartbeatMs":8}', '').passed).toBe(true);
  expect(trustedRendererUrl('http://localhost.attacker.invalid/', 'unused', 'http://localhost:5173/')).toBe(false);
  expect(trustedRendererUrl('http://localhost:5173/#settings', 'unused', 'http://localhost:5173/')).toBe(true);
  expect(trustedRendererUrl('http://localhost:5173/evil', 'unused', 'http://localhost:5173/')).toBe(false);
  const main = { url: 'http://localhost:5173/#settings' };
  expect(trustedMainFrame(main, main, 'unused', 'http://localhost:5173/')).toBe(true);
  expect(trustedMainFrame({ ...main }, main, 'unused', 'http://localhost:5173/')).toBe(false);
});

it('marks a failed Kiln export stale, keeping the saved scene and old parts for recovery', async () => {
  const { root } = setup();
  const original = join(root, 'source.blend'); writeFileSync(original, 'scene');
  const store = new ModelStore(root);
  store.save({ name: 'Fixture', source: 'blender', hash: 'old', size: [1, 1, 1], triangles: 12, vertices: 8, volume: 1, faces: 6, solids: 1, valid: true, tolerance: null, placements: [] }, { deferBuilder: true });
  const workspace = new KilnWorkspace(root, 'Fixture', {
    exportDir: root, bus: { emit: () => {} }, log: { warn: () => {} }, kiln: {
      supports: () => false,
      get: async () => ({ scene: original, version: 2 }),
      post: async (path: string) => path.endsWith('/python') ? { ok: true, changed: true, version: 2 } : { ok: false, error: 'simulated export failure' },
    },
  } as never);
  Object.assign(workspace, { run: (fn: (id: string) => Promise<unknown>) => fn('fixture') });
  const result = await workspace.exec('fixture', 100);
  expect(result).toMatchObject({ ok: false, pythonOk: true, saved: true, exportStatus: 'failed', parts: [], changed: true });
  expect(store.get('Fixture')).toMatchObject({ valid: false, hash: 'old', exportError: expect.stringContaining('simulated export failure') });
  expect(readFileSync(workspace.blend, 'utf8')).toBe('scene');
});

it('binds approval to the entire command and stops retries after an approval card', async () => {
  expect(approvalSignature('scope', 'shell', { command: 'x'.repeat(600) + 'a' })).not.toEqual(approvalSignature('scope', 'shell', { command: 'x'.repeat(600) + 'b' }));
  const { reg, caller } = setup();
  let prompts = 0;
  caller.builtinTools = ['edit_files'];
  caller.builtinPermission = async () => { prompts++; return { allow: false, message: 'Needs human approval' }; };
  for (const path of ['first.txt', 'retry.txt']) expect((await reg.invoke('workspace_write_file', { path, content: '', expectedSha256: 'absent' }, caller)).isError).toBe(true);
  expect(prompts).toBe(1);
});

it('refuses the second MCP call before mutation when the Codex run budget is one tool', async () => {
  const { core, provider, ctx, root } = await makeCore({ respond: async (_req, _kind, call) => {
    expect(await call('workspace_write_file', { path: 'first.txt', content: 'first', expectedSha256: 'absent' })).not.toMatchObject({ isError: true });
    expect(await call('workspace_write_file', { path: 'second.txt', content: 'second', expectedSha256: 'absent' })).toMatchObject({ isError: true });
    return null;
  } });
  Object.defineProperty(provider, 'id', { value: 'codex' });
  core.providers.register(provider);
  core.providers.setAssignments({ default: 'fake', roles: { fixture: 'codex' } });
  const outcome = await core.runner.run({ project: ctx, role: { ...ROLES.critic!, id: 'fixture', appTools: [], maxTurns: 1, builtinTools: ['edit_files'] }, task: null, directive: 'fixture', contextText: 'fixture', output: null, signal: new AbortController().signal });
  expect(outcome.completion).toMatchObject({ ok: false, errorKind: 'max_turns' });
  expect(readFileSync(join(root, 'first.txt'), 'utf8')).toBe('first');
  expect(existsSync(join(root, 'second.txt'))).toBe(false);
});
