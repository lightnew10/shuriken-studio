import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../src/core/core';
import { findBlender } from '../src/core/blender/bridge';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import { OpenCloudAssets, type UploadResult } from '../src/core/roblox/open-cloud-assets';
import { ModelStore, type ModelMeta } from '../src/core/modeling/model-store';
import { ModelUploads } from '../src/core/modeling/model-uploads';
import type { CallerContext } from '../src/core/capabilities/tool-registry';
import { FakeProvider } from './helpers/fake-provider';
import { makeGlb } from './helpers/glb';
import { GLB_FACING, glbTurned180 } from '../src/core/modeling/glb';

// Pipeline fixes that make Kiln-made models look right in Studio and upload quickly: uploads that outlive
// the run that asked for them, rigs built from what is uploaded, concurrent uploads that are joined,
// clips that reach the game's animations, temporary meshes with their own normals, texture limits, the
// export's change check and its material notes. Everything runs offline (fake Roblox, fake Studio).

/** Toolchain stub: static analysis passes without binaries or network. */
class StubLuau extends LuauToolchain {
  constructor() {
    super(tmpdir());
  }
  override async check(): Promise<LuauCheckResult> {
    return { ok: true, problems: [], toolErrors: [], durationMs: 1 };
  }
}

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown().catch(() => {});
});

async function makeCore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
  const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
  cores.push(core);
  const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
  const ctx = core.openProject(core.createProject({ name: 'Fidelity', rootPath: root }).id);
  ctx.updateExtras({ syncMode: 'none' });
  core.orchestrator.pause();
  return { core, root };
}

const agent: CallerContext = { kind: 'agent', runId: 'run_fid', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

/** A part in the model store with its mesh file and GLB on disk. */
function savePart(root: string, name: string, over: Partial<ModelMeta> = {}): ModelMeta {
  const store = new ModelStore(root);
  const meta = store.save({
    name, hash: `h-${name}`, size: [1, 1, 1], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', ...over,
  });
  writeFileSync(store.paths(name).glb, makeGlb({ positions: [0.5, 0, 1, 1.5, 0, 1, 1, 2, 0.25], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }));
  writeFileSync(store.paths(name).mesh, JSON.stringify({ v: [0, 0, 0, 1, 0, 0, 0, 1, 0], n: [0, 0, 1, 0, 0, 1, 0, 0, 1], t: [0, 1, 2] }));
  return meta;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('Open Cloud: an upload Roblox is still processing is pending, not failed', () => {
  const file = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-up-'));
    const f = join(dir, 'part.glb');
    writeFileSync(f, 'glb');
    return f;
  })();
  const FAST = { startDelayMs: 5, maxDelayMs: 20 };

  it('wait() keeps polling through server errors and answers pending (with the operation) when the time is up', async () => {
    let polls = 0;
    const cloud = new OpenCloudAssets(async () => 'KEY', (async (url: string) => {
      expect(url).toBe('https://apis.roblox.com/assets/v1/operations/op-1');
      polls++;
      if (polls === 1) return new Response('busy', { status: 503 });
      if (polls === 2) return new Response('slow down', { status: 429 });
      return json({ path: 'operations/op-1', done: false });
    }) as unknown as typeof fetch);
    const r = await cloud.wait('operations/op-1', 300, undefined, FAST);
    expect(r).toMatchObject({ ok: false, pending: true, operation: 'op-1' });
    expect(polls).toBeGreaterThan(3);
    // A rejected asset is a real failure, an unknown operation too.
    const rejected = new OpenCloudAssets(async () => 'KEY', (async () => json({ done: true, error: { message: 'Moderated' } })) as unknown as typeof fetch);
    expect(await rejected.wait('op-2', 300, undefined, FAST)).toMatchObject({ ok: false, error: 'Roblox rejected the asset: Moderated' });
    expect(await rejected.wait('op-2', 300, undefined, FAST).then((x) => x.pending)).toBeUndefined();
    const gone = new OpenCloudAssets(async () => 'KEY', (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch);
    expect(await gone.wait('op-3', 300, undefined, FAST)).toMatchObject({ ok: false, error: expect.stringContaining('(404)') });
  });

  it('upload() reports the operation as pending when Roblox needs longer than the wait, and asks again after a 429', async () => {
    const calls: string[] = [];
    let first = true;
    const cloud = new OpenCloudAssets(async () => 'KEY', (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('/v1/')[1]}`);
      if (init?.method === 'POST') {
        if (first) {
          first = false;
          return json({ message: 'slow down' }, 429, { 'retry-after': '0' });
        }
        return json({ path: 'operations/op-9', done: false });
      }
      return json({ done: false });
    }) as unknown as typeof fetch);
    const r = await cloud.upload({ file, type: 'Model', name: 'Part', creator: { userId: '1' }, waitMs: 150, poll: FAST });
    expect(r).toMatchObject({ ok: false, pending: true, operation: 'op-9' });
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
    // Resolved later with the operation alone.
    const done = new OpenCloudAssets(async () => 'KEY', (async () => json({ done: true, response: { assetId: '777' } })) as unknown as typeof fetch);
    expect(await done.wait('op-9', 1000, undefined, FAST)).toEqual({ ok: true, assetId: '777' });
  });
});

describe('model uploads outlive the run that asked for them', () => {
  const fakeCloud = (upload: (input: { name: string }) => Promise<UploadResult> | UploadResult, wait: (op: string) => Promise<UploadResult> | UploadResult = () => ({ ok: false, error: 'not asked' })) => {
    const log = { upload: [] as unknown[][], wait: [] as unknown[][] };
    return {
      log,
      cloud: {
        configured: async () => true,
        upload: async (...args: unknown[]) => {
          log.upload.push(args);
          return upload(args[0] as { name: string });
        },
        wait: async (...args: unknown[]) => {
          log.wait.push(args);
          return wait(args[0] as string);
        },
      } as unknown as OpenCloudAssets,
    };
  };
  const uploader = (cloud: OpenCloudAssets, extra: Partial<ConstructorParameters<typeof ModelUploads>[0]> = {}) => new ModelUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42', ...extra });

  it('never hands the upload an AbortSignal, records the asset id, and a second call finds it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const part = savePart(root, 'Crate');
    const { cloud, log } = fakeCloud(() => ({ ok: true, assetId: '1001' }));
    const up = uploader(cloud);
    const r = await up.ensure(root, part);
    expect(r).toMatchObject({ name: 'Crate', assetId: '1001' });
    // upload(input) only: no signal for the run to abort.
    expect(log.upload).toHaveLength(1);
    expect(log.upload[0]).toHaveLength(1);
    expect(ModelStore.assetId(new ModelStore(root).get('Crate')!)).toBe('1001');
    expect(await up.ensure(root, part)).toMatchObject({ assetId: '1001', reused: true });
    expect(log.upload).toHaveLength(1);
  });

  it('keeps the operation Roblox is still processing in the part’s record, and the next call resolves it instead of uploading again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const part = savePart(root, 'Wing');
    const recorded: string[] = [];
    let resolved = false;
    const { cloud, log } = fakeCloud(
      () => ({ ok: false, pending: true, operation: 'op-77', error: 'Roblox is still processing the upload; check again later.' }),
      () => (resolved ? { ok: true, assetId: '2002' } : { ok: false, pending: true, operation: 'op-77', error: 'still processing' }),
    );
    const up = uploader(cloud, { uploaded: (m, id) => recorded.push(`${m.name}:${id}`) });
    const first = await up.ensure(root, part);
    expect(first).toMatchObject({ assetId: null, pending: true });
    expect(first.why).toMatch(/still processing/);
    const stored = new ModelStore(root).get('Wing')!;
    expect(stored.upload).toMatchObject({ operation: 'op-77', hash: part.hash });
    expect(ModelStore.assetId(stored)).toBeNull();
    expect(ModelStore.pendingOperation(stored)).toBe('op-77');
    // Still pending: asked about, not uploaded again.
    expect(await up.ensure(root, stored)).toMatchObject({ assetId: null, pending: true });
    expect(log.upload).toHaveLength(1);
    expect(log.wait.map((a) => a[0])).toEqual(['op-77']);
    // Roblox is done: the same operation gives the asset id and the record becomes an upload.
    resolved = true;
    expect(await up.ensure(root, new ModelStore(root).get('Wing')!)).toMatchObject({ assetId: '2002' });
    expect(log.upload).toHaveLength(1);
    expect(ModelStore.assetId(new ModelStore(root).get('Wing')!)).toBe('2002');
    expect(recorded).toEqual(['Wing:2002']);
    // A rejected pending upload is a failure on record, and the next call uploads the part again.
    const root2 = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const part2 = savePart(root2, 'Fang', { upload: { operation: 'op-5', hash: 'h-Fang', at: '' } });
    const { cloud: cloud2, log: log2 } = fakeCloud(() => ({ ok: true, assetId: '3003' }), () => ({ ok: false, operation: 'op-5', error: 'Roblox rejected the asset: Moderated' }));
    const up2 = uploader(cloud2);
    expect(await up2.ensure(root2, part2)).toMatchObject({ assetId: null, why: 'Roblox rejected the asset: Moderated' });
    expect(new ModelStore(root2).get('Fang')!.upload).toMatchObject({ error: 'Roblox rejected the asset: Moderated' });
    expect(await up2.ensure(root2, new ModelStore(root2).get('Fang')!)).toMatchObject({ assetId: '3003' });
    expect(log2.upload).toHaveLength(1);
  });

  it('joins an upload that is already running, and never overwrites a part exported again meanwhile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const part = savePart(root, 'Horn');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { cloud, log } = fakeCloud(async () => {
      await gate;
      return { ok: true, assetId: '4004' };
    });
    const up = uploader(cloud);
    const a = up.ensure(root, part);
    const b = up.ensure(root, part);
    await new Promise((r) => setTimeout(r, 20));
    // The model is exported again while the upload goes on: the new build keeps its own (empty) record.
    savePart(root, 'Horn', { hash: 'h-Horn-2', description: 'second build' });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(log.upload).toHaveLength(1);
    expect(ra).toBe(rb);
    expect(ra).toMatchObject({ assetId: null, why: expect.stringMatching(/changed while it was uploading/) });
    const now = new ModelStore(root).get('Horn')!;
    expect(now).toMatchObject({ hash: 'h-Horn-2', description: 'second build' });
    expect(now.upload).toBeUndefined();
  });

  it('a stopped run does not abort the upload: the asset id is recorded (real Open Cloud client, fake Roblox)', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    savePart(root, 'Crate');
    const seen: Array<{ method: string; url: string; signal: AbortSignal | null | undefined }> = [];
    const run = new AbortController();
    const cloud = core.assetUploads as unknown as { secret: unknown; fetchImpl: unknown };
    cloud.secret = async () => 'KEY';
    let polls = 0;
    cloud.fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', url, signal: init?.signal });
      if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
      if (init?.method === 'POST') {
        // The run is stopped (the user hits Stop) just after Roblox took the upload.
        setTimeout(() => run.abort(), 10);
        return json({ path: 'operations/op-1', done: false });
      }
      return polls++ ? json({ done: true, response: { assetId: '9001' } }) : json({ done: false });
    };
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async () => ({ ok: true, output: JSON.stringify({ path: 'Workspace.Crate', position: [0, 0, 0], notes: [] }), durationMs: 1 });
    // The call comes back as soon as its run is stopped (it can't wait any more)...
    const out = await core.tools.invoke('model_place', { name: 'Crate', position: [0, 5, 0] }, agent, run.signal);
    expect(run.signal.aborted).toBe(true);
    expect(JSON.parse(text(out))).toMatchObject({ uploading: true, stillUploading: ['Crate'] });
    // ...but the upload goes on by itself, untouched by the stopped run, and records its asset id.
    const store = new ModelStore(root);
    for (let i = 0; i < 100 && !ModelStore.assetId(store.get('Crate')!); i++) await new Promise((r) => setTimeout(r, 100));
    expect(ModelStore.assetId(store.get('Crate')!)).toBe('9001');
    expect(seen.length).toBeGreaterThan(2);
    // Nothing was told to stop: no request carried the run's signal.
    expect(seen.every((s) => !s.signal)).toBe(true);
  }, 30_000);

  it('model_place tells a still-processing upload from a failed one, and the next call resolves it', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    savePart(root, 'Crate');
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    let uploads = 0;
    let done = false;
    cloud.upload = async () => {
      uploads++;
      return { ok: false, pending: true, operation: 'op-31', error: 'Roblox is still processing the upload; check again later.' };
    };
    cloud.wait = async () => (done ? { ok: true, assetId: '5005' } : { ok: false, pending: true, operation: 'op-31', error: 'still processing' });
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const luau: string[] = [];
    studio.runLuau = async (code: string) => {
      luau.push(code);
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Crate', position: [0, 0, 0], notes: [] }), durationMs: 1 };
    };
    const first = await core.tools.invoke('model_place', { name: 'Crate', position: [0, 5, 0] }, agent);
    expect(first.isError, text(first)).toBeFalsy();
    expect(JSON.parse(text(first))).toMatchObject({ permanent: false, note: expect.stringMatching(/still processing/) });
    expect(new ModelStore(root).get('Crate')!.upload).toMatchObject({ operation: 'op-31' });
    done = true;
    luau.length = 0;
    const second = await core.tools.invoke('model_place', { name: 'Crate', position: [0, 5, 0] }, agent);
    expect(JSON.parse(text(second))).toMatchObject({ permanent: true, assetId: '5005' });
    expect(uploads).toBe(1);
    expect(readFileSync(join(root, 'world', 'Models.luau'), 'utf8')).toContain('asset=5005');
  });
});

// ---------------------------------------------------------------------------------------------
// rig_build builds from what is uploaded and stages only the rest as temporary meshes
// ---------------------------------------------------------------------------------------------

const STALKER = {
  version: 1, model: 'Stalker', root: 'Body',
  joints: [
    { name: 'Body', parent: null, part: 'Body', pivot: [0, 2, 0], kind: 'ball' },
    { name: 'Tail', parent: 'Body', part: 'Tail', pivot: [0, 2.2, 1.5], kind: 'hinge', axis: [1, 0, 0] },
    { name: 'Claw', parent: 'Body', part: 'Claw', pivot: [0, 2, -1], kind: 'ball' },
  ],
  legs: [], attachments: [{ name: 'Sting', part: 'Tail', position: [0, 3, 2.5] }],
};

/** Stalker's three parts (Body, Tail, Claw, one per segment) and its rig in a project. */
function stalker(root: string, uploaded: string[] = []) {
  const store = new ModelStore(root);
  const origins: Record<string, [number, number, number]> = { Body: [0, 2, 0], Tail: [0, 2.4, 2], Claw: [0, 2, -1.2] };
  for (const seg of ['Body', 'Tail', 'Claw']) {
    const name = `Stalker_${seg}`;
    savePart(root, name, { assembly: 'Stalker', origin: origins[seg], segment: seg, ...(uploaded.includes(seg) ? { upload: { assetId: String(100 + seg.length), hash: `h-${name}`, at: '' } } : {}) });
  }
  writeFileSync(store.rigFile('Stalker'), JSON.stringify(STALKER));
  return store;
}

/** A stand-in Studio that answers the rig programs and keeps what it was sent. */
function rigStudio(core: Core, opts: { onBuild?: (code: string, n: number) => unknown; failStaging?: boolean } = {}) {
  const sent: Array<{ kind: 'stage' | 'build' | 'place' | 'other'; code: string }> = [];
  let builds = 0;
  const studio = core.studio as unknown as Record<string, unknown>;
  studio.availability = () => ({ ok: true });
  studio.runLuau = async (code: string) => {
    const kind = code.includes('CreateEditableMesh') && code.includes('_Staging') ? 'stage' : code.includes('local RIGS = {') ? 'build' : code.includes('ShurikenRigs:FindFirstChild') ? 'place' : 'other';
    sent.push({ kind, code });
    if (kind === 'stage') return opts.failStaging ? { ok: false, output: 'EditableMesh memory is full', durationMs: 1 } : { ok: true, output: '1', durationMs: 1 };
    if (kind === 'build') return { ok: true, output: JSON.stringify(opts.onBuild?.(code, ++builds) ?? { built: ['Stalker'], failed: [], skipped: [] }), durationMs: 1 };
    return { ok: true, output: JSON.stringify({ path: 'Workspace.Stalker', position: [0, 2, 0], notes: [] }), durationMs: 1 };
  };
  return sent;
}

const uploadsFor = (core: Core, outcome: (name: string) => UploadResult) => {
  const cloud = core.assetUploads as unknown as Record<string, unknown>;
  const asked: string[] = [];
  cloud.configured = async () => true;
  cloud.upload = async (input: { name: string }) => {
    asked.push(input.name);
    return outcome(input.name);
  };
  core.prefs.set({ robloxCreatorId: '42' });
  return asked;
};

describe('rig_build: a rig is built from what is uploaded, the rest staged as temporary meshes', () => {
  it('uploads only the parts that need it and stages only the part Roblox did not take', async () => {
    const { core, root } = await makeCore();
    const store = stalker(root, ['Body', 'Tail']);
    const sent = rigStudio(core);
    const asked = uploadsFor(core, () => ({ ok: false, error: 'Upload failed (500): try later' }));
    const r = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    // Body and Tail were uploaded already (same build): only the Claw went to Roblox.
    expect(asked).toEqual(['Stalker_Claw']);
    const stage = sent.filter((s) => s.kind === 'stage');
    expect(stage).toHaveLength(1);
    expect(stage[0]!.code).toContain('"Stalker_Claw"');
    expect(stage[0]!.code).not.toContain('"Stalker_Body"');
    expect(stage[0]!.code).not.toContain('"Stalker_Tail"');
    const build = sent.find((s) => s.kind === 'build')!.code;
    expect(build).toContain('local TEMPORARY = true');
    expect(build).toContain('local SKIP_MISSING = true');
    expect(build).toMatch(/name="Stalker_Body",asset=104,/);
    expect(build).toMatch(/name="Stalker_Tail",asset=104,/);
    expect(build).toMatch(/name="Stalker_Claw",asset=nil,/);
    const out = r.data as { parts: Record<string, number>; temporary: string; temporaryParts: string[]; leftOut?: unknown[] };
    expect(out.parts).toEqual({ total: 3, uploaded: 2, temporary: 1, leftOut: 0 });
    expect(out.temporaryParts).toEqual(['Stalker_Claw']);
    expect(out.temporary).toMatch(/1 of 3 part\(s\) as temporary meshes — Stalker_Claw/);
    expect(out.leftOut).toBeUndefined();
    // The world builder holds permanent rigs only: this one waits for its last upload.
    expect(() => readFileSync(join(root, 'world', 'Rigs.luau'), 'utf8')).toThrow();
    expect(store.get('Stalker_Claw')!.upload).toMatchObject({ error: 'Upload failed (500): try later' });
  });

  it('builds fully from uploads once they are all there (nothing staged, world/Rigs.luau written)', async () => {
    const { core, root } = await makeCore();
    stalker(root, ['Body', 'Tail', 'Claw']);
    const sent = rigStudio(core);
    uploadsFor(core, () => ({ ok: false, error: 'never asked' }));
    const r = await core.tools.invoke('rig_build', { model: 'Stalker', place: { position: [0, 5, 0] } }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    expect(sent.map((s) => s.kind)).toEqual(['build', 'place']);
    expect(sent[0]!.code).toContain('local TEMPORARY = false');
    expect(r.data).toMatchObject({ parts: { total: 3, uploaded: 3, temporary: 0, leftOut: 0 }, placed: { path: 'Workspace.Stalker' } });
    expect(r.data).not.toHaveProperty('temporary');
    const file = readFileSync(join(root, 'world', 'Rigs.luau'), 'utf8');
    expect(file).toContain('local KNOWN = {["Stalker"]=true}');
    expect(file).toMatch(/name="Stalker_Claw",asset=104,/);
  });

  it('still builds when a part cannot be shown at all: it is left out and reported, not a stale older build', async () => {
    const { core, root } = await makeCore();
    stalker(root, ['Body', 'Tail']);
    const sent = rigStudio(core, {
      failStaging: true,
      onBuild: () => ({ built: ['Stalker'], failed: [], skipped: [{ rig: 'Stalker', name: 'Stalker_Claw', why: 'no mesh' }] }),
    });
    uploadsFor(core, () => ({ ok: false, error: 'Roblox is rate limiting uploads; try again in a minute.' }));
    const r = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    expect(sent.some((s) => s.kind === 'build')).toBe(true);
    const out = r.data as { parts: Record<string, number>; leftOut: Array<{ name: string; why: string }> };
    expect(out.parts).toEqual({ total: 3, uploaded: 2, temporary: 0, leftOut: 1 });
    expect(out.leftOut[0]).toMatchObject({ name: 'Stalker_Claw' });
    expect(out.leftOut[0]!.why).toMatch(/rate limiting.*temporary mesh couldn't be staged: EditableMesh memory is full/);
  });

  it('says so, and leaves the older build alone, when nothing is uploaded and nothing can be staged', async () => {
    const { core, root } = await makeCore();
    stalker(root, []);
    const sent = rigStudio(core, { failStaging: true });
    uploadsFor(core, () => ({ ok: false, error: 'no key' }));
    const bad = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/None of Stalker's 3 part\(s\) is uploaded .* a preview rig from temporary meshes failed too: EditableMesh memory is full/);
    expect(sent.some((s) => s.kind === 'build')).toBe(false);
  });

  it('shows an uploaded part Studio cannot load yet as a temporary mesh (a second pass), and keeps still-processing uploads pending', async () => {
    const { core, root } = await makeCore();
    const store = stalker(root, ['Body']);
    const sent = rigStudio(core, {
      onBuild: (_code, n) => (n === 1 ? { built: ['Stalker'], failed: [], skipped: [{ rig: 'Stalker', name: 'Stalker_Body', why: 'asset 104 has no MeshPart (still processing?)' }] } : { built: ['Stalker'], failed: [], skipped: [] }),
    });
    uploadsFor(core, (name) => ({ ok: false, pending: true, operation: `op-${name}`, error: 'Roblox is still processing the upload; check again later.' }));
    const r = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    const out = r.data as { parts: Record<string, number>; temporaryParts: string[]; temporary: string };
    // Tail and Claw are processing at Roblox, Body's asset didn't load: all three are temporary meshes in the end.
    expect(out.parts).toEqual({ total: 3, uploaded: 0, temporary: 3, leftOut: 0 });
    expect(out.temporaryParts.sort()).toEqual(['Stalker_Body', 'Stalker_Claw', 'Stalker_Tail']);
    expect(out.temporary).toMatch(/still processing|couldn't load/);
    const builds = sent.filter((s) => s.kind === 'build');
    expect(builds).toHaveLength(2);
    expect(builds[0]!.code).toMatch(/name="Stalker_Body",asset=104,/);
    expect(builds[1]!.code).toMatch(/name="Stalker_Body",asset=nil,/);
    // The processing uploads are kept, not failed: the next call asks Roblox about them.
    expect(store.get('Stalker_Tail')!.upload).toMatchObject({ operation: 'op-Stalker_Tail' });
    expect(store.get('Stalker_Claw')!.upload).toMatchObject({ operation: 'op-Stalker_Claw' });
  });
});

describe('world/Rigs.luau (permanent rigs)', () => {
  it('holds only rigs whose parts are all uploaded, but never prunes the template of a rig that is merely waiting', async () => {
    const { writeRigsBuilder } = await import('../src/core/modeling/rig-builder');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const store = stalker(root, ['Body', 'Tail', 'Claw']);
    // A second rig, Hopper, with one part not uploaded yet.
    const hopper = { ...STALKER, model: 'Hopper', joints: STALKER.joints.slice(0, 2), attachments: [] };
    for (const seg of ['Body', 'Tail']) savePart(root, `Hopper_${seg}`, { assembly: 'Hopper', origin: [0, 1, 0], segment: seg, ...(seg === 'Body' ? { upload: { assetId: '555', hash: `h-Hopper_${seg}`, at: '' } } : {}) });
    writeFileSync(store.rigFile('Hopper'), JSON.stringify(hopper));
    const out = writeRigsBuilder(root);
    expect(out).toMatchObject({ rigs: ['Stalker'], waiting: ['Hopper'] });
    const file = readFileSync(out.file!, 'utf8');
    expect(file).toContain('local KNOWN = {["Hopper"]=true,["Stalker"]=true}');
    expect(file).toMatch(/name="Stalker",root=/);
    expect(file).not.toMatch(/name="Hopper",root=/);
    expect(file).toContain('not KNOWN[child.Name]');
  });
});

// ---------------------------------------------------------------------------------------------
// Upload speed: only changed parts, six at a time, joined across calls, progress while it goes
// ---------------------------------------------------------------------------------------------

describe('uploading a model: only what changed, six at a time, joined, with progress', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A fake Roblox that counts how many uploads run at once. */
  function roblox(latency: number | Promise<void>) {
    const asked: string[] = [];
    const state = { running: 0, peak: 0 };
    const cloud = {
      configured: async () => true,
      wait: async () => ({ ok: false, error: 'not asked' }),
      upload: async (input: { name: string }) => {
        asked.push(input.name);
        state.running++;
        state.peak = Math.max(state.peak, state.running);
        await (typeof latency === 'number' ? sleep(latency) : latency);
        state.running--;
        return { ok: true, assetId: `id-${input.name}` } as UploadResult;
      },
    } as unknown as OpenCloudAssets;
    return { asked, state, cloud };
  }
  const makeUploader = (cloud: OpenCloudAssets) => new ModelUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42' });
  const manyParts = (root: string, n: number, uploaded: number[] = []) => {
    const store = new ModelStore(root);
    return Array.from({ length: n }, (_, i) => {
      const m = savePart(root, `Many_${i}`);
      return uploaded.includes(i) ? store.save({ ...m, upload: { assetId: `old-${i}`, hash: m.hash, at: '' } }) : m;
    });
  };

  it('uploads only the parts that changed, up to six at once, and reports progress as they finish', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const parts = manyParts(root, 14, [0, 1, 2, 3]);
    const fake = roblox(30);
    const progress: Array<{ done: number; total: number; message: string }> = [];
    const r = await makeUploader(fake.cloud).ensureMany(root, parts, { onProgress: (p) => progress.push(p) });
    // The four parts whose build was uploaded already are not sent again.
    expect(fake.asked.sort()).toEqual(parts.slice(4).map((m) => m.name).sort());
    expect(fake.state.peak).toBe(6);
    expect(r.stillUploading).toEqual([]);
    expect(r.results.map((x) => x.name)).toEqual(parts.map((m) => m.name));
    expect(r.results.filter((x) => x.reused)).toHaveLength(4);
    expect(r.results.filter((x) => x.assetId?.startsWith('id-'))).toHaveLength(10);
    const done = progress.map((p) => p.done);
    expect(done[0]).toBe(0);
    expect(done.at(-1)).toBe(10);
    expect([...done].sort((a, b) => a - b)).toEqual(done);
    expect(progress.at(-1)).toMatchObject({ total: 10, message: 'Uploaded 10 of 10 parts to Roblox' });
    expect(progress[0]!.message).toMatch(/Uploaded 0 of 10 parts to Roblox \(6 at a time, 10 to go\)/);
    // Everything is on record: the next call sends nothing.
    fake.asked.length = 0;
    await makeUploader(fake.cloud).ensureMany(root, parts, {});
    expect(fake.asked).toEqual([]);
  });

  it('answers "still uploading" at the budget, lets the uploads carry on, and the next call joins them instead of uploading twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const parts = manyParts(root, 3);
    let release!: () => void;
    const fake = roblox(new Promise<void>((r) => (release = r)));
    const up = makeUploader(fake.cloud);
    const first = await up.ensureMany(root, parts, { budgetMs: 40 });
    expect(first.stillUploading.sort()).toEqual(parts.map((m) => m.name).sort());
    expect(first.results).toEqual([]);
    expect(up.uploading(root).sort()).toEqual(parts.map((m) => m.name).sort());
    // Another call (another run) joins the three uploads under way.
    const second = up.ensureMany(root, parts, { budgetMs: 5000 });
    await sleep(20);
    release();
    const r2 = await second;
    expect(r2.stillUploading).toEqual([]);
    expect(fake.asked).toHaveLength(3);
    expect(r2.results.map((x) => x.assetId)).toEqual(parts.map((m) => `id-${m.name}`));
    const store = new ModelStore(root);
    expect(parts.map((m) => ModelStore.assetId(store.get(m.name)!))).toEqual(parts.map((m) => `id-${m.name}`));
    expect(up.uploading(root)).toEqual([]);
  });

  it('stops waiting when the run is stopped but not the uploads, and sends a sign of life while it waits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const parts = manyParts(root, 2);
    let release!: () => void;
    const fake = roblox(new Promise<void>((r) => (release = r)));
    const up = makeUploader(fake.cloud);
    const run = new AbortController();
    const beats: number[] = [];
    // The run is stopped once a few signs of life have gone out (however slowly a busy machine runs its timers).
    void (async () => {
      for (let i = 0; i < 500 && beats.length < 4; i++) await sleep(10);
      run.abort();
    })();
    const r = await up.ensureMany(root, parts, { signal: run.signal, heartbeatMs: 20, onProgress: (p) => beats.push(p.done) });
    expect(r.stillUploading).toHaveLength(2);
    // Nothing finished, yet progress went out several times (the initial one and the heartbeats).
    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(new Set(beats)).toEqual(new Set([0]));
    release();
    await sleep(50);
    const store = new ModelStore(root);
    expect(parts.map((m) => ModelStore.assetId(store.get(m.name)!))).toEqual(parts.map((m) => `id-${m.name}`));
  });

  it('model_place answers "still uploading" when its run stops, and the next call goes on with the same uploads', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    const store = new ModelStore(root);
    for (const n of ['Hut_Wall', 'Hut_Roof']) savePart(root, n, { assembly: 'Hut', origin: [0, 1, 0] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const asked: string[] = [];
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    cloud.upload = async (input: { name: string }) => {
      asked.push(input.name);
      await gate;
      return { ok: true, assetId: `id-${input.name}` };
    };
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async () => ({ ok: true, output: JSON.stringify({ path: 'Workspace.Hut', position: [0, 0, 0], notes: [], parts: { Hut_Wall: { pos: [0, 1, 0], rot: [0, 0, 0] }, Hut_Roof: { pos: [0, 2, 0], rot: [0, 0, 0] } } }), durationMs: 1 });
    const run = new AbortController();
    setTimeout(() => run.abort(), 50);
    const first = await core.tools.invoke('model_place', { name: 'Hut', position: [0, 5, 0] }, agent, run.signal);
    expect(first.isError, text(first)).toBeFalsy();
    expect(JSON.parse(text(first))).toMatchObject({ uploading: true, stillUploading: expect.arrayContaining(['Hut_Wall', 'Hut_Roof']), uploaded: 0, parts: 2 });
    expect(text(first)).toMatch(/Call model_place again: it joins the uploads that are running/);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(ModelStore.assetId(store.get('Hut_Wall')!)).toBe('id-Hut_Wall');
    const second = await core.tools.invoke('model_place', { name: 'Hut', position: [0, 5, 0] }, agent);
    expect(JSON.parse(text(second))).toMatchObject({ permanent: true, parts: expect.arrayContaining(['Hut_Wall', 'Hut_Roof']) });
    // Each part went to Roblox exactly once.
    expect(asked.sort()).toEqual(['Hut_Roof', 'Hut_Wall']);
  });

  it('an MCP client that sent a progress token gets progress notifications while the uploads go', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    for (const n of ['Hut_Wall', 'Hut_Roof', 'Hut_Door']) savePart(root, n, { assembly: 'Hut', origin: [0, 1, 0] });
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    cloud.upload = async (input: { name: string }) => {
      await sleep(60);
      return { ok: true, assetId: `id-${input.name}` };
    };
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async () => ({ ok: true, output: JSON.stringify({ path: 'Workspace.Hut', position: [0, 0, 0], notes: [], parts: {} }), durationMs: 1 });
    const token = core.mcp.issueToken({ ...agent, providerId: 'fake' });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(core.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const seen: Array<{ progress: number; message?: string }> = [];
    const res = await client.callTool({ name: 'model_place', arguments: { name: 'Hut', position: [0, 5, 0] } }, undefined, { onprogress: (p) => seen.push({ progress: p.progress, message: p.message }) });
    expect(res.isError).toBeFalsy();
    // Each notification is a sign of life: the number only ever goes up, and it says how far the uploads are.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.map((s) => s.progress)).toEqual([...seen.map((s) => s.progress)].sort((a, b) => a - b));
    expect(new Set(seen.map((s) => s.progress)).size).toBe(seen.length);
    expect(seen.at(-1)!.message).toMatch(/Uploaded 3 of 3 parts to Roblox/);
    // Without a token (a plain tool call) nothing is sent and the call works the same.
    const plain = await core.tools.invoke('model_place', { name: 'Hut', position: [0, 5, 0] }, agent);
    expect(plain.isError).toBeFalsy();
    await client.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Kiln clips reach the game's animations: world/Animations.luau and Studio follow the clip files
// ---------------------------------------------------------------------------------------------

const BUG_RIG = {
  version: 2, model: 'Bug', source: 'kiln', kind: 'custom', root: 'Root',
  joints: [
    { name: 'Root', parent: null, part: 'Root', pivot: [0, 1, 0], kind: 'ball' },
    { name: 'Tail', parent: 'Root', part: 'Tail', pivot: [0, 1, 1], kind: 'ball' },
  ],
  legs: [], attachments: [],
};
/** models/Bug.clips.json as Kiln's export writes it: one clip, Wag, whose tail turns `rot` degrees. */
const bugClips = (rot: number, fp: string) => ({
  version: 1, model: 'Bug', kind: 'custom', fps: 30,
  clips: [{ name: 'Wag', loop: true, in_place: true, priority: 'Idle', speed: null, fade: 0.2, length: 1, generator: null, fp, markers: [], keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }, { t: 0.5, poses: { Tail: { rot: [0, rot, 0] } } }, { t: 1, poses: { Tail: { rot: [0, 0, 0] } } }] }],
});

describe('AnimationRebuilder: the place follows the clip files', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('shares one build between changes that come close together, builds once more for a change during a build, and says why when Studio is not there', async () => {
    const { AnimationRebuilder, summarize } = await import('../src/core/animation/animation-rebuild');
    const { jsonOutput, errorOutput } = await import('../src/core/capabilities/tool-registry');
    let builds = 0;
    const rb = new AnimationRebuilder({
      ready: () => ({ ok: true }),
      build: async () => {
        builds++;
        await sleep(40);
        return jsonOutput({ built: [{ name: 'BugWag', id: 'rbxassetid://1' }], failed: [] });
      },
    });
    rb.schedule(10);
    rb.schedule(10);
    rb.schedule(10);
    await sleep(120);
    expect(builds).toBe(1);
    // A change arrives while a build is going on: that build is joined and one more follows it.
    const joined = rb.now();
    await sleep(10);
    rb.schedule(10);
    const second = rb.now();
    expect(await joined).toMatchObject({ updated: true, built: ['BugWag'] });
    expect(await second).toMatchObject({ updated: true });
    expect(builds).toBe(3);
    // Not ready: nothing is built, and the note says where the build will happen instead.
    const idle = new AnimationRebuilder({ ready: () => ({ ok: false, reason: 'Studio is not connected' }), build: async () => jsonOutput({}) });
    expect(await idle.now()).toMatchObject({ updated: false, note: expect.stringMatching(/Studio wasn't updated \(Studio is not connected\).*world\/Animations\.luau is current/) });
    // animation_build's own answers: built, failed clips, and "Studio is not connected".
    expect(summarize(jsonOutput({ built: [{ name: 'A', id: '1' }], failed: [{ name: 'B', error: 'bad pose' }] }))).toMatchObject({ updated: true, note: expect.stringMatching(/1 clip.*1 did not build: B \(bad pose\)/) });
    expect(summarize(jsonOutput({ built: [], failed: [], note: 'Studio is not connected; world/Animations.luau builds on the next world_rebuild.' }))).toMatchObject({ updated: false, note: expect.stringMatching(/Studio wasn't updated: Studio is not connected/) });
    expect(summarize(errorOutput('Capability roblox.app.animation is unavailable: no Studio'))).toMatchObject({ updated: false, note: expect.stringMatching(/unavailable/) });
  });
});

describe('recordClips: world/Animations.luau follows the clips and the rig', () => {
  it('writes the changed keys into the builder and asks for a rebuild only when something changed', async () => {
    const { recordClips } = await import('../src/core/modeling/publish');
    const { EventBus } = await import('../src/core/events');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    mkdirSync(join(root, 'models'), { recursive: true });
    const write = (rig: unknown, clips: unknown) => {
      writeFileSync(join(root, 'models', 'Bug.rig.json'), JSON.stringify(rig));
      writeFileSync(join(root, 'models', 'Bug.clips.json'), JSON.stringify(clips));
    };
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on('animations.changed', (e) => events.push(e));
    const builder = () => readFileSync(join(root, 'world', 'Animations.luau'), 'utf8');

    write(BUG_RIG, bugClips(20, 'fp1'));
    expect(recordClips(root, 'Bug', bus).added).toEqual(['BugWag']);
    expect(builder()).toContain('r={0,20,0}');
    expect(events).toEqual([{ stale: true }]);

    // Nothing changed in Kiln: nothing to rebuild.
    recordClips(root, 'Bug', bus);
    expect(events).toHaveLength(1);

    // The user retimed the wag in Kiln: the builder has the new keys, the place is stale.
    write(BUG_RIG, bugClips(35, 'fp2'));
    expect(recordClips(root, 'Bug', bus).updated).toEqual(['BugWag']);
    expect(builder()).toContain('r={0,35,0}');
    expect(builder()).not.toContain('r={0,20,0}');
    expect(events).toHaveLength(2);

    // The rig changed (a new joint) while the clip didn't: the poses nest along the joints, so the builder changes too.
    write({ ...BUG_RIG, joints: [...BUG_RIG.joints, { name: 'Fin', parent: 'Tail', part: 'Fin', pivot: [0, 1, 2], kind: 'ball' }] }, bugClips(35, 'fp2'));
    expect(recordClips(root, 'Bug', bus)).toMatchObject({ updated: [], unchanged: ['BugWag'] });
    expect(builder()).toContain('["Fin"]="Tail"');
    expect(events).toHaveLength(3);
    recordClips(root, 'Bug', bus);
    expect(events).toHaveLength(3);
  });
});

describe('kiln_import builds the clips into Studio', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const readBody = (req: import('node:http').IncomingMessage) =>
    new Promise<Record<string, unknown>>((ok) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => ok(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
    });

  it('imports the clips, regenerates the builder, rebuilds Studio and says so; says it did not without Studio; follows live changes by itself', async () => {
    const { createServer } = await import('node:http');
    const { EventBus } = await import('../src/core/events');
    const { Logger } = await import('../src/core/log');
    const { KilnModeling } = await import('../src/core/modeling/kiln-modeling');
    const { ToolRegistry, jsonOutput } = await import('../src/core/capabilities/tool-registry');
    const { registerKilnTools } = await import('../src/core/capabilities/kiln-tools');
    const priorNoKiln = process.env.SHURIKEN_NO_KILN;
    delete process.env.SHURIKEN_NO_KILN;
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const tmp = mkdtempSync(join(tmpdir(), 'kiln-fid-'));
    const scene = join(tmp, 'scene.blend');
    writeFileSync(scene, 'BLENDER-fake');
    const kilnState = { rot: 20, fp: 'fp1' };
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer test-token') return void res.writeHead(401).end();
      const b = req.method === 'POST' ? await readBody(req) : {};
      const path = (req.url ?? '').split('?')[0]!;
      const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (path === '/api/v1/app') return send({ version: '0.7.1', blender: { path: 'C:/Blender/blender.exe' }, projects: [] });
      if (path.endsWith('/state')) return send({ project: { id: 'bug-proj', title: 'Bug', units: 'studs', linked: { app: 'Shuriken Studio', model: 'Bug', project: root } }, scene: { version: 1 } });
      if (path.endsWith('/lock')) return send({ lock: null });
      if (path.endsWith('/file')) return send({ scene, version: 1 });
      if (path.endsWith('/ext')) {
        const args = b.args as { dir: string; name: string };
        mkdirSync(args.dir, { recursive: true });
        writeFileSync(join(args.dir, `${args.name}.rig.json`), JSON.stringify(BUG_RIG));
        writeFileSync(join(args.dir, `${args.name}.clips.json`), JSON.stringify(bugClips(kilnState.rot, kilnState.fp)));
        writeFileSync(join(args.dir, `${args.name}.mesh.json`), '{"v":[],"n":[],"t":[]}');
        writeFileSync(join(args.dir, `${args.name}.glb`), 'glb');
        return send({ ok: true, parts: [{ name: args.name, blender_material: 'Shell', segment: 'Root', color: '#3f5a2a', material: 'SmoothPlastic', transparency: 0, origin: [0, 1, 0], size: [1, 1, 1], triangles: 12, vertices: 8 }], size: [1, 1, 1], tris: 12, anim_fp: kilnState.fp });
      }
      res.writeHead(404).end('{}');
    });
    const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)));
    const runtime = join(tmp, 'runtime.json');
    writeFileSync(runtime, JSON.stringify({ app: 'kiln', version: '0.7.1', port, token: 'test-token', pid: process.pid }));
    mkdirSync(join(root, '.shuriken', 'kiln'), { recursive: true });
    writeFileSync(join(root, '.shuriken', 'kiln', 'Bug.json'), JSON.stringify({ projectId: 'bug-proj' }));
    const bus = new EventBus();
    const fallback = { status: () => ({ ready: true, exe: 'blender.exe', version: '5.2', max: 4, running: 0, detail: 'Blender 5.2' }), workspace: () => ({}), list: () => [], releaseRun() {}, stop() {} };
    const modeling = new KilnModeling(fallback as never, { enabled: () => true, resourcesDir: resolve(__dirname, '..', 'resources'), runtimeFile: () => runtime }, bus, new Logger(null, null).scope('kiln'));
    await modeling.kiln.check(true);

    // The tools, with a Studio that is there (or not) and an animation_build that counts its builds.
    const reg = new ToolRegistry({ rules: () => ({}) as never, requestApproval: async () => true, notify: () => undefined }, { record: () => undefined }, new Logger(null, null).scope('tools'));
    const studio = { up: true };
    let builds = 0;
    reg.register({
      name: 'animation_build', title: 'Build all animations', description: 'test', capability: 'roblox.app.animation', permission: 'roblox_write', input: {},
      available: () => (studio.up ? { ok: true } : { ok: false, reason: 'Roblox Studio is not connected' }),
      handler: async () => {
        builds++;
        return jsonOutput({ built: [{ name: 'BugWag', id: 'rbxassetid://9' }], failed: [], runtime: {} });
      },
    });
    registerKilnTools(reg, { project: () => ({ root }) as never, kiln: () => modeling, modeling: () => modeling, bus });
    const ui = { kind: 'ui' as const, runId: null, taskId: null, role: 'user', providerId: null, allowedTools: null };
    try {
      const first = await reg.invoke('kiln_import', { model: 'Bug' }, ui);
      expect(first.isError, text(first)).toBeFalsy();
      const out = first.data as { clips: { added: string[] }; animations: Array<{ name: string }>; studio: { updated: boolean; built: string[]; note: string }; next: string };
      expect(out.clips.added).toEqual(['BugWag']);
      expect(out.studio).toMatchObject({ updated: true, built: ['BugWag'] });
      expect(out.next).toMatch(/built into Studio/);
      expect(builds).toBe(1);
      const builder = () => readFileSync(join(root, 'world', 'Animations.luau'), 'utf8');
      expect(builder()).toContain('r={0,20,0}');

      // The clip changes in Kiln; importing again puts the new keys in the builder and in Studio (one build, not two).
      kilnState.rot = 35;
      kilnState.fp = 'fp2';
      const second = await reg.invoke('kiln_import', { model: 'Bug' }, ui);
      expect((second.data as { clips: { updated: string[] } }).clips.updated).toEqual(['BugWag']);
      expect((second.data as { studio: { updated: boolean } }).studio.updated).toBe(true);
      expect(builder()).toContain('r={0,35,0}');
      await sleep(1700);
      expect(builds).toBe(2);

      // Without Studio the files are current and the result says Studio was not updated.
      studio.up = false;
      kilnState.rot = 50;
      kilnState.fp = 'fp3';
      const third = await reg.invoke('kiln_import', { model: 'Bug' }, ui);
      expect((third.data as { studio: { updated: boolean; note: string } }).studio).toMatchObject({ updated: false, note: expect.stringMatching(/Studio wasn't updated .*world\/Animations\.luau is current/) });
      expect(builder()).toContain('r={0,50,0}');
      expect(builds).toBe(2);

      // Clips that come in by themselves (the user animates in Kiln, Shuriken's live sync) rebuild Studio a moment later.
      studio.up = true;
      kilnState.rot = 65;
      kilnState.fp = 'fp4';
      const { recordClips } = await import('../src/core/modeling/publish');
      writeFileSync(join(root, 'models', 'Bug.clips.json'), JSON.stringify(bugClips(65, 'fp4')));
      recordClips(root, 'Bug', bus);
      expect(builds).toBe(2);
      for (let i = 0; i < 100 && builds < 3; i++) await sleep(100);
      expect(builds).toBe(3);
      expect(builder()).toContain('r={0,65,0}');
    } finally {
      server.close();
      modeling.stop();
      if (priorNoKiln !== undefined) process.env.SHURIKEN_NO_KILN = priorNoKiln;
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Creature clips: the runtime prefers uploaded ids, warns on the server, and the build uploads them
// ---------------------------------------------------------------------------------------------

describe('the generated animation runtime', () => {
  it('prefers a clip’s uploaded asset to a Studio-local id (Studio too), and warns once when a server uses a local id for a creature', async () => {
    const { RUNTIME_MODULE, RUNTIME_VERSION } = await import('../src/core/animation/luau');
    expect(RUNTIME_VERSION).toBe(5);
    expect(RUNTIME_MODULE).toContain('-- ShurikenAnimations v5 (generated by Shuriken Studio');
    // The id: the uploaded asset (the Animation's AssetId attribute) is looked at before a Studio-local id is registered.
    const resolve = RUNTIME_MODULE.slice(RUNTIME_MODULE.indexOf('local function resolve('), RUNTIME_MODULE.indexOf('function Anims.id('));
    expect(resolve.indexOf('GetAttribute("AssetId")')).toBeGreaterThan(0);
    expect(resolve.indexOf('RegisterKeyframeSequence')).toBeGreaterThan(resolve.indexOf('GetAttribute("AssetId")'));
    expect(resolve.indexOf('if RunService:IsStudio() then')).toBeGreaterThan(resolve.indexOf('return id, false'));
    // A Studio-local id is remembered as such...
    expect(resolve).toContain('studioOnly[name] = true');
    expect(resolve).toContain('return id, true');
    // ...and loading a track on the server for a rig that isn't a player's character warns once per clip.
    const load = RUNTIME_MODULE.slice(RUNTIME_MODULE.indexOf('function Anims.load('), RUNTIME_MODULE.indexOf('--- Play a clip.'));
    expect(load).toContain('local id, localOnly = resolve(name)');
    expect(load).toMatch(/if localOnly and RunService:IsServer\(\) and not isPlayerCharacter\(animator\) and not warnedServer\[name\] then/);
    expect(RUNTIME_MODULE).toContain("[ShurikenAnimations] %s isn't uploaded: players won't see it (it plays on the server only). Upload it with animation_upload.");
    expect(RUNTIME_MODULE).toContain('Players:GetPlayerFromCharacter(model)');
    // The public id function still answers with the id alone.
    expect(RUNTIME_MODULE).toMatch(/function Anims\.id\(name: string\): string\?\n\tlocal id = resolve\(name\)\n\treturn id\nend/);
  });

  it('is written into projects that have an older generated module, but a hand-replaced one is left alone', async () => {
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    const { RUNTIME_MODULE } = await import('../src/core/animation/luau');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-anim-'));
    const store = new AnimationStore(root);
    const loc = AnimationStore.runtimeLocation(undefined);
    mkdirSync(join(root, loc.file, '..'), { recursive: true });
    writeFileSync(join(root, loc.file), RUNTIME_MODULE.replace('-- ShurikenAnimations v5 (generated', '-- ShurikenAnimations v4 (generated'));
    expect(store.ensureRuntime(undefined).written).toBe(true);
    expect(readFileSync(join(root, loc.file), 'utf8')).toBe(RUNTIME_MODULE);
    writeFileSync(join(root, loc.file), '-- my own animation module\nreturn {}\n');
    expect(store.ensureRuntime(undefined).written).toBe(false);
    expect(readFileSync(join(root, loc.file), 'utf8')).toContain('my own animation module');
  });
});

/** A creature's clip (Stalker's tail wags) and an R15 clip, saved in a project that has Stalker's rig. */
async function creatureProject(root: string) {
  const { AnimationStore } = await import('../src/core/animation/animation-service');
  const { buildPreset } = await import('../src/core/animation/presets');
  stalker(root, ['Body', 'Tail', 'Claw']);
  const store = new AnimationStore(root);
  const wag = (rot: number) => ({ name: 'StalkerWag', rig: 'Stalker', loop: true, priority: 'Idle' as const, keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] as [number, number, number] } } }, { t: 1, poses: { Tail: { rot: [0, rot, 0] as [number, number, number] } } }] });
  store.save({ clip: wag(20) });
  store.save({ clip: buildPreset('Walk', 'Walk'), preset: 'Walk' });
  return { store, wag };
}

/** Studio stand-in for the animation builder: answers it with the clips it was given, counts builds. */
function animationStudio(core: Core) {
  const studio = core.studio as unknown as Record<string, unknown>;
  Object.defineProperty(core.studio, 'connected', { get: () => true, configurable: true });
  studio.availability = () => ({ ok: true });
  const builds: string[] = [];
  studio.runLuau = async (code: string) => {
    if (code.includes('local CLIPS = {')) {
      builds.push(code);
      const built = [...code.matchAll(/\{name="([^"]+)",loop=/g)].map((m) => ({ name: m[1]!, id: `rbxassetid://${m[1]}` }));
      return { ok: true, output: JSON.stringify({ built, failed: [] }), durationMs: 1 };
    }
    return { ok: true, output: JSON.stringify({ path: 'Workspace.Stalker', position: [0, 2, 0], notes: [] }), durationMs: 1 };
  };
  return builds;
}

describe('clip uploads: only changed clips, together, never aborted with the run, pending kept', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fakeClipCloud = (upload: (input: { name: string }) => Promise<UploadResult> | UploadResult, wait: (op: string) => Promise<UploadResult> | UploadResult = () => ({ ok: false, error: 'not asked' })) => {
    const log = { upload: [] as unknown[][], wait: [] as unknown[][] };
    return {
      log,
      cloud: {
        configured: async () => true,
        upload: async (...args: unknown[]) => {
          log.upload.push(args);
          return upload(args[0] as { name: string });
        },
        wait: async (...args: unknown[]) => {
          log.wait.push(args);
          return wait(args[0] as string);
        },
      } as unknown as OpenCloudAssets,
    };
  };

  it('uploads a creature clip once, records it, finds it unchanged, and drops it when the clip is edited', async () => {
    const { AnimationUploads } = await import('../src/core/animation/animation-uploads');
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const { store, wag } = await creatureProject(root);
    const { cloud, log } = fakeClipCloud(() => ({ ok: true, assetId: '7001' }));
    const up = new AnimationUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42' });
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '7001' });
    // upload(input) only: no abort signal of any run; an .rbxmx of the clip went up as an Animation.
    expect(log.upload[0]).toHaveLength(1);
    expect(log.upload[0]![0]).toMatchObject({ type: 'Animation', name: 'StalkerWag', creator: { userId: '42' } });
    expect(store.summary(store.get('StalkerWag')!).uploaded).toBe('7001');
    expect(readFileSync(join(root, 'world', 'Animations.luau'), 'utf8')).toContain('asset="7001"');
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '7001', reused: true });
    expect(log.upload).toHaveLength(1);
    // Edited: the old upload is no longer valid, the new content goes up.
    store.save({ clip: wag(35) });
    expect(new AnimationStore(root).summary(store.get('StalkerWag')!).uploaded).toBeNull();
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '7001' });
    expect(log.upload).toHaveLength(2);
  });

  it('uploads a clip again when uploads now go to another owner (a game moved to a community needs its clips under it)', async () => {
    const { AnimationUploads } = await import('../src/core/animation/animation-uploads');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const { store } = await creatureProject(root);
    let owner = 'u';
    const { cloud, log } = fakeClipCloud(() => ({ ok: true, assetId: owner === 'u' ? '7001' : '9001', owner }));
    const up = new AnimationUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42', ownerKey: async () => owner });
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '7001' });
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '7001', reused: true });
    owner = 'g:555';
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '9001' });
    expect(log.upload).toHaveLength(2);
    expect(store.get('StalkerWag')!.upload).toMatchObject({ assetId: '9001', owner: 'g:555' });
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '9001', reused: true });
    // A clip uploaded before owners were recorded counts as the person's.
    owner = 'u';
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '7001' });
    expect(log.upload).toHaveLength(3);
  });

  it('keeps an upload Roblox is still processing as the clip’s pending operation and asks about it next time instead of uploading again', async () => {
    const { AnimationUploads } = await import('../src/core/animation/animation-uploads');
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const { store } = await creatureProject(root);
    let ready = false;
    const { cloud, log } = fakeClipCloud(
      () => ({ ok: false, pending: true, operation: 'op-clip-1', error: 'still processing' }),
      () => (ready ? { ok: true, assetId: '8002' } : { ok: false, pending: true, operation: 'op-clip-1', error: 'still processing' }),
    );
    const up = new AnimationUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42' });
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: null, pending: true });
    expect(store.get('StalkerWag')!.uploading).toMatchObject({ operation: 'op-clip-1' });
    expect(AnimationStore.pendingOperation(store.get('StalkerWag')!)).toBe('op-clip-1');
    expect(store.summary(store.get('StalkerWag')!).uploaded).toBeNull();
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ pending: true });
    expect(log.upload).toHaveLength(1);
    ready = true;
    expect(await up.ensure(root, 'StalkerWag')).toMatchObject({ assetId: '8002' });
    expect(log.upload).toHaveLength(1);
    const now = store.get('StalkerWag')!;
    expect(now.upload).toMatchObject({ assetId: '8002' });
    expect(now.uploading).toBeUndefined();
  });

  it('uploads several clips at the same time, joins an upload under way, and carries on after the budget', async () => {
    const { AnimationUploads } = await import('../src/core/animation/animation-uploads');
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    const { buildPreset } = await import('../src/core/animation/presets');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const store = new AnimationStore(root);
    for (const n of ['Walk', 'Run', 'Idle', 'Jump']) store.save({ clip: buildPreset(n, n), preset: n });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let peak = 0;
    const { cloud, log } = fakeClipCloud(async (input) => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return { ok: true, assetId: `id-${input.name}` };
    });
    const up = new AnimationUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42' });
    const names = ['Walk', 'Run', 'Idle', 'Jump'];
    const first = await up.ensureMany(root, names, { budgetMs: 40 });
    expect(first.stillUploading.sort()).toEqual(['Idle', 'Jump', 'Run', 'Walk']);
    expect(up.uploading(root).sort()).toEqual(['Idle', 'Jump', 'Run', 'Walk']);
    const second = up.ensureMany(root, names, { budgetMs: 5000 });
    await sleep(20);
    release();
    const r = await second;
    expect(r.stillUploading).toEqual([]);
    expect(log.upload).toHaveLength(4);
    expect(peak).toBe(4);
    expect(names.map((n) => store.summary(store.get(n)!).uploaded)).toEqual(names.map((n) => `id-${n}`));
  });
});

describe('animation_build uploads the creature clips that changed', () => {
  it('uploads them while it builds, builds again with their asset ids, and says what went up; unchanged clips are not sent again', async () => {
    const { core, root } = await makeCore();
    const { store } = await creatureProject(root);
    const builds = animationStudio(core);
    const asked = uploadsFor(core, (name) => ({ ok: true, assetId: `a-${name}` }));
    const r = await core.tools.invoke('animation_build', {}, agent);
    expect(r.isError, text(r)).toBeFalsy();
    // Only the creature's clip went to Roblox (the R15 walk plays in Studio from its KeyframeSequence).
    expect(asked).toEqual(['StalkerWag']);
    expect(r.data).toMatchObject({ uploads: { uploaded: [{ name: 'StalkerWag', assetId: 'a-StalkerWag' }] } });
    // Built once at the start and once more with the asset id in the Animation.
    expect(builds).toHaveLength(2);
    expect(builds[0]).toMatch(/name="StalkerWag",loop=true,priority="Idle",duration=1,asset=nil,/);
    expect(builds[1]).toMatch(/name="StalkerWag",loop=true,priority="Idle",duration=1,asset="a-StalkerWag",/);
    expect(store.summary(store.get('StalkerWag')!).uploaded).toBe('a-StalkerWag');
    // Again: nothing changed, nothing is uploaded, one build.
    const again = await core.tools.invoke('animation_build', {}, agent);
    expect(asked).toEqual(['StalkerWag']);
    expect(builds).toHaveLength(3);
    expect((again.data as { uploads?: unknown }).uploads).toBeUndefined();
    // An edit to the clip uploads it again.
    store.save({ clip: { ...store.get('StalkerWag')!.clip, keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }, { t: 1, poses: { Tail: { rot: [0, 45, 0] } } }] } });
    await core.tools.invoke('animation_build', {}, agent);
    expect(asked).toEqual(['StalkerWag', 'StalkerWag']);
  });

  it('says why creature clips are not uploaded when uploading is not possible, and still builds', async () => {
    const { core, root } = await makeCore();
    await creatureProject(root);
    const builds = animationStudio(core);
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => false;
    core.prefs.set({ robloxCreatorId: '42' });
    const r = await core.tools.invoke('animation_build', {}, agent);
    expect(r.isError, text(r)).toBeFalsy();
    expect(builds).toHaveLength(1);
    const uploads = (r.data as { uploads: { skipped: string; clips: string[]; note: string } }).uploads;
    expect(uploads).toMatchObject({ clips: ['StalkerWag'] });
    expect(uploads.skipped).toMatch(/no Open Cloud API key/);
    expect(uploads.note).toMatch(/1 creature clip \(StalkerWag\) isn't uploaded .*a server script that plays it shows nothing to the players/);
  });

  it('keeps a clip Roblox is still processing as pending, then picks it up on the next build', async () => {
    const { core, root } = await makeCore();
    const { store } = await creatureProject(root);
    const builds = animationStudio(core);
    let done = false;
    uploadsFor(core, () => ({ ok: false, pending: true, operation: 'op-anim-9', error: 'still processing' }));
    (core.assetUploads as unknown as Record<string, unknown>).wait = async () => (done ? { ok: true, assetId: 'a-late' } : { ok: false, pending: true, operation: 'op-anim-9', error: 'still processing' });
    const first = await core.tools.invoke('animation_build', {}, agent);
    expect(first.isError, text(first)).toBeFalsy();
    expect(first.data).toMatchObject({ uploads: { uploaded: [], pending: ['StalkerWag'] } });
    expect(builds).toHaveLength(1);
    expect(store.get('StalkerWag')!.uploading).toMatchObject({ operation: 'op-anim-9' });
    done = true;
    const second = await core.tools.invoke('animation_build', {}, agent);
    expect(second.data).toMatchObject({ uploads: { uploaded: [{ name: 'StalkerWag', assetId: 'a-late' }] } });
    expect(builds).toHaveLength(3);
    expect(builds.at(-1)).toContain('asset="a-late"');
  });

  it('animation_create for a creature clip uploads it too, and rig_build uploads the creature’s clips that are not up yet', async () => {
    const { core, root } = await makeCore();
    const { store } = await creatureProject(root);
    const builds = animationStudio(core);
    const asked = uploadsFor(core, (name) => ({ ok: true, assetId: `a-${name}` }));
    const made = await core.tools.invoke('animation_create', { rig: 'Stalker', clip: { name: 'StalkerShiver', loop: true, priority: 'Idle', keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }, { t: 0.4, poses: { Tail: { rot: [0, 10, 0] } } }] } }, agent);
    expect(made.isError, text(made)).toBeFalsy();
    // Both of the creature's clips were not uploaded yet: both go up (the R15 one isn't a creature's).
    expect(asked.sort()).toEqual(['StalkerShiver', 'StalkerWag']);
    expect(made.data).toMatchObject({ uploads: { uploaded: expect.arrayContaining([{ name: 'StalkerShiver', assetId: 'a-StalkerShiver' }]) } });
    expect(builds.length).toBeGreaterThanOrEqual(2);
    // The creature's clips changed (a new take of the wag): rig_build builds the rig and uploads it with the next build.
    store.save({ clip: { ...store.get('StalkerWag')!.clip, keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }, { t: 1, poses: { Tail: { rot: [0, 60, 0] } } }] } });
    const before = asked.length;
    const sent = rigStudio(core);
    animationStudioKeepRig(core, sent);
    const rig = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(rig.isError, text(rig)).toBeFalsy();
    expect(asked.slice(before)).toEqual(['StalkerWag']);
    expect(rig.data).toMatchObject({ clips: { uploaded: [{ name: 'StalkerWag', assetId: 'a-StalkerWag' }], clips: ['StalkerWag'] } });
  });
});

/** rigStudio's Studio, which also answers the animation builder (so rig_build's clip upload can rebuild). */
function animationStudioKeepRig(core: Core, sent: Array<{ kind: string; code: string }>) {
  const studio = core.studio as unknown as { runLuau: (code: string) => Promise<{ ok: boolean; output: string; durationMs: number }> };
  const rigsAnswer = studio.runLuau;
  studio.runLuau = async (code: string) => {
    if (code.includes('local CLIPS = {')) {
      sent.push({ kind: 'animations', code });
      const built = [...code.matchAll(/\{name="([^"]+)",loop=/g)].map((m) => ({ name: m[1]!, id: `rbxassetid://${m[1]}` }));
      return { ok: true, output: JSON.stringify({ built, failed: [] }), durationMs: 1 };
    }
    return rigsAnswer(code);
  };
}

// ---------------------------------------------------------------------------------------------
// Temporary meshes keep the shading the model was exported with (its own normals)
// ---------------------------------------------------------------------------------------------

describe('temporary meshes pass the exported normals to EditableMesh', () => {
  const selene = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene');
  // Two triangles of a cube's corner: the vertex they share is split (one position, two normals), as along a UV seam.
  const mesh = { v: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1], n: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0.7071, 0.7071, 0, 0.7071, 0.7071, 0, 0.7071, 0.7071, 0], t: [0, 1, 2, 3, 4, 5], uv: [0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1] };
  const placement = { name: 'Crate', parent: 'Workspace', position: [0, 1, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1 };

  it('temporaryMeshLuau gives every vertex its normal and every face its three, guarded so an older Studio still builds the mesh', async () => {
    const { temporaryMeshLuau, NORMALS_FN, meshNormals } = await import('../src/core/modeling/model-store');
    const code = temporaryMeshLuau('Crate', mesh, placement, true);
    expect(code).toContain('local N = {0,0,1,0,0,1,0,0,1,0.707,0.707,0,0.707,0.707,0,0.707,0.707,0}');
    expect(code).toContain(NORMALS_FN);
    // AddNormal per normal, SetFaceNormals per triangle (the face AddTriangle returned), all inside one pcall.
    expect(NORMALS_FN).toContain('em:AddNormal(Vector3.new(N[i], N[i + 1], N[i + 2]))');
    expect(NORMALS_FN).toContain('em:SetFaceNormals(face, { ids[T[i] + 1], ids[T[i + 1] + 1], ids[T[i + 2] + 1] })');
    expect(NORMALS_FN).toMatch(/pcall\(function\(\)[\s\S]*AddNormal[\s\S]*SetFaceNormals[\s\S]*end\)\nend$/);
    expect(code).toContain('faces[#faces + 1] = f');
    expect(code).toContain('if N then setNormals(em, faces, N, T) end');
    // The normals go in after the triangles and before the part is made from the mesh.
    expect(code.indexOf('if N then setNormals')).toBeGreaterThan(code.indexOf('em:AddTriangle'));
    expect(code.indexOf('if N then setNormals')).toBeLessThan(code.indexOf('CreateMeshPartAsync'));
    // A mesh without normals (older exports, or ones of another length) is built as before.
    expect(temporaryMeshLuau('Crate', { v: mesh.v, t: mesh.t }, placement)).toContain('local N = nil');
    expect(temporaryMeshLuau('Crate', { ...mesh, n: [] }, placement)).toContain('local N = nil');
    expect(temporaryMeshLuau('Crate', { ...mesh, n: [0, 0, 1] }, placement)).toContain('local N = nil');
    expect(meshNormals(mesh)).toBe(mesh.n);
  });

  it('stageMeshesLuau carries them per part for a preview rig', async () => {
    const { stageMeshesLuau } = await import('../src/core/modeling/rig-builder');
    const code = stageMeshesLuau('Stalker', [
      { name: 'Stalker_Tail', v: mesh.v, t: mesh.t, uv: mesh.uv, n: mesh.n },
      { name: 'Stalker_Claw', v: [0, 0, 0, 1, 0, 0, 0, 1, 0], t: [0, 1, 2] },
    ]);
    expect(code).toContain('n={0,0,1,0,0,1,0,0,1,0.707,0.707,0,0.707,0.707,0,0.707,0.707,0}');
    expect(code.match(/,n=\{/g)).toHaveLength(1);
    expect(code).toContain('if m.n then setNormals(em, faces, m.n, m.t) end');
    expect(code).toContain('local function setNormals(em, faces, N, T)');
    expect(code.indexOf('if m.n then setNormals')).toBeLessThan(code.indexOf('CreateMeshPartAsync'));
  });

  it.skipIf(!existsSync(selene))('the generated programs parse (selene)', async () => {
    const { temporaryMeshLuau } = await import('../src/core/modeling/model-store');
    const { stageMeshesLuau } = await import('../src/core/modeling/rig-builder');
    const t = new LuauToolchain(tmpdir());
    for (const [name, code] of [
      ['temporary mesh with normals', temporaryMeshLuau('Crate', mesh, placement, true)],
      ['temporary mesh without', temporaryMeshLuau('Crate', { v: mesh.v, t: mesh.t }, placement)],
      ['staged meshes with normals', stageMeshesLuau('Stalker', [{ name: 'Stalker_Tail', v: mesh.v, t: mesh.t, uv: mesh.uv, n: mesh.n }])],
    ] as Array<[string, string]>)
      expect(await t.parseErrors(code), name).toEqual([]);
  }, 60_000);

  it('model_place and rig_build send the exported normals to Studio for their temporary meshes', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    savePart(root, 'Crate');
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => false;
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const sent: string[] = [];
    studio.runLuau = async (code: string) => {
      sent.push(code);
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Crate', position: [0, 0, 0], notes: [] }), durationMs: 1 };
    };
    const placed = await core.tools.invoke('model_place', { name: 'Crate', position: [0, 5, 0] }, agent);
    expect(placed.isError, text(placed)).toBeFalsy();
    const program = sent.find((c) => c.includes('CreateEditableMesh'))!;
    expect(program).toContain('local N = {0,0,1,0,0,1,0,0,1}');
    expect(program).toContain('setNormals(em, faces, N, T)');
    // A rig whose parts are not uploaded: the staged meshes carry theirs.
    stalker(root, []);
    const stage: string[] = [];
    studio.runLuau = async (code: string) => {
      if (code.includes('_Staging') && code.includes('CreateEditableMesh')) {
        stage.push(code);
        return { ok: true, output: '1', durationMs: 1 };
      }
      return { ok: true, output: JSON.stringify({ built: ['Stalker'], failed: [], skipped: [] }), durationMs: 1 };
    };
    const rig = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(rig.isError, text(rig)).toBeFalsy();
    expect(stage.join('\n').match(/,n=\{0,0,1,0,0,1,0,0,1\}/g)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Texture maps on temporary meshes: roughness at full size, constant gray maps as a few pixels
// ---------------------------------------------------------------------------------------------

describe('texture staging sizes', () => {
  it('sends roughness (and a metalness map with detail) at 512 px, and a constant gray map as a few pixels', async () => {
    const { mapUploadLuau, isConstantGray } = await import('../src/core/modeling/texture-staging');
    const { encodePng, decodePng } = await import('../src/core/modeling/png');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-tex-'));
    mkdirSync(join(root, 'models'), { recursive: true });
    const gray = (size: number, at: (x: number, y: number) => number) => {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) data.set([at(x, y), at(x, y), at(x, y), 255], (y * size + x) * 4);
      return { width: size, height: size, data };
    };
    // A wet creature's roughness (detail everywhere, glossy and rough patches), its metalness (nothing: 0), a metalness with a pattern.
    writeFileSync(join(root, 'models', 'Griever__Skin.roughness.png'), encodePng(gray(512, (x, y) => 20 + ((x * 7 + y * 13) % 200))));
    writeFileSync(join(root, 'models', 'Griever__Skin.metalness.png'), encodePng(gray(512, () => 0)));
    writeFileSync(join(root, 'models', 'Griever__Plate.metalness.png'), encodePng(gray(512, (x) => (x < 256 ? 0 : 255))));
    writeFileSync(join(root, 'models', 'Griever__Skin.emissive.png'), encodePng(gray(512, () => 255)));
    const size = (kind: 'roughness' | 'metalness' | 'emissive', file: string) => {
      const last = mapUploadLuau(root, { kind, file, key: `${file}#x` }).at(-1)!;
      return /local w, h, ch = (\d+), (\d+), (\d+)/.exec(last)!.slice(1).map(Number);
    };
    expect(size('roughness', 'Griever__Skin.roughness.png')).toEqual([512, 512, 1]);
    expect(size('metalness', 'Griever__Plate.metalness.png')).toEqual([512, 512, 1]);
    // A number instead of an image (constant) is a few pixels, whatever it is called.
    expect(size('metalness', 'Griever__Skin.metalness.png')).toEqual([4, 4, 1]);
    expect(size('emissive', 'Griever__Skin.emissive.png')).toEqual([4, 4, 1]);
    expect(isConstantGray(decodePng(readFileSync(join(root, 'models', 'Griever__Skin.metalness.png'))))).toBe(true);
    expect(isConstantGray(decodePng(readFileSync(join(root, 'models', 'Griever__Skin.roughness.png'))))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The Blender export: retuned textures are changes, a clear coat becomes roughness, notes, tint, nlerp
// ---------------------------------------------------------------------------------------------

const blender = findBlender(process.env.SHURIKEN_BLENDER || null);

/** Wet flesh the way the Griever's was made: a coat of 0.8 at roughness 0.05 over a 0.6-rough texture, sheen and subsurface too. */
const WET = `
kiln.clear()
n = kiln.noise(64, 4, seed=2)
flesh = kiln.pbr("Flesh", kiln.ramp(n, ["#5a2a2a", "#9a5a50"]), roughness=0.6)
fp = next(x for x in flesh.node_tree.nodes if x.type == "BSDF_PRINCIPLED")
fp.inputs["Coat Weight"].default_value = 0.8
fp.inputs["Coat Roughness"].default_value = 0.05
fp.inputs["Sheen Weight"].default_value = 0.5
fp.inputs["Subsurface Weight"].default_value = 0.3
dry = kiln.pbr("Dry", kiln.ramp(n, ["#5a2a2a", "#9a5a50"]), roughness=0.6)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
a = kiln.mesh_object("Body", bm); a.location = (0, 0, 1); kiln.paint(a, flesh); kiln.uv_box(a, 1.0)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
b = kiln.mesh_object("Control", bm); b.location = (3, 0, 0.5); kiln.paint(b, dry); kiln.uv_box(b, 1.0)
plain = kiln.mat("Plain", base="#446688")
pp = next(x for x in plain.node_tree.nodes if x.type == "BSDF_PRINCIPLED")
pp.inputs["Coat Weight"].default_value = 0.5
plain.node_tree.nodes.new("ShaderNodeAmbientOcclusion")
bump = plain.node_tree.nodes.new("ShaderNodeBump")
plain.node_tree.links.new(bump.outputs["Normal"], pp.inputs["Normal"])
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
c = kiln.mesh_object("Box", bm); c.location = (-3, 0, 0.5); kiln.paint(c, plain)
lava = kiln.material("Lava", "lava", size=64)
lava["roblox_emissive_tint"] = "#ff6a10"
glow = kiln.material("Glow", "lava", size=64)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
d = kiln.mesh_object("LavaBox", bm); d.location = (0, 3, 0.5); kiln.paint(d, lava); kiln.uv_box(d, 1.0)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
e = kiln.mesh_object("GlowBox", bm); e.location = (0, -3, 0.5); kiln.paint(e, glow); kiln.uv_box(e, 1.0)
`;

describe.skipIf(!blender)('the Blender export for Roblox (real Blender)', () => {
  it('folds a clear coat into roughness, lists what Roblox cannot show once, and reads a custom emissive tint', async () => {
    const { decodePng } = await import('../src/core/modeling/png');
    process.env.SHURIKEN_BLENDER = blender!;
    const { core, root } = await makeCore();
    const made = await core.tools.invoke('blender_python', { model: 'Wet', code: WET }, agent);
    expect(made.isError, text(made)).toBeFalsy();
    const out = text(made);
    // The coat (0.8, roughness 0.05) over roughness 0.6 reads 0.6 + (0.05 - 0.6) * 0.8 = 0.16; the same material without a coat stays 0.6.
    const gray = (file: string) => decodePng(readFileSync(join(root, 'models', file))).data[0]!;
    expect(Math.abs(gray('Wet__Flesh.roughness.png') - Math.round(0.16 * 255))).toBeLessThanOrEqual(1);
    expect(Math.abs(gray('Wet__Dry.roughness.png') - Math.round(0.6 * 255))).toBeLessThanOrEqual(1);
    // What Roblox can't show is listed (once, in the export's notes).
    expect(out).toMatch(/Export notes \(what Roblox can't show of this model\):/);
    expect(out).toContain("'Flesh': Coat (weight 0.80, roughness 0.05) is folded into the roughness map");
    expect(out).toContain("'Flesh': Sheen (0.50) isn't exported");
    expect(out).toContain("'Flesh': Subsurface (0.30) isn't exported");
    expect(out).toContain("'Plain': Coat (weight 0.50) is dropped");
    expect(out).toContain("'Plain': Bump isn't exported without a normal map");
    expect(out).toContain("'Plain': An Ambient Occlusion node isn't exported");
    expect(out).not.toContain("'Dry'");
    // Change the model again: the same notes are not repeated.
    const again = await core.tools.invoke('blender_python', { model: 'Wet', code: 'bpy.data.objects["Body"].location = (0, 0, 1.2)' }, agent);
    expect(again.isError, text(again)).toBeFalsy();
    expect(text(again)).toMatch(/changed: version 2/);
    expect(text(again)).not.toContain('Export notes');
    // A glowing texture takes the material's custom tint (else white); the coat didn't touch the colour map.
    const store = new ModelStore(root);
    expect(store.get('Wet_Lava')?.emission).toMatchObject({ tint: '#ff6a10' });
    expect(store.get('Wet_Glow')?.emission).toMatchObject({ tint: '#ffffff' });
  }, 240_000);

  it('notices a texture retuned under the same names (its pixels changed), so it exports and uploads again', async () => {
    process.env.SHURIKEN_BLENDER = blender!;
    const { core, root } = await makeCore();
    const BLOCK = `
kiln.clear()
n = kiln.noise(64, 4, seed=3)
stone = kiln.pbr("Stone", kiln.ramp(n, ["#3d3934", "#7b746a", "#a39a8c"]), roughness=0.6)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
blk = kiln.mesh_object("Block", bm); blk.location = (0, 0, 1); kiln.paint(blk, stone); kiln.uv_box(blk, 1.0)
import roblox_export as rx
print("FP " + rx.maps_fingerprint())
`;
    const made = await core.tools.invoke('blender_python', { model: 'Rock', code: BLOCK }, agent);
    expect(made.isError, text(made)).toBeFalsy();
    const store = new ModelStore(root);
    const before = store.get('Rock')!;
    const fpBefore = /FP ([0-9a-f]+)/.exec(text(made))![1]!;
    const colorFile = join(root, 'models', before.textures!.color!);
    const pngBefore = readFileSync(colorFile);
    // Same node graph, same image name and size: only its pixels change (the artist retunes the texture).
    const RETUNE = `
import roblox_export as rx
img = bpy.data.images["Stone_color"]
px = np.empty(len(img.pixels), dtype=np.float32)
img.pixels.foreach_get(px)
px[0::4] = 1.0 - px[0::4]
img.pixels.foreach_set(px)
img.update()
print("FP " + rx.maps_fingerprint())
`;
    const tuned = await core.tools.invoke('blender_python', { model: 'Rock', code: RETUNE }, agent);
    expect(tuned.isError, text(tuned)).toBeFalsy();
    expect(/FP ([0-9a-f]+)/.exec(text(tuned))![1]).not.toBe(fpBefore);
    // It counts as a change: version 2, re-exported, a new hash (so an upload of the old one no longer counts).
    expect(text(tuned)).toMatch(/changed: version 2/);
    const after = store.get('Rock')!;
    expect(after.hash).not.toBe(before.hash);
    expect(readFileSync(colorFile).equals(pngBefore)).toBe(false);
    // Untouched, it is no change at all.
    const same = await core.tools.invoke('blender_python', { model: 'Rock', code: 'print(1)' }, agent);
    expect(text(same)).toContain('No change to the model.');
    expect(store.get('Rock')!.hash).toBe(after.hash);
  }, 240_000);

  it("judges keyframe reduction against nlerp, the way Roblox blends Linear keys (a slerp judge keeps too few keys)", async () => {
    process.env.SHURIKEN_BLENDER = blender!;
    const { core } = await makeCore();
    const CODE = `
import json
import numpy as np
import roblox_export as rx

def q_about_z(deg):
    h = np.radians(deg) / 2
    return np.array([np.cos(h), 0.0, 0.0, np.sin(h)])

def angle(a, b):
    return float(np.degrees(2 * np.arccos(min(1.0, abs(float(np.dot(a, b)))))))

def slerp(a, b, f):
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    th = np.arccos(min(1.0, d))
    return (np.sin((1 - f) * th) * a + np.sin(f * th) * b) / np.sin(th)

def old_reduce(qs, rot_tol=0.35):
    # the reduction as it was: neighbours judged against a slerp
    keep, k, i = [0], 0, 2
    while i < len(qs):
        if any(angle(slerp(qs[k], qs[i], (m - k) / (i - k)), qs[m]) > rot_tol for m in range(k + 1, i)):
            keep.append(i - 1)
            k = i - 1
        i += 1
    keep.append(len(qs) - 1)
    return keep

def worst_nlerp_error(qs, keep):
    # what Roblox plays between the kept keys, against the original motion at every frame
    worst = 0.0
    for a, b in zip(keep, keep[1:]):
        for m in range(a, b + 1):
            worst = max(worst, angle(rx._nlerp(qs[a], qs[b], (m - a) / (b - a)), qs[m]))
    return worst

n = 31
qs = [q_about_z(150 * i / (n - 1)) for i in range(n)]
ts = [np.zeros(3) for _ in range(n)]
keep = rx._reduce(qs, ts)
old = old_reduce(qs)
print("REDUCE " + json.dumps({"keep": keep, "worst": worst_nlerp_error(qs, keep), "oldKeep": old, "oldWorst": worst_nlerp_error(qs, old), "quarter": angle(rx._nlerp(qs[0], qs[-1], 0.25), qs[0])}))
`;
    const r = await core.tools.invoke('blender_python', { model: 'Reduce', code: CODE }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    const out = JSON.parse(/REDUCE (.*)/.exec(text(r))![1]!) as { keep: number[]; worst: number; oldKeep: number[]; oldWorst: number; quarter: number };
    // Roblox's blend of 0 to 150 degrees reads 33.0 at a quarter, not the 37.5 of a slerp (measured in Studio).
    expect(out.quarter).toBeCloseTo(33.0, 1);
    // The old judge, a slerp, keeps just the ends, and Roblox's nlerp then lags the motion by several degrees.
    expect(out.oldKeep).toEqual([0, 30]);
    expect(out.oldWorst).toBeGreaterThan(3);
    // Judged against what Roblox does, more keys are kept and the error stays within the tolerance (0.35 degrees).
    expect(out.keep.length).toBeGreaterThan(2);
    expect(out.keep[0]).toBe(0);
    expect(out.keep.at(-1)).toBe(30);
    expect(out.worst).toBeLessThanOrEqual(0.35 + 1e-6);
  }, 240_000);
});

describe('a Kiln model whose textures were retuned without Kiln calling it a change', () => {
  const readBody = (req: import('node:http').IncomingMessage) =>
    new Promise<Record<string, unknown>>((ok) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => ok(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
    });

  it("asks the export for the textures' pixel hash and exports again when it changed (and lists the export's notes once)", async () => {
    const { createServer } = await import('node:http');
    const { EventBus } = await import('../src/core/events');
    const { Logger } = await import('../src/core/log');
    const { KilnModeling } = await import('../src/core/modeling/kiln-modeling');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const tmp = mkdtempSync(join(tmpdir(), 'kiln-fid-'));
    const scene = join(tmp, 'scene.blend');
    writeFileSync(scene, 'BLENDER-fake');
    const state = { fp: 'aaa', exports: 0, mapsAsked: 0, changed: true };
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer test-token') return void res.writeHead(401).end();
      const b = req.method === 'POST' ? await readBody(req) : {};
      const path = (req.url ?? '').split('?')[0]!;
      const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (path === '/api/v1/app') return send({ version: '0.7.1', blender: { path: 'C:/Blender/blender.exe' }, projects: [] });
      if (path === '/api/v1/projects') return send({ id: 'rock-abc12', title: b.title, units: b.units });
      if (path.endsWith('/state')) return send({ scene: { version: 1 } });
      if (path.endsWith('/lock') || path.endsWith('/import')) return send({ ok: true });
      if (path.endsWith('/file')) return send({ scene, version: 1 });
      if (path.endsWith('/python')) return send({ ok: true, error: null, output: '', added: [], removed: [], summary: { objects: 1, tris: 12, verts: 8, list: [], materials: [] }, changed: state.changed, version: 1, issues: null });
      if (path.endsWith('/ext') && b.func === 'maps_fp') {
        state.mapsAsked++;
        return send({ ok: true, fp: state.fp });
      }
      if (path.endsWith('/ext')) {
        state.exports++;
        const args = b.args as { dir: string; name: string };
        mkdirSync(args.dir, { recursive: true });
        writeFileSync(join(args.dir, `${args.name}.mesh.json`), '{"v":[],"n":[],"t":[]}');
        writeFileSync(join(args.dir, `${args.name}.glb`), 'glb');
        return send({ ok: true, parts: [{ name: args.name, blender_material: 'Flesh', color: '#7a4a2a', material: 'SmoothPlastic', transparency: 0, origin: [0, 1, 0], size: [1, 1, 1], triangles: 12, vertices: 8, ...(args.name === 'Plain' ? {} : { textures: { color: 'Rock__Flesh.color.png' } }) }], size: [1, 1, 1], tris: 12, maps_fp: state.fp, notes: ["'Flesh': Coat (weight 0.80, roughness 0.05) is folded into the roughness map: Roblox has no clear coat"] });
      }
      res.writeHead(404).end('{}');
    });
    const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)));
    const runtime = join(tmp, 'runtime.json');
    writeFileSync(runtime, JSON.stringify({ app: 'kiln', version: '0.7.1', port, token: 'test-token', pid: process.pid }));
    const fallback = { status: () => ({ ready: true, exe: 'blender.exe', version: '5.2', max: 4, running: 0, detail: 'Blender 5.2' }), workspace: () => ({}), list: () => [], releaseRun() {}, stop() {} };
    const modeling = new KilnModeling(fallback as never, { enabled: () => true, resourcesDir: resolve(__dirname, '..', 'resources'), runtimeFile: () => runtime }, new EventBus(), new Logger(null, null).scope('kiln'));
    try {
      await modeling.kiln.check(true);
      const ws = modeling.workspace(root, 'Rock', { runId: 'run1', role: 'modeler' });
      // A change Kiln reports: exported, with the export's notes, and the textures' pixel hash remembered.
      const first = await ws.exec('make()', 60_000);
      expect(first).toMatchObject({ ok: true, changed: true, notes: [expect.stringContaining("'Flesh': Coat (weight 0.80")] });
      expect(state.exports).toBe(1);
      expect(JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', 'Rock.json'), 'utf8')).mapsFp).toBe('aaa');
      // Kiln sees nothing and the pixels are the same: nothing is exported.
      state.changed = false;
      const quiet = await ws.exec('print(1)', 60_000);
      expect(quiet.changed).toBe(false);
      expect(state.exports).toBe(1);
      expect(state.mapsAsked).toBe(1);
      // The artist retunes the texture: Kiln still says "no change", but the pixels differ, so it exports (and uploads) again.
      state.fp = 'bbb';
      const tuned = await ws.exec('retune()', 60_000);
      expect(tuned.changed).toBe(true);
      expect(state.exports).toBe(2);
      expect(JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', 'Rock.json'), 'utf8')).mapsFp).toBe('bbb');
      // The note was told with the first export and isn't repeated.
      expect(tuned.notes).toBeUndefined();
      // A model whose export has no textured parts isn't asked about its textures at all.
      state.changed = true;
      const plain = modeling.workspace(root, 'Plain', { runId: 'run1', role: 'modeler' });
      await plain.exec('make()', 60_000);
      state.changed = false;
      const asked = state.mapsAsked;
      expect((await plain.exec('print(1)', 60_000)).changed).toBe(false);
      expect(state.mapsAsked).toBe(asked);
    } finally {
      modeling.stop();
      server.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Guidance: plausible albedo, wet = low roughness, the dark comes from the lighting
// ---------------------------------------------------------------------------------------------

describe('modeling guidance for how a model looks in Roblox', () => {
  const skill = (name: string) => readFileSync(join(__dirname, '..', 'resources', 'skills', name, 'SKILL.md'), 'utf8');
  it('both Blender skills say: keep a plausible albedo, wet means low roughness, the lighting makes it dark', () => {
    for (const name of ['blender-creatures', 'blender-props']) {
      const md = skill(name);
      expect(md, name).toMatch(/plausible albedo/i);
      expect(md, name).toMatch(/Don't darken (a )?colou?r maps?/);
      expect(md, name).toMatch(/0\.3[–-]0\.5/);
      expect(md, name).toMatch(/[Ll]ow roughness|roughness 0\.05[–-]0\.3/);
      expect(md, name).toMatch(/lighting/i);
      expect(md, name).toMatch(/Coat/);
      expect(md, name).toMatch(/Export notes/);
    }
    // A changed bundled skill only reaches an existing install when its version goes up.
    expect(skill('blender-creatures')).toMatch(/^version: 5$/m);
    expect(skill('blender-props')).toMatch(/^version: 7$/m);
  });

  it("Kiln's copilot is told what survives the trip to Roblox, including albedo, wetness and lighting", async () => {
    const { kilnBrief } = await import('../src/core/capabilities/kiln-tools');
    const brief = kilnBrief('A Griever for my maze');
    expect(brief).toMatch(/plausible brightness/);
    expect(brief).toMatch(/mood comes from the game's lighting, never from darkened textures/);
    expect(brief).toMatch(/wet surfaces low roughness/);
  });
});

describe('the animation prompts', () => {
  it('tell the animator and the animation copilot that server-played creature clips must be uploaded before a playtest judges them', async () => {
    const { ROLES } = await import('../src/core/agents/roles');
    const { COPILOT_ROLES } = await import('../src/core/copilots/copilot-roles');
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    // The copilot has no playtest of its own (copilots work in their dock): it is told the same fact for whoever judges.
    for (const text of [ROLES.animator!.instructions, COPILOT_ROLES.animation.instructions]) {
      expect(flat(text)).toMatch(/Clips a server script plays on creatures must be uploaded \(animation_build does it for creature clips when it can\) before (?:you judge|anyone judges) them in a playtest: Studio-local ids don't replicate to the players/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Uploaded meshes keep the facing they were modeled with (the importer's 180° turn is compensated)
// ---------------------------------------------------------------------------------------------

describe('uploads are pre-turned, marked, and legacy uploads are turned back in Studio', () => {
  const cloudOf = (onUpload: (input: { name: string; file: string }) => Promise<UploadResult> | UploadResult, wait: (op: string) => UploadResult = () => ({ ok: false, error: 'not asked' })) =>
    ({ configured: async () => true, upload: async (input: { name: string; file: string }) => onUpload(input), wait: async (op: string) => wait(op) }) as unknown as OpenCloudAssets;
  const uploaderFor = (cloud: OpenCloudAssets) => new ModelUploads({ cloud, uploads: () => ({ enabled: true, creatorId: '42' }), creator: async () => '42' });

  it('uploads a copy with x and z negated (the GLB under models/ stays as exported), records facing, and cleans up its temporary file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const part = savePart(root, 'Arm');
    const store = new ModelStore(root);
    const original = readFileSync(store.paths('Arm').glb);
    let sent: Buffer | null = null;
    let file = '';
    const up = uploaderFor(
      cloudOf((input) => {
        file = input.file;
        sent = readFileSync(input.file);
        return { ok: true, assetId: '1001' };
      }),
    );
    expect(await up.ensure(root, part)).toMatchObject({ assetId: '1001' });
    expect(sent).not.toBeNull();
    expect(sent!.equals(glbTurned180(original))).toBe(true);
    expect(sent!.equals(original)).toBe(false);
    expect(readFileSync(store.paths('Arm').glb).equals(original)).toBe(true);
    expect(file).not.toBe(store.paths('Arm').glb);
    expect(existsSync(file)).toBe(false);
    const rec = store.get('Arm')!;
    expect(rec.upload).toMatchObject({ assetId: '1001', facing: GLB_FACING, hash: part.hash });
    expect(ModelStore.legacyUpload(rec)).toBe(false);
  });

  it('keeps the facing on an operation Roblox is still processing, and a legacy operation resolves to a legacy record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const part = savePart(root, 'Arm');
    const store = new ModelStore(root);
    let done = false;
    const up = uploaderFor(
      cloudOf(
        () => ({ ok: false, pending: true, operation: 'op-1', error: 'still processing' }),
        () => (done ? { ok: true, assetId: '2002' } : { ok: false, pending: true, operation: 'op-1', error: 'still processing' }),
      ),
    );
    expect(await up.ensure(root, part)).toMatchObject({ pending: true });
    expect(store.get('Arm')!.upload).toMatchObject({ operation: 'op-1', facing: GLB_FACING });
    done = true;
    expect(await up.ensure(root, store.get('Arm')!)).toMatchObject({ assetId: '2002' });
    expect(store.get('Arm')!.upload).toMatchObject({ assetId: '2002', facing: GLB_FACING });
    // A pending operation recorded without the marker (an upload of the old pipeline) resolves to a record without it.
    const old = savePart(root, 'Leg', { upload: { operation: 'op-old', hash: 'h-Leg', at: '' } });
    expect(await up.ensure(root, old)).toMatchObject({ assetId: '2002' });
    expect(store.get('Leg')!.upload).toEqual({ assetId: '2002', hash: 'h-Leg', at: expect.any(String) });
    expect(ModelStore.legacyUpload(store.get('Leg')!)).toBe(true);
  });

  it('does not upload a legacy upload again (it stays valid), but uploads a part exported again as a marked one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const legacy = savePart(root, 'Arm', { upload: { assetId: '777', hash: 'h-Arm', at: '' } });
    let uploads = 0;
    const up = uploaderFor(
      cloudOf(() => {
        uploads++;
        return { ok: true, assetId: '888' };
      }),
    );
    expect(await up.ensure(root, legacy)).toMatchObject({ assetId: '777', reused: true });
    expect(uploads).toBe(0);
    const store = new ModelStore(root);
    expect(ModelStore.legacyUpload(store.get('Arm')!)).toBe(true);
    // The model changes (a new hash): the old upload no longer counts, and the new one is a marked one.
    const again = savePart(root, 'Arm', { hash: 'h-Arm-2' });
    expect(await up.ensure(root, again)).toMatchObject({ assetId: '888' });
    expect(uploads).toBe(1);
    expect(store.get('Arm')!.upload).toMatchObject({ assetId: '888', facing: GLB_FACING });
  });

  it('model_place: a legacy single part is turned back after it settles (a wall mount sets the orientation), a marked one is not, and the recorded rotation is the modeled one', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    cloud.upload = async () => ({ ok: false, error: 'never asked' });
    savePart(root, 'Old', { upload: { assetId: '111', hash: 'h-Old', at: '' } });
    savePart(root, 'New', { upload: { assetId: '222', hash: 'h-New', at: '', facing: GLB_FACING } });
    const sent: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async (code: string) => {
      sent.push(code);
      return { ok: true, output: JSON.stringify({ path: 'Workspace.X', position: [1, 2, 3], rotation: [0, 90, 0], notes: [] }), durationMs: 1 };
    };
    const legacy = await core.tools.invoke('model_place', { name: 'Old', position: [0, 5, 0], rotation: [0, 45, 0], on_wall: true }, agent);
    expect(legacy.isError, text(legacy)).toBeFalsy();
    const program = sent.find((c) => c.includes('local mp = place("Old"'))!;
    expect(program).toContain('local info = settle(mp, "wall")\n-- A legacy upload arrives turned 180° about its centre (glb.ts): turned back after settling');
    expect(program).toContain('mp.CFrame = mp.CFrame * CFrame.Angles(0, math.pi, 0)\nmp:SetAttribute("ShurikenTurned", true)\ninfo.maps');
    // The placement is recorded as modeled (the wall mount's orientation), and world/Models.luau turns it back when it rebuilds.
    expect(new ModelStore(root).get('Old')!.placements[0]).toMatchObject({ rotation: [0, 90, 0] });
    expect(readFileSync(join(root, 'world', 'Models.luau'), 'utf8')).toMatch(/\{model="Old",asset=111,size=\{1,1,1\},turn=true,/);
    sent.length = 0;
    const marked = await core.tools.invoke('model_place', { name: 'New', position: [0, 5, 0] }, agent);
    expect(marked.isError, text(marked)).toBeFalsy();
    const program2 = sent.find((c) => c.includes('local mp = place("New"'))!;
    expect(program2).not.toContain('ShurikenTurned", true)\ninfo.maps');
    expect(program2).not.toMatch(/mp\.CFrame = mp\.CFrame \* CFrame\.Angles\(0, math\.pi, 0\)\nmp:SetAttribute/);
    expect(readFileSync(join(root, 'world', 'Models.luau'), 'utf8')).toMatch(/\{model="New",asset=222,size=\{1,1,1\},placements=/);
  });

  it('model_place: a whole model turns only its legacy parts back, and records the modeled orientation of each (the turn is undone for the record)', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    cloud.upload = async () => ({ ok: false, error: 'never asked' });
    savePart(root, 'Hut_Wall', { assembly: 'Hut', origin: [0, 1, 0], upload: { assetId: '111', hash: 'h-Hut_Wall', at: '' } });
    savePart(root, 'Hut_Roof', { assembly: 'Hut', origin: [0, 2, 0], upload: { assetId: '222', hash: 'h-Hut_Roof', at: '', facing: GLB_FACING } });
    const sent: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async (code: string) => {
      sent.push(code);
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Hut', position: [0, 0, 0], notes: [], parts: { Hut_Wall: { pos: [0, 1, 0], rot: [0, 30, 0] }, Hut_Roof: { pos: [0, 2, 0], rot: [0, 30, 0] } } }), durationMs: 1 };
    };
    const r = await core.tools.invoke('model_place', { name: 'Hut', position: [0, 5, 0], rotation: [0, 30, 0] }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    const program = sent.find((c) => c.includes('place("Hut_Wall"'))!;
    expect(program).toMatch(/place\("Hut_Wall", 111, \{1,1,1\}, \{name="Hut_Wall",[^\n]*,group=true,turn=true\}\)/);
    expect(program).toMatch(/place\("Hut_Roof", 222, \{1,1,1\}, \{name="Hut_Roof",[^\n]*,group=true\}\)/);
    // What it writes down about each placed part is the orientation without the turn.
    expect(program).toContain('if c:GetAttribute("ShurikenTurned") then cf = cf * CFrame.Angles(0, math.pi, 0) end\n    local x, y, z = cf:ToOrientation()');
    expect(new ModelStore(root).get('Hut_Wall')!.placements[0]).toMatchObject({ rotation: [0, 30, 0], group: true });
    const builder = readFileSync(join(root, 'world', 'Models.luau'), 'utf8');
    expect(builder).toMatch(/\{model="Hut_Wall",asset=111,size=\{1,1,1\},turn=true,/);
    expect(builder).toMatch(/\{model="Hut_Roof",asset=222,size=\{1,1,1\},placements=/);
  });

  it('rig_build and model_gear send turn=true for legacy parts only, and a part that was just uploaded is not legacy', async () => {
    const { core, root } = await makeCore();
    core.prefs.set({ robloxCreatorId: '42' });
    stalker(root, []);
    const store = new ModelStore(root);
    // Body was uploaded by the old pipeline, Tail and Claw are uploaded now (marked).
    store.save({ ...store.get('Stalker_Body')!, upload: { assetId: '101', hash: 'h-Stalker_Body', at: '' } });
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    let n = 100;
    cloud.upload = async () => ({ ok: true, assetId: String(++n) });
    const sent = rigStudio(core);
    const r = await core.tools.invoke('rig_build', { model: 'Stalker' }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    const build = sent.find((s) => s.kind === 'build')!.code;
    const rowOf = (name: string) => new RegExp(`\\{name="${name}",asset=[^,]+,segment="[^"]*",origin=\\{[^}]*\\},size=\\{[^}]*\\}[^{}]*\\}`).exec(build)![0];
    expect(rowOf('Stalker_Body')).toContain(',turn=true');
    expect(rowOf('Stalker_Tail')).not.toContain('turn=true');
    expect(rowOf('Stalker_Claw')).not.toContain('turn=true');
    expect(store.get('Stalker_Tail')!.upload).toMatchObject({ facing: GLB_FACING });
    // The permanent builder says the same.
    expect(readFileSync(join(root, 'world', 'Rigs.luau'), 'utf8')).toContain(',turn=true');
  });

  it('the generated programs with the turn in them parse (selene)', async () => {
    const selene = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene');
    if (!existsSync(selene)) return;
    const { rigsBuilder } = await import('../src/core/modeling/rig-builder');
    const { gearBuilder } = await import('../src/core/modeling/gear');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const store = new ModelStore(root);
    const mk = (name: string, upload: ModelMeta['upload'], over: Partial<ModelMeta> = {}) => store.save({ name, hash: `h-${name}`, size: [1, 2, 3], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [{ name: 'Lamp', parent: 'Workspace', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }], source: 'blender', origin: [0, 2, 0], segment: 'Handle', upload, ...over });
    const old = mk('Old', { assetId: '101', hash: 'h-Old', at: '' });
    const fresh = mk('Fresh', { assetId: '102', hash: 'h-Fresh', at: '', facing: GLB_FACING });
    const t = new LuauToolchain(tmpdir());
    const rig = { version: 1, model: 'Stalker', root: 'Handle', joints: [{ name: 'Handle', parent: null, part: 'Handle', pivot: [0, 2, 0] as [number, number, number], kind: 'ball' as const }], legs: [], attachments: [] };
    const programs: Array<[string, string]> = [
      ['models builder with turn', readFileSync(join(root, 'world', 'Models.luau'), 'utf8')],
      ['rigs builder with turn', rigsBuilder([{ rig, parts: [old, fresh], assets: { Old: '101', Fresh: '102' } }])],
      ['gear tool with a legacy handle', gearBuilder([{ spec: { name: 'Sword', model: 'Old', kind: 'tool', point: [0, 0.2, 0], into: 'ServerStorage.ShurikenGear' }, parts: [old, fresh], assets: { Old: '101', Fresh: '102' } }])],
      ['gear accessory with a legacy handle', gearBuilder([{ spec: { name: 'Helm', model: 'Old', kind: 'accessory', attachTo: 'HatAttachment', point: [0, 5.4, 0], into: 'ServerStorage.ShurikenGear' }, parts: [old], assets: { Old: '101' } }])],
    ];
    for (const [name, code] of programs) expect(await t.parseErrors(code), name).toEqual([]);
  }, 60_000);
});

describe('a real Blender export turns into the pre-turned GLB the importer needs', () => {
  it.skipIf(!blender)('the uploaded copy of an exported part has x and z of every vertex negated against mesh.json, y and the winding untouched', async () => {
    const { accessorRows } = await import('./helpers/glb');
    process.env.SHURIKEN_BLENDER = blender!;
    const { core, root } = await makeCore();
    const made = await core.tools.invoke('blender_python', { model: 'Arm', code: 'kiln.clear()\nm = kiln.mat("Metal", base="#888888", roughness=0.4)\nbm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)\na = kiln.mesh_object("Arm", bm); a.scale = (3, 0.5, 0.5); a.location = (1.2, -0.7, 2); kiln.paint(a, m)\nbm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.4)\nb = kiln.mesh_object("Lamp", bm); b.location = (-1.2, -0.7, 2); kiln.paint(b, m)' }, agent);
    expect(made.isError, text(made)).toBeFalsy();
    const store = new ModelStore(root);
    const part = store.get('Arm')!;
    const mesh = JSON.parse(readFileSync(store.paths('Arm').mesh, 'utf8')) as { v: number[]; n: number[]; t: number[] };
    const exported = readFileSync(store.paths('Arm').glb);
    const out = glbTurned180(exported);
    // The GLB is the mesh in Roblox space (a part centred on its box); the upload copy is that, turned about Y.
    const want = (a: number[]) => a.map((x, i) => (i % 3 === 1 ? x : x === 0 ? 0 : -x));
    const close = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-3);
    expect(close(accessorRows(exported, 0).flat(), mesh.v)).toBe(true);
    expect(close(accessorRows(out, 0).flat(), want(mesh.v))).toBe(true);
    expect(close(accessorRows(out, 1).flat(), want(mesh.n))).toBe(true);
    expect(accessorRows(out, 2).flat()).toEqual(mesh.t);
    // And the uploader sends exactly that.
    let sent: Buffer | null = null;
    const up = new ModelUploads({
      cloud: { configured: async () => true, wait: async () => ({ ok: false }), upload: async (input: { file: string }) => ((sent = readFileSync(input.file)), { ok: true, assetId: '5' }) } as unknown as OpenCloudAssets,
      uploads: () => ({ enabled: true, creatorId: '42' }),
      creator: async () => '42',
    });
    expect(await up.ensure(root, part)).toMatchObject({ assetId: '5' });
    expect(sent!.equals(out)).toBe(true);
  }, 240_000);
});
