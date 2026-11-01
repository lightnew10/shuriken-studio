import { arcBand, box, circ, cubic, ell, ellPts, ellR, path, pill, poly, quad, rbox, ringP, rot, shieldP, sparkleP, starP, strokePts, type P2, type Piece } from './geo';
import { inner, part, shift, shine, T, type PropDef, type Tone } from './kit';

/**
 * Adventure items: potions, scrolls, books, maps, swords, shields, bombs, skulls, locks, hourglasses, alarm clocks and
 * dice, drawn as filled, shaded objects in the unit frame (light from the upper left).
 */

const CORK: Tone = { hi: '#f2c48a', mid: '#c98a4a', lo: '#7a4a1e' };
const SAND: Tone = { hi: '#fff2b0', mid: '#f4c04a', lo: '#b87a10' };
const INKLINE: Tone = { hi: '#8a6a4a', mid: '#6a4a2a', lo: '#3a2410' };
/** A lumpy island outline. */
const blob = (cx: number, cy: number, r: number, lobes: number): P2[] => Array.from({ length: 40 }, (_, i) => {
  const a = (i / 40) * Math.PI * 2;
  const rr = r * (1 + 0.16 * Math.sin(a * lobes + 1) + 0.08 * Math.sin(a * (lobes + 2)));
  return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8] as P2;
});
const crossShape = (x: number, y: number, s: number, t = 0.26): Piece => ({ shape: { kind: 'cross', thickness: t }, at: [x - s / 2, y - s / 2, s, s] });

export const ITEMS: Record<string, PropDef> = {
  potion: {
    about: 'a round potion flask with a cork',
    draw: (c) => {
      const liq = c.main(T.red);
      const [cx, cy, ri, y0] = [50, 63, 27.5, 51];
      const dx = Math.sqrt(ri * ri - (y0 - cy) ** 2);
      const a = (Math.atan2(y0 - cy, dx) * 180) / Math.PI;
      const wave: P2[] = [];
      for (let i = 0; i <= 16; i++) wave.push([cx - dx + (2 * dx * i) / 16, y0 + Math.sin((i / 16) * Math.PI * 2) * 1.6]);
      return [
        part(box(39, 12, 22, 30, 3), 'glass', T.glass),
        part(circ(50, 63, 33), 'glass', T.glass, { shadow: true }),
        part(box(35, 10, 30, 8, 4), 'glass', T.glass),
        part(box(41, 1, 18, 13, [4, 4, 2, 2]), 'wood', CORK),
        inner(poly([...wave, ...ellPts(cx, cy, ri, ri, { a0: a, a1: 180 - a, n: 40 })]), 'liquid', liq, { line: 0 }),
        inner(ell(50, y0, dx, 3.2), 'flat', shift(liq, 0.4), { line: 0, plain: true }),
        c.detail > 0 && shine(circ(40, 72, 3.2), 0.55),
        c.detail > 0 && shine(circ(58, 79, 2.2), 0.5),
        c.detail > 1 && shine(circ(50, 64, 1.6), 0.5),
        shine(poly(arcBand(50, 63, 24.5, 29, 196, 252)), 0.85),
        shine(box(43, 15, 3.6, 22, 1.8), 0.6),
      ];
    },
  },

  scroll: {
    about: 'an open parchment scroll with a wax seal',
    draw: (c) => {
      const paper = T.paper;
      const seal = c.main(T.red);
      const roll = (y: number) => [
        part(circ(11, y, 6.5), 'wood', T.woodDark),
        part(circ(89, y, 6.5), 'wood', T.woodDark),
        part(pill(12, y - 7.5, 76, 15), 'paper', paper, { fx: { fill: { angle: 90, stops: [[0, paper.mid], [0.3, paper.hi], [1, paper.lo]] } } }),
      ];
      const lines = c.detail > 0 ? [30, 38, 46, 54, 62] : [32, 44, 56];
      const lens = [40, 34, 42, 30, 24];
      return [
        part(box(18, 14, 64, 72), 'paper', paper, { shadow: true }),
        ...lines.map((y, i) => inner(box(28, y, lens[i]!, c.detail > 0 ? 2.4 : 3.6, 1.2), 'flat', INKLINE, { line: 0, plain: true })),
        ...roll(14),
        ...roll(86),
        c.detail > 0 && inner(poly([[60, 72], [66, 72], [68, 90], [63, 86], [58, 90]], 0.8), 'matte', shift(seal, -0.1)),
        inner(circ(63, 70, c.detail > 0 ? 9 : 10), 'gloss', seal),
        c.detail > 0 && inner(starP(63, 70, 5, { inner: 0.5 }), 'flat', shift(seal, -0.25), { line: 0, plain: true }),
      ];
    },
  },

  book: {
    about: 'a closed spellbook with gold corners',
    draw: (c) => {
      const cover = c.main({ hi: '#ff8a7a', mid: '#c8283a', lo: '#5a0a1a' });
      return [
        part(box(22, 11, 66, 82, [3, 5, 6, 3]), 'paper', T.paper),
        c.detail > 0 && inner(box(80, 18, 1.2, 66), 'flat', T.paper, { line: 0, plain: true, fx: { fill: T.paper.lo } }),
        c.detail > 0 && inner(box(28, 86, 52, 1.2), 'flat', T.paper, { line: 0, plain: true, fx: { fill: T.paper.lo } }),
        part(box(12, 6, 68, 80, [3, 8, 8, 3]), 'matte', cover, { shadow: true }),
        inner(box(12, 6, 13, 80, [3, 0, 0, 3]), 'matte', shift(cover, -0.25), { line: 0.8 }),
        inner(poly([[66, 6], [80, 6], [80, 20]], 1), 'metal', T.gold, { line: 0.8 }),
        inner(poly([[80, 72], [80, 86], [66, 86]], 1), 'metal', T.gold, { line: 0.8 }),
        inner(poly([[50, 28], [64, 44], [50, 64], [36, 44]], 2), 'metal', T.gold, { line: 0.8 }),
        inner(poly([[50, 36], [57, 44], [50, 55], [43, 44]], 1), 'gem', c.tint ? T.cyan : T.cyan),
        c.detail > 0 && inner(poly([[56, 86], [64, 86], [64, 97], [60, 94], [56, 97]], 0.6), 'matte', T.gold),
        shine(box(28, 10, 40, 3, 1.5), 0.35),
      ];
    },
  },

  map: {
    about: 'a folded treasure map with a red X',
    draw: (c) => {
      const p = T.paper;
      const x = c.main(T.red);
      const trail: P2[] = cubic([16, 78], [30, 50], [50, 86], [70, 40], 12);
      return [
        part(poly([[6, 18], [36, 10], [36, 84], [6, 92]], 1.5), 'paper', p, { shadow: true }),
        part(poly([[36, 10], [64, 18], [64, 92], [36, 84]], 1.5), 'paper', shift(p, -0.12)),
        part(poly([[64, 18], [94, 10], [94, 84], [64, 92]], 1.5), 'paper', p),
        c.detail > 0 && inner(poly(blob(20, 33, 8, 5)), 'matte', T.leaf, { line: 0.6 }),
        c.detail > 1 && inner(poly(blob(51, 62, 6.5, 4)), 'matte', T.leaf, { line: 0.6 }),
        ...trail.slice(1, -1).filter((_, i) => i % 2 === 0).map(([tx, ty]) => inner(circ(tx, ty, c.detail > 0 ? 2.2 : 2.8), 'flat', INKLINE, { line: 0, plain: true })),
        part(crossShape(76, 32, 22, 0.3), 'gloss', x, { sil: false }),
      ];
    },
  },

  sword: {
    about: 'a sword with a gold guard',
    draw: (c) => {
      const steel = T.steel;
      const gold = c.main(T.gold);
      const r = (pts: P2[]) => rot(pts, -45);
      const at = (x: number, y: number) => r([[x, y]])[0]!;
      const [px, py] = at(-3, 50);
      const [gx, gy] = at(27, 50);
      const [hx, hy] = at(11, 50);
      return [
        part(poly(r([[30, 41.5], [94, 41.5], [112, 50], [94, 58.5], [30, 58.5]]), 1.5), 'metal', steel, { shadow: true }),
        c.detail > 0 && inner(poly(r([[33, 48.4], [88, 48.4], [95, 50], [88, 51.6], [33, 51.6]])), 'flat', shift(steel, -0.18), { line: 0, plain: true }),
        shine(poly(r([[32, 43.5], [93, 43.5], [107, 48.6], [32, 48.6]])), 0.5),
        part(rbox(hx, hy, 25, 11, -45, 3), 'matte', T.leather, { fx: { patterns: [{ kind: 'stripes', color: '#000000', opacity: 0.3, size: 4 * c.u, angle: 135, duty: 0.35 }] } }),
        part(rbox(gx, gy, 11, 44, -45, 5), 'metal', gold),
        part(circ(px, py, 9.5), 'metal', gold),
        inner(circ(gx, gy, 5), 'gem', c.tint ? shift(c.tint, 0.1) : T.red),
        c.detail > 0 && shine(circ(px - 3, py - 3, 2.4), 0.7),
      ];
    },
  },

  shield: {
    about: 'a knight\'s shield with a metal rim',
    draw: (c) => {
      const face = c.main(T.blue);
      const rim = c.rarity === 'legendary' || c.variant === 'premium' ? T.silver : T.gold;
      return [
        part(shieldP(9, 4, 82, 92, 12, 36), 'metal', rim, { shadow: true }),
        inner(shieldP(19, 14, 62, 72, 6, 27), 'gloss', face),
        inner(box(45, 15, 10, 68, 1), 'metal', rim, { line: 0.7, span: [14, 86] }),
        inner(box(20, 38, 60, 10, 1), 'metal', rim, { line: 0.7 }),
        inner(circ(50, 43, 9), 'metal', shift(rim, 0.1), { line: 0.8 }),
        c.detail > 0 && inner(circ(16, 12, 2.2), 'metal', shift(rim, 0.2), { line: 0.5, plain: true }),
        c.detail > 0 && inner(circ(84, 12, 2.2), 'metal', shift(rim, 0.2), { line: 0.5, plain: true }),
        c.detail > 0 && inner(circ(50, 92, 2.2), 'metal', shift(rim, 0.2), { line: 0.5, plain: true }),
        shine(poly([[23, 18], [42, 18], [42, 36], [23, 36]], 2), 0.3),
      ];
    },
  },

  bomb: {
    about: 'a round bomb with a lit fuse',
    draw: (c) => {
      const body = c.tint ? shift(c.tint, -0.45) : T.dark;
      return [
        part(poly(strokePts(quad([70, 24], [80, 6], [92, 12], 10), 4.5)), 'matte', CORK),
        part(circ(46, 58, 37), 'gloss', body, { shadow: true }),
        part(rbox(69, 28, 20, 13, 45, 2.5), 'metal', T.iron),
        shine(ellR(31, 42, 8, 14, 40), 0.55),
        shine(circ(42, 30, 3), 0.6),
        part(sparkleP(92, 11, c.detail > 0 ? 11 : 13, 0.55), 'glow', T.flame, { sil: false, line: 0 }),
        shine(circ(92, 11, 3), 0.95),
      ];
    },
  },

  skull: {
    about: 'a cartoon skull',
    draw: (c) => {
      const bone = T.bone;
      const eye = c.tint && c.rarity !== 'common' ? c.tint : null;
      return [
        part(box(26, 56, 48, 34, [6, 6, 14, 14]), 'matte', bone),
        part(ell(50, 42, 40, 37), 'matte', bone, { shadow: true }),
        inner(ellR(34, 48, 10.5, 12, 12), 'flat', T.hole, { line: 0 }),
        inner(ellR(66, 48, 10.5, 12, -12), 'flat', T.hole, { line: 0 }),
        eye && inner(circ(35, 50, 4.5), 'glow', eye, { line: 0 }),
        eye && inner(circ(65, 50, 4.5), 'glow', eye, { line: 0 }),
        inner(poly([[50, 59], [44.5, 69], [55.5, 69]], 2), 'flat', T.hole, { line: 0 }),
        ...[38, 46, 54, 62].map((x) => inner(box(x - 0.9, 76, 1.8, 13, 0.9), 'flat', T.hole, { line: 0, plain: true })),
        inner(box(30, 77, 40, 1.6, 0.8), 'flat', T.hole, { line: 0, plain: true }),
        c.detail > 1 && inner(poly(strokePts([[60, 10], [56, 17], [61, 21], [57, 28]], 1.4, 'flat')), 'flat', shift(bone, -0.35), { line: 0, plain: true }),
        shine(ellR(32, 22, 9, 5, -30), 0.6),
      ];
    },
  },

  lock: {
    about: 'a padlock',
    draw: (c) => {
      const body = c.main(T.gold);
      return [
        part(ringP(50, 40, 25, 27, 9), 'metal', T.silver),
        part(box(14, 40, 72, 54, 10), 'metal', body, { shadow: true }),
        inner(circ(50, 61, 7), 'flat', T.hole, { line: 0 }),
        inner(poly([[47, 62], [53, 62], [55, 79], [45, 79]], 1.5), 'flat', T.hole, { line: 0 }),
        c.detail > 0 && inner(box(14, 48, 72, 1.4), 'flat', shift(body, -0.25), { line: 0, plain: true, opacity: 0.6 }),
        shine(box(20, 45, 6, 24, 3), 0.5),
      ];
    },
  },

  hourglass: {
    about: 'an hourglass with sand',
    draw: (c) => {
      const sand = c.main(SAND);
      const glass = path(cubic([24, 16], [24, 40], [46, 44], [47, 50], 10), cubic([47, 50], [46, 56], [24, 60], [24, 84], 10), [[76, 84]], cubic([76, 84], [76, 60], [54, 56], [53, 50], 10), cubic([53, 50], [54, 44], [76, 40], [76, 16], 10));
      return [
        part(poly(glass), 'glass', T.glass),
        inner(poly([...cubic([31, 30], [36, 40], [46, 44], [48, 49], 8), [52, 49], ...cubic([52, 49], [54, 44], [64, 40], [69, 30], 8)]), 'liquid', sand, { line: 0 }),
        inner(poly([[49.2, 48], [50.8, 48], [50.8, 80], [49.2, 80]]), 'flat', sand, { line: 0, plain: true }),
        inner(poly([[27, 82], ...quad([30, 70], [50, 60], [70, 70], 10), [73, 82]]), 'liquid', sand, { line: 0 }),
        part(box(18, 14, 6, 72, 2), 'wood', T.woodDark),
        part(box(76, 14, 6, 72, 2), 'wood', T.woodDark),
        part(box(12, 5, 76, 12, 4), 'wood', T.wood, { shadow: true }),
        part(box(12, 83, 76, 12, 4), 'wood', T.wood),
        shine(poly(cubic([30, 20], [30, 34], [38, 40], [42, 42], 8).concat(cubic([40, 40], [34, 34], [34, 24], [34, 20], 8))), 0.6),
      ];
    },
  },

  clock: {
    about: 'an alarm clock',
    draw: (c) => {
      const body = c.main(T.red);
      const hand = (deg: number, len: number, wid: number) => poly(strokePts([[50, 55], [50 + Math.cos((deg * Math.PI) / 180) * len, 55 + Math.sin((deg * Math.PI) / 180) * len]], wid));
      return [
        part(rbox(25, 88, 7, 15, 35, 3), 'metal', T.iron),
        part(rbox(75, 88, 7, 15, -35, 3), 'metal', T.iron),
        part(ellR(23, 20, 14, 11, -38), 'metal', T.gold),
        part(ellR(77, 20, 14, 11, 38), 'metal', T.gold),
        part(box(46, 9, 8, 10, 2), 'metal', T.gold),
        part(circ(50, 55, 38), 'gloss', body, { shadow: true }),
        inner(circ(50, 55, 29), 'matte', T.white, { line: 0.9 }),
        ...[[50, 31], [74, 55], [50, 79], [26, 55]].map(([x, y]) => inner(circ(x!, y!, 2.4), 'flat', T.ink, { line: 0, plain: true })),
        inner(hand(-90, 19, 4.2), 'flat', T.ink, { line: 0, plain: true }),
        inner(hand(-30, 14, 5), 'flat', T.ink, { line: 0, plain: true }),
        inner(circ(50, 55, 3.6), 'metal', T.gold, { line: 0.6, plain: true }),
        shine(poly(arcBand(50, 55, 30.5, 35, 200, 250)), 0.75),
      ];
    },
  },

  dice: {
    about: 'a die in three-quarter view',
    draw: (c) => {
      const body = c.tint ?? T.white;
      const pip = c.tint ? T.white : T.red;
      const pipAt = (x: number, y: number, deg: number) => inner(ellR(x, y, 5, 3.8, deg), 'flat', pip, { line: 0, plain: true, fx: { fill: c.tint ? '#ffffff' : '#d8202e' } });
      return [
        part(poly([[50, 6], [92, 27], [92, 74], [50, 95], [8, 74], [8, 27]], 6), 'matte', body, { shadow: true }),
        inner(poly([[50, 7], [91, 27.5], [50, 48], [9, 27.5]], 5), 'gloss', shift(body, 0.12), { line: 0.8 }),
        inner(poly([[50, 48], [91, 27.5], [91, 73.5], [50, 94]], 5), 'matte', shift(body, -0.22), { line: 0.8 }),
        inner(ell(50, 27.5, 7, 4.2), 'flat', pip, { line: 0, plain: true, fx: { fill: c.tint ? '#ffffff' : '#d8202e' } }),
        pipAt(19.8, 46.2, 62),
        pipAt(38.2, 75.8, 62),
        pipAt(60.3, 54.4, -62),
        pipAt(70.5, 60.8, -62),
        pipAt(80.7, 67.1, -62),
        shine(poly([[28, 22], [44, 14], [48, 16], [32, 24]], 1), 0.5),
      ];
    },
  },
};
