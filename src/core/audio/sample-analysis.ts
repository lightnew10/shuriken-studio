/**
 * What a sample is, measured: the cleanup every sample gets before the composer may use it (silence trimmed,
 * DC removed, the peak normalised, mono when its channels are the same) and what the composer needs to know
 * to play it (its pitch for a melodic one-shot, its tempo and length in beats for a loop, its key when the
 * file name says one, and a guess at its kind and role). Plain functions on 44.1 kHz float PCM.
 */
import { SAMPLE_RATE, dbToLin } from './dsp/util';
import { Biquad } from './dsp/filter';
import { fft } from './dsp/fft';
import { measureLoudness } from './dsp/master';
import { midiOf } from './music';

const SR = SAMPLE_RATE;

export const SAMPLE_KINDS = ['oneshot', 'loop', 'texture'] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

/** What a sample is for in a track (the composer's instruments map onto these). */
export const SAMPLE_ROLES = ['kick', 'snare', 'clap', 'hat', 'openhat', 'cymbal', 'cowbell', 'perc', 'tom', '808', 'bass', 'keys', 'pad', 'lead', 'pluck', 'bell', 'strings', 'vocal', 'fx', 'texture', 'drums', 'other'] as const;
export type SampleRole = (typeof SAMPLE_ROLES)[number];

/** Roles that are drum hits: played at their own pitch unless a track says otherwise. */
export const DRUM_ROLES = new Set<string>(['kick', 'snare', 'clap', 'hat', 'openhat', 'cymbal', 'perc', 'tom', 'drums', 'fx']);

// In order: a drum named with its machine ("808 cowbell", "808 clap") is that drum; "808" alone is the bass.
const WORDS: Array<[SampleRole, RegExp]> = [
  ['cowbell', /cow\s*bell/i],
  ['openhat', /open\s*-?\s*hi?\s*-?\s*hat|\bohh?\b|\boh\b/i],
  ['hat', /hi\s*-?\s*hat|\bhats?\b|\bchh?\b/i],
  ['clap', /\bclaps?\b|snap/i],
  ['snare', /snare|\brim\s*shot|\brim\b/i],
  ['kick', /\bkicks?\b|bass\s*drum|\bbd\b/i],
  ['cymbal', /cymbal|crash|\bride\b|splash/i],
  ['tom', /\btoms?\b/i],
  ['808', /\b808s?\b|\bsub\s*bass\b/i],
  ['vocal', /vocal|vox|voice|chop|choir|sing|acapella|\bahh?\b|\booh\b/i],
  ['keys', /rhodes|piano|keys|e-?piano|wurli|organ/i],
  ['pad', /\bpads?\b|drone|swell/i],
  ['bell', /\bbells?\b|chime|glock|celesta|music\s*box/i],
  ['strings', /string|violin|cello|viola|orchestra/i],
  ['pluck', /pluck|guitar|harp|koto|pizz/i],
  ['lead', /\blead\b|synth\s*lead|melody/i],
  ['bass', /\bbass\b/i],
  ['texture', /vinyl|crackle|tape|hiss|rain|noise|ambien|atmos|room\s*tone|field|wind|static/i],
  ['perc', /perc|shaker|tamb|conga|bongo|clave|block|triangle|guiro/i],
  ['fx', /riser|impact|sweep|whoosh|\bfx\b|uplifter|downlifter|reverse/i],
  ['drums', /drum\s*loop|break\s*beat|\bbreaks?\b|\bbeat\b|drums/i],
];

/** A role from a sample's name and tags. */
export function guessRole(words: string): SampleRole {
  for (const [role, rx] of WORDS) if (rx.test(words)) return role;
  return 'other';
}

/** A kind from the name and the length: loops say so, textures are long beds, the rest are one-shots. */
export function guessKind(words: string, seconds: number, role: string): SampleKind {
  if (/\bloops?\b|\bbpm\b|\d\s*bpm/i.test(words)) return 'loop';
  if (role === 'texture' || (seconds > 8 && !/one\s*-?\s*shot|hit\b/i.test(words))) return 'texture';
  return 'oneshot';
}

/** The tempo a file name states ("85BPM", "bpm 140", "_128_bpm"). */
export function bpmFromName(words: string): number | null {
  const m = /(\d{2,3}(?:\.\d+)?)\s*-?_?\s*bpm|bpm\s*-?_?\s*(\d{2,3}(?:\.\d+)?)/i.exec(words);
  const v = m ? Number(m[1] ?? m[2]) : NaN;
  return v >= 50 && v <= 220 ? v : null;
}

/** The key a file name states ("[C#Minor]", "Am", "F# min", "in D major"), as a tonic MIDI note (octave 4) and a mode. */
export function keyFromName(words: string): { tonic: number; minor: boolean; name: string } | null {
  const m = /(?:^|[^A-Za-z])([A-G])(#|b|♯|♭|\s?sharp|\s?flat)?\s?-?(minor|major|min|maj|m)(?![a-z])/i.exec(words) ?? /(?:^|[^A-Za-z])([A-G])(#|b|♯|♭)?(m)(?=[^A-Za-z]|$)/.exec(words);
  if (!m) return null;
  const letter = m[1]!.toUpperCase();
  const acc = /#|♯|sharp/i.test(m[2] ?? '') ? '#' : /b|♭|flat/i.test(m[2] ?? '') ? 'b' : '';
  const mode = m[3]!;
  const minor = /^m(in(or)?)?$/i.test(mode) && mode !== 'M';
  return { tonic: midiOf(`${letter}${acc}4`), minor, name: `${letter}${acc} ${minor ? 'minor' : 'major'}` };
}

// ─── cleanup ────────────────────────────────────────────────────────────────

/** Mono when the channels carry the same signal (the side is 30 dB under the mid), else the two channels. */
export function foldChannels(chs: Float32Array[]): Float32Array[] {
  if (chs.length < 2) return [chs[0]!];
  const [L, R] = [chs[0]!, chs[1]!];
  let mid = 0;
  let side = 0;
  for (let i = 0; i < L.length; i++) {
    mid += (L[i]! + R[i]!) ** 2;
    side += (L[i]! - R[i]!) ** 2;
  }
  if (side <= mid * 1e-3) return [Float32Array.from(L, (v, i) => (v + R[i]!) * 0.5)];
  return [L, R];
}

/** Removes DC with a gentle 15 Hz high-pass (two poles), in place. */
export function removeDcOffset(chs: Float32Array[]): void {
  for (const ch of chs) Biquad.highpass(15, 0.707).processBuffer(ch);
}

/**
 * Cuts the silence before and after the sound: the start goes to 1.5 ms before the first sample 50 dB under
 * the peak, the end to 15 ms after the last sample 60 dB under it, with a 0.5 ms fade in (when anything was cut)
 * and a 6 ms fade out. Returns the new channels and the seconds cut from the front.
 */
export function trimSilence(chs: Float32Array[], o: { startDb?: number; endDb?: number } = {}): { channels: Float32Array[]; cutStart: number } {
  const n = chs[0]!.length;
  let peak = 0;
  for (const ch of chs) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  if (peak === 0) return { channels: chs.map((c) => c.slice()), cutStart: 0 };
  const startTh = peak * dbToLin(o.startDb ?? -50);
  const endTh = peak * dbToLin(o.endDb ?? -60);
  const loud = (i: number, th: number) => chs.some((ch) => Math.abs(ch[i]!) > th);
  let a = 0;
  while (a < n && !loud(a, startTh)) a++;
  let b = n - 1;
  while (b > a && !loud(b, endTh)) b--;
  a = Math.max(0, a - Math.round(0.0015 * SR));
  b = Math.min(n, b + Math.round(0.015 * SR));
  const out = chs.map((ch) => ch.slice(a, b));
  const fadeIn = a > 0 ? Math.round(0.0005 * SR) : 0;
  const fadeOut = Math.min(Math.round(0.006 * SR), out[0]!.length >> 2);
  for (const ch of out) {
    for (let i = 0; i < fadeIn && i < ch.length; i++) ch[i]! *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) ch[ch.length - 1 - i]! *= i / fadeOut;
  }
  return { channels: out, cutStart: a / SR };
}

/** Scales to a peak of `db` dBFS, in place; returns the gain. */
export function normalizePeak(chs: Float32Array[], db = -1): number {
  let peak = 0;
  for (const ch of chs) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  if (!peak) return 1;
  const g = dbToLin(db) / peak;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i]! *= g;
  return g;
}

// ─── pitch ──────────────────────────────────────────────────────────────────

/**
 * The pitch of the steady part of a sound by YIN (de Cheveigné and Kawahara 2002): the difference function,
 * normalised by its running mean, the first dip under 0.15 (else the deepest), refined by a parabola. Frames at
 * 30, 90 and 180 ms after the start; the median of the clear ones. 30-2000 Hz. Null when nothing is periodic
 * (noise, most drums) or the sound is too short. `range` narrows the search to where the role's notes are (a
 * cowbell layered over a sub is heard at the cowbell's pitch, not the sub's).
 */
export function detectPitch(input: Float32Array, rate = SR, range: [number, number] = [30, 2000]): { midi: number; hz: number; confidence: number } | null {
  const W = 1536;
  // Whatever lies under the range (a sub or a kick layered in) is filtered out first.
  let x = input;
  if (range[0] >= 100) {
    x = Float32Array.from(input.subarray(0, Math.min(input.length, Math.round(0.3 * rate))));
    for (let k = 0; k < 2; k++) Biquad.highpass(range[0] * 0.6, 0.707).processBuffer(x);
  }
  const tauMin = Math.floor(rate / range[1]);
  const tauMax = Math.ceil(rate / range[0]);
  const found: Array<{ hz: number; c: number }> = [];
  let frames = 0;
  for (const at of [0.03, 0.09, 0.18]) {
    const s = Math.round(at * rate);
    if (s + W + tauMax > x.length) continue;
    let energy = 0;
    for (let j = 0; j < W; j++) energy += x[s + j]! ** 2;
    if (energy < 1e-6 * W) continue;
    frames++;
    const d = new Float64Array(tauMax + 2);
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const e = x[s + j]! - x[s + j + tau]!;
        sum += e * e;
      }
      d[tau] = sum;
    }
    const cmnd = new Float64Array(tauMax + 2);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau]!;
      cmnd[tau] = running > 0 ? (d[tau]! * tau) / running : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau]! < 0.15) {
        while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let m = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++)
        if (cmnd[tau]! < m) {
          m = cmnd[tau]!;
          best = tau;
        }
    }
    const a = cmnd[best - 1] ?? cmnd[best]!;
    const b = cmnd[best]!;
    const c = cmnd[best + 1] ?? cmnd[best]!;
    const den = a - 2 * b + c;
    const shift = den > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den))) : 0;
    const conf = 1 - b;
    if (conf > 0.7) found.push({ hz: rate / (best + shift), c: conf });
  }
  // A pitch is believed when most of the frames heard one (noise dips once in a while, a tone every time).
  if (!found.length || found.length * 2 < frames) return null;
  found.sort((p, q) => p.hz - q.hz);
  const pick = found[found.length >> 1]!;
  const midi = 69 + 12 * Math.log2(pick.hz / 440);
  return { midi: Math.round(midi * 100) / 100, hz: Math.round(pick.hz * 10) / 10, confidence: Math.round(pick.c * 100) / 100 };
}

/**
 * The pitch of a metallic sound (a cowbell, a bell): the lowest strong partial, not the period. Two partials a
 * fifth apart (a cowbell's 540 and 800 Hz) repeat together an octave under the lower one, which is where YIN
 * would hear it; a producer pitching a cowbell, and the composer's own cowbell voice, go by the lower partial.
 * The lowest spectral peak in the range within 6 dB of the strongest, in the 190 ms after the attack.
 */
export function dominantPartial(input: Float32Array, rate = SR, range: [number, number] = [250, 2000]): { midi: number; hz: number; confidence: number } | null {
  const N = 8192;
  const start = Math.min(Math.round(0.01 * rate), Math.max(0, input.length - 256));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (input[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
  const lo = Math.max(2, Math.floor((range[0] * N) / rate));
  const hi = Math.min(N / 2 - 2, Math.ceil((range[1] * N) / rate));
  const peaks: number[] = [];
  for (let k = lo; k <= hi; k++) if (mag[k]! > mag[k - 1]! && mag[k]! >= mag[k + 1]!) peaks.push(k);
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map((k) => mag[k]!));
  let total = 0;
  for (let k = lo; k <= hi; k++) total += mag[k]!;
  // A clear partial stands well out of the band (three times its mean); noise doesn't.
  if (top < (3 * total) / (hi - lo + 1)) return null;
  const k = peaks.find((p) => mag[p]! >= top * 0.5)!;
  const a = Math.log(mag[k - 1]! + 1e-12);
  const b = Math.log(mag[k]! + 1e-12);
  const c = Math.log(mag[k + 1]! + 1e-12);
  const shift = a - 2 * b + c < 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const hz = ((k + shift) * rate) / N;
  return { midi: Math.round((69 + 12 * Math.log2(hz / 440)) * 100) / 100, hz: Math.round(hz * 10) / 10, confidence: 0.9 };
}

/** Where a role's notes are (Hz), for the pitch search. */
export function pitchRange(role: string): [number, number] {
  if (role === 'cowbell' || role === 'bell') return [250, 2000];
  if (role === '808' || role === 'bass' || role === 'kick' || role === 'tom') return [25, 300];
  if (role === 'keys' || role === 'pad' || role === 'strings' || role === 'pluck' || role === 'lead' || role === 'vocal') return [50, 1500];
  return [30, 2000];
}

/** Where the energy is: shares (%) under 150 Hz, 150-1000, 1-5 kHz and above, and the spectral centroid. */
export function spectrumSummary(x: Float32Array, rate = SR): { sub: number; low: number; mid: number; high: number; centroidHz: number } {
  const N = 4096;
  const bands = [0, 0, 0, 0];
  let wsum = 0;
  let total = 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let s = 0; s + N <= Math.max(N, x.length); s += N) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = (x[s + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const f = (k * rate) / N;
      bands[f < 150 ? 0 : f < 1000 ? 1 : f < 5000 ? 2 : 3]! += p;
      wsum += p * f;
      total += p;
    }
    if (s > 30 * rate) break;
  }
  const pct = (v: number) => Math.round((100 * v) / (total || 1));
  return { sub: pct(bands[0]!), low: pct(bands[1]!), mid: pct(bands[2]!), high: pct(bands[3]!), centroidHz: Math.round(wsum / (total || 1)) };
}

// ─── tempo ──────────────────────────────────────────────────────────────────

/** Onset strength every 10 ms: the rise of the high-passed energy (log), half-wave rectified. */
function onsets(x: Float32Array, rate: number): Float64Array {
  const hop = Math.round(rate * 0.01);
  const hp = Float32Array.from(x);
  Biquad.highpass(150, 0.707).processBuffer(hp);
  const frames = Math.floor(hp.length / hop);
  const e = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    let s = 0;
    for (let j = 0; j < hop; j++) s += hp[k * hop + j]! ** 2;
    e[k] = Math.log10(1e-9 + s);
  }
  const flux = new Float64Array(frames);
  for (let k = 1; k < frames; k++) flux[k] = Math.max(0, e[k]! - e[k - 1]!);
  return flux;
}

/**
 * A loop's tempo and length in beats. A tempo in the name wins (its beat count is rounded to the loop's
 * length); else the onsets' self-similarity picks the beat count whose beat (and half bar) repeats best, at
 * 60-200 bpm, so the loop always covers a whole number of beats.
 */
export function detectTempo(x: Float32Array, rate = SR, words = ''): { bpm: number; beats: number; from: 'name' | 'audio' } {
  const seconds = x.length / rate;
  const named = bpmFromName(words);
  if (named) {
    const beats = Math.max(1, Math.round((seconds * named) / 60));
    return { bpm: Math.round(((60 * beats) / seconds) * 100) / 100, beats, from: 'name' };
  }
  const flux = onsets(x, rate);
  const ac = (lagFrames: number): number => {
    const L = Math.round(lagFrames);
    if (L <= 0 || L >= flux.length) return 0;
    let s = 0;
    let n = 0;
    for (let k = 0; k + L < flux.length; k++) {
      s += flux[k]! * flux[k + L]!;
      n++;
    }
    return n ? s / n : 0;
  };
  let best = { beats: 4, score: -Infinity };
  for (const beats of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
    const bpm = (60 * beats) / seconds;
    if (bpm < 60 || bpm > 200) continue;
    const beatFrames = (seconds / beats) * 100;
    // The beat, the half bar and the half beat repeating, with a slight preference for tempos near 115.
    const score = (ac(beatFrames) + 0.5 * ac(beatFrames * 2) + 0.25 * ac(beatFrames / 2)) * (1 - 0.15 * Math.abs(Math.log2(bpm / 115)));
    if (score > best.score) best = { beats, score };
  }
  return { bpm: Math.round(((60 * best.beats) / seconds) * 100) / 100, beats: best.beats, from: 'audio' };
}

// ─── loudness ───────────────────────────────────────────────────────────────

/** What the composer matches a sample's level by: the loudest 400 ms for a one-shot, the integrated loudness for a bed. */
export function sampleLoudness(chs: Float32Array[], kind: SampleKind): number {
  const m = measureLoudness(chs);
  const v = kind === 'oneshot' ? m.momentaryMax : (m.integrated ?? m.momentaryMax);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : -70;
}
