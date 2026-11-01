import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng, SAMPLE_RATE } from '../src/core/audio/dsp/util';
import { measureLoudness, checkAudio } from '../src/core/audio/dsp/master';
import { powerSpectrum } from '../src/core/audio/dsp/fft';
import { Biquad } from '../src/core/audio/dsp/filter';
import { wavBytes } from '../src/core/audio/synth';
import { detectPitch, detectTempo, dominantPartial, guessKind, guessRole, keyFromName, bpmFromName, trimSilence, foldChannels } from '../src/core/audio/sample-analysis';
import { SampleLibrary, prepareSample, noteName, BUILTIN_SAMPLE_IDS } from '../src/core/audio/sample-library';
import { renderSamplerNote, timeStretch, seamless, type LoadedSample, type SampleBank } from '../src/core/audio/sampler';
import { renderSong, songStems, voiceLoudness, songLoopStart, type SongSpec } from '../src/core/audio/music';

const SR = SAMPLE_RATE;
const tone = (hz: number, sec: number, amp = 0.6, decay = 0) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR) * (decay ? Math.exp(-i / SR / decay) : 1));

/** The strongest frequency in a stretch of audio. */
function peakHz(x: Float32Array, from = 0, n = 8192): number {
  const P = powerSpectrum(x, from, n);
  let best = 1;
  for (let k = 1; k < P.length; k++) if (P[k]! > P[best]!) best = k;
  return (best * SR) / n;
}

/** Clicks every `beatSec` seconds for `beats` beats: a loop with a tempo. */
function clickLoop(bpm: number, beats: number): Float32Array {
  const spb = 60 / bpm;
  const x = new Float32Array(Math.round(beats * spb * SR));
  for (let b = 0; b < beats; b++) {
    const at = Math.round(b * spb * SR);
    for (let j = 0; j < 2000 && at + j < x.length; j++) x[at + j] = (b % 4 === 0 ? 0.9 : 0.5) * Math.exp(-j / 300) * Math.sin(j * 0.3);
  }
  return x;
}

const bank = (samples: LoadedSample[]): SampleBank => ({ get: (id) => samples.find((s) => s.id === id) ?? null });

describe('what a sample is, measured', () => {
  it('finds the pitch of a melodic one-shot, and of a cowbell layered over a sub at the cowbell', () => {
    const saw = Float32Array.from({ length: SR }, (_, i) => 0.5 * (((220 * i) / SR) % 1) - 0.25);
    expect(detectPitch(saw)!.midi).toBeCloseTo(57, 0);
    const layered = Float32Array.from(tone(554.4, 1, 0.3), (v, i) => v + 0.8 * Math.sin((2 * Math.PI * 50 * i) / SR));
    expect(detectPitch(layered)!.midi).toBeLessThan(40); // the sub, when nothing says where to look
    expect(Math.round(detectPitch(layered, SR, [250, 2000])!.midi)).toBe(73); // C#5, the cowbell
    const noiseOf = (seed: number) => {
      const rng = new Rng(seed);
      return Float32Array.from({ length: SR / 2 }, () => rng.bipolar() * 0.5);
    };
    for (let seed = 1; seed <= 20; seed++) expect(detectPitch(noiseOf(seed)), `noise ${seed}`).toBeNull();
    const noise = noiseOf(12);
    // A cowbell's two partials a fifth apart (540 and 800 Hz): YIN hears their common period an octave down; the
    // root a producer and the cowbell voice go by is the lower partial.
    const bell = Float32Array.from({ length: SR / 2 }, (_, i) => Math.exp(-i / SR / 0.1) * (Math.sin((2 * Math.PI * 540 * i) / SR) + 0.6 * Math.sin((2 * Math.PI * 800 * i) / SR)));
    expect(detectPitch(bell, SR, [250, 2000])?.hz ?? 270).toBeLessThan(300);
    expect(dominantPartial(bell)!.hz).toBeCloseTo(540, -1);
    expect(dominantPartial(noise)).toBeNull();
  });

  it('reads tempo and key from a name, and the tempo from the audio when the name has none', () => {
    expect(bpmFromName('Dark cowbell melody loop 85BPM.wav')).toBe(85);
    expect(bpmFromName('drums_bpm_140')).toBe(140);
    expect(bpmFromName('kick 808')).toBeNull();
    expect(keyFromName('vocal chop loop 1 [C#Minor] [128bpm]')).toMatchObject({ name: 'C# minor' });
    expect(keyFromName('Rhodes Am chord')).toMatchObject({ name: 'A minor' });
    expect(keyFromName('F# maj pad')).toMatchObject({ name: 'F# major' });
    expect(keyFromName('Ambient bpm drums')).toBeNull();
    const t = detectTempo(clickLoop(92, 8));
    expect(t.beats).toBe(8);
    expect(t.bpm).toBeCloseTo(92, 0);
    expect(detectTempo(clickLoop(100, 8), SR, 'loop 100 bpm')).toMatchObject({ bpm: 100, beats: 8, from: 'name' });
  });

  it('guesses the role and kind from the words and the length', () => {
    expect(guessRole('POiZONE 808 COWBELL.mp3')).toBe('cowbell');
    expect(guessRole('Vocal Chops, Female Dry')).toBe('vocal');
    expect(guessRole('rhodes chords.wav')).toBe('keys');
    expect(guessRole('vinyl crackle loop')).toBe('texture');
    expect(guessRole('Hard Kick 01')).toBe('kick');
    expect(guessRole('808 bass glide')).toBe('808');
    expect(guessKind('Dark cowbell melody loop 85BPM', 5.6, 'cowbell')).toBe('loop');
    expect(guessKind('rain on a window', 30, 'texture')).toBe('texture');
    expect(guessKind('cowbell', 0.4, 'cowbell')).toBe('oneshot');
  });

  it('prepares a sample: silence trimmed, the same two channels folded to mono, the peak at -1 dBFS', () => {
    const body = tone(440, 0.5, 0.3, 0.15);
    const padded = new Float32Array(Math.round(0.8 * SR) + body.length);
    padded.set(body, Math.round(0.3 * SR));
    const p = prepareSample({ sampleRate: SR, channels: [padded, padded.slice()] }, { words: 'bell hit' });
    expect(p.channels.length).toBe(1);
    expect(p.info.durationSec).toBeLessThan(0.55);
    const peak = Math.max(...p.channels[0]!.map(Math.abs));
    expect(20 * Math.log10(peak)).toBeCloseTo(-1, 1);
    expect(p.info.root).toBeCloseTo(69, 0);
    expect(p.info.kind).toBe('oneshot');
    // A different right channel stays stereo; a loop keeps its length (its beats are its tempo).
    expect(foldChannels([body, tone(330, 0.5)]).length).toBe(2);
    const loop = clickLoop(120, 4);
    const pl = prepareSample({ sampleRate: SR, channels: [loop] }, { words: 'drum loop 120bpm' });
    expect(pl.info).toMatchObject({ kind: 'loop', bpm: 120, beats: 4 });
    expect(pl.channels[0]!.length).toBe(loop.length);
    // start / end take a phrase out of a longer recording, at its own rate.
    const cut = prepareSample({ sampleRate: 22050, channels: [Float32Array.from({ length: 22050 * 4 }, (_, i) => Math.sin(i * 0.1))] }, { words: 'pad', kind: 'texture', start: 1, end: 2.5 });
    expect(cut.info.durationSec).toBeCloseTo(1.5, 1);
    expect(trimSilence([new Float32Array(100)]).channels[0]!.length).toBe(100);
  });
});

describe('the sampler', () => {
  const sine: LoadedSample = { id: 'a4', kind: 'oneshot', role: 'keys', channels: [tone(440, 1, 0.8, 0.5)], root: 69, lufs: -10 };

  it('pitches a one-shot by the note against its root, and a gated note stops at its length plus the release', () => {
    const up = renderSamplerNote(sine, { semis: 12, seconds: 2, gate: false, release: 0.05, reverse: false, startSec: 0, offsetBeats: 0, songBpm: 120 });
    expect(up.L.length).toBeCloseTo(SR / 2, -2);
    expect(peakHz(up.L, 0, 8192)).toBeCloseTo(880, -1);
    const cut = renderSamplerNote(sine, { semis: 0, seconds: 0.25, gate: true, release: 0.05, reverse: false, startSec: 0, offsetBeats: 0, songBpm: 120 });
    expect(cut.L.length).toBe(Math.round(0.3 * SR));
    expect(Math.abs(cut.L[cut.L.length - 1]!)).toBeLessThan(1e-3);
  });

  it('stretches in time without moving the pitch, and fits a loop to the song: 4 beats at 100 bpm play 4 beats at 120', () => {
    const x = tone(500, 1, 0.5);
    const [y] = timeStretch([x], 1.5);
    expect(y!.length).toBe(Math.round(1.5 * SR));
    expect(peakHz(y!, 4096, 16384)).toBeCloseTo(500, -1);
    const loop: LoadedSample = { id: 'l', kind: 'loop', role: 'drums', channels: [clickLoop(100, 4)], bpm: 100, beats: 4, lufs: -14 };
    const n = renderSamplerNote(loop, { semis: 0, seconds: 4, gate: true, release: 0.01, reverse: false, startSec: 0, offsetBeats: 0, songBpm: 120 });
    // The clicks now come every half second, and the bed wraps round for as long as the note lasts.
    const onsets: number[] = [];
    for (let i = 1; i < n.L.length; i++) if (Math.abs(n.L[i]!) > 0.15 && Math.abs(n.L[i - 1]!) <= 0.15 && (!onsets.length || i - onsets[onsets.length - 1]! > 4000)) onsets.push(i);
    expect(onsets.length).toBeGreaterThanOrEqual(7);
    for (let k = 1; k < 7; k++) expect((onsets[k]! - onsets[k - 1]!) / SR).toBeCloseTo(0.5, 1);
  });

  it('makes a texture seamless (its end crossfaded into its start)', () => {
    const x = Float32Array.from({ length: 2 * SR }, (_, i) => Math.sin(i * 0.013) * (i < SR ? 1 : 0.2));
    const [y] = seamless([x]);
    expect(y!.length).toBeLessThan(x.length);
    expect(Math.abs(y![0]! - y![y!.length - 1]!)).toBeLessThan(0.05);
  });
});

describe('the sample library', () => {
  const mk = () => {
    const app = mkdtempSync(join(tmpdir(), 'shuriken-samples-'));
    const project = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    return { app, project };
  };

  it("picks up the user's own files, prepares them once and again when they change, and says what it can't read", () => {
    const { app, project } = mk();
    const lib0 = new SampleLibrary(app, project);
    lib0.list();
    expect(readdirSync(join(app, 'My samples'))).toContain('README.txt');
    mkdirSync(join(app, 'My samples', 'Kicks'), { recursive: true });
    writeFileSync(join(app, 'My samples', 'Kicks', 'Hard Kick 01.wav'), wavBytes([tone(55, 0.6, 0.9, 0.2)]));
    writeFileSync(join(app, 'My samples', 'broken.wav'), 'not audio at all, just text pretending');
    mkdirSync(join(project, 'assets', 'audio', 'samples'), { recursive: true });
    writeFileSync(join(project, 'assets', 'audio', 'samples', 'Rhodes C.wav'), wavBytes([tone(261.6, 1.5, 0.5, 0.6)]));
    const lib = new SampleLibrary(app, project);
    const all = lib.list();
    const kick = all.find((s) => s.id === 'my-kicks-hard-kick-01')!;
    expect(kick).toMatchObject({ kind: 'oneshot', role: 'kick', source: { kind: 'user', folder: 'app', file: 'Kicks/Hard Kick 01.wav' } });
    expect(all.find((s) => s.id === 'proj-rhodes-c')).toMatchObject({ role: 'keys', source: { folder: 'project' } });
    expect(Math.round(all.find((s) => s.id === 'proj-rhodes-c')!.root!)).toBe(60);
    expect(lib.prepared.sort()).toEqual(['Kicks/Hard Kick 01.wav', 'Rhodes C.wav']);
    expect(lib.skipped.map((s) => s.file)).toEqual(['broken.wav']);
    // Prepared once: a second library reads the prepared copy.
    const again = new SampleLibrary(app, project);
    again.list();
    expect(again.prepared).toEqual([]);
    expect(again.get('my-kicks-hard-kick-01')!.channels[0]!.length).toBeGreaterThan(1000);
    for (const id of BUILTIN_SAMPLE_IDS) expect(all.some((s) => s.id === id), id).toBe(true);
  });

  it('keeps a web sample with its source, and a copy in the project of each sample a song uses', () => {
    const { app, project } = mk();
    const lib = new SampleLibrary(app, project);
    const p = prepareSample({ sampleRate: SR, channels: [tone(554.4, 0.4, 0.7, 0.1)] }, { words: '808 cowbell' });
    const info = lib.saveWeb('808 cowbell', p, { kind: 'web', license: 'cc0', licenseName: 'CC0 1.0', creator: 'someone', sourceUrl: 'https://freesound.org/s/1' }, ['cowbell']);
    expect(info.id).toBe('808-cowbell');
    expect(lib.saveWeb('808 cowbell', p, { kind: 'web', license: 'cc0' }).id).toBe('808-cowbell-2');
    expect(noteName(info.root!)).toMatch(/^C#5/);
    lib.keepInProject(['808-cowbell', 'tr808-clap']);
    expect(readdirSync(join(project, 'assets', 'audio', 'samples')).sort()).toEqual(['808-cowbell.sample.json', '808-cowbell.wav']);
    // On another machine (another app folder) the project still has it.
    const elsewhere = new SampleLibrary(mkdtempSync(join(tmpdir(), 'shuriken-samples-')), project);
    expect(elsewhere.get('808-cowbell')).not.toBeNull();
    expect(elsewhere.info('808-cowbell')!.source).toMatchObject({ kind: 'web', license: 'cc0', creator: 'someone' });
    // What the analysis got wrong can be corrected.
    expect(lib.update('808-cowbell', { root: 72 }).root).toBe(72);
    expect(() => lib.update('tr808-cowbell', { root: 70 })).toThrow(/built in/);
  });

  it('has the TR-808 emulations: a cowbell at 540 Hz, a long kick at 49 Hz, hats, clap, textures', () => {
    const lib = new SampleLibrary(mkdtempSync(join(tmpdir(), 'shuriken-samples-')), null);
    const cow = lib.get('tr808-cowbell')!;
    expect(noteName(cow.root!)).toBe('C#5 -45c'); // 540 Hz
    expect(cow.channels[0]!.length / SR).toBeLessThan(0.7);
    expect(lib.get('tr808-kick')!.root).toBeCloseTo(31, 0);
    expect(lib.get('vinyl-crackle')!.kind).toBe('texture');
    for (const id of BUILTIN_SAMPLE_IDS) expect(Number.isFinite(lib.get(id)!.lufs), id).toBe(true);
  });
});

describe('songs that play samples', () => {
  const sine: LoadedSample = { id: 'a4', kind: 'oneshot', role: 'keys', channels: [tone(440, 1.5, 0.8, 0.6)], root: 69, lufs: measureLoudness([tone(440, 1.5, 0.8, 0.6)]).momentaryMax };

  it('plays a melody on a sample at the notes it is given', () => {
    const spec: SongSpec = { bpm: 120, beats: 8, reverb: 0, tracks: [{ instrument: 'pluck', sample: 'a4', notes: [{ t: 0, d: 1.8, n: 'A4' }, { t: 4, d: 1.8, n: 'A5' }] }] };
    const [L] = renderSong(spec, 7, { samples: bank([sine]) });
    expect(peakHz(L, Math.round(0.1 * SR))).toBeCloseTo(440, -1);
    expect(peakHz(L, Math.round(2.1 * SR))).toBeCloseTo(880, -1);
  });

  it('glides a pitched sample like the 808 voice does: a sampled 808 slides into the next note', () => {
    const sub: LoadedSample = { id: 'sub', kind: 'oneshot', role: '808', channels: [tone(55, 3, 0.8)], root: 33, lufs: -12 };
    const spec: SongSpec = { bpm: 120, beats: 8, reverb: 0, tracks: [{ instrument: 'bass808', sample: 'sub', duck: 0, slide: 0.5, notes: [{ t: 0, d: 4, n: 'A1', glide: 'A2' }] }] };
    const [L] = songStems(spec, 7, bank([sub])).map((s) => s.L);
    expect(peakHz(L!, Math.round(0.1 * SR), 32768)).toBeCloseTo(55, 0);
    expect(peakHz(L!, Math.round(1.8 * SR), 8192)).toBeGreaterThan(95);
  });

  it('matches a sample to the loudness of the voice it stands in for', () => {
    const one = (t: SongSpec['tracks'][0]) => {
      const spec: SongSpec = { bpm: 120, beats: 4, reverb: 0, tracks: [t] };
      const stem = songStems(spec, 7, bank([sine]))[0]!;
      return measureLoudness([stem.L, stem.R]).momentaryMax;
    };
    const voice = one({ instrument: 'pluck', notes: [{ t: 0, d: 1, n: 'G4', v: 0.8 }] });
    const sampled = one({ instrument: 'pluck', sample: 'a4', notes: [{ t: 0, d: 1, n: 'G4', v: 0.8 }] });
    expect(Math.abs(voice - sampled)).toBeLessThan(4);
    expect(voiceLoudness('texture')).toBeCloseTo(voiceLoudness('pad') - 8, 5);
  });

  it('says which sample is missing, and that a sample-only part needs one', () => {
    const spec: SongSpec = { bpm: 120, beats: 4, tracks: [{ instrument: 'cowbell', sample: 'nope', notes: [{ t: 0, d: 0.25, n: 'F5' }] }] };
    expect(() => renderSong(spec, 7, { samples: bank([]) })).toThrow(/Sample "nope" is not in the sample library/);
    expect(() => renderSong({ bpm: 120, beats: 4, tracks: [{ instrument: 'vocal', notes: [{ t: 0, d: 1 }] }] })).toThrow(/plays a sample/);
  });

  it('a phonk song with the TR-808 cowbell sample and a vinyl bed masters cleanly and loops seamlessly', async () => {
    const { composeStyle } = await import('../src/core/audio/compose');
    const lib = new SampleLibrary(mkdtempSync(join(tmpdir(), 'shuriken-samples-')), null);
    const spec = composeStyle('phonk', { bars: 12, seed: 3 });
    for (const t of spec.tracks) if (t.instrument === 'cowbell') t.sample = 'tr808-cowbell';
    spec.tracks.push({ instrument: 'texture', name: 'vinyl', sample: 'vinyl-crackle', notes: [{ t: 0, d: spec.beats, v: 0.8 }] });
    spec.tape = { wow: 0.4, hiss: 0.3 };
    const [L, R] = renderSong(spec, 7, { samples: lib });
    const c = checkAudio([L, R], { category: 'music', loop: true, loopStart: songLoopStart(spec), targetLufs: -11, measure: 'integrated' });
    expect(c.issues, c.summary).toEqual([]);
    expect(c.seam!.ratio).toBeLessThan(2.5);
  }, 120_000);
});

describe('effects over the song', () => {
  const base = (): SongSpec => ({ bpm: 120, beats: 16, reverb: 0, tracks: [{ instrument: 'pad', duck: 0, notes: [0, 4, 8, 12].map((t) => ({ t, d: 3.9, n: 'C4', v: 0.8 })) }] });
  const hiShare = (x: Float32Array, from: number, to: number) => {
    let hi = 0;
    let all = 0;
    for (let s = from; s + 4096 <= to; s += 4096) {
      const P = powerSpectrum(x, s, 4096);
      for (let k = 1; k < P.length; k++) {
        all += P[k]!;
        if ((k * SR) / 4096 > 1500) hi += P[k]!;
      }
    }
    return hi / all;
  };

  it('sweeps a low-pass over a part (a breakdown that closes and opens)', () => {
    const plain = songStems(base())[0]!.L;
    const s = base();
    s.tracks[0]!.auto = { lp: [[0, 18000], [6, 18000], [8, 300], [10, 300], [12, 18000]] };
    const swept = songStems(s)[0]!.L;
    const bar3 = [Math.round(8.2 * 0.5 * SR), Math.round(9.8 * 0.5 * SR)] as const;
    expect(hiShare(swept, ...bar3)).toBeLessThan(hiShare(plain, ...bar3) * 0.2);
    const bar1 = [Math.round(0.5 * 0.5 * SR), Math.round(3.5 * 0.5 * SR)] as const;
    expect(hiShare(swept, ...bar1)).toBeCloseTo(hiShare(plain, ...bar1), 2);
  });

  it('crushes, mutes, and pumps longer with a longer duck release', () => {
    const crushed = base();
    crushed.tracks[0]!.crush = 1;
    expect(hiShare(songStems(crushed)[0]!.L, 0, SR * 4)).toBeGreaterThan(hiShare(songStems(base())[0]!.L, 0, SR * 4));
    const muted = base();
    muted.tracks[0]!.mute = true;
    expect(songStems(muted)[0]!.L.every((v) => v === 0)).toBe(true);
    const pump = (release?: number) => {
      const s: SongSpec = { ...base(), duckRelease: release, tracks: [{ ...base().tracks[0]!, duck: 0.8 }, { instrument: 'kick', notes: Array.from({ length: 16 }, (_, t) => ({ t, d: 0.25 })) }] };
      const [l] = renderSong(s, 3);
      const hp = Float32Array.from(l);
      Biquad.highpass(1500, 0.707).processBuffer(hp); // the pad, not the kick's own low end
      const rms = (a: number, b: number) => Math.sqrt(hp.slice(a, b).reduce((x, v) => x + v * v, 0) / (b - a));
      const k = SR * 4;
      return rms(k + 3000, k + 9000) / rms(k + 14000, k + 20000);
    };
    expect(pump(0.2)).toBeLessThan(pump(0.04));
  });
});
