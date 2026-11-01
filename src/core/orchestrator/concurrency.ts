import type { Task } from '@shared/domain';
import { liveWindows, windowKind, type UsageWindowReading } from '@shared/usage';

/**
 * How many agents work at once. On Auto the scheduler starts an agent for every task that is ready, up to the cap
 * (DEFAULT_AGENT_CAP unless the user's slider says otherwise, at most PROJECT_MAX_AGENTS) in one project and
 * APP_MAX_AGENTS across every project window of the app. Planning holds a place like any other agent, and at most the
 * Studio limit (STUDIO_AGENTS unless the slider says otherwise) of a build's running tasks work in Studio at once: a
 * task that would only join Studio's line waits unstarted, at no cost, while off-Studio work goes ahead. Usage does not
 * hold work back: the same work costs the same usage fast or slow (work pauses at the limit and resumes at the reset).
 * Kiln builds have their own limit (kilnBuildsAtOnce) and take nothing from this one, and an agent that is only waiting
 * (for a Kiln build, an upload) holds no place. It can say why the number is what it is (`AgentChoice.why`).
 */
export const AUTO_MIN_AGENTS = 3;
/** The most agents in one project (the top of Settings' slider). */
export const PROJECT_MAX_AGENTS = 32;
/** The most agents Auto runs in one project unless the slider (AppPrefs.agentCap, a project's own agentCap) says otherwise. */
export const DEFAULT_AGENT_CAP = 8;
/** Auto's ceiling: the slider can move it up to here. */
export const AUTO_MAX_AGENTS = PROJECT_MAX_AGENTS;
export const MAX_FIXED_AGENTS = PROJECT_MAX_AGENTS;
/** The most agents across every project window of the app (a safety net: builds themselves are not limited). */
export const APP_MAX_AGENTS = 96;
/** From this share of a usage window the reason line mentions it (nothing is held back). */
export const USAGE_WORTH_SAYING = 0.85;
/**
 * The most of a build's running tasks that work in Studio at once by default; another task that needs Studio waits
 * unstarted. Settings → Agents may set 1 to MAX_STUDIO_AGENTS (AppPrefs.studioAgents). Measured over about 12,000
 * Studio calls in every build on record (2026-10-26), by how many agents were in that Studio at the moment:
 *   in Studio   typical playtest   slowest 1 in 10   playtests that failed
 *   1           25 s               70 s              3%
 *   2           26 s               63 s              4%
 *   3           31 s               106 s             7%
 *   4           36 s               128 s             10%
 *   5-6         49 s               265 s             13%
 *   10+         117 s              534 s             15%
 * Two cost nothing over one; from three Studio's line shows; above four it gets worse fast. That is for playtests, which
 * go one at a time: a long build's agents mostly write code and playtest now and then, so the limit goes well past that
 * and the line is the price when many want a playtest together.
 */
export const STUDIO_AGENTS = 4;
export const MAX_STUDIO_AGENTS = 16;

/** A Studio limit from a preference: 1 to MAX_STUDIO_AGENTS, STUDIO_AGENTS when unset or not a number. */
export function studioLimit(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_STUDIO_AGENTS, n) : STUDIO_AGENTS;
}

/** What Auto chooses from. */
export interface AgentLoad {
  /** Ready tasks that could start now (dependencies met, their files free). */
  ready: number;
  /** Of those, the tasks that don't queue for Studio: code-only, audio, modeling, planning, research. */
  readyOffStudio: number;
  /** Tasks an agent is working on (their checks and review included); agents that only wait don't count. */
  running: number;
  /** Running tasks that work in Studio (studioBound): at the Studio limit, ready tasks that need Studio wait. */
  studioRunning: number;
  /** The most in Studio at once (AppPrefs.studioAgents); STUDIO_AGENTS when absent. */
  studioCap?: number;
  /** The most at once the user chose (Settings' slider, 1 to PROJECT_MAX_AGENTS); none: DEFAULT_AGENT_CAP. */
  cap?: number;
  /** Where `cap` comes from: this project's own setting or the app-wide one (for the reason line). */
  capFrom?: 'project' | 'app';
  /** Agents working in the app's other project windows. */
  elsewhere: number;
  /** The live usage windows of each account runs can use now, the active one first (for the reason line only). */
  accounts: ReadonlyArray<Record<string, UsageWindowReading>>;
  /** Epoch ms. */
  now: number;
}

export interface AgentChoice {
  limit: number;
  /** Why, in plain words: "14 ready, usage 41% of the 5-hour window (room for about 12 at once, resets in 2 h 10 min)". */
  why: string;
}

/** Roles whose work doesn't queue for Studio: they write code or designs, make sounds or models, plan or research. */
const OFF_STUDIO_ROLES: ReadonlySet<string> = new Set(['luau-engineer', 'sound-designer', 'modeler', 'game-designer', 'researcher', 'executive', 'architect']);
const STUDIO_CHECKS: ReadonlySet<string> = new Set(['luau_assert', 'playtest', 'screenshot', 'perf']);

/** Whether a task's checks run in Studio. */
export function studioChecked(task: Pick<Task, 'verification'>): boolean {
  return task.verification.some((m) => STUDIO_CHECKS.has(m.kind));
}

/** Whether a task spends its time in the one Studio (building in the place, playtesting), so it queues there with the others. */
export function studioBound(task: Pick<Task, 'kind' | 'role' | 'verification'>): boolean {
  if (task.kind === 'plan' || task.kind === 'research' || task.kind === 'document') return false;
  return studioChecked(task) || !OFF_STUDIO_ROLES.has(task.role);
}

const fmtIn = (ms: number): string => {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 90) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 >= 5 ? ` ${min % 60} min` : ''}`;
  return `${Math.round(h / 24)} days`;
};

/** The fullest live usage window of an account, or null when nothing is known. */
export function fullestWindow(windows: Record<string, UsageWindowReading>, now: number): { window: string; used: number; resetsInMs: number | null } | null {
  let full: { window: string; used: number; resetsInMs: number | null } | null = null;
  for (const [key, w] of liveWindows(windows, now)) {
    if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const kind = windowKind(key);
    const used = Math.max(0, Math.min(1, w.utilization));
    const resetsInMs = typeof w.resetsAt === 'number' && w.resetsAt > 0 ? w.resetsAt * 1000 - now : null;
    if (!full || used > full.used) full = { window: kind === 'weekly' ? 'weekly' : kind === 'five_hour' ? '5-hour' : key, used, resetsInMs };
  }
  return full;
}

/** What this project may run at most: its own ceiling, within what the app's other projects leave of APP_MAX_AGENTS. */
export function projectCeiling(elsewhere: number): number {
  return Math.max(1, Math.min(PROJECT_MAX_AGENTS, APP_MAX_AGENTS - Math.max(0, elsewhere)));
}

/** Of `ready` tasks that need Studio, how many must wait because `cap` running tasks already work there. */
export function studioHeld(readyInStudio: number, studioRunning: number, cap = STUDIO_AGENTS): number {
  return Math.max(0, readyInStudio - Math.max(0, cap - studioRunning));
}

/**
 * The agents Auto allows now, and why: as many as there is work (working agents plus ready tasks; ready tasks that
 * need Studio count only while fewer than STUDIO_AGENTS running tasks work there), up to the cap. Never under the
 * floor (unless the cap or the app's other projects leave less).
 */
export function autoAgentLimit(load: AgentLoad): AgentChoice {
  const inStudioCap = load.studioCap ?? STUDIO_AGENTS;
  const waitStudio = studioHeld(load.ready - load.readyOffStudio, load.studioRunning, inStudioCap);
  const work = load.running + load.ready - waitStudio;
  const cap = Math.max(1, Math.min(AUTO_MAX_AGENTS, Math.round(load.cap ?? DEFAULT_AGENT_CAP)));
  const ceiling = Math.min(cap, projectCeiling(load.elsewhere));
  const limit = Math.min(ceiling, Math.max(AUTO_MIN_AGENTS, work));

  const parts: string[] = [load.ready === 0 ? 'nothing else is ready' : `${load.ready} ready`];
  if (waitStudio > 0) parts.push(`${waitStudio} of them wait for Studio (${load.studioRunning} running tasks work there, ${inStudioCap} at most)`);
  if (work > ceiling) parts.push(ceiling < cap ? `${ceiling} is what ${load.elsewhere} agents in other projects leave of ${APP_MAX_AGENTS} across the app` : `${ceiling} is the most at once ${load.capFrom === 'project' ? 'set for this project' : 'in Settings'}`);
  const usage = load.accounts.map((w) => fullestWindow(w, load.now));
  const first = usage[0] ?? null;
  // Another account with room (or no reading) means the limit is not near.
  if (first && first.used >= USAGE_WORTH_SAYING && usage.every((u) => u !== null && u.used >= USAGE_WORTH_SAYING))
    parts.push(`usage ${Math.round(first.used * 100)}% of the ${first.window} window (work pauses at the limit${first.resetsInMs !== null && first.resetsInMs > 0 ? ` and resumes in ${fmtIn(first.resetsInMs)}` : ''})`);
  return { limit, why: parts.join(', ') };
}

/** Why a number fixed in Settings is what runs. */
export function fixedAgentWhy(ready: number, fixed: number, elsewhere = 0): string {
  const left = projectCeiling(elsewhere);
  return `${ready === 0 ? 'nothing else is ready' : `${ready} ready`}, fixed at ${fixed} in Settings${left < fixed ? ` (${left} now: ${elsewhere} agents in other projects, ${APP_MAX_AGENTS} across the app)` : ''}`;
}
