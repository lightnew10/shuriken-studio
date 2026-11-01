import { circ, cubic, ell, ellR, mirror, path, poly, quad, rbox, scalePts, strokePts, taper, type P2 } from './geo';
import { inner, part, shift, shine, T, type Part, type PropCtx, type PropDef, type Tone } from './kit';

/**
 * Creatures and mounts: slime, cat, dog, bunny and wolf as chunky front-facing heads with faces; horse, unicorn and
 * dragon as heads in profile; a phoenix with its wings of flame spread — the pet, mount and boss icons of simulator
 * and fantasy games. The variant tints the fur, scales or feathers.
 */

const tone = (hi: string, mid: string, lo: string): Tone => ({ hi, mid, lo });
const EYE = tone('#5a4a78', '#1c1428', '#06040a');
const PINK = tone('#ffd8e8', '#ff8ab8', '#c84a80');
const BLUSH = tone('#ffb0c8', '#ff8aa8', '#e05a80');

/** A shiny cartoon eye: dark, a big glint and a small one. */
function eye(c: PropCtx, x: number, y: number, rx: number, ry: number): Part[] {
  return [inner(ell(x, y, rx, ry), 'gloss', EYE, { line: 0 }), shine(circ(x - rx * 0.32, y - ry * 0.35, Math.max(1.4, rx * 0.42)), 0.95), ...(c.detail > 0 ? [shine(circ(x + rx * 0.3, y + ry * 0.35, Math.max(0.8, rx * 0.2)), 0.85)] : [])];
}
const blush = (x: number, y: number, rx = 6, ry = 3.6) => inner(ell(x, y, rx, ry), 'flat', BLUSH, { line: 0, plain: true, fx: { fillOpacity: 0.55 } });
const stroke = (pts: P2[], w: number, t: Tone = EYE) => inner(poly(strokePts(pts, w)), 'flat', t, { line: 0, plain: true });

/** A horse's head and neck in profile, facing right. */
const HORSE_HEAD: P2[] = path([[10, 98]], cubic([10, 98], [10, 76], [17, 48], [31, 27], 12), quad([31, 27], [40, 14], [53, 16], 8), cubic([53, 16], [67, 24], [81, 40], [89, 54], 12), cubic([89, 54], [96, 64], [93, 78], [80, 78], 10), [[70, 78]], cubic([70, 78], [61, 76], [56, 67], [53, 61], 8), cubic([53, 61], [46, 67], [44, 82], [47, 98], 10));
/** Points along the back of the horse's neck (where the mane grows), t = 0 at the withers. */
const neckBack = (t: number): P2 => {
  const [a, b, c, d]: P2[] = [[10, 98], [10, 76], [17, 48], [31, 27]];
  const u = 1 - t;
  return [u * u * u * a![0] + 3 * u * u * t * b![0] + 3 * u * t * t * c![0] + t * t * t * d![0], u * u * u * a![1] + 3 * u * u * t * b![1] + 3 * u * t * t * c![1] + t * t * t * d![1]];
};

function horse(c: PropCtx, coat: Tone, mane: Tone[], horn: boolean): Array<Part | false> {
  const strands: Array<Part | false> = [];
  // Locks of mane flowing down and back from the crest of the neck.
  [0.06, 0.24, 0.42, 0.6, 0.78, 0.94].forEach((t, i) => {
    const [x, y] = neckBack(t);
    const m = mane[i % mane.length]!;
    strands.push(part(poly(taper(cubic([x + 8, y - 4], [x - 2, y - 4], [x - 10, y + 6], [x - 9, y + 20], 12), 18, 1.5)), 'gloss', m));
  });
  return [
    part(poly([[34, 28], [37, 3], [49, 19]], 2.5), 'matte', coat),
    ...strands,
    part(poly(HORSE_HEAD), 'gloss', coat, { shadow: true }),
    inner(poly([[36, 25], [38, 9], [45, 20]], 1.5), 'flat', PINK, { line: 0, plain: true }),
    !horn && inner(poly(taper(quad([57, 22], [72, 34], [84, 52], 10), 6, 2)), 'flat', T.white, { line: 0, plain: true, opacity: 0.9, fx: { fillOpacity: 0.9 } }),
    part(poly(taper(quad([44, 20], [52, 24], [57, 34], 8), 12, 1)), 'gloss', mane[0]!),
    ...eye(c, 59, 37, 5, 5.8),
    inner(ellR(86, 64, 2.8, 4.6, 30), 'flat', shift(coat, -0.55), { line: 0, plain: true }),
    stroke([[74, 72], [87, 72]], 1.6, shift(coat, -0.55)),
    horn && part(poly(taper([[52, 20], [56, 11], [61, 1]], 9, 0.6)), 'metal', T.gold, { fx: { patterns: [{ kind: 'stripes', color: '#b8740a', opacity: 0.55, size: 3.2 * c.u, angle: 60, duty: 0.35 }] } }),
    shine(ellR(64, 30, 7, 2.6, 38), 0.45),
  ];
}

export const CREATURES: Record<string, PropDef> = {
  slime: {
    about: 'a jelly slime with a happy face',
    draw: (c) => {
      const t = c.main(tone('#d8ffc0', '#5ad84a', '#1a7a2a'));
      const body = path(cubic([7, 88], [3, 58], [24, 16], [50, 15], 14), cubic([50, 15], [76, 16], [97, 58], [93, 88], 14), quad([93, 88], [86, 95], [72, 94], 6), quad([72, 94], [50, 92], [28, 94], 8), quad([28, 94], [14, 95], [7, 88], 6));
      return [
        part(poly(body), 'gloss', t),
        ...eye(c, 35, 57, 6.5, 8.5),
        ...eye(c, 65, 57, 6.5, 8.5),
        stroke(quad([42, 71], [50, 79], [58, 71], 10), 3.2, shift(t, -0.6)),
        blush(24, 69),
        blush(76, 69),
        shine(ellR(30, 32, 11, 6, -32), 0.8),
        shine(circ(46, 22, 2.8), 0.75),
        c.detail > 0 && shine(circ(78, 40, 3.4), 0.35),
      ];
    },
  },

  cat: {
    about: 'a cat\'s face',
    draw: (c) => {
      const fur = c.main(tone('#ffe0b0', '#ff9a3c', '#b45a10'));
      const ear: P2[] = [[10, 46], [17, 6], [45, 27]];
      const earIn: P2[] = [[18, 38], [21, 16], [37, 28]];
      return [
        part(poly(ear, 4), 'gloss', fur),
        part(poly(mirror(ear), 4), 'gloss', fur),
        part(ell(50, 59, 42, 34), 'gloss', fur, { shadow: true }),
        inner(poly(earIn, 3), 'flat', PINK, { line: 0, plain: true }),
        inner(poly(mirror(earIn), 3), 'flat', PINK, { line: 0, plain: true }),
        inner(poly(taper([[50, 27], [50, 38]], 4.5, 1)), 'flat', shift(fur, -0.3), { line: 0, plain: true }),
        inner(poly(taper([[41, 29], [43, 37]], 3.5, 1)), 'flat', shift(fur, -0.3), { line: 0, plain: true }),
        inner(poly(taper([[59, 29], [57, 37]], 3.5, 1)), 'flat', shift(fur, -0.3), { line: 0, plain: true }),
        inner(ell(43, 72, 9.5, 7.5), 'matte', T.cream, { line: 0 }),
        inner(ell(57, 72, 9.5, 7.5), 'matte', T.cream, { line: 0 }),
        ...eye(c, 33, 56, 6.8, 8.6),
        ...eye(c, 67, 56, 6.8, 8.6),
        inner(poly([[45.5, 64], [54.5, 64], [50, 69.5]], 2), 'gloss', PINK, { line: 0.5 }),
        stroke([[44, 74], [47, 76.5], [50, 73.5], [53, 76.5], [56, 74]], 1.6),
        c.detail > 0 && stroke([[22, 70], [6, 66]], 1.3),
        c.detail > 0 && stroke([[22, 75], [7, 77]], 1.3),
        c.detail > 0 && stroke([[78, 70], [94, 66]], 1.3),
        c.detail > 0 && stroke([[78, 75], [93, 77]], 1.3),
        blush(23, 67),
        blush(77, 67),
        shine(ellR(30, 36, 9, 3.6, -22), 0.45),
      ];
    },
  },

  dog: {
    about: 'a puppy\'s face with floppy ears',
    draw: (c) => {
      const fur = c.main(tone('#ffeac0', '#f2b860', '#a8641e'));
      const ear = shift(fur, -0.35);
      return [
        part(ellR(17, 50, 12, 25, 16), 'gloss', ear),
        part(ellR(83, 50, 12, 25, -16), 'gloss', ear),
        part(ell(50, 52, 35, 37), 'gloss', fur, { shadow: true }),
        inner(ellR(64, 45, 11, 12, 10), 'matte', ear, { line: 0 }),
        inner(ell(50, 72, 21, 16), 'matte', T.cream, { line: 0.7 }),
        ...eye(c, 36, 46, 6, 7.4),
        ...eye(c, 64, 46, 6, 7.4),
        inner(ell(50, 64, 8.5, 6.2), 'gloss', EYE, { line: 0 }),
        shine(ell(47.5, 62, 3, 1.8), 0.85),
        stroke([[50, 70], [50, 74]], 1.6),
        stroke(quad([42, 74], [46, 78], [50, 74], 6), 1.6),
        stroke(quad([50, 74], [54, 78], [58, 74], 6), 1.6),
        inner(ellR(55, 82, 5, 6, -10), 'gloss', PINK, { line: 0.6 }),
        blush(27, 60),
        blush(73, 60),
        shine(ellR(36, 26, 9, 3.6, -18), 0.45),
      ];
    },
  },

  bunny: {
    about: 'a bunny\'s face with long ears',
    draw: (c) => {
      const fur = c.main(tone('#ffffff', '#f0e6ff', '#a898d0'));
      return [
        part(rbox(35, 26, 16, 48, -12, 8), 'gloss', fur),
        part(rbox(65, 26, 16, 48, 12, 8), 'gloss', fur),
        inner(rbox(35, 27, 7.5, 36, -12, 3.7), 'flat', PINK, { line: 0, plain: true }),
        inner(rbox(65, 27, 7.5, 36, 12, 3.7), 'flat', PINK, { line: 0, plain: true }),
        part(ell(50, 66, 37, 30), 'gloss', fur, { shadow: true }),
        ...eye(c, 36, 63, 5.8, 7.2),
        ...eye(c, 64, 63, 5.8, 7.2),
        inner(ell(50, 73, 4.2, 3), 'gloss', PINK, { line: 0.5 }),
        stroke([[50, 76], [50, 79]], 1.5),
        inner(rbox(47.6, 82.5, 4.6, 6, 0, 1), 'matte', T.white, { line: 0.6 }),
        inner(rbox(52.4, 82.5, 4.6, 6, 0, 1), 'matte', T.white, { line: 0.6 }),
        blush(24, 74),
        blush(76, 74),
        shine(ellR(34, 46, 9, 3.4, -18), 0.45),
      ];
    },
  },

  wolf: {
    about: 'a wolf\'s head with golden eyes',
    draw: (c) => {
      const fur = c.main(tone('#d8e2f2', '#7d8cab', '#2c3450'));
      const right: P2[] = [[50, 18], [72, 22], [85, 36], [95, 55], [85, 59], [91, 69], [75, 73], [63, 87], [50, 93]];
      const mask: P2[] = [[50, 46], [61, 54], [72, 68], [62, 82], [50, 89]];
      const ear: P2[] = [[13, 44], [19, 3], [44, 25]];
      const eyeL = (sgn: 1 | -1): Array<Part | false> => {
        const x = 50 - sgn * 15;
        return [inner(ellR(x, 52, 7.5, 4.6, sgn * 16), 'glow', tone('#fffbd0', '#ffd23a', '#e08a00'), { line: 0.7, lineColor: '#140c04' }), inner(ellR(x, 52, 1.6, 4, 0), 'flat', EYE, { line: 0, plain: true }), c.detail > 0 && shine(circ(x - 2, 50.5, 1.2), 0.9)];
      };
      return [
        part(poly(ear, 3), 'gloss', fur),
        part(poly(mirror(ear), 3), 'gloss', fur),
        part(poly(path(right, mirror(right)), 1.5), 'gloss', fur, { shadow: true }),
        inner(poly([[21, 36], [23, 14], [37, 27]], 2), 'flat', shift(fur, -0.4), { line: 0, plain: true }),
        inner(poly(mirror([[21, 36], [23, 14], [37, 27]]), 2), 'flat', shift(fur, -0.4), { line: 0, plain: true }),
        inner(poly(path(mask, mirror(mask)), 3), 'matte', T.cream, { line: 0 }),
        ...eyeL(1),
        ...eyeL(-1),
        inner(poly(taper([[26, 42], [43, 47]], 1, 4)), 'flat', shift(fur, -0.55), { line: 0, plain: true }),
        inner(poly(taper([[74, 42], [57, 47]], 1, 4)), 'flat', shift(fur, -0.55), { line: 0, plain: true }),
        inner(poly([[42, 69], [58, 69], [50, 78]], 3.5), 'gloss', EYE, { line: 0 }),
        shine(ell(46.5, 71, 2.6, 1.4), 0.8),
        stroke([[50, 78], [50, 82]], 1.5),
        shine(ellR(36, 28, 8, 3, -14), 0.4),
      ];
    },
  },

  horse: {
    about: 'a horse\'s head in profile',
    draw: (c) => horse(c, c.main(tone('#f6c08a', '#b8642a', '#58280c')), [tone('#7a4a2a', '#4a2410', '#1e0c04')], false),
  },

  unicorn: {
    about: 'a unicorn\'s head with a golden horn and a rainbow mane',
    draw: (c) => horse(c, c.main(tone('#ffffff', '#f6f0ff', '#a898d0')), [tone('#ffd0ec', '#ff6ab8', '#a01a6a'), tone('#e4c8ff', '#a66aff', '#4a1aa0'), tone('#c8e8ff', '#4aa8ff', '#1a4aa0'), tone('#d0ffe8', '#3ed8a0', '#0a7a4a')], true),
  },

  dragon: {
    about: 'a horned dragon\'s head in profile',
    draw: (c) => {
      const scales = c.main(tone('#c8f8a0', '#3fae4a', '#13502a'));
      const head = path([[18, 98]], cubic([18, 98], [16, 78], [18, 58], [26, 46], 10), cubic([26, 46], [30, 34], [40, 28], [52, 28], 10), cubic([52, 28], [66, 30], [80, 38], [90, 44], 10), quad([90, 44], [97, 48], [92, 56], 6), [[66, 59], [88, 63]], quad([88, 63], [86, 70], [74, 72], 6), cubic([74, 72], [62, 76], [52, 74], [48, 72], 8), cubic([48, 72], [44, 80], [44, 90], [46, 98], 8));
      const spike = (x: number, y: number, dx: number, dy: number) => part(poly([[x, y - 5], [x + dx, y + dy], [x + 1, y + 6]], 1.5), 'gloss', shift(scales, -0.25));
      return [
        part(poly(taper(quad([36, 31], [18, 22], [6, 4], 12), 11, 1)), 'matte', T.bone),
        part(poly(taper(quad([28, 42], [12, 38], [3, 24], 10), 8, 1)), 'matte', shift(T.bone, -0.1)),
        spike(20, 60, -14, 2),
        spike(17, 76, -13, 6),
        spike(15, 90, -12, 8),
        part(poly(head), 'gloss', scales, { shadow: true, fx: { patterns: [{ kind: 'scales', color: scales.lo, opacity: 0.28, size: 7 * c.u }] } }),
        inner(poly(path([[46, 74]], quad([46, 74], [41, 86], [43, 98], 6), [[33, 98]], quad([33, 98], [32, 86], [38, 72], 6))), 'matte', T.cream, { line: 0.6, fx: { patterns: [{ kind: 'stripes', color: '#c8a070', opacity: 0.6, size: 6 * c.u, angle: 0, duty: 0.18 }] } }),
        stroke([[64, 59.5], [91, 59]], 2, EYE),
        inner(poly([[78, 59], [83, 59], [80.5, 66]], 1), 'matte', T.white, { line: 0.5 }),
        inner(ellR(53, 41, 7, 5, -12), 'glow', tone('#fffbd0', '#ffd23a', '#e06a00'), { line: 0.7, lineColor: '#140c04' }),
        inner(ellR(53, 41, 1.5, 4.2, -12), 'flat', EYE, { line: 0, plain: true }),
        inner(poly(taper([[42, 34], [62, 34]], 2, 5)), 'flat', shift(scales, -0.5), { line: 0, plain: true }),
        inner(ellR(88, 49, 1.8, 2.8, 30), 'flat', EYE, { line: 0, plain: true }),
        shine(ellR(66, 37, 10, 2.6, 18), 0.45),
      ];
    },
  },

  phoenix: {
    about: 'a phoenix with wings of flame',
    draw: (c) => {
      const fire = c.main(tone('#ffb070', '#ff4a1a', '#a8100a'));
      const glow = c.tint ? shift(c.tint, 0.45) : tone('#fffbd0', '#ffd23a', '#ff9a1a');
      // A wing: flame tongues fanned up and out from the shoulder.
      const S: P2 = [45, 47];
      const tongue = (from: P2, tip: P2, to: P2): P2[] => [...cubic(from, [from[0] - 2, from[1] - 8], [tip[0] + 6, tip[1] + 8], tip, 6).slice(1), ...cubic(tip, [tip[0] + 2, tip[1] + 10], [to[0] - 4, to[1] - 4], to, 6).slice(1)];
      const wing: P2[] = path([S], tongue(S, [30, 3], [28, 22]), tongue([28, 22], [9, 11], [15, 32]), tongue([15, 32], [1, 30], [11, 44]), tongue([11, 44], [5, 56], [24, 54]), [[42, 60]]);
      const tail: P2[] = path([[42, 66]], cubic([42, 66], [36, 78], [30, 84], [32, 97], 8), cubic([32, 97], [40, 88], [44, 86], [47, 80], 6), cubic([47, 80], [49, 88], [50, 94], [50, 99], 6), cubic([50, 99], [52, 92], [53, 86], [53, 80], 6), cubic([53, 80], [56, 86], [60, 88], [68, 97], 6), cubic([68, 97], [70, 84], [64, 78], [58, 66], 8));
      const crest: P2[] = path([[42, 26]], cubic([42, 26], [38, 18], [40, 12], [43, 8], 6), cubic([43, 8], [45, 14], [47, 16], [49, 18], 4), cubic([49, 18], [49, 10], [51, 6], [53, 3], 4), cubic([53, 3], [55, 10], [55, 14], [55, 18], 4), cubic([55, 18], [58, 14], [60, 12], [62, 10], 4), cubic([62, 10], [62, 18], [60, 22], [58, 27], 6));
      return [
        part(poly(wing), 'glow', fire, { line: 1 }),
        part(poly(mirror(wing)), 'glow', fire, { line: 1 }),
        inner(poly(scalePts(wing, 0.62, S[0], S[1])), 'glow', glow, { line: 0 }),
        inner(poly(mirror(scalePts(wing, 0.62, S[0], S[1]))), 'glow', glow, { line: 0 }),
        part(poly(tail), 'glow', fire, { line: 1 }),
        part(poly(crest, 1), 'glow', fire, { line: 1 }),
        part(ell(50, 56, 13, 19), 'gloss', fire, { shadow: true }),
        inner(ell(50, 61, 8, 12), 'matte', glow, { line: 0 }),
        part(circ(50, 31, 11.5), 'gloss', fire),
        ...eye(c, 45.5, 29, 2.4, 3),
        ...eye(c, 54.5, 29, 2.4, 3),
        inner(poly([[47, 34], [53, 34], [50, 40]], 1), 'gloss', T.yellow, { line: 0.6 }),
      ];
    },
  },
};

