import { estimateText, isText, layoutScreen, shapePolygon, strokesOf, TOPBAR, UI_DEVICES, withState, wrapText, type Measure, type RGB, type UiBox, type UiDevice, type UiGradient, type UiNode, type UiScreen, type UiStateName, type UiStroke } from '@shared/ui-layout';
import { fontFor } from './ui-fonts';
import { blurMask, circle, fillMask, maskTimes, moveMask, newRaster, paint, pixelText, roundedRect, sampler, strokeOutline, toRgba, wound, type Mask, type Pt, type Raster, type Rect, type Shader } from './ui-raster';
import type { RgbaImage } from '../modeling/png';

/**
 * Pictures of UI for agents that can't look at the UI page: a mockup's screens (or the game's UI as last read)
 * drawn on one device by the same layout engine the audit uses (@shared/ui-layout), in software
 * (core/ui/ui-raster.ts), the way the effects workshop draws its contact sheets without Studio. Drawn: fills with
 * transparency, UIGradient (linear, radial, conical; colour and transparency keys), UICorner (per corner),
 * borders, UIStroke (Outer, Center, Inner; several by ZIndex; with their own gradients; round the letters for
 * text), UIShadow (blurred, cut out under the element), panel shapes, rotation (children turn with their
 * parent), ClipsDescendants, images (uploaded ones from their thumbnails, the project's icons, glyphs; Fit, Crop,
 * 9-slice), text in a stand-in font (wrapping, alignment, TextScaled sizes from the layout, rich text bold,
 * colour, strike and underline, truncation), elements in a state (hover, press, selected, disabled), Roblox's top
 * bar, the notch and a TV's safe area, and rulers in points. Not drawn: Roblox's own fonts (stand-ins), the 3D
 * game behind (a backdrop instead), CanvasGroup flattening, ViewportFrames, scrolling.
 */

export type Backdrop = 'dark' | 'bright' | RgbaImage;

export interface UiRenderOptions {
  /** Picture pixels per point (default: 1 on a phone or tablet, 0.75 on a desktop or TV; a focus picks its own). */
  scale?: number;
  backdrop?: Backdrop;
  /** Roblox's top bar, a phone's notch and home bar, a TV's safe area (default on). */
  guides?: boolean;
  /** A ruler in points along the top and the left (default on). */
  rulers?: boolean;
  /** An element's path: the picture is that element (with a margin), drawn big. */
  focus?: string;
  /** The part of the screen to draw, in points (a focus finds its own). */
  region?: Rect;
  /** Paths of hidden elements (Visible = false, or a screen a script enables) to draw as shown. */
  show?: string[];
  /** Elements drawn in a state: path → hover, press, selected or disabled. */
  states?: Record<string, UiStateName>;
  /** An image for a reference ("rbxassetid://…", "icon:Name", "glyph:name") at about `px` pixels, or null when it isn't there. */
  images?: (ref: string, px: number) => RgbaImage | null;
  /** A line under the picture. */
  caption?: string;
  /** Text widths for the layout and wrapping (default: the audit's estimate). The UI Lab passes Roblox's own fonts' metrics. */
  measure?: Measure;
  /** The font a text is drawn in (default: a Windows stand-in for its Roblox font). */
  fonts?: FontPicker;
  /** Where the first line's baseline sits below its line's top, as a fraction of the text size (default 0.85: capitals centred). */
  baseline?: (font: GlyphFont | null, size: number, lineH: number) => number;
  /** Drawn over the UI, under the guides (the UI Lab draws Roblox's own controls here): view maps points to picture pixels. */
  overlay?: (c: Raster, view: Mat, scale: number, area: Rect) => void;
}

/** A font the renderer can draw: outlines in font units (y up) and advances; kerning when it has it. */
export interface GlyphFont {
  name: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyph(cp: number): { contours: Pt[][]; advance: number };
  /** Pair adjustment in font units (negative pulls the pair together). */
  kern?(left: number, right: number): number;
  /**
   * Roblox's own fonts (the UI Lab's faces): pixels per font unit at a TextSize (Roblox fits ascender−descender to
   * the TextSize), the TextSize multiplier the family is drawn at, and italic made by slanting an upright face. Their
   * text also advances on Roblox's whole-pixel pen.
   */
  pxPerUnit?(size: number): number;
  sizeScale?: number;
  synthItalic?: boolean;
}

/** The pen Roblox moves text on: each glyph's advance rounds up from a tenth of a pixel (UI Lab, fitted to TextBounds). */
const ROBLOX_PEN_BIAS = 0.9;
const unitScale = (font: GlyphFont, size: number): number => (font.pxPerUnit ? font.pxPerUnit(size) : size / font.unitsPerEm);

/** Picks the font a text is drawn in, and names it for the picture's notes. */
export type FontPicker = (font: string | undefined, bold: boolean, italic: boolean, weight?: number) => { font: GlyphFont | null; standIn: string };

/** A screen to draw on: a device's id, or any screen in points (with a name for captions). */
export type RenderScreen = UiDevice | (UiScreen & { label?: string });
export const screenOf = (d: RenderScreen): UiScreen & { label?: string } => (typeof d === 'string' ? UI_DEVICES[d] : d);
const standInFonts: FontPicker = (font, bold, italic) => fontFor(font, bold, italic);

export interface UiRender {
  image: RgbaImage;
  /** Picture pixels per point. */
  scale: number;
  /** The part of the screen drawn, in points. */
  region: Rect;
  /** Where the screen's point (0, 0) of the region lands in the picture (the rulers take the top and left). */
  origin: [number, number];
  /** Fonts drawn as stand-ins (Roblox's own aren't on this machine), images that were placeholders. */
  notes: string[];
}

export type Mat = [number, number, number, number, number, number];
const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mul = (a: Mat, b: Mat): Mat => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const invert = (m: Mat): Mat => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const rotateAbout = (deg: number, cx: number, cy: number): Mat => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return mul(translate(cx, cy), mul([c, s, -s, c, 0, 0], translate(-cx, -cy)));
};

const c01 = (c: RGB): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];
const RULER = 22;
const CAPTION = 24;

/** The default picture scale for a device: its screen at about 1,440 pixels across at most. */
export const defaultScale = (device: RenderScreen): number => (screenOf(device).w > 1400 ? 0.75 : 1);

export { withState };

/** The screens with elements in their states and hidden ones shown (copies; ids kept). Paths that match nothing are returned. */
function prepare(screens: UiNode[], states: Record<string, UiStateName>, show: string[]): { screens: UiNode[]; showIds: Set<number>; unknown: string[] } {
  const want = new Set([...Object.keys(states), ...show]);
  const found = new Set<string>();
  const showIds = new Set<number>();
  const walk = (n: UiNode, path: string): UiNode => {
    let out = n;
    if (want.has(path)) found.add(path);
    if (states[path]) out = withState(out, states[path]!);
    else if (n.state && n.states?.[n.state]) out = withState(out, n.state);
    if (show.includes(path)) {
      showIds.add(n.id);
      if (out.enabled === false) out = { ...out, enabled: true };
    }
    // The state's own kids (a state's art is on its "Skin" child).
    if (out.kids?.length) out = { ...out, kids: out.kids.map((c) => walk(c, `${path}.${c.name}`)) };
    return out;
  };
  const next = screens.map((s) => walk(s, s.name));
  return { screens: next, showIds, unknown: [...want].filter((p) => !found.has(p)) };
}

/** Value of a gradient at local (u, v) in 0..1 of the element: colour multipliers and how much it lets through. */
function gradientAt(g: UiGradient, u: number, v: number, out: Float32Array): void {
  const ux = u - 0.5 - (g.offset?.[0] ?? 0);
  const vy = v - 0.5 - (g.offset?.[1] ?? 0);
  let t: number;
  const r = (g.rot * Math.PI) / 180;
  if (g.type === 'Radial') t = 2 * Math.hypot(ux, vy);
  else if (g.type === 'Conical') {
    const a = Math.atan2(vy, ux) - r;
    t = (((a / (2 * Math.PI)) % 1) + 1) % 1;
  } else t = 0.5 + ux * Math.cos(r) + vy * Math.sin(r);
  t = Math.max(0, Math.min(1, t));
  const keys = g.colors;
  if (keys.length) {
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1]![0] <= t) i++;
    const a = keys[i]!;
    const b = keys[Math.min(i + 1, keys.length - 1)]!;
    const f = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
    out[0] = (a[1] + (b[1] - a[1]) * f) / 255;
    out[1] = (a[2] + (b[2] - a[2]) * f) / 255;
    out[2] = (a[3] + (b[3] - a[3]) * f) / 255;
  } else out[0] = out[1] = out[2] = 1;
  const tr = g.transp;
  if (tr?.length) {
    let i = 0;
    while (i < tr.length - 1 && tr[i + 1]![0] <= t) i++;
    const a = tr[i]!;
    const b = tr[Math.min(i + 1, tr.length - 1)]!;
    const f = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
    out[3] = 1 - (a[1] + (b[1] - a[1]) * f);
  } else out[3] = 1;
}

// ─── Text ─────────────────────────────────────────────────────────────────────────────────────────

interface Run {
  ch: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  color: RGB | null;
  /** Rich text's <font transparency> (0..1). */
  t: number;
  size: number | null;
  stroke: { color: RGB; px: number; t: number } | null;
  upper: boolean;
}

const hexRgb = (s: string | undefined): RGB | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s?.trim() ?? '') ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s?.trim() ?? '');
  if (!m) {
    const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(s?.trim() ?? '');
    return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
  }
  if (m.length === 2) return [parseInt(m[1]!.slice(0, 2), 16), parseInt(m[1]!.slice(2, 4), 16), parseInt(m[1]!.slice(4, 6), 16)];
  return [parseInt(m[1]! + m[1]!, 16), parseInt(m[2]! + m[2]!, 16), parseInt(m[3]! + m[3]!, 16)];
};

/** Roblox rich text as one styled run per character (the tags Roblox knows; others are left as text). */
export function richRuns(src: string, rich: boolean): Run[] {
  const plain: Run = { ch: '', bold: false, italic: false, strike: false, underline: false, color: null, t: 0, size: null, stroke: null, upper: false };
  if (!rich) return [...src].map((ch) => ({ ...plain, ch }));
  const out: Run[] = [];
  const stack: Array<Partial<Run>> = [];
  const style = (): Run => Object.assign({}, plain, ...stack) as Run;
  const re = /<\s*(\/?)\s*([a-z]+)([^>]*)>/gi;
  let last = 0;
  const push = (text: string) => {
    const t = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const s = style();
    for (const ch of t) out.push({ ...s, ch: s.upper ? ch.toUpperCase() : ch });
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    push(src.slice(last, m.index));
    last = re.lastIndex;
    const [, close, tag, attrs] = m;
    const name = tag!.toLowerCase();
    if (name === 'br') {
      out.push({ ...style(), ch: '\n' });
      continue;
    }
    if (close) {
      stack.pop();
      continue;
    }
    const attr = (a: string) => new RegExp(`${a}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs ?? '')?.[1];
    const s: Partial<Run> = {};
    if (name === 'b') s.bold = true;
    else if (name === 'i') s.italic = true;
    else if (name === 'u') s.underline = true;
    else if (name === 's') s.strike = true;
    else if (name === 'uc' || name === 'uppercase') s.upper = true;
    else if (name === 'font') {
      const c = hexRgb(attr('color'));
      if (c) s.color = c;
      const size = Number(attr('size'));
      if (size > 0 && size < 400) s.size = size;
      const w = attr('weight');
      if (w && /bold|heavy|black|[6-9]00/i.test(w)) s.bold = true;
      const tr = Number(attr('transparency'));
      if (Number.isFinite(tr)) s.t = Math.max(0, Math.min(1, tr));
    } else if (name === 'stroke') {
      s.stroke = { color: hexRgb(attr('color')) ?? [0, 0, 0], px: Number(attr('thickness')) || 1, t: Math.max(0, Math.min(1, Number(attr('transparency')) || 0)) };
    }
    stack.push(s);
  }
  push(src.slice(last));
  return out;
}

interface Laid {
  font: GlyphFont | null;
  run: Run;
  x: number;
  baseline: number;
  size: number;
  advance: number;
}

/** Glyph outlines (picture coordinates) for laid-out characters. */
function glyphContours(chars: Laid[], to: (x: number, y: number) => Pt): Pt[][] {
  const out: Pt[][] = [];
  for (const c of chars) {
    if (c.run.ch === ' ' || c.run.ch === '\n') continue;
    if (!c.font) {
      // No font: a block the size of the letter.
      const tall = /[A-Z0-9bdfhklt]/.test(c.run.ch) ? 0.7 : 0.5;
      const x0 = c.x + c.size * 0.06;
      const x1 = c.x + c.advance - c.size * 0.06;
      out.push([to(x0, c.baseline - c.size * tall), to(x1, c.baseline - c.size * tall), to(x1, c.baseline), to(x0, c.baseline)]);
      continue;
    }
    const g = c.font.glyph(c.run.ch.codePointAt(0)!);
    const k = unitScale(c.font, c.size);
    const slant = c.run.italic && (c.font.synthItalic ?? !/i\.ttf$|z\.ttf$|bli\.ttf$|sbi\.ttf$/i.test(c.font.name)) ? 0.2 : 0;
    for (const contour of g.contours) out.push(contour.map(([gx, gy]) => to(c.x + gx * k + gy * k * slant, c.baseline - gy * k)));
  }
  return out;
}

// ─── Drawing ──────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  c: Raster;
  view: Mat;
  scale: number;
  images: UiRenderOptions['images'];
  notes: Set<string>;
  bounds: Rect;
  measure: Measure;
  fonts: FontPicker;
  baseline: NonNullable<UiRenderOptions['baseline']> | null;
}

/** An element's outline in its own points: its shape, else its rectangle with its corners. */
function outlineOf(n: UiNode, w: number, h: number, k: number, grow = 0): Pt[] {
  if (n.shape && (n.shape.cut || n.shape.slant)) {
    const poly = shapePolygon(n.shape, w, h, k);
    if (!grow) return poly;
    // Grown outward from its centre of mass (a convex shape stays the same shape).
    const cx = poly.reduce((t, p) => t + p[0], 0) / poly.length;
    const cy = poly.reduce((t, p) => t + p[1], 0) / poly.length;
    return poly.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      return [x + ((x - cx) / d) * grow, y + ((y - cy) / d) * grow] as Pt;
    });
  }
  const r = (u: [number, number] | undefined) => (u ? Math.max(0, u[0] * Math.min(w, h) + u[1] * k) : 0);
  const radii: [number, number, number, number] = n.corners ? [r(n.corners[0]), r(n.corners[1]), r(n.corners[2]), r(n.corners[3])] : [r(n.corner), r(n.corner), r(n.corner), r(n.corner)];
  return roundedRect(-grow, -grow, w + 2 * grow, h + 2 * grow, radii.map((x) => (x > 0 ? x + grow : 0)) as [number, number, number, number]);
}

function drawElement(ctx: Ctx, b: UiBox, world: Mat, clip: Rect | null): void {
  const n = b.node;
  const { c, scale } = ctx;
  const w = b.w;
  const h = b.h;
  if (w <= 0 || h <= 0) return;
  const k = b.k || 1;
  const F = mul(ctx.view, mul(world, translate(b.x, b.y)));
  const inv = invert(F);
  const toPic = (pts: Pt[]): Pt[] => pts.map(([x, y]) => apply(F, x, y));
  const bounds = clip ? intersectRect(ctx.bounds, clip) : ctx.bounds;
  if (bounds.w <= 0 || bounds.h <= 0) return;
  const outline = toPic(outlineOf(n, w, h, k));
  const body = fillMask([wound(outline, 1)], bounds);
  const g = new Float32Array(4);
  const local = (x: number, y: number): Pt => apply(inv, x, y);
  const grad = n.gradient;
  /** A shader for a colour (× the element's gradient) with an opacity. */
  const tinted = (col: RGB, alpha: number, gradient: UiGradient | undefined = grad): Shader | [number, number, number, number] => {
    const [r0, g0, b0] = c01(col);
    if (!gradient) return [r0, g0, b0, alpha];
    return (x, y, out) => {
      const [lx, ly] = local(x, y);
      gradientAt(gradient, lx / w, ly / h, g);
      out[0] = r0 * g[0]!;
      out[1] = g0 * g[1]!;
      out[2] = b0 * g[2]!;
      out[3] = alpha * g[3]!;
    };
  };
  const strokes = strokesOf(n);
  const bodyBand = (s: UiStroke): Mask | null => {
    const px = s.px * k * scale;
    if (px <= 0) return null;
    const pos = s.pos ?? 'Outer';
    const band = fillMask(strokeOutline([outline], pos === 'Center' ? px / 2 : px), bounds);
    if (!band) return null;
    return pos === 'Center' ? band : maskTimes(band, body, pos === 'Outer');
  };

  // UIShadow: under the element, cut out where the element is.
  if (n.shadow && n.shadow.t < 1) {
    const s = n.shadow;
    const grown = toPic(outlineOf({ ...n, shape: undefined }, w, h, k, (s.spread ?? 0) * k));
    const m = fillMask([wound(grown, 1)], { x: -1e5, y: -1e5, w: 2e5, h: 2e5 });
    if (m) {
      const dx = (s.offset?.[0] ?? 0) * k * scale;
      const dy = (s.offset?.[1] ?? 0) * k * scale;
      const blurred = blurMask(moveMask(m, dx, dy), Math.max(0.5, (s.blur * k * scale) / 2), bounds);
      const shown = body ? maskTimes(blurred, body, true) : blurred;
      paint(c, shown, [...c01(s.color), 1 - s.t] as [number, number, number, number]);
    }
  }
  // Background (and the legacy border).
  const bgA = n.bg ? 1 - (n.bgT ?? 0) : 0;
  if (body && n.bg && bgA > 0) paint(c, body, tinted(n.bg, bgA));
  if (n.bg && bgA > 0 && n.border && n.border > 0 && !n.shape) {
    const ring = fillMask(strokeOutline([toPic(roundedRect(0, 0, w, h))], n.border * k * scale), bounds);
    if (ring) paint(c, maskTimes(ring, fillMask([wound(toPic(roundedRect(0, 0, w, h)), 1)], bounds), true), [...c01(n.borderColor ?? [27, 42, 53]), bgA] as [number, number, number, number]);
  }
  // The image.
  if ((n.cls === 'ImageLabel' || n.cls === 'ImageButton') && n.image && body) drawImage(ctx, n, w, h, k, F, body, grad);
  // UIStrokes round the box, lowest ZIndex first.
  for (const s of strokes) {
    if (s.text && isText(n)) continue;
    if (s.t >= 1) continue;
    const band = bodyBand(s);
    if (band) paint(c, band, tinted(s.color, 1 - s.t, s.gradient));
  }
  // Text.
  if (isText(n)) drawText(ctx, n, b, w, h, k, F, bounds, tinted);
}

const crops = new WeakMap<RgbaImage, Map<string, RgbaImage>>();
/** A rectangle of an image (cached per image). */
function cropImage(img: RgbaImage, r: [number, number, number, number]): RgbaImage {
  const key = r.join(',');
  let m = crops.get(img);
  if (!m) crops.set(img, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const x0 = Math.max(0, Math.round(r[0]));
  const y0 = Math.max(0, Math.round(r[1]));
  const w = Math.max(1, Math.min(img.width - x0, Math.round(r[2])));
  const h = Math.max(1, Math.min(img.height - y0, Math.round(r[3])));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  const out = { width: w, height: h, data };
  m.set(key, out);
  return out;
}

function drawImage(ctx: Ctx, n: UiNode, w: number, h: number, k: number, F: Mat, body: Mask, grad: UiGradient | undefined): void {
  const { c, scale } = ctx;
  const inv = invert(F);
  const want = Math.ceil(Math.max(w, h) * scale);
  const whole = ctx.images?.(n.image!, want) ?? null;
  // ImageRectOffset/Size: the part of the image shown (a sprite in an atlas); a 9-slice's centre is within it.
  const img = whole && n.rect ? cropImage(whole, n.rect) : whole;
  const tint = c01(n.imageColor ?? [255, 255, 255]);
  const alpha = 1 - (n.imageT ?? 0);
  const g = new Float32Array(4);
  if (!img) {
    // Not available here (a built-in texture, offline, not uploaded): show where it goes.
    ctx.notes.add(`${n.image} drawn as a placeholder`);
    paint(c, body, (x, y, out) => {
      const [lx, ly] = apply(inv, x, y);
      const stripe = Math.floor(((lx + ly) * scale) / 6) % 2 === 0;
      out[0] = tint[0];
      out[1] = tint[1];
      out[2] = tint[2];
      out[3] = (stripe ? 0.18 : 0.06) * alpha;
    });
    return;
  }
  // Roblox scales images over 1024 px a side down when it loads them (measured: a 9-slice then loses its far edges).
  if (Math.max(img.width, img.height) > 1024) ctx.notes.add(`${n.image} is ${img.width}×${img.height} px: Roblox shrinks images over 1024 px a side${n.scaleType === 'Slice' ? ' and this 9-slice loses its right and bottom edges' : ''}`);
  // Where the image lands in the box (Fit and Crop keep its proportions).
  const ia = img.width / Math.max(1, img.height);
  let ix = 0;
  let iy = 0;
  let iw = w;
  let ih = h;
  if (n.scaleType === 'Fit' || n.scaleType === 'Crop') {
    const fitW = n.scaleType === 'Fit' ? w / h < ia : w / h > ia;
    iw = fitW ? w : h * ia;
    ih = fitW ? w / ia : h;
    ix = (w - iw) / 2;
    iy = (h - ih) / 2;
  }
  const sample = sampler(img, img.width / Math.max(1, iw * scale));
  const px = new Float32Array(4);
  const slice = n.scaleType === 'Slice' && n.slice ? n.slice : null;
  /** A local coordinate across the box to a coordinate across the image (9-slice: the middle stretches, the edges keep their size). */
  const sk = k * (n.sliceScale ?? 1);
  const sliced = (l: number, size: number, lo: number, hi: number, full: number): number => {
    const a = lo * sk;
    const b = (full - hi) * sk;
    if (l < a) return l / sk;
    if (l > size - b) return hi + (l - (size - b)) / sk;
    // Measured in Studio: Roblox never shrinks a 9-slice's centre. With more image pixels than points to fill, it
    // shows them one per point from the centre's top-left and crops the rest (SliceScale scales the corners only).
    const centre = size - a - b;
    if (centre < hi - lo) return lo + (l - a);
    return lo + ((l - a) / Math.max(1e-6, centre)) * (hi - lo);
  };
  paint(c, body, (x, y, out) => {
    const [lx, ly] = apply(inv, x, y);
    let u: number;
    let v: number;
    if (slice) {
      u = sliced(lx, w, slice[0], slice[2], img.width) / img.width;
      v = sliced(ly, h, slice[1], slice[3], img.height) / img.height;
    } else {
      u = (lx - ix) / iw;
      v = (ly - iy) / ih;
      if (u < 0 || v < 0 || u > 1 || v > 1) {
        out[3] = 0;
        return;
      }
    }
    sample(u, v, px);
    let a = px[3]! * alpha;
    let mr = 1;
    let mg = 1;
    let mb = 1;
    if (grad) {
      gradientAt(grad, lx / w, ly / h, g);
      [mr, mg, mb] = [g[0]!, g[1]!, g[2]!];
      a *= g[3]!;
    }
    out[0] = px[0]! * tint[0] * mr;
    out[1] = px[1]! * tint[1] * mg;
    out[2] = px[2]! * tint[2] * mb;
    out[3] = a;
  });
}

function drawText(ctx: Ctx, n: UiNode, b: UiBox, w: number, h: number, k: number, F: Mat, bounds: Rect, tinted: (col: RGB, alpha: number, gradient?: UiGradient) => Shader | [number, number, number, number]): void {
  const raw = n.text ?? '';
  if (!raw.trim()) return;
  const size = b.fontSize;
  if (size <= 0) return;
  const pad = n.padding;
  const u = (d: [number, number] | undefined, len: number) => (d ? d[0] * len + d[1] * k : 0);
  const [pt, pr, pb, pl] = pad ? [u(pad[0], h), u(pad[1], w), u(pad[2], h), u(pad[3], w)] : [0, 0, 0, 0];
  const areaW = Math.max(1, w - pl - pr);
  const areaH = Math.max(1, h - pt - pb);
  const runs = richRuns(raw, !!n.rich);
  const text = runs.map((r) => r.ch).join('');
  const lineTexts = n.wrapped || n.scaled ? wrapText(text, size, areaW, n, ctx.measure) : text.split('\n');
  // Map the wrapped lines back onto the runs (wrapping only drops the spaces it breaks at).
  const lines: Run[][] = [];
  let at = 0;
  for (const lt of lineTexts) {
    while (at < runs.length && (runs[at]!.ch === ' ' || runs[at]!.ch === '\n') && lt[0] !== runs[at]!.ch) at++;
    lines.push(runs.slice(at, at + [...lt].length));
    at += [...lt].length;
  }
  const choose = (r: Run) => ctx.fonts(n.font, !!(n.bold || r.bold), !!(n.italic || r.italic), r.bold && !n.bold ? 700 : n.weight);
  const main = ctx.fonts(n.font, !!n.bold, !!n.italic, n.weight).font;
  const lineH = size * (main?.sizeScale ?? 1) * (n.lineHeight ?? 1);
  const blockH = lines.length * lineH;
  let top = pt + (n.yAlign === 'Top' ? 0 : n.yAlign === 'Bottom' ? areaH - blockH : (areaH - blockH) / 2);
  const laid: Laid[] = [];
  for (const line of lines) {
    let chars = line.map((r) => {
      const f = choose(r);
      const s = r.size ? r.size * k : size;
      const advance = f.font ? f.font.glyph(r.ch.codePointAt(0) ?? 32).advance * unitScale(f.font, s) : estimateText(r.ch, s, n);
      // The label's own italic (FontFace Style) slants every run, as a rich-text <i> does one (Studio synthesises it
      // for a family without an italic face).
      return { font: f.font, standIn: f.standIn, run: n.italic && !r.italic ? { ...r, italic: true } : r, size: s, advance, shift: 0 };
    });
    // A pair's kerning moves the second glyph and joins its step, as Roblox's TextBounds add up (roblox-fonts.ts
    // placeLine): the same order keeps the whole-pixel pen, and so the width, identical to the measure.
    for (let i = 1; i < chars.length; i++) {
      const a = chars[i - 1]!;
      const b = chars[i]!;
      if (b.font && a.font === b.font && b.font.kern) {
        const k = b.font.kern(a.run.ch.codePointAt(0) ?? 32, b.run.ch.codePointAt(0) ?? 32) * unitScale(b.font, b.size);
        b.advance += k;
        b.shift = k;
      }
    }
    // Where each character starts on the line: Roblox's fonts move a whole-pixel pen (as their TextBounds add up).
    const penOf = (list: typeof chars): { xs: number[]; width: number } => {
      const xs: number[] = [];
      let pen = 0;
      for (const ch of list) {
        xs.push(pen);
        pen = ch.font?.pxPerUnit ? Math.floor(pen + ch.advance + ROBLOX_PEN_BIAS) : pen + ch.advance;
      }
      return { xs, width: pen };
    };
    let width = penOf(chars).width;
    if (n.truncate && !n.wrapped && !n.scaled && width > areaW + 0.5) {
      const ell = chars[chars.length - 1] ? { ...chars[chars.length - 1]!, shift: 0, run: { ...chars[chars.length - 1]!.run, ch: '…' } } : null;
      const ellW = ell?.font ? ell.font.glyph(0x2026).advance * unitScale(ell.font, ell.size) : size * 0.8;
      while (chars.length && penOf(chars).width + ellW > areaW) chars.pop();
      if (ell) chars = [...chars, { ...ell, advance: ellW }];
      width = penOf(chars).width;
    }
    const x0 = pl + (n.xAlign === 'Left' ? 0 : n.xAlign === 'Right' ? areaW - width : (areaW - width) / 2);
    // Roblox's fonts: the ascender−descender box fills the TextSize, so the baseline is the ascender down from the
    // line's top (measured); stand-ins: capitals centred on the line, as Roblox's fonts sit.
    const baseline =
      top +
      (ctx.baseline
        ? ctx.baseline(main, size, lineH)
        : main?.pxPerUnit
          ? (lineH - size * (main.sizeScale ?? 1)) / 2 + main.ascender * main.pxPerUnit(size)
          : lineH / 2 + size * 0.35);
    const { xs } = penOf(chars);
    chars.forEach((ch, i) => {
      laid.push({ font: ch.font, run: ch.run, x: x0 + xs[i]! + ch.shift, baseline, size: ch.size, advance: ch.advance });
      if (ch.standIn) ctx.notes.add(`text in ${ch.standIn} for ${n.font ?? 'BuilderSans'}`);
    });
    top += lineH;
  }
  const to = (x: number, y: number): Pt => apply(F, x, y);
  const scale = ctx.scale;
  // Strike and underline as bars.
  const bars = (list: Laid[]): Pt[][] =>
    list.flatMap((c) => {
      const out: Pt[][] = [];
      const th = Math.max(1 / scale, c.size * 0.07);
      if (c.run.strike) out.push(wound([to(c.x, c.baseline - c.size * 0.3), to(c.x + c.advance, c.baseline - c.size * 0.3), to(c.x + c.advance, c.baseline - c.size * 0.3 + th), to(c.x, c.baseline - c.size * 0.3 + th)], 1));
      if (c.run.underline) out.push(wound([to(c.x, c.baseline + c.size * 0.08), to(c.x + c.advance, c.baseline + c.size * 0.08), to(c.x + c.advance, c.baseline + c.size * 0.08 + th), to(c.x, c.baseline + c.size * 0.08 + th)], 1));
      return out;
    });
  // One mask per look (colour, transparency, stroke), so rich text keeps its colours.
  const groups = new Map<string, Laid[]>();
  for (const c of laid) {
    const key = `${c.run.color?.join(',') ?? ''}|${c.run.t}|${c.run.stroke ? `${c.run.stroke.color.join(',')}/${c.run.stroke.px}/${c.run.stroke.t}` : ''}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const textA = 1 - (n.textT ?? 0);
  const textStrokes = strokesOf(n).filter((s) => s.text && s.t < 1);
  for (const list of groups.values()) {
    const contours = [...glyphContours(list, to), ...bars(list)];
    if (!contours.length) continue;
    const first = list[0]!.run;
    // Outlines behind the letters: UIStroke Contextual (several by ZIndex), rich text's <stroke>, the legacy TextStroke.
    const outlines: Array<{ px: number; color: RGB; t: number; gradient?: UiGradient }> = [
      ...(n.strokeT !== undefined && n.strokeT < 1 ? [{ px: Math.max(1, size / 14) / 2 / k, color: n.strokeColor ?? [0, 0, 0], t: n.strokeT }] : []),
      ...textStrokes.map((s) => ({ px: s.px, color: s.color, t: s.t, ...(s.gradient ? { gradient: s.gradient } : {}) })),
      ...(first.stroke ? [{ px: first.stroke.px, color: first.stroke.color, t: first.stroke.t }] : []),
    ];
    for (const o of outlines) {
      const band = fillMask(strokeOutline(contours, o.px * k * scale), bounds);
      if (band) paint(ctx.c, band, tinted(o.color, (1 - o.t) * (1 - first.t), o.gradient));
    }
    const mask = fillMask(contours, bounds);
    if (mask) paint(ctx.c, mask, tinted(first.color ?? n.textColor ?? [0, 0, 0], textA * (1 - first.t)));
  }
}

const intersectRect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};

// ─── Labels in a system font (captions, glyph sheets) ─────────────────────────────────────────────

/** A line of text in the stand-in for BuilderSans (or the pixel font): for captions and sheets. Returns its width. */
export function drawLabel(c: Raster, text: string, x: number, y: number, size: number, color: [number, number, number], opts: { bold?: boolean; maxWidth?: number } = {}): number {
  const f = fontFor('BuilderSans', opts.bold, false).font;
  if (!f) {
    const digits = text.replace(/[^0-9.×, -]/g, '');
    pixelText(c, digits, Math.round(x), Math.round(y + size * 0.15), color, Math.max(1, Math.round(size / 8)));
    return digits.length * 4 * Math.max(1, Math.round(size / 8));
  }
  const k = size / f.unitsPerEm;
  let pen = x;
  const contours: Pt[][] = [];
  const baseline = y + size * 0.8;
  for (const ch of text) {
    const g = f.glyph(ch.codePointAt(0)!);
    if (opts.maxWidth && pen + g.advance * k > x + opts.maxWidth) break;
    for (const contour of g.contours) contours.push(contour.map(([gx, gy]) => [pen + gx * k, baseline - gy * k] as Pt));
    pen += g.advance * k;
  }
  const m = contours.length ? fillMask(contours, { x: 0, y: 0, w: c.w, h: c.h }) : null;
  if (m) paint(c, m, [...color, 1]);
  return pen - x;
}

// ─── A device ─────────────────────────────────────────────────────────────────────────────────────

function drawBackdrop(c: Raster, area: Rect, backdrop: Backdrop): void {
  const { x: ax, y: ay, w: aw, h: ah } = area;
  if (typeof backdrop === 'object') {
    // The game's picture, cropped to fill.
    const s = sampler(backdrop, backdrop.width / aw);
    const ia = backdrop.width / backdrop.height;
    const fitW = aw / ah > ia;
    const iw = fitW ? aw : ah * ia;
    const ih = fitW ? aw / ia : ah;
    const px = new Float32Array(4);
    for (let y = 0; y < ah; y++)
      for (let x = 0; x < aw; x++) {
        s((x + (iw - aw) / 2) / iw, (y + (ih - ah) / 2) / ih, px);
        c.rgb.set([px[0]! * 0.85, px[1]! * 0.85, px[2]! * 0.85], ((ay + y) * c.w + ax + x) * 3);
      }
    return;
  }
  for (let y = 0; y < ah; y++)
    for (let x = 0; x < aw; x++) {
      let col: [number, number, number];
      if (backdrop === 'bright') {
        // A daylight scene: sky above, sunlit grass below.
        const t = y / ah;
        col = t < 0.55 ? [0.55 + 0.25 * t, 0.75 + 0.2 * t, 0.98] : [0.42 - 0.1 * (t - 0.55), 0.68 - 0.15 * (t - 0.55), 0.3];
      } else {
        // The UI page's backdrop: a slate radial (#3c4a5c to #161b22).
        const d = Math.min(1, Math.hypot((x - aw / 2) / aw, (y - ah * 0.35) / ah) / 0.7);
        col = [0.235 + (0.086 - 0.235) * d, 0.29 + (0.106 - 0.29) * d, 0.361 + (0.133 - 0.361) * d];
      }
      c.rgb.set(col, ((ay + y) * c.w + ax + x) * 3);
    }
}

/** Roblox's top bar buttons, a phone's notch and home bar, a TV's safe area: on top, as the player sees them. */
function drawGuides(c: Raster, dev: UiScreen, view: Mat, scale: number, area: Rect): void {
  const rect = (x: number, y: number, w: number, h: number, col: [number, number, number, number]) => {
    const m = fillMask([wound([apply(view, x, y), apply(view, x + w, y), apply(view, x + w, y + h), apply(view, x, y + h)], 1)], area);
    if (m) paint(c, m, col);
  };
  const top = dev.top ?? 0;
  if (dev.top) rect(0, 0, dev.w, dev.top, [0, 0, 0, 0.3]);
  if (dev.bottom) {
    rect(0, dev.h - dev.bottom, dev.w, dev.bottom, [0, 0, 0, 0.3]);
    rect(dev.w / 2 - 67, dev.h - dev.bottom / 2 - 2.5, 134, 5, [1, 1, 1, 0.5]);
  }
  if (dev.side) {
    rect(0, 0, dev.side, dev.h, [0, 0, 0, 0.25]);
    rect(dev.w - dev.side, 0, dev.side, dev.h, [0, 0, 0, 0.25]);
  }
  // The top bar's lower edge, dashed.
  const tb = top + (dev.topbar ?? TOPBAR);
  for (let x = 0; x < dev.w; x += 12) rect(x, tb - 0.5, 6, 1 / scale, [1, 1, 1, 0.22]);
  // Its buttons: two at the left (menu, chat), one at the right.
  const dot = (cx: number, cy: number) => {
    const [px, py] = apply(view, cx, cy);
    const m = fillMask([circle(px, py, 18 * scale)], area);
    if (m) paint(c, m, [0, 0, 0, 0.45]);
  };
  dot(16 + 18, top + 11 + 18);
  dot(16 + 36 + 8 + 18, top + 11 + 18);
  dot(dev.w - 16 - 18, top + 11 + 18);
  if (dev.tenFoot) {
    const x0 = dev.w * 0.05;
    const y0 = dev.h * 0.05;
    for (let x = x0; x < dev.w - x0; x += 14) {
      rect(x, y0, 7, 1 / scale, [1, 1, 1, 0.25]);
      rect(x, dev.h - y0, 7, 1 / scale, [1, 1, 1, 0.25]);
    }
    for (let y = y0; y < dev.h - y0; y += 14) {
      rect(x0, y, 1 / scale, 7, [1, 1, 1, 0.25]);
      rect(dev.w - x0, y, 1 / scale, 7, [1, 1, 1, 0.25]);
    }
  }
}

/** Ticks every 50 points, numbers every 100 (or 200 when they would crowd). */
function drawRulers(c: Raster, region: Rect, scale: number, ox: number, oy: number): void {
  const ink: [number, number, number] = [0.62, 0.6, 0.58];
  for (let i = 0; i < c.w * RULER; i++) c.rgb.set([0.09, 0.085, 0.08], i * 3);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < RULER; x++) c.rgb.set([0.09, 0.085, 0.08], (y * c.w + x) * 3);
  const step = scale * 100 < 46 ? 200 : 100;
  const tick = (x: number, y: number, w: number, h: number) => {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(c.h, Math.round(y + h)); yy++) for (let xx = Math.max(0, Math.round(x)); xx < Math.min(c.w, Math.round(x + w)); xx++) c.rgb.set(ink, (yy * c.w + xx) * 3);
  };
  const first = (v: number) => Math.ceil(v / 50) * 50;
  for (let p = first(region.x); p <= region.x + region.w; p += 50) {
    const x = ox + (p - region.x) * scale;
    const major = p % step === 0;
    tick(x, major ? 8 : 15, 1, major ? 14 : 7);
    if (major) pixelText(c, String(p), Math.round(x) + 3, 3, ink, 1);
  }
  for (let p = first(region.y); p <= region.y + region.h; p += 50) {
    const y = oy + (p - region.y) * scale;
    const major = p % step === 0;
    tick(major ? 8 : 15, y, major ? 14 : 7, 1);
    if (major) pixelText(c, String(p), 2, Math.round(y) + 3, ink, 1);
  }
}

/**
 * The screens on a device as a player would see them, as a picture: the elements laid out by the audit's
 * engine and drawn with what the format describes, the device's guides, rulers in points and a caption.
 */
export function renderUi(screens: UiNode[], device: RenderScreen, o: UiRenderOptions = {}): UiRender & { unknown: string[] } {
  const dev: UiScreen = screenOf(device);
  const measure = o.measure ?? estimateText;
  const prepared = prepare(screens, o.states ?? {}, o.show ?? []);
  const shown = prepared.screens.filter((s) => s.enabled !== false || prepared.showIds.has(s.id)).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  const laid = shown.map((s) => layoutScreen(s, dev, { measure, show: prepared.showIds }));
  let region: Rect = o.region ?? { x: 0, y: 0, w: dev.w, h: dev.h };
  let scale = o.scale ?? (o.region ? Math.max(1, Math.min(4, 720 / o.region.w, 480 / o.region.h)) : defaultScale(device));
  const unknown = [...prepared.unknown];
  if (o.focus && !o.region) {
    const b = laid.flat().find((x) => x.path === o.focus);
    if (!b) unknown.push(o.focus);
    else {
      const m = Math.max(16, 0.2 * Math.max(b.w, b.h));
      // A turned element's whole extent.
      const r = Math.hypot(b.w, b.h) / 2;
      const turned = b.rot ? { x: b.x + b.w / 2 - r, y: b.y + b.h / 2 - r, w: 2 * r, h: 2 * r } : { x: b.x, y: b.y, w: b.w, h: b.h };
      region = { x: Math.floor(turned.x - m), y: Math.floor(turned.y - m), w: Math.ceil(turned.w + 2 * m), h: Math.ceil(turned.h + 2 * m) };
      scale = o.scale ?? Math.max(1, Math.min(4, 720 / region.w, 480 / region.h));
    }
  }
  const rulers = o.rulers !== false;
  const ox = rulers ? RULER : 0;
  const oy = rulers ? RULER : 0;
  const aw = Math.max(1, Math.round(region.w * scale));
  const ah = Math.max(1, Math.round(region.h * scale));
  const W = ox + aw;
  const H = oy + ah + (o.caption ? CAPTION : 0);
  const c = newRaster(W, H, [0.09, 0.085, 0.08]);
  const area: Rect = { x: ox, y: oy, w: aw, h: ah };
  drawBackdrop(c, area, o.backdrop ?? 'dark');
  const view: Mat = [scale, 0, 0, scale, ox - region.x * scale, oy - region.y * scale];
  const ctx: Ctx = { c, view, scale, images: o.images, notes: new Set(), bounds: area, measure, fonts: o.fonts ?? standInFonts, baseline: o.baseline ?? null };
  for (const boxes of laid) {
    const byPath = new Map<string, Mat>();
    for (const b of boxes) {
      const parent = b.path.slice(0, b.path.lastIndexOf('.'));
      const base = byPath.get(parent) ?? ([1, 0, 0, 1, 0, 0] as Mat);
      const world = b.rot ? mul(base, rotateAbout(b.rot, b.x + b.w / 2, b.y + b.h / 2)) : base;
      byPath.set(b.path, world);
      const clip = b.clip ? { x: ox + (b.clip[0] - region.x) * scale, y: oy + (b.clip[1] - region.y) * scale, w: b.clip[2] * scale, h: b.clip[3] * scale } : null;
      drawElement(ctx, b, world, clip);
    }
  }
  o.overlay?.(c, view, scale, area);
  if (o.guides !== false) drawGuides(c, dev, view, scale, area);
  if (rulers) drawRulers(c, region, scale, ox, oy);
  if (o.caption) {
    for (let i = (oy + ah) * W; i < W * H; i++) c.rgb.set([0.13, 0.12, 0.11], i * 3);
    drawLabel(c, o.caption, ox + 6, oy + ah + 4, 14, [0.85, 0.83, 0.8], { maxWidth: W - ox - 12 });
  }
  return { image: toRgba(c), scale, region, origin: [ox, oy], notes: [...ctx.notes].sort(), unknown };
}

/** Pictures side by side with a label over each (a states sheet, a reference beside a render). */
export function sideBySide(items: Array<{ image: RgbaImage; label: string }>, gap = 12): RgbaImage {
  const label = 22;
  const W = items.reduce((t, i) => t + i.image.width, 0) + gap * (items.length + 1);
  const H = Math.max(...items.map((i) => i.image.height)) + label + gap * 2;
  const c = newRaster(W, H, [0.09, 0.085, 0.08]);
  let x = gap;
  for (const it of items) {
    drawLabel(c, it.label, x, gap - 2, 14, [0.88, 0.86, 0.82], { bold: true, maxWidth: it.image.width });
    for (let y = 0; y < it.image.height; y++)
      for (let xx = 0; xx < it.image.width; xx++) {
        const s = (y * it.image.width + xx) * 4;
        const a = it.image.data[s + 3]! / 255;
        const d = ((gap + label + y) * W + x + xx) * 3;
        for (let k = 0; k < 3; k++) c.rgb[d + k] = c.rgb[d + k]! * (1 - a) + (it.image.data[s + k]! / 255) * a;
      }
    x += it.image.width + gap;
  }
  return toRgba(c);
}
