import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling, kilnAtLeast, versionParts } from '../src/core/modeling/kiln-modeling';
import { LIGHTING_LUAU, lightingHash, mapLighting, readPlaceLighting, type KilnLighting } from '../src/core/modeling/kiln-lighting';
import { kilnBrief, kilnGoalBrief, registerKilnTools } from '../src/core/capabilities/kiln-tools';
import type { ModelingBackend, ModelingWorkspace } from '../src/core/modeling/backend';
import type { ProjectContext } from '../src/core/projects/project-service';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import { ROBLOX_TARGET } from '../src/core/capabilities/kiln-tools';
import { ROLES } from '../src/core/agents/roles';
import { COPILOT_ROLES } from '../src/core/copilots/copilot-roles';

// Shuriken's side of the Kiln 0.7.3 contract against a fake Kiln: briefs that ask for results (kind, effort,
// the agent's text as written, the turn's delivery), the Roblox target and the place's lighting (sent once,
// again only when it changed), the baked Roblox export, and no hands-on control of Kiln's projects. Older
// Kiln keeps today's brief. No real Kiln, Studio or Blender.

const tmp = mkdtempSync(join(tmpdir(), 'kiln-results-'));
const root = join(tmp, 'project');
mkdirSync(root, { recursive: true });
const liveScene = join(tmp, 'live.blend');
const bakedBlend = join(tmp, 'exports', 'roblox-v3', 'roblox.blend');
mkdirSync(join(tmp, 'exports', 'roblox-v3'), { recursive: true });
writeFileSync(liveScene, 'BLENDER-live');
writeFileSync(bakedBlend, 'BLENDER-baked');

const DELIVERY = {
  size: [9, 4, 3],
  units: 'studs',
  objects: 14,
  tris: 9100,
  joints: 12,
  clips: [{ name: 'Walk', length: 1, loop: true, in_place: true, speed: 11.5, priority: 'Movement', markers: [] }, { name: 'Lunge', length: 0.9, loop: false, in_place: false, speed: null, priority: 'Action', markers: [{ name: 'Strike', time: 0.4 }] }],
  renders: ['http://127.0.0.1/render1.png'],
};

let kilnVersion = '0.7.3';
let bake409 = 0;
let bakeBlendPath: string | null = bakedBlend;
let turnPolls = 0;
let calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
const hits = (path: RegExp) => calls.filter((c) => path.test(c.path));

const readBody = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => ok(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
  });

const PART = { name: 'Griever', blender_material: 'Skin', color: '#7a4a2a', material: 'SmoothPlastic', transparency: 0.3, origin: [0, 1, 0], size: [4, 2, 2.6], triangles: 12, vertices: 8 };

const server: Server = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer res-token') return void res.writeHead(401).end();
  const body = req.method === 'POST' ? await readBody(req) : {};
  const path = (req.url ?? '').split('?')[0]!;
  // Every message to the copilot ends with the moderation rule: these tests read what was asked for.
  calls.push({ method: req.method ?? 'GET', path, body });
  const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (path === '/api/v1/app') return send({ version: kilnVersion, blender: { path: 'C:/Blender/blender.exe' }, projects: [] });
  if (path === '/api/v1/projects') return send({ id: `${String(body.title).toLowerCase()}-abc12`, title: body.title, units: body.units });
  if (path.endsWith('/target')) return send({ id: 'x', roblox: true, lightingSummary: 'ok' });
  if (path.endsWith('/chat')) return send({ ok: true, turnId: 't1', effort: body.effort ?? 'max', effortWhy: body.effort ? null : 'a detailed, named, rigged creature' });
  if (path.endsWith('/turns/t1')) {
    turnPolls++;
    // A turn stays running until its delivery is in.
    return turnPolls < 2 ? send({ state: 'running', reply: '' }) : send({ state: 'done', reply: 'Built it.', clips: ['Walk', 'Lunge'], effort: 'max', effortWhy: 'a detailed, named, rigged creature', delivery: DELIVERY });
  }
  if (path.endsWith('/state')) {
    const id = path.split('/')[4]!;
    // Each project is the model it was made for ("crate-abc12" is Crate): builds come into the game by themselves now.
    const model = id[0]!.toUpperCase() + id.split('-')[0]!.slice(1);
    return send({ project: { id, title: model, units: 'studs', linked: { app: 'Shuriken Studio', model, project: root } }, scene: { version: 3 } });
  }
  if (path.endsWith('/lock') || path.endsWith('/close')) return send({});
  if (path.endsWith('/import')) return send({ ok: true });
  if (path.endsWith('/file')) return send({ scene: liveScene, version: 3 });
  if (path.endsWith('/anim')) return send({ open: true, working: false, version: 3, anim: 'fp-live', clips: ['Walk'], current: 'Walk' });
  if (path.endsWith('/roblox') && req.method === 'POST') {
    if (bake409 > 0) {
      bake409--;
      return send({ error: 'The copilot is working on this project: export when it is done' }, 409);
    }
    return bakeBlendPath ? send({ ok: true, cached: false, manifest: { blend: bakeBlendPath, materials: [] } }) : send({ ok: false, error: 'bake failed' }, 500);
  }
  if (path.endsWith('/ext')) {
    const args = body.args as { dir: string; name: string };
    mkdirSync(args.dir, { recursive: true });
    return send({ ok: true, parts: [{ ...PART, name: args.name }], size: [4, 2, 2.6], tris: 12, anim_fp: 'fp-from-live-ext' });
  }
  if (path.includes('/clips/')) return send({ summary: 'clean', issues: [] });
  if (path.endsWith('/python')) return send({ ok: true, error: null, output: '', added: [], removed: [], summary: null, changed: false, version: 3, issues: null });
  res.writeHead(404).end('{}');
});
const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)));
const runtime = join(tmp, 'runtime.json');
writeFileSync(runtime, JSON.stringify({ app: 'kiln', version: '0.7.3', port, token: 'res-token', pid: process.pid }));

/** Shuriken's own Blender stand-in: records what the baked export was asked to run on. */
const exported: Array<{ blend: string; dir: string; name: string }> = [];
const fallback = {
  status: () => ({ ready: true, exe: 'blender.exe', version: '5.2', max: 4, running: 0, detail: 'Blender 5.2' }),
  workspace: (_r: string, name: string) =>
    ({
      name,
      by: null,
      version: 0,
      parts: [],
      exec: async () => ({ ok: true, error: null, output: `KILN_CLIP_RESULT ${JSON.stringify([{ name: 'Walk' }])}`, added: [], removed: [], summary: null, issues: null, changed: true, version: 1, parts: [], size: null, ms: 1 }),
    }) as unknown as ModelingWorkspace,
  list: () => [],
  releaseRun: () => undefined,
  stop: () => undefined,
  exportBaked: async (blend: string, dir: string, name: string) => {
    exported.push({ blend, dir, name });
    mkdirSync(dir, { recursive: true });
    return { ok: true, parts: [{ ...PART, name }], size: [4, 2, 2.6], tris: 12, anim_fp: 'fp-from-baked-blend' };
  },
} as unknown as ModelingBackend;

let place: KilnLighting | null = { brightness: 3, clockTime: 14, ambient: [0.5, 0.5, 0.5], atmosphere: { density: 0.3 }, bloom: null };
let placeThrows = false;
const resourcesDir = resolve(__dirname, '..', 'resources');
const modeling = new KilnModeling(fallback, { enabled: () => false, resourcesDir, runtimeFile: () => runtime, bakeWaitMs: 400, lighting: async () => (placeThrows ? Promise.reject(new Error('studio went away')) : place) }, new EventBus(), new Logger(null, null).scope('kiln'));

type Handler = ToolDefinition['handler'];
const tools = new Map<string, Handler>();
registerKilnTools({ register: (def: { name: string; handler: Handler }) => void tools.set(def.name, def.handler), get: () => undefined, invoke: async () => ({ content: [] }) } as never, {
  project: () => ({ root }) as unknown as ProjectContext,
  kiln: () => modeling,
  modeling: () => fallback,
  bus: new EventBus(),
});
const caller: CallerContext = { kind: 'agent', runId: 'run_res', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const call = async (name: string, args: Record<string, unknown>) => {
  const out = await tools.get(name)!({ args, caller, signal: undefined } as never);
  const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { out, text, data: out.data as Record<string, any> | undefined };
};
/** Builds run in Shuriken's queue and carry on after a `wait: false` call: wait until they have ended (and come into the game). */
const drain = () => call('kiln_builds', {});
const setVersion = async (v: string) => {
  kilnVersion = v;
  await modeling.kiln.check(true);
};

const savedEnv = process.env.SHURIKEN_NO_KILN;
beforeAll(async () => {
  delete process.env.SHURIKEN_NO_KILN;
  await modeling.kiln.check(true);
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.SHURIKEN_NO_KILN;
  else process.env.SHURIKEN_NO_KILN = savedEnv;
  modeling.stop();
  server.close();
});

describe('Kiln versions', () => {
  it('compares numbers, not text', () => {
    expect(kilnAtLeast('0.7.3')).toBe(true);
    expect(kilnAtLeast('0.7.2')).toBe(false);
    expect(kilnAtLeast('0.10.0')).toBe(true);
    expect(kilnAtLeast('0.7.10')).toBe(true);
    expect(kilnAtLeast('1.0.0')).toBe(true);
    expect(kilnAtLeast('0.6.9')).toBe(false);
    expect(kilnAtLeast('0.7.3-beta.2')).toBe(true);
    expect(kilnAtLeast('v0.8')).toBe(true);
    expect(kilnAtLeast('')).toBe(false);
    expect(kilnAtLeast(null)).toBe(false);
    expect(kilnAtLeast('nonsense')).toBe(false);
    expect(versionParts('0.7')).toEqual([0, 7, 0]);
  });
});

describe('the place’s lighting', () => {
  it('maps Studio’s Lighting to the contract’s field names and ignores what is missing', () => {
    const l = mapLighting({
      Brightness: 3, Ambient: [0.5, 0.5, 0.5], OutdoorAmbient: [0.2, 0.3, 0.4], ClockTime: 14.5, GeographicLatitude: 41.7, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.5, ExposureCompensation: -0.25,
      Atmosphere: { Density: 0.3, Offset: 0.1, Haze: 1.2, Glare: 0, Color: [0.78, 0.78, 0.78], Decay: [0.4, 0.4, 0.4] },
      Bloom: { Intensity: 0.4, Size: 24, Threshold: 0.95 },
      ColorCorrection: { Brightness: 0, Contrast: 0.1, Saturation: 0.2, TintColor: [1, 1, 1] },
    });
    expect(l).toEqual({
      brightness: 3, ambient: [0.5, 0.5, 0.5], outdoorAmbient: [0.2, 0.3, 0.4], clockTime: 14.5, latitude: 41.7, envDiffuse: 1, envSpecular: 0.5, exposure: -0.25,
      atmosphere: { density: 0.3, offset: 0.1, haze: 1.2, glare: 0, color: [0.78, 0.78, 0.78], decay: [0.4, 0.4, 0.4] },
      bloom: { intensity: 0.4, size: 24, threshold: 0.95 },
      colorCorrection: { brightness: 0, contrast: 0.1, saturation: 0.2, tint: [1, 1, 1] },
    });
    // No atmosphere / bloom in the place: explicit nulls (Kiln turns them off); unreadable fields stay out.
    const bare = mapLighting({ Brightness: 2, ClockTime: 6 });
    expect(bare).toEqual({ brightness: 2, clockTime: 6, atmosphere: null, bloom: null, colorCorrection: null });
    expect(mapLighting(null)).toBeNull();
    expect(mapLighting({})).toBeNull();
    expect(lightingHash(l!)).toBe(lightingHash(mapLighting({ Brightness: 3, Ambient: [0.5, 0.5, 0.5], OutdoorAmbient: [0.2, 0.3, 0.4], ClockTime: 14.5, GeographicLatitude: 41.7, EnvironmentDiffuseScale: 1, EnvironmentSpecularScale: 0.5, ExposureCompensation: -0.25, Atmosphere: { Density: 0.3, Offset: 0.1, Haze: 1.2, Glare: 0, Color: [0.78, 0.78, 0.78], Decay: [0.4, 0.4, 0.4] }, Bloom: { Intensity: 0.4, Size: 24, Threshold: 0.95 }, ColorCorrection: { Brightness: 0, Contrast: 0.1, Saturation: 0.2, TintColor: [1, 1, 1] } })!));
    expect(lightingHash({ ...l!, clockTime: 15 })).not.toBe(lightingHash(l!));
  });

  it('reads it with a read-only snippet and never fails when Studio is away', async () => {
    expect(LIGHTING_LUAU).toMatch(/Brightness[\s\S]*Ambient[\s\S]*OutdoorAmbient[\s\S]*ClockTime[\s\S]*GeographicLatitude[\s\S]*EnvironmentDiffuseScale[\s\S]*EnvironmentSpecularScale[\s\S]*ExposureCompensation/);
    expect(LIGHTING_LUAU).toMatch(/Atmosphere[\s\S]*BloomEffect[\s\S]*ColorCorrectionEffect/);
    expect(LIGHTING_LUAU).not.toMatch(/Instance\.new|:Destroy|\.Parent\s*=|SetAttribute/);
    let sent = '';
    const ok = await readPlaceLighting({ connected: true, luauJson: async (code: string) => ((sent = code), { Brightness: 2, ClockTime: 12 }) as never });
    expect(sent).toBe(LIGHTING_LUAU);
    expect(ok?.brightness).toBe(2);
    expect(await readPlaceLighting({ connected: false, luauJson: async () => ({ Brightness: 1 }) as never })).toBeNull();
    expect(await readPlaceLighting({ connected: true, luauJson: async () => Promise.reject(new Error('no place')) })).toBeNull();
  });
});

describe('a brief for Kiln 0.7.3', () => {
  it('goes out as the agent wrote it, with the subject as one sentence, and Kiln 0.7.2’s brief keeps the Roblox paragraph', () => {
    const text = 'Maze Runner Griever as the maze hunter; seen at 5-60 studs; clips Idle, Walk (loops; tell me ground speeds), Lunge (Strike marker).';
    expect(kilnGoalBrief(text)).toBe(text);
    expect(kilnGoalBrief(`  ${text}  `, 'the Griever from The Maze Runner films.')).toBe(`${text}\n\nThe subject is the Griever from The Maze Runner films.`);
    for (const line of [ROBLOX_TARGET, 'Research first', 'your call', 'research phase']) expect(kilnGoalBrief(text, 'a snow leopard')).not.toContain(line);
    expect(kilnBrief(text)).toContain(ROBLOX_TARGET);
  });

  it('asks for a new Roblox-target project, sends kind and the text as written, waits for the delivery and returns it', async () => {
    calls = [];
    turnPolls = 0;
    exported.length = 0;
    const text = 'Maze Runner Griever (2014 film) as the maze hunter; seen at 5-60 studs from a running player; clips Idle, Walk (loops; tell me ground speeds), Lunge (Strike and Hit markers).';
    const r = await call('kiln_request', { model: 'Griever', text, references: 'the Griever from The Maze Runner films', timeout_min: 1 });
    expect(r.out.isError).toBeFalsy();
    const created = hits(/^\/api\/v1\/projects$/)[0]!.body;
    expect(created).toMatchObject({ title: 'Griever', units: 'studs', target: 'roblox', lighting: place });
    const chat = hits(/\/chat$/)[0]!.body;
    expect(chat.text).toBe(`${text}\n\nThe subject is the Griever from The Maze Runner films.`);
    expect(chat).toMatchObject({ from: 'shuriken', kind: 'new' });
    // A named subject to research is a standard build: Shuriken always says how much effort it is worth.
    expect(chat.effort).toBe('high');
    for (const bad of ['Where it goes', 'Research first', 'your call']) expect(String(chat.text)).not.toContain(bad);
    // Running until the delivery is in, then the facts come back with the effort Kiln chose and why.
    expect(turnPolls).toBeGreaterThanOrEqual(2);
    expect(r.data).toMatchObject({ effort: 'max', effortWhy: 'a detailed, named, rigged creature', kind: 'new', delivery: DELIVERY, reply: 'Built it.', clipsChanged: ['Walk', 'Lunge'] });
    // The result was baked by Kiln and exported from the baked copy: nothing was modeled through /python and the live scene wasn't exported.
    expect(hits(/\/roblox$/).length).toBe(1);
    expect(exported).toHaveLength(1);
    expect(exported[0]!.blend).toBe(bakedBlend);
    expect(hits(/\/python$/)).toHaveLength(0);
    expect(hits(/\/ext$/)).toHaveLength(0);
    // The project's lighting went with its creation, so it isn't sent again.
    expect(hits(/\/target$/)).toHaveLength(0);
    // The clips' fingerprint is Kiln's own live one (what syncClips compares), not the baked file's.
    const link = JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', 'Griever.json'), 'utf8')) as { animFp: string; targetFp: string };
    expect(link.animFp).toBe('fp-live');
    expect(link.targetFp).toMatch(/^griever-abc12\|[0-9a-f]{16}$/);
  }, 30_000);

  it('takes the effort asked for, omits kind for an existing project, and sends the lighting again only when it changed', async () => {
    calls = [];
    await call('kiln_request', { model: 'Griever', text: 'Make it wetter.', wait: false });
    expect(hits(/\/target$/)).toHaveLength(0); // same lighting as last sent
    expect(hits(/\/chat$/)[0]!.body).toEqual({ text: 'Make it wetter.', from: 'shuriken', effort: 'low' });
    await drain();
    calls = [];
    place = { ...place!, clockTime: 22 };
    await call('kiln_request', { model: 'Griever', text: 'The Lunge reads wrong in the night version of the maze.', kind: 'fix', effort: 'max', wait: false });
    expect(hits(/\/target$/)).toHaveLength(1);
    expect(hits(/\/target$/)[0]!.body).toEqual({ target: 'roblox', lighting: place });
    // The lighting was sent before the brief.
    expect(calls.findIndex((c) => c.path.endsWith('/target'))).toBeLessThan(calls.findIndex((c) => c.path.endsWith('/chat')));
    expect(hits(/\/chat$/)[0]!.body).toMatchObject({ kind: 'fix', effort: 'max', from: 'shuriken' });
    await drain();
    calls = [];
    await call('kiln_request', { model: 'Griever', text: 'Again.', wait: false });
    expect(hits(/\/target$/)).toHaveLength(0);
    await drain();
  });

  it('never fails a request because the lighting can’t be read (and doesn’t send nothing as a change)', async () => {
    calls = [];
    placeThrows = true;
    const r = await call('kiln_request', { model: 'Griever', text: 'Slightly bigger claws.', wait: false });
    placeThrows = false;
    expect(r.out.isError).toBeFalsy();
    expect(hits(/\/target$/)).toHaveLength(0);
    expect(hits(/\/chat$/)).toHaveLength(1);
    await drain();
  });

  it('puts a new model’s project on the Roblox target even when the place can’t be read', async () => {
    calls = [];
    placeThrows = true;
    const r = await call('kiln_request', { model: 'Boulder', text: 'A simple placeholder boulder.', wait: false });
    placeThrows = false;
    expect(r.out.isError).toBeFalsy();
    expect(hits(/^\/api\/v1\/projects$/)[0]!.body).toEqual({ title: 'Boulder', units: 'studs', linked: { app: 'Shuriken Studio', model: 'Boulder', project: root }, target: 'roblox' });
    expect(hits(/\/chat$/)[0]!.body).toMatchObject({ kind: 'new' });
    await drain();
    // A later request with the place readable sends the lighting once.
    calls = [];
    await call('kiln_request', { model: 'Boulder', text: 'Mossier.', wait: false });
    expect(hits(/\/target$/)).toHaveLength(1);
    expect(hits(/\/target$/)[0]!.body).toEqual({ target: 'roblox', lighting: place });
    await drain();
  });
});

describe('the baked Roblox export', () => {
  it('waits out a copilot that is still working (409), and says when it falls back to the live scene', async () => {
    exported.length = 0;
    calls = [];
    bake409 = 2;
    const ok = await modeling.importFromKiln(root, 'griever-abc12', 'Griever');
    expect(ok.ok).toBe(true);
    expect(hits(/\/roblox$/)).toHaveLength(3);
    expect(exported).toHaveLength(1);
    expect(hits(/\/ext$/)).toHaveLength(0);
    // A bake that can't be had: the live scene is exported instead, and the result says so.
    exported.length = 0;
    calls = [];
    bakeBlendPath = null;
    const again = await modeling.importFromKiln(root, 'griever-abc12', 'Griever');
    bakeBlendPath = bakedBlend;
    expect(again.ok).toBe(true);
    expect(exported).toHaveLength(0);
    expect(hits(/\/ext$/)).toHaveLength(1);
  });

  it('gives up on a copilot that stays busy and exports the live scene', async () => {
    exported.length = 0;
    calls = [];
    bake409 = 1000;
    const r = await modeling.importFromKiln(root, 'griever-abc12', 'Griever');
    bake409 = 0;
    expect(r.ok).toBe(true);
    expect(hits(/\/roblox$/).length).toBeGreaterThan(1);
    expect(hits(/\/ext$/)).toHaveLength(1);
  });

  it('runs on Kiln 0.7.2 as before: the live scene exported inside Kiln, no bake', async () => {
    await setVersion('0.7.2');
    exported.length = 0;
    calls = [];
    const r = await modeling.importFromKiln(root, 'griever-abc12', 'Griever');
    expect(r.ok).toBe(true);
    expect(hits(/\/roblox$/)).toHaveLength(0);
    expect(hits(/\/ext$/)).toHaveLength(1);
    expect(exported).toHaveLength(0);
    await setVersion('0.7.3');
  });
});

describe('Kiln before 0.7.3', () => {
  it('gets the old brief and project: Roblox paragraph, research line, no kind, no target', async () => {
    await setVersion('0.7.2');
    calls = [];
    const r = await call('kiln_request', { model: 'Crate', text: 'A wooden crate', references: 'a medieval shipping crate', wait: false });
    expect(r.out.isError).toBeFalsy();
    expect(hits(/^\/api\/v1\/projects$/)[0]!.body).toEqual({ title: 'Crate', units: 'studs', linked: { app: 'Shuriken Studio', model: 'Crate', project: root } });
    const chat = hits(/\/chat$/)[0]!.body;
    expect(chat.text).toBe(kilnBrief('A wooden crate', 'a medieval shipping crate', 0));
    expect(chat.from).toBe('Shuriken 3D modeler');
    expect(chat).not.toHaveProperty('kind');
    expect(chat).not.toHaveProperty('effort');
    expect(hits(/\/target$/)).toHaveLength(0);
    await drain();
    await setVersion('0.7.3');
  });
});

describe('no hands-on control of Kiln projects (0.7.3)', () => {
  it('refuses to change a Kiln project’s clips and points at kiln_request', async () => {
    calls = [];
    for (const action of ['generate', 'regenerate', 'settings', 'rename', 'delete', 'event']) {
      const r = await call('kiln_clip', { model: 'Griever', clip: 'Walk', action, generator: 'gait', to: 'Stride', label: 'Hit', time: 0.4, settings: { loop: true } });
      expect(r.out.isError, action).toBe(true);
      expect(r.text, action).toMatch(/Kiln owns its model and clips/);
      expect(r.text, action).toMatch(/kiln_request \{model: "Griever", kind: "animate"/);
      expect(r.text, action).toMatch(/kind: "fix"/);
    }
    expect(hits(/\/python$/)).toHaveLength(0);
    expect(hits(/\/clips\//)).toHaveLength(0);
  });

  it('still checks a Kiln project’s clip, through Kiln', async () => {
    calls = [];
    const r = await call('kiln_clip', { model: 'Griever', clip: 'Walk', action: 'check' });
    expect(r.out.isError).toBeFalsy();
    expect(r.data).toMatchObject({ model: 'Griever', clip: 'Walk', report: { summary: 'clean' } });
    expect(hits(/\/projects\/griever-abc12\/clips\/Walk$/)[0]!.body).toEqual({ action: 'check' });
  });

  it('leaves models that live in Shuriken’s own Blender, and older Kiln, as they were', async () => {
    // A model with no Kiln project: the clip operation runs in the engine as before.
    const own = await call('kiln_clip', { model: 'OwnModel', clip: 'Walk', action: 'regenerate', params: { speed: 8 } });
    expect(own.text).not.toMatch(/Kiln owns/);
    expect(own.data).toMatchObject({ model: 'OwnModel', clip: 'Walk', action: 'regenerate' });
    await setVersion('0.7.2');
    const old = await call('kiln_clip', { model: 'Griever', clip: 'Walk', action: 'regenerate', params: { speed: 8 } });
    await setVersion('0.7.3');
    expect(old.text).not.toMatch(/Kiln owns/);
    expect(old.data).toMatchObject({ model: 'Griever', action: 'regenerate' });
  });

  it('tells the modeler’s blender_python a Kiln project is not its to change, unless the advanced setting lets it work inside Kiln', () => {
    expect(modeling.kilnOwns(root, 'Griever')).toBe(true);
    expect(modeling.kilnOwns(root, 'OwnModel')).toBe(false);
    expect(modeling.modelsInKiln).toBe(false);
  });
});

describe('bundled Kiln helpers', () => {
  const dir = join(resourcesDir, 'blender');
  const helpers = readdirSync(dir).filter((f) => /^kiln.*\.py$/.test(f));

  it('are LF files and include the Roblox target module', () => {
    expect(helpers).toContain('kiln_roblox.py');
    for (const f of helpers) expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain('\r');
    expect(readFileSync(join(dir, 'kiln.py'), 'utf8')).toMatch(/import kiln_roblox as roblox/);
  });

  it('are byte-identical (LF) to Kiln’s own, when KILN_BLENDER_DIR points at a Kiln checkout’s blender folder', () => {
    const kilnDir = process.env.KILN_BLENDER_DIR ? resolve(process.env.KILN_BLENDER_DIR) : '';
    if (!kilnDir || !existsSync(kilnDir)) return;
    const theirs = readdirSync(kilnDir).filter((f) => /^kiln.*\.py$/.test(f));
    expect(helpers.sort()).toEqual(theirs.sort());
    for (const f of theirs) expect(readFileSync(join(dir, f)).equals(Buffer.from(readFileSync(join(kilnDir, f), 'utf8').replace(/\r\n/g, '\n'))), f).toBe(true);
  });

  it('are read for a baked material’s see-through-ness by the Roblox export', () => {
    const src = readFileSync(join(dir, 'roblox_export.py'), 'utf8');
    expect(src).toMatch(/roblox_transparency/);
    expect(src).toMatch(/RobloxUV/);
  });
});

describe('what agents are told about Kiln', () => {
  const squash = (t: string) => t.replace(/\s+/g, ' ');
  const must = [/kiln_request/, /kind: "fix"/, /Studio screenshots/, /\.shuriken\/evidence/, /images/, /never retune|never change or retune|retune a Kiln project/i, /blender_python/];

  it('has the modeler, the animator and the animation copilot ask Kiln for results, read the delivery and send fixes with Studio screenshots', () => {
    const texts: Record<string, string> = { modeler: ROLES.modeler!.instructions, animator: ROLES.animator!.instructions, 'animation copilot': COPILOT_ROLES.animation.instructions };
    for (const [who, text] of Object.entries(texts)) {
      const t = squash(text);
      for (const re of must) expect(t, `${who}: ${re}`).toMatch(re);
      expect(t, who).toMatch(/delivery/);
      expect(t, who).toMatch(/kind: "(new"|animate")/);
    }
    expect(squash(ROLES.modeler!.instructions)).toMatch(/Leave effort out \(detail sets it\)/);
    // Kiln first, for everything: the modeler is Kiln's client, and Blender is the fallback it says out loud.
    const modeler = squash(ROLES.modeler!.instructions);
    expect(modeler).toMatch(/Kiln builds every model of this game \(props, vehicles, characters, creatures, weapons, map pieces, set dressing\)/);
    expect(modeler).toMatch(/Fallback, only when kiln_request says Kiln can't be reached or failed twice on a model/);
    expect(modeler).toMatch(/Skill "kiln-briefs" has worked briefs/);
    expect(modeler).toMatch(/Kiln wasn't reachable, so I modeled <name> in Blender myself\./);
    expect(modeler).not.toMatch(/Props and set pieces you model yourself in Blender/);
    expect(modeler).not.toMatch(/^ROLE: 3D modeler\. Model custom props and set pieces in a headless Blender/);
    expect(squash(COPILOT_ROLES.animation.instructions)).toMatch(/Leave effort out/);
  });

  it('has the planner state kind, goal and must-haves, and keep a wrong result a fix request', () => {
    const t = squash(ROLES.executive!.instructions);
    expect(t).toMatch(/A model task is SHORT and LOOSE/);
    expect(t).toMatch(/most models are QUICK/);
    expect(t).toMatch(/builds EVERY model of the game/);
    expect(t).toMatch(/read from Kiln's delivery afterwards/);
    expect(t).toMatch(/fix request with Studio screenshots/);
  });
});
