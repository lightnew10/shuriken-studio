import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type CallerContext } from '../src/core/capabilities/tool-registry';
import { registerWaitTools, WAIT_FOR, type KilnWatch } from '../src/core/capabilities/wait-tools';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { ModelStore, type ModelMeta } from '../src/core/modeling/model-store';
import { DEFAULT_ESCALATION } from '../src/core/permissions/policy';
import { PLAYTEST_LIMITS, PlaytestLease } from '../src/core/roblox/playtest-lease';
import { coreHarness } from './helpers/make-core';
import { RobloxStudioAdapter, STUDIO_WAIT } from '../src/core/roblox/studio-adapter';

const ok = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });
const EDIT = 'Current Studio Mode: Edit\nAvailable DataModels: Edit\nFocused DataModel in the viewport: Edit';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StubStudio extends RobloxStudioAdapter {
  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }
  override availability() {
    return { ok: true };
  }
  protected override async callOnce(): Promise<ExternalCallResult> {
    return ok(EDIT);
  }
}

const agent: CallerContext = { kind: 'agent', runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
const savedWait = { ...STUDIO_WAIT };
const savedLimits = { ...PLAYTEST_LIMITS };
const savedFor = { ...WAIT_FOR };
beforeEach(() => {
  Object.assign(STUDIO_WAIT, { maxMs: 3000, pollMs: 15, noteMs: 40 });
  Object.assign(PLAYTEST_LIMITS, { pollMs: 15, maxHoldMs: 60_000 });
  Object.assign(WAIT_FOR, { pollMs: 15, noteMs: 30 });
});
afterEach(() => {
  Object.assign(STUDIO_WAIT, savedWait);
  Object.assign(PLAYTEST_LIMITS, savedLimits);
  Object.assign(WAIT_FOR, savedFor);
  vi.unstubAllEnvs();
});

function setup(over: { uploading?: (root: string) => string[]; kiln?: () => KilnWatch | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-wait-'));
  const lease = new PlaytestLease();
  const studio = new StubStudio();
  studio.useLease(lease);
  const reg = new ToolRegistry({ rules: () => DEFAULT_ESCALATION, requestApproval: async () => true, notify: () => undefined }, { record: () => undefined }, new Logger(null, null, 'error').scope('tools'));
  registerWaitTools(reg, { project: () => ({ root }) as never, studio, uploading: over.uploading ?? (() => []), kiln: over.kiln ?? (() => null) });
  const notes: string[] = [];
  const call = (args: Record<string, unknown>) => reg.invoke('wait_for', args, agent, undefined, ({ message }) => message && notes.push(message));
  return { root, lease, studio, call, notes };
}

const meta = (name: string, over: Partial<ModelMeta> = {}): Omit<ModelMeta, 'updatedAt'> => ({
  name,
  hash: `h-${name}`,
  size: [1, 1, 1],
  triangles: 12,
  vertices: 8,
  volume: null,
  faces: 6,
  solids: 1,
  valid: true,
  tolerance: null,
  placements: [],
  source: 'blender',
  ...over,
});

describe('wait_for studio_edit', () => {
  it("blocks until another agent's playtest is over, with progress, then says ready", async () => {
    const { lease, call, notes } = setup();
    lease.tryAcquire('run_other');
    const pending = call({ what: 'studio_edit', timeout_sec: 30 });
    await sleep(120);
    lease.release('run_other');
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ ready: true });
    expect(notes.some((n) => /^Waiting for Studio: another agent \(run_other\)/.test(n))).toBe(true);
  });

  it('answers ready at once when Studio is free', async () => {
    const { call } = setup();
    const t0 = Date.now();
    const r = await call({ what: 'studio_edit' });
    expect(r.data).toMatchObject({ ready: true, waitedSec: 0 });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('says it ran out of time, and who still holds Studio, when the playtest goes on', async () => {
    STUDIO_WAIT.maxMs = 200;
    const { lease, call } = setup();
    lease.tryAcquire('verifier:t1');
    const r = await call({ what: 'studio_edit', timeout_sec: 30 });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ ready: false });
    expect((r.data as { why: string }).why).toMatch(/Studio is still held by Shuriken's verification/);
  });
});

describe('wait_for upload', () => {
  const part = (root: string, name: string, over: Partial<ModelMeta> = {}) => new ModelStore(root).save(meta(name, { assembly: 'Hut', ...over }));

  it('waits until the uploads of a model are through, then lists what became of each part', async () => {
    let polls = 0;
    const s = setup({ uploading: () => (polls++ < 4 ? ['Hut_Wall', 'Rock'] : ['Rock']) });
    part(s.root, 'Hut_Wall', { upload: { assetId: '111', hash: 'h-Hut_Wall', at: '' } });
    part(s.root, 'Hut_Roof', { upload: { operation: 'op-1', hash: 'h-Hut_Roof', at: '' } });
    part(s.root, 'Hut_Door', { upload: { error: 'moderated', hash: 'h-Hut_Door', at: '' } });
    part(s.root, 'Hut_Sign');
    // Rock (not part of Hut) keeps uploading: it isn't waited for.
    const r = await s.call({ what: 'upload', model: 'Hut', timeout_sec: 20 });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.data).toMatchObject({ ready: true, stillUploading: [], uploaded: 1, processingAtRoblox: ['Hut_Roof'], failed: [{ part: 'Hut_Door', why: 'moderated' }], notUploaded: 1 });
    expect(polls).toBeGreaterThan(4);
    expect(s.notes.some((n) => /Waiting for \d+ part uploads? to Roblox: Hut_Wall/.test(n))).toBe(true);
    expect((r.data as { note: string }).note).toMatch(/still processing 1 upload \(Hut_Roof\)/);
  });

  it('gives up when the time is up and the uploads are still going (they carry on by themselves)', async () => {
    const s = setup({ uploading: () => ['Hut_Wall'] });
    part(s.root, 'Hut_Wall');
    const t0 = Date.now();
    const r = await s.call({ what: 'upload', timeout_sec: 1 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r.data).toMatchObject({ ready: false, stillUploading: ['Hut_Wall'] });
    expect((r.data as { note: string }).note).toMatch(/call wait_for again/);
  });

  it('is ready at once when nothing is uploading', async () => {
    const s = setup();
    const r = await s.call({ what: 'upload' });
    expect(r.data).toMatchObject({ ready: true, stillUploading: [] });
  });
});

describe('wait_for kiln_turn', () => {
  const fakeKiln = (working: () => boolean, linked: string | null = 'kp1'): KilnWatch => ({
    linkedProject: (_root, model) => (model === 'Griever' ? linked : null),
    kiln: {
      check: async () => ({ ok: true, detail: 'Kiln 0.7.3' }),
      get: async () => ({ projects: [{ id: 'kp1', title: 'Griever', working: working() }] }),
    },
  });

  it("waits until Kiln's copilot is no longer working on the model's project", async () => {
    vi.stubEnv('SHURIKEN_NO_KILN', '0');
    let asks = 0;
    const s = setup({ kiln: () => fakeKiln(() => asks++ < 3) });
    const r = await s.call({ what: 'kiln_turn', model: 'Griever', timeout_sec: 20 });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.data).toMatchObject({ ready: true, kilnProject: 'kp1' });
    expect(asks).toBeGreaterThan(3);
    expect(s.notes.some((n) => /Waiting for Kiln's copilot to finish its turn on Griever/.test(n))).toBe(true);
  });

  it('says so when Kiln still works after the time is up', async () => {
    vi.stubEnv('SHURIKEN_NO_KILN', '0');
    const s = setup({ kiln: () => fakeKiln(() => true) });
    const r = await s.call({ what: 'kiln_turn', kiln_project: 'kp1', timeout_sec: 1 });
    expect(r.data).toMatchObject({ ready: false, kilnProject: 'kp1' });
  });

  it('is plain about what is missing: no Kiln, no model, no project', async () => {
    vi.stubEnv('SHURIKEN_NO_KILN', '0');
    expect((await setup().call({ what: 'kiln_turn', model: 'Griever' })).isError).toBe(true);
    const s = setup({ kiln: () => fakeKiln(() => false, null) });
    const none = await s.call({ what: 'kiln_turn', model: 'Griever' });
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.content)).toMatch(/has no Kiln project yet/);
    expect(JSON.stringify((await s.call({ what: 'kiln_turn' })).content)).toMatch(/Give model/);
    vi.stubEnv('SHURIKEN_NO_KILN', '1');
    expect((await setup({ kiln: () => fakeKiln(() => false) }).call({ what: 'kiln_turn', model: 'Griever' })).isError).toBe(true);
  });
});

describe('wait_for in the agents’ tool set', () => {
  const makeCore = coreHarness();

  it('is registered by the core for every agent role, with its capability', async () => {
    const { core } = await makeCore({ respond: async () => null });
    for (const role of ['roblox-engineer', 'level-designer', 'modeler']) {
      expect(core.tools.visibleTo({ ...agent, role }).some((t) => t.name === 'wait_for'), role).toBe(true);
    }
    expect(core.capabilities.get('app.wait')?.status).toBe('healthy');
  });

  it('is in the common agent instructions point to it instead of sleep loops', async () => {
    const { roleFor } = await import('../src/core/agents/roles');
    expect(roleFor('roblox-engineer').instructions).toMatch(/call wait_for/);
    expect(roleFor('roblox-engineer').instructions).toMatch(/Never sleep or poll in a shell loop/);
  });
});
