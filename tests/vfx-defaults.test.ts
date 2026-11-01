import { describe, expect, it } from 'vitest';
import { validateEffect, withEmitterDefaults, type EffectSpec } from '../src/shared/effects';

// Three effects in one build were refused with "transparency needs 1–8 values" because an emitter left the list out.
describe('an emitter that says nothing about its transparency', () => {
  const spec = {
    name: 'DroneSmoke',
    kind: 'persistent',
    emitters: [
      { name: 'Smoke', texture: 'rbxasset://textures/particles/smoke_main.dds', color: ['#cfc9c1'], size: [1.5, 3.5], transparency: [0.35, 1], lifetime: [1.2, 1.8], rate: 12, speed: [3, 6] },
      { name: 'Sparks', texture: 'rbxasset://textures/particles/fire_sparks_main.dds', color: ['#ffffff'], size: [0.4, 0.15], lifetime: [0.2, 0.4], rate: 5, speed: [10, 16] },
    ],
  } as unknown as EffectSpec;

  it('fades out over its life instead of being refused', () => {
    expect(validateEffect(spec).join(' ')).toMatch(/emitter Sparks transparency needs 1–8 values/);
    const filled = withEmitterDefaults(spec);
    expect(validateEffect(filled)).toEqual([]);
    const [smoke, sparks] = (filled as unknown as { emitters: Array<{ transparency: number[] }> }).emitters;
    expect(sparks!.transparency).toEqual([0, 1]);
    // What was given is kept.
    expect(smoke!.transparency).toEqual([0.35, 1]);
  });

  it('holds for particle tracks of a timed effect, and leaves other tracks alone', () => {
    const burst = { name: 'Pop', kind: 'burst', duration: 1, tracks: [{ type: 'particles', name: 'Seeds', texture: 'rbxasset://textures/particles/sparkles_main.dds', color: ['#fff2a0'], size: [0.3], lifetime: [0.4, 0.6], speed: [8, 12], emit: 6 }, { type: 'flash', name: 'Pop', duration: 0.1 }] } as unknown as EffectSpec;
    const filled = withEmitterDefaults(burst) as unknown as { tracks: Array<Record<string, unknown>> };
    expect(filled.tracks[0]!.transparency).toEqual([0, 1]);
    expect(filled.tracks[1]).not.toHaveProperty('transparency');
  });
});
