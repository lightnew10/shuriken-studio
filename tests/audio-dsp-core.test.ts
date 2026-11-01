import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, Rng } from '../src/core/audio/dsp/util';
import { Osc, naiveSaw, naiveSquare, naiveTriangle, polyBlep, polyBlep4 } from '../src/core/audio/dsp/osc';
import { Noise } from '../src/core/audio/dsp/noise';
import { Biquad, OnePole, Svf } from '../src/core/audio/dsp/filter';
import { adsr, breakpoints, sweep } from '../src/core/audio/dsp/env';
import { reverbWet } from '../src/core/audio/dsp/reverb';
import { Saturator, compress, delayWet, saturate } from '../src/core/audio/dsp/fx';
import { powerSpectrum } from '../src/core/audio/dsp/fft';

const SR = SAMPLE_RATE;

const sine = (f: number, secs: number, amp = 1): Float32Array => Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
const mean = (x: Float32Array): number => x.reduce((a, b) => a + b, 0) / x.length;
const maxAbs = (x: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
};

/** Inharmonic over harmonic energy (dB) of a steady tone, the way the measurement script does it. */
function aliasingDb(x: Float32Array, f0: number): number {
  const N = 16384;
  const P = powerSpectrum(x, 4410, N);
  const bin = SR / N;
  let harmonic = 0;
  let other = 0;
  for (let k = 3; k < P.length; k++) {
    const f = k * bin;
    const h = Math.round(f / f0);
    if (h >= 1 && Math.abs(f - h * f0) <= 5 * bin) harmonic += P[k]!;
    else other += P[k]!;
  }
  return 10 * Math.log10(other / harmonic);
}

function tone(f: number, gen: (osc: Osc, phase: number) => number): Float32Array {
  const x = new Float32Array(SR);
  const o = new Osc(0);
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = gen(o, p);
    p += f / SR;
  }
  return x;
}

describe('oscillators', () => {
  it('PolyBLEP saw and pulse alias far less than the naive waveforms (22+ dB at 1-3.5 kHz)', () => {
    for (const f of [988, 1760, 3520]) {
      const naiveSawDb = aliasingDb(tone(f, (_o, p) => naiveSaw(p)), f);
      const blepSawDb = aliasingDb(tone(f, (o) => o.saw(f)), f);
      const naiveSqDb = aliasingDb(tone(f, (_o, p) => naiveSquare(p)), f);
      const blepSqDb = aliasingDb(tone(f, (o) => o.pulse(f, 0.5)), f);
      expect(blepSawDb, `saw ${f}`).toBeLessThan(naiveSawDb - 22);
      expect(blepSqDb, `square ${f}`).toBeLessThan(naiveSqDb - 22);
      expect(blepSawDb, `saw ${f}`).toBeLessThan(-36);
      expect(blepSqDb, `square ${f}`).toBeLessThan(-36);
    }
    // The four-point residual beats the two-point one (it is why saw and pulse use it).
    const two = tone(1760, (_o, p) => {
      const q = p - Math.floor(p);
      return 1 - 2 * q + polyBlep(q, 1760 / SR);
    });
    const four = tone(1760, (o) => o.saw(1760));
    expect(aliasingDb(four, 1760)).toBeLessThan(aliasingDb(two, 1760) - 6);
    expect(polyBlep4(0.5, 0.01)).toBe(0); // away from the edge nothing changes
  });

  it('PolyBLAMP triangle aliases less than the naive one where it matters (3.5 kHz)', () => {
    const naive = aliasingDb(tone(3520, (_o, p) => naiveTriangle(p)), 3520);
    const blamp = aliasingDb(tone(3520, (o) => o.triangle(3520)), 3520);
    expect(blamp).toBeLessThan(naive - 8);
  });

  it('every waveform is DC-free and bounded, whatever the duty', () => {
    for (const duty of [0.1, 0.25, 0.5, 0.8]) {
      const x = tone(220, (o) => o.pulse(220, duty));
      expect(Math.abs(mean(x)), `duty ${duty}`).toBeLessThan(2e-3);
    }
    const gens: Array<[string, (o: Osc) => number]> = [
      ['saw', (o) => o.saw(330)],
      ['triangle', (o) => o.triangle(330)],
      ['sine', (o) => o.sine(330)],
    ];
    for (const [name, gen] of gens) {
      const x = tone(330, gen);
      expect(Math.abs(mean(x)), name).toBeLessThan(2e-3);
      expect(maxAbs(x), name).toBeLessThan(1.7);
    }
  });

  it('the phase stays continuous through a pitch slide (no clicks)', () => {
    const o = new Osc(0);
    let prev = 0;
    let worst = 0;
    for (let i = 0; i < SR / 2; i++) {
      const f = 200 * Math.pow(2, (3 * i) / SR);
      const y = o.sine(f);
      if (i) worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    // The biggest step of a sine at 565 Hz is 2*pi*f/fs = 0.08; there are no jumps beyond that.
    expect(worst).toBeLessThan(0.09);
  });
});

describe('noise', () => {
  it('white, pink and brown have the right slopes and the same level', () => {
    const slopes: Record<string, number> = { white: 3.01, pink: 0, brown: -3.01 }; // dB per octave band
    for (const c of ['white', 'pink', 'brown'] as const) {
      const n = new Noise(7);
      const x = new Float32Array(1 << 18);
      for (let i = 0; i < x.length; i++) x[i] = n.color(c);
      const rms = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
      expect(rms, c).toBeGreaterThan(0.4);
      expect(rms, c).toBeLessThan(0.6);
      const N = 4096;
      const acc = new Float64Array(N / 2 + 1);
      for (let s = 0; s + N <= x.length; s += N) {
        const P = powerSpectrum(x, s, N);
        for (let k = 0; k < P.length; k++) acc[k]! += P[k]!;
      }
      const band = (lo: number): number => {
        let e = 0;
        for (let k = 0; k < acc.length; k++) {
          const f = (k * SR) / N;
          if (f >= lo && f < 2 * lo) e += acc[k]!;
        }
        return 10 * Math.log10(e);
      };
      const bands = [250, 500, 1000, 2000, 4000].map(band);
      const slope = (bands[4]! - bands[0]!) / 4;
      expect(Math.abs(slope - slopes[c]!), `${c} slope ${slope.toFixed(2)} dB/oct`).toBeLessThan(0.9);
    }
  });

  it('crunch is the old stepped noise: it holds a value, so it is dark', () => {
    const n = new Noise(3);
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = n.crunch(500);
    let runs = 0;
    for (let i = 1; i < x.length; i++) if (x[i] !== x[i - 1]) runs++;
    expect(runs).toBeLessThan(600);
    expect(runs).toBeGreaterThan(400);
  });

  it('is deterministic for a seed', () => {
    const a = new Noise(11);
    const b = new Noise(11);
    for (let i = 0; i < 100; i++) expect(a.pink()).toBe(b.pink());
  });
});

describe('filters and envelopes', () => {
  const gainAt = (f: Svf, hz: number, pick: (f: Svf) => number): number => {
    let peak = 0;
    for (let i = 0; i < SR / 2; i++) {
      f.process(Math.sin((2 * Math.PI * hz * i) / SR));
      if (i > SR / 4) peak = Math.max(peak, Math.abs(pick(f)));
    }
    return peak;
  };

  it('state-variable filter: 12 dB/octave low-pass, resonance peak, band-pass centre', () => {
    const lp = () => new Svf(1000, 0.707);
    expect(gainAt(lp(), 1000, (f) => f.lp)).toBeCloseTo(0.707, 2);
    expect(gainAt(lp(), 4000, (f) => f.lp)).toBeLessThan(0.07); // two octaves up: about -24 dB
    expect(gainAt(lp(), 100, (f) => f.lp)).toBeGreaterThan(0.99);
    expect(gainAt(new Svf(1000, 6), 1000, (f) => f.lp)).toBeCloseTo(6, 0);
    expect(gainAt(new Svf(1000, 2), 1000, (f) => f.bandpass)).toBeCloseTo(1, 1);
    expect(gainAt(new Svf(1000, 2), 250, (f) => f.bandpass)).toBeLessThan(0.45);
    expect(gainAt(new Svf(1000, 0.707), 100, (f) => f.hp)).toBeLessThan(0.05);
  });

  it('stays stable and bounded when the cutoff moves on every sample', () => {
    const f = new Svf(500, 8);
    const r = new Rng(3);
    let worst = 0;
    for (let i = 0; i < SR; i++) {
      f.set(100 + 9000 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 7 * i) / SR)), 8);
      const y = f.process(r.bipolar());
      expect(Number.isFinite(y)).toBe(true);
      worst = Math.max(worst, Math.abs(y));
    }
    expect(worst).toBeLessThan(40);
  });

  it('biquads put the gain where they say', () => {
    const response = (b: Biquad, hz: number): number => {
      let peak = 0;
      for (let i = 0; i < SR / 2; i++) {
        const y = b.process(Math.sin((2 * Math.PI * hz * i) / SR));
        if (i > SR / 4) peak = Math.max(peak, Math.abs(y));
      }
      return 20 * Math.log10(peak);
    };
    expect(response(Biquad.highShelf(4000, 6), 12000)).toBeCloseTo(6, 0);
    expect(response(Biquad.highShelf(4000, 6), 200)).toBeCloseTo(0, 0);
    expect(response(Biquad.peaking(2000, 1, 5), 2000)).toBeCloseTo(5, 0);
    expect(response(Biquad.lowShelf(200, -4), 40)).toBeCloseTo(-4, 0);
    expect(response(Biquad.highpass(100), 25)).toBeLessThan(-20);
    const dc = new OnePole(20);
    let y = 0;
    for (let i = 0; i < SR; i++) y = dc.hp(1);
    expect(Math.abs(y)).toBeLessThan(1e-3);
  });

  it('exponential ADSR: smooth attack, decay to the sustain level, release to exact silence', () => {
    expect(adsr(0, 1, 0.01, 0.2, 0.5, 0.3)).toBe(0);
    expect(adsr(0.005, 1, 0.01, 0.2, 0.5, 0.3)).toBeCloseTo(0.5, 2);
    expect(adsr(0.01, 1, 0.01, 0.2, 0.5, 0.3)).toBeCloseTo(1, 2);
    expect(adsr(0.9, 1, 0.01, 0.2, 0.5, 0.3)).toBeCloseTo(0.5, 2);
    // exponential, not linear: partway through the decay it is well under the straight line
    expect(adsr(0.06, 1, 0.01, 0.2, 0.5, 0.3)).toBeLessThan(0.82);
    expect(adsr(1.0, 1, 0.01, 0.2, 0.5, 0.3)).toBeCloseTo(0.5, 2); // continuous at note-off
    expect(adsr(1.3, 1, 0.01, 0.2, 0.5, 0.3)).toBe(0);
    let prev = adsr(1, 1, 0.01, 0.2, 0.5, 0.3);
    for (let t = 1.001; t < 1.3; t += 0.001) {
      const v = adsr(t, 1, 0.01, 0.2, 0.5, 0.3);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    expect(sweep(0.5, 0, 1, 100, 400)).toBeCloseTo(200, 3); // exponential midpoint
    expect(breakpoints([[0, 0], [1, 1], [2, 0]], 1.5)).toBeCloseTo(0.5, 5);
  });
});

describe('effects', () => {
  const energy = (a: Float32Array, from: number, to: number): number => {
    let e = 0;
    for (let i = from; i < to; i++) e += a[i]! * a[i]!;
    return e;
  };

  it('reverb: wet only, damped, decorrelated left/right, longer with a bigger room', () => {
    const n = SR * 3;
    const x = new Float32Array(n);
    const r = new Noise(2);
    for (let i = 0; i < 4410; i++) x[i] = r.white();
    const [L, R] = reverbWet(x, null, { room: 0.5, damp: 0.7, size: 1 });
    expect(energy(L, 0, 150)).toBeLessThan(energy(L, 0, n) * 1e-3); // nothing dry in it
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < n; i++) {
      lr += L[i]! * R[i]!;
      ll += L[i]! ** 2;
      rr += R[i]! ** 2;
    }
    expect(Math.abs(lr / Math.sqrt(ll * rr))).toBeLessThan(0.15);
    // damping: high frequencies in the tail die faster than lows
    const hp = Float32Array.from(L);
    Biquad.highpass(4000).processBuffer(hp);
    const lp = Float32Array.from(L);
    Biquad.lowpass(400).processBuffer(lp);
    const ratio = (a: Float32Array): number => energy(a, SR, SR * 2) / energy(a, 4410, 4410 + SR / 4);
    expect(ratio(hp)).toBeLessThan(ratio(lp));
    // room and size set the length
    const tail = (room: number, size: number): number => {
      const [wl] = reverbWet(x, null, { room, damp: 0.5, size });
      return energy(wl, SR, SR * 2) / energy(wl, 4410, 4410 + SR / 4);
    };
    expect(tail(0.8, 1)).toBeGreaterThan(tail(0.3, 0.4) * 3);
  });

  it('the reverb of a loop wraps its tail into the start', () => {
    const n = SR;
    const x = new Float32Array(n);
    x[n - 100] = 1; // a click just before the end
    const [wet] = reverbWet(x, null, { room: 0.6, damp: 0.4, size: 0.8, loop: true });
    expect(energy(wet, 0, 6000)).toBeGreaterThan(1e-7); // the tail came around
    const [dry] = reverbWet(x, null, { room: 0.6, damp: 0.4, size: 0.8 });
    expect(energy(dry, 0, 6000)).toBe(0);
  });

  it('saturator keeps the peak, lifts what is under it, and is bounded', () => {
    const y = sine(200, 0.5, 0.9);
    saturate(y, 3);
    expect(maxAbs(y)).toBeGreaterThan(0.9);
    expect(maxAbs(y)).toBeLessThanOrEqual(1.01);
    const s = new Saturator(3);
    let q = 0;
    for (let i = 0; i < 2000; i++) q = Math.max(q, Math.abs(s.process(0.2 * Math.sin((2 * Math.PI * 200 * i) / SR))));
    expect(q).toBeGreaterThan(0.2); // 0.2 in comes out louder than 0.2: the top is compressed, the rest normalised up
    expect(new Saturator(5).process(0)).toBe(0);
  });

  it('compressor reduces by the ratio above the threshold and leaves quiet signals alone', () => {
    const loud = sine(200, 1, 0.9);
    const r = compress([loud], { thresholdDb: -12, ratio: 4, attackMs: 3, releaseMs: 80, kneeDb: 0 });
    const settled = maxAbs(loud.slice(SR / 2));
    const expected = Math.pow(10, (-12 + (20 * Math.log10(0.9) + 12) / 4) / 20);
    expect(Math.abs(20 * Math.log10(settled / expected))).toBeLessThan(1.2);
    expect(r.maxReductionDb).toBeGreaterThan(4);
    const quiet = sine(200, 0.5, 0.1);
    const copy = Float32Array.from(quiet);
    compress([copy], { thresholdDb: -12, ratio: 4, attackMs: 3, releaseMs: 80 });
    expect(Math.max(...copy.map((v, i) => Math.abs(v - quiet[i]!)))).toBeLessThan(1e-3);
  });

  it('delay repeats at the set time and fades by the feedback', () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < 2205; i++) x[i] = Math.sin((2 * Math.PI * 500 * i) / SR) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 2205)); // a 50 ms burst
    const [L, R] = delayWet(x, null, { timeL: 0.1, timeR: 0.15, feedback: 0.5, highCutHz: 18000, lowCutHz: 20 });
    const peakIn = (a: Float32Array, from: number): number => maxAbs(a.slice(from, from + 2205));
    const d = Math.round(0.1 * SR);
    const first = peakIn(L, d);
    const second = peakIn(L, 2 * d);
    expect(first).toBeGreaterThan(0.9);
    expect(second / first).toBeGreaterThan(0.4);
    expect(second / first).toBeLessThan(0.6);
    expect(peakIn(R, Math.round(0.15 * SR))).toBeGreaterThan(0.9);
    expect(maxAbs(L.slice(0, d - 100))).toBeLessThan(0.01); // wet only: nothing before the first repeat
  });
});
