/**
 * Live measurement, against real Roblox Studio, of WHEN Studio answers a screen capture (no model calls):
 *
 *   E2E=capture-focus npx vitest run -c vitest.e2e.config.ts tests/e2e/capture-focus.e2e.ts
 *
 * With two builds side by side, one project's captures timed out for hours (25 s, then 15 s, each inside Studio's
 * line) while the other project's worked: its Studio window was the one in front. This opens two throwaway places in
 * two new Studio windows and captures the first one while it is in front, while the other one has the focus (next to
 * it, over it), and after the app's own "raise above the others without focus", in Edit mode and in a playtest.
 * Only its own two windows are moved; it closes them. `FINDINGS_OUT=<file.json>` saves the measurements.
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { isBlankImage } from '../../src/core/roblox/studio-adapter';
import { StudioRecovery } from '../../src/core/roblox/studio-recovery';
import { lowerStudioWindow, raiseStudioWindow, readUserActivity, saveStudioPlace, WIN_HELPER_SOURCE } from '../../src/core/roblox/studio-window';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';

const A = 'shuriken-capture-a-e2e.rbxlx';
const B = 'shuriken-capture-b-e2e.rbxlx';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Window work on this test's own two Studio windows (found by their place file in the title). */
const WINDOWS = `${WIN_HELPER_SOURCE}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CapWin {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static long Find(string needle) {
    long found = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(400); GetWindowText(h, sb, 400);
      string t = sb.ToString();
      if (t.Contains(needle) && t.EndsWith("Roblox Studio")) { found = h.ToInt64(); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Place(long h, int x, int y, int w, int hgt) {
    IntPtr p = new IntPtr(h);
    ShowWindow(p, 4);
    SetWindowPos(p, IntPtr.Zero, x, y, w, hgt, 0x0010 | 0x0004);
  }
  public static bool IsFront(long h) { return GetForegroundWindow().ToInt64() == h; }
}
'@
`;
function windows(script: string): string {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${WINDOWS}\n${script}`], { encoding: 'utf8', windowsHide: true });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}
const place = (file: string, x: number, y: number, w: number, h: number) => windows(`$h = [CapWin]::Find('${file}'); if ($h -ne 0) { [CapWin]::Place($h, ${x}, ${y}, ${w}, ${h}); 'ok' } else { 'nowindow' }`);
const front = (file: string) => windows(`$h = [CapWin]::Find('${file}'); if ($h -ne 0) { [ShurikenWin]::Front($h) } else { 'nowindow' }`);
const isFront = (file: string) => windows(`[CapWin]::IsFront([CapWin]::Find('${file}'))`) === 'True';

describe.runIf(process.env.E2E === 'capture-focus')("when Studio answers a screen capture", () => {
  it('measures a capture of a Studio window in front, beside and under another Studio, and raised without focus', async () => {
    if (process.platform !== 'win32') throw new Error('Windows with Roblox Studio only.');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-capture-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-capture-project-'));
    const closeStudio = () => {
      for (const file of [A, B]) {
        try {
          execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${file}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
        } catch {
          /* none open */
        }
      }
    };
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const studio = core.studio;
    const findings: Record<string, unknown> = {};
    /** One capture of A, straight to Studio (no window handling, no retry): how long, and whether a picture came. */
    const capture = async (label: string, timeoutMs = 20_000, args: Record<string, unknown> = {}) => {
      const before = { aInFront: isFront(A), bInFront: isFront(B) };
      const t0 = Date.now();
      const r = await studio.call('screen_capture', { capture_id: `ScreenCapture_${Date.now()}`, ...args }, { timeoutMs });
      const img = r.content.find((c) => c.type === 'image' && typeof c.data === 'string');
      const got = !r.ok ? `no: ${(r.error ?? '').slice(0, 120)}` : !img ? 'no image' : isBlankImage(img.data as string) ? 'blank' : 'picture';
      findings[label] = { got, ms: Date.now() - t0, ...before };
      console.log(`CAPTURE ${label}: ${got} in ${Date.now() - t0} ms ${JSON.stringify(before)}`);
      // A capture that timed out may still be pending in Studio: give it room before the next.
      if (!r.ok) await sleep(4000);
      return got;
    };
    try {
      await studio.start();
      for (const [file, name] of [[A, 'Capture E2E A'], [B, 'Capture E2E B']] as const) writeFileSync(join(projectDir, file), sandboxPlaceXml(name), 'utf8');
      closeStudio();
      const summary = core.createProject({ name: 'Capture E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      core.orchestrator.pause();
      await studio.openPlace(join(projectDir, A), A);
      await studio.openPlace(join(projectDir, B), B);
      ctx.updateSettings({ robloxStudioMatch: A });
      studio.bind(A);
      await sleep(6000);
      findings.activity = await readUserActivity();

      const rounds = async (mode: string) => {
        // Side by side, nothing over either.
        place(A, 160, 120, 1300, 860);
        place(B, 1640, 120, 1300, 860);
        front(A);
        await sleep(2500);
        await capture(`${mode}: A in front`);
        front(B);
        await sleep(2500);
        await capture(`${mode}: B has the focus, A beside it (nothing covers A)`);
        // B over A, with the focus: what a second build's maximized window does to the first.
        place(B, 160, 120, 1300, 860);
        front(B);
        await sleep(2500);
        await capture(`${mode}: B has the focus and covers A`);
        // The app's own step for a capture nobody is there to see: above the others, focus untouched.
        const raised = await raiseStudioWindow(A, false);
        await sleep(1500);
        await capture(`${mode}: A raised above B without focus`);
        if (raised) await lowerStudioWindow(raised);
        front(A);
        await sleep(2500);
        await capture(`${mode}: A in front again`);
      };

      if (process.env.CAPTURE_REPAIR) {
        // The app's own way: a stop that waits for the capture never kills the tool; and when it is dead anyway,
        // the place is saved, closed and opened again (StudioRecovery.refresh), and captures answer.
        place(A, 160, 120, 1300, 860);
        front(A);
        await sleep(2500);
        ctx.updateExtras({ placeFile: A });
        expect(core.lease.tryAcquire('e2e')).toBe(true);
        for (let i = 1; i <= 3; i++) {
          await studio.setPlaying(true);
          await sleep(2500);
          const [shot] = await Promise.all([studio.screenshot().then((x) => (x ? 'picture' : 'none'), (e: Error) => `no: ${e.message.slice(0, 100)}`), studio.setPlaying(false).catch(() => undefined)]);
          findings[`kept apart ${i}: a screenshot and a stop asked together`] = shot;
          await sleep(1500);
          await capture(`kept apart ${i}: in Edit afterwards`, 8000);
        }
        // Now past the app's line, as Studio's own Stop button would do it.
        await studio.setPlaying(true);
        await sleep(2500);
        await Promise.all([capture('dead: a raw capture as the playtest stops'), studio.call('start_stop_play', { is_start: false }, { timeoutMs: 60_000 })]);
        await sleep(4000);
        core.lease.release('e2e');
        const first = await studio.screenshot().catch((e: Error) => e.message);
        findings['dead: what a screenshot says'] = typeof first === 'string' ? first.slice(0, 260) : 'picture';
        (studio as unknown as { captureDied(): void }).captureDied();
        const mark = await studio.runLuau('local p = Instance.new("Part") p.Name = "MadeBeforeRefresh" p.Anchored = true p.Parent = workspace return "made"', 'Edit', 15_000);
        findings['repair: a part made before the refresh'] = mark.output;
        const file = join(projectDir, A);
        const recovery = new StudioRecovery({
          project: () => core.project,
          studio,
          bus: core.bus,
          log: core.logger.scope('recovery'),
          working: () => true,
          reopened: async () => undefined,
          lease: core.lease,
          save: () => saveStudioPlace(file, 15_000, { unattended: true }),
          activity: async () => ({ idleMs: 10 * 60_000, foreground: 'RobloxStudioBeta' }),
        });
        const t0 = Date.now();
        findings['repair: refresh'] = await recovery.refresh();
        findings['repair: seconds'] = Math.round((Date.now() - t0) / 1000);
        const shot = await studio.screenshot().then((x) => (x ? 'picture' : 'none'), (e: Error) => `no: ${e.message.slice(0, 160)}`);
        findings['repair: a screenshot afterwards'] = shot;
        const kept = await studio.runLuau('return tostring(workspace:FindFirstChild("MadeBeforeRefresh") ~= nil)', 'Edit', 15_000);
        findings['repair: the part is in the reopened place'] = kept.output;
        const { ChatService } = await import('../../src/core/director/chat-service');
        findings['repair: chat'] = new ChatService(ctx, core.bus).list().map((m) => `${m.kind}: ${m.text}`);
        expect(findings['repair: refresh']).toBe('reopened');
        expect(shot).toBe('picture');
        expect(kept.output).toBe('true');
        return;
      }
      if (process.env.CAPTURE_STUCK) {
        // After one capture met a stopping playtest, no capture is answered any more. What brings them back?
        place(A, 160, 120, 1300, 860);
        front(A);
        await sleep(2500);
        await capture('stuck: before');
        expect(core.lease.tryAcquire('e2e')).toBe(true);
        await studio.setPlaying(true);
        await sleep(2500);
        await Promise.all([capture('stuck: capture as the playtest stops'), studio.setPlaying(false).catch(() => undefined)]);
        await sleep(2000);
        await capture('stuck: in Edit afterwards', 8000);
        const luau = await studio.runLuau('return "edit luau ok"', 'Edit', 15_000);
        findings['stuck: Edit Luau'] = luau.ok ? luau.output : `no: ${luau.output.slice(0, 120)}`;
        await capture('try: a capture with a camera', 8000, { camera_position: [0, 30, 40], look_at_position: [0, 0, 0] });
        await (studio as unknown as { conn: { disconnect(): Promise<void> } }).conn.disconnect();
        await studio.start();
        studio.bind(A);
        await sleep(3000);
        await capture("try: a new connection to Studio's MCP server", 8000);
        await studio.setPlaying(true);
        await sleep(4000);
        await capture('try: inside a new playtest', 8000);
        await studio.setPlaying(false);
        await sleep(2000);
        await capture('try: after that playtest, in Edit', 8000);
        await sleep(90_000);
        await capture('try: 90 s later', 8000);
        core.lease.release('e2e');
        // The heavy one: the place closed and opened again.
        const t0 = Date.now();
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${A}*' } | Stop-Process -Force"`, { stdio: 'ignore' });
        await sleep(4000);
        await studio.openPlace(join(projectDir, A), A);
        studio.bind(A);
        await sleep(6000);
        findings['reopen: seconds'] = Math.round((Date.now() - t0) / 1000);
        await capture('try: the place closed and opened again', 20_000);
        return;
      }
      if (process.env.CAPTURE_RACE) {
        // A capture asked for while the playtest stops (or starts) under it: does Studio's capture tool recover?
        // In 1.13 an Edit screenshot raced the next playtest, and captures answered "Target is closed (… Client)".
        place(A, 160, 120, 1300, 860);
        front(A);
        await sleep(2500);
        await capture('race: before');
        expect(core.lease.tryAcquire('e2e')).toBe(true);
        for (let i = 1; i <= Number(process.env.CAPTURE_RACE); i++) {
          await studio.setPlaying(true);
          await sleep(1500 + 400 * i);
          // The capture and the stop leave together; then one while Studio is still on its way back to Edit.
          const [, stopped] = await Promise.all([capture(`race ${i}: capture as the playtest stops`), studio.setPlaying(false).then(() => 'stopped', (e: Error) => `stop failed: ${e.message.slice(0, 80)}`)]);
          findings[`race ${i}: stop`] = stopped;
          await capture(`race ${i}: right after the stop`);
          // And one that leaves with the start.
          const [, started] = await Promise.all([capture(`race ${i}: capture as the playtest starts`), studio.setPlaying(true).then(() => 'started', (e: Error) => `start failed: ${e.message.slice(0, 80)}`)]);
          findings[`race ${i}: start`] = started;
          await studio.setPlaying(false).catch(() => undefined);
          await sleep(1500);
          await capture(`race ${i}: in Edit afterwards`);
        }
        core.lease.release('e2e');
        await sleep(5000);
        await capture('race: at the end');
        return;
      }
      await rounds('Edit');
      expect(core.lease.tryAcquire('e2e')).toBe(true);
      await studio.setPlaying(true);
      await sleep(5000);
      await rounds('Play');
      await studio.setPlaying(false);
      core.lease.release('e2e');
      expect((findings['Edit: A in front'] as { got: string }).got).toBe('picture');
    } finally {
      console.log('FINDINGS ' + JSON.stringify(findings, null, 1));
      if (process.env.FINDINGS_OUT) writeFileSync(process.env.FINDINGS_OUT, JSON.stringify(findings, null, 1), 'utf8');
      await studio.setPlaying(false).catch(() => undefined);
      closeStudio();
      await core.shutdown();
    }
  }, 900_000);
});
