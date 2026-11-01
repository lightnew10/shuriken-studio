import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LeaseMarker {
  owner: string;
  since: number;
  pid: number;
  /** The Studio window (binding) the playtest runs in, when known. */
  studio?: string | null;
}

/**
 * How long Studio may be held. Everyone else's Edit-mode work waits behind a playtest, so one is not kept:
 * - an agent's playtest plays `playMs` (60 s) once it is up: the time Studio takes to load it into play is not
 *   counted, but a start still not up `loadMs` after it took Studio gives Studio back (a heavy place loads in up to
 *   PLAY_START.maxMs). There is no extension, and one call that is a whole check (roblox_playtest "run") gets the
 *   same 60 s. 1.15.7: a start whose Studio hung kept every agent out of Studio for 90 minutes;
 * - an agent's playtest with no Studio call of its own for `idleMs` gives way sooner while someone waits;
 * - the world's rebuild ("healer") and a reopening of the place ("refresh") keep Studio until they are done, up to
 *   `healMs`: on 2026-10-07 a rebuild from 35 build scripts took 13 minutes, was cut at 3, and agents played a
 *   half-built map for ten minutes;
 * - anyone else who holds Studio (the user's playtest from the app, a save) has `maxHoldMs`, and Shuriken's own checks
 *   (owners "verifier:…") never more than `ceilingMs`.
 * Waiters look at the lease at least every `pollMs`. An object so a test can shorten it.
 */
export const PLAYTEST_LIMITS = { playMs: 60 * 1000, loadMs: 5 * 60 * 1000, maxHoldMs: 3 * 60 * 1000, ceilingMs: 15 * 60 * 1000, healMs: 30 * 60 * 1000, idleMs: 30 * 1000, pollMs: 1000, lineMs: 25 };

/** Owners that put the place back (a rebuild, a reopening): they keep Studio until done, up to PLAYTEST_LIMITS.healMs. */
const REBUILDS = /^(healer|refresh)$/;

/** Owners that hold Studio without playing an agent's game: the play cap is not theirs (see PLAYTEST_LIMITS). */
const NOT_CAPPED = /^(saver|healer|refresh|cut:\d+|shot:|ui:|verifier:)/;
/** Whether `owner`'s playtest plays at most PLAYTEST_LIMITS.playMs once it is up (an agent's, a copilot's, a critic's). */
export const playCapped = (owner: string): boolean => !NOT_CAPPED.test(owner);

/**
 * The order of the line for Studio (since 1.13.8). Shortest first: of those waiting, the one that will hold Studio
 * the least goes next (its estimate, `want`), so a 10-second playtest no longer waits behind a four-minute check run;
 * one that has waited `agingMs` goes before anything shorter that came later, so nothing waits forever. Without an
 * estimate a turn counts as `unknownMs`. An object so a test can change it.
 *
 * Why: with play windows dropped, Studio plays one game at a time. In the two 14-hour builds playtest calls averaged
 * 108 to 113 s and check runs 175 to 268 s, nearly all of it standing in line, short ones behind long ones.
 */
export const LINE_ORDER = { agingMs: 3 * 60_000, checkAgingMs: 60_000, unknownMs: 60_000 };
/*
 * checkAgingMs: a check run (a worker's task_run_checks, a verification: owners "verifier:…") ages after one minute.
 * Its estimate is the sum of its checks, so shortest-first put it behind every playtest, and it is what finishes a task:
 * in the first hour of the 1.14 RTS build check runs took a median 134 s (slowest tenth 455 s) against 18 to 80 s in
 * the builds before, while single playtests were no faster for it.
 */

/** What a caller waiting for Studio said about itself: how many waits, since when, and how long it will hold Studio. */
interface Wanting {
  n: number;
  since: number;
  estimateMs: number | null;
}
/*
 * `idleMs` is counted from the END of the holder's last Studio call, and never while one of its calls is still
 * running. In the first 1.13 builds it was 20 s from the call's start: a capture that took 25-40 s, or a model that
 * needed 26 s to write its next call, lost a playtest it had waited minutes in line for (ten times in one build,
 * mostly the UI designer's click-look-decide sessions), and had to stand in line again.
 */

/** Why a playtest was stopped for others: past its time, idle while they waited, Studio crashed under it, or freed by hand. */
export type LeaseExpiry = 'long' | 'idle' | 'crash' | 'freed';

/** "40 s", "3 min 20 s", "1 h 5 min": how long, for a message. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 >= 10 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Local clock time ("14:32:05") of a timestamp. */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Who a lease owner id is, for a caller who is not it. */
export function ownerLabel(owner: string): string {
  if (owner.startsWith('verifier:')) return "Shuriken's verification";
  if (owner === 'saver') return "the place's auto-save";
  if (owner === 'healer') return "the world's rebuild";
  if (owner === 'refresh') return "Shuriken, which is reopening the place to bring Studio's screen capture back";
  if (owner.startsWith('cut:')) return 'Shuriken, which is saving the place to open a play window from it';
  if (owner.startsWith('ui:')) return 'the user (from the app)';
  if (owner.startsWith('shot:')) return "another agent's screenshot";
  if (owner.startsWith('run_')) return `another agent (${owner})`;
  return owner;
}

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Studio has one play mode per window. Parallel agents (and the verifier) must not start, stop or
 * piggyback on each other's playtests, so play mode is leased to one owner at a time.
 *
 * With a marker directory, the current holder is also written to disk (one file per process, since
 * every app window runs its own core), so a core that starts after a crash can tell that a playtest
 * may have been left running (takeOrphan) and stop it. Markers of live processes are never touched.
 */
export class PlaytestLease {
  private owner: string | null = null;
  private since = 0;
  /** The holder's last Studio call (see touch): an agent that sits on play mode can be asked to give it up. */
  private lastActive = 0;
  private waitingNow = 0;
  private readonly waiters: Array<() => void> = [];
  /** Agent runs whose playtest was stopped for others (runId → when), so their next call can say so. */
  readonly reclaimed = new Map<string, number>();
  /** Why those playtests were stopped (runId → 'long' or 'idle'). */
  readonly reclaimReasons = new Map<string, LeaseExpiry>();
  /** When the holder's playtest was up (Studio in play with its client): its PLAYTEST_LIMITS.playMs count from here. */
  private playUpAt = 0;
  /** A hold that is not an agent's playtest isn't cut before this, up to PLAYTEST_LIMITS.ceilingMs (a save, a rebuild). */
  private shieldedUntil = 0;
  /** Owners whose turn is not an agent's playtest: Shuriken's own checks keep Studio as long as they take (up to the ceiling). */
  exempt: (owner: string) => boolean = (owner) => owner.startsWith('verifier:');
  /** Set by the Studio adapter: stops a playtest that is past its limits so waiting callers can go on (see RobloxStudioAdapter.enforceLease). */
  enforcer: ((opts: { waiting: boolean }) => Promise<unknown>) | null = null;
  /** The Studio binding of this core's project, recorded in the marker. */
  studio: string | null = null;
  /** Edit-mode work under way that Studio must not be taken in the middle of (see beginEdit). */
  private editWork = 0;
  /** Owners waiting to take Studio: new Edit-mode work holds off for them. */
  private readonly wanted = new Map<string, Wanting>();
  /** An owner that handed Studio to waiting screenshots in the middle of its turn and takes it back next (see yieldToShots). */
  private resuming: string | null = null;

  constructor(private readonly markerDir: string | null = null) {}

  private get markerPath(): string | null {
    return this.markerDir ? join(this.markerDir, `${process.pid}.lease`) : null;
  }

  get holder(): { owner: string; since: number } | null {
    return this.owner ? { owner: this.owner, since: this.since } : null;
  }

  tryAcquire(owner: string): boolean {
    if (this.owner && this.owner !== owner) return false;
    // A code sync under way finishes first (seconds): Studio is never taken, or put into play mode, in the middle of one.
    if (!this.owner && this.editWork > 0) return false;
    // First come, first served. Whoever was free to grab play mode the moment it was released got it: in a
    // 12-agent build a critic's check waited three minutes while four later ones went ahead, and waits reached
    // 336 s for playtests of 25. The line is the order in which owners said they want Studio (`want`).
    // A screenshot's turn ("shot:…") goes ahead of the playtests that wait: it takes a second or two, and behind
    // five queued playtests it stood 159 to 209 s in the first builds on 1.13.1. It still waits for the playtest
    // that is running, and it still holds Studio out of play mode while it draws.
    if (!this.owner && !owner.startsWith('shot:')) {
      // A check run that lent Studio to screenshots takes it back before anyone else.
      if (this.resuming && this.resuming !== owner) return false;
      const line = [...this.wanted.keys()];
      // A screenshot that waits draws first (whichever of the two happens to ask at the moment Studio is free).
      if (line.some((o) => o.startsWith('shot:'))) return false;
      const head = this.next();
      if (head !== null && head !== owner) return false;
    }
    const fresh = this.owner !== owner;
    this.owner = owner;
    // Asking again for play mode one already holds doesn't start its time box over.
    if (fresh) {
      this.since = Date.now();
      this.playUpAt = 0;
      this.shieldedUntil = 0;
      this.inFlight = 0;
    }
    this.lastActive = Date.now();
    if (fresh) this.writeMarker();
    return true;
  }

  /**
   * When the holder's time runs out (null when nobody holds Studio). An agent's playtest: `playMs` after it was up, or
   * `loadMs` after it took Studio while it is still loading. Shuriken's own checks: the ceiling. A rebuild or a reopening
   * of the place: `healMs` (a stuck one still ends). Anyone else: `maxHoldMs`, or as long as a shield asks, never past
   * the ceiling.
   */
  expiresAt(_someoneWaits = this.waitingNow > 0): number | null {
    if (!this.owner) return null;
    // A world half rebuilt is worse than a wait: agents' checks and playtests failed on what wasn't there yet.
    if (REBUILDS.test(this.owner)) return this.since + PLAYTEST_LIMITS.healMs;
    const ceiling = this.since + PLAYTEST_LIMITS.ceilingMs;
    if (this.exempt(this.owner)) return ceiling;
    if (playCapped(this.owner)) return this.playUpAt ? this.playUpAt + PLAYTEST_LIMITS.playMs : this.since + PLAYTEST_LIMITS.loadMs;
    return Math.min(ceiling, Math.max(this.since + PLAYTEST_LIMITS.maxHoldMs, this.shieldedUntil));
  }

  /** The holder's playtest is up (Studio is in play with its client): its play time counts from now. */
  markPlaying(owner: string, now = Date.now()): void {
    if (this.owner === owner) this.playUpAt = now;
  }

  /** When the holder's playtest was up (0: not yet, or nobody plays). */
  get playingSince(): number {
    return this.owner ? this.playUpAt : 0;
  }

  /** Whether the holder's playtest is past its limits: held too long, or (an agent's, while someone waits) gone quiet. */
  overdue(now = Date.now(), someoneWaits = this.waitingNow > 0): LeaseExpiry | null {
    const end = this.expiresAt(someoneWaits);
    if (end === null || !this.owner) return null;
    if (now >= end) return 'long';
    if (someoneWaits && this.owner.startsWith('run_') && this.playUpAt > 0 && this.inFlight === 0 && now - this.lastActive >= PLAYTEST_LIMITS.idleMs) return 'idle';
    return null;
  }

  /** Playtests are not extended (since 1.15.7): an agent's plays 60 s once it is up, and is played again when it needs more. */
  extend(owner: string, _reason: string): { ok: boolean; message: string } {
    if (this.owner !== owner) return { ok: false, message: 'Play mode is not yours (you have no playtest running), so there is nothing to extend.' };
    if (!playCapped(owner)) return { ok: true, message: 'This turn has no play cap.' };
    const end = this.expiresAt();
    return { ok: false, message: `Playtests are not extended: one plays ${fmtDuration(PLAYTEST_LIMITS.playMs)} once it is up (loading is not counted)${end ? `, and this one is stopped at ${clockTime(end)}` : ''}. Finish what you need in that time, or stop and play again with the rest in one roblox_playtest "run".` };
  }

  /** A hold that is not an agent's playtest isn't cut for `ms` (never past the ceiling; agents' playtests ignore it). */
  shield(owner: string, ms: number): void {
    if (this.owner === owner) this.shieldedUntil = Math.max(this.shieldedUntil, Date.now() + ms);
  }

  /**
   * Takes Studio from whoever holds it, whatever its state: Studio crashed under the playtest, or the user (or the
   * director for them) freed it. An agent's run is told why at its next call. A play start in progress no longer keeps
   * Edit work out. Returns the owner it was taken from (null when nobody held it).
   */
  forfeit(reason: LeaseExpiry): string | null {
    const owner = this.owner;
    this.starting = 0;
    if (!owner) {
      for (const w of this.waiters.splice(0)) w();
      return null;
    }
    if (owner.startsWith('run_')) {
      this.reclaimed.set(owner, Date.now());
      this.reclaimReasons.set(owner, reason);
    }
    this.release(owner);
    return owner;
  }

  /** The holder is still using play mode (a Studio call of its own). */
  touch(owner: string | null): void {
    if (owner && this.owner === owner) this.lastActive = Date.now();
  }

  /** The holder's Studio calls that are running right now: while there is one it isn't idle. */
  private inFlight = 0;

  /** A Studio call of the holder's begins; call the returned function when it has ended (the idle time counts from then). */
  busy(owner: string | null): () => void {
    if (!owner || this.owner !== owner) return () => undefined;
    const since = this.since;
    this.inFlight++;
    this.lastActive = Date.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      // Play mode may have changed hands while the call ran: the count belongs to the playtest it began in.
      if (this.owner !== owner || this.since !== since) return;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastActive = Date.now();
    };
  }

  /** Who holds play mode, since when and how long it has been quiet, in words for a caller that has to wait (null when free). */
  describe(now = Date.now()): string | null {
    if (!this.owner) return null;
    const end = this.expiresAt();
    // A save, a rebuild, a screenshot's turn and a reopening of the place hold Studio without playing.
    const playing = !/^(saver|healer|refresh|cut:\d+)$/.test(this.owner) && !this.owner.startsWith('shot:');
    const loading = playing && playCapped(this.owner) && !this.playUpAt ? ', its playtest still loading' : '';
    return `${ownerLabel(this.owner)}, ${playing ? 'in a playtest' : 'holding Studio'} since ${clockTime(this.since)} (${fmtDuration(now - this.since)} ago${loading}; its last Studio call ${fmtDuration(now - this.lastActive)} ago${end ? `; stopped at ${clockTime(end)} at the latest` : ''})`;
  }

  /** How long the holder has gone without a Studio call (0 when nobody holds play mode). */
  idleMs(now = Date.now()): number {
    return this.owner ? now - this.lastActive : 0;
  }

  /** Callers waiting right now for play mode to end or to be theirs. */
  get waiting(): number {
    return this.waitingNow;
  }

  private async pause(): Promise<void> {
    this.waitingNow++;
    try {
      // A playtest past its limits is stopped now, not when a watchdog next looks.
      if (this.owner && this.enforcer) await this.enforcer({ waiting: true }).catch(() => undefined);
      // Studio is free, and still not this caller's: someone ahead of it in the line takes it first (tryAcquire is
      // first come, first served). It must WAIT for that, on a timer. In 1.13.1 it came straight back here: a
      // verification behind three playtests asked again and again without ever yielding to a timer, which froze the
      // whole engine of that project (one core at 100%, no playtest, no sync, no log line) until its ten minutes ran
      // out, and then again for the next one.
      if (!this.owner && this.editWork === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, PLAYTEST_LIMITS.lineMs));
        return;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, PLAYTEST_LIMITS.pollMs);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    } finally {
      this.waitingNow--;
    }
  }

  /** Wait until the lease is free (or already ours), up to `timeoutMs` (false on timeout or abort). */
  async acquire(owner: string, timeoutMs = 5 * 60 * 1000, signal?: AbortSignal, estimateMs?: number | null): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    this.want(owner, estimateMs);
    try {
      while (!this.tryAcquire(owner)) {
        if (Date.now() > deadline || signal?.aborted) return false;
        await this.pause();
      }
      return true;
    } finally {
      this.unwant(owner);
    }
  }

  /** Whether `owner` is the next playtest in the line (screenshots' turns aside). */
  isNext(owner: string): boolean {
    const head = this.next();
    return head === null || head === owner;
  }

  /**
   * Whose turn it is of those waiting (screenshots aside, they go first anyway): one that has waited its aging
   * (LINE_ORDER), a check run before a playtest and then the longest-waiting; otherwise the shortest turn, and of equal
   * ones the one that came first. Checks first among the aged: in a 20-agent build every playtest in line had aged, a
   * check run that aged after them stood behind all of them, and as check runs go one at a time, three of them took
   * 23 to 30 minutes each (2026-10-03). A check is what finishes a task and frees its agent.
   */
  next(now = Date.now()): string | null {
    let best: { owner: string; w: Wanting } | null = null;
    let aged: { owner: string; w: Wanting } | null = null;
    for (const [owner, w] of this.wanted) {
      if (owner.startsWith('shot:')) continue;
      const check = owner.startsWith('verifier:');
      if (now - w.since >= (check ? LINE_ORDER.checkAgingMs : LINE_ORDER.agingMs)) {
        const agedCheck = !!aged && aged.owner.startsWith('verifier:');
        if (!aged || (check && !agedCheck) || (check === agedCheck && w.since < aged.w.since)) aged = { owner, w };
        continue;
      }
      const est = w.estimateMs ?? LINE_ORDER.unknownMs;
      const bestEst = best ? (best.w.estimateMs ?? LINE_ORDER.unknownMs) : Infinity;
      if (!best || est < bestEst || (est === bestEst && w.since < best.w.since)) best = { owner, w };
    }
    return (aged ?? best)?.owner ?? null;
  }

  /**
   * `owner` is waiting to take Studio: Edit-mode work that hasn't begun holds off (beginEdit) until it has had its turn.
   * `estimateMs`: how long it will hold Studio (the line goes shortest first: LINE_ORDER).
   */
  want(owner: string, estimateMs?: number | null): void {
    const w = this.wanted.get(owner);
    if (w) {
      w.n++;
      if (estimateMs != null) w.estimateMs = estimateMs;
    } else this.wanted.set(owner, { n: 1, since: Date.now(), estimateMs: estimateMs ?? null });
  }

  unwant(owner: string): void {
    const w = this.wanted.get(owner);
    if (!w) return;
    if (w.n > 1) w.n--;
    else this.wanted.delete(owner);
  }

  /** Whether a screenshot is waiting for Studio. */
  get shotWaiting(): boolean {
    for (const o of this.wanted.keys()) if (o.startsWith('shot:')) return true;
    return false;
  }

  /**
   * A long turn (a check run, several playtests one after the other) lets the screenshots that wait in: between two of
   * its playtests it hands Studio over, they each draw (a second or two), and it takes Studio back before any other
   * playtest (`resuming`). In the two long builds an environment artist's screenshot averaged 90 s for a picture that
   * takes one: it waited behind check runs that held Studio for two to five minutes. At most `maxMs`; true when the
   * turn is `owner`'s again.
   */
  async yieldToShots(owner: string, maxMs = 60_000): Promise<boolean> {
    if (this.owner !== owner || !this.shotWaiting) return this.owner === owner;
    this.resuming = owner;
    const deadline = Date.now() + maxMs;
    try {
      this.release(owner);
      for (;;) {
        if (!this.owner && this.editWork === 0 && !this.shotWaiting) break;
        if (Date.now() > deadline && !this.owner && this.editWork === 0) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, PLAYTEST_LIMITS.lineMs * 4);
          this.waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      this.resuming = null;
      return this.tryAcquire(owner) || this.forceTake(owner);
    } finally {
      this.resuming = null;
    }
  }

  /** Takes a free Studio back for an owner that held it a moment ago, whatever the line says. */
  private forceTake(owner: string): boolean {
    if (this.owner || this.editWork > 0) return false;
    this.owner = owner;
    this.since = Date.now();
    this.playUpAt = 0;
    this.shieldedUntil = 0;
    this.inFlight = 0;
    this.lastActive = Date.now();
    this.writeMarker();
    return true;
  }

  /**
   * Edit-mode work that takes several Studio calls and must not be cut in two by a playtest (a code sync) begins:
   * false while someone else holds Studio or is waiting to take it. Until endEdit nobody is given Studio, so the
   * work never has to wait for the lease once it has begun, and whoever holds the lease never waits behind work
   * that is itself waiting for the lease. The holder's own work always begins.
   */
  beginEdit(owner: string | null): boolean {
    // A playtest is being started: Studio is copying the place for it, and must not copy it half-written.
    if (this.starting > 0) return false;
    if (this.owner) {
      // Someone else plays: with the Studio plugin the Edit DataModel can still be written (editInPlay).
      if (this.owner !== owner && !this.editInPlay?.()) return false;
    } else if (this.resuming && this.resuming !== owner) return false;
    else if ([...this.wanted.keys()].some((o) => o !== owner)) return false;
    this.editWork++;
    return true;
  }

  /**
   * Set by the Studio adapter: true while Edit-mode work can go on during a playtest (Shuriken Link's Edit
   * instance is linked). Measured in Studio 0.741 (tests/e2e/link-edit-in-play.e2e.ts): during a playtest the
   * plugin's Edit instance runs Luau in 17 ms a call; a script's source, a new script, a new part and a property
   * changed there stay out of the running game (which is the copy made when play started), are still there when
   * play stops, and the next playtest has them. Studio's own MCP server refuses the same work ("Edit datamodel is
   * not available in Play mode"), which is why every agent's Edit work used to wait behind every playtest.
   */
  editInPlay: (() => boolean) | null = null;
  /** Playtests being started right now (Studio is copying the place): no Edit work begins until they are up. */
  private starting = 0;

  /**
   * A playtest is about to start: no new Edit work begins (beginEdit), and work under way finishes first, so the
   * copy Studio makes for the playtest is never half of a code sync. Call endPlayStart when the start is over.
   */
  async beginPlayStart(maxMs = 60_000): Promise<void> {
    this.starting++;
    const t0 = Date.now();
    while (this.editWork > 0 && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 25));
  }

  endPlayStart(): void {
    this.starting = Math.max(0, this.starting - 1);
    if (this.starting === 0) for (const w of this.waiters.splice(0)) w();
  }

  endEdit(): void {
    this.editWork = Math.max(0, this.editWork - 1);
    if (this.editWork === 0) for (const w of this.waiters.splice(0)) w();
  }

  /** Whether Edit-mode work begun with beginEdit is under way. */
  get editing(): boolean {
    return this.editWork > 0;
  }

  /** Resolves true once nobody but `except` holds play mode (without taking it), false on timeout/abort. */
  async waitFree(except: string | null, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.owner && this.owner !== except) {
      if (Date.now() > deadline || signal?.aborted) return false;
      await this.pause();
    }
    return true;
  }

  release(owner: string): boolean {
    if (this.owner !== owner) return false;
    this.owner = null;
    this.playUpAt = 0;
    this.shieldedUntil = 0;
    this.clearMarker();
    for (const w of this.waiters.splice(0)) w();
    return true;
  }

  /** A marker a dead process left behind while holding play mode, if any (removed on read). */
  takeOrphan(): LeaseMarker | null {
    if (!this.markerDir || !existsSync(this.markerDir)) return null;
    for (const name of readdirSync(this.markerDir)) {
      const m = /^(\d+)\.lease$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid || alive(pid)) continue;
      const file = join(this.markerDir, name);
      let marker: LeaseMarker;
      try {
        marker = JSON.parse(readFileSync(file, 'utf8')) as LeaseMarker;
      } catch {
        /* unreadable marker: treat as orphaned without details */
        marker = { owner: 'unknown', since: 0, pid };
      }
      try {
        unlinkSync(file);
      } catch {
        /* raced with another core */
        continue;
      }
      return marker;
    }
    return null;
  }

  private writeMarker(): void {
    if (!this.markerDir || !this.markerPath || !this.owner) return;
    try {
      mkdirSync(this.markerDir, { recursive: true });
      writeFileSync(this.markerPath, JSON.stringify({ owner: this.owner, since: this.since, pid: process.pid, studio: this.studio } satisfies LeaseMarker), 'utf8');
    } catch {
      /* best effort */
    }
  }

  private clearMarker(): void {
    if (!this.markerPath) return;
    try {
      if (existsSync(this.markerPath)) unlinkSync(this.markerPath);
    } catch {
      /* best effort */
    }
  }

  isOwnedBy(owner: string): boolean {
    return this.owner === owner;
  }
}
