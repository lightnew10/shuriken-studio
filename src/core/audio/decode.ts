/**
 * Reading audio files into PCM, for samples: WAV (PCM 8-32 bit and float), AIFF/AIFC (PCM, little-endian
 * "sowt", float), FLAC and MP3 (flac-decode.ts, mp3-decode.ts), all in plain TypeScript, and the resampler
 * that brings them to the engine's 44.1 kHz. Ogg Vorbis and Opus are not read: a sample in them is refused
 * with a reason (the same sound on Freesound or in a user's pack is nearly always also an MP3, WAV or FLAC).
 */
import { decodeFlac } from './flac-decode';
import { decodeMp3, type DecodedPcm } from './mp3-decode';
import { SAMPLE_RATE } from './dsp/util';

export type { DecodedPcm };
export type Decoded = ({ ok: true; format: SampleFileFormat } & DecodedPcm) | { ok: false; error: string };
export type SampleFileFormat = 'wav' | 'aiff' | 'flac' | 'mp3';

/** File extensions read as samples (the user's folders are scanned for these). */
export const SAMPLE_EXTENSIONS = ['.wav', '.wave', '.aif', '.aiff', '.aifc', '.flac', '.mp3'];

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** The format the bytes are in (not the extension), or null. */
export function sampleFormat(b: Uint8Array): SampleFileFormat | 'ogg' | null {
  if (b.length < 12) return null;
  const head = ascii(b, 0, 4);
  if (head === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (head === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC')) return 'aiff';
  if (head === 'fLaC') return 'flac';
  if (head === 'OggS') return 'ogg';
  if (head.startsWith('ID3') || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/** Decodes any supported file (at most `maxSeconds` of it), at its own sample rate. */
export function decodeAudio(bytes: Uint8Array, opts: { maxSeconds?: number } = {}): Decoded {
  const f = sampleFormat(bytes);
  switch (f) {
    case 'wav':
      return tag(decodeWav(bytes, opts.maxSeconds), 'wav');
    case 'aiff':
      return tag(decodeAiff(bytes, opts.maxSeconds), 'aiff');
    case 'flac':
      return tag(decodeFlac(bytes, opts), 'flac');
    case 'mp3':
      return tag(decodeMp3(bytes, opts), 'mp3');
    case 'ogg':
      return { ok: false, error: 'an Ogg file: Ogg Vorbis and Opus are not read here (use the MP3, WAV or FLAC of the same sound)' };
    default:
      return { ok: false, error: 'not an audio file this app reads (WAV, AIFF, FLAC or MP3)' };
  }
}

function tag(d: ({ ok: true } & DecodedPcm) | { ok: false; error: string }, format: SampleFileFormat): Decoded {
  if (!d.ok) return d;
  if (!d.channels.length || !d.channels[0]!.length) return { ok: false, error: 'the file holds no audio' };
  return { ok: true, format, sampleRate: d.sampleRate, channels: d.channels.slice(0, 2) };
}

// ─── WAV ────────────────────────────────────────────────────────────────────

function decodeWav(b: Uint8Array, maxSeconds?: number): ({ ok: true } & DecodedPcm) | { ok: false; error: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number; align: number } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = dv.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= b.length) {
      let t = dv.getUint16(body, true);
      if (t === 0xfffe && size >= 26 && body + 26 <= b.length) t = dv.getUint16(body + 24, true);
      fmt = { tag: t, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true), align: dv.getUint16(body + 12, true) };
    } else if (id === 'data') {
      if (!fmt) return { ok: false, error: 'a WAV without a format chunk before its data' };
      const bytes = size === 0 || size === 0xffffffff || body + size > b.length ? b.length - body : size;
      return pcm(dv, body, bytes, fmt.channels, fmt.rate, fmt.bits, fmt.tag === 3 ? 'float' : fmt.tag === 1 ? 'int' : null, true, maxSeconds);
    }
    at = body + size + (size & 1);
  }
  return { ok: false, error: 'a WAV without a data chunk' };
}

// ─── AIFF ───────────────────────────────────────────────────────────────────

/** The 80-bit IEEE extended number AIFF stores its sample rate in. */
function extended(dv: DataView, at: number): number {
  const exp = dv.getUint16(at) & 0x7fff;
  const hi = dv.getUint32(at + 2);
  const lo = dv.getUint32(at + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

function decodeAiff(b: Uint8Array, maxSeconds?: number): ({ ok: true } & DecodedPcm) | { ok: false; error: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const aifc = ascii(b, 8, 4) === 'AIFC';
  let at = 12;
  let comm: { channels: number; frames: number; bits: number; rate: number; kind: 'int' | 'float' | null; little: boolean } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = dv.getUint32(at + 4);
    const body = at + 8;
    if (id === 'COMM' && body + 18 <= b.length) {
      let kind: 'int' | 'float' | null = 'int';
      let little = false;
      if (aifc && body + 22 <= b.length) {
        const c = ascii(b, body + 18, 4);
        if (c === 'sowt') little = true;
        else if (c === 'fl32' || c === 'FL32' || c === 'fl64' || c === 'FL64') kind = 'float';
        else if (c !== 'NONE' && c !== 'twos') kind = null;
      }
      comm = { channels: dv.getUint16(body), frames: dv.getUint32(body + 2), bits: dv.getUint16(body + 6), rate: extended(dv, body + 8), kind, little };
    } else if (id === 'SSND') {
      if (!comm) return { ok: false, error: 'an AIFF without a COMM chunk before its sound' };
      const offset = dv.getUint32(body);
      const start = body + 8 + offset;
      const bytes = Math.min(b.length - start, comm.frames * comm.channels * Math.ceil(comm.bits / 8));
      return pcm(dv, start, bytes, comm.channels, comm.rate, comm.bits, comm.kind, comm.little, maxSeconds);
    }
    at = body + size + (size & 1);
  }
  return { ok: false, error: 'an AIFF without sound data' };
}

/** Interleaved PCM samples into channels of floats -1..1. */
function pcm(dv: DataView, at: number, bytes: number, channels: number, rate: number, bits: number, kind: 'int' | 'float' | null, little: boolean, maxSeconds?: number): ({ ok: true } & DecodedPcm) | { ok: false; error: string } {
  if (!kind) return { ok: false, error: 'a compressed WAV or AIFF (only PCM and float are read)' };
  if (!channels || !rate || rate < 4000 || rate > 384000) return { ok: false, error: 'a WAV or AIFF with a bad format' };
  const width = Math.ceil(bits / 8);
  if (kind === 'int' ? width < 1 || width > 4 : width !== 4 && width !== 8) return { ok: false, error: `${bits}-bit ${kind} samples are not read` };
  let frames = Math.floor(bytes / (width * channels));
  if (maxSeconds !== undefined) frames = Math.min(frames, Math.ceil(maxSeconds * rate));
  const keep = Math.min(2, channels);
  const out = Array.from({ length: keep }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < keep; c++) {
      const o = at + (i * channels + c) * width;
      let v: number;
      if (kind === 'float') v = width === 4 ? dv.getFloat32(o, little) : dv.getFloat64(o, little);
      else if (width === 1) v = little ? (dv.getUint8(o) - 128) / 128 : dv.getInt8(o) / 128; // 8-bit WAV is unsigned, AIFF signed
      else if (width === 2) v = dv.getInt16(o, little) / 32768;
      else if (width === 3) {
        const b0 = dv.getUint8(o);
        const b1 = dv.getUint8(o + 1);
        const b2 = dv.getUint8(o + 2);
        const u = little ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        v = (u & 0x800000 ? u - 0x1000000 : u) / 8388608;
      } else v = dv.getInt32(o, little) / 2147483648;
      out[c]![i] = v;
    }
  }
  return { ok: true, sampleRate: rate, channels: out };
}

// ─── resampling ─────────────────────────────────────────────────────────────

const HALF = 24; // kernel half-width in output-rate samples (scaled up when going down in rate)
const PHASES = 256;

/** I0, for the Kaiser window. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/**
 * Resamples to `to` Hz with a Kaiser-windowed sinc (beta 8.6, about 90 dB down, the pass band to 94 % of the
 * lower Nyquist): plenty for samples that are pitched and mastered after.
 */
export function resample(x: Float32Array, from: number, to = SAMPLE_RATE): Float32Array {
  if (from === to || x.length === 0) return x.slice();
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.94; // of the input Nyquist
  const half = Math.ceil(HALF / Math.min(1, ratio));
  const n = Math.max(1, Math.round(x.length * ratio));
  const out = new Float32Array(n);
  const beta = 8.6;
  const i0b = bessel0(beta);
  // The kernel sampled at PHASES points per input sample, over [-half, half].
  const table = new Float64Array(2 * half * PHASES + 2);
  for (let k = 0; k < table.length; k++) {
    const t = k / PHASES - half;
    const r = t / half;
    const w = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0b;
    const s = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
    table[k] = s * w * cutoff;
  }
  for (let j = 0; j < n; j++) {
    const pos = j / ratio;
    const i0 = Math.floor(pos);
    let s = 0;
    for (let i = i0 - half + 1; i <= i0 + half; i++) {
      if (i < 0 || i >= x.length) continue;
      const t = (i - pos + half) * PHASES;
      const k = Math.floor(t);
      const f = t - k;
      s += x[i]! * (table[k]! + (table[k + 1]! - table[k]!) * f);
    }
    out[j] = s;
  }
  return out;
}
