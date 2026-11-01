import { describe, expect, it } from 'vitest';
import { ROLES, tierFor } from '../src/core/agents/roles';
import { DEFAULT_PROJECT_SETTINGS } from '../src/core/projects/project-service';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * Models and effort. The critic runs on the deep tier at medium effort (the user's decision after the first A–Z
 * build, where the balanced-tier critic passed 38 of 38 reviews), and the planner thinks at medium (at xhigh it took 5-8 minutes to its first task): it runs once per
 * plan and every wait of that build came from its task graph. A project that never chose its tiers gets the new
 * default, although 1.9 wrote its defaults into every project's saved settings.
 */
const makeCore = coreHarness();
const TIERS_1_9 = { executive: 'deep', worker: 'deep', critic: 'balanced', research: 'balanced', chat: 'balanced' };
const saved = (ctx: Awaited<ReturnType<typeof makeCore>>['ctx']) => JSON.parse(ctx.store.get<{ value: string }>(`SELECT value FROM project_settings WHERE key = 'settings'`)!.value) as Record<string, unknown>;

describe('default model tiers and effort', () => {
  it('runs the planner, the workers and the critic on the deep tier; research and chat on the balanced one', () => {
    expect(DEFAULT_PROJECT_SETTINGS.modelTier).toEqual({ executive: 'deep', worker: 'deep', critic: 'deep', research: 'balanced', chat: 'balanced' });
    // The fallback for a tier nobody set agrees with the default.
    expect(tierFor(ROLES.critic!, {})).toBe('deep');
    expect(tierFor(ROLES.executive!, {})).toBe('deep');
    expect(tierFor(ROLES['luau-engineer']!, {})).toBe('deep');
    expect(tierFor(ROLES.director!, {})).toBe('balanced');
    // A tier that is set wins.
    expect(tierFor(ROLES.critic!, { critic: 'balanced' })).toBe('balanced');
  });

  it("has the planner think at max and every other agent at high (1.15.3, the user's choice; both in Settings)", () => {
    expect(ROLES.executive!.effort).toBe('max');
    expect(ROLES.critic!.effort).toBe('high');
    expect(ROLES['roblox-engineer']!.effort).toBe('high');
    expect(ROLES['luau-engineer']!.effort).toBe('high');
    expect(ROLES.researcher!.effort).toBe('high');
    expect(ROLES.director!.effort).toBe('high');
  });

  it('gives a project that never chose its tiers the new default, even when 1.9 saved its own defaults there', async () => {
    const { ctx } = await makeCore({ respond: async () => null });
    expect(ctx.settings().modelTier.critic).toBe('deep');
    // What 1.9 left in every project that ever saved a setting (binding Studio saved the whole object): not a choice.
    ctx.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [JSON.stringify({ autonomy: 'autonomous', maxConcurrentAgents: 0, modelTier: TIERS_1_9, robloxStudioMatch: 'Scratch' })]);
    expect(ctx.settings()).toMatchObject({ autonomy: 'autonomous', robloxStudioMatch: 'Scratch', modelTier: { executive: 'deep', worker: 'deep', critic: 'deep', research: 'balanced', chat: 'balanced' } });
    // Saved settings without any tier (or without the critic's) get the default for the rest.
    ctx.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [JSON.stringify({ autonomy: 'autonomous' })]);
    expect(ctx.settings()).toMatchObject({ autonomy: 'autonomous', modelTier: { critic: 'deep', executive: 'deep' } });
    ctx.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [JSON.stringify({ modelTier: { worker: 'balanced' } })]);
    expect(ctx.settings().modelTier).toEqual({ executive: 'deep', worker: 'balanced', critic: 'deep', research: 'balanced', chat: 'balanced' });
  });

  it('keeps tiers a project did choose, and no longer writes the defaults into what it saves', async () => {
    const { ctx } = await makeCore({ respond: async () => null });
    // A set that differs from 1.9's defaults was chosen (through the RPC or by hand): it stays, critic included.
    const chosen = { executive: 'deep', worker: 'balanced', critic: 'balanced', research: 'balanced', chat: 'balanced' };
    ctx.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [JSON.stringify({ autonomy: 'supervised', modelTier: chosen })]);
    expect(ctx.settings().modelTier).toEqual(chosen);
    ctx.updateSettings({ maxConcurrentAgents: 4 });
    expect(ctx.settings().modelTier).toEqual(chosen);
    expect(saved(ctx).modelTier).toEqual(chosen);
    // Choosing tiers saves them.
    ctx.updateSettings({ modelTier: { ...DEFAULT_PROJECT_SETTINGS.modelTier, critic: 'balanced' } });
    expect(ctx.settings().modelTier.critic).toBe('balanced');
    expect(saved(ctx).modelTier).toMatchObject({ critic: 'balanced' });

    // A project that never chose: saving another setting writes no tiers, so a later default still reaches it.
    const fresh = await makeCore({ respond: async () => null });
    fresh.ctx.updateSettings({ maxConcurrentAgents: 6, robloxStudioMatch: 'Scratch' });
    expect(saved(fresh.ctx)).toMatchObject({ maxConcurrentAgents: 6, robloxStudioMatch: 'Scratch' });
    expect(saved(fresh.ctx)).not.toHaveProperty('modelTier');
    expect(fresh.ctx.settings().modelTier).toEqual(DEFAULT_PROJECT_SETTINGS.modelTier);
    // 1.9's saved defaults are dropped the next time the project saves anything.
    fresh.ctx.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [JSON.stringify({ autonomy: 'autonomous', modelTier: TIERS_1_9 })]);
    fresh.ctx.updateSettings({ maxConcurrentAgents: 0 });
    expect(saved(fresh.ctx)).not.toHaveProperty('modelTier');
    expect(fresh.ctx.settings().modelTier.critic).toBe('deep');
  });

  it('reaches the provider: the critic on the deep tier at medium effort, the planner at medium, the worker at high', async () => {
    const { core, ctx, provider } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'One task', tasks: [{ key: 't1', title: 'Greeting module', kind: 'implement', role: 'luau-engineer', objective: 'Create a Greeting module.', acceptanceCriteria: ['It greets'], verification: [{ kind: 'critic' }] }] };
        if (kind === 'work') return { status: 'implemented', summary: 'Module written' };
        if (kind === 'review') return { verdict: 'pass', summary: 'Looks good', criteria: [], defects: [] };
        return null;
      },
    });
    // The project as 1.9 left it: its saved default tiers must not keep the critic on the balanced tier.
    ctx.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [JSON.stringify({ ...ctx.settings(), modelTier: TIERS_1_9 })]);
    const goal = core.orchestrator.submitObjective({ title: 'Greeting feature', description: 'Players can be greeted.', skipResearch: true });
    await waitFor(() => ctx.tasks.get(goal.id)?.status === 'done', 60000);
    const of = (role: string) => provider.runs.find((r) => r.role === role)!;
    expect([of('executive').modelTier, of('executive').effort]).toEqual(['deep', 'max']);
    expect([of('luau-engineer').modelTier, of('luau-engineer').effort]).toEqual(['deep', 'high']);
    expect([of('critic').modelTier, of('critic').effort]).toEqual(['deep', 'high']);
  }, 90000);
});
