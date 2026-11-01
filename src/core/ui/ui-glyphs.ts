import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RgbaImage } from '../modeling/png';
import { blurMask, fillMask, newRaster, strokeOutline, toRgba, wound, type Pt, type Raster } from './ui-raster';
import { drawLabel } from './ui-render';

/**
 * Line-art glyphs for game UI without Studio or a network: Lucide's icon set (ISC, ~1,850 icons, bundled as
 * resources/ui-glyphs/lucide.json with its licence), searched by name, alias and a table of game words, and drawn
 * by the core's rasteriser as white lines on a transparent square (ImageColor3 tints them in the game), with an
 * optional dark outline (the sticker look over a busy game) or a coloured glow (sci-fi HUDs). ui_icon {glyph} saves
 * one as an icon and uploads it like any other; mockups show "glyph:<name>" directly.
 */

type SvgNode = [tag: string, attrs: Record<string, string | number>];
interface GlyphSet {
  source: string;
  size: number;
  icons: Record<string, SvgNode[]>;
  aliases: Record<string, string>;
  /** Game concepts ("pet-egg", "rebirth", "loot-crate") and the glyphs that draw them, best first (game-icons.json). */
  concepts?: Record<string, string[]>;
}

let cached: { dir: string; set: GlyphSet | null } | null = null;

/** The bundled glyph set (null when the resources aren't there). */
export function glyphSet(resourcesDir: string | null): GlyphSet | null {
  const dir = resourcesDir ?? '';
  if (cached && cached.dir === dir) return cached.set;
  let set: GlyphSet | null = null;
  const file = join(dir, 'ui-glyphs', 'lucide.json');
  try {
    if (resourcesDir && existsSync(file)) set = JSON.parse(readFileSync(file, 'utf8')) as GlyphSet;
  } catch {
    set = null;
  }
  // The catalogue of game concepts (optional: names still work without it).
  try {
    const games = join(dir, 'ui-glyphs', 'game-icons.json');
    if (set && existsSync(games)) {
      const cat = JSON.parse(readFileSync(games, 'utf8')) as { categories: Record<string, Record<string, string[]>> };
      set.concepts = {};
      for (const group of Object.values(cat.categories)) for (const [k, v] of Object.entries(group)) set.concepts[k] ??= v.filter((g) => set!.icons[g]);
    }
  } catch {
    /* names and aliases only */
  }
  cached = { dir, set };
  return set;
}

/** A glyph's canonical name ("alarm-check" → "alarm-clock-check"), or null when there is none. */
export function glyphName(set: GlyphSet, name: string): string | null {
  const n = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (set.icons[n]) return n;
  if (set.aliases[n] && set.icons[set.aliases[n]!]) return set.aliases[n]!;
  // A game concept ("pet-egg", "rebirth"): its best glyph.
  return set.concepts?.[n]?.[0] ?? set.concepts?.[n.replace(/s$/, '')]?.[0] ?? null;
}

/** Game words the glyph names don't say, and the glyphs that draw them. */
const GAME_WORDS: Record<string, string[]> = {
  missile: ['rocket', 'send-horizontal'], ammo: ['bullet', 'crosshair', 'package'], bullet: ['crosshair'], gun: ['crosshair', 'target'], weapon: ['sword', 'swords', 'crosshair'], reload: ['refresh-cw', 'rotate-cw'],
  energy: ['zap', 'battery-charging'], lightning: ['zap'], power: ['zap', 'power'], boost: ['rocket', 'chevrons-up', 'zap'], speed: ['gauge', 'wind', 'zap'], dash: ['wind', 'chevrons-right'],
  health: ['heart', 'heart-pulse', 'cross'], hp: ['heart'], armor: ['shield'], armour: ['shield'], defense: ['shield'], damage: ['swords', 'flame'], attack: ['sword', 'swords'], magic: ['wand-sparkles', 'sparkles'],
  cash: ['banknote', 'coins', 'circle-dollar-sign'], money: ['banknote', 'coins', 'piggy-bank'], coin: ['coins', 'circle-dollar-sign'], currency: ['coins', 'gem'], robux: ['hexagon', 'gem'], gems: ['gem', 'diamond'], diamond: ['gem', 'diamond'], price: ['tag', 'badge-dollar-sign'],
  shop: ['store', 'shopping-cart', 'shopping-bag'], store: ['store'], buy: ['shopping-cart'], sale: ['badge-percent', 'tag'], discount: ['badge-percent'], deal: ['badge-percent', 'tag'], offer: ['gift', 'badge-percent'],
  inventory: ['backpack', 'package', 'boxes'], bag: ['backpack', 'shopping-bag'], items: ['package', 'boxes'], crate: ['package', 'box'], case: ['package', 'box', 'briefcase'], chest: ['package', 'archive'], loot: ['package', 'gem'],
  trade: ['arrow-left-right', 'repeat', 'handshake'], swap: ['arrow-left-right', 'repeat'], tasks: ['clipboard-list', 'list-checks'], quests: ['scroll-text', 'clipboard-list', 'map'], quest: ['scroll-text', 'map'], missions: ['target', 'flag'], daily: ['calendar-check', 'calendar'],
  rebirth: ['refresh-cw', 'rotate-ccw', 'sparkles'], prestige: ['crown', 'sparkles'], vip: ['crown', 'star'], premium: ['crown', 'gem'], rank: ['trophy', 'medal'], leaderboard: ['trophy', 'list-ordered'], winner: ['trophy', 'crown'], prize: ['trophy', 'gift'], reward: ['gift', 'trophy'],
  pets: ['paw-print', 'dog', 'cat'], pet: ['paw-print'], egg: ['egg'], hatch: ['egg'], index: ['book-open', 'library'], collection: ['library', 'layout-grid'],
  timer: ['timer', 'clock', 'hourglass'], countdown: ['timer', 'hourglass'], time: ['clock', 'timer'],
  settings: ['settings', 'sliders-horizontal'], options: ['settings'], close: ['x'], back: ['arrow-left', 'chevron-left'], menu: ['menu'], friends: ['users', 'user-plus'], invite: ['user-plus'], chat: ['message-circle'],
  notification: ['bell'], new: ['sparkles', 'badge-alert'], locked: ['lock'], unlock: ['lock-open'], level: ['chevrons-up', 'star'], xp: ['star', 'sparkles'], upgrade: ['chevrons-up', 'arrow-big-up'],
  map: ['map', 'compass'], teleport: ['map-pin', 'navigation'], home: ['house'], spawn: ['map-pin'], play: ['play'], skip: ['skip-forward'], sound: ['volume-2'], music: ['music'], mute: ['volume-x'],
  sword: ['sword', 'swords'], bow: ['bow-arrow', 'target'], axe: ['axe'], pickaxe: ['pickaxe'], hammer: ['hammer'], bomb: ['bomb'], fire: ['flame'], ice: ['snowflake'], poison: ['skull', 'flask-conical'], potion: ['flask-conical', 'flask-round'],
  radar: ['radar'], scan: ['scan', 'radar'], target: ['target', 'crosshair'], scope: ['crosshair', 'scan'], grenade: ['bomb'], shield: ['shield'], skull: ['skull'], kill: ['skull', 'crosshair'],
};

/**
 * Glyphs for a query, best first: whole-name matches, then game words, then names and aliases that contain
 * every word of it.
 */
export function searchGlyphs(set: GlyphSet, query: string, limit = 24): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const score = new Map<string, number>();
  const add = (name: string | null, s: number) => {
    if (!name) return;
    score.set(name, Math.max(score.get(name) ?? 0, s));
  };
  const joined = words.join('-');
  add(glyphName(set, joined), 100);
  (set.concepts?.[joined] ?? []).forEach((g, j) => add(g, 95 - j));
  words.forEach((w, i) => {
    add(glyphName(set, w), 90 - i);
    (set.concepts?.[w] ?? set.concepts?.[w.replace(/s$/, '')] ?? []).forEach((g, j) => add(g, 85 - i - j));
    (GAME_WORDS[w] ?? GAME_WORDS[w.replace(/s$/, '')] ?? []).forEach((g, j) => add(glyphName(set, g), 80 - i - j));
  });
  const names = [...Object.keys(set.icons), ...Object.keys(set.aliases)];
  for (const n of names) {
    const parts = n.split('-');
    const all = words.every((w) => parts.some((p) => p === w || p.startsWith(w) || (w.length > 3 && p.includes(w))));
    if (!all) continue;
    const exact = words.filter((w) => parts.includes(w)).length;
    add(glyphName(set, n), 40 + exact * 5 - parts.length);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([n]) => n);
}

/** Names like a misspelt one (for errors that help). */
export function glyphsLike(set: GlyphSet, name: string): string[] {
  const found = searchGlyphs(set, name.replace(/-/g, ' '), 6);
  if (found.length) return found;
  // A typo: the names a few letters away.
  const q = name.toLowerCase();
  const dist = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length]!;
  };
  const max = Math.max(2, Math.floor(q.length / 3));
  return Object.keys(set.icons)
    .map((n) => ({ n, d: dist(q, n) }))
    .filter((x) => x.d <= max)
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 6)
    .map((x) => x.n);
}

// ─── Drawing a glyph ──────────────────────────────────────────────────────────────────────────────

/** An SVG path's subpaths as polylines (with whether each closes). */
export function svgPath(d: string): Array<{ pts: Pt[]; closed: boolean }> {
  const out: Array<{ pts: Pt[]; closed: boolean }> = [];
  // A scanner, not a split: arc flags may be packed against the next number ("a1.5 1.5 0 00-2.4-1.5").
  let at = 0;
  const sep = () => {
    while (at < d.length && /[\s,]/.test(d[at]!)) at++;
  };
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: Pt | null = null;
  let lastQ: Pt | null = null;
  let cur: Pt[] = [];
  const num = () => {
    sep();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(at, at + 32));
    if (!m) {
      at = d.length;
      return 0;
    }
    at += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    sep();
    return d[at++] === '1';
  };
  const flush = (closed: boolean) => {
    if (cur.length > 1) out.push({ pts: cur, closed });
    cur = [];
  };
  const cubic = (c1: Pt, c2: Pt, e: Pt) => {
    const p0: Pt = [x, y];
    const n = Math.max(8, Math.min(40, Math.ceil((Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(e[0] - c2[0], e[1] - c2[1])) * 4)));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      cur.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]]);
    }
  };
  const quad = (c: Pt, e: Pt) => {
    const p0: Pt = [x, y];
    const n = Math.max(8, Math.min(32, Math.ceil((Math.hypot(c[0] - p0[0], c[1] - p0[1]) + Math.hypot(e[0] - c[0], e[1] - c[1])) * 4)));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      cur.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * e[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * e[1]]);
    }
  };
  // SVG's elliptical arc: endpoint form to centre form (SVG spec F.6.5), then points along it.
  const arc = (rx: number, ry: number, phi: number, large: boolean, sweep: boolean, ex: number, ey: number) => {
    if (!rx || !ry) {
      cur.push([ex, ey]);
      return;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const p = (phi * Math.PI) / 180;
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    const dx = (x - ex) / 2;
    const dy = (y - ey) / 2;
    const x1 = cp * dx + sp * dy;
    const y1 = -sp * dx + cp * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) {
      rx *= Math.sqrt(lam);
      ry *= Math.sqrt(lam);
    }
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / (den || 1e-12)));
    const cxp = (co * rx * y1) / ry;
    const cyp = (-co * ry * x1) / rx;
    const cx = cp * cxp - sp * cyp + (x + ex) / 2;
    const cy = sp * cxp + cp * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(6, Math.min(64, Math.ceil(Math.abs(dt) * 16)));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      cur.push([cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp]);
    }
  };
  for (;;) {
    sep();
    if (at >= d.length) break;
    if (/[a-zA-Z]/.test(d[at]!)) cmd = d[at++]!;
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === 'Z') {
      cur.push([sx, sy]);
      flush(true);
      x = sx;
      y = sy;
      lastCtrl = lastQ = null;
      cmd = '';
      continue;
    }
    if (C === 'M') {
      flush(false);
      x = ox + num();
      y = oy + num();
      sx = x;
      sy = y;
      cur = [[x, y]];
      cmd = rel ? 'l' : 'L';
      lastCtrl = lastQ = null;
      continue;
    }
    if (!cur.length) cur = [[x, y]];
    if (C === 'L') {
      x = ox + num();
      y = oy + num();
      cur.push([x, y]);
      lastCtrl = lastQ = null;
    } else if (C === 'H') {
      x = ox + num();
      cur.push([x, y]);
      lastCtrl = lastQ = null;
    } else if (C === 'V') {
      y = oy + num();
      cur.push([x, y]);
      lastCtrl = lastQ = null;
    } else if (C === 'C') {
      const c1: Pt = [ox + num(), oy + num()];
      const c2: Pt = [ox + num(), oy + num()];
      const e: Pt = [ox + num(), oy + num()];
      cubic(c1, c2, e);
      [x, y] = e;
      lastCtrl = c2;
      lastQ = null;
    } else if (C === 'S') {
      const c1: Pt = lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
      const c2: Pt = [ox + num(), oy + num()];
      const e: Pt = [ox + num(), oy + num()];
      cubic(c1, c2, e);
      [x, y] = e;
      lastCtrl = c2;
      lastQ = null;
    } else if (C === 'Q') {
      const c: Pt = [ox + num(), oy + num()];
      const e: Pt = [ox + num(), oy + num()];
      quad(c, e);
      [x, y] = e;
      lastQ = c;
      lastCtrl = null;
    } else if (C === 'T') {
      const c: Pt = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
      const e: Pt = [ox + num(), oy + num()];
      quad(c, e);
      [x, y] = e;
      lastQ = c;
      lastCtrl = null;
    } else if (C === 'A') {
      const rx = num();
      const ry = num();
      const phi = num();
      const large = flag();
      const sweep = flag();
      const ex = ox + num();
      const ey = oy + num();
      arc(rx, ry, phi, large, sweep, ex, ey);
      x = ex;
      y = ey;
      lastCtrl = lastQ = null;
    } else {
      num(); // an unknown command's number: skip it
    }
  }
  flush(false);
  return out;
}

const attr = (v: string | number | undefined, d = 0) => (v === undefined ? d : Number(v));

/** A glyph's drawing as polylines in its 24-unit box, and the parts it fills. */
export function glyphShapes(nodes: SvgNode[]): { lines: Array<{ pts: Pt[]; closed: boolean }>; fills: Pt[][] } {
  const lines: Array<{ pts: Pt[]; closed: boolean }> = [];
  const fills: Pt[][] = [];
  for (const [tag, a] of nodes) {
    let parts: Array<{ pts: Pt[]; closed: boolean }> = [];
    if (tag === 'path') parts = svgPath(String(a.d ?? ''));
    else if (tag === 'circle') parts = [{ pts: Array.from({ length: 64 }, (_, i) => [attr(a.cx) + Math.cos((i / 64) * Math.PI * 2) * attr(a.r), attr(a.cy) + Math.sin((i / 64) * Math.PI * 2) * attr(a.r)] as Pt), closed: true }];
    else if (tag === 'ellipse') {
      const n = 64;
      parts = [{ pts: Array.from({ length: n }, (_, i) => [attr(a.cx) + Math.cos((i / n) * Math.PI * 2) * attr(a.rx), attr(a.cy) + Math.sin((i / n) * Math.PI * 2) * attr(a.ry)] as Pt), closed: true }];
    } else if (tag === 'line') parts = [{ pts: [[attr(a.x1), attr(a.y1)], [attr(a.x2), attr(a.y2)]], closed: false }];
    else if (tag === 'polyline' || tag === 'polygon') {
      const v = String(a.points ?? '').trim().split(/[\s,]+/).map(Number);
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i]!, v[i + 1]!]);
      parts = [{ pts, closed: tag === 'polygon' }];
    } else if (tag === 'rect') {
      const x = attr(a.x);
      const y = attr(a.y);
      const w = attr(a.width);
      const h = attr(a.height);
      const r = Math.min(attr(a.rx, attr(a.ry)), w / 2, h / 2);
      const pts: Pt[] = [];
      if (r > 0) {
        const corner = (cx: number, cy: number, from: number) => {
          for (let i = 0; i <= 12; i++) pts.push([cx + Math.cos(from + (i / 12) * (Math.PI / 2)) * r, cy + Math.sin(from + (i / 12) * (Math.PI / 2)) * r]);
        };
        corner(x + r, y + r, Math.PI);
        corner(x + w - r, y + r, -Math.PI / 2);
        corner(x + w - r, y + h - r, 0);
        corner(x + r, y + h - r, Math.PI / 2);
      } else pts.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
      parts = [{ pts, closed: true }];
    }
    lines.push(...parts);
    if (a.fill && a.fill !== 'none') for (const p of parts) fills.push(p.pts);
  }
  return { lines, fills };
}

export interface GlyphStyle {
  /** Line weight in the glyph's 24-unit box (Lucide draws 2). */
  weight?: number;
  /** The line colour (white by default: ImageColor3 tints it in the game). */
  color?: [number, number, number];
  /** A dark outline round the lines, as a share of the size (0.035 reads well); 0 for none. */
  outline?: number;
  outlineColor?: [number, number, number];
  /** A soft glow behind the lines in this colour. */
  glow?: [number, number, number];
  /** Empty border round the glyph, as a share of the size. */
  margin?: number;
}

/** A glyph as a transparent square picture of `size` pixels. */
export function drawGlyph(nodes: SvgNode[], size: number, style: GlyphStyle = {}): RgbaImage {
  const { lines, fills } = glyphShapes(nodes);
  const margin = (style.margin ?? 0.06) * size + (style.outline ?? 0) * size + (style.glow ? size * 0.08 : 0);
  const k = (size - 2 * margin) / 24;
  const to = (p: Pt): Pt => [margin + p[0] * k, margin + p[1] * k];
  const half = ((style.weight ?? 2) * k) / 2;
  const contours: Pt[][] = [];
  for (const l of lines) contours.push(...strokeOutline([l.pts.map(to)], half, l.closed));
  for (const f of fills) contours.push(wound(f.map(to), 1));
  const bounds = { x: 0, y: 0, w: size, h: size };
  // Straight colour and coverage, composited by hand: the picture keeps its transparency.
  const color = new Float32Array(size * size * 3);
  const alpha = new Float32Array(size * size);
  const lay = (m: ReturnType<typeof fillMask>, col: [number, number, number], a = 1) => {
    if (!m) return;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const s = m.a[y * m.w + x]! * a;
        if (s <= 0) continue;
        const i = (m.y0 + y) * size + m.x0 + x;
        const out = s + alpha[i]! * (1 - s);
        for (let c = 0; c < 3; c++) color[i * 3 + c] = out > 0 ? (col[c]! * s + color[i * 3 + c]! * alpha[i]! * (1 - s)) / out : 0;
        alpha[i] = out;
      }
  };
  const body = fillMask(contours, bounds);
  if (style.glow && body) lay(blurMask(body, size * 0.035, bounds), style.glow, 0.9);
  if (style.outline && style.outline > 0) lay(fillMask(contours.length ? strokeOutline(contours, style.outline * size) : [], bounds), style.outlineColor ?? [0.08, 0.07, 0.06]);
  lay(body, style.color ?? [1, 1, 1]);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(color[i * 3]! * 255);
    data[i * 4 + 1] = Math.round(color[i * 3 + 1]! * 255);
    data[i * 4 + 2] = Math.round(color[i * 3 + 2]! * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, alpha[i]!) * 255);
  }
  return { width: size, height: size, data };
}

/** Found glyphs on a dark sheet with their names, for an agent to pick from. */
export function glyphSheet(set: GlyphSet, names: string[], cell = 96): RgbaImage {
  const cols = Math.min(6, Math.max(1, names.length));
  const rows = Math.ceil(names.length / cols);
  const label = 18;
  const c: Raster = newRaster(cols * cell, rows * (cell + label), [0.1, 0.095, 0.09]);
  names.forEach((n, i) => {
    const x0 = (i % cols) * cell;
    const y0 = Math.floor(i / cols) * (cell + label);
    const g = drawGlyph(set.icons[n]!, cell - 24, { margin: 0.04 });
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++) {
        const a = g.data[(y * g.width + x) * 4 + 3]! / 255;
        if (!a) continue;
        const d = ((y0 + 12 + y) * c.w + x0 + 12 + x) * 3;
        for (let k = 0; k < 3; k++) c.rgb[d + k] = c.rgb[d + k]! * (1 - a) + 0.95 * a;
      }
    drawLabel(c, n, x0 + 6, y0 + cell - 6, 12, [0.75, 0.72, 0.68], { maxWidth: cell - 10 });
  });
  return toRgba(c);
}

