import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { VerificationMethod } from '../src/shared/domain';
import { PLAY_POLL, SHOT_RETRY } from '../src/core/roblox/studio-adapter';
import { TestService } from '../src/core/verification/test-service';
import { MEMORY_NOT_JUDGED, VERIFY_CLOCK, type VerificationReport } from '../src/core/verification/verifier';
import { coreHarness } from './helpers/make-core';
import { attachSim, fakePicture, type StudioSim } from './helpers/studio-sim';

/**
 * The final regression suite of the user's 8-hour build: 36 playtest checks, one at a time, 30 minutes with
 * nobody else working. Their durations in the run's log: a check took its own play time plus 7-10 s, and plus
 * 60-90 s whenever a screenshot nobody would look at timed out (the display was off): full_loop_smoke 151 s for
 * 60 s of play, audio_no_errors 122 s for 40, Quick playtest 80 s for 10.
 *
 * Measured here against a Studio stand-in whose timings are the log's, at 1:SCALE: a start settles 3.5 s after
 * it is asked for, a stop 2.5 s, a Luau call takes 70 ms, a capture 0.8 s when Studio draws and never answers
 * when it doesn't. Before the change (release 1.9, measured with this same test): 10.2 s per check beyond its own
 * play time with Studio drawing, 28.0 s with the display off, one play session and one capture per check.
 */
const makeCore = coreHarness();
const SCALE = 25;
const ms = (seconds: number) => Math.round((seconds * 1000) / SCALE);

const saved = { clock: { ...VERIFY_CLOCK }, shot: { ...SHOT_RETRY }, poll: { ...PLAY_POLL } };
beforeEach(() => {
  VERIFY_CLOCK.secondMs = ms(1);
  Object.assign(SHOT_RETRY, { delayMs: ms(3), timeoutMs: ms(15), firstTimeoutMs: ms(45), pauseMs: ms(120), quickTimeoutMs: ms(10) });
  // The poll keeps its real proportion to the transitions it watches.
  PLAY_POLL.ms = Math.max(1, Math.round(saved.poll.ms / SCALE));
});
afterEach(() => {
  Object.assign(VERIFY_CLOCK, saved.clock);
  Object.assign(SHOT_RETRY, saved.shot);
  Object.assign(PLAY_POLL, saved.poll);
});

const probe = (name: string, durationSec: number): VerificationMethod => ({ kind: 'playtest', name, durationSec, luau: `-- ${name}\nreturn "PASS"`, failOnConsoleErrors: true });
const watch = (name: string, durationSec: number): VerificationMethod => ({ kind: 'playtest', name, durationSec, failOnConsoleErrors: true });
const perf = (name: string, durationSec: number, extra: Partial<Extract<VerificationMethod, { kind: 'perf' }>> = {}): VerificationMethod => ({ kind: 'perf', name, durationSec, maxHeartbeatMs: 16, ...extra });
const nameOf = (m: VerificationMethod) => ('name' in m ? m.name : m.kind);

/** The suite's shape in the log: 20 checks with a probe, the ones that only watch the output, perf budgets. */
const PROBES = [20, 20, 25, 25, 25, 25, 25, 30, 30, 30, 40, 40, 60, 60, 4, 20, 25, 25, 30, 20].map((d, i) => probe(`probe_${i + 1}`, d));
const WATCHERS = [watch('quick_playtest', 10), watch('no_anim_load_error', 15), watch('audio_mix_caps', 30), watch('vfx_readability', 40), perf('atmosphere_perf', 20), perf('vfx_perf', 30), perf('six_mech_fight', 60)];
const SUITE: VerificationMethod[] = [...PROBES, ...WATCHERS];
const seconds = (list: VerificationMethod[]) => list.reduce((n, m) => n + ('durationSec' in m ? (m.durationSec ?? 0) : 0), 0);
const PLAY_SECONDS = seconds(SUITE);

const STATS = '{"heartbeatMs":7.5,"physicsStepMs":2,"memoryMb":4100,"instances":900}';

async function suite(drawing: boolean, checks: VerificationMethod[] = SUITE) {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const sim = attachSim(h.core);
  sim.delays = { start: ms(0.3), stop: ms(0.3), luau: ms(0.07), shot: ms(0.8) };
  sim.settle = { start: ms(3.5), stop: ms(2.5) };
  sim.shot = drawing ? fakePicture() : null;
  sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : code.includes('GetTotalMemoryUsageMb') ? STATS : 'PASS');
  const tests = new TestService(h.ctx.store);
  for (const m of checks) tests.register({ name: nameOf(m), method: m, taskId: null });
  return { ...h, sim, tests };
}

/** Seconds of the real clock the suite would take, and the same per check beyond its own play time. */
async function timed(sim: StudioSim, tests: TestService, run: () => Promise<VerificationReport>) {
  const t0 = Date.now();
  const report = await run();
  const total = ((Date.now() - t0) * SCALE) / 1000;
  // The checks with a probe keep a session each: what one of them costs beyond its play time.
  const own = tests.list().filter((t) => PROBES.some((p) => nameOf(p) === t.name));
  const ownSeconds = own.reduce((n, t) => n + ((tests.results(t.id, 1)[0]?.durationMs ?? 0) * SCALE) / 1000, 0);
  return { report, total, overhead: (total - PLAY_SECONDS) / SUITE.length, probeOverhead: (ownSeconds - seconds(PROBES)) / PROBES.length, sessions: sim.starts, captures: sim.captures };
}

/** The measurement, where a person can read it: the test output, and a file when REGRESSION_SPEED_OUT names one. */
function note(line: string): void {
  console.log(line);
  if (process.env.REGRESSION_SPEED_OUT) appendFileSync(process.env.REGRESSION_SPEED_OUT, `${line}\n`);
}
const line = (label: string, t: Awaited<ReturnType<typeof timed>>) =>
  `[regression-speed] ${label}: ${t.total.toFixed(0)} s for ${SUITE.length} checks (${PLAY_SECONDS} s of play asked for), ${t.overhead.toFixed(1)} s per check beyond its play time (${t.probeOverhead.toFixed(1)} s for a check with a probe), ${t.sessions} play sessions, ${t.captures} captures, poll ${saved.poll.ms} ms`;

const verdicts = (r: VerificationReport) => Object.fromEntries(r.results.map((x) => [x.name, x.passed]));
const allPass = Object.fromEntries(SUITE.map((m) => [nameOf(m), true]));
const output = (r: VerificationReport, name: string) => r.results.find((x) => x.name === name)!.output;

describe('the regression suite: what a check costs beyond its own play time', () => {
  it('with Studio drawing: a session per check with a probe, one for all that only watch, no pictures nobody looks at', async () => {
    const { core, ctx, sim, tests } = await suite(true);
    const t = await timed(sim, tests, () => core.verifier.regression(ctx, null));
    note(line('drawing', t));
    expect(verdicts(t.report)).toEqual(allPass);
    // What the time went on before: a session and a capture per check (27 and 27). Wall-clock figures are noted, not
    // asserted: under a loaded test run they say more about the machine than about the suite.
    expect(t.sessions).toBe(PROBES.length + 1);
    expect(t.captures).toBe(0);
  }, 240_000);

  it('with the display off: the same, where a capture used to time out every two minutes', async () => {
    const { core, ctx, sim, tests } = await suite(false);
    const t = await timed(sim, tests, () => core.verifier.regression(ctx, null));
    note(line('not drawing', t));
    expect(verdicts(t.report)).toEqual(allPass);
    expect(t.sessions).toBe(PROBES.length + 1);
    expect(t.captures).toBe(0);
  }, 240_000);
});

describe('one play session for the checks that only watch', () => {
  it('gives each the result and the text its own session would give', async () => {
    const shared = await suite(true, WATCHERS);
    const together = await shared.core.verifier.regression(shared.ctx, null);
    expect(shared.sim.starts).toBe(1);
    // Each perf budget is measured once, at its own mark.
    expect(shared.sim.luau('Server').filter((c) => c.code.includes('GetTotalMemoryUsageMb'))).toHaveLength(3);
    for (const m of WATCHERS) {
      const alone = await suite(true, [m]);
      const single = await alone.core.verifier.regression(alone.ctx, null);
      expect(alone.sim.starts).toBe(1);
      expect(output(together, nameOf(m)), nameOf(m)).toBe(output(single, nameOf(m)));
      expect(verdicts(together)[nameOf(m)]).toBe(verdicts(single)[nameOf(m)]);
    }
    expect(output(together, 'quick_playtest')).toBe('Playtest 10s: PASS\nNo runtime errors (LogService history checked on Server and Client).');
    expect(output(together, 'six_mech_fight')).toBe(`Within budget — ${STATS}`);
  }, 120_000);

  it('decides nothing about the output when an error was logged: those checks run in a session of their own, as before', async () => {
    const { core, ctx, sim } = await suite(true, [watch('short', 5), watch('long', 30), perf('budget', 10, { maxHeartbeatMs: 5, maxMemoryMb: 1500 })]);
    // The game logs an error 20 s in: a 5 s watch never sees it, a 30 s one does.
    const born = new Map<number, number>();
    sim.answer = (code) => {
      if (code.includes('GetTotalMemoryUsageMb')) return STATS;
      if (!code.includes('GetLogHistory')) return 'PASS';
      const age = (Date.now() - (born.get(sim.starts) ?? Date.now())) / VERIFY_CLOCK.secondMs;
      return JSON.stringify({ ok: true, errors: age >= 20 ? ['ServerScriptService.Round:12: attempt to index nil with "Parent"'] : [] });
    };
    sim.before = (tool, args) => {
      if (tool === 'start_stop_play' && args.is_start === true) born.set(sim.starts + 1, Date.now());
    };
    const report = await core.verifier.regression(ctx, null);
    expect(verdicts(report)).toEqual({ short: true, long: false, budget: false });
    expect(output(report, 'short')).toBe('Playtest 5s: PASS\nNo runtime errors (LogService history checked on Server and Client).');
    expect(output(report, 'long')).toMatch(/^Playtest 30s: FAIL\nRuntime errors \(LogService history\) \(2\):\n\[Server\] ServerScriptService\.Round:12/);
    // The perf budget doesn't look at the output: its measurement from the shared session stands.
    expect(output(report, 'budget')).toBe(`Over budget: heartbeat 7.50 ms > 5 — ${STATS}\n${MEMORY_NOT_JUDGED} (maxMemoryMb 1500 ignored).`);
    // The shared session, then one each for the two that watch the output.
    expect(sim.starts).toBe(3);
  }, 120_000);

  it('is not used for one such check, never for a check with a probe, and identical checks still run once', async () => {
    const one = await suite(true, [watch('only', 5), probe('p1', 4), probe('p2', 4)]);
    await one.core.verifier.regression(one.ctx, null);
    expect(one.sim.starts).toBe(3);
    const twins = await suite(true, [watch('a', 5), { ...watch('b', 5) }, watch('c', 8), perf('d', 6), perf('e', 6)]);
    const report = await twins.core.verifier.regression(twins.ctx, null);
    expect(twins.sim.starts).toBe(1);
    expect(twins.sim.luau('Server').filter((c) => c.code.includes('GetTotalMemoryUsageMb'))).toHaveLength(1);
    expect(report.results.map((r) => r.name).sort()).toEqual(['a', 'c', 'd']);
    expect(twins.tests.list().map((t) => t.lastStatus)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
  }, 120_000);

  it('stops with the suite when the team is stopped', async () => {
    const { core, ctx, sim } = await suite(true, [watch('a', 20), watch('b', 60), probe('p', 5)]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms(30));
    const report = await core.verifier.regression(ctx, null, { signal: ctrl.signal });
    expect(report.aborted).toBe(true);
    expect(report.results).toEqual([]);
    expect(sim.mode).toBe('Edit');
    expect(core.lease.holder).toBeNull();
  }, 120_000);
});

describe('a recorded playtest takes one quick picture', () => {
  it('for the critic when Studio draws, and gives up after one short try when it does not', async () => {
    const h = await suite(false, []);
    const task = h.ctx.tasks.create({ kind: 'implement', title: 'Round loop', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification: [probe('round_runs', 4)] });
    const t0 = Date.now();
    const report = await h.core.verifier.verify(h.ctx, h.ctx.tasks.get(task.id)!, null);
    const took = ((Date.now() - t0) * SCALE) / 1000;
    expect(report.passed, report.summary).toBe(true);
    expect(h.sim.captures).toBe(1);
    // 4 s of play, Studio's start and stop, one 10 s try: not the 45 + 3 + 15 s of a capture and its retry.
    expect(took).toBeLessThan(4 + 8 + 10 + 8);
    h.sim.shot = fakePicture();
    (h.core.studio as unknown as { shotsPausedUntil: number }).shotsPausedUntil = 0;
    await h.core.verifier.verify(h.ctx, h.ctx.tasks.get(task.id)!, null);
    const shots = h.ctx.tasks.evidence(task.id).filter((e) => e.title === 'Playtest: round_runs');
    expect(shots.map((e) => !!e.path)).toEqual([false, true]);
  }, 120_000);
});
