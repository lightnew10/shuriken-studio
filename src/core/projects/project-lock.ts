import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * An exclusive lock file holding the owner's PID and when it took the lock: two engines on one project would
 * run two orchestrators against the same tasks and files. A stale lock is taken over: its process is gone, or
 * its PID now belongs to a process that started after the lock was taken (Windows reuses PIDs; a lock left by
 * a crash once blocked its project for good when explorer.exe got the number). Releasing twice is harmless.
 */
export function acquireLock(file: string, busy: (pid: number) => string): () => void {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const held = JSON.parse(readFileSync(file, 'utf8')) as { pid: number };
          if (held.pid === process.pid) unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let held: { pid?: number; since?: string } = {};
      try {
        held = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; since?: string };
      } catch {
        /* unreadable lock is stale */
      }
      // Any live holder counts, this process included (two cores in one process, as in tests).
      if (held.pid && alive(held.pid) && !startedAfter(held.pid, held.since)) {
        throw new Error(busy(held.pid));
      }
      try {
        unlinkSync(file);
      } catch {
        /* raced */
      }
    }
  }
  throw new Error(`Could not acquire the lock at ${file}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when process `pid` started after `since` (the lock's ISO time), so it can't be the process that took the
 * lock then. A real holder started before it took the lock; a process that got its PID later started after.
 * Unknown (no time recorded, the start time unreadable) counts as the holder.
 */
export function startedAfter(pid: number, since: string | undefined): boolean {
  const at = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(at)) return false;
  const started = processStart(pid);
  // Two seconds of slack: `ps` reports whole seconds.
  return started !== null && started > at + 2000;
}

/** When a process started (epoch ms), or null when that can't be told. */
export function processStart(pid: number): number | null {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        : execFileSync('ps', ['-o', 'lstart=', '-p', String(Math.trunc(pid))], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
