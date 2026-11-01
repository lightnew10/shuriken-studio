import { createRequire } from 'node:module';
import { newId } from '@shared/ids';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';

const require = createRequire(import.meta.url);

interface Pty {
  pid: number;
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
  pid: number;
  startedAt: string;
}

/**
 * Integrated terminal sessions (ConPTY via node-pty's prebuilt N-API binaries). Output is streamed to
 * the UI as events; input comes back through RPC. The module is loaded lazily so a missing native
 * binary disables only the terminal, never the core.
 */
export class TerminalService {
  private readonly sessions = new Map<string, { pty: Pty; info: TerminalInfo; buffer: string[] }>();
  private ptyModule: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => Pty } | null | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
  ) {}

  available(): { ok: boolean; reason?: string } {
    if (this.ptyModule === undefined) {
      try {
        this.ptyModule = require('node-pty');
      } catch (e) {
        this.ptyModule = null;
        this.log.warn('node-pty unavailable; terminal disabled', e);
      }
    }
    return this.ptyModule ? { ok: true } : { ok: false, reason: 'Terminal backend (node-pty) failed to load' };
  }

  create(opts: { cwd: string; shell?: string; args?: string[]; env?: Record<string, string>; cols?: number; rows?: number }): TerminalInfo {
    if (!this.available().ok) throw new Error('Terminal is unavailable on this machine');
    const shell = opts.shell ?? (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL ?? 'bash');
    const args = opts.args ?? (opts.shell ? [] : process.platform === 'win32' ? ['-NoLogo'] : []);
    const pty = this.ptyModule!.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: { ...process.env, TERM_PROGRAM: 'ShurikenStudio', ...(opts.env ?? {}) },
      useConpty: true,
    });
    const info: TerminalInfo = { id: newId('term'), shell, cwd: opts.cwd, pid: pty.pid, startedAt: new Date().toISOString() };
    const session = { pty, info, buffer: [] as string[] };
    this.sessions.set(info.id, session);
    pty.onData((data) => {
      session.buffer.push(data);
      if (session.buffer.length > 2000) session.buffer.splice(0, session.buffer.length - 2000);
      this.bus.emit('terminal.data', { id: info.id, data });
    });
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(info.id);
      this.bus.emit('terminal.exit', { id: info.id, exitCode });
    });
    return info;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (s && cols > 0 && rows > 0) s.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  /** Recent output, so a reopened view can repaint its session. */
  replay(id: string): string {
    return this.sessions.get(id)?.buffer.join('') ?? '';
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.pty.kill();
    } catch {
      /* already exited */
    }
    this.sessions.delete(id);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
