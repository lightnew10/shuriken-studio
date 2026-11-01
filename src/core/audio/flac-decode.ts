/**
 * A FLAC decoder in plain TypeScript (FLAC is lossless: what an artist exports when the sound matters, and
 * how some of the web's CC0 sounds come). Every part of the format a file can use: constant, verbatim, fixed
 * and LPC subframes, Rice-coded residuals (escape codes included), wasted bits, and the left/side, right/side
 * and mid/side channel modes, at 8 to 32 bits. Checksums are not verified (a damaged frame is skipped by sync).
 */
import type { DecodedPcm } from './mp3-decode';

export type FlacDecoded = ({ ok: true } & DecodedPcm) | { ok: false; error: string };

class Bits {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get bytePos(): number {
    return this.pos >> 3;
  }
  bit(): number {
    const v = ((this.b[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  signed(n: number): number {
    if (n === 0) return 0;
    const v = this.read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }
  /** Zeros before the next one. */
  unary(): number {
    let n = 0;
    while (this.bit() === 0) {
      n++;
      if (n > 1 << 20) throw new Error('bad unary code');
    }
    return n;
  }
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
  get done(): boolean {
    return this.pos >= this.b.length * 8;
  }
}

interface StreamInfo {
  sampleRate: number;
  channels: number;
  bps: number;
  total: number;
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const DEPTHS = [0, 8, 12, 0, 16, 20, 24, 32];

function residual(br: Bits, out: Float64Array, order: number, blockSize: number): void {
  const method = br.read(2);
  if (method > 1) throw new Error('reserved residual coding');
  const paramBits = method === 0 ? 4 : 5;
  const escape = method === 0 ? 15 : 31;
  const partOrder = br.read(4);
  const parts = 1 << partOrder;
  let i = order;
  for (let p = 0; p < parts; p++) {
    const n = (blockSize >> partOrder) - (p === 0 ? order : 0);
    const k = br.read(paramBits);
    if (k === escape) {
      const raw = br.read(5);
      for (let j = 0; j < n; j++) out[i++] = br.signed(raw);
    } else
      for (let j = 0; j < n; j++) {
        const v = br.unary() * 2 ** k + br.read(k);
        out[i++] = v % 2 === 0 ? v / 2 : -(v + 1) / 2;
      }
  }
}

const FIXED: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function subframe(br: Bits, bps: number, blockSize: number): Float64Array {
  if (br.bit() !== 0) throw new Error('bad subframe');
  const type = br.read(6);
  let wasted = 0;
  if (br.bit()) wasted = br.unary() + 1;
  const bits = bps - wasted;
  const x = new Float64Array(blockSize);
  if (type === 0) x.fill(br.signed(bits));
  else if (type === 1) for (let i = 0; i < blockSize; i++) x[i] = br.signed(bits);
  else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) x[i] = br.signed(bits);
    residual(br, x, order, blockSize);
    const c = FIXED[order]!;
    for (let i = order; i < blockSize; i++) {
      let s = 0;
      for (let j = 0; j < order; j++) s += c[j]! * x[i - 1 - j]!;
      x[i]! += s;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) x[i] = br.signed(bits);
    const precision = br.read(4) + 1;
    if (precision === 16) throw new Error('bad LPC precision');
    const shift = br.signed(5);
    const coefs: number[] = [];
    for (let i = 0; i < order; i++) coefs.push(br.signed(precision));
    residual(br, x, order, blockSize);
    const div = 2 ** Math.max(0, shift);
    for (let i = order; i < blockSize; i++) {
      let s = 0;
      for (let j = 0; j < order; j++) s += coefs[j]! * x[i - 1 - j]!;
      x[i]! += Math.floor(s / div);
    }
  } else throw new Error(`reserved subframe type ${type}`);
  if (wasted) for (let i = 0; i < blockSize; i++) x[i]! *= 2 ** wasted;
  return x;
}

/** The UTF-8-like coded frame or sample number. */
function codedNumber(br: Bits): void {
  const first = br.read(8);
  let extra = 0;
  for (let m = 0x80; first & m && extra < 7; m >>= 1) extra++;
  for (let i = 1; i < extra; i++) br.read(8);
}

/** Decodes a FLAC file to PCM at its own sample rate (at most `maxSeconds` of it). */
export function decodeFlac(bytes: Uint8Array, opts: { maxSeconds?: number } = {}): FlacDecoded {
  if (bytes.length < 42 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') return { ok: false, error: 'not a FLAC file' };
  let at = 4;
  let info: StreamInfo | null = null;
  for (;;) {
    if (at + 4 > bytes.length) return { ok: false, error: 'a FLAC file cut short in its header' };
    const last = (bytes[at]! & 0x80) !== 0;
    const type = bytes[at]! & 0x7f;
    const len = (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (type === 0) {
      const br = new Bits(bytes.subarray(at + 4, at + 4 + len));
      br.read(16 + 16 + 24 + 24);
      const sampleRate = br.read(20);
      const channels = br.read(3) + 1;
      const bps = br.read(5) + 1;
      const total = br.read(36);
      info = { sampleRate, channels, bps, total };
    }
    at += 4 + len;
    if (last) break;
  }
  if (!info || !info.sampleRate) return { ok: false, error: 'a FLAC file without stream info' };
  const limit = Math.ceil((opts.maxSeconds ?? 600) * info.sampleRate);
  const want = info.total ? Math.min(info.total, limit) : limit;
  const nch = Math.min(2, info.channels);
  const out = Array.from({ length: nch }, () => new Float32Array(Math.min(want, 1 << 20)));
  const scale = 1 / 2 ** (info.bps - 1);
  let written = 0;
  while (at + 2 <= bytes.length && written < want) {
    // Frame sync: 1111 1111 1111 10xx
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xfe) !== 0xf8) {
      at++;
      continue;
    }
    const br = new Bits(bytes.subarray(at));
    try {
      br.read(16);
      const bsCode = br.read(4);
      const rateCode = br.read(4);
      const chanCode = br.read(4);
      const depthCode = br.read(3);
      br.read(1);
      codedNumber(br);
      let blockSize = BLOCK_SIZES[bsCode]!;
      if (bsCode === 6) blockSize = br.read(8) + 1;
      else if (bsCode === 7) blockSize = br.read(16) + 1;
      if (rateCode === 12) br.read(8);
      else if (rateCode === 13 || rateCode === 14) br.read(16);
      else if (rateCode === 15) throw new Error('bad sample rate code');
      br.read(8); // CRC-8
      const bps = depthCode === 0 ? info.bps : DEPTHS[depthCode]!;
      if (!bps || !blockSize || chanCode > 10) throw new Error('bad frame header');
      const chans = chanCode < 8 ? chanCode + 1 : 2;
      const subs: Float64Array[] = [];
      for (let c = 0; c < chans; c++) {
        const side = (chanCode === 8 && c === 1) || (chanCode === 9 && c === 0) || (chanCode === 10 && c === 1);
        subs.push(subframe(br, bps + (side ? 1 : 0), blockSize));
      }
      if (chanCode === 8) for (let i = 0; i < blockSize; i++) subs[1]![i] = subs[0]![i]! - subs[1]![i]!;
      else if (chanCode === 9) for (let i = 0; i < blockSize; i++) subs[0]![i] = subs[0]![i]! + subs[1]![i]!;
      else if (chanCode === 10)
        for (let i = 0; i < blockSize; i++) {
          const s = subs[1]![i]!;
          const mid = subs[0]![i]! * 2 + (Math.abs(s) % 2);
          subs[0]![i] = (mid + s) / 2;
          subs[1]![i] = (mid - s) / 2;
        }
      br.align();
      br.read(16); // CRC-16
      const n = Math.min(blockSize, want - written);
      if (written + n > out[0]!.length) {
        for (let c = 0; c < nch; c++) {
          const next = new Float32Array(Math.min(want, Math.max(written + n, out[c]!.length * 2)));
          next.set(out[c]!);
          out[c] = next;
        }
      }
      for (let c = 0; c < nch; c++) {
        const src = subs[Math.min(c, subs.length - 1)]!;
        const dst = out[c]!;
        for (let i = 0; i < n; i++) dst[written + i] = src[i]! * scale;
      }
      written += n;
      at += br.bytePos;
    } catch {
      at++;
    }
  }
  if (!written) return { ok: false, error: 'a FLAC file with no readable audio' };
  return { ok: true, sampleRate: info.sampleRate, channels: out.map((o) => o.slice(0, written)) };
}
