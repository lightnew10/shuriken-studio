import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/db/store';

/**
 * The databases' write-ahead logs reach their files: a global.db once had not been written for a month, every change
 * since lived only in its -wal, and a hard stop of the app lost them all. A copy of the file alone stands in for
 * "the log is gone".
 */
describe('the write-ahead log reaches the database file', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'store-ckpt-'));
    dirs.push(d);
    return d;
  };
  const MIGRATIONS = [{ version: 1, name: 'init', sql: 'CREATE TABLE t (x TEXT)' }];
  const rowsInFileAlone = (file: string) => {
    const copy = `${file}.alone.db`;
    copyFileSync(file, copy);
    const db = new DatabaseSync(copy);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    db.close();
    return n;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('saves on demand, so the file alone has every row', () => {
    const file = join(dir(), 'global.db');
    const s = new Store(file, MIGRATIONS);
    for (let i = 0; i < 50; i++) s.run('INSERT INTO t VALUES (?)', [`row ${i}`]);
    const r = s.checkpoint();
    expect(r).toMatchObject({ busy: 0 });
    expect(r!.done).toBe(r!.log);
    expect(rowsInFileAlone(file)).toBe(50);
    s.close();
  });

  it('saves what an earlier session left in the log when it opens', () => {
    const file = join(dir(), 'global.db');
    // An earlier session that stopped hard: its rows are only in the log.
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE t (x TEXT);');
    raw.exec(`INSERT INTO schema_migrations VALUES (1, 'init', '2026-10-27'); ${Array.from({ length: 30 }, (_, i) => `INSERT INTO t VALUES ('old ${i}');`).join(' ')}`);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const s = new Store(file, MIGRATIONS);
    expect(rowsInFileAlone(file)).toBe(30);
    s.close();
    raw.close();
  });

  it('saves on close', () => {
    const file = join(dir(), 'project.db');
    const s = new Store(file, MIGRATIONS);
    s.run('INSERT INTO t VALUES (?)', ['last']);
    s.close();
    expect(!existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0).toBe(true);
    expect(rowsInFileAlone(file)).toBe(1);
  });
});
