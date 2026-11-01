import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LogRecord } from '@shared/events';
import type { EventBus } from './events';

const RING_SIZE = 2000;

/**
 * Structured logger: JSON lines on disk (one file per day), an in-memory ring buffer for the
 * Logs panel, and warn/error records forwarded to the UI as events.
 */
export class Logger {
  private readonly ring: LogRecord[] = [];
  /** The same warning or error over and over (a loop somewhere) is written 20 times, then summarized. */
  private readonly repeat = { key: '', n: 0, at: 0 };
  /**
   * The project this core has open (its window's), written on every line with the core's process id. Every project
   * window runs a core of its own and they all append to the same day's file: on 2026-10-07 two windows' lines
   * (a health check passing in one, failing in the other) could not be told apart.
   */
  private project: string | null = null;

  constructor(
    private readonly dir: string | null,
    private readonly bus: EventBus | null,
    private readonly minLevel: LogRecord['level'] = 'info',
  ) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  scope(name: string): ScopedLogger {
    return new ScopedLogger(this, name);
  }

  /** The window's project opened (its name) or closed (null): the label of every line from now on. */
  setProject(name: string | null): void {
    this.project = name;
  }

  write(level: LogRecord['level'], scope: string, msg: string, data?: unknown): void {
    const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
    if (order[level] < order[this.minLevel]) return;
    if (level === 'warn' || level === 'error') {
      const key = `${level}|${scope}|${msg}`;
      const now = Date.now();
      if (key === this.repeat.key && now - this.repeat.at < 10_000) {
        this.repeat.n++;
        this.repeat.at = now;
        if (this.repeat.n > 20) return;
      } else {
        if (this.repeat.n > 20) this.record('warn', 'log', `previous message repeated ${this.repeat.n - 20} more times`, this.repeat.key.slice(0, 300));
        Object.assign(this.repeat, { key, n: 1, at: now });
      }
    }
    this.record(level, scope, msg, data);
  }

  private record(level: LogRecord['level'], scope: string, msg: string, data?: unknown): void {
    const rec: LogRecord = { ts: new Date().toISOString(), level, scope, msg, data: serializable(data), pid: process.pid, ...(this.project ? { project: this.project } : {}) };
    this.ring.push(rec);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (this.dir) {
      try {
        appendFileSync(join(this.dir, `core-${rec.ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
      } catch {
        /* disk logging is best-effort */
      }
    }
    if (level === 'warn' || level === 'error') this.bus?.emit('log', rec);
    if (!this.dir) {
      // Test/dev fallback so failures are visible.
      if (level === 'error') console.error(`[${scope}] ${msg}`, data ?? '');
    }
  }

  recent(limit = 500, minLevel: LogRecord['level'] = 'debug'): LogRecord[] {
    const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
    return this.ring.filter((r) => order[r.level] >= order[minLevel]).slice(-limit);
  }
}

export class ScopedLogger {
  constructor(
    private readonly root: Logger,
    private readonly name: string,
  ) {}
  debug(msg: string, data?: unknown): void {
    this.root.write('debug', this.name, msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.root.write('info', this.name, msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.root.write('warn', this.name, msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.root.write('error', this.name, msg, data);
  }
}

function serializable(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
  return data;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
