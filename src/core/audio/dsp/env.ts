/**
 * Envelopes in closed form (a function of time, so notes and effect voices need no state): an
 * exponential ADSR (decays and releases fall like real sounds do, linear ones sound artificial and
 * leave a long inaudible tail) and breakpoint / sweep helpers for filter and pitch moves.
 */

/** ln(1/0.0025): an exponential reaches about -52 dB at its nominal time. */
export const DECAY_K = 6;

/**
 * ADSR: linear attack a, exponential decay d down to the sustain level s, held until `gate` seconds, then
 * an exponential release r (about -52 dB at r, ending at exactly zero). Times in seconds, s 0..1.
 */
export function adsr(t: number, gate: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  const att = Math.max(a, 0.0004);
  const level = (u: number): number => (u < att ? u / att : s + (1 - s) * Math.exp((-DECAY_K * (u - att)) / Math.max(d, 1e-4)));
  if (t < gate) return level(t);
  const rel = t - gate;
  const len = Math.max(r, 1e-3);
  if (rel >= len) return 0;
  return level(gate) * Math.exp((-DECAY_K * rel) / len) * (1 - rel / len);
}

/** Exponential interpolation of a positive quantity (a cutoff or a pitch) from v0 at t0 to v1 at t1, clamped outside. */
export function sweep(t: number, t0: number, t1: number, v0: number, v1: number): number {
  if (t <= t0) return v0;
  if (t >= t1) return v1;
  return v0 * Math.pow(v1 / v0, (t - t0) / (t1 - t0));
}

export type Breakpoint = readonly [time: number, value: number];

/** Piecewise-linear value through breakpoints (times ascending); exp interpolates positive values in the log domain. */
export function breakpoints(points: readonly Breakpoint[], t: number, exp = false): number {
  const first = points[0];
  if (!first || t <= first[0]) return first ? first[1] : 0;
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]!;
    if (t <= t1) {
      const [t0, v0] = points[i - 1]!;
      const x = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return exp && v0 > 0 && v1 > 0 ? v0 * Math.pow(v1 / v0, x) : v0 + (v1 - v0) * x;
    }
  }
  return points[points.length - 1]![1];
}
