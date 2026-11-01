import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { coreHarness } from './helpers/make-core';

/**
 * Studio's recovery reopens a place that closed while the team works. Opening the shooting-range project on 3 October
 * started its suggestion writer, which counted as working, and the app reopened a Studio place nobody had asked for.
 */
describe('the team at work, for Studio recovery', () => {
  const makeCore = coreHarness();
  it('counts the builders, not the suggestion writer, the director or a copilot', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { core, ctx } = await makeCore({
      respond: async () => {
        await hold;
        return null;
      },
    });
    core.orchestrator.pause();
    const signal = new AbortController().signal;
    const runs = [
      core.runner.run({ project: ctx, role: ROLES.suggester!, task: null, signal, directive: 'x', contextText: 'x' }),
      core.runner.run({ project: ctx, role: ROLES.director!, task: null, signal, directive: 'x', contextText: 'x' }),
    ];
    for (let i = 0; i < 50 && core.runner.activeRuns().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(core.runner.activeRuns()).toHaveLength(2);
    expect(core.runner.teamRuns()).toHaveLength(0);
    runs.push(core.runner.run({ project: ctx, role: ROLES['environment-artist']!, task: null, signal, directive: 'x', contextText: 'x' }));
    for (let i = 0; i < 50 && core.runner.activeRuns().length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(core.runner.teamRuns()).toHaveLength(1);
    release();
    await Promise.all(runs);
    expect(core.runner.teamRuns()).toHaveLength(0);
  });
});
