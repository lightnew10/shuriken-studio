import type { ChatMessage, Escalation, Task, TaskEvidence, TimelineEvent } from '@shared/domain';
import type { CoreEventMap } from '@shared/events';
import { errorMeaning, isRawError, plainOption, plainText, scriptLabel, shortTitle } from '@shared/plain-words';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { ReviewOutput } from '../agents/roles';
import { ChatService } from './chat-service';
import type { PlainWordsLike } from './plain-words';
import { autoResolvedLine, isDecisionTask, isNextMilestone } from '../orchestrator/autonomy';
import { isTriagePlan, listedProposalIds, triageKind } from '../orchestrator/proposal-triage';
import { NOT_REPRODUCED } from '../orchestrator/reopen';
import { RETIRED_BY_QUARANTINE, TestService, checkName } from '../verification/test-service';

/**
 * How the director's chat tells the story of a build, honestly and in plain words (docs/ARCHITECTURE.md §5, "The
 * chat's story"). What it fixes, from audits of the user's projects:
 * - Volume: 208 "Done:" lines, 39 "Another pass" lines and ~31 triage plan cards in one project. Finished tasks,
 *   send-backs and triage outcomes are now lines of one "progress" message, updated in place for a few minutes.
 * - Truth: "checks and review passed" printed where no review ran, a rejected review summed up by the reviewer's first
 *   sentence ("Most of this works and looks good."), "built and verified" with five failing checks set aside, "3190
 *   min" counted across a night's pause, phone controls "passed" from Studio alone. Each line now says what happened.
 * - Plan cards: one per planning run, finished by that run whatever it ends in; never another run's plan, never stuck
 *   at "Updating the plan…".
 * - Jargon: cards and lines go through plain words (rules first, a fast model when there is one).
 */

// ─── Durations ─────────────────────────────────────────────────────────────

/** A task's status changes from its timeline, oldest first. */
export function statusChanges(timeline: readonly TimelineEvent[]): Array<{ at: number; from: string; to: string }> {
  const out: Array<{ at: number; from: string; to: string }> = [];
  for (const e of timeline) {
    if (e.kind !== 'task.status') continue;
    const m = /: (\w+) → (\w+)$/.exec(e.title);
    if (m) out.push({ at: Date.parse(e.ts), from: m[1]!, to: m[2]! });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Statuses in which a task is being worked on (an agent, its checks or its review), not waiting or paused. */
const WORKING = new Set(['running', 'implemented', 'verifying', 'reviewing', 'verified']);

/**
 * How long a task was actually worked on: the time it spent running, being checked or reviewed. Time waiting in line,
 * paused, out for a usage limit or overnight is not in it (a task's start to its end said "3190 min").
 */
export function activeMs(changes: ReadonlyArray<{ at: number; to: string }>, until: number): number | null {
  if (!changes.length) return null;
  let total = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    if (!WORKING.has(c.to)) continue;
    const end = changes[i + 1]?.at ?? until;
    total += Math.max(0, end - c.at);
  }
  return total;
}

// ─── What a finished task's line says ──────────────────────────────────────

/** Phone, touch, tablet, gamepad and "feel": what a playtest in Studio on a PC doesn't show. */
const DEVICE = /\b(?:phones?|mobile|touch(?:screen| controls?)?|tablets?|ipad|iphone|android|gamepads?|game ?pads?|xbox|playstation|thumbsticks?|joysticks?|haptics?|feel|feels|feeling)\b/i;

export const deviceSensitive = (task: Pick<Task, 'title' | 'acceptanceCriteria'>): boolean => DEVICE.test([task.title, ...task.acceptanceCriteria].join('\n'));

/** Evidence from a real device (nothing records it today; an agent's note that says so counts). */
export const realDeviceEvidence = (evidence: readonly TaskEvidence[]): boolean => evidence.some((e) => e.passed === true && /\b(?:on|from) (?:a |an |my |the user's )?real (?:phone|device|tablet|gamepad|controller)\b/i.test(e.title));

const AUTOMATED: ReadonlySet<TaskEvidence['kind']> = new Set(['test_result', 'console', 'static_analysis']);

/**
 * What checked the task's last attempt, in words: its automated checks, its review, or that a review was skipped (a
 * small code fix a playtest proved: review-policy.ts). It said "checks and review passed" for every task.
 */
export function checkWords(task: Pick<Task, 'kind'>, evidence: readonly TaskEvidence[], timeline: readonly TimelineEvent[], changes: ReadonlyArray<{ at: number; to: string }>): string | null {
  if (task.kind === 'research') return null;
  const since = [...changes].reverse().find((c) => c.to === 'verifying')?.at ?? 0;
  const after = (iso: string) => Date.parse(iso) >= since;
  // A static analysis that answered for no file of the task (it changed none) checked nothing of it.
  const checks = evidence.some((e) => e.passed === true && AUTOMATED.has(e.kind) && after(e.createdAt) && !(e.kind === 'static_analysis' && (e.data as { files?: unknown } | null)?.files === 0));
  const reviewedAt = evidence.filter((e) => e.kind === 'critic_review' && e.passed === true && after(e.createdAt)).at(-1)?.createdAt ?? null;
  const skippedAt = timeline.filter((e) => e.kind === 'review.skipped' && after(e.ts)).map((e) => e.ts).sort().at(-1) ?? null;
  const reviewed = !!reviewedAt && (!skippedAt || reviewedAt >= skippedAt);
  if (reviewed) return checks ? 'checks and review passed' : 'review passed, no automated checks';
  if (skippedAt) return checks ? 'checks passed, review skipped' : 'no automated checks, review skipped';
  return checks ? 'checks passed, no review' : 'no checks or review ran';
}

/** The line for a finished task: what it was, how long it was worked on, what checked it, and what wasn't checked. */
export function doneLine(p: ProjectContext, task: Task): string {
  const timeline = p.audit.timeline({ taskId: task.id, limit: 1000 });
  const evidence = p.tasks.evidence(task.id);
  const changes = statusChanges(timeline);
  const parts: string[] = [];
  const ms = activeMs(changes, task.completedAt ? Date.parse(task.completedAt) : Date.now());
  if (ms !== null) parts.push(`${Math.max(1, Math.round(ms / 60_000))} min of work`);
  const checked = checkWords(task, evidence, timeline, changes);
  if (checked) parts.push(checked);
  // Its checks ran in Studio on a PC: touch, a phone's screen, a gamepad and how it feels are not known from them.
  if (task.kind !== 'research' && deviceSensitive(task) && !realDeviceEvidence(evidence)) parts.push('not checked on a real device');
  return `Done: ${plainText(task.title)}${parts.length ? ` (${parts.join('; ')})` : ''}.`;
}

const SEVERITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const firstSentence = (x: string): string => {
  const s = x.trim().split(/(?<=[.!?])\s/)[0]!.slice(0, 200).trim();
  return s.replace(/[.!?]+$/, '');
};

/** What a rejected review found, by its most serious defect or first unmet criterion (not the review's opening line). */
export function reviewPoint(review: Pick<ReviewOutput, 'defects' | 'criteria'> | null | undefined): string | null {
  const defect = [...(review?.defects ?? [])].sort((a, b) => (SEVERITY[a.severity] ?? 9) - (SEVERITY[b.severity] ?? 9))[0];
  if (defect?.title?.trim()) {
    const title = plainText(defect.title.trim()).replace(/[.!?]+$/, '');
    const detail = plainText(firstSentence(defect.detail ?? ''));
    return title.split(/\s+/).length < 4 && detail ? `"${title}" (${detail})` : `"${title}"`;
  }
  const unmet = review?.criteria?.find((c) => !c.met);
  if (unmet?.criterion?.trim()) return `not met yet: "${plainText(unmet.criterion.trim()).replace(/[.!?]+$/, '').slice(0, 200)}"`;
  return null;
}

/** "the Combat client script doesn't compile (line 2199: …)" from a verification's failure, or null. */
export function brokenFile(text: string): string | null {
  const said = /Broken: (.+?) \(([^()\s]+\.(?:luau|lua))\) (doesn't compile|has errors) \(line (\d+): ([^\n]*?)\)(?:,|\.|$)/m.exec(text);
  if (said) return `${scriptLabel(said[2]!)} ${said[3]} (line ${said[4]}: ${plainText(said[5]!)})`;
  const line = /^(\S+\.(?:luau|lua)):(\d+):\d+ error (\S+?)\/(\S+): (.*)$/m.exec(text);
  if (!line) return null;
  const compiles = line[3] === 'compile' || /syntax|parse/i.test(line[4]!);
  return `${scriptLabel(line[1]!)} ${compiles ? "doesn't compile" : 'has errors'} (line ${line[2]})`;
}

/**
 * The line for a task sent back for another pass, in plain words for each kind of failure: a rejected review names
 * what it found, failed checks name the checks (or the file that doesn't compile), an internal error says so plainly.
 */
export function sendBackLine(title: string, failure: string, more: { review?: Pick<ReviewOutput, 'defects' | 'criteria'> | null; detail?: string | null } = {}): string {
  const t = plainText(title);
  const sentence = (x: string) => {
    const first = x.trim().split(/(?<=[.!?])\s/)[0]!.slice(0, 160);
    return /[.!?]$/.test(first) ? first : `${first}.`;
  };
  if (/^Critic rejected:/.test(failure)) {
    const point = reviewPoint(more.review);
    if (point) return `Another pass for ${t}: the reviewer found ${point}.`;
    return `Another pass for ${t}. The reviewer: ${sentence(plainText(failure.replace(/^Critic rejected:\s*/, '')))}`;
  }
  if (failure.startsWith(NOT_REPRODUCED)) return `Another pass for ${t}: it has to show the problem you reported in Studio before its fix counts.`;
  if (/^Verification failed:/.test(failure)) {
    const broken = brokenFile(`${failure}\n${more.detail ?? ''}`);
    if (broken) return `Another pass for ${t}: ${broken}.`;
    const names = failure
      .replace(/^Verification failed:\s*(\d+ check\(s\) failed:\s*)?/, '')
      .split(' | ')
      .map((x) => plainText(x.split(':')[0]!.trim()))
      .filter(Boolean)
      .slice(0, 3);
    return `Another pass for ${t}: its automated checks failed${names.length ? ` (${names.join(', ')})` : ''}.`;
  }
  if (/^Agent run failed/.test(failure)) return `Another try for ${t}: its run ended with an error.`;
  if (isRawError(failure)) return `Another try for ${t}: ${errorMeaning(failure)}.`;
  return `Another pass for ${t}: ${sentence(plainText(failure))}`;
}

/** One line for a finished triage run: how many reports or suggestions it looked at and how many became tasks. */
export function triageLine(p: ProjectContext, task: Task): string {
  const listed = listedProposalIds(task.objective).length || Number(/\((\d+)\)/.exec(task.title)?.[1] ?? 0);
  const added = p.audit.toolCalls({ taskId: task.id, limit: 500 }).filter((c) => /(^|__)plan_add_task$/.test(c.tool) && c.status === 'ok').length;
  const defects = triageKind(task.title) === 'defects';
  const noun = defects ? `reported problem${listed === 1 ? '' : 's'}` : `suggested improvement${listed === 1 ? '' : 's'}`;
  const outcome = added === 0 ? (defects ? 'none needed a new fix' : 'none was worth a task') : `${added} became ${added === 1 ? 'a task' : 'tasks'}`;
  return `${listed ? `${listed} ${noun}` : defects ? 'Reported problems' : 'Suggested improvements'} looked at: ${outcome}.`;
}

// ─── The progress digest ───────────────────────────────────────────────────

/** How long a progress message takes new lines before the next one starts. An object so a test can shorten it. */
export const DIGEST = { windowMs: 5 * 60_000 };

export interface DigestItem {
  kind: 'done' | 'again' | 'triage';
  text: string;
  at: string;
  taskId?: string;
  /** Send-backs of this task folded into this item. */
  passes?: number;
}

/** The progress message still taking lines: recent, and nothing said by the user or the director since. */
function openDigest(chat: ChatService, now: number): ChatMessage | null {
  const last = chat.findLatest('status', (d) => d.digest === true);
  if (!last || now - Date.parse(last.createdAt) > DIGEST.windowMs) return null;
  const recent = chat.list(40);
  const at = recent.findIndex((m) => m.id === last.id);
  if (at < 0) return null;
  // New lines go below a conversation, never above it where nobody looks.
  if (recent.slice(at + 1).some((m) => m.role === 'user' || m.role === 'director')) return null;
  return last;
}

/** Adds a line to the progress message (a task's later line replaces its earlier one), or starts a new message. */
export function addToDigest(chat: ChatService, item: Omit<DigestItem, 'at'>, now = Date.now()): ChatMessage {
  const at = new Date(now).toISOString();
  const open = openDigest(chat, now);
  const items = open ? ((open.data?.items as DigestItem[] | undefined) ?? []) : [];
  let passes = 0;
  const kept = items.filter((i) => {
    if (!item.taskId || i.taskId !== item.taskId) return true;
    passes += (i.passes ?? 0) + (i.kind === 'again' ? 1 : 0);
    return false;
  });
  const next: DigestItem = { ...item, at, ...(passes ? { passes } : {}) };
  const all = [...kept, next];
  const data = { digest: true, items: all };
  const text = all.map((i) => i.text).join('\n');
  return open ? chat.update(open.id, { text, data })! : chat.add({ role: 'system', kind: 'status', text, data });
}

// ─── Plan cards ────────────────────────────────────────────────────────────

const FINAL_PLAN = new Set(['done', 'cancelled', 'ended']);
const stripCount = (s: string | null | undefined) => (s ?? '').replace(/\s*\(\d+ tasks?\)\s*$/, '').trim();

/** The tasks a planning run added (its plan_add_task calls; the structured-result fallback by time). */
function addedBy(p: ProjectContext, plan: Task, expected?: number | null): string[] {
  const ids: string[] = [];
  for (const c of p.audit.toolCalls({ taskId: plan.id, limit: 500 }).reverse()) {
    if (!/(^|__)plan_add_task$/.test(c.tool) || c.status !== 'ok') continue;
    const id = (c.result as { id?: unknown } | null)?.id;
    if (typeof id === 'string') ids.push(id);
  }
  if (plan.parentId && expected && ids.length < expected && plan.startedAt) {
    // Tasks the planner returned whole (Orchestrator.addTasks) carry no call: the ones made under the goal while it planned.
    const taken = new Set(ids);
    for (const t of p.tasks.list({ parentId: plan.parentId })) {
      if (taken.has(t.id) || t.kind === 'plan' || t.createdBy !== 'executive' || t.createdAt < plan.startedAt || t.status === 'proposed') continue;
      ids.push(t.id);
      if (ids.length >= expected) break;
    }
  }
  return ids;
}

// ─── The narrator ──────────────────────────────────────────────────────────

export interface NarratorDeps {
  project: () => ProjectContext | null;
  bus: EventBus;
  log: ScopedLogger;
  /** The fast model's rewrites (absent or off: the rules alone). */
  plainWords?: PlainWordsLike | null;
  /** The title a goal gets from a request when the director gave none (director.ts titleFromPrompt). */
  heuristicTitle?: (request: string) => string;
}

/** Status lines from the timeline that the chat carries. */
const TIMELINE_LINES = new Set(['account.switched', 'limit.paused', 'limit.wait', 'provider.environment', 'test.quarantined', 'visual.unchecked']);

export class Narrator {
  private readonly lastStatus = new Map<string, string>();
  private readonly titled = new Set<string>();

  constructor(private readonly d: NarratorDeps) {}

  wire(): void {
    const bus = this.d.bus;
    bus.on('plan.updated', (e) => this.guard('plan card', () => this.planUpdated(e)));
    bus.on('escalation.updated', (e) => this.guard('question card', () => this.escalation(e)));
    bus.on('task.updated', (t) => this.guard('task line', () => this.taskUpdated(t)));
    bus.on('timeline', (ev) => this.guard('timeline line', () => this.timeline(ev)));
    // Cards a closed or crashed session left open are settled when the project opens (after recovery).
    bus.on('project.changed', () => this.guard('plan cards', () => this.settlePlanCards()));
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.d.log.warn(`The chat's ${what} failed`, errorMessage(e));
    }
  }

  private ctx(): { p: ProjectContext; chat: ChatService } | null {
    const p = this.d.project();
    return p ? { p, chat: new ChatService(p, this.d.bus) } : null;
  }

  // ── Tasks ──

  private taskUpdated(t: Task): void {
    const prev = this.lastStatus.get(t.id);
    this.lastStatus.set(t.id, t.status);
    if (t.kind === 'objective') {
      if (!prev) this.nameGoal(t);
      if (t.status === 'done' && prev !== 'done') this.goalDone(t);
      return;
    }
    if (!prev || prev === t.status) return;
    const c = this.ctx();
    if (!c) return;
    if (t.kind === 'plan') {
      if (isDecisionTask(t)) return;
      if (isTriagePlan(t)) {
        if (t.status === 'done') addToDigest(c.chat, { kind: 'triage', taskId: t.id, text: triageLine(c.p, t) });
        return;
      }
      this.planTaskChanged(c, t);
      return;
    }
    if (t.status === 'done') {
      addToDigest(c.chat, { kind: 'done', taskId: t.id, text: doneLine(c.p, t) });
    } else if (t.status === 'failed' && t.attempts < t.maxAttempts && t.failureSummary) {
      const failure = c.p.tasks.failures(t.id).at(-1);
      const review = /^Critic rejected:/.test(t.failureSummary) ? (c.p.tasks.evidence(t.id).filter((e) => e.kind === 'critic_review' && e.passed === false).at(-1)?.data as ReviewOutput | null) : null;
      addToDigest(c.chat, { kind: 'again', taskId: t.id, text: sendBackLine(t.title, failure?.summary ?? t.failureSummary, { review, detail: failure?.detail ?? null }) });
    }
  }

  /**
   * A goal named from the user's own words (the director gave no title) gets a real one from the fast model. The
   * project's first goal is the game itself and keeps the game's name.
   */
  private nameGoal(t: Task): void {
    const words = this.d.plainWords;
    const c = this.ctx();
    if (!words || !c || this.titled.has(t.id) || !this.d.heuristicTitle) return;
    if (t.title !== this.d.heuristicTitle(t.objective).slice(0, 80)) return;
    const first = c.p.tasks.list({ kinds: ['objective'] })[0];
    if (!first || first.id === t.id) return;
    this.titled.add(t.id);
    const was = t.title;
    void words
      .title(c.p, t.objective)
      .then((title) => {
        if (!title || this.d.project() !== c.p) return;
        const cur = c.p.tasks.get(t.id);
        if (cur && cur.title === was) c.p.tasks.update(t.id, { title });
      })
      .catch(() => undefined);
  }

  /** A finished goal, honestly: "built and verified" only when no check of it was set aside as still failing. */
  private goalDone(t: Task): void {
    const c = this.ctx();
    if (!c) return;
    // Said once per finish: a goal reopened (a change, a task reported still broken) and finished again is said again.
    const said = c.chat.findLatest('done', (d) => d.objectiveId === t.id);
    if (said && said.createdAt >= (t.completedAt ?? '')) return;
    const kids = c.p.tasks.list({ parentId: t.id }).filter((k) => k.status === 'done' && k.kind !== 'plan');
    const passed = `${kids.length} task${kids.length === 1 ? '' : 's'} passed ${kids.length === 1 ? 'its' : 'their'} checks`;
    const failing = new TestService(c.p.store).list().filter((x) => x.retiredBy === RETIRED_BY_QUARANTINE && !!x.retiredAt && x.retiredAt >= t.createdAt);
    const title = plainText(t.title);
    let text: string;
    if (failing.length) {
      const n = failing.length;
      const names = [...new Set(failing.map((x) => plainText(checkName(x.spec))))].slice(0, 3);
      text = `**${title}** is built; ${n} check${n === 1 ? ' is' : 's are'} still failing (${names.map((x) => `"${x}"`).join(', ')}${n > names.length ? ', …' : ''}). ${n === 1 ? 'It was' : 'They were'} set aside after a repair didn't fix ${n === 1 ? 'it' : 'them'}, so the goal could finish; ${passed}. Tell me if you want ${n === 1 ? 'it' : 'them'} fixed, or what to change next.`;
    } else {
      text = `**${title}** is built and verified — ${passed}. Tell me what to add or change next.`;
    }
    c.chat.add({ role: 'director', kind: 'done', text, data: { objectiveId: t.id, failing: failing.length } });
  }

  // ── Plan cards ──

  private cardFor(chat: ChatService, planTaskId: string): ChatMessage | null {
    return chat.findLatest('plan', (d) => d.planTaskId === planTaskId);
  }

  /** The planning run an event is about: its id, or (the director's "" right after amendPlan) the goal's newest open update. */
  private planTaskOf(p: ProjectContext, objectiveId: string, planTaskId: string): Task | null {
    if (planTaskId) return p.tasks.get(planTaskId);
    const open = p.tasks
      .list({ parentId: objectiveId, kinds: ['plan'] })
      .filter((t) => !isTriagePlan(t) && !isDecisionTask(t) && !['done', 'cancelled'].includes(t.status));
    return open.filter((t) => t.createdBy === 'user').at(-1) ?? open.at(-1) ?? null;
  }

  /** A card shown before its run was known (older builds, or the start page's card): taken over by this run. */
  private adopt(chat: ChatService, objectiveId: string, planTaskId: string): ChatMessage | null {
    const card = chat.findLatest('plan', (d) => d.objectiveId === objectiveId && !d.planTaskId && !d.iteration && !FINAL_PLAN.has(String(d.status)));
    return card ? chat.update(card.id, { data: { ...card.data, planTaskId } }) : null;
  }

  private planningText(plan: Task | null): string {
    return plan?.createdBy === 'user' ? 'Updating the plan…' : 'Planning…';
  }

  private planUpdated(e: CoreEventMap['plan.updated']): void {
    const c = this.ctx();
    if (!c) return;
    const plan = this.planTaskOf(c.p, e.objectiveId, e.planTaskId);
    // Triage folds into the progress message when it finishes (taskUpdated); a decision is a status line of its own.
    if (plan && (isTriagePlan(plan) || isDecisionTask(plan))) return;
    const id = plan?.id ?? '';
    let card = id ? (this.cardFor(c.chat, id) ?? this.adopt(c.chat, e.objectiveId, id)) : null;
    const base = { ...(card?.data ?? {}), objectiveId: e.objectiveId, planTaskId: id || null };
    switch (e.status) {
      case 'planning':
        if (!card) c.chat.add({ role: 'director', kind: 'plan', text: this.planningText(plan), data: { ...base, status: 'planning' } });
        else if (card.data?.status !== 'planning') c.chat.update(card.id, { text: this.planningText(plan), data: { ...base, status: 'planning' } });
        return;
      case 'cancelled':
        if (card) c.chat.update(card.id, { text: plan?.createdBy === 'user' ? 'The plan update was cancelled.' : 'Planning was cancelled.', data: { ...base, status: 'cancelled' } });
        return;
      case 'paused':
        if (card) c.chat.update(card.id, { text: 'Planning was interrupted; it carries on from where it stopped.', data: { ...base, status: 'paused' } });
        return;
      case 'failed': {
        if (!card) return;
        const retries = !plan || plan.attempts < plan.maxAttempts;
        c.chat.update(card.id, { text: retries ? 'Planning hit a problem; trying again.' : 'Planning stopped without a plan.', data: { ...base, status: 'failed' } });
        return;
      }
      case 'done': {
        const taskIds = plan ? addedBy(c.p, plan, e.tasks) : [];
        const data = { ...base, status: 'done', milestone: e.milestone ?? null, tasks: e.tasks ?? taskIds.length, taskIds };
        const text = plainText(e.summary || stripCount(plan?.result) || 'The plan is ready.');
        if (card) c.chat.update(card.id, { text, data });
        else card = c.chat.add({ role: 'director', kind: 'plan', text, data });
        // A "next milestone" goal is named after the milestone its plan chose.
        const goal = c.p.tasks.get(e.objectiveId);
        const name = e.milestone ? shortTitle(e.milestone, 6) : '';
        if (goal && name && isNextMilestone(goal) && goal.title !== name) c.p.tasks.update(goal.id, { title: name });
        return;
      }
    }
  }

  /** A planning run's task changed status: its card follows, so no card outlives its run unfinished. */
  private planTaskChanged(c: { p: ProjectContext; chat: ChatService }, t: Task): void {
    if (!t.parentId) return;
    const card = this.cardFor(c.chat, t.id);
    if (!card || FINAL_PLAN.has(String(card.data?.status))) return;
    this.settle(c, card, t);
  }

  /** Brings a card in line with its run's task (see planTaskChanged and settlePlanCards). */
  private settle(c: { p: ProjectContext; chat: ChatService }, card: ChatMessage, t: Task): void {
    const data = { ...card.data, planTaskId: t.id };
    switch (t.status) {
      case 'done': {
        const taskIds = addedBy(c.p, t);
        c.chat.update(card.id, { text: plainText(stripCount(t.result) || 'The plan is ready.'), data: { ...data, status: 'done', taskIds, tasks: taskIds.length } });
        return;
      }
      case 'cancelled':
        c.chat.update(card.id, { text: t.createdBy === 'user' ? 'The plan update was cancelled.' : 'Planning was cancelled.', data: { ...data, status: 'cancelled' } });
        return;
      case 'escalated':
      case 'blocked':
        c.chat.update(card.id, { text: 'Planning stopped without a plan: it needs a decision first.', data: { ...data, status: 'failed' } });
        return;
      case 'failed':
        if (t.attempts >= t.maxAttempts) c.chat.update(card.id, { text: 'Planning stopped without a plan.', data: { ...data, status: 'failed' } });
        return;
      case 'paused':
        c.chat.update(card.id, { text: 'Planning is paused.', data: { ...data, status: 'paused' } });
        return;
      case 'ready':
        // Not running (a restart, or waiting for its turn after a stop): it carries on when work does.
        if (card.data?.status === 'planning') c.chat.update(card.id, { text: 'Planning was interrupted; it carries on when work resumes.', data: { ...data, status: 'paused' } });
        return;
    }
  }

  /**
   * Every card still saying it plans, checked against its run when the project opens: a run that ended while nobody
   * listened (the app closed, an older version) settles its card; a card no run can finish says so.
   */
  settlePlanCards(): void {
    const c = this.ctx();
    if (!c) return;
    for (const card of c.chat.list(400)) {
      if (card.kind !== 'plan' || card.data?.iteration || FINAL_PLAN.has(String(card.data?.status))) continue;
      const objectiveId = String(card.data?.objectiveId ?? '');
      let task = typeof card.data?.planTaskId === 'string' && card.data.planTaskId ? c.p.tasks.get(card.data.planTaskId) : null;
      if (!task) {
        const open = c.p.tasks
          .list({ parentId: objectiveId, kinds: ['plan'] })
          .filter((t) => !isTriagePlan(t) && !isDecisionTask(t) && !['done', 'cancelled'].includes(t.status) && !this.cardFor(c.chat, t.id));
        if (open.length === 1) task = open[0]!;
        else {
          c.chat.update(card.id, { text: 'This planning run ended without a report.', data: { ...card.data, status: 'ended' } });
          continue;
        }
      }
      if (task.status === 'running') continue;
      this.settle(c, card, task);
    }
  }

  // ── Questions and decisions ──

  private escalation(e: Escalation): void {
    const c = this.ctx();
    if (!c) return;
    // Autonomous mode: what the AI system settled is a plain status line (updated in place once the decision is made), never a card.
    if (e.status === 'auto_resolved') {
      const raw = autoResolvedLine(e);
      const line = plainText(raw);
      const shown = c.chat.findLatest('status', (d) => d.escalationId === e.id);
      const data = { escalationId: e.id, taskId: e.taskId, ...(line !== raw ? { technical: raw } : {}) };
      const msg = shown ? c.chat.update(shown.id, { text: line, data: { ...shown.data, ...data } }) : c.chat.add({ role: 'system', kind: 'status', text: line, data });
      // A line the rules had to change, or a long one, is worth a fast model's rewrite.
      if (msg && this.d.plainWords && (line !== raw || line.length > 260)) {
        void this.d.plainWords
          .line(c.p, raw)
          .then((better) => {
            const cur = better ? c.chat.get(msg.id) : null;
            if (cur && cur.text === line) c.chat.update(msg.id, { text: better!, data: { ...cur.data, technical: raw, plain: 'model' } });
          })
          .catch(() => undefined);
      }
      return;
    }
    const existing = c.chat.findLatest('question', (d) => d.escalationId === e.id);
    if (e.status === 'open' && !existing) {
      const card = questionCard(e);
      const msg = c.chat.add({ role: 'director', kind: 'question', text: card.text, data: card.data });
      void this.d.plainWords
        ?.card(c.p, { title: e.title, detail: e.detail, options: e.options })
        .then((better) => {
          const cur = better ? c.chat.get(msg.id) : null;
          if (!cur || cur.data?.resolved) return;
          c.chat.update(msg.id, { text: better!.text ? `${better!.title}\n\n${better!.text}` : better!.title, data: { ...cur.data, labels: better!.labels, plain: 'model' } });
        })
        .catch(() => undefined);
    } else if (e.status !== 'open' && existing && !existing.data?.resolved) {
      c.chat.update(existing.id, { data: { ...existing.data, resolved: true, dismissed: e.status === 'dismissed', response: e.response ?? e.status } });
    }
  }

  // ── Timeline lines ──

  private timeline(ev: TimelineEvent): void {
    if (!TIMELINE_LINES.has(ev.kind)) return;
    const c = this.ctx();
    if (!c) return;
    const text = timelineLine(ev);
    c.chat.add({ role: 'system', kind: 'status', text, ...(text !== ev.title ? { data: { technical: ev.title } } : {}) });
  }
}

/** A question card as the rules write it (the fast model may rewrite it a moment later). */
export function questionCard(e: Pick<Escalation, 'id' | 'title' | 'detail' | 'options' | 'taskId'>): { text: string; data: Record<string, unknown> } {
  const title = plainText(e.title);
  const first = e.detail
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[-=*#]{3,}$/.test(l));
  const body = first ? plainText(first).slice(0, 400) : '';
  return {
    text: body && body !== title ? `${title}\n\n${body}` : title,
    data: { escalationId: e.id, options: e.options, labels: e.options.map(plainOption), taskId: e.taskId, technical: `${e.title}\n\n${e.detail}`.slice(0, 6000) },
  };
}

/** A timeline event as a chat line, in plain words. */
export function timelineLine(ev: Pick<TimelineEvent, 'kind' | 'title' | 'detail'>): string {
  if (ev.kind === 'provider.environment') {
    const error = String((ev.detail as { error?: unknown } | null)?.error ?? ev.title);
    const why = errorMeaning(error);
    return `Agents can't start right now${why ? ` (${why})` : ''}; retrying automatically.`;
  }
  if (ev.kind === 'test.quarantined') {
    const tests = ((ev.detail as { tests?: Array<{ name?: string }> } | null)?.tests ?? []).map((t) => plainText(String(t.name ?? '').split(':').at(-1) ?? ''));
    const n = tests.length || Number(/Quarantined (\d+)/.exec(ev.title)?.[1] ?? 1);
    const names = [...new Set(tests.filter(Boolean))].slice(0, 3);
    return `${n} automated check${n === 1 ? '' : 's'}${names.length ? ` (${names.map((x) => `"${x}"`).join(', ')}${n > names.length ? ', …' : ''})` : ''} still ${n === 1 ? 'fails' : 'fail'} after a repair and ${n === 1 ? 'was' : 'were'} set aside so the goal can finish. You can turn ${n === 1 ? 'it' : 'them'} back on from the Tests list once fixed.`;
  }
  return plainText(ev.title);
}
