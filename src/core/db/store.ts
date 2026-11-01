import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export type Params = Record<string, SQLInputValue> | SQLInputValue[] | undefined;

/**
 * Thin, synchronous wrapper around node:sqlite with WAL, foreign keys, a statement cache and
 * forward-only migrations. One Store per database file; core is single-threaded so a single
 * connection per file is correct and avoids lock contention.
 */
export class Store {
  readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(
    readonly path: string,
    migrations: Migration[],
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    // What an earlier session left in the log goes into the database file now (a global.db once kept a month of
    // changes only in its -wal, and a hard stop of the app lost them all).
    this.checkpoint('TRUNCATE');
    this.migrate(migrations);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, params?: Params): T[] {
    const s = this.stmt(sql);
    return (Array.isArray(params) ? s.all(...params) : params ? s.all(params) : s.all()) as T[];
  }

  get<T>(sql: string, params?: Params): T | undefined {
    const s = this.stmt(sql);
    return (Array.isArray(params) ? s.get(...params) : params ? s.get(params) : s.get()) as T | undefined;
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const s = this.stmt(sql);
    const r = Array.isArray(params) ? s.run(...params) : params ? s.run(params) : s.run();
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Nested calls join the outer transaction (savepoints keep inner failures contained). */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth++;
    const sp = `sp${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    try {
      const out = fn();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  private migrate(migrations: Migration[]): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const applied = new Set(
      this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
    );
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    for (const m of sorted) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          m.version,
          m.name,
          new Date().toISOString(),
        ]);
      });
    }
  }

  schemaVersion(): number {
    return this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  }

  /**
   * Copies the write-ahead log into the database file (WAL mode). `busy`: another connection held it back; `log` /
   * `done`: pages in the log and pages copied. Null for an in-memory database or when the database is closed.
   */
  checkpoint(mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): { busy: number; log: number; done: number } | null {
    if (this.path === ':memory:') return null;
    try {
      const r = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as { busy: number; log: number; checkpointed: number } | undefined;
      return r ? { busy: r.busy, log: r.log, done: r.checkpointed } : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.cache.clear();
    this.checkpoint('TRUNCATE');
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── JSON column helpers ─────────────────────────────────────────────────────

export function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function pj<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Truncate large payloads before persisting them in audit columns. */
export function clip(value: unknown, maxChars = 20000): unknown {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return null;
  if (s.length <= maxChars) return value;
  return { truncated: true, length: s.length, head: s.slice(0, maxChars) };
}
