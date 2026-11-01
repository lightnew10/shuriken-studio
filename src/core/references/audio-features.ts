import type { AudioEvent, AudioSummary } from '@shared/references';
import { fft } from '../audio/dsp/fft';
import { measureLoudness } from '../audio/dsp/master';

/**
 * Listening to a reference clip with numbers. The model that writes the study can't hear, so the core measures
 * the sound from its PCM: how loud it is and how that moves, where the hits are (spectral flux onsets, placed
 * to a couple of milliseconds in the waveform), whether there is a steady beat and how fast, where the energy
 * sits (bass, mid, high) over time, how much of it is silence, and the loudest moments with their character.
 * Speech is not transcribed: nothing here knows what is said.
 */

/** Below this a 100 ms stretch counts as silence (dBFS RMS). Game mixes sit around -30 to -12. */
export const SILENCE_DB = -50;
/** Bass is under this, high above HIGH_HZ, mid between (Hz). */
export const BASS_HZ = 250;
export const HIGH_HZ = 4000;
/** Rows of the log-frequency picture (spectrogram), from LOG_MIN_HZ to the top of the band. */
export const LOG_ROWS = 96;
export const LOG_MIN_HZ = 30;

export interface Stft {
  rate: number;
  win: number;
  hop: number;
  frames: number;
  /** Per frame: spectral flux (log magnitude rise), RMS (linear), bass/mid/high power, centroid (Hz). */
  flux: Float32Array;
  rms: Float32Array;
  bass: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  centroid: Float32Array;
  /** LOG_ROWS dB values per frame, frame after frame (lowest frequency first). */
  logDb: Float32Array;
  /** The frequency at the bottom edge of each row (LOG_ROWS + 1 edges). */
  rowEdges: Float64Array;
}

export interface AudioAnalysis extends AudioSummary {
  rate: number;
  /** RMS level per 100 ms (dBFS). */
  envelope: { step: number; db: number[] };
  /** Every onset found (s) with its strength (0..1 of the strong ones). */
  onsetList: Array<{ t: number; strength: number }>;
  /** Energy shares and brightness per section. */
  sections: { step: number; rows: Array<{ t: number; db: number; bass: number; mid: number; high: number; centroidHz: number }> };
  momentaryMaxLufs: number | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const dbOf = (lin: number) => (lin > 1e-9 ? 20 * Math.log10(lin) : -180);

/** Mono 16-bit little-endian PCM (what the media page writes) as floats. */
export function pcmFromInt16(buf: Uint8Array): Float32Array {
  const n = Math.floor(buf.byteLength / 2);
  const view = new DataView(buf.buffer, buf.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Floats as mono 16-bit little-endian PCM (tests and the fake decoder write it this way). */
export function int16FromPcm(x: Float32Array): Buffer {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), i * 2);
  return out;
}

/** The short-time spectrum the other measurements and the spectrogram are read from (Hann window of ~46 ms, half overlap). */
export function stft(x: Float32Array, rate: number): Stft {
  let win = 256;
  while (win < rate * 0.046) win <<= 1;
  const hop = win / 2;
  const frames = Math.max(1, Math.ceil(Math.max(0, x.length - win) / hop) + 1);
  const half = win / 2;
  const hann = new Float64Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  // A full-scale sine reads about 1 in magnitude (Hann's coherent gain is a half).
  const scale = 4 / win;
  const binHz = rate / win;
  const bassBin = Math.ceil(BASS_HZ / binHz);
  const highBin = Math.ceil(HIGH_HZ / binHz);
  const minBin = Math.max(1, Math.round(40 / binHz));
  const nyq = rate / 2;
  const rowEdges = new Float64Array(LOG_ROWS + 1);
  for (let r = 0; r <= LOG_ROWS; r++) rowEdges[r] = LOG_MIN_HZ * Math.pow(nyq / LOG_MIN_HZ, r / LOG_ROWS);
  const rowBins: Array<[number, number]> = [];
  for (let r = 0; r < LOG_ROWS; r++) {
    const a = Math.max(1, Math.floor(rowEdges[r]! / binHz));
    const b = Math.max(a, Math.min(half, Math.ceil(rowEdges[r + 1]! / binHz)));
    rowBins.push([a, b]);
  }
  const out: Stft = {
    rate,
    win,
    hop,
    frames,
    flux: new Float32Array(frames),
    rms: new Float32Array(frames),
    bass: new Float32Array(frames),
    mid: new Float32Array(frames),
    high: new Float32Array(frames),
    centroid: new Float32Array(frames),
    logDb: new Float32Array(frames * LOG_ROWS),
    rowEdges,
  };
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  const mag = new Float64Array(half + 1);
  let prev = new Float64Array(half + 1);
  let cur = new Float64Array(half + 1);
  for (let k = 0; k < frames; k++) {
    const s = k * hop;
    let sq = 0;
    for (let i = 0; i < win; i++) {
      const v = x[s + i] ?? 0;
      sq += v * v;
      re[i] = v * hann[i]!;
      im[i] = 0;
    }
    out.rms[k] = Math.sqrt(sq / win);
    fft(re, im);
    let pb = 0, pm = 0, ph = 0, num = 0, den = 0, flux = 0;
    for (let b = 0; b <= half; b++) {
      const p = (re[b]! * re[b]! + im[b]! * im[b]!) * scale * scale;
      mag[b] = Math.sqrt(p);
      cur[b] = Math.log10(1 + 1000 * mag[b]!);
      if (b > 0) flux += Math.max(0, cur[b]! - prev[b]!);
      if (b < bassBin) pb += p;
      else if (b < highBin) pm += p;
      else ph += p;
      if (b >= minBin) {
        num += b * binHz * p;
        den += p;
      }
    }
    out.flux[k] = k === 0 ? 0 : flux;
    out.bass[k] = pb;
    out.mid[k] = pm;
    out.high[k] = ph;
    out.centroid[k] = den > 0 ? num / den : 0;
    for (let r = 0; r < LOG_ROWS; r++) {
      const [a, b] = rowBins[r]!;
      let m = 0;
      for (let i = a; i <= b; i++) if (mag[i]! > m) m = mag[i]!;
      out.logDb[k * LOG_ROWS + r] = dbOf(m);
    }
    [prev, cur] = [cur, prev];
  }
  return out;
}

function percentile(values: ArrayLike<number>, q: number): number {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]!;
}

/** RMS level per block of `step` seconds (dBFS). */
export function levelEnvelope(x: Float32Array, rate: number, step = 0.1): number[] {
  const n = Math.max(1, Math.round(step * rate));
  const out: number[] = [];
  for (let s = 0; s < x.length; s += n) {
    let sq = 0;
    const e = Math.min(x.length, s + n);
    for (let i = s; i < e; i++) sq += x[i]! * x[i]!;
    out.push(r1(Math.max(-120, dbOf(Math.sqrt(sq / Math.max(1, e - s))))));
  }
  return out;
}

/** Share of the 100 ms stretches under SILENCE_DB. */
export function silenceRatio(envelopeDb: number[]): number {
  if (!envelopeDb.length) return 1;
  return r3(envelopeDb.filter((d) => d < SILENCE_DB).length / envelopeDb.length);
}

/**
 * Onsets: peaks of the spectral flux that stand out from their surroundings, in stretches that aren't silent,
 * then placed in the waveform itself (the first 1.5 ms block of the rise), which is what makes them good to a
 * couple of milliseconds although the spectrum moves in 23 ms steps.
 */
export function detectOnsets(x: Float32Array, s: Stft): Array<{ t: number; strength: number }> {
  const { flux, hop, win, rate, frames } = s;
  let top = 0;
  for (let k = 0; k < frames; k++) if (flux[k]! > top) top = flux[k]!;
  const norm = Math.max(percentile(flux, 0.99), 0.25 * top, 1e-9);
  const f = Float32Array.from(flux, (v) => v / norm);
  const gate = Math.pow(10, (SILENCE_DB - 5) / 20);
  const picked: Array<{ k: number; strength: number }> = [];
  for (let k = 1; k < frames; k++) {
    const v = f[k]!;
    if (v < 0.1) continue;
    let isMax = true;
    for (let j = Math.max(0, k - 3); j <= Math.min(frames - 1, k + 3); j++) if (f[j]! > v || (f[j]! === v && j < k)) isMax = false;
    if (!isMax) continue;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, k - 8); j <= Math.min(frames - 1, k + 8); j++) {
      sum += f[j]!;
      n++;
    }
    if (v < sum / n + 0.08) continue;
    if (Math.max(s.rms[k]!, s.rms[Math.min(frames - 1, k + 1)]!) < gate) continue;
    picked.push({ k, strength: Math.min(1, v) });
  }
  const out: Array<{ t: number; strength: number }> = [];
  const block = Math.max(8, Math.round(rate * 0.0015));
  let floor = 0;
  for (const p of picked) {
    const from = Math.max(floor, p.k * hop - hop);
    const to = Math.min(x.length, p.k * hop + win);
    if (to - from < block * 2) continue;
    const nb = Math.floor((to - from) / block);
    const e = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      let sq = 0;
      for (let i = from + b * block; i < from + (b + 1) * block; i++) sq += x[i]! * x[i]!;
      e[b] = sq;
    }
    let bmax = 0;
    for (let b = 1; b < nb; b++) if (e[b]! > e[bmax]!) bmax = b;
    // The background is what the stretch holds before the rise (its quietest quarter).
    const bg = percentile(e.subarray(0, Math.max(1, bmax)), 0.25);
    const thr = bg + 0.1 * (e[bmax]! - bg);
    let b0 = bmax;
    while (b0 > 0 && e[b0 - 1]! > thr) b0--;
    const t = (from + b0 * block) / rate;
    if (out.length && t - out[out.length - 1]!.t < 0.04) continue;
    out.push({ t: r3(t), strength: r2(p.strength) });
    floor = from + (bmax + 1) * block;
  }
  return out;
}

/**
 * A tempo estimate from the onsets' rhythm: the autocorrelation of the flux (local mean taken away, lightly
 * smoothed) over beat lengths of 60-200 bpm, the beat and its double together, leaning toward 120 bpm, refined
 * between frames. Confidence is the normalized autocorrelation at the beat (a click track reads near 1, noise
 * under 0.15: then there is no beat to speak of and the answer is null).
 */
export function estimateTempo(s: Stft): { bpm: number; confidence: number } | null {
  const fr = s.rate / s.hop;
  const n = s.frames;
  if (n < fr * 4) return null;
  const odf = new Float64Array(n);
  const w = Math.round(fr * 0.5);
  let acc = 0;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + s.flux[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    odf[i] = Math.max(0, s.flux[i]! - (prefix[b]! - prefix[a]!) / (b - a));
  }
  // Light smoothing makes the peak round, so the refinement between frames means something.
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = 0.25 * (odf[i - 1] ?? 0) + 0.5 * odf[i]! + 0.25 * (odf[i + 1] ?? 0);
  // Correlation, not raw products: without the mean taken away, steady noise correlates with itself at every lag.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sm[i]!;
  mean /= n;
  for (let i = 0; i < n; i++) sm[i] = sm[i]! - mean;
  const minLag = Math.floor((fr * 60) / 200);
  const maxLag = Math.ceil((fr * 60) / 60);
  const acTo = Math.min(n - 1, 4 * maxLag + 3);
  const ac = new Float64Array(acTo + 1);
  for (let l = 0; l <= acTo; l++) {
    acc = 0;
    for (let i = 0; i + l < n; i++) acc += sm[i]! * sm[i + l]!;
    ac[l] = acc / (n - l);
  }
  if (!(ac[0]! > 0)) return null;
  // A beat that isn't a whole number of frames splits its peak over two lags: look at the best of the three around.
  const pk = (l: number) => {
    const c = Math.round(l);
    return Math.max(ac[c - 1] ?? 0, ac[c] ?? 0, ac[c + 1] ?? 0);
  };
  const score = (l: number) => {
    const bpm = (60 * fr) / l;
    const lean = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.2, 2));
    return (pk(l) + 0.5 * pk(2 * l)) * lean;
  };
  let best = minLag;
  for (let l = minLag; l <= maxLag; l++) if (score(l) > score(best)) best = l;
  const confidence = Math.max(0, Math.min(1, pk(best) / ac[0]!));
  if (confidence < 0.15) return null;
  // The beat's length, read where it is sharpest: the peak at four (or three, two) beats, divided back.
  let lag = best;
  for (const m of [4, 3, 2, 1]) {
    const c = Math.round(best * m);
    if (c + 3 > Math.min(acTo, n / 2) && m > 1) continue;
    let p = c;
    for (let l = c - 2; l <= c + 2; l++) if ((ac[l] ?? -Infinity) > (ac[p] ?? -Infinity)) p = l;
    const y0 = ac[p - 1] ?? 0;
    const y1 = ac[p] ?? 0;
    const y2 = ac[p + 1] ?? 0;
    const d = y0 - 2 * y1 + y2;
    const off = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;
    lag = (p + off) / m;
    break;
  }
  return { bpm: r1((60 * fr) / lag), confidence: r2(confidence) };
}

/** The loudest moments: onsets ranked by how loud they peak and how far they jump (up to 30 dB counts), at most `max`, in time order. */
export function loudEvents(x: Float32Array, s: Stft, onsets: Array<{ t: number; strength: number }>, max = 24): AudioEvent[] {
  const rate = s.rate;
  const w10 = Math.max(1, Math.round(rate * 0.01));
  const rmsAt = (from: number, to: number) => {
    const a = Math.max(0, Math.round(from * rate));
    const b = Math.min(x.length, Math.round(to * rate));
    if (b <= a) return -180;
    let sq = 0;
    for (let i = a; i < b; i++) sq += x[i]! * x[i]!;
    return dbOf(Math.sqrt(sq / (b - a)));
  };
  const cands: Array<AudioEvent & { score: number }> = [];
  for (const o of onsets) {
    let peak = -180;
    let peakAt = o.t;
    for (let t = o.t; t < o.t + 0.08; t += 0.005) {
      const v = rmsAt(t, t + w10 / rate);
      if (v > peak) {
        peak = v;
        peakAt = t;
      }
    }
    if (peak < SILENCE_DB) continue;
    const before = rmsAt(o.t - 0.2, o.t - 0.02);
    let decay = 2000;
    for (let t = peakAt; t < peakAt + 2; t += 0.01)
      if (rmsAt(t, t + 0.01) < peak - 12) {
        decay = Math.round((t - o.t) * 1000);
        break;
      }
    const k0 = Math.min(s.frames - 1, Math.max(0, Math.floor((o.t * rate) / s.hop)));
    let pb = 0, pm = 0, ph = 0, num = 0, den = 0;
    for (let k = k0; k < Math.min(s.frames, k0 + 3); k++) {
      pb += s.bass[k]!;
      pm += s.mid[k]!;
      ph += s.high[k]!;
      const e = s.bass[k]! + s.mid[k]! + s.high[k]!;
      num += s.centroid[k]! * e;
      den += e;
    }
    const tot = pb + pm + ph || 1;
    const centroidHz = den > 0 ? num / den : 0;
    const character: AudioEvent['character'] = pb / tot > 0.5 || centroidHz < 400 ? 'low' : ph / tot > 0.3 || centroidHz > 3000 ? 'bright' : 'mid';
    const rise = Math.max(0, peak - Math.max(before, -90));
    // A jump out of digital silence reads as 70 dB or more; past 30 dB a jump says nothing more about loudness.
    cands.push({ t: o.t, peakDb: r1(peak), riseDb: r1(rise), decayMs: decay, character, centroidHz: Math.round(centroidHz), score: peak + 0.6 * Math.min(rise, 30) });
  }
  cands.sort((a, b) => b.score - a.score);
  const kept: typeof cands = [];
  for (const c of cands) {
    if (kept.length >= max) break;
    if (kept.some((k) => Math.abs(k.t - c.t) < 0.15)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.t - b.t).map(({ score: _score, ...e }) => e);
}

/** Everything the study and the page say about a clip's sound, from mono PCM. */
export function analyzeAudio(x: Float32Array, rate: number, opts: { sourceSeconds?: number; truncated?: boolean; maxEvents?: number; stft?: Stft } = {}): AudioAnalysis {
  const seconds = x.length / rate;
  const s = opts.stft ?? stft(x, rate);
  const envelope = levelEnvelope(x, rate, 0.1);
  const onsetList = detectOnsets(x, s);
  const tempo = estimateTempo(s);
  const events = loudEvents(x, s, onsetList, opts.maxEvents ?? 24);
  let peak = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > peak) peak = Math.abs(x[i]!);
  const loud = x.length ? measureLoudness([x], rate) : { integrated: null, momentaryMax: -Infinity };
  // Short-term (3 s) levels a second apart, silence left out: how much the loudness moves.
  const short: number[] = [];
  const span = Math.min(30, envelope.length);
  for (let i = 0; span > 0 && i + span <= envelope.length; i += 10) {
    const part = envelope.slice(i, i + span).map((d) => Math.pow(10, d / 10));
    const db = 10 * Math.log10(part.reduce((a, b) => a + b, 0) / part.length);
    if (db >= SILENCE_DB) short.push(db);
  }
  let tb = 0, tm = 0, th = 0, tn = 0, td = 0;
  for (let k = 0; k < s.frames; k++) {
    tb += s.bass[k]!;
    tm += s.mid[k]!;
    th += s.high[k]!;
    const e = s.bass[k]! + s.mid[k]! + s.high[k]!;
    tn += s.centroid[k]! * e;
    td += e;
  }
  const tot = tb + tm + th || 1;
  const step = Math.max(1, Math.ceil(seconds / 120));
  const per = Math.max(1, Math.round((step * rate) / s.hop));
  const rows: AudioAnalysis['sections']['rows'] = [];
  for (let k0 = 0; k0 < s.frames; k0 += per) {
    let b = 0, m = 0, h = 0, num = 0, den = 0, sq = 0, cnt = 0;
    for (let k = k0; k < Math.min(s.frames, k0 + per); k++) {
      b += s.bass[k]!;
      m += s.mid[k]!;
      h += s.high[k]!;
      const e = s.bass[k]! + s.mid[k]! + s.high[k]!;
      num += s.centroid[k]! * e;
      den += e;
      sq += s.rms[k]! * s.rms[k]!;
      cnt++;
    }
    const t = b + m + h || 1;
    rows.push({ t: r1((k0 * s.hop) / rate), db: r1(Math.max(-120, dbOf(Math.sqrt(sq / Math.max(1, cnt))))), bass: r2(b / t), mid: r2(m / t), high: r2(h / t), centroidHz: Math.round(den > 0 ? num / den : 0) });
  }
  return {
    rate,
    seconds: r2(opts.sourceSeconds ?? seconds),
    analyzedSeconds: r2(seconds),
    truncated: opts.truncated ?? false,
    integratedLufs: loud.integrated === null ? null : r1(loud.integrated),
    momentaryMaxLufs: Number.isFinite(loud.momentaryMax) ? r1(loud.momentaryMax) : null,
    peakDb: r1(Math.max(-120, dbOf(peak))),
    rangeDb: short.length ? r1(percentile(short, 0.95) - percentile(short, 0.1)) : 0,
    silenceRatio: silenceRatio(envelope),
    tempo,
    balance: { bass: r2(tb / tot), mid: r2(tm / tot), high: r2(th / tot) },
    centroidHz: Math.round(td > 0 ? tn / td : 0),
    onsets: onsetList.length,
    onsetsPerMinute: seconds > 0 ? r1((onsetList.length / seconds) * 60) : 0,
    events,
    envelope: { step: 0.1, db: envelope },
    onsetList,
    sections: { step, rows },
  };
}

/** The summary the record keeps (the full analysis goes to audio.json). */
export function audioSummary(a: AudioAnalysis): AudioSummary {
  return {
    seconds: a.seconds,
    analyzedSeconds: a.analyzedSeconds,
    truncated: a.truncated,
    integratedLufs: a.integratedLufs,
    peakDb: a.peakDb,
    rangeDb: a.rangeDb,
    silenceRatio: a.silenceRatio,
    tempo: a.tempo,
    balance: a.balance,
    centroidHz: a.centroidHz,
    onsets: a.onsets,
    onsetsPerMinute: a.onsetsPerMinute,
    events: a.events,
  };
}
