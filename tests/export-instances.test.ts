import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../src/core/core';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import { ModelStore, instancesTable, metaJson, temporaryInstancesLuau, type ModelMeta } from '../src/core/modeling/model-store';
import { recordParts } from '../src/core/modeling/publish';
import type { ExportedPart, ModelInstance } from '../src/core/modeling/backend';
import { assembledSize, instanceReach } from '../src/shared/render';
import type { CallerContext } from '../src/core/capabilities/tool-registry';
import { EventBus } from '../src/core/events';
import { FakeProvider } from './helpers/fake-provider';
import { makeGlb } from './helpers/glb';
import { ExportHarness, blender, type ExportPart } from './helpers/blender-export';

// Instances stay instances. A Kiln map has 1,373 visible meshes but only 356 unique (15 tree meshes account for 1,032
// placements): merging them by material made 141 huge unique meshes. Objects that share a mesh (Blender linked duplicates,
// collection instances; at least 4 uses) are exported ONCE, in the mesh's own frame, with a list of placements (position,
// rotation, scale in Roblox space); the model records `instances`, uploads happen once per unique mesh, and the generated Luau
// clones the MeshPart per placement and sets its CFrame and Size. Mirrored uses (a negative determinant can't be done in
// Roblox) get a mirrored mesh of their own.

class StubLuau extends LuauToolchain {
  constructor() {
    super(tmpdir());
  }
  override async check(): Promise<LuauCheckResult> {
    return { ok: true, problems: [], toolErrors: [], durationMs: 1 };
  }
}
const SELENE = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene');
const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown().catch(() => {});
});
const agent: CallerContext = { kind: 'agent', runId: 'run_inst', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

async function makeCore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
  const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
  cores.push(core);
  const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
  const ctx = core.openProject(core.createProject({ name: 'Instances', rootPath: root }).id);
  ctx.updateExtras({ syncMode: 'none' });
  core.orchestrator.pause();
  return { core, root };
}

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

// ---- Roblox-space math the tests share ---------------------------------------------------------------------------------

/** R = Ry(y) Rx(x) Rz(z), degrees: what CFrame.fromOrientation builds. */
function rotation(deg: [number, number, number]): number[][] {
  const [a, b, c] = deg.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  const mul = (A: number[][], B: number[][]) => A.map((_, i) => [0, 1, 2].map((j) => A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]!));
  return mul(mul(Ry, Rx), Rz);
}

/** Every triangle of a part's mesh in model space for each of its uses: [centroid, unit normal by the winding]. */
function worldTriangles(mesh: { v: number[]; t: number[] }, uses: ModelInstance[]): Array<{ c: number[]; n: number[] }> {
  const out: Array<{ c: number[]; n: number[] }> = [];
  for (const u of uses) {
    const R = rotation(u.rotation);
    const w = (k: number) => {
      const v = [mesh.v[k * 3]! * u.scale[0], mesh.v[k * 3 + 1]! * u.scale[1], mesh.v[k * 3 + 2]! * u.scale[2]];
      return [0, 1, 2].map((r) => R[r]![0]! * v[0]! + R[r]![1]! * v[1]! + R[r]![2]! * v[2]! + u.position[r]!);
    };
    for (let i = 0; i < mesh.t.length; i += 3) {
      const [a, b, c] = [w(mesh.t[i]!), w(mesh.t[i + 1]!), w(mesh.t[i + 2]!)];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const len = Math.hypot(...n) || 1;
      out.push({ c: [0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]!) / 3), n: n.map((x) => x / len) });
    }
  }
  return out;
}

describe.skipIf(!blender)('Roblox export: instances', () => {
  // Linked duplicates of a two-material tree with arbitrary position, rotation (all three axes) and non-uniform scale, five
  // mirrored ones, and a lone unique box.
  const FOREST = `
import bmesh, random
random.seed(7)
kiln.clear()
bark = kiln.mat("Bark", base="#553311")
leaf = kiln.mat("Foliage", base="#22aa22")
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
for v in bm.verts:
    v.co.x += 0.3 * v.co.z
    v.co.y *= 1.0 + 0.4 * v.co.x
bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.8, matrix=Matrix.Translation((0.2, 0, 1.5)))
for f in bm.faces:
    f.material_index = 0 if len(f.verts) == 4 else 1
tree = bpy.data.meshes.new("TreeMesh")
bm.to_mesh(tree)
tree.materials.append(bark)
tree.materials.append(leaf)
objs = []
def link(name, loc, rot, scale):
    o = bpy.data.objects.new(name, tree)
    bpy.context.scene.collection.objects.link(o)
    o.location, o.rotation_euler, o.scale = loc, rot, scale
    objs.append(o)
for i in range(12):
    s = random.uniform(0.7, 1.6)
    link("Tree.%03d" % i, (random.uniform(-100, 100), random.uniform(-100, 100), random.uniform(0, 3)), (random.uniform(-0.5, 0.5), random.uniform(-0.5, 0.5), random.uniform(0, 6.28)), (s, s * random.uniform(0.9, 1.1), s * random.uniform(0.8, 1.3)))
for i in range(5):
    link("Mir.%03d" % i, (random.uniform(-100, 100), random.uniform(-100, 100), 0), (0, 0, random.uniform(0, 6.28)), (-1.2, 1.0, 1.1))
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
kiln.paint(kiln.mesh_object("Unique", bm), kiln.mat("Plain", base="#888888"))
`;

  it('exports linked duplicates once with their placements; every use reproduces the Blender geometry (rotation, scale, mirror)', async () => {
    await harness!.python(FOREST);
    const r = await harness!.export('Forest');
    const instanced = r.parts.filter((p) => p.instances?.length);
    expect(instanced.map((p) => [p.blender_material, p.instances!.length]).sort()).toEqual([['Bark', 12], ['Bark', 5], ['Foliage', 12], ['Foliage', 5]]);
    expect(r.parts.filter((p) => !p.instances)).toHaveLength(1); // the unique box, merged as before
    expect(r.notes?.some((n) => /^Instanced: 17 objects share 1 mesh \(TreeMesh\)/.test(n))).toBe(true);
    // 12 + 5 uses: the geometry of one use is in the mesh file, not 17 times
    const bark = instanced.find((p) => p.blender_material === 'Bark' && p.instances!.length === 12)!;
    expect(bark.triangles).toBe(12);
    expect(bark.name).toBe('Forest_TreeMesh_Bark');
    expect(instanced.find((p) => /Mirrored/.test(p.name) && p.blender_material === 'Bark')!.instances).toHaveLength(5);
    expect(bark.origin).toEqual(bark.instances![0]!.position);
    for (const u of bark.instances!) {
      for (const s of u.scale) expect(s).toBeGreaterThan(0); // never negative: a mirrored use has a mesh of its own
    }
    // The whole model's size includes every use (the same as Blender's world bounds, in Roblox axes)
    const truth = await harness!.python(
      `
import numpy as np
lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
for o in bpy.context.scene.objects:
    if o.type != "MESH": continue
    for v in o.data.vertices:
        w = o.matrix_world @ v.co
        lo = np.minimum(lo, [w.x, w.y, w.z]); hi = np.maximum(hi, [w.x, w.y, w.z])
d = hi - lo
print("SIZE", d[0], d[2], d[1])
`,
      false,
    );
    const m = /SIZE ([\d.]+) ([\d.]+) ([\d.]+)/.exec(truth)!;
    expect(r.size[0]).toBeCloseTo(Number(m[1]), 1);
    expect(r.size[1]).toBeCloseTo(Number(m[2]), 1);
    expect(r.size[2]).toBeCloseTo(Number(m[3]), 1);
    // Every triangle of every object, in Roblox space from Blender's own matrices, is reproduced by exactly one use of a part (position by
    // the centroid, facing by the winding: a mirrored object shows its faces the other way round, Roblox only knows the winding).
    const dump = await harness!.python(
      `
import json, numpy as np
TO = np.array([[-1.0, 0, 0], [0, 0, 1.0], [0, 1.0, 0]])
rows = []
for o in bpy.context.scene.objects:
    if o.type != "MESH": continue
    M = np.array(o.matrix_world)
    flip = np.linalg.det(M[:3, :3]) < 0
    me = o.data
    me.calc_loop_triangles()
    for t in me.loop_triangles:
        pts = np.array([(M @ np.append(np.array(me.vertices[me.loops[l].vertex_index].co), 1.0))[:3] for l in t.loops]) @ TO.T
        if flip: pts = pts[[0, 2, 1]]
        n = np.cross(pts[1] - pts[0], pts[2] - pts[0]); n = n / (np.linalg.norm(n) + 1e-12)
        rows.append([pts.mean(axis=0).tolist(), n.tolist()])
open(r"${join(harness!.dir, 'truth.json').replaceAll(String.fromCharCode(92), '/')}", "w").write(json.dumps(rows))
`,
      false,
    );
    void dump;
    const truthRows = JSON.parse(readFileSync(join(harness!.dir, 'truth.json'), 'utf8')) as Array<[number[], number[]]>;
    const have: Array<{ c: number[]; n: number[] }> = [];
    for (const p of r.parts) have.push(...worldTriangles(harness!.mesh(p.name), p.instances ?? [{ position: p.origin, rotation: [0, 0, 0], scale: [1, 1, 1] }]));
    expect(have.length).toBe(truthRows.length);
    let worst = 0;
    for (const [c, n] of truthRows) {
      const near = have.filter((h) => Math.hypot(h.c[0]! - c[0]!, h.c[1]! - c[1]!, h.c[2]! - c[2]!) < 0.05);
      worst = Math.max(worst, Math.min(...have.map((h) => Math.hypot(h.c[0]! - c[0]!, h.c[1]! - c[1]!, h.c[2]! - c[2]!))));
      expect(near.some((h) => h.n[0]! * n[0]! + h.n[1]! * n[1]! + h.n[2]! * n[2]! > 0.98), `a triangle at ${c.map((v) => v.toFixed(2))}`).toBe(true);
    }
    expect(worst).toBeLessThan(0.02);
    // the total is the real triangle count of the scene
    expect(r.tris).toBe(truthRows.length);
  }, 180_000);

  it('a mesh used three times is merged by material as before; four is enough to instance it', async () => {
    const scene = (n: number) => `
import bmesh
kiln.clear()
m = kiln.mat("Rock", base="#777766")
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
me = bpy.data.meshes.new("RockMesh"); bm.to_mesh(me); me.materials.append(m)
for i in range(${n}):
    o = bpy.data.objects.new("Rock.%03d" % i, me); bpy.context.scene.collection.objects.link(o); o.location = (i * 5, 0, 1)
`;
    await harness!.python(scene(3));
    const three = await harness!.export('Rocks');
    expect(three.parts).toHaveLength(1);
    expect(three.parts[0]!.instances).toBeUndefined();
    expect(three.parts[0]!.triangles).toBe(3 * 20);
    await harness!.python(scene(4));
    const four = await harness!.export('Rocks');
    expect(four.parts).toHaveLength(1);
    expect(four.parts[0]!.instances).toHaveLength(4);
    expect(four.parts[0]!.triangles).toBe(20);
    expect(four.parts[0]!.name).toBe('Rocks'); // the only part of the model
    expect(four.tris).toBe(80);
  }, 120_000);

  it('collection instances become instances too (an empty placing a collection, six times)', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
col = bpy.data.collections.new("Hut"); bpy.context.scene.collection.children.link(col)
wall = kiln.mat("Plaster", base="#ddccaa"); roof = kiln.mat("Thatch", base="#aa8844")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
a = bpy.data.objects.new("HutWalls", bpy.data.meshes.new("HutWallsMesh")); bm.to_mesh(a.data); a.data.materials.append(wall); col.objects.link(a)
bm = bmesh.new(); bmesh.ops.create_cone(bm, segments=6, radius1=1.6, radius2=0.0, depth=1.5, matrix=Matrix.Translation((0, 0, 1.75)))
b = bpy.data.objects.new("HutRoof", bpy.data.meshes.new("HutRoofMesh")); bm.to_mesh(b.data); b.data.materials.append(roof); col.objects.link(b)
# the source collection is not shown itself (only its instances are)
bpy.context.view_layer.layer_collection.children["Hut"].exclude = True
for i in range(6):
    e = bpy.data.objects.new("Village.%d" % i, None); e.instance_type = "COLLECTION"; e.instance_collection = col
    e.location = (i * 10, (i % 2) * 7, 0); e.rotation_euler = (0, 0, i * 0.5)
    bpy.context.scene.collection.objects.link(e)
`);
    const r = await harness!.export('Village');
    expect(r.parts.map((p) => [p.blender_material, p.instances?.length]).sort()).toEqual([['Plaster', 6], ['Thatch', 6]]);
    const walls = r.parts.find((p) => p.blender_material === 'Plaster')!;
    expect(walls.triangles).toBe(12);
    // the sixth village is at Blender x = 50, y = 7: Roblox x = -50, z = 7 (the walls' box is centred on the hut's origin)
    const u = walls.instances!.find((i) => Math.abs(i.position[0] + 50) < 0.01)!;
    expect(u.position[1]).toBeCloseTo(0, 3);
    expect(u.position[2]).toBeCloseTo(7, 3);
    expect(r.size[0]).toBeGreaterThan(50);
    // The hut's own collection is excluded from the view: nothing was exported twice
    expect(r.tris).toBe(6 * (12 + r.parts.find((p) => p.blender_material === 'Thatch')!.triangles));
  }, 120_000);

  it('keeps shear, oversize and modifier-made differences out of the instances (merged as ordinary objects)', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
m = kiln.mat("Post", base="#665544")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
me = bpy.data.meshes.new("PostMesh"); bm.to_mesh(me); me.materials.append(m)
def put(name, loc, scale=(1, 1, 1), parent=None):
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    o.location, o.scale = loc, scale
    if parent is not None:
        o.parent = parent
    return o
for i in range(5):
    put("Post.%d" % i, (i * 4, 0, 0.5))
# shear: a child of a rotated parent that is scaled unevenly
holder = bpy.data.objects.new("Holder", None); bpy.context.scene.collection.objects.link(holder)
holder.rotation_euler = (0, 0, 0.7); holder.scale = (3, 1, 1); holder.location = (0, 30, 0)
put("Sheared", (0, 0, 0), (1, 1, 1), holder)
sheared = bpy.data.objects["Sheared"]; sheared.rotation_euler = (0, 0, 0.8)
# oversize: one use scaled to 3,000 studs
put("Giant", (0, 60, 0), (3000, 1, 1))
# a modifier that makes this one a different mesh
big = put("Arrayed", (0, 90, 0.5))
big.modifiers.new("Rep", "ARRAY").count = 3
`);
    const r = await harness!.export('Posts');
    const inst = r.parts.filter((p) => p.instances);
    expect(inst).toHaveLength(1);
    expect(inst[0]!.instances).toHaveLength(5);
    // the other three (sheared, giant, arrayed) are merged by material into ordinary parts: the giant one cut into tiles
    const merged = r.parts.filter((p) => !p.instances);
    expect(merged.length).toBeGreaterThanOrEqual(2);
    for (const p of r.parts) expect(Math.max(...p.size), p.name).toBeLessThanOrEqual(2000);
    // 5 instanced + sheared (12) + giant (12 cut up, at least) + arrayed (3 x 12 = 36)
    const mergedTris = merged.reduce((t, p) => t + p.triangles, 0);
    expect(mergedTris).toBeGreaterThanOrEqual(12 + 12 + 36);
  }, 120_000);

  it('exports a map-sized scene fast: 15 tree meshes placed 1,035 times come out as 15 parts', async () => {
    await harness!.python(`
import bmesh, random
random.seed(3)
kiln.clear()
bark = kiln.mat("Bark", base="#553311")
n = 0
for k in range(15):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, segments=5 + k, radius1=1.0 + k * 0.1, radius2=0.1, depth=6.0 + k, matrix=Matrix.Translation((0, 0, 3 + k / 2)))
    me = bpy.data.meshes.new("Tree%02d" % k); bm.to_mesh(me); me.materials.append(bark)
    for i in range(69):
        o = bpy.data.objects.new("T%02d_%03d" % (k, i), me); bpy.context.scene.collection.objects.link(o)
        o.location = (random.uniform(-4000, 4000), random.uniform(-4000, 4000), 0)
        o.rotation_euler = (0, 0, random.uniform(0, 6.28)); s = random.uniform(0.8, 1.4); o.scale = (s, s, s)
        n += 1
print("OBJECTS", n)
`);
    const t0 = Date.now();
    const r = await harness!.export('Grove');
    const seconds = (Date.now() - t0) / 1000;
    expect(r.parts).toHaveLength(15);
    expect(r.parts.every((p) => p.instances!.length === 69)).toBe(true);
    expect(r.parts.reduce((n, p) => n + p.instances!.length, 0)).toBe(1035);
    expect(Math.max(...r.parts.map((p) => p.triangles))).toBeLessThan(40);
    expect(readdirSync(harness!.dir).filter((f) => f.startsWith('Grove_') && f.endsWith('.glb'))).toHaveLength(15); // not 1,035 meshes
    expect(seconds).toBeLessThan(60);
    // the whole scene is ~8 km across, instances included
    expect(r.size[0]).toBeGreaterThan(7000);
  }, 240_000);

  it('instances keep their role (decor leaves never merge with a trunk) and are not cut by the tiling', async () => {
    await harness!.python(`
import bmesh
kiln.clear()
trunk = kiln.mat("Trunk", base="#553311"); crown = kiln.mat("Leaves", base="#22aa22")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
me = bpy.data.meshes.new("Pine"); bm.to_mesh(me); me.materials.append(trunk)
for i in range(6):
    o = bpy.data.objects.new("Pine.%d" % i, me); bpy.context.scene.collection.objects.link(o); o.location = (i * 3000, 0, 0.5)
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
me2 = bpy.data.meshes.new("Puff"); bm.to_mesh(me2); me2.materials.append(crown)
for i in range(6):
    o = bpy.data.objects.new("Puff.%d" % i, me2); bpy.context.scene.collection.objects.link(o); o.location = (i * 3000, 0, 4)
`);
    const r = await harness!.export('Pines');
    const byMat = Object.fromEntries(r.parts.map((p) => [p.blender_material, p])) as Record<string, ExportPart>;
    expect(byMat.Leaves).toMatchObject({ role: 'decor', roleInferred: true });
    expect(byMat.Leaves!.instances).toHaveLength(6);
    expect(byMat.Trunk!.role).toBeUndefined();
    expect(byMat.Trunk!.instances).toHaveLength(6);
    // 15,000 studs across: each use is small, so nothing is cut
    expect(r.parts.every((p) => !p.tile && !p.piece)).toBe(true);
    expect(r.size[0]).toBeGreaterThan(15000);
  }, 120_000);
});

// ---- Store, builders, tools (no Blender) --------------------------------------------------------------------------------

const use = (x: number, z: number, rot = 0, s = 1): ModelInstance => ({ position: [x, 3, z], rotation: [0, rot, 0], scale: [s, s, s] });

function savePart(root: string, name: string, over: Partial<ModelMeta> = {}): ModelMeta {
  const store = new ModelStore(root);
  const meta = store.save({ name, hash: `h-${name}`, size: [4, 6, 4], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', ...over }, { deferBuilder: true });
  writeFileSync(store.paths(name).glb, makeGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2] }));
  writeFileSync(store.paths(name).mesh, JSON.stringify({ v: [0, 0, 0, 1, 0, 0, 0, 0, 1], n: [0, 1, 0, 0, 1, 0, 0, 1, 0], t: [0, 1, 2] }));
  return meta;
}

describe('instances in the model store', () => {
  it('writes an instanced part compactly (a use per line) and reads it back', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const uses = Array.from({ length: 300 }, (_, i) => use(i * 1.5, i + 1, i % 360, 1 + (i % 5) / 10));
    savePart(root, 'Grove_Pine', { assembly: 'Grove', instances: uses });
    const store = new ModelStore(root);
    const file = readFileSync(store.paths('Grove_Pine').meta, 'utf8');
    expect(file.split('\n').length).toBeLessThan(400); // pretty JSON would be 12 lines a use: thousands
    expect(file).toContain('"instances": [');
    expect(file).toContain('{"position":[0,3,1],"rotation":[0,0,0],"scale":[1,1,1]}');
    expect(store.get('Grove_Pine')!.instances).toEqual(uses);
    // a part without instances is the same file as before
    savePart(root, 'Plain');
    expect(readFileSync(store.paths('Plain').meta, 'utf8')).not.toContain('instances');
    expect(metaJson({ ...store.get('Plain')!, instances: [] })).not.toContain('instances');
  });

  it('recordParts keeps the uses, makes even a lone instanced part an assembly, and writes world/Models.luau once', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const uses = [use(0, 0), use(5, 0), use(10, 0), use(15, 0)];
    const part = (over: Partial<ExportedPart> = {}): ExportedPart => ({ name: 'Grove', blender_material: 'Bark', color: '#553311', material: 'SmoothPlastic', transparency: 0, origin: [0, 3, 0], size: [4, 6, 4], triangles: 12, vertices: 8, ...over });
    recordParts(root, 'Grove', [part({ instances: uses })], [], new EventBus());
    const m = new ModelStore(root).get('Grove')!;
    expect(m.instances).toEqual(uses);
    expect(m.assembly).toBe('Grove');
    expect(m.origin).toEqual([0, 3, 0]);
    // without instances a single part is still no assembly
    recordParts(root, 'Crate', [part({ name: 'Crate' })], [], new EventBus());
    expect(new ModelStore(root).get('Crate')!.assembly).toBeUndefined();
  });

  it('a map of 400 parts records in well under a second of builder writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const parts: ExportedPart[] = Array.from({ length: 400 }, (_, i) => ({ name: `Map_P${i}`, blender_material: 'M', color: '#888888', material: 'SmoothPlastic', transparency: 0, origin: [i, 0, 0], size: [1, 1, 1], triangles: 12, vertices: 8, instances: [use(i, 0), use(i, 5), use(i, 10), use(i, 15)] }));
    const t0 = Date.now();
    recordParts(root, 'Map', parts, [], new EventBus());
    // 0.7 s alone; 5 to 9 s when the whole suite writes to the disk at once (one builder write per part took far longer).
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(new ModelStore(root).names()).toHaveLength(400);
  });

  it('world/Models.luau places an instanced part with placeInstances, from the pivot recorded; it parses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const uses = [use(0, 0, 0, 1), use(5, 2, 90, 1.5), use(-3, 8, 45, 0.5), use(7, -7, 180, 1)];
    savePart(root, 'Grove_Pine', { assembly: 'Grove', instances: uses, upload: { assetId: '555', hash: 'h-Grove_Pine', at: 'now', facing: 2 }, role: 'decor', color: '#336611', material: 'Grass', placements: [{ name: 'Grove_Pine', parent: 'Workspace.Grove', position: [100, 0, -50], rotation: [0, 30, 0], scale: 2, color: '#336611', material: 'Grass', group: true }] });
    savePart(root, 'Grove_Rock', { assembly: 'Grove', upload: { assetId: '556', hash: 'h-Grove_Rock', at: 'now', facing: 2 }, placements: [{ name: 'Grove_Rock', parent: 'Workspace.Grove', position: [1, 2, 3], rotation: [0, 0, 0], scale: 2, group: true }] });
    const code = new ModelStore(root).writeBuilder();
    expect(code).toContain('{model="Grove_Pine",asset=555,size={4,6,4},fx={cc=false,cq=false,ct=false,sh=false},inst={0,3,0,0,0,0,1,1,1,');
    expect(code).toContain('placements={{name="Grove_Pine",parent="Workspace.Grove",pos={100,0,-50},rot={0,30,0},scale=2,color="#336611",material="Grass",group=true}}');
    expect(code).toContain('ok, err = pcall(placeInstances, m.model, m.asset, m.size, m.inst, p)');
    expect(code).toContain('function placeInstances(modelName, assetId, size, inst, p)');
    expect(code).toContain('mp.Size = Vector3.new(size[1] * inst[i + 6], size[2] * inst[i + 7], size[3] * inst[i + 8]) * k');
    expect(code).toContain('local cf = pivot * (CFrame.new(inst[i] * k, inst[i + 1] * k, inst[i + 2] * k) * CFrame.fromOrientation(math.rad(inst[i + 3]), math.rad(inst[i + 4]), math.rad(inst[i + 5])))');
    expect(code).toContain('applyFx(mp, p.fx)');
    expect(code).toContain('if p.turn then cf = cf * CFrame.Angles(0, math.pi, 0) end'); // legacy uploads, as place() does
    // an ordinary part's row has no inst
    expect(code).toMatch(/\{model="Grove_Rock",asset=556,size=\{4,6,4\},placements=/);
    if (existsSync(SELENE)) expect(await new LuauToolchain(tmpdir()).parseErrors(code)).toEqual([]);
  });

  it('a legacy upload (no facing mark) of an instanced part is turned back per use', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    savePart(root, 'Old_Tree', { instances: [use(0, 0), use(1, 1), use(2, 2), use(3, 3)], upload: { assetId: '9', hash: 'h-Old_Tree', at: 'then' }, placements: [{ name: 'Old_Tree', parent: 'Workspace.Old', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, group: true }] });
    expect(new ModelStore(root).writeBuilder()).toContain('size={4,6,4},turn=true,inst=');
  });

  it('instancesTable: nine numbers a use, rounded', () => {
    expect(instancesTable([{ position: [1.23456789, 0, -2], rotation: [0, 33.3333333, 0], scale: [1, 1.00004, 2] }])).toBe('{1.2346,0,-2,0,33.3333,0,1,1,2}');
  });

  it('the temporary (no upload) version clones one EditableMesh per use and parses', async () => {
    const code = temporaryInstancesLuau('Grove_Pine', { v: [0, 0, 0, 1, 0, 0, 0, 0, 1], t: [0, 1, 2], n: [0, 1, 0, 0, 1, 0, 0, 1, 0] }, [use(0, 0), use(5, 0)], { name: 'Grove_Pine', parent: 'Workspace.Grove', position: [10, 0, 20], rotation: [0, 90, 0], scale: 2, group: true }, '', { cc: false, cq: false, ct: false, sh: false });
    expect(code.match(/CreateMeshPartAsync/g)).toHaveLength(1);
    expect(code).toContain('local inst = {0,3,0,0,0,0,1,1,1,\n5,3,0,0,0,0,1,1,1}');
    expect(code).toContain('local c = mp:Clone()');
    expect(code).toContain('applyFx(mp, {cc=false,cq=false,ct=false,sh=false})');
    expect(code).toContain('local pivot = CFrame.new(10, 0, 20) * CFrame.fromOrientation(math.rad(0), math.rad(90), math.rad(0))');
    if (existsSync(SELENE)) expect(await new LuauToolchain(tmpdir()).parseErrors(code)).toEqual([]);
  });

  it('assembledSize covers every use, turned and scaled', () => {
    // a 2 x 2 x 10 post, 3 uses spread along x; one lies on its side (turned 90 degrees about z)
    const size = assembledSize([{ size: [2, 2, 10], origin: [0, 0, 0], instances: [{ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [100, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [0, 0, 50], rotation: [0, 90, 0], scale: [1, 1, 1] }] }]);
    expect(size[0]).toBeCloseTo(106, 5); // x from the lying post's -5 to the far post's +101
    expect(size[1]).toBeCloseTo(2, 5);
    expect(size[2]).toBeCloseTo(56, 5); // z from the standing posts' -5 to the lying one's 50 + 1
    expect(assembledSize([{ size: [2, 4, 6], origin: [10, 0, 0] }])).toEqual([2, 4, 6]); // without instances: as before
    const r = instanceReach([2, 2, 10], { position: [0, 0, 0], rotation: [0, 0, 90], scale: [2, 1, 1] });
    expect(r[0]).toBeCloseTo(1, 5); // turned 90 degrees about z: y (1 each way) onto x
    expect(r[1]).toBeCloseTo(2, 5); // the scaled x (2 each way) onto y
    expect(r[2]).toBeCloseTo(5, 5); // z stays
  });
});

describe('model_place with instances', () => {
  const upload = (n: string, id: string) => ({ assetId: id, hash: `h-${n}`, at: 'now', facing: 2 });

  it('places each use relative to the model pivot, records the pivot, uploads each unique mesh once, and rebuilds from it', async () => {
    const { core, root } = await makeCore();
    const uses = Array.from({ length: 40 }, (_, i) => use(i * 6, (i % 4) * 8, i * 9, 1 + (i % 3) / 4));
    savePart(root, 'Grove_Pine', { assembly: 'Grove', instances: uses, origin: [0, 3, 0], role: 'decor', hash: 'h-pine' });
    savePart(root, 'Grove_Rock', { assembly: 'Grove', origin: [3, 1, 3], hash: 'h-rock', role: 'ground' });
    core.prefs.set({ robloxCreatorId: '42' });
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    cloud.configured = async () => true;
    let uploads = 0;
    const names: string[] = [];
    cloud.upload = async (o: { name: string }) => {
      uploads++;
      names.push(o.name);
      return { ok: true, assetId: String(700 + uploads) };
    };
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const luau: string[] = [];
    studio.runLuau = async (code: string) => {
      luau.push(code);
      return {
        ok: true,
        output: JSON.stringify({ path: 'Workspace.Grove', position: [100, 7, -20], rotation: [0, 15, 0], notes: [], pivot: { pos: [100, 7.25, -20], rot: [0, 15.5, 0] }, parts: { Grove_Pine: { instances: 40, maps: false }, Grove_Rock: { pos: [103, 8, -17], rot: [0, 15.5, 0] } } }),
        durationMs: 1,
      };
    };
    const placed = await core.tools.invoke('model_place', { name: 'Grove', position: [100, 7, -20], rotation: [0, 15, 0], on_ground: false }, agent);
    expect(placed.isError, text(placed)).toBeFalsy();
    // 41 placed MeshParts (40 + 1) from 2 uploads
    expect(uploads).toBe(2);
    expect(names.sort()).toEqual(['Grove_Pine', 'Grove_Rock']);
    const out = JSON.parse(text(placed)) as { instances: Record<string, number>; instancesNote: string; permanent: boolean };
    expect(out).toMatchObject({ permanent: true, instances: { Grove_Pine: 40 } });
    expect(out.instancesNote).toMatch(/40 placed MeshParts from 1 uploaded mesh/);
    const program = luau.find((c) => c.includes('model:SetAttribute("ShurikenAssembly"'))!;
    expect(program).toContain('placeInstances("Grove_Pine", 701, {4,6,4}, {0,3,0,0,0,0,1,1,1,');
    expect(program).toMatch(/pos=\{pivot\.X, pivot\.Y, pivot\.Z\},rot=rot,scale=1[^\n]*group=true[^\n]*fx=\{cc=false,cq=false,ct=false,sh=false\}\}\)/);
    expect(program).toContain('local pv = model:GetPivot()');
    // the pivot after settling is what the part's placement records (its uses hang off it)
    const store = new ModelStore(root);
    expect(store.get('Grove_Pine')!.placements).toEqual([expect.objectContaining({ name: 'Grove_Pine', parent: 'Workspace.Grove', position: [100, 7.25, -20], rotation: [0, 15.5, 0], scale: 1, group: true })]);
    expect(store.get('Grove_Rock')!.placements[0]).toMatchObject({ position: [103, 8, -17] });
    const builder = readFileSync(join(root, 'world', 'Models.luau'), 'utf8');
    expect(builder).toContain('{model="Grove_Pine",asset=701,');
    expect(builder).toContain('pos={100,7.25,-20},rot={0,15.5,0}');
    // a second placement does not upload again
    await core.tools.invoke('model_place', { name: 'Grove', position: [100, 7, -20], on_ground: false }, agent);
    expect(uploads).toBe(2);
    // model_list tells the number of uses
    const listed = JSON.parse(text(await core.tools.invoke('model_list', {}, agent))) as { models: Array<{ name: string; instances?: number }> };
    expect(listed.models.find((m) => m.name === 'Grove_Pine')!.instances).toBe(40);
    if (existsSync(SELENE)) expect(await new LuauToolchain(tmpdir()).parseErrors(program)).toEqual([]);
  });

  it('a lone instanced part (named like its model) is placed as an assembly too', async () => {
    const { core, root } = await makeCore();
    savePart(root, 'Grove', { assembly: 'Grove', instances: [use(0, 0), use(5, 0), use(10, 0), use(15, 0)], origin: [0, 3, 0], upload: upload('Grove', '77') });
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const luau: string[] = [];
    studio.runLuau = async (code: string) => {
      luau.push(code);
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Grove', position: [0, 0, 0], rotation: [0, 0, 0], notes: [], pivot: { pos: [0, 0, 0], rot: [0, 0, 0] }, parts: { Grove: { instances: 4 } } }), durationMs: 1 };
    };
    const placed = await core.tools.invoke('model_place', { name: 'Grove', position: [0, 0, 0], on_ground: false }, agent);
    expect(placed.isError, text(placed)).toBeFalsy();
    expect(luau.find((c) => c.includes('placeInstances("Grove", 77'))).toBeTruthy();
    expect(new ModelStore(root).get('Grove')!.placements).toHaveLength(1);
  });

  it('without uploads the uses are temporary meshes cloned from one EditableMesh', async () => {
    const { core, root } = await makeCore();
    savePart(root, 'Grove_Pine', { assembly: 'Grove', instances: [use(0, 0), use(5, 0), use(10, 0), use(15, 0)], origin: [0, 3, 0] });
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const luau: string[] = [];
    studio.runLuau = async (code: string) => {
      luau.push(code);
      if (code.includes('local spots = {}')) return { ok: true, output: JSON.stringify({ spots: { Grove_Pine: [0, 3, 0] }, rot: [0, 0, 0], pivot: [50, 0, 60] }), durationMs: 1 };
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Grove', position: [50, 0, 60], notes: [] }), durationMs: 1 };
    };
    const placed = await core.tools.invoke('model_place', { name: 'Grove', position: [50, 0, 60], temporary: true, on_ground: false }, agent);
    expect(placed.isError, text(placed)).toBeFalsy();
    expect(JSON.parse(text(placed))).toMatchObject({ permanent: false });
    const temp = luau.find((c) => c.includes('local c = mp:Clone()'))!;
    expect(temp).toContain('local pivot = CFrame.new(50, 0, 60)');
    expect(temp).toContain('local inst = {0,3,0,0,0,0,1,1,1,');
  });
});
