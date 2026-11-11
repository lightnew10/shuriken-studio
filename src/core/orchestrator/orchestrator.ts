import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { PermissionMode, Task, VerificationMethod } from '@shared/domain';
import type { FinalCheck, OrchestratorState } from '@shared/events';
import type { UsageWindowReading } from '@shared/usage';
import type { ProjectContext } from '../projects/project-service';
import type { AgentRunner, RunOutcome } from './agent-runner';
import type { Verifier } from '../verification/verifier';
import { amendmentNotes } from '../verification/check-edits';
import { lintChecks } from '../verification/probe-lint';
import { writeProjectReport } from '../projects/report';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { UsageTracker } from './usage-tracker';
import type { ProviderRegistry } from '../providers/provider-registry';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { Semaphore } from '../util/async';
import { roleFor, ROLES, type LivePlanOutput, type PlanOutput, type PlanTaskSpec, type ResearchOutput, type ReviewOutput, type RoleDefinition, type WorkOutput } from '../agents/roles';
import { couldNotContinue, criticContinuation, implementerContinuation, type Continuation } from './continuation';
import { plannerBrief, plannerSession } from './planner-session';
import { claimWarnings, dependencyWarnings, planNodes, strictWarnings } from './plan-checks';
import { heldByPlanUpdate, pendingUserPlanUpdates } from './plan-gate';
import { applyTestAnswer, handleRegressionFailure, otherWorkInFlight } from './regression-wrapup';
import { CLOSED_AT_TRIAGE, DEFECT_REASON, MAX_POLISH_PER_RUN, budgetNotice, MAX_WRAPUP_TRIAGES, TRIAGE_DEFECTS_PREFIX, TRIAGE_POLISH_PREFIX, TRIAGE_PREFIX, classifyFollowUp, closedAtWrapUp, closedForBudget, defectTriageObjective, dueBatches, duePolishBatches, followUpRoom, isDefectProposal, isTriagePlan, listedProposalIds, polishLevel, polishTriageObjective, readFollowUpCounts, triageKind, type FollowUpRoom, type PolishLevel } from './proposal-triage';
import { clockTime } from '../roblox/playtest-lease';
import { ChatService } from '../director/chat-service';
import { lightReview } from './review-policy';
import { autoAgentLimit, fixedAgentWhy, projectCeiling, studioBound, studioLimit, type AgentLoad } from './concurrency';
import { claimsOf, dirTest, sharedFiles, sharedFolderNote, type Claims } from './file-claims';
import { LOOKS_DIRECTIVE, LOOKS_FIX_PREFIX, PENDING_LINE, VISUAL_DONE, VISUAL_PENDING, looksContext, passedUnseen, pendingLooks, pendingSince, readLooks, studioDrawsSince, uncheckedLine } from './visual-checks';
import { applyDecision, decisionFailed, DECISION_ROLE, handOff, isDecisionTask, isNextMilestone, MAX_AUTO_MILESTONES, nextMilestoneTitle } from './autonomy';
import { NOT_REPRODUCED, REOPEN_FAILURE, REOPENED_NOTE, REPRODUCE_FIRST, openReopen, reopenBrief, reproduceCriterion, reproduced } from './reopen';
import { diffEvidence, diffSnapshots, REMOVAL_RECHECK, removalsStillGone, renderDiff, type DataModelSnapshot } from '../roblox/snapshot-diff';
import { ACTIVE, COMPLETE, TERMINAL } from '../tasks/task-graph';
import { pj } from '../db/store';
import { nowIso } from '@shared/ids';

/** The reason recorded on an iteration's objective (a few tasks the director specified, no planner). */
export const ITERATION_REASON = 'A quick iteration the user asked for (no planning pass)';
export const isIteration = (t: Task) => t.kind === 'objective' && t.reason === ITERATION_REASON;
/** More than this is a goal for the planner. */
export const MAX_ITERATION_STEPS = 6;
/** Failure note for a run that ran out of turns and continues in a fresh run. */
const TURN_LIMIT = 'Reached the turn limit';
/** Title prefix of the note on a task whose prerequisite was reworked while it ran (`Prerequisite reworked: "<title>"`). */
export const REWORK_NOTE = 'Prerequisite reworked';

export interface OrchestratorDeps {
  /** Returns a reason when the provider must not be used right now (failed health/compatibility). */
  providerBlocked?: (providerId: string) => string | null;
  runner: AgentRunner;
  verifier: Verifier;
  knowledge: KnowledgeService;
  studio: RobloxStudioAdapter;
  usage: UsageTracker;
  providers: ProviderRegistry;
  bus: EventBus;
  log: ScopedLogger;
  /** Shared with the AgentRunner: task-scoped approvals granted by the user. */
  approvals: Set<string>;
  /** Studio play-mode lease (snapshots wait while someone else's playtest holds Studio). */
  lease?: import('../roblox/playtest-lease').PlaytestLease;
  /** Signed-in provider accounts: failover when one hits its limit, auto-resume when all are limited. */
  accounts?: import('../accounts/account-service').AccountService;
  /** Saves the place in Studio (Studio has no save API for tools); used after verified world changes. */
  savePlace?: (reason: 'goal') => Promise<{ ok: boolean; message: string }>;
  /** Verified work changed the world (the place guard saves it at a safe moment). */
  checkpoint?: () => void;
  /** App-wide preferences (parallel agents, auto-save); a project's own non-default setting wins. */
  appPrefs?: () => { maxConcurrentAgents: number; agentCap?: number; studioAgents?: number; autoSave: boolean; polish?: PolishLevel };
  /** Windows building at once (each runs its own core); the app-wide agent budget is split between them. */
  /** Kiln builds in progress: Opus turns on the same subscription, so Auto leaves room for them (concurrency.ts). */
  kilnBuilds?: () => number;
  /** Agents working in the app's other project windows (the app-wide ceiling takes them off). */
  elsewhere?: () => number;
  /**
   * The permission mode of a project. 'autonomous': nothing waits for the user — approvals are granted and logged, a
   * blocked or repeatedly failing task goes to the planner to decide (autonomous.ts). Absent = 'ask', the earlier
   * behaviour: approval and question cards.
   */
  permissionMode?: (project: ProjectContext) => PermissionMode;
}

/** Title prefix of the planner task that changes a goal's plan at the user's request. */
export const UPDATE_PLAN_PREFIX = 'Update plan: ';

/** A time limit the user sets on running work (Orchestrator.tell): at most `maxMinutes`, enforced `graceMs` after it. An object so a test can shorten it. */
export const TELL = { maxMinutes: 240, graceMs: 2 * 60_000, minuteMs: 60_000 };

/** What the chat and the timeline say when a usage limit pauses the team because auto-resume is off. */
export const PAUSED_FOR_LIMIT = 'Paused until you resume';
export const RESUME_IS_YOURS = '"Resume automatically when a limit resets" is off (Settings, Accounts), so the team stays paused, also after the reset: press Resume to carry on.';

/**
 * The executive loop. Owns what happens next: it schedules runnable tasks under concurrency and
 * usage limits, runs the UNDERSTAND → RESEARCH → PLAN → IMPLEMENT → OBSERVE → TEST → CRITIQUE →
 * REPAIR → VERIFY → DOCUMENT cycle, escalates to the human per project rules, and recovers
 * interrupted work after crashes. Agents are workers; this class decides.
 */
export class Orchestrator {
  private project: ProjectContext | null = null;
  private running = false;
  private paused = false;
  /** Opened on hold: unfinished work waits until the user resumes, asks for work or answers a question. */
  private onHold = false;
  private phase = 'idle';
  private lastDecision: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickError: string | null = null;
  /** End of a timed pause (epoch ms), or null. */
  private pausedUntil: number | null = null;
  /** Why ready work can't start right now (usage limits, agents unable to start), or null. */
  private waiting: string | null = null;
  /** Set when the agent runtime itself fails to start (see checkCompletion); no new runs until then. */
  private envBlockedUntil = 0;
  private envBackoffMs = 0;
  private lastEnvError: string | null = null;
  private lastLimitNotice: string | null = null;
  /** Set while the project is being let go of (see letGo()): nothing new starts. */
  private leaving = false;
  /** Set while the team is held (see hold()). */
  private held: string | null = null;

  /**
   * Verified work that changed the world is saved into the place file (Ctrl+S in Studio), batched so a
   * burst of finished tasks saves once, and never during a playtest.
   */
  /** Verified work changed the world: ask the place guard to save it (it picks a safe moment). */
  private worldCheckpoint(p: ProjectContext, task: Task): void {
    const changedWorld = p.tasks.evidence(task.id).some((e) => e.kind === 'datamodel_snapshot' && !/^DataModel: No DataModel changes/.test(e.title));
    if (changedWorld) this.deps.checkpoint?.();
  }

  /** No new runs until `until` settles (e.g. while a lost world is rebuilt). */
  hold(until: Promise<unknown>, reason: string): void {
    this.held = reason;
    this.emitState();
    void until.finally(() => {
      this.held = null;
      this.emitState();
      this.kick();
    });
  }

  /**
   * What the automatic agent limit is chosen from (concurrency.ts): the ready tasks that could start now, how many
   * of them stay off Studio, the running tasks queued for Studio, the Kiln builds in progress and the live usage
   * windows of the accounts runs can use.
   */
  private agentLoad(p: ProjectContext): AgentLoad {
    // A task that was just started is still 'ready' for a moment (checkpoint, snapshot): count it once, as running.
    const ready = p.tasks.runnable().filter((t) => !this.inflight.has(t.id));
    // Tasks that claim the same file take turns (file-claims.ts): only one of them counts as startable.
    const isDir = dirTest(p.root);
    const taken: Claims[] = [...this.inflight.keys()].map((id) => claimsOf(p.tasks.get(id)?.files ?? [], isDir));
    const startable: Task[] = [];
    for (const t of ready) {
      const mine = claimsOf(t.files, isDir);
      if (taken.some((c) => sharedFiles(mine, c).length > 0)) continue;
      taken.push(mine);
      startable.push(t);
    }
    const usage = this.deps.usage;
    const provider = this.deps.providers.list()[0];
    // Only readings whose window hasn't reset count (the snapshot drops the others): a limit that is over holds nothing back.
    const accounts: Array<Record<string, UsageWindowReading>> = [];
    if (provider && this.deps.accounts) {
      const svc = this.deps.accounts;
      const active = svc.active(provider.id);
      accounts.push(usage.snapshot(svc.usageKey(provider.id, active)).windows);
      // Accounts the scheduler would switch to when the active one is full add their room.
      if (active && svc.policy().autoSwitch) for (const a of svc.candidates(provider.id)) if (a.id !== active.id) accounts.push(usage.snapshot(svc.usageKey(provider.id, a)).windows);
    } else if (provider) accounts.push(usage.snapshot(provider.id).windows);
    return {
      ready: startable.length,
      readyOffStudio: startable.filter((t) => !studioBound(t)).length,
      running: this.working(),
      studioRunning: this.inStudio(p),
      studioCap: studioLimit(this.deps.appPrefs?.().studioAgents),
      // This window's project may set its own "Most agents at once" (a big game being iterated needs fewer than a fresh build).
      cap: p.settings().agentCap ?? this.deps.appPrefs?.().agentCap,
      capFrom: p.settings().agentCap != null ? 'project' : 'app',
      elsewhere: Math.max(0, this.deps.elsewhere?.() ?? 0),
      accounts,
      now: usage.now(),
    };
  }

  /** Running tasks that work in Studio (studioBound): at the Studio limit, a ready task that needs Studio waits unstarted. */
  private inStudio(p: ProjectContext): number {
    return [...this.inflight.keys()].map((id) => p.tasks.get(id)).filter((t) => t && studioBound(t)).length;
  }

  /**
   * Tasks whose agent is only waiting right now (inside a tool that waits for a Kiln build, an upload, Studio's
   * turn): they hold no place among the working agents, so the work that is ready starts beside them. Counted per
   * task, because one agent may wait in two calls at once.
   */
  private readonly parked = new Map<string, number>();

  /** A tool call of this task started (or stopped) waiting for something outside the agent. */
  park(taskId: string | null | undefined, waiting: boolean): void {
    if (!taskId || !this.inflight.has(taskId)) return;
    const n = (this.parked.get(taskId) ?? 0) + (waiting ? 1 : -1);
    if (n > 0) this.parked.set(taskId, n);
    else this.parked.delete(taskId);
    // The other project windows count this one's working agents: tell them it changed.
    this.emitState();
    if (waiting) this.kick();
  }

  /** Agents working now: the running tasks that hold a place (planning and waiting agents don't). */
  private working(): number {
    return Math.max(0, this.semaphore.inUse - [...this.parked.keys()].filter((id) => this.slotted.has(id)).length);
  }

  /** Running tasks that took a place among the working agents (planning too, since 1.16). */
  private readonly slotted = new Set<string>();

  /** The agent limit in force and why (set at every tick; see parallelLimit and state). */
  private agents: { limit: number; auto: boolean; why: string } = { limit: 3, auto: true, why: '' };
  /** Tasks stopped in their checks because every account reached its usage limit (standDownForLimit). */
  private readonly stoppedAtLimit = new Set<string>();
  private readonly inflight = new Map<string, AbortController>();
  /** Counts task starts: a task's before/after place diff is only its own when no other task ran meanwhile. */
  private starts = 0;
  /** Tasks the user explicitly asked to run now (honoured even in manual autonomy). */
  private readonly runNowQueue = new Set<string>();
  /** A user requested Resume while the interrupted agent is still winding down. */
  private readonly resumeAfterStop = new Set<string>();
  private readonly semaphore = new Semaphore(3);
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: OrchestratorDeps) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  attach(project: ProjectContext | null, opts: { autostart?: boolean; hold?: boolean } = {}): void {
    this.stopLoop();
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.project = project;
    this.paused = false;
    this.onHold = false;
    this.leaving = false;
    if (!project) return;
    // Safe mode (inspection) must not touch run state: another engine may be executing this project.
    if (opts.autostart !== false) this.recover(project);
    // Cards left open from before 1.15.8 whose task has since finished or been cancelled no longer apply.
    if (opts.autostart !== false) {
      const gone = project.governance.escalations('open').filter((e) => { const t = e.taskId ? project.tasks.get(e.taskId) : null; return !!t && (t.status === 'done' || t.status === 'cancelled'); });
      for (const e of gone) project.governance.dismiss(e.id, closedReason(project.tasks.get(e.taskId!)!));
    }
    this.unsubscribers.push(
      this.deps.bus.on('escalation.updated', (e) => {
        // An auto-resolved escalation (autonomous mode) is a record of what was decided, not an answer to act on; a
        // dismissed card no longer applied (or was cleared): its task is left as it is.
        if (e.status !== 'open' && e.status !== 'auto_resolved' && e.status !== 'dismissed') this.onEscalationResolved(e.id);
      }),
      // A card is about its task: once the task is done, cancelled or replaced, it no longer applies and closes. Before
      // 1.15.8 cards stayed until answered: a card whose task was replaced two minutes after it opened was mentioned in
      // about 21 replies over 21 hours, and the director could not clear it.
      this.deps.bus.on('task.updated', (t: Task) => {
        if (t.status !== 'done' && t.status !== 'cancelled') return;
        const cur = this.project;
        if (!cur || cur !== project) return;
        // A finished goal keeps its own cards ("Save the place in Studio" is asked as the goal closes); a cancelled one doesn't.
        const kids = t.kind === 'objective' ? cur.tasks.list({ parentId: t.id }).map((k) => k.id) : [];
        const ids = t.kind === 'objective' && t.status === 'done' ? kids : [t.id, ...kids];
        cur.governance.dismissForTasks(ids, closedReason(t));
      }),
      this.deps.bus.on('usage.limit', (e) => {
        if (e.projectId === project.summary.id) this.standDownForLimit(project);
      }),
    );
    if (project.settings().autonomy !== 'manual' && opts.autostart !== false) this.start();
    if (project.extras().paused) {
      // Paused by the user before the restart: stay paused until they resume (or the timed pause ends).
      this.paused = true;
      const until = project.extras().pausedUntil;
      this.pausedUntil = until ? Date.parse(until) : null;
      this.lastDecision = this.pausedUntil ? `Paused until ${new Date(this.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Paused (as you left it)';
    } else {
      this.pausedUntil = null;
      // Opening a project doesn't set the team off: its unfinished work waits for the user.
      if (opts.hold && project.tasks.runnable().length > 0) {
        this.paused = true;
        this.onHold = true;
        this.lastDecision = 'Opened on hold: the team carries on when you resume';
      }
    }
    this.emitState();
  }

  /** The user wants work done (a request, an answer): lift the hold the project was opened with. */
  wake(): void {
    if (this.onHold) this.resume();
  }

  start(): void {
    this.running = true;
    this.paused = false;
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 3000);
    this.lastDecision = 'Orchestrator started';
    this.emitState();
    this.kick();
  }

  pause(): void {
    this.paused = true;
    this.onHold = false;
    this.pausedUntil = null;
    this.project?.updateExtras({ paused: true, pausedUntil: null });
    this.lastDecision = 'Paused: running tasks continue, no new tasks start';
    this.emitState();
  }

  /** Pause now and resume by itself at a time (e.g. when the account's 5-hour window resets). */
  pauseUntil(until: number): void {
    this.pause();
    this.pausedUntil = until;
    this.project?.updateExtras({ paused: true, pausedUntil: new Date(until).toISOString() });
    this.lastDecision = `Paused until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    this.project?.audit.event({ kind: 'pause.scheduled', title: `Paused until ${new Date(until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` });
    this.emitState();
  }

  resume(): void {
    this.paused = false;
    this.onHold = false;
    this.pausedUntil = null;
    this.project?.updateExtras({ paused: false, pausedUntil: null });
    if (!this.running) this.start();
    this.lastDecision = 'Resumed';
    this.emitState();
    this.kick();
  }

  /** Whether any account could start a run for this role now (a look; nothing is switched). */
  private roomFor(role: string): boolean {
    const available = this.project ? this.deps.runner.availability?.(this.project, roleFor(role)) : undefined;
    if (available) return available.ok;
    const provider = this.deps.providers.forRole(roleFor(role).id);
    return this.deps.accounts ? this.deps.accounts.anyCanStart(provider.id, this.deps.usage) : this.deps.usage.canStartRun(provider.id).ok;
  }

  /**
   * A run hit its usage limit and no account has room: the tasks running their checks in Studio stop too. No review
   * can start after them, and the checks run again before the review anyway (resumableWork), so they would drive Studio
   * for nothing. They are ready again with their work kept and the attempt given back. (The runner already stopped the
   * agents waiting on a call; a review cut off by the limit is reviewCutOff's.)
   */
  private standDownForLimit(p: ProjectContext): void {
    let stopped = 0;
    for (const [id, ctrl] of this.inflight) {
      const t = p.tasks.get(id);
      // An objective's regression suite needs no model: it may finish.
      if (!t || t.kind === 'objective' || t.status !== 'verifying' || this.roomFor(t.role)) continue;
      this.stoppedAtLimit.add(id);
      ctrl.abort();
      stopped++;
    }
    if (stopped) p.audit.event({ kind: 'limit.standdown', severity: 'warning', title: `Usage limit reached: ${stopped} task${stopped === 1 ? '' : 's'} running ${stopped === 1 ? 'its' : 'their'} checks in Studio stopped; ${stopped === 1 ? 'it is' : 'they are'} checked and reviewed after the reset` });
  }

  /** Stop: no new work, interrupt running agents; interrupted tasks return to ready. */
  async stop(): Promise<void> {
    this.paused = true;
    this.project?.updateExtras({ paused: true, pausedUntil: this.pausedUntil ? new Date(this.pausedUntil).toISOString() : null });
    for (const c of this.inflight.values()) c.abort();
    await this.deps.runner.interruptAll();
    this.lastDecision = 'Stopped by user';
    this.emitState();
  }

  /**
   * The project is about to close under running work (its window opens another one): nothing new starts, running
   * agents are interrupted, and this resolves once they have come back (at most `timeoutMs`), their tasks ready again
   * while the store is still open. They carry on in their own sessions when the project opens next, as after a
   * restart. Unlike stop(), the project isn't left paused; stay() carries on when the switch doesn't happen.
   */
  async letGo(timeoutMs = 60_000): Promise<void> {
    this.leaving = true;
    for (const c of this.inflight.values()) c.abort();
    await this.deps.runner.interruptAll();
    const until = Date.now() + timeoutMs;
    while ((this.inflight.size > 0 || this.deps.runner.activeRuns().length > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }

  /** The project stays open after letGo() after all (the other one could not open): carry on. */
  stay(): void {
    if (!this.leaving) return;
    this.leaving = false;
    this.kick();
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  kick(): void {
    setImmediate(() => void this.tick());
  }

  /**
   * The user paused or stopped (or the project closed or switched): nothing new may be created or started.
   * Checked after every await in tick() and finalizeObjectives(), because a tick spans minutes of checks.
   */
  private halted(p: ProjectContext): boolean {
    return !this.running || this.project !== p || this.paused || this.leaving;
  }

  /** Agents allowed at once right now (shared between windows), whether that follows the work (automatic, 3–20) or is fixed, and why it is that number. */
  parallelLimit(): { now: number; auto: boolean; why: string } {
    const p = this.project;
    const fixed = p ? (p.settings().maxConcurrentAgents > 0 ? p.settings().maxConcurrentAgents : (this.deps.appPrefs?.().maxConcurrentAgents ?? 0)) : 0;
    return { now: this.agents.limit, auto: fixed <= 0, why: this.agents.why };
  }

  /** A goal's final review while it runs (state().finalCheck). */
  private finalCheck: FinalCheck | null = null;

  state(): OrchestratorState {
    const p = this.project;
    const objective = p?.tasks.list({ kinds: ['objective'], statuses: ['ready', 'running'] })[0] ?? null;
    return {
      projectId: p?.summary.id ?? '',
      running: this.running,
      paused: this.paused,
      held: this.paused && this.onHold,
      pausedUntil: this.paused && this.pausedUntil ? new Date(this.pausedUntil).toISOString() : null,
      waiting: this.paused ? null : this.waiting,
      activeRuns: this.inflight.size,
      working: this.working(),
      agents: { limit: this.agents.limit, auto: this.agents.auto, why: this.agents.why },
      queued: p ? p.tasks.runnable().length : 0,
      phase: this.phase,
      currentObjectiveId: objective?.id ?? null,
      lastDecision: this.lastDecision,
      finalCheck: this.finalCheck,
    };
  }

  private emitState(): void {
    this.deps.bus.emit('orchestrator.state', this.state());
  }

  // ─── Recovery ──────────────────────────────────────────────────────────────

  private recover(project: ProjectContext): void {
    const stale = project.store.run(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = COALESCE(error, 'Interrupted (application restarted or crashed)') WHERE status IN ('starting', 'running')`, [new Date().toISOString()]);
    let resumed = 0;
    for (const t of project.tasks.list({ statuses: ['running', 'implemented', 'verifying', 'reviewing'] })) {
      if (t.kind === 'objective') {
        // Objectives are containers: they stay running while their children are recovered. One caught
        // mid-finalization (regression suite) has no finalizer left: re-queue it so the suite runs again.
        if (t.status === 'verifying') {
          project.tasks.setStatus(t.id, 'ready', 'Recovered: the regression suite was interrupted; it will run again');
          resumed++;
        }
        continue;
      }
      if (t.status === 'running') {
        // If the interrupted run already changed files, verify before redoing anything.
        project.tasks.setResumeRun(t.id, null);
        project.tasks.setStatus(t.id, 'ready', 'Recovered after interruption; will re-run with prior failures in context');
        project.tasks.addFailure({ taskId: t.id, runId: null, attempt: t.attempts, stage: 'provider', summary: 'Run interrupted (application restart or crash)', detail: 'Any partial changes remain on disk; inspect git diff before redoing work.' });
        project.tasks.refundAttempt(t.id);
      } else {
        // The implementation finished; only its checks were cut off. doWork resumes at verification
        // (resume_run_id), and the check run doesn't count as a new attempt.
        project.tasks.setStatus(t.id, 'failed', 'Recovered after interruption during verification');
        project.tasks.setStatus(t.id, 'ready', 'Re-verify after restart');
        if (project.tasks.resumeRun(t.id)) project.tasks.refundAttempt(t.id);
      }
      resumed++;
    }
    if (stale.changes || resumed) {
      project.audit.event({ kind: 'recovery', severity: 'warning', title: `Recovered: ${stale.changes} interrupted run(s), ${resumed} task(s) re-queued` });
    }
  }

  // ─── User commands ─────────────────────────────────────────────────────────

  submitObjective(input: { title: string; description: string; acceptanceCriteria?: string[]; skipResearch?: boolean }): Task {
    const p = this.requireProject();
    const settings = p.settings();
    const objective = p.tasks.create({
      kind: 'objective',
      title: input.title,
      objective: input.description,
      reason: 'Defined by the user',
      role: 'executive',
      status: 'running',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      createdBy: 'user',
      maxAttempts: settings.maxAttemptsPerTask,
    });
    const deps: string[] = [];
    if (!input.skipResearch) {
      const research = p.tasks.create({
        parentId: objective.id,
        kind: 'research',
        title: `Research requirements: ${input.title}`,
        objective: `Research what is required to achieve this objective in Roblox, what is officially supported, known pitfalls, and the correct modern approach.\n\nObjective: ${input.title}\n${input.description}`,
        reason: 'Plans must rest on verified facts about the platform and the current project state.',
        role: 'researcher',
        status: 'ready',
        priority: 90,
        acceptanceCriteria: ['Sources recorded with authority labels', 'Findings recorded as knowledge with confidence', 'Conclusion states possible / impossible / risks'],
        createdBy: 'executive',
        maxAttempts: 2,
      });
      deps.push(research.id);
    }
    p.tasks.create({
      parentId: objective.id,
      kind: 'plan',
      title: `Plan: ${input.title}`,
      objective: `Turn the objective into a verified task graph.\n\nObjective: ${input.title}\n${input.description}${input.acceptanceCriteria?.length ? `\n\nObjective acceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''}`,
      reason: 'Decompose, assign specialists and define verification before implementation.',
      role: 'executive',
      status: 'ready',
      priority: 85,
      dependencies: deps,
      acceptanceCriteria: ['Every task has observable acceptance criteria and automated verification', 'Dependencies form a DAG', 'Independent tasks can run in parallel'],
      createdBy: 'executive',
      maxAttempts: 2,
    });
    p.audit.event({ kind: 'objective.submitted', severity: 'info', title: `Objective: ${input.title}`, taskId: objective.id, role: 'user' });
    this.lastDecision = `New objective "${input.title}": ${input.skipResearch ? 'planning' : 'research then planning'}`;
    this.kick();
    this.emitState();
    return objective;
  }

  retry(taskId: string): Task {
    const p = this.requireProject();
    const t = p.tasks.require(taskId);
    p.tasks.resetAttempts(taskId);
    const next = t.status === 'ready' ? t : p.tasks.setStatus(taskId, 'ready', 'Retry requested by user', 'user');
    this.kick();
    return next;
  }

  /**
   * The user says a finished task is still broken (the director passes their words on). The task comes back with
   * the report on its record and a "reproduce first" requirement: its next attempt must show the failure in Studio (a
   * check that fails before the fix, or the failure recorded as evidence) before its work counts, and its review is
   * never skipped (reopen.ts). Its history stays: earlier runs, evidence and failures, and the attempts already used
   * (it gets a fresh allowance on top). A finished goal it belongs to is reopened too, so its wrap-up runs again.
   * A task still being worked on gets the report and the requirement, and a running agent is told at once.
   */
  reopen(taskId: string, report: string): { ok: boolean; message: string } {
    const p = this.project;
    if (!p) return { ok: false, message: 'No project is open.' };
    const t = p.tasks.get(taskId);
    if (!t) return { ok: false, message: `There is no task ${taskId}.` };
    const text = report.trim().slice(0, 2000);
    if (!text) return { ok: false, message: 'Say what is still broken: the report is what the task starts from.' };
    if (t.kind === 'objective' || t.kind === 'plan') return { ok: false, message: `"${t.title}" is a goal or a planning step, not a piece of work: ask for the fix as a change instead.` };
    if (t.status === 'cancelled') return { ok: false, message: `"${t.title}" was cancelled, so there is nothing to reopen: ask for it again as a change.` };
    p.tasks.addEvidence({ taskId: t.id, runId: null, kind: 'note', title: `${REOPENED_NOTE}: ${text.slice(0, 160)}`, passed: null, data: { report: text, previousStatus: t.status, previousResult: t.result }, path: null });
    const criteria = [reproduceCriterion(text), ...t.acceptanceCriteria.filter((c) => !c.startsWith(REPRODUCE_FIRST))];
    const allowance = Math.max(t.maxAttempts, t.attempts + p.settings().maxAttemptsPerTask);
    p.tasks.update(t.id, { acceptanceCriteria: criteria, maxAttempts: allowance });
    p.audit.event({ kind: 'task.reopened', severity: 'warning', title: `Reopened "${t.title}": the user reports it is still broken`, taskId: t.id, role: 'user', detail: { report: text, was: t.status } });
    if (ACTIVE.has(t.status) || this.inflight.has(t.id)) {
      // Being worked on (or just passing): the report reaches its agent with the next tool result (as the director's
      // word does), and the work counts only after the problem was shown (the gate in doWork).
      if (t.status === 'running' && this.inflight.has(t.id)) this.pendingNotes.set(t.id, [...(this.pendingNotes.get(t.id) ?? []), reopenBrief(text)]);
      return { ok: true, message: `"${t.title}" is being worked on right now: the report is on it${t.status === 'running' ? ', and its agent was told' : ''}. Its work counts only once the problem is shown in Studio and then fixed.` };
    }
    // The next run sees the report under "Previous attempts" (and in its continued session's brief).
    p.tasks.addFailure({ taskId: t.id, runId: null, attempt: t.attempts, stage: 'review', summary: `${REOPEN_FAILURE}: ${text}`, detail: reopenBrief(text) });
    p.tasks.setResumeRun(t.id, null);
    if (t.status !== 'ready' && t.status !== 'proposed') p.tasks.setStatus(t.id, 'ready', 'Reopened: the user reports it is still broken', 'user');
    const goal = t.parentId ? p.tasks.get(t.parentId) : null;
    if (goal?.kind === 'objective' && (goal.status === 'done' || goal.status === 'verified')) p.tasks.setStatus(goal.id, 'ready', `Reopened: "${t.title}" is reported still broken`, 'user');
    this.lastDecision = `Reopened "${t.title}" at the user's report`;
    this.kick();
    this.emitState();
    return { ok: true, message: `Reopened "${t.title}". Its next attempt first shows the problem in Studio, then fixes it; the review isn't skipped.` };
  }

  /** Run one task now, regardless of autonomy mode (still subject to concurrency and usage limits). */
  runNow(taskId: string): Task {
    const p = this.requireProject();
    let t = p.tasks.require(taskId);
    if (t.status !== 'ready') t = p.tasks.setStatus(taskId, 'ready', 'Run requested by user', 'user');
    this.runNowQueue.add(taskId);
    if (!this.running) {
      this.running = true;
      if (!this.timer) this.timer = setInterval(() => void this.tick(), 3000);
    }
    this.lastDecision = `Running "${t.title}" at your request`;
    this.kick();
    return t;
  }

  cancel(taskId: string, reason = 'Cancelled by user', actor = 'user'): Task {
    const p = this.requireProject();
    this.inflight.get(taskId)?.abort();
    const t = p.tasks.setStatus(taskId, 'cancelled', reason, actor);
    // A cancelled plan update ends its "Updating the plan…" card, and the tasks it held start.
    if (t.kind === 'plan' && t.parentId) this.deps.bus.emit('plan.updated', { objectiveId: t.parentId, planTaskId: t.id, status: 'cancelled' });
    this.kick();
    return t;
  }

  /** Pause this one task without pausing the other agents or its parent objective. */
  pauseTask(taskId: string): Task {
    const p = this.requireProject();
    const task = p.tasks.require(taskId);
    if (task.kind === 'objective') throw new Error('Pause an individual agent task, not the whole objective.');
    if (task.status === 'paused') return task;
    if (!['ready', 'running', 'implemented', 'verifying', 'reviewing'].includes(task.status))
      throw new Error('This task cannot be paused in its current state.');
    this.resumeAfterStop.delete(taskId);
    this.runNowQueue.delete(taskId);
    // Immediately mark the task paused, so the scheduler cannot relaunch it.
    // The abort is cooperative: an in-progress tool may finish its current action.
    const paused = p.tasks.setStatus(taskId, 'paused', 'Paused individually by user', 'user');
    this.inflight.get(taskId)?.abort();
    this.kick();
    return paused;
  }

  /** Resuming just one task does not resume a globally paused project. */
  resumeTask(taskId: string): Task {
    const p = this.requireProject();
    const task = p.tasks.require(taskId);
    if (task.status !== 'paused') throw new Error('Only a paused task can be resumed.');
    if (this.inflight.has(taskId)) {
      // Do not start an overlapping run: wait for the original agent to stop first.
      this.resumeAfterStop.add(taskId);
      return task;
    }
    const ready = p.tasks.setStatus(taskId, 'ready', 'Resumed individually by user', 'user');
    this.kick();
    return ready;
  }

  /**
   * Wrap up (the user said so): every task that hasn't started is cancelled (planning that runs included, a decision
   * excepted), and until the user asks for something new nothing is created or started: no triage, no polish, no look,
   * no final regression run. What runs finishes. Before 1.15.8 a wrap-up took four or five messages, each cancelling a
   * few more tasks while triage created new ones.
   */
  wrapUp(): { cancelled: number; running: string[] } {
    const p = this.requireProject();
    p.updateExtras({ wrapUp: true });
    let cancelled = 0;
    for (const t of p.tasks.list({})) {
      if (t.kind === 'objective' || TERMINAL.has(t.status) || COMPLETE.has(t.status)) continue;
      const started = this.inflight.has(t.id) || ACTIVE.has(t.status);
      if (started && !(t.kind === 'plan' && !isDecisionTask(t))) continue;
      try {
        if (started) this.cancel(t.id, 'Wrapped up at your word', 'user');
        else p.tasks.setStatus(t.id, 'cancelled', 'Wrapped up at your word: not started', 'user');
        cancelled++;
      } catch {
        /* a task that changed state under us: left as it is */
      }
    }
    const running = p.tasks.list({}).filter((t) => t.kind !== 'objective' && this.inflight.has(t.id)).map((t) => t.title);
    p.audit.event({ kind: 'wrapup.started', severity: 'info', title: `Wrapping up: ${cancelled} task${cancelled === 1 ? '' : 's'} not started were cancelled; ${running.length} running finish` });
    this.kick();
    return { cancelled, running };
  }

  /** Goals whose final review the user stopped: they finish without the regression run (stopFinalCheck). */
  private readonly skipFinal = new Set<string>();

  /**
   * The user stops a goal's final review (the regression run that closes it): the run stops now and the goal finishes
   * without it. The director could not act on it before ("I couldn't find task_… among the tasks"). Returns its title.
   */
  stopFinalCheck(): string | null {
    const fc = this.finalCheck;
    if (!fc) return null;
    this.skipFinal.add(fc.objectiveId);
    this.inflight.get(fc.objectiveId)?.abort();
    this.project?.audit.event({ kind: 'final.skipped', severity: 'info', title: `Final review of "${fc.title}" stopped at the user's word; the goal finishes without it`, taskId: fc.objectiveId });
    this.kick();
    return fc.title;
  }

  /** The user asked for something new: the wrap-up ends (triage, polish and the final review come back). */
  endWrapUp(): void {
    if (this.project?.extras().wrapUp) this.project.updateExtras({ wrapUp: false });
  }

  /** The plan the user was waiting for is ready: the team runs again, as they asked ("resume when the plan is ready"). */
  private resumeIfPlanned(p: ProjectContext, task: Task): void {
    if (!p.extras().resumeWhenPlanned || isDecisionTask(task)) return;
    p.updateExtras({ resumeWhenPlanned: false });
    if (!this.paused) return;
    this.resume();
    new ChatService(p, this.deps.bus).add({ role: 'system', kind: 'status', text: 'The plan is ready, so the team is running again, as you asked.' });
  }

  private wrappingUp(p: ProjectContext): boolean {
    return p.extras().wrapUp === true;
  }

  /** Resume by itself once the plan update now being made is ready ("don't resume yet; resume when the plan is ready"). */
  resumeWhenPlanned(): void {
    this.project?.updateExtras({ resumeWhenPlanned: true });
  }

  /**
   * Why ready tasks aren't starting right now, in plain words for the director (empty when nothing waits, or they are
   * starting). The director said "I can't see why it hasn't started" while a world restore held the team.
   */
  whyWaiting(): string[] {
    const p = this.project;
    if (!p) return [];
    const ready = p.tasks.runnable().filter((t) => !this.inflight.has(t.id));
    if (!ready.length) return [];
    const why: string[] = [];
    if (this.paused) why.push(this.onHold ? 'the project opened on hold: the first request starts it' : 'the team is stopped: it starts again when the user says resume (or "start <task>" runs one task now)');
    if (this.held) why.push(`held: ${this.held}`);
    if (p.settings().autonomy === 'manual') why.push('autonomy is manual: tasks start only when run by hand');
    if (this.waiting && !this.paused) why.push(this.waiting);
    if (this.wrappingUp(p)) why.push('wrapping up: nothing new starts until the user asks for something');
    const updates = pendingUserPlanUpdates(p.tasks.list({ kinds: ['plan'], statuses: ['ready', 'running'] }));
    const heldByPlan = updates.length ? ready.filter((t) => heldByPlanUpdate(t, updates)).length : 0;
    if (heldByPlan) why.push(`${heldByPlan} task${heldByPlan === 1 ? ' waits' : 's wait'} for the plan update the user asked for (the planner may reshape them)`);
    const planning = p.tasks.list({ kinds: ['plan'], statuses: ['running'] });
    const plansReady = ready.filter((t) => t.kind === 'plan').length;
    if (planning.length && plansReady) why.push(`${plansReady} planning job${plansReady === 1 ? ' waits' : 's wait'} for the planner, who is busy with "${planning[0]!.title.slice(0, 80)}" (one planner per project)`);
    const agentsBusy = this.semaphore.inUse >= this.semaphore.max;
    if (agentsBusy && ready.length) why.push(`every agent slot is in use (${this.semaphore.inUse} of ${this.agents.limit}: ${this.agents.why})`);
    return why;
  }

  forceResearch(targetTaskId: string, question: string): Task {
    const p = this.requireProject();
    const target = p.tasks.require(targetTaskId);
    const research = p.tasks.create({
      parentId: target.kind === 'objective' ? target.id : target.parentId,
      kind: 'research',
      title: `Research: ${question.slice(0, 80)}`,
      objective: question,
      reason: `Requested by the user for "${target.title}"`,
      role: 'researcher',
      status: 'ready',
      priority: 95,
      acceptanceCriteria: ['Sources recorded', 'Findings recorded as knowledge'],
      createdBy: 'user',
    });
    if (target.kind !== 'objective' && !TERMINAL.has(target.status) && !ACTIVE.has(target.status)) p.tasks.addDependency(target.id, research.id);
    this.kick();
    return research;
  }

  async forceReview(taskId: string): Promise<ReviewOutput | null> {
    const p = this.requireProject();
    const task = p.tasks.require(taskId);
    const out = await this.critique(p, task, new AbortController().signal, 'Review requested by the user.', false);
    return out.review;
  }

  // ─── Scheduling ────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const p = this.project;
    if (!p || !this.running || this.ticking || this.leaving) return;
    if (this.paused && this.pausedUntil && Date.now() >= this.pausedUntil) {
      p.audit.event({ kind: 'pause.ended', severity: 'info', title: 'Timed pause ended; resuming work' });
      this.resume();
    }
    if (this.paused && this.runNowQueue.size === 0) return;
    if (this.held) {
      this.waiting = this.held;
      return;
    }
    this.ticking = true;
    try {
      const settings = p.settings();
      const fixed = settings.maxConcurrentAgents > 0 ? settings.maxConcurrentAgents : (this.deps.appPrefs?.().maxConcurrentAgents ?? 0);
      const load = this.agentLoad(p);
      const choice = fixed > 0 ? { limit: Math.min(fixed, projectCeiling(load.elsewhere)), why: fixedAgentWhy(load.ready, fixed, load.elsewhere) } : autoAgentLimit(load);
      const waitingAgents = [...this.parked.keys()].filter((id) => this.slotted.has(id)).length;
      // An agent that only waits keeps its place on paper and frees it in practice.
      this.semaphore.setLimit(Math.max(1, choice.limit) + waitingAgents);
      this.agents = { limit: Math.max(1, choice.limit), auto: fixed <= 0, why: `${choice.why}${waitingAgents ? `, ${waitingAgents} more ${waitingAgents === 1 ? 'is' : 'are'} only waiting (Kiln, uploads)` : ''}` };
      // At most the Studio limit's running tasks work in Studio: another task that needs it waits unstarted (an agent
      // queueing for Studio only spends tokens), and work off Studio goes first.
      let inStudio = load.studioRunning;
      let manual = settings.autonomy === 'manual' || this.paused;
      if (manual && this.runNowQueue.size === 0) return;

      if (!manual) {
        await this.finalizeObjectives(p);
        // Finalizing awaits minutes of checks: the user may have paused or stopped meanwhile (or the project
        // closed). Look again before anything is created or started (a pause once still set agents off).
        if (!this.running || this.project !== p) return;
        manual = this.paused || p.settings().autonomy === 'manual';
        if (manual && this.runNowQueue.size === 0) return;
      }
      // Defects agents reported are looked at soon, not at a wrap-up that may be hours away (never while paused).
      if (!manual) this.triageDefects(p);
      // Optional polish is triaged in rolling batches when agents would otherwise sit idle: nothing ready is waiting
      // to start, and one more task would be allowed to run.
      const roomForMore = fixed > 0 ? this.semaphore.inUse < this.semaphore.max : autoAgentLimit({ ...load, ready: load.ready + 1, readyOffStudio: load.readyOffStudio + 1 }).limit > load.running;
      if (!manual && load.ready === 0 && roomForMore) this.triagePolish(p);
      // Tasks that passed while Studio wasn't drawing get their look as soon as it draws again.
      if (!manual) this.lookWhenStudioDraws(p);

      for (const t of p.tasks.deadlocked()) {
        if (t.status === 'ready') {
          p.tasks.setStatus(t.id, 'blocked', 'A dependency was cancelled, blocked or escalated');
          this.lastDecision = `Blocked "${t.title}" (dependency cannot complete)`;
        }
      }
      for (const t of p.tasks.unblockable()) p.tasks.setStatus(t.id, 'ready', 'Its dependencies can complete again');

      // A change the user asked for is being planned: the objective's older not-yet-started tasks wait
      // for the planner, who may cancel or reshape them (see plan-gate.ts). Tasks the user asked to run now don't.
      const updates = pendingUserPlanUpdates(p.tasks.list({ kinds: ['plan'], statuses: ['ready', 'running'] }));
      const startable = p.tasks
        .runnable()
        .filter((t) => !this.inflight.has(t.id))
        .filter((t) => !manual || this.runNowQueue.has(t.id));
      const held = updates.length ? startable.filter((t) => !this.runNowQueue.has(t.id) && heldByPlanUpdate(t, updates)) : [];
      if (held.length) this.noteHeld(p, held, updates);
      // Tasks the user asked to run now first, then planning (everything else waits on it, and it holds a place now).
      const runnable = startable.filter((t) => !held.includes(t)).sort((a, b) => Number(this.runNowQueue.has(b.id)) - Number(this.runNowQueue.has(a.id)) || Number(b.kind === 'plan') - Number(a.kind === 'plan'));
      if (runnable.length === 0) {
        this.phase = this.inflight.size ? 'working' : 'idle';
        return;
      }
      const isDir = dirTest(p.root);
      for (const task of runnable) {
        // Two tasks that claim the same FILE never run at the same time (one shared working tree). A folder in
        // `files` keeps nobody out: the agents are told whose files are whose instead (file-claims.ts).
        const mine = claimsOf(task.files, isDir);
        if (mine.files.size && [...this.inflight.keys()].some((id) => sharedFiles(mine, claimsOf(p.tasks.get(id)?.files ?? [], isDir)).length > 0)) continue;
        const needsStudio = studioBound(task);
        if (needsStudio && inStudio >= studioLimit(load.studioCap) && !this.runNowQueue.has(task.id)) continue;
        const role = p.tasks.resumeRun(task.id) ? ROLES.critic! : roleFor(task.role);
        const route = this.deps.runner.availability?.(p, role, task.id);
        const provider = route?.ok ? route.provider : this.deps.providers.forRole(role.id);
        const pick = route ? (route.ok
          ? { ok: true, account: route.account, switchedFrom: undefined, resumeAt: null, reason: route.reason }
          : { ...route, account: null, switchedFrom: undefined })
          : this.deps.accounts
          ? this.deps.accounts.pick(provider.id, this.deps.usage)
          : { ok: this.deps.usage.canStartRun(provider.id).ok, reason: this.deps.usage.canStartRun(provider.id).reason, switchedFrom: undefined, account: null, resumeAt: null };
        if (pick.switchedFrom && pick.account) {
          p.audit.event({ kind: 'account.switched', severity: 'warning', title: `Switched to ${pick.account.label}: ${pick.switchedFrom.label} reached its usage limit` });
        }
        if (!pick.ok) {
          this.lastDecision = pick.reason ?? 'Provider unavailable';
          this.waiting = (pick.reason ?? 'Waiting for a usage limit to reset') + (route && pick.resumeAt ? ` · next attempt ${new Date(pick.resumeAt).toLocaleString()}` : '');
          const notice = `${pick.resumeAt ?? 'none'}`;
          if (this.lastLimitNotice !== notice) {
            this.lastLimitNotice = notice;
            p.audit.event({ kind: 'limit.wait', severity: 'warning', title: pick.reason ?? 'Waiting for a usage limit to reset' });
          }
          if (this.deps.accounts && !this.deps.accounts.policy().autoResume && !this.paused) {
            // Auto-resume is off: stop here and let the user decide when to continue.
            this.pause();
            p.audit.event({ kind: 'limit.paused', severity: 'warning', title: `${PAUSED_FOR_LIMIT}: ${pick.reason ?? 'usage limit reached'}. ${RESUME_IS_YOURS}` });
          }
          if (route && !this.paused) continue;
          break;
        }
        if (Date.now() < this.envBlockedUntil) {
          this.lastDecision = `Agents can't start right now; retrying in ${Math.ceil((this.envBlockedUntil - Date.now()) / 1000)} s`;
          this.waiting = "Agents can't start right now; retrying shortly";
          break;
        }
        const blocked = this.deps.providerBlocked?.(provider.id) ?? null;
        if (blocked) {
          this.lastDecision = `Not starting agents: ${blocked}`;
          break;
        }
        // One planner per project (1.15.8): planning jobs (a plan, a plan update, triage, a decision) run one at a time,
        // in priority order (decisions, then the user's plan updates, then triage, then polish), so each works from the
        // plan as the one before it left it, and the planner keeps one conversation for the whole project
        // (orchestrator/planner-session.ts). Two used to start in the same second, each from its own view of the plan.
        if (task.kind === 'plan' && [...this.inflight.keys()].some((id) => p.tasks.get(id)?.kind === 'plan')) continue;
        // Planning holds a place like any agent (1.16: few agents, each working); it goes first in line (above).
        const release = this.semaphore.tryAcquire();
        if (!release) break;
        this.slotted.add(task.id);
        if (needsStudio) inStudio++;
        this.waiting = null;
        const ctrl = new AbortController();
        this.inflight.set(task.id, ctrl);
        this.starts++;
        this.runNowQueue.delete(task.id);
        this.phase = 'working';
        this.lastDecision = `Assigned "${task.title}" to ${roleFor(task.role).name}${this.inflight.size > 1 ? ` (${this.inflight.size} in parallel)` : ''}`;
        this.emitState();
        void this.execute(p, task, ctrl.signal)
          .catch((e) => {
            this.deps.log.error(`Task ${task.id} crashed`, e);
            try {
              const cur = p.tasks.get(task.id);
              if (cur && !TERMINAL.has(cur.status)) this.handleFailure(p, cur, 'implement', `Orchestrator error: ${errorMessage(e)}`, null, null);
            } catch (inner) {
              this.deps.log.error('Failure handling failed', inner);
            }
          })
          .finally(() => {
            this.inflight.delete(task.id);
            if (this.resumeAfterStop.delete(task.id) && this.project === p && p.tasks.get(task.id)?.status === 'paused') {
              p.tasks.setStatus(task.id, 'ready', 'Resumed individually after previous run stopped', 'user');
            }
            this.parked.delete(task.id);
            this.slotted.delete(task.id);
            release();
            this.emitState();
            this.kick();
          });
      }
    } catch (e) {
      // Shutdown or a project switch can close the store under an in-flight tick; that is not an error.
      if (!this.running || this.project !== p) return;
      // A failing tick stalls all scheduling; say so where the user looks, once per distinct error.
      const msg = errorMessage(e);
      this.deps.log.error('Orchestrator tick failed', e);
      this.lastDecision = `Scheduler error: ${msg}`;
      if (msg !== this.lastTickError) {
        this.lastTickError = msg;
        try {
          p.audit.event({ kind: 'orchestrator.error', severity: 'error', title: `Scheduler error: ${msg}`.slice(0, 300), detail: { stack: e instanceof Error ? e.stack : null } });
        } catch {
          /* the store may be closing */
        }
      }
    } finally {
      this.ticking = false;
      this.emitState();
    }
  }

  /** Notes for running agents (by task id), handed over with their next tool result: see noteRework. */
  private readonly pendingNotes = new Map<string, string[]>();

  /** The notes waiting for the agent of `taskId`, taken (each is delivered once). */
  private takeNotes(taskId: string): string | null {
    const notes = this.pendingNotes.get(taskId);
    if (!notes?.length) return null;
    this.pendingNotes.delete(taskId);
    return notes.join('\n\n');
  }

  /**
   * A task that had been sent back (by its checks or the critic) has landed its rework. The tasks that started on its
   * earlier version keep running: each gets a note on its record, and its agent reads what changed in its next tool
   * result (a dependent whose agent has finished is covered by its reviewer, who is told too).
   */
  private noteRework(p: ProjectContext, task: Task, work: WorkOutput, files: string[]): void {
    const sentBack = p.tasks.failures(task.id).filter((f) => f.stage === 'verify' || f.stage === 'review').at(-1);
    if (!sentBack) return;
    const dependents = p.tasks.list().filter((t) => t.dependencies.includes(task.id) && ACTIVE.has(t.status));
    if (!dependents.length) return;
    const why = sentBack.summary.split('\n')[0]!.slice(0, 300);
    const text = [
      `Note from Shuriken: the prerequisite task "${task.title}" was reworked while you worked (it had been sent back: ${why}).`,
      `What it is now: ${work.summary.slice(0, 800)}`,
      files.length ? `Files it changed: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ', …' : ''}` : '',
      'Re-read what you use from it before you finish and adjust your part where it no longer fits; otherwise carry on.',
    ].filter(Boolean).join('\n');
    for (const t of dependents) {
      p.tasks.addEvidence({ taskId: t.id, runId: null, kind: 'note', title: `${REWORK_NOTE}: "${task.title}"`, passed: null, data: { summary: work.summary.slice(0, 800), files: files.slice(0, 40), sentBack: why }, path: null });
      if (t.status === 'running') this.pendingNotes.set(t.id, [...(this.pendingNotes.get(t.id) ?? []), text]);
    }
    p.audit.event({ kind: 'task.note', severity: 'info', title: `"${task.title}" was reworked: told ${dependents.length} task${dependents.length === 1 ? '' : 's'} that started on its earlier version`, taskId: task.id, detail: { dependents: dependents.map((t) => t.title) } });
  }

  /** Time limits the user set on running work (by task id): see tell. */
  private readonly deadlines = new Map<string, NodeJS.Timeout>();

  /**
   * The user's word to the agents that are working right now, passed on by the director: each reads it with its
   * next tool result (the same way a reworked prerequisite reaches it), so within a tool call, not at its next run.
   * `finishInMinutes`: they are told to bring their work to a working state and return within that time, and a run
   * still going TELL.graceMs after it is stopped where it is (its files stay, its task is paused), so "finish in five
   * minutes" is kept, not hoped for. Returns the tasks whose agents were told (none: nobody is working).
   *
   * Before this the director answered "I can't set a timer on agents that are already running" and paused the
   * queue instead; the four agents worked on for as long as their tasks took.
   */
  tell(message: string, opts: { taskIds?: string[]; finishInMinutes?: number } = {}): Task[] {
    const p = this.requireProject();
    const text = message.trim().slice(0, 2000);
    if (!text) return [];
    const only = opts.taskIds?.length ? new Set(opts.taskIds) : null;
    const running = p.tasks.list({ statuses: ['running'] }).filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && this.inflight.has(t.id) && (!only || only.has(t.id)));
    const minutes = typeof opts.finishInMinutes === 'number' && Number.isFinite(opts.finishInMinutes) && opts.finishInMinutes > 0 ? Math.min(TELL.maxMinutes, Math.max(1, Math.round(opts.finishInMinutes))) : null;
    const until = minutes ? Date.now() + minutes * 60_000 : null;
    const note = [
      `Message from the director, passing on what the user just asked: ${text}`,
      until
        ? `Time limit: finish within ${minutes} minute${minutes === 1 ? '' : 's'} (by ${clockTime(until)}). Bring what you have to a working state now, leave out what is optional, sync, run task_run_checks once, and return your result saying what is done and what is not. A run still going shortly after that time is stopped where it is: its files stay, and nothing more is done on it.`
        : 'Act on it in the work you are doing now, and say in your result what you did about it.',
    ].join('\n');
    for (const t of running) {
      this.pendingNotes.set(t.id, [...(this.pendingNotes.get(t.id) ?? []), note]);
      p.tasks.addEvidence({ taskId: t.id, runId: null, kind: 'note', title: `The user, through the director: ${text.slice(0, 120)}`, passed: null, data: { message: text, finishInMinutes: minutes }, path: null });
      if (until) {
        clearTimeout(this.deadlines.get(t.id));
        const timer = setTimeout(() => {
          this.deadlines.delete(t.id);
          if (this.project !== p || p.tasks.get(t.id)?.status !== 'running' || !this.inflight.has(t.id)) return;
          this.inflight.get(t.id)?.abort();
          p.tasks.setStatus(t.id, 'paused', `Stopped at the time limit the user set (${minutes} min)`, 'user');
          p.audit.event({ kind: 'task.note', severity: 'warning', title: `"${t.title}" was stopped at the ${minutes}-minute limit the user set; its files stay as they are`, taskId: t.id });
        }, minutes! * TELL.minuteMs + TELL.graceMs);
        timer.unref?.();
        this.deadlines.set(t.id, timer);
      }
    }
    if (running.length) p.audit.event({ kind: 'task.note', severity: 'info', title: `Told ${running.length} working agent${running.length === 1 ? '' : 's'}: ${text.slice(0, 160)}${minutes ? ` (finish within ${minutes} min)` : ''}`, detail: { tasks: running.map((t) => ({ id: t.id, title: t.title })), finishInMinutes: minutes } });
    return running;
  }

  /** Plan updates whose hold on older tasks was announced (once each, on the timeline). */
  private readonly heldNoted = new Set<string>();

  private noteHeld(p: ProjectContext, held: Task[], updates: Task[]): void {
    this.lastDecision = `Holding ${held.length} task${held.length === 1 ? '' : 's'} until the plan update finishes, so work the change drops never starts`;
    for (const u of updates) {
      if (this.heldNoted.has(u.id) || !held.some((t) => t.parentId === u.parentId)) continue;
      this.heldNoted.add(u.id);
      p.audit.event({ kind: 'plan.hold', severity: 'info', title: "Holding the goal's waiting tasks until the plan update finishes (it may cancel or reshape them)", taskId: u.id });
    }
  }

  private async execute(p: ProjectContext, task: Task, signal: AbortSignal): Promise<void> {
    switch (task.kind) {
      case 'research':
        return this.doResearch(p, task, signal);
      case 'plan':
        return isDecisionTask(task) ? this.doDecision(p, task, signal) : this.doPlan(p, task, signal);
      default:
        return this.doWork(p, task, signal);
    }
  }

  /** Autonomous permission mode: nothing waits for the user (docs/ARCHITECTURE.md, "Permission modes"). */
  private autonomous(p: ProjectContext): boolean {
    return (this.deps.permissionMode?.(p) ?? 'ask') === 'autonomous';
  }

  /**
   * A stuck task's decision (autonomous.ts): a small planner run that retries it with a different approach, replaces
   * it or drops it. Its summary is the decision; it is applied to the task and shown as a line in the director's chat.
   */
  private async doDecision(p: ProjectContext, task: Task, signal: AbortSignal): Promise<void> {
    task = p.tasks.setStatus(task.id, 'running', 'Deciding what to do about a stuck task', 'executive');
    const directive = 'Decide what happens to the stuck task in your task description, as it says: retry it differently (a summary stating the new approach), or replace or drop it with the plan tools. Do not plan anything else. Return your summary: the decision and why, one or two plain sentences.';
    const outcome = await this.plannerRun(p, task, DECISION_ROLE, signal, directive);
    if (p.tasks.get(task.id)?.status === 'cancelled') return;
    if (!this.checkCompletion(p, task, outcome, 'implement')) return;
    const out = outcome.structured as LivePlanOutput | null;
    const line = applyDecision(p, task, out?.summary ?? '');
    p.tasks.update(task.id, { result: line });
    p.tasks.setStatus(task.id, 'done', 'Decision made', 'executive');
    this.lastDecision = line.slice(0, 160);
    this.kick();
  }

  // ─── Research ──────────────────────────────────────────────────────────────

  private async doResearch(p: ProjectContext, task: Task, signal: AbortSignal): Promise<void> {
    task = p.tasks.setStatus(task.id, 'running', 'Research started', 'researcher');
    const session = p.research.sessionForTask(task.id)?.status === 'open' ? p.research.sessionForTask(task.id)! : p.research.open(task.objective, 'researcher', task.id);
    const researcher = ROLES.researcher!;
    const fresh = () =>
      this.deps.runner.run({
        project: p,
        role: researcher,
        task,
        signal,
        directive: `Research session id: ${session.id}\nRecord sources with research_add_source(session_id="${session.id}", ...) and claims with research_add_claim(session_id="${session.id}", ...). Return your conclusion and reusable findings (reference claim ids where applicable).`,
      });
    const cont = implementerContinuation(p, task, this.deps.providers.forRole(researcher.id).id, this.deps.runner.appVersion);
    const outcome = cont ? await this.continueRun(p, task, researcher, signal, cont, fresh) : await fresh();
    if (!this.checkCompletion(p, task, outcome, 'implement')) return;
    const out = outcome.structured as ResearchOutput | null;
    if (!out?.conclusion) return this.handleFailure(p, task, 'implement', 'Research returned no conclusion', outcome.completion.resultText, outcome.run.id);
    const concluded = p.research.conclude(session.id, {
      conclusion: [out.conclusion, out.possible?.length ? `Possible: ${out.possible.join('; ')}` : '', out.impossible?.length ? `Not possible: ${out.impossible.join('; ')}` : '', out.risks?.length ? `Risks: ${out.risks.join('; ')}` : ''].filter(Boolean).join('\n'),
      actor: 'researcher',
      findings: (out.findings ?? []).map((f) => ({ ...f, confidence: clamp01(f.confidence) })),
    });
    p.tasks.update(task.id, { result: `${out.conclusion}${concluded.knowledgeIds.length ? ` (${concluded.knowledgeIds.length} knowledge entries recorded)` : ''}` });
    p.tasks.addEvidence({ taskId: task.id, runId: outcome.run.id, kind: 'note', title: 'Research concluded', passed: true, data: { sessionId: session.id, knowledgeIds: concluded.knowledgeIds, sources: p.research.sources(session.id).length }, path: null });
    p.tasks.setStatus(task.id, 'done', 'Research concluded with recorded provenance', 'researcher');
  }

  // ─── Planning ──────────────────────────────────────────────────────────────

  private async doPlan(p: ProjectContext, task: Task, signal: AbortSignal): Promise<void> {
    task = p.tasks.setStatus(task.id, 'running', 'Planning started', 'executive');
    const objectiveId = task.parentId;
    if (objectiveId) this.deps.bus.emit('plan.updated', { objectiveId, planTaskId: task.id, status: 'planning' });
    // A triage is a short run (a few turns) at its own effort, not a planning session.
    const triage = isTriagePlan(task);
    const planner: RoleDefinition = triage ? { ...ROLES.executive!, maxTurns: 10, effort: 'medium', ownEffort: true } : ROLES.executive!;
    const noQa = p.settings().autoQa === false ? ' This window has QA passes turned off: add no task whose job is only to test or QA other tasks (the checks and the critic still run on every task).' : '';
    const directive = triage
      ? 'Triage the proposals listed in your task, quickly: add a task with plan_add_task for each real defect or worthwhile follow-up (independent calls together in one turn), cancel every listed proposal with plan_cancel_task, and finish with a one-sentence plain summary of what became a task (or that nothing was needed).'
      : `Plan the request in your task. Add tasks with plan_add_task in dependency order — each starts as soon as the work it depends on exists, while you keep planning. Tasks that do not depend on each other go in together (several plan_add_task calls in one turn); a task goes in after the tasks it depends on. When the plan is complete, return your summary as structured output.${noQa}`;
    const outcome = await this.plannerRun(p, task, planner, signal, directive);
    // The user took the request back (the plan update was cancelled while it ran): nothing to record, and
    // cancel() already told the chat. Tasks it added before stay; cancelling them is the director's call.
    if (p.tasks.get(task.id)?.status === 'cancelled') return;
    if (!this.checkCompletion(p, task, outcome, 'implement')) {
      // Paused, stopped, closing or waiting on a usage limit is not a planning problem.
      const kind = outcome.completion.errorKind;
      const paused = signal.aborted || kind === 'interrupted' || kind === 'rate_limit' || kind === 'environment' || kind === 'max_turns';
      if (objectiveId) this.deps.bus.emit('plan.updated', { objectiveId, planTaskId: task.id, status: paused ? 'paused' : 'failed' });
      return;
    }
    const out = outcome.structured as LivePlanOutput | null;
    const added = p.audit.toolCalls({ runId: outcome.run.id }).filter((c) => /(^|__)plan_add_task$/.test(c.tool) && c.status === 'ok').length;
    // Fallback: tasks returned in the structured result instead of added live.
    // (A triage run under a budget adds its tasks with plan_add_task, where they are counted: none are taken from its result.)
    const fallback = triage && triageKind(task.title) && this.polish() !== 'unlimited' ? [] : (out?.tasks ?? []).filter((t) => !(objectiveId && p.tasks.byPlanKey(objectiveId, t.key)));
    // Whatever the planner left of the proposals it was shown is reviewed: never parked, never triaged twice.
    if (triage) {
      const listed = new Set(listedProposalIds(task.objective));
      for (const t of p.tasks.list({ parentId: objectiveId ?? undefined, statuses: ['proposed'] })) {
        if (t.createdBy !== 'user' && (listed.has(t.id) || (added === 0 && fallback.length === 0 && task.title.startsWith(TRIAGE_PREFIX)))) p.tasks.setStatus(t.id, 'cancelled', CLOSED_AT_TRIAGE, 'executive');
      }
    }
    if (added === 0 && fallback.length === 0 && triage) {
      p.tasks.update(task.id, { result: out?.summary || 'No follow-ups needed.' });
      p.tasks.setStatus(task.id, 'done', 'Follow-ups reviewed; none needed', 'executive');
      return;
    }
    // An automatic "next milestone" with none left to plan: the roadmap is done, not a planner failure.
    if (added === 0 && fallback.length === 0 && objectiveId && isNextMilestone(p.tasks.get(objectiveId) ?? { title: '', objective: '' }) && /roadmap (is )?(complete|done|finished)|no (further |more |remaining )?milestones?/i.test(out?.summary ?? '')) {
      p.tasks.update(task.id, { result: out?.summary });
      p.tasks.setStatus(task.id, 'done', 'The roadmap is complete: no milestone left to plan', 'executive');
      p.tasks.setStatus(objectiveId, 'cancelled', 'The roadmap is complete: no milestone left', 'executive');
      this.deps.bus.emit('plan.updated', { objectiveId, planTaskId: task.id, status: 'done', summary: out?.summary ?? 'The roadmap is complete.', tasks: 0 });
      return;
    }
    // A change to a plan may be all removal ("wrap up now: drop what has not started"), or nothing at all once the
    // planner has looked (the director cancelled it already). That is the update done, not a planner that failed:
    // it was once retried twice, escalated as a repeated failure and closed by a decision run, for a request that
    // asked for no new work.
    if (added === 0 && fallback.length === 0 && task.title.startsWith(UPDATE_PLAN_PREFIX) && (out?.summary ?? '').trim()) {
      const cancelled = p.audit.toolCalls({ runId: outcome.run.id }).filter((c) => /(^|__)plan_cancel_task$/.test(c.tool) && c.status === 'ok').length;
      p.tasks.update(task.id, { result: out!.summary });
      p.tasks.setStatus(task.id, 'done', cancelled ? `Plan updated: ${cancelled} task${cancelled === 1 ? '' : 's'} cancelled, none added` : 'Plan looked at: no change was needed', 'executive');
      if (objectiveId) this.deps.bus.emit('plan.updated', { objectiveId, planTaskId: task.id, status: 'done', summary: out!.summary, tasks: 0 });
      return;
    }
    if (added === 0 && fallback.length === 0) {
      if (objectiveId) this.deps.bus.emit('plan.updated', { objectiveId, planTaskId: task.id, status: 'failed' });
      return this.handleFailure(p, task, 'implement', 'The planner did not add any tasks', JSON.stringify(out)?.slice(0, 2000) ?? null, outcome.run.id);
    }
    const plan: PlanOutput = { summary: out?.summary ?? '', milestone: out?.milestone, risks: out?.risks, tasks: fallback };
    const created = fallback.length ? this.addTasks(p, objectiveId, fallback, 'executive') : [];
    if (typeof created === 'string') return this.handleFailure(p, task, 'implement', `Invalid plan: ${created}`, JSON.stringify(out)?.slice(0, 4000) ?? null, outcome.run.id);
    const total = added + created.length;
    p.governance.addDecision({
      title: `Plan: ${task.title.replace(/^Plan:\s*/, '')}`,
      context: task.objective,
      decision: `${plan.summary}\n\nTasks: ${total}`,
      consequences: plan.risks?.length ? `Risks: ${plan.risks.join('; ')}` : 'None recorded',
      status: 'accepted',
      createdBy: 'executive',
      taskId: task.id,
    });
    p.tasks.update(task.id, { result: `${plan.summary} (${total} tasks)` });
    p.tasks.setStatus(task.id, 'done', `Plan accepted with ${total} tasks`, 'executive');
    this.lastDecision = `Plan created: ${total} tasks`;
    if (objectiveId) this.deps.bus.emit('plan.updated', { objectiveId, planTaskId: task.id, status: 'done', summary: plan.summary, milestone: plan.milestone, tasks: total });
    this.resumeIfPlanned(p, task);
  }

  /**
   * Adds planned tasks under a parent (an objective): checked as a graph (keys, acceptance criteria,
   * dependsOn, no cycles), verification normalized (static analysis and the critic always), dependencies
   * by key (keys of tasks added earlier under the same parent count too). Returns the created tasks in
   * dependency order, or what is wrong with them. The planner's structured result and the director's
   * iterations both come through here.
   */
  addTasks(p: ProjectContext, parentId: string | null, specs: PlanTaskSpec[], createdBy: string): Task[] | string {
    const order = validatePlan({ summary: '', tasks: specs.map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).filter((k) => specs.some((f) => f.key === k)) })) });
    if (typeof order === 'string') return order;
    // A dependency on a task that was cancelled can never be met: the new task would sit blocked.
    if (parentId)
      for (const t of specs)
        for (const k of t.dependsOn ?? []) {
          if (specs.some((f) => f.key === k)) continue;
          if (p.tasks.byPlanKey(parentId, k)?.status === 'cancelled') return `task "${t.key}" depends on "${k}", which was cancelled and can never complete: depend on the task that replaced it, or on nothing`;
        }
    // A probe that runs on the wrong side (server code reading the LocalPlayer, say) could never pass: refused here as in plan_add_task.
    for (const t of specs) {
      const refused = lintChecks(normalizeVerification(t.verification, t.kind));
      if (refused) return `task "${t.key}": ${refused}`;
    }
    const keyToId = new Map<string, string>();
    const settings = p.settings();
    const out: Task[] = [];
    for (const t of order) {
      const idOf = (k: string) => keyToId.get(k) ?? (parentId ? p.tasks.byPlanKey(parentId, k)?.id : undefined);
      const created = p.tasks.create({
        parentId,
        kind: t.kind,
        title: t.title,
        objective: t.objective,
        reason: t.reason ?? '',
        role: ROLES[t.role] ? t.role : t.kind === 'research' ? 'researcher' : 'roblox-engineer',
        status: 'ready',
        priority: typeof t.priority === 'number' ? Math.max(0, Math.min(100, Math.round(t.priority))) : 50,
        acceptanceCriteria: t.acceptanceCriteria,
        verification: normalizeVerification(t.verification, t.kind),
        requiredSkills: t.requiredSkills ?? [],
        files: t.files ?? [],
        robloxSystems: t.robloxSystems ?? [],
        dependencies: (specs.find((f) => f.key === t.key)?.dependsOn ?? []).map(idOf).filter((x): x is string => !!x),
        // The dependencies it must see reviewed first (final test and QA tasks); the rest only need their work to exist.
        strictDependencies: (t.strictDependsOn ?? []).map(idOf).filter((x): x is string => !!x),
        createdBy,
        maxAttempts: settings.maxAttemptsPerTask,
        planKey: t.key,
      });
      keyToId.set(t.key, created.id);
      out.push(created);
    }
    this.warnAboutDependencies(p, parentId, out, keyToId);
    return out;
  }

  /**
   * Dependencies that only add waiting (a chain deeper than 3, assets behind code, QA behind QA: see
   * plan-checks.ts) and folders two tasks both claim. This batch path has no planner to tell mid-turn, so
   * they go to the timeline.
   */
  private warnAboutDependencies(p: ProjectContext, parentId: string | null, created: Task[], keyToId: Map<string, string>): void {
    if (!parentId || created.length === 0) return;
    const nodes = planNodes(p.tasks.list({ parentId }), new Map([...keyToId].map(([key, id]) => [id, key])));
    const warnings = created.flatMap((t) => [...dependencyWarnings(nodes.get(t.id)!, nodes), ...strictWarnings(nodes.get(t.id)!, nodes), ...claimWarnings(nodes.get(t.id)!, nodes, dirTest(p.root))]);
    if (!warnings.length) return;
    p.audit.event({
      kind: 'plan.warning',
      severity: 'warning',
      title: `Plan check: ${warnings.length} ${warnings.some((w) => w.code === 'shared-folder') ? '' : 'dependency '}warning${warnings.length === 1 ? '' : 's'} (${[...new Set(warnings.map((w) => w.code))].join(', ')})`,
      taskId: parentId,
      detail: { warnings: warnings.map((w) => w.message) },
    });
  }

  /**
   * A quick iteration: the director specified the few tasks a small change needs (a tweak, a fix, a
   * small feature on an existing game), so they start at once — no research or planner run. They get
   * the same checks as planned work (static analysis, the critic, and the Studio checks each asks for),
   * and the wrap-up is light: the regression suite and a checkpoint, no follow-up triage, milestone
   * offer or report. Runs alongside any goal in progress.
   */
  submitIteration(input: { title: string; description: string; steps: PlanTaskSpec[] }): Task | string {
    const p = this.requireProject();
    if (!input.steps.length) return 'an iteration needs at least one step';
    if (input.steps.length > MAX_ITERATION_STEPS) return `an iteration has at most ${MAX_ITERATION_STEPS} steps (this one has ${input.steps.length}): plan it as a goal`;
    const check = validatePlan({ summary: '', tasks: input.steps });
    if (typeof check === 'string') return check;
    const objective = p.tasks.create({
      kind: 'objective',
      title: input.title,
      objective: input.description,
      reason: ITERATION_REASON,
      role: 'executive',
      status: 'running',
      acceptanceCriteria: [],
      createdBy: 'director',
      maxAttempts: p.settings().maxAttemptsPerTask,
    });
    const added = this.addTasks(p, objective.id, input.steps.map((s) => ({ ...s, reason: s.reason || 'Part of a quick iteration the user asked for.' })), 'director');
    if (typeof added === 'string') return added;
    p.audit.event({ kind: 'objective.submitted', severity: 'info', title: `Iteration: ${input.title} (${added.length} task${added.length === 1 ? '' : 's'})`, taskId: objective.id, role: 'director' });
    this.lastDecision = `Quick iteration "${input.title}": ${added.length} task${added.length === 1 ? '' : 's'}, no planning pass`;
    this.kick();
    this.emitState();
    return objective;
  }

  /**
   * The user asked for a change while the objective is being built: a new planning step adds tasks
   * (which may depend on existing ones) and cancels obsolete ones, without stopping running work.
   */
  amendPlan(objectiveId: string, request: string): Task {
    const p = this.requireProject();
    const obj = p.tasks.require(objectiveId);
    if (obj.status === 'verifying' || obj.status === 'verified' || obj.status === 'done') {
      // A finished (or finishing) objective reopens so the new work is part of it.
      p.tasks.setStatus(obj.id, 'ready', 'Reopened for a change requested by the user', 'user');
    }
    const plan = p.tasks.create({
      parentId: objectiveId,
      kind: 'plan',
      title: `${UPDATE_PLAN_PREFIX}${request.length > 60 ? `${request.slice(0, 57)}…` : request}`,
      objective: `The user asked for a change while the game is being built:\n\n${request}\n\nThe objective already has tasks (see task_list with parent_id ${objectiveId}): keep finished work and running work the change doesn't touch, add the tasks this change needs (they may depend on existing task ids or plan keys), and cancel the tasks it makes obsolete. Work the change replaces (the user wants something redone, reworked or dropped) is stopped now, even while it runs or is in review: add the new version first, then plan_cancel_task the old one with stop: true and replaced_by the new one, so the new version starts at once instead of after the old one finishes. Never make the new version wait for the work it replaces.`,
      reason: 'Requested by the user during the build.',
      role: 'executive',
      status: 'ready',
      priority: 95,
      acceptanceCriteria: ['The change is covered by concrete tasks with verification', 'Obsolete not-started tasks are cancelled'],
      createdBy: 'user',
      maxAttempts: 2,
    });
    p.audit.event({ kind: 'plan.amend', severity: 'info', title: `Plan change requested: ${request.slice(0, 120)}`, taskId: objectiveId, role: 'user' });
    this.kick();
    this.emitState();
    return plan;
  }

  // ─── Implementation → verification → critique → repair ────────────────────

  private async doWork(p: ProjectContext, task: Task, signal: AbortSignal): Promise<void> {
    const role = roleFor(task.role);
    const resumed = this.resumableWork(p, task);
    let work: WorkOutput;
    let runId: string;
    let editedFiles: string[] = [];
    let changes: Awaited<ReturnType<ProjectContext['git']['changesSince']>> | null = null;
    let dmDiff = '';
    if (resumed) {
      // A restart cut off the checks of finished work: check that work instead of redoing it.
      task = p.tasks.setStatus(task.id, 'running', 'Resuming at verification: the work finished before the restart', 'executive');
      task = p.tasks.setStatus(task.id, 'implemented', resumed.work.summary.slice(0, 300), role.id);
      work = resumed.work;
      runId = resumed.runId;
    } else {
      p.tasks.setResumeRun(task.id, null);
      const othersActive = [...this.inflight.keys()].some((id) => id !== task.id);
      const pre = await p.git.checkpoint({ label: `before "${task.title}" (attempt ${task.attempts + 1})`, kind: 'pre_task', taskId: task.id, commit: !othersActive }).catch((e) => {
        this.deps.log.warn('Pre-task checkpoint failed', e);
        return null;
      });
      const before = await this.snapshot(p);
      const startsBefore = this.starts;
      const othersBefore = this.inflight.size > 1;
      // Stopped while the checkpoint and snapshot ran: no agent is started for it (it stays ready).
      if (signal.aborted) return;
      task = p.tasks.setStatus(task.id, 'running', `Assigned to ${role.name}`, 'executive');
      // Whose files are whose in the folders this task shares with other running tasks (file-claims.ts).
      const sharing = sharedFolderNote(p, task, [...this.inflight.keys()].map((id) => p.tasks.get(id)).filter((t): t is Task => !!t));
      // Prerequisites whose work exists but is still being checked (this task started on it: dependencyMet).
      const unreviewed = task.dependencies.map((id) => p.tasks.get(id)).filter((d): d is Task => !!d && !COMPLETE.has(d.status));
      const early = unreviewed.length
        ? `Prerequisites still being checked: ${unreviewed.map((d) => `"${d.title}"`).join(', ')}. ${unreviewed.length === 1 ? 'Its' : 'Their'} work is on disk and in Studio: build on it as it is and don't wait for ${unreviewed.length === 1 ? 'its' : 'their'} review. If one is reworked while you work, a tool result tells you what changed.`
        : '';
      // A task the user reopened (still broken) reproduces the problem before it changes anything (reopen.ts).
      const reopenedNow = openReopen(p, task);
      const extra = [reopenedNow ? reopenBrief(reopenedNow.report) : '', early, sharing].filter(Boolean).join('\n\n');
      this.pendingNotes.delete(task.id);
      const fresh = () =>
        this.deps.runner.run({
          project: p,
          role,
          task,
          signal,
          notes: () => this.takeNotes(task.id),
          directive: `Implement your task${task.attempts > 1 ? ` (attempt ${task.attempts}: fix the problems listed under "Previous attempts")` : ''}. When finished, make sure code is synced into Studio (roblox_sync_push) and luau_check is clean, observe the result, then return the structured result.${extra ? `\n\n${extra}` : ''}`,
        });
      // A task that comes back (rejected, out of turns, interrupted) continues its agent's own session.
      const cont = implementerContinuation(p, task, this.deps.providers.forRole(role.id).id, this.deps.runner.appVersion);
      const outcome = cont ? await this.continueRun(p, task, role, signal, extra ? { ...cont, brief: `${cont.brief}\n\n${extra}` } : cont, fresh) : await fresh();
      // A note its agent never read (no tool call after it) reaches the reviewer instead (see critique notes below).
      this.pendingNotes.delete(task.id);
      if (!this.checkCompletion(p, task, outcome, 'implement')) return;
      if (signal.aborted) return this.interrupted(p, task);
      const out = outcome.structured as WorkOutput | null;
      if (!out) return this.handleFailure(p, task, 'implement', 'Agent returned no structured result', outcome.completion.resultText, outcome.run.id);
      work = out;
      runId = outcome.run.id;
      editedFiles = outcome.editedFiles;
      this.recordAgentKnowledge(p, task, work);
      if (work.status === 'blocked' && this.autonomous(p)) {
        // Nobody is asked: the planner decides (retry differently, replace, drop) and the director's chat says what it decided.
        p.tasks.update(task.id, { result: work.summary });
        const r = handOff(p, task, { reason: 'blocked', summary: work.summary, detail: (work.blockers ?? []).map((b) => `- ${b}`).join('\n') || null, runId });
        this.lastDecision = r.outcome === 'deciding' ? `"${task.title}" is blocked: the planner is deciding what to do` : `"${task.title}" is blocked: ${r.outcome === 'retried' ? 'retrying it a different way' : 'dropped'}`;
        this.kick();
        return;
      }
      if (work.status === 'blocked') {
        p.governance.escalate({ kind: 'capability_missing', title: `Blocked: ${task.title}`, detail: `${work.summary}\n\nBlockers:\n${(work.blockers ?? []).map((b) => `- ${b}`).join('\n')}`, taskId: task.id, runId, options: ['retry', 'cancel'] });
        p.tasks.update(task.id, { result: work.summary });
        p.tasks.setStatus(task.id, 'escalated', 'Agent reported a blocker', role.id);
        return;
      }
      if (work.status === 'failed') return this.handleFailure(p, task, 'implement', work.summary, (work.blockers ?? []).join('\n') || null, runId);

      // OBSERVE: what actually changed on disk and in the DataModel.
      task = p.tasks.setStatus(task.id, 'implemented', work.summary.slice(0, 300), role.id);
      p.tasks.setResumeRun(task.id, runId);
      // The work exists: what waits for it starts now, on what it produced, while its checks and review go on
      // (TaskGraph dependencyMet). Dependents already at work on an earlier version are told what changed.
      p.tasks.update(task.id, { result: work.summary });
      this.noteRework(p, task, work, [...new Set([...(work.filesChanged ?? []), ...editedFiles.map((f) => relative(p.root, f).split(sep).join('/')).filter((f) => !f.startsWith('..'))])]);
      this.kick();
      changes = pre ? await p.git.changesSince(pre.commitSha).catch(() => null) : null;
      if (changes) p.tasks.addEvidence({ taskId: task.id, runId, kind: 'diff', title: `Code changes (${changes.files.length} files)`, passed: null, data: changes, path: null });
      const after = await this.snapshot(p);
      if (before && after) {
        const d = diffSnapshots(before, after);
        // With other agents in the place at the same time, the diff includes their changes (a modeler
        // rebuilding its kit looks like this task removed it): it can't be blamed on this task.
        const shared = othersBefore || this.starts !== startsBefore || this.inflight.size > 1;
        dmDiff = `${shared ? '(Other agents were working in the place at the same time: this may include their changes.)\n' : ''}${renderDiff(d, 30)}`;
        const file = join(p.dir, 'snapshots', `${task.id}-${task.attempts}.json`);
        try {
          writeFileSync(file, JSON.stringify({ ...diffEvidence(before, after, d), diff: d }), 'utf8');
        } catch {
          /* evidence file is best-effort */
        }
        p.tasks.addEvidence({ taskId: task.id, runId, kind: 'datamodel_snapshot', title: `DataModel: ${d.summary}`, passed: null, data: { summary: d.summary, added: d.added.slice(0, 200), removed: d.removed.slice(0, 200), changed: d.changed.slice(0, 200) }, path: file });
        // Safety net: arbitrary Luau can delete world content. Large removals are destructive operations.
        if (d.removed.length >= 25 && shared) this.deps.log.info(`"${task.title}": ${d.removed.length} instances gone from the place while other agents were working; not asking (the diff isn't this task's alone)`);
        // A snapshot cut at its cap (or taken while the place changed) says nothing about what was deleted.
        if (d.removed.length >= 25 && d.unreliable) this.deps.log.info(`"${task.title}": ${d.removed.length} instances missing from a cut or unstable snapshot; not asking`);
        // Looked at again a few seconds later: what a rebuild in progress had taken out is back by then.
        const gone = d.removed.length >= 25 && !shared && !d.unreliable && p.settings().escalation.destructiveOperations !== 'allow' ? await this.stillRemoved(p, d.removed, signal) : [];
        if (gone.length >= 25) {
          const rule = p.settings().escalation.destructiveOperations;
          if (rule !== 'allow') {
            const removal = {
              kind: (rule === 'ask' ? 'approval' : 'question') as 'approval' | 'question',
              title: `${task.title} removed ${gone.length} instances from the place`,
              detail: [
                `DataModel snapshot comparison shows ${gone.length} instances removed (showing up to 40):`,
                ...gone.slice(0, 40),
                '',
                `Before/after snapshots: ${file}`,
                'If this was not intended, undo in Studio (Ctrl+Z) or rebuild from world/ scripts before approving.',
              ].join('\n'),
              taskId: task.id,
              runId,
              options: rule === 'ask' ? ['approve', 'reject'] : ['ok'],
            };
            // Autonomous: approved on the spot and logged (the checks and the critic look at the result next); nothing parks the task.
            const auto = this.autonomous(p);
            if (auto) p.governance.autoResolve({ ...removal, options: [], response: `Went ahead (autonomous mode): the checks and the critic review the result next; the before/after snapshots are kept in the task's evidence.` });
            else p.governance.escalate(removal);
            if (rule === 'ask' && !auto) {
              p.tasks.setStatus(task.id, 'escalated', `Removed ${gone.length} instances; waiting for approval`);
              return;
            }
          }
        }
      }
    }

    // A reopened task's work counts only once the reported problem was shown in Studio (reopen.ts): otherwise it is sent
    // back before its checks, which passed before and did not catch the problem.
    const reopened = openReopen(p, task);
    if (reopened && !reproduced(p, task.id, reopened.at)) {
      return this.handleFailure(p, task, 'verify', NOT_REPRODUCED, `${reopenBrief(reopened.report)}\n\nNothing on this task shows the problem happening after it was reopened: no failing check and no evidence recorded with passed: false.`, runId);
    }

    // A user may have paused the task while observations or snapshots were running.
    if (signal.aborted || p.tasks.get(task.id)?.status === 'paused') return this.interrupted(p, task);

    // TEST.
    const checksFrom = nowIso();
    task = p.tasks.setStatus(task.id, 'verifying', 'Running automated verification');
    const scopeFiles = [...new Set([...task.files, ...editedFiles.map((f) => relative(p.root, f)).filter((f) => !f.startsWith('..'))])];
    // The files the agent says it changed are checked too (a file written through the shell isn't in editedFiles):
    // one that doesn't compile fails the task, whatever its other checks say.
    const reported = (work.filesChanged ?? []).map((f) => (isAbsolute(f) ? relative(p.root, f) : f).split(sep).join('/').replace(/^\.\//, '')).filter((f) => f && !f.startsWith('..'));
    const report = await this.deps.verifier.verify(p, task, runId, scopeFiles, signal, reported);
    if (signal.aborted) return this.interrupted(p, task);
    if (!report.passed) {
      return this.handleFailure(p, task, 'verify', `Verification failed: ${report.summary}`, report.results.filter((r) => r.passed === false).map((r) => `[${r.name}]\n${r.output}`).join('\n\n').slice(0, 8000), runId);
    }

    // CRITIQUE (independent agent).
    task = p.tasks.setStatus(task.id, 'reviewing', `Automated checks passed (${report.summary}); critic reviewing`);
    // A prerequisite that was reworked while this task ran: the reviewer checks the work still fits it.
    const reworked = p.tasks
      .evidence(task.id)
      .filter((e) => e.kind === 'note' && e.title.startsWith(REWORK_NOTE))
      .map((e) => `Prerequisite ${e.title.slice(REWORK_NOTE.length + 2)} was reworked while this task ran (${String((e.data as { summary?: string } | null)?.summary ?? '').slice(0, 300)}): check that this work fits what that task is now.`)
      .join('\n');
    const light = reopened ? null : lightReview(task, editedFiles.map((f) => relative(p.root, f)), report.results);
    const reopenNote = reopened ? `\nThis task was finished and the user reported it STILL BROKEN: "${reopened.report.slice(0, 600)}". Pass it only when the evidence shows that problem reproduced in Studio after the report and fixed now (the same check failing, then passing).` : '';
    if (light) p.audit.event({ kind: 'review.skipped', severity: 'info', title: `"${task.title}": ${light.why}`, taskId: task.id, runId });
    const judged = light
      ? { review: { verdict: 'pass', summary: light.why, criteria: [], defects: [], visualCheck: 'not_needed' } as ReviewOutput, cut: null }
      : await this.critique(p, task, signal, `Implementer summary: ${work.summary}\nAutomated verification: ${report.summary}\n${changes ? `Changed files: ${changes.files.join(', ')}\n${changes.stat}` : ''}\n${dmDiff ? `DataModel changes:\n${dmDiff}` : ''}${reworked ? `\n${reworked}` : ''}${amendmentNotes(p, task.id) ? `\n\n${amendmentNotes(p, task.id)}` : ''}${reopenNote}`);
    if (signal.aborted) return this.interrupted(p, task);
    const review = judged.review;
    if (!review && judged.cut) return this.reviewCutOff(p, task, judged.cut);
    if (!review) return this.handleFailure(p, task, 'review', 'Critic did not return a review', null, null);
    if (review.verdict !== 'pass') {
      const defects = review.defects.map((d) => `- [${d.severity}/${d.area}] ${d.title}: ${d.detail}${d.file ? ` (${d.file})` : ''}\n  Fix: ${d.fix}`).join('\n');
      const unmet = review.criteria.filter((c) => !c.met).map((c) => `- Unmet: ${c.criterion} — ${c.evidence}`).join('\n');
      return this.handleFailure(p, task, 'review', `Critic rejected: ${review.summary}`, `${unmet}\n${defects}`.trim(), null);
    }

    // VERIFY + DOCUMENT + CHECKPOINT.
    // Passed, but nobody saw it (Studio wasn't drawing): the work goes on, and its looks are reviewed later (visual-checks.ts).
    const unseen = passedUnseen(p, task, review, checksFrom, p.tasks.evidence(task.id).filter((e) => e.kind === 'critic_review').at(-1)?.runId ?? null);
    p.tasks.update(task.id, { result: `${work.summary}\n\nReview: ${review.summary}${unseen ? `\n\n${PENDING_LINE}` : ''}` });
    if (unseen) {
      p.tasks.addEvidence({ taskId: task.id, runId: null, kind: 'note', title: VISUAL_PENDING, passed: null, data: { reason: "Studio wasn't drawing when the task was checked and reviewed" }, path: null });
      p.audit.event({ kind: 'visual.pending', severity: 'warning', title: `"${task.title}" passed without a visual check (Studio wasn't drawing): its looks are reviewed when Studio can draw again`, taskId: task.id });
    }
    // What the agents saw outside the task is filed before the task counts as complete: the objective's wrap-up
    // starts the moment its last task is verified, and must find these (it used to miss the last task's).
    // Every defect is filed; of the optional ideas only the first MAX_POLISH_PER_RUN of the run that did the work
    // (agents filed about five a task, a goal takes on a handful in all: proposal-triage.ts FOLLOW_UP_BUDGET), and
    // none of the reviewer's: it filed 211 and 206 follow-ups in 160 and 145 reviews of two builds, the largest
    // source of the polish that kept those builds from ending. A reviewer judges; it reports defects only.
    for (const [list, by, most] of [[review.followUps ?? [], 'critic', 0], [work.followUps ?? [], role.id, MAX_POLISH_PER_RUN]] as const) {
      let ideas = 0;
      for (const f of list) {
        if (typeof f !== 'string') continue;
        if (!classifyFollowUp(f).defect && ++ideas > most) continue;
        this.proposeFollowUp(p, task, f, by);
      }
    }
    p.tasks.setStatus(task.id, 'verified', light ? `Checks passed: ${review.summary.slice(0, 200)}` : `Critic passed: ${review.summary.slice(0, 200)}`, light ? 'executive' : 'critic');
    // With other tasks mid-edit, committing now would capture their half-finished files: reference HEAD
    // instead; the objective-level checkpoint commits everything once the work is verified together.
    const othersBusy = [...this.inflight.keys()].some((id) => id !== task.id);
    await p.git.checkpoint({ label: `verified "${task.title}"`, kind: 'verified', taskId: task.id, runId, commit: !othersBusy }).catch((e) => this.deps.log.warn('Verified checkpoint failed', e));
    this.worldCheckpoint(p, task);
    p.tasks.setStatus(task.id, 'done', 'Acceptance criteria verified and review passed', 'executive');
    p.tasks.setResumeRun(task.id, null);
    // Knowledge learned during work that then passed verification and review is validated by it.
    for (const k of this.deps.knowledge.byTask(task.id)) {
      if (!k.validatedAt) this.deps.knowledge.validate(k.id, `Validated by verified task "${task.title}" (${task.id}): automated checks + critic PASS`, Math.max(k.confidence, 0.75));
    }
    p.exportState();
  }

  /** The finished implementation a task can be re-checked from (see TaskGraph.setResumeRun). */
  private resumableWork(p: ProjectContext, task: Task): { runId: string; work: WorkOutput } | null {
    const runId = p.tasks.resumeRun(task.id);
    if (!runId) return null;
    const row = p.store.get<{ status: string; result_data: string | null }>('SELECT status, result_data FROM runs WHERE id = ?', [runId]);
    const work = row?.status === 'completed' && row.result_data ? pj<WorkOutput | null>(row.result_data, null) : null;
    if (work?.status !== 'implemented' || !work.summary) {
      p.tasks.setResumeRun(task.id, null);
      return null;
    }
    return { runId, work };
  }

  /**
   * The review never happened, and not because of the work: the reviewer met a usage limit, or its agent runtime
   * could not start. In a two-build night every account reached its limit at once; the reviews that were cut off
   * (0 turns) counted as "Critic did not return a review", a failed attempt each, and finished, checked work was
   * to be done again when the limit reset. The task goes back in line with its work kept (doWork resumes at the
   * checks: resumableWork) and the attempt doesn't count.
   */
  private reviewCutOff(p: ProjectContext, task: Task, cut: { kind: 'rate_limit' | 'environment'; error: string | null }): void {
    p.tasks.refundAttempt(task.id);
    if (cut.kind === 'rate_limit') {
      p.tasks.setStatus(task.id, 'ready', 'Usage limit reached during the review; it is reviewed when an account has room');
      this.kick();
      return;
    }
    p.tasks.setStatus(task.id, 'ready', 'The reviewer could not start; the review will be retried');
    this.holdForEnvironment(p, cut.error);
  }

  /** The agent runtime could not start: hold all new runs for a while (backing off) and say so once. */
  private holdForEnvironment(p: ProjectContext, error: string | null | undefined): void {
    this.envBackoffMs = Math.min(300_000, this.envBackoffMs ? this.envBackoffMs * 2 : 20_000);
    this.envBlockedUntil = Date.now() + this.envBackoffMs;
    const reason = (error ?? 'unknown error').split('\n')[0]!.slice(0, 240);
    this.lastDecision = `Agents can't start: ${reason}`;
    if (this.lastEnvError !== reason) {
      this.lastEnvError = reason;
      p.audit.event({ kind: 'provider.environment', severity: 'error', title: `Agents can't start right now; retrying automatically. ${reason}`.slice(0, 300), detail: { error } });
    }
  }

  /** `cut`: why there is no review when that is not the work's doing (a usage limit, an agent runtime that could not start). */
  private async critique(p: ProjectContext, task: Task, signal: AbortSignal, notes: string, again = true): Promise<{ review: ReviewOutput | null; cut: { kind: 'rate_limit' | 'environment'; error: string | null } | null }> {
    const critic = ROLES.critic!;
    // Every account at its limit: no review is started only to fail (the work is reviewed after the reset).
    if (!this.roomFor(critic.id)) return { review: null, cut: { kind: 'rate_limit', error: 'Every account is at its usage limit' } };
    const fresh = () =>
      this.deps.runner.run({
        project: p,
        role: critic,
        task,
        signal,
        directive: `Independently review the work done for your task. Judge it against every acceptance criterion using real evidence (files, git_diff, Studio state, recorded evidence).\n\n${notes}`,
      });
    // A repair is re-reviewed in the critic's own review session: it knows what it asked for.
    const cont = again ? criticContinuation(p, task, this.deps.providers.forRole(critic.id).id, this.deps.runner.appVersion, notes) : null;
    const outcome = cont ? await this.continueRun(p, task, critic, signal, cont, fresh) : await fresh();
    const review = outcome.completion.ok ? (outcome.structured as ReviewOutput | null) : null;
    if (review) {
      p.tasks.addEvidence({ taskId: task.id, runId: outcome.run.id, kind: 'critic_review', title: `Critic: ${review.verdict.toUpperCase()} — ${review.summary.slice(0, 120)}`, passed: review.verdict === 'pass', data: review, path: null });
    }
    const kind = outcome.completion.ok ? null : outcome.completion.errorKind;
    const cut = kind === 'rate_limit' ? ('rate_limit' as const) : kind === 'environment' || (kind === 'auth' && this.autonomous(p)) ? ('environment' as const) : null;
    return { review, cut: !review && cut ? { kind: cut, error: outcome.completion.error ?? null } : null };
  }

  /** Run `cont` (a continued session); if that session can't be picked up, run `fresh` instead. */
  /**
   * A planning job (a plan, a plan update, a triage, a decision). Its own interrupted session carries on first; otherwise it
   * continues the project's planner conversation (planner-session.ts) with a message that says what changed since the
   * planner's last turn; with none to continue (or when continuing fails) it starts fresh with a full context package.
   */
  private async plannerRun(p: ProjectContext, task: Task, role: RoleDefinition, signal: AbortSignal, directive: string): Promise<RunOutcome> {
    const fresh = () => this.deps.runner.run({ project: p, role, task, signal, directive });
    const providerId = this.deps.providers.forRole(role.id).id;
    const own = implementerContinuation(p, task, providerId, this.deps.runner.appVersion);
    if (own) return this.continueRun(p, task, role, signal, own, fresh);
    const session = plannerSession(p, providerId, this.deps.runner.appVersion);
    if (!session) return fresh();
    return this.continueRun(p, task, role, signal, { runId: session.runId, sessionId: session.sessionId, reason: 'finish', brief: plannerBrief(p, task, directive, session.since) }, fresh);
  }

  private async continueRun(p: ProjectContext, task: Task, role: RoleDefinition, signal: AbortSignal, cont: Continuation, fresh: () => Promise<RunOutcome>): Promise<RunOutcome> {
    const outcome = await this.deps.runner.run({ project: p, role, task, signal, directive: cont.brief, resumeSessionId: cont.sessionId, continuesRunId: cont.runId, ...(role.id === task.role ? { notes: () => this.takeNotes(task.id) } : {}) });
    if (!couldNotContinue(outcome.completion, signal.aborted)) return outcome;
    p.audit.event({
      kind: 'run.notice',
      severity: 'info',
      title: `${role.name} couldn't continue its earlier session (${(outcome.completion.error ?? 'no reply').split('\n')[0]!.slice(0, 160)}); starting fresh`,
      runId: outcome.run.id,
      taskId: task.id,
      role: role.id,
    });
    return fresh();
  }

  /** Returns false (and handles it) when the provider run did not complete successfully. */
  private checkCompletion(p: ProjectContext, task: Task, outcome: RunOutcome, stage: 'implement'): boolean {
    const c = outcome.completion;
    // A pause requested while the provider was finishing takes precedence even
    // if the provider returned a successful answer after the abort.
    if (p.tasks.get(task.id)?.status === 'paused') return false;
    if (c.ok) {
      this.envBackoffMs = 0;
      this.lastEnvError = null;
      return true;
    }
    if (c.errorKind === 'interrupted') {
      this.interrupted(p, task);
      return false;
    }
    if (c.errorKind === 'rate_limit') {
      // A usage limit is not the task's fault: give the attempt back and wait (or switch accounts).
      // (The runner already recorded the limit for this account.)
      p.tasks.refundAttempt(task.id);
      p.tasks.setStatus(task.id, 'ready', 'Usage limit reached; will continue when an account has room');
      this.kick();
      return false;
    }
    // A sign-in problem is not the task's fault either, and in autonomous mode it parks nothing on a question card: it
    // is handled like an agent runtime that can't start (retried with backoff, said once in the director's chat).
    if (c.errorKind === 'environment' || (c.errorKind === 'auth' && this.autonomous(p))) {
      // The agent runtime could not start: not the task's fault, so the attempt doesn't count. Hold all
      // new runs for a while (backing off) and say so once instead of failing every task in turn.
      p.tasks.refundAttempt(task.id);
      p.tasks.setStatus(task.id, 'ready', 'Agent runtime could not start; will retry');
      this.holdForEnvironment(p, c.error);
      return false;
    }
    if (c.errorKind === 'max_turns') {
      // A big task ran out of turns: that is progress, not failure. Continue in a fresh run (its work is
      // on disk), up to twice, before it counts as a failed attempt.
      const continued = p.tasks.failures(task.id).filter((f) => f.stage === 'provider' && f.summary.startsWith(TURN_LIMIT)).length;
      if (continued < 2) {
        p.tasks.addFailure({ taskId: task.id, runId: outcome.run.id, attempt: task.attempts, stage: 'provider', summary: `${TURN_LIMIT}: continue from where the previous run stopped. Its work is on disk: check git_diff, the files and recorded evidence first, and don't redo finished parts.`, detail: null });
        p.tasks.refundAttempt(task.id);
        p.tasks.setStatus(task.id, 'ready', 'Reached its turn limit; continuing in a fresh run');
        this.lastDecision = `"${task.title}" continues in a fresh run (turn limit)`;
        return false;
      }
    }
    if (c.errorKind === 'auth') {
      p.governance.escalate({ kind: 'capability_missing', title: 'AI provider authentication failed', detail: c.error ?? 'Authentication error', taskId: task.id, runId: outcome.run.id, options: ['retry'] });
      p.tasks.setStatus(task.id, 'failed', 'Provider authentication failed');
      p.tasks.setStatus(task.id, 'escalated', 'Waiting for the user to fix provider authentication');
      return false;
    }
    this.handleFailure(p, task, stage, `Agent run failed (${c.errorKind ?? 'error'}): ${(c.error ?? '').slice(0, 300)}`, c.error, outcome.run.id);
    return false;
  }

  private interrupted(p: ProjectContext, task: Task): void {
    const cur = p.tasks.get(task.id);
    const atLimit = this.stoppedAtLimit.delete(task.id);
    if (!cur || TERMINAL.has(cur.status) || cur.status === 'paused') return;
    if (atLimit) {
      // Stopped at the usage limit (standDownForLimit): not the task's doing.
      p.tasks.refundAttempt(task.id);
      p.tasks.setStatus(task.id, 'ready', 'Usage limit reached during its checks; they run again when an account has room');
      return;
    }
    p.tasks.setStatus(task.id, 'ready', 'Interrupted; will resume');
  }

  private handleFailure(p: ProjectContext, task: Task, stage: 'implement' | 'verify' | 'review' | 'provider' | 'capability', summary: string, detail: string | null, runId: string | null): void {
    const cur = p.tasks.require(task.id);
    p.tasks.setResumeRun(task.id, null);
    p.tasks.addFailure({ taskId: task.id, runId, attempt: cur.attempts, stage, summary: summary.slice(0, 1000), detail: detail?.slice(0, 12000) ?? null });
    if (cur.status !== 'failed') p.tasks.setStatus(task.id, 'failed', summary.slice(0, 300));
    // Studio wasn't there (closed, reopening, not connected): not the task's failure, and the attempt is given back (a few
    // times, so a Studio that stays away doesn't loop). The user's prioritised sign fix once spent its last attempt in one
    // second with no Studio connected, and was dropped.
    if (STUDIO_AWAY.test(`${summary}\n${detail ?? ''}`) && p.tasks.failures(task.id).filter((f) => STUDIO_AWAY.test(`${f.summary}\n${f.detail ?? ''}`)).length <= 3) {
      p.tasks.refundAttempt(task.id);
      p.tasks.setStatus(task.id, 'ready', 'Studio was not available; this attempt does not count');
      this.lastDecision = `"${task.title}" waits for Studio (the attempt does not count)`;
      return;
    }
    if (cur.attempts < cur.maxAttempts) {
      p.tasks.setStatus(task.id, 'ready', `Repair attempt ${cur.attempts + 1}/${cur.maxAttempts} scheduled`);
      this.lastDecision = `Repairing "${task.title}" (attempt ${cur.attempts + 1})`;
      return;
    }
    // Out of attempts: what it left behind is not something to start new work on (running dependents carry on).
    p.tasks.clearLanded(task.id);
    // A decision that could not be made settles itself (retry once with a note, then drop): never a decision about a decision.
    if (isDecisionTask(cur)) {
      decisionFailed(p, cur, summary);
      p.tasks.setStatus(cur.id, 'cancelled', 'The planner could not settle it; settled by default', 'executive');
      this.lastDecision = `Settled "${cur.title}" by default`;
      this.kick();
      return;
    }
    const rule = p.settings().escalation.repeatedFailures;
    if (rule === 'deny') {
      this.lastDecision = `"${task.title}" failed permanently`;
      return;
    }
    if (this.autonomous(p)) {
      // Nobody is asked: the planner decides (retry differently, replace, drop) and the director's chat says what it decided.
      const r = handOff(p, cur, { reason: 'failure', summary: `Last failure at ${stage}: ${summary}`, detail, runId });
      this.lastDecision = r.outcome === 'deciding' ? `"${task.title}" is out of attempts: the planner is deciding what to do` : `"${task.title}" is out of attempts: ${r.outcome === 'retried' ? 'retrying it a different way' : 'dropped'}`;
      this.kick();
      return;
    }
    p.governance.escalate({
      kind: 'failure',
      title: `Repeated failure: ${task.title}`,
      detail: `Failed ${cur.attempts} time(s). Last failure at ${stage}: ${summary}\n\n${detail ?? ''}`.slice(0, 8000),
      taskId: task.id,
      runId,
      options: ['retry', 'cancel'],
    });
    p.tasks.setStatus(task.id, 'escalated', 'Attempts exhausted; waiting for the user');
    this.lastDecision = `Escalated "${task.title}" after ${cur.attempts} attempts`;
  }

  /** Plan and execute the next milestone of the roadmap after `done` (the user said so, or autonomous mode did). */
  private startNextMilestone(done: Task): void {
    this.submitObjective({
      title: nextMilestoneTitle(done.title),
      description:
        'Plan and execute the NEXT milestone of this project from the roadmap in the project specification. Read the spec (roadmap, gameplay, systems) and the completed objectives, pick exactly one milestone that builds on what is verified, and deliver it as a playable, verified vertical slice. If every milestone of the roadmap is already delivered by the completed objectives, do not invent more work: add no tasks and say "The roadmap is complete" in your summary.',
    });
  }

  /**
   * Autonomous mode: "Continue with the next milestone?" is not asked, the next one starts (at most
   * MAX_AUTO_MILESTONES in a row, so a roadmap that never ends can't run unattended without limit).
   */
  private continueAutomatically(p: ProjectContext, done: Task, roadmap: string[]): void {
    const title = `Continue with the next milestone after "${done.title}"?`;
    const detail = `The objective is verified. The project spec describes a roadmap (sections: ${roadmap.join(', ')}).`;
    const chained = p.tasks.list({ kinds: ['objective'] }).filter(isNextMilestone).length;
    if (chained >= MAX_AUTO_MILESTONES) {
      p.governance.autoResolve({ kind: 'question', title, detail, taskId: done.id, options: [], response: `Not continuing on its own: ${chained} milestones were started automatically already. Tell the director to carry on when you want the next one.` });
      return;
    }
    p.governance.autoResolve({ kind: 'question', title, detail, taskId: done.id, options: [], response: 'Yes: planning and building the next milestone from the roadmap.' });
    this.startNextMilestone(done);
  }

  private onEscalationResolved(escalationId: string): void {
    const p = this.project;
    if (!p) return;
    const e = p.governance.escalation(escalationId);
    if (!e?.taskId) return;
    const task = p.tasks.get(e.taskId);
    if (!task) return;
    const response = (e.response ?? '').toLowerCase();
    if (e.kind === 'question' && task.kind === 'objective' && e.title.startsWith('Continue with the next milestone') && response === 'start next milestone') {
      this.startNextMilestone(task);
      return;
    }
    if (e.kind === 'approval' && e.status === 'approved') {
      const sig = /signature:(.+)$/m.exec(e.detail)?.[1];
      if (sig) this.deps.approvals.add(sig.trim());
    }
    // An answer that retires or drops a check does it, instead of re-queueing the task into the same failure.
    const effect = applyTestAnswer(p, e, task);
    if (effect.moot && (task.status === 'escalated' || task.status === 'blocked' || task.status === 'failed')) {
      p.tasks.setStatus(task.id, 'cancelled', "Its failing checks were retired at the user's answer; the suite runs again", 'user');
    } else if (task.status === 'escalated' || task.status === 'blocked' || task.status === 'failed') {
      if (e.status === 'rejected' || response === 'cancel') p.tasks.setStatus(task.id, 'cancelled', 'Cancelled after escalation', 'user');
      else {
        p.tasks.resetAttempts(task.id);
        p.tasks.setStatus(task.id, 'ready', `Resumed after escalation (${e.status})`, 'user');
      }
    }
    this.kick();
  }

  // ─── Objectives ────────────────────────────────────────────────────────────

  private async finalizeObjectives(p: ProjectContext): Promise<void> {
    for (const obj of p.tasks.list({ kinds: ['objective'], statuses: ['running', 'ready'] })) {
      // Paused or stopped (maybe during the previous objective's suite): create and start nothing.
      if (this.halted(p)) return;
      const children = p.tasks.list({ parentId: obj.id });
      if (children.length === 0) continue;
      const open = children.filter((c) => !TERMINAL.has(c.status) && !COMPLETE.has(c.status) && c.status !== 'proposed');
      if (open.length > 0) continue;
      const hasWork = children.some((c) => c.kind !== 'research' && c.kind !== 'plan' && COMPLETE.has(c.status));
      if (!hasWork) continue;
      if (this.inflight.has(obj.id) || this.inflight.has(`looks:${obj.id}`)) continue;
      // What is left of the agents' follow-up proposals (most were triaged in rolling batches while the goal was
      // built) gets a look from the planner before the milestone closes: the few that matter become tasks for the
      // right specialist, the rest are closed with a reason. The tasks that come of it can propose more, so this runs
      // at most MAX_WRAPUP_TRIAGES times; what is proposed after that is closed when the objective closes (below).
      // An iteration's wrap-up is light: a reported defect is looked at before the iteration closes, like in a goal;
      // optional polish is closed with the iteration (the director can raise it).
      const proposals = children.filter((c) => c.status === 'proposed' && c.createdBy !== 'user' && (!isIteration(obj) || isDefectProposal(c)));
      // Wrapping up: no proposal becomes work (they are closed with the goal, below), nobody looks, no suite runs.
      const wrapping = this.wrappingUp(p) || this.skipFinal.has(obj.id);
      // Under a budget (proposal-triage.ts FOLLOW_UP_BUDGET) the wrap-up is the rolling triage's last pass: what the
      // budgets still allow goes to the planner, by kind; the rest is closed with that reason. The budgets end it.
      if (proposals.length > 0 && !wrapping && this.polish() !== 'unlimited') {
        const room = this.followUpRoom(p, obj.id);
        const defects = proposals.filter(isDefectProposal);
        const polish = proposals.filter((c) => !isDefectProposal(c));
        let triaging = false;
        if (defects.length) {
          if (room.defectsLeft > 0) triaging = this.createTriage(p, obj, defects, 'defects', room) || triaging;
          else this.closeForBudget(p, obj, defects, true, room);
        }
        if (polish.length) {
          if (room.polishLeft > 0) triaging = this.createTriage(p, obj, polish, 'polish', room) || triaging;
          else this.closeForBudget(p, obj, polish, false, room);
        }
        if (triaging) continue;
      } else if (proposals.length > 0 && !wrapping && children.filter((c) => c.kind === 'plan' && c.title.startsWith(TRIAGE_PREFIX)).length < MAX_WRAPUP_TRIAGES) {
        p.tasks.create({
          parentId: obj.id,
          kind: 'plan',
          title: `${TRIAGE_PREFIX} (${proposals.length})`,
          objective: `All planned tasks of this objective are complete. While working, agents proposed these follow-ups:\n\n${proposals.map((t) => `- [${t.id}] ${t.objective.slice(0, 400)} (proposed by ${roleFor(t.role).name})`).join('\n')}\n\nFor each one: if it matters for a polished, working milestone and no finished or planned task already covers it, add it with plan_add_task for the RIGHT specialist (merge overlapping proposals into one task). Then cancel every proposal listed above with plan_cancel_task: the ones your tasks replace, and the ones not worth doing with the reason why (already covered, too small to notice, out of scope). Adding no tasks is fine when nothing is worth it.`,
          reason: 'Agents proposed follow-ups; the planner decides which are worth doing.',
          role: 'executive',
          status: 'ready',
          priority: 90,
          acceptanceCriteria: ['Every listed proposal is either turned into a task for the right role or cancelled'],
          createdBy: 'executive',
          maxAttempts: 2,
        });
        this.lastDecision = `Reviewing ${proposals.length} follow-up proposal(s) for "${obj.title}"`;
        continue;
      }
      // The full suite tests the whole place: not while another objective's work or a plan change is mid-flight in it
      // (a replaced task's frozen check once failed against a map import still running). A quick iteration never
      // runs it: only its own checks, below; the full suite runs at the main objective's wrap-up.
      const iteration = isIteration(obj);
      const busy = iteration ? null : otherWorkInFlight(p, obj.id);
      if (busy) {
        this.lastDecision = `Waiting to run the regression suite for "${obj.title}": ${busy}`;
        continue;
      }
      const ctrl = new AbortController();
      this.inflight.set(obj.id, ctrl);
      try {
        // Looks nobody has seen are reviewed now at the latest, before the suite (unless that was just tried and
        // Studio still isn't drawing). What the look finds becomes fix tasks, and the objective waits for them.
        const unseen = pendingLooks(p, obj.id);
        if (unseen.length && !wrapping && this.canLook() && !this.lookedLately(p, obj.id)) {
          this.phase = 'finalizing';
          this.lastDecision = `Looking at ${unseen.length} task${unseen.length === 1 ? '' : 's'} of "${obj.title}" nobody has seen yet`;
          this.emitState();
          const looked = await this.reviewLooks(p, obj, unseen, ctrl.signal);
          if (!this.running || this.project !== p) return;
          if (ctrl.signal.aborted || this.halted(p)) continue;
          if (looked.fixes > 0) {
            this.lastDecision = `The look at "${obj.title}" found ${looked.fixes} task${looked.fixes === 1 ? '' : 's'} to fix`;
            continue;
          }
        }
        this.phase = 'finalizing';
        this.lastDecision = iteration ? `Running the checks of "${obj.title}"` : `Running regression suite for "${obj.title}"`;
        this.emitState();
        // An objective sits in 'ready' after a regression repair or a recovery; ready → verifying is not a
        // legal transition, so pass through running.
        if (obj.status === 'ready') p.tasks.setStatus(obj.id, 'running', 'All tasks complete; finalizing', 'executive');
        p.tasks.setStatus(obj.id, 'verifying', 'All tasks complete; running the regression suite', 'executive');
        // The final review shows as an agent of its own (no agent run stands for it): what it checks, how far it is.
        const startedAt = new Date().toISOString();
        this.finalCheck = { objectiveId: obj.id, title: obj.title, iteration, check: null, done: 0, total: 0, startedAt, studioSince: null };
        this.emitState();
        const onProgress = (x: { check: string | null; done: number; total: number; studio: boolean }) => {
          if (this.finalCheck?.objectiveId !== obj.id) return;
          this.finalCheck = { ...this.finalCheck, check: x.check, done: x.done, total: x.total, studioSince: x.studio ? (this.finalCheck.studioSince ?? new Date().toISOString()) : this.finalCheck.studioSince };
          this.emitState();
        };
        const report = wrapping
          ? { passed: true, results: [], summary: this.skipFinal.delete(obj.id) ? 'skipped: the final review was stopped at your word' : 'skipped: wrapped up at your word' }
          : await this.deps.verifier.regression(p, null, iteration ? { signal: ctrl.signal, taskIds: new Set(children.map((c) => c.id)), skipStatic: true, onProgress } : { signal: ctrl.signal, onProgress });
        // The project closed or switched under the suite: its store is not ours to touch (recovery re-queues it).
        if (!this.running || this.project !== p) return;
        // Stopped while the suite ran: its results are partial and nothing follows from them. The objective
        // goes back to ready and the suite runs again on resume.
        if (ctrl.signal.aborted || report.aborted) {
          p.tasks.setStatus(obj.id, 'ready', 'The regression suite was cut short (stopped); it runs again on resume', 'executive');
          this.lastDecision = `Regression suite for "${obj.title}" stopped; it runs again on resume`;
          continue;
        }
        p.tasks.addEvidence({ taskId: obj.id, runId: null, kind: 'test_result', title: `Regression suite: ${report.summary}`, passed: report.passed, data: report, path: null });
        // Paused while it ran: what it found is recorded, but no repair task (or anything else) is created now.
        if (!report.passed && this.halted(p)) {
          p.tasks.setStatus(obj.id, 'ready', 'Regressions found while paused; the repair is planned on resume', 'executive');
          this.lastDecision = `Regressions found for "${obj.title}" while paused; nothing is created until you resume`;
          continue;
        }
        let quarantined: string[] = [];
        if (!report.passed) {
          // One repair task per failure, then quarantine; never two open repair tasks; a cap, then the user.
          const outcome = handleRegressionFailure(p, obj, children, report, p.settings().maxAttemptsPerTask, this.autonomous(p));
          if (outcome.action === 'repair') {
            p.tasks.setStatus(obj.id, 'ready', `Regressions found; repair task created${outcome.quarantined.length ? ` (${outcome.quarantined.length} still-failing check(s) quarantined)` : ''}`, 'executive');
            this.lastDecision = `Regressions found; repair task created for "${obj.title}"`;
            continue;
          }
          if (outcome.action === 'escalated') {
            p.tasks.setStatus(obj.id, 'escalated', 'The suite keeps failing; waiting for the user', 'executive');
            this.lastDecision = `The regression suite keeps failing for "${obj.title}": asking you`;
            continue;
          }
          quarantined = outcome.quarantined;
        }
        const done = children.filter((c) => COMPLETE.has(c.status));
        // Studio still can't draw: the objective closes, and the user is told plainly which tasks nobody looked at.
        const unchecked = pendingLooks(p, obj.id);
        if (unchecked.length) p.audit.event({ kind: 'visual.unchecked', severity: 'warning', title: uncheckedLine(obj.title, unchecked), taskId: obj.id, detail: { tasks: unchecked.map((t) => ({ id: t.id, title: t.title })) } });
        const summary = `Objective "${obj.title}" completed.\n\n${done.map((c) => `- ${c.title}: ${(c.result ?? '').split('\n')[0]!.slice(0, 300)}`).join('\n')}${quarantined.length ? `\n\nQuarantined (still failing after their repair, no longer blocking): ${quarantined.join(', ')}` : ''}${unchecked.length ? `\n\n${VISUAL_PENDING} (nobody has looked at these: Studio wasn't drawing):\n${unchecked.map((t) => `- ${t.title}`).join('\n')}` : ''}`;
        this.deps.knowledge.add({ scope: 'project', category: 'project', title: `Completed: ${obj.title}`, body: summary, tags: ['objective', 'history'], confidence: 0.9, createdBy: 'executive', sources: [{ kind: 'run', ref: `task:${obj.id}`, title: 'Verified task results', authority: 'observed' }] });
        p.tasks.update(obj.id, { result: summary });
        const worldChanged = children.some((c) => p.tasks.evidence(c.id).some((e) => e.kind === 'datamodel_snapshot' && !/^DataModel: No DataModel changes/.test(e.title)));
        const autoSave = !!this.deps.savePlace && p.extras().autoSave !== false && this.deps.appPrefs?.().autoSave !== false;
        const saved = worldChanged && autoSave ? await this.deps.savePlace!('goal').catch((e: unknown) => ({ ok: false, message: errorMessage(e) })) : null;
        if (saved) p.audit.event({ kind: 'place.saved', severity: saved.ok ? 'info' : 'warning', title: saved.ok ? 'Saved the place in Studio' : `Could not save the place: ${saved.message}` });
        if (worldChanged && !saved?.ok && this.autonomous(p)) {
          // Not a question: the place guard keeps trying to save (and files Studio's recovery copies); the chat carries one line.
          p.governance.autoResolve({
            kind: 'question',
            title: `Save the place in Studio to keep "${obj.title}" world changes`,
            detail: 'Agents changed instances in the open Studio place (not only code). Code is on disk and versioned, but world changes exist only in Studio until the place is saved.',
            taskId: obj.id,
            options: [],
            response: autoSave
              ? `The save didn't go through yet (${saved?.message ?? 'Studio did not answer'}); Shuriken keeps trying every few minutes, and Studio's recovery copies are filed in the project.`
              : 'Auto-save is off in Settings; press Ctrl+S in Studio when it suits you. Studio\'s recovery copies are filed in the project meanwhile.',
          });
          this.deps.checkpoint?.();
        } else if (worldChanged && !saved?.ok) {
          // Studio MCP exposes no save API: world (non-code) changes live in the open place until saved.
          p.governance.escalate({
            kind: 'question',
            title: `Save the place in Studio to keep "${obj.title}" world changes`,
            detail: 'Agents changed instances in the open Studio place (not only code). Code is on disk and versioned, but world changes exist only in Studio until the place is saved. Press Ctrl+S (or File → Save / Publish) in the bound Studio window, then answer "saved".',
            taskId: obj.id,
            options: ['saved'],
          });
        }
        // No proposal is left hanging when the objective closes: what no triage turned into a task is closed, with why.
        this.closeProposals(p, obj);
        p.tasks.setStatus(obj.id, 'verified', report.passed ? `All tasks verified; regression suite passed (${report.summary})` : `All tasks verified; ${quarantined.length} still-failing check(s) quarantined`, 'executive');
        await p.git.checkpoint({ label: `objective complete: ${obj.title}`, kind: 'verified', taskId: obj.id }).catch(() => null);
        p.tasks.setStatus(obj.id, 'done', 'Objective complete', 'executive');
        if (isIteration(obj)) {
          p.exportState();
          this.lastDecision = `Iteration complete: ${obj.title}`;
          continue;
        }
        // CONTINUE: the next milestone of the roadmap only when this window keeps building (ProjectSettings.keepBuilding,
        // off by default). Otherwise the build stops here: nothing is planned, and the chat says the roadmap has more.
        // Before 1.15.7 autonomous mode always went on, milestone after milestone, whether or not the user wanted more.
        const roadmap = p.governance
          .spec()
          .filter((s) => /milestone|roadmap/i.test(s.body))
          .map((s) => s.key);
        if (roadmap.length && p.settings().keepBuilding === true) this.continueAutomatically(p, obj, roadmap);
        else if (roadmap.length) new ChatService(p, this.deps.bus).add({ role: 'system', kind: 'status', text: `"${obj.title}" is done and checked. The roadmap in the spec has more; I won't start the next milestone unless you ask ("next milestone"), or turn on Keep building for this window in Settings → Agents.` });
        p.exportState();
        // DOCUMENT: write the outcome up from the project's own records (spec, tasks, tests, decisions, runs).
        try {
          const file = writeProjectReport(p, this.deps.knowledge, this.deps.runner);
          p.audit.event({ kind: 'report.written', severity: 'info', title: `Report written: ${relative(p.root, file).split(sep).join('/')}`, taskId: obj.id });
        } catch (e) {
          this.deps.log.warn('Could not write the project report', errorMessage(e));
        }
        this.lastDecision = `Objective complete: ${obj.title}`;
      } finally {
        this.inflight.delete(obj.id);
        this.phase = 'idle';
        if (this.finalCheck?.objectiveId === obj.id) {
          this.finalCheck = null;
          this.emitState();
        }
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async snapshot(p: ProjectContext): Promise<DataModelSnapshot | null> {
    if (!this.deps.studio.connected) return null;
    try {
      // Snapshots need Edit mode. They are evidence, not a gate: if someone's playtest holds Studio,
      // wait a little (playtests are short now) and otherwise go without, rather than hold up the task.
      const deadline = Date.now() + 20_000;
      while (this.deps.lease?.holder && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
      if (this.deps.lease?.holder) return null;
      const st = await this.deps.studio.state();
      if (!st.availableDataModels.includes('Edit')) return null;
      // Read page by page (a place's snapshot is far over what Studio returns in one call): room for a game-sized place.
      return (await this.deps.studio.snapshot(p.extras().snapshotRoots, 'Edit', 10_000, 30_000)) as DataModelSnapshot;
    } catch (e) {
      this.deps.log.warn('DataModel snapshot failed', errorMessage(e));
      return null;
    }
  }

  /** The removals that are still gone after a pause (see REMOVAL_RECHECK): a kit another agent was rebuilding is back by then. */
  private async stillRemoved(p: ProjectContext, removed: string[], signal: AbortSignal): Promise<string[]> {
    await new Promise((r) => setTimeout(r, REMOVAL_RECHECK.delayMs));
    // Stopped meanwhile: no approval for work the user called off (the checks that follow notice the stop).
    if (signal.aborted) return [];
    const gone = removalsStillGone(removed, await this.snapshot(p));
    if (gone.length < removed.length) this.deps.log.info(`${removed.length - gone.length} of ${removed.length} instances that looked removed were back a moment later (rebuilt by someone else)`);
    return gone;
  }

  private recordAgentKnowledge(p: ProjectContext, task: Task, work: WorkOutput): void {
    for (const k of work.knowledge ?? []) {
      try {
        this.deps.knowledge.add({
          scope: k.scope === 'roblox' ? 'roblox' : 'project',
          category: 'agent',
          title: k.title,
          body: k.body,
          confidence: Math.min(clamp01(k.confidence), 0.7),
          taskId: task.id,
          tags: ['agent-learned'],
          createdBy: task.role,
          sources: [{ kind: 'run', ref: `task:${task.id}`, title: task.title, authority: 'inference' }],
        });
      } catch (e) {
        this.deps.log.warn('Could not record agent knowledge', errorMessage(e));
      }
    }
  }

  /**
   * Continuous triage: defects agents reported as proposals are turned into tasks for the right role (or dropped)
   * by one short planner run per batch — every ~10 minutes, or as soon as three are waiting — instead of waiting
   * for the objective's wrap-up, for goals and quick iterations alike. Never while paused (tick() doesn't call it).
   */
  private triageDefects(p: ProjectContext): void {
    if (this.wrappingUp(p)) return;
    for (const { objectiveId, batch } of dueBatches(p.tasks.list(), Date.now())) {
      const obj = p.tasks.get(objectiveId);
      if (!obj) continue;
      const room = this.followUpRoom(p, objectiveId);
      if (room.defectsLeft <= 0) this.closeForBudget(p, obj, batch, true, room);
      else this.createTriage(p, obj, batch, 'defects', room);
    }
  }

  /** The follow-up setting (Settings, Agents, "Polish"): how much work a goal's follow-ups may add to its plan. */
  private polish(): PolishLevel {
    return polishLevel(this.deps.appPrefs?.().polish);
  }

  /** What a goal's plan and triage runs have added, and what its budgets leave (proposal-triage.ts). */
  private followUpRoom(p: ProjectContext, objectiveId: string): FollowUpRoom {
    return followUpRoom(readFollowUpCounts(p.store, objectiveId), this.polish());
  }

  /** One planner run for a batch of proposals of one kind, told what the goal's budget still allows. True when it was created. */
  private createTriage(p: ProjectContext, obj: Task, batch: Task[], kind: 'polish' | 'defects', room: FollowUpRoom): boolean {
    const lines = batch.map((t) => `- [${t.id}] ${t.objective.slice(0, 400)} (${kind === 'defects' ? 'reported' : 'proposed'} by ${roleFor(t.role).name})`);
    const n = batch.length;
    p.tasks.create({
      parentId: obj.id,
      kind: 'plan',
      title: `${kind === 'defects' ? TRIAGE_DEFECTS_PREFIX : TRIAGE_POLISH_PREFIX} (${n})`,
      objective: kind === 'defects' ? defectTriageObjective(lines, room.defectsLeft) : polishTriageObjective(lines, room.polishLeft),
      reason: kind === 'defects' ? 'Agents reported defects while building; the planner decides which become tasks, soon rather than at the wrap-up.' : 'Agents proposed improvements and there is spare capacity; the planner decides which are worth doing now.',
      role: 'executive',
      status: 'ready',
      priority: kind === 'defects' ? 92 : 60,
      acceptanceCriteria: [kind === 'defects' ? 'Every listed defect report is either turned into a task for the right role or cancelled' : 'Every listed proposal is either turned into a task for the right role or cancelled with a reason'],
      createdBy: 'executive',
      maxAttempts: 2,
    });
    p.audit.event({
      kind: 'plan.triage',
      severity: 'info',
      title: kind === 'defects' ? `Triaging ${n} defect report${n === 1 ? '' : 's'} agents filed in "${obj.title}"` : `Triaging ${n} improvement${n === 1 ? '' : 's'} agents proposed in "${obj.title}" (agents are free)`,
      taskId: obj.id,
      detail: { proposals: batch.map((t) => ({ id: t.id, text: t.objective.slice(0, 200), by: t.createdBy })), budget: Number.isFinite(room.budget.polish) ? { planned: room.planned, polish: `${room.polish}/${room.budget.polish}`, defects: `${room.defects}/${room.budget.defects}` } : null },
    });
    this.lastDecision = kind === 'defects' ? `Triaging ${n} reported defect${n === 1 ? '' : 's'} for "${obj.title}"` : `Triaging ${n} proposed improvement${n === 1 ? '' : 's'} for "${obj.title}"`;
    this.kick();
    return true;
  }

  /** Goals whose budget was said to be used, by kind (the chat hears it once per goal and kind). */
  private readonly budgetSaid = new Set<string>();

  /**
   * A goal's budget for follow-ups is used: the proposals are closed with that reason (they stay readable on the
   * goal), no planner run is spent on them, and the chat is told once what happened and where the setting is.
   */
  private closeForBudget(p: ProjectContext, obj: Task, batch: Task[], defect: boolean, room: FollowUpRoom): void {
    if (!batch.length) return;
    const reason = closedForBudget(defect, room);
    for (const t of batch) p.tasks.setStatus(t.id, 'cancelled', reason, 'executive');
    const n = batch.length;
    p.audit.event({
      kind: 'plan.triage',
      severity: 'info',
      title: defect ? `Closed ${n} defect report${n === 1 ? '' : 's'} in "${obj.title}": its follow-up fixes are used up (${room.defects} of ${room.budget.defects})` : `Closed ${n} proposed improvement${n === 1 ? '' : 's'} in "${obj.title}": its polish budget is used (${room.polish} of ${room.budget.polish} tasks)`,
      taskId: obj.id,
      detail: { reason, proposals: batch.map((t) => ({ id: t.id, text: t.objective.slice(0, 200), by: t.createdBy })) },
    });
    const key = `${obj.id}:${defect ? 'defects' : 'polish'}`;
    if (this.budgetSaid.has(key)) return;
    this.budgetSaid.add(key);
    try {
      // Once per goal and kind, also across restarts (it was said again after every restart of a long build).
      const chat = new ChatService(p, this.deps.bus);
      if (chat.findLatest('status', (d) => d.budgetNotice === key)) return;
      chat.add({ role: 'system', kind: 'status', text: budgetNotice(obj.title, defect, room), data: { budgetNotice: key } });
    } catch {
      /* the chat is a courtesy: never in the way of the schedule */
    }
  }

  /** Whether a look is worth trying at all: Studio has to be there to draw. */
  private canLook(): boolean {
    return this.deps.studio.connected;
  }

  /** When the pending looks of an objective were last tried (ISO). */
  private readonly looksTried = new Map<string, string>();

  /** A look was tried for this objective and nothing has shown Studio drawing since: trying again would only repeat it. */
  private lookedLately(p: ProjectContext, objectiveId: string): boolean {
    const tried = this.looksTried.get(objectiveId);
    return !!tried && !studioDrawsSince(p, tried);
  }

  /**
   * Studio draws again (a screenshot came back with a picture since the tasks were marked): one critic run looks at
   * all the pending tasks of an objective together, as soon as an agent is free. Never while paused (tick() doesn't
   * call it then), and not during the objective's wrap-up, which does it itself.
   */
  private lookWhenStudioDraws(p: ProjectContext): void {
    if (!this.canLook()) return;
    for (const obj of p.tasks.list({ kinds: ['objective'], statuses: ['running', 'ready'] })) {
      const key = `looks:${obj.id}`;
      if (this.inflight.has(key) || this.inflight.has(obj.id)) continue;
      const pending = pendingLooks(p, obj.id);
      if (!pending.length) continue;
      const since = [this.looksTried.get(obj.id) ?? '', ...pending.map((t) => pendingSince(p, t.id) ?? '')].sort().at(-1)!;
      if (!studioDrawsSince(p, since)) continue;
      const release = this.semaphore.tryAcquire();
      if (!release) return;
      const ctrl = new AbortController();
      this.inflight.set(key, ctrl);
      this.lastDecision = `Studio can draw again: looking at ${pending.length} task${pending.length === 1 ? '' : 's'} of "${obj.title}" nobody has seen yet`;
      this.emitState();
      void this.reviewLooks(p, obj, pending, ctrl.signal)
        .catch((e) => this.deps.log.error(`Looking at the pending tasks of ${obj.id} crashed`, e))
        .finally(() => {
          this.inflight.delete(key);
          release();
          this.emitState();
          this.kick();
        });
    }
  }

  /**
   * One critic run that looks at the tasks whose looks nobody has seen (visual-checks.ts). A task that looks right
   * is settled; one that looks wrong gets a fix task for the role that built it; when Studio still isn't drawing
   * nothing changes and the tasks stay pending. Returns whether a look was possible and how many fix tasks it made.
   */
  private async reviewLooks(p: ProjectContext, obj: Task, pending: Task[], signal: AbortSignal): Promise<{ possible: boolean; fixes: number }> {
    this.looksTried.set(obj.id, nowIso());
    const outcome = await this.deps.runner.run({ project: p, role: ROLES.critic!, task: obj, signal, directive: LOOKS_DIRECTIVE, contextText: looksContext(pending) });
    if (signal.aborted || this.project !== p) return { possible: false, fixes: 0 };
    const looks = readLooks(outcome.completion.ok ? (outcome.structured as ReviewOutput | null) : null, pending);
    if (looks.notPossible) {
      p.audit.event({ kind: 'visual.pending', severity: 'info', title: `Studio still isn't drawing: ${pending.length} task${pending.length === 1 ? '' : 's'} of "${obj.title}" wait${pending.length === 1 ? 's' : ''} for a look`, taskId: obj.id });
      return { possible: false, fixes: 0 };
    }
    const settle = (t: Task, line: string) => p.tasks.update(t.id, { result: (p.tasks.get(t.id)?.result ?? '').replace(PENDING_LINE, line) });
    for (const { task, seen } of looks.fine) {
      p.tasks.addEvidence({ taskId: task.id, runId: outcome.run.id, kind: 'note', title: VISUAL_DONE, passed: true, data: { seen }, path: null });
      settle(task, `${VISUAL_DONE}: ${seen.slice(0, 300) || 'it looks right'}`);
    }
    for (const { task, findings } of looks.wrong) {
      p.tasks.addEvidence({ taskId: task.id, runId: outcome.run.id, kind: 'note', title: VISUAL_DONE, passed: false, data: { findings }, path: null });
      settle(task, `${VISUAL_DONE}: it had visual problems, fixed by a follow-up task.`);
      p.tasks.create({
        parentId: obj.id,
        kind: 'implement',
        title: `${LOOKS_FIX_PREFIX} "${task.title}"`.slice(0, 120),
        objective: `"${task.title}" passed its checks and review while Studio wasn't drawing, so nobody saw it. Now that it can be seen, the reviewer found:\n\n${findings}\n\nFix these, look at the result yourself (roblox_screenshot from 2-3 angles) and keep what already works.`,
        reason: 'Found when the looks were reviewed once Studio could draw again.',
        role: task.role,
        status: 'ready',
        priority: 70,
        acceptanceCriteria: ['Every visual problem listed is fixed, shown by screenshots of the result'],
        verification: [{ kind: 'static_analysis' }, { kind: 'critic' }],
        files: task.files,
        createdBy: 'critic',
        maxAttempts: p.settings().maxAttemptsPerTask,
      });
    }
    p.audit.event({ kind: 'visual.reviewed', severity: looks.wrong.length ? 'warning' : 'success', title: `Looked at ${looks.fine.length + looks.wrong.length} task${looks.fine.length + looks.wrong.length === 1 ? '' : 's'} of "${obj.title}" that had passed unseen: ${looks.wrong.length ? `${looks.wrong.length} need${looks.wrong.length === 1 ? 's' : ''} a fix` : 'all look right'}`, taskId: obj.id, runId: outcome.run.id });
    this.kick();
    return { possible: true, fixes: looks.wrong.length };
  }

  /**
   * Rolling triage of optional polish (tick() calls it only while agents have spare capacity, never while paused):
   * one short planner run per batch — six waiting, or the oldest twenty minutes old — turns the improvements a
   * player would notice into tasks and closes the rest with a reason. A quick iteration's polish is not triaged.
   */
  private triagePolish(p: ProjectContext): void {
    if (this.wrappingUp(p)) return;
    for (const { objectiveId, batch } of duePolishBatches(p.tasks.list(), Date.now())) {
      const obj = p.tasks.get(objectiveId);
      if (!obj || isIteration(obj)) continue;
      const room = this.followUpRoom(p, objectiveId);
      if (room.polishLeft <= 0) this.closeForBudget(p, obj, batch, false, room);
      else this.createTriage(p, obj, batch, 'polish', room);
    }
  }

  /** The proposals agents filed that are still waiting when an objective closes are closed, each with the reason, and listed on the timeline. */
  private closeProposals(p: ProjectContext, obj: Task): void {
    const left = p.tasks.list({ parentId: obj.id, statuses: ['proposed'] }).filter((t) => t.createdBy !== 'user');
    if (!left.length) return;
    const reason = closedAtWrapUp(isIteration(obj));
    for (const t of left) p.tasks.setStatus(t.id, 'cancelled', reason, 'executive');
    p.audit.event({ kind: 'plan.triage', severity: 'info', title: `Closed ${left.length} follow-up proposal${left.length === 1 ? '' : 's'} still waiting when "${obj.title}" finished`, taskId: obj.id, detail: { reason, proposals: left.map((t) => ({ id: t.id, text: t.objective.slice(0, 200), by: t.createdBy })) } });
  }

  private proposeFollowUp(p: ProjectContext, task: Task, raw: string, by: string): void {
    if (!raw.trim()) return;
    // A defect a player would hit ("DEFECT: …", or worded like one) is triaged soon; optional polish when agents are free.
    const { defect, text } = classifyFollowUp(raw);
    if (!text) return;
    // Feedback about Shuriken itself (tools, capabilities, human steps) is platform knowledge, not game work.
    if (/\b(shuriken|mcp|capabilit|tool(ing)?\b|a human should|a person should|the user should)/i.test(text)) {
      try {
        this.deps.knowledge.add({ scope: 'global', category: 'agent', title: `Platform feedback: ${text.slice(0, 80)}`, body: `${text}

(Raised by ${by} while working on "${task.title}".)`, tags: ['platform-feedback'], confidence: 0.5, createdBy: by, taskId: null, sources: [{ kind: 'run', ref: `task:${task.id}`, title: task.title, authority: 'inference' }] });
      } catch {
        /* never block completion on feedback recording */
      }
      return;
    }
    // Skip near-duplicates of existing proposals.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter((w) => w.length > 3);
    const words = new Set(norm(text));
    const dup = p.tasks.list({ parentId: task.parentId, statuses: ['proposed', 'ready'] }).some((t) => {
      const other = norm(t.objective);
      const overlap = other.filter((w) => words.has(w)).length;
      return overlap >= Math.max(3, Math.min(words.size, other.length) * 0.6);
    });
    if (dup) return;
    p.tasks.create({
      parentId: task.parentId,
      kind: 'implement',
      title: text.slice(0, 100),
      objective: text,
      reason: `${defect ? DEFECT_REASON : 'Follow-up proposed by'} ${by} while working on "${task.title}"`,
      role: task.role,
      status: 'proposed',
      priority: defect ? 55 : 30,
      acceptanceCriteria: [],
      verification: [{ kind: 'static_analysis' }, { kind: 'critic' }],
      createdBy: by,
    });
  }

  private requireProject(): ProjectContext {
    if (!this.project) throw new Error('No project is open');
    return this.project;
  }
}

/** A failure that only says Studio wasn't there (closed, reopening, not connected): handleFailure gives the attempt back. */
const STUDIO_AWAY = /No open Studio instance|Studio (?:is )?not connected|not connected to (?:Roblox )?Studio|Roblox Studio (?:closed|is closed|isn't running|is not running)|no Studio (?:instance|window)|Studio went away|while Studio was (?:closed|reopening)/i;

/** Why a card of a finished task closed, in plain words. */
function closedReason(t: Task): string {
  if (t.status === 'done') return `No longer needed: "${t.title.slice(0, 80)}" is done.`;
  return `No longer needed: "${t.title.slice(0, 80)}" was cancelled or replaced.`;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/** Validate a plan and return its tasks in dependency (topological) order, or an error string. */
export function validatePlan(plan: PlanOutput): PlanOutput['tasks'] | string {
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return 'plan has no tasks';
  if (plan.tasks.length > 40) return `plan has ${plan.tasks.length} tasks (max 40); merge related work`;
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (!t.key || keys.has(t.key)) return `duplicate or missing task key "${t.key}"`;
    keys.add(t.key);
    if (!t.acceptanceCriteria?.length) return `task "${t.title}" has no acceptance criteria`;
  }
  for (const t of plan.tasks) for (const d of t.dependsOn ?? []) if (!keys.has(d)) return `task "${t.key}" depends on unknown key "${d}"`;
  // A task that names another task's key in its objective ("uses the framework from t2") but does not
  // depend on it would start before its input exists.
  for (const t of plan.tasks) {
    const deps = new Set(t.dependsOn ?? []);
    for (const m of `${t.objective} ${t.reason ?? ''}`.matchAll(/\b([a-z]\d{1,2})\b/gi)) {
      const k = m[1]!;
      if (k !== t.key && keys.has(k) && !deps.has(k) && !plan.tasks.find((x) => x.key === k)?.dependsOn?.includes(t.key)) {
        return `task "${t.key}" refers to "${k}" but does not list it in dependsOn (add the dependency, or remove the reference)`;
      }
    }
  }
  // A multi-task plan whose summary describes an order but declares no dependencies would run everything
  // at once (observed: a 9-task plan described three waves in prose with every dependsOn empty).
  const anyDeps = plan.tasks.some((t) => (t.dependsOn ?? []).length > 0);
  if (!anyDeps && plan.tasks.length >= 3 && /\b(wave|depends|needs|after|requires|then|prerequisite)\b/i.test(`${plan.summary} ${plan.tasks.map((t) => t.objective).join(' ')}`)) {
    return 'the plan describes an order between tasks but no task declares dependsOn; express every ordering as dependsOn keys (scheduling reads only dependsOn)';
  }
  const order: PlanOutput['tasks'] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const visit = (k: string): string | null => {
    const s = state.get(k) ?? 0;
    if (s === 1) return `dependency cycle at "${k}"`;
    if (s === 2) return null;
    state.set(k, 1);
    for (const d of byKey.get(k)!.dependsOn ?? []) {
      const err = visit(d);
      if (err) return err;
    }
    state.set(k, 2);
    order.push(byKey.get(k)!);
    return null;
  };
  for (const t of plan.tasks) {
    const err = visit(t.key);
    if (err) return err;
  }
  return order;
}

/** Ensure implementation tasks always get static analysis and an independent critic. */
export function normalizeVerification(raw: Array<Record<string, unknown>>, kind: string): VerificationMethod[] {
  const out: VerificationMethod[] = [];
  for (const r of raw ?? []) {
    switch (r.kind) {
      case 'static_analysis':
        out.push({ kind: 'static_analysis' });
        break;
      case 'luau_assert':
        if (typeof r.luau === 'string' && r.luau.trim()) out.push({ kind: 'luau_assert', name: String(r.name ?? 'assert'), luau: r.luau, datamodel: r.datamodel === 'server' || r.datamodel === 'client' ? r.datamodel : 'edit' });
        break;
      case 'playtest':
        out.push({ kind: 'playtest', name: String(r.name ?? 'playtest'), durationSec: typeof r.durationSec === 'number' ? r.durationSec : 10, luau: typeof r.luau === 'string' && r.luau.trim() ? r.luau : undefined, ...(typeof r.clientLuau === 'string' && r.clientLuau.trim() ? { clientLuau: r.clientLuau } : {}), failOnConsoleErrors: r.failOnConsoleErrors !== false });
        break;
      case 'screenshot': {
        const vec = (v: unknown) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? (v as [number, number, number]) : undefined);
        out.push({ kind: 'screenshot', name: String(r.name ?? 'screenshot'), instructions: String(r.instructions ?? ''), camera: vec(r.camera), lookAt: vec(r.lookAt) });
        break;
      }
      case 'perf': {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        out.push({ kind: 'perf', name: String(r.name ?? 'performance'), durationSec: num(r.durationSec), maxHeartbeatMs: num(r.maxHeartbeatMs), maxPhysicsStepMs: num(r.maxPhysicsStepMs), maxMemoryMb: num(r.maxMemoryMb), maxInstances: num(r.maxInstances) });
        break;
      }
      case 'cloud_luau':
        if (typeof r.luau === 'string' && r.luau.trim()) out.push({ kind: 'cloud_luau', name: String(r.name ?? 'cloud'), luau: r.luau, timeoutSec: typeof r.timeoutSec === 'number' ? r.timeoutSec : undefined });
        break;
      case 'manual':
        out.push({ kind: 'manual', instructions: String(r.instructions ?? '') });
        break;
      case 'critic':
        out.push({ kind: 'critic' });
        break;
    }
  }
  if (kind !== 'research') {
    if (!out.some((m) => m.kind === 'static_analysis')) out.unshift({ kind: 'static_analysis' });
    if (!out.some((m) => m.kind === 'critic')) out.push({ kind: 'critic' });
  }
  return out;
}
