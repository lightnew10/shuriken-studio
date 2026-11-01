import { LOGIN_LOCK, endStudio, hasOpen, holdsLoginLock, startedWith, studioProcesses, stuckAtLogin, type StudioProcess } from './studio-login-lock';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import type { HealthCheckResult, RobloxStudioInstance } from '@shared/domain';
import { McpStdioConnection, type ExternalCallResult } from '../mcp/mcp-client';
import type { CapabilityRegistry } from '../capabilities/capability-registry';
import { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { LUAU_SNAPSHOT, LUAU_TREE, LUAU_DETAIL, LUAU_MOUSE_FREE_CLIENT, luauMouseFree } from './luau-snippets';
import type { DataModelSnapshot } from './snapshot-diff';
import { FOCUS_GUARD, IdleTracker, StudioFocusGuard, UNATTENDED, lowerStudioWindow, raiseStudioWindow, studioWindowState, unminimizeStudioWindow } from './studio-window';
import { currentStudioCaller, type StudioCaller } from './studio-context';
import { clockTime, fmtDuration, playCapped, type LeaseExpiry, type PlaytestLease } from './playtest-lease';
import { waitBudget } from './upload-queue';
import type { PlaceLinkView } from './link/studio-link';
import { BRIDGE_MAX_CODE, CAPABILITY_ERROR, HOSTS_PRESENT, HOSTS_REMOVE, HOSTS_WRITE, HOST_SCRIPTS, NEEDS_GAME_RIGHTS, NO_HOST, RESTRICTED_PROBE, bridgedProgram } from './probe-bridge';

import { STUDIO_FORBIDDEN, studioForbidden } from './studio-guard';
const execFileP = promisify(execFile);
export const STUDIO_INTEGRATION = 'roblox-studio';

/**
 * Characters of node records one snapshot page asks for. Studio cuts an execute_luau result at about
 * 100,000 characters (the viewer's pages use 84,000 for the same reason): a page well under that arrives
 * whole. A page that still comes back cut halves the figure, down to the minimum.
 */
export const SNAPSHOT_PAGE_CHARS = 80_000;
const SNAPSHOT_MIN_PAGE_CHARS = 4_000;
/** A place that keeps changing while its pages are read is read again this many times, then taken as it is. */
const SNAPSHOT_ATTEMPTS = 3;

/**
 * Studio refuses to start or stop play while a start or stop is still going on ("Start play hasn't
 * finished yet"); the same request works a moment later. setPlaying asks again this many times, this far
 * apart (an object so a test can shorten it): a start takes about 3-5 s, so a stop that comes in the
 * middle of one is through within a few tries.
 */
export const PLAY_RETRY = { retries: 5, delayMs: 2000 };
const PLAY_BUSY = /hasn.t finished yet|still (?:starting|stopping)/i;

/**
 * A start that outlasts its request. Studio copies the whole place into a playtest, and on a heavy place late in a
 * long build that took over a minute: Studio's start request timed out at 60 s and the playtest failed while Studio
 * went on loading it, so the load was thrown away and the next agent in line started it again (23 of 170 playtests
 * of the mech build on 2026-10-05). After a timed-out start the playtest is waited for instead: twice the slowest of
 * the recent starts, at least `minMs` and at most `maxMs` (under the five minutes an agent's MCP client sits through
 * without a progress note). A stop that meets a start still under way waits for it the same way. An object so a test
 * can shorten it.
 */
export const PLAY_START = { minMs: 120_000, maxMs: 240_000, pollMs: 1500, clientGraceMs: 60_000 };
const START_TIMED_OUT = /timed out|-32001/i;

/**
 * Waiting for Studio to stop a playtest that has to go: `stopMs` for one past its limits (or whose run ended) before
 * Studio is given to the others anyway, `freeMs` when the user frees Studio. One start or stop of play takes at most
 * `requestMs` (its request) + the slow-start budget (PLAY_START) + `settleMs` (the poll after it). An object so a test
 * can shorten it.
 */
export const ENFORCE = { stopMs: 90_000, freeMs: 30_000, requestMs: 60_000, settleMs: 60_000 };

/**
 * A call that needs a DataModel Studio isn't in (Edit while someone plays, Server/Client before the playtest is up)
 * waits for it instead of handing the agent the mode error. `maxMs` is the longest it waits (and no longer than the
 * caller's MCP client sits through: without progress notes it gives up after about five minutes); `pollMs` how often
 * it looks at Studio's mode; `noteMs` how often it tells the caller what it waits for; `startMs` how long the
 * caller's own playtest gets to come up; `transitionMs` how long "Target is not reachable" (Studio switching modes) is
 * retried. An object so a test can shorten them.
 */
export const STUDIO_WAIT = { maxMs: 6 * 60 * 1000, pollMs: 2000, noteMs: 15_000, startMs: 20_000, transitionMs: 30_000, lineFactor: 1.6 };
/*
 * `lineFactor`: a caller standing in the line for play mode (a playtest, a screenshot's turn) waits this many times
 * `maxMs` (9.6 minutes; its progress notes keep its client listening for ten). The line is first come, first served,
 * so its place only gets better: giving up at six minutes threw the wait away and put it at the back again. In a
 * build with two games on one PC, three playtests in every ten minutes gave up that way.
 */
const EDIT_IN_PLAY = /\bedit\s+data\s?model is not available/i;
const PLAY_IN_EDIT = /\b(?:server|client)\s+data\s?model is not available/i;
const MODE_UNAVAILABLE = /data\s?model is not available/i;
const NOT_REACHABLE = /target is not reachable/i;

/** The DataModel a Studio MCP call works in, or null when it doesn't depend on Studio's mode (state, list, play control). */
export function requiredDataModel(tool: string, args: Record<string, unknown>): DataModelType | null {
  const dm = args.datamodel_type;
  if (dm === 'Edit' || dm === 'Server' || dm === 'Client') return dm;
  return /^(?:multi_edit|insert_asset|screen_capture)$/.test(tool) ? 'Edit' : null;
}

/** What a mode error from Studio means for a call that needed `need`. */
function modeError(error: string, need: DataModelType): 'edit-in-play' | 'play-in-edit' | 'settling' | null {
  if (EDIT_IN_PLAY.test(error) || (need === 'Edit' && MODE_UNAVAILABLE.test(error))) return 'edit-in-play';
  if (PLAY_IN_EDIT.test(error) || (need !== 'Edit' && MODE_UNAVAILABLE.test(error))) return 'play-in-edit';
  return NOT_REACHABLE.test(error) ? 'settling' : null;
}

/** What Studio's MCP answers when the bound place has no Studio (it closed, or crashed). */
export const STUDIO_GONE = /No open Studio instance matches|No Roblox Studio instance is connected/i;

/**
 * A window found by the project's place id (RobloxStudioAdapter.samePlaceById) is asked again whether it holds the
 * bound place's document after `freshMs` (a published copy is never kept for long by a stale answer), with `askMs` for
 * its answer. An object so a test can shorten it.
 */
export const SAME_DOC = { freshMs: 30_000, askMs: 15_000 };

/** A reopen of the place's Studio that is under way (see StudioRecovery). */
export interface StudioReopening {
  /** When Studio was found gone. */
  since: number;
  attempt: number;
  tries: number;
  /** The place file's name. */
  place: string;
  /** Settles when the reopen is over: true when Studio is back with the place. */
  done: Promise<boolean>;
  /** Shuriken closed it itself, to bring Studio's dead screen capture back (StudioRecovery.refresh); absent: Studio closed on its own. */
  refresh?: boolean;
}

/** What a call to Studio may be told (RobloxStudioAdapter.call). */
export interface StudioCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  needsStudio?: boolean;
  mcpOnly?: boolean;
  around?: (once: () => Promise<ExternalCallResult>) => Promise<ExternalCallResult>;
}

/** What waiting for Studio came to. */
export type StudioWait = { ok: true; waitedMs: number } | { ok: false; waitedMs: number; message: string };
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** A promise settled from outside (it never rejects, so nobody has to catch it). */
function settleable(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((r) => (settle = r));
  return { promise, settle };
}

/** What a capture Studio couldn't draw is called, for agents, verification and critics (see ScreenshotUnavailableError). */
export const STUDIO_NOT_DRAWING = "Studio isn't drawing (minimized, the display off, or its screen capture stopped answering)";
const NOT_DRAWING_ADVICE =
  "This is an environment condition, not a failure of the work: the visual check can't be done right now, so treat it as \"can't check visually\" and not as a defect. Carry on without screenshots and don't wait for them (never sleep in Studio): use measurements (roblox_run_luau, map_audit, animation_check, playtest probes), say in your result that the visual check wasn't possible, and leave the looking to a later review. Pictures come back by themselves once Studio draws again.";
/**
 * A capture gets `firstTimeoutMs`; one that timed out or came back blank is tried once more: after `delayMs`, giving
 * Studio `timeoutMs` (a Studio that draws answers within seconds). After a timeout no capture is tried for `pauseMs`.
 * A `quick` capture (a playtest's picture for the record, taken while everyone waits for Studio) gets one try of
 * `quickTimeoutMs`. A window raised for the capture gets `raisedMs` to draw, a display woken for it `wokenMs`, a
 * minimized window that was restored `restoredMs`. The first try had 45 s until 1.11: in 136 captures of three
 * simultaneous builds every picture that came came within 10 s or on the second try, so a Studio that isn't drawing
 * cost 65 s per ask (and 21 minutes in one project).
 * A Studio that stays that way is asked less and less: the pause doubles with every round that timed out, up to
 * `pauseMaxMs`, and the round after a pause is one try of `quickTimeoutMs`. In a two-build night one project's
 * captures timed out for over an hour: every two minutes one took 25 s, 3 s and 15 s inside Studio's line, which
 * twelve agents waited behind (13 of 15 playtests gave up in one ten-minute window).
 * An object so a test can shorten it.
 */
export const SHOT_RETRY = { delayMs: 3000, timeoutMs: 15_000, firstTimeoutMs: 25_000, pauseMs: 2 * 60_000, pauseMaxMs: 5 * 60_000, quickTimeoutMs: 10_000, raisedMs: 500, wokenMs: 2500, restoredMs: 1500 };
/**
 * How often setPlaying looks whether Studio has finished starting or stopping play (750 ms until 1.9: a start and a
 * stop each waited 375 ms longer than Studio took, on average, for every playtest). An object so a test can shorten it.
 */
export const PLAY_POLL = { ms: 250 };
/** The lease owner of a caller's turn in Edit mode (inEditTurn). */
export const editTurnOwner = (owner: string): string => `shot:${owner}`;
/** What a capture's call answers when its turn comes right after another capture timed out for good: none was tried. */
const CAPTURE_PAUSED = 'screen_capture was not tried: another capture failed a moment ago';
/**
 * What Studio answers a capture whose playtest stopped under it. Measured in a scratch place (capture-focus.e2e.ts,
 * 2026-10-02): from that answer on, that Studio answers NO capture any more (each times out), in Edit and in every
 * later playtest, over a new MCP connection too; Luau goes on working. Only closing the place and opening it again
 * brings captures back (20 s). A window that is covered, unfocused or beside another Studio has nothing to do with
 * it: all of those answered in 0.3 s. One project of a two-build night had no picture for hours for this.
 */
export const CAPTURE_TARGET_CLOSED = /Target is closed/i;
/** Rounds of captures that timed out in a row after which Studio's capture tool is taken for dead (see onCaptureDead). */
export const CAPTURE_DEAD_ROUNDS = 3;
/**
 * A playtest's plugin instances link a moment after it starts (measured: under 2 s for the server, a little more for
 * the client, whose commands the server instance relays). Within `windowMs` of the start a Luau call waits this long
 * for its DataModel's session before it takes the MCP path. An object so a test can shorten it.
 */
export const LINK_PLAY_WAIT = { windowMs: 15_000, serverMs: 5000, clientMs: 8000, backMs: 25_000 };

/** Dimensions of a PNG or JPEG from its headers (null for anything else). */
function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      // Start-of-frame markers (not DHT 0xC4, JPG 0xC8, DAC 0xCC) carry the size.
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * Whether a capture has nothing in it: no picture bytes at all, the 1×1 viewport of a minimized Studio, or a frame
 * of one flat colour (the black a display that is off gives). A flat JPEG's scan data is one short bit pattern
 * repeated, which compresses to almost nothing; a picture of a place never does. Heuristic, checked against
 * synthetic images only (a real Studio wasn't available).
 */
export function isBlankImage(base64: string): boolean {
  const b = Buffer.from(base64, 'base64');
  if (b.length < 1200) return true;
  const size = imageSize(b);
  if (size && (size.w < 16 || size.h < 16)) return true;
  if (b[0] === 0xff && b[1] === 0xd8) return deflateSync(b).length < b.length * 0.06;
  if (size && b.readUInt32BE(0) === 0x89504e47) return b.length / (size.w * size.h) < 0.004;
  return false;
}

/** One page of LUAU_SNAPSHOT's answer. */
interface SnapshotPage {
  count: number;
  truncated: boolean;
  from: number;
  next: number;
  /** JSONEncode writes an empty table as []. */
  nodes: Record<string, Record<string, unknown>> | unknown[];
}

export type DataModelType = 'Edit' | 'Client' | 'Server';

export interface StudioState {
  mode: string | null;
  availableDataModels: DataModelType[];
  focused: string | null;
  raw: string;
}

export interface StudioInstallInfo {
  versionFolder: string | null;
  studioVersion: string | null;
  mcpExe: string | null;
}

/**
 * Known facts about Studio MCP tools that are not visible in their schemas. Recorded into the
 * capability registry as limitations so agents know them before calling. Sources: tool
 * descriptions (official), observed behavior during integration tests (observed).
 */
const KNOWN_LIMITATIONS: Record<string, string[]> = {
  '*': [
    'studio_id values are ephemeral: they change when Studio reconnects or a place reloads. Shuriken resolves the bound instance by name on every call.',
    'No MCP tool saves the place: world (non-code) changes persist only after a human saves in Studio. Keep world construction as re-runnable builder scripts under world/.',
  ],
  execute_luau: [
    'datamodel_type must be one of the currently available DataModels (Edit when not playing; Client/Server only during a playtest).',
    'Return a string (e.g. HttpService:JSONEncode(...)) to get structured data back; print() output goes to the Studio console, not the tool result.',
    'In the Server/Client DataModels, require() returns a fresh module instance, not the running game copy: assert on instances/attributes, not module state.',
    'A result longer than about 100,000 characters arrives cut off (JSON then fails to parse): return less, or page through the data over several calls (the DataModel snapshot reads pages of 80,000 characters).',
    'Some properties need the RobloxScript capability and can’t be read or written (StarterPlayer.GameSettingsAvatar, Lighting.Technology): for the avatar type, read a spawned character’s Humanoid.RigType in a playtest; for lighting, Lighting.LightingStyle is readable. Terrain.Decoration no longer exists.',
    'loadstring() is unavailable in the Server/Client DataModels.',
    'Calls run one at a time, even to different DataModels. Observed: a thread a Client probe left running (task.delay) stalled while a later Server probe ran — to drive gameplay and watch it, do both in one call, or have a listener write attributes and read them afterwards.',
  ],
  multi_edit: ['Edit DataModel only. Script edits made through MCP bypass the on-disk source of truth; Shuriken projects write code as files instead.'],
  search_game_tree: ['max_depth default 3, absolute max 10; head_limit default 200. "Edit" is rejected while a playtest is running.'],
  start_stop_play: ['Transitions are asynchronous; poll get_studio_state until the expected DataModels appear.'],
  screen_capture: [
    'Captures the edit-time viewport; camera_position/look_at_position temporarily move the camera.',
    'Images are JPEG (sized to fit ~1 MB tool results).',
    'A capture in flight when its playtest stops is answered "Target is closed", and that Studio answers no capture after it (each times out, in Edit and in play, over a new connection too) until the place is closed and opened again. Measured 2026-10-02 (tests/e2e/capture-focus.e2e.ts). Shuriken keeps captures and play starts/stops apart, and reopens the place when it happens anyway. Whether the window is covered, unfocused or beside another Studio makes no difference: all answer in about 0.3 s.',
  ],
  user_keyboard_input: ['Targets the Client DataModel during a playtest only (game input); it cannot press Studio shortcuts such as Ctrl+S.'],
  user_mouse_input: [
    'Targets the Client DataModel during a playtest only (game input). Each action names its kind in an "action" field (moveTo, mouseButtonClick, wait, ...).',
    'Needs Studio’s window drawn: a minimized Studio (1×1 viewport) is restored behind the user’s windows automatically, but with the screen asleep or locked it times out. Then run the same client code with roblox_run_luau on the Client: fire the remotes and play the animations the input handler would.',
  ],
  script_read: ['May return stale source for scripts edited outside the editor; Shuriken verifies code by hashing Script.Source instead.'],
  script_grep: ['Capped at 50 results.'],
  script_search: ['Capped at 10 results.'],
  inspect_instance: ['Path matching is case-insensitive and may return up to 20 matches.'],
};

/**
 * Studio prefixes every Luau error with the paths of its own assistant plugin
 * ("sabuiltin_Assistant.rbxm.Assistant.Packages…ExecuteLuauTool:66: …CommandExecution:54: "): noise.
 */
export function cleanLuauError(text: string): string {
  return text.replace(/(?:sabuiltin_[\w.]+:\d+:\s*)+/g, '').trim();
}

/** Studio's message for code it could not compile (no line, no reason). */
export const LUAU_PARSE_FAILED = /Failed to parse command code/i;

/**
 * Studio reports runtime errors without the line of the code that failed. This wraps agent code so the
 * error names it: "attempt to index nil with 'b' (line 12, called from line 30)". The code starts on
 * line 2 of the wrapper; the chunk's own name is read at run time (it differs between DataModels).
 * Code that only compiles at the top level (export type) fails to parse here: run it unwrapped then.
 */
export function withErrorLines(code: string): string {
  const lines = code.split('\n').length;
  return [
    `local __skSrc, __skLines = debug.info(1, "s"), ${lines}; local __sk = table.pack(xpcall(function(...)`,
    code,
    'end, function(e: any)',
    '\tlocal at = {}',
    '\tlocal pattern = string.gsub(__skSrc, "%p", "%%%0") .. ":(%d+)"',
    '\tfor n in string.gmatch(debug.traceback(), pattern) do',
    '\t\tlocal line = (tonumber(n) :: number) - 1',
    '\t\tif line >= 1 and line <= __skLines and #at < 3 and at[#at] ~= tostring(line) then',
    '\t\t\ttable.insert(at, tostring(line))',
    '\t\tend',
    '\tend',
    '\tlocal msg = string.gsub(tostring(e), "^" .. string.gsub(__skSrc, "%p", "%%%0") .. ":%d+: ", "")',
    '\treturn if #at > 0 then msg .. " (line " .. table.concat(at, ", called from line ") .. ")" else msg',
    'end))',
    'if not __sk[1] then error(__sk[2], 0) end',
    'return table.unpack(__sk, 2, __sk.n)',
  ].join('\n');
}

/** Offline syntax check (LuauToolchain.parseErrors). */
export interface LuauParser {
  parseErrors(code: string): Promise<Array<{ line: number; column: number; message: string }>>;
}

/**
 * Run Luau an agent wrote: errors name the failing line, and code Studio can't compile gets its syntax
 * error from the offline parser (Studio only says "Failed to parse command code"). Valid code that
 * compiles only at the top level (e.g. `export type`) runs as written.
 */
export async function runAgentLuau(
  studio: RobloxStudioAdapter,
  parser: LuauParser,
  code: string,
  datamodel: DataModelType,
  timeoutMs = 120000,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string; syntax?: boolean }> {
  const r = await studio.runLuau(withErrorLines(code), datamodel, timeoutMs, signal);
  if (r.ok || !LUAU_PARSE_FAILED.test(r.output)) return r;
  const syntax = await parser.parseErrors(code);
  if (syntax.length) {
    // selene names the end of the code as an empty token.
    const where = syntax.slice(0, 3).map((e) => `line ${e.line}:${e.column}: ${e.message === 'unexpected token ``' ? 'the code ends too early (a missing `end`, `)` or `}`?)' : e.message}`);
    return { ok: false, syntax: true, output: `nothing ran: ${where.join('; ')}` };
  }
  return studio.runLuau(code, datamodel, timeoutMs, signal);
}

/**
 * Adapter for Roblox Studio's built-in MCP server (StudioMCP.exe). Discovers the installed
 * Studio build dynamically (never a hard-coded version folder), records every exposed tool in the
 * capability registry, and offers typed helpers used by Shuriken's own higher-level tools.
 */
export class RobloxStudioAdapter {
  readonly conn: McpStdioConnection;
  private install: StudioInstallInfo = { versionFolder: null, studioVersion: null, mcpExe: null };
  private studioMatch: string | null = null;
  private lastStudios: RobloxStudioInstance[] = [];

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
    appVersion: string,
  ) {
    this.conn = new McpStdioConnection(
      STUDIO_INTEGRATION,
      async () => {
        this.install = await locateStudio();
        // Run from its own folder: a child whose working directory is inside the app install would lock
        // that folder (and block moving or updating app versions) for as long as it runs.
        return this.install.mcpExe ? { command: this.install.mcpExe, cwd: dirname(this.install.mcpExe) } : null;
      },
      log,
      (c) => this.onConnectionChange(c),
      { clientName: 'shuriken', clientVersion: appVersion, autoReconnect: true, forbidden: studioForbidden },
    );
  }

  /** Bind to a Studio instance whose name contains this string (project setting). */
  bind(match: string | null): void {
    if (match === this.studioMatch) return;
    this.studioMatch = match;
    // What was proven about windows was proven for the old binding.
    this.sameDoc.clear();
    this.bus.emit('roblox.changed', { reason: 'binding' });
  }

  get binding(): string | null {
    return this.studioMatch;
  }

  get installInfo(): StudioInstallInfo {
    return this.install;
  }

  get connected(): boolean {
    return this.conn.state === 'connected';
  }

  availability(): { ok: boolean; reason?: string } {
    if (this.conn.state !== 'connected') return { ok: false, reason: `Studio MCP ${this.conn.state}${this.conn.lastError ? `: ${this.conn.lastError}` : ''}` };
    return { ok: true };
  }

  async start(): Promise<void> {
    if (studioForbidden()) return;
    await this.conn.connect();
  }

  private onConnectionChange(c: McpStdioConnection): void {
    const version = this.install.studioVersion;
    if (c.state === 'connected') {
      const tools = c.listTools();
      for (const t of tools) {
        this.registry.upsert({
          id: `roblox.${t.name}`,
          integration: STUDIO_INTEGRATION,
          name: t.title ?? t.name,
          status: 'healthy',
          description: t.description.split('\n')[0]!.slice(0, 400),
          version,
          detail: `Studio MCP ${c.serverInfo?.version ?? '?'} · Studio ${version ?? '?'}`,
          limitations: [...(KNOWN_LIMITATIONS['*'] ?? []), ...(KNOWN_LIMITATIONS[t.name] ?? [])],
          schema: t.inputSchema,
        });
      }
      // Tools that disappeared since the last discovery become unsupported rather than silently missing.
      const present = new Set(tools.map((t) => `roblox.${t.name}`));
      for (const cap of this.registry.list(STUDIO_INTEGRATION)) {
        if (cap.id.startsWith('roblox.') && !cap.id.startsWith('roblox.app.') && !present.has(cap.id)) {
          this.registry.setStatus(cap.id, 'unsupported', 'No longer exposed by the installed Studio MCP server');
        }
      }
    } else if (c.state === 'failed' || c.state === 'disconnected') {
      this.registry.setIntegrationStatus(STUDIO_INTEGRATION, 'unavailable', c.lastError ?? c.state);
    }
    this.bus.emit('roblox.changed', { reason: `connection:${c.state}` });
  }

  // ─── Raw access ─────────────────────────────────────────────────────────────

  /** The play-mode lease of this Studio's project: who is in a playtest decides who has to wait (see useLease). */
  lease: PlaytestLease | null = null;

  /**
   * Gives the adapter the play-mode lease. From then on a call made inside an agent's tool call that needs
   * the Edit DataModel waits while another agent's playtest holds Studio (and the reverse), instead of
   * returning Studio's mode error: see call.
   */
  /**
   * The plugin's link to a DataModel dropped (Studio froze for a while): true once it is linked again, within
   * LINK_PLAY_WAIT.backMs. False when there is no plugin, or it stayed away.
   */
  async linkBack(dm: DataModelType = 'Edit'): Promise<boolean> {
    return !!this.link && (await this.link.waitFor(dm, LINK_PLAY_WAIT.backMs).catch(() => false));
  }

  /** Edit-mode Luau and code syncs go on while someone playtests: the plugin's Edit instance is linked. */
  get editInPlay(): boolean {
    return !!this.link?.has('Edit');
  }

  useLease(lease: PlaytestLease, onReclaim?: (r: { owner: string; reason: LeaseExpiry }) => void): void {
    this.lease = lease;
    lease.editInPlay = () => this.editInPlay;
    this.onReclaim = onReclaim ?? null;
    // Callers waiting on the lease stop a playtest that is past its limits themselves (see enforceLease).
    lease.enforcer = (opts) => this.enforceLease(opts);
  }

  private onReclaim: ((r: { owner: string; reason: LeaseExpiry }) => void) | null = null;
  private enforcing: Promise<{ owner: string; reason: LeaseExpiry } | null> | null = null;

  /**
   * Stops the playtest that holds play mode when it is past its limits (PLAYTEST_LIMITS: held too long, or an
   * agent's gone quiet while others wait) and lets go of the lease, so the Edit work waiting behind it can go on.
   * Called by the callers that wait for the lease and by the core's watchdog; one stop at a time. An agent whose
   * playtest it was is told by its next Studio call (lease.reclaimed). Returns what it stopped, null when nothing
   * was past its limits.
   */
  enforceLease(opts: { waiting?: boolean } = {}): Promise<{ owner: string; reason: LeaseExpiry } | null> {
    if (this.enforcing) return this.enforcing;
    const lease = this.lease;
    const holder = lease?.holder;
    const reason = lease && holder ? lease.overdue(Date.now(), opts.waiting ?? lease.waiting > 0) : null;
    if (!lease || !holder || !reason) return Promise.resolve(null);
    const run = (async () => {
      // A save, a rebuild or a reopening holds Studio without playing: "playtest" in the log sent a reader the wrong way.
      const what = /^(saver|healer|refresh)$/.test(holder.owner) ? 'turn in Studio' : 'playtest';
      this.log.info(`Stopping ${holder.owner}'s ${what} (${reason === 'long' ? 'past its time limit' : 'idle while others wait'})`);
      // Never longer than ENFORCE.stopMs: a stop Studio doesn't answer (it hung, it crashed under the playtest) must not
      // keep Studio from everyone else, and this promise must end, or no playtest is ever stopped again.
      const stopped = await Promise.race([
        this.setPlaying(false).then(
          () => 'stopped' as const,
          (e: unknown) => {
            this.log.warn('Could not stop a playtest', errorMessage(e));
            return 'failed' as const;
          },
        ),
        sleepMs(ENFORCE.stopMs).then(() => 'timeout' as const),
      ]);
      if (stopped === 'timeout') this.log.warn(`Studio did not confirm the stop of ${holder.owner}'s playtest within ${Math.round(ENFORCE.stopMs / 1000)} s; Studio goes to the others anyway`);
      if (!lease.release(holder.owner)) return null;
      if (holder.owner.startsWith('run_')) {
        lease.reclaimed.set(holder.owner, Date.now());
        lease.reclaimReasons.set(holder.owner, reason);
      }
      const r = { owner: holder.owner, reason };
      this.onReclaim?.(r);
      return r;
    })().finally(() => {
      this.enforcing = null;
    });
    this.enforcing = run;
    return run;
  }

  /**
   * Call a Studio MCP tool, injecting the bound studio_id (re-resolved on stale-id errors). A call made inside
   * an agent's tool call that needs a DataModel Studio isn't in (Edit during another agent's playtest, Server or
   * Client before the caller's own playtest is up) waits for it — bounded by STUDIO_WAIT, with progress notes
   * when the caller takes them — and runs then; only when the wait runs out does it fail, saying who holds
   * Studio and since when. Calls outside a tool call (verification, the app's own views) are never held back.
   * The same goes for a Studio that closed (a crash): while the app reopens the place (`reopening`, set by
   * StudioRecovery) a tool call's Studio calls wait for it, and one that finds no Studio asks for a look (`onGone`)
   * and waits for the reopen it starts, instead of handing the agent "no Studio instance" to ask someone about.
   */
  async call(tool: string, args: Record<string, unknown>, opts: StudioCallOptions = {}): Promise<ExternalCallResult> {
    const need = requiredDataModel(tool, args);
    const ctx = currentStudioCaller();
    // `around` wraps the call itself, after any wait for Studio's mode: what it holds is never held through that wait.
    const once = () => (opts.around ? opts.around(() => this.callOnce(tool, args, opts)) : this.callOnce(tool, args, opts));
    // Edit Luau goes through the plugin when it is linked, and the plugin's Edit instance works during a playtest
    // (PlaytestLease.editInPlay): such a call waits for nobody. Should the link drop under it, Studio's own answer
    // ("not available in Play mode") sends it down the waiting path after all.
    const freeEdit = tool === 'execute_luau' && need === 'Edit' && !opts.mcpOnly && this.editInPlay;
    const run = async (): Promise<ExternalCallResult> => {
      if (!need || !ctx || !this.lease) return once();
      if (freeEdit) {
        const r = await once();
        if (r.ok || !modeError(r.error ?? '', need)) return r;
      }
      return this.callInMode(need, ctx, once);
    };
    if (!ctx || tool === 'list_roblox_studios') return run();
    const held = await this.waitForReopen(ctx);
    if (held) return held;
    // While the play-mode holder's own call runs, its playtest isn't idle (PlaytestLease.busy).
    const ended = this.lease?.busy(ctx.owner) ?? (() => undefined);
    let res: ExternalCallResult;
    try {
      res = await run();
    } finally {
      ended();
    }
    if (res.ok || !this.onGone || !STUDIO_GONE.test(res.error ?? '')) return res;
    // No Studio with the place: have it looked at now; when that reopens it, this call runs once it is back.
    const look = this.onGone().catch(() => false);
    for (let i = 0; i < 100 && !this.reopening; i++) {
      if (await Promise.race([look.then(() => true), sleepMs(100).then(() => false)])) break;
    }
    const again = await this.waitForReopen(ctx);
    if (again) return again;
    return (await look) ? run() : res;
  }

  /** The place's Studio closed and is being reopened right now (set by StudioRecovery for as long as it tries). */
  reopening: StudioReopening | null = null;
  /** Asks whoever reopens Studio to look now; resolves true when Studio is there (or back). Set by StudioRecovery. */
  onGone: (() => Promise<boolean>) | null = null;

  /**
   * Waits while the place's Studio is being reopened (null when it isn't, or once it is back): progress notes say
   * what is going on; a wait that runs out, or a reopen that failed, comes back as the call's error, worded so the
   * agent carries on with other work and asks nobody.
   */
  private async waitForReopen(ctx: StudioCaller): Promise<ExternalCallResult | null> {
    const r = this.reopening;
    if (!r) return null;
    const t0 = Date.now();
    const fail = (error: string): ExternalCallResult => ({ ok: false, content: [], error, durationMs: Date.now() - t0 });
    const deadline = t0 + this.waitLimit(ctx);
    for (;;) {
      ctx.progress?.(
        r.refresh
          ? `Waiting for Studio: its screen capture stopped answering, so Shuriken saves the place and reopens ${r.place} to bring it back (started ${clockTime(r.since)}). Your call goes on when it is back.`
          : `Waiting for Studio: it closed unexpectedly at ${clockTime(r.since)} and Shuriken is reopening ${r.place} (try ${r.attempt} of ${r.tries}). Your call goes on when it is back.`,
      );
      const left = deadline - Date.now();
      const back = await Promise.race<'back' | 'failed' | 'waiting'>([r.done.then((ok) => (ok ? 'back' : 'failed'), () => 'failed'), sleepMs(Math.min(STUDIO_WAIT.noteMs, Math.max(0, left))).then(() => 'waiting')]);
      if (back === 'back') return null;
      if (back === 'failed') return fail(`Roblox Studio closed and could not be reopened (the user was told in the chat). Carry on with work that needs no Studio (files, luau_check) and say in your result which Studio steps are left. This is not a question for anyone and not a blocker to report: Studio tools work again once it is back.`);
      if (ctx.signal?.aborted) return fail('Stopped waiting for Studio: the call was cancelled.');
      if (Date.now() >= deadline && r.refresh) return fail(`Shuriken is reopening ${r.place} in Studio to bring its screen capture back (since ${clockTime(r.since)}); waited ${fmtDuration(Date.now() - t0)}. Do non-Studio work (files, luau_check) and try again later. This is not a blocker to report, and nothing to ask the user.`);
      if (Date.now() >= deadline) return fail(`Roblox Studio closed unexpectedly at ${clockTime(r.since)} and is still being reopened (try ${r.attempt} of ${r.tries}); waited ${fmtDuration(Date.now() - t0)}. Shuriken reopens it by itself: do non-Studio work (files, luau_check) and try again later. This is not a blocker to report, and nothing to ask the user.`);
    }
  }

  /** For code outside a tool call (verification): resolves once a reopen under way is over (true: Studio is back, or none was under way). */
  async waitUntilBack(maxMs: number): Promise<boolean> {
    const r = this.reopening;
    if (!r) return true;
    return Promise.race([r.done.catch(() => false), sleepMs(maxMs).then(() => false)]);
  }

  /**
   * Shuriken Link (link/plugin.ts): Luau runs through the Studio plugin when the place's DataModel is linked, with a
   * plugin's rights and in milliseconds; everything else, and Luau when no plugin is linked, goes through Studio's
   * MCP server as before. Set by the core; null in tests and where the plugin is switched off.
   */
  link: PlaceLinkView | null = null;
  /** When the playtest that is running started (its plugin instances link a moment later). */
  private playStartedAt = 0;
  /** Luau calls that went through the plugin, and the ones among them that failed (for the health check). */
  readonly linkStats = { calls: 0, failed: 0 };

  /** Does (or will, within a moment) the plugin serve this DataModel? A playtest's sessions are waited for briefly. */
  private async linkServes(dm: DataModelType): Promise<boolean> {
    const link = this.link;
    if (!link) return false;
    if (link.has(dm)) return true;
    if (dm === 'Edit' || !link.has('Edit') || Date.now() - this.playStartedAt > LINK_PLAY_WAIT.windowMs) return false;
    return link.waitFor(dm, dm === 'Client' ? LINK_PLAY_WAIT.clientMs : LINK_PLAY_WAIT.serverMs);
  }

  /** execute_luau through the plugin; null when that DataModel isn't linked (the MCP path then). */
  private async luauViaLink(args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExternalCallResult | null> {
    const dm = args.datamodel_type as DataModelType;
    if (typeof args.code !== 'string' || !(await this.linkServes(dm))) return null;
    const running = this.link!.run(dm, args.code, opts.timeoutMs ?? 120_000, opts.signal);
    if (!running) return null;
    const r = await running;
    this.linkStats.calls++;
    if (r.ok) return { ok: true, content: [{ type: 'text', text: r.text }], durationMs: r.durationMs };
    this.linkStats.failed++;
    return { ok: false, content: [], error: r.text, durationMs: r.durationMs };
  }

  /** The call itself, as Studio takes it. */
  protected async callOnce(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal; needsStudio?: boolean; mcpOnly?: boolean } = {}): Promise<ExternalCallResult> {
    const linked = tool === 'execute_luau' && this.link && !opts.mcpOnly;
    if (linked) {
      const via = await this.luauViaLink(args, opts);
      if (via) return via;
    }
    const res = await this.callMcp(tool, args, opts);
    // Studio's own path refused what the plugin may do (require a module, fire an event), and the plugin was only away
    // for a moment (Studio froze for half a minute and the link dropped): wait for it to come back and run it there.
    // A playtest that began with the plugin linked has no probe hosts to fall back on.
    if (linked && !res.ok && CAPABILITY_ERROR.test(res.error ?? textOf(res)) && (await this.link!.waitFor(args.datamodel_type as DataModelType, LINK_PLAY_WAIT.backMs).catch(() => false))) {
      const via = await this.luauViaLink(args, opts);
      if (via) return via;
    }
    return res;
  }

  /** The call through Studio's MCP server. */
  protected async callMcp(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal; needsStudio?: boolean } = {}): Promise<ExternalCallResult> {
    const needsStudio = opts.needsStudio ?? tool !== 'list_roblox_studios';
    let studioId: string | null = null;
    if (needsStudio) {
      const r = await this.resolveStudioId();
      if (!r.ok) return { ok: false, content: [], error: r.error, durationMs: 0 };
      studioId = r.id;
    }
    const first = await this.conn.call(tool, studioId ? { ...args, studio_id: studioId } : args, opts.timeoutMs, opts.signal);
    if (!first.ok && studioId && /not connected|unknown studio|studio_id/i.test(first.error ?? '')) {
      const r = await this.resolveStudioId(true);
      if (r.ok && r.id !== studioId) return this.conn.call(tool, { ...args, studio_id: r.id }, opts.timeoutMs, opts.signal);
    }
    return first;
  }

  // ─── Waiting for Studio's mode ──────────────────────────────────────────────

  /** The most this caller waits for Studio: STUDIO_WAIT.maxMs, less when its MCP client would give up first. */
  private waitLimit(ctx: StudioCaller | null): number {
    return Math.min(STUDIO_WAIT.maxMs, ctx ? waitBudget(ctx.kind, !!ctx.progress) : STUDIO_WAIT.maxMs);
  }

  /** How long a caller stands in the line for play mode (STUDIO_WAIT.lineFactor), within what its client sits through. */
  private lineLimit(ctx: StudioCaller | null): number {
    const line = STUDIO_WAIT.maxMs * STUDIO_WAIT.lineFactor;
    return Math.min(line, ctx ? waitBudget(ctx.kind, !!ctx.progress) : line);
  }

  /** The most the tool call this runs inside waits for Studio (see waitLimit). */
  waitLimitMs(): number {
    return this.waitLimit(currentStudioCaller());
  }

  /**
   * Waits until nobody but the caller holds play mode (another agent's playtest, a verification), at most `maxMs`
   * (and the caller's own limit). The caller is the tool call this runs inside; one that holds play mode itself never
   * waits. Tells the caller what it waits for every few seconds.
   */
  async waitForLease(maxMs = Infinity, purpose = 'Edit-mode work', strict = false, inLine = false): Promise<StudioWait> {
    const lease = this.lease;
    const ctx = currentStudioCaller();
    const owner = ctx?.owner ?? null;
    const t0 = Date.now();
    const free = () => !lease || !lease.holder || lease.holder.owner === owner || (!!owner && lease.holder.owner === editTurnOwner(owner));
    if (!lease || free()) return { ok: true, waitedMs: 0 };
    // Edit-mode work through the plugin needs no turn: it goes on during the playtest. `strict` is for what
    // needs Studio itself out of play mode (a playtest of one's own, a screenshot, Studio's own Edit-only tools):
    // each of those calls waits where it is made.
    if (!strict && this.editInPlay) return { ok: true, waitedMs: 0 };
    const deadline = t0 + Math.min(maxMs, inLine ? this.lineLimit(ctx) : this.waitLimit(ctx));
    for (;;) {
      const now = Date.now();
      const holder = lease.describe(now);
      if (holder) ctx?.progress?.(`Waiting for Studio: ${holder}. ${purpose} goes on when it ends.`);
      const slice = Math.min(STUDIO_WAIT.noteMs, deadline - now);
      if (slice > 0) await lease.waitFree(owner, slice, ctx?.signal);
      if (free()) return { ok: true, waitedMs: Date.now() - t0 };
      const waited = Date.now() - t0;
      if (ctx?.signal?.aborted) return { ok: false, waitedMs: waited, message: 'Stopped waiting for Studio: the call was cancelled.' };
      if (Date.now() >= deadline) {
        return {
          ok: false,
          waitedMs: waited,
          message: `Studio is still held by ${lease.describe() ?? 'another playtest'}; waited ${fmtDuration(waited)} for it to end. ${purpose} needs Studio out of play mode. Do non-Studio work (files, luau_check) and try again later. This is not a blocker to report.`,
        };
      }
    }
  }

  /**
   * A turn in Studio's Edit mode for what Studio's own tools do there (a screenshot of the Edit scene): the caller
   * stands in the same line as the playtests and holds Studio out of play mode while `fn` runs.
   *
   * Until 1.13 a screenshot only waited for the lease to be free and then raced the next playtest's start: it got
   * its picture in the gap between two playtests, or met play mode again and waited once more (22 s a screenshot on
   * average in a 12-agent build, 72 minutes in all). With the line for play mode first come, first served that gap
   * is gone, so a screenshot takes a place in the line instead. Several pictures in one turn cost one wait.
   * Calls outside a tool call, and the play holder's own, run at once (the holder's Edit picture is refused by Studio
   * as before, with the advice to stop its playtest).
   */
  async inEditTurn<T>(fn: () => Promise<T>): Promise<T> {
    const lease = this.lease;
    const ctx = currentStudioCaller();
    if (!lease || !ctx || !ctx.owner) return fn();
    const me = editTurnOwner(ctx.owner);
    const holder = lease.holder?.owner;
    if (holder === ctx.owner || holder === me) return fn();
    const w = await this.acquirePlayMode(me, 'Your screenshot');
    if (!w.ok) throw new Error(w.message);
    try {
      return await fn();
    } finally {
      lease.release(me);
    }
  }

  /** Takes play mode for `owner` (the caller of this tool call), waiting in line like waitForLease while someone else plays. */
  async acquirePlayMode(owner: string, purpose = 'Your playtest', estimateMs?: number): Promise<StudioWait> {
    const lease = this.lease;
    if (!lease) return { ok: false, waitedMs: 0, message: "Studio's play-mode lease isn't attached (internal error): no playtest can be started." };
    const t0 = Date.now();
    const deadline = t0 + this.lineLimit(currentStudioCaller());
    // Code syncs that haven't begun hold off for this playtest; one that is under way finishes first (seconds). How long
    // it will hold Studio puts it in its place in the line (shortest first: LINE_ORDER).
    lease.want(owner, estimateMs);
    try {
      for (;;) {
        const w = await this.waitForLease(deadline - Date.now(), purpose, true, true);
        if (!w.ok) return w;
        if (lease.tryAcquire(owner)) return { ok: true, waitedMs: Date.now() - t0 };
        if (Date.now() >= deadline) return { ok: false, waitedMs: Date.now() - t0, message: `Studio is held by ${lease.describe() ?? (lease.editing ? 'a code sync that is still writing scripts' : 'another playtest')}; waited ${fmtDuration(Date.now() - t0)}. ${purpose} needs Studio. Do non-Studio work (files, luau_check) and try again later. This is not a blocker to report.` };
        await sleepMs(50);
      }
    } finally {
      lease.unwant(owner);
    }
  }

  /**
   * Waits until the Edit DataModel can be used: nobody else holds play mode (waitForLease) and Studio itself isn't
   * playing (a playtest someone started by hand, or one that is still stopping).
   */
  async waitForEdit(maxMs = Infinity): Promise<StudioWait> {
    const ctx = currentStudioCaller();
    const t0 = Date.now();
    const deadline = t0 + Math.min(maxMs, this.waitLimit(ctx));
    let lastNote = 0;
    for (;;) {
      const lw = await this.waitForLease(deadline - Date.now(), 'Edit-mode work', true);
      if (!lw.ok) return { ...lw, waitedMs: Date.now() - t0 };
      const st = await this.state().catch(() => null);
      if (!st || st.availableDataModels.includes('Edit')) return { ok: true, waitedMs: Date.now() - t0 };
      if (ctx?.owner && this.lease?.holder?.owner === ctx.owner) {
        return { ok: false, waitedMs: Date.now() - t0, message: 'Edit-mode work is not possible while your own playtest runs: stop it first (roblox_playtest action "stop"), then do the Edit-mode work.' };
      }
      const left = deadline - Date.now();
      if (ctx?.signal?.aborted) return { ok: false, waitedMs: Date.now() - t0, message: 'Stopped waiting for Studio: the call was cancelled.' };
      if (left <= 0) {
        const waited = Date.now() - t0;
        return { ok: false, waitedMs: waited, message: `Studio is in play mode and no agent holds it (a playtest started in Studio by hand, or one that never stopped); waited ${fmtDuration(waited)} for it to end. Edit-mode work needs Studio out of play mode. Do non-Studio work (files, luau_check) and try again later. This is not a blocker to report.` };
      }
      if (Date.now() - lastNote >= STUDIO_WAIT.noteMs) {
        lastNote = Date.now();
        ctx?.progress?.('Waiting for Studio: it is in play mode and no agent holds it (a playtest started in Studio by hand?). Edit-mode work goes on when it ends.');
      }
      await sleepMs(Math.min(STUDIO_WAIT.pollMs, left));
    }
  }

  /**
   * A call that needs the Server or Client DataModel while Studio is in Edit mode. The caller's own playtest may
   * still be coming up (a start takes a few seconds): wait for that. Otherwise there is nothing to wait for (nobody
   * is starting a playtest for it, and it must not ride on another agent's): say what to do.
   */
  private async waitForPlay(need: DataModelType, ctx: StudioCaller): Promise<StudioWait> {
    const lease = this.lease!;
    const t0 = Date.now();
    const fail = (message: string): StudioWait => ({ ok: false, waitedMs: Date.now() - t0, message });
    if (!ctx.owner || lease.holder?.owner !== ctx.owner) {
      if (ctx.owner && lease.reclaimed.has(ctx.owner)) {
        const reason = lease.reclaimReasons.get(ctx.owner);
        const why = reason === 'long' ? 'it ran past its 60 s of play' : reason === 'crash' ? 'Studio closed under it and the place was reopened' : reason === 'freed' ? 'the user freed Studio' : 'it sat idle while they waited';
        return fail(`Your playtest was stopped (${why}), so Studio is back in Edit mode and the ${need} DataModel is gone. Start another with roblox_playtest: action "run" does the whole check (plays, runs your probes, stops) in one call.`);
      }
      if (lease.holder) return fail(`The ${need} DataModel isn't available yet: the playtest running now belongs to ${lease.describe()}, not to you. Start your own with roblox_playtest (it waits its turn).`);
      return fail(`Studio is in Edit mode: the ${need} DataModel only exists during a playtest. Start one with roblox_playtest (action "run" plays, runs your probes and stops, in one call; "start" and "stop" if you drive it yourself).`);
    }
    const deadline = t0 + STUDIO_WAIT.startMs;
    ctx.progress?.(`Waiting for your playtest to come up (the ${need} DataModel isn't there yet).`);
    for (;;) {
      const st = await this.state().catch(() => null);
      if (!st || st.availableDataModels.includes(need)) return { ok: true, waitedMs: Date.now() - t0 };
      if (Date.now() >= deadline || ctx.signal?.aborted) return fail(`Your playtest hasn't come up after ${fmtDuration(Date.now() - t0)}: Studio is still in Edit mode, so the ${need} DataModel isn't there. Stop it (roblox_playtest action "stop") and start again.`);
      await sleepMs(Math.min(STUDIO_WAIT.pollMs, 1000));
    }
  }

  /** The call, once Studio is in the mode it needs (see call). */
  private async callInMode(need: DataModelType, ctx: StudioCaller, run: () => Promise<ExternalCallResult>): Promise<ExternalCallResult> {
    const t0 = Date.now();
    const fail = (error: string): ExternalCallResult => ({ ok: false, content: [], error, durationMs: Date.now() - t0 });
    // A Studio call of its own keeps the holder's playtest from counting as idle.
    this.lease?.touch(ctx.owner);
    // Known before asking: another agent's playtest holds Studio, so an Edit call would only be refused.
    if (need === 'Edit') {
      const w = await this.waitForLease(Infinity, 'Edit-mode work', true);
      if (!w.ok) return fail(w.message);
    }
    const deadline = t0 + this.waitLimit(ctx);
    let res = await run();
    let settlingSince = 0;
    for (let round = 0; !res.ok && round < 12 && !ctx.signal?.aborted; round++) {
      const kind = modeError(res.error ?? '', need);
      if (!kind) break;
      let waited: StudioWait;
      if (kind === 'edit-in-play') waited = await this.waitForEdit(deadline - Date.now());
      else if (kind === 'play-in-edit') waited = await this.waitForPlay(need, ctx);
      else {
        // "Target is not reachable": Studio is switching between modes; ask again in a moment.
        settlingSince ||= Date.now();
        if (Date.now() - settlingSince >= STUDIO_WAIT.transitionMs) break;
        await sleepMs(STUDIO_WAIT.pollMs);
        waited = { ok: true, waitedMs: 0 };
      }
      if (!waited.ok) return fail(waited.message);
      // Asked again right away it would only meet the same mode again: give a settling Studio a moment.
      if (waited.waitedMs < 300 && kind !== 'settling') await sleepMs(Math.min(STUDIO_WAIT.pollMs, 1000));
      res = await run();
    }
    return res;
  }

  async listStudios(): Promise<RobloxStudioInstance[]> {
    const res = await this.conn.call('list_roblox_studios', {}, 20000);
    if (!res.ok) throw new Error(res.error ?? 'list_roblox_studios failed');
    const text = textOf(res);
    try {
      const parsed = JSON.parse(text) as { studios?: Array<{ id: string; name: string | null }> };
      // A Studio window that is still loading reports name = null; keep it but never match it.
      this.lastStudios = (parsed.studios ?? []).map((s) => ({ id: s.id, name: s.name ?? '(loading)' }));
    } catch {
      this.lastStudios = [];
    }
    return this.lastStudios;
  }

  private async resolveStudioId(refresh = false): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
    let studios = this.lastStudios;
    if (refresh || studios.length === 0) {
      try {
        studios = await this.listStudios();
      } catch (e) {
        return { ok: false, error: `Cannot list Studio instances: ${errorMessage(e)}` };
      }
    }
    if (studios.length === 0) return { ok: false, error: 'No Roblox Studio instance is connected. Open Studio with "Enable Studio as MCP server" turned on.' };
    let pick: RobloxStudioInstance | undefined;
    if (this.studioMatch) {
      const m = this.studioMatch.toLowerCase();
      pick = studios.find((s) => s.name.toLowerCase().includes(m));
      // Listed under the published game's name while it is still the place file's own document: found by the place id
      // and proven by the window itself (samePlaceById).
      if (!pick) pick = (await this.samePlaceById(studios).catch(() => null)) ?? undefined;
      if (!pick) {
        if (!refresh) return this.resolveStudioId(true);
        const other = [...this.notSameDoc.entries()].filter(([id]) => studios.some((s) => s.id === id)).map(([, why]) => why);
        return { ok: false, error: `No open Studio instance matches "${this.studioMatch}". Open: ${studios.map((s) => s.name).join('; ')}${other.length ? `. ${other.join('; ')}` : ''}` };
      }
    } else {
      // The project's own place file, open in a window the user opened (Shuriken's own open of it failed or was
      // never made): that window is this project's, and it is linked now. On 8 October a place opened by hand
      // stayed "not linked" until the project was set up again.
      const mine = this.linkOwnPlace(studios);
      if (mine) return { ok: true, id: mine.id, name: mine.name };
      // The list kept from before may not have the window yet.
      if (!refresh && this.projectPlaceFile()) return this.resolveStudioId(true);
      // Never adopt whatever place happens to be open: with only the user's own game open, an unbound
      // project would read it, move its camera for shots, and let agents build into it.
      return { ok: false, error: `No Studio place is linked to this project yet (it opens its own place when the project opens, or pick one in Settings → Roblox). Open in Studio: ${studios.map((s) => s.name).join('; ')}` };
    }
    return { ok: true, id: pick!.id, name: pick!.name };
  }

  /** The open project's published place id (extras.cloud.placeId), set by the core: see samePlaceById. */
  projectPlaceId: () => string | null = () => null;
  /** The open project's own place file's name (extras.placeFile), set by the core: an unbound project links the window that has it. */
  projectPlaceFile: () => string | null = () => null;
  /** Told when an unbound project was linked to its own place's window (the core keeps it in the project's settings). */
  onAutoBind: ((match: string) => void) | null = null;

  /**
   * An unbound project's own place file open in exactly one window (opened by hand): linked to it, and that window
   * returned. Another place is never taken (see resolveStudioId).
   */
  linkOwnPlace(studios: RobloxStudioInstance[]): RobloxStudioInstance | null {
    if (this.studioMatch) return null;
    const own = this.projectPlaceFile()?.toLowerCase() ?? null;
    const mine = own ? studios.filter((s) => s.name.toLowerCase() === own) : [];
    if (mine.length !== 1) return null;
    this.bind(mine[0]!.name);
    this.onAutoBind?.(mine[0]!.name);
    return mine[0]!;
  }
  /** Windows proven to hold the bound place's own document although listed under the game's name: id → as listed, when. */
  private readonly sameDoc = new Map<string, { name: string; at: number }>();
  /** Windows listed with the project's place id that hold another document: id → why, for the "no instance" error. */
  private readonly notSameDoc = new Map<string, string>();
  /** A window being asked right now (one question at a time per window, however many calls need the answer). */
  private readonly askingDoc = new Map<string, Promise<boolean>>();

  /**
   * The bound place's window when Studio's MCP server lists it under the published game's name ("Voxel Pit (placeId:
   * N)") instead of the place file's. Seen on 2026-10-07: the team's window had the project's place file open, its
   * DataModel was still named after the file (Shuriken Link said so), and Studio listed it as "Voxel Pit (placeId: …)":
   * for 50 minutes every playtest and screenshot failed with "No open Studio instance matches". A window is taken
   * only when its place id is the project's (extras.cloud.placeId, or what Shuriken Link reports for the project's
   * Edit session) and the window itself says its place is the bound one (`game.Name` contains the binding, as a place
   * file's DataModel is named after the file). A published copy is never taken: after a reload, or opened from Roblox,
   * Studio names its DataModel after the game. Null when there is no such window.
   */
  async samePlaceById(studios: RobloxStudioInstance[]): Promise<RobloxStudioInstance | null> {
    const match = this.studioMatch;
    if (!match) return null;
    const ids = new Set<string>();
    const own = this.projectPlaceId();
    if (own && /^\d+$/.test(own) && own !== '0') ids.add(own);
    const linked = this.link?.place();
    if (linked?.placeId) ids.add(String(linked.placeId));
    if (!ids.size) return null;
    for (const s of studios) {
      const id = /\(placeId:\s*(\d+)\)\s*$/.exec(s.name)?.[1];
      if (!id || !ids.has(id)) continue;
      if (await this.provenSameDoc(s, match)) return s;
    }
    return null;
  }

  /** Whether the window `s` holds the bound place's own document (see samePlaceById), asked of the window itself. */
  private provenSameDoc(s: RobloxStudioInstance, match: string): Promise<boolean> {
    const known = this.sameDoc.get(s.id);
    if (known && known.name === s.name && Date.now() - known.at < SAME_DOC.freshMs) return Promise.resolve(true);
    const asking = this.askingDoc.get(s.id);
    if (asking) return asking;
    const run = (async (): Promise<boolean> => {
      const r = await this.conn.call('execute_luau', { code: 'return game.Name', datamodel_type: 'Edit', studio_id: s.id }, SAME_DOC.askMs).catch(
        (e: unknown): ExternalCallResult => ({ ok: false, content: [], error: errorMessage(e), durationMs: 0 }),
      );
      if (r.ok) {
        const place = textOf(r).trim();
        if (place.toLowerCase().includes(match.toLowerCase())) {
          if (!known || known.name !== s.name) this.log.info(`Studio lists the project's place "${match}" as "${s.name}" (published); its window's place is "${place}", so the team works there`);
          this.sameDoc.set(s.id, { name: s.name, at: Date.now() });
          this.notSameDoc.delete(s.id);
          return true;
        }
        const why = `"${s.name}" has this project's place id but is another document (its place is "${place.slice(0, 80)}", not ${match}): a published copy, not the team's place`;
        if (this.notSameDoc.get(s.id) !== why) this.log.info(why);
        this.notSameDoc.set(s.id, why);
        this.sameDoc.delete(s.id);
        return false;
      }
      // Studio is in a playtest: its Edit DataModel can't be asked. A window proven before is still that document (a
      // place is published, and reloaded under the game's name, only from Edit mode).
      return !!known && known.name === s.name && modeError(r.error ?? '', 'Edit') === 'edit-in-play';
    })().finally(() => this.askingDoc.delete(s.id));
    this.askingDoc.set(s.id, run);
    return run;
  }

  // ─── Typed helpers ──────────────────────────────────────────────────────────

  async state(): Promise<StudioState> {
    const res = await this.call('get_studio_state', {}, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(res.error);
    return parseState(textOf(res));
  }

  async runLuau(code: string, datamodel: DataModelType = 'Edit', timeoutMs = 120000, signal?: AbortSignal): Promise<{ ok: boolean; output: string; durationMs: number }> {
    // A probe that requires a module or fires an event runs inside the game while Studio refuses that to MCP code
    // (probe-bridge.ts); with no host in this playtest it runs as written.
    if (datamodel !== 'Edit' && this.probeHosts && code.length <= BRIDGE_MAX_CODE && NEEDS_GAME_RIGHTS.test(code) && !(await this.linkServes(datamodel))) {
      const via = await this.call('execute_luau', { code: bridgedProgram(code, datamodel, timeoutMs / 1000 - 5), datamodel_type: datamodel }, { timeoutMs, signal });
      if (!(via.ok && textOf(via).trim() === NO_HOST)) return { ok: via.ok, output: via.ok ? textOf(via) : cleanLuauError(via.error ?? textOf(via)), durationMs: via.durationMs };
    }
    const res = await this.call('execute_luau', { code, datamodel_type: datamodel }, { timeoutMs, signal });
    return { ok: res.ok, output: res.ok ? textOf(res) : cleanLuauError(res.error ?? textOf(res)), durationMs: res.durationMs };
  }

  /** The probe hosts are in the playtest that is running (they were put in before it started). */
  private probeHosts = false;
  /** Whether Studio refuses scripts to MCP code, and when that was last asked (it changes with a Studio restart at most). */
  private restricted: { value: boolean; at: number } | null = null;

  /**
   * Does Studio run MCP code without the script capabilities (see probe-bridge.ts)? Asked in Edit, remembered for
   * ten minutes; "no" when it can't be told. Tests and Studios that allow everything pay one tiny call.
   */
  async scriptsRestricted(): Promise<boolean> {
    if (this.restricted && Date.now() - this.restricted.at < 10 * 60_000) return this.restricted.value;
    // Asked of Studio's MCP server itself (never through the plugin): this is about what that path may do.
    const r = await this.call('execute_luau', { code: RESTRICTED_PROBE, datamodel_type: 'Edit' }, { timeoutMs: 15_000, mcpOnly: true }).catch(() => null);
    if (!r?.ok) return this.restricted?.value ?? false;
    const value = textOf(r).trim() === 'restricted';
    if (value && !this.restricted?.value) this.log.warn("Studio runs MCP code without its script capabilities: scripts are created through Studio's script tool, and probes that require modules or fire events run through a host script in the playtest");
    this.restricted = { value, at: Date.now() };
    return value;
  }

  /** What is known about Studio's MCP path refusing scripts (null: not asked yet). */
  get mcpRestricted(): boolean | null {
    return this.restricted?.value ?? null;
  }

  /** Puts the probe hosts in (Edit, before a playtest starts). Failures only mean probes run as written. */
  private async installProbeHosts(): Promise<boolean> {
    try {
      const present = JSON.parse(textOf(await this.call('execute_luau', { code: HOSTS_PRESENT, datamodel_type: 'Edit' }, { timeoutMs: 15_000 }))) as boolean[];
      for (const [i, s] of HOST_SCRIPTS.entries()) {
        if (present[i]) continue;
        const made = await this.call('multi_edit', { file_path: s.path, className: s.className, datamodel_type: 'Edit', edits: [{ old_string: '', new_string: '-- Shuriken Studio probe host\n' }] }, { timeoutMs: 20_000 });
        if (!made.ok) throw new Error(made.error ?? 'multi_edit failed');
      }
      const wrote = await this.call('execute_luau', { code: HOSTS_WRITE, datamodel_type: 'Edit' }, { timeoutMs: 15_000 });
      if (!wrote.ok) throw new Error(wrote.error ?? 'writing the hosts failed');
      return true;
    } catch (e) {
      this.log.warn('Could not put the probe hosts into the place; probes run as written', errorMessage(e));
      return false;
    }
  }

  /** Run Luau that returns a JSON string; parse it. */
  async luauJson<T>(code: string, datamodel: DataModelType = 'Edit', timeoutMs = 120000): Promise<T> {
    const r = await this.runLuau(code, datamodel, timeoutMs);
    if (!r.ok) throw new Error(r.output);
    try {
      return JSON.parse(r.output) as T;
    } catch {
      throw new Error(`Luau did not return JSON (${r.output.length} characters): ${r.output.length > 700 ? `${r.output.slice(0, 400)} … ${r.output.slice(-200)}` : r.output}`);
    }
  }

  async tree(path: string, datamodel: DataModelType = 'Edit'): Promise<unknown> {
    return this.luauJson(LUAU_TREE.replace(/__PATH__/g, () => JSON.stringify(path)), datamodel, 120_000);
  }

  async detail(path: string, datamodel: DataModelType = 'Edit'): Promise<unknown> {
    return this.luauJson(LUAU_DETAIL.replace(/__PATH__/g, () => JSON.stringify(path)), datamodel, 120_000);
  }

  /** Characters of records the next snapshot page asks for: SNAPSHOT_PAGE_CHARS, less once Studio has cut a page. */
  private snapshotPageChars = SNAPSHOT_PAGE_CHARS;

  /**
   * Deterministic JSON snapshot of the given roots for before/after comparisons. Studio cuts one
   * execute_luau result at about 100,000 characters, so the place is read page by page (LUAU_SNAPSHOT:
   * every call walks the roots in the same order and writes the next few hundred nodes) and the pages are
   * joined here. Pages that disagree about how many instances the place has mean it changed while they were
   * read: the snapshot starts over, and the last attempt takes what it gets (`unstable`). At most
   * maxInstances nodes are read (`truncated` when the place has more).
   */
  async snapshot(roots: string[], datamodel: DataModelType = 'Edit', maxInstances = 3000, timeoutMs = 120000): Promise<DataModelSnapshot> {
    const deadline = Date.now() + timeoutMs;
    const cap = Math.max(1, Math.floor(maxInstances));
    for (let attempt = 1; ; attempt++) {
      const snap = await this.snapshotPass(roots, datamodel, cap, deadline, attempt < SNAPSHOT_ATTEMPTS);
      if (snap) return snap;
    }
  }

  /** One read of every page; null when the place changed under it and restartOnChange is set. */
  private async snapshotPass(roots: string[], datamodel: DataModelType, cap: number, deadline: number, restartOnChange: boolean): Promise<DataModelSnapshot | null> {
    const nodes: DataModelSnapshot['nodes'] = {};
    let from = 0;
    let count: number | null = null;
    let truncated = false;
    let unstable = false;
    let pages = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`DataModel snapshot timed out (${pages} pages read)`);
      const page = await this.snapshotPage(roots, datamodel, cap, from, Math.min(left, 60_000));
      pages++;
      if (count === null) count = page.count;
      else if (page.count !== count) {
        if (restartOnChange) return null;
        unstable = true;
      }
      truncated = page.truncated;
      if (!Array.isArray(page.nodes)) Object.assign(nodes, page.nodes);
      if (page.next < 0) break;
      if (page.next <= from) throw new Error(`DataModel snapshot made no progress at node ${from}`);
      from = page.next;
    }
    return { roots, count: count ?? 0, truncated, ...(unstable ? { unstable: true } : {}), nodes };
  }

  /** One page, asked again with a smaller budget while Studio keeps cutting it. */
  private async snapshotPage(roots: string[], datamodel: DataModelType, cap: number, from: number, timeoutMs: number): Promise<SnapshotPage> {
    for (;;) {
      const budget = this.snapshotPageChars;
      const code = LUAU_SNAPSHOT.replace('__ROOTS__', () => JSON.stringify(JSON.stringify(roots)))
        .replace('__FROM__', () => String(from))
        .replace('__BUDGET__', () => String(budget))
        .replace('__MAX__', () => String(cap));
      const r = await this.runLuau(code, datamodel, timeoutMs);
      if (!r.ok) throw new Error(r.output);
      let page: SnapshotPage | null = null;
      try {
        page = JSON.parse(r.output) as SnapshotPage;
      } catch {
        /* cut by Studio: below */
      }
      if (page && typeof page.next === 'number' && page.from === from) return page;
      if (page) throw new Error(`DataModel snapshot page out of step (asked for node ${from}, got ${String(page.from)})`);
      if (budget <= SNAPSHOT_MIN_PAGE_CHARS) throw new Error(`Luau did not return JSON (${r.output.length} characters, even for pages of ${budget}): ${r.output.slice(0, 200)} … ${r.output.slice(-120)}`);
      this.snapshotPageChars = Math.max(SNAPSHOT_MIN_PAGE_CHARS, Math.floor(budget / 2));
      this.log.warn(`Studio cut a ${r.output.length}-character snapshot page; pages now hold ${this.snapshotPageChars} characters`);
    }
  }

  async console(): Promise<string> {
    const res = await this.call('get_console_output', {}, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(res.error);
    return textOf(res);
  }

  /**
   * Starts or stops play mode and waits until Studio is there. A request that meets a start or stop still
   * in progress is repeated (PLAY_RETRY) instead of failing: an agent's run that ended while its playtest
   * was still starting must not leave Studio to finish starting it.
   */
  async setPlaying(start: boolean): Promise<StudioState> {
    // The probe hosts are the way without the plugin: not needed once the plugin has been seen inside a playtest.
    const linked = !!this.link?.has('Edit') && this.link.playProven;
    // Edit work goes on during playtests (editInPlay), so a start first lets the code sync under way finish and
    // keeps new ones out until Studio has made its copy of the place.
    if (start) await this.lease?.beginPlayStart();
    let st: StudioState;
    // Studio comes to the front as play starts or stops: an agent's start or stop gives the user's window back.
    const guarded = await this.guardFocus(this.playTurnMs() + FOCUS_GUARD.settleMs);
    try {
      const withHosts = start && !linked && (await this.scriptsRestricted().catch(() => false));
      // In the captures' line: a capture in flight when play stops kills Studio's capture tool (CAPTURE_TARGET_CLOSED).
      st = await this.inShotLine((over) => this.setPlayingNow(start, withHosts, over), this.playTurnMs(), start ? 'bring the playtest up' : 'stop the playtest');
    } finally {
      if (start) this.lease?.endPlayStart();
      if (guarded) void this.guardFocus(FOCUS_GUARD.settleMs);
    }
    const playing = st.availableDataModels.includes('Server') || st.availableDataModels.includes('Client');
    if (start && playing) {
      this.playStartedAt = Date.now();
      // The holder's 60 s of play count from here: the load is not part of them (PLAYTEST_LIMITS.playMs).
      const holder = this.lease?.holder;
      if (holder) this.lease!.markPlaying(holder.owner);
      // An agent's playtest (not the user's own from the app): the mouse and the sound follow the user (agentPlay).
      if (!holder?.owner.startsWith('ui:')) void this.agentPlay(true);
    }
    if (!playing && this.agentPlaying) void this.agentPlay(false);
    if (!playing) this.link?.endPlay();
    if (!playing && this.probeHosts) {
      this.probeHosts = false;
      await this.call('execute_luau', { code: HOSTS_REMOVE, datamodel_type: 'Edit' }, { timeoutMs: 15_000 }).catch(() => null);
    }
    return st;
  }

  /** How long the last starts took to bring a playtest up (ms, newest last), for the wait after a slow one. */
  private readonly startTimes: number[] = [];

  /** How long a start that outlasted its request is waited for (PLAY_START). */
  playStartBudget(): number {
    const slowest = this.startTimes.length ? Math.max(...this.startTimes) : 0;
    return Math.min(PLAY_START.maxMs, Math.max(PLAY_START.minMs, 2 * slowest));
  }

  private noteStartTime(ms: number): void {
    this.startTimes.push(ms);
    if (this.startTimes.length > 10) this.startTimes.shift();
  }

  /** When a start last outlasted its request (0: never). */
  private slowStartAt = 0;

  /** This Studio's starts are slow (one outlasted its request lately, or took over a minute): a stop waits for one. */
  private slowStarts(): boolean {
    return Date.now() - this.slowStartAt < 30 * 60_000 || this.startTimes.some((t) => t >= 60_000);
  }

  /**
   * Waits until Studio is in play (`playing`) or out of it, until `until`: null when it didn't get there. Keeps the
   * play holder's lease alive meanwhile (a slow load is not an idle playtest, and its time box starts once it is up).
   * A playtest that is coming up is given a moment for its client too (the character wait starts from there).
   */
  private async waitForPlayState(playing: boolean, until: number, over: () => boolean = () => false): Promise<StudioState | null> {
    let serverSince = 0;
    // The holder whose start this is: a slow load is not an idle playtest (its time counts once it is up).
    const owner = this.lease?.holder?.owner ?? null;
    for (;;) {
      if (over()) return null;
      if (owner) {
        this.lease!.touch(owner);
        // A turn that is not an agent's playtest (the user's, from the app) is not cut while it loads.
        if (!playCapped(owner)) this.lease!.shield(owner, Math.max(0, until - Date.now()) + 60_000);
      }
      const st = await this.state().catch(() => null);
      if (st) {
        const server = st.availableDataModels.includes('Server');
        const client = st.availableDataModels.includes('Client');
        if (!playing && !server && !client) return st;
        if (playing && server && client) return st;
        if (playing && server && !serverSince) serverSince = Date.now();
        if (playing && server && Date.now() - serverSince >= PLAY_START.clientGraceMs) return st;
      }
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, PLAY_START.pollMs));
    }
  }

  private async setPlayingNow(start: boolean, withHosts: boolean, over: () => boolean = () => false): Promise<StudioState> {
    if (withHosts) this.probeHosts = await this.installProbeHosts();
    const began = Date.now();
    let res = await this.call('start_stop_play', { is_start: start }, { timeoutMs: 60000 });
    // A heavy place: Studio is still copying it into play after the request gave up. Wait for it (PLAY_START).
    if (start && !res.ok && START_TIMED_OUT.test(res.error ?? '')) {
      this.slowStartAt = Date.now();
      const budget = this.playStartBudget();
      this.log.info(`Studio is still starting the playtest after ${Math.round((Date.now() - began) / 1000)} s (a heavy place); waiting up to ${Math.round(budget / 1000)} s for it`);
      const st = await this.waitForPlayState(true, began + budget, over);
      if (st) {
        this.noteStartTime(Date.now() - began);
        this.log.info(`The playtest came up after ${Math.round((Date.now() - began) / 1000)} s`);
        return st;
      }
      throw new Error(`Studio did not finish starting the playtest in ${Math.round((Date.now() - began) / 1000)} s. The place is heavy and this Studio may be slowed by its memory: reopening the place in Studio (Shuriken opens it again) makes starts fast again.`);
    }
    // A request that meets a start or stop still under way is asked again (PLAY_RETRY). On a Studio whose starts are
    // slow a stop waits as long as such a start may take: the start of a heavy place goes on for minutes.
    const longWait = !start && this.slowStarts();
    const busyUntil = Date.now() + this.playStartBudget();
    for (let i = 1; !res.ok && !over() && PLAY_BUSY.test(res.error ?? '') && (longWait ? Date.now() < busyUntil : i <= PLAY_RETRY.retries); i++) {
      if (i === 1 || i % 8 === 0) this.log.info(`Studio isn't ready to ${start ? 'start' : 'stop'} play yet (${(res.error ?? '').slice(0, 100)}); asking again every ${PLAY_RETRY.delayMs / 1000} s`);
      if (!start) {
        const holder = this.lease?.holder;
        if (holder) this.lease!.touch(holder.owner);
      }
      await new Promise((r) => setTimeout(r, PLAY_RETRY.delayMs));
      res = await this.call('start_stop_play', { is_start: start }, { timeoutMs: 60000 });
    }
    if (!res.ok) throw new Error(res.error);
    // Transitions are asynchronous: poll until the expected DataModels are available.
    const deadline = Date.now() + 45000;
    let st = await this.state();
    while (Date.now() < deadline && !over()) {
      const playing = st.availableDataModels.includes('Server') || st.availableDataModels.includes('Client');
      if (playing === start) {
        if (start) this.noteStartTime(Date.now() - began);
        return st;
      }
      await new Promise((r) => setTimeout(r, PLAY_POLL.ms));
      st = await this.state().catch(() => st);
    }
    return st;
  }

  /** Studio can only capture a visible window: after a capture times out, fail fast for a while. */
  private shotsPausedUntil = 0;
  /** Rounds of captures that timed out, one after the other (a picture ends the count). */
  private shotFails = 0;

  /**
   * "Studio isn't drawing" when a capture timed out a moment ago and none is tried for now, else null. Whoever
   * would wait for Studio before a capture (a turn in its line, a playtest's end) asks first: an agent stood three
   * minutes in the line for a picture that was then not even tried.
   */
  capturePause(): ScreenshotUnavailableError | null {
    if (Date.now() >= this.shotsPausedUntil) return null;
    return this.shotDead ? this.captureDeadError() : new ScreenshotUnavailableError(`${STUDIO_NOT_DRAWING}: its screen capture failed a moment ago, so no new one was tried. ${NOT_DRAWING_ADVICE}`);
  }

  /** Studio's capture tool stopped answering for good (CAPTURE_TARGET_CLOSED): since when. A picture, or the place reopened, ends it. */
  private shotDead: { since: number } | null = null;
  /**
   * Captures are taken for dead (Studio said so, or CAPTURE_DEAD_ROUNDS rounds timed out): whoever can reopen the
   * place is told (StudioRecovery.refresh), each time a look whether they are back fails too.
   */
  onCaptureDead: (() => void) | null = null;

  /** Since when Studio's capture tool is known to be dead (null: it isn't, as far as anyone knows). */
  get capturesDeadSince(): number | null {
    return this.shotDead?.since ?? null;
  }

  /** How many rounds of captures timed out in a row. */
  get captureFailRounds(): number {
    return this.shotFails;
  }

  private captureDeadError(): ScreenshotUnavailableError {
    return new ScreenshotUnavailableError(
      `${STUDIO_NOT_DRAWING}: Studio's screen capture stopped answering at ${clockTime(this.shotDead?.since ?? Date.now())} (a fault in Studio: a capture met a playtest that stopped under it, and no capture is answered after that until the place is closed and opened again; Shuriken reopens it by itself when it can save first and nobody is using the PC). ${NOT_DRAWING_ADVICE}`,
    );
  }

  private captureDied(): void {
    if (!this.shotDead) this.log.warn("Studio's screen capture is dead: a capture met a playtest that stopped under it. It answers again once the place is closed and opened again");
    this.shotDead ??= { since: Date.now() };
    this.shotFails = Math.max(this.shotFails, CAPTURE_DEAD_ROUNDS);
    this.shotsPausedUntil = Date.now() + Math.max(SHOT_RETRY.pauseMs, SHOT_RETRY.pauseMaxMs);
    this.onCaptureDead?.();
  }

  /** The place was opened again (or captures are known to work): pictures are asked for as usual. */
  capturesBack(): void {
    this.shotDead = null;
    this.shotFails = 0;
    this.shotsPausedUntil = 0;
  }

  /**
   * A start or stop of play takes a place in the captures' line: neither meets the other. Each turn has `maxMs`: past
   * it the turn gives its place up (and fails) even when Studio never answered, so a start whose Studio hung no longer
   * holds every stop, capture and start behind it. On 2026-10-06 one did for 90 minutes, and nothing could stop it.
   */
  private async inShotLine<T>(fn: (over: () => boolean) => Promise<T>, maxMs: number, what: string): Promise<T> {
    const before = this.shotQueue;
    let done = (): void => undefined;
    this.shotQueue = new Promise<void>((r) => (done = r));
    const line = this.playLine;
    const gone = this.lineGone.promise;
    await before;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let over = false;
    // Over when its time is up, and when Studio went (resetPlayLine): a turn of a Studio that is gone is not waited for.
    const isOver = () => over || line !== this.playLine;
    try {
      return await Promise.race([
        fn(isOver),
        gone.then(() => {
          throw new Error('Studio went (or was freed) while this waited for it; nothing is waited for from that Studio any more.');
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            over = true;
            reject(new Error(`Studio did not ${what} within ${Math.round(maxMs / 1000)} s; Shuriken stopped waiting for it so the others can use Studio.`));
          }, maxMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      over = true;
      done();
    }
  }

  /** Counts the times Studio went (or was freed): a start or stop of a Studio that went is not waited for any longer. */
  private playLine = 0;
  /** Settles when the line is reset: the turns still waiting on the Studio that went end then. */
  private lineGone = settleable();

  /**
   * Studio went (a crash, a hang the place was reopened from) or the user freed it: the starts and stops still waiting
   * on the old one end now, nobody waits behind them, and the enforcer is free for the next playtest.
   */
  resetPlayLine(): void {
    this.playLine++;
    this.lineGone.settle();
    this.lineGone = settleable();
    this.shotQueue = Promise.resolve();
    this.enforcing = null;
  }

  /** How long one start or stop of play may take in all (request, a slow start waited for, the poll after it). */
  private playTurnMs(): number {
    return ENFORCE.requestMs + this.playStartBudget() + ENFORCE.settleMs;
  }

  /**
   * Make sure the bound Studio window is drawn: a minimized one is restored behind the user's windows
   * without taking focus (a minimized Studio renders a 1×1 viewport, so captures time out and game input
   * is lost). Only with the real Studio (never in tests); failures are ignored.
   */
  async ensureVisible(): Promise<'restored' | 'visible' | 'nowindow' | 'error' | 'skipped'> {
    const needle = await this.windowNeedle();
    if (!needle) return 'skipped';
    return this.windows.unminimize(needle).catch(() => 'error' as const);
  }

  /** What the adapter does to Studio's window and how it knows whether anybody is at the PC (replaced in tests). */
  windows = {
    idle: new IdleTracker(),
    raise: raiseStudioWindow,
    lower: lowerStudioWindow,
    unminimize: unminimizeStudioWindow,
    guard: (needle: string, ms: number): Promise<boolean> => this.focusGuard.arm(needle, ms),
    play: (needle: string, on: boolean): Promise<boolean> => this.focusGuard.play(needle, on),
    opening: (needle: string, ms: number): Promise<boolean> => this.focusGuard.opening(needle, ms),
  };
  private readonly focusGuard = new StudioFocusGuard((what) => this.focusGuardSaid(what));

  private focusGuardSaid(what: string): void {
    const [kind, program = 'the window you were in'] = what.split(' ');
    if (kind === 'FREE') {
      void this.setMouseFree(program === '1');
      return;
    }
    if (kind === 'GAVEBACK' && program === 'opened') {
      this.log.info('Studio opened in front of the window you were in; it was sent behind it');
      return;
    }
    if (kind === 'GAVEBACK') this.log.info(`Studio took the foreground as play started or stopped; it was given back to ${program}`);
    else if (kind === 'REFUSED') this.log.warn(`Studio took the foreground as play started or stopped, and Windows would not give it back to ${program}`);
  }

  /** An agent's playtest is up in this Studio (agentPlay): the focus guard's FREE goes to it. */
  agentPlaying = false;

  /**
   * An agent's playtest came up (or ended), 1.16.1. The user works at the same PC while builds run: the playtest may
   * not hold their mouse while they use another window (LUAU_MOUSE_FREE_CLIENT, told by the focus guard's FREE), and
   * Studio stays silent while it isn't the window in front (the guard's own sound step).
   */
  private async agentPlay(on: boolean): Promise<void> {
    this.agentPlaying = on;
    const needle = await this.windowNeedle().catch(() => null);
    if (!needle) return;
    await this.windows.play(needle, on).catch(() => false);
    if (!on) return;
    // The client is up a moment after the server: asked twice.
    for (let i = 0; i < 2 && this.agentPlaying; i++) {
      const r = await this.runLuau(LUAU_MOUSE_FREE_CLIENT, 'Client', 15_000).catch(() => null);
      if (r?.ok) return;
      await sleepMs(3000);
    }
  }

  /** The focus guard said whether the user is at the PC in another window: the running agent playtest follows. */
  private async setMouseFree(free: boolean): Promise<void> {
    if (!this.agentPlaying) return;
    await this.runLuau(luauMouseFree(free), 'Server', 10_000).catch(() => null);
  }

  /**
   * While an agent's play starts or stops, this place's Studio may not keep the foreground it takes (StudioFocusGuard).
   * Not for the user's own playtest from the app (owner "ui:…"): Studio comes forward for them to play.
   */
  private async guardFocus(ms: number): Promise<boolean> {
    if (this.lease?.holder?.owner.startsWith('ui:')) return false;
    const needle = await this.windowNeedle().catch(() => null);
    return needle ? this.windows.guard(needle, ms).catch(() => false) : false;
  }
  /** The "Keep the screen on while agents work" setting: with it, a sleeping display is woken for a capture nobody is there to see. */
  keepScreenOn: () => boolean = () => false;

  /** The title of the bound place's Studio window, when there is a real Studio whose window may be handled (never in tests). */
  protected async windowNeedle(): Promise<string | null> {
    if (process.platform !== 'win32' || !this.installInfo.mcpExe) return null;
    const r = await this.resolveStudioId().catch(() => null);
    // Local places are named by their file ("x.rbxlx"); published ones "Name (placeId: …)", titled "Name".
    return r?.ok ? r.name.replace(/\s*\(placeId:.*$/, '').trim() : null;
  }

  /**
   * Gets Studio's window drawn for a capture and returns what puts it back. With someone at the PC (input in the
   * last few minutes, or it can't be told) the user's windows are theirs: only a minimized Studio is restored, behind
   * them, without focus (ensureVisible). With nobody there, Studio's window goes above the others, still without
   * focus, so nothing covers its viewport; a display that went to sleep is woken when the "keep the screen on"
   * setting is on; and afterwards the window goes back where it was in the stack.
   */
  private async showForCapture(): Promise<{ putBack: () => Promise<void>; window: string }> {
    const nothing = async (): Promise<void> => undefined;
    const needle = await this.windowNeedle();
    if (!needle) return { putBack: nothing, window: '' };
    const act = await this.windows.idle.activity().catch(() => null);
    if (!act || act.idleMs < UNATTENDED.idleMs) {
      const did = await this.windows.unminimize(needle).catch(() => 'error' as const);
      // A window that was just restored has a 1×1 viewport until it lays itself out: a capture asked for at once
      // waited out its whole first timeout (the 52 s screenshots in the logs: 45 s, a pause, then 2 s).
      if (did === 'restored') await sleepMs(SHOT_RETRY.restoredMs);
      return { putBack: nothing, window: did === 'nowindow' ? `no Studio window titled "${needle}" was found` : did === 'restored' ? 'the window was minimized and was restored behind your windows' : did === 'visible' ? 'someone is at the PC, so the window was left where it is' : '' };
    }
    const wake = this.keepScreenOn();
    const raised = await this.windows.raise(needle, wake).catch(() => null);
    // The wake is input as far as Windows can tell: it is not the user coming back.
    if (wake) this.windows.idle.noteOwnInput(act.idleMs);
    if (!raised) return { putBack: nothing, window: `no Studio window titled "${needle}" was found` };
    await sleepMs(wake ? SHOT_RETRY.wokenMs : SHOT_RETRY.raisedMs);
    return {
      putBack: async () => {
        await this.windows.lower(raised).catch(() => undefined);
      },
      window: `nobody was at the PC, so the window was put above the others for the capture${wake ? ' and the display was woken' : ' (the display was not woken: "Keep the screen on while agents work" is off)'}`,
    };
  }

  /**
   * Captures go to Studio one at a time: three asked for together each waited out both timeouts (3 × 65 s) for one
   * answer. The line forms at the call itself, once Studio's mode is the caller's (`around` in call). In 1.11 it
   * formed around the whole capture: an agent's Edit-mode screenshot that waited for a verification's playtest to end
   * held the line, the verification's own picture of that playtest stood behind it, and each waited for the other
   * until the six-minute limit, with every agent's Studio work behind them (twice in the first half hour of a build).
   */
  private shotQueue: Promise<unknown> = Promise.resolve();
  /** A capture whose first try timed out and whose second is on its way: the others wait to see how that one ends. */
  private shotRetry: { done: Promise<void>; end: () => void } | null = null;

  /**
   * One capture call in its turn. Behind a capture that is about to try again, it waits for that one's outcome
   * instead of timing out itself, but never longer than its own timeout (the other may be waiting for Studio's
   * mode, which this caller may be the one holding); after a capture that timed out for good it isn't tried at all.
   * `mine` is the caller's mark for "my first try timed out, my second is coming": it is set here, within the turn,
   * so the next in line sees it.
   */
  private async inCaptureTurn(mine: { done: Promise<void>; end: () => void } | null, retrying: boolean, patienceMs: number, attempt: () => Promise<ExternalCallResult>): Promise<ExternalCallResult> {
    for (let waited = false; ; waited = true) {
      const before = this.shotQueue;
      let done = (): void => undefined;
      this.shotQueue = new Promise<void>((r) => (done = r));
      await before;
      let other: Promise<void> | null = null;
      try {
        if (!retrying && !waited && this.shotRetry) other = this.shotRetry.done;
        else if (!retrying && Date.now() < this.shotsPausedUntil) return { ok: false, content: [], error: CAPTURE_PAUSED, durationMs: 0 };
        else {
          const res = await attempt();
          if (!res.ok && mine && !retrying && /timed out/i.test(res.error ?? '')) this.shotRetry = mine;
          return res;
        }
      } finally {
        done();
      }
      await Promise.race([other, sleepMs(patienceMs)]);
    }
  }

  /**
   * A picture of Studio's viewport. A capture that times out or comes back blank (Studio draws nothing while it is
   * minimized, and a screen that is off or asleep gives nothing either) is tried once more after a short wait, with the
   * window restored behind the user's windows first (or, with nobody at the PC, put above them for the capture: showForCapture); if that gives nothing too it is an environment condition, not a
   * failure of the work: ScreenshotUnavailableError, saying Studio isn't drawing, and after timeouts no more captures are
   * tried for 2 minutes (each one costs half a minute), then for longer while it stays that way (SHOT_RETRY).
   * Verification and critics read that as "can't check visually".
   */
  async screenshot(opts: { camera?: [number, number, number]; lookAt?: [number, number, number]; quick?: boolean } = {}): Promise<{ data: string; mimeType: string } | null> {
    const paused = this.capturePause();
    if (paused) throw paused;
    return this.inEditTurn(() => this.screenshotNow(opts));
  }

  private async screenshotNow(opts: { camera?: [number, number, number]; lookAt?: [number, number, number]; quick?: boolean }): Promise<{ data: string; mimeType: string } | null> {
    const failedJustNow = () => this.capturePause() ?? new ScreenshotUnavailableError(`${STUDIO_NOT_DRAWING}: its screen capture failed a moment ago, so no new one was tried. ${NOT_DRAWING_ADVICE}`);
    if (Date.now() < this.shotsPausedUntil) throw failedJustNow();
    const args: Record<string, unknown> = {};
    if (opts.camera) args.camera_position = opts.camera;
    if (opts.lookAt) args.look_at_position = opts.lookAt;
    let why = '';
    let window = '';
    // The last round timed out and its pause is over: one short look whether Studio draws again, not another
    // 25 + 15 s in Studio's line. A failure long ago says nothing about now.
    if (this.shotFails && Date.now() - this.shotsPausedUntil > SHOT_RETRY.pauseMaxMs) this.shotFails = 0;
    const probing = this.shotFails > 0;
    const short = !!opts.quick || probing;
    // A quick capture is a picture for the record taken while others wait for Studio: one short try, no second one.
    const tries = short ? 1 : 2;
    let end = (): void => undefined;
    const retry = tries > 1 ? { done: new Promise<void>((r) => (end = r)), end: () => end() } : null;
    let retrying = false;
    try {
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (attempt > 1) await sleepMs(SHOT_RETRY.delayMs);
        const timeoutMs = short ? SHOT_RETRY.quickTimeoutMs : attempt === 1 ? SHOT_RETRY.firstTimeoutMs : SHOT_RETRY.timeoutMs;
        let t0 = Date.now();
        // The window is shown, captured and put back within the capture's turn: two never move it at once.
        const shownCall = async (once: () => Promise<ExternalCallResult>): Promise<ExternalCallResult> => {
          const shown = await this.showForCapture();
          window = shown.window;
          t0 = Date.now();
          try {
            return await once();
          } finally {
            await shown.putBack();
          }
        };
        const res = await this.call('screen_capture', { ...args, capture_id: `ScreenCapture_${Date.now()}` }, { timeoutMs, around: (once) => this.inCaptureTurn(retry, retrying, timeoutMs, () => shownCall(once)) });
        if (!res.ok) {
          if (res.error === CAPTURE_PAUSED) throw failedJustNow();
          if (CAPTURE_TARGET_CLOSED.test(res.error ?? '')) {
            this.captureDied();
            throw this.captureDeadError();
          }
          if (!/timed out/i.test(res.error ?? '')) throw new Error(res.error);
          why = 'timed out';
          this.log.info(`Capture ${attempt}/${tries} timed out after ${Date.now() - t0} ms${window ? ` (${window})` : ''}`);
          retrying = true;
          continue;
        }
        const img = res.content.find((c) => c.type === 'image' && typeof c.data === 'string');
        if (img && !isBlankImage(img.data as string)) {
          this.capturesBack();
          // A slow or second-try picture is worth a line: it says what the window step did when captures get slow.
          if (attempt > 1 || Date.now() - t0 > 8000) this.log.info(`Capture ${attempt}/${tries} took ${Date.now() - t0} ms${window ? ` (${window})` : ''}`);
          return { data: img.data as string, mimeType: (img.mimeType as string) ?? 'image/png' };
        }
        why = img ? 'came back blank' : 'came back without an image';
        this.log.info(`Capture ${attempt}/${tries} ${why}${window ? ` (${window})` : ''}`);
      }
      // A timeout means the display is off or Studio hidden, and every further try costs half a minute: stop asking for a
      // while. A blank frame comes back at once, so asking again is cheap (and a picture wrongly taken for blank costs nothing).
      if (why === 'timed out') {
        this.shotFails++;
        const pause = Math.min(SHOT_RETRY.pauseMs * 2 ** (this.shotFails - 1), Math.max(SHOT_RETRY.pauseMs, SHOT_RETRY.pauseMaxMs));
        this.shotsPausedUntil = Date.now() + pause;
        if (probing) this.log.info(`Studio still isn't drawing (${this.shotFails} rounds of captures timed out): the next one is tried in ${Math.round(pause / 1000)} s`);
        // A Studio that draws answers in a third of a second: this many rounds of silence is the dead capture tool
        // (or a display that is off; whoever reopens the place tells the two apart).
        if (this.shotFails >= CAPTURE_DEAD_ROUNDS) this.onCaptureDead?.();
        if (this.shotDead) throw this.captureDeadError();
      }
      throw new ScreenshotUnavailableError(`${STUDIO_NOT_DRAWING}: its screen capture ${why}${tries > 1 ? ' on both tries' : probing ? ' again' : ''}${window ? ` (${window})` : ''}. ${NOT_DRAWING_ADVICE}`);
    } finally {
      // The ones that waited for this capture's second try go on now (to their own capture, or to "failed a moment ago").
      if (retry) {
        if (this.shotRetry === retry) this.shotRetry = null;
        retry.end();
      }
    }
  }

  /**
   * Open a local place file in a new Studio window and wait until it appears as an MCP-connected
   * instance whose name contains `match`. Studio must already be installed and signed in.
   */
  async openPlace(file: string, match: string, timeoutMs = 180000, opts: { background?: boolean } = {}): Promise<RobloxStudioInstance> {
    // One launch per place, however many ask. On a restart with Studio closed, the project's own "open my place" and
    // the watch for a Studio that went away each launched it (7 s apart: Studio takes about 20 s to show up in the
    // list either of them looks at). Two windows had the place open: the plugin's edits went into one, playtests ran
    // in the other, and checks tested a stale copy until an agent noticed.
    const key = file.toLowerCase();
    const under = this.opening.get(key);
    if (under) return under;
    // A reopen after a crash, or a build's own open: the new Studio may not stay in front of the user's work (1.16.1).
    if (opts.background) void this.windows.opening(basename(file), timeoutMs).catch(() => false);
    const run = this.openPlaceOnce(file, match, timeoutMs).finally(() => this.opening.delete(key));
    this.opening.set(key, run);
    return run;
  }

  /** Opens of place files that are under way, by file. */
  private readonly opening = new Map<string, Promise<RobloxStudioInstance>>();

  /** Starts Studio with a place file (replaced in tests). */
  protected launchStudio(exe: string, file: string): void {
    if (studioForbidden()) throw new Error(STUDIO_FORBIDDEN);
    // `start` of a file that isn't there fails without a word: the open would wait for a Studio that never comes.
    if (!existsSync(exe)) throw new StudioMovedError(exe);
    // Launch through `cmd /c start` so Studio is not in Shuriken's process tree: a crash or kill of
    // the core must never take the user's Studio (and unsaved work) down with it.
    spawn('cmd.exe', ['/d', '/c', `start "" "${exe}" "${file}"`], { cwd: dirname(file), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }

  /** The running Studio processes (replaced in tests: never the real list). */
  protected studioProcs(): Promise<StudioProcess[]> {
    return studioProcesses();
  }

  /** Whether a Studio process holds Roblox's login lock for good (replaced in tests: never a real log). */
  protected holdsLock(p: StudioProcess): boolean {
    return holdsLoginLock(p);
  }

  /** Ends a Studio process (replaced in tests). */
  protected endProc(pid: number): boolean {
    return endStudio(pid);
  }

  /**
   * A Studio Shuriken started hangs at its login, and another Studio holds Roblox's login lock (studio-login-lock.ts):
   * told to whoever can do something about it (the core: its own Studio is restarted by StudioRecovery, any other
   * is named in the chat). Once per open.
   */
  onLoginLock: ((e: { holder: StudioProcess; stuck: StudioProcess; file: string }) => void) | null = null;

  /** Whether a Studio window already has this place file open, by its title (replaced in tests). */
  protected placeWindowOpen(file: string): Promise<boolean> {
    return studioWindowState(basename(file)).then(
      (st) => st === 'open',
      () => false,
    );
  }

  private async openPlaceOnce(file: string, match: string, timeoutMs: number): Promise<RobloxStudioInstance> {
    if (!existsSync(file)) throw new Error(`Place file not found: ${file}`);
    const existing = (await this.listStudios().catch(() => [])).find((s) => s.name.toLowerCase().includes(match.toLowerCase()));
    if (existing) return existing;
    const info = this.installInfo.versionFolder ? this.installInfo : (this.install = await locateStudio());
    if (!info.versionFolder) throw new Error('Roblox Studio is not installed');
    let exe = join(info.versionFolder, 'RobloxStudioBeta.exe');
    const launch = async (): Promise<void> => {
      try {
        this.launchStudio(exe, file);
      } catch (e) {
        if (!(e instanceof StudioMovedError)) throw e;
        // Studio updated since it was found (the old version's folder is gone or emptied): found again, once.
        const again = (this.install = await locateStudio());
        if (!again.versionFolder) throw new Error('Roblox Studio is not installed');
        exe = join(again.versionFolder, 'RobloxStudioBeta.exe');
        this.launchStudio(exe, file);
      }
    };
    // A window that has the place open and is not in Studio's list yet (still connecting) is waited for, not doubled.
    let launchedAt = 0;
    if (await this.placeWindowOpen(file)) this.log.info(`${file} is open in a Studio window that hasn't connected yet: waiting for it`);
    else {
      await launch();
      launchedAt = Date.now();
      this.log.info(`Opening ${file} in Studio`);
    }
    const deadline = Date.now() + timeoutMs;
    // Roblox's login lock (studio-login-lock.ts): a Studio of ours that took it for good is started again at once; one
    // that hangs at login behind another Studio's lock is reported, and ended if it never opens.
    const name = basename(file);
    const checked = new Set<number>();
    let relaunched = 0;
    let told = false;
    let stuck: StudioProcess | null = null;
    let holder: StudioProcess | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!this.connected && !studioForbidden()) await this.conn.connect().catch(() => {});
      const found = (await this.listStudios().catch(() => [])).find((s) => s.name.toLowerCase().includes(match.toLowerCase()));
      // A Studio we started opens its place in about 5 s, and may have kept the login lock 2 s in: looked at before it
      // is taken (on 2 October two did, each the first Studio after all had been closed, and every Studio after them hung).
      if (found && launchedAt && relaunched < LOGIN_LOCK.relaunches) {
        const wait = launchedAt + LOGIN_LOCK.checkAfterMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const procs = await this.studioProcs().catch(() => [] as StudioProcess[]);
        const opened = procs.find((p) => startedWith(p, name) && p.startedAt >= launchedAt - 5000) ?? null;
        if (opened && !checked.has(opened.pid)) {
          checked.add(opened.pid);
          if (this.holdsLock(opened)) {
            relaunched++;
            this.log.warn(`The Studio just started for ${name} kept Roblox's login lock (a Studio fault that makes every later Studio hang at login): starting it again before anything is done in it`);
            this.endProc(opened.pid);
            // Studio's list of instances lags a process that ended by a moment.
            for (let i = 0; i < 40; i++) {
              const listed = await this.listStudios().catch(() => null);
              if (!listed || !listed.some((s) => s.name.toLowerCase().includes(match.toLowerCase()))) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            this.launchStudio(exe, file);
            launchedAt = Date.now();
            continue;
          }
        }
      }
      if (found) {
        this.bus.emit('roblox.changed', { reason: 'studio-opened' });
        return found;
      }
      if (!launchedAt || Date.now() - launchedAt < LOGIN_LOCK.checkAfterMs) continue;
      const procs = await this.studioProcs().catch(() => [] as StudioProcess[]);
      const mine = procs.find((p) => startedWith(p, name) && p.startedAt >= launchedAt - 5000 && !hasOpen(p, name)) ?? null;
      if (!mine) continue;
      if (!checked.has(mine.pid)) {
        checked.add(mine.pid);
        if (this.holdsLock(mine) && relaunched < LOGIN_LOCK.relaunches) {
          // It took the lock and will keep it: every Studio started after it would hang. Nothing is in it yet.
          relaunched++;
          this.log.warn(`The Studio just started for ${name} took Roblox's login lock and would keep it (a Studio fault that makes every later Studio hang at login): starting it again`);
          this.endProc(mine.pid);
          await new Promise((r) => setTimeout(r, 1500));
          this.launchStudio(exe, file);
          launchedAt = Date.now();
          continue;
        }
      }
      if (stuckAtLogin(mine)) {
        stuck = mine;
        holder = procs.find((p) => p.pid !== mine.pid && this.holdsLock(p)) ?? holder;
        if (holder && !told) {
          told = true;
          this.log.warn(`The Studio started for ${name} hangs at its login: Studio ${holder.pid} ("${holder.title.split(/[\\/]/).pop()}") holds Roblox's login lock`);
          try {
            this.onLoginLock?.({ holder, stuck: mine, file });
          } catch (e) {
            this.log.warn('Reporting the login lock failed', errorMessage(e));
          }
        }
      }
    }
    // A Studio of ours that never opened the place is ended, not left behind (it holds memory, and the lock queue).
    if (stuck) this.endProc(stuck.pid);
    if (stuck && holder) {
      throw new Error(`Studio did not open "${match}" within ${Math.round(timeoutMs / 1000)} s: it hung at its login because another Studio ("${holder.title.split(/[\\/]/).pop() || 'Roblox Studio'}") holds Roblox's login lock (a Studio fault). That Studio has to be closed and opened again; the hung one was ended.`);
    }
    throw new Error(`Studio did not report an instance matching "${match}" within ${Math.round(timeoutMs / 1000)} s. Is the MCP server enabled in Studio (Assistant → Manage MCP Servers)?`);
  }

  // ─── Health ─────────────────────────────────────────────────────────────────

  async healthChecks(): Promise<HealthCheckResult[]> {
    const out: HealthCheckResult[] = [];
    const time = async (id: string, name: string, fn: () => Promise<{ status: HealthCheckResult['status']; message: string; data?: unknown }>) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        out.push({ id, name, durationMs: Date.now() - t0, ...r });
      } catch (e) {
        out.push({ id, name, status: 'unavailable', message: errorMessage(e), durationMs: Date.now() - t0 });
      }
    };
    await time('roblox.install', 'Studio installation', async () => {
      this.install = await locateStudio();
      if (!this.install.versionFolder) return { status: 'unavailable', message: 'Roblox Studio is not installed' };
      if (!this.install.mcpExe) return { status: 'unsupported', message: `Studio ${this.install.studioVersion ?? '?'} has no StudioMCP.exe` };
      return { status: 'healthy', message: `Studio ${this.install.studioVersion ?? '?'} (${this.install.versionFolder})`, data: this.install };
    });
    await time('roblox.mcp', 'Studio MCP server', async () => {
      if (studioForbidden()) return { status: 'unavailable', message: STUDIO_FORBIDDEN };
      await this.conn.connect();
      if (this.conn.state !== 'connected') return { status: 'unavailable', message: this.conn.lastError ?? this.conn.state };
      return { status: 'healthy', message: `${this.conn.serverInfo?.name ?? 'StudioMCP'} ${this.conn.serverInfo?.version ?? ''} · ${this.conn.listTools().length} tools` };
    });
    if (this.conn.state !== 'connected') return out;
    await time('roblox.instances', 'Studio instances', async () => {
      const studios = await this.listStudios();
      if (studios.length === 0) return { status: 'needs_configuration', message: 'No Studio instance connected. Open a place in Studio with the MCP server enabled.' };
      const r = await this.resolveStudioId();
      if (!r.ok) return { status: 'needs_configuration', message: r.error, data: studios };
      return { status: 'healthy', message: `Bound to "${r.name}" (${studios.length} open)`, data: studios };
    });
    if (!out.some((c) => c.id === 'roblox.instances' && c.status === 'healthy')) return out;
    await time('roblox.state', 'Studio state', async () => {
      const st = await this.state();
      return { status: 'healthy', message: `Mode ${st.mode ?? '?'} · DataModels ${st.availableDataModels.join(', ') || 'none'}`, data: st };
    });
    await time('roblox.luau', 'Luau execution', async () => {
      const st = await this.state();
      const dm: DataModelType = st.availableDataModels.includes('Edit') ? 'Edit' : 'Server';
      const r = await this.runLuau('return tostring(6 * 7) .. "|" .. game.PlaceId', dm, 20000);
      const ok = r.ok && r.output.startsWith('42|');
      this.registry.setStatus('roblox.execute_luau', ok ? 'healthy' : 'degraded', ok ? `Verified in ${r.durationMs} ms` : r.output);
      return { status: ok ? 'healthy' : 'degraded', message: ok ? `Round-trip ${r.durationMs} ms (placeId ${r.output.split('|')[1]})` : `Unexpected output: ${r.output.slice(0, 300)}` };
    });
    await time('roblox.snapshot', 'DataModel snapshot', async () => {
      // During a playtest (Shuriken's own verification, or the user's) the Edit DataModel is not
      // available; the capability is the same, so check it on the Server DataModel instead.
      const st = await this.state();
      const dm: DataModelType = st.availableDataModels.includes('Edit') ? 'Edit' : 'Server';
      const snap = (await this.snapshot(['ReplicatedStorage'], dm, 200)) as { count?: number };
      return { status: 'healthy', message: `Serialized ${snap.count ?? 0} instances${dm === 'Edit' ? '' : ' (Server DataModel: Studio is in a playtest)'}` };
    });
    return out;
  }
}

function textOf(res: ExternalCallResult): string {
  return res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
}

export function parseState(text: string): StudioState {
  const get = (label: string) => new RegExp(`${label}:\\s*(.+)`, 'i').exec(text)?.[1]?.trim() ?? null;
  const dms = (get('Available DataModels') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s): s is DataModelType => s === 'Edit' || s === 'Client' || s === 'Server');
  return { mode: get('Current Studio Mode'), availableDataModels: dms, focused: get('Focused DataModel in the viewport'), raw: text };
}

/** Find the newest Studio build that ships StudioMCP.exe. */
export async function locateStudio(): Promise<StudioInstallInfo> {
  const base = join(process.env.LOCALAPPDATA ?? '', 'Roblox', 'Versions');
  if (!existsSync(base)) return { versionFolder: null, studioVersion: null, mcpExe: null };
  const dirs = readdirSync(base)
    .map((name) => join(base, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, 'RobloxStudioBeta.exe'));
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  // Registry first (what Roblox's own launcher uses), then the newest folder that ships StudioMCP.exe.
  let fromRegistry: string | null = null;
  try {
    const { stdout } = await execFileP('reg', ['query', 'HKCU\\Software\\Roblox\\RobloxStudio', '/v', 'ContentFolder'], { timeout: 10000, windowsHide: true });
    const m = /ContentFolder\s+REG_\w+\s+(.+)/.exec(stdout);
    if (m?.[1]) {
      const dir = dirname(m[1].trim().replace(/[\\/]+$/, ''));
      // Roblox's installer can leave the key on the previous version's folder, and that folder holding only a
      // StudioMCP.exe it couldn't delete (in use): Studio itself must be there too (on 8 October every open of a
      // place started a RobloxStudioBeta.exe that no longer existed, and waited for nothing for 158 s).
      if (existsSync(join(dir, 'StudioMCP.exe')) && existsSync(join(dir, 'RobloxStudioBeta.exe'))) fromRegistry = dir;
    }
  } catch {
    /* key missing */
  }
  const withMcp = fromRegistry ?? dirs.find((d) => existsSync(join(d, 'StudioMCP.exe')));
  const folder = withMcp ?? dirs[0] ?? null;
  let version: string | null = null;
  if (folder) {
    try {
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${join(folder, 'RobloxStudioBeta.exe').replace(/'/g, "''")}').VersionInfo.FileVersion`],
        { timeout: 15000, windowsHide: true },
      );
      version = stdout.trim().replace(/,\s*/g, '.') || null;
    } catch {
      version = null;
    }
  }
  return { versionFolder: folder, studioVersion: version, mcpExe: withMcp ? join(withMcp, 'StudioMCP.exe') : null };
}

/** Studio is not where it was found (an update moved it to a new version folder). */
export class StudioMovedError extends Error {
  override readonly name = 'StudioMovedError';
  constructor(exe: string) {
    super(`Roblox Studio is not where its install says (${exe}): start Studio once from its own shortcut, or reinstall it.`);
  }
}

/** A screenshot couldn't be taken for a reason outside the task (display off, Studio hidden). */
export class ScreenshotUnavailableError extends Error {
  override readonly name = 'ScreenshotUnavailableError';
}
