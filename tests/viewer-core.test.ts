import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Core } from '@core/core';
import { createRouter } from '@core/rpc/router';
import { LUAU_VIEW_PARTS } from '@core/roblox/luau-snippets';
import { LuauToolchain } from '@core/roblox/luau-toolchain';
import { glbTurned180 } from '@core/modeling/glb';
import { ModelStore, type ModelMeta } from '@core/modeling/model-store';
import { encodePng, decodePng } from '@core/modeling/png';
import { hasCutouts, knownViewerModels, legacyUploadOf, slimGlb, textureThumb, viewerModelData } from '@core/roblox/viewer-models';
import { MESH_CAP, PART_FLAG, isStudioModeFlip, meshTurned, specialMeshDrawSize } from '@shared/viewer';
import { FakeProvider } from './helpers/fake-provider';
import { accessorRows, makeGlb, readGlb } from './helpers/glb';

// The Studio viewer's core side: which uploaded meshes Roblox turns (the orientation rule), the size of a
// SpecialMesh piece, the viewer's copy of a model (geometry without the GLB's images, a colour-map thumbnail),
// the Luau that reads the place, and the quiet retry when Studio flips between Edit and Play.

const POS = [0.5, 0, 1, 1.5, 0, 1, 1, 2, 0.25, 1, 0.5, 3];
const NRM = [0.1, 0.2, 0.9, -0.5, 0.3, 0.8, 0.6, -0.7, 0.2, 0, 1, 0];
const IDX = [0, 1, 2, 0, 2, 3, 1, 3, 2, 0, 3, 1];
const UV = [0, 0, 1, 0, 0.5, 1, 0.25, 0.75];

const meta = (over: Partial<ModelMeta> = {}): ModelMeta => ({
  name: 'Crate',
  hash: 'h1',
  size: [4, 2, 8],
  triangles: 4,
  vertices: 4,
  volume: null,
  faces: 0,
  solids: 1,
  valid: true,
  tolerance: null,
  placements: [],
  updatedAt: '',
  ...over,
});

describe('orientation of uploaded meshes', () => {
  it('knows which uploads Roblox turns (no facing marker) and which it does not', () => {
    expect(legacyUploadOf(meta({ upload: { assetId: '1', hash: 'h1', at: 'x' } }))).toBe(true);
    expect(legacyUploadOf(meta({ upload: { assetId: '1', hash: 'h1', at: 'x', facing: 1 } }))).toBe(true);
    expect(legacyUploadOf(meta({ upload: { assetId: '1', hash: 'h1', at: 'x', facing: 2 } }))).toBe(false);
    expect(legacyUploadOf(meta({ upload: { operation: 'op', hash: 'h1', at: 'x' } }))).toBe(true);
    expect(legacyUploadOf(meta({ upload: { operation: 'op', hash: 'h1', at: 'x', facing: 2 } }))).toBe(false);
    // Never uploaded or failed: nothing in Studio is turned (a temporary mesh, or no mesh at all).
    expect(legacyUploadOf(meta())).toBe(false);
    expect(legacyUploadOf(meta({ upload: { error: 'no', hash: 'h1', at: 'x' } }))).toBe(false);
    // A model built again since its upload still has the old asset in Studio: the hash does not matter.
    expect(legacyUploadOf(meta({ hash: 'h2', upload: { assetId: '1', hash: 'h1', at: 'x' } }))).toBe(true);
    // The store's own question (current build only) agrees where both apply.
    const m = meta({ upload: { assetId: '1', hash: 'h1', at: 'x' } });
    expect(ModelStore.legacyUpload(m)).toBe(legacyUploadOf(m));
  });

  it('turns a mesh when Studio does: legacy uploads and ShurikenTurned parts, never temporary meshes', () => {
    expect(meshTurned(0, true)).toBe(true); // the user's world/Map.luau: HALF_TURN by hand, no attribute
    expect(meshTurned(PART_FLAG.turned, true)).toBe(true); // Shuriken's builder: marked
    expect(meshTurned(0, false)).toBe(false); // a marked upload shows its original
    // Re-uploaded since the part was placed: the part still holds the legacy mesh.
    expect(meshTurned(PART_FLAG.turned, false)).toBe(true);
    // An EditableMesh from mesh.json is not touched by the importer, whatever the record says now.
    expect(meshTurned(PART_FLAG.temporary, true)).toBe(false);
    expect(meshTurned(PART_FLAG.temporary + PART_FLAG.turned, true)).toBe(false);
    // Other flags don't matter.
    expect(meshTurned(PART_FLAG.colorMap + PART_FLAG.fileMesh, true)).toBe(true);
    expect(meshTurned(PART_FLAG.colorMap + PART_FLAG.fileMesh, false)).toBe(false);
  });
});

describe('a SpecialMesh piece', () => {
  it('draws the mesh at its own size times Scale', () => {
    expect(specialMeshDrawSize([10, 20, 30], [1, 1, 1])).toEqual([10, 20, 30]);
    expect(specialMeshDrawSize([10, 20, 30], [2, 0.5, 3])).toEqual([20, 10, 90]);
  });

  it('lands on the size the model was made at when Scale undoes the cap, whether or not the importer shrank the mesh', () => {
    // Map_Foliage_Autumn_Orange_1: 1949.5 × 1063.7 × 4148.4 studs, over the 2048 cap on one axis.
    const size: [number, number, number] = [1949.503, 1063.702, 4148.393];
    const f = MESH_CAP / 4148.393;
    // The builder divides the model's size by the mesh's size in Studio (MeshSize): 1 if it was not shrunk, 1 / f if it was.
    expect(specialMeshDrawSize(size, [1, 1, 1]).map((v, i) => Math.round(v - size[i]!))).toEqual([0, 0, 0]);
    const restored = specialMeshDrawSize(size, [1 / f, 1 / f, 1 / f]);
    restored.forEach((v, i) => expect(v).toBeCloseTo(size[i]!, 6));
    // A model that fits the cap has one reading only.
    specialMeshDrawSize([1500, 800, 1200], [1.1, 1.1, 1.1]).forEach((v, i) => expect(v).toBeCloseTo([1650, 880, 1320][i]!, 6));
  });
});

describe('Studio switching between Edit and Play', () => {
  it('recognises the errors of a read aimed at a datamodel that just went away', () => {
    expect(isStudioModeFlip('Server datamodel is not available in Edit mode')).toBe(true);
    expect(isStudioModeFlip('Target is not reachable')).toBe(true);
    expect(isStudioModeFlip('Error invoking remote method \'rpc\': Error: Server datamodel is not available in Edit mode')).toBe(true);
    expect(isStudioModeFlip('Studio is not connected')).toBe(false);
    expect(isStudioModeFlip('Luau did not return JSON (12 characters): oops')).toBe(false);
    expect(isStudioModeFlip('attempt to index nil with Size (line 12)')).toBe(false);
  });
});

describe('slimGlb', () => {
  const image = Buffer.alloc(5000, 7);

  it('keeps the geometry byte for byte and drops the images, textures and material maps', () => {
    const src = makeGlb({ positions: POS, normals: NRM, indices: IDX, uvs: UV, image });
    // A material that points at the image, as Blender writes a textured one.
    const parsed = readGlb(src);
    parsed.gltf.textures = [{ source: 0 }];
    parsed.gltf.samplers = [{ magFilter: 9729 }];
    parsed.gltf.materials = [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 1 }, normalTexture: { index: 0 } }];
    const withMaps = rebuild(src, parsed.gltf);
    const out = slimGlb(withMaps);
    expect(out.triangles).toBe(4);
    expect(out.glb.length).toBeLessThan(withMaps.length - 4000);
    const { gltf, length, bin } = readGlb(out.glb);
    expect(length).toBe(out.glb.length);
    expect(gltf.images).toBeUndefined();
    expect(gltf.textures).toBeUndefined();
    expect(gltf.samplers).toBeUndefined();
    expect(JSON.stringify(gltf.materials)).not.toMatch(/Texture/);
    expect(gltf.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(gltf.buffers[0].byteLength).toBe(bin.length);
    for (const i of [0, 1, 2, 3]) expect(accessorRows(out.glb, i)).toEqual(accessorRows(withMaps, i));
    // Every buffer view is 4-byte aligned and inside the buffer.
    for (const v of gltf.bufferViews) {
      expect(v.byteOffset % 4).toBe(0);
      expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(bin.length);
    }
    // The file stays a GLB the exporter-side reader accepts (it throws on anything malformed).
    expect(() => glbTurned180(out.glb)).not.toThrow();
  });

  it('copes with an interleaved layout and an image stored before the geometry', () => {
    const src = makeGlb({ positions: POS, normals: NRM, indices: IDX, uvs: UV, interleaved: true, image });
    const parsed = readGlb(src);
    // Move the image's view to the front of the view list (a writer is free to order them so).
    const imageView = parsed.gltf.bufferViews.pop();
    parsed.gltf.bufferViews.unshift(imageView);
    for (const a of parsed.gltf.accessors) a.bufferView += 1;
    parsed.gltf.images[0].bufferView = 0;
    const out = slimGlb(rebuild(src, parsed.gltf));
    expect(accessorRows(out.glb, 0).flat()).toEqual(POS.map(Math.fround));
    expect(accessorRows(out.glb, 1).flat()).toEqual(NRM.map(Math.fround));
    expect(accessorRows(out.glb, 3).flat()).toEqual(UV.map(Math.fround));
    expect(readGlb(out.glb).gltf.bufferViews[0].byteStride).toBe(24);
  });

  it('refuses what it cannot rewrite', () => {
    expect(() => slimGlb(Buffer.from('not a glb at all, just some bytes'))).toThrow(/not a GLB/);
    const parsed = readGlb(makeGlb({ positions: POS, normals: NRM, indices: IDX }));
    parsed.gltf.extensionsRequired = ['KHR_draco_mesh_compression'];
    expect(() => slimGlb(rebuild(makeGlb({ positions: POS, normals: NRM, indices: IDX }), parsed.gltf))).toThrow(/compressed/);
  });

  // Real file from the user's drift project, when this machine has it: the viewer's copy is a small share of the upload.
  const real = join(homedir(), 'Documents', 'Shuriken Studio', 'Projects', 'very-simple', 'models', 'Map_Asphalt_Track.glb');
  it.skipIf(!existsSync(real))("shrinks the drift map's asphalt GLB (4.4 MB with three maps) to its geometry", async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(real);
    const out = slimGlb(raw);
    expect(raw.length).toBeGreaterThan(4_000_000);
    expect(out.glb.length).toBeLessThan(500_000);
    expect(out.triangles).toBe(6464);
    expect(accessorRows(out.glb, 0)).toEqual(accessorRows(raw, 0));
  });
});

// Measured on the user's drift project (when this machine has it): the road's centreline (world/data/MapRoad.json,
// from the Kiln export) runs along the asphalt's vertices only when the legacy mesh is turned the way Roblox turns it.
const drift = join(homedir(), 'Documents', 'Shuriken Studio', 'Projects', 'very-simple');
describe.skipIf(!existsSync(join(drift, 'world', 'data', 'MapRoad.json')))("the drift map's asphalt", () => {
  it('lines up with the road centreline when drawn with meshTurned, and is tens of studs off drawn the old way', async () => {
    const { readFileSync } = await import('node:fs');
    const road = JSON.parse(readFileSync(join(drift, 'world', 'data', 'MapRoad.json'), 'utf8')) as { points: number[][] };
    const store = new ModelStore(drift);
    const track = store.get('Map_Asphalt_Track')!;
    expect(legacyUploadOf(track)).toBe(true);
    // world/Map.luau turns the part half a turn about Y (a HALF_TURN, no ShurikenTurned attribute), so Studio draws
    // turn180(GLB) at pos * Ry(π): the original GLB at pos. The old viewer drew the original at that CFrame: turned.
    const turned = meshTurned(0, legacyUploadOf(track));
    expect(turned).toBe(true);
    const verts = accessorRows(readFileSync(store.paths('Map_Asphalt_Track').glb), 0);
    const [px, , pz] = track.placements[0]!.position;
    const nearest = (sign: number) => {
      const dists = road.points.filter((_, i) => i % 8 === 0).map((c) => {
        let best = Infinity;
        for (const v of verts) best = Math.min(best, Math.hypot(px + sign * v[0]! - c[0]!, pz + sign * v[2]! - c[2]!));
        return best;
      });
      return dists.reduce((a, b) => a + b, 0) / dists.length;
    };
    // Drawn with the rule: Ry(π) (the CFrame) then Ry(π) (the mesh's turn) is the identity.
    expect(nearest(1)).toBeLessThan(0.5);
    // The old drawing, the mesh un-turned at the half-turned CFrame, was 66 studs off on average.
    expect(nearest(-1)).toBeGreaterThan(40);
  });
});

/** The GLB with its JSON replaced (same binary chunk). */
function rebuild(glb: Buffer, gltf: Record<string, unknown>): Buffer {
  const { bin } = readGlb(glb);
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(json.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, json, bh, bin]);
}

describe('colour-map thumbnails', () => {
  it('shrinks a big map to at most 256 px, keeps it between runs, and notices cut-outs', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-vthumb-'));
    const w = 1024;
    const h = 512;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([200, 120, 40, 255], i * 4);
    const file = join(root, 'Crate__Wood.color.png');
    writeFileSync(file, encodePng({ width: w, height: h, data }));
    const cache = join(root, 'cache');
    const t = textureThumb(file, cache)!;
    const img = decodePng(t.png);
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(256);
    expect(img.width / img.height).toBeCloseTo(2, 1);
    expect(Array.from(img.data.slice(0, 4))).toEqual([200, 120, 40, 255]);
    expect(t.alpha).toBe(false);
    // Second time from memory/disk: the same bytes.
    expect(textureThumb(file, cache)!.png.equals(t.png)).toBe(true);
    // A fence: half the texels are see-through.
    const lace = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) lace.set([90, 90, 90, i % 2 ? 255 : 0], i * 4);
    expect(hasCutouts({ data: lace })).toBe(true);
    expect(hasCutouts({ data })).toBe(false);
    // Not a PNG: no thumbnail, no crash.
    writeFileSync(join(root, 'bad.png'), 'nope');
    expect(textureThumb(join(root, 'bad.png'), cache)).toBeNull();
    expect(textureThumb(join(root, 'missing.png'), cache)).toBeNull();
  });
});

describe('viewerModelData', () => {
  it("sends a model's geometry, colour map, size and upload kind; refuses names that leave the models folder", () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-vmodel-'));
    const store = new ModelStore(root);
    mkdirSync(store.dir(), { recursive: true });
    const png = encodePng({ width: 300, height: 300, data: new Uint8Array(300 * 300 * 4).fill(180) });
    writeFileSync(join(store.dir(), 'Crate__Wood.color.png'), png);
    writeFileSync(store.paths('Crate').glb, makeGlb({ positions: POS, normals: NRM, indices: IDX, uvs: UV, image: Buffer.alloc(9000) }));
    store.save({ ...meta({ upload: { assetId: '77', hash: 'h1', at: 'x' }, textures: { color: 'Crate__Wood.color.png' } }) });
    writeFileSync(store.paths('Plain').glb, makeGlb({ positions: POS, normals: NRM, indices: IDX }));
    store.save({ ...meta({ name: 'Plain', upload: { assetId: '78', hash: 'h1', at: 'x', facing: 2 } }) });
    const crate = viewerModelData(root, 'Crate', join(root, 'cache'));
    expect(crate.legacy).toBe(true);
    expect(crate.size).toEqual([4, 2, 8]);
    expect(crate.triangles).toBe(4);
    expect(crate.glb.startsWith('data:model/gltf-binary;base64,')).toBe(true);
    expect(Buffer.from(crate.glb.split(',')[1]!, 'base64').length).toBeLessThan(2000);
    expect(crate.texture!.startsWith('data:image/png;base64,')).toBe(true);
    expect(decodePng(Buffer.from(crate.texture!.split(',')[1]!, 'base64')).width).toBeLessThanOrEqual(256);
    const plain = viewerModelData(root, 'Plain', null);
    expect(plain.legacy).toBe(false);
    expect(plain.texture).toBeNull();
    expect(() => viewerModelData(root, 'Missing', null)).toThrow(/has not been built/);
    expect(() => viewerModelData(root, '../secrets', null)).toThrow(/No model named/);
    expect(knownViewerModels(root).sort()).toEqual(['Crate', 'Plain']);
  });
});

describe('LUAU_VIEW_PARTS', () => {
  const code = LUAU_VIEW_PARTS.replace('__OFFSET__', '0').replace('__KNOWN__', () => JSON.stringify(['Map_Foliage_Autumn_Orange_1']));
  const selene = existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene'));

  it.skipIf(!selene)('parses like the other Luau Shuriken sends', async () => {
    expect(await new LuauToolchain(tmpdir()).parseErrors(code)).toEqual([]);
    // Without the model names (an old caller that only fills the offset) it still parses.
    expect(await new LuauToolchain(tmpdir()).parseErrors(LUAU_VIEW_PARTS.replace('__OFFSET__', '0'))).toEqual([]);
  });

  it('writes the rows the viewer reads: 21 fields, the new ones last, the flag values from the shared contract', () => {
    const concat = /local row = table\.concat\(\{([\s\S]*?)\}, ","\)/.exec(code)![1]!;
    const fields: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of concat) {
      if (ch === '(' || ch === '{') depth++;
      if (ch === ')' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        fields.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    fields.push(cur.trim());
    expect(fields).toHaveLength(21);
    expect(fields.slice(14)).toEqual(['name', 'tex', 'r(d.Reflectance)', 'model', 'parentKey(d)', 'flags', 'sm']);
    expect(code).toContain(`if d:GetAttribute("ShurikenTurned") == true then flags += ${PART_FLAG.turned} end`);
    expect(code).toContain(`if d:GetAttribute("ShurikenTemporaryMesh") == true then flags += ${PART_FLAG.temporary} end`);
    expect(code).toContain(`flags += ${PART_FLAG.fileMesh}\n`);
    expect(code.match(new RegExp(`flags \\+= ${PART_FLAG.colorMap} end`, 'g'))).toHaveLength(2);
    // A Part is drawn through a SpecialMesh only when it is a FileMesh, and its piece of the project is found by
    // attribute (part, then mesh), then by MeshId, then by name.
    expect(code).toContain('mesh.MeshType == Enum.MeshType.FileMesh');
    const order = ['modelAttr(d)', 'modelAttr(mesh)', 'modelOfMeshId(mesh.MeshId)', 'KNOWN[d.Name]'].map((s) => code.indexOf(s, code.indexOf('flags += ' + PART_FLAG.fileMesh)));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The model names ride in a long string the names cannot end.
    expect(code).toContain('[==[["Map_Foliage_Autumn_Orange_1"]]==]');
  });
});

describe('viewer.parts when Studio flips between Edit and Play', () => {
  const cores: Core[] = [];
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.shutdown();
  });

  async function router() {
    const provider = new FakeProvider({ respond: async () => ({ intent: 'chat', reply: 'unused' }) });
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-vp-')), resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [provider], integrations: false, logToDisk: false });
    cores.push(core);
    const calls: Array<{ dm: string; offset: number }> = [];
    let modes: string[][] = [['Edit']];
    let failures: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.state = async () => ({ availableDataModels: modes.shift() ?? ['Edit'] });
    studio.luauJson = async (code: string, dm: string) => {
      calls.push({ dm, offset: Number(/local OFFSET = (\d+)/.exec(code)![1]) });
      const fail = failures.shift();
      if (fail) throw new Error(fail);
      return { total: 0, count: 0, next: null, classes: [], materials: [], rows: '' };
    };
    const rpc = createRouter(core) as unknown as Record<string, (a: unknown) => Promise<Record<string, unknown>>>;
    return { rpc, calls, setModes: (m: string[][]) => (modes = m), setFailures: (f: string[]) => (failures = f) };
  }

  it('reads the mode again and tries again, quietly, when the first read hits a datamodel that went away', async () => {
    const t = await router();
    t.setModes([['Server'], ['Edit']]);
    t.setFailures(['Server datamodel is not available in Edit mode']);
    const page = await t.rpc['viewer.parts']!({ offset: 0 });
    expect(t.calls.map((c) => c.dm)).toEqual(['Server', 'Edit']);
    expect(page.source).toBe('Edit');
  });

  it('does not move a later page to another datamodel (its offset means the first one) and does not retry other errors', async () => {
    const t = await router();
    t.setFailures(['Target is not reachable']);
    await expect(t.rpc['viewer.parts']!({ offset: 400, datamodel: 'Server' })).rejects.toThrow(/not reachable/);
    expect(t.calls).toHaveLength(1);
    const u = await router();
    u.setFailures(['attempt to index nil with Size']);
    await expect(u.rpc['viewer.parts']!({ offset: 0 })).rejects.toThrow(/attempt to index nil/);
    expect(u.calls).toHaveLength(1);
  });

  it('fills the project model names into the snippet', async () => {
    const t = await router();
    const seen: string[] = [];
    const studio = (cores[0] as Core).studio as unknown as Record<string, unknown>;
    const inner = studio.luauJson as (c: string, d: string) => Promise<unknown>;
    studio.luauJson = (c: string, d: string) => {
      seen.push(c);
      return inner(c, d);
    };
    await t.rpc['viewer.parts']!({ offset: 0 });
    // No project is open in this core: an empty list, and nothing left to fill in.
    expect(seen[0]).toContain('[==[[]]==]');
    expect(seen[0]).not.toContain('__KNOWN__');
  });
});
