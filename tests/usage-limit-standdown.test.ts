import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AT_LIMIT } from '../src/core/orchestrator/agent-runner';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * When a run hits its account's usage limit, the work the other runs on that account already asked for doesn't go on
 * running in Studio for answers no agent can read (a build drove Studio for four minutes after its limit: checks and
 * playtests that had waited in Studio's line, the rest of a batch of placements).
 */
describe('the usage limit stops what no agent can read any more', () => {
  const makeCore = coreHarness();

  it('stops the runs waiting on a call at once and refuses the calls the others make next; their tasks carry on later', async () => {
    let blocking = false;
    let limitHit = false;
    let blockEnded: 'aborted' | 'timed out' | null = null;
    let later: string | null = null;
    const text = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
    const { core, ctx } = await makeCore({
      respond: async (req, kind, call) => {
        if (kind === 'plan')
          return {
            summary: 'three',
            tasks: [
              { key: 'a', title: 'Hits the limit', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] },
              { key: 'b', title: 'Waits in Studio', kind: 'implement', role: 'environment-artist', objective: 'x', acceptanceCriteria: ['works'], verification: [] },
              { key: 'c', title: 'Writes, then calls', kind: 'implement', role: 'sound-designer', objective: 'x', acceptanceCriteria: ['works'], verification: [] },
            ],
          };
        if (kind !== 'work') return null;
        if (req.role === 'environment-artist') {
          // A playtest waiting in Studio's line, as far as the run can tell.
          await call('test_studio_line', {});
          return { status: 'implemented', summary: 'placed' };
        }
        if (req.role === 'sound-designer') {
          // Mid-answer when the limit hits; then it asks for one more thing (the rest of a batch).
          // (The waiting run's stop says the runner has seen the limit.)
          await waitFor(() => blockEnded, 20_000);
          later = text(await call('test_studio_line', { quick: true }));
          return { status: 'implemented', summary: 'sounds' };
        }
        await waitFor(() => blocking, 20_000);
        limitHit = true;
        throw Object.assign(new Error("You've hit your session limit · resets 2:20am"), { errorKind: 'rate_limit' });
      },
    });
    ctx.updateSettings({ maxConcurrentAgents: 3 });
    core.tools.register({
      name: 'test_studio_line',
      title: 'Waits like a playtest in line',
      description: 'test',
      capability: 'test.studio',
      permission: 'read',
      input: { quick: z.boolean().optional() },
      handler: async ({ args, signal }) => {
        if (args.quick) return { content: [{ type: 'text', text: 'ran' }] };
        blocking = true;
        blockEnded = await new Promise<'aborted' | 'timed out'>((resolve) => {
          const t = setTimeout(() => resolve('timed out'), 20_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve('aborted');
          });
        });
        return { content: [{ type: 'text', text: blockEnded }] };
      },
    });
    const obj = core.orchestrator.submitObjective({ title: 'Three at once', description: 'x', skipResearch: true });
    const t0 = Date.now();
    await waitFor(() => limitHit);
    // The run waiting on Studio stops within moments of the limit, not when its call would have come back.
    await waitFor(() => blockEnded, 10_000);
    expect(blockEnded).toBe('aborted');
    expect(Date.now() - t0).toBeLessThan(15_000);
    await waitFor(() => later, 10_000);
    expect(later).toContain(AT_LIMIT);
    const tasks = () => ctx.tasks.list({ parentId: obj.id });
    const waited = await waitFor(() => tasks().find((t) => t.title === 'Waits in Studio' && t.status === 'ready'));
    expect(ctx.tasks.failures(waited.id)).toEqual([]);
    // Cut off by the limit like the run that hit it: its work kept, the attempt given back, it carries on after the reset.
    const runs = core.runner.listRuns(ctx, { taskId: waited.id });
    expect(runs[0]!.error).toMatch(/usage limit/);
    expect(waited.attempts).toBe(0);
    expect(ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'limit.standdown')).toBe(true);
  }, 90_000);
});
