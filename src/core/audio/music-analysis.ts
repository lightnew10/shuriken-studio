/**
 * Listening to a rendered song the way a mixing engineer would, so the copilot can correct a song over a few
 * passes as it does a sound effect: how much of the mix each part takes and how much of that is low end, parts
 * that fight for the low end in the same bars (an 808 and a pad), each section's loudness and brightness and
 * how they contrast (a drop that doesn't lift), how deep the kick pumps the rest, and what to change, with the
 * parameters that do it. Energies are measured per beat in three bands (under 150 Hz, 150-500 Hz, over 4 kHz)
 * with filters, not FFTs, so it costs a fraction of the render.
 */
import { SAMPLE_RATE } from './dsp/util';
import { Biquad } from './dsp/filter';
import { measureLoudness } from './dsp/master';
import type { Instrument, SongSpec } from './music';

const SR = SAMPLE_RATE;

export interface MixPart {
  track: number;
  name: string;
  instrument: Instrument;
  /** How deep the kick ducks it (0: not at all). */
  duck: number;
  /** The part as it enters the mix (after its pump), folded to the loop's length. */
  L: Float32Array;
  R: Float32Array;
}

export interface MixReport {
  /** One line of what it measures as. */
  heard: string;
  /** Each part's share of the mix's energy and of what is above 150 Hz (how present it is), and how much of it is low end (%). */
  parts: Array<{ track: number; name: string; share: number; presence: number; low: number }>;
  sections: Array<{ name: string; bars: string; lufs: number | null; highPct: number; lowPct: number }>;
  clashes: Array<{ a: string; b: string; bars: string; overlap: number }>;
  /** How far the parts the kick ducks dip after it (dB), when there are both. */
  pumpDb: number | null;
  /** What to change, most audible first, with the parameters that do it. */
  improve: string[];
}

interface Bands {
  /** Per beat: all, under 150 Hz, 150-500 Hz, over 4 kHz (energy). */
  all: Float64Array;
  low: Float64Array;
  lowMid: Float64Array;
  high: Float64Array;
}

/** An RBJ low-pass (Q 0.707) at any sample rate: the decimated copies run at 5.5 kHz. */
function lowpassAt(fc: number, rate: number): (x: number) => number {
  const w0 = (2 * Math.PI * fc) / rate;
  const cos = Math.cos(w0);
  const al = Math.sin(w0) / (2 * 0.707);
  const a0 = 1 + al;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - al) / a0;
  let z1 = 0;
  let z2 = 0;
  return (x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b0 * x - a2 * y;
    return y;
  };
}

/**
 * Energy per beat. A part needs only its total and its low end, measured on a copy decimated by 8 (an 8-sample
 * average, 5.5 kHz: the low-pass after it does the rest); the master gets all four bands at full rate.
 */
function bands(L: Float32Array, R: Float32Array, beatLen: number, full: boolean): Bands {
  const beats = Math.max(1, Math.floor(L.length / beatLen));
  const out: Bands = { all: new Float64Array(beats), low: new Float64Array(beats), lowMid: new Float64Array(beats), high: new Float64Array(beats) };
  const n = beats * beatLen;
  if (!full) {
    const D = 8;
    const lp1 = lowpassAt(150, SR / D);
    const lp2 = lowpassAt(150, SR / D);
    for (let i = 0; i + D <= n; i += D) {
      let acc = 0;
      let e = 0;
      for (let j = 0; j < D; j++) {
        const m = (L[i + j]! + R[i + j]!) * 0.5;
        acc += m;
        e += m * m;
      }
      const lo = lp2(lp1(acc / D));
      const b = Math.floor(i / beatLen);
      out.all[b]! += e;
      out.low[b]! += lo * lo * D;
    }
    return out;
  }
  const lp1 = Biquad.lowpass(150, 0.707);
  const lp2 = Biquad.lowpass(150, 0.707);
  const bpLo = Biquad.highpass(150, 0.707);
  const bpHi = Biquad.lowpass(500, 0.707);
  const hp1 = Biquad.highpass(4000, 0.707);
  const hp2 = Biquad.highpass(4000, 0.707);
  for (let i = 0; i < n; i++) {
    const m = (L[i]! + R[i]!) * 0.5;
    const b = Math.floor(i / beatLen);
    const lo = lp2.process(lp1.process(m));
    const lm = bpHi.process(bpLo.process(m));
    const hi = hp2.process(hp1.process(m));
    out.all[b]! += m * m;
    out.low[b]! += lo * lo;
    out.lowMid[b]! += lm * lm;
    out.high[b]! += hi * hi;
  }
  return out;
}

const sum = (x: Float64Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]!;
  return s;
};
const pct = (a: number, b: number) => Math.round((100 * a) / Math.max(1e-20, b));

/** Bars (1-based) where a per-beat mask is true, as ranges. */
function barRanges(mask: boolean[]): string {
  const bars = [...new Set(mask.flatMap((m, i) => (m ? [Math.floor(i / 4) + 1] : [])))];
  const out: string[] = [];
  for (let i = 0; i < bars.length; ) {
    let j = i;
    while (j + 1 < bars.length && bars[j + 1] === bars[j]! + 1) j++;
    out.push(bars[i] === bars[j] ? `${bars[i]}` : `${bars[i]}-${bars[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** Parts that carry a tune the ear follows (judged by their share above 150 Hz, where loudness is heard). */
const MELODIC = new Set<Instrument>(['lead', 'pluck', 'cowbell', 'koto', 'flute', 'vocal']);
/** Parts whose place is the low end. */
const LOW_OK = new Set<Instrument>(['bass', 'bass808', 'kick', 'taiko', 'tom', 'impact']);
const DRUM_LOW = new Set<Instrument>(['kick', 'taiko', 'tom', 'impact']);
/** Parts that hold notes, where a pump shows. */
const HELD = new Set<Instrument>(['pad', 'strings', 'texture']);

/** The report on a rendered song: its parts (as they enter the mix, after the pump), its master, where its kicks fall. */
export function analyseMix(spec: SongSpec, parts: MixPart[], master: [Float32Array, Float32Array], kicks: number[]): MixReport {
  const beatLen = Math.round((60 / spec.bpm) * SR);
  const per = parts.map((p) => ({ p, b: bands(p.L, p.R, beatLen, false) }));
  const mix = bands(master[0], master[1], beatLen, true);
  const beats = mix.all.length;
  const totalAll = per.reduce((s, x) => s + sum(x.b.all), 0);
  const totalLow = per.reduce((s, x) => s + sum(x.b.low), 0);
  // Low frequencies carry most of a mix's energy but not of its loudness: what a part holds above 150 Hz is how
  // present it is.
  const above = (x: (typeof per)[number]) => sum(x.b.all) - sum(x.b.low);
  const totalAbove = per.reduce((s, x) => s + above(x), 0);
  const partsOut = per
    .filter((x) => sum(x.b.all) > 0)
    .map((x) => ({ track: x.p.track, name: x.p.name, share: pct(sum(x.b.all), totalAll), presence: pct(above(x), totalAbove), low: pct(sum(x.b.low), sum(x.b.all)) }));

  // Low-end clashes: two parts that each hold a real share of the low end (8 %+) and are loud there in the same
  // beats (a third or more of the weaker one's low end coincides with the other's, at a level near it).
  const clashes: MixReport['clashes'] = [];
  const lowParts = per.filter((x) => sum(x.b.low) > 0.08 * totalLow);
  for (let i = 0; i < lowParts.length; i++)
    for (let j = i + 1; j < lowParts.length; j++) {
      const a = lowParts[i]!;
      const b = lowParts[j]!;
      // A kick (or taiko) on a bass or an 808 is the genre, not a clash (the 808 follows the kick).
      const kinds = [a.p.instrument, b.p.instrument];
      if (kinds.some((k) => DRUM_LOW.has(k)) && kinds.some((k) => k === 'bass808' || k === 'bass')) continue;
      // Beats where both are loud down there, at levels near each other (a kick's short hit over a held pad isn't).
      let both = 0;
      const mask: boolean[] = [];
      for (let k = 0; k < Math.min(a.b.low.length, b.b.low.length); k++) {
        const m = Math.min(a.b.low[k]!, b.b.low[k]!);
        const hit = m > 0.25 * Math.max(a.b.low[k]!, b.b.low[k]!) && m > 0.02 * (totalLow / Math.max(1, beats));
        mask.push(hit);
        if (hit) both += m;
      }
      const overlap = both / Math.max(1e-20, Math.min(sum(a.b.low), sum(b.b.low)));
      if (overlap >= 0.35) clashes.push({ a: a.p.name, b: b.p.name, bars: barRanges(mask), overlap: Math.round(overlap * 100) });
    }

  // Sections: loudness, the share over 4 kHz and under 150 Hz, from the master.
  const sections: MixReport['sections'] = [];
  let bar = 0;
  for (const s of spec.sections?.length ? spec.sections : [{ name: 'Song', bars: Math.round(spec.beats / 4) }]) {
    const a = bar * 4 * beatLen;
    const b = Math.min(master[0].length, (bar + s.bars) * 4 * beatLen);
    const l = b - a > SR * 0.5 ? measureLoudness([master[0].subarray(a, b), master[1].subarray(a, b)]).integrated : null;
    const ba = bar * 4;
    const bb = Math.min(beats, (bar + s.bars) * 4);
    sections.push({ name: s.name, bars: `${bar + 1}-${bar + s.bars}`, lufs: l === null ? null : Math.round(l * 10) / 10, highPct: pct(sum(mix.high, ba, bb), sum(mix.all, ba, bb)), lowPct: pct(sum(mix.low, ba, bb), sum(mix.all, ba, bb)) });
    bar += s.bars;
  }

  // The pump: the held parts the kick ducks (pads, strings, keys, beds), summed, just after each kick against just
  // before the next. Hits and the 808 start with the kick, so they show their own attack, not the pump.
  let pumpDb: number | null = null;
  const pumped = parts.filter((p) => p.duck > 0 && HELD.has(p.instrument));
  if (kicks.length >= 4 && pumped.length) {
    const n = master[0].length;
    const sumSq = (a: number, b: number) => {
      let s = 0;
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) {
        let v = 0;
        for (const p of pumped) v += (p.L[i]! + p.R[i]!) * 0.5;
        s += v * v;
      }
      return s / Math.max(1, Math.min(n, b) - Math.max(0, a));
    };
    const sorted = [...new Set(kicks)].filter((k) => k < n).sort((a, b) => a - b);
    const ratios: number[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const k = sorted[i]!;
      const next = sorted[i + 1]!;
      if (next - k < 0.18 * SR) continue;
      const after = sumSq(k + Math.round(0.02 * SR), k + Math.round(0.07 * SR));
      const before = sumSq(next - Math.round(0.06 * SR), next - Math.round(0.005 * SR));
      if (after > 0 && before > 0) ratios.push(10 * Math.log10(before / after));
    }
    if (ratios.length) {
      ratios.sort((a, b) => a - b);
      pumpDb = Math.round(ratios[ratios.length >> 1]! * 10) / 10;
    }
  }

  const improve: string[] = [];
  for (const c of clashes) {
    const quiet = [c.a, c.b].find((nm) => !LOW_OK.has(per.find((x) => x.p.name === nm)!.p.instrument)) ?? c.b;
    improve.push(`${c.a} and ${c.b} fight for the low end (bars ${c.bars}; ${c.overlap}% of the lighter one's lows sit on the other's): high-pass ${quiet} at 150-250 Hz (set hp), or duck it under the kick (duck 0.6-0.8), or move it up an octave (transpose 12)`);
  }
  for (const drop of sections.filter((x) => /drop|chorus|hook/i.test(x.name))) {
    const prev = sections[sections.indexOf(drop) - 1];
    if (!(prev && prev.lufs !== null && drop.lufs !== null && drop.lufs - prev.lufs < 1.5)) continue;
    // A riser into it and an impact on it already there: what is left is to thin what comes before.
    const at = (Number(drop.bars.split('-')[0]) - 1) * 4;
    const built = spec.tracks.some((t) => t.instrument === 'riser' && !t.mute && t.notes.some((n) => Math.abs(n.t + n.d - at) < 0.5)) && spec.tracks.some((t) => t.instrument === 'impact' && !t.mute && t.notes.some((n) => Math.abs(n.t - at) < 0.5));
    improve.push(`the ${drop.name} is only ${(drop.lufs - prev.lufs).toFixed(1)} dB louder than the ${prev.name} before it: for a bigger lift, thin or clear the ${prev.name}'s drums or low end (thin, clear)${built ? ', or lower its riser' : `, or add a riser into the ${drop.name} and an impact on it`}`);
  }
  for (const p of partsOut) {
    const part = per.find((x) => x.p.track === p.track)!.p;
    if (p.presence > 65 && !LOW_OK.has(part.instrument)) improve.push(`${p.name} is ${p.presence}% of everything above 150 Hz: the other parts are under it. Lower its volume (set volume) or its send`);
    if ((MELODIC.has(part.instrument) || /melody|lead|vocal|cowbell/i.test(p.name)) && p.presence < 3) improve.push(`${p.name} carries the tune but is only ${p.presence}% of what is heard above 150 Hz: raise its volume`);
    if (!LOW_OK.has(part.instrument) && p.low > 45 && p.share > 8) improve.push(`${p.name} is ${p.low}% low end (under 150 Hz) though it isn't a bass: high-pass it (set hp 150-250)`);
  }
  if (spec.style === 'phonk' && pumpDb !== null && pumpDb < 2) improve.push(`phonk pumps, and this one barely does (${pumpDb} dB after each kick): duck 0.6-0.8 on the pad, cowbell and hats, or song duckRelease 0.12-0.2 for a longer breath`);
  const all = sum(mix.all);
  const highPct = pct(sum(mix.high), all);
  const lowMidPct = pct(sum(mix.lowMid), all);
  if (highPct < 1) improve.push(`almost nothing above 4 kHz (${highPct}%): dull. Brighter hats, song tone 0.5-0.8, or less tape warmth`);
  if (lowMidPct > 40) improve.push(`${lowMidPct}% of the mix is 150-500 Hz: muddy. High-pass pads, keys and chords at 200-300 Hz`);

  const top = [...partsOut].sort((a, b) => b.share - a.share).slice(0, 4);
  const heard = [
    `parts (share of energy / of what is heard above 150 Hz): ${top.map((p) => `${p.name} ${p.share}/${p.presence}%`).join(', ')}`,
    `sections: ${sections.map((s) => `${s.name} ${s.lufs ?? '?'} LUFS`).join(', ')}`,
    `${pct(sum(mix.low), all)}% under 150 Hz, ${lowMidPct}% 150-500 Hz, ${highPct}% over 4 kHz`,
    ...(pumpDb !== null ? [`pump ${pumpDb} dB`] : []),
    ...(clashes.length ? [`${clashes.length} low-end clash${clashes.length > 1 ? 'es' : ''}`] : []),
  ].join('; ');
  return { heard, parts: partsOut, sections, clashes, pumpDb, improve };
}
