/**
 * The sample library: sounds the composer plays as instruments. Three sources, one list (ids are unique
 * across them):
 *  - web samples, found on Openverse and added by the copilot: CC0 or public domain ONLY (a sample becomes part
 *    of a new song that is uploaded, so nothing that asks for a credit or limits use goes in); saved prepared
 *    (trimmed, normalised, analysed) under the app's data folder, samples/web, with where they came from;
 *  - the user's own: any WAV, AIFF, FLAC or MP3 dropped into the app's "samples/My samples" folder ("my-" ids)
 *    or into a project's assets/audio/samples folder ("proj-" ids); prepared on first use, again when changed;
 *  - built-in "TR-808" emulations and two textures, synthesized: the fallback when nothing better is found.
 * A song that uses a sample gets a copy in its project (assets/audio/samples/<id>.wav + .sample.json), so
 * the project re-renders anywhere. Samples are 44.1 kHz WAVs, peak -1 dBFS, with their loudness measured.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { Rng, SAMPLE_RATE } from './dsp/util';
import { Osc } from './dsp/osc';
import { Noise } from './dsp/noise';
import { Biquad } from './dsp/filter';
import { Saturator } from './dsp/fx';
import { wavBytes } from './synth';
import { SAMPLE_EXTENSIONS, decodeAudio, resample, type DecodedPcm } from './decode';
import { DRUM_ROLES, detectPitch, detectTempo, dominantPartial, foldChannels, guessKind, guessRole, keyFromName, normalizePeak, pitchRange, removeDcOffset, sampleLoudness, spectrumSummary, trimSilence, type SampleKind } from './sample-analysis';
import type { LoadedSample, SampleBank } from './sampler';

const SR = SAMPLE_RATE;

/** Licenses a web sample may have: it is mixed into a new song, so only sounds free of every condition. */
export const SAMPLE_LICENSES = ['cc0', 'pdm'] as const;
export type SampleLicense = (typeof SAMPLE_LICENSES)[number];

export interface SampleOrigin {
  kind: 'web' | 'user' | 'builtin';
  /** Web: the license (cc0 or pdm), as Openverse states it. */
  license?: SampleLicense;
  licenseName?: string;
  title?: string;
  creator?: string;
  /** The page the sound is on, and the file that was downloaded. */
  sourceUrl?: string;
  downloadUrl?: string;
  /** The site (freesound, wikimedia_audio...) and Openverse's id. */
  origin?: string;
  openverseId?: string;
  /** User samples: the file, relative to its folder, and which folder. */
  file?: string;
  folder?: 'app' | 'project';
  /** Seconds cut out of the original (a phrase taken from a longer recording). */
  cut?: { start: number; end: number };
}

export interface SampleInfo {
  id: string;
  name: string;
  kind: SampleKind;
  role: string;
  /** The note it sounds at (MIDI, fractional) and how sure the pitch detection was (0..1). */
  root?: number;
  pitchConfidence?: number;
  /** Loops: tempo and length in beats; key when its name says one. */
  bpm?: number;
  beats?: number;
  key?: string;
  keyTonic?: number;
  durationSec: number;
  channels: number;
  /** LUFS (one-shots: the loudest 400 ms; beds: integrated). */
  lufs: number;
  /** Where its energy is (%: under 150 Hz, 150-1000, 1-5 kHz, above) and its spectral centroid. */
  spectrum?: { sub: number; low: number; mid: number; high: number; centroidHz: number };
  tags?: string[];
  source: SampleOrigin;
  addedAt: string;
  /** A user file: its size and time when it was prepared (prepared again when they change). */
  stamp?: string;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** 72.55 → "C5 +55c". */
export function noteName(midi: number): string {
  const r = Math.round(midi);
  const cents = Math.round((midi - r) * 100);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}${cents ? ` ${cents > 0 ? '+' : ''}${cents}c` : ''}`;
}

export const sampleSlug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'sample';

export const SAMPLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ─── preparing a sample ─────────────────────────────────────────────────────

export interface PrepareOptions {
  /** Name, title and tags: the words its kind, role, tempo and key are guessed from. */
  words: string;
  kind?: SampleKind;
  role?: string;
  /** The note it sounds at, when the detection is wrong (MIDI or a name like "C#5"). */
  root?: number;
  bpm?: number;
  beats?: number;
  /** Seconds of the original to keep. */
  start?: number;
  end?: number;
}

export interface Prepared {
  channels: Float32Array[];
  info: Pick<SampleInfo, 'kind' | 'role' | 'root' | 'pitchConfidence' | 'bpm' | 'beats' | 'key' | 'keyTonic' | 'durationSec' | 'channels' | 'lufs' | 'spectrum'>;
  notes: string[];
}

/** The longest sample kept, by kind (a longer file is cut). */
export const SAMPLE_MAX_SECONDS: Record<SampleKind, number> = { oneshot: 10, loop: 60, texture: 60 };

/** Cleans and measures decoded audio: cut, 44.1 kHz, mono when it is, DC off, silence trimmed (not from loops), peak -1 dBFS. */
export function prepareSample(d: DecodedPcm, o: PrepareOptions): Prepared {
  const notes: string[] = [];
  const rate = d.sampleRate;
  const a = Math.max(0, Math.round((o.start ?? 0) * rate));
  const b = Math.min(d.channels[0]!.length, o.end !== undefined ? Math.round(o.end * rate) : Infinity);
  if (b - a < rate * 0.01) throw new Error('Nothing left to keep: start and end leave under 10 ms of audio');
  let chs: Float32Array[] = d.channels.map((c) => c.slice(a, b));
  if (rate !== SR) chs = chs.map((c) => resample(c, rate, SR));
  chs = foldChannels(chs);
  removeDcOffset(chs);
  const seconds0 = chs[0]!.length / SR;
  const role = o.role ?? guessRole(o.words);
  const kind = o.kind ?? guessKind(o.words, seconds0, role);
  const max = SAMPLE_MAX_SECONDS[kind];
  if (seconds0 > max) {
    chs = chs.map((c) => c.slice(0, Math.round(max * SR)));
    notes.push(`cut to its first ${max} s (a ${kind} keeps at most ${max} s; give start/end to take another part)`);
  }
  if (kind !== 'loop') chs = trimSilence(chs).channels;
  normalizePeak(chs, -1);
  const mono = chs.length > 1 ? Float32Array.from(chs[0]!, (v, i) => (v + chs[1]![i]!) * 0.5) : chs[0]!;
  const info: Prepared['info'] = { kind, role, durationSec: Math.round((chs[0]!.length / SR) * 1000) / 1000, channels: chs.length, lufs: sampleLoudness(chs, kind), spectrum: spectrumSummary(mono) };
  if (kind === 'oneshot') {
    // Metal (a cowbell, a bell) is pitched by its lowest strong partial, everything else by its period.
    const p = role === 'cowbell' || role === 'bell' ? dominantPartial(mono, SR, pitchRange(role)) : detectPitch(mono, SR, pitchRange(role));
    if (o.root !== undefined) info.root = o.root;
    else if (p && p.confidence >= 0.75) {
      info.root = p.midi;
      info.pitchConfidence = p.confidence;
    } else if (!DRUM_ROLES.has(role)) notes.push('no clear pitch found: give root (the note it plays, e.g. "C#5") to play melodies with it');
  }
  if (kind === 'loop') {
    const t = o.bpm ? { bpm: o.bpm, beats: o.beats ?? Math.max(1, Math.round((info.durationSec * o.bpm) / 60)), from: 'given' } : detectTempo(mono, SR, o.words);
    info.bpm = t.bpm;
    info.beats = t.beats;
    if (t.from === 'audio') notes.push(`tempo guessed from the audio: ${t.bpm} bpm over ${t.beats} beats (give bpm if it is wrong)`);
  }
  const key = keyFromName(o.words);
  if (key && kind !== 'oneshot') {
    info.key = key.name;
    info.keyTonic = key.tonic;
  }
  return { channels: chs, info, notes };
}

// ─── built-in emulations ────────────────────────────────────────────────────

/** The TR-808's six metallic square oscillators (Hz). */
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

function render(seconds: number, fn: (i: number, t: number) => number): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = fn(i, i / SR);
  return x;
}

function metallic(decay: number, seconds: number): Float32Array {
  const oscs = METAL.map((_, k) => new Osc(k * 0.17));
  const bp = Biquad.bandpass(7100, 1.2);
  const hp = Biquad.highpass(6500, 0.7);
  return render(seconds, (_, t) => {
    let s = 0;
    for (let k = 0; k < oscs.length; k++) s += oscs[k]!.pulse(METAL[k]!, 0.5);
    return hp.process(bp.process(s / 6)) * Math.min(1, t / 0.0005) * Math.exp(-t / decay);
  });
}

const BUILTINS: Record<string, { name: string; kind: SampleKind; role: string; root?: number; make: () => Float32Array }> = {
  'tr808-cowbell': {
    name: 'TR-808 cowbell (emulated)',
    kind: 'oneshot',
    role: 'cowbell',
    root: 69 + 12 * Math.log2(540 / 440),
    // Two square oscillators, 540 and 800 Hz, a band-pass, and the two-stage decay (a fast clank, a ringing tail).
    make: () => {
      const a = new Osc(0);
      const b = new Osc(0.25);
      const bp = Biquad.bandpass(2640, 0.6);
      const hp = Biquad.highpass(400, 0.7);
      const sat = new Saturator(1.3);
      return render(0.6, (_, t) => {
        const s = a.pulse(540, 0.5) + b.pulse(800, 0.5);
        const env = Math.min(1, t / 0.0004) * (0.6 * Math.exp(-t / 0.012) + 0.4 * Math.exp(-t / 0.16));
        return sat.process(hp.process(bp.process(s) * 1.4 + s * 0.35) * env);
      });
    },
  },
  'tr808-clap': {
    name: 'TR-808 clap (emulated)',
    kind: 'oneshot',
    role: 'clap',
    // Noise through a band-pass at 1 kHz, struck three times 10 ms apart, then a diffuse tail.
    make: () => {
      const n = new Noise(808);
      const bp = Biquad.bandpass(1100, 1.4);
      return render(0.45, (_, t) => {
        let e = 0;
        for (const at of [0, 0.01, 0.02]) if (t >= at) e = Math.max(e, Math.exp(-(t - at) / 0.004));
        if (t >= 0.03) e = Math.max(e, 0.6 * Math.exp(-(t - 0.03) / 0.11));
        return bp.process(n.white()) * e * 2;
      });
    },
  },
  'tr808-hat': { name: 'TR-808 closed hat (emulated)', kind: 'oneshot', role: 'hat', make: () => metallic(0.035, 0.25) },
  'tr808-openhat': { name: 'TR-808 open hat (emulated)', kind: 'oneshot', role: 'openhat', make: () => metallic(0.28, 1.2) },
  'tr808-kick': {
    name: 'TR-808 kick, long boom (emulated)',
    kind: 'oneshot',
    role: 'kick',
    root: 69 + 12 * Math.log2(49 / 440),
    // A sine at 49 Hz that starts a little higher, ringing out over a second: the kick, and pitched, an 808 bass.
    make: () => {
      let ph = 0;
      return render(1.6, (_, t) => {
        ph += (49 * (1 + 1.4 * Math.exp(-t / 0.012))) / SR;
        return Math.sin(2 * Math.PI * ph) * Math.min(1, t / 0.001) * Math.exp(-t / 0.55);
      });
    },
  },
  'tr808-snare': {
    name: 'TR-808 snare (emulated)',
    kind: 'oneshot',
    role: 'snare',
    // Two tuned drumheads (238 and 476 Hz) and high-passed noise for the snares.
    make: () => {
      const n = new Noise(9);
      const hp = Biquad.highpass(1800, 0.7);
      return render(0.4, (_, t) => {
        const tone = Math.sin(2 * Math.PI * 238 * t) * 0.7 * Math.exp(-t / 0.07) + Math.sin(2 * Math.PI * 476 * t) * 0.35 * Math.exp(-t / 0.045);
        return (tone + hp.process(n.white()) * 0.8 * Math.exp(-t / 0.09)) * Math.min(1, t / 0.0005);
      });
    },
  },
  'tr808-rim': {
    name: 'TR-808 rimshot (emulated)',
    kind: 'oneshot',
    role: 'snare',
    make: () => {
      const hp = Biquad.highpass(600, 0.7);
      return render(0.08, (_, t) => hp.process((Math.sin(2 * Math.PI * 1667 * t) + 0.6 * Math.sin(2 * Math.PI * 455 * t)) * Math.exp(-t / 0.009)));
    },
  },
  'vinyl-crackle': {
    name: 'Vinyl crackle (synthesized)',
    kind: 'texture',
    role: 'texture',
    // Dust clicks at random over a quiet rumble and hiss.
    make: () => {
      const rng = new Rng(33);
      const n = new Noise(34);
      const lp = Biquad.lowpass(90, 0.7);
      const hp = Biquad.highpass(3000, 0.7);
      const x = render(8, () => lp.process(n.white()) * 0.25 + hp.process(n.white()) * 0.02);
      for (let k = 0; k < 8 * 14; k++) {
        const at = Math.floor(rng.next() * x.length);
        const a = (0.2 + rng.next() * 0.8) * (rng.chance(0.5) ? 1 : -1);
        for (let j = 0; j < 60 && at + j < x.length; j++) x[at + j]! += a * Math.exp(-j / 8) * (j % 2 ? -0.5 : 1);
      }
      return x;
    },
  },
  'tape-hiss': {
    name: 'Tape hiss (synthesized)',
    kind: 'texture',
    role: 'texture',
    make: () => {
      const n = new Noise(35);
      const hp = Biquad.highpass(1500, 0.5);
      const lp = Biquad.lowpass(11000, 0.7);
      return render(8, (_, t) => lp.process(hp.process(n.pink())) * (1 + 0.05 * Math.sin(2 * Math.PI * 0.5 * t)));
    },
  },
};

export const BUILTIN_SAMPLE_IDS = Object.keys(BUILTINS);

const builtinCache = new Map<string, { info: SampleInfo; channels: Float32Array[] }>();
function builtin(id: string): { info: SampleInfo; channels: Float32Array[] } | null {
  const b = BUILTINS[id];
  if (!b) return null;
  let v = builtinCache.get(id);
  if (!v) {
    const chs = [b.make()];
    if (b.kind !== 'texture') chs[0] = trimSilence(chs).channels[0]!;
    normalizePeak(chs, -1);
    v = {
      channels: chs,
      info: { id, name: b.name, kind: b.kind, role: b.role, ...(b.root !== undefined ? { root: Math.round(b.root * 100) / 100 } : {}), durationSec: Math.round((chs[0]!.length / SR) * 1000) / 1000, channels: 1, lufs: sampleLoudness(chs, b.kind), source: { kind: 'builtin' }, addedAt: '2026-10-02T00:00:00.000Z' },
    };
    builtinCache.set(id, v);
  }
  return v;
}

// ─── the library ────────────────────────────────────────────────────────────

const SIDE = '.sample.json';
const MAX_USER_FILES = 400;
const MAX_USER_BYTES = 40 * 1024 * 1024;

const USER_README = `Your own samples for Shuriken Studio's Music & sound copilot.

Put one-shots (a cowbell hit, a vocal chop, a Rhodes chord), loops and textures (rain, tape, vinyl) in this
folder: WAV, AIFF, FLAC or MP3, in subfolders if you like. They show up as samples named "my-" and the file
name ("Kicks/Hard Kick 01.wav" is my-kicks-hard-kick-01), ready for the copilot to compose with. Put a tempo in a
loop's file name ("Dark keys 85bpm C#m.wav") and it is fitted to the song's tempo and key.

Use only sounds you have the rights to: what the copilot makes with them goes into your game.
`;

interface Entry {
  info: SampleInfo;
  /** The prepared WAV. */
  wav: string;
}

/** Reads and writes samples; `appDir` is the app's samples folder, `projectRoot` the open project (or null). */
export class SampleLibrary implements SampleBank {
  private readonly loaded = new Map<string, LoadedSample>();
  private index: Map<string, Entry> | null = null;
  /** User files prepared by the last scan (for the tool's message). */
  prepared: string[] = [];
  /** User files that could not be read, with why. */
  skipped: Array<{ file: string; error: string }> = [];

  constructor(
    private readonly appDir: string,
    private readonly projectRoot: string | null,
  ) {}

  get webDir(): string {
    return join(this.appDir, 'web');
  }
  get userDir(): string {
    return join(this.appDir, 'My samples');
  }
  private get userCache(): string {
    return join(this.appDir, '.prepared');
  }
  get projectDir(): string | null {
    return this.projectRoot ? join(this.projectRoot, 'assets', 'audio', 'samples') : null;
  }
  private get projectCache(): string | null {
    return this.projectRoot ? join(this.projectRoot, '.shuriken', 'samples') : null;
  }

  /** Every sample: the project's copies and drops first, then the web library, the user's folder and the built-ins. */
  list(): SampleInfo[] {
    return [...[...this.entries().values()].map((e) => e.info), ...BUILTIN_SAMPLE_IDS.map((id) => builtin(id)!.info)];
  }

  info(id: string): SampleInfo | null {
    return this.entries().get(id)?.info ?? builtin(id)?.info ?? null;
  }

  /** A sample ready to play (SampleBank). */
  get(id: string): LoadedSample | null {
    const known = this.loaded.get(id);
    if (known) return known;
    const b = builtin(id);
    let info: SampleInfo;
    let channels: Float32Array[];
    if (b) ({ info, channels } = b);
    else {
      const e = this.entries().get(id);
      if (!e || !existsSync(e.wav)) return null;
      const d = decodeAudio(readFileSync(e.wav));
      if (!d.ok) return null;
      info = e.info;
      channels = d.channels;
    }
    const s: LoadedSample = { id, kind: info.kind, role: info.role, channels, lufs: info.lufs, ...(info.root !== undefined ? { root: info.root } : {}), ...(info.bpm ? { bpm: info.bpm, beats: info.beats } : {}), ...(info.keyTonic !== undefined ? { keyTonic: info.keyTonic } : {}) };
    this.loaded.set(id, s);
    return s;
  }

  /** A sample's prepared WAV (to listen to it): the file, or a built-in rendered. */
  wav(id: string): Uint8Array | null {
    const b = builtin(id);
    if (b) return wavBytes(b.channels);
    const e = this.entries().get(id);
    return e && existsSync(e.wav) ? readFileSync(e.wav) : null;
  }

  /** Saves a prepared web sample in the app library (and returns its info). The id is free or made free. */
  saveWeb(name: string, p: Prepared, source: SampleOrigin, tags: string[] = [], wantedId?: string): SampleInfo {
    mkdirSync(this.webDir, { recursive: true });
    const taken = this.entries();
    const base = wantedId ?? sampleSlug(name);
    let id = base;
    for (let k = 2; taken.has(id) || builtin(id); k++) id = `${base}-${k}`;
    const info: SampleInfo = { id, name, ...p.info, ...(tags.length ? { tags } : {}), source, addedAt: new Date().toISOString() };
    writeFileSync(join(this.webDir, `${id}.wav`), wavBytes(p.channels));
    writeFileSync(join(this.webDir, `${id}${SIDE}`), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    this.index = null;
    return info;
  }

  /** Changes what is known about a sample (its root, kind, role, tempo): web and project samples, and user files' prepared copies. */
  update(id: string, patch: Partial<Pick<SampleInfo, 'root' | 'kind' | 'role' | 'bpm' | 'beats' | 'name'>>): SampleInfo {
    const e = this.entries().get(id);
    if (!e) throw new Error(builtin(id) ? `${id} is built in: it can't be changed` : `No sample ${id}`);
    const side = e.wav.replace(/\.wav$/, SIDE);
    const info: SampleInfo = { ...e.info, ...patch };
    if (patch.root !== undefined) delete info.pitchConfidence;
    writeFileSync(side, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    this.index = null;
    this.loaded.delete(id);
    return info;
  }

  /** Removes a web sample from the app library (the user's own files are theirs to delete). */
  remove(id: string): boolean {
    const wav = join(this.webDir, `${id}.wav`);
    if (!existsSync(wav)) return false;
    rmSync(wav);
    rmSync(join(this.webDir, `${id}${SIDE}`), { force: true });
    this.index = null;
    this.loaded.delete(id);
    return true;
  }

  /** Copies samples a song uses into the project (built-ins are code and need none); returns their info. */
  keepInProject(ids: string[]): SampleInfo[] {
    const dir = this.projectDir;
    const out: SampleInfo[] = [];
    for (const id of new Set(ids)) {
      const b = builtin(id);
      if (b) {
        out.push(b.info);
        continue;
      }
      const e = this.entries().get(id);
      if (!e) continue;
      out.push(e.info);
      if (!dir || e.wav.startsWith(dir)) continue;
      mkdirSync(dir, { recursive: true });
      copyFileSync(e.wav, join(dir, `${id}.wav`));
      writeFileSync(join(dir, `${id}${SIDE}`), `${JSON.stringify(e.info, null, 2)}\n`, 'utf8');
    }
    this.index = null;
    return out;
  }

  /** The user's folder, made with a note on what goes in it. */
  ensureUserFolder(): string {
    if (!existsSync(this.userDir)) {
      mkdirSync(this.userDir, { recursive: true });
      writeFileSync(join(this.userDir, 'README.txt'), USER_README, 'utf8');
    }
    return this.userDir;
  }

  private entries(): Map<string, Entry> {
    if (this.index) return this.index;
    const idx = new Map<string, Entry>();
    this.prepared = [];
    this.skipped = [];
    const add = (e: Entry) => {
      if (!idx.has(e.info.id)) idx.set(e.info.id, e);
    };
    // The project's own copies (a song's samples) come first: they are what its songs were made with.
    const pdir = this.projectDir;
    if (pdir) for (const e of sidecars(pdir)) add(e);
    if (pdir && this.projectCache) for (const e of this.scanUser(pdir, this.projectCache, 'proj', 'project')) add(e);
    for (const e of sidecars(this.webDir)) add(e);
    this.ensureUserFolder();
    for (const e of this.scanUser(this.userDir, this.userCache, 'my', 'app')) add(e);
    for (const id of BUILTIN_SAMPLE_IDS) idx.delete(id);
    this.index = idx;
    return idx;
  }

  /** The audio files of a user folder, each prepared once (again when the file changes) into `cache`. */
  private scanUser(dir: string, cache: string, prefix: string, folder: 'app' | 'project'): Entry[] {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 6 || files.length >= MAX_USER_FILES) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f, depth + 1);
        else if (SAMPLE_EXTENSIONS.includes(extname(e.name).toLowerCase()) && !existsSync(f.replace(/\.[^.]+$/, SIDE))) files.push(f);
      }
    };
    walk(dir, 0);
    const out: Entry[] = [];
    const used = new Set<string>();
    for (const f of files.sort()) {
      const rel = relative(dir, f).replaceAll('\\', '/');
      let id = `${prefix}-${sampleSlug(rel.replace(/\//g, '-'))}`.slice(0, 60).replace(/-+$/, '');
      for (let k = 2; used.has(id); k++) id = `${id.slice(0, 56)}-${k}`;
      used.add(id);
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      const stamp = `${Math.round(st.mtimeMs)}:${st.size}`;
      const side = join(cache, `${id}${SIDE}`);
      const wav = join(cache, `${id}.wav`);
      if (existsSync(side) && existsSync(wav)) {
        try {
          const info = JSON.parse(readFileSync(side, 'utf8')) as SampleInfo;
          if (info.stamp === stamp) {
            out.push({ info, wav });
            continue;
          }
        } catch {
          // prepared again below
        }
      }
      if (st.size > MAX_USER_BYTES) {
        this.skipped.push({ file: rel, error: `over ${MAX_USER_BYTES / 1024 / 1024} MB` });
        continue;
      }
      const d = decodeAudio(readFileSync(f), { maxSeconds: 90 });
      if (!d.ok) {
        this.skipped.push({ file: rel, error: d.error });
        continue;
      }
      try {
        const name = basename(rel).replace(/\.[^.]+$/, '');
        const p = prepareSample(d, { words: rel });
        const info: SampleInfo = { id, name, ...p.info, source: { kind: 'user', file: rel, folder }, addedAt: new Date().toISOString(), stamp };
        mkdirSync(cache, { recursive: true });
        writeFileSync(wav, wavBytes(p.channels));
        writeFileSync(side, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
        this.prepared.push(rel);
        out.push({ info, wav });
      } catch (e) {
        this.skipped.push({ file: rel, error: (e as Error).message });
      }
    }
    return out;
  }
}

/** Prepared samples in a folder: <id>.wav next to <id>.sample.json. */
function sidecars(dir: string): Entry[] {
  if (!existsSync(dir)) return [];
  const out: Entry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(SIDE)) continue;
    try {
      const info = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SampleInfo;
      const wav = join(dir, f.slice(0, -SIDE.length) + '.wav');
      if (info.id && existsSync(wav)) out.push({ info, wav });
    } catch {
      // an unreadable sidecar is skipped
    }
  }
  return out;
}

