/**
 * Live measurement, against real Roblox Studio, of saving a place through Studio's File menu (no model calls):
 *
 *   E2E=save-menu npx vitest run -c vitest.e2e.config.ts tests/e2e/save-menu.e2e.ts
 *
 * In two builds of 14 hours the place of one was saved once: Ctrl+S needs Studio in the foreground, Windows refused
 * that for hours, and a dialog in front of the place took the keys. Studio then crashed and came back three hours
 * old. This opens one throwaway place in a new Studio window, puts a Notepad window of its own in front of it, and
 * saves the place through the menu: the file must change, no key may be sent, and Notepad must have the focus back.
 * It also asks what the menu says while the place is in a playtest. Only its own two windows are touched; it closes
 * them. `FINDINGS_OUT=<file.json>` saves the measurements.
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { pressSaveInMenu, saveStudioPlace, WIN_HELPER_SOURCE } from '../../src/core/roblox/studio-window';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';

const PLACE = 'shuriken-save-e2e.rbxlx';
const NOTE = 'shuriken-save-e2e-in-front';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function windows(script: string): string {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${WIN_HELPER_SOURCE}\n${script}`], { encoding: 'utf8', windowsHide: true });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}
const foreground = () => windows('[ShurikenWin]::Foreground()');

describe.runIf(process.env.E2E === 'save-menu')("saving a place through Studio's File menu", () => {
  it('saves without keys, gives the focus back, and says what the menu does in a playtest', async () => {
    if (process.platform !== 'win32') throw new Error('Windows with Roblox Studio only.');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-save-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-save-project-'));
    const file = join(projectDir, PLACE);
    const closeStudio = () => {
      try {
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${PLACE}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
      } catch {
        /* none open */
      }
    };
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const studio = core.studio;
    const findings: Record<string, unknown> = {};
    // "The app the user works in": a Notepad window of this test's own, on a file of its own name.
    const note = join(projectDir, `${NOTE}.txt`);
    writeFileSync(note, '', 'utf8');
    spawn('cmd.exe', ['/d', '/c', `start "" notepad.exe "${note}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    const notepadWindow = () => windows(`$n = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${NOTE}*' } | Select-Object -First 1; if ($n) { $n.MainWindowHandle.ToInt64() } else { 0 }`);
    const closeNotepad = () => windows(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${NOTE}*' } | ForEach-Object { $null = $_.CloseMainWindow() }`);
    try {
      await studio.start();
      writeFileSync(file, sandboxPlaceXml('Save E2E'), 'utf8');
      closeStudio();
      const summary = core.createProject({ name: 'Save E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      await studio.openPlace(file, PLACE);
      ctx.updateSettings({ robloxStudioMatch: PLACE });
      studio.bind(PLACE);
      await sleep(6000);

      const save = async (label: string) => {
        let pad = '0';
        for (let i = 0; i < 20 && pad === '0'; i++) {
          pad = notepadWindow();
          if (pad === '0') await sleep(500);
        }
        for (let i = 0; i < 3 && foreground() !== pad; i++) {
          windows(`$null = [ShurikenWin]::Front(${pad})`);
          await sleep(800);
        }
        const was = foreground();
        const before = statSync(file).mtimeMs;
        const t0 = Date.now();
        const r = await saveStudioPlace(file, 20_000);
        const ms = Date.now() - t0;
        await sleep(400);
        const after = foreground();
        findings[label] = { ok: r.ok, how: r.how, menuNote: r.menuNote, message: r.message, ms, changed: statSync(file).mtimeMs > before, otherAppInFrontBefore: was === pad && pad !== '0', focusBack: after === was };
        console.log(`SAVE ${label}: ${JSON.stringify(findings[label])}`);
        return { r, focusBack: after === was, inFront: was === pad && pad !== '0' };
      };

      // 1. Edit mode, another app in front of Studio.
      await studio.runLuau('local p = Instance.new("Part") p.Name = "SavedByMenu" p.Anchored = true p.Parent = workspace return "ok"', 'Edit');
      const first = await save('edit mode, Notepad in front');
      expect(first.r.ok).toBe(true);
      expect(first.r.how).toBe('menu');
      expect(readFileSync(file, 'utf8')).toContain('SavedByMenu');
      expect(first.inFront).toBe(true);
      expect(first.focusBack).toBe(true);

      // 2. Twelve presses one after the other, with Notepad or Studio itself in front: every one must press, and
      // how long Studio has the focus for one.
      const presses: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 12; i++) {
        const pad = notepadWindow();
        if (i % 3 !== 2) windows(`$null = [ShurikenWin]::Front(${pad})`);
        await sleep(i % 2 ? 150 : 900);
        const before = statSync(file).mtimeMs;
        const p = await pressSaveInMenu(PLACE);
        await sleep(300);
        presses.push({ state: p.state, tries: p.tries, frontMs: p.frontMs, note: p.note, changed: statSync(file).mtimeMs > before });
      }
      findings.presses = presses;
      console.log(`PRESSES: ${JSON.stringify(presses)}`);
      expect(presses.filter((p) => p.state !== 'pressed' || !p.changed)).toEqual([]);

      // 3. In a playtest: what the menu says, and WHAT is saved (the place being edited, or the running game?).
      await studio.setPlaying(true);
      await sleep(4000);
      const made = await studio.runLuau('local p = Instance.new("Part") p.Name = "OnlyInTheRunningGame" p.Anchored = true p.Parent = workspace return "ok"', 'Server');
      const before = statSync(file).mtimeMs;
      const t0 = Date.now();
      const playing = await pressSaveInMenu(PLACE);
      const pressMs = Date.now() - t0;
      await sleep(1500);
      const text = readFileSync(file, 'utf8');
      const still = await studio.state().catch(() => null);
      findings.playtest = { ...playing, pressMs, madeInGame: made.ok, changed: statSync(file).mtimeMs > before, savedTheRunningGame: text.includes('OnlyInTheRunningGame'), hasEditPart: text.includes('SavedByMenu'), stillPlaying: still?.availableDataModels };
      console.log(`PLAYTEST: ${JSON.stringify(findings.playtest)}`);
      await studio.setPlaying(false);
      await sleep(2500);

      // 4. Right after the playtest, and again a little later: a save works.
      const again = await save('edit mode, right after the playtest');
      expect(again.r.ok).toBe(true);
      await sleep(5000);
      const later = await save('edit mode, a little later');
      expect(later.r.ok).toBe(true);
      expect(later.r.how).toBe('menu');
      expect(later.focusBack).toBe(true);

      // 5. The way the app saves with someone at the PC: through the menu only, at a pause in their input (a save,
      // or "waiting" when someone really is typing while this runs).
      const guarded = await saveStudioPlace(file, 20_000, { via: 'menu', minIdleMs: 1500 });
      findings.guarded = guarded;
      console.log(`GUARDED: ${JSON.stringify(guarded)}`);
      expect(guarded.ok || guarded.waiting).toBe(true);
      expect(guarded.noMenu).toBeUndefined();
    } finally {
      if (process.env.FINDINGS_OUT) writeFileSync(process.env.FINDINGS_OUT, JSON.stringify(findings, null, 2), 'utf8');
      closeStudio();
      closeNotepad();
      await core.shutdown().catch(() => undefined);
    }
  });
});
