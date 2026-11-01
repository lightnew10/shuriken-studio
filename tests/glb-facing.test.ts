import { describe, expect, it } from 'vitest';
import { glbTurned180, GLB_FACING } from '../src/core/modeling/glb';
import { ModelStore, PLACE_FN, type ModelMeta } from '../src/core/modeling/model-store';
import { rigsBuilder } from '../src/core/modeling/rig-builder';
import { gearBuilder } from '../src/core/modeling/gear';
import { accessorRows, makeGlb, readGlb } from './helpers/glb';

// Roblox's glTF importer turns an uploaded mesh 180° about Y around its own centre (measured in the user's
// live build, 2026-09-30). The copy Shuriken uploads is turned first; uploads made before that are turned
// back in the Luau Shuriken generates. These are the pure pieces: the GLB turn and the generated Luau.

// A little tetrahedron off to one side (so negating x and z moves every point), with distinct normals and UVs.
const POS = [0.5, 0, 1, 1.5, 0, 1, 1, 2, 0.25, 1, 0.5, 3];
const NRM = [0.1, 0.2, 0.9, -0.5, 0.3, 0.8, 0.6, -0.7, 0.2, 0, 1, 0];
const IDX = [0, 1, 2, 0, 2, 3, 1, 3, 2, 0, 3, 1];
const UV = [0, 0, 1, 0, 0.5, 1, 0.25, 0.75];
const turned = (v: number[]) => v.map((x, i) => (i % 3 === 1 ? x : x === 0 ? 0 : -x));

describe('glbTurned180', () => {
  it('negates x and z of positions and normals, fixes the bounds, and leaves indices, UVs and images alone', () => {
    const image = Buffer.from('\x89PNG fake image bytes');
    const src = makeGlb({ positions: POS, normals: NRM, indices: IDX, uvs: UV, image });
    const before = Buffer.from(src);
    const out = glbTurned180(src);
    expect(src.equals(before)).toBe(true); // the input is not edited
    // A valid GLB: magic, version 2, a total length that matches, a JSON chunk padded to 4 bytes, a BIN chunk.
    const { gltf, length } = readGlb(out);
    expect(out.readUInt32LE(0)).toBe(0x46546c67);
    expect(out.readUInt32LE(4)).toBe(2);
    expect(length).toBe(out.length);
    expect(out.readUInt32LE(12) % 4).toBe(0);
    const want = turned(POS).map((x) => Math.fround(x));
    expect(accessorRows(out, 0).flat()).toEqual(want);
    expect(accessorRows(out, 1).flat()).toEqual(turned(NRM).map((x) => Math.fround(x)));
    // Untouched: the triangles (a 180° turn about Y keeps their winding), the UVs, the image.
    expect(accessorRows(out, 2)).toEqual(accessorRows(src, 2));
    expect(accessorRows(out, 3)).toEqual(accessorRows(src, 3));
    const imgView = gltf.bufferViews[gltf.images[0].bufferView];
    expect(readGlb(out).bin.subarray(imgView.byteOffset, imgView.byteOffset + imgView.byteLength).equals(image)).toBe(true);
    // The position bounds follow: x and z swap ends, negated; y stays.
    const original = readGlb(src).gltf.accessors[0];
    expect(gltf.accessors[0].min).toEqual([-original.max[0], original.min[1], -original.max[2]]);
    expect(gltf.accessors[0].max).toEqual([-original.min[0], original.max[1], -original.min[2]]);
    expect(gltf.accessors[0].min.every((v: number, i: number) => v <= gltf.accessors[0].max[i])).toBe(true);
    // Everything else about the file is as it was (the material, the node, the mesh).
    expect(gltf.materials).toEqual(readGlb(src).gltf.materials);
    expect(gltf.meshes).toEqual(readGlb(src).gltf.meshes);
  });

  it('turning twice gives the original back', () => {
    const src = makeGlb({ positions: POS, normals: NRM, indices: IDX, uvs: UV });
    const twice = glbTurned180(glbTurned180(src));
    expect(accessorRows(twice, 0)).toEqual(accessorRows(src, 0));
    expect(accessorRows(twice, 1)).toEqual(accessorRows(src, 1));
    expect(readGlb(twice).gltf.accessors[0].min).toEqual(readGlb(src).gltf.accessors[0].min);
  });

  it('handles an interleaved buffer view (byteStride) and tangents (xyz turned, w kept)', () => {
    const tangents = [1, 0, 0, 1, 0, 0, 1, -1, 0.5, 0.5, 0.7, 1, 0, 1, 0, -1];
    const src = makeGlb({ positions: POS, normals: NRM, indices: IDX, uvs: UV, tangents, interleaved: true });
    expect(readGlb(src).gltf.bufferViews[0].byteStride).toBe(24);
    const out = glbTurned180(src);
    expect(accessorRows(out, 0).flat()).toEqual(turned(POS).map((x) => Math.fround(x)));
    expect(accessorRows(out, 1).flat()).toEqual(turned(NRM).map((x) => Math.fround(x)));
    // The tangent accessor is the last one: x and z negated, y and the handedness w are not.
    const t = accessorRows(out, readGlb(out).gltf.meshes[0].primitives[0].attributes.TANGENT);
    expect(t.flat()).toEqual(tangents.map((x, i) => Math.fround(i % 4 === 1 || i % 4 === 3 ? x : x === 0 ? 0 : -x)));
  });

  it('refuses what it cannot edit instead of uploading a mesh that is still turned', () => {
    expect(() => glbTurned180(Buffer.from('not a glb at all, just some bytes'))).toThrow(/not a GLB/);
    const good = makeGlb({ positions: POS, normals: NRM, indices: IDX });
    const edit = (f: (g: Record<string, any>) => void) => {
      const { gltf, bin } = readGlb(good);
      f(gltf);
      const json = Buffer.from(JSON.stringify(gltf), 'utf8');
      const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
      const head = Buffer.alloc(12);
      head.writeUInt32LE(0x46546c67, 0);
      head.writeUInt32LE(2, 4);
      head.writeUInt32LE(12 + 8 + padded.length + 8 + bin.length, 8);
      const jh = Buffer.alloc(8);
      jh.writeUInt32LE(padded.length, 0);
      jh.writeUInt32LE(0x4e4f534a, 4);
      const bh = Buffer.alloc(8);
      bh.writeUInt32LE(bin.length, 0);
      bh.writeUInt32LE(0x004e4942, 4);
      return Buffer.concat([head, jh, padded, bh, bin]);
    };
    expect(() => glbTurned180(edit((g) => (g.accessors[0].componentType = 5122)))).toThrow(/POSITION is not a float vec3/);
    expect(() => glbTurned180(edit((g) => (g.accessors[0].sparse = { count: 1 })))).toThrow(/sparse/);
    expect(() => glbTurned180(edit((g) => (g.extensionsRequired = ['KHR_draco_mesh_compression'])))).toThrow(/compressed/);
    expect(() => glbTurned180(edit((g) => delete g.meshes[0].primitives[0].attributes.POSITION))).toThrow(/no POSITION/);
    expect(() => glbTurned180(edit((g) => (g.accessors[0].count = 100000)))).toThrow(/past the end/);
  });

  it('turns a point exactly the way the importer turns it back: (x, y, z) becomes (−x, y, −z), both ways', () => {
    // The importer's own turn is the same map: a pre-turned mesh arrives as it was exported.
    const exported = [0.5, 1.25, -2];
    const uploaded = turned(exported);
    expect(uploaded).toEqual([-0.5, 1.25, 2]);
    expect(turned(uploaded)).toEqual(exported);
  });
});

// ---------------------------------------------------------------------------------------------
// Legacy uploads are turned back by the Luau Shuriken generates; marked uploads and temporary meshes aren't
// ---------------------------------------------------------------------------------------------

/** A part as the model store records it, uploaded as an asset with or without the facing marker. */
const part = (name: string, upload: 'legacy' | 'marked' | 'none', over: Partial<ModelMeta> = {}): ModelMeta => ({
  name, hash: `h-${name}`, size: [1, 2, 3], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null,
  placements: [], updatedAt: '', source: 'blender', color: '#445566', material: 'Slate', segment: 'Body', origin: [0, 2, 0],
  ...(upload === 'legacy' ? { upload: { assetId: '101', hash: `h-${name}`, at: '' } } : upload === 'marked' ? { upload: { assetId: '101', hash: `h-${name}`, at: '', facing: GLB_FACING } } : {}),
  ...over,
});

describe('which uploads are legacy', () => {
  it('only a valid upload without the facing marker is legacy', () => {
    expect(ModelStore.legacyUpload(part('A', 'legacy'))).toBe(true);
    expect(ModelStore.legacyUpload(part('A', 'marked'))).toBe(false);
    expect(ModelStore.legacyUpload(part('A', 'none'))).toBe(false);
    // An upload of an older build is no upload at all (it uploads again, as a marked one).
    expect(ModelStore.legacyUpload({ ...part('A', 'legacy'), hash: 'newer' })).toBe(false);
    expect(ModelStore.legacyUpload({ ...part('A', 'none'), upload: { error: 'no', hash: 'h-A', at: '' } })).toBe(false);
    expect(ModelStore.legacyUpload({ ...part('A', 'none'), upload: { operation: 'op-1', hash: 'h-A', at: '' } })).toBe(false);
  });
});

/** One part's row of a generated builder (a Luau table with nested braces for its origin and size). */
const row = (code: string, name: string): string => new RegExp(`\\{name="${name}",asset=[^,]+,(?:segment="[^"]*",)?origin=\\{[^}]*\\},size=\\{[^}]*\\}[^{}]*\\}`).exec(code)![0];

describe('the generated Luau turns legacy uploads back', () => {
  const stalker = { version: 1, model: 'Stalker', root: 'Body', joints: [{ name: 'Body', parent: null, part: 'Body', pivot: [0, 2, 0] as [number, number, number], kind: 'ball' as const }, { name: 'Tail', parent: 'Body', part: 'Tail', pivot: [0, 2.2, 1.5] as [number, number, number], kind: 'hinge' as const }], legs: [], attachments: [] };

  it('place() turns a part with turn=true about its own centre and marks it; the world builder sets turn on legacy models only', () => {
    expect(PLACE_FN).toContain('if p.turn then\n    mp.CFrame = mp.CFrame * CFrame.Angles(0, math.pi, 0)\n    mp:SetAttribute("ShurikenTurned", true)\n  end');
    // The turn comes after the part is placed (position and orientation), before it is parented.
    expect(PLACE_FN.indexOf('CFrame.Angles(0, math.pi, 0)')).toBeGreaterThan(PLACE_FN.indexOf('mp.CFrame = CFrame.new(p.pos[1]'));
    expect(PLACE_FN.indexOf('CFrame.Angles(0, math.pi, 0)')).toBeLessThan(PLACE_FN.indexOf('mp.Parent = parent'));
  });

  it('world/Models.luau: turn=true for a model uploaded before the fix, nothing for a marked upload', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const store = new ModelStore(root);
    const placement = { name: 'Lamp', parent: 'Workspace', position: [0, 0, 0] as [number, number, number], rotation: [0, 90, 0] as [number, number, number], scale: 1 };
    store.save({ ...part('LampOld', 'legacy'), placements: [placement] });
    store.save({ ...part('LampNew', 'marked'), placements: [{ ...placement, name: 'Lamp2' }] });
    const builder = readFileSync(join(root, 'world', 'Models.luau'), 'utf8');
    expect(builder).toMatch(/\{model="LampOld",asset=101,size=\{1,2,3\},turn=true,placements=/);
    expect(builder).toMatch(/\{model="LampNew",asset=101,size=\{1,2,3\},placements=/);
    expect(builder).toContain('if m.turn then p.turn = true end');
  });

  it('rig meshes: legacy parts that come from an asset get turn=true (the weld keeps it); marked and staged ones do not', () => {
    const parts = [part('Stalker_Body', 'legacy'), part('Stalker_Tail', 'marked', { segment: 'Tail' }), part('Stalker_Fang', 'legacy', { segment: 'Tail' })];
    // Fang is staged as a temporary mesh (its asset is not given): never turned, even if its old upload were legacy.
    const code = rigsBuilder([{ rig: stalker, parts, assets: { Stalker_Body: '101', Stalker_Tail: '101' } }], { temporary: true });
    expect(row(code, 'Stalker_Body')).toContain(',turn=true');
    expect(row(code, 'Stalker_Tail')).not.toContain('turn=true');
    expect(row(code, 'Stalker_Fang')).toMatch(/^\{name="Stalker_Fang",asset=nil,/);
    expect(row(code, 'Stalker_Fang')).not.toContain('turn=true');
    // The Luau turns the clone about its own centre before it is welded, and only when it really came from the asset.
    expect(code).toContain('if p.turn and fromAsset then mp.CFrame = mp.CFrame * CFrame.Angles(0, math.pi, 0) end');
    expect(code.indexOf('if p.turn and fromAsset')).toBeLessThan(code.indexOf('Instance.new("WeldConstraint")'));
    expect(code.indexOf('mp.CFrame = CFrame.new(v(p.origin))')).toBeLessThan(code.indexOf('if p.turn and fromAsset'));
  });

  it('gear: legacy parts are turned, and a legacy Handle turns its Grip and Attachment frame with it', () => {
    const blade = part('Sword_Blade', 'legacy', { segment: 'Handle', origin: [0, 2, 0] });
    const glow = part('Sword_Glow', 'marked', { segment: 'Handle', origin: [0, 3, 0], material: 'Neon' });
    const code = gearBuilder([
      { spec: { name: 'Sword', model: 'Sword', kind: 'tool', point: [0, 0.2, 0], into: 'ServerStorage.ShurikenGear' }, parts: [blade, glow], assets: { Sword_Blade: '101', Sword_Glow: '101' } },
    ]);
    expect(row(code, 'Sword_Blade')).toMatch(/,turn=true,handle=true\}$/);
    expect(row(code, 'Sword_Glow')).not.toContain('turn=true');
    expect(code).toContain('mp.CFrame = CFrame.new(v(p.origin)) * (if p.turn then TURN else CFrame.new())');
    expect(code).toContain('handleTurn = p.turn == true');
    expect(code).toContain('item.Grip = CFrame.new(offset) * (if handleTurn then TURN else CFrame.new())');
    expect(code).toContain('a.CFrame = CFrame.new(offset) * (if handleTurn then TURN else CFrame.new()) * CFrame.fromOrientation(');
    expect(code).toContain('local TURN = CFrame.Angles(0, math.pi, 0)');
  });
});

// ---------------------------------------------------------------------------------------------
// The geometry behind those lines, checked with plain rotation math (the importer turns (x, y, z) to (−x, y, −z))
// ---------------------------------------------------------------------------------------------

type V3 = [number, number, number];
type M3 = [V3, V3, V3];
const mul = (a: M3, b: M3): M3 => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r]![0] * b[0]![c]! + a[r]![1] * b[1]![c]! + a[r]![2] * b[2]![c]!)) as M3;
const app = (m: M3, v: V3): V3 => [0, 1, 2].map((r) => m[r]![0] * v[0] + m[r]![1] * v[1] + m[r]![2] * v[2]) as V3;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const rotY = (t: number): M3 => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]];
const rotX = (t: number): M3 => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
const TURN = rotY(Math.PI);
const inv = (m: M3): M3 => [0, 1, 2].map((r) => [0, 1, 2].map((c) => m[c]![r]!)) as M3; // rotations
const close = (a: V3, b: V3) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-9);
const q: V3 = [0.7, -0.3, 1.9]; // a vertex of the part, in its own frame as exported (Roblox space, front −Z)

describe('the compensation puts every vertex where the model says', () => {
  it('place: CFrame(pos) · R · Turn puts the importer-turned vertex at pos + R·q', () => {
    const R = mul(rotY(0.7), rotX(0.3));
    const pos: V3 = [10, 4, -3];
    const imported = app(TURN, q); // what the importer left in the MeshPart
    // Without the compensation: the vertex lands at pos + R·(Turn·q), turned about the part's centre.
    expect(close(add(pos, app(R, imported)), add(pos, app(R, q)))).toBe(false);
    // With it: part CFrame = pos, R·Turn, so the vertex is at pos + R·Turn·(Turn·q) = pos + R·q.
    expect(close(add(pos, app(mul(R, TURN), imported)), add(pos, app(R, q)))).toBe(true);
  });

  it('a wall mount sets the orientation, so the turn goes after it: lookAt(…) · Turn', () => {
    const wall = mul(rotY(-1.1), rotX(0.2)); // the orientation settle gives a wall mount
    expect(close(app(mul(wall, TURN), app(TURN, q)), app(wall, q))).toBe(true);
  });

  it('rig: a legacy mesh at its segment pivot-relative origin, turned about its centre, then welded, lands as modeled', () => {
    const pivot: V3 = [0, 2, 0];
    const origin: V3 = [0.5, 2.4, 2];
    // The weld keeps the mesh's CFrame relative to the segment part (at the pivot, no rotation at rest): origin, Turn.
    const rel = { p: sub(origin, pivot), r: TURN };
    const segmentR = rotX(0.4); // the joint has turned the segment
    const world = (v: V3) => add(add(pivot, app(segmentR, rel.p)), app(mul(segmentR, rel.r), app(TURN, v)));
    // As modeled (the segment turned by the same joint): the part's own centre at its origin, its vertices as exported.
    const modeled = (v: V3) => add(add(pivot, app(segmentR, sub(origin, pivot))), app(segmentR, v));
    expect(close(world(q), modeled(q))).toBe(true);
  });

  it('gear: Grip = CFrame(offset) · Turn for a legacy Handle holds the weapon exactly as modeled', () => {
    const originH: V3 = [0, 2, 0]; // the handle part's origin in the model
    const point: V3 = [0.1, 1.2, -0.4]; // the grip point in the model
    const gripWorld: V3 = [5, 3, 2];
    const M = mul(rotY(0.9), rotX(-0.2)); // the hand's grip frame orientation
    // Studio: Handle = grip · Grip⁻¹. The legacy handle is built at CFrame(originH) · Turn, so offset = Turn·(point − originH).
    const offset = app(TURN, sub(point, originH));
    // Grip = CFrame(offset) · Turn: rotation Turn, translation offset. Its inverse: rotation Turn⁻¹ = Turn, translation −Turn·offset.
    const gripInvR = inv(TURN);
    const handleR = mul(M, gripInvR);
    const handleP = add(gripWorld, app(M, app(gripInvR, offset.map((x) => -x) as V3)));
    // A vertex q of the handle, as the importer left it (turned), in the handle's frame; its place in the world:
    const worldVertex = add(handleP, app(handleR, app(TURN, q)));
    // As modeled: the model's point at the grip, the model's frame turned by the hand's M: vertex = originH + q.
    const modeledVertex = add(gripWorld, app(M, sub(add(originH, q), point)));
    expect(close(worldVertex, modeledVertex)).toBe(true);
  });
});
