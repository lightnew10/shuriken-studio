import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Roblox Studio's login lock, and the Studios it leaves stuck.
 *
 * Studio refreshes its Roblox login under a Windows lock (a named mutex, `www.roblox.com-oauth2RefreshToken-Studio`)
 * so that two Studios never refresh it at once. A Studio sometimes takes that lock on one thread and releases it from
 * another, which Windows refuses ("~NamedMutex::unlock(…) failed: Attempt to release mutex not owned by caller"): the
 * lock stays held for as long as that Studio runs, and every Studio started after it waits for it forever at its
 * automatic login ("LoginController::login with category 'Local'", then "Hang In Progress"). Measured 2 October 2026:
 * one build's Studio did it at start; four play windows, a scratch Studio, a plain Studio with no place and the next
 * project's own Studio all hung behind it, and the next project could not build. A Studio that did it says so in its
 * log within a second or two of starting, before anyone has worked in it.
 *
 * So Shuriken: checks every Studio it starts a few seconds in and starts one that took the lock this way again at once
 * (nothing has been done in it yet); ends a Studio it started that hangs at login instead of leaving it behind; and,
 * when a Studio hangs at login, finds the Studio that holds the lock. A project's own Studio that holds it is saved,
 * closed and opened again by its project (StudioRecovery); the lock is let go when that process ends, and the Studios
 * that waited for it carry on by themselves. One Shuriken did not start is named in the chat.
 */

/**
 * When to look (a Studio writes the failed release about 1.1 to 2.3 s after it starts), how long a Studio may sit at its
 * login before it is taken for stuck, and how often one is started again. An object so a test can shorten it.
 *
 * In the two cases of 2 October the Studio that kept the lock was the first one started after every Studio had been
 * closed (it refreshed the login at start: "AuthTokenRefresh … 'AuthenticateOnStartup'"); one started while another
 * runs has a fresh login and did not. So one that kept it is started again at once: the new one finds the login fresh.
 */
export const LOGIN_LOCK = { checkAfterMs: 4000, stuckAfterMs: 20_000, relaunches: 2, readBytes: 2 * 1024 * 1024 };

export interface StudioProcess {
  pid: number;
  /** When the process started (ms since epoch). */
  startedAt: number;
  /** Its main window's title ("<place file> - Roblox Studio" once a place is open; "Roblox Studio" before). */
  title: string;
  responding: boolean;
  commandLine: string;
}

/** The running Studio processes (none when not on Windows or when they can't be read). */
export function studioProcesses(): Promise<StudioProcess[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$cim = @{}
Get-CimInstance Win32_Process -Filter "Name='RobloxStudioBeta.exe'" | ForEach-Object { $cim[[int]$_.ProcessId] = [string]$_.CommandLine }
$out = @(Get-Process RobloxStudioBeta | ForEach-Object { [pscustomobject]@{ pid = $_.Id; startedAt = [long]([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds(); title = [string]$_.MainWindowTitle; responding = [bool]$_.Responding; commandLine = [string]$cim[[int]$_.Id] } })
ConvertTo-Json -InputObject $out -Compress -Depth 3
`;
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let text = '';
    ps.stdout.on('data', (d: Buffer) => (text += d.toString()));
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(text.trim() || '[]') as StudioProcess[] | StudioProcess;
        resolve((Array.isArray(parsed) ? parsed : [parsed]).filter((p) => p && typeof p.pid === 'number'));
      } catch {
        resolve([]);
      }
    });
    ps.on('error', () => resolve([]));
  });
}

/** Studio's log folder. */
export const studioLogsDir = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Roblox', 'logs');

/**
 * The log of the Studio process that started at `startedAt`: Studio names each log after its start time
 * ("…_20261002T215633Z_Studio_38AAB_last.log", UTC, to the second). Null when none is within a few seconds.
 */
export function studioLogFor(startedAt: number, dir = studioLogsDir()): string | null {
  if (!existsSync(dir)) return null;
  let best: { file: string; off: number } | null = null;
  for (const f of readdirSync(dir)) {
    const m = /_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_Studio_[^_]+_last\.log$/i.exec(f);
    if (!m) continue;
    const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    const off = Math.abs(at - startedAt);
    if (off <= 4000 && (!best || off < best.off)) best = { file: join(dir, f), off };
  }
  return best?.file ?? null;
}

/** Whether this Studio log shows the login lock taken and then not let go (see above). */
export function logHoldsLoginLock(file: string, bytes = LOGIN_LOCK.readBytes): boolean {
  if (!existsSync(file)) return false;
  const size = Math.min(statSync(file).size, bytes);
  const buf = Buffer.alloc(size);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const handles = [...text.matchAll(/NamedMutex\((\w+), name:www\.roblox\.com-oauth2RefreshToken-Studio\)/g)].map((m) => m[1]!);
  return handles.some((h) => text.includes(`~NamedMutex::unlock(${h}) failed`));
}

/** Studio processes already looked at (by pid and start time): the lock is taken, or not, in the first seconds. */
const looked = new Map<string, boolean>();

/** Whether this Studio process holds the login lock for good (its log is read once, after LOGIN_LOCK.checkAfterMs). */
export function holdsLoginLock(p: StudioProcess, dir = studioLogsDir(), now = Date.now()): boolean {
  const key = `${p.pid}:${p.startedAt}`;
  const known = looked.get(key);
  if (known !== undefined) return known;
  if (now - p.startedAt < LOGIN_LOCK.checkAfterMs) return false;
  const log = studioLogFor(p.startedAt, dir);
  const held = !!log && logHoldsLoginLock(log);
  looked.set(key, held);
  return held;
}

/** A Studio that has sat at its login for a while: not responding, and no place open in it yet. */
export function stuckAtLogin(p: StudioProcess, now = Date.now()): boolean {
  return !p.responding && !/ - Roblox Studio$/i.test(p.title) && now - p.startedAt >= LOGIN_LOCK.stuckAfterMs;
}

/** Whether this process is the Studio that was started with `file` (its command line names it). */
export const startedWith = (p: StudioProcess, file: string) => p.commandLine.toLowerCase().includes(file.toLowerCase());

/** Whether this process has `placeFileName` open (its window is titled with it). */
export const hasOpen = (p: StudioProcess, placeFileName: string) => p.title.toLowerCase().endsWith(`${placeFileName.toLowerCase()} - roblox studio`);

/** Ends a Studio process (a stuck one, or one started a moment ago that took the lock): nothing in it is lost. */
export function endStudio(pid: number): boolean {
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}
