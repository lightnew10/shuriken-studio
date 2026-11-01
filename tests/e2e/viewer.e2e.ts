/**
 * Live viewer queries against a place open in Studio (read-only, no model calls):
 *
 *   E2E=viewer PLACE=pit-tribes npx vitest run -c vitest.e2e.config.ts tests/e2e/viewer.e2e.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { LUAU_VIEW_PARTS, LUAU_VIEW_TERRAIN } from '../../src/core/roblox/luau-snippets';

interface PartsPage {
  total: number;
  offset: number;
  count: number;
  next: number | null;
  classes: string[];
  materials: string[];
  rows: string;
  lighting?: Record<string, unknown>;
  camera?: { pos: number[]; look: number[]; fov: number };
}

describe.runIf(process.env.E2E === 'viewer')('viewer queries (live Studio)', () => {
  it('reads parts, lighting, camera and a terrain heightmap', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-viewer-e2e-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.studio.bind(process.env.PLACE ?? 'sandbox');
      const t0 = Date.now();
      let page = await core.studio.luauJson<PartsPage>(LUAU_VIEW_PARTS.replace('__OFFSET__', '0'));
      console.log(`parts page: ${page.count}/${page.total} (next ${page.next}) ${page.rows.length} chars in ${Date.now() - t0} ms; classes ${page.classes.join(',')}; materials ${page.materials.join(',')}; lighting ${JSON.stringify(page.lighting).slice(0, 200)}; camera ${JSON.stringify(page.camera)}`);
      expect(page.total).toBeGreaterThan(0);
      expect(page.rows.split(';')[0]!.split(',').length).toBe(17);
      expect(page.lighting).toBeTruthy();
      let seen = page.count;
      while (page.next != null) {
        page = await core.studio.luauJson<PartsPage>(LUAU_VIEW_PARTS.replace('__OFFSET__', String(page.next)));
        seen += page.count;
      }
      expect(seen).toBe(page.total);
      const t1 = Date.now();
      const terr = await core.studio.luauJson<{ n: number; hits: number; heights: string; mats: string; names: string[]; colors: string[] }>(
        LUAU_VIEW_TERRAIN.replace('__MINX__', '-256').replace('__MINZ__', '-256').replace('__MAXX__', '256').replace('__MAXZ__', '256').replace('__N__', '128').replace('__Z0__', '0').replace('__Z1__', '63'),
      );
      console.log(`terrain: ${terr.hits}/${terr.n * 64} hits in ${Date.now() - t1} ms; ${terr.heights.length + terr.mats.length} chars; materials ${terr.names.join(', ')} ${terr.colors.join(', ')}`);
      if (terr.hits) expect(terr.mats.length).toBe(128 * 64);
    } finally {
      await core.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
