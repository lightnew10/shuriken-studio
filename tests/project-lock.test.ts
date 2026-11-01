import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, processStart } from '../src/core/projects/project-lock';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

/** A live process that is not a Shuriken core (as explorer.exe was when it got a dead core's PID). */
async function liveProcess(): Promise<number> {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  await new Promise((r) => setTimeout(r, 300));
  return c.pid!;
}

const busy = (pid: number) => `already open (process ${pid})`;

describe('the project lock', () => {
  it('takes over a lock whose PID now belongs to a process that started after the lock was taken', async () => {
    const pid = await liveProcess();
    const file = join(mkdtempSync(join(tmpdir(), 'shuriken-lock-')), 'open.lock');
    writeFileSync(file, JSON.stringify({ pid, since: new Date(Date.now() - 3_600_000).toISOString() }));
    const release = acquireLock(file, busy);
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid);
    release();
    release();
  }, 30000);

  it('keeps a lock its live holder took', async () => {
    const pid = await liveProcess();
    expect(processStart(pid)).toBeLessThanOrEqual(Date.now());
    const file = join(mkdtempSync(join(tmpdir(), 'shuriken-lock-')), 'open.lock');
    writeFileSync(file, JSON.stringify({ pid, since: new Date().toISOString() }));
    expect(() => acquireLock(file, busy)).toThrow(`already open (process ${pid})`);
    // A lock from before start times were compared (no time) counts as held too.
    writeFileSync(file, JSON.stringify({ pid }));
    expect(() => acquireLock(file, busy)).toThrow(/already open/);
    // This process holds it: refused as well (two cores in one process).
    writeFileSync(file, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
    expect(() => acquireLock(file, busy)).toThrow(/already open/);
  }, 30000);
});
