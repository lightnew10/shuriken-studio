/**
 * Live check of the suggestion bubbles with the real (fast) model — one small call, about a cent:
 *
 *   E2E=suggestions npx vitest run -c vitest.e2e.config.ts tests/e2e/suggestions.e2e.ts
 *
 * A throwaway Maze Runner project (a Griever goal, a maze built, the Griever rigged and animated, a
 * roar) gets its bubbles written: every place has some, each label is short and each prompt says
 * more, and they are about this game (they name the Griever or the maze). No Studio, no Kiln.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { LiveSuggestions, SUGGESTION_SCOPES } from '../../src/core/director/live-suggestions';
import { SoundLibrary } from '../../src/core/audio/audio-library';

describe.runIf(process.env.E2E === 'suggestions')('suggestion bubbles with the real model (live)', () => {
  it('writes bubbles about this game for the director and every dock', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-suggest-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-suggest-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    try {
      const ctx = core.openProject(core.createProject({ name: 'Maze Runner', rootPath: projectDir }).id);
      core.orchestrator.pause();
      const goal = ctx.tasks.create({ kind: 'objective', title: 'A Maze Runner Griever that chases players through a vine-covered maze', objective: 'x', role: 'executive', status: 'running', createdBy: 'e2e' });
      for (const title of ['Maze test map: tall stone walls, corridors, dead ends, vines', 'Model and rig a Griever in Kiln', 'Griever walk and run clips'])
        ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role: 'modeler', status: 'done', createdBy: 'e2e' });
      ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever patrol and chase AI (no damage)', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'e2e' });
      new SoundLibrary(projectDir).save({ name: 'GrieverRoar', kind: 'sfx', source: 'generated', assetId: null, volume: 0.6, looped: false });
      const live = new LiveSuggestions({ runner: core.runner, bus: core.bus, log: core.logger.scope('e2e'), enabled: () => true });
      const t0 = Date.now();
      expect(await live.refresh(ctx)).toBe(true);
      console.log(`bubbles written in ${Math.round((Date.now() - t0) / 1000)} s`);
      const run = core.runner.listRuns(ctx, { limit: 5 }).find((r) => r.role === 'suggester')!;
      console.log(`model ${run.model}, $${(run.costUsd ?? 0).toFixed(4)}`);
      let aboutThisGame = 0;
      for (const scope of SUGGESTION_SCOPES) {
        const list = live.get(ctx, scope) ?? [];
        console.log(`\n${scope}:`);
        for (const s of list) console.log(`  [${s.label}] ${s.prompt}`);
        expect(list.length, scope).toBeGreaterThan(0);
        for (const s of list) {
          expect(s.label.length).toBeLessThanOrEqual(48);
          expect(s.prompt.length).toBeGreaterThan(s.label.length);
          if (/griever|maze|vine/i.test(`${s.label} ${s.prompt}`)) aboutThisGame++;
        }
      }
      expect(aboutThisGame).toBeGreaterThanOrEqual(8);
    } finally {
      await core.shutdown();
    }
  }, 180_000);
});
