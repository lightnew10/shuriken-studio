import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopedLogger } from '../../log';
import { errorMessage } from '../../log';
import { LinkServer, type LinkDm, type LinkPlace, type LinkRunResult } from './link-server';
import { LINK_PLUGIN_FILE, LINK_PORTS, LINK_VERSION, linkPluginFile } from './plugin';

/**
 * Shuriken Link as the core sees it: the plugin file in Studio's Plugins folder, this core's end of the connection
 * and the sessions of the place this core's project is bound to. See plugin.ts for what the plugin is and why.
 *
 * Every project window is a core of its own and listens on its own port; they share one key (link.json in the app's
 * data folder) and one plugin file. A Studio window is linked to the core whose project is bound to its place.
 */

export interface StudioLinkDeps {
  /** The app's data folder (the key lives there). */
  dataDir: string;
  /** Studio's Plugins folder; null where there is none to write to (not Windows, tests). */
  pluginsDir: string | null;
  /** The setting: off removes the plugin file and closes the port. */
  enabled: () => boolean;
  /** The place this core's project is bound to (what a Studio instance's name must contain), or null. */
  binding: () => string | null;
  /**
   * The bound place came back under another name (published, or saved as another file): the project follows it.
   * `display` is the name Studio's MCP server lists it under.
   */
  renamed?: (display: string, now: LinkPlace, before: LinkPlace | null) => void;
  /** Sessions came or went (for the status shown in Settings and the health check). */
  changed?: () => void;
  log: ScopedLogger;
  ports?: readonly number[];
}

/** The plugin's link to the project's Studio window, as the Studio adapter uses it (StudioLink itself). */
export interface PlaceLinkView {
  has(dm: LinkDm): boolean;
  waitFor(dm: LinkDm, maxMs: number): Promise<boolean>;
  run(dm: LinkDm, code: string, timeoutMs: number, signal?: AbortSignal): Promise<LinkRunResult> | null;
  endPlay(): void;
  place(): LinkPlace | null;
  lostWithin(ms: number): boolean;
  readonly playProven: boolean;
}

export interface StudioLinkStatus {
  enabled: boolean;
  /** The plugin file is in Studio's Plugins folder, written by this version. */
  installed: boolean;
  pluginFile: string | null;
  /** The port this core listens on (null: not listening). */
  port: number | null;
  /** The DataModels of this project's place that are linked right now. */
  linked: LinkDm[];
  /** Every place a plugin has linked to this core (normally the project's own, once). */
  places: string[];
  version: number;
}

/** Studio's Plugins folder on this PC (Windows), or null. */
export function studioPluginsDir(): string | null {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  return join(process.env.LOCALAPPDATA, 'Roblox', 'Plugins');
}

/** The name Studio's MCP server lists a place under: its file name, or "Name (placeId: N)" once published. */
export const linkDisplayName = (p: Pick<LinkPlace, 'place' | 'placeId'>): string => (p.placeId ? `${p.place} (placeId: ${p.placeId})` : p.place);

/** The shared key: made once, kept in the data folder, never sent anywhere (both ends only prove they hold it). */
export function linkKey(dataDir: string): string {
  const file = join(dataDir, 'link.json');
  try {
    const key = (JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown }).key;
    if (typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)) return key;
  } catch {
    /* made below */
  }
  const key = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  // Another core may be making it at the same moment: the first file wins.
  try {
    writeFileSync(file, `${JSON.stringify({ key }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return key;
  } catch {
    return linkKey(dataDir);
  }
}

/** A Studio window that keeps running a plugin with another key: acted on after this many failed handshakes in the window, at most once per everyMs. */
export const STALE_PLUGIN = { times: 2, windowMs: 5 * 60_000, everyMs: 10 * 60_000 };

const STAMP = /<!\[CDATA\[-- written [^\n]*\n/;
/** The plugin file with a stamp as its source's first line (a Luau comment): the same plugin, a changed file. */
export function stamped(file: string, at: string): string {
  return file.replace('<![CDATA[', `<![CDATA[-- written ${at}\n`);
}
/** The plugin file without its stamp, to compare with what this version writes. */
export function unstamped(file: string): string {
  return file.replace(STAMP, '<![CDATA[');
}

export class StudioLink {
  readonly server: LinkServer;
  private key: string | null = null;
  /** The Studio window (Edit instance) that last linked as this project's place, and what it was called. */
  private claimed: { studio: string; place: LinkPlace } | null = null;
  /** When the project's Edit session last went away (recovery gives the plugin a moment to come back). */
  private lostAt = 0;
  private hadEdit = false;
  /** The playtest's own sessions were seen for this place: the plugin runs there on this Studio. */
  private playSeen = false;

  constructor(private readonly d: StudioLinkDeps) {
    this.server = new LinkServer({
      key: () => (this.key ??= linkKey(d.dataDir)),
      claims: (place, previous) => this.claims(place, previous),
      renamed: (before, now) => this.follow(now, before),
      changed: () => this.onChanged(),
      unproven: (place) => this.onUnproven(place),
      ports: d.ports,
      log: (line) => d.log.info(line),
    });
  }

  private readonly mine = (p: LinkPlace): boolean => {
    const b = this.d.binding();
    return !!b && linkDisplayName(p).toLowerCase().includes(b.toLowerCase());
  };

  private claims(place: LinkPlace, previous: string | null): boolean {
    if (this.mine(place)) {
      this.claimed = { studio: place.studio, place };
      return true;
    }
    // Not the bound name, but the place carries the id of the window that was this project's place, and that
    // window is gone: it is the same place under a new name (Studio reloads a place it has just published).
    if (previous && this.claimed && previous === this.claimed.studio && this.d.binding() && !this.server.has(this.mine, 'Edit')) {
      const before = this.claimed.place;
      this.claimed = { studio: place.studio, place };
      this.follow(place, before);
      return true;
    }
    return false;
  }

  private follow(now: LinkPlace, before: LinkPlace | null): void {
    if (this.claimed && this.claimed.studio === now.studio) this.claimed = { studio: now.studio, place: now };
    if (this.mine(now)) return;
    const display = linkDisplayName(now);
    this.d.log.info(`Shuriken Link: the project's place is now "${display}" (it was "${before ? linkDisplayName(before) : '?'}")`);
    try {
      this.d.renamed?.(display, now, before);
    } catch (e) {
      this.d.log.warn('Following the renamed place failed', errorMessage(e));
    }
  }

  private onChanged(): void {
    const edit = this.server.has(this.mine, 'Edit');
    if (this.hadEdit && !edit) this.lostAt = Date.now();
    this.hadEdit = edit;
    if (this.server.has(this.mine, 'Server')) this.playSeen = true;
    this.d.changed?.();
  }

  /** Edit sessions of the project's place that never got past the handshake (their times, the last 10 minutes). */
  private unprovenAt: number[] = [];
  private refreshedAt = 0;

  /**
   * The project's Studio window runs a plugin that holds another key: it says hello for the place, cannot check this
   * core's proof and never polls, so nothing reaches its Edit DataModel and every code sync waits for every playtest.
   * Seen 2026-10-03: a test put its own plugin file in the Plugins folder and the original back, and Studio kept the
   * test's copy in the open Edit session for half an hour ("port … answered without this plugin's key; ignored").
   * Writing the file again with a new stamp is a change Studio loads; told once more if it doesn't help.
   */
  private onUnproven(place: LinkPlace): void {
    if (!this.mine(place)) return;
    const now = Date.now();
    this.unprovenAt = [...this.unprovenAt.filter((t) => now - t < STALE_PLUGIN.windowMs), now];
    if (this.unprovenAt.length < STALE_PLUGIN.times || now - this.refreshedAt < STALE_PLUGIN.everyMs) return;
    const again = this.refreshedAt > 0 && now - this.refreshedAt < 3 * STALE_PLUGIN.everyMs;
    this.refreshedAt = now;
    this.unprovenAt = [];
    if (this.install({ fresh: true })) {
      this.d.log.warn(
        again
          ? `Shuriken Link: "${linkDisplayName(place)}" still runs a plugin with another key after the file was written again; closing and reopening that Studio window loads the right one`
          : `Shuriken Link: "${linkDisplayName(place)}" runs a plugin with another key (an older copy); the plugin file was written again so Studio loads this one`,
      );
    }
  }

  // ─── Life cycle ─────────────────────────────────────────────────────────────

  /** Writes the plugin file when it is missing or from another version or key, and starts listening. */
  async start(): Promise<void> {
    if (!this.d.enabled()) {
      this.uninstall();
      return;
    }
    this.install();
    await this.server.start().catch((e) => this.d.log.warn('Shuriken Link could not listen', errorMessage(e)));
  }

  async stop(): Promise<void> {
    await this.server.stop().catch(() => undefined);
  }

  /** The setting changed. */
  async apply(): Promise<void> {
    if (this.d.enabled()) await this.start();
    else {
      await this.stop();
      this.uninstall();
    }
    this.d.changed?.();
  }

  private pluginPath(): string | null {
    return this.d.pluginsDir ? join(this.d.pluginsDir, LINK_PLUGIN_FILE) : null;
  }

  /**
   * True when the file is there with this version's content. `fresh`: written again whatever is there, with a new
   * stamp (a comment), so Studio sees a changed plugin and loads it into windows that run an older copy.
   */
  install(opts: { fresh?: boolean } = {}): boolean {
    const file = this.pluginPath();
    if (!file) return false;
    try {
      const want = linkPluginFile({ key: (this.key ??= linkKey(this.d.dataDir)), ports: this.d.ports ?? LINK_PORTS });
      if (!opts.fresh && existsSync(file) && unstamped(readFileSync(file, 'utf8')) === want) return true;
      mkdirSync(this.d.pluginsDir!, { recursive: true });
      writeFileSync(file, opts.fresh ? stamped(want, new Date().toISOString()) : want, 'utf8');
      this.d.log.info(`Shuriken Link plugin written to ${file} (Studio windows opened from now on load it)`);
      return true;
    } catch (e) {
      this.d.log.warn('Could not write the Shuriken Link plugin', errorMessage(e));
      return false;
    }
  }

  uninstall(): void {
    const file = this.pluginPath();
    if (!file || !existsSync(file)) return;
    try {
      rmSync(file, { force: true });
      this.d.log.info(`Shuriken Link plugin removed (${file})`);
    } catch (e) {
      this.d.log.warn('Could not remove the Shuriken Link plugin', errorMessage(e));
    }
  }

  status(): StudioLinkStatus {
    const file = this.pluginPath();
    let installed = false;
    try {
      installed = !!file && existsSync(file) && readFileSync(file, 'utf8').includes(`local VERSION = ${LINK_VERSION}\n`);
    } catch {
      installed = false;
    }
    const sessions = this.server.list();
    return {
      enabled: this.d.enabled(),
      installed,
      pluginFile: file,
      port: this.server.port,
      linked: sessions.filter((s) => this.mine(s.place)).map((s) => s.dm),
      places: [...new Set(sessions.map((s) => linkDisplayName(s.place)))],
      version: LINK_VERSION,
    };
  }

  // ─── What the Studio adapter uses ───────────────────────────────────────────

  /** A DataModel of the project's place is linked. */
  has(dm: LinkDm): boolean {
    return this.server.has(this.mine, dm);
  }

  /** The plugin has been seen running inside a playtest of this place (so its sessions are worth a short wait). */
  get playProven(): boolean {
    return this.playSeen;
  }

  /** Waits a moment for a playtest's session (its plugin instance starts with the playtest). */
  waitFor(dm: LinkDm, maxMs: number): Promise<boolean> {
    return this.server.waitFor(this.mine, dm, maxMs);
  }

  /** Runs Luau in the project's place through the plugin; null when that DataModel isn't linked. */
  run(dm: LinkDm, code: string, timeoutMs: number, signal?: AbortSignal): Promise<LinkRunResult> | null {
    return this.server.run(this.mine, dm, code, timeoutMs, signal);
  }

  /** The playtest stopped. */
  endPlay(): void {
    this.server.endPlay(this.mine);
  }

  /** The project's place as its Edit session reports it now. */
  place(): LinkPlace | null {
    return this.server.place(this.mine);
  }

  /** The project's Edit session ended within the last `ms`: Studio may only be reloading the place. */
  lostWithin(ms: number): boolean {
    return !this.has('Edit') && this.lostAt > 0 && Date.now() - this.lostAt < ms;
  }
}
