/**
 * Run one objective end-to-end on a real project with real Claude and real Roblox Studio.
 *
 *   E2E=objective OBJECTIVE_FILE=path/to/objective.json npx vitest run -c vitest.e2e.config.ts tests/e2e/objective.e2e.ts
 *
 * objective.json:
 * { "projectDir": "...", "projectName": "...", "placeName": "game", "title": "...", "description": "...",
 *   "acceptanceCriteria": ["..."], "maxConcurrentAgents": 2, "maxMinutes": 180 }
 *
 * Uses the real app data directory so progress and results are visible in the desktop app.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Core } from '../../src/core/core';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import type { Task } from '../../src/shared/domain';

interface ObjectiveSpec {
  projectDir: string;
  projectName: string;
  description?: string;
  placeName: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  maxConcurrentAgents?: number;
  maxMinutes?: number;
  skipResearch?: boolean;
}

const DATA_DIR = process.env.SHURIKEN_DATA_DIR ?? join(process.env.APPDATA ?? '', 'Shuriken');
const log = (...a: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

describe.runIf(process.env.E2E === 'objective')('objective run', () => {
  it('runs the objective to verified completion', async () => {
    const spec = JSON.parse(readFileSync(process.env.OBJECTIVE_FILE!, 'utf8')) as ObjectiveSpec;
    const core = await Core.create({ dataDir: DATA_DIR, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    try {
      await core.studio.start();
      const existing = core.projects.list().find((p) => resolve(p.rootPath) === resolve(spec.projectDir));
      const summary = existing ?? core.createProject({ name: spec.projectName, rootPath: spec.projectDir, description: spec.description ?? '' });
      const ctx = core.openProject(summary.id);
      const placeFile = join(ctx.root, `${spec.placeName}.rbxlx`);
      if (!existsSync(placeFile)) writeFileSync(placeFile, sandboxPlaceXml(spec.projectName), 'utf8');
      const inst = await core.studio.openPlace(placeFile, `${spec.placeName}.rbxlx`);
      const match = inst.name.replace(/\s*\(placeId:.*$/, '');
      ctx.updateSettings({ robloxStudioMatch: match, autonomy: 'autonomous', maxConcurrentAgents: spec.maxConcurrentAgents ?? 2 });
      core.studio.bind(match);
      log(`Project "${ctx.summary.name}" bound to Studio "${inst.name}"`);
      for (const id of ['provider:claude', 'roblox-studio']) {
        const h = await core.health.run(id, id === 'provider:claude');
        log(`${h.name}: ${h.status} — ${h.summary}`);
        expect(h.status).toBe('healthy');
      }
      // RESUME=1 continues an existing (unfinished) objective with the same title instead of submitting a new one.
      // CONTINUE=1 answers the "Continue with the next milestone" prompt of the (finished) objective with that
      // title — the same path as the app's Executive view — and follows the objective Shuriken creates.
      let continued: Task | undefined;
      if (process.env.CONTINUE === '1') {
        const prev = ctx.tasks.list({ kinds: ['objective'] }).find((t) => t.title === spec.title);
        const prompt = prev ? ctx.governance.escalations('open').find((e) => e.taskId === prev.id && e.title.startsWith('Continue with the next milestone')) : undefined;
        if (!prompt) throw new Error(`No open "Continue with the next milestone" prompt for "${spec.title}"`);
        const before = new Set(ctx.tasks.list({ kinds: ['objective'] }).map((t) => t.id));
        core.orchestrator.start();
        ctx.governance.resolveEscalation(prompt.id, 'answered', 'start next milestone');
        for (let i = 0; i < 50 && !continued; i++) {
          await new Promise((r) => setTimeout(r, 200));
          continued = ctx.tasks.list({ kinds: ['objective'] }).find((t) => !before.has(t.id));
        }
        if (!continued) throw new Error('Answering the continue prompt did not create a new objective');
      }
      const existingObjective = process.env.RESUME === '1' ? ctx.tasks.list({ kinds: ['objective'] }).find((t) => t.title === spec.title && t.status !== 'done' && t.status !== 'cancelled') : undefined;
      const objective = continued ?? existingObjective ?? core.orchestrator.submitObjective({ title: spec.title, description: spec.objective, acceptanceCriteria: spec.acceptanceCriteria, skipResearch: spec.skipResearch });
      if (continued) log(`Continuing with the next milestone: ${objective.title} (${objective.id})`);
      else if (existingObjective) {
        core.orchestrator.start();
        log(`Resuming objective: ${objective.id}`);
      } else log(`Objective submitted: ${objective.id}`);
      const t0 = Date.now();
      let last = '';
      const seenEscalations = new Set<string>();
      for (;;) {
        await new Promise((r) => setTimeout(r, 20000));
        const obj = ctx.tasks.get(objective.id)!;
        const kids = ctx.tasks.list({ parentId: objective.id }).filter((k) => k.status !== 'proposed');
        const line = `${obj.status} | ${kids.map((k) => `${k.title.slice(0, 28)}=${k.status}${k.attempts > 1 ? `#${k.attempts}` : ''}`).join(' · ')}`;
        if (line !== last) {
          log(line);
          last = line;
        }
        for (const e of ctx.governance.escalations('open')) {
          if (seenEscalations.has(e.id)) continue;
          seenEscalations.add(e.id);
          log(`ESCALATION [${e.kind}] ${e.title}\n${e.detail.slice(0, 600)}`);
        }
        if (obj.status === 'done') break;
        const active = kids.some((k) => ['ready', 'running', 'implemented', 'verifying', 'reviewing'].includes(k.status));
        if (!active && kids.some((k) => k.status === 'escalated' || k.status === 'blocked') && !core.orchestrator.state().activeRuns) {
          throw new Error('Objective stalled on escalations');
        }
        if (Date.now() - t0 > (spec.maxMinutes ?? 180) * 60000) throw new Error('Objective timed out');
      }
      const runs = core.runner.listRuns(ctx, { limit: 1000 });
      log(`DONE in ${Math.round((Date.now() - t0) / 60000)} min · ${runs.length} runs · $${runs.reduce((a, r) => a + r.costUsd, 0).toFixed(2)} estimated`);
      log(ctx.tasks.get(objective.id)!.result);
    } finally {
      await core.shutdown();
    }
  });
});
