/**
 * Shared constants and helpers of the audio DSP core (no dependencies): the sample rate, dB maths and a
 * small seeded random generator (every render is deterministic for a seed, so takes and tests repeat).
 */

export const SAMPLE_RATE = 44100;
export const TWO_PI = Math.PI * 2;

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const linToDb = (x: number): number => 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Semitones to a frequency ratio. */
export const semis = (n: number): number => Math.pow(2, n / 12);
/** MIDI note number to Hz (A4 = 69 = 440 Hz). */
export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** 32-bit integer hash (lowbias32): neighbouring seeds give unrelated random streams. */
export function hashSeed(seed: number): number {
  let x = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97) >>> 0;
  x ^= x >>> 15;
  return x >>> 0 || 1;
}

/** mulberry32: small, fast, good enough for audio noise and musical dice. */
export class Rng {
  private s: number;
  constructor(seed = 1) {
    this.s = hashSeed(seed);
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in [-1, 1). */
  bipolar(): number {
    return this.next() * 2 - 1;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Integer in [lo, hi] (both included). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  /** Roughly normal (sum of three uniforms), std about 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}
