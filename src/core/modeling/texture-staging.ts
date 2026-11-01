import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Emission, TextureMaps } from './backend';
import { MODEL_DIR } from './model-store';
import { decodePng, shrinkImage, type RgbaImage } from './png';

/**
 * Texture maps on temporary meshes in Studio (verified in Studio 0.741: EditableImage pixels, UVs on an
 * EditableMesh, and a SurfaceAppearance's ColorMapContent / NormalMapContent / RoughnessMapContent /
 * MetalnessMapContent set from Content.fromObject(image)). Each textured part gets a SurfaceAppearance
 * listing the maps it needs; each map goes to Studio once per Studio session (kept in `shared` in the
 * plugin), in chunks, and attaches to every SurfaceAppearance waiting for it. Like the temporary meshes
 * themselves, none of this is saved with the place: an uploaded model carries its maps in its GLB.
 */

export type MapKind = keyof TextureMaps;

/** SurfaceAppearance's property for each map. */
export const SA_PROP: Record<MapKind, string> = { color: 'ColorMapContent', normal: 'NormalMapContent', roughness: 'RoughnessMapContent', metalness: 'MetalnessMapContent', emissive: 'EmissiveMaskContent' };
/**
 * The largest side sent for a preview (Kiln paints 512 px sets). Roughness and metalness are full size: a
 * wet, glossy creature is judged by its roughness map, and shrinking it to 128 px made it look different
 * in Studio than uploaded (the export writes them as 512 px images when the material has a real texture).
 */
const LIMIT: Record<MapKind, number> = { color: 512, normal: 512, roughness: 512, metalness: 512, emissive: 256 };
/** A gray map that is one value everywhere (a number the material had instead of an image) needs only a few pixels. */
const CONSTANT_SIZE = 4;

/** Whether every pixel of a gray map has the same value (its red channel: the others copy it). */
export function isConstantGray(img: RgbaImage): boolean {
  const first = img.data[0];
  for (let i = 4; i < img.data.length; i += 4) if (img.data[i] !== first) return false;
  return true;
}
/** Bytes per pixel sent: colour with alpha, a normal's three, one gray channel. */
const CHANNELS: Record<MapKind, 1 | 3 | 4> = { color: 4, normal: 3, roughness: 1, metalness: 1, emissive: 1 };
/** Base64 per Studio call (a multiple of 4). */
const CHUNK = 160_000;

/** The key a map is loaded under in Studio: its file and content, so a repainted map loads again. */
export function textureKey(root: string, file: string): string | null {
  const f = join(root, MODEL_DIR, file);
  if (!existsSync(f)) return null;
  return `${file}#${createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 10)}`;
}

/** The maps a part needs as [kind, key] (files that exist). */
function keysOf(root: string, textures: TextureMaps | undefined): Array<[MapKind, string]> {
  const out: Array<[MapKind, string]> = [];
  for (const [kind, file] of Object.entries(textures ?? {}) as Array<[MapKind, string | undefined]>) {
    const key = file ? textureKey(root, file) : null;
    if (key) out.push([kind, key]);
  }
  return out;
}

/**
 * Luau that gives the MeshPart in variable `target` a SurfaceAppearance for these maps: the ones Studio
 * already has attach at once, the rest when stageTextures sends them. Empty for an untextured part.
 */
export function surfaceLuau(root: string, textures: TextureMaps | undefined, target = 'mp', emission?: Emission): string {
  const maps = keysOf(root, textures);
  if (!maps.length) return '';
  const json = JSON.stringify(Object.fromEntries(maps));
  const glow = emission && textures?.emissive ? `\n  sa.EmissiveStrength = ${Math.max(0, Math.min(10, emission.strength))}\n  sa.EmissiveTint = Color3.fromHex(${JSON.stringify(emission.tint)})` : '';
  return `do
  local sa = Instance.new("SurfaceAppearance")
  sa.Name = "ShurikenTextures"
  sa:SetAttribute("ShurikenMaps", ${JSON.stringify(json)})${glow}
  local loaded = shared.ShurikenTextures
  if loaded then
${maps.map(([kind, key]) => `    if loaded[${JSON.stringify(key)}] then sa.${SA_PROP[kind]} = Content.fromObject(loaded[${JSON.stringify(key)}]) end`).join('\n')}
  end
  game:GetService("CollectionService"):AddTag(sa, "ShurikenTextured")
  sa.Parent = ${target}
end`;
}

/** Every map these parts need, once each. */
export function mapsOf(root: string, parts: Array<{ textures?: TextureMaps }>): Array<{ kind: MapKind; file: string; key: string }> {
  const seen = new Map<string, { kind: MapKind; file: string; key: string }>();
  for (const p of parts)
    for (const [kind, file] of Object.entries(p.textures ?? {}) as Array<[MapKind, string | undefined]>) {
      const key = file ? textureKey(root, file) : null;
      if (file && key && !seen.has(key)) seen.set(key, { kind, file, key });
    }
  return [...seen.values()];
}

const DECODE = `local B64 = {}
do
  local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for i = 1, 64 do B64[string.byte(chars, i)] = i - 1 end
end
local function decode(s, out)
  local o = 0
  for i = 1, #s, 4 do
    local a, b, c, d = string.byte(s, i, i + 3)
    local x = bit32.bor(bit32.lshift(B64[a], 18), bit32.lshift(B64[b], 12), bit32.lshift(B64[c] or 0, 6), B64[d] or 0)
    buffer.writeu8(out, o, bit32.rshift(x, 16))
    o += 1
    if c ~= 61 then
      buffer.writeu8(out, o, bit32.band(bit32.rshift(x, 8), 255))
      o += 1
    end
    if d ~= 61 then
      buffer.writeu8(out, o, bit32.band(x, 255))
      o += 1
    end
  end
  return o
end`;

/** The Studio calls that load one map: chunks, the last of which makes the image and attaches it. */
export function mapUploadLuau(root: string, map: { kind: MapKind; file: string; key: string }): string[] {
  const source = decodePng(readFileSync(join(root, MODEL_DIR, map.file)));
  const ch = CHANNELS[map.kind];
  const img = shrinkImage(source, ch === 1 && isConstantGray(source) ? CONSTANT_SIZE : LIMIT[map.kind]);
  const packed = new Uint8Array(img.width * img.height * ch);
  for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < ch; c++) packed[i * ch + c] = img.data[i * 4 + c]!;
  const b64 = Buffer.from(packed).toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
  const key = JSON.stringify(map.key);
  return chunks.map((chunk, i) => {
    const head = `local up = shared.ShurikenTexUpload or {}
shared.ShurikenTexUpload = up
local parts = up[${key}] or {}
up[${key}] = parts
parts[${i + 1}] = "${chunk}"`;
    if (i < chunks.length - 1) return `${head}\nreturn "chunk ${i + 1}/${chunks.length}"`;
    return `${head}
local AssetService = game:GetService("AssetService")
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
if #parts ~= ${chunks.length} then up[${key}] = nil error("a piece of ${map.file} went missing: send it again") end
local s = table.concat(parts)
up[${key}] = nil
${DECODE}
local w, h, ch = ${img.width}, ${img.height}, ${ch}
local raw = buffer.create(w * h * ch)
if decode(s, raw) ~= w * h * ch then error("${map.file} arrived damaged") end
local px = buffer.create(w * h * 4)
for i = 0, w * h - 1 do
  if ch == 4 then
    buffer.writeu32(px, i * 4, buffer.readu32(raw, i * 4))
  elseif ch == 3 then
    buffer.writeu8(px, i * 4, buffer.readu8(raw, i * 3))
    buffer.writeu8(px, i * 4 + 1, buffer.readu8(raw, i * 3 + 1))
    buffer.writeu8(px, i * 4 + 2, buffer.readu8(raw, i * 3 + 2))
    buffer.writeu8(px, i * 4 + 3, 255)
  else
    local g = buffer.readu8(raw, i)
    buffer.writeu32(px, i * 4, bit32.bor(g, bit32.lshift(g, 8), bit32.lshift(g, 16), 0xFF000000))
  end
end
local loaded = shared.ShurikenTextures or {}
shared.ShurikenTextures = loaded
-- An older version of this map (the model was repainted) makes room for the new one.
local file = string.split(${key}, "#")[1]
for k, old in loaded do
  if k ~= ${key} and string.split(k, "#")[1] == file then
    loaded[k] = nil
    pcall(function() old:Destroy() end)
  end
end
local okImg, img = pcall(function() return AssetService:CreateEditableImage({ Size = Vector2.new(w, h) }) end)
if not okImg or not img then error("Studio has no room left for temporary textures (its EditableImage memory is full): restart Studio, or upload the model") end
img:WritePixelsBuffer(Vector2.zero, Vector2.new(w, h), px)
loaded[${key}] = img
local PROP = { color = "ColorMapContent", normal = "NormalMapContent", roughness = "RoughnessMapContent", metalness = "MetalnessMapContent", emissive = "EmissiveMaskContent" }
local attached = 0
for _, sa in CollectionService:GetTagged("ShurikenTextured") do
  local ok, maps = pcall(function() return HttpService:JSONDecode(sa:GetAttribute("ShurikenMaps") or "{}") end)
  if ok then
    for kind, k in maps do
      if k == ${key} and PROP[kind] then
        sa[PROP[kind]] = Content.fromObject(img)
        attached += 1
      end
    end
  end
end
return "attached " .. attached`;
  });
}

/** Studio calls that attach the maps these parts need that Studio already has (after new SurfaceAppearances). */
export function knownMapsLuau(keys: string[]): string {
  return `local t = shared.ShurikenTextures or {}
local out = {}
for _, k in game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify(keys))}) do
  if t[k] then table.insert(out, k) end
end
return game:GetService("HttpService"):JSONEncode(out)`;
}

/**
 * Sends the maps these parts need that Studio doesn't have yet and attaches them to the waiting
 * SurfaceAppearances. Returns how many maps it sent; errors come back as values.
 */
export async function stageTextures(
  run: (code: string) => Promise<{ ok: boolean; output: string }>,
  root: string,
  parts: Array<{ textures?: TextureMaps }>,
): Promise<{ sent: number; error?: string }> {
  const maps = mapsOf(root, parts);
  if (!maps.length) return { sent: 0 };
  const known = await run(knownMapsLuau(maps.map((m) => m.key)));
  let have = new Set<string>();
  try {
    have = new Set(known.ok ? (JSON.parse(known.output.trim()) as string[]) : []);
  } catch {
    have = new Set();
  }
  let sent = 0;
  for (const m of maps) {
    if (have.has(m.key)) continue;
    for (const code of mapUploadLuau(root, m)) {
      const r = await run(code);
      if (!r.ok) return { sent, error: `${m.file}: ${r.output.slice(0, 300)}` };
    }
    sent++;
  }
  return { sent };
}
