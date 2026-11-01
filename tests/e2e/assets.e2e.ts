/**
 * Live asset-library check against real Roblox Studio (no model calls, no cost):
 *
 *   E2E=assets npx vitest run -c vitest.e2e.config.ts tests/e2e/assets.e2e.ts
 *
 * Needs the Shuriken sandbox place (sandbox.rbxlx) open in Studio with its MCP server enabled. Boots a
 * core in a throwaway data directory, so it can run while the app or another e2e holds the real one.
 * Inserts a free Creator Store rock pack through the same capture path roblox_call uses, analyzes it,
 * reuses it by cloning, checks usage tracking, then removes what it placed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { Store } from '../../src/core/db/store';
import { PROJECT_MIGRATIONS } from '../../src/core/db/schema';
import { AssetService } from '../../src/core/assets/asset-service';
import { AssetCapture, watchRoots } from '../../src/core/assets/asset-capture';
import { LUAU_ASSET_CLONE } from '../../src/core/roblox/luau-snippets';

const ROCK_PACK = process.env.ASSET_ID ?? '2128776869'; // "Low Poly Rock Pack [FREE]", 10 MeshParts

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

describe.runIf(process.env.E2E === 'assets')('asset library (live Studio)', () => {
  it('captures, analyzes, tracks and reuses an inserted asset', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-assets-e2e-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const store = new Store(':memory:', PROJECT_MIGRATIONS);
    const svc = new AssetService(store);
    const capture = new AssetCapture(core.studio);
    let usageTag: string | null = null;
    try {
      await core.studio.start();
      core.studio.bind('sandbox');
      const state = await core.studio.state();
      log('Studio:', JSON.stringify(state).slice(0, 200));

      const args = { assetId: ROCK_PACK, assetName: 'E2E Rock Pack' };
      const before = await capture.childIds(watchRoots('insert_asset', args));
      expect(before).not.toBeNull();
      const r = await core.studio.call('insert_asset', args, { timeoutMs: 120_000 });
      expect(r.ok, r.error ?? '').toBe(true);
      const text = r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ');
      const { records, report } = await capture.capture(svc, { tool: 'insert_asset', args, text, before, actor: 'e2e', taskId: null, runId: null });
      log(report.join('\n'));
      const rec = records[0]!;
      usageTag = rec.usageTag;
      expect(rec.robloxAssetId).toBe(ROCK_PACK);
      expect(rec.instancePaths[0]).toMatch(/^Workspace\.E2E Rock Pack/);
      expect(rec.usageTag).toBe(`ShurikenAsset_${rec.id}`);
      const a = rec.analysis!;
      expect(a).toBeTruthy();
      log(`analysis: ${a.parts} parts, ${a.meshCount} meshes, bbox ${a.bbox.join('x')}, polycount ${JSON.stringify(a.polycount)}, deps ${a.dependencyCount}, findings ${JSON.stringify(a.findings)}`);
      expect(a.meshCount).toBeGreaterThan(0);
      expect(a.polycount.measuredMeshes + a.polycount.unmeasuredMeshes).toBeGreaterThan(0);
      expect(a.dependencies.some((d) => d.kinds.includes('mesh'))).toBe(true);
      expect(a.bbox.every((n) => n > 0)).toBe(true);

      expect(await capture.usage(svc, svc.get(rec.id)!)).toHaveLength(1);
      const clone = await core.studio.luauJson<{ path?: string; error?: string }>(
        LUAU_ASSET_CLONE.replace(/__PATH__/g, () => JSON.stringify(rec.instancePaths[0]))
          .replace(/__PARENT__/g, () => JSON.stringify('Workspace'))
          .replace(/__NAME__/g, () => JSON.stringify('E2E Rock Pack Copy'))
          .replace('__OFFSET__', () => JSON.stringify(JSON.stringify([40, 0, 0]))),
      );
      expect(clone.error).toBeUndefined();
      const placed = await capture.usage(svc, svc.get(rec.id)!);
      log('placements after reuse:', placed.join(', '));
      expect(placed).toHaveLength(2);
      expect(placed).toContain(clone.path);

      // Procedural models (generate_procedural_model) expose their tunable attributes as parameters.
      const generated = await capture.tagged(['AssistantAIGeneratedAsset']);
      if (generated[0]) {
        const pa = await capture.analyze(generated[0]);
        log(`procedural ${pa.path}: ${pa.className}, ${pa.parts} parts, ${pa.scriptCount} scripts, parameters ${Object.keys(pa.parameters).join(', ')}; findings ${JSON.stringify(pa.findings)}`);
        expect(Object.keys(pa.parameters).length).toBeGreaterThan(0);
      }

      // Re-inserting the same Roblox asset is reuse of the same record, not a new asset.
      const again = svc.record({ name: 'E2E Rock Pack', kind: 'model', source: 'e2e', robloxAssetId: ROCK_PACK, event: 'inserted', actor: 'e2e' });
      expect(again.id).toBe(rec.id);
      expect(svc.history(rec.id).map((e) => e.kind)).toEqual(['inserted', 'analyzed', 'reused']);
    } finally {
      if (usageTag) {
        await core.studio
          .runLuau(`for _, i in ipairs(game:GetService("CollectionService"):GetTagged(${JSON.stringify(usageTag)})) do i:Destroy() end return "ok"`, 'Edit')
          .catch(() => undefined);
      }
      store.close();
      await core.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
