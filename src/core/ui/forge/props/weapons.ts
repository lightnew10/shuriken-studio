import { box, circ, ell, ellR, path, poly, quad, ringP, rot, strokePts, taper, type P2, type Piece } from './geo';
import { inner, part, shift, shine, T, type PropDef, type Tone } from './kit';

/**
 * Guns and launchers: pistol, SMG, rifle, shotgun, sniper, sci-fi blaster, retro laser, rocket launcher and grenade —
 * chunky, toy-like silhouettes (Roblox shooters' style) facing right and tilted a little up, so they read at 48 px.
 * The variant tints the body (a rare rifle is blue); grips, barrels and stocks keep their materials.
 */

const tone = (hi: string, mid: string, lo: string): Tone => ({ hi, mid, lo });
const GUN = tone('#d4dce6', '#7a8698', '#2c3240');
const POLY = tone('#70747e', '#3c404a', '#16181e');
const OLIVE = tone('#c8d488', '#6f7f36', '#2c3612');
const WHITE = tone('#ffffff', '#e8eef6', '#8a98ac');
const ENERGY = tone('#f0ffff', '#3fe6ff', '#0a7ab8');
const HOLE = T.hole;

/** Every gun is drawn level, then turned up by this much round the middle. */
const TILT = -9;
const r = (pts: P2[]) => rot(pts, TILT);
const R = (x: number, y: number, w: number, h: number, rad = 0): Piece => poly(r([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), rad);
const at = (x: number, y: number) => r([[x, y]])[0]!;
const grip = (pts: P2[], t: Tone = POLY) => part(poly(r(pts), 3), 'matte', t);

export const WEAPONS: Record<string, PropDef> = {
  pistol: {
    about: 'a pistol',
    draw: (c) => {
      const body = c.main(GUN);
      return [
        grip([[22, 50], [46, 50], [42, 84], [38, 89], [19, 89], [16, 84]]),
        part(ringP(...at(53, 57), 9, 8, 3.4), 'matte', POLY),
        part(R(18, 44, 52, 13, 3), 'matte', POLY),
        part(R(12, 22, 76, 24, 5), 'metal', body, { shadow: true }),
        part(R(84, 26, 9, 16, 2.5), 'metal', POLY),
        part(R(16, 17, 7, 6, 1.5), 'matte', POLY),
        part(R(78, 17, 6, 6, 1.5), 'matte', POLY),
        inner(R(50, 27, 18, 7, 2), 'flat', HOLE, { line: 0.6 }),
        ...(c.detail > 0 ? [18, 23, 28].map((x) => inner(R(x, 28, 2, 13, 1), 'flat', shift(body, -0.35), { line: 0, plain: true })) : []),
        inner(R(48, 52, 4, 10, 1.5), 'matte', POLY, { line: 0.6 }),
        shine(R(16, 25, 62, 3.5, 1.7), 0.5),
      ];
    },
  },

  smg: {
    about: 'a submachine gun',
    draw: (c) => {
      const body = c.main(GUN);
      return [
        part(poly(r([[2, 34], [18, 34], [18, 50], [7, 58], [2, 55]]), 2.5), 'matte', POLY),
        part(R(46, 48, 12, 42, 2), 'metal', POLY),
        grip([[22, 48], [38, 48], [34, 78], [19, 78]]),
        part(R(14, 28, 60, 23, 4), 'metal', body, { shadow: true }),
        part(R(72, 31, 18, 17, 3), 'matte', POLY),
        part(R(88, 35, 9, 9, 2), 'metal', POLY),
        part(R(26, 21, 32, 8, 2), 'matte', POLY),
        ...(c.detail > 0 ? [76, 81, 86].map((x) => inner(circ(...at(x, 39.5), 1.8), 'flat', HOLE, { line: 0, plain: true })) : []),
        inner(R(34, 34, 18, 6, 2), 'flat', HOLE, { line: 0.6 }),
        shine(R(18, 31, 50, 3.5, 1.7), 0.5),
      ];
    },
  },

  rifle: {
    about: 'an assault rifle with a wooden stock and a curved magazine',
    draw: (c) => {
      const body = c.main(GUN);
      const mag = r(path(quad([44, 48], [46, 70], [55, 87], 10), [[67, 83]], quad([67, 83], [59, 68], [57, 48], 10)));
      return [
        part(poly(r([[1, 39], [22, 33], [24, 51], [4, 63], [1, 60]]), 2.5), 'wood', T.wood, { angle: 80 }),
        part(poly(mag, 2), 'metal', POLY),
        grip([[25, 48], [37, 48], [33, 73], [21, 73]]),
        part(R(20, 31, 46, 20, 4), 'metal', body, { shadow: true }),
        part(R(64, 33, 22, 15, 4), 'wood', T.wood),
        part(R(84, 37, 13, 7, 2), 'metal', POLY),
        part(R(88, 28, 3.5, 10, 1), 'metal', POLY),
        part(R(28, 25, 10, 7, 2), 'matte', POLY),
        inner(R(42, 35, 16, 6, 2), 'flat', HOLE, { line: 0.6 }),
        c.detail > 0 && inner(R(66, 39.5, 18, 1.4, 0.7), 'flat', T.woodDark, { line: 0, plain: true }),
        shine(R(24, 34, 38, 3.2, 1.6), 0.5),
      ];
    },
  },

  shotgun: {
    about: 'a pump shotgun',
    draw: (c) => {
      const body = c.main(GUN);
      return [
        part(poly(r([[1, 41], [25, 34], [27, 55], [6, 70], [1, 66]]), 2.5), 'wood', T.wood, { angle: 80 }),
        part(R(46, 45, 46, 9, 3), 'metal', POLY),
        part(R(46, 33, 52, 12, 3), 'metal', T.steel),
        part(R(23, 31, 27, 25, 4), 'metal', body, { shadow: true }),
        part(R(56, 42, 26, 17, 6), 'wood', T.wood, { fx: { patterns: [{ kind: 'stripes', color: '#3a1a08', opacity: 0.45, size: 4 * c.u, angle: 0 - TILT, duty: 0.25 }] } }),
        inner(R(28, 38, 14, 5, 2), 'flat', HOLE, { line: 0.6 }),
        c.detail > 0 && inner(R(8, 47, 6, 3, 1.5), 'gloss', T.red, { line: 0.5 }),
        c.detail > 0 && inner(R(8, 52, 6, 3, 1.5), 'gloss', T.red, { line: 0.5 }),
        shine(R(48, 35.5, 46, 3, 1.5), 0.55),
      ];
    },
  },

  sniper: {
    about: 'a sniper rifle with a scope and bipod',
    draw: (c) => {
      const body = c.main(GUN);
      return [
        part(poly(strokePts(r([[72, 52], [64, 82]]), 3.4)), 'metal', POLY),
        part(poly(strokePts(r([[74, 52], [84, 82]]), 3.4)), 'metal', POLY),
        part(poly(r([[1, 45], [26, 42], [26, 57], [15, 61], [3, 68]]), 2.5), 'matte', POLY),
        part(R(40, 54, 11, 11, 2), 'metal', POLY),
        part(R(54, 45.5, 38, 6.5, 2), 'metal', POLY),
        part(R(89, 43, 9, 11, 2), 'metal', POLY),
        part(R(23, 42, 34, 15, 4), 'metal', body, { shadow: true }),
        part(R(34, 34, 4, 9, 1), 'matte', POLY),
        part(R(51, 34, 4, 9, 1), 'matte', POLY),
        part(R(27, 25, 32, 10, 5), 'metal', POLY),
        part(poly(r([[57, 25], [67, 21], [67, 39], [57, 35]]), 2), 'metal', POLY),
        part(poly(r([[22, 26], [28, 25], [28, 35], [22, 34]]), 1.5), 'metal', POLY),
        inner(ellR(...at(66, 30), 2.2, 7, TILT), 'gloss', ENERGY, { line: 0.6 }),
        shine(R(29, 27, 26, 2.4, 1.2), 0.55),
        shine(R(26, 45, 28, 2.6, 1.3), 0.5),
      ];
    },
  },

  blaster: {
    about: 'a sci-fi blaster with a glowing energy cell',
    draw: (c) => {
      const body = c.main(WHITE);
      return [
        grip([[22, 50], [40, 50], [36, 83], [18, 83]]),
        part(poly(r([[28, 30], [40, 14], [52, 14], [48, 30]]), 3), 'gloss', T.orange),
        part(R(66, 31, 20, 19, 5), 'metal', POLY),
        part(R(14, 26, 58, 28, 11), 'gloss', body, { shadow: true }),
        part(ellR(...at(88, 40.5), 5.5, 10.5, TILT), 'glow', ENERGY, { line: 1 }),
        inner(R(22, 35.5, 32, 8.5, 4), 'glow', ENERGY, { line: 0.7 }),
        inner(R(14, 45, 58, 4, 2), 'gloss', T.orange, { line: 0.6 }),
        c.detail > 0 && inner(circ(...at(64, 38), 2.6), 'glow', ENERGY, { line: 0.5 }),
        shine(R(20, 28, 44, 3.2, 1.6), 0.55),
      ];
    },
  },

  laser: {
    about: 'a retro ray gun',
    draw: (c) => {
      const body = c.main(T.red);
      return [
        part(poly(r([[16, 34], [2, 18], [18, 22], [28, 34]]), 2.5), 'gloss', T.silver),
        part(poly(r([[16, 54], [4, 68], [20, 64], [28, 52]]), 2.5), 'gloss', T.silver),
        grip([[26, 56], [40, 56], [37, 86], [22, 86]], T.dark),
        part(poly(r([[50, 34], [84, 38], [84, 48], [50, 54]]), 2), 'metal', T.silver),
        part(ellR(...at(36, 44), 23, 18, TILT), 'gloss', body, { shadow: true }),
        part(ellR(...at(87, 43), 5, 12, TILT), 'metal', T.silver),
        part(circ(...at(93, 43), 4.5), 'glow', ENERGY, { line: 1 }),
        ...[60, 70].map((x) => inner(R(x, 37.5, 3.4, 13, 1.5), 'metal', shift(T.silver, -0.25), { line: 0.5 })),
        inner(circ(...at(32, 40), 7), 'glow', ENERGY, { line: 0.7 }),
        shine(ellR(...at(30, 33), 9, 3, TILT - 10), 0.6),
      ];
    },
  },

  launcher: {
    about: 'a rocket launcher with a rocket loaded',
    draw: (c) => {
      const body = c.main(OLIVE);
      return [
        grip([[30, 52], [41, 52], [39, 74], [28, 74]]),
        grip([[56, 52], [65, 52], [63, 67], [54, 67]]),
        part(poly(r([[88, 37], [99, 43], [88, 49]]), 1.5), 'gloss', T.red),
        part(R(2, 30, 80, 23, 5), 'matte', body, { shadow: true }),
        part(poly(r([[78, 26], [90, 24], [90, 59], [78, 57]]), 2.5), 'metal', POLY),
        part(R(0, 33, 6, 17, 2), 'metal', POLY),
        part(R(38, 19, 15, 12, 2.5), 'metal', POLY),
        inner(ellR(...at(53, 25), 1.6, 3.4, TILT), 'gloss', ENERGY, { line: 0.4 }),
        inner(R(64, 30, 7, 23, 0), 'flat', T.yellow, { line: 0.6, fx: { patterns: [{ kind: 'stripes', color: '#1a1a1a', opacity: 0.9, size: 5 * c.u, angle: 45, duty: 0.5 }] } }),
        shine(R(6, 33, 70, 3.4, 1.7), 0.45),
      ];
    },
  },

  grenade: {
    about: 'a frag grenade with its pin',
    draw: (c) => {
      const body = c.main(OLIVE);
      return [
        part(ringP(28, 19, 8.5, 8.5, 2.8), 'metal', T.silver),
        part(poly(taper(quad([54, 22], [76, 24], [75, 64], 12), 7, 4.5)), 'metal', T.steel),
        part(box(35, 21, 22, 13, 3), 'metal', T.iron),
        part(ell(47, 62, 31, 33), 'matte', body, { shadow: true, fx: { patterns: [{ kind: 'grid', color: body.lo, opacity: 0.75, size: 11 * c.u, duty: 0.14 }] } }),
        part(box(39, 30, 16, 6, 2), 'metal', T.iron),
        inner(poly(strokePts([[36, 21], [33, 22]], 2.2, 'flat')), 'metal', T.silver, { line: 0.4, plain: true }),
        shine(ellR(34, 48, 6, 11, 30), 0.45),
      ];
    },
  },
};

