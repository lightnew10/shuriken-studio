/**
 * Live check of the look at a texture before its upload, with the real (fast) model — one small call per
 * image, about a cent each:
 *
 *   E2E=image-check IMAGE_FLAG=<a png Roblox would remove> IMAGE_OK=<a png that is fine> \
 *     npx vitest run -c vitest.e2e.config.ts tests/e2e/image-check.e2e.ts
 *
 * IMAGE_FLAG is a texture with a QR code, a web address, a handle or a real logo painted on it (the image
 * Roblox removed on 2026-10-01 was a vending machine's glow atlas with a QR lookalike on its pay panel);
 * IMAGE_OK is an ordinary texture with invented brands and signage. Several files: separate them with ";".
 * No Studio, no Kiln, nothing is uploaded.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { ImageScreen } from '../../src/core/roblox/image-screen';

describe.runIf(process.env.E2E === 'image-check')('the look at a texture before its upload (live)', () => {
  it('flags what Roblox removes and lets ordinary textures through', async () => {
    const flag = (process.env.IMAGE_FLAG ?? '').split(';').filter(Boolean);
    const fine = (process.env.IMAGE_OK ?? '').split(';').filter(Boolean);
    expect(flag.length + fine.length, 'set IMAGE_FLAG and IMAGE_OK').toBeGreaterThan(0);
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-imagecheck-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-imagecheck-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    try {
      const ctx = core.openProject(core.createProject({ name: 'Image check', rootPath: projectDir }).id);
      core.orchestrator.pause();
      mkdirSync(join(projectDir, 'models'), { recursive: true });
      const screen = new ImageScreen({ runner: () => core.runner, project: () => ctx, log: core.logger.scope('e2e') });
      const look = async (src: string) => {
        const file = join(projectDir, 'models', basename(src));
        copyFileSync(src, file);
        const t0 = Date.now();
        const what = await screen.check(projectDir, file);
        console.log(`${basename(src)}: ${what ?? 'fine'} (${Math.round((Date.now() - t0) / 100) / 10} s)`);
        const last = core.runner.listRuns(ctx, { limit: 1 })[0];
        if (last?.status !== 'completed') console.log(`  the look did not run: ${last?.status} ${last?.error ?? ''}`);
        return what;
      };
      for (const f of flag) expect(await look(f), f).not.toBeNull();
      for (const f of fine) expect(await look(f), f).toBeNull();
      const runs = core.runner.listRuns(ctx, { limit: 20 }).filter((r) => r.role === 'image-checker');
      console.log(`${runs.length} looks, model ${runs[0]?.model}, $${runs.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)}`);
      expect(runs.length).toBe(flag.length + fine.length);
    } finally {
      await core.shutdown();
    }
  }, 300_000);
});
