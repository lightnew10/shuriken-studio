/**
 * The director with the real model (a few cents of usage):
 *
 *   E2E=director npx vitest run -c vitest.e2e.config.ts tests/e2e/director.e2e.ts
 *
 * Isolated data dir, no Studio needed. Checks that the director's structured reply works with the
 * current schema (including "show" buttons to app pages) for a question about the game's content.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../../src/core/core';

const MODE = process.env.E2E ?? '';

describe.runIf(MODE === 'director')('director (real model)', () => {
  it('answers a "show me" question with buttons to the right page', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-director-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Director E2E', rootPath: join(dataDir, 'project'), description: 'A battlegrounds fighting game' });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      for (const [name, preset] of [['M1_1', 'PunchJab'], ['M1_2', 'PunchCross'], ['M1_3', 'PunchHook'], ['M1_4', 'PunchUppercut']] as const) {
        await core.invokeTool('animation_create', { name, preset, build: false }, 'system');
      }
      ctx.tasks.create({ kind: 'objective', title: 'Battlegrounds game', objective: 'A battlegrounds fighting game', role: 'executive', status: 'running', createdBy: 'e2e' });
      core.director.send('Can I see the punch combo the animator made?');
      const chat = core.director.chat()!;
      const t0 = Date.now();
      while (!chat.list().some((m) => m.role === 'director') && Date.now() - t0 < 180_000) await new Promise((r) => setTimeout(r, 2000));
      const reply = chat.list().find((m) => m.role === 'director');
      console.log('reply:', reply?.kind, reply?.text, JSON.stringify(reply?.data));
      expect(reply?.kind).toBe('text');
      const links = (reply?.data?.links as Array<{ page: string; item?: string }> | undefined) ?? [];
      expect(links.some((l) => l.page === 'animation')).toBe(true);
    } finally {
      await core.shutdown();
    }
  }, 240_000);
});
