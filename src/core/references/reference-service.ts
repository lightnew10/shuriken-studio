import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@shared/ids';
import {
  REFERENCE_LIMITS,
  REFERENCE_TAGS,
  clock,
  riseWords,
  type AudioEvent,
  type MediaFramesRequest,
  type MediaFramesResult,
  type MediaProbeRequest,
  type MediaProbeResult,
  type MediaRequest,
  type MediaResult,
  type MediaSynthRequest,
  type MediaSynthResult,
  type ReferenceFrame,
  type ReferenceRecord,
  type ReferenceStudy,
} from '@shared/references';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { ProjectContext } from '../projects/project-service';
import type { AgentRunner } from '../orchestrator/agent-runner';
import { registerRoleLabel, type RoleDefinition } from '../agents/roles';
import { ChatService } from '../director/chat-service';
import { decodePng } from '../modeling/png';
import { decodeJpeg, isJpeg } from '../look/jpeg-decode';
import { mimeForPath } from '../util/mime';
import { analyzeAudio, audioSummary, pcmFromInt16, stft, type AudioAnalysis } from './audio-features';
import { pickStrips, spectrogramStrips } from './spectrogram';
import { alignEvents, coverageLine, palette, pickForStudy, planFrames, sceneCuts, signatureOf } from './frames';
import { ReferenceStore, describeKind, settled } from './reference-store';

/**
 * Reference footage and pictures, from file to study: the file is copied into the project, the app's hidden
 * media page decodes it (main process; Chromium's decoders), the core measures what came back (cuts, palette,
 * the sound) and picks the frames, and one agent run — the reference analyst, shown the frames with their
 * times and pictures of the sound — writes the study the planner, the specialists and the docks read. One
 * analysis runs at a time; progress is a status line in the director's chat and the References page.
 */

/** Runs one request on the hidden media page (the core asks the main process). Absent in plain Node and most tests. */
export type MediaRunner = (req: MediaRequest) => Promise<MediaResult>;

export interface ReferenceServiceDeps {
  project: () => ProjectContext | null;
  runner: () => AgentRunner;
  bus: EventBus;
  log: ScopedLogger;
  media: MediaRunner | null;
  /** Whether agent runs may start (not in safe mode or smoke runs): without them the study waits. */
  agentsAllowed: () => boolean;
}

/** The analyst's structured result (OUTPUT_SCHEMAS.reference_study). */
export interface ReferenceStudyOutput {
  summary: string;
  takeaways: string[];
  tags: string[];
  study: string;
}

const ANALYST_INSTRUCTIONS = `ROLE: Reference analyst. The user gave Shuriken Studio a reference: a clip of a game (often another
Roblox game) whose feel they want, or a picture (concept art, a UI screenshot, a mood). The team that builds
the user's Roblox game — the planner, gameplay engineers, the UI designer, animators, VFX and sound
designers, environment artists — works from what you write. They can't watch the clip, so be concrete and
measured, and write what they can build.

What you are shown, and what it can't tell you:
- Frames with their time in seconds. They are SAMPLES (spread evenly, plus the frame right after each cut and
  at each of the loudest hits): what happens between two frames is not seen. Read timings from the frame
  times and say how sure a number is from the gap between them ("about 0.3 s: frames at 12.0 and 12.4").
- Spectrogram strips and measurements of the sound. The sound was MEASURED, NOT HEARD: loudness, the hits and
  their times, a tempo estimate (which can be half or double), where the energy sits. Speech is not
  transcribed: never guess what anyone says. Music mood is a guess from the measurements: say so.
- For a picture: the picture and its measured palette.
To look closer at a moment: reference_view {id, from, to, detail: true} captures frames at up to 30 fps in a
window of a few seconds (one or two calls; your result matters more than more pictures).

How to read feel from frames: a wind-up is from the first anticipation pose to the strike; the impact is the
frame at a loud hit (does the sound land on it?); recovery runs until the character is neutral again;
hit-stop shows as frames that barely change right after an impact; knockback as how far a target moves over
the frames after it; screen shake as the whole view jumping between neighbouring frames.

Write the study in markdown with these sections (leave out one the reference doesn't show):
## What it is — the game and genre, what the clip shows, the camera (first/third person, distance, how it
follows, shake), the controls you can infer.
## UI and HUD — each element by screen zone, what it shows, its size against the screen, colours, fonts,
shapes, what animates.
## Combat and movement feel — each move with its timings (wind-up / impact / recovery), hit-stop, knockback,
combos, cooldowns, movement and jump speed, dashes, how hits are sold (flash, shake, numbers, sound).
## VFX and animation — effects by kind, colour, size and length; the animation style (snappy or floaty,
anticipation, exaggeration).
## World and art style — palette, materials, lighting, density, scale against the character.
## Pacing — what happens how often; the loop as seen.
## Sound — music (tempo estimate, mood guess), sound effects against the impacts, what is loud and quiet.
## What to take into our game — 5-10 concrete, buildable points with numbers (timings, sizes, colours, counts).
## What not to copy — another game's identity (names, logos, characters, exact UI art and icons) and what
would not suit a Roblox game. We take the feel, the timings and the ideas, never the art.
A picture gets a lighter study: What it is, Layout, Style and palette, What to take, What not to copy.

The structured result: summary (one line: what it is and what it is a reference for), takeaways (the "what to
take" points, one line each), tags (what it is a reference for), study (the markdown).`;

/** The run that writes a reference's study: shown the frames and the sound's pictures, a few turns, reading only. */
export const REFERENCE_ANALYST: RoleDefinition = {
  id: 'reference-analyst',
  name: 'Reference Analyst',
  label: 'Reference analyst',
  description: 'Studies reference footage and pictures the user gave and writes what the team should take from them.',
  // The deep tier (the user's worker tier): this is reading pictures closely, once per reference.
  tier: 'worker',
  builtinTools: [],
  appTools: ['reference_view'],
  maxTurns: 8,
  output: 'reference_study',
  effort: 'high',
  instructions: ANALYST_INSTRUCTIONS,
};
registerRoleLabel(REFERENCE_ANALYST.id, REFERENCE_ANALYST.label!);

/** Cost ceiling of one study run (USD): it reads about 30 pictures and writes a page. */
const STUDY_BUDGET_USD = 3;

type RunImage = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; caption?: string };

class StageError extends Error {}

export class ReferenceService {
  private chain: Promise<void> = Promise.resolve();
  /** References waiting in line or being analyzed, with the stop for the one running. */
  private readonly pending = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  /** The director's chat line of each reference (updated as the analysis goes). */
  private readonly notes = new Map<string, string>();

  constructor(private readonly d: ReferenceServiceDeps) {}

  get canDecode(): boolean {
    return !!this.d.media;
  }

  private ctx(): ProjectContext {
    const p = this.d.project();
    if (!p) throw new Error('No project is open');
    return p;
  }

  store(p: ProjectContext = this.ctx()): ReferenceStore {
    return new ReferenceStore(p.dir);
  }

  list(p: ProjectContext | null = this.d.project()): ReferenceRecord[] {
    if (!p) return [];
    return this.store(p)
      .list()
      .map((r) => settled(r, this.pending.has(r.id)));
  }

  get(id: string): ReferenceRecord | null {
    const p = this.d.project();
    if (!p) return null;
    const r = this.store(p).get(id);
    return r ? settled(r, this.pending.has(r.id)) : null;
  }

  /** Copies the files in and queues their analysis. Files that can't be references are refused with the reason. */
  async add(paths: string[], from: ReferenceRecord['from'] = 'page'): Promise<{ added: ReferenceRecord[]; refused: Array<{ file: string; why: string }> }> {
    const p = this.ctx();
    const store = this.store(p);
    const added: ReferenceRecord[] = [];
    const refused: Array<{ file: string; why: string }> = [];
    for (const path of paths.slice(0, 20)) {
      try {
        const rec = await store.add(String(path), from);
        added.push(rec);
        this.emit(rec);
        this.enqueue(p, rec.id, { measure: true, study: true });
      } catch (e) {
        refused.push({ file: String(path).split(/[\\/]/).pop() ?? String(path), why: errorMessage(e) });
      }
    }
    // A file dropped in a chat has no page to show why it wasn't taken: the director's chat says it.
    if (from === 'chat')
      for (const r of refused) {
        try {
          new ChatService(p, this.d.bus).add({ role: 'system', kind: 'error', text: `I couldn't add that as a reference: ${r.why}` });
        } catch {
          /* the chat is optional here */
        }
      }
    return { added, refused };
  }

  /** Measures again and writes a new study (after a failure, or to start over). */
  analyze(id: string): ReferenceRecord {
    const p = this.ctx();
    const rec = this.store(p).get(id);
    if (!rec) throw new Error('That reference is gone.');
    if (this.pending.has(id)) return settled(rec, true);
    const next = this.store(p).patch(id, { status: 'queued', stage: 'Waiting to be analyzed', error: null })!;
    this.emit(next);
    this.enqueue(p, id, { measure: true, study: true });
    return next;
  }

  /** Writes the study again from the measurements already there (no decoding). */
  restudy(id: string): ReferenceRecord {
    const p = this.ctx();
    const rec = this.store(p).get(id);
    if (!rec) throw new Error('That reference is gone.');
    if (this.pending.has(id)) return settled(rec, true);
    const measured = rec.kind === 'video' ? !!rec.video?.frames.length : !!rec.image;
    if (!measured) return this.analyze(id);
    const next = this.store(p).patch(id, { status: 'queued', stage: 'Waiting for its study', error: null })!;
    this.emit(next);
    this.enqueue(p, id, { measure: false, study: true });
    return next;
  }

  /** Removes a reference and everything made from it (stopping its analysis first). */
  remove(id: string): boolean {
    const p = this.ctx();
    this.running.get(id)?.abort();
    this.pending.delete(id);
    const gone = this.store(p).remove(id);
    this.d.bus.emit('references.changed', { id, status: 'removed' });
    return gone;
  }

  /** Stops every analysis (the project closes, the core shuts down). */
  stop(): void {
    for (const a of this.running.values()) a.abort();
    this.pending.clear();
  }

  /** Resolves when the analyses queued so far have finished (tests, the self-test). */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(p: ProjectContext, id: string, opts: { measure: boolean; study: boolean }): void {
    this.pending.add(id);
    this.chain = this.chain
      .then(() => (this.pending.has(id) && this.d.project() === p ? this.run(p, id, opts) : undefined))
      .catch((e) => this.d.log.warn('Reference analysis failed', errorMessage(e)))
      .finally(() => this.pending.delete(id));
  }

  private emit(rec: ReferenceRecord): void {
    this.d.bus.emit('references.changed', { id: rec.id, status: rec.status });
  }

  private set(p: ProjectContext, id: string, patch: Partial<ReferenceRecord>): ReferenceRecord {
    const rec = this.store(p).patch(id, patch);
    if (!rec) throw new StageError('The reference was removed.');
    this.emit(rec);
    return rec;
  }

  /** The reference's line in the director's chat, written once and updated as the analysis goes. */
  private note(p: ProjectContext, rec: ReferenceRecord, text: string, kind: 'status' | 'error' = 'status'): void {
    try {
      const chat = new ChatService(p, this.d.bus);
      const id = this.notes.get(rec.id);
      const data = { reference: rec.id };
      if (id && chat.get(id)) chat.update(id, { text, kind, data });
      else this.notes.set(rec.id, chat.add({ role: 'system', kind, text, data }).id);
    } catch (e) {
      this.d.log.warn('Could not write the reference status line', errorMessage(e));
    }
  }

  private async run(p: ProjectContext, id: string, opts: { measure: boolean; study: boolean }): Promise<void> {
    const abort = new AbortController();
    this.running.set(id, abort);
    let rec = this.store(p).get(id);
    if (!rec) return;
    const label = `“${rec.name}”`;
    try {
      if (opts.measure) {
        this.note(p, rec, `Studying the reference ${label}: reading its ${rec.kind === 'video' ? 'frames and sound' : 'picture'}…`);
        rec = rec.kind === 'video' ? await this.measureVideo(p, rec, abort.signal) : await this.measureImage(p, rec);
      }
      if (abort.signal.aborted) throw new StageError('Stopped.');
      if (!opts.study) {
        rec = this.set(p, id, { status: 'measured', stage: null });
        return;
      }
      if (!this.d.agentsAllowed()) {
        rec = this.set(p, id, { status: 'measured', stage: null, error: 'Agents are off in this window (safe mode), so the study was not written. Press "Write the study" when they can run.' });
        this.note(p, rec, `Measured the reference ${label}; its study waits until agents can run.`);
        return;
      }
      this.note(p, rec, `Studying the reference ${label}: the analyst is writing what to take from it…`);
      rec = await this.writeStudy(p, rec, abort.signal);
      this.note(p, rec, `The reference ${label} is studied: ${rec.study?.summary ?? ''} The team sees it while building (References page).`.replace(/\s+/g, ' '));
    } catch (e) {
      const why = abort.signal.aborted ? 'Stopped.' : errorMessage(e);
      const cur = this.store(p).get(id);
      if (!cur) return;
      const failed = this.store(p).save({ ...cur, status: 'failed', stage: null, error: why });
      this.emit(failed);
      this.note(p, failed, `I couldn't study the reference ${label}: ${why}`, 'error');
      this.d.log.warn(`Reference ${id} failed`, why);
    } finally {
      this.running.delete(id);
    }
  }

  private media<R extends MediaResult>(req: MediaRequest): Promise<R> {
    if (!this.d.media) throw new StageError("Videos are decoded by the app's hidden media page, which isn't available here.");
    return this.d.media(req) as Promise<R>;
  }

  private async measureVideo(p: ProjectContext, rec: ReferenceRecord, signal: AbortSignal): Promise<ReferenceRecord> {
    const store = this.store(p);
    const dir = store.dir(rec.id);
    const file = join(dir, rec.original);
    rec = this.set(p, rec.id, { status: 'decoding', stage: 'Reading the video and its sound…', error: null });
    const L = REFERENCE_LIMITS;
    const soundFits = rec.bytes <= L.audioFileBytes;
    const probe = await this.media<MediaProbeResult>({
      op: 'probe',
      file,
      kind: 'video',
      outDir: dir,
      scan: { maxPoints: L.scanPoints, minStep: L.scanStep, width: L.scanWidth, height: L.scanHeight },
      audio: soundFits ? { rate: L.audioRate, maxSeconds: L.audioSeconds } : null,
    } satisfies MediaProbeRequest);
    if (signal.aborted) throw new StageError('Stopped.');
    const duration = probe.duration && Number.isFinite(probe.duration) ? probe.duration : null;
    if (!duration) throw new StageError("The video's length couldn't be read: Chromium may not play this file. Export it as MP4 (H.264 video, AAC sound) and add it again.");
    rec = this.set(p, rec.id, { status: 'measuring', stage: 'Measuring the sound…', duration, width: probe.width, height: probe.height });
    // The sound.
    let audio: AudioAnalysis | null = null;
    let audioNote: string | null = soundFits ? (probe.audioError ?? null) : `The file is over ${Math.round(L.audioFileBytes / 1024 ** 2)} MB, so its sound was not measured (trim the clip to measure it).`;
    let spectrograms: ReferenceRecord['spectrograms'] = [];
    if (probe.audio) {
      // Each step holds the core for up to a couple of seconds on a 15-minute clip: other calls get a turn between them.
      const breathe = () => new Promise((r) => setImmediate(r));
      const pcm = pcmFromInt16(new Uint8Array(readFileSync(join(dir, probe.audio.file))));
      const s = stft(pcm, probe.audio.rate);
      await breathe();
      audio = analyzeAudio(pcm, probe.audio.rate, { sourceSeconds: probe.audio.sourceSeconds, truncated: probe.audio.truncated, stft: s });
      if (probe.audio.truncated) audioNote = `Only the first ${clock(probe.audio.seconds)} of the sound was measured (of ${clock(probe.audio.sourceSeconds)}).`;
      await breathe();
      const strips = spectrogramStrips(pcm, probe.audio.rate, { stft: s, events: audio.events, onsets: audio.onsetList, stripSeconds: 15, maxStrips: 60 });
      spectrograms = strips.map((st, i) => {
        const name = `spectrogram-${String(i + 1).padStart(2, '0')}.png`;
        writeFileSync(join(dir, name), st.png);
        return { file: name, t0: st.t0, t1: st.t1 };
      });
    } else if (!audioNote) audioNote = 'No sound could be decoded (the clip may have no sound track).';
    if (signal.aborted) throw new StageError('Stopped.');
    // Cuts and palette from the scan pictures; then the frames.
    const sigs = (probe.scan ?? []).map(signatureOf);
    const cuts = sceneCuts(sigs);
    const colours = palette(sigs);
    const sounds = (audio?.events ?? []).map((e) => ({ t: e.t, score: e.peakDb + 0.6 * Math.min(e.riseDb, 30) }));
    const plan = planFrames({ duration, cuts, sounds, max: L.storedFrames });
    rec = this.set(p, rec.id, { stage: `Taking ${plan.length} frames…` });
    const framesDir = join(dir, 'frames');
    mkdirSync(framesDir, { recursive: true });
    // A new analysis replaces the last one's frames (detail frames stay: they are of the same file).
    for (const f of readdirSync(framesDir)) if (f.startsWith('f-')) rmSync(join(framesDir, f), { force: true });
    const got = await this.media<MediaFramesResult>({ op: 'frames', file, outDir: framesDir, times: plan.map((f) => f.t), maxSide: L.frameSide, quality: 0.82, prefix: 'f' } satisfies MediaFramesRequest);
    if (signal.aborted) throw new StageError('Stopped.');
    const frames: ReferenceFrame[] = got.frames.map((f) => ({ t: f.t, file: f.file, why: plan.find((x) => Math.abs(x.t - f.t) < 0.011)?.why ?? 'even' }));
    if (!frames.length) throw new StageError("No frame could be read from the video: Chromium may not play its picture. Export it as MP4 (H.264) and add it again.");
    if (audio) {
      audio = { ...audio, events: alignEvents(audio.events, frames) };
      store.writeAudio(rec.id, audio);
    }
    const notes = [...(probe.notes ?? []), ...(got.notes ?? [])];
    return this.set(p, rec.id, {
      stage: null,
      video: { frames, scanned: sigs.length, cuts: cuts.map((c) => c.t), coverage: coverageLine(duration, frames), palette: colours, detail: rec.video?.detail ?? [] },
      audio: audio ? audioSummary(audio) : null,
      audioNote,
      spectrograms,
      error: notes.length ? notes.join(' ') : null,
    });
  }

  private async measureImage(p: ProjectContext, rec: ReferenceRecord): Promise<ReferenceRecord> {
    const store = this.store(p);
    const dir = store.dir(rec.id);
    const file = join(dir, rec.original);
    rec = this.set(p, rec.id, { status: 'decoding', stage: 'Reading the picture…', error: null });
    if (this.d.media) {
      const probe = await this.media<MediaProbeResult>({ op: 'probe', file, kind: 'image', outDir: dir, preview: { maxSide: REFERENCE_LIMITS.imageSide } } satisfies MediaProbeRequest);
      if (!probe.preview) throw new StageError("The picture couldn't be read.");
      const thumb = probe.thumb ? signatureOf(probe.thumb) : null;
      return this.set(p, rec.id, { stage: null, width: probe.width, height: probe.height, image: { preview: probe.preview.file, width: probe.preview.width, height: probe.preview.height, palette: thumb ? palette([thumb]) : [] } });
    }
    // Without the media page (plain Node): a PNG or baseline JPEG small enough is read here, and shown as it is.
    const bytes = new Uint8Array(readFileSync(file));
    const mime = mimeForPath(rec.original);
    if (!mime || mime === 'image/webp' || bytes.length > 5 * 1024 * 1024) throw new StageError("This picture needs the app's media page to be read, which isn't available here.");
    const img = mime === 'image/png' ? decodePng(bytes) : isJpeg(bytes) ? decodeJpeg(bytes) : null;
    if (!img) throw new StageError("The picture couldn't be read.");
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0; i < img.width * img.height; i++) rgb.set(img.data.subarray(i * 4, i * 4 + 3), i * 3);
    return this.set(p, rec.id, { stage: null, width: img.width, height: img.height, image: { preview: rec.original, width: img.width, height: img.height, palette: palette([{ rgb }]) } });
  }

  /** The pictures and the brief the study run gets. */
  studyInput(p: ProjectContext, rec: ReferenceRecord): { images: RunImage[]; brief: string } {
    const store = this.store(p);
    const images: RunImage[] = [];
    const read = (rel: string, caption: string) => {
      const abs = store.file(rec.id, rel);
      const mediaType = (mimeForPath(abs) ?? (abs.endsWith('.gif') ? 'image/gif' : null)) as RunImage['mediaType'] | null;
      if (!mediaType || !existsSync(abs)) return false;
      images.push({ mediaType, data: readFileSync(abs).toString('base64'), caption });
      return true;
    };
    if (rec.kind === 'image') {
      if (rec.image) read(rec.image.preview, `The reference picture "${rec.name}"`);
      return { images, brief: studyBrief(p, rec, null, [], [], []) };
    }
    const audio = store.audio(rec.id);
    const frames = rec.video?.frames ?? [];
    const picks = pickForStudy(frames, REFERENCE_LIMITS.studyFrames, audio?.events ?? []);
    const shown: ReferenceFrame[] = [];
    for (const f of picks) if (read(`frames/${f.file}`, `Frame at ${f.t.toFixed(2)} s${f.why === 'scene' ? ' (right after a cut)' : f.why === 'sound' ? ' (at a loud hit)' : ''}`)) shown.push(f);
    const strips = pickStrips(rec.spectrograms ?? [], audio?.events ?? [], REFERENCE_LIMITS.studySpectrograms);
    const stripsShown = strips.filter((s) => read(s.file, `Spectrogram ${s.t0.toFixed(0)}–${s.t1.toFixed(0)} s`));
    return { images, brief: studyBrief(p, rec, audio, frames, shown, stripsShown) };
  }

  private async writeStudy(p: ProjectContext, rec: ReferenceRecord, signal: AbortSignal): Promise<ReferenceRecord> {
    rec = this.set(p, rec.id, { status: 'studying', stage: 'Writing the study (one agent run)…' });
    const { images, brief } = this.studyInput(p, rec);
    if (!images.length) throw new StageError('There was nothing to show the analyst (no frames or picture were saved).');
    const outcome = await this.d.runner().run({
      project: p,
      role: REFERENCE_ANALYST,
      task: null,
      signal,
      directive: `Study the reference "${rec.name}" and write what the team should take from it.`,
      contextText: brief,
      images,
      maxBudgetUsd: STUDY_BUDGET_USD,
    });
    const o = outcome.structured as ReferenceStudyOutput | null;
    if (!outcome.completion.ok || !o || typeof o.summary !== 'string' || typeof o.study !== 'string' || !o.study.trim()) throw new StageError(`The analyst didn't finish the study (${outcome.completion.error ?? 'no study came back'}).`);
    const study: ReferenceStudy = {
      summary: o.summary.trim().replace(/\s+/g, ' ').slice(0, 300),
      takeaways: (Array.isArray(o.takeaways) ? o.takeaways : []).filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()).slice(0, 12),
      tags: (Array.isArray(o.tags) ? o.tags : []).filter((t): t is string => (REFERENCE_TAGS as readonly string[]).includes(t)),
      at: nowIso(),
      runId: outcome.run.id,
      costUsd: outcome.completion.costUsd ?? null,
      imagesShown: images.length,
    };
    const fresh = this.store(p).get(rec.id);
    if (!fresh) throw new StageError('The reference was removed.');
    this.store(p).writeStudy(rec.id, studyMarkdown(fresh, study, o.study, this.store(p).audio(rec.id)));
    return this.set(p, rec.id, { status: 'ready', stage: null, study });
  }

  /**
   * Frames at a higher rate in a short window (reference_view detail): for reading a wind-up or a hit-stop
   * closely. Kept with the reference, never more than REFERENCE_LIMITS.detailTotal.
   */
  async captureDetail(id: string, from: number, to: number, fps: number): Promise<ReferenceFrame[]> {
    const p = this.ctx();
    const store = this.store(p);
    const rec = store.get(id);
    if (!rec || rec.kind !== 'video' || !rec.video) throw new Error('Detail frames are for a measured video.');
    if (!this.d.media) throw new Error("New frames need the app's media page, which isn't available here: use the stored frames.");
    const dur = rec.duration ?? 0;
    const a = Math.max(0, Math.min(from, dur));
    const b = Math.max(a, Math.min(to, dur - 0.05, a + 4));
    const step = 1 / Math.max(1, Math.min(30, fps));
    const have = [...rec.video.frames, ...(rec.video.detail ?? [])];
    const times: number[] = [];
    for (let t = a; t <= b + 1e-9 && times.length < REFERENCE_LIMITS.detailPerCall; t += step) {
      const tt = Math.round(t * 1000) / 1000;
      if (!have.some((f) => Math.abs(f.t - tt) < step / 2)) times.push(tt);
    }
    const room = REFERENCE_LIMITS.detailTotal - (rec.video.detail?.length ?? 0);
    if (room <= 0) throw new Error(`This reference already has ${REFERENCE_LIMITS.detailTotal} detail frames: use those (reference_view with from/to).`);
    if (!times.length) return have.filter((f) => f.t >= a - 1e-6 && f.t <= b + 1e-6).sort((x, y) => x.t - y.t);
    const framesDir = join(store.dir(id), 'frames');
    mkdirSync(framesDir, { recursive: true });
    const got = await this.media<MediaFramesResult>({ op: 'frames', file: join(store.dir(id), rec.original), outDir: framesDir, times: times.slice(0, room), maxSide: REFERENCE_LIMITS.frameSide, quality: 0.82, prefix: 'd' } satisfies MediaFramesRequest);
    const added: ReferenceFrame[] = got.frames.map((f) => ({ t: f.t, file: f.file, why: 'detail' }));
    const cur = store.get(id);
    if (cur?.video) {
      const next = store.save({ ...cur, video: { ...cur.video, detail: [...(cur.video.detail ?? []), ...added].sort((x, y) => x.t - y.t) } });
      this.emit(next);
    }
    return [...have, ...added].filter((f) => f.t >= a - 1e-6 && f.t <= b + 1e-6).sort((x, y) => x.t - y.t);
  }

  /**
   * The self-test (smoke runs and the lead's check): the media page records a short clip of its own — a canvas
   * that cuts between colours and a click track — then it goes through the whole pipeline as a reference.
   * Waits for the analysis when asked to.
   */
  async selftest(opts: { seconds?: number; wait?: boolean; container?: 'mp4' | 'webm' } = {}): Promise<{ reference: ReferenceRecord | null; clip: MediaSynthResult }> {
    const p = this.ctx();
    if (!this.d.media) throw new Error("The self-test needs the app's media page (run it in the app, e.g. a smoke run).");
    const scratch = join(p.dir, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const clip = await this.media<MediaSynthResult>({ op: 'synthesize', outFile: join(scratch, 'reference-selftest'), seconds: Math.max(3, Math.min(20, opts.seconds ?? 8)), ...(opts.container ? { container: opts.container } : {}) } satisfies MediaSynthRequest);
    const { added, refused } = await this.add([clip.file], 'selftest');
    rmSync(clip.file, { force: true });
    if (!added[0]) throw new Error(`The self-test clip was refused: ${refused[0]?.why ?? 'unknown'}`);
    if (opts.wait !== false) await this.idle();
    return { reference: this.get(added[0].id), clip };
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function brightness(hz: number): string {
  return hz < 900 ? 'dark, bass-heavy' : hz < 2200 ? 'warm' : hz < 4000 ? 'bright' : 'very bright';
}

/** The brief the analyst reads with the pictures: what the reference is, what the frames cover, the sound's numbers. */
export function studyBrief(p: ProjectContext, rec: ReferenceRecord, audio: AudioAnalysis | null, frames: ReferenceFrame[], shown: ReferenceFrame[], strips: Array<{ t0: number; t1: number }>): string {
  const out: string[] = [];
  out.push(`Reference "${rec.name}" (id ${rec.id}; the user's file ${rec.source}): a ${describeKind(rec)}${rec.width ? `, ${rec.width}×${rec.height}` : ''}.`);
  const goal = p.tasks.list({ kinds: ['objective'] })[0];
  out.push(`Our game: "${p.summary.name}"${goal ? ` — what the user asked for: ${goal.objective.replace(/\s+/g, ' ').slice(0, 700)}` : ' (nothing built yet)'}. Write what to take for THIS game.`);
  if (rec.kind === 'image') {
    out.push('You are shown the picture (labelled above it).');
    if (rec.image?.palette.length) out.push(`Measured palette: ${rec.image.palette.map((c) => `${c.hex} ${pct(c.share)}`).join(', ')}.`);
    return out.join('\n\n');
  }
  const v = rec.video;
  if (v) {
    out.push(`Frames: ${v.coverage} You are shown ${shown.length} of them (each labelled "Frame at <seconds> s", in time order). reference_view {id: "${rec.id}", from, to} shows the others; with detail: true it captures new frames at up to 30 fps in a window of up to 4 s.`);
    out.push(`Frames shown: ${shown.map((f) => `${f.t.toFixed(2)}${f.why === 'even' ? '' : ` (${f.why})`}`).join(', ')}`);
    const others = frames.filter((f) => !shown.includes(f));
    if (others.length) out.push(`Stored but not shown: ${others.map((f) => f.t.toFixed(2)).join(', ')}`);
    if (v.cuts.length) out.push(`Scene changes (cuts) at: ${v.cuts.map((t) => `${t.toFixed(1)} s`).join(', ')}.`);
    if (v.palette.length) out.push(`Measured palette of the clip: ${v.palette.map((c) => `${c.hex} ${pct(c.share)}`).join(', ')}.`);
  }
  if (!audio) out.push(`Sound: ${rec.audioNote ?? 'not measured.'}`);
  else {
    const lines = [`Sound — measured from the waveform, not heard; speech is not transcribed:`];
    lines.push(`- Length ${clock(audio.seconds)}${audio.truncated ? ` (the first ${clock(audio.analyzedSeconds)} measured)` : ''}; loudness ${audio.integratedLufs ?? '—'} LUFS integrated, peak ${audio.peakDb} dBFS, loudness range ${audio.rangeDb} dB, silence ${pct(audio.silenceRatio)}.`);
    lines.push(`- Balance: bass ${pct(audio.balance.bass)}, mid ${pct(audio.balance.mid)}, high ${pct(audio.balance.high)} (bass under 250 Hz, high over 4 kHz); spectral centroid ${audio.centroidHz} Hz (${brightness(audio.centroidHz)}).`);
    lines.push(`- Tempo: ${audio.tempo ? `about ${audio.tempo.bpm} bpm (${audio.tempo.confidence >= 0.5 ? 'a steady beat' : 'a weak beat'}, confidence ${audio.tempo.confidence}; it may be half or double)` : 'no steady beat found'}.`);
    lines.push(`- Onsets (hits, steps, notes): ${audio.onsets}, ${audio.onsetsPerMinute} a minute.`);
    if (audio.events.length) {
      lines.push('- The loudest hits (time, peak, jump over the 200 ms before, character, how long until 12 dB down; the nearest frame):');
      for (const e of audio.events as AudioEvent[]) lines.push(`  ${e.t.toFixed(2)} s  ${e.peakDb} dBFS  ${riseWords(e.riseDb)}  ${e.character}  ${e.decayMs} ms${e.frame ? `  → frame ${e.frame.t.toFixed(2)} s${shown.some((f) => f.t === e.frame!.t) ? ' (shown)' : ''}` : ''}`);
    }
    const rows = audio.sections.rows;
    if (rows.length) {
      const every = Math.max(1, Math.ceil(rows.length / 24));
      const shownRows = rows.filter((_, i) => i % every === 0);
      lines.push(`- How it moves (every ${audio.sections.step * every} s: level dBFS, bass/mid/high, centroid): ${shownRows.map((r) => `${r.t}s ${r.db}dB ${Math.round(r.bass * 100)}/${Math.round(r.mid * 100)}/${Math.round(r.high * 100)} ${r.centroidHz}Hz`).join('; ')}`);
    }
    if (strips.length)
      lines.push(
        `- Spectrograms: ${strips.length} strip${strips.length === 1 ? '' : 's'} (labelled "Spectrogram <from>–<to> s"): time runs left to right (the ruler at the bottom ticks every second and writes the time every 5), frequency bottom to top on a log scale (faint lines at 100, 1000 and 5000 Hz), brighter is louder; the grey lane under it is the level (the dotted red line is -50 dBFS, silence); white ticks above are onsets, orange marks the loudest hits.`,
      );
    if (rec.audioNote) lines.push(`- Note: ${rec.audioNote}`);
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

/** study.md: the analyst's study under a header that says what it was made from, then the measured facts. */
export function studyMarkdown(rec: ReferenceRecord, study: ReferenceStudy, body: string, audio: AudioAnalysis | null): string {
  const out: string[] = [`# Reference: ${rec.name}`, ''];
  out.push(`${describeKind(rec)} · the user's file ${rec.source} · studied ${study.at.slice(0, 16).replace('T', ' ')}${study.tags.length ? ` · for ${study.tags.join(', ')}` : ''}`);
  out.push('');
  out.push(`> ${study.summary}`);
  out.push('');
  if (rec.kind === 'video')
    out.push(`_How this was made: ${rec.video?.coverage ?? 'frames sampled.'} The analyst saw ${study.imagesShown} pictures (frames and pictures of the sound). The sound was measured, not heard; speech is not transcribed._`, '');
  out.push(body.trim(), '');
  if (study.takeaways.length && !/what to take/i.test(body)) out.push('## What to take into our game', '', ...study.takeaways.map((t) => `- ${t}`), '');
  out.push('## Measured', '');
  if (rec.kind === 'video' && rec.video) {
    if (rec.video.cuts.length) out.push(`- Cuts at ${rec.video.cuts.map((t) => `${t.toFixed(1)} s`).join(', ')}.`);
    if (rec.video.palette.length) out.push(`- Palette: ${rec.video.palette.map((c) => `${c.hex} ${pct(c.share)}`).join(', ')}.`);
  }
  if (rec.kind === 'image' && rec.image?.palette.length) out.push(`- Palette: ${rec.image.palette.map((c) => `${c.hex} ${pct(c.share)}`).join(', ')}.`);
  if (audio) {
    out.push(`- Sound: ${audio.integratedLufs ?? '—'} LUFS, peak ${audio.peakDb} dBFS, range ${audio.rangeDb} dB, silence ${pct(audio.silenceRatio)}; bass/mid/high ${pct(audio.balance.bass)}/${pct(audio.balance.mid)}/${pct(audio.balance.high)}, centroid ${audio.centroidHz} Hz; ${audio.tempo ? `about ${audio.tempo.bpm} bpm (confidence ${audio.tempo.confidence})` : 'no steady beat'}; ${audio.onsets} onsets.`);
    if (audio.events.length) out.push(`- Loudest hits: ${[...audio.events].sort((a, b) => b.peakDb - a.peakDb).slice(0, 12).sort((a, b) => a.t - b.t).map((e) => `${e.t.toFixed(2)} s (${e.peakDb} dBFS, ${e.character}${e.frame ? `, frame ${e.frame.t.toFixed(2)} s` : ''})`).join('; ')}.`);
  } else if (rec.audioNote) out.push(`- Sound: ${rec.audioNote}`);
  return `${out.join('\n')}\n`;
}
