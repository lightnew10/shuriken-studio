/**
 * Live end-to-end verification against the real Claude provider and real Roblox Studio.
 *
 *   E2E=probe  npx vitest run -c vitest.e2e.config.ts   → provider + MCP + Studio integration probes only
 *   E2E=slice  npx vitest run -c vitest.e2e.config.ts   → the full first vertical slice (costs usage)
 *
 * Uses the real app data directory (%APPDATA%/Shuriken) so results are visible in the desktop app.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Core } from '../../src/core/core';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import type { Task } from '../../src/shared/domain';

const MODE = process.env.E2E ?? 'probe';
const DATA_DIR = process.env.SHURIKEN_DATA_DIR ?? join(process.env.APPDATA ?? '', 'Shuriken');
const SANDBOX = process.env.SHURIKEN_SANDBOX ?? resolve(__dirname, '..', '..', '..', 'shuriken-sandbox');

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function boot(): Promise<Core> {
  const core = await Core.create({ dataDir: DATA_DIR, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
  await core.studio.start();
  return core;
}

async function openSandbox(core: Core) {
  const existing = core.projects.list().find((p) => resolve(p.rootPath) === resolve(SANDBOX));
  const summary = existing ?? core.createProject({ name: 'Shuriken Sandbox', rootPath: SANDBOX, description: 'Integration sandbox for Shuriken agents' });
  const ctx = core.openProject(summary.id);
  const file = join(ctx.root, 'sandbox.rbxlx');
  if (!existsSync(file)) writeFileSync(file, sandboxPlaceXml('Shuriken Sandbox'), 'utf8');
  log('Opening sandbox place in Studio…');
  const inst = await core.studio.openPlace(file, 'sandbox');
  const match = inst.name.replace(/\s*\(placeId:.*$/, '');
  ctx.updateSettings({ robloxStudioMatch: match });
  core.studio.bind(match);
  log(`Bound to Studio instance "${inst.name}"`);
  return ctx;
}

describe.runIf(MODE === 'probe' || MODE === 'slice')('live integration', () => {
  it('passes provider, MCP and Studio probes', async () => {
    const core = await boot();
    try {
      await openSandbox(core);
      for (const id of ['provider:claude', 'mcp-server', 'roblox-studio', 'luau-toolchain', 'git']) {
        const h = await core.health.run(id, true);
        log(`${h.name}: ${h.status} — ${h.summary}`);
        for (const c of h.checks) log(`   ${c.status.padEnd(12)} ${c.name}: ${c.message}`);
      }
      expect(core.health.get('provider:claude')?.status).toBe('healthy');
      expect(core.health.get('mcp-server')?.status).toBe('healthy');
      expect(core.health.get('roblox-studio')?.status).toBe('healthy');
      const verified = core.capabilities.list('provider:claude').filter((c) => c.detail === 'Verified by live probe').map((c) => c.id);
      log('Live-verified Claude capabilities:', verified.join(', '));
      expect(verified).toContain('claude.mcp');
    } finally {
      await core.shutdown();
    }
  });
});

describe.runIf(MODE === 'slice')('first vertical slice', () => {
  it('objective → research → plan → Claude builds in Roblox → test → critic → verified', async () => {
    const core = await boot();
    try {
      const ctx = await openSandbox(core);
      ctx.updateSettings({ autonomy: 'autonomous', maxConcurrentAgents: 2, maxAttemptsPerTask: 3 });
      ctx.updateExtras({ syncMode: 'shuriken' });
      const objective = core.orchestrator.submitObjective({
        title: process.env.SLICE_TITLE ?? 'Collectible coins',
        description:
          process.env.SLICE_DESCRIPTION ??
          'Add 10 gold coins floating in a ring (radius ~30 studs, ~4 studs above the baseplate) around the spawn. Each coin is an anchored, non-colliding part tagged "Coin" in Workspace.Coins. When a player touches a coin, the SERVER awards +1 to that player\'s leaderstats "Coins" value and hides the coin; it reappears after 10 seconds. Clients must not be able to award coins. Code lives on disk under src/ and is synced into Studio.',
        acceptanceCriteria: [
          'Workspace.Coins contains exactly 10 coin parts tagged "Coin", anchored, CanCollide false',
          'Every player gets leaderstats.Coins (IntValue) starting at 0',
          'Touching a coin on the server increments Coins by exactly 1 and hides the coin; it respawns after ~10 s',
          'No console errors during a playtest; static analysis clean',
        ],
      });
      log(`Objective submitted: ${objective.id}`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 15000));
        const obj = ctx.tasks.get(objective.id)!;
        const kids = ctx.tasks.list({ parentId: objective.id });
        const line = `${obj.status} | ${kids.map((k: Task) => `${k.title.slice(0, 32)}=${k.status}${k.attempts > 1 ? `(#${k.attempts})` : ''}`).join(' · ')}`;
        if (line !== last) {
          log(line);
          last = line;
        }
        const open = ctx.governance.escalations('open');
        if (open.length) log(`ESCALATIONS: ${open.map((e) => `${e.kind}: ${e.title}`).join(' | ')}`);
        if (obj.status === 'done') break;
        if (kids.length && kids.every((k) => ['done', 'cancelled', 'escalated', 'blocked'].includes(k.status)) && kids.some((k) => k.status === 'escalated' || k.status === 'blocked')) {
          throw new Error(`Slice stalled on escalation: ${open.map((e) => `${e.title}: ${e.detail.slice(0, 500)}`).join('\n')}`);
        }
        if (Date.now() - t0 > 150 * 60 * 1000) throw new Error('Slice timed out after 150 minutes');
      }
      const runs = core.runner.listRuns(ctx, { limit: 500 });
      log(`DONE in ${Math.round((Date.now() - t0) / 60000)} min · ${runs.length} runs · $${runs.reduce((a, r) => a + r.costUsd, 0).toFixed(2)} estimated`);
      log(ctx.tasks.get(objective.id)!.result);
      expect(ctx.tasks.get(objective.id)!.status).toBe('done');
    } finally {
      await core.shutdown();
    }
  });
});
