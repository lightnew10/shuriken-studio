import { describe, expect, it } from 'vitest';
import { validateEffect, type EffectSpec, type EmitterSpec, type TrackSpec } from '@shared/effects';
import { TEXTURES as T } from '@shared/effects';
import { effectBounds, effectLength, EffectSim, undrawn, type FxFrame, type FxSolids, type FxSprites, type FxStrips } from '@shared/fx/sim';
import { GLOW_TEX, tessellate } from '@shared/fx/mesh';
import { cameraOf, dummySolids, frameEffect, lookFrom, placementOf, STAGES } from '@shared/fx/stage';
import { vdot, vsub } from '@shared/fx/math';
import { buildEffect, listEffectPresets } from '@core/effects/presets';
import { EXAMPLES, exampleEffect } from '@core/effects/examples';

const emitter = (over: Partial<EmitterSpec> = {}): EmitterSpec => ({ name: 'Dots', texture: T.glow, color: ['#ffffff'], size: [1], transparency: [0], lifetime: [1, 1], speed: [10, 10], emit: 4, ...over });
const burst = (tracks: TrackSpec[], emitters?: EmitterSpec[]): EffectSpec => ({ name: 'Test', kind: 'burst', tracks, ...(emitters ? { emitters } : {}) });
const sprites = (f: FxFrame, name: string) => f.layers.find((l): l is FxSprites => l.kind === 'sprites' && l.name === name);
const strips = (f: FxFrame, name: string) => f.layers.find((l): l is FxStrips => l.kind === 'strips' && l.name === name);
const solids = (f: FxFrame, name: string) => f.layers.find((l): l is FxSolids => l.kind === 'solids' && l.name === name);
const at = (spec: EffectSpec, t: number, opts = {}) => {
  const sim = new EffectSim(spec, opts);
  sim.advance(t);
  return sim.frame();
};

describe('the effect player: bursts written as timelines', () => {
  // What 1.10's preview missed: every burst the VFX artist wrote had no `emitters`, only `tracks`.
  const spec = burst([
    { type: 'flash', name: 'Flash', duration: 0.1, size: [4, 9] },
    { type: 'ring', name: 'Shock', duration: 0.3, radius: [1, 10] },
    { type: 'particles', name: 'Embers', texture: T.spark, color: ['#ffffff'], size: [0.5], transparency: [0], lifetime: [0.5, 0.5], speed: [20, 30], spread: [180, 180], emit: 12 },
    { type: 'shell', name: 'Ball', shape: 'sphere', duration: 0.4, size: [6, 6, 6] },
  ]);

  it('shows its particle tracks, shorthands and shells on the very first frame', () => {
    expect(validateEffect(spec)).toEqual([]);
    const f = new EffectSim(spec).frame();
    expect(f.t).toBe(0);
    expect(sprites(f, 'Flash')!.items).toHaveLength(1);
    expect(sprites(f, 'Shock')!.mode).toBe('VelocityPerpendicular');
    expect(sprites(f, 'Embers')!.items).toHaveLength(12);
    expect(solids(f, 'Ball')!.items[0]!.shape).toBe('sphere');
  });

  it('ends: nothing is left after its last particle and track', () => {
    const sim = new EffectSim(spec);
    expect(sim.done).toBe(false);
    sim.advance(0.45);
    expect(sim.done).toBe(false);
    sim.advance(0.6);
    expect(sim.done).toBe(true);
    expect(sim.frame().layers).toEqual([]);
    expect(effectLength(spec)).toBeCloseTo(0.5, 5);
  });

  it('plays the same with the same seed, differently with another', () => {
    const a = at(spec, 0.2, { seed: 3 });
    const b = at(spec, 0.2, { seed: 3 });
    const c = at(spec, 0.2, { seed: 4 });
    const where = (f: FxFrame) => sprites(f, 'Embers')!.items.map((s) => s.p.map((v) => Math.round(v * 1000)));
    expect(where(a)).toEqual(where(b));
    expect(where(a)).not.toEqual(where(c));
  });
});

describe('particles follow Roblox emitter rules', () => {
  it('fly along the emission direction at their speed, slowed by drag and pulled by acceleration', () => {
    const plain = at(burst([], [emitter({ emit: 1 })]), 0.5);
    expect(sprites(plain, 'Dots')!.items[0]!.p[1]).toBeCloseTo(5, 1);
    // Drag 2: speed halves twice a second, so after 0.5 s it went 10 * (1 - 2^-1) / (2 ln 2) studs.
    const dragged = at(burst([], [emitter({ emit: 1, drag: 2 })]), 0.5);
    expect(sprites(dragged, 'Dots')!.items[0]!.p[1]).toBeCloseTo((10 * 0.5) / (2 * Math.LN2), 1);
    const falling = at(burst([], [emitter({ emit: 1, speed: [0, 0], acceleration: [0, -40, 0] })]), 0.5);
    expect(sprites(falling, 'Dots')!.items[0]!.p[1]).toBeCloseTo(-5, 0);
    const forward = at(burst([], [emitter({ emit: 1, direction: 'Front' })]), 0.5);
    expect(sprites(forward, 'Dots')!.items[0]!.p[2]).toBeCloseTo(-5, 1);
    // turn tilts the emitter: Top turned 90° about x points back (+z).
    const turned = at(burst([], [emitter({ emit: 1, turn: [90, 0, 0], offset: [1, 2, 3] })]), 0.5);
    expect(sprites(turned, 'Dots')!.items[0]!.p.map((v) => Math.round(v))).toEqual([1, 2, 8]);
  });

  it('change size, transparency and colour over each particle life', () => {
    const f = at(burst([], [emitter({ emit: 1, speed: [0, 0], size: [2, 6], transparency: [0, 1], color: ['#ff0000', '#0000ff'], lifetime: [1, 1] })]), 0.5);
    const s = sprites(f, 'Dots')!.items[0]!;
    expect(s.size).toBeCloseTo(4, 1);
    expect(s.alpha).toBeCloseTo(0.5, 1);
    expect(s.color.map((c) => Math.round(c * 10) / 10)).toEqual([0.5, 0, 0.5]);
  });

  it('emit by count at their delay, stream at a rate for a while, and run on rate when the effect stays on', () => {
    const delayed = burst([], [emitter({ emit: 7, delay: 0.2 })]);
    expect(sprites(at(delayed, 0.1), 'Dots')).toBeUndefined();
    expect(sprites(at(delayed, 0.25), 'Dots')!.items).toHaveLength(7);
    const stream = burst([], [emitter({ emit: undefined, rate: 40, for: 0.5, lifetime: [5, 5] })]);
    expect(sprites(at(stream, 0.25), 'Dots')!.items.length).toBeGreaterThanOrEqual(9);
    expect(sprites(at(stream, 0.25), 'Dots')!.items.length).toBeLessThanOrEqual(11);
    expect(sprites(at(stream, 2), 'Dots')!.items).toHaveLength(20);
    const aura: EffectSpec = { name: 'Aura', kind: 'persistent', emitters: [emitter({ emit: undefined, rate: 10, lifetime: [1, 1] })] };
    expect(validateEffect(aura)).toEqual([]);
    const sim = new EffectSim(aura);
    sim.advance(3);
    expect(sprites(sim.frame(), 'Dots')!.items.length).toBeGreaterThanOrEqual(9);
    expect(sim.done).toBe(false);
    sim.stop();
    sim.advance(4.2);
    expect(sim.done).toBe(true);
  });

  it('draw fewer at a lower quality level and skip layers above it', () => {
    const spec = burst([], [emitter({ emit: 100 }), emitter({ name: 'Extra', emit: 10, detail: 'high' })]);
    expect(sprites(at(spec, 0.1, { quality: 'low' }), 'Dots')!.items).toHaveLength(35);
    expect(sprites(at(spec, 0.1, { quality: 'low' }), 'Extra')).toBeUndefined();
    expect(sprites(at(spec, 0.1), 'Extra')!.items).toHaveLength(10);
  });

  it('step through a flipbook: once over a life, or looping at its frame rate', () => {
    const once = burst([], [emitter({ emit: 1, speed: [0, 0], flipbook: { layout: 'Grid4x4', mode: 'OneShot' } })]);
    expect(sprites(at(once, 0), 'Dots')!.items[0]!.cell).toBe(0);
    expect(sprites(at(once, 0.51), 'Dots')!.items[0]!.cell).toBe(8);
    expect(sprites(at(once, 0.99), 'Dots')!.items[0]!.cell).toBe(15);
    expect(sprites(at(once, 0.51), 'Dots')!.grid).toBe(4);
    const loop = burst([], [emitter({ emit: 1, speed: [0, 0], lifetime: [3, 3], flipbook: { layout: 'Grid2x2', mode: 'Loop', fps: [4, 4] } })]);
    expect([0.1, 0.3, 0.6, 0.8, 1.1].map((t) => sprites(at(loop, t), 'Dots')!.items[0]!.cell)).toEqual([0, 1, 2, 3, 0]);
  });
});

describe('timeline tracks play as ShurikenEffects plays them', () => {
  it('a shell grows, fades and changes colour over its duration; discs and pillars stand up', () => {
    const spec = burst([
      { type: 'shell', name: 'Ball', shape: 'sphere', duration: 1, size: [4, 4, 4], scale: [1, 3], transparency: [0, 1], color: ['#ff0000', '#00ff00'] },
      { type: 'shell', name: 'Pillar', shape: 'pillar', duration: 1, size: [5, 30, 5], offset: [0, 15, 0], transparency: 0.5, material: 'Neon' },
    ]);
    const ball = solids(at(spec, 0.5), 'Ball')!.items[0]!;
    expect(ball.size[0]).toBeCloseTo(8, 1);
    expect(ball.alpha).toBeCloseTo(0.5, 1);
    expect(ball.color.map((c) => Math.round(c * 10) / 10)).toEqual([0.5, 0.5, 0]);
    // A Cylinder part's length is its x: 30 long, turned to stand along y.
    const pillar = solids(at(spec, 0.5), 'Pillar')!.items[0]!;
    expect(pillar.shape).toBe('cylinder');
    expect(pillar.size).toEqual([30, 5, 5]);
    expect(Math.abs(pillar.r[3]!)).toBeCloseTo(1, 5);
    expect(pillar.p).toEqual([0, 15, 0]);
    expect(solids(at(spec, 1.1), 'Ball')).toBeUndefined();
  });

  it('a track starts at its `at` and not before', () => {
    const spec = burst([{ type: 'circle', name: 'Late', at: 0.3, duration: 0.2, radius: [2, 6], width: 0.5 }]);
    expect(strips(at(spec, 0.2), 'Late')).toBeUndefined();
    const f = at(spec, 0.4);
    const rows = strips(f, 'Late')!.strips;
    // Four quarter beams; halfway through, the radius is 4 studs.
    expect(rows).toHaveLength(4);
    expect(Math.hypot(rows[0]![0]!.p[0], rows[0]![0]!.p[2])).toBeCloseTo(4, 0);
    expect(rows[0]![0]!.half).toBeCloseTo(0.25, 5);
  });

  it('a beam runs from `from` to `to`, bends, and crackles as lightning with jag', () => {
    const straight = at(burst([{ type: 'beam', name: 'Ray', duration: 1, from: [0, 0, 0], to: [0, 0, -20], width: [2, 1], color: ['#ffffff', '#0000ff'], transparency: [0, 1] }]), 0.1);
    const rows = strips(straight, 'Ray')!.strips[0]!;
    expect(rows[0]!.p).toEqual([0, 0, 0]);
    expect(rows[rows.length - 1]!.p[2]).toBeCloseTo(-20, 5);
    expect(rows[0]!.half).toBeCloseTo(1, 5);
    expect(rows[rows.length - 1]!.half).toBeCloseTo(0.5, 5);
    expect(rows[0]!.alpha).toBeCloseTo(1, 5);
    expect(rows[rows.length - 1]!.alpha).toBeCloseTo(0, 5);
    const bent = at(burst([{ type: 'beam', name: 'Arc', duration: 1, to: [0, 0, -20], bend: [0, 6] }]), 0.1);
    const mid = strips(bent, 'Arc')!.strips[0]!;
    // Both control points are pushed up 6 studs: the middle of the cubic rises 4.5.
    expect(mid[Math.floor(mid.length / 2)]!.p[1]).toBeCloseTo(4.5, 1);
    const bolt = at(burst([{ type: 'beam', name: 'Bolt', duration: 1, from: [0, 30, 0], to: [0, 0, 0], jag: { segments: 10, amplitude: 0.1, rate: 20 } }]), 0.1);
    const pieces = strips(bolt, 'Bolt')!.strips;
    expect(pieces).toHaveLength(10);
    expect(pieces[0]![0]!.p).toEqual([0, 30, 0]);
    expect(pieces[9]![pieces[9]!.length - 1]!.p.map((v) => Math.round(v))).toEqual([0, 0, 0]);
    expect(pieces.some((p) => Math.abs(p[0]!.p[0]) > 0.05 || Math.abs(p[0]!.p[2]) > 0.05)).toBe(true);
    // "target" is the game's opts.to: the runtime's default end (10 studs ahead) when there is none.
    const aimed = at(burst([{ type: 'beam', name: 'Aim', duration: 1, to: 'target' }]), 0.1);
    expect(strips(aimed, 'Aim')!.strips[0]!.at(-1)!.p[2]).toBeCloseTo(-10, 5);
  });

  it('a ribbon leaves a trail along its path that dies out after it stops', () => {
    const spec = burst([{ type: 'ribbon', name: 'Swirl', duration: 0.4, ease: 'linear', path: { kind: 'orbit', radius: 3, turns: 1 }, width: 1, trail: { lifetime: 0.2 } }]);
    const mid = strips(at(spec, 0.2), 'Swirl')!.strips[0]!;
    expect(mid.length).toBeGreaterThan(6);
    for (const r of mid) expect(Math.hypot(r.p[0], r.p[2])).toBeCloseTo(3, 1);
    // Newest at the brush (full width), oldest at the tail (WidthScale 1 → 0 by default).
    expect(mid[0]!.half).toBeGreaterThan(mid[mid.length - 1]!.half);
    expect(strips(at(spec, 0.7), 'Swirl')).toBeUndefined();
    expect(effectLength(spec)).toBeCloseTo(0.6, 5);
  });

  it('debris flies out, bounces on the floor and fades; a decal lies on the ground under the effect', () => {
    const spec = burst([
      { type: 'debris', name: 'Rocks', count: 5, speed: [20, 30], lifetime: [2, 2] },
      { type: 'decal', name: 'Scorch', duration: 4, texture: T.puff, size: 9 },
    ]);
    const opts = { at: [0, 3, 0] as [number, number, number], floor: 0 };
    const early = at(spec, 0.2, opts);
    expect(solids(early, 'Rocks')!.items).toHaveLength(5);
    expect(Math.max(...solids(early, 'Rocks')!.items.map((s) => s.p[1]))).toBeGreaterThan(4);
    const late = at(spec, 1.9, opts);
    for (const s of solids(late, 'Rocks')!.items) expect(s.p[1]).toBeGreaterThanOrEqual(0);
    expect(solids(late, 'Rocks')!.items[0]!.alpha).toBeLessThan(0.5);
    const decal = early.layers.find((l) => l.kind === 'decal')!;
    expect(decal.kind === 'decal' && decal.p[1]).toBeCloseTo(0.04, 5);
    expect(decal.kind === 'decal' && decal.size).toEqual([9, 9]);
  });

  it('lights, shake, screen cues and sounds come at their times', () => {
    const spec = burst([
      { type: 'light', name: 'Glow', duration: 0.4, color: '#ff8800', brightness: [8, 0], range: 20 },
      { type: 'shake', at: 0.1, magnitude: 2, duration: 0.2 },
      { type: 'screen', at: 0.1, fx: 'flash', color: '#ffffff', strength: 0.3, duration: 0.2 },
      { type: 'sound', at: 0.05, sound: 'Boom' },
    ]);
    const sim = new EffectSim(spec);
    expect(sim.frame().lights[0]!.brightness).toBeCloseTo(8, 5);
    sim.advance(0.11);
    const f = sim.frame();
    expect(f.lights[0]!.brightness).toBeLessThan(8);
    expect(f.lights[0]!.range).toBe(20);
    expect(f.shake).toBeGreaterThan(1.5);
    expect(f.screens[0]!.fx).toBe('flash');
    expect(f.screens[0]!.alpha).toBeGreaterThan(0.2);
    expect(f.cues.map((c) => `${c.type}:${c.label}`)).toContain('sound:Boom');
    // Cues are told once.
    expect(sim.frame().cues).toEqual([]);
    sim.advance(0.5);
    expect(sim.frame().lights).toEqual([]);
    expect(sim.frame().shake).toBe(0);
    expect(undrawn(spec)).toEqual(["Sound Boom at 0.05 s isn't played here."]);
  });

  it('highlight and hit-stop act on the target when there is one', () => {
    const spec = burst([
      { type: 'highlight', duration: 0.2, color: '#ffffff', transparency: [0, 1] },
      { type: 'hitstop', seconds: 0.1 },
    ]);
    expect(at(spec, 0.05).highlight).toBeNull();
    const f = at(spec, 0.05, { target: true });
    expect(f.highlight!.fill).toBeGreaterThan(0.5);
    expect(f.hitstop).toBe(true);
    expect(placementOf(spec)).toEqual({ height: 3, dummy: true });
  });

  it('a spawn track plays another effect where it says', () => {
    const child = burst([], [emitter({ name: 'Child', emit: 3, speed: [0, 0] })]);
    child.name = 'Child';
    const parent = burst([{ type: 'spawn', at: 0.2, effect: 'Child', offset: [5, 0, 0] }]);
    const resolve = (n: string) => (n === 'Child' ? child : null);
    expect(sprites(at(parent, 0.1, { resolve }), 'Child')).toBeUndefined();
    const f = at(parent, 0.3, { resolve });
    expect(sprites(f, 'Child')!.items[0]!.p[0]).toBeCloseTo(5, 5);
    expect(effectLength(parent, resolve)).toBeCloseTo(1.2, 5);
    // An effect can't spawn itself for ever.
    const loop = burst([{ type: 'spawn', effect: 'Other' }]);
    expect(() => at(loop, 0.5, { resolve: () => loop })).not.toThrow();
  });

  it('looping tracks of an effect that stays on wrap round; its one-shot particle tracks never fire', () => {
    const spec: EffectSpec = { name: 'Aura', kind: 'persistent', tracks: [{ type: 'circle', name: 'Ring', loop: true, duration: 1, radius: [2, 4] }, { type: 'flash', name: 'Pop' }] };
    const r = (t: number) => Math.hypot(...(strips(at(spec, t), 'Ring')!.strips[0]![0]!.p.filter((_, i) => i !== 1) as [number, number]));
    expect(r(0.5)).toBeCloseTo(3, 1);
    expect(r(2.5)).toBeCloseTo(3, 1);
    expect(sprites(at(spec, 0.5), 'Pop')).toBeUndefined();
    expect(undrawn(spec).join(' ')).toMatch(/never fire/);
  });

  it('trail and beam effects are shown on a blade and between two points', () => {
    const trail = at(buildEffect('SlashTrail', 'SlashTrail'), 0.5);
    expect(solids(trail, 'blade')).toBeDefined();
    expect(strips(trail, 'SlashTrail')!.strips[0]!.length).toBeGreaterThan(3);
    const beam = at(buildEffect('EnergyBeam', 'EnergyBeam'), 0.5);
    const rows = strips(beam, 'EnergyBeam')!.strips[0]!;
    expect(rows[0]!.p[0]).toBeCloseTo(-5, 5);
    expect(rows[rows.length - 1]!.p[0]).toBeCloseTo(5, 5);
    expect(undrawn(buildEffect('SlashTrail', 'S')).join(' ')).toMatch(/swinging blade/);
  });
});

describe('every preset and worked example plays', () => {
  const all: EffectSpec[] = [...listEffectPresets().map((p) => buildEffect(p.id, p.id)), ...Object.keys(EXAMPLES).map((id) => exampleEffect(id, id)!)];

  it('with finite numbers, bounds that hold what it shows, and an end', () => {
    const resolve = (n: string) => all.find((e) => e.name === n) ?? null;
    for (const spec of all) {
      const place = placementOf(spec);
      const opts = { at: [0, place.height, 0] as [number, number, number], floor: 0, target: place.dummy, resolve };
      const b = effectBounds(spec, opts);
      for (const v of [...b.min, ...b.max, ...b.focus.min, ...b.focus.max, b.radius]) expect(Number.isFinite(v), spec.name).toBe(true);
      for (let i = 0; i < 3; i++) {
        expect(b.focus.min[i]!, spec.name).toBeGreaterThanOrEqual(b.min[i]! - 1e-6);
        expect(b.focus.max[i]!, spec.name).toBeLessThanOrEqual(b.max[i]! + 1e-6);
      }
      expect(b.activity.ink.some((v) => v > 0), spec.name).toBe(true);
      const sim = new EffectSim(spec, opts);
      sim.advance(spec.kind === 'burst' ? effectLength(spec, resolve) + 0.5 : 2);
      const f = sim.frame();
      const nums = f.layers.flatMap((l) => (l.kind === 'sprites' ? l.items.flatMap((s) => [...s.p, s.size, s.alpha]) : l.kind === 'strips' ? l.strips.flatMap((s) => s.flatMap((r) => [...r.p, r.half, r.alpha])) : l.kind === 'solids' ? l.items.flatMap((s) => [...s.p, ...s.size, s.alpha]) : [...l.p, l.alpha]));
      expect(nums.every(Number.isFinite), spec.name).toBe(true);
      if (spec.kind === 'burst') expect(sim.done, spec.name).toBe(true);
    }
  });
});

describe('triangles for the renderers', () => {
  const cam = lookFrom([0, 4, 20], [0, 3, 0]);

  it('makes a camera-facing quad per particle with its flipbook cell', () => {
    const spec = burst([], [emitter({ emit: 1, speed: [0, 0], size: [2], flipbook: { layout: 'Grid2x2', mode: 'OneShot' }, lifetime: [1, 1] })]);
    const batches = tessellate(at(spec, 0.6, { at: [0, 3, 0] }), cam, STAGES.dark);
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    expect(b.pos).toHaveLength(18);
    expect(b.tex).toBe(T.glow);
    // Cell 2 of a 2x2 grid: the left half, lower row (v = 0 is the image's top).
    expect([Math.min(...b.uv.filter((_, i) => i % 2 === 0)), Math.max(...b.uv.filter((_, i) => i % 2 === 0))]).toEqual([0, 0.5]);
    expect([Math.min(...b.uv.filter((_, i) => i % 2 === 1)), Math.max(...b.uv.filter((_, i) => i % 2 === 1))]).toEqual([0.5, 1]);
    // 2 studs across, facing the camera: every corner as far from it as the centre.
    const xs = b.pos.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 3);
    const depths = Array.from({ length: 6 }, (_, i) => vdot(vsub([b.pos[i * 3]!, b.pos[i * 3 + 1]!, b.pos[i * 3 + 2]!], cam.pos), cam.forward));
    expect(Math.max(...depths) - Math.min(...depths)).toBeLessThan(1e-6);
  });

  it('lays a ring flat, stretches a streak along its velocity, and squashes by powers of two', () => {
    const ring = tessellate(at(burst([{ type: 'ring', name: 'R', duration: 1, radius: 5 }]), 0.1), cam, STAGES.dark)[0]!;
    const ys = ring.pos.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-3);
    // Squash -3: eight times as long along its velocity, an eighth as wide.
    const streak = tessellate(at(burst([], [emitter({ emit: 1, size: [1], squash: [-3], orientation: 'VelocityParallel', direction: 'Right', speed: [1, 1] })]), 0.1), cam, STAGES.dark)[0]!;
    const sx = streak.pos.filter((_, i) => i % 3 === 0);
    const sy = streak.pos.filter((_, i) => i % 3 === 1);
    expect(Math.max(...sx) - Math.min(...sx)).toBeCloseTo(8, 2);
    expect(Math.max(...sy) - Math.min(...sy)).toBeCloseTo(0.125, 2);
  });

  it('draws solid parts first, then the ground, then the rest far to near; Neon parts get their glow', () => {
    const spec = burst([
      { type: 'particles', name: 'Near', offset: [0, 0, 5], texture: T.glow, color: ['#ffffff'], size: [1], transparency: [0], lifetime: [1, 1], speed: [0, 0], emit: 1 },
      { type: 'particles', name: 'Far', offset: [0, 0, -5], texture: T.glow, color: ['#ffffff'], size: [1], transparency: [0], lifetime: [1, 1], speed: [0, 0], emit: 1 },
      { type: 'decal', name: 'Mark', duration: 2, texture: T.puff, transparency: 0 },
      { type: 'shell', name: 'Core', shape: 'block', duration: 2, size: [2, 2, 2], transparency: 0.4, material: 'Neon' },
      { type: 'debris', name: 'Rocks', count: 2, lifetime: [2, 2] },
    ]);
    const batches = tessellate(at(spec, 0.1, { at: [0, 3, 0], floor: 0 }), cam, STAGES.dark, dummySolids([0, 3, 0]));
    const names = batches.map((b) => `${b.name}${b.opaque ? '!' : ''}${b.tex === GLOW_TEX ? '~' : ''}`);
    expect(names.slice(0, 3)).toEqual(['!', 'Rocks!', 'Mark']);
    expect(names.indexOf('Far')).toBeLessThan(names.indexOf('Near'));
    expect(names).toContain('Core~');
    // A block shows at most three of its six faces: back faces are not drawn.
    const core = batches.find((b) => b.name === 'Core' && !b.tex)!;
    expect(core.pos.length / 9).toBeLessThanOrEqual(6);
    expect(core.col[3]).toBeCloseTo(0.6, 5);
  });
});

describe('framing', () => {
  it('puts ground effects on the ground, hits at a character height, auras on a character', () => {
    expect(placementOf(exampleEffect('FireballImpact', 'F')!)).toEqual({ height: 0.05, dummy: false });
    expect(placementOf(buildEffect('HitSpark', 'H'))).toEqual({ height: 3, dummy: false });
    expect(placementOf(exampleEffect('HealAura', 'A')!)).toEqual({ height: 3, dummy: true });
  });

  it('holds the whole of what an effect shows in the picture', () => {
    for (const id of ['FireballImpact', 'LightningStrike', 'HolyPillar', 'WindSpin']) {
      const spec = exampleEffect(id, id)!;
      const place = placementOf(spec);
      const b = effectBounds(spec, { at: [0, place.height, 0], floor: 0 });
      for (const aspect of [0.7, 1.33, 2.2]) {
        const cam = cameraOf(frameEffect(b, aspect));
        const tan = Math.tan((cam.fov * Math.PI) / 360);
        for (let k = 0; k < 8; k++) {
          const p: [number, number, number] = [k & 1 ? b.focus.max[0] : b.focus.min[0], Math.max(0, k & 2 ? b.focus.max[1] : b.focus.min[1]), k & 4 ? b.focus.max[2] : b.focus.min[2]];
          const d = vsub(p, cam.pos);
          const z = vdot(d, cam.forward);
          expect(z, id).toBeGreaterThan(0);
          expect(Math.abs(vdot(d, cam.right) / (z * tan * aspect)), `${id} ${aspect}`).toBeLessThanOrEqual(1.001);
          expect(Math.abs(vdot(d, cam.up) / (z * tan)), `${id} ${aspect}`).toBeLessThanOrEqual(1.001);
        }
      }
    }
    // A beam reaching far ahead is looked at from the side.
    const far = burst([{ type: 'beam', name: 'B', duration: 1, to: [0, 0, -300], width: [8, 8] }]);
    expect(frameEffect(effectBounds(far, { at: [0, 3, 0], floor: 0 })).azimuth).toBeGreaterThan(1);
  });
});
