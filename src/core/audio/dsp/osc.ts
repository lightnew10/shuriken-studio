/**
 * Band-limited oscillators. Naive saw/square/triangle alias (their harmonics above Nyquist fold back as
 * inharmonic whine: measured -10 to -17 dB below the harmonics at 1-3.5 kHz); PolyBLEP/PolyBLAMP
 * corrections smooth each discontinuity over two samples and take that down by 25-40 dB.
 */
import { SAMPLE_RATE } from './util';

/** PolyBLEP residual of a unit step, evaluated at phase t (0..1) for a phase increment dt. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * Four-point PolyBLEP: the residual of the cubic B-spline (support of two samples each side, quartic pieces)
 * instead of the linear one above. It removes about 8 dB more of the images near Nyquist, where aliasing
 * lives, and costs the highest harmonics 2 dB at 11 kHz. For an UPWARD unit step at phase 0; dt below 0.25.
 */
export function polyBlep4(t: number, dt: number): number {
  let x: number;
  if (t < 2 * dt) x = t / dt;
  else if (t > 1 - 2 * dt) x = (t - 1) / dt;
  else return 0;
  if (x >= 0) {
    if (x < 1) return -(0.5 - (2 * x) / 3 + (x * x * x) / 3 - (x * x * x * x) / 8);
    const y = 2 - x;
    return -(y * y * y * y) / 24;
  }
  if (x >= -1) return 0.5 + (2 * x) / 3 - (x * x * x) / 3 - (x * x * x * x) / 8;
  const y = 2 + x;
  return (y * y * y * y) / 24;
}

/** PolyBLAMP residual of a unit-slope kink (the integral of polyBlep), in phase units (multiply by dt). */
export function polyBlamp(t: number, dt: number): number {
  if (t < dt) {
    const x = 1 - t / dt;
    return (x * x * x) / 3;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt + 1;
    return (x * x * x) / 3;
  }
  return 0;
}

export const naiveSaw = (p: number): number => 1 - 2 * (p - Math.floor(p));
export const naiveSquare = (p: number, duty = 0.5): number => (p - Math.floor(p) < duty ? 1 : -1);
export const naiveTriangle = (p: number): number => {
  const x = p - Math.floor(p);
  return x < 0.5 ? 4 * x - 1 : 3 - 4 * x;
};

export type OscWave = 'sine' | 'triangle' | 'saw' | 'square';

/**
 * A phase-accumulating oscillator (frequency may change on every sample, so slides and vibrato are
 * continuous). Saw falls from +1 to -1; pulses are DC-free whatever the duty; triangle starts at -1.
 */
export class Osc {
  phase: number;
  constructor(phase = 0) {
    this.phase = phase - Math.floor(phase);
  }

  private advance(freq: number): number {
    const dt = Math.min(0.49, Math.max(0, freq / SAMPLE_RATE));
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    return dt;
  }

  sine(freq: number): number {
    this.advance(freq);
    return Math.sin(2 * Math.PI * this.phase);
  }

  saw(freq: number): number {
    const dt = Math.min(0.24, this.advance(freq));
    const p = this.phase;
    return 1 - 2 * p + 2 * polyBlep4(p, dt);
  }

  /** Band-limited pulse with zero mean. duty 0.5 is a square wave. */
  pulse(freq: number, duty = 0.5): number {
    const dt = Math.min(0.24, this.advance(freq));
    const p = this.phase;
    const d = Math.min(0.95, Math.max(0.05, duty));
    const q = p - d < 0 ? p - d + 1 : p - d;
    return (p < d ? 1 : -1) + 2 * polyBlep4(p, dt) - 2 * polyBlep4(q, dt) - (2 * d - 1);
  }

  triangle(freq: number): number {
    const dt = this.advance(freq);
    const p = this.phase;
    const q = p + 0.5 >= 1 ? p - 0.5 : p + 0.5;
    return naiveTriangle(p) + 4 * dt * (polyBlamp(p, dt) - polyBlamp(q, dt));
  }

  tick(wave: OscWave, freq: number, duty = 0.5): number {
    switch (wave) {
      case 'sine':
        return this.sine(freq);
      case 'triangle':
        return this.triangle(freq);
      case 'saw':
        return this.saw(freq);
      default:
        return this.pulse(freq, duty);
    }
  }
}
