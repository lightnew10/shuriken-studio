import { trustedMainFrame, trustedRendererUrl } from './trusted-url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, powerSaveBlocker, safeStorage, screen, shell, utilityProcess, WebContentsView, type UtilityProcess, type WebContents } from 'electron';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, normalize } from 'node:path';
import { Updater } from './updater';
import { KilnDocks } from './kiln-dock';
import { ensureKiln, findKilnExe, readKilnRuntime } from './kiln-host';
import { SessionJournal, markUnfinishedSessions } from './session-journal';
import { release } from 'node:os';
import type { StripState, TabInfo } from '../preload/api';
import type { RenderRequest } from '../shared/render';
import type { ForgeGLRequest, ForgeGLResponse } from '../shared/forge-plan';
import type { MediaRequest } from '../shared/references';
import { MediaHost, registerMediaScheme } from './media-decoder';
import { repointShortcuts, shortcutFolders } from './shortcuts';

/**
 * Electron main process: thin and stable. App windows show projects as project windows docked along
 * a bar at the top (they can be pulled out into app windows of their own and docked back); every
 * project window is a workspace with its own page and core engine (utilityProcess), so projects build
 * independently. Main supervises the cores, routes each page's RPC and events to its own core, and
 * owns OS integration (dialogs, shell, secure storage). All product logic lives in core.
 */

const APP_NAME = 'Shuriken Studio';
app.setName(APP_NAME);
// The installed app's id (the installer's shortcuts carry it). Dev, smoke and test runs (electron.exe)
// get their own, or Windows files the installed app's taskbar button under "Electron" with no icon.
const AUMID = app.isPackaged && !process.argv.includes('--smoke') ? 'com.shurikenstudio.app' : 'com.shurikenstudio.app.dev';
if (process.platform === 'win32') app.setAppUserModelId(AUMID);

/** Windows: this window's taskbar button is Shuriken Studio's, with its icon, whatever Windows cached for the id. */
function taskbarIdentity(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  if (app.isPackaged) win.setAppDetails({ appId: AUMID, appIconPath: process.execPath, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: APP_NAME });
  else win.setAppDetails({ appId: AUMID, appIconPath: resolve(import.meta.dirname, '..', '..', 'build', 'icon.ico'), appIconIndex: 0 });
}

// SHURIKEN_DATA_DIR isolates state for automated runs (smoke tests, CI) from the user's real data.
// Smoke runs are always isolated: without SHURIKEN_DATA_DIR they get their own folder next to the output.
if (process.env.SHURIKEN_DATA_DIR) app.setPath('userData', process.env.SHURIKEN_DATA_DIR);
else if (process.argv.includes('--smoke')) {
  const out = process.argv.indexOf('--smoke-out');
  app.setPath('userData', out >= 0 && process.argv[out + 1] ? `${process.argv[out + 1]}-data` : join(app.getPath('temp'), `shuriken-smoke-${process.pid}`));
}
const userData = app.getPath('userData');
// New projects from a smoke run (start page, Open blank) stay in its folder, not the user's Documents.
if (process.argv.includes('--smoke')) process.env.SHURIKEN_PROJECTS_DIR ??= join(userData, 'projects');
const logDir = join(userData, 'logs');
mkdirSync(logDir, { recursive: true });
const smoke = process.argv.includes('--smoke');
const smokeOut = (() => {
  const i = process.argv.indexOf('--smoke-out');
  return i >= 0 ? process.argv[i + 1] : join(userData, 'smoke');
})();

// A second launch (the desktop shortcut while the app runs, maybe another installed version) hands
// its command line to the running app ('second-instance') and leaves before doing anything: no
// session journal (which would mark the running session abandoned), no core, no window.
const secondary = !smoke && !app.requestSingleInstanceLock();
if (secondary) app.exit(0);

// Every app session is journaled for later review (see docs/SESSIONS.md). Smoke runs are not user sessions.
const journal = smoke || secondary ? null : new SessionJournal(join(userData, 'sessions'), { appVersion: app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${release()}`, packaged: app.isPackaged });
if (journal) markUnfinishedSessions(join(userData, 'sessions'), journal.id);

/**
 * Mirroring to the console stops for good once its pipe is gone (the terminal that started the app
 * closed): the write would throw EPIPE, which lands in the uncaughtException handler, which logs, which
 * writes to the console again — a loop that once wrote 159 MB of log in under a minute.
 */
let consoleOk = true;
for (const stream of [process.stdout, process.stderr]) stream?.on?.('error', () => (consoleOk = false));

function mainLog(level: string, msg: string, data?: unknown): void {
  if (level === 'error') journal?.error('main', msg, data instanceof Error ? data.stack ?? data.message : data);
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope: 'main', msg, data: data instanceof Error ? { message: data.message, stack: data.stack } : data });
  try {
    appendFileSync(join(logDir, `main-${new Date().toISOString().slice(0, 10)}.jsonl`), line + '\n');
  } catch {
    /* ignore */
  }
  if (consoleOk && (level === 'error' || !app.isPackaged)) {
    try {
      console.log(line);
    } catch {
      consoleOk = false;
    }
  }
}

/** The same error over and over (a loop somewhere) is logged 20 times, then once more when it stops. */
const repeats = { key: '', n: 0, at: 0 };
/** Uncaught errors so far (a smoke run reports them: none is the pass mark). */
const uncaughtSeen: string[] = [];
function logUncaught(kind: string, e: unknown): void {
  if ((e as NodeJS.ErrnoException | null)?.code === 'EPIPE') {
    consoleOk = false; // a closed console, not a crash
    return;
  }
  if (uncaughtSeen.length < 50) uncaughtSeen.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
  const key = `${kind}:${e instanceof Error ? e.message : String(e)}`;
  const now = Date.now();
  if (key === repeats.key && now - repeats.at < 10_000) {
    repeats.n++;
    repeats.at = now;
    if (repeats.n > 20) return;
  } else {
    if (repeats.n > 20) mainLog('warn', `previous error repeated ${repeats.n - 20} more times`, repeats.key.slice(0, 300));
    Object.assign(repeats, { key, n: 1, at: now });
  }
  mainLog('error', kind, e);
}

process.on('uncaughtException', (e) => logUncaught('uncaughtException', e));
process.on('unhandledRejection', (e) => logUncaught('unhandledRejection', e));

if (smoke) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// The windows' JavaScript gets room for a big project (long chats, big task lists, 3D previews): 8 GB of heap each.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
process.on('exit', (code) => {
  try {
    appendFileSync(join(logDir, `main-${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', scope: 'main', msg: 'process exit', data: { code, smoke } })}\n`);
  } catch {
    /* ignore */
  }
});


// ─── Core supervisor ─────────────────────────────────────────────────────────

type CoreStatus = { state: 'starting' | 'ready' | 'restarting' | 'failed'; detail?: string; mcpUrl?: string };

class CoreSupervisor {
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly queue: Array<{ id: number; method: string; params: unknown }> = [];
  private ready = false;
  private restarts: number[] = [];
  private stopping = false;
  private shareCount = 1;
  private elsewhere = 0;
  status: CoreStatus = { state: 'starting' };
  onEvent: (channel: string, payload: unknown) => void = () => {};
  onStatus: (s: CoreStatus) => void = () => {};

  /** `openProject`: what this window's core opens at startup ('last', a project id, or nothing). */
  constructor(private openProject: string | null | 'last' | 'blank') {}

  start(): void {
    this.ready = false;
    const entry = join(import.meta.dirname, 'core.js');
    // A smoke run's core makes no model calls of its own (the suggestion bubbles).
    // A big project's core holds a lot (200 MB databases, big task lists, uploads in flight): 16 GB of heap before V8 has to collect hard.
    // --smoke-profile also profiles the core (core.cpuprofile in the smoke folder, written when it shuts down).
    const coreProfile = smoke && process.argv.includes('--smoke-profile') ? { SHURIKEN_CORE_PROFILE: join(smokeOut ?? userData, 'core.cpuprofile') } : {};
    const child = utilityProcess.fork(entry, [], { serviceName: 'Shuriken Core', stdio: 'pipe', execArgv: ['--max-old-space-size=16384'], env: { ...process.env, ...(smoke ? { SHURIKEN_SMOKE: '1' } : {}), ...coreProfile } });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => mainLog('info', 'core stdout', d.toString('utf8').slice(0, 2000)));
    child.stderr?.on('data', (d: Buffer) => mainLog('warn', 'core stderr', d.toString('utf8').slice(0, 4000)));
    child.on('message', (msg: { type: string; [k: string]: unknown }) => this.handle(msg));
    child.on('exit', (code) => this.handleExit(code));
    child.postMessage({
      type: 'init',
      dataDir: userData,
      resourcesDir: app.isPackaged ? join(process.resourcesPath, 'resources') : resolve(import.meta.dirname, '..', '..', 'resources'),
      appVersion: app.getVersion(),
      // Smoke/inspection runs never start agents (--safe-mode or --smoke).
      safeMode: smoke || process.argv.includes('--safe-mode'),
      openProject: this.openProject,
      // Restarted after a crash in the middle of a build: it carries on (a project the user opens waits on hold).
      resume: this.restarts.length > 0 && this.building,
    });
    child.postMessage({ type: 'share', count: this.shareCount, elsewhere: this.elsewhere });
    this.setStatus({ state: this.restarts.length ? 'restarting' : 'starting' });
  }

  /** After a crash, reopen whatever project the window had (not the global "last" one). */
  reopenOnRestart(projectId: string | null): void {
    this.openProject = projectId;
  }

  /** Whether the window's project was building when last heard from (see start). */
  private building = false;
  buildingNow(building: boolean): void {
    this.building = building;
  }

  /** How many windows are building at once, and how many agents work in the OTHER windows (the app-wide ceiling). */
  share(count: number, elsewhere: number): void {
    if (count === this.shareCount && elsewhere === this.elsewhere) return;
    this.shareCount = count;
    this.elsewhere = elsewhere;
    this.child?.postMessage({ type: 'share', count, elsewhere });
  }

  private handle(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.setStatus({ state: 'ready', mcpUrl: msg.mcpUrl as string });
        for (const q of this.queue.splice(0)) this.child?.postMessage({ type: 'rpc', ...q });
        break;
      case 'rpc-result': {
        const p = this.pending.get(msg.id as number);
        if (!p) return;
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
        break;
      }
      case 'event':
        this.onEvent(msg.channel as string, msg.payload);
        break;
      case 'fatal':
        mainLog('error', 'core fatal', msg);
        this.setStatus({ state: 'failed', detail: String(msg.error) });
        break;
      case 'core-error':
        mainLog('error', 'core error', msg.error);
        break;
      case 'render': {
        const id = msg.id as number;
        void renderPicture(msg.req as RenderRequest).then(
          (image) => this.child?.postMessage({ type: 'render-result', id, image }),
          (e) => this.child?.postMessage({ type: 'render-result', id, image: null, error: (e as Error).message }),
        );
        break;
      }
      case 'forge': {
        // Forge plans drawn on the GPU by the hidden render page (core/ui/forge/gpu-batch.ts).
        const id = msg.id as number;
        void forgePictures(msg.req as ForgeGLRequest).then(
          (result) => this.child?.postMessage({ type: 'forge-result', id, result }),
          (e) => this.child?.postMessage({ type: 'forge-result', id, result: null, error: (e as Error).message }),
        );
        break;
      }
      case 'media': {
        // A reference video or picture to read on the hidden media page (main/media-decoder.ts).
        const id = msg.id as number;
        void mediaHost.run(msg.req as MediaRequest).then(
          (result) => this.child?.postMessage({ type: 'media-result', id, result }),
          (e) => this.child?.postMessage({ type: 'media-result', id, result: null, error: (e as Error).message }),
        );
        break;
      }
      case 'secret-get': {
        let value: string | null = null;
        try {
          const enc = readSecrets()[msg.key as string];
          if (enc && safeStorage.isEncryptionAvailable()) value = safeStorage.decryptString(Buffer.from(enc, 'base64'));
        } catch (e) {
          mainLog('warn', 'secret decrypt failed', String(e));
        }
        this.child?.postMessage({ type: 'secret-value', id: msg.id, value });
        break;
      }
    }
  }

  private handleExit(code: number): void {
    this.child = null;
    this.ready = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Core process exited'));
      this.pending.delete(id);
    }
    if (this.stopping) return;
    mainLog('error', `core exited with code ${code}`);
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60000);
    this.restarts.push(now);
    if (this.restarts.length > 5) {
      this.setStatus({ state: 'failed', detail: `Core crashed ${this.restarts.length} times in a minute (last exit code ${code}). See logs.` });
      return;
    }
    journal?.record('main', 'core.restart', { reason: `exit code ${code}` });
    this.setStatus({ state: 'restarting', detail: `Core exited (code ${code}); restarting…` });
    setTimeout(() => this.start(), 500 * this.restarts.length);
  }

  call(method: string, params: unknown, timeoutMs = 10 * 60 * 1000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      if (this.ready && this.child) this.child.postMessage({ type: 'rpc', id, method, params });
      else this.queue.push({ id, method, params });
    });
  }

  /** Test hook: hard-kill the core process as a crash would (used by --smoke-crash). */
  simulateCrash(): void {
    this.child?.kill();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        child.kill();
        res();
      }, 8000);
      child.once('exit', () => {
        clearTimeout(t);
        res();
      });
      child.postMessage({ type: 'shutdown' });
    });
  }

  private setStatus(s: CoreStatus): void {
    this.status = s;
    this.onStatus(s);
  }
}

// ─── Workspaces (one window + one core each) ────────────────────────────────

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface Workspace {
  /** The project window's id: its page's webContents id. */
  id: number;
  view: WebContentsView;
  core: CoreSupervisor;
  /** The app window it is docked in (it can be pulled out into another and docked back). */
  frame: Frame;
  projectId: string | null;
  projectName: string | null;
  /** The core's orchestrator has work (runs or ready tasks) and is not paused. */
  building: boolean;
  paused: boolean;
  /** Paused until a time, to resume by itself ("until my 5-hour limit resets"): a PC asleep then never resumes it. */
  resumesLater: boolean;
  activeRuns: number;
  /** Agents holding a place among the working ones (what the app-wide ceiling counts). */
  working: number;
  /** Questions and approvals waiting for the user (open escalation ids). */
  waiting: Set<string>;
}

/**
 * An app window. Its own page is the bar along the top: the Projects menu, then the project windows
 * docked in it, each a workspace view below the bar with its own page and core (so the ones behind
 * keep building). A project window can be pulled out into an app window of its own and docked back.
 * In the code a docked project window is a "tab"; the app calls them windows.
 */
interface Frame {
  win: BrowserWindow;
  /** Docked project windows, left to right. */
  tabs: Workspace[];
  active: Workspace | null;
}

/** The bar's height (the window controls' overlay is the same height). */
const STRIP = 36;
/** The bar's colour (and the window controls'); pages use the app's own background. */
const STRIP_BG = '#080706';
const PAGE_BG = '#0e0c0b';
const frames: Frame[] = [];
/** The app window used last: new project windows and the second-instance prompt go there. */
let lastFrame: Frame | null = null;
const workspaces = new Map<number, Workspace>();
const stateFile = join(userData, 'window-state.json');
const windowsFile = join(userData, 'windows.json');

function onScreen(s: WindowState): WindowState {
  const visible = screen.getAllDisplays().some((d) => s.x !== undefined && s.y !== undefined && s.x >= d.bounds.x - 50 && s.y >= d.bounds.y - 50 && s.x < d.bounds.x + d.bounds.width && s.y < d.bounds.y + d.bounds.height);
  return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
}

function loadWindowState(): WindowState {
  try {
    return onScreen(JSON.parse(readFileSync(stateFile, 'utf8')) as WindowState);
  } catch {
    return { width: 1500, height: 940, maximized: false };
  }
}

function boundsOf(win: BrowserWindow): WindowState {
  const b = win.getNormalBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    writeFileSync(stateFile, JSON.stringify(boundsOf(win)));
  } catch {
    /* ignore */
  }
}

interface SavedFrame {
  bounds: WindowState | null;
  active: number;
  tabs: Array<{ projectId: string | null }>;
}

/** Windows open at quit, so the next launch brings the same projects back, docked as they were. */
function saveOpenTabs(): void {
  const data = {
    frames: frames
      .filter((f) => !f.win.isDestroyed() && f.tabs.length)
      .map((f) => ({ bounds: boundsOf(f.win), active: f.active ? Math.max(0, f.tabs.indexOf(f.active)) : 0, tabs: f.tabs.map((w) => ({ projectId: w.projectId })) })),
  };
  if (!data.frames.length) return;
  try {
    writeFileSync(windowsFile, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function loadOpenTabs(): SavedFrame[] {
  const tabsOf = (t: unknown) => (Array.isArray(t) ? (t as Array<{ projectId?: string | null } | null>).slice(0, 12).map((x) => ({ projectId: x?.projectId ?? null })) : []);
  try {
    const raw = JSON.parse(readFileSync(windowsFile, 'utf8')) as unknown;
    // Before 1.3 every project had an app window of its own: they come back docked in one.
    if (Array.isArray(raw)) {
      const list = raw.slice(0, 12) as Array<{ projectId?: string | null; bounds?: WindowState }>;
      return [{ bounds: list[0]?.bounds ?? null, active: 0, tabs: tabsOf(list) }];
    }
    const o = raw as { frames?: Array<{ bounds?: WindowState; active?: number; tabs?: unknown }>; bounds?: WindowState; active?: number; tabs?: unknown };
    // 1.3 saved one app window's tabs.
    const list = Array.isArray(o.frames) ? o.frames.slice(0, 6) : [o];
    return list.map((f) => ({ bounds: f.bounds ?? null, active: f.active ?? 0, tabs: tabsOf(f.tabs) })).filter((f) => f.tabs.length);
  } catch {
    return [];
  }
}

/**
 * A project window's page while it's alive. Once it closes, its view has no webContents any more
 * (undefined, not just destroyed), while its core can still be sending events on its way down.
 */
function pageOf(ws: Workspace | null | undefined): WebContents | null {
  const wc = ws?.view.webContents as WebContents | undefined;
  return wc && !wc.isDestroyed() ? wc : null;
}

function send(ws: Workspace, channel: string, ...args: unknown[]): void {
  pageOf(ws)?.send(channel, ...args);
}

function workspaceOf(sender: WebContents): Workspace | null {
  return workspaces.get(sender.id) ?? null;
}

function live(f: Frame | null | undefined): Frame | null {
  return f && !f.win.isDestroyed() ? f : null;
}

/** The app window a page belongs to: a project window's, or the bar's own. */
function frameOfContents(wc: WebContents): Frame | null {
  const ws = workspaces.get(wc.id);
  if (ws) return live(ws.frame);
  return frames.find((f) => !f.win.isDestroyed() && f.win.webContents.id === wc.id) ?? null;
}

/** The first app window still open (the main one when there are several). */
function mainFrame(): Frame | null {
  return frames.find((f) => !f.win.isDestroyed()) ?? null;
}

/** Brings a project window to the front, and its app window with it. */
function focus(ws: Workspace): void {
  selectTab(ws);
  const f = live(ws.frame);
  if (!f) return;
  if (f.win.isMinimized()) f.win.restore();
  f.win.show();
  f.win.focus();
  pageOf(ws)?.focus();
}

function workspaceWithProject(projectId: string, except?: Workspace): Workspace | null {
  for (const w of workspaces.values()) if (w !== except && w.projectId === projectId) return w;
  return null;
}

/**
 * Keep the screen on while agents work (preference, on by default): Studio can only take screenshots
 * of a visible window, so a screen that sleeps during an unattended build blinds every visual check.
 * Released as soon as nothing is building, a project is paused (unless it resumes by itself at a time:
 * kept then, or the PC sleeps through it), or the preference is off.
 */
let screenOnId: number | null = null;
let screenOnSeq = 0;
async function updateScreenOn(): Promise<void> {
  // Building state can flip while the preference is read (a paused project reports running, then
  // paused, in one tick): only the latest call decides, from the state after the read.
  const my = ++screenOnSeq;
  const first = [...workspaces.values()].find((w) => w.building || w.resumesLater);
  let keepOn = true;
  if (!smoke && first) {
    const prefs = (await first.core.call('app.prefs', {}, 10000).catch(() => null)) as { keepScreenOn?: boolean } | null;
    keepOn = prefs?.keepScreenOn !== false;
  }
  if (my !== screenOnSeq) return;
  const want = !smoke && keepOn && [...workspaces.values()].some((w) => w.building || w.resumesLater);
  if (want && screenOnId === null) {
    screenOnId = powerSaveBlocker.start('prevent-display-sleep');
    mainLog('info', 'keeping the screen on while agents work');
  } else if (!want && screenOnId !== null) {
    powerSaveBlocker.stop(screenOnId);
    screenOnId = null;
    mainLog('info', 'the screen may sleep again');
  }
}

/** Tell every core how many agents work in the other project windows, so together they stay under the app-wide ceiling. */
function broadcastShare(): void {
  const all = [...workspaces.values()];
  const n = Math.max(1, all.filter((w) => w.building).length);
  const total = all.reduce((s, w) => s + w.working, 0);
  for (const w of all) w.core.share(n, total - w.working);
}

function updateTitle(f: Frame): void {
  if (!f.win.isDestroyed()) f.win.setTitle(f.active?.projectName ? `${f.active.projectName} — ${APP_NAME}` : APP_NAME);
}

// ─── Project windows, docked in app windows ─────────────────────────────────

/** A project window as its bar shows it, with its light: needs you, working, paused, idle (or a start page). */
function tabInfo(w: Workspace): TabInfo {
  const n = w.waiting.size;
  const state: TabInfo['state'] = !w.projectId ? 'start' : n ? 'input' : w.building ? 'working' : w.paused ? 'paused' : 'idle';
  const detail =
    state === 'input'
      ? n === 1
        ? 'Needs your answer'
        : `${n} things need your answer`
      : state === 'working'
        ? w.activeRuns > 0
          ? `${w.activeRuns} agent${w.activeRuns === 1 ? '' : 's'} working`
          : 'Starting work'
        : state === 'paused'
          ? 'Paused'
          : state === 'idle'
            ? 'Idle'
            : 'Start page';
  return { id: w.id, title: w.projectName ?? (w.projectId ? 'Opening…' : 'Start'), busy: w.building, state, detail, active: w === w.frame.active };
}

/** What an app window's bar shows: its project windows, and whether it is the main one of several. */
function stripState(f: Frame): StripState {
  return { tabs: f.tabs.map(tabInfo), main: mainFrame() === f, others: frames.filter((x) => x !== f && !x.win.isDestroyed()).length };
}

/** Held while a smoke run photographs the bar with made-up states. */
let barFrozen = false;

/** Tells bars what their project windows are (and app windows their titles): one app window, or all. */
function sendTabs(only?: Frame | null): void {
  if (barFrozen) return;
  for (const f of only ? [only] : frames) {
    if (f.win.isDestroyed() || f.win.webContents.isDestroyed()) continue;
    f.win.webContents.send('tabs:changed', stripState(f));
    updateTitle(f);
  }
}

/** Every project window fills its app window below the bar; only the one in front is visible. */
function layout(f: Frame): void {
  if (f.win.isDestroyed()) return;
  const [width, height] = f.win.getContentSize();
  for (const w of f.tabs) {
    w.view.setBounds({ x: 0, y: STRIP, width: width ?? 0, height: Math.max(0, (height ?? 0) - STRIP) });
    w.view.setVisible(w === f.active);
  }
  // A project window's Kiln view lies over its Kiln page (and hides with it).
  for (const w of f.tabs) kilnDocks?.layout(w.id);
}

function selectTab(ws: Workspace): void {
  if (!workspaces.has(ws.id)) return;
  const f = ws.frame;
  // A bar menu left open in the page going to the back would still be open on coming back.
  if (f.active && f.active !== ws) send(f.active, 'strip:menu', { kind: 'none' });
  f.active = ws;
  lastFrame = f;
  layout(f);
  sendTabs(f);
}

/** Ctrl+T / Ctrl+Shift+N new window, Ctrl+W close, Ctrl+Tab and Ctrl+Shift+Tab switch, Ctrl+1…9 jump. */
function tabShortcut(e: Electron.Event, input: Electron.Input, wc: WebContents): void {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
  const f = frameOfContents(wc);
  if (!f) return;
  const k = input.key.toLowerCase();
  if (k === 't' || (input.shift && k === 'n')) {
    e.preventDefault();
    openTab(null, f);
  } else if (k === 'w' && !input.shift) {
    e.preventDefault();
    if (f.active) closeTab(f.active);
  } else if (k === 'tab') {
    e.preventDefault();
    if (f.tabs.length > 1 && f.active) focus(f.tabs[(f.tabs.indexOf(f.active) + (input.shift ? -1 : 1) + f.tabs.length) % f.tabs.length]!);
  } else if (/^[1-9]$/.test(k) && !input.shift) {
    const t = k === '9' ? f.tabs.at(-1) : f.tabs[Number(k) - 1];
    if (t) {
      e.preventDefault();
      focus(t);
    }
  }
}

/** Agents still working where the user is closing: keep them, pause the project, or stop for now. */
function confirmCloseWhileBuilding(what: string, parent: BrowserWindow | null): 'keep' | 'pause' | 'stop' {
  const opts = {
    type: 'question' as const,
    buttons: ['Keep working', 'Stop and stay paused', 'Stop for now'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `Agents are still working on ${what}`,
    detail:
      'Stop and stay paused: agents stop now and the project stays paused until you press Resume.\n' +
      'Stop for now: agents stop now and carry on when you open the project again.',
  };
  const choice = parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
  return choice === 0 ? 'keep' : choice === 1 ? 'pause' : 'stop';
}

function rendererUrl(page: string, extra: string[]): { url?: string; file?: string; hash: string; search: string } {
  const search = [...extra, ...(smoke ? ['smoke'] : [])].join('&');
  // ?smoke tells the page it is being captured (no one-time popups over the screenshots).
  if (process.env.ELECTRON_RENDERER_URL) return { url: `${process.env.ELECTRON_RENDERER_URL}${search ? `?${search}` : ''}#${page}`, hash: page, search };
  return { file: join(import.meta.dirname, '..', 'renderer', 'index.html'), hash: page, search };
}

const webPreferences = () => ({
  preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: false,
  // Smoke windows live off-screen; without this Chromium may stop producing their frames.
  backgroundThrottling: !smoke,
});

function guard(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!trustedRendererUrl(url, join(import.meta.dirname, '..', 'renderer', 'index.html'), process.env.ELECTRON_RENDERER_URL)) e.preventDefault();
  });
  wc.on('will-redirect', (e, url) => {
    if (!trustedRendererUrl(url, join(import.meta.dirname, '..', 'renderer', 'index.html'), process.env.ELECTRON_RENDERER_URL)) e.preventDefault();
  });
  wc.on('before-input-event', (e, input) => tabShortcut(e, input, wc));
}

// ─── Pictures of models for agents ──────────────────────────────────────────────

/**
 * A hidden offscreen page that draws models (the Models page's ModelView, four angles with a player
 * for scale) for agents that can't look at a 3D viewer. Made on the first request, one render at a
 * time, closed after two idle minutes and with the last app window (it must never keep the app open).
 */
let renderWin: BrowserWindow | null = null;
let renderLoaded: Promise<void> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderIdle: NodeJS.Timeout | null = null;

function closeRenderWindow(): void {
  if (renderIdle) clearTimeout(renderIdle);
  renderIdle = null;
  if (renderWin && !renderWin.isDestroyed()) renderWin.destroy();
  renderWin = null;
  renderLoaded = null;
}

/** The hidden render page, opened (or reopened) and loaded. */
async function renderPage(): Promise<BrowserWindow> {
  if (!renderWin || renderWin.isDestroyed()) {
    const win = new BrowserWindow({ show: false, width: 1100, height: 1100, webPreferences: { ...webPreferences(), offscreen: true, backgroundThrottling: false } });
    renderWin = win;
    guard(win.webContents);
    renderLoaded = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
    const target = rendererUrl('render', ['render']);
    if (target.url) void win.loadURL(target.url);
    else void win.loadFile(target.file!, { hash: target.hash, search: target.search });
  }
  await renderLoaded;
  if (renderIdle) clearTimeout(renderIdle);
  return renderWin!;
}

function renderPicture(req: RenderRequest): Promise<string | null> {
  const job = renderQueue.then(async () => {
    // Nothing new is drawn while the app closes (a hidden window must never keep it open).
    if (!req || (req.kind !== 'model' && req.kind !== 'icon' && req.kind !== 'animation' && req.kind !== 'rig-animation') || quitting || !mainFrame()) return null;
    const win = await renderPage();
    const out = (await win.webContents.executeJavaScript(`window.__render(${JSON.stringify(req)})`)) as unknown;
    renderIdle = setTimeout(closeRenderWindow, 120_000);
    return typeof out === 'string' && out.startsWith('data:image/') ? out : null;
  });
  renderQueue = job.catch(() => undefined);
  return job;
}

/**
 * Forge plans drawn on the GPU by the same hidden page (src/renderer/src/lib/forge-gl): the pixels come back as bytes
 * for the core to wear and save. Null when nothing can be drawn now (the app closing); the core forges on the CPU.
 */
function forgePictures(req: ForgeGLRequest): Promise<ForgeGLResponse | null> {
  const job = renderQueue.then(async () => {
    if (!req || !Array.isArray(req.plans) || quitting || !mainFrame()) return null;
    const win = await renderPage();
    const out = (await win.webContents.executeJavaScript(`window.__forge(${JSON.stringify(req)})`)) as ForgeGLResponse | null;
    renderIdle = setTimeout(closeRenderWindow, 120_000);
    return out && Array.isArray(out.items) ? out : null;
  });
  renderQueue = job.catch(() => undefined);
  return job;
}

// ─── Reference videos and pictures for the core ─────────────────────────────────

// The scheme the hidden media page reads files through has to be known before the app is ready.
registerMediaScheme();

/** The hidden media page: Chromium decodes the user's reference clips and pictures there (see media-decoder.ts). */
const mediaHost = new MediaHost({
  webPreferences: () => webPreferences(),
  load: (win) => {
    const target = rendererUrl('media', ['media']);
    if (target.url) void win.loadURL(target.url);
    else void win.loadFile(target.file!, { hash: target.hash, search: target.search });
  },
  guard: (wc) => guard(wc),
  // Nothing new is opened while the app closes (a hidden window must never keep it open).
  alive: () => !quitting && !!mainFrame(),
  log: (level, msg, data) => mainLog(level, msg, data),
});

/** An app window with its bar; project windows are docked in it with createTab (or moveTab). */
function createFrame(bounds?: WindowState | null): Frame {
  nativeTheme.themeSource = 'dark';
  const st = bounds ? onScreen(bounds) : loadWindowState();
  const win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: app.isPackaged ? undefined : resolve(import.meta.dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: STRIP_BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: STRIP_BG, symbolColor: '#b9ada2', height: STRIP },
    webPreferences: webPreferences(),
  });
  taskbarIdentity(win);
  const f: Frame = { win, tabs: [], active: null };
  frames.push(f);
  lastFrame ??= f;
  if (st.maximized) win.maximize();
  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore'] as const) win.on(ev as 'resize', () => layout(f));
  win.once('ready-to-show', () => {
    if (!smoke) win.show();
  });
  // Keys go to the project window in front, not to the bar, when the app window comes back into focus.
  win.on('focus', () => {
    lastFrame = f;
    pageOf(f.active)?.focus();
  });
  let confirmed = false;
  win.on('close', (e) => {
    const last = !frames.some((x) => x !== f && !x.win.isDestroyed());
    if (!quitting && !smoke && !confirmed) {
      const busy = f.tabs.filter((w) => w.building);
      if (busy.length) {
        const choice = confirmCloseWhileBuilding(busy.length === 1 ? (busy[0]!.projectName ?? 'a project') : `${busy.length} projects`, win);
        if (choice === 'keep') {
          e.preventDefault();
          return;
        }
        journal?.record('main', 'window.close.while-building', { projects: busy.map((w) => w.projectName), choice });
        if (choice === 'pause') {
          // Save the pauses first (the cores stop with the window), then close.
          e.preventDefault();
          confirmed = true;
          void Promise.all(busy.map((w) => w.core.call('orchestrator.pause', {}, 10_000).catch(() => undefined))).finally(() => !win.isDestroyed() && win.close());
          return;
        }
      }
    }
    // The last app window closing quits the app: remember what was open, so the next launch reopens it.
    if (last) {
      if (!quitting && !smoke) saveOpenTabs();
      saveWindowState(win);
    }
  });
  win.on('closed', () => {
    const i = frames.indexOf(f);
    if (i >= 0) frames.splice(i, 1);
    if (lastFrame === f) lastFrame = mainFrame();
    if (!mainFrame()) closeRenderWindow();
    if (!mainFrame()) mediaHost.close();
    for (const w of [...f.tabs]) disposeTab(w);
    sendTabs();
  });
  guard(win.webContents);
  const target = rendererUrl('strip', ['strip']);
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file!, { hash: target.hash, search: target.search });
  return f;
}

function createTab(opts: { openProject: string | null | 'last' | 'blank'; activate?: boolean; frame?: Frame | null }): Workspace {
  const f = live(opts.frame) ?? live(lastFrame) ?? mainFrame() ?? createFrame();
  const view = new WebContentsView({ webPreferences: webPreferences() });
  view.setBackgroundColor(PAGE_BG);
  f.win.contentView.addChildView(view);
  const core = new CoreSupervisor(opts.openProject);
  const ws: Workspace = { id: view.webContents.id, view, core, frame: f, projectId: null, projectName: null, building: false, paused: false, resumesLater: false, activeRuns: 0, working: 0, waiting: new Set() };
  workspaces.set(ws.id, ws);
  // New project windows open to the right of the one in front.
  f.tabs.splice(f.active ? f.tabs.indexOf(f.active) + 1 : f.tabs.length, 0, ws);

  core.onEvent = (channel, payload) => {
    perf.events.set(channel, (perf.events.get(channel) ?? 0) + 1);
    send(ws, 'core:event', channel, payload);
    notifyUser(ws, channel, payload);
    if (journal) journalCoreEvent(journal, ws, channel, payload);
    if (channel === 'project.changed') {
      const id = (payload as { projectId: string | null }).projectId;
      // Closing a project sends no orchestrator state: it isn't building any more.
      if (!id && (ws.building || ws.resumesLater)) {
        ws.building = false;
        ws.resumesLater = false;
        broadcastShare();
        void updateScreenOn();
      }
      if (id !== ws.projectId) ws.waiting.clear();
      ws.projectId = id;
      ws.core.reopenOnRestart(id);
      sendTabs(ws.frame);
      if (id) {
        void ws.core
          .call('project.current', {}, 20000)
          .then((p) => {
            ws.projectName = (p as { name?: string } | null)?.name ?? null;
            sendTabs(ws.frame);
          })
          .catch(() => {});
        // What already waits for the user in the project just opened.
        void ws.core
          .call('escalations.list', { status: 'open' }, 20000)
          .then((list) => {
            if (ws.projectId !== id) return;
            ws.waiting = new Set((list as Array<{ id: string }>).map((e) => e.id));
            sendTabs(ws.frame);
          })
          .catch(() => {});
      } else ws.projectName = null;
      for (const other of workspaces.values()) if (other !== ws) send(other, 'core:event', 'windows.changed', {});
    } else if (channel === 'orchestrator.state') {
      const s = payload as { paused?: boolean; pausedUntil?: string | null; activeRuns?: number; working?: number; queued?: number };
      const building = !s.paused && ((s.activeRuns ?? 0) > 0 || (s.queued ?? 0) > 0);
      const resumesLater = !!s.paused && !!s.pausedUntil;
      if (resumesLater !== ws.resumesLater) {
        ws.resumesLater = resumesLater;
        void updateScreenOn();
      }
      ws.core.buildingNow(building);
      const changed = building !== ws.building || !!s.paused !== ws.paused || (s.activeRuns ?? 0) !== ws.activeRuns;
      ws.paused = !!s.paused;
      ws.activeRuns = s.activeRuns ?? 0;
      const working = s.working ?? s.activeRuns ?? 0;
      const agentsChanged = working !== ws.working;
      ws.working = working;
      if (building !== ws.building) {
        ws.building = building;
        broadcastShare();
        void updateScreenOn();
      } else if (agentsChanged) broadcastShare();
      if (changed) sendTabs(ws.frame);
    } else if (channel === 'escalation.updated') {
      const e = payload as { id?: string; status?: string };
      if (e.id && (e.status === 'open') !== ws.waiting.has(e.id)) {
        if (e.status === 'open') ws.waiting.add(e.id);
        else ws.waiting.delete(e.id);
        sendTabs(ws.frame);
      }
    } else if (channel === 'prefs.changed') {
      void updateScreenOn();
    }
  };
  core.onStatus = (s) => {
    send(ws, 'core:status', s);
    if (s.state === 'ready') startKilnIfWanted(ws);
    // A core that gave up (or is restarting) runs no agents until it reports again.
    if (s.state !== 'ready' && ws.building) {
      ws.building = false;
      broadcastShare();
      void updateScreenOn();
      sendTabs(ws.frame);
    }
  };
  core.start();
  broadcastShare();

  const wc = view.webContents;
  guard(wc);
  wc.on('render-process-gone', (_e, details) => {
    journal?.record('main', 'renderer.crash', { reason: details.reason, exitCode: details.exitCode });
    mainLog('error', 'renderer gone', details);
    if (details.reason !== 'clean-exit') setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
  });
  // A project window opened for a specific project starts on its dashboard; others on the start page.
  const target = rendererUrl(opts.openProject && opts.openProject !== 'last' ? 'dashboard' : 'start', ['tab']);
  if (target.url) void wc.loadURL(target.url);
  else void wc.loadFile(target.file!, { hash: target.hash, search: target.search });
  if (opts.activate !== false || !f.active) f.active = ws;
  layout(f);
  sendTabs(f);
  return ws;
}

/** Closes a project window (asking first when its agents are working); the last one gives way to a start page. */
function closeTab(ws: Workspace): void {
  if (!quitting && !smoke && ws.building) {
    const choice = confirmCloseWhileBuilding(ws.projectName ?? 'this project', live(ws.frame)?.win ?? null);
    if (choice === 'keep') return;
    journal?.record('main', 'tab.close.while-building', { project: ws.projectName, choice });
    if (choice === 'pause') {
      void ws.core
        .call('orchestrator.pause', {}, 10_000)
        .catch(() => undefined)
        .finally(() => disposeTab(ws));
      return;
    }
  }
  journal?.record('main', 'window.close', { project: ws.projectName, windows: workspaces.size - 1 });
  disposeTab(ws);
}

function disposeTab(ws: Workspace): void {
  if (!workspaces.has(ws.id)) return;
  const f = ws.frame;
  const i = f.tabs.indexOf(ws);
  workspaces.delete(ws.id);
  if (i >= 0) f.tabs.splice(i, 1);
  kilnDocks?.dispose(ws.id);
  if (!f.win.isDestroyed()) f.win.contentView.removeChildView(ws.view);
  // The project window is gone: whatever its core still says on the way down goes nowhere.
  ws.core.onEvent = () => {};
  ws.core.onStatus = () => {};
  pageOf(ws)?.close();
  if (ws.building || ws.resumesLater) void updateScreenOn();
  // While quitting, before-quit stops every core (and records the open windows) itself.
  if (!quitting) {
    void ws.core.stop();
    broadcastShare();
    for (const other of workspaces.values()) send(other, 'core:event', 'windows.changed', {});
  }
  if (f.active === ws) f.active = f.tabs[Math.min(Math.max(0, i), f.tabs.length - 1)] ?? null;
  if (!f.tabs.length && !f.win.isDestroyed() && !quitting) {
    // An app window left empty: a pulled-out one closes; the only one gets a start page.
    if (frames.some((x) => x !== f && !x.win.isDestroyed())) f.win.close();
    else createTab({ openProject: null, frame: f });
    return;
  }
  layout(f);
  sendTabs(f);
  // (Its app window may be the one closing, with the rest of its project windows.)
  if (!f.win.isDestroyed() && f.win.isFocused()) pageOf(f.active)?.focus();
}

/**
 * Docks a project window into an app window at a position (its own, to reorder), without reloading it:
 * its page and core carry on as they were. An app window left empty closes.
 */
function moveTab(ws: Workspace, to: Frame, index: number, why: 'dock' | 'detach' = 'dock'): void {
  const from = ws.frame;
  if (to.win.isDestroyed() || !workspaces.has(ws.id)) return;
  const i = from.tabs.indexOf(ws);
  if (i >= 0) from.tabs.splice(i, 1);
  to.tabs.splice(Math.max(0, Math.min(index, to.tabs.length)), 0, ws);
  if (from !== to) {
    if (from.active) send(from.active, 'strip:menu', { kind: 'none' });
    if (!from.win.isDestroyed()) from.win.contentView.removeChildView(ws.view);
    to.win.contentView.addChildView(ws.view);
    ws.frame = to;
    if (from.active === ws) from.active = from.tabs[Math.min(Math.max(0, i), from.tabs.length - 1)] ?? null;
    if (why === 'dock') journal?.record('main', 'window.dock', { project: ws.projectName, appWindows: frames.length });
  } else if (i !== index) journal?.record('main', 'window.reorder', { project: ws.projectName, from: i, to: index });
  to.active = ws;
  layout(to);
  if (from !== to) {
    if (!from.tabs.length && !from.win.isDestroyed()) from.win.close();
    else layout(from);
  }
  sendTabs();
  focus(ws);
}

/** Pulls a project window out into an app window of its own (at a screen point: where it was dropped). */
function detachTab(ws: Workspace, at?: { x: number; y: number }): Frame | null {
  const from = live(ws.frame);
  if (!from || from.tabs.length < 2) return null;
  const b = from.win.getNormalBounds();
  const f = createFrame({ x: at ? Math.round(at.x - 160) : b.x + 48, y: at ? Math.round(at.y - STRIP / 2) : b.y + 48, width: b.width, height: b.height, maximized: false });
  journal?.record('main', 'window.detach', { project: ws.projectName, appWindows: frames.length });
  moveTab(ws, f, 0, 'detach');
  return f;
}

/** Where a project window dropped on an app window's bar goes: before the first one right of the pointer. */
async function dropIndex(f: Frame, localX: number): Promise<number> {
  try {
    const centers = (await f.win.webContents.executeJavaScript('window.__stripCenters?.() ?? []')) as number[];
    return centers.filter((c) => c < localX).length;
  } catch {
    return f.tabs.length;
  }
}

/** A project window dragged off its bar and let go at a screen point: dock it on the bar there, or pull it out. */
async function dropTab(ws: Workspace, x: number, y: number): Promise<void> {
  const own = live(ws.frame);
  const bars = frames.filter((f) => !f.win.isDestroyed() && f.win.isVisible() && !f.win.isMinimized());
  // Another app window's bar under the pointer first (the dragged one's own bar is handled by its page).
  for (const f of [...bars.filter((b) => b !== own), ...bars.filter((b) => b === own)]) {
    const c = f.win.getContentBounds();
    if (x >= c.x && x < c.x + c.width && y >= c.y - 10 && y < c.y + STRIP + 10) {
      moveTab(ws, f, await dropIndex(f, x - c.x));
      return;
    }
  }
  if (own && own.tabs.length > 1) detachTab(ws, { x, y });
}

/** Opens a project in a new project window, or brings forward the one that already has it. */
function openTab(projectId: string | null, frame?: Frame | null): { focused: boolean } {
  if (projectId) {
    const existing = workspaceWithProject(projectId);
    if (existing) {
      focus(existing);
      return { focused: true };
    }
  }
  const ws = createTab({ openProject: projectId, frame });
  journal?.record('main', 'tab.open', { projectId, windows: workspaces.size });
  focus(ws);
  return { focused: false };
}

const updater = new Updater(userData, app.isPackaged, (s) => {
  for (const w of workspaces.values()) send(w, 'core:event', 'app.update', s);
}, mainLog);
handleTrusted('updates:status', () => updater.status);
handleTrusted('updates:check', () => updater.check());
handleTrusted('updates:install', () => updater.installNow());

/** Native Windows notifications for things that need the user or finished while they looked away. */
function notifyUser(ws: Workspace, channel: string, payload: unknown): void {
  const f = live(ws.frame);
  if (smoke || !Notification.isSupported() || !f || (f.win.isFocused() && f.active === ws)) return;
  let title: string | null = null;
  let body = '';
  if (channel === 'escalation.updated') {
    const e = payload as { status: string; title: string; kind: string };
    if (e.status !== 'open') return;
    title = ws.projectName ? `${ws.projectName} needs you` : 'Shuriken needs you';
    body = e.title;
  } else if (channel === 'task.updated') {
    const t = payload as { kind: string; status: string; title: string };
    if (t.kind !== 'objective' || t.status !== 'done') return;
    title = ws.projectName ? `${ws.projectName}: goal complete` : 'Goal complete';
    body = t.title;
  }
  if (!title) return;
  const n = new Notification({ title, body: body.slice(0, 200), silent: false });
  n.on('click', () => workspaces.has(ws.id) && focus(ws));
  n.show();
}

const runsSeen = new Set<string>();
const runsDone = new Set<string>();
const tasksDone = new Set<string>();
const escalationsSeen = new Set<string>();
const taskTitles = new Map<string, string>();

/** Picks the core events worth keeping in the session journal and gives them stable kinds. */
function journalCoreEvent(j: SessionJournal, ws: Workspace, channel: string, payload: unknown): void {
  const p = (payload ?? {}) as Record<string, unknown>;
  const project = ws.projectName ?? undefined;
  switch (channel) {
    case 'chat.message': {
      const m = p as { role?: string; text?: string; kind?: string; projectName?: string };
      if (m.role === 'user') {
        j.record('core', 'chat.user', { text: m.text, project: m.projectName ?? project });
        j.chat('You', m.text ?? '', m.projectName);
      } else if (m.role === 'director') {
        j.record('core', 'chat.director', { kind: m.kind, text: m.text, project: m.projectName ?? project });
        j.chat('Director', m.text ?? '', m.projectName);
      }
      return;
    }
    case 'run.updated': {
      const r = p as { id?: string; role?: string; status?: string; error?: string | null; taskId?: string | null; costUsd?: number; numTurns?: number; startedAt?: string; endedAt?: string | null; continuesRunId?: string | null };
      const id = r.id ?? '';
      if (r.status === 'running' && !runsSeen.has(id)) {
        runsSeen.add(id);
        j.record('core', 'run.started', { id, role: r.role, taskId: r.taskId, task: taskTitles.get(r.taskId ?? ''), project, continues: r.continuesRunId ?? null });
      }
      if (r.status && ['completed', 'failed', 'interrupted', 'error'].includes(r.status) && !runsDone.has(id)) {
        runsDone.add(id);
        const ms = r.startedAt && r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : null;
        j.record('core', 'run.finished', { id, role: r.role, status: r.status, error: r.error, taskId: r.taskId, turns: r.numTurns, costUsd: r.costUsd, ms, task: taskTitles.get(r.taskId ?? ''), project });
      }
      return;
    }
    case 'task.updated': {
      const t = p as { id?: string; title?: string; status?: string; attempts?: number; failureSummary?: string | null; kind?: string };
      if (t.id && t.title) taskTitles.set(t.id, t.title);
      if (t.status === 'done' && t.id && !tasksDone.has(t.id)) {
        tasksDone.add(t.id);
        j.record('core', 'task.done', { id: t.id, title: t.title, attempts: t.attempts, kind: t.kind, project });
        if (t.kind === 'objective') void captureScreen(ws, 'objective-done');
      }
      if (t.status === 'failed' && t.id) j.record('core', 'task.failed', { id: t.id, title: t.title, reason: t.failureSummary, project });
      return;
    }
    case 'escalation.updated': {
      const e = p as { id?: string; status?: string; title?: string; kind?: string };
      if (e.status === 'open' && e.id && !escalationsSeen.has(e.id)) {
        escalationsSeen.add(e.id);
        j.record('core', 'escalation', { title: e.title, kind: e.kind, project });
      }
      return;
    }
    case 'log': {
      const l = p as { level?: string; scope?: string; msg?: string; data?: unknown };
      if (l.level === 'error') j.error('core', `${project ? `[${project}] ` : ''}${l.scope ?? 'core'}: ${l.msg ?? ''}`, l.data);
      return;
    }
    case 'timeline': {
      const e = p as { kind?: string; title?: string; detail?: unknown };
      if (e.kind === 'account.switched') j.record('core', 'account.switched', { title: e.title });
      else if (e.kind === 'limit.paused' || e.kind === 'limit.wait') j.record('core', 'limit.wait', { reason: e.title });
      else if (e.kind === 'project.opened') j.record('core', 'project.opened', { name: String(e.title ?? '').replace(/^Project opened: /, '') });
      else if (e.kind === 'orchestrator.error') j.error('core', String(e.title ?? 'Scheduler error'), e.detail);
      else if (e.kind === 'regression.failed') j.record('core', 'regression.failed', { summary: e.title, project });
      else if (e.kind === 'critic.failed') j.record('core', 'critic.failed', { task: e.title, summary: (e.detail as { summary?: string } | undefined)?.summary, project });
      else if (e.kind === 'provider.environment') j.error('core', String(e.title ?? 'Agents cannot start'), e.detail);
      return;
    }
  }
}

/** Saves a small JPEG of a tab into the session's screens/ folder. */
async function captureScreen(ws: Workspace | null, label: string): Promise<void> {
  const wc = pageOf(ws);
  const f = live(ws?.frame);
  if (!journal || !wc || !f || f.win.isMinimized()) return;
  try {
    const img = await wc.capturePage();
    writeFileSync(journal.screenPath(label), img.resize({ width: Math.min(1600, img.getSize().width) }).toJPEG(72));
  } catch {
    /* best effort */
  }
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

/**
 * How long each RPC takes, and how often each core event reaches a window: a slow call is logged (it holds the window's
 * view and, while the core runs it, the core's one thread), and a smoke run reports both (report.perf).
 */
const perf = { rpc: new Map<string, { n: number; total: number; max: number; bytes: number }>(), events: new Map<string, number>() };
const SLOW_RPC_MS = 300;
function notePerf(method: string, ms: number, result: unknown): void {
  const cur = perf.rpc.get(method) ?? { n: 0, total: 0, max: 0, bytes: 0 };
  cur.n++;
  cur.total += ms;
  cur.max = Math.max(cur.max, ms);
  if (smokeOut) {
    try {
      cur.bytes += JSON.stringify(result ?? null)?.length ?? 0;
    } catch {
      /* not serializable: not counted */
    }
  }
  perf.rpc.set(method, cur);
  if (ms >= SLOW_RPC_MS) mainLog('warn', 'slow rpc', { method, ms: Math.round(ms) });
}

function isTrustedRenderer(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return trustedMainFrame(event.senderFrame, event.sender.mainFrame, join(import.meta.dirname, '..', 'renderer', 'index.html'), process.env.ELECTRON_RENDERER_URL);
}
function handleTrusted(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted IPC sender');
    return listener(event, ...args);
  });
}

handleTrusted('rpc', async (e, method: string, params: unknown) => {
  const ws = workspaceOf(e.sender);
  if (!ws) throw new Error('No engine for this window');
  // A project lives in one project window: opening one that another window has brings that one forward.
  if (method === 'projects.open') {
    const id = (params as { id?: string } | null)?.id;
    const other = id ? workspaceWithProject(id, ws) : null;
    if (other) {
      focus(other);
      return { openedIn: 'other-window' };
    }
  }
  const t0 = performance.now();
  const result = await ws.core.call(method, params);
  notePerf(method, performance.now() - t0, result);
  return result;
});
handleTrusted('windows:open', (e, projectId: string | null) => openTab(projectId, frameOfContents(e.sender)));
// "Open blank": a new project straight into its workspace, nothing started. In this project window
// when it's on the start page, otherwise in a new one next to it.
handleTrusted('windows:blank', async (e) => {
  const me = workspaceOf(e.sender);
  if (me && !me.projectId) {
    const created = (await me.core.call('projects.createBlank', {}, 60_000)) as { name?: string };
    journal?.record('main', 'project.blank', { name: created?.name, windows: workspaces.size });
    send(me, 'core:event', 'app.navigate', { page: 'dashboard' });
    return { name: created?.name, here: true };
  }
  // A new project window whose core creates the blank project while starting, so its page opens on it.
  const ws = createTab({ openProject: 'blank', frame: frameOfContents(e.sender) });
  focus(ws);
  journal?.record('main', 'project.blank', { windows: workspaces.size });
  return { here: false };
});
// "Open a game…": plug in a game Shuriken didn't build. In this project window when it's on the start
// page, otherwise in a new one whose core plugs it in once it's up (its page opens on the project).
// roblox: the game's community or account, chosen in the dialog (the renderer saves its own key once the project exists).
handleTrusted('windows:adopt', async (e, game: { studio?: string; file?: string; roblox?: { groupId?: string | null; userId?: string | null } }) => {
  const id = (v: unknown) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null);
  const roblox = game?.roblox ? { groupId: id(game.roblox.groupId), userId: id(game.roblox.userId) } : undefined;
  const params = { studio: typeof game?.studio === 'string' ? game.studio : undefined, file: typeof game?.file === 'string' ? game.file : undefined, roblox };
  const me = workspaceOf(e.sender);
  const run = async (ws: Workspace) => {
    try {
      const created = (await ws.core.call('games.adopt', params, 120_000)) as { id?: string; name?: string };
      journal?.record('main', 'project.adopt', { name: created?.name, from: params.studio ? 'studio' : 'file', windows: workspaces.size });
      send(ws, 'core:event', 'app.navigate', { page: 'dashboard' });
      return { name: created?.name, id: created?.id, error: undefined };
    } catch (err) {
      return { name: undefined, id: undefined, error: (err as Error).message };
    }
  };
  if (me && !me.projectId) return { ...(await run(me)), here: true };
  const ws = createTab({ openProject: null, frame: frameOfContents(e.sender) });
  focus(ws);
  const r = await run(ws);
  // Nothing to show in the new window when it failed: close it again and say why here.
  if (r.error) void ws.core.call('project.current', {}).then((cur) => (cur ? undefined : closeTab(ws)), () => undefined);
  return { ...r, here: false };
});
// The bar along the top of an app window (the app window's own page).
handleTrusted('tabs:list', (e) => {
  const f = frameOfContents(e.sender);
  return f ? stripState(f) : { tabs: [], main: true, others: 0 };
});
handleTrusted('tabs:select', (_e, id: number) => {
  const w = workspaces.get(id);
  if (w) focus(w);
});
handleTrusted('tabs:close', (_e, id: number) => {
  const w = workspaces.get(id);
  if (w) closeTab(w);
});
handleTrusted('tabs:new', (e) => openTab(null, frameOfContents(e.sender)));
handleTrusted('tabs:move', (_e, id: number, index: number) => {
  const w = workspaces.get(id);
  if (w && live(w.frame)) moveTab(w, w.frame, Number(index) || 0);
});
// Let go at a point on the sender bar's page (it may be far outside it): the screen point is that page's
// origin plus the point, exact for any display scale or maximized window.
handleTrusted('tabs:drop', (e, id: number, px: number, py: number) => {
  const w = workspaces.get(id);
  const f = frameOfContents(e.sender);
  if (!w || !f || !Number.isFinite(px) || !Number.isFinite(py)) return;
  const c = f.win.getContentBounds();
  const x = c.x + px;
  const y = c.y + py;
  mainLog('info', 'window dropped', { project: w.projectName, x, y });
  return dropTab(w, x, y);
});
handleTrusted('tabs:detach', (_e, id: number) => {
  const w = workspaces.get(id);
  if (w) detachTab(w);
});
handleTrusted('tabs:dock', (_e, id: number) => {
  const w = workspaces.get(id);
  // Back into the main app window (from the main one: into the app window used last).
  const to = w ? (mainFrame() !== w.frame ? mainFrame() : (frames.filter((f) => f !== w.frame && !f.win.isDestroyed()).at(-1) ?? null)) : null;
  if (w && to) moveTab(w, to, to.tabs.length);
});
// The bar's menus open in the page below it (the bar is only as tall as the bar): the Projects menu,
// and the options of the project window in front. 'none' closes them.
ipcMain.on('strip:menu', (e, menu: { kind?: string; x?: number }) => {
  if (!isTrustedRenderer(e)) return;
  const f = frameOfContents(e.sender);
  if (!f?.active) return;
  const kind = menu?.kind === 'projects' || menu?.kind === 'window' ? menu.kind : 'none';
  const st = stripState(f);
  send(f.active, 'strip:menu', { kind, x: Math.max(0, Math.round(Number(menu?.x) || 0)), id: f.active.id, title: tabInfo(f.active).title, canDetach: f.tabs.length > 1, canDock: st.others > 0, main: st.main });
  // Keys (Escape) go to the menu.
  if (kind !== 'none') pageOf(f.active)?.focus();
});
handleTrusted('windows:projects', (e) => {
  const me = workspaceOf(e.sender);
  return [...workspaces.values()].filter((w) => w.projectId).map((w) => ({ projectId: w.projectId!, mine: w === me }));
});
let firstDashboardShot = false;
ipcMain.on('journal', (e, kind: string, data: unknown) => {
  if (!isTrustedRenderer(e)) return;
  if (!journal) return;
  if (kind === 'error') {
    const d = (data ?? {}) as { message?: string; stack?: string };
    journal.error('renderer', d.message ?? 'Renderer error', d.stack);
    return;
  }
  const ws = workspaceOf(e.sender);
  journal.record('renderer', kind, workspaces.size > 1 && data && typeof data === 'object' ? { ...(data as object), window: ws?.projectName ?? ws?.id ?? null } : data);
  if (kind === 'nav' && (data as { page?: string } | null)?.page === 'dashboard' && !firstDashboardShot) {
    firstDashboardShot = true;
    setTimeout(() => void captureScreen(ws, 'dashboard'), 4000);
  }
});
handleTrusted('journal:dir', () => journal?.dir ?? null);
handleTrusted('core:status', (e) => workspaceOf(e.sender)?.core.status ?? { state: 'starting' });
handleTrusted('dialog:openDirectory', async (e, title?: string) => {
  const parent = frameOfContents(e.sender)?.win ?? null;
  const opts = { title: title ?? 'Select folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0];
});
handleTrusted('dialog:openPlaceFile', async (e) => {
  const parent = frameOfContents(e.sender)?.win ?? null;
  const opts = { title: 'Open a Roblox place', filters: [{ name: 'Roblox places', extensions: ['rbxl', 'rbxlx'] }], properties: ['openFile'] as Array<'openFile'> };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
handleTrusted('shell:openPath', (_e, p: string) => shell.openPath(normalize(p)));
// The Storefront's pictures (a thumbnail, the icon) saved where the user picks, to upload to Roblox by hand. Only a PNG
// inside a project's .shuriken/storefront folder can be the source.
handleTrusted('file:saveAs', async (e, source: string, suggestedName: string) => {
  const from = normalize(String(source));
  if (!/[\\/]\.shuriken[\\/]storefront[\\/]art[\\/].+\.png$/i.test(from) || !existsSync(from)) return null;
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const name = String(suggestedName || 'thumbnail.png').replace(/[<>:"/\\|?*]+/g, '-').slice(0, 80);
  const r = win ? await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'PNG image', extensions: ['png'] }] }) : await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return null;
  copyFileSync(from, r.filePath);
  return r.filePath;
});
// Deleting a project moves its folder to the Recycle Bin (recoverable), and only a folder that is a
// Shuriken project (it has .shuriken/project.json) and not a drive, home, Documents or Desktop.
handleTrusted('projects:trash', async (_e, p: string) => {
  const dir = normalize(String(p ?? ''));
  const protectedDirs = ['home', 'documents', 'desktop', 'userData'].map((k) => normalize(app.getPath(k as 'home')).toLowerCase());
  if (!dir || dir === dirname(dir) || protectedDirs.includes(dir.toLowerCase()) || !existsSync(join(dir, '.shuriken', 'project.json'))) {
    return { ok: false, error: 'That folder is not a Shuriken project folder, so it was left alone.' };
  }
  try {
    await shell.trashItem(dir);
    journal?.record('main', 'project.trashed', { dir });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Windows could not move it to the Recycle Bin (${(e as Error).message}). If its place is open in Studio, close it and try again.` };
  }
});
handleTrusted('shell:showItem', (_e, p: string) => shell.showItemInFolder(normalize(p)));
handleTrusted('shell:openExternal', (_e, url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
handleTrusted('file:readImage', (_e, p: string) => {
  // Only images inside a project's .shuriken folder may be read by the renderer.
  const n = normalize(p);
  const m = /[\\/]\.shuriken[\\/](evidence|snapshots)[\\/][^\\/]+\.(png|jpe?g|webp)$/i.exec(n);
  if (!m || !existsSync(n)) return null;
  const mime = m[2]!.toLowerCase() === 'png' ? 'image/png' : m[2]!.toLowerCase() === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(n).toString('base64')}`;
});

// Secure credential storage (OS-level encryption via DPAPI on Windows). Values never reach the renderer.
const secretsFile = join(userData, 'secrets.json');
function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}
handleTrusted('secrets:set', (_e, key: string, value: string) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
  const all = readSecrets();
  all[key] = safeStorage.encryptString(value).toString('base64');
  writeFileSync(secretsFile, JSON.stringify(all));
  return true;
});
handleTrusted('secrets:has', (_e, key: string) => key in readSecrets());
// Settings → This project: "keep the current default key for this project" copies it encrypted, without reading it.
handleTrusted('secrets:copy', (_e, from: string, to: string) => {
  const all = readSecrets();
  if (!(from in all) || typeof to !== 'string' || !to) return false;
  all[to] = all[from]!;
  writeFileSync(secretsFile, JSON.stringify(all));
  return true;
});
handleTrusted('secrets:delete', (_e, key: string) => {
  const all = readSecrets();
  delete all[key];
  writeFileSync(secretsFile, JSON.stringify(all));
  return true;
});

// ─── Smoke mode: capture every view for automated UI verification ───────────

async function runSmoke(ws: Workspace): Promise<void> {
  mkdirSync(smokeOut!, { recursive: true });
  const { core } = ws;
  const win = ws.view;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 60000;
  while (core.status.state !== 'ready' && Date.now() < deadline) await wait(250);
  await wait(2500);
  const openIdx = process.argv.indexOf('--smoke-open');
  if (openIdx >= 0 && process.argv[openIdx + 1]) {
    // Adopt/open an existing project folder so views render real data in an isolated profile.
    await core.call('projects.create', { name: '', rootPath: process.argv[openIdx + 1], open: true }).catch((e) => mainLog('warn', 'smoke-open failed', String(e)));
    await wait(4000);
  }
  let worldReport: unknown = null;
  const bindIdx = process.argv.indexOf('--smoke-bind');
  if (bindIdx >= 0 && process.argv[bindIdx + 1]) {
    // A scratch project bound to an already-open Studio place: the viewer reads it (read-only), so the
    // real replica can be checked without touching that place's own project.
    await core.call('projects.create', { name: 'Viewer check', rootPath: join(smokeOut!, 'viewer-check'), open: true }).catch((e) => mainLog('warn', 'smoke-bind create failed', String(e)));
    await core.call('project.settings.update', { settings: { robloxStudioMatch: process.argv[bindIdx + 1] } }).catch((e) => mainLog('warn', 'smoke-bind failed', String(e)));
    await wait(5000);
    const worldIdx = process.argv.indexOf('--smoke-world');
    if (worldIdx >= 0 && process.argv[worldIdx + 1]) {
      // Build a real project's world into the bound (scratch) place with the app's own rebuild.
      const src = process.argv[worldIdx + 1]!;
      const dst = join(smokeOut!, 'viewer-check', 'world');
      mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(src)) if (/\.(luau|json)$/.test(f)) copyFileSync(join(src, f), join(dst, f));
      const built = await core.call('roblox.rebuildWorld', {}, 10 * 60_000).catch((e) => ({ error: String(e) }));
      worldReport = built;
      await wait(3000);
    }
  }
  // Seed data through the app's own RPCs: --smoke-rpc-file <file with [{"method": ..., "params": ...}]>
  // (a file, because JSON quotes don't survive Windows command shims).
  const rpcReport: unknown[] = [];
  const rpcIdx = process.argv.indexOf('--smoke-rpc-file');
  let seeds: Array<{ method: string; params?: unknown }> = [];
  if (rpcIdx >= 0 && process.argv[rpcIdx + 1]) {
    try {
      seeds = JSON.parse(readFileSync(process.argv[rpcIdx + 1]!, 'utf8')) as typeof seeds;
    } catch (e) {
      rpcReport.push({ error: `bad --smoke-rpc-file: ${(e as Error).message}` });
    }
  }
  for (const [n, { method, params }] of seeds.entries()) {
    const t0 = Date.now();
    const r = await core.call(method, params, 120_000).then(
      (v) => {
        // Pictures in a result (a tool's image content) are saved next to the report.
        const content = (v as { content?: Array<{ type?: string; data?: string; mimeType?: string }> } | null)?.content ?? [];
        content.forEach((c, i) => c.type === 'image' && c.data && writeFileSync(join(smokeOut!, `rpc-${n}-${i}.${c.mimeType === 'image/png' ? 'png' : 'jpg'}`), Buffer.from(c.data, 'base64')));
        return { method, ok: true, ms: Date.now() - t0, result: JSON.stringify(v, (k, x) => (k === 'data' && typeof x === 'string' && x.length > 200 ? `<${x.length} chars>` : x)).slice(0, 600) };
      },
      (e) => ({ method, ok: false, ms: Date.now() - t0, error: String(e).slice(0, 600) }),
    );
    rpcReport.push(r);
    mainLog('info', 'smoke rpc', r);
  }
  await win.webContents.executeJavaScript('window.__shurikenAutoSelect = true');
  // --smoke-theme <id>: every view in that colour theme (lib/appearance.ts; the other windows follow by the storage event).
  const themeIdx = process.argv.indexOf('--smoke-theme');
  if (themeIdx >= 0 && /^[a-z]+$/.test(process.argv[themeIdx + 1] ?? '')) {
    const theme = process.argv[themeIdx + 1]!;
    await win.webContents.executeJavaScript(`localStorage.setItem('shuriken.theme', '${theme}'); document.documentElement.dataset.theme = '${theme}'; window.dispatchEvent(new Event('shuriken:appearance'))`).catch(() => undefined);
  }
  const viewsIdx = process.argv.indexOf('--smoke-views');
  // Views may be URL-encoded: an argument with a colon ("viewer@script:src/…") never reaches the app.
  const views = viewsIdx >= 0 && process.argv[viewsIdx + 1] ? process.argv[viewsIdx + 1]!.split(',').map((v) => decodeURIComponent(v)) : (((await win.webContents.executeJavaScript('window.__shurikenViews ?? []')) as string[]) ?? []);
  const report: Record<string, unknown> = { core: core.status, views: [] as unknown[], world: worldReport, rpc: rpcReport };
  // Never let one page stall the whole run: every step is bounded and failures are recorded.
  const bounded = <T,>(p: Promise<T>, ms: number, what: string) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);
  for (const v of views) {
    const t0 = Date.now();
    try {
      await bounded(win.webContents.executeJavaScript(`window.__shurikenSetView(${JSON.stringify(v)})`), 10_000, 'setView');
      await wait(2500);
      // Make sure the new view has painted before capturing (off-screen windows can lag a frame).
      await bounded(win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'), 10_000, 'paint');
      win.webContents.invalidate();
      await wait(300);
      const img = await bounded(win.webContents.capturePage(), 15_000, 'capture');
      writeFileSync(join(smokeOut!, `${v.replace(/[^\w.-]+/g, '-')}.png`), img.toPNG());
      const errors = (await bounded(win.webContents.executeJavaScript('window.__shurikenErrors ?? []'), 10_000, 'errors')) as string[];
      (report.views as unknown[]).push({ view: v, errors, ms: Date.now() - t0 });
    } catch (e) {
      (report.views as unknown[]).push({ view: v, errors: [`smoke step failed: ${(e as Error).message}`], ms: Date.now() - t0 });
    }
    mainLog('info', 'smoke view', { view: v, ms: Date.now() - t0 });
  }
  // --smoke-js-file <file>: run a snippet in the tab (open a menu, click something), then capture js.png.
  const jsIdx = process.argv.indexOf('--smoke-js-file');
  if (jsIdx >= 0 && process.argv[jsIdx + 1]) {
    try {
      // --smoke-profile: a CPU profile of the page while the snippet runs (cpu.cpuprofile, opens in Chrome's DevTools).
      const profile = process.argv.includes('--smoke-profile');
      if (profile) {
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Profiler.enable');
        await win.webContents.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 500 });
        await win.webContents.debugger.sendCommand('Profiler.start');
      }
      report.js = await bounded(win.webContents.executeJavaScript(readFileSync(process.argv[jsIdx + 1]!, 'utf8')), 180_000, 'js');
      if (profile) {
        const { profile: cpu } = (await win.webContents.debugger.sendCommand('Profiler.stop')) as { profile: unknown };
        writeFileSync(join(smokeOut!, 'cpu.cpuprofile'), JSON.stringify(cpu));
        win.webContents.debugger.detach();
      }
      await wait(900);
      writeFileSync(join(smokeOut!, 'js.png'), (await win.webContents.capturePage()).toPNG());
    } catch (e) {
      report.js = { error: String(e) };
    }
  }
  if (process.argv.includes('--smoke-calibrate')) {
    // Replica vs Studio from the same pose: sweep the lighting multipliers and keep the closest match.
    const js = <T,>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
    await js(`window.__shurikenSetView('viewer')`);
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000 && !((await js<number>('window.__shurikenViewer?.parts?.() ?? 0')) > 0)) await wait(1000);
    await wait(4000); // terrain and textures
    await js('window.__shurikenViewer.frameMap()');
    await wait(1500);
    const pose = await js<{ pos: number[]; look: number[] }>('window.__shurikenViewer.pose()');
    const withRefs = process.argv.includes('--smoke-ref');
    let studio = withRefs ? null : ((await core.call('viewer.shot', { camera: pose.pos, lookAt: pose.look }, 90_000).catch(() => null)) as string | null);
    if (!withRefs) {
      await wait(1200);
      studio = ((await core.call('viewer.shot', { camera: pose.pos, lookAt: pose.look }, 90_000).catch(() => null)) as string | null) ?? studio;
    }
    type Stats = { r: number; g: number; b: number; l: number; sd: number };
    const stats = (url: string, aspect?: number) => js<Stats | null>(`window.__shurikenViewer.stats(${JSON.stringify(url)}, ${aspect ?? 0})`);
    const cal: Record<string, unknown> = { pose };
    // Reference renders taken earlier in Studio with known camera poses: --smoke-ref <image>|x,y,z|x,y,z
    const refs: Array<{ file: string; pose: { pos: number[]; look: number[] } }> = [];
    process.argv.forEach((a, i) => {
      if (a !== '--smoke-ref') return;
      const [file, p, l] = (process.argv[i + 1] ?? '').split('|');
      if (file && p && l) refs.push({ file, pose: { pos: p.split(',').map(Number), look: l.split(',').map(Number) } });
    });
    if (refs.length) {
      const aspect = await js<number>('window.__shurikenViewer.aspect()');
      const targets: Array<Stats | null> = [];
      for (const r of refs) {
        const mime = /\.png$/i.test(r.file) ? 'image/png' : 'image/jpeg';
        targets.push(await stats(`data:${mime};base64,${readFileSync(r.file).toString('base64')}`, aspect));
      }
      const render = async (i: number) => {
        await js(`window.__shurikenViewer.frame(${JSON.stringify(refs[i]!.pose)})`);
        await wait(260);
        return js<string>('window.__shurikenViewer.snapshot(480)');
      };
      const results: Array<{ t: Record<string, number>; err: number; per: number[] }> = [];
      for (const exposure of [0.6, 0.75, 0.9, 1.05, 1.2])
        for (const sun of [0.5, 0.7, 0.9, 1.1])
          for (const hemi of [0.5, 0.7, 0.9, 1.1])
            for (const fog of [0.35, 0.7, 1.0]) {
              const t = { exposure, sun, hemi, ambient: hemi, fog };
              await js(`window.__shurikenViewer.tune(${JSON.stringify(t)})`);
              const per: number[] = [];
              for (let i = 0; i < refs.length; i++) {
                const s = await stats(await render(i));
                const target = targets[i];
                if (!s || !target) continue;
                per.push(Math.abs(s.l - target.l) + 0.35 * (Math.abs(s.r - target.r) + Math.abs(s.g - target.g) + Math.abs(s.b - target.b)) + 0.6 * Math.abs(s.sd - target.sd));
              }
              if (per.length) results.push({ t, err: per.reduce((a, b) => a + b, 0) / per.length, per });
            }
      results.sort((a, b) => a.err - b.err);
      cal.refTargets = targets;
      cal.refBest = results.slice(0, 6);
      if (results[0]) {
        await js(`window.__shurikenViewer.tune(${JSON.stringify(results[0].t)})`);
        for (let i = 0; i < refs.length; i++) {
          const url = await render(i);
          await wait(200);
          const hi = await js<string>('window.__shurikenViewer.snapshot(1280)');
          writeFileSync(join(smokeOut!, `calib-ref${i}-replica.jpg`), Buffer.from((hi || url).split(',')[1]!, 'base64'));
        }
      }
    }
    if (studio && !refs.length) {
      writeFileSync(join(smokeOut!, 'calib-studio.png'), Buffer.from(studio.split(',')[1]!, 'base64'));
      const target = await stats(studio);
      cal.studio = target;
      const before = await js<string>('window.__shurikenViewer.snapshot(1280)');
      writeFileSync(join(smokeOut!, 'calib-replica-before.jpg'), Buffer.from(before.split(',')[1]!, 'base64'));
      cal.before = await stats(before);
      const results: Array<{ t: Record<string, number>; s: Stats; err: number }> = [];
      for (const exposure of [0.55, 0.7, 0.85, 1.0])
        for (const sun of [0.45, 0.7, 1.0])
          for (const hemi of [0.35, 0.6, 1.0])
            for (const fog of [0, 0.3, 1.0]) {
              const t = { exposure, sun, hemi, ambient: hemi, fog };
              await js(`window.__shurikenViewer.tune(${JSON.stringify(t)})`);
              await wait(220);
              const s = await stats(await js<string>('window.__shurikenViewer.snapshot(320)'));
              if (!s || !target) continue;
              const err = Math.abs(s.l - target.l) + 0.35 * (Math.abs(s.r - target.r) + Math.abs(s.g - target.g) + Math.abs(s.b - target.b)) + 0.6 * Math.abs(s.sd - target.sd);
              results.push({ t, s, err });
            }
      results.sort((a, b) => a.err - b.err);
      cal.best = results.slice(0, 5);
      if (results[0]) {
        await js(`window.__shurikenViewer.tune(${JSON.stringify(results[0].t)})`);
        await wait(400);
        const after = await js<string>('window.__shurikenViewer.snapshot(1280)');
        writeFileSync(join(smokeOut!, 'calib-replica-best.jpg'), Buffer.from(after.split(',')[1]!, 'base64'));
      }
    }
    report.calibration = cal;
  }
  if (process.argv.includes('--smoke-kiln') && kilnDocks) {
    // The user's running Kiln (never started by a smoke run) docked on the Kiln page, pulled out into
    // its own window and docked back: the view must stay the same page (no reload) throughout.
    const docks = kilnDocks;
    const probe = `({ host: typeof window.kilnHost, app: window.kilnHost && window.kilnHost.app, dock: window.kilnHost && window.kilnHost.dockState(), path: location.pathname, embed: new URLSearchParams(location.search).get('embed'), root: !!document.getElementById('root'), marker: window.__shurikenMarker ?? null })`;
    report.kiln = await bounded(
      (async () => {
        await win.webContents.executeJavaScript(`window.__shurikenSetView('kiln')`);
        let info = docks.inspect(ws.id);
        const until = Date.now() + 30_000;
        while ((info.status.state !== 'ready' || !info.contents || info.contents.isLoading()) && Date.now() < until) {
          await wait(300);
          info = docks.inspect(ws.id);
        }
        const view = info.contents;
        if (!view || info.status.state !== 'ready') return { status: info.status };
        await wait(2500);
        const at = docks.inspect(ws.id);
        const docked = { ...(await view.executeJavaScript(probe)), bounds: at.bounds, visible: at.visible, pageRect: at.page?.rect ?? null };
        writeFileSync(join(smokeOut!, 'kiln-docked.png'), (await view.capturePage()).toPNG());
        writeFileSync(join(smokeOut!, 'kiln-page.png'), (await win.webContents.capturePage()).toPNG());
        await view.executeJavaScript('window.__shurikenMarker = 7');
        docks.toggleTab(ws.id);
        await wait(3000);
        const own = docks.inspect(ws.id).window;
        const undocked = { ...(await view.executeJavaScript(probe)), bounds: docks.inspect(ws.id).bounds, visible: docks.inspect(ws.id).visible };
        writeFileSync(join(smokeOut!, 'kiln-undocked.png'), (await view.capturePage()).toPNG());
        if (own) writeFileSync(join(smokeOut!, 'kiln-undocked-header.png'), (await own.webContents.capturePage()).toPNG());
        docks.toggleTab(ws.id);
        await wait(2000);
        const back = await view.executeJavaScript(probe);
        return { status: docks.inspect(ws.id).status, docked, undocked: { ...undocked, ownWindow: !!own }, back, windowClosed: !docks.undocked(ws.id) };
      })(),
      90_000,
      'kiln',
    ).catch((e) => ({ error: (e as Error).message }));
  }
  if (process.argv.includes('--smoke-crash')) {
    // Crash the core mid-session and measure recovery: the supervisor must restart it, the project
    // must reopen, and RPC must work again.
    const t0 = Date.now();
    core.simulateCrash();
    await wait(300);
    const deadline2 = Date.now() + 60000;
    while (core.status.state !== 'ready' && Date.now() < deadline2) await wait(200);
    let project: unknown = null;
    let rpcOk = false;
    try {
      project = await core.call('project.current', {}, 20000);
      rpcOk = true;
    } catch (e) {
      project = String(e);
    }
    await win.webContents.executeJavaScript(`window.__shurikenSetView('dashboard')`);
    await wait(2500);
    writeFileSync(join(smokeOut!, 'after-crash.png'), (await win.webContents.capturePage()).toPNG());
    report.crashRecovery = { recovered: core.status.state === 'ready' && rpcOk, ms: Date.now() - t0, status: core.status, project };
  }
  if (process.argv.includes('--smoke-windows')) {
    const f = ws.frame;
    // A second project window gets its own engine; both answer RPC independently.
    const second = createTab({ openProject: null, activate: false, frame: f });
    const deadline3 = Date.now() + 60000;
    while (second.core.status.state !== 'ready' && Date.now() < deadline3) await wait(200);
    // Window 1 builds project A; window 2 may not open A too, but runs its own project B.
    const call = (c: CoreSupervisor, m: string, p: unknown) => c.call(m, p, 30000).then((r) => ({ ok: true, r }), (e: Error) => ({ ok: false, r: e.message }));
    const a = (await call(core, 'projects.create', { name: 'Smoke A', rootPath: join(smokeOut!, 'proj-a'), open: true })).r as { id?: string };
    const refused = await call(second.core, 'projects.open', { id: a?.id });
    const b = await call(second.core, 'projects.create', { name: 'Smoke B', rootPath: join(smokeOut!, 'proj-b'), open: true });
    const [pa, pb] = await Promise.all([call(core, 'project.current', {}), call(second.core, 'project.current', {})]);
    report.windows = {
      count: workspaces.size,
      secondReady: second.core.status.state === 'ready',
      sameProjectRefused: !refused.ok && /already open/.test(String(refused.r)),
      refusal: refused.r,
      secondCreated: b.ok,
      firstProject: (pa.r as { name?: string } | null)?.name ?? pa.r,
      secondProject: (pb.r as { name?: string } | null)?.name ?? pb.r,
    };
    // The bar shows both by name (and their lights) once their projects report in.
    await wait(1500);
    report.tabs = stripState(f).tabs;
    const strip = f.win.webContents;
    const shot = async (name: string, wc: WebContents | null | undefined, rect?: Electron.Rectangle) => {
      try {
        if (wc && !wc.isDestroyed()) writeFileSync(join(smokeOut!, name), (await wc.capturePage(rect)).toPNG());
      } catch (e) {
        mainLog('warn', `capture ${name} failed`, String(e));
      }
    };
    // How each light draws on the bar (states faked for the picture only, then put back).
    {
      const st = stripState(f);
      const names = ['Lava Obby', 'Horror Escape', 'Pizza Tycoon', 'Racing Rivals'];
      const states: Array<[TabInfo['state'], string]> = [['working', '2 agents working'], ['input', 'Needs your answer'], ['paused', 'Paused'], ['idle', 'Idle']];
      const fake = states.map(([state, detail], i) => ({ id: 1000 + i, title: names[i]!, busy: state === 'working', state, detail, active: i === 0 }));
      barFrozen = true;
      strip.send('tabs:changed', { ...st, tabs: fake });
      await wait(500);
      await shot('lights.png', strip, { x: 0, y: 0, width: 1100, height: STRIP });
      barFrozen = false;
      sendTabs(f);
      await wait(300);
    }
    // The bar's menus open in the page below it: the Projects menu, then the front window's options.
    await strip.executeJavaScript(`window.shuriken.tabs.menu({ kind: 'projects' })`);
    await wait(900);
    await shot('menu-projects.png', pageOf(f.active), { x: 0, y: 0, width: 760, height: 560 });
    const projectsMenu = (await pageOf(f.active)?.executeJavaScript(`!!document.querySelector('[data-strip-menu="projects"]')`).catch(() => false)) ?? false;
    await strip.executeJavaScript(`window.shuriken.tabs.menu({ kind: 'window', x: 180 })`);
    await wait(700);
    await shot('menu-window.png', pageOf(f.active), { x: 0, y: 0, width: 760, height: 360 });
    const windowMenu = (await pageOf(f.active)?.executeJavaScript(`[...document.querySelectorAll('[data-strip-menu="window"] button')].map((b) => b.textContent)`).catch(() => null)) as string[] | null;
    await strip.executeJavaScript(`window.shuriken.tabs.menu({ kind: 'none' })`);
    await wait(300);
    // Switch, pull the second window out into an app window of its own and dock it back (the menu's
    // calls), then drag-and-drop: let go far away (pulls it out), let go on the first bar (docks it).
    await strip.executeJavaScript(`window.shuriken.tabs.select(${second.id})`);
    const switched = f.active === second;
    await pageOf(second)!.executeJavaScript('window.__smokeMarker = 42');
    await pageOf(second)!.executeJavaScript(`window.shuriken.tabs.detach(${second.id})`);
    await wait(900);
    const out = second.frame;
    out.win.showInactive();
    await wait(600);
    const detached = frames.length === 2 && out !== f && f.tabs.length === 1 && out.tabs.length === 1 && f.active === ws;
    // The page moved without reloading: what it set before is still there.
    const kept = (await pageOf(second)?.executeJavaScript('window.__smokeMarker === 42').catch(() => false)) ?? false;
    await shot('detached-strip.png', out.win.webContents, { x: 0, y: 0, width: 900, height: STRIP });
    await pageOf(second)!.executeJavaScript(`window.shuriken.tabs.dock(${second.id})`);
    await wait(900);
    const docked = frames.length === 1 && second.frame === f && f.tabs.length === 2 && f.active === second;
    const fb = f.win.getContentBounds();
    await dropTab(second, fb.x + fb.width + 400, fb.y + 300);
    await wait(900);
    const dropOut = frames.length === 2 && second.frame !== f;
    second.frame.win.showInactive();
    await dropTab(second, fb.x + 40, fb.y + 12);
    await wait(900);
    const dropIn = frames.length === 1 && second.frame === f && f.tabs[0] === second;
    // The same by hand on the bar: press on the second window, drag it down off the bar, let go; then
    // from its own app window's bar, drag it back onto the first one's.
    const handDrag = async (bar: WebContents, index: number, to: (p: { x: number; y: number }) => { x: number; y: number }) => {
      // (A bar just created may not have drawn its windows yet.)
      let p: { x: number; y: number } | null = null;
      for (let i = 0; i < 50 && !p; i++) {
        p = (await bar.executeJavaScript(`(() => { const el = document.querySelectorAll('[data-seg]')[${index}]; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`)) as { x: number; y: number } | null;
        if (!p) await wait(100);
      }
      if (!p) throw new Error(`no window ${index} on the bar`);
      const end = to(p);
      bar.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        bar.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x + ((end.x - p.x) * i) / 8), y: Math.round(p.y + ((end.y - p.y) * i) / 8), button: 'left', modifiers: ['leftbuttondown'] });
        await wait(25);
      }
      bar.sendInputEvent({ type: 'mouseUp', x: Math.round(end.x), y: Math.round(end.y), button: 'left', clickCount: 1 });
      await wait(1200);
    };
    let handOut: boolean | null = null;
    let handIn: boolean | null = null;
    let handError: string | null = null;
    try {
      await handDrag(strip, f.tabs.indexOf(second), (p) => ({ x: p.x + 120, y: p.y + 260 }));
      handOut = frames.length === 2 && second.frame !== f;
      if (handOut) {
        second.frame.win.showInactive();
        await wait(500);
        const sc = second.frame.win.getContentBounds();
        await handDrag(second.frame.win.webContents, 0, () => ({ x: fb.x + 300 - sc.x, y: fb.y + 14 - sc.y }));
        handIn = frames.length === 1 && second.frame === f;
      }
    } catch (e) {
      handError = (e as Error).message;
    }
    report.dock = { detached, kept, docked, dropOut, dropIn, handOut, handIn, handError, projectsMenu, windowMenu };
    // Whatever the hand test left, the second window is docked in the first app window from here on.
    if (second.frame !== f) moveTab(second, f, f.tabs.length);
    await wait(500);
    // Open blank from the second window (it has a project, so a third window opens with the blank one).
    const before3 = workspaces.size;
    const blank = (await pageOf(second)!.executeJavaScript('window.shuriken.windows.blank()').catch((e: Error) => ({ error: e.message }))) as { here?: boolean; error?: string };
    const third = f.active;
    const deadline4 = Date.now() + 60000;
    while (third && third !== second && !third.projectId && Date.now() < deadline4) await wait(200);
    await wait(2500);
    const blankInfo = third && third !== second && third !== ws ? await call(third.core, 'project.settings', {}) : null;
    report.blank = {
      here: blank?.here ?? blank?.error,
      newWindow: workspaces.size === before3 + 1,
      title: third ? tabInfo(third).title : null,
      blankFlag: (blankInfo?.r as { extras?: { blank?: boolean } } | undefined)?.extras?.blank === true,
      page: third ? await pageOf(third)?.executeJavaScript('location.hash').catch(() => null) : null,
    };
    await shot('blank.png', pageOf(third));
    if (third && third !== second && third !== ws) closeTab(third);
    await wait(500);
    await strip.executeJavaScript(`window.shuriken.tabs.close(${second.id})`);
    await wait(300);
    const closed = !workspaces.has(second.id) && f.active === ws;
    const before = f.tabs.length;
    ws.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
    await wait(500);
    const ctrlT = f.tabs.length === before + 1 && f.active !== ws;
    f.active!.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] });
    await wait(500);
    report.tabActions = { switched, closed, ctrlT, ctrlW: f.tabs.length === before && f.active === ws };
    await second.core.stop();
    // Closing a pulled-out app window that holds two project windows closes both, and only that one.
    const x1 = createTab({ openProject: null, frame: f });
    await wait(800);
    const own = detachTab(x1);
    const x2 = own ? createTab({ openProject: null, frame: own }) : null;
    await wait(1200);
    const errorsBefore = uncaughtSeen.length;
    own?.win.close();
    await wait(1500);
    report.closeAppWindow = { closed: !!own && own.win.isDestroyed(), windowsGone: !workspaces.has(x1.id) && !!x2 && !workspaces.has(x2.id), appWindows: frames.length, firstIntact: f.tabs.length === before && f.active === ws, errors: uncaughtSeen.length - errorsBefore };
  }
  report.front = workspaces.has(ws.id) ? tabInfo(ws) : null;
  // The bar along the top (the app window's own page, above the project windows).
  const bar = live(ws.frame);
  if (bar) {
    try {
      const [w] = bar.win.getContentSize();
      writeFileSync(join(smokeOut!, 'strip.png'), (await bar.win.webContents.capturePage({ x: 0, y: 0, width: w ?? 1600, height: STRIP })).toPNG());
    } catch (e) {
      mainLog('warn', 'strip capture failed', String(e));
    }
  }
  report.perf = {
    rpc: [...perf.rpc.entries()].map(([method, x]) => ({ method, n: x.n, totalMs: Math.round(x.total), avgMs: Math.round(x.total / x.n), maxMs: Math.round(x.max), kb: Math.round(x.bytes / 1024) })).sort((a, b) => b.totalMs - a.totalMs),
    events: [...perf.events.entries()].map(([channel, n]) => ({ channel, n })).sort((a, b) => b.n - a.n),
  };
  report.uncaught = [...uncaughtSeen];
  writeFileSync(join(smokeOut!, 'report.json'), JSON.stringify(report, null, 2));
  mainLog('info', 'smoke complete', report);
  await core.stop();
  // Errors on the way down (this core, closed tabs' cores) count too.
  await wait(800);
  if (uncaughtSeen.length !== (report.uncaught as string[]).length) {
    report.uncaught = [...uncaughtSeen];
    writeFileSync(join(smokeOut!, 'report.json'), JSON.stringify(report, null, 2));
  }
  app.exit(0);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

app.on('second-instance', (_e, argv) => {
  const f = live(lastFrame) ?? mainFrame();
  const target = f?.active ?? f?.tabs[0] ?? null;
  if (target) focus(target);
  // `Shuriken Studio --prompt "…"` starts a build in the running app (same as the start page), in the
  // front tab when it has no project yet, otherwise in a new tab.
  const i = argv.indexOf('--prompt');
  const prompt = i >= 0 ? argv[i + 1] : undefined;
  if (prompt?.trim()) {
    journal?.record('main', 'cli.prompt', { prompt });
    const ws = target && !target.projectId ? target : createTab({ openProject: null, frame: f });
    void ws.core
      .call('projects.createFromPrompt', { prompt })
      .then(() => send(ws, 'core:event', 'app.navigate', { page: 'dashboard' }))
      .catch((e) => mainLog('error', 'CLI prompt failed', e));
  }
});

/** Kiln docked in project windows (see kiln-dock.ts); created once the app is ready. */
let kilnDocks: KilnDocks | null = null;
function createKilnDocks(): KilnDocks {
  return new KilnDocks({
    placeOf: (tabId) => {
      const ws = workspaces.get(tabId);
      const f = live(ws?.frame);
      return ws && f ? { win: f.win, top: STRIP, front: f.active === ws } : null;
    },
    pageOf: (tabId) => pageOf(workspaces.get(tabId)),
    tabOf: (wc) => (workspaces.has(wc.id) ? wc.id : null),
    trustedRenderer: isTrustedRenderer,
    projectName: (tabId) => workspaces.get(tabId)?.projectName ?? null,
    callCore: (tabId, method, params, timeoutMs) => {
      const ws = workspaces.get(tabId);
      if (!ws) return Promise.reject(new Error('That project window is closed'));
      return ws.core.call(method, params, timeoutMs ?? 30_000);
    },
    prefs: async (tabId) => {
      // Test runs never start the user's Kiln (a smoke run only looks at a running one with --smoke-kiln).
      const off = process.env.SHURIKEN_NO_KILN === '1' || (smoke && !process.argv.includes('--smoke-kiln'));
      const ws = workspaces.get(tabId);
      const prefs = ws ? ((await ws.core.call('app.prefs', {}, 10_000).catch(() => null)) as { kilnPath?: string; dockKiln?: boolean } | null) : null;
      if (off) return { exe: null, launch: false, connect: false, docked: true };
      return { exe: prefs?.kilnPath || null, launch: !smoke, connect: true, docked: prefs?.dockKiln !== false };
    },
    loadHeader: (win, tabId) => {
      taskbarIdentity(win);
      const name = workspaces.get(tabId)?.projectName ?? '';
      const target = rendererUrl('kiln', ['kiln-window', `name=${encodeURIComponent(name)}`]);
      if (target.url) void win.loadURL(target.url);
      else void win.loadFile(target.file!, { hash: target.hash, search: target.search });
    },
    pageWebPreferences: () => webPreferences(),
    preload: join(import.meta.dirname, '..', 'preload', 'kiln.cjs'),
    log: (level, msg) => mainLog(level, `kiln: ${msg}`),
  });
}

/** Where Kiln is, for Settings: the exe Shuriken would start, and whether (which version) runs now. */
handleTrusted('kiln:locate', async (_e, configured: unknown) => {
  const rt = readKilnRuntime();
  let running = false;
  if (rt) {
    try {
      process.kill(rt.pid, 0);
      running = true;
    } catch (err) {
      running = (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  return { exe: findKilnExe(typeof configured === 'string' && configured.trim() ? configured.trim() : null), running, version: running ? rt?.version ?? null : null };
});

/** Settings → Agents → "Start Kiln with Shuriken": once, when the first project window's core is up. */
let kilnStartChecked = false;
function startKilnIfWanted(ws: Workspace): void {
  if (kilnStartChecked || smoke || process.env.SHURIKEN_NO_KILN === '1') return;
  kilnStartChecked = true;
  void (async () => {
    const prefs = (await ws.core.call('app.prefs', {}, 15_000).catch(() => null)) as { startKilnWithShuriken?: boolean; kilnPath?: string } | null;
    if (!prefs?.startKilnWithShuriken) return;
    const found = await ensureKiln({ exe: prefs.kilnPath || null, launch: true, log: (m) => mainLog('info', `kiln: ${m}`) });
    mainLog(found.ok ? 'info' : 'warn', found.ok ? `kiln: ${found.launched ? 'started with Shuriken' : 'already running'}` : `kiln: couldn't start (${found.reason})`);
  })();
}

app.whenReady().then(() => {
  if (secondary) return;
  // The Start menu's and the Desktop's shortcuts open this version from now on, when they opened an older side-by-side copy.
  if (process.platform === 'win32' && app.isPackaged && !smoke)
    setTimeout(() => {
      try {
        const changed = repointShortcuts(process.execPath, shortcutFolders({ appData: app.getPath('appData'), desktop: app.getPath('desktop') }));
        if (changed.length) journal?.record('main', 'shortcuts.repointed', { changed, to: process.execPath });
      } catch (e) {
        journal?.record('main', 'shortcuts.repoint-failed', { error: String(e) });
      }
    }, 5000);
  kilnDocks = createKilnDocks();
  if (smoke) {
    // Show inactive and off-screen: WebGL does not present frames in a never-shown window.
    const f = createFrame({ x: -3000, y: 0, width: 1600, height: 1000 + STRIP, maximized: false });
    const ws = createTab({ openProject: 'last', frame: f });
    f.win.showInactive();
    ws.view.webContents.once('did-finish-load', () => void runSmoke(ws));
    return;
  }
  // Windows come back as they were closed, docked as they were: a project on its dashboard, a start
  // page on the start page (nothing opens, or starts working, behind a start page), the same in front.
  const restore = loadOpenTabs();
  const saved: SavedFrame[] = restore.length ? restore : [{ bounds: null, active: 0, tabs: [{ projectId: null }] }];
  for (const [n, s] of saved.entries()) {
    const f = createFrame(s.bounds ?? (n === 0 ? null : undefined));
    const opened = s.tabs.map((t) => createTab({ openProject: t.projectId, activate: false, frame: f }));
    const front = opened[Math.min(s.active, opened.length - 1)] ?? opened[0]!;
    selectTab(front);
  }
  const first = mainFrame();
  if (first?.active) focus(first.active);
  updater.start();
  app.on('activate', () => {
    if (!mainFrame()) createTab({ openProject: null, frame: createFrame() });
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  if (workspaces.size > 0) saveOpenTabs();
  journal?.end('quit');
  void Promise.all([...workspaces.values()].map((w) => w.core.stop())).finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
