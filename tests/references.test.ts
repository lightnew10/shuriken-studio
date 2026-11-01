import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunRequest } from '../src/core/providers/types';
import type { MediaFramesResult, MediaProbeResult, MediaRequest, MediaResult, MediaSynthResult, ReferenceRecord } from '../src/shared/references';
import { REFERENCE_LIMITS } from '../src/shared/references';
import { encodePng } from '../src/core/modeling/png';
import { int16FromPcm } from '../src/core/references/audio-features';
import { ReferenceStore, directorLines, referencesSection } from '../src/core/references/reference-store';
import { REFERENCE_TOOL_ROLES } from '../src/core/capabilities/reference-tools';
import { ROLES, hiddenToolsFor } from '../src/core/agents/roles';
import { LOOK_TOOLS } from '../src/core/director/look';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * Reference footage from file to study, with the hidden media page replaced by a fake (Chromium's decoding
 * can't run under Node): the fake answers like the page — a scan with a cut at 6 s, a sound track with a click
 * every half second and a low thump at 4 s, frames at the times asked for — and the analyst is a scripted run.
 */

const RATE = REFERENCE_LIMITS.audioRate;

function synthSound(seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let t = 0.25; t < seconds; t += 0.5) {
    const s = Math.round(t * RATE);
    for (let i = 0; i < RATE * 0.02 && s + i < x.length; i++) x[s + i]! += 0.3 * Math.exp(-i / (RATE * 0.003)) * Math.sin((2 * Math.PI * 2500 * i) / RATE);
  }
  const s = Math.round(4 * RATE);
  for (let i = 0; i < RATE * 0.5; i++) x[s + i]! += 0.9 * Math.exp(-i / (RATE * 0.1)) * Math.sin((2 * Math.PI * 60 * i) / RATE);
  return x;
}

function solid(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) out.set(rgb, i * 3);
  return out;
}

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return encodePng({ width: w, height: h, data });
}

/** Answers like the app's media page would, writing what the main process writes. */
function fakeMedia(o: { duration?: number; sound?: boolean } = {}) {
  const calls: MediaRequest[] = [];
  const duration = o.duration ?? 12;
  const run = async (req: MediaRequest): Promise<MediaResult> => {
    calls.push(req);
    if (req.op === 'probe' && req.kind === 'video') {
      const scan = [];
      for (let t = 0; t < duration - 0.08; t += 0.5) scan.push({ t, w: 32, h: 18, rgb: Buffer.from(solid(32, 18, t < 6 ? [40, 150, 60] : [30, 30, 140])).toString('base64') });
      let audio: MediaProbeResult['audio'] = null;
      if (req.audio && o.sound !== false) {
        writeFileSync(join(req.outDir, 'audio.pcm'), int16FromPcm(synthSound(duration)));
        audio = { file: 'audio.pcm', rate: req.audio.rate, seconds: duration, sourceSeconds: duration, channels: 2, truncated: false };
      }
      return { duration, width: 1280, height: 720, scan, audio, audioError: o.sound === false ? 'no sound track' : null } satisfies MediaProbeResult;
    }
    if (req.op === 'probe') {
      writeFileSync(join(req.outDir, 'preview.png'), png(64, 48, [200, 40, 40]));
      return { duration: null, width: 1920, height: 1080, preview: { file: 'preview.png', width: 64, height: 48 }, thumb: { t: 0, w: 8, h: 8, rgb: Buffer.from(solid(8, 8, [200, 40, 40])).toString('base64') } } satisfies MediaProbeResult;
    }
    if (req.op === 'frames') {
      const frames = req.times.map((t) => {
        const file = `${req.prefix}-${t.toFixed(2)}.png`;
        writeFileSync(join(req.outDir, file), png(16, 9, t < 6 ? [40, 150, 60] : [30, 30, 140]));
        return { t, file, width: 16, height: 9 };
      });
      return { frames } satisfies MediaFramesResult;
    }
    const file = `${req.outFile}.webm`;
    writeFileSync(file, 'clip');
    return { file, mimeType: 'video/webm', clicks: [0.5, 1], cuts: [2] } satisfies MediaSynthResult;
  };
  return { run, calls };
}

const isStudy = (req: AgentRunRequest) => 'takeaways' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const text = (r: unknown) => ((r as { content?: Array<{ type: string; text?: string }> }).content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const pictures = (r: unknown) => ((r as { content?: Array<{ type: string }> }).content ?? []).filter((c) => c.type === 'image').length;

const STUDY = {
  summary: 'Third-person sword combat: a snappy hit with a low thump on impact.',
  takeaways: ['Hit-stop of about 80 ms on every sword impact', 'A low 60 Hz thump lands on the impact frame'],
  tags: ['combat', 'audio', 'nonsense'],
  study: '## What it is\nA sword fight.\n\n## What to take into our game\n- Hit-stop of about 80 ms',
};

function sourceFile(name: string, bytes: Buffer | string = 'not really a video'): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuriken-ref-src-'));
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

const media = fakeMedia();
const makeCore = coreHarness({ media: media.run });

describe('a reference video', () => {
  it('becomes frames, measured sound and a study the team reads', async () => {
    const seen: { req: AgentRunRequest | null; frames: unknown; sound: unknown } = { req: null, frames: null, sound: null };
    const { core, ctx, root } = await makeCore({
      respond: async (req, _kind, call) => {
        if (!isStudy(req)) return null;
        seen.req = req;
        const id = /id (ref_[0-9a-z]+)/.exec(req.prompt)![1]!;
        seen.frames = await call('reference_view', { id, part: 'frames', from: 3.5, to: 4.5 });
        seen.sound = await call('reference_view', { id, part: 'sound', from: 3, to: 5 });
        return STUDY;
      },
    });
    core.orchestrator.pause();
    const { added, refused } = await core.references.add([sourceFile('Sword combat.mp4')]);
    expect(refused).toEqual([]);
    const id = added[0]!.id;
    await core.references.idle();
    const rec = core.references.get(id)!;
    expect(rec.status, rec.error ?? '').toBe('ready');
    expect(rec.duration).toBe(12);
    // Frames: one a second, the one after the cut, and the one at the thump.
    const frames = rec.video!.frames;
    expect(frames.length).toBeLessThanOrEqual(REFERENCE_LIMITS.storedFrames);
    expect(rec.video!.cuts).toEqual([6]);
    expect(frames.find((f) => f.why === 'scene')!.t).toBe(6);
    expect(frames.some((f) => f.why === 'sound' && Math.abs(f.t - 4) < 0.01)).toBe(true);
    expect(rec.video!.coverage).toMatch(/frames over 0:12/);
    expect(rec.video!.palette[0]!.hex).toBeTruthy();
    // Sound: the click track's tempo, and the thump as a loud low hit paired with its frame.
    expect(Math.abs(rec.audio!.tempo!.bpm - 120)).toBeLessThan(3);
    const thump = rec.audio!.events.find((e) => Math.abs(e.t - 4) < 0.01)!;
    expect(thump.character).toBe('low');
    expect(thump.frame?.t).toBe(4);
    expect(rec.spectrograms!.map((s) => s.file)).toEqual(['spectrogram-01.png']);
    // The study: written, the unknown tag dropped, what it cost recorded.
    expect(rec.study!.summary).toBe(STUDY.summary);
    expect(rec.study!.tags).toEqual(['combat', 'audio']);
    expect(rec.study!.runId).toBeTruthy();
    const md = readFileSync(join(ctx.dir, 'references', id, 'study.md'), 'utf8');
    expect(md).toMatch(/^# Reference: Sword combat/);
    expect(md).toContain('The sound was measured, not heard; speech is not transcribed');
    expect(md).toContain('## What it is');
    expect(md).toContain('## Measured');
    // What the analyst got: frames with their times, the spectrogram, a brief with the numbers and the limits.
    const req = seen.req!;
    expect(req.role).toBe('reference-analyst');
    const captions = req.images!.map((im) => im.caption ?? '');
    expect(captions.filter((c) => c.startsWith('Frame at')).length).toBe(Math.min(frames.length, REFERENCE_LIMITS.studyFrames));
    expect(captions).toContain('Frame at 4.00 s (at a loud hit)');
    expect(captions).toContain('Spectrogram 0–12 s');
    expect(req.prompt).toContain('measured from the waveform, not heard; speech is not transcribed');
    expect(req.prompt).toMatch(/4\.00 s +-?\d+(\.\d)? dBFS +(\+\d+(\.\d)? dB|out of silence) +low/);
    expect(req.prompt).toContain('about 120');
    expect(req.instructions).toContain('never guess what anyone says');
    // Its own look at a stretch and at the sound, through the tools.
    expect(pictures(seen.frames)).toBeGreaterThanOrEqual(1);
    expect(text(seen.frames)).toMatch(/Frame at 4\.00 s/);
    expect(text(seen.sound)).toContain('not heard');
    expect(pictures(seen.sound)).toBe(1);
    // The director's chat said what happened.
    const line = core.director.chat()!.list().find((m) => m.data?.reference === id)!;
    expect(line.text).toContain('is studied');
    // The folder never goes into the game's git history.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.shuriken/references/');
  });

  it('is offered to the team: tools, the context package and the director', async () => {
    const { core, ctx } = await makeCore({ respond: async (req) => (isStudy(req) ? STUDY : null) });
    core.orchestrator.pause();
    const { added } = await core.references.add([sourceFile('Sword combat.mp4')]);
    await core.references.idle();
    const id = added[0]!.id;
    const list = await core.invokeTool('reference_list', {});
    expect(text(list)).toContain(`${id} "Sword combat"`);
    expect(text(list)).toContain('Hit-stop of about 80 ms');
    const view = await core.invokeTool('reference_view', { id: 'sword combat' });
    expect(text(view)).toContain('# Reference: Sword combat');
    expect(pictures(view)).toBe(8);
    // Detail frames at 10 fps between 1 and 2 s: captured once, kept with the reference.
    const detail = await core.invokeTool('reference_view', { id, part: 'frames', from: 1, to: 2, detail: true, fps: 10 });
    expect(detail.isError, text(detail)).toBeFalsy();
    const after = core.references.get(id)!.video!;
    expect(after.detail!.map((f) => f.t)).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]);
    // Every frame of that second is shown: the new ones and the ones stored before.
    expect(pictures(detail)).toBe([...after.frames, ...after.detail!].filter((f) => f.t >= 1 && f.t <= 2).length);
    expect(media.calls.filter((c) => c.op === 'frames' && c.prefix === 'd').length).toBe(1);
    // The package a UI designer's or the planner's run is compiled with.
    const ui = core.compiler.compile(ctx, { runId: 'run_test1', role: ROLES['ui-engineer']!, task: null, directive: 'Build the combat HUD' });
    expect(ui.text).toContain('## Reference footage and pictures from the user');
    expect(ui.text).toContain(`"Sword combat" (${id}, video 0:12): ${STUDY.summary}`);
    expect(ui.text).toContain('Take: Hit-stop of about 80 ms');
    const plan = core.compiler.compile(ctx, { runId: 'run_test2', role: ROLES.executive!, task: null, directive: 'Plan the game' });
    expect(plan.text).toContain('names it (its id, and the seconds for a video)');
    // Who sees the tools: the planner, the critic, the looking pass, the specialists whose work a reference shows.
    for (const role of ['executive', 'critic']) expect(ROLES[role]!.appTools, role).toEqual(expect.arrayContaining(['reference_list', 'reference_view']));
    expect(LOOK_TOOLS).toEqual(expect.arrayContaining(['reference_list', 'reference_view']));
    const sees = (role: string) => core.tools.visibleTo({ kind: 'agent', runId: 'r', taskId: null, role, providerId: 'fake', allowedTools: ROLES[role]!.appTools ? new Set(ROLES[role]!.appTools) : null, hiddenTools: hiddenToolsFor(ROLES[role]!) }).some((t) => t.name === 'reference_view');
    for (const role of ['ui-engineer', 'roblox-engineer', 'animator', 'vfx-artist', 'sound-designer', 'environment-artist', 'executive', 'critic']) expect(sees(role), role).toBe(true);
    for (const role of ['qa-engineer', 'security-engineer', 'performance-engineer', 'copywriter']) expect(sees(role), role).toBe(false);
    expect(REFERENCE_TOOL_ROLES).toContain('copilot-ui');
    // The director's state names them.
    expect(directorLines(core.references.list()).join('\n')).toContain(`"Sword combat" (${id}, video 0:12): ${STUDY.summary}`);
  });

  it('says what it could not do: no sound track, a file it cannot keep, a stopped analysis', async () => {
    const quiet = fakeMedia({ sound: false });
    const harness = coreHarness({ media: quiet.run });
    const { core, ctx } = await harness({ respond: async (req) => (isStudy(req) ? STUDY : null) });
    core.orchestrator.pause();
    const { added, refused } = await core.references.add([sourceFile('Silent.webm'), sourceFile('notes.txt'), sourceFile('huge.png', Buffer.alloc(REFERENCE_LIMITS.imageBytes + 1))]);
    expect(refused.map((r) => r.file)).toEqual(['notes.txt', 'huge.png']);
    expect(refused[0]!.why).toContain("isn't a video or a picture");
    expect(refused[1]!.why).toContain('up to 20 MB');
    await core.references.idle();
    const rec = core.references.get(added[0]!.id)!;
    expect(rec.status).toBe('ready');
    expect(rec.audio).toBeNull();
    expect(rec.audioNote).toBe('no sound track');
    // An analysis that was running when the app closed reads as stopped, not as forever "being read".
    const store = new ReferenceStore(ctx.dir);
    store.save({ ...rec, id: 'ref_0000000000aaaaaaaaaaaaaaaa', status: 'decoding' });
    const stale = core.references.list().find((r) => r.id === 'ref_0000000000aaaaaaaaaaaaaaaa')!;
    expect(stale.status).toBe('failed');
    expect(stale.error).toContain('stopped before it finished');
    // Removing takes the folder and everything made from it.
    expect(core.references.remove(rec.id)).toBe(true);
    expect(existsSync(join(ctx.dir, 'references', rec.id))).toBe(false);
    expect(core.references.list().map((r) => r.id)).toEqual(['ref_0000000000aaaaaaaaaaaaaaaa']);
  });

  it('studies a picture lightly', async () => {
    const seen: AgentRunRequest[] = [];
    const { core } = await makeCore({
      respond: async (req) => {
        if (!isStudy(req)) return null;
        seen.push(req);
        return { summary: 'A cartoon shop screen.', takeaways: ['Big rounded buttons'], tags: ['ui', 'style'], study: '## What it is\nA shop.' };
      },
    });
    core.orchestrator.pause();
    const { added } = await core.references.add([sourceFile('Shop.webp', 'webp')]);
    await core.references.idle();
    const rec = core.references.get(added[0]!.id)!;
    expect(rec.status).toBe('ready');
    expect(rec.image!.palette).toEqual([{ hex: '#c82828', share: 1 }]);
    expect(seen[0]!.images!.map((i) => i.caption)).toEqual(['The reference picture "Shop"']);
    expect(seen[0]!.prompt).toContain('Measured palette: #c82828 100%');
    const view = await core.invokeTool('reference_view', { id: rec.id });
    expect(pictures(view)).toBe(1);
    expect(text(view)).toContain(`ui_reference {file: ".shuriken/references/${rec.id}/preview.png"}`);
  });
});

describe('a reference without the media page', () => {
  const plain = coreHarness();

  it('reads a PNG picture itself, and says a video needs the app', async () => {
    const { core } = await plain({ respond: async (req) => (isStudy(req) ? STUDY : null) });
    core.orchestrator.pause();
    const { added } = await core.references.add([sourceFile('Concept.png', png(10, 10, [20, 200, 20])), sourceFile('Clip.mp4')]);
    await core.references.idle();
    const [pic, clip] = added.map((r) => core.references.get(r.id)!) as [ReferenceRecord, ReferenceRecord];
    expect(pic.status).toBe('ready');
    expect(pic.image!.palette[0]!.hex).toBe('#14c814');
    expect(clip.status).toBe('failed');
    expect(clip.error).toContain("hidden media page");
    await expect(core.references.selftest()).rejects.toThrow(/media page/);
  });
});

describe('safe mode', () => {
  const safe = coreHarness({ media: fakeMedia().run, safeMode: true });

  it('measures but writes no study until agents may run', async () => {
    const runs: AgentRunRequest[] = [];
    const { core } = await safe({
      respond: async (req) => {
        runs.push(req);
        return STUDY;
      },
    });
    const { added } = await core.references.add([sourceFile('Clip.mp4')]);
    await core.references.idle();
    const rec = core.references.get(added[0]!.id)!;
    expect(rec.status).toBe('measured');
    expect(rec.error).toContain('safe mode');
    expect(rec.video!.frames.length).toBeGreaterThan(5);
    expect(runs.filter(isStudy)).toEqual([]);
  });

  it('runs the self-test clip through the pipeline', async () => {
    const { core } = await safe({ respond: async () => null });
    const out = await core.references.selftest({ seconds: 6 });
    expect(out.reference!.from).toBe('selftest');
    expect(out.reference!.status).toBe('measured');
    await waitFor(() => core.references.list().length === 1);
  });
});

describe('the context section', () => {
  const rec = (name: string, tags: string[], takeaways: string[]): ReferenceRecord => ({
    id: `ref_${name.toLowerCase().padEnd(26, '0').slice(0, 26)}`,
    kind: 'video',
    name,
    source: `${name}.mp4`,
    original: 'original.mp4',
    bytes: 1,
    addedAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z',
    from: 'page',
    status: 'ready',
    duration: 30,
    study: { summary: `${name} summary`, takeaways, tags, at: '', runId: null, costUsd: null, imagesShown: 1 },
  });

  it('puts the references a role works on first, with their takeaways, within its budget', () => {
    const refs = [rec('Footsteps', ['audio'], ['Steps every 0.35 s']), rec('Shop', ['ui'], ['Rounded buttons 18% of the height']), rec('Combo', ['combat', 'vfx'], ['Three hits, 0.25 s apart'])];
    const ui = referencesSection(refs, { role: 'ui-engineer', query: 'Build the shop screen' });
    expect(ui.split('\n')[1]).toContain('"Shop"');
    expect(ui).toContain('Take: Rounded buttons 18% of the height');
    const sound = referencesSection(refs, { role: 'sound-designer', query: '' });
    expect(sound.split('\n')[1]).toContain('"Footsteps"');
    // A tight budget keeps the names and drops takeaways first.
    const tight = referencesSection(refs, { role: 'animator', query: '', budget: 420 });
    expect(tight.length).toBeLessThanOrEqual(480);
    expect(tight).toContain('"Combo"');
    expect(referencesSection([], { role: 'animator', query: '' })).toBe('');
  });
});
