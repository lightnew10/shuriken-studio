/**
 * The UI Lab against Roblox, number for number and pixel for pixel (no model calls, no uploads, no playtest):
 *
 *   E2E=ui-lab npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-lab-fidelity.e2e.ts
 *
 * Opens a throwaway place in a new Studio window, builds the Lab's calibration screens into StarterGui with the
 * Lab's own builder (`core/ui/lab/ui-luau.ts`), and records what Roblox made of them: every element's box, every
 * text's TextBounds (about 900 texts in 55 faces, wrapped and TextScaled ones too) and a screenshot of each visual
 * screen. Saved to FINDINGS_OUT (a folder; a temp folder otherwise) as `studio.json` and `shot-<screen>.png`, so the
 * comparison (`core/ui/lab/fidelity.ts`) can be run again offline. Then compares and prints the report. Closes that
 * Studio window. About a minute.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import { decodePng, encodePng } from '../../src/core/modeling/png';
import { decodeImage } from '../../src/core/look/look-analysis';
import { uiBuildChunk } from '../../src/core/ui/lab/ui-luau';
import { calMeasureLuau, calShowLuau, measureScreens, visualScreens } from '../../src/core/ui/lab/calibration';

const FILE = 'shuriken-uilab-e2e.rbxlx';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(process.env.E2E === 'ui-lab')('the UI Lab against Roblox (live)', () => {
  it('records Roblox boxes, TextBounds and screenshots of the calibration screens', async () => {
    if (process.platform !== 'win32') throw new Error('Windows with Roblox Studio only.');
    const out = process.env.FINDINGS_OUT ?? mkdtempSync(join(tmpdir(), 'shuriken-uilab-'));
    mkdirSync(out, { recursive: true });
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-uilab-project-'));
    const closeStudio = () => {
      try {
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${FILE}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
      } catch {
        /* none open */
      }
    };
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-uilab-data-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const studio = core.studio;
    try {
      await studio.start();
      writeFileSync(join(projectDir, FILE), sandboxPlaceXml('UI Lab E2E'), 'utf8');
      closeStudio();
      const ctx = core.openProject(core.createProject({ name: 'UI Lab E2E', rootPath: projectDir }).id);
      core.orchestrator.pause();
      await studio.openPlace(join(projectDir, FILE), FILE);
      ctx.updateSettings({ robloxStudioMatch: FILE });
      studio.bind(FILE);
      await sleep(4000);
      const pid = await studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      expect(pid.output.trim()).toBe('0');
      await studio.runLuau('game:GetService("StarterGui").ShowDevelopmentGui = true return "ok"', 'Edit');

      const { screens: measures, texts } = measureScreens();
      const visuals = visualScreens();
      const names = [...measures, ...visuals].map((s) => s.name);
      // One call per screen: each stays far inside what Studio takes in (and returns from) one call.
      for (const s of [...measures, ...visuals]) {
        const built = await studio.runLuau(uiBuildChunk([s], 'game:GetService("StarterGui")'), 'Edit', 120_000);
        expect(built.output, built.output).toContain('built 1');
      }

      // Reads until two in a row agree (fonts load asynchronously the first time a face is used).
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

      const measured: { texts: Record<string, [number, number, boolean]>; boxes: Record<string, number[]>; w: number; h: number } = { texts: {}, boxes: {}, w: 0, h: 0 };
      for (const m of measures) {
        await studio.runLuau(calShowLuau(names, m.name), 'Edit');
        const r = await settled(m.name);
        Object.assign(measured.texts, r.texts);
        Object.assign(measured.boxes, r.boxes);
        measured.w = r.w;
        measured.h = r.h;
      }
      const shots: Record<string, { file: string; w: number; h: number }> = {};
      const visual: Record<string, unknown> = {};
      for (const v of visuals) {
        await studio.runLuau(calShowLuau(names, v.name), 'Edit');
        visual[v.name] = await settled(v.name);
        await sleep(800);
        const shot = await studio.screenshot();
        if (!shot) throw new Error(`no screenshot of ${v.name}`);
        const buf = Buffer.from(shot.data, 'base64');
        const img = shot.mimeType.includes('png') ? decodePng(buf) : decodeImage(buf);
        const file = `shot-${v.name}.png`;
        writeFileSync(join(out, file), encodePng(img));
        shots[v.name] = { file, w: img.width, h: img.height };
        console.log(`shot ${v.name}: ${img.width}×${img.height} (viewport ${(visual[v.name] as { w: number }).w}×${(visual[v.name] as { h: number }).h})`);
      }
      await studio.runLuau(calShowLuau(names, null), 'Edit');
      const data = { at: new Date().toISOString(), texts, measured, visual, shots, screens: { measures, visuals } };
      writeFileSync(join(out, 'studio.json'), JSON.stringify(data));
      console.log(`saved to ${out}`);
      expect(Object.keys(measured.texts).length).toBe(texts.length);

      // The comparison is offline and can be run again on the saved folder.
      const lab = await import('../../src/core/ui/lab/fidelity').catch(() => null);
      if (lab) {
        const result = lab.compareCalibration(out);
        writeFileSync(join(out, 'report.json'), JSON.stringify(result, null, 2));
        console.log(lab.fidelityReport(result));
      }
    } finally {
      await studio.runLuau(`for _, g in game:GetService("StarterGui"):GetChildren() do if string.sub(g.Name, 1, 3) == "Cal" then g:Destroy() end end return "clean"`, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
      closeStudio();
    }
  }, 600_000);
});
