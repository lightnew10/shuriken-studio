import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling } from '../src/core/modeling/kiln-modeling';
import { briefBody, briefSpec, renderBrief } from '../src/core/modeling/kiln-brief';
import { modelSockets, parseChecks, readFamily, readStyleSheet, styleId, styleSpec, type FamilyRecord } from '../src/core/modeling/kiln-family';
import { parseFit, parseModels, type Mat4 } from '../src/core/modeling/kiln-manifest';
import { socketFrame } from '../src/core/modeling/kiln-layout';
import { kilnDirectorLine } from '../src/core/context/environment';
import { GRIP_IN_TEXT, KILN_BUILD, registerKilnTools } from '../src/core/capabilities/kiln-tools';
import { registerWaitTools, WAIT_FOR } from '../src/core/capabilities/wait-tools';
import type { ProjectContext } from '../src/core/projects/project-service';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import { fakeBlender, fakeKiln } from './helpers/fake-kiln';

// Shuriken against Kiln 0.8.2's contract (Kiln's docs/INTEGRATION.md: "While a turn is running", "Requirements
// as data", "A game's style sheet", "Reading a turn", "Models, sockets and fit", "Many builds at once"), with
// a fake Kiln that behaves like it. The same flows against 0.8.1 are in kiln-family, kiln-queue and kiln-results.

/** A frame at a point (scene units, Blender axes), facing its own +Y. */
const at = (x: number, y: number, z: number): Mat4 => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
const until = async (cond: () => unknown, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

describe('a brief’s requirements as data', () => {
  const brief = {
    text: 'The three torso frames of Scrapyard Titans.',
    family: 'MechTorsos',
    members: [{ name: 'Torso_Light' }, { name: 'Torso_Heavy' }],
    sockets: [{ name: 'LegSocket', joins: 'the top centre of every leg set', where: 'bottom centre of every torso' }],
    style: 'Industrial salvage: rust, one amber glow.',
    tris: 6000,
    grounded: true,
  };

  it('sends triangles, ground contact and the socket names as spec, the style as an id, and keeps in prose only what data can’t say', () => {
    const body = briefBody(brief, { fields: true, styleId: 'shuriken-titans-1a2b3c', styleKnown: false });
    expect(body.spec).toEqual({ tris: 6000, ground: true, sockets: ['LegSocket'] });
    expect(body.style).toBe('shuriken-titans-1a2b3c');
    expect(body.mode).toBe('queue');
    // No sheet in Kiln yet: the look is described once, so the first build's copilot can propose the sheet from it.
    // Bare lists: Kiln's own prompt says what a socket and a set of models are (the whole text, 233 characters).
    expect(body.text).toBe('The three torso frames of Scrapyard Titans.\n\nGame look: Industrial salvage: rust, one amber glow.\n\nSeparate models, exact top-level names: Torso_Light, Torso_Heavy.\n\nSockets (on every model): LegSocket (joins the top centre of every leg set; bottom centre of every torso).');
    expect(body.text).not.toMatch(/6,000 triangles|stands on the ground|marker with role/);
    // Once Kiln has the sheet, the id says it all.
    expect(briefBody(brief, { fields: true, styleId: 'shuriken-titans-1a2b3c', styleKnown: true }).text).not.toMatch(/Game look|The look every model/);
    // Kiln 0.8.1 gets the same brief as one text.
    const old = briefBody(brief, false);
    expect(old).toEqual({ text: renderBrief(brief) });
    expect(old.text).toMatch(/At most 6,000 triangles per model; each stands on the ground/);
  });

  it('turns one model’s size from width, height, depth to Kiln’s axes (z up), and sends no spec when there is nothing to check', () => {
    expect(briefSpec({ text: 'A crane.', size: [14, 80, 12], grounded: true })).toEqual({ size: [14, 12, 80], ground: true });
    expect(briefSpec({ text: 'A crate.' })).toBeNull();
    expect(briefBody({ text: 'A crate.' }, { fields: true, styleId: 's1' })).toEqual({ text: 'A crate.', mode: 'queue', style: 's1' });
    // A family's own size isn't one size: the members' sizes stay in the text.
    expect(briefSpec({ text: 'x', members: [{ name: 'A' }, { name: 'B' }], size: [1, 2, 3] })).toBeNull();
  });
});

describe('reading what Kiln 0.8.2 delivers', () => {
  const raw = [
    {
      name: 'Torso_Light',
      objects: ['Torso_Light_Hull', 'Torso_Light_Glass'],
      origin: [12, 0, 0],
      origin_at: 'bottom_centre',
      min: [9, -2, 0],
      max: [15, 2, 5],
      size: [6, 4, 5],
      ground_gap: 0,
      tris: 4200,
      materials: [{ name: 'Paint', color: '#c8a020', roblox_material: 'Metal' }],
      rigged: false,
      sockets: [
        { name: 'LegSocket', mates: ['TorsoMount'], position: [0, 0, 0], facing: [0, 0, -1], matrix: [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]] },
        { name: 'ArmSocket_L', mates: [], position: [3, 0, 4], facing: [1, 0, 0], matrix: at(3, 0, 4) },
      ],
    },
    { nonsense: true },
  ];

  it('takes each model’s sockets as frames in the model’s own space, in Roblox axes', () => {
    const models = parseModels(raw);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ name: 'Torso_Light', objects: ['Torso_Light_Hull', 'Torso_Light_Glass'], origin: [12, 0, 0], originAt: 'bottom_centre', tris: 4200, groundGap: 0, rigged: false });
    const s = modelSockets(models[0]!);
    // Blender (3, 0, 4) from the model's origin is Roblox (-3, 4, 0); the socket's mates travel with it.
    expect(s.ArmSocket_L).toMatchObject({ position: [-3, 4, 0], from: 'model' });
    expect(s.LegSocket).toMatchObject({ position: [0, 0, 0], mates: ['TorsoMount'], from: 'model' });
    // The frame is the one a Roblox Attachment gets (kiln-layout.ts socketFrame): its +Z is the socket's facing, here straight down.
    const down = socketFrame(models[0]!.sockets[0]!.matrix, 1);
    expect(down.facing.map((v) => Math.round(v) + 0)).toEqual([0, -1, 0]);
    expect(s.LegSocket!.rotation).toEqual(down.rotation.map((v) => Math.round(v * 100) / 100 + 0));
    // A project exported whole keeps the scene's origin: the model's own origin is added back.
    expect(modelSockets(models[0]!, 1, models[0]!.origin).ArmSocket_L!.position).toEqual([-15, 4, 0]);
    // In a project in meters, lengths become studs.
    expect(modelSockets(models[0]!, 2).ArmSocket_L!.position).toEqual([-6, 8, 0]);
    expect(parseModels(null)).toEqual([]);
  });

  it('reads the fit and the checks, whatever is missing', () => {
    const fit = parseFit({ ok: false, summary: '1 of 2 pairings fit', pairs: [{ parent: 'Torso_Light', socket: 'LegSocket', child: 'Legs_Biped', mate: 'TorsoMount', ok: false, gap: 0.4, buried: 0, problem: 'a 0.4 gap at the joint' }, 'junk'], unpaired: ['ArmSocket_L'] });
    expect(fit).toEqual({ ok: false, summary: '1 of 2 pairings fit', pairs: [{ parent: 'Torso_Light', socket: 'LegSocket', child: 'Legs_Biped', mate: 'TorsoMount', ok: false, gap: 0.4, buried: 0, problem: 'a 0.4 gap at the joint' }], unpaired: ['ArmSocket_L'] });
    expect(parseFit(null)).toBeNull();
    expect(parseChecks([{ name: 'tris', ok: false, detail: 'Torso_Heavy has 9,100 (budget 6,000)' }, { name: 'ground', ok: true }, 7])).toEqual([{ name: 'tris', ok: false, detail: 'Torso_Heavy has 9,100 (budget 6,000)' }, { name: 'ground', ok: true, detail: '' }]);
  });

  it('writes the style sheet as a spec section others can use', () => {
    const text = styleSpec({ id: 'shuriken-titans-1a2b3c', palette: ['#c8a020', '#2f6f6a'], materials: [{ name: 'HazardPaint', color: '#c8a020', roughness: 0.6, roblox_material: 'Metal', use: 'armour plates.' }, { name: 'Glow', color: '#ffb040', emission: 4 }], wear: 'chipped edges, rust in the creases.' }, 'Industrial salvage.');
    expect(text).toContain('kept in Kiln as "shuriken-titans-1a2b3c"');
    expect(text).toContain('The look: Industrial salvage.');
    expect(text).toContain('Palette: #c8a020, #2f6f6a.');
    expect(text).toContain('- HazardPaint: #c8a020, Roblox Metal, roughness 0.6 — armour plates.');
    expect(text).toContain('- Glow: #ffb040, glows.');
    expect(text).toContain('Wear: chipped edges, rust in the creases.');
    expect(styleSpec(null, 'x')).toBe('');
  });

  it('tells the director what the builds in hand will still take', () => {
    expect(kilnDirectorLine({ available: true, detail: 'Kiln 0.8.2', queue: { running: 3, queued: 2, minutes: 14, usd: 7.5 } })).toMatch(/Building now: 3 running, 2 waiting their turn \(about 14 min and \$7\.50 of usage to finish them, an estimate; count it into any time you give\)\.$/);
    expect(kilnDirectorLine({ available: true, detail: 'Kiln 0.8.2', queue: { running: 0, queued: 0 } })).not.toMatch(/Building now/);
  });
});

// ---- Against a fake Kiln 0.8.2 ---------------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'kiln-082-'));
const root = join(tmp, 'project');
mkdirSync(root, { recursive: true });
const kiln = await fakeKiln(tmp, { version: '0.8.2' });
const blender = fakeBlender({
  // The export of one member: what Shuriken's Blender printed after keeping exactly the objects and origin it was given.
  prepared: (_name, prepare) => {
    const origin = /_exact_origin = (\[[^\]]*\])/.exec(prepare)?.[1] ?? '[0, 0, 0]';
    return /_exact = None/.test(prepare) ? `KILN_MEMBER ${JSON.stringify({ found: false, top: [] })}` : `KILN_MEMBER {"found": true, "origin": ${origin}, "lo": ${origin}, "hi": ${origin}, "objects": [], "markers": []}`;
  },
});
const published: FamilyRecord[][] = [];
const chat: string[] = [];
const modeling = new KilnModeling(
  blender.backend,
  { enabled: () => false, resourcesDir: resolve(__dirname, '..', 'resources'), runtimeFile: () => kiln.runtimeFile, bakeWaitMs: 400, buildsAtOnce: () => 8, note: (text) => (chat.push(text), `m${chat.length}`), onSockets: (_r, families) => void published.push(JSON.parse(JSON.stringify(families)) as FamilyRecord[]) },
  new EventBus(),
  new Logger(null, null).scope('kiln'),
);
type Handler = ToolDefinition['handler'];
const tools = new Map<string, Handler>();
const reg = { register: (def: { name: string; handler: Handler }) => void tools.set(def.name, def.handler), get: () => undefined, invoke: async () => ({ content: [] }) } as never;
registerKilnTools(reg, { project: () => ({ root }) as unknown as ProjectContext, kiln: () => modeling, modeling: () => blender.backend, bus: new EventBus() });
registerWaitTools(reg, { project: () => ({ root }) as never, studio: {} as never, uploading: () => [], kiln: () => modeling });
const caller: CallerContext = { kind: 'agent', runId: 'run_082', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const call = async (name: string, args: Record<string, unknown>) => {
  const notes: string[] = [];
  const out = await tools.get(name)!({ args, caller, signal: new AbortController().signal, progress: (n: { message?: string }) => void notes.push(n.message ?? '') } as never);
  const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { out, text, notes, data: out.data as Record<string, any> | undefined };
};
const chats = () => kiln.hits(/\/chat$/);
const lastChat = () => chats().at(-1)!;
const projectOf = (name: string) => [...kiln.projects.keys()].find((id) => id.startsWith(`${name.toLowerCase()}-`))!;
const turnsOf = (name: string) => [...kiln.turns.values()].filter((t) => t.projectId === projectOf(name));
const runningOf = (name: string) => turnsOf(name).find((t) => t.state === 'running');

const saved = { env: process.env.SHURIKEN_NO_KILN, build: { ...KILN_BUILD }, wait: { ...WAIT_FOR } };
beforeAll(async () => {
  delete process.env.SHURIKEN_NO_KILN;
  Object.assign(KILN_BUILD, { pollMs: 15, busyPollMs: 15, noteMs: 30 });
  Object.assign(WAIT_FOR, { pollMs: 10, noteMs: 10 });
  kiln.autoFinish = null;
  await modeling.kiln.check(true);
});
afterAll(async () => {
  if (saved.env === undefined) delete process.env.SHURIKEN_NO_KILN;
  else process.env.SHURIKEN_NO_KILN = saved.env;
  Object.assign(KILN_BUILD, saved.build);
  Object.assign(WAIT_FOR, saved.wait);
  modeling.stop();
  await kiln.close();
});

const TORSO_MODELS = (names: string[]) =>
  names.map((name, i) => ({
    name,
    objects: [`${name}_Hull`, `${name}_Glass`],
    origin: [i * 12, 0, 0],
    origin_at: 'bottom_centre',
    size: [6, 4, 5 + i],
    ground_gap: 0,
    tris: 4000 + i * 3000,
    materials: [],
    rigged: false,
    sockets: [
      { name: 'LegSocket', mates: ['TorsoMount'], position: [0, 0, 0], facing: [0, 1, 0], matrix: at(0, 0, 0) },
      { name: 'ArmSocket_L', mates: ['ShoulderMount'], position: [3 + i, 0, 4], facing: [0, 1, 0], matrix: at(3 + i, 0, 4) },
    ],
  }));

describe('a family against Kiln 0.8.2', () => {
  it('briefs with spec and the style id, reads the models, sockets, fit and checks Kiln delivers, and keeps the style sheet', async () => {
    const models = TORSO_MODELS(['Torso_Light', 'Torso_Heavy']);
    const fit = { ok: true, summary: 'no pairings in this project yet', pairs: [], unpaired: ['LegSocket', 'ArmSocket_L'] };
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [], models, fit });
    kiln.proposes = { title: 'Scrapyard Titans', palette: ['#c8a020', '#2f6f6a'], materials: [{ name: 'HazardPaint', color: '#c8a020', roblox_material: 'Metal' }] };
    const pending = call('kiln_request', {
      family: 'MechTorsos',
      models: ['Torso_Light', 'Torso_Heavy'],
      sockets: [{ name: 'LegSocket', joins: 'the top centre of every leg set' }, { name: 'ArmSocket_L', joins: 'the left arm' }],
      style: 'Industrial salvage: rust, one amber glow.',
      tris: 6000,
      grounded: true,
      text: 'The torso frames of Scrapyard Titans.',
      timeout_min: 1,
    });
    await until(() => runningOf('MechTorsos'));
    const id = styleId(root);
    expect(id).toMatch(/^shuriken-project-[0-9a-f]{6}$/);
    expect(lastChat().body).toMatchObject({ from: 'shuriken', kind: 'new', mode: 'queue', style: id, spec: { tris: 6000, ground: true, sockets: ['LegSocket', 'ArmSocket_L'] } });
    expect(String(lastChat().body.text)).toContain('Game look: Industrial salvage');
    expect(String(lastChat().body.text)).not.toMatch(/6,000 triangles/);
    // While it builds, the build shows how far Kiln's copilot is.
    await until(() => modeling.builds.list(root)[0]?.progress);
    const live = await call('kiln_builds', { wait: false });
    expect(live.data!.builds[0]).toMatchObject({ name: 'MechTorsos', state: 'running', step: 'Blocking out the main volumes (step 2 of 4, about 3 min left)', stepsDone: 1, steps: 4, minutesLeft: 3 });
    expect(live.data!.queue.expect).toEqual({ usd: 1.95, minutes: 3 });
    // wait_for kiln_turn says the same while it waits.
    const waited = await call('wait_for', { what: 'kiln_turn', model: 'MechTorsos', timeout_sec: 1 });
    expect(waited.notes.join(' ')).toMatch(/Waiting for Kiln's copilot to finish its turn on MechTorsos \(\d+ s so far\): Blocking out the main volumes \(step 2 of 4, about 3 min left\)/);
    kiln.finish(runningOf('MechTorsos')!.turnId, {
      delivery: { size: [18, 4, 6], units: 'studs', objects: 4, tris: 11_000, joints: 0, clips: [], renders: [], models, fit, checks: [{ name: 'tris', ok: false, detail: 'Torso_Heavy has 7,000 triangles (budget 6,000)' }, { name: 'ground', ok: true, detail: '' }, { name: 'sockets', ok: true, detail: '' }] },
    });
    const r = await pending;
    expect(r.out.isError).toBeFalsy();
    // Each model exported from exactly the meshes Kiln names, about the origin Kiln gives.
    expect(blender.exported.map((e) => e.name)).toEqual(['Torso_Light', 'Torso_Heavy']);
    expect(blender.exported[1]!.prepare).toContain('_exact = ["Torso_Heavy_Hull","Torso_Heavy_Glass"]');
    expect(blender.exported[1]!.prepare).toContain('_exact_origin = [12,0,0]');
    // Sockets as Kiln placed them, in each model's own space (Roblox axes), with what they mate with.
    const imp = r.data!.imported;
    expect(imp.models.Torso_Light.sockets).toEqual({ LegSocket: [0, 0, 0], ArmSocket_L: [-3, 4, 0] });
    expect(imp.models.Torso_Heavy.sockets).toEqual({ LegSocket: [0, 0, 0], ArmSocket_L: [-4, 4, 0] });
    const rec = readFamily(root, 'MechTorsos')!;
    expect(rec.read!.members.Torso_Light!.sockets.LegSocket).toMatchObject({ from: 'model', mates: ['TorsoMount'] });
    expect(rec.read!.members.Torso_Heavy).toMatchObject({ originAt: 'bottom_centre', groundGap: 0 });
    // What Kiln itself found unmet is the ground for a fix.
    expect(imp.problems).toEqual(["Kiln's tris check failed: Torso_Heavy has 7,000 triangles (budget 6,000)."]);
    expect(imp.fit).toEqual({ ok: true, summary: 'no pairings in this project yet' });
    expect(r.data!.failedChecks).toEqual(['tris: Torso_Heavy has 7,000 triangles (budget 6,000)']);
    expect(r.data!.next).toMatch(/Kiln's own checks failed: send them back, kiln_request \{family: "MechTorsos", kind: "fix"/);
    // The delivery an agent reads has the facts, not the matrices and mesh lists.
    expect(r.data!.delivery.models[0]).toMatchObject({ name: 'Torso_Light', origin_at: 'bottom_centre', tris: 4000, sockets: [{ name: 'LegSocket', mates: ['TorsoMount'], position: [0, 0, 0] }, { name: 'ArmSocket_L' }] });
    expect(r.data!.delivery.models[0]).not.toHaveProperty('objects');
    expect(r.data!.delivery.models[0].sockets[0]).not.toHaveProperty('matrix');
    // The first build's copilot saved the game's style sheet: the project has a copy, and the spec is told.
    expect(readStyleSheet(root)).toMatchObject({ id, title: 'Scrapyard Titans', palette: ['#c8a020', '#2f6f6a'] });
    expect(JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', 'families', '_style.json'), 'utf8'))).toMatchObject({ id, text: 'Industrial salvage: rust, one amber glow.' });
    expect(published.length).toBeGreaterThan(0);
  }, 30_000);

  it('names the sheet by id from then on, without describing the look again', async () => {
    await call('kiln_request', { model: 'AmmoCrate', detail: 'standard', text: 'A simple ammo crate.', tris: 1500, size: [3, 3, 4], wait: false });
    expect(lastChat().body).toMatchObject({ kind: 'new', style: styleId(root), spec: { tris: 1500, size: [3, 4, 3] }, effort: 'high' });
    expect(String(lastChat().body.text)).toBe('A simple ammo crate.');
    kiln.finish(runningOf('AmmoCrate')!.turnId);
    await call('kiln_builds', {});
  }, 30_000);

  // Two builds in a row: the modeler wrote "a Grip attachment at the handle" in the text, Kiln's quick build gave a
  // sword without one (or with one listed under its Handle part), and model_gear failed "no grip point" on each.
  it('a held tool whose text speaks of a Grip gets the socket, and a Grip Kiln lists under a part is read back', async () => {
    const parts = [
      { name: 'PitSword', objects: ['PitSword_Blade'], origin: [0, 0, 0], origin_at: 'bottom_centre', size: [1, 0.3, 4], ground_gap: 0, tris: 200, materials: [], rigged: false, sockets: [] },
      { name: 'Handle', objects: ['Handle'], origin: [0, 0, 0], origin_at: 'bottom_centre', size: [0.3, 0.3, 1], ground_gap: 0, tris: 40, materials: [], rigged: false, sockets: [{ name: 'Grip', mates: [], position: [0, 0, 0.6], facing: [0, 0, 1], matrix: at(0, 0, 0.6) }] },
    ];
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [], models: parts });
    await call('kiln_request', { model: 'PitSword', detail: 'quick', text: 'A pixel iron sword held as a Tool: upright, blade up, a Grip attachment at the handle.', wait: false });
    const body = lastChat().body as { text: string; spec?: { sockets?: string[] }; effort?: string };
    expect(body.spec?.sockets).toEqual(['Grip']);
    expect(body.text).toContain('Sockets: Grip (joins the hand holding it; on the handle, where the fist closes).');
    // Still the quick build it was asked as.
    expect(body.effort).toBe('low');
    kiln.finish(runningOf('PitSword')!.turnId);
    await call('kiln_builds', {});
    expect(readFamily(root, 'PitSword')!.read!.members.PitSword!.sockets.Grip).toMatchObject({ position: [0, 0.6, 0], from: 'model' });
    // A fix, an animation, or a brief with its own sockets is left as it was written.
    expect(GRIP_IN_TEXT.test('A crate with a good grip on reality.')).toBe(false);
    expect(GRIP_IN_TEXT.test('held in the hand, grip attachment at the middle')).toBe(true);
  }, 30_000);

  it('reports pairings that don’t fit', async () => {
    const legs = [{ name: 'Legs_Biped', objects: ['Legs_Biped_Frame'], origin: [0, 0, 0], origin_at: 'bottom_centre', size: [6, 4, 8], ground_gap: 0, tris: 5000, materials: [], rigged: false, sockets: [{ name: 'TorsoMount', mates: ['LegSocket'], position: [0, 0, 8], facing: [0, 0, 1], matrix: at(0, 0, 8) }] }, { name: 'Legs_Treads', objects: ['Legs_Treads_Belt'], origin: [14, 0, 0], origin_at: 'bottom_centre', size: [12, 6, 4.5], ground_gap: 0.3, tris: 5000, materials: [], rigged: false, sockets: [] }];
    const fit = { ok: false, summary: '1 of 2 pairings fit', pairs: [{ parent: 'Torso_Light', socket: 'LegSocket', child: 'Legs_Biped', mate: 'TorsoMount', ok: true, gap: 0, buried: 0.1, problem: null }, { parent: 'Torso_Heavy', socket: 'LegSocket', child: 'Legs_Biped', mate: 'TorsoMount', ok: false, gap: 0.4, buried: 0, problem: 'a 0.4 stud gap at the joint' }], unpaired: [] };
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [], models: legs, fit });
    blender.exported.length = 0;
    const pending = call('kiln_request', { family: 'MechLegs', models: ['Legs_Biped', 'Legs_Treads'], fits: ['MechTorsos'], sockets: [{ name: 'TorsoMount', joins: "a torso's LegSocket" }], grounded: true, text: 'The leg units.', timeout_min: 1 });
    await until(() => runningOf('MechLegs'));
    expect(String(lastChat().body.text)).toContain(`These must fit the parts already built in Kiln project "${projectOf('MechTorsos')}" (MechTorsos: Torso_Light, Torso_Heavy; sockets LegSocket, ArmSocket_L)`);
    kiln.finish(runningOf('MechLegs')!.turnId, { delivery: { size: [26, 6, 8], units: 'studs', objects: 2, tris: 10_000, joints: 0, clips: [], renders: [], models: legs, fit, checks: [{ name: 'ground', ok: false, detail: 'Legs_Treads floats 0.3 above the ground' }, { name: 'fit', ok: false, detail: '1 of 2 pairings fit' }] } });
    const r = await pending;
    const imp = r.data!.imported;
    expect(imp.fit).toEqual({ ok: false, summary: '1 of 2 pairings fit', failing: ['Legs_Biped.TorsoMount on Torso_Heavy.LegSocket: a 0.4 stud gap at the joint'] });
    expect(imp.problems).toEqual(['Legs_Treads has no TorsoMount socket to read back.', "Kiln's ground check failed: Legs_Treads floats 0.3 above the ground.", "Kiln's fit check failed: 1 of 2 pairings fit."]);
    expect(imp.models.Legs_Biped.sockets).toEqual({ TorsoMount: [0, 8, 0] });
    expect(readFamily(root, 'MechLegs')!.read!.members.Legs_Treads).toMatchObject({ groundGap: 0.3 });
  }, 30_000);
});

describe('talking to a build that is still running', () => {
  it('interjects a correction into the running build: same build, same turn, one result', async () => {
    const started = await call('kiln_request', { model: 'Turret', text: 'A turret base with two heads.', wait: false });
    expect(started.data).toMatchObject({ state: 'running', turn: expect.any(String) });
    const before = chats().length;
    const r = await call('kiln_request', { model: 'Turret', mode: 'interject', text: 'The heads need a MountSocket each.' });
    expect(r.out.isError).toBeFalsy();
    expect(r.data).toMatchObject({ interjected: true, build: started.data!.build, turn: started.data!.turn });
    expect(r.data!.note).toMatch(/reads it at its next step and re-plans/);
    expect(chats()).toHaveLength(before + 1);
    expect(lastChat().body).toEqual({ text: 'The heads need a MountSocket each.', from: 'shuriken', mode: 'interject' });
    expect(runningOf('Turret')!.interjections).toEqual(['The heads need a MountSocket each.']);
    // Still one build in Shuriken's queue.
    expect(modeling.builds.list(root).filter((b) => b.name === 'Turret')).toHaveLength(1);
    kiln.finish(runningOf('Turret')!.turnId);
    await call('kiln_builds', {});
    // Nothing running any more: an interjection has nothing to join.
    const late = await call('kiln_request', { model: 'Turret', mode: 'interject', text: 'Also a hatch.' });
    expect(late.out.isError).toBe(true);
    expect(late.text).toMatch(/No build of Turret is running to interject into .* kind "fix" for what is wrong, "rework" for more\./);
  }, 30_000);

  it('queues follow-on work behind the running build, and replaces a build aimed at the wrong thing', async () => {
    const first = await call('kiln_request', { model: 'Turret', kind: 'rework', text: 'Chunkier base.', wait: false });
    const follow = await call('kiln_request', { model: 'Turret', kind: 'rework', text: 'Add a third head.', wait: false });
    // The follow-on waits its turn in Shuriken's queue: one build per Kiln project at a time.
    expect(follow.data).toMatchObject({ state: 'queued', position: 1 });
    const before = chats().length;
    kiln.finish(runningOf('Turret')!.turnId);
    await until(() => chats().length === before + 1);
    expect(lastChat().body).toMatchObject({ text: 'Add a third head.', mode: 'queue', kind: 'rework' });
    // Start over instead: the running build gives way.
    const replaced = await call('kiln_request', { model: 'Turret', kind: 'rework', mode: 'replace', text: 'A missile rack instead of heads.', wait: false });
    expect(replaced.data).toMatchObject({ state: 'running' });
    expect(lastChat().body).toMatchObject({ text: 'A missile rack instead of heads.', mode: 'replace' });
    const mine = modeling.builds.list(root).filter((b) => b.name === 'Turret');
    expect(mine.find((b) => b.id === follow.data!.build)).toMatchObject({ state: 'stopped' });
    expect(mine.find((b) => b.id === first.data!.build)).toMatchObject({ state: 'done' });
    expect(turnsOf('Turret').filter((t) => t.state === 'running')).toHaveLength(1);
    kiln.finish(runningOf('Turret')!.turnId);
    const all = await call('kiln_builds', { builds: [replaced.data!.build] });
    expect(all.data!.builds[0]).toMatchObject({ state: 'done', imported: { ok: true } });
  }, 30_000);

  it('waits in Kiln’s own queue behind the user’s turn, where Kiln 0.8.1 answered 409', async () => {
    const turret = projectOf('Turret');
    kiln.turns.set('users-turn', { projectId: turret, turnId: 'users-turn', state: 'running', reply: '', clips: [], effort: null, effortWhy: null, delivery: null, pollsLeft: null, costUsd: null, body: {} });
    const posts = chats().length;
    const r = await call('kiln_request', { model: 'Turret', kind: 'fix', text: 'The base clips the floor.', wait: false });
    // One POST, never refused: Kiln queued it behind the user's turn.
    expect(chats()).toHaveLength(posts + 1);
    expect(lastChat().body).toMatchObject({ mode: 'queue', kind: 'fix' });
    const turn = kiln.turns.get(r.data!.turn)!;
    expect(turn.state).toBe('queued');
    await until(() => modeling.builds.get(r.data!.build)?.step === "Waiting in Kiln: its project's copilot is busy with another turn");
    kiln.finish('users-turn');
    expect(turn.state).toBe('running');
    kiln.finish(turn.turnId);
    expect((await call('kiln_builds', { builds: [r.data!.build] })).data!.builds[0]).toMatchObject({ state: 'done' });
  }, 30_000);

  it('says what an older Kiln can’t do', async () => {
    kiln.version = '0.8.1';
    await modeling.kiln.check(true);
    const started = await call('kiln_request', { model: 'AmmoCrate', kind: 'rework', text: 'Stencilled lid.', wait: false });
    // The 0.8.1 brief: no spec, no style id, no mode.
    expect(lastChat().body).toEqual({ text: 'Stencilled lid.\n\nThe look every model of this game shares: Industrial salvage: rust, one amber glow.', from: 'shuriken', kind: 'rework', effort: 'low' });
    const r = await call('kiln_request', { model: 'AmmoCrate', mode: 'interject', text: 'Yellow, not red.' });
    expect(r.out.isError).toBe(true);
    expect(r.text).toBe(`Kiln 0.8.1 can't take a message while it builds (Kiln 0.8.2 can). Send it as kind "fix" when the build has ended: kiln_builds {wait: true} waits for it.`);
    kiln.finish(runningOf('AmmoCrate')!.turnId);
    await call('kiln_builds', { builds: [started.data!.build] });
    kiln.version = '0.8.2';
    await modeling.kiln.check(true);
  }, 30_000);
});

describe('a project that is a map', () => {
  it('is left to kiln_layout_import: the build ends without baking its placements into one model', async () => {
    blender.exported.length = 0;
    const pending = call('kiln_request', { model: 'ScrapyardArena', text: 'The arena: a ring road, container stacks and two cranes placed from their own projects.', timeout_min: 1 });
    await until(() => runningOf('ScrapyardArena'));
    kiln.placements.set(projectOf('ScrapyardArena'), 140);
    kiln.calls.length = 0;
    kiln.finish(runningOf('ScrapyardArena')!.turnId);
    const r = await pending;
    expect(r.out.isError).toBeFalsy();
    expect(r.data!.imported).toMatchObject({ ok: true, layout: true, model: 'ScrapyardArena', placements: 140 });
    expect(r.data!.imported.next).toMatch(/ScrapyardArena is a map \(140 placed pieces\): kiln_layout_import \{model: "ScrapyardArena"\} brings it into the game/);
    // No bake and no export here: the importer does both once, its own way.
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(0);
    expect(blender.exported).toHaveLength(0);
    kiln.placements.clear();
  }, 30_000);
});

describe('a project Kiln doesn’t list', () => {
  it('is still waited for: Kiln lists only its most recent projects', async () => {
    const turret = projectOf('Turret');
    kiln.unlisted.add(turret);
    const started = await call('kiln_request', { model: 'Turret', kind: 'fix', text: 'Thicker barrel.', wait: false });
    const waiting = call('wait_for', { what: 'kiln_turn', model: 'Turret', timeout_sec: 5 });
    await new Promise((ok) => setTimeout(ok, 40));
    kiln.finish(runningOf('Turret')!.turnId);
    expect((await waiting).data).toMatchObject({ ready: true, kilnProject: turret });
    await call('kiln_builds', { builds: [started.data!.build] });
    // One Kiln has never heard of is still said to be unknown.
    kiln.unlisted.add('gone-1');
    expect((await call('wait_for', { what: 'kiln_turn', kiln_project: 'gone-1', timeout_sec: 1 })).text).toMatch(/Kiln has no project gone-1/);
    kiln.unlisted.clear();
  }, 30_000);
});

describe('the GPU gate of Kiln 0.8.2', () => {
  it('is read while several builds run, and only then', async () => {
    kiln.calls.length = 0;
    await modeling.watchLoad();
    expect(kiln.hits(/\/load$/)).toHaveLength(0);
    const a = await call('kiln_request', { model: 'AmmoCrate', kind: 'fix', text: 'a', wait: false });
    await modeling.watchLoad();
    expect(kiln.hits(/\/load$/)).toHaveLength(0);
    const b = await call('kiln_request', { model: 'Turret', kind: 'fix', text: 'b', wait: false });
    kiln.load.gpu = { slots: 3, busy: 3, waiting: 2, waitedMs: 5000 };
    await modeling.watchLoad();
    expect(kiln.hits(/\/load$/)).toHaveLength(1);
    // One reading is no evidence: the limit is the setting.
    expect(modeling.builds.status()).toMatchObject({ atOnce: 8, setting: 8, note: null });
    // An older Kiln has no such endpoint: it isn't asked.
    kiln.version = '0.8.1';
    await modeling.kiln.check(true);
    await modeling.watchLoad();
    expect(kiln.hits(/\/load$/)).toHaveLength(1);
    kiln.version = '0.8.2';
    await modeling.kiln.check(true);
    for (const m of ['AmmoCrate', 'Turret']) kiln.finish(runningOf(m)!.turnId);
    await call('kiln_builds', { builds: [a.data!.build, b.data!.build] });
  }, 30_000);
});

// Variants: the modeler asks for Forge_A, Forge_B and Forge_C, keeps one and removes the others. A removed model's
// own Kiln project goes to Kiln's trash, so losers don't pile up there; a family's project stays.
describe('a model that was removed', () => {
  it('takes its own Kiln project with it, and never a family’s', async () => {
    kiln.autoFinish = 'now' as never;
    const id = projectOf('AmmoCrate');
    expect(modeling.linkedProject(root, 'AmmoCrate')).toBe(id);
    kiln.calls.length = 0;
    const said = await modeling.discard(root, 'AmmoCrate');
    expect(kiln.hits(/\/delete$/).map((c) => c.path)).toEqual([`/api/v1/projects/${id}/delete`]);
    expect(said).toMatch(new RegExp(`^its Kiln project ${id} `));
    expect(modeling.linkedProject(root, 'AmmoCrate')).toBeNull();
    // Nothing linked: nothing to do. A family member: its project is the family's.
    expect(await modeling.discard(root, 'AmmoCrate')).toBeNull();
    expect(await modeling.discard(root, 'Torso_Heavy')).toBeNull();
    expect(kiln.hits(/\/delete$/)).toHaveLength(1);
  });
});
