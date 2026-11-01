/**
 * The planner alone, with the real model (one planning session of usage, no Studio needed):
 *
 *   E2E=plan [PROMPT="…"] npx vitest run -c vitest.e2e.config.ts tests/e2e/plan.e2e.ts
 *
 * Isolated data dir, manual autonomy: only the plan task runs, and the tasks it adds stay "ready".
 * Prints the plan so its use of the workshops (moves, effects, sounds, models, skills) can be judged.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../../src/core/core';

const MODE = process.env.E2E ?? '';
const PROMPT =
  process.env.PROMPT ??
  'A battlegrounds fighting game: fist combos (4-hit M1 chain with a knockback finisher), block, dash and dodge rolls, hit-stop and screen shake on heavy hits, a ring-out arena and a kill feed.';

describe.runIf(MODE === 'plan')('planner (real model)', () => {
  it('plans a game from a prompt', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-plan-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Plan E2E', rootPath: join(dataDir, 'project'), description: PROMPT });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ autonomy: 'manual' });
      core.orchestrator.attach(ctx);
      const objective = core.orchestrator.submitObjective({ title: 'Battlegrounds', description: PROMPT, skipResearch: true });
      const plan = ctx.tasks.list({ parentId: objective.id }).find((t) => t.kind === 'plan');
      expect(plan).toBeTruthy();
      core.orchestrator.runNow(plan!.id);
      const t0 = Date.now();
      while (!['done', 'failed', 'escalated'].includes(ctx.tasks.get(plan!.id)!.status) && Date.now() - t0 < 15 * 60_000) await new Promise((r) => setTimeout(r, 5000));
      const tasks = ctx.tasks.list({ parentId: objective.id }).filter((t) => t.kind !== 'plan');
      const lines = [`plan: ${ctx.tasks.get(plan!.id)!.status}`, ...tasks.map((t) => `- [${t.role}] ${t.title}\n    ${t.objective.replace(/\n/g, ' ')}\n    skills: ${(t.requiredSkills ?? []).join(', ')} | deps: ${(t.dependencies ?? []).length}`)];
      const runs = core.runner.listRuns(ctx, { limit: 5 });
      lines.push(...runs.map((r) => `run ${r.role} ${r.status} ${r.numTurns} turns $${r.costUsd.toFixed(2)}`));
      writeFileSync(join(dataDir, 'plan.txt'), lines.join('\n'));
      console.log(lines.join('\n'));
      expect(tasks.length).toBeGreaterThan(3);
    } finally {
      await core.shutdown();
    }
  }, 20 * 60_000);
});
