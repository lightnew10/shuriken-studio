import type { Task } from '@shared/domain';

/**
 * Agents file problems they find outside their own task as follow-up proposals ("proposed" tasks). They used
 * to wait for the objective's wrap-up before anyone looked at them, which in a 4.6 h build never came: the
 * launch wheelspin was reported by three agents an hour before the user hit it. A real defect is now looked at
 * soon (a batch every ~20 minutes, or as soon as five are waiting) by one short planner run. Optional polish is
 * triaged in rolling batches while agents have spare capacity (in the first A–Z build 94 of 132 proposals were
 * triaged in one batch at the very end and 24 never were), and none is left `proposed` when an objective closes:
 * the wrap-up triages what remains, and what is not worth doing is closed with a reason. Pure rules, unit-tested.
 */

/** Title prefix of the planner task that triages defects reported during the build. */
export const TRIAGE_DEFECTS_PREFIX = 'Triage defects';
/** Title prefix of the planner task that reviews all agents' follow-up proposals before an objective closes. */
export const TRIAGE_PREFIX = 'Triage follow-ups';
/**
 * A defect report waits for the planner no longer than this... (1.16: 20 min and 5, were 10 and 3. Builds ran up to 82
 * triage runs, each a planner run, and planning now holds one of a build's few places: bigger batches, fewer runs.)
 */
export const TRIAGE_AFTER_MS = 20 * 60_000;
/** ...or until this many are waiting. */
export const TRIAGE_BATCH = 5;
/** Title prefix of the planner task that triages optional polish while agents have spare capacity. */
export const TRIAGE_POLISH_PREFIX = 'Triage polish';
/**
 * Polish proposals wait for spare capacity, and then until this many are waiting... (ten, not six: the planner may
 * only turn a few into tasks, see FOLLOW_UP_BUDGET, and chooses better among more).
 */
export const POLISH_BATCH = 10;
/** ...or the oldest has waited this long. */
export const POLISH_AFTER_MS = 30 * 60_000;

/**
 * How much work a goal's follow-ups may add to its plan.
 *
 * Every finished task proposes follow-ups (about five each), a planner run turns the ones "a player would notice"
 * into tasks, and each of those tasks proposes five more. Nothing ended it: in two builds of 14 hours the plans
 * were 24 and 33 tasks, and polish triage added 119 and 85 more (52 and 36 planner runs), with defect triage
 * another 18 and 43. Three quarters of each build's cost went into work nobody had asked for, most of it small
 * (a label two pixels bigger, a calmer grass colour), and neither build could finish, because a goal closes when
 * no task is open.
 *
 * So follow-ups have a budget, a share of the plan's own size. `polish`: the tasks optional improvements may
 * become (rolling polish triage and the wrap-up's). `defects`: the tasks reported defects may become; a real
 * defect is still fixed first, and this is a ceiling against a loop of fixes of fixes, not a target. When a budget
 * is used, the proposals that are left are closed with that reason (they stay readable on the goal), the goal
 * finishes its open tasks and closes. 'unlimited' is the behaviour before budgets.
 */
export type PolishLevel = 'none' | 'light' | 'standard' | 'thorough' | 'unlimited';
export const POLISH_LEVELS: readonly PolishLevel[] = ['none', 'light', 'standard', 'thorough', 'unlimited'];
export const FOLLOW_UP_BUDGET: Record<Exclude<PolishLevel, 'unlimited'>, { polish: number; polishMin: number; defects: number; defectsMin: number }> = {
  none: { polish: 0, polishMin: 0, defects: 0.5, defectsMin: 6 },
  light: { polish: 0.25, polishMin: 2, defects: 0.75, defectsMin: 6 },
  standard: { polish: 0.5, polishMin: 4, defects: 1, defectsMin: 8 },
  thorough: { polish: 1, polishMin: 6, defects: 2, defectsMin: 12 },
};

/**
 * The default is light: the user would rather a build spend its time getting the plan's own tasks right than on rounds
 * of follow-ups ("iteration loops to no end").
 */
export const DEFAULT_POLISH: PolishLevel = 'light';
export const polishLevel = (v: unknown): PolishLevel => (POLISH_LEVELS.includes(v as PolishLevel) ? (v as PolishLevel) : DEFAULT_POLISH);

/** The tasks a goal's follow-ups may become, for a plan of `planned` tasks. */
export function followUpBudget(planned: number, level: PolishLevel): { polish: number; defects: number } {
  if (level === 'unlimited') return { polish: Infinity, defects: Infinity };
  const b = FOLLOW_UP_BUDGET[level];
  const n = Math.max(0, planned);
  return { polish: b.polish === 0 ? 0 : Math.max(b.polishMin, Math.ceil(n * b.polish)), defects: Math.max(b.defectsMin, Math.ceil(n * b.defects)) };
}

/** What a goal's plan and its triage runs have added so far (FollowUpCounts), and what is left of each budget. */
export interface FollowUpCounts {
  /** Tasks the goal's own planning added. */
  planned: number;
  /** Tasks polish triage and the wrap-up triage added. */
  polish: number;
  /** Tasks defect triage added. */
  defects: number;
}
export interface FollowUpRoom extends FollowUpCounts {
  budget: { polish: number; defects: number };
  /** Tasks polish may still become (0: the budget is used). */
  polishLeft: number;
  defectsLeft: number;
}

/** Which budget a planner task's added tasks count against (null: the goal's own planning, which has none). */
export function triageKind(planTitle: string): 'polish' | 'defects' | null {
  if (planTitle.startsWith(TRIAGE_DEFECTS_PREFIX)) return 'defects';
  if (planTitle.startsWith(TRIAGE_POLISH_PREFIX) || planTitle.startsWith(TRIAGE_PREFIX)) return 'polish';
  return null;
}

/**
 * Counts, from the record of the planner's own calls, what was added to a goal by whom: `rows` are the goal's
 * planner tasks' titles, one per task a plan_add_task call of theirs added. (The tasks carry no mark of where they
 * came from; the calls do, also in builds that began before budgets existed.)
 */
export function followUpCounts(rows: ReadonlyArray<{ title: string }>): FollowUpCounts {
  const out: FollowUpCounts = { planned: 0, polish: 0, defects: 0 };
  for (const r of rows) {
    const kind = triageKind(r.title);
    if (kind === 'polish') out.polish++;
    else if (kind === 'defects') out.defects++;
    else out.planned++;
  }
  return out;
}

/**
 * A goal's counts, read from the project's record of tool calls: one row per plan_add_task call of the goal's
 * planner tasks that added a task or is adding one right now (a call is recorded as pending while it runs, so
 * calls made side by side in one turn see each other).
 */
export function readFollowUpCounts(store: { all<T>(sql: string, params?: string[]): T[] }, objectiveId: string): FollowUpCounts {
  const rows = store.all<{ title: string; status: string }>(
    `SELECT pt.title AS title, c.status AS status FROM tool_calls c JOIN tasks pt ON pt.id = c.task_id WHERE pt.parent_id = ? AND pt.kind = 'plan' AND c.tool = 'plan_add_task' AND c.status IN ('ok', 'pending')`,
    [objectiveId],
  );
  const counts = followUpCounts(rows);
  // A plan that was not added call by call (returned whole by the planner, or made of tasks the user or the
  // director added): the goal's work that is neither a proposal nor a triage run's (a call that is still running
  // has made no task yet).
  const made = followUpCounts(rows.filter((r) => r.status === 'ok'));
  const work = store.all<{ n: number }>(
    `SELECT count(*) AS n FROM tasks WHERE parent_id = ? AND kind NOT IN ('plan', 'objective') AND reason NOT LIKE 'Follow-up proposed by%' AND reason NOT LIKE '${DEFECT_REASON}%'`,
    [objectiveId],
  )[0]?.n ?? 0;
  return { ...counts, planned: Math.max(counts.planned, work - made.polish - made.defects) };
}

export function followUpRoom(counts: FollowUpCounts, level: PolishLevel): FollowUpRoom {
  const budget = followUpBudget(counts.planned, level);
  return { ...counts, budget, polishLeft: Math.max(0, budget.polish - counts.polish), defectsLeft: Math.max(0, budget.defects - counts.defects) };
}

/** The reason recorded on a proposal that was closed because its goal's budget for follow-ups was used. */
export const closedForBudget = (defect: boolean, room: FollowUpRoom): string =>
  defect
    ? `Closed: this goal's follow-up fixes are used up (${room.defects} tasks came of reported defects; the limit for a plan of ${room.planned} is ${room.budget.defects}). Ask the director if you want it fixed.`
    : `Closed: this goal's polish budget is used (${room.polish} of ${room.budget.polish} tasks; Settings, Agents, "Polish"). Ask the director if you want it done.`;
/**
 * What the chat says, once, when a goal's budget for follow-ups is used. In plain, correct words: the count can be past
 * the limit (a plan that shrank, a build from before budgets), and the old line read "44 tasks have come of defects the
 * team reported, which is the limit for a plan of 34 tasks (17)".
 */
export function budgetNotice(goal: string, defect: boolean, room: FollowUpRoom): string {
  const s = (n: number) => (n === 1 ? '' : 's');
  const plan = `${room.planned} planned task${s(room.planned)}`;
  if (defect) {
    const used = room.defects;
    const limit = room.budget.defects;
    const where = used > limit ? `more than this goal's limit of ${limit}` : `which is this goal's limit (${limit}, for ${plan})`;
    return `"${goal}": the team's bug reports have already become ${used} fix task${s(used)}, ${where}. New reports are now closed instead of fixed, so the goal can finish; you can still read them on the goal. Tell me which ones you want fixed, or raise "Polish" in Settings → Agents.`;
  }
  if (room.budget.polish === 0) return `"${goal}": improvements the team suggests are closed, not done, because "Polish" is set to none (Settings → Agents). You can still read them on the goal; tell me which ones you want.`;
  const used = room.polish;
  const limit = room.budget.polish;
  return `"${goal}": the plan had ${plan}, and ${used} more came from improvements the team suggested, ${used > limit ? `more than the limit of ${limit}` : `which is the limit (${limit})`}. Further suggestions are now closed, not done, so the goal can finish; you can still read them on the goal. Tell me which ones you want, or raise "Polish" in Settings → Agents.`;
}

/** Start of closedForBudget's reasons (how the timeline and the tests recognize them). */
export const CLOSED_FOR_BUDGET = 'Closed: this goal\'s ';

/** What a triage run is told about its budget (appended to its brief). */
export function budgetLine(kind: 'polish' | 'defects', left: number): string {
  if (!Number.isFinite(left)) return '';
  return kind === 'polish'
    ? `\n\nBUDGET: this goal may still get ${left} polish task${left === 1 ? '' : 's'}, in all. So choose: the ${left === 1 ? 'one improvement' : `${left} improvements`} a player would notice most in their first minutes (something that looks wrong or confuses comes before something that could look nicer), merged where they touch the same thing. plan_add_task refuses more. Everything else is cancelled; nothing is lost, the proposals stay readable on the goal.`
    : `\n\nBUDGET: this goal may still get ${left} task${left === 1 ? '' : 's'} for reported defects, in all. Take what breaks the game for a player first, merge reports of one cause into one task, and cancel what is cosmetic. plan_add_task refuses more.`;
}
/** Wrap-up triage runs per objective; what is proposed after the last one is closed with a reason, not triaged again. */
export const MAX_WRAPUP_TRIAGES = 2;
/** Optional ideas one run may file (its first ones; reported defects are never limited). */
export const MAX_POLISH_PER_RUN = 2;
/** Start of the reason recorded on a proposal that is a defect (not optional polish). */
export const DEFECT_REASON = 'Defect reported by';

const DEFECT_PREFIX = /^\s*\[?(?:defect|bug)\]?\s*[:\-–—]\s*/i;
const POLISH_PREFIX = /^\s*\[?(?:polish|optional|idea|nice[- ]to[- ]have|suggestion)\]?\s*[:\-–—]\s*/i;
/** Wording of something that is broken, in the way agents write it down. */
const DEFECT_WORDS =
  /\b(bugs?|broken|breaks|crash(?:es|ed|ing)?|errors?|exceptions?|fail(?:s|ed|ing|ures?)?|doesn'?t work|does not work|not working|won'?t|can'?t|cannot|unable to|stuck|soft-?lock(?:s|ed)?|wheel-?spin(?:s|ning)?|glitch(?:es|ed|y)?|desync(?:s|ed)?|regress(?:ion|ed|es)?|exploit(?:s|able)?|unplayable|invisible|falls? through|clips? through)\b|\b(?:doesn'?t|does not|don'?t|do not|didn'?t|did not|never|won'?t|will not|isn'?t|is not|aren'?t|are not)\s+(?:\w+\s+){0,2}(?:fire|trigger|spawn|appear|load|play|move|work|count|show|register|start|end|finish|update|save|reset|respond|detect|hit|land|open|close|apply|follow|stop|reach)\b/i;
/** Wording of an optional improvement. */
const POLISH_WORDS = /\b(polish|optional|nice[- ]to[- ]have|would be nice|could be (?:improved|better|nicer)|consider|maybe|might want|idea|cosmetic|tweak|enhancement|stretch goal|in the future|eventually)\b/i;

/**
 * Whether a follow-up is a defect a player would hit (worth triaging soon) or optional polish. An explicit
 * "DEFECT:" / "POLISH:" prefix (what the agents' schemas ask for) decides; otherwise the wording does: broken-
 * behaviour words without "optional/nice to have" words. `text` is the follow-up without its prefix.
 */
export function classifyFollowUp(raw: string): { defect: boolean; text: string } {
  if (DEFECT_PREFIX.test(raw)) return { defect: true, text: raw.replace(DEFECT_PREFIX, '').trim() };
  if (POLISH_PREFIX.test(raw)) return { defect: false, text: raw.replace(POLISH_PREFIX, '').trim() };
  return { defect: DEFECT_WORDS.test(raw) && !POLISH_WORDS.test(raw), text: raw.trim() };
}

/** A proposal an agent filed as a defect (see DEFECT_REASON), not yet looked at by the planner. */
export const isDefectProposal = (t: Task): boolean => t.status === 'proposed' && t.createdBy !== 'user' && t.reason.startsWith(DEFECT_REASON);

/** A proposal an agent filed as optional polish, not yet looked at by the planner. */
export const isPolishProposal = (t: Task): boolean => t.status === 'proposed' && t.createdBy !== 'user' && !t.reason.startsWith(DEFECT_REASON);

/** Whether a plan task is a triage run (of defects or polish during the build, or of everything at the wrap-up). */
export const isTriagePlan = (t: Task): boolean => t.kind === 'plan' && (t.title.startsWith(TRIAGE_DEFECTS_PREFIX) || t.title.startsWith(TRIAGE_POLISH_PREFIX) || t.title.startsWith(TRIAGE_PREFIX));

/** Whether a batch of waiting defect reports is due for the planner now: three of them, or the oldest has waited long enough. */
export function triageDue(batch: readonly Task[], now: number): boolean {
  if (!batch.length) return false;
  if (batch.length >= TRIAGE_BATCH) return true;
  const oldest = Math.min(...batch.map((t) => Date.parse(t.createdAt)));
  return now - oldest >= TRIAGE_AFTER_MS;
}

/**
 * The batches due for triage now, by objective: an objective's waiting defect reports, unless a triage run for it
 * is already waiting or running. Only objectives still being built (running, or ready for more) are triaged:
 * the wrap-up looks at the rest.
 */
export function dueBatches(tasks: readonly Task[], now: number): Array<{ objectiveId: string; batch: Task[] }> {
  return batches(tasks, now, isDefectProposal, triageDue);
}

/** Whether a batch of waiting polish proposals is due (given spare capacity): POLISH_BATCH of them, or the oldest has waited POLISH_AFTER_MS. */
export function polishDue(batch: readonly Task[], now: number): boolean {
  if (!batch.length) return false;
  if (batch.length >= POLISH_BATCH) return true;
  return now - Math.min(...batch.map((t) => Date.parse(t.createdAt))) >= POLISH_AFTER_MS;
}

/**
 * The polish batches due now, by objective, under the same rules as dueBatches (one triage run per objective at a
 * time, only objectives still being built). The caller asks only while agents have spare capacity.
 */
export function duePolishBatches(tasks: readonly Task[], now: number): Array<{ objectiveId: string; batch: Task[] }> {
  return batches(tasks, now, isPolishProposal, polishDue);
}

function batches(tasks: readonly Task[], now: number, pick: (t: Task) => boolean, due: (batch: readonly Task[], now: number) => boolean): Array<{ objectiveId: string; batch: Task[] }> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = new Set(tasks.filter((t) => isTriagePlan(t) && (t.status === 'ready' || t.status === 'running')).map((t) => t.parentId));
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!pick(t) || !t.parentId) continue;
    const list = groups.get(t.parentId) ?? [];
    list.push(t);
    groups.set(t.parentId, list);
  }
  const out: Array<{ objectiveId: string; batch: Task[] }> = [];
  for (const [objectiveId, batch] of groups) {
    const objective = byId.get(objectiveId);
    if (!objective || objective.kind !== 'objective' || (objective.status !== 'running' && objective.status !== 'ready')) continue;
    if (open.has(objectiveId) || !due(batch, now)) continue;
    out.push({ objectiveId, batch });
  }
  return out;
}

/** The ids of the proposals a triage task lists ("- [task_…] text"). */
export function listedProposalIds(planObjective: string): string[] {
  return [...planObjective.matchAll(/^- \[([^\]\s]+)\]/gm)].map((m) => m[1]!);
}

/** The brief of a defect triage run: short, so the run is cheap. */
export function defectTriageObjective(lines: readonly string[], left = Infinity): string {
  return [
    'While the game was being built, agents reported these defects they found outside their own tasks:',
    '',
    ...lines,
    '',
    'Triage them now, quickly (no research): for each one that is a real defect a player would hit and that no finished or planned task already covers, add ONE task for the RIGHT specialist with plan_add_task (merge reports of the same problem into one task; say what is wrong, where, and how to see it fixed; it starts at once). Skip anything cosmetic, already covered, or not a defect. Then cancel EVERY listed proposal with plan_cancel_task (your tasks replace them). Adding no tasks is fine. Put the independent plan_add_task calls and the cancellations in the same turn and finish in at most three turns.',
  ].join('\n') + budgetLine('defects', left);
}

/** The brief of a polish triage run: agents are free, so the few improvements a player would notice become tasks now. */
export function polishTriageObjective(lines: readonly string[], left = Infinity): string {
  return [
    'Agents have spare capacity right now. While building, agents proposed these optional improvements:',
    '',
    ...lines,
    '',
    'Triage them now, quickly (no research): add ONE task with plan_add_task for each improvement a player would notice and that no finished or planned task already covers (merge overlapping proposals into one task for the RIGHT specialist; say what to change, where, and how to see it done; exact files; it starts at once). Then cancel EVERY listed proposal with plan_cancel_task: the ones you turned into tasks, and the ones not worth doing with the reason why (already covered, too small to notice, out of scope). Adding no tasks is fine. Put the independent plan_add_task calls and the cancellations in the same turn and finish in at most three turns.',
  ].join('\n') + budgetLine('polish', left);
}

/** Reason recorded on a proposal a triage run was shown and did not turn into a task or cancel itself. */
export const CLOSED_AT_TRIAGE = 'Closed at triage: the planner did not take it up (already covered, or not worth a task)';
/** Reason recorded on a proposal that was still waiting when its objective finished. */
export const closedAtWrapUp = (iteration: boolean): string =>
  iteration
    ? 'Closed with the quick iteration: optional polish is not part of an iteration (ask the director if you want it done)'
    : 'Closed when the goal finished: it was proposed after the last follow-up triage (ask the director if you want it done)';
