/**
 * The UI Lab checked against Roblox on what it was NOT fitted to (no model calls, no uploads, no playtest):
 *
 *   E2E=ui-lab-verify VERIFY_SCREENS=<fixture.json> FINDINGS_OUT=<folder> npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-lab-verify.e2e.ts
 *
 * In a throwaway place in a new Studio window: about 380 texts in new strings and sizes (TextBounds), probes of
 * TextScaled and UIGradient.Type, and real screens (VERIFY_SCREENS: a JSON array of {title, screen} — captured game UI or
 * resolved mockups) built by the Lab's builder over a flat backdrop, measured and photographed. Saves `verify.json` and
 * `shot-<screen>.png` to FINDINGS_OUT. Closes that Studio window.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import { decodePng, encodePng } from '../../src/core/modeling/png';
import { decodeImage } from '../../src/core/look/look-analysis';
import { uiBuildChunk } from '../../src/core/ui/lab/ui-luau';
import { calMeasureLuau, calShowLuau, PROBE_LUAU, verifyScreens } from '../../src/core/ui/lab/calibration';
import type { UiNode } from '../../src/shared/ui-layout';

const FILE = 'shuriken-uilab-verify-e2e.rbxlx';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The flat backdrop every real screen is photographed over (the Lab draws the same colour behind it). */
export const VERIFY_BACKDROP: [number, number, number] = [27, 29, 36];

describe.runIf(process.env.E2E === 'ui-lab-verify')('the UI Lab against Roblox, out of sample (live)', () => {
  it('records TextBounds of new texts, probes, and real screens with screenshots', async () => {
    if (process.platform !== 'win32') throw new Error('Windows with Roblox Studio only.');
    const out = process.env.FINDINGS_OUT ?? mkdtempSync(join(tmpdir(), 'shuriken-uilab-verify-'));
    mkdirSync(out, { recursive: true });
    const fixture = process.env.VERIFY_SCREENS ? (JSON.parse(readFileSync(process.env.VERIFY_SCREENS, 'utf8')) as Array<{ title: string; screen: UiNode }>) : [];
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-uilab-verify-project-'));
    const closeStudio = () => {
      try {
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${FILE}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
      } catch {
        /* none open */
      }
    };
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-uilab-verify-data-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const studio = core.studio;
    try {
      await studio.start();
      writeFileSync(join(projectDir, FILE), sandboxPlaceXml('UI Lab Verify E2E'), 'utf8');
      closeStudio();
      const ctx = core.openProject(core.createProject({ name: 'UI Lab Verify E2E', rootPath: projectDir }).id);
      core.orchestrator.pause();
      await studio.openPlace(join(projectDir, FILE), FILE);
      ctx.updateSettings({ robloxStudioMatch: FILE });
      studio.bind(FILE);
      await sleep(4000);
      const pid = await studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      expect(pid.output.trim()).toBe('0');
      await studio.runLuau('game:GetService("StarterGui").ShowDevelopmentGui = true return "ok"', 'Edit');

      // 1. Probes.
      const probe = await studio.runLuau(PROBE_LUAU, 'Edit', 30_000);
      console.log(`probe: ${probe.output}`);
      const probes = JSON.parse(probe.output.trim());
      if (process.env.PROBE_ONLY) {
        writeFileSync(join(out, 'probe.json'), JSON.stringify(probes));
        return;
      }

      // 2. Out-of-sample texts.
      const { screens: verify, texts } = verifyScreens();
      const backdrop: UiNode = { id: 1, name: 'CalBackdrop', cls: 'ScreenGui', ignoreInset: true, displayOrder: -100, enabled: true, kids: [{ id: 2, name: 'Fill', cls: 'Frame', pos: [0, 0, 0, 0], size: [1, 0, 1, 0], bg: VERIFY_BACKDROP, bgT: 0 }] };
      const real = fixture.map((f) => f.screen);
      const names = [...verify, ...real].map((s) => s.name);
      for (const s of [backdrop, ...verify, ...real]) {
        const built = await studio.runLuau(uiBuildChunk([s], 'game:GetService("StarterGui")'), 'Edit', 120_000);
        expect(built.output, `${s.name}: ${built.output}`).toContain('built 1');
      }
      const settled = async (screen: string) => {
        let last = '';
        for (let i = 0; i < 15; i++) {
          await sleep(i === 0 ? 1500 : 1000);
          const r = await studio.runLuau(calMeasureLuau([screen]), 'Edit', 30_000);
          if (r.ok && r.output === last) return JSON.parse(r.output.trim()).screens[screen];
          last = r.output;
        }
        throw new Error(`${screen} never settled`);
      };
      const measured: Record<string, [number, number, boolean]> = {};
      for (const v of verify) {
        await studio.runLuau(calShowLuau(names, v.name), 'Edit');
        Object.assign(measured, (await settled(v.name)).texts);
      }

      // 3. Real screens over the flat backdrop, one at a time.
      const visual: Record<string, unknown> = {};
      const shots: Record<string, { file: string; w: number; h: number }> = {};
      for (const s of real) {
        await studio.runLuau(calShowLuau(names, s.name), 'Edit');
        visual[s.name] = await settled(s.name);
        await sleep(1200);
        // Studio may not draw (someone at the PC keeps the window where it is): the boxes still count.
        const shot = await studio.screenshot().catch((e: Error) => {
          console.log(`no screenshot of ${s.name}: ${e.message.slice(0, 120)}`);
          return null;
        });
        if (!shot) continue;
        const buf = Buffer.from(shot.data, 'base64');
        const img = shot.mimeType.includes('png') ? decodePng(buf) : decodeImage(buf);
        const file = `shot-${s.name}.png`;
        writeFileSync(join(out, file), encodePng(img));
        shots[s.name] = { file, w: img.width, h: img.height };
      }
      await studio.runLuau(calShowLuau(names, null), 'Edit');
      writeFileSync(join(out, 'verify.json'), JSON.stringify({ at: new Date().toISOString(), probes, texts, measured, visual, shots, fixture, backdrop: VERIFY_BACKDROP }));
      console.log(`saved to ${out}`);
      expect(Object.keys(measured).length).toBe(texts.length);
    } finally {
      await studio.runLuau('for _, g in game:GetService("StarterGui"):GetChildren() do if string.sub(g.Name, 1, 3) == "Cal" or string.sub(g.Name, 1, 3) == "Ver" then g:Destroy() end end return "clean"', 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
      closeStudio();
    }
  }, 900_000);
});
