import type { AudioEvent, MediaScan, PaletteColor, ReferenceFrame } from '@shared/references';
import { clock } from '@shared/references';

/**
 * Which moments of a video become frames. A clip is read three ways: tiny pictures every half second or so
 * (scanned) find the cuts and the palette; frames are then taken spread evenly (about one a second, fewer on a
 * long clip), right after each cut, and at the loudest hits the sound measurement found, so an impact's frame
 * is the one at its sound. The study run is shown a budget of them, chosen to cover the clip and its key
 * moments; it can ask for the rest by time.
 */

export interface Signature {
  t: number;
  w: number;
  h: number;
  rgb: Uint8Array;
}

export function signatureOf(s: MediaScan): Signature {
  return { t: s.t, w: s.w, h: s.h, rgb: new Uint8Array(Buffer.from(s.rgb, 'base64')) };
}

/** 4×4×4 colour histogram (normalized). */
function histogram(sig: Signature): Float64Array {
  const h = new Float64Array(64);
  const n = Math.floor(sig.rgb.length / 3);
  for (let i = 0; i < n; i++) h[(sig.rgb[i * 3]! >> 6) * 16 + (sig.rgb[i * 3 + 1]! >> 6) * 4 + (sig.rgb[i * 3 + 2]! >> 6)]! += 1 / Math.max(1, n);
  return h;
}

/**
 * How different two scan pictures are (0..1): mostly the colour distribution (a camera sweeping across one
 * place keeps it, a cut changes it), partly the pixels themselves.
 */
export function difference(a: Signature, b: Signature): number {
  const ha = histogram(a);
  const hb = histogram(b);
  let tv = 0;
  for (let i = 0; i < 64; i++) tv += Math.abs(ha[i]! - hb[i]!);
  tv /= 2;
  let px = 0;
  const n = Math.min(a.rgb.length, b.rgb.length);
  if (a.w === b.w && a.h === b.h && n) {
    for (let i = 0; i < n; i += 3) {
      const ya = 0.299 * a.rgb[i]! + 0.587 * a.rgb[i + 1]! + 0.114 * a.rgb[i + 2]!;
      const yb = 0.299 * b.rgb[i]! + 0.587 * b.rgb[i + 1]! + 0.114 * b.rgb[i + 2]!;
      px += Math.abs(ya - yb);
    }
    px /= (n / 3) * 255;
  } else px = tv;
  return 0.65 * tv + 0.35 * Math.min(1, px * 2);
}

/**
 * Scene changes: a jump between neighbouring scan pictures that is a peak of its own, well above what the clip
 * usually moves (median + 4 × its spread) and big in itself; at least a second apart. The time is the first
 * scan picture of the new scene.
 */
export function sceneCuts(sigs: Signature[], minGap = 1): Array<{ t: number; strength: number }> {
  if (sigs.length < 3) return [];
  const d = sigs.slice(1).map((s, i) => difference(sigs[i]!, s));
  const sorted = [...d].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  const mad = [...d].map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(d.length / 2)]!;
  const thr = Math.max(0.22, med + 4 * Math.max(mad, 0.01));
  const cuts: Array<{ t: number; strength: number }> = [];
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!;
    if (v < thr || v < (d[i - 1] ?? 0) || v < (d[i + 1] ?? 0)) continue;
    const t = sigs[i + 1]!.t;
    const last = cuts[cuts.length - 1];
    if (last && t - last.t < minGap) {
      if (v > last.strength) cuts[cuts.length - 1] = { t, strength: Math.round(v * 100) / 100 };
      continue;
    }
    cuts.push({ t, strength: Math.round(v * 100) / 100 });
  }
  return cuts;
}

export interface FramePlanInput {
  duration: number;
  cuts: Array<{ t: number; strength: number }>;
  /** Loud moments (strongest first is not needed: they are ranked here). */
  sounds: Array<{ t: number; score: number }>;
  max: number;
}

const round2 = (t: number) => Math.round(t * 100) / 100;

/**
 * The frames to take: up to 30% after cuts and 20% at loud hits (the strongest of each), the rest spread
 * evenly (one a second when the clip is short enough, else farther apart); an even frame within 0.35 s of a
 * chosen moment is left out, and the total never exceeds `max`.
 */
export function planFrames(input: FramePlanInput): Array<{ t: number; why: ReferenceFrame['why'] }> {
  const { duration, max } = input;
  const end = Math.max(0, duration - 0.08);
  const clampT = (t: number) => round2(Math.max(0, Math.min(end, t)));
  const priority: Array<{ t: number; why: 'scene' | 'sound'; w: number }> = [];
  const take = <T extends { t: number }>(items: T[], score: (x: T) => number, cap: number, why: 'scene' | 'sound') => {
    for (const x of [...items].sort((a, b) => score(b) - score(a))) {
      if (priority.filter((p) => p.why === why).length >= cap) break;
      const t = clampT(x.t);
      if (priority.some((p) => Math.abs(p.t - t) < 0.2)) continue;
      priority.push({ t, why, w: score(x) });
    }
  };
  take(input.cuts, (c) => c.strength, Math.floor(max * 0.3), 'scene');
  take(input.sounds, (s) => s.score, Math.floor(max * 0.2), 'sound');
  const evenCount = Math.max(1, max - priority.length);
  const step = Math.max(1, duration / evenCount);
  const even: number[] = [];
  for (let t = 0; t <= end + 1e-9 && even.length < evenCount; t += step) even.push(clampT(t));
  const all: Array<{ t: number; why: ReferenceFrame['why'] }> = [...priority.map((p) => ({ t: p.t, why: p.why }))];
  for (const t of even) if (!priority.some((p) => Math.abs(p.t - t) < 0.35)) all.push({ t, why: 'even' });
  all.sort((a, b) => a.t - b.t);
  // Over the cap: drop the even frame whose neighbours are closest, again and again.
  while (all.length > max) {
    let worst = -1;
    let gap = Infinity;
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.why !== 'even') continue;
      const g = (all[i + 1]?.t ?? Infinity) - (all[i - 1]?.t ?? -Infinity);
      if (g < gap) {
        gap = g;
        worst = i;
      }
    }
    if (worst < 0) all.splice(all.length - 1, 1);
    else all.splice(worst, 1);
  }
  return all;
}

/**
 * The frames the study run is shown: the key moments first (sound and scene frames, up to half the budget,
 * those nearest the loudest hits first), then the frames that best fill the remaining gaps in time.
 */
export function pickForStudy<F extends { t: number; why: ReferenceFrame['why'] }>(frames: F[], budget: number, events: Array<{ t: number; peakDb: number }> = []): F[] {
  if (frames.length <= budget) return frames;
  const chosen = new Set<F>();
  const loudness = (f: F) => Math.max(-200, ...events.filter((e) => Math.abs(e.t - f.t) < 0.3).map((e) => e.peakDb));
  const keys = frames.filter((f) => f.why === 'sound' || f.why === 'scene').sort((a, b) => loudness(b) - loudness(a) || (a.why === 'sound' ? -1 : 1));
  for (const f of keys.slice(0, Math.floor(budget / 2))) chosen.add(f);
  // Fill the biggest gaps: each time, the frame farthest from every chosen one (the first frame to start from).
  if (!chosen.size) chosen.add(frames[0]!);
  while (chosen.size < budget) {
    let best: F | null = null;
    let far = -1;
    for (const f of frames) {
      if (chosen.has(f)) continue;
      let near = Infinity;
      for (const c of chosen) near = Math.min(near, Math.abs(c.t - f.t));
      if (near > far) {
        far = near;
        best = f;
      }
    }
    if (!best) break;
    chosen.add(best);
  }
  return frames.filter((f) => chosen.has(f));
}

/** The stored frame nearest a time (and how far it is). */
export function nearestFrame(t: number, frames: ReferenceFrame[]): { t: number; file: string; dt: number } | null {
  let best: ReferenceFrame | null = null;
  for (const f of frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best ? { t: best.t, file: best.file, dt: round2(best.t - t) } : null;
}

/** Every loud hit with the frame nearest to it. */
export function alignEvents(events: AudioEvent[], frames: ReferenceFrame[]): AudioEvent[] {
  return events.map((e) => ({ ...e, frame: nearestFrame(e.t, frames) }));
}

/**
 * The colours a clip or picture is made of: pixels binned 5 bits a channel, the biggest bins merged with
 * their near neighbours (within 40 in RGB), the main ones with their share. Up to `max`, each at least 2%.
 */
export function palette(images: Array<{ rgb: Uint8Array }>, max = 8): PaletteColor[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (const img of images) {
    const n = Math.floor(img.rgb.length / 3);
    for (let i = 0; i < n; i++) {
      const r = img.rgb[i * 3]!;
      const g = img.rgb[i * 3 + 1]!;
      const b = img.rgb[i * 3 + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
      total++;
    }
  }
  if (!total) return [];
  const groups: Array<{ n: number; r: number; g: number; b: number }> = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    const c = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
    const g = groups.find((x) => Math.hypot(x.r / x.n - c[0]!, x.g / x.n - c[1]!, x.b / x.n - c[2]!) < 40);
    if (g) {
      g.n += bin.n;
      g.r += bin.r;
      g.g += bin.g;
      g.b += bin.b;
    } else groups.push({ ...bin });
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return groups
    .sort((a, b) => b.n - a.n)
    .filter((g) => g.n / total >= 0.02)
    .slice(0, max)
    .map((g) => ({ hex: `#${hex(g.r / g.n)}${hex(g.g / g.n)}${hex(g.b / g.n)}`, share: Math.round((g.n / total) * 100) / 100 }));
}

/** What the frames cover, in words. */
export function coverageLine(duration: number, frames: Array<{ t: number; why: ReferenceFrame['why'] }>): string {
  const even = frames.filter((f) => f.why === 'even').length;
  const scene = frames.filter((f) => f.why === 'scene').length;
  const sound = frames.filter((f) => f.why === 'sound').length;
  const step = duration / Math.max(1, frames.length);
  const parts = [`${even} spread evenly`];
  if (scene) parts.push(`${scene} right after cuts`);
  if (sound) parts.push(`${sound} at loud hits`);
  return `${frames.length} frames over ${clock(duration)}, about one every ${step < 1.5 ? `${step.toFixed(1)} s` : `${Math.round(step)} s`}: ${parts.join(', ')}. Motion between frames is not seen.`;
}
