import type { RgbaImage } from '../modeling/png';

/**
 * A small baseline JPEG decoder (no dependencies): sequential Huffman, 8-bit, one (grey) or three (YCbCr, or
 * RGB with Adobe's transform 0) components, any sampling factors, restart intervals. That is what Studio's
 * screen_capture writes (baseline 4:2:0 at 1920 px wide). Progressive, arithmetic-coded, 12-bit and CMYK files
 * throw a plain error: the look analysis only needs Studio's pictures and our own evidence.
 */

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** cos((2x+1)uπ/16) · C(u)/2, the separable IDCT basis (row u, column x). */
const IDCT = (() => {
  const m = new Float32Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) m[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return m;
})();

interface Huffman {
  /** code (left-aligned to 9 bits) → length << 8 | symbol, 0 when longer than 9 bits. */
  fast: Uint16Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const fast = new Uint16Array(512);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1]!;
    valptr[len] = k;
    mincode[len] = code;
    for (let i = 0; i < n; i++, k++, code++) {
      if (len <= 9) {
        const shift = 9 - len;
        const base = code << shift;
        for (let j = 0; j < 1 << shift; j++) fast[base + j] = (len << 8) | values[k]!;
      }
    }
    maxcode[len] = n ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { fast, maxcode, valptr, mincode, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Blocks per line and column padded to whole MCUs. */
  bpl: number;
  bpc: number;
  coefs: Int16Array;
  dc: Huffman | null;
  ac: Huffman | null;
  pred: number;
}

export function isJpeg(buf: Uint8Array): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export function decodeJpeg(buf: Uint8Array): RgbaImage {
  if (!isJpeg(buf)) throw new Error('not a JPEG');
  const qt: (Uint16Array | null)[] = [null, null, null, null];
  const dcTables: (Huffman | null)[] = [null, null, null, null];
  const acTables: (Huffman | null)[] = [null, null, null, null];
  let comps: Component[] = [];
  let width = 0;
  let height = 0;
  let hmax = 1;
  let vmax = 1;
  let mcusX = 0;
  let mcusY = 0;
  let restart = 0;
  let adobeTransform = -1;
  let frame = false;
  let pos = 2;
  const u16 = (at: number) => (buf[at]! << 8) | buf[at + 1]!;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1]!;
    pos += 2;
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker === 0xff) pos--;
      continue;
    }
    if (marker === 0xd9) break;
    const len = u16(pos);
    const seg = pos + 2;
    const end = pos + len;
    if (marker === 0xdb) {
      for (let at = seg; at < end; ) {
        const pq = buf[at]! >> 4;
        const tq = buf[at]! & 15;
        at++;
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++, at += pq ? 2 : 1) t[i] = pq ? u16(at) : buf[at]!;
        qt[tq & 3] = t;
      }
    } else if (marker === 0xc4) {
      for (let at = seg; at < end; ) {
        const tc = buf[at]! >> 4;
        const th = buf[at]! & 3;
        const counts = buf.subarray(at + 1, at + 17);
        let n = 0;
        for (const c of counts) n += c;
        const values = buf.subarray(at + 17, at + 17 + n);
        (tc ? acTables : dcTables)[th] = buildHuffman(counts, values);
        at += 17 + n;
      }
    } else if (marker === 0xdd) {
      restart = u16(seg);
    } else if (marker === 0xee && len >= 12 && String.fromCharCode(...buf.subarray(seg, seg + 5)) === 'Adobe') {
      adobeTransform = buf[seg + 11]!;
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (buf[seg] !== 8) throw new Error(`unsupported JPEG (${buf[seg]}-bit samples)`);
      height = u16(seg + 1);
      width = u16(seg + 3);
      const n = buf[seg + 5]!;
      if (n !== 1 && n !== 3) throw new Error(`unsupported JPEG (${n} components${n === 4 ? ', CMYK' : ''})`);
      if (!width || !height) throw new Error('unsupported JPEG (no size in the frame header)');
      comps = [];
      for (let i = 0; i < n; i++) {
        const at = seg + 6 + i * 3;
        comps.push({ id: buf[at]!, h: buf[at + 1]! >> 4 || 1, v: buf[at + 1]! & 15 || 1, tq: buf[at + 2]! & 3, blocksPerLine: 0, blocksPerColumn: 0, bpl: 0, bpc: 0, coefs: new Int16Array(0), dc: null, ac: null, pred: 0 });
      }
      hmax = Math.max(...comps.map((c) => c.h));
      vmax = Math.max(...comps.map((c) => c.v));
      mcusX = Math.ceil(width / (8 * hmax));
      mcusY = Math.ceil(height / (8 * vmax));
      for (const c of comps) {
        c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
        c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
        c.bpl = mcusX * c.h;
        c.bpc = mcusY * c.v;
        c.coefs = new Int16Array(c.bpl * c.bpc * 64);
      }
      frame = true;
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error(`unsupported JPEG (${marker === 0xc2 ? 'progressive' : marker >= 0xc9 ? 'arithmetic-coded' : 'lossless or hierarchical'}; only baseline is decoded)`);
    } else if (marker === 0xda) {
      if (!frame) throw new Error('corrupt JPEG (scan before the frame header)');
      const ns = buf[seg]!;
      const inScan: Component[] = [];
      for (let i = 0; i < ns; i++) {
        const id = buf[seg + 1 + i * 2]!;
        const t = buf[seg + 2 + i * 2]!;
        const c = comps.find((x) => x.id === id);
        if (!c) throw new Error('corrupt JPEG (scan names an unknown component)');
        c.dc = dcTables[t >> 4 & 3]!;
        c.ac = acTables[t & 3]!;
        if (!c.dc || !c.ac) throw new Error('corrupt JPEG (scan uses a missing Huffman table)');
        inScan.push(c);
      }
      pos = decodeScan(buf, end, inScan, mcusX, mcusY, restart);
      continue;
    }
    pos = end;
  }
  if (!frame) throw new Error('corrupt JPEG (no frame header)');

  // Dequantize, inverse DCT, then upsample and convert to RGBA.
  const planes = comps.map((c) => {
    const q = qt[c.tq];
    if (!q) throw new Error('corrupt JPEG (missing quantization table)');
    const w = c.bpl * 8;
    const plane = new Uint8ClampedArray(w * c.bpc * 8);
    const block = new Float32Array(64);
    const tmp = new Float32Array(64);
    for (let by = 0; by < c.bpc; by++) {
      for (let bx = 0; bx < c.bpl; bx++) {
        const off = (by * c.bpl + bx) * 64;
        block.fill(0);
        for (let i = 0; i < 64; i++) {
          const v = c.coefs[off + i]!;
          if (v) block[ZIGZAG[i]!] = v * q[i]!;
        }
        // Rows: tmp[y][x] = Σu F[y][u]·basis[u][x]; then columns.
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            let s = 0;
            for (let u = 0; u < 8; u++) s += block[y * 8 + u]! * IDCT[u * 8 + x]!;
            tmp[y * 8 + x] = s;
          }
        }
        const base = by * 8 * w + bx * 8;
        for (let x = 0; x < 8; x++) {
          for (let y = 0; y < 8; y++) {
            let s = 0;
            for (let v = 0; v < 8; v++) s += tmp[v * 8 + x]! * IDCT[v * 8 + y]!;
            plane[base + y * w + x] = Math.round(s + 128);
          }
        }
      }
    }
    return { plane, w, sx: c.h / hmax, sy: c.v / vmax };
  });

  const data = new Uint8Array(width * height * 4);
  const rgb = comps.length === 3 && (adobeTransform === 0 || (adobeTransform === -1 && comps[0]!.id === 0x52 && comps[1]!.id === 0x47 && comps[2]!.id === 0x42));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const sample = (p: (typeof planes)[number]) => p.plane[Math.floor(y * p.sy) * p.w + Math.floor(x * p.sx)]!;
      if (planes.length === 1) {
        const g = sample(planes[0]!);
        data[o] = data[o + 1] = data[o + 2] = g;
      } else if (rgb) {
        data[o] = sample(planes[0]!);
        data[o + 1] = sample(planes[1]!);
        data[o + 2] = sample(planes[2]!);
      } else {
        const Y = sample(planes[0]!);
        const cb = sample(planes[1]!) - 128;
        const cr = sample(planes[2]!) - 128;
        data[o] = clamp(Y + 1.402 * cr);
        data[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
        data[o + 2] = clamp(Y + 1.772 * cb);
      }
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Decodes one scan's entropy-coded data; returns the position after it (at the next marker). */
function decodeScan(buf: Uint8Array, start: number, comps: Component[], mcusX: number, mcusY: number, restart: number): number {
  let pos = start;
  let bits = 0;
  let nbits = 0;
  let atMarker = false;
  const fill = () => {
    while (nbits <= 24) {
      let byte = 0;
      if (!atMarker && pos < buf.length) {
        byte = buf[pos]!;
        if (byte === 0xff) {
          const next = buf[pos + 1];
          if (next === 0x00) pos += 2;
          else {
            atMarker = true;
            byte = 0;
          }
        } else pos++;
      }
      bits = ((bits << 8) | byte) >>> 0;
      nbits += 8;
    }
  };
  const peek = (n: number) => (bits >>> (nbits - n)) & ((1 << n) - 1);
  const skip = (n: number) => {
    nbits -= n;
    bits = nbits ? (bits & (0xffffffff >>> (32 - nbits))) >>> 0 : 0;
  };
  const receive = (n: number) => {
    if (!n) return 0;
    if (nbits < n) fill();
    const v = peek(n);
    skip(n);
    return v;
  };
  const extend = (v: number, n: number) => (v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decode = (h: Huffman) => {
    if (nbits < 16) fill();
    const f = h.fast[peek(9)]!;
    if (f) {
      skip(f >> 8);
      return f & 255;
    }
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | ((bits >>> (nbits - len)) & 1);
      if (code <= h.maxcode[len]!) {
        skip(len);
        return h.values[h.valptr[len]! + code - h.mincode[len]!]!;
      }
    }
    throw new Error('corrupt JPEG (bad Huffman code)');
  };
  const decodeBlock = (c: Component, off: number) => {
    const t = decode(c.dc!);
    c.pred += t ? extend(receive(t), t) : 0;
    c.coefs[off] = c.pred;
    for (let k = 1; k < 64; ) {
      const rs = decode(c.ac!);
      const s = rs & 15;
      const r = rs >> 4;
      if (!s) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coefs[off + k] = extend(receive(s), s);
      k++;
    }
  };
  const restartAt = () => {
    // Drop the bits left in the byte, step over the RSTn marker and start again from fresh predictors.
    bits = 0;
    nbits = 0;
    atMarker = false;
    while (pos + 1 < buf.length && !(buf[pos] === 0xff && buf[pos + 1]! >= 0xd0 && buf[pos + 1]! <= 0xd7)) {
      if (buf[pos] === 0xff && buf[pos + 1] !== 0 && buf[pos + 1] !== 0xff) return false;
      pos++;
    }
    pos += 2;
    for (const c of comps) c.pred = 0;
    return true;
  };

  for (const c of comps) c.pred = 0;
  if (comps.length === 1) {
    // Non-interleaved: the component's own blocks, without MCU padding.
    const c = comps[0]!;
    const total = c.blocksPerLine * c.blocksPerColumn;
    for (let n = 0; n < total; n++) {
      if (restart && n && n % restart === 0 && !restartAt()) break;
      const by = Math.floor(n / c.blocksPerLine);
      const bx = n % c.blocksPerLine;
      decodeBlock(c, (by * c.bpl + bx) * 64);
    }
  } else {
    const total = mcusX * mcusY;
    for (let n = 0; n < total; n++) {
      if (restart && n && n % restart === 0 && !restartAt()) break;
      const my = Math.floor(n / mcusX);
      const mx = n % mcusX;
      for (const c of comps) {
        for (let v = 0; v < c.v; v++) {
          for (let h = 0; h < c.h; h++) decodeBlock(c, ((my * c.v + v) * c.bpl + mx * c.h + h) * 64);
        }
      }
    }
  }
  // Find the marker that ends the scan.
  while (pos + 1 < buf.length && !(buf[pos] === 0xff && buf[pos + 1] !== 0 && !(buf[pos + 1]! >= 0xd0 && buf[pos + 1]! <= 0xd7))) pos++;
  return pos;
}
