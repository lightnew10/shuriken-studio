import { describe, expect, it } from 'vitest';
import { validateClip } from '@shared/animation';
import { parseRig, type Vec3 } from '@shared/rig';
import { checkRigClip, generateRigClip, RIG_MOTIONS, type RigBody } from '../src/core/animation/rig-motion';
import { biped, griever, snake } from './rig-motion.fixtures';

const valid = (b: RigBody, c: Parameters<typeof validateClip>[0]) => expect(validateClip(c, b.rig)).toEqual([]);

describe('custom rig motion', () => {
  it('reads Kiln limits: hinge [min, max] about its axis, ball per Blender axis turned into Roblox axes', () => {
    const r = griever().rig;
    const hip = r.joints.find((j) => j.name === 'LegL0_0')!;
    // Blender ((-35,-25,-35),(35,25,35)): Roblox x = -Blender x (range flips), y = Blender z, z = Blender y.
    expect(hip.limits).toEqual({ min: [-35, -35, -25], max: [35, 35, 25] });
    expect(r.joints.find((j) => j.name === 'LegL0_1')!.limits).toEqual({ min: [-45], max: [45] });
    const asym = parseRig({ joints: [{ name: 'A', pivot: [0, 0, 0], kind: 'ball', limits: [[-10, -20, -30], [40, 50, 60]] }] });
    expect(typeof asym !== 'string' && asym.joints[0]!.limits).toEqual({ min: [-40, -30, -20], max: [10, 60, 50] });
  });

  for (const make of [griever, biped]) {
    for (const run of [false, true]) {
      it(`${make.name} ${run ? 'runs' : 'walks'}: feet planted and moving back at the ground speed, nothing in the ground, loop closes`, () => {
        const b = make();
        const g = generateRigClip(b, run ? 'run' : 'walk', run ? 'Run' : 'Walk');
        valid(b, g.clip);
        expect(g.clip.loop).toBe(true);
        expect(g.groundSpeed).toBeGreaterThan(0.5);
        const { metrics, findings } = checkRigClip(b, g.clip);
        expect(findings).toEqual([]);
        expect(metrics.groundSpeed).toBeGreaterThan(0.6 * g.groundSpeed!);
        expect(metrics.groundSpeed).toBeLessThan(1.4 * g.groundSpeed!);
        expect(Math.max(...metrics.feet.map((f) => f.slide))).toBeLessThan(0.35 * g.groundSpeed!);
        expect(metrics.sink?.depth ?? 0).toBeLessThan(0.1);
        expect(g.clip.markers!.every((m) => m.name === 'Step')).toBe(true);
        expect(g.notes).toEqual([]);
      });
    }
  }

  it('asks for speed: the cycle matches it', () => {
    const b = griever();
    const g = generateRigClip(b, 'walk', 'Walk', { speed: 6 });
    expect(g.groundSpeed).toBeCloseTo(6, 0);
    expect(checkRigClip(b, g.clip).metrics.groundSpeed).toBeGreaterThan(4.5);
  });

  it('eight legs alternate in two groups of four (tetrapod); "wave" ripples them', () => {
    const g = generateRigClip(griever(), 'walk', 'Walk');
    expect(g.clip.markers!.length).toBe(2);
    expect(g.clip.markers![0]!.value!.split(',').length).toBe(4);
    const w = generateRigClip(griever(), 'walk', 'Crawl', { gait: 'wave' });
    expect(w.clip.markers!.length).toBe(8);
  });

  it('slithers: a wave along the body that loops', () => {
    const b = snake();
    const g = generateRigClip(b, 'slither', 'Slither');
    valid(b, g.clip);
    expect(Object.keys(g.clip.keys[0]!.poses)).toHaveLength(10);
    const { findings, metrics } = checkRigClip(b, g.clip);
    expect(findings).toEqual([]);
    expect(metrics.sink?.depth ?? 0).toBeLessThan(0.05);
    expect(g.groundSpeed).toBeGreaterThan(0);
  });

  it('stings with the tail: the stinger lands in front of the body at Hit', () => {
    const b = griever();
    const g = generateRigClip(b, 'sting', 'Sting');
    valid(b, g.clip);
    expect(g.notes).toEqual([]);
    const { metrics, findings } = checkRigClip(b, g.clip);
    expect(findings).toEqual([]);
    const hit = metrics.markers.find((m) => m.name === 'Hit')!;
    // f is forward from the root joint; the body's front is 1.6 studs ahead of it.
    expect(hit.attachments.Stinger_Tip![2]).toBeGreaterThan(1.6);
  });

  for (const motion of ['idle', 'lunge', 'slam', 'hit', 'death'] as const) {
    for (const make of [griever, biped]) {
      it(`${make.name} ${motion}: valid, feet stay put, nothing sinks`, () => {
        const b = make();
        const g = generateRigClip(b, motion, `${make.name}${motion}`);
        valid(b, g.clip);
        const { metrics, findings } = checkRigClip(b, g.clip);
        expect(findings).toEqual([]);
        expect(metrics.sink?.depth ?? 0).toBeLessThan(0.15);
        expect(g.notes).toEqual([]);
      });
    }
  }

  it('dies lying on the ground, legs curled for a many-legged rig', () => {
    const b = griever();
    const g = generateRigClip(b, 'death', 'Death');
    expect(g.clip.loop).toBe(false);
    expect(g.clip.markers!.map((m) => m.name)).toEqual(['Impact', 'Dead']);
    const last = g.clip.keys[g.clip.keys.length - 1]!;
    expect(last.poses.Body!.pos![1]).toBeLessThan(0);
  });

  it('flags what a rig cannot do: past limits, a hinge off its axis, a joint that is not there', () => {
    const b = griever();
    const clip = { name: 'Bad', rig: 'Griever', loop: false, priority: 'Action' as const, keys: [
      { t: 0, poses: { LegL0_1: { rot: [0, 0, 0] as Vec3 } } },
      { t: 0.5, poses: { LegL0_1: { rot: [0, 0, 80] as Vec3 }, LegL0_2: { rot: [30, 0, 0] as Vec3 }, Body: { rot: [0, 0, 0] as Vec3, pos: [0, -2, 0] as Vec3 } } },
    ] };
    const { findings } = checkRigClip(b, clip);
    expect(findings.join('\n')).toMatch(/LegL0_1 bends 80° .* past its limits/);
    expect(findings.join('\n')).toMatch(/LegL0_2 is a hinge .* another axis/);
    expect(findings.join('\n')).toMatch(/sinks .* into the ground/);
    expect(validateClip({ ...clip, keys: [...clip.keys, { t: 1, poses: { Wing: { rot: [0, 0, 0] as Vec3 } } }] }, b.rig).join('\n')).toMatch(/unknown joint "Wing"/);
  });

  it('every motion is described', () => {
    expect(RIG_MOTIONS.length).toBe(9);
  });

  it('says why a legless rig cannot walk', () => {
    expect(() => generateRigClip(snake(), 'walk', 'Walk')).toThrow(/no legs/);
  });
});

