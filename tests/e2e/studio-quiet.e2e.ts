/**
 * Live check, with no Roblox Studio at all, of what keeps an agent's playtest out of the user's way (1.16.1):
 *
 *   E2E=quiet npx vitest run -c vitest.e2e.config.ts tests/e2e/studio-quiet.e2e.ts
 *
 * A stand-in "Studio": a small program built here and named RobloxStudioBeta.exe, with a window titled like a place
 * window (off screen, shown without taking the focus), playing a silent sound so Windows gives it a sound session. The
 * real focus guard is pointed at it. While an agent's playtest runs and the stand-in isn't the window in front, the
 * guard mutes it and says whether the user is at the PC ("FREE 1": input in the last 3 minutes); when the playtest ends
 * it is unmuted. With QUIET_FOCUS=1 it also opens a second stand-in "in the background" that pulls itself to the front,
 * and checks that the guard sends it behind again: that one moves the focus for a moment, so run it when nobody is using
 * the PC. Only its own stand-ins are touched, and they are closed. What it can't show: Roblox applying a game's mouse
 * lock to the cursor (that needs a real playtest; LUAU_MOUSE_FREE_CLIENT is what answers it there).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIO_HELPER_SOURCE, StudioFocusGuard, WIN_HELPER_SOURCE } from '../../src/core/roblox/studio-window';

const run = process.env.E2E === 'quiet' && process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ps(script: string): string {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}
const muted = (pid: number) => Number(ps(`${AUDIO_HELPER_SOURCE()}\n[ShurikenAudio]::IsMuted(${pid})`).split(/\s+/).pop());
const idleMs = () => Number(ps(`${WIN_HELPER_SOURCE}\n[ShurikenWin]::IdleMs()`).split(/\s+/).pop());
const foregroundPid = () => Number(ps(`${WIN_HELPER_SOURCE}\n[ShurikenWin]::ForegroundPid()`).split(/\s+/).pop());

/** The stand-in's source: a window with the given title, shown without the focus (or pulling itself in front), playing a WAV in a loop. */
const STAND_IN = `
using System;
using System.Drawing;
using System.Media;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class StandIn : Form {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  readonly bool front;
  public StandIn(string title, bool front, Point at) {
    this.front = front;
    Text = title;
    ShowInTaskbar = true; // an owned window (no taskbar button) has no main-window title, and Studio windows are found by it
    StartPosition = FormStartPosition.Manual;
    Location = at;
    Size = new Size(240, 140);
  }
  protected override bool ShowWithoutActivation { get { return !front; } }
  protected override void OnShown(EventArgs e) {
    base.OnShown(e);
    if (front) { Activate(); SetForegroundWindow(Handle); }
  }
  [STAThread] public static void Main(string[] a) {
    SoundPlayer p = new SoundPlayer(a[2]);
    p.PlayLooping();
    bool front = a[1] == "front";
    Application.Run(new StandIn(a[0], front, front ? new Point(40, 40) : new Point(-4000, -4000)));
  }
}`;

/** One second of silence, 16-bit mono PCM. */
function silentWav(file: string): void {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

describe.skipIf(!run)('an agent playtest stays out of the way (stand-in Studio, no Roblox)', () => {
  it('mutes the stand-in while its playtest runs and it is not in front, says FREE from the user’s activity, unmutes after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-quiet-'));
    const exe = join(dir, 'RobloxStudioBeta.exe');
    const wav = join(dir, 'silence.wav');
    silentWav(wav);
    const built = ps(`$src = @'\n${STAND_IN}\n'@\nAdd-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${exe}' -OutputType WindowsApplication\n'BUILT'`);
    expect(built).toContain('BUILT');
    const procs: ChildProcess[] = [];
    const events: string[] = [];
    const guard = new StudioFocusGuard((e) => events.push(e));
    try {
      const needle = `quiet-${process.pid}.rbxlx`;
      const a = spawn(exe, [`${needle} - Roblox Studio`, 'back', wav], { stdio: 'ignore' });
      procs.push(a);
      await sleep(2500);
      expect(muted(a.pid!)).toBe(0);
      expect(foregroundPid()).not.toBe(a.pid);

      // An agent's playtest comes up in the stand-in.
      expect(await guard.play(needle, true)).toBe(true);
      let state = -1;
      for (let i = 0; i < 20 && state !== 1; i++) {
        await sleep(250);
        state = muted(a.pid!);
      }
      expect(state).toBe(1);
      const away = idleMs() >= 180_000;
      expect(events).toContain(away ? 'FREE 0' : 'FREE 1');

      // The playtest ends: sound back, the mouse is the game's again.
      expect(await guard.play(needle, false)).toBe(true);
      for (let i = 0; i < 20 && state !== 0; i++) {
        await sleep(250);
        state = muted(a.pid!);
      }
      expect(state).toBe(0);
      expect(events.at(-1)).toBe('FREE 0');

      if (process.env.QUIET_FOCUS === '1') {
        // A Studio opened in the background pulls itself in front: it is sent behind again.
        const before = foregroundPid();
        const needle2 = `quiet-open-${process.pid}.rbxlx`;
        expect(await guard.opening(needle2, 15_000)).toBe(true);
        await sleep(300);
        const b = spawn(exe, [`${needle2} - Roblox Studio`, 'front', wav], { stdio: 'ignore' });
        procs.push(b);
        await sleep(3000);
        const after = foregroundPid();
        expect(after).not.toBe(b.pid);
        expect(after).toBe(before);
        expect(events).toContain('GAVEBACK opened');
      }
    } finally {
      guard.close();
      for (const p of procs) p.kill();
      await sleep(500);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
