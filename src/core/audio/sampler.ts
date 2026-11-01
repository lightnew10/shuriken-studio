/**
 * The sampler: how a note of a sample track sounds. A one-shot plays from its start, pitched by the note
 * against the sample's root (by reading it faster or slower, with cubic interpolation), and is cut by the
 * note's length plus a release when the track gates it. A loop is fitted to the song: stretched in time to the
 * song's tempo without changing its pitch (WSOLA), moved to the song's key when it has one, and played from any
 * beat of it for as long as the note lasts, wrapping round. A texture is made seamless once (its end crossfaded
 * into its start) and played the same way at its own speed. Results are cached per sample and setting.
 */
import { SAMPLE_RATE } from './dsp/util';
import type { SampleKind } from './sample-analysis';

const SR = SAMPLE_RATE;

/** A sample ready to play: 44.1 kHz, peak-normalised, with what the analysis found. */
export interface LoadedSample {
  id: string;
  kind: SampleKind;
  role: string;
  channels: Float32Array[];
  /** The note (MIDI, fractional) the sample sounds at its own speed: melodic one-shots. */
  root?: number;
  /** Loops: tempo and length in beats. */
  bpm?: number;
  beats?: number;
  /** Loops in a key: the tonic's MIDI note, to move the loop into the song's key. */
  keyTonic?: number;
  /** Loudness the composer matches it by (LUFS: momentary max for one-shots, integrated for beds). */
  lufs: number;
}

/** Where a song's samples come from (the sample library, or a test's map). */
export interface SampleBank {
  get(id: string): LoadedSample | null;
}

export interface SamplerNote {
  /** Semitones to move the sample by (0 = as it is). */
  semis: number;
  /** The note's length in seconds. */
  seconds: number;
  /** Cut the sample at the note's end (plus release); a drum hit rings out instead. */
  gate: boolean;
  release: number;
  reverse: boolean;
  /** One-shots: seconds into the sample to start from. */
  startSec: number;
  /** Loops and textures: where in the bed the note starts, in the song's beats. */
  offsetBeats: number;
  songBpm: number;
  /** One-shots: the note slides to this many semitones over the last `slide` share of its length (an 808's glide). */
  glideTo?: number;
  slide?: number;
}

const cache = new Map<string, Float32Array[]>();
const remember = (key: string, make: () => Float32Array[]): Float32Array[] => {
  let v = cache.get(key);
  if (!v) {
    if (cache.size > 64) cache.clear();
    v = make();
    cache.set(key, v);
  }
  return v;
};

/** Four-point Hermite interpolation of x at a fractional position (zero outside). */
function hermite(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const xm1 = x[i - 1] ?? 0;
  const x0 = x[i] ?? 0;
  const x1 = x[i + 1] ?? 0;
  const x2 = x[i + 2] ?? 0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/** Reads `chs` at `rate` (2 = an octave up) into `length` samples, wrapping round when `wrap`. */
function readAt(chs: Float32Array[], start: number, rate: number, length: number, wrap: boolean): Float32Array[] {
  const n = chs[0]!.length;
  return chs.map((ch) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let p = start + i * rate;
      if (wrap) p = ((p % n) + n) % n;
      else if (p >= n) break;
      if (wrap && p > n - 3) {
        // Across the seam: interpolate between the end and the start.
        const k = Math.floor(p);
        const t = p - k;
        out[i] = ch[k]! * (1 - t) + ch[(k + 1) % n]! * t;
      } else out[i] = hermite(ch, p);
    }
    return out;
  });
}

/**
 * WSOLA time-stretch (Verhelst and Roelands 1993): 46 ms Hann frames overlapped by half, each taken from near
 * where the stretched time says, at the offset (within ±6 ms) that best continues the previous frame, so the
 * waveform carries on without phasiness. `factor` > 1 makes it longer. A loop is stretched as three copies
 * and the middle one kept, so its seam is as smooth as the rest.
 */
export function timeStretch(chs: Float32Array[], factor: number, loop = false): Float32Array[] {
  const len = chs[0]!.length;
  const tile = (c: Float32Array) => {
    const t = new Float32Array(len * 3);
    for (let k = 0; k < 3; k++) t.set(c, k * len);
    return t;
  };
  const src = loop ? chs.map(tile) : chs;
  const n = src[0]!.length;
  const N = 2048;
  const H = N / 2;
  const tol = 256;
  const L = 512;
  const mono = new Float32Array(n);
  for (const c of src) for (let i = 0; i < n; i++) mono[i]! += c[i]! / src.length;
  const outLen = Math.round(n * factor);
  const out = src.map(() => new Float32Array(outLen + N));
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let prev = 0;
  for (let k = 0; k * H < outLen; k++) {
    const nominal = Math.round((k * H) / factor);
    let pos = Math.min(Math.max(0, nominal), Math.max(0, n - 1));
    if (k > 0) {
      const target = prev + H;
      const score = (cand: number, step: number) => {
        let s = 0;
        for (let j = 0; j < L; j += step) s += (mono[target + j] ?? 0) * (mono[cand + j] ?? 0);
        return s;
      };
      // Coarse (every 4th sample and offset), then the best offset refined at full resolution.
      let best = pos;
      let bestS = -Infinity;
      for (let d = -tol; d <= tol; d += 4) {
        const c = nominal + d;
        if (c < 0 || c >= n) continue;
        const s = score(c, 4);
        if (s > bestS) {
          bestS = s;
          best = c;
        }
      }
      let fineS = -Infinity;
      for (let d = -3; d <= 3; d++) {
        const c = best + d;
        if (c < 0 || c >= n) continue;
        const s = score(c, 1);
        if (s > fineS) {
          fineS = s;
          pos = c;
        }
      }
    }
    const o = k * H;
    src.forEach((c, ci) => {
      const dst = out[ci]!;
      for (let j = 0; j < N; j++) {
        const v = c[pos + j];
        if (v === undefined) break;
        dst[o + j]! += v * win[j]!;
      }
    });
    prev = pos;
  }
  if (!loop) return out.map((o) => o.slice(0, outLen));
  const one = Math.round(len * factor);
  return out.map((o) => o.slice(one, 2 * one));
}

/** A bed whose end is crossfaded (equal power, up to half a second) into its start: it loops without a seam. */
export function seamless(chs: Float32Array[]): Float32Array[] {
  const n = chs[0]!.length;
  const X = Math.min(Math.round(0.5 * SR), n >> 2);
  if (X < 64) return chs;
  return chs.map((c) => {
    const out = c.slice(0, n - X);
    for (let i = 0; i < X; i++) {
      const t = (i + 0.5) / X;
      out[i] = c[i]! * Math.sin((Math.PI / 2) * t) + c[n - X + i]! * Math.cos((Math.PI / 2) * t);
    }
    return out;
  });
}

/** The loop as the song hears it: at the song's tempo and moved by `semis`, exactly beats × beat-length long. */
function fittedLoop(s: LoadedSample, songBpm: number, semis: number): Float32Array[] {
  const beats = s.beats ?? 4;
  const target = Math.round((beats * 60 * SR) / songBpm);
  return remember(`loop|${s.id}|${songBpm}|${semis}`, () => {
    const n = s.channels[0]!.length;
    const pitch = Math.pow(2, semis / 12);
    const timeRatio = target / n;
    // Close enough in tempo and no transposition: read it a little faster or slower (the pitch moves by under a semitone).
    if (semis === 0 && Math.abs(timeRatio - 1) <= 0.05) return readAt(s.channels, 0, n / target, target, true);
    const stretched = timeStretch(s.channels, timeRatio * pitch, true);
    return readAt(stretched, 0, stretched[0]!.length / target, target, true);
  });
}

/** One note of a sample track, before its level, pan and the track's filters. */
export function renderSamplerNote(s: LoadedSample, o: SamplerNote): { L: Float32Array; R: Float32Array } {
  const stereo = (chs: Float32Array[]) => ({ L: chs[0]!, R: chs[1] ?? chs[0]!.slice() });
  const fade = (chs: Float32Array[], inSamples: number, outSamples: number) => {
    for (const ch of chs) {
      for (let i = 0; i < inSamples && i < ch.length; i++) ch[i]! *= i / inSamples;
      for (let i = 0; i < outSamples && i < ch.length; i++) ch[ch.length - 1 - i]! *= i / outSamples;
    }
    return chs;
  };
  const seconds = Math.max(0.005, o.seconds);
  if (s.kind === 'loop' || s.kind === 'texture') {
    const bed = s.kind === 'loop' ? fittedLoop(s, o.songBpm, o.semis) : remember(`bed|${s.id}`, () => seamless(s.channels));
    const n = bed[0]!.length;
    const rate = s.kind === 'texture' ? Math.pow(2, o.semis / 12) : 1;
    const startSamples = o.offsetBeats * (60 / o.songBpm) * SR * rate;
    const length = Math.round((seconds + (o.gate ? o.release : 0)) * SR);
    const chs = readAt(o.reverse ? bed.map((c) => c.slice().reverse()) : bed, ((startSamples % n) + n) % n, rate, length, true);
    return stereo(fade(chs, Math.round(0.003 * SR), Math.round(Math.max(0.004, o.release) * SR)));
  }
  const src = o.reverse ? remember(`rev|${s.id}`, () => s.channels.map((c) => c.slice().reverse())) : s.channels;
  const rate = Math.pow(2, o.semis / 12);
  const start = Math.max(0, Math.round(o.startSec * SR));
  const available = Math.max(0, Math.floor((src[0]!.length - start) / rate));
  const held = Math.round(seconds * SR);
  const release = Math.round(Math.max(0.004, o.release) * SR);
  const length = Math.max(1, o.gate ? Math.min(available, held + release) : available);
  let chs: Float32Array[];
  if (o.glideTo !== undefined && o.glideTo !== o.semis) {
    // The read speed moves from the note to the glide's target (smoothstep) over the end of the note.
    const hold = held * (1 - Math.max(0.05, Math.min(1, o.slide ?? 0.5)));
    const span = Math.max(1, held - hold);
    const n = src[0]!.length;
    chs = src.map(() => new Float32Array(length));
    let pos = start;
    for (let i = 0; i < length && pos < n - 1; i++) {
      for (let c = 0; c < src.length; c++) chs[c]![i] = hermite(src[c]!, pos);
      const u = Math.min(1, Math.max(0, (i - hold) / span));
      pos += Math.pow(2, (o.semis + (o.glideTo - o.semis) * u * u * (3 - 2 * u)) / 12);
    }
  } else chs = readAt(src, start, rate, length, false);
  if (o.gate && held < length)
    for (const ch of chs) for (let i = held; i < length; i++) ch[i]! *= Math.max(0, 1 - (i - held) / release);
  return stereo(fade(chs, start > 0 ? Math.round(0.002 * SR) : 0, Math.min(Math.round(0.003 * SR), length >> 1)));
}

/** The playback length of a note before rendering it (for the renderer's room after the last beat). */
export function samplerLength(s: LoadedSample, o: SamplerNote): number {
  if (s.kind !== 'oneshot') return Math.round((o.seconds + (o.gate ? o.release : 0)) * SR);
  const rate = Math.pow(2, o.semis / 12);
  const available = Math.floor((s.channels[0]!.length - Math.round(o.startSec * SR)) / rate);
  return Math.max(1, o.gate ? Math.min(available, Math.round((o.seconds + Math.max(0.004, o.release)) * SR)) : available);
}
