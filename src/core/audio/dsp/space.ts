/**
 * Places for sound effects. A dry synthesized hit sounds like it happened in a padded box; what tells the ear
 * "a hangar" or "outdoors" is the first few reflections (when they arrive, from where, how dull) and the way
 * the tail dies. Each space here is a set of early reflections (delayed, filtered, panned copies) feeding a
 * feedback delay network: eight delay lines mixed through a Householder matrix (every line feeds all the
 * others, so the echo density builds within a few dozen milliseconds, unlike parallel combs which flutter),
 * each line losing its highs faster than its lows, as air and walls do.
 *
 * It is a send: spaceWet() returns only the wet left and right (decorrelated, for stereo sounds; sum them for
 * mono), the caller mixes it under the dry sound.
 */
import { SAMPLE_RATE } from './util';
import { Biquad, OnePole } from './filter';

export const SPACES = ['room', 'hall', 'hangar', 'outdoor', 'tunnel', 'cave'] as const;
export type SpaceName = (typeof SPACES)[number];

interface SpaceModel {
  /** Early reflections: [delay ms, gain, pan -1..1, low-pass Hz]. */
  taps: Array<[number, number, number, number]>;
  /** Seconds for the tail to fall 60 dB at low and at high frequencies. */
  rt60: number;
  rt60High: number;
  /** Scale of the delay lines (1 = 23-53 ms lines, a large room). */
  size: number;
  /** Level of the diffuse tail against the early reflections. */
  tail: number;
  /** Milliseconds before the tail starts. */
  preDelayMs: number;
  /** The send is filtered to this band. */
  lowCutHz: number;
  highCutHz: number;
  what: string;
}

/** The spaces by name. Tuned by measurement (echo density, decay per band), to be tuned by ear in Studio. */
export const SPACE_MODELS: Record<SpaceName, SpaceModel> = {
  room: {
    taps: [[7, 0.7, -0.5, 9000], [11, 0.6, 0.6, 8000], [17, 0.5, -0.2, 6500], [23, 0.4, 0.4, 5500], [31, 0.3, -0.7, 4500]],
    rt60: 0.35, rt60High: 0.18, size: 0.32, tail: 0.8, preDelayMs: 4, lowCutHz: 200, highCutHz: 9000,
    what: 'a small hard room: tight reflections in the first 30 ms, a 0.3 s tail (interiors, garages, cockpits)',
  },
  hall: {
    taps: [[14, 0.6, -0.6, 8000], [23, 0.55, 0.5, 7000], [37, 0.45, -0.3, 6000], [52, 0.4, 0.7, 5000], [71, 0.3, -0.8, 4000], [94, 0.25, 0.2, 3500]],
    rt60: 1.3, rt60High: 0.55, size: 0.9, tail: 1, preDelayMs: 18, lowCutHz: 160, highCutHz: 8000,
    what: 'a large hall: reflections out to 90 ms, a smooth 1.3 s tail (arenas, temples, stingers)',
  },
  hangar: {
    taps: [[19, 0.65, 0.6, 7000], [33, 0.6, -0.7, 6500], [58, 0.5, 0.3, 5000], [86, 0.45, -0.4, 4200], [127, 0.35, 0.8, 3200], [171, 0.25, -0.6, 2600]],
    rt60: 2.2, rt60High: 0.7, size: 1.35, tail: 0.9, preDelayMs: 28, lowCutHz: 120, highCutHz: 6500,
    what: 'a huge metal building: distinct slaps up to 170 ms, a long dark 2.2 s tail (warehouses, mech bays, big interiors)',
  },
  outdoor: {
    taps: [[41, 0.5, 0.5, 5000], [97, 0.42, -0.6, 3600], [163, 0.3, 0.3, 2600], [251, 0.22, -0.4, 1900], [347, 0.14, 0.7, 1400]],
    rt60: 1.6, rt60High: 0.35, size: 1.9, tail: 0.45, preDelayMs: 60, lowCutHz: 90, highCutHz: 4500,
    what: 'open ground with buildings or hills around: a slap after 40-100 ms, then echoes rolling away, dark and sparse (gunfire and explosions outside)',
  },
  tunnel: {
    taps: [[9, 0.7, -0.3, 6000], [18, 0.65, 0.3, 5500], [27, 0.6, -0.4, 5000], [36, 0.5, 0.4, 4500], [54, 0.4, -0.2, 3800], [72, 0.3, 0.2, 3200]],
    rt60: 1.1, rt60High: 0.4, size: 0.55, tail: 1, preDelayMs: 8, lowCutHz: 180, highCutHz: 6000,
    what: 'a concrete tube: evenly spaced flutter reflections, a ringing 1.1 s tail (corridors, sewers, pipes)',
  },
  cave: {
    taps: [[23, 0.55, 0.7, 5500], [47, 0.5, -0.6, 4500], [83, 0.45, 0.2, 3800], [131, 0.4, -0.8, 3000], [197, 0.3, 0.5, 2400]],
    rt60: 2.8, rt60High: 0.9, size: 1.6, tail: 1.1, preDelayMs: 35, lowCutHz: 140, highCutHz: 6000,
    what: 'a big stone cavity: late uneven reflections, a 2.8 s tail (caverns, canyons, boss arenas)',
  },
};

/** Seconds of tail a space adds after the dry sound (what the caller makes room for). */
export const spaceTailSeconds = (name: SpaceName, decay = 1): number => {
  const m = SPACE_MODELS[name];
  return Math.min(3.2, m.rt60 * Math.max(0.3, Math.min(2, decay)) * 0.85 + m.taps[m.taps.length - 1]![0] / 1000 + 0.05);
};

/** Mutually prime delay lengths (samples at size 1), about 23 to 53 ms. */
const LINES = [1019, 1171, 1327, 1487, 1663, 1847, 2069, 2333];
const DIFFUSERS = [211, 337, 463];

export interface SpaceOptions {
  /** Scales the decay times (0.3 .. 2). Default 1. */
  decay?: number;
  /** The input is a loop: the tail wraps into the start (the buffers are run through twice). */
  loop?: boolean;
}

/** Wet (space only) left and right for a mono or stereo input of the same length as the outputs. */
export function spaceWet(inL: Float32Array, inR: Float32Array | null, name: SpaceName, o: SpaceOptions = {}): [Float32Array, Float32Array] {
  const m = SPACE_MODELS[name];
  const n = inL.length;
  const decay = Math.max(0.3, Math.min(2, o.decay ?? 1));
  const send = new Float32Array(n);
  for (let i = 0; i < n; i++) send[i] = inR ? (inL[i]! + inR[i]!) * 0.5 : inL[i]!;
  Biquad.highpass(m.lowCutHz, 0.707).processBuffer(send);
  Biquad.lowpass(m.highCutHz, 0.707).processBuffer(send);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const passes = o.loop ? 2 : 1;

  // Early reflections: each tap is a delayed, darker copy on its own side.
  for (const [msDelay, gain, pan, cut] of m.taps) {
    const d = Math.round((msDelay / 1000) * SAMPLE_RATE);
    const lp = new OnePole(cut);
    const gl = gain * Math.sqrt(0.5 * (1 - pan));
    const gr = gain * Math.sqrt(0.5 * (1 + pan));
    for (let pass = 0; pass < passes; pass++)
      for (let i = 0; i < n; i++) {
        const src = i - d;
        const v = lp.lp(src >= 0 ? send[src]! : o.loop && pass === 1 ? send[(((src % n) + n) % n)]! : 0);
        if (pass === passes - 1) {
          outL[i]! += v * gl;
          outR[i]! += v * gr;
        }
      }
  }

  // The tail: allpass diffusion, then eight lines through a Householder mix.
  const N = LINES.length;
  const len = LINES.map((l) => Math.max(16, Math.round(l * m.size)));
  const buf = len.map((l) => new Float32Array(l));
  const idx = len.map(() => 0);
  // Per line: gain for the low decay time, and a one-pole whose loss makes the highs reach -60 dB in rt60High.
  const gLow = len.map((l) => Math.pow(10, (-3 * l) / (m.rt60 * decay * SAMPLE_RATE)));
  const gHigh = len.map((l) => Math.pow(10, (-3 * l) / (m.rt60High * decay * SAMPLE_RATE)));
  const dampA = gHigh.map((gh, k) => Math.min(0.95, Math.max(0, 1 - gh / gLow[k]!)) * 0.9);
  const dampS = len.map(() => 0);
  const apLen = DIFFUSERS.map((l) => Math.max(8, Math.round(l * Math.min(1, m.size))));
  const apBuf = apLen.map((l) => new Float32Array(l));
  const apIdx = apLen.map(() => 0);
  const pre = Math.round((m.preDelayMs / 1000) * SAMPLE_RATE);
  const preBuf = new Float32Array(Math.max(1, pre));
  let preIdx = 0;
  const read = new Float64Array(N);
  // Output taps: two sign patterns that are orthogonal, so left and right are decorrelated.
  const sl = [1, -1, 1, -1, 1, -1, 1, -1];
  const sr = [1, 1, -1, -1, 1, 1, -1, -1];
  const norm = m.tail / Math.sqrt(N);
  for (let pass = 0; pass < passes; pass++)
    for (let i = 0; i < n; i++) {
      let x = send[i]!;
      if (pre > 0) {
        const d = preBuf[preIdx]!;
        preBuf[preIdx] = x;
        preIdx = preIdx + 1 === pre ? 0 : preIdx + 1;
        x = d;
      }
      for (let a = 0; a < apBuf.length; a++) {
        const b = apBuf[a]!;
        const k = apIdx[a]!;
        const delayed = b[k]!;
        const y = delayed - 0.6 * x;
        b[k] = x + 0.6 * y;
        apIdx[a] = k + 1 === b.length ? 0 : k + 1;
        x = y;
      }
      let sum = 0;
      for (let k = 0; k < N; k++) {
        const v = buf[k]![idx[k]!]!;
        read[k] = v;
        sum += v;
      }
      const mix = (2 / N) * sum;
      let l = 0;
      let r = 0;
      for (let k = 0; k < N; k++) {
        const v = read[k]!;
        l += v * sl[k]!;
        r += v * sr[k]!;
        // Householder feedback, then the line's losses.
        const fb = (v - mix) * gLow[k]!;
        dampS[k] = fb + dampA[k]! * (dampS[k]! - fb);
        buf[k]![idx[k]!] = x + dampS[k]!;
        idx[k] = idx[k]! + 1 === len[k]! ? 0 : idx[k]! + 1;
      }
      if (pass === passes - 1) {
        outL[i]! += l * norm;
        outR[i]! += r * norm;
      }
    }
  return [outL, outR];
}

/**
 * Distance: what air does to a sound that is far away, applied to the dry signal in place. The highs go
 * first (a low-pass that falls from 16 kHz when near to about 1.2 kHz at 1) and the front edge softens with
 * them; the lows carry (distant thunder is all rumble). amount 0 (at the listener) .. 1 (hundreds of metres).
 */
export function applyDistance(chs: Float32Array[], amount: number): void {
  const d = Math.min(1, Math.max(0, amount));
  if (!d) return;
  const cut = 16000 * Math.pow(1200 / 16000, d);
  for (const x of chs) {
    Biquad.lowpass(cut, 0.6).processBuffer(x);
    if (d > 0.3) Biquad.lowpass(cut * 1.6, 0.6).processBuffer(x);
  }
}
