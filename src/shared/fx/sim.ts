import { arc, catmullRom, easer, hexToRgb, polyline, sampleColor, sampleCurve, spiral, type Path, type Vec3 } from '../curves';
import type { ColorCurve, Curve, Detail, EffectSpec, PathSpec, TrackSpec } from '../effects';
import { compileEffect, type CompiledEmitter } from './compile';
import { angles, anglesRad, I3, lookRotation, mapply, mmul, noise1, rad, seeded, vadd, vcross, vlen, vlerp, vmul, vnorm, vsub, xf, xfMul, xfPoint, type Mat3, type Xf } from './math';

/**
 * Plays an effect offline exactly as the generated ShurikenEffects module plays it in the game: the same
 * compiled data (emitters + timeline tracks), the same rules (Roblox's ParticleEmitter motion, each
 * track's curves over its duration, looping tracks of persistent effects, spawned effects). It draws
 * nothing itself: `frame()` describes what is on screen now (sprites, strips, solids, decals, lights,
 * screen cues), and the renderers (the three.js preview, the core's software rasteriser for contact
 * sheets) turn that into triangles with `tessellate`. One player, so the preview and the picture an agent
 * looks at can never disagree about what an effect does.
 *
 * Space: studs, x right, y up, -z forward (Roblox's). The effect plays at `opts.at` (the origin by default),
 * facing -z.
 */

export interface SimOptions {
  /** The same seed plays the same effect (default 1). */
  seed?: number;
  /** The quality level it plays at (default high: every layer, full counts). */
  quality?: Detail;
  /** opts.scale of Effects.play. */
  scale?: number;
  /** Where it plays (default: the origin). */
  at?: Vec3;
  /** The height of the ground (debris bounces on it, decals lie on it); none by default. */
  floor?: number;
  /** A character stands where the effect plays: highlight and hit-stop tracks act on it. */
  target?: boolean;
  /** The game's other effects, for spawn tracks. */
  resolve?: (name: string) => EffectSpec | null | undefined;
}

export interface FxSprite {
  p: Vec3;
  v: Vec3;
  size: number;
  /** Radians. */
  rot: number;
  color: Vec3;
  alpha: number;
  squash: number;
  /** Flipbook cell (0 when the texture is one image). */
  cell: number;
}

/** One emitter's live particles: camera-facing quads, oriented per its ParticleOrientation. */
export interface FxSprites {
  kind: 'sprites';
  name: string;
  tex: string;
  /** Flipbook cells per side (1 = one image). */
  grid: number;
  /** LightEmission: 0 blends normally, 1 adds onto what is behind it. */
  emission: number;
  /** LightInfluence: how much scene lighting shades it. */
  lit: number;
  mode: 'FacingCamera' | 'FacingCameraWorldUp' | 'VelocityParallel' | 'VelocityPerpendicular';
  zOffset: number;
  at: Vec3;
  items: FxSprite[];
}

export interface FxRow {
  p: Vec3;
  /** Half the width here (studs). */
  half: number;
  /** The direction the width runs (a fixed ribbon); absent: the strip turns to face the camera. */
  side?: Vec3;
  color: Vec3;
  alpha: number;
  /** Texture coordinate along the strip. */
  u: number;
}

/** Beams, lightning, circles, ribbons and trails: strips of quads through rows of points. */
export interface FxStrips {
  kind: 'strips';
  name: string;
  tex?: string;
  emission: number;
  zOffset: number;
  at: Vec3;
  strips: FxRow[][];
}

export interface FxSolid {
  shape: 'sphere' | 'cylinder' | 'block' | 'wedge';
  p: Vec3;
  r: Mat3;
  /** A Roblox part's size (a cylinder's length is x, a ball's diameter its smallest side). */
  size: Vec3;
  color: Vec3;
  alpha: number;
  material: string;
}

export interface FxSolids {
  kind: 'solids';
  name: string;
  at: Vec3;
  items: FxSolid[];
}

export interface FxDecal {
  kind: 'decal';
  name: string;
  tex: string;
  p: Vec3;
  r: Mat3;
  /** Studs along the part's x and z. */
  size: [number, number];
  color: Vec3;
  alpha: number;
  at: Vec3;
}

export type FxLayer = FxSprites | FxStrips | FxSolids | FxDecal;

export interface FxLight {
  p: Vec3;
  color: Vec3;
  brightness: number;
  range: number;
}

export interface FxScreen {
  fx: string;
  color: Vec3;
  /** How strongly it shows right now (0..1). */
  alpha: number;
  text?: string;
}

export interface FxFrame {
  t: number;
  layers: FxLayer[];
  lights: FxLight[];
  screens: FxScreen[];
  /** Camera shake right now, in degrees. */
  shake: number;
  /** The Highlight on the target, when one flashes. */
  highlight: { color: Vec3; fill: number; outlineColor: Vec3; outline: number } | null;
  /** The target's animations are frozen (hit-stop). */
  hitstop: boolean;
  /** Tracks that fired since the last frame and draw nothing here: sounds, hit-stop, spawned effects. */
  cues: Array<{ type: string; label: string; at: number }>;
}

const RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
const QUALITY: Record<string, number> = { low: 0.35, medium: 0.7, high: 1 };
const FACES: Record<string, Vec3> = { Top: [0, 1, 0], Bottom: [0, -1, 0], Front: [0, 0, -1], Back: [0, 0, 1], Left: [-1, 0, 0], Right: [1, 0, 0] };
const GRID: Record<string, number> = { Grid2x2: 2, Grid4x4: 4, Grid8x8: 8 };
/** The most particles one emitter keeps alive here (Roblox draws far more; a preview doesn't need them). */
const MAX_PARTICLES = 900;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** ShurikenEffects' vec(): a table of numbers, missing ones 0. */
const vec = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) && typeof v[0] === 'number' ? [v[0], num(v[1], 0), num(v[2], 0)] : d);
const hex = (v: unknown, d: Vec3): Vec3 => (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v) ? hexToRgb(v) : d);

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
const colorAt = (keys: Array<[number, Vec3]>, t: number): Vec3 => {
  if (!keys.length) return [1, 1, 1];
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, c0] = keys[i]!;
    const [t1, c1] = keys[i + 1]!;
    if (t <= t1) return vlerp(c0, c1, t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  }
  return keys[keys.length - 1]![1];
};

interface Particle {
  p: Vec3;
  v: Vec3;
  age: number;
  life: number;
  rot: number;
  spin: number;
  cell0: number;
  fps: number;
  id: number;
}

interface Ctx {
  base: Xf;
  scale: number;
  /** The quality level's share of particles and debris. */
  countScale: number;
  persistent: boolean;
  floor: number;
  target: boolean;
  rand: () => number;
}

/** One ParticleEmitter on its attachment. */
class Emitter {
  readonly parts: Particle[] = [];
  private carry = 0;
  private fired = false;
  private readonly origin: Vec3;
  private readonly axis: [Vec3, Vec3, Vec3];
  private readonly sizes: Array<[number, number]>;
  private readonly colors: Array<[number, Vec3]>;
  private readonly cells: number;
  private made = 0;
  enabled = true;

  constructor(
    readonly m: CompiledEmitter,
    private readonly ctx: Ctx,
    private readonly countScale: number,
  ) {
    // An emitter with an offset or turn sits on its own attachment (its offset is not scaled by opts.scale).
    const place = xfMul(ctx.base, xf(m.offset ?? [0, 0, 0], angles(m.turn)));
    this.origin = place.p;
    const n = FACES[m.direction ?? 'Top'] ?? FACES.Top!;
    const u: Vec3 = Math.abs(n[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
    const w = vcross(u, n);
    this.axis = [mapply(place.r, n), mapply(place.r, u), mapply(place.r, w)];
    this.sizes = m.size.map(([t, v]) => [t, v * ctx.scale]);
    this.colors = m.color.map(([t, c]) => [t, hexToRgb(c)]);
    this.cells = m.flipbook ? (GRID[m.flipbook.layout] ?? 1) ** 2 : 1;
  }

  /** Where it stops by itself: its last particle is gone and it will make no more. */
  get spent(): boolean {
    if (this.parts.length) return false;
    return !this.enabled || (!this.ctx.persistent && this.fired);
  }

  private emit(count: number): void {
    const { m, ctx } = this;
    const r = ctx.rand;
    const [n, u, w] = this.axis;
    const sx = rad(m.spread?.[0] ?? 0);
    const sy = rad(m.spread?.[1] ?? m.spread?.[0] ?? 0);
    for (let k = 0; k < count && this.parts.length < MAX_PARTICLES; k++) {
      const ax = (r() * 2 - 1) * sx;
      const ay = (r() * 2 - 1) * sy;
      // Tilt off the emission direction about its two side axes.
      const d = vadd(vmul(vadd(vmul(n, Math.cos(ay)), vmul(u, Math.sin(ay))), Math.cos(ax)), vmul(w, Math.sin(ax)));
      const speed = (m.speed[0] + (m.speed[1] - m.speed[0]) * r()) * ctx.scale;
      const fps = m.flipbook?.fps ?? [1, 1];
      this.parts.push({
        p: [this.origin[0], this.origin[1], this.origin[2]],
        v: vmul(d, speed),
        age: 0,
        life: Math.max(1e-3, m.lifetime[0] + (m.lifetime[1] - m.lifetime[0]) * r()),
        rot: rad((m.rotation?.[0] ?? 0) + ((m.rotation?.[1] ?? m.rotation?.[0] ?? 0) - (m.rotation?.[0] ?? 0)) * r()),
        spin: rad((m.rotSpeed?.[0] ?? 0) + ((m.rotSpeed?.[1] ?? m.rotSpeed?.[0] ?? 0) - (m.rotSpeed?.[0] ?? 0)) * r()),
        cell0: m.flipbook?.startRandom ? Math.floor(r() * this.cells) : 0,
        fps: fps[0] + ((fps[1] ?? fps[0]) - fps[0]) * r(),
        id: this.made++,
      });
    }
  }

  /** Moves the live particles on by dt, then makes the ones due by time t. */
  step(t: number, dt: number): void {
    const { m } = this;
    const sim = dt * (m.timeScale ?? 1);
    const drag = m.drag ? 0.5 ** (m.drag * sim) : 1;
    const acc = m.acceleration ? vmul(m.acceleration, this.ctx.scale * sim) : null;
    let alive = 0;
    for (const q of this.parts) {
      q.age += sim;
      if (q.age >= q.life) continue;
      q.v[0] = q.v[0] * drag + (acc ? acc[0] : 0);
      q.v[1] = q.v[1] * drag + (acc ? acc[1] : 0);
      q.v[2] = q.v[2] * drag + (acc ? acc[2] : 0);
      q.p[0] += q.v[0] * sim;
      q.p[1] += q.v[1] * sim;
      q.p[2] += q.v[2] * sim;
      q.rot += q.spin * sim;
      this.parts[alive++] = q;
    }
    this.parts.length = alive;
    this.due(t, dt);
  }

  /** Particles due at time t (dt = 0: the effect's first frame). */
  due(t: number, dt: number): void {
    const { m, ctx } = this;
    if (!this.enabled) return;
    if (ctx.persistent) {
      this.carry += (m.rate ?? 0) * this.countScale * dt;
    } else if (m.for) {
      // Streaming for a while: the part of this step inside [delay, delay + for].
      const overlap = Math.min(t, m.delay + m.for) - Math.max(t - dt, m.delay);
      if (overlap > 0) this.carry += (m.rate ?? 0) * this.countScale * overlap;
      if (t >= m.delay + m.for) this.fired = true;
    } else if (!this.fired && t >= m.delay - 1e-9) {
      this.fired = true;
      this.emit(Math.max(1, Math.round((m.emit ?? 0) * this.countScale)));
    }
    // (A hair over, so a rate × time that should come to a whole number does.)
    const n = Math.floor(this.carry + 1e-6);
    if (n > 0) {
      this.carry -= n;
      this.emit(n);
    }
  }

  layer(): FxSprites {
    const { m } = this;
    const items: FxSprite[] = [];
    const bright = (m.lightInfluence ?? 0) < 1 ? Math.max(0, m.brightness ?? 1) : 1;
    for (const q of this.parts) {
      const k = clamp01(q.age / q.life);
      const alpha = 1 - clamp01(keyAt(m.transparency, k));
      if (alpha <= 0) continue;
      const c = colorAt(this.colors, k);
      items.push({ p: q.p, v: q.v, size: keyAt(this.sizes, k), rot: q.rot, color: bright === 1 ? c : vmul(c, bright), alpha, squash: m.squash ? keyAt(m.squash, k) : 0, cell: this.cell(q, k) });
    }
    return {
      kind: 'sprites',
      name: m.name,
      tex: m.texture,
      grid: m.flipbook ? (GRID[m.flipbook.layout] ?? 1) : 1,
      emission: clamp01(m.lightEmission ?? 0),
      lit: clamp01(m.lightInfluence ?? 0),
      mode: m.orientation ?? 'FacingCamera',
      zOffset: m.zOffset ?? 0,
      at: this.origin,
      items,
    };
  }

  private cell(q: Particle, k: number): number {
    const n = this.cells;
    const f = this.m.flipbook;
    if (!f || n <= 1) return 0;
    const mode = f.mode ?? 'Loop';
    if (mode === 'OneShot') return Math.min(n - 1, Math.floor(k * n));
    const tick = Math.floor(q.cell0 + q.age * q.fps);
    if (mode === 'Random') return Math.floor((Math.abs(Math.sin((q.id + 1) * 12.9898 + tick * 78.233) * 43758.5453) % 1) * n);
    if (mode === 'PingPong') {
      const span = Math.max(1, 2 * n - 2);
      const i = tick % span;
      return i < n ? i : span - i;
    }
    return tick % n;
  }
}

/** What a running track does each step, and what it shows. */
interface Runner {
  update(t: number, dt: number): boolean;
  draw?(out: FxFrame): void;
}

const localXf = (track: TrackSpec, scale: number): Xf => xf(vmul(vec(track.offset, [0, 0, 0]), scale), angles(track.type === 'particles' ? undefined : track.rotation));

function progress(track: TrackSpec, ctx: Ctx, t: number): [number, boolean] {
  const duration = Math.max(num(track.duration, 0.3), 1e-3);
  if (ctx.persistent && track.loop) return [(t % duration) / duration, true];
  return [clamp01(t / duration), t < duration];
}

function pathOf(spec: PathSpec | undefined, scale: number): Path {
  const s = (spec ?? {}) as Record<string, unknown>;
  if (s.kind === 'spiral') return spiral(num(s.r0, 1) * scale, num(s.r1, 3) * scale, num(s.turns, 2), num(s.height, 6) * scale);
  if (s.kind === 'orbit') return spiral(num(s.radius, 3) * scale, num(s.radius, 3) * scale, num(s.turns, 1), num(s.height, 0) * scale);
  if (s.kind === 'points' && Array.isArray(s.points)) {
    const pts = (s.points as unknown[]).map((p) => vmul(vec(p, [0, 0, 0]), scale));
    return s.smooth === false ? polyline(pts) : catmullRom(pts);
  }
  if (s.kind === 'line') return polyline([vmul(vec(s.from, [0, 0, 0]), scale), vmul(vec(s.to, [0, 0, -10]), scale)]);
  return arc(num(s.radius, 4) * scale, num(s.from, 60), num(s.to, -60));
}

/** ShurikenCurves.lightning: a jagged line from a to b (ends fixed, wild in the middle). */
function lightning(a: Vec3, b: Vec3, segments: number, amplitude: number, seed: number): Vec3[] {
  const r = seeded(seed);
  const length = vlen(vsub(b, a));
  const dir = vnorm(vsub(b, a));
  const side = vnorm(vcross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]), [1, 0, 0]);
  const up = vnorm(vcross(side, dir));
  const pts: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const s = i / segments;
    let p = vlerp(a, b, s);
    if (i > 0 && i < segments) p = vadd(p, vmul(vadd(vmul(side, r() * 2 - 1), vmul(up, r() * 2 - 1)), amplitude * length * Math.sin(s * Math.PI)));
    pts.push(p);
  }
  return pts;
}

/** A beam's look along its length, shared by beam, lightning and circle tracks. */
function beamLook(track: Record<string, unknown>) {
  const color = (track.color ?? '#ffffff') as ColorCurve;
  const bright = Math.max(0, num(track.brightness, 1));
  return {
    color: (s: number): Vec3 => vmul(sampleColor(color, s), bright),
    emission: clamp01(num(track.lightEmission, 1)),
    tex: typeof track.texture === 'string' && track.texture ? track.texture : undefined,
    zOffset: num(track.zOffset, 0),
    /** Texture repeats along `length` studs, moved by TextureSpeed. */
    u: (s: number, length: number, t: number) => {
      const len = Math.max(num(track.textureLength, 1), 1e-3);
      const repeats = (track.textureMode ?? 'Stretch') === 'Stretch' ? len : length / len;
      return s * repeats - num(track.textureSpeed, 0) * t;
    },
  };
}

const RUNNERS: { [K in TrackSpec['type']]?: (track: Extract<TrackSpec, { type: K }>, ctx: Ctx, sim: EffectSim) => Runner | null } = {
  shell(track, ctx) {
    const shape = track.shape ?? 'sphere';
    const kind: FxSolid['shape'] = shape === 'sphere' || shape === 'dome' ? 'sphere' : shape === 'cylinder' || shape === 'disc' || shape === 'pillar' ? 'cylinder' : shape === 'wedge' ? 'wedge' : 'block';
    const base = vmul(vec(track.size, [4, 4, 4]), ctx.scale);
    // A Cylinder part's length is its X axis: discs and pillars stand it up.
    const offset = xfMul(localXf(track, ctx.scale), xf([0, 0, 0], kind === 'cylinder' ? angles([0, 0, 90]) : I3));
    const spin = vec(track.spin, [0, 0, 0]);
    let solid: FxSolid | null = null;
    return {
      update(t) {
        const [k, going] = progress(track, ctx, t);
        const s = Math.max(sampleCurve(track.scale ?? 1, k), 0);
        let size = vmul(base, s);
        if (kind === 'cylinder') size = [size[1], size[0], size[2]];
        size = [Math.max(size[0], 0.05), Math.max(size[1], 0.05), Math.max(size[2], 0.05)];
        const place = xfMul(xfMul(ctx.base, offset), xf([0, 0, 0], anglesRad(rad(spin[0] * t), rad(spin[1] * t), rad(spin[2] * t))));
        solid = { shape: kind, p: place.p, r: place.r, size, color: sampleColor(track.color ?? '#ffffff', k), alpha: 1 - clamp01(sampleCurve(track.transparency ?? [0, 1], k)), material: track.material ?? 'Neon' };
        return going;
      },
      draw(out) {
        if (solid && solid.alpha > 0) out.layers.push({ kind: 'solids', name: track.name ?? 'shell', at: solid.p, items: [solid] });
      },
    };
  },

  light(track, ctx) {
    const offset = localXf(track, ctx.scale);
    const flicker = num(track.flicker, 0);
    const seed = ctx.rand() * 100;
    const color = hex(track.color, [1, 0.8, 0.5]);
    let light: FxLight | null = null;
    return {
      update(t) {
        const [k, going] = progress(track, ctx, t);
        // ShurikenCurves.flicker: mostly bright, with quick dips.
        const f = flicker > 0 ? 1 - flicker + flicker * clamp01(0.75 + noise1(t * 8, seed) * 0.45) : 1;
        light = { p: xfMul(ctx.base, offset).p, color, brightness: Math.max(sampleCurve(track.brightness ?? [4, 0], k), 0) * f, range: Math.min(60, Math.max(0, sampleCurve(track.range ?? 12, k) * ctx.scale)) };
        return going;
      },
      draw(out) {
        if (light && light.brightness > 0 && light.range > 0) out.lights.push(light);
      },
    };
  },

  beam(track, ctx) {
    const from = vmul(vec(track.from, [0, 0, 0]), ctx.scale);
    // "target" is opts.to in the game; with none given the runtime's default end is 10 studs ahead.
    const to = vmul(vec(track.to, [0, 0, -10]), ctx.scale);
    const count = track.jag ? Math.min(24, Math.max(2, Math.floor(num(track.jag.segments, 8)))) : 1;
    const rate = track.jag ? num(track.jag.rate, 15) : 0;
    const amplitude = track.jag ? num(track.jag.amplitude, 0.12) : 0;
    const bend = vmul(vec(track.bend, [0, 0, 0]), ctx.scale);
    const widths = vec(track.width, [0.5, 0.5, 0]);
    const look = beamLook(track as unknown as Record<string, unknown>);
    const smooth = Math.min(48, Math.max(8, Math.floor(num(track.segments, 10))));
    let nextJag = 0;
    let seed = Math.floor(ctx.rand() * 1e6) + 1;
    let jagged: Vec3[] = [];
    let strips: FxRow[][] = [];
    return {
      update(t) {
        const [k, going] = progress(track, ctx, t);
        const a = xfPoint(ctx.base, from);
        const b = xfPoint(ctx.base, to);
        const w = sampleCurve(track.widthScale ?? 1, k) * ctx.scale;
        const fade = Math.round(sampleCurve(track.fade ?? 0, k) * 50) / 50;
        const along = (s: number) => {
          const v = sampleCurve(track.transparency ?? 0, s);
          return 1 - clamp01(v + (1 - v) * fade);
        };
        const row = (p: Vec3, s: number, length: number): FxRow => ({ p, half: ((widths[0] + (widths[1] - widths[0]) * s) * w) / 2, color: look.color(s), alpha: along(s), u: look.u(s, length, t) });
        strips = [];
        if (count === 1) {
          // One Beam: a cubic Bezier whose control points sit a third along, pushed sideways by `bend`.
          const frame = lookRotation(vsub(b, a));
          const push = vadd(vmul(mapply(frame, [1, 0, 0]), bend[0]), vmul(mapply(frame, [0, 1, 0]), bend[1]));
          const third = vmul(vsub(b, a), 1 / 3);
          const p1 = vadd(a, vadd(third, push));
          const p2 = vsub(b, vsub(third, push));
          const length = vlen(vsub(b, a));
          const rows: FxRow[] = [];
          for (let i = 0; i <= smooth; i++) {
            const s = i / smooth;
            const u = 1 - s;
            rows.push(row(vadd(vadd(vmul(a, u * u * u), vmul(p1, 3 * u * u * s)), vadd(vmul(p2, 3 * u * s * s), vmul(b, s * s * s))), s, length));
          }
          strips.push(rows);
        } else {
          if (t >= nextJag || !jagged.length) {
            nextJag = t + (rate > 0 ? 1 / rate : Infinity);
            seed += 1;
            jagged = lightning(a, b, count, amplitude, seed);
          }
          // Each kink is its own Beam: its width, colour and transparency run over that one piece.
          for (let i = 0; i < count; i++) {
            const p0 = jagged[i]!;
            const p1 = jagged[i + 1]!;
            const length = vlen(vsub(p1, p0));
            strips.push([0, 0.25, 0.5, 0.75, 1].map((s) => row(vlerp(p0, p1, s), s, length)));
          }
        }
        return going;
      },
      draw(out) {
        if (strips.length) out.layers.push({ kind: 'strips', name: track.name ?? 'beam', tex: look.tex, emission: look.emission, zOffset: look.zOffset, at: strips[0]![0]!.p, strips: track.faceCamera === false ? strips.map((s) => s.map((r) => ({ ...r, side: [1, 0, 0] as Vec3 }))) : strips });
      },
    };
  },

  circle(track, ctx) {
    const offset = localXf(track, ctx.scale);
    const look = beamLook(track as unknown as Record<string, unknown>);
    let strips: FxRow[][] = [];
    let at: Vec3 = [0, 0, 0];
    return {
      update(t) {
        const [k, going] = progress(track, ctx, t);
        const radius = Math.max(sampleCurve(track.radius ?? [1, 8], k) * ctx.scale, 0.05);
        const half = Math.max(sampleCurve(track.width ?? 0.4, k) * ctx.scale, 0.01) / 2;
        const alpha = 1 - clamp01(sampleCurve(track.transparency ?? [0, 1], k));
        const center = xfMul(ctx.base, offset);
        at = center.p;
        strips = [];
        // Four quarter beams (+x, +z, -x, -z): each carries the whole colour sequence along its own length.
        for (let q = 0; q < 4; q++) {
          const rows: FxRow[] = [];
          for (let i = 0; i <= 12; i++) {
            const s = i / 12;
            const a = ((q + s) * Math.PI) / 2;
            rows.push({ p: xfPoint(center, [Math.cos(a) * radius, 0, Math.sin(a) * radius]), half, color: look.color(s), alpha, u: look.u(s, (radius * Math.PI) / 2, t) });
          }
          strips.push(rows);
        }
        return going;
      },
      draw(out) {
        if (strips.length && strips[0]![0]!.alpha > 0) out.layers.push({ kind: 'strips', name: track.name ?? 'circle', tex: look.tex, emission: look.emission, zOffset: look.zOffset, at, strips });
      },
    };
  },

  ribbon(track, ctx) {
    const path = pathOf(track.path, ctx.scale);
    const offset = localXf(track, ctx.scale);
    const width = num(track.width, 1.5) * ctx.scale;
    const upright = track.across === 'upright';
    const trail = track.trail ?? {};
    const lifetime = num(trail.lifetime, 0.25);
    const duration = Math.max(num(track.duration, 0.3), 1e-3);
    const ease = easer(track.ease ?? 'quadOut');
    const bright = Math.max(0, num(trail.brightness, 1));
    const samples: Array<{ c: Vec3; side: Vec3; at: number }> = [];
    let now = 0;
    return {
      update(t) {
        now = t;
        const looping = ctx.persistent && !!track.loop;
        if (looping || t < duration || !samples.length) {
          const k = looping ? (t % duration) / duration : clamp01(t / duration);
          const u = ease(k);
          // path:frame(u): -z along the path, y up.
          const brush = xfMul(xfMul(ctx.base, offset), xf(path.at(u), lookRotation(path.tangent(u))));
          samples.push({ c: brush.p, side: mapply(brush.r, upright ? [0, 1, 0] : [1, 0, 0]), at: t });
        }
        while (samples.length && t - samples[0]!.at > lifetime) samples.shift();
        return looping || t < duration + lifetime;
      },
      draw(out) {
        if (samples.length < 2) return;
        // A Trail: newest at the brush (0 along its sequences), oldest at its tail (1).
        const rows: FxRow[] = [];
        for (let i = samples.length - 1; i >= 0; i--) {
          const s = samples[i]!;
          const age = clamp01((now - s.at) / Math.max(lifetime, 1e-3));
          rows.push({ p: s.c, side: s.side, half: (width / 2) * Math.max(0, sampleCurve(trail.width ?? [1, 0], age)), color: vmul(sampleColor(trail.color ?? '#ffffff', age), bright), alpha: 1 - clamp01(sampleCurve(trail.transparency ?? [0, 1], age)), u: age });
        }
        out.layers.push({ kind: 'strips', name: track.name ?? 'ribbon', tex: trail.texture, emission: clamp01(num(trail.lightEmission, 1)), zOffset: 0, at: rows[0]!.p, strips: [rows] });
      },
    };
  },

  debris(track, ctx) {
    const r = ctx.rand;
    const count = Math.max(1, Math.round(num(track.count, 6) * ctx.countScale));
    const origin = xfMul(ctx.base, localXf(track, ctx.scale));
    // The runtime looks for ground up to 60 studs below.
    const floor = origin.p[1] - ctx.floor <= 60 ? ctx.floor : -Infinity;
    const sizes = vec(track.size, [0.4, 1, 0]);
    const speeds = vec(track.speed, [20, 40, 0]);
    const spread = rad(num(track.spread, 50));
    const gravity = num(track.gravity, 120);
    const bounce = num(track.bounce, 0.35);
    const life = vec(track.lifetime, [1.2, 2, 0]);
    const colors = (Array.isArray(track.color) ? track.color : [track.color ?? '#8a7f73']).map((c) => hex(c, [0.5, 0.5, 0.5]));
    const shape: FxSolid['shape'] = track.shape === 'wedge' ? 'wedge' : track.shape === 'ball' ? 'sphere' : 'block';
    const between = (a: number, b: number) => a + (b - a) * r();
    const pieces = Array.from({ length: count }, () => {
      const s = between(sizes[0], sizes[1]) * ctx.scale;
      const size: Vec3 = [s, s * between(0.6, 1), s * between(0.7, 1.2)];
      const yaw = between(0, 2 * Math.PI);
      const tilt = between(0, spread);
      const dir = mapply(mmul(origin.r, mmul(anglesRad(0, yaw, 0), anglesRad(tilt, 0, 0))), [0, 1, 0]);
      return { p: origin.p, v: vmul(dir, between(speeds[0], speeds[1]) * ctx.scale), spin: [between(-12, 12), between(-12, 12), between(-12, 12)] as Vec3, angle: [0, 0, 0] as Vec3, size, dies: between(life[0], life[1]), color: colors[Math.min(colors.length - 1, Math.floor(r() * colors.length))]!, alpha: 1 };
    });
    const longest = Math.max(...pieces.map((p) => p.dies));
    return {
      update(t, dt) {
        for (const piece of pieces) {
          let v: Vec3 = [piece.v[0], piece.v[1] - gravity * dt, piece.v[2]];
          let p = vadd(piece.p, vmul(v, dt));
          const rest = floor + piece.size[1] / 2;
          if (p[1] < rest) {
            p = [p[0], rest, p[2]];
            v = [v[0] * 0.55, Math.abs(v[1]) * bounce, v[2] * 0.55];
            piece.spin = vmul(piece.spin, 0.5);
          }
          piece.p = p;
          piece.v = v;
          piece.angle = vadd(piece.angle, vmul(piece.spin, dt));
          const fadeFrom = piece.dies * 0.7;
          piece.alpha = 1 - (t > fadeFrom ? clamp01((t - fadeFrom) / (piece.dies - fadeFrom)) : 0);
        }
        return t < longest;
      },
      draw(out) {
        const items = pieces.filter((p) => p.alpha > 0).map((p): FxSolid => ({ shape, p: p.p, r: anglesRad(p.angle[0], p.angle[1], p.angle[2]), size: p.size, color: p.color, alpha: p.alpha, material: track.material ?? 'Slate' }));
        if (items.length) out.layers.push({ kind: 'solids', name: track.name ?? 'debris', at: origin.p, items });
      },
    };
  },

  decal(track, ctx) {
    if (typeof track.texture !== 'string') return null;
    const at = xfMul(ctx.base, localXf(track, ctx.scale));
    let place = at;
    // Laid on the ground when there is some within 30 studs below.
    if (track.ground !== false && at.p[1] + 2 >= ctx.floor && at.p[1] - ctx.floor <= 28) {
      const look = mapply(at.r, [0, 0, -1]);
      const flat = vnorm([look[0], 0, look[2]], [0, 0, -1]);
      place = xf([at.p[0], ctx.floor + 0.04, at.p[2]], lookRotation(flat, [0, 1, 0]));
    }
    const size = vmul(vec(typeof track.size === 'number' ? [track.size, track.size] : track.size, [8, 8, 0]), ctx.scale);
    const spin = num(track.spin, 0);
    let layer: FxDecal | null = null;
    return {
      update(t) {
        const [k, going] = progress(track, ctx, t);
        const turned = xfMul(place, xf([0, 0, 0], anglesRad(0, rad(spin * t), 0)));
        layer = { kind: 'decal', name: track.name ?? 'decal', tex: track.texture, p: turned.p, r: turned.r, size: [size[0], size[1] > 0 ? size[1] : size[0]], color: sampleColor(track.color ?? '#ffffff', k), alpha: 1 - clamp01(sampleCurve(track.transparency ?? { keys: [[0, 1], [0.1, 0], [0.75, 0], [1, 1]] }, k)), at: turned.p };
        return going;
      },
      draw(out) {
        if (layer && layer.alpha > 0) out.layers.push(layer);
      },
    };
  },

  highlight(track, ctx) {
    if (!ctx.target) return null;
    const color = hex(track.color, [1, 1, 1]);
    const outlineColor = hex(track.outline ?? track.color, [1, 1, 1]);
    let state: FxFrame['highlight'] = null;
    return {
      update(t) {
        const [k, going] = progress(track, ctx, t);
        state = { color, outlineColor, fill: 1 - clamp01(sampleCurve(track.transparency ?? [0.15, 1], k)), outline: 1 - clamp01(sampleCurve(track.outlineTransparency ?? [0.3, 1], k)) };
        return going;
      },
      draw(out) {
        if (state) out.highlight = state;
      },
    };
  },

  hitstop(track, ctx, sim) {
    sim.cue('hitstop', `${num(track.seconds, 0.06)} s`);
    if (!ctx.target) return null;
    const seconds = num(track.seconds, 0.06);
    return {
      update: (t) => t < seconds,
      draw(out) {
        out.hitstop = true;
      },
    };
  },

  sound(track, _ctx, sim) {
    sim.cue('sound', String(track.sound));
    return null;
  },

  shake(track, _ctx, sim) {
    sim.shakeBy(num(track.magnitude, 1.5), num(track.duration, 0.25));
    return null;
  },

  screen(track, _ctx, sim) {
    const seconds = typeof track.duration === 'number' ? track.duration : undefined;
    const color = hex(track.color, [1, 1, 1]);
    const strength = typeof track.strength === 'number' ? track.strength : undefined;
    const quadOut = (x: number) => 1 - (1 - x) * (1 - x);
    // ShurikenScreenFX.cue: how strongly each cue shows over its own time.
    let alpha: (t: number) => number;
    let length: number;
    if (track.fx === 'flash') {
      const peak = Math.min(0.6, Math.max(0, strength ?? 0.35));
      length = seconds ?? 0.25;
      alpha = (t) => peak * (1 - quadOut(clamp01(t / length)));
    } else if (track.fx === 'tint') {
      const goal = Math.min(0.6, Math.max(0, strength ?? 0.2));
      const hold = Math.max(seconds ?? 0.6, 0.15);
      length = hold + 0.35;
      alpha = (t) => (t < hold ? goal * quadOut(clamp01(t / 0.15)) : goal * (1 - clamp01((t - hold) / 0.35) ** 2));
    } else if (track.fx === 'shake') {
      sim.shakeBy(1.5 * (strength ?? 1), 0.25);
      return null;
    } else {
      length = seconds ?? (track.fx === 'speedlines' ? 0.4 : track.fx === 'hitmarker' ? 0.25 : track.fx === 'banner' ? 1.6 : 2);
      const level = track.fx === 'vignette' ? (strength ?? 0.5) : 1;
      alpha = () => level;
    }
    let state: FxScreen | null = null;
    return {
      update(t) {
        state = { fx: track.fx, color, alpha: alpha(t), text: track.text };
        return t < length;
      },
      draw(out) {
        if (state && state.alpha > 0) out.screens.push(state);
      },
    };
  },
};

/** How a trail effect is shown: a blade swinging where the effect plays (game code attaches it to a part). */
function trailDemo(spec: EffectSpec): Runner {
  const trail = spec.trail!;
  const samples: Array<{ a: Vec3; b: Vec3; at: number }> = [];
  let blade: FxSolid[] = [];
  let now = 0;
  return {
    update(t) {
      now = t;
      // Swings that snap across and settle, like real strikes.
      const phase = (t * 0.9) % 2;
      const k = phase < 1 ? phase : 2 - phase;
      const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      const hand = xf([0, 0.2, 0], anglesRad(0, 0, 1.9 - eased * 3.8));
      blade = [
        { shape: 'block', p: xfPoint(hand, [0, 2.3, 0]), r: hand.r, size: [0.14, 3.8, 0.34], color: [0.9, 0.93, 0.95], alpha: 1, material: 'Metal' },
        { shape: 'block', p: xfPoint(hand, [0, 0.4, 0]), r: hand.r, size: [0.9, 0.12, 0.2], color: [0.54, 0.42, 0.23], alpha: 1, material: 'Metal' },
        { shape: 'block', p: hand.p, r: hand.r, size: [0.2, 0.8, 0.2], color: [0.23, 0.16, 0.12], alpha: 1, material: 'Plastic' },
      ];
      samples.push({ a: xfPoint(hand, [0, 1.1, 0]), b: xfPoint(hand, [0, 4.2, 0]), at: t });
      while (samples.length && t - samples[0]!.at > trail.lifetime) samples.shift();
      return true;
    },
    draw(out) {
      out.layers.push({ kind: 'solids', name: 'blade', at: [0, 2, 0], items: blade });
      if (samples.length < 2) return;
      const seq = (v: number[], s: number) => sampleCurve(v, s, v[0] ?? 0);
      const rows: FxRow[] = [];
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i]!;
        const age = clamp01((now - s.at) / Math.max(trail.lifetime, 1e-3));
        const mid = vlerp(s.a, s.b, 0.5);
        const reach = vsub(s.b, mid);
        rows.push({ p: mid, side: trail.faceCamera ? undefined : vnorm(reach), half: vlen(reach) * Math.max(0, seq(trail.width, age)), color: sampleColor(trail.color, age), alpha: 1 - clamp01(seq(trail.transparency, age)), u: age });
      }
      out.layers.push({ kind: 'strips', name: spec.name, tex: trail.texture, emission: clamp01(trail.lightEmission ?? 0), zOffset: 0, at: rows[0]!.p, strips: [rows] });
    },
  };
}

/** How a beam effect is shown: between two orbs 10 studs apart (game code gives it its two attachments). */
function beamDemo(spec: EffectSpec): Runner {
  const beam = spec.beam!;
  const a: Vec3 = [-5, 0, 0];
  const b: Vec3 = [5, 0, 0];
  let now = 0;
  const seq = (v: number[], s: number) => sampleCurve(v, s, v[0] ?? 0);
  return {
    update(t) {
      now = t;
      return true;
    },
    draw(out) {
      const orb = (p: Vec3): FxSolid => ({ shape: 'sphere', p, r: I3, size: [1, 1, 1], color: vlerp(sampleColor(beam.color, 0), [0.23, 0.2, 0.18], 0.5), alpha: 1, material: 'Plastic' });
      out.layers.push({ kind: 'solids', name: 'ends', at: [0, 0, 0], items: [orb(a), orb(b)] });
      const n = Math.min(48, Math.max(8, beam.segments ?? 10));
      // CurveSize pushes each control point along its attachment's X axis (here: up).
      const p1 = vadd(a, [0, beam.curve?.[0] ?? 0, 0]);
      const p2 = vsub(b, [0, beam.curve?.[1] ?? 0, 0]);
      const rows: FxRow[] = [];
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        const u = 1 - s;
        const p = vadd(vadd(vmul(a, u * u * u), vmul(p1, 3 * u * u * s)), vadd(vmul(p2, 3 * u * s * s), vmul(b, s * s * s)));
        rows.push({ p, side: beam.faceCamera === false ? [0, 1, 0] : undefined, half: (beam.width[0] + ((beam.width[1] ?? beam.width[0]) - beam.width[0]) * s) / 2, color: sampleColor(beam.color, s), alpha: 1 - clamp01(seq(beam.transparency, s)), u: s * Math.max(beam.textureLength ?? 1, 1e-3) - (beam.textureSpeed ?? 0) * now });
      }
      out.layers.push({ kind: 'strips', name: spec.name, tex: beam.texture, emission: clamp01(beam.lightEmission ?? 0), zOffset: 0, at: [0, 0, 0], strips: [rows] });
    },
  };
}

export class EffectSim {
  /** Seconds since the effect started. */
  t = 0;
  readonly persistent: boolean;
  private readonly ctx: Ctx;
  private readonly emitters: Emitter[] = [];
  private readonly tracks: TrackSpec[];
  private next = 0;
  private active: Array<{ run: Runner; start: number }> = [];
  private readonly children: EffectSim[] = [];
  private readonly shakes: Array<{ magnitude: number; start: number; duration: number }> = [];
  private cues: FxFrame['cues'] = [];
  private stopped = false;
  private readonly rank: number;

  private readonly depth: number;

  /** `spawned`: an effect another one's spawn track started (where, how deep, always one-shot). */
  constructor(
    readonly spec: EffectSpec,
    private readonly opts: SimOptions = {},
    spawned?: { base: Xf; depth: number },
  ) {
    const base = spawned?.base ?? xf(opts.at ?? [0, 0, 0]);
    const depth = spawned?.depth ?? 0;
    this.depth = depth;
    this.persistent = spawned ? false : spec.kind === 'persistent';
    this.rank = RANK[opts.quality ?? 'high'] ?? 3;
    const rand = seeded((opts.seed ?? 1) * 7919 + depth * 104729 + spec.name.length);
    const countScale = QUALITY[opts.quality ?? 'high'] ?? 1;
    this.ctx = { base, scale: opts.scale ?? 1, countScale, persistent: this.persistent, floor: opts.floor ?? -Infinity, target: !!opts.target, rand };
    const compiled = compileEffect(spec);
    if (spec.kind === 'burst' || spec.kind === 'persistent') {
      for (const m of compiled.emitters) if ((RANK[m.detail ?? 'low'] ?? 1) <= this.rank) this.emitters.push(new Emitter(m, this.ctx, countScale));
    }
    this.tracks = spec.kind === 'burst' || spec.kind === 'persistent' ? compiled.tracks : [];
    if (spec.kind === 'trail' && spec.trail) this.active.push({ run: trailDemo(spec), start: 0 });
    if (spec.kind === 'beam' && spec.beam) this.active.push({ run: beamDemo(spec), start: 0 });
    if (spec.light && (spec.kind === 'burst' || spec.kind === 'persistent')) this.active.push({ run: this.flashLight(spec.light), start: 0 });
    // The first frame: what starts at 0 is already there.
    for (const e of this.emitters) e.due(0, 0);
    this.startDue();
    for (const a of this.active) a.run.update(0, 0);
  }

  /** The PointLight of older effects: a flash that fades over its duration, or a steady glow. */
  private flashLight(light: NonNullable<EffectSpec['light']>): Runner {
    const color = hex(light.color, [1, 1, 1]);
    const flash = light.duration > 0 && !this.persistent;
    let now = 0;
    return {
      update: (t) => {
        now = t;
        return flash ? t < light.duration : !this.stopped && (this.persistent || this.emitters.some((e) => !e.spent));
      },
      draw: (out) => {
        const k = flash ? clamp01(now / light.duration) : 0;
        // A Quad Out tween to 0.
        out.lights.push({ p: this.ctx.base.p, color, brightness: light.brightness * (1 - k) * (1 - k), range: light.range * this.ctx.scale });
      },
    };
  }

  cue(type: string, label: string): void {
    this.cues.push({ type, label, at: this.t });
  }

  shakeBy(magnitude: number, duration: number): void {
    this.shakes.push({ magnitude, start: this.t, duration: Math.max(duration, 0.01) });
    this.cue('shake', `${magnitude}°`);
  }

  private startDue(): void {
    while (!this.stopped && this.next < this.tracks.length && (this.tracks[this.next]!.at ?? 0) <= this.t + 1e-9) {
      const track = this.tracks[this.next++]!;
      if ((RANK[track.detail ?? 'low'] ?? 1) > this.rank) continue;
      if (track.type === 'spawn') {
        const other = track.effect !== this.spec.name && this.depth < 3 ? this.opts.resolve?.(track.effect) : null;
        this.cue('spawn', track.effect);
        if (other && (other.kind === 'burst' || other.kind === 'persistent')) this.children.push(new EffectSim(other, this.opts, { base: xfMul(this.ctx.base, localXf(track, this.ctx.scale)), depth: this.depth + 1 }));
        continue;
      }
      const make = RUNNERS[track.type] as ((track: TrackSpec, ctx: Ctx, sim: EffectSim) => Runner | null) | undefined;
      const run = make?.(track, this.ctx, this);
      if (run) this.active.push({ run, start: this.t });
    }
  }

  /** One step of dt seconds. */
  step(dt: number): void {
    if (dt <= 0) return;
    this.t += dt;
    for (const e of this.emitters) e.step(this.t, dt);
    const started = this.active.length;
    this.startDue();
    this.active = this.active.filter((a, i) => a.run.update(this.t - a.start, i < started ? dt : 0));
    for (const c of this.children) c.step(dt);
  }

  /** Plays on to time `to` in steps of at most `maxStep` (fixed steps keep a seed's playback identical). */
  advance(to: number, maxStep = 1 / 60): void {
    while (this.t < to - 1e-9) this.step(Math.min(maxStep, to - this.t));
  }

  /** handle.stop(): emitters stop, tracks end, the particles left die out. */
  stop(): void {
    this.stopped = true;
    for (const e of this.emitters) e.enabled = false;
    this.active = [];
    for (const c of this.children) c.stop();
  }

  /** Nothing is left of it and nothing more will come (a persistent effect: only after stop()). */
  get done(): boolean {
    if (this.spec.kind === 'trail' || this.spec.kind === 'beam') return false;
    if (this.persistent && !this.stopped) return false;
    return this.active.length === 0 && (this.stopped || this.next >= this.tracks.length) && this.emitters.every((e) => e.spent) && this.children.every((c) => c.done);
  }

  /** What is on screen now. */
  frame(): FxFrame {
    const out: FxFrame = { t: this.t, layers: [], lights: [], screens: [], shake: 0, highlight: null, hitstop: false, cues: this.cues };
    this.cues = [];
    for (const e of this.emitters) {
      const layer = e.layer();
      if (layer.items.length) out.layers.push(layer);
    }
    for (const a of this.active) a.run.draw?.(out);
    for (const s of this.shakes) {
      const left = 1 - (this.t - s.start) / s.duration;
      if (left > 0) out.shake += s.magnitude * left * left;
    }
    for (const c of this.children) {
      const f = c.frame();
      out.layers.push(...f.layers);
      out.lights.push(...f.lights);
      out.screens.push(...f.screens);
      out.shake += f.shake;
      out.highlight ??= f.highlight;
      out.hitstop ||= f.hitstop;
      out.cues.push(...f.cues);
    }
    return out;
  }
}

/** Seconds until a one-shot effect is over (its last particle, part and light gone); a persistent effect: one cycle. */
export function effectLength(spec: EffectSpec, resolve?: SimOptions['resolve'], depth = 0): number {
  const { emitters, tracks } = compileEffect(spec);
  const persistent = spec.kind === 'persistent';
  let end = spec.light && !persistent ? spec.light.duration : 0;
  for (const m of emitters) end = Math.max(end, persistent ? m.lifetime[1] : m.delay + (m.for ?? 0) + m.lifetime[1]);
  for (const t of tracks) {
    const at = t.at ?? 0;
    const d = t.duration ?? 0.3;
    const own =
      t.type === 'ribbon' ? d + (t.trail?.lifetime ?? 0.25)
      : t.type === 'debris' ? (t.lifetime?.[1] ?? 2)
      : t.type === 'spawn' ? (depth < 3 && t.effect !== spec.name ? effectLength(resolve?.(t.effect) ?? { name: '', kind: 'burst' }, resolve, depth + 1) : 0)
      : t.type === 'sound' || t.type === 'hitstop' ? 0
      : t.type === 'shake' ? (t.duration ?? 0.25)
      : t.type === 'screen' ? (t.fx === 'tint' ? Math.max(t.duration ?? 0.6, 0.15) + 0.35 : (t.duration ?? 0.25))
      : d;
    end = Math.max(end, at + own);
  }
  return persistent ? Math.max(1, end) : Math.max(0.1, end);
}

export interface FxBounds {
  /** Everything it ever reaches. */
  min: Vec3;
  max: Vec3;
  center: Vec3;
  /** Half the diagonal. */
  radius: number;
  /** Where nearly all of what shows is (by area and opacity: a stray spark or a faint last wisp doesn't count). */
  focus: { min: Vec3; max: Vec3 };
  /** How much it shows over time (area × opacity), sampled every `activity.step` seconds from 0. */
  activity: { step: number; ink: number[] };
}

/**
 * The box an effect fills while it plays (played through at a coarse step, in the sim's space), and the
 * tighter box that holds 97% of what it shows, for framing a camera on it.
 */
export function effectBounds(spec: EffectSpec, opts: SimOptions = {}): FxBounds {
  const sim = new EffectSim(spec, { ...opts, seed: opts.seed ?? 1 });
  const at = opts.at ?? [0, 0, 0];
  const min: Vec3 = [at[0] - 0.5, at[1] - 0.5, at[2] - 0.5];
  const max: Vec3 = [at[0] + 0.5, at[1] + 0.5, at[2] + 0.5];
  // Every drawn thing as a ball with a weight (its area × opacity).
  const balls: number[] = [];
  let ink = 0;
  const activity: number[] = [];
  const grow = (p: Vec3, r: number, weight: number) => {
    if (weight <= 0 || r <= 0) return;
    ink += weight;
    for (let i = 0; i < 3; i++) {
      if (p[i]! - r < min[i]!) min[i] = p[i]! - r;
      if (p[i]! + r > max[i]!) max[i] = p[i]! + r;
    }
    balls.push(p[0], p[1], p[2], r, weight);
  };
  const length = spec.kind === 'burst' ? Math.min(12, effectLength(spec, opts.resolve)) : 2.5;
  const steps = Math.min(150, Math.max(12, Math.ceil(length * 30)));
  for (let i = 0; i <= steps; i++) {
    sim.advance((length * i) / steps, 1 / 30);
    ink = 0;
    for (const l of sim.frame().layers) {
      if (l.kind === 'sprites') for (const s of l.items) grow(s.p, s.size / 2, s.alpha > 0.03 ? s.size * s.size * s.alpha : 0);
      else if (l.kind === 'strips')
        for (const strip of l.strips)
          strip.forEach((r, k) => {
            const next = strip[Math.min(strip.length - 1, k + 1)]!;
            grow(r.p, Math.max(r.half, 0.05), r.alpha > 0.03 ? Math.max(r.half, 0.05) * 2 * Math.max(vlen(vsub(next.p, r.p)), r.half) * r.alpha : 0);
          });
      else if (l.kind === 'solids')
        for (const s of l.items) {
          const d = s.shape === 'sphere' ? Math.min(...s.size) : vlen(s.size);
          grow(s.p, d / 2, s.alpha > 0.03 ? d * d * s.alpha : 0);
        }
      else grow(l.p, Math.max(l.size[0], l.size[1]) / 2, l.size[0] * l.size[1] * l.alpha * 0.06); // a mark on the ground is the least of it
    }
    activity.push(ink);
  }
  // Per axis: the span that holds all but 1.5% of the weight at each end.
  const focus = { min: [...min] as Vec3, max: [...max] as Vec3 };
  const BINS = 200;
  for (let axis = 0; axis < 3; axis++) {
    const lo = min[axis]!;
    const span = max[axis]! - lo;
    if (span <= 1e-6 || !balls.length) continue;
    const bins = new Float64Array(BINS);
    let total = 0;
    for (let k = 0; k < balls.length; k += 5) {
      const c = balls[k + axis]!;
      const r = balls[k + 3]!;
      const w = balls[k + 4]!;
      const a = Math.max(0, Math.floor(((c - r - lo) / span) * BINS));
      const b = Math.min(BINS - 1, Math.floor(((c + r - lo) / span) * BINS));
      const share = w / (b - a + 1);
      for (let n = a; n <= b; n++) bins[n] = bins[n]! + share;
      total += w;
    }
    let acc = 0;
    let first = 0;
    while (first < BINS - 1 && acc + bins[first]! < total * 0.015) acc += bins[first++]!;
    acc = 0;
    let last = BINS - 1;
    while (last > first && acc + bins[last]! < total * 0.015) acc += bins[last--]!;
    focus.min[axis] = lo + (first / BINS) * span;
    focus.max[axis] = lo + ((last + 1) / BINS) * span;
  }
  const center = vlerp(min, max, 0.5);
  return { min, max, center, radius: vlen(vsub(max, min)) / 2, focus, activity: { step: length / steps, ink: activity } };
}

/** Tracks the preview can't show, with what they do in the game. */
export function undrawn(spec: EffectSpec): string[] {
  const out: string[] = [];
  const at = (t: TrackSpec) => `${(t.at ?? 0).toFixed(2)} s`;
  for (const t of spec.tracks ?? []) {
    if (t.type === 'sound') out.push(`Sound ${t.sound} at ${at(t)} isn't played here.`);
    else if (t.type === 'shell' && t.shape === 'mesh') out.push(`${t.name ?? 'A mesh shell'} uses a mesh from Roblox: a block stands in for it.`);
    else if (t.type === 'beam' && t.to === 'target') out.push(`${t.name ?? 'A beam'} ends at the target the game gives it: 10 studs ahead here.`);
    else if (t.type === 'screen' && t.fx === 'banner') out.push(`The banner "${t.text ?? ''}" at ${at(t)} is drawn by the game's screen FX module in its own font.`);
  }
  if (spec.kind === 'trail') out.push('A trail follows the part game code attaches it to: here it is on a swinging blade.');
  if (spec.kind === 'beam') out.push('A beam runs between two attachments game code gives it: here they are 10 studs apart.');
  if (spec.kind === 'persistent' && (spec.tracks ?? []).some((t) => t.type === 'flash' || t.type === 'ring' || t.type === 'slash' || (t.type === 'particles' && !t.rate))) out.push('Particle tracks with emit but no rate never fire in an effect that stays on (it runs on rate): they are not shown, and the game won\'t show them either.');
  if ((spec.emitters ?? []).some((m) => m.windAffectsDrag) || (spec.tracks ?? []).some((t) => t.type === 'particles' && t.windAffectsDrag)) out.push('Wind (workspace.GlobalWind) is not simulated.');
  return out;
}
