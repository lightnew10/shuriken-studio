import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILDER_TIMEOUT, LUAU_DOUBLES, rebuildWorld } from '../src/core/roblox/world-builder';
import { PLACE_FN } from '../src/core/modeling/model-store';

/**
 * world/Models.luau (the Kiln models, placed by Shuriken) run alone undid what a later builder had finished: in the RTS
 * build of 2 October every unit template held its art twice and lost its team colour, and the neutral templates their
 * turn. Whoever runs it now runs the builders ordered after it, and a rerun finds its old parts however they were
 * grouped or renamed.
 */
function world(order: string[], files: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-world-'));
  mkdirSync(join(root, 'world'));
  for (const f of files) writeFileSync(join(root, 'world', f), `return "${f}"`, 'utf8');
  writeFileSync(join(root, 'world', 'world.json'), JSON.stringify({ order }), 'utf8');
  return root;
}
const studio = (doubles = '{"count":0,"top":[]}') => {
  const ran: string[] = [];
  const s = {
    runLuau: async (code: string) => {
      // The look for things placed twice, after the builders.
      if (code === LUAU_DOUBLES) return { ok: true, output: doubles, durationMs: 1 };
      ran.push(/return "(.+)"/.exec(code)?.[1] ?? '?');
      return { ok: true, output: 'ok', durationMs: 1 };
    },
  };
  return { s: s as never, ran };
};

describe('a builder that runs out of time', () => {
  it('is run once more with longer, and only once', async () => {
    const root = world(['A.luau', 'Models.luau'], ['A.luau', 'Models.luau']);
    const calls: Array<{ file: string; ms: number }> = [];
    let slow = 1;
    const s = {
      runLuau: async (code: string, _dm: string, ms: number) => {
        if (code === LUAU_DOUBLES) return { ok: true, output: '{"count":0,"top":[]}', durationMs: 1 };
        const file = /return "(.+)"/.exec(code)?.[1] ?? '?';
        calls.push({ file, ms });
        if (file === 'Models.luau' && slow-- > 0) return { ok: false, output: 'MCP error -32001: Request timed out', durationMs: ms };
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    };
    const { results } = await rebuildWorld(s as never, root);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(calls).toEqual([
      { file: 'A.luau', ms: BUILDER_TIMEOUT.firstMs },
      { file: 'Models.luau', ms: BUILDER_TIMEOUT.firstMs },
      { file: 'Models.luau', ms: BUILDER_TIMEOUT.againMs },
    ]);
    // Twice out of time: reported, not tried a third time; an error of the builder's own is never retried.
    slow = 2;
    calls.length = 0;
    expect((await rebuildWorld(s as never, root, ['Models.luau'])).results[0]!.ok).toBe(false);
    expect(calls.filter((c) => c.file === 'Models.luau')).toHaveLength(2);
  });
});

describe('rerunning the Kiln models builder', () => {
  const order = ['Lighting.luau', 'MatchMap.luau', 'Models.luau', 'NeutralModels.luau', 'RTSUnitModels.luau'];
  const root = world(order, order);

  it('runs the builders that finish its models after it', async () => {
    const { s, ran } = studio();
    await rebuildWorld(s, root, ['Models.luau']);
    expect(ran).toEqual(['Models.luau', 'NeutralModels.luau', 'RTSUnitModels.luau']);
  });

  it('leaves any other builder run alone', async () => {
    const { s, ran } = studio();
    await rebuildWorld(s, root, ['NeutralModels.luau']);
    expect(ran).toEqual(['NeutralModels.luau']);
    const all = studio();
    await rebuildWorld(all.s, root);
    expect(all.ran).toEqual(order);
  });

  it('marks each placed part with the name it was placed under, and clears old ones by it', () => {
    expect(PLACE_FN).toMatch(/mp:SetAttribute\("ShurikenPart", p\.name\)/);
    expect(PLACE_FN).toMatch(/d:GetAttribute\("ShurikenPart"\) == name/);
  });
});

describe('a world built twice over', () => {
  it('says what stands twice at the same spot after the builders ran, and where', async () => {
    const root = world(['LobbyKit.luau', 'Assembly_Lobby.luau'], ['LobbyKit.luau', 'Assembly_Lobby.luau']);
    const found = JSON.stringify({ count: 2, top: [{ name: 'QueuePad', at: ['Workspace.Lobby.Pieces.QueuePad', 'Workspace.Lobby.Art.QueuePad'] }, { name: 'LobbyHangar', at: ['Workspace.Lobby.Pieces.LobbyHangar', 'Workspace.Lobby.Art.LobbyHangar'] }] });
    const { s } = studio(found);
    const out = await rebuildWorld(s, root);
    expect(out.doubles[0]).toMatch(/^Placed more than once at the same spot \(2 groups/);
    expect(out.doubles[1]).toBe('- QueuePad: Workspace.Lobby.Pieces.QueuePad, Workspace.Lobby.Art.QueuePad');
    // Nothing doubled: nothing said.
    expect((await rebuildWorld(studio().s, root)).doubles).toEqual([]);
  });
});
