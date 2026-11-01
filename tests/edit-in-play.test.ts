import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { PLAYTEST_LIMITS, PlaytestLease } from '../src/core/roblox/playtest-lease';
import { STUDIO_WAIT } from '../src/core/roblox/studio-adapter';
import { withStudioCaller } from '../src/core/roblox/studio-context';
import { coreHarness, waitFor } from './helpers/make-core';
import { attachSim, fakePicture, linkEdit } from './helpers/studio-sim';

/**
 * Edit work during a playtest. Studio's MCP server refuses it ("Edit datamodel is not available in Play mode"), so
 * every agent's code sync and Edit Luau waited behind every playtest: in the user's 12-agent build someone was
 * waiting for Studio nearly all the time, up to the six-minute limit. Shuriken Link's Edit instance keeps running
 * during a playtest (measured in Studio 0.741, tests/e2e/link-edit-in-play.e2e.ts: 17 ms a call; changes stay out
 * of the running game, are there when play stops, and the next playtest has them). With the plugin linked only
 * playtests and Studio's own Edit-only tools (a screenshot) take turns.
 */
const makeCore = coreHarness();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = (runId: string) => ({ kind: 'agent' as const, runId, taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null });
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const MAP = { 'src/Server': 'ServerScriptService/Server', 'src/Shared': 'ReplicatedStorage/Shared' };

const savedWait = { ...STUDIO_WAIT };
const savedLease = { ...PLAYTEST_LIMITS };
beforeEach(() => {
  Object.assign(STUDIO_WAIT, { maxMs: 1500, pollMs: 15, noteMs: 40 });
  Object.assign(PLAYTEST_LIMITS, { pollMs: 15 });
});
afterEach(() => {
  Object.assign(STUDIO_WAIT, savedWait);
  Object.assign(PLAYTEST_LIMITS, savedLease);
});

async function setup(linked: boolean) {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  h.ctx.updateExtras({ syncMode: 'shuriken', syncMap: MAP });
  const write = (rel: string, body: string) => {
    mkdirSync(join(h.root, rel, '..'), { recursive: true });
    writeFileSync(join(h.root, rel), body, 'utf8');
  };
  write('src/Server/Main.server.luau', 'print("main v1")\n');
  write('src/Shared/Config.luau', 'return { speed = 16 }\n');
  const sim = attachSim(h.core);
  sim.shot = fakePicture();
  linkEdit(h.core, sim, linked);
  /** Another agent's playtest holds Studio. */
  const otherPlays = async () => {
    expect(h.core.lease.tryAcquire('run_other')).toBe(true);
    await h.core.studio.setPlaying(true);
    expect(sim.mode).toBe('Play');
  };
  return { ...h, sim, write, otherPlays };
}

describe("Edit work while another agent's playtest holds Studio, with the plugin linked", () => {
  it('a code sync goes through at once, and Luau in Edit too', async () => {
    const { core, sim, write, otherPlays } = await setup(true);
    await otherPlays();
    write('src/Server/Main.server.luau', 'print("main v2")\n');
    const t0 = Date.now();
    const push = await core.tools.invoke('roblox_sync_push', {}, agent('run_me'));
    expect(push.isError, text(push)).toBeFalsy();
    expect(sim.place.scripts.get('ServerScriptService/Server/Main')!.source).toBe('print("main v2")\n');
    const luau = await core.tools.invoke('roblox_run_luau', { code: 'return 1', datamodel: 'Edit' }, agent('run_me'));
    expect(luau.isError, text(luau)).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(STUDIO_WAIT.maxMs / 2);
    // The playtest was not touched.
    expect(sim.mode).toBe('Play');
    expect(core.lease.holder?.owner).toBe('run_other');
    expect(sim.stops).toBe(0);
  });

  it("without the plugin it waits for the playtest, as Studio's own server requires", async () => {
    const { core, sim, otherPlays } = await setup(false);
    await otherPlays();
    const push = core.tools.invoke('roblox_sync_push', {}, agent('run_me'));
    await sleep(200);
    expect(sim.place.scripts.size).toBe(0);
    await core.studio.setPlaying(false);
    core.lease.release('run_other');
    expect((await push).isError).toBeFalsy();
    expect(sim.place.scripts.size).toBe(2);
  });

  it("a task's checks that neither play nor take pictures run at once; checks that play still take their turn", async () => {
    const { core, sim, ctx, otherPlays } = await setup(true);
    const task = (verification: unknown[]) => ctx.tasks.create({ parentId: null, kind: 'implement', title: 'T', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'user', verification: verification as never });
    const editOnly = task([{ kind: 'static_analysis' }, { kind: 'luau_assert', name: 'config_speed', luau: 'return true' }]);
    const playing = task([{ kind: 'playtest', name: 'round_starts', durationSec: 2, failOnConsoleErrors: false }]);
    await otherPlays();
    const t0 = Date.now();
    // A run of checks with no playtest took up to 8 minutes in a 12-agent build, waiting behind every playtest.
    const quick = await core.tools.invoke('task_run_checks', {}, { ...agent('run_me'), taskId: editOnly.id });
    expect(quick.isError, text(quick)).toBeFalsy();
    expect(text(quick)).toMatch(/PASS {2}config_speed/);
    expect(Date.now() - t0).toBeLessThan(STUDIO_WAIT.maxMs / 2);
    expect(sim.mode).toBe('Play');
    expect(core.lease.holder?.owner).toBe('run_other');
    // A playtest check waits for the other agent's playtest.
    let done = false;
    const slow = core.tools.invoke('task_run_checks', {}, { ...agent('run_me2'), taskId: playing.id }).finally(() => (done = true));
    await sleep(300);
    expect(done).toBe(false);
    await core.studio.setPlaying(false);
    core.lease.release('run_other');
    await slow;
  });

  it("a screenshot still waits its turn: it is Studio's own tool and needs Edit mode", async () => {
    const { core, sim, otherPlays } = await setup(true);
    await otherPlays();
    const shot = core.tools.invoke('roblox_screenshot', {}, agent('run_me'));
    await sleep(200);
    expect(sim.captures).toBe(0);
    await core.studio.setPlaying(false);
    core.lease.release('run_other');
    expect((await shot).isError).toBeFalsy();
    expect(sim.captures).toBe(1);
  });

  it("an agent's push during its OWN playtest is still told to stop it first (that game would keep running the old code)", async () => {
    const { core, sim } = await setup(true);
    expect(core.lease.tryAcquire('run_me')).toBe(true);
    await core.studio.setPlaying(true);
    const push = await core.tools.invoke('roblox_sync_push', {}, agent('run_me'));
    expect(text(push)).toMatch(/your own playtest runs: stop it first/);
    expect(sim.place.scripts.size).toBe(0);
  });

  it('should the link drop, a call that Studio refuses goes back to waiting instead of failing', async () => {
    const { core, sim, otherPlays } = await setup(true);
    await otherPlays();
    // The adapter still believes the plugin is linked; Studio answers as its own server does.
    sim.linkedEdit = false;
    const call = withStudioCaller({ owner: 'run_me', kind: 'agent' }, () => core.studio.runLuau('return 1', 'Edit'));
    await sleep(150);
    await core.studio.setPlaying(false);
    core.lease.release('run_other');
    expect(await call).toMatchObject({ ok: true });
  });
});

describe('a playtest that starts while code is being synced', () => {
  it('waits for the sync under way, and no new sync begins until Studio has made its copy of the place', async () => {
    const { core, sim, write, root } = await setup(true);
    // A push whose first Studio call is still running.
    let held = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    sim.before = async (tool, args) => {
      if (tool === 'execute_luau' && args.datamodel_type === 'Edit' && held++ === 0) await gate;
    };
    const first = core.tools.invoke('roblox_sync_push', {}, agent('run_a'));
    await waitFor(() => held > 0, 5000);
    // Another agent starts a playtest: Studio isn't put into play mode in the middle of the push.
    const play = core.tools.invoke('roblox_playtest', { action: 'start' }, agent('run_b'));
    await sleep(150);
    expect(sim.starts).toBe(0);
    open();
    expect((await first).isError).toBeFalsy();
    expect((await play).isError).toBeFalsy();
    expect(sim.starts).toBe(1);
    expect(sim.place.scripts.size).toBe(2);
    // And with the playtest up, the next push goes through during it.
    write('src/Shared/Config.luau', 'return { speed = 20 }\n');
    const during = await withStudioCaller({ owner: 'run_a', kind: 'agent' }, () => core.sync.push(root, MAP));
    expect(during.errors).toEqual([]);
    expect(sim.place.scripts.get('ReplicatedStorage/Shared/Config')!.source).toBe('return { speed = 20 }\n');
    expect(sim.mode).toBe('Play');
  });

  it('the lease: Edit work begins during a playtest only with the plugin, and never while one is starting', async () => {
    const lease = new PlaytestLease();
    lease.tryAcquire('run_b');
    expect(lease.beginEdit('run_a')).toBe(false);
    lease.editInPlay = () => true;
    expect(lease.beginEdit('run_a')).toBe(true);
    // A start waits for that work, and keeps new work out.
    let started = false;
    const starting = lease.beginPlayStart().then(() => (started = true));
    await sleep(60);
    expect(started).toBe(false);
    expect(lease.beginEdit('run_c')).toBe(false);
    lease.endEdit();
    await starting;
    expect(started).toBe(true);
    expect(lease.beginEdit('run_c')).toBe(false);
    lease.endPlayStart();
    expect(lease.beginEdit('run_c')).toBe(true);
    lease.endEdit();
  });
});
