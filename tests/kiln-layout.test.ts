import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCheck, parseManifest, parseMat4, sortProblems, type Mat4, type Vec3 } from '../src/core/modeling/kiln-manifest';
import { batchUnits, decompose, eulerYXZ, fromRoblox, markerFrame, mulV, partUse, placementFrame, planLayout, rotationYXZ, toRoblox, type LayoutPart, type M3, type PlanUse } from '../src/core/modeling/kiln-layout';
import { glbTurned180 } from '../src/core/modeling/glb';
import { accessorRows, makeGlb } from './helpers/glb';

// Kiln's Roblox manifest v2 (a map: pieces, placements, markers, paths) read into a typed structure, and the plan of
// what Studio must hold. The ground truth is Kiln's reference layout (tests/fixtures/kiln-layout-reference: its
// roblox.json and the expected.json Kiln computed from its own matrices): every placed piece's reference points must
// land where Kiln says, through the whole chain (the axis change, the CFrame and Size sent to Studio, and the upload
// path: Shuriken's pre-turn and Roblox's importer turning the mesh 180 degrees about Y).

const FIXTURE = resolve(__dirname, 'fixtures', 'kiln-layout-reference');
const rawManifest = JSON.parse(readFileSync(join(FIXTURE, 'roblox.json'), 'utf8')) as Record<string, unknown>;
const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')) as {
  placements: Record<string, { piece: string; origin: Vec3; x1: Vec3; y1: Vec3; z1: Vec3 }>;
  markers: Record<string, { role: string; position: Vec3; facing: Vec3 }>;
  paths: Record<string, { role: string; width: number; closed: boolean; first: Vec3; last: Vec3; points: number }>;
};

/** A box of a piece in the piece's own space (Blender axes), as Kiln's make_fixture.py builds them: one part each. */
const box = (name: string, lo: Vec3, hi: Vec3, over: Partial<LayoutPart> = {}): LayoutPart => ({
  name,
  origin: toRoblox([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]),
  size: [hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]],
  hash: `h-${name}`,
  asset: '1000',
  legacy: false,
  ...over,
});
const PIECES = (over: Partial<LayoutPart> = {}) => ({
  Arrow: { model: 'Arrow', studsPerUnit: 1, parts: [box('Arrow_Shaft', [0, -0.25, 0], [3, 0.25, 0.5], over), box('Arrow_Fin', [0, 0.25, 0], [0.5, 1.25, 0.5], over), box('Arrow_Post', [0, -0.25, 0.5], [0.5, 0.25, 2], over)] },
  Pillar: { model: 'Pillar', studsPerUnit: 1, parts: [box('Pillar_Body', [-0.5, -0.5, 0], [0.5, 0.5, 4], over), box('Pillar_Step', [-0.5, -1.5, 0], [0.5, -0.5, 1], over)] },
  Slab: { model: 'Slab', studsPerUnit: 1, parts: [box('Slab', [0, 0, 0], [4, 2, 0.5], over)] },
});

/** What Studio does with a use: CFrame.new(p) * CFrame.fromOrientation(r) applied to the mesh's own point times Size / mesh size. */
const studio = (u: Pick<PlanUse, 'p' | 'r' | 's'>, local: readonly number[], half = false): Vec3 => {
  let R = rotationYXZ(u.r);
  if (half) R = R.map((row) => [-row[0], row[1], -row[2]]) as M3; // CFrame * Angles(0, pi, 0)
  const w = mulV(R, [local[0]! * u.s[0], local[1]! * u.s[1], local[2]! * u.s[2]]);
  return [w[0] + u.p[0], w[1] + u.p[1], w[2] + u.p[2]];
};
const close = (a: readonly number[], b: readonly number[], tol: number, what: string) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!), `${what}: got ${a.map((v) => v.toFixed(4))}, want ${b.map((v) => v.toFixed(4))}`).toBeLessThan(tol);
};

describe('manifest v2', () => {
  it('reads the reference layout: units, meshes, materials, pieces, placements, markers, paths, roles, colliders', () => {
    const { manifest: m, notes } = parseManifest(rawManifest, FIXTURE);
    expect(notes).toEqual([]);
    expect(m).toMatchObject({ version: 2, plain: true, units: 'studs', studsPerUnit: 1, sourceVersion: 1, objects: 4, tris: 48 });
    // a file name (the fixture) is resolved against the manifest's folder
    expect(m.blend).toBe(join(FIXTURE, 'roblox.blend'));
    expect(m.meshes.Wall_North).toEqual({ objects: ['Wall_North', 'Wall_South'], tris: 12 });
    expect(m.materials.map((x) => [x.name, x.plain, x.color, x.robloxMaterial])).toEqual([['Ground_Mat', true, '#55585c', 'Asphalt'], ['Wall_North_Mat', true, '#b0b0b0', null], ['Shed_Mat', true, '#806040', null]]);
    expect(m.pieces.Arrow).toEqual({ project: 'fixture-arrow', version: 1, fingerprint: 'fixture-fixture-arrow', tris: 36, placements: 4, stale: false });
    expect(m.placements).toHaveLength(10);
    expect(m.placements.find((p) => p.name === 'Pillar_Tall_001')!.matrix[2]).toEqual([0, 0, 2.5, 0]);
    expect(m.mirroredPlacements).toEqual([]);
    expect(m.markers).toEqual([{ name: 'Spawn_A', role: 'spawn', matrix: [[-0, -1, 0, -25], [1, -0, 0, -18], [0, 0, 1, 0.5], [0, 0, 0, 1]] }]);
    expect(m.paths).toEqual([{ name: 'Center_Line', role: 'road_centerline', points: [[-25, -18, 0], [0, -18, 0], [25, -10, 0], [25, 10, 0]], width: 8, closed: false }]);
    expect(m.roles).toEqual({ Ground: 'drivable', Shed: 'decor', Wall_North: 'barrier', Wall_South: 'barrier' });
    expect(m.colliders).toEqual([{ name: 'Shed_Collider', standsFor: 'Shed' }]);
  });

  it('keeps absolute paths as they are (a real export)', () => {
    const abs = resolve(FIXTURE, 'elsewhere', 'roblox.blend');
    const { manifest } = parseManifest({ ...rawManifest, blend: abs, materials: [{ name: 'Bark', size: 512, maps: { color: resolve(FIXTURE, 'Bark.color.png'), normal: 'Bark.normal.png' } }] }, FIXTURE);
    expect(manifest.blend).toBe(abs);
    expect(manifest.materials[0]!.maps).toEqual({ color: resolve(FIXTURE, 'Bark.color.png'), normal: join(FIXTURE, 'Bark.normal.png') });
    expect(manifest.materials[0]!.plain).toBe(false);
  });

  it('an older manifest (version 1) is a note, not a crash: no map data, studs from the units', () => {
    const { manifest: m, notes } = parseManifest({ version: 1, blend: 'C:/x/roblox.blend', units: 'm', materials: [{ name: 'Skin', size: 1024, maps: { color: 'C:/x/Skin.color.png' }, roughness: null, metallic: 0 }], objects: 3, tris: 900 });
    expect(m.version).toBe(1);
    expect(m.studsPerUnit).toBeCloseTo(3.5714, 3);
    expect(m.plain).toBe(false);
    expect(m.placements).toEqual([]);
    expect(m.pieces).toEqual({});
    expect(m.markers).toEqual([]);
    expect(m.paths).toEqual([]);
    expect(m.meshes).toEqual({});
    expect(m.sourceFingerprint).toBeNull();
    expect(notes.join('\n')).toMatch(/version 1 \(before Kiln 0\.8\)/);
  });

  it('missing and malformed fields degrade to notes', () => {
    const { manifest: m, notes } = parseManifest({
      version: 2,
      blend: 'C:/x/roblox.blend',
      units: 'm',
      placements: [
        { name: 'Ok_001', piece: 'Tree', matrix: [[1, 0, 0, 5], [0, 1, 0, 6], [0, 0, 1, 7]] }, // 3 rows are enough; no project: the piece's
        { name: 'NoMatrix', piece: 'Tree' },
        { name: 'BadNumbers', piece: 'Tree', matrix: [[1, 0, 0, 'x'], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
        'nonsense',
      ],
      pieces: { Tree: { project: 'tree-abc', stale: true }, Broken: 5 },
      markers: [{ name: 'M', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }, { role: 'spawn' }],
      paths: [{ name: 'OnePoint', points: [[0, 0, 0]] }, { name: 'Line', points: [[0, 0, 0], [1, 2, 3], ['a', 0, 0]], closed: true }],
      materials: [{ name: 'Road', roblox_material: 'Asphalt', color: '#333333' }, { color: '#fff' }],
      colliders: [{ name: 'Box' }, {}],
      mirrored_placements: ['Flip_001', 7],
    });
    expect(m.studsPerUnit).toBeCloseTo(1 / 0.28, 6);
    expect(m.placements).toEqual([{ name: 'Ok_001', piece: 'Tree', project: 'tree-abc', matrix: [[1, 0, 0, 5], [0, 1, 0, 6], [0, 0, 1, 7], [0, 0, 0, 1]] }]);
    expect(m.pieces).toEqual({ Tree: { project: 'tree-abc', version: 0, fingerprint: '', tris: 0, placements: 0, stale: true } });
    expect(m.markers.map((x) => [x.name, x.role])).toEqual([['M', 'marker']]);
    expect(m.paths).toEqual([{ name: 'Line', role: 'path', points: [[0, 0, 0], [1, 2, 3]], width: null, closed: true }]);
    expect(m.materials).toHaveLength(1);
    expect(m.materials[0]).toMatchObject({ name: 'Road', plain: true, robloxMaterial: 'Asphalt', color: '#333333', maps: {} });
    expect(m.colliders).toEqual([{ name: 'Box', standsFor: null }]);
    expect(m.mirroredPlacements).toEqual(['Flip_001']);
    const text = notes.join('\n');
    expect(text).toMatch(/studs_per_unit is missing: taken as 3\.5714 from units "m"/);
    expect(text).toMatch(/3 placements in the manifest could not be read/);
    expect(text).toMatch(/1 piece in the manifest could not be read/);
    expect(text).toMatch(/1 marker /);
    expect(text).toMatch(/1 path /);
    expect(text).toMatch(/1 material /);
    expect(text).toMatch(/1 collider /);
    // nothing at all is still a manifest
    for (const junk of [null, undefined, 'text', 42, []]) {
      const r = parseManifest(junk);
      expect(r.manifest.placements).toEqual([]);
      expect(r.manifest.studsPerUnit).toBe(1);
      expect(r.notes.length).toBeGreaterThan(0);
    }
    expect(parseMat4([[1, 2, 3, 4], [5, 6, 7, 8]])).toBeNull();
  });

  it("reads Kiln's check and sorts its problems by what they mean for an import", () => {
    // Kiln 0.8.1's check of the user's 9.2 km map (GET /projects/:id/roblox), shortened.
    const check = parseCheck({
      problems: [
        'Material "Corrugated_Metal" has metalness 0.30: Roblox metal is all or nothing. Use 1 for bare metal (with a light base colour) or 0 for painted, dirty or rusted metal.',
        'Material "Fence_ChainLink" is see-through (alpha): Roblox parts with textures are opaque. Make it opaque, or keep see-through pieces as their own untextured parts.',
        'Too big for one Roblox part (2,048 studs at most on a side): Ridge_Layer_1 (16,429 studs), Ridge_Layer_2 (23,571 studs), Ridge_Layer_3 (32,857 studs). kiln.tile(obj, size) cuts it into tiles.',
        'Too many triangles for one Roblox part (20,000 at most per object or joint, and material): Terrain / Grass: 81,204. Split the part (kiln.tile cuts ground into tiles), or kiln.decimate / kiln.bake it.',
        "Mirrored placements (House_003): a placed piece can't be mirrored. Give them a positive scale, or build the mirrored piece as its own project.",
      ],
      notes: ['1032 objects are copies of 15 shared meshes: each mesh is uploaded once and cloned.'],
      summary: 'Roblox check: 5 problems, 1 note.',
      materials: 106,
      tris: 521727,
      meshes: 356,
      layout: { pieces: { Tree: {}, House: {} }, placements: 12, markers: 3, paths: 1, roles: 40, colliders: 2 },
    });
    expect(check.meshes).toBe(356);
    expect(check.layout).toEqual({ pieces: 2, placements: 12, markers: 3, paths: 1, roles: 40, colliders: 2 });
    const s = sortProblems(check.problems);
    expect(s.blocking).toHaveLength(1);
    expect(s.blocking[0]).toMatch(/^Mirrored placements/);
    expect(s.handled.map((p) => p.slice(0, 12))).toEqual(['Too big for ', 'Too many tri']);
    expect(s.look).toHaveLength(2);
    // an old Kiln's check (no layout, no meshes) and no check at all
    expect(parseCheck({ problems: ['x'], summary: 's' })).toEqual({ problems: ['x'], notes: [], summary: 's', meshes: null, layout: null });
    expect(parseCheck(undefined)).toEqual({ problems: [], notes: [], summary: '', meshes: null, layout: null });
  });
});

describe('Blender Z-up to Roblox Y-up', () => {
  it('maps (x, y, z) to (-x, z, y) times the studs per unit, and back', () => {
    expect(toRoblox([1, 2, 3])).toEqual([-1, 3, 2]);
    expect(toRoblox([1, 2, 3], 3.5714)).toEqual([-3.5714, 10.7142, 7.1428]);
    expect(fromRoblox(toRoblox([4, -5, 6], 3.5714), 3.5714).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([4, -5, 6]);
    // a model's front (Blender -Y) is Roblox's forward (-Z); up is up
    expect(toRoblox([0, -1, 0])).toEqual([-0, 0, -1]);
    expect(toRoblox([0, 0, 1])).toEqual([-0, 1, 0]);
  });

  it('a placement by hand: turned 90 degrees about Z, scaled (2, 1, 1), moved to (10, 20, 5), in meters', () => {
    // Blender: world = Rz(90) diag(2, 1, 1) p + t. The point (1, 2, 3): diag -> (2, 2, 3); Rz(90) -> (-2, 2, 3); + t -> (8, 22, 8).
    const M: Mat4 = [[0, -1, 0, 10], [2, 0, 0, 20], [0, 0, 1, 5], [0, 0, 0, 1]];
    const k = 3.5714;
    // The piece is its own project in meters too: its exported model is in studs, q = k * (-x, z, y).
    const frame = placementFrame(M, k, k);
    const q = toRoblox([1, 2, 3], k);
    const w = mulV(frame.B, q).map((v, i) => v + frame.d[i]!);
    close(w, [-8 * k, 8 * k, 22 * k], 1e-9, 'the point in Roblox');
    // As a MeshPart: the scale 2 is along the piece's own X (Roblox X too), the turn is a yaw of +90 degrees about Y
    // (Blender's Z up is Roblox's Y up, and the axis change is a rotation, so the sense is kept).
    const u = partUse(frame, [0, 0, 0])!;
    expect(u.scale.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([2, 1, 1]);
    expect(u.rotation.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 90, 0]);
    close(u.position, [-10 * k, 5 * k, 20 * k], 1e-9, 'the pivot');
    close(studio({ p: u.position, r: u.rotation, s: u.scale }, q), [-8 * k, 8 * k, 22 * k], 1e-9, 'through CFrame and Size');
    // A piece built in studs placed in a layout in meters: its numbers are read as meters there, so it is 3.5714 times bigger.
    const mixed = partUse(placementFrame(M, k, 1), [0, 0, 0])!;
    expect(mixed.scale.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([7.1428, 3.5714, 3.5714]);
  });

  it('decomposes rotation times non-uniform scale exactly, flags mirrors and shear, and round-trips Euler angles', () => {
    for (const d of [[10, 20, 30], [-80, 170, 5], [0, 0, 0], [89.9, -45, 120], [90, 30, 0], [-90, 200, 0]] as Vec3[]) {
      const R = rotationYXZ(d);
      const S: Vec3 = [0.5, 2, 1.25];
      const dec = decompose(R.map((row) => row.map((v, j) => v * S[j]!)) as M3)!;
      expect(dec.mirrored).toBe(false);
      expect(dec.sheared).toBe(false);
      close(dec.S, S, 1e-9, 'scale');
      const back = rotationYXZ(eulerYXZ(dec.R));
      for (let i = 0; i < 3; i++) close(back[i]!, R[i]!, 1e-9, `rotation ${d.join(',')}`);
    }
    expect(decompose([[-1, 0, 0], [0, 1, 0], [0, 0, 1]])!.mirrored).toBe(true);
    expect(decompose([[1, 0.5, 0], [0, 1, 0], [0, 0, 1]])!.sheared).toBe(true);
    expect(decompose([[1, 0, 0], [0, 0, 0], [0, 0, 1]])).toBeNull();
    // Kiln rounds matrices to 5 decimals: that is not shear
    expect(decompose([[0.86603, -0.5, 0], [0.5, 0.86603, 0], [0, 0, 2.5]])!.sheared).toBe(false);
  });
});

describe("Kiln's reference layout through the whole chain", () => {
  const { manifest } = parseManifest(rawManifest, FIXTURE);
  const POINTS = { origin: [0, 0, 0], x1: [1, 0, 0], y1: [0, 1, 0], z1: [0, 0, 1] } as const;

  it('every placement puts the piece\'s origin and its X, Y and Z points where Kiln says (each part of each piece agrees)', () => {
    const plan = planLayout({ map: 'Reference', manifest, own: [], pieces: PIECES() });
    expect(plan.notes).toEqual([]);
    expect(plan.counts).toMatchObject({ placements: 10, placed: 10, parts: 4 * 3 + 3 * 2 + 3, mirrored: 0, sheared: 0, missingPieces: 0 });
    expect(Object.keys(expected.placements)).toHaveLength(10);
    for (const [name, want] of Object.entries(expected.placements)) {
      const unit = plan.units.find((u) => u.name === name)!;
      expect(unit, name).toBeTruthy();
      const parts = PIECES()[want.piece as 'Arrow'].parts;
      expect(unit.uses).toHaveLength(parts.length);
      for (const use of unit.uses) {
        const part = parts.find((p) => p.name === plan.templates[use.t]!.name)!;
        for (const [key, p] of Object.entries(POINTS)) {
          // the point in the piece's exported model (Roblox space), relative to this part's mesh (centred on its box)
          const q = toRoblox(p);
          const local = [q[0] - part.origin[0], q[1] - part.origin[1], q[2] - part.origin[2]];
          close(fromRoblox(studio(use, local)), want[key as 'origin'], 2e-3, `${name} ${part.name} ${key}`);
        }
      }
      // the unit's pivot is the piece's own origin
      close(fromRoblox(unit.pivot.p), want.origin, 2e-3, `${name} pivot`);
    }
    // the examples Kiln names: non-uniform scale is kept, a tip about X lays the pillar on its back
    const tall = plan.units.find((u) => u.name === 'Pillar_Tall_001')!;
    expect(tall.uses[0]!.s).toEqual([1, 2.5, 1]); // Blender Z (up) is the MeshPart's Y
    const stretched = plan.units.find((u) => u.name === 'Slab_Stretched_001')!;
    expect(stretched.uses[0]!.s).toEqual([0.5, 1, 2]); // Blender (0.5, 2, 1) -> Roblox (x, z, y)
    expect(plan.units.find((u) => u.name === 'Arrow_Scaled2_001')!.uses.every((u) => u.s.join() === '2,2,2')).toBe(true);
  });

  it('the upload path keeps it: the pre-turned copy that Roblox turns back, and a legacy upload turned back in Luau', () => {
    // The Arrow's fin as a mesh centred on its box (what mesh.json and the GLB hold): asymmetric about every axis.
    const fin = PIECES().Arrow.parts[1]!;
    const corner = toRoblox([0.5, 1.25, 0.5]); // the fin's far corner: +X, +Y (the fin's side), top
    const local: Vec3 = [corner[0] - fin.origin[0], corner[1] - fin.origin[1], corner[2] - fin.origin[2]];
    const glb = makeGlb({ positions: [...local, 0, 0, 0, 0.1, 0, 0], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2] });
    /** Roblox's importer: (x, y, z) -> (-x, y, -z). */
    const importer = (rows: number[][]) => rows.map(([x, y, z]) => [-x!, y!, -z!]);
    // Today's uploads: the copy that goes up is turned first, the importer turns it back: the MeshPart holds the mesh as exported.
    const marked = importer(accessorRows(glbTurned180(glb), 0))[0]!;
    close(marked, local, 1e-6, 'a marked upload arrives as exported');
    // A legacy upload went up as exported: the MeshPart holds the mesh turned, and the Luau multiplies the CFrame by Angles(0, pi, 0).
    const legacy = importer(accessorRows(glb, 0))[0]!;
    for (const name of ['Arrow_Turn90_001', 'Arrow_Scaled2_001', 'Arrow_TurnMinus45_001']) {
      const pl = manifest.placements.find((p) => p.name === name)!;
      const truth = [0, 1, 2].map((i) => pl.matrix[i]![0] * 0.5 + pl.matrix[i]![1] * 1.25 + pl.matrix[i]![2] * 0.5 + pl.matrix[i]![3]);
      const plan = planLayout({ map: 'Reference', manifest, own: [], pieces: PIECES() });
      const use = plan.units.find((u) => u.name === name)!.uses.find((u) => plan.templates[u.t]!.name === 'Arrow_Fin')!;
      close(fromRoblox(studio(use, marked)), truth, 2e-3, `${name}: marked upload`);
      close(fromRoblox(studio(use, legacy, true)), truth, 2e-3, `${name}: legacy upload, turned back`);
      // and without the turn a legacy mesh would be wrong (the asymmetric fin shows it)
      const wrong = fromRoblox(studio(use, legacy, false));
      expect(Math.hypot(wrong[0] - truth[0]!, wrong[1] - truth[1]!, wrong[2] - truth[2]!)).toBeGreaterThan(0.4);
    }
    // the plan marks a legacy part's template, so the Luau turns its clones
    const old = planLayout({ map: 'Reference', manifest, own: [], pieces: PIECES({ legacy: true }) });
    expect(old.templates.every((t) => t.turn)).toBe(true);
    expect(planLayout({ map: 'Reference', manifest, own: [], pieces: PIECES() }).templates.some((t) => t.turn)).toBe(false);
  });

  it('the marker is an anchor whose LookVector is its +Y, and the path is in studs', () => {
    const plan = planLayout({ map: 'Reference', manifest, own: [], pieces: PIECES() });
    const want = expected.markers.Spawn_A!;
    const m = plan.markers[0]!;
    expect(m).toMatchObject({ name: 'Spawn_A', role: 'spawn' });
    close(fromRoblox(m.p), want.position, 1e-4, 'marker position');
    close(fromRoblox(m.look), want.facing, 1e-4, 'marker facing');
    // what Studio builds from the numbers: the part's LookVector is -Z of CFrame.fromOrientation(r); its UpVector is world up
    const R = rotationYXZ(m.r);
    close(fromRoblox([-R[0][2], -R[1][2], -R[2][2]]), want.facing, 1e-4, 'LookVector');
    close([R[0][1], R[1][1], R[2][1]], [0, 1, 0], 1e-4, 'UpVector');
    // an unturned marker faces Blender +Y, which is Roblox +Z: a half turn from a part's default look (-Z)
    const plain = markerFrame([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], 1);
    close(plain.look, [0, 0, 1], 1e-9, 'unturned marker');
    expect(Math.abs(Math.abs(plain.rotation[1]) - 180)).toBeLessThan(1e-6);
    // a tilted marker keeps its up (a start grid on a banked road): its +Z is the part's UpVector
    const tilt = markerFrame([[1, 0, 0, 0], [0, 0.86603, -0.5, 0], [0, 0.5, 0.86603, 0], [0, 0, 0, 1]], 1);
    const Rt = rotationYXZ(tilt.rotation);
    close(fromRoblox([Rt[0][1], Rt[1][1], Rt[2][1]]), [0, -0.5, 0.86603], 1e-4, 'tilted up');
    close(fromRoblox(tilt.look), [0, 0.86603, 0.5], 1e-4, 'tilted facing');

    const p = plan.paths[0]!;
    const wantPath = expected.paths.Center_Line!;
    expect(p).toMatchObject({ name: 'Center_Line', role: 'road_centerline', width: 8, closed: false });
    expect(p.points).toHaveLength(wantPath.points);
    close(fromRoblox(p.points[0]!), wantPath.first, 1e-6, 'first point');
    close(fromRoblox(p.points.at(-1)!), wantPath.last, 1e-6, 'last point');
    expect(p.length).toBeCloseTo(25 + Math.hypot(25, 8) + 20, 3);
    // meters: points and width are multiplied by the studs per unit
    const meters = planLayout({ map: 'M', manifest: { ...manifest, studsPerUnit: 3.5714 }, own: [], pieces: {} });
    expect(meters.paths[0]!.width).toBeCloseTo(8 * 3.5714, 3);
    expect(meters.paths[0]!.points[0]).toEqual([89.285, 0, -64.2852]);
    close(meters.markers[0]!.p, toRoblox(want.position, 3.5714), 1e-3, 'marker in meters');
  });
});

describe('the plan', () => {
  const { manifest } = parseManifest(rawManifest, FIXTURE);
  const own: LayoutPart[] = [
    { name: 'Map_Ground', origin: [0, -0.5, 0], size: [60, 1, 40], role: 'drivable', color: '#55585c', material: 'Asphalt', hash: 'g', asset: '1', legacy: false },
    { name: 'Map_Wall', origin: [0, 1.5, 20.5], size: [60, 3, 1], role: 'barrier', box: true, hash: 'w', asset: '2', legacy: false, instances: [{ position: [0, 1.5, 20.5], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [0, 1.5, -20.5], rotation: [0, 180, 0], scale: [1, 1, 1] }] },
    { name: 'Map_Shed', origin: [-23, 2, 13], size: [6, 4, 6], role: 'decor', replaced: true, hash: 's', asset: '3', legacy: false },
    { name: 'Map_ShedCollider', origin: [-23, 2, 13], size: [6, 4, 6], role: 'collider', box: true, hash: 'c', asset: '4', legacy: false },
  ];

  it('one template per unique mesh, one unit per placement and per part of the layout, grouped by grid cell', () => {
    const plan = planLayout({ map: 'Map', manifest, own, pieces: PIECES() });
    expect(plan.templates.map((t) => t.name).sort()).toEqual(['Arrow_Fin', 'Arrow_Post', 'Arrow_Shaft', 'Map_Ground', 'Map_Shed', 'Map_ShedCollider', 'Map_Wall', 'Pillar_Body', 'Pillar_Step', 'Slab']);
    // the layout's own parts: single ones are Static, each use of an instanced one sits in its cell
    const statics = plan.units.filter((u) => u.group === 'Static');
    expect(statics.map((u) => u.name)).toEqual(['Map_Ground', 'Map_Shed', 'Map_ShedCollider']);
    expect(statics.every((u) => u.cell === '')).toBe(true);
    expect(plan.units.filter((u) => u.name.startsWith('Map_Wall_')).sort((x, y) => x.name.localeCompare(y.name)).map((u) => [u.name, u.cell, u.uses[0]!.r])).toEqual([['Map_Wall_1', 'c_0_0', [0, 0, 0]], ['Map_Wall_2', 'c_0_-1', [0, 180, 0]]]);
    // placements: a Model's worth of parts each, in the cell of its pivot (Roblox x = -Blender x, z = Blender y)
    const arrow = plan.units.find((u) => u.name === 'Arrow_Turn90_001')!;
    expect(arrow).toMatchObject({ group: 'Pieces', cell: 'c_-1_0', pivot: { p: [-10, 0, 0], r: [0, 90, 0] } });
    expect(arrow.uses).toHaveLength(3);
    // traits come from the part's role: the ground collides precisely, the wall as a box, the shed (stood in for) not at all
    const fx = Object.fromEntries(plan.templates.map((t) => [t.name, t.fx]));
    expect(fx.Map_Ground).toEqual({ cc: true, cq: true, fid: 'PreciseConvexDecomposition' });
    expect(fx.Map_Wall).toEqual({ cc: true, cq: true, fid: 'Box' });
    expect(fx.Map_Shed).toEqual({ cc: false, cq: false, ct: false, sh: false });
    expect(fx.Map_ShedCollider).toMatchObject({ cc: true, fid: 'Box', tr: 1 });
    expect(fx.Slab).toBeNull();
    // a second plan of the same input is the same plan (fingerprints and stamps are stable)
    const again = planLayout({ map: 'Map', manifest, own, pieces: PIECES() });
    expect(again.units.map((u) => u.fp)).toEqual(plan.units.map((u) => u.fp));
    expect(again.templates.map((t) => t.stamp)).toEqual(plan.templates.map((t) => t.stamp));
    // a re-uploaded mesh changes its template's stamp and the fingerprint of every unit that uses it, and nothing else
    const reup = planLayout({ map: 'Map', manifest, own, pieces: { ...PIECES(), Slab: { model: 'Slab', studsPerUnit: 1, parts: [box('Slab', [0, 0, 0], [4, 2, 0.5], { asset: '2000' })] } } });
    const changed = reup.units.filter((u, i) => u.fp !== plan.units[i]!.fp).map((u) => u.name);
    expect(changed.sort()).toEqual(['Slab_Plain_001', 'Slab_Stretched_001', 'Slab_Tilted_001']);
  });

  it("a placement's own role and a collider that stands for it override the parts' collision", () => {
    const m = {
      ...manifest,
      colliders: [...manifest.colliders, { name: 'Pillar_Box', standsFor: 'Pillar_Plain_001' }, { name: 'Slabs_Box', standsFor: 'Slab' }],
      placements: manifest.placements.map((p) => (p.name === 'Arrow_Plain_001' ? { ...p, role: 'decor' } : p.name === 'Arrow_Turn90_001' ? { ...p, role: 'barrier' } : p)),
    };
    const plan = planLayout({ map: 'Map', manifest: m, own: [], pieces: PIECES() });
    const fxOf = (name: string) => plan.units.find((u) => u.name === name)!.uses.map((u) => (u.fx ? plan.fx[u.fx - 1] : null));
    expect(fxOf('Arrow_Plain_001')).toEqual(['{cc=false,cq=false,ct=false,sh=false}', '{cc=false,cq=false,ct=false,sh=false}', '{cc=false,cq=false,ct=false,sh=false}']);
    expect(fxOf('Arrow_Turn90_001')).toEqual(['{cc=true,cq=true,fid="PreciseConvexDecomposition"}', '{cc=true,cq=true,fid="PreciseConvexDecomposition"}', '{cc=true,cq=true,fid="PreciseConvexDecomposition"}']);
    expect(fxOf('Arrow_Scaled2_001')).toEqual([null, null, null]);
    // named by a collider: by its own name, or by its piece
    expect(fxOf('Pillar_Plain_001')).toEqual(['{cc=false,cq=false,ct=false}', '{cc=false,cq=false,ct=false}']);
    expect(fxOf('Pillar_Tall_001')).toEqual([null, null]);
    expect(fxOf('Slab_Tilted_001')).toEqual(['{cc=false,cq=false,ct=false}']);
  });

  it('leaves mirrored placements and pieces without a model out, and says so', () => {
    const flip: Mat4 = [[-1, 0, 0, 3], [0, 1, 0, 4], [0, 0, 1, 0], [0, 0, 0, 1]];
    const m = { ...manifest, placements: [...manifest.placements, { name: 'Arrow_Flip_001', piece: 'Arrow', project: 'fixture-arrow', matrix: flip }, { name: 'Ghost_001', piece: 'Ghost', project: 'gone', matrix: flip }], mirroredPlacements: ['Slab_Plain_001'] };
    const plan = planLayout({ map: 'Map', manifest: m, own: [], pieces: PIECES() });
    expect(plan.counts).toMatchObject({ placements: 12, placed: 9, mirrored: 2, missingPieces: 1 });
    expect(plan.units.some((u) => /Flip|Ghost|Slab_Plain/.test(u.name))).toBe(false);
    expect(plan.notes.join('\n')).toMatch(/Piece "Ghost" has no exported model: its 1 placement was left out/);
    expect(plan.notes.join('\n')).toMatch(/2 mirrored placements were left out/);
  });

  it("a piece that instances its own mesh: each use is placed, and a non-uniform placement of a turned use is flagged as shear", () => {
    const fence: LayoutPart = { name: 'Fence_Post', origin: [0, 1, 0], size: [0.5, 2, 0.5], hash: 'f', asset: '9', legacy: false, instances: [{ position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [-4, 1, 0], rotation: [0, 45, 0], scale: [1, 2, 1] }] };
    const one = (matrix: Mat4) => planLayout({ map: 'M', manifest: { ...manifest, placements: [{ name: 'Fence_001', piece: 'Fence', project: 'p', matrix }], colliders: [] }, own: [], pieces: { Fence: { model: 'Fence', studsPerUnit: 1, parts: [fence] } } });
    // uniform scale 2, turned 90 degrees about Z, at (10, 0, 0)
    const plan = one([[0, -2, 0, 10], [2, 0, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]);
    expect(plan.counts.sheared).toBe(0);
    const [a, b] = plan.units[0]!.uses;
    expect(a!.s).toEqual([2, 2, 2]);
    expect(b!.s).toEqual([2, 4, 2]);
    expect(b!.r[1]).toBeCloseTo(135, 3); // its own 45 degrees on top of the placement's 90
    // the second post sits 4 studs along the piece's Blender +X (Roblox -X in the model), turned by the placement to Blender +Y: 8 units from the pivot
    close(fromRoblox(b!.p), [10, 8, 2], 1e-3, 'the second post');
    // a non-uniform placement: the unturned post is exact, the turned one can only be approximated
    const squashed = one([[3, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
    expect(squashed.counts.sheared).toBe(1);
    expect(squashed.notes.join('\n')).toMatch(/1 part is placed approximately/);
  });

  it('a synthetic giant: 1,400 placements of 350 meshes plan in well under a second and cut into bounded batches', () => {
    const pieces: Record<string, { model: string; studsPerUnit: number; parts: LayoutPart[] }> = {};
    for (let i = 0; i < 175; i++) pieces[`P${i}`] = { model: `P${i}`, studsPerUnit: 3.5714, parts: [box(`P${i}_A`, [-1, -1, 0], [1, 1, 3 + (i % 5)]), box(`P${i}_B`, [-2, -2, 3], [2, 2, 6])] };
    const placements = Array.from({ length: 1400 }, (_, i) => {
      const a = (i * 37) % 360;
      const [c, s] = [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)];
      const f = 0.8 + (i % 7) / 10;
      return { name: `P${i % 175}_${String(i).padStart(4, '0')}`, piece: `P${i % 175}`, project: `proj-${i % 175}`, matrix: [[c * f, -s * f, 0, ((i * 131) % 9200) - 4600], [s * f, c * f, 0, ((i * 977) % 9200) - 4600], [0, 0, f, (i % 13) * 2], [0, 0, 0, 1]] as Mat4 };
    });
    const t0 = Date.now();
    const plan = planLayout({ map: 'Giant', manifest: { ...manifest, studsPerUnit: 3.5714, placements, markers: [], paths: [], colliders: [] }, own: [], pieces });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(plan.templates).toHaveLength(350);
    expect(plan.units).toHaveLength(1400);
    expect(plan.counts).toMatchObject({ placed: 1400, parts: 2800, mirrored: 0, sheared: 0 });
    // 9.2 km in meters is about 32,857 studs: the units spread over many cells, none of them holding everything
    const cells = new Map<string, number>();
    for (const u of plan.units) cells.set(u.cell, (cells.get(u.cell) ?? 0) + 1);
    expect(cells.size).toBeGreaterThan(300);
    expect(Math.max(...cells.values())).toBeLessThan(40);
    // a piece in meters placed in a layout in meters keeps its scale factor (not 3.57 times it)
    expect(plan.units[0]!.uses[0]!.s[0]).toBeGreaterThan(0.79);
    expect(plan.units[0]!.uses[0]!.s[0]).toBeLessThan(1.41);
    const batches = batchUnits(plan.units, { maxUses: 300 });
    expect(batches.length).toBe(Math.ceil(2800 / 300));
    expect(batches.every((b) => b.reduce((n, u) => n + u.uses.length, 0) <= 300)).toBe(true);
    expect(batches.flat()).toHaveLength(1400);
    // and by size: no batch over the character budget
    const bySize = batchUnits(plan.units, { maxUses: 10_000, maxChars: 20_000, chars: (u) => 100 * u.uses.length });
    expect(bySize.every((b) => b.reduce((n, u) => n + 100 * u.uses.length, 0) <= 20_000)).toBe(true);
    expect(bySize.length).toBe(14);
  });
});
