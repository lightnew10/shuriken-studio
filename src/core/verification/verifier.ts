import { runAgentLuau, ScreenshotUnavailableError, STUDIO_GONE, STUDIO_NOT_DRAWING } from '../roblox/studio-adapter';
import { detachStudioCaller } from '../roblox/studio-context';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode, Task, TaskEvidence, TestCase, VerificationMethod } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import { filesInFlight, planSync, type CodeSync } from '../roblox/code-sync';
import type { LuauToolchain } from '../roblox/luau-toolchain';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { extFor } from '../util/mime';
import { TestService, checkName, testName } from './test-service';
import { compileProblems } from './compile-limits';
import { scriptLabel } from '@shared/plain-words';
import type { Mutex } from '../util/mutex';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { OpenCloudLuau } from '../roblox/open-cloud-luau';

export interface MethodResult {
  kind: VerificationMethod['kind'];
  name: string;
  /** null = not automatically decidable (skipped or needs a human/critic). */
  passed: boolean | null;
  output: string;
  evidenceId: string | null;
  /** Regression runs: the registered tests this result stands for (identical checks run once and share it). */
  testIds?: string[];
}

export interface VerificationReport {
  passed: boolean;
  results: MethodResult[];
  summary: string;
  /** The run was cut short (the user stopped the team): the results are partial and must not be acted on. */
  aborted?: boolean;
}

/**
 * Fallback console heuristics (Studio's console text has no message types): runtime error shapes only,
 * never the bare word "error", which appears in harmless prints.
 */
const ERROR_LINE = /(^[\w.]+:\d+: |Stack Begin|attempt to (index|call|perform|compare|concatenate)|is not a valid member|Infinite yield possible|Requested module experienced an error|Error while loading|^Script '[^']+', Line \d+)/i;
/**
 * Not the game's scripts failing: assets Roblox couldn't deliver to a local place (a sound, or an avatar's
 * own animation — "Failed to load animation with sanitized ID rbxassetid://…" appears in every playtest
 * of an unpublished place for some avatars), plugins and Studio API limits. They never fail a check;
 * the asset ones are listed under the result so they stay visible.
 */
export const IGNORE_LINE = /(Failed to load sound|Failed to load animation|Animation failed to load|HTTP 4\d\d|Plugin|DataStoreService: .*StudioAccessToApisNotAllowed|Moon Animator)/i;
const ASSET_NOISE = /(Failed to load sound|Failed to load animation|Animation failed to load)/i;

/** What a perf check with a memory budget says once: the budget is not applied in Studio. */
export const MEMORY_NOT_JUDGED = "Memory is reported for information and never fails the check: in Studio it is the whole Studio process, not the game's own use";

/** How long a second of a playtest check's play time lasts, and how long a verification waits for a Studio that closed to be reopened. An object so a test can shorten it. */
export const VERIFY_CLOCK = { secondMs: 1000, studioBackMs: 12 * 60_000 };

/**
 * A playtest check that just passed in its worker's rehearsal (task_run_checks) counts for the verification
 * that follows, when the task's files are as they were and it is no older than this. Studio has one play mode:
 * in a 12-agent build it started 91 playtests in half an hour, 42 of them the agents' own calls, and most of the
 * rest were each task's checks run twice, minutes apart, with agents waiting three to five minutes in line.
 */
export const REHEARSAL_REUSE = { maxAgeMs: 10 * 60_000 };
/*
 * 10 minutes since 1.13.8 (was 4): what keeps a reused pass honest is that the task's files are the same, and in a busy
 * line the verification often came 4 to 5 minutes after the worker's run (the median in one build was 4.7 min). A
 * worker that runs its checks again without changing anything gets its own passes back too.
 */

/** How long a check holds Studio, roughly (for the line, which goes shortest first: LINE_ORDER). */
export function checkTurnMs(m: VerificationMethod): number {
  if (m.kind === 'playtest') return playSeconds(m.durationSec) * 1000 + 8000;
  if (m.kind === 'perf') return playSeconds(m.durationSec ?? 5) * 1000 + 8000;
  if (m.kind === 'luau_assert') return m.datamodel === 'server' || m.datamodel === 'client' ? 12_000 : 2000;
  if (m.kind === 'screenshot') return 4000;
  return 0;
}

/** A check that needs a playtest of its own (the costly kind: Studio's one play mode). */
export const playsStudio = (m: VerificationMethod): boolean => m.kind === 'playtest' || m.kind === 'perf' || (m.kind === 'luau_assert' && (m.datamodel === 'server' || m.datamodel === 'client'));

/** How long a playtest check plays: its durationSec, at least 2 s and at most 2 minutes. */
const playSeconds = (durationSec: number): number => Math.max(2, Math.min(120, durationSec));

/** What a perf check measures on the server: it reads the Stats service and counts instances, and changes nothing. */
const PERF_PROBE = `
local Stats = game:GetService("Stats")
local n = 0
for _ in ipairs(game:GetDescendants()) do n += 1 end
local function try(fn) local ok, v = pcall(fn) return ok and v or nil end
return game:GetService("HttpService"):JSONEncode({
  heartbeatMs = try(function() return Stats.HeartbeatTimeMs end),
  physicsStepMs = try(function() return Stats.PhysicsStepTimeMs end),
  memoryMb = try(function() return Stats:GetTotalMemoryUsageMb() end),
  instances = n,
})`;

type PerfMethod = Extract<VerificationMethod, { kind: 'perf' }>;
type PlaytestMethod = Extract<VerificationMethod, { kind: 'playtest' }>;
/** A check that only watches a playing game: a playtest without a probe, or a perf budget (its probe only reads). */
type Watcher = PerfMethod | PlaytestMethod;
const isWatcher = (m: VerificationMethod): m is Watcher => m.kind === 'perf' || (m.kind === 'playtest' && !m.luau && !m.clientLuau);

/** A perf check's verdict from what its probe returned (`jsonText` null: it could not be measured; `failText` says why). */
export function judgePerf(m: PerfMethod, jsonText: string | null, failText: string): { passed: boolean; output: string; stats: { heartbeatMs?: number; physicsStepMs?: number; memoryMb?: number; instances?: number } } {
  let stats: { heartbeatMs?: number; physicsStepMs?: number; memoryMb?: number; instances?: number } = {};
  try {
    const parsed: unknown = jsonText ? JSON.parse(jsonText) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      for (const key of ['heartbeatMs', 'physicsStepMs', 'memoryMb', 'instances'] as const) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (key !== 'instances' || Number.isInteger(value))) stats[key] = value;
      }
    }
  } catch { /* Unparseable output has no usable measurements. */ }
  const over: string[] = [];
  if (m.maxHeartbeatMs !== undefined && (stats.heartbeatMs ?? 0) > m.maxHeartbeatMs) over.push(`heartbeat ${stats.heartbeatMs?.toFixed(2)} ms > ${m.maxHeartbeatMs}`);
  if (m.maxPhysicsStepMs !== undefined && (stats.physicsStepMs ?? 0) > m.maxPhysicsStepMs) over.push(`physics step ${stats.physicsStepMs?.toFixed(2)} ms > ${m.maxPhysicsStepMs}`);
  if (m.maxInstances !== undefined && (stats.instances ?? 0) > m.maxInstances) over.push(`instances ${stats.instances} > ${m.maxInstances}`);
  const required = [m.maxHeartbeatMs !== undefined ? 'heartbeatMs' : null, m.maxPhysicsStepMs !== undefined ? 'physicsStepMs' : null, m.maxInstances !== undefined ? 'instances' : null].filter(Boolean) as Array<keyof typeof stats>;
  const measured = jsonText !== null && required.length > 0 && required.every((key) => stats[key] !== undefined);
  const passed = measured && over.length === 0;
  const memory = m.maxMemoryMb !== undefined ? `\n${MEMORY_NOT_JUDGED} (maxMemoryMb ${m.maxMemoryMb} ignored).` : '';
  const output = measured ? `${passed ? 'Within budget' : `Over budget: ${over.join('; ')}`} — ${JSON.stringify(stats)}${memory}` : `Could not verify performance: ${required.length ? 'required metrics missing or invalid' : 'no supported performance threshold supplied'}. ${failText.slice(0, 400)}`.trimEnd();
  return { passed, output, stats };
}

/** The text of a playtest check's result. */
function playtestText(durationSec: number, passed: boolean, serverProbe: string | null, clientProbe: string | null, typedHistory: boolean, errorLines: string[], assetNoise: ReadonlySet<string>): string {
  return [
    `Playtest ${durationSec}s: ${passed ? 'PASS' : 'FAIL'}`,
    serverProbe !== null ? `Server probe: ${serverProbe}` : '',
    clientProbe !== null ? `Client probe: ${clientProbe}` : '',
    errorLines.length
      ? `${typedHistory ? 'Runtime errors (LogService history)' : 'Console errors (text heuristics)'} (${errorLines.length}):\n${errorLines.join('\n')}`
      : `No runtime errors${typedHistory ? ' (LogService history checked on Server and Client)' : ''}.`,
    assetNoise.size ? `Not counted (assets Roblox couldn't load here, not script errors): ${[...assetNoise].slice(0, 3).join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** What a rehearsal (task_run_checks) says about the checks it does not run. */
const NOT_REHEARSED = {
  screenshot: 'Not run here: the critic looks at this picture during review. Take it yourself with roblox_screenshot (the same camera and look_at) to see what the critic will see.',
  manual: 'Not run here: this check is put to a person (or stands for the critic) at verification.',
  cloud_luau: "Not run here: Open Cloud's hourly quota is kept for the verification itself.",
} as const;

/** Reads typed log history inside a play DataModel: exact MessageError entries, no text guessing. */
export const LUAU_LOG_ERRORS = `
local LogService = game:GetService("LogService")
local out = {}
local ok, hist = pcall(function() return LogService:GetLogHistory() end)
if ok then
  for _, e in ipairs(hist) do
    if e.messageType == Enum.MessageType.MessageError then table.insert(out, e.message) end
  end
end
return game:GetService("HttpService"):JSONEncode({ ok = ok, errors = out })`;

export interface VerifierDeps {
  studio: RobloxStudioAdapter;
  sync: CodeSync;
  luau: LuauToolchain;
  studioLock: Mutex;
  lease: PlaytestLease;
  cloud: OpenCloudLuau;
  log: ScopedLogger;
  /** The permission mode of a project; absent = 'ask'. In autonomous mode a manual check is not put to the user. */
  permissionMode?: (project: ProjectContext) => PermissionMode;
}

/**
 * Deterministic verification (everything except the critic): static analysis, code sync into
 * Studio, Luau assertions, playtests with console capture, screenshots. Every result becomes task
 * evidence and a permanent test result.
 */
/** How a regression suite runs: stopped by `signal`, only `taskIds`' checks, without static analysis, and who hears how far it is. */
export interface RegressionOptions {
  signal?: AbortSignal;
  taskIds?: ReadonlySet<string>;
  skipStatic?: boolean;
  /** Before each check (and once Studio is its turn): the final review shows as an agent while it runs. */
  onProgress?: (p: { check: string | null; done: number; total: number; studio: boolean }) => void;
}

export class Verifier {
  constructor(private readonly deps: VerifierDeps) {}

  /**
   * Studio has one DataModel per window: while anyone plays, Edit-mode work (code sync, Edit asserts,
   * snapshots) is rejected. A verification that touches Studio therefore owns it for its whole Studio
   * phase: the process-wide mutex plus the play-mode lease (which also keeps agents' playtests out).
   */
  private async withStudio<T>(owner: string, needed: boolean, fn: () => Promise<T>, signal?: AbortSignal, estimateMs?: number, editOnly = false): Promise<T> {
    if (!needed) return fn();
    // Checks that only sync code and assert in Edit go on during someone else's playtest when the plugin's Edit
    // instance is linked, like any agent's Edit work: a run of them waited up to 8 minutes behind every playtest in line.
    if (editOnly && this.deps.studio.editInPlay) return detachStudioCaller(() => this.deps.studioLock.run(fn));
    // It holds Studio on its own account (the lease below): never as a tool call of whoever started it.
    return detachStudioCaller(() => this.deps.studioLock.run(async () => {
      if (!(await this.deps.lease.acquire(owner, 10 * 60 * 1000, signal, estimateMs))) {
        throw new Error(signal?.aborted ? 'Stopped waiting for Studio: the call was cancelled.' : `Could not get exclusive use of Studio within 10 minutes (play mode held by ${this.deps.lease.holder?.owner ?? 'unknown'})`);
      }
      try {
        // Leave any leftover play session (e.g. from a crashed run) before Edit-mode work.
        const st = await this.deps.studio.state().catch(() => null);
        if (st && !st.availableDataModels.includes('Edit')) await this.deps.studio.setPlaying(false).catch(() => {});
        return await fn();
      } finally {
        this.deps.lease.release(owner);
      }
    }));
  }

  /**
   * Between two checks of a run that holds Studio, the screenshots that wait draw (PlaytestLease.yieldToShots), and
   * the run goes on with Studio its own again.
   */
  private async letShotsIn(owner: string, signal?: AbortSignal): Promise<void> {
    const lease = this.deps.lease;
    if (!lease.shotWaiting || !lease.isOwnedBy(owner)) return;
    if (await lease.yieldToShots(owner)) return;
    if (!(await lease.acquire(owner, 10 * 60 * 1000, signal))) throw new Error('Studio was not given back after the screenshots that waited were taken');
  }

  /**
   * @param scopeFiles project-relative files this task changed. When given, static-analysis problems in
   *   other files (e.g. a parallel task's half-written code) are reported but do not fail this task;
   *   the regression suite at objective completion still requires the whole project to be clean.
   * @param alsoCheck files the task's agent says it changed beyond `scopeFiles`: their analysis and compile errors fail
   *   the task too (they don't change which files the rehearsal's stamp covers).
   */
  async verify(project: ProjectContext, task: Task, runId: string | null, scopeFiles?: string[], signal?: AbortSignal, alsoCheck: string[] = []): Promise<VerificationReport> {
    return this.overCrash(
      // A stop (the user's, or the usage limit's stand-down) ends the checks between two of them and any wait in line.
      () => this.runTaskChecks(project, task, runId, scopeFiles, { record: true, signal, alsoCheck }),
      () => this.evidence(project, task, runId, { kind: 'note', title: 'Roblox Studio closed during the verification; it was reopened and the checks were run again (their earlier results in this verification do not count)', passed: null, data: { environment: 'studio_closed' }, path: null }),
    );
  }

  /**
   * Runs a verification, and runs it once more when Studio closed under it (a crash) and came back: what the checks
   * found against a Studio that was gone says nothing about the work. A reopen already under way is waited for first.
   */
  private async overCrash(run: () => Promise<VerificationReport>, rerun?: () => void): Promise<VerificationReport> {
    const studio = this.deps.studio;
    if (studio.reopening) await studio.waitUntilBack(VERIFY_CLOCK.studioBackMs);
    const first = await run();
    if (first.passed || first.aborted) return first;
    const gone = !!studio.reopening || first.results.some((r) => r.passed === false && STUDIO_GONE.test(r.output));
    // Have it looked at now (the reopen, if one starts, is over when this settles), within what a reopen may take.
    const look = gone ? (studio.onGone?.() ?? studio.reopening?.done) : null;
    if (!look) return first;
    const back = await Promise.race([look.catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), VERIFY_CLOCK.studioBackMs))]);
    if (!back) return first;
    rerun?.();
    return run();
  }

  /**
   * The task's automated checks, run now for its own worker (the tool task_run_checks) exactly as verification
   * will run them: the same code sync, the same probes in the same DataModels, the same result text. Nothing is
   * recorded (no evidence, no test results, no tests registered), nobody is asked anything, and the checks only a
   * reviewer can judge (a screenshot, a manual check) or that spend a limited quota (Open Cloud) are named, not run.
   */
  async rehearse(project: ProjectContext, task: Task, runId: string | null, scopeFiles?: string[], signal?: AbortSignal): Promise<VerificationReport> {
    return this.runTaskChecks(project, task, runId, scopeFiles, { record: false, signal });
  }

  /** What each task's last rehearsal found for its playtest checks, and the state of its files then. */
  private readonly rehearsed = new Map<string, { at: number; stamp: string; passed: Map<string, MethodResult> }>();

  /**
   * The state of the code a task's checks depend on: its own files (time and size) when it has a scope, else
   * every script of the game (their hashes). Equal stamps: nothing the task wrote changed in between.
   */
  private codeStamp(project: ProjectContext, scope: Set<string> | null): string {
    if (scope) {
      return [...scope]
        .sort()
        .map((f) => {
          try {
            const st = statSync(join(project.root, f));
            return `${f}:${st.mtimeMs}:${st.size}`;
          } catch {
            return `${f}:gone`;
          }
        })
        .join('|');
    }
    try {
      return planSync(project.root, project.extras().syncMap).map((e) => `${e.file}:${e.hash}`).join('|');
    } catch {
      return `unknown:${Date.now()}`;
    }
  }

  private async runTaskChecks(project: ProjectContext, task: Task, runId: string | null, scopeFiles: string[] | undefined, opts: { record: boolean; signal?: AbortSignal; alsoCheck?: string[] }): Promise<VerificationReport> {
    const { record } = opts;
    const scope = scopeFiles && scopeFiles.length ? new Set(scopeFiles.map(normPath)) : null;
    // A rehearsal that just passed stands for the same playtest checks now (see REHEARSAL_REUSE).
    const stamp = this.codeStamp(project, scope);
    const earlier = this.rehearsed.get(task.id);
    const reusable = earlier && earlier.stamp === stamp && Date.now() - earlier.at <= REHEARSAL_REUSE.maxAgeMs ? earlier : null;
    if (record) this.rehearsed.delete(task.id);
    const rehearsedNow = new Map<string, MethodResult>();
    /** Whether a check was taken from an earlier run (whose record then stays as it was: its passes keep their own age). */
    let reusedAny = false;
    const tests = new TestService(project.store);
    const results: MethodResult[] = [];
    const own = task.verification.filter((m) => m.kind !== 'critic');
    // What the static analysis answers for: the task's files and the ones its agent says it changed. A task that changed
    // Luau files passes only when they compile, whatever checks it was given (a side task the director made has only the
    // critic): the static analysis of its own files runs anyway.
    const checkFiles = [...new Set([...(scopeFiles ?? []), ...(opts.alsoCheck ?? [])])];
    const checkScope = checkFiles.length ? new Set(checkFiles.map(normPath)) : null;
    const touchesLuau = checkFiles.some((f) => /\.(?:luau|lua)$/i.test(f));
    const methods: VerificationMethod[] = touchesLuau && !own.some((m) => m.kind === 'static_analysis') ? [{ kind: 'static_analysis' }, ...own] : own;
    const reused = (m: VerificationMethod): MethodResult | null => (reusable && playsStudio(m) ? (reusable.passed.get(JSON.stringify(m)) ?? null) : null);
    // Studio is needed for what is not taken from the rehearsal.
    const needsStudio = methods.some((m) => ((m.kind === 'luau_assert' || m.kind === 'playtest' || m.kind === 'perf') && !reused(m)) || (record && m.kind === 'screenshot'));
    const extras = project.extras();
    // How long this run will hold Studio: what it plays (not what it takes from an earlier run), and the code sync.
    const turnMs = 5000 + methods.filter((m) => !reused(m) && (record || m.kind !== 'screenshot')).reduce((n, m) => n + checkTurnMs(m), 0);
    // Nothing here plays or takes a picture: Edit work, which needs no turn of play mode.
    const editOnly = !methods.some((m) => (playsStudio(m) && !reused(m)) || (record && m.kind === 'screenshot'));

    try {
      await this.withStudio(`verifier:${task.id}`, needsStudio, async () => {
        if (needsStudio && extras.syncMode === 'shuriken') {
          const r = await this.syncCode(project, record ? task : null, runId, `verifier:${task.id}`, scope);
          results.push(r);
          if (r.passed === false) return;
        }
        for (const original of methods) {
          if (opts.signal?.aborted) break;
          // A check the team retired is skipped (with a note the critic sees); one that stands for a registered
          // test (a repair task) runs that test's current spec, not the copy it was created with.
          const { method: m, test, skip } = resolveCheck(tests, task, original, !record);
          if (skip) {
            const ev = record ? project.tasks.addEvidence({ taskId: task.id, runId, kind: 'note', title: `Check "${checkName(original)}" skipped: ${skip}`, passed: null, data: { check: checkName(original), testId: test?.id ?? null, reason: skip }, path: null }) : null;
            results.push({ kind: original.kind, name: checkName(original), passed: null, output: `Skipped: ${skip}`, evidenceId: ev?.id ?? null });
            continue;
          }
          if (!record && (m.kind === 'screenshot' || m.kind === 'manual' || m.kind === 'cloud_luau')) {
            results.push({ kind: m.kind, name: checkName(m), passed: null, output: NOT_REHEARSED[m.kind], evidenceId: null });
            continue;
          }
          const t0 = Date.now();
          let res: MethodResult;
          const before = reused(m);
          if (before) {
            // Passed in the worker's rehearsal a moment ago, on the same files: not played again.
            const age = Math.round((Date.now() - reusable!.at) / 1000);
            const output = record
              ? `${before.output}\n(This check passed ${age} s ago in the worker's own run of the task's checks, and the task's files have not changed since: it was not played again.)`
              : `${before.output}\n(This check passed ${age} s ago when you ran these checks, and the task's files have not changed since: it was not played again. Change something and run them again to play it again.)`;
            res = { kind: before.kind, name: before.name, passed: true, output, evidenceId: record ? this.evidence(project, task, runId, { kind: 'test_result', title: `${before.kind === 'playtest' ? 'Playtest' : 'Check'}: ${before.name} (passed ${age} s ago in the worker's rehearsal, same files)`, passed: true, data: { output: before.output, rehearsedAt: new Date(reusable!.at).toISOString(), reused: true }, path: null }) : null };
            results.push(res);
            reusedAny = true;
            if (test) tests.recordResult({ testId: test.id, runId, taskId: task.id, status: 'pass', output: res.output, durationMs: 0 });
            continue;
          }
          // Screenshots that wait draw now, between this run's checks, instead of after the whole run.
          if (playsStudio(m) || (record && m.kind === 'screenshot')) await this.letShotsIn(`verifier:${task.id}`, opts.signal);
          try {
            res = await this.runMethod(project, task, runId, m, { regression: false, scope, files: checkFiles, checkScope, record });
            if (!record && res.passed === true && playsStudio(m)) rehearsedNow.set(JSON.stringify(m), res);
          } catch (e) {
            res = { kind: m.kind, name: checkName(m), passed: false, output: `Verifier error: ${errorMessage(e)}`, evidenceId: null };
            if (record) res.evidenceId = project.tasks.addEvidence({ taskId: task.id, runId, kind: 'test_result', title: `${res.name} (error)`, passed: false, data: { output: res.output }, path: null }).id;
          }
          results.push(res);
          if (record && test && res.passed !== null) {
            tests.recordResult({ testId: test.id, runId, taskId: task.id, status: res.passed ? 'pass' : 'fail', output: res.output, durationMs: Date.now() - t0 });
          }
        }
      }, opts.signal, turnMs, editOnly);
    } catch (e) {
      results.push({ kind: 'playtest', name: 'studio access', passed: false, output: errorMessage(e), evidenceId: null });
    }
    // A rehearsal's passes are kept for the verification that follows, with the files' state as it was BEFORE the
    // checks ran (a change made while they ran makes the stamp differ, and everything is played again).
    if (!record) {
      if (rehearsedNow.size && results.every((r) => r.passed !== false)) this.rehearsed.set(task.id, { at: Date.now(), stamp, passed: rehearsedNow });
      else if (!(reusedAny && !rehearsedNow.size && results.every((r) => r.passed !== false))) this.rehearsed.delete(task.id);
    }
    return this.finish(results);
  }

  /**
   * Re-run every enabled project test (regression suite). A signal that fires stops it between tests.
   * `taskIds` runs only the tests those tasks registered (a quick iteration's own checks; `skipStatic` leaves out
   * the project-wide static analysis, which belongs to the full suite). Tests of cancelled tasks never run: they
   * are retired first (older projects, or a verification that finished after its task was cancelled).
   */
  async regression(project: ProjectContext, runId: string | null, opts: RegressionOptions = {}): Promise<VerificationReport> {
    return this.overCrash(() => this.regressionOnce(project, runId, opts));
  }

  private async regressionOnce(project: ProjectContext, runId: string | null, opts: RegressionOptions): Promise<VerificationReport> {
    const tests = new TestService(project.store);
    const results: MethodResult[] = [];
    let aborted = false;
    const orphans = tests.retireOfCancelledTasks();
    if (orphans.length) {
      project.audit.event({
        kind: 'test.retired',
        title: `Retired ${orphans.length} regression test${orphans.length === 1 ? '' : 's'} of cancelled tasks (they cannot be satisfied by work that was dropped)`,
        role: 'system',
        detail: { tests: orphans.map((o) => ({ id: o.test.id, name: o.test.name, task: o.taskTitle })) },
      });
    }
    let enabled = tests.list().filter((t) => t.enabled);
    if (opts.taskIds) enabled = enabled.filter((t) => !!t.taskId && opts.taskIds!.has(t.taskId));
    if (opts.skipStatic) enabled = enabled.filter((t) => t.spec.kind !== 'static_analysis');
    const pseudoTask = (taskId: string | null): Task => ({ ...(project.tasks.get(taskId ?? '') ?? placeholderTask()), verification: [] });
    const needsStudio = enabled.some((t) => t.kind === 'luau' || t.kind === 'playtest' || t.spec.kind === 'screenshot');
    let done = 0;
    opts.onProgress?.({ check: null, done, total: enabled.length, studio: false });
    try {
      await this.withStudio('verifier:regression', needsStudio, async () => {
        if (needsStudio) opts.onProgress?.({ check: null, done, total: enabled.length, studio: true });
        if (needsStudio && project.extras().syncMode === 'shuriken') {
          const r = await this.syncCode(project, null, runId, 'verifier:regression');
          results.push(r);
          if (r.passed === false) return;
        }
        // Identical checks registered by several tasks (every task registers the project-wide static
        // analysis, for example) run once per suite; each registered test still gets its result.
        const cache = new Map<string, { result: MethodResult; owner: MethodResult }>();
        const keyOf = (m: VerificationMethod) => JSON.stringify({ ...m, name: undefined });
        // The checks that only watch the game (no probe of their own) share one play session, when there are several.
        const watchers = new Map<string, Watcher>();
        for (const t of enabled) if (isWatcher(t.spec) && !watchers.has(keyOf(t.spec))) watchers.set(keyOf(t.spec), t.spec);
        let watched: Map<string, MethodResult> | null = null;
        for (const t of enabled) {
          if (opts.signal?.aborted) {
            aborted = true;
            break;
          }
          opts.onProgress?.({ check: t.name, done: done++, total: enabled.length, studio: needsStudio });
          const t0 = Date.now();
          const key = keyOf(t.spec);
          let res: MethodResult;
          const hit = cache.get(key);
          if (hit) {
            res = { ...hit.result };
            // The shared result stands for every test with this check: the repair has to know all of them.
            hit.owner.testIds!.push(t.id);
          } else {
            if (!watched && watchers.size > 1 && watchers.has(key)) {
              watched = await this.watchSession([...watchers], opts.signal);
              if (opts.signal?.aborted) {
                aborted = true;
                break;
              }
            }
            const shared = watched?.get(key);
            if (!shared && (t.kind === 'luau' || t.kind === 'playtest')) await this.letShotsIn('verifier:regression', opts.signal);
            try {
              // What the shared session could not decide (an error in the output) runs in a session of its own.
              res = shared ? { ...shared } : await this.runMethod(project, pseudoTask(t.taskId), runId, t.spec, { regression: true, scope: null });
            } catch (e) {
              res = { kind: t.spec.kind, name: t.name, passed: false, output: errorMessage(e), evidenceId: null };
            }
            res.name = t.name;
            res.testIds = [t.id];
            cache.set(key, { result: { ...res }, owner: res });
          }
          res.name = t.name;
          if (!hit) results.push(res);
          if (res.passed !== null) tests.recordResult({ testId: t.id, runId, taskId: t.taskId, status: res.passed ? 'pass' : 'fail', output: res.output, durationMs: hit ? 0 : Date.now() - t0 });
        }
      });
    } catch (e) {
      results.push({ kind: 'playtest', name: 'studio access', passed: false, output: errorMessage(e), evidenceId: null });
    }
    return aborted || opts.signal?.aborted ? { ...this.finish(results), aborted: true } : this.finish(results);
  }

  private finish(results: MethodResult[]): VerificationReport {
    const failed = results.filter((r) => r.passed === false);
    const passed = failed.length === 0;
    const summary = passed
      ? `${results.filter((r) => r.passed).length} check(s) passed${results.some((r) => r.passed === null) ? `, ${results.filter((r) => r.passed === null).length} need review` : ''}`
      : `${failed.length} check(s) failed: ${failed.map((f) => `${f.name}: ${f.output.split('\n')[0]!.slice(0, 200)}`).join(' | ')}`;
    return { passed, results, summary };
  }

  private evidence(project: ProjectContext, task: Task | null, runId: string | null, input: Omit<TaskEvidence, 'id' | 'createdAt' | 'taskId' | 'runId'>): string | null {
    if (!task || !project.tasks.get(task.id)) return null;
    return project.tasks.addEvidence({ ...input, taskId: task.id, runId }).id;
  }

  /**
   * Pushes the code as the verification that holds Studio (`owner`): its push goes ahead of the agents' (see
   * CodeSync.push). Files other agents still running have edited stay out, by the rule of roblox_sync_push (a
   * check must not fail on someone else's half-written file); the result and the evidence name them.
   */
  private async syncCode(project: ProjectContext, task: Task | null, runId: string | null, owner: string, scope: Set<string> | null = null): Promise<MethodResult> {
    if (!this.deps.studio.connected) {
      return { kind: 'luau_assert', name: 'code sync', passed: false, output: 'Roblox Studio MCP is not connected; runtime verification impossible.', evidenceId: null };
    }
    const report = await this.deps.sync.push(project.root, project.extras().syncMap, { owner, skip: filesInFlight(project, runId) });
    const ok = report.errors.length === 0;
    const leftOut = report.skipped;
    const own = scope ? leftOut.filter((f) => scope.has(normPath(f))) : [];
    const left = leftOut.length
      ? `\nLeft out ${leftOut.length} file(s) other agents are still editing (Studio keeps the version last synced; their own sync brings them in): ${leftOut.slice(0, 20).join(', ')}${leftOut.length > 20 ? ', …' : ''}.${own.length ? ` ${own.length} of them ${own.length === 1 ? 'is' : 'are'} also this task's (${own.slice(0, 5).join(', ')}): the checks ran against the version last synced.` : ''}`
      : '';
    const output = ok
      ? `Synced: ${report.created.length} created, ${report.updated.length} updated, ${report.unchanged.length} unchanged${report.orphans.length ? `, ${report.orphans.length} orphan script(s) in Studio not on disk: ${report.orphans.slice(0, 10).join(', ')}` : ''}${left}`
      : `Sync errors: ${report.errors.map((e) => `${e.path}: ${e.error}`).join('; ').slice(0, 2000)}${left}`;
    const title = `Code sync into Studio${leftOut.length ? ` (${leftOut.length} file${leftOut.length === 1 ? '' : 's'} other agents are editing left out)` : ''}`;
    const evidenceId = this.evidence(project, task, runId, { kind: 'note', title, passed: ok, data: { ...report, leftOut }, path: null });
    return { kind: 'luau_assert', name: 'code sync', passed: ok, output, evidenceId };
  }

  /** Every script the project syncs (project-relative), for the regression suite's compile check. */
  private projectScripts(project: ProjectContext): string[] {
    try {
      return planSync(project.root, project.extras().syncMap).map((e) => e.file);
    } catch {
      return [];
    }
  }

  /** Runs one method. Studio-backed methods assume the caller holds the Studio session (withStudio). */
  private async runMethod(project: ProjectContext, task: Task, runId: string | null, m: VerificationMethod, opts: { regression: boolean; scope: Set<string> | null; files?: string[]; checkScope?: Set<string> | null; record?: boolean }): Promise<MethodResult> {
    const { regression } = opts;
    // A regression run and a worker's rehearsal leave no evidence on the task.
    const quiet = regression || opts.record === false;
    const name = 'name' in m && m.name ? m.name : m.kind;
    const ev = (input: Omit<TaskEvidence, 'id' | 'createdAt' | 'taskId' | 'runId'>) => (quiet ? null : this.evidence(project, task, runId, input));
    switch (m.kind) {
      case 'static_analysis': {
        const checked = await this.deps.luau.check(project.root, project.extras().syncMap, { paths: m.paths });
        const scope = regression ? null : (opts.checkScope ?? opts.scope);
        // What Studio's compiler refuses and the analyzers let through (too many locals in one function): the task's
        // own files, or every script in the regression suite (compile-limits.ts).
        const r = { ...checked, problems: [...checked.problems, ...compileProblems(project.root, regression ? this.projectScripts(project) : scope ? (opts.files ?? []) : [])] };
        // A task that edited no file itself (a sound designer working through its tools, a modeler) has no scope,
        // and answers for none: it used to answer for the whole project, failing on three errors in a script an
        // engineer was still writing, and (in the Pit build) on one in a finished client script nobody was
        // touching, three times. The project's errors are the regression suite's and their writer's.
        const mine = (p: (typeof r.problems)[number]) => (regression ? true : scope ? scope.has(normPath(p.file)) : false);
        const own = r.problems.filter(mine);
        const elsewhere = r.problems.filter((p) => !mine(p));
        const errors = own.filter((p) => p.severity === 'error');
        const passed = errors.length === 0 && r.toolErrors.filter((t) => !t.startsWith('No Luau')).length === 0;
        const fmt = (p: (typeof r.problems)[number]) => `${p.file}:${p.line}:${p.column} ${p.severity} ${p.tool}/${p.code}: ${p.message}`;
        const output = [
          // A file with errors is named first, in words: the status line and the repair brief start from this line.
          ...(errors.length ? [brokenLine(errors)] : []),
          `${own.length} problem(s), ${errors.length} error(s) in ${regression ? 'the project' : scope ? `this task's ${scope.size} file(s)` : 'this task (it changed no Luau file)'} · ${r.durationMs} ms`,
          ...own.slice(0, 40).map(fmt),
          ...(elsewhere.length ? [`${elsewhere.length} problem(s) in files outside this task (not blocking here; the regression suite requires them fixed):`, ...elsewhere.slice(0, 15).map(fmt)] : []),
          ...r.toolErrors,
        ].join('\n');
        return { kind: m.kind, name, passed, output, evidenceId: ev({ kind: 'static_analysis', title: 'Static analysis (selene + luau-lsp)', passed, data: { ...r, files: scope ? scope.size : regression ? null : 0 }, path: null }) };
      }
      case 'luau_assert': {
        const dm = m.datamodel === 'server' ? 'Server' : m.datamodel === 'client' ? 'Client' : 'Edit';
        if (dm !== 'Edit') {
          // Server/Client DataModels exist only during play: run the assertion inside a short leased playtest.
          const asPlaytest: Extract<VerificationMethod, { kind: 'playtest' }> = { kind: 'playtest', name, durationSec: 4, ...(dm === 'Client' ? { clientLuau: m.luau } : { luau: m.luau }), failOnConsoleErrors: false };
          return this.runMethod(project, task, runId, asPlaytest, opts);
        }
        const r = await runAgentLuau(this.deps.studio, this.deps.luau, m.luau, dm, 60000);
        const passed = r.ok && /^\s*PASS/i.test(r.output);
        const output = r.ok ? r.output : r.syntax ? `Luau syntax error, ${r.output}` : `Luau error: ${r.output}`;
        return { kind: m.kind, name, passed, output, evidenceId: ev({ kind: 'test_result', title: `Luau assert: ${name}`, passed, data: { luau: m.luau, output, datamodel: dm }, path: null }) };
      }
      case 'playtest':
        return this.playtest(project, task, runId, m, name, quiet);
      case 'perf': {
        // Measured on the Server during a short playtest; an exceeded heartbeat, physics or instance budget fails the
        // test. Memory never does: in Studio, Stats:GetTotalMemoryUsageMb is the whole Studio process (3.6-5.2 GB with
        // nothing of the game's running), not the game's own use, so the number is reported as information only.
        const res = await this.playtest(project, task, runId, { kind: 'playtest', name, durationSec: m.durationSec ?? 8, luau: PERF_PROBE, failOnConsoleErrors: false }, name, true);
        const { passed, output, stats } = judgePerf(m, /Server probe: (\{.*\})/s.exec(res.output)?.[1] ?? null, res.output);
        return { kind: m.kind, name, passed, output, evidenceId: ev({ kind: 'test_result', title: `Performance: ${name}`, passed, data: { stats, budget: m }, path: null }) };
      }
      case 'screenshot': {
        let shot: Awaited<ReturnType<typeof this.deps.studio.screenshot>>;
        try {
          shot = await this.deps.studio.screenshot({ camera: m.camera, lookAt: m.lookAt });
        } catch (e) {
          // No picture for reasons outside the work (display off, Studio minimized or covered): "can't check visually", an
          // environment condition. Not a failed check, and the critic is told so (the note evidence), never a rejection.
          if (e instanceof ScreenshotUnavailableError) {
            return {
              kind: m.kind,
              name,
              passed: null,
              output: `Skipped, can't check visually (environment, not a defect of the work): ${e.message}`,
              evidenceId: ev({ kind: 'note', title: `No screenshot possible: ${STUDIO_NOT_DRAWING} (can't check visually)`, passed: null, data: { environment: 'studio_not_drawing', instructions: m.instructions }, path: null }),
            };
          }
          throw e;
        }
        // No image at all is the same condition (a Studio that draws always returns one), never a failed check.
        if (!shot) return { kind: m.kind, name, passed: null, output: `Skipped, can't check visually (environment, not a defect of the work): ${STUDIO_NOT_DRAWING}; Studio returned no image.`, evidenceId: null };
        const file = join(project.dir, 'evidence', `${task.id}-${Date.now()}.${extFor(shot.mimeType)}`);
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return { kind: m.kind, name, passed: null, output: `Screenshot saved for review: ${m.instructions}`, evidenceId: ev({ kind: 'screenshot', title: `Screenshot: ${name}`, passed: null, data: { instructions: m.instructions }, path: file }) };
      }
      case 'cloud_luau': {
        const target = project.extras().cloud;
        if (!target.universeId || !target.placeId) return { kind: m.kind, name, passed: null, output: 'Skipped: no published place configured for Open Cloud', evidenceId: null };
        const r = await this.deps.cloud.run({ universeId: target.universeId, placeId: target.placeId, script: m.luau, timeoutSec: m.timeoutSec });
        if (r.state === 'NOT_CONFIGURED' || r.state === 'RATE_LIMITED') return { kind: m.kind, name, passed: null, output: `Skipped: ${r.error?.message}`, evidenceId: null };
        const first = r.results[0];
        const passed = r.ok && (first === true || (typeof first === 'string' && /^\s*PASS/i.test(first)));
        const output = [`${r.state} (${r.durationMs} ms) result=${JSON.stringify(first)}${r.error ? ` error=${r.error.code}: ${r.error.message}` : ''}`, ...r.logs.slice(-40)].join('\n');
        return { kind: m.kind, name, passed, output, evidenceId: ev({ kind: 'test_result', title: `Cloud Luau: ${name}`, passed, data: { results: r.results, logs: r.logs.slice(-200), error: r.error }, path: null }) };
      }
      case 'manual':
        if (!regression) {
          // Autonomous mode: nobody checks by hand; the automated checks and the critic stand in, and the record says so.
          if ((this.deps.permissionMode?.(project) ?? 'ask') === 'autonomous') project.governance.autoResolve({ kind: 'question', title: `Manual verification: ${task.title}`, detail: m.instructions, taskId: task.id, runId, options: [], response: "Nobody is asked to check this by hand (autonomous mode): the automated checks and the critic's review stand in for it." });
          else project.governance.escalate({ kind: 'question', title: `Manual verification: ${task.title}`, detail: m.instructions, taskId: task.id, runId, options: ['verified', 'not verified'] });
        }
        return { kind: m.kind, name, passed: null, output: `Manual verification requested: ${m.instructions}`, evidenceId: null };
      default:
        return { kind: m.kind, name, passed: null, output: 'Not an automated method', evidenceId: null };
    }
  }

  /**
   * One playtest check: start play, let its time pass, run its probes, read the errors, stop. `quiet` (a regression
   * run, a worker's rehearsal) leaves no evidence, so it takes no picture either: nobody would look at it, and a
   * Studio that isn't drawing makes a capture cost a minute. A recorded check takes one quick picture for the critic.
   */
  private async playtest(project: ProjectContext, task: Task, runId: string | null, m: PlaytestMethod, name: string, quiet: boolean): Promise<MethodResult> {
    const studio = this.deps.studio;
    const before = await studio.console().catch(() => '');
    let luauOutput: string | null = null;
    let clientOutput: string | null = null;
    let luauPassed = true;
    let screenshotPath: string | null = null;
    let read: ErrorRead = { typed: false, errors: [], noise: new Set() };
    const st = await studio.setPlaying(true);
    try {
      if (!st.availableDataModels.includes('Server')) throw new Error(`Playtest did not start (DataModels: ${st.availableDataModels.join(', ') || 'none'})`);
      await new Promise((r) => setTimeout(r, playSeconds(m.durationSec) * VERIFY_CLOCK.secondMs));
      if (m.luau) {
        const r = await runAgentLuau(studio, this.deps.luau, m.luau, 'Server', 60000);
        luauOutput = r.syntax ? `Luau syntax error, ${r.output}` : r.output;
        luauPassed = r.ok && /^\s*PASS/i.test(r.output);
      }
      if (m.clientLuau) {
        // The player's own client: what only it has (LocalPlayer, PlayerGui, the camera, FireServer).
        const r = await runAgentLuau(studio, this.deps.luau, m.clientLuau, 'Client', 60000);
        clientOutput = r.syntax ? `Luau syntax error, ${r.output}` : r.output;
        luauPassed = luauPassed && r.ok && /^\s*PASS/i.test(r.output);
      }
      if (!quiet) {
        try {
          const shot = await studio.screenshot({ quick: true });
          if (shot) {
            screenshotPath = join(project.dir, 'evidence', `${task.id}-play-${Date.now()}.${extFor(shot.mimeType)}`);
            writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
          }
        } catch {
          /* screenshots during play are best-effort */
        }
      }
      read = await this.readErrors();
    } finally {
      await studio.setPlaying(false).catch((e) => this.deps.log.warn('Failed to stop playtest', e));
    }
    const after = await studio.console().catch(() => '');
    const fresh = after.startsWith(before) ? after.slice(before.length) : after;
    const errorLines = errorLinesOf(read, fresh);
    const consoleOk = !m.failOnConsoleErrors || errorLines.length === 0;
    const passed = luauPassed && consoleOk;
    const output = playtestText(m.durationSec, passed, luauOutput, clientOutput, read.typed, errorLines, read.noise);
    const evidenceId = quiet
      ? null
      : this.evidence(project, task, runId, { kind: 'console', title: `Playtest: ${name}`, passed, data: { output, console: fresh.slice(-12000) }, path: screenshotPath });
    return { kind: 'playtest', name, passed, output, evidenceId };
  }

  /** Typed error history from both play DataModels (exact MessageError entries); `typed` false when neither answered. */
  private async readErrors(): Promise<ErrorRead> {
    const read: ErrorRead = { typed: false, errors: [], noise: new Set() };
    for (const dm of ['Server', 'Client'] as const) {
      const r = await this.deps.studio.runLuau(LUAU_LOG_ERRORS, dm, 20000).catch(() => null);
      if (!r?.ok) continue;
      try {
        const parsed = JSON.parse(r.output) as { ok: boolean; errors: string[] };
        if (parsed.ok) {
          read.typed = true;
          read.errors.push(...parsed.errors.filter((e) => !IGNORE_LINE.test(e)).map((e) => `[${dm}] ${e}`));
          for (const e of parsed.errors) if (ASSET_NOISE.test(e)) read.noise.add(e.replace(/\s+/g, ' ').slice(0, 160));
        }
      } catch {
        /* fall back to console heuristics */
      }
    }
    return read;
  }

  /**
   * One play session for the checks of a regression suite that only watch the game: playtests without a probe
   * ("play N s, no errors in the output") and perf budgets (their probe reads the Stats service and counts
   * instances). Nothing they do can change the game, so none of them can affect the next: the session plays as
   * long as the longest asks, each perf budget is measured at its own mark, and the errors are read once at the
   * end. Sharing is sound only for the results it can prove: a clean output over the longest window is clean over
   * every shorter one, so every watching playtest passes with the text its own run would give; with any error in
   * the output (or no typed history, or a measurement that failed) nothing is decided here and the check runs in
   * a session of its own, as before. Returns the decided results by check key.
   */
  private async watchSession(specs: ReadonlyArray<readonly [string, Watcher]>, signal?: AbortSignal): Promise<Map<string, MethodResult>> {
    const out = new Map<string, MethodResult>();
    const studio = this.deps.studio;
    const marks = specs.map(([key, m]) => ({ key, m, at: playSeconds(m.kind === 'perf' ? (m.durationSec ?? 8) : m.durationSec) })).sort((a, b) => a.at - b.at);
    const measured = new Map<string, string | null>();
    let read: ErrorRead | null = null;
    const before = await studio.console().catch(() => '');
    try {
      const st = await studio.setPlaying(true);
      if (!st.availableDataModels.includes('Server')) return out;
      const t0 = Date.now();
      for (const mark of marks) {
        const left = t0 + mark.at * VERIFY_CLOCK.secondMs - Date.now();
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        if (signal?.aborted) return out;
        if (mark.m.kind !== 'perf') continue;
        const r = await runAgentLuau(studio, this.deps.luau, PERF_PROBE, 'Server', 60000).catch(() => null);
        measured.set(mark.key, r?.ok ? (/(\{.*\})/s.exec(r.output)?.[1] ?? null) : null);
      }
      read = await this.readErrors();
    } catch (e) {
      this.deps.log.warn('The shared play session of the regression suite failed; its checks run one by one', errorMessage(e));
      return out;
    } finally {
      await studio.setPlaying(false).catch((e) => this.deps.log.warn('Failed to stop playtest', e));
    }
    const after = await studio.console().catch(() => '');
    const errorLines = errorLinesOf(read, after.startsWith(before) ? after.slice(before.length) : after);
    for (const { key, m } of marks) {
      if (m.kind === 'perf') {
        const json = measured.get(key) ?? null;
        if (json) out.set(key, { kind: 'perf', name: checkName(m), passed: judgePerf(m, json, '').passed, output: judgePerf(m, json, '').output, evidenceId: null });
      } else if (read.typed && errorLines.length === 0) {
        out.set(key, { kind: 'playtest', name: checkName(m), passed: true, output: playtestText(m.durationSec, true, null, null, true, [], read.noise), evidenceId: null });
      }
    }
    return out;
  }
}

interface ErrorRead {
  /** The typed log history answered (else the console text decides). */
  typed: boolean;
  errors: string[];
  /** Asset-loading lines that never count as script errors. */
  noise: Set<string>;
}

/** The error lines a playtest is judged on: the typed history, or the console's new text by its shape. */
function errorLinesOf(read: ErrorRead, fresh: string): string[] {
  return (read.typed ? read.errors : fresh.split(/\r?\n/).filter((l) => ERROR_LINE.test(l) && !IGNORE_LINE.test(l))).slice(0, 60);
}

/**
 * What a task's check stands for right now. A check that references a registered test (`testId`) runs that
 * test's current spec and is skipped once the test is retired or turned off; a task's own check is registered
 * under its name and is skipped once that test is retired. A reference to a test that no longer exists runs the
 * copy it carries.
 */
export function resolveCheck(tests: TestService, task: Task, m: VerificationMethod, readOnly = false): { method: VerificationMethod; test: TestCase | null; skip?: string } {
  const ref = 'testId' in m ? m.testId : undefined;
  if (ref) {
    const reg = tests.get(ref);
    if (!reg) return { method: m, test: null };
    if (reg.retiredAt) return { method: reg.spec, test: reg, skip: `retired (${reg.retiredReason ?? 'no reason recorded'}). The team decided it no longer applies.` };
    if (!reg.enabled) return { method: reg.spec, test: reg, skip: 'this test is turned off' };
    return { method: reg.spec, test: reg };
  }
  // A rehearsal registers nothing: it only looks whether the task's test was retired.
  const test = readOnly ? (tests.find(testName(task.id, m)).find((t) => t.taskId === task.id) ?? null) : tests.upsertForTask(task.id, m);
  if (test?.retiredAt) return { method: m, test, skip: `retired (${test.retiredReason ?? 'no reason recorded'}). The team decided it no longer applies.` };
  return { method: m, test };
}

function placeholderTask(): Task {
  return {
    id: 'regression',
    parentId: null,
    kind: 'test',
    title: 'Regression suite',
    objective: '',
    reason: '',
    role: 'qa-engineer',
    status: 'running',
    priority: 0,
    acceptanceCriteria: [],
    verification: [],
    requiredSkills: [],
    requiredKnowledge: [],
    tools: [],
    files: [],
    robloxSystems: [],
    dependencies: [],
    attempts: 0,
    maxAttempts: 1,
    result: null,
    failureSummary: null,
    createdBy: 'system',
    createdAt: '',
    updatedAt: '',
    startedAt: null,
    completedAt: null,
  };
}

/** The first file with errors, in words: "Broken: the Combat client script doesn't compile (line 2199: …)". */
export function brokenLine(errors: ReadonlyArray<{ file: string; line: number; tool: string; code: string; message: string }>): string {
  const first = errors.find((e) => e.tool === 'compile' || /syntax|parse/i.test(e.code)) ?? errors[0]!;
  const files = new Set(errors.map((e) => e.file));
  const compiles = first.tool === 'compile' || /syntax|parse/i.test(first.code);
  const label = scriptLabel(first.file);
  const what = first.tool === 'compile' ? 'too many local variables in one function' : first.message.split('\n')[0]!.slice(0, 160);
  return `Broken: ${label[0]!.toUpperCase()}${label.slice(1)} (${first.file}) ${compiles ? "doesn't compile" : 'has errors'} (line ${first.line}: ${what})${files.size > 1 ? `, and ${files.size - 1} more file${files.size === 2 ? '' : 's'} ${files.size === 2 ? 'has' : 'have'} errors` : ''}.`;
}

function normPath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}
