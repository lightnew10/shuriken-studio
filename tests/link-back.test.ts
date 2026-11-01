import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { LINK_PLAY_WAIT, RobloxStudioAdapter } from '../src/core/roblox/studio-adapter';

/**
 * Studio froze for half a minute in a build and the plugin's link dropped. A playtest probe that came in that moment
 * went to Studio's own path, which refuses what the plugin may do: "The current thread cannot require 'Melee' since
 * 'Melee' has additional values for the Capabilities property". The playtest had begun with the plugin linked, so it
 * had no probe hosts to fall back on. The link was back eight seconds later.
 */
const REFUSED = "The current thread cannot require 'Melee' since 'Melee' has additional values for the Capabilities property: LoadUnownedAsset (and 3 more)";

class FrozenStudio extends RobloxStudioAdapter {
  mcp: string[] = [];
  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }
  protected override async callMcp(tool: string, args: Record<string, unknown>): Promise<ExternalCallResult> {
    this.mcp.push(`${tool}:${String(args.datamodel_type)}`);
    return { ok: false, content: [], error: REFUSED, durationMs: 1 };
  }
}

function fakeLink(comesBack: boolean) {
  const state = { linked: false, waited: [] as Array<[string, number]>, ran: [] as string[] };
  const link = {
    has: (dm: string) => (dm === 'Edit' ? false : state.linked),
    playProven: true,
    lostWithin: () => true,
    endPlay: () => undefined,
    waitFor: async (dm: string, ms: number) => {
      state.waited.push([dm, ms]);
      state.linked = comesBack;
      return comesBack;
    },
    run: (dm: string, code: string) => (state.linked ? (state.ran.push(`${dm}:${code}`), Promise.resolve({ ok: true, text: 'v3', durationMs: 2 })) : null),
  };
  return { link, state };
}

describe('a probe Studio refuses while the plugin is away for a moment', () => {
  it('waits for the plugin to come back and runs there', async () => {
    const studio = new FrozenStudio();
    const { link, state } = fakeLink(true);
    (studio as unknown as { link: unknown }).link = link;
    const r = await studio.runLuau('return require(game.ReplicatedStorage.Shared.Melee).version', 'Server');
    expect(r).toMatchObject({ ok: true, output: 'v3' });
    expect(studio.mcp).toEqual(['execute_luau:Server']);
    expect(state.waited).toEqual([['Server', LINK_PLAY_WAIT.backMs]]);
    expect(state.ran).toHaveLength(1);
  });

  it('answers with the refusal when the plugin stays away, and other errors are not waited for', async () => {
    const studio = new FrozenStudio();
    const { link, state } = fakeLink(false);
    (studio as unknown as { link: unknown }).link = link;
    const r = await studio.runLuau('return require(game.ReplicatedStorage.Shared.Melee).version', 'Server');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Capabilities property/);
    expect(state.waited).toHaveLength(1);
    // Without the plugin at all (switched off): Studio's answer as it is.
    const plain = new FrozenStudio();
    expect((await plain.runLuau('return 1', 'Server')).ok).toBe(false);
  });
});
