import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, Rng, dbToLin } from '../src/core/audio/dsp/util';
import { Biquad } from '../src/core/audio/dsp/filter';
import { powerSpectrum } from '../src/core/audio/dsp/fft';
import { clipLows, shapeTransients } from '../src/core/audio/dsp/fx';
import { TRUE_PEAK_CEILING_DB, checkAudio, clipTruePeaks, master, truePeakDb } from '../src/core/audio/dsp/master';
import { SPACES, SPACE_MODELS, spaceWet } from '../src/core/audio/dsp/space';
import { MATERIALS, materialModes } from '../src/core/audio/dsp/modal';
import { analyzeSound, critiqueSound, guessKind, takeDifference } from '../src/core/audio/dsp/analyze';
import { SFX_PRESETS, isStereoSfx, lintSfx, renderSfx, renderSfxChannels, renderVoice, type SfxParams } from '../src/core/audio/synth';
import { bedParams, designSfx, sfxParams } from '../src/core/audio/sfx-design';

const SR = SAMPLE_RATE;
const rms = (x: ArrayLike<number>, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};
const db = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));
const peak = (x: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
};
const noise = (n: number, seed = 1, level = 0.3): Float32Array => {
  const r = new Rng(seed);
  return Float32Array.from({ length: n }, () => r.bipolar() * level);
};

/** A flat burst the way the first agent-made weapons were: noise and a thump held at full level for 0.1 s. */
const flatShot: SfxParams = {
  wave: 'noise', freq: 440, lowpass: 6000, lowpassEnd: 1500, attack: 0.001, sustain: 0.03, decay: 0.06, drive: 0.5, volume: 0.7, category: 'impact',
  layers: [{ wave: 'sine', freq: 160, freqEnd: 55, pitchTime: 0.06, decay: 0.11, volume: 0.9, drive: 0.4 }, { wave: 'noise', freq: 440, highpass: 2000, decay: 0.03, volume: 0.6 }],
};

/** The same gun designed in layers: a crack, a held noise body, a thump, a place. */
const designedShot: Partial<SfxParams> = {
  wave: 'white', highpass: 3000, attack: 0.0003, decay: 0.03, volume: 2.2,
  layers: [
    { wave: 'pink', freq: 1, lowpass: 9000, lowpassEnd: 900, sweepTime: 0.12, sustain: 0.05, decay: 0.3, drive: 0.5, volume: 1.8 },
    { wave: 'sine', freq: 160, freqEnd: 50, pitchTime: 0.05, decay: 0.22, drive: 0.5, volume: 1 },
    { wave: 'brown', freq: 1, lowpass: 180, decay: 0.25, volume: 0.8 },
  ],
  clip: 0.7, weight: 0.5, space: 'outdoor', spaceMix: 0.18, spaceDecay: 0.6,
};

describe('the tools that give a hit its front edge', () => {
  it('the transient designer raises attacks and leaves steady noise and decays alone', () => {
    // 150 ms of silence, then a noise burst that starts at full level and stays there.
    const n = Math.round(0.6 * SR);
    const x = noise(n, 3);
    for (let i = 0; i < Math.round(0.15 * SR); i++) x[i] = 0;
    const y = Float32Array.from(x);
    shapeTransients([y], { attackDb: 6, snap: 0 });
    const at = Math.round(0.15 * SR);
    const front = db(rms(y, at, at + 441)) - db(rms(x, at, at + 441));
    const later = db(rms(y, at + Math.round(0.2 * SR), n)) - db(rms(x, at + Math.round(0.2 * SR), n));
    expect(front).toBeGreaterThan(4);
    expect(front).toBeLessThanOrEqual(6.1);
    expect(Math.abs(later)).toBeLessThan(0.3);
    // A negative amount softens the same front.
    const z = Float32Array.from(x);
    shapeTransients([z], { attackDb: -6 });
    expect(db(rms(z, at, at + 441)) - db(rms(x, at, at + 441))).toBeLessThan(-3);
  });

  it('the peak clipper stops at its threshold and does not touch what is under the knee', () => {
    const n = 4000;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / SR) * (i < 2000 ? 0.4 : 1.6));
    const y = Float32Array.from(x);
    const r = clipTruePeaks([y], 1, 0.7);
    expect(peak(y)).toBeLessThanOrEqual(1.0001);
    expect(truePeakDb([y])).toBeLessThan(0.3);
    expect(r.reductionDb).toBeGreaterThan(3);
    for (let i = 0; i < 1990; i++) expect(y[i]).toBe(x[i]);
    // clipLows: the lows give way by at most what it is allowed, and only where the sum is over.
    const low = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 80 * i) / SR) * 0.9);
    const hi = noise(n, 5, 0.25);
    Biquad.highpass(3000, 0.707).processBuffer(hi);
    const mix = Float32Array.from(low, (v, i) => v + hi[i]!);
    const out = Float32Array.from(mix);
    const c = clipLows([out], 1, 3);
    expect(c.reductionDb).toBeGreaterThan(0);
    expect(c.reductionDb).toBeLessThanOrEqual(3.01);
    // The highs come through as they were: what changed is all under 250 Hz.
    const diff = Float32Array.from(out, (v, i) => v - mix[i]!);
    const diffHigh = Float32Array.from(diff);
    Biquad.highpass(2000, 0.707).processBuffer(diffHigh);
    expect(rms(diffHigh)).toBeLessThan(rms(diff) * 0.1);
  });

  it('mastering a struck sound clips instead of limiting: same loudness, same ceiling, more front', () => {
    const p = SFX_PRESETS.hit!;
    const dry = renderSfx({ ...p, category: 'pickup', clip: 0.75, transient: 0 }, 1);
    // The same pre-master signal through both paths: scale it up so each has to take 6 dB off.
    const a = Float32Array.from(dry, (v) => v * 4);
    const b = Float32Array.from(a);
    const limited = master([a], { category: 'impact' });
    const clipped = master([b], { category: 'impact', clipDb: 6 });
    expect(limited.limiterDb).toBeGreaterThan(3);
    expect(clipped.limiterDb).toBeLessThan(1.5);
    expect(clipped.clipDb).toBeGreaterThan(1);
    expect(truePeakDb([b])).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DB + 0.05);
    expect(Math.abs(clipped.loudness! - -12)).toBeLessThanOrEqual(0.5);
    expect(clipped.loudness!).toBeGreaterThanOrEqual(limited.loudness! - 0.1);
    const front = (x: Float32Array): number => analyzeSound([x]).punchDb!;
    expect(front(b)).toBeGreaterThanOrEqual(front(a));
  });

  it('impacts and footsteps get a front edge by default; other categories render as they did in 1.9', () => {
    const before = analyzeSound([renderSfx({ ...flatShot, transient: 0 }, 1)]).punchDb!;
    const after = analyzeSound([renderSfx(flatShot, 1)]).punchDb!;
    expect(after).toBeGreaterThan(before + 1);
    const c = checkAudio([renderSfx(flatShot, 1)], { category: 'impact' });
    expect(c.issues, c.summary).toEqual([]);
    // A sound outside those categories, with every old feature in it: the samples the 1.9 engine produced.
    const legacy: SfxParams = {
      wave: 'square', freq: 440, slide: -1, deltaSlide: 0.5, attack: 0.01, sustain: 0.1, decay: 0.2, punch: 0.4, duty: 0.3, vibratoDepth: 0.05, vibratoSpeed: 10, arpMul: 1.5, arpTime: 0.05, lowpass: 3000, lowpassSweep: -2000, highpass: 100, repeat: 0.12, volume: 0.5, room: 0.2, roomSize: 0.3,
      layers: [{ wave: 'noise', freq: 900, attack: 0.001, decay: 0.1, lowpass: 3000, volume: 0.6, delay: 0.02 }, { wave: 'modal', freq: 700, modes: [[1, 1, 1], [2.4, 0.5, 0.6]], decay: 0.2, volume: 0.4 }, { wave: 'fm', freq: 300, fmRatio: 2, fmIndex: 2, decay: 0.15, volume: 0.3 }],
    };
    const x = renderSfx(legacy, 1);
    expect(x.length).toBe(25358);
    const want: Array<[number, number]> = [[100, -0.130342], [1000, 0.198028], [5000, 0.322682], [9000, -0.004825], [14000, -0.015155]];
    for (const [i, v] of want) expect(x[i]!, `sample ${i}`).toBeCloseTo(v, 4);
  });
});

describe('spaces', () => {
  it('every space decays as its model says, gets denser and darker, and is different left and right', () => {
    for (const name of SPACES) {
      const m = SPACE_MODELS[name];
      const x = new Float32Array(Math.round(SR * Math.min(3.5, m.rt60 + 0.8)));
      x[0] = 1;
      const [l, r] = spaceWet(x, null, name);
      // Schroeder curve: the time the remaining energy is 60 dB down.
      let acc = 0;
      const edc = new Float64Array(l.length);
      for (let i = l.length - 1; i >= 0; i--) {
        acc += l[i]! * l[i]! + r[i]! * r[i]!;
        edc[i] = acc;
      }
      let t60 = l.length;
      for (let i = 0; i < edc.length; i++)
        if (edc[i]! < edc[0]! * 1e-6) {
          t60 = i;
          break;
        }
      expect(t60 / SR, `${name} decay`).toBeGreaterThan(m.rt60 * 0.6);
      expect(t60 / SR, `${name} decay`).toBeLessThan(m.rt60 * 1.3);
      let lr = 0, ll = 0, rr = 0;
      for (let i = 0; i < l.length; i++) {
        lr += l[i]! * r[i]!;
        ll += l[i]! * l[i]!;
        rr += r[i]! * r[i]!;
      }
      expect(Math.abs(lr / Math.sqrt(ll * rr)), `${name} left/right`).toBeLessThan(0.5);
      // Darker with time: the share above 4 kHz falls from the first 50 ms to the stretch after 300 ms.
      const high = Float32Array.from(l);
      Biquad.highpass(4000, 0.707).processBuffer(high);
      const a = Math.round(0.05 * SR);
      const b = Math.round(0.3 * SR);
      const early = rms(high, 0, a) / rms(l, 0, a);
      const late = rms(high, b, b + 4 * a) / rms(l, b, b + 4 * a);
      expect(late, `${name} gets darker`).toBeLessThan(early);
    }
  });

  it('spaceMix is the energy of the place against the dry sound, and a shot in a place has a tail', () => {
    const dry = renderSfx({ ...flatShot, category: 'pickup' }, 1);
    const wet = renderSfx({ ...flatShot, category: 'pickup', space: 'outdoor', spaceMix: 0.3 }, 1);
    expect(wet.length).toBeGreaterThan(dry.length + 0.4 * SR);
    const a = analyzeSound([dry]);
    const b = analyzeSound([wet]);
    expect(b.t40Ms!).toBeGreaterThan(a.t40Ms! + 150);
    // Mono by default; the gate still passes with the tail.
    expect(isStereoSfx({ ...flatShot, space: 'outdoor' })).toBe(false);
    expect(checkAudio([wet], { category: 'pickup' }).issues).toEqual([]);
  });

  it('distance takes the highs and the edge away', () => {
    const near = analyzeSound([renderSfx({ ...flatShot, category: 'pickup' }, 1)]);
    const far = analyzeSound([renderSfx({ ...flatShot, category: 'pickup', distance: 0.8, space: 'outdoor' }, 1)]);
    expect(far.bands.presence).toBeLessThan(near.bands.presence - 6);
    expect(far.edgeAirDb).toBeLessThan(near.edgeAirDb - 6);
  });
});

describe('struck materials', () => {
  it('a material is a dozen or more modes whose highs are weaker and die first, the same object every time', () => {
    for (const material of MATERIALS) {
      const modes = materialModes(material, { count: 14, seed: 520 });
      expect(modes.length, material).toBe(14);
      for (let k = 1; k < modes.length; k++) expect(modes[k]![2], `${material} decay`).toBeLessThanOrEqual(modes[0]![2] + 1e-9);
      expect(modes[13]![2], material).toBeLessThan(modes[1]![2]);
      expect(materialModes(material, { count: 14, seed: 520 })).toEqual(modes);
      // Another hit on the same object: the same pitches, another balance.
      const other = materialModes(material, { count: 14, seed: 520, strike: 1 });
      expect(other.map((m) => m[0])).toEqual(modes.map((m) => m[0]));
      expect(other.map((m) => m[1])).not.toEqual(modes.map((m) => m[1]));
    }
    // Wood is dead, a bell rings: the upper modes of wood decay much faster.
    expect(materialModes('wood', { seed: 1 })[5]![2]).toBeLessThan(materialModes('bell', { seed: 1 })[5]![2] * 0.5);
  });

  it('a plate rings with many partials where three hand-written modes ring with three', () => {
    const plate = renderVoice({ wave: 'modal', freq: 500, material: 'plate', modeCount: 20, hardness: 0.8, attack: 0.0005, sustain: 0, decay: 0.8, volume: 1 }, 1);
    const toy = renderVoice({ wave: 'modal', freq: 500, modes: [[1, 1, 1], [2.3, 0.6, 0.7], [4.1, 0.4, 0.5]], attack: 0.0005, sustain: 0, decay: 0.8, volume: 1 }, 1);
    // Partials within 30 dB of the strongest in the first 93 ms: the plate has several times as many.
    const partials = (x: Float32Array): number => {
      const P = powerSpectrum(x, 0, 4096);
      const top = Math.max(...P);
      let count = 0;
      for (let k = 2; k < P.length - 2; k++) if (P[k]! > top * 1e-3 && P[k]! > P[k - 1]! && P[k]! >= P[k + 1]! && P[k]! > P[k - 2]! && P[k]! > P[k + 2]!) count++;
      return count;
    };
    expect(partials(toy)).toBeLessThanOrEqual(4);
    expect(partials(plate)).toBeGreaterThanOrEqual(8);
    // The ring darkens as the high modes die.
    const a = analyzeSound([plate]);
    expect(a.centroidEndHz).toBeLessThan(a.centroidStartHz);
  });
});

describe('movement, stereo and loops', () => {
  it('a pitch curve, tremolo, unison and a comb resonator do what they say', () => {
    const n = Math.round(0.6 * SR);
    const zero = (x: Float32Array, from: number, to: number): number => {
      let c = 0;
      for (let i = from + 1; i < to; i++) if (x[i - 1]! < 0 !== x[i]! < 0) c++;
      return (c / 2 / (to - from)) * SR;
    };
    const sweep = renderVoice({ wave: 'sine', freq: 100, freqCurve: [[0, 200], [0.3, 800], [0.6, 400]], attack: 0.001, sustain: 0.6, decay: 0.01, volume: 1 }, 1);
    expect(zero(sweep, 0, 2000)).toBeLessThan(260);
    expect(zero(sweep, Math.round(0.29 * SR), Math.round(0.31 * SR))).toBeGreaterThan(700);
    expect(zero(sweep, n - 2000, n)).toBeLessThan(500);

    const trem = renderVoice({ wave: 'sine', freq: 600, tremoloDepth: 0.8, tremoloSpeed: 10, attack: 0.001, sustain: 0.6, decay: 0.01, volume: 1 }, 1);
    const win = Math.round(0.01 * SR);
    const levels = Array.from({ length: 50 }, (_, k) => rms(trem, 2000 + k * win, 2000 + (k + 1) * win));
    expect(Math.max(...levels) / Math.min(...levels)).toBeGreaterThan(3);

    // Detuned copies beat: the level of three saws moves, one saw's does not.
    const env = (v: Float32Array): number[] => Array.from({ length: 20 }, (_, k) => rms(v, 2000 + k * 1000, 3000 + k * 1000));
    const one = env(renderVoice({ wave: 'saw', freq: 220, attack: 0.001, sustain: 0.6, decay: 0.01, volume: 1 }, 1));
    const three = env(renderVoice({ wave: 'saw', freq: 220, unison: 3, detune: 20, attack: 0.001, sustain: 0.6, decay: 0.01, volume: 1 }, 1));
    expect(Math.max(...three) / Math.min(...three)).toBeGreaterThan((Math.max(...one) / Math.min(...one)) * 1.2);

    // A comb at 300 Hz keeps ringing after the noise that excited it has gone.
    const dryTail = renderVoice({ wave: 'white', freq: 1, attack: 0.0003, sustain: 0.01, decay: 0.02, volume: 1 }, 1);
    const combed = renderVoice({ wave: 'white', freq: 1, comb: 300, combDecay: 0.4, attack: 0.0003, sustain: 0.01, decay: 0.4, levelCurve: [[0, 1], [1, 1]], volume: 1 }, 1);
    expect(dryTail.length).toBeLessThan(combed.length);
  });

  it('a sound is mono unless it asks for stereo; width spreads the noise, not the lows, and folds to mono cleanly', () => {
    const mono = renderSfxChannels(flatShot, 1);
    expect(mono.length).toBe(1);
    const p: SfxParams = { ...flatShot, width: 0.8, space: 'hall', spaceMix: 0.3 };
    expect(isStereoSfx(p)).toBe(true);
    const [l, r] = renderSfxChannels(p, 1) as [Float32Array, Float32Array];
    const c = checkAudio([l, r], { category: 'impact' });
    expect(c.issues, c.summary).toEqual([]);
    expect(c.stereo!.correlation).toBeLessThan(0.98);
    expect(c.stereo!.correlation).toBeGreaterThan(0.3);
    // Under 150 Hz the two sides are the same signal.
    const low = (x: Float32Array): Float32Array => {
      const y = Float32Array.from(x);
      Biquad.lowpass(150, 0.707).processBuffer(y);
      Biquad.lowpass(150, 0.707).processBuffer(y);
      return y;
    };
    const ll = low(l);
    const lr = low(r);
    let dot = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < ll.length; i++) {
      dot += ll[i]! * lr[i]!;
      e1 += ll[i]! * ll[i]!;
      e2 += lr[i]! * lr[i]!;
    }
    expect(dot / Math.sqrt(e1 * e2)).toBeGreaterThan(0.97);
    // A panned layer moves the image.
    const [pl, pr] = renderSfxChannels({ wave: 'white', freq: 1, attack: 0.001, sustain: 0.1, decay: 0.05, pan: -0.8, category: 'pickup' }, 1) as [Float32Array, Float32Array];
    expect(rms(pl)).toBeGreaterThan(rms(pr) * 2);
  });

  it('loop: true makes a seamless loop of the main voice\'s length, with events wrapped into it', () => {
    const p: SfxParams = {
      loop: true, engine: 3, category: 'movement',
      wave: 'saw', freq: 331.3, sustain: 1.5, decay: 0, lowpass: 2600, resonance: 1.2, tremoloDepth: 0.3, tremoloSpeed: 43.7, slide: 0.35, volume: 0.5,
      layers: [
        { wave: 'pink', freq: 1, bandpass: 2500, resonance: 1.5, sustain: 1.5, decay: 0, volume: 0.5 },
        { wave: 'modal', freq: 700, material: 'bar', decay: 0.3, volume: 0.4, delay: 1.4 },
      ],
    };
    const x = renderSfx(p, 1);
    expect(x.length).toBe(Math.round(1.5 * SR));
    const c = checkAudio([x], { category: 'movement', loop: true });
    expect(c.issues, c.summary).toEqual([]);
    expect(c.seam!.ratio).toBeLessThan(2.5);
    const a = analyzeSound([x], { loop: true });
    // The slide is dropped (a loop cannot drift): the end runs into the start no differently than any two moments of it.
    expect(critiqueSound(a, { kind: 'loop' }).improve.join(' ')).not.toMatch(/seam/);
    // The clank that starts 100 ms before the end rings on into the start of the loop.
    const without = renderSfx({ ...p, layers: [p.layers![0]!] }, 1);
    const head = Math.round(0.1 * SR);
    let d = 0;
    for (let i = 0; i < head; i++) d = Math.max(d, Math.abs(x[i]! - without[i]!));
    expect(d).toBeGreaterThan(0.002);
    // The old way (a long sustain, no loop) fades at both ends and drifts: the gate and the analysis say so.
    const old = renderSfx({ ...p, loop: undefined }, 1);
    expect(Math.abs(old[old.length - 1]!)).toBeLessThan(1e-3);
    expect(critiqueSound(analyzeSound([old], { loop: true }), { kind: 'loop' }).improve.join(' ')).toMatch(/seam/);
  });
});

describe('parameters as agents write them', () => {
  it('lintSfx names what does nothing and what was read differently', () => {
    const notes = lintSfx({
      wave: 'saw', freq: 110, resonance: 0.3, lowpass: 2000, looped: true, glow: 1,
      layers: [{ wave: 'noise', freq: 1, crackle: 0.7, grain: 60, sustain: 2, decay: 0 }, { wave: 'noise', freq: 1, highpass: 2000, decay: 0.04 }, { wave: 'modal', freq: 900, modes: [[1, 1, 1], [2.6, 0.6, 0.7]], decay: 0.3 }],
    } as unknown as SfxParams).join('\n');
    expect(notes).toMatch(/unknown parameter glow/);
    expect(notes).toMatch(/crackle is grains per second/);
    expect(notes).toMatch(/layer 2: no sustain given/);
    expect(notes).toMatch(/resonance is the filter's Q/);
    expect(notes).toMatch(/2 modes ring like a toy bell/);
    expect(lintSfx(SFX_PRESETS.hit!)).toEqual([]);
    // "amount, rate" (crackle 0.7, grain 60) is 60 grains a second in a sound made now; a saved sound keeps the
    // literal reading (a layer that is silent, or stuck open once a grain fires).
    const sparks = renderVoice({ wave: 'white', freq: 1, crackle: 0.7, grain: 60, attack: 0.001, sustain: 0.5, decay: 0.01, volume: 1 }, 3, { engine: 3 });
    const level = rms(sparks);
    expect(level).toBeGreaterThan(0.02);
    expect(sparks.filter((v) => Math.abs(v) < level * 0.05).length / sparks.length).toBeGreaterThan(0.3);
  });

  it('a sound made now starts from nothing and its voices are hits unless they hold; saved sounds keep their defaults', () => {
    const made = sfxParams({ params: { wave: 'saw', freq: 220, layers: [{ wave: 'noise', freq: 1, highpass: 2000, decay: 0.04 }] } });
    expect(made.slide).toBeUndefined(); // it used to inherit the blip preset's rising pitch
    expect(made.engine).toBe(3);
    expect(sfxParams({}).freq).toBe(SFX_PRESETS.blip!.freq);
    expect(sfxParams({ params: { looped: true } as unknown as Partial<SfxParams> }).loop).toBe(true);
    expect(() => sfxParams({ preset: 'nope' })).toThrow(/Unknown preset/);
    const crack = { wave: 'white' as const, freq: 1, highpass: 2000, decay: 0.04, volume: 1 };
    expect(renderVoice(crack, 1, { engine: 3 }).length).toBeLessThan(0.05 * SR);
    expect(renderVoice(crack, 1).length).toBeGreaterThan(0.13 * SR);
    // Every preset says how long each voice holds, so presets are the same under both.
    for (const [name, p] of Object.entries(SFX_PRESETS)) for (const v of [p, ...(p.layers ?? [])]) expect(v.sustain !== undefined && v.attack !== undefined, name).toBe(true);
  });
});

describe('listening with numbers', () => {
  it('measures what it says: bands, noisiness, the front edge, the decay', () => {
    const n = SR;
    const tone = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 100 * i) / SR) * Math.exp(-i / (0.1 * SR)));
    const a = analyzeSound([tone]);
    expect(a.bands.bass).toBeGreaterThan(-1);
    expect(a.bands.air).toBeLessThan(-30);
    expect(a.noisiness).toBeLessThan(0.3);
    expect(a.t20Ms!).toBeGreaterThan(180);
    expect(a.t20Ms!).toBeLessThan(290);
    const hiss = noise(n, 2);
    const h = analyzeSound([hiss]);
    expect(h.noisiness).toBeGreaterThan(0.85);
    expect(Math.abs(h.punchDb!)).toBeLessThan(1.5);
    expect(h.t40Ms).toBeNull();
    expect(h.edgeAirDb).toBeGreaterThan(-3);
    const hit = Float32Array.from(hiss, (v, i) => v * Math.exp(-i / (0.02 * SR)));
    expect(analyzeSound([hit]).punchDb!).toBeGreaterThan(8);
    // Two takes: a quieter, darker copy reads as such.
    const dark = Float32Array.from(hit, (v) => v * dbToLin(-3));
    Biquad.lowpass(2000, 0.707).processBuffer(dark);
    const d = takeDifference(hit, dark);
    expect(d.levelDb).toBeLessThan(-3);
    expect(d.toneOct).toBeLessThan(-0.5);
    expect(d.spectrumDb).toBeGreaterThan(3);
  });

  it('the critique finds what was wrong with the first agent-made weapons and is satisfied by a designed one', () => {
    // As it shipped: a flat burst, dull, no tail.
    const flat = renderSfx({ ...flatShot, transient: 0 }, 1);
    const said = critiqueSound(analyzeSound([flat]), { kind: 'shot', heavy: true }).improve.join('\n');
    expect(said).toMatch(/transient weak/);
    expect(said).toMatch(/no tail/);
    // Through the tool's own path: judged from its name, with the notes on its parameters.
    const first = designSfx({ name: 'Fire_Autocannon', category: 'impact', description: 'Autocannon shot', params: { ...flatShot, layers: [...flatShot.layers!, { wave: 'noise', freq: 1, crackle: 0.6, grain: 25, bandpass: 2500, resonance: 0.3, decay: 0.3, volume: 0.3 }] } });
    expect(first.kind).toBe('shot');
    expect(first.feedback.judgedAs).toMatch(/^shot, heavy \(guessed/);
    expect(first.feedback.heard).toMatch(/front [+-]?[\d.]+ dB over body/);
    expect(first.feedback.notes.join('\n')).toMatch(/crackle is grains per second/);
    expect(first.feedback.improve.join('\n')).toMatch(/no tail/);
    // Designed in layers, in a place: the gate passes and nothing is left to say.
    const good = designSfx({ name: 'Fire_Autocannon', category: 'impact', kind: 'shot', heavy: true, variations: 2, params: designedShot });
    expect(good.check.issues, good.check.summary).toEqual([]);
    expect(good.feedback.improve, good.feedback.heard).toEqual([]);
    expect(good.feedback.notes).toEqual([]);
    expect(good.analysis.punchDb!).toBeGreaterThan(analyzeSound([flat]).punchDb! + 1.5);
    expect(good.analysis.edgeAirDb).toBeGreaterThan(analyzeSound([flat]).edgeAirDb + 1.5);
    expect(good.analysis.t40Ms!).toBeGreaterThan(450);
    expect(good.takes.length).toBe(2);
    expect(good.feedback.takes![0]).toMatch(/^take 2: level/);
    // A sharp front with nothing behind it stays under its target, and is told to gain body, not to go flat.
    const thin = designSfx({ name: 'Crack', category: 'impact', kind: 'shot', params: { wave: 'white', highpass: 3000, attack: 0.0003, decay: 0.03, volume: 2, layers: [{ wave: 'sine', freq: 160, freqEnd: 50, pitchTime: 0.05, decay: 0.12, volume: 0.6 }] } });
    expect(thin.check.ok).toBe(false);
    expect(thin.feedback.improve[0]).toMatch(/LU under its loudness target/);
    expect(thin.feedback.improve.join('\n')).not.toMatch(/transient weak/);
  });

  it('guesses what a sound is from its name', () => {
    const a = analyzeSound([noise(SR / 4, 1)]);
    expect(guessKind(a, 'impact', false, 'RocketExplosion')).toEqual({ kind: 'explosion', heavy: false });
    expect(guessKind(a, 'stinger', false, 'Footstep_Heavy').kind).toBe('step');
    expect(guessKind(a, 'stinger', false, 'Footstep_Heavy').heavy).toBe(true);
    expect(guessKind(a, 'movement', false, 'BoostDash').kind).toBe('whoosh');
    expect(guessKind(a, 'ui', false, 'Thing').kind).toBe('ui');
    expect(guessKind(a, 'movement', true, 'ServoWhir').kind).toBe('loop');
  });
});

describe('skill roblox-audio', () => {
  it('its recipes are sounds the engine itself has nothing to say about', () => {
    const md = readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-audio', 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^version: 5$/m);
    const recipes = [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Partial<SfxParams>);
    const as: Array<{ name: string; category: 'impact' | 'footstep'; kind: 'shot' | 'explosion' | 'step' | 'impact'; heavy?: boolean }> = [
      { name: 'Gun', category: 'impact', kind: 'shot', heavy: true },
      { name: 'Blast', category: 'impact', kind: 'explosion', heavy: true },
      { name: 'Step', category: 'footstep', kind: 'step', heavy: true },
      { name: 'Clang', category: 'impact', kind: 'impact' },
    ];
    // The last recipe is an ambience bed: what audio_ambience would render from it.
    const bed = designSfx({ name: 'Ambience_Yard', category: 'ambience', kind: 'loop', params: bedParams(recipes.pop()!, 16) });
    expect(bed.check.issues, bed.check.summary).toEqual([]);
    expect(bed.feedback.improve, bed.feedback.heard).toEqual([]);
    expect(bed.feedback.notes).toEqual([]);
    expect(recipes.length).toBe(as.length);
    recipes.forEach((params, i) => {
      const made = designSfx({ ...as[i]!, params });
      expect(made.check.issues, `${as[i]!.name}: ${made.check.summary}`).toEqual([]);
      expect(made.feedback.improve, `${as[i]!.name}: ${made.feedback.heard}`).toEqual([]);
      expect(made.feedback.notes, as[i]!.name).toEqual([]);
    });
  });
});
