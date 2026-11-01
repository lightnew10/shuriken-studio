/**
 * Mastering for generated game audio: everything a render goes through before it is encoded.
 *
 *  - DC removal (zero-phase high-pass, so no thump and no lost headroom)
 *  - a loudness meter (ITU-R BS.1770-4: K-weighting, 400 ms blocks, absolute and relative gates)
 *  - per-category loudness targets (LOUDNESS_TARGETS, the one place the mix is decided)
 *  - a lookahead true-peak limiter (4x oversampled detection, ceiling -1.5 dBTP) instead of peak
 *    normalisation / soft clipping; struck one-shots get a peak clipper in front of it (clipDb), so the
 *    limiter's release does not duck the body behind a transient
 *  - short fades so one-shots start and end without clicks
 *  - checkAudio(): the gate every tool result carries (peak, loudness, DC, start silence, loop seam)
 *  - the MP3 loop region (the encoder delay a loop has to skip)
 *
 * Offline and non-causal on purpose: a render sees the whole sound, so the limiter can look ahead
 * exactly and loops can be processed circularly (their seam stays seamless).
 */
import { SAMPLE_RATE, dbToLin, linToDb } from './util';
import { clipCurve, clipLows } from './fx';

// ─── The mix: loudness targets ────────────────────────────────────────────────

export type AudioCategory = 'music' | 'ambience' | 'impact' | 'pickup' | 'ui' | 'footstep' | 'movement' | 'stinger';
export const AUDIO_CATEGORIES: readonly AudioCategory[] = ['music', 'ambience', 'impact', 'pickup', 'ui', 'footstep', 'movement', 'stinger'];

export interface LoudnessTarget {
  /** LUFS the asset is mastered to. */
  lufs: number;
  /** integrated = the whole asset (loops); momentary = its loudest 400 ms (one-shots). */
  measure: 'integrated' | 'momentary';
  /**
   * The most the limiter may pull the peaks down (dB) to reach the target. A very short or very peaky
   * sound that would need more stays quieter than the target and says so in its check.
   */
  maxLimiterDb: number;
  /** What it is for (shown to agents). */
  use: string;
}

/**
 * One place for the mix. Measured with measureLoudness(): K-weighted, a mono file counts as one channel
 * (like ffmpeg and pyloudnorm). Roblox Sound.Volume and the SoundGroups then only trim the balance:
 * a game sound plays at its category's level times its Volume.
 * To retune the whole game's balance, change these numbers (tune by ear in Studio).
 */
export const LOUDNESS_TARGETS: Record<AudioCategory, LoudnessTarget> = {
  music: { lufs: -16, measure: 'integrated', maxLimiterDb: 4, use: 'music loops' },
  ambience: { lufs: -24, measure: 'integrated', maxLimiterDb: 3, use: 'ambience beds under everything' },
  impact: { lufs: -12, measure: 'momentary', maxLimiterDb: 6, use: 'hits, explosions, slams, weapon fire: the loudest thing players cause' },
  pickup: { lufs: -16, measure: 'momentary', maxLimiterDb: 6, use: 'coins, pickups, power-ups, checkpoints' },
  ui: { lufs: -20, measure: 'momentary', maxLimiterDb: 6, use: 'clicks, hovers, errors, confirmations' },
  footstep: { lufs: -22, measure: 'momentary', maxLimiterDb: 6, use: 'footsteps and other constant small sounds' },
  movement: { lufs: -18, measure: 'momentary', maxLimiterDb: 6, use: 'swings, whooshes, jumps, splashes' },
  stinger: { lufs: -14, measure: 'momentary', maxLimiterDb: 6, use: 'level-up and victory fanfares, discoveries' },
};

/** True-peak ceiling of every export. The MP3 encoder adds a little on top, hence not -1.0. */
export const TRUE_PEAK_CEILING_DB = -1.5;

export const isAudioCategory = (s: unknown): s is AudioCategory => typeof s === 'string' && (AUDIO_CATEGORIES as readonly string[]).includes(s);

// ─── BS.1770-4 loudness ───────────────────────────────────────────────────────

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages of BS.1770-4, derived for any sample rate from the analog prototype (the
 * way libebur128 does it: at 48 kHz this gives the standard's coefficients exactly, at 44.1 kHz the same
 * response). A 997 Hz sine of -23 dBFS peak in both channels reads -23.0 LUFS.
 */
function kFilters(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / rate);
  const vh = Math.pow(10, gain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / rate);
  const d = 1 + k / q + k * k;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / d, a2: (1 - k / q + k * k) / d };
  return [shelf, highpass];
}

/** Prefix sums (length n+1) of the K-weighted squares summed over channels. */
function kPower(chs: Float32Array[], rate: number): Float64Array {
  const n = chs[0]!.length;
  const sq = new Float64Array(n + 1);
  const [s1, s2] = kFilters(rate);
  for (const x of chs) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < n; i++) {
      const xi = x[i]!;
      const y = s1.b0 * xi + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      const z = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * v1 - s2.a2 * v2;
      u2 = u1;
      u1 = y;
      v2 = v1;
      v1 = z;
      sq[i + 1] = sq[i + 1]! + z * z;
    }
  }
  for (let i = 0; i < n; i++) sq[i + 1] = sq[i + 1]! + sq[i]!;
  return sq;
}

const lufsOf = (meanSquare: number): number => -0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-20));

export interface Loudness {
  /** Integrated loudness with the -70 LUFS and -10 LU gates (null when everything is gated out). */
  integrated: number | null;
  /** Loudest 400 ms block (a sound shorter than 400 ms is padded with silence, as the BS.1770 meters do). */
  momentaryMax: number;
}

export function measureLoudness(chs: Float32Array[], rate = SAMPLE_RATE): Loudness {
  const n = chs[0]?.length ?? 0;
  if (!n) return { integrated: null, momentaryMax: -Infinity };
  const P = kPower(chs, rate);
  const win = Math.round(0.4 * rate);
  const hop = Math.round(0.1 * rate);
  const z: number[] = [];
  if (n < win) z.push(P[n]! / win);
  else for (let s = 0; s + win <= n; s += hop) z.push((P[s + win]! - P[s]!) / win);
  let momentaryMax = -Infinity;
  for (const v of z) momentaryMax = Math.max(momentaryMax, lufsOf(v));
  const abs = z.filter((v) => lufsOf(v) > -70);
  if (!abs.length) return { integrated: null, momentaryMax };
  const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((v) => lufsOf(v) > rel);
  return { integrated: gated.length ? lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length) : null, momentaryMax };
}

// ─── True peak (8x oversampled windowed-sinc, like scipy.signal.resample_poly) ─

/**
 * BS.1770 measures with 4x oversampling, which can read up to 0.7 dB under the real peak of bright
 * signals. Detection here is 8x with a long Kaiser kernel (within 0.15 dB of ideal reconstruction for
 * content up to 19 kHz; mastering low-passes at 16.5 kHz first, as the MP3 encoder would anyway), so a
 * ceiling of -1.5 holds for a 4x meter (analysis scripts) and an independent reconstruction alike.
 */
const TP_FACTOR = 8;
const TP_HALF = 24; // kernel half-length in input samples
const TP_TAPS = 2 * TP_HALF;
/** Interpolation taps of the in-between points after a sample, phase p = 1..F-1, ordered for ascending sample index i - (HALF-1) + j. */
const TP_PHASES: Float64Array[] = (() => {
  const F = TP_FACTOR;
  const half = TP_HALF * F;
  const bessel0 = (x: number): number => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 60; k++) {
      term *= (x / (2 * k)) * (x / (2 * k));
      sum += term;
    }
    return sum;
  };
  const beta = 8;
  const N = 2 * half + 1;
  const g = new Float64Array(N);
  let total = 0;
  for (let k = 0; k < N; k++) {
    const m = k - half;
    const sinc = m === 0 ? 1 : Math.sin((Math.PI * m) / F) / ((Math.PI * m) / F);
    const r = (2 * k) / (N - 1) - 1;
    g[k] = sinc * (bessel0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / bessel0(beta));
    total += g[k]!;
  }
  for (let k = 0; k < N; k++) g[k] = (g[k]! * F) / total;
  const out: Float64Array[] = [];
  for (let p = 1; p < F; p++) {
    // y(i + p/F) = sum over d = -HALF..HALF-1 of x[i - d] * g[F*d + p]
    const t = new Float64Array(TP_TAPS);
    for (let d = -TP_HALF; d < TP_HALF; d++) t[TP_TAPS - 1 - (d + TP_HALF)] = g[F * d + p + half]!;
    out.push(t);
  }
  return out;
})();

/**
 * Per sample: the largest |value| of the sample and the oversampled points after it (all channels).
 * Samples whose four neighbours are all below `floor` are not interpolated (their value stands in): pass
 * the amplitude under which a peak cannot matter (the limiter: half its ceiling); by default 30 % of the
 * loudest sample, which is enough to find the maximum.
 */
export function truePeakEnvelope(chs: Float32Array[], loop = false, floor?: number): Float32Array {
  const n = chs[0]!.length;
  const env = new Float32Array(n);
  const K = TP_HALF + 1;
  const phases = TP_PHASES;
  if (floor === undefined) {
    let top = 0;
    for (const x of chs) for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(x[i]!));
    floor = top * 0.3;
  }
  for (const x of chs) {
    const xe = new Float32Array(n + 2 * K + 1);
    for (let i = 0; i < n; i++) xe[K + i] = x[i]!;
    if (loop) {
      for (let k = 0; k < K; k++) xe[k] = x[(n - K + k + n * K) % n]!;
      for (let k = 0; k < K + 1; k++) xe[K + n + k] = x[k % n]!;
    }
    for (let i = 0; i < n; i++) {
      let m = Math.abs(x[i]!);
      const near = Math.max(m, Math.abs(xe[K + i - 1]!), Math.abs(xe[K + i + 1]!), Math.abs(xe[K + i + 2]!));
      if (near >= floor) {
        const b = K + i - (TP_HALF - 1);
        for (let p = 0; p < phases.length; p++) {
          const t = phases[p]!;
          let a = 0;
          for (let j = 0; j < TP_TAPS; j++) a += xe[b + j]! * t[j]!;
          if (a < 0) a = -a;
          if (a > m) m = a;
        }
      }
      if (m > env[i]!) env[i] = m;
    }
  }
  return env;
}

export function truePeakDb(chs: Float32Array[], loop = false): number {
  let m = 0;
  for (const v of truePeakEnvelope(chs, loop)) if (v > m) m = v;
  return linToDb(m);
}

export function samplePeakDb(chs: Float32Array[]): number {
  let m = 0;
  for (const x of chs) for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return linToDb(m);
}

// ─── DC removal and fades ─────────────────────────────────────────────────────

/**
 * Removes DC and sub-sonic drift: a one-pole high-pass run forwards and backwards (zero phase, so the
 * sound does not shift and the attack keeps its shape), then the little mean a short sound's own low
 * frequencies leave (a slow Hann-shaped correction: inaudible, no click). Loops are processed circularly.
 */
export function removeDc(chs: Float32Array[], loop = false, cutoffHz = 12): void {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE);
  for (const x of chs) {
    const n = x.length;
    if (!n) continue;
    const pad = loop ? Math.min(n, Math.ceil(8 / (1 - a))) : 0;
    const m = n + 2 * pad;
    const buf = new Float64Array(m);
    for (let i = 0; i < m; i++) buf[i] = x[(((i - pad) % n) + n) % n]!;
    const pass = (dir: 1 | -1): void => {
      let xp = buf[dir === 1 ? 0 : m - 1]!;
      let yp = 0;
      for (let k = 0; k < m; k++) {
        const i = dir === 1 ? k : m - 1 - k;
        const v = buf[i]!;
        yp = a * (yp + v - xp);
        xp = v;
        buf[i] = yp;
      }
    };
    pass(1);
    pass(-1);
    for (let i = 0; i < n; i++) x[i] = buf[i + pad]!;
    trimMean(x, loop);
  }
}

/** Takes the remaining mean out: a constant for loops, a Hann-shaped bump (no click at the ends) for one-shots. */
function trimMean(x: Float32Array, loop = false): void {
  const n = x.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i]!;
  const mean = sum / (n || 1);
  if (loop) for (let i = 0; i < n; i++) x[i]! -= mean;
  else for (let i = 0; i < n; i++) x[i]! -= 2 * mean * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
}

/**
 * 8th-order Butterworth low-pass run forwards and backwards (zero phase), circular for loops. The MP3
 * encoder throws away what is above about 16 kHz anyway; doing it here keeps the peaks the limiter sees
 * the peaks that survive, and spares the encoder the overshoot of cutting a transient's edge.
 */
export function lowpassZeroPhase(chs: Float32Array[], cutoffHz = 16500, loop = false): void {
  const qs = [0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055];
  const w0 = (2 * Math.PI * cutoffHz) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const sections = qs.map((q) => {
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
  });
  for (const x of chs) {
    const n = x.length;
    if (!n) continue;
    const pad = loop ? Math.min(n, 2048) : 0;
    const m = n + 2 * pad;
    const buf = new Float64Array(m);
    for (let i = 0; i < m; i++) buf[i] = x[(((i - pad) % n) + n) % n]!;
    for (let dir = 0; dir < 2; dir++)
      for (const c of sections) {
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let k = 0; k < m; k++) {
          const i = dir === 0 ? k : m - 1 - k;
          const v = buf[i]!;
          const y = c.b0 * v + c.b1 * x1 + c.b0 * x2 - c.a1 * y1 - c.a2 * y2;
          x2 = x1;
          x1 = v;
          y2 = y1;
          y1 = y;
          buf[i] = y;
        }
      }
    for (let i = 0; i < n; i++) x[i] = buf[i + pad]!;
  }
}

/** Raised-cosine fades at the ends of a one-shot (samples). */
export function fadeEnds(x: Float32Array, inSamples: number, outSamples: number): void {
  const n = x.length;
  const fi = Math.min(inSamples, n >> 1);
  const fo = Math.min(outSamples, n >> 1);
  for (let k = 0; k < fi; k++) x[k]! *= 0.5 - 0.5 * Math.cos((Math.PI * k) / fi);
  for (let k = 0; k < fo; k++) x[n - 1 - k]! *= 0.5 - 0.5 * Math.cos((Math.PI * k) / fo);
}

// ─── True-peak limiter ────────────────────────────────────────────────────────

export interface LimiterOptions {
  /** Default TRUE_PEAK_CEILING_DB. */
  ceilingDb?: number;
  /** Lookahead (ms): the gain reaches its value 2x this ahead of a peak. Default 1. */
  lookaheadMs?: number;
  /** Release time constant (ms). Default 60. */
  releaseMs?: number;
  /** Process circularly (a looped asset). */
  loop?: boolean;
}

function slidingMin(src: Float32Array, half: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + half);
    while (next <= hi) {
      while (tail > head && src[dq[tail - 1]!]! >= src[next]!) tail--;
      dq[tail++] = next++;
    }
    const lo = i - half;
    while (dq[head]! < lo) head++;
    out[i] = src[dq[head]!]!;
  }
  return out;
}

/**
 * The limiter's gain curve for a true-peak envelope scaled by preGain: the gain that keeps every
 * (oversampled) peak at or below the ceiling. min-filter + box smoothing give a lookahead ramp that
 * provably reaches the needed gain at the peak; an exponential release lets it back up.
 */
function limiterGain(env: Float32Array, preGain: number, o: Required<Omit<LimiterOptions, 'ceilingDb'>> & { ceiling: number }): { gain: Float32Array; minGain: number } {
  const n = env.length;
  const H = Math.max(2, Math.round((o.lookaheadMs * SAMPLE_RATE) / 1000));
  const ext = 2 * H + 2;
  const m = n + 2 * ext;
  const need = new Float32Array(m).fill(1);
  for (let i = 0; i < m; i++) {
    const src = o.loop ? (((i - ext) % n) + n) % n : i - ext;
    if (src < 0 || src >= n) continue;
    const p = env[src]! * preGain;
    need[i] = p > o.ceiling ? o.ceiling / p : 1;
  }
  const mins = slidingMin(need, H);
  // Box smoothing over +-(H-1): every term already includes the needed gain at the centre.
  const hs = H - 1;
  const pre = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) pre[i + 1] = pre[i]! + mins[i]!;
  const smooth = (i: number): number => {
    const lo = Math.max(0, i - hs);
    const hi = Math.min(m - 1, i + hs);
    return (pre[hi + 1]! - pre[lo]!) / (hi - lo + 1);
  };
  const rel = Math.exp(-1 / ((o.releaseMs * SAMPLE_RATE) / 1000));
  const gain = new Float32Array(n);
  let r = 1;
  let minGain = 1;
  // A loop is run twice so the release state at its start is the one its end leaves.
  for (let pass = 0; pass < (o.loop ? 2 : 1); pass++)
    for (let i = 0; i < n; i++) {
      const s = smooth(i + ext);
      const relaxed = 1 - (1 - r) * rel;
      r = s < relaxed ? s : relaxed;
      gain[i] = r;
      if (r < minGain) minGain = r;
    }
  return { gain, minGain };
}

const limiterDefaults = (o: LimiterOptions) => ({ ceiling: dbToLin(o.ceilingDb ?? TRUE_PEAK_CEILING_DB), lookaheadMs: o.lookaheadMs ?? 1, releaseMs: o.releaseMs ?? 60, loop: !!o.loop });

/** Brick-wall true-peak limiter, in place. Returns the deepest gain reduction (dB, positive). */
export function limit(chs: Float32Array[], opts: LimiterOptions = {}): { reductionDb: number } {
  if (!chs[0]?.length) return { reductionDb: 0 };
  const o = limiterDefaults(opts);
  const { gain, minGain } = limiterGain(truePeakEnvelope(chs, o.loop, 0.5 * o.ceiling), 1, o);
  for (const x of chs) for (let i = 0; i < x.length; i++) x[i]! *= gain[i]!;
  return { reductionDb: 0 - linToDb(minGain) };
}

// ─── Peak clipper ─────────────────────────────────────────────────────────────

/**
 * Clips what is above `threshold` (linear) and leaves everything under the knee exactly as it was. Unlike the
 * limiter it has no release: a sample is turned down only as far as its own peak asks, so the body right
 * behind a transient keeps its level (the hole a limiter's release leaves is what takes the punch out of
 * short hits). It works on the true-peak envelope (the peaks between samples count), so what it leaves for
 * the limiter is a fraction of a dB. knee 0..1: where the shoulder starts (0.8 = 2 dB under the threshold).
 * Returns the deepest reduction (dB).
 */
export function clipTruePeaks(chs: Float32Array[], threshold: number, knee = 0.8): { reductionDb: number } {
  const n = chs[0]?.length ?? 0;
  if (!n) return { reductionDb: 0 };
  const a = Math.min(0.98, Math.max(0.2, knee));
  const env = truePeakEnvelope(chs, false, a * threshold * 0.9);
  let worst = 1;
  let before = 1;
  for (let i = 0; i < n; i++) {
    const u = env[i]! / threshold;
    const g = u > a ? clipCurve(u, a) / u : 1;
    // env[i] covers the points between this sample and the next: both of its neighbours are turned down.
    const use = g < before ? g : before;
    before = g;
    if (use < 1) {
      if (use < worst) worst = use;
      for (const x of chs) x[i]! *= use;
    }
  }
  return { reductionDb: 0 - linToDb(worst) };
}

// ─── Mastering to a loudness target ───────────────────────────────────────────

export interface MasterOptions {
  category: AudioCategory;
  /** A looped asset: circular processing, no end fade. */
  loop?: boolean;
  /** Override the category's target (LUFS) or measure. */
  targetLufs?: number;
  measure?: 'integrated' | 'momentary';
  ceilingDb?: number;
  /** Release of the limiter (ms); default 40 for one-shots, 120 for loops. */
  releaseMs?: number;
  /** Fade lengths (ms) of a one-shot. */
  fadeInMs?: number;
  fadeOutMs?: number;
  /**
   * One-shots: the peaks may be clipped by up to this many dB on the way to the loudness target, before the
   * limiter (fx.clipLows, then clipTruePeaks: the lows give the highs 3 dB of room first, so the crack on top of a
   * thump survives; what is still over the ceiling is clipped). For struck sounds (impacts, footsteps): a clipped
   * front keeps its edge and the body right behind it keeps its level, where a limiter pulls everything down for
   * its release time. Not for pitched sounds (a clipped tone buzzes). Default 0: the limiter alone.
   */
  clipDb?: number;
}

export interface MasterReport {
  category: AudioCategory;
  targetLufs: number;
  measure: 'integrated' | 'momentary';
  /** Loudness reached (same measure as the target). */
  loudness: number | null;
  /** Gain applied before limiting (dB). */
  gainDb: number;
  /** Deepest limiter gain reduction (dB). */
  limiterDb: number;
  /** Deepest reduction by the peak clipper (dB; 0 when it is off or was not needed). */
  clipDb: number;
  /** Whether the target was reached (within 0.5 LU). A sound too short/peaky for it ends up lower. */
  reached: boolean;
  silent: boolean;
}

/**
 * Masters channels in place: removes DC, fades one-shot ends, scales to the category's loudness and
 * limits true peaks to the ceiling (the loudness is measured after limiting, so the target holds).
 */
export function master(chs: Float32Array[], opts: MasterOptions): MasterReport {
  const cat = LOUDNESS_TARGETS[opts.category];
  const target = opts.targetLufs ?? cat.lufs;
  const measure = opts.measure ?? cat.measure;
  const loop = !!opts.loop;
  const lim = limiterDefaults({ ceilingDb: opts.ceilingDb, loop, lookaheadMs: loop ? 2 : 1, releaseMs: opts.releaseMs ?? (loop ? 120 : 40) });
  const report: MasterReport = { category: opts.category, targetLufs: target, measure, loudness: null, gainDb: 0, limiterDb: 0, clipDb: 0, reached: false, silent: false };

  removeDc(chs, loop);
  lowpassZeroPhase(chs, 16500, loop);
  if (!loop) for (const x of chs) fadeEnds(x, Math.round(((opts.fadeInMs ?? 0.5) * SAMPLE_RATE) / 1000), Math.round(((opts.fadeOutMs ?? 10) * SAMPLE_RATE) / 1000));
  const pick = (l: Loudness): number => (measure === 'integrated' ? (l.integrated ?? l.momentaryMax) : l.momentaryMax);
  const l0 = pick(measureLoudness(chs));
  if (!Number.isFinite(l0) || l0 < -100) {
    report.silent = true;
    return report;
  }
  const base = chs.map((c) => Float32Array.from(c));
  const n = base[0]!.length;
  const maxLimiter = cat.maxLimiterDb;
  // Peaks more than (the limiter cap + 6 dB) under the loudest cannot reach the ceiling at any gain we accept.
  let top = 0;
  for (const x of base) for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(x[i]!));
  const env = truePeakEnvelope(base, loop, 0.5 * top * dbToLin(-maxLimiter));
  // Find the gain whose limited result reads the target: undershoot/overshoot bracketing, a few passes.
  let gainDb = target - l0;
  let lo: { g: number; l: number; gr: number } | null = null; // highest gain that is still under the target (and within the limiter cap)
  let hi: number | null = null; // lowest gain known to be over the target or over the cap
  let best: { g: number; l: number; gr: number; clip: number } | null = null;
  const clipMax = loop ? 0 : Math.max(0, opts.clipDb ?? 0);
  // The clipper's threshold sits a little under the ceiling: what it leaves between samples is the limiter's.
  const clipAt = lim.ceiling * dbToLin(-0.3);
  for (let pass = 0; pass < 10; pass++) {
    const lin = dbToLin(gainDb);
    let gr: number;
    let clipped = 0;
    let out: Float32Array[];
    if (clipMax > 0 && top * lin > clipAt * 0.7) {
      // Clip the scaled sound, then let the limiter take what is left over the ceiling between samples.
      out = base.map((x) => {
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = x[i]! * lin;
        return y;
      });
      // The lows give the highs up to 3 dB of room first (the crack on a thump survives), then what is still over is clipped.
      clipLows(out, clipAt, Math.min(3, clipMax));
      clipped = clipTruePeaks(out, clipAt, 0.8).reductionDb;
      const { gain, minGain } = limiterGain(truePeakEnvelope(out, false, 0.5 * lim.ceiling), 1, lim);
      gr = 0 - linToDb(minGain);
      for (const y of out) for (let i = 0; i < n; i++) y[i]! *= gain[i]!;
    } else {
      const { gain, minGain } = limiterGain(env, lin, lim);
      gr = 0 - linToDb(minGain);
      out = base.map((x) => {
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = x[i]! * lin * gain[i]!;
        return y;
      });
    }
    const l = pick(measureLoudness(out));
    const over = gr > maxLimiter + 0.05 || clipped > clipMax + 0.05;
    if (!over && (!best || Math.abs(l - target) < Math.abs(best.l - target))) {
      best = { g: gainDb, l, gr, clip: clipped };
      for (let c = 0; c < chs.length; c++) chs[c]!.set(out[c]!);
    }
    if (!over && Math.abs(l - target) <= 0.1) break;
    if (!over && l < target) lo = { g: gainDb, l, gr };
    else hi = hi === null ? gainDb : Math.min(hi, gainDb);
    if (lo && hi !== null) {
      if (hi - lo.g < 0.05) break;
      gainDb = (lo.g + hi) / 2;
    } else if (lo) gainDb = lo.g + Math.max(0.2, target - lo.l);
    else gainDb = (hi ?? gainDb) - (over ? 1 : Math.max(0.2, l - target));
  }
  if (!best) {
    // Even the quietest try needed more limiting than allowed: use the capped gain.
    const { gain } = limiterGain(env, 1, lim);
    for (let c = 0; c < chs.length; c++) for (let i = 0; i < n; i++) chs[c]![i] = base[c]![i]! * gain[i]!;
    best = { g: 0, l: pick(measureLoudness(chs)), gr: 0, clip: 0 };
  }
  if (!loop) {
    // The limiter's gain moved the mean a little: trim it again, then hold the ceiling with a constant gain (<0.1 dB).
    for (const x of chs) trimMean(x);
    let peak = 0;
    for (const v of truePeakEnvelope(chs)) if (v > peak) peak = v;
    const ceiling = dbToLin(opts.ceilingDb ?? TRUE_PEAK_CEILING_DB);
    if (peak > ceiling) for (const x of chs) for (let i = 0; i < x.length; i++) x[i]! *= ceiling / peak;
  }
  report.gainDb = best.g;
  report.limiterDb = best.gr;
  report.clipDb = best.clip;
  report.loudness = pick(measureLoudness(chs));
  report.reached = Math.abs(report.loudness - target) <= 0.5;
  return report;
}

// ─── The gate: checkAudio ─────────────────────────────────────────────────────

export interface AudioCheck {
  ok: boolean;
  /** One line for tool results: "ok: -12.0 LUFS-M (target -12), -1.6 dBTP, DC 0.000, starts at 0 ms". */
  summary: string;
  issues: string[];
  durationSec: number;
  peakDb: number;
  truePeakDb: number;
  /** Integrated LUFS (null when silent) and the loudest 400 ms. */
  lufsI: number | null;
  lufsM: number;
  dc: number;
  /** Milliseconds until the sound rises above -60 dBFS. */
  leadSilenceMs: number;
  /** Level of the last millisecond against the peak (dB): a one-shot that was not faded out ends near 0 and clicks. */
  endDb: number;
  /** Loops only: the jump from the last sample to the first against the sound's own sample-to-sample steps. */
  seam?: { jump: number; ratio: number };
  target?: { category: AudioCategory; lufs: number; measure: 'integrated' | 'momentary'; deltaLu: number | null };
  stereo?: { correlation: number; sideMidDb: number };
}

export interface CheckOptions {
  category?: AudioCategory;
  loop?: boolean;
  /** Loops with an intro: the sample the loop starts at (the seam is the end running into this sample). */
  loopStart?: number;
  targetLufs?: number;
  measure?: 'integrated' | 'momentary';
}

export function checkAudio(chs: Float32Array[], opts: CheckOptions = {}): AudioCheck {
  const n = chs[0]?.length ?? 0;
  const loop = !!opts.loop;
  const peakDb = samplePeakDb(chs);
  const tpDb = n ? truePeakDb(chs) : -Infinity;
  const l = measureLoudness(chs);
  const mono = new Float32Array(n);
  for (const x of chs) for (let i = 0; i < n; i++) mono[i]! += x[i]! / chs.length;
  let dc = 0;
  for (let i = 0; i < n; i++) dc += mono[i]!;
  dc = n ? dc / n : 0;
  const thr = dbToLin(-60);
  let first = -1;
  for (let i = 0; i < n; i++)
    if (Math.abs(mono[i]!) > thr) {
      first = i;
      break;
    }
  const lead = first < 0 ? (n / SAMPLE_RATE) * 1000 : (first / SAMPLE_RATE) * 1000;
  const w = Math.min(n, Math.round(0.001 * SAMPLE_RATE));
  let tailSq = 0;
  let pk = 0;
  for (let i = n - w; i < n; i++) tailSq += mono[i]! * mono[i]!;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(mono[i]!));
  const endDb = w && pk > 0 ? linToDb(Math.sqrt(tailSq / w)) - linToDb(pk) : 0;

  const check: AudioCheck = {
    ok: true,
    summary: '',
    issues: [],
    durationSec: n / SAMPLE_RATE,
    peakDb: round(peakDb, 2),
    truePeakDb: round(tpDb, 2),
    lufsI: l.integrated === null ? null : round(l.integrated, 2),
    lufsM: round(l.momentaryMax, 2),
    dc: Math.round(dc * 1e5) / 1e5,
    leadSilenceMs: round(lead, 1),
    endDb: round(endDb, 1),
  };
  if (chs.length === 2 && n) {
    let ll = 0, rr = 0, lr = 0, mm = 0, ss = 0;
    const [L, R] = chs as [Float32Array, Float32Array];
    for (let i = 0; i < n; i++) {
      const a = L[i]!, b = R[i]!;
      ll += a * a;
      rr += b * b;
      lr += a * b;
      mm += ((a + b) / 2) ** 2;
      ss += ((a - b) / 2) ** 2;
    }
    check.stereo = { correlation: round(lr / Math.sqrt(Math.max(ll * rr, 1e-20)), 3), sideMidDb: round(10 * Math.log10(Math.max(ss, 1e-20) / Math.max(mm, 1e-20)), 1) };
  }
  if (loop && n > 8) {
    // The step across the seam against the sound's own steps (99.9th percentile of |x[i+1]-x[i]|).
    let jump = 0;
    const steps: number[] = [];
    const stride = Math.max(1, Math.floor(n / 150000));
    const from = Math.max(0, Math.min(n - 2, opts.loopStart ?? 0));
    for (const x of chs) {
      jump = Math.max(jump, Math.abs(x[from]! - x[n - 1]!));
      for (let i = from; i + 1 < n; i += stride) steps.push(Math.abs(x[i + 1]! - x[i]!));
    }
    steps.sort((a, b) => a - b);
    const p999 = steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.999))]!;
    check.seam = { jump: round(jump, 5), ratio: round(jump / Math.max(p999, 1e-9), 2) };
  }

  const issues = check.issues;
  if (!n || pk === 0 || !Number.isFinite(l.momentaryMax) || l.momentaryMax < -70) issues.push('silent');
  if (tpDb > -1) issues.push(`true peak ${check.truePeakDb} dBTP is over -1 dBTP (it would clip after MP3 encoding)`);
  if (Math.abs(dc) > 0.003) issues.push(`DC offset ${check.dc}`);
  if (!loop && lead > 30 && pk > 0) issues.push(`starts ${check.leadSilenceMs} ms late`);
  if (!loop && endDb > -35) issues.push(`ends abruptly (${check.endDb} dB in the last millisecond): it can click`);
  if (check.seam && check.seam.ratio > 2.5) issues.push(`loop seam jumps (${check.seam.ratio}x the usual step)`);
  if (opts.category || opts.targetLufs !== undefined) {
    const cat = opts.category ? LOUDNESS_TARGETS[opts.category] : null;
    const target = opts.targetLufs ?? cat!.lufs;
    const measure = opts.measure ?? cat?.measure ?? (loop ? 'integrated' : 'momentary');
    const got = measure === 'integrated' ? (l.integrated ?? l.momentaryMax) : l.momentaryMax;
    const delta = Number.isFinite(got) ? round(got - target, 2) : null;
    check.target = { category: opts.category ?? 'pickup', lufs: target, measure, deltaLu: delta };
    if (delta !== null && Math.abs(delta) > 1.5 && !issues.includes('silent')) issues.push(delta < 0 ? `${-delta} LU quieter than its ${target} LUFS target (too short or peaky to get there without heavy limiting)` : `${delta} LU louder than its ${target} LUFS target`);
  }
  check.ok = issues.length === 0;
  const unit = check.target ? (check.target.measure === 'integrated' ? 'LUFS-I' : 'LUFS-M') : loop ? 'LUFS-I' : 'LUFS-M';
  const level = unit === 'LUFS-I' ? (check.lufsI ?? check.lufsM) : check.lufsM;
  const parts = [`${round(level, 1)} ${unit}${check.target ? ` (target ${check.target.lufs})` : ''}`, `${round(check.truePeakDb, 1)} dBTP`, `DC ${round(check.dc, 4)}`, loop && check.seam ? `loop seam ${check.seam.ratio}x` : `starts at ${round(check.leadSilenceMs, 0)} ms`];
  if (check.stereo) parts.push(`stereo corr ${check.stereo.correlation}, side/mid ${check.stereo.sideMidDb} dB`);
  check.summary = `${check.ok ? 'ok' : 'check'}: ${parts.join(', ')}${issues.length ? `; ${issues.join('; ')}` : ''}`;
  return check;
}

const round = (x: number, d: number): number => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

// ─── MP3 loops ────────────────────────────────────────────────────────────────

/**
 * lamejs writes no gapless (LAME/Xing) tag, so a decoder plays the encoder's priming samples before the
 * audio (measured with ffmpeg: 1105 samples = 25.1 ms at 44.1 kHz, plus 1152-2061 samples of padding at
 * the end). Without a loop region a looped MP3 breaks 50-70 ms at every wrap.
 */
export const MP3_ENCODER_DELAY = 1105;

export interface LoopRegion {
  /** Seconds into the decoded MP3 where the audio starts (skips the encoder delay). */
  start: number;
  /** Seconds the audio lasts (its exact length: the padding after it is skipped too). */
  length: number;
}

/**
 * Roblox Sound.LoopRegion for a looped MP3: `frames` samples of loop after `introFrames` that play once (NEEDS A
 * STUDIO CHECK, see audioBuilder).
 */
export function mp3LoopRegion(frames: number, rate = SAMPLE_RATE, introFrames = 0): LoopRegion {
  return { start: Math.round(((MP3_ENCODER_DELAY + introFrames) / rate) * 1e6) / 1e6, length: Math.round((frames / rate) * 1e6) / 1e6 };
}
