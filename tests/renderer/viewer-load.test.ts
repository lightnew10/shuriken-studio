import { describe, expect, it } from 'vitest';
import { acceptShot, failRetryDelay, keepPrevious, LoadGate, VIEWER_LOAD } from '../../src/renderer/src/lib/viewer-load';

/**
 * The Studio viewer showed "grey flashes across the screen" and sometimes stayed grey. An empty replica is a grey
 * ground under a sky, and a Studio picture taken while Studio switches modes is a grey frame.
 */
describe('what the viewer does with an empty read', () => {
  it('keeps the scene it shows when one read finds no parts, and believes the second empty read in a row', () => {
    expect(keepPrevious(4200, 0, 0)).toBe(true);
    expect(keepPrevious(4200, 0, 1)).toBe(false);
    // Nothing shown yet, or parts came: the read is what it is.
    expect(keepPrevious(0, 0, 0)).toBe(false);
    expect(keepPrevious(4200, 3900, 0)).toBe(false);
  });

  it('tries a failed read again by itself, further and further apart, then waits for the next change', () => {
    expect([1, 2, 3, 4].map(failRetryDelay)).toEqual([...VIEWER_LOAD.failRetryMs]);
    expect(failRetryDelay(5)).toBeNull();
  });
});

describe('reads of the place, while Studio changes all the time', () => {
  const deferred = () => {
    let done = (): void => undefined;
    const promise = new Promise<void>((r) => (done = r));
    return { promise, done };
  };

  it('lets the read under way finish, and makes one more for everything that changed meanwhile', async () => {
    const runs: Array<{ terrain: boolean; d: ReturnType<typeof deferred> }> = [];
    const gate = new LoadGate((terrain) => {
      const d = deferred();
      runs.push({ terrain, d });
      return d.promise;
    });
    gate.request(false);
    // Three changes in Studio while the first read is still coming in (one of them wants the terrain again).
    gate.request(false);
    gate.request(true);
    gate.request(false);
    expect(runs).toHaveLength(1);
    expect(gate.loading).toBe(true);
    runs[0]!.d.done();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs.map((r) => r.terrain)).toEqual([false, true]);
    runs[1]!.d.done();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toHaveLength(2);
    expect(gate.loading).toBe(false);
    // Idle again: the next change reads at once.
    gate.request(false);
    expect(runs).toHaveLength(3);
  });

  it('goes on after a read that threw', async () => {
    let n = 0;
    const gate = new LoadGate(async () => {
      if (++n === 1) throw new Error('execute_luau timed out after 120 s');
    });
    gate.request(true);
    gate.request(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBe(2);
    expect(gate.loading).toBe(false);
  });
});

describe("Studio's own picture over the replica", () => {
  const stats = (l: number, sd: number) => ({ r: l, g: l, b: l, l, sd });

  it('is not shown when it is a blank frame, or much flatter than the replica of the same view', () => {
    expect(acceptShot(null, stats(120, 50))).toBe(false);
    expect(acceptShot(stats(128, 6), stats(120, 50))).toBe(false);
    // A grey viewport with a little interface on it, where the replica shows a town.
    expect(acceptShot(stats(128, 17), stats(120, 52))).toBe(false);
  });

  it('is shown when it can be this view: as much contrast as the replica, or a plain view that is plain in both', () => {
    expect(acceptShot(stats(110, 44), stats(120, 52))).toBe(true);
    expect(acceptShot(stats(150, 18), stats(150, 20))).toBe(true);
    // No replica picture to compare with: only the blank frame is turned away.
    expect(acceptShot(stats(128, 17), null)).toBe(true);
  });
});
