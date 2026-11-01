import { describe, expect, it } from 'vitest';
import { RpcCoalescer } from '../../src/renderer/src/lib/rpc-coalescer';

describe('one request per method and parameters, shared by every view that asks', () => {
  it('shares a request in flight, and asks once more after it for those who asked meanwhile', async () => {
    const calls: number[] = [];
    let n = 0;
    const gates: Array<() => void> = [];
    const c = new RpcCoalescer((_m, _p) => {
      const i = ++n;
      calls.push(i);
      return new Promise((r) => gates.push(() => r(i)));
    });
    const a = c.fetch<number>('tasks.list|null', 'tasks.list', null);
    // Three more views ask while the first request runs: one more request after it, shared by all three.
    const b = c.fetch<number>('tasks.list|null', 'tasks.list', null);
    const d = c.fetch<number>('tasks.list|null', 'tasks.list', null);
    const e = c.fetch<number>('tasks.list|null', 'tasks.list', null);
    expect(calls).toEqual([1]);
    gates[0]!();
    expect(await a).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([1, 2]);
    gates[1]!();
    expect(await Promise.all([b, d, e])).toEqual([2, 2, 2]);
    // Another method or other parameters are their own requests.
    void c.fetch('runs.list|80', 'runs.list', 80);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('a failed request does not stop the next one', async () => {
    let first = true;
    const c = new RpcCoalescer(async () => {
      if (first) {
        first = false;
        throw new Error('No project is open');
      }
      return 'ok';
    });
    const a = c.fetch('x|null', 'x', null);
    const b = c.fetch('x|null', 'x', null);
    await expect(a).rejects.toThrow('No project is open');
    expect(await b).toBe('ok');
  });
});
