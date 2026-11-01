import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A reply from resources/blender/bridge.py. */
export interface BridgeReply {
  id?: number;
  ok: boolean;
  error?: string | null;
  ms?: number;
  timedOut?: boolean;
  [key: string]: unknown;
}

const MARK = '@@SHURIKEN ';

const versionOf = (p: string) => (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(p) ?? []).slice(1, 4).map((n) => Number(n ?? 0));

/**
 * blender.exe: the one set in Settings, else the newest in the usual places (the same places Kiln
 * looks: Desktop\Blender\<version>, Kiln's own copy, Program Files, Steam).
 */
export function findBlender(configured?: string | null): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const roots = [join(homedir(), 'Desktop', 'Blender'), join(process.env.LOCALAPPDATA ?? '', 'Kiln', 'blender'), join(process.env.LOCALAPPDATA ?? '', 'Shuriken', 'blender'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation')];
  const found: string[] = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const direct = join(root, 'blender.exe');
    if (existsSync(direct)) found.push(direct);
    try {
      for (const d of readdirSync(root)) {
        const exe = join(root, d, 'blender.exe');
        if (existsSync(exe)) found.push(exe);
      }
    } catch {
      /* unreadable */
    }
  }
  const steam = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe';
  if (existsSync(steam)) found.push(steam);
  found.sort((a, b) => {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  return found[0] ?? null;
}

/**
 * One long-lived headless Blender running resources/blender/bridge.py (Kiln's design). Requests are
 * JSON lines on stdin and run one at a time (Blender is single-threaded); replies are marked lines on
 * stdout. A request that hangs restarts Blender and reopens the last saved scene; so does a crash.
 */
export class BlenderBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, (r: BridgeReply) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private recent: string[] = [];
  private crashes: number[] = [];
  private stopping = false;
  private readonly killed = new WeakSet<ChildProcessWithoutNullStreams>();
  private onReady: (msg: Record<string, unknown>) => void = () => undefined;
  version: string | null = null;
  /** The scene to open after a (re)start, or null for an empty scene. Set by the workspace that holds it. */
  restorePath: () => string | null = () => null;

  constructor(
    private readonly exe: string,
    private readonly script: string,
  ) {}

  /** Starts Blender (once; concurrent callers share the start). */
  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Blender was stopped'));
    if (this.proc) return Promise.resolve();
    if (!this.starting) this.starting = this.launch().finally(() => (this.starting = null));
    return this.starting;
  }

  private launch(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.exe, ['-b', '--factory-startup', '-noaudio', '--python', this.script], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
      this.proc = proc;
      this.buf = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Blender did not start within 60 s. ${this.recent.slice(-8).join(' | ')}`));
      }, 60_000);
      let ready = false;
      this.onReady = async (msg) => {
        ready = true;
        clearTimeout(timer);
        this.version = String(msg.version ?? '') || null;
        try {
          const path = this.restorePath();
          const r = path ? await this.send({ op: 'open', path }, 60_000) : await this.send({ op: 'new' }, 60_000);
          if (!r.ok) throw new Error(r.error ?? 'could not load the scene');
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      };
      proc.stdout.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => this.remember(d.toString('utf8')));
      proc.on('error', (e) => {
        clearTimeout(timer);
        this.proc = null;
        reject(e);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        for (const [, done] of this.pending) done({ ok: false, error: `Blender stopped (exit code ${code}). ${this.recent.slice(-4).join(' | ')}` });
        this.pending.clear();
        if (!ready) reject(new Error(`Blender exited while starting (code ${code}). ${this.recent.slice(-8).join(' | ')}`));
        if (!this.stopping && ready && !this.killed.has(proc)) this.onCrash();
      });
    });
  }

  private onCrash(): void {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > 3) return; // the next call reports the failure
    this.start().catch(() => undefined);
  }

  private remember(text: string): void {
    for (const l of text.split(/\r?\n/)) if (l.trim()) this.recent.push(l.trim());
    if (this.recent.length > 60) this.recent = this.recent.slice(-60);
  }

  private onData(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const k = line.indexOf(MARK);
      if (k < 0) {
        this.remember(line);
        continue;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line.slice(k + MARK.length)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.event === 'ready') this.onReady(msg);
      else if (typeof msg.id === 'number') {
        const done = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        done?.(msg as BridgeReply);
      }
    }
  }

  private send(req: Record<string, unknown>, timeoutMs: number): Promise<BridgeReply> {
    const proc = this.proc;
    if (!proc) return Promise.resolve({ ok: false, error: 'Blender is not running' });
    const id = this.nextId++;
    return new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout', timedOut: true });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    });
  }

  /** Runs one request after the ones before it. A timeout restarts Blender from the last save. */
  call(op: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<BridgeReply> {
    const run = async (): Promise<BridgeReply> => {
      try {
        await this.start();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const r = await this.send({ op, ...payload }, timeoutMs);
      if (r.timedOut) {
        if (this.proc) {
          this.killed.add(this.proc);
          this.proc.kill();
          this.proc = null;
        }
        await this.start().catch(() => undefined);
        return { ok: false, timedOut: true, error: `Timed out after ${Math.round(timeoutMs / 1000)} s. Blender was restarted and the model reloaded from its last saved version (the unfinished call's changes are gone).` };
      }
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  get alive(): boolean {
    return !!this.proc || !!this.starting;
  }

  stop(): void {
    this.stopping = true;
    try {
      this.proc?.stdin.end();
    } catch {
      /* already gone */
    }
    const p = this.proc;
    setTimeout(() => p?.kill(), 1500).unref();
  }
}
