import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { isBlankImage, RobloxStudioAdapter, ScreenshotUnavailableError, SHOT_RETRY, STUDIO_NOT_DRAWING } from '../src/core/roblox/studio-adapter';
import { coreHarness } from './helpers/make-core';

const fail = (e: string): ExternalCallResult => ({ ok: false, content: [], error: e, durationMs: 1 });
const shot = (data: Buffer, mimeType = 'image/jpeg'): ExternalCallResult => ({ ok: true, content: [{ type: 'image', data: data.toString('base64'), mimeType }], durationMs: 1 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A JPEG-shaped buffer: the headers a decoder reads for its size, then `scan` bytes. */
function jpeg(w: number, h: number, scan: Buffer): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xda, 0x00, 0x0c]), scan]);
}
function png(w: number, h: number, bytes: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(head, 0);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, randomBytes(Math.max(0, bytes - 33))]);
}

const flatScan = Buffer.alloc(40_000, Buffer.from([0x7f, 0xa3, 0xf9, 0x3c, 0x7f, 0xa3, 0xf9, 0x3c, 0x7f]));
const REAL = jpeg(1280, 720, randomBytes(60_000));
const BLANK_1X1 = jpeg(1, 1, randomBytes(3000));
const BLACK = jpeg(1280, 720, flatScan);

describe('telling a blank capture from a picture', () => {
  it('calls no bytes, the 1×1 viewport of a minimized Studio and a flat frame blank, and a picture not', () => {
    expect(isBlankImage('')).toBe(true);
    expect(isBlankImage(randomBytes(500).toString('base64'))).toBe(true);
    expect(isBlankImage(BLANK_1X1.toString('base64'))).toBe(true);
    expect(isBlankImage(BLACK.toString('base64'))).toBe(true);
    expect(isBlankImage(REAL.toString('base64'))).toBe(false);
    expect(isBlankImage(png(1, 1, 5000).toString('base64'))).toBe(true);
    expect(isBlankImage(png(1280, 720, 2500).toString('base64'))).toBe(true);
    expect(isBlankImage(png(1280, 720, 300_000).toString('base64'))).toBe(false);
  });
});

/** Studio's screen_capture answers from a script (the nth call gets the nth answer; the last one repeats). */
class ScriptedShots extends RobloxStudioAdapter {
  sent: string[] = [];
  constructor(private readonly answers: ExternalCallResult[]) {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }
  protected override async callOnce(tool: string): Promise<ExternalCallResult> {
    this.sent.push(tool);
    return this.answers[Math.min(this.sent.length, this.answers.length) - 1]!;
  }
}

const saved = { ...SHOT_RETRY };
beforeEach(() => Object.assign(SHOT_RETRY, { delayMs: 5, timeoutMs: 1000 }));
afterEach(() => Object.assign(SHOT_RETRY, saved));

describe('a screenshot of a Studio that may not be drawing', () => {
  it('returns the picture of a Studio that draws, with one capture', async () => {
    const studio = new ScriptedShots([shot(REAL)]);
    expect(await studio.screenshot()).toMatchObject({ mimeType: 'image/jpeg' });
    expect(studio.sent).toEqual(['screen_capture']);
  });

  it('tries once more after a blank capture, and after a timeout, and returns what the second gives', async () => {
    const blank = new ScriptedShots([shot(BLANK_1X1), shot(REAL)]);
    expect((await blank.screenshot())?.data).toBe(REAL.toString('base64'));
    expect(blank.sent).toHaveLength(2);
    const timedOut = new ScriptedShots([fail('screen capture timed out (Studio only captures a window it is drawing)'), shot(REAL)]);
    expect((await timedOut.screenshot())?.data).toBe(REAL.toString('base64'));
    expect(timedOut.sent).toHaveLength(2);
  });

  it("says Studio isn't drawing, as an environment condition, when the second try is blank too", async () => {
    const studio = new ScriptedShots([shot(BLACK), shot(BLANK_1X1), shot(REAL)]);
    const err = await studio.screenshot().catch((e: Error) => e);
    expect(err).toBeInstanceOf(ScreenshotUnavailableError);
    const message = (err as Error).message;
    expect(message).toContain(STUDIO_NOT_DRAWING);
    expect(message).toMatch(/came back blank on both tries/);
    expect(message).toMatch(/can't check visually/);
    expect(message).toMatch(/not a failure of the work/);
    expect(studio.sent).toHaveLength(2);
    // A blank frame comes back at once: the next ask goes to Studio again, and a Studio that draws again answers.
    expect((await studio.screenshot())?.data).toBe(REAL.toString('base64'));
    expect(studio.sent).toHaveLength(3);
  });

  it('after timeouts stops asking for a while (each costs half a minute), and answers at once meanwhile', async () => {
    const studio = new ScriptedShots([fail('screen capture timed out')]);
    await expect(studio.screenshot()).rejects.toBeInstanceOf(ScreenshotUnavailableError);
    expect(studio.sent).toHaveLength(2);
    const again = await studio.screenshot().catch((e: Error) => e);
    expect(again).toBeInstanceOf(ScreenshotUnavailableError);
    expect((again as Error).message).toContain(STUDIO_NOT_DRAWING);
    expect(studio.sent).toHaveLength(2);
  });

  it('does the same for captures that keep timing out, or come back without an image', async () => {
    const timedOut = new ScriptedShots([fail('screen capture timed out')]);
    await expect(timedOut.screenshot()).rejects.toThrow(/screen capture timed out on both tries/);
    expect(timedOut.sent).toHaveLength(2);
    const empty = new ScriptedShots([{ ok: true, content: [{ type: 'text', text: 'done' }], durationMs: 1 }]);
    await expect(empty.screenshot()).rejects.toThrow(/came back without an image on both tries/);
  });

  it('leaves a real error alone: no retry, no environment label', async () => {
    const studio = new ScriptedShots([fail('capture_id must be unique')]);
    const err = await studio.screenshot().catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(ScreenshotUnavailableError);
    expect((err as Error).message).toBe('capture_id must be unique');
    expect(studio.sent).toHaveLength(1);
  });

  it("restores the window without taking focus only where it can (never without a real Studio)", async () => {
    expect(await new ScriptedShots([shot(REAL)]).ensureVisible()).toBe('skipped');
  });
});

describe('what the agents and the verification see when Studio is not drawing', () => {
  const makeCore = coreHarness();
  const unavailable = () => new ScreenshotUnavailableError(`${STUDIO_NOT_DRAWING}: its screen capture came back blank on both tries. This is an environment condition, not a failure of the work.`);

  it('roblox_screenshot answers with the condition (not an error) and notes it on the task for the critic', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.screenshot = async () => {
      throw unavailable();
    };
    const task = ctx.tasks.create({ kind: 'implement', title: 'Dress the arena', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test' });
    const agent = { kind: 'agent' as const, runId: 'run_me', taskId: task.id, role: 'roblox-engineer', providerId: null, allowedTools: null };
    const r = await core.tools.invoke('roblox_screenshot', {}, agent);
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ environment: 'studio_not_drawing', visualCheck: 'unavailable' });
    expect(r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain(STUDIO_NOT_DRAWING);
    // Once on the task, however often it is asked.
    await core.tools.invoke('roblox_screenshot', {}, agent);
    const notes = ctx.tasks.evidence(task.id).filter((e) => e.kind === 'note' && e.title.includes(STUDIO_NOT_DRAWING));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ passed: null });
    // Other failures are still errors.
    studio.screenshot = async () => {
      throw new Error('boom');
    };
    expect((await core.tools.invoke('roblox_screenshot', {}, agent)).isError).toBe(true);
  });

  // Agents stood three minutes in Studio's line (behind a playtest, then for their turn) to be told that no capture
  // was tried.
  it("roblox_screenshot says at once that no capture is tried, without waiting for someone's playtest to end", async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.shotsPausedUntil = Date.now() + 60_000;
    studio.screenshot = async () => {
      throw new Error('no capture is asked for');
    };
    core.lease.tryAcquire('run_playing');
    const task = ctx.tasks.create({ kind: 'implement', title: 'Dress the arena', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test' });
    const agent = { kind: 'agent' as const, runId: 'run_me', taskId: task.id, role: 'roblox-engineer', providerId: null, allowedTools: null };
    const t0 = Date.now();
    const r = await core.tools.invoke('roblox_screenshot', { shots: [{ title: 'front' }, { title: 'back' }] }, agent);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ environment: 'studio_not_drawing', visualCheck: 'unavailable' });
    expect(r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')).toMatch(/failed a moment ago, so no new one was tried/);
    expect(ctx.tasks.evidence(task.id).filter((e) => e.kind === 'note' && e.title.includes(STUDIO_NOT_DRAWING))).toHaveLength(1);
    core.lease.release('run_playing');
  });

  it('a screenshot check is skipped as "can’t check visually", never failed, with a note for the critic', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.state = async () => ({ mode: 'Edit', availableDataModels: ['Edit'], focused: 'Edit', raw: '' });
    const check = { kind: 'screenshot' as const, name: 'arena_view', instructions: 'The arena has a landmark and warm light' };
    const task = ctx.tasks.create({ kind: 'implement', title: 'Dress the arena', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification: [check] });
    for (const answer of [
      async () => {
        throw unavailable();
      },
      async () => null,
    ]) {
      studio.screenshot = answer;
      const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
      const result = report.results.find((x) => x.name === 'arena_view')!;
      expect(result.passed).toBeNull();
      expect(result.output).toMatch(/^Skipped, can't check visually \(environment, not a defect of the work\)/);
      expect(report.passed).toBe(true);
    }
    expect(ctx.tasks.evidence(task.id).some((e) => e.kind === 'note' && e.title.includes(`${STUDIO_NOT_DRAWING} (can't check visually)`))).toBe(true);
  });

  it('the critic is told to judge by measurements and never to fail the work for it', async () => {
    const { roleFor } = await import('../src/core/agents/roles');
    const text = roleFor('critic').instructions.replace(/\s+/g, ' ');
    expect(text).toMatch(/Studio isn't drawing/);
    expect(text).toMatch(/environment condition, not a defect and not a failed task/);
    expect(text).toMatch(/never fail the work/);
    await sleep(0);
  });
});
