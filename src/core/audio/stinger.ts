/**
 * Stingers: the two or three seconds of music that mark a moment (the round is won, lost, about to start, a
 * reward lands). They are written in the key and scale of the game's music (a style and a root, the same
 * two things audio_music takes), with that style's instruments, so a win in a lofi game is an electric
 * piano figure and in an epic one strings and taiko, and neither clashes with the track playing under it.
 * A win resolves on the bright tonic of the scale (the relative major when the music is minor), a loss on
 * the dark one, so both stay inside the music's own notes.
 */
import type { Instrument, NoteEvent, SongSpec, Track } from './music';
import { styleKey, type Style } from './compose';

export const STINGER_MOODS = ['win', 'lose', 'start', 'reward'] as const;
export type StingerMood = (typeof STINGER_MOODS)[number];

export interface StingerOptions {
  style?: Style;
  /** The music's root note ("D", "F#3"): default the style's own. */
  key?: string;
  /** Default: the style's tempo, kept between 96 and 150. */
  bpm?: number;
}

interface Palette {
  melody: Instrument;
  chord: Instrument;
  sparkle: Instrument | null;
  hit: Instrument | null;
  chip?: boolean;
}

const PALETTES: Record<Style, Palette> = {
  lofi: { melody: 'epiano', chord: 'pad', sparkle: 'bell', hit: 'kick' },
  chiptune: { melody: 'lead', chord: 'arp', sparkle: 'pluck', hit: 'kick', chip: true },
  epic: { melody: 'strings', chord: 'strings', sparkle: 'bell', hit: 'taiko' },
  ambient: { melody: 'bell', chord: 'pad', sparkle: 'pluck', hit: null },
  action: { melody: 'lead', chord: 'strings', sparkle: 'pluck', hit: 'taiko' },
  japanese: { melody: 'koto', chord: 'pad', sparkle: 'flute', hit: 'taiko' },
  tropical: { melody: 'pluck', chord: 'epiano', sparkle: 'bell', hit: 'tom' },
  spooky: { melody: 'bell', chord: 'strings', sparkle: 'flute', hit: 'taiko' },
  phonk: { melody: 'cowbell', chord: 'pad', sparkle: 'pluck', hit: 'kick' },
};

/** A short musical phrase for a moment of the game, as a song spec (render it with renderSong one-shot). */
export function composeStinger(mood: StingerMood, opts: StingerOptions = {}): SongSpec {
  const style = opts.style ?? 'epic';
  const pal = PALETTES[style];
  const key = styleKey(style, opts.key);
  const scale = key.scale;
  const len = scale.length;
  const full = len >= 7;
  // The melody sits in the octave around C5, whatever octave the music's root is written in.
  const root = 60 + (((key.root % 12) + 12) % 12);
  const note = (d: number, octave = 0): number => root + 12 * (octave + Math.floor(d / len)) + scale[((d % len) + len) % len]!;
  const minorish = scale.includes(3) && !scale.includes(4);
  // The bright and the dark tonic of the scale: its relative major or minor when it has one.
  const bright = full && minorish ? 2 : 0;
  const dark = full && !minorish ? 5 : 0;
  const triad = (base: number): number[] => (full ? [base, base + 2, base + 4] : [base, base + 2, base + 3]);
  const bpm = Math.round((opts.bpm ?? Math.min(150, Math.max(96, key.bpm))) * (mood === 'lose' ? 0.62 : 1));
  const melody: NoteEvent[] = [];
  const chord: NoteEvent[] = [];
  const sparkle: NoteEvent[] = [];
  const low: NoteEvent[] = [];
  const hits: NoteEvent[] = [];
  const crash: NoteEvent[] = [];
  let beats = 4;

  if (mood === 'win') {
    // Up the bright triad to its octave, then the chord, held.
    const [a, b, c] = triad(bright) as [number, number, number];
    [a, b, c].forEach((d, i) => melody.push({ t: i * 0.5, d: 0.45, n: note(d), v: 0.8 }));
    melody.push({ t: 1.5, d: 0.45, n: note(bright + len), v: 0.9 }, { t: 2, d: 2.5, n: note(bright + len), v: 1 });
    for (const d of [a, b, c]) chord.push({ t: 2, d: 2.6, n: note(d, -1), v: 0.8 });
    chord.push({ t: 2, d: 2.6, n: note(bright + len, -1), v: 0.7 });
    [a, b, c, bright + len, c, bright + len].forEach((d, i) => sparkle.push({ t: 2 + i * 0.25, d: 0.6, n: note(d, 1), v: 0.6 - i * 0.04 }));
    low.push({ t: 2, d: 2.4, n: note(bright, -2), v: 0.9 });
    hits.push({ t: 0, d: 0.5, v: 0.7 }, { t: 2, d: 0.8, v: 1 });
    crash.push({ t: 2, d: 2, v: 0.8 });
    beats = 5;
  } else if (mood === 'lose') {
    // Down the dark triad and under it; the chord arrives late and low.
    const [a, b, c] = triad(dark) as [number, number, number];
    melody.push({ t: 0, d: 0.9, n: note(c), v: 0.75 }, { t: 1, d: 0.9, n: note(b), v: 0.7 }, { t: 2, d: 0.9, n: note(a), v: 0.7 }, { t: 3, d: 2.4, n: note(a, -1), v: 0.7 });
    for (const d of [a, b, c]) chord.push({ t: 3, d: 2.6, n: note(d, -2), v: 0.7 });
    low.push({ t: 3, d: 2.6, n: note(dark, -2), v: 0.9 });
    hits.push({ t: 3, d: 1, v: 0.6 });
    beats = 5.5;
  } else if (mood === 'start') {
    // Two pulses on the fifth, then the tonic: ready, set, go.
    const fifth = full ? 4 : 3;
    melody.push({ t: 0, d: 0.35, n: note(fifth, -1), v: 0.8 }, { t: 1, d: 0.35, n: note(fifth, -1), v: 0.85 }, { t: 2, d: 1.8, n: note(len, -1), v: 1 });
    for (const d of triad(0)) chord.push({ t: 2, d: 1.9, n: note(d, -1), v: 0.8 });
    sparkle.push({ t: 2, d: 0.8, n: note(len), v: 0.6 }, { t: 2.25, d: 0.8, n: note(len + (full ? 4 : 3)), v: 0.5 });
    low.push({ t: 0, d: 0.3, n: note(0, -2), v: 0.8 }, { t: 1, d: 0.3, n: note(0, -2), v: 0.8 }, { t: 2, d: 1.8, n: note(0, -2), v: 1 });
    hits.push({ t: 0, d: 0.4, v: 0.75 }, { t: 1, d: 0.4, v: 0.8 }, { t: 2, d: 0.8, v: 1 });
    crash.push({ t: 2, d: 1.5, v: 0.7 });
    beats = 4;
  } else {
    // reward: a quick run up the bright triad into its octave, light.
    const run = [...triad(bright), bright + len];
    run.forEach((d, i) => melody.push({ t: i * 0.25, d: i === run.length - 1 ? 1.4 : 0.3, n: note(d), v: 0.7 + i * 0.08 }));
    run.forEach((d, i) => sparkle.push({ t: 0.125 + i * 0.25, d: 0.5, n: note(d, 1), v: 0.5 }));
    for (const d of triad(bright)) chord.push({ t: 0.75, d: 1.4, n: note(d, -1), v: 0.6 });
    beats = 2.5;
  }

  const tracks: Track[] = [{ instrument: pal.melody, volume: 0.9, notes: melody, ...(pal.chip ? { tone: 'chip' as const } : {}) }];
  if (chord.length) tracks.push({ instrument: pal.chord, volume: 0.7, notes: chord });
  if (pal.sparkle && sparkle.length) tracks.push({ instrument: pal.sparkle, volume: 0.6, notes: sparkle, pan: 0.25 });
  if (low.length) tracks.push({ instrument: 'bass', volume: 0.8, notes: low });
  if (pal.hit && hits.length) tracks.push({ instrument: pal.hit, volume: 0.85, notes: hits });
  if (crash.length && style !== 'lofi' && style !== 'ambient') tracks.push({ instrument: 'crash', volume: 0.5, notes: crash });
  return { bpm, beats, tracks, reverb: 0.4, tone: 0.4 };
}
