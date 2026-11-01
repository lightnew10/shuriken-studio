import { afterAll, describe, expect, it } from 'vitest';
import { ExportHarness, blender, meshArea } from './helpers/blender-export';

// Roblox's part limits in the Blender export (roblox_export.py): at most 2,048 studs on a side (the export cuts at
// 2,000) and 10,000 triangles per part. A Kiln map is 9.2 km across: its ground, roads and rails are far wider than
// one part, so they come out as tiles on a grid (cutting the triangles that cross a tile's edge, keeping UVs, normals,
// textures and material) and, within a tile, as slabs when it has too many triangles. Real Blender; skipped without it.

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

/** Scene helper: a quad / grid object with its own UV layer (u from Blender x, v from Blender y) painted with `mat`. */
const PRELUDE = `
import bmesh
def grid_object(name, x0, x1, y0, y1, nx, ny, z, mat, up=True):
    bm = bmesh.new()
    vs = [[bm.verts.new((x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny, z)) for i in range(nx + 1)] for j in range(ny + 1)]
    uv = bm.loops.layers.uv.new("UVMap")
    for j in range(ny):
        for i in range(nx):
            quad = [vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]]
            if not up:
                quad.reverse()
            f = bm.faces.new(quad)
            for l in f.loops:
                l[uv].uv = ((l.vert.co.x - x0) / (x1 - x0), (l.vert.co.y - y0) / (y1 - y0))
    o = kiln.mesh_object(name, bm)
    kiln.paint(o, mat)
    return o
`;

describe.skipIf(!blender)('Roblox export: parts wider than a part can be', () => {
  it('cuts a 5,000 x 3,000 stud textured quad (two triangles) into tiles of at most 2,000 studs that keep UVs, normals, texture and area', async () => {
    await harness!.python(`${PRELUDE}
kiln.clear()
road = kiln.textured("Tarmac", kiln.image("TarmacPixels", [["#222222", "#444444"], ["#333333", "#555555"]]), metallic=0.0)
grid_object("Ground", -2500, 2500, -1500, 1500, 1, 1, 0, road)
`);
    const r = await harness!.export('Map');
    expect(r.parts.length).toBe(6); // 3 columns x 2 rows
    for (const p of r.parts) {
      expect(Math.max(...p.size), p.name).toBeLessThanOrEqual(2000);
      expect(p.piece![1]).toBe(6);
      expect(p.tile).toBeTruthy();
      expect(p.textures?.color, p.name).toBeTruthy(); // every tile keeps the material's maps
      expect(p.blender_material).toBe('Tarmac');
      expect(p.triangles).toBeLessThanOrEqual(10_000);
    }
    expect(new Set(r.parts.map((p) => p.piece![0])).size).toBe(6);
    expect(new Set(r.parts.map((p) => p.textures!.color)).size).toBe(1); // one shared map, not one per tile
    let area = 0;
    for (const p of r.parts) {
      const m = harness!.mesh(p.name);
      area += meshArea(m);
      expect(m.uv?.length, p.name).toBe((m.v.length / 3) * 2);
      for (let i = 0; i < m.v.length / 3; i++) {
        const wx = m.v[i * 3]! + p.origin[0];
        const wy = m.v[i * 3 + 1]! + p.origin[1];
        const wz = m.v[i * 3 + 2]! + p.origin[2];
        expect(Math.abs(wy)).toBeLessThan(1e-3);
        // Blender (x, y, z) is Roblox (-x, z, y); the export's UVs have a top-left origin (v flipped).
        expect(m.uv![i * 2]!).toBeCloseTo((2500 - wx) / 5000, 3);
        expect(m.uv![i * 2 + 1]!).toBeCloseTo(1 - (wz + 1500) / 3000, 3);
        // the normal still points up (+Y), unit length
        expect(m.n[i * 3]!).toBeCloseTo(0, 2);
        expect(m.n[i * 3 + 1]!).toBeCloseTo(1, 2);
        expect(m.n[i * 3 + 2]!).toBeCloseTo(0, 2);
      }
    }
    expect(area).toBeCloseTo(5000 * 3000, -2);
    // the whole thing is still 5,000 x 3,000
    expect(r.size[0]).toBeCloseTo(5000, 1);
    expect(r.size[2]).toBeCloseTo(3000, 1);
    // a GLB per tile as well
    for (const p of r.parts) expect(harness!.has(`${p.name}.glb`)).toBe(true);
  }, 240_000);

  it('cuts a tower taller than 2,000 studs along Y too', async () => {
    await harness!.python(`
kiln.clear()
m = kiln.mat("Rock", base="#777777", roughness=0.9)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
t = kiln.mesh_object("Tower", bm); t.scale = (100, 100, 3000); t.location = (0, 0, 1500); kiln.paint(t, m)
`);
    const r = await harness!.export('Tower');
    expect(r.parts.length).toBe(2);
    for (const p of r.parts) {
      expect(p.size[1], p.name).toBeLessThanOrEqual(2000);
      expect(p.size[1]).toBeCloseTo(1500, 1);
      expect(p.size[0]).toBeCloseTo(100, 1);
    }
    // the two halves stack: together they span the tower's 3,000 studs
    const lo = Math.min(...r.parts.map((p) => p.origin[1] - p.size[1] / 2));
    const hi = Math.max(...r.parts.map((p) => p.origin[1] + p.size[1] / 2));
    expect(hi - lo).toBeCloseTo(3000, 1);
    // nothing is lost or doubled: the cut surfaces are the tower's own (nothing is capped, the halves just abut)
    const area = r.parts.reduce((a, p) => a + meshArea(harness!.mesh(p.name)), 0);
    expect(area).toBeCloseTo(2 * 100 * 100 + 4 * 100 * 3000, -2);
  }, 240_000);

  it('cuts a wide ground of 28,800 triangles into tiles that each keep to 10,000 triangles, losing nothing', async () => {
    await harness!.python(`${PRELUDE}
kiln.clear()
g = kiln.mat("Grass", base="#4a7a2a", roughness=1.0)
grid_object("Ground", -4000, 4000, -4000, 4000, 120, 120, 0, g)
`);
    const r = await harness!.export('Field');
    expect(r.parts.length).toBeGreaterThanOrEqual(4);
    for (const p of r.parts) {
      expect(p.triangles, p.name).toBeLessThanOrEqual(10_000);
      expect(Math.max(...p.size), p.name).toBeLessThanOrEqual(2000);
      expect(p.material).toBeTruthy();
    }
    const area = r.parts.reduce((a, p) => a + meshArea(harness!.mesh(p.name)), 0);
    expect(area).toBeCloseTo(8000 * 8000, -3);
    // no gaps between tiles: the union of their boxes is the whole ground
    const lo = [Math.min(...r.parts.map((p) => p.origin[0] - p.size[0] / 2)), Math.min(...r.parts.map((p) => p.origin[2] - p.size[2] / 2))];
    const hi = [Math.max(...r.parts.map((p) => p.origin[0] + p.size[0] / 2)), Math.max(...r.parts.map((p) => p.origin[2] + p.size[2] / 2))];
    expect(hi[0]! - lo[0]!).toBeCloseTo(8000, 0);
    expect(hi[1]! - lo[1]!).toBeCloseTo(8000, 0);
  }, 240_000);

  it('leaves a model that fits in one part exactly as before: one part, no tile', async () => {
    await harness!.python(`
kiln.clear()
m = kiln.mat("Crate", base="#9a6b3f", roughness=0.8)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=3.5)
c = kiln.mesh_object("Crate", bm); c.location = (0, 0, 1.75); kiln.paint(c, m)
`);
    const r = await harness!.export('Crate');
    expect(r.parts.length).toBe(1);
    expect(r.parts[0]!.tile).toBeUndefined();
    expect(r.parts[0]!.piece).toBeUndefined();
    expect(r.parts[0]!.triangles).toBe(12);
  }, 120_000);
});
