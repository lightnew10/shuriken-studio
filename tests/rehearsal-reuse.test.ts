import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationMethod } from '../src/shared/domain';
import { REHEARSAL_REUSE, VERIFY_CLOCK } from '../src/core/verification/verifier';
import { coreHarness } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * Studio has one play mode. In a 12-agent build it started 91 playtests in half an hour; 42 were the agents' own
 * calls, and most of the rest were each task's checks played twice: once by the worker (task_run_checks), and again
 * by the verification a minute or two later, on the same files, with everyone else waiting three to five minutes in
 * line. A playtest check that just passed in the rehearsal now stands for the verification.
 */
const makeCore = coreHarness();
const MAP = { 'src/Server': 'ServerScriptService/Server' };
const PLAY: VerificationMethod = { kind: 'playtest', name: 'round_runs', durationSec: 2, luau: "return 'PASS'", failOnConsoleErrors: false };
const saved = { ...REHEARSAL_REUSE };
const savedClock = { ...VERIFY_CLOCK };
// A second of play is 20 ms here: the checks' own play time is not what is tested.
beforeEach(() => void (VERIFY_CLOCK.secondMs = 20));
afterEach(() => {
  Object.assign(REHEARSAL_REUSE, saved);
  Object.assign(VERIFY_CLOCK, savedClock);
});

async function setup(verification: VerificationMethod[]) {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  h.ctx.updateExtras({ syncMode: 'shuriken', syncMap: MAP });
  const write = (rel: string, body: string) => {
    mkdirSync(join(h.root, rel, '..'), { recursive: true });
    writeFileSync(join(h.root, rel), body, 'utf8');
  };
  write('src/Server/Round.server.luau', 'print("round v1")\n');
  const sim = attachSim(h.core);
  sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'PASS');
  const task = h.ctx.tasks.create({ kind: 'implement', title: 'Round loop', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification });
  const scope = ['src/Server/Round.server.luau'];
  const rehearse = () => h.core.verifier.rehearse(h.ctx, h.ctx.tasks.get(task.id)!, 'run_me', scope);
  const verify = () => h.core.verifier.verify(h.ctx, h.ctx.tasks.get(task.id)!, 'run_me', scope);
  return { ...h, sim, task, write, rehearse, verify };
}

describe("a playtest check that just passed in the worker's rehearsal", () => {
  it('is not played again by the verification, which says so and still records it', async () => {
    const { ctx, sim, task, rehearse, verify } = await setup([PLAY]);
    expect((await rehearse()).passed).toBe(true);
    expect(sim.starts).toBe(1);
    const report = await verify();
    expect(report.passed, report.summary).toBe(true);
    // No second playtest: Studio's play mode was not taken at all.
    expect(sim.starts).toBe(1);
    const check = report.results.find((r) => r.name === 'round_runs')!;
    expect(check.passed).toBe(true);
    expect(check.output).toMatch(/This check passed \d+ s ago in the worker's own run of the task's checks, and the task's files have not changed since: it was not played again\./);
    const ev = ctx.tasks.evidence(task.id).find((e) => /round_runs/.test(e.title))!;
    expect(ev.title).toMatch(/^Playtest: round_runs \(passed \d+ s ago in the worker's rehearsal, same files\)$/);
    expect(ev.passed).toBe(true);
    // Used once: the next verification (after a rejection, say) plays it.
    expect((await verify()).passed).toBe(true);
    expect(sim.starts).toBe(2);
  });

  it('is played again when one of the task\'s files changed after the rehearsal', async () => {
    const { sim, write, rehearse, verify } = await setup([PLAY]);
    await rehearse();
    write('src/Server/Round.server.luau', 'print("round v2, a longer file")\n');
    expect((await verify()).passed).toBe(true);
    expect(sim.starts).toBe(2);
  });

  it('is played again when the rehearsal is too old, or when it failed', async () => {
    const old = await setup([PLAY]);
    await old.rehearse();
    REHEARSAL_REUSE.maxAgeMs = -1;
    await old.verify();
    expect(old.sim.starts).toBe(2);
    Object.assign(REHEARSAL_REUSE, saved);

    const bad = await setup([PLAY]);
    bad.sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'FAIL: no round');
    expect((await bad.rehearse()).passed).toBe(false);
    bad.sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'PASS');
    expect((await bad.verify()).passed).toBe(true);
    expect(bad.sim.starts).toBe(2);
  }, 90_000);

  it('only stands for playtests: an Edit check is cheap and runs both times', async () => {
    const edit: VerificationMethod = { kind: 'luau_assert', name: 'map_ready', luau: "return 'PASS'", datamodel: 'edit' };
    const { sim, rehearse, verify } = await setup([edit, PLAY]);
    await rehearse();
    const before = sim.luau('Edit').filter((c) => c.code.includes("return 'PASS'")).length;
    const report = await verify();
    expect(report.passed, report.summary).toBe(true);
    expect(sim.starts).toBe(1);
    expect(sim.luau('Edit').filter((c) => c.code.includes("return 'PASS'")).length).toBe(before + 1);
    expect(report.results.find((r) => r.name === 'map_ready')!.output).not.toMatch(/not played again/);
  });
});
