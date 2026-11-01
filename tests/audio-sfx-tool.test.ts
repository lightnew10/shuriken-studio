import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreHarness } from './helpers/make-core';
import { SoundLibrary } from '../src/core/audio/audio-library';
import { probeAudio } from '../src/core/audio/probe';

const makeCore = coreHarness();
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

describe('audio_sfx as a sound designer uses it', () => {
  it('answers with what the sound measures as and what to change, and the next pass is better', async () => {
    const { core, ctx, root } = await makeCore({ respond: async () => null });
    // Pass 1, the way the first full build wrote its weapons: everything held, a crackle in the wrong units.
    const first = await core.invokeTool(
      'audio_sfx',
      {
        name: 'Fire_Autocannon', category: 'impact', upload: false, description: 'Autocannon shot',
        params: {
          wave: 'noise', lowpass: 6000, lowpassEnd: 1500, attack: 0.001, sustain: 0.1, decay: 0.06, drive: 0.5, glow: 2,
          layers: [{ wave: 'sine', freq: 160, freqEnd: 55, pitchTime: 0.06, sustain: 0.1, decay: 0.11, volume: 0.9 }, { wave: 'noise', crackle: 0.6, grain: 25, bandpass: 2500, sustain: 0.1, decay: 0.2, volume: 0.3 }],
        },
      },
      'agent',
    );
    expect(first.isError, text(first)).toBeFalsy();
    const a = JSON.parse(text(first)) as { check: { ok: boolean }; analysis: { judgedAs: string; heard: string; improve: string[]; notes: string[]; next: string } };
    expect(a.analysis.judgedAs).toMatch(/^shot/);
    expect(a.analysis.heard).toMatch(/front [+-]?[\d.]+ dB over body; crack -[\d.]+ dB/);
    expect(a.analysis.improve.join('\n')).toMatch(/no crack/);
    expect(a.analysis.improve.join('\n')).toMatch(/no tail/);
    expect(a.analysis.notes.join('\n')).toMatch(/unknown parameter glow/);
    expect(a.analysis.notes.join('\n')).toMatch(/crackle is grains per second/);
    expect(a.analysis.next).toMatch(/call audio_sfx again with the same name/);
    // Pass 2, acting on it: a crack, a held body, a thump, a place.
    const second = await core.invokeTool(
      'audio_sfx',
      {
        name: 'Fire_Autocannon', category: 'impact', kind: 'shot', heavy: true, variations: 2, upload: false,
        params: {
          wave: 'white', highpass: 3000, attack: 0.0003, decay: 0.03, volume: 2.2,
          layers: [
            { wave: 'pink', lowpass: 9000, lowpassEnd: 900, sweepTime: 0.12, sustain: 0.05, decay: 0.3, drive: 0.5, volume: 1.8 },
            { wave: 'sine', freq: 160, freqEnd: 50, pitchTime: 0.05, decay: 0.22, drive: 0.5, volume: 1 },
            { wave: 'brown', lowpass: 180, decay: 0.25, volume: 0.8 },
          ],
          clip: 0.7, weight: 0.5, space: 'outdoor', spaceMix: 0.18, spaceDecay: 0.6,
        },
      },
      'agent',
    );
    const b = JSON.parse(text(second)) as { check: { ok: boolean; summary: string }; analysis: { improve: string[]; notes?: string[]; takes: string[]; next: string } };
    expect(b.check.ok, b.check.summary).toBe(true);
    expect(b.analysis.improve).toEqual([]);
    expect(b.analysis.notes).toBeUndefined();
    expect(b.analysis.takes).toHaveLength(1);
    expect(b.analysis.next).toMatch(/Nothing stands out/);
    // The sound is stamped with the engine it was made with, so it renders the same later.
    const asset = ctx.store.all<{ metadata: string }>("SELECT metadata FROM assets WHERE name = 'Fire_Autocannon' ORDER BY rowid DESC LIMIT 1")[0]!;
    expect(JSON.parse(asset.metadata)).toMatchObject({ params: { engine: 3 }, judgedAs: 'shot', channels: 1 });
    expect(new SoundLibrary(root).get('Fire_Autocannon')).toMatchObject({ looped: false, category: 'impact' });
  }, 60000);

  it('makes a seamless stereo loop the game can keep playing', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    const made = await core.invokeTool(
      'audio_sfx',
      {
        name: 'ServoWhir', category: 'movement', upload: false,
        params: {
          looped: true, width: 0.6,
          wave: 'saw', freq: 330, sustain: 1.5, decay: 0, lowpass: 2600, resonance: 1.2, tremoloDepth: 0.25, tremoloSpeed: 43, volume: 0.5,
          layers: [{ wave: 'pink', bandpass: 2500, resonance: 1.5, sustain: 1.5, decay: 0, volume: 0.5 }, { wave: 'sine', freq: 55, sustain: 1.5, decay: 0, volume: 0.45 }],
        },
      },
      'agent',
    );
    expect(made.isError, text(made)).toBeFalsy();
    const r = JSON.parse(text(made)) as { looped: boolean; stereo: boolean; durationSec: number; check: { ok: boolean; summary: string }; analysis: { judgedAs: string; improve: string[] } };
    expect(r).toMatchObject({ looped: true, stereo: true, durationSec: 1.5 });
    expect(r.check.ok, r.check.summary).toBe(true);
    expect(r.check.summary).toMatch(/loop seam/);
    expect(r.analysis.judgedAs).toBe('loop');
    expect(r.analysis.improve.join('\n')).not.toMatch(/seam/);
    const entry = new SoundLibrary(root).get('ServoWhir')!;
    expect(entry).toMatchObject({ looped: true, pitchVariation: 0, loop: { length: 1.5 } });
    expect(entry.loop!.start).toBeGreaterThan(0.02);
    // The builder gives the Sound its loop region; the file is a two-channel MP3.
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toMatch(/name="ServoWhir".*looped=true.*loopLength=1\.5/);
    const probe = probeAudio(readFileSync(join(root, entry.file!)));
    expect(probe).toMatchObject({ ok: true, format: 'mp3', channels: 2 });
  }, 60000);
});
