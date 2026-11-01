/**
 * The composer: a style, a key, a tempo and a length become a full SongSpec with real musical structure.
 *
 *  - harmony: a progression per section (A, B) from mood tables, chords stacked in the scale (7ths where
 *    the style wants them), VOICE-LED: each chord is the nearest voicing to the one before it
 *  - melody: a motif per section, developed (sequence, inversion, rhythm variation, cadence) instead of one
 *    short loop repeated; strong beats land on chord tones; the last phrase ends open so the loop restarts
 *  - bass: a pattern per style that approaches the next chord's root
 *  - drums: a groove per style and section, ghost notes, a mini fill at the end of every 4th bar, a bigger fill and
 *    a crash at the end of every 8th
 *  - feel: swing, human timing and velocity (tight on a chip, loose in lofi), all written into the spec
 *  - structure: A / B halves; the progression's last bar turns around into the first chord, so the loop is seamless
 * Same seed, same song; another seed, another song.
 */
import { Rng } from './dsp/util';
import { midiOf, pitchName, type Instrument, type NoteEvent, type SongSpec, type Track } from './music';
import { composePhonk } from './compose-phonk';

export type Style = 'lofi' | 'chiptune' | 'epic' | 'ambient' | 'action' | 'japanese' | 'tropical' | 'spooky' | 'phonk';
export const STYLES: readonly Style[] = ['lofi', 'chiptune', 'epic', 'ambient', 'action', 'japanese', 'tropical', 'spooky', 'phonk'];

const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  japanese: [0, 1, 5, 7, 8], // in scale (miyako-bushi)
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// ─── style table ─────────────────────────────────────────────────────────────

type ChordPattern = 'sustain' | 'comp' | 'offbeat' | 'arp16' | 'arp8' | 'swell' | 'none';
type BassPattern = 'lofi' | 'pulse' | 'sustain' | 'drone' | 'tumbao' | 'epic';
type DrumKit = 'boom' | 'four' | 'taiko' | 'shuffle' | 'half' | 'drive' | 'none';

interface StyleConfig {
  bpm: number;
  scale: string;
  root: string;
  progs: number[][];
  seventh: boolean;
  /** swing 0..1, human timing (ms, +-), velocity spread. */
  feel: { swing: number; ms: number; vel: number };
  /** Master tone -1 (warm) .. 1 (bright). */
  tone: number;
  /** reg: semitones above the key's root where the voicing is centred. */
  chords: { inst: Instrument; pattern: ChordPattern; vol: number; pan: number; reg: number; tone?: 'chip' };
  pad?: { inst: Instrument; vol: number; pan: number; reg: number };
  bass: { pattern: BassPattern; inst: Instrument; vol: number; tone?: 'chip'; octave: number };
  lead: { inst: Instrument; vol: number; pan: number; octave: number; density: number; rest: number; tone?: 'chip'; durations: number[] };
  sparkle?: { inst: Instrument; vol: number; pan: number; octave: number; density: number };
  drums: DrumKit;
  reverb: number;
}

const CFG: Record<Exclude<Style, 'phonk'>, StyleConfig> = {
  lofi: {
    bpm: 80, scale: 'dorian', root: 'C3', progs: [[0, 3, 5, 4], [0, 3, 0, 4], [1, 4, 0, 5], [0, 6, 3, 4]], seventh: true,
    feel: { swing: 0.55, ms: 14, vel: 0.14 },
    tone: -0.35,
    chords: { inst: 'epiano', pattern: 'comp', vol: 0.8, pan: -0.2, reg: 16 },
    pad: { inst: 'pad', vol: 0.5, pan: 0, reg: 9 },
    bass: { pattern: 'lofi', inst: 'bass', vol: 0.8, octave: -1 },
    lead: { inst: 'pluck', vol: 0.85, pan: 0.2, octave: 1, density: 0.55, rest: 0.18, durations: [0.5, 0.5, 1, 1, 1.5, 2] },
    sparkle: { inst: 'bell', vol: 0.65, pan: 0.35, octave: 2, density: 0.12 },
    drums: 'boom', reverb: 0.3,
  },
  chiptune: {
    bpm: 140, scale: 'major', root: 'C3', progs: [[0, 5, 3, 4], [0, 3, 4, 0], [0, 4, 5, 3], [5, 3, 0, 4]], seventh: false,
    feel: { swing: 0, ms: 0, vel: 0.05 },
    tone: 0.5,
    chords: { inst: 'arp', pattern: 'arp16', vol: 0.75, pan: -0.25, reg: 20, tone: 'chip' },
    bass: { pattern: 'pulse', inst: 'bass', vol: 0.8, octave: -1, tone: 'chip' },
    lead: { inst: 'lead', vol: 0.85, pan: 0.2, octave: 2, density: 0.75, rest: 0.1, tone: 'chip', durations: [0.5, 0.5, 0.5, 1, 1, 1.5, 2] },
    drums: 'four', reverb: 0.12,
  },
  epic: {
    bpm: 100, scale: 'minor', root: 'A2', progs: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 6, 2], [0, 5, 3, 4]], seventh: false,
    feel: { swing: 0, ms: 6, vel: 0.1 },
    tone: 0.7,
    chords: { inst: 'strings', pattern: 'swell', vol: 0.8, pan: -0.15, reg: 14 },
    pad: { inst: 'pad', vol: 0.5, pan: 0, reg: 2 },
    bass: { pattern: 'epic', inst: 'bass', vol: 0.5, octave: -1 },
    lead: { inst: 'strings', vol: 0.8, pan: 0.2, octave: 1, density: 0.45, rest: 0.1, durations: [1, 1, 1.5, 2, 2, 3] },
    sparkle: { inst: 'bell', vol: 0.55, pan: 0.3, octave: 2, density: 0.08 },
    drums: 'taiko', reverb: 0.42,
  },
  ambient: {
    bpm: 70, scale: 'lydian', root: 'C3', progs: [[0, 4, 5, 3], [0, 3, 4, 1], [0, 2, 3, 4]], seventh: true,
    feel: { swing: 0, ms: 25, vel: 0.12 },
    tone: 0.1,
    chords: { inst: 'pad', pattern: 'sustain', vol: 0.8, pan: 0, reg: 14 },
    bass: { pattern: 'drone', inst: 'bass', vol: 0.6, octave: -1 },
    lead: { inst: 'bell', vol: 0.8, pan: 0.25, octave: 2, density: 0.28, rest: 0.35, durations: [1, 1.5, 2, 3] },
    sparkle: { inst: 'flute', vol: 0.7, pan: -0.3, octave: 2, density: 0.1 },
    drums: 'none', reverb: 0.5,
  },
  action: {
    bpm: 150, scale: 'minor', root: 'D3', progs: [[0, 5, 6, 4], [0, 6, 5, 4], [0, 0, 5, 6], [0, 3, 5, 6]], seventh: false,
    feel: { swing: 0, ms: 3, vel: 0.07 },
    tone: 0.5,
    chords: { inst: 'arp', pattern: 'arp8', vol: 0.75, pan: -0.25, reg: 22 },
    pad: { inst: 'strings', vol: 0.55, pan: 0, reg: 12 },
    bass: { pattern: 'pulse', inst: 'bass', vol: 0.85, octave: -1 },
    lead: { inst: 'lead', vol: 0.85, pan: 0.2, octave: 2, density: 0.7, rest: 0.1, durations: [0.5, 0.5, 0.5, 1, 1, 1.5] },
    drums: 'drive', reverb: 0.2,
  },
  japanese: {
    bpm: 92, scale: 'japanese', root: 'D3', progs: [[0, 3, 0, 4], [0, 2, 3, 0], [0, 4, 3, 2]], seventh: false,
    feel: { swing: 0, ms: 10, vel: 0.12 },
    tone: 0.05,
    chords: { inst: 'koto', pattern: 'sustain', vol: 0.7, pan: -0.3, reg: 14 },
    pad: { inst: 'pad', vol: 0.4, pan: 0, reg: 8 },
    bass: { pattern: 'drone', inst: 'bass', vol: 0.6, octave: -1 },
    lead: { inst: 'koto', vol: 0.9, pan: 0.2, octave: 1, density: 0.5, rest: 0.25, durations: [0.5, 0.5, 1, 1, 1.5, 2] },
    sparkle: { inst: 'flute', vol: 0.8, pan: -0.25, octave: 2, density: 0.14 },
    drums: 'taiko', reverb: 0.3,
  },
  tropical: {
    bpm: 110, scale: 'major', root: 'C3', progs: [[0, 4, 5, 3], [0, 3, 4, 3], [0, 5, 1, 4]], seventh: false,
    feel: { swing: 0.4, ms: 8, vel: 0.12 },
    tone: 0.35,
    chords: { inst: 'pluck', pattern: 'offbeat', vol: 0.75, pan: -0.3, reg: 16 },
    pad: { inst: 'pad', vol: 0.35, pan: 0, reg: 9 },
    bass: { pattern: 'tumbao', inst: 'bass', vol: 0.8, octave: -1 },
    lead: { inst: 'pluck', vol: 0.85, pan: 0.2, octave: 1, density: 0.6, rest: 0.15, durations: [0.5, 0.5, 0.5, 1, 1, 1.5] },
    sparkle: { inst: 'bell', vol: 0.6, pan: 0.35, octave: 2, density: 0.15 },
    drums: 'shuffle', reverb: 0.25,
  },
  spooky: {
    bpm: 76, scale: 'phrygian', root: 'A2', progs: [[0, 1, 0, 5], [0, 5, 1, 0], [0, 1, 6, 5]], seventh: false,
    feel: { swing: 0, ms: 18, vel: 0.12 },
    tone: -0.1,
    chords: { inst: 'strings', pattern: 'swell', vol: 0.7, pan: -0.15, reg: 12 },
    pad: { inst: 'pad', vol: 0.5, pan: 0, reg: 5 },
    bass: { pattern: 'drone', inst: 'bass', vol: 0.7, octave: -1 },
    lead: { inst: 'bell', vol: 0.8, pan: 0.25, octave: 2, density: 0.3, rest: 0.4, durations: [1, 1.5, 2, 2, 3] },
    sparkle: { inst: 'flute', vol: 0.55, pan: -0.3, octave: 2, density: 0.08 },
    drums: 'half', reverb: 0.45,
  },
};

// ─── theory helpers ──────────────────────────────────────────────────────────

interface Theory {
  scale: number[];
  root: number;
  /** MIDI note of scale degree d (any integer) in the given octave. */
  note: (d: number, octave?: number) => number;
  /** Degrees stacked into a chord (3rd, 5th, 7th by steps of the scale). */
  stack: number[];
}

function theory(cfg: StyleConfig, root: number): Theory {
  const scale = SCALES[cfg.scale]!;
  const len = scale.length;
  const note = (d: number, octave = 0): number => root + 12 * (octave + Math.floor(d / len)) + scale[mod(d, len)]!;
  const stack = len >= 7 ? (cfg.seventh ? [0, 2, 4, 6] : [0, 2, 4]) : [0, 2, 3];
  return { scale, root, note, stack };
}

/** Voice-leading: the voicing of `tones` (pitch classes, root first) nearest to the previous voicing. */
function voiceLead(prev: number[] | null, tones: number[], lo: number, hi: number, centre: number): number[] {
  const nearest = (pc: number, around: number): number => {
    let best = around;
    let bd = Infinity;
    for (let m = lo; m <= hi; m++)
      if (mod(m, 12) === pc && Math.abs(m - around) < bd) {
        best = m;
        bd = Math.abs(m - around);
      }
    return best;
  };
  if (!prev || prev.length !== tones.length) return tones.map((pc) => nearest(pc, centre)).sort((a, b) => a - b);
  let best: number[] = [];
  let bestCost = Infinity;
  const permute = (arr: number[], k: number, out: number[][]): void => {
    if (k === arr.length) {
      out.push(arr.slice());
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i]!, arr[k]!];
      permute(arr, k + 1, out);
      [arr[k], arr[i]] = [arr[i]!, arr[k]!];
    }
  };
  const perms: number[][] = [];
  permute(tones.slice(), 0, perms);
  for (const perm of perms) {
    const v = perm.map((pc, i) => nearest(pc, prev[i]!));
    if (new Set(v).size < v.length) continue;
    const cost = v.reduce((a, m, i) => a + Math.abs(m - prev[i]!), 0) + (Math.max(...v) - Math.min(...v)) * 0.15;
    if (cost < bestCost) {
      bestCost = cost;
      best = v.slice().sort((a, b) => a - b);
    }
  }
  return best.length ? best : tones.map((pc) => nearest(pc, centre)).sort((a, b) => a - b);
}

// ─── harmony ─────────────────────────────────────────────────────────────────

interface Plan {
  bars: number;
  aBars: number;
  /** Scale degree of the chord root of each bar. */
  roots: number[];
  /** 0 = A section, 1 = B section. */
  section: number[];
}

function plan(cfg: StyleConfig, bars: number, rng: Rng): Plan {
  const aBars = bars >= 8 ? Math.max(2, Math.round(bars / 4) * 2) : bars;
  const progA = rng.pick(cfg.progs);
  const others = cfg.progs.filter((p) => p !== progA);
  const progB = others.length ? rng.pick(others) : progA.slice(2).concat(progA.slice(0, 2));
  const roots: number[] = [];
  const section: number[] = [];
  for (let b = 0; b < bars; b++) {
    const inA = b < aBars;
    const prog = inA ? progA : progB;
    roots.push(prog[(inA ? b : b - aBars) % prog.length]!);
    section.push(inA || bars < 8 ? 0 : 1);
  }
  // Turnaround: the last bar leans into the first chord (the dominant, or the degree before it).
  if (bars >= 4 && rng.chance(0.7)) {
    const first = roots[0]!;
    const last = roots[bars - 1]!;
    const lean = mod(first + 4, SCALES[cfg.scale]!.length);
    if (last !== lean && last !== first - 1) roots[bars - 1] = lean;
  }
  return { bars, aBars, roots, section };
}

/** Voice-led voicings of every bar's chord within [lo, hi]. */
function voicings(th: Theory, plan_: Plan, lo: number, hi: number, centre: number): number[][] {
  const out: number[][] = [];
  let prev: number[] | null = null;
  for (const r of plan_.roots) {
    const tones = th.stack.map((k) => mod(th.note(r + k), 12));
    const v = voiceLead(prev, tones, lo, hi, centre);
    out.push(v);
    prev = v;
  }
  return out;
}

// ─── melody ──────────────────────────────────────────────────────────────────

interface MNote {
  /** Beats from the start of the motif. */
  t: number;
  d: number;
  /** Scale degree (any integer; 0 = the tonic of the melody octave). */
  deg: number;
  v: number;
}

/**
 * A rhythm of durations summing to `beats`. density is the chance each note is a short one (up to a beat) rather
 * than a long one; long notes land on beats 1 and 3, short ones between.
 */
function genRhythm(rng: Rng, beats: number, durations: number[], density: number): number[] {
  for (let attempt = 0; attempt < 80; attempt++) {
    const out: number[] = [];
    let t = 0;
    while (t < beats - 1e-9) {
      const options = durations.filter((d) => t + d <= beats + 1e-9);
      if (!options.length) break;
      const strong = Math.abs(t % 2) < 1e-9;
      const wantShort = rng.chance(strong ? density * 0.7 : density + 0.2);
      const pool = options.filter((d) => (wantShort ? d <= 1 : d >= 1.5));
      const d = rng.pick(pool.length ? pool : options);
      out.push(d);
      t += d;
    }
    if (Math.abs(t - beats) < 1e-9 && out.length >= 3) return out;
  }
  return [1, 1, 2, 1, 1, 2];
}

function nearestChordDegree(deg: number, chordRoot: number, th: Theory): number {
  const len = th.scale.length;
  let best = deg;
  let bd = Infinity;
  for (const k of th.stack)
    for (let oct = -2; oct <= 2; oct++) {
      const cand = chordRoot + k + oct * len;
      if (Math.abs(cand - deg) < bd || (Math.abs(cand - deg) === bd && cand > best)) {
        bd = Math.abs(cand - deg);
        best = cand;
      }
    }
  return best;
}

/** A two-bar motif over the chords of those bars. */
function genMotif(rng: Rng, th: Theory, cfg: StyleConfig, roots: [number, number], startDeg: number, beats = 8): MNote[] {
  const rhythm = genRhythm(rng, beats, cfg.lead.durations, cfg.lead.density);
  const notes: MNote[] = [];
  const peak = rng.int(2, 4);
  let t = 0;
  let cur = nearestChordDegree(startDeg, roots[0], th);
  let last = cur;
  rhythm.forEach((d, i) => {
    const pos = i / Math.max(1, rhythm.length - 1);
    const target = startDeg + Math.round(Math.sin(Math.PI * pos) * peak) + (pos > 0.85 ? -1 : 0);
    let step = clamp(Math.round((target - cur) * 0.6), -2, 2);
    if (step === 0 && rng.chance(0.55)) step = rng.pick([-1, 1, 1, 2, -2]);
    if (Math.abs(cur - last) >= 3) step = cur > last ? -1 : 1; // resolve a leap by step
    let deg = cur + step;
    const bar = Math.floor(t / 4);
    const strong = Math.abs(t % 2) < 1e-9;
    if (strong || i === rhythm.length - 1) deg = nearestChordDegree(deg, roots[bar >= 1 ? 1 : 0], th);
    if (notes.length >= 2 && deg === notes[notes.length - 1]!.deg && deg === notes[notes.length - 2]!.deg) deg += rng.chance(0.5) ? 1 : -1;
    deg = clamp(deg, startDeg - 4, startDeg + 7);
    last = cur;
    cur = deg;
    const rest = i > 0 && i < rhythm.length - 1 && !strong && rng.chance(cfg.lead.rest * 0.5);
    notes.push({ t, d: rest ? 0 : d * (d >= 1 ? 0.92 : 0.85), deg, v: strong ? 0.82 : 0.68 });
    t += d;
  });
  // a rest is a note with zero length: fold it into the previous note's gap
  return notes.filter((n) => n.d > 0);
}

/** Transforms for developing a motif: sequence, inversion, a rhythmic change. */
function transposeMotif(m: MNote[], shift: number): MNote[] {
  return m.map((n) => ({ ...n, deg: n.deg + shift }));
}
function invertMotif(m: MNote[]): MNote[] {
  const c = m[0]!.deg;
  return m.map((n) => ({ ...n, deg: 2 * c - n.deg }));
}
function varyRhythm(m: MNote[], rng: Rng): MNote[] {
  const out = m.map((n) => ({ ...n }));
  const i = out.findIndex((n, k) => k > 0 && k < out.length - 1 && n.d >= 1);
  if (i >= 0 && rng.chance(0.7)) {
    const n = out[i]!;
    const half = n.d / 2;
    out.splice(i, 1, { ...n, d: half * 0.9 }, { ...n, t: n.t + half, d: half * 0.9, deg: n.deg + rng.pick([-1, 1, 0]), v: n.v * 0.85 });
  } else if (out.length > 4) {
    // push one note an eighth later (syncopation)
    const k = rng.int(1, out.length - 2);
    out[k]!.t += 0.5;
    out[k]!.d = Math.max(0.25, out[k]!.d - 0.5);
  }
  return out;
}

/** Re-snaps strong beats of a developed motif to the chord tones of the bars it now sits in. */
function resnap(m: MNote[], rootsOfBars: [number, number], th: Theory): MNote[] {
  return m.map((n) => {
    const strong = Math.abs(n.t % 2) < 1e-9;
    return strong ? { ...n, deg: nearestChordDegree(n.deg, rootsOfBars[Math.floor(n.t / 4) >= 1 ? 1 : 0], th) } : n;
  });
}

// ─── drums ───────────────────────────────────────────────────────────────────

/** 16-step patterns per bar: x normal, X accent, o ghost, . nothing. */
const GROOVES: Record<Exclude<DrumKit, 'none'>, { a: Record<string, string>; b: Record<string, string> }> = {
  boom: {
    a: { kick: 'X......x..x.....', snare: '....X.......X.o.', hat: 'x.o.x.o.x.o.x.o.', open: '..............x.' },
    b: { kick: 'X.....ox..x...o.', snare: '....X.o.....X.o.', hat: 'xoxoxoxoxoxoxoxo', open: '......x.......x.', shaker: '.o.o.o.o.o.o.o.o' },
  },
  four: {
    a: { kick: 'X...x...X...x...', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', open: '..x...x...x...x.' },
    b: { kick: 'X...x...X...x...', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx', open: '..x...x...x...x.', clap: '....x.......x...' },
  },
  drive: {
    a: { kick: 'X..xX..xX..xX..x', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', open: '..x...x...x...x.' },
    b: { kick: 'X..xX..xX..xX.xx', snare: '....X.......X..x', hat: 'xxxxxxxxxxxxxxxx', open: '..x...x...x...x.', clap: '....x.......x...' },
  },
  taiko: {
    a: { kick: 'X.....x.X.x.....', hat: '..............x.', shaker: 'o.o.o.o.o.o.o.o.' },
    b: { kick: 'X.....x.X.x.x...', snare: '............X...', hat: 'x.x.x.x.x.x.x.x.', shaker: 'xoxoxoxoxoxoxoxo' },
  },
  shuffle: {
    a: { kick: 'X.....x.X.x.....', clap: '....x.......x...', hat: 'x.o.x.o.x.o.x.o.' },
    b: { kick: 'X.....x.X.x...x.', clap: '....X.......X...', hat: 'xoxoxoxoxoxoxoxo', shaker: '.x.x.x.x.x.x.x.x' },
  },
  half: {
    a: { kick: 'X...............', snare: '........o.......' },
    b: { kick: 'X.......x.......', snare: '........X.......', hat: '..o...o...o...o.' },
  },
};

const LANES: Record<string, { inst: Instrument; vol: number; pan: number }> = {
  kick: { inst: 'kick', vol: 0.85, pan: 0 },
  snare: { inst: 'snare', vol: 0.75, pan: 0.05 },
  clap: { inst: 'clap', vol: 0.75, pan: 0.1 },
  hat: { inst: 'hat', vol: 0.7, pan: 0.3 },
  open: { inst: 'openhat', vol: 0.7, pan: 0.3 },
  shaker: { inst: 'shaker', vol: 0.65, pan: -0.3 },
};

const velOf = (c: string): number => (c === 'X' ? 1 : c === 'x' ? 0.78 : c === 'o' ? 0.36 : 0);

interface DrumHit {
  lane: string;
  t: number;
  v: number;
  n?: number;
}

function drumBars(kit: DrumKit, plan_: Plan, rng: Rng, th: Theory): DrumHit[] {
  if (kit === 'none') return [];
  const g = GROOVES[kit];
  const hits: DrumHit[] = [];
  for (let bar = 0; bar < plan_.bars; bar++) {
    const b0 = bar * 4;
    const pat = plan_.section[bar] === 1 && plan_.bars >= 8 ? g.b : g.a;
    const lastOf4 = bar % 4 === 3;
    const bigFill = bar % 8 === 7 || bar === plan_.bars - 1;
    const fillFrom = bigFill ? 8 : lastOf4 ? 12 : 16; // first step of the fill
    for (const [lane, str] of Object.entries(pat)) {
      for (let s = 0; s < 16; s++) {
        if (s >= fillFrom && lane !== 'kick') continue;
        if (s >= fillFrom + 2 && lane === 'kick') continue;
        let v = velOf(str[s]!);
        if (!v) continue;
        // ghost notes come and go
        if (str[s] === 'o' && rng.chance(0.35)) continue;
        v *= plan_.section[bar] === 1 ? 1 : 0.92;
        hits.push({ lane, t: b0 + s * 0.25, v });
      }
    }
    if (fillFrom < 16) {
      const steps = 16 - fillFrom;
      if (kit === 'taiko') {
        for (let k = 0; k < steps; k++) hits.push({ lane: 'tom', t: b0 + (fillFrom + k) * 0.25, v: 0.5 + (0.5 * k) / steps, n: th.note(k % 3 === 0 ? -3 : k % 3 === 1 ? -1 : 0, -1) });
      } else if (kit === 'half') {
        hits.push({ lane: 'tom', t: b0 + 3, v: 0.5, n: th.note(0, -1) }, { lane: 'tom', t: b0 + 3.5, v: 0.4, n: th.note(-1, -1) });
      } else {
        const rolls = kit === 'boom' || kit === 'shuffle' ? [0, 1, 2, 3].filter(() => rng.chance(0.8)) : [0, 1, 2, 3];
        for (const k of rolls) hits.push({ lane: 'snare', t: b0 + (fillFrom + k * (steps / 4)) * 0.25 + (steps === 8 ? 0 : 0), v: 0.45 + (0.5 * k) / 4 });
        if (bigFill) for (let k = 0; k < 4; k++) hits.push({ lane: 'tom', t: b0 + 2 + k * 0.25, v: 0.6 + k * 0.08, n: th.note(3 - k, -1) });
      }
    }
    // crash where a section starts (after the fill), and at the loop start
    if (bar === 0 || bar === plan_.aBars) if (plan_.bars >= 8) hits.push({ lane: 'crash', t: b0, v: 0.8 });
  }
  return hits;
}

// ─── bass ────────────────────────────────────────────────────────────────────

type BassEv = [t: number, d: number, semitones: number, v: number];

function bassBar(pattern: BassPattern, rng: Rng, fifth: number, section: number): BassEv[] {
  switch (pattern) {
    case 'lofi':
      return rng.pick<BassEv[]>([
        [[0, 1.5, 0, 0.85], [2.5, 0.75, fifth, 0.65], [3.5, 0.4, 0, 0.55]],
        [[0, 2, 0, 0.85], [2.5, 0.5, 12, 0.6], [3, 0.9, fifth, 0.6]],
        [[0, 1.25, 0, 0.85], [1.5, 0.5, 0, 0.55], [2.5, 1.5, fifth, 0.7]],
      ]);
    case 'pulse': {
      const out: BassEv[] = [];
      const motif = section === 1 ? [0, 0, 12, 0, 0, fifth, 12, 0] : [0, 0, 12, 0, 0, 12, 0, 12];
      motif.forEach((s, i) => out.push([i * 0.5, 0.42, s, i % 2 === 0 ? 0.85 : 0.65]));
      return out;
    }
    case 'sustain':
      return [[0, 3.9, 0, 0.8]];
    case 'drone':
      return [[0, 3.95, 0, 0.7]];
    case 'tumbao':
      return [[0, 0.7, 0, 0.8], [1.5, 0.5, fifth, 0.7], [2, 0.7, 0, 0.75], [3.5, 0.45, fifth, 0.7]];
    case 'epic':
      return section === 1 ? [[0, 1, 0, 0.85], [1, 1, 0, 0.7], [2, 1, fifth, 0.75], [3, 0.9, 0, 0.7]] : [[0, 3.9, 0, 0.8]];
  }
}

// ─── the composer ────────────────────────────────────────────────────────────

/** Swing, human timing and velocity, written into the notes. */
function feel(notes: NoteEvent[], f: { swing: number; ms: number; vel: number }, bpm: number, rng: Rng, tight = 1): NoteEvent[] {
  const msBeats = (f.ms / 1000) * (bpm / 60) * tight;
  return notes.map((n) => {
    let t = n.t;
    const frac = t - Math.floor(t);
    if (f.swing > 0) {
      if (Math.abs(frac - 0.5) < 1e-6 || Math.abs(frac - 0.75) < 1e-6) t += f.swing * (1 / 6);
      else if (Math.abs(frac - 0.25) < 1e-6) t += f.swing * (1 / 12);
    }
    if (msBeats > 0) t += clamp(rng.gauss() * msBeats * 0.5, -msBeats, msBeats);
    const v = clamp((n.v ?? 0.8) * (1 + rng.gauss() * f.vel * 0.5), 0.05, 1);
    return { ...n, t: Math.max(0, Math.round(t * 1000) / 1000), v: Math.round(v * 100) / 100 };
  });
}

/**
 * The key a style's music is in: its root (MIDI) for a key, its scale (semitones from the root) and its tempo.
 * What a stinger needs to stay inside the notes of the track playing under it.
 */
export function styleKey(style: Style, key?: string): { root: number; scale: number[]; bpm: number } {
  if (style === 'phonk') return { root: midiOf(key ?? 'F2'), scale: SCALES.minor!, bpm: 140 };
  const cfg = CFG[style];
  if (!cfg) throw new Error(`Unknown style "${style}" (styles: ${STYLES.join(', ')})`);
  return { root: midiOf(key ?? cfg.root), scale: SCALES[cfg.scale]!, bpm: cfg.bpm };
}

export interface ComposeOptions {
  key?: string;
  bpm?: number;
  bars?: number;
  seed?: number;
}

/**
 * Builds a complete, loopable song spec from a style: voice-led chords (7ths where the style fits), a
 * developed melody, a bass line, drums with fills, texture, swing and human feel. The agent can pass the
 * result straight to renderSong or edit it first.
 */
export function composeStyle(style: Style, opts: ComposeOptions = {}): SongSpec {
  if (style === 'phonk') return composePhonk(opts);
  const cfg = CFG[style];
  if (!cfg) throw new Error(`Unknown style "${style}" (styles: ${STYLES.join(', ')})`);
  const rng = new Rng((opts.seed ?? 11) * 7919 + 3);
  const bpm = opts.bpm ?? cfg.bpm;
  const bars = Math.max(2, Math.min(64, opts.bars ?? 8));
  const beats = bars * 4;
  const root = midiOf(opts.key ?? cfg.root);
  const th = theory(cfg, root);
  const pl = plan(cfg, bars, rng);
  const tracks: Track[] = [];
  const fl = (notes: NoteEvent[], tight = 1) => feel(notes, cfg.feel, bpm, rng, tight);

  // ── harmony ──
  const centre = root + cfg.chords.reg;
  const chordVoicings = voicings(th, pl, centre - 9, centre + 9, centre);
  const chordNotes: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * 4;
    const v = chordVoicings[bar]!;
    const energy = pl.section[bar] === 1 ? 1 : 0.85;
    switch (cfg.chords.pattern) {
      case 'sustain':
      case 'swell': {
        const strum = cfg.chords.inst === 'koto' || cfg.chords.inst === 'pluck' ? 0.03 : 0;
        v.forEach((m, i) => chordNotes.push({ t: b0 + i * strum, d: 3.95, n: m, v: (cfg.chords.pattern === 'swell' ? 0.55 : 0.5) * energy }));
        break;
      }
      case 'comp': {
        const variant = rng.pick([[[0, 1.4], [1.5, 0.45], [2.5, 1.4]], [[0, 2.2], [2.5, 1.4]], [[0, 1.4], [1.5, 0.45], [3, 0.9]]]);
        variant.forEach(([t, d], i) => {
          for (const m of v) chordNotes.push({ t: b0 + t!, d: d! * 0.95, n: m, v: (i === 0 ? 0.72 : 0.55) * energy });
        });
        break;
      }
      case 'offbeat':
        for (let k = 0; k < 4; k++) for (const m of v) chordNotes.push({ t: b0 + k + 0.5, d: 0.3, n: m, v: 0.62 * energy });
        break;
      case 'arp16':
      case 'arp8': {
        const step = cfg.chords.pattern === 'arp16' ? 0.25 : 0.5;
        const order = pl.section[bar] === 1 ? [0, 1, 2, 3, 2, 1] : [0, 1, 2, 1];
        const hiTone = v[v.length - 1]! + 12;
        const seq = [...v, hiTone];
        for (let k = 0; k < 4 / step; k++) {
          const idx = order[k % order.length]! % seq.length;
          chordNotes.push({ t: b0 + k * step, d: step * 0.9, n: seq[idx]!, v: (k % 4 === 0 ? 0.7 : 0.5) * energy });
        }
        break;
      }
      case 'none':
        break;
    }
  }
  if (chordNotes.length)
    tracks.push({ instrument: cfg.chords.inst, name: 'chords', volume: cfg.chords.vol, pan: cfg.chords.pan, tone: cfg.chords.tone, notes: fl(chordNotes) });
  if (cfg.pad) {
    const padCentre = root + cfg.pad.reg;
    const padV = voicings(th, pl, padCentre - 8, padCentre + 8, padCentre);
    const padNotes: NoteEvent[] = [];
    for (let bar = 0; bar < bars; bar++) for (const m of padV[bar]!) padNotes.push({ t: bar * 4, d: 3.95, n: m, v: 0.5 });
    tracks.push({ instrument: cfg.pad.inst, name: 'pad', volume: cfg.pad.vol, pan: cfg.pad.pan, notes: fl(padNotes, 0.3) });
  }

  // ── bass ──
  const bassNotes: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const r = pl.roots[bar]!;
    const nextR = pl.roots[(bar + 1) % bars]!;
    const base = th.note(r, cfg.bass.octave);
    const fifthSemis = th.note(r + 4, cfg.bass.octave) - base;
    const evs = bassBar(cfg.bass.pattern, rng, fifthSemis, pl.section[bar]!);
    for (const [t, d, semis, v] of evs) bassNotes.push({ t: bar * 4 + t, d, n: base + semis, v });
    // approach the next root in the bar's last half beat
    if (cfg.bass.pattern === 'lofi' && !evs.some((e) => e[0] >= 3.25) && rng.chance(0.5)) {
      const target = th.note(nextR, cfg.bass.octave);
      bassNotes.push({ t: bar * 4 + 3.5, d: 0.45, n: target + (rng.chance(0.5) ? -1 : 1) * (rng.chance(0.5) ? 1 : 2), v: 0.55 });
    }
  }
  // drop approach notes that collide with the last note of the bar
  tracks.push({ instrument: cfg.bass.inst, name: 'bass', volume: cfg.bass.vol, tone: cfg.bass.tone, notes: fl(bassNotes, 0.5) });

  // ── melody: A, A', B, A'' ──
  const lead: NoteEvent[] = [];
  const motifBars = 2;
  const startA = 2;
  const startB = 3;
  const mA = genMotif(rng, th, cfg, [pl.roots[0]!, pl.roots[1 % bars]!], startA);
  const mB = genMotif(rng, th, cfg, [pl.roots[pl.aBars % bars]!, pl.roots[(pl.aBars + 1) % bars]!], startB);
  const phraseCount = Math.ceil(bars / motifBars);
  for (let ph = 0; ph < phraseCount; ph++) {
    const bar = ph * motifBars;
    const inB = pl.section[bar] === 1 && bars >= 8;
    const idx = inB ? ph - Math.ceil(pl.aBars / motifBars) : ph;
    const base = inB ? mB : mA;
    const r0 = pl.roots[bar]!;
    const r1 = pl.roots[(bar + 1) % bars]!;
    let m: MNote[];
    switch (idx % 4) {
      case 0:
        m = base;
        break;
      case 1:
        m = varyRhythm(transposeMotif(base, rng.pick([1, 2, -1])), rng);
        break;
      case 2:
        m = rng.chance(0.5) ? invertMotif(base) : transposeMotif(base, rng.pick([2, 3, -2]));
        break;
      default:
        m = varyRhythm(base, rng);
    }
    m = resnap(m, [r0, r1], th);
    const last = ph === phraseCount - 1;
    if (last) {
      // end open: on the chord's third or fifth, not the tonic, so the loop restarts into the tonic
      const k = m.length - 1;
      const len = th.scale.length;
      const cands: number[] = [];
      for (const tone of th.stack.slice(1, 3)) for (let oct = -2; oct <= 2; oct++) cands.push(r1 + tone + oct * len);
      cands.sort((a, b) => Math.abs(a - m[k]!.deg) - Math.abs(b - m[k]!.deg));
      m[k] = { ...m[k]!, deg: cands[0]! };
    }
    for (const n of m) {
      const t = bar * 4 + n.t;
      if (t >= beats) continue;
      lead.push({ t, d: Math.min(n.d, beats - t), n: th.note(n.deg, cfg.lead.octave), v: n.v * (pl.section[bar] === 1 ? 1 : 0.9) });
    }
  }
  tracks.push({ instrument: cfg.lead.inst, name: 'melody', volume: cfg.lead.vol, pan: cfg.lead.pan, tone: cfg.lead.tone, notes: fl(lead) });

  // ── sparkle: sparse chord-tone chimes in the top register ──
  if (cfg.sparkle) {
    const sp: NoteEvent[] = [];
    for (let bar = 0; bar < bars; bar++) {
      const r = pl.roots[bar]!;
      for (let k = 0; k < 8; k++) {
        if (!rng.chance(cfg.sparkle.density * (pl.section[bar] === 1 ? 1.6 : 1))) continue;
        const tone = th.stack[rng.int(0, th.stack.length - 1)]!;
        sp.push({ t: bar * 4 + k * 0.5, d: 1.2, n: th.note(r + tone + (rng.chance(0.2) ? th.scale.length : 0), cfg.sparkle.octave), v: 0.45 + rng.next() * 0.3 });
      }
    }
    if (sp.length) tracks.push({ instrument: cfg.sparkle.inst, name: 'sparkle', volume: cfg.sparkle.vol, pan: cfg.sparkle.pan, notes: fl(sp) });
  }

  // ── drums ──
  const hits = drumBars(cfg.drums, pl, rng, th);
  const byLane = new Map<string, DrumHit[]>();
  for (const h of hits) byLane.set(h.lane, [...(byLane.get(h.lane) ?? []), h]);
  const laneInst: Record<string, { inst: Instrument; vol: number; pan: number }> = {
    ...LANES,
    tom: { inst: 'tom', vol: 0.75, pan: -0.15 },
    crash: { inst: 'crash', vol: 0.7, pan: 0.2 },
  };
  if (cfg.drums === 'taiko' || cfg.drums === 'half') laneInst.kick = { inst: cfg.drums === 'half' ? 'kick' : 'taiko', vol: cfg.drums === 'half' ? 0.85 : 0.5, pan: 0 };
  if (cfg.drums === 'taiko') {
    laneInst.hat = { inst: 'hat', vol: 0.95, pan: 0.3 };
    laneInst.shaker = { inst: 'shaker', vol: 1, pan: -0.3 };
    laneInst.tom = { inst: 'tom', vol: 0.6, pan: -0.15 };
  }
  if (cfg.drums === 'shuffle' || cfg.drums === 'half') laneInst.snare = { inst: cfg.drums === 'half' ? 'snare' : 'rim', vol: cfg.drums === 'half' ? 0.6 : 0.7, pan: 0.05 };
  for (const [lane, hs] of byLane) {
    const def = laneInst[lane]!;
    const tight = lane === 'kick' || lane === 'snare' || lane === 'clap' ? 0.45 : 0.8;
    const evs: NoteEvent[] = hs.map((h) => ({ t: h.t, d: 0.25, v: h.v, ...(h.n !== undefined ? { n: h.n } : {}) }));
    tracks.push({ instrument: def.inst, name: lane === 'open' ? 'open hat' : lane, volume: def.vol, pan: lane === 'hat' || lane === 'open' ? 0.3 : def.pan, notes: fl(evs, tight) });
  }

  const sections = pl.aBars < bars ? [{ name: 'A', bars: pl.aBars }, { name: 'B', bars: bars - pl.aBars }] : [{ name: 'A', bars }];
  return { bpm, beats, tracks, reverb: cfg.reverb, swing: cfg.feel.swing, tone: cfg.tone, sections, style, key: `${pitchName(root)} ${cfg.scale}`, chords: chordVoicings.map((v) => [...v]) };
}
