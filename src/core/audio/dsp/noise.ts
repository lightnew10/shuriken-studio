/**
 * Noise sources. The old synth only had stepped "sample and hold" noise (one random value per period,
 * a dull staircase with no air above its rate); these are the real colours, all with an RMS of about 0.5.
 */
import { Rng, SAMPLE_RATE } from './util';

export type NoiseColor = 'white' | 'pink' | 'brown';

export class Noise {
  private readonly r: Rng;
  // pink (Paul Kellet's refined filter) and brown state
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  private brownState = 0;
  // crunch (sample and hold)
  private held = 0;
  private holdPhase = 1;

  constructor(seed = 1) {
    this.r = new Rng(seed);
  }

  /** Uniform white noise, RMS 0.5. */
  white(): number {
    return this.r.bipolar() * 0.866;
  }

  /** -3 dB/octave. */
  pink(): number {
    const w = this.r.bipolar();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.28;
  }

  /** -6 dB/octave (leaky integrated white). */
  brown(): number {
    const w = this.r.bipolar();
    this.brownState = (this.brownState + 0.02 * w) / 1.02;
    return this.brownState * 8.6;
  }

  color(c: NoiseColor): number {
    return c === 'white' ? this.white() : c === 'pink' ? this.pink() : this.brown();
  }

  /**
   * The old stepped noise ("crunch"): a new random value every 1/rate seconds, held in between. Gritty,
   * lo-fi and dark; good for 8-bit explosions and retro hits, not for air.
   */
  crunch(rateHz: number): number {
    this.holdPhase += Math.max(1, rateHz) / SAMPLE_RATE;
    if (this.holdPhase >= 1) {
      this.holdPhase -= Math.floor(this.holdPhase);
      this.held = this.r.bipolar();
    }
    return this.held * 0.7;
  }

  /** A uniform random number, for callers that share this noise source's stream. */
  next(): number {
    return this.r.next();
  }
}
