import { deflateSync, inflateSync } from 'node:zlib';

/** An image as 8-bit RGBA, top row first. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes a PNG (8-bit gray, gray+alpha, RGB, RGBA or palette, not interlaced — what Shuriken's Blender export
 * and most tools write) into RGBA. Anything else throws.
 */
export function decodePng(buf: Uint8Array): RgbaImage {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = view.getUint32(at);
    const kind = String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const ch = type === 3 && palette ? 1 : CHANNELS[type];
  if (depth !== 8 || !ch || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${type}${interlace ? ', interlaced' : ''})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch]! : 0;
      const b = up ? up[x]! : 0;
      const c = up && x >= ch ? up[x - ch]! : 0;
      let v = src[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += ch) {
    const g = px[j]!;
    if (type === 3) data.set([palette![g * 3] ?? 0, palette![g * 3 + 1] ?? 0, palette![g * 3 + 2] ?? 0, trns && g < trns.length ? trns[g]! : 255], i * 4);
    else if (ch === 1) data.set([g, g, g, 255], i * 4);
    else if (ch === 2) data.set([g, g, g, px[j + 1]!], i * 4);
    else if (ch === 3) data.set([g, px[j + 1]!, px[j + 2]!, 255], i * 4);
    else data.set([g, px[j + 1]!, px[j + 2]!, px[j + 3]!], i * 4);
  }
  return { width, height, data };
}

/** The image at most `max` pixels on a side (whole-pixel box averaging; smaller images come back as they are). */
export function shrinkImage(img: RgbaImage, max: number): RgbaImage {
  const f = Math.ceil(Math.max(img.width, img.height) / max);
  if (f <= 1) return img;
  const w = Math.max(1, Math.floor(img.width / f));
  const h = Math.max(1, Math.floor(img.height / f));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += img.data[((y * f + dy) * img.width + x * f + dx) * 4 + c]!;
        data[(y * w + x) * 4 + c] = Math.round(sum / (f * f));
      }
  return { width: w, height: h, data };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An RGBA PNG (8-bit, no filtering) — the same shape Shuriken's Blender export writes. */
export function encodePng(img: RgbaImage): Buffer {
  const rows = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(rows, y * (img.width * 4 + 1) + 1);
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
