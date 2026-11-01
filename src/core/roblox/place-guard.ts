import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { placePath, type ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { ChatService } from '../director/chat-service';
import type { RobloxStudioAdapter } from './studio-adapter';
import type { PlaytestLease } from './playtest-lease';
import { UNATTENDED, readUserActivity, saveStudioPlace, type SavePlaceResult, type UserActivity } from './studio-window';
import { listWorldBuilders, rebuildWorld } from './world-builder';
import { clockTime } from './playtest-lease';
import { StudioRecovery, type PlaceCheck, type RecoveredCopy } from './studio-recovery';

export interface PlaceGuardDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  bus: EventBus;
  log: ScopedLogger;
  /** Auto-save wanted (app preference and the project's own setting). */
  autoSave: () => boolean;
  /** Push the project's code into Studio (after a rebuild). */
  pushCode: (ctx: ProjectContext) => Promise<unknown>;
  /** Hold the team (no new runs) while a world is restored. */
  hold: (until: Promise<unknown>, reason: string) => void;
  /** Studio's auto-recovery folder (tests point it elsewhere). */
  autoSavesDir?: string;
  /** Studio's log folder (tests point it elsewhere). */
  studioLogsDir?: string;
  /**
   * The save with Ctrl+S (tests: never drive a real Studio window). `unattended`: nobody is at the PC, so Studio may
   * be brought to the foreground and the window in front put back.
   */
  save?: (placeFile: string, unattended: boolean) => Promise<SavePlaceResult>;
  /**
   * The save through Studio's File menu (studio-window.ts pressSaveInMenu): no keys, no turn in Studio's line, the
   * focus back in a fraction of a second. `minIdleMs`: only when nobody has typed for that long. Absent with `save`
   * given (tests of the keys): there is no menu.
   */
  menuSave?: (placeFile: string, minIdleMs: number) => Promise<SavePlaceResult>;
  /** Tests: pretend the user is (not) busy in another app. */
  userBusy?: () => Promise<boolean>;
  /** Tests: what the user is doing (idle time, the app in front). */
  activity?: () => Promise<UserActivity | null>;
  /** Agents are working on the project right now: a Studio that closed is reopened (absent: never). */
  working?: () => boolean;
}

const SAVE_EVERY_MS = 10 * 60 * 1000;
/**
 * How the place is saved through Studio's File menu. With someone working in another app the place is saved when it
 * has had unsaved changes for `busyEveryMs` (the menu shows in Studio for a tenth of a second), otherwise every
 * SAVE_EVERY_MS; the menu is opened only after `pauseMs` without a key or a mouse move (a key pressed while it is
 * open would choose one of its entries); a place unsaved for `lateMs` is said in the project's activity, with what
 * holds the save back. An object so a test can shorten it.
 *
 * Why: two builds ran 14 hours, and one project's place was saved once. A save with Ctrl+S waits for a free moment
 * in Studio's line (there is none while a dozen agents stand in it), for Windows to let Studio come to the front
 * (refused for hours), and for the user to stop working in another app. Studio then crashed, came back as its
 * last save, three hours old, and the team spent an hour putting the work back.
 *
 * A problem with saving is said in the chat once (see tell); the same problem again only after a save worked in
 * between and `tellAgainMs` after it was said. On 2026-10-07 one project's chat said "I haven't been able to save the
 * place" fifteen times in a day, every hour, for a Studio the user had closed while the team was paused.
 */
export const PLACE_SAVE = { busyEveryMs: 20 * 60_000, pauseMs: 1500, lateMs: 30 * 60_000, timeoutMs: 15_000, tellAgainMs: 12 * 60 * 60_000 };

/** What kept a save from happening, as said in the chat (each said once: PlaceGuard.tell). */
type SaveProblem = 'focus' | 'closed' | 'nowindow' | 'dialog' | 'other';
/** After Windows refused to bring Studio forward, unattended saves wait this long before asking again. */
const FOCUS_BACKOFF_MS = 10 * 60 * 1000;
const KEEP_BACKUPS = 20;
/** How many of the place files that a recovery copy took the stead of are kept. */
const KEEP_SAVED = 5;
/** A recovery copy is used when it is at least this much newer than the place file. */
const RECOVERY_NEWER_MS = 60_000;
/** How recently a Studio log must have been written to be the log of the Studio that just closed. */
const CRASH_LOG_MS = 10 * 60_000;
/** A place with fewer parts than this, while the project has world builders, lost its world. */
const EMPTY_PLACE_PARTS = 25;

const COUNT_PARTS = `local n = 0
for _, d in workspace:GetDescendants() do
  if d:IsA("BasePart") and not d:IsA("Terrain") then n += 1 end
end
return game:GetService("HttpService"):JSONEncode({ parts = n })`;

/**
 * Keeps the world agents build from being lost. Studio's MCP has no save command and the world lives in
 * Studio's memory until the place is saved, so the guard:
 * - saves (Ctrl+S through the Studio window, confirmed by the file time) after verified work and at most
 *   every 10 minutes while the world has unsaved changes — taking its turn with play mode like any other
 *   Studio user, and never while the user is busy in another app (that would steal their focus);
 * - files Studio's own auto-recovery copies of the place into the project (.shuriken/backups): a backup
 *   that needs no window focus, every few minutes;
 * - rebuilds a place that opens without its world (e.g. never saved) from the project's world/ builders;
 * - reopens the place when Studio closes while agents are working (StudioRecovery), and checks it again then.
 */
export class PlaceGuard {
  private dirty = false;
  /** When the place first had changes that are still unsaved (0: none). */
  private dirtySince = 0;
  /** Why the last save that did not happen did not (for the log, said once per reason, and for "late"). */
  private heldBack = '';
  /** Said that the place has been unsaved for long (once, until a save works). */
  private lateSaid = false;
  private lastSave = 0;
  private lastAttempt = 0;
  /** A save through Studio's File menu has worked in this Studio: a menu that fails once is tried again, not swapped for Ctrl+S. */
  private menuWorked = false;
  private failures = 0;
  /** Save problems said in the chat: when, and whether a save has worked since (see tell). */
  private readonly told = new Map<SaveProblem, { at: number; fixed: boolean }>();
  /** Said in the chat that the place file is in the other format than its name says (until it is fixed). */
  private formatTold = false;
  /** Windows wouldn't bring Studio to the front: not asked again for a while. */
  private focusBackoffUntil = 0;
  /** The try that Windows refused was made with nobody at the PC (the strongest way there is to bring Studio forward). */
  private focusBackoffUnattended = false;
  private backupMtime = -1;
  private saving: Promise<SavePlaceResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private healed = new Set<string>();
  private readonly off: Array<() => void> = [];
  /** Reopens the place when Studio closes while agents work (a crash). */
  readonly recovery: StudioRecovery;

  constructor(private readonly d: PlaceGuardDeps) {
    this.recovery = new StudioRecovery({
      project: d.project,
      studio: d.studio,
      bus: d.bus,
      log: d.log,
      // Agents at work, or a verification of their work in Studio.
      working: () => (d.working?.() ?? false) || !!d.lease.holder?.owner.startsWith('verifier:'),
      lease: d.lease,
      // The place is saved inside the refresh's own turn in Studio's line, whoever is or isn't at the PC.
      save: () => (this.dirty ? this.saveNow('restore', true, true) : Promise.resolve({ ok: true, message: 'Nothing unsaved.' })),
      activity: d.activity,
      // The place came back older than the work: the "once per Studio session" check runs again for the new session,
      // and after a crash with unsaved work the world and the code are put back from the files.
      reopened: async (ctx, how): Promise<PlaceCheck> => {
        this.healed.clear();
        this.checkFormat(ctx);
        const healed = await this.heal(ctx);
        // The window turned into another place (published from it, another file opened in it): not a crash, and nothing
        // in the place file was lost with it. The world is not rebuilt from every build script (on 2026-10-07 that took
        // 13 minutes with the team held, for a recovery copy ten minutes old and whole): heal rebuilds only a world that
        // is missing, and the code goes in from the files the way every sync puts it.
        if (how?.moved) {
          if (healed === 'rebuilt') return { rebuilt: true, codePushed: true };
          // A project whose code Shuriken doesn't sync pushes nothing (null): nothing is said about the code then.
          const pushed = await this.d.pushCode(ctx).then(
            (r) => (r != null ? true : undefined),
            (e: unknown) => {
              this.d.log.warn('Code push after reopening the local place failed', errorMessage(e));
              return false;
            },
          );
          return { rebuilt: false, codePushed: pushed };
        }
        if (healed !== 'rebuilt' && how?.crashed && (this.dirty || how.recovered)) await this.restore(ctx, how.recovered);
        return { rebuilt: healed === 'rebuilt' };
      },
      recover: (ctx, file) => this.recoverCopy(ctx, file),
      crashReason: (file) => studioCrashReason(file, d.studioLogsDir),
    });
  }

  start(): void {
    this.recovery.start();
    this.timer = setInterval(() => void this.tick().catch((e) => this.d.log.warn('Place guard tick failed', errorMessage(e))), 30_000);
    this.off.push(
      this.d.bus.on('roblox.changed', (e) => {
        if (/^(connection:|binding|studio-opened)/.test(e.reason)) return;
        this.touched();
      }),
    );
  }

  stop(): void {
    this.recovery.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const f of this.off.splice(0)) f();
  }

  /** A new project is open: forget the last one's state. */
  reset(): void {
    this.dirty = false;
    this.dirtySince = 0;
    this.heldBack = '';
    this.lateSaid = false;
    this.failures = 0;
    this.told.clear();
    this.formatTold = false;
    this.focusBackoffUntil = 0;
    this.backupMtime = -1;
    this.lastSave = Date.now();
  }

  get unsaved(): boolean {
    return this.dirty;
  }

  private placeFile(ctx = this.d.project()): string | null {
    return ctx ? placePath(ctx) : null;
  }

  async tick(): Promise<void> {
    await this.backup();
    this.checkFormat();
    if (this.dirty && this.d.autoSave() && Date.now() - this.lastSave > SAVE_EVERY_MS && Date.now() - this.lastAttempt > 2 * 60 * 1000) await this.saveNow('periodic');
    this.late();
  }

  /** The place has changes that are not saved. */
  private touched(): void {
    if (!this.dirty || !this.dirtySince) this.dirtySince = Date.now();
    this.dirty = true;
  }

  /** How long the place has had unsaved changes (0: none). */
  get unsavedMs(): number {
    return this.dirty && this.dirtySince ? Date.now() - this.dirtySince : 0;
  }

  /**
   * A place unsaved for PLACE_SAVE.lateMs: said once in the project's activity and the log, with what holds the save
   * back. Nothing said that for 14 hours of two builds, and nobody knew the place was hours behind until Studio closed.
   */
  private late(): void {
    const ctx = this.d.project();
    if (!ctx || this.lateSaid || !this.d.autoSave() || this.unsavedMs < PLACE_SAVE.lateMs) return;
    this.lateSaid = true;
    const title = `The place has not been saved for ${Math.round(this.unsavedMs / 60_000)} min${this.heldBack ? `: ${this.heldBack}` : ''}`.slice(0, 300);
    this.d.log.warn(title);
    ctx.audit.event({ kind: 'place.save.late', severity: 'warning', title });
  }

  /** A save that did not happen: why, in the log once per reason. */
  private waits(r: SavePlaceResult): SavePlaceResult {
    if (r.message !== this.heldBack) this.d.log.info('The place is not saved yet', r.message);
    this.heldBack = r.message;
    return r;
  }

  /** Verified work changed the world: save soon (still not while the user is busy elsewhere). */
  checkpoint(): void {
    this.touched();
    if (!this.d.autoSave()) return;
    setTimeout(() => void this.saveNow('checkpoint').catch(() => undefined), 5000);
  }

  /**
   * Save the place now. `force` (the user pressed Save) skips the busy-elsewhere check; `held`: the caller holds
   * Studio's turn already, so none is taken. Returns the
   * outcome; failures are recorded and, when they keep happening, reported once an hour in the chat.
   */
  async saveNow(reason: 'periodic' | 'checkpoint' | 'goal' | 'user' | 'restore', force = false, held = false): Promise<SavePlaceResult> {
    if (this.saving) return this.saving;
    const ctx = this.d.project();
    const file = this.placeFile(ctx);
    if (!ctx || !file) return { ok: false, message: 'This project has no local place file.' };
    this.lastAttempt = Date.now();
    this.saving = (async (): Promise<SavePlaceResult> => {
      // A place file in the other format than its name says: Studio answers every save with a Save As dialog, so the
      // menu is not pressed into one again and again (checkFormat says once what fixes it).
      const wrong = this.checkFormat(ctx);
      if (wrong) return this.waits({ ok: false, message: `Waiting: ${wrong.message}` });
      // Nobody at the PC for a few minutes: Studio may come to the foreground for the save (and the window that was in
      // front goes back afterwards). With someone there, their focus is never taken.
      const act = this.d.activity ? await this.d.activity() : this.d.userBusy ? null : await (this.d.studio.windows?.idle.activity() ?? readUserActivity()).catch(() => null);
      const alone = !!act && act.idleMs >= UNATTENDED.idleMs;
      const busy = !force && !alone && (this.d.userBusy ? await this.d.userBusy() : busyElsewhere(act));
      // Through Studio's File menu first (studio-window.ts pressSaveInMenu): no key is sent, it needs no turn in
      // Studio's line (during a playtest it saves the place being edited, and the playtest plays on), and it does
      // not depend on Windows letting Studio come to the front. `held` or not makes no difference to it.
      const menu = this.d.menuSave ?? (this.d.save ? null : (f: string, idle: number) => saveStudioPlace(f, PLACE_SAVE.timeoutMs, { via: 'menu', minIdleMs: idle }));
      if (menu) {
        // The menu shows in Studio for a tenth of a second and the focus comes straight back: with someone working
        // in another app that is done only for a place that has been unsaved for a while.
        if (busy && this.unsavedMs < PLACE_SAVE.busyEveryMs) {
          return this.waits({ ok: false, waiting: true, message: `Waiting: you are working in another app; the place is saved once its changes are ${Math.round(PLACE_SAVE.busyEveryMs / 60_000)} minutes old (Studio's menu shows for a moment).` });
        }
        const r = await menu(file, force || alone ? 0 : PLACE_SAVE.pauseMs);
        if (r.ok) return this.saved(ctx, reason, r);
        if (r.noWindow && this.closedByUser()) return this.closed(ctx, r);
        if (r.waiting) {
          // Someone is typing: looked at again at the next tick, not in two minutes.
          this.lastAttempt = 0;
          return this.waits(r);
        }
        if (!r.noMenu) return this.failed(ctx, reason, this.waits(r).message, r);
        // The menu worked in this Studio before: this time it didn't open, or its entry wasn't found in time (a dialog
        // over it, Studio busy). Asked again soon, through the menu. Ctrl+S needs Studio in front, which Windows refuses
        // while you use another app: three times on 2026-10-06 a save fell back to it and nothing was saved for an hour.
        if (this.menuWorked) {
          this.d.log.info('The File menu save did not go through this time; trying it again shortly', r.menuNote ?? '');
          this.lastAttempt = Date.now() - 2 * 60 * 1000 + 30_000;
          return this.waits({ ok: false, waiting: true, message: `Waiting: Studio's File menu did not open for the save a moment ago${r.menuNote ? ` (${r.menuNote.slice(0, 120)})` : ''}; trying again shortly.` });
        }
        this.d.log.info('Studio has no File menu save; using Ctrl+S', r.menuNote ?? '');
        // This Studio has no such menu (another language): Ctrl+S, as before.
      }
      // A refusal met with someone at the PC says nothing about what an unattended try can do.
      if (!force && Date.now() < this.focusBackoffUntil && !(alone && !this.focusBackoffUnattended)) {
        // Windows wouldn't bring Studio forward a moment ago (said once): not asked again every few minutes.
        return this.waits({ ok: false, focus: true, message: "Waiting: Windows wouldn't bring Studio to the front a moment ago; trying again later (Studio's recovery copies are backed up meanwhile)." });
      }
      if (busy) {
        // Saving brings Studio to the front; while the user works in another app, wait (backups cover it).
        return this.waits({ ok: false, message: 'Waiting: saving would pull Studio in front of the app you are using.' });
      }
      // Take a turn with play mode: nothing playtests while the save runs. A save nobody is waiting for (periodic, after
      // verified work) doesn't queue behind a playtest — that would hold up the agents waiting for Studio too: it waits
      // for a quieter moment, and the recovery backups cover it.
      const unattended = reason === 'periodic' || reason === 'checkpoint';
      // `held`: the caller holds Studio's turn already (a refresh that saves before it reopens the place).
      const turn = held || (unattended ? this.d.lease.tryAcquire('saver') : await this.d.lease.acquire('saver', 3 * 60 * 1000));
      if (!turn) return unattended ? this.waits({ ok: false, message: 'Waiting: Studio is in a playtest; the save waits for a quieter moment.' }) : this.failed(ctx, reason, 'Studio stayed in a playtest');
      try {
        // The turn is ours, and Studio plays all the same: the user is trying the game (or pressed Play). Ctrl+S saves
        // nothing there and lands in their game as key presses ("S" walks the character backwards); it was then
        // reported as a save that failed. The save waits for Edit mode.
        if (await this.studioPlays()) return this.waits({ ok: false, message: force ? 'Studio is in a playtest: stop it in Studio, then save.' : 'Waiting: Studio is in a playtest that is not the team\'s; the save waits until it is back in Edit mode.' });
        const r = await (this.d.save ?? ((f: string, nobody: boolean) => saveStudioPlace(f, PLACE_SAVE.timeoutMs, { unattended: nobody, via: 'keys' })))(file, alone);
        // The Ctrl+S it pressed is Shuriken's own input, not the user coming back.
        if (alone && act) this.d.studio.windows?.idle.noteOwnInput(act.idleMs);
        if (r.focus) this.focusBackoffUnattended = alone;
        if (!r.ok && r.noWindow && this.closedByUser()) return this.closed(ctx, r);
        if (!r.ok) return r.focus ? this.focusFailed(ctx, this.waits(r)) : this.failed(ctx, reason, this.waits(r).message, r);
        return this.saved(ctx, reason, r);
      } finally {
        if (!held) this.d.lease.release('saver');
      }
    })().finally(() => (this.saving = null));
    return this.saving;
  }

  /** The place file was written: nothing is unsaved, and whatever was said about saves that failed starts over. */
  private saved(ctx: ProjectContext, reason: string, r: SavePlaceResult): SavePlaceResult {
    if (r.how === 'menu') this.menuWorked = true;
    this.dirty = false;
    this.dirtySince = 0;
    this.heldBack = '';
    this.lateSaid = false;
    this.failures = 0;
    // What was said about saves that failed may be said again if it comes back (after PLACE_SAVE.tellAgainMs).
    for (const t of this.told.values()) t.fixed = true;
    this.focusBackoffUntil = 0;
    this.lastSave = Date.now();
    ctx.audit.event({ kind: 'place.saved', severity: 'info', title: `Saved the place in Studio (${reason})` });
    return r;
  }

  /**
   * Says a save problem in the chat, once: the same problem again only once a save has worked since and
   * PLACE_SAVE.tellAgainMs has passed. True when it was said now.
   */
  private tell(ctx: ProjectContext, problem: SaveProblem, text: string): boolean {
    const t = this.told.get(problem);
    if (t && !(t.fixed && Date.now() - t.at >= PLACE_SAVE.tellAgainMs)) return false;
    this.told.set(problem, { at: Date.now(), fixed: false });
    new ChatService(ctx, this.d.bus).add({ role: 'system', kind: 'status', text });
    return true;
  }

  /**
   * No Studio window has the place, nobody is working and nothing is reopening it: the user closed Studio while the
   * team is paused. Nothing is unsaved in a Studio that is gone, and nothing is wrong. (While the team works, a Studio
   * that went is reopened by StudioRecovery, and a window that turned into another place is followed.)
   */
  private closedByUser(): boolean {
    return !(this.d.working?.() ?? false) && !this.d.studio.reopening && !this.recovery.moving;
  }

  /** The place's Studio was closed while the team is paused: said once, in plain words, and not counted as a failure. */
  private closed(ctx: ProjectContext, r: SavePlaceResult): SavePlaceResult {
    const name = basename(this.placeFile(ctx) ?? 'the place');
    if (this.tell(ctx, 'closed', `Studio isn't open with ${name} (it was closed while the team is paused), so there is nothing for me to save. That's fine: the place opens again by itself when the team starts working.`)) {
      ctx.audit.event({ kind: 'place.save.skipped', severity: 'info', title: `Not saving: Studio isn't open with ${name} while the team is paused` });
    }
    return this.waits(r);
  }

  /** Studio is in play mode right now (false when it can't be told: the save then goes ahead as before). */
  private async studioPlays(): Promise<boolean> {
    try {
      const st = await this.d.studio.state();
      return st.availableDataModels.includes('Server') || st.availableDataModels.includes('Client');
    } catch {
      return false;
    }
  }

  /**
   * Windows wouldn't bring Studio to the front, so there is no way to press Ctrl+S unattended (Studio's MCP has no save
   * command, and no Luau call saves a place file without its window). Nothing is wrong with the place and the build goes
   * on: said once (the project's activity and the chat) until a save works, and not tried again for ten minutes; Studio's
   * recovery copies keep being backed up meanwhile.
   */
  private focusFailed(ctx: ProjectContext, r: SavePlaceResult): SavePlaceResult {
    this.focusBackoffUntil = Date.now() + FOCUS_BACKOFF_MS;
    const said = this.tell(
      ctx,
      'focus',
      "I couldn't bring Studio to the front to save the place (Windows wouldn't let me). That's fine: the work goes on, and Studio's own recovery copies of the place are backed up in the project every few minutes. Press Ctrl+S in Studio when you get a chance.",
    );
    if (said) ctx.audit.event({ kind: 'place.save.skipped', severity: 'info', title: "Couldn't bring Studio to the front to save the place; the build goes on and the recovery backups cover it" });
    return r;
  }

  /** A save that failed: in the activity now and then, and in the chat once it has failed three times (once per kind). */
  private failed(ctx: ProjectContext, reason: string, message: string, r?: SavePlaceResult): SavePlaceResult {
    this.failures++;
    if (this.failures === 1 || this.failures % 5 === 0) ctx.audit.event({ kind: 'place.save.failed', severity: 'warning', title: `Could not save the place (${reason}): ${message}`.slice(0, 300) });
    if (this.failures >= 3) {
      const problem: SaveProblem = r?.noWindow ? 'nowindow' : /shows (a dialog|dialogs)/.test(message) ? 'dialog' : 'other';
      const said = /[.!?)]$/.test(message) ? message : `${message}.`;
      this.tell(ctx, problem, `I couldn't save the place in Studio. ${said} Studio's recovery copies of the place are backed up in the project meanwhile.`);
    }
    return { ok: false, message };
  }

  /** Studio's newest auto-recovery file of this place (it writes one every few minutes, and removes them when it closes properly). */
  private newestRecovery(file: string): { path: string; mtime: number; size: number } | null {
    const dir = this.d.autoSavesDir ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Roblox', 'RobloxStudio', 'AutoSaves');
    if (!existsSync(dir)) return null;
    const stem = `${basename(file, extname(file))}_AutoRecovery_`;
    let newest: { path: string; mtime: number; size: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(stem) || !f.endsWith('.rbxl')) continue;
      const st = statSync(join(dir, f));
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: join(dir, f), mtime: st.mtimeMs, size: st.size };
    }
    return newest;
  }

  /**
   * Studio is gone and the place is about to be opened again. Studio keeps a recovery copy of every open place (a
   * few minutes old at most) and leaves it behind when it crashes: when that copy is newer than the place file and in
   * the place file's own format, it takes the place file's stead, and the file as it was saved is kept in
   * .shuriken/backups ("saved-<time>"). In the build this was written after, the last save was 167 minutes old and
   * the recovery copy 19.
   *
   * Only a copy in the same format: Studio writes its recovery copies in its binary format, and an XML place
   * (.rbxlx) with binary data in it opens (Studio reads the content) but is never saved again under its name: every
   * save, Ctrl+S and File > Save to File alike, opens a Save As dialog. 1.15.7 put binary copies in .rbxlx files and
   * that is what happened on 2026-10-07. An .rbxlx place opens as it was last saved instead, and a crash with unsaved
   * work is put back from the files (restore).
   */
  recoverCopy(ctx: ProjectContext, file: string): RecoveredCopy | null {
    if (!existsSync(file)) return null;
    const newest = this.newestRecovery(file);
    const savedAt = statSync(file).mtimeMs;
    if (!newest || newest.mtime <= savedAt + RECOVERY_NEWER_MS || newest.size < 1000) return null;
    // A place file, whole: it begins with the format's own mark and ends with "</roblox>" (both formats do).
    const head = Buffer.alloc(16);
    const tail = Buffer.alloc(32);
    const fd = openSync(newest.path, 'r');
    try {
      readSync(fd, head, 0, 16, 0);
      readSync(fd, tail, 0, 32, Math.max(0, newest.size - 32));
    } finally {
      closeSync(fd);
    }
    const format = placeFormatOf(head);
    if (!format || !tail.toString('latin1').includes('</roblox>')) {
      this.d.log.warn("Studio's recovery copy is not a whole place file; the place opens as it was last saved", newest.path);
      return null;
    }
    if (format !== formatForName(file)) {
      this.d.log.info(
        `Studio's recovery copy of ${clockTime(newest.mtime)} is in the ${format} format and ${basename(file)} is not, so it does not take the place file's stead (Studio would save it only through a Save As dialog); the place opens as it was last saved (${clockTime(savedAt)})`,
      );
      return null;
    }
    const out = join(ctx.dir, 'backups');
    mkdirSync(out, { recursive: true });
    const kept = join(out, `saved-${new Date(savedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}${extname(file)}`);
    copyFileSync(file, kept);
    utimesSync(kept, new Date(savedAt), new Date(savedAt));
    const saved = readdirSync(out)
      .filter((f) => f.startsWith('saved-'))
      .sort();
    for (const old of saved.slice(0, Math.max(0, saved.length - KEEP_SAVED))) {
      try {
        unlinkSync(join(out, old));
      } catch {
        /* in use */
      }
    }
    copyFileSync(newest.path, file);
    this.d.log.info(`The place opens from Studio's recovery copy of ${clockTime(newest.mtime)} (last saved ${clockTime(savedAt)}; that file is kept as ${basename(kept)})`);
    return {
      copyAt: newest.mtime,
      savedAt,
      undo: () => {
        copyFileSync(kept, file);
        utimesSync(file, new Date(savedAt), new Date(savedAt));
      },
    };
  }

  /**
   * Studio closed with work in the place that was not saved, and the place came back older than that work (as its
   * last save, or as Studio's recovery copy). The project's files are what is true: the world is rebuilt from the
   * build scripts and the code is pushed (after a reopen a sync lets the files win: code-sync.ts), with the team
   * held until both are done, and the place is saved. Left to itself, every agent found its own piece of the gap:
   * checks failed on things that were gone, a critic rejected work whose effect "no longer appears", syncs wrote
   * old scripts over new files, and three agents spent their runs digging copies out of backups.
   */
  async restore(ctx: ProjectContext, recovered: RecoveredCopy | null): Promise<'restored' | 'skipped'> {
    if (!this.d.studio.connected) return 'skipped';
    const builders = ctx.extras().adopted ? [] : listWorldBuilders(ctx.root).files;
    const chat = new ChatService(ctx, this.d.bus);
    const asOf = recovered ? `Studio's recovery copy of ${clockTime(recovered.copyAt)}` : 'it was last saved';
    const doing = builders.length ? `rebuilding the world from the project's ${builders.length} build script${builders.length === 1 ? '' : 's'} and putting the code back from the files` : 'putting the code back from the files';
    const note = chat.add({ role: 'system', kind: 'status', text: `Studio closed with work that was not saved, so the place came back as ${asOf}. I'm ${doing} before the team continues…` });
    const work = (async () => {
      const turn = await this.d.lease.acquire('healer', 5 * 60 * 1000);
      let ok = 0;
      let total = 0;
      try {
        if (builders.length) {
          const { results } = await rebuildWorld(this.d.studio, ctx.root);
          total = results.length;
          ok = results.filter((r) => r.ok).length;
        }
        await this.d.pushCode(ctx).catch((e) => this.d.log.warn('Code push after reopening Studio failed', errorMessage(e)));
        this.d.bus.emit('roblox.changed', { reason: 'world.rebuilt' });
      } finally {
        if (turn) this.d.lease.release('healer');
      }
      const built = total ? ` Rebuilt the world (${ok} of ${total} build scripts worked)` : '';
      ctx.audit.event({ kind: 'place.restored', severity: ok === total ? 'success' : 'warning', title: `Studio came back as ${asOf}:${built || ' no build scripts;'} and pushed the code from the files`.slice(0, 300) });
      chat.update(note.id, {
        text: `Studio closed with work that was not saved, and the place came back as ${asOf}.${built ? `${built} and put` : ' I put'} the code back from the files. What was placed by hand after that and is in no build script is gone; the team redoes what is missing.`,
      });
      await this.saveNow('restore', true).catch(() => undefined);
    })();
    this.d.hold(work, 'Putting the place back after Studio closed');
    await work.catch((e) => {
      this.d.log.warn('Restoring the place after Studio closed failed', errorMessage(e));
      chat.update(note.id, { kind: 'error', text: `Studio closed with work that was not saved, and I couldn't put the place back by myself (${errorMessage(e)}). Use "Rebuild world" on the viewer page, then sync the code.` });
    });
    return 'restored';
  }

  /**
   * The place file holds the other format than its name says (binary data in an .rbxlx: what 1.15.7 did when it put
   * Studio's binary recovery copy in the place file's stead). Studio opens it (it reads the content) but won't save it
   * under that name: Ctrl+S and File > Save to File both open a Save As dialog, and the guard pressed the menu into
   * that dialog again and again. Said once in the chat with what fixes it; saves wait until the file is fixed.
   * Returns the mismatch, with the reason saves wait (null: the file is what its name says, or there is none).
   */
  checkFormat(ctx = this.d.project()): { has: PlaceFormat; want: PlaceFormat; message: string } | null {
    const file = this.placeFile(ctx);
    if (!ctx || !file) return null;
    let m: { has: PlaceFormat; want: PlaceFormat } | null = null;
    try {
      m = placeFormatMismatch(file);
    } catch {
      return null;
    }
    const name = basename(file);
    if (!m) {
      if (this.formatTold) this.d.log.info(`${name} is in its own format again; saves go on`);
      this.formatTold = false;
      return null;
    }
    const has = m.has === 'binary' ? "Roblox's binary place format" : "Roblox's XML place format";
    const type = m.want === 'xml' ? '"Roblox XML Place (*.rbxlx)"' : 'the binary "Roblox Place (*.rbxl)"';
    const message = `${name} holds ${has} although its name ends in ${extname(name)}, so Studio won't save it under that name (every save opens a Save As dialog); saves wait until it is saved again as ${type}.`;
    if (!this.formatTold) {
      this.formatTold = true;
      this.d.log.warn(message);
      ctx.audit.event({ kind: 'place.format', severity: 'warning', title: message.slice(0, 300) });
      new ChatService(ctx, this.d.bus).add({
        role: 'system',
        kind: 'status',
        text: `${name} holds ${has} although its name ends in ${extname(name)}, so Studio won't save it: every save, yours and mine, opens a Save As dialog. To fix it once, press Ctrl+S in Studio, and in the Save As dialog keep the same folder and file name, pick ${type} as the type, and confirm that it replaces the file. Until then I don't press Save; Studio's recovery copies are still backed up in the project.`,
      });
    }
    return { ...m, message };
  }

  /** Copy Studio's newest auto-recovery file of this place into the project (when it changed). */
  async backup(): Promise<string | null> {
    const ctx = this.d.project();
    const file = this.placeFile(ctx);
    if (!ctx || !file) return null;
    const newest = this.newestRecovery(file);
    if (!newest) return null;
    const out = join(ctx.dir, 'backups');
    if (this.backupMtime < 0) {
      // After a restart: continue from the newest copy already filed.
      this.backupMtime = existsSync(out) ? Math.max(0, ...readdirSync(out).map((f) => statSync(join(out, f)).mtimeMs)) : 0;
    }
    if (newest.mtime <= this.backupMtime + 1) return null;
    mkdirSync(out, { recursive: true });
    const stamp = new Date(newest.mtime).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = join(out, `place-${stamp}.rbxl`);
    copyFileSync(newest.path, target);
    // Keep the source's time on the copy, so a restart knows what is already filed.
    utimesSync(target, new Date(newest.mtime), new Date(newest.mtime));
    this.backupMtime = newest.mtime;
    const all = readdirSync(out)
      .filter((f) => f.startsWith('place-') && f.endsWith('.rbxl'))
      .sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
      try {
        unlinkSync(join(out, old));
      } catch {
        /* in use */
      }
    }
    return target;
  }

  /**
   * A place that opens without its world (never saved, or reverted) while the project has world
   * builders: rebuild it and push the code, holding the team until it is back. Once per project and
   * Studio session.
   */
  async heal(ctx: ProjectContext): Promise<'rebuilt' | 'fine' | 'skipped'> {
    const key = `${ctx.summary.id}:${this.d.studio.binding ?? ''}`;
    if (this.healed.has(key)) return 'skipped';
    // A plugged-in game's world was built by hand: a small place is just small, never "opened empty".
    if (ctx.extras().adopted) return 'skipped';
    const builders = listWorldBuilders(ctx.root).files;
    if (!builders.length || !this.d.studio.connected) return 'skipped';
    const count = await this.d.studio.luauJson<{ parts: number }>(COUNT_PARTS, 'Edit', 120_000).catch(() => null);
    if (!count) return 'skipped';
    this.healed.add(key);
    if (count.parts >= EMPTY_PLACE_PARTS) return 'fine';
    const chat = new ChatService(ctx, this.d.bus);
    const note = chat.add({ role: 'system', kind: 'status', text: `Your place opened without its world (it hadn't been saved in Studio), so I'm rebuilding it from the project's ${builders.length} build script${builders.length === 1 ? '' : 's'} before the team continues…` });
    const work = (async () => {
      const turn = await this.d.lease.acquire('healer', 3 * 60 * 1000);
      try {
        const { results } = await rebuildWorld(this.d.studio, ctx.root);
        const ok = results.filter((r) => r.ok).length;
        await this.d.pushCode(ctx).catch((e) => this.d.log.warn('Code push after rebuild failed', errorMessage(e)));
        this.d.bus.emit('roblox.changed', { reason: 'world.rebuilt' });
        ctx.audit.event({ kind: 'world.rebuilt', severity: ok === results.length ? 'success' : 'warning', title: `Rebuilt the world after the place opened empty (${ok}/${results.length} builders)` });
        chat.update(note.id, {
          text:
            ok === results.length
              ? `Rebuilt the world from ${ok} build script${ok === 1 ? '' : 's'} and restored the code. Anything that was placed by hand and never saved couldn't be recovered; the team will redo what's missing.`
              : `Rebuilt what I could (${ok} of ${results.length} build scripts worked) and restored the code. The team will fix the rest.`,
        });
      } finally {
        if (turn) this.d.lease.release('healer');
      }
      await this.saveNow('restore', true).catch(() => undefined);
    })();
    this.d.hold(work, 'Restoring the world before the team continues');
    await work.catch((e) => {
      this.d.log.warn('World rebuild failed', errorMessage(e));
      chat.update(note.id, { kind: 'error', text: `I couldn't rebuild the world automatically (${errorMessage(e)}). Use "Rebuild world" on the viewer page.` });
    });
    return 'rebuilt';
  }
}

/**
 * Why Studio closed, from the end of its own log: the newest Studio log written in the last few minutes that names
 * this place and ends in a crash line ("RBXCRASH: …"), in a few words; '' when there is none (it was closed by
 * hand, or its log says nothing). The crash this was written after: "Ran out of remap ids, increase max count",
 * at the start of that Studio window's 256th playtest.
 */
export function studioCrashReason(placeFile: string, logsDir?: string): string {
  const dir = logsDir ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Roblox', 'logs');
  if (!existsSync(dir)) return '';
  const name = basename(placeFile);
  const now = Date.now();
  const logs = readdirSync(dir)
    .filter((f) => /Studio.*\.log$/i.test(f))
    .map((f) => ({ path: join(dir, f), st: statSync(join(dir, f)) }))
    .filter((l) => now - l.st.mtimeMs < CRASH_LOG_MS)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  for (const log of logs.slice(0, 6)) {
    const size = Math.min(log.st.size, 256 * 1024);
    const buf = Buffer.alloc(size);
    const fd = openSync(log.path, 'r');
    try {
      readSync(fd, buf, 0, size, log.st.size - size);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    if (!text.includes(name)) continue;
    const crash = [...text.matchAll(/RBXCRASH: ([^\r\n]+)/g)].at(-1)?.[1]?.trim();
    if (crash) return `Studio crashed: "${crash.slice(0, 120)}"`;
  }
  return '';
}

/** Roblox's two place formats: binary (.rbxl) and XML (.rbxlx). */
export type PlaceFormat = 'binary' | 'xml';

/**
 * What a place file's first bytes say it is: Studio's binary format begins with "<roblox!", its XML format with
 * "<roblox " (or an XML declaration). Null when it is neither.
 */
export function placeFormatOf(head: Buffer): PlaceFormat | null {
  let t = head.toString('latin1');
  if (t.startsWith('\xEF\xBB\xBF')) t = t.slice(3);
  t = t.trimStart();
  if (t.startsWith('<roblox!')) return 'binary';
  if (/^<roblox[\s>/]/.test(t) || t.startsWith('<?xml')) return 'xml';
  return null;
}

/** The format a place file's name promises (null: not a place file name). */
export function formatForName(file: string): PlaceFormat | null {
  const ext = extname(file).toLowerCase();
  return ext === '.rbxlx' ? 'xml' : ext === '.rbxl' ? 'binary' : null;
}

/** The place file holds the other format than its name promises (binary data in an .rbxlx), or null. */
export function placeFormatMismatch(file: string): { has: PlaceFormat; want: PlaceFormat } | null {
  const want = formatForName(file);
  if (!want || !existsSync(file)) return null;
  const head = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  let n = 0;
  try {
    n = readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  const has = placeFormatOf(head.subarray(0, n));
  return has && has !== want ? { has, want } : null;
}

/** The user is actively using an app other than Studio or Shuriken (recent input and another window in front). */
function busyElsewhere(act: UserActivity | null): boolean {
  return !!act && act.idleMs < 60_000 && !/^(RobloxStudioBeta|Shuriken)$/i.test(act.foreground);
}

/**
 * True when the user is actively using an app other than Studio or Shuriken (recent input and another
 * window in front): bringing Studio forward then would steal their focus.
 */
export async function userBusyElsewhere(): Promise<boolean> {
  return busyElsewhere(await readUserActivity());
}
