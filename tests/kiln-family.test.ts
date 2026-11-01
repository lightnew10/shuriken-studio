import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling } from '../src/core/modeling/kiln-modeling';
import { briefBody, renderBrief } from '../src/core/modeling/kiln-brief';
import { familyProblems, memberOf, memberPrepare, parsePrepared, publishSockets, readFamily, readSockets, readStyle, socketSpread, socketsLuau, socketsSpec, styleId, type FamilyRecord, type MarkerIn } from '../src/core/modeling/kiln-family';
import type { Mat4 } from '../src/core/modeling/kiln-manifest';
import { ModelStore } from '../src/core/modeling/model-store';
import { kilnGoalBrief, registerKilnTools } from '../src/core/capabilities/kiln-tools';
import type { ProjectContext } from '../src/core/projects/project-service';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import { ROLES } from '../src/core/agents/roles';
import { fakeBlender, fakeKiln } from './helpers/fake-kiln';
import { ExportHarness, blender } from './helpers/blender-export';

// Parts that must fit together: one Kiln project per interface family, every member its own model in the
// game, sockets stated as names and constraints and read back as positions, a later family fitted against
// the earlier project. A fake Kiln and a fake Blender for Shuriken's side; the scene surgery that takes one
// member out of Kiln's baked scene runs in the real Blender where it is installed.

/** A marker at a point (scene units, Blender axes), facing its own +Y. */
const at = (x: number, y: number, z: number): Mat4 => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];

describe('a brief as data, rendered to prose for Kiln up to 0.8.1', () => {
  it('leaves a plain brief as the agent wrote it', () => {
    expect(renderBrief({ text: '  A wooden crate.  ' })).toBe('A wooden crate.');
    expect(renderBrief({ text: 'A Griever.', references: 'the Griever from The Maze Runner films.' })).toBe('A Griever.\n\nThe subject is the Griever from The Maze Runner films.');
    expect(kilnGoalBrief('A Griever.', 'a snow leopard')).toBe('A Griever.\n\nThe subject is a snow leopard.');
  });

  it('asks for a family in one project, sockets by name and constraint, the fit, the shared style and the budget', () => {
    const text = renderBrief({
      text: 'The three torso frames of Scrapyard Titans, a mech arena; seen at 20-80 studs from behind the shoulder.',
      family: 'MechTorsos',
      members: [{ name: 'Torso_Light', what: 'compact scout frame', size: [6, 5, 4] }, { name: 'Torso_Medium' }, { name: 'Torso_Heavy', what: 'hunched slab armour.' }],
      sockets: [
        { name: 'LegSocket', joins: 'the top centre of every leg set', where: 'bottom centre of every torso; the same position on all three' },
        { name: 'ArmSocket_L', joins: 'the left arm' },
      ],
      fits: [{ name: 'MechLegs', projectId: 'mechlegs-7', members: ['Legs_Biped', 'Legs_Treads'], sockets: ['TorsoMount'] }],
      style: 'industrial salvage: mismatched painted plates, rust, one amber glow.',
      tris: 6000,
      grounded: true,
    });
    const paras = text.split('\n\n');
    expect(paras[0]).toBe('The three torso frames of Scrapyard Titans, a mech arena; seen at 20-80 studs from behind the shoulder.');
    expect(paras[1]).toBe('The look every model of this game shares: industrial salvage: mismatched painted plates, rust, one amber glow.');
    expect(paras[2]).toBe(
      'One project, 3 separate models: Torso_Light (compact scout frame; about 6 wide × 5 tall × 4 deep (studs)), Torso_Medium, Torso_Heavy (hunched slab armour). Each is its own top-level object with exactly that name (everything that belongs to it under it), side by side and not overlapping: each becomes its own model in the game, so build them in one scene against the same sockets and with the same proportions and materials.',
    );
    expect(paras[3]).toBe(
      'Sockets on every one of these models (you choose where they go; I read the positions back): LegSocket: joins the top centre of every leg set; bottom centre of every torso; the same position on all three. ArmSocket_L: joins the left arm. Give each back as a named point: an attach point when the model is rigged, otherwise a marker with role "socket", named <model>.<socket> (Torso_Light.LegSocket), its +Y pointing out of the joint.',
    );
    expect(paras[4]).toBe('These must fit the parts already built in Kiln project "mechlegs-7" (MechLegs: Legs_Biped, Legs_Treads; sockets TorsoMount): bring one in to fit against, and tell me if a socket there has to move.');
    expect(paras[5]).toBe('At most 6,000 triangles per model; each stands on the ground (lowest point on the floor).');
    // Names and constraints only: Kiln chooses the numbers.
    expect(paras[3]).not.toMatch(/\d/);
  });

  it('states one model’s sockets and size without the family wording', () => {
    const text = renderBrief({ text: 'A tower crane.', members: [{ name: 'ScrapTowerCrane' }], sockets: [{ name: 'HookPoint', joins: 'the load the crane lifts' }], size: [14, 80, 14], tris: 12000 });
    expect(text).toContain('Size: about 14 wide × 80 tall × 14 deep (studs).');
    expect(text).toContain('Sockets on the model (you choose where they go; I read the positions back): HookPoint: joins the load the crane lifts. Give each back as a named point: an attach point when the model is rigged, otherwise a marker with role "socket", its +Y pointing out of the joint.');
    expect(text).toContain('At most 12,000 triangles in all.');
    expect(text).not.toMatch(/One project/);
  });

  it('adds Kiln 0.8.2’s chat mode only for a Kiln that has it', () => {
    expect(briefBody({ text: 'A crate.' }, false)).toEqual({ text: 'A crate.' });
    expect(briefBody({ text: 'A crate.' }, true)).toEqual({ text: 'A crate.', mode: 'queue' });
  });
});

describe('sockets read back', () => {
  const boxes = {
    Torso_Light: { origin: [0, 0, 0] as [number, number, number], lo: [-3, -2, 0] as [number, number, number], hi: [3, 2, 5] as [number, number, number] },
    Torso_Heavy: { origin: [20, 0, 0] as [number, number, number], lo: [15, -3, 0] as [number, number, number], hi: [25, 3, 8] as [number, number, number] },
  };

  it('knows which model a name belongs to (the longest name it starts with)', () => {
    const names = ['Arm', 'Arm_Heavy', 'Torso_Light'];
    expect(memberOf('Arm_Heavy.WeaponMount', names)).toBe('Arm_Heavy');
    expect(memberOf('Arm.WeaponMount', names)).toBe('Arm');
    expect(memberOf('Arm_Plate', names)).toBe('Arm');
    expect(memberOf('Armour', names)).toBeNull();
    expect(memberOf('Torso_Light', names)).toBe('Torso_Light');
  });

  it('puts each marker in its own model’s space: Roblox axes, from the model’s pivot', () => {
    const markers: MarkerIn[] = [
      { name: 'Torso_Light.LegSocket', role: 'socket', matrix: at(0, 0, 0) },
      { name: 'Torso_Light.ArmSocket_L', role: 'socket', matrix: at(3, 0.5, 4) },
      // The same socket on the heavy torso, 20 units along in the scene.
      { name: 'Torso_Heavy.LegSocket', role: 'socket', matrix: at(20, 0, 0) },
      { name: 'Torso_Heavy.ArmSocket_L.001', role: 'socket', matrix: at(24.5, 0.5, 6) },
    ];
    const s = readSockets(markers, boxes, ['LegSocket', 'ArmSocket_L']);
    // Blender (x, y, z) from the pivot becomes Roblox (-x, z, y).
    expect(s.Torso_Light!.LegSocket!.position).toEqual([0, 0, 0]);
    expect(s.Torso_Light!.ArmSocket_L!.position).toEqual([-3, 4, 0.5]);
    expect(s.Torso_Heavy!.LegSocket!.position).toEqual([0, 0, 0]);
    expect(s.Torso_Heavy!.ArmSocket_L!.position).toEqual([-4.5, 6, 0.5]);
    expect(s.Torso_Light!.LegSocket!.from).toBe('marker');
    // The same place on both, or not: what "the same position on all three" comes back as.
    const members = { a: { size: [1, 1, 1] as [number, number, number], tris: 1, parts: 1, sockets: s.Torso_Light! }, b: { size: [1, 1, 1] as [number, number, number], tris: 1, parts: 1, sockets: s.Torso_Heavy! } };
    expect(socketSpread(members, 'LegSocket')).toBe(0);
    expect(socketSpread(members, 'ArmSocket_L')).toBeCloseTo(Math.hypot(1.5, 2), 3);
    expect(socketSpread(members, 'Nope')).toBeNull();
  });

  it('finds the model of a marker that isn’t named after one: the model it hangs on, else the box that holds it', () => {
    const s = readSockets(
      [
        { name: 'LegSocket', role: 'socket', matrix: at(20, 0, 0), member: 'Torso_Heavy' },
        { name: 'legsocket.001', role: 'socket', matrix: at(1, 0, 0.2) },
        // In meters: 3.5714 studs per unit.
      ],
      boxes,
      ['LegSocket'],
    );
    expect(s.Torso_Heavy!.LegSocket!.position).toEqual([0, 0, 0]);
    expect(s.Torso_Light!.LegSocket!.position).toEqual([-1, 0.2, 0]);
  });

  it('takes a map’s other markers for sockets only when they are named like one, and scales scene units to studs', () => {
    const s = readSockets(
      [
        { name: 'Spawn_1', role: 'spawn', matrix: at(1, 1, 0) },
        { name: 'Torso_Light.Cockpit', role: 'socket', matrix: at(0, -1, 3) },
        { name: 'Torso_Light.LegSocket', role: 'marker', matrix: at(0, 0, 1) },
      ],
      { Torso_Light: boxes.Torso_Light },
      ['LegSocket'],
      2,
    );
    expect(Object.keys(s.Torso_Light!).sort()).toEqual(['Cockpit', 'LegSocket']);
    expect(s.Torso_Light!.LegSocket!.position).toEqual([0, 2, 0]);
    expect(s.Torso_Light!.Cockpit!.position).toEqual([0, 6, -2]);
  });

  it('says what a build still owes the game, and writes the spec section and the data module from what was read', () => {
    const rec: FamilyRecord = {
      family: 'MechTorsos',
      projectId: 'mechtorsos-1',
      members: [{ name: 'Torso_Light', size: [6, 5, 4] }, { name: 'Torso_Heavy' }, { name: 'Torso_Medium' }],
      fits: [],
      sockets: [{ name: 'LegSocket', joins: 'the top centre of every leg set.', where: 'bottom centre of every torso' }, { name: 'ArmSocket_L', joins: 'the left arm' }],
      tris: 6000,
      read: {
        at: '2026-10-01T00:00:00.000Z',
        members: {
          Torso_Light: { size: [6.2, 5.1, 4], tris: 4200, parts: 3, sockets: { LegSocket: { position: [0, 0, 0], rotation: [0, 0, 0], from: 'marker' }, ArmSocket_L: { position: [-3, 4, 0.5], rotation: [0, 90, 0], from: 'marker' } } },
          Torso_Heavy: { size: [20, 8, 6], tris: 9100, parts: 4, sockets: { LegSocket: { position: [0, 0, 0], rotation: [0, 0, 0], from: 'marker' } } },
        },
        missing: ['Torso_Medium'],
      },
    };
    expect(familyProblems(rec)).toEqual([
      "Not found as its own top-level object in Kiln's scene: Torso_Medium.",
      'Torso_Heavy has no ArmSocket_L socket to read back.',
      'Torso_Heavy has 9,100 triangles, over the budget of 6,000.',
    ]);
    const spec = socketsSpec([rec]);
    expect(spec).toMatch(/^Read back from Kiln's builds, not typed by anyone/);
    expect(spec).toContain('### MechTorsos');
    expect(spec).toContain('- LegSocket: joins the top centre of every leg set (bottom centre of every torso); the same position on every model.');
    expect(spec).toContain('- Torso_Light: 6.2 × 5.1 × 4 studs, 4,200 triangles; LegSocket (0, 0, 0), ArmSocket_L (-3, 4, 0.5).');
    expect(spec).toContain('- Open: Not found as its own top-level object');
    const lua = socketsLuau([rec]);
    expect(lua).toContain('\tTorso_Light = {');
    expect(lua).toContain('\t\tsize = Vector3.new(6.2, 5.1, 4),');
    expect(lua).toContain('\t\t\tArmSocket_L = CFrame.new(-3, 4, 0.5) * CFrame.fromOrientation(math.rad(0), math.rad(90), math.rad(0)),');
    // What code does with them: a socket's place in the world, and mating two models so the frames coincide.
    expect(lua).toMatch(/^--!strict\n/);
    expect(lua).toContain('function Sockets.world(instance: PVInstance, name: string, socket: string): CFrame');
    expect(lua).toContain('\tchild:PivotTo(Sockets.world(parent, parentName, parentSocket) * Sockets.frame(childName, childSocket):Inverse())');
    expect(lua.trimEnd().endsWith('return Sockets')).toBe(true);
    expect(socketsSpec([{ ...rec, read: undefined }])).toBe('');

    // Into a project: the spec section once (not again for the same text), the module next to the other generated ones.
    const root = mkdtempSync(join(tmpdir(), 'kiln-sockets-'));
    const sections: Array<{ key: string; body: string; status: string; title?: string }> = [];
    const project = {
      root,
      extras: () => ({}),
      governance: {
        spec: () => sections,
        updateSpec: (key: string, body: string, _actor: string, status: string, title?: string) => {
          const cur = sections.find((s) => s.key === key);
          if (cur) Object.assign(cur, { body, status });
          else sections.push({ key, body, status, title });
        },
      },
    } as unknown as ProjectContext;
    const first = publishSockets(project, [rec]);
    expect(first).toEqual({ spec: true, module: 'src/Shared/ShurikenSockets.luau', requirePath: 'game.ReplicatedStorage.Shared.ShurikenSockets' });
    expect(sections).toMatchObject([{ key: 'model-sockets', status: 'draft', title: 'Model sizes and sockets (read back from Kiln)' }]);
    expect(readFileSync(join(root, 'src', 'Shared', 'ShurikenSockets.luau'), 'utf8')).toBe(lua);
    expect(publishSockets(project, [rec])).toEqual({ spec: false, module: null, requirePath: 'game.ReplicatedStorage.Shared.ShurikenSockets' });
  });
});

// ---- Shuriken's side against a fake Kiln ---------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'kiln-family-'));
const root = join(tmp, 'project');
mkdirSync(root, { recursive: true });
const kiln = await fakeKiln(tmp);
/** Where each member stands in Kiln's scene (side by side along X), and the markers the scene has. */
const layout: Record<string, number> = { Torso_Light: 0, Torso_Medium: 12, Torso_Heavy: 24, Legs_Biped: 0, Legs_Treads: 14 };
let sceneMarkers: Array<{ name: string; role: string; member: string | null; matrix: number[][] }> = [];
let absent = new Set<string>();
const blenderFake = fakeBlender({
  prepared: (name) =>
    absent.has(name) || layout[name] === undefined
      ? `KILN_MEMBER ${JSON.stringify({ found: false, top: Object.keys(layout) })}`
      : `KILN_MEMBER ${JSON.stringify({ found: true, origin: [layout[name], 0, 0], lo: [layout[name]! - 3, -2, 0], hi: [layout[name]! + 3, 2, 6], objects: [name], markers: sceneMarkers })}`,
});
const published: FamilyRecord[][] = [];
const modeling = new KilnModeling(
  blenderFake.backend,
  { enabled: () => false, resourcesDir: resolve(__dirname, '..', 'resources'), runtimeFile: () => kiln.runtimeFile, bakeWaitMs: 400, onSockets: (_root, families) => void published.push(JSON.parse(JSON.stringify(families)) as FamilyRecord[]) },
  new EventBus(),
  new Logger(null, null).scope('kiln'),
);
type Handler = ToolDefinition['handler'];
const tools = new Map<string, Handler>();
registerKilnTools({ register: (def: { name: string; handler: Handler }) => void tools.set(def.name, def.handler), get: () => undefined, invoke: async () => ({ content: [] }) } as never, {
  project: () => ({ root }) as unknown as ProjectContext,
  kiln: () => modeling,
  modeling: () => blenderFake.backend,
  bus: new EventBus(),
});
const caller: CallerContext = { kind: 'agent', runId: 'run_fam', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const call = async (name: string, args: Record<string, unknown>) => {
  const out = await tools.get(name)!({ args, caller, signal: new AbortController().signal } as never);
  const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { out, text, data: out.data as Record<string, any> | undefined };
};
const chats = () => kiln.hits(/\/chat$/);
const lastChat = () => chats().at(-1)!;

const savedEnv = process.env.SHURIKEN_NO_KILN;
beforeAll(async () => {
  delete process.env.SHURIKEN_NO_KILN;
  await modeling.kiln.check(true);
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.SHURIKEN_NO_KILN;
  else process.env.SHURIKEN_NO_KILN = savedEnv;
  modeling.stop();
  await kiln.close();
});

const TORSO_SOCKETS = [
  { name: 'LegSocket', joins: 'the top centre of every leg set', where: 'bottom centre of every torso; the same position on all three' },
  { name: 'ArmSocket_L', joins: 'the left arm, at shoulder height' },
];

describe('a family of parts in one Kiln project', () => {
  it('asks Kiln once for all the torsos, and brings each in as its own model with its sockets read back', async () => {
    sceneMarkers = [
      { name: 'Torso_Light.LegSocket', role: 'socket', member: 'Torso_Light', matrix: at(0, 0, 0) },
      { name: 'Torso_Light.ArmSocket_L', role: 'socket', member: 'Torso_Light', matrix: at(3, 0, 4) },
      { name: 'Torso_Medium.LegSocket', role: 'socket', member: 'Torso_Medium', matrix: at(12, 0, 0) },
      { name: 'Torso_Medium.ArmSocket_L', role: 'socket', member: 'Torso_Medium', matrix: at(15.5, 0, 4.5) },
      { name: 'Torso_Heavy.LegSocket', role: 'socket', member: 'Torso_Heavy', matrix: at(24, 0, 0) },
    ];
    // Kiln's manifest lists the heavy torso's arm socket; the scene's own marker list (above) doesn't: both are read.
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [{ name: 'Torso_Heavy.ArmSocket_L', role: 'socket', matrix: at(28.5, 0, 6) }] });
    const r = await call('kiln_request', {
      family: 'MechTorsos',
      models: [{ name: 'Torso_Light', what: 'compact scout frame' }, 'Torso_Medium', 'Torso_Heavy'],
      text: 'The three torso frames of Scrapyard Titans; seen at 20-80 studs from behind the shoulder; silhouettes must differ clearly.',
      sockets: TORSO_SOCKETS,
      style: 'Industrial salvage: mismatched painted plates, rust, one amber glow.',
      tris: 6000,
      timeout_min: 1,
    });
    expect(r.out.isError).toBeFalsy();
    // ONE Kiln project, named after the family.
    const made = kiln.hits(/^\/api\/v1\/projects$/, 'POST');
    expect(made).toHaveLength(1);
    expect(made[0]!.body).toMatchObject({ title: 'MechTorsos', units: 'studs', target: 'roblox', linked: { model: 'MechTorsos', project: root } });
    const text = String(lastChat().body.text);
    expect(lastChat().body).toMatchObject({ from: 'shuriken', kind: 'new' });
    expect(lastChat().body).not.toHaveProperty('mode');
    expect(text).toMatch(/^The three torso frames of Scrapyard Titans/);
    expect(text).toContain('The look every model of this game shares: Industrial salvage: mismatched painted plates, rust, one amber glow.');
    expect(text).toContain('One project, 3 separate models: Torso_Light (compact scout frame), Torso_Medium, Torso_Heavy. Each is its own top-level object with exactly that name');
    expect(text).toContain('LegSocket: joins the top centre of every leg set; bottom centre of every torso; the same position on all three.');
    expect(text).toContain('named <model>.<socket> (Torso_Light.LegSocket)');
    expect(text).toContain('At most 6,000 triangles per model.');
    // One bake, then each member exported from a copy that holds only its objects.
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(1);
    expect(blenderFake.exported.map((e) => e.name)).toEqual(['Torso_Light', 'Torso_Medium', 'Torso_Heavy']);
    for (const e of blenderFake.exported) {
      expect(e.blend).toBe(kiln.bakedBlend);
      expect(e.prepare).toContain(`_want = "${e.name}"`);
      expect(e.prepare).toContain('_names = ["Torso_Light","Torso_Medium","Torso_Heavy"]');
    }
    // Each is a model of the game, and Kiln's own: its link names the family's project.
    const store = new ModelStore(root);
    for (const name of ['Torso_Light', 'Torso_Medium', 'Torso_Heavy']) {
      expect(store.get(name), name).toBeTruthy();
      expect(JSON.parse(readFileSync(join(root, '.shuriken', 'kiln', `${name}.json`), 'utf8'))).toMatchObject({ projectId: made[0] ? [...kiln.projects.keys()][0] : '', family: 'MechTorsos' });
      expect(modeling.kilnOwns(root, name)).toBe(true);
    }
    expect(store.get('MechTorsos')).toBeFalsy();
    // What came back: sizes, and the sockets in each model's own space (Roblox axes from its pivot).
    const imp = r.data!.imported;
    expect(imp).toMatchObject({ ok: true, family: 'MechTorsos', parts: 3 });
    expect(imp.models.Torso_Light.sockets).toEqual({ LegSocket: [0, 0, 0], ArmSocket_L: [-3, 4, 0] });
    expect(imp.models.Torso_Medium.sockets).toEqual({ LegSocket: [0, 0, 0], ArmSocket_L: [-3.5, 4.5, 0] });
    expect(imp.models.Torso_Heavy.sockets).toEqual({ LegSocket: [0, 0, 0], ArmSocket_L: [-4.5, 6, 0] });
    expect(imp.socketSpread).toEqual({ LegSocket: 0, ArmSocket_L: expect.any(Number) });
    expect(imp).not.toHaveProperty('problems');
    expect(imp.next).toMatch(/spec section "Model sizes and sockets \(read back from Kiln\)" and in the ShurikenSockets module/);
    // The record keeps the brief as data, and the hook was told (core writes the spec and the module).
    const rec = readFamily(root, 'MechTorsos')!;
    expect(rec).toMatchObject({ family: 'MechTorsos', fits: [], tris: 6000, sockets: TORSO_SOCKETS });
    expect(rec.members.map((m) => m.name)).toEqual(['Torso_Light', 'Torso_Medium', 'Torso_Heavy']);
    expect(Object.keys(rec.read!.members)).toEqual(['Torso_Light', 'Torso_Medium', 'Torso_Heavy']);
    expect(published.at(-1)!.map((f) => f.family)).toEqual(['MechTorsos']);
    expect(readStyle(root)).toBe('Industrial salvage: mismatched painted plates, rust, one amber glow.');
    // The family's scene came home for a lost Kiln project.
    expect(existsSync(join(root, 'models', 'MechTorsos.blend'))).toBe(true);
  }, 30_000);

  it('names the earlier project in a later family’s brief so Kiln can fit against it', async () => {
    blenderFake.exported.length = 0;
    sceneMarkers = [];
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [{ name: 'Legs_Biped.TorsoMount', role: 'socket', matrix: at(0, 0, 8) }, { name: 'Legs_Treads.TorsoMount', role: 'socket', matrix: at(14, 0, 4.5) }] });
    const torsos = readFamily(root, 'MechTorsos')!.projectId;
    const r = await call('kiln_request', {
      family: 'MechLegs',
      models: ['Legs_Biped', 'Legs_Treads'],
      fits: ['MechTorsos'],
      text: 'The leg units of Scrapyard Titans.',
      sockets: [{ name: 'TorsoMount', joins: "a torso's LegSocket", where: 'top centre of every leg set' }],
      timeout_min: 1,
    });
    expect(r.out.isError).toBeFalsy();
    const text = String(lastChat().body.text);
    expect(text).toContain(`These must fit the parts already built in Kiln project "${torsos}" (MechTorsos: Torso_Light, Torso_Medium, Torso_Heavy; sockets LegSocket, ArmSocket_L): bring one in to fit against, and tell me if a socket there has to move.`);
    // The style set with the first family goes with every new build.
    expect(text).toContain('The look every model of this game shares: Industrial salvage');
    expect(lastChat().path).not.toContain(torsos);
    expect(r.data!.imported.models.Legs_Biped.sockets).toEqual({ TorsoMount: [0, 8, 0] });
    expect(r.data!.imported.models.Legs_Treads.sockets).toEqual({ TorsoMount: [0, 4.5, 0] });
    expect(readFamily(root, 'MechLegs')).toMatchObject({ fits: ['MechTorsos'] });
    // A member's name works as well as the family's: it is the same project.
    const again = await call('kiln_request', { family: 'MechLegs', kind: 'rework', fits: ['Torso_Heavy'], text: 'Chunkier feet.', wait: false });
    expect(again.out.isError).toBeFalsy();
    expect(String(lastChat().body.text)).toContain(`Kiln project "${torsos}" (MechTorsos:`);
    kiln.finish(kiln.running().at(-1)!.turnId);
    // The build carries on by itself (Shuriken's queue): let it bring its result in before the next test counts exports.
    await call('kiln_builds', {});
  }, 30_000);

  it('refuses a family fitted against something that isn’t built, a family of one, and a name used twice', async () => {
    const before = chats().length;
    const unbuilt = await call('kiln_request', { family: 'MechArms', models: ['Arms_Light', 'Arms_Heavy'], fits: ['MechWeapons'], text: 'Arms.' });
    expect(unbuilt.out.isError).toBe(true);
    expect(unbuilt.text).toMatch(/fits: MechWeapons has no Kiln project yet\. It has to be built first .* a family that is fitted against another one is built after it\./);
    const one = await call('kiln_request', { family: 'MechArms', models: ['Arms_Light'], text: 'Arms.' });
    expect(one.text).toMatch(/A family is two or more models built in one Kiln project/);
    const both = await call('kiln_request', { family: 'MechArms', model: 'Arms_Light', models: ['Arms_Light', 'Arms_Heavy'], text: 'Arms.' });
    expect(both.text).toMatch(/Give family \(with models\) or model, not both/);
    const stolen = await call('kiln_request', { family: 'MechArms', models: ['Arms_Light', 'Torso_Heavy'], text: 'Arms.' });
    expect(stolen.text).toMatch(/Torso_Heavy already belongs to the family MechTorsos/);
    const alone = await call('kiln_request', { model: 'Crate', models: ['Crate', 'Barrel'], text: 'x' });
    expect(alone.text).toMatch(/models goes with family/);
    expect(chats()).toHaveLength(before);
    expect(readFamily(root, 'MechArms')).toBeNull();
  });

  it('sends a fix for one member to the family’s project as written, and brings every member in again', async () => {
    blenderFake.exported.length = 0;
    sceneMarkers = [];
    const torsos = readFamily(root, 'MechTorsos')!.projectId;
    const r = await call('kiln_request', { model: 'Torso_Heavy', kind: 'fix', text: 'The heavy torso is 10.6 studs wide: the heavy arms clip into its shoulder plates.', timeout_min: 1 });
    expect(r.out.isError).toBeFalsy();
    expect(lastChat().path).toBe(`/api/v1/projects/${torsos}/chat`);
    expect(lastChat().body).toEqual({ text: 'The heavy torso is 10.6 studs wide: the heavy arms clip into its shoulder plates.', from: 'shuriken', kind: 'fix', effort: 'low' });
    expect(blenderFake.exported.map((e) => e.name)).toEqual(['Torso_Light', 'Torso_Medium', 'Torso_Heavy']);
    expect(r.data!.imported.family).toBe('MechTorsos');
  }, 30_000);

  it('reports a member Kiln did not build as its own object, and what else the build owes, as lines for a fix', async () => {
    blenderFake.exported.length = 0;
    absent = new Set(['Torso_Medium']);
    sceneMarkers = [{ name: 'Torso_Light.LegSocket', role: 'socket', member: 'Torso_Light', matrix: at(0, 0, 0) }];
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [] });
    const r = await call('kiln_request', { family: 'MechTorsos', kind: 'rework', text: 'Sharper silhouettes.', timeout_min: 1 });
    absent = new Set();
    expect(r.out.isError).toBeFalsy();
    const imp = r.data!.imported;
    expect(imp.missing).toEqual(['Torso_Medium']);
    expect(imp.problems).toEqual([
      "Not found as its own top-level object in Kiln's scene: Torso_Medium.",
      'Torso_Light has no ArmSocket_L socket to read back.',
      'Torso_Heavy has no LegSocket, ArmSocket_L sockets to read back.',
    ]);
    expect(imp.next).toMatch(/send them back as one request, kiln_request \{family: "MechTorsos", kind: "fix", text: the problems\}/);
    // A rework states the whole of what the game needs again: the members, the sockets, the style, the budget.
    const text = String(lastChat().body.text);
    expect(text).toContain('One project, 3 separate models');
    expect(text).toContain('Sockets on every one of these models');
    expect(text).toContain('At most 6,000 triangles per model.');
  }, 30_000);

  it('reads one model’s sockets back too (a family of one), from the manifest’s markers', async () => {
    kiln.manifest = () => ({ version: 2, blend: kiln.bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [{ name: 'HookPoint', role: 'socket', matrix: at(2, -1, 60) }, { name: 'Spawn', role: 'spawn', matrix: at(0, 0, 0) }] });
    const r = await call('kiln_request', { model: 'ScrapTowerCrane', text: 'A lattice tower crane, the arena’s landmark.', sockets: [{ name: 'HookPoint', joins: 'the load the crane lifts' }], size: [14, 80, 14], grounded: true, timeout_min: 1 });
    expect(r.out.isError).toBeFalsy();
    const text = String(lastChat().body.text);
    expect(text).toContain('Size: about 14 wide × 80 tall × 14 deep (studs).');
    expect(text).toContain('Sockets on the model');
    expect(text).not.toContain('<model>.<socket>');
    expect(text).toContain('It stands on the ground (lowest point on the floor).');
    expect(r.data!.imported).toMatchObject({ ok: true, model: 'ScrapTowerCrane', sockets: { HookPoint: [-2, 60, -1] } });
    expect(readFamily(root, 'ScrapTowerCrane')!.read!.members.ScrapTowerCrane!.sockets.HookPoint).toMatchObject({ position: [-2, 60, -1], from: 'marker' });
    // A plain model has no record and no socket lines.
    const plain = await call('kiln_request', { model: 'OilBarrel', text: 'A dented oil barrel.', timeout_min: 1 });
    expect(plain.data!.imported).not.toHaveProperty('sockets');
    expect(readFamily(root, 'OilBarrel')).toBeNull();
    const status = await call('kiln_status', {});
    expect(status.data!.families).toEqual([
      { family: 'MechLegs', kilnProject: expect.any(String), models: ['Legs_Biped', 'Legs_Treads'], sockets: ['TorsoMount'], fits: ['MechTorsos'], built: true },
      { family: 'MechTorsos', kilnProject: expect.any(String), models: ['Torso_Light', 'Torso_Medium', 'Torso_Heavy'], sockets: ['LegSocket', 'ArmSocket_L'], fits: [], built: true },
    ]);
  }, 30_000);

  it('sends Kiln 0.8.2 the chat mode that queues a brief behind a busy project', async () => {
    kiln.version = '0.8.2';
    await modeling.kiln.check(true);
    await call('kiln_request', { model: 'OilBarrel', kind: 'fix', text: 'Rustier.', wait: false });
    // And the game's style sheet by its id, on every brief (see tests/kiln-082.test.ts for the rest of that contract).
    expect(lastChat().body).toEqual({ text: 'Rustier.', mode: 'queue', style: styleId(root), from: 'shuriken', kind: 'fix', effort: 'low' });
    kiln.version = '0.8.1';
    await modeling.kiln.check(true);
  });
});

describe('what the planner and the modeler are told about parts that fit together', () => {
  const squash = (t: string) => t.replace(/\s+/g, ' ');
  it('has the planner plan model tasks by family, say what each is fitted against, and keep socket numbers out of objectives', () => {
    const t = squash(ROLES.executive!.instructions);
    expect(t).toMatch(/planned by FAMILY, never one task per part: one modeler task per family, built in ONE Kiln project/);
    expect(t).toMatch(/each named model is still its own model in the game/);
    expect(t).toMatch(/names the sockets as names and constraints, never coordinates/);
    expect(t).toMatch(/says which family it is fitted against \("fits MechTorsos"\); that family's task is its only dependsOn/);
    expect(t).toMatch(/spec section "Model sizes and sockets" and the generated ShurikenSockets module/);
    expect(t).toMatch(/no objective carries socket numbers/);
    expect(t).toMatch(/the same style line in every model task/);
  });

  it('has the modeler ask for a family in one request and read sizes and sockets back instead of typing them', () => {
    const t = squash(ROLES.modeler!.instructions);
    expect(t).toMatch(/kiln_request \{family: "MechTorsos", models: \["Torso_Light", "Torso_Medium", "Torso_Heavy"\], sockets: \[\{name: "LegSocket"/);
    expect(t).toMatch(/fits: \[the families built before that it must fit\]/);
    expect(t).toMatch(/Sockets are names and constraints, never coordinates: Kiln places them/);
    expect(t).toMatch(/each model's size and socket positions, which are also in the spec section "Model sizes and sockets" and the ShurikenSockets module the game code uses: never type them yourself/);
  });
});

// ---- The scene surgery, in the real Blender --------------------------------------------------------------------------------

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

const SCENE = `
import bpy
def box(name, at, size, parent=None, mat=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    o = bpy.context.object
    o.name = name
    o.scale = size
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
    if mat:
        o.data.materials.append(kiln.mat(mat, base="#886644"))
    return o
def empty(name, at, parent=None, role=None):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.location = at
    if parent is not None:
        e.parent = parent
        e.matrix_parent_inverse = parent.matrix_world.inverted()
    if role:
        e["kiln_role"] = role
    return e
# Three ways a copilot may group a variant: under a top-level empty, in a collection, and by its objects' names.
light = empty("Torso_Light", (0, 0, 0))
bpy.context.view_layer.update()
box("Hull", (0, 0, 2.5), (6, 4, 5), light, "Paint")
box("Cockpit", (0, -2, 4), (2, 1, 1), light, "Glass")
empty("Torso_Light.LegSocket", (0, 0, 0), light, "socket")
empty("Torso_Light.ArmSocket_L", (3, 0, 4), light, "socket")
coll = bpy.data.collections.new("Torso_Medium")
bpy.context.scene.collection.children.link(coll)
m = box("MediumHull", (12, 0, 3.25), (7.5, 4, 6.5), None, "Paint")
for c in list(m.users_collection):
    c.objects.unlink(m)
coll.objects.link(m)
box("Torso_Heavy_Hull", (26, 1, 4), (9, 6, 8), None, "Paint")
box("Torso_Heavy.Fins", (26, 4.5, 6), (4, 1, 2), None, "Steel")
empty("Torso_Heavy.LegSocket", (26, 1, 0), None, "socket")
bpy.context.view_layer.update()
`;

describe.skipIf(!harness)('taking one member out of Kiln’s baked scene (real Blender)', () => {
  const names = ['Torso_Light', 'Torso_Medium', 'Torso_Heavy'];
  const one = async (member: string) => {
    await harness!.python(SCENE);
    const out = await harness!.python(memberPrepare(member, names), false);
    return { prep: parsePrepared(out)!, reply: await harness!.export(member) };
  };

  it('keeps a member grouped under a top-level object, with its pivot at the bottom centre of its box', async () => {
    const { prep, reply } = await one('Torso_Light');
    expect(prep.found).toBe(true);
    expect(prep.objects).toEqual(['Cockpit', 'Hull']);
    expect(prep.origin!.map((v) => Math.round(v * 100) / 100)).toEqual([0, -0.25, 0]);
    // Only this member's meshes were exported: one part per material, sized like the torso.
    expect(reply.parts.map((p) => p.name).sort()).toEqual(['Torso_Light_Glass', 'Torso_Light_Paint']);
    expect(reply.size.map((v) => Math.round(v * 10) / 10)).toEqual([6, 5, 4.5]);
    // The scene's markers come back with the member they hang on, for every member of the scene.
    const mk = Object.fromEntries(prep.markers!.map((m) => [m.name, m]));
    expect(mk['Torso_Light.ArmSocket_L']).toMatchObject({ role: 'socket', member: 'Torso_Light' });
    expect(mk['Torso_Heavy.LegSocket']).toMatchObject({ role: 'socket', member: 'Torso_Heavy' });
    const sockets = readSockets(prep.markers!.map((m) => ({ ...m, matrix: m.matrix as Mat4 })), { Torso_Light: { origin: prep.origin!, lo: prep.lo!, hi: prep.hi! } }, ['LegSocket', 'ArmSocket_L']);
    // From the pivot (0, -0.25, 0): Blender (3, 0.25, 4) is Roblox (-3, 4, 0.25).
    expect(sockets.Torso_Light!.ArmSocket_L!.position).toEqual([-3, 4, 0.25]);
    expect(sockets.Torso_Light!.LegSocket!.position).toEqual([0, 0, 0.25]);
  }, 120_000);

  it('keeps a member that is a collection, and one that is only named after the member, moved to the origin', async () => {
    const medium = await one('Torso_Medium');
    expect(medium.prep.objects).toEqual(['MediumHull']);
    expect(medium.prep.origin!.map((v) => Math.round(v * 100) / 100)).toEqual([12, 0, 0]);
    expect(medium.reply.parts).toHaveLength(1);
    // Its part sits at the model's pivot now, not 12 studs away where it stood in the family's scene.
    expect(medium.reply.size.map((v) => Math.round(v * 10) / 10)).toEqual([7.5, 6.5, 4]);
    const heavy = await one('Torso_Heavy');
    expect(heavy.prep.objects).toEqual(['Torso_Heavy.Fins', 'Torso_Heavy_Hull']);
    expect(heavy.reply.parts.map((p) => p.name).sort()).toEqual(['Torso_Heavy_Paint', 'Torso_Heavy_Steel']);
    expect(Math.round(heavy.prep.origin![2]! * 100) / 100).toBe(0);
  }, 180_000);

  it('exports nothing for a member that isn’t in the scene', async () => {
    await harness!.python(SCENE);
    await expect(harness!.python(memberPrepare('Torso_Titan', [...names, 'Torso_Titan']), false)).rejects.toThrow(/KILN_MEMBER_MISSING: no object named Torso_Titan/);
  }, 120_000);
});
