import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExportedPart } from '../src/core/modeling/backend';
import { glbTurned180 } from '../src/core/modeling/glb';
import { fromRoblox, mulV, planLayout, rotationYXZ, type LayoutPart, type PlanUse } from '../src/core/modeling/kiln-layout';
import { parseManifest, type Vec3 } from '../src/core/modeling/kiln-manifest';
import { applyManifestLook, exportBakedBlend, prepareCode } from '../src/core/modeling/layout-import';
import { partFx } from '../src/core/modeling/part-traits';
import { blender } from './helpers/blender-export';
import { accessorRows } from './helpers/glb';

// The real exporter on Kiln's reference layout (tests/fixtures/kiln-layout-reference/roblox.blend, the baked scene Kiln's
// make_fixture.py wrote): the map's own geometry without its placements, each piece as its own model, and then the whole
// chain with the real meshes: every vertex of every placed part must land where Kiln's matrix puts the piece's box
// (the boxes are asymmetric: a half-turned or mirrored result fails), through the upload copy Roblox's importer turns back.

const FIXTURE = resolve(__dirname, 'fixtures', 'kiln-layout-reference');
const BLEND = join(FIXTURE, 'roblox.blend');
const SCRIPT = resolve(__dirname, '..', 'resources', 'blender', 'bridge.py');
const { manifest } = parseManifest(JSON.parse(readFileSync(join(FIXTURE, 'roblox.json'), 'utf8')), FIXTURE);
const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')) as { placements: Record<string, { piece: string; origin: Vec3; x1: Vec3; y1: Vec3; z1: Vec3 }> };
const PROJECTS = ['fixture-arrow', 'fixture-pillar', 'fixture-slab'];

/** A piece's own scene, made from the layout's copy of it (the objects kiln.piece brought in): what the piece's project holds. */
const isolate = (piece: string) => `import bpy
_col = bpy.data.collections["Piece_${piece}"]
for _o in list(bpy.context.scene.objects):
    bpy.data.objects.remove(_o, do_unlink=True)
for _o in _col.objects:
    bpy.context.scene.collection.objects.link(_o)
bpy.context.view_layer.update()
`;

/** The boxes of each piece in its own space (Blender axes), from Kiln's make_fixture.py. */
const BOXES: Record<string, Array<[Vec3, Vec3]>> = {
  Arrow: [[[0, -0.25, 0], [3, 0.25, 0.5]], [[0, 0.25, 0], [0.5, 1.25, 0.5]], [[0, -0.25, 0.5], [0.5, 0.25, 2]]],
  Pillar: [[[-0.5, -0.5, 0], [0.5, 0.5, 4]], [[-0.5, -1.5, 0], [0.5, -0.5, 1]]],
  Slab: [[[0, 0, 0], [4, 2, 0.5]]],
};
const corners = ([lo, hi]: [Vec3, Vec3]): Vec3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
const key = (v: readonly number[]) => v.map((x) => (Math.round(x * 100) / 100 + 0).toFixed(2)).join(',');

/** What Studio does with a use: CFrame.new(p) * CFrame.fromOrientation(r), Size = the mesh's size times s. */
const studio = (u: Pick<PlanUse, 'p' | 'r' | 's'>, local: readonly number[]): Vec3 => {
  const w = mulV(rotationYXZ(u.r), [local[0]! * u.s[0], local[1]! * u.s[1], local[2]! * u.s[2]]);
  return [w[0] + u.p[0], w[1] + u.p[1], w[2] + u.p[2]];
};

const toLayoutPart = (p: ExportedPart, asset = '1'): LayoutPart => ({ name: p.name, origin: p.origin, size: p.size, ...(p.instances ? { instances: p.instances } : {}), ...(p.role ? { role: p.role } : {}), ...(p.replaced ? { replaced: true } : {}), ...(p.box ? { box: true } : {}), color: p.color, material: p.material, hash: p.name, asset, legacy: false });

describe.skipIf(!blender)("Kiln's reference layout through the real exporter", () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuriken-layout-blend-'));
  const mesh = (part: string) => JSON.parse(readFileSync(join(dir, `${part}.mesh.json`), 'utf8')) as { v: number[]; t: number[] };
  let own: ExportedPart[] = [];
  const pieces: Record<string, ExportedPart[]> = {};

  beforeAll(async () => {
    const r = await exportBakedBlend(blender, SCRIPT, BLEND, dir, 'Ref', prepareCode(manifest.studsPerUnit, PROJECTS));
    expect(r.ok, String(r.error)).toBe(true);
    own = r.parts!;
    for (const piece of Object.keys(BOXES)) {
      const p = await exportBakedBlend(blender, SCRIPT, BLEND, dir, piece, isolate(piece));
      expect(p.ok, String(p.error)).toBe(true);
      pieces[piece] = p.parts!;
    }
  }, 300_000);

  it("the map's own export holds the ground, the walls, the shed and its collider, and none of the placed pieces", () => {
    // Blender 60 x 40 x 1 ground, two 60 x 1 x 3 walls (one mesh, two objects), a 6 x 6 x 4 shed and its collider box
    expect(own.reduce((n, p) => n + p.triangles * Math.max(1, p.instances?.length ?? 0), 0)).toBe(12 + 24 + 12 + 12);
    const by = (re: RegExp) => own.find((p) => re.test(p.name))!;
    const ground = by(/Ground/);
    expect(ground).toMatchObject({ role: 'drivable', material: 'Asphalt', size: [60, 1, 40], origin: [0, -0.5, 0] });
    expect(by(/Wall/)).toMatchObject({ role: 'barrier' });
    expect(by(/Shed_?Mat|ShedMat/i)).toMatchObject({ role: 'decor', replaced: true });
    expect(own.find((p) => p.role === 'collider')).toMatchObject({ transparency: 1, box: true, size: [6, 4, 6] });
    // Kiln's manifest says how the plain materials look: the ground is Roblox's Asphalt tinted #55585c, no texture
    expect(applyManifestLook(own, manifest)).toBe(own.filter((p) => p.role !== 'collider').length);
    expect(ground).toMatchObject({ color: '#55585c', material: 'Asphalt' });
    expect(own.every((p) => !p.textures)).toBe(true);
    expect(by(/Wall/).color).toBe('#b0b0b0');
    // collision from the roles, as 1.9 does: precise ground, box walls, a shed that doesn't collide, an invisible collider that does
    expect(partFx(ground)).toMatchObject({ cc: true, fid: 'PreciseConvexDecomposition' });
    expect(partFx(by(/Shed_?Mat|ShedMat/i))).toMatchObject({ cc: false, cq: false, ct: false });
    expect(partFx(own.find((p) => p.role === 'collider')!)).toMatchObject({ cc: true, tr: 1, fid: 'Box' });
  });

  it('without the prepare step the placements would be baked into the map (what an import must not do)', async () => {
    const other = mkdtempSync(join(tmpdir(), 'shuriken-layout-blend-'));
    const r = await exportBakedBlend(blender, SCRIPT, BLEND, other, 'Baked', null);
    expect(r.ok, String(r.error)).toBe(true);
    const tris = r.parts!.reduce((n, p) => n + p.triangles * Math.max(1, p.instances?.length ?? 0), 0);
    expect(tris).toBe(60 + 4 * 36 + 3 * 24 + 3 * 12); // the map's 60 triangles plus every placed piece
    // and dropping only some pieces keeps the others (a piece whose project could not be exported stays in the map)
    const some = await exportBakedBlend(blender, SCRIPT, BLEND, other, 'Some', prepareCode(1, ['fixture-arrow', 'fixture-slab']));
    expect(some.parts!.reduce((n, p) => n + p.triangles * Math.max(1, p.instances?.length ?? 0), 0)).toBe(60 + 3 * 24);
  }, 300_000);

  it('a map in meters is exported in studs (the prepare step scales the copy)', async () => {
    const other = mkdtempSync(join(tmpdir(), 'shuriken-layout-blend-'));
    const r = await exportBakedBlend(blender, SCRIPT, BLEND, other, 'Meters', prepareCode(3.5714, PROJECTS));
    expect(r.ok, String(r.error)).toBe(true);
    const ground = r.parts!.find((p) => /Ground/.test(p.name))!;
    for (const [i, want] of [60, 1, 40].entries()) expect(ground.size[i]).toBeCloseTo(want * 3.5714, 2);
    for (const [i, want] of [0, -0.5, 0].entries()) expect(ground.origin[i]).toBeCloseTo(want * 3.5714, 2);
  }, 300_000);

  it('each piece exports as its own model: its boxes, centred, at their place in the piece', () => {
    expect(pieces.Arrow!.length).toBe(3);
    expect(pieces.Pillar!.length).toBe(2);
    expect(pieces.Slab!.length).toBe(1);
    // the slab's origin is at a corner: its box centre is (2, 1, 0.25) in Blender, (-2, 0.25, 1) in Roblox
    expect(pieces.Slab![0]).toMatchObject({ name: 'Slab', origin: [-2, 0.25, 1], size: [4, 0.5, 2] });
    for (const [piece, parts] of Object.entries(pieces)) {
      const have = new Set(parts.flatMap((p) => Array.from({ length: mesh(p.name).v.length / 3 }, (_, i) => key(fromRoblox([0, 1, 2].map((k) => mesh(p.name).v[i * 3 + k]! + p.origin[k]!))))));
      const want = new Set(BOXES[piece]!.flatMap((b) => corners(b).map(key)));
      expect([...have].sort(), piece).toEqual([...want].sort());
    }
  });

  it('every vertex of every placed part lands where Kiln\'s matrix puts it, through the copy that is uploaded', () => {
    const plan = planLayout({ map: 'Ref', manifest, own: own.map((p) => toLayoutPart(p)), pieces: Object.fromEntries(Object.entries(pieces).map(([name, parts]) => [name, { model: name, studsPerUnit: 1, parts: parts.map((p) => toLayoutPart(p)) }])) });
    expect(plan.notes).toEqual([]);
    expect(plan.counts).toMatchObject({ placements: 10, placed: 10, mirrored: 0, sheared: 0 });
    /** A part's mesh as the MeshPart holds it: the uploaded copy (turned first), turned back by Roblox's importer. */
    const delivered = (part: string): number[][] => accessorRows(glbTurned180(readFileSync(join(dir, `${part}.glb`))), 0).map(([x, y, z]) => [-x!, y!, -z!]);
    let checked = 0;
    for (const pl of manifest.placements) {
      const unit = plan.units.find((u) => u.name === pl.name)!;
      const world = new Set<string>();
      for (const use of unit.uses) for (const v of delivered(plan.templates[use.t]!.name)) world.add(key(fromRoblox(studio(use, v))));
      const truth = new Set(BOXES[pl.piece]!.flatMap((b) => corners(b).map((c) => key([0, 1, 2].map((i) => pl.matrix[i]![0] * c[0] + pl.matrix[i]![1] * c[1] + pl.matrix[i]![2] * c[2] + pl.matrix[i]![3])))));
      expect([...world].sort(), pl.name).toEqual([...truth].sort());
      checked += world.size;
      // and Kiln's own answers: the piece's origin and its X, Y, Z points, from any part of it
      const want = expected.placements[pl.name]!;
      const part = pieces[pl.piece]![0]!;
      const use = unit.uses.find((u) => plan.templates[u.t]!.name === part.name)!;
      for (const [k, p] of Object.entries({ origin: [0, 0, 0], x1: [1, 0, 0], y1: [0, 1, 0], z1: [0, 0, 1] })) {
        const q = [-p[0]! - part.origin[0], p[2]! - part.origin[1], p[1]! - part.origin[2]];
        const got = fromRoblox(studio(use, q));
        for (let i = 0; i < 3; i++) expect(got[i], `${pl.name} ${k}`).toBeCloseTo(want[k as 'origin'][i]!, 2);
      }
    }
    expect(checked).toBe(142); // the corners of every placed box (shared ones once per placement)
    // the examples Kiln names
    const tall = plan.units.find((u) => u.name === 'Pillar_Tall_001')!;
    const body = tall.uses.find((u) => /Body/.test(plan.templates[u.t]!.name))!;
    const top = Math.max(...delivered(plan.templates[body.t]!.name).map((v) => fromRoblox(studio(body, v))[2]));
    expect(top).toBeCloseTo(10, 3); // 4 tall, 2.5 times as tall
  });
});
