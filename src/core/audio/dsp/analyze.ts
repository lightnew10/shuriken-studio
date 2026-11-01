/**
 * Listening with numbers. A sound designer judges an effect by ear: is there a crack at the front, weight
 * under it, air on top, a tail in a space, movement while it lasts. Agents have no ears, so analyzeSound()
 * measures those things (the front edge against the body, six spectral bands early / in the body / in the
 * tail, how it decays and how it ends, how tonal it is, how much it moves, how wide it is) and
 * critiqueSound() turns the numbers into the few sentences a designer would say about them for the kind of
 * sound it is meant to be. Every audio_sfx result carries both, so a sound is improved in two or three
 * passes instead of being written blind.
 *
 * The reference ranges are those of well-made game effects (close-miked, edited, mastered): a hit's first
 * 10 ms sit 6-15 dB over what follows and carry energy above 4 kHz; a heavy sound keeps a real share of
 * its energy under 150 Hz; nothing natural stops dead. They are first-principles targets, not measured
 * from a library.
 */
import { SAMPLE_RATE, linToDb } from './util';
import { Biquad } from './filter';
import { powerSpectrum } from './fft';

/** The six bands a mix is judged in. */
export const BANDS = ['sub', 'bass', 'lowMid', 'mid', 'presence', 'air'] as const;
export type Band = (typeof BANDS)[number];
/** Upper edges (Hz) of sub, bass, lowMid, mid, presence; air is everything above. */
export const BAND_EDGES = [60, 150, 500, 2000, 6000] as const;

/** Energy share of each band in dB (0 = all of the energy is in this band; -30 or lower = none worth hearing). */
export type BandLevels = Record<Band, number>;

export interface SoundAnalysis {
  durationMs: number;
  /** Peak over RMS of the whole sound (dB). */
  crestDb: number;
  /** From the first audible sample to 70 % of the loudest point of the first 150 ms. */
  attackMs: number;
  /**
   * The front edge: RMS of the first 10 ms against the RMS of the 30-130 ms after the onset (dB). 0 = a flat
   * burst (no transient), 6+ = a clear hit, 12+ = a crack. null when the sound is shorter than 40 ms.
   */
  punchDb: number | null;
  /** Share of the first 10 ms that is above 4 kHz (dB): the crack and the click live here. */
  edgeAirDb: number;
  /** Band shares of the whole sound, of its first 30 ms, of 30-250 ms and of everything after. */
  bands: BandLevels;
  early: BandLevels;
  body: BandLevels | null;
  tail: BandLevels | null;
  /** Spectral centroid (Hz) of the first 30 ms and of the last third: sounds in a space get darker as they die. */
  centroidStartHz: number;
  centroidEndHz: number;
  /** 0 = pure steady tones, 1 = noise (spectral flatness inside each octave from 200 Hz to 12.8 kHz, per frame, weighted by energy). */
  noisiness: number;
  /** Milliseconds after the loudest point until the level has fallen 20 and 40 dB for good (null: it never does). */
  t20Ms: number | null;
  t40Ms: number | null;
  /** Level of the 5 ms before the closing fade against the loudest 10 ms (dB): above -25 the sound is cut off, not decayed. */
  endDb: number;
  /** How much the level moves while the sound lasts (dB, standard deviation of the 20 ms levels in its middle 80 %). */
  levelMotionDb: number;
  /** How much the colour moves (octaves, standard deviation of the 20 ms centroids in its middle 80 %). */
  toneMotionOct: number;
  /**
   * Sounds of 4 s and more: how far the level travels from second to second (dB between the 10th and 90th
   * percentile of the one-second levels). A bed that evolves moves 3 dB or more; under 1.5 it is a held note.
   */
  swellDb?: number;
  /** Stereo only: correlation of left and right (1 = mono) and side level against mid (dB). */
  stereo?: { correlation: number; sideMidDb: number };
  /**
   * Loops only: how the last 60 ms run into the first 60 ms (levelDb = their level difference, toneOct = their
   * centroid distance), against what neighbouring 60 ms stretches inside the loop differ by anyway (usual...):
   * a seam is heard when it stands out from the sound's own movement.
   */
  seam?: { levelDb: number; toneOct: number; usualLevelDb: number; usualToneOct: number };
}

const r1 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
const r0 = (x: number): number => (Number.isFinite(x) ? Math.round(x) : x);

/** Mono sum of the channels. */
function monoOf(chs: Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0]!;
  const n = chs[0]!.length;
  const m = new Float32Array(n);
  for (const x of chs) for (let i = 0; i < n; i++) m[i]! += x[i]! / chs.length;
  return m;
}

/** The six bands of a signal (24 dB/octave splits), same length as the input. */
export function splitBands(x: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  let rest = x;
  for (const edge of BAND_EDGES) {
    const low = Float32Array.from(rest);
    const high = Float32Array.from(rest);
    for (let k = 0; k < 2; k++) {
      Biquad.lowpass(edge, 0.707).processBuffer(low);
      Biquad.highpass(edge, 0.707).processBuffer(high);
    }
    out.push(low);
    rest = high;
  }
  out.push(rest);
  return out;
}

function sumSq(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) s += x[i]! * x[i]!;
  return s;
}

function bandShares(bands: Float32Array[], from: number, to: number): BandLevels {
  const e = bands.map((b) => sumSq(b, from, to));
  const total = e.reduce((a, b) => a + b, 0) || 1e-20;
  const out = {} as BandLevels;
  BANDS.forEach((name, i) => (out[name] = r1(Math.max(-60, 10 * Math.log10(Math.max(e[i]!, 1e-20) / total)))));
  return out;
}

/** Spectral centroid (Hz) of a stretch, on a log-frequency axis (what "brighter" means to the ear). */
function centroid(x: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.min(from, x.length));
  const b = Math.max(a, Math.min(to, x.length));
  // Exactly the stretch asked for (zero-padded to a power of two), so two stretches of one length compare.
  let size = 256;
  while (size < b - a && size < 8192) size <<= 1;
  const seg = new Float32Array(size);
  seg.set(x.subarray(a, Math.min(b, a + size)));
  const P = powerSpectrum(seg, 0, size);
  let num = 0;
  let den = 0;
  for (let k = 1; k < P.length; k++) {
    const hz = (k * SAMPLE_RATE) / size;
    if (hz < 30 || hz > 16000) continue;
    num += Math.log2(hz) * P[k]!;
    den += P[k]!;
  }
  return den > 0 ? Math.pow(2, num / den) : 0;
}

export interface AnalyzeOptions {
  /** The sound loops: no attack or tail is expected, and the seam is measured. */
  loop?: boolean;
}

export function analyzeSound(chs: Float32Array[], opts: AnalyzeOptions = {}): SoundAnalysis {
  const x = monoOf(chs);
  const n = x.length;
  const ms = (t: number): number => Math.round((t * SAMPLE_RATE) / 1000);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const total = sumSq(x, 0, n);
  const rms = Math.sqrt(total / Math.max(1, n));

  // Onset: the first sample above -30 dB of the peak.
  let onset = 0;
  for (let i = 0; i < n; i++)
    if (Math.abs(x[i]!) > peak * 0.03) {
      onset = i;
      break;
    }

  // Level per 5 ms hop (RMS of 10 ms windows), from the onset.
  const hop = ms(5);
  const win = ms(10);
  const env: number[] = [];
  for (let s = onset; s < n; s += hop) env.push(Math.sqrt(sumSq(x, s, s + win) / win));
  let top = 0;
  let topAt = 0;
  env.forEach((v, i) => {
    if (v > top) {
      top = v;
      topAt = i;
    }
  });

  // Attack: to 70 % of the loudest 1 ms peak of the first 150 ms.
  let early = 0;
  const upto = Math.min(n, onset + ms(150));
  for (let i = onset; i < upto; i++) early = Math.max(early, Math.abs(x[i]!));
  let attack = 0;
  for (let i = onset; i < upto; i++)
    if (Math.abs(x[i]!) >= 0.7 * early) {
      attack = i - onset;
      break;
    }

  const front = Math.sqrt(sumSq(x, onset, onset + win) / win);
  const after = n - onset >= ms(40) ? Math.sqrt(sumSq(x, onset + ms(30), onset + ms(130)) / Math.max(1, Math.min(n, onset + ms(130)) - (onset + ms(30)))) : 0;

  const bands = splitBands(x);
  const air = Float32Array.from(x);
  for (let k = 0; k < 2; k++) Biquad.highpass(4000, 0.707).processBuffer(air);
  const edgeAir = 10 * Math.log10(Math.max(sumSq(air, onset, onset + win), 1e-20) / Math.max(sumSq(x, onset, onset + win), 1e-20));

  // Decay: the last time the level is within 20 / 40 dB of the top.
  const lastAbove = (db: number): number | null => {
    const thr = top * Math.pow(10, -db / 20);
    if (!(env[env.length - 1]! < thr)) return null;
    for (let i = env.length - 1; i >= topAt; i--) if (env[i]! >= thr) return ((i + 1 - topAt) * hop * 1000) / SAMPLE_RATE;
    return 0;
  };

  // The end: the 5 ms before the 10 ms closing fade.
  const endFrom = Math.max(onset, n - ms(15));
  const endRms = Math.sqrt(sumSq(x, endFrom, n - ms(10)) / Math.max(1, n - ms(10) - endFrom));

  // Noisiness: spectral flatness inside each octave from 200 Hz up (so a tilt, or a thump under it, does not
  // read as "tonal"), per 46 ms frame, weighted by energy. A frame of pure noise reads 0.56 (e^-gamma), hence the scale.
  // A sound with next to nothing above 200 Hz (a sub drop, a rumble) is judged on its low octaves instead.
  const size = 2048;
  const sums = [0, 0, 0, 0]; // flatness * energy and energy: from 200 Hz up, and 50-200 Hz
  for (let s = 0; s === 0 || s + size <= n; s += size / 2) {
    const P = powerSpectrum(x, s, size);
    for (let lo = 50; lo < 12800; lo *= 2) {
      let logSum = 0;
      let linSum = 0;
      let count = 0;
      for (let k = Math.ceil((lo * size) / SAMPLE_RATE); k < (2 * lo * size) / SAMPLE_RATE; k++) {
        const v = P[k]! + 1e-18;
        logSum += Math.log(v);
        linSum += v;
        count++;
      }
      const at = lo < 200 ? 2 : 0;
      sums[at]! += (Math.exp(logSum / count) / (linSum / count)) * linSum;
      sums[at + 1]! += linSum;
    }
  }
  const lowOnly = sums[1]! < 0.03 * (sums[1]! + sums[3]!);
  const flatness = Math.min(1, (lowOnly ? sums[0]! + sums[2]! : sums[0]!) / Math.max(lowOnly ? sums[1]! + sums[3]! : sums[1]!, 1e-30) / 0.56);

  // Movement in the middle 80 %: level and colour per 20 ms.
  const step = ms(20);
  const levels: number[] = [];
  const tones: number[] = [];
  const a = onset + Math.round((n - onset) * 0.1);
  const b = onset + Math.round((n - onset) * 0.9);
  for (let s = a; s + step <= b; s += step) {
    const e = sumSq(x, s, s + step) / step;
    if (e < rms * rms * 1e-4) continue;
    levels.push(10 * Math.log10(e));
    tones.push(Math.log2(Math.max(30, centroid(x, s, s + step))));
  }
  const sd = (v: number[]): number => {
    if (v.length < 3) return 0;
    const m = v.reduce((p, c) => p + c, 0) / v.length;
    return Math.sqrt(v.reduce((p, c) => p + (c - m) * (c - m), 0) / v.length);
  };

  const out: SoundAnalysis = {
    durationMs: r0((n * 1000) / SAMPLE_RATE),
    crestDb: r1(linToDb(peak) - linToDb(rms)),
    attackMs: r1((attack * 1000) / SAMPLE_RATE),
    punchDb: after > 0 ? r1(linToDb(front) - linToDb(after)) : null,
    edgeAirDb: r1(Math.max(-60, edgeAir)),
    bands: bandShares(bands, 0, n),
    early: bandShares(bands, onset, onset + ms(30)),
    body: n - onset > ms(60) ? bandShares(bands, onset + ms(30), onset + ms(250)) : null,
    tail: n - onset > ms(300) ? bandShares(bands, onset + ms(250), n) : null,
    centroidStartHz: r0(centroid(x, onset, onset + ms(30))),
    centroidEndHz: r0(centroid(x, Math.max(onset, n - Math.round((n - onset) / 3)), n)),
    noisiness: Math.round(flatness * 100) / 100,
    t20Ms: lastAbove(20) === null ? null : r0(lastAbove(20)!),
    t40Ms: lastAbove(40) === null ? null : r0(lastAbove(40)!),
    endDb: r1(linToDb(endRms) - linToDb(top)),
    levelMotionDb: r1(sd(levels)),
    toneMotionOct: Math.round(sd(tones) * 100) / 100,
  };
  if (n >= 4 * SAMPLE_RATE) {
    const secs: number[] = [];
    for (let s = 0; s + SAMPLE_RATE <= n; s += SAMPLE_RATE >> 1) secs.push(10 * Math.log10(Math.max(sumSq(x, s, s + SAMPLE_RATE) / SAMPLE_RATE, 1e-20)));
    secs.sort((p, q) => p - q);
    out.swellDb = r1(secs[Math.floor(secs.length * 0.9)]! - secs[Math.floor(secs.length * 0.1)]!);
  }
  if (chs.length === 2 && n) {
    let ll = 0, rr = 0, lr = 0, mm = 0, ss = 0;
    const [L, R] = chs as [Float32Array, Float32Array];
    for (let i = 0; i < n; i++) {
      const p = L[i]!, q = R[i]!;
      ll += p * p;
      rr += q * q;
      lr += p * q;
      mm += ((p + q) / 2) ** 2;
      ss += ((p - q) / 2) ** 2;
    }
    out.stereo = { correlation: Math.round((lr / Math.sqrt(Math.max(ll * rr, 1e-20))) * 100) / 100, sideMidDb: r1(10 * Math.log10(Math.max(ss, 1e-20) / Math.max(mm, 1e-20))) };
  }
  if (opts.loop && n > ms(200)) {
    const w = ms(60);
    const head = sumSq(x, 0, w) / w;
    const foot = sumSq(x, n - w, n) / w;
    // The same two measures between neighbouring stretches inside the loop (their 80th percentile).
    const lv: number[] = [];
    const tn: number[] = [];
    let prevE = 0;
    let prevC = 0;
    for (let s = 0, k = 0; s + w <= n; s += w, k++) {
      const e = sumSq(x, s, s + w) / w;
      const c = Math.max(30, centroid(x, s, s + w));
      if (k > 0) {
        lv.push(Math.abs(10 * Math.log10(Math.max(e, 1e-20) / Math.max(prevE, 1e-20))));
        tn.push(Math.abs(Math.log2(c / prevC)));
      }
      prevE = e;
      prevC = c;
    }
    const p80 = (v: number[]): number => (v.length ? [...v].sort((p, q) => p - q)[Math.floor(v.length * 0.8)]! : 0);
    out.seam = {
      levelDb: r1(10 * Math.log10(Math.max(foot, 1e-20) / Math.max(head, 1e-20))),
      toneOct: Math.round(Math.abs(Math.log2(Math.max(30, centroid(x, n - w, n)) / Math.max(30, centroid(x, 0, w)))) * 100) / 100,
      usualLevelDb: r1(p80(lv)),
      usualToneOct: Math.round(p80(tn) * 100) / 100,
    };
  }
  return out;
}

// ─── the critique ────────────────────────────────────────────────────────────

/**
 * What a sound is meant to be, as far as judging it goes. shot: gunfire, cannons, launches. explosion. impact:
 * punches, hits, slams, clangs (one thing struck). step: footsteps and landings. mechanism: reloads, latches,
 * equips, ratchets (several small events in a row). ui: clicks, blips, ticks. tonal: chimes, alarms, pickups,
 * stingers (pitched on purpose). whoosh: swings, dashes, air, thrusters. riser: charge-ups, power-ups, deploys
 * (it builds). loop: engines, servos, beams, beds (sustained, seamless).
 */
export const SOUND_KINDS = ['shot', 'explosion', 'impact', 'step', 'mechanism', 'ui', 'tonal', 'whoosh', 'riser', 'loop'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export interface CritiqueOptions {
  kind?: SoundKind;
  /** The sound is meant to be heavy (a mech's step, a cannon): weight under 150 Hz is expected. */
  heavy?: boolean;
  /** An ambience bed (a long loop under everything else): judged on how it evolves, its width and how much room it leaves. */
  bed?: boolean;
  /** Meant to be heard from far away (params.distance): no front edge, crack or top end is expected. */
  far?: boolean;
  /** How mastering went: a sound that ends under its loudness target has a body too thin for its front. */
  master?: { loudness: number | null; targetLufs: number; clipDb: number; limiterDb: number };
}

export interface Critique {
  /** One line of numbers, always present. */
  heard: string;
  /** What a sound designer would fix, most audible first, each with the parameters that do it ([] = nothing stands out). */
  improve: string[];
}

const low = (b: BandLevels): number => 10 * Math.log10(Math.pow(10, b.sub / 10) + Math.pow(10, b.bass / 10));
const high = (b: BandLevels): number => 10 * Math.log10(Math.pow(10, b.presence / 10) + Math.pow(10, b.air / 10));

const KIND_WORDS: Array<[SoundKind, RegExp]> = [
  ['step', /foot|step|stomp|tread(?!rumble)|landing|land(?:ed)?$/i],
  ['mechanism', /reload|equip|latch|ratchet|wrench|airtool|clunk|hatch|holster|rack(?:ing)?$/i],
  ['riser', /deploy|charge|power[_-]?up|riser|spool|warm[_-]?up|startup|spawn|warp/i],
  ['explosion', /explo|blast|detonat|boom|blowup|destroyed?|death/i],
  ['shot', /fire|shot|shoot|gun|cannon|rifle|pistol|launch|rocket|missile|laser|blaster|turret/i],
  ['ui', /click|hover|tick|button|select|toggle|ui[_-]?(?:click|hover|tap|open|close|back)|tap$/i],
  ['whoosh', /whoosh|swoosh|woosh|swing|dash|boost|swish|wind|thrust|jet|flyby/i],
  ['tonal', /chime|bell|alarm|warning|beep|notify|unlock|levelup|victory|defeat|coin|pickup|jingle|fanfare|success|error/i],
  ['impact', /hit|punch|slam|clang|clank|impact|block|smash|crash|thud/i],
];
const HEAVY_WORDS = /heavy|giant|huge|massive|titan|boss|cannon|slam|stomp|tank/i;

/**
 * The kind a sound is judged as when the caller does not say: from its name and description, else from its
 * loudness category and shape. heavy from the same words.
 */
export function guessKind(a: SoundAnalysis, category: string | undefined, loop = false, words = ''): { kind: SoundKind; heavy: boolean } {
  const heavy = HEAVY_WORDS.test(words);
  if (loop) return { kind: 'loop', heavy };
  for (const [kind, re] of KIND_WORDS) if (re.test(words)) return { kind, heavy };
  let kind: SoundKind;
  if (category === 'ui') kind = 'ui';
  else if (category === 'footstep') kind = 'step';
  else if (category === 'stinger' || category === 'pickup') kind = a.noisiness < 0.3 ? 'tonal' : 'impact';
  else if (category === 'movement') kind = a.attackMs > 25 ? 'whoosh' : 'impact';
  else if (category === 'impact') kind = a.durationMs > 900 && low(a.bands) > -6 ? 'explosion' : 'impact';
  else kind = a.noisiness < 0.2 ? 'tonal' : 'impact';
  return { kind, heavy };
}

const an = (kind: SoundKind): string => (kind === 'impact' || kind === 'explosion' ? `an ${kind}` : kind === 'ui' ? 'a UI sound' : `a ${kind}`);

/** What gives each kind of sound the body its loudness needs. */
const BODY_ADVICE: Partial<Record<SoundKind, string>> = {
  ui: 'A click carries its level with 20-60 ms of tone under the tick: a sine or triangle blip (freq 800-2000 falling a little, sustain 0.005, decay 0.05-0.1), and clip 0.5',
  tonal: 'Let the notes last (sustain 0.03-0.1, decay 0.2+), layer an octave, or add a space',
  whoosh: 'Hold the main noise longer (sustain 0.1+) and make it the loudest layer',
  riser: 'Let the build be loud before the peak (levelCurve rising to 1, or a longer sustain), not only its end',
  mechanism: 'The events are far apart with silence between: put something under them (a slide or servo: band-passed noise with attack 0.03 and sustain across the gap, a quiet motor tone), give each clunk a body (pink, lowpass 3000 falling to 600, sustain 0.01, decay 0.1), clip 0.6',
};

export function critiqueSound(a: SoundAnalysis, o: CritiqueOptions = {}): Critique {
  const kind = o.kind ?? 'impact';
  const improve: string[] = [];
  const struck = kind === 'shot' || kind === 'explosion' || kind === 'impact' || kind === 'step';
  const lowDb = low(a.bands);
  const highDb = high(a.bands);

  if (kind === 'loop' && o.bed) {
    if (a.seam && (Math.abs(a.seam.levelDb) > Math.max(1.5, 2 * a.seam.usualLevelDb) || a.seam.toneOct > Math.max(0.25, 2 * a.seam.usualToneOct))) improve.push(`the loop seam is audible: the end is ${a.seam.levelDb > 0 ? '+' : ''}${a.seam.levelDb} dB and ${a.seam.toneOct} octaves away from the start (inside the loop neighbouring moments differ by ${a.seam.usualLevelDb} dB and ${a.seam.usualToneOct} octaves). Take out what drifts over the length (slide, freqEnd, lowpassEnd on held voices)`);
    if (a.durationMs < 15000) improve.push(`short: a ${r1(a.durationMs / 1000)} s bed is heard repeating. 20-40 s, so its events do not come round like a clock`);
    if ((a.swellDb ?? 0) < 1.5) improve.push(`static: from second to second the level moves ${a.swellDb ?? 0} dB, so it is a held noise, not a place. Let the held voices breathe at different slow rates (tremoloDepth 0.4-0.7 with tremoloSpeed 0.04-0.15, filterLfoDepth 0.5-1 with filterLfoSpeed 0.05-0.12: periods of 8-25 s that do not line up) and add events (layers with scatter)`);
    if (!a.stereo) improve.push('mono: a bed plays in 2D around the listener. width 0.6-0.9 (noise layers are spread, lows stay in the middle), pan on the tonal voices, scatterPan on the events');
    if (highDb > -8) improve.push(`bright for a bed: ${r1(highDb)} dB of the energy is above 2 kHz, where the game's effects and voices need the room. Lower or lowpass the hiss layers, or tone: {presence: -3, air: -3}`);
    if (lowDb > -1.5) improve.push(`all rumble: ${r1(lowDb)} dB of the energy is under 150 Hz and small speakers will play nothing. Add a mid layer (band-passed pink at 400-1200 Hz) and some air (white above 3 kHz, quiet)`);
    return { heard: heardLine(a), improve };
  }
  if (kind === 'loop') {
    if (a.seam && (Math.abs(a.seam.levelDb) > Math.max(1.5, 2 * a.seam.usualLevelDb) || a.seam.toneOct > Math.max(0.25, 2 * a.seam.usualToneOct))) improve.push(`the loop seam is audible: the end is ${a.seam.levelDb > 0 ? '+' : ''}${a.seam.levelDb} dB and ${a.seam.toneOct} octaves away from the start (inside the loop neighbouring moments differ by ${a.seam.usualLevelDb} dB and ${a.seam.usualToneOct} octaves). Set loop: true (the engine closes the seam: held voices get whole cycles, noise is crossfaded) and take out what drifts over the length (slide, freqEnd, lowpassEnd)`);
    if (a.levelMotionDb < 0.4 && a.toneMotionOct < 0.05) improve.push(`static: over the loop the level moves ${a.levelMotionDb} dB and the colour ${a.toneMotionOct} octaves, so it reads as a test tone. A machine moves: filterLfoDepth 0.3-0.8 with filterLfoSpeed 0.5-3, tremoloDepth 0.2-0.5 at tremoloSpeed 20-60 (gear chatter) or 2-8 (pulsing), unison 3 with detune 10-20 (beating), jitter 5-20 (an unsteady motor), fm with fmIndex 0.5-2 (whine), a crackle layer (sputter)`);
    if (a.noisiness < 0.1) improve.push(`purely tonal (noisiness ${a.noisiness}): a machine also has a noise floor (air, friction, electricity). Add a band-passed pink or white layer (bandpass 1500-4000, resonance 1-2, volume 0.3-0.6; noise is about 6 dB quieter than an oscillator at the same volume)`);
    if (highDb < -22) improve.push(`dull: ${r1(highDb)} dB of the energy is above 2 kHz. Open the lowpass, or add a quiet high layer (a whine at 2-5 kHz, hiss with highpass 4000)`);
    return { heard: heardLine(a), improve };
  }

  // Loudness against the front. Under a peak ceiling the two trade: a sound that stays under its target has too
  // little behind its transient, and one that needed its peaks clipped to get there has no room for a sharper front.
  const m = o.master;
  const want = kind === 'shot' ? 6 : kind === 'impact' ? 5 : kind === 'step' ? 4 : 3;
  const under = m && m.loudness !== null ? m.targetLufs - m.loudness : 0;
  if (under > 1.5 && !struck) improve.push(`${r1(under)} LU under its loudness target with its peaks at the ceiling: it is too short or too sparse to carry the level of its class (the loudest 400 ms are what is measured), so it will sound small next to other sounds. ${BODY_ADVICE[kind] ?? 'Give it a body that lasts'}`);
  if (under > 1.5 && struck) {
    const sharp = a.punchDb !== null && a.punchDb > want + 3;
    improve.push(`${r1(under)} LU under its loudness target with its peaks at the ceiling: ${sharp ? `the front is ${a.punchDb} dB over the body, more than ${an(kind)} needs (${want}+), and there is too little behind it` : 'there is too little body behind the front'}, so it will sound small next to other sounds. ${sharp ? 'Lower transient (0, or -0.3 to soften), and make' : 'Make'} the body denser: a noise body with sustain 0.03-0.06 and decay 0.3-0.5 under the crack, clip 0.6-0.8, weight 0.4-0.7, a space (the tail counts)`);
  }
  // No room: the loudness was reached by clipping the peaks, so the front is as far over the body as the ceiling allows.
  const noRoom = !!m && under <= 1.5 && m.clipDb + m.limiterDb >= 3;

  // The front edge.
  if ((struck || kind === 'ui') && !o.far) {
    if (a.attackMs > (kind === 'explosion' ? 12 : 6)) improve.push(`slow front: it takes ${a.attackMs} ms to reach its level. ${kind === 'ui' ? 'A click' : 'A hit'} starts in under 2 ms: give the first layers attack 0.0005 and delay 0 (a lead-in belongs in its own sound or needs the hit to be the loudest thing)`);
    if (a.punchDb !== null && struck && under <= 1.5) {
      if (a.punchDb < (noRoom ? Math.min(want, 3) : want)) improve.push(`transient weak: the first 10 ms are ${a.punchDb} dB over the body (${an(kind)} wants ${want}+). Anything held at full level buries the front: sustain 0 on the crack and the thump, a short hold (0.02-0.06) on the body noise only, and the crack the loudest thing in the first 5 ms (white, highpass 2500, attack 0.0003, sustain 0, decay 0.02-0.04, volume 1.5-2.5: noise is about 6 dB quieter than an oscillator at the same volume). transient 0.7-1 sharpens what is there`);
    }
    if (struck && a.edgeAirDb < (kind === 'step' ? -20 : -12)) improve.push(`no crack: ${a.edgeAirDb} dB of the first 10 ms is above 4 kHz (${an(kind)} wants ${kind === 'step' ? -20 : -12} or more). Add or raise a white layer at the very start: highpass 3000-6000, attack 0.0003, sustain 0, decay 0.01-0.03, volume 1.5-2.5, delay 0`);
  }

  // Weight.
  if (struck && (o.heavy || kind === 'explosion') && !o.far) {
    const want = kind === 'explosion' ? -5 : kind === 'shot' ? -8 : -7;
    if (lowDb < want) improve.push(`thin: ${r1(lowDb)} dB of the energy is under 150 Hz (a heavy ${kind} wants ${want} or more). Add or raise a sine thump (freq 110-180 falling to freqEnd 35-55, pitchTime 0.03-0.08, sustain 0, decay 0.15-0.4, drive 0.3) and a rumble (brown, lowpass 150-250, decay 0.3-1); weight 0.5 adds harmonics and the octave below`);
  }
  if (struck && a.bands.lowMid > -2.5 && a.durationMs > 150) improve.push(`boxy: ${a.bands.lowMid} dB of the energy sits in 150-500 Hz. Move the body down (lower freq and freqEnd), highpass the noise layers at 500, or tone: {mid: -4}`);

  // Top end.
  if (kind !== 'tonal' && kind !== 'ui' && kind !== 'riser' && !o.far && highDb < (kind === 'explosion' ? -16 : kind === 'step' ? (o.heavy ? -18 : -12) : -12)) improve.push(`dull: ${r1(highDb)} dB of the energy is above 2 kHz. Start the noise layers open and close them (lowpass 9000-12000 falling to lowpassEnd 800-1500), add air (white, highpass 6000, sustain 0, decay 0.05-0.2, volume 0.5-1)${kind === 'step' ? ' or debris (white, highpass 2500, crackle 60-150, decay 0.2-0.4)' : ''}, or tone: {air: 3, presence: 2}`);
  if (a.bands.presence > -1.5 && a.durationMs > 120 && kind !== 'ui') improve.push(`harsh: ${a.bands.presence} dB of the energy is in 2-6 kHz, where ears are most sensitive. Lower the layers band-passed there, or tone: {presence: -3}`);

  // The tail and the space.
  if (kind !== 'ui') {
    if (a.endDb > -25 && a.durationMs > 60) improve.push(`cut off: still ${a.endDb} dB under its loudest when the end fade starts. Let the last voice decay (decay 0.05+ instead of a held sustain), or give it a space (space: 'room' with spaceMix 0.15)`);
    if ((kind === 'shot' || kind === 'explosion') && a.t40Ms !== null && a.t40Ms < (kind === 'explosion' ? 1200 : 450)) improve.push(`no tail: it is 40 dB down ${a.t40Ms} ms after its loudest point, so it happens in a padded box. ${kind === 'explosion' ? 'An explosion' : 'A shot'} rings in a place: space: 'outdoor' (a slap, then echoes rolling away), 'hangar' or 'hall' with spaceMix 0.2-0.35, plus a rumble layer (brown, lowpass 400 falling to lowpassEnd 80, decay ${kind === 'explosion' ? '1.5-2.5' : '0.4-0.8'})`);
    if (kind === 'explosion' && a.tail && high(a.tail) > high(a.early) + 3 && high(a.tail) > -14) improve.push(`the tail is brighter than the blast (${r1(high(a.tail))} dB above 2 kHz against ${r1(high(a.early))} at the start): a real one rumbles away. Sweep the long noise layers down (lowpass 6000 falling to lowpassEnd 300) and keep bright debris sparse (crackle 40-120)`);
    if ((kind === 'impact' || kind === 'step') && o.heavy && a.t40Ms !== null && a.t40Ms < 250) improve.push(`short for something heavy: 40 dB down after ${a.t40Ms} ms. Mass rings and settles: a longer body (decay 0.3-0.6), a material ring (wave modal, material plate or bar, decay 0.4-0.9, volume 0.3-0.5) or space: 'hangar' / 'outdoor' with spaceMix 0.15-0.25`);
  }

  // Character.
  if (kind === 'riser') {
    if (a.toneMotionOct < 0.4) improve.push(`static riser: the colour moves ${a.toneMotionOct} octaves. A build rises: freqCurve up one or two octaves, lowpass 400 with lowpassEnd 6000 (resonance 2-3), a noise layer whose highpass climbs (highpass 800, highpassEnd 5000), unison 5 with detune 20`);
    if (a.attackMs < 80 && a.durationMs > 400) improve.push(`it starts at full level (${a.attackMs} ms): a build swells. attack about half the length on the rising layers, or a levelCurve from 0.1 to 1`);
  }
  if (kind === 'whoosh') {
    if (a.toneMotionOct < 0.2) improve.push(`static whoosh: the colour moves ${a.toneMotionOct} octaves. A whoosh is a band-pass sweeping past the listener: bandpass 400 with bandpassEnd 3000+ (resonance 1.5-3), attack about a third of the length, and for 2D sounds pan -0.6 with panEnd 0.6`);
    if (a.attackMs < 15 && a.durationMs > 200) improve.push(`it starts at full level (${a.attackMs} ms): a whoosh swells. attack 0.05-0.15 on the main noise voice (a thruster's ignition thump is a separate short layer)`);
  }
  if ((kind === 'impact' || kind === 'step' || kind === 'mechanism') && a.noisiness < 0.12 && a.durationMs > 150) improve.push(`all ring, no material (noisiness ${a.noisiness}): struck things also make a broadband knock. Add a short noise body (pink, lowpass 2500 falling to lowpassEnd 500, sustain 0, decay 0.05-0.1, volume 1)`);
  if (kind === 'tonal' && a.noisiness > 0.6) improve.push(`noisy for a pitched sound (noisiness ${a.noisiness}): lower the noise layers or filter them above the notes`);
  if ((kind === 'shot' || kind === 'explosion') && a.noisiness < 0.35) improve.push(`too tonal for ${an(kind)} (noisiness ${a.noisiness}): it reads as a synth note. Its body is noise: make filtered noise the loudest layer above 200 Hz and keep oscillators for the thump under it`);
  if (a.stereo && a.stereo.sideMidDb > -3) improve.push(`very wide (side ${a.stereo.sideMidDb} dB against mid): it thins out in mono and when played at a position in the world. Lower width, spread or the pans`);
  return { heard: heardLine(a) + (m && m.clipDb + m.limiterDb >= 0.5 ? `; mastering took ${r1(m.clipDb + m.limiterDb)} dB off the peaks` : ''), improve: improve.slice(0, 5) };
}

function heardLine(a: SoundAnalysis): string {
  const b = a.bands;
  const parts = [
    `${a.durationMs} ms`,
    `attack ${a.attackMs} ms`,
    ...(a.punchDb === null ? [] : [`front ${a.punchDb > 0 ? '+' : ''}${a.punchDb} dB over body`]),
    `crack ${a.edgeAirDb} dB (first 10 ms above 4 kHz)`,
    `bands sub ${b.sub} / bass ${b.bass} / low-mid ${b.lowMid} / mid ${b.mid} / presence ${b.presence} / air ${b.air} dB`,
    `brightness ${a.centroidStartHz} -> ${a.centroidEndHz} Hz`,
    `noisiness ${a.noisiness}`,
    a.t40Ms === null ? `never 40 dB down (ends at ${a.endDb} dB)` : `-20 dB at ${a.t20Ms} ms, -40 dB at ${a.t40Ms} ms`,
    `movement ${a.levelMotionDb} dB, ${a.toneMotionOct} oct${a.swellDb !== undefined ? `, ${a.swellDb} dB from second to second` : ''}`,
    a.stereo ? `stereo (side ${a.stereo.sideMidDb} dB)` : 'mono',
    ...(a.seam ? [`seam ${a.seam.levelDb} dB, ${a.seam.toneOct} oct (inside the loop ${a.seam.usualLevelDb} dB, ${a.seam.usualToneOct} oct)`] : []),
  ];
  return parts.join('; ');
}

/** How different two takes of a sound are: level (dB), length (%), colour (octaves of centroid) and spectrum (dB rms). */
export function takeDifference(a: Float32Array, b: Float32Array): { levelDb: number; lengthPct: number; toneOct: number; spectrumDb: number } {
  const ea = sumSq(a, 0, a.length) / a.length;
  const eb = sumSq(b, 0, b.length) / b.length;
  const size = 1024;
  const spec = (x: Float32Array): Float64Array => {
    const acc = new Float64Array(size / 2 + 1);
    let f = 0;
    for (let s = 0; s === 0 || s + size <= x.length; s += size / 2) {
      const P = powerSpectrum(x, s, size);
      for (let k = 0; k < P.length; k++) acc[k]! += P[k]!;
      f++;
    }
    return acc.map((v) => v / f);
  };
  const A = spec(a);
  const B = spec(b);
  let e = 0;
  let c = 0;
  for (let k = 2; k < 372; k++) {
    const d = 10 * Math.log10((A[k]! + 1e-12) / (B[k]! + 1e-12));
    e += d * d;
    c++;
  }
  return {
    levelDb: r1(10 * Math.log10(eb / ea)),
    lengthPct: r1((b.length / a.length - 1) * 100),
    toneOct: Math.round(Math.log2(Math.max(30, centroid(b, 0, b.length)) / Math.max(30, centroid(a, 0, a.length))) * 100) / 100,
    spectrumDb: r1(Math.sqrt(e / c)),
  };
}
