import { BrowserWindow, protocol, session, type Session, type WebContents, type WebPreferences } from 'electron';
import { createReadStream, mkdirSync, openSync, closeSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { MediaPageRequest, MediaPageResult, MediaProbeResult, MediaRequest, MediaResult } from '../shared/references';

/**
 * The hidden media page's host: the core asks for a reference video or picture to be read (core/references/),
 * and this runs the request on a window nobody sees (the renderer's ?media page), where Chromium decodes it.
 * The page can't read files, so the file is served on a scheme of its own, only in that window's session, only
 * while a request for it runs, under a random name (never any other path), with byte ranges for seeking and
 * CORS for the canvas. What the page returns is written next to the reference: frames as JPEG, the sound as
 * 16-bit PCM, a picture's copy for the model. One request at a time; the window closes after two idle minutes.
 */

export const MEDIA_SCHEME = 'shuriken-media';
const PARTITION = 'shuriken-media';
/** Samples of sound read from the page per call (about 4 MB). */
const AUDIO_CHUNK = 2_000_000;

/** Electron allows privileged schemes only before the app is ready, once: main/index.ts calls this at load. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }]);
}

export interface MediaHostDeps {
  /** The app's page preferences (preload, sandbox); the session and throttling are set here. */
  webPreferences: () => WebPreferences;
  /** Loads the renderer's media page into the window. */
  load: (win: BrowserWindow) => void;
  guard: (wc: WebContents) => void;
  /** False while the app quits or has no window: nothing new is opened then. */
  alive: () => boolean;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

const TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};

function fromDataUrl(url: string): Buffer {
  const i = url.indexOf(',');
  return Buffer.from(i >= 0 ? url.slice(i + 1) : url, 'base64');
}

export class MediaHost {
  private win: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private readonly served = new Map<string, string>();
  private ses: Session | null = null;

  constructor(private readonly d: MediaHostDeps) {}

  run(req: MediaRequest): Promise<MediaResult> {
    const job = this.queue.then(() => this.runNow(req));
    this.queue = job.catch(() => undefined);
    return job;
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.loaded = null;
    this.served.clear();
  }

  private session(): Session {
    if (this.ses) return this.ses;
    const ses = session.fromPartition(PARTITION);
    ses.protocol.handle(MEDIA_SCHEME, (req) => this.serve(req));
    this.ses = ses;
    return ses;
  }

  private async page(): Promise<BrowserWindow> {
    if (!this.d.alive()) throw new Error('The app is closing.');
    if (!this.win || this.win.isDestroyed()) {
      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { ...this.d.webPreferences(), session: this.session(), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
      });
      this.win = win;
      this.d.guard(win.webContents);
      this.loaded = new Promise<void>((resolve, reject) => {
        win.webContents.once('did-finish-load', () => resolve());
        win.webContents.once('did-fail-load', (_e, _code, desc) => reject(new Error(`The media page didn't load (${desc}).`)));
      });
      win.webContents.on('render-process-gone', (_e, details) => {
        this.d.log('warn', 'media page gone', details);
        if (this.win === win) {
          this.win = null;
          this.loaded = null;
        }
      });
      this.d.load(win);
    }
    const win = this.win;
    await this.loaded;
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('typeof window.__media === "function"')) return win;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('The media page never got ready.');
  }

  private async call(win: BrowserWindow, req: MediaPageRequest): Promise<MediaPageResult> {
    // A page that crashes (a file too big for it, a broken decoder) or hangs must not hold the queue forever.
    let stop = () => {};
    const gone = new Promise<never>((_, reject) => {
      const onGone = () => reject(new Error('The media page stopped while reading the file (it may be too big or damaged).'));
      const timer = setTimeout(() => reject(new Error('The media page took over 20 minutes on one step.')), 20 * 60_000);
      win.webContents.once('render-process-gone', onGone);
      win.once('closed', onGone);
      stop = () => {
        clearTimeout(timer);
        if (!win.isDestroyed()) {
          win.webContents.removeListener('render-process-gone', onGone);
          win.removeListener('closed', onGone);
        }
      };
    });
    try {
      const out = (await Promise.race([win.webContents.executeJavaScript(`window.__media(${JSON.stringify(req)})`, true), gone])) as MediaPageResult | { error: string } | null;
      if (!out) throw new Error('The media page gave no answer.');
      if ('error' in out) throw new Error(out.error);
      return out;
    } finally {
      stop();
    }
  }

  private async runNow(req: MediaRequest): Promise<MediaResult> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    try {
      const win = await this.page();
      if (req.op === 'synthesize') {
        const out = await this.call(win, { op: 'synthesize', seconds: req.seconds, ...(req.container ? { container: req.container } : {}) });
        if (out.op !== 'synthesize') throw new Error('The media page answered something else.');
        const file = `${req.outFile}.${/mp4/.test(out.mimeType) ? 'mp4' : 'webm'}`;
        writeFileSync(file, Buffer.from(out.data, 'base64'));
        return { file, mimeType: out.mimeType, clicks: out.clicks, cuts: out.cuts };
      }
      const token = randomBytes(18).toString('hex');
      this.served.set(token, req.file);
      try {
        const url = `${MEDIA_SCHEME}://media/${token}/${encodeURIComponent(basename(req.file))}`;
        mkdirSync(req.outDir, { recursive: true });
        if (req.op === 'probe') {
          const { file: _file, outDir, ...rest } = req;
          const out = await this.call(win, { ...rest, url });
          if (out.op !== 'probe') throw new Error('The media page answered something else.');
          let audio: MediaProbeResult['audio'] = null;
          if (out.audio) {
            // The sound comes over in pieces (a quarter of an hour of it is tens of megabytes).
            const fd = openSync(join(outDir, 'audio.pcm'), 'w');
            try {
              for (let start = 0; start < out.audio.samples; start += AUDIO_CHUNK) {
                const piece = (await win.webContents.executeJavaScript(`window.__mediaAudioChunk(${start}, ${AUDIO_CHUNK})`)) as string;
                writeSync(fd, Buffer.from(piece, 'base64'));
              }
            } finally {
              closeSync(fd);
              await win.webContents.executeJavaScript('window.__mediaAudioDone()').catch(() => undefined);
            }
            const { samples: _samples, ...meta } = out.audio;
            audio = { file: 'audio.pcm', ...meta };
          }
          let preview: { file: string; width: number; height: number } | null = null;
          if (out.preview) {
            const file = `preview.${out.preview.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg'}`;
            writeFileSync(join(outDir, file), fromDataUrl(out.preview.dataUrl));
            preview = { file, width: out.preview.width, height: out.preview.height };
          }
          return { duration: out.duration, width: out.width, height: out.height, scan: out.scan ?? [], audio, audioError: out.audioError ?? null, preview, thumb: out.thumb ?? null, notes: out.notes ?? [] };
        }
        // Frames, a batch at a time so no one answer is too big.
        const frames: Array<{ t: number; file: string; width: number; height: number }> = [];
        const notes: string[] = [];
        for (let i = 0; i < req.times.length; i += 12) {
          const out = await this.call(win, { op: 'frames', url, times: req.times.slice(i, i + 12), maxSide: req.maxSide, quality: req.quality });
          if (out.op !== 'frames') throw new Error('The media page answered something else.');
          for (const f of out.frames) {
            const file = `${req.prefix}-${f.t.toFixed(3).padStart(8, '0')}.jpg`;
            writeFileSync(join(req.outDir, file), fromDataUrl(f.dataUrl));
            frames.push({ t: f.t, file, width: f.width, height: f.height });
          }
          notes.push(...(out.notes ?? []));
        }
        return { frames, notes: notes.slice(0, 3) };
      } finally {
        this.served.delete(token);
      }
    } finally {
      this.idle = setTimeout(() => this.close(), 120_000);
    }
  }

  /** Serves a file the running request named, with byte ranges (seeking) and CORS (the canvas reads its pixels). */
  private serve(request: Request): Response {
    const url = new URL(request.url);
    const file = this.served.get(url.pathname.split('/')[1] ?? '');
    if (!file) return new Response('Not found', { status: 404 });
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return new Response('Gone', { status: 404 });
    }
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
      return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
    }
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }
}
