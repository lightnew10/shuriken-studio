import { endStudio, hasOpen, holdsLoginLock, startedWith, studioProcesses, stuckAtLogin, type StudioProcess } from './studio-login-lock';
import { studioForbidden } from './studio-guard';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { placePath, type ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { ChatService } from '../director/chat-service';
import { CAPTURE_DEAD_ROUNDS, type RobloxStudioAdapter, type StudioReopening } from './studio-adapter';
import { clockTime, type PlaytestLease } from './playtest-lease';
import { closeStudioWindow, studioWindowState, UNATTENDED, type SavePlaceResult, type UserActivity } from './studio-window';

export interface StudioRecoveryDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  bus: EventBus;
  log: ScopedLogger;
  /** The project is being worked on right now (agents running): only then is a Studio that went away reopened. */
  working: () => boolean;
  /**
   * Studio is back with the place: check the place still has its world, and put back what it is behind by.
   * `recovered`: the place came back as Studio's own recovery copy (see `recover`); absent after a refresh, which
   * saved the place before it closed it. `moved`: the window turned into another place (a publish), which is not a
   * crash: nothing is rebuilt that is there. Resolves with what was done (PlaceCheck), when the caller says.
   */
  reopened: (ctx: ProjectContext, how?: { crashed: boolean; moved?: boolean; recovered: RecoveredCopy | null }) => Promise<unknown>;
  /**
   * Studio is gone: put Studio's newest recovery copy of the place in the place file's stead when it left one that
   * is newer than the last save (PlaceGuard.recoverCopy). Null: there is none, and the place opens as it was saved.
   */
  recover?: (ctx: ProjectContext, file: string) => RecoveredCopy | null;
  /** Why Studio closed, from its own log, in a few words ('' when it can't be told). */
  crashReason?: (file: string) => string;
  /** Tests: the running Studio processes, and whether one holds Roblox's login lock (studio-login-lock.ts). */
  procs?: () => Promise<StudioProcess[]>;
  holdsLock?: (p: StudioProcess) => boolean;
  /** Tests: what the place's Studio window looks like to Windows (never a real process list). */
  windowState?: (titleNeedle: string) => Promise<'open' | 'starting' | 'none' | 'unknown'>;
  /** Tests: opening the place (never a real Studio). Resolves with the instance's name. */
  open?: (file: string, match: string, timeoutMs: number) => Promise<{ name: string }>;
  /** Studio's line (for a refresh: nobody plays or captures while the place is saved and reopened). Absent: no refresh. */
  lease?: PlaytestLease;
  /** Saves the place inside the caller's turn (for a refresh). Absent: the place is never closed by Shuriken. */
  save?: () => Promise<SavePlaceResult>;
  /** Tests: what the user is doing (idle time, the app in front). */
  activity?: () => Promise<UserActivity | null>;
  /** Tests: closing the place's Studio window (never a real one). */
  close?: (placeFileName: string) => Promise<'closed' | 'killed' | 'nowindow' | 'error'>;
  /** Tests: ending a Studio process (never a real one). */
  endProc?: (pid: number) => boolean;
}

/**
 * A refresh (the place saved, closed and opened again to bring Studio's dead screen capture back): no more often
 * than every `cooldownMs`, waiting up to `turnMs` for its turn in Studio's line, giving the window `closeMs` to go
 * before its process is ended, and looking whether one is due every `everyMs`. An object so a test can shorten it.
 */
/** Studio's recovery copy of a place that took the place file's stead before a reopen. */
export interface RecoveredCopy {
  /** When Studio wrote the copy. */
  copyAt: number;
  /** When the place was last saved (the file that was there). */
  savedAt: number;
  /** Puts the saved file back (the copy did not open). */
  undo: () => void;
}

/** What the check after a reopen did (StudioRecoveryDeps.reopened), for the status line. */
export interface PlaceCheck {
  /** The world was missing and was rebuilt from the build scripts. */
  rebuilt: boolean;
  /** The code went into the place from the files (false: it could not; absent: not asked). */
  codePushed?: boolean;
}

export const STUDIO_REFRESH = { cooldownMs: 20 * 60_000, turnMs: 4 * 60_000, closeMs: 15_000, everyMs: 60_000 };

/**
 * The place's Studio holds Roblox's login lock and another Studio hangs behind it (studio-login-lock.ts): it is saved,
 * closed and opened again, at most once per `cooldownMs`. An object so a test can shorten it.
 */
export const LOCK_RESTART = { cooldownMs: 10 * 60_000 };

export type RefreshOutcome = 'reopened' | 'waiting' | 'skipped' | 'failed';

/**
 * How Studio is watched and reopened: looked at every `everyMs` while agents work; a reopen gets `tries` tries of
 * `openMs` each, `retryMs` apart; no more than `maxLaunches` launches within `windowMs` (a place that crashes
 * Studio on load must not be reopened forever). An object so a test can shorten it.
 */
/** How long after the place's plugin link dropped the place is not yet taken for gone. */
export const LINK_GRACE_MS = 15_000;
export const STUDIO_RECOVERY = { everyMs: 20_000, tries: 3, openMs: 180_000, retryMs: 5000, maxLaunches: 6, windowMs: 30 * 60_000 };

/**
 * Studio crashed in the middle of a build once: agents asked "may I relaunch it?", the director said yes, an agent
 * relaunched it. That is the app's job. While agents work, this looks whether the Studio window of the project's
 * place is still there; when its process is gone (not merely slow to connect: Windows is asked, see
 * studioWindowState) it opens the place file again, binds to it, has the place checked for its world, and says
 * what it did in the chat, in one status line. Tries are bounded. Agents' Studio calls made meanwhile wait
 * (RobloxStudioAdapter.reopening) instead of failing or asking.
 */
export class StudioRecovery {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<boolean> | null = null;
  /** Reopening was given up for this place (said in the chat); cleared when Studio shows up again. */
  private gaveUp: string | null = null;
  private launches: number[] = [];
  private refreshing: Promise<RefreshOutcome> | null = null;
  private lastRefresh = 0;
  private lastRefreshLook = 0;
  /** Said in the chat that the screen capture is dead and why the place was not reopened (once, until pictures are back). */
  private toldDead = false;
  /** A refresh for captures that only timed out brought no picture (the display is off?): not done again until one comes. */
  private refreshUseless = false;

  constructor(private readonly d: StudioRecoveryDeps) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.check().catch((e) => this.d.log.warn('Studio check failed', errorMessage(e)));
      // Dead captures whose refresh waits (for the user to leave, for a cooldown) are looked at again.
      if (this.capturesDead() && Date.now() - this.lastRefreshLook >= STUDIO_REFRESH.everyMs) void this.refresh().catch((e) => this.d.log.warn('Studio refresh failed', errorMessage(e)));
      // This place's Studio may be what keeps another Studio from starting.
      void this.letGoOfLoginLock().catch((e) => this.d.log.warn("Looking at Roblox's login lock failed", errorMessage(e)));
    }, STUDIO_RECOVERY.everyMs);
    this.timer.unref?.();
    // A Studio call that found no Studio asks for a look right now (and waits when a reopen starts).
    this.d.studio.onGone = () => this.check(true);
    this.d.studio.onCaptureDead = () => void this.refresh().catch((e) => this.d.log.warn('Studio refresh failed', errorMessage(e)));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.d.studio.onGone = null;
    this.d.studio.onCaptureDead = null;
  }

  private capturesDead(): boolean {
    return this.d.studio.capturesDeadSince != null || this.d.studio.captureFailRounds >= CAPTURE_DEAD_ROUNDS;
  }

  /**
   * Studio's screen capture is dead (RobloxStudioAdapter.onCaptureDead; measured: tests/e2e/capture-focus.e2e.ts):
   * no capture is answered until the place is closed and opened again, so that is done, the way a person would. The
   * place is saved first, and only when that worked is its window closed; never while someone is using the PC
   * (said once instead, and done when they have been away for a few minutes), never while nobody works on the
   * project, and not more often than STUDIO_REFRESH.cooldownMs. Agents' Studio calls wait meanwhile, as they do
   * for a Studio that crashed. One project of a two-build night had no picture for hours for want of this.
   */
  refresh(): Promise<RefreshOutcome> {
    if (this.refreshing) return this.refreshing;
    const run = this.renew().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }

  private async renew(): Promise<RefreshOutcome> {
    const ctx = this.d.project();
    const studio = this.d.studio;
    const lease = this.d.lease;
    const save = this.d.save;
    const file = ctx ? placePath(ctx) : null;
    const match = studio.binding;
    this.lastRefreshLook = Date.now();
    if (!this.capturesDead()) {
      this.toldDead = false;
      this.refreshUseless = false;
      return 'skipped';
    }
    if (!ctx || !file || !match || !lease || !save || !studio.connected || !existsSync(file)) return 'skipped';
    if (this.running || studio.reopening || !this.d.working()) return 'skipped';
    const since = studio.capturesDeadSince;
    // Captures that only time out may be a display that is off: reopening the place is tried once for those.
    if (since == null && this.refreshUseless) return 'skipped';
    if (Date.now() - this.lastRefresh < STUDIO_REFRESH.cooldownMs) return 'skipped';
    const name = basename(file);
    const chat = new ChatService(ctx, this.d.bus);
    const what = `Studio's screenshots stopped answering${since != null ? ` at ${clockTime(since)}` : ''} (a fault in Studio: a capture met a playtest that stopped under it, and none is answered after that until the place is closed and opened again)`;
    let note: { id: string } | null = null;
    const say = (text: string, kind: 'status' | 'error' = 'status') => {
      if (note) chat.update(note.id, { text, kind });
      else note = chat.add({ role: 'system', kind, text });
    };
    // Someone is using the PC (or it can't be told): their Studio is not closed under their hands.
    const act = await (this.d.activity ?? (() => studio.windows.idle.activity()))().catch(() => null);
    if (!act || act.idleMs < UNATTENDED.idleMs) {
      if (!this.toldDead) {
        this.toldDead = true;
        ctx.audit.event({ kind: 'studio.captures.dead', severity: 'warning', title: `${what}. Waiting until nobody uses the PC to reopen ${name}`.slice(0, 300) });
        say(`${what}. I'll save the place and reopen ${name} myself once nobody has used the PC for a few minutes, or you can save and reopen it in Studio now. The team works on without pictures meanwhile.`);
      }
      return 'waiting';
    }
    const now = Date.now();
    this.launches = this.launches.filter((t) => now - t < STUDIO_RECOVERY.windowMs);
    if (this.launches.length >= STUDIO_RECOVERY.maxLaunches) return 'skipped';
    // A turn in Studio's line, like a playtest: nobody plays or captures while the place is saved and reopened.
    if (!(await lease.acquire('refresh', STUDIO_REFRESH.turnMs))) return 'waiting';
    this.lastRefresh = Date.now();
    let finish: (ok: boolean) => void = () => undefined;
    const state: StudioReopening = { since: Date.now(), attempt: 1, tries: STUDIO_RECOVERY.tries, place: name, refresh: true, done: new Promise<boolean>((r) => (finish = r)) };
    let ok = false;
    let last = '';
    try {
      if (this.d.project() !== ctx || !this.capturesDead()) return 'skipped';
      studio.reopening = state;
      say(`${what}. Saving the place and reopening ${name} to bring them back; the agents' Studio work waits a moment…`);
      ctx.audit.event({ kind: 'studio.refresh', severity: 'warning', title: `Studio's screen capture is dead; saving the place and reopening ${name}` });
      const saved = await save().catch((e): SavePlaceResult => ({ ok: false, message: errorMessage(e) }));
      if (!saved.ok) {
        this.toldDead = true;
        ctx.audit.event({ kind: 'studio.refresh', severity: 'warning', title: `Not reopening ${name}: the place could not be saved first (${saved.message})`.slice(0, 300) });
        say(`${what}. Reopening ${name} would bring them back, but I couldn't save the place first (${saved.message}), so I left Studio as it is. Save and reopen it in Studio when you can; the team works on without pictures meanwhile, and I try again later.`);
        return 'failed';
      }
      const closed = await (this.d.close ?? ((f) => closeStudioWindow(f, STUDIO_REFRESH.closeMs)))(name);
      if (closed === 'error') {
        say(`${what}. I saved the place but couldn't close ${name} in Studio to reopen it. Close and reopen it in Studio when you can; the team works on without pictures meanwhile.`);
        return 'failed';
      }
      // Studio's list of instances lags a closed window by a moment: opening the place then would find "it is open".
      for (let i = 0; i < 40; i++) {
        const listed = await studio.listStudios().catch(() => null);
        if (!listed || !listed.some((x) => x.name.toLowerCase().includes(match.toLowerCase()))) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const opened = await this.open(ctx, file, match, state, (attempt) => say(`${what}. I saved the place; reopening ${name} (try ${attempt} of ${STUDIO_RECOVERY.tries}); the agents' Studio work waits and goes on when it is back…`));
      ok = opened.ok;
      last = opened.last;
      if (ok) studio.capturesBack();
    } finally {
      if (studio.reopening === state) studio.reopening = null;
      finish(ok);
      lease.release('refresh');
    }
    if (this.d.project() !== ctx) return ok ? 'reopened' : 'failed';
    if (!ok) {
      this.gaveUp = file;
      say(`I saved the place and closed ${name} to bring Studio's screenshots back, and couldn't reopen it (${last || 'it did not come back'}). Open ${name} in Studio with its MCP server enabled; the team's Studio work goes on once it connects.`, 'error');
      ctx.audit.event({ kind: 'studio.gone', severity: 'error', title: `Could not reopen Roblox Studio: ${last}`.slice(0, 300) });
      return 'failed';
    }
    await this.d.reopened(ctx).catch((e) => this.d.log.warn('Place check after reopening Studio failed', errorMessage(e)));
    // Does Studio answer a capture now?
    const picture = await studio.screenshot({ quick: true }).then(
      (shot) => !!shot,
      () => false,
    );
    if (!picture) {
      if (since == null) this.refreshUseless = true;
      this.toldDead = true;
      ctx.audit.event({ kind: 'studio.refresh', severity: 'warning', title: `Reopened ${name}, but Studio still returns no picture` });
      say(`Studio's screenshots stopped answering, so I saved the place and reopened ${name}, but Studio still returns no picture (is the display off, or Studio minimized?). The team works on without pictures.`);
      return 'reopened';
    }
    this.toldDead = false;
    ctx.audit.event({ kind: 'studio.refresh', severity: 'success', title: `Saved the place and reopened ${name}: Studio's screen capture answers again` });
    say(`${what}. I saved the place and reopened ${name}: screenshots work again, and the team carries on.`);
    return 'reopened';
  }

  private lockRestarting: Promise<RefreshOutcome> | null = null;
  private lastLockRestart = 0;

  /**
   * This place's Studio holds Roblox's login lock for good (it took it when it started and never let go: a Studio
   * fault, studio-login-lock.ts), and another Studio hangs at its login behind it: another project's, a play window,
   * one the user opened. The lock is let go only when this Studio's process ends, so the place is saved, its window
   * closed and the place opened again, the way a refresh does it (a turn in Studio's line, the agents' Studio calls
   * waiting meanwhile). Done while agents work, whoever is at the PC: the other Studio cannot start otherwise. Not
   * when the save fails (said in the chat instead).
   */
  letGoOfLoginLock(): Promise<RefreshOutcome> {
    if (this.lockRestarting) return this.lockRestarting;
    const run = this.restartForLock().finally(() => {
      this.lockRestarting = null;
    });
    this.lockRestarting = run;
    return run;
  }

  private async restartForLock(): Promise<RefreshOutcome> {
    const ctx = this.d.project();
    const studio = this.d.studio;
    const lease = this.d.lease;
    const save = this.d.save;
    const file = ctx ? placePath(ctx) : null;
    const match = studio.binding;
    if (!ctx || !file || !match || !lease || !save || !studio.connected || !existsSync(file)) return 'skipped';
    if (this.running || this.refreshing || studio.reopening || !this.d.working()) return 'skipped';
    if (Date.now() - this.lastLockRestart < LOCK_RESTART.cooldownMs) return 'skipped';
    const name = basename(file);
    const procs = await (this.d.procs ?? studioProcesses)().catch(() => [] as StudioProcess[]);
    const own = procs.find((p) => hasOpen(p, name));
    if (!own || !(this.d.holdsLock ?? ((p: StudioProcess) => holdsLoginLock(p)))(own)) return 'skipped';
    const waiting = procs.filter((p) => p.pid !== own.pid && stuckAtLogin(p));
    if (!waiting.length) return 'skipped';
    this.d.log.info(`This place's Studio holds Roblox's login lock and ${waiting.length} Studio${waiting.length === 1 ? '' : 's'} wait${waiting.length === 1 ? 's' : ''} behind it: saving and reopening ${name}`);
    this.lastLockRestart = Date.now();
    const chat = new ChatService(ctx, this.d.bus);
    const what = `Another Studio could not start: this project's Studio holds Roblox's login lock (a fault in Studio: it took the lock when it started and never let go, and every Studio started after it waits for it at login)`;
    let note: { id: string } | null = null;
    const say = (text: string, kind: 'status' | 'error' = 'status') => {
      if (note) chat.update(note.id, { text, kind });
      else note = chat.add({ role: 'system', kind, text });
    };
    if (!(await lease.acquire('refresh', STUDIO_REFRESH.turnMs))) {
      this.d.log.info(`Reopening ${name} for the login lock waits: Studio's line did not come free within ${Math.round(STUDIO_REFRESH.turnMs / 60_000)} min`);
      this.lastLockRestart = 0;
      return 'waiting';
    }
    let finish: (ok: boolean) => void = () => undefined;
    const state: StudioReopening = { since: Date.now(), attempt: 1, tries: STUDIO_RECOVERY.tries, place: name, refresh: true, done: new Promise<boolean>((r) => (finish = r)) };
    let ok = false;
    let last = '';
    try {
      if (this.d.project() !== ctx) return 'skipped';
      studio.reopening = state;
      say(`${what}. Saving the place and reopening ${name} so that it lets go; the agents' Studio work waits a moment…`);
      ctx.audit.event({ kind: 'studio.login.lock', severity: 'warning', title: `This project's Studio held Roblox's login lock and ${waiting.length} Studio${waiting.length === 1 ? '' : 's'} waited behind it; saving the place and reopening ${name}` });
      const saved = await save().catch((e): SavePlaceResult => ({ ok: false, message: errorMessage(e) }));
      if (!saved.ok) {
        say(`${what}. Reopening ${name} would free it, but I couldn't save the place first (${saved.message}), so I left Studio as it is. Save the place, close ${name} in Studio and open it again; I try again in ${Math.round(LOCK_RESTART.cooldownMs / 60_000)} minutes.`);
        return 'failed';
      }
      const closed = await (this.d.close ?? ((f) => closeStudioWindow(f, STUDIO_REFRESH.closeMs)))(name);
      if (closed === 'error') {
        say(`${what}. I saved the place but couldn't close ${name} in Studio. Close it and open it again in Studio; that frees the lock.`);
        return 'failed';
      }
      for (let i = 0; i < 40; i++) {
        const listed = await studio.listStudios().catch(() => null);
        if (!listed || !listed.some((x) => x.name.toLowerCase().includes(match.toLowerCase()))) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const opened = await this.open(ctx, file, match, state, (attempt) => say(`${what}. I saved the place; reopening ${name} (try ${attempt} of ${STUDIO_RECOVERY.tries}); the agents' Studio work waits and goes on when it is back…`));
      ok = opened.ok;
      last = opened.last;
    } finally {
      if (studio.reopening === state) studio.reopening = null;
      finish(ok);
      lease.release('refresh');
    }
    if (this.d.project() !== ctx) return ok ? 'reopened' : 'failed';
    if (!ok) {
      this.gaveUp = file;
      say(`I saved the place and closed ${name} to free Roblox's login lock, and couldn't reopen it (${last || 'it did not come back'}). Open ${name} in Studio with its MCP server enabled; the team's Studio work goes on once it connects.`, 'error');
      return 'failed';
    }
    await this.d.reopened(ctx).catch((e) => this.d.log.warn('Place check after reopening Studio failed', errorMessage(e)));
    ctx.audit.event({ kind: 'studio.login.lock', severity: 'success', title: `Reopened ${name}: Roblox's login lock is free again` });
    say(`${what}. I saved the place and reopened ${name}: the lock is free, the Studio that waited can start, and the team carries on.`);
    return 'reopened';
  }

  /** Opens the place file and binds to it: up to STUDIO_RECOVERY.tries tries, within the bound on launches. */
  private async open(ctx: ProjectContext, file: string, match: string, state: StudioReopening, trying: (attempt: number) => void): Promise<{ ok: boolean; last: string }> {
    const studio = this.d.studio;
    const name = basename(file);
    let last = '';
    for (let attempt = 1; attempt <= STUDIO_RECOVERY.tries; attempt++) {
      const now = Date.now();
      this.launches = this.launches.filter((t) => now - t < STUDIO_RECOVERY.windowMs);
      if (this.launches.length >= STUDIO_RECOVERY.maxLaunches) {
        last = `Studio was reopened ${this.launches.length} times in the last ${Math.round(STUDIO_RECOVERY.windowMs / 60_000)} minutes and keeps closing`;
        break;
      }
      this.launches.push(now);
      state.attempt = attempt;
      trying(attempt);
      try {
        const inst = await (this.d.open ?? ((f, m, t) => studio.openPlace(f, m, t, { background: true })))(file, name, STUDIO_RECOVERY.openMs);
        if (this.d.project() !== ctx) return { ok: false, last };
        const bound = inst.name.replace(/\s*\(placeId:.*$/, '');
        if (bound !== match) ctx.updateSettings({ robloxStudioMatch: bound });
        studio.bind(bound);
        return { ok: true, last };
      } catch (e) {
        last = errorMessage(e);
        this.d.log.warn(`Reopening Studio failed (try ${attempt} of ${STUDIO_RECOVERY.tries})`, last);
        if (this.d.project() !== ctx) return { ok: false, last };
        if (attempt < STUDIO_RECOVERY.tries) await new Promise((r) => setTimeout(r, STUDIO_RECOVERY.retryMs));
      }
    }
    return { ok: false, last };
  }

  /**
   * Looks whether the place's Studio is still there and reopens it when it is gone. Resolves true when Studio is
   * there (or back), false when it is gone and was not reopened (nobody working, no place file, tries used up).
   * `asked`: a Studio call or a verification found no Studio, so work is waiting for it whatever `working` says.
   */
  check(asked = false): Promise<boolean> {
    if (this.running) return this.running;
    const run = this.look(asked).finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async look(asked: boolean): Promise<boolean> {
    const ctx = this.d.project();
    const studio = this.d.studio;
    const file = ctx ? placePath(ctx) : null;
    const match = studio.binding;
    if (!ctx || !file || !match || !existsSync(file)) return true;
    // Shuriken closed it itself a moment ago and is opening it again (refresh): not a crash, and not opened twice.
    if (this.refreshing) return true;
    // Its plugin is linked: Studio has the place. Its link dropped a moment ago: Studio may be reloading the place (it
    // does after a publish, and comes back under the published name: link/studio-link.ts follows it).
    if (studio.link?.has('Edit') || studio.link?.lostWithin(LINK_GRACE_MS)) return true;
    // Roblox's MCP connection goes with the last Studio: when the project's Studio was the only one and crashed, there
    // is no list to ask, and the window alone tells (2026-10-03: a crash of the only Studio was not taken for one, and
    // the place was opened later from its last save, without Studio's newer recovery copy: 20 minutes of work lost).
    if (studio.connected) {
      const studios = await studio.listStudios().catch(() => null);
      if (!studios || this.d.project() !== ctx) return true;
      // Listed under the game's name once Studio knows the place is published ("Voxel Pit (placeId: N)"), and proven to
      // be the place file's own document (RobloxStudioAdapter.samePlaceById): there, not gone.
      if (studios.some((s) => s.name.toLowerCase().includes(match.toLowerCase())) || (await studio.samePlaceById?.(studios))) {
        this.gaveUp = null;
        return true;
      }
    }
    // Not connected through MCP. Is its process gone, or is it only starting, or open without its MCP server?
    const window = await (this.d.windowState ?? studioWindowState)(basename(file));
    if (window !== 'none') return window === 'open' || window === 'starting';
    if (this.gaveUp === file) return false;
    // Nobody works and nobody asked: a Studio the user closed stays closed. One whose window now shows another place
    // (the user published from it, or Shuriken was told so: afterMove) is the team's copy gone missing, and is reopened:
    // after a publish on 2026-10-06 the paused project had no window for an hour and every save failed.
    if (!asked && !this.d.working() && !this.moveSeen() && !(await this.movedTo(file))) return false;
    return this.reopen(ctx, file, match);
  }

  /** When the place's window was last seen turning into another place (afterMove), so a look soon after reopens it. */
  private movedAt = 0;
  /** What that window shows now (the published game's name), when it was said. */
  private movedName: string | null = null;
  private moveTimer: NodeJS.Timeout | null = null;
  private moveSeen(): boolean {
    return Date.now() - this.movedAt < 10 * 60_000;
  }

  /** The place's window turned into another place a moment ago and the local file is (about to be) opened again. */
  get moving(): boolean {
    return this.moveSeen();
  }

  /**
   * The window that had the project's local place now shows another one (published from it, saved under another name,
   * another place opened in it): the local file is opened again for the team once Studio has settled (the plugin's
   * link of the old place gets LINK_GRACE_MS first), whether or not agents are working. `to`: what it shows now.
   */
  afterMove(to?: string): void {
    this.movedAt = Date.now();
    this.movedName = to ?? null;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => void this.check(true).catch((e) => this.d.log.warn('Reopening the local place failed', errorMessage(e))), LINK_GRACE_MS + 5000);
    this.moveTimer.unref?.();
  }

  /**
   * A Studio of this place still running after its window went: a crash whose handler (or a hung teardown) kept the
   * process and all its memory alive. On 2026-10-05 a crashed Studio of a long build held about 10 GB until the user
   * ended it in Task Manager, while Shuriken had already opened the place again in a new Studio. Before the place is
   * opened again, every Studio process that was started with this place file, shows no place in its window and is
   * over a minute old is ended. A Studio showing a place (this one or another) is never touched.
   */
  private async endLeftovers(file: string): Promise<number> {
    if (!this.d.procs && studioForbidden()) return 0;
    const procs = await (this.d.procs ?? studioProcesses)().catch(() => [] as StudioProcess[]);
    const now = Date.now();
    // A window Windows shows as "(Not Responding)" is a Studio of this place that hung (a load that never finished:
    // Studio's MCP lists it as "(loading)"): it holds the place and its memory, and is ended too. One that shows another
    // place and answers is the user's (a published game) and is never touched.
    const left = procs.filter((p) => {
      if (!startedWith(p, file) || now - p.startedAt < 60_000) return false;
      const title = p.title.replace(/\s*\(Not Responding\)\s*$/i, '');
      if (!/ - Roblox Studio$/i.test(title)) return true;
      return !p.responding && hasOpen({ ...p, title }, basename(file));
    });
    let ended = 0;
    for (const p of left) {
      if (!(this.d.endProc ?? endStudio)(p.pid)) continue;
      ended++;
      this.d.log.warn(`Ended a Studio of ${basename(file)} still running without its window after it closed (pid ${p.pid}, running since ${new Date(p.startedAt).toISOString()}, ${p.responding ? 'responding' : 'not responding'})`);
    }
    return ended;
  }

  /** What the window that had this place shows now, when it is still open with another place in it (null: it is gone). */
  private async movedTo(file: string): Promise<string | null> {
    if (!this.d.procs && studioForbidden()) return null;
    const procs = await (this.d.procs ?? studioProcesses)().catch(() => [] as StudioProcess[]);
    const moved = procs.find((p) => startedWith(p, file) && / - Roblox Studio$/i.test(p.title) && !hasOpen(p, basename(file)));
    return moved ? moved.title.replace(/ - Roblox Studio$/i, '').trim() : null;
  }

  private async reopen(ctx: ProjectContext, file: string, match: string): Promise<boolean> {
    const studio = this.d.studio;
    const chat = new ChatService(ctx, this.d.bus);
    const name = basename(file);
    const since = Date.now();
    let note: { id: string } | null = null;
    const say = (text: string, kind: 'status' | 'error' = 'status') => {
      if (note) chat.update(note.id, { text, kind });
      else note = chat.add({ role: 'system', kind, text });
    };
    let why = '';
    try {
      why = this.d.crashReason?.(file) ?? '';
    } catch {
      /* its log can't be read: no reason given */
    }
    // Not a crash: the window that had the place now shows another one (Studio turns it into the published game when
    // the place is published from it, or another place was opened in it), or the core was told so (afterMove). The local
    // file is reopened all the same, so the team keeps working on it, and the chat says what happened instead of
    // "closed unexpectedly". Nothing in the place file was lost with it, so nothing that is there is rebuilt (see
    // StudioRecoveryDeps.reopened): on 2026-10-07 a publish was handled as a crash and the world was rebuilt from 35
    // build scripts for 13 minutes, with the team held, over a place that was whole.
    const movedTo = (await this.movedTo(file)) ?? (this.moveSeen() ? this.movedName : null);
    const moved = !!movedTo || this.moveSeen();
    // Whatever played in the Studio that went is gone with it: its turn in Studio's line ends now (a start that hung on
    // the old Studio kept every agent out of Studio for 90 minutes on 2026-10-06), and its agent is told at its next call.
    const lost = this.d.lease?.forfeit('crash') ?? null;
    this.d.studio.resetPlayLine?.();
    if (lost) this.d.log.warn(`Studio went while ${lost} held it; its turn ended so the others can use the reopened Studio`);
    const shows = movedTo ? `"${movedTo}"` : 'another place';
    if (moved) ctx.audit.event({ kind: 'studio.place.left', severity: 'info', title: `Studio's window of ${name} now shows ${shows}; reopening ${name} so the team keeps working on the local copy`.slice(0, 300) });
    else ctx.audit.event({ kind: 'studio.gone', severity: 'warning', title: `Roblox Studio closed while the team was working${why ? ` (${why})` : ''}; reopening ${name}`.slice(0, 300) });
    if (why && !moved) this.d.log.warn(`Studio closed: ${why}`);
    const ended = await this.endLeftovers(file);
    if (ended) ctx.audit.event({ kind: 'studio.leftover', severity: 'warning', title: `Ended ${ended} Studio process${ended === 1 ? '' : 'es'} of ${name} still running without a window after it closed (holding memory)` });
    let last = '';
    let savedAt = 0;
    try {
      savedAt = statSync(file).mtimeMs;
    } catch {
      /* said without the time */
    }
    // Studio's own recovery copy of the place, when it left one newer than the last save in the place file's own format
    // (PlaceGuard.recoverCopy): the place comes back minutes old instead of as old as its last save (three hours, in the
    // build this was written after).
    let recovered: RecoveredCopy | null = null;
    try {
      recovered = this.d.recover?.(ctx, file) ?? null;
    } catch (e) {
      this.d.log.warn("Studio's recovery copy could not be used", errorMessage(e));
    }
    const from = recovered ? ` from Studio's recovery copy of ${clockTime(recovered.copyAt)} (its last save was at ${clockTime(recovered.savedAt)})` : '';
    if (recovered) ctx.audit.event({ kind: 'place.recovered', severity: 'info', title: `Reopening ${name}${from}` });
    // What calls that arrive from now on wait for (see RobloxStudioAdapter.call).
    const state: StudioReopening = { since, attempt: 1, tries: STUDIO_RECOVERY.tries, place: name, done: Promise.resolve(false) };
    const lead = moved ? `Studio's window of ${name} now shows ${shows} (you published the place from it, or opened another place in it)` : `Roblox Studio closed unexpectedly at ${clockTime(since)}`;
    const trying = (attempt: number) => say(`${lead}. Reopening ${name}${from} (try ${attempt} of ${STUDIO_RECOVERY.tries}); the agents' Studio work waits and goes on when it is back…`);
    const work = this.open(ctx, file, match, state, trying).then(async (r) => {
      last = r.last;
      if (r.ok || !recovered || this.d.project() !== ctx) return r.ok;
      // The recovery copy did not open: the place as it was saved, then.
      this.d.log.warn("Studio's recovery copy did not open; opening the place as it was last saved", r.last);
      recovered.undo();
      recovered = null;
      const again = await this.open(ctx, file, match, state, (attempt) => say(`${lead}. Its recovery copy did not open; reopening ${name} as it was last saved (try ${attempt} of ${STUDIO_RECOVERY.tries})…`));
      last = again.last;
      return again.ok;
    });
    state.done = work;
    studio.reopening = state;
    let ok = false;
    try {
      ok = await work;
      // A Studio that opened again has its screen capture back, whatever it was before.
      if (ok) studio.capturesBack();
    } finally {
      studio.reopening = null;
      // The move is handled: a Studio that goes later is a crash again.
      if (moved) {
        this.movedAt = 0;
        this.movedName = null;
      }
    }
    if (this.d.project() !== ctx) return ok;
    if (!ok) {
      this.gaveUp = file;
      say(`${moved ? `${lead}, and I couldn't reopen ${name}` : "Roblox Studio closed and I couldn't reopen it"} (${last || 'it did not come back'}). Open ${name} in Studio with its MCP server enabled; the team's Studio work goes on once it connects.`, 'error');
      ctx.audit.event({ kind: 'studio.gone', severity: 'error', title: `Could not reopen Roblox Studio: ${last}`.slice(0, 300) });
      return false;
    }
    this.gaveUp = null;
    ctx.audit.event({ kind: 'studio.reopened', severity: 'success', title: moved ? `Reopened ${name} in Roblox Studio after its window turned into ${shows}` : `Reopened ${name} in Roblox Studio after it closed` });
    const back: RecoveredCopy | null = recovered;
    if (moved) {
      const asOf = back ? `from Studio's recovery copy of ${clockTime(back.copyAt)}` : `as it was last saved${savedAt ? ` (${clockTime(savedAt)})` : ''}`;
      const theirs = movedTo ? `the "${movedTo}" window is no longer the team's` : 'the window it was in is no longer the team\'s';
      say(`${lead}. That is not a crash: I reopened ${name} ${asOf} and I'm checking its world and code before the agents go on.`);
      const check = await this.d.reopened(ctx, { crashed: false, moved: true, recovered: back }).catch((e: unknown) => {
        this.d.log.warn('Place check after reopening Studio failed', errorMessage(e));
        return null;
      });
      const c = check && typeof check === 'object' ? (check as PlaceCheck) : null;
      const code = c?.codePushed === false ? "; the code could not be put back from the files just now, and goes in with the next sync" : c?.codePushed ? ' and put the code back from the files' : '';
      const done = c?.rebuilt ? `but the place opened without its world: I reopened ${name} ${asOf}, rebuilt its world from the build scripts${code}` : `so nothing was rebuilt: I reopened ${name} ${asOf}${code}`;
      say(`${lead}. That is not a crash, ${done}. The team carries on on your local copy; ${theirs}, so close it when you're done with it.`);
      return true;
    }
    const asOf = back ? `Studio's recovery copy of ${clockTime(back.copyAt)}` : 'it was last saved';
    say(`${lead}${why ? ` (${why})` : ''}; I reopened ${name} and reconnected. The place is as ${asOf}: I'm checking that its world and code are there before the agents go on.`);
    await this.d.reopened(ctx, { crashed: true, recovered: back }).catch((e) => this.d.log.warn('Place check after reopening Studio failed', errorMessage(e)));
    say(`${lead}${why ? ` (${why})` : ''}; I reopened ${name}${back ? ` from ${asOf}` : ''}, reconnected and checked the place. The team carries on.`);
    return true;
  }
}
