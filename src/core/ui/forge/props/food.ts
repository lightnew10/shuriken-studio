import { box, circ, cubic, ell, ellPts, ellR, leafP, path, pill, poly, quad, rot, strokePts, type P2, type Piece } from './geo';
import { inner, part, shift, shine, T, type PropDef, type Tone } from './kit';

/**
 * Food: apples, drumsticks, cookies, cakes, wrapped sweets, carrots, ice cream and pizza, drawn as filled, shaded
 * objects in the unit frame (light from the upper left). Food keeps its own colours (a rare apple is still a red
 * apple): a variant shows as a glow in its colour round it, glints and shimmer; sweets (candy, frosting, ice cream) take
 * the variant's colour as their flavour.
 */

const COOKIE: Tone = { hi: '#ffe0a8', mid: '#dc9a50', lo: '#8a4a18' };
const CHOC: Tone = { hi: '#9a6040', mid: '#5a2e18', lo: '#2a1208' };
const SPONGE: Tone = { hi: '#fff4d8', mid: '#f6d29a', lo: '#c08a48' };
const CONE: Tone = { hi: '#ffe0a0', mid: '#e8a858', lo: '#9a5a1c' };
const CHEESE: Tone = { hi: '#fff6b0', mid: '#ffcf3a', lo: '#d88a10' };
const CRUST: Tone = { hi: '#ffd08a', mid: '#d88a3a', lo: '#8a4a14' };
const PEPPERONI: Tone = { hi: '#ff8a7a', mid: '#d0302a', lo: '#7a1010' };

const wobble = (cx: number, cy: number, r: number, amp: number, lobes: number, n = 64): P2[] => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  const rr = r + amp * Math.sin(a * lobes + 0.6);
  return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr] as P2;
});
const crossShape = (x: number, y: number, s: number): Piece => ({ shape: { kind: 'cross', thickness: 0.3 }, at: [x - s / 2, y - s / 2, s, s] });

export const FOOD: Record<string, PropDef> = {
  apple: {
    aura: true,
    about: 'a shiny red apple with a leaf',
    draw: (c) => {
      const t = c.own(T.red);
      const body = path(cubic([50, 30], [38, 18], [8, 20], [8, 54], 14), cubic([8, 54], [8, 82], [30, 98], [43, 93], 12), quad([43, 93], [50, 90], [57, 93], 6), cubic([57, 93], [70, 98], [92, 82], [92, 54], 12), cubic([92, 54], [92, 20], [62, 18], [50, 30], 14));
      return [
        part(poly(strokePts(quad([50, 34], [49, 18], [56, 7], 8), 5.5)), 'wood', T.woodDark),
        part(poly(body), 'gloss', t, { shadow: true }),
        part(leafP(68, 16, 28, 13, -28), 'gloss', T.leaf),
        shine(ellR(27, 46, 6, 12, 24), 0.75),
        shine(circ(36, 33, 2.8), 0.7),
      ];
    },
  },

  drumstick: {
    aura: true,
    about: 'a roast drumstick',
    draw: (c) => {
      const meat = c.own(T.meat);
      return [
        part(circ(79, 86, 10), 'matte', T.bone),
        part(circ(89, 74, 10), 'matte', T.bone),
        part(poly(strokePts([[56, 56], [83, 79]], 12)), 'matte', T.bone),
        part(poly(path(ellPts(40, 40, 33, 33, { a0: 68, a1: 380, n: 44 }), [[70, 70], [64, 74]]), 4), 'gloss', meat, { shadow: true }),
        c.detail > 0 && inner(ellR(50, 52, 9, 3, -40), 'shade', T.shadow, { opacity: 0.18 }),
        shine(ellR(26, 28, 6, 11, 40), 0.55),
        shine(circ(38, 18, 2.6), 0.55),
      ];
    },
  },

  cookie: {
    aura: true,
    about: 'a chocolate-chip cookie',
    draw: (c) => {
      const t = c.own(COOKIE);
      const chip = (x: number, y: number, r: number, deg: number) => inner(poly(rot([[x - r, y + r * 0.6], [x - r * 0.2, y - r], [x + r, y - r * 0.2], [x + r * 0.6, y + r]], deg, x, y), r * 0.5), 'matte', CHOC, { line: 0 });
      return [
        part(poly(wobble(50, 52, 43, 1.6, 9), 2), 'matte', t, { shadow: true, fx: { textures: [{ kind: 'speckle', scale: 3 * c.u, density: 0.5, color: shift(t, -0.3).mid, opacity: 0.4 }] } }),
        chip(32, 38, 6, 10),
        chip(60, 30, 5, 40),
        chip(68, 58, 6.5, -20),
        chip(40, 66, 5.5, 60),
        c.detail > 0 && chip(52, 48, 4, 0),
        c.detail > 0 && chip(24, 56, 4, 30),
        c.detail > 0 && chip(56, 78, 4, -30),
        shine(ellR(30, 28, 8, 3.5, -35), 0.35),
      ];
    },
  },

  cake: {
    about: 'a frosted cake with a cherry',
    draw: (c) => {
      const frost = c.main(T.pink);
      const side = path([[12, 46]], ellPts(50, 82, 38, 11, { a0: 180, a1: 0, n: 24 }), [[88, 46]]);
      return [
        part(ell(50, 88, 46, 9), 'matte', T.white, { shadow: true }),
        part(poly(side), 'matte', SPONGE),
        c.detail > 0 && inner(poly(path([[12, 66]], ellPts(50, 68, 38, 10, { a0: 180, a1: 0, n: 20 }), [[88, 66]], [[88, 70]], ellPts(50, 72, 38, 10, { a0: 0, a1: 180, n: 20 }), [[12, 70]])), 'flat', T.white, { line: 0, plain: true }),
        part({ shape: { kind: 'drip', drips: 4, length: 0.55, seed: 3 }, at: [12, 44, 76, 24] }, 'gloss', frost, { sil: false, line: 0.8 }),
        part(ell(50, 46, 38, 11), 'gloss', shift(frost, 0.08)),
        part(poly(strokePts(quad([50, 30], [52, 18], [60, 12], 6), 2.6)), 'wood', T.woodDark, { sil: false, line: 0.6 }),
        part(circ(50, 34, 8.5), 'gloss', T.red),
        shine(circ(47, 31, 2.4), 0.8),
      ];
    },
  },

  candy: {
    about: 'a wrapped sweet',
    draw: (c) => {
      const t = c.main(T.pink);
      const wrap = shift(t, 0.15);
      return [
        part(poly([[30, 50], [5, 28], [11, 50], [5, 72]], 3), 'gloss', wrap),
        part(poly([[70, 50], [95, 28], [89, 50], [95, 72]], 3), 'gloss', wrap),
        part(ell(29, 50, 5, 8), 'gloss', shift(t, -0.1)),
        part(ell(71, 50, 5, 8), 'gloss', shift(t, -0.1)),
        part(circ(50, 50, 24), 'gloss', t, { shadow: true, fx: { patterns: [{ kind: 'stripes', color: '#ffffff', opacity: 0.85, size: 9 * c.u, angle: 45, duty: 0.32 }] } }),
        shine(ellR(41, 39, 6, 3.5, -35), 0.7),
      ];
    },
  },

  carrot: {
    aura: true,
    about: 'a carrot with leafy greens',
    draw: (c) => {
      const t = c.own(T.orange);
      // Along +x (base at x 28, tip at 98), then turned so the tip points down-left.
      const hw = (x: number) => 20 * (1 - (x - 28) / 70) ** 0.85;
      const body = rot(path(ellPts(28, 50, 13, 20, { a0: 90, a1: 270, n: 16 }), [[50, 50 - hw(50)], [74, 50 - hw(74)], [98, 50.6], [98, 49.4], [74, 50 + hw(74)], [50, 50 + hw(50)]]), 135, 50, 50);
      const ridge = (x: number, side: 1 | -1) => inner(poly(rot(strokePts([[x, 50 - side * (hw(x) - 1)], [x - 2, 50 - side * hw(x) * 0.4]], 1.8), 135, 50, 50)), 'flat', shift(t, -0.25), { line: 0, plain: true });
      return [
        part(leafP(72, 14, 30, 12, -70), 'gloss', T.leaf),
        part(leafP(86, 26, 30, 12, -20), 'gloss', T.leaf),
        part(leafP(82, 14, 32, 13, -45), 'gloss', shift(T.leaf, 0.08)),
        part(poly(body, 2), 'gloss', t, { shadow: true }),
        c.detail > 0 && ridge(44, 1),
        c.detail > 0 && ridge(60, -1),
        c.detail > 0 && ridge(74, 1),
        c.detail > 1 && ridge(36, -1),
      ];
    },
  },

  'ice-cream': {
    about: 'an ice cream cone with a cherry',
    draw: (c) => {
      const scoop = c.main(T.pink);
      return [
        part(poly([[24, 50], [76, 50], [52, 97], [48, 97]], 3), 'matte', CONE, { shadow: true, fx: { patterns: [{ kind: 'crosshatch', color: CONE.lo, opacity: 0.55, size: 9 * c.u, duty: 0.14 }] } }),
        part(circ(50, 34, 28), 'gloss', scoop),
        part({ shape: { kind: 'wave', side: 'bottom', amplitude: 3.2, period: 15 }, at: [20, 40, 60, 18] }, 'gloss', scoop, { span: [6, 58] }),
        c.detail > 0 && inner(box(36, 22, 6, 2.2, 1.1), 'flat', T.yellow, { line: 0, plain: true }),
        c.detail > 0 && inner(box(56, 30, 6, 2.2, 1.1), 'flat', T.cyan, { line: 0, plain: true }),
        c.detail > 0 && inner(box(44, 40, 6, 2.2, 1.1), 'flat', T.green, { line: 0, plain: true }),
        part(circ(56, 9, 7), 'gloss', T.red),
        shine(ellR(36, 22, 5, 8, 35), 0.6),
      ];
    },
  },

  pizza: {
    aura: true,
    about: 'a slice of pepperoni pizza',
    draw: (c) => {
      const cheese = c.own(CHEESE);
      return [
        part(poly([[9, 24], [91, 24], [52, 97], [48, 97]], 4), 'matte', cheese, { shadow: true }),
        part(pill(4, 12, 92, 18), 'matte', CRUST),
        inner(circ(34, 40, 8), 'gloss', PEPPERONI, { line: 0.6 }),
        inner(circ(64, 42, 7), 'gloss', PEPPERONI, { line: 0.6 }),
        inner(circ(50, 64, 7.5), 'gloss', PEPPERONI, { line: 0.6 }),
        c.detail > 0 && inner(circ(48, 82, 4.5), 'gloss', PEPPERONI, { line: 0.6 }),
        c.detail > 0 && inner(crossShape(22, 33, 5), 'flat', T.leaf, { line: 0, plain: true }),
        shine(box(12, 15, 30, 3.5, 1.7), 0.4),
      ];
    },
  },
};
