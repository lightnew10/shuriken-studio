import { app, BrowserWindow, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { autoUpdater } = electronUpdater;

export interface UpdateStatus {
  state: 'not-configured' | 'dev' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  detail: string;
  version?: string;
}

/** Where the installed app looks for new versions: shuriken.studio serves latest.yml and the installer. */
export const UPDATE_FEED = 'https://shuriken.studio/updates/shuriken-studio';

/**
 * Application updates via electron-updater, from UPDATE_FEED. Nothing downloads without asking: a new version opens
 * a prompt (Update, Not now, Never ask), so a copy someone has changed is never replaced behind their back. Never ask
 * writes {"url": "off"} to userData/update.json; a machine can also point elsewhere there or with SHURIKEN_UPDATE_URL.
 */
export class Updater {
  status: UpdateStatus = { state: 'not-configured', detail: 'No update feed configured' };
  private timer: NodeJS.Timeout | null = null;
  private asking = false;
  private readonly dismissed = new Set<string>();

  constructor(
    private readonly userData: string,
    private readonly packaged: boolean,
    private readonly onStatus: (s: UpdateStatus) => void,
    private readonly log: (level: string, msg: string, data?: unknown) => void,
  ) {}

  feedUrl(): string | null {
    const off = (url: string) => (url.trim().toLowerCase() === 'off' ? null : url.trim());
    if (process.env.SHURIKEN_UPDATE_URL) return off(process.env.SHURIKEN_UPDATE_URL);
    const f = join(this.userData, 'update.json');
    if (!existsSync(f)) return UPDATE_FEED;
    try {
      const url = (JSON.parse(readFileSync(f, 'utf8')) as { url?: string }).url;
      return url ? off(url) : UPDATE_FEED;
    } catch {
      return UPDATE_FEED;
    }
  }

  start(): void {
    if (!this.packaged) return this.set({ state: 'dev', detail: 'Updates are disabled in development builds' });
    const url = this.feedUrl();
    if (!url) return this.set({ state: 'not-configured', detail: 'Updates are off (SHURIKEN_UPDATE_URL or update.json says off)' });
    autoUpdater.setFeedURL({ provider: 'generic', url });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', detail: 'Checking for updates…' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'idle', detail: 'Up to date' }));
    autoUpdater.on('update-available', (i) => {
      this.set({ state: 'available', detail: `Version ${i.version} is available`, version: i.version });
      void this.ask(i.version);
    });
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'ready', detail: `Version ${i.version} will install on restart`, version: i.version }));
    autoUpdater.on('error', (e) => this.set({ state: 'error', detail: e.message }));
    void this.check();
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.state === 'dev' || this.status.state === 'not-configured') return this.status;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.set({ state: 'error', detail: (e as Error).message });
    }
    return this.status;
  }

  installNow(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall();
  }

  /** Asks once per version per run whether to update. */
  private async ask(version: string): Promise<void> {
    if (this.asking || this.dismissed.has(version)) return;
    this.asking = true;
    try {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const opts = {
        type: 'info' as const,
        title: 'Shuriken Studio update',
        message: `Shuriken Studio ${version} is available`,
        detail: `You have ${app.getVersion()}. It downloads in the background and installs when you restart; your games and settings stay. If you've changed Shuriken Studio's own code, updating replaces those changes.`,
        buttons: ['Update', 'Not now', 'Never ask'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      if (response === 0) {
        this.set({ state: 'downloading', detail: `Downloading ${version}`, version });
        await autoUpdater.downloadUpdate();
      } else if (response === 2) {
        writeFileSync(join(this.userData, 'update.json'), JSON.stringify({ url: 'off' }, null, 2));
        this.set({ state: 'not-configured', detail: 'Updates are off (Never ask)' });
      } else this.dismissed.add(version);
    } catch (e) {
      this.set({ state: 'error', detail: (e as Error).message });
    } finally {
      this.asking = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private set(s: UpdateStatus): void {
    this.status = s;
    this.log('info', `updater: ${s.state}`, s.detail);
    this.onStatus(s);
  }
}
