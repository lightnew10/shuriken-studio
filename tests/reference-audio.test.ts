import { describe, expect, it } from 'vitest';
import { analyzeAudio, detectOnsets, estimateTempo, int16FromPcm, levelEnvelope, pcmFromInt16, silenceRatio, stft } from '../src/core/references/audio-features';
import { spectrogramStrips } from '../src/core/references/spectrogram';
import { decodePng } from '../src/core/modeling/png';

/**
 * The sound of a reference clip is measured, not heard: these are synthetic signals with known answers (clicks at
 * known times, a click track at a known tempo, half silence, a low thump among small clicks).
 */

const RATE = 22050;

/** A seeded noise source, so every run measures the same signal. */
function noise(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

function silence(seconds: number, floorDb = -70, seed = 3): Float32Array {
  const rnd = noise(seed);
  const a = Math.pow(10, floorDb / 20) * 2;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => rnd() * a);
}

/** A short bright click (a 3 ms decaying burst) added at time t. */
function addClick(x: Float32Array, t: number, amp = 0.6, hz = 2500): void {
  const s = Math.round(t * RATE);
  const rnd = noise(Math.round(t * 1000) + 7);
  for (let i = 0; i < RATE * 0.03 && s + i < x.length; i++) {
    const env = Math.exp(-i / (RATE * 0.004));
    x[s + i]! += amp * env * (0.7 * Math.sin((2 * Math.PI * hz * i) / RATE) + 0.3 * rnd() * 2);
  }
}

/** A low thump (60 Hz, 250 ms decay) added at time t. */
function addThump(x: Float32Array, t: number, amp = 0.9): void {
  const s = Math.round(t * RATE);
  for (let i = 0; i < RATE * 0.6 && s + i < x.length; i++) x[s + i]! += amp * Math.exp(-i / (RATE * 0.12)) * Math.sin((2 * Math.PI * 60 * i) / RATE);
}

function sine(seconds: number, hz: number, amp: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE));
}

describe('reference sound measurements', () => {
  it('finds clicks within a few milliseconds of where they are', () => {
    const times = [0.5, 1.21, 1.9, 2.663, 3.4, 4.371];
    const x = silence(5);
    for (const t of times) addClick(x, t);
    const onsets = detectOnsets(x, stft(x, RATE));
    for (const t of times) {
      const near = onsets.reduce((best, o) => (Math.abs(o.t - t) < Math.abs(best - t) ? o.t : best), Infinity);
      expect(Math.abs(near - t), `click at ${t}`).toBeLessThan(0.005);
    }
    expect(onsets.length).toBeLessThanOrEqual(times.length + 1);
  });

  it('reads a click track at 120 bpm as about 120, and 90 as about 90', () => {
    for (const bpm of [120, 90]) {
      const x = silence(16);
      for (let t = 0.25; t < 16; t += 60 / bpm) addClick(x, t, 0.5);
      const tempo = estimateTempo(stft(x, RATE));
      expect(tempo, `${bpm} bpm`).not.toBeNull();
      expect(Math.abs(tempo!.bpm - bpm), `${bpm} bpm read as ${tempo!.bpm}`).toBeLessThan(2);
      expect(tempo!.confidence).toBeGreaterThan(0.3);
    }
  });

  it('has no tempo for steady noise', () => {
    const rnd = noise(11);
    const x = Float32Array.from({ length: RATE * 10 }, () => rnd() * 0.2);
    expect(estimateTempo(stft(x, RATE))).toBeNull();
  });

  it('counts silence: two seconds of sound and two of nothing is half', () => {
    const rnd = noise(5);
    const x = new Float32Array(RATE * 4);
    for (let i = 0; i < RATE * 2; i++) x[i] = rnd() * 0.35;
    const env = levelEnvelope(x, RATE);
    expect(env.length).toBe(40);
    expect(Math.abs(silenceRatio(env) - 0.5)).toBeLessThan(0.03);
  });

  it('puts a low sine in the bass and a high one in the highs, and measures loudness', () => {
    const low = analyzeAudio(sine(3, 80, 0.3), RATE);
    expect(low.balance.bass).toBeGreaterThan(0.9);
    expect(low.centroidHz).toBeLessThan(300);
    const high = analyzeAudio(sine(3, 6000, 0.3), RATE);
    expect(high.balance.high).toBeGreaterThan(0.9);
    expect(high.centroidHz).toBeGreaterThan(4000);
    // A 1 kHz sine 20 dB under full scale: about -23.7 LUFS.
    const mid = analyzeAudio(sine(5, 1000, 0.1), RATE);
    expect(mid.integratedLufs).not.toBeNull();
    expect(mid.integratedLufs!).toBeGreaterThan(-25);
    expect(mid.integratedLufs!).toBeLessThan(-22.5);
    expect(Math.abs(mid.peakDb + 20)).toBeLessThan(0.5);
    expect(mid.silenceRatio).toBe(0);
  });

  it('ranks a low thump above small clicks and says it is low', () => {
    const x = silence(6);
    for (const t of [0.4, 1.1, 2.2, 3.9, 5.1]) addClick(x, t, 0.08);
    addThump(x, 3.0);
    const a = analyzeAudio(x, RATE, { maxEvents: 3 });
    const thump = a.events.find((e) => Math.abs(e.t - 3.0) < 0.01);
    expect(thump, JSON.stringify(a.events)).toBeTruthy();
    expect(thump!.character).toBe('low');
    expect(thump!.riseDb).toBeGreaterThan(20);
    expect(thump!.decayMs).toBeGreaterThan(150);
    // Events come in time order, at most as many as asked.
    expect(a.events.length).toBeLessThanOrEqual(3);
    expect([...a.events].sort((p, q) => p.t - q.t)).toEqual(a.events);
    expect(a.onsets).toBeGreaterThanOrEqual(5);
  });

  it('keeps a thump that comes right after a click out of digital silence (the self-test clip found this)', () => {
    const x = new Float32Array(RATE * 4);
    for (const t of [0.5, 1.04, 1.5, 2.0]) addClick(x, t, 0.4);
    addThump(x, 1.24);
    const a = analyzeAudio(x, RATE, { maxEvents: 2 });
    const thump = a.events.find((e) => Math.abs(e.t - 1.24) < 0.01);
    expect(thump?.character, JSON.stringify(a.events)).toBe('low');
  });

  it('round-trips 16-bit PCM', () => {
    const x = Float32Array.from([0, 0.5, -0.5, 0.999, -1]);
    const back = pcmFromInt16(int16FromPcm(x));
    for (let i = 0; i < x.length; i++) expect(Math.abs(back[i]! - x[i]!)).toBeLessThan(1e-3);
  });
});

describe('spectrogram pictures', () => {
  it('draws one PNG strip per stretch, the time it covers on each, with a lane for the level', () => {
    const x = silence(34);
    for (let t = 1; t < 34; t += 2) addClick(x, t, 0.4);
    addThump(x, 20);
    const a = analyzeAudio(x, RATE);
    const strips = spectrogramStrips(x, RATE, { stripSeconds: 15, events: a.events, onsets: a.onsetList });
    expect(strips.map((s) => [s.t0, s.t1])).toEqual([
      [0, 15],
      [15, 30],
      [30, 34],
    ]);
    const img = decodePng(strips[0]!.png);
    // Wide enough to see 23 ms steps (about 43 px a second), tall enough to read the bands.
    expect(img.width).toBeGreaterThan(15 * 40);
    expect(img.height).toBeGreaterThan(200);
    const last = decodePng(strips[2]!.png);
    expect(last.width).toBeLessThan(img.width);
    // Not a blank picture: the thump's strip has bright pixels in its low rows.
    const mid = decodePng(strips[1]!.png);
    let bright = 0;
    for (let i = 0; i < mid.data.length; i += 4) if (mid.data[i]! + mid.data[i + 1]! > 400) bright++;
    expect(bright).toBeGreaterThan(50);
  });
});
