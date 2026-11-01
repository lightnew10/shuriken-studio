import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../src/core/audio/dsp/util';
import { Biquad } from '../src/core/audio/dsp/filter';
import { powerSpectrum } from '../src/core/audio/dsp/fft';
import { checkAudio } from '../src/core/audio/dsp/master';
import { STYLES, composeStyle, midiOf, renderSong, songLoopStart, songStems, type Instrument, type NoteEvent, type SongSpec, type Style, type Track } from '../src/core/audio/synth';

const SR = SAMPLE_RATE;

const trackOf = (spec: SongSpec, inst: Instrument): Track | undefined => spec.tracks.find((t) => t.instrument === inst);
const barOf = (t: number): number => Math.floor((t + 0.15) / 4);
const PITCHED: Instrument[] = ['lead', 'pluck', 'bass', 'pad', 'bell', 'arp', 'strings', 'koto', 'flute', 'epiano'];

/** Energy shares of a stereo mix: below 500 Hz and 2-6 kHz, plus the spectral centroid. */
function spectrum(L: Float32Array, R: Float32Array): { low: number; presence: number; centroid: number } {
  const N = 4096;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (L[i]! + R[i]!) * 0.5;
  const acc = new Float64Array(N / 2 + 1);
  for (let s = 0; s + N <= mono.length; s += N * 2) {
    const P = powerSpectrum(mono, s, N);
    for (let k = 0; k < P.length; k++) acc[k]! += P[k]!;
  }
  let tot = 0, low = 0, presence = 0, cw = 0;
  for (let k = 1; k < acc.length; k++) {
    const f = (k * SR) / N;
    tot += acc[k]!;
    cw += f * acc[k]!;
    if (f < 500) low += acc[k]!;
    else if (f >= 2000 && f < 6000) presence += acc[k]!;
  }
  return { low: low / tot, presence: presence / tot, centroid: cw / tot };
}

/** Level of the side signal against the mid, both low-passed at 150 Hz (dB). */
function bassSideDb(L: Float32Array, R: Float32Array): number {
  const mid = new Float32Array(L.length);
  const side = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    mid[i] = (L[i]! + R[i]!) * 0.5;
    side[i] = (L[i]! - R[i]!) * 0.5;
  }
  for (const x of [mid, side]) {
    Biquad.lowpass(150, 0.707).processBuffer(x);
    Biquad.lowpass(150, 0.707).processBuffer(x);
  }
  const e = (x: Float32Array): number => x.reduce((a, v) => a + v * v, 0);
  return 10 * Math.log10((e(side) + 1e-20) / (e(mid) + 1e-20));
}

describe('composer', () => {
  it('every style composes a full spec: chords, bass, melody, drums where the style has them', () => {
    expect(STYLES).toEqual(['lofi', 'chiptune', 'epic', 'ambient', 'action', 'japanese', 'tropical', 'spooky', 'phonk']);
    for (const style of STYLES) {
      const spec = composeStyle(style, { bars: 8, seed: 3 });
      expect(spec.beats, style).toBe(32);
      expect(spec.tracks.length, style).toBeGreaterThanOrEqual(style === 'ambient' ? 4 : 6);
      for (const t of spec.tracks) {
        expect(t.notes.length, `${style} ${t.instrument}`).toBeGreaterThan(0);
        for (const n of t.notes) {
          expect(n.t, `${style} ${t.instrument}`).toBeGreaterThanOrEqual(0);
          expect(n.t, `${style} ${t.instrument}`).toBeLessThan(32.2);
          expect(n.v ?? 0.8).toBeGreaterThan(0);
          expect(n.v ?? 0.8).toBeLessThanOrEqual(1);
        }
      }
      expect(trackOf(spec, style === 'phonk' ? 'bass808' : 'bass'), style).toBeDefined();
    }
    expect(() => composeStyle('nope' as Style)).toThrow(/Unknown style/);
  });

  it('is deterministic per seed, and a different seed is a different song', () => {
    const a = composeStyle('lofi', { bars: 8, seed: 5 });
    expect(composeStyle('lofi', { bars: 8, seed: 5 })).toEqual(a);
    const b = composeStyle('lofi', { bars: 8, seed: 6 });
    expect(JSON.stringify(b.tracks.find((t) => t.instrument === 'pluck'))).not.toBe(JSON.stringify(a.tracks.find((t) => t.instrument === 'pluck')));
  });

  it('voice-led chords: every chord moves to the nearest voicing, and lofi chords carry sevenths', () => {
    const spec = composeStyle('lofi', { bars: 8, seed: 3 });
    const pad = trackOf(spec, 'pad')!;
    const byBar = new Map<number, number[]>();
    for (const n of pad.notes) byBar.set(barOf(n.t), [...(byBar.get(barOf(n.t)) ?? []), midiOf(n.n!)]);
    const voicings = [...byBar.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v.sort((p, q) => p - q));
    expect(voicings.length).toBe(8);
    let total = 0;
    voicings.slice(1).forEach((v, i) => {
      const prev = voicings[i]!;
      expect(v.length).toBe(prev.length);
      const move = v.reduce((a, m, k) => a + Math.abs(m - prev[k]!), 0);
      total += move;
      expect(move, `bar ${i + 2}`).toBeLessThanOrEqual(12); // smooth: a chord change moves its voices a few semitones in all
    });
    expect(total / 7).toBeLessThan(8);
    // sevenths: four different pitch classes in a chord (the epiano plays them)
    const ep = trackOf(spec, 'epiano')!;
    const first = ep.notes.filter((n) => barOf(n.t) === 0 && n.t < 0.2);
    expect(new Set(first.map((n) => midiOf(n.n!) % 12)).size).toBe(4);
    // a triad style stays triads
    const chip = trackOf(composeStyle('chiptune', { bars: 4, seed: 3 }), 'arp')!;
    const arpBar0 = chip.notes.filter((n) => n.t < 4).map((n) => midiOf(n.n!) % 12);
    expect(new Set(arpBar0).size).toBe(3);
  });

  it('develops its melody: 2-bar phrases differ in rhythm and contour instead of one motif repeated', () => {
    for (const style of ['lofi', 'chiptune', 'epic', 'action', 'tropical'] as Style[]) {
      const spec = composeStyle(style, { bars: 16, seed: 4 });
      const lead = trackOf(spec, spec.tracks.find((t) => ['pluck', 'lead', 'strings'].includes(t.instrument) && t.notes.length && (t.volume ?? 0) >= 0.8 && t.pan! > 0)!.instrument)!;
      const sigs = new Set<string>();
      for (let ph = 0; ph < 8; ph++) {
        const notes = lead.notes.filter((n) => n.t >= ph * 8 - 0.15 && n.t < ph * 8 + 8 - 0.15).sort((a, b) => a.t - b.t);
        const rhythm = notes.map((n) => Math.round((n.t - ph * 8) * 2) / 2).join(',');
        const contour = notes.slice(1).map((n, i) => Math.sign(midiOf(n.n!) - midiOf(notes[i]!.n!))).join('');
        sigs.add(`${rhythm}|${contour}`);
      }
      expect(sigs.size, style).toBeGreaterThanOrEqual(4);
    }
  });

  it('plays drum fills at the end of every 4th bar, a bigger one with a crash at the 8th, and sections change the groove', () => {
    const spec = composeStyle('action', { bars: 16, seed: 3 });
    const rolls = (bar: number): number => {
      let c = 0;
      for (const inst of ['snare', 'tom'] as Instrument[]) c += trackOf(spec, inst)!.notes.filter((n) => n.t >= bar * 4 + 2.4 && n.t < bar * 4 + 4 - 0.01 && (n.v ?? 0) > 0.3).length;
      return c;
    };
    expect(rolls(3)).toBeGreaterThanOrEqual(3);
    expect(rolls(7)).toBeGreaterThanOrEqual(5);
    expect(rolls(0)).toBeLessThanOrEqual(1);
    const crash = trackOf(spec, 'crash')!.notes.map((n) => Math.round(n.t / 4));
    expect(crash).toContain(0);
    expect(crash).toContain(8); // the section change
    // the B section's hats are denser than the A section's
    const hats = trackOf(spec, 'hat')!.notes;
    const a = hats.filter((n) => n.t >= 4 && n.t < 8).length;
    const b = hats.filter((n) => n.t >= 36 && n.t < 40).length;
    expect(b).toBeGreaterThan(a);
    expect(spec.sections).toEqual([{ name: 'A', bars: 8 }, { name: 'B', bars: 8 }]);
  });

  it('has a human feel: swing pushes the offbeats late, timing and velocity wander, a chip stays on the grid', () => {
    const lofi = composeStyle('lofi', { bars: 8, seed: 3 });
    const hat = trackOf(lofi, 'hat')!.notes;
    const off = hat.filter((n) => Math.abs((n.t % 1) - 0.5) < 0.2 && (n.t % 1) > 0.3);
    const median = off.map((n) => n.t % 1).sort((a, b) => a - b)[Math.floor(off.length / 2)]!;
    expect(median).toBeGreaterThan(0.55);
    expect(lofi.swing).toBeGreaterThan(0.4);
    const vels = hat.map((n) => n.v ?? 0.8);
    const mean = vels.reduce((a, b) => a + b, 0) / vels.length;
    expect(Math.sqrt(vels.reduce((a, v) => a + (v - mean) ** 2, 0) / vels.length)).toBeGreaterThan(0.08);
    const snare = trackOf(lofi, 'snare')!.notes.filter((n) => Math.abs((n.t % 2) - 1) < 0.1 || (n.t % 2) < 0.05);
    expect(snare.some((n) => Math.abs(n.t - Math.round(n.t)) > 0.002)).toBe(true); // not on the grid
    const chip = composeStyle('chiptune', { bars: 4, seed: 3 });
    const grid = (n: NoteEvent): boolean => Math.abs(n.t * 4 - Math.round(n.t * 4)) < 1e-6;
    expect(trackOf(chip, 'kick')!.notes.every(grid)).toBe(true);
    expect(trackOf(chip, 'hat')!.notes.every(grid)).toBe(true);
  });

  it('keeps its old spec format: a spec with only the original fields still renders', () => {
    const old: SongSpec = {
      bpm: 100,
      beats: 16,
      reverb: 0.3,
      tracks: [
        { instrument: 'pad', volume: 0.55, pan: -0.25, notes: [{ t: 0, d: 3.9, n: 'A3', v: 0.5 }, { t: 0, d: 3.9, n: 'C4', v: 0.5 }, { t: 0, d: 3.9, n: 'E4', v: 0.5 }] },
        { instrument: 'bass', notes: [{ t: 0, d: 1.5, n: 'A2' }, { t: 2, d: 1.5, n: 'E3', v: 0.7 }] },
        { instrument: 'kick', notes: [{ t: 0, d: 0.5 }, { t: 2, d: 0.5 }] },
      ],
    };
    const [L, R] = renderSong(old, 1);
    expect(L.length).toBe(R.length);
    expect(L.length / SR).toBeCloseTo((16 * 60) / 100, 1);
    expect(checkAudio([L, R], { category: 'music', loop: true }).ok).toBe(true);
  });
});

describe('song renderer', () => {
  const renders = new Map<Style, { L: Float32Array; R: Float32Array; spec: SongSpec }>();
  const render = (style: Style) => {
    if (!renders.has(style)) {
      const spec = composeStyle(style, { bars: style === 'phonk' ? 8 : 6, seed: 3 });
      const [L, R] = renderSong(spec, 7);
      renders.set(style, { L, R, spec });
    }
    return renders.get(style)!;
  };
  /** The gate the way AudioService runs it: the song's own loudness target and loop start. */
  const gate = (style: Style) => {
    const { L, R, spec } = render(style);
    return checkAudio([L, R], { category: 'music', loop: true, loopStart: songLoopStart(spec), ...(spec.loudness !== undefined ? { targetLufs: spec.loudness, measure: 'integrated' as const } : {}) });
  };

  it('masters every style to its loudness (-16 LUFS-I, phonk hotter) under -1 dBTP, with no DC and a seamless loop', () => {
    for (const style of STYLES) {
      const c = gate(style);
      expect(c.truePeakDb, style).toBeLessThanOrEqual(-1);
      expect(Math.abs(c.lufsI! - (render(style).spec.loudness ?? -16)), `${style} ${c.lufsI}`).toBeLessThanOrEqual(1);
      expect(Math.abs(c.dc), style).toBeLessThan(0.003);
      expect(c.seam!.ratio, `${style} seam`).toBeLessThan(2.5);
      expect(c.issues, `${style}: ${c.summary}`).toEqual([]);
    }
  }, 120_000);

  it('has top end and presence: not the 85-95 % below 500 Hz of the old mixes', () => {
    for (const style of STYLES) {
      const { L, R } = render(style);
      const sp = spectrum(L, R);
      expect(sp.low, `${style} low share`).toBeLessThan(0.9);
      expect(sp.presence, `${style} 2-6 kHz share`).toBeGreaterThan(0.02);
      expect(sp.centroid, `${style} centroid`).toBeGreaterThan(450);
    }
  });

  it('is wide with a mono bass: left and right decorrelated, nothing under 150 Hz in the sides', () => {
    for (const style of STYLES) {
      const { L, R } = render(style);
      const c = gate(style);
      expect(c.stereo!.correlation, `${style} corr`).toBeLessThan(0.96);
      expect(c.stereo!.sideMidDb, `${style} side/mid`).toBeGreaterThan(-18);
      expect(bassSideDb(L, R), `${style} bass side`).toBeLessThan(-18);
    }
  });

  it('wraps tails and reverb onto the start of the loop', () => {
    const base: SongSpec = { bpm: 120, beats: 8, reverb: 0.4, tracks: [{ instrument: 'bell', notes: [{ t: 7.5, d: 0.4, n: 'C6', v: 0.9 }] }, { instrument: 'pad', notes: [{ t: 0, d: 6, n: 'C3', v: 0.4 }] }] };
    const [L] = renderSong(base, 1);
    const silentBell: SongSpec = { ...base, tracks: [base.tracks[1]!] };
    const [L2] = renderSong(silentBell, 1);
    // the bell's ring (and its reverb) is in the first 0.5 s of the loop when it plays, and not otherwise
    const hf = (x: Float32Array): number => {
      const h = Float32Array.from(x.slice(0, 22050));
      Biquad.highpass(1500, 0.707).processBuffer(h);
      return h.reduce((a, v) => a + v * v, 0);
    };
    expect(hf(L)).toBeGreaterThan(hf(L2) * 3);
  });

  it('every instrument renders finite, bounded audio that ends without a step', () => {
    const insts: Instrument[] = [...PITCHED, 'kick', 'snare', 'rim', 'clap', 'hat', 'openhat', 'shaker', 'taiko', 'tom', 'crash'];
    for (const inst of insts) {
      const spec: SongSpec = { bpm: 120, beats: 8, reverb: 0, tracks: [{ instrument: inst, notes: [{ t: 0, d: 1, n: 'C4', v: 0.8 }] }] };
      const st = songStems(spec, 3)[0]!;
      let peak = 0;
      let finite = true;
      for (let i = 0; i < st.L.length; i++) {
        const v = st.L[i]!;
        const w = st.R[i]!;
        if (!Number.isFinite(v) || !Number.isFinite(w)) finite = false;
        peak = Math.max(peak, Math.abs(v), Math.abs(w));
      }
      expect(finite, `${inst} is finite`).toBe(true);
      expect(peak, inst).toBeGreaterThan(0.005);
      expect(peak, inst).toBeLessThan(4);
    }
  });

  it('a tonal track plays the pitch it is given', () => {
    const spec: SongSpec = { bpm: 120, beats: 4, reverb: 0, tracks: [{ instrument: 'lead', notes: [{ t: 0, d: 3, n: 'A4', v: 0.8 }] }] };
    const [L, R] = songStems(spec, 1).map((s) => [s.L, s.R])[0]!;
    const mono = Float32Array.from(L!, (v, i) => (v + R![i]!) * 0.5);
    const P = powerSpectrum(mono, 8000, 8192);
    // the strongest partial sits on the harmonic series of 440 Hz (a saw's second harmonic may beat the filtered first)
    let best = 3;
    for (let k = 3; k < P.length; k++) if (P[k]! > P[best]!) best = k;
    const ratio = (best * SR) / 8192 / 440;
    expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(0.02);
    // and the fundamental itself is there
    const bin440 = Math.round((440 / SR) * 8192);
    expect(Math.max(...Array.from(P.slice(bin440 - 2, bin440 + 3)))).toBeGreaterThan(P[best]! * 0.02);
  });
});
