import { estimateText, isButton, isText, layoutScreen, plainText, strokesOf, TOPBAR, UI_DEVICES, wrapText, type Measure, type RGB, type UiBox, type UiDevice, type UiNode, type UiScreen } from '@shared/ui-layout';
import { resolveVersion, type MockVersion } from '@shared/ui-mockup';
import { defaultScale, renderUi, richRuns, type RenderScreen } from '../ui-render';
import { sampler } from '../ui-raster';
import type { RgbaImage } from '../../modeling/png';

/**
 * A design critic: what an art director would say about a screen, in numbers an agent can act on. ui_audit checks
 * mechanics (off the screen, overlaps, small targets); this measures design quality per screen and device from the
 * layout engine's boxes and, when asked, from the picture the renderer draws over backdrops (a bright sky, a dark
 * scene, the game's own screenshot): legibility on what is really behind the text, the spacing system, alignment,
 * the type scale, colour, hierarchy (is the primary action the most salient button), consistency and density.
 * Every finding carries its elements, its numbers and a concrete fix; every view gets a 0-100 score with sub-scores.
 * Thresholds were tuned by eye on 18 real games' UIs and the project mockups (see tests/ui-lab-critique.test.ts).
 */

export type CritCheck = 'legibility' | 'spacing' | 'alignment' | 'type' | 'color' | 'hierarchy' | 'consistency' | 'density';
export const CRIT_CHECKS: CritCheck[] = ['legibility', 'spacing', 'alignment', 'type', 'color', 'hierarchy', 'consistency', 'density'];
export type CritSeverity = 'problem' | 'warning' | 'note';

export interface CritFinding {
  severity: CritSeverity;
  check: CritCheck;
  /** The view: a ScreenGui ("Shop"), or a menu inside one that a script shows ("Shop.Window"). */
  view: string;
  devices: UiDevice[];
  paths: string[];
  message: string;
  numbers: Record<string, number | string | number[] | string[]>;
  fix: string;
}

export interface CritSub {
  /** 0-100; null when there is nothing to judge (no buttons for hierarchy, no text for legibility). */
  score: number | null;
  why: string;
}

export interface CritScore {
  view: string;
  device: UiDevice;
  /** hud: shown while playing (the world shows round it); menu: a window or full-screen panel. */
  kind: 'hud' | 'menu';
  /** Only on screen when a script shows it (a disabled ScreenGui, a hidden menu). */
  later: boolean;
  score: number;
  sub: Record<CritCheck, CritSub>;
  metrics: CritMetrics;
}

export interface CritMetrics {
  elements: number;
  texts: number;
  /** Distinct rendered text sizes (points on this device). */
  sizes: number[];
  fonts: string[];
  /** The spacing grid the fixed spacing values follow (8, 6, 5, 4, 3 or 2), null with too few values. */
  spacingBase: number | null;
  /** Share of fixed spacing values on a grid of 4 or more. */
  gridShare: number | null;
  spacingValues: number[];
  palette: number;
  accents: number;
  radii: number[];
  /** Share of the safe area covered by what it draws. */
  coverage: number;
  /** Worst text contrast over the backdrops (10th percentile round the glyphs), and where. */
  worstContrast: { ratio: number; path: string; backdrop: string } | null;
}

/** What a player sees while playing, per device: every enabled HUD screen together. */
export interface PlayDensity {
  device: UiDevice;
  coverage: number;
  /** Share of the middle (40% × 40%) of the screen covered. */
  centre: number;
  /** Separate clusters of HUD (8 pt apart or more). */
  widgets: number;
  screens: Record<string, number>;
}

export interface Critique {
  findings: CritFinding[];
  scores: CritScore[];
  play: PlayDensity[];
  notes: string[];
}

export interface CritBackdrop {
  name: string;
  image: 'bright' | 'dark' | RgbaImage;
}

/** How a device is seen: Roblox UI points per inch on its screen and the eye's distance in mm. */
export interface Viewing {
  ppi: number;
  mm: number;
}

export const VIEWING: Record<UiDevice, Viewing> = {
  // An iPhone: 3 px per point at about 460 ppi, held at 30 cm.
  phone: { ppi: 153, mm: 300 },
  phonePortrait: { ppi: 153, mm: 300 },
  tablet: { ppi: 132, mm: 380 },
  laptop: { ppi: 112, mm: 500 },
  // A 24" 1080p monitor at 60 cm; a 55" TV at 2.5 m.
  desktop: { ppi: 92, mm: 600 },
  tv: { ppi: 40, mm: 2500 },
};

/** The em's visual angle in arc minutes. */
export const arcmin = (pt: number, v: Viewing): number => (Math.atan((pt * 25.4) / v.ppi / v.mm) * 180 * 60) / Math.PI;
export const ptToMm = (pt: number, v: Viewing): number => (pt * 25.4) / v.ppi;

/** Text minimums as the em's visual angle: labels and numbers 18.5′ (phone 9.7 pt, desktop 11.7, TV 21), body 21′ (phone 11, desktop 13.3, TV 24), never under 15′. */
export const TEXT_MIN = { label: 18.5, number: 18.5, body: 21, floor: 15 };

export interface CritiqueOptions {
  devices?: UiDevice[];
  /** Read the rendered pictures (legibility on real pixels, salience); default true. */
  pixels?: boolean;
  /** Backdrops text must read on (default a bright sky and a dark scene). */
  backdrops?: CritBackdrop[];
  /** Images for the renderer (projectImages); text over an image that isn't there is not judged. */
  images?: (ref: string, px: number) => RgbaImage | null;
  viewing?: Partial<Record<UiDevice, Viewing>>;
  /**
   * The real screen each form is judged on (a Lab phone's size and safe area: an iPhone SE is 667×375), instead of the
   * form's canonical one; pair it with its `viewing` (the device's points per inch).
   */
  screens?: Partial<Record<UiDevice, UiScreen & { label?: string }>>;
  /** Hidden menus (Visible = false under a shown parent) get their own view when they draw this many elements (6). */
  hiddenMin?: number;
  measure?: Measure;
  /** Only these views. */
  views?: string[];
}

/** The screen a form is judged on: the real device's when given, else the form's canonical one. */
const screenFor = (device: UiDevice, o: Pick<CritiqueOptions, 'screens'>): UiScreen & { label?: string } => o.screens?.[device] ?? UI_DEVICES[device];
const deviceLabel = (device: UiDevice, o: Pick<CritiqueOptions, 'screens'>): string => (screenFor(device, o).label ?? UI_DEVICES[device].label).toLowerCase();

// ─── Small helpers ────────────────────────────────────────────────────────────────────────────────

type R = { x: number; y: number; w: number; h: number };
type C3 = [number, number, number];
const area = (r: R | null) => (r ? Math.max(0, r.w) * Math.max(0, r.h) : 0);
const inter = (a: R, b: R): R | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0.25 && h > 0.25 ? { x, y, w, h } : null;
};
const union = (a: R | null, b: R | null): R | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r0 = (v: number) => Math.round(v);
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]! : 0;
};
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const hex = (c: RGB) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const vOverlap = (a: R, b: R) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const hOverlap = (a: R, b: R) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum01 = (c: C3) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast of two colours in 0..1. */
const ratio01 = (a: C3, b: C3) => {
  const x = lum01(a);
  const y = lum01(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const c01 = (c: RGB): C3 => [c[0] / 255, c[1] / 255, c[2] / 255];
const mix = (a: C3, b: C3, t: number): C3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** CIELAB (D65) of a colour in 0..1: lightness, chroma, hue (degrees). */
function lch(c: C3): { L: number; a: number; b: number; C: number; h: number } {
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(Y) - 16;
  const A = 500 * (f(X) - f(Y));
  const B = 200 * (f(Y) - f(Z));
  return { L, a: A, b: B, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}
const deltaE = (p: C3, q: C3) => {
  const a = lch(p);
  const b = lch(q);
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
};
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const HUES: Array<[number, string]> = [
  [20, 'red'],
  [50, 'orange'],
  [85, 'yellow'],
  [140, 'green'],
  [200, 'teal'],
  [260, 'blue'],
  [300, 'purple'],
  [345, 'pink'],
  [360, 'red'],
];
const hueName = (h: number) => HUES.find(([lim]) => h < lim)?.[1] ?? 'red';

// ─── Words ────────────────────────────────────────────────────────────────────────────────────────

const PRIMARY = /\b(buy|purchase|play|start|confirm|claim|equip|accept|continue|ok|okay|yes|upgrade|spin|join|ready|go|collect|redeem|craft|deploy|launch|unlock|get|save|apply|submit|create|respawn|retry|next|done|enter|show me|let'?s go|begin|sell|trade|open)\b/i;
const SECONDARY = /\b(cancel|close|back|no|later|skip|exit|dismiss|not now|nah|decline|leave|quit|maybe later|return)\b/i;
const CLOSE_GLYPH = /^\s*[x×✕✖]\s*$/i;
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
type Role = 'primary' | 'secondary' | null;
function roleOf(label: string, name: string): Role {
  if (CLOSE_GLYPH.test(label)) return 'secondary';
  if (label.trim()) {
    if (SECONDARY.test(label)) return 'secondary';
    if (PRIMARY.test(label)) return 'primary';
    return null;
  }
  const n = words(name);
  if (/\bclose|cancel|back|exit\b/i.test(n)) return 'secondary';
  if (/\b(buy|purchase|play|confirm|claim|equip|accept|spin|upgrade)\b/i.test(n)) return 'primary';
  return null;
}

const EMOJI = /\p{Extended_Pictographic}/u;
/** Emoji draw in their own colours; what's left once they are taken out. */
const withoutEmoji = (t: string) => t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '');
/** Text that is an icon: emoji alone, or one character ("X", "+", "?"). */
const glyphText = (t: string) => withoutEmoji(t).replace(/\s/g, '').length <= 1 || (EMOJI.test(t) && withoutEmoji(t).replace(/[\s\d×x:+.,-]/gi, '').length < 2);

type TextRole = 'number' | 'label' | 'body';
function textRole(t: string, lines: number): TextRole {
  const s = t.replace(/\s/g, '');
  const digits = (s.match(/[0-9]/g) ?? []).length;
  if (s.length && digits / s.length >= 0.5) return 'number';
  if (t.trim().split(/\s+/).length >= 5 || lines > 1) return 'body';
  return 'label';
}

// ─── Views ────────────────────────────────────────────────────────────────────────────────────────

interface View {
  name: string;
  screen: UiNode;
  /** The hidden menu this view is about (null: the whole screen). */
  scope: UiNode | null;
  showPaths: string[];
  showIds: Set<number>;
  later: boolean;
}

const fills = (n: UiNode) => (n.bg ? 1 - (n.bgT ?? 0) : 0);
const hasImage = (n: UiNode) => (n.cls === 'ImageLabel' || n.cls === 'ImageButton') && !!n.image && (n.imageT ?? 0) < 0.95;
const borderStrokes = (n: UiNode) => strokesOf(n).filter((s) => !(s.text && isText(n)) && s.t < 0.95 && s.px > 0);
const showsText = (n: UiNode) => isText(n) && !!plainText(n).trim() && (n.textT ?? 0) < 0.95;
const drawsStatic = (n: UiNode) => fills(n) > 0.05 || hasImage(n) || showsText(n) || borderStrokes(n).length > 0;

function viewsOf(screens: UiNode[], hiddenMin: number): View[] {
  const out: View[] = [];
  for (const s of screens) {
    const base = s.enabled === false ? [s.name] : [];
    out.push({ name: s.name, screen: s, scope: null, showPaths: base, showIds: new Set(), later: s.enabled === false });
    const walk = (n: UiNode, path: string) => {
      for (const c of n.kids ?? []) {
        const p = `${path}.${c.name}`;
        if (c.visible === false) {
          let count = 0;
          const tally = (x: UiNode) => {
            if (x !== c && x.visible === false) return;
            if (drawsStatic(x)) count++;
            for (const k of x.kids ?? []) tally(k);
          };
          tally(c);
          if (count >= hiddenMin) out.push({ name: p, screen: s, scope: c, showPaths: [...base, p], showIds: new Set([c.id]), later: true });
        } else walk(c, p);
      }
    };
    walk(s, s.name);
  }
  return out;
}

// ─── The model of a view on a device ──────────────────────────────────────────────────────────────

interface El {
  b: UiBox;
  n: UiNode;
  path: string;
  parent: El | null;
  kids: El[];
  /** The part of its box on the screen (clipping applied). */
  vis: R | null;
  turned: boolean;
  fillA: number;
  image: boolean;
  border: boolean;
  text: string;
  draws: boolean;
  /** Covers most of the screen: a backdrop, a dim or a full-screen menu's background. */
  dim: boolean;
  /** What it and its children draw (text by its glyph lines). */
  ink: R | null;
  /** Its layout extent: its box if it draws, else its drawn children's. */
  lay: R | null;
  lines: R[];
  /** Inside a button (its icon, its label). */
  inButton: boolean;
  /** Part of an illustration built from frames (a mech's silhouette, a pixel heart, a speaker drawn in boxes). */
  art: boolean;
}

interface Model {
  dev: UiScreen;
  root: R;
  els: El[];
  byNode: Map<UiNode, El>;
  tops: El[];
}

/** The area a ScreenGui lays out in on a device (as layoutScreen computes it). */
function rootArea(screen: UiNode, dev: UiScreen): R {
  const full = screen.ignoreInset || screen.insets === 'None';
  const top = full ? 0 : (dev.top ?? 0) + (screen.insets === 'DeviceSafeInsets' ? 0 : (dev.topbar ?? TOPBAR));
  const bottom = full ? 0 : (dev.bottom ?? 0);
  const side = full ? 0 : (dev.side ?? 0);
  return { x: side, y: top, w: dev.w - 2 * side, h: dev.h - top - bottom };
}

/** The glyph lines of a text element in points (as the renderer places them). */
function textLines(b: UiBox, measure: Measure): R[] {
  const n = b.node;
  const size = b.fontSize;
  if (size <= 0) return [];
  const k = b.k || 1;
  const u = (d: [number, number] | undefined, len: number) => (d ? d[0] * len + d[1] * k : 0);
  const pad = n.padding;
  const [pt, pr, pb, pl] = pad ? [u(pad[0], b.h), u(pad[1], b.w), u(pad[2], b.h), u(pad[3], b.w)] : [0, 0, 0, 0];
  const areaW = Math.max(1, b.w - pl - pr);
  const areaH = Math.max(1, b.h - pt - pb);
  const text = n.rich ? richRuns(n.text ?? '', true).map((r) => r.ch).join('') : (n.text ?? '');
  const lines = (n.wrapped || n.scaled ? wrapText(text, size, areaW, n, measure) : text.split('\n')).filter((l) => l.trim());
  if (!lines.length) return [];
  const lineH = size * (n.lineHeight ?? 1);
  let top = pt + (n.yAlign === 'Top' ? 0 : n.yAlign === 'Bottom' ? areaH - lines.length * lineH : (areaH - lines.length * lineH) / 2);
  const out: R[] = [];
  for (const l of lines) {
    const w = Math.min(areaW, measure(l, size, n));
    const x = pl + (n.xAlign === 'Left' ? 0 : n.xAlign === 'Right' ? areaW - w : (areaW - w) / 2);
    const base = top + lineH / 2 + size * 0.35;
    out.push({ x: b.x + x, y: b.y + base - size * 0.72, w, h: size * 0.86 });
    top += lineH;
  }
  return out;
}

function buildModel(view: View, dev: UiScreen, measure: Measure): Model {
  const boxes = layoutScreen(view.screen, dev, { measure, show: view.showIds });
  const parentOf = new Map<UiNode, UiNode>();
  // A folder's children belong to the folder's parent (a skin's art lives in one).
  const link = (n: UiNode, owner: UiNode = n) => {
    for (const c of n.kids ?? []) {
      if (c.cls === 'Folder') {
        link(c, owner);
        continue;
      }
      parentOf.set(c, owner);
      link(c);
    }
  };
  link(view.screen);
  const inScope = (n: UiNode): boolean => {
    if (!view.scope) return true;
    for (let x: UiNode | undefined = n; x; x = parentOf.get(x)) if (x === view.scope) return true;
    return false;
  };
  const screenR: R = { x: 0, y: 0, w: dev.w, h: dev.h };
  const root = rootArea(view.screen, dev);
  const byNode = new Map<UiNode, El>();
  const els: El[] = [];
  for (const b of boxes) {
    const n = b.node;
    const p = parentOf.get(n);
    const parent = p ? (byNode.get(p) ?? null) : null;
    // A worn skin's art is its element's fill (a panel, a button face), not content of its own: its glow reaches past
    // the box, so it takes no part in spacing or collisions. Its pixels still draw for legibility.
    if (n.decor) {
      if (parent && parent.vis) {
        parent.fillA = Math.max(parent.fillA, 0.95);
        parent.draws = true;
      }
      continue;
    }
    let vis: R | null = b.w > 0 && b.h > 0 ? inter({ x: b.x, y: b.y, w: b.w, h: b.h }, screenR) : null;
    if (vis && b.clip) vis = inter(vis, { x: b.clip[0], y: b.clip[1], w: b.clip[2], h: b.clip[3] });
    const turned = !!b.rot || !!parent?.turned;
    const text = showsText(n) && b.fontSize > 0 ? plainText(n).trim() : '';
    const fillA = fills(n);
    const image = hasImage(n);
    const border = borderStrokes(n).length > 0 || (!!n.border && n.border > 0 && fillA > 0);
    const draws = !!vis && (fillA > 0.05 || image || border || !!text);
    const el: El = { b, n, path: b.path, parent, kids: [], vis, turned, fillA, image, border, text, draws, dim: false, ink: null, lay: null, lines: [], inButton: !!parent && (parent.inButton || isButton(parent.n)), art: false };
    if (text && vis) el.lines = textLines(b, measure).map((l) => inter(l, vis!)).filter((l): l is R => !!l);
    el.dim = draws && fillA > 0.05 && area(vis) >= 0.6 * area(root);
    byNode.set(n, el);
    if (parent) parent.kids.push(el);
    if (inScope(n)) els.push(el);
  }
  // Ink and layout extents, children first (boxes come parents first).
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i]!;
    const textOnly = !!e.text && e.fillA <= 0.05 && !e.image && !e.border;
    let ink: R | null = e.draws ? (textOnly ? e.lines.reduce<R | null>((u, l) => union(u, l), null) : e.vis) : null;
    let lay: R | null = e.draws ? e.vis : null;
    for (const k of e.kids) {
      ink = union(ink, k.ink);
      if (!e.draws) lay = union(lay, k.lay);
    }
    e.ink = ink;
    e.lay = lay;
  }
  const tops = els.filter((e) => !e.parent || !els.includes(e.parent));
  // Illustrations: four or more drawn pieces with no text or button among them and no layout. Their parts are
  // drawing, not layout; the illustration counts as one block.
  const mark = (e: El): { drawn: number; words: boolean } => {
    let drawn = 0;
    let words = false;
    for (const k of e.kids) {
      const s = mark(k);
      drawn += s.drawn + (k.draws ? 1 : 0);
      words ||= s.words || !!k.text || isButton(k.n);
    }
    if (drawn >= 4 && !words && !e.n.list && !e.n.grid) {
      const all = (x: El) => {
        for (const k of x.kids) {
          k.art = true;
          all(k);
        }
      };
      all(e);
    }
    return { drawn, words };
  };
  for (const t of tops) mark(t);
  return { dev, root, els, byNode, tops };
}

// ─── Pixels ───────────────────────────────────────────────────────────────────────────────────────

interface Layer {
  w: number;
  h: number;
  scale: number;
  /** The UI over black (premultiplied colour) and how much of what is behind shows through, per channel. */
  pre: Float32Array;
  tr: Float32Array;
}

const solid = (v: number): RgbaImage => ({ width: 1, height: 1, data: new Uint8Array([v, v, v, 255]) });

/** The view drawn without its text (what is behind the letters), as a layer that composites over any backdrop. */
function textlessLayer(view: View, device: RenderScreen, images: CritiqueOptions['images']): Layer {
  const hide = (n: UiNode): UiNode => {
    const out: UiNode = { ...n };
    if (isText(n)) {
      out.textT = 1;
      if (out.strokeT !== undefined) out.strokeT = 1;
      if (n.rich && n.text) out.text = n.text.replace(/<\/?stroke[^>]*>/gi, '');
    }
    if (n.stroke || n.strokes) {
      const s = strokesOf(n).map((x) => (x.text ? { ...x, t: 1 } : x));
      out.stroke = s[0];
      out.strokes = s.length > 1 ? s : undefined;
    }
    if (n.kids) out.kids = n.kids.map(hide);
    return out;
  };
  const screen = hide(view.screen);
  const scale = defaultScale(device);
  const o = { rulers: false, guides: false, show: view.showPaths, scale, ...(images ? { images } : {}) };
  const black = renderUi([screen], device, { ...o, backdrop: solid(0) }).image;
  const white = renderUi([screen], device, { ...o, backdrop: solid(255) }).image;
  const px = black.width * black.height;
  const pre = new Float32Array(px * 3);
  const tr = new Float32Array(px * 3);
  // The renderer dims a picture backdrop to 85%: white is drawn as 217.
  const span = Math.round(0.85 * 255);
  for (let i = 0; i < px; i++)
    for (let c = 0; c < 3; c++) {
      const b = black.data[i * 4 + c]!;
      pre[i * 3 + c] = b / 255;
      tr[i * 3 + c] = Math.max(0, Math.min(1, (white.data[i * 4 + c]! - b) / span));
    }
  return { w: black.width, h: black.height, scale, pre, tr };
}

const backdropCache = new Map<string, Float32Array>();
/** A backdrop as the renderer draws it (bright sky and grass, the UI page's dark slate, a picture cropped to fill and dimmed). */
function backdropPixels(bd: CritBackdrop, w: number, h: number): Float32Array {
  const key = `${bd.name}|${typeof bd.image === 'string' ? bd.image : `${bd.image.width}x${bd.image.height}`}|${w}x${h}`;
  const hit = backdropCache.get(key);
  if (hit) return hit;
  const out = new Float32Array(w * h * 3);
  if (typeof bd.image === 'object') {
    const img = bd.image;
    const s = sampler(img, img.width / w);
    const ia = img.width / img.height;
    const fitW = w / h > ia;
    const iw = fitW ? w : h * ia;
    const ih = fitW ? w / ia : h;
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        s((x + (iw - w) / 2) / iw, (y + (ih - h) / 2) / ih, px);
        out.set([(px[0]! / 255) * 0.85, (px[1]! / 255) * 0.85, (px[2]! / 255) * 0.85], (y * w + x) * 3);
      }
  } else
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let col: C3;
        if (bd.image === 'bright') {
          const t = y / h;
          col = t < 0.55 ? [0.55 + 0.25 * t, 0.75 + 0.2 * t, 0.98] : [0.42 - 0.1 * (t - 0.55), 0.68 - 0.15 * (t - 0.55), 0.3];
        } else {
          const d = Math.min(1, Math.hypot((x - w / 2) / w, (y - h * 0.35) / h) / 0.7);
          col = [0.235 + (0.086 - 0.235) * d, 0.29 + (0.106 - 0.29) * d, 0.361 + (0.133 - 0.361) * d];
        }
        out.set(col, (y * w + x) * 3);
      }
  if (backdropCache.size > 24) backdropCache.clear();
  backdropCache.set(key, out);
  return out;
}

/** Pixel indices inside a rectangle of points (at most `max`, evenly strided). */
function pixelsIn(layer: Layer, r: R, max = 600): number[] {
  const x0 = Math.max(0, Math.floor(r.x * layer.scale));
  const y0 = Math.max(0, Math.floor(r.y * layer.scale));
  const x1 = Math.min(layer.w, Math.ceil((r.x + r.w) * layer.scale));
  const y1 = Math.min(layer.h, Math.ceil((r.y + r.h) * layer.scale));
  const n = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!n) return [];
  const step = Math.max(1, Math.sqrt(n / max));
  const out: number[] = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) out.push(Math.floor(y) * layer.w + Math.floor(x));
  return out;
}

const composite = (layer: Layer, bd: Float32Array, i: number): C3 => [layer.pre[i * 3]! + layer.tr[i * 3]! * bd[i * 3]!, layer.pre[i * 3 + 1]! + layer.tr[i * 3 + 1]! * bd[i * 3 + 1]!, layer.pre[i * 3 + 2]! + layer.tr[i * 3 + 2]! * bd[i * 3 + 2]!];

const meanColour = (cols: C3[]): C3 => {
  const s: C3 = [0, 0, 0];
  for (const c of cols) {
    s[0] += c[0];
    s[1] += c[1];
    s[2] += c[2];
  }
  return cols.length ? [s[0] / cols.length, s[1] / cols.length, s[2] / cols.length] : [0, 0, 0];
};

// ─── Findings ─────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  view: View;
  device: UiDevice;
  /** The device's name in messages ("small phone (iphone se)"). */
  label: string;
  m: Model;
  measure: Measure;
  viewing: Viewing;
  layer: Layer | null;
  backdrops: Array<{ bd: CritBackdrop; px: Float32Array }>;
  images: CritiqueOptions['images'];
  out: Array<Omit<CritFinding, 'view' | 'devices'>>;
  kind: 'hud' | 'menu';
}

const add = (ctx: Ctx, f: Omit<CritFinding, 'view' | 'devices'>) => ctx.out.push(f);
const short = (paths: string[], max = 6) => (paths.length > max ? [...paths.slice(0, max), `… ${paths.length - max} more`] : paths);
const name = (e: El) => e.path.split('.').slice(-2).join('.');

// Legibility ───────────────────────────────────────────────────────────────────────────────────────

interface TextRead {
  e: El;
  worst: number;
  worstOn: string;
  /** The median ratio on the worst backdrop, and the mean colour behind its worst 10%. */
  worstMid: number;
  behind: C3;
  best: number;
  bestOn: string;
  stroked: boolean;
  large: boolean;
  role: TextRole;
  arc: number;
  glyph: boolean;
}

function textColours(n: UiNode): C3[] {
  const base = c01(n.textColor ?? [0, 0, 0]);
  const cols: C3[] = [base];
  if (n.rich && n.text) for (const r of richRuns(n.text, true)) if (r.color && r.ch.trim()) cols.push(c01(r.color));
  if (n.gradient?.colors.length) return cols.flatMap((c) => n.gradient!.colors.map(([, r, g, b]) => [c[0] * (r / 255), c[1] * (g / 255), c[2] * (b / 255)] as C3));
  const seen = new Map<string, C3>();
  for (const c of cols) seen.set(c.map((v) => v.toFixed(2)).join(','), c);
  return [...seen.values()];
}

/** The nearest fill under an element that hides what is behind (node colours, for when there are no pixels). */
function solidBehind(e: El): C3 | null {
  for (let x: El | null = e; x; x = x.parent) if (x.fillA >= 0.9 && x.n.bg) return c01(x.n.bg);
  return null;
}

function legibility(ctx: Ctx): TextRead[] {
  const reads: TextRead[] = [];
  const placeholders = ctx.m.els.filter((e) => e.image && e.vis && !(ctx.images?.(e.n.image!, 64) ?? null)).map((e) => ({ r: e.vis!, order: e.b.order }));
  const covers = ctx.m.els.filter((e) => e.vis && !e.dim && (e.fillA >= 0.9 || (e.image && (e.n.imageT ?? 0) < 0.1))).map((e) => ({ e, r: e.vis!, order: e.b.order }));
  const fallback: Array<{ name: string; c: C3 }> = [
    { name: 'bright', c: [0.66, 0.84, 0.98] },
    { name: 'dark', c: [0.17, 0.2, 0.25] },
  ];
  for (const e of ctx.m.els) {
    if (!e.text || !e.lines.length || e.turned) continue;
    // Emoji draw in their own colours (Roblox ignores TextColor for them).
    if (EMOJI.test(e.text) && withoutEmoji(e.text).replace(/[\s\d×x:+.,-]/gi, '').length < 2) continue;
    const n = e.n;
    // Text over an image that isn't drawn (not cached here) can't be judged.
    if (placeholders.some((p) => p.order <= e.b.order && e.lines.some((l) => inter(l, p.r)))) continue;
    const size = e.b.fontSize;
    // A big faint word is a watermark, faint on purpose.
    if ((n.textT ?? 0) >= 0.6 && size >= 28) continue;
    // Covered by something drawn over it (a fallback initial under an avatar picture): not seen.
    const inkArea = e.lines.reduce((t, l) => t + area(l), 0);
    const over = covers.filter((c) => c.order > e.b.order && !nested(c.e, e)).reduce((t, c) => t + e.lines.reduce((u, l) => u + area(inter(l, c.r)), 0), 0);
    if (over >= 0.5 * inkArea) continue;
    const textA = 1 - (n.textT ?? 0);
    const strokes: Array<{ c: C3; a: number }> = [];
    if (n.strokeT !== undefined && n.strokeT < 1) strokes.push({ c: c01(n.strokeColor ?? [0, 0, 0]), a: (1 - n.strokeT) * Math.min(1, size / 28 / Math.max(0.5, 0.05 * size)) });
    for (const s of strokesOf(n)) if (s.text && s.t < 1) strokes.push({ c: c01(s.color), a: (1 - s.t) * Math.min(1, (s.px * (e.b.k || 1)) / Math.max(0.75, 0.05 * size)) });
    const cols = textColours(n);
    const ratioOver = (B: C3): number => {
      let E = B;
      for (const s of strokes) E = mix(E, s.c, s.a);
      let worst = Infinity;
      for (const col of cols) {
        const T = mix(E, col, textA);
        const r = Math.max(ratio01(T, E), strokes.length ? ratio01(mix(B, col, textA), B) : 0);
        worst = Math.min(worst, r);
      }
      return worst;
    };
    const per: Array<{ name: string; r: number; mid: number; behind: C3 }> = [];
    if (ctx.layer) {
      const idx = e.lines.flatMap((l) => pixelsIn(ctx.layer!, l, Math.ceil(600 / e.lines.length)));
      if (!idx.length) continue;
      for (const { bd, px } of ctx.backdrops) {
        const rs = idx.map((i) => {
          const B = composite(ctx.layer!, px, i);
          return { r: ratioOver(B), B };
        });
        rs.sort((a, b) => a.r - b.r);
        const cut = Math.max(1, Math.floor(rs.length * 0.1));
        per.push({ name: bd.name, r: rs[Math.min(rs.length - 1, cut - 1)]!.r, mid: rs[Math.floor(rs.length / 2)]!.r, behind: meanColour(rs.slice(0, cut).map((x) => x.B)) });
      }
    } else {
      const solid = solidBehind(e);
      for (const f of fallback) {
        const r = ratioOver(solid ?? f.c);
        per.push({ name: f.name, r, mid: r, behind: solid ?? f.c });
      }
    }
    if (!per.length) continue;
    per.sort((a, b) => a.r - b.r);
    const bold = !!n.bold || /bold|heavy|black/i.test(n.font ?? '');
    reads.push({
      e,
      worst: per[0]!.r,
      worstOn: per[0]!.name,
      worstMid: per[0]!.mid,
      behind: per[0]!.behind,
      best: per[per.length - 1]!.r,
      bestOn: per[per.length - 1]!.name,
      stroked: strokes.some((s) => s.a > 0.4),
      large: size >= 24 || (size >= 18.5 && bold),
      role: textRole(e.text, e.lines.length),
      arc: arcmin(size, ctx.viewing),
      glyph: glyphText(e.text),
    });
  }
  // Contrast: grouped by look (colour, stroke) and backdrop, so twelve white labels on a sky are one finding.
  const groups = new Map<string, TextRead[]>();
  for (const t of reads) {
    const need = t.large ? 2.4 : 3;
    if (t.worst >= need) continue;
    const key = `${hex(t.e.n.textColor ?? [0, 0, 0])}|${t.stroked}|${t.worstOn}|${t.best >= need ? 'one' : 'all'}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.worst - b.worst);
    const w = g[0]!;
    const problem = g.some((t) => t.worst < (t.large ? 1.6 : 2));
    const col = hex(w.e.n.textColor ?? [0, 0, 0]);
    const need = w.large ? 2.4 : 3;
    const onBackdropOnly = w.best >= need && w.best / w.worst > 1.3;
    // Most of it reads, the worst tenth doesn't: the text runs off its fill onto something else.
    const spills = !onBackdropOnly && w.worstMid >= need + 1;
    const behind = hex(w.behind.map((v) => v * 255) as RGB);
    const what = g.length === 1 ? `"${w.e.text.slice(0, 24)}"` : `${g.length} texts`;
    add(ctx, {
      severity: problem ? 'problem' : 'warning',
      check: 'legibility',
      paths: short(g.map((t) => t.e.path)),
      message: onBackdropOnly
        ? `${what} (${col}${w.stroked ? ', stroked' : ''}) read ${r1(w.best)}:1 on the ${w.bestOn} backdrop but ${r1(w.worst)}:1 on the ${w.worstOn} one (worst 10% round the glyphs)`
        : spills
          ? `${what} (${col}) reads ${r1(w.worstMid)}:1 over most of it but ${r1(w.worst)}:1 where it runs over ${behind}: it spills off its fill`
          : `${what} (${col}) at ${r1(w.worst)}:1 against ${behind} behind ${g.length === 1 ? 'it' : 'them'} (worst 10% round the glyphs; 3:1 is the floor, 4.5:1 reads well)`,
      numbers: { contrast: r1(w.worst), median: r1(w.worstMid), [`on_${w.bestOn}`]: r1(w.best), backdrop: w.worstOn, behind, size: r1(w.e.b.fontSize) },
      fix: onBackdropOnly
        ? 'give it a dark text outline (UIStroke Contextual 2 px, #000 at 0.3 transparency) or a backing panel at 0.3-0.5 transparency, so it reads on a bright sky too'
        : spills
          ? 'keep the text inside its fill: a shorter label, a smaller TextSize, or a wider box'
          : lch(w.behind).L > 55
            ? `darken the text to about ${hex(darker(c01(w.e.n.textColor ?? [0, 0, 0]), w.behind))} (or lighten what is behind) to reach 4.5:1`
            : `lighten the text to about ${hex(lighter(c01(w.e.n.textColor ?? [0, 0, 0]), w.behind))} or add a dark outline to reach 4.5:1`,
    });
  }
  // Cut short: TextTruncate ends what doesn't fit in "…" ("SETTI…", "S…"): a title or a label cut short reads broken.
  const cut: Array<{ e: El; shown: number }> = [];
  for (const e of ctx.m.els) {
    if (!e.text || !e.n.truncate || e.n.wrapped || e.n.scaled || !e.lines.length || e.turned || e.text.includes('\n')) continue;
    const k = e.b.k || 1;
    const p = e.n.padding;
    const areaW = e.b.w - (p ? p[1][0] * e.b.w + p[1][1] * k + p[3][0] * e.b.w + p[3][1] * k : 0);
    const full = ctx.measure(e.text, e.b.fontSize, e.n);
    if (full > areaW + 2) cut.push({ e, shown: Math.max(0, areaW / full) });
  }
  if (cut.length) {
    cut.sort((a, b) => a.shown - b.shown);
    const bad = cut.filter((c) => c.shown < 0.6 || c.e.text.length <= 14);
    add(ctx, {
      severity: bad.length ? 'warning' : 'note',
      check: 'legibility',
      paths: short(cut.map((c) => `${c.e.path} ("${c.e.text.slice(0, 16)}", ${r0(c.shown * 100)}% shows)`)),
      message: `${cut.length} text${cut.length === 1 ? ' is' : 's are'} cut short with "…" here (the worst shows ${r0(cut[0]!.shown * 100)}% of "${cut[0]!.e.text.slice(0, 20)}")`,
      numbers: { cut: cut.length, worstShown: r1(cut[0]!.shown) },
      fix: `give ${cut.length === 1 ? 'it' : 'them'} room (AutomaticSize X, a wider box, a shorter word) or a smaller size on this device; truncate only player-made names`,
    });
  }
  // Size: the em's visual angle against the minimum for its role.
  const small = reads.filter((t) => !t.glyph && t.arc < (t.role === 'body' ? TEXT_MIN.body : TEXT_MIN.label));
  const byRole = new Map<TextRole, TextRead[]>();
  for (const t of small) byRole.set(t.role, [...(byRole.get(t.role) ?? []), t]);
  for (const [role, g] of byRole) {
    g.sort((a, b) => a.arc - b.arc);
    const w = g[0]!;
    const min = role === 'body' ? TEXT_MIN.body : TEXT_MIN.label;
    const minPt = minPoints(min, ctx.viewing);
    add(ctx, {
      severity: w.arc < TEXT_MIN.floor ? 'problem' : 'warning',
      check: 'legibility',
      paths: short(g.map((t) => t.e.path)),
      message: `${g.length === 1 ? `"${w.e.text.slice(0, 24)}"` : `${g.length} ${role} texts`} at ${r1(w.e.b.fontSize)} pt (${r1(ptToMm(w.e.b.fontSize, ctx.viewing))} mm, ${r0(w.arc)}′ at ${ctx.viewing.mm / 10} cm) on a ${ctx.label}: ${role} text needs ${r1(minPt)} pt here`,
      numbers: { pt: r1(w.e.b.fontSize), mm: r1(ptToMm(w.e.b.fontSize, ctx.viewing)), arcmin: r0(w.arc), minPt: r1(minPt) },
      fix: `raise it to ${Math.ceil(minPt / (w.e.b.k || 1))} (design) so it renders at ${Math.ceil(minPt)}+ pt${w.e.n.scaled ? ' (TextScaled shrinks it: give the box more height, or a fixed TextSize)' : ''}`,
    });
  }
  return reads;
}

const minPoints = (arc: number, v: Viewing) => (Math.tan((arc / 60) * (Math.PI / 180)) * v.mm * v.ppi) / 25.4;
/** The text colour moved toward black until it reaches 4.5:1 on `bg`. */
function darker(c: C3, bg: C3): C3 {
  for (let t = 0; t <= 1; t += 0.05) {
    const x = mix(c, [0, 0, 0], t);
    if (ratio01(x, bg) >= 4.5) return x.map((v) => v * 255) as C3;
  }
  return [0, 0, 0];
}
function lighter(c: C3, bg: C3): C3 {
  for (let t = 0; t <= 1; t += 0.05) {
    const x = mix(c, [1, 1, 1], t);
    if (ratio01(x, bg) >= 4.5) return x.map((v) => v * 255) as C3;
  }
  return [255, 255, 255];
}

// Spacing ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A spacing value as typed (design units, before UIScale): a list's or grid's padding, a UIPadding side, an inset
 * from the parent's edge, a gap between two offset-placed siblings, a HUD piece's margin from the screen edge.
 * Values a layout derives (centring, scale, TextBounds) are not the designer's numbers and are left out.
 */
interface Declared {
  kind: 'list' | 'grid' | 'pad' | 'inset' | 'gap' | 'margin';
  value: number;
  container: El | null;
  who: El;
  side: string;
  /** A padding the content reaches (on a side the content doesn't reach, a different value can't be seen). */
  shown?: boolean;
}
interface Row {
  container: El | null;
  axis: 'x' | 'y';
  items: El[];
  gaps: number[];
}

/** Children of a container that take part in its spacing (drawn, upright, not a backdrop). */
const spaced = (els: El[]) => els.filter((e) => e.lay && !e.dim && !e.turned && e.lay.w >= 2 && e.lay.h >= 2);

function rowsOf(items: El[], axis: 'x' | 'y', container: El | null, maxGap: number): Row[] {
  const n = items.length;
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = items[i]!.lay!;
      const b = items[j]!.lay!;
      const across = axis === 'x' ? vOverlap(a, b) / Math.min(a.h, b.h) : hOverlap(a, b) / Math.min(a.w, b.w);
      const along = axis === 'x' ? hOverlap(a, b) : vOverlap(a, b);
      if (across >= 0.5 && along <= 1) parent[find(i)] = find(j);
    }
  const groups = new Map<number, El[]>();
  items.forEach((e, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), e]));
  const rows: Row[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (axis === 'x' ? a.lay!.x - b.lay!.x : a.lay!.y - b.lay!.y));
    const gaps: number[] = [];
    let ok = true;
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1]!.lay!;
      const b = g[i]!.lay!;
      const gap = axis === 'x' ? b.x - (a.x + a.w) : b.y - (a.y + a.h);
      if (gap < -1 || gap > maxGap) ok = false;
      gaps.push(gap);
    }
    if (ok) rows.push({ container, axis, items: g, gaps });
  }
  return rows;
}

/** Placed by offsets alone along an axis (no scale, no anchor, no aspect or automatic size): its numbers are typed. */
function offsetOnly(n: UiNode, axis: 'x' | 'y'): boolean {
  const p = n.pos ?? [0, 0, 0, 0];
  const s = n.size ?? [0, 100, 0, 100];
  if (n.aspect || n.auto === 'XY' || n.auto === (axis === 'x' ? 'X' : 'Y')) return false;
  return axis === 'x' ? p[0] === 0 && s[0] === 0 && (n.anchor?.[0] ?? 0) === 0 : p[2] === 0 && s[2] === 0 && (n.anchor?.[1] ?? 0) === 0;
}

function declared(m: Model, hud: boolean): { values: Declared[]; rows: Row[] } {
  const out: Declared[] = [];
  const rows: Row[] = [];
  const containers: Array<{ c: El | null; kids: El[] }> = [{ c: null, kids: m.tops }, ...m.els.map((c) => ({ c, kids: c.kids }))];
  const half = (v: number) => Math.round(v * 2) / 2;
  for (const { c, kids } of containers) {
    if (c && (c.turned || !c.vis)) continue;
    const items = spaced(kids);
    if (!items.length) continue;
    const mine: Row[] = [];
    for (const axis of ['x', 'y'] as const) {
      const span = c?.lay ?? m.root;
      mine.push(...rowsOf(items, axis, c, Math.min(96, 0.3 * (axis === 'x' ? span.w : span.h))));
    }
    rows.push(...mine);
    const n = c?.n;
    // A mockup may leave a list's or grid's padding at Roblox's default.
    const lpad = n?.list?.pad ?? [0, 0];
    const gpad = n?.grid?.pad ?? [0, 0, 0, 0];
    if (c && n?.list && items.length >= 2 && lpad[0] === 0 && lpad[1] > 0 && !n.list.hFlex && !n.list.vFlex) out.push({ kind: 'list', value: half(lpad[1]), container: c, who: c, side: n.list.dir === 'Horizontal' ? 'x' : 'y' });
    if (c && n?.grid && items.length >= 2) {
      if (gpad[0] === 0 && gpad[1] > 0) out.push({ kind: 'grid', value: half(gpad[1]), container: c, who: c, side: 'x' });
      if (gpad[2] === 0 && gpad[3] > 0) out.push({ kind: 'grid', value: half(gpad[3]), container: c, who: c, side: 'y' });
    }
    if (c && n?.padding && c.vis) {
      const u = items.reduce<R | null>((acc, e) => union(acc, e.lay), null)!;
      const k = c.b.k || 1;
      const box = { x: c.b.x, y: c.b.y, w: c.b.w, h: c.b.h };
      const reach = [u.y - box.y, box.x + box.w - (u.x + u.w), box.y + box.h - (u.y + u.h), u.x - box.x];
      n.padding.forEach((d, i) => {
        if (d[0] === 0 && d[1] > 0 && d[1] <= 64) out.push({ kind: 'pad', value: half(d[1]), container: c, who: c, side: ['top', 'right', 'bottom', 'left'][i]!, shown: Math.abs(reach[i]! - d[1] * k) <= 1 });
      });
    }
    if (n?.list || n?.grid || n?.pages) continue;
    const kind: Declared['kind'] | null = c ? 'inset' : hud ? 'margin' : null;
    if (kind)
      for (const e of items) {
        const p = e.n.pos ?? [0, 0, 0, 0];
        const a = e.n.anchor ?? [0, 0];
        const push = (v: number, side: string) => {
          if (v > 0 && v <= 48) out.push({ kind, value: half(v), container: c, who: e, side });
        };
        if (p[0] === 0 && a[0] === 0) push(p[1], 'left');
        if (p[0] === 1 && a[0] === 1) push(-p[1], 'right');
        if (p[2] === 0 && a[1] === 0) push(p[3], 'top');
        if (p[2] === 1 && a[1] === 1) push(-p[3], 'bottom');
      }
    if (!c) continue;
    for (const row of mine)
      row.gaps.forEach((g, i) => {
        const a = row.items[i]!;
        const b = row.items[i + 1]!;
        if (g < 1 || !a.draws || !b.draws || !offsetOnly(a.n, row.axis) || !offsetOnly(b.n, row.axis)) return;
        const pa = a.n.pos ?? [0, 0, 0, 0];
        const sa = a.n.size ?? [0, 100, 0, 100];
        const pb = b.n.pos ?? [0, 0, 0, 0];
        const v = row.axis === 'x' ? pb[1] - (pa[1] + sa[1]) : pb[3] - (pa[3] + sa[3]);
        if (v > 0 && v <= 64) out.push({ kind: 'gap', value: half(v), container: c, who: b, side: row.axis });
      });
  }
  return { values: out, rows };
}

/** The grid most typed spacing values sit on, and the share on each base. */
export function spacingGrid(values: number[]): { base: number | null; share: Record<number, number>; best4: number } {
  const v = values.filter((x) => x >= 2);
  const share: Record<number, number> = {};
  for (const b of [8, 6, 5, 4, 3, 2]) share[b] = v.length ? v.filter((x) => Math.abs(x / b - Math.round(x / b)) * b <= 0.3).length / v.length : 0;
  const base = v.length < 4 ? null : ([8, 6, 5, 4, 3, 2].find((b) => share[b]! >= 0.85) ?? null);
  return { base, share, best4: Math.max(share[8]!, share[6]!, share[5]!, share[4]!) };
}

interface SpacingResult {
  fixed: number[];
  base: number | null;
  best4: number | null;
  even: number | null;
  nearDup: number;
  /** Near-duplicate typed values in one container whatever their roles (a sloppiness signal for the score, not reported). */
  loose: number;
  uneven: number;
  margins: number;
}

const kindName = (d: Declared) => (d.kind === 'inset' || d.kind === 'margin' ? `${d.side} ${d.kind}` : d.kind === 'pad' ? `padding ${d.side}` : d.kind === 'list' ? 'list padding' : d.kind === 'grid' ? 'grid padding' : 'gap');

function spacing(ctx: Ctx): SpacingResult {
  const hud = ctx.kind === 'hud';
  const { values: all, rows } = declared(ctx.m, hud);
  // Pixel art built from frames (a heart of 6-pt squares) is drawing, not spacing.
  const dec = all.filter((d) => Math.min(d.who.b.w, d.who.b.h) / (d.who.b.k || 1) >= 6);
  // Each value counts once per container and kind: a repeated card doesn't outvote the rest.
  const values = [...new Map(dec.map((d) => [`${d.container?.n.id ?? 0}|${d.kind}|${d.value}`, d.value])).values()];
  const grid = spacingGrid(values);
  const big = values.filter((v) => v >= 2);
  const res: SpacingResult = { fixed: values, base: grid.base, best4: big.length >= 4 ? grid.best4 : null, even: big.length >= 4 ? grid.share[2]! : null, nearDup: 0, loose: 0, uneven: 0, margins: 0 };
  const step = grid.base && grid.base >= 4 ? grid.base : 4;
  const onGrid = (v: number) => step * Math.max(1, Math.round(v / step));

  // Repeated items in a row (same size) spaced unevenly, as rendered.
  for (const row of rows) {
    if (row.items.length < 3) continue;
    const c = row.container?.n;
    if (c && (c.grid || (c.list && !c.list.hFlex && !c.list.vFlex && !c.list.wraps))) continue;
    const ws = row.items.map((e) => e.lay!.w);
    const hs = row.items.map((e) => e.lay!.h);
    const similar = (v: number[]) => Math.max(...v) <= 1.12 * Math.min(...v);
    if (!similar(ws) || !similar(hs)) continue;
    const gs = row.gaps;
    if (gs.some((g) => g < 1)) continue;
    const spread = Math.max(...gs) - Math.min(...gs);
    const mid = median(gs);
    if (spread <= Math.max(2, 0.15 * mid)) continue;
    res.uneven++;
    const k = row.items[0]!.b.k || 1;
    add(ctx, {
      severity: 'warning',
      check: 'spacing',
      paths: short(row.items.map((e) => e.path)),
      message: `${row.items.length} matching items in a ${row.axis === 'x' ? 'row' : 'column'} spaced unevenly: gaps ${gs.map(r0).join(', ')} pt`,
      numbers: { gaps: gs.map(r1), median: r1(mid) },
      fix: `use one gap, ${onGrid(mid / k)} (design), between all of them (a UIListLayout with Padding ${onGrid(mid / k)} keeps it even)`,
    });
  }
  {
    const byC = new Map<El | null, number[]>();
    for (const d of dec) if (d.kind !== 'margin') byC.set(d.container, [...(byC.get(d.container) ?? []), d.value]);
    for (const vals of byC.values()) {
      const u = [...new Set(vals)].sort((a, b) => a - b);
      for (let i = 1; i < u.length; i++) if (u[i]! <= 40 && u[i]! - u[i - 1]! >= 0.75 && u[i]! - u[i - 1]! <= Math.max(1.01, 0.13 * u[i]!)) res.loose++;
    }
  }
  // Near-duplicate typed values of one role side by side (11 and 12): gaps among gaps, paddings among paddings, and
  // an element's own insets into a corner (14 from the top, 16 from the right). Insets of different elements on one
  // side are alignment's business; a gap against a padding are two roles.
  const byRole = new Map<string, { c: El | null; list: Declared[] }>();
  const put = (key: string, c: El | null, d: Declared) => {
    const g = byRole.get(key) ?? { c, list: [] };
    g.list.push(d);
    byRole.set(key, g);
  };
  for (const d of dec) {
    const id = d.container?.n.id ?? 0;
    if (d.kind === 'list' || d.kind === 'grid' || d.kind === 'gap') put(`gap:${id}`, d.container, d);
    else if (d.kind === 'pad' && d.shown && (d.side === 'left' || d.side === 'right')) put(`pad:${id}`, d.container, d);
    else if (d.kind === 'inset') put(`corner:${d.who.n.id}`, d.container, d);
  }
  for (const { c, list } of byRole.values()) {
    if (list[0]!.kind === 'inset' && new Set(list.map((d) => d.side === 'left' || d.side === 'right')).size < 2) continue;
    const k = (c ?? list[0]!.who).b.k || 1;
    const vals = [...new Set(list.map((d) => d.value))].sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i++) {
      const a = vals[i - 1]!;
      const b = vals[i]!;
      if (b > 40 || b - a < 0.75 || b - a > Math.max(1.01, 0.13 * b) || (b - a) * k < 0.9) continue;
      const users = list.filter((d) => d.value === a || d.value === b);
      if (list[0]!.kind === 'inset' && new Set(users.map((d) => d.side === 'left' || d.side === 'right')).size < 2) continue;
      const keep = [a, b].find((v) => v % 4 === 0) ?? [a, b].find((v) => v % 2 === 0) ?? b;
      res.nearDup++;
      add(ctx, {
        severity: list[0]!.kind === 'inset' ? 'note' : 'warning',
        check: 'spacing',
        paths: short([...new Set(users.map((d) => `${d.who.path} (${kindName(d)} ${d.value})`))]),
        message:
          list[0]!.kind === 'inset'
            ? `${name(list[0]!.who)} sits ${users.map((d) => `${d.value} from the ${d.side}`).join(' and ')} (design) of its corner in ${c?.path ?? ctx.view.name}`
            : `near-duplicate ${list[0]!.kind === 'pad' ? 'paddings' : 'gaps'} in ${c ? c.path : 'the screen'}: ${a} and ${b} (design) side by side`,
        numbers: { values: [a, b], container: c?.path ?? ctx.view.name },
        fix: `use ${keep} for both`,
      });
    }
  }
  // No grid at all: many typed values that are odd or fractional.
  if (res.even !== null && big.length >= 6 && res.even < 0.7) {
    const off = [...new Set(big.filter((v) => Math.abs(v / 2 - Math.round(v / 2)) * 2 > 0.3))].sort((a, b) => a - b);
    add(ctx, {
      severity: 'note',
      check: 'spacing',
      paths: short([...new Set(dec.filter((d) => off.includes(d.value)).map((d) => `${d.who.path} (${kindName(d)} ${d.value})`))]),
      message: `spacing follows no grid: ${r0((1 - res.even) * 100)}% of ${big.length} typed gaps, paddings and insets are odd or fractional (${off.slice(0, 8).join(', ')})`,
      numbers: { even: r1(res.even), on4: r1(grid.best4), off: off.slice(0, 12) },
      fix: `snap spacing to the 4-pt scale (4, 8, 12, 16, 24, 32): ${off
        .slice(0, 4)
        .map((v) => `${v}→${Math.max(4, Math.round(v / 4) * 4)}`)
        .join(', ')}`,
    });
  }
  // A HUD's pieces set different distances from the same pair of screen edges (10 and 16 from the sides).
  if (hud) {
    const ms = dec.filter((d) => d.kind === 'margin');
    for (const axis of [
      ['left', 'right'],
      ['top', 'bottom'],
    ]) {
      const list = ms.filter((d) => axis.includes(d.side) && d.value >= 2);
      const vals = [...new Set(list.map((d) => d.value))].sort((a, b) => a - b);
      if (vals.length < 2) continue;
      const lo = vals[0]!;
      const hi = vals[vals.length - 1]!;
      if (hi - lo < 3 || hi > 40 || hi > 2 * lo) continue;
      res.margins++;
      add(ctx, {
        severity: 'note',
        check: 'spacing',
        paths: short(list.map((d) => `${d.who.path} (${d.side} ${d.value})`)),
        message: `HUD pieces sit ${vals.join(', ')} (design) from the ${axis.join('/')} screen edges`,
        numbers: { margins: vals },
        fix: `use one edge margin (${onGrid(median(vals))}) for every corner piece`,
      });
    }
  }
  return res;
}

// Alignment ────────────────────────────────────────────────────────────────────────────────────────

type Edge = 'left' | 'cx' | 'right' | 'top' | 'cy' | 'bottom';
function edgesOf(e: El): Partial<Record<Edge, number>> {
  const textOnly = !!e.text && e.fillA <= 0.05 && !e.image && !e.border;
  if (textOnly) {
    const l = e.lines;
    if (!l.length) return {};
    const out: Partial<Record<Edge, number>> = {};
    const xa = e.n.xAlign ?? 'Center';
    if (xa === 'Left') out.left = Math.min(...l.map((r) => r.x));
    else if (xa === 'Right') out.right = Math.max(...l.map((r) => r.x + r.w));
    else out.cx = l[0]!.x + l[0]!.w / 2;
    // Capitals sit centred on each line: the middle is halfway between the first and last lines' cap centres.
    const cap = 0.37 * e.b.fontSize;
    if ((e.n.yAlign ?? 'Center') === 'Center') out.cy = (l[0]!.y + l[l.length - 1]!.y) / 2 + cap;
    return out;
  }
  const r = e.vis!;
  return { left: r.x, cx: r.x + r.w / 2, right: r.x + r.w, top: r.y, cy: r.y + r.h / 2, bottom: r.y + r.h };
}

const nested = (a: El, b: El) => {
  for (let x: El | null = a.parent; x; x = x.parent) if (x === b) return true;
  for (let x: El | null = b.parent; x; x = x.parent) if (x === a) return true;
  return false;
};

function alignment(ctx: Ctx): { nearMiss: number; checked: number } {
  // Groups: everything inside one top-level window (or the screen for a HUD), outside buttons.
  const groupOf = (e: El): El | null => {
    let top: El | null = null;
    for (let x: El | null = e.parent; x; x = x.parent) if (x.draws && !x.dim) top = x;
    return top;
  };
  // Blocks: drawn, upright, outside buttons and illustrations, big enough to be seen as a block (no rivets or lips).
  const items = ctx.m.els.filter((e) => e.draws && e.vis && !e.dim && !e.turned && !e.inButton && !e.art && Math.min(e.vis.w, e.vis.h) >= 6 && area(e.vis) >= 150);
  const groups = new Map<El | null, El[]>();
  for (const e of items) groups.set(groupOf(e), [...(groups.get(groupOf(e)) ?? []), e]);
  let nearMiss = 0;
  const reported = new Set<El>();
  const AXES: Array<{ vertical: boolean; edges: Edge[] }> = [
    { vertical: true, edges: ['left', 'cx', 'right'] },
    { vertical: false, edges: ['top', 'cy', 'bottom'] },
  ];
  // Stacked near each other: one above the other for a vertical line, side by side for a horizontal one.
  // Edges known to a point: a filled box's. Text (side bearings, the estimate) and images (transparent margins) are
  // known to two or three, so a near-miss involving one must be bigger to count.
  const loose = (e: El) => (!!e.text && e.fillA <= 0.05) || (e.image && e.fillA <= 0.05);
  // An element inside a block is placed by that block: comparing it with the block's siblings is padding, not alignment.
  const uncle = (a: El, b: El) => (!!a.parent && a.parent.parent === b.parent) || (!!b.parent && b.parent.parent === a.parent);
  // Across the cards of a list or grid, only the same slot of the template is comparable (Name with Name).
  const lca = (a: El, b: El): El | null => {
    const up = new Set<El>();
    for (let x: El | null = a.parent; x; x = x.parent) up.add(x);
    for (let x: El | null = b.parent; x; x = x.parent) if (up.has(x)) return x;
    return null;
  };
  const otherSlot = (a: El, b: El) => {
    const c = lca(a, b);
    return !!c && !!(c.n.list || c.n.grid) && a.parent !== c && b.parent !== c && a.n.name !== b.n.name;
  };
  const stackedNear = (a: El, b: El, vertical: boolean) => {
    if (nested(a, b) || uncle(a, b) || otherSlot(a, b)) return false;
    const r = a.vis!;
    const q = b.vis!;
    if (vertical) {
      if (vOverlap(r, q) > 0) return false;
      return Math.max(q.y - (r.y + r.h), r.y - (q.y + q.h)) <= Math.max(24, 1.5 * Math.min(r.h, q.h));
    }
    if (hOverlap(r, q) > 0) return false;
    return Math.max(q.x - (r.x + r.w), r.x - (q.x + q.w)) <= Math.max(24, 1.5 * Math.min(r.w, q.w));
  };
  for (const [, list] of groups) {
    if (list.length < 3) continue;
    const edges = list.map((e) => ({ e, ed: edgesOf(e) }));
    for (const axis of AXES) {
      // Exact lines per edge: members within 0.6 pt, at least two that aren't nested in each other.
      const linesOf = new Map<Edge, Array<{ v: number; members: El[] }>>();
      const aligned = new Set<El>();
      for (const edge of axis.edges) {
        const have = edges.filter((x) => x.ed[edge] !== undefined).map((x) => ({ e: x.e, v: x.ed[edge]! }));
        const lines: Array<{ v: number; members: El[] }> = [];
        const sorted = [...have].sort((a, b) => a.v - b.v);
        let cur: typeof sorted = [];
        const close = () => {
          const free = cur.filter((c) => !cur.some((o) => o !== c && nested(o.e, c.e)));
          if (free.length >= 2) {
            lines.push({ v: median(cur.map((c) => c.v)), members: cur.map((c) => c.e) });
            for (const c of cur) aligned.add(c.e);
          }
          cur = [];
        };
        for (const h of sorted) {
          if (cur.length && h.v - cur[cur.length - 1]!.v > 0.6) close();
          cur.push(h);
        }
        close();
        linesOf.set(edge, lines);
      }
      for (const edge of axis.edges) {
        for (const x of edges) {
          const v = x.ed[edge];
          const e = x.e;
          // Aligned on this axis some way already (its centre with others, say): not a near-miss.
          if (v === undefined || aligned.has(e) || reported.has(e)) continue;
          for (const line of linesOf.get(edge)!) {
            const d = Math.abs(v - line.v);
            if (d < 1.5 || d > 4.5) continue;
            const others = line.members.filter((m) => !nested(m, e));
            const near = others.filter((m) => stackedNear(e, m, axis.vertical));
            if (others.length < 2 || !near.length) continue;
            // Centres of big things are judged in proportion (2 pt off the middle of a 70-pt disc doesn't show).
            const centre = edge === 'cx' || edge === 'cy';
            const span = (x: El) => (axis.vertical ? x.vis!.w : x.vis!.h);
            const lo = Math.max(loose(e) || near.some(loose) ? 2.5 : 1.5, centre ? 0.04 * Math.max(span(e), ...near.map(span)) : 0);
            if (d < lo) continue;
            nearMiss++;
            reported.add(e);
            const dir = axis.vertical ? (v > line.v ? 'right' : 'left') : v > line.v ? 'down' : 'up';
            const k = e.b.k || 1;
            add(ctx, {
              severity: 'warning',
              check: 'alignment',
              paths: [e.path, ...short(others.map((m) => m.path), 3)],
              message: `${name(e)}'s ${edge === 'cx' ? 'centre' : edge === 'cy' ? 'middle' : `${edge} edge`} is ${r1(d)} pt ${dir} of the line ${others.length} neighbours share (${axis.vertical ? 'x' : 'y'} = ${r1(line.v)})`,
              numbers: { off: r1(d), line: r1(line.v), at: r1(v) },
              fix: `move ${name(e)} ${r1(d / k)} (design) ${dir === 'right' ? 'left' : dir === 'left' ? 'right' : dir === 'down' ? 'up' : 'down'} onto the line`,
            });
            break;
          }
        }
      }
    }
  }
  return { nearMiss, checked: items.length };
}

// Type ─────────────────────────────────────────────────────────────────────────────────────────────

/** Faces made for titles and logos (wide, thin, novelty, pixel): fine big, hard to read at label sizes. */
const DISPLAY_FACES = /^(Michroma|Jura|Bangers|Creepster|PermanentMarker|IndieFlower|Arcade|Highway|SpecialElite|Antique|Fantasy|SciFi|Cartoon|Zekton|Orbitron|GrenzeGotisch|Grenze|RomanAntique|Fondamento|Kalam|Sarpanch)$/i;

const family = (f: string | undefined) => (f ?? 'Default').replace(/(Extra|Semi|Ultra)?(Bold|Light|Black|Heavy|Medium|Regular|Thin|Italic|Condensed)+$/i, '') || 'Default';

function typeScale(ctx: Ctx, all: El[]): { sizes: number[]; fonts: string[]; scaledSpread: number; nearDup: number } {
  // Glyphs set as text (an "X", a "+", emoji) are icons, not type.
  const texts = all.filter((e) => !glyphText(e.text));
  const sizes: number[] = [];
  for (const s of texts.map((e) => e.b.fontSize).sort((a, b) => a - b)) if (!sizes.length || s - sizes[sizes.length - 1]! > 0.75) sizes.push(r1(s));
  const fonts = [...new Set(texts.map((e) => family(e.n.font)))];
  // A monospaced face for timers and numbers is a role, not a third voice.
  const voices = fonts.filter((f) => f !== 'Default' && !/mono|code|courier|inconsolata/i.test(f));
  let scaledSpread = 0;
  let nearDup = 0;
  if (sizes.length > 7)
    add(ctx, {
      severity: sizes.length > 10 ? 'problem' : 'warning',
      check: 'type',
      paths: [],
      message: `${sizes.length} text sizes on one screen (${sizes.join(', ')} pt): a type scale has 4-6`,
      numbers: { sizes },
      fix: `map them onto a scale (display, title, heading, body, label, caption), e.g. ${scaleFor(sizes).join(' / ')} pt`,
    });
  // A display face (wide, thin or novelty) at label sizes reads poorly; blind judges marked a screen with every label
  // in one thin display font "a stock template" with "poor contrast".
  const display = texts.filter((e) => DISPLAY_FACES.test(family(e.n.font)) && e.b.fontSize > 0 && e.b.fontSize < 20 && e.text.length > 2);
  if (display.length >= 2) {
    const faces = [...new Set(display.map((e) => family(e.n.font)))];
    add(ctx, {
      severity: 'warning',
      check: 'type',
      paths: display.slice(0, 6).map((e) => e.path),
      message: `${display.length} labels under 20 pt in ${faces.join(', ')} — a display face, hard to read small`,
      numbers: { labels: display.length },
      fix: `set labels in a readable body face (BuilderSans, Montserrat, Nunito, GothamSSm) at weight 600-800; keep ${faces[0]} for titles, buttons and big numbers`,
    });
  }
  // Near-duplicate fixed sizes in one window: 14 and 15 read as a mistake, not as two levels.
  const groupOf = (e: El): El | null => {
    let top: El | null = null;
    for (let x: El | null = e.parent; x; x = x.parent) if (x.draws && !x.dim) top = x;
    return top;
  };
  const byGroup = new Map<El | null, El[]>();
  for (const e of texts) if (!e.n.scaled && !e.n.textMax) byGroup.set(groupOf(e), [...(byGroup.get(groupOf(e)) ?? []), e]);
  for (const [g, list] of byGroup) {
    const s = [...new Set(list.map((e) => r1(e.b.fontSize)))].sort((a, b) => a - b);
    // Chains of sizes each within 8% of the next (28, 30, 32 is one chain).
    const chains: number[][] = [];
    for (const v of s) {
      const last = chains[chains.length - 1];
      if (last && v - last[last.length - 1]! >= 0.9 && v / last[last.length - 1]! <= 1.08) last.push(v);
      else if (last && v - last[last.length - 1]! < 0.9) continue;
      else chains.push([v]);
    }
    for (const chain of chains) {
      if (chain.length < 2) continue;
      nearDup++;
      const users = list.filter((e) => chain.includes(r1(e.b.fontSize)));
      const k = users[0]!.b.k || 1;
      const design = chain.map((v) => r0(v / k));
      add(ctx, {
        severity: 'warning',
        check: 'type',
        paths: short(users.map((e) => `${e.path} (${r1(e.b.fontSize)})`)),
        message: `text sizes ${chain.join(', ')} pt side by side in ${g?.path ?? ctx.view.name}: too close to read as ${chain.length} levels`,
        numbers: { sizes: chain, design },
        fix: `use one size (${design[design.length - 1]} design) for all of them, or keep ${design.length > 2 ? 'two' : 'both'} at least 1.2× apart (${design[0]} and ${r0(design[0]! * 1.25)})`,
      });
    }
  }
  // TextScaled labels in one group rendering at different sizes.
  const groups = new Map<string, El[]>();
  for (const e of texts) {
    if (!e.n.scaled || !e.parent) continue;
    const gp = e.parent.parent;
    const sib = `s:${e.parent.n.id}:${e.n.cls}`;
    groups.set(sib, [...(groups.get(sib) ?? []), e]);
    if (gp) {
      const cousin = `c:${gp.n.id}:${e.n.name}`;
      groups.set(cousin, [...(groups.get(cousin) ?? []), e]);
    }
  }
  const seen = new Set<string>();
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    // Siblings only when their boxes match in height (the same role).
    const mh = median(list.map((x) => x.b.h));
    const mw = median(list.map((x) => x.b.w));
    const sized = key.startsWith('s:') ? list.filter((e) => Math.abs(e.b.h - mh) <= 0.15 * mh && Math.abs(e.b.w - mw) <= 0.15 * mw) : list;
    // One role: a label beside its number ("LOBBY" over "0:15") is a hierarchy, not a mismatch.
    const roleOfText = (e: El) => textRole(e.text, 1);
    const g = sized.filter((e) => roleOfText(e) === roleOfText(sized[0]!));
    if (g.length < 2) continue;
    const fs = g.map((e) => e.b.fontSize);
    const lo = Math.min(...fs);
    const hi = Math.max(...fs);
    if (hi / lo < 1.15 || hi - lo < 2) continue;
    const id = g
      .map((e) => e.n.id)
      .sort()
      .join(',');
    if (seen.has(id)) continue;
    seen.add(id);
    scaledSpread++;
    const target = Math.floor(lo / (g[0]!.b.k || 1));
    add(ctx, {
      severity: 'warning',
      check: 'type',
      paths: short(g.map((e) => `${e.path} (${r1(e.b.fontSize)})`)),
      message: `${g.length} TextScaled labels of one kind render at ${r1(lo)}-${r1(hi)} pt (each fits its own text): a classic amateur tell`,
      numbers: { min: r1(lo), max: r1(hi), sizes: fs.map(r1) },
      fix: `give them one fixed TextSize (${target} design) instead of TextScaled, or a UITextSizeConstraint MaxTextSize ${target} on each`,
    });
  }
  if (voices.length >= 3) {
    // The faces by how much text they set: keep the two that carry the most.
    const use = (f: string) => texts.filter((e) => family(e.n.font) === f).length;
    const ranked = [...voices].sort((a, b) => use(b) - use(a));
    add(ctx, {
      severity: voices.length >= 4 ? 'warning' : 'note',
      check: 'type',
      paths: short(ranked.map((f) => `${texts.find((e) => family(e.n.font) === f)!.path} (${f})`)),
      message: `${voices.length} font families (${ranked.join(', ')}): one body face and one display face read as a system`,
      numbers: { fonts: ranked },
      fix: `keep ${ranked.slice(0, 2).join(' and ')}; set ${ranked.slice(2).join(', ')} in one of them`,
    });
  }
  return { sizes, fonts, scaledSpread, nearDup };
}

/** A modular scale near the sizes in use (ratio about 1.25). */
function scaleFor(sizes: number[]): number[] {
  const base = Math.max(10, Math.round(median(sizes)));
  const out = new Set<number>();
  for (const step of [-2, -1, 0, 1, 2, 3]) out.add(Math.round(base * 1.25 ** step));
  return [...out].sort((a, b) => a - b);
}

// Colour ───────────────────────────────────────────────────────────────────────────────────────────

function colour(ctx: Ctx): { palette: number; accents: number; clashes: number } {
  const samples: Array<{ c: C3; w: number; path: string; fill: boolean }> = [];
  const view = area(ctx.m.root);
  for (const e of ctx.m.els) {
    if (!e.vis || e.turned || e.art) continue;
    if (e.fillA > 0.25 && e.n.bg && !e.dim) {
      const base = c01(e.n.bg);
      const cols = e.n.gradient?.colors.length ? e.n.gradient.colors.map(([, r, g, b]) => [base[0] * (r / 255), base[1] * (g / 255), base[2] * (b / 255)] as C3) : [base];
      for (const c of cols) samples.push({ c, w: (area(e.vis) * e.fillA) / cols.length, path: e.path, fill: true });
    }
    if (e.text) samples.push({ c: c01(e.n.textColor ?? [0, 0, 0]), w: e.lines.reduce((t, l) => t + area(l), 0) * 0.5, path: e.path, fill: false });
    for (const s of borderStrokes(e.n)) samples.push({ c: c01(s.color), w: 2 * (e.vis.w + e.vis.h) * s.px * (1 - s.t), path: e.path, fill: false });
  }
  const total = samples.reduce((t, s) => t + s.w, 0) || 1;
  // Clusters within ΔE 10.
  const clusters: Array<{ c: C3; w: number; paths: Set<string>; lc: ReturnType<typeof lch> }> = [];
  for (const s of [...samples].sort((a, b) => b.w - a.w)) {
    const hit = clusters.find((k) => deltaE(k.c, s.c) <= 10);
    if (hit) {
      hit.w += s.w;
      hit.paths.add(s.path);
    } else clusters.push({ c: s.c, w: s.w, paths: new Set([s.path]), lc: lch(s.c) });
  }
  const palette = clusters.filter((k) => k.w / total >= 0.005 || k.paths.size >= 3);
  // Accents: saturated colours, by hue.
  // Imagery isn't chrome: a gradient across several hues (a rainbow trail swatch) shows a product, not an accent.
  const imagery = new Set(ctx.m.els.filter((e) => (e.n.gradient?.colors.length ?? 0) >= 3).map((e) => e.path));
  // A colour picker's swatches are content too: four or more same-size fills of different hues under one parent.
  for (const p of ctx.m.els) {
    const sw = p.kids.filter((k) => k.fillA > 0.5 && k.n.bg && !k.text && k.vis);
    if (sw.length < 4) continue;
    const s0 = sw[0]!.vis!;
    const same = sw.filter((k) => Math.abs(k.vis!.w - s0.w) <= 0.15 * s0.w && Math.abs(k.vis!.h - s0.h) <= 0.15 * s0.h);
    if (same.length >= 4 && new Set(same.map((k) => hueName(lch(c01(k.n.bg!)).h))).size >= 4) for (const k of same) imagery.add(k.path);
  }
  const accent = palette.filter((k) => k.lc.C >= 30 && k.lc.L >= 25 && k.lc.L <= 95 && [...k.paths].some((p) => !imagery.has(p)));
  const hues: Array<{ h: number; w: number; paths: Set<string> }> = [];
  for (const k of [...accent].sort((a, b) => b.w - a.w)) {
    const hit = hues.find((x) => hueGap(x.h, k.lc.h) <= 25);
    if (hit) {
      hit.w += k.w;
      for (const p of k.paths) hit.paths.add(p);
    } else hues.push({ h: k.lc.h, w: k.w, paths: new Set(k.paths) });
  }
  const accents = hues.filter((x) => x.w / total >= 0.01 || x.paths.size >= 2);
  if (accents.length >= 6)
    add(ctx, {
      severity: 'note',
      check: 'color',
      paths: short(accents.map((x) => `${[...x.paths][0]} (${hueName(x.h)})`)),
      message: `${accents.length} accent hues (${accents.map((x) => hueName(x.h)).join(', ')}) compete: one accent for the primary action reads as designed`,
      numbers: { accents: accents.length, palette: palette.length },
      fix: `keep ${hueName(accents[0]!.h)} as the accent and move the others to neutrals (keep red/green only where they mean danger/success)`,
    });
  // Clashes: a saturated fill on a saturated fill of a far hue at the same lightness (the edge vibrates).
  let clashes = 0;
  for (const e of ctx.m.els) {
    if (!e.vis || e.turned || e.fillA < 0.7 || !e.n.bg || e.n.gradient) continue;
    let p: El | null = e.parent;
    while (p && !(p.fillA >= 0.7 && p.n.bg)) p = p.parent;
    if (!p || p.n.gradient || area(e.vis) < 0.02 * area(p.vis)) continue;
    const a = lch(c01(e.n.bg));
    const b = lch(c01(p.n.bg!));
    if (a.C < 40 || b.C < 40 || hueGap(a.h, b.h) < 100 || Math.abs(a.L - b.L) > 12) continue;
    clashes++;
    add(ctx, {
      severity: 'warning',
      check: 'color',
      paths: [e.path, p.path],
      message: `${hex(e.n.bg)} (${hueName(a.h)}) on ${hex(p.n.bg!)} (${hueName(b.h)}): two saturated colours of equal lightness (L ${r0(a.L)} / ${r0(b.L)}) vibrate at the edge`,
      numbers: { hueGap: r0(hueGap(a.h, b.h)), L: [r0(a.L), r0(b.L)] },
      fix: `darken one of them by 20+ L (e.g. the panel to ${hex(darkenL(c01(p.n.bg!), 25))}) or add a dark stroke between them`,
    });
  }
  // The dated look: flat mid-grey panels with square corners (a 2016 developer's UI).
  const panels = ctx.m.els.filter((e) => e.vis && !e.dim && !e.art && e.fillA >= 0.6 && e.n.bg && area(e.vis) >= 0.02 * view);
  const greyArea = panels.filter((e) => {
    const c = lch(c01(e.n.bg!));
    return c.C < 6 && c.L >= 40 && c.L <= 85 && !e.n.gradient;
  });
  const panelArea = panels.reduce((t, e) => t + area(e.vis), 0);
  if (panels.length >= 3 && greyArea.reduce((t, e) => t + area(e.vis), 0) >= 0.5 * panelArea && !panels.some((e) => radiusOf(e) !== null))
    add(ctx, {
      severity: 'problem',
      check: 'color',
      paths: short(greyArea.map((e) => `${e.path} (${hex(e.n.bg!)})`)),
      message: `flat mid-grey panels with square corners (${greyArea.length} of ${panels.length} panels, ${[...new Set(greyArea.map((e) => hex(e.n.bg!)))].slice(0, 3).join(', ')}): reads as a placeholder developer UI (a retro look wants texture: a 9-sliced stone or pixel image, not a flat fill)`,
      numbers: { grey: greyArea.length, panels: panels.length },
      fix: 'pick a palette (roblox-ui-references section 3): a dark or light surface with one accent, UICorner 8-12 on panels and buttons, and a hairline Inner UIStroke',
    });
  // Large pure black or white fills.
  for (const e of ctx.m.els) {
    if (!e.vis || e.dim || !e.n.bg || e.fillA < 0.9 || e.n.gradient) continue;
    const pure = e.n.bg.every((v) => v === 0) ? '#000000' : e.n.bg.every((v) => v === 255) ? '#FFFFFF' : null;
    // A mask (a scope's black surround) is meant to be black: only panels that hold content count.
    if (!pure || area(e.vis) < 0.08 * view || e.kids.filter((k) => k.draws).length < 2) continue;
    add(ctx, {
      severity: 'note',
      check: 'color',
      paths: [e.path],
      message: `a pure ${pure} fill over ${r0((100 * area(e.vis)) / view)}% of the screen`,
      numbers: { share: r1(area(e.vis) / view) },
      fix: pure === '#000000' ? 'use the palette’s near-black (e.g. #11151C) so the panel has depth' : 'use an off-white surface (e.g. #F4F1EA) so it doesn’t glare',
    });
  }
  // Gradients: far hues on one element.
  for (const e of ctx.m.els) {
    const g = e.n.gradient;
    // Three or more keys is imagery (a trail swatch, a rarity sheen); a two-key gradient across far hues is styling.
    if (!g || !e.vis || g.colors.length !== 2 || area(e.vis) < 0.01 * view || (e.fillA < 0.3 && !e.image)) continue;
    const base = c01(e.n.bg ?? [255, 255, 255]);
    const cs = g.colors.map(([, r, gg, b]) => lch([base[0] * (r / 255), base[1] * (gg / 255), base[2] * (b / 255)]));
    const sat = cs.filter((c) => c.C >= 35);
    let spread = 0;
    for (const a of sat) for (const b of sat) spread = Math.max(spread, hueGap(a.h, b.h));
    if (spread < 120) continue;
    add(ctx, {
      severity: 'warning',
      check: 'color',
      paths: [e.path],
      message: `a gradient across ${r0(spread)}° of hue (${sat.map((c) => hueName(c.h)).join(' → ')}) on ${r0((100 * area(e.vis)) / view)}% of the screen`,
      numbers: { hueSpread: r0(spread) },
      fix: 'shade with one hue (white to 85% grey over the fill, rotation 90); keep rainbow for the top rarity only',
    });
  }
  // Buttons that say the same thing in different saturated colours.
  const buttons = ctx.m.els.filter((e) => isButton(e.n) && e.n.cls !== 'TextBox' && e.vis && !e.dim);
  const byLabel = new Map<string, El[]>();
  for (const b of buttons) {
    const label = labelOf(b)
      .toLowerCase()
      .replace(/[\d.,$€£¥%+x×:]+/g, '')
      .trim();
    if (!label || label.length > 24) continue;
    byLabel.set(label, [...(byLabel.get(label) ?? []), b]);
  }
  for (const [label, list] of byLabel) {
    const coloured = list.map((b) => ({ b, c: bodyColour(b) })).filter((x): x is { b: El; c: C3 } => !!x.c && lch(x.c).C >= 30);
    if (coloured.length < 2) continue;
    const ref = coloured[0]!;
    const off = coloured.find((x) => hueGap(lch(x.c).h, lch(ref.c).h) > 40);
    if (!off) continue;
    add(ctx, {
      severity: 'warning',
      check: 'color',
      paths: [ref.b.path, off.b.path],
      message: `"${label}" buttons in two colours: ${hex(ref.c.map((v) => v * 255) as RGB)} and ${hex(off.c.map((v) => v * 255) as RGB)}`,
      numbers: { hueGap: r0(hueGap(lch(off.c).h, lch(ref.c).h)) },
      fix: `give every "${label}" button the same role colour (${hex(ref.c.map((v) => v * 255) as RGB)}); show a state (owned, can't afford) with grey, not another hue`,
    });
  }
  return { palette: palette.length, accents: accents.length, clashes };
}

const darkenL = (c: C3, by: number): RGB => {
  for (let t = 0; t <= 1; t += 0.05) {
    const x = mix(c, [0, 0, 0], t);
    if (lch(c).L - lch(x).L >= by) return x.map((v) => v * 255) as RGB;
  }
  return [0, 0, 0];
};

// Hierarchy ────────────────────────────────────────────────────────────────────────────────────────

function labelOf(b: El): string {
  if (b.text) return b.text;
  const t: string[] = [];
  const walk = (e: El) => {
    if (e.text && t.length < 2) t.push(e.text);
    for (const k of e.kids) walk(k);
  };
  walk(b);
  return t.join(' ');
}

/** What a button looks like: its own fill, else its parent's when it covers it, else its biggest filled child. */
function bodyOf(b: El): El {
  if (b.fillA > 0.3 || b.image) return b;
  const p = b.parent;
  if (p && p.vis && b.vis && (p.fillA > 0.3 || p.image) && area(inter(p.vis, b.vis)) >= 0.8 * Math.max(area(p.vis), area(b.vis))) return p;
  const kid = b.kids.filter((k) => (k.fillA > 0.3 || k.image) && k.vis && b.vis && area(k.vis) >= 0.6 * area(b.vis)).sort((x, y) => area(y.vis) - area(x.vis))[0];
  return kid ?? b;
}
function bodyColour(b: El): C3 | null {
  const body = bodyOf(b);
  if (!body.n.bg || body.fillA < 0.3) return null;
  const c = c01(body.n.bg);
  const g = body.n.gradient?.colors;
  return g?.length ? meanColour(g.map(([, r, gg, bb]) => [(c[0] * r) / 255, (c[1] * gg) / 255, (c[2] * bb) / 255] as C3)) : c;
}

interface Salience {
  fill: C3 | null;
  e: El;
  s: number;
  size: number;
  contrast: number;
  chroma: number;
}

function salienceOf(ctx: Ctx, b: El): Salience {
  const body = bodyOf(b);
  const r = body.vis ?? b.vis!;
  let fill: C3 | null = null;
  let ring: C3 | null = null;
  let contrast = 1;
  if (ctx.layer) {
    const pad = 4;
    const inner = pixelsIn(ctx.layer, { x: r.x + r.w * 0.15, y: r.y + r.h * 0.15, w: r.w * 0.7, h: r.h * 0.7 }, 300);
    const outer = [
      { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: pad },
      { x: r.x - pad, y: r.y + r.h, w: r.w + 2 * pad, h: pad },
      { x: r.x - pad, y: r.y, w: pad, h: r.h },
      { x: r.x + r.w, y: r.y, w: pad, h: r.h },
    ].flatMap((q) => pixelsIn(ctx.layer!, q, 80));
    const cs: number[] = [];
    for (const { px } of ctx.backdrops) {
      const f = meanColour(inner.map((i) => composite(ctx.layer!, px, i)));
      const o = meanColour(outer.map((i) => composite(ctx.layer!, px, i)));
      cs.push(ratio01(f, o));
      fill ??= f;
      ring ??= o;
    }
    contrast = cs.length ? cs.reduce((t, v) => t + v, 0) / cs.length : 1;
  } else {
    fill = bodyColour(b);
    let p = body.parent;
    while (p && !(p.fillA >= 0.5 && p.n.bg)) p = p.parent;
    ring = p?.n.bg ? c01(p.n.bg) : [0.4, 0.5, 0.6];
    contrast = fill ? ratio01(fill, ring) : 1;
  }
  const chroma = fill ? lch(fill).C : 0;
  const size = Math.sqrt(area(r));
  // Size × (luminance contrast with what surrounds it) × (colourfulness).
  const s = size * (1 + Math.log2(Math.max(1, contrast))) * (1 + Math.min(1, chroma / 70));
  return { e: b, s, size, contrast, chroma, fill };
}

function hierarchy(ctx: Ctx): { judged: boolean; outshone: number; flat: number } {
  const buttons = ctx.m.els.filter((e) => isButton(e.n) && e.n.cls !== 'TextBox' && e.vis && !e.dim && !e.turned && area(e.vis) < 0.3 * area(ctx.m.root) && Math.min(e.vis.w, e.vis.h) >= 12 && !e.inButton);
  // Decision groups: buttons inside the same top-level window.
  const groupOf = (e: El): El | null => {
    let top: El | null = null;
    for (let x: El | null = e.parent; x; x = x.parent) if (x.draws && !x.dim && x.vis && area(x.vis) >= 3 * area(e.vis)) top = x;
    return top;
  };
  const groups = new Map<El | null, El[]>();
  for (const b of buttons) groups.set(groupOf(b), [...(groups.get(groupOf(b)) ?? []), b]);
  let judged = false;
  let outshone = 0;
  let flat = 0;
  for (const [g, list] of groups) {
    if (!g || list.length < 2) continue;
    const roles = list.map((b) => ({ b, role: roleOf(labelOf(b), b.n.name) }));
    let primaries = roles.filter((r) => r.role === 'primary');
    const secondaries = roles.filter((r) => r.role === 'secondary');
    // A dialog's one unnamed button beside a "Cancel" is its primary.
    if (!primaries.length && secondaries.length && roles.length - secondaries.length === 1) primaries = roles.filter((r) => r.role === null && labelOf(r.b).trim().length > 1);
    if (primaries.length !== 1) continue;
    judged = true;
    const p = salienceOf(ctx, primaries[0]!.b);
    const sal = new Map(list.map((b) => [b, b === p.e ? p : salienceOf(ctx, b)]));
    for (const s of secondaries) {
      const q = sal.get(s.b)!;
      if (q.s < 0.9 * p.s) continue;
      // A red "Skip" or "Leave" is a destructive confirm, salient on purpose.
      const fill = q.fill ?? bodyColour(s.b);
      if (fill && lch(fill).C >= 40 && (hueName(lch(fill).h) === 'red' || hueName(lch(fill).h) === 'pink')) continue;
      outshone++;
      const pl = labelOf(p.e) || p.e.n.name;
      const ql = labelOf(q.e) || q.e.n.name;
      const pk = p.e.b.k || 1;
      add(ctx, {
        severity: q.s >= 1.2 * p.s ? 'problem' : 'warning',
        check: 'hierarchy',
        paths: [q.e.path, p.e.path],
        message: `"${ql.slice(0, 20)}" (secondary) is as salient as "${pl.slice(0, 20)}" (primary) or more: ${r1(q.s / p.s)}× (size ${r0(q.size)} vs ${r0(p.size)} pt, contrast ${r1(q.contrast)} vs ${r1(p.contrast)}, chroma ${r0(q.chroma)} vs ${r0(p.chroma)})`,
        numbers: { ratio: r1(q.s / p.s), secondary: r1(q.s), primary: r1(p.s) },
        fix:
          q.chroma > p.chroma
            ? `make "${ql.slice(0, 20)}" neutral (a grey or ghost button) and "${pl.slice(0, 20)}" the accent colour`
            : `raise "${pl.slice(0, 20)}" to ${Math.ceil(Math.max(p.e.vis!.h, q.e.vis!.h * 1.15) / pk)} (design) tall in the accent colour, or make "${ql.slice(0, 20)}" a ghost button (transparent fill, 1 px stroke)`,
      });
    }
    // Nothing stands out: the primary no more salient than the other (non-secondary) buttons.
    const others = list.filter((b) => b !== p.e && !secondaries.some((s) => s.b === b)).map((b) => sal.get(b)!);
    if (others.length >= 2) {
      const top = Math.max(...others.map((o) => o.s));
      if (p.s < 1.1 * top) {
        flat++;
        add(ctx, {
          severity: 'note',
          check: 'hierarchy',
          paths: [p.e.path, ...short(others.map((o) => o.e.path), 3)],
          message: `nothing stands out in ${g.path}: "${(labelOf(p.e) || p.e.n.name).slice(0, 20)}" is only ${r1(p.s / top)}× as salient as the other buttons`,
          numbers: { ratio: r1(p.s / top) },
          fix: `make "${(labelOf(p.e) || p.e.n.name).slice(0, 20)}" the one accent-coloured button and 15-25% bigger; keep the rest neutral`,
        });
      }
    }
  }
  return { judged, outshone, flat };
}

// Consistency ──────────────────────────────────────────────────────────────────────────────────────

function radiusOf(e: El): number | 'pill' | null {
  const n = e.n;
  const r = e.vis ?? { w: e.b.w, h: e.b.h };
  const m = Math.min(e.b.w, e.b.h);
  const k = e.b.k || 1;
  const c = n.corner ?? n.corners?.[0];
  if (!c) return null;
  if (c[0] >= 0.5) return 'pill';
  const pts = c[0] * m + c[1] * k;
  if (pts >= 0.4 * m) return 'pill';
  if (pts <= 0 || r.w < 16 || r.h < 16) return null;
  return Math.round(pts / k);
}

function consistency(ctx: Ctx): { radii: number[]; strokes: number[]; heights: number; icons: number; peers: number } {
  const els = ctx.m.els.filter((e) => e.vis && !e.turned && !e.dim && !e.art);
  // Corner radii.
  const radii = new Map<number, El[]>();
  for (const e of els) {
    if (!(e.fillA > 0.2 || e.image || e.border)) continue;
    const r = radiusOf(e);
    if (typeof r === 'number') radii.set(r, [...(radii.get(r) ?? []), e]);
  }
  const rv: number[] = [];
  for (const v of [...radii.keys()].sort((a, b) => a - b)) if (!rv.length || v - rv[rv.length - 1]! > 1) rv.push(v);
  if (rv.length >= 5)
    add(ctx, {
      severity: rv.length >= 7 ? 'warning' : 'note',
      check: 'consistency',
      paths: short(rv.map((v) => `${radii.get(v)?.[0]?.path ?? [...radii.entries()].find(([k]) => Math.abs(k - v) <= 1)?.[1][0]?.path} (${v})`)),
      message: `${rv.length} corner radii (${rv.join(', ')}, design) on one screen: a radius family has 2-3`,
      numbers: { radii: rv },
      fix: `use two or three: ${radiusAdvice(radii)} (inner = outer − padding when nested)`,
    });
  // Stroke widths (borders).
  const strokes = new Map<number, El[]>();
  for (const e of els) for (const s of borderStrokes(e.n)) if (s.t < 0.8) strokes.set(Math.round(s.px * 2) / 2, [...(strokes.get(Math.round(s.px * 2) / 2) ?? []), e]);
  const sv = [...strokes.keys()].sort((a, b) => a - b);
  if (sv.length >= 4)
    add(ctx, {
      severity: 'note',
      check: 'consistency',
      paths: short(sv.map((v) => `${strokes.get(v)![0]!.path} (${v})`)),
      message: `${sv.length} border stroke widths (${sv.join(', ')} px): one hairline and one outline weight read as a recipe`,
      numbers: { strokes: sv },
      fix: `use ${sv[0]} for hairlines and ${sv[sv.length - 1]! >= 3 ? 3 : sv[sv.length - 1]} for outlines`,
    });
  // Peers that should match: buttons in one row (heights), sibling or cousin icons (sizes), peer radii.
  let heights = 0;
  let icons = 0;
  let peers = 0;
  const buttons = els.filter((e) => isButton(e.n) && e.n.cls !== 'TextBox' && !e.inButton && Math.min(e.vis!.w, e.vis!.h) >= 16);
  const byParent = new Map<El | null, El[]>();
  for (const b of buttons) byParent.set(b.parent, [...(byParent.get(b.parent) ?? []), b]);
  for (const [, list] of byParent) {
    for (const row of rowsOf(
      list.map((b) => ({ ...b, lay: b.vis })),
      'x',
      null,
      1e9,
    )) {
      const hs = row.items.map((b) => b.vis!.h);
      const lo = Math.min(...hs);
      const hi = Math.max(...hs);
      const ws = row.items.map((b) => b.vis!.w);
      const shapes = new Set(row.items.map((b) => radiusOf(bodyOf(b)) === 'pill'));
      if (hi - lo < 2 || hi / lo > 1.2 || hi / lo < 1.04 || Math.max(...ws) > 1.15 * Math.min(...ws) || shapes.size > 1) continue;
      heights++;
      const k = row.items[0]!.b.k || 1;
      add(ctx, {
        severity: 'warning',
        check: 'consistency',
        paths: short(row.items.map((b) => `${b.path} (${r0(b.vis!.h)})`)),
        message: `buttons in one row at ${[...new Set(hs.map(r0))].join(' and ')} pt tall`,
        numbers: { heights: hs.map(r1) },
        fix: `make them all ${r0(hi / k)} (design) tall`,
      });
    }
  }
  const isIcon = (e: El) => e.image && e.vis!.w <= 72 && e.vis!.h <= 72 && e.b.w / Math.max(1, e.b.h) >= 0.75 && e.b.w / Math.max(1, e.b.h) <= 1.33;
  const iconGroups = new Map<string, El[]>();
  for (const e of els.filter(isIcon)) {
    const gp = e.parent?.parent;
    if (gp && e.parent && !e.parent.n.list && !e.parent.n.grid) iconGroups.set(`c:${gp.n.id}:${e.n.name}:${e.parent.n.cls}:${isButton(e.parent.n)}`, [...(iconGroups.get(`c:${gp.n.id}:${e.n.name}`) ?? []), e]);
  }
  for (const [, list] of iconGroups) {
    if (list.length < 2) continue;
    const s = list.map((e) => Math.max(e.b.w, e.b.h));
    const lo = Math.min(...s);
    const hi = Math.max(...s);
    if (hi - lo < 2 || hi / lo < 1.1) continue;
    icons++;
    add(ctx, {
      severity: 'warning',
      check: 'consistency',
      paths: short(list.map((e) => `${e.path} (${r0(Math.max(e.b.w, e.b.h))})`)),
      message: `the same icon slot at ${[...new Set(s.map(r0))].join(', ')} pt across ${list.length} siblings`,
      numbers: { sizes: s.map(r1) },
      fix: `size every ${list[0]!.n.name} the same (${r0(median(s) / (list[0]!.b.k || 1))} design, ScaleType Fit)`,
    });
  }
  // Peer buttons (same parent, same size) with different radii.
  for (const [, list] of byParent) {
    const rs = list.map((b) => ({ b, r: radiusOf(bodyOf(b)) })).filter((x) => typeof x.r === 'number') as Array<{ b: El; r: number }>;
    if (rs.length < 2) continue;
    const vals = [...new Set(rs.map((x) => x.r))];
    if (vals.length < 2 || Math.max(...vals) - Math.min(...vals) < 2) continue;
    const similar = rs.filter((x) => Math.abs(x.b.vis!.h - rs[0]!.b.vis!.h) <= 0.15 * rs[0]!.b.vis!.h);
    if (new Set(similar.map((x) => x.r)).size < 2) continue;
    peers++;
    add(ctx, {
      severity: 'warning',
      check: 'consistency',
      paths: short(similar.map((x) => `${x.b.path} (${x.r})`)),
      message: `sibling buttons with corner radii ${[...new Set(similar.map((x) => x.r))].join(' and ')} (design)`,
      numbers: { radii: [...new Set(similar.map((x) => x.r))] },
      fix: `give them one radius (${median(similar.map((x) => x.r))})`,
    });
  }
  return { radii: rv, strokes: sv, heights, icons, peers };
}
/** A radius family from what is in use: the buttons' typical radius and the panels' largest, on the 4-pt grid. */
function radiusAdvice(radii: Map<number, El[]>): string {
  const q = (v: number) => Math.max(4, Math.round(v / 4) * 4);
  const ctrl = [...radii].flatMap(([r, es]) => es.filter((e) => isButton(e.n)).map(() => r));
  const panel = [...radii].flatMap(([r, es]) => es.filter((e) => !isButton(e.n) && !e.inButton).map(() => r));
  const c = ctrl.length ? q(median(ctrl)) : 8;
  const p = panel.length ? q(Math.max(...panel)) : 12;
  return p > c ? `${c} for buttons, ${p} for panels` : `${c} for buttons and panels`;
}

// Density ──────────────────────────────────────────────────────────────────────────────────────────

const CELL = 2;
/** Cells (2 pt) a set of rectangles covers inside an area. */
function cover(rects: R[], within: R): Uint8Array {
  const w = Math.ceil(within.w / CELL);
  const h = Math.ceil(within.h / CELL);
  const grid = new Uint8Array(Math.max(0, w * h));
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.x - within.x) / CELL));
    const y0 = Math.max(0, Math.floor((r.y - within.y) / CELL));
    const x1 = Math.min(w, Math.ceil((r.x + r.w - within.x) / CELL));
    const y1 = Math.min(h, Math.ceil((r.y + r.h - within.y) / CELL));
    for (let y = y0; y < y1; y++) grid.fill(1, y * w + x0, y * w + Math.max(x0, x1));
  }
  return grid;
}
const share = (g: Uint8Array) => (g.length ? g.reduce((t, v) => t + v, 0) / g.length : 0);

/** What the view draws, as rectangles (text by its lines; backdrops and dims left out). */
const inkRects = (m: Model) => m.els.filter((e) => e.draws && !e.dim && e.vis && (e.fillA > 0.15 || e.image || e.border || e.text)).flatMap((e) => (e.text && e.fillA <= 0.15 && !e.image && !e.border ? e.lines : [e.vis!]));

/** Separate clusters of drawn pixels (cells 8 pt apart or more). */
function widgets(rects: R[], within: R): number {
  const S = 8;
  const w = Math.ceil(within.w / S);
  const h = Math.ceil(within.h / S);
  const g = new Int32Array(w * h).fill(-1);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.x - within.x) / S));
    const y0 = Math.max(0, Math.floor((r.y - within.y) / S));
    const x1 = Math.min(w, Math.ceil((r.x + r.w - within.x) / S));
    const y1 = Math.min(h, Math.ceil((r.y + r.h - within.y) / S));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * w + x] = 0;
  }
  let n = 0;
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== 0) continue;
    n++;
    const stack = [i];
    g[i] = n;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = Math.floor(j / w);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (g[q] === 0) {
          g[q] = n;
          stack.push(q);
        }
      }
    }
  }
  return n;
}

const centreOf = (dev: UiScreen): R => ({ x: dev.w * 0.3, y: dev.h * 0.3, w: dev.w * 0.4, h: dev.h * 0.4 });

function density(ctx: Ctx): { coverage: number; centre: number; widgets: number; collisions: number } {
  const rects = inkRects(ctx.m);
  const coverage = share(cover(rects, ctx.m.root));
  const centre = share(cover(rects, centreOf(ctx.m.dev)));
  const wcount = widgets(rects, ctx.m.root);
  // Collisions: words printed over words, and blocks half on top of their neighbours (a layout that doesn't fit).
  let collisions = 0;
  const texts = ctx.m.els.filter((e) => e.text && e.lines.length && !e.turned && !e.art && !glyphText(e.text));
  // The estimate is ~8% off in width: shrink each line a little before testing.
  const shrink = (r: R): R => ({ x: r.x + r.w * 0.05, y: r.y + r.h * 0.1, w: r.w * 0.9, h: r.h * 0.8 });
  const hits: Array<{ a: El; b: El; share: number }> = [];
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      // The same words twice in one place are a layered effect (a glow, a drop shadow), not a collision.
      if (nested(a, b) || a.text === b.text) continue;
      let o = 0;
      for (const la of a.lines) for (const lb of b.lines) o += area(inter(shrink(la), shrink(lb)));
      const small = Math.min(...[a, b].map((e) => e.lines.reduce((t, l) => t + area(shrink(l)), 0)));
      if (small > 0 && o / small >= 0.15) hits.push({ a, b, share: o / small });
    }
  for (const h of hits.sort((x, y) => y.share - x.share).slice(0, 6)) {
    collisions++;
    add(ctx, {
      severity: h.share >= 0.4 ? 'problem' : 'warning',
      check: 'density',
      paths: [h.a.path, h.b.path],
      message: `"${h.a.text.slice(0, 20)}" and "${h.b.text.slice(0, 20)}" print over each other (${r0(h.share * 100)}% of the smaller)`,
      numbers: { overlap: r1(h.share) },
      fix: `give them their own space: a list (UIListLayout) for the row, AutomaticSize on the labels, or a shorter string; on a phone, a layout of its own`,
    });
  }
  // Blocks (filled boxes, buttons) partly on top of a sibling: neither inside the other, a real share covered.
  // Peers only: blocks of a similar size (a knob on a slider's fill, a badge on a card are on purpose), no screen-wide
  // overlays (a vignette, a scan band) and nothing that fades out (a gradient with transparency is an effect).
  const blocks = ctx.m.els.filter((e) => e.vis && !e.dim && !e.turned && !e.art && (e.fillA >= 0.5 || isButton(e.n)) && area(e.vis) >= 300 && Math.min(e.vis.w, e.vis.h) >= 12 && area(e.vis) < 0.25 * area(ctx.m.root) && !e.n.gradient?.transp?.length && Math.max(e.vis.w, e.vis.h) < 4 * Math.min(e.vis.w, e.vis.h));
  // Every pair in the view, outermost first: once two panels collide, their insides aren't reported again.
  const upOrSelf = (x: El, y: El) => x === y || nested(x, y);
  const reported: Array<[El, El]> = [];
  const sorted = [...blocks].sort((x, y) => x.b.depth - y.b.depth);
  for (let i = 0; i < sorted.length && collisions < 8; i++)
    for (let j = i + 1; j < sorted.length && collisions < 8; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (nested(a, b)) continue;
      const o = area(inter(a.vis!, b.vis!));
      const small = Math.min(area(a.vis), area(b.vis));
      const big = Math.max(area(a.vis), area(b.vis));
      // A badge on a corner (much smaller) or a layer stacked exactly (a lip, a glow) is on purpose.
      if (!o || o >= 0.9 * small || small < 0.4 * big || o / small < 0.15) continue;
      if (reported.some(([p, q]) => (upOrSelf(p, a) && upOrSelf(q, b)) || (upOrSelf(p, b) && upOrSelf(q, a)))) continue;
      reported.push([a, b]);
      collisions++;
      add(ctx, {
        severity: o / small >= 0.35 ? 'problem' : 'warning',
        check: 'density',
        paths: [a.path, b.path],
        message: `${name(a)} and ${name(b)} overlap: ${r0((100 * o) / small)}% of the smaller is covered`,
        numbers: { overlap: r1(o / small) },
        fix: `lay them out side by side (a UIListLayout with Padding 8) or give this device its own layout`,
      });
    }
  // Content cut off: drawn pieces more than half hidden by their panel's ClipsDescendants or the screen's edge
  // (a scrolling list hides on purpose; something wholly off the screen is parked for a script to slide in).
  const inScroll = (e: El) => {
    for (let x: El | null = e.parent; x; x = x.parent) if (x.n.cls === 'ScrollingFrame') return true;
    return false;
  };
  const drawnEls = ctx.m.els.filter((e) => !e.dim && !e.turned && !e.art && (e.n.textT ?? 0) < 0.6 && (e.fillA > 0.3 || e.image || !!e.text || e.border) && e.b.w >= 4 && e.b.h >= 4);
  const cutEls = drawnEls.filter((e) => {
    if (inScroll(e)) return false;
    const full = area({ x: e.b.x, y: e.b.y, w: e.b.w, h: e.b.h });
    const seen = area(e.vis);
    // Words cut by a panel's edge read broken even when most of the box shows.
    if (e.text && e.b.clip && seen > 0) {
      const all = textLines(e.b, ctx.measure).reduce((t, l) => t + area(l), 0);
      const shown = e.lines.reduce((t, l) => t + area(l), 0);
      if (all > 0 && shown < 0.9 * all) return true;
    }
    if (seen >= 0.5 * full) return false;
    const onScreen = area(inter({ x: e.b.x, y: e.b.y, w: e.b.w, h: e.b.h }, { x: 0, y: 0, w: ctx.m.dev.w, h: ctx.m.dev.h }));
    // Wholly off the screen and not clipped by a panel: parked.
    return !(onScreen === 0 && !e.b.clip);
  });
  // Report the outermost pieces only (a cut card, not each of its labels).
  const outer = cutEls.filter((e) => !cutEls.some((o) => o !== e && nested(o, e) && e.path.startsWith(`${o.path}.`)));
  if (outer.length && (outer.length >= 2 || outer.some((e) => !!e.text || isButton(e.n)))) {
    const share = cutEls.length / Math.max(1, drawnEls.length);
    add(ctx, {
      severity: share >= 0.25 ? 'problem' : 'warning',
      check: 'density',
      paths: short(outer.map((e) => `${e.path} (${r0((100 * area(e.vis)) / Math.max(1, e.b.w * e.b.h))}% shows)`)),
      message: `${cutEls.length} of ${drawnEls.length} drawn pieces are more than half cut off by their panel or the screen edge: the content doesn't fit this ${ctx.label}`,
      numbers: { cut: cutEls.length, of: drawnEls.length },
      fix: `fit the content to the panel on this device: a ScrollingFrame for long lists, AutomaticSize on the panel, or a layout of its own for the ${ctx.label}`,
    });
  }
  return { coverage, centre, widgets: wcount, collisions };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────────────────────────

// Density carries collisions and content cut off (a layout that doesn't fit), the strongest tell in calibration.
const WEIGHTS: Record<CritCheck, number> = { legibility: 0.2, hierarchy: 0.1, spacing: 0.12, alignment: 0.08, type: 0.12, color: 0.1, consistency: 0.06, density: 0.22 };
const PENALTY: Record<CritSeverity, number> = { problem: 18, warning: 8, note: 2 };
const findingsOf = (fs: Ctx['out'], c: CritCheck) => fs.filter((f) => f.check === c);
const penalties = (fs: Ctx['out'], c: CritCheck, cap = 60) => Math.min(cap, findingsOf(fs, c).reduce((t, f) => t + PENALTY[f.severity], 0));

function scoreView(ctx: Ctx, m: { reads: TextRead[]; sp: SpacingResult; al: { nearMiss: number; checked: number }; ty: ReturnType<typeof typeScale>; co: ReturnType<typeof colour>; hi: ReturnType<typeof hierarchy>; cs: ReturnType<typeof consistency>; de: ReturnType<typeof density> }): Record<CritCheck, CritSub> {
  const fs = ctx.out;
  const sub = {} as Record<CritCheck, CritSub>;
  // Legibility: the share of texts that read on every backdrop and are big enough, then the findings.
  if (m.reads.length) {
    const deficit = m.reads.map((t) => Math.max(0, 1 - t.worst / (t.large ? 3 : 4.5)) * 0.6 + (t.glyph ? 0 : 1) * Math.max(0, 1 - t.arc / (t.role === 'body' ? TEXT_MIN.body : TEXT_MIN.label)) * 0.8);
    const bad = m.reads.filter((t) => t.worst < (t.large ? 2.4 : 3)).length;
    const worst = [...m.reads].sort((a, b) => a.worst - b.worst)[0]!;
    sub.legibility = {
      score: r0(clamp(100 - 100 * (deficit.reduce((t, v) => t + v, 0) / m.reads.length) - penalties(fs, 'legibility', 50))),
      why: `${m.reads.length - bad} of ${m.reads.length} texts read on every backdrop; worst ${r1(worst.worst)}:1 (${name(worst.e)} on ${worst.worstOn}); smallest ${r1(Math.min(...m.reads.map((t) => t.e.b.fontSize)))} pt`,
    };
  } else sub.legibility = { score: null, why: 'no text' };
  // Spacing: typed values on a grid (4 best, even at least), no near-duplicates, rows even.
  {
    const gridPart = (m.sp.best4 === null || m.sp.even === null ? 0 : 12 * (1 - m.sp.best4) + 25 * (1 - m.sp.even)) + 4 * Math.min(6, m.sp.loose);
    const n = m.sp.fixed.filter((v) => v >= 2).length;
    sub.spacing = {
      score: r0(clamp(100 - gridPart - penalties(fs, 'spacing', 45))),
      why:
        n < 4
          ? `too few typed spacing values to judge a grid (${n}); ${m.sp.uneven} uneven rows`
          : `${m.sp.base ? `${m.sp.base}-pt grid` : 'no single grid'}: ${r0((m.sp.best4 ?? 0) * 100)}% of ${n} typed values on 4, ${r0((m.sp.even ?? 0) * 100)}% even; ${m.sp.loose} near-duplicate values (${m.sp.nearDup} side by side in one role); ${m.sp.uneven} uneven rows`,
    };
  }
  sub.alignment = {
    score: m.al.checked < 3 ? null : r0(clamp(100 - Math.min(50, (m.al.nearMiss * 280) / Math.max(20, m.al.checked)) - (m.al.nearMiss ? 6 : 0))),
    why: m.al.checked < 3 ? 'too few elements' : `${m.al.nearMiss} near-misses (1.5-4.5 pt off a shared line) among ${m.al.checked} elements`,
  };
  {
    const n = m.ty.sizes.length;
    const extra = Math.max(0, n - 6) * 6;
    sub.type = {
      score: n ? r0(clamp(100 - extra - penalties(fs, 'type', 50))) : null,
      why: n ? `${n} sizes (${m.ty.sizes.join(', ')} pt), ${m.ty.fonts.length} families; ${m.ty.scaledSpread} TextScaled groups of mixed sizes; ${m.ty.nearDup} near-duplicate sizes` : 'no text',
    };
  }
  sub.color = {
    score: r0(clamp(100 - Math.max(0, m.co.palette - 10) * 3 - penalties(fs, 'color', 50))),
    why: `${m.co.palette} colours, ${m.co.accents} accent hues, ${m.co.clashes} clashes`,
  };
  sub.hierarchy = m.hi.judged ? { score: r0(clamp(100 - penalties(fs, 'hierarchy', 70) * 1.6)), why: m.hi.outshone ? `${m.hi.outshone} secondary buttons as salient as the primary` : m.hi.flat ? 'the primary barely stands out' : 'the primary action is the most salient button' } : { score: null, why: 'no primary/secondary pair to judge' };
  sub.consistency = {
    score: r0(clamp(100 - penalties(fs, 'consistency', 50))),
    why: `radii ${m.cs.radii.join('/') || 'none'}; strokes ${m.cs.strokes.join('/') || 'none'}; ${m.cs.heights} mixed-height rows, ${m.cs.icons} mixed icon groups`,
  };
  {
    const phone = ctx.device === 'phone' || ctx.device === 'phonePortrait';
    let p = penalties(fs, 'density', 60);
    if (ctx.kind === 'hud') {
      const lim = phone ? 0.2 : 0.15;
      p += Math.max(0, m.de.coverage - lim) * 150 + Math.max(0, m.de.centre - 0.1) * 100;
    }
    sub.density = {
      score: r0(clamp(100 - p)),
      why: `${ctx.kind === 'hud' ? `covers ${r0(m.de.coverage * 100)}% of the screen, ${r0(m.de.centre * 100)}% of its middle; ${m.de.widgets} separate pieces` : `covers ${r0(m.de.coverage * 100)}% of the screen (a menu: coverage not judged)`}; ${m.de.collisions} collisions`,
    };
  }
  return sub;
}

// ─── Entry points ─────────────────────────────────────────────────────────────────────────────────

const DEFAULT_BACKDROPS: CritBackdrop[] = [
  { name: 'bright sky', image: 'bright' },
  { name: 'dark scene', image: 'dark' },
];

/** One view on one device: its findings, score and what it covers (for the play density). */
function critiqueView(view: View, device: UiDevice, o: CritiqueOptions): { findings: Ctx['out']; score: CritScore | null; hudRects: R[] } {
  const measure = o.measure ?? estimateText;
  const dev: UiScreen = screenFor(device, o);
  const m = buildModel(view, dev, measure);
  const drawn = m.els.filter((e) => e.draws && !e.dim);
  if (!drawn.length) return { findings: [], score: null, hudRects: [] };
  const root = area(m.root);
  const panel = m.els.some((e) => e.draws && e.vis && e.fillA >= 0.5 && area(e.vis) >= 0.25 * root);
  // A screen that hides Roblox's chat or controls while it shows owns the screen: a menu (a garage, a shop), however
  // its art is laid out.
  const kind: 'hud' | 'menu' = panel || m.els.some((e) => e.dim) || !!view.screen.hides ? 'menu' : 'hud';
  const layer = o.pixels === false ? null : textlessLayer(view, o.screens?.[device] ?? device, o.images);
  const backdrops = layer ? (o.backdrops ?? DEFAULT_BACKDROPS).map((bd) => ({ bd, px: backdropPixels(bd, layer.w, layer.h) })) : [];
  const ctx: Ctx = { view, device, label: deviceLabel(device, o), m, measure, viewing: { ...VIEWING[device], ...o.viewing?.[device] }, layer, backdrops, images: o.images, out: [], kind };
  const reads = legibility(ctx);
  const sp = spacing(ctx);
  const al = alignment(ctx);
  const texts = m.els.filter((e) => e.text && e.lines.length);
  const ty = typeScale(ctx, texts);
  const co = colour(ctx);
  const hi = hierarchy(ctx);
  const cs = consistency(ctx);
  const de = density(ctx);
  const sub = scoreView(ctx, { reads, sp, al, ty, co, hi, cs, de });
  let wsum = 0;
  let total = 0;
  for (const c of CRIT_CHECKS) {
    const s = sub[c].score;
    if (s === null) continue;
    wsum += WEIGHTS[c];
    total += WEIGHTS[c] * s;
  }
  // Faults weigh on the whole: a screen whose words collide is broken however tidy its grid. Normalised by size, so a
  // big menu isn't marked down for having more places to slip.
  const problems = ctx.out.filter((f) => f.severity === 'problem').length;
  const warnings = ctx.out.filter((f) => f.severity === 'warning').length;
  const faults = Math.min(25, (5 * problems + 1.5 * warnings) / Math.max(1, Math.sqrt(drawn.length / 30)));
  const worst = [...reads].sort((a, b) => a.worst - b.worst)[0];
  const score: CritScore = {
    view: view.name,
    device,
    kind,
    later: view.later,
    score: r0(clamp((wsum ? total / wsum : 100) - faults)),
    sub,
    metrics: {
      elements: drawn.length,
      texts: texts.length,
      sizes: ty.sizes,
      fonts: ty.fonts,
      spacingBase: sp.base,
      gridShare: sp.best4 === null ? null : r1(sp.best4 * 100) / 100,
      spacingValues: [...new Set(sp.fixed)].sort((a, b) => a - b),
      palette: co.palette,
      accents: co.accents,
      radii: cs.radii,
      coverage: Math.round(de.coverage * 1000) / 1000,
      worstContrast: worst ? { ratio: r1(worst.worst), path: worst.e.path, backdrop: worst.worstOn } : null,
    },
  };
  return { findings: ctx.out, score, hudRects: kind === 'hud' && !view.later ? inkRects(m) : [] };
}

/**
 * Critiques a game's ScreenGuis on each device: every screen (a disabled one as if shown) and every sizeable hidden
 * menu as its own view, plus the HUD as a player sees it while playing. Findings that repeat on several devices are
 * merged (their numbers are the first device's).
 */
export function critiqueUi(screens: UiNode[], o: CritiqueOptions = {}): Critique {
  const devices = o.devices ?? ['phone', 'desktop'];
  const views = viewsOf(screens, o.hiddenMin ?? 6).filter((v) => !o.views || o.views.includes(v.name));
  const found = new Map<string, CritFinding>();
  const scores: CritScore[] = [];
  const play: PlayDensity[] = [];
  const notes = new Set<string>();
  for (const device of devices) {
    const hud: Array<{ view: string; rects: R[] }> = [];
    for (const v of views) {
      const r = critiqueView(v, device, o);
      if (r.score) scores.push(r.score);
      if (r.hudRects.length) hud.push({ view: v.name, rects: r.hudRects });
      for (const f of r.findings) {
        const key = `${v.name}|${f.check}|${f.paths.join(',')}|${f.message.replace(/\d+(\.\d+)?/g, '#')}`;
        const prev = found.get(key);
        if (prev) {
          if (!prev.devices.includes(device)) prev.devices.push(device);
          if (f.severity === 'problem') prev.severity = 'problem';
        } else found.set(key, { ...f, view: v.name, devices: [device] });
      }
    }
    // While playing: every HUD screen together.
    const dev: UiScreen = screenFor(device, o);
    const full: R = { x: 0, y: 0, w: dev.w, h: dev.h };
    const all = hud.flatMap((h) => h.rects);
    if (all.length) {
      const p: PlayDensity = { device, coverage: share(cover(all, full)), centre: share(cover(all, centreOf(dev))), widgets: widgets(all, full), screens: Object.fromEntries(hud.map((h) => [h.view, Math.round(share(cover(h.rects, full)) * 1000) / 1000])) };
      p.coverage = Math.round(p.coverage * 1000) / 1000;
      p.centre = Math.round(p.centre * 1000) / 1000;
      play.push(p);
      const phone = device === 'phone' || device === 'phonePortrait';
      const lim = phone ? 0.22 : 0.16;
      if (p.coverage > lim) {
        const top = Object.entries(p.screens).sort((a, b) => b[1] - a[1]);
        const f: CritFinding = {
          severity: p.coverage > lim * 1.5 ? 'problem' : 'warning',
          check: 'density',
          view: '(playing)',
          devices: [device],
          paths: top.slice(0, 4).map(([s]) => s),
          message: `while playing, the HUD covers ${r0(p.coverage * 100)}% of a ${deviceLabel(device, o)} screen (${top
            .slice(0, 4)
            .map(([s, c]) => `${s} ${r0(c * 100)}%`)
            .join(', ')}): the game needs the rest`,
          numbers: { coverage: p.coverage, centre: p.centre, widgets: p.widgets },
          fix: `aim under ${r0(lim * 100)}%: shrink or merge ${top[0]![0]}, hide what isn't needed in the moment (show on change, then fade), give the phone its own compact layout`,
        };
        found.set(`(playing)|density|${device}`, f);
      }
      if (p.centre > 0.12)
        found.set(`(playing)|centre|${device}`, {
          severity: 'warning',
          check: 'density',
          view: '(playing)',
          devices: [device],
          paths: Object.keys(p.screens),
          message: `while playing, ${r0(p.centre * 100)}% of the middle of the screen is covered by HUD`,
          numbers: { centre: p.centre },
          fix: 'keep the middle 40% clear in play: move panels to the edges, and show prompts briefly',
        });
    }
  }
  if (o.pixels !== false && !o.images) notes.add('images were drawn as placeholders: text over them was not judged for contrast');
  const order: Record<CritSeverity, number> = { problem: 0, warning: 1, note: 2 };
  const findings = [...found.values()].sort((a, b) => order[a.severity] - order[b.severity] || a.view.localeCompare(b.view));
  return { findings, scores, play, notes: [...notes] };
}

/** A mockup version critiqued on each device as resolved for it (the form layouts and the kits' screen setup). */
export function critiqueVersion(v: Pick<MockVersion, 'screens' | 'theme'>, o: CritiqueOptions = {}): Critique {
  const devices = o.devices ?? ['phone', 'desktop'];
  const parts = devices.map((d) => critiqueUi(resolveVersion(v, d).screens, { ...o, devices: [d] }));
  const found = new Map<string, CritFinding>();
  for (const p of parts)
    for (const f of p.findings) {
      const key = `${f.view}|${f.check}|${f.paths.join(',')}|${f.message.replace(/\d+(\.\d+)?/g, '#')}`;
      const prev = found.get(key);
      if (!prev) found.set(key, { ...f, devices: [...f.devices] });
      else {
        for (const d of f.devices) if (!prev.devices.includes(d)) prev.devices.push(d);
        if (f.severity === 'problem') prev.severity = 'problem';
      }
    }
  return { findings: [...found.values()], scores: parts.flatMap((p) => p.scores), play: parts.flatMap((p) => p.play), notes: [...new Set(parts.flatMap((p) => p.notes))] };
}

/** The mean score of a critique's views (menus and HUDs alike), per device, for ranking versions. */
export function overallScore(c: Critique, device?: UiDevice): number | null {
  const s = c.scores.filter((x) => !device || x.device === device);
  if (!s.length) return null;
  return r0(s.reduce((t, x) => t + x.score * Math.sqrt(x.metrics.elements), 0) / s.reduce((t, x) => t + Math.sqrt(x.metrics.elements), 0));
}

/** One ScreenGui on one device: its findings and score (no merging across devices; the play density isn't computed). */
export function critiqueScreen(screen: UiNode, device: UiDevice, o: Omit<CritiqueOptions, 'devices'> = {}): Critique {
  return critiqueUi([screen], { ...o, devices: [device] });
}
