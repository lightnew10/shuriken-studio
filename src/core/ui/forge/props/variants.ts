import { arcBand, box, circ, clipBelow, cubic, ell, ellPts, ellR, eggPts, heartPts, inset, ngon, path, poly, quad, rbox, rot, sparkleP, starP, strokePts, taper, type P2 } from './geo';
import { inner, part, shade, shift, shine, T, type Part, type PropCtx, type PropDef, type Tone } from './kit';

/**
 * Designs: several looks for the objects a game shows many of — eggs (spots, zigzag stripes, a glowing crack, flames,
 * stars, a swirl), potions (round, tall, heart, vial), chests (wood, iron, royal gold), swords (arming sword,
 * broadsword, katana, crystal blade) and gem cuts (brilliant, emerald, oval, heart) — chosen by name ("egg-3",
 * "potion-2"), and themed ones with their own colours when no variant is asked for ("dragon-egg", "galaxy-egg",
 * "ruby", "emerald").
 */

const tone = (hi: string, mid: string, lo: string): Tone => ({ hi, mid, lo });
const P = (pts: P2[]) => poly(pts);

// ─── Eggs ─────────────────────────────────────────────────────────────────────────────────────────

type EggDesign = 'spots' | 'stripes' | 'crack' | 'flames' | 'stars' | 'swirl' | 'rainbow' | 'mystery';
const E = { cx: 50, cy: 52, rx: 34, ry: 44, k: 0.14 };
/** The egg's half width at y. */
const hw = (y: number) => {
  const s = Math.max(-1, Math.min(1, (y - E.cy) / E.ry));
  return Math.sqrt(Math.max(0, 1 - s * s)) * E.rx * (1 + E.k * s);
};
const inEgg = ([x, y]: P2): P2 => [Math.max(E.cx - hw(y), Math.min(E.cx + hw(y), x)), y];
/** A triangle wave 0 at both ends. */
const zig = (u: number, teeth: number) => 1 - Math.abs(((u * teeth * 2) % 2) - 1);
/** A band across the egg between yA and yB, its top and bottom edges zigzag (amp, teeth); its ends follow the shell. */
function eggBand(yA: number, yB: number, amp: number, teeth: number): P2[] {
  const edge = (y0: number, a: number): P2[] => Array.from({ length: teeth * 2 + 1 }, (_, i) => {
    const u = i / (teeth * 2);
    return inEgg([E.cx - hw(y0) + 2 * hw(y0) * u, y0 + a * zig(u, teeth)]);
  });
  const side = (from: number, to: number, sgn: 1 | -1): P2[] => Array.from({ length: 7 }, (_, i) => {
    const y = from + ((to - from) * i) / 6;
    return [E.cx + sgn * hw(y), y] as P2;
  });
  return path(edge(yA, -amp), side(yA, yB, 1), edge(yB, amp).reverse(), side(yB, yA, -1));
}
/** The shell below a flame-tongued edge: tips (x, y) between valleys at yv. */
function eggFlames(tips: P2[], yv: number): P2[] {
  const xl = E.cx - hw(yv);
  const xr = E.cx + hw(yv);
  const edge: P2[] = [[xl, yv]];
  tips.forEach(([tx, ty], i) => {
    const prev = edge[edge.length - 1]!;
    const nextX = i + 1 < tips.length ? (tx + tips[i + 1]![0]) / 2 : xr;
    // A tongue: bulging up from the valley, flicking to its tip, falling back to the next valley.
    edge.push(...cubic(prev, [prev[0] + (tx - prev[0]) * 0.15, prev[1] - (prev[1] - ty) * 0.55], [tx - 7, ty + 9], [tx, ty], 8).slice(1));
    edge.push(...cubic([tx, ty], [tx + 2, ty + 9], [nextX - 1, yv - (yv - ty) * 0.45], [nextX, yv], 8).slice(1));
  });
  const bottom = eggPts(E.cx, E.cy, E.rx, E.ry, E.k, 96).filter(([, y]) => y > yv);
  return path(edge.map(inEgg), bottom);
}
/** A point on the egg's outline at angle t (radians), moved and scaled. */
const eggAt = (t: number, dx = 0, dy = 0, k = 1): P2 => [E.cx + dx + Math.cos(t) * E.rx * k * (1 + E.k * Math.sin(t)), E.cy + dy + Math.sin(t) * E.ry * k];
/** The shading over the lower right of the shell (drawn over its markings, so they curve with it). */
const eggShade = () => {
  const ts = Array.from({ length: 25 }, (_, i) => -0.35 + (2.95 * i) / 24);
  return shade(poly([...ts.map((t) => eggAt(t)), ...ts.reverse().map((t) => eggAt(t, -3.5, -4.5, 0.97))]), T.shadow, 0.16);
};
const eggShine = (): Part[] => [shine(ellR(36, 30, 6.5, 11, 32), 0.8), shine(circ(46, 19, 2.6), 0.8)];

interface EggColours {
  shell: Tone;
  mark: Tone;
  /** A second marking colour (inner flames, a nebula). */
  mark2?: Tone;
  /** The shell's material (a golden egg is metal). */
  mat?: 'gloss' | 'metal';
  /** A pattern over the shell (dragon scales). */
  scales?: boolean;
}

function egg(design: EggDesign, natural: EggColours, about: string): PropDef {
  return {
    about,
    draw: (c) => {
      const shell = c.main(natural.shell);
      const mark = c.tint && design !== 'flames' && design !== 'crack' && design !== 'stars' && design !== 'mystery' ? shift(c.tint, 0.5) : natural.mark;
      const mark2 = natural.mark2 ?? shift(mark, 0.35);
      const body = part(poly(eggPts(E.cx, E.cy, E.rx, E.ry, E.k)), natural.mat ?? 'gloss', shell, natural.scales ? { fx: { patterns: [{ kind: 'scales', color: shell.lo, opacity: 0.4, size: 10 * c.u }] } } : {});
      const m = (g: Parameters<typeof inner>[0], t: Tone = mark, o: Parameters<typeof inner>[3] = {}) => inner(g, 'matte', t, { line: 0, ...o });
      const marks: Array<Part | false> = [];
      switch (design) {
        case 'spots':
          marks.push(m(ellR(35, 67, 11, 8.5, -24)), m(ellR(64, 45, 8.5, 6.5, 28)), m(ellR(61, 77, 6.5, 5, 12)), c.detail > 0 && m(ellR(30, 46, 4, 3.4, 0)), c.detail > 0 && m(ellR(70, 62, 3.6, 3, 0)));
          break;
        case 'stripes':
          marks.push(m(P(eggBand(36, 45, 4, 5))), m(P(eggBand(63, 72, 4, 5))), c.detail > 0 && m(circ(36, 54, 2.6), mark2), c.detail > 0 && m(circ(50, 55, 2.6), mark2), c.detail > 0 && m(circ(64, 54, 2.6), mark2));
          break;
        case 'rainbow': {
          const bands: Array<[number, string]> = [[24, '#ff4d5e'], [34, '#ff9a2e'], [44, '#ffd83a'], [54, '#4ccf5a'], [64, '#3a9cff'], [74, '#a35cff']];
          bands.forEach(([y, col]) => marks.push(inner(P(eggBand(y, y + 10.4, 0, 1)), 'matte', { hi: col, mid: col, lo: col }, { line: 0, fx: { fill: col } })));
          break;
        }
        case 'crack': {
          const glow = natural.mark;
          const edge = shift(shell, -0.55).mid;
          const main: P2[] = [[E.cx - hw(51) + 0.5, 51], [27, 44], [35, 56], [44, 45], [52, 57], [60, 46], [68, 55], [76, 47], [E.cx + hw(51) - 0.5, 51]];
          marks.push(inner(P(strokePts(main.map(inEgg), c.detail > 0 ? 4.6 : 5.6, 'flat')), 'glow', glow, { line: 0.8, lineColor: edge }));
          // Branches: the lava egg is split all over, the hatching egg just starting.
          const branches: P2[][] = natural.mark2 ? [[[44, 45], [40, 35], [45, 27], [42, 20]], [[68, 55], [64, 65], [70, 74], [66, 82]], [[35, 56], [29, 64], [32, 72]], [[60, 46], [66, 38], [63, 30]]] : [[[44, 45], [41, 37], [44, 31]], [[68, 55], [71, 62]]];
          if (c.detail > 0 || natural.mark2) for (const b of branches) marks.push(inner(P(taper(b.map(inEgg), natural.mark2 ? 4 : 3, 0.6)), 'glow', glow, { line: 0.7, lineColor: edge }));
          break;
        }
        case 'flames':
          marks.push(m(P(eggFlames([[27, 42], [45, 26], [63, 32], [79, 46]], 64)), natural.mark, { line: 0.6, lineColor: shift(natural.mark, -0.4).mid }));
          marks.push(m(P(eggFlames([[36, 56], [52, 46], [68, 56]], 75)), mark2));
          break;
        case 'stars': {
          const stars: Array<[number, number, number]> = [[34, 40, 7.5], [64, 32, 5.5], [65, 63, 8.5], [40, 73, 6], [50, 52, 4.2], [27, 58, 3.6], [57, 82, 3.4]];
          if (natural.mark2) marks.push(inner(P(strokePts(cubic([20, 70], [36, 48], [60, 66], [82, 36], 16).map(inEgg), 14)), 'flat', natural.mark2, { line: 0, opacity: 0.55, fx: { fillOpacity: 0.45 } }));
          for (const [x, y, r] of c.detail > 0 ? stars : stars.slice(0, 4)) marks.push(inner(starP(x, y, r, { inner: 0.48, round: r * 0.12 }), 'gloss', mark, { line: 0.55, lineColor: shift(mark, -0.45).mid }));
          if (c.detail > 1) for (const [x, y] of [[44, 30], [74, 48], [30, 84], [56, 40]] as P2[]) marks.push(shine(circ(x, y, 1.2), 0.85));
          break;
        }
        case 'swirl': {
          const sp: P2[] = [];
          for (let i = 0; i <= 60; i++) {
            const th = (i / 60) * Math.PI * 3.3;
            const r = 3 + th * 2.5;
            sp.push([50 + Math.cos(th + 1.6) * r, 56 + Math.sin(th + 1.6) * r * 1.1]);
          }
          marks.push(m(P(strokePts(sp.map(inEgg), c.detail > 0 ? 6.5 : 8))));
          break;
        }
        case 'mystery': {
          const q = path(ellPts(50, 39, 12, 12, { a0: 195, a1: 390, n: 18 }), quad([60.4, 45], [50, 50], [50, 60], 8));
          marks.push(inner(P(strokePts(q, 8.5)), 'gloss', mark, { line: 0.8 }), inner(circ(50, 73, 5.2), 'gloss', mark, { line: 0.8 }));
          break;
        }
      }
      return [body, ...marks, eggShade(), ...eggShine()];
    },
  };
}

// ─── Potions ──────────────────────────────────────────────────────────────────────────────────────

const CORK: Tone = { hi: '#f2c48a', mid: '#c98a4a', lo: '#7a4a1e' };
const surface = (pts: P2[], y: number, t: Tone, c: PropCtx): Array<Part | false> => {
  const xs = clipBelow(pts, y).filter(([, py]) => Math.abs(py - y) < 0.01).map(([x]) => x);
  if (xs.length < 2) return [];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  return [inner(ell((x0 + x1) / 2, y, (x1 - x0) / 2, 3), 'flat', shift(t, 0.4), { line: 0, plain: true }), c.detail > 0 && shine(circ(x0 + (x1 - x0) * 0.3, y + 10, 2.4), 0.55), c.detail > 0 && shine(circ(x0 + (x1 - x0) * 0.62, y + 18, 1.7), 0.5)];
};

function potionTall(natural: Tone): PropDef {
  return {
    about: 'a tall potion bottle with a label',
    draw: (c) => {
      const liq = c.main(natural);
      const bottle = path([[41, 22], [41, 30]], cubic([41, 30], [41, 36], [24, 36], [24, 46], 8), [[24, 88]], quad([24, 88], [24, 96], [32, 96], 4), [[68, 96]], quad([68, 96], [76, 96], [76, 88], 4), [[76, 46]], cubic([76, 46], [76, 36], [59, 36], [59, 30], 8), [[59, 22]]);
      const innerB = path(cubic([44, 36], [44, 40], [29, 40], [29, 49], 8), [[29, 86]], quad([29, 86], [29, 91], [34, 91], 4), [[66, 91]], quad([66, 91], [71, 91], [71, 86], 4), [[71, 49]], cubic([71, 49], [71, 40], [56, 40], [56, 36], 8));
      return [
        part(poly(bottle, 1), 'glass', T.glass, { shadow: true }),
        part(box(37, 15, 26, 9, 3), 'glass', T.glass),
        part(box(41, 2, 18, 15, [4, 4, 2, 2]), 'wood', CORK),
        inner(poly(clipBelow(innerB, 54)), 'liquid', liq, { line: 0, span: [54, 91] }),
        ...surface(innerB, 54, liq, c),
        inner(box(32, 62, 36, 20, 2), 'paper', T.paper, { line: 0.6 }),
        inner(poly(heartPts(50, 72, c.detail > 0 ? 11 : 13, 0)), 'flat', shift(liq, -0.05), { line: 0, plain: true }),
        shine(box(28, 44, 4, 40, 2), 0.55),
        shine(box(44, 24, 3, 10, 1.5), 0.5),
      ];
    },
  };
}

function potionHeart(natural: Tone): PropDef {
  return {
    about: 'a heart-shaped potion flask',
    draw: (c) => {
      const liq = c.main(natural);
      const heart = heartPts(50, 61, 92, 0);
      const innerH = heartPts(50, 62, 78, 0);
      return [
        part(box(41, 10, 18, 24, 3), 'glass', T.glass),
        part(poly(heart), 'glass', T.glass, { shadow: true }),
        part(box(37, 8, 26, 8, 4), 'glass', T.glass),
        part(box(42, 0, 16, 12, [4, 4, 2, 2]), 'wood', CORK),
        inner(poly(clipBelow(innerH, 52)), 'liquid', liq, { line: 0 }),
        ...surface(innerH, 52, liq, c),
        shine(poly(path(cubic([16, 46], [16, 36], [24, 30], [32, 30], 8), cubic([32, 30], [26, 34], [22, 40], [21, 50], 8))), 0.8),
        shine(box(44, 14, 3, 14, 1.5), 0.5),
      ];
    },
  };
}

function potionVial(natural: Tone): PropDef {
  return {
    about: 'a slim vial',
    draw: (c) => {
      const liq = c.main(natural);
      const r = (pts: P2[]) => rot(pts, 28, 50, 52);
      const tube = path([[37, 14]], [[37, 78]], ellPts(50, 78, 13, 13, { a0: 180, a1: 0, n: 16 }).slice(1), [[63, 14]]);
      const innerT = path([[41, 20]], [[41, 78]], ellPts(50, 78, 9, 9, { a0: 180, a1: 0, n: 14 }).slice(1), [[59, 20]]);
      const liquid = clipBelow(innerT, 46);
      return [
        part(poly(r(tube)), 'glass', T.glass, { shadow: true }),
        part(poly(r([[33, 8], [67, 8], [67, 16], [33, 16]]), 3), 'glass', T.glass),
        part(poly(r([[40, -4], [60, -4], [60, 10], [40, 10]]), 3), 'wood', CORK),
        inner(poly(r(liquid)), 'liquid', liq, { line: 0 }),
        inner(poly(r(ellPts(50, 46, 9, 2.4, { n: 20 }))), 'flat', shift(liq, 0.4), { line: 0, plain: true }),
        c.detail > 0 && shine(circ(...r([[49, 62]])[0]!, 2.2), 0.6),
        c.detail > 0 && shine(circ(...r([[53, 72]])[0]!, 1.6), 0.55),
        shine(poly(r([[40, 18], [43.5, 18], [43.5, 72], [40, 72]]), 1.5), 0.6),
      ];
    },
  };
}

// ─── Chests ───────────────────────────────────────────────────────────────────────────────────────

interface ChestLook {
  lid: Tone;
  body: Tone;
  mat: 'wood' | 'metal';
  band: Tone;
  lock: Tone;
  rivets?: boolean;
  panels?: Tone;
  gems?: boolean;
}

function chest(look: ChestLook, about: string): PropDef {
  return {
    about,
    draw: (c) => {
      // Royal chests keep their gold and wear the variant on the velvet; the others wear it on the bands and lock.
      const band = look.panels ? look.band : c.main(look.band);
      const lock = look.panels ? look.lock : c.main(look.lock);
      const panels = look.panels ? c.main(look.panels) : null;
      const top = (x: number) => 48 - 34 * Math.sqrt(Math.max(0, 1 - ((x - 50) / 42) ** 2));
      const domeBand = (x0: number, x1: number): P2[] => [[x0, 46], ...Array.from({ length: 9 }, (_, i) => { const x = x0 + ((x1 - x0) * i) / 8; return [x, top(x) - 1.2] as P2; }), [x1, 46]];
      const out: Array<Part | false> = [
        part(poly(ellPts(50, 48, 42, 34, { a0: 180, a1: 360, n: 40 })), look.mat, shift(look.lid, 0.06), { shadow: true }),
        part(box(10, 46, 80, 46, [2, 2, 7, 7]), look.mat, look.body, { shadow: true }),
      ];
      if (panels) {
        out.push(inner(poly(path(ellPts(50, 46, 28, 22, { a0: 190, a1: 350, n: 24 }))), 'matte', panels, { line: 0.6, fx: { textures: [{ kind: 'fabric', scale: 1.4 * c.u, opacity: 0.3, blend: 'overlay' }] } }));
        out.push(inner(box(32, 56, 36, 32, 3), 'matte', panels, { line: 0.6, fx: { textures: [{ kind: 'fabric', scale: 1.4 * c.u, opacity: 0.3, blend: 'overlay' }] } }));
      } else if (look.mat === 'wood' && c.detail > 0) out.push(inner(box(10, 64, 80, 1.4), 'flat', T.woodDark, { line: 0 }), inner(box(10, 78, 80, 1.4), 'flat', T.woodDark, { line: 0 }));
      else if (look.mat === 'metal' && c.detail > 0) out.push(inner(box(10, 69, 80, 1.6), 'flat', shift(look.body, -0.3), { line: 0 }));
      out.push(
        shade(box(10, 50, 80, 7), T.shadow, 0.3),
        part(poly(domeBand(16, 28)), 'metal', band, { span: [12, 50], sil: false }),
        part(poly(domeBand(72, 84)), 'metal', band, { span: [12, 50], sil: false }),
        inner(box(16, 50, 12, 42, [0, 0, 3, 3]), 'metal', band, { span: [50, 92] }),
        inner(box(72, 50, 12, 42, [0, 0, 3, 3]), 'metal', band, { span: [50, 92] }),
        part(box(5, 41, 90, 11, 4), 'metal', band),
      );
      if (look.rivets) for (const x of [22, 78]) for (const y of c.detail > 0 ? [57, 66, 75, 84] : [60, 80]) out.push(inner(circ(x, y, c.detail > 0 ? 1.9 : 2.4), 'metal', shift(band, 0.25), { line: 0.6 }));
      if (look.rivets && c.detail > 0) for (const x of [12, 30, 50, 70, 88]) out.push(inner(circ(x, 46.5, 1.6), 'metal', shift(band, 0.25), { line: 0.5 }));
      out.push(
        part(poly([[38, 37], [62, 37], [62, 56], [50, 65], [38, 56]], 3), 'metal', shift(lock, 0.08), { sil: false }),
        inner(circ(50, 48.5, 3.6), 'flat', T.hole, { line: 0 }),
        inner(poly([[48.3, 49], [51.7, 49], [52.8, 57.5], [47.2, 57.5]], 0.6), 'flat', T.hole, { line: 0 }),
      );
      if (look.gems) out.push(inner(poly([[22, 42.5], [25, 46.5], [22, 50.5], [19, 46.5]], 0.6), 'gem', T.red, { line: 0.6 }), inner(poly([[78, 42.5], [81, 46.5], [78, 50.5], [75, 46.5]], 0.6), 'gem', T.red, { line: 0.6 }), inner(circ(50, 30, 4), 'gem', T.cyan, { line: 0.6 }));
      out.push(shine(ellR(36, 24, 9, 3.2, -24), 0.45));
      return out;
    },
  };
}

// ─── Swords ───────────────────────────────────────────────────────────────────────────────────────

/** Turned so the tip points up and right; `at` maps a point of the sword laid along +x. */
const swordRot = (pts: P2[]) => rot(pts, -45);
const swordAt = (x: number, y: number) => swordRot([[x, y]])[0]!;

const SWORDS: Record<string, PropDef> = {
  'sword-2': {
    about: 'a broadsword with a winged guard',
    draw: (c) => {
      const hilt = c.main(T.silver);
      const [gx, gy] = swordAt(27, 50);
      const [hx, hy] = swordAt(12, 50);
      const [px, py] = swordAt(-2, 50);
      const guard = swordRot(path(cubic([31, 50], [31, 40], [24, 28], [20, 22], 8), cubic([20, 22], [28, 26], [33, 34], [34, 44], 6), [[34, 56]], cubic([34, 56], [33, 66], [28, 74], [20, 78], 6), cubic([20, 78], [24, 72], [31, 60], [31, 50], 8)));
      return [
        part(poly(swordRot([[30, 38], [92, 38], [110, 50], [92, 62], [30, 62]]), 2), 'metal', T.steel, { shadow: true }),
        c.detail > 0 && inner(poly(swordRot([[34, 47.5], [84, 47.5], [92, 50], [84, 52.5], [34, 52.5]])), 'flat', shift(T.steel, -0.2), { line: 0, plain: true }),
        shine(poly(swordRot([[32, 40.5], [91, 40.5], [104, 47], [32, 47]])), 0.5),
        part(rbox(hx, hy, 20, 11, -45, 3), 'matte', T.leather, { fx: { patterns: [{ kind: 'stripes', color: '#000000', opacity: 0.3, size: 4 * c.u, angle: 135, duty: 0.35 }] } }),
        part(poly(guard, 1.5), 'metal', hilt),
        part(circ(px, py, 9.5), 'metal', hilt),
        inner(circ(px, py, 4.5), 'gem', T.blue, { line: 0.6 }),
        inner(circ(gx, gy, 5), 'gem', c.tint ? shift(c.tint, 0.1) : T.blue),
      ];
    },
  },
  'sword-3': {
    about: 'a katana with a round guard',
    draw: (c) => {
      const accent = c.main(T.red);
      const blade = swordRot(path(quad([30, 43.5], [72, 42], [107, 35], 14), [[111, 40]], quad([111, 40], [72, 54], [30, 56.5], 14)));
      const hamon = swordRot(Array.from({ length: 13 }, (_, i) => { const x = 34 + i * 6; return [x, 51 - Math.sin(i * 1.3) * 0.9 - ((x - 30) / 80) ** 2 * 6] as P2; }));
      const [tx, ty] = swordAt(28, 50);
      const [hx, hy] = swordAt(12, 50);
      const [kx, ky] = swordAt(-1, 50);
      return [
        part(poly(blade, 0.5), 'metal', T.steel, { shadow: true }),
        c.detail > 0 && inner(poly(strokePts(hamon, 1.4, 'flat')), 'flat', T.white, { line: 0, plain: true, opacity: 0.8, fx: { fillOpacity: 0.85 } }),
        part(rbox(hx, hy, 24, 10.5, -45, 3), 'matte', T.dark, { fx: { patterns: [{ kind: 'diamonds', color: accent.mid, opacity: 0.9, size: 4.5 * c.u, angle: 45 }] } }),
        part(rbox(kx, ky, 6, 10, -45, 2), 'metal', T.gold),
        part(circ(tx, ty, 11.5), 'metal', T.gold),
        inner(circ(tx, ty, 4), 'flat', T.hole, { line: 0, plain: true }),
        part(rbox(...swordAt(32, 50), 4, 11, -45, 1.5), 'metal', T.gold),
      ];
    },
  },
  'sword-4': {
    about: 'a crystal blade with a gold hilt',
    draw: (c) => {
      const crystal = c.main(T.cyan);
      const [gx, gy] = swordAt(27, 50);
      const [hx, hy] = swordAt(11, 50);
      const [px, py] = swordAt(-3, 50);
      return [
        part(poly(swordRot([[30, 40], [84, 36], [112, 50], [84, 64], [30, 60]]), 1.5), 'gem', crystal, { shadow: true }),
        inner(poly(swordRot([[30, 50], [84, 50], [112, 50], [84, 64], [30, 60]])), 'flat', crystal, { line: 0, plain: true, fx: { fill: { angle: 90, stops: [[0, crystal.mid], [1, crystal.lo]] } } }),
        inner(poly(swordRot([[30, 40], [84, 36], [112, 50], [84, 50], [30, 50]])), 'flat', crystal, { line: 0, plain: true, fx: { fill: { angle: 90, stops: [[0, crystal.hi], [1, shift(crystal, 0.15).mid]] } } }),
        c.detail > 0 && shine(sparkleP(...swordAt(88, 46), 6), 0.95),
        part(rbox(hx, hy, 22, 10, -45, 3), 'matte', T.leather, { fx: { patterns: [{ kind: 'stripes', color: '#000000', opacity: 0.3, size: 4 * c.u, angle: 135, duty: 0.35 }] } }),
        part(poly(swordRot([[22, 26], [34, 38], [34, 62], [22, 74], [28, 50]]), 2), 'metal', T.gold),
        part(poly(ngon(px, py, 9, 4, 0)), 'metal', T.gold),
        inner(circ(gx, gy, 5), 'gem', crystal),
      ];
    },
  },
};

// ─── Gem cuts ─────────────────────────────────────────────────────────────────────────────────────

const facet = (pts: P2[], t: Tone, k: number) => inner(poly(inset(pts, 0.94), 0.4), 'flat', shift(t, k), { line: 0 });

function gemEmerald(natural: Tone, about: string): PropDef {
  return {
    about,
    currency: true,
    draw: (c) => {
      const g = c.main(natural);
      const o: P2[] = [[24, 12], [76, 12], [90, 26], [90, 74], [76, 88], [24, 88], [10, 74], [10, 26]];
      const i: P2[] = [[32, 26], [68, 26], [76, 34], [76, 66], [68, 74], [32, 74], [24, 66], [24, 34]];
      return [
        part(poly(o, 2), 'gem', shift(g, -0.15), { shadow: true }),
        facet([o[0]!, o[1]!, i[1]!, i[0]!], g, 0.35),
        facet([o[1]!, o[2]!, i[2]!, i[1]!], g, 0.15),
        facet([o[2]!, o[3]!, i[3]!, i[2]!], g, -0.1),
        facet([o[3]!, o[4]!, i[4]!, i[3]!], g, -0.28),
        facet([o[4]!, o[5]!, i[5]!, i[4]!], g, -0.18),
        facet([o[5]!, o[6]!, i[6]!, i[5]!], g, 0),
        facet([o[6]!, o[7]!, i[7]!, i[6]!], g, 0.2),
        facet([o[7]!, o[0]!, i[0]!, i[7]!], g, 0.3),
        inner(poly(i, 1), 'gem', shift(g, 0.18), { line: 0.5, lineColor: shift(g, 0.5).mid }),
        c.detail > 0 && inner(poly(inset(i, 0.62), 1), 'flat', shift(g, 0.32), { line: 0, plain: true }),
        shine(poly([[30, 16], [52, 16], [40, 24], [26, 24]], 1), 0.45),
        shine(sparkleP(70, 22, c.detail ? 8 : 6), 0.95),
      ];
    },
  };
}

function gemOval(natural: Tone, about: string): PropDef {
  return {
    about,
    currency: true,
    draw: (c) => {
      const g = c.main(natural);
      const R = 42;
      const girdle = (deg: number): P2 => [50 + Math.cos((deg * Math.PI) / 180) * R, 50 + Math.sin((deg * Math.PI) / 180) * R * 0.92];
      const tab = (k: number): P2 => [50 + Math.cos(((k * 45 - 90) * Math.PI) / 180) * 20, 50 + Math.sin(((k * 45 - 90) * Math.PI) / 180) * 20 * 0.92];
      // Lit from the upper left: a facet facing that way is lighter.
      const lit = (deg: number) => 0.32 * Math.cos(((deg - 225) * Math.PI) / 180);
      const out: Array<Part | false> = [part(ell(50, 50, R, R * 0.92), 'gem', shift(g, -0.12), { shadow: true })];
      for (let k = 0; k < 8; k++) {
        const a = k * 45 - 90;
        out.push(facet([tab(k), tab(k + 1), girdle(a + 22.5)], g, lit(a + 22.5) + 0.08));
        out.push(facet([tab(k), girdle(a - 22.5), girdle(a), girdle(a + 22.5)], g, lit(a) - 0.06));
      }
      out.push(inner(poly(Array.from({ length: 8 }, (_, k) => tab(k)), 0.5), 'gem', shift(g, 0.22), { line: 0.5, lineColor: shift(g, 0.5).mid }));
      out.push(shine(poly(arcBand(50, 50, R - 6, R - 2.5, 200, 250)), 0.7), shine(sparkleP(66, 30, c.detail ? 8 : 6), 0.95));
      return out;
    },
  };
}

function gemHeart(natural: Tone, about: string): PropDef {
  return {
    about,
    currency: true,
    draw: (c) => {
      const g = c.main(natural);
      const h = heartPts(50, 52, 98, 0);
      const t = heartPts(50, 50, 46, 0);
      const pick = (pts: P2[], i: number) => pts[Math.round((i / 8) * pts.length) % pts.length]!;
      const light = [0.0, -0.2, -0.3, -0.15, 0.05, 0.25, 0.4, 0.2];
      const out: Array<Part | false> = [part(poly(h), 'gem', shift(g, -0.1), { shadow: true })];
      for (let i = 0; i < 8; i++) out.push(facet([pick(h, i), pick(h, i + 1), pick(t, i + 1), pick(t, i)], g, light[i]!));
      out.push(inner(poly(t), 'gem', shift(g, 0.22), { line: 0.5, lineColor: shift(g, 0.5).mid }), shine(sparkleP(32, 30, c.detail ? 8 : 6), 0.95));
      return out;
    },
  };
}

/** The brilliant cut (the classic gem) in a colour. */
function gemBrilliant(natural: Tone, about: string): PropDef {
  return {
    about,
    currency: true,
    draw: (c) => {
      const g = c.main(natural);
      const [TL, TR, R, B, L, a, b, cl, cr]: [P2, P2, P2, P2, P2, P2, P2, P2, P2] = [[24, 12], [76, 12], [97, 36], [50, 95], [3, 36], [38, 12], [62, 12], [30, 36], [70, 36]];
      return [
        part(poly([TL, TR, R, B, L], 2.5), 'gem', shift(g, -0.12)),
        facet([TL, a, cl, L], g, 0.3),
        facet([a, b, cr, cl], g, 0.55),
        facet([b, TR, R, cr], g, 0.05),
        facet([L, cl, B], g, 0.12),
        facet([cl, cr, B], g, 0.3),
        facet([cr, R, B], g, -0.22),
        shine(poly([[27, 15], [36, 15], [28, 33], [10, 33]], 1), 0.4),
        shine(sparkleP(70, 22, c.detail ? 9 : 7), 0.95),
      ];
    },
  };
}

// ─── The registry ─────────────────────────────────────────────────────────────────────────────────

const EGG = tone('#ffffff', '#fff3dc', '#d6b07a');
const TEAL = tone('#9ff5e4', '#2fc6a8', '#0f7a6a');

export const VARIANTS: Record<string, PropDef> = {
  'egg-1': egg('spots', { shell: EGG, mark: TEAL }, 'a speckled pet egg'),
  'egg-2': egg('stripes', { shell: tone('#f0fff8', '#9ff0c8', '#2f9a6a'), mark: tone('#c8a8ff', '#8a5cff', '#4a1aa8') }, 'an egg with zigzag stripes'),
  'egg-3': egg('crack', { shell: tone('#ffffff', '#f6eedc', '#bfa47a'), mark: tone('#fffbe0', '#ffd83a', '#ff9a1a') }, 'a hatching egg with a glowing crack'),
  'egg-4': egg('flames', { shell: tone('#ff9a8a', '#e0302a', '#6a0a12'), mark: tone('#ffd08a', '#ff8a1a', '#c84a00'), mark2: tone('#fffbd0', '#ffe04a', '#ffb020') }, 'an egg wrapped in flames'),
  'egg-5': egg('stars', { shell: tone('#8ab0ff', '#3a4ab8', '#141a5a'), mark: tone('#fffbe0', '#ffd83a', '#e08a00') }, 'an egg covered in stars'),
  'egg-6': egg('swirl', { shell: tone('#ffd8f0', '#ff7ac0', '#a82a6e'), mark: tone('#ffffff', '#fff0fa', '#e0a8cc') }, 'an egg with a swirl'),
  'dragon-egg': egg('flames', { shell: tone('#ff8a6a', '#c0281e', '#4a0808'), mark: tone('#ffd08a', '#ff8a1a', '#c84a00'), mark2: tone('#fffbd0', '#ffe04a', '#ffb020'), scales: true }, 'a scaled dragon egg wrapped in flames'),
  'lava-egg': egg('crack', { shell: tone('#8a7a7e', '#3a3036', '#120a0e'), mark: tone('#fff0a0', '#ff8a1a', '#d02a00'), mark2: tone('#fff0a0', '#ff8a1a', '#d02a00') }, 'a dark rock egg split by glowing lava'),
  'frost-egg': egg('stripes', { shell: tone('#ffffff', '#bfe8ff', '#4a8ad0'), mark: tone('#ffffff', '#ffffff', '#a8d4f4'), mark2: tone('#ffffff', '#e8f6ff', '#a8d4f4') }, 'an icy egg with frost zigzags'),
  'galaxy-egg': egg('stars', { shell: tone('#a88aff', '#3a1a8a', '#0a0428'), mark: tone('#ffffff', '#fff4c0', '#e0b040'), mark2: tone('#ffb0f0', '#ff5ad0', '#8a1a8a') }, 'a galaxy egg with a nebula and stars'),
  'golden-egg': egg('spots', { shell: T.gold, mark: tone('#fffbe0', '#fff0a0', '#e0a820'), mat: 'metal' }, 'a golden egg'),
  'rainbow-egg': egg('rainbow', { shell: tone('#ffffff', '#ffffff', '#c8c8d8'), mark: T.white }, 'a rainbow-striped egg'),
  'mystery-egg': egg('mystery', { shell: tone('#d8b0ff', '#8a4ae0', '#3a127a'), mark: T.gold }, 'a mystery egg with a question mark'),

  'potion-2': potionTall(tone('#a8d8ff', '#2a7cff', '#0a2a9a')),
  'potion-3': potionHeart(tone('#ffd0e8', '#ff4fa0', '#a0105a')),
  'potion-4': potionVial(tone('#d8ffa8', '#5ad83a', '#1a7a1a')),

  'chest-2': chest({ lid: T.iron, body: T.iron, mat: 'metal', band: tone('#8a909c', '#434852', '#16181e'), lock: T.bronze, rivets: true }, 'an iron-plated chest with rivets'),
  'chest-3': chest({ lid: T.gold, body: T.gold, mat: 'metal', band: tone('#fffbe0', '#ffe08a', '#c88a10'), lock: T.gold, panels: tone('#ff8aa8', '#c8143c', '#4a0418'), gems: true }, 'a royal gold chest with velvet and jewels'),

  ...SWORDS,

  'gem-2': gemEmerald(tone('#c8ffd8', '#22c45a', '#0a5a28'), 'an emerald-cut gem'),
  'gem-3': gemOval(tone('#ffc8d0', '#e8203c', '#6a0818'), 'an oval-cut gem'),
  'gem-4': gemHeart(tone('#ffd0f0', '#ff4fb8', '#8a0a5a'), 'a heart-cut gem'),
  ruby: gemOval(tone('#ffc8d0', '#e8203c', '#6a0818'), 'a ruby (oval cut)'),
  emerald: gemEmerald(tone('#c8ffd8', '#22c45a', '#0a5a28'), 'an emerald (emerald cut)'),
  sapphire: gemBrilliant(tone('#c0d8ff', '#2a5aff', '#0a1a8a'), 'a sapphire (brilliant cut)'),
  diamond: gemBrilliant(tone('#ffffff', '#d8f4ff', '#7ab8e0'), 'a clear diamond (brilliant cut)'),
  topaz: gemHeart(tone('#fff0b0', '#ffb81a', '#a85a00'), 'a topaz (heart cut)'),
};
