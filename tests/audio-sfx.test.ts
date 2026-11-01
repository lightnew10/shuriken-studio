import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, Rng } from '../src/core/audio/dsp/util';
import { Biquad } from '../src/core/audio/dsp/filter';
import { powerSpectrum } from '../src/core/audio/dsp/fft';
import { checkAudio, measureLoudness } from '../src/core/audio/dsp/master';
import { SFX_PRESETS, renderSfx, renderTakes, renderVoice, varySfx, varyTake, type SfxParams } from '../src/core/audio/synth';

const SR = SAMPLE_RATE;

/** Welch-style spectrum (1024 Hann frames, 50 % overlap) of a signal, in power per bin. */
function welch(x: Float32Array, frames: number): Float64Array {
  const N = 1024;
  const acc = new Float64Array(N / 2 + 1);
  let n = 0;
  for (let s = 0; n < frames && s + N <= x.length; s += N / 2) {
    const P = powerSpectrum(x, s, N);
    for (let k = 0; k < P.length; k++) acc[k]! += P[k]!;
    n++;
  }
  return acc.map((v) => v / Math.max(1, n));
}

/** Log-spectral distance (dB rms over the bins up to 16 kHz) between two sounds' average spectra. */
function lsd(a: Float32Array, b: Float32Array): number {
  const frames = Math.floor((Math.min(a.length, b.length) - 1024) / 512);
  const A = welch(a, frames);
  const B = welch(b, frames);
  let e = 0;
  let c = 0;
  for (let k = 2; k < 372; k++) {
    const d = 10 * Math.log10((A[k]! + 1e-12) / (B[k]! + 1e-12));
    e += d * d;
    c++;
  }
  return Math.sqrt(e / c);
}

/** Peak of the band above `hz` in the first 15 ms against the whole sound's peak, in dB: how much front edge it has. */
function crackDb(x: Float32Array, hz = 3000): number {
  const h = Float32Array.from(x);
  Biquad.highpass(hz, 0.707).processBuffer(h);
  Biquad.highpass(hz, 0.707).processBuffer(h);
  let hp = 0;
  for (let i = 0; i < Math.round(0.015 * SR); i++) hp = Math.max(hp, Math.abs(h[i]!));
  let pk = 0;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  return 20 * Math.log10(hp / pk);
}

const maxAbs = (x: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
};

describe('sound effect presets', () => {
  it('every preset renders clean, passes the gate and lands on its category loudness', () => {
    for (const [name, p] of Object.entries(SFX_PRESETS)) {
      const x = renderSfx(p, 1);
      const c = checkAudio([x], { category: p.category ?? 'pickup' });
      expect(c.issues, `${name}: ${c.summary}`).toEqual([]);
      expect(Math.abs(c.target!.deltaLu!), name).toBeLessThanOrEqual(1.5);
      expect(x.length / SR, name).toBeLessThan(2);
      expect(Math.abs(x[0]!), name).toBeLessThan(2e-3);
      expect(Math.abs(x[x.length - 1]!), name).toBeLessThan(1e-4);
    }
  });

  it('combat sounds have a front edge: bright noise at the start, not one dull filtered burst', () => {
    for (const name of ['hit', 'punch', 'block', 'hurt', 'slam', 'explosion', 'clang', 'laser']) {
      const x = renderSfx(SFX_PRESETS[name]!, 1);
      expect(crackDb(x), `${name} crack`).toBeGreaterThan(-14);
      expect(crackDb(x, 6000), `${name} air`).toBeGreaterThan(-20);
    }
  });

  it('impacts are layered: transient, body and tail voices all contribute, and the sound has a tail', () => {
    for (const name of ['hit', 'punch', 'block', 'slam', 'explosion']) {
      const p = SFX_PRESETS[name]!;
      expect(p.layers!.length, name).toBeGreaterThanOrEqual(3);
      const whole = renderSfx(p, 1);
      const bodyOnly = renderSfx({ ...p, layers: undefined, room: undefined }, 1);
      // the layers make it brighter than its body voice alone and keep it ringing longer
      expect(lsd(whole, bodyOnly), name).toBeGreaterThan(3);
    }
    const boom = renderSfx(SFX_PRESETS.explosion!, 1);
    const tailStart = Math.round(0.6 * SR);
    expect(maxAbs(boom.slice(tailStart)), 'explosion tail').toBeGreaterThan(0.01);
  });

  it('voices: a modal bank rings at its partials, FM makes sidebands, crackle is sparse, crunch holds values', () => {
    const f0 = 800;
    const modal = renderVoice({ wave: 'modal', freq: f0, modes: [[1, 1, 1], [2.76, 0.7, 0.7], [5.4, 0.5, 0.5]], attack: 0.0005, sustain: 0, decay: 0.4, volume: 1 }, 1);
    const P = powerSpectrum(modal, 200, 4096);
    const bin = (hz: number): number => Math.round((hz / SR) * 4096);
    const at = (hz: number): number => Math.max(...Array.from(P.slice(bin(hz) - 3, bin(hz) + 4)));
    const floor = P.slice(bin(1300), bin(1700)).reduce((a, b) => Math.max(a, b), 0);
    expect(at(f0)).toBeGreaterThan(floor * 100);
    expect(at(f0 * 2.76)).toBeGreaterThan(floor * 30);
    expect(at(f0 * 5.4)).toBeGreaterThan(floor * 10);

    const fm = renderVoice({ wave: 'fm', freq: 600, fmRatio: 2, fmIndex: 3, fmDecay: 5, attack: 0.001, sustain: 0.3, decay: 0.1, volume: 1 }, 1);
    const Pf = powerSpectrum(fm, 2000, 4096);
    const bf = (hz: number): number => Math.max(...Array.from(Pf.slice(Math.round((hz / SR) * 4096) - 2, Math.round((hz / SR) * 4096) + 3)));
    expect(bf(600 + 1200)).toBeGreaterThan(bf(600) * 0.01); // first upper sideband exists
    expect(bf(600 + 2400)).toBeGreaterThan(bf(600) * 0.001);

    const grains = renderVoice({ wave: 'white', freq: 1000, crackle: 40, grain: 0.003, attack: 0.001, sustain: 0.5, decay: 0.1, volume: 1 }, 5);
    const rms = Math.sqrt(grains.reduce((a, v) => a + v * v, 0) / grains.length);
    const quiet = grains.filter((v) => Math.abs(v) < rms * 0.05).length / grains.length;
    expect(quiet).toBeGreaterThan(0.5); // mostly silence between the grains

    const steps = renderVoice({ wave: 'crunch', freq: 400, attack: 0.001, sustain: 0.3, decay: 0.05, volume: 1 }, 2);
    let changes = 0;
    const from = Math.round(0.02 * SR);
    const to = Math.round(0.3 * SR);
    for (let i = from + 1; i < to; i++) if (Math.abs(steps[i]! - steps[i - 1]!) > 1e-4) changes++;
    expect(changes / ((to - from) / SR)).toBeLessThan(500); // the 400 steps per second of its rate, not one value per sample
    expect(changes / ((to - from) / SR)).toBeGreaterThan(300);
  });

  it('keeps the old sfxr-style parameters working: they render clean and mastered', () => {
    const legacy: SfxParams = {
      wave: 'square', freq: 440, slide: -1, deltaSlide: 0.5, attack: 0.01, sustain: 0.1, decay: 0.2, punch: 0.4, duty: 0.3, vibratoDepth: 0.05, vibratoSpeed: 10, arpMul: 1.5, arpTime: 0.05,
      lowpass: 3000, lowpassSweep: -2000, highpass: 100, repeat: 0.12, volume: 0.5,
      layers: [{ wave: 'noise', freq: 900, slide: -2, attack: 0.001, sustain: 0.02, decay: 0.1, lowpass: 3000, volume: 0.6, delay: 0.02 }],
    };
    const x = renderSfx(legacy, 1);
    const c = checkAudio([x], { category: 'pickup' });
    expect(c.issues, c.summary).toEqual([]);
    expect(renderSfx(legacy, 1)).toEqual(x); // deterministic
    expect(renderSfx(legacy, 2)).not.toEqual(x); // another seed, another noise
  });

  it('takes differ in grain and balance, not only pitch, and stay at the same loudness', () => {
    for (const name of ['hit', 'punch', 'footstep', 'swing', 'slam']) {
      const p = SFX_PRESETS[name]!;
      const takes = renderTakes(p, 4);
      const main = takes[0]!;
      const L0 = measureLoudness([main]).momentaryMax;
      for (let k = 1; k < 4; k++) {
        const t = takes[k]!;
        expect(Math.abs(measureLoudness([t]).momentaryMax - L0), `${name} take ${k + 1} loudness`).toBeLessThanOrEqual(1);
        expect(lsd(main, t), `${name} take ${k + 1} vs main`).toBeGreaterThan(2);
        // against the old way of varying (pitch and length only): there is more to it
        const pitchOnly = renderSfx(varySfx(p, 1 + (k % 2 ? 1 : -1) * 0.04 * Math.ceil(k / 2), 1 + 0.05 * k), 1);
        expect(lsd(pitchOnly, t), `${name} take ${k + 1} vs pitch-only`).toBeGreaterThan(1.5);
      }
    }
    // take 1 is the sound itself; takes are reproducible
    expect(varyTake(SFX_PRESETS.hit!, 0)).toBe(SFX_PRESETS.hit);
    expect(renderTakes(SFX_PRESETS.hit!, 3)[2]).toEqual(renderTakes(SFX_PRESETS.hit!, 3)[2]);
  });

  it('the room is a small send: a hit with room is longer than without but stays short', () => {
    const p = SFX_PRESETS.hit!;
    const dry = renderSfx({ ...p, room: 0 }, 1);
    const wet = renderSfx(p, 1);
    expect(wet.length).toBeGreaterThanOrEqual(dry.length);
    expect(wet.length / SR).toBeLessThan(0.9);
    const r = new Rng(1);
    expect(r.next()).toBeGreaterThanOrEqual(0);
  });
});
