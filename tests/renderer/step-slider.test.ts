import { describe, expect, it } from 'vitest';
import { labelledStops, nearestStop, stopForKey, stopFraction, stopOf } from '../../src/renderer/src/lib/step-slider';

// The settings page's sliders: dots along the track, and the handle always rests on one of them.
describe('a slider with stops', () => {
  it('puts its dots evenly along the track and snaps a drag or a click to the nearest', () => {
    expect([0, 1, 2, 3].map((i) => stopFraction(i, 4))).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(stopFraction(0, 1)).toBe(0);
    expect(nearestStop(0.4, 4)).toBe(1);
    expect(nearestStop(0.5, 4)).toBe(2);
    expect(nearestStop(-0.3, 4)).toBe(0);
    expect(nearestStop(1.7, 20)).toBe(19);
  });

  it('shows a value that is no stop on the nearest stop', () => {
    const kiln = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20];
    expect(stopOf(8, kiln)).toBe(5);
    // Shuriken lowered Kiln's builds to 5 by itself: the nearest dot (4 comes first of two equally near).
    expect(stopOf(5, kiln)).toBe(3);
    expect(stopOf(14, kiln)).toBe(7);
    expect(stopOf('thorough' as string, ['medium', 'high'])).toBe(0);
  });

  it('moves with the keyboard and names the ends and evenly between when there are many stops', () => {
    expect(stopForKey('ArrowRight', 3, 4)).toBe(3);
    expect(stopForKey('ArrowLeft', 0, 4)).toBe(0);
    expect(stopForKey('PageUp', 0, 20)).toBe(5);
    expect(stopForKey('End', 2, 20)).toBe(19);
    expect(stopForKey('a', 2, 20)).toBeNull();
    expect(labelledStops(5)).toEqual([0, 1, 2, 3, 4]);
    expect(labelledStops(20)).toEqual([0, 3, 6, 9, 12, 15, 19]);
    expect(labelledStops(20, 5)).toEqual([0, 5, 10, 15, 19]);
  });
});
