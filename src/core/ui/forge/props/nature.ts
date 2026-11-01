import { circ, cubic, ellPts, ellR, heartPts, leafP, mirror, path, poly, quad, rot, strokePts, type P2 } from './geo';
import { inner, part, shift, shine, T, type Part, type PropDef, type Tone } from './kit';

/**
 * Nature and creatures: flames, droplets, mushrooms, pets' paws, lucky clovers, bones, feathers and wings, drawn as
 * filled, shaded objects in the unit frame (light from the upper left).
 */

const FIRE: Tone = { hi: '#ffc04a', mid: '#ff6a1a', lo: '#c01e08' };
const FIRE_IN: Tone = { hi: '#fffbd0', mid: '#ffd23a', lo: '#ff9a1a' };
const WATER: Tone = { hi: '#c8f2ff', mid: '#36a8ff', lo: '#0a44b8' };
const STEM: Tone = { hi: '#fffaf0', mid: '#f4e6cc', lo: '#b8a07a' };
const PAW: Tone = { hi: '#ffd6ea', mid: '#ff7ab4', lo: '#b02a6e' };
const FEATHER: Tone = { hi: '#c8fff4', mid: '#2ec8b0', lo: '#0a6a6a' };

export const NATURE: Record<string, PropDef> = {
  flame: {
    about: 'a flame',
    draw: (c) => {
      const outer = c.tint ? c.tint : FIRE;
      const mid = c.tint ? shift(c.tint, 0.45) : FIRE_IN;
      const body = path(
        cubic([50, 96], [16, 96], [8, 68], [22, 46], 12),
        cubic([22, 46], [28, 38], [28, 30], [26, 22], 8),
        cubic([26, 22], [36, 30], [40, 36], [42, 42], 8),
        cubic([42, 42], [42, 26], [50, 12], [58, 3], 10),
        cubic([58, 3], [64, 20], [78, 30], [80, 46], 10),
        cubic([80, 46], [82, 40], [82, 34], [80, 28], 6),
        cubic([80, 28], [94, 42], [94, 64], [86, 76], 10),
        cubic([86, 76], [80, 90], [66, 96], [50, 96], 10),
      );
      const core = path(cubic([50, 94], [30, 94], [26, 76], [34, 64], 10), cubic([34, 64], [40, 56], [44, 50], [48, 38], 8), cubic([48, 38], [56, 50], [72, 58], [70, 74], 10), cubic([70, 74], [68, 88], [60, 94], [50, 94], 10));
      return [
        part(poly(body), 'glow', outer, { line: 1, fx: { fill: { angle: 90, stops: [[0, outer.mid], [0.6, outer.mid], [1, outer.lo]] } } }),
        inner(poly(core), 'glow', mid, { fx: { fill: { angle: 90, stops: [[0, mid.mid], [1, mid.hi]] } } }),
        inner(ellR(50, 82, 10, 12, 0), 'glow', { hi: '#ffffff', mid: '#fffbe6', lo: mid.hi }, { fx: { fill: '#fffbe6' } }),
      ];
    },
  },

  droplet: {
    about: 'a water droplet',
    draw: (c) => {
      const t = c.main(WATER);
      const drop = path(quad([50, 3], [64, 26], [75.5, 46.2], 12), ellPts(50, 64, 31, 31, { a0: -35, a1: 215, n: 40 }), quad([24.5, 46.2], [36, 26], [50, 3], 12));
      return [part(poly(drop), 'gloss', t), shine(poly(path(cubic([30, 56], [28, 66], [32, 76], [40, 82], 10), cubic([40, 82], [34, 74], [32, 64], [34, 56], 10))), 0.75), shine(circ(40, 44, 3), 0.75)];
    },
  },

  mushroom: {
    about: 'a red-capped mushroom with white spots',
    draw: (c) => {
      const cap = c.main(T.red);
      const stem = path(cubic([34, 94], [32, 80], [38, 62], [40, 52], 8), [[60, 52]], cubic([60, 52], [62, 62], [68, 80], [66, 94], 8));
      const dome = path(ellPts(50, 58, 46, 50, { a0: 180, a1: 360, n: 40 }), quad([96, 58], [50, 68], [4, 58], 12));
      return [
        part(poly(stem, 3), 'matte', STEM, { shadow: true }),
        part(poly(dome, 3), 'gloss', cap),
        inner(ellR(28, 36, 8, 6, -20), 'matte', T.white, { line: 0 }),
        inner(ellR(54, 22, 9, 6.5, 6), 'matte', T.white, { line: 0 }),
        inner(ellR(76, 42, 7, 5.5, 25), 'matte', T.white, { line: 0 }),
        c.detail > 0 && inner(ellR(50, 48, 5, 4, 0), 'matte', T.white, { line: 0 }),
        c.detail > 0 && inner(ellR(16, 52, 3.5, 3, 0), 'matte', T.white, { line: 0 }),
        shine(ellR(30, 20, 8, 4, -30), 0.5),
      ];
    },
  },

  paw: {
    about: 'a pet\'s paw print',
    draw: (c) => {
      const t = c.main(PAW);
      const pad = path(cubic([50, 48], [72, 48], [88, 70], [80, 84], 12), cubic([80, 84], [72, 97], [58, 89], [50, 89], 10), cubic([50, 89], [42, 89], [28, 97], [20, 84], 10), cubic([20, 84], [12, 70], [28, 48], [50, 48], 12));
      return [
        part(poly(pad), 'gloss', t, { shadow: true }),
        part(ellR(17, 47, 10.5, 13.5, -22), 'gloss', t),
        part(ellR(37, 23, 11.5, 14.5, -8), 'gloss', t),
        part(ellR(63, 23, 11.5, 14.5, 8), 'gloss', t),
        part(ellR(83, 47, 10.5, 13.5, 22), 'gloss', t),
        c.detail > 0 && shine(ellR(36, 60, 6, 3.5, -20), 0.5),
      ];
    },
  },

  clover: {
    about: 'a four-leaf clover',
    draw: (c) => {
      const t = c.main(T.leaf);
      const leaf = (deg: number) => part(poly(heartPts(50 + Math.sin((deg * Math.PI) / 180) * 21, 46 - Math.cos((deg * Math.PI) / 180) * 21, 46, deg)), 'gloss', t);
      return [
        part(poly(strokePts(quad([50, 50], [54, 80], [70, 96], 10), 6)), 'matte', shift(t, -0.1)),
        leaf(0),
        leaf(90),
        leaf(180),
        leaf(270),
        inner(circ(50, 46, 4), 'matte', shift(t, -0.15), { line: 0 }),
      ];
    },
  },

  bone: {
    about: 'a dog bone',
    aura: true,
    draw: (c) => {
      const t = c.own(T.bone);
      const knob = (x: number, y: number) => part(circ(x, y, 13), 'matte', t);
      const [a, b, d, e] = [rot([[20, 38]], -35)[0]!, rot([[20, 62]], -35)[0]!, rot([[80, 38]], -35)[0]!, rot([[80, 62]], -35)[0]!];
      return [knob(...a), knob(...b), knob(...d), knob(...e), part(poly(rot([[20, 40], [80, 40], [80, 60], [20, 60]], -35), 4), 'matte', t), shine(ellR(...rot([[50, 44]], -35)[0]!, 22, 2.2, -35), 0.45)];
    },
  },

  feather: {
    about: 'a feather quill',
    draw: (c) => {
      const t = c.main(FEATHER);
      // The vane is a leaf along the diagonal (wide end low): barbs slant back from the shaft inside it.
      const [cx, cy, len, half] = [55, 45, 90, 19];
      const u: P2 = [Math.SQRT1_2, -Math.SQRT1_2];
      const at = (k: number): P2 => [cx + u[0] * len * (k - 0.5), cy + u[1] * len * (k - 0.5)];
      const hw = (k: number) => half * Math.sin(Math.PI * k) * (1 - 0.3 * k);
      const barbs: Part[] = [];
      if (c.detail > 0)
        for (const k of [0.22, 0.34, 0.46, 0.58, 0.7])
          for (const sgn of [1, -1]) {
            const [px, py] = at(k);
            const h = hw(k);
            const end: P2 = [px + sgn * Math.SQRT1_2 * h * 0.72 - u[0] * h * 0.4, py + sgn * Math.SQRT1_2 * h * 0.72 - u[1] * h * 0.4];
            barbs.push(inner(poly(strokePts([[px, py], end], 1.5, 'flat')), 'flat', shift(t, -0.22), { line: 0, plain: true }));
          }
      return [
        part(leafP(cx, cy, len, half * 2, -45), 'gloss', t, { shadow: true }),
        ...barbs,
        part(poly(strokePts([[9, 91], at(0.97)], 4.5)), 'matte', T.white, { line: 0.8 }),
      ];
    },
  },

  wings: {
    about: 'a pair of feathered wings',
    draw: (c) => {
      const t = c.main(T.white);
      // Each wing: feathers laid along the wing from the shoulder to the tip like shingles (the lowest, shortest drawn
      // first), their staggered tips making the trailing edge, a rounded covert over the shoulder.
      const R: P2 = [47, 57];
      const th = Math.atan2(22 - R[1], 8 - R[0]);
      const ax: P2 = [Math.cos(th), Math.sin(th)];
      const nx: P2 = [ax[1], -ax[0]];
      const rows: Array<[number, number]> = [[56, 15], [48, 14], [39, 13], [29, 12]];
      const wing = (side: 1 | -1): Array<Part | false> => {
        const m = (pts: P2[]) => (side === 1 ? pts : mirror(pts));
        const out: Array<Part | false> = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          const [len, wid] = rows[i]!;
          const deg = (th * 180) / Math.PI - i * 6;
          const r = (deg * Math.PI) / 180;
          const [sx, sy] = [R[0] + nx[0] * i * 7.5, R[1] + nx[1] * i * 7.5];
          out.push(part(poly(m(ellPts(sx + Math.cos(r) * len * 0.5, sy + Math.sin(r) * len * 0.5, len * 0.5, wid * 0.5, { rot: deg, n: 36 }))), 'gloss', shift(t, -0.04 - i * 0.05), { span: [14, 80] }));
        }
        out.push(part(poly(m(ellPts(R[0] + ax[0] * 13 + nx[0] * 2, R[1] + ax[1] * 13 + nx[1] * 2, 16, 10, { rot: (th * 180) / Math.PI, n: 36 }))), 'gloss', shift(t, 0.08), { span: [14, 80] }));
        out.push(c.detail > 0 && shine(poly(m(ellPts(R[0] + ax[0] * 34 - nx[0] * 3.5, R[1] + ax[1] * 34 - nx[1] * 3.5, 14, 2.4, { rot: (th * 180) / Math.PI, n: 20 }))), 0.6));
        return out;
      };
      return [...wing(1), ...wing(-1)];
    },
  },
};
