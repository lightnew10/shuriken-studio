import { newId } from '@shared/ids';
import { kilnAtLeast } from './kiln-version';

/**
 * Shuriken's queue of Kiln builds. Kiln itself queues nothing: every brief starts a turn at once, each
 * open project is one Blender, and every Blender renders and bakes on the same GPU, so the caller is the
 * only limit (Kiln's docs/INTEGRATION.md). A build is one copilot turn on one Kiln project plus bringing
 * its result in; builds wait first in, first out, at most `kilnBuildsAtOnce` run, and two builds of the
 * same Kiln project never run together.
 *
 * The limit is the user's (Settings, 1-32, default 8), with two safety rules. Against a Kiln older than
 * 0.8.2 it is at most 6, whatever the setting: that Kiln doesn't gate simultaneous GPU work, and 12
 * Blenders rendering at once froze a PC with an 8 GB graphics card (2026-10-01). Kiln 0.8.2 lets only 3
 * renders or bakes run at the same moment itself, so there the setting applies as given. And the queue
 * steps its own limit DOWN on evidence (builds failing, Kiln refusing briefs with 503, turns or bakes
 * slowing sharply while several run, builds queuing for Kiln's GPU gate) and says so in one line; it
 * never steps back up by itself.
 *
 * A build runs to its end whether or not an agent waits for it, so a modeler can queue several and wait
 * for all of them in one call, instead of one agent sitting idle per build.
 */

/** The default for `kilnBuildsAtOnce` (Settings → Agents → Kiln). */
export const KILN_BUILDS_DEFAULT = 8;
export const KILN_BUILDS_MAX = 32;
/** The most builds at once against a Kiln that doesn't gate GPU work itself (older than KILN_GPU_GATE_VERSION). */
export const KILN_BUILDS_UNGATED = 6;
/** The first Kiln that runs only a few renders and bakes at a time across all its projects. */
export const KILN_GPU_GATE_VERSION = '0.8.2';
/** Shuriken's own GPU work through Kiln (Roblox bakes, renders) at the same moment, against a Kiln that doesn't gate it. */
export const KILN_GPU_JOBS_UNGATED = 2;

/** A bake of one model takes 10-30 s on the GPU (Kiln's docs): past this it is slowing sharply. */
export const SLOW_BAKE_MS = 120_000;
/**
 * A turn at high effort runs for minutes; past this something is starving it. Only against a Kiln without its own
 * GPU gate (older than 0.8.2): how long a turn takes is the copilot's effort and its brief, not the load. In the
 * user's three simultaneous builds two kits at max effort took 55 and 56 minutes, the queue read that as trouble
 * and ran 3 builds at once instead of 5 for the rest of the day. A gated Kiln says itself when builds queue for
 * the graphics card (observeLoad).
 */
export const SLOW_TURN_MS = 30 * 60_000;
/** A limit the queue stepped down goes back up by one after this long without new trouble. */
export const STEP_UP_MS = 15 * 60_000;
/** Against builds that ran with little company: this many times slower counts as slowing sharply. */
const SLOW_FACTOR = 2.5;
/** Troubled builds among the last WINDOW that step the limit down. */
const WINDOW = 4;
const TROUBLED = 2;
/** Builds queuing for Kiln's GPU gate (GET /api/v1/load, Kiln 0.8.2): waiting without a break for this long, or this much waiting added within it. */
export const GPU_QUEUE_MS = 60_000;
/** After a step down for the GPU, the load is watched afresh for this long before another. */
const GPU_COOLDOWN_MS = 2 * 60_000;

/**
 * What a build is expected to take, from Kiln 0.8.2's own measured builds (2026-10-01, briefs as Shuriken
 * sends them): a kit of parts 9.8 min and $1.95, one prop 5.4 min and $1.20, a follow-on change 3.1 min and $0.64.
 */
export function estimateBuild(kind: string | null, family: boolean): { minutes: number; usd: number } {
  if (kind === 'fix' || kind === 'animate') return { minutes: 3.1, usd: 0.64 };
  return family ? { minutes: 9.8, usd: 1.95 } : { minutes: 5.4, usd: 1.2 };
}

export const clampBuilds = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(KILN_BUILDS_MAX, n) : KILN_BUILDS_DEFAULT;
};

/** The limit that applies: the setting, held to 6 against a Kiln without its own GPU gate (an unknown version counts as one). */
export function effectiveBuildLimit(setting: number, kilnVersion: string | null): { limit: number; capped: boolean; why: string | null } {
  const want = clampBuilds(setting);
  if (kilnAtLeast(kilnVersion, KILN_GPU_GATE_VERSION) || want <= KILN_BUILDS_UNGATED) return { limit: want, capped: false, why: null };
  return { limit: KILN_BUILDS_UNGATED, capped: true, why: `Kiln ${kilnVersion ?? '(version unknown)'} runs at most ${KILN_BUILDS_UNGATED} builds at once; Kiln ${KILN_GPU_GATE_VERSION} lifts this` };
}

export type BuildState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface KilnBuild {
  id: string;
  /** The Shuriken project it belongs to. */
  root: string;
  /** The model or family being built. */
  name: string;
  kilnProject: string;
  kind: string | null;
  /** Who asked (a role's label). */
  by: string | null;
  runId: string | null;
  taskId: string | null;
  state: BuildState;
  /** What it is doing now, in a few words. */
  step: string | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  turn: string | null;
  effort: string | null;
  /** What the turn cost, when Kiln reports it. */
  costUsd: number | null;
  error: string | null;
  /** Several models in one Kiln project (a kit of parts). */
  family?: boolean;
  /** How far Kiln's copilot is (GET turns/:id `progress`, Kiln 0.8.2): its plan's steps, the step in hand, a rough time left, the newest render. */
  progress?: { done: number | null; total: number | null; current: string | null; etaMs: number | null; lastRender: string | null } | null;
}

/** Kiln's GPU gate as GET /api/v1/load reports it (0.8.2). */
export interface KilnLoad {
  /** Renders and bakes waiting for a slot now. */
  waiting: number;
  /** How long builds have waited for the GPU in all (ms): it only grows. */
  waitedMs: number;
}

/** How a build went, for the queue's own judgement of its limit. */
export interface BuildEvidence {
  /** Kiln refused the brief for want of resources (503). */
  refused?: boolean;
  /** The copilot's turn, from the brief to its delivery. */
  turnMs?: number;
  /** Kiln's Roblox bake. */
  bakeMs?: number;
  /** The failure is not about load (the account's usage limit, the user's Stop, a brief Kiln rejected). */
  unrelated?: boolean;
}

export interface BuildEnd<T> {
  state: 'done' | 'failed' | 'stopped';
  result?: T;
  error?: string;
  evidence?: BuildEvidence;
}

export interface BuildFinished<T = unknown> {
  build: KilnBuild;
  result: T | null;
}

interface Entry {
  build: KilnBuild;
  run: (build: KilnBuild, signal: AbortSignal) => Promise<BuildEnd<unknown>>;
  ctl: AbortController;
  done: Promise<BuildFinished>;
  settle: (r: BuildFinished) => void;
  result: unknown;
  /** The most builds that ran together while this one did. */
  peak: number;
}

interface Sample {
  name: string;
  peak: number;
  trouble: string | null;
  turnMs: number | null;
  bakeMs: number | null;
}

export interface QueueStatus {
  running: number;
  queued: number;
  /** Builds that may run at once right now. */
  atOnce: number;
  /** The user's setting. */
  setting: number;
  /** Why fewer run than the setting allows, in one line (null when the setting applies). */
  note: string | null;
  /** What the builds waiting and running are expected to cost and take from now (see estimateBuild), when there are any. */
  estimate?: { usd: number; minutes: number };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const mins = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
/** The one line about a limit the queue lowered itself: why, what it is now, and that it comes back. */
const steppedNote = (s: { limit: number; cause: string }) => `${s.cause}, so ${s.limit} run${s.limit === 1 ? 's' : ''} at once now. One more runs again after every ${Math.round(STEP_UP_MS / 60_000)} minutes without trouble.`;

export class KilnBuildQueue {
  private readonly entries: Entry[] = [];
  private samples: Sample[] = [];
  /** The limit the queue set itself after trouble (null: none), and the setting it was stepped down under. */
  private stepped: { limit: number; cause: string; setting: number; at: number } | null = null;
  /** Readings of Kiln's GPU gate while several builds ran. */
  private loads: Array<{ at: number; waiting: number; waitedMs: number }> = [];
  private gpuSteppedAt = 0;

  constructor(
    private readonly o: {
      /** `kilnBuildsAtOnce` from Settings. */
      setting: () => number;
      /** The running Kiln's version (null when it doesn't answer). */
      kilnVersion: () => string | null;
      /** Builds started, ended or changed step. */
      onChange?: () => void;
      /** One plain line for the user when the queue lowers its own limit. */
      say?: (line: string) => void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  get running(): number {
    return this.entries.filter((e) => e.build.state === 'running').length;
  }

  get queued(): number {
    return this.entries.filter((e) => e.build.state === 'queued').length;
  }

  /** How many may run at once now, and why it is less than the setting when it is. */
  status(): QueueStatus {
    const setting = clampBuilds(this.o.setting());
    // The user changed the setting: their number counts again.
    if (this.stepped && this.stepped.setting !== setting) this.stepped = null;
    const eff = effectiveBuildLimit(setting, this.o.kilnVersion());
    // A quiet quarter of an hour: one more may run again (and one more after the next), up to the setting.
    while (this.stepped && this.now() - this.stepped.at >= STEP_UP_MS) {
      this.stepped = this.stepped.limit + 1 >= eff.limit ? null : { ...this.stepped, limit: this.stepped.limit + 1, at: this.stepped.at + STEP_UP_MS };
    }
    const stepped = this.stepped && this.stepped.limit < eff.limit ? this.stepped : null;
    const atOnce = stepped ? stepped.limit : eff.limit;
    const note = stepped ? steppedNote(stepped) : eff.why;
    const open = this.entries.filter((e) => e.build.state === 'queued' || e.build.state === 'running').map((e) => e.build);
    if (!open.length) return { running: 0, queued: 0, atOnce, setting, note };
    // From now: a running build's own estimate when Kiln gives one, else what such a build took when measured; the waiting ones after them.
    const left = open.map((b) => {
      const whole = estimateBuild(b.kind, !!b.family);
      const ms = b.state === 'running' ? (b.progress?.etaMs ?? Math.max(60_000, whole.minutes * 60_000 - (this.now() - (b.startedAt ?? this.now())))) : whole.minutes * 60_000;
      return { usd: whole.usd, ms };
    });
    const lanes = Math.max(1, Math.min(atOnce, open.length));
    const minutes = Math.max(...left.map((l) => l.ms), left.reduce((t, l) => t + l.ms, 0) / lanes) / 60_000;
    return { running: this.running, queued: this.queued, atOnce, setting, note, estimate: { usd: Math.round(left.reduce((t, l) => t + l.usd, 0) * 100) / 100, minutes: Math.round(minutes) } };
  }

  /**
   * A reading of Kiln's GPU gate (0.8.2 lets 3 renders or bakes run at once; the rest wait). Builds
   * waiting for it without a break for a minute, or a minute of waiting added within a minute, mean more
   * parallel builds will not finish sooner: the limit steps down, once per two minutes at most.
   */
  observeLoad(load: KilnLoad): void {
    const now = this.now();
    // A limit that went back up lets a waiting build start.
    this.pump();
    if (this.running <= 1) {
      this.loads = [];
      return;
    }
    this.loads.push({ at: now, waiting: Math.max(0, load.waiting), waitedMs: Math.max(0, load.waitedMs) });
    this.loads = this.loads.filter((l) => now - l.at <= GPU_QUEUE_MS * 2);
    if (now - this.gpuSteppedAt < GPU_COOLDOWN_MS) return;
    const first = this.loads[0]!;
    const span = now - first.at;
    if (span < GPU_QUEUE_MS) return;
    const window = this.loads.filter((l) => now - l.at <= GPU_QUEUE_MS + 1);
    const stuck = window.length >= 3 && window.every((l) => l.waiting > 0);
    const base = window[0]!;
    const climbed = load.waitedMs - base.waitedMs;
    if (!stuck && climbed < GPU_QUEUE_MS) return;
    const { atOnce, setting } = this.status();
    if (atOnce <= 1) return;
    const limit = Math.max(1, Math.min(atOnce - 1, Math.floor((atOnce * 2) / 3)));
    const what = stuck ? `${load.waiting} waiting for the graphics card for over a minute` : `${mins(climbed)} of waiting for the graphics card in the last minute`;
    this.stepped = { limit, cause: `Kiln builds were queuing for the graphics card with ${atOnce} at once (${what})`, setting, at: now };
    this.gpuSteppedAt = now;
    this.loads = [];
    this.o.say?.(steppedNote(this.stepped));
    this.o.onChange?.();
  }

  /** Builds of a project (all projects when none is given): waiting and running ones first in queue order, then the latest finished. */
  list(root?: string): KilnBuild[] {
    const mine = this.entries.filter((e) => !root || e.build.root.toLowerCase() === root.toLowerCase()).map((e) => e.build);
    return [...mine.filter((b) => b.state === 'running'), ...mine.filter((b) => b.state === 'queued'), ...mine.filter((b) => b.endedAt !== null).sort((a, b) => b.endedAt! - a.endedAt!)];
  }

  get(id: string): KilnBuild | null {
    return this.entries.find((e) => e.build.id === id)?.build ?? null;
  }

  /** A queued build's place in line (1 = next), or null. */
  position(id: string): number | null {
    const waiting = this.entries.filter((e) => e.build.state === 'queued');
    const i = waiting.findIndex((e) => e.build.id === id);
    return i < 0 ? null : i + 1;
  }

  /** The result a finished build left (null while it runs, or when it failed). */
  resultOf<T>(id: string): T | null {
    return (this.entries.find((e) => e.build.id === id)?.result as T | undefined) ?? null;
  }

  /** Resolves when the build has ended (at once if it has). */
  wait(id: string): Promise<BuildFinished> | null {
    return this.entries.find((e) => e.build.id === id)?.done ?? null;
  }

  /**
   * Puts a build in line. `run` does the work when its turn comes (the brief, following the turn,
   * bringing the result in) and says how it ended; it must not throw for an ordinary failure.
   */
  submit<T>(info: Pick<KilnBuild, 'root' | 'name' | 'kilnProject' | 'kind' | 'by' | 'runId' | 'taskId' | 'family'>, run: (build: KilnBuild, signal: AbortSignal) => Promise<BuildEnd<T>>): { build: KilnBuild; done: Promise<BuildFinished<T>> } {
    const build: KilnBuild = { ...info, id: newId('kb'), state: 'queued', step: null, queuedAt: this.now(), startedAt: null, endedAt: null, turn: null, effort: null, costUsd: null, error: null };
    let settle!: (r: BuildFinished) => void;
    const done = new Promise<BuildFinished>((ok) => (settle = ok));
    this.entries.push({ build, run, ctl: new AbortController(), done, settle, result: null, peak: 0 });
    this.trim();
    this.pump();
    this.o.onChange?.();
    return { build, done: done as Promise<BuildFinished<T>> };
  }

  /** Takes a waiting build out of line, or stops following a running one (Kiln's turn itself is left to the caller's `run`). */
  stop(id: string): boolean {
    const e = this.entries.find((x) => x.build.id === id);
    if (!e || e.build.endedAt !== null) return false;
    if (e.build.state === 'queued') {
      e.build.state = 'stopped';
      e.build.endedAt = this.now();
      e.build.error = 'Taken out of the queue';
      e.settle({ build: e.build, result: null });
      this.o.onChange?.();
      return true;
    }
    e.ctl.abort();
    return true;
  }

  /** A step of a running build changed (for whoever shows the queue). */
  touch(): void {
    this.o.onChange?.();
  }

  /** Starts waiting builds while there is room: first in, first out, skipping one whose Kiln project is still busy with another build. */
  private pump(): void {
    for (;;) {
      const { atOnce } = this.status();
      const busy = new Set(this.entries.filter((e) => e.build.state === 'running').map((e) => e.build.kilnProject));
      if (busy.size >= atOnce || this.running >= atOnce) return;
      const next = this.entries.find((e) => e.build.state === 'queued' && !busy.has(e.build.kilnProject));
      if (!next) return;
      this.start(next);
    }
  }

  private start(e: Entry): void {
    e.build.state = 'running';
    e.build.startedAt = this.now();
    const together = this.running;
    for (const x of this.entries) if (x.build.state === 'running') x.peak = Math.max(x.peak, together);
    void (async () => {
      let end: BuildEnd<unknown>;
      try {
        end = await e.run(e.build, e.ctl.signal);
      } catch (err) {
        end = { state: 'failed', error: (err as Error).message };
      }
      e.build.state = end.state;
      e.build.endedAt = this.now();
      e.build.step = null;
      e.build.progress = null;
      e.build.error = end.state === 'done' ? null : (end.error ?? `ended ${end.state}`);
      e.result = end.result ?? null;
      this.judge(e, end);
      e.settle({ build: e.build, result: e.result });
      this.pump();
      this.o.onChange?.();
    })();
  }

  /** What a finished build says about the load, and the step down when enough of the latest ones were in trouble. */
  private judge(e: Entry, end: BuildEnd<unknown>): void {
    const ev = end.evidence ?? {};
    const calm = this.samples.filter((s) => s.peak <= Math.min(3, Math.max(1, e.peak - 1)) && !s.trouble);
    const turnBase = median(calm.flatMap((s) => (s.turnMs ? [s.turnMs] : [])));
    const bakeBase = median(calm.flatMap((s) => (s.bakeMs ? [s.bakeMs] : [])));
    let trouble: string | null = null;
    if (ev.refused) trouble = 'Kiln refused its brief (503)';
    else if (end.state === 'failed' && !ev.unrelated) trouble = 'failed';
    else if (end.state === 'done' && e.peak > 1) {
      const slowBake = ev.bakeMs !== undefined && (ev.bakeMs > SLOW_BAKE_MS || (bakeBase !== null && calm.length >= 2 && ev.bakeMs > bakeBase * SLOW_FACTOR && ev.bakeMs > 30_000));
      const gated = kilnAtLeast(this.o.kilnVersion(), KILN_GPU_GATE_VERSION);
      const slowTurn = !gated && ev.turnMs !== undefined && (ev.turnMs > SLOW_TURN_MS || (turnBase !== null && calm.length >= 2 && ev.turnMs > turnBase * SLOW_FACTOR));
      if (slowBake) trouble = `its bake took ${mins(ev.bakeMs!)}`;
      else if (slowTurn) trouble = `its turn took ${mins(ev.turnMs!)}`;
    }
    this.samples.push({ name: e.build.name, peak: e.peak, trouble, turnMs: ev.turnMs ?? null, bakeMs: ev.bakeMs ?? null });
    if (this.samples.length > 60) this.samples = this.samples.slice(-60);
    if (!trouble || e.peak <= 1) return;
    const { atOnce, setting } = this.status();
    if (atOnce <= 1) return;
    const recent = this.samples.slice(-WINDOW).filter((s) => s.trouble && s.peak > 1);
    // A refusal is Kiln saying it has no room: one is enough. Otherwise two of the last four.
    if (!ev.refused && recent.length < TROUBLED) return;
    const limit = Math.max(1, Math.min(atOnce - 1, Math.floor((atOnce * 2) / 3)));
    this.stepped = { limit, cause: `Kiln builds were in trouble with ${atOnce} at once (${recent.slice(-3).map((s) => `${s.name}: ${s.trouble}`).join('; ')})`, setting, at: this.now() };
    // What ran under the old limit says nothing about the new one.
    this.samples = this.samples.map((s) => ({ ...s, trouble: null }));
    this.o.say?.(steppedNote(this.stepped));
  }

  /** Finished builds are kept for a while (their results are read after the fact), not for ever. */
  private trim(): void {
    const ended = this.entries.filter((e) => e.build.endedAt !== null);
    for (const old of ended.slice(0, Math.max(0, ended.length - 60))) this.entries.splice(this.entries.indexOf(old), 1);
  }
}

/** At most `max()` jobs at a time, the rest in order: Shuriken's own GPU work through Kiln (Roblox bakes, renders). */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: () => number) {}

  get busy(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= Math.max(1, this.max())) await new Promise<void>((ok) => this.waiting.push(ok));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
