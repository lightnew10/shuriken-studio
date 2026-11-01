/**
 * Effects: a gentle saturator (antiderivative anti-aliased tanh, so driving it does not fold harmonics
 * back as whine), a feed-forward compressor with a soft knee and log-domain ballistics, and a stereo
 * delay as a send (ping-pong optional, filtered feedback).
 */
import { SAMPLE_RATE, dbToLin, linToDb } from './util';
import { Biquad } from './filter';

// ─── saturation ──────────────────────────────────────────────────────────────

/** ln(cosh(x)), the antiderivative of tanh, without overflow. */
const lncosh = (x: number): number => {
  const a = Math.abs(x);
  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2;
};

/**
 * Soft saturation: tanh(drive * x) / tanh(drive) per sample with first-order antiderivative anti-aliasing.
 * drive about 0.5 is a touch of warmth, 3 is obviously driven, 8 is close to a clipper. Peaks stay near 1.
 */
export class Saturator {
  private xp = 0;
  private fp = 0;
  private readonly norm: number;
  constructor(readonly drive: number) {
    this.drive = Math.max(0.05, drive);
    this.norm = 1 / Math.tanh(this.drive);
  }
  process(x: number): number {
    const d = this.drive;
    const u = x * d;
    const f = lncosh(u);
    const dx = u - this.xp * d;
    const y = Math.abs(dx) < 1e-5 ? Math.tanh((u + this.xp * d) / 2) : (f - this.fp) / dx;
    this.xp = x;
    this.fp = f;
    return y * this.norm;
  }
}

/** Saturates a buffer in place. */
export function saturate(x: Float32Array, drive: number): void {
  const s = new Saturator(drive);
  for (let i = 0; i < x.length; i++) x[i] = s.process(x[i]!);
}

// ─── compressor ──────────────────────────────────────────────────────────────

export interface CompressorOptions {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  /** Soft knee width (dB). Default 6. */
  kneeDb?: number;
  makeupDb?: number;
  /** The signal is a loop: run through twice so the detector state at the start is the one the end leaves. */
  loop?: boolean;
}

/** Feed-forward peak compressor (channels linked), in place. Returns the deepest gain reduction (dB). */
export function compress(chs: Float32Array[], o: CompressorOptions): { maxReductionDb: number } {
  const n = chs[0]!.length;
  const knee = o.kneeDb ?? 6;
  const att = Math.exp(-1 / ((Math.max(0.01, o.attackMs) * SAMPLE_RATE) / 1000));
  const rel = Math.exp(-1 / ((Math.max(0.1, o.releaseMs) * SAMPLE_RATE) / 1000));
  const slope = 1 / Math.max(1, o.ratio) - 1;
  const makeup = dbToLin(o.makeupDb ?? 0);
  const gains = new Float32Array(n);
  let gr = 0; // dB, <= 0
  let deepest = 0;
  for (let pass = 0; pass < (o.loop ? 2 : 1); pass++)
    for (let i = 0; i < n; i++) {
      let level = 0;
      for (const x of chs) level = Math.max(level, Math.abs(x[i]!));
      const over = linToDb(level) - o.thresholdDb;
      let target = 0;
      if (2 * over > knee) target = slope * over;
      else if (2 * over > -knee) target = (slope * (over + knee / 2) ** 2) / (2 * knee);
      const coef = target < gr ? att : rel;
      gr = target + coef * (gr - target);
      if (gr < deepest) deepest = gr;
      gains[i] = dbToLin(gr) * makeup;
    }
  for (const x of chs) for (let i = 0; i < n; i++) x[i]! *= gains[i]!;
  return { maxReductionDb: -deepest };
}

// ─── delay send ──────────────────────────────────────────────────────────────

export interface DelayOptions {
  /** Delay times (seconds) of the left and right taps. */
  timeL: number;
  timeR: number;
  /** 0..0.95 */
  feedback: number;
  /** Feed each side into the other (ping-pong). */
  pingPong?: boolean;
  /** Filters in the feedback path (Hz): repeats get darker and thinner. */
  highCutHz?: number;
  lowCutHz?: number;
  /** The input is a loop: the repeats wrap around (run twice). */
  loop?: boolean;
}

/** Wet-only stereo echo of a stereo (or mono) input. */
export function delayWet(inL: Float32Array, inR: Float32Array | null, o: DelayOptions): [Float32Array, Float32Array] {
  const n = inL.length;
  const dl = Math.max(1, Math.round(o.timeL * SAMPLE_RATE));
  const dr = Math.max(1, Math.round(o.timeR * SAMPLE_RATE));
  const bufL = new Float32Array(dl);
  const bufR = new Float32Array(dr);
  let il = 0;
  let ir = 0;
  const fbL = [Biquad.lowpass(o.highCutHz ?? 6000, 0.707), Biquad.highpass(o.lowCutHz ?? 200, 0.707)];
  const fbR = [Biquad.lowpass(o.highCutHz ?? 6000, 0.707), Biquad.highpass(o.lowCutHz ?? 200, 0.707)];
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const fb = Math.min(0.95, Math.max(0, o.feedback));
  for (let pass = 0; pass < (o.loop ? 2 : 1); pass++)
    for (let i = 0; i < n; i++) {
      const yl = bufL[il]!;
      const yr = bufR[ir]!;
      const xl = inL[i]!;
      const xr = inR ? inR[i]! : xl;
      const sendL = o.pingPong ? yr : yl;
      const sendR = o.pingPong ? yl : yr;
      bufL[il] = xl + fbL[1]!.process(fbL[0]!.process(sendL * fb));
      bufR[ir] = xr + fbR[1]!.process(fbR[0]!.process(sendR * fb));
      il = il + 1 === dl ? 0 : il + 1;
      ir = ir + 1 === dr ? 0 : ir + 1;
      if (pass === (o.loop ? 1 : 0)) {
        outL[i] = yl;
        outR[i] = yr;
      }
    }
  return [outL, outR];
}

// ─── transient shaping ───────────────────────────────────────────────────────

export interface TransientOptions {
  /** The most an attack is raised (dB). 3 is a touch, 6 a clear hit, 9 a crack. Negative softens attacks. */
  attackDb: number;
  /** How much brighter the raised part is: the share of the boost that goes to the band above 3 kHz again (0..1). Default 0.5. */
  snap?: number;
  /** Time constants (ms) of the fast and slow level followers and their common release. Defaults 1 / 22 / 45. */
  fastMs?: number;
  slowMs?: number;
  releaseMs?: number;
}

/**
 * A transient designer: two followers of the signal's energy, one that rises in a millisecond and one that
 * takes 20; while the fast one is ahead (an attack is happening) the signal is raised, by at most attackDb.
 * It works on level differences, not on thresholds, so it finds the front of a sound whatever its volume,
 * and leaves steady noise and decays alone (a 3 dB dead zone covers the fast follower's bias on noise).
 * Channels are linked. In place.
 */
export function shapeTransients(chs: Float32Array[], o: TransientOptions): void {
  const n = chs[0]?.length ?? 0;
  if (!n || !o.attackDb) return;
  const coef = (msTime: number): number => Math.exp(-1 / ((Math.max(0.05, msTime) * SAMPLE_RATE) / 1000));
  const fa = coef(o.fastMs ?? 1);
  const sa = coef(o.slowMs ?? 22);
  const rel = coef(o.releaseMs ?? 45);
  const snap = Math.min(1, Math.max(0, o.snap ?? 0.5));
  let top = 0;
  for (const x of chs) for (let i = 0; i < n; i++) top = Math.max(top, x[i]! * x[i]!);
  if (top === 0) return;
  const floor = top * 1e-6;
  const dead = 3;
  const max = Math.abs(o.attackDb);
  const sign = o.attackDb < 0 ? -1 : 1;
  const highs = snap > 0 && sign > 0 ? chs.map(() => [Biquad.highpass(3000, 0.707), Biquad.highpass(3000, 0.707)]) : null;
  let fast = 0;
  let slow = 0;
  let smooth = 0;
  const sm = coef(0.4);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (const x of chs) e = Math.max(e, x[i]! * x[i]!);
    fast = e > fast ? e + fa * (fast - e) : e + rel * (fast - e);
    slow = e > slow ? e + sa * (slow - e) : e + rel * (slow - e);
    const diff = 10 * Math.log10((fast + floor) / (slow + floor)) - dead;
    const want = diff <= 0 ? 0 : Math.min(max, diff);
    smooth = want + sm * (smooth - want);
    const g = dbToLin(sign * smooth);
    for (let c = 0; c < chs.length; c++) {
      const x = chs[c]!;
      const v = x[i]!;
      let y = v * g;
      if (highs) {
        const h = highs[c]![1]!.process(highs[c]![0]!.process(v));
        y += h * (g - 1) * snap;
      }
      x[i] = y;
    }
  }
}

// ─── peak clipping (the clipper itself is master.clipTruePeaks) ──────────────

/** Soft clipping curve: x below the knee a (0..1), a tanh shoulder above it that never passes 1. */
export const clipCurve = (u: number, a: number): number => {
  const m = Math.abs(u);
  if (m <= a) return u;
  const y = a + (1 - a) * Math.tanh((m - a) / (1 - a));
  return u < 0 ? -y : y;
};

/**
 * For a sound with a crack on top of a thump: the band under `splitHz` is turned down, by at most maxDb and
 * only while the two bands together would pass `threshold`, so the lows make way for the highs. Clipping
 * the full band alone flattens the thump's crest and erases the bright noise riding on it, which is
 * exactly the front edge of a hit. The gain moves over about a millisecond (it follows the bands' levels in
 * half-millisecond blocks), the split adds back to the input exactly where nothing is reduced. Returns the
 * deepest reduction of the low band (dB).
 */
export function clipLows(chs: Float32Array[], threshold: number, maxDb = 3, splitHz = 250): { reductionDb: number } {
  const n = chs[0]?.length ?? 0;
  const least = dbToLin(-Math.max(0, maxDb));
  const block = Math.max(4, Math.round(0.0005 * SAMPLE_RATE));
  const blocks = Math.ceil(n / block);
  const lows = chs.map((x) => {
    const low = Float32Array.from(x);
    Biquad.lowpass(splitHz, 0.707).processBuffer(low);
    Biquad.lowpass(splitHz, 0.707).processBuffer(low);
    return low;
  });
  // Level of each band per block (all channels), then the gain the lows need there.
  const lowTop = new Float32Array(blocks);
  const highTop = new Float32Array(blocks);
  chs.forEach((x, c) => {
    const low = lows[c]!;
    for (let i = 0; i < n; i++) {
      const b = (i / block) | 0;
      const l = Math.abs(low[i]!);
      const h = Math.abs(x[i]! - low[i]!);
      if (l > lowTop[b]!) lowTop[b] = l;
      if (h > highTop[b]!) highTop[b] = h;
    }
  });
  const need = new Float32Array(blocks).fill(1);
  let worst = 1;
  for (let b = 0; b < blocks; b++) {
    let l = 0;
    let h = 0;
    for (let k = Math.max(0, b - 1); k <= Math.min(blocks - 1, b + 1); k++) {
      l = Math.max(l, lowTop[k]!);
      h = Math.max(h, highTop[k]!);
    }
    if (l + h > threshold && l > 1e-9) need[b] = Math.min(1, Math.max(least, (threshold - h) / l));
    if (need[b]! < worst) worst = need[b]!;
  }
  if (worst >= 1) return { reductionDb: 0 };
  for (let c = 0; c < chs.length; c++) {
    const x = chs[c]!;
    const low = lows[c]!;
    for (let i = 0; i < n; i++) {
      // Linear between block centres.
      const pos = i / block - 0.5;
      const b0 = Math.max(0, Math.min(blocks - 1, Math.floor(pos)));
      const b1 = Math.min(blocks - 1, b0 + 1);
      const f = Math.min(1, Math.max(0, pos - b0));
      const g = need[b0]! + (need[b1]! - need[b0]!) * f;
      if (g < 1) x[i] = x[i]! - low[i]! * (1 - g);
    }
  }
  return { reductionDb: -linToDb(worst) };
}

// ─── low-end weight ──────────────────────────────────────────────────────────

/**
 * Weight: the band under about 160 Hz is saturated and added back (harmonics at two and three times its
 * pitch, which small speakers can play and which read as size), together with a little of the octave below
 * the body (a half-rate tracker on the low band's zero crossings, low-passed). amount 0..1. Peak-relative,
 * channels processed alike. In place.
 */
export function addWeight(chs: Float32Array[], amount: number): void {
  const k = Math.min(1, Math.max(0, amount));
  if (!k) return;
  let peak = 0;
  for (const x of chs) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  if (peak === 0) return;
  for (const x of chs) {
    const lp = [Biquad.lowpass(160, 0.707), Biquad.lowpass(160, 0.707)];
    const subLp = [Biquad.lowpass(90, 0.707), Biquad.lowpass(90, 0.707)];
    const tidy = Biquad.highpass(28, 0.707);
    const sat = new Saturator(1.5 + 3 * k);
    let flip = 1;
    let prev = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i]! / peak;
      const lowBand = lp[1]!.process(lp[0]!.process(v));
      // Octave below: a square at half the low band's frequency, scaled by the band's own level.
      if (prev <= 0 && lowBand > 0) flip = -flip;
      prev = lowBand;
      const sub = subLp[1]!.process(subLp[0]!.process(flip * Math.abs(lowBand)));
      const driven = sat.process(lowBand * 1.6) - lowBand;
      x[i] = (v + tidy.process(k * 0.9 * driven + k * 0.5 * sub)) * peak;
    }
  }
}
