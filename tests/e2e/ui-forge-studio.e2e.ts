/**
 * Forged UI in real Studio (no model calls, nothing uploaded to Roblox):
 *
 *   E2E=ui-forge FORGE_FIXTURE=<folder with fixture.json and images/> FINDINGS_OUT=<folder> npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-forge-studio.e2e.ts
 *
 * The fixture's screens wear forged skins whose images point at rbxasset://shuriken-forge/<file>.png: the PNGs are
 * copied into Studio's own content folder (Studio loads rbxasset:// from it, for this PC only), each screen is built
 * by the Lab's builder in a throwaway place in a big Studio window, measured and photographed. Saved like the verify
 * run (`verify.json`, `shot-<screen>.png`) so `compareVerify` can set the Lab's pictures beside Studio's. Closes that
 * window; the copied PNGs stay in content/shuriken-forge (a later Studio update removes them).
 */
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import { tuckStudioWindow } from '../../src/core/roblox/studio-window';
import { decodePng, encodePng } from '../../src/core/modeling/png';
import { decodeImage } from '../../src/core/look/look-analysis';
import { uiBuildChunk } from '../../src/core/ui/lab/ui-luau';
import { calMeasureLuau, calShowLuau } from '../../src/core/ui/lab/calibration';
import { findRobloxFonts } from '../../src/core/ui/lab/roblox-fonts';
import type { UiNode } from '../../src/shared/ui-layout';

const FILE = 'shuriken-uiforge-e2e.rbxlx';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(process.env.E2E === 'ui-forge')('forged UI in real Studio (live)', () => {
  it('builds forged screens with their art from the content folder and photographs them', async () => {
    if (process.platform !== 'win32') throw new Error('Windows with Roblox Studio only.');
    const fixtureDir = process.env.FORGE_FIXTURE;
    if (!fixtureDir) throw new Error('Set FORGE_FIXTURE.');
    const out = process.env.FINDINGS_OUT ?? mkdtempSync(join(tmpdir(), 'shuriken-uiforge-'));
    mkdirSync(out, { recursive: true });
    const fixture = JSON.parse(readFileSync(join(fixtureDir, 'fixture.json'), 'utf8')) as Array<{ title: string; screen: UiNode; states?: Record<string, string> }>;
    const install = findRobloxFonts();
    if (!install) throw new Error('No Studio install found.');
    const content = dirname(install.fonts);
    mkdirSync(join(content, 'shuriken-forge'), { recursive: true });
    for (const f of readdirSync(join(fixtureDir, 'images'))) copyFileSync(join(fixtureDir, 'images', f), join(content, 'shuriken-forge', f));

    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-uiforge-project-'));
    const closeStudio = () => {
      try {
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${FILE}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
      } catch {
        /* none open */
      }
    };
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-uiforge-data-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const studio = core.studio;
    try {
      await studio.start();
      writeFileSync(join(projectDir, FILE), sandboxPlaceXml('UI Forge E2E'), 'utf8');
      closeStudio();
      const ctx = core.openProject(core.createProject({ name: 'UI Forge E2E', rootPath: projectDir }).id);
      core.orchestrator.pause();
      await studio.openPlace(join(projectDir, FILE), FILE);
      ctx.updateSettings({ robloxStudioMatch: FILE });
      studio.bind(FILE);
      await sleep(4000);
      // A big window: the screens are designed for a laptop-sized screen.
      console.log(`window: ${await tuckStudioWindow(FILE, Number(process.env.FORGE_W ?? 1700), Number(process.env.FORGE_H ?? 1080), null)}`);
      await sleep(2500);
      const pid = await studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      expect(pid.output.trim()).toBe('0');
      await studio.runLuau('game:GetService("StarterGui").ShowDevelopmentGui = true return "ok"', 'Edit');
      const names = fixture.map((f) => f.screen.name);
      for (const f of fixture) {
        const built = await studio.runLuau(uiBuildChunk([f.screen], 'game:GetService("StarterGui")', f.states ?? {}), 'Edit', 120_000);
        expect(built.output, `${f.screen.name}: ${built.output}`).toContain('built 1');
      }
      const settled = async (screen: string) => {
        let last = '';
        for (let i = 0; i < 15; i++) {
          await sleep(i === 0 ? 2000 : 1000);
          const r = await studio.runLuau(calMeasureLuau([screen]), 'Edit', 30_000);
          if (r.ok && r.output === last) return JSON.parse(r.output.trim()).screens[screen];
          last = r.output;
        }
        throw new Error(`${screen} never settled`);
      };
      const visual: Record<string, unknown> = {};
      const shots: Record<string, { file: string; w: number; h: number }> = {};
      for (const f of fixture) {
        await studio.runLuau(calShowLuau(names, f.screen.name), 'Edit');
        visual[f.screen.name] = await settled(f.screen.name);
        // Images load asynchronously the first time.
        await sleep(3500);
        const shot = await studio.screenshot().catch((e: Error) => {
          console.log(`no screenshot of ${f.screen.name}: ${e.message.slice(0, 160)}`);
          return null;
        });
        if (!shot) continue;
        const buf = Buffer.from(shot.data, 'base64');
        const img = shot.mimeType.includes('png') ? decodePng(buf) : decodeImage(buf);
        const file = `shot-${f.screen.name}.png`;
        writeFileSync(join(out, file), encodePng(img));
        shots[f.screen.name] = { file, w: img.width, h: img.height };
        console.log(`shot ${f.screen.name}: ${img.width}×${img.height}, viewport ${(visual[f.screen.name] as { w: number }).w}×${(visual[f.screen.name] as { h: number }).h}`);
      }
      writeFileSync(join(out, 'verify.json'), JSON.stringify({ at: new Date().toISOString(), probes: null, texts: [], measured: {}, visual, shots, fixture, backdrop: [0, 0, 0], imagesDir: join(fixtureDir, 'images') }));
      expect(Object.keys(shots).length).toBeGreaterThan(0);
    } finally {
      await studio.runLuau('for _, g in game:GetService("StarterGui"):GetChildren() do if string.sub(g.Name, 1, 5) == "Forge" then g:Destroy() end end return "clean"', 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
      closeStudio();
    }
  }, 900_000);
});
