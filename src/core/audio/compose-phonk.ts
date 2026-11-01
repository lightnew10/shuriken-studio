/**
 * Drift phonk: the 130-150 bpm Memphis-rap descendant built on a TR-808 cowbell riff over a distorted, gliding
 * 808 bass that follows the kick, hard clipped kicks, lo-fi claps and snares on 2 and 4, fast hats with triplet
 * rolls and open-hat accents, and a pump on everything but the kick.
 *
 * Form (bars, by default 4 + 8 + 2 + 8): an INTRO without drums (the cowbell riff, a filtered 808 and a dark pad),
 * the DROP (everything), a short BREAKDOWN (no kick, hats or bass: cowbell, pad and a snare build), then the DROP
 * again with a busier variation. The intro plays once; the loop is the rest, and its last bar fills into the
 * crash that opens the first drop, so it repeats without a seam.
 */
import { Rng } from './dsp/util';
import { midiOf, pitchName, type NoteEvent, type SongSpec, type Track } from './music';

const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Cowbell hit patterns on a 16-step bar (x hit, X accent). */
const RIFF_RHYTHMS = ['X..x..x.x..x.x..', 'X.x..x..X..x..x.', 'X..x.x..x..X..x.', 'X.....x.x.x..x.x', 'x..X..x..x.X.x..', 'X..x..x...x.x.x.'];
/** Kick patterns; the 808 plays on every kick hit. */
const KICKS = ['X.....x...x.....', 'X..x..x...x...x.', 'X.....x..x..x...', 'X..x....X.....x.'];
/** Chord-root progressions (scale degrees, one per bar, four-bar cycles). */
const PROGRESSIONS = [[0, 0, 5, 6], [0, 5, 0, 6], [0, 3, 5, 6], [0, 1, 0, 5]];

interface Plan {
  total: number;
  intro: number;
  dropA: number;
  brk: number;
  dropB: number;
}

function planBars(total: number): Plan {
  const intro = total >= 16 ? 4 : 2;
  const brk = 2;
  const rem = Math.max(4, total - intro - brk);
  const dropA = Math.max(2, 2 * Math.round(rem / 4));
  return { total: intro + dropA + brk + Math.max(2, rem - dropA), intro, dropA, brk, dropB: Math.max(2, rem - dropA) };
}

export interface PhonkOptions {
  key?: string;
  bpm?: number;
  bars?: number;
  seed?: number;
}

export function composePhonk(opts: PhonkOptions = {}): SongSpec {
  const rng = new Rng((opts.seed ?? 11) * 7919 + 77);
  const bpm = opts.bpm ?? 140;
  const root = midiOf(opts.key ?? 'F2');
  const scale = rng.chance(0.55) ? PHRYGIAN : MINOR;
  const note = (d: number, octave = 0): number => root + 12 * (octave + Math.floor(d / 7)) + scale[mod(d, 7)]!;
  const pl = planBars(clamp(opts.bars ?? 22, 8, 64));
  const bars = pl.total;
  const beats = bars * 4;
  const dropAStart = pl.intro;
  const brkStart = pl.intro + pl.dropA;
  const dropBStart = brkStart + pl.brk;
  const sectionOf = (bar: number): 'intro' | 'drop' | 'break' | 'drop2' => (bar < dropAStart ? 'intro' : bar < brkStart ? 'drop' : bar < dropBStart ? 'break' : 'drop2');
  const prog = rng.pick(PROGRESSIONS);
  const rootDeg = (bar: number): number => (bar === bars - 1 ? 0 : prog[bar % prog.length]!);
  const human = (notes: NoteEvent[], ms: number, vel: number): NoteEvent[] => {
    const b = (ms / 1000) * (bpm / 60);
    return notes.map((n) => ({ ...n, t: Math.max(0, Math.round((n.t + (b ? clamp(rng.gauss() * b * 0.5, -b, b) : 0)) * 1000) / 1000), v: Math.round(clamp((n.v ?? 0.8) * (1 + rng.gauss() * vel * 0.5), 0.05, 1) * 100) / 100 }));
  };

  // ── the cowbell riff: two bars, then a variation of it ──
  const riffDegrees = [0, 2, 3, 4, 6, 7];
  const makeRiff = (): Array<{ step: number; deg: number; accent: boolean }> => {
    const hits: Array<{ step: number; deg: number; accent: boolean }> = [];
    let cur = 0;
    for (let b = 0; b < 2; b++) {
      const pat = RIFF_RHYTHMS[rng.int(0, RIFF_RHYTHMS.length - 1)]!;
      for (let s = 0; s < 16; s++) {
        const c = pat[s]!;
        if (c === '.') continue;
        const i = riffDegrees.indexOf(cur);
        cur = riffDegrees[clamp(i + rng.pick([-2, -1, -1, 0, 1, 1, 2]), 0, riffDegrees.length - 1)]!;
        if (s === 0 && b === 0) cur = 0;
        const accent = c === 'X';
        if (accent && rng.chance(0.55)) cur = rng.pick([0, 4, 7]);
        hits.push({ step: b * 16 + s, deg: cur + (rng.chance(0.22) && cur <= 2 ? 7 : 0), accent });
      }
    }
    // the riff turns: its last hit leans up
    hits[hits.length - 1]!.deg = rng.pick([3, 4, 6]);
    return hits;
  };
  const riff = makeRiff();
  const riffVar = riff.map((h, i, a) => (i >= a.length - 3 ? { ...h, deg: h.deg >= 7 ? h.deg - 7 : h.deg <= 2 ? h.deg + 7 : h.deg } : h));
  const cowbell: NoteEvent[] = [];
  for (let b = 0; b < bars; b += 2) {
    const sec = sectionOf(b);
    const pair = Math.floor((b - (sec === 'intro' ? 0 : sec === 'drop' ? dropAStart : sec === 'break' ? brkStart : dropBStart)) / 2);
    const useVar = sec === 'drop2' ? pair % 2 === 1 : sec === 'drop' ? pair % 4 === 3 : false;
    const pat = useVar ? riffVar : riff;
    for (const h of pat) {
      const t = b * 4 + h.step * 0.25;
      if (t >= beats) continue;
      if (sec === 'break' && h.step % 2 === 1) continue; // sparser in the breakdown
      const jump = sec === 'drop2' && h.accent && pair % 2 === 1 ? 7 : 0;
      cowbell.push({ t, d: 0.25, n: note(Math.min(h.deg + jump, 9), 2), v: (h.accent ? 0.95 : 0.7) * (sec === 'intro' ? 0.85 : 1) });
    }
  }

  // ── kick and 808 ──
  const kickPat = rng.pick(KICKS);
  const busy = kickPat.slice(0, 14) + 'x' + kickPat[15];
  const kick: NoteEvent[] = [];
  const bass: NoteEvent[] = [];
  const bassIntro: NoteEvent[] = [];
  const hitsOf = (bar: number): Array<{ t: number; deg: number; v: number }> => {
    const sec = sectionOf(bar);
    if (sec === 'break') return [];
    const pat = sec === 'drop2' ? busy : kickPat;
    const out: Array<{ t: number; deg: number; v: number }> = [];
    for (let s = 0; s < 16; s++) {
      if (pat[s] === '.') continue;
      const strong = s === 0;
      const r = rootDeg(bar);
      let deg = r;
      if (!strong && rng.chance(0.32)) deg = r + rng.pick([2, 4, 6]);
      out.push({ t: bar * 4 + s * 0.25, deg, v: pat[s] === 'X' ? 1 : 0.85 });
    }
    return out;
  };
  const allHits: Array<{ t: number; deg: number; v: number; bar: number }> = [];
  for (let bar = 0; bar < bars; bar++) for (const h of hitsOf(bar)) allHits.push({ ...h, bar });
  allHits.forEach((h, i) => {
    const next = allHits[i + 1];
    const sec = sectionOf(h.bar);
    const gap = next ? next.t - h.t : beats - h.t + (allHits[0]?.t ?? 0);
    const dur = clamp(gap * 0.97, 0.4, 3);
    const sub = (m: number): number => (m > 45 ? m - 12 : m); // the 808 stays in the sub range (44-110 Hz)
    const nextPitch = next ? sub(note(next.deg, -1)) : null;
    const pitch = sub(note(h.deg, -1));
    const slide = nextPitch !== null && nextPitch !== pitch && gap >= 0.5 && rng.chance(sec === 'drop2' ? 0.5 : 0.3);
    const ev: NoteEvent = { t: h.t, d: dur, n: pitch, v: h.v, ...(slide ? { glide: nextPitch! } : {}) };
    if (sec === 'intro') bassIntro.push(ev);
    else {
      bass.push(ev);
      kick.push({ t: h.t, d: 0.25, v: h.v });
    }
  });

  // ── claps and snares on 2 and 4, a ghost rim, hats with triplet rolls, open-hat accents, crashes ──
  const clap: NoteEvent[] = [];
  const snare: NoteEvent[] = [];
  const hat: NoteEvent[] = [];
  const open: NoteEvent[] = [];
  const crash: NoteEvent[] = [];
  const rim: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const sec = sectionOf(bar);
    const b0 = bar * 4;
    const lastOfSection = bar === dropAStart - 1 || bar === brkStart - 1 || bar === dropBStart - 1 || bar === bars - 1;
    const full = sec === 'drop' || sec === 'drop2';
    if (full) {
      for (const beat of [1, 3]) {
        if (lastOfSection && beat === 3) continue; // the fill takes the last beat
        clap.push({ t: b0 + beat, d: 0.25, v: 1 });
        snare.push({ t: b0 + beat, d: 0.25, v: 0.8 });
      }
      if (rng.chance(0.4)) rim.push({ t: b0 + 3.75, d: 0.25, v: 0.5 });
      // hats: eighths, ghost sixteenths, a stutter, a triplet roll at the end of every other bar
      for (let k = 0; k < 8; k++) {
        const t = b0 + k * 0.5;
        if (lastOfSection && t >= b0 + 3) continue;
        hat.push({ t, d: 0.25, v: k % 2 === 0 ? 0.62 : 0.45 });
        if (sec === 'drop2' || rng.chance(0.3)) if (k % 2 === 1 || sec === 'drop2') hat.push({ t: t + 0.25, d: 0.25, v: 0.32 });
      }
      if (rng.chance(0.5)) hat.push({ t: b0 + 2.5 + 0.125, d: 0.25, v: 0.35 }, { t: b0 + 2.5 + 0.25, d: 0.25, v: 0.4 });
      if (bar % 2 === 1 || sec === 'drop2') {
        for (let k = 0; k < 6; k++) hat.push({ t: b0 + 3 + (k * 1) / 6, d: 0.25, v: 0.3 + (0.55 * k) / 5 });
      }
      open.push({ t: b0 + 3.5, d: 0.5, v: 0.8 });
      if (sec === 'drop2') open.push({ t: b0 + 1.5, d: 0.5, v: 0.6 });
    }
    // transitions: a snare build into every section change
    if (lastOfSection) {
      const steps = sec === 'break' ? 16 : 8;
      for (let k = 0; k < steps; k++) {
        const t = b0 + 4 - steps * 0.25 + k * 0.25;
        snare.push({ t, d: 0.25, v: 0.35 + (0.6 * k) / steps });
        if (k >= steps - 4) clap.push({ t, d: 0.25, v: 0.4 + (0.5 * (k - (steps - 4))) / 4 });
      }
    }
    if (bar === dropAStart || bar === dropBStart) crash.push({ t: b0, d: 0.25, v: 0.9 });
  }

  // ── a dark pad under it all, one chord per bar (loud in the breakdown) ──
  const pad: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const r = rootDeg(bar);
    const sec = sectionOf(bar);
    for (const k of [0, 2, 4]) pad.push({ t: bar * 4, d: 3.95, n: note(r + k, 1), v: sec === 'break' ? 0.7 : 0.45 });
  }

  const tracks: Track[] = [];
  tracks.push({ instrument: 'cowbell', name: 'cowbell', volume: 0.66, pan: 0.12, duck: 0.3, notes: human(cowbell, 3, 0.06) });
  if (bassIntro.length) tracks.push({ instrument: 'bass808', name: '808 intro', volume: 0.8, lp: 280, duck: 0, notes: bassIntro });
  tracks.push({ instrument: 'bass808', name: '808', volume: 0.8, drive: 0.3, notes: bass });
  tracks.push({ instrument: 'kick', name: 'kick', volume: 0.29, drive: 1, notes: human(kick, 2, 0.05) });
  tracks.push({ instrument: 'clap', name: 'clap', volume: 0.27, lp: 9500, drive: 0.35, notes: human(clap, 2, 0.06) });
  tracks.push({ instrument: 'snare', name: 'snare', volume: 0.18, lp: 9000, drive: 0.35, notes: human(snare, 2, 0.08) });
  if (rim.length) tracks.push({ instrument: 'rim', name: 'rim', volume: 0.6, notes: human(rim, 3, 0.1) });
  tracks.push({ instrument: 'hat', name: 'hat', volume: 0.6, pan: 0.3, duck: 0.25, notes: human(hat, 3, 0.1) });
  if (open.length) tracks.push({ instrument: 'openhat', name: 'open hat', volume: 0.8, pan: 0.3, duck: 0.25, notes: human(open, 3, 0.08) });
  if (crash.length) tracks.push({ instrument: 'crash', name: 'crash', volume: 0.65, pan: 0.2, notes: crash });
  tracks.push({ instrument: 'pad', name: 'pad', volume: 0.45, pan: 0, duck: 0.6, lp: 2400, notes: pad });

  const sections = [
    { name: 'Intro', bars: pl.intro },
    { name: 'Drop', bars: pl.dropA },
    { name: 'Breakdown', bars: pl.brk },
    { name: 'Drop 2', bars: pl.dropB },
  ];
  const chords = Array.from({ length: bars }, (_, bar) => [0, 2, 4].map((k) => note(rootDeg(bar) + k, 1)));
  return { bpm, beats, tracks, reverb: 0.25, tone: 0.35, drive: 0.7, loudness: -11, sections, introBeats: pl.intro * 4, style: 'phonk', key: `${pitchName(root)} ${scale === PHRYGIAN ? 'phrygian' : 'minor'}`, chords };
}
