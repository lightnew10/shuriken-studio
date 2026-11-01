import type { EffectSpec, TrackSpec } from '@shared/effects';
import { add, arc, catmullRom, hexToRgb, len, mul, polyline, sampleCurve, spiral, type Vec3 } from '@shared/curves';
import { compileEffect, type CompiledEmitter } from './compile';

/**
 * What an effect costs and how it reads, measured offline from its data the way ShurikenEffects plays it:
 * how long it lasts, how many particles (per quality level), parts, lights and beams, where it reaches
 * (bounds, for the runtime's culling radius), how much of the screen it fills from a fighting distance
 * (20 studs, further for effects that reach further) and how opaque its centre gets, when its impact
 * lands, and what a VFX artist would flag. (How it looks is measured on its picture: see render.ts.)
 * Particle motion follows Roblox's rules: speed halves `drag` times a second, acceleration in studs/s²,
 * sizes and transparencies over each particle's life.
 */
export interface EffectMeasure {
  /** Seconds until the last particle, part or light is gone (persistent effects: one cycle). */
  duration: number;
  particles: { perPlay: number; peakAlive: number; steady: number | null; byQuality: { low: number; medium: number; high: number } };
  parts: number;
  lights: number;
  beams: number;
  highlights: number;
  bounds: { center: Vec3; size: Vec3; radius: number };
  /** Share of a 70° view filled at `at` studs (overlaps count again), when it peaks, and the centre's opacity then. */
  coverage: { at: number; peak: number; when: number; centerOpacity: number };
  /** The first bright beat (flash, light, short glowing burst), and when it has settled to a tenth of its peak. */
  timing: { impactAt: number | null; impactBy: string | null; settleAt: number };
  warnings: string[];
  /** All of it in one line. */
  line: string;
}

const QUALITY = { low: 0.35, medium: 0.7, high: 1 } as const;
/** Where a fight is watched from; an effect that reaches further is judged from where it is in view. */
const VIEW_DISTANCE = 20;
/** A soft particle texture covers about this share of its square. */
const FILL = 0.45;
const DIRS: Record<string, Vec3> = { Top: [0, 1, 0], Bottom: [0, -1, 0], Front: [0, 0, -1], Back: [0, 0, 1], Left: [-1, 0, 0], Right: [1, 0, 0] };

const rad = (d: number) => (d * Math.PI) / 180;
/** Rotates v by Euler degrees (x, then y, then z, like CFrame.Angles applied to a vector). */
function turn(v: Vec3, deg: Vec3 | undefined): Vec3 {
  if (!deg) return v;
  let [x, y, z] = v;
  const [ax, ay, az] = deg.map(rad) as Vec3;
  // CFrame.Angles(rx, ry, rz) = Rx * Ry * Rz: apply Rz, then Ry, then Rx.
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  return [x, y, z];
}

const keyAt = (keys: Array<[number, number]>, t: number): number => {
  if (!keys.length) return 0;
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i]!;
    const [t1, v1] = keys[i + 1]!;
    if (t <= t1) return v0 + (v1 - v0) * (t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  }
  return keys[keys.length - 1]![1];
};

/** Distance travelled after `t` s at speed v0 with `drag` halvings a second. */
const travelled = (v0: number, drag: number, t: number) => (drag > 0 ? (v0 * (1 - 2 ** (-drag * t))) / (drag * Math.LN2) : v0 * t);

/** Relative luminance (0 black .. 1 white) of an sRGB hex colour. */
export function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

interface Box {
  min: Vec3;
  max: Vec3;
}
const grow = (b: Box, p: Vec3, r = 0) => {
  for (let i = 0; i < 3; i++) {
    b.min[i] = Math.min(b.min[i]!, p[i]! - r);
    b.max[i] = Math.max(b.max[i]!, p[i]! + r);
  }
};

/** Sample directions in a cone of half-angle `spread` around `dir`. */
function coneDirections(dir: Vec3, spread: number): Vec3[] {
  const s = Math.min(180, Math.max(0, spread));
  const out: Vec3[] = [dir];
  // A frame around dir.
  const up: Vec3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: Vec3) => mul(a, 1 / (len(a) || 1));
  const u = norm(cross(dir, up));
  const w = norm(cross(dir, u));
  for (const polar of [s / 2, s]) {
    if (polar <= 0) continue;
    for (let k = 0; k < 8; k++) {
      const az = (k / 8) * 2 * Math.PI;
      const p = rad(polar);
      out.push(add(add(mul(dir, Math.cos(p)), mul(u, Math.sin(p) * Math.cos(az))), mul(w, Math.sin(p) * Math.sin(az))));
    }
  }
  return out;
}

interface EmitterSim {
  m: CompiledEmitter;
  count: number; // per play (bursts) or steady (persistent)
  start: number;
  end: number; // last particle gone
  lifeMean: number;
  /** How far its particles typically get from where the effect plays (mean speed and life, their size included). */
  reach: number;
  /** The area (studs², seen from the side) the cloud covers at an age, at the mean speed. */
  areaAt: (age: number, size: number) => number;
}

function simulate(m: CompiledEmitter, persistent: boolean, box: Box): EmitterSim {
  const dir = turn(DIRS[m.direction ?? 'Top'] ?? [0, 1, 0], m.turn);
  const offset: Vec3 = m.offset ?? [0, 0, 0];
  const spread = Math.max(m.spread?.[0] ?? 0, m.spread?.[1] ?? 0);
  const accel: Vec3 = m.acceleration ?? [0, 0, 0];
  const drag = m.drag ?? 0;
  const [lmin, lmax] = m.lifetime;
  const maxSize = Math.max(...m.size.map(([, v]) => v), 0);
  const dirs = coneDirections(dir, spread);
  for (const v0 of [m.speed[0], m.speed[1]]) {
    for (const d of dirs) {
      for (let i = 0; i <= 8; i++) {
        const t = (lmax * i) / 8;
        const p = add(add(offset, mul(d, travelled(v0, drag, t))), mul(accel, 0.5 * t * t));
        grow(box, p, maxSize / 2);
      }
    }
  }
  const streaming = persistent || !!m.for;
  const count = streaming ? Math.round((m.rate ?? 0) * (persistent ? (lmin + lmax) / 2 : (m.for ?? 0))) : (m.emit ?? 0);
  const vMean = (m.speed[0] + m.speed[1]) / 2;
  return {
    m,
    count,
    start: m.delay,
    end: m.delay + (m.for ?? 0) + lmax,
    lifeMean: (lmin + lmax) / 2,
    reach: len(add(offset, add(mul(dir, travelled(vMean, drag, (lmin + lmax) / 2)), mul(accel, 0.5 * ((lmin + lmax) / 2) ** 2)))) + maxSize / 2,
    // A cone is a long thin cloud seen from the side; a wide spread a ball of particles.
    areaAt: (age, size) => {
      const d = len(add(mul(dir, travelled(vMean, drag, age)), mul(accel, 0.5 * age * age)));
      if (spread >= 90) return Math.PI * Math.max(d, size / 2) ** 2;
      return Math.PI * (d / 2 + size / 2) * (d * Math.sin(rad(Math.max(spread, 2))) + size / 2);
    },
  };
}

/** Particles of an emitter alive at time t, with their (mean) age. */
function aliveAt(s: EmitterSim, t: number, persistent: boolean): { n: number; age: number } {
  const [lmin, lmax] = s.m.lifetime;
  if (persistent) return { n: s.count, age: s.lifeMean / 2 };
  const age = t - s.start;
  if (age < 0) return { n: 0, age: 0 };
  if (s.m.for) {
    // Streaming for a while: particles of every age up to the lifetime.
    const emitting = Math.min(age, s.m.for);
    const oldest = Math.min(age, lmax);
    const n = (s.m.rate ?? 0) * Math.max(0, Math.min(emitting, oldest - Math.max(0, age - s.m.for)));
    return { n, age: oldest / 2 };
  }
  const frac = lmax > lmin ? Math.min(1, Math.max(0, (lmax - age) / (lmax - lmin))) : age <= lmax ? 1 : 0;
  return { n: s.count * frac, age };
}

function trackBounds(t: TrackSpec, box: Box): void {
  const o: Vec3 = t.offset ?? [0, 0, 0];
  const maxOf = (c: unknown, d: number) => (c === undefined ? d : Math.max(...Array.from({ length: 11 }, (_, i) => sampleCurve(c as never, i / 10))));
  switch (t.type) {
    case 'shell': {
      const size: Vec3 = t.size ?? [4, 4, 4];
      grow(box, o, (Math.max(...size) * maxOf(t.scale, 1)) / 2);
      break;
    }
    case 'circle':
      grow(box, o, maxOf(t.radius, 8));
      break;
    case 'ribbon': {
      const p = t.path;
      const path = p.kind === 'arc' ? arc(p.radius, p.from, p.to) : p.kind === 'spiral' ? spiral(p.r0, p.r1, p.turns, p.height) : p.kind === 'orbit' ? spiral(p.radius, p.radius, p.turns ?? 1, p.height ?? 0) : p.kind === 'points' ? (p.smooth === false ? polyline(p.points) : catmullRom(p.points)) : polyline([p.from, p.to]);
      for (let i = 0; i <= 16; i++) grow(box, add(o, turn(path.at(i / 16), t.rotation)), (t.width ?? 1.5) / 2);
      break;
    }
    case 'beam': {
      grow(box, add(o, t.from ?? [0, 0, 0]), 0.5);
      if (Array.isArray(t.to)) grow(box, t.to, 0.5);
      break;
    }
    case 'debris': {
      const v = t.speed?.[1] ?? 40;
      const g = t.gravity ?? 120;
      grow(box, add(o, [0, (v * v) / (2 * g), 0]), 0);
      grow(box, o, Math.min((v * v) / g, v * (t.lifetime?.[1] ?? 2)));
      break;
    }
    case 'decal': {
      const s = typeof t.size === 'number' ? [t.size, t.size] : (t.size ?? [8, 8]);
      grow(box, o, Math.max(s[0]!, s[1]!) / 2);
      break;
    }
    default:
      break;
  }
}

const trackEnd = (t: TrackSpec) => (t.at ?? 0) + (t.type === 'ribbon' ? (t.duration ?? 0.3) + (t.trail?.lifetime ?? 0.25) : t.type === 'debris' ? (t.lifetime?.[1] ?? 2) : ['sound', 'shake', 'hitstop', 'screen', 'spawn'].includes(t.type) ? 0 : (t.duration ?? 0.3));

const HITLIKE = /hit|impact|spark|punch|slash|block|parry|clash|strike|land/i;

export function measureEffect(e: EffectSpec): EffectMeasure {
  const persistent = e.kind === 'persistent';
  const { emitters, tracks } = compileEffect(e);
  const box: Box = { min: [0, 0, 0], max: [0, 0, 0] };
  const sims = emitters.map((m) => simulate(m, persistent, box));
  for (const t of tracks) trackBounds(t, box);
  if (e.kind === 'trail' || e.kind === 'beam') grow(box, [0, 0, 0], 2);

  const lightsInTracks = tracks.filter((t) => t.type === 'light').length;
  const lights = lightsInTracks + (e.light ? 1 : 0);
  const parts =
    tracks.reduce((n, t) => n + (t.type === 'shell' || t.type === 'decal' || t.type === 'ribbon' ? 1 : t.type === 'debris' ? (t.count ?? 6) : 0), 0);
  const beams = tracks.reduce((n, t) => n + (t.type === 'beam' ? (t.jag ? Math.min(24, Math.max(2, t.jag.segments ?? 8)) : 1) : t.type === 'circle' ? 4 : 0), 0) + (e.kind === 'beam' ? 1 : 0);
  const highlights = tracks.filter((t) => t.type === 'highlight').length;

  const ends = [...sims.map((s) => s.end), ...tracks.map(trackEnd), e.light ? e.light.duration : 0];
  const duration = persistent ? Math.max(1, ...sims.map((s) => s.m.lifetime[1]), ...tracks.map(trackEnd)) : Math.max(e.duration ?? 0, ...ends, 0);

  const perPlay = sims.reduce((n, s) => n + (persistent ? 0 : s.count), 0);
  const byQuality = { low: 0, medium: 0, high: 0 };
  for (const q of Object.keys(QUALITY) as Array<keyof typeof QUALITY>) byQuality[q] = sims.reduce((n, s) => n + (s.count ? Math.max(1, Math.round(s.count * QUALITY[q])) : 0), 0);

  const size: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const center: Vec3 = [(box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2];
  const radius = Math.max(0.5, len(size) / 2);
  // Coverage and centre opacity over time, with a 70° vertical field of view (16:9), from 20 studs. What
  // typically reaches past the view there (14 studs: a wave, a long beam) is an area effect by design, and
  // is judged from where it fits the view.
  const trackBox: Box = { min: [0, 0, 0], max: [0, 0, 0] };
  for (const t of tracks) trackBounds(t, trackBox);
  const typical = Math.max(0, ...sims.map((s) => s.reach), len([Math.max(-trackBox.min[0], trackBox.max[0]), Math.max(-trackBox.min[1], trackBox.max[1]), Math.max(-trackBox.min[2], trackBox.max[2])]));
  const viewDistance = typical <= 14 ? VIEW_DISTANCE : Math.round((typical * 1.5) / 5) * 5;
  const screenH = 2 * viewDistance * Math.tan(rad(35));
  const screenArea = screenH * screenH * (16 / 9);
  let peak = 0;
  let when = 0;
  let centerAtPeak = 0;
  let peakAlive = 0;
  const step = 1 / 30;
  const coverageAt: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) {
    let cov = 0;
    let clear = 1;
    let alive = 0;
    for (const s of sims) {
      const { n, age } = aliveAt(s, t, persistent);
      if (n <= 0) continue;
      alive += n;
      const lifeFrac = Math.min(1, age / Math.max(s.lifeMean, 1e-3));
      const size = keyAt(s.m.size, lifeFrac);
      const opacity = 1 - Math.min(1, Math.max(0, keyAt(s.m.transparency, lifeFrac)));
      cov += (n * size * size * FILL * opacity) / screenArea;
      const layers = n * Math.min(1, (size * size * FILL) / Math.max(s.areaAt(age, size), 1e-3));
      clear *= (1 - opacity * 0.85) ** layers;
    }
    for (const tr of tracks) {
      if (tr.type !== 'shell') continue;
      const start = tr.at ?? 0;
      const d = tr.duration ?? 0.3;
      if (t < start || t > start + d) continue;
      const k = (t - start) / d;
      const size = Math.max(...(tr.size ?? [4, 4, 4])) * sampleCurve(tr.scale, k, 1);
      const opacity = 1 - Math.min(1, Math.max(0, sampleCurve(tr.transparency ?? [0, 1], k)));
      cov += (size * size * 0.78 * opacity) / screenArea;
      clear *= 1 - opacity;
    }
    coverageAt.push(cov);
    peakAlive = Math.max(peakAlive, alive);
    if (cov > peak) {
      peak = cov;
      when = t;
      centerAtPeak = 1 - clear;
    }
  }
  const settleIndex = coverageAt.findIndex((c, i) => i * step > when && c < peak * 0.1);
  const settleAt = settleIndex >= 0 ? settleIndex * step : duration;

  // The impact beat: the first flash, light, glowing shell or short bright burst.
  const beats: Array<{ at: number; by: string }> = [];
  for (const s of sims) if ((s.m.lightEmission ?? 0) >= 0.7 && s.m.lifetime[1] <= 0.3 && Math.max(...s.m.size.map(([, v]) => v)) >= 1) beats.push({ at: s.start, by: s.m.name });
  for (const t of tracks) if (t.type === 'light' || (t.type === 'shell' && (t.material ?? 'Neon') === 'Neon') || (t.type === 'screen' && t.fx === 'flash')) beats.push({ at: t.at ?? 0, by: t.name ?? t.type });
  if (e.light) beats.push({ at: 0, by: 'light' });
  beats.sort((a, b) => a.at - b.at);
  const impact = beats[0] ?? null;

  const warnings: string[] = [];
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  for (const s of sims) {
    const m = s.m;
    const lightness = Math.max(...m.color.map(([, c]) => luminance(c)));
    const opaque = 1 - (m.transparency[0]?.[1] ?? 0);
    const big = Math.max(...m.size.map(([, v]) => v));
    if ((m.lightInfluence ?? 0) >= 0.5 && (m.lightEmission ?? 0) < 0.3 && lightness < 0.12 && opaque > 0.45 && big >= 2 && s.count >= 4) {
      warnings.push(`${m.name}: dark (${m.color.map(([, c]) => c).join(' ')}) and only ${Math.round((1 - opaque) * 100)}% transparent, ${s.count} puffs up to ${r1(big)} studs pile up into an opaque black blob (scene lighting darkens it further: LightInfluence ${m.lightInfluence}). Lighten it to a mid grey (#8a8178 or lighter), start at transparency ≥ 0.55, or use fewer, smaller puffs.`);
    }
    if ((m.lightEmission ?? 0) >= 0.7 && lightness < 0.06) warnings.push(`${m.name}: LightEmission ${m.lightEmission} adds its colour to what's behind it, and ${m.color[0]![1]} adds almost nothing: use a bright colour, or LightEmission 0 for dark matter (smoke, soot).`);
    if ((m.brightness ?? 1) > 1 && (m.lightInfluence ?? 0) >= 1) warnings.push(`${m.name}: Brightness only lifts particles whose LightInfluence is below 1.`);
    if (m.flipbook && m.flipbook.mode === 'OneShot' && m.lifetime[1] - m.lifetime[0] > m.lifetime[1] * 0.5) warnings.push(`${m.name}: a OneShot flipbook plays over each particle's own lifetime, so lifetimes ${m.lifetime[0]}–${m.lifetime[1]} s play it at very different speeds.`);
  }
  if (!persistent && HITLIKE.test(e.name) && duration > 1.5) warnings.push(`${r1(duration)} s is long for a hit that repeats: players stop seeing the next one. Keep the impact under 0.3 s and the whole effect near 1 s.`);
  if (!persistent && HITLIKE.test(e.name) && impact && impact.at > 0.05) warnings.push(`The first bright beat (${impact.by}) comes at ${r2(impact.at)} s: a hit should flash on the frame it lands.`);
  if (!persistent && perPlay > 200) warnings.push(`${perPlay} particles per play is heavy for phones (low quality draws ${byQuality.low}); 40–120 reads as well.`);
  if (persistent && peakAlive > 150) warnings.push(`About ${Math.round(peakAlive)} particles alive at once, all the time: heavy for an effect that stays on (keep auras under ~60).`);
  if (peak > 0.6) warnings.push(`At its peak it fills ${pct(Math.min(peak, 1))}${peak > 1 ? ' and more' : ''} of the view from ${viewDistance} studs: players lose sight of the fight. Smaller or fewer particles, or more transparent.`);
  // Seen from across a map, particles alone don't show: agents measured in the user's builds that Roblox stops
  // drawing them somewhere between 200 and 400 studs from the camera at automatic graphics quality.
  if (viewDistance >= 200 && sims.length && !tracks.some((t) => t.type === 'shell' || t.type === 'beam' || t.type === 'circle' || t.type === 'light')) {
    warnings.push(`It reaches ${r1(typical)} studs and is watched from about ${viewDistance}, and it is made of particles only: Roblox stops drawing particles somewhere between 200 and 400 studs from the camera (automatic graphics quality). Add a layer that isn't particles (a shell, a beam, a circle, a light) so it still shows from far.`);
  }
  // An effect that stays on runs its emitters on rate: a particle track with only an emit count never fires.
  if (persistent) {
    const silent = sims.filter((s) => !(s.m.rate! > 0)).map((s) => s.m.name);
    if (silent.length) warnings.push(`${silent.join(', ')}: in an effect that stays on, particles need a rate (emit only fires in a burst), so ${silent.length > 1 ? 'these never show' : 'this never shows'}. Give ${silent.length > 1 ? 'them' : 'it'} a rate, or play ${silent.length > 1 ? 'them' : 'it'} as a separate burst.`);
  }
  if (centerAtPeak > 0.92 && peak > 0.15) warnings.push(`Its centre is ${pct(centerAtPeak)} opaque at its peak: whatever is behind it disappears for a moment.`);
  if (lights > 2) warnings.push(`${lights} lights: lights cost the most on phones (low quality allows 2 at once).`);
  const brightLayers = sims.filter((s) => (s.m.lightEmission ?? 0) >= 0.7).length;
  if (sims.length >= 3 && brightLayers === sims.length && !tracks.some((t) => t.type === 'shell' && t.material !== 'Neon')) warnings.push('Every layer glows: with no darker layer (smoke, a core shadow, a dark ring) there is no value contrast and the bright part reads less. Add one.');
  for (const t of tracks) if (t.type === 'highlight' && (t.duration ?? 0.3) > 0.4) warnings.push(`${t.name ?? 'highlight'}: a hit flash longer than 0.4 s reads as a status, not a hit.`);

  const line = [
    `${r1(duration)} s${persistent ? ' per cycle' : ''}`,
    persistent ? `~${Math.round(peakAlive)} particles alive` : `${perPlay} particles (low ${byQuality.low} / medium ${byQuality.medium} / high ${byQuality.high}), peak ${Math.round(peakAlive)} alive`,
    parts ? `${parts} parts` : '',
    lights ? `${lights} light${lights > 1 ? 's' : ''}` : '',
    beams ? `${beams} beams` : '',
    `reaches ${r1(radius)} studs`,
    `fills ${pct(Math.min(peak, 1))} of the view at ${viewDistance} studs (centre ${pct(centerAtPeak)} opaque) at ${r1(when)} s`,
    impact ? `impact at ${r2(impact.at)} s (${impact.by}), settled by ${r2(settleAt)} s` : 'no bright impact beat',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    duration,
    particles: { perPlay, peakAlive: Math.round(peakAlive), steady: persistent ? Math.round(peakAlive) : null, byQuality },
    parts,
    lights,
    beams,
    highlights,
    bounds: { center: center.map(r1) as Vec3, size: size.map(r1) as Vec3, radius: r1(radius) },
    coverage: { at: viewDistance, peak: Math.round(peak * 1000) / 1000, when: r1(when), centerOpacity: Math.round(centerAtPeak * 100) / 100 },
    timing: { impactAt: impact ? r2(impact.at) : null, impactBy: impact?.by ?? null, settleAt: r2(settleAt) },
    warnings,
    line,
  };
}
