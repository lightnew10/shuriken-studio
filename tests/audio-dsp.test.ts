import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, Rng } from '../src/core/audio/dsp/util';
import { AUDIO_CATEGORIES, LOUDNESS_TARGETS, MP3_ENCODER_DELAY, TRUE_PEAK_CEILING_DB, checkAudio, limit, master, measureLoudness, mp3LoopRegion, removeDc, truePeakDb, type AudioCategory } from '../src/core/audio/dsp/master';
import { upsampleFft } from '../src/core/audio/dsp/fft';
import { audioBuilder } from '../src/core/audio/audio-library';
import { AudioService } from '../src/core/audio/audio-service';
import { SFX_PRESETS, renderSfx } from '../src/core/audio/synth';
import { Store } from '../src/core/db/store';
import { PROJECT_MIGRATIONS } from '../src/core/db/schema';
import type { ProjectContext } from '../src/core/projects/project-service';

const SR = SAMPLE_RATE;

// ─── test signals ────────────────────────────────────────────────────────────

const sine = (f: number, secs: number, amp = 1, phase = 0): Float32Array => Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR + phase));

/** Noise with a falling spectrum (one-pole smoothed white) and an exponential decay: a rough "impact". */
function burst(secs: number, seed = 1, decay = 6): Float32Array {
  const r = new Rng(seed);
  const n = Math.round(secs * SR);
  const x = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.25 * (r.bipolar() - lp);
    x[i] = lp * Math.exp((-decay * i) / SR);
  }
  // Fully decayed at the end (the FFT oversampling used to measure it assumes a periodic signal).
  const taper = Math.round(0.01 * SR);
  for (let i = 0; i < taper; i++) x[n - 1 - i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
  return x;
}

/** Independent true peak: 8x spectral oversampling (exact for periodic or fully decayed signals). */
function trueDbFft(x: Float32Array): number {
  const up = upsampleFft(x, 8);
  let m = 0;
  for (let i = 0; i < up.length; i++) m = Math.max(m, Math.abs(up[i]!));
  return 20 * Math.log10(m);
}

const mean = (x: Float32Array): number => x.reduce((a, b) => a + b, 0) / x.length;
const scaled = (x: Float32Array, g: number): Float32Array => x.map((v) => v * g);

// ─── limiter ─────────────────────────────────────────────────────────────────

describe('true-peak limiter', () => {
  it('keeps true peaks (also between samples) at or under -1 dBTP on hot signals', () => {
    // A sine at fs/4 with a 45 degree phase has samples of +-0.707 but a true peak of 1.0: +6 dB gives 2.0.
    const quarter = Float32Array.from({ length: 4096 }, (_, i) => 2 * Math.sin((Math.PI * i) / 2 + Math.PI / 4));
    expect(Math.max(...quarter.map(Math.abs))).toBeLessThan(1.5); // sample peak hides the real one
    expect(trueDbFft(quarter)).toBeGreaterThan(5.9);
    const cases: Array<[string, Float32Array[]]> = [
      ['fs/4 sine +6 dB', [quarter]],
      ['loud noise burst', [scaled(burst(0.5, 3), 40)]],
      ['sine +12 dB', [sine(997, 0.25, 4)]],
      ['stereo, different peaks', [scaled(burst(0.4, 1), 30), scaled(burst(0.4, 2), 10)]],
    ];
    for (const [name, chs] of cases) {
      const x = chs.map((c) => Float32Array.from(c));
      // Zero-pad so the FFT measure is not fooled by a hard cut at the end of the buffer.
      const loop = name.startsWith('fs/4') || name.startsWith('sine');
      limit(x, { loop });
      for (const c of x) expect(trueDbFft(c), name).toBeLessThanOrEqual(-1.0);
      expect(truePeakDb(x, loop), name).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DB + 0.02);
    }
  });

  it('master holds -1 dBTP even for white noise to Nyquist (it low-passes at 16.5 kHz like the MP3 will)', () => {
    const r = new Rng(21);
    const white = Float32Array.from({ length: 16384 }, (_, i) => r.bipolar() * 3 * Math.sin((Math.PI * i) / 16384) ** 2);
    const rep = master([white], { category: 'impact' });
    expect(trueDbFft(white)).toBeLessThanOrEqual(-1.0);
    expect(rep.limiterDb).toBeLessThanOrEqual(LOUDNESS_TARGETS.impact.maxLimiterDb + 0.1);
  });

  it('leaves signals under the ceiling untouched and brings overs down without squashing the rest', () => {
    const quiet = sine(440, 0.3, 0.3);
    const copy = Float32Array.from(quiet);
    const r = limit([copy]);
    expect(r.reductionDb).toBe(0);
    expect(Math.max(...copy.map((v, i) => Math.abs(v - quiet[i]!)))).toBeLessThan(1e-7);
    // One loud click inside a quiet tone: the tone away from the click keeps its level after the release.
    const x = sine(440, 1, 0.2);
    for (let i = 0; i < 6; i++) x[22050 + i] = 3;
    const y = Float32Array.from(x);
    const { reductionDb } = limit([y], { releaseMs: 40 });
    expect(reductionDb).toBeGreaterThan(8);
    expect(Math.abs(y[SR - 2000]! - x[SR - 2000]!)).toBeLessThan(1e-4);
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(0.85);
  });

  it('limits a loop circularly: a peak at the seam leaves no jump', () => {
    const x = sine(220, 1, 0.5);
    for (let i = 0; i < 4; i++) {
      x[i] = 2.5;
      x[x.length - 1 - i] = 2.5;
    }
    const y = Float32Array.from(x);
    limit([y], { loop: true });
    expect(truePeakDb([y], true)).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DB + 0.02);
    // The gain applied at the first and last sample is the same one (continuous across the wrap).
    expect(y[0]! / x[0]!).toBeCloseTo(y[y.length - 1]! / x[x.length - 1]!, 2);
  });
});

// ─── loudness meter ──────────────────────────────────────────────────────────

describe('BS.1770 loudness meter', () => {
  it('reads a 997 Hz sine of -23 dBFS peak in both channels as -23 LUFS, and one channel 3 dB lower', () => {
    const amp = Math.pow(10, -23 / 20);
    const s = sine(997, 5, amp);
    const stereo = measureLoudness([s, s]);
    expect(stereo.integrated).toBeCloseTo(-23, 0);
    expect(Math.abs(stereo.integrated! + 23)).toBeLessThan(0.15);
    expect(stereo.momentaryMax).toBeCloseTo(stereo.integrated!, 1);
    const mono = measureLoudness([s]);
    expect(stereo.integrated! - mono.integrated!).toBeCloseTo(3.01, 1);
  });

  it('gates silence out of the integrated value but not out of the momentary maximum', () => {
    const tone = sine(997, 3, 0.1);
    const padded = new Float32Array(SR * 9);
    padded.set(tone, 0);
    const a = measureLoudness([tone]);
    const b = measureLoudness([padded]);
    expect(Math.abs(b.integrated! - a.integrated!)).toBeLessThan(0.3);
    expect(b.momentaryMax).toBeCloseTo(a.momentaryMax, 0);
  });

  it('pads sounds shorter than 400 ms like the standard meters (a short click is quieter than its level)', () => {
    const click = sine(1000, 0.04, 0.5);
    const long = sine(1000, 0.4, 0.5);
    const d = measureLoudness([long]).momentaryMax - measureLoudness([click]).momentaryMax;
    expect(d).toBeGreaterThan(9);
    expect(d).toBeLessThan(11);
  });
});

// ─── mastering to category targets ───────────────────────────────────────────

describe('mastering', () => {
  const pick = (cat: AudioCategory, chs: Float32Array[]): number => {
    const l = measureLoudness(chs);
    return LOUDNESS_TARGETS[cat].measure === 'integrated' ? l.integrated! : l.momentaryMax;
  };

  it('puts every category within 1 LU of its target with true peaks under the ceiling', () => {
    const signals: Record<AudioCategory, () => Float32Array[]> = {
      impact: () => [burst(0.7, 5, 5)],
      pickup: () => [sine(988, 0.35, 0.3).map((v, i) => v * Math.exp((-5 * i) / SR))],
      ui: () => [sine(1800, 0.2, 0.4).map((v, i) => v * Math.exp((-12 * i) / SR))],
      footstep: () => [burst(0.3, 9, 14)],
      movement: () => [burst(0.5, 2, 4)],
      stinger: () => [sine(523, 0.9, 0.2).map((v, i) => v * Math.exp((-2.5 * i) / SR))],
      music: () => [scaled(sine(110, 6, 0.3).map((v, i) => v + 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.25 * Math.sin((2 * Math.PI * 1320 * i) / SR)), 1), sine(165, 6, 0.3)],
      ambience: () => [scaled(burst(5, 4, 0), 0.05), scaled(burst(5, 6, 0), 0.05)],
    };
    for (const cat of AUDIO_CATEGORIES) {
      const chs = signals[cat]();
      const report = master(chs, { category: cat, loop: cat === 'music' || cat === 'ambience' });
      expect(report.silent, cat).toBe(false);
      expect(report.reached, `${cat}: ${report.loudness} vs ${report.targetLufs} (limiter ${report.limiterDb} dB)`).toBe(true);
      expect(Math.abs(pick(cat, chs) - LOUDNESS_TARGETS[cat].lufs), cat).toBeLessThanOrEqual(1);
      expect(truePeakDb(chs), cat).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DB + 0.02);
      expect(report.limiterDb, cat).toBeLessThanOrEqual(LOUDNESS_TARGETS[cat].maxLimiterDb + 0.1);
    }
  });

  it('orders the categories as the targets say: impacts louder than pickups, UI and footsteps', () => {
    expect(LOUDNESS_TARGETS.impact.lufs).toBe(-12);
    expect(LOUDNESS_TARGETS.music.lufs).toBe(-16);
    expect(LOUDNESS_TARGETS.ambience.lufs).toBe(-24);
    expect(LOUDNESS_TARGETS.pickup.lufs).toBe(-16);
    expect(LOUDNESS_TARGETS.ui.lufs).toBe(-20);
    expect(LOUDNESS_TARGETS.footstep.lufs).toBe(-22);
    // The same sound lands where its category says, whatever level it came in at.
    const loud = scaled(burst(0.5, 11, 8), 30);
    const faint = scaled(burst(0.5, 11, 8), 0.01);
    master([loud], { category: 'ui' });
    master([faint], { category: 'ui' });
    expect(Math.abs(measureLoudness([loud]).momentaryMax - measureLoudness([faint]).momentaryMax)).toBeLessThan(0.3);
  });

  it('says so when a sound is too short to reach its target instead of crushing it', () => {
    const tick = sine(2000, 0.004, 0.9);
    const r = master([tick], { category: 'footstep' });
    expect(r.reached).toBe(false);
    expect(r.limiterDb).toBeLessThanOrEqual(LOUDNESS_TARGETS.footstep.maxLimiterDb + 0.1);
    expect(truePeakDb([tick])).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DB + 0.02);
  });

  it('removes DC offset and starts and ends one-shots at zero', () => {
    const x = burst(0.4, 3, 5).map((v) => v + 0.35);
    const raw = Float32Array.from(x);
    expect(Math.abs(mean(raw))).toBeGreaterThan(0.3);
    master([x], { category: 'impact' });
    expect(Math.abs(mean(x))).toBeLessThan(1e-3);
    expect(Math.abs(x[0]!)).toBeLessThan(2e-3);
    expect(Math.abs(x[x.length - 1]!)).toBeLessThan(1e-4);
  });

  it('removes DC from a loop without breaking its seam', () => {
    const x = sine(110, 2, 0.4).map((v) => v + 0.2);
    removeDc([x], true);
    expect(Math.abs(mean(x))).toBeLessThan(2e-3);
    const step = Math.abs(x[0]! - x[x.length - 1]!);
    const typical = Math.abs(x[1000]! - x[1001]!);
    expect(step).toBeLessThan(typical * 3);
  });

  it('silence stays silence', () => {
    const z = new Float32Array(SR / 2);
    expect(master([z], { category: 'impact' }).silent).toBe(true);
    expect(checkAudio([z], { category: 'impact' }).issues).toContain('silent');
  });
});

// ─── the gate ────────────────────────────────────────────────────────────────

describe('checkAudio', () => {
  it('passes a mastered sound and describes it in one line', () => {
    const x = burst(0.6, 7, 6);
    master([x], { category: 'impact' });
    const c = checkAudio([x], { category: 'impact' });
    expect(c.issues).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.summary).toMatch(/^ok: -1[0-3](\.\d)? LUFS-M \(target -12\), -1\.\d dBTP, DC /);
    expect(c.truePeakDb).toBeLessThanOrEqual(-1);
    expect(Math.abs(c.dc)).toBeLessThan(0.003);
    expect(c.leadSilenceMs).toBeLessThan(5);
  });

  it('flags clipping, DC, a late start, a click at the end and a wrong level', () => {
    const hot = scaled(burst(0.4, 3, 5), 20);
    const c = checkAudio([hot], { category: 'impact' });
    expect(c.ok).toBe(false);
    expect(c.issues.join(' ')).toMatch(/true peak/);
    const dc = sine(300, 0.3, 0.2).map((v) => v + 0.1);
    expect(checkAudio([dc]).issues.join(' ')).toMatch(/DC offset/);
    const late = new Float32Array(SR / 2);
    late.set(sine(500, 0.2, 0.3), Math.round(0.1 * SR));
    expect(checkAudio([late]).issues.join(' ')).toMatch(/starts 100(\.\d)? ms late/);
    const cut = sine(500, 0.2, 0.3);
    expect(checkAudio([cut]).issues.join(' ')).toMatch(/ends abruptly/);
    const quiet = scaled(sine(500, 0.5, 0.3), 0.05);
    expect(checkAudio([quiet], { category: 'impact' }).issues.join(' ')).toMatch(/quieter than its -12 LUFS target/);
  });

  it('measures the loop seam against the sound\'s own steps', () => {
    const seamless = sine(100, 1, 0.5); // 100 whole cycles in 1 s
    const ok = checkAudio([seamless], { loop: true });
    expect(ok.seam!.ratio).toBeLessThanOrEqual(1.05);
    const jumpy = sine(100.25, 1, 0.5); // a quarter cycle left over: the wrap jumps from 0.5 to 0
    const bad = checkAudio([jumpy], { loop: true });
    expect(bad.seam!.ratio).toBeGreaterThan(2.5);
    expect(bad.issues.join(' ')).toMatch(/loop seam/);
  });

  it('reports stereo correlation for music', () => {
    const a = sine(220, 1, 0.3);
    const c = checkAudio([a, a], { loop: true });
    expect(c.stereo!.correlation).toBeCloseTo(1, 3);
    expect(c.stereo!.sideMidDb).toBeLessThan(-60);
  });
});

// ─── loops in MP3 ────────────────────────────────────────────────────────────

describe('loop metadata', () => {
  it('skips the 1105-sample encoder delay and keeps the exact length', () => {
    expect(MP3_ENCODER_DELAY).toBe(1105);
    const r = mp3LoopRegion(SR * 30);
    expect(r.start).toBeCloseTo(1105 / SR, 6);
    expect(r.length).toBeCloseTo(30, 6);
    expect(mp3LoopRegion(100000).length).toBeCloseTo(100000 / SR, 6);
  });

  it('the world builder sets LoopRegion and PlaybackRegionsEnabled for looped generated sounds only', () => {
    const e = (over: object) => ({ name: 'Theme', kind: 'music' as const, source: 'generated' as const, assetId: '77', volume: 0.45, looped: true, updatedAt: '', ...over });
    const code = audioBuilder([e({ loop: mp3LoopRegion(1323000) }), e({ name: 'Hit', kind: 'sfx', looped: false }), e({ name: 'Store', source: 'store' })]);
    expect(code).toContain('{name="Theme",kind="music",id="77",volume=0.45,looped=true,pitch=0,range=80,alts="",loopStart=0.025057,loopLength=30}');
    expect(code).toContain('PlaybackRegionsEnabled');
    expect(code).toContain('LoopRegion = NumberRange.new');
    expect(code).toContain('NEEDS A STUDIO CHECK');
    expect(code).toMatch(/pcall\(function\(\)[\s\S]*PlaybackRegionsEnabled/); // a Studio without the property must not fail the build
    expect(code).toContain('{name="Hit",kind="sfx",id="77",volume=0.45,looped=false,pitch=0,range=80,alts=""}');
    expect(code).toContain('{name="Store",kind="music",id="77",volume=0.45,looped=true,pitch=0,range=80,alts=""}');
  });

  it('AudioService returns the loop region, the gate and writes both into the asset metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-audio-dsp-'));
    const store = new Store(':memory:', PROJECT_MIGRATIONS);
    const svc = new AudioService({ root, store } as unknown as ProjectContext);
    const music = svc.music({ name: 'Theme', style: 'lofi', bars: 4, seed: 3, actor: 'test' });
    expect(music.loop.start).toBeCloseTo(1105 / SR, 6);
    expect(music.loop.length).toBeCloseTo(music.durationSec, 3);
    expect(music.check.target).toMatchObject({ category: 'music', lufs: -16, measure: 'integrated' });
    expect(music.check.truePeakDb).toBeLessThanOrEqual(-1);
    expect(music.check.seam).toBeDefined();
    expect(existsSync(join(root, music.file))).toBe(true);
    expect((music.asset.metadata as { loop?: unknown }).loop).toMatchObject({ start: music.loop.start });
    expect(readFileSync(join(root, music.file)).length).toBeGreaterThan(10000);
    const amb = svc.music({ name: 'Bed', style: 'ambient', bars: 4, seed: 3, category: 'ambience', actor: 'test' });
    expect(amb.check.target).toMatchObject({ category: 'ambience', lufs: -24 });
    const sfx = svc.sfx({ name: 'Coin', preset: 'coin', actor: 'test' });
    expect(sfx.check.target).toMatchObject({ category: 'pickup', lufs: -16, measure: 'momentary' });
    expect(sfx.check.summary).toContain('LUFS-M');
    expect(sfx.loop).toBeUndefined();
  });

  it('mastered presets pass the gate: true peak under -1 dBTP, no DC, a clean start', () => {
    for (const [name, p] of Object.entries(SFX_PRESETS)) {
      const pcm = renderSfx(p, 1);
      const c = checkAudio([pcm], { category: p.category ?? 'pickup' });
      expect(c.truePeakDb, name).toBeLessThanOrEqual(-1);
      expect(Math.abs(c.dc), name).toBeLessThan(2e-3);
      expect(c.leadSilenceMs, name).toBeLessThan(5);
    }
  });
});
