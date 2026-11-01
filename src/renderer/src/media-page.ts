import { scanTimes, type MediaPageRequest, type MediaPageResult, type MediaScan } from '@shared/references';

/**
 * The hidden media page (?media): the main process loads it in a window nobody sees and asks it to read the
 * user's reference videos and pictures, because Chromium is what decodes them (H.264/AAC, VP8/VP9/AV1, Opus,
 * MP3, every picture format). A video element seeks to each moment and a canvas copies the frame; the sound is
 * decoded with Web Audio at the rate the core measures at. The files come from a scheme only this window's
 * session serves (shuriken-media://, main/media-decoder.ts), with CORS so the canvas may read the pixels.
 * Nothing here judges anything: the core measures what this returns.
 */

declare global {
  interface Window {
    __media?: (req: MediaPageRequest) => Promise<MediaPageResult | { error: string }>;
    __mediaAudioChunk?: (start: number, count: number) => string;
    __mediaAudioDone?: () => void;
  }
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function wait<T>(what: string, ms: number, start: (ok: (v: T) => void, fail: (e: Error) => void) => () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
    stop = start(
      (v) => {
        clearTimeout(timer);
        stop();
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        stop();
        reject(e);
      },
    );
  });
}

function mediaError(v: HTMLVideoElement): Error {
  const code = v.error?.code;
  const why = code === 4 ? "Chromium can't play this file's format or codec" : code === 3 ? 'the file is damaged or uses a codec Chromium lacks' : code === 2 ? 'the file could not be read' : 'the video could not be opened';
  return new Error(`${why}${v.error?.message ? ` (${v.error.message})` : ''}. Export it as MP4 (H.264 video, AAC sound) and add it again.`);
}

async function openVideo(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  // In the page (not shown: the window never is), so Chromium keeps it decoding like any visible video.
  v.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  v.src = url;
  await wait<void>('Opening the video', 60_000, (ok, fail) => {
    const onMeta = () => ok();
    const onError = () => fail(mediaError(v));
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onError);
    };
  });
  return v;
}

function closeVideo(v: HTMLVideoElement): void {
  v.removeAttribute('src');
  v.load();
  v.remove();
}

async function seek(v: HTMLVideoElement, t: number): Promise<void> {
  await wait<void>(`Seeking to ${t.toFixed(2)} s`, 20_000, (ok, fail) => {
    const onSeeked = () => ok();
    const onError = () => fail(mediaError(v));
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    v.currentTime = t;
    return () => {
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
    };
  });
  // A frame to draw: after a seek it is normally there; give a slow decoder a moment when it isn't.
  if (v.readyState < 2)
    await wait<void>('Waiting for the frame', 10_000, (ok) => {
      const on = () => ok();
      v.addEventListener('loadeddata', on);
      v.addEventListener('canplay', on);
      return () => {
        v.removeEventListener('loadeddata', on);
        v.removeEventListener('canplay', on);
      };
    }).catch(() => undefined);
}

/** The length of a video; files from a MediaRecorder say Infinity until Chromium is sent past their end. */
async function durationOf(v: HTMLVideoElement): Promise<number | null> {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  try {
    await seek(v, 1e7);
  } catch {
    /* some files can't seek that far; the duration may still have arrived */
  }
  const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
  await seek(v, 0).catch(() => undefined);
  return d;
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d', { willReadFrequently: true })! };
}

function scanOf(src: CanvasImageSource, w: number, h: number, t: number): MediaScan {
  const { g } = canvas(w, h);
  g.drawImage(src, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = rgba[i * 4]!;
    rgb[i * 3 + 1] = rgba[i * 4 + 1]!;
    rgb[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return { t, w, h, rgb: b64(rgb) };
}

function fit(w: number, h: number, maxSide: number): [number, number] {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

let pcm: Int16Array | null = null;

/** The sound as mono 16-bit at `rate`, at most `maxSeconds` (Web Audio resamples to its context's rate). */
async function decodeSound(url: string, rate: number, maxSeconds: number): Promise<NonNullable<Extract<MediaPageResult, { op: 'probe' }>['audio']>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reading the file failed (${res.status})`);
  const bytes = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, rate);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error('No sound could be decoded (the clip may have no sound track, or a sound codec Chromium lacks).');
  }
  const n = Math.min(buf.length, Math.round(maxSeconds * rate));
  const out = new Int16Array(n);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of chans) s += ch[i]!;
    s /= chans.length || 1;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  pcm = out;
  return { samples: n, rate, seconds: n / rate, sourceSeconds: buf.duration, channels: buf.numberOfChannels, truncated: buf.length > n };
}

async function probe(req: Extract<MediaPageRequest, { op: 'probe' }>): Promise<MediaPageResult> {
  if (req.kind === 'image') {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = req.url;
    await img.decode().catch(() => {
      throw new Error("The picture couldn't be decoded.");
    });
    const [w, h] = fit(img.naturalWidth, img.naturalHeight, req.preview?.maxSide ?? 1568);
    const { c, g } = canvas(w, h);
    g.drawImage(img, 0, 0, w, h);
    // Transparency is kept (PNG); an opaque picture goes as JPEG, much smaller.
    const alpha = g.getImageData(0, 0, w, h).data;
    let clear = false;
    for (let i = 3; i < alpha.length && !clear; i += 4 * 7) if (alpha[i]! < 250) clear = true;
    const dataUrl = clear ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
    const [tw, th] = fit(img.naturalWidth, img.naturalHeight, 64);
    return { op: 'probe', duration: null, width: img.naturalWidth, height: img.naturalHeight, preview: { dataUrl, width: w, height: h }, thumb: scanOf(img, tw, th, 0) };
  }
  const v = await openVideo(req.url);
  const notes: string[] = [];
  try {
    const duration = await durationOf(v);
    const scan: MediaScan[] = [];
    if (req.scan && duration) {
      const sw = req.scan.width;
      const sh = Math.max(4, Math.min(64, Math.round((sw * (v.videoHeight || 9)) / (v.videoWidth || 16))));
      for (const t of scanTimes(duration, req.scan.maxPoints, req.scan.minStep)) {
        try {
          await seek(v, t);
          scan.push(scanOf(v, sw, sh, t));
        } catch (e) {
          notes.push(`The scan skipped ${t.toFixed(1)} s (${(e as Error).message}).`);
          if (notes.length > 5) break;
        }
      }
    }
    let audio: Extract<MediaPageResult, { op: 'probe' }>['audio'] = null;
    let audioError: string | null = null;
    if (req.audio) {
      try {
        audio = await decodeSound(req.url, req.audio.rate, req.audio.maxSeconds);
      } catch (e) {
        audioError = (e as Error).message;
      }
    }
    return { op: 'probe', duration, width: v.videoWidth, height: v.videoHeight, scan, audio, audioError, notes: notes.slice(0, 3) };
  } finally {
    closeVideo(v);
  }
}

async function frames(req: Extract<MediaPageRequest, { op: 'frames' }>): Promise<MediaPageResult> {
  const v = await openVideo(req.url);
  const out: Array<{ t: number; dataUrl: string; width: number; height: number }> = [];
  const notes: string[] = [];
  try {
    const [w, h] = fit(v.videoWidth || 16, v.videoHeight || 9, req.maxSide);
    const { c, g } = canvas(w, h);
    for (const t of req.times) {
      try {
        await seek(v, t);
        g.drawImage(v, 0, 0, w, h);
        out.push({ t, dataUrl: c.toDataURL('image/jpeg', req.quality), width: w, height: h });
      } catch (e) {
        notes.push(`No frame at ${t.toFixed(2)} s (${(e as Error).message}).`);
      }
    }
  } finally {
    closeVideo(v);
  }
  return { op: 'frames', frames: out, notes: notes.slice(0, 3) };
}

/**
 * The self-test clip: a canvas that cuts between three colours with a square moving across, and a click every
 * half second (120 bpm) with a low thump at the first cut, recorded together. The times are the schedule;
 * the recorder's own start adds a little delay in the file.
 */
async function synthesize(seconds: number, container?: 'mp4' | 'webm'): Promise<MediaPageResult> {
  const { c, g } = canvas(640, 360);
  const stream = c.captureStream(30);
  const ac = new AudioContext({ sampleRate: 48000 });
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].filter((m) => !container || m.includes(container)).find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const cuts = [Math.round(seconds * 0.4 * 10) / 10, Math.round(seconds * 0.75 * 10) / 10];
  const colours = ['#2e8b57', '#1e3a8a', '#c2410c'];
  const started = performance.now();
  const drawNow = () => {
    const t = (performance.now() - started) / 1000;
    g.fillStyle = colours[t < cuts[0]! ? 0 : t < cuts[1]! ? 1 : 2]!;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#ffffff';
    g.fillRect(((t * 220) % 600) + 10, 150, 40, 40);
  };
  drawNow();
  const timer = setInterval(drawNow, 16);
  rec.start(250);
  const t0 = ac.currentTime + 0.05;
  const clicks: number[] = [];
  for (let t = 0.5; t < seconds - 0.2; t += 0.5) {
    const o = ac.createOscillator();
    const gain = ac.createGain();
    o.type = 'square';
    o.frequency.value = 2500;
    gain.gain.setValueAtTime(0.0001, t0 + t);
    gain.gain.exponentialRampToValueAtTime(0.5, t0 + t + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.04);
    o.connect(gain).connect(dest);
    o.start(t0 + t);
    o.stop(t0 + t + 0.05);
    clicks.push(Math.round((t + 0.05) * 1000) / 1000);
  }
  const thump = ac.createOscillator();
  const tg = ac.createGain();
  thump.frequency.value = 60;
  tg.gain.setValueAtTime(0.0001, t0 + cuts[0]!);
  tg.gain.exponentialRampToValueAtTime(0.9, t0 + cuts[0]! + 0.002);
  tg.gain.exponentialRampToValueAtTime(0.0001, t0 + cuts[0]! + 0.5);
  thump.connect(tg).connect(dest);
  thump.start(t0 + cuts[0]!);
  thump.stop(t0 + cuts[0]! + 0.55);
  await new Promise((r) => setTimeout(r, seconds * 1000 + 300));
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  clearInterval(timer);
  await ac.close();
  const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'video/webm' });
  const data = b64(new Uint8Array(await blob.arrayBuffer()));
  return { op: 'synthesize', data, mimeType: blob.type, clicks, cuts };
}

export function installMediaPage(): void {
  window.__media = async (req) => {
    try {
      if (req.op === 'probe') return await probe(req);
      if (req.op === 'frames') return await frames(req);
      return await synthesize(req.seconds, req.container);
    } catch (e) {
      return { error: (e as Error).message || String(e) };
    }
  };
  window.__mediaAudioChunk = (start, count) => (pcm ? b64(new Uint8Array(pcm.buffer, start * 2, Math.max(0, Math.min(count, pcm.length - start)) * 2)) : '');
  window.__mediaAudioDone = () => {
    pcm = null;
  };
}
