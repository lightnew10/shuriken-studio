import { BrowserWindow, ipcMain, shell, WebContentsView, type WebContents } from 'electron';
import { ensureKiln, isKilnOrigin, kilnAnswers, kilnEmbedUrl, readKilnRuntime, type KilnRuntime } from './kiln-host';

/**
 * Kiln docked in Shuriken: each project window can show Shuriken's own view onto the user's running
 * Kiln (its embedded UI, signed in with the token from runtime.json) on its Kiln page, and pull that
 * same view out into a window of its own (another monitor) and back, without reloading it. The user's
 * own Kiln windows are never touched; the view is an additional client of the same Kiln.
 */

export interface KilnStatus {
  state: 'connecting' | 'ready' | 'unavailable' | 'undocked';
  detail?: string;
}

export interface KilnPageState {
  /** The Kiln page is showing (its area below Shuriken's top bar is `rect`, in page coordinates). */
  shown: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  /** A menu or dialog of Shuriken's is open over that area: the native view steps aside meanwhile. */
  covered?: boolean;
  /** The Kiln project to show (Watch in Kiln); none for Kiln's own start. */
  project?: string | null;
}

export interface KilnDockHost {
  /** The app window a project window is docked in, where its page starts below the bar, whether it's in front. */
  placeOf(tabId: number): { win: BrowserWindow; top: number; front: boolean } | null;
  pageOf(tabId: number): WebContents | null;
  tabOf(page: WebContents): number | null;
  projectName(tabId: number): string | null;
  callCore(tabId: number, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** Where Kiln.exe is, whether Shuriken may start it, and whether it may use Kiln at all (off in test runs). */
  prefs(tabId: number): Promise<{ exe: string | null; launch: boolean; connect: boolean; docked: boolean }>;
  /** Loads Shuriken's slim header page (with its Dock back button) into an undocked window. */
  loadHeader(win: BrowserWindow, tabId: number): void;
  /** Web preferences of Shuriken's own pages (the header of an undocked window is one). */
  pageWebPreferences(): Electron.WebPreferences;
  /** The Kiln view's preload (window.kilnHost). */
  preload: string;
  log(level: 'info' | 'warn', msg: string): void;
}

interface Dock {
  tabId: number;
  view: WebContentsView | null;
  runtime: KilnRuntime | null;
  starting: Promise<void> | null;
  page: KilnPageState;
  project: string | null;
  /** Its own window while undocked. */
  window: BrowserWindow | null;
  /** The window the view is a child of now. */
  parent: BrowserWindow | null;
  status: KilnStatus;
}

/** Height of an undocked window's header (Shuriken's slim bar with Dock back). */
export const KILN_HEADER = 40;
const BG = '#0e0c0b';

export class KilnDocks {
  private readonly docks = new Map<number, Dock>();
  private watcher: NodeJS.Timeout | null = null;

  constructor(private readonly host: KilnDockHost) {
    // From a project window's Kiln page.
    ipcMain.on('kiln:page', (e, state: KilnPageState) => {
      const tab = this.host.tabOf(e.sender);
      if (tab !== null) this.pageChanged(tab, state);
    });
    // From the Kiln page's Undock button, an undocked window's Dock back button, or Kiln itself (kilnHost.toggleDock).
    ipcMain.on('kiln:toggle-dock', (e) => {
      const d = this.dockOfSender(e.sender);
      if (d) this.toggle(d);
    });
    // kilnHost.useModel: a Kiln project into this Shuriken project, as a Roblox model.
    // kilnHost.sendToStudio: that, and straight into the open Studio place.
    ipcMain.handle('kiln:send-to-studio', async (e, args: { kind?: unknown; kilnProjectId?: unknown; name?: unknown; clip?: unknown }) => {
      const d = this.fromKiln(e);
      if (!d) return { ok: false, error: 'Not from Kiln' };
      const kilnProjectId = String(args?.kilnProjectId ?? '');
      const name = String(args?.name ?? '');
      if (!kilnProjectId || !name) return { ok: false, error: 'A Kiln project and a name are needed' };
      try {
        return (await this.host.callCore(d.tabId, 'kiln.sendToStudio', { kind: args?.kind === 'animation' ? 'animation' : 'model', kilnProjectId, name, clip: args?.clip ? String(args.clip) : undefined }, 10 * 60_000)) as { ok: boolean; error?: string };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle('kiln:use-model', async (e, args: { kilnProjectId?: unknown; name?: unknown }) => {
      const d = this.dockOfSender(e.sender);
      if (!d || !d.view || e.sender !== d.view.webContents || !isKilnOrigin(e.senderFrame?.url ?? '', d.runtime)) return { ok: false, error: 'Not from Kiln' };
      const kilnProjectId = String(args?.kilnProjectId ?? '');
      const name = String(args?.name ?? '');
      if (!kilnProjectId || !name) return { ok: false, error: 'A Kiln project and a model name are needed' };
      try {
        return (await this.host.callCore(d.tabId, 'models.fromKiln', { kilnProjectId, name }, 5 * 60_000)) as { ok: boolean; error?: string };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
  }

  /** A request from the Kiln view itself (its origin checked), for the project window it's docked in. */
  private fromKiln(e: Electron.IpcMainInvokeEvent): Dock | null {
    const d = this.dockOfSender(e.sender);
    return d && d.view && e.sender === d.view.webContents && isKilnOrigin(e.senderFrame?.url ?? '', d.runtime) ? d : null;
  }

  /** The dock a message came from: its project window's page, its undocked window's header, or its Kiln view. */
  private dockOfSender(wc: WebContents): Dock | null {
    const tab = this.host.tabOf(wc);
    if (tab !== null) return this.docks.get(tab) ?? null;
    for (const d of this.docks.values()) {
      if (d.view?.webContents === wc) return d;
      if (d.window && !d.window.isDestroyed() && d.window.webContents === wc) return d;
    }
    return null;
  }

  private dock(tabId: number): Dock {
    let d = this.docks.get(tabId);
    if (!d) {
      d = { tabId, view: null, runtime: null, starting: null, page: { shown: false }, project: null, window: null, parent: null, status: { state: 'connecting' } };
      this.docks.set(tabId, d);
    }
    return d;
  }

  private setStatus(d: Dock, status: KilnStatus): void {
    d.status = status;
    this.host.pageOf(d.tabId)?.send('kiln:status', status);
  }

  private pageChanged(tabId: number, state: KilnPageState): void {
    const d = this.dock(tabId);
    const project = state.project ?? null;
    d.page = { ...state, project };
    if (state.shown) {
      this.host.pageOf(tabId)?.send('kiln:status', d.window ? { state: 'undocked' } : d.status);
      if (!d.view && !d.starting) d.starting = this.start(d).finally(() => (d.starting = null));
      else if (d.view && d.runtime && project && project !== d.project) this.open(d, project);
    }
    this.layout(tabId);
  }

  /**
   * Kiln restarts on a new port and token (and can close): while any view is open, runtime.json is
   * watched, a view follows Kiln to its new address, and one whose Kiln closed says so.
   */
  private watch(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => void this.followKiln(), 3000);
    this.watcher.unref();
  }

  private async followKiln(): Promise<void> {
    const views = [...this.docks.values()].filter((d) => d.view);
    if (!views.length) {
      if (this.watcher) clearInterval(this.watcher);
      this.watcher = null;
      return;
    }
    const rt = readKilnRuntime();
    const live = rt ? await kilnAnswers(rt, 1500) : false;
    for (const d of views) {
      if (live && rt && (rt.port !== d.runtime?.port || rt.token !== d.runtime?.token)) {
        this.host.log('info', `Kiln moved to port ${rt.port}; following it`);
        d.runtime = rt;
        this.open(d, d.project);
        this.setStatus(d, { state: 'ready' });
        this.layout(d.tabId);
      } else if (!live && d.status.state === 'ready') {
        this.setStatus(d, { state: 'unavailable', detail: 'Kiln closed. It comes back here when Kiln runs again.' });
        this.layout(d.tabId);
      } else if (live && d.status.state === 'unavailable' && rt && rt.port === d.runtime?.port) {
        this.setStatus(d, { state: 'ready' });
        this.layout(d.tabId);
      }
    }
  }

  /** Finds (or starts) Kiln, then creates the view. */
  private async start(d: Dock): Promise<void> {
    this.setStatus(d, { state: 'connecting' });
    const prefs = await this.host.prefs(d.tabId).catch(() => ({ exe: null, launch: false, connect: true, docked: true }));
    if (!prefs.connect) {
      this.setStatus(d, { state: 'unavailable', detail: 'Kiln is off for this run.' });
      return;
    }
    const found = await ensureKiln({ exe: prefs.exe, launch: prefs.launch, log: (m) => this.host.log('info', m) });
    if (!found.ok) {
      this.setStatus(d, { state: 'unavailable', detail: found.reason });
      return;
    }
    if (!this.docks.has(d.tabId)) return; // the project window closed meanwhile
    d.runtime = found.runtime;
    const view = new WebContentsView({
      webPreferences: { preload: this.host.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:kiln', spellcheck: false },
    });
    view.setBackgroundColor(BG);
    const wc = view.webContents;
    // Kiln's own pages only: anything else opens in the user's browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url) && !isKilnOrigin(url, d.runtime)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (isKilnOrigin(url, d.runtime)) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    });
    wc.on('did-finish-load', () => wc.send('kiln:dock-state', d.window ? 'undocked' : 'docked'));
    wc.on('render-process-gone', () => this.host.log('warn', 'the Kiln view stopped; it reloads when shown again'));
    d.view = view;
    this.watch();
    this.open(d, d.page.project ?? null);
    this.setStatus(d, { state: 'ready', detail: found.launched ? 'Kiln was started in the background' : undefined });
    // Settings → Agents → "Show Kiln docked" off: it opens in its own window.
    if (!prefs.docked) this.toggle(d);
    else this.layout(d.tabId);
  }

  private open(d: Dock, project: string | null): void {
    if (!d.view || !d.runtime) return;
    d.project = project;
    void d.view.webContents.loadURL(kilnEmbedUrl(d.runtime, project)).catch((e) => this.host.log('warn', `the Kiln view didn't load: ${(e as Error).message}`));
  }

  /** Puts the view where it belongs: over its project window's Kiln page, in its own window, or out of sight. */
  layout(tabId: number): void {
    const d = this.docks.get(tabId);
    if (!d?.view) return;
    const view = d.view;
    if (d.window && !d.window.isDestroyed()) {
      this.attach(d, d.window);
      const [w, h] = d.window.getContentSize();
      view.setBounds({ x: 0, y: KILN_HEADER, width: w ?? 0, height: Math.max(0, (h ?? 0) - KILN_HEADER) });
      view.setVisible(true);
      return;
    }
    const place = this.host.placeOf(tabId);
    const r = d.page.rect;
    if (!place || !r) {
      view.setVisible(false);
      return;
    }
    this.attach(d, place.win);
    view.setBounds({ x: Math.round(r.x), y: Math.round(place.top + r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) });
    // While Kiln is closed the page says so instead of showing a dead view.
    view.setVisible(d.page.shown && !d.page.covered && place.front && d.status.state === 'ready');
  }

  /** Makes `win` the view's parent (on top of the page), moving it without a reload. */
  private attach(d: Dock, win: BrowserWindow): void {
    if (!d.view || win.isDestroyed()) return;
    if (d.parent && d.parent !== win && !d.parent.isDestroyed()) d.parent.contentView.removeChildView(d.view);
    // Adding a view it already has brings it to the top (above a project window's page moved in later).
    win.contentView.addChildView(d.view);
    d.parent = win;
  }

  /** Undocks into its own window, or docks back into its project window. */
  toggle(d: Dock): void {
    if (d.window && !d.window.isDestroyed()) return this.dockBack(d);
    if (!d.view) return;
    const name = this.host.projectName(d.tabId);
    const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 420, backgroundColor: BG, title: `Kiln${name ? ` — ${name}` : ''} · Shuriken`, autoHideMenuBar: true, show: false, webPreferences: this.host.pageWebPreferences() });
    d.window = win;
    this.host.loadHeader(win, d.tabId);
    win.once('ready-to-show', () => win.show());
    win.on('resize', () => this.layout(d.tabId));
    // Closing the window docks Kiln back, it doesn't lose it.
    win.on('close', () => {
      if (d.window === win) this.dockBack(d, false);
    });
    d.view.webContents.send('kiln:dock-state', 'undocked');
    this.host.pageOf(d.tabId)?.send('kiln:status', { state: 'undocked' } satisfies KilnStatus);
    this.layout(d.tabId);
  }

  private dockBack(d: Dock, close = true): void {
    const win = d.window;
    d.window = null;
    const place = this.host.placeOf(d.tabId);
    if (d.view && place) this.attach(d, place.win);
    else if (d.view && win && !win.isDestroyed()) win.contentView.removeChildView(d.view);
    if (close && win && !win.isDestroyed()) win.close();
    d.view?.webContents.send('kiln:dock-state', 'docked');
    this.host.pageOf(d.tabId)?.send('kiln:status', d.status);
    this.layout(d.tabId);
  }

  /** Whether a project window's Kiln is in its own window now. */
  undocked(tabId: number): boolean {
    const d = this.docks.get(tabId);
    return !!d?.window && !d.window.isDestroyed();
  }

  /** The project window closed: its view and any undocked window go with it. */
  dispose(tabId: number): void {
    const d = this.docks.get(tabId);
    if (!d) return;
    this.docks.delete(tabId);
    const win = d.window;
    d.window = null;
    if (d.view) {
      if (d.parent && !d.parent.isDestroyed()) d.parent.contentView.removeChildView(d.view);
      d.view.webContents.close();
    }
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** A project window's dock as it is now (smoke checks). */
  inspect(tabId: number): { status: KilnStatus; contents: WebContents | null; window: BrowserWindow | null; bounds: Electron.Rectangle | null; visible: boolean; page: KilnPageState | null } {
    const d = this.docks.get(tabId);
    return {
      status: d?.status ?? { state: 'connecting' },
      contents: d?.view?.webContents ?? null,
      window: d?.window && !d.window.isDestroyed() ? d.window : null,
      bounds: d?.view?.getBounds() ?? null,
      visible: d?.view?.getVisible() ?? false,
      page: d?.page ?? null,
    };
  }

  /** Undocks or docks back a project window's Kiln (as its buttons do). */
  toggleTab(tabId: number): void {
    const d = this.docks.get(tabId);
    if (d) this.toggle(d);
  }

  /** Every docked view steps aside or comes back after a window change (switching, moving, resizing). */
  layoutAll(): void {
    for (const tabId of this.docks.keys()) this.layout(tabId);
  }
}
