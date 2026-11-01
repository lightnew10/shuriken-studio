import { describe, expect, it } from 'vitest';
import { renderSong, type SongSpec } from '../src/core/audio/music';
import type { MixReport } from '../src/core/audio/music-analysis';
import { composeStyle } from '../src/core/audio/compose';
import { editScore } from '../src/core/audio/score-edit';

// The copilot's fourth wish: "a music analysis it can listen through (frequency clashes 808 vs pad, energy and
// brightness per section, pump depth), to correct over 2-3 passes like it does for sound effects".

const report = (spec: SongSpec): MixReport => {
  let r: MixReport | null = null;
  renderSong(spec, 7, { onReport: (x) => (r = x) });
  return r!;
};

const bars = (n: number, fn: (b: number) => Array<{ t: number; d: number; n?: string; v?: number }>) => Array.from({ length: n }, (_, b) => fn(b)).flat();

describe('listening to a mix', () => {
  it('hears a pad sitting on the 808, and the fix (a high-pass on the pad) clears it', () => {
    const spec: SongSpec = {
      bpm: 120,
      beats: 32,
      reverb: 0.1,
      sections: [{ name: 'Drop', bars: 8 }],
      tracks: [
        { instrument: 'kick', name: 'kick', notes: bars(8, (b) => [0, 1.5, 2.5].map((t) => ({ t: b * 4 + t, d: 0.25 }))) },
        { instrument: 'bass808', name: '808', notes: bars(8, (b) => [{ t: b * 4, d: 3.8, n: 'F1' }]) },
        { instrument: 'pad', name: 'pad', hp: 0, duck: 0, volume: 1.4, notes: bars(8, (b) => ['F2', 'C3', 'F3'].map((n) => ({ t: b * 4, d: 3.9, n }))) },
        { instrument: 'hat', name: 'hat', notes: bars(8, (b) => [0, 1, 2, 3].map((t) => ({ t: b * 4 + t + 0.5, d: 0.25 }))) },
      ],
    };
    const r = report(spec);
    expect(r.clashes.map((c) => [c.a, c.b])).toEqual([['808', 'pad']]);
    expect(r.improve.join('\n')).toMatch(/808 and pad fight for the low end \(bars 1-8; \d+% of the lighter one's lows sit on the other's\): high-pass pad at 150-250 Hz \(set hp\)/);
    expect(r.parts.map((p) => p.name)).toEqual(['kick', '808', 'pad', 'hat']);
    expect(r.heard).toMatch(/^parts \(share of energy \/ of what is heard above 150 Hz\): kick \d+\/\d+%.*; sections: Drop -?[\d.]+ LUFS; \d+% under 150 Hz/);
    const fixed = report(editScore(spec, [{ op: 'set', track: 'pad', hp: 220 }]).spec);
    expect(fixed.clashes).toEqual([]);
  }, 60_000);

  it('hears a drop that does not lift over the part before it, and measures the pump', () => {
    const flat = composeStyle('phonk', { bars: 12, seed: 3 });
    const r = report(flat);
    expect(r.sections.map((s) => s.name)).toEqual(['Intro', 'Drop', 'Breakdown', 'Drop 2']);
    expect(r.pumpDb).not.toBeNull();
    // Fill the breakdown with the drop's drums and the drop no longer stands out.
    const busy = editScore(flat, [{ op: 'copy', from: [5, 6], to: 7 }]).spec;
    const b = report(busy);
    const brk = b.sections.find((s) => s.name === 'Breakdown')!;
    const drop2 = b.sections.find((s) => s.name === 'Drop 2')!;
    expect(drop2.lufs! - brk.lufs!).toBeLessThan(1.5);
    expect(b.improve.join('\n')).toMatch(/the Drop 2 is only -?[\d.]+ dB louder than the Breakdown before it/);
    // The pad pumps under the kick (a few dB); with nothing ducked there is no pump to measure.
    expect(r.pumpDb!).toBeGreaterThan(2);
    const still = report(editScore(flat, flat.tracks.map((_, i) => ({ op: 'set' as const, track: i, duck: 0 }))).spec);
    expect(still.pumpDb).toBeNull();
  }, 120_000);
});
