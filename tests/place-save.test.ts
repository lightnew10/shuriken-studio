import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLACE_SAVE, PlaceGuard, placeFormatMismatch, studioCrashReason } from '../src/core/roblox/place-guard';
import { PlaytestLease } from '../src/core/roblox/playtest-lease';
import { STUDIO_RECOVERY, StudioRecovery } from '../src/core/roblox/studio-recovery';
import type { SavePlaceResult, UserActivity } from '../src/core/roblox/studio-window';
import { SAVE_PENDING_MS, notePendingSave, saveWaitMs, savePending } from '../src/core/roblox/studio-window';
import type { StudioProcess } from '../src/core/roblox/studio-login-lock';
import { coreHarness } from './helpers/make-core';

/**
 * Two builds ran for 14 hours and one project's place was saved once: the save (Ctrl+S) waited for a free moment in
 * Studio's line, for Windows to let Studio come to the front, and for the user to leave the app they worked in.
 * Studio then crashed and came back three hours old, while its own recovery copy was 19 minutes old. Nothing here
 * touches a real Studio.
 */
const makeCore = coreHarness();
const saved = { save: { ...PLACE_SAVE }, rec: { ...STUDIO_RECOVERY } };
beforeEach(() => {
  Object.assign(STUDIO_RECOVERY, { everyMs: 60_000, tries: 2, openMs: 200, retryMs: 5, maxLaunches: 6, windowMs: 60_000 });
});
afterEach(() => {
  Object.assign(PLACE_SAVE, saved.save);
  Object.assign(STUDIO_RECOVERY, saved.rec);
});

/**
 * A whole place file in Studio's binary format, as far as the guard looks: how it begins and how it ends. `fill` tells
 * two of them apart (the byte after the mark).
 */
const binaryPlace = (fill = 7) => Buffer.concat([Buffer.from('<roblox!', 'latin1'), Buffer.alloc(1200, fill), Buffer.from('END\0\0\0\0\0\t\0\0\0\0\0\0\0</roblox>', 'latin1')]);
const BINARY_PLACE = binaryPlace(9);
/** What a place file is: XML as saved ("<roblox>"), Studio's binary copy (9) or a binary save (7). */
const kindOf = (b: Buffer) => (b.subarray(0, 8).toString('latin1') !== '<roblox!' ? b.subarray(0, 8).toString('latin1') : b[8] === 9 ? 'copy' : 'saved');

/** `file`: an XML place (.rbxlx, the default) or a binary one (.rbxl). */
async function setup(opts: { menu?: boolean; file?: 'arena.rbxlx' | 'arena.rbxl' } = {}) {
  const { core, ctx } = await makeCore({ respond: async () => null });
  core.orchestrator.pause();
  const placeName = opts.file ?? 'arena.rbxlx';
  const file = join(ctx.root, placeName);
  writeFileSync(file, placeName.endsWith('.rbxl') ? binaryPlace(7) : '<roblox>saved</roblox>');
  ctx.updateExtras({ placeFile: placeName });
  mkdirSync(join(ctx.root, 'world'), { recursive: true });
  writeFileSync(join(ctx.root, 'world', 'Arena.luau'), 'return "built"');
  const lease = new PlaytestLease();
  const w = {
    activity: { idleMs: 10 * 60_000, foreground: 'RobloxStudioBeta' } as UserActivity | null,
    menu: { ok: true, message: 'Saved arena.rbxlx.', how: 'menu' } as SavePlaceResult,
    keys: { ok: true, message: 'Saved arena.rbxlx.', how: 'keys' } as SavePlaceResult,
    plays: false,
    pressed: [] as number[],
    keyed: [] as boolean[],
    ran: [] as string[],
    pushed: 0,
    held: 0,
    parts: 500,
    working: false,
  };
  const autosaves = mkdtempSync(join(tmpdir(), 'shuriken-autosaves-'));
  const logs = mkdtempSync(join(tmpdir(), 'shuriken-studiologs-'));
  const studio = {
    connected: true,
    binding: placeName,
    state: async () => ({ availableDataModels: w.plays ? ['Edit', 'Server', 'Client'] : ['Edit'] }),
    luauJson: async () => ({ parts: w.parts }),
    runLuau: async (code: string) => {
      w.ran.push(code);
      return { ok: true, output: 'ok', durationMs: 1 };
    },
  } as never;
  const guard = new PlaceGuard({
    project: () => ctx,
    studio,
    lease,
    bus: core.bus,
    log: core.log,
    autoSave: () => true,
    pushCode: async () => {
      w.pushed++;
      return { created: [], updated: [] };
    },
    working: () => w.working,
    hold: (p) => {
      w.held++;
      void p;
    },
    autoSavesDir: autosaves,
    studioLogsDir: logs,
    activity: async () => w.activity,
    save: async (_f, unattended) => {
      w.keyed.push(unattended);
      return w.keys;
    },
    menuSave:
      opts.menu === false
        ? undefined
        : async (_f, minIdleMs) => {
            w.pressed.push(minIdleMs);
            return w.menu;
          },
  });
  const events = (kind: string) => ctx.audit.timeline({ limit: 100 }).filter((e) => e.kind === kind);
  const chat = () => core.director.chat()!.list().map((m) => `${m.kind}: ${m.text}`);
  return { core, ctx, file, placeName, lease, guard, w, autosaves, logs, events, chat };
}

/**
 * The guard's own recovery with Windows and Studio played by the test: Studio is gone (`world.gone`) until it opens
 * the place, `world.opened` says what each open found in the place file, `world.fails` opens fail first, and
 * `world.procs` is the process list (a window that turned into the published game).
 */
function recoveryOf(h: Awaited<ReturnType<typeof setup>>, world: { gone: boolean; opened: string[]; fails: number; procs?: StudioProcess[] }) {
  const { core, ctx, guard, logs, placeName } = h;
  const studio = { connected: true, binding: placeName, reopening: null as unknown, link: null, listStudios: async () => (world.gone ? [] : [{ id: 's1', name: placeName }]), bind: () => undefined, capturesBack: () => undefined, onGone: null, onCaptureDead: null, capturesDeadSince: null, captureFailRounds: 0 };
  return new StudioRecovery({
    project: () => ctx,
    studio: studio as never,
    bus: core.bus,
    log: core.log,
    working: () => true,
    reopened: (c, how) => (guard.recovery as unknown as { d: { reopened: (c: unknown, h: unknown) => Promise<unknown> } }).d.reopened(c, how),
    recover: (c, f) => guard.recoverCopy(c, f),
    crashReason: (f) => studioCrashReason(f, logs),
    windowState: async () => (world.gone ? 'none' : 'open'),
    procs: async () => world.procs ?? [],
    open: async (f) => {
      world.opened.push(kindOf(readFileSync(f)));
      if (world.fails-- > 0) throw new Error('Studio did not report an instance');
      world.gone = false;
      return { name: placeName };
    },
  });
}

describe("saving the place through Studio's File menu", () => {
  it('saves in the middle of a playtest without a turn in Studio’s line, and never sends a key', async () => {
    const { guard, lease, w, events } = await setup();
    lease.tryAcquire('run_playing');
    w.plays = true;
    guard.checkpoint();
    const r = await guard.saveNow('periodic');
    expect(r).toMatchObject({ ok: true, how: 'menu' });
    expect(w.pressed).toEqual([0]); // nobody at the PC: no pause to wait for
    expect(w.keyed).toEqual([]);
    expect(lease.holder?.owner).toBe('run_playing');
    expect(lease.waiting).toBe(0);
    expect(guard.unsaved).toBe(false);
    expect(events('place.saved')).toHaveLength(1);
  });

  it('with someone working in another app it waits until the changes are old enough, then saves at a pause in their typing', async () => {
    const { guard, w, events } = await setup();
    w.activity = { idleMs: 400, foreground: 'Code' };
    guard.checkpoint();
    const first = await guard.saveNow('periodic');
    expect(first).toMatchObject({ ok: false, waiting: true });
    expect(first.message).toMatch(/^Waiting: you are working in another app; the place is saved once its changes are 20 minutes old/);
    expect(w.pressed).toEqual([]);
    expect(events('place.save.failed')).toHaveLength(0);

    // Old enough: the menu is pressed, at a pause of PLACE_SAVE.pauseMs.
    Object.assign(PLACE_SAVE, { busyEveryMs: 0 });
    w.menu = { ok: false, waiting: true, message: 'Waiting: for a pause in your typing (the save opens a menu in Studio for a moment).' };
    expect(await guard.saveNow('periodic')).toMatchObject({ ok: false, waiting: true });
    expect(w.pressed).toEqual([PLACE_SAVE.pauseMs]);
    expect(events('place.save.failed')).toHaveLength(0);
    // No pause came: looked at again at the very next tick, not two minutes later.
    await guard.tick();
    expect(w.pressed).toHaveLength(2);
    w.menu = { ok: true, message: 'Saved arena.rbxlx.', how: 'menu' };
    await guard.tick();
    expect(w.pressed).toHaveLength(3);
    expect(guard.unsaved).toBe(false);
    expect(w.keyed).toEqual([]);

    // The user pressing Save does not wait for a pause (their click is the latest input).
    guard.checkpoint();
    expect((await guard.saveNow('user', true)).ok).toBe(true);
    expect(w.pressed.at(-1)).toBe(0);
  });

  it('uses Ctrl+S, with everything that guards it, in a Studio that has no such menu', async () => {
    const { guard, lease, w } = await setup();
    w.menu = { ok: false, noMenu: true, message: "Studio's File menu could not be used (no File menu)." };
    guard.checkpoint();
    // Behind a playtest the keys wait, as they always did.
    lease.tryAcquire('run_playing');
    const waiting = await guard.saveNow('periodic');
    expect(waiting.message).toMatch(/Studio is in a playtest; the save waits for a quieter moment/);
    expect(w.keyed).toEqual([]);
    lease.release('run_playing');
    expect((await guard.saveNow('periodic')).ok).toBe(true);
    expect(w.keyed).toEqual([true]);
    expect(lease.holder).toBeNull();
  });

  it('a menu that worked in this Studio and fails once is tried again soon, never swapped for Ctrl+S (Windows refuses the focus)', async () => {
    const { guard, w, events } = await setup();
    guard.checkpoint();
    expect((await guard.saveNow('periodic')).ok).toBe(true);
    // The menu didn't open this time (a dialog over it, Studio busy).
    w.menu = { ok: false, noMenu: true, menuNote: 'the File menu has no Save to File', message: "Studio's File menu could not be used (the File menu has no Save to File)." };
    guard.checkpoint();
    const again = await guard.saveNow('periodic');
    expect(again).toMatchObject({ ok: false, waiting: true });
    expect(again.message).toMatch(/^Waiting: Studio's File menu did not open for the save a moment ago \(the File menu has no Save to File\); trying again shortly/);
    expect(w.keyed).toEqual([]);
    expect(events('place.save.failed')).toHaveLength(0);
    // Asked again within a minute, through the menu.
    w.menu = { ok: true, message: 'Saved arena.rbxlx.', how: 'menu' };
    (guard as unknown as { lastAttempt: number }).lastAttempt -= 31_000;
    (guard as unknown as { lastSave: number }).lastSave = 0;
    await guard.tick();
    expect(guard.unsaved).toBe(false);
    expect(w.keyed).toEqual([]);
  });

  it('a save that fails through the menu is a failure, said like any other', async () => {
    const { guard, w, events } = await setup();
    w.menu = { ok: false, message: 'File > Save to File was pressed in Studio but arena.rbxlx did not change: Studio shows a dialog ("Save changes?"). Answer it in Studio; saves work again after that.' };
    guard.checkpoint();
    expect((await guard.saveNow('periodic')).ok).toBe(false);
    expect(events('place.save.failed')).toHaveLength(1);
    expect(w.keyed).toEqual([]);
  });

  it('says once, with the reason, that a place has been unsaved for long', async () => {
    const { guard, w, events } = await setup();
    w.activity = { idleMs: 400, foreground: 'Code' };
    guard.checkpoint();
    await guard.saveNow('periodic');
    await guard.tick();
    expect(events('place.save.late')).toHaveLength(0);
    Object.assign(PLACE_SAVE, { lateMs: 0 });
    await guard.tick();
    await guard.tick();
    const late = events('place.save.late');
    expect(late).toHaveLength(1);
    expect(late[0]!.title).toMatch(/^The place has not been saved for \d+ min: Waiting: you are working in another app/);
    // A save that works starts it over.
    w.activity = { idleMs: 10 * 60_000, foreground: 'Code' };
    await guard.saveNow('periodic');
    expect(guard.unsaved).toBe(false);
    guard.checkpoint();
    w.activity = { idleMs: 400, foreground: 'Code' };
    await guard.saveNow('periodic');
    await guard.tick();
    expect(events('place.save.late')).toHaveLength(2);
  });
});

/** Marks the place as having unsaved changes (what a world change does), without a save scheduled behind it. */
const touch = (guard: PlaceGuard) => (guard as unknown as { touched(): void }).touched();

describe('a place that Studio left a recovery copy of', () => {
  it("never puts Studio's binary recovery copy in an XML place file's stead (Studio would save it only through Save As)", async () => {
    const { guard, ctx, file, autosaves } = await setup();
    const savedAt = Date.now() - 3 * 60 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    const copy = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(copy, BINARY_PLACE);
    expect(guard.recoverCopy(ctx, file)).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('<roblox>saved</roblox>');
    expect(existsSync(join(ctx.dir, 'backups')) ? readdirSync(join(ctx.dir, 'backups')).filter((f) => f.startsWith('saved-')) : []).toEqual([]);
    // A copy in the place's own format is used: the format is read from the content, not from the copy's name.
    writeFileSync(copy, Buffer.concat([Buffer.from('<roblox version="4">', 'latin1'), Buffer.alloc(1200, 32), Buffer.from('</roblox>', 'latin1')]));
    expect(guard.recoverCopy(ctx, file)).not.toBeNull();
    expect(readFileSync(file, 'latin1').startsWith('<roblox version="4">')).toBe(true);
  });

  it('opens a binary place from the recovery copy when it is newer than the last save, keeps the saved file, and can put it back', async () => {
    const { guard, ctx, file, autosaves } = await setup({ file: 'arena.rbxl' });
    const savedAt = Date.now() - 3 * 60 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    // None: the place opens as it was saved.
    expect(guard.recoverCopy(ctx, file)).toBeNull();
    // Older than the save, or not a whole place file: not used.
    const copy = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(copy, BINARY_PLACE);
    utimesSync(copy, new Date(savedAt - 60_000), new Date(savedAt - 60_000));
    expect(guard.recoverCopy(ctx, file)).toBeNull();
    const cut = join(autosaves, 'arena_AutoRecovery_1.rbxl');
    writeFileSync(cut, BINARY_PLACE.subarray(0, 900));
    expect(guard.recoverCopy(ctx, file)).toBeNull();
    writeFileSync(cut, 'x');
    utimesSync(cut, new Date(savedAt - 120_000), new Date(savedAt - 120_000));
    // Another place's copy is not this one's.
    writeFileSync(join(autosaves, 'arena2_AutoRecovery_0.rbxl'), BINARY_PLACE);
    expect(guard.recoverCopy(ctx, file)).toBeNull();

    // Newer: it takes the place file's stead.
    const copyAt = Date.now() - 19 * 60_000;
    utimesSync(copy, new Date(copyAt), new Date(copyAt));
    const r = guard.recoverCopy(ctx, file)!;
    expect(r).not.toBeNull();
    expect(Math.abs(r.copyAt - copyAt)).toBeLessThan(2000);
    expect(Math.abs(r.savedAt - savedAt)).toBeLessThan(2000);
    expect(kindOf(readFileSync(file))).toBe('copy');
    const kept = readdirSync(join(ctx.dir, 'backups')).filter((f) => f.startsWith('saved-'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^saved-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.rbxl$/);
    expect(kindOf(readFileSync(join(ctx.dir, 'backups', kept[0]!)))).toBe('saved');
    // The copy is the place now: not taken a second time.
    expect(guard.recoverCopy(ctx, file)).toBeNull();
    // It did not open: the saved file is back, with its own time.
    r.undo();
    expect(kindOf(readFileSync(file))).toBe('saved');
    expect(Math.abs(statSync(file).mtimeMs - savedAt)).toBeLessThan(2000);
  });

  it('reads why Studio closed from the end of its log, for this place only', async () => {
    const { file, logs } = await setup();
    expect(studioCrashReason(file, logs)).toBe('');
    writeFileSync(join(logs, '0.741_20261002T170647Z_Studio_AAAAA_last.log'), `x [telemetryLog] DmId: 1-C:/p/other/other.rbxlx-PlayServer\n2026 [LOGCHANNELS + 1] RBXCRASH: Something else\n`);
    expect(studioCrashReason(file, logs)).toBe('');
    writeFileSync(join(logs, '0.741_20261002T180000Z_Studio_BBBBB_last.log'), `${'filler line\n'.repeat(40_000)}x [telemetryLog] DmId: 1-C:/p/arena/arena.rbxlx-PlayServer\r\n2026-10-02T19:09:48.635Z,7381.6,66fc,6 [LOGCHANNELS + 1] RBXCRASH: Ran out of remap ids, increase max count\r\n2026 [FLog::X] after\r\n`);
    expect(studioCrashReason(file, logs)).toBe('Studio crashed: "Ran out of remap ids, increase max count"');
    // A log from long ago is not the log of the Studio that just closed.
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(logs, '0.741_20261002T180000Z_Studio_BBBBB_last.log'), old, old);
    expect(studioCrashReason(file, logs)).toBe('');
    expect(studioCrashReason(file, join(logs, 'missing'))).toBe('');
  });

  it('after a crash with unsaved work: reopens from the copy, rebuilds the world, pushes the code, holds the team, saves, and says it once', async () => {
    const h = await setup({ file: 'arena.rbxl' });
    const { ctx, guard, file, autosaves, logs, w, events, chat } = h;
    ctx.updateSettings({ robloxStudioMatch: 'arena.rbxl' });
    const savedAt = Date.now() - 3 * 60 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    const copy = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(copy, BINARY_PLACE);
    const copyAt = Date.now() - 19 * 60_000;
    utimesSync(copy, new Date(copyAt), new Date(copyAt));
    writeFileSync(join(logs, '0.741_Studio_CCCCC_last.log'), 'DmId: 1-C:/p/arena/arena.rbxl-Edit\n[LOGCHANNELS + 1] RBXCRASH: Ran out of remap ids, increase max count\n');
    touch(guard);
    w.menu = { ok: false, waiting: true, message: 'Waiting: Studio has "Save to File" switched off for arena.rbxl right now; the save is tried again in a moment.' };
    await guard.saveNow('periodic');
    w.menu = { ok: true, message: 'Saved arena.rbxl.', how: 'menu' };
    w.pressed.length = 0;

    const world = { gone: true, opened: [] as string[], fails: 0 };
    const recovery = recoveryOf(h, world);
    expect(await recovery.check()).toBe(true);
    // It opened Studio's copy, not the three-hour-old save.
    expect(world.opened).toEqual(['copy']);
    // The world's build scripts ran, the code was pushed, the team was held, and the place was saved.
    expect(w.ran.some((c) => c.includes('return "built"'))).toBe(true);
    expect(w.pushed).toBe(1);
    expect(w.held).toBe(1);
    expect(w.pressed).toEqual([0]);
    expect(guard.unsaved).toBe(false);
    const gone = events('studio.gone');
    expect(gone[0]!.title).toMatch(/Roblox Studio closed while the team was working \(Studio crashed: "Ran out of remap ids, increase max count"\); reopening arena\.rbxl/);
    expect(events('place.recovered')).toHaveLength(1);
    expect(events('place.restored')[0]!.title).toMatch(/^Studio came back as Studio's recovery copy of \d\d:\d\d:\d\d: Rebuilt the world \(1 of 1 build scripts worked\) and pushed the code from the files$/);
    const lines = chat();
    expect(lines.some((l) => /I reopened arena\.rbxl from Studio's recovery copy of \d\d:\d\d:\d\d, reconnected and checked the place\. The team carries on\.$/.test(l))).toBe(true);
    expect(lines.filter((l) => /Studio closed with work that was not saved, and the place came back as Studio's recovery copy of \d\d:\d\d:\d\d\. Rebuilt the world \(1 of 1 build scripts worked\) and put the code back from the files\./.test(l))).toHaveLength(1);
    recovery.stop();
  });

  it("after a crash of an XML place with unsaved work: opens it as it was last saved (never Studio's binary copy) and puts the world and the code back", async () => {
    const h = await setup();
    const { ctx, guard, file, autosaves, w, events, chat } = h;
    ctx.updateSettings({ robloxStudioMatch: 'arena.rbxlx' });
    const savedAt = Date.now() - 3 * 60 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    const copy = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(copy, BINARY_PLACE);
    utimesSync(copy, new Date(Date.now() - 19 * 60_000), new Date(Date.now() - 19 * 60_000));
    touch(guard);
    const world = { gone: true, opened: [] as string[], fails: 0 };
    const recovery = recoveryOf(h, world);
    expect(await recovery.check()).toBe(true);
    expect(world.opened).toEqual(['<roblox>']);
    expect(readFileSync(file, 'utf8')).toBe('<roblox>saved</roblox>');
    expect(events('place.recovered')).toHaveLength(0);
    expect(w.ran.some((c) => c.includes('return "built"'))).toBe(true);
    expect(w.pushed).toBe(1);
    expect(w.held).toBe(1);
    expect(events('place.restored')[0]!.title).toMatch(/^Studio came back as it was last saved: Rebuilt the world \(1 of 1 build scripts worked\)/);
    expect(chat().some((l) => /I reopened arena\.rbxlx, reconnected and checked the place\. The team carries on\.$/.test(l))).toBe(true);
    // Nothing in the chat about the file's format: it is the XML it always was.
    expect(chat().join('\n')).not.toMatch(/Save As/);
    recovery.stop();
  });

  it('opens the place as it was saved when the recovery copy does not open, and leaves a saved place alone', async () => {
    const h = await setup({ file: 'arena.rbxl' });
    const { ctx, file, autosaves, w, events } = h;
    ctx.updateSettings({ robloxStudioMatch: 'arena.rbxl' });
    const savedAt = Date.now() - 60 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    const copy = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(copy, BINARY_PLACE);
    const world = { gone: true, opened: [] as string[], fails: 2 };
    const recovery = recoveryOf(h, world);
    expect(await recovery.check()).toBe(true);
    // Two tries with the copy, then the saved file.
    expect(world.opened).toEqual(['copy', 'copy', 'saved']);
    expect(kindOf(readFileSync(file))).toBe('saved');
    // Nothing was known to be unsaved and no copy was used: the world is not rebuilt for nothing.
    expect(w.ran).toEqual([]);
    expect(w.pushed).toBe(0);
    expect(events('place.restored')).toHaveLength(0);
    recovery.stop();
    expect(existsSync(copy)).toBe(true);
  });
});

// 2026-10-07: the user published from the team's window; Shuriken reopened the local file and, taking it for a crash,
// rebuilt the world from 35 build scripts for 13 minutes with the team held, over a recovery copy ten minutes old.
describe('the window turned into the published game (a publish, not a crash)', () => {
  const published = (file: string): StudioProcess[] => [{ pid: 7, startedAt: Date.now() - 3600_000, title: 'Voxel Pit - Roblox Studio', responding: true, commandLine: `"RobloxStudioBeta.exe" "${file}"` }];

  it('reopens the local file from a copy in its own format, puts the code in from the files, rebuilds nothing, and says so in one line', async () => {
    const h = await setup({ file: 'arena.rbxl' });
    const { ctx, guard, file, autosaves, w, events, chat } = h;
    ctx.updateSettings({ robloxStudioMatch: 'arena.rbxl' });
    const savedAt = Date.now() - 50 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    const copy = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(copy, BINARY_PLACE);
    utimesSync(copy, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    touch(guard);
    const world = { gone: true, opened: [] as string[], fails: 0, procs: published(file) };
    const recovery = recoveryOf(h, world);
    expect(await recovery.check()).toBe(true);
    expect(world.opened).toEqual(['copy']);
    // No world rebuild, no team held: the code went in the way every sync puts it.
    expect(w.ran.some((c) => c.includes('return "built"'))).toBe(false);
    expect(w.pushed).toBe(1);
    expect(w.held).toBe(0);
    expect(events('place.restored')).toHaveLength(0);
    expect(events('studio.gone')).toHaveLength(0);
    expect(events('studio.place.left')).toHaveLength(1);
    const lines = chat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^status: Studio's window of arena\.rbxl now shows "Voxel Pit" \(you published the place from it, or opened another place in it\)\. That is not a crash, so nothing was rebuilt: I reopened arena\.rbxl from Studio's recovery copy of \d\d:\d\d:\d\d and put the code back from the files\. The team carries on on your local copy; the "Voxel Pit" window is no longer the team's, so close it when you're done with it\.$/,
    );
    recovery.stop();
  });

  it('an XML place told of the publish (afterMove) opens as it was last saved; a world that is missing is rebuilt; a crash after it is a crash again', async () => {
    const h = await setup();
    const { ctx, guard, file, autosaves, w, events, chat } = h;
    ctx.updateSettings({ robloxStudioMatch: 'arena.rbxlx' });
    const savedAt = Date.now() - 50 * 60_000;
    utimesSync(file, new Date(savedAt), new Date(savedAt));
    writeFileSync(join(autosaves, 'arena_AutoRecovery_0.rbxl'), BINARY_PLACE);
    touch(guard);
    w.parts = 3;
    const world = { gone: true, opened: [] as string[], fails: 0 };
    const recovery = recoveryOf(h, world);
    recovery.afterMove('Voxel Pit');
    expect(await recovery.check()).toBe(true);
    // Studio's binary copy never goes into the XML file: the saved file opens.
    expect(world.opened).toEqual(['<roblox>']);
    // The place opened without its world: heal rebuilt it (and pushed the code with it), and only heal.
    expect(w.ran.filter((c) => c.includes('return "built"'))).toHaveLength(1);
    expect(w.pushed).toBe(1);
    expect(events('place.restored')).toHaveLength(0);
    // Two lines: the reopen's, and heal's own about the rebuild.
    expect(chat()).toHaveLength(2);
    expect(chat()[0]).toMatch(
      /^status: Studio's window of arena\.rbxlx now shows "Voxel Pit" \(you published the place from it, or opened another place in it\)\. That is not a crash, but the place opened without its world: I reopened arena\.rbxlx as it was last saved \(\d\d:\d\d:\d\d\), rebuilt its world from the build scripts and put the code back from the files\. The team carries on on your local copy/,
    );
    // The move is handled: Studio going later is a crash, and is put back as one.
    w.parts = 500;
    w.ran.length = 0;
    touch(guard);
    world.gone = true;
    expect(await recovery.check()).toBe(true);
    expect(chat().some((l) => /^status: Roblox Studio closed unexpectedly at \d\d:\d\d:\d\d; I reopened arena\.rbxlx, reconnected and checked the place\. The team carries on\.$/.test(l))).toBe(true);
    expect(events('place.restored')).toHaveLength(1);
    recovery.stop();
  });
});

describe('a place file in the other format than its name', () => {
  it('says once how to fix it, never presses Save into the Save As dialog, and saves again once it is fixed', async () => {
    const { guard, file, w, chat, events } = await setup();
    // What 1.15.7 did: Studio's binary recovery copy put in an .rbxlx file.
    writeFileSync(file, binaryPlace(7));
    touch(guard);
    for (let i = 0; i < 3; i++) {
      const r = await guard.saveNow('periodic');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Waiting: arena\.rbxlx holds Roblox's binary place format although its name ends in \.rbxlx, so Studio won't save it under that name/);
    }
    await guard.tick();
    expect((await guard.saveNow('user', true)).ok).toBe(false);
    expect(w.pressed).toEqual([]);
    expect(w.keyed).toEqual([]);
    const lines = chat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^status: arena\.rbxlx holds Roblox's binary place format although its name ends in \.rbxlx, so Studio won't save it: every save, yours and mine, opens a Save As dialog\./);
    expect(lines[0]).toMatch(/press Ctrl\+S in Studio, and in the Save As dialog keep the same folder and file name, pick "Roblox XML Place \(\*\.rbxlx\)" as the type, and confirm that it replaces the file\. Until then I don't press Save/);
    expect(events('place.format')).toHaveLength(1);
    expect(events('place.save.failed')).toHaveLength(0);
    // The user saved it as XML: saves go on, through the menu.
    writeFileSync(file, '<roblox version="4"></roblox>');
    expect((await guard.saveNow('periodic')).ok).toBe(true);
    expect(w.pressed).toEqual([0]);
    expect(chat()).toHaveLength(1);
  });

  it('names the binary type for XML in an .rbxl, and a file that is what its name says is left alone', async () => {
    const { guard, ctx, file, chat } = await setup({ file: 'arena.rbxl' });
    expect(guard.checkFormat(ctx)).toBeNull();
    writeFileSync(file, '\uFEFF<?xml version="1.0"?><roblox version="4"></roblox>');
    expect(guard.checkFormat(ctx)).toMatchObject({ has: 'xml', want: 'binary' });
    expect(chat()[0]).toMatch(/pick the binary "Roblox Place \(\*\.rbxl\)" as the type/);
    expect(placeFormatMismatch(file)).toEqual({ has: 'xml', want: 'binary' });
    writeFileSync(file, 'not a place');
    expect(placeFormatMismatch(file)).toBeNull();
  });
});

describe('what is said about saves that fail', () => {
  it('a Studio the user closed while the team is paused is said once, in plain words, and is no failure', async () => {
    const { guard, w, chat, events } = await setup();
    w.menu = { ok: false, noWindow: true, message: 'No Studio window has arena.rbxlx open.' };
    touch(guard);
    for (let i = 0; i < 6; i++) await guard.saveNow('periodic');
    const lines = chat();
    expect(lines).toEqual(["status: Studio isn't open with arena.rbxlx (it was closed while the team is paused), so there is nothing for me to save. That's fine: the place opens again by itself when the team starts working."]);
    expect(events('place.save.failed')).toHaveLength(0);
  });

  it('a save that keeps failing is said once per problem, with no promise to stay quiet, and again only after a save worked and a long while', async () => {
    const { guard, w, chat } = await setup();
    w.working = true;
    const dialog: SavePlaceResult = { ok: false, message: 'File > Save to File was pressed in Studio but arena.rbxlx did not change: Studio shows a dialog ("Save As"). Answer it in Studio; saves work again after that.' };
    w.menu = dialog;
    touch(guard);
    for (let i = 0; i < 8; i++) await guard.saveNow('periodic');
    expect(chat()).toEqual([`status: I couldn't save the place in Studio. ${dialog.message} Studio's recovery copies of the place are backed up in the project meanwhile.`]);
    // While the team works, a window that has no place file in it is another problem (Studio went, or its window turned
    // into the published game): said once too, without "press Ctrl+S".
    w.menu = { ok: false, noWindow: true, message: 'No Studio window has arena.rbxlx open.' };
    for (let i = 0; i < 5; i++) await guard.saveNow('periodic');
    expect(chat()).toHaveLength(2);
    expect(chat()[1]).toBe("status: I couldn't save the place in Studio. No Studio window has arena.rbxlx open. Studio's recovery copies of the place are backed up in the project meanwhile.");
    // A save works; the same problem soon after is not said again...
    w.menu = { ok: true, message: 'Saved arena.rbxlx.', how: 'menu' };
    expect((await guard.saveNow('periodic')).ok).toBe(true);
    w.menu = dialog;
    touch(guard);
    for (let i = 0; i < 5; i++) await guard.saveNow('periodic');
    expect(chat()).toHaveLength(2);
    // ...and after PLACE_SAVE.tellAgainMs it is.
    PLACE_SAVE.tellAgainMs = 0;
    await guard.saveNow('periodic');
    expect(chat()).toHaveLength(3);
    expect(chat().join('\n')).not.toMatch(/mention it again|Ctrl\+S/);
  });

  it("Windows refusing Studio the focus is said once, without a promise to stay quiet", async () => {
    const { guard, w, chat } = await setup({ menu: false });
    w.working = true;
    w.keys = { ok: false, focus: true, message: 'Windows did not bring the Studio window to the front, so no keys were sent. Save it in Studio with Ctrl+S.' };
    touch(guard);
    for (let i = 0; i < 4; i++) await guard.saveNow('user', true);
    const lines = chat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^status: I couldn't bring Studio to the front to save the place \(Windows wouldn't let me\)\..*Press Ctrl\+S in Studio when you get a chance\.$/);
    expect(lines[0]).not.toMatch(/mention it again/);
  });
});

describe('a big place takes longer to reach the disk', () => {
  it('waits 5 s and one more second per 4 MB for the file to change, at most a minute', () => {
    expect(saveWaitMs(1024)).toBe(6000);
    // The mech build's 96 MB place was written about 5 s after the press: every save was reported as failed.
    expect(saveWaitMs(96 * 1024 * 1024)).toBe(29_000);
    expect(saveWaitMs(2 * 1024 * 1024 * 1024)).toBe(60_000);
    expect(saveWaitMs(8 * 1024 * 1024, 15_000)).toBe(17_000);
  });
});

describe('a save still being written', () => {
  it('is not pressed again until the file changes, or ten minutes have passed', () => {
    // In the mech build a save took 214 s; two more presses landed on it and Studio refused one in a dialog.
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-pending-'));
    const file = join(dir, 'game.rbxlx');
    writeFileSync(file, 'v1');
    const t = new Date('2026-10-03T10:00:00Z');
    utimesSync(file, t, t);
    const before = statSync(file).mtimeMs;
    const at = Date.now();
    notePendingSave(file, before, at);
    expect(savePending(file, at + 60_000)).toBe(true);
    // The save reaches the disk: free again.
    const t2 = new Date('2026-10-03T10:03:34Z');
    utimesSync(file, t2, t2);
    expect(savePending(file, at + 214_000)).toBe(false);
    // One that never comes: pressed again after ten minutes.
    notePendingSave(file, statSync(file).mtimeMs, at);
    expect(savePending(file, at + SAVE_PENDING_MS - 1000)).toBe(true);
    expect(savePending(file, at + SAVE_PENDING_MS + 1000)).toBe(false);
  });
});
