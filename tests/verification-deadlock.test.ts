import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYTEST_LIMITS } from '../src/core/roblox/playtest-lease';
import { STUDIO_WAIT } from '../src/core/roblox/studio-adapter';
import { withStudioCaller } from '../src/core/roblox/studio-context';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { coreHarness, waitFor } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * The user's 8-hour build lost about 115 minutes to this: a verification took the play-mode lease and then
 * queued its code sync behind agents' syncs, each of which sat in the Studio adapter waiting (up to 6 minutes
 * per Studio call) for the lease the verification held. Lease → sync queue against sync queue → lease.
 */
const makeCore = coreHarness();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = (runId: string, taskId: string | null = null) => ({ kind: 'agent' as const, runId, taskId, role: 'roblox-engineer', providerId: null, allowedTools: null });
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const savedWait = { ...STUDIO_WAIT };
const savedLease = { ...PLAYTEST_LIMITS };
beforeEach(() => {
  // What an agent's Studio call waits for a lease (6 minutes in the app): long next to how long the checks take here.
  Object.assign(STUDIO_WAIT, { maxMs: 3000, pollMs: 15, noteMs: 40 });
  Object.assign(PLAYTEST_LIMITS, { pollMs: 15 });
});
afterEach(() => {
  Object.assign(STUDIO_WAIT, savedWait);
  Object.assign(PLAYTEST_LIMITS, savedLease);
});

async function setup() {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  h.ctx.updateExtras({ syncMode: 'shuriken', syncMap: { 'src/Server': 'ServerScriptService/Server', 'src/Shared': 'ReplicatedStorage/Shared' } });
  const write = (rel: string, body: string) => {
    mkdirSync(join(h.root, rel, '..'), { recursive: true });
    writeFileSync(join(h.root, rel), body, 'utf8');
  };
  write('src/Server/Main.server.luau', 'print("main")\n');
  write('src/Shared/Config.luau', 'return { speed = 16 }\n');
  write('src/Shared/ShurikenEffects.luau', 'return {}\n');
  const sim = attachSim(h.core);
  const task = h.ctx.tasks.create({ kind: 'implement', title: 'Match loop', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification: [{ kind: 'luau_assert', name: 'loop_ready', luau: "return 'PASS'", datamodel: 'edit' }] });
  return { ...h, sim, task, write };
}

describe('a verification and the code syncs of agents', () => {
  it("is never stuck behind agents' syncs that wait for the lease it holds", async () => {
    const { core, ctx, root, sim, task } = await setup();
    const map = ctx.extras().syncMap;
    // Agent A's sync is under way (its first Studio call is still running) when the verification starts.
    let held = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    sim.before = async (tool) => {
      if (tool === 'execute_luau' && held++ === 0) await gate;
    };
    const a = core.tools.invoke('roblox_sync_push', {}, agent('run_a'));
    await waitFor(() => held > 0, 5000);
    // B's sync and C's runtime-file push (what vfx_create, audio_build and animation_build do) wait their turn behind A's.
    const b = core.tools.invoke('roblox_sync_push', {}, agent('run_b'));
    const c = withStudioCaller({ owner: 'run_c', kind: 'agent' }, () => core.sync.push(root, map, { only: ['src/Shared/ShurikenEffects.luau'] }));
    await sleep(60);

    const t0 = Date.now();
    const verifying = core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    await sleep(100);
    open();
    const report = await verifying;
    const took = Date.now() - t0;

    expect(report.passed, report.summary).toBe(true);
    expect(report.results.map((r) => r.name)).toEqual(['code sync', 'loop_ready']);
    // About as long as its checks: nowhere near one agent's wait for the lease, let alone several in a row.
    expect(took).toBeLessThan(STUDIO_WAIT.maxMs / 2);
    // Nobody lost a sync: the agents' pushes go through too, without a "Studio is still held" error.
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.isError, text(ra)).toBeFalsy();
    expect(rb.isError, text(rb)).toBeFalsy();
    expect(rc.errors).toEqual([]);
    expect(core.lease.holder).toBeNull();
    expect(sim.place.scripts.get('ServerScriptService/Server/Main')?.source).toBe('print("main")\n');
  }, 30000);

  it('an agent whose sync has to wait for Studio waits for the lease before it takes a place in the queue', async () => {
    const { core, ctx, root, sim } = await setup();
    const map = ctx.extras().syncMap;
    expect(core.lease.tryAcquire('verifier:t1')).toBe(true);
    const notes: string[] = [];
    const waiting = core.tools.invoke('roblox_sync_push', {}, agent('run_a'), undefined, ({ message }) => message && notes.push(message));
    await sleep(120);
    expect(sim.luau()).toEqual([]);
    // The holder's own sync has nobody in front of it.
    const t0 = Date.now();
    const own = await core.sync.push(root, map, { owner: 'verifier:t1' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(own.errors).toEqual([]);
    expect(own.created.sort()).toEqual(['ReplicatedStorage/Shared/Config', 'ReplicatedStorage/Shared/ShurikenEffects', 'ServerScriptService/Server/Main']);
    core.lease.release('verifier:t1');
    const r = await waiting;
    expect(r.isError, text(r)).toBeFalsy();
    expect(notes.some((n) => /Waiting for Studio: Shuriken's verification/.test(n))).toBe(true);
  }, 30000);

  it("the world's rebuild (it holds Studio too) pushes the code ahead of the agents' syncs waiting in line", async () => {
    const { core, ctx, root, sim } = await setup();
    const map = ctx.extras().syncMap;
    let held = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    sim.before = async (tool) => {
      if (tool === 'execute_luau' && held++ === 0) await gate;
    };
    const a = core.tools.invoke('roblox_sync_push', {}, agent('run_a'));
    await waitFor(() => held > 0, 5000);
    const b = core.tools.invoke('roblox_sync_push', {}, agent('run_b'));
    await sleep(40);
    const t0 = Date.now();
    const healing = (async () => {
      if (!(await core.lease.acquire('healer', 5000))) throw new Error('no lease');
      try {
        return await core.sync.push(root, map, { owner: 'healer' });
      } finally {
        core.lease.release('healer');
      }
    })();
    await sleep(80);
    open();
    const rep = await healing;
    expect(Date.now() - t0).toBeLessThan(STUDIO_WAIT.maxMs / 2);
    expect(rep.errors).toEqual([]);
    for (const r of await Promise.all([a, b])) expect(r.isError, text(r)).toBeFalsy();
  }, 30000);

  it("a playtest never starts in the middle of a code sync: it waits the seconds the sync takes", async () => {
    const { core, sim } = await setup();
    let held = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    sim.before = async (tool) => {
      if (tool === 'execute_luau' && held++ === 0) await gate;
    };
    const syncing = core.tools.invoke('roblox_sync_push', {}, agent('run_a'));
    await waitFor(() => held > 0, 5000);
    expect(core.lease.editing).toBe(true);
    expect(core.lease.tryAcquire('run_b')).toBe(false);
    const playing = core.tools.invoke('roblox_playtest', { action: 'start' }, agent('run_b'));
    await sleep(120);
    expect(sim.starts).toBe(0);
    open();
    const [rs, rp] = await Promise.all([syncing, playing]);
    expect(rs.isError, text(rs)).toBeFalsy();
    expect(rp.isError, text(rp)).toBeFalsy();
    // Every one of the sync's Studio calls ran in Edit mode, before play began.
    expect(sim.calls.findIndex((c) => c.tool === 'start_stop_play')).toBe(sim.calls.length - 1);
    expect(core.lease.holder?.owner).toBe('run_b');
    expect(core.lease.editing).toBe(false);
  }, 30000);

  it('an agent that syncs during its own playtest is told to stop it first, at once', async () => {
    const { core, sim } = await setup();
    expect((await core.tools.invoke('roblox_playtest', { action: 'start' }, agent('run_a'))).isError).toBeFalsy();
    const t0 = Date.now();
    const r = await core.tools.invoke('roblox_sync_push', {}, agent('run_a'));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/your own playtest runs: stop it first/);
    expect(sim.luau('Edit')).toEqual([]);
  }, 30000);

  it("a sync that can't get Studio in time says who holds it, and pushes nothing", async () => {
    STUDIO_WAIT.maxMs = 300;
    const { core, sim } = await setup();
    core.lease.tryAcquire('verifier:t9');
    const r = await core.tools.invoke('roblox_sync_push', {}, agent('run_a'));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Studio is still held by Shuriken's verification/);
    expect(text(r)).toMatch(/not a blocker/);
    expect(sim.luau()).toEqual([]);
  }, 30000);
});

describe('Edit-mode work and the lease', () => {
  it('begins only while nobody else holds Studio or is waiting to take it, and keeps Studio from being taken until it ends', async () => {
    const { PlaytestLease } = await import('../src/core/roblox/playtest-lease');
    const lease = new PlaytestLease();
    expect(lease.beginEdit('run_a')).toBe(true);
    expect(lease.tryAcquire('run_b')).toBe(false);
    // Someone waiting for Studio comes before Edit-mode work that hasn't begun.
    const taking = lease.acquire('verifier:t1', 2000);
    await sleep(30);
    expect(lease.beginEdit('run_c')).toBe(false);
    lease.endEdit();
    expect(await taking).toBe(true);
    expect(lease.holder?.owner).toBe('verifier:t1');
    // The holder's own work always begins; others' doesn't.
    expect(lease.beginEdit('verifier:t1')).toBe(true);
    expect(lease.beginEdit('run_c')).toBe(false);
    lease.endEdit();
    lease.release('verifier:t1');
    expect(lease.beginEdit('run_c')).toBe(true);
    lease.endEdit();
    expect(lease.editing).toBe(false);
  });
});
