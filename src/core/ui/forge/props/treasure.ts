import { arcBand, box, circ, ell, ellPts, ellR, eggPts, heartP, inset, poly, quad, rbox, ringP, rot, sparkleP, starP, type P2 } from './geo';
import { inner, part, shade, shift, shine, T, type PropDef, type Tone } from './kit';

/**
 * Treasure and rewards: eggs, chests, gems, coins, keys, crowns, stars, hearts and lightning, drawn as filled, shaded
 * objects in the unit frame (light from the upper left).
 */

const EGG: Tone = { hi: '#ffffff', mid: '#fff3dc', lo: '#d6b07a' };
const EGG_SPOT: Tone = { hi: '#9ff5e4', mid: '#2fc6a8', lo: '#0f7a6a' };
const GEM: Tone = { hi: '#e6fcff', mid: '#38c4ff', lo: '#0a50c0' };

export const TREASURE: Record<string, PropDef> = {
  egg: {
    about: 'a speckled pet egg',
    draw: (c) => {
      const shell = c.main(EGG);
      const spot = c.tint ? shift(c.tint, 0.5) : EGG_SPOT;
      return [
        part(poly(eggPts(50, 52, 34, 44)), 'gloss', shell),
        inner(ellR(35, 67, 11, 8.5, -24), 'matte', spot, { line: 0 }),
        inner(ellR(64, 45, 8.5, 6.5, 28), 'matte', spot, { line: 0 }),
        inner(ellR(61, 77, 6.5, 5, 12), 'matte', spot, { line: 0 }),
        c.detail > 0 && inner(ellR(30, 46, 4, 3.4, 0), 'matte', spot, { line: 0 }),
        c.detail > 0 && inner(ellR(70, 62, 3.6, 3, 0), 'matte', spot, { line: 0 }),
        shine(ellR(36, 30, 6.5, 11, 32), 0.8),
        shine(circ(46, 19, 2.6), 0.8),
      ];
    },
  },

  chest: {
    about: 'a wooden treasure chest with metal bands and a lock',
    draw: (c) => {
      const metal = c.main(T.gold);
      const wood = T.wood;
      const top = (x: number) => 48 - 34 * Math.sqrt(Math.max(0, 1 - ((x - 50) / 42) ** 2));
      const band = (x0: number, x1: number): P2[] => {
        const pts: P2[] = [[x0, 46]];
        for (let i = 0; i <= 8; i++) {
          const x = x0 + ((x1 - x0) * i) / 8;
          pts.push([x, top(x) - 1.2]);
        }
        pts.push([x1, 46]);
        return pts;
      };
      return [
        part(poly([...ellPts(50, 48, 42, 34, { a0: 180, a1: 360, n: 40 })]), 'wood', shift(wood, 0.06), { shadow: true }),
        part(box(10, 46, 80, 46, [2, 2, 7, 7]), 'wood', wood, { shadow: true }),
        c.detail > 0 && inner(box(10, 64, 80, 1.4), 'flat', T.woodDark, { line: 0 }),
        c.detail > 0 && inner(box(10, 78, 80, 1.4), 'flat', T.woodDark, { line: 0 }),
        c.detail > 0 && inner(box(14, 26, 1.4, 18), 'flat', T.woodDark, { line: 0, opacity: 0.6 }),
        shade(box(10, 50, 80, 7), T.shadow, 0.3),
        part(poly(band(19, 30)), 'metal', metal, { span: [12, 50] }),
        part(poly(band(70, 81)), 'metal', metal, { span: [12, 50] }),
        part(box(19, 50, 11, 42, [0, 0, 3, 3]), 'metal', metal, { span: [50, 92] }),
        part(box(70, 50, 11, 42, [0, 0, 3, 3]), 'metal', metal, { span: [50, 92] }),
        part(box(5, 41, 90, 11, 4), 'metal', metal),
        part(poly([[39, 38], [61, 38], [61, 56], [50, 64], [39, 56]], 3), 'metal', shift(metal, 0.08)),
        inner(circ(50, 48.5, 3.6), 'flat', T.hole, { line: 0 }),
        inner(poly([[48.3, 49], [51.7, 49], [52.8, 57.5], [47.2, 57.5]], 0.6), 'flat', T.hole, { line: 0 }),
        c.detail > 1 && inner(circ(24.5, 58, 1.6), 'metal', shift(metal, 0.2), { line: 0.6 }),
        c.detail > 1 && inner(circ(24.5, 84, 1.6), 'metal', shift(metal, 0.2), { line: 0.6 }),
        c.detail > 1 && inner(circ(75.5, 58, 1.6), 'metal', shift(metal, 0.2), { line: 0.6 }),
        c.detail > 1 && inner(circ(75.5, 84, 1.6), 'metal', shift(metal, 0.2), { line: 0.6 }),
        shine(ellR(36, 24, 9, 3.2, -24), 0.45),
      ];
    },
  },

  gem: {
    about: 'a cut gem (brilliant cut)',
    currency: true,
    draw: (c) => {
      const g = c.main(GEM);
      const TL: P2 = [24, 12];
      const TR: P2 = [76, 12];
      const R: P2 = [97, 36];
      const B: P2 = [50, 95];
      const L: P2 = [3, 36];
      const a: P2 = [38, 12];
      const b: P2 = [62, 12];
      const cl: P2 = [30, 36];
      const cr: P2 = [70, 36];
      const facet = (pts: P2[], k: number) => inner(poly(inset(pts, 0.93), 0.5), 'flat', shift(g, k), { line: 0 });
      return [
        part(poly([TL, TR, R, B, L], 2.5), 'gem', shift(g, -0.12)),
        facet([TL, a, cl, L], 0.3),
        facet([a, b, cr, cl], 0.55),
        facet([b, TR, R, cr], 0.05),
        facet([L, cl, B], 0.12),
        facet([cl, cr, B], 0.3),
        facet([cr, R, B], -0.22),
        shine(poly([[27, 15], [36, 15], [28, 33], [10, 33]], 1), 0.4),
        shine(sparkleP(70, 22, c.detail ? 9 : 7), 0.95),
      ];
    },
  },

  coin: {
    about: 'a gold coin with a star',
    currency: true,
    draw: (c) => {
      const g = c.main(T.gold);
      return [
        part(ell(50, 54, 44, 41), 'metal', shift(g, -0.3), { shadow: true }),
        part(ell(50, 48, 44, 41), 'metal', g),
        inner(ell(50, 48, 33, 30.5), 'metal', shift(g, -0.1), { line: 0.7, angle: 270 }),
        inner(starP(50, 49, 21, { inner: 0.5, round: 2 }), 'metal', shift(g, 0.12), { line: 0.7 }),
        shine(poly(arcBand(50, 48, 37, 41, 195, 255)), 0.75),
        c.detail > 0 && shine(circ(76, 66, 2), 0.7),
      ];
    },
  },

  heart: {
    about: 'a glossy heart',
    draw: (c) => {
      const t = c.main(T.red);
      return [part(heartP(50, 53, 94, 88), 'gloss', t), shine(ellR(29, 31, 8, 12.5, 40), 0.8), shine(circ(41, 22, 3), 0.8)];
    },
  },

  star: {
    about: 'a gold star',
    draw: (c) => {
      const t = c.main(T.gold);
      return [
        part(starP(50, 54, 48, { inner: 0.52, round: 5 }), 'gloss', t),
        inner(starP(50, 55, 26, { inner: 0.52, round: 3 }), 'gloss', shift(t, 0.18), { line: 0, opacity: 0.9 }),
        shine(ellR(37, 36, 5, 9, 35), 0.75),
      ];
    },
  },

  key: {
    about: 'a gold key',
    draw: (c) => {
      const t = c.main(T.gold);
      const k = (pts: P2[]) => rot(pts, 45);
      return [
        part(rbox(62, 62, 58, 12, 45, 2.5), 'metal', t),
        part(poly(k([[75, 54], [83, 54], [83, 71], [75, 71]]), 1.5), 'metal', t),
        part(poly(k([[87, 54], [94, 54], [94, 66], [87, 66]]), 1.5), 'metal', t),
        part(poly(k([[36, 40], [44, 40], [44, 60], [36, 60]]), 2), 'metal', shift(t, -0.05)),
        part(ringP(28.8, 28.8, 21, 21, 11), 'metal', t, { shadow: true }),
        inner(circ(28.8, 28.8, 7.5), 'gem', c.tint ? T.red : T.cyan),
        shine(poly(arcBand(28.8, 28.8, 14, 18.5, 200, 260)), 0.7),
      ];
    },
  },

  crown: {
    about: 'a jewelled crown',
    draw: (c) => {
      const t = c.main(T.gold);
      return [
        part(poly([[13, 70], [8, 26], [31, 48], [50, 16], [69, 48], [92, 26], [87, 70]], 2.5), 'metal', t, { span: [14, 88] }),
        part(poly([[11, 62], [89, 62], ...quad([89, 82], [50, 92], [11, 82])], 2), 'metal', shift(t, -0.04), { span: [14, 88] }),
        part(circ(8, 24, 6.5), 'metal', t),
        part(circ(50, 14, 7.5), 'metal', t),
        part(circ(92, 24, 6.5), 'metal', t),
        inner(poly([[50, 62], [57, 72], [50, 82], [43, 72]], 1.5), 'gem', T.red),
        inner(circ(28, 73, 5), 'gem', T.blue),
        inner(circ(72, 73, 5), 'gem', T.blue),
        c.detail > 0 && inner(circ(50, 42, 4.5), 'gem', T.green),
        shine(poly([[16, 64], [40, 64], [38, 67], [16, 67]], 1), 0.5),
      ];
    },
  },

  lightning: {
    about: 'a lightning bolt',
    draw: (c) => {
      const t = c.main(T.yellow);
      return [part(poly([[60, 3], [17, 56], [45, 56], [35, 97], [84, 39], [56, 39], [74, 3]], 2.5), 'gloss', t), shine(poly([[61, 9], [27, 51], [35, 51], [66, 10]], 1), 0.55)];
    },
  },
};
