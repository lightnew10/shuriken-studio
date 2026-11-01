/**
 * Struck things. A metal plate, a bar, a bell, a pipe or a plank is a set of resonances (modes) that an
 * impact excites all at once: their frequency ratios say what the object IS (a free bar: 1, 2.76, 5.4, 8.9;
 * a plate: a dense, irregular cluster; a pipe: nearly harmonic), their decays say what it is MADE OF (metal
 * rings, wood thuds, and in every material the high modes die first), and their levels say how hard and
 * where it was hit. Three hand-written modes sound like a toy bell; a dozen or two from a material sound
 * like the object. materialModes() builds that list for the modal voice.
 */
import { Rng } from './util';

export const MATERIALS = ['plate', 'bar', 'bell', 'pipe', 'wood', 'glass', 'membrane'] as const;
export type Material = (typeof MATERIALS)[number];

/** [frequency ratio, gain, decay scale (1 = the voice's decay)], as the modal voice takes them. */
export type Mode = [number, number, number];

export interface MaterialOptions {
  /** How many modes (4..32). Default 14. */
  count?: number;
  /** 0 (a soft mallet: only the low modes) .. 1 (steel on steel: all of them). Default 0.6. */
  hardness?: number;
  /** 0 (rings like a bell) .. 1 (dead). Default: the material's own. */
  damping?: number;
  /** Which object it is: its small detunings and which of its modes are weak (the same seed is the same object). */
  seed?: number;
  /** -1..1: where this hit lands on it, a little off the object's usual spot (takes of one sound differ in this). */
  strike?: number;
}

/** Ratios of a free-free bar (Euler-Bernoulli): (2k+1)^2 over the first, with the exact first three. */
const barRatios = (count: number): number[] => {
  const betas = [4.730041, 7.853205, 10.995608, 14.137165];
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const b = k < betas.length ? betas[k]! : ((2 * k + 3) * Math.PI) / 2;
    out.push((b * b) / (betas[0]! * betas[0]!));
  }
  return out;
};

/** Ratios of a rectangular plate (aspect 1.37): m^2 + (n * aspect)^2, sorted, lowest = 1. */
const plateRatios = (count: number, aspect = 1.37): number[] => {
  const all: number[] = [];
  for (let m = 1; m <= 9; m++) for (let n = 1; n <= 9; n++) all.push(m * m + n * aspect * n * aspect);
  all.sort((a, b) => a - b);
  return all.slice(0, count).map((v) => v / all[0]!);
};

/** Partials of a church bell against its prime (hum, prime, tierce, quint, nominal and the upper ones). */
const BELL = [0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011, 4.166, 5.433, 6.796, 8.215, 9.71, 11.3, 12.9, 14.6];
/** Modes of an ideal circular membrane (Bessel zeros) against the fundamental. */
const MEMBRANE = [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501, 3.6, 3.652, 4.06, 4.154, 4.601, 4.832, 4.903, 5.132];

const DAMPING: Record<Material, number> = { plate: 0.3, bar: 0.25, bell: 0.08, pipe: 0.3, wood: 0.85, glass: 0.15, membrane: 0.7 };

export function materialModes(material: Material, o: MaterialOptions = {}): Mode[] {
  const count = Math.round(Math.min(32, Math.max(4, o.count ?? 14)));
  const hard = Math.min(1, Math.max(0, o.hardness ?? 0.6));
  const damp = Math.min(1, Math.max(0, o.damping ?? DAMPING[material]));
  const rand = new Rng((o.seed ?? 1) * 7919 + 101);
  let ratios: number[];
  switch (material) {
    case 'bar':
    case 'wood':
      ratios = barRatios(count);
      break;
    case 'plate':
      ratios = plateRatios(count);
      break;
    case 'glass':
      ratios = plateRatios(count, 1.12);
      break;
    case 'bell':
      ratios = BELL.slice(0, count);
      break;
    case 'membrane':
      ratios = MEMBRANE.slice(0, count);
      break;
    default:
      // A tube: nearly harmonic, stretched a little (stiffness), plus the shell's own high ring.
      ratios = Array.from({ length: count }, (_, k) => (k + 1) * (1 + 0.004 * k * k));
  }
  // Where it is struck: a comb over the modes, so some are strong and some nearly missing.
  const pos = 0.18 + 0.2 * rand.next() + 0.025 * Math.min(1, Math.max(-1, o.strike ?? 0));
  // A soft hit excites less and less of the high modes; a hard one keeps them.
  const tilt = 2.2 - 1.9 * hard;
  return ratios.map((ratio, k): Mode => {
    const strike = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * (k + 1) * pos));
    const gain = (strike * (0.85 + 0.3 * rand.next())) / Math.pow(ratio, tilt * 0.5);
    // High modes die first: the decay falls with frequency, faster in damped materials.
    const decay = 1 / (1 + (0.25 + 3.5 * damp) * Math.pow(Math.max(0, ratio - 1), 0.7));
    const detune = 1 + (rand.next() * 2 - 1) * (material === 'pipe' ? 0.001 : 0.004);
    return [Math.round(ratio * detune * 1e4) / 1e4, Math.round(gain * 1e3) / 1e3, Math.round(decay * 1e3) / 1e3];
  });
}
