import { afterEach, describe, expect, it } from 'vitest';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { PLAYTEST_LIMITS, PlaytestLease } from '../src/core/roblox/playtest-lease';
import { coreHarness } from './helpers/make-core';
import { attachSim, fakePicture } from './helpers/studio-sim';
import { PLAY_START } from '../src/core/roblox/studio-adapter';

/**
 * A playtest is a hot potato. In the user's 12-agent build someone waited for Studio nearly all the time, and the
 * playtests driven by hand held it 35-98 s each (5-13 tool calls, with the agent thinking between them), where a
 * whole check in one call took 10-30 s. So the whole plan of a check goes into one call (steps), and a playtest
 * held by hand gives way sooner once others wait.
 */
const makeCore = coreHarness();
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };

async function setup() {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const sim = attachSim(h.core);
  sim.shot = fakePicture();
  sim.answer = async (code) => {
    if (code.includes('GetLogHistory')) return '{"ok":true,"errors":[]}';
    if (code.includes('CharacterAutoLoads')) return JSON.stringify({ character: true, player: true, autoLoads: true, waited: 0.2 });
    return /return "(\w+)"/.exec(code)?.[1] ?? 'ran';
  };
  return { ...h, sim };
}

describe('roblox_playtest "run" with steps: the whole plan of a check in one hold of Studio', () => {
  it('plays, does the steps in order (probes, keys, a wait, pictures), collects errors and stops', async () => {
    const { core, sim } = await setup();
    const r = await core.tools.invoke(
      'roblox_playtest',
      {
        action: 'run',
        seconds: 0,
        steps: [
          { luau: 'return "before"' },
          { keys: [{ action: 'keyPress', key_code: 'Space' }] },
          { wait: 0.01 },
          { client_luau: 'return "after"' },
          { screenshot: true },
          { mouse: [{ action: 'click', x: 10, y: 10 }] },
          { screenshot: true },
        ],
      },
      agent,
    );
    const out = text(r);
    expect(r.isError, out).toBeFalsy();
    expect(out).toMatch(/Step 1 \(server probe\): before/);
    expect(out).toMatch(/Step 2 \(keyboard\): /);
    expect(out).toMatch(/Step 3: 0\.01 s passed\./);
    expect(out).toMatch(/Step 4 \(client probe\): after/);
    expect(out).toMatch(/Step 5 \(screenshot\): picture 1 below\./);
    expect(out).toMatch(/Step 6 \(mouse\): /);
    expect(out).toMatch(/Step 7 \(screenshot\): picture 2 below\./);
    expect(out).toMatch(/No errors in the output\./);
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(2);
    // One start, one stop, and Studio saw the steps in the order they were written.
    expect(sim.starts).toBe(1);
    expect(sim.stops).toBe(1);
    const order = sim.calls
      .filter((c) => ['user_keyboard_input', 'user_mouse_input', 'screen_capture'].includes(c.tool) || (c.tool === 'execute_luau' && /return "(before|after)"/.test(c.code ?? '')))
      .map((c) => (c.tool === 'execute_luau' ? `${c.dm}` : c.tool));
    expect(order).toEqual(['Server', 'user_keyboard_input', 'Client', 'screen_capture', 'user_mouse_input', 'screen_capture']);
    expect(core.lease.holder).toBeNull();
  });

  it('takes at most four pictures, and refuses a step that sleeps in Studio before it plays', async () => {
    const { core, sim } = await setup();
    const many = await core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0, steps: [1, 2, 3, 4, 5].map(() => ({ screenshot: true })) }, agent);
    expect(many.content.filter((c) => c.type === 'image')).toHaveLength(4);
    expect(text(many)).toMatch(/Step 5 \(screenshot\): not taken \(a run takes at most 4 pictures\)\./);
    const starts = sim.starts;
    const sleepy = await core.tools.invoke('roblox_playtest', { action: 'run', steps: [{ luau: 'task.wait(60) return 1' }] }, agent);
    expect(sleepy.isError).toBe(true);
    expect(text(sleepy)).toMatch(/Not run: steps\[0\]\.luau waits 60 s in Studio/);
    expect(sim.starts).toBe(starts);
  });

  it("waits for a heavy place's playtest when Studio's start request times out, instead of failing and throwing the load away", async () => {
    const saved = { ...PLAY_START };
    Object.assign(PLAY_START, { minMs: 5000, maxMs: 8000, pollMs: 100, clientGraceMs: 1000 });
    try {
      const { core, sim } = await setup();
      sim.slowStartMs = 2500;
      const r = await core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0, steps: [{ luau: 'return "loaded"' }] }, agent);
      const out = text(r);
      expect(r.isError, out).toBeFalsy();
      expect(out).toMatch(/Step 1 \(server probe\): loaded/);
      expect(sim.starts).toBe(1);
      expect(sim.stops).toBe(1);
      expect(core.lease.holder).toBeNull();
      // The slow start is remembered: the next one is given twice as long before it is called a failure.
      expect(core.studio.playStartBudget()).toBeGreaterThanOrEqual(5000);
    } finally {
      Object.assign(PLAY_START, saved);
    }
  }, 30_000);

  it('gives up on a start that never comes up within its budget, says why, and stops what Studio was loading', async () => {
    const saved = { ...PLAY_START };
    Object.assign(PLAY_START, { minMs: 1500, maxMs: 1500, pollMs: 100, clientGraceMs: 500 });
    try {
      const { core, sim } = await setup();
      sim.slowStartMs = 60_000;
      const r = await core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0, steps: [{ luau: 'return "never"' }] }, agent);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/did not finish starting the playtest in \d+ s.*reopening the place/s);
      expect(core.lease.holder).toBeNull();
    } finally {
      Object.assign(PLAY_START, saved);
    }
  }, 30_000);

  it('tells an agent that sends input with no playtest to put it in a step', async () => {
    const { core } = await setup();
    const r = await core.tools.invoke('roblox_input', { device: 'keyboard', actions: [{ action: 'keyPress', key_code: 'Space' }] }, agent);
    expect(text(r)).toMatch(/Put the input in a step of roblox_playtest action "run"/);
  });
});

describe('roblox_screenshot with several shots', () => {
  it('takes every view in one call and one turn in the line', async () => {
    const { core, sim } = await setup();
    const held: Array<string | null> = [];
    sim.before = (tool) => {
      if (tool === 'screen_capture') held.push(core.lease.holder?.owner ?? null);
    };
    const r = await core.tools.invoke(
      'roblox_screenshot',
      { shots: [{ camera: [0, 40, 60], look_at: [0, 0, 0], title: 'overview' }, { camera: [10, 6, 10], look_at: [0, 4, 0], title: 'spawn, eye height' }, { title: 'as it is' }] },
      agent,
    );
    const out = text(r);
    expect(r.isError, out).toBeFalsy();
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(out).toMatch(/1\. overview: captured/);
    expect(out).toMatch(/2\. spawn, eye height: captured/);
    expect(out).toMatch(/3\. as it is: captured/);
    expect(sim.captures).toBe(3);
    // One turn: Studio was held for the caller's pictures from the first to the last, and is free afterwards.
    expect(held).toEqual(['shot:run_me', 'shot:run_me', 'shot:run_me']);
    expect(core.lease.holder).toBeNull();
    // One picture, as before.
    const one = await core.tools.invoke('roblox_screenshot', { camera: [0, 40, 60], look_at: [0, 0, 0] }, agent);
    expect(one.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(text(one)).toMatch(/Screenshot captured/);
  });
});

describe('the line for play mode', () => {
  it('is first come, first served: whoever asked first plays next, however the wake-ups fall', async () => {
    const saved = { ...PLAYTEST_LIMITS };
    Object.assign(PLAYTEST_LIMITS, { pollMs: 5 });
    try {
      const lease = new PlaytestLease();
      lease.tryAcquire('run_holder');
      const order: string[] = [];
      const wait = (owner: string) =>
        lease.acquire(owner, 5000).then((ok) => {
          expect(ok).toBe(true);
          order.push(owner);
          // Each plays for a moment, then lets go.
          return new Promise<void>((r) => setTimeout(() => (lease.release(owner), r()), 10));
        });
      const all = [wait('run_critic')];
      await new Promise((r) => setTimeout(r, 15));
      all.push(wait('run_vfx'));
      await new Promise((r) => setTimeout(r, 15));
      all.push(wait('run_animator'));
      await new Promise((r) => setTimeout(r, 15));
      // Someone who never stood in line can't take it past them when it comes free.
      lease.release('run_holder');
      expect(lease.tryAcquire('run_latecomer')).toBe(false);
      await Promise.all(all);
      expect(order).toEqual(['run_critic', 'run_vfx', 'run_animator']);
      // Nobody in line: anyone takes it.
      expect(lease.tryAcquire('run_latecomer')).toBe(true);
    } finally {
      Object.assign(PLAYTEST_LIMITS, saved);
    }
  });
});

describe('a playtest held by hand while others wait', () => {
  const saved = { ...PLAYTEST_LIMITS };
  afterEach(() => Object.assign(PLAYTEST_LIMITS, saved));

  it('plays 60 s once it is up (its load not counted), with no extension; 30 s without a Studio call gives way when others wait', () => {
    expect(PLAYTEST_LIMITS).toMatchObject({ playMs: 60_000, loadMs: 300_000, idleMs: 30_000 });
    const lease = new PlaytestLease();
    lease.tryAcquire('run_a');
    const since = lease.holder!.since;
    // Still loading: Studio gets it back only after the load allowance, whether or not others wait.
    expect(lease.expiresAt(false)).toBe(since + 300_000);
    expect(lease.expiresAt(true)).toBe(since + 300_000);
    expect(lease.overdue(since + 299_000, true)).toBeNull();
    // A load that takes 100 s is not counted: the 60 s start when the playtest is up.
    const up = since + 100_000;
    lease.markPlaying('run_a', up);
    expect(lease.playingSince).toBe(up);
    expect(lease.expiresAt(true)).toBe(up + 60_000);
    expect(lease.expiresAt(false)).toBe(up + 60_000);
    const busy = (ms: number) => {
      lease.touch('run_a');
      (lease as unknown as { lastActive: number }).lastActive = up + ms;
      return lease.overdue(up + ms, true);
    };
    expect(busy(59_000)).toBeNull();
    expect(busy(61_000)).toBe('long');
    expect(lease.overdue(up + 61_000, false)).toBe('long');
    // Quiet for 30 s while someone waits.
    (lease as unknown as { lastActive: number }).lastActive = up;
    expect(lease.overdue(up + 29_000, true)).toBeNull();
    expect(lease.overdue(up + 31_000, true)).toBe('idle');
    expect(lease.overdue(up + 31_000, false)).toBeNull();
    // A Studio call of the holder's that is still running (a capture that takes 40 s) is not idleness, and the
    // quiet time counts from when it ended.
    const ended = lease.busy('run_a');
    expect(lease.overdue(up + 40_000, true)).toBeNull();
    ended();
    expect(lease.overdue(Date.now() + 29_000, true)).toBeNull();
    // No extension: the cap is the cap.
    const asked = lease.extend('run_a', 'the round has one more minute');
    expect(asked.ok).toBe(false);
    expect(asked.message).toMatch(/not extended: one plays 60 s once it is up/);
    expect(lease.expiresAt(true)).toBe(up + 60_000);
  });

  it("Shuriken's own checks get up to the ceiling, and a whole check in one call gets the same 60 s of play", () => {
    const lease = new PlaytestLease();
    lease.tryAcquire('verifier:t1');
    expect(lease.expiresAt(true)).toBe(lease.holder!.since + PLAYTEST_LIMITS.ceilingMs);
    lease.release('verifier:t1');
    lease.tryAcquire('run_a');
    lease.markPlaying('run_a');
    // A shield is not a way past the cap for an agent's playtest.
    lease.shield('run_a', 4 * 60_000);
    expect(lease.expiresAt(true)).toBe(lease.playingSince + 60_000);
  });
});
