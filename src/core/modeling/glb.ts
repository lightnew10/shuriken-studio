/**
 * What Roblox's glTF importer does to an uploaded mesh (measured in Studio, 2026-09-30, on the user's live
 * build): glTF's front is +Z and Roblox's is −Z, so the importer turns the geometry 180° about Y,
 * (x, y, z) → (−x, y, −z). A MeshPart's geometry is centred on its own box, so every uploaded part ends up
 * turned about its own centre while its position (the model.json origin) stays right — a street-light arm
 * pointing +Z with its lamp at −Z, chevrons reading "<" from the back, a car trim's top at the bottom.
 * The temporary EditableMesh path (mesh.json) is not affected. Shuriken's export writes its GLBs in Roblox
 * space (front −Z), so the copy that is uploaded is turned first and the importer turns it back.
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;

/** Upload pipeline marker of a part uploaded from a pre-turned GLB (records without it were uploaded as exported). */
export const GLB_FACING = 2;

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}

interface Gltf {
  extensionsRequired?: string[];
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
  accessors?: Accessor[];
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
}

/**
 * A copy of a GLB turned 180° about Y: its POSITION and NORMAL accessors' x and z negated (TANGENT's xyz too,
 * w untouched) and the POSITION (and NORMAL) min/max updated. Indices, UVs, images and materials are
 * untouched (a turn about Y keeps the triangles' winding). Written for the GLBs Shuriken's own export
 * (write_glb) produces — one float accessor per attribute, tightly packed or interleaved (byteStride) in
 * the BIN chunk, no node transforms — and it throws on what it can't edit (sparse or non-float
 * accessors, compressed geometry) rather than upload a mesh that is still turned.
 */
export function glbTurned180(glb: Uint8Array): Buffer {
  const src = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
  if (src.length < 20 || src.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file');
  if (src.readUInt32LE(4) !== 2) throw new Error(`unsupported glTF version ${src.readUInt32LE(4)}`);
  const chunks: Array<{ type: number; data: Buffer }> = [];
  for (let at = 12; at + 8 <= src.length; ) {
    const len = src.readUInt32LE(at);
    const type = src.readUInt32LE(at + 4);
    if (at + 8 + len > src.length) throw new Error('the GLB is cut short');
    chunks.push({ type, data: Buffer.from(src.subarray(at + 8, at + 8 + len)) });
    at += 8 + len;
  }
  const jsonChunk = chunks.find((c) => c.type === CHUNK_JSON);
  const bin = chunks.find((c) => c.type === CHUNK_BIN);
  if (!jsonChunk) throw new Error('the GLB has no JSON chunk');
  const gltf = JSON.parse(jsonChunk.data.toString('utf8')) as Gltf;
  if ((gltf.extensionsRequired ?? []).some((e) => /draco|meshopt/i.test(e))) throw new Error('compressed glTF geometry is not supported');
  const seen = new Set<number>();
  let positions = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const [attr, width] of [['POSITION', 3], ['NORMAL', 3], ['TANGENT', 4]] as const) {
        const index = prim.attributes?.[attr];
        if (index === undefined || seen.has(index)) continue;
        seen.add(index);
        if (attr === 'POSITION') positions++;
        const acc = gltf.accessors?.[index];
        if (!acc) throw new Error(`${attr} points at a missing accessor`);
        if (acc.sparse) throw new Error(`${attr} is a sparse accessor`);
        if (acc.componentType !== FLOAT || acc.type !== (width === 3 ? 'VEC3' : 'VEC4')) throw new Error(`${attr} is not ${width === 3 ? 'a float vec3' : 'a float vec4'}`);
        if (acc.bufferView === undefined || !bin) throw new Error(`${attr} has no data`);
        const view = gltf.bufferViews?.[acc.bufferView];
        if (!view || view.buffer !== 0) throw new Error(`${attr}'s buffer view is not in the GLB's own buffer`);
        const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : width * 4;
        const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        if (acc.count > 0 && base + (acc.count - 1) * stride + width * 4 > bin.data.length) throw new Error(`${attr} runs past the end of the buffer`);
        for (let i = 0; i < acc.count; i++) {
          const p = base + i * stride;
          const x = bin.data.readFloatLE(p);
          const z = bin.data.readFloatLE(p + 8);
          bin.data.writeFloatLE(x === 0 ? 0 : -x, p);
          bin.data.writeFloatLE(z === 0 ? 0 : -z, p + 8);
        }
        // The bounds turn with the points: x and z swap ends, negated.
        if (attr !== 'TANGENT' && acc.min?.length === 3 && acc.max?.length === 3) {
          const [lx, ly, lz] = acc.min as [number, number, number];
          const [hx, hy, hz] = acc.max as [number, number, number];
          acc.min = [-hx, ly, -hz];
          acc.max = [-lx, hy, -lz];
        }
      }
    }
  }
  if (!positions) throw new Error('the GLB has no POSITION data');
  // The JSON chunk is padded with spaces to a multiple of 4 bytes, as the glTF spec asks.
  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  jsonChunk.data = padded;
  const body = chunks.map((c) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(c.data.length, 0);
    head.writeUInt32LE(c.type, 4);
    return Buffer.concat([head, c.data]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.reduce((n, b) => n + b.length, 0), 8);
  return Buffer.concat([header, ...body]);
}
