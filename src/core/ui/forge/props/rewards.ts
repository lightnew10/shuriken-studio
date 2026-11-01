import { arcBand, box, circ, cubic, ell, ellPts, ellR, glyphP, inset, path, poly, rbox, ringP, rot, sparkleP, starP, type P2 } from './geo';
import { inner, part, shade, shift, shine, T, type Part, type PropCtx, type PropDef, type Tone } from './kit';

/**
 * Rewards and currencies: coin stacks, cash, trophies, medals, gifts, tickets, money bags, rings, crystals and magic
 * orbs, drawn as filled, shaded objects in the unit frame (light from the upper left).
 */

const GEM: Tone = { hi: '#e6fcff', mid: '#38c4ff', lo: '#0a50c0' };
const CASH: Tone = { hi: '#d6ffb0', mid: '#5cc24a', lo: '#1f6a22' };
const SACK: Tone = { hi: '#f8dca8', mid: '#d29c56', lo: '#7a4c1c' };
const ROPE: Tone = { hi: '#f2d29a', mid: '#b8843e', lo: '#6a4214' };
const TICKET: Tone = { hi: '#ffd0b0', mid: '#ff6a4a', lo: '#a8241a' };
const AMETHYST: Tone = { hi: '#f0d0ff', mid: '#b05cff', lo: '#4a1490' };
const ORB: Tone = { hi: '#e8d8ff', mid: '#8a5cff', lo: '#2a1080' };
const STONE: Tone = { hi: '#a8a4b8', mid: '#6e6a80', lo: '#34304a' };

/** A coin seen edge-on (a short cylinder): its side and its top face. */
function stackCoin(cx: number, y: number, rx: number, ry: number, th: number, g: Tone): Part[] {
  const side = path(ellPts(cx, y, rx, ry, { a0: 180, a1: 360, n: 20 }), ellPts(cx, y + th, rx, ry, { a0: 0, a1: 180, n: 20 }));
  return [part(poly(side), 'metal', shift(g, -0.22), { span: [y - ry, y + th + ry] }), inner(ell(cx, y, rx, ry), 'metal', g, { line: 0.7 })];
}

/** A ticket's outline (notched at both ends) in the frame, turned by deg. */
function ticketPts(x0: number, y0: number, x1: number, y1: number, r: number, deg: number): P2[] {
  const cy = (y0 + y1) / 2;
  const notch = (x: number, from: number, to: number): P2[] => ellPts(x, cy, r, r, { a0: from, a1: to, n: 12 }).slice(1, -1);
  const pts: P2[] = [[x0, y0], [x1, y0], [x1, cy - r], ...notch(x1, 270, 90), [x1, cy + r], [x1, y1], [x0, y1], [x0, cy + r], ...notch(x0, 90, -90), [x0, cy - r]];
  return rot(pts, deg, (x0 + x1) / 2, cy);
}

/** A crystal: a pointed prism with a lit left face and a shaded right face. */
function crystal(c: PropCtx, base: [number, number], tip: [number, number], w: number, t: Tone): Part[] {
  const [bx, by] = base;
  const [tx, ty] = tip;
  const dx = tx - bx;
  const dy = ty - by;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const sh = 0.72;
  const L: P2 = [bx + nx * w, by + ny * w];
  const R: P2 = [bx - nx * w, by - ny * w];
  const L2: P2 = [L[0] + dx * sh, L[1] + dy * sh];
  const R2: P2 = [R[0] + dx * sh, R[1] + dy * sh];
  const M: P2 = [bx - nx * w * 0.15 + dx * sh, by - ny * w * 0.15 + dy * sh];
  const Mb: P2 = [bx - nx * w * 0.15, by - ny * w * 0.15];
  const out: Array<Part | false> = [
    part(poly([L, L2, [tx, ty], R2, R], 1.2), 'gem', t),
    inner(poly([Mb, M, [tx, ty], R2, R], 0.8), 'flat', t, { line: 0, plain: true, fx: { fill: { angle: 90, stops: [[0, shift(t, -0.05).mid], [1, t.lo]] } } }),
    inner(poly([L, L2, [tx, ty], M, Mb], 0.8), 'flat', t, { line: 0, plain: true, fx: { fill: { angle: 90, stops: [[0, t.hi], [1, shift(t, 0.1).mid]] } } }),
    c.detail > 0 && shine(poly([[L[0] + (Mb[0] - L[0]) * 0.25, L[1] + (Mb[1] - L[1]) * 0.25 - 6], [L2[0] + (M[0] - L2[0]) * 0.25, L2[1] + (M[1] - L2[1]) * 0.25], [L2[0] + (M[0] - L2[0]) * 0.5, L2[1] + (M[1] - L2[1]) * 0.5], [L[0] + (Mb[0] - L[0]) * 0.5, L[1] + (Mb[1] - L[1]) * 0.5 - 6]]), 0.45),
  ];
  return out.filter((x): x is Part => !!x);
}

export const REWARDS: Record<string, PropDef> = {
  coins: {
    about: 'a stack of gold coins with one standing in front',
    currency: true,
    draw: (c) => {
      const g = c.main(T.gold);
      const stack: Part[] = [];
      const ys: Array<[number, number]> = c.detail > 0 ? [[34, 80], [36, 70], [33, 60], [35, 50], [34, 40]] : [[34, 80], [36, 68], [33, 56], [35, 44]];
      for (const [x, y] of ys) stack.push(...stackCoin(x, y, 26, 8.5, c.detail > 0 ? 8 : 10, g));
      return [
        ...stack,
        part(ell(66, 66, 27, 27), 'metal', shift(g, -0.3), { shadow: true }),
        part(ell(64, 64, 27, 27), 'metal', g),
        inner(ell(64, 64, 19.5, 19.5), 'metal', shift(g, -0.1), { line: 0.7, angle: 270 }),
        inner(starP(64, 65, 12, { inner: 0.5, round: 1.5 }), 'metal', shift(g, 0.12), { line: 0.7 }),
        shine(poly(arcBand(64, 64, 22, 25, 195, 255)), 0.7),
      ];
    },
  },

  cash: {
    about: 'a fanned stack of banknotes',
    currency: true,
    draw: (c) => {
      const t = c.main(CASH);
      const edge = shift(t, -0.35).mid;
      const bill = (cx: number, cy: number, deg: number, k: number, top: boolean): Array<Part | false> => [
        part(rbox(cx, cy, 86, 48, deg, 5), 'matte', shift(t, k), top ? {} : { shadow: true }),
        inner(rbox(cx, cy, 74, 36, deg, 3), 'flat', shift(t, k + 0.22), { line: 0.6, lineColor: edge, plain: true }),
        top && inner(ell(cx, cy, 13, 13), 'matte', shift(t, -0.02), { line: 0.6, lineColor: edge }),
        top && c.detail > 0 && inner(circ(cx - 28, cy - 5, 4), 'flat', shift(t, -0.1), { line: 0.5, lineColor: edge, plain: true }),
        top && c.detail > 0 && inner(circ(cx + 28, cy + 5, 4), 'flat', shift(t, -0.1), { line: 0.5, lineColor: edge, plain: true }),
      ];
      return [
        ...bill(46, 62, -16, -0.2, false),
        ...bill(50, 55, -4, -0.1, false),
        ...bill(54, 46, 8, 0, true),
        inner(glyphP('dollar-sign', 54, 46, 21, 3.8), 'flat', shift(t, -0.45), { line: 0, plain: true }),
        c.detail > 0 && shine(rbox(46, 26, 44, 3, 8, 1.5), 0.4),
      ];
    },
  },

  trophy: {
    about: 'a gold trophy cup on a plinth',
    draw: (c) => {
      const g = c.main(T.gold);
      const cup = path(cubic([20, 14], [20, 48], [38, 60], [45, 64], 14), [[55, 64]], cubic([55, 64], [62, 60], [80, 48], [80, 14], 14));
      return [
        part(ringP(19, 32, 14, 15, 6.5), 'metal', g),
        part(ringP(81, 32, 14, 15, 6.5), 'metal', g),
        part(box(43, 60, 14, 16, 2), 'metal', shift(g, -0.1)),
        part(poly(cup, 2), 'metal', g, { span: [10, 66] }),
        part(box(15, 8, 70, 10, 5), 'metal', shift(g, 0.08)),
        part(box(29, 72, 42, 10, 3), 'metal', g),
        part(box(21, 80, 58, 16, 4), 'wood', T.woodDark, { shadow: true }),
        inner(box(39, 84, 22, 7, 1.5), 'metal', T.gold, { line: 0.6 }),
        inner(starP(50, 34, 12.5, { inner: 0.5, round: 1.5 }), 'metal', shift(g, 0.15), { line: 0.7 }),
        shine(poly(path(cubic([27, 20], [27, 40], [34, 50], [40, 55], 8), cubic([36, 50], [31, 42], [31, 30], [32, 20], 8))), 0.6),
      ];
    },
  },

  medal: {
    about: 'a gold medal on a ribbon',
    draw: (c) => {
      const g = c.main(T.gold);
      return [
        part(poly([[16, 3], [38, 3], [60, 46], [42, 54]], 1.5), 'matte', T.blue),
        part(poly([[84, 3], [62, 3], [40, 46], [58, 54]], 1.5), 'matte', T.red),
        c.detail > 0 && inner(poly([[24, 3], [30, 3], [50, 44], [46, 47]]), 'flat', T.white, { line: 0, plain: true, opacity: 0.85 }),
        part(circ(50, 66, 31), 'metal', g, { shadow: true }),
        inner(circ(50, 66, 22.5), 'metal', shift(g, -0.12), { line: 0.7, angle: 270 }),
        inner(starP(50, 67, 14, { inner: 0.5, round: 1.5 }), 'metal', shift(g, 0.14), { line: 0.7 }),
        shine(poly(arcBand(50, 66, 25, 28.5, 195, 255)), 0.7),
      ];
    },
  },

  gift: {
    about: 'a wrapped gift box with a bow',
    draw: (c) => {
      const box0 = c.main(T.red);
      const rib = c.rarity === 'legendary' || c.variant === 'premium' ? T.red : T.gold;
      return [
        part(ellR(33, 22, 17, 11, -28), 'gloss', rib),
        part(ellR(67, 22, 17, 11, 28), 'gloss', rib),
        shade(ellR(33, 23, 7, 4, -28), T.shadow, 0.35),
        shade(ellR(67, 23, 7, 4, 28), T.shadow, 0.35),
        part(box(14, 44, 72, 50, [2, 2, 7, 7]), 'gloss', box0, { shadow: true }),
        shade(box(14, 46, 72, 6), T.shadow, 0.25),
        part(box(8, 31, 84, 17, 4), 'gloss', shift(box0, 0.08)),
        inner(box(43, 48, 14, 46), 'gloss', rib, { span: [31, 94], line: 0.8 }),
        inner(box(43, 31, 14, 17), 'gloss', rib, { span: [31, 94], line: 0.8 }),
        part(circ(50, 29, 8), 'gloss', shift(rib, 0.05)),
        c.detail > 0 && shine(box(18, 35, 20, 3, 1.5), 0.45),
      ];
    },
  },

  ticket: {
    about: 'a ticket with a star',
    currency: true,
    draw: (c) => {
      const t = c.main(TICKET);
      const n = c.detail > 0 ? 7 : 5;
      const perf = rot([[30, 31], [30, 69]], -14, 50, 50);
      const dots: P2[] = [];
      for (let i = 0; i < n; i++) dots.push([perf[0]![0] + ((perf[1]![0] - perf[0]![0]) * i) / (n - 1), perf[0]![1] + ((perf[1]![1] - perf[0]![1]) * i) / (n - 1)]);
      return [
        part(poly(ticketPts(5, 25, 95, 75, 8, -14), 3), 'gloss', t, { shadow: true }),
        inner(poly(ticketPts(12, 32, 88, 68, 5, -14), 2), 'flat', shift(t, 0.12), { line: 0.6, lineColor: shift(t, -0.35).mid, plain: true }),
        ...dots.map(([x, y]) => inner(circ(x, y, 2), 'flat', shift(t, -0.45), { line: 0, plain: true })),
        inner(starP(62, 47, 15, { inner: 0.5, round: 1.5 }), 'gloss', T.yellow, { line: 0.8 }),
        c.detail > 0 && shine(poly(rot([[14, 32], [60, 32], [60, 35], [14, 35]], -14, 50, 50)), 0.4),
      ];
    },
  },

  'money-bag': {
    about: 'a money sack tied with rope, a dollar sign on it',
    currency: true,
    draw: (c) => {
      const sack = c.main(SACK);
      const body = path(cubic([40, 36], [10, 46], [5, 94], [50, 94], 16), cubic([50, 94], [95, 94], [90, 46], [60, 36], 16));
      return [
        part(poly([[38, 38], [27, 14], [40, 21], [50, 9], [60, 21], [73, 14], [62, 38]], 3), 'matte', shift(sack, 0.05)),
        part(poly(body, 2), 'matte', sack, { shadow: true }),
        part(rbox(50, 36, 34, 9, 0, 4.5), 'matte', ROPE),
        inner(circ(50, 66, 16), 'metal', T.gold, { line: 0.8 }),
        inner(glyphP('dollar-sign', 50, 66, 24, 4.2), 'flat', T.gold, { line: 0, plain: true, fx: { fill: '#a85a00' } }),
        shine(ellR(28, 58, 5, 11, 25), 0.35),
      ];
    },
  },

  ring: {
    about: 'a gold ring with a gem',
    draw: (c) => {
      const band = T.gold;
      const gem = c.main(GEM);
      return [
        part(ringP(50, 64, 33, 29, 8.5), 'metal', band, { shadow: true }),
        part(poly([[34, 32], [66, 32], [58, 44], [42, 44]], 2), 'metal', band),
        part(poly([[34, 12], [66, 12], [76, 24], [50, 42], [24, 24]], 1.5), 'gem', shift(gem, -0.1)),
        inner(poly(inset([[34, 12], [44, 12], [40, 24], [24, 24]], 0.9), 0.5), 'flat', shift(gem, 0.3), { line: 0, plain: true }),
        inner(poly(inset([[44, 12], [56, 12], [60, 24], [40, 24]], 0.9), 0.5), 'flat', shift(gem, 0.5), { line: 0, plain: true }),
        inner(poly(inset([[40, 24], [60, 24], [50, 42]], 0.9), 0.5), 'flat', shift(gem, 0.15), { line: 0, plain: true }),
        inner(poly(inset([[60, 24], [76, 24], [50, 42]], 0.9), 0.5), 'flat', shift(gem, -0.2), { line: 0, plain: true }),
        shine(poly(arcBand(50, 64, 27, 30.5, 195, 250)), 0.6),
        shine(sparkleP(62, 16, 7), 0.95),
      ];
    },
  },

  crystal: {
    about: 'a cluster of crystals on a rock',
    draw: (c) => {
      const t = c.main(AMETHYST);
      return [
        part(ell(50, 88, 42, 9), 'matte', STONE, { shadow: true }),
        ...crystal(c, [24, 90], [12, 40], 9, shift(t, -0.08)),
        ...crystal(c, [76, 90], [90, 44], 9, shift(t, -0.08)),
        ...crystal(c, [50, 92], [50, 4], 14, t),
        c.detail > 0 && shine(sparkleP(36, 22, 6), 0.9),
      ];
    },
  },

  orb: {
    about: 'a glowing magic orb on a gold stand',
    draw: (c) => {
      const t = c.main(ORB);
      return [
        part(poly([[28, 97], [72, 97], [64, 80], [36, 80]], 3), 'metal', T.gold, { shadow: true }),
        part(circ(50, 45, 40), 'liquid', t),
        inner(circ(50, 47, 17), 'glow', shift(t, 0.45), { line: 0 }),
        shine(poly(arcBand(50, 45, 27, 31, 120, 200)), 0.3),
        shine(poly(arcBand(50, 45, 20, 23, 300, 380)), 0.3),
        part(poly([[30, 80], [70, 80], [76, 72], [24, 72]], 2), 'metal', shift(T.gold, 0.06)),
        shine(ellR(34, 25, 10, 6, -35), 0.85),
        shine(circ(48, 15, 2.6), 0.8),
        c.detail > 0 && shine(sparkleP(66, 58, 5), 0.9),
      ];
    },
  },
};
