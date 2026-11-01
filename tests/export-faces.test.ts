import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../src/core/core';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import { ModelStore, type ModelMeta } from '../src/core/modeling/model-store';
import { FX_FN, formatFaces, fxTable, partFx } from '../src/core/modeling/part-traits';
import type { CallerContext } from '../src/core/capabilities/tool-registry';
import { FakeProvider } from './helpers/fake-provider';
import { makeGlb } from './helpers/glb';
import { ExportHarness, blender } from './helpers/blender-export';

// Faces Roblox can't see. Roblox draws a face only from its front, so an open mesh (a sheet: leaf cards, a road strip), a
// paper-thin one, or a flat road whose faces point down vanishes when it is seen from the wrong side — a Kiln-made road came
// in with its faces down and was invisible for an hour. The export marks such parts double-sided (the builders set
// MeshPart.DoubleSided, guarded) and warns about flat meshes facing down; the check tools say so.

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

const agent: CallerContext = { kind: 'agent', runId: 'run_faces', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

async function makeCore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
  const core = await Core.create({
    dataDir,
    resourcesDir: resolve(__dirname, '..', 'resources'),
    appVersion: 'test',
    providers: [new FakeProvider({ respond: async () => null })],
    integrations: false,
    logToDisk: false,
    luau: new StubLuau(),
    render: async () => 'data:image/png;base64,AAAA',
  });
  cores.push(core);
  const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
  const ctx = core.openProject(core.createProject({ name: 'Faces', rootPath: root }).id);
  ctx.updateExtras({ syncMode: 'none' });
  core.orchestrator.pause();
  return { core, root };
}

/** A part in the model store with its mesh file and GLB on disk. */
function savePart(root: string, name: string, over: Partial<ModelMeta> = {}): ModelMeta {
  const store = new ModelStore(root);
  const meta = store.save({ name, hash: `h-${name}`, size: [4, 0.1, 2], triangles: 2, vertices: 4, volume: null, faces: 1, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', ...over });
  writeFileSync(store.paths(name).glb, makeGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2] }));
  writeFileSync(store.paths(name).mesh, JSON.stringify({ v: [0, 0, 0, 1, 0, 0, 0, 0, 1], n: [0, 1, 0, 0, 1, 0, 0, 1, 0], t: [0, 1, 2] }));
  return meta;
}

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

describe.skipIf(!blender)('Roblox export: open, thin and face-down meshes', () => {
  it('marks open sheets and paper-thin shells double-sided, leaves solids alone, and warns about a flat road facing down', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
def quad(name, x, y, z, w, d, up, mat):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in [(-w/2, -d/2, 0), (w/2, -d/2, 0), (w/2, d/2, 0), (-w/2, d/2, 0)]]
    if not up:
        vs.reverse()
    bm.faces.new(vs)
    o = kiln.mesh_object(name, bm); o.location = (x, y, z); kiln.paint(o, mat); return o
road = kiln.mat("Road", base="#333333")
leaf = kiln.mat("Leaf", base="#228822")
solid = kiln.mat("Solid", base="#885522")
quad("RoadDown", 0, 0, 0, 40, 6, False, road)       # flat, faces point down: invisible from above
quad("LeafCard", 20, 0, 3, 2, 2, True, leaf)        # an open sheet
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
c = kiln.mesh_object("Box", bm); c.location = (10, 10, 1); kiln.paint(c, solid)              # watertight
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
s = kiln.mesh_object("Slab", bm); s.scale = (10, 10, 0.02); s.location = (-20, 0, 0); kiln.paint(s, kiln.mat("Slabby", base="#999999"))   # closed but paper-thin
`);
    const r = await harness!.export('Faces');
    const by = Object.fromEntries(r.parts.map((p) => [p.blender_material, p]));
    expect(by.Solid!.doubleSided).toBeUndefined();
    expect(by.Leaf!.doubleSided).toBe(true);
    expect(by.Leaf!.facesDown).toBeUndefined(); // it faces up
    expect(by.Slabby!.doubleSided).toBe(true);
    expect(by.Road!.doubleSided).toBe(true);
    expect(by.Road!.facesDown).toEqual(['RoadDown']);
    const note = (r.notes ?? []).find((n) => n.startsWith("Faces Roblox can't see"));
    expect(note).toMatch(/'RoadDown' \(40 x 6 studs\) is flat and faces down/);
    expect(note).toMatch(/front/);
  }, 120_000);

  it('does not call a road that faces up, or a closed floor slab, a problem', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
road = kiln.mat("Road", base="#333333")
bm = bmesh.new()
vs = [bm.verts.new(p) for p in [(-20, -3, 0), (20, -3, 0), (20, 3, 0), (-20, 3, 0)]]
bm.faces.new(vs)
o = kiln.mesh_object("RoadUp", bm); kiln.paint(o, road)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
f = kiln.mesh_object("Floor", bm); f.scale = (30, 30, 0.5); f.location = (0, 20, 0.25); kiln.paint(f, kiln.mat("Slab", base="#aaaaaa"))
`);
    const r = await harness!.export('Roads');
    expect((r.notes ?? []).filter((n) => n.startsWith("Faces Roblox can't see"))).toEqual([]);
    expect(r.parts.find((p) => p.blender_material === 'Slab')!.doubleSided).toBeUndefined();
    expect(r.parts.find((p) => p.blender_material === 'Slab')!.facesDown).toBeUndefined();
    expect(r.parts.find((p) => p.blender_material === 'Road')!.facesDown).toBeUndefined();
  }, 120_000);

  it('blender_python tells the note once, blender_check and model_view list the parts again', async () => {
    const { core, root } = await makeCore();
    process.env.SHURIKEN_BLENDER = blender!;
    const made = await core.tools.invoke(
      'blender_python',
      {
        model: 'Track',
        code: `
import bmesh
kiln.clear()
road = kiln.mat("Asphalt", base="#333333")
bm = bmesh.new()
vs = [bm.verts.new(p) for p in [(-30, -4, 0), (30, -4, 0), (30, 4, 0), (-30, 4, 0)]]
vs.reverse()
bm.faces.new(vs)
o = kiln.mesh_object("Road", bm); kiln.paint(o, road)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
b = kiln.mesh_object("Block", bm); b.location = (0, 12, 1); kiln.paint(b, kiln.mat("Stone", base="#888888"))
`,
      },
      agent,
    );
    expect(made.isError, text(made)).toBeFalsy();
    expect(text(made)).toMatch(/Faces Roblox can't see: 'Road' \(60 x 8 studs\) is flat and faces down/);
    const store = new ModelStore(root);
    const road = store.parts('Track').find((p) => p.name.endsWith('Asphalt'))!;
    expect(road.doubleSided).toBe(true);
    expect(road.facesDown).toEqual(['Road']);
    expect(store.parts('Track').find((p) => p.name.endsWith('Stone'))!.doubleSided).toBeUndefined();
    // A second change doesn't repeat the note, but the check tool says what is wrong now.
    const again = await core.tools.invoke('blender_python', { model: 'Track', code: 'bpy.data.objects["Block"].location.x = 3' }, agent);
    expect(text(again)).not.toMatch(/Faces Roblox can't see/);
    const checked = await core.tools.invoke('blender_check', { model: 'Track' }, agent);
    expect(text(checked)).toMatch(/Faces Roblox can't see: Road is a flat mesh whose faces point down/);
    expect(text(checked)).toMatch(/Drawn double-sided .*Asphalt/);
    const viewed = await core.tools.invoke('model_view', { name: 'Track' }, agent);
    expect(text(viewed)).toMatch(/Faces Roblox can't see: Road/);
  }, 180_000);
});

describe('the builders set DoubleSided, guarded', () => {
  it('partFx: only a double-sided part gets the trait, as a short table', () => {
    expect(partFx({})).toBeNull();
    expect(partFx({ doubleSided: true })).toEqual({ ds: true });
    expect(fxTable(partFx({ doubleSided: true }))).toBe('{ds=true}');
    expect(fxTable(null)).toBe('nil');
  });

  it('applyFx sets MeshPart.DoubleSided through pcall (a Studio without the property still builds)', () => {
    expect(FX_FN).toContain('if fx.ds then pcall(function() mp.DoubleSided = true end) end');
  });

  it('world/Models.luau carries the trait of a double-sided part and its place() applies it; model_place does the same', async () => {
    const { core, root } = await makeCore();
    savePart(root, 'Road', { doubleSided: true, upload: { assetId: '77', hash: 'h-Road', at: 'now', facing: 2 }, placements: [{ name: 'Road', parent: 'Workspace', position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 }] });
    savePart(root, 'Plain', { upload: { assetId: '78', hash: 'h-Plain', at: 'now', facing: 2 }, placements: [{ name: 'Plain', parent: 'Workspace', position: [5, 1, 0], rotation: [0, 0, 0], scale: 1 }] });
    new ModelStore(root).writeBuilder();
    const builder = readFileSync(join(root, 'world', 'Models.luau'), 'utf8');
    expect(builder).toContain('{model="Road",asset=77,size={4,0.1,2},fx={ds=true},placements=');
    expect(builder).toContain('{model="Plain",asset=78,size={4,0.1,2},placements=');
    expect(builder).toContain('if m.fx and not p.fx then p.fx = m.fx end');
    expect(builder).toContain('applyFx(mp, p.fx)');
    // Everything generated parses (selene's parser, where it is installed).
    if (existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene'))) expect(await new LuauToolchain(tmpdir()).parseErrors(builder)).toEqual([]);
    // model_place of the single part
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const luau: string[] = [];
    studio.runLuau = async (code: string) => {
      luau.push(code);
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Road', position: [0, 1, 0], notes: [] }), durationMs: 1 };
    };
    core.prefs.set({ robloxCreatorId: '42' });
    const placed = await core.tools.invoke('model_place', { name: 'Road', position: [0, 5, 0] }, agent);
    expect(placed.isError, text(placed)).toBeFalsy();
    expect(luau.join('\n')).toMatch(/place\("Road", 77, \{4,0\.1,2\}, \{name="Road".*fx=\{ds=true\}\}\)/);
    const plain = await core.tools.invoke('model_place', { name: 'Plain', position: [0, 5, 0] }, agent);
    expect(plain.isError, text(plain)).toBeFalsy();
    expect(luau.at(-1)).not.toMatch(/fx=/);
  });

  it('formatFaces is empty for ordinary parts and names the culprits otherwise', () => {
    expect(formatFaces([{ name: 'A' }, { name: 'B' }])).toBe('');
    const s = formatFaces([{ name: 'Map_Asphalt', doubleSided: true, facesDown: ['Road', 'Pit'] }, { name: 'Map_Leaf', doubleSided: true }]);
    expect(s).toMatch(/Faces Roblox can't see: Road, Pit are flat meshes whose faces point down/);
    expect(s).toMatch(/Drawn double-sided .*Map_Asphalt, Map_Leaf/);
  });
});
