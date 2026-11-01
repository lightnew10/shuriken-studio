import { describe, expect, it } from 'vitest';
import { SFX_PRESETS, SAMPLE_RATE, composeStyle, midiOf, renderSfx, renderSong, varySfx, wavBytes } from '../src/core/audio/synth';
import { encodeMp3 } from '../src/core/audio/audio-service';

describe('audio synthesis', () => {
  it('renders every sfx preset to a short, non-silent, non-clipping sound', () => {
    for (const [name, p] of Object.entries(SFX_PRESETS)) {
      const pcm = renderSfx(p, 1);
      const peak = pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      expect(pcm.length / SAMPLE_RATE, name).toBeLessThan(2);
      // Loudness is set per category now (not peak-normalised), so a quiet UI buzz peaks lower than a hit.
      expect(peak, name).toBeGreaterThan(0.1);
      expect(peak, name).toBeLessThanOrEqual(1);
    }
  });

  it('mixes layered voices (combat hits) and detunes every layer for variations', () => {
    for (const k of ['clang', 'punch', 'block', 'slam']) expect(SFX_PRESETS[k]?.layers?.length, k).toBeGreaterThan(0);
    const clang = renderSfx(SFX_PRESETS.clang!, 1);
    const main = renderSfx({ ...SFX_PRESETS.clang!, layers: undefined }, 1);
    expect(clang.length).toBeGreaterThanOrEqual(main.length);
    // Brighter than its fundamental alone: the partials add high-frequency energy (more zero crossings).
    const zc = (x: Float32Array) => x.reduce((n, v, i) => (i && (x[i - 1]! < 0) !== (v < 0) ? n + 1 : n), 0);
    expect(zc(clang)).toBeGreaterThan(zc(main) * 1.3);
    // A delayed layer extends the sound.
    const slam = SFX_PRESETS.slam!;
    expect(renderSfx(slam, 1).length).toBeGreaterThan(Math.round(((slam.layers![1]!.delay ?? 0) + 0.6) * SAMPLE_RATE));
    const v = varySfx(SFX_PRESETS.clang!, 1.05, 1.1);
    expect(v.freq).toBeCloseTo(SFX_PRESETS.clang!.freq * 1.05, 5);
    expect(v.layers![0]!.freq).toBeCloseTo(SFX_PRESETS.clang!.layers![0]!.freq * 1.05, 5);
  });

  it('parses note names', () => {
    expect(midiOf('A4')).toBe(69);
    expect(midiOf('C4')).toBe(60);
    expect(midiOf('F#3')).toBe(54);
    expect(midiOf('Bb2')).toBe(46);
    expect(() => midiOf('H4')).toThrow(/Bad note/);
  });

  it('composes and renders a loop for every style', () => {
    for (const style of ['lofi', 'chiptune', 'epic', 'ambient', 'action', 'japanese', 'tropical', 'spooky'] as const) {
      const spec = composeStyle(style, { bars: 4, seed: 3 });
      expect(spec.tracks.length, style).toBeGreaterThanOrEqual(3);
      const [L, R] = renderSong(spec, 1);
      expect(L.length).toBe(R.length);
      expect(L.length / SAMPLE_RATE).toBeCloseTo((spec.beats * 60) / spec.bpm, 1);
      expect(L.some((x) => Math.abs(x) > 0.1), style).toBe(true);
    }
  }, 120_000);

  it('encodes WAV and MP3', () => {
    const pcm = renderSfx(SFX_PRESETS.coin!, 1);
    const wav = wavBytes([pcm]);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    const mp3 = encodeMp3([pcm]);
    expect(mp3.length).toBeGreaterThan(1000);
    // MP3 frame sync (0xFFE) at the first frame.
    expect(mp3[0]).toBe(0xff);
    expect((mp3[1]! & 0xe0) === 0xe0).toBe(true);
  });
});
