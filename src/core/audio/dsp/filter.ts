/**
 * Filters. The old synth only had one-pole filters (6 dB/octave, no resonance): sounds were dull, there
 * were no sweeps with a voice to them. These are a resonant state-variable filter that stays stable under
 * fast cutoff modulation, RBJ biquads for EQ, and a one-pole for cheap smoothing.
 */
import { SAMPLE_RATE, dbToLin } from './util';

/**
 * Cytomic (Andrew Simper) trapezoidal state-variable filter. Call set() when the cutoff moves (it may be
 * every sample), then process(): lp, bp and hp hold the three outputs. q 0.5..20 (0.707 is flat).
 */
export class Svf {
  lp = 0;
  bp = 0;
  hp = 0;
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1.414;

  constructor(cutoff = 1000, q = 0.707) {
    this.set(cutoff, q);
  }

  set(cutoff: number, q = 0.707): void {
    const fc = Math.min(SAMPLE_RATE * 0.49, Math.max(10, cutoff));
    const g = Math.tan((Math.PI * fc) / SAMPLE_RATE);
    this.k = 1 / Math.min(40, Math.max(0.3, q));
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** One sample in; returns the low-pass output (lp, bp, hp are updated too). */
  process(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }

  /** Band-pass with unity gain at the centre (bp itself has gain Q there). */
  get bandpass(): number {
    return this.k * this.bp;
  }
  get notch(): number {
    return this.lp + this.hp;
  }
  reset(): void {
    this.ic1 = this.ic2 = this.lp = this.bp = this.hp = 0;
  }
}

/** RBJ cookbook biquad (transposed direct form II). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private setCoefs(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  private static w(fc: number): { cos: number; sin: number } {
    const w0 = (2 * Math.PI * Math.min(SAMPLE_RATE * 0.49, Math.max(10, fc))) / SAMPLE_RATE;
    return { cos: Math.cos(w0), sin: Math.sin(w0) };
  }

  static lowpass(fc: number, q = 0.707): Biquad {
    const { cos, sin } = Biquad.w(fc);
    const al = sin / (2 * q);
    return new Biquad().setCoefs((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + al, -2 * cos, 1 - al);
  }
  static highpass(fc: number, q = 0.707): Biquad {
    const { cos, sin } = Biquad.w(fc);
    const al = sin / (2 * q);
    return new Biquad().setCoefs((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + al, -2 * cos, 1 - al);
  }
  static bandpass(fc: number, q = 1): Biquad {
    const { cos, sin } = Biquad.w(fc);
    const al = sin / (2 * q);
    return new Biquad().setCoefs(al, 0, -al, 1 + al, -2 * cos, 1 - al);
  }
  static notch(fc: number, q = 1): Biquad {
    const { cos, sin } = Biquad.w(fc);
    const al = sin / (2 * q);
    return new Biquad().setCoefs(1, -2 * cos, 1, 1 + al, -2 * cos, 1 - al);
  }
  static peaking(fc: number, q: number, gainDb: number): Biquad {
    const A = Math.pow(10, gainDb / 40);
    const { cos, sin } = Biquad.w(fc);
    const al = sin / (2 * q);
    return new Biquad().setCoefs(1 + al * A, -2 * cos, 1 - al * A, 1 + al / A, -2 * cos, 1 - al / A);
  }
  static lowShelf(fc: number, gainDb: number, q = 0.707): Biquad {
    const A = Math.pow(10, gainDb / 40);
    const { cos, sin } = Biquad.w(fc);
    const s = 2 * Math.sqrt(A) * (sin / (2 * q));
    return new Biquad().setCoefs(A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s), A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s);
  }
  static highShelf(fc: number, gainDb: number, q = 0.707): Biquad {
    const A = Math.pow(10, gainDb / 40);
    const { cos, sin } = Biquad.w(fc);
    const s = 2 * Math.sqrt(A) * (sin / (2 * q));
    return new Biquad().setCoefs(A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s), A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Filters a buffer in place. */
  processBuffer(buf: Float32Array): void {
    for (let i = 0; i < buf.length; i++) buf[i] = this.process(buf[i]!);
  }

  reset(): void {
    this.z1 = this.z2 = 0;
  }
}

/** One-pole low-pass / high-pass (6 dB/octave): smoothing, DC blocking, cheap tone. */
export class OnePole {
  private a: number;
  private y = 0;
  private xp = 0;
  constructor(cutoffHz: number) {
    this.a = Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE);
  }
  lp(x: number): number {
    this.y = x + this.a * (this.y - x);
    return this.y;
  }
  hp(x: number): number {
    this.y = this.a * (this.y + x - this.xp);
    this.xp = x;
    return this.y;
  }
}

/** Biquad EQ chain applied in place to a channel (cascade of the given filters). */
export function applyEq(x: Float32Array, filters: Biquad[]): void {
  for (const f of filters) f.processBuffer(x);
}

/** Gain from dB, for readability next to EQ settings. */
export const gainDb = dbToLin;
