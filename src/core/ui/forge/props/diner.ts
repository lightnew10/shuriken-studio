import { box, circ, clipHalf, ell, ellPts, ellR, path, poly, quad, rbox, ringP, rodPts, taper, type P2 } from './geo';
import { inner, part, shade, shift, shine, T, type Part, type PropDef, type Tone } from './kit';

/**
 * The diner: a cheeseburger, fries in a striped carton, a soda with a straw, a frosted donut and a chef's hat — the
 * menu and the staff of restaurant and tycoon games. Food keeps its own colours (a variant glows round it); what is
 * packaging or icing wears the variant (a rare soda cup is blue, an epic donut's icing purple, a chef's band gold).
 */

const tone = (hi: string, mid: string, lo: string): Tone => ({ hi, mid, lo });
const BUN: Tone = tone('#ffdca0', '#eca04a', '#9a5414');
const SEED: Tone = tone('#ffffff', '#fff6e0', '#d8c094');
const LETTUCE: Tone = tone('#d4ff9a', '#62cc2e', '#1e6e12');
const CHEESE: Tone = tone('#fff6a8', '#ffc928', '#d08200');
const PATTY: Tone = tone('#b8724a', '#6e3618', '#2a1004');
const TOMATO: Tone = tone('#ffa08a', '#ee3a2a', '#8a1208');
const FRY: Tone = tone('#fff6b0', '#ffcc3c', '#cc7a10');
const DOUGH: Tone = tone('#ffdca0', '#e09a4c', '#8a4e18');
const LID: Tone = tone('#ffffff', '#eef2f8', '#a8b4c8');

/** A wavy edge from (x0, y) to (x1, y): n bumps of amplitude a (positive: down). */
const wavy = (x0: number, x1: number, y: number, a: number, n: number, steps = 8): P2[] =>
  Array.from({ length: n * steps + 1 }, (_, i) => {
    const t = i / (n * steps);
    return [x0 + (x1 - x0) * t, y + a * Math.abs(Math.sin(t * n * Math.PI))] as P2;
  });

export const DINER: Record<string, PropDef> = {
  burger: {
    aura: true,
    about: 'a cheeseburger: sesame bun, lettuce, melted cheese and a juicy patty',
    draw: (c) => {
      const bun = c.own(BUN);
      const top = path(ellPts(50, 47, 43, 35, { a0: 180, a1: 360, n: 40 }), quad([93, 47], [93, 52], [87, 52], 4), [[13, 52]], quad([13, 52], [7, 52], [7, 47], 4));
      const lettuce = path([[6, 50]], [[94, 50]], wavy(94, 6, 57, 4.4, 7).slice(1));
      const cheese = path([[10, 55]], [[90, 55]], [[90, 60], [76, 60], [70, 71], [64, 60], [36, 60], [30, 69], [24, 60], [10, 60]]);
      const seed = (x: number, y: number, deg: number) => inner(ellR(x, y, 2.6, 1.5, deg), 'gloss', SEED, { line: 0.4, plain: true });
      return [
        part(box(11, 70, 78, 17, [3, 3, 12, 12]), 'gloss', bun, { shadow: true }),
        part(box(8, 57, 84, 16, 8), 'matte', c.own(PATTY), { fx: c.detail > 0 ? { textures: [{ kind: 'speckle', scale: 2.4 * c.u, density: 0.45, color: '#2a1004', opacity: 0.45 }] } : {} }),
        c.detail > 0 && part(box(14, 54, 72, 5, 2.5), 'gloss', TOMATO),
        part(poly(cheese, 1.4), 'gloss', CHEESE),
        part(poly(lettuce, 1.6), 'gloss', LETTUCE),
        part(poly(top), 'gloss', bun),
        shade(poly(clipHalf(top, 0, 1, -40)), T.shadow, 0.14),
        seed(34, 26, -20),
        seed(52, 21, 10),
        seed(68, 29, 30),
        seed(44, 36, 40),
        c.detail > 0 && seed(26, 38, -40),
        c.detail > 0 && seed(60, 38, -10),
        c.detail > 0 && seed(76, 40, 20),
        shine(ellR(30, 25, 9, 4, -28), 0.6),
        shine(ellR(24, 77, 6, 2, 0), 0.4),
      ];
    },
  },

  fries: {
    about: 'French fries in a striped carton',
    draw: (c) => {
      const box_ = c.main(T.red);
      const fry = c.own(FRY);
      const back = shift(fry, -0.12);
      const stick = (x: number, top: number, deg: number, t: Tone) => part(rbox(x, top + 22, 8.4, 44, deg, 1.6), 'matte', t);
      const carton = path(quad([14, 40], [50, 58], [86, 40], 16), [[76, 94], [24, 94]]);
      return [
        stick(30, 10, -14, back),
        stick(46, 4, -4, back),
        stick(62, 6, 8, back),
        stick(74, 14, 18, back),
        stick(23, 18, -22, fry),
        stick(38, 12, -8, fry),
        stick(54, 9, 3, fry),
        stick(68, 15, 13, fry),
        part(poly(carton, 2.4), 'gloss', box_, { shadow: true, fx: { patterns: [{ kind: 'stripes', color: '#ffffff', opacity: 0.9, size: 12 * c.u, angle: 0, duty: 0.3 }] } }),
        shade(poly(clipHalf(carton, -1, 0, 50)), T.shadow, 0.12),
        shine(poly(taper(quad([20, 46], [34, 54], [48, 56], 8), 2.4, 0.6)), 0.6),
      ];
    },
  },

  soda: {
    about: 'a soda cup with a lid and a striped straw',
    draw: (c) => {
      const cup = c.main(T.red);
      const body: P2[] = [[20, 32], [80, 32], [71, 94], [29, 94]];
      const wave = (y: number, a: number) => Array.from({ length: 17 }, (_, i) => [16 + i * 4.25, y + a * Math.sin(i * 0.75)] as P2);
      const band = path(wave(52, 2.6), wave(64, 2.6).reverse());
      // Inside the cup's slanted sides.
      const bandIn = clipHalf(clipHalf(band, 62, -9, -62 * 20 + 9 * 32), -62, -9, 62 * 80 + 9 * 32);
      return [
        part(poly(rodPts(path([[53, 26]], quad([53, 26], [56, 10], [60, 6], 8), quad([60, 6], [64, 3], [74, 4], 6)), 6.4)), 'gloss', T.white, { fx: { patterns: [{ kind: 'stripes', color: '#ff3a4a', opacity: 0.9, size: 7 * c.u, angle: 30, duty: 0.45 }] } }),
        part(poly(body, 3), 'gloss', cup, { shadow: true, span: [30, 96] }),
        inner(poly(bandIn, 1), 'gloss', T.white, { line: 0.7 }),
        c.detail > 0 && inner(circ(50, 77, 6.4), 'gloss', T.white, { line: 0.6 }),
        part(box(14, 23, 72, 12, 5), 'gloss', LID),
        part(ell(50, 23.6, 26, 5), 'gloss', shift(LID, 0.04)),
        shade(poly(clipHalf(body, -1, 0, 58)), T.shadow, 0.14),
        shine(poly([[25, 38], [31, 38], [33.6, 88], [29.4, 88]], 1.4), 0.5),
        shine(box(20, 25, 30, 2.6, 1.3), 0.6),
      ];
    },
  },

  donut: {
    about: 'a frosted donut with sprinkles',
    draw: (c) => {
      const icing = c.main(T.pink);
      const sprinkle = (x: number, y: number, deg: number, t: Tone) => inner(rbox(x, y, 6.4, 2.4, deg, 1.2), 'gloss', t, { line: 0.4, plain: true });
      const drip = (x: number, y: number, w: number, h: number) => inner(poly(path(ellPts(x, y, w, w, { a0: 180, a1: 360, n: 8 }), ellPts(x, y + h - w, w, w, { a0: 0, a1: 180, n: 10 }))), 'gloss', icing, { line: 0, span: [22, 78] });
      return [
        part(ringP(50, 56, 46, 34, 22), 'matte', c.own(DOUGH), { shadow: true }),
        drip(18, 62, 4.6, 14),
        drip(36, 72, 4.2, 12),
        drip(70, 72, 4.6, 13),
        part(ringP(50, 51, 42, 28, 16), 'gloss', icing, { sil: false, span: [22, 78], line: 0.8 }),
        sprinkle(28, 42, 30, T.yellow),
        sprinkle(44, 30, -20, T.cyan),
        sprinkle(64, 32, 40, T.white),
        sprinkle(76, 48, -50, T.yellow),
        sprinkle(24, 58, -30, T.cyan),
        sprinkle(68, 64, 20, T.green),
        c.detail > 0 && sprinkle(50, 70, -10, T.purple),
        c.detail > 0 && sprinkle(36, 66, 60, T.white),
        c.detail > 0 && sprinkle(82, 58, 10, T.purple),
        c.detail > 0 && sprinkle(56, 26, 70, T.green),
        shine(ellR(30, 33, 10, 3.6, -24), 0.55),
      ];
    },
  },

  'chef-hat': {
    about: 'a chef\'s tall white hat',
    draw: (c) => {
      const cloth = T.white;
      const band = c.tint ?? shift(T.white, -0.04);
      const puff: Part[] = [
        part(circ(27, 42, 19), 'matte', cloth),
        part(circ(73, 42, 19), 'matte', cloth),
        part(circ(50, 30, 25), 'matte', cloth),
      ];
      return [
        part(poly([[22, 44], [78, 44], [76, 82], [24, 82]], 3), 'matte', shift(cloth, -0.03), { shadow: true }),
        ...puff,
        shade(poly([[36, 52], [40, 52], [40, 76], [36, 76]], 1.6), T.shadow, 0.12),
        shade(poly([[60, 52], [64, 52], [64, 76], [60, 76]], 1.6), T.shadow, 0.12),
        c.detail > 0 && shade(poly([[48, 54], [52, 54], [52, 76], [48, 76]], 1.6), T.shadow, 0.1),
        part(box(20, 74, 60, 16, 4), 'gloss', band),
        shine(ellR(38, 16, 8, 3.4, -20), 0.6),
        shine(ellR(16, 36, 3, 6, 20), 0.4),
      ];
    },
  },
};
