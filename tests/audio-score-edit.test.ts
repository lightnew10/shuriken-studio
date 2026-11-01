import { describe, expect, it } from 'vitest';
import { composeStyle } from '../src/core/audio/compose';
import { midiOf, songStems, type SongSpec } from '../src/core/audio/music';
import { EditError, describeScore, editScore, sectionBars, spanBeats } from '../src/core/audio/score-edit';

// The copilot, asked what would make it better at drift phonk: "the score exists but every change means a whole new
// song from a seed: luck, not craft. Edit it and render again: layer a pad, rewrite the cowbell riff, thin the drums
// for a breakdown."

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const phonk = (): SongSpec => composeStyle('phonk', { bars: 22, seed: 3 });
const notesIn = (spec: SongSpec, track: string, bars: [number, number]) => {
  const t = spec.tracks.find((x) => x.name === track)!;
  return t.notes.filter((n) => n.t >= (bars[0] - 1) * 4 - 1e-6 && n.t < bars[1] * 4 - 1e-6);
};

describe('a composed score', () => {
  it('names its parts and keeps its key and chords, so it can be edited by name', () => {
    const s = phonk();
    expect(s.tracks.map((t) => t.name)).toEqual(['cowbell', '808 intro', '808', 'kick', 'clap', 'snare', ...(s.tracks.some((t) => t.name === 'rim') ? ['rim'] : []), 'hat', 'open hat', 'crash', 'pad']);
    expect(s.key).toMatch(/^F (phrygian|minor)$/);
    expect(s.chords).toHaveLength(22);
    expect(s.chords![0]!.length).toBe(3);
    const lofi = composeStyle('lofi', { bars: 8, seed: 2 });
    expect(lofi.style).toBe('lofi');
    expect(lofi.chords).toHaveLength(8);
    expect(lofi.tracks.map((t) => t.name)).toContain('melody');
    expect(sectionBars(s)).toEqual([
      { name: 'Intro', from: 1, to: 4 },
      { name: 'Drop', from: 5, to: 12 },
      { name: 'Breakdown', from: 13, to: 14 },
      { name: 'Drop 2', from: 15, to: 22 },
    ]);
    expect(spanBeats(s, { section: 'breakdown' })).toEqual([48, 56]);
    expect(spanBeats(s, { bars: [5, 12] })).toEqual([16, 48]);
  });
});

describe('editing a score', () => {
  it('thins the drums for a breakdown, clears a section, and rewrites the riff as a repeated 2-bar pattern', () => {
    const s = phonk();
    const riff: Array<[number, number, string, number]> = [[0, 0.25, 'F5', 1], [0.75, 0.25, 'Ab5', 0.8], [1.5, 0.25, 'C6', 0.8], [3, 0.5, 'Bb5', 0.9], [4, 0.25, 'F5', 1], [5.5, 0.25, 'Eb5', 0.8]];
    const { spec, changes } = editScore(s, [
      { op: 'thin', track: 'hat', keep: 'beats', section: 'Drop 2' },
      { op: 'clear', track: 'clap', bars: [15, 16] },
      { op: 'notes', track: 'cowbell', section: 'Drop', notes: riff, every: 2 },
    ]);
    expect(notesIn(spec, 'hat', [15, 22]).every((n) => Math.abs(n.t - Math.round(n.t)) < 0.06)).toBe(true);
    expect(notesIn(spec, 'hat', [15, 22]).length).toBeLessThan(notesIn(s, 'hat', [15, 22]).length);
    expect(notesIn(spec, 'hat', [5, 12])).toEqual(notesIn(s, 'hat', [5, 12]));
    expect(notesIn(spec, 'clap', [15, 16])).toEqual([]);
    const cow = notesIn(spec, 'cowbell', [5, 12]);
    expect(cow).toHaveLength(6 * 4);
    expect(cow.slice(0, 6).map((n) => [n.t - 16, n.n])).toEqual(riff.map(([t, , n]) => [t, n]));
    expect(cow.slice(6, 12).map((n) => n.t - 24)).toEqual(riff.map(([t]) => t));
    expect(notesIn(spec, 'cowbell', [1, 4])).toEqual(notesIn(s, 'cowbell', [1, 4]));
    expect(changes).toHaveLength(3);
    expect(changes[2]).toMatch(/cowbell: 24 notes written in section Drop \(a 2-bar pattern repeated\)/);
  });

  it('layers a pad from the chords, swaps a part for a sample, adds a riser and an impact, and sets the song', () => {
    const { spec, changes } = editScore(phonk(), [
      { op: 'add', instrument: 'strings', name: 'strings', pattern: 'chords', octave: 1, section: 'Breakdown', volume: 0.6 },
      { op: 'set', track: 'cowbell', sample: 'tr808-cowbell', send: 0.3 },
      { op: 'add', instrument: 'texture', name: 'vinyl', sample: 'vinyl-crackle', pattern: 'bed' },
      { op: 'riser', at: 15, bars: 2 },
      { op: 'impact', at: 15 },
      { op: 'song', bpm: 132, duckRelease: 0.15, tape: { wow: 0.3, hiss: 0.2 }, delay: { left: 0.5 } },
      { op: 'set', track: 'pad', auto: { lp: [[48, 2400], [56, 600], [60, 2400]] } },
    ]);
    const strings = spec.tracks.find((t) => t.name === 'strings')!;
    expect(strings.notes.length).toBe(2 * 3);
    expect(strings.notes.every((n) => n.t >= 48 && n.t < 56)).toBe(true);
    expect(midiOf(strings.notes[0]!.n!)).toBe(spec.chords![12]![0]! + 12);
    expect(spec.tracks.find((t) => t.name === 'cowbell')).toMatchObject({ sample: 'tr808-cowbell', send: 0.3 });
    expect(spec.tracks.find((t) => t.name === 'vinyl')!.notes).toEqual([{ t: 0, d: 88, v: 0.8, o: 0 }]);
    expect(spec.tracks.find((t) => t.instrument === 'riser')!.notes).toEqual([{ t: 48, d: 8, n: 'C4', v: 0.9 }]);
    expect(spec.tracks.find((t) => t.instrument === 'impact')!.notes[0]!.t).toBe(56);
    expect(spec).toMatchObject({ bpm: 132, duckRelease: 0.15, tape: { wow: 0.3, hiss: 0.2 }, delayTime: { left: 0.5 } });
    expect(changes.join('\n')).toMatch(/added track \d+ strings: 6 notes in section Breakdown/);
  });

  it('inserts, copies and deletes bars: notes, chords, sections and the intro move with them', () => {
    const s = phonk();
    const ins = editScore(s, [{ op: 'insert', at: 13, bars: 2, copy: [11, 12] }]).spec;
    expect(ins.beats).toBe(s.beats + 8);
    expect(ins.chords).toHaveLength(24);
    expect(sectionBars(ins).map((x) => `${x.name} ${x.from}-${x.to}`)).toEqual(['Intro 1-4', 'Drop 5-12', 'Breakdown 13-16', 'Drop 2 17-24']);
    expect(notesIn(ins, 'kick', [13, 14]).map((n) => r3(n.t - 48))).toEqual(notesIn(s, 'kick', [11, 12]).map((n) => r3(n.t - 40)));
    expect(notesIn(ins, 'kick', [17, 24]).map((n) => r3(n.t - 64))).toEqual(notesIn(s, 'kick', [15, 22]).map((n) => r3(n.t - 56)));
    const intro = editScore(s, [{ op: 'insert', at: 2, bars: 1 }]).spec;
    expect(intro.introBeats).toBe(20);
    const del = editScore(s, [{ op: 'delete', bars: [13, 14] }]).spec;
    expect(del.beats).toBe(s.beats - 8);
    expect(sectionBars(del).map((x) => x.name)).toEqual(['Intro', 'Drop', 'Drop 2']);
    expect(notesIn(del, 'kick', [13, 20]).map((n) => r3(n.t - 48))).toEqual(notesIn(s, 'kick', [15, 22]).map((n) => r3(n.t - 56)));
    const cp = editScore(s, [{ op: 'copy', from: [5, 6], to: 15, tracks: ['cowbell'] }]).spec;
    expect(notesIn(cp, 'cowbell', [15, 16]).map((n) => [r3(n.t - 56), n.n])).toEqual(notesIn(s, 'cowbell', [5, 6]).map((n) => [r3(n.t - 16), n.n]));
    expect(notesIn(cp, 'kick', [15, 16])).toEqual(notesIn(s, 'kick', [15, 16]));
  });

  it('refuses what is malformed, saying exactly what and where', () => {
    const s = phonk();
    const fails = (ops: Parameters<typeof editScore>[1]) => {
      try {
        editScore(s, ops);
      } catch (e) {
        expect(e).toBeInstanceOf(EditError);
        return (e as Error).message;
      }
      throw new Error('did not fail');
    };
    expect(fails([{ op: 'clear', track: 'tuba' }])).toMatch(/^ops\[0\] \(clear\): No track "tuba" \(tracks: 0 cowbell, 1 808 intro/);
    expect(fails([{ op: 'set', track: 'hat', volume: 0.5 }, { op: 'thin', track: 'hat', keep: 'beats', bars: [20, 30] }])).toMatch(/^ops\[1\] \(thin\): bars \[20, 30\] is outside the song \(bars 1-22/);
    expect(fails([{ op: 'clear', track: 'all', section: 'chorus' }])).toMatch(/No section "chorus" \(sections: Intro 1-4, Drop 5-12, Breakdown 13-14, Drop 2 15-22\)/);
    expect(fails([{ op: 'sections', sections: [{ name: 'A', bars: 10 }] }])).toMatch(/add up to 10 bars; the song has 22/);
    expect(fails([{ op: 'notes', track: 'cowbell', notes: [[0, 0.25, 'H9']] }])).toMatch(/Bad note "H9"/);
    expect(fails([{ op: 'delete', bars: [1, 22] }])).toMatch(/would leave no song/);
    const old = { ...s, chords: undefined };
    expect(() => editScore(old, [{ op: 'add', instrument: 'pad', pattern: 'chords' }])).toThrow(/has none .*give notes instead/);
  });

  it('renders what was not touched exactly as before (the same seed): craft, not another roll of the dice', () => {
    const s = composeStyle('phonk', { bars: 8, seed: 5 });
    s.seed = 7;
    const before = songStems(s, 7);
    const { spec } = editScore(s, [{ op: 'set', track: 'hat', volume: 0.3 }, { op: 'notes', track: 'cowbell', bars: [5, 6], notes: [[0, 0.25, 'F5', 1]] }]);
    const after = songStems(spec, 7);
    const diff = (a: Float32Array, b: Float32Array) => {
      let d = a.length === b.length ? 0 : Infinity;
      for (let i = 0; i < a.length && d < Infinity; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
      return d;
    };
    for (const [i, t] of spec.tracks.entries()) {
      if (t.name === 'hat' || t.name === 'cowbell') continue;
      expect(diff(after[i]!.L, before[i]!.L), t.name).toBe(0);
    }
    expect(diff(after[spec.tracks.findIndex((t) => t.name === 'hat')]!.L, before[s.tracks.findIndex((t) => t.name === 'hat')]!.L)).toBeGreaterThan(0.001);
  }, 60_000);

  it("takes the edits skill roblox-audio teaches (its table and its ambient drift phonk)", () => {
    const { spec, changes } = editScore(phonk(), [
      { op: 'set', track: 'cowbell', sample: 'tr808-cowbell' },
      { op: 'add', instrument: 'pad', name: 'pad 2', pattern: 'chords', section: 'Drop 2', duck: 0.7, hp: 200 },
      { op: 'thin', track: 'hat', keep: 'beats', section: 'Breakdown' },
      { op: 'clear', track: 'kick', section: 'Breakdown' },
      { op: 'riser', at: 15, bars: 2 },
      { op: 'impact', at: 15 },
      { op: 'set', track: 'pad', auto: { lp: [[48, 2400], [56, 500], [60, 2400]] } },
      { op: 'song', duckRelease: 0.15, tape: { wow: 0.3, hiss: 0.15, warmth: 0.3 } },
      { op: 'set', track: '808', drive: 0.6, slide: 0.7 },
      { op: 'add', instrument: 'texture', name: 'rain', sample: 'vinyl-crackle', pattern: 'bed', volume: 0.5 },
      { op: 'insert', at: 13, bars: 2, copy: [11, 12] },
    ]);
    expect(changes).toHaveLength(11);
    expect(spec.tracks.find((t) => t.name === '808')).toMatchObject({ drive: 0.6, slide: 0.7 });
  });

  it('reads back as the copilot sees it: sections, chords, parts with their bars, and notes bar by bar', () => {
    const s = phonk();
    const d = describeScore(s, { tracks: [0], bars: [5, 6] }) as { sections: string[]; chords: string[]; tracks: Array<{ track: number; name: string; bars: string }>; notes: Record<string, string[]> };
    expect(d.sections).toEqual(['Intro 1-4', 'Drop 5-12', 'Breakdown 13-14', 'Drop 2 15-22']);
    expect(d.chords[0]).toMatch(/^1: [A-G]#?\d [A-G]#?\d [A-G]#?\d$/);
    expect(d.tracks.find((t) => t.name === 'kick')!.bars).toBe('5-12, 15-22');
    expect(d.notes['0 cowbell']![0]).toMatch(/^bar 5: [\d.]+ [A-G]#?\d 0\.25 [\d.]+ \|/);
    expect(d.notes['0 cowbell']).toHaveLength(2);
  });
});
