/**
 * A GLB built the way Shuriken's own export (resources/blender/roblox_export.py: write_glb) builds one — a
 * single mesh and primitive, float VEC3 POSITION (with min/max) and NORMAL, optional TEXCOORD_0 and TANGENT,
 * u32 indices — plus an optional interleaved layout (one buffer view with a byteStride) to prove the reader
 * copes with what other writers do.
 */
export interface GlbParts {
  positions: number[];
  normals: number[];
  indices: number[];
  uvs?: number[];
  /** xyzw per vertex. */
  tangents?: number[];
  /** Positions and normals share one buffer view (byteStride 24) instead of one each. */
  interleaved?: boolean;
  /** An extra blob after the geometry (a texture image, say): it must come through untouched. */
  image?: Buffer;
}

export function makeGlb(o: GlbParts): Buffer {
  const n = o.positions.length / 3;
  const blobs: Buffer[] = [];
  let offset = 0;
  const views: Array<Record<string, number>> = [];
  const add = (data: Buffer, extra: Record<string, number> = {}): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      blobs.push(Buffer.alloc(pad));
      offset += pad;
    }
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...extra });
    blobs.push(data);
    offset += data.length;
    return views.length - 1;
  };
  const floats = (a: number[]) => {
    const b = Buffer.alloc(a.length * 4);
    a.forEach((v, i) => b.writeFloatLE(v, i * 4));
    return b;
  };
  const xs = o.positions.filter((_, i) => i % 3 === 0);
  const ys = o.positions.filter((_, i) => i % 3 === 1);
  const zs = o.positions.filter((_, i) => i % 3 === 2);
  const accessors: Array<Record<string, unknown>> = [];
  const attributes: Record<string, number> = {};
  const pos = { componentType: 5126, count: n, type: 'VEC3', min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] };
  if (o.interleaved) {
    const both = Buffer.alloc(n * 24);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        both.writeFloatLE(o.positions[i * 3 + c]!, i * 24 + c * 4);
        both.writeFloatLE(o.normals[i * 3 + c]!, i * 24 + 12 + c * 4);
      }
    }
    const view = add(both, { byteStride: 24, target: 34962 });
    accessors.push({ bufferView: view, byteOffset: 0, ...pos });
    accessors.push({ bufferView: view, byteOffset: 12, componentType: 5126, count: n, type: 'VEC3' });
  } else {
    accessors.push({ bufferView: add(floats(o.positions), { target: 34962 }), ...pos });
    accessors.push({ bufferView: add(floats(o.normals), { target: 34962 }), componentType: 5126, count: n, type: 'VEC3' });
  }
  attributes.POSITION = 0;
  attributes.NORMAL = 1;
  const idx = Buffer.alloc(o.indices.length * 4);
  o.indices.forEach((v, i) => idx.writeUInt32LE(v, i * 4));
  accessors.push({ bufferView: add(idx, { target: 34963 }), componentType: 5125, count: o.indices.length, type: 'SCALAR' });
  if (o.uvs) {
    attributes.TEXCOORD_0 = accessors.length;
    accessors.push({ bufferView: add(floats(o.uvs), { target: 34962 }), componentType: 5126, count: n, type: 'VEC2' });
  }
  if (o.tangents) {
    attributes.TANGENT = accessors.length;
    accessors.push({ bufferView: add(floats(o.tangents), { target: 34962 }), componentType: 5126, count: n, type: 'VEC4' });
  }
  const images = o.image ? [{ bufferView: add(o.image), mimeType: 'image/png' }] : undefined;
  const gltf = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    ...(images ? { images } : {}),
    buffers: [{ byteLength: 0 }],
    bufferViews: views,
    accessors,
  };
  let bin = Buffer.concat(blobs);
  bin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  gltf.buffers[0]!.byteLength = bin.length;
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

/** The JSON and BIN chunks of a GLB. */
export function readGlb(glb: Buffer): { gltf: Record<string, any>; bin: Buffer; length: number } {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen)) as Record<string, any>;
  const binLen = glb.readUInt32LE(20 + jsonLen);
  return { gltf, bin: glb.subarray(28 + jsonLen, 28 + jsonLen + binLen), length: glb.readUInt32LE(8) };
}

/** An accessor's values as rows (count × components). */
export function accessorRows(glb: Buffer, accessor: number): number[][] {
  const { gltf, bin } = readGlb(glb);
  const acc = gltf.accessors[accessor];
  const view = gltf.bufferViews[acc.bufferView];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type as string]!;
  const stride = view.byteStride ?? width * (acc.componentType === 5125 ? 4 : 4);
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const rows: number[][] = [];
  for (let i = 0; i < acc.count; i++) {
    const row: number[] = [];
    for (let c = 0; c < width; c++) {
      const at = base + i * stride + c * 4;
      row.push(acc.componentType === 5125 ? bin.readUInt32LE(at) : bin.readFloatLE(at));
    }
    rows.push(row);
  }
  return rows;
}
