import { arcBand, box, circ, clipHalf, cubic, ell, ellPts, ellR, path, pill, poly, quad, ringP, rodPts, starP, strokePts, taper, type P2 } from './geo';
import { inner, part, shade, shift, shine, T, type Part, type PropCtx, type PropDef, type Tone } from './kit';

/**
 * Vehicles: a supercar, a formula race car, a kart, a monster truck, a sport bike, a speedboat, a propeller plane and
 * a helicopter, side on and facing right (light from the upper left) — the garage, shop and unlock art of racing,
 * driving and tycoon games. Glossy paint wears the variant (a legendary supercar is gold, a rare one blue); tyres,
 * glass, chrome and trim keep their own materials.
 */

const tone = (hi: string, mid: string, lo: string): Tone => ({ hi, mid, lo });
const RED: Tone = tone('#ff9a8c', '#e8192c', '#6a0010');
const BLUE: Tone = tone('#a4d4ff', '#2474f0', '#0a2a84');
const GREEN: Tone = tone('#c0ff96', '#34c43c', '#0c5a1c');
const ORANGE: Tone = tone('#ffd494', '#ff7c14', '#9a3000');
const YELLOW: Tone = tone('#fffbc0', '#ffcf2a', '#c47000');
const TYRE: Tone = tone('#6a6e78', '#2a2c33', '#0b0c10');
const WELL: Tone = tone('#3c3e48', '#17181e', '#050608');
const CARBON: Tone = tone('#62666f', '#2a2d34', '#0c0d11');
const TINT: Tone = tone('#b4dcff', '#335a86', '#0c1a30');
const LAMP: Tone = tone('#ffffff', '#fff4c4', '#e8b44a');
const TAIL: Tone = tone('#ffb4a4', '#ff2a24', '#8a0000');
const SEAT: Tone = tone('#5e5a66', '#2c2a32', '#0e0d12');
const WATER: Tone = tone('#c4f6ff', '#2cb8f0', '#0a5aa8');

/** The part of an outline between two parallel diagonal lines x + k·y = d0 and d1 (a reflection band on glass). */
const band = (pts: P2[], d0: number, d1: number, k = 0.7): P2[] => clipHalf(clipHalf(pts, 1, k, -d0), -1, -k, d1);

/** A wheel side on: tyre (treaded for off-road), rim (spoked with a chrome lip from 64 pt up), hub and a sheen on the tyre wall. */
function wheel(c: PropCtx, cx: number, cy: number, r: number, o: { rim?: Tone; spokes?: number; rimK?: number; tread?: boolean } = {}): Array<Part | false> {
  const rim = o.rim ?? T.silver;
  const rr = r * (o.rimK ?? 0.64);
  const tyre = o.tread ? part(starP(cx, cy, r, { points: Math.round(r * 0.7), inner: 0.88, round: r * 0.05 }), 'matte', TYRE) : part(circ(cx, cy, r), 'matte', TYRE);
  return [
    tyre,
    !!o.tread && inner(circ(cx, cy, r * 0.86), 'matte', TYRE, { line: 0.5 }),
    shine(poly(arcBand(cx, cy, r * 0.74, r * 0.84, 200, 262, 16)), 0.22),
    c.detail > 0 ? inner(circ(cx, cy, rr), 'flat', WELL, { line: 0.6 }) : inner(circ(cx, cy, rr), 'metal', rim, { line: 0.6 }),
    c.detail > 0 && inner(starP(cx, cy, rr * 0.94, { points: o.spokes ?? 5, inner: 0.34, round: rr * 0.1 }), 'metal', rim, { line: 0.5 }),
    c.detail > 0 && inner(ringP(cx, cy, rr, rr, rr * 0.16), 'metal', rim, { line: 0.5 }),
    inner(circ(cx, cy, rr * (c.detail > 0 ? 0.3 : 0.34)), 'metal', c.detail > 0 ? shift(rim, -0.08) : CARBON, { line: 0.5, plain: true }),
  ];
}

/** A wheel arch over a wheel: the dark well a body's arch shows (a half disc). */
const well = (cx: number, cy: number, r: number) => part(poly(ellPts(cx, cy, r, r, { a0: 180, a1: 360, n: 20 })), 'flat', WELL);

/** A body's edge round the top of a wheel (cx, cy): an arch of radius r meeting the sill `below` units under the hub. */
const arch = (cx: number, cy: number, r: number, below = 4): P2[] => {
  const a = (Math.asin(Math.min(1, below / r)) * 180) / Math.PI;
  return ellPts(cx, cy, r, r, { a0: a, a1: -180 - a, n: 20 });
};

// ─── The supercar ─────────────────────────────────────────────────────────────────────────────────

const CAR_BODY: P2[] = path(
  [[6.5, 62]],
  cubic([6.5, 62], [3.8, 57], [3.2, 50], [4.2, 44], 8),
  [[9.4, 44.6]],
  cubic([9.4, 44.6], [18, 43], [28, 35.4], [38, 33.4], 12),
  cubic([38, 33.4], [44, 32.4], [49, 32.2], [53, 32.6], 6),
  cubic([53, 32.6], [60, 33.6], [65, 37.4], [70, 41.6], 10),
  cubic([70, 41.6], [80, 43.2], [90, 45.2], [95.6, 48.8], 10),
  quad([95.6, 48.8], [98.8, 52], [97, 56], 6),
  quad([97, 56], [96, 60.4], [92.6, 62], 4),
  arch(78, 58, 13.4),
  arch(25, 58, 13.4),
  [[8.4, 62]],
);
/** The side window: a teardrop under the roof, raked to the windscreen. */
const CAR_GLASS: P2[] = path(quad([33.6, 44.2], [40, 36], [49, 35.2], 8), quad([49, 35.2], [58, 35], [66.4, 43.2], 8), [[63.6, 44.4]]);

// ─── Vehicles ─────────────────────────────────────────────────────────────────────────────────────

export const VEHICLES: Record<string, PropDef> = {
  'sports-car': {
    wide: true,
    base: TYRE,
    about: 'a sleek low supercar side on: glossy paint, tinted glass, a side intake and chrome rims on low tyres',
    draw: (c) => {
      const paint = c.main(RED);
      const span: [number, number] = [32, 62];
      return [
        part(poly(path([[1.4, 37.6]], quad([1.4, 37.6], [10, 37.2], [18.4, 38.6], 6), [[17.6, 40.6]], quad([17.6, 40.6], [10, 40.2], [2.2, 40.8], 6)), 0.8), 'gloss', CARBON),
        part(poly([[11, 40], [13.4, 40], [14.6, 44.4], [11.6, 44.6]], 0.5), 'matte', CARBON),
        well(25, 58, 13.4),
        well(78, 58, 13.4),
        part(poly(CAR_BODY), 'gloss', paint, { shadow: true, span }),
        inner(poly(CAR_GLASS, 1.2), 'gloss', TINT, { line: 0.8 }),
        shine(poly(band(CAR_GLASS, 62, 69)), 0.42),
        c.detail > 0 && shine(poly(band(CAR_GLASS, 70, 72.5)), 0.3),
        c.detail > 0 && inner(poly([[51.4, 35.2], [54.2, 35.2], [56.2, 44.5], [52.6, 44.5]], 0.6), 'gloss', paint, { line: 0.6, span }),
        inner(poly(path([[58, 47.6]], quad([58, 47.6], [48, 47.6], [40.2, 48.8], 6), [[41.2, 56.2]], quad([41.2, 56.2], [48, 52.6], [58, 47.6], 8)), 1.2), 'flat', WELL, { line: 0.6 }),
        c.detail > 0 && inner(poly(path([[52, 49.2]], quad([52, 49.2], [46, 49.4], [42.6, 50.2], 4), [[43.2, 53.4]], quad([43.2, 53.4], [47, 51.4], [52, 49.2], 4)), 0.8), 'flat', CARBON, { line: 0, plain: true }),
        shade(poly(clipHalf(CAR_BODY, 0, 1, -53)), T.shadow, 0.24),
        c.detail > 0 && shine(poly(clipHalf(clipHalf(CAR_BODY, 0, 1, -50.8), 0, -1, 52.6)), 0.2),
        c.detail > 0 && inner(poly([[38.6, 59.4], [64.4, 59.4], [64.6, 62], [38.4, 62]], 0.8), 'matte', CARBON, { line: 0.5 }),
        c.detail > 0 && inner(poly([[87.6, 58.6], [96.6, 56.6], [94.4, 60.8], [90.2, 61.6]], 1), 'flat', WELL, { line: 0.5 }),
        c.detail > 0 && inner(poly(strokePts(quad([57.6, 45.2], [60, 51], [59.6, 58], 8), 0.9, 'flat')), 'flat', shift(paint, -0.45), { line: 0, plain: true }),
        inner(poly([[84.4, 45], [93.8, 47.4], [96.8, 51.2], [88, 49.8]], 1), 'glass', LAMP, { line: 0.6 }),
        inner(poly([[4.4, 46.4], [10.6, 45.2], [11, 47.6], [4.2, 50]], 0.8), 'glow', TAIL, { line: 0.5 }),
        shine(poly(taper(cubic([11.6, 46.4], [36, 46.6], [66, 45.2], [93.6, 49.4], 24), 2.2, 0.5)), 0.75),
        shine(poly(taper(cubic([30, 37.4], [37, 34.2], [44, 33.4], [52, 33.4], 12), 1.6, 0.3)), 0.6),
        shine(poly(taper(cubic([72, 43.4], [80, 44.4], [88, 46], [94, 48.4], 10), 1.4, 0.3)), 0.55),
        ...wheel(c, 25, 58, 11.4, { rimK: 0.7 }),
        ...wheel(c, 78, 58, 11.4, { rimK: 0.7 }),
      ];
    },
  },

  'race-car': {
    wide: true,
    base: TYRE,
    about: 'an open-wheel formula race car side on, the driver\'s helmet in the cockpit, front and rear wings',
    draw: (c) => {
      const paint = c.main(BLUE);
      const body = path(
        [[9, 61]],
        [[9, 50]],
        [[17, 46.6]],
        cubic([17, 46.6], [24, 42], [28, 33], [34, 31.4], 10),
        [[42, 30.6]],
        [[43.4, 38.4], [46, 42.2], [60, 42.2]],
        cubic([60, 42.2], [70, 44.6], [86, 51], [96.4, 56.6], 12),
        quad([96.4, 56.6], [99.4, 58.6], [96.6, 61.4], 6),
        [[70, 62.4], [58, 64], [12, 63.4]],
      );
      return [
        part(poly([[9.4, 24], [12.6, 24], [15.6, 48], [11.8, 48]], 1), 'matte', CARBON),
        part(poly([[1, 19.6], [21.6, 19], [21.6, 23.4], [16, 25.6], [2.4, 25.8]], 1.6), 'gloss', paint),
        c.detail > 0 && inner(poly(taper([[3.4, 22.8], [19.6, 21.6]], 1.4, 0.8)), 'flat', CARBON, { line: 0, plain: true }),
        part(circ(51.2, 38.4, 7), 'gloss', T.yellow),
        inner(poly([[50.4, 34.6], [57.8, 35], [58.4, 39.4], [51.2, 39.8]], 1.6), 'gloss', TINT, { line: 0.5 }),
        part(poly([[78, 71.4], [98.6, 67.4], [99.4, 71.6], [80.4, 74.6]], 1.4), 'gloss', paint),
        part(poly([[94.6, 64.6], [97.8, 64.2], [99.4, 71.6], [96, 72.2]], 1), 'matte', CARBON),
        part(poly(body), 'gloss', paint, { shadow: true, span: [30, 64] }),
        inner(poly([[30, 49.6], [55, 46.2], [62, 47], [62.4, 63.2], [30.4, 63.2]], 3), 'gloss', shift(paint, 0.06), { line: 0.7, span: [30, 64] }),
        inner(poly([[56.6, 47.6], [61.8, 47.4], [62, 53.4], [57.6, 52.6]], 1), 'flat', WELL, { line: 0.5 }),
        inner(poly([[41.4, 31.8], [42.6, 31.8], [43.6, 37.6], [42, 37.8]], 0.4), 'flat', WELL, { line: 0, plain: true }),
        inner(poly(taper([[64, 47.2], [80, 51.8], [95.6, 57.6]], 3.2, 1)), 'flat', T.white, { line: 0, plain: true }),
        c.detail > 0 && inner(poly(taper([[31, 56.6], [61, 54.2]], 2.6, 2.6)), 'flat', T.white, { line: 0, plain: true }),
        shade(poly(clipHalf(body, 0, 1, -56)), T.shadow, 0.2),
        shine(poly(taper(cubic([20, 47.6], [26, 41], [30, 34], [40, 32.2], 12), 1.8, 0.5)), 0.6),
        shine(poly(taper([[62, 44], [80, 48.6], [93, 54.4]], 1.6, 0.4)), 0.65),
        shine(circ(49, 34.4, 1.8), 0.85),
        ...wheel(c, 21, 63, 15.2, { rim: T.silver, spokes: 6, rimK: 0.58 }),
        ...wheel(c, 77, 66, 12.4, { rim: T.silver, spokes: 6, rimK: 0.58 }),
      ];
    },
  },

  kart: {
    wide: true,
    base: TYRE,
    about: 'a go-kart side on with its helmeted driver at the wheel',
    draw: (c) => {
      const paint = c.main(GREEN);
      const suit = T.white;
      const nose = path([[54, 62]], cubic([54, 62], [68, 57], [88, 59], [97.4, 66], 10), quad([97.4, 66], [99, 72], [94, 75], 6), [[62, 77], [52, 72]]);
      return [
        part(box(4, 57, 17, 12, 3), 'metal', T.iron),
        part(pill(0.6, 59.4, 9, 5), 'metal', T.silver),
        part(poly([[19, 40.4], [27.6, 38.4], [33.6, 70], [21.4, 70]], 3), 'matte', SEAT),
        part(poly([[26.4, 44], [43, 40.6], [50.6, 62], [32, 66]], 5), 'matte', suit),
        part(poly(taper([[40, 47], [50, 51.6], [58.6, 49.6]], 8, 5.6)), 'matte', suit),
        c.detail > 0 && inner(poly(taper([[42, 46.4], [50.4, 50.4], [56, 49]], 1.8, 1.4)), 'flat', paint, { line: 0, plain: true }),
        part(poly(rodPts([[61.6, 50], [68, 62]], 2.8)), 'metal', T.iron),
        part(ellR(61.6, 48.6, 2.4, 7.6, -16), 'matte', CARBON),
        part(circ(59.6, 50.2, 3.4), 'matte', CARBON),
        part(circ(38.6, 29.6, 13.4), 'gloss', paint),
        inner(poly([[40.4, 24.2], [51.8, 25.6], [52, 34], [41.8, 34.2]], 3), 'gloss', TINT, { line: 0.6 }),
        shine(ellR(32.6, 22.6, 5, 2.4, -32), 0.75),
        part(poly(nose, 2), 'gloss', paint, { shadow: true, span: [56, 78] }),
        part(poly([[28, 66], [62, 66], [64, 80], [28, 80]], 3), 'gloss', paint, { span: [56, 80] }),
        c.detail > 0 && inner(circ(46, 73, 4.4), 'flat', T.white, { line: 0.5 }),
        shine(poly(taper(cubic([60, 61.2], [72, 58.8], [86, 60], [95, 64.4], 10), 1.8, 0.4)), 0.7),
        ...wheel(c, 21, 74, 13, { spokes: 5, rimK: 0.56 }),
        ...wheel(c, 79, 76, 11, { spokes: 5, rimK: 0.56 }),
      ];
    },
  },

  truck: {
    wide: true,
    base: TYRE,
    about: 'a monster truck: a lifted pickup on giant treaded tyres',
    draw: (c) => {
      const paint = c.main(ORANGE);
      const body = path([[3.4, 47.6], [3.4, 32.6]], [[5, 30.6], [43, 30.6], [44.2, 18.4]], quad([44.2, 18.4], [45, 13.8], [49.6, 13.8], 4), [[60.4, 13.8]], quad([60.4, 13.8], [63, 13.8], [64.4, 16], 4), [[71.4, 29.6], [93.4, 32]], quad([93.4, 32], [97.6, 33], [97.6, 37.6], 4), [[97.6, 47.6]]);
      const win: P2[] = [[48.4, 17.4], [59.6, 17.4], [66.4, 29.4], [48.4, 29.4]];
      return [
        part(box(16, 44, 70, 10, 2), 'matte', CARBON),
        part(poly(rodPts([[26, 52], [34, 44]], 4.6)), 'metal', T.yellow),
        part(poly(rodPts([[76, 52], [68, 44]], 4.6)), 'metal', T.yellow),
        c.detail > 0 && part(box(47, 9.6, 15, 4.6, 1.6), 'matte', CARBON),
        part(poly(body, 1.6), 'gloss', paint, { shadow: true, span: [13, 48] }),
        inner(poly(win, 1.4), 'gloss', TINT, { line: 0.7 }),
        shine(poly(band(win, 58, 64, 0.5)), 0.4),
        inner(box(5, 34.6, 37.4, 2.4, 1), 'flat', shift(paint, -0.45), { line: 0, plain: true }),
        c.detail > 0 && inner(poly(strokePts([[68, 32], [69, 46]], 0.9, 'flat')), 'flat', shift(paint, -0.45), { line: 0, plain: true }),
        inner(poly([[91.6, 34.6], [96.6, 35.4], [96.6, 40.2], [91.6, 40.2]], 1), 'glass', LAMP, { line: 0.5 }),
        inner(box(3.8, 34.4, 3.2, 6, 0.8), 'glow', TAIL, { line: 0.4 }),
        part(box(88, 44, 11, 6, 2), 'metal', T.silver),
        c.detail > 0 && inner(circ(50.8, 11.8, 1.4), 'glow', LAMP, { line: 0, plain: true }),
        c.detail > 0 && inner(circ(54.6, 11.8, 1.4), 'glow', LAMP, { line: 0, plain: true }),
        c.detail > 0 && inner(circ(58.4, 11.8, 1.4), 'glow', LAMP, { line: 0, plain: true }),
        shade(poly(clipHalf(body, 0, 1, -40)), T.shadow, 0.18),
        shine(poly(taper([[6, 32.6], [42, 32.4]], 1.8, 0.6)), 0.6),
        shine(poly(taper([[72, 31.6], [94, 34]], 1.8, 0.6)), 0.6),
        ...wheel(c, 24, 71, 21, { rim: T.silver, spokes: 6, rimK: 0.5, tread: true }),
        ...wheel(c, 77, 71, 21, { rim: T.silver, spokes: 6, rimK: 0.5, tread: true }),
      ];
    },
  },

  motorbike: {
    wide: true,
    base: TYRE,
    about: 'a sport motorbike side on with a full fairing',
    draw: (c) => {
      const paint = c.main(YELLOW);
      const body = path(
        [[5, 29.6]],
        [[22, 35.2], [44, 37]],
        cubic([44, 37], [48, 30], [56, 27], [66, 27.6], 8),
        [[73, 29.6]],
        cubic([73, 29.6], [81, 31], [88, 35], [90.6, 41.6], 10),
        quad([90.6, 41.6], [91, 46.6], [86.6, 48.6], 6),
        cubic([86.6, 48.6], [80, 55], [70, 62], [58, 64.4], 10),
        [[46, 64.2], [40, 58]],
        cubic([40, 58], [34, 50], [24, 44], [11, 35.6], 10),
      );
      return [
        ...wheel(c, 20, 68, 15, { rim: CARBON, spokes: 3, rimK: 0.68 }),
        part(poly(rodPts([[20, 68], [45, 60]], 5.6)), 'metal', CARBON),
        ...wheel(c, 80, 68, 15, { rim: CARBON, spokes: 3, rimK: 0.68 }),
        part(poly(rodPts([[80, 68], [71, 36]], 4.4)), 'metal', T.silver),
        part(poly([[42, 56], [62, 58], [60, 69], [46, 69]], 3), 'metal', T.iron),
        part(poly([[69.6, 30.4], [75.6, 20.4], [81.4, 22.2], [80, 31.6]], 1.6), 'gloss', TINT),
        part(poly(body, 1.4), 'gloss', paint, { shadow: true, span: [27, 65] }),
        part(poly([[19.6, 32.4], [40, 34.2], [46.4, 37.4], [22, 37.4]], 2), 'matte', SEAT),
        c.detail > 0 && inner(poly(taper(cubic([12, 38.4], [30, 44], [46, 56], [64, 58.4], 12), 3, 1.2)), 'flat', T.white, { line: 0, plain: true }),
        inner(poly([[62, 44], [76, 42.6], [74, 50.6], [64, 53]], 3), 'flat', WELL, { line: 0.6 }),
        inner(poly([[84, 37.6], [90, 41.2], [89.6, 45.6], [84.6, 43]], 1.4), 'glass', LAMP, { line: 0.5 }),
        shade(poly(clipHalf(body, 0, 1, -48)), T.shadow, 0.18),
        shine(poly(taper(cubic([47, 33], [52, 29], [60, 28.4], [70, 29.6], 10), 1.8, 0.4)), 0.7),
        shine(poly(taper([[9, 31.4], [26, 35.6]], 1.4, 0.4)), 0.55),
        part(poly(arcBand(80, 68, 15.6, 19, 205, 300, 14)), 'gloss', paint, { sil: false, line: 0.6 }),
        part(poly(rodPts([[42, 63], [26, 58], [11, 54]], 5.2)), 'metal', T.silver),
        c.detail > 0 && inner(ell(10.6, 54, 1.4, 2.2), 'flat', WELL, { line: 0, plain: true }),
      ];
    },
  },

  boat: {
    wide: true,
    base: WATER,
    about: 'a speedboat cutting through the water, spray at its stern and bow',
    draw: (c) => {
      const paint = c.main(RED);
      const hull = path([[7, 45.6]], [[56, 45.4]], cubic([56, 45.4], [72, 44.8], [86, 41.4], [98.4, 38.8], 10), cubic([98.4, 38.8], [94, 50], [82, 61], [66, 63.4], 12), [[12, 63.4]], quad([12, 63.4], [6.4, 63], [6, 57], 6), [[7, 45.6]]);
      const lower = clipHalf(hull, 0.11, -1, 58.6 - 0.11 * 10);
      const screen: P2[] = [[49, 45.6], [57.4, 32], [66.6, 33.2], [63.4, 45.6]];
      const crest = (x: number) => 62 + 1.8 * Math.sin(x / 6.4 + 0.8);
      const top: P2[] = Array.from({ length: 33 }, (_, i) => [2 + i * 3, crest(2 + i * 3)] as P2);
      const water = path(top, Array.from({ length: 17 }, (_, i) => [98 - i * 6, 75 + 1.2 * Math.sin(i * 0.9)] as P2));
      return [
        part(poly(screen, 1.8), 'gloss', TINT),
        part(poly([[30, 46], [31.4, 37.6], [38.4, 37.2], [40.6, 46]], 2), 'matte', SEAT),
        c.detail > 0 && part(poly([[14, 46], [15.4, 39.6], [22, 39.4], [23.6, 46]], 2), 'matte', SEAT),
        part(poly(hull, 1.2), 'gloss', T.white, { shadow: true, span: [38, 64] }),
        inner(poly(lower, 1), 'gloss', paint, { line: 0.7, span: [44, 64] }),
        inner(poly(taper([[8, 51.4], [60, 50.6], [94, 42.6]], 1.8, 0.8)), 'flat', paint, { line: 0, plain: true }),
        shine(poly(band(screen, 76, 82, 0.6)), 0.45),
        shine(poly(taper([[10, 47.4], [56, 47.2], [90, 41.6]], 1.8, 0.4)), 0.7),
        part(poly(water, 2.4), 'liquid', WATER, { span: [58, 78] }),
        c.detail > 0 && inner(poly(taper(top.slice(1, 28), 2, 0.6)), 'flat', T.white, { line: 0, plain: true, fx: { fillOpacity: 0.8 } }),
        c.detail > 0 && inner(poly(taper(cubic([10, 70], [30, 67], [50, 72], [72, 68.6], 14), 1.6, 0.4)), 'flat', T.white, { line: 0, plain: true, fx: { fillOpacity: 0.5 } }),
        part(poly(taper(quad([62, 62.6], [72, 57.6], [84, 55.4], 10), 4.4, 0.6)), 'gloss', T.white),
        c.detail > 0 && part(circ(87.6, 52.6, 1.8), 'gloss', T.white),
        part(circ(7, 61.6, 5), 'gloss', T.white),
        part(circ(13.6, 64, 3.8), 'gloss', T.white),
        part(circ(2.6, 56.6, 3), 'gloss', T.white),
      ];
    },
  },

  plane: {
    wide: true,
    about: 'a small propeller plane with its wings spread',
    draw: (c) => {
      const paint = c.main(YELLOW);
      const body = path([[8, 40]], cubic([8, 40], [26, 36], [50, 33], [72, 36], 14), quad([72, 36], [82, 38], [85, 47], 8), quad([85, 47], [84, 58], [72, 61], 8), cubic([72, 61], [52, 64], [26, 52], [10, 46], 14), quad([10, 46], [6.4, 44], [8, 40], 4));
      const wing = (pts: P2[]) => poly(pts, 3);
      return [
        part(wing([[40, 40], [58, 40], [54, 12], [44, 12]]), 'gloss', shift(paint, -0.12)),
        part(poly([[4, 41], [2, 20], [9, 19], [24, 39]], 2.4), 'gloss', paint),
        part(poly([[2, 44.6], [20, 42.6], [22, 47], [3.6, 48]], 1.6), 'gloss', shift(paint, -0.08)),
        part(poly(path(ellPts(56, 37, 11.6, 7.6, { a0: 180, a1: 360, n: 20 })), 1), 'gloss', TINT),
        part(poly(body), 'gloss', paint, { shadow: true, span: [33, 63] }),
        inner(poly(path([[74.6, 36.6]], quad([74.6, 36.6], [83, 38.6], [85, 47], 6), quad([85, 47], [84, 57.6], [74.6, 60.4], 6), [[72, 48]]), 1), 'metal', T.silver, { line: 0.6 }),
        inner(poly(taper([[14, 44.6], [44, 47.6], [72, 47.4]], 1.4, 3)), 'flat', T.white, { line: 0, plain: true }),
        shine(poly(taper(cubic([14, 39.6], [30, 36.8], [52, 35.4], [70, 37.6], 12), 1.8, 0.6)), 0.7),
        c.detail > 0 && inner(ell(94.6, 48, 2.6, 29), 'flat', T.white, { line: 0, plain: true, fx: { fillOpacity: 0.28 } }),
        part(poly(taper(quad([94.4, 46], [96.4, 34], [95, 19.6], 8), 5.4, 2.6), 1), 'matte', CARBON),
        part(poly(taper(quad([94.4, 50], [96.4, 62], [95, 76.4], 8), 5.4, 2.6), 1), 'matte', CARBON),
        part(poly([[84.6, 41.6], [93, 45.4], [96.6, 48], [93, 50.6], [84.6, 54.4]], 2), 'metal', T.red),
        part(wing([[44, 54], [64, 54], [56, 88], [42, 88]]), 'gloss', paint, { span: [54, 88] }),
        c.detail > 0 && inner(poly([[43, 80], [57.6, 80], [56, 87.6], [42, 87.6]], 2), 'flat', T.white, { line: 0.5 }),
        shine(poly(taper([[48, 57], [45, 84]], 2, 0.6)), 0.5),
        c.detail > 0 && inner(circ(30, 44.8, 1.6), 'flat', WELL, { line: 0, plain: true }),
      ];
    },
  },

  helicopter: {
    wide: true,
    base: CARBON,
    about: 'a helicopter side on: bubble cockpit, tail rotor and skids',
    draw: (c) => {
      const paint = c.main(RED);
      const body = path([[36, 46]], cubic([36, 46], [40, 38], [52, 36.4], [62, 37], 10), cubic([62, 37], [76, 38], [86, 48], [86, 58], 12), quad([86, 58], [86, 70], [72, 70], 8), [[46, 70]], quad([46, 70], [34, 70], [33, 58], 8));
      const bubble: P2[] = path([[64, 40.6]], cubic([64, 40.6], [74, 42], [82, 48], [83.6, 56], 10), [[66, 56]], quad([66, 56], [62, 50], [64, 40.6], 6));
      return [
        part(poly([[38, 47], [10, 44.6], [6, 47], [10, 51.4], [38, 59]], 2), 'gloss', shift(paint, -0.06)),
        part(poly([[2, 30], [9, 30], [14, 47], [5, 50]], 2), 'gloss', paint),
        part(box(53, 29, 5, 9, 1.2), 'matte', CARBON),
        part(box(36, 70, 3.4, 12, 1), 'metal', T.iron),
        part(box(68, 70, 3.4, 12, 1), 'metal', T.iron),
        part(poly(rodPts([[26, 82.6], [80, 82.6], [87, 78.6]], 3.6)), 'metal', T.iron),
        part(poly(body), 'gloss', paint, { shadow: true, span: [36, 71] }),
        inner(poly(bubble, 1.4), 'gloss', TINT, { line: 0.7 }),
        shine(poly(band(bubble, 104, 110, 0.6)), 0.4),
        inner(box(46, 43, 13, 10, 3), 'gloss', TINT, { line: 0.7 }),
        c.detail > 0 && inner(poly(taper([[34, 60], [80, 62.6]], 2.6, 2.6)), 'flat', T.white, { line: 0, plain: true }),
        shade(poly(clipHalf(body, 0, 1, -62)), T.shadow, 0.2),
        shine(poly(taper(cubic([38, 45], [44, 39.4], [54, 38.6], [64, 39.4], 10), 1.8, 0.5)), 0.7),
        part(pill(3, 25.6, 95, 4), 'matte', CARBON),
        part(box(50, 24.4, 11, 6.4, 2), 'metal', T.iron),
        c.detail > 0 && shine(ell(6, 40, 1.4, 11), 0.3),
        part(ell(6, 40, 2, 11.6), 'matte', CARBON, { sil: false, line: 0.6 }),
      ];
    },
  },
};
