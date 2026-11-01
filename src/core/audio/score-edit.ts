/**
 * Editing a song's score instead of composing a new one: the craft the copilot asked for ("every change means a
 * whole new song from a seed: luck, not craft"). A score (SongSpec, saved next to the MP3 as <name>.song.json)
 * is changed by a list of operations and rendered again with the same seed, so everything not touched sounds the
 * same: set a part's sound, sample or mix; clear, thin, rewrite, transpose or re-voice its notes in some bars or
 * a section; add a part from the song's chords or a rhythm; copy, insert and delete bars; risers and impacts;
 * the song's tempo, sections, delay, pump, tape and filter sweeps. Bars count from 1; ranges include both ends.
 */
import { INSTRUMENTS, midiOf, type Automation, type Instrument, type NoteEvent, type SongSpec, type Tape, type Track } from './music';

export type TrackRef = number | string;

/** Bars (1-based, both ends included) or a section by name; neither means the whole song. */
export interface Span {
  bars?: [number, number];
  section?: string;
}

export interface TrackProps {
  instrument?: Instrument;
  name?: string;
  sample?: string | null;
  volume?: number;
  pan?: number;
  send?: number;
  delay?: number;
  hp?: number;
  lp?: number | null;
  width?: number;
  duck?: number;
  drive?: number;
  crush?: number;
  slide?: number;
  pitched?: boolean;
  tune?: number;
  gate?: boolean;
  release?: number;
  reverse?: boolean;
  start?: number;
  mute?: boolean;
  auto?: Automation | null;
  tone?: 'chip' | null;
}

export type NoteInput = { t: number; d: number; n?: string | number; v?: number; o?: number; glide?: string | number } | [number, number, (string | number)?, number?];

export type EditOp =
  | ({ op: 'set'; track: TrackRef } & TrackProps)
  | ({ op: 'clear'; track: TrackRef | 'all' } & Span)
  | ({ op: 'thin'; track: TrackRef | 'all'; keep: 'downbeats' | 'beats' | 'offbeats' | 'every2' | 'accents' } & Span)
  | ({ op: 'notes'; track: TrackRef; notes: NoteInput[]; every?: number } & Span)
  | ({ op: 'transpose'; track: TrackRef; semitones: number } & Span)
  | ({ op: 'velocity'; track: TrackRef | 'all'; scale: number } & Span)
  | ({ op: 'add'; instrument: Instrument; pattern?: Pattern; rhythm?: string; octave?: number; notes?: NoteInput[]; every?: number } & TrackProps & Span)
  | { op: 'remove'; track: TrackRef }
  | { op: 'copy'; from: [number, number]; to: number; tracks?: TrackRef[] }
  | { op: 'insert'; at: number; bars: number; copy?: [number, number] }
  | { op: 'delete'; bars: [number, number] }
  | { op: 'sections'; sections: Array<{ name: string; bars: number }> }
  | { op: 'song'; bpm?: number; reverb?: number; tone?: number; drive?: number; loudness?: number | null; key?: string; delay?: { left?: number; right?: number; feedback?: number }; duckRelease?: number; tape?: Tape | null; auto?: Automation | null; introBars?: number }
  | { op: 'riser'; at: number; bars?: number; volume?: number }
  | { op: 'impact'; at: number; volume?: number };

export const PATTERNS = ['chords', 'stabs', 'arp', 'bass', 'drone', 'hits', 'bed', 'chops'] as const;
export type Pattern = (typeof PATTERNS)[number];

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export class EditError extends Error {}

/** The bar count of a song. */
export const barsOf = (spec: SongSpec): number => Math.round(spec.beats / 4);

/** Sections with their first and last bar (1-based). */
export function sectionBars(spec: SongSpec): Array<{ name: string; from: number; to: number }> {
  const out: Array<{ name: string; from: number; to: number }> = [];
  let at = 1;
  for (const s of spec.sections ?? []) {
    out.push({ name: s.name, from: at, to: at + s.bars - 1 });
    at += s.bars;
  }
  return out;
}

/** A span as beats [from, to). */
export function spanBeats(spec: SongSpec, s: Span): [number, number] {
  const bars = barsOf(spec);
  if (s.section) {
    const want = s.section.trim().toLowerCase();
    const sec = sectionBars(spec).find((x) => x.name.toLowerCase() === want) ?? sectionBars(spec).find((x) => x.name.toLowerCase().startsWith(want));
    if (!sec) throw new EditError(`No section "${s.section}" (sections: ${sectionBars(spec).map((x) => `${x.name} ${x.from}-${x.to}`).join(', ') || 'none'})`);
    return [(sec.from - 1) * 4, sec.to * 4];
  }
  if (s.bars) {
    const [a, b] = s.bars;
    if (!(a >= 1 && b >= a && b <= bars)) throw new EditError(`bars [${a}, ${b}] is outside the song (bars 1-${bars}, both ends included)`);
    return [(a - 1) * 4, b * 4];
  }
  return [0, spec.beats];
}

/** Finds a track: its index, its name, or its instrument (the first of that instrument). */
export function findTrack(spec: SongSpec, ref: TrackRef): number {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 0 || ref >= spec.tracks.length) throw new EditError(`No track ${ref} (tracks 0-${spec.tracks.length - 1})`);
    return ref;
  }
  const want = ref.trim().toLowerCase();
  // A name first ("808" is a part, not track 808), then the instrument, the sample, a number written as text.
  let i = spec.tracks.findIndex((t) => (t.name ?? '').toLowerCase() === want);
  if (i < 0) i = spec.tracks.findIndex((t) => t.instrument === want);
  if (i < 0) i = spec.tracks.findIndex((t) => t.sample === want);
  if (i < 0 && /^\d+$/.test(want) && Number(want) < spec.tracks.length) i = Number(want);
  if (i < 0) throw new EditError(`No track "${ref}" (tracks: ${spec.tracks.map((t, k) => `${k} ${t.name ?? t.instrument}`).join(', ')})`);
  return i;
}

const tracksOf = (spec: SongSpec, ref: TrackRef | 'all'): number[] => (ref === 'all' ? spec.tracks.map((_, i) => i) : [findTrack(spec, ref)]);

function toNote(x: NoteInput, offset: number): NoteEvent {
  const o = Array.isArray(x) ? { t: x[0], d: x[1], n: x[2], v: x[3] } : x;
  if (!(Number.isFinite(o.t) && o.t >= 0 && Number.isFinite(o.d) && o.d > 0)) throw new EditError(`A note needs t >= 0 and d > 0 (beats): ${JSON.stringify(x)}`);
  if (o.n !== undefined && o.n !== null) midiOf(o.n as string | number);
  if ((o as { glide?: string | number }).glide !== undefined) midiOf((o as { glide: string | number }).glide);
  const ev: NoteEvent = { t: r3(offset + o.t), d: r3(o.d) };
  if (o.n !== undefined && o.n !== null) ev.n = o.n;
  if (o.v !== undefined) ev.v = Math.max(0, Math.min(1, o.v));
  if ((o as { o?: number }).o !== undefined) ev.o = (o as { o: number }).o;
  if ((o as { glide?: string | number }).glide !== undefined) ev.glide = (o as { glide: string | number }).glide;
  return ev;
}

/** Sets a track's properties (null removes one). */
function applyProps(t: Track, p: TrackProps): string[] {
  const changed: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || ['op', 'track', 'bars', 'section', 'pattern', 'rhythm', 'octave', 'notes', 'every'].includes(k)) continue;
    if (k === 'instrument' && !INSTRUMENTS.includes(v as Instrument)) throw new EditError(`Unknown instrument "${String(v)}" (instruments: ${INSTRUMENTS.join(', ')})`);
    if (v === null) delete (t as unknown as Record<string, unknown>)[k];
    else (t as unknown as Record<string, unknown>)[k] = v;
    changed.push(`${k} ${v === null ? 'removed' : JSON.stringify(v)}`);
  }
  return changed;
}

/** A rhythm string ("x..x..x." per bar: x a hit, X an accent, o a ghost, . nothing) as [beat, velocity] per bar. */
function rhythm(r: string): Array<[number, number]> {
  const steps = r.replace(/\s|\|/g, '');
  if (!/^[xXo.\-_]+$/.test(steps) || !steps.length) throw new EditError(`rhythm "${r}": use x (hit), X (accent), o (ghost) and . (rest), e.g. "x...x...x...x..."`);
  const step = 4 / steps.length;
  const out: Array<[number, number]> = [];
  [...steps].forEach((c, i) => {
    if (c === 'x') out.push([i * step, 0.8]);
    else if (c === 'X') out.push([i * step, 1]);
    else if (c === 'o') out.push([i * step, 0.45]);
  });
  return out;
}

/** Notes for a new part from the song's chords (one voicing per bar) or a rhythm. */
function patternNotes(spec: SongSpec, p: Pattern, from: number, to: number, o: { rhythm?: string; octave?: number }): NoteEvent[] {
  const oct = 12 * (o.octave ?? 0);
  const chordAt = (beat: number): number[] => {
    const c = spec.chords?.[Math.floor(beat / 4)];
    if (!c || !c.length) throw new EditError(`Pattern "${p}" follows the song's chords and this score has none (composed before 1.14?): give notes instead`);
    return c;
  };
  const out: NoteEvent[] = [];
  const bars: number[] = [];
  for (let b = Math.floor(from / 4); b * 4 < to; b++) bars.push(b);
  const hits = (fallback: string) => rhythm(o.rhythm ?? fallback);
  switch (p) {
    case 'chords':
      for (const b of bars) for (const m of chordAt(b * 4)) out.push({ t: b * 4, d: 3.95, n: m + oct, v: 0.6 });
      break;
    case 'stabs':
      for (const b of bars) {
        const hs = hits('x.....x.....x...');
        hs.forEach(([t, v], i) => {
          const next = hs[i + 1]?.[0] ?? 4;
          for (const m of chordAt(b * 4)) out.push({ t: b * 4 + t, d: r3(Math.min(0.75, (next - t) * 0.9)), n: m + oct, v });
        });
      }
      break;
    case 'arp':
      for (const b of bars) {
        const c = chordAt(b * 4);
        const seq = [...c, c[0]! + 12];
        hits('x.x.x.x.x.x.x.x.').forEach(([t, v], i) => out.push({ t: b * 4 + t, d: 0.45, n: seq[i % seq.length]! + oct, v: v * 0.85 }));
      }
      break;
    case 'bass':
      for (const b of bars) {
        const root = Math.min(...chordAt(b * 4));
        const hs = hits('x.......x.......');
        hs.forEach(([t, v], i) => {
          const next = hs[i + 1]?.[0] ?? 4;
          out.push({ t: b * 4 + t, d: r3((next - t) * 0.95), n: root - 12 + oct, v });
        });
      }
      break;
    case 'drone': {
      const root = Math.min(...chordAt(from));
      out.push({ t: from, d: r3(to - from - 0.05), n: root - 12 + oct, v: 0.7 });
      break;
    }
    case 'hits':
      for (const b of bars) for (const [t, v] of hits('x...x...x...x...')) out.push({ t: b * 4 + t, d: 0.25, v });
      break;
    case 'bed':
      out.push({ t: from, d: r3(to - from), v: 0.8, o: 0 });
      break;
    case 'chops':
      // Each hit plays the bed from where the song is, so the chops keep the loop's own line, gated to the rhythm.
      for (const b of bars) {
        const hs = hits('x.x...x.x.x...x.');
        hs.forEach(([t, v], i) => {
          const next = hs[i + 1]?.[0] ?? 4;
          out.push({ t: b * 4 + t, d: r3(Math.min(1, next - t) * 0.9), v, o: r3(b * 4 + t - from) });
        });
      }
      break;
  }
  return out.filter((n) => n.t >= from && n.t < to);
}

const inSpan = (n: NoteEvent, a: number, b: number) => n.t >= a - 1e-6 && n.t < b - 1e-6;

/** Shifts every time in the song at or after `at` (beats) by `by`, notes, curves and chords alike. */
function shiftFrom(spec: SongSpec, at: number, by: number): void {
  for (const t of spec.tracks) {
    for (const n of t.notes) if (n.t >= at - 1e-6) n.t = r3(n.t + by);
    if (t.auto) for (const c of Object.values(t.auto) as Array<Array<[number, number]> | undefined>) if (c) for (const p of c) if (p[0] >= at) p[0] = r3(p[0] + by);
  }
  if (spec.auto) for (const c of Object.values(spec.auto) as Array<Array<[number, number]> | undefined>) if (c) for (const p of c) if (p[0] >= at) p[0] = r3(p[0] + by);
}

/** Applies the operations in order to a copy of the score; returns it and one line per change. */
export function editScore(input: SongSpec, ops: EditOp[]): { spec: SongSpec; changes: string[] } {
  const spec = clone(input);
  const changes: string[] = [];
  ops.forEach((op, k) => {
    const where = (s: Span) => (s.section ? `section ${s.section}` : s.bars ? `bars ${s.bars[0]}-${s.bars[1]}` : 'the whole song');
    const label = (i: number) => `${i} ${spec.tracks[i]!.name ?? spec.tracks[i]!.instrument}`;
    try {
      switch (op.op) {
        case 'set': {
          const i = findTrack(spec, op.track);
          const c = applyProps(spec.tracks[i]!, op);
          changes.push(`track ${label(i)}: ${c.join(', ') || 'nothing to change'}`);
          break;
        }
        case 'clear': {
          const [a, b] = spanBeats(spec, op);
          let n = 0;
          for (const i of tracksOf(spec, op.track)) {
            const t = spec.tracks[i]!;
            const before = t.notes.length;
            t.notes = t.notes.filter((x) => !inSpan(x, a, b));
            n += before - t.notes.length;
          }
          changes.push(`cleared ${n} notes of ${op.track === 'all' ? 'every track' : label(findTrack(spec, op.track))} in ${where(op)}`);
          break;
        }
        case 'thin': {
          const [a, b] = spanBeats(spec, op);
          const keep: Record<typeof op.keep, (x: NoteEvent, i: number) => boolean> = {
            downbeats: (x) => Math.abs(x.t / 4 - Math.round(x.t / 4)) < 0.02,
            beats: (x) => Math.abs(x.t - Math.round(x.t)) < 0.06,
            offbeats: (x) => Math.abs(x.t - Math.floor(x.t) - 0.5) < 0.06,
            every2: (_, i) => i % 2 === 0,
            accents: (x) => (x.v ?? 0.8) >= 0.85,
          };
          let n = 0;
          for (const i of tracksOf(spec, op.track)) {
            const t = spec.tracks[i]!;
            const inside = t.notes.filter((x) => inSpan(x, a, b)).sort((p, q) => p.t - q.t);
            const kept = new Set(inside.filter((x, j) => keep[op.keep](x, j)));
            const before = t.notes.length;
            t.notes = t.notes.filter((x) => !inSpan(x, a, b) || kept.has(x));
            n += before - t.notes.length;
          }
          changes.push(`thinned ${op.track === 'all' ? 'every track' : label(findTrack(spec, op.track))} to ${op.keep} in ${where(op)} (${n} notes out)`);
          break;
        }
        case 'notes': {
          const i = findTrack(spec, op.track);
          const [a, b] = spanBeats(spec, op);
          const t = spec.tracks[i]!;
          const every = op.every ? op.every * 4 : b - a;
          const fresh: NoteEvent[] = [];
          for (let s = a; s < b - 1e-6; s += every) for (const x of op.notes) {
            const ev = toNote(x, s);
            if (ev.t < Math.min(b, s + every) - 1e-6) fresh.push(ev);
          }
          t.notes = [...t.notes.filter((x) => !inSpan(x, a, b)), ...fresh].sort((p, q) => p.t - q.t);
          changes.push(`track ${label(i)}: ${fresh.length} notes written in ${where(op)}${op.every ? ` (a ${op.every}-bar pattern repeated)` : ''}`);
          break;
        }
        case 'transpose': {
          const i = findTrack(spec, op.track);
          const [a, b] = spanBeats(spec, op);
          let n = 0;
          for (const x of spec.tracks[i]!.notes)
            if (inSpan(x, a, b) && x.n !== undefined) {
              x.n = midiOf(x.n) + op.semitones;
              if (x.glide !== undefined) x.glide = midiOf(x.glide) + op.semitones;
              n++;
            }
          changes.push(`track ${label(i)}: ${n} notes moved ${op.semitones > 0 ? '+' : ''}${op.semitones} semitones in ${where(op)}`);
          break;
        }
        case 'velocity': {
          const [a, b] = spanBeats(spec, op);
          for (const i of tracksOf(spec, op.track)) for (const x of spec.tracks[i]!.notes) if (inSpan(x, a, b)) x.v = Math.round(Math.max(0.05, Math.min(1, (x.v ?? 0.8) * op.scale)) * 100) / 100;
          changes.push(`velocity x${op.scale} on ${op.track === 'all' ? 'every track' : label(findTrack(spec, op.track))} in ${where(op)}`);
          break;
        }
        case 'add': {
          if (!INSTRUMENTS.includes(op.instrument)) throw new EditError(`Unknown instrument "${op.instrument}" (instruments: ${INSTRUMENTS.join(', ')})`);
          const [a, b] = spanBeats(spec, op);
          let notes: NoteEvent[] = [];
          if (op.notes?.length) {
            const every = op.every ? op.every * 4 : b - a;
            for (let s = a; s < b - 1e-6; s += every) for (const x of op.notes) {
              const ev = toNote(x, s);
              if (ev.t < Math.min(b, s + every) - 1e-6) notes.push(ev);
            }
          } else if (op.pattern) notes = patternNotes(spec, op.pattern, a, b, op);
          else throw new EditError('add needs notes or a pattern');
          const t: Track = { instrument: op.instrument, notes };
          applyProps(t, { ...op, instrument: undefined });
          spec.tracks.push(t);
          changes.push(`added track ${label(spec.tracks.length - 1)}${t.sample ? ` (sample ${t.sample})` : ''}: ${notes.length} notes in ${where(op)}`);
          break;
        }
        case 'remove': {
          const i = findTrack(spec, op.track);
          const was = label(i);
          spec.tracks.splice(i, 1);
          changes.push(`removed track ${was} (the tracks after it moved up one)`);
          break;
        }
        case 'copy': {
          const [a, b] = spanBeats(spec, { bars: op.from });
          const len = b - a;
          const dest = (op.to - 1) * 4;
          if (!(op.to >= 1 && dest + len <= spec.beats)) throw new EditError(`copy to bar ${op.to} runs past the song's end (bar ${barsOf(spec)})`);
          const which = op.tracks?.length ? op.tracks.map((r) => findTrack(spec, r)) : spec.tracks.map((_, i) => i);
          for (const i of which) {
            const t = spec.tracks[i]!;
            const copied = t.notes.filter((x) => inSpan(x, a, b)).map((x) => ({ ...x, t: r3(x.t - a + dest) }));
            t.notes = [...t.notes.filter((x) => !inSpan(x, dest, dest + len)), ...copied].sort((p, q) => p.t - q.t);
          }
          if (spec.chords) for (let k2 = 0; k2 < len / 4; k2++) if (spec.chords[a / 4 + k2]) spec.chords[dest / 4 + k2] = [...spec.chords[a / 4 + k2]!];
          changes.push(`copied bars ${op.from[0]}-${op.from[1]} onto bars ${op.to}-${op.to + len / 4 - 1}${op.tracks?.length ? ` (${which.map(label).join(', ')})` : ''}`);
          break;
        }
        case 'insert': {
          if (!(Number.isInteger(op.bars) && op.bars >= 1 && op.bars <= 32)) throw new EditError('insert takes 1-32 bars');
          const bars = barsOf(spec);
          if (!(op.at >= 1 && op.at <= bars + 1)) throw new EditError(`insert at bar 1-${bars + 1}`);
          const at = (op.at - 1) * 4;
          const by = op.bars * 4;
          const source = op.copy ? spanBeats(spec, { bars: op.copy }) : null;
          const copied = source ? spec.tracks.map((t) => t.notes.filter((x) => inSpan(x, source[0], source[1]))) : null;
          shiftFrom(spec, at, by);
          spec.beats += by;
          if (spec.introBeats && at < spec.introBeats) spec.introBeats += by;
          if (copied && source) {
            const len = source[1] - source[0];
            spec.tracks.forEach((t, i) => {
              for (let s = 0; s < by; s += len) for (const x of copied[i]!) if (x.t - source[0] + s < by) t.notes.push({ ...x, t: r3(x.t - source[0] + s + at) });
              t.notes.sort((p, q) => p.t - q.t);
            });
          }
          if (spec.chords) {
            const fill = source ? Array.from({ length: op.bars }, (_, k2) => spec.chords![source[0] / 4 + (k2 % ((source[1] - source[0]) / 4))] ?? []) : Array.from({ length: op.bars }, () => spec.chords![Math.max(0, op.at - 2)] ?? []);
            spec.chords.splice(op.at - 1, 0, ...fill.map((c) => [...c]));
          }
          growSection(spec, op.at, op.bars);
          changes.push(`inserted ${op.bars} bars before bar ${op.at}${op.copy ? ` (a copy of bars ${op.copy[0]}-${op.copy[1]})` : ' (empty)'}: the song is ${barsOf(spec)} bars`);
          break;
        }
        case 'delete': {
          const [a, b] = spanBeats(spec, { bars: op.bars });
          if (b - a >= spec.beats) throw new EditError('delete would leave no song');
          for (const t of spec.tracks) t.notes = t.notes.filter((x) => !inSpan(x, a, b));
          shiftFrom(spec, b, -(b - a));
          spec.beats -= b - a;
          if (spec.introBeats) spec.introBeats = Math.max(0, spec.introBeats - Math.max(0, Math.min(b, spec.introBeats) - a));
          if (spec.chords) spec.chords.splice(op.bars[0] - 1, op.bars[1] - op.bars[0] + 1);
          shrinkSections(spec, op.bars[0], op.bars[1] - op.bars[0] + 1);
          changes.push(`deleted bars ${op.bars[0]}-${op.bars[1]}: the song is ${barsOf(spec)} bars`);
          break;
        }
        case 'sections': {
          const total = op.sections.reduce((s, x) => s + x.bars, 0);
          if (total !== barsOf(spec)) throw new EditError(`the sections add up to ${total} bars; the song has ${barsOf(spec)}`);
          if (op.sections.some((s) => !(Number.isInteger(s.bars) && s.bars >= 1) || !s.name.trim())) throw new EditError('every section needs a name and at least 1 bar');
          spec.sections = op.sections.map((s) => ({ name: s.name.trim(), bars: s.bars }));
          changes.push(`sections: ${sectionBars(spec).map((s) => `${s.name} ${s.from}-${s.to}`).join(', ')}`);
          break;
        }
        case 'song': {
          const c: string[] = [];
          if (op.bpm !== undefined) {
            if (!(op.bpm >= 50 && op.bpm <= 200)) throw new EditError('bpm must be 50-200');
            spec.bpm = op.bpm;
            c.push(`bpm ${op.bpm}`);
          }
          for (const k2 of ['reverb', 'tone', 'drive', 'duckRelease'] as const)
            if (op[k2] !== undefined) {
              spec[k2] = op[k2];
              c.push(`${k2} ${op[k2]}`);
            }
          if (op.loudness !== undefined) {
            if (op.loudness === null) delete spec.loudness;
            else spec.loudness = Math.max(-24, Math.min(-8, op.loudness));
            c.push(`loudness ${op.loudness ?? 'the category default'}`);
          }
          if (op.key !== undefined) {
            spec.key = op.key;
            c.push(`key ${op.key} (only loops in a key follow it: notes are not moved; transpose them)`);
          }
          if (op.delay) {
            spec.delayTime = { ...spec.delayTime, ...op.delay };
            c.push(`delay ${JSON.stringify(spec.delayTime)}`);
          }
          if (op.tape !== undefined) {
            if (op.tape === null) delete spec.tape;
            else spec.tape = { ...spec.tape, ...op.tape };
            c.push(`tape ${JSON.stringify(spec.tape ?? 'off')}`);
          }
          if (op.auto !== undefined) {
            if (op.auto === null) delete spec.auto;
            else spec.auto = op.auto;
            c.push(`mix automation ${op.auto ? Object.keys(op.auto).join(', ') : 'off'}`);
          }
          if (op.introBars !== undefined) {
            if (!(op.introBars >= 0 && op.introBars < barsOf(spec))) throw new EditError(`introBars must be 0-${barsOf(spec) - 1}`);
            spec.introBeats = op.introBars * 4;
            c.push(`intro ${op.introBars} bars (played once; the loop starts after it)`);
          }
          changes.push(`song: ${c.join(', ') || 'nothing to change'}`);
          break;
        }
        case 'riser': {
          const len = (op.bars ?? 2) * 4;
          const end = (op.at - 1) * 4;
          if (!(end - len >= 0 && end <= spec.beats)) throw new EditError(`a ${op.bars ?? 2}-bar riser into bar ${op.at} starts before the song`);
          let i = spec.tracks.findIndex((t) => t.instrument === 'riser');
          if (i < 0) i = spec.tracks.push({ instrument: 'riser', name: 'riser', volume: op.volume ?? 0.7, notes: [] }) - 1;
          spec.tracks[i]!.notes.push({ t: end - len, d: len, n: 'C4', v: 0.9 });
          changes.push(`riser over bars ${op.at - (op.bars ?? 2)}-${op.at - 1}, into bar ${op.at}`);
          break;
        }
        case 'impact': {
          const at = (op.at - 1) * 4;
          if (!(at >= 0 && at < spec.beats)) throw new EditError(`impact at bar 1-${barsOf(spec)}`);
          let i = spec.tracks.findIndex((t) => t.instrument === 'impact');
          if (i < 0) i = spec.tracks.push({ instrument: 'impact', name: 'impact', volume: op.volume ?? 0.8, notes: [] }) - 1;
          spec.tracks[i]!.notes.push({ t: at, d: 1, v: 1 });
          changes.push(`impact on bar ${op.at}`);
          break;
        }
        default:
          throw new EditError(`Unknown op "${(op as { op: string }).op}"`);
      }
    } catch (e) {
      if (e instanceof EditError) throw new EditError(`ops[${k}] (${op.op}): ${e.message}`);
      throw new EditError(`ops[${k}] (${op.op}): ${(e as Error).message}`);
    }
  });
  // Notes keep their order (a voice's random detail follows a note's place in its track): only edited parts were re-sorted.
  return { spec, changes };
}

/** Inserting bars before `at` grows the section that bar is in (or the last one). */
function growSection(spec: SongSpec, at: number, bars: number): void {
  if (!spec.sections?.length) return;
  const secs = sectionBars(spec);
  const i = Math.max(0, secs.findIndex((s) => at >= s.from && at <= s.to + (s === secs[secs.length - 1] ? 1 : 0)));
  spec.sections[i] = { ...spec.sections[i]!, bars: spec.sections[i]!.bars + bars };
}

/** Deleting bars shrinks the sections they were in (a section left empty goes). */
function shrinkSections(spec: SongSpec, from: number, count: number): void {
  if (!spec.sections?.length) return;
  const secs = sectionBars(spec);
  spec.sections = secs
    .map((s) => {
      const overlap = Math.max(0, Math.min(s.to, from + count - 1) - Math.max(s.from, from) + 1);
      return { name: s.name, bars: s.to - s.from + 1 - overlap };
    })
    .filter((s) => s.bars > 0);
}

// ─── reading a score ────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const nameOf = (m: number): string => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/** Bars (1-based) a track plays in, as ranges: "5-14, 17-22". */
function barsPlayed(t: Track): string {
  const set = [...new Set(t.notes.map((n) => Math.floor(n.t / 4) + 1))].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < set.length; ) {
    let j = i;
    while (j + 1 < set.length && set[j + 1] === set[j]! + 1) j++;
    out.push(set[i] === set[j] ? `${set[i]}` : `${set[i]}-${set[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** The score as the copilot reads it: the song, its sections and chords, every track's settings, and (asked for) notes. */
export function describeScore(spec: SongSpec, o: { tracks?: number[]; bars?: [number, number] } = {}): Record<string, unknown> {
  const bars = barsOf(spec);
  const settings = (t: Track) => {
    const s: Record<string, unknown> = {};
    for (const k of ['volume', 'pan', 'send', 'delay', 'hp', 'lp', 'width', 'duck', 'drive', 'crush', 'slide', 'tone', 'pitched', 'tune', 'gate', 'release', 'reverse', 'start', 'mute', 'auto'] as const) if (t[k] !== undefined) s[k] = t[k];
    return s;
  };
  const tracks = spec.tracks.map((t, i) => {
    const pitches = t.notes.filter((n) => n.n !== undefined).map((n) => midiOf(n.n!));
    return {
      track: i,
      ...(t.name ? { name: t.name } : {}),
      instrument: t.instrument,
      ...(t.sample ? { sample: t.sample } : {}),
      notes: t.notes.length,
      bars: barsPlayed(t),
      ...(pitches.length ? { range: `${nameOf(Math.min(...pitches))}-${nameOf(Math.max(...pitches))}` } : {}),
      ...settings(t),
    };
  });
  const out: Record<string, unknown> = {
    bpm: spec.bpm,
    bars,
    ...(spec.style ? { style: spec.style } : {}),
    ...(spec.key ? { key: spec.key } : {}),
    ...(spec.introBeats ? { introBars: spec.introBeats / 4, loop: `bars ${spec.introBeats / 4 + 1}-${bars} loop; the intro plays once` } : {}),
    sections: sectionBars(spec).map((s) => `${s.name} ${s.from}-${s.to}`),
    ...(spec.chords?.length ? { chords: spec.chords.map((c, i) => `${i + 1}: ${c.map(nameOf).join(' ')}`) } : {}),
    mix: { reverb: spec.reverb ?? 0.3, tone: spec.tone ?? 0.4, drive: spec.drive ?? 0, ...(spec.loudness !== undefined ? { loudness: spec.loudness } : {}), ...(spec.delayTime ? { delay: spec.delayTime } : {}), ...(spec.duckRelease ? { duckRelease: spec.duckRelease } : {}), ...(spec.tape ? { tape: spec.tape } : {}), ...(spec.auto ? { auto: spec.auto } : {}) },
    seed: spec.seed ?? 7,
    tracks,
  };
  if (o.tracks?.length) {
    const [a, b] = o.bars ? [(o.bars[0] - 1) * 4, o.bars[1] * 4] : [0, spec.beats];
    out.notes = Object.fromEntries(
      o.tracks.map((i) => {
        const t = spec.tracks[i]!;
        const lines: string[] = [];
        for (let bar = Math.floor(a / 4); bar * 4 < b; bar++) {
          const ns = t.notes.filter((n) => n.t >= bar * 4 - 1e-6 && n.t < bar * 4 + 4 - 1e-6);
          if (!ns.length) continue;
          lines.push(`bar ${bar + 1}: ${ns.map((n) => [r3(n.t - bar * 4), n.n !== undefined ? nameOf(midiOf(n.n)) : '-', n.d, n.v ?? 0.8].join(' ') + (n.glide !== undefined ? ` >${nameOf(midiOf(n.glide))}` : '') + (n.o !== undefined ? ` @${n.o}` : '')).join(' | ')}`);
        }
        return [`${i} ${t.name ?? t.instrument}`, lines];
      }),
    );
    out.noteFormat = 'per bar: beat-in-bar note length velocity (">X" glides to X, "@o" plays a bed from its beat o)';
  }
  return out;
}
