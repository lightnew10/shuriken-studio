import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { ROLES } from '../src/core/agents/roles';
import { imageStates, imagesInUseLuau, reviewNote, type ImageState } from '../src/core/roblox/image-status';
import { coreHarness } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * A texture Roblox has not approved yet renders flat grey. In the first 1.13 build a warehouse and four props stood
 * grey for 40 minutes; the critic failed the modeler's task ("looks like an untextured blockout") and proposed
 * re-uploading, which would only have queued the images again. Roblox's public thumbnail service said "Pending"
 * for all six.
 */
const makeCore = coreHarness();
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const critic = { kind: 'agent' as const, runId: 'run_critic', taskId: null, role: 'critic', providerId: null, allowedTools: null };
const answer = (states: Record<string, string>) =>
  vi.fn(async (url: string | URL) => {
    const ids = /assetIds=([\d,]+)/.exec(String(url))![1]!.split(',');
    return new Response(JSON.stringify({ data: ids.filter((id) => states[id]).map((id) => ({ targetId: Number(id), state: states[id], imageUrl: null })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

afterEach(() => vi.unstubAllGlobals());

describe('where an image is in Roblox\'s review', () => {
  it('reads approved, pending and blocked, and unknown for what Roblox does not say', async () => {
    const fetchImpl = answer({ '1111': 'Completed', '2222': 'Pending', '3333': 'InReview', '4444': 'Blocked' });
    const states = await imageStates(['1111', '2222', '3333', '4444', '5555', '2222', 'not-an-id'], fetchImpl as unknown as typeof fetch);
    expect(Object.fromEntries(states)).toEqual({ '1111': 'approved', '2222': 'pending', '3333': 'pending', '4444': 'blocked', '5555': 'unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stays unknown when Roblox cannot be asked', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(Object.fromEntries(await imageStates(['1111'], down as unknown as typeof fetch))).toEqual({ '1111': 'unknown' });
  });

  it('looks at the colour maps, mesh textures and decals under a path', () => {
    const luau = imagesInUseLuau('Workspace/Map/Warehouse');
    expect(luau).toContain('local asked = "Workspace/Map/Warehouse"');
    expect(luau).toMatch(/d:IsA\("SurfaceAppearance"\)[\s\S]*d\.ColorMap/);
    expect(luau).toMatch(/d:IsA\("MeshPart"\)[\s\S]*d\.TextureID/);
    expect(imagesInUseLuau('')).toContain('roots = { workspace, game:GetService("ReplicatedStorage"), game:GetService("ServerStorage") }');
  });
});

// Two builds each grew about twenty follow-ups and several whole tasks about "grey, untextured" models that were
// only waiting for Roblox, and agents re-uploaded them or replaced their textures with flat colours.
describe('a placement says when its textures are still in review', () => {
  const studio = (used: unknown) => ({ runLuau: async () => ({ ok: true, output: JSON.stringify(used) }) });
  const states = (m: Record<string, ImageState>) => async (ids: string[]) => new Map(ids.map((id) => [id, m[id] ?? 'unknown']));

  it('counts the pending images and says that nothing is to be done', async () => {
    const note = await reviewNote(studio([{ id: '111', at: 'a' }, { id: '222', at: 'b' }, { id: '333', at: 'c' }]), states({ '111': 'pending', '222': 'approved', '333': 'pending' }), 'game.ReplicatedStorage.MapPieces.Blossom_House');
    expect(note).toMatch(/^2 of its 3 texture image\(s\) are still in Roblox's review: those parts show FLAT GREY in Studio and in playtests/);
    expect(note).toMatch(/don't re-upload, repaint or replace them with flat colours, and don't report it as a defect/);
  });

  it('says nothing when they are approved, when the model has no textures, or when it cannot be told', async () => {
    expect(await reviewNote(studio([{ id: '111', at: 'a' }]), states({ '111': 'approved' }), 'Workspace.Map.House')).toBeNull();
    expect(await reviewNote(studio([]), states({}), 'Workspace.Map.Crate')).toBeNull();
    expect(await reviewNote(studio({ error: 'no instance at Workspace.Gone' }), states({}), 'Workspace.Gone')).toBeNull();
    expect(await reviewNote({ runLuau: async () => ({ ok: false, output: 'Studio is busy' }) }, states({}), 'Workspace.Map.House')).toBeNull();
  });

  it('the planner plans no work for grey models that only wait for Roblox', () => {
    const planner = ROLES.executive!.instructions;
    expect(planner).toMatch(/almost always waiting for Roblox to approve their texture images/);
    expect(planner).toMatch(/never plan a task for it, never have\s+textures replaced with flat colours or re-uploaded for it, and drop follow-ups that ask for it/);
  });
});

describe('texture_status', () => {
  async function setup(used: Array<{ id: string; at: string }>, states: Record<string, string>) {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    const sim = attachSim(h.core);
    sim.answer = (code) => (code.includes('SurfaceAppearance') ? JSON.stringify(used) : 'PASS');
    vi.stubGlobal('fetch', answer(states));
    return h;
  }

  it('says which grey parts only wait for Roblox, and that nothing is to be done about them', async () => {
    const { core } = await setup(
      [
        { id: '100000000000003', at: 'ReplicatedStorage.MapPieces.Warehouse.Warehouse_Palette' },
        { id: '100000000000004', at: 'ReplicatedStorage.MapPieces.ShelfUnit' },
        { id: '111111111', at: 'ReplicatedStorage.MapPieces.House_A' },
      ],
      { '100000000000003': 'Pending', '100000000000004': 'Pending', '111111111': 'Completed' },
    );
    const r = await core.tools.invoke('texture_status', { path: 'ReplicatedStorage/MapPieces' }, critic);
    const out = text(r);
    expect(r.isError, out).toBeFalsy();
    expect(out).toMatch(/3 image\(s\) colour parts under ReplicatedStorage\/MapPieces: 1 approved, 2 pending, 0 blocked\./);
    expect(out).toMatch(/PENDING \(Roblox is still reviewing them; these parts render flat grey until it approves\. Not a defect of the work: don't re-upload, rebuild or ask Kiln again; judge the look with model_view\): ReplicatedStorage\.MapPieces\.Warehouse\.Warehouse_Palette \(100000000000003\); ReplicatedStorage\.MapPieces\.ShelfUnit \(100000000000004\)/);
    expect(out).not.toMatch(/BLOCKED/);
  });

  it('names an image Roblox removed as what has to be repainted', async () => {
    const { core } = await setup([{ id: '222222222', at: 'Workspace.Map.Vending' }], { '222222222': 'Blocked' });
    const out = text(await core.tools.invoke('texture_status', {}, critic));
    expect(out).toMatch(/1 image\(s\) colour parts: 0 approved, 0 pending, 1 blocked\./);
    expect(out).toMatch(/BLOCKED \(Roblox removed these images: the part stays grey; have that texture repainted with kiln_request kind "fix"\): Workspace\.Map\.Vending \(222222222\)/);
  });

  it('the critic has the tool and is told that pending is not a defect', () => {
    const c = ROLES.critic!;
    expect(c.appTools).toContain('texture_status');
    expect(c.instructions).toMatch(/A textured model that shows FLAT GREY in Studio: run texture_status on it before you judge/);
    expect(c.instructions).toMatch(/not a defect of the work and never a reason to re-upload, rebuild or ask Kiln again/);
    expect(ROLES['environment-artist']!.instructions).toMatch(/texture_status says so\. Pending needs no fix \(never re-upload\)/);
  });
});
