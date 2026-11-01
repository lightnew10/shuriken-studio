import { describe, expect, it } from 'vitest';
import { EASES } from '@shared/effects';
import { arc, ballistic, bezier, bezierEase, catmullRom, colorKeys, curveKeys, EASE_FUNCTIONS, easer, fromFunction, hexToRgb, polyline, rgbToHex, sampleColor, sampleCurve, spiral, type Vec3 } from '@shared/curves';
import { FX_CURVES_MODULE } from '@core/effects/runtime/curves';
import { angles, anglesRad, lookRotation, mapply, mmul, noise1, seeded, xf, xfMul, xfPoint } from '@shared/fx/math';

const near = (a: number[], b: number[], digits = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

describe('easings', () => {
  it('every named easing exists here and in ShurikenCurves, starts at 0 and ends at 1', () => {
    for (const name of EASES) {
      const f = EASE_FUNCTIONS[name]!;
      expect(f, name).toBeTypeOf('function');
      expect(f(0), name).toBeCloseTo(0, 6);
      expect(f(1), name).toBeCloseTo(1, 6);
      // The Luau module has the same name in its EASE table.
      expect(new RegExp(`^\\t${name} = `, 'm').test(FX_CURVES_MODULE), `${name} in ShurikenCurves`).toBe(true);
    }
    expect(Object.keys(EASE_FUNCTIONS).sort()).toEqual([...EASES].sort());
  });

  it('have the known shapes (Penner)', () => {
    const at = (name: string, t: number) => EASE_FUNCTIONS[name]!(t);
    expect(at('quadIn', 0.5)).toBeCloseTo(0.25, 9);
    expect(at('quadOut', 0.5)).toBeCloseTo(0.75, 9);
    expect(at('cubicInOut', 0.25)).toBeCloseTo(0.0625, 9);
    expect(at('quartOut', 0.5)).toBeCloseTo(0.9375, 9);
    expect(at('quintIn', 0.5)).toBeCloseTo(0.03125, 9);
    expect(at('sineInOut', 0.5)).toBeCloseTo(0.5, 9);
    expect(at('expoOut', 0.5)).toBeCloseTo(1 - 2 ** -5, 9);
    expect(at('expoIn', 0.5)).toBeCloseTo(2 ** -5, 9);
    expect(at('circOut', 0.5)).toBeCloseTo(Math.sqrt(0.75), 9);
    // Back overshoots past 1, then settles; elastic rings; bounce stays within 0..1.
    expect(at('backOut', 0.5)).toBeCloseTo(1.0876975, 6);
    expect(at('backIn', 0.5)).toBeCloseTo(-0.0876975, 6);
    expect(at('elasticOut', 0.1)).toBeCloseTo(1.25, 2);
    expect(at('bounceOut', 0.5)).toBeCloseTo(0.765625, 9);
    expect(at('bounceIn', 0.5)).toBeCloseTo(0.234375, 9);
    expect(at('step', 0.99)).toBe(0);
    for (const name of ['sineIn', 'quadOut', 'cubicInOut', 'expoInOut', 'circInOut', 'quintIn']) for (let t = 0.05; t < 1; t += 0.05) expect(at(name, t + 0.05), name).toBeGreaterThanOrEqual(at(name, t) - 1e-9);
    // In and out mirror each other.
    for (const p of ['quad', 'cubic', 'quart', 'quint', 'sine', 'expo', 'circ']) for (const t of [0.2, 0.7]) expect(at(`${p}In`, t)).toBeCloseTo(1 - at(`${p}Out`, 1 - t), 9);
  });

  it('cubic-bezier easings match CSS', () => {
    const ease = bezierEase(0.25, 0.1, 0.25, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
    expect(bezierEase(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5);
    expect(easer([0.42, 0, 0.58, 1])(0.5)).toBeCloseTo(0.5, 4);
    expect(easer('nope' as never)(0.4)).toBe(0.4);
    expect(easer(undefined)(0.4)).toBe(0.4);
  });
});

describe('data curves', () => {
  it('sample a constant, evenly spaced values and eased keys', () => {
    expect(sampleCurve(3, 0.7)).toBe(3);
    expect(sampleCurve(undefined, 0.7, 9)).toBe(9);
    expect(sampleCurve([2, 4, 10], 0.25)).toBeCloseTo(3, 9);
    expect(sampleCurve([2, 4, 10], 0.75)).toBeCloseTo(7, 9);
    expect(sampleCurve([5], 0.5)).toBe(5);
    const keyed = { keys: [[0, 0], [0.5, 10], [1, 0]] as Array<[number, number]>, ease: 'quadOut' as const };
    expect(sampleCurve(keyed, 0.25)).toBeCloseTo(7.5, 9);
    expect(sampleCurve(keyed, 0.5)).toBe(10);
    expect(sampleCurve(keyed, -1)).toBe(0);
    expect(sampleCurve(keyed, 2)).toBe(0);
    // Keys that don't start at 0 or end at 1 hold their ends.
    expect(sampleCurve({ keys: [[0.2, 4], [0.6, 8]] }, 0.1)).toBe(4);
    expect(sampleCurve({ keys: [[0.2, 4], [0.6, 8]] }, 0.9)).toBe(8);
  });

  it('sample colours, and turn curves into the keypoints a Roblox sequence holds', () => {
    near(sampleColor(['#000000', '#ffffff'], 0.5), [0.5, 0.5, 0.5]);
    near(sampleColor('#ff8000', 0.3), [1, 128 / 255, 0]);
    near(sampleColor(undefined, 0.3, '#00ff00'), [0, 1, 0]);
    near(sampleColor({ keys: [[0, '#ff0000'], [1, '#0000ff']], ease: 'quadIn' }, 0.5), [0.75, 0, 0.25]);
    expect(rgbToHex(hexToRgb('#3ce1ff'))).toBe('#3ce1ff');
    expect(rgbToHex([2, -1, 0.5])).toBe('#ff0080');
    expect(curveKeys(4, 2)).toEqual([[0, 8]]);
    expect(curveKeys([1, 2, 3])).toEqual([[0, 1], [0.5, 2], [1, 3]]);
    expect(curveKeys({ keys: [[0, 1], [1, 5]] })).toEqual([[0, 1], [1, 5]]);
    // An eased curve is sampled, so the sequence follows the eased shape (16 keys of the 20 Roblox allows).
    const eased = curveKeys({ keys: [[0, 0], [1, 10]], ease: 'quadOut' });
    expect(eased).toHaveLength(16);
    expect(eased[0]).toEqual([0, 0]);
    expect(eased[15]![1]).toBeCloseTo(10, 9);
    expect(eased[8]![1]).toBeGreaterThan(10 * (8 / 15));
    expect(colorKeys(['#ff0000', '#00ff00'])).toEqual([[0, '#ff0000'], [1, '#00ff00']]);
    expect(colorKeys({ keys: [[0, '#000000'], [1, '#ffffff']], ease: 'cubicIn' })).toHaveLength(12);
  });
});

describe('paths at even speed', () => {
  it('re-parameterises any curve by arc length', () => {
    // A curve that crawls, then races: by distance it moves evenly.
    const path = fromFunction((s) => [s * s * 10, 0, 0], 256);
    expect(path.length).toBeCloseTo(10, 3);
    for (const u of [0.1, 0.25, 0.5, 0.9]) expect(path.at(u)[0]).toBeCloseTo(u * 10, 1);
    expect(path.raw(0.5)[0]).toBeCloseTo(2.5, 9);
    near(path.tangent(0.5), [1, 0, 0]);
    expect(path.param(0.25)).toBeCloseTo(0.5, 2);
    near(path.at(-1), [0, 0, 0]);
    near(path.at(2), [10, 0, 0]);
  });

  it('draws arcs, spirals, lines and lobs where ShurikenCurves does', () => {
    // 0° is forward (-z); positive angles turn left (-x).
    const quarter = arc(4, 0, 90);
    near(quarter.at(0), [0, 0, -4]);
    near(quarter.at(1), [-4, 0, 0]);
    expect(quarter.length).toBeCloseTo(2 * Math.PI, 2);
    near(quarter.at(0.5), [-4 * Math.SQRT1_2, 0, -4 * Math.SQRT1_2], 2);
    const helix = spiral(2, 2, 1, 6);
    near(helix.at(0), [0, 0, -2]);
    near(helix.at(1), [0, 6, -2], 4);
    expect(helix.at(0.5)[1]).toBeCloseTo(3, 1);
    expect(Math.hypot(helix.at(0.3)[0], helix.at(0.3)[2])).toBeCloseTo(2, 5);
    const line = polyline([[0, 0, 0], [10, 0, 0], [10, 5, 0]]);
    expect(line.length).toBeCloseTo(15, 6);
    near(line.at(2 / 3), [10, 0, 0], 4);
    const lob = ballistic([0, 0, 0], [20, 0, 0], 5);
    near(lob.at(0), [0, 0, 0]);
    near(lob.at(1), [20, 0, 0]);
    expect(lob.raw(0.5)[1]).toBeCloseTo(5, 6);
    const curve = bezier([0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]);
    near(curve.raw(0.5), [5, 7.5, 0]);
  });

  it('passes a Catmull-Rom spline through its points', () => {
    const pts: Vec3[] = [[0, 0, 0], [4, 2, 0], [8, 0, 3], [12, 5, 3]];
    const path = catmullRom(pts);
    near(path.raw(0), pts[0]!);
    near(path.raw(1 / 3), pts[1]!);
    near(path.raw(2 / 3), pts[2]!);
    near(path.raw(1), pts[3]!);
    expect(path.length).toBeGreaterThan(Math.hypot(4, 2) + Math.hypot(4, 2, 3) + Math.hypot(4, 5));
    // Closed: it comes back to where it started.
    const loop = catmullRom(pts, 0.5, true);
    near(loop.raw(0), loop.raw(1), 4);
    // One point is a point; two a straight line.
    near(catmullRom([[1, 2, 3]]).at(0.5), [1, 2, 3]);
    near(catmullRom([[0, 0, 0], [10, 0, 0]]).at(0.5), [5, 0, 0], 3);
  });
});

describe('placement math (Roblox conventions)', () => {
  it('CFrame.Angles is Rx * Ry * Rz, in degrees', () => {
    near(mapply(angles([90, 0, 0]), [0, 1, 0]), [0, 0, 1]);
    near(mapply(angles([0, 90, 0]), [0, 0, -1]), [-1, 0, 0]);
    near(mapply(angles([0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
    near(mapply(angles(undefined), [1, 2, 3]), [1, 2, 3]);
    // Rz is applied first, then Ry, then Rx.
    near(mapply(angles([90, 0, 90]), [1, 0, 0]), mapply(mmul(anglesRad(Math.PI / 2, 0, 0), anglesRad(0, 0, Math.PI / 2)), [1, 0, 0]));
    near(mapply(angles([90, 0, 90]), [1, 0, 0]), [0, 0, 1]);
  });

  it('lookAt points -z along the direction, and placements compose like CFrames', () => {
    const r = lookRotation([1, 0, 0]);
    near(mapply(r, [0, 0, -1]), [1, 0, 0]);
    near(mapply(r, [0, 1, 0]), [0, 1, 0]);
    near(mapply(lookRotation([0, 1, 0]), [0, 0, -1]), [0, 1, 0]);
    const world = xfMul(xf([10, 0, 0], angles([0, 90, 0])), xf([0, 0, -2]));
    near(world.p, [8, 0, 0]);
    near(xfPoint(xf([1, 2, 3], angles([0, 180, 0])), [1, 0, 0]), [0, 2, 3]);
  });

  it('gives the same random numbers and noise for the same seed', () => {
    const a = seeded(42);
    const b = seeded(42);
    const c = seeded(43);
    const run = (r: () => number) => Array.from({ length: 5 }, r);
    const first = run(a);
    expect(run(b)).toEqual(first);
    expect(run(c)).not.toEqual(first);
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    for (const t of [0, 0.3, 1.7, 12.25]) {
      expect(noise1(t, 3)).toBe(noise1(t, 3));
      expect(Math.abs(noise1(t, 3))).toBeLessThanOrEqual(1);
    }
    // Smooth: a small step in time is a small step in value.
    expect(Math.abs(noise1(2.5, 1) - noise1(2.51, 1))).toBeLessThan(0.1);
  });
});
