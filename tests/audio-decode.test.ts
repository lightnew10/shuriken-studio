import { describe, expect, it } from 'vitest';
import { Mp3Encoder } from '@breezystack/lamejs';
import { decodeMp3 } from '../src/core/audio/mp3-decode';
import { decodeAudio, resample } from '../src/core/audio/decode';

// The MP3 decoder is checked against the encoder the app ships (lamejs, an independent implementation of the
// standard): what it encodes must come back. lamejs writes plain stereo without the bit reservoir and without a
// gapless tag, so the tests also rewrite its streams into the forms other encoders write (mid/side stereo, data
// borrowed from earlier frames, a LAME tag) and expect the same audio back.

const SR = 44100;

/** A test signal: partials and a little noise, so every subband carries something and no lag repeats. */
function signal(seconds: number, rate = SR, seed = 1, freqs = [220, 1000, 3100, 7400]): Float32Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    let v = (s / 0x7fffffff - 0.5) * 0.02;
    freqs.forEach((f, k) => (v += Math.sin((2 * Math.PI * f * i) / rate + k) * (0.25 / (k + 1))));
    x[i] = v;
  }
  return x;
}

/** Sharp decaying bursts: the encoder switches to short blocks for them. */
function clicks(seconds: number, rate = SR): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let k = 0; k < x.length; k += Math.round(rate * 0.25)) for (let j = 0; j < 400 && k + j < x.length; j++) x[k + j] = 0.8 * Math.exp(-j / 60) * Math.sin(j * 0.9);
  return x;
}

function encode(chs: Float32Array[], rate: number, kbps: number): Uint8Array {
  const toI16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  const l = toI16(chs[0]!);
  const r = chs[1] ? toI16(chs[1]) : undefined;
  const e = new Mp3Encoder(r ? 2 : 1, rate, kbps);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < l.length; i += 1152) parts.push(e.encodeBuffer(l.subarray(i, i + 1152), r?.subarray(i, i + 1152)));
  parts.push(e.flush());
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SNR (dB) of `y` against `x` delayed by `lag`, over the middle of the signal. */
function snr(x: Float32Array, y: Float32Array, lag: number): number {
  let sig = 0;
  let err = 0;
  for (let i = 2000; i < x.length - 2000; i++) {
    const j = i + lag;
    if (j < 0 || j >= y.length) continue;
    sig += x[i]! * x[i]!;
    err += (y[j]! - x[i]!) ** 2;
  }
  return 10 * Math.log10(sig / Math.max(err, 1e-20));
}

function bestLag(x: Float32Array, y: Float32Array): number {
  let best = 0;
  let bestV = -Infinity;
  for (let lag = 0; lag < 2400; lag++) {
    const v = snr(x, y, lag);
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  return best;
}

// ─── rewriting lamejs streams (MPEG-1, stereo, no CRC) ─────────────────────────

const bits = (b: Uint8Array) => Array.from(b, (x) => x.toString(2).padStart(8, '0')).join('');
const bytes = (s: string, size?: number) => {
  const out = new Uint8Array(size ?? Math.ceil(s.length / 8));
  for (let i = 0; i * 8 < s.length && i < out.length; i++) out[i] = parseInt(s.slice(i * 8, i * 8 + 8).padEnd(8, '0'), 2);
  return out;
};
const field = (n: number, width: number) => n.toString(2).padStart(width, '0');
const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

interface Frame {
  head: Uint8Array;
  /** Side info as bits: main_data_begin 9, private 3, scfsi 8, then gr0 ch0, gr0 ch1, gr1 ch0, gr1 ch1 (59 bits each). */
  side: string;
  /** Each granule and channel's main data (part2_3_length bits), in stream order. */
  parts: string[];
}

function readFrames(b: Uint8Array): Frame[] {
  const out: Frame[] = [];
  for (let at = 0; at + 4 <= b.length; ) {
    const kbps = KBPS[b[at + 2]! >> 4]!;
    const len = Math.floor((144000 * kbps) / SR) + ((b[at + 2]! >> 1) & 1);
    const side = bits(b.subarray(at + 4, at + 36));
    expect(parseInt(side.slice(0, 9), 2), 'lamejs writes no reservoir').toBe(0);
    const main = bits(b.subarray(at + 36, at + len));
    const parts: string[] = [];
    let p = 0;
    for (let k = 0; k < 4; k++) {
      const n = parseInt(side.slice(20 + k * 59, 32 + k * 59), 2);
      parts.push(main.slice(p, p + n));
      p += n;
    }
    out.push({ head: b.slice(at, at + 4), side, parts });
    at += len;
  }
  return out;
}

/** A frame of the given bitrate with these side bits and main data bytes (padded with zeros). */
function writeFrame(head: Uint8Array, kbpsIx: number, side: string, main: Uint8Array): Uint8Array {
  const len = Math.floor((144000 * KBPS[kbpsIx]!) / SR);
  const f = new Uint8Array(len);
  f.set(head);
  f[2] = (kbpsIx << 4) | (head[2]! & 0x0d); // the bitrate, no padding
  f.set(bytes(side, 32), 4);
  f.set(main.subarray(0, len - 36), 36);
  return f;
}

/**
 * A stream whose channels are the same, rewritten as mid/side: the mid channel is the left one 3 dB up
 * (global gain + 2 is a factor of 2^0.5) and the side channel is empty. It must decode to the same audio.
 */
function toMidSide(fs: Frame[]): Frame[] {
  return fs.map((f) => {
    const block = (k: number) => f.side.slice(20 + k * 59, 20 + (k + 1) * 59);
    const mid = (k: number) => {
      const b = block(k);
      return b.slice(0, 21) + field(parseInt(b.slice(21, 29), 2) + 2, 8) + b.slice(29);
    };
    const empty = (k: number) => '0'.repeat(33) + block(k).slice(33);
    const side = f.side.slice(0, 16) + '0000' + mid(0) + empty(0) + mid(2) + empty(2);
    const head = f.head.slice();
    head[3] = (head[3]! & 0x0f) | (1 << 6) | (2 << 4); // joint stereo, mid/side on
    return { head, side, parts: [f.parts[0]!, '', f.parts[2]!, ''] };
  });
}

/**
 * Repacks frames with the bit reservoir: every fifth frame at 320 kbps, the others as small as they can be, so
 * the frames after a big one start their data in it (main_data_begin up to 400 bytes back).
 */
function withReservoir(fs: Frame[]): { stream: Uint8Array; maxBegin: number } {
  const S: number[] = [];
  let W = 0;
  let maxBegin = 0;
  const layout: Array<{ f: Frame; ix: number; W: number; cap: number; begin: number }> = [];
  for (const [k, f] of fs.entries()) {
    const block = bytes(f.parts.join(''));
    const P = Math.max(S.length, W - 400);
    while (S.length < P) S.push(0);
    for (const v of block) S.push(v);
    let ix = k % 5 === 0 ? 14 : 1;
    while (ix < 14 && Math.floor((144000 * KBPS[ix]!) / SR) - 36 < P + block.length - W) ix++;
    const cap = Math.floor((144000 * KBPS[ix]!) / SR) - 36;
    maxBegin = Math.max(maxBegin, W - P);
    layout.push({ f, ix, W, cap, begin: W - P });
    W += cap;
  }
  // The payloads are cut from the whole stream once every frame's data is in it.
  const out = layout.map((l) => writeFrame(l.f.head, l.ix, field(l.begin, 9) + l.f.side.slice(9), Uint8Array.from(S.slice(l.W, l.W + l.cap))));
  return { stream: concat(out), maxBegin };
}

function plain(fs: Frame[]): Uint8Array {
  return concat(fs.map((f) => writeFrame(f.head, f.head[2]! >> 4, f.side, bytes(f.parts.join('')))));
}

/** An Info frame with a LAME tag (encoder delay and padding) in front of a stream. */
function withLameTag(stream: Uint8Array, frames: number, delay: number, padding: number): Uint8Array {
  const head = stream.slice(0, 4);
  const len = Math.floor((144000 * KBPS[head[2]! >> 4]!) / SR) + ((head[2]! >> 1) & 1);
  const f = new Uint8Array(len);
  f.set(head);
  let p = 4 + ((head[3]! >> 6) === 3 ? 17 : 32); // after the side info
  f.set(new TextEncoder().encode('Info'), p);
  f[p + 7] = 1; // flags: the frame count
  f[p + 8] = (frames >>> 24) & 255;
  f[p + 9] = (frames >>> 16) & 255;
  f[p + 10] = (frames >>> 8) & 255;
  f[p + 11] = frames & 255;
  p += 12;
  f.set(new TextEncoder().encode('LAME3.100'), p);
  f[p + 21] = delay >> 4;
  f[p + 22] = ((delay & 15) << 4) | (padding >> 8);
  f[p + 23] = padding & 255;
  return concat([f, stream]);
}

describe('mp3 decoder', () => {
  it('decodes what lamejs encodes, 576 samples late (the encoder delay), at every MPEG-1, 2 and 2.5 rate', () => {
    const cases: Array<[number, number, number]> = [
      [44100, 2, 320],
      [44100, 2, 128],
      [48000, 1, 192],
      [32000, 1, 128],
      [22050, 1, 64],
      [24000, 2, 96],
      [16000, 1, 48],
      [11025, 1, 32],
      [8000, 1, 24],
    ];
    for (const [rate, ch, kbps] of cases) {
      const x = signal(1.5, rate);
      const y = ch === 2 ? signal(1.5, rate, 7, [330, 1500, 4100]) : null;
      const d = decodeMp3(encode(y ? [x, y] : [x], rate, kbps));
      expect(d.ok, `${rate} ${kbps}`).toBe(true);
      if (!d.ok) continue;
      expect(d.sampleRate).toBe(rate);
      expect(d.channels.length).toBe(ch);
      expect(bestLag(x, d.channels[0]!), `${rate} ${kbps}`).toBe(576);
      // Quantization noise only: the encoder hides it 20-30 dB under the music (more at 320 kbps). A decoder
      // that gets any step wrong is under 5 dB.
      expect(snr(x, d.channels[0]!, 576), `${rate} ${kbps}`).toBeGreaterThan(kbps === 320 ? 35 : 16);
      if (y) expect(snr(y, d.channels[1]!, 576), `${rate} ${kbps} right`).toBeGreaterThan(16);
    }
  });

  it('decodes short blocks (transients) as well as long ones', () => {
    const x = clicks(2);
    const d = decodeMp3(encode([x], SR, 320));
    expect(d.ok).toBe(true);
    if (d.ok) expect(snr(x, d.channels[0]!, 576)).toBeGreaterThan(28);
  });

  it('reads mid/side stereo and data that starts in earlier frames (the bit reservoir) to the same audio', () => {
    const c = clicks(1.5);
    const x = Float32Array.from(signal(1.5), (v, i) => v * 0.7 + c[i]! * 0.3);
    const fs = readFrames(encode([x, x], SR, 192));
    const ref = decodeMp3(plain(fs));
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect(snr(x, ref.channels[0]!, 576)).toBeGreaterThan(22);
    const same = (d: ReturnType<typeof decodeMp3>, what: string) => {
      expect(d.ok, what).toBe(true);
      if (!d.ok) return;
      for (let c = 0; c < 2; c++) {
        let worst = 0;
        for (let i = 0; i < ref.channels[0]!.length; i++) worst = Math.max(worst, Math.abs(d.channels[c]![i]! - ref.channels[0]![i]!));
        expect(worst, `${what} channel ${c}`).toBeLessThan(1e-5);
      }
    };
    same(decodeMp3(plain(toMidSide(fs))), 'mid/side');
    const packed = withReservoir(toMidSide(fs));
    expect(packed.maxBegin).toBeGreaterThan(200);
    same(decodeMp3(packed.stream), 'mid/side with the reservoir');
  });

  it('trims the encoder delay and padding a LAME tag records, so a loop comes back sample-exact in length and place', () => {
    const x = signal(1.2);
    const stream = encode([x], SR, 192);
    const frames = readFramesMono(stream);
    const padding = frames * 1152 - 576 - x.length;
    const d = decodeMp3(withLameTag(stream, frames, 576, padding));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.gapless).toBe(true);
    expect(d.channels[0]!.length).toBe(x.length);
    expect(bestLag(x, d.channels[0]!)).toBe(0);
  });

  it('skips damaged bytes and refuses what is not an MP3', () => {
    const x = signal(2);
    const stream = encode([x], SR, 128);
    const broken = stream.slice();
    for (let i = 20000; i < 20600; i++) broken[i] = (i * 37) & 255;
    const d = decodeMp3(broken);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(Math.abs(d.channels[0]!.length - (x.length + 576))).toBeLessThan(4000);
      expect(d.channels[0]!.every((v) => Number.isFinite(v) && Math.abs(v) < 2)).toBe(true);
    }
    expect(decodeMp3(new TextEncoder().encode('<html>not audio</html>'.repeat(50))).ok).toBe(false);
    expect(decodeMp3(new Uint8Array(0)).ok).toBe(false);
  });

  it('stops at maxSeconds', () => {
    const d = decodeMp3(encode([signal(3)], SR, 128), { maxSeconds: 1 });
    expect(d.ok && d.channels[0]!.length).toBe(SR);
  });
});

// ─── WAV, AIFF, FLAC, resampling ─────────────────────────────────────────────

/** Integer test samples: a sine and a slower one, 16 bits. */
const ints = (n: number, f: number, amp = 20000) => Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * f * i) / 44100) + (amp / 4) * Math.sin((2 * Math.PI * f * 0.31 * i) / 44100)));

function wavFile(chs: number[][], bits: 8 | 16 | 24 | 32, rate = 44100, float = false): Uint8Array {
  const n = chs[0]!.length;
  const w = bits / 8;
  const b = Buffer.alloc(44 + n * chs.length * w);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * chs.length * w, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(float ? 3 : 1, 20);
  b.writeUInt16LE(chs.length, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * chs.length * w, 28);
  b.writeUInt16LE(chs.length * w, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * chs.length * w, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (const ch of chs) {
      const v = ch[i]!;
      if (float) b.writeFloatLE(v / 32768, o);
      else if (bits === 8) b.writeUInt8(Math.round(v / 256) + 128, o);
      else if (bits === 16) b.writeInt16LE(v, o);
      else if (bits === 24) b.writeIntLE(v * 256, o, 3);
      else b.writeInt32LE(v * 65536, o);
      o += w;
    }
  return b;
}

function aiffFile(ch: number[], rate: number): Uint8Array {
  const n = ch.length;
  const b = Buffer.alloc(12 + 26 + 16 + n * 2);
  b.write('FORM', 0);
  b.writeUInt32BE(b.length - 8, 4);
  b.write('AIFF', 8);
  b.write('COMM', 12);
  b.writeUInt32BE(18, 16);
  b.writeUInt16BE(1, 20);
  b.writeUInt32BE(n, 22);
  b.writeUInt16BE(16, 26);
  // 80-bit extended: exponent and a 64-bit mantissa with the integer bit set.
  const e = Math.floor(Math.log2(rate));
  b.writeUInt16BE(16383 + e, 28);
  const mant = BigInt(rate) << BigInt(63 - e);
  b.writeBigUInt64BE(mant, 30);
  b.write('SSND', 38);
  b.writeUInt32BE(8 + n * 2, 42);
  b.writeUInt32BE(0, 46);
  b.writeUInt32BE(0, 50);
  for (let i = 0; i < n; i++) b.writeInt16BE(ch[i]!, 54 + i * 2);
  return b;
}

/** A small FLAC encoder for the tests: verbatim, fixed and LPC subframes, Rice residuals, wasted bits, mid/side. */
function flacFile(chs: number[][], mode: 'independent' | 'midside'): Uint8Array {
  let bitsOut = '';
  const put = (v: number, n: number) => {
    const u = v < 0 ? v + 2 ** n : v;
    bitsOut += u.toString(2).padStart(n, '0').slice(-n);
  };
  const rice = (res: number[], k: number) => {
    put(0, 2); // 4-bit parameters
    put(0, 4); // partition order 0
    put(k, 4);
    for (const r of res) {
      const z = r >= 0 ? r * 2 : -r * 2 - 1;
      const q = Math.floor(z / 2 ** k);
      bitsOut += '0'.repeat(q) + '1';
      if (k) put(z % 2 ** k, k);
    }
  };
  const bestK = (res: number[]) => Math.max(0, Math.min(14, Math.round(Math.log2(Math.max(1, res.reduce((a, r) => a + Math.abs(r), 0) / Math.max(1, res.length))))));
  const n = chs[0]!.length;
  const block = 1024;
  const header = Buffer.alloc(4 + 4 + 34);
  header.write('fLaC', 0);
  header[4] = 0x80; // last metadata block, STREAMINFO
  header.writeUIntBE(34, 5, 3);
  header.writeUInt16BE(block, 8);
  header.writeUInt16BE(block, 10);
  // sample rate 20 bits, channels-1 3 bits, bps-1 5 bits, total samples 36 bits
  const v = (BigInt(44100) << 44n) | (BigInt(chs.length - 1) << 41n) | (15n << 36n) | BigInt(n);
  header.writeBigUInt64BE(v, 18);
  const frames: Buffer[] = [header];
  for (let f = 0, s0 = 0; s0 < n; f++, s0 += block) {
    bitsOut = '';
    const len = Math.min(block, n - s0);
    put(0xfff8, 16);
    put(len === block ? 10 : 7, 4); // 1024, or a 16-bit size at the end of the header
    put(9, 4); // 44.1 kHz
    put(chs.length === 1 ? 0 : mode === 'midside' ? 10 : 1, 4);
    put(4, 3); // 16 bits
    put(0, 1);
    put(f, 8); // frame number (< 128)
    if (len !== block) put(len - 1, 16);
    put(0, 8); // CRC-8 (not checked)
    let subs = chs.map((c) => c.slice(s0, s0 + len));
    if (mode === 'midside' && subs.length === 2) subs = [subs[0]!.map((l, i) => (l + subs[1]![i]!) >> 1), subs[0]!.map((l, i) => l - subs[1]![i]!)];
    subs.forEach((x, c) => {
      const bps = 16 + (mode === 'midside' && c === 1 ? 1 : 0);
      const kind = (f + c) % 4;
      if (kind === 0) {
        put(0, 1);
        put(1, 6); // verbatim
        put(0, 1);
        for (const s of x) put(s, bps);
      } else if (kind === 1) {
        put(0, 1);
        put(8 + 2, 6); // fixed, order 2
        put(0, 1);
        put(x[0]!, bps);
        put(x[1]!, bps);
        const res = x.slice(2).map((s, i) => s - (2 * x[i + 1]! - x[i]!));
        rice(res, bestK(res));
      } else if (kind === 2) {
        // LPC order 2: coefficients 1.8 and -0.85 at precision 12, shift 10
        const c1 = Math.round(1.8 * 1024);
        const c2 = Math.round(-0.85 * 1024);
        put(0, 1);
        put(31 + 2, 6);
        put(0, 1);
        put(x[0]!, bps);
        put(x[1]!, bps);
        put(12 - 1, 4);
        put(10, 5);
        put(c1, 12);
        put(c2, 12);
        const res = x.slice(2).map((s, i) => s - Math.floor((c1 * x[i + 1]! + c2 * x[i]!) / 1024));
        rice(res, bestK(res));
      } else {
        // wasted bits: the low bits every sample has as zeros are dropped (2 for the inputs, 1 for a mid channel)
        const w = x.every((s) => s % 4 === 0) ? 2 : x.every((s) => s % 2 === 0) ? 1 : 0;
        put(0, 1);
        put(1, 6);
        put(w ? 1 : 0, 1);
        if (w) bitsOut += `${'0'.repeat(w - 1)}1`; // unary: w - 1 zeros, then a one
        for (const s of x) put(s / 2 ** w, bps - w);
      }
    });
    while (bitsOut.length % 8) bitsOut += '0';
    put(0, 16); // CRC-16 (not checked)
    frames.push(Buffer.from(bytes(bitsOut)));
  }
  return concat(frames);
}

describe('wav, aiff and flac decoders, and the resampler', () => {
  it('reads 8, 16, 24 and 32-bit and float WAVs, mono and stereo', () => {
    const a = ints(3000, 440);
    const b = ints(3000, 660, 12000);
    for (const bits of [8, 16, 24, 32] as const) {
      const d = decodeAudio(wavFile([a, b], bits));
      expect(d.ok, `${bits}`).toBe(true);
      if (!d.ok) continue;
      expect(d.format).toBe('wav');
      expect(d.channels.length).toBe(2);
      const tol = bits === 8 ? 1 / 128 + 1e-6 : 1e-6;
      for (let i = 0; i < a.length; i += 37) {
        expect(Math.abs(d.channels[0]![i]! - a[i]! / 32768)).toBeLessThanOrEqual(tol);
        expect(Math.abs(d.channels[1]![i]! - b[i]! / 32768)).toBeLessThanOrEqual(tol);
      }
    }
    const f = decodeAudio(wavFile([a], 32, 22050, true));
    expect(f.ok && f.sampleRate === 22050 && Math.abs(f.channels[0]![100]! - a[100]! / 32768) < 1e-6).toBe(true);
  });

  it('reads an AIFF (big-endian, an 80-bit sample rate)', () => {
    const a = ints(2000, 300);
    const d = decodeAudio(aiffFile(a, 22050));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.format).toBe('aiff');
    expect(d.sampleRate).toBe(22050);
    expect(d.channels[0]!.length).toBe(2000);
    expect(d.channels[0]![123]).toBeCloseTo(a[123]! / 32768, 6);
  });

  it('reads FLAC exactly: verbatim, fixed, LPC, wasted bits, independent and mid/side stereo', () => {
    const a = ints(5000, 440).map((v) => v - (v % 4));
    const b = ints(5000, 550, 15000).map((v) => v - (v % 4));
    for (const mode of ['independent', 'midside'] as const) {
      const d = decodeAudio(flacFile([a, b], mode));
      expect(d.ok, mode).toBe(true);
      if (!d.ok) continue;
      expect(d.format).toBe('flac');
      expect(d.channels[0]!.length).toBe(5000);
      let worst = 0;
      for (let i = 0; i < 5000; i++) worst = Math.max(worst, Math.abs(d.channels[0]![i]! * 32768 - a[i]!), Math.abs(d.channels[1]![i]! * 32768 - b[i]!));
      expect(worst, mode).toBeLessThan(1e-3);
    }
  });

  it('refuses Ogg and what is not audio, with a reason', () => {
    const ogg = new Uint8Array(64);
    ogg.set(new TextEncoder().encode('OggS'), 0);
    const r = decodeAudio(ogg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Ogg/);
    expect(decodeAudio(new TextEncoder().encode('just some text, nothing more')).ok).toBe(false);
  });

  it('resamples to 44.1 kHz keeping the pitch and the level', () => {
    for (const from of [48000, 22050, 32000]) {
      const x = Float32Array.from({ length: from }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / from));
      const y = resample(x, from, 44100);
      expect(Math.abs(y.length - 44100)).toBeLessThanOrEqual(1);
      let crossings = 0;
      for (let i = 2000; i < y.length - 2000; i++) if (y[i - 1]! < 0 && y[i]! >= 0) crossings++;
      expect(crossings / ((y.length - 4000) / 44100)).toBeCloseTo(1000, -1);
      let ms = 0;
      for (let i = 2000; i < y.length - 2000; i++) ms += y[i]! * y[i]!;
      expect(Math.sqrt(ms / (y.length - 4000))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    }
  });
});

/** Frames in a mono lamejs stream. */
function readFramesMono(b: Uint8Array): number {
  let n = 0;
  for (let at = 0; at + 4 <= b.length; n++) at += Math.floor((144000 * KBPS[b[at + 2]! >> 4]!) / SR) + ((b[at + 2]! >> 1) & 1);
  return n;
}
