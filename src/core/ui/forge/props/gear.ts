import { box, circ, ellPts, ellR, path, poly, ringP, rodPts, rot, strokePts, taper, type P2, type Piece } from './geo';
import { inner, part, shade, shift, shine, T, type PropDef, type Tone } from './kit';

/**
 * Survival gear: a flashlight with its beam, a battery, a key card with an access band, an adhesive bandage, a
 * syringe of serum, a crowbar, a torn note pinned up and a first-aid kit — the pickups and inventory of horror,
 * escape and survival games. The variant tints what would be coloured (the flashlight's body, the battery's
 * wrapper, the card's access band, the serum, the crowbar's paint, the pin, the kit); steel, glass and paper keep
 * their own, and the bandage keeps its skin tone with the variant as a glow.
 */

const tone = (hi: string, mid: string, lo: string): Tone => ({ hi, mid, lo });
const TORCH: Tone = tone('#8a92a4', '#3e4452', '#14161c');
const RUBBER: Tone = tone('#ff9a6a', '#ff5a1a', '#a02800');
const LAMP: Tone = tone('#ffffff', '#fff6c4', '#ffc840');
const BEAM: Tone = tone('#fffbe0', '#fff2a8', '#ffe070');
const CHARGE: Tone = tone('#dcff9c', '#5ad83a', '#147a1a');
const CELL: Tone = tone('#6a7080', '#2c303a', '#0c0e12');
const PHOTO: Tone = tone('#d8e4f4', '#9cb0cc', '#5a6e8c');
const TAN: Tone = tone('#ffe4c4', '#f2b47c', '#a8662a');
const PAD: Tone = tone('#ffffff', '#fbf2e6', '#d2bca0');
const SERUM: Tone = tone('#e0ffb8', '#46e04c', '#0e7a2a');
const RUBBER_DARK: Tone = tone('#6a6470', '#2e2a34', '#0c0a10');
const INK: Tone = tone('#6a5a50', '#3a2c26', '#1a100c');

/** Points turned round (cx, cy) by deg. */
const R = (pts: P2[], deg: number, cx = 50, cy = 50) => rot(pts, deg, cx, cy);
/** A box (x, y, w, h in level coordinates) turned by deg round (cx, cy), with rounded corners. */
const RB = (x: number, y: number, w: number, h: number, deg: number, radius = 0, cx = 50, cy = 50): Piece => poly(R([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], deg, cx, cy), radius);
const at = (x: number, y: number, deg: number, cx = 50, cy = 50): [number, number] => R([[x, y]], deg, cx, cy)[0]!;
/** A plus sign round (cx, cy): arms r long, a units either side of the middle. */
const plus = (cx: number, cy: number, r: number, a: number): P2[] => [[cx - a, cy - r], [cx + a, cy - r], [cx + a, cy - a], [cx + r, cy - a], [cx + r, cy + a], [cx + a, cy + a], [cx + a, cy + r], [cx - a, cy + r], [cx - a, cy + a], [cx - r, cy + a], [cx - r, cy - a], [cx - a, cy - a]];

export const GEAR: Record<string, PropDef> = {
  flashlight: {
    about: 'a flashlight shining its beam',
    draw: (c) => {
      const body = c.main(TORCH);
      const d = -35;
      const L = (pts: P2[], radius = 0) => poly(R(pts, d), radius);
      return [
        { ...shine(L([[70, 36], [97, 22], [97, 78], [70, 64]]), 1), fx: { fill: { angle: d, stops: [[0, BEAM.mid, 0.7], [1, BEAM.hi, 0]] } } },
        part(RB(3, 42, 8, 16, d, 2), 'metal', T.steel),
        part(RB(8, 41, 46, 18, d, 3), 'metal', body, { shadow: true, angle: 90 + d }),
        c.detail > 0 && inner(RB(14, 41, 22, 18, d, 1), 'metal', shift(body, -0.12), { line: 0.5, angle: 90 + d, fx: { patterns: [{ kind: 'crosshatch', color: '#000000', opacity: 0.35, size: 3.2 * c.u, duty: 0.3 }] } }),
        part(RB(40, 37, 8, 5, d, 1.6), 'gloss', RUBBER),
        part(L([[52, 41], [64, 35.4], [70, 35.4], [70, 64.6], [64, 64.6], [52, 59]], 2), 'metal', body, { angle: 90 + d }),
        part(RB(66, 34, 6, 32, d, 2), 'metal', T.silver, { angle: 90 + d }),
        inner(ellR(...at(71.6, 50, d), 2.6, 14.4, d), 'glow', LAMP, { line: 0.6 }),
        shine(L([[12, 43.6], [52, 43.6], [52, 46.4], [12, 46.4]], 1.4), 0.45),
      ];
    },
  },

  battery: {
    about: 'a battery cell with a charge bolt',
    draw: (c) => {
      const wrap = c.main(CHARGE);
      const d = -30;
      const ang = 90 + d;
      const [ex, ey] = at(82, 50, d);
      const [nx, ny] = at(88, 50, d);
      const bolt: P2[] = [[60, 38.6], [50.4, 51.6], [57, 51.6], [52.6, 61.6], [64.4, 47.4], [57.6, 47.4], [62, 38.6]];
      return [
        part(RB(10, 35, 40, 30, d, 5), 'metal', CELL, { shadow: true, angle: ang }),
        part(RB(46, 35, 36, 30, d, 1), 'metal', wrap, { angle: ang }),
        part(ellR(ex, ey, 5, 15, d), 'metal', T.silver, { angle: ang }),
        part(RB(82, 44, 6, 12, d, 1), 'metal', T.silver, { angle: ang }),
        part(ellR(nx, ny, 2, 6, d), 'metal', shift(T.silver, 0.1), { angle: ang }),
        inner(poly(R(bolt, d), 1), 'gloss', T.white, { line: 0.6 }),
        c.detail > 0 && inner(poly(R(strokePts([[20, 50], [30, 50]], 2.6, 'flat'), d)), 'flat', T.white, { line: 0, plain: true, fx: { fillOpacity: 0.85 } }),
        shine(poly(R([[14, 39], [80, 39], [80, 42.4], [14, 42.4]], d), 1.6), 0.55),
      ];
    },
  },

  'key-card': {
    about: 'a security key card with a coloured access band',
    draw: (c) => {
      const access = c.main(T.red);
      const d = -14;
      const card: P2[] = R([[12, 24], [88, 24], [88, 76], [12, 76]], d);
      const bandPts = R([[12, 24], [88, 24], [88, 42], [12, 42]], d);
      return [
        part(poly(card, 6), 'gloss', T.white, { shadow: true }),
        inner(poly(bandPts, 6), 'gloss', access, { line: 0, fx: {} }),
        inner(poly(R([[12, 36], [88, 36], [88, 42], [12, 42]], d)), 'gloss', access, { line: 0, plain: true }),
        inner(poly(R([[12, 41.6], [88, 41.6], [88, 43], [12, 43]], d)), 'flat', shift(access, -0.4), { line: 0, plain: true }),
        inner(poly(R([[42, 29], [58, 29], [58, 35], [42, 35]], d), 3), 'flat', T.hole, { line: 0.5 }),
        inner(poly(R([[19, 48], [39, 48], [39, 70], [19, 70]], d), 2), 'matte', PHOTO, { line: 0.6 }),
        inner(circ(...at(29, 56, d), 4.4), 'matte', shift(PHOTO, -0.4), { line: 0, plain: true }),
        inner(poly(R(path(ellPts(29, 70, 8, 7, { a0: 180, a1: 360, n: 12 })), d)), 'matte', shift(PHOTO, -0.4), { line: 0, plain: true }),
        inner(poly(R([[46, 50], [80, 50], [80, 54], [46, 54]], d), 2), 'flat', shift(T.white, -0.35), { line: 0, plain: true }),
        c.detail > 0 && inner(poly(R([[46, 58], [72, 58], [72, 61.4], [46, 61.4]], d), 1.7), 'flat', shift(T.white, -0.3), { line: 0, plain: true }),
        c.detail > 0 && inner(poly(R([[64, 64], [80, 64], [80, 72], [64, 72]], d), 1.6), 'metal', T.gold, { line: 0.5 }),
        shine(poly(R([[17, 27], [60, 27], [60, 29.6], [17, 29.6]], d), 1.3), 0.5),
      ];
    },
  },

  bandage: {
    aura: true,
    about: 'an adhesive bandage',
    draw: (c) => {
      const strip = c.own(TAN);
      const d = -34;
      const holes = c.detail > 0 ? [[16, 44], [16, 56], [24, 44], [24, 56], [76, 44], [76, 56], [84, 44], [84, 56]] : [[20, 50], [80, 50]];
      return [
        part(poly(R(rodPts([[16, 50], [84, 50]], 32), d)), 'gloss', strip, { shadow: true }),
        inner(poly(R([[36, 37], [64, 37], [64, 63], [36, 63]], d), 4), 'matte', PAD, { line: 0.7, fx: c.detail > 0 ? { textures: [{ kind: 'speckle', scale: 2 * c.u, density: 0.4, color: '#c8b090', opacity: 0.4 }] } : {} }),
        ...holes.map(([x, y]) => inner(circ(...at(x!, y!, d), 1.5), 'flat', shift(strip, -0.3), { line: 0, plain: true })),
        shine(poly(R(rodPts([[18, 39.6], [82, 39.6]], 3.4), d)), 0.5),
      ];
    },
  },

  syringe: {
    about: 'a syringe of glowing serum',
    draw: (c) => {
      const serum = c.main(SERUM);
      const d = -40;
      const ang = 90 + d;
      const L = (pts: P2[], radius = 0) => poly(R(pts, d), radius);
      return [
        part(L(strokePts([[2, 50], [16, 50]], 2.4, 'flat')), 'metal', T.steel),
        part(L([[14, 46], [22, 43], [22, 57], [14, 54]], 1), 'metal', T.silver, { angle: ang }),
        part(RB(72, 47, 18, 6, d, 1), 'metal', T.silver, { angle: ang }),
        part(RB(88, 37, 5, 26, d, 2), 'gloss', RUBBER_DARK),
        part(RB(20, 38, 50, 24, d, 4), 'glass', T.glass, { shadow: true, angle: ang }),
        part(RB(66, 31, 6, 38, d, 2), 'gloss', T.white, { angle: ang }),
        inner(RB(22, 41, 30, 18, d, 3), 'liquid', serum, { line: 0, angle: ang }),
        inner(RB(52, 40, 7, 20, d, 1.6), 'gloss', RUBBER_DARK, { line: 0.5 }),
        ...(c.detail > 0 ? [28, 36, 44].map((x) => inner(RB(x, 38.6, 1.6, 6, d), 'flat', shift(T.glass, -0.55), { line: 0, plain: true })) : []),
        shine(L([[24, 41], [64, 41], [64, 43.6], [24, 43.6]], 1.3), 0.7),
      ];
    },
  },

  crowbar: {
    about: 'a red crowbar with a hooked, split claw',
    draw: (c) => {
      const paint = c.main(T.red);
      const [hx, hy, hr] = [70, 27, 10];
      const end = (50 * Math.PI) / 180;
      const hook = ellPts(hx, hy, hr, hr, { a0: 50, a1: -146, n: 22 });
      const line = path(hook, [[22, 80]], [[10.6, 84.4]]);
      // The paint runs along the straight shaft, bare steel at the hook and the chisel end.
      const top = hook[hook.length - 1]!;
      const painted: P2[] = [[top[0] + (22 - top[0]) * 0.08, top[1] + (80 - top[1]) * 0.08], [24.4, 77]];
      const tip: P2 = [hx + hr * Math.cos(end), hy + hr * Math.sin(end)];
      const [rx, ry, bx, by] = [Math.cos(end), Math.sin(end), Math.sin(end), -Math.cos(end)];
      return [
        part(poly(taper(line, 11.6, 8)), 'metal', T.steel, { shadow: true }),
        inner(poly(strokePts(painted, 10.8, 'flat')), 'gloss', paint, { line: 0.8 }),
        c.detail > 0 && inner(poly([[tip[0] + rx * 2.8 - bx, tip[1] + ry * 2.8 - by], [tip[0] - rx * 2.8 - bx, tip[1] - ry * 2.8 - by], [tip[0] + bx * 6, tip[1] + by * 6]]), 'flat', T.hole, { line: 0, plain: true }),
        shine(poly(rodPts([[58.6, 30.6], [25, 75.2]], 2.2)), 0.55),
        shine(poly(taper(ellPts(hx, hy, hr - 2.4, hr - 2.4, { a0: -150, a1: -60, n: 10 }), 2, 0.4)), 0.6),
      ];
    },
  },

  'torn-note': {
    about: 'a torn note pinned up, scrawled with writing',
    draw: (c) => {
      const pin = c.main(T.red);
      const d = -6;
      const rip: P2[] = [[14, 20], [20, 15], [25, 19], [31, 13.4], [37, 18.6], [44, 14], [50, 19.4], [56, 13], [63, 18], [69, 14.6], [75, 19.6], [81, 14], [86, 18.4]];
      const sheet = R(path(rip, [[86, 90], [14, 90]]), d);
      const lines = c.detail > 0 ? [32, 41, 50, 59, 68, 77] : [36, 50, 64];
      const lens = [56, 48, 58, 40, 52, 30];
      const scrawl = (y: number, len: number, i: number) => {
        const pts: P2[] = Array.from({ length: 9 }, (_, k) => [22 + (len * k) / 8, y + Math.sin(k * 1.7 + i) * 1.2] as P2);
        return inner(poly(R(rodPts(pts, c.detail > 0 ? 2.2 : 3.4), d)), 'flat', INK, { line: 0, plain: true, fx: { fillOpacity: 0.85 } });
      };
      return [
        part(poly(sheet, 1), 'paper', T.paper, { shadow: true }),
        shade(poly(R([[50, 18], [86, 18], [86, 90], [50, 90]], d)), T.shadow, 0.06),
        ...lines.map((y, i) => scrawl(y, lens[i]!, i)),
        part(circ(...at(50, 18, d), 7.4), 'gloss', pin),
        shine(circ(...at(47.6, 15.6, d), 2.2), 0.85),
      ];
    },
  },

  medkit: {
    about: 'a first-aid kit with a white cross',
    draw: (c) => {
      const kit = c.main(T.red);
      return [
        part(ringP(50, 30, 15, 13, 5), 'matte', tone('#6a6e78', '#2e3038', '#0e0f12')),
        part(box(8, 28, 84, 62, 8), 'gloss', kit, { shadow: true, span: [28, 90] }),
        inner(box(8, 28, 84, 16, [8, 8, 2, 2]), 'gloss', shift(kit, 0.08), { line: 0.8, span: [28, 90] }),
        part(box(17, 38, 9, 10, 2), 'metal', T.silver),
        part(box(74, 38, 9, 10, 2), 'metal', T.silver),
        inner(poly(plus(50, 64, 15, 5.6), 1.6), 'gloss', T.white, { line: 0.8 }),
        shade(box(8, 76, 84, 14, [0, 0, 8, 8]), T.shadow, 0.14),
        shine(box(16, 31, 38, 3, 1.5), 0.55),
      ];
    },
  },
};
