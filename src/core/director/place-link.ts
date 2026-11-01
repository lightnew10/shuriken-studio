import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { RobloxStudioInstance } from '@shared/domain';
import { placePath, type ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import { ChatService } from './chat-service';

/**
 * Which Studio window the project is linked to, and whether that window is the project's place file.
 *
 * A project is bound to a Studio window by name (`robloxStudioMatch`, normally the place file's name). After a
 * Studio crash the user may open Studio's auto-recovery copy instead ("<place>_AutoRecovery_0.rbxl"): no window
 * matches any more, every Studio tool fails, and the director could only say "I can't tell from here". This
 * reads Studio's list of open places, tells the cases apart, says once in the chat what is open and what it means
 * for saving, and gives the director the same facts.
 *
 * One step is automatic: when the place file is not open and exactly one open window is a recovery copy of it,
 * the project is linked to that window (in memory only, the saved setting stays), so the team works where the
 * user is. Saving stays the user's: Shuriken saves through the File menu of the window titled with the place file,
 * a window that doesn't exist now, so nothing is ever written to the wrong file. The link returns to the place
 * file by itself once a window has it open again (File > Save As over the place file does that).
 */

export type PlaceLinkKind =
  /** Studio's MCP server isn't connected: nothing is known about its windows. */
  | 'offline'
  /** The project has no place yet (opened blank, nothing started). */
  | 'unlinked'
  /** The project's place is open in Studio. */
  | 'linked'
  /** The place isn't open; one recovery copy of it is. */
  | 'recovery'
  /** The place isn't open; several recovery copies of it are. */
  | 'recoveries'
  /** The place isn't open; other places are. */
  | 'elsewhere'
  /** Studio has no place open. */
  | 'closed';

export interface PlaceLinkFacts {
  kind: PlaceLinkKind;
  /** The project's place file (absolute), or null for a project without one (a published place plugged in by name). */
  placeFile: string | null;
  /** The window name the project's setting asks for. */
  match: string | null;
  /** What Studio calls are sent to right now (the adapter's binding). */
  binding: string | null;
  /** The places open in Studio, as its MCP server names them. */
  open: string[];
  /** The open window that is the project's place, when there is one. */
  place: string | null;
  /** Open windows that are recovery copies of the project's place. */
  recoveries: string[];
  /** Why Studio isn't connected (offline). */
  detail?: string;
  at: number;
}

/** A Studio window's name without the "(placeId: …)" Studio adds for published places. */
export const windowName = (name: string): string => name.replace(/\s*\(placeId:.*$/, '').trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a Studio window is an auto-recovery copy of a place: Studio names them "<place>_AutoRecovery_<n>.rbxl",
 * and "<place>_AutoRecovery_<n>_<date>_<time>.rbxl" once archived (a window may be listed without the extension).
 * `stem` is the place file's name without its extension, or a published place's id.
 */
export function isRecoveryOf(window: string, stem: string): boolean {
  if (!stem) return false;
  return new RegExp(`^${escapeRe(stem)}_AutoRecovery_\\d+(?:_\\d{8}_\\d{6})?(?:\\.rbxlx?)?$`, 'i').test(basename(windowName(window)));
}

/** The link between a project and Studio's open windows, from what is known of both (pure). */
export function readPlaceLink(input: { placeFile: string | null; match: string | null; placeId?: string | null; binding: string | null; connected: boolean; studios: readonly RobloxStudioInstance[] | null; detail?: string; now?: number }): PlaceLinkFacts {
  const at = input.now ?? Date.now();
  const base = { placeFile: input.placeFile, match: input.match, binding: input.binding, at };
  if (!input.connected || !input.studios) return { ...base, kind: 'offline', open: [], place: null, recoveries: [], ...(input.detail ? { detail: input.detail } : {}) };
  // A window that is still loading has no name yet: it is neither the place nor anything else.
  const open = input.studios.map((s) => windowName(s.name)).filter((n) => n && n !== '(loading)');
  if (!input.placeFile && !input.match) return { ...base, kind: 'unlinked', open, place: null, recoveries: [] };
  const fileName = input.placeFile ? basename(input.placeFile).toLowerCase() : null;
  const wanted = input.match?.toLowerCase() ?? null;
  const stems = [input.placeFile ? basename(input.placeFile, extname(input.placeFile)) : null, input.placeId ?? null].filter((s): s is string => !!s);
  const recoveries = open.filter((n) => stems.some((s) => isRecoveryOf(n, s)));
  // The place: the window with the place file (by its name), or for a place without a file the window the setting names.
  const place = open.find((n) => !recoveries.includes(n) && (fileName ? n.toLowerCase().includes(fileName) : !!wanted && n.toLowerCase().includes(wanted))) ?? null;
  const kind: PlaceLinkKind = place ? 'linked' : recoveries.length === 1 ? 'recovery' : recoveries.length > 1 ? 'recoveries' : open.length ? 'elsewhere' : 'closed';
  return { ...base, kind, open, place, recoveries };
}

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`).join(', ');

/** The facts as lines of the director's state (and of the studio_place tool). `playtest`: who holds play mode, if anyone. */
export function placeLinkLines(f: PlaceLinkFacts, opts: { playtest?: string | null } = {}): string[] {
  const lines: string[] = [];
  const file = f.placeFile;
  if (f.kind === 'offline') {
    lines.push(`- Roblox Studio: NOT connected${f.detail ? ` (${f.detail})` : ''}. Which place is open there is unknown; nothing can be read from or built into Studio until it is open with its MCP server on.`);
  } else {
    lines.push(`- Roblox Studio: connected. Open there: ${f.open.length ? quoted(f.open) : 'no place'}.`);
  }
  if (file) {
    let saved = 'the file is missing';
    try {
      if (existsSync(file)) saved = `last saved ${new Date(statSync(file).mtimeMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    } catch {
      /* unreadable: say nothing more */
    }
    lines.push(`- This project's place file: ${file} (${saved}). The code lives in the project folder and is synced into Studio; the map and everything built in Studio is only in that file once Studio saves it.`);
  } else if (f.match) lines.push(`- This project works in the Studio place "${f.match}" (it has no place file of its own).`);
  switch (f.kind) {
    case 'offline':
      break;
    case 'unlinked':
      lines.push('- No Studio place is linked to this project yet.');
      break;
    case 'linked':
      lines.push(`- Linked to "${f.place}": the project's place${file ? ' file' : ''}. Studio calls go there${file ? ', and saving (the auto-save through that window\'s File menu, or the user) writes the place file' : ''}.`);
      if (f.recoveries.length) lines.push(`- Also open: ${f.recoveries.length === 1 ? 'a recovery copy' : 'recovery copies'} of the place (${quoted(f.recoveries)}). The team does NOT work there; if it holds newer work, the user saves it over the place file with File > Save As and closes the other window.`);
      break;
    case 'recovery': {
      const copy = f.recoveries[0]!;
      const linked = f.binding === copy;
      lines.push(
        `- Studio does NOT have the project's place file open. It has a RECOVERY COPY of it: "${copy}" (Studio's auto-recovery file, opened after Studio closed without saving). ${
          linked ? 'The project is linked to that window, so the team reads and builds there.' : `The project is not linked to it (it is linked to "${f.binding ?? f.match ?? 'nothing'}", which is not open), so Studio tools fail until the user saves the copy as the place file or picks it in Settings → Roblox.`
        }`,
        `- Saving: nothing reaches the place file until the user does File > Save As in Studio and saves over ${file ?? 'the place'}. Shuriken cannot do that for them, and its auto-save is off meanwhile. Once the window has the place file open the link goes back by itself.`,
      );
      break;
    }
    case 'recoveries':
      lines.push(`- Studio does NOT have the project's place file open. It has several recovery copies of it: ${quoted(f.recoveries)}. The project is linked to none of them (Shuriken can't tell which one the user means). The user closes the ones they don't want, or saves the right one over ${file ?? 'the place'} with File > Save As; the link follows by itself.`);
      break;
    case 'elsewhere':
      lines.push(`- The project's place is NOT open in Studio (linked to "${f.binding ?? f.match ?? 'nothing'}", which no open window matches), so Studio tools fail for now. ${file ? `It opens by itself when work starts, or the user opens ${basename(file)}. If one of the open places is this game saved under another name, the user saves it over the place file with File > Save As (or picks it in Settings → Roblox).` : 'The user opens it in Studio, or picks the right place in Settings → Roblox.'}`);
      break;
    case 'closed':
      lines.push(`- Studio has no place open. ${file ? `The project's place opens by itself when work starts, or the user opens ${basename(file)}.` : 'The user opens the place in Studio.'}`);
      break;
  }
  if (opts.playtest) lines.push(`- Play mode: held by ${opts.playtest}. Otherwise Studio is in Edit mode as far as Shuriken knows (a playtest the user starts by hand isn't seen without asking Studio).`);
  return lines;
}

export interface PlaceLinkDeps {
  project: () => ProjectContext | null;
  studio: Pick<RobloxStudioAdapter, 'connected' | 'binding' | 'bind' | 'listStudios'> & { conn?: { lastError?: string | null; state?: string } };
  bus: EventBus;
  log: ScopedLogger;
}

/** How often Studio's open windows are looked at while a project is open (the user opens and closes them without telling anyone). */
export const PLACE_LINK = { everyMs: 30_000 };

export class PlaceLink {
  private timer: NodeJS.Timeout | null = null;
  private readonly off: Array<() => void> = [];
  private running: Promise<PlaceLinkFacts | null> | null = null;
  private last: { projectId: string; facts: PlaceLinkFacts } | null = null;
  /** The recovery copy the project is linked to for now (the saved setting still names the place file). */
  private temp: { projectId: string; copy: string } | null = null;

  constructor(private readonly d: PlaceLinkDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), PLACE_LINK.everyMs);
    this.timer.unref?.();
    this.off.push(
      this.d.bus.on('roblox.changed', (e) => {
        if (/^(connection:|studio-opened)/.test(e.reason)) void this.check();
      }),
      this.d.bus.on('project.changed', () => {
        // Another project (or none): its link is its own. The adapter is bound again from its setting when it opens.
        if (this.temp && this.d.project()?.summary.id !== this.temp.projectId) this.temp = null;
        void this.check();
      }),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const f of this.off.splice(0)) f();
  }

  /** What the last look found for the open project (null before the first one). */
  facts(): PlaceLinkFacts | null {
    const p = this.d.project();
    return p && this.last?.projectId === p.summary.id ? this.last.facts : null;
  }

  /** The project is linked to a recovery copy of its place: nothing Shuriken does may save. */
  get onRecovery(): boolean {
    const p = this.d.project();
    return !!p && this.temp?.projectId === p.summary.id;
  }

  /** Looks at Studio's open windows now (one look at a time). Never throws; null without a project. */
  check(): Promise<PlaceLinkFacts | null> {
    if (this.running) return this.running;
    const run = this.look()
      .catch((e) => {
        this.d.log.warn('Could not read which place Studio has open', errorMessage(e));
        return this.facts();
      })
      .finally(() => {
        this.running = null;
      });
    this.running = run;
    return run;
  }

  /** The facts within `ms` (a fresh look if Studio answers in time, else the last one): a chat reply never waits on Studio. */
  async soon(ms = 800): Promise<PlaceLinkFacts | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.check(), new Promise<PlaceLinkFacts | null>((r) => (timer = setTimeout(() => r(this.facts()), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async look(): Promise<PlaceLinkFacts | null> {
    const ctx = this.d.project();
    if (!ctx) return null;
    const studio = this.d.studio;
    const file = placePath(ctx);
    const match = ctx.settings().robloxStudioMatch ?? null;
    const placeId = ctx.extras().adopted?.placeId ?? null;
    const connected = studio.connected;
    const studios = connected ? await studio.listStudios().catch(() => null) : null;
    if (this.d.project() !== ctx) return null;
    const read = () => readPlaceLink({ placeFile: file, match, placeId, binding: studio.binding, connected, studios, detail: connected ? undefined : (studio.conn?.lastError ?? studio.conn?.state ?? undefined) });
    let facts = read();
    // Studio unreachable for a moment says nothing about its windows: the link stays as it is.
    if (facts.kind !== 'offline') {
      this.follow(ctx, facts);
      facts = read();
    }
    this.last = { projectId: ctx.summary.id, facts };
    return facts;
  }

  /** Links to the one recovery copy while the place file isn't open, and back to the place when it is. */
  private follow(ctx: ProjectContext, f: PlaceLinkFacts): void {
    const studio = this.d.studio;
    const id = ctx.summary.id;
    const mine = this.temp?.projectId === id ? this.temp : null;
    if (f.kind === 'recovery' && f.placeFile) {
      const copy = f.recoveries[0]!;
      if (studio.binding !== copy) studio.bind(copy);
      if (mine?.copy !== copy) {
        this.temp = { projectId: id, copy };
        ctx.audit.event({ kind: 'place.recovery', severity: 'warning', title: `Studio has a recovery copy of the place open (${copy}), not the place file: linked to it; saving is the user's (File > Save As)` });
      }
      this.say(
        ctx,
        `recovery:${copy}`,
        `Studio has a recovery copy of your place open (${copy}), not the project's place file. I've linked to that window, so the team and I work in it. I can't save it for you: in Studio use File > Save As and save over ${f.placeFile}. Until then nothing new reaches the place file, and auto-save is off.`,
      );
      return;
    }
    if (mine) {
      // The copy was saved as the place file (or closed): back to the place the project's setting names.
      this.temp = null;
      const back = f.place ?? f.match;
      if (studio.binding === mine.copy && back !== mine.copy) studio.bind(back);
      if (f.kind === 'linked') {
        ctx.audit.event({ kind: 'place.recovery', severity: 'success', title: `Studio has the place file open again (${f.place}): linked to it` });
        this.say(ctx, `linked:${f.place}`, `Studio has the project's place file open again (${f.place}). I'm linked to it, and saving works again.`);
        return;
      }
    }
    if (f.kind === 'recovery' || f.kind === 'recoveries') {
      const copies = f.recoveries.join(', ');
      this.say(
        ctx,
        `copies:${copies}`,
        `Studio has ${f.recoveries.length === 1 ? 'a recovery copy' : 'recovery copies'} of your place open (${copies}) and not the place itself, so I'm not linked to ${f.recoveries.length === 1 ? 'it' : 'any of them'} and can't read or build in Studio. ${
          f.placeFile ? `Close the ones you don't want, or save the right one over ${f.placeFile} with File > Save As: I link to it by myself then.` : 'Publish or save the one you want as the place, or pick it in Settings → Roblox.'
        }`,
      );
    }
  }

  /** One status line per situation: not again while it lasts, nor after a restart that finds it unchanged. */
  private say(ctx: ProjectContext, key: string, text: string): void {
    const chat = new ChatService(ctx, this.d.bus);
    const latest = chat.findLatest('status', (d) => typeof d.placeLink === 'string');
    if (latest?.data?.placeLink === key) return;
    chat.add({ role: 'system', kind: 'status', text, data: { placeLink: key } });
  }
}
