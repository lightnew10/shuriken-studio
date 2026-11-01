/**
 * Live check, against real Roblox Studio, of Roblox's login lock and what Shuriken does about it (no model calls):
 *
 *   E2E=login-lock npx vitest run -c vitest.e2e.config.ts tests/e2e/login-lock.e2e.ts
 *
 * Needs NO Studio running when it starts (it refuses otherwise: it measures the first Studio after a break). Opens
 * throwaway places only, each in a new Studio window, through the app's own RobloxStudioAdapter.openPlace, and closes
 * them all. Rounds (`ROUNDS`, default 3): open place A as the first Studio (does it keep the login lock? did the app
 * start it again?), then place B beside it (does it open?), then close both and wait `GAP_S` seconds before the next
 * round. `FINDINGS_OUT=<file.json>` saves the measurements.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import { holdsLoginLock, studioLogFor, studioProcesses, logHoldsLoginLock } from '../../src/core/roblox/studio-login-lock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = 'shuriken-lock-a-e2e.rbxlx';
const B = 'shuriken-lock-b-e2e.rbxlx';

function closeMine(): void {
  for (const f of [A, B]) {
    try {
      execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='RobloxStudioBeta.exe'\\" | Where-Object { $_.CommandLine -like '*${f}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'ignore' });
    } catch {
      /* none */
    }
  }
}

describe.runIf(process.env.E2E === 'login-lock')("Roblox's login lock", () => {
  it('the first Studio after a break, started again when it kept the lock, and a second Studio beside it', async () => {
    if (process.platform !== 'win32') throw new Error('Windows with Roblox Studio only.');
    const running = await studioProcesses();
    if (running.length) throw new Error(`Close every Studio first: ${running.length} running (this measures the first Studio after a break).`);
    const rounds = Number(process.env.ROUNDS ?? 3);
    const gapMs = Number(process.env.GAP_S ?? 20) * 1000;
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-lock-e2e-'));
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-lock-places-'));
    writeFileSync(join(dir, A), sandboxPlaceXml('Lock E2E A'), 'utf8');
    writeFileSync(join(dir, B), sandboxPlaceXml('Lock E2E B'), 'utf8');
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    const studio = core.studio;
    const findings: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const log = (studio as unknown as { log: { warn: (...a: unknown[]) => void } }).log;
    const warn = log.warn.bind(log);
    log.warn = (...a: unknown[]) => {
      warnings.push(String(a[0]));
      warn(...a);
    };
    try {
      await studio.start();
      for (let round = 1; round <= rounds; round++) {
        const before = warnings.length;
        const t0 = Date.now();
        await studio.openPlace(join(dir, A), A, 180_000);
        const aMs = Date.now() - t0;
        await sleep(3000);
        const procs = await studioProcesses();
        const a = procs.find((p) => p.commandLine.toLowerCase().includes(A));
        // Every Studio log written in this round: which kept the lock (also one the app ended and started again).
        const kept = procs.map((p) => ({ pid: p.pid, holds: holdsLoginLock(p) }));
        const restarted = warnings.slice(before).filter((w) => /kept Roblox's login lock/.test(w)).length;
        const t1 = Date.now();
        let bOpened = true;
        let bError = '';
        try {
          await studio.openPlace(join(dir, B), B, 90_000);
        } catch (e) {
          bOpened = false;
          bError = String(e).slice(0, 300);
        }
        const bMs = Date.now() - t1;
        const aLog = a ? studioLogFor(a.startedAt) : null;
        const row = { round, aOpenedInMs: aMs, aKeptLockNow: a ? holdsLoginLock(a) : null, aLogHolds: aLog ? logHoldsLoginLock(aLog) : null, restartedByApp: restarted, bOpened, bMs, bError, processes: kept };
        findings.push(row);
        console.log(`LOCK round ${round}: ${JSON.stringify(row)}`);
        closeMine();
        await sleep(gapMs);
      }
      if (process.env.FINDINGS_OUT) writeFileSync(process.env.FINDINGS_OUT, JSON.stringify(findings, null, 2), 'utf8');
      // What must hold whatever the first start did: a second Studio opens beside the first, every round.
      expect(findings.every((f) => f.bOpened)).toBe(true);
      expect(findings.every((f) => f.aKeptLockNow === false)).toBe(true);
    } finally {
      if (process.env.FINDINGS_OUT && !findings.length) writeFileSync(process.env.FINDINGS_OUT, JSON.stringify({ findings, warnings }, null, 2), 'utf8');
      closeMine();
      await core.shutdown().catch(() => undefined);
    }
  });
});
