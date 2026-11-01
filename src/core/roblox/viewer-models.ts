import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ViewerModel, V3 } from '@shared/viewer';
import { GLB_FACING } from '../modeling/glb';
import { ModelStore, type ModelMeta } from '../modeling/model-store';
import { decodePng, encodePng, shrinkImage } from '../modeling/png';

/**
 * What the Studio viewer needs of a modeled mesh, in a form that is cheap to move and draw: the geometry
 * without the GLB's embedded images (a map's meshes carry three 1-4 MB maps each, about 90% of its 75 MB),
 * the colour map shrunk to a thumbnail, and whether its upload is legacy (see @shared/viewer's meshTurned).
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Colour maps are shown at most this many pixels on a side. */
export const VIEWER_TEXTURE_PX = 256;

/**
 * The model's upload went through Roblox's importer without Shuriken's compensating pre-turn (its record has
 * no `facing` marker): in Studio its mesh is the GLB turned 180° about Y. Unlike ModelStore.legacyUpload this
 * does not need the upload to match the current build: a model built again since still has the older
 * asset in Studio until it is placed again.
 */
export function legacyUploadOf(m: ModelMeta): boolean {
  const u = m.upload;
  if (!u || !('assetId' in u || 'operation' in u)) return false;
  return (u.facing ?? 0) < GLB_FACING;
}

interface GltfView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}
interface GltfAccessor {
  bufferView?: number;
  count: number;
  sparse?: { indices: { bufferView: number }; values: { bufferView: number } };
}
interface Gltf {
  asset?: unknown;
  scene?: number;
  scenes?: unknown;
  nodes?: unknown;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number; mode?: number; material?: number }> }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] }; doubleSided?: boolean; alphaMode?: string; alphaCutoff?: number }>;
  accessors?: GltfAccessor[];
  bufferViews?: GltfView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  images?: unknown;
  textures?: unknown;
  samplers?: unknown;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}

/**
 * A copy of a GLB with its geometry only: the binary chunk keeps just the buffer views the accessors read
 * (the images' views go), and the JSON loses its images, textures, samplers and the materials' texture
 * references (each material keeps its base colour). Throws on what it can't rewrite (external buffers,
 * compressed geometry); the caller then sends the file as it is.
 */
export function slimGlb(src: Uint8Array): { glb: Buffer; triangles: number } {
  const buf = Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file');
  let json: Gltf | null = null;
  let bin: Buffer | null = null;
  for (let at = 12; at + 8 <= buf.length; ) {
    const len = buf.readUInt32LE(at);
    const type = buf.readUInt32LE(at + 4);
    if (at + 8 + len > buf.length) throw new Error('the GLB is cut short');
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8')) as Gltf;
    else if (type === CHUNK_BIN && !bin) bin = body;
    at += 8 + len;
  }
  if (!json || !bin) throw new Error('the GLB has no JSON or binary chunk');
  if ((json.extensionsRequired ?? []).some((e) => /draco|meshopt/i.test(e))) throw new Error('compressed glTF geometry is not supported');
  if ((json.buffers ?? []).length !== 1 || json.buffers![0]!.uri) throw new Error('the GLB reads from more than its own buffer');
  const views = json.bufferViews ?? [];
  const accessors = json.accessors ?? [];
  const used: number[] = [];
  const need = (i: number | undefined) => {
    if (i !== undefined && !used.includes(i)) used.push(i);
  };
  for (const a of accessors) {
    need(a.bufferView);
    need(a.sparse?.indices.bufferView);
    need(a.sparse?.values.bufferView);
  }
  used.sort((a, b) => a - b);
  const mapped = new Map<number, number>();
  const out: Buffer[] = [];
  const newViews: GltfView[] = [];
  let at = 0;
  for (const i of used) {
    const v = views[i];
    if (!v || v.buffer !== 0) throw new Error('a buffer view is missing');
    const from = v.byteOffset ?? 0;
    if (from + v.byteLength > bin.length) throw new Error('a buffer view runs past the end of the buffer');
    const pad = (4 - (at % 4)) % 4;
    if (pad) out.push(Buffer.alloc(pad));
    at += pad;
    mapped.set(i, newViews.length);
    newViews.push({ ...v, buffer: 0, byteOffset: at });
    out.push(bin.subarray(from, from + v.byteLength));
    at += v.byteLength;
  }
  const remap = (i: number | undefined) => (i === undefined ? undefined : mapped.get(i));
  const newAccessors = accessors.map((a) => {
    const n: GltfAccessor = { ...a };
    if (a.bufferView !== undefined) n.bufferView = remap(a.bufferView);
    if (a.sparse) n.sparse = { ...a.sparse, indices: { ...a.sparse.indices, bufferView: remap(a.sparse.indices.bufferView)! }, values: { ...a.sparse.values, bufferView: remap(a.sparse.values.bufferView)! } };
    return n;
  });
  let triangles = 0;
  for (const m of json.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      if (p.mode !== undefined && p.mode !== 4) continue;
      const count = p.indices !== undefined ? accessors[p.indices]?.count : accessors[p.attributes?.POSITION ?? -1]?.count;
      triangles += Math.floor((count ?? 0) / 3);
    }
  }
  const slim: Gltf = { ...json };
  delete slim.images;
  delete slim.textures;
  delete slim.samplers;
  delete slim.extensions;
  slim.extensionsUsed = (json.extensionsUsed ?? []).filter((e) => e === 'KHR_mesh_quantization');
  if (!slim.extensionsUsed.length) delete slim.extensionsUsed;
  delete slim.extensionsRequired;
  slim.materials = (json.materials ?? []).map((m) => ({
    pbrMetallicRoughness: { baseColorFactor: m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
    ...(m.doubleSided ? { doubleSided: true } : {}),
  }));
  slim.bufferViews = newViews;
  slim.accessors = newAccessors;
  const body = Buffer.concat(out);
  const binary = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
  slim.buffers = [{ byteLength: binary.length }];
  const text = Buffer.from(JSON.stringify(slim), 'utf8');
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const parts = [chunk(CHUNK_JSON, jsonChunk), chunk(CHUNK_BIN, binary)];
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + parts.reduce((n, b) => n + b.length, 0), 8);
  return { glb: Buffer.concat([header, ...parts]), triangles };
}

/** Whether a notable share of an image's texels are transparent (leaf cards, fences: drawn as cut-outs). */
export function hasCutouts(img: { data: Uint8Array }): boolean {
  let clear = 0;
  const n = img.data.length / 4;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 128) clear++;
  return n > 0 && clear / n > 0.01;
}

const thumbs = new Map<string, { png: Buffer; alpha: boolean }>();

/**
 * A colour map as a thumbnail (PNG, at most `max` px a side), kept in memory and in `cacheDir` (named for the
 * file's size and time, so a rebuilt map is made again). Null when the image can't be read (the viewer then
 * paints the part in its colour).
 */
export function textureThumb(file: string, cacheDir: string | null, max = VIEWER_TEXTURE_PX): { png: Buffer; alpha: boolean } | null {
  try {
    const st = statSync(file);
    const key = createHash('sha1').update(`${file}|${st.size}|${Math.floor(st.mtimeMs)}|${max}`).digest('hex').slice(0, 20);
    const hit = thumbs.get(key);
    if (hit) return hit;
    const png = cacheDir ? join(cacheDir, `${key}.png`) : null;
    const flag = cacheDir ? join(cacheDir, `${key}.alpha`) : null;
    if (png && flag && existsSync(png) && existsSync(flag)) {
      const cached = { png: readFileSync(png), alpha: readFileSync(flag, 'utf8') === '1' };
      thumbs.set(key, cached);
      return cached;
    }
    const img = shrinkImage(decodePng(readFileSync(file)), max);
    const made = { png: encodePng(img), alpha: hasCutouts(img) };
    thumbs.set(key, made);
    if (png && flag) {
      try {
        mkdirSync(cacheDir!, { recursive: true });
        writeFileSync(png, made.png);
        writeFileSync(flag, made.alpha ? '1' : '0');
      } catch {
        /* a cache that can't be written costs only time */
      }
    }
    return made;
  } catch {
    return null;
  }
}

/** The project models' names for the viewer snippet (Part + SpecialMesh pieces are matched to them by name). */
export function knownViewerModels(root: string): string[] {
  return new ModelStore(root)
    .names()
    .filter((n) => n.length <= 48 && !/[\]"\\,;|]/.test(n))
    .slice(0, 800);
}

const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;

/** A model's mesh for the viewer (see ViewerModel). Throws when the model has not been built. */
export function viewerModelData(root: string, name: string, cacheDir: string | null): ViewerModel {
  if (!/^[\w.\- ]+$/.test(name) || name.includes('..')) throw new Error(`No model named ${name}`);
  const store = new ModelStore(root);
  const meta = store.get(name);
  const file = store.paths(name).glb;
  if (!existsSync(file)) throw new Error(`${name} has not been built`);
  const raw = readFileSync(file);
  let glb: Uint8Array = raw;
  let triangles = meta?.triangles ?? 0;
  try {
    const slim = slimGlb(raw);
    glb = slim.glb;
    triangles = slim.triangles || triangles;
  } catch {
    /* a GLB this can't rewrite goes as it is */
  }
  const color = meta?.textures?.color ? basename(meta.textures.color) : null;
  const thumb = color ? textureThumb(join(store.dir(), color), cacheDir) : null;
  const size: V3 = meta ? [meta.size[0], meta.size[1], meta.size[2]] : [1, 1, 1];
  return {
    glb: dataUrl('model/gltf-binary', glb),
    texture: thumb ? dataUrl('image/png', thumb.png) : null,
    textureAlpha: thumb?.alpha ?? false,
    legacy: meta ? legacyUploadOf(meta) : false,
    size,
    triangles,
  };
}
