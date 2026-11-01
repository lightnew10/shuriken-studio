/**
 * The song renderer: a SongSpec (tracks of timed notes) becomes a mastered stereo loop.
 *
 * Instruments are small synthesis recipes on the DSP core (band-limited oscillators, resonant filters,
 * FM, Karplus-Strong strings, noise drums), not sine+envelope sketches. The mix is built like one:
 *  - every track gets a low-cut (all but bass and kick), a pan, optional saturation and a sidechain duck from the kick
 *  - reverb and delay are SENDS (damped Freeverb room, tempo-synced ping-pong delay), never on kick and bass
 *  - wide instruments (pads, strings, e-piano) spread their own detuned voices; the master keeps everything
 *    under 150 Hz mono, adds presence and air, glues with a gentle compressor and masters to -16 LUFS
 *  - tails are rendered into a few seconds of extra room and folded back onto the start, so the loop is
 *    seamless (notes, reverb and delay all wrap)
 */
import { Rng, SAMPLE_RATE, dbToLin, midiToHz } from './dsp/util';
import { Osc } from './dsp/osc';
import { Noise } from './dsp/noise';
import { Biquad, Svf } from './dsp/filter';
import { adsr } from './dsp/env';
import { Saturator, compress, delayWet } from './dsp/fx';
import { reverbWet } from './dsp/reverb';
import { master, measureLoudness, type AudioCategory } from './dsp/master';
import { renderSamplerNote, samplerLength, type LoadedSample, type SampleBank } from './sampler';
import { analyseMix, type MixReport } from './music-analysis';

const SR = SAMPLE_RATE;
const TAU = 2 * Math.PI;

export type Instrument =
  | 'lead' | 'pluck' | 'bass' | 'pad' | 'bell' | 'arp' | 'strings' | 'kick' | 'snare' | 'hat' | 'clap' | 'shaker' | 'taiko' | 'koto' | 'flute'
  | 'epiano' | 'openhat' | 'crash' | 'tom' | 'rim' | 'cowbell' | 'bass808' | 'riser' | 'impact'
  /** Sample-only parts (a track with `sample`): a generic one, a vocal and a texture bed, each with its own mix defaults. */
  | 'sample' | 'vocal' | 'texture';

export const INSTRUMENTS: readonly Instrument[] = ['lead', 'pluck', 'bass', 'pad', 'bell', 'arp', 'strings', 'kick', 'snare', 'hat', 'clap', 'shaker', 'taiko', 'koto', 'flute', 'epiano', 'openhat', 'crash', 'tom', 'rim', 'cowbell', 'bass808', 'riser', 'impact', 'sample', 'vocal', 'texture'];
/** Instruments that only play samples. */
export const SAMPLE_ONLY = new Set<Instrument>(['sample', 'vocal', 'texture']);

export interface NoteEvent {
  /** Start, in beats from the start of the song. */
  t: number;
  /** Length in beats. */
  d: number;
  /** Note name ("C4", "F#3", "Bb2") or MIDI number. Ignored for drums except toms. */
  n?: string | number;
  /** Velocity 0..1. */
  v?: number;
  /** bass808 only: the note slides to this note over the second half of its length. */
  glide?: string | number;
  /** Sample tracks with a loop or texture: the beat of the bed the note starts at (chops). */
  o?: number;
}

/** A curve over the song: [beat, value] points, linear between them (filters move on a log scale), held after the last. */
export type Curve = Array<[number, number]>;

export interface Automation {
  /** Low-pass cutoff (Hz) over time: a sweep into or out of a breakdown. */
  lp?: Curve;
  /** High-pass cutoff (Hz) over time. */
  hp?: Curve;
  /** Gain (0..2, 1 = as mixed) over time: fades, builds, a part dropping out. */
  gain?: Curve;
}

export interface Track {
  instrument: Instrument;
  /** A name to refer to the part by ("cowbell", "808 intro"). */
  name?: string;
  volume?: number;
  /** -1 (left) .. 1 (right). */
  pan?: number;
  notes: NoteEvent[];
  /** Reverb send 0..1 and delay send 0..1 (defaults per instrument; kick and bass have none). */
  send?: number;
  delay?: number;
  /** Low-cut (Hz) and high-cut (Hz) on the track (defaults per instrument). */
  hp?: number;
  lp?: number;
  /** Stereo spread of the instrument's own voices 0..1. */
  width?: number;
  /** Sidechain depth from the kick 0..1 (the track ducks on every kick). */
  duck?: number;
  /** Saturation 0..1. */
  drive?: number;
  /** Bit and sample-rate reduction 0..1 (lo-fi grit). */
  crush?: number;
  /** "chip" gives lead, arp and bass the plain pulse/triangle voices of an 8-bit machine. */
  tone?: 'chip';
  /** bass808: the share of a gliding note the slide takes (default 0.5, the second half). */
  slide?: number;
  /** Filters and gain moving over the song. */
  auto?: Automation;
  /** Left out of the mix (kept in the score). */
  mute?: boolean;
  /**
   * Plays this sample (an id from the sample library) instead of the synthesized voice; the instrument still
   * sets the mix defaults (send, low-cut, sidechain) and the level it is matched to.
   */
  sample?: string;
  /** Sample tracks: notes move the sample against its root (default: melodic one-shots and loops in a key do, drum hits don't). */
  pitched?: boolean;
  /** Sample tracks: semitones added to every note (tunes a drum hit, or moves a part). */
  tune?: number;
  /** Sample tracks: cut at the note's end plus release (default: melodic parts and beds are cut, drum hits ring out). */
  gate?: boolean;
  /** Sample tracks: seconds of fade after a cut note (default 0.08 for one-shots, 0.01 for beds). */
  release?: number;
  /** Sample tracks: played backwards. */
  reverse?: boolean;
  /** Sample one-shots: seconds into the sample to start at (skip an attack, use the middle of a phrase). */
  start?: number;
}

/** Tape and vinyl on the whole mix: each 0..1. */
export interface Tape {
  /** Slow pitch drift (wow) and a little flutter. */
  wow?: number;
  /** A bed of tape hiss under the music. */
  hiss?: number;
  /** Vinyl crackle: dust clicks. */
  crackle?: number;
  /** Age: the top rolled off, the lows thinned, a little saturation. */
  warmth?: number;
}

export interface SongSpec {
  bpm: number;
  /** Total length in beats (the loop length). */
  beats: number;
  tracks: Track[];
  /** Reverb amount 0..1 (scales every send). */
  reverb?: number;
  /** Informational: the song's sections, in bars. */
  sections?: Array<{ name: string; bars: number }>;
  /** Informational: swing 0..1 the composer applied. */
  swing?: number;
  /** Master tone -1 (dark, warm) .. 1 (bright, airy): presence and air of the master EQ. Default 0.4. */
  tone?: number;
  /** Master drive 0..1: saturation of the bus before the limiter (0 is a touch). */
  drive?: number;
  /** Integrated loudness (LUFS) this song is mastered to instead of its category's; for genres that are meant to be hot. */
  loudness?: number;
  /**
   * The first introBeats play once; the loop is everything after them (the intro's reverb flows into the loop,
   * the loop's tail wraps onto its own start). The MP3 loop region starts there (songLoopStart).
   */
  introBeats?: number;
  /** The render seed (voices' random detail): kept so an edited score renders the rest the same. */
  seed?: number;
  /** Informational: the style it was composed in, its key ("F minor") and its chords, one voicing (MIDI notes) per bar. */
  style?: string;
  key?: string;
  chords?: number[][];
  /** The tempo-synced delay: left and right times in beats (default 0.75 and 1) and feedback 0..0.9 (default 0.36). */
  delayTime?: { left?: number; right?: number; feedback?: number };
  /** How fast the sidechain lets go after a kick, seconds (default 0.075; longer pumps more). */
  duckRelease?: number;
  /** Filters and gain on the whole mix over time. */
  auto?: Automation;
  /** Tape and vinyl character on the whole mix. */
  tape?: Tape;
}

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** A MIDI note's pitch class as a key's name ("F", "Bb"). */
export const pitchName = (m: number): string => PITCH_NAMES[((Math.round(m) % 12) + 12) % 12]!;

export function midiOf(n: string | number): number {
  if (typeof n === 'number') return n;
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(n.trim());
  if (!m) throw new Error(`Bad note "${n}" (use names like C4, F#3, Bb2 or MIDI numbers)`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]!.toUpperCase()]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

// ─── instruments ─────────────────────────────────────────────────────────────

interface Ctx {
  L: Float32Array;
  R: Float32Array;
  start: number;
  len: number;
  f: number;
  dur: number;
  vel: number;
  gl: number;
  gr: number;
  width: number;
  rand: Rng;
  chip: boolean;
  /** Glide target in Hz (0 = none). */
  f2: number;
  /** Share of the note the glide takes. */
  slide: number;
}

const put = (c: Ctx, i: number, l: number, r: number): void => {
  const k = c.start + i;
  if (k < c.L.length) {
    c.L[k]! += l * c.gl;
    c.R[k]! += r * c.gr;
  }
};
const mono = (c: Ctx, i: number, y: number): void => put(c, i, y, y);
/** Stereo voices: width 1 keeps the voice's own left and right, 0 folds them to mono. */
const spread = (c: Ctx, i: number, l: number, r: number): void => {
  const a = 0.5 + 0.5 * c.width;
  const b = 0.5 - 0.5 * c.width;
  put(c, i, l * a + r * b, r * a + l * b);
};
const ctl = (i: number): boolean => (i & 7) === 0;

/** Karplus-Strong plucked string with a fractional-delay tuner: t60 seconds to decay 60 dB, bright 0..1. */
function karplus(c: Ctx, t60: number, bright: number, release = 0.35): void {
  const stretch = 0.5 - 0.35 * bright; // weight of the next sample in the loop average: lower = brighter
  const P = SR / c.f - stretch;
  const N = Math.max(4, Math.floor(P));
  const frac = P - N;
  const ap = (1 - frac) / (1 + frac);
  const buf = new Float32Array(N);
  let lp = 0;
  const colour = 0.15 + 0.8 * bright;
  let rms = 0;
  for (let k = 0; k < N; k++) {
    lp += colour * (c.rand.bipolar() - lp);
    buf[k] = lp;
    rms += lp * lp;
  }
  const norm = 1 / Math.max(1e-6, Math.sqrt(rms / N));
  for (let k = 0; k < N; k++) buf[k]! *= norm * 0.5;
  const g = Math.pow(0.001, 1 / Math.max(1, c.f * t60)); // loop gain per period
  let idx = 0;
  let apx = 0;
  let apy = 0;
  for (let i = 0; i < c.len; i++) {
    const t = i / SR;
    const cur = buf[idx]!;
    const next = buf[(idx + 1) % N]!;
    const y = ((1 - stretch) * cur + stretch * next) * g;
    const yap = ap * (y - apy) + apx;
    apx = y;
    apy = yap;
    buf[idx] = yap;
    idx = (idx + 1) % N;
    const tail = t > c.dur ? Math.exp(-(t - c.dur) / release) : 1;
    mono(c, i, cur * tail * (0.5 + 0.6 * c.vel));
  }
}

type VoiceFn = (c: Ctx) => void;

const VOICES: Record<Instrument, { fn: VoiceFn; tail: number; drum?: boolean }> = {
  lead: {
    tail: 0.18,
    fn: (c) => {
      const o1 = new Osc(c.rand.next());
      const o2 = new Osc(c.rand.next());
      const o3 = new Osc(c.rand.next());
      const f = new Svf(3000, 0.9);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        const vib = 1 + 0.0035 * Math.min(1, t / 0.18) * Math.sin(TAU * 5.6 * t);
        const fr = c.f * vib;
        let s: number;
        if (c.chip) s = o1.pulse(fr, 0.5) * 0.5 + o2.pulse(fr * 2.002, 0.25) * 0.18;
        else {
          s = (o1.saw(fr * 0.9965) + o3.saw(fr * 1.0035)) * 0.42 + o2.pulse(fr, 0.34) * 0.36;
          if (ctl(i)) f.set(Math.min(13000, 1200 + (1400 + 3600 * c.vel) * Math.exp(-t / 0.2) + c.f * 2), 0.9);
          s = f.process(s);
        }
        mono(c, i, s * adsr(t, c.dur, 0.007, 0.16, 0.64, 0.14) * (0.16 + 0.2 * c.vel));
      }
    },
  },
  pluck: {
    tail: 1.3,
    fn: (c) => karplus(c, 0.9, 0.55, 0.3),
  },
  koto: {
    tail: 1.6,
    fn: (c) => {
      karplus(c, 1.4, 0.8, 0.5);
      // the pick: a few ms of bright noise
      const n = new Noise(c.rand.int(1, 1e6));
      const f = new Svf(3200, 0.9);
      for (let i = 0; i < Math.min(c.len, 220); i++) {
        if (ctl(i)) f.set(3200, 0.9);
        f.process(n.white());
        mono(c, i, f.hp * Math.exp(-i / 55) * 0.05 * c.vel);
      }
    },
  },
  bass: {
    tail: 0.12,
    fn: (c) => {
      const so = new Osc(0);
      const sw = new Osc(c.rand.next());
      const f = new Svf(400, 0.8);
      const sat = new Saturator(1.2);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        let s: number;
        if (c.chip) s = so.triangle(c.f) * 0.9 + sw.pulse(c.f * 2, 0.25) * 0.08;
        else {
          if (ctl(i)) f.set(180 + (500 + 800 * c.vel) * Math.exp(-t / 0.12) + c.f * 2.5, 0.9);
          s = sat.process((so.sine(c.f) * 0.75 + f.process(sw.saw(c.f)) * 0.45) * 0.9);
        }
        mono(c, i, s * adsr(t, c.dur, 0.004, 0.16, 0.85, 0.07) * (0.35 + 0.35 * c.vel));
      }
    },
  },
  pad: {
    tail: 1.0,
    fn: (c) => {
      const dets = [-0.012, -0.007, -0.0025, 0.0025, 0.007, 0.012];
      const oscs = dets.map(() => new Osc(c.rand.next()));
      const fl = new Svf(1500, 0.9);
      const fr = new Svf(1500, 0.9);
      const ph = c.rand.next() * TAU;
      const w = c.width;
      let env = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        let sl = 0;
        let sr = 0;
        for (let k = 0; k < 6; k++) {
          const s = oscs[k]!.saw(c.f * (1 + dets[k]! * (0.6 + 0.8 * w)));
          if (k % 2 === 0) sl += s;
          else sr += s;
        }
        if (ctl(i)) {
          const lfo = 0.5 + 0.5 * Math.sin(TAU * 0.11 * t + ph);
          const cut = Math.min(11000, 900 + 1500 * lfo + 1500 * c.vel + c.f * 1.6);
          fl.set(cut, 0.9);
          fr.set(cut * 1.05, 0.9);
        }
        if ((i & 3) === 0) env = adsr(t, c.dur, 0.45, 0.4, 0.8, 0.9) * 0.1;
        const l = fl.process(sl) * env;
        const r = fr.process(sr) * env;
        spread(c, i, l, r);
      }
    },
  },
  strings: {
    tail: 0.8,
    fn: (c) => {
      const dets = [-0.006, 0.0, 0.006];
      const oa = dets.map(() => new Osc(c.rand.next()));
      const ob = dets.map(() => new Osc(c.rand.next()));
      const fl = new Svf(2500, 0.8);
      const fr = new Svf(2500, 0.8);
      const bow = new Noise(c.rand.int(1, 1e6));
      const bf = new Svf(3500, 0.9);
      let env = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        const vib = 1 + 0.004 * Math.min(1, Math.max(0, (t - 0.25) / 0.4)) * Math.sin(TAU * 5.1 * t);
        let sl = 0;
        let sr = 0;
        for (let k = 0; k < 3; k++) {
          sl += oa[k]!.saw(c.f * vib * (1 + dets[k]!));
          sr += ob[k]!.saw(c.f * vib * (1 + dets[k]! * 1.15 + 0.002));
        }
        if (ctl(i)) {
          const cut = Math.min(12000, 2400 + 3600 * c.vel + c.f * 3);
          fl.set(cut, 0.8);
          fr.set(cut, 0.8);
          bf.set(3500, 0.9);
        }
        bf.process(bow.white());
        if ((i & 3) === 0) env = adsr(t, c.dur, 0.2, 0.25, 0.85, 0.55) * 0.11;
        const l = (fl.process(sl) + bf.hp * 0.03) * env;
        const r = (fr.process(sr) + bf.hp * 0.03) * env;
        spread(c, i, l, r);
      }
    },
  },
  bell: {
    tail: 2.6,
    fn: (c) => {
      let pc = 0;
      let pm = 0;
      let p2 = 0;
      const ring = Math.min(2.4, Math.max(0.5, 1.5 * Math.sqrt(440 / c.f)));
      const kRing = Math.exp(-1 / (ring * SR));
      const kIdx = Math.exp(-1 / (0.45 * SR));
      const kP2 = Math.exp(-1 / (0.35 * SR));
      let eRing = 1;
      let eIdx = 1;
      let eP2 = 1;
      for (let i = 0; i < c.len; i++) {
        pc += c.f / SR;
        pm += (c.f * 3.5) / SR;
        p2 += (c.f * 2.76) / SR;
        const idx = (1 + 2.2 * c.vel) * eIdx;
        const s = Math.sin(TAU * pc + idx * Math.sin(TAU * pm)) + 0.3 * Math.sin(TAU * p2) * eP2;
        mono(c, i, s * Math.min(1, i / (0.002 * SR)) * eRing * 0.24 * (0.4 + 0.6 * c.vel));
        eRing *= kRing;
        eIdx *= kIdx;
        eP2 *= kP2;
      }
    },
  },
  epiano: {
    tail: 0.95,
    fn: (c) => {
      let pc = 0;
      let pm = 0;
      let pt = 0;
      const ph = c.rand.next() * TAU;
      const ring = 1.6 * Math.pow(440 / c.f, 0.35);
      const kRing = Math.exp(-1 / (ring * SR));
      const kIdx = Math.exp(-1 / (0.22 * SR));
      const kTine = Math.exp(-1 / (0.035 * SR));
      const kRel = Math.exp(-1 / (0.16 * SR));
      let eRing = 1;
      let eIdx = 1;
      let eTine = 1;
      let eRel = 1;
      const idx0 = 0.35 + 1.7 * c.vel;
      const lfoStep = (TAU * 4.3) / SR;
      let lp = ph;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        pc += c.f / SR;
        pm += c.f / SR;
        pt += (c.f * 14) / SR;
        const idx = idx0 * (0.22 + 0.78 * eIdx);
        const tine = Math.sin(TAU * pt) * 0.1 * c.vel * eTine;
        const s = Math.sin(TAU * pc + idx * Math.sin(TAU * pm)) + tine;
        if (t > c.dur) eRel *= kRel;
        const y = s * Math.min(1, t / 0.003) * eRing * eRel * 0.25 * (0.35 + 0.65 * c.vel);
        lp += lfoStep;
        const lfo = Math.sin(lp) * 0.25 * c.width;
        spread(c, i, y * (1 - lfo), y * (1 + lfo));
        eRing *= kRing;
        eIdx *= kIdx;
        eTine *= kTine;
      }
    },
  },
  arp: {
    tail: 0.14,
    fn: (c) => {
      const o = new Osc(c.rand.next());
      const f = new Svf(4500, 0.8);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        let s = o.pulse(c.f, c.chip ? 0.25 : 0.3);
        if (!c.chip) {
          if (ctl(i)) f.set(1800 + 4200 * c.vel * Math.exp(-t / 0.12), 0.9);
          s = f.process(s);
        }
        mono(c, i, s * adsr(t, c.dur, 0.003, 0.08, 0.5, 0.1) * (0.1 + 0.14 * c.vel));
      }
    },
  },
  flute: {
    tail: 0.25,
    fn: (c) => {
      const o = new Osc(0);
      const o2 = new Osc(0);
      const n = new Noise(c.rand.int(1, 1e6));
      const bf = new Svf(c.f * 3, 2.5);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        const vib = 1 + 0.006 * Math.min(1, t / 0.3) * Math.sin(TAU * 5.4 * t);
        if (ctl(i)) bf.set(c.f * 3, 2.5);
        bf.process(n.white());
        const s = o.sine(c.f * vib) * 0.8 + o2.triangle(c.f * 2 * vib) * 0.08 + bf.bandpass * 0.2 * (0.5 + 0.5 * Math.min(1, t / 0.06));
        mono(c, i, s * adsr(t, c.dur, 0.07, 0.1, 0.85, 0.2) * (0.14 + 0.16 * c.vel));
      }
    },
  },
  cowbell: {
    // The 808 cowbell: two detuned squares (540 and 800 Hz at its original pitch), a band-pass and a two-stage decay.
    tail: 0.42,
    fn: (c) => {
      const o1 = new Osc(0);
      const o2 = new Osc(0.3);
      const bp = new Svf(c.f * 1.5, 1.6);
      const sat = new Saturator(1.4);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        let s = o1.pulse(c.f, 0.5) * 0.55 + o2.pulse(c.f * 1.4815, 0.5) * 0.55;
        if (ctl(i)) bp.set(c.f * 1.45, 1.6);
        bp.process(s);
        s = bp.bandpass * 0.9 + s * 0.25;
        const e = Math.min(1, t / 0.0006) * (0.65 * Math.exp(-t / 0.045) + 0.35 * Math.exp(-t / 0.2));
        mono(c, i, sat.process(s * 0.9) * e * 0.5 * (0.45 + 0.55 * c.vel));
      }
    },
  },
  bass808: {
    // A sine with a quick pitch drop at the attack, heavy saturation, a long tail, and a slide into the next note.
    tail: 0.45,
    fn: (c) => {
      const sat = new Saturator(2.6);
      const kDecay = Math.exp(-1 / (1.1 * SR));
      const kRel = Math.exp(-1 / (0.11 * SR));
      let ph = 0;
      let eDecay = 1;
      let eRel = 1;
      const hold = c.dur * (1 - c.slide);
      const span = Math.max(0.02, c.dur - hold);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        let f = c.f * (1 + 0.9 * Math.exp(-t / 0.014));
        if (c.f2 > 0 && t > hold) {
          const u = Math.min(1, (t - hold) / span);
          f *= Math.pow(c.f2 / c.f, u * u * (3 - 2 * u));
        }
        ph += f / SR;
        const base = Math.sin(TAU * ph);
        const s = sat.process((base + 0.18 * Math.sin(2 * TAU * ph)) * 1.5);
        if (t > c.dur) eRel *= kRel;
        mono(c, i, s * Math.min(1, t / 0.003) * eDecay * eRel * 0.8 * (0.5 + 0.5 * c.vel));
        eDecay *= kDecay;
      }
    },
  },
  // ── drums: notes carry only a start and a velocity (toms use the note for pitch) ──
  kick: {
    tail: 0.45,
    drum: true,
    fn: (c) => {
      const sat = new Saturator(1.4);
      const n = new Noise(5);
      const hf = new Svf(2500, 0.7);
      let ph = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        const f = 46 + 110 * Math.exp(-t / 0.028);
        ph += f / SR;
        let s = Math.sin(TAU * ph) * Math.exp(-t / 0.085);
        if (ctl(i)) hf.set(2500, 0.7);
        hf.process(n.white());
        s += hf.hp * 0.45 * Math.exp(-t / 0.0022);
        mono(c, i, sat.process(s * 1.1) * 0.85 * c.vel);
      }
    },
  },
  snare: {
    tail: 0.32,
    drum: true,
    fn: (c) => {
      const n = new Noise(c.rand.int(1, 1e6));
      const bp = new Svf(2200, 0.7);
      const hp = new Svf(600, 0.7);
      let p1 = 0;
      let p2 = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        const w = n.white();
        if (ctl(i)) {
          bp.set(2400, 0.7);
          hp.set(900, 0.7);
        }
        bp.process(w);
        hp.process(w);
        p1 += (185 * (1 + 0.25 * Math.exp(-t / 0.012))) / SR;
        p2 += 330 / SR;
        const tone = (Math.sin(TAU * p1) * 0.7 + Math.sin(TAU * p2) * 0.3) * Math.exp(-t / 0.055);
        const noise = (bp.bandpass * 0.9 + hp.hp * 0.45) * Math.exp(-t / 0.085);
        mono(c, i, (tone * 0.6 + noise * 0.7) * 0.55 * c.vel);
      }
    },
  },
  rim: {
    tail: 0.12,
    drum: true,
    fn: (c) => {
      let p1 = 0;
      let p2 = 0;
      const n = new Noise(9);
      const bp = new Svf(3000, 1.2);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        p1 += 420 / SR;
        p2 += 1180 / SR;
        if (ctl(i)) bp.set(3000, 1.2);
        bp.process(n.white());
        mono(c, i, ((Math.sin(TAU * p1) * 0.6 + Math.sin(TAU * p2) * 0.4) * Math.exp(-t / 0.012) + bp.bandpass * 0.5 * Math.exp(-t / 0.004)) * 0.4 * c.vel);
      }
    },
  },
  clap: {
    tail: 0.3,
    drum: true,
    fn: (c) => {
      const n = new Noise(c.rand.int(1, 1e6));
      const bp = new Svf(1300, 1.1);
      const hits = [0, 0.009, 0.018, 0.029];
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        if (ctl(i)) bp.set(1400, 1.1);
        bp.process(n.white());
        let e = 0;
        for (let k = 0; k < hits.length; k++) if (t >= hits[k]!) e += Math.exp(-(t - hits[k]!) / (k === hits.length - 1 ? 0.07 : 0.006)) * (k === hits.length - 1 ? 0.7 : 0.55);
        mono(c, i, bp.bandpass * e * 0.55 * c.vel);
      }
    },
  },
  hat: {
    tail: 0.1,
    drum: true,
    fn: (c) => metalHat(c, 0.03, 0.06),
  },
  openhat: {
    tail: 0.5,
    drum: true,
    fn: (c) => metalHat(c, 0.2, 0.05),
  },
  shaker: {
    tail: 0.14,
    drum: true,
    fn: (c) => {
      const n = new Noise(c.rand.int(1, 1e6));
      const bp = new Svf(6500, 0.8);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        if (ctl(i)) bp.set(6500, 0.8);
        bp.process(n.white());
        mono(c, i, bp.bandpass * Math.min(1, t / 0.012) * Math.exp(-t / 0.035) * 0.3 * c.vel);
      }
    },
  },
  taiko: {
    tail: 0.8,
    drum: true,
    fn: (c) => {
      const n = new Noise(11);
      const bp = new Svf(320, 0.9);
      let ph = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        ph += (58 + 75 * Math.exp(-t / 0.04)) / SR;
        if (ctl(i)) bp.set(320, 0.9);
        bp.process(n.white());
        const s = Math.sin(TAU * ph) * Math.exp(-t / 0.17) + bp.bandpass * 0.35 * Math.exp(-t / 0.05) + Math.sin(TAU * ph * 0.5) * 0.25 * Math.exp(-t / 0.22);
        mono(c, i, s * 0.85 * c.vel);
      }
    },
  },
  tom: {
    tail: 0.6,
    drum: true,
    fn: (c) => {
      const n = new Noise(13);
      const bp = new Svf(c.f * 2, 1);
      let ph = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        ph += (c.f * (1 + 0.6 * Math.exp(-t / 0.035))) / SR;
        if (ctl(i)) bp.set(c.f * 2, 1);
        bp.process(n.white());
        mono(c, i, (Math.sin(TAU * ph) * Math.exp(-t / 0.12) + bp.bandpass * 0.25 * Math.exp(-t / 0.02)) * 0.7 * c.vel);
      }
    },
  },
  riser: {
    // A build: noise through a band-pass sweeping up from 400 Hz to 9 kHz over the note, a faint rising tone, swelling to the end.
    tail: 0.3,
    fn: (c) => {
      const n = new Noise(c.rand.int(1, 1e6));
      const f = new Svf(400, 2);
      const o = new Osc(0);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        const u = Math.min(1, t / Math.max(0.05, c.dur));
        if (ctl(i)) f.set(400 * Math.pow(22.5, u), 2);
        f.process(n.white());
        const env = t <= c.dur ? u * u : Math.exp(-(t - c.dur) / 0.06);
        mono(c, i, (f.bandpass * 0.9 + o.saw(c.f * Math.pow(4, u)) * 0.06) * env * (0.35 + 0.5 * c.vel));
      }
    },
  },
  impact: {
    // A hit that opens a section: a sub drop from 145 to 35 Hz ringing a second, and a dark noise burst.
    tail: 2.2,
    drum: true,
    fn: (c) => {
      const n = new Noise(c.rand.int(1, 1e6));
      const lp = new Svf(2500, 0.8);
      const sat = new Saturator(1.6);
      let ph = 0;
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        ph += (35 + 110 * Math.exp(-t / 0.07)) / SR;
        if (ctl(i)) lp.set(300 + 2200 * Math.exp(-t / 0.15), 0.8);
        const burst = lp.process(n.white()) * Math.exp(-t / 0.12);
        mono(c, i, sat.process(Math.sin(TAU * ph) * Math.exp(-t / 0.9) * 0.9 + burst * 0.4) * Math.min(1, t / 0.001) * c.vel);
      }
    },
  },
  // Parts that only play samples: without one there is nothing to render.
  sample: { tail: 0, fn: () => needsSample('sample') },
  vocal: { tail: 0, fn: () => needsSample('vocal') },
  texture: { tail: 0, fn: () => needsSample('texture') },
  crash: {
    tail: 2.4,
    drum: true,
    fn: (c) => {
      const n = new Noise(c.rand.int(1, 1e6));
      const hp = new Svf(4200, 0.7);
      const metals = CYMBAL.map(() => new Osc(0));
      const mf = new Svf(3500, 0.7);
      for (let i = 0; i < c.len; i++) {
        const t = i / SR;
        if (ctl(i)) {
          hp.set(4200, 0.7);
          mf.set(3500, 0.7);
        }
        hp.process(n.white());
        let m = 0;
        for (let k = 0; k < metals.length; k++) m += metals[k]!.pulse(CYMBAL[k]!, 0.5);
        mf.process(m * 0.12);
        const e = Math.min(1, t / 0.003) * (0.55 * Math.exp(-t / 0.35) + 0.45 * Math.exp(-t / 1.1));
        mono(c, i, (hp.hp * 0.55 + mf.hp * 0.5) * e * 0.35 * c.vel);
      }
    },
  },
};

function needsSample(inst: string): never {
  throw new Error(`A ${inst} track plays a sample: give it one (sample: an id from audio_samples)`);
}

/** The six inharmonic square oscillators of a classic drum machine's hats. */
const HAT_METAL = [263, 400, 421, 474, 587, 845];
const CYMBAL = [300, 460, 520, 640, 830, 1190];

function metalHat(c: Ctx, decay: number, attack: number): void {
  const oscs = HAT_METAL.map((f) => new Osc(c.rand.next()));
  const hp = new Svf(6500, 0.9);
  const lp = new Svf(11500, 0.7);
  const n = new Noise(c.rand.int(1, 1e6));
  for (let i = 0; i < c.len; i++) {
    const t = i / SR;
    let m = 0;
    const scale = 4;
    for (let k = 0; k < oscs.length; k++) m += oscs[k]!.pulse(HAT_METAL[k]! * scale, 0.5);
    if (ctl(i)) hp.set(6500, 0.9);
    hp.process(m * 0.11 + n.white() * 0.5);
    mono(c, i, lp.process(hp.hp) * Math.min(1, t / 0.0008) * Math.exp(-t / decay) * (0.22 + attack) * c.vel);
  }
}

/**
 * Defaults per instrument: reverb send, delay send, low-cut, stereo width, sidechain duck, and `level`: the gain that
 * makes one event at velocity 0.8 on a track of volume 0.8 land at a sensible loudness against the others (calibrated
 * with K-weighted LUFS-M, then bass and kick brought down so the mix keeps its top end: they are loud, dense
 * and low, and left at equal loudness they take 60-80 % of a mix's energy), so
 * a track's volume is only a taste adjustment.
 */
const DEFAULTS: Record<Instrument, { send: number; delay: number; hp: number; width: number; duck: number; level: number }> = {
  lead: { send: 0.18, delay: 0.12, hp: 150, width: 0.4, duck: 0.2, level: 1.0 },
  pluck: { send: 0.25, delay: 0.08, hp: 120, width: 0.3, duck: 0.15, level: 0.385 },
  koto: { send: 0.3, delay: 0.06, hp: 140, width: 0.3, duck: 0, level: 0.38 },
  bass: { send: 0, delay: 0, hp: 0, width: 0, duck: 0.45, level: 0.38 },
  pad: { send: 0.4, delay: 0.05, hp: 180, width: 1, duck: 0.35, level: 0.44 },
  strings: { send: 0.35, delay: 0, hp: 150, width: 0.9, duck: 0.25, level: 0.42 },
  bell: { send: 0.5, delay: 0.18, hp: 300, width: 0.3, duck: 0, level: 0.29 },
  epiano: { send: 0.3, delay: 0.05, hp: 140, width: 0.8, duck: 0.2, level: 0.39 },
  arp: { send: 0.15, delay: 0.25, hp: 200, width: 0.5, duck: 0.15, level: 0.4 },
  flute: { send: 0.35, delay: 0.1, hp: 200, width: 0.3, duck: 0, level: 0.41 },
  kick: { send: 0, delay: 0, hp: 0, width: 0, duck: 0, level: 0.5 },
  snare: { send: 0.22, delay: 0, hp: 120, width: 0, duck: 0, level: 2.4 },
  rim: { send: 0.12, delay: 0, hp: 200, width: 0, duck: 0, level: 2.9 },
  clap: { send: 0.25, delay: 0, hp: 200, width: 0, duck: 0, level: 5.2 },
  hat: { send: 0.05, delay: 0, hp: 400, width: 0, duck: 0, level: 3.5 },
  openhat: { send: 0.08, delay: 0, hp: 400, width: 0, duck: 0, level: 1.2 },
  shaker: { send: 0.05, delay: 0, hp: 500, width: 0, duck: 0, level: 1.15 },
  taiko: { send: 0.2, delay: 0, hp: 0, width: 0, duck: 0, level: 0.6 },
  tom: { send: 0.15, delay: 0, hp: 0, width: 0, duck: 0, level: 0.5 },
  cowbell: { send: 0.14, delay: 0.14, hp: 300, width: 0.4, duck: 0.3, level: 1 },
  bass808: { send: 0, delay: 0, hp: 0, width: 0, duck: 0.7, level: 0.15 },
  crash: { send: 0.3, delay: 0, hp: 300, width: 0, duck: 0, level: 0.77 },
  riser: { send: 0.35, delay: 0.1, hp: 150, width: 0.6, duck: 0, level: 0.45 },
  impact: { send: 0.4, delay: 0, hp: 0, width: 0.3, duck: 0, level: 0.55 },
  // Sample parts are matched in loudness (sampleGain), so their level is 1.
  sample: { send: 0.2, delay: 0.08, hp: 60, width: 0.3, duck: 0.25, level: 1 },
  vocal: { send: 0.3, delay: 0.18, hp: 160, width: 0.3, duck: 0.3, level: 1 },
  texture: { send: 0.15, delay: 0, hp: 120, width: 0.7, duck: 0.15, level: 1 },
};

/** Instruments whose notes carry no pitch (a drum hit rings out; a sample on it is not pitched by its notes). */
const DRUMS = new Set<Instrument>(['kick', 'snare', 'hat', 'clap', 'shaker', 'taiko', 'openhat', 'crash', 'tom', 'rim', 'impact']);

/** The note each instrument is measured at for loudness matching. */
const TYPICAL: Partial<Record<Instrument, number>> = { cowbell: 77, bass808: 41, bass: 36, pad: 60, strings: 60, lead: 72, arp: 72, bell: 84, flute: 79, pluck: 67, koto: 67, epiano: 64, tom: 45 };
const loudnessCache = new Map<Instrument, number>();

/**
 * How loud one note of an instrument is in the mix (LUFS, the loudest 400 ms) at velocity 0.8 and volume 1,
 * with its calibrated level: a sample put on that instrument is matched to it, so swapping a voice for a
 * sample keeps the balance. Sample-only parts follow a voice: a vocal the lead, a texture 8 dB under a pad.
 */
export function voiceLoudness(inst: Instrument): number {
  const known = loudnessCache.get(inst);
  if (known !== undefined) return known;
  let v: number;
  if (inst === 'sample') v = voiceLoudness('pluck');
  else if (inst === 'vocal') v = voiceLoudness('lead');
  else if (inst === 'texture') v = voiceLoudness('pad') - 8;
  else {
    const voice = VOICES[inst];
    const dur = inst === 'pad' || inst === 'strings' ? 2 : voice.drum ? 0.25 : 0.6;
    const len = Math.ceil((dur + voice.tail) * SR);
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    voice.fn({ L, R, start: 0, len, f: voice.drum && inst !== 'tom' ? 440 : midiToHz(TYPICAL[inst] ?? 60), dur, vel: 0.8, gl: 1, gr: 1, width: DEFAULTS[inst].width, rand: new Rng(5), chip: false, f2: 0, slide: 0.5 });
    v = measureLoudness([L, R]).momentaryMax + 20 * Math.log10(DEFAULTS[inst].level);
  }
  loudnessCache.set(inst, v);
  return v;
}

// ─── the mixer ───────────────────────────────────────────────────────────────

/** Voices that make their own stereo image (detuned left and right oscillators, auto-pan). */
const STEREO_VOICES = new Set<Instrument>(['pad', 'strings', 'epiano']);

/**
 * Pseudo-stereo for a mono source that is mono-compatible: the sides get a delayed, high-passed copy of the
 * mid (the side cancels in a mono sum, so nothing combs), scaled by `width`.
 */
function widen(L: Float32Array, R: Float32Array, width: number, delayMs: number): void {
  const d = Math.max(1, Math.round((delayMs / 1000) * SR));
  const side = new Float32Array(L.length);
  for (let i = d; i < L.length; i++) side[i] = (L[i - d]! + R[i - d]!) * 0.5 * width * 0.8;
  Biquad.highpass(350, 0.707).processBuffer(side);
  for (let i = 0; i < L.length; i++) {
    L[i]! += side[i]!;
    R[i]! -= side[i]!;
  }
}

/** Adds the tail room back onto the start: the loop wraps, so tails of the last notes ring into the first. */
function fold(buf: Float32Array, n: number, loopStart = 0): Float32Array {
  const out = buf.slice(0, n);
  const body = n - loopStart;
  for (let i = n; i < buf.length; i++) out[loopStart + ((i - n) % body)]! += buf[i]!;
  return out;
}

/** The sample where the loop starts (after an intro that plays once); 0 for a plain loop. */
export function songLoopStart(spec: SongSpec): number {
  const intro = Math.max(0, Math.min(spec.introBeats ?? 0, spec.beats - 1));
  return Math.round(intro * (60 / spec.bpm) * SR);
}

/** Runs a filter chain over a loop circularly: the end of the loop is its pre-roll, so there is no start-up click at the seam. */
function circular(x: Float32Array, chain: Biquad[]): void {
  const warm = Math.min(x.length, 8192);
  const ext = new Float32Array(warm + x.length);
  ext.set(x.subarray(x.length - warm), 0);
  ext.set(x, warm);
  for (const f of chain) f.processBuffer(ext);
  x.set(ext.subarray(warm));
}

/** Everything under `hz` in mono: the side signal is high-passed. */
function monoBelow(L: Float32Array, R: Float32Array, hz: number): void {
  const side = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) side[i] = (L[i]! - R[i]!) * 0.5;
  circular(side, [Biquad.highpass(hz, 0.707), Biquad.highpass(hz, 0.707)]);
  for (let i = 0; i < L.length; i++) {
    const m = (L[i]! + R[i]!) * 0.5;
    L[i] = m + side[i]!;
    R[i] = m - side[i]!;
  }
}

/** The kick's sidechain: 1 normally, dipping on every kick and recovering (time constant `release`, default 75 ms). */
function duckCurve(kicks: number[], len: number, depth: number, release = 0.075): Float32Array {
  const env = new Float32Array(len).fill(1);
  const rec = Math.round(Math.max(0.35, release * 4.7) * SR);
  for (const k of kicks) {
    for (let j = 0; j < rec && k + j < len; j++) {
      const g = 1 - depth * Math.exp(-j / (release * SR)) * Math.min(1, (j + 1) / 40);
      if (g < env[k + j]!) env[k + j] = g;
    }
  }
  return env;
}

/** A curve's value at a beat: linear between points (on a log scale for frequencies), held before the first and after the last. */
function curveAt(c: Curve, beat: number, log: boolean): number {
  if (beat <= c[0]![0]) return c[0]![1];
  for (let i = 1; i < c.length; i++) {
    const [b1, v1] = c[i]!;
    if (beat <= b1) {
      const [b0, v0] = c[i - 1]!;
      const u = b1 > b0 ? (beat - b0) / (b1 - b0) : 1;
      return log ? Math.exp(Math.log(Math.max(1, v0)) + (Math.log(Math.max(1, v1)) - Math.log(Math.max(1, v0))) * u) : v0 + (v1 - v0) * u;
    }
  }
  return c[c.length - 1]![1];
}

/**
 * Filters and gain moving over a buffer laid out like the song (`n` samples, then room for tails that fold
 * onto the loop): the room past the end follows the curve from the loop's start, where it will sound.
 */
function automate(chs: Float32Array[], a: Automation, spb: number, n: number, loopStart: number, wrap: boolean): void {
  const body = Math.max(1, n - loopStart);
  const beatOf = (i: number): number => {
    const k = wrap && i >= n ? loopStart + ((i - n) % body) : i;
    return k / SR / spb;
  };
  const sorted = (c?: Curve) => (c && c.length ? [...c].sort((p, q) => p[0] - q[0]) : null);
  const lp = sorted(a.lp);
  const hp = sorted(a.hp);
  const gain = sorted(a.gain);
  for (const ch of chs) {
    const fl = new Svf(1000, 0.707);
    const fh = new Svf(100, 0.707);
    for (let i = 0; i < ch.length; i++) {
      if ((i & 31) === 0) {
        const b = beatOf(i);
        if (lp) fl.set(curveAt(lp, b, true), 0.707);
        if (hp) fh.set(curveAt(hp, b, true), 0.707);
      }
      let x = ch[i]!;
      if (lp) x = fl.process(x);
      if (hp) {
        fh.process(x);
        x = fh.hp;
      }
      if (gain) x *= Math.max(0, curveAt(gain, beatOf(i), false));
      ch[i] = x;
    }
  }
}

/** Bit and rate reduction: at 1, 4 bits held for 8 samples. */
function crush(chs: Float32Array[], amount: number): void {
  const a = Math.max(0, Math.min(1, amount));
  const levels = Math.pow(2, 16 - 12 * a) / 2;
  const hold = 1 + Math.round(7 * a);
  for (const ch of chs) {
    let held = 0;
    for (let i = 0; i < ch.length; i++) {
      if (i % hold === 0) held = Math.round(ch[i]! * levels) / levels;
      ch[i] = held;
    }
  }
}

/** Velocity to gain for a sample note: drum hits follow the velocity, melodic parts are gentler; 0.8 is 1. */
const sampleVelocity = (vel: number, drum: boolean): number => (drum ? vel / 0.8 : (0.3 + 0.7 * vel) / 0.86);

/** The interval (-6..+5 semitones) that moves a loop in one key to another tonic. */
const toKey = (from: number, to: number): number => {
  const d = (((to - from) % 12) + 12) % 12;
  return d > 5 ? d - 12 : d;
};

/** A song's key tonic (MIDI) from its key ("F minor", "C#"), or null. */
export function keyTonic(key: string | undefined): number | null {
  const m = key ? /^\s*([A-G])([#b]?)/i.exec(key) : null;
  return m ? midiOf(`${m[1]!.toUpperCase()}${m[2] ?? ''}4`) : null;
}

/** How a sample plays on a track: whether notes pitch it, whether notes cut it, and the release. */
export function samplePlayback(t: Track, s: LoadedSample): { pitched: boolean; gate: boolean; release: number; drum: boolean } {
  const drum = DRUMS.has(t.instrument) || (s.kind === 'oneshot' && /^(kick|snare|clap|hat|openhat|cymbal|perc|tom|drums|fx)$/.test(s.role) && !t.notes.some((n) => n.n !== undefined));
  const pitched = t.pitched ?? (s.kind === 'oneshot' ? s.root !== undefined && !drum : s.kind === 'loop' && s.keyTonic !== undefined);
  const gate = t.gate ?? (s.kind !== 'oneshot' || !drum);
  const release = t.release ?? (s.kind === 'oneshot' ? 0.08 : 0.01);
  return { pitched, gate, release, drum };
}

function renderTracks(spec: SongSpec, seed: number, tailSeconds?: number, samples?: SampleBank): {
  rendered: Array<{ t: Track; d: (typeof DEFAULTS)[Instrument]; L: Float32Array; R: Float32Array }>;
  kicks: number[];
  n: number;
  len: number;
  spb: number;
  amount: number;
  loopStart: number;
} {
  if (!(spec.bpm > 20 && spec.bpm < 300)) throw new Error('bpm must be between 20 and 300');
  const spb = 60 / spec.bpm;
  const seconds = spec.beats * spb;
  if (seconds > 240) throw new Error(`The song is ${Math.round(seconds)} s; keep loops under 240 s`);
  const n = Math.ceil(seconds * SR);
  // Room after the last beat for what rings on: folded onto the start of a loop, kept as the tail of a one-shot.
  const room = tailSeconds !== undefined ? Math.ceil(tailSeconds * SR) : Math.min(n, Math.ceil(3.6 * SR));
  const len = n + room;
  const amount = Math.min(1, Math.max(0, spec.reverb ?? 0.3));
  const introSec = songLoopStart(spec) / SR;
  const bodySec = Math.max(1e-3, seconds - introSec);

  const rendered: Array<{ t: Track; d: (typeof DEFAULTS)[Instrument]; L: Float32Array; R: Float32Array }> = [];
  const kicks: number[] = [];
  const cache = new Map<string, { L: Float32Array; R: Float32Array }>();
  spec.tracks.forEach((track, ti) => {
    const inst = VOICES[track.instrument];
    if (!inst) throw new Error(`Unknown instrument "${track.instrument}" (instruments: ${INSTRUMENTS.join(', ')})`);
    const d = DEFAULTS[track.instrument];
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    if (track.mute) {
      rendered.push({ t: track, d, L, R });
      return;
    }
    let smp: LoadedSample | null = null;
    if (track.sample) {
      smp = samples?.get(track.sample) ?? null;
      if (!smp) throw new Error(`Sample "${track.sample}" is not in the sample library (audio_samples lists what is)`);
    } else if (SAMPLE_ONLY.has(track.instrument)) needsSample(track.instrument);
    const play = smp ? samplePlayback(track, smp) : null;
    // A sample is matched in loudness to the voice it stands in for (DEFAULTS.level is the voices' own calibration).
    const level = smp ? dbToLin(voiceLoudness(track.instrument) - smp.lufs - (smp.kind === 'loop' ? 2 : 0)) : d.level;
    const songTonic = keyTonic(spec.key);
    const loopShift = smp && smp.kind === 'loop' && play!.pitched && smp.keyTonic !== undefined && songTonic !== null ? toKey(smp.keyTonic, songTonic) : 0;
    const vol = track.volume ?? 0.8;
    const pan = Math.max(-1, Math.min(1, track.pan ?? 0));
    const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2 * vol * level;
    const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2 * vol * level;
    const width = track.width ?? d.width;
    const hp = track.hp ?? d.hp;
    track.notes.forEach((ev, ni) => {
      let at = ev.t * spb;
      if (at >= seconds || at < 0) at = introSec + ((((at - introSec) % bodySec) + bodySec) % bodySec); // notes past the end wrap into the loop
      const start = Math.floor(at * SR);
      const dur = Math.max(0.01, Math.round(ev.d * spb * 200) / 200);
      const f = inst.drum && track.instrument !== 'tom' ? 440 : midiToHz(midiOf(ev.n ?? 60));
      const f2 = ev.glide !== undefined ? midiToHz(midiOf(ev.glide)) : 0;
      const vel = Math.max(0, Math.min(1, Math.round((ev.v ?? 0.8) * 10) / 10));
      // A sample note: its pitch against the sample's root (or the loop's key), how long it plays.
      const sn = smp
        ? {
            semis: Math.round(((play!.pitched && smp.kind === 'oneshot' && ev.n !== undefined ? midiOf(ev.n) - (smp.root ?? 60) : 0) + loopShift + (track.tune ?? 0)) * 100) / 100,
            seconds: dur,
            gate: play!.gate,
            release: play!.release,
            reverse: !!track.reverse,
            startSec: track.start ?? 0,
            offsetBeats: ev.o ?? 0,
            songBpm: spec.bpm,
            ...(play!.pitched && smp.kind === 'oneshot' && ev.glide !== undefined ? { glideTo: Math.round((midiOf(ev.glide) - (smp.root ?? 60) + (track.tune ?? 0)) * 100) / 100, slide: track.slide ?? 0.5 } : {}),
          }
        : null;
      const natural = sn ? samplerLength(smp!, sn) : Math.ceil(((inst.drum ? 0 : dur) + inst.tail) * SR);
      const length = Math.min(len - start, natural);
      if (length <= 0) return;
      if (track.instrument === 'kick') kicks.push(start);
      // Repeated notes (a chord every bar, a hat every eighth) are rendered once per dynamic level and a few variants.
      const key = sn
        ? `s|${track.sample}|${sn.semis}|${dur}|${vel}|${width}|${sn.offsetBeats}|${sn.glideTo ?? ''}|${sn.slide ?? ''}`
        : `${track.instrument}|${track.tone ?? ''}|${f.toFixed(2)}|${dur}|${vel}|${width}|${f2.toFixed(1)}|${track.slide ?? ''}|${ni % (inst.drum ? 4 : 2)}`;
      let note = cache.get(key);
      if (!note) {
        // The note's own buffer has room after it for the filters' ringing and the widener's delay.
        const room = Math.ceil(0.03 * SR);
        note = { L: new Float32Array(natural + room), R: new Float32Array(natural + room) };
        if (sn) {
          const s = renderSamplerNote(smp!, sn);
          const g = sampleVelocity(vel, play!.drum);
          for (let i = 0; i < natural; i++) {
            note.L[i] = (s.L[i] ?? 0) * g;
            note.R[i] = (s.R[i] ?? 0) * g;
          }
        } else inst.fn({ L: note.L, R: note.R, start: 0, len: natural, f, dur, vel, gl: 1, gr: 1, width, rand: new Rng(seed * 1009 + ti * 131 + ni + 1), chip: track.tone === 'chip', f2, slide: Math.max(0.05, Math.min(1, track.slide ?? 0.5)) });
        // No voice may end on a step: the last 12 ms of every note fade out.
        const fade = Math.min(natural >> 1, Math.round(0.012 * SR));
        for (let k = 0; k < fade; k++) {
          const g = k / fade;
          note.L[natural - 1 - k]! *= g;
          note.R[natural - 1 - k]! *= g;
        }
        // Low-cut, high-cut and widening are linear: done once per note, not over the whole track.
        if (hp > 0) for (const ch of [note.L, note.R]) Biquad.highpass(hp, 0.707).processBuffer(ch);
        if (track.lp) for (const ch of [note.L, note.R]) Biquad.lowpass(track.lp, 0.707).processBuffer(ch);
        // A stereo sample keeps its own image; a mono one is widened like a mono voice.
        const ownStereo = smp ? smp.channels.length > 1 : STEREO_VOICES.has(track.instrument);
        if (width > 0 && !ownStereo) widen(note.L, note.R, width, 9 + ((ti * 2.7) % 8));
        cache.set(key, note);
      }
      const nl = note.L;
      const nr = note.R;
      const mixLen = Math.min(len - start, nl.length);
      for (let i = 0; i < mixLen; i++) {
        L[start + i]! += nl[i]! * gl;
        R[start + i]! += nr[i]! * gr;
      }
    });
    if (track.drive && track.drive > 0) {
      let peak = 1e-6;
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
      for (const ch of [L, R]) {
        const s = new Saturator(0.6 + 3 * track.drive);
        for (let i = 0; i < len; i++) ch[i] = s.process(ch[i]! / peak) * peak;
      }
    }
    if (track.crush && track.crush > 0) crush([L, R], track.crush);
    if (track.auto) automate([L, R], track.auto, spb, n, songLoopStart(spec), tailSeconds === undefined);
    rendered.push({ t: track, d, L, R });
  });
  return { rendered, kicks, n, len, spb, amount, loopStart: songLoopStart(spec) };
}

/**
 * Tape and vinyl on a mixed loop (before mastering), seamless: wow and flutter as a slowly moving delay whose
 * cycles fit the loop (reads before the loop's start come from its end), hiss and crackle as noise the
 * seam can't be heard in, age as filters run round the loop.
 */
function applyTape(L: Float32Array, R: Float32Array, tape: Tape, loopStart: number, seed: number): void {
  const n = L.length;
  const body = Math.max(1, n - loopStart);
  const bodySec = body / SR;
  const rng = new Rng(seed * 31 + 17);
  let ms = 0;
  for (let i = 0; i < n; i++) ms += L[i]! * L[i]! + R[i]! * R[i]!;
  const rms = Math.sqrt(ms / (2 * n)) || 1e-4;
  const wow = Math.max(0, Math.min(1, tape.wow ?? 0));
  if (wow > 0) {
    const depth = wow * 0.0025 * SR;
    const flutter = wow * 0.00025 * SR;
    const cw = Math.max(1, Math.round(0.6 * bodySec));
    const cf = Math.max(1, Math.round(6 * bodySec));
    for (const ch of [L, R]) {
      const src = ch.slice();
      for (let i = 0; i < n; i++) {
        const u = (i - loopStart) / body;
        const dly = depth * (1 + Math.sin(TAU * cw * u)) + flutter * (1 + Math.sin(TAU * cf * u + 1.3));
        let p = i - dly;
        if (i >= loopStart && p < loopStart) p += body;
        if (p < 0) p = 0;
        const k = Math.floor(p);
        const t = p - k;
        const next = k + 1 >= n ? loopStart : k + 1;
        ch[i] = src[k]! * (1 - t) + src[next]! * t;
      }
    }
  }
  const warmth = Math.max(0, Math.min(1, tape.warmth ?? 0));
  if (warmth > 0) {
    for (const ch of [L, R]) {
      circular(ch, [Biquad.lowpass(16000 - 9000 * warmth, 0.6), Biquad.highpass(25 + 45 * warmth, 0.6)]);
      const s = new Saturator(1 + 2 * warmth);
      let peak = 1e-6;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]!));
      for (let i = 0; i < n; i++) ch[i] = s.process(ch[i]! / peak) * peak;
    }
  }
  const hiss = Math.max(0, Math.min(1, tape.hiss ?? 0));
  if (hiss > 0) {
    const level = rms * dbToLin(-36 + 16 * hiss);
    const nl = new Noise(rng.int(1, 1e6));
    const nr = new Noise(rng.int(1, 1e6));
    const hl = new Float32Array(n);
    const hr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      hl[i] = nl.pink();
      hr[i] = nr.pink();
    }
    for (const h of [hl, hr]) circular(h, [Biquad.highpass(1500, 0.5), Biquad.lowpass(12000, 0.7)]);
    let hms = 0;
    for (let i = 0; i < n; i++) hms += hl[i]! * hl[i]!;
    const g = level / (Math.sqrt(hms / n) || 1);
    for (let i = 0; i < n; i++) {
      L[i]! += hl[i]! * g;
      R[i]! += hr[i]! * g;
    }
  }
  const crackle = Math.max(0, Math.min(1, tape.crackle ?? 0));
  if (crackle > 0) {
    const count = Math.round(bodySec * (2 + 28 * crackle));
    const amp = rms * dbToLin(-4);
    for (let k = 0; k < count; k++) {
      const at = loopStart + Math.floor(rng.next() * body);
      const a = amp * (0.3 + rng.next()) * (rng.chance(0.5) ? 1 : -1);
      const pan = rng.next();
      const decay = 0.0004 + rng.next() * 0.0012;
      for (let j = 0; j < Math.round(decay * 6 * SR); j++) {
        const v = a * Math.exp(-j / (decay * SR)) * (j % 2 ? -0.6 : 1);
        const i = at + j < n ? at + j : loopStart + ((at + j - n) % body);
        L[i]! += v * (1 - 0.5 * pan);
        R[i]! += v * (0.5 + 0.5 * pan);
      }
    }
  }
}

/** One track of a song as it enters the mix: stereo, before the sends and the master. */
export interface Stem {
  instrument: Instrument;
  L: Float32Array;
  R: Float32Array;
}

/** The tracks of a spec rendered separately (tails wrapped onto the start): for balancing and for adaptive layers. */
export function songStems(spec: SongSpec, seed = 7, samples?: SampleBank): Stem[] {
  const { rendered, n, loopStart } = renderTracks(spec, seed, undefined, samples);
  return rendered.map((r) => ({ instrument: r.t.instrument, L: fold(r.L, n, loopStart), R: fold(r.R, n, loopStart) }));
}

/**
 * Renders a song spec to mastered stereo PCM (left, right): a seamless loop at the category's loudness, or
 * with oneShot a phrase that plays once and rings out (a stinger: nothing is folded back onto the start, the
 * tail is kept until it is silent). Tracks that play samples find them in `samples`. `onReport` gets what the
 * mix measures as (music-analysis.ts: parts, low-end clashes, sections, the pump, what to change).
 */
export function renderSong(spec: SongSpec, seed = 7, opts: { category?: AudioCategory; oneShot?: boolean; samples?: SampleBank; onReport?: (r: MixReport) => void } = {}): [Float32Array, Float32Array] {
  const out = renderMix(spec, seed, opts);
  if (opts.onReport && !opts.oneShot) {
    const { rendered, kicks, n, loopStart } = out.parts;
    const parts = rendered.map((r, i) => ({ track: i, name: r.t.name ?? r.t.instrument, instrument: r.t.instrument, duck: r.t.duck ?? r.d.duck, L: fold(r.L, n, loopStart), R: fold(r.R, n, loopStart) }));
    opts.onReport(analyseMix(spec, parts.filter((p) => !spec.tracks[p.track]!.mute), out.audio, kicks));
  }
  return out.audio;
}

function renderMix(spec: SongSpec, seed: number, opts: { category?: AudioCategory; oneShot?: boolean; samples?: SampleBank }): { audio: [Float32Array, Float32Array]; parts: ReturnType<typeof renderTracks> } {
  const parts = renderTracks(spec, seed, opts.oneShot ? 3 : undefined, opts.samples);
  return { audio: mixAndMaster(spec, seed, opts, parts), parts };
}

function mixAndMaster(spec: SongSpec, seed: number, opts: { category?: AudioCategory; oneShot?: boolean }, tracks: ReturnType<typeof renderTracks>): [Float32Array, Float32Array] {
  const { rendered, kicks, n, len, spb, amount, loopStart } = tracks;
  const duckers = rendered.filter((r) => (r.t.duck ?? r.d.duck) > 0);
  if (kicks.length && duckers.length) {
    for (const r of duckers) {
      const env = duckCurve(kicks, len, r.t.duck ?? r.d.duck, Math.max(0.02, Math.min(0.4, spec.duckRelease ?? 0.075)));
      for (let i = 0; i < len; i++) {
        r.L[i]! *= env[i]!;
        r.R[i]! *= env[i]!;
      }
    }
  }

  // 2) the dry mix and the two send buses
  const dryL = new Float32Array(len);
  const dryR = new Float32Array(len);
  const revL = new Float32Array(len);
  const revR = new Float32Array(len);
  const delL = new Float32Array(len);
  const delR = new Float32Array(len);
  const reverbScale = amount / 0.3;
  for (const r of rendered) {
    const send = (r.t.send ?? r.d.send) * reverbScale;
    const del = r.t.delay ?? r.d.delay;
    for (let i = 0; i < len; i++) {
      const l = r.L[i]!;
      const rr = r.R[i]!;
      dryL[i]! += l;
      dryR[i]! += rr;
      if (send > 0) {
        revL[i]! += l * send;
        revR[i]! += rr * send;
      }
      if (del > 0) {
        delL[i]! += l * del;
        delR[i]! += rr * del;
      }
    }
  }
  const [wetL, wetR] = reverbWet(revL, revR, { room: 0.4 + 0.45 * amount, damp: 0.6, size: 0.8 + 0.9 * amount, width: 1, preDelayMs: 16, lowCutHz: 200, highCutHz: 8500 });
  const dt = spec.delayTime ?? {};
  const beatsL = Math.max(0.0625, Math.min(4, dt.left ?? 0.75));
  const beatsR = Math.max(0.0625, Math.min(4, dt.right ?? 1));
  const [echoL, echoR] = delayWet(delL, delR, { timeL: spb * beatsL, timeR: spb * beatsR, feedback: Math.max(0, Math.min(0.9, dt.feedback ?? 0.36)), pingPong: true, highCutHz: 4800, lowCutHz: 250 });
  for (let i = 0; i < len; i++) {
    dryL[i]! += wetL[i]! + echoL[i]!;
    dryR[i]! += wetR[i]! + echoR[i]!;
  }
  if (spec.auto) automate([dryL, dryR], spec.auto, spb, n, loopStart, !opts.oneShot);

  const category = opts.category ?? 'music';
  const tone = Math.max(-1, Math.min(1, spec.tone ?? 0.4));
  const satDrive = 1.5 + 4 * Math.max(0, Math.min(1, spec.drive ?? 0));
  if (opts.oneShot) {
    // The phrase and its tail, cut where it has died away (60 dB under its peak), mastered as a one-shot.
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(dryL[i]!), Math.abs(dryR[i]!));
    let end = len;
    while (end > n && Math.abs(dryL[end - 1]!) < peak * 1e-3 && Math.abs(dryR[end - 1]!) < peak * 1e-3) end--;
    const one: [Float32Array, Float32Array] = [dryL.slice(0, end), dryR.slice(0, end)];
    masterChain(one[0], one[1], tone, satDrive, category, false, spec.loudness, 150);
    return one;
  }

  // 3) back to the loop length: tails wrap onto the start of the loop
  const L = fold(dryL, n, loopStart);
  const R = fold(dryR, n, loopStart);
  if (spec.tape) applyTape(L, R, spec.tape, loopStart, seed);

  if (loopStart > 0) {
    // An intro plays once and the rest loops. Mastering sees the loop as it will play: the intro, then the loop
    // twice and a bit more, processed linearly; the file is the intro and the SECOND pass, so the loop's start
    // and end were both processed in the context of the loop around them.
    const body = n - loopStart;
    const head = Math.min(body, Math.round(0.4 * SR));
    const E = [new Float32Array(loopStart + 2 * body + head), new Float32Array(loopStart + 2 * body + head)];
    [L, R].forEach((src, c) => {
      E[c]!.set(src, 0);
      E[c]!.set(src.subarray(loopStart), n);
      E[c]!.set(src.subarray(loopStart, loopStart + head), n + body);
    });
    masterChain(E[0]!, E[1]!, tone, satDrive, category, false, spec.loudness);
    const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < 2; c++) {
      out[c]!.set(E[c]!.subarray(0, loopStart), 0);
      out[c]!.set(E[c]!.subarray(loopStart + body, loopStart + 2 * body), loopStart);
    }
    return out;
  }
  masterChain(L, R, tone, satDrive, category, true, spec.loudness);
  return [L, R];
}

/** Mono bass, presence and air, glue, saturation and mastering of a stereo mix (a loop: circular; otherwise linear). */
function masterChain(L: Float32Array, R: Float32Array, tone: number, satDrive: number, category: AudioCategory, loop: boolean, targetLufs?: number, fadeOutMs?: number): void {
  const n = L.length;
  if (loop) monoBelow(L, R, 150);
  else {
    const side = new Float32Array(n);
    for (let i = 0; i < n; i++) side[i] = (L[i]! - R[i]!) * 0.5;
    Biquad.highpass(150, 0.707).processBuffer(side);
    Biquad.highpass(150, 0.707).processBuffer(side);
    for (let i = 0; i < n; i++) {
      const m = (L[i]! + R[i]!) * 0.5;
      L[i] = m + side[i]!;
      R[i] = m - side[i]!;
    }
  }
  const eq = (): Biquad[] => [Biquad.lowShelf(110, -3), Biquad.peaking(3200, 0.8, 1.2 + 2.5 * tone), Biquad.highShelf(8500, 1.4 + 3 * tone)];
  for (const ch of [L, R]) {
    if (loop) circular(ch, eq());
    else for (const f of eq()) f.processBuffer(ch);
  }
  let top = 1e-6;
  for (let i = 0; i < n; i++) top = Math.max(top, Math.abs(L[i]!), Math.abs(R[i]!));
  for (let i = 0; i < n; i++) {
    L[i]! /= top;
    R[i]! /= top;
  }
  compress([L, R], { thresholdDb: -14, ratio: 2, attackMs: 25, releaseMs: 180, kneeDb: 8, makeupDb: 2, loop });
  // A little saturation (anti-aliased tanh, relative to the peak) rounds the sharpest peaks, so the limiter
  // has less to do and plucks and drums do not cost the whole mix its loudness.
  for (const ch of [L, R]) {
    const sat = new Saturator(satDrive);
    for (let i = 0; i < n; i++) ch[i] = sat.process(ch[i]!);
  }
  master([L, R], { category, loop, ...(targetLufs !== undefined ? { targetLufs } : {}), ...(fadeOutMs !== undefined ? { fadeOutMs } : {}) });
}
