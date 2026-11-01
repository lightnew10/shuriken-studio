/**
 * Reference footage and images: a clip of another game whose combat feel the user wants, concept art, a UI
 * screenshot. The core keeps each one under `<project>/.shuriken/references/<id>/`, the app's hidden media page
 * decodes it (Chromium plays H.264/AAC, VP8/VP9/AV1, Opus, MP3), the core measures the frames and the sound,
 * and one agent run writes the study the team builds from. These types are shared by the core (the pipeline,
 * the tools), the main process (it runs the decoding page and writes what it returns) and the renderer (the
 * References page, the decoding page itself).
 */

export type ReferenceKind = 'video' | 'image';

/** What a reference can be a reference for (the study run picks; the context section uses them to put the right ones first). */
export const REFERENCE_TAGS = ['combat', 'movement', 'camera', 'ui', 'vfx', 'animation', 'audio', 'environment', 'style', 'pacing'] as const;
export type ReferenceTag = (typeof REFERENCE_TAGS)[number];

/**
 * Where an analysis stands. `measured`: frames and sound are measured but no study was written (agents can't
 * run in this window, or the user asked for none yet); `ready`: the study is written.
 */
export type ReferenceStatus = 'queued' | 'decoding' | 'measuring' | 'studying' | 'measured' | 'ready' | 'failed';

export const REFERENCE_BUSY: readonly ReferenceStatus[] = ['queued', 'decoding', 'measuring', 'studying'];

export const REFERENCE_LIMITS = {
  /** The biggest video kept (a copy goes with the project). */
  videoBytes: 4 * 1024 * 1024 * 1024,
  /** The biggest picture kept. */
  imageBytes: 20 * 1024 * 1024,
  /** The sound of a bigger file is not measured: Chromium decodes it in one piece, in memory. */
  audioFileBytes: 4 * 1024 * 1024 * 1024,
  /** Only this much of the sound is measured (from the start). */
  audioSeconds: 60 * 60,
  /** The rate the sound is measured at (mono): enough for everything a game's mix has up to 11 kHz. */
  audioRate: 22050,
  /** Frames kept per video. */
  storedFrames: 60,
  /** Frames the study run is shown (the rest it can ask for with reference_view). */
  studyFrames: 28,
  /** Spectrogram strips the study run is shown. */
  studySpectrograms: 6,
  /** A frame's longest side (px). */
  frameSide: 768,
  /** A picture reference's copy for the model, longest side (px): what the model sees anyway. */
  imageSide: 1568,
  /** Small pictures read to find scene changes and the palette: at most this many, at least this far apart (s). */
  scanPoints: 240,
  scanStep: 0.5,
  scanWidth: 32,
  scanHeight: 18,
  /** Frames reference_view may capture on demand per call, and per reference in all. */
  detailPerCall: 16,
  detailTotal: 160,
  /** References per project. */
  perProject: 40,
} as const;

/** File types the hidden page can decode (what Chromium plays; MKV works when its codecs are ones it plays). */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv'] as const;
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const;

/** A file's kind by its extension, or null when it is neither a video nor a picture the app reads. */
export function referenceKindOf(fileName: string): ReferenceKind | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  return null;
}

/** One stored frame: when it is from and why it was taken. */
export interface ReferenceFrame {
  /** Seconds into the video. */
  t: number;
  /** File name inside the reference's frames/ folder. */
  file: string;
  /** even: spread over the clip; scene: right after a cut; sound: at a loud hit; detail: captured later on request. */
  why: 'even' | 'scene' | 'sound' | 'detail';
}

export interface PaletteColor {
  hex: string;
  /** Share of the pixels (0..1). */
  share: number;
}

/** A loud moment in the sound, with the frame nearest to it. */
export interface AudioEvent {
  t: number;
  /** Loudest 10 ms after it (dBFS). */
  peakDb: number;
  /** How far it jumps over the 200 ms before it (dB). */
  riseDb: number;
  /** How long until it has fallen 12 dB (ms). */
  decayMs: number;
  /** Where its energy is: low (booms, thumps), mid (hits, punches), bright (cracks, clicks, slashes). */
  character: 'low' | 'mid' | 'bright';
  centroidHz: number;
  frame?: { t: number; file: string; dt: number } | null;
}

/** How a hit's jump reads: past 40 dB it came out of (near) silence, and the number says nothing more. */
export function riseWords(riseDb: number): string {
  return riseDb >= 40 ? 'out of silence' : `+${riseDb} dB`;
}

/** The numbers the References page and the brief show about a clip's sound (the full measurement is audio.json). */
export interface AudioSummary {
  /** How long the sound is, and how much of it was measured. */
  seconds: number;
  analyzedSeconds: number;
  truncated: boolean;
  integratedLufs: number | null;
  peakDb: number;
  /** Spread of the 3-second loudness (dB between its 10th and 95th percentile, silence left out). */
  rangeDb: number;
  /** Share of 100 ms stretches under -50 dBFS. */
  silenceRatio: number;
  tempo: { bpm: number; confidence: number } | null;
  /** Energy shares (0..1): bass under 250 Hz, mid to 4 kHz, high above. */
  balance: { bass: number; mid: number; high: number };
  centroidHz: number;
  onsets: number;
  onsetsPerMinute: number;
  events: AudioEvent[];
}

export interface ReferenceStudy {
  /** One line: what the reference is and what it is for. */
  summary: string;
  /** Concrete, buildable points to take into the game. */
  takeaways: string[];
  /** What it is a reference for (combat, movement, ui, vfx, animation, audio, environment, camera, pacing, style). */
  tags: string[];
  at: string;
  runId: string | null;
  costUsd: number | null;
  /** Pictures the run was shown (frames, spectrograms, the image). */
  imagesShown: number;
}

/** A reference as `reference.json` keeps it. */
export interface ReferenceRecord {
  id: string;
  kind: ReferenceKind;
  /** Shown name (the file's name without its extension). */
  name: string;
  /** The file name the user gave. */
  source: string;
  /** The copy's file name inside the reference's folder ("original.mp4"). */
  original: string;
  bytes: number;
  addedAt: string;
  /** Where it came from: the References page, a file dropped in a chat, a self-test clip. */
  from: 'page' | 'chat' | 'selftest';
  status: ReferenceStatus;
  /** What the analysis is doing now, in words. */
  stage?: string | null;
  /** Why it failed (status failed), or what was left out (status measured / ready). */
  error?: string | null;
  updatedAt: string;
  width?: number;
  height?: number;
  /** Seconds (videos). */
  duration?: number | null;
  video?: {
    frames: ReferenceFrame[];
    /** Small pictures looked at to find cuts. */
    scanned: number;
    /** Scene changes found (s). */
    cuts: number[];
    /** What the frames cover, in words ("60 frames over 2:14: one every 3 s, 9 after cuts, 8 at loud hits"). */
    coverage: string;
    palette: PaletteColor[];
    /** Frames captured later at a higher rate (reference_view detail). */
    detail?: ReferenceFrame[];
  };
  /** Sound (videos): null when it had none or couldn't be measured (audioNote says why). */
  audio?: AudioSummary | null;
  audioNote?: string | null;
  spectrograms?: Array<{ file: string; t0: number; t1: number }>;
  image?: { preview: string; width: number; height: number; palette: PaletteColor[] };
  study?: ReferenceStudy | null;
}

/** The scan points of a video: evenly spread, at most `maxPoints`, at least `minStep` apart, never at the very end. */
export function scanTimes(duration: number, maxPoints: number = REFERENCE_LIMITS.scanPoints, minStep: number = REFERENCE_LIMITS.scanStep): number[] {
  if (!(duration > 0) || !Number.isFinite(duration)) return [0];
  const step = Math.max(minStep, duration / Math.max(1, maxPoints));
  const end = Math.max(0, duration - 0.08);
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const t = Math.round(i * step * 1000) / 1000;
    if (t > end || out.length >= maxPoints) break;
    out.push(t);
  }
  return out.length ? out : [0];
}

/** "2:14" or "0:07.5" for a time in seconds. */
export function clock(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${m}:${sec}`;
}

// ─── The media page's protocol (core → main → hidden page) ──────────────────────

/** Read a video or a picture: its size, small scan pictures, its sound as PCM, a copy for the model. */
export interface MediaProbeRequest {
  op: 'probe';
  /** The original (absolute path). */
  file: string;
  kind: ReferenceKind;
  /** Where the decoder writes (absolute): audio.pcm, preview.* */
  outDir: string;
  scan?: { maxPoints: number; minStep: number; width: number; height: number };
  /** Mono 16-bit little-endian PCM at `rate`, at most `maxSeconds`, written to outDir/audio.pcm. Absent: not measured. */
  audio?: { rate: number; maxSeconds: number } | null;
  /** Pictures: a copy at most this many pixels on a side. */
  preview?: { maxSide: number };
}

export interface MediaScan {
  t: number;
  w: number;
  h: number;
  /** RGB bytes, base64. */
  rgb: string;
}

export interface MediaProbeResult {
  /** Seconds (null for pictures, or when the file never says). */
  duration: number | null;
  width: number;
  height: number;
  scan?: MediaScan[];
  audio?: { file: string; rate: number; seconds: number; sourceSeconds: number; channels: number; truncated: boolean } | null;
  audioError?: string | null;
  /** Pictures: the copy for the model (a file in outDir) and a small one for the palette. */
  preview?: { file: string; width: number; height: number } | null;
  thumb?: MediaScan | null;
  notes?: string[];
}

/** Capture frames at these times, at most `maxSide` pixels on a side, as JPEG files in outDir. */
export interface MediaFramesRequest {
  op: 'frames';
  file: string;
  outDir: string;
  times: number[];
  maxSide: number;
  /** JPEG quality 0..1. */
  quality: number;
  /** File names start with this ("f" → f-0012.40.jpg). */
  prefix: string;
}

export interface MediaFramesResult {
  frames: Array<{ t: number; file: string; width: number; height: number }>;
  notes?: string[];
}

/** The self-test: a short clip made in the page (a canvas and a click track recorded together), written to outFile. */
export interface MediaSynthRequest {
  op: 'synthesize';
  /** Absolute path without extension: the decoder adds .webm or .mp4. */
  outFile: string;
  seconds: number;
  /** The container to record (MP4 when Chromium can, else WebM; WebM from a recorder has no length in it, a case worth testing). */
  container?: 'mp4' | 'webm';
}

export interface MediaSynthResult {
  file: string;
  mimeType: string;
  /** When the clicks were scheduled and when the picture cuts (s, relative to the recording's start: the recorder's start delay shifts them a little). */
  clicks: number[];
  cuts: number[];
}

export type MediaRequest = MediaProbeRequest | MediaFramesRequest | MediaSynthRequest;
export type MediaResult = MediaProbeResult | MediaFramesResult | MediaSynthResult;
/** What the page itself gets: the main process swaps the file's path for a URL only the hidden page can load. */
export type MediaPageRequest =
  | (Omit<MediaProbeRequest, 'file' | 'outDir'> & { url: string })
  | (Omit<MediaFramesRequest, 'file' | 'outDir' | 'prefix'> & { url: string })
  | Omit<MediaSynthRequest, 'outFile'>;

/** What the page answers; the main process writes the files and answers the core with MediaResult. */
export type MediaPageResult =
  /**
   * The sound stays on the page (`samples` of it, 16-bit mono): the main process reads it in pieces with
   * window.__mediaAudioChunk(start, count) and lets it go with window.__mediaAudioDone(), because a quarter of
   * an hour of it is tens of megabytes.
   */
  | { op: 'probe'; duration: number | null; width: number; height: number; scan?: MediaScan[]; audio?: { samples: number; rate: number; seconds: number; sourceSeconds: number; channels: number; truncated: boolean } | null; audioError?: string | null; preview?: { dataUrl: string; width: number; height: number } | null; thumb?: MediaScan | null; notes?: string[] }
  | { op: 'frames'; frames: Array<{ t: number; dataUrl: string; width: number; height: number }>; notes?: string[] }
  | { op: 'synthesize'; data: string; mimeType: string; clicks: number[]; cuts: number[] };
