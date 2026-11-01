import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { RobloxStudioAdapter } from '../src/core/roblox/studio-adapter';
import { LOGIN_LOCK, hasOpen, logHoldsLoginLock, startedWith, studioLogFor, stuckAtLogin, type StudioProcess } from '../src/core/roblox/studio-login-lock';
import { LOCK_RESTART, STUDIO_RECOVERY, StudioRecovery } from '../src/core/roblox/studio-recovery';
import { ChatService } from '../src/core/director/chat-service';
import type { SavePlaceResult } from '../src/core/roblox/studio-window';
import { coreHarness } from './helpers/make-core';

/**
 * 2 October 2026: a build's Studio took Roblox's login lock when it started and never let go (a Studio fault). Four play
 * windows, a scratch Studio, a plain Studio and the next project's own Studio all hung behind it at their login, and
 * the next project could not build. Nothing here starts a real Studio or reads a real process list.
 */
const saved = { lock: { ...LOGIN_LOCK }, rec: { ...STUDIO_RECOVERY }, restart: { ...LOCK_RESTART } };
afterEach(() => {
  Object.assign(LOGIN_LOCK, saved.lock);
  Object.assign(STUDIO_RECOVERY, saved.rec);
  Object.assign(LOCK_RESTART, saved.restart);
});

/** The lines of a Studio log around its login, as Studio 0.741 writes them. */
const LOG_START = `2026-10-02T21:56:34.603Z,1.603091,8a7c,6 [DFLog::NamedMutex] NamedMutex(0000028F30E99908, name:RobloxStudioCookieManager)
2026-10-02T21:56:34.603Z,1.603091,8a7c,6 [DFLog::NamedMutex] NamedMutex(0000028F2FECC310, name:www.roblox.com-oauth2RefreshToken-Studio)
2026-10-02T21:56:35.325Z,2.325257,8a7c,6,Info [FLog::LoginController] LoginController::login with category 'Local'
`;
const HELD = `${LOG_START}2026-10-02T21:56:35.680Z,2.680054,35cc,6 [DFLog::NamedMutex] ~NamedMutex::unlock(0000028F2FECC310) failed: Attempt to release mutex not owned by caller
2026-10-02T21:56:35.680Z,2.680054,8a7c,6,Info [FLog::LoginController] AuthTokenRefresh, Retrieved new access token for stage: 'AuthenticateOnStartup'
`;
const LET_GO = `${LOG_START}2026-10-02T21:56:35.680Z,2.680054,8a7c,6 [DFLog::NamedMutex] ~NamedMutex(0000028F2FECC310, name:www.roblox.com-oauth2RefreshToken-Studio)
`;
/** Another mutex's failed release is not this lock. */
const OTHER = `${LOG_START}2026-10-02T21:56:35.680Z,2.680054,35cc,6 [DFLog::NamedMutex] ~NamedMutex::unlock(0000028F30E99908) failed: Attempt to release mutex not owned by caller
`;

const proc = (over: Partial<StudioProcess> & { pid: number }): StudioProcess => ({ startedAt: Date.now() - 60_000, title: 'Roblox Studio', responding: true, commandLine: '', ...over });

describe("reading Roblox's login lock from Studio's log (pure)", () => {
  it('knows a Studio that took the lock and could not let go, from one that did, and from another lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-studiologs-'));
    const write = (name: string, text: string) => {
      const f = join(dir, name);
      writeFileSync(f, text, 'utf8');
      return f;
    };
    expect(logHoldsLoginLock(write('0.741.19.7411056_20261002T215633Z_Studio_38AAB_last.log', HELD))).toBe(true);
    expect(logHoldsLoginLock(write('0.741.19.7411056_20261002T221626Z_Studio_83E18_last.log', LET_GO))).toBe(false);
    expect(logHoldsLoginLock(write('0.741.19.7411056_20261002T230527Z_Studio_3EF5E_last.log', OTHER))).toBe(false);
    expect(logHoldsLoginLock(join(dir, 'missing.log'))).toBe(false);
    // A process's log is the one named after the second it started (UTC), within a few seconds.
    expect(basename(studioLogFor(Date.UTC(2026, 9, 2, 21, 56, 33, 598), dir)!)).toBe('0.741.19.7411056_20261002T215633Z_Studio_38AAB_last.log');
    expect(basename(studioLogFor(Date.UTC(2026, 9, 2, 22, 16, 28, 100), dir)!)).toBe('0.741.19.7411056_20261002T221626Z_Studio_83E18_last.log');
    expect(studioLogFor(Date.UTC(2026, 9, 2, 22, 30, 0), dir)).toBeNull();
  });

  it('tells a Studio stuck at its login from one that is loading or has its place open', () => {
    const now = Date.now();
    expect(stuckAtLogin(proc({ pid: 1, responding: false, startedAt: now - 30_000 }), now)).toBe(true);
    expect(stuckAtLogin(proc({ pid: 1, responding: false, startedAt: now - 5000 }), now)).toBe(false);
    expect(stuckAtLogin(proc({ pid: 1, responding: true, startedAt: now - 30_000 }), now)).toBe(false);
    // Busy with its place (a long Luau call): not stuck at login.
    expect(stuckAtLogin(proc({ pid: 1, responding: false, startedAt: now - 30_000, title: 'C:\\p\\arena.rbxlx - Roblox Studio' }), now)).toBe(false);
    expect(hasOpen(proc({ pid: 1, title: 'C:\\Users\\x\\Projects\\arena\\arena.rbxlx - Roblox Studio' }), 'arena.rbxlx')).toBe(true);
    expect(hasOpen(proc({ pid: 1, title: 'Roblox Studio' }), 'arena.rbxlx')).toBe(false);
    expect(startedWith(proc({ pid: 1, commandLine: '"C:\\R\\RobloxStudioBeta.exe" "C:\\p\\arena.rbxlx"' }), 'arena.rbxlx')).toBe(true);
  });
});

/** An adapter whose Studio is played by the test: what is launched, which processes run, which hold the lock. */
class Launcher extends RobloxStudioAdapter {
  launches = 0;
  ended: number[] = [];
  procs: StudioProcess[] = [];
  holders = new Set<number>();
  /** What each launch does: 'locks' (takes the lock and would keep it), 'hangs' (waits at login), 'opens'. */
  plan: Array<'locks' | 'hangs' | 'opens' | 'locks-opens'> = [];
  opened = false;
  nextPid = 100;

  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
    (this as unknown as { install: unknown }).install = { versionFolder: 'C:/Roblox/version-test', studioVersion: 'test', mcpExe: null };
    (this as unknown as { conn: { connect(): Promise<void> } }).conn = { connect: async () => undefined };
  }
  override get connected(): boolean {
    return true;
  }
  override async listStudios(): Promise<Array<{ id: string; name: string }>> {
    return this.opened ? [{ id: 's1', name: 'arena.rbxlx' }] : [];
  }
  protected override launchStudio(_exe: string, file: string): void {
    const what = this.plan[this.launches++] ?? 'opens';
    const pid = this.nextPid++;
    this.procs.push(proc({ pid, startedAt: Date.now(), responding: what !== 'hangs', commandLine: `"RobloxStudioBeta.exe" "${file}"` }));
    if (what === 'locks' || what === 'locks-opens') this.holders.add(pid);
    if (what === 'opens' || what === 'locks-opens') setTimeout(() => (this.opened = true), 3000);
  }
  protected override async placeWindowOpen(): Promise<boolean> {
    return false;
  }
  protected override async studioProcs(): Promise<StudioProcess[]> {
    return this.procs.filter((p) => !this.ended.includes(p.pid));
  }
  protected override holdsLock(p: StudioProcess): boolean {
    return this.holders.has(p.pid);
  }
  protected override endProc(pid: number): boolean {
    this.ended.push(pid);
    this.opened = false;
    return true;
  }
}

const place = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'shuriken-lock-')), 'arena.rbxlx');
  writeFileSync(file, '<roblox/>', 'utf8');
  return file;
};

describe('a Studio Shuriken starts', () => {
  it('that opens its place within seconds and kept the lock (both cases of 2 October) is started again before it is used', async () => {
    Object.assign(LOGIN_LOCK, { checkAfterMs: 4000, stuckAfterMs: 0 });
    const studio = new Launcher();
    studio.plan = ['locks-opens', 'opens'];
    expect(await studio.openPlace(place(), 'arena.rbxlx', 40_000)).toEqual({ id: 's1', name: 'arena.rbxlx' });
    expect(studio.launches).toBe(2);
    expect(studio.ended).toEqual([100]);
    // One that opens and did not keep the lock is used as it is.
    const clean = new Launcher();
    clean.plan = ['opens'];
    await clean.openPlace(place(), 'arena.rbxlx', 40_000);
    expect(clean.launches).toBe(1);
    expect(clean.ended).toEqual([]);
  }, 60_000);

  it('is started again at once when it took the login lock and would keep it, and then opens the place', async () => {
    Object.assign(LOGIN_LOCK, { checkAfterMs: 0, stuckAfterMs: 0 });
    const studio = new Launcher();
    studio.plan = ['locks', 'opens'];
    expect(await studio.openPlace(place(), 'arena.rbxlx', 30_000)).toEqual({ id: 's1', name: 'arena.rbxlx' });
    expect(studio.launches).toBe(2);
    expect(studio.ended).toEqual([100]);
  }, 30_000);

  it('hanging at login behind another Studio: says which one holds the lock, and is ended when it never opens', async () => {
    Object.assign(LOGIN_LOCK, { checkAfterMs: 0, stuckAfterMs: 0 });
    const studio = new Launcher();
    const told: Array<{ holder: number; stuck: number }> = [];
    studio.onLoginLock = ({ holder, stuck }) => told.push({ holder: holder.pid, stuck: stuck.pid });
    studio.procs.push(proc({ pid: 7, title: 'C:\\p\\rts\\rts.rbxlx - Roblox Studio' }));
    studio.holders.add(7);
    studio.plan = ['hangs'];
    await expect(studio.openPlace(place(), 'arena.rbxlx', 9000)).rejects.toThrow(/hung at its login because another Studio \("rts\.rbxlx - Roblox Studio"\) holds Roblox's login lock \(a Studio fault\)\. That Studio has to be closed and opened again; the hung one was ended\./);
    expect(told).toEqual([{ holder: 7, stuck: 100 }]);
    // The hung one is ended; the Studio that holds the lock is not (it has the user's or another project's place).
    expect(studio.ended).toEqual([100]);
  }, 30_000);
});

describe("a project's own Studio that holds the login lock", () => {
  const makeCore = coreHarness();
  async function setup() {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    writeFileSync(join(h.root, 'arena.rbxlx'), '<roblox/>', 'utf8');
    h.ctx.updateExtras({ placeFile: 'arena.rbxlx' });
    h.ctx.updateSettings({ robloxStudioMatch: 'arena.rbxlx' });
    (h.core.studio as unknown as { studioMatch: string }).studioMatch = 'arena.rbxlx';
    Object.defineProperty(h.core.studio, 'connected', { get: () => true, configurable: true });
    const w = {
      procs: [proc({ pid: 7, title: `${join(h.root, 'arena.rbxlx')} - Roblox Studio` })] as StudioProcess[],
      holders: new Set<number>([7]),
      save: { ok: true, message: 'Saved arena.rbxlx.' } as SavePlaceResult,
      did: [] as string[],
      gone: false,
    };
    (h.core.studio as unknown as { listStudios: () => Promise<Array<{ id: string; name: string }>> }).listStudios = async () => (w.gone ? [] : [{ id: 's1', name: 'arena.rbxlx' }]);
    const recovery = new StudioRecovery({
      project: () => h.core.project,
      studio: h.core.studio,
      bus: h.core.bus,
      log: h.core.logger.scope('test'),
      working: () => true,
      reopened: async () => void w.did.push('checked'),
      lease: h.core.lease,
      save: async () => {
        w.did.push(`save (held by ${h.core.lease.holder?.owner})`);
        return w.save;
      },
      close: async (name) => {
        w.did.push(`close ${name}`);
        w.gone = true;
        return 'closed';
      },
      open: async (file) => {
        w.did.push('open');
        w.gone = false;
        return { name: basename(file) };
      },
      procs: async () => w.procs,
      holdsLock: (p) => w.holders.has(p.pid),
    });
    const chat = () => new ChatService(h.ctx, h.core.bus).list().map((m) => m.text);
    return { ...h, recovery, w, chat };
  }

  it('is saved, closed and reopened when another Studio hangs behind it, and says so once', async () => {
    Object.assign(STUDIO_RECOVERY, { tries: 2, openMs: 200, retryMs: 5 });
    const { recovery, w, chat, ctx } = await setup();
    // Nobody waits behind it: it is left alone.
    expect(await recovery.letGoOfLoginLock()).toBe('skipped');
    expect(w.did).toEqual([]);
    // Another project's Studio hangs at its login.
    w.procs.push(proc({ pid: 9, responding: false }));
    expect(await recovery.letGoOfLoginLock()).toBe('reopened');
    expect(w.did).toEqual(['save (held by refresh)', 'close arena.rbxlx', 'open', 'checked']);
    const lines = chat();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Another Studio could not start: this project's Studio holds Roblox's login lock \(a fault in Studio: .*\)\. I saved the place and reopened arena\.rbxlx: the lock is free, the Studio that waited can start, and the team carries on\.$/);
    expect(ctx.audit.timeline({ limit: 20 }).filter((e) => e.kind === 'studio.login.lock').map((e) => e.severity)).toEqual(['success', 'warning']);
    // Not again right away.
    expect(await recovery.letGoOfLoginLock()).toBe('skipped');
  });

  it('is not closed when the place could not be saved first', async () => {
    const { recovery, w, chat } = await setup();
    w.procs.push(proc({ pid: 9, responding: false }));
    w.save = { ok: false, message: 'Studio is in a playtest that is not the team’s' };
    expect(await recovery.letGoOfLoginLock()).toBe('failed');
    expect(w.did).toEqual(['save (held by refresh)']);
    expect(chat()[0]).toMatch(/Reopening arena\.rbxlx would free it, but I couldn't save the place first/);
  });
});
