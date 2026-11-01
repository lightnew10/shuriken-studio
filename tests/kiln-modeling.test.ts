import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling } from '../src/core/modeling/kiln-modeling';
import { ModelStore } from '../src/core/modeling/model-store';
import type { ModelingBackend, ModelingWorkspace } from '../src/core/modeling/backend';

// Shuriken's side of the Kiln link against a fake Kiln (its local API as documented in Kiln's
// docs/INTEGRATION.md): models become Kiln projects in studs, changes export through Shuriken's own
// Roblox export and land in the model store, Kiln's check report is translated, and when Kiln goes
// away the model carries on in the fallback engine.

const tmp = mkdtempSync(join(tmpdir(), 'kiln-link-'));
const kilnScene = join(tmp, 'kiln-scene.blend');
writeFileSync(kilnScene, 'BLENDER-fake');
const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let version = 0;
// Kiln's open projects (GET /api/v1/app) and the animation fingerprint of the one a user animates.
let appProjects: Array<{ id: string; open?: boolean; working?: boolean }> = [];
let animFp = 'fp1';
const BUG_RIG = { version: 2, model: 'Bug', root: 'Root', joints: [{ name: 'Root', parent: null, part: 'Root', pivot: [0, 1, 0], kind: 'ball' }, { name: 'Tail', parent: 'Root', part: 'Tail', pivot: [0, 1, 1], kind: 'ball' }], legs: [], attachments: [] };
const BUG_CLIPS = () => ({
  version: 1, model: 'Bug', kind: 'custom', fps: 30,
  clips: [{ name: 'Wag', loop: true, in_place: true, priority: 'Idle', speed: null, fade: 0.2, length: 1, generator: null, fp: animFp, markers: [], keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }, { t: 0.5, poses: { Tail: { rot: [0, 20, 0] } } }, { t: 1, poses: { Tail: { rot: [0, 0, 0] } } }] }],
});

const body = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => ok(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
  });

const server: Server = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer test-token') return void res.writeHead(401).end();
  const b = req.method === 'POST' ? await body(req) : {};
  const path = (req.url ?? '').split('?')[0]!;
  calls.push({ method: req.method ?? 'GET', path, body: b });
  const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (path === '/api/v1/app') return send({ version: '0.5.0', blender: { path: 'C:/Blender/blender.exe' }, projects: appProjects });
  if (path === '/api/v1/projects/bug-proj/anim') {
    const p = appProjects.find((x) => x.id === 'bug-proj');
    return send(p?.open ? { open: true, working: !!p.working, version, anim: animFp, clips: ['Wag'], current: 'Wag' } : { open: false });
  }
  if (path === '/api/v1/projects/bug-proj/scene') return send({ rig: { anim: animFp } });
  if (path === '/api/v1/projects') return send({ id: `${String(b.title).toLowerCase()}-abc12`, title: b.title, units: b.units });
  if (path.endsWith('/lock')) return send({ lock: Number(b.seconds) > 0 ? { by: b.by } : null });
  if (path.endsWith('/close')) return send({ closed: true });
  if (path.endsWith('/import')) return send({ ok: true });
  // Projects the user made in Kiln (meters), and one Kiln built for this Shuriken project's Chest.
  if (path === '/api/v1/projects/user-lantern/state') return send({ project: { id: 'user-lantern', title: 'Stone lantern', units: 'm' }, scene: { version } });
  if (path === '/api/v1/projects/linked-chest/state') return send({ project: { id: 'linked-chest', title: 'Chest', units: 'studs', linked: { app: 'Shuriken Studio', model: 'Chest', project: join(tmp, 'project') } }, scene: { version } });
  if (path.endsWith('/state')) return send({ scene: { version } });
  if (path.endsWith('/python')) {
    version++;
    return send({ ok: true, error: null, output: 'built', added: ['Body'], removed: [], summary: { objects: 1, tris: 12, verts: 8, list: [], materials: [] }, changed: true, version, issues: { zfight: [], zfight_pairs: 0, floating: [{ object: 'Lid', gap_below_m: 0.5 }] } });
  }
  if (path.endsWith('/file')) return send({ scene: kilnScene, version });
  if (path.endsWith('/ext') && b.func === 'export_rig_clips') {
    const args = b.args as { dir: string; name: string };
    mkdirSync(args.dir, { recursive: true });
    writeFileSync(join(args.dir, `${args.name}.rig.json`), JSON.stringify(BUG_RIG));
    writeFileSync(join(args.dir, `${args.name}.clips.json`), JSON.stringify(BUG_CLIPS()));
    return send({ ok: true, rig: { joints: BUG_RIG.joints.map((j) => j.name) }, clips: [{ name: 'Wag' }], anim_fp: animFp });
  }
  if (path.endsWith('/ext')) {
    const args = b.args as { dir: string; name: string };
    mkdirSync(args.dir, { recursive: true });
    writeFileSync(join(args.dir, `${args.name}.mesh.json`), '{"v":[],"n":[],"t":[]}');
    writeFileSync(join(args.dir, `${args.name}.glb`), 'glb');
    return send({ ok: true, parts: [{ name: args.name, blender_material: 'ChestWood', color: '#7a4a2a', material: 'WoodPlanks', transparency: 0, origin: [0, 1, 0], size: [4, 2, 2.6], triangles: 12, vertices: 8 }], size: [4, 2, 2.6], tris: 12 });
  }
  if (path.endsWith('/render')) {
    const f = join(tmp, 'render.png');
    writeFileSync(f, 'png');
    return send({ ok: true, file: f, views: b.views ?? ['iso'] });
  }
  if (path.endsWith('/check')) return send({ ok: true, zfight: [], zfight_pairs: 0, floating: [], below_ground: [{ object: 'Post', top_z: -0.2 }], faces_checked: 12 });
  if (path.endsWith('/undo')) return send({ ok: true });
  res.writeHead(404).end('{}');
});

const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)));
const runtime = join(tmp, 'runtime.json');
writeFileSync(runtime, JSON.stringify({ app: 'kiln', version: '0.5.0', port, token: 'test-token', pid: process.pid }));

/** The fallback engine (Shuriken's own Blender in the app): records that it was asked. */
class FallbackStub implements ModelingBackend {
  asked: string[] = [];
  max = 4;
  status() {
    return { ready: true, exe: 'blender.exe', version: '5.2', max: this.max, running: 0, detail: 'Blender 5.2 · up to 4 models at once' };
  }
  workspace(_root: string, name: string): ModelingWorkspace {
    this.asked.push(name);
    return { name, by: null, version: 0, parts: [] } as unknown as ModelingWorkspace;
  }
  list() {
    return [];
  }
  releaseRun() {}
  stop() {}
}

const bus = new EventBus();
const log = new Logger(null, null).scope('kiln');
const fallback = new FallbackStub();
const resourcesDir = resolve(__dirname, '..', 'resources');
const modeling = new KilnModeling(fallback, { enabled: () => true, resourcesDir, runtimeFile: () => runtime }, bus, log);
const root = join(tmp, 'project');
mkdirSync(root, { recursive: true });

afterAll(() => {
  modeling.stop();
  server.close();
});

describe('KilnModeling (the Kiln link)', () => {
  it('finds Kiln through its runtime file and reports it', async () => {
    const h = await modeling.kiln.check(true);
    expect(h.ok).toBe(true);
    expect(existsSync(join(resourcesDir, 'blender', 'roblox_export.py'))).toBe(true);
    expect(modeling.status().ready).toBe(true);
    expect(modeling.status().detail).toContain('Kiln');
  });

  it('builds a model as a Kiln project in studs and publishes Roblox parts to the model store', async () => {
    const ws = modeling.workspace(root, 'Chest', { runId: 'run1', role: 'modeler' });
    const r = await ws.exec('kiln.clear()', 60_000, 'Block out the chest');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    const created = calls.find((c) => c.path === '/api/v1/projects');
    expect(created?.body).toMatchObject({ title: 'Chest', units: 'studs', linked: { app: 'Shuriken Studio', model: 'Chest' } });
    const ext = calls.find((c) => c.path.endsWith('/ext'));
    expect(ext?.body).toMatchObject({ module: 'roblox_export', func: 'export', dir: join(resourcesDir, 'blender') });
    const meta = new ModelStore(root).get('Chest');
    expect(meta).toMatchObject({ name: 'Chest', material: 'WoodPlanks', color: '#7a4a2a', source: 'blender', blend: 'models/Chest.blend', triangles: 12 });
    expect(readFileSync(join(root, 'models', 'Chest.blend'), 'utf8')).toBe('BLENDER-fake');
    expect(r.issues?.floating[0]).toEqual({ object: 'Lid', gap_below: 0.5 });
    expect(r.parts.map((p) => p.name)).toEqual(['Chest']);
    expect(JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', 'Chest.json'), 'utf8')).projectId).toBe('chest-abc12');
  });

  it('locks the model in Kiln while a run works on it, and unlocks when the run ends', () => {
    const locks = calls.filter((c) => c.path.endsWith('/lock'));
    expect(locks.at(-1)?.body).toMatchObject({ by: 'Shuriken Studio' });
    expect(Number(locks.at(-1)?.body.seconds)).toBeGreaterThan(0);
  });

  it('keeps a model with the run working on it', () => {
    expect(() => modeling.workspace(root, 'Chest', { runId: 'run2', role: 'builder' })).toThrow(/being modeled/);
    modeling.releaseRun('run1');
    expect(() => modeling.workspace(root, 'Chest', { runId: 'run2', role: 'builder' })).not.toThrow();
    return new Promise<void>((done) => setTimeout(() => {
      expect(calls.some((c) => c.path.endsWith('/lock') && Number(c.body.seconds) === 0)).toBe(true);
      done();
    }, 100));
  });

  it('renders into the evidence folder with a 5.2-stud figure, and translates the check', async () => {
    const ws = modeling.workspace(root, 'Chest', { runId: 'run2', role: 'modeler' });
    const r = await ws.render({ views: ['iso'], player: true });
    expect(r.ok).toBe(true);
    expect(r.file?.startsWith(join(root, '.shuriken', 'evidence'))).toBe(true);
    expect(calls.find((c) => c.path.endsWith('/render'))?.body).toMatchObject({ figure: true, figure_height: 5.2 });
    const c = await ws.check(false);
    expect(c.below_ground).toEqual([{ object: 'Post', lowest_z: -0.2 }]);
  });

  it('stays within the "models at once" setting by closing the longest-idle Kiln project', async () => {
    fallback.max = 1;
    const other = modeling.workspace(root, 'Barrel', { runId: 'run4', role: 'modeler' });
    await other.exec('pass', 60_000);
    expect(calls.some((c) => c.path === '/api/v1/projects/chest-abc12/close')).toBe(true);
    fallback.max = 4;
  });

  it('brings Kiln up to date when Shuriken changed the model without it', async () => {
    const later = (Date.now() + 60_000) / 1000;
    utimesSync(join(root, 'models', 'Chest.blend'), later, later);
    const fresh = new KilnModeling(fallback, { enabled: () => true, resourcesDir, runtimeFile: () => runtime }, bus, log);
    await fresh.kiln.check(true);
    const before = calls.length;
    await fresh.workspace(root, 'Chest', { runId: 'run5', role: 'modeler' }).scene();
    expect(calls.slice(before).some((c) => c.path === '/api/v1/projects/chest-abc12/import' && c.body.path === join(root, 'models', 'Chest.blend'))).toBe(true);
    fresh.stop();
  });

  it("takes a model the user made in Kiln into the game (Kiln's Use in this game), scaled from meters", async () => {
    const before = calls.length;
    const r = await modeling.importFromKiln(root, 'user-lantern', 'Stone lantern!');
    expect(r).toMatchObject({ ok: true, name: 'StoneLantern', parts: 1 });
    const mine = calls.slice(before);
    // Its own studs project for Shuriken, the user's scene copied in, scaled, exported: the user's project untouched.
    expect(mine.find((c) => c.path === '/api/v1/projects')?.body).toMatchObject({ title: 'StoneLantern', units: 'studs', linked: { model: 'StoneLantern' } });
    expect(mine.some((c) => c.path === '/api/v1/projects/stonelantern-abc12/import' && c.body.path === kilnScene)).toBe(true);
    expect(String(mine.find((c) => c.path === '/api/v1/projects/stonelantern-abc12/python')?.body.code)).toMatch(/s = 1 \/ 0\.28/);
    expect(mine.some((c) => c.path.startsWith('/api/v1/projects/user-lantern/') && c.method === 'POST')).toBe(false);
    expect(new ModelStore(root).get('StoneLantern')).toMatchObject({ source: 'blender' });
    // A project Kiln built for one of this project's models is published as it is (not forked).
    const again = calls.length;
    expect(await modeling.importFromKiln(root, 'linked-chest', 'Chest')).toMatchObject({ ok: true, name: 'Chest' });
    const second = calls.slice(again);
    expect(second.some((c) => c.path === '/api/v1/projects')).toBe(false);
    expect(second.some((c) => c.path === '/api/v1/projects/linked-chest/ext')).toBe(true);
  });

  it('brings clips in while the user animates a linked model in Kiln, only when they changed', async () => {
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    mkdirSync(join(root, '.shuriken', 'kiln'), { recursive: true });
    writeFileSync(join(root, '.shuriken', 'kiln', 'Bug.json'), JSON.stringify({ projectId: 'bug-proj' }));
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(join(root, 'models', 'Bug.rig.json'), JSON.stringify(BUG_RIG));
    const exts = () => calls.filter((c) => c.path === '/api/v1/projects/bug-proj/ext').length;
    const scenes = () => calls.filter((c) => c.path === '/api/v1/projects/bug-proj/scene').length;

    // Not open in Kiln: nothing exported, and /scene (which would open it) is never used.
    appProjects = [{ id: 'bug-proj', open: false }];
    expect(await modeling.syncClips(root)).toEqual([]);
    expect(exts()).toBe(0);

    // Open, and animated: its clips come in as the game's animations.
    appProjects = [{ id: 'bug-proj', open: true }];
    expect(await modeling.syncClips(root)).toEqual(['Bug']);
    expect(new AnimationStore(root).get('BugWag')).toMatchObject({ source: { kind: 'kiln', model: 'Bug', clip: 'Wag', fp: 'fp1' } });
    expect(calls.find((c) => c.path === '/api/v1/projects/bug-proj/ext')!.body).toMatchObject({ func: 'export_rig_clips' });

    // Nothing changed: nothing exported.
    const before = exts();
    expect(await modeling.syncClips(root)).toEqual([]);
    expect(exts()).toBe(before);

    // Kiln's copilot is working on it: wait. Then a change comes in.
    animFp = 'fp2';
    appProjects = [{ id: 'bug-proj', open: true, working: true }];
    expect(await modeling.syncClips(root)).toEqual([]);
    appProjects = [{ id: 'bug-proj', open: true }];
    expect(await modeling.syncClips(root)).toEqual(['Bug']);
    expect(new AnimationStore(root).get('BugWag')!.source!.fp).toBe('fp2');
    expect(scenes()).toBe(0);
    appProjects = [];
  });

  it('carries on in Shuriken’s own Blender when Kiln goes away', async () => {
    writeFileSync(runtime, '{}');
    await modeling.kiln.check(true);
    expect(modeling.status().detail).toContain('Blender 5.2');
    modeling.workspace(root, 'Chest', { runId: 'run3', role: 'modeler' });
    expect(fallback.asked).toContain('Chest');
  });
});
