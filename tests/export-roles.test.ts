import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../src/core/core';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import { ModelStore, type ModelMeta } from '../src/core/modeling/model-store';
import { HULL_MIN_FILL, SHADOW_MIN_STUDS, fidelityOf, fxTable, partFx, type TraitSource } from '../src/core/modeling/part-traits';
import type { CallerContext } from '../src/core/capabilities/tool-registry';
import { FakeProvider } from './helpers/fake-provider';
import { makeGlb } from './helpers/glb';
import { ExportHarness, blender } from './helpers/blender-export';

// Collision roles. A Kiln map's collision was undrivable: asphalt up to 2 studs off, grass hulls 9.7 studs above the road,
// so another task built 1,616 invisible road boxes by hand. An object's custom property kiln_role (drivable | ground |
// barrier | decor | collider; guessed from names and materials when absent) is carried per part, parts of different roles
// are never merged (the road is its own part, never merged with leaves), and the generated Luau sets collision from it.

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

const agent: CallerContext = { kind: 'agent', runId: 'run_roles', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

async function makeCore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
  const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
  cores.push(core);
  const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
  const ctx = core.openProject(core.createProject({ name: 'Roles', rootPath: root }).id);
  ctx.updateExtras({ syncMode: 'none' });
  core.orchestrator.pause();
  return { core, root };
}

function savePart(root: string, name: string, over: Partial<ModelMeta> = {}): ModelMeta {
  const store = new ModelStore(root);
  const meta = store.save({ name, hash: `h-${name}`, size: [4, 1, 2], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', ...over });
  writeFileSync(store.paths(name).glb, makeGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2] }));
  writeFileSync(store.paths(name).mesh, JSON.stringify({ v: [0, 0, 0, 1, 0, 0, 0, 0, 1], n: [0, 1, 0, 0, 1, 0, 0, 1, 0], t: [0, 1, 2] }));
  return meta;
}

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

describe.skipIf(!blender)('Roblox export: collision roles', () => {
  const SCENE = `
import bmesh
kiln.clear()
def cube(name, loc, scale, mat, **props):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    o = kiln.mesh_object(name, bm); o.location = loc; o.scale = scale
    if mat:
        kiln.paint(o, mat)
    for k, v in props.items():
        o[k] = v
    return o
dark = kiln.mat("Dark", base="#222222")      # one material for a road, a rail and a trunk: three roles, three parts
leafm = kiln.mat("LeafGreen", base="#22aa22")
cube("RoadSection", (0, 0, 0.25), (40, 8, 0.5), dark)                      # drivable: guessed from the name
cube("GuardRail", (0, 5, 1), (40, 0.4, 1), dark)                           # barrier: guessed, and exactly a box
cube("Tree", (10, 10, 2), (1, 1, 4), dark)                                 # no role
cube("Crown", (10, 10, 6), (4, 4, 3), leafm)                               # decor: guessed from its material (LeafGreen)
cube("Hill", (30, 0, 1), (20, 20, 2), kiln.mat("Plain", base="#444444"), kiln_role="ground")      # explicit
cube("Boulder", (-30, 0, 1), (4, 4, 4), kiln.mat("Stone", base="#777777"), kiln_role="decor")     # explicit beats everything
cube("Wall", (-30, 20, 1), (4, 4, 4), kiln.mat("Brick", base="#774433"), kiln_role="bogus")      # an unknown word is no role: guessed (wall)
cube("RoadCollider", (0, 0, 0.25), (40, 8, 0.5), None, kiln_role="collider", kiln_collides_for="RoadSection")
`;

  it('carries the role per part, never merges roles, and keeps explicit properties over guesses', async () => {
    await harness!.python(SCENE);
    const r = await harness!.export('Map');
    const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
    const dark = r.parts.filter((p) => p.blender_material === 'Dark');
    expect(dark).toHaveLength(3); // road (replaced), rail, trunk; the collider has no material and is a part of its own
    const road = r.parts.find((p) => p.role === 'drivable')!;
    expect(road).toMatchObject({ roleInferred: true, replaced: true, blender_material: 'Dark' });
    const rail = r.parts.find((p) => p.role === 'barrier' && p.blender_material === 'Dark')!;
    expect(rail).toMatchObject({ roleInferred: true, box: true });
    const trunk = r.parts.find((p) => p.blender_material === 'Dark' && !p.role)!;
    expect(trunk).toBeTruthy();
    expect(trunk.replaced).toBeUndefined();
    // decor guessed from the material name; the explicit ones are not "inferred"
    expect(r.parts.find((p) => p.blender_material === 'LeafGreen')).toMatchObject({ role: 'decor', roleInferred: true });
    expect(r.parts.find((p) => p.blender_material === 'Plain')).toMatchObject({ role: 'ground' });
    expect(r.parts.find((p) => p.blender_material === 'Plain')!.roleInferred).toBeUndefined();
    expect(r.parts.find((p) => p.blender_material === 'Stone')).toMatchObject({ role: 'decor' });
    expect(r.parts.find((p) => p.blender_material === 'Brick')).toMatchObject({ role: 'barrier', roleInferred: true });
    // every part holds one role; the part names tell the variants of one material apart
    expect(new Set(r.parts.map((p) => p.name)).size).toBe(r.parts.length);
    expect(Object.keys(byName).some((n) => /Dark_Barrier$/.test(n))).toBe(true);
    // the collider: invisible, no material look, no texture, a box
    const collider = r.parts.find((p) => p.role === 'collider')!;
    expect(collider).toMatchObject({ transparency: 1, box: true });
    expect(collider.textures).toBeUndefined();
    expect(collider.size.map((v) => Math.round(v))).toEqual([40, 1, 8]); // Roblox axes: x, y up, z
    // guessed roles are said once, with the way to say otherwise
    const note = (r.notes ?? []).find((n) => n.startsWith('Collision roles guessed from names'))!;
    expect(note).toMatch(/GuardRail -> barrier/);
    expect(note).toMatch(/RoadSection -> drivable/);
    expect(note).toMatch(/Crown -> decor/);
    expect(note).not.toMatch(/Hill/); // explicit
    expect(note).toMatch(/kiln_role/);
  }, 120_000);

  it('reads a role from the mesh data too, a list of targets for a collider, and ignores roles on a rigged model', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
def cube(name, loc, scale, mat, **props):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    o = kiln.mesh_object(name, bm); o.location = loc; o.scale = scale
    if mat:
        kiln.paint(o, mat)
    for k, v in props.items():
        o[k] = v
    return o
m = kiln.mat("Gray", base="#555555")
a = cube("Slab1", (0, 0, 0.5), (10, 10, 1), m)
a.data["kiln_role"] = "drivable"          # on the mesh data
cube("Slab2", (20, 0, 0.5), (10, 10, 1), m)
cube("Slab3", (40, 0, 0.5), (10, 10, 1), m)
cube("Col", (20, 0, 0.5), (50, 10, 1), None, kiln_collides_for='["Slab2", "Slab3"]')   # a collider by kiln_collides_for alone, a JSON list
`);
    const r = await harness!.export('Lists');
    expect(r.parts.find((p) => p.role === 'drivable')).toBeTruthy();
    const replaced = r.parts.filter((p) => p.replaced);
    expect(replaced).toHaveLength(1); // Slab2 and Slab3 share material and role: one part
    expect(replaced[0]!.triangles).toBe(24);
    expect(r.parts.find((p) => p.role === 'collider')).toBeTruthy();
  }, 120_000);

  it('a model with no roles at all comes out exactly as before (one part per material, no role fields)', async () => {
    await harness!.python(`
kiln.clear()
m = kiln.mat("Crate", base="#9a6b3f", roughness=0.8)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=3.5)
c = kiln.mesh_object("Crate", bm); c.location = (0, 0, 1.75); kiln.paint(c, m)
`);
    const r = await harness!.export('Crate');
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.name).toBe('Crate');
    for (const k of ['role', 'roleInferred', 'replaced', 'box', 'fill']) expect(r.parts[0], k).not.toHaveProperty(k);
    expect((r.notes ?? []).filter((n) => /Collision roles/.test(n))).toEqual([]);
  }, 120_000);

  it('records the fill of a closed barrier (a chunky one collides as a hull, a thin curved one precisely)', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
m = kiln.mat("Concrete", base="#999999")
# a wedge: closed, fills about half its box
bm = bmesh.new()
vs = [bm.verts.new(p) for p in [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0), (-1, -1, 1), (1, -1, 1)]]
bm.faces.new([vs[0], vs[3], vs[2], vs[1]])
bm.faces.new([vs[0], vs[1], vs[5], vs[4]])
bm.faces.new([vs[3], vs[4], vs[5], vs[2]])
bm.faces.new([vs[0], vs[4], vs[3]])
bm.faces.new([vs[1], vs[2], vs[5]])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
w = kiln.mesh_object("Wedge", bm); w.location = (0, 0, 0); w["kiln_role"] = "barrier"; kiln.paint(w, m)
`);
    const r = await harness!.export('Wedge');
    const p = r.parts[0]!;
    expect(p.role).toBe('barrier');
    expect(p.box).toBeUndefined();
    expect(p.fill).toBeCloseTo(0.5, 1);
  }, 120_000);
});

describe('collision traits', () => {
  const sizes = { small: [2, 2, 2] as [number, number, number], big: [SHADOW_MIN_STUDS + 2, 6, 6] as [number, number, number] };

  it('decor collides with nothing and can not be hit; only big decor casts a shadow', () => {
    expect(fxTable(partFx({ role: 'decor', size: sizes.small }))).toBe('{cc=false,cq=false,ct=false,sh=false}');
    expect(fxTable(partFx({ role: 'decor', size: sizes.big }))).toBe('{cc=false,cq=false,ct=false,sh=true}');
    expect(fxTable(partFx({ role: 'decor', size: sizes.small, fill: 1, box: true }))).not.toContain('fid'); // nothing to collide with, so no fidelity
  });

  it('drivable and ground surfaces collide exactly (precise convex decomposition), not with Roblox\'s default hull', () => {
    for (const role of ['drivable', 'ground'] as const) expect(fxTable(partFx({ role }))).toBe('{cc=true,cq=true,fid="PreciseConvexDecomposition"}');
    expect(fidelityOf({ role: 'drivable', box: true })).toBe('PreciseConvexDecomposition'); // even a box-shaped road piece
  });

  it('a barrier collides as a box when it is one, as a hull when it fills its box, else precisely', () => {
    expect(fxTable(partFx({ role: 'barrier', box: true }))).toBe('{cc=true,cq=true,fid="Box"}');
    expect(fidelityOf({ role: 'barrier', fill: HULL_MIN_FILL })).toBe('Hull');
    expect(fidelityOf({ role: 'barrier', fill: 0.4 })).toBe('PreciseConvexDecomposition'); // a curved rail's hull would close off the road
    expect(fidelityOf({ role: 'barrier' })).toBe('PreciseConvexDecomposition'); // an open mesh has no volume
  });

  it('a collider is invisible collision geometry; the visuals it replaces collide with nothing', () => {
    expect(fxTable(partFx({ role: 'collider', box: true, transparency: 1 }))).toBe('{cc=true,cq=true,ct=true,sh=false,fid="Box",tr=1}');
    expect(fxTable(partFx({ role: 'collider' }))).toBe('{cc=true,cq=true,ct=true,sh=false,fid="PreciseConvexDecomposition",tr=1}');
    expect(fxTable(partFx({ role: 'drivable', replaced: true }))).toBe('{cc=false,cq=false,ct=false}');
    expect(fxTable(partFx({ replaced: true }))).toBe('{cc=false,cq=false,ct=false}');
  });

  it('keeps Roblox defaults for a part with no role, and applies a part\'s transparency and double-sidedness', () => {
    expect(partFx({})).toBeNull();
    expect(partFx({ size: [1, 1, 1] })).toBeNull();
    expect(fxTable(partFx({ transparency: 0.4 }))).toBe('{tr=0.4}');
    expect(fxTable(partFx({ role: 'ground', doubleSided: true }))).toBe('{cc=true,cq=true,fid="PreciseConvexDecomposition",ds=true}');
  });
});

describe('the builders set collision from the role', () => {
  const upload = (n: string, id: string) => ({ assetId: id, hash: `h-${n}`, at: 'now', facing: 2 });

  it('world/Models.luau and model_place carry each part\'s traits; every program parses', async () => {
    const { core, root } = await makeCore();
    const parts: Array<[string, Partial<ModelMeta>, string]> = [
      ['Map_Road', { role: 'drivable', replaced: true, size: [40, 1, 8], origin: [0, 0.5, 0] }, 'cc=false,cq=false,ct=false'],
      ['Map_Collider', { role: 'collider', box: true, transparency: 1, size: [40, 1, 8], origin: [0, 0.5, 0] }, 'cc=true,cq=true,ct=true,sh=false,fid="Box",tr=1'],
      ['Map_Rail', { role: 'barrier', box: true, size: [40, 1, 0.4], origin: [0, 1, 5] }, 'cc=true,cq=true,fid="Box"'],
      ['Map_Crown', { role: 'decor', size: [4, 3, 4], origin: [10, 6, 10] }, 'cc=false,cq=false,ct=false,sh=false'],
      ['Map_Hill', { role: 'ground', size: [20, 2, 20], origin: [30, 1, 0] }, 'cc=true,cq=true,fid="PreciseConvexDecomposition"'],
    ];
    let id = 100;
    for (const [name, over] of parts) savePart(root, name, { assembly: 'Map', upload: upload(name, String(id++)), ...over });
    const store = new ModelStore(root);
    store.writeBuilder(); // no placements yet: nothing to build
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const luau: string[] = [];
    studio.runLuau = async (code: string) => {
      luau.push(code);
      const info: Record<string, { pos: number[]; rot: number[] }> = {};
      for (const [n] of parts) info[n] = { pos: [0, 0, 0], rot: [0, 0, 0] };
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Map', position: [0, 0, 0], rotation: [0, 0, 0], notes: [], parts: info }), durationMs: 1 };
    };
    core.prefs.set({ robloxCreatorId: '42' });
    const placed = await core.tools.invoke('model_place', { name: 'Map', position: [0, 0, 0] }, agent);
    expect(placed.isError, text(placed)).toBeFalsy();
    const program = luau.find((c) => c.includes('model:SetAttribute("ShurikenAssembly"'))!;
    for (const [name, , fx] of parts) {
      const call = program.split('\n').find((l) => l.includes(`place("${name}"`))!;
      expect(call, name).toContain(`fx={${fx}}`);
    }
    // each part is placed with its own traits, and place() applies them
    expect(program).toContain('applyFx(mp, p.fx)');
    expect(program).toContain('if fx.cc ~= nil then mp.CanCollide = fx.cc end');
    // what world/Models.luau rebuilds carries them too (its row per model)
    const builder = readFileSync(join(root, 'world', 'Models.luau'), 'utf8');
    for (const [name, , fx] of parts) expect(builder, name).toContain(`{model="${name}",`), expect(builder, name).toContain(`fx={${fx}}`);
    expect(builder).toContain('if m.fx and not p.fx then p.fx = m.fx end');
    // Everything generated parses (selene's parser, where it is installed).
    if (existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene'))) {
      const t = new LuauToolchain(tmpdir());
      expect(await t.parseErrors(program)).toEqual([]);
      expect(await t.parseErrors(builder)).toEqual([]);
    }
  });

  it('blender_python lists the roles of the parts and model_list shows them', async () => {
    if (!blender) return;
    const { core } = await makeCore();
    process.env.SHURIKEN_BLENDER = blender;
    const made = await core.tools.invoke(
      'blender_python',
      {
        model: 'Circuit',
        code: `
import bmesh
kiln.clear()
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
o = kiln.mesh_object("RoadSection", bm); o.scale = (30, 6, 0.4); kiln.paint(o, kiln.mat("Surface", base="#222222"))
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
l = kiln.mesh_object("Bush", bm); l.location = (0, 10, 1); kiln.paint(l, kiln.mat("Leaves", base="#228822"))
`,
      },
      agent,
    );
    expect(made.isError, text(made)).toBeFalsy();
    expect(text(made)).toMatch(/Circuit_Surface \(.*drivable \(guessed from its name\)\)/);
    expect(text(made)).toMatch(/Circuit_Leaves \(.*decor \(guessed from its name\)\)/);
    expect(text(made)).toMatch(/Collision roles guessed from names/);
    const listed = JSON.parse(text(await core.tools.invoke('model_list', {}, agent))) as { models: Array<{ name: string; role?: string }> };
    expect(listed.models.find((m) => m.name === 'Circuit_Surface')!.role).toBe('drivable');
  }, 180_000);
});
