import { circ, cubic, ellPts, path, poly, rot, scalePts, strokePts, type P2, type Piece } from './geo';
import { inner, part, shift, shine, T, type PropDef, type Tone } from './kit';

/**
 * Power-ups and tools: rockets, magnets, ×2 boosts, level-up arrows and pickaxes, drawn as filled, shaded objects in
 * the unit frame (light from the upper left).
 */

const BOOST: Tone = { hi: '#d8ff9a', mid: '#46d84a', lo: '#127a2a' };
const X2: Tone = { hi: '#fff8b0', mid: '#ffcc22', lo: '#d86a00' };
const FIRE: Tone = { hi: '#fff4a0', mid: '#ffa01a', lo: '#e0400a' };
const GLASS: Tone = { hi: '#e4fbff', mid: '#5cc8ff', lo: '#1a5ab8' };

/** The digit 2 as one outline: a thick hook, a diagonal and a foot. */
function two(): P2[] {
  const [cx, cy, ro, ri] = [64, 31, 23, 9.5];
  const at = (r: number, deg: number): P2 => [cx + Math.cos((deg * Math.PI) / 180) * r, cy + Math.sin((deg * Math.PI) / 180) * r];
  const outEnd = at(ro, 30);
  const inEnd = at(ri, 30);
  const capC: P2 = [(at(ro, 195)[0] + at(ri, 195)[0]) / 2, (at(ro, 195)[1] + at(ri, 195)[1]) / 2];
  const capR = (ro - ri) / 2;
  return path(
    ellPts(cx, cy, ro, ro, { a0: 195, a1: 390, n: 28 }),
    [[outEnd[0], outEnd[1]], [62, 74], [94, 74], [94, 93], [38, 93], [38, 78], [inEnd[0] - 1.5, inEnd[1] + 1.5]],
    ellPts(cx, cy, ri, ri, { a0: 390, a1: 195, n: 20 }),
    ellPts(capC[0], capC[1], capR, capR, { a0: 15, a1: 195, n: 12 }),
  );
}

export const POWER: Record<string, PropDef> = {
  rocket: {
    about: 'a rocket with fins and a flame',
    draw: (c) => {
      const accent = c.main(T.red);
      const r = (pts: P2[]) => rot(pts, 45, 50, 52);
      const at = (x: number, y: number) => r([[x, y]])[0]!;
      const body = path(cubic([50, 4], [64, 14], [70, 30], [68, 50], 14), [[65, 76], [35, 76]], cubic([32, 50], [30, 30], [36, 14], [50, 4], 14));
      const nose = path(cubic([50, 4], [60, 11], [64, 18], [66, 27], 10), [[34, 27]], cubic([34, 27], [36, 18], [40, 11], [50, 4], 10));
      const flame = path(cubic([38, 78], [36, 88], [44, 96], [50, 104], 8), cubic([50, 104], [56, 96], [64, 88], [62, 78], 8));
      const [wx, wy] = at(50, 45);
      return [
        part(poly(r(flame)), 'glow', FIRE, { sil: false }),
        part(poly(r([[34, 54], [16, 74], [18, 88], [36, 76]]), 2.5), 'gloss', accent),
        part(poly(r([[66, 54], [84, 74], [82, 88], [64, 76]]), 2.5), 'gloss', accent),
        part(poly(r([[38, 72], [62, 72], [60, 82], [40, 82]]), 2), 'metal', T.iron),
        part(poly(r(body), 2), 'gloss', T.white, { shadow: true }),
        inner(poly(r(nose), 1.5), 'gloss', accent),
        inner(circ(wx, wy, 10.5), 'metal', T.silver),
        inner(circ(wx, wy, 7), 'gloss', GLASS, { line: 0.6 }),
        shine(circ(wx - 2.5, wy - 2.5, 2.4), 0.85),
      ];
    },
  },

  magnet: {
    about: 'a horseshoe magnet',
    draw: (c) => {
      const t = c.main(T.red);
      const r = (pts: P2[]) => rot(scalePts(pts, 0.88), -40, 50, 50);
      const u = path([[12, 12], [12, 52]], ellPts(50, 52, 38, 38, { a0: 180, a1: 0, n: 32 }), [[88, 52], [88, 12], [66, 12], [66, 52]], ellPts(50, 52, 16, 16, { a0: 0, a1: 180, n: 20 }), [[34, 52], [34, 12]]);
      return [
        part(poly(r(u), 1.5), 'gloss', t, { shadow: true }),
        part(poly(r([[11, 4], [35, 4], [35, 22], [11, 22]]), 2), 'metal', T.silver),
        part(poly(r([[65, 4], [89, 4], [89, 22], [65, 22]]), 2), 'metal', T.silver),
        shine(poly(r(path(ellPts(50, 52, 33, 33, { a0: 150, a1: 115, n: 8 }), [[17, 30], [20, 30]]))), 0),
        shine(poly(r([[16, 26], [20, 26], [20, 50], [16, 50]]), 2), 0.5),
      ];
    },
  },

  x2: {
    about: 'a ×2 multiplier boost',
    draw: (c) => {
      const t = c.main(X2);
      const cross: Piece = { shape: { kind: 'cross', thickness: 0.32 }, at: [3, 50, 34, 34] };
      return [part(cross, 'gloss', t, { span: [8, 93] }), part(poly(two(), 1), 'gloss', t, { shadow: true, span: [8, 93] }), shine(poly(ellPts(64, 31, 19, 19, { a0: 205, a1: 290, n: 10 }).concat(ellPts(64, 31, 14, 14, { a0: 290, a1: 205, n: 10 }))), 0.6)];
    },
  },

  boost: {
    about: 'a double up-arrow boost',
    draw: (c) => {
      const t = c.main(BOOST);
      const chevron = (y: number): P2[] => [[50, y], [92, y + 36], [92, y + 52], [50, y + 22], [8, y + 52], [8, y + 36]];
      return [part(poly(chevron(44), 3), 'gloss', shift(t, -0.08)), part(poly(chevron(6), 3), 'gloss', t, { shadow: true }), shine(poly([[50, 12], [86, 43], [86, 46], [50, 17], [14, 46], [14, 43]], 1), 0.55)];
    },
  },

  pickaxe: {
    about: 'a pickaxe',
    draw: (c) => {
      const head = c.main(T.steel);
      const [ox, oy, R] = [14, 86, 70];
      const pts: P2[] = [];
      const inner_: P2[] = [];
      for (let i = 0; i <= 24; i++) {
        const s = i / 24;
        const a = ((-82 + 74 * s) * Math.PI) / 180;
        const th = 4 + 20 * Math.sin(Math.PI * s) ** 0.7;
        pts.push([ox + Math.cos(a) * (R + th / 2), oy + Math.sin(a) * (R + th / 2)]);
        inner_.push([ox + Math.cos(a) * (R - th / 2), oy + Math.sin(a) * (R - th / 2)]);
      }
      const arc = path(pts, inner_.reverse());
      return [
        part(poly(strokePts([[11, 91], [64, 38]], 11)), 'wood', T.wood, { angle: 45 }),
        part(poly(arc, 1.5), 'metal', head, { shadow: true }),
        part(poly(rot([[56, 30], [70, 30], [70, 50], [56, 50]], 45, 63, 40), 2), 'metal', T.iron),
        c.detail > 0 && shine(poly(path(ellPts(ox, oy, R + 6, R + 6, { a0: -74, a1: -40, n: 12 }), ellPts(ox, oy, R + 2.5, R + 2.5, { a0: -40, a1: -74, n: 12 }))), 0.6),
      ];
    },
  },
};
