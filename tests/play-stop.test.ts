import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { PLAY_RETRY, RobloxStudioAdapter } from '../src/core/roblox/studio-adapter';
import { coreHarness, waitFor } from './helpers/make-core';

const ok = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });
const fail = (e: string): ExternalCallResult => ({ ok: false, content: [], error: e, durationMs: 1 });
const EDIT = 'Current Studio Mode: Edit\nAvailable DataModels: Edit\nFocused DataModel in the viewport: Edit';
const PLAYING = 'Current Studio Mode: Play\nAvailable DataModels: Client, Server\nFocused DataModel in the viewport: Client';
const STARTING = "Start play hasn't finished yet";

/** A Studio MCP whose tools answer from a script: `play(n)` is the answer to the nth start_stop_play call. */
class ScriptedStudio extends RobloxStudioAdapter {
  playCalls: boolean[] = [];

  constructor(
    private readonly play: (n: number) => ExternalCallResult | Promise<ExternalCallResult>,
    private readonly mode: () => string = () => EDIT,
  ) {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }

  override async call(tool: string, args: Record<string, unknown>): Promise<ExternalCallResult> {
    if (tool === 'start_stop_play') {
      this.playCalls.push(args.is_start as boolean);
      return this.play(this.playCalls.length);
    }
    if (tool === 'get_studio_state') return ok(this.mode());
    return fail(`unexpected tool ${tool}`);
  }
}

afterEach(() => {
  Object.assign(PLAY_RETRY, { retries: 5, delayMs: 2000 });
});

describe('stopping play while it is still starting', () => {
  it('asks again until Studio is ready, then waits for Edit mode', async () => {
    PLAY_RETRY.delayMs = 5;
    const studio = new ScriptedStudio((n) => (n < 3 ? fail(STARTING) : ok('Game Stopped')));
    const st = await studio.setPlaying(false);
    expect(studio.playCalls).toEqual([false, false, false]);
    expect(st.availableDataModels).toEqual(['Edit']);
  });

  it('gives up with Studio\'s own words once the tries are used', async () => {
    PLAY_RETRY.delayMs = 5;
    const studio = new ScriptedStudio(() => fail(STARTING));
    await expect(studio.setPlaying(false)).rejects.toThrow(STARTING);
    // The first ask and five more.
    expect(studio.playCalls).toHaveLength(1 + PLAY_RETRY.retries);
  });

  it('asks again for a start that meets a stop in progress, but not for other errors', async () => {
    PLAY_RETRY.delayMs = 5;
    let playing = false;
    const start = new ScriptedStudio(
      (n) => {
        if (n < 2) return fail("Stop play hasn't finished yet");
        playing = true;
        return ok('Game Started');
      },
      () => (playing ? PLAYING : EDIT),
    );
    expect((await start.setPlaying(true)).availableDataModels).toEqual(['Client', 'Server']);
    expect(start.playCalls).toEqual([true, true]);
    const other = new ScriptedStudio(() => fail('No Roblox Studio instance is connected.'));
    await expect(other.setPlaying(false)).rejects.toThrow('No Roblox Studio instance');
    expect(other.playCalls).toHaveLength(1);
  });
});

describe("a run that ends while its playtest is starting", () => {
  const makeCore = coreHarness();
  const ended = (id: string) => ({ id, status: 'interrupted' }) as never;

  it("keeps play mode leased until the stop has gone through, so nobody builds into a place that is about to play", async () => {
    PLAY_RETRY.delayMs = 20;
    const { core } = await makeCore({ respond: async () => null });
    // Studio finishes starting only when the test says so (the third time it is asked).
    let started: () => void = () => undefined;
    const startedUp = new Promise<void>((resolve) => (started = resolve));
    const studio = new ScriptedStudio(async (n) => {
      if (n < 3) return fail(STARTING);
      await startedUp;
      return ok('Game Stopped');
    });
    core.studio.call = studio.call.bind(studio);
    expect(core.lease.tryAcquire('run_x')).toBe(true);
    core.bus.emit('run.updated', ended('run_x'));
    // Still starting: the stop asked again and is waiting for its answer; the lease is not let go meanwhile.
    await waitFor(() => studio.playCalls.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(core.lease.holder?.owner).toBe('run_x');
    started();
    await waitFor(() => !core.lease.holder);
    expect(studio.playCalls).toEqual([false, false, false]);
    expect(core.logger.recent(50, 'warn').some((r) => r.msg === 'Could not stop leaked playtest')).toBe(false);
  });

  it('lets go of the lease, and says so, when the stop never goes through', async () => {
    PLAY_RETRY.delayMs = 5;
    const { core } = await makeCore({ respond: async () => null });
    const studio = new ScriptedStudio(() => fail(STARTING));
    core.studio.call = studio.call.bind(studio);
    expect(core.lease.tryAcquire('run_y')).toBe(true);
    core.bus.emit('run.updated', ended('run_y'));
    await waitFor(() => !core.lease.holder);
    expect(studio.playCalls).toHaveLength(1 + PLAY_RETRY.retries);
    const warning = core.logger.recent(50, 'warn').find((r) => r.msg === 'Could not stop leaked playtest');
    expect(warning?.data).toContain(STARTING);
  });
});
