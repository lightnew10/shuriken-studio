import { coverage } from '../canvas';
import { scaleShape, shapeContours } from '../shapes';
import type { P2, Piece } from './geo';

/**
 * A prop's silhouette as one outline: the union of its pieces rasterised once (overlapping outlines of one winding add
 * up to their union), traced at half coverage by marching squares and simplified. The outline pass then draws one
 * layer — one outer edge, one base, one drop shadow, one glow — instead of one per part. Null when the union has a
 * hole (a polygon can't carry one): the caller draws the parts one by one.
 */

/** Outer loops (unit frame) of the union of pieces traced at k cells per unit, or null when it has a hole. */
export function unionOutline(pieces: Piece[], k: number): P2[][] | null {
  if (!pieces.length) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pieces) {
    // Shapes may reach past their box (a turned leaf): pad by a third of the box.
    const px = p.at[2] * 0.35 + 2;
    const py = p.at[3] * 0.35 + 2;
    x0 = Math.min(x0, p.at[0] - px);
    y0 = Math.min(y0, p.at[1] - py);
    x1 = Math.max(x1, p.at[0] + p.at[2] + px);
    y1 = Math.max(y1, p.at[1] + p.at[3] + py);
  }
  const W = Math.ceil((x1 - x0) * k) + 2;
  const H = Math.ceil((y1 - y0) * k) + 2;
  const contours = pieces.flatMap((p) => shapeContours(scaleShape(p.shape, k), (p.at[0] - x0) * k, (p.at[1] - y0) * k, p.at[2] * k, p.at[3] * k));
  const f = coverage(contours, W, H).v;
  const loops = march(f, W, H, 0.5);
  const toUnit = (l: P2[]): P2[] => l.map(([x, y]) => [(x + 0.5) / k + x0, (y + 0.5) / k + y0] as P2);
  const out: P2[][] = [];
  for (let i = 0; i < loops.length; i++) {
    const l = loops[i]!;
    if (l.length < 4) continue;
    let inside = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && contains(loops[j]!, l[0]!)) inside++;
    if (inside % 2 === 1) {
      // A hole bigger than a speck: the union can't be one polygon.
      if (Math.abs(area(l)) > 4) return null;
      continue;
    }
    out.push(simplify(toUnit(l), 0.3 / k));
  }
  return out;
}

/** Closed iso-lines of a field (corner samples at whole coordinates): marching squares, saddles by the centre. */
function march(f: Float32Array, W: number, H: number, iso: number): P2[][] {
  const at = (i: number, j: number) => f[j * W + i]!;
  const hKey = (i: number, j: number) => 2 * (j * W + i);
  const vKey = (i: number, j: number) => 2 * (j * W + i) + 1;
  const point = (key: number): P2 => {
    const cell = key >> 1;
    const i = cell % W;
    const j = (cell - i) / W;
    if (key % 2 === 0) {
      const a = at(i, j);
      const b = at(i + 1, j);
      return [i + (iso - a) / (b - a || 1e-9), j];
    }
    const a = at(i, j);
    const b = at(i, j + 1);
    return [i, j + (iso - a) / (b - a || 1e-9)];
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j + 1 < H; j++)
    for (let i = 0; i + 1 < W; i++) {
      const a = at(i, j) >= iso ? 8 : 0;
      const b = at(i + 1, j) >= iso ? 4 : 0;
      const c = at(i + 1, j + 1) >= iso ? 2 : 0;
      const d = at(i, j + 1) >= iso ? 1 : 0;
      const n = a | b | c | d;
      if (n === 0 || n === 15) continue;
      const T = hKey(i, j);
      const B = hKey(i, j + 1);
      const L = vKey(i, j);
      const R = vKey(i + 1, j);
      const centre = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 >= iso;
      switch (n) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(T, L); break;
        case 5:
          if (centre) { link(T, L); link(R, B); } else { link(T, R); link(L, B); }
          break;
        case 10:
          if (centre) { link(T, R); link(L, B); } else { link(T, L); link(R, B); }
          break;
      }
    }
  const seen = new Set<number>();
  const loops: P2[][] = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: P2[] = [];
    let prev = -1;
    let cur = start;
    for (let guard = 0; guard < 1e6; guard++) {
      seen.add(cur);
      loop.push(point(cur));
      const next = links.get(cur)!.find((x) => x !== prev && !seen.has(x)) ?? links.get(cur)!.find((x) => x !== prev);
      if (next === undefined || next === start) break;
      prev = cur;
      cur = next;
      if (seen.has(cur)) break;
    }
    loops.push(loop);
  }
  return loops;
}

const area = (l: P2[]) => {
  let s = 0;
  for (let i = 0; i < l.length; i++) {
    const [ax, ay] = l[i]!;
    const [bx, by] = l[(i + 1) % l.length]!;
    s += ax * by - bx * ay;
  }
  return s / 2;
};

function contains(l: P2[], [x, y]: P2): boolean {
  let inside = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const [xi, yi] = l[i]!;
    const [xj, yj] = l[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(l: P2[], tol: number): P2[] {
  if (l.length < 8) return l;
  const far = l.reduce((best, p, i) => (Math.hypot(p[0] - l[0]![0], p[1] - l[0]![1]) > Math.hypot(l[best]![0] - l[0]![0], l[best]![1] - l[0]![1]) ? i : best), 0);
  const a = rdp(l.slice(0, far + 1), tol);
  const b = rdp([...l.slice(far), l[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: P2[], tol: number): P2[] {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0]!;
  const [bx, by] = pts[pts.length - 1]!;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1e-9;
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i]!;
    const d = Math.abs((px - ax) * dy - (py - ay) * dx) / len;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tol) return [pts[0]!, pts[pts.length - 1]!];
  return [...rdp(pts.slice(0, at + 1), tol).slice(0, -1), ...rdp(pts.slice(at), tol)];
}
