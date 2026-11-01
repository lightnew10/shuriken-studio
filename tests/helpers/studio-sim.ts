import { randomBytes } from 'node:crypto';
import type { Core } from '../../src/core/core';
import type { ExternalCallResult } from '../../src/core/mcp/mcp-client';
import { FakeStudio } from './fake-studio';
import { RESTRICTED_PROBE } from '../../src/core/roblox/probe-bridge';

const EDIT = 'Current Studio Mode: Edit\nAvailable DataModels: Edit\nFocused DataModel in the viewport: Edit';
const PLAYING = 'Current Studio Mode: Play\nAvailable DataModels: Client, Server\nFocused DataModel in the viewport: Client';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SimCall {
  tool: string;
  dm: string | null;
  code: string;
  at: number;
  /** The call's arguments as Studio got them. */
  args: Record<string, unknown>;
}

/**
 * A Studio behind the real adapter (its waiting, its lease, its modes): Edit work is refused in play mode and
 * the reverse, start_stop_play flips the mode after `delays`, the code sync's programs run against a
 * FakeStudio place, and any other Luau is answered by `answer` ("PASS" by default). Attach it to a test core
 * with `attachSim`.
 */
export class StudioSim {
  mode: 'Edit' | 'Play' = 'Edit';
  readonly place = new FakeStudio();
  readonly calls: SimCall[] = [];
  /** How long Studio takes to answer a start, a stop, one Luau call and a capture it can draw. */
  delays = { start: 0, stop: 0, luau: 0, shot: 0 };
  /** How long after start_stop_play answered the DataModels really change (Studio's transitions are asynchronous). */
  settle = { start: 0, stop: 0 };
  starts = 0;
  stops = 0;
  /**
   * A heavy place: a start's request times out (as Studio's MCP call did at 60 s on 2026-10-05) while Studio goes on
   * and is in play this many ms later. Null: starts answer normally.
   */
  slowStartMs: number | null = null;
  /** Runs before a call is answered (hold a call back by awaiting something here). */
  before: ((tool: string, args: Record<string, unknown>) => Promise<void> | void) | null = null;
  /** The answer to Luau that isn't one of the sync's programs: a string, or { error }. */
  answer: (code: string, dm: string) => string | { error: string } | Promise<string | { error: string }> = () => 'PASS';
  console = '';
  /** screen_capture's answer: a base64 image, or null for a timeout (it then takes as long as the caller allows). */
  shot: string | null = null;
  captures = 0;
  /** Studio closed (a crash): every call answers that no Studio has the place, as Studio's MCP proxy does. */
  gone = false;
  /**
   * Shuriken Link's Edit instance is linked: Luau in the Edit DataModel is answered during a playtest too, as the
   * plugin does (Studio's own tools, a screenshot among them, still need Edit mode). Set by `linkEdit`.
   */
  linkedEdit = false;

  async callOnce(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<ExternalCallResult> {
    const ok = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });
    const fail = (e: string): ExternalCallResult => ({ ok: false, content: [], error: e, durationMs: 1 });
    const dm = typeof args.datamodel_type === 'string' ? args.datamodel_type : null;
    const code = typeof args.code === 'string' ? args.code : '';
    await this.before?.(tool, args);
    if (this.gone) return fail('No open Studio instance matches "Fake place". Open: ');
    if (tool === 'get_studio_state') return ok(this.mode === 'Edit' ? EDIT : PLAYING);
    // The question asked before a playtest (does Studio refuse scripts to MCP code?): this Studio doesn't, and the question isn't one of the test's calls.
    if (tool === 'execute_luau' && code === RESTRICTED_PROBE) return ok('free');
    this.calls.push({ tool, dm, code, at: Date.now(), args });
    if (tool === 'start_stop_play') {
      const start = args.is_start === true;
      if (start) this.starts++;
      else this.stops++;
      if (start && this.slowStartMs !== null) {
        setTimeout(() => (this.mode = 'Play'), this.slowStartMs);
        return fail('MCP error -32001: Request timed out');
      }
      await sleep(start ? this.delays.start : this.delays.stop);
      const settle = start ? this.settle.start : this.settle.stop;
      if (settle) setTimeout(() => (this.mode = start ? 'Play' : 'Edit'), settle);
      else this.mode = start ? 'Play' : 'Edit';
      return ok(start ? 'Game Started' : 'Game Stopped');
    }
    if (tool === 'get_console_output') return ok(this.console);
    if (tool === 'screen_capture') {
      if (this.mode === 'Play' && dm === 'Edit') return fail('Edit datamodel is not available in Play mode');
      this.captures++;
      if (!this.shot) {
        // A Studio that isn't drawing never answers: the caller's own timeout ends the call.
        if (opts.timeoutMs) await sleep(opts.timeoutMs);
        return fail('screen_capture timed out');
      }
      if (this.delays.shot) await sleep(this.delays.shot);
      return { ok: true, content: [{ type: 'image', data: this.shot, mimeType: 'image/jpeg' }], durationMs: 1 };
    }
    if (tool !== 'execute_luau') return ok('(ok)');
    if (dm === 'Edit' && this.mode === 'Play' && !this.linkedEdit) return fail('Edit datamodel is not available in Play mode');
    if ((dm === 'Server' || dm === 'Client') && this.mode === 'Edit') return fail(`${dm} datamodel is not available in Edit mode`);
    if (this.delays.luau) await sleep(this.delays.luau);
    if (dm === 'Edit' && /ShurikenSync|local function walk\(node, path, ambiguous\)|local s = string\.gsub\(current\(inst\)|inst:Destroy\(\) table\.insert\(deleted, p\)/.test(code)) {
      const r = await this.place.runLuau(code);
      return r.ok ? ok(r.output) : fail(r.output);
    }
    const a = await this.answer(code, dm ?? 'Edit');
    return typeof a === 'string' ? ok(a) : fail(a.error);
  }

  /** Luau calls that reached Studio (not state polls or play control), oldest first. */
  luau(dm?: string): SimCall[] {
    return this.calls.filter((c) => c.tool === 'execute_luau' && (!dm || c.dm === dm));
  }
}

/** Puts `sim` behind the core's Studio adapter (connected and bound, as far as the tools can tell). */
export function attachSim(core: Core, sim = new StudioSim()): StudioSim {
  const studio = core.studio as unknown as Record<string, unknown>;
  studio.availability = () => ({ ok: true });
  studio.callOnce = (tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }) => sim.callOnce(tool, args, opts);
  Object.defineProperty(studio, 'connected', { get: () => true, configurable: true });
  return sim;
}

/** A JPEG-shaped picture that passes for a drawn viewport (see isBlankImage), as base64. */
export function fakePicture(): string {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 720 >> 8, 720 & 255, 1280 >> 8, 1280 & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xda, 0x00, 0x0c]), randomBytes(20_000)]).toString('base64');
}

/** As if Shuriken Link's Edit instance were linked to the place: Edit Luau goes on during a playtest. */
export function linkEdit(core: Core, sim: StudioSim, linked = true): void {
  sim.linkedEdit = linked;
  (core.studio as unknown as { link: unknown }).link = linked ? { has: (dm: string) => dm === 'Edit', playProven: true, endPlay: () => undefined, lostWithin: () => false } : null;
}
