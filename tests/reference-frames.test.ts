import { describe, expect, it } from 'vitest';
import { scanTimes, REFERENCE_LIMITS, referenceKindOf, clock } from '../src/shared/references';
import { alignEvents, coverageLine, nearestFrame, palette, pickForStudy, planFrames, sceneCuts, type Signature } from '../src/core/references/frames';

/** Which moments of a reference video become frames, and which of those the study run sees. */

function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A 32×18 scan picture of a flat colour with some noise, or a gradient that slides (a camera pan). */
function sig(t: number, base: [number, number, number], r: () => number, shift = -1): Signature {
  const w = 32;
  const h = 18;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = shift >= 0 ? ((x + shift) % w) * 4 : 0;
      for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, base[c]! + g + (r() - 0.5) * 20));
    }
  return { t, w, h, rgb };
}

describe('scan plan', () => {
  it('reads a short clip every half second and a long one at most 240 times, never at the very end', () => {
    const short = scanTimes(10);
    expect(short.length).toBe(20);
    expect(short[0]).toBe(0);
    expect(short.at(-1)!).toBeLessThanOrEqual(9.92);
    const long = scanTimes(600);
    expect(long.length).toBe(REFERENCE_LIMITS.scanPoints);
    expect(long[1]).toBeCloseTo(2.5, 5);
    expect(scanTimes(Infinity)).toEqual([0]);
    expect(scanTimes(0)).toEqual([0]);
  });

  it('knows videos from pictures by extension', () => {
    expect(referenceKindOf('Combat clip.MP4')).toBe('video');
    expect(referenceKindOf('ui.webp')).toBe('image');
    expect(referenceKindOf('notes.txt')).toBeNull();
    expect(clock(134)).toBe('2:14');
    expect(clock(7.5, true)).toBe('0:07.5');
  });
});

describe('scene changes', () => {
  it('finds the cut between two scenes and none in a camera pan', () => {
    const r = rnd(1);
    const sigs = [...Array.from({ length: 20 }, (_, i) => sig(i * 0.5, [60, 160, 70], r)), ...Array.from({ length: 20 }, (_, i) => sig(10 + i * 0.5, [20, 30, 120], r))];
    const cuts = sceneCuts(sigs);
    expect(cuts.map((c) => c.t)).toEqual([10]);
    const pan = Array.from({ length: 40 }, (_, i) => sig(i * 0.5, [80, 90, 100], r, i));
    expect(sceneCuts(pan)).toEqual([]);
  });

  it('keeps cuts at least a second apart (a flash is one change, not two)', () => {
    const r = rnd(2);
    const sigs = Array.from({ length: 30 }, (_, i) => sig(i * 0.5, i === 12 ? [250, 250, 250] : i > 20 ? [200, 40, 40] : [40, 40, 200], r));
    const cuts = sceneCuts(sigs);
    expect(cuts.length).toBe(2);
    expect(cuts[0]!.t).toBeGreaterThanOrEqual(6);
    expect(cuts[0]!.t).toBeLessThanOrEqual(6.5);
    expect(cuts[1]!.t).toBe(10.5);
  });
});

describe('frame plan', () => {
  it('spreads frames one a second on a short clip', () => {
    const plan = planFrames({ duration: 5, cuts: [], sounds: [], max: 60 });
    expect(plan.map((f) => f.t)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.every((f) => f.why === 'even')).toBe(true);
  });

  it('takes frames after cuts and at loud hits, stays under the cap and keeps them apart', () => {
    const sounds = Array.from({ length: 30 }, (_, i) => ({ t: 3 + i * 3.9, score: i }));
    const plan = planFrames({ duration: 120, cuts: [{ t: 30, strength: 0.6 }, { t: 61.5, strength: 0.4 }], sounds, max: 60 });
    expect(plan.length).toBeLessThanOrEqual(60);
    expect(plan.filter((f) => f.why === 'scene').map((f) => f.t)).toEqual([30, 61.5]);
    const loud = plan.filter((f) => f.why === 'sound');
    expect(loud.length).toBe(12);
    // The strongest hits are the ones kept.
    expect(Math.min(...loud.map((f) => f.t))).toBeGreaterThan(sounds[17]!.t - 0.01);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.t - plan[i - 1]!.t).toBeGreaterThanOrEqual(0.2);
    const evens = plan.filter((f) => f.why === 'even');
    expect(evens[0]!.t).toBe(0);
    expect(evens.at(-1)!.t).toBeGreaterThan(110);
    expect(coverageLine(120, plan)).toMatch(/^\d+ frames over 2:00, about one every \d s: \d+ spread evenly, 2 right after cuts, 12 at loud hits\. Motion between frames is not seen\.$/);
  });

  it('shows the study run its budget: the loudest key moments, and the whole clip covered', () => {
    const plan = planFrames({ duration: 120, cuts: [{ t: 30, strength: 0.6 }], sounds: [{ t: 50, score: 1 }, { t: 90, score: 2 }], max: 60 });
    const picks = pickForStudy(plan, 28, [{ t: 90, peakDb: -3 }, { t: 50, peakDb: -9 }]);
    expect(picks.length).toBe(28);
    expect(picks.map((f) => f.t)).toEqual(expect.arrayContaining([30, 50, 90]));
    const times = picks.map((f) => f.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    let gap = 0;
    for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i]! - times[i - 1]!);
    expect(gap).toBeLessThan(10);
    // A clip with fewer frames than the budget shows them all.
    expect(pickForStudy(plan.slice(0, 10), 28)).toHaveLength(10);
  });

  it('pairs each loud hit with its nearest frame', () => {
    const frames = [0, 1, 2, 12.4, 13].map((t) => ({ t, file: `f-${t}.jpg`, why: 'even' as const }));
    expect(nearestFrame(12.37, frames)).toEqual({ t: 12.4, file: 'f-12.4.jpg', dt: 0.03 });
    const out = alignEvents([{ t: 1.9, peakDb: -6, riseDb: 20, decayMs: 120, character: 'mid', centroidHz: 1500 }], frames);
    expect(out[0]!.frame).toEqual({ t: 2, file: 'f-2.jpg', dt: 0.1 });
  });
});

describe('palette', () => {
  it('names the colours a picture is made of with their shares', () => {
    const rgb = new Uint8Array(100 * 3);
    for (let i = 0; i < 100; i++) rgb.set(i < 60 ? [200, 30, 30] : [20, 40, 210], i * 3);
    const p = palette([{ rgb }]);
    expect(p).toEqual([
      { hex: '#c81e1e', share: 0.6 },
      { hex: '#1428d2', share: 0.4 },
    ]);
  });
});
