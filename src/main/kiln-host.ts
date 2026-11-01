import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app, shell } from 'electron';

/**
 * Finding (and when asked, starting) the user's Kiln, so Shuriken can show its own view onto it.
 *
 * Kiln writes %APPDATA%\Kiln\runtime.json (port, token, pid) while it runs, and holds a single-
 * instance lock. Shuriken never starts a second Kiln on the same data: a Kiln whose process is alive
 * is waited for, never relaunched (a second launch would also bring the user's own Kiln window
 * forward). Only when no Kiln runs does Shuriken start one, in the background.
 */

export interface KilnRuntime {
  port: number;
  token: string;
  pid: number;
  version: string | null;
  startedAt: string | null;
}

export type KilnFound = { ok: true; runtime: KilnRuntime; launched: boolean } | { ok: false; reason: string };

export function kilnRuntimeFile(): string {
  return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Kiln', 'runtime.json');
}

export function readKilnRuntime(): KilnRuntime | null {
  try {
    const v = JSON.parse(readFileSync(kilnRuntimeFile(), 'utf8')) as Record<string, unknown>;
    if (typeof v.port !== 'number' || typeof v.token !== 'string' || typeof v.pid !== 'number') return null;
    return { port: v.port, token: v.token, pid: v.pid, version: typeof v.version === 'string' ? v.version : null, startedAt: typeof v.startedAt === 'string' ? v.startedAt : null };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kiln answers its API with this runtime's token. */
export async function kilnAnswers(rt: KilnRuntime, timeoutMs = 2500): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${rt.port}/api/v1/app`, { headers: { Authorization: `Bearer ${rt.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Kiln.exe: the one set in Settings, else where Kiln last ran from (install.json), else the Desktop shortcut's target,
 * else the Kiln Shuriken Studio's installer put in (%LOCALAPPDATA%\Programs\Kiln).
 */
export function findKilnExe(configured: string | null): string | null {
  if (configured && existsSync(configured)) return configured;
  try {
    // Kiln 0.6+ writes %APPDATA%\Kiln\install.json at every start.
    const install = JSON.parse(readFileSync(join(dirname(kilnRuntimeFile()), 'install.json'), 'utf8')) as { exe?: unknown };
    if (typeof install.exe === 'string' && existsSync(install.exe)) return install.exe;
  } catch {
    /* an older Kiln, or never started */
  }
  const lnk = join(app.getPath('desktop'), 'Kiln.lnk');
  try {
    if (process.platform === 'win32' && existsSync(lnk)) {
      const target = shell.readShortcutLink(lnk).target;
      if (target && existsSync(target)) return target;
    }
  } catch {
    /* not a readable shortcut */
  }
  // Where Shuriken Studio's installer puts the Kiln that comes with it (build/installer.nsh), before Kiln first runs.
  const bundled = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Kiln', 'Kiln.exe');
  return existsSync(bundled) ? bundled : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a Kiln whose process is alive to answer; false if it never does (it is left alone). */
async function waitForAnswer(rt: KilnRuntime, deadline: number): Promise<KilnRuntime | null> {
  let cur: KilnRuntime | null = rt;
  while (cur && pidAlive(cur.pid)) {
    if (await kilnAnswers(cur)) return cur;
    if (Date.now() > deadline) return null;
    await sleep(500);
    cur = readKilnRuntime() ?? cur;
  }
  return null;
}

let pending: Promise<KilnFound> | null = null;

/**
 * The running Kiln; when none runs and `launch` allows, Kiln started with --background and waited for.
 * One search at a time (every window asking at once shares it).
 */
export function ensureKiln(opts: { exe: string | null; launch: boolean; timeoutMs?: number; log?: (msg: string) => void }): Promise<KilnFound> {
  pending ??= (async (): Promise<KilnFound> => {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const rt = readKilnRuntime();
    if (rt && pidAlive(rt.pid)) {
      const up = await waitForAnswer(rt, deadline);
      return up ? { ok: true, runtime: up, launched: false } : { ok: false, reason: 'Kiln is running but not answering. Restart Kiln and try again.' };
    }
    if (!opts.launch) return { ok: false, reason: "Kiln isn't running." };
    const exe = findKilnExe(opts.exe);
    if (!exe) return { ok: false, reason: "Kiln.exe wasn't found: set its location in Settings → Agents." };
    const before = rt?.startedAt ?? null;
    opts.log?.(`starting Kiln in the background: ${exe}`);
    // Through `cmd /c start`, so Kiln is not in Shuriken's process tree: closing Shuriken never closes Kiln.
    spawn('cmd.exe', ['/d', '/c', `start "" "${exe}" --background`], { cwd: dirname(exe), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    while (Date.now() < deadline) {
      await sleep(500);
      const now = readKilnRuntime();
      if (!now || now.startedAt === before || !pidAlive(now.pid)) continue;
      const up = await waitForAnswer(now, deadline);
      if (up) return { ok: true, runtime: up, launched: true };
    }
    return { ok: false, reason: `Kiln didn't start within ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} s.` };
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** The address Shuriken's view opens: Kiln's sign-in, then its embedded UI for a project. */
export function kilnEmbedUrl(rt: KilnRuntime, kilnProjectId: string | null): string {
  const next = `/?embed=shuriken${kilnProjectId ? `&project=${encodeURIComponent(kilnProjectId)}` : ''}`;
  return `http://127.0.0.1:${rt.port}/auth?t=${encodeURIComponent(rt.token)}&next=${encodeURIComponent(next)}`;
}

/** Only Kiln's own pages may load in (and talk to Shuriken from) the Kiln view. */
export function isKilnOrigin(url: string, rt: KilnRuntime | null): boolean {
  if (!rt) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === rt.port;
  } catch {
    return false;
  }
}
