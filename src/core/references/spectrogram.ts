import type { AudioEvent } from '@shared/references';
import { encodePng } from '../modeling/png';
import { newRaster, pixelText, toRgba, type Raster } from '../ui/ui-raster';
import { LOG_MIN_HZ, LOG_ROWS, SILENCE_DB, stft as computeStft, type Stft } from './audio-features';

/**
 * Pictures of a clip's sound the study run can look at: one strip per stretch of time (15 s by default), the
 * spectrum on a log-frequency axis (low at the bottom, faint lines at 100 Hz, 1 kHz and 5 kHz), the level
 * below it, onsets as white ticks and the loudest hits as orange marks above it, and a ruler in seconds
 * (a tick a second, the time written every 5). The colours are scaled to the whole clip, so strips compare.
 */

export interface SpectrogramStrip {
  t0: number;
  t1: number;
  width: number;
  height: number;
  png: Buffer;
}

const MARK_H = 10;
const ROW_H = 2;
const SPEC_H = LOG_ROWS * ROW_H;
const LEVEL_H = 36;
const RULER_H = 14;
export const STRIP_HEIGHT = MARK_H + SPEC_H + LEVEL_H + RULER_H;
/** The dB span the colours cover, under the clip's loud end. */
const SPAN_DB = 70;

/** An inferno-like ramp: black, purple, red, orange, pale yellow. */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [0, 0, 0.016]],
  [0.25, [0.259, 0.039, 0.408]],
  [0.5, [0.576, 0.149, 0.404]],
  [0.75, [0.867, 0.318, 0.227]],
  [0.9, [0.988, 0.647, 0.039]],
  [1, [0.988, 1, 0.643]],
];

function ramp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  for (let i = 1; i < RAMP.length; i++) {
    const [b, cb] = RAMP[i]!;
    const [a, ca] = RAMP[i - 1]!;
    if (x <= b) {
      const f = (x - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
    }
  }
  return RAMP[RAMP.length - 1]![1];
}

function put(c: Raster, x: number, y: number, rgb: [number, number, number]): void {
  if (x >= 0 && y >= 0 && x < c.w && y < c.h) c.rgb.set(rgb, (y * c.w + x) * 3);
}

/** The y of a frequency inside the spectrum band (row 0 at the bottom). */
function rowY(hz: number, rate: number): number {
  const r = (Math.log(hz / LOG_MIN_HZ) / Math.log(rate / 2 / LOG_MIN_HZ)) * LOG_ROWS;
  return MARK_H + SPEC_H - 1 - Math.round(r * ROW_H);
}

export interface StripOptions {
  /** Seconds per strip. */
  stripSeconds?: number;
  /** At most this many strips (from the start); the rest of the clip is not drawn. */
  maxStrips?: number;
  events?: AudioEvent[];
  onsets?: Array<{ t: number }>;
  /** A spectrum already computed for this signal. */
  stft?: Stft;
}

export function spectrogramStrips(x: Float32Array, rate: number, opts: StripOptions = {}): SpectrogramStrip[] {
  const s = opts.stft ?? computeStft(x, rate);
  const stripSeconds = opts.stripSeconds ?? 15;
  const seconds = x.length / rate;
  const fr = rate / s.hop;
  // The clip's loud end: nearly the loudest cell, so one click doesn't darken everything.
  const sample: number[] = [];
  const every = Math.max(1, Math.floor(s.logDb.length / 200_000));
  for (let i = 0; i < s.logDb.length; i += every) sample.push(s.logDb[i]!);
  sample.sort((a, b) => a - b);
  const top = sample.length ? sample[Math.floor(0.995 * (sample.length - 1))]! : 0;
  const floor = top - SPAN_DB;
  const out: SpectrogramStrip[] = [];
  const count = Math.min(opts.maxStrips ?? 60, Math.max(1, Math.ceil(seconds / stripSeconds - 1e-9)));
  for (let n = 0; n < count; n++) {
    const t0 = n * stripSeconds;
    const t1 = Math.min(seconds, t0 + stripSeconds);
    if (t1 <= t0) break;
    const k0 = Math.floor(t0 * fr);
    const k1 = Math.min(s.frames, Math.max(k0 + 1, Math.ceil(t1 * fr)));
    const w = k1 - k0;
    const c = newRaster(w, STRIP_HEIGHT, [0.07, 0.07, 0.08]);
    for (let col = 0; col < w; col++) {
      const k = k0 + col;
      for (let r = 0; r < LOG_ROWS; r++) {
        const rgb = ramp((s.logDb[k * LOG_ROWS + r]! - floor) / SPAN_DB);
        for (let dy = 0; dy < ROW_H; dy++) put(c, col, MARK_H + SPEC_H - 1 - (r * ROW_H + dy), rgb);
      }
      // The level lane: RMS from -60 to 0 dBFS, filled from the bottom.
      const db = s.rms[k]! > 1e-9 ? 20 * Math.log10(s.rms[k]!) : -120;
      const hgt = Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * (LEVEL_H - 2));
      for (let y = 0; y < hgt; y++) put(c, col, MARK_H + SPEC_H + LEVEL_H - 1 - y, [0.62, 0.64, 0.7]);
    }
    // The silence line in the level lane.
    const sy = MARK_H + SPEC_H + LEVEL_H - 1 - Math.round(((SILENCE_DB + 60) / 60) * (LEVEL_H - 2));
    for (let col = 0; col < w; col += 3) put(c, col, sy, [0.55, 0.25, 0.25]);
    // Faint guides at 100 Hz, 1 kHz and 5 kHz, written in Hz at the left.
    for (const hz of [100, 1000, 5000]) {
      if (hz >= rate / 2) continue;
      const y = rowY(hz, rate);
      for (let col = 0; col < w; col += 4) put(c, col, y, [0.85, 0.85, 0.9]);
      pixelText(c, String(hz), 2, y - 6, [0.92, 0.92, 0.96]);
    }
    // Onsets: a white tick; the loudest hits: an orange mark.
    for (const o of opts.onsets ?? []) {
      if (o.t < t0 || o.t >= t1) continue;
      const col = Math.round((o.t - t0) * fr);
      for (let y = 5; y < MARK_H; y++) put(c, col, y, [0.95, 0.95, 0.95]);
    }
    for (const e of opts.events ?? []) {
      if (e.t < t0 || e.t >= t1) continue;
      const col = Math.round((e.t - t0) * fr);
      for (let y = 0; y < 5; y++) for (let dx = -(4 - y); dx <= 4 - y; dx++) put(c, col + dx, y, [1, 0.55, 0.1]);
    }
    // The ruler: a tick every second, a long one and the time every 5 s.
    const ry = MARK_H + SPEC_H + LEVEL_H;
    for (let sec = Math.ceil(t0); sec <= t1; sec++) {
      const col = Math.round((sec - t0) * fr);
      const long = sec % 5 === 0;
      for (let y = 0; y < (long ? 6 : 3); y++) put(c, col, ry + y, [0.8, 0.8, 0.85]);
      if (long) pixelText(c, String(sec), col + 2, ry + 6, [0.9, 0.9, 0.95], 1);
    }
    out.push({ t0: Math.round(t0 * 100) / 100, t1: Math.round(t1 * 100) / 100, width: w, height: STRIP_HEIGHT, png: encodePng(toRgba(c)) });
  }
  return out;
}

/** The strips worth showing the study run: the one with the most loud hits first, then spread over the clip, in time order. */
export function pickStrips<T extends { t0: number; t1: number }>(strips: T[], events: Array<{ t: number }>, max: number): T[] {
  if (strips.length <= max) return strips;
  const hits = (s: T) => events.filter((e) => e.t >= s.t0 && e.t < s.t1).length;
  const chosen = new Set<T>();
  const busiest = [...strips].sort((a, b) => hits(b) - hits(a) || a.t0 - b.t0);
  // Half by where the hits are, half spread evenly so quiet stretches are seen too.
  for (const s of busiest.slice(0, Math.ceil(max / 2))) if (hits(s) > 0) chosen.add(s);
  for (let i = 0; chosen.size < max && i < max * 4; i++) {
    const idx = Math.round((i * (strips.length - 1)) / Math.max(1, max - 1)) % strips.length;
    chosen.add(strips[idx]!);
  }
  for (const s of strips) if (chosen.size < max) chosen.add(s);
  return strips.filter((s) => chosen.has(s));
}
