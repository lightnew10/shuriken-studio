import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreHarness } from './helpers/make-core';
import { SAMPLE_RATE } from '../src/core/audio/dsp/util';
import { checkAudio } from '../src/core/audio/dsp/master';
import { analyzeSound } from '../src/core/audio/dsp/analyze';
import { SoundLibrary } from '../src/core/audio/audio-library';
import { midiOf, renderSfx, renderSong, styleKey, type SfxParams } from '../src/core/audio/synth';
import { designSfx } from '../src/core/audio/sfx-design';
import { STINGER_MOODS, composeStinger } from '../src/core/audio/stinger';

const SR = SAMPLE_RATE;
const makeCore = coreHarness();
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

describe('scattered events', () => {
  it('a layer with scatter plays that many times across a loop, each a little different, and wraps', () => {
    const tick = { wave: 'modal' as const, freq: 900, material: 'bar' as const, decay: 0.15, volume: 0.8 };
    const bed: SfxParams = { engine: 3, loop: true, category: 'movement', wave: 'brown', freq: 1, lowpass: 200, sustain: 4, decay: 0, volume: 0.05, layers: [{ ...tick, scatter: 6 }] };
    const x = renderSfx(bed, 1);
    expect(x.length).toBe(4 * SR);
    // Six onsets: count the 50 ms windows that are much louder than the one before.
    const win = Math.round(0.05 * SR);
    const level = (k: number): number => {
      let s = 0;
      for (let i = k * win; i < (k + 1) * win; i++) s += x[i]! * x[i]!;
      return s;
    };
    let onsets = 0;
    for (let k = 0; k < x.length / win; k++) if (level(k) > 6 * level((k - 1 + x.length / win) % (x.length / win))) onsets++;
    expect(onsets).toBe(6);
    // One in each sixth of the loop: sparse, never bunched. Another seed puts them elsewhere.
    expect(renderSfx(bed, 2)).not.toEqual(x);
    expect(checkAudio([x], { category: 'movement', loop: true }).seam!.ratio).toBeLessThan(2.5);
    // In a one-shot the events fall within scatterOver seconds after the delay.
    const blast = renderSfx({ engine: 3, category: 'pickup', wave: 'white', freq: 1, decay: 0.05, volume: 0.5, layers: [{ ...tick, delay: 0.3, scatter: 3, scatterOver: 0.6 }] }, 1);
    expect(blast.length / SR).toBeGreaterThan(0.6);
    expect(blast.length / SR).toBeLessThan(1.3);
  });
});

describe('ambience beds', () => {
  const held = { sustain: 8, decay: 0 };
  const yard: Partial<SfxParams> = {
    loop: true, width: 0.8, space: 'outdoor', spaceMix: 0.25,
    wave: 'pink', ...held, bandpass: 500, resonance: 1.2, filterLfoDepth: 0.9, filterLfoSpeed: 0.25, tremoloDepth: 0.6, tremoloSpeed: 0.125, volume: 1.4,
    layers: [
      { wave: 'brown', freq: 1, lowpass: 160, tremoloDepth: 0.3, tremoloSpeed: 0.375, volume: 0.9, ...held },
      { wave: 'modal', freq: 260, material: 'plate', modeCount: 12, hardness: 0.4, decay: 1.2, volume: 0.35, scatter: 2, scatterPitch: 0.3 },
    ],
  };

  it('a bed is a long seamless stereo loop at the ambience level, and the critique knows what a bed needs', () => {
    const made = designSfx({ name: 'Ambience_Yard', category: 'ambience', kind: 'loop', params: yard });
    const [l, r] = made.takes[0] as [Float32Array, Float32Array];
    expect(l.length).toBe(8 * SR);
    expect(r.length).toBe(l.length);
    expect(made.check.issues, made.check.summary).toEqual([]);
    expect(made.check.summary).toMatch(/-24(\.\d)? LUFS-I \(target -24\).*loop seam/);
    expect(made.analysis.swellDb!).toBeGreaterThan(1.5);
    // 8 s is short for a bed and it says so; nothing else.
    expect(made.feedback.improve.join('\n')).toMatch(/^short: a 8 s bed/);
    expect(made.feedback.improve).toHaveLength(1);
    // A held noise with no movement, no width and no events is told all three.
    const flat = designSfx({ name: 'Ambience_Flat', category: 'ambience', kind: 'loop', params: { loop: true, wave: 'pink', sustain: 8, decay: 0, lowpass: 2000 } });
    const said = flat.feedback.improve.join('\n');
    expect(said).toMatch(/static/);
    expect(said).toMatch(/mono/);
    expect(said).toMatch(/no events/);
    expect(analyzeSound(flat.takes[0]!).swellDb!).toBeLessThan(1.5);
  }, 30000);

  it('audio_ambience holds what has no length of its own, saves a looping ambience sound and answers with its analysis', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    const { sustain: _s, decay: _d, ...main } = yard;
    const params = { ...main, layers: [{ wave: 'brown', lowpass: 160, tremoloDepth: 0.3, tremoloSpeed: 0.375, volume: 0.9 }, yard.layers![1]] };
    const made = await core.invokeTool('audio_ambience', { name: 'Ambience_Yard', seconds: 8, params, upload: false }, 'agent');
    expect(made.isError, text(made)).toBeFalsy();
    const out = JSON.parse(text(made)) as { kind: string; looped: boolean; stereo: boolean; durationSec: number; check: { ok: boolean; summary: string }; analysis: { heard: string; improve: string[] } };
    expect(out).toMatchObject({ kind: 'ambience', looped: true, stereo: true, durationSec: 8 });
    expect(out.check.ok, out.check.summary).toBe(true);
    expect(out.analysis.heard).toMatch(/dB from second to second/);
    const entry = new SoundLibrary(root).get('Ambience_Yard')!;
    expect(entry).toMatchObject({ kind: 'ambience', looped: true, category: 'ambience', file: 'assets/audio/ambience/ambience-yard.mp3', loop: { length: 8 } });
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toMatch(/name="Ambience_Yard",kind="ambience".*looped=true.*loopLength=8/);
  }, 60000);
});

describe('stingers', () => {
  it('every mood in every scale stays inside the notes of the music and ends where it should', () => {
    for (const style of ['epic', 'action', 'lofi', 'chiptune', 'japanese', 'phonk'] as const) {
      const key = styleKey(style, style === 'action' ? 'D3' : undefined);
      const inScale = new Set(key.scale.map((s) => (((key.root + s) % 12) + 12) % 12));
      for (const mood of STINGER_MOODS) {
        const spec = composeStinger(mood, { style, key: style === 'action' ? 'D3' : undefined });
        const pitched = spec.tracks.flatMap((t) => t.notes).filter((n) => n.n !== undefined);
        expect(pitched.length, `${style} ${mood}`).toBeGreaterThan(3);
        for (const n of pitched) expect(inScale.has(((midiOf(n.n!) % 12) + 12) % 12), `${style} ${mood}: note ${String(n.n)}`).toBe(true);
        expect(spec.beats).toBeLessThanOrEqual(6);
      }
    }
    // In D minor a win resolves on F (the relative major), a loss on D; in C major a win on C, a loss on A.
    const last = (spec: ReturnType<typeof composeStinger>): number => midiOf(spec.tracks[0]!.notes[spec.tracks[0]!.notes.length - 1]!.n!) % 12;
    expect(last(composeStinger('win', { style: 'action', key: 'D3' }))).toBe(5);
    expect(last(composeStinger('lose', { style: 'action', key: 'D3' }))).toBe(2);
    expect(last(composeStinger('win', { style: 'chiptune' }))).toBe(0);
    expect(last(composeStinger('lose', { style: 'chiptune' }))).toBe(9);
    // The style picks the instruments.
    expect(composeStinger('win', { style: 'lofi' }).tracks[0]!.instrument).toBe('epiano');
    expect(composeStinger('win', { style: 'japanese' }).tracks[0]!.instrument).toBe('koto');
  });

  it('renders once and rings out at the stinger level; a song still loops', () => {
    const spec = composeStinger('win', { style: 'action', key: 'D3' });
    const [l, r] = renderSong(spec, 7, { category: 'stinger', oneShot: true });
    const c = checkAudio([l, r], { category: 'stinger' });
    expect(c.issues, c.summary).toEqual([]);
    const phrase = (spec.beats * 60) / spec.bpm;
    expect(l.length / SR).toBeGreaterThan(phrase);
    expect(l.length / SR).toBeLessThan(phrase + 3.1);
    // It dies away: the last 50 ms are 40 dB under the peak.
    const a = analyzeSound([l, r]);
    expect(a.noisiness).toBeLessThan(0.5);
    expect(a.t40Ms).not.toBeNull();
    expect(a.endDb).toBeLessThan(-35);
  }, 30000);

  it('audio_stinger saves a 2D one-shot in the music\'s key', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    const made = await core.invokeTool('audio_stinger', { name: 'Stinger_Win', mood: 'win', style: 'action', key: 'D minor', upload: false }, 'agent');
    expect(made.isError, text(made)).toBeFalsy();
    const out = JSON.parse(text(made)) as { kind: string; mood: string; style: string; check: { ok: boolean; summary: string }; durationSec: number };
    expect(out).toMatchObject({ kind: 'sfx', mood: 'win', style: 'action' });
    expect(out.check.ok, out.check.summary).toBe(true);
    expect(out.durationSec).toBeGreaterThan(2);
    expect(new SoundLibrary(root).get('Stinger_Win')).toMatchObject({ kind: 'sfx', looped: false, category: 'stinger', pitchVariation: 0, style: 'action' });
  }, 60000);
});
