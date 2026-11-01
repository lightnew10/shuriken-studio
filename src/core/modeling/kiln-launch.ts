import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Starting the user's Kiln when a build needs a model and Kiln isn't running: the default, so a build
 * never falls back to hand-modeling because nobody had opened Kiln. The same rules as the Kiln page's
 * host (main/kiln-host.ts): a Kiln whose process is alive is waited for, never relaunched; Kiln is
 * started with --background (tray only) outside Shuriken's process tree. Test runs never start it.
 */

export interface KilnStartFacts {
  /** Kiln answers its API (and has a Blender). */
  answers: boolean;
  /** runtime.json names a process that is alive. */
  processAlive: boolean;
  /** Kiln.exe, when it is installed. */
  exe: string | null;
  /** Settings allow starting it (on by default), and this isn't a test or smoke run. */
  allowed: boolean;
}

export type KilnStartDecision =
  | { do: 'nothing' }
  /** A Kiln is starting up (or busy): wait for it, never launch a second one. */
  | { do: 'wait' }
  | { do: 'start'; exe: string }
  | { do: 'cannot'; why: string };

/** What to do about a Kiln that a build needs. */
export function kilnStartDecision(f: KilnStartFacts): KilnStartDecision {
  if (f.answers) return { do: 'nothing' };
  if (f.processAlive) return { do: 'wait' };
  if (!f.allowed) return { do: 'cannot', why: "Kiln isn't running, and starting it for builds is switched off (Settings → Agents → Kiln)" };
  if (!f.exe) return { do: 'cannot', why: "Kiln isn't running and Kiln.exe wasn't found (set its location in Settings → Agents)" };
  return { do: 'start', exe: f.exe };
}

/** Why this process never starts Kiln, or null: a test run, a smoke run, or Kiln switched off by the environment. */
export function kilnStartForbidden(): string | null {
  if (process.env.SHURIKEN_NO_KILN === '1') return 'Kiln is switched off in this setup';
  if (process.env.SHURIKEN_SMOKE === '1') return 'a smoke run never starts Kiln';
  return null;
}

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kiln.exe: the one set in Settings, else where Kiln last ran from (%APPDATA%\Kiln\install.json, written by Kiln 0.6
 * and newer), else the Kiln Shuriken Studio's installer put in (%LOCALAPPDATA%\Programs\Kiln) before it first runs.
 */
export function findKilnExe(configured: string | null, runtimeFile: string): string | null {
  if (configured && existsSync(configured)) return configured;
  try {
    const install = JSON.parse(readFileSync(join(dirname(runtimeFile), 'install.json'), 'utf8')) as { exe?: unknown };
    if (typeof install.exe === 'string' && existsSync(install.exe)) return install.exe;
  } catch {
    /* never installed, or an older Kiln */
  }
  const bundled = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Kiln', 'Kiln.exe');
  return existsSync(bundled) ? bundled : null;
}

/** Through `cmd /c start`, so Kiln is not in Shuriken's process tree: closing Shuriken never closes Kiln. */
function startDetached(exe: string): void {
  spawn('cmd.exe', ['/d', '/c', `start "" "${exe}" --background`], { cwd: dirname(exe), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

export interface KilnLauncherOptions {
  runtimeFile: () => string;
  /** Asks Kiln whether it answers (a forced health check). */
  check: () => Promise<{ ok: boolean; detail: string }>;
  /** Kiln.exe from Settings ('' = found from install.json). */
  configured: () => string;
  /** The "start Kiln when a build needs it" setting. */
  allowed: () => boolean;
  /** How Kiln is started (tests pass a fake; without one a test run never starts anything). */
  spawn?: (exe: string) => void;
  log?: (msg: string) => void;
  timeoutMs?: number;
  pollMs?: number;
}

export type KilnStarted = { ok: true; launched: boolean } | { ok: false; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class KilnLauncher {
  private pending: Promise<KilnStarted> | null = null;
  /** When Shuriken last started Kiln itself (a second start isn't tried for a minute). */
  private lastStart = 0;

  constructor(private readonly o: KilnLauncherOptions) {}

  private alive(): boolean {
    try {
      const rt = JSON.parse(readFileSync(this.o.runtimeFile(), 'utf8')) as { pid?: unknown };
      return typeof rt.pid === 'number' && pidAlive(rt.pid);
    } catch {
      return false;
    }
  }

  private get permitted(): boolean {
    // A real spawn never happens under a test runner; a test that passes its own `spawn` decides for itself.
    const testRun = !this.o.spawn && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test');
    return this.o.allowed() && !kilnStartForbidden() && !testRun;
  }

  facts(answers: boolean): KilnStartFacts {
    return { answers, processAlive: this.alive(), exe: findKilnExe(this.o.configured().trim() || null, this.o.runtimeFile()), allowed: this.permitted };
  }

  /** Kiln is on this PC: its exe is known, or one is running. */
  get installed(): boolean {
    return this.alive() || !!findKilnExe(this.o.configured().trim() || null, this.o.runtimeFile());
  }

  /** Kiln doesn't answer now, but a kiln_request would bring it up (it is starting, or Shuriken can start it). */
  startable(answers: boolean): boolean {
    const d = kilnStartDecision(this.facts(answers));
    return d.do === 'start' || d.do === 'wait';
  }

  /** Why a Kiln that doesn't answer can't be brought up (the reason `ensure` would give), or null when it can. */
  whyNot(): string | null {
    const d = kilnStartDecision(this.facts(false));
    return d.do === 'cannot' ? d.why : null;
  }

  /** Kiln answering: as it is, after waiting for one that is starting, or started by Shuriken. One attempt at a time. */
  ensure(): Promise<KilnStarted> {
    this.pending ??= this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async run(): Promise<KilnStarted> {
    const timeout = this.o.timeoutMs ?? 45_000;
    const poll = this.o.pollMs ?? 500;
    const first = await this.o.check();
    const decision = kilnStartDecision(this.facts(first.ok));
    if (decision.do === 'nothing') return { ok: true, launched: false };
    if (decision.do === 'cannot') return { ok: false, reason: decision.why };
    let launched = false;
    if (decision.do === 'start') {
      if (Date.now() - this.lastStart < 60_000) return { ok: false, reason: "Kiln was started a moment ago and still doesn't answer" };
      this.lastStart = Date.now();
      this.o.log?.(`starting Kiln in the background: ${decision.exe}`);
      try {
        (this.o.spawn ?? startDetached)(decision.exe);
      } catch (e) {
        return { ok: false, reason: `Kiln couldn't be started (${(e as Error).message})` };
      }
      launched = true;
    }
    const deadline = Date.now() + timeout;
    let last = first;
    while (Date.now() < deadline) {
      await sleep(poll);
      last = await this.o.check();
      if (last.ok) return { ok: true, launched };
      // A Kiln that was only starting and went away again: nothing to wait for.
      if (!launched && !this.alive()) break;
    }
    return { ok: false, reason: launched ? `Kiln didn't start within ${Math.round(timeout / 1000)} s` : last.detail === 'Kiln is not running' ? 'Kiln is running but not answering (restart Kiln)' : last.detail };
  }
}
