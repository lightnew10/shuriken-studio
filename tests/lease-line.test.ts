import { describe, expect, it } from 'vitest';
import { PlaytestLease } from '../src/core/roblox/playtest-lease';

/**
 * 1.13.1 froze a project's whole engine. The line for Studio is first come, first served, so a free Studio is not
 * given to a caller who is not first in line; `acquire` then asked again at once, without ever waiting on a timer.
 * A verification behind three playtests did that for its full ten minutes: one core at 100%, and no timer of that
 * engine fired, so the playtest at the head of the line (which waits on one) never took Studio either.
 */
describe('waiting in the line for Studio', () => {
  it('a caller who is not first in line lets timers run while it waits, so the one ahead of it can take Studio', async () => {
    const lease = new PlaytestLease();
    // The first in line stands there the way a playtest does: it asks every 50 ms.
    lease.want('run_first');
    let firstGotIt = false;
    const first = (async () => {
      for (let i = 0; i < 100 && !firstGotIt; i++) {
        await new Promise((r) => setTimeout(r, 50));
        firstGotIt = lease.tryAcquire('run_first');
      }
      lease.unwant('run_first');
    })();
    // A verification asks behind it, with a long patience.
    const t0 = Date.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const second = lease.acquire('verifier:t1', 5000);
    await first;
    clearInterval(timer);
    // Timers ran while it waited, and the first in line got Studio within a moment, not after the other's patience.
    expect(firstGotIt).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ticks).toBeGreaterThan(2);
    expect(lease.holder?.owner).toBe('run_first');
    // Then the second, when the first is done.
    lease.release('run_first');
    expect(await second).toBe(true);
    expect(lease.holder?.owner).toBe('verifier:t1');
  });

  it("a screenshot's turn goes ahead of waiting playtests, and playtests keep their order among themselves", () => {
    const lease = new PlaytestLease();
    lease.want('run_first');
    lease.want('run_second');
    lease.want('shot:run_third');
    expect(lease.tryAcquire('run_second')).toBe(false);
    expect(lease.tryAcquire('shot:run_third')).toBe(true);
    // While it draws, nobody plays.
    expect(lease.tryAcquire('run_first')).toBe(false);
    lease.unwant('shot:run_third');
    lease.release('shot:run_third');
    expect(lease.tryAcquire('run_second')).toBe(false);
    expect(lease.tryAcquire('run_first')).toBe(true);
    // A screenshot that waits draws before a playtest that waits, whichever asks at the moment Studio is free.
    lease.release('run_first');
    lease.unwant('run_first');
    const other = new PlaytestLease();
    other.want('run_b');
    other.want('shot:run_a');
    expect(other.tryAcquire('run_b')).toBe(false);
    expect(other.tryAcquire('shot:run_a')).toBe(true);
  });

  it('gives up after its patience when the one ahead never takes Studio, without spinning', async () => {
    const lease = new PlaytestLease();
    lease.want('run_gone');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    expect(await lease.acquire('saver', 200)).toBe(false);
    clearInterval(timer);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(ticks).toBeGreaterThan(5);
  });
});
