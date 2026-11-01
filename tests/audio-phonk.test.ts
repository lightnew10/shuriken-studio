import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../src/core/audio/dsp/util';
import { Biquad } from '../src/core/audio/dsp/filter';
import { powerSpectrum } from '../src/core/audio/dsp/fft';
import { checkAudio } from '../src/core/audio/dsp/master';
import { AudioService } from '../src/core/audio/audio-service';
import { composeStyle, midiOf, renderSong, songLoopStart, type Instrument, type SongSpec, type Track } from '../src/core/audio/synth';
import { Store } from '../src/core/db/store';
import { PROJECT_MIGRATIONS } from '../src/core/db/schema';
import type { ProjectContext } from '../src/core/projects/project-service';

const SR = SAMPLE_RATE;
const track = (spec: SongSpec, inst: Instrument, i = 0): Track => spec.tracks.filter((t) => t.instrument === inst)[i]!;

describe('phonk composition', () => {
  const spec = composeStyle('phonk', { bars: 22, seed: 3 });
  const spb = 60 / spec.bpm;

  it('is 130-150 bpm in a minor or Phrygian key, intro / drop / breakdown / drop, intro played once', () => {
    expect(spec.bpm).toBeGreaterThanOrEqual(130);
    expect(spec.bpm).toBeLessThanOrEqual(150);
    expect(spec.sections).toEqual([{ name: 'Intro', bars: 4 }, { name: 'Drop', bars: 8 }, { name: 'Breakdown', bars: 2 }, { name: 'Drop 2', bars: 8 }]);
    expect(spec.beats).toBe(22 * 4);
    expect(spec.introBeats).toBe(16);
    expect(songLoopStart(spec)).toBe(Math.round(16 * spb * SR));
    // every pitched note is in F minor / Phrygian (flat 3 and flat 6/7 present, no natural 3rd or 7th)
    const pcs = new Set<number>();
    for (const t of spec.tracks.filter((t) => ['cowbell', 'bass808', 'pad'].includes(t.instrument))) for (const n of t.notes) pcs.add(midiOf(n.n!) % 12);
    for (const pc of pcs) expect([5, 6, 8, 10, 0, 1, 3], `pitch class ${pc}`).toContain(pc); // F Gb Ab Bb C Db Eb
    expect(pcs.has(4)).toBe(false); // no A natural
    expect(pcs.has(8) || pcs.has(1)).toBe(true);
  });

  it('has no drums in the intro, a full groove in the drops and none but the cowbell, pad and a snare build in the breakdown', () => {
    const introEnd = 16;
    for (const inst of ['kick', 'hat', 'openhat'] as Instrument[]) expect(track(spec, inst).notes.every((n) => n.t >= introEnd - 0.3), inst).toBe(true);
    // the only thing near drums in the intro is the snare build of its last bar
    for (const inst of ['clap', 'snare'] as Instrument[]) expect(track(spec, inst).notes.every((n) => n.t >= introEnd - 4 - 0.1), inst).toBe(true);
    expect(track(spec, 'cowbell').notes.some((n) => n.t < introEnd)).toBe(true);
    const intro808 = spec.tracks.filter((t) => t.instrument === 'bass808').find((t) => t.lp);
    expect(intro808, 'a filtered 808 in the intro').toBeDefined();
    expect(intro808!.notes.every((n) => n.t < introEnd + 0.1)).toBe(true);
    const brk = [48, 56];
    const inBreak = (t: Track) => t.notes.filter((n) => n.t >= brk[0]! && n.t < brk[1]! - 1.9);
    expect(inBreak(track(spec, 'kick')).length).toBe(0);
    expect(inBreak(track(spec, 'hat')).length).toBe(0);
    expect(spec.tracks.filter((t) => t.instrument === 'bass808').every((t) => inBreak(t).length === 0)).toBe(true);
    expect(track(spec, 'cowbell').notes.some((n) => n.t >= brk[0]! && n.t < brk[1]!)).toBe(true);
    // the build: snare notes in the breakdown's last bar
    expect(track(spec, 'snare').notes.filter((n) => n.t >= brk[1]! - 4 && n.t < brk[1]!).length).toBeGreaterThanOrEqual(8);
    // claps and snares on 2 and 4 in a drop bar
    const bar = (inst: Instrument, b: number) => track(spec, inst).notes.filter((n) => n.t >= b * 4 - 0.1 && n.t < b * 4 + 4 - 0.1).map((n) => Math.round(n.t - b * 4));
    expect(bar('clap', 5)).toEqual([1, 3]);
    expect(bar('snare', 5)).toEqual([1, 3]);
    // crashes open both drops
    expect(track(spec, 'crash').notes.map((n) => Math.round(n.t / 4))).toEqual([4, 14]);
  });

  it('has the cowbell riff: short hits in the 350-1200 Hz range, a repeating 2-bar riff with variation and octave jumps', () => {
    const cow = track(spec, 'cowbell').notes;
    for (const n of cow) {
      expect(midiOf(n.n!)).toBeGreaterThanOrEqual(64);
      expect(midiOf(n.n!)).toBeLessThanOrEqual(86);
      expect(n.d).toBeLessThanOrEqual(0.3);
    }
    const sig = (b0: number) => cow.filter((n) => n.t >= b0 * 4 - 0.1 && n.t < (b0 + 2) * 4 - 0.1).map((n) => `${Math.round((n.t - b0 * 4) * 4)}:${midiOf(n.n!)}`).join(' ');
    expect(sig(0)).toBe(sig(4)); // the riff repeats
    expect(sig(8)).not.toBe(sig(10)); // and turns
    const pitches = cow.map((n) => midiOf(n.n!));
    expect(Math.max(...pitches) - Math.min(...pitches)).toBeGreaterThanOrEqual(12); // an octave of range, octave jumps included
    let jumps = 0;
    for (let i = 1; i < cow.length; i++) if (Math.abs(midiOf(cow[i]!.n!) - midiOf(cow[i - 1]!.n!)) >= 12) jumps++;
    expect(jumps).toBeGreaterThanOrEqual(2);
  });

  it('plays the 808 on the kick, in the sub range, with glides and long tails', () => {
    const kicks = track(spec, 'kick').notes.map((n) => n.t);
    const bass = spec.tracks.filter((t) => t.instrument === 'bass808').find((t) => !t.lp)!;
    for (const n of bass.notes) expect(kicks.some((k) => Math.abs(k - n.t) < 0.1), `808 at ${n.t} has a kick`).toBe(true);
    for (const n of bass.notes) {
      const f = 440 * Math.pow(2, (midiOf(n.n!) - 69) / 12);
      expect(f).toBeGreaterThan(38);
      expect(f).toBeLessThan(115);
    }
    expect(bass.notes.some((n) => n.glide !== undefined)).toBe(true);
    expect(bass.notes.filter((n) => n.d >= 0.9).length).toBeGreaterThanOrEqual(bass.notes.length / 3);
    expect(bass.drive).toBeGreaterThan(0);
    expect(track(spec, 'kick').drive).toBeGreaterThanOrEqual(0.9); // hard clipped
  });

  it('has fast hats with triplet rolls, open-hat accents, and a pump on everything but the kick', () => {
    const hats = track(spec, 'hat').notes;
    const bars = (b: number) => hats.filter((n) => n.t >= b * 4 - 0.05 && n.t < b * 4 + 4 - 0.05);
    expect(bars(5).length).toBeGreaterThanOrEqual(8);
    // a triplet roll: six hits a sixth of a beat apart in the last beat of an odd bar
    const roll = bars(5).filter((n) => n.t - 20 >= 3 - 0.05).sort((a, b) => a.t - b.t);
    expect(roll.length).toBeGreaterThanOrEqual(6);
    const gaps = roll.slice(1, 6).map((n, i) => n.t - roll[i]!.t);
    expect(Math.max(...gaps)).toBeLessThan(0.25);
    expect(track(spec, 'openhat').notes.length).toBeGreaterThan(8);
    expect(track(spec, 'pad').duck).toBeGreaterThanOrEqual(0.5);
    expect(track(spec, 'cowbell').duck).toBeGreaterThan(0);
    expect(spec.tracks.filter((t) => t.instrument === 'bass808').some((t) => t.duck === undefined || t.duck > 0)).toBe(true);
  });

  it('is deterministic per seed, and a variation per seed', () => {
    expect(composeStyle('phonk', { bars: 22, seed: 3 })).toEqual(spec);
    expect(JSON.stringify(composeStyle('phonk', { bars: 22, seed: 4 }).tracks[0])).not.toBe(JSON.stringify(spec.tracks[0]));
    const short = composeStyle('phonk', { bars: 12, seed: 3 });
    expect(short.sections!.map((s) => s.bars).reduce((a, b) => a + b, 0)).toBe(short.beats / 4);
    expect(short.sections!.every((s) => s.bars >= 2)).toBe(true);
  });
});

describe('phonk render', () => {
  const spec = composeStyle('phonk', { bars: 12, seed: 3 });
  const S = songLoopStart(spec);
  const [L, R] = renderSong(spec, 7);
  const mono = Float32Array.from(L, (v, i) => (v + R[i]!) * 0.5);
  const share = (lo: number, hi: number, from = S): number => {
    const N = 8192;
    let band = 0;
    let tot = 0;
    for (let s = from; s + N <= mono.length; s += N * 2) {
      const P = powerSpectrum(mono, s, N);
      for (let k = 1; k < P.length; k++) {
        const f = (k * SR) / N;
        tot += P[k]!;
        if (f >= lo && f < hi) band += P[k]!;
      }
    }
    return band / tot;
  };

  it('is a loud, driven master under the limiter: -11 LUFS-I, no clipping, a seamless loop from the first drop', () => {
    expect(spec.loudness).toBe(-11);
    const c = checkAudio([L, R], { category: 'music', loop: true, loopStart: S, targetLufs: -11, measure: 'integrated' });
    expect(c.issues, c.summary).toEqual([]);
    expect(Math.abs(c.lufsI! + 11)).toBeLessThanOrEqual(1);
    expect(c.truePeakDb).toBeLessThanOrEqual(-1);
    expect(c.seam!.ratio).toBeLessThan(2.5);
    expect(Math.abs(c.dc)).toBeLessThan(0.003);
    // a loud master: the loudness sits well above the -16 of ordinary music with peaks under the ceiling
    expect(L.every((v) => Math.abs(v) <= 1)).toBe(true);
  });

  it('has a strong sub (40-70 Hz at F1), a clear cowbell band (500-900 Hz) and presence (2-6 kHz)', () => {
    expect(share(40, 70)).toBeGreaterThan(0.15);
    expect(share(500, 900)).toBeGreaterThan(0.1);
    expect(share(2000, 6000)).toBeGreaterThan(0.03);
    const N = 8192;
    const big = new Float64Array(N / 2 + 1);
    for (let s = S; s + N <= mono.length; s += N) {
      const P = powerSpectrum(mono, s, N);
      for (let k = 0; k < P.length; k++) big[k]! += P[k]!;
    }
    let best = 1;
    for (let k = 1; k < big.length; k++) if ((k * SR) / N > 30 && (k * SR) / N < 130 && big[k]! > big[best]!) best = k;
    expect((best * SR) / N).toBeGreaterThan(38);
    expect((best * SR) / N).toBeLessThan(75);
  });

  it('keeps the bass mono and pumps: the loop is quieter right after each kick than just before the next', () => {
    const side = Float32Array.from(L, (v, i) => (v - R[i]!) * 0.5);
    const lo = (x: Float32Array): number => {
      const y = Float32Array.from(x);
      Biquad.lowpass(150, 0.707).processBuffer(y);
      Biquad.lowpass(150, 0.707).processBuffer(y);
      return y.reduce((a, v) => a + v * v, 0);
    };
    expect(10 * Math.log10(lo(side) / lo(mono))).toBeLessThan(-18);
    // sidechain: a pad over a four-on-the-floor kick dips right after every kick (heard above the kick's own low end)
    const pump: SongSpec = { bpm: 120, beats: 16, reverb: 0, tracks: [{ instrument: 'pad', duck: 0.7, notes: [{ t: 0, d: 15.9, n: 'C4', v: 0.8 }] }, { instrument: 'kick', notes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((t) => ({ t, d: 0.25 })) }] };
    const [pl, pr] = renderSong(pump, 3);
    const hi = Float32Array.from(pl, (v, i) => (v + pr[i]!) * 0.5);
    Biquad.highpass(1500, 0.707).processBuffer(hi);
    const k0 = SR * 4; // a kick every half second (22050 samples)
    const rms = (a: number, b: number): number => Math.sqrt(hi.slice(a, b).reduce((x, v) => x + v * v, 0) / (b - a));
    expect(rms(k0 + 1500, k0 + 4500)).toBeLessThan(rms(k0 - 4500, k0 - 1500) * 0.8);
  });

  it('AudioService stores the intro in the loop region: the loop starts after the intro and the MP3 delay', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-phonk-'));
    const svc = new AudioService({ root, store: new Store(':memory:', PROJECT_MIGRATIONS) } as unknown as ProjectContext);
    const made = svc.music({ name: 'Drift', style: 'phonk', bars: 12, seed: 3, actor: 'test' });
    expect(made.loop.start).toBeCloseTo((S + 1105) / SR, 4);
    expect(made.loop.length).toBeCloseTo((made.spec.beats * 60) / made.spec.bpm - S / SR, 3);
    expect(made.check.target).toMatchObject({ lufs: -11, measure: 'integrated' });
    expect(made.check.issues).toEqual([]);
  }, 120_000);
});
