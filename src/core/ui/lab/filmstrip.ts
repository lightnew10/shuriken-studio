import type { UiBox, UiDevice, UiNode } from '@shared/ui-layout';
import type { MockMotion } from '@shared/ui-mockup';
import type { RgbaImage } from '../../modeling/png';
import { circle, fillMask, newRaster, paint, roundedRect, strokeOutline, toRgba, type Pt, type Raster, type Rect } from '../ui-raster';
import { drawLabel, renderUi, type Backdrop, type UiRenderOptions } from '../ui-render';
import { measureMotion, overshootOf, progressCurve, stillAt, type MotionCurve, type MotionMetrics } from './feel';
import { compileMotion, type CompileOptions, type LabMotion, type LabNode, type MotionTimeline } from './motion-sim';

/**
 * Motion as pictures an agent can read: a contact sheet of frames at the moments that matter (the start, one frame
 * in, the peak of an overshoot, when it is still, the end), each labelled with its time, over a small graph per move
 * (eased progress and speed against time, the frames marked); and an onion skin (several frames over one another,
 * earlier ones fainter, the element's path drawn through them) that shows arcs and overshoot in one picture.
 * Frames are drawn by the core's UI renderer from the timeline's samples; pictures stay small (≈1,000 px wide).
 */

export interface FilmFrame {
  /** Seconds on the timeline. */
  t: number;
  label: string;
  /** The move whose row it is in (a sheet with a row per move). */
  move?: number;
}

export interface FilmstripOptions extends CompileOptions {
  /** How text is measured and drawn (the UI Lab passes Roblox's own fonts). */
  text?: Pick<UiRenderOptions, 'measure' | 'fonts'>;
  /** Frames at these times instead of the key moments. */
  times?: number[];
  /** "auto" (the moving elements, or the whole screen when they cross it), "screen", or an element's path. */
  focus?: 'auto' | 'screen' | string;
  /** The moves whose moments, focus and graphs it shows (indexes; all play). Default: all. */
  only?: number[];
  /** Pixels per frame across (default 220; 300 for the whole screen). */
  frameWidth?: number;
  columns?: number;
  maxFrames?: number;
  /** The widest the sheet gets, in pixels (default 1,100): a row per move keeps as many frames as fit. */
  maxWidth?: number;
  /** A graph per move under the frames (default on). */
  graphs?: boolean;
  backdrop?: Backdrop;
  images?: UiRenderOptions['images'];
  title?: string;
}

export interface Filmstrip {
  image: RgbaImage;
  frames: FilmFrame[];
  /** The part of the screen each frame shows (points) and its pixels per point. */
  region: Rect;
  scale: number;
  /** Each row's region and scale (one entry when the frames share a region). */
  regions: Array<{ move: number | null; region: Rect; scale: number }>;
  timeline: MotionTimeline;
  metrics: MotionMetrics[];
  notes: string[];
}

const INK: [number, number, number] = [0.86, 0.84, 0.8];
const FAINT: [number, number, number] = [0.55, 0.53, 0.5];
const PANEL: [number, number, number] = [0.13, 0.12, 0.11];
const BACK: [number, number, number] = [0.09, 0.085, 0.08];
const CURVE: [number, number, number] = [1, 0.62, 0.2];
const SPEED: [number, number, number] = [0.38, 0.66, 1];
const ms = (s: number) => `${Math.round(s * 1000)} ms`;

/**
 * The moments worth a frame: the start, one frame in, each move's overshoot peak (a kick's biggest swing), when it
 * is still, its end; a loop's quarters; then midpoints where the gaps are widest, up to `max` frames.
 */
export function keyMoments(tl: MotionTimeline, only?: number[], max = 8): FilmFrame[] {
  const spans = tl.spans.filter((s) => !only || only.includes(s.index));
  if (!spans.length) return [{ t: 0, label: 'start' }];
  const t0 = Math.min(...spans.map((s) => s.call));
  const dt = 1 / tl.fps;
  const cand: Array<FilmFrame & { pri: number }> = [
    { t: t0, label: 'start', pri: 0 },
    { t: t0 + dt, label: '+1 frame', pri: 2 },
  ];
  const many = spans.length > 1;
  for (const s of spans) {
    const name = many ? ` · ${s.kind}` : '';
    if (s.loop) {
      const c = s.cycle ?? 1;
      for (const q of [0.25, 0.5, 0.75, 1]) cand.push({ t: s.start + c * q, label: `${q === 1 ? 'cycle' : `${q * 4}/4`}${name}`, pri: q === 0.5 ? 2 : 3 });
      continue;
    }
    if (s.start > t0 + dt * 1.5) cand.push({ t: s.start, label: `starts${name}`, pri: 1 });
    // Moves with phases of their own: a flight's burst, mid-air and landing; a cover's full cover; a stagger's last item.
    const m = tl.motions[s.index]!;
    if (m.kind === 'fly') {
      const secs = m.seconds ?? 0.55;
      cand.push({ t: s.call + 0.25, label: `burst${name}`, pri: 1 }, { t: s.call + 0.3 + secs / 2, label: `mid-air${name}`, pri: 1 }, { t: s.call + 0.3 + secs, label: `lands${name}`, pri: 1 });
    }
    if (m.kind === 'transition' && s.blocks) cand.push({ t: (s.blocks[0] + s.blocks[1]) / 2, label: `covered${name}`, pri: 1 });
    if (m.kind === 'enter' && s.items && s.items > 1 && s.gap) cand.push({ t: s.start + (s.items - 1) * s.gap, label: `last item starts${name}`, pri: 2 });
    const curve = progressCurve(tl, s.index);
    if (curve) {
      const sh = overshootOf(curve);
      if (sh.peakAt !== null && (curve.kick || sh.over > 0.5)) cand.push({ t: sh.peakAt, label: curve.kick ? `peak${name}` : `peak +${Math.round(sh.over)}%${name}`, pri: 1 });
      const still = stillAt(curve);
      if (still !== null && still < s.end - dt) cand.push({ t: still, label: `still${name}`, pri: 3 });
    }
    cand.push({ t: s.end, label: `end${name}`, pri: 1 });
  }
  const pick = (list: typeof cand) => {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    const out: typeof cand = [];
    for (const c of sorted) {
      const near = out.findIndex((o) => Math.abs(o.t - c.t) < dt * 0.6);
      if (near < 0) out.push(c);
      else if (c.pri < out[near]!.pri) out[near] = c;
    }
    return out;
  };
  let frames = pick(cand);
  while (frames.length > max) {
    const worst = frames.reduce((w, f, i) => (f.pri > frames[w]!.pri || (f.pri === frames[w]!.pri && i > w) ? i : w), 0);
    frames.splice(worst, 1);
  }
  // Fill wide gaps with midpoints until there are at least five frames.
  while (frames.length < Math.min(5, max)) {
    let gi = -1;
    let gap = dt * 2;
    for (let i = 0; i + 1 < frames.length; i++) if (frames[i + 1]!.t - frames[i]!.t > gap) [gi, gap] = [i, frames[i + 1]!.t - frames[i]!.t];
    if (gi < 0) break;
    frames = pick([...frames, { t: (frames[gi]!.t + frames[gi + 1]!.t) / 2, label: 'mid', pri: 4 }]);
  }
  return frames.map(({ t, label }) => ({ t, label }));
}

/** Where a box's turned corners reach. */
function extentOf(b: UiBox): Rect {
  const r = (b.rot * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(r)) * b.w + Math.abs(Math.sin(r)) * b.h) / 2;
  const hh = (Math.abs(Math.sin(r)) * b.w + Math.abs(Math.cos(r)) * b.h) / 2;
  return { x: b.x + b.w / 2 - hw, y: b.y + b.h / 2 - hh, w: 2 * hw, h: 2 * hh };
}
const union = (a: Rect | null, b: Rect): Rect => (!a ? b : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) });

/** The part of the screen that shows the moves: their elements over every frame, with room round them. */
function focusRegion(tl: MotionTimeline, frames: FilmFrame[], only: number[] | undefined, focus: FilmstripOptions['focus']): { region: Rect; whole: boolean } {
  const dev = tl.device;
  const whole = { region: { x: 0, y: 0, w: dev.w, h: dev.h }, whole: true };
  if (focus === 'screen') return whole;
  const spans = tl.spans.filter((s) => !only || only.includes(s.index));
  const paths = focus && focus !== 'auto' ? [focus] : spans.some((s) => s.kind === 'fly' || s.kind === 'transition' || s.kind === 'swap') ? null : spans.map((s) => s.primary?.path).filter((p): p is string => !!p);
  if (!paths?.length) return whole;
  let u: Rect | null = null;
  for (const f of frames) for (const b of tl.layoutAt(f.t)) if (paths.includes(b.path) && b.w > 0 && b.h > 0) u = union(u, extentOf(b));
  if (!u || u.w * u.h > 0.45 * dev.w * dev.h) return whole;
  const m = Math.min(60, Math.max(12, 0.2 * Math.max(u.w, u.h)));
  const x0 = Math.max(0, Math.floor(u.x - m));
  const y0 = Math.max(0, Math.floor(u.y - m));
  const x1 = Math.min(dev.w, Math.ceil(u.x + u.w + m));
  const y1 = Math.min(dev.h, Math.ceil(u.y + u.h + m));
  return { region: { x: x0, y: y0, w: Math.max(8, x1 - x0), h: Math.max(8, y1 - y0) }, whole: false };
}

const deviceArg = (tl: MotionTimeline): Parameters<typeof renderUi>[1] => (tl.deviceKey ?? (tl.device as unknown as UiDevice)) as Parameters<typeof renderUi>[1];

/** Copies a picture into a raster at (x, y). */
function blit(c: Raster, img: RgbaImage, x0: number, y0: number, alpha = 1): void {
  for (let y = 0; y < img.height; y++) {
    const py = y0 + y;
    if (py < 0 || py >= c.h) continue;
    for (let x = 0; x < img.width; x++) {
      const px = x0 + x;
      if (px < 0 || px >= c.w) continue;
      const s = (y * img.width + x) * 4;
      const a = (img.data[s + 3]! / 255) * alpha;
      const d = (py * c.w + px) * 3;
      for (let k = 0; k < 3; k++) c.rgb[d + k] = c.rgb[d + k]! * (1 - a) + (img.data[s + k]! / 255) * a;
    }
  }
}

function rect(c: Raster, x: number, y: number, w: number, h: number, col: [number, number, number], a = 1): void {
  const m = fillMask([roundedRect(x, y, w, h)], { x: 0, y: 0, w: c.w, h: c.h });
  if (m) paint(c, m, [...col, a]);
}

function polyline(c: Raster, pts: Pt[], width: number, col: [number, number, number], a = 1, clip?: Rect): void {
  if (pts.length < 2) return;
  const m = fillMask(strokeOutline([pts], width / 2, false), clip ?? { x: 0, y: 0, w: c.w, h: c.h });
  if (m) paint(c, m, [...col, a]);
}

/**
 * A move's graph: eased progress (orange; 0 at the bottom line, the goal on the dotted line, overshoot above it) and
 * speed (blue, scaled to its peak) against time, with the frames' times as ticks; a caption over it.
 */
export function motionGraph(curve: MotionCurve, w: number, h: number, marks: number[], caption: string, sub: string, sub2 = ''): Raster {
  const c = newRaster(w, h, PANEL);
  const top = sub2 ? 42 : 30;
  const pad = 6;
  const pw = w - 2 * pad;
  const ph = h - top - pad;
  drawLabel(c, caption, pad, 2, 12, INK, { bold: true, maxWidth: w - 2 * pad });
  drawLabel(c, sub, pad, 15, 11, FAINT, { maxWidth: w - 2 * pad });
  if (sub2) drawLabel(c, sub2, pad, 27, 11, FAINT, { maxWidth: w - 2 * pad });
  const lo = Math.min(0, ...curve.p) - 0.05;
  const hi = Math.max(1, ...curve.p) + 0.05;
  const t0 = curve.t[0]!;
  const t1 = curve.t[curve.t.length - 1]!;
  const X = (t: number) => pad + ((t - t0) / Math.max(1e-9, t1 - t0)) * pw;
  const Y = (p: number) => top + ph - ((p - lo) / (hi - lo)) * ph;
  rect(c, pad, top, pw, ph, BACK);
  // The start (0) and the goal (1; a kick's rest is 0).
  const ref = curve.kick ? 0 : 1;
  rect(c, pad, Y(0) - 0.5, pw, 1, FAINT, 0.5);
  for (let x = pad; x < pad + pw; x += 6) rect(c, x, Y(ref) - 0.5, 3, 1, INK, 0.55);
  for (const t of marks) if (t >= t0 - 1e-9 && t <= t1 + 1e-9) rect(c, X(t) - 0.5, top, 1, ph, INK, 0.22);
  const vmax = Math.max(1e-9, ...curve.v.map((v) => Math.abs(v)));
  const clip = { x: pad, y: top, w: pw, h: ph };
  polyline(c, curve.t.map((t, i) => [X(t), top + ph - (Math.abs(curve.v[i]!) / vmax) * ph * 0.9] as Pt), 1.2, SPEED, 0.85, clip);
  polyline(c, curve.t.map((t, i) => [X(t), Y(curve.p[i]!)] as Pt), 2, CURVE, 1, clip);
  return c;
}

const blitRaster = (c: Raster, r: Raster, x0: number, y0: number) => {
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (x0 + x < c.w && y0 + y < c.h) c.rgb.set(r.rgb.subarray((y * r.w + x) * 3, (y * r.w + x) * 3 + 3), ((y0 + y) * c.w + x0 + x) * 3);
};

/** A move's caption and summary lines for its graph. */
function graphText(m: MotionMetrics): [string, string, string] {
  const extra: string[] = [];
  if (m.overshootPct !== null && m.overshootPct > 0.5) extra.push(`over +${Math.round(m.overshootPct)}%`);
  if (m.anticipationPct !== null && m.anticipationPct > 0.5) extra.push(`wind-up -${Math.round(m.anticipationPct)}%`);
  if (m.swings !== null) extra.push(`${m.swings} swing${m.swings === 1 ? '' : 's'}`);
  if (m.settle !== null && Math.abs(m.settle - m.duration) > 0.02) extra.push(`still after ${ms(m.settle)}`);
  if (m.delay > 0) extra.push(`delay ${ms(m.delay)}`);
  return [m.label, `${m.easing} · ${m.loop ? `cycle ${ms(m.cycle ?? 0)}` : ms(m.duration)}`, extra.join(' · ')];
}

const GRAPH_H = 118;

/** Renders frames of a timeline as pictures of one region. */
function shots(tl: MotionTimeline, frames: FilmFrame[], region: Rect, scale: number, whole: boolean, o: FilmstripOptions, notes: Set<string>): RgbaImage[] {
  return frames.map((f) => {
    const r = renderUi(tl.sample(f.t) as UiNode[], deviceArg(tl), { region, scale, rulers: false, guides: whole, backdrop: o.backdrop, images: o.images, ...o.text });
    for (const n of r.notes) notes.add(n);
    return r.image;
  });
}

/**
 * The contact sheet. One move (or a focus given, or `times`): frames at its key moments in a grid, labelled with
 * their time from the first call and what the moment is, its graph under them. Several moves: a row per move, each
 * focused on its own element (the whole screen when it crosses it), its graph at the start of the row; every move
 * plays in every frame, as in the game.
 */
export function filmstrip(screens: UiNode[], motions: Array<LabMotion | MockMotion>, o: FilmstripOptions = {}): Filmstrip {
  const tl = compileMotion(screens, motions, o);
  const metrics = tl.spans.map((s) => measureMotion(tl, s.index));
  const chosen = tl.spans.filter((s) => (!o.only || o.only.includes(s.index)) && s.primary).slice(0, 8);
  const notes = new Set<string>();
  const gap = 10;
  const label = 30;
  const title = 26;
  const dev = tl.device;
  const heading = o.title ?? `Motion · ${dev.label ?? `${dev.w}×${dev.h}`}${tl.reduced ? ' · Reduce Motion' : ''} · ${chosen.length} move${chosen.length === 1 ? '' : 's'} · times from the first call`;
  const graphFor = (index: number, w: number, h: number, marks: number[]): Raster | null => {
    const curve = progressCurve(tl, index);
    if (!curve || o.graphs === false) return null;
    const [cap, a, b] = graphText(metrics[index]!);
    return motionGraph(curve, w, h, marks, cap, a, b);
  };
  const together = !!o.times || o.focus === 'screen' || (!!o.focus && o.focus !== 'auto') || chosen.length <= 1;
  if (together) {
    const only = o.only ?? (chosen.length ? chosen.map((s) => s.index) : undefined);
    const frames = o.times ? o.times.map((t) => ({ t, label: '' })) : keyMoments(tl, only, o.maxFrames ?? 8);
    const { region, whole } = focusRegion(tl, frames, only, o.focus);
    const fw = o.frameWidth ?? (whole ? 300 : 220);
    const scale = Math.min(3, fw / region.w, (fw * 1.25) / region.h);
    const t0 = frames.length ? Math.min(...frames.map((f) => f.t)) : 0;
    const pics = shots(tl, frames, region, scale, whole, o, notes);
    const cw = Math.max(...pics.map((p) => p.width), 200);
    const ch = Math.max(...pics.map((p) => p.height), 40);
    const cols = Math.max(1, Math.min(o.columns ?? (whole ? 3 : 4), frames.length));
    const rows = Math.ceil(frames.length / cols);
    const graphs = chosen.map((s) => graphFor(s.index, cw, GRAPH_H, frames.map((f) => f.t))).filter((g): g is Raster => !!g);
    const grows = Math.ceil(graphs.length / cols);
    const W = gap + cols * (cw + gap);
    const H = title + rows * (label + ch + gap) + grows * (GRAPH_H + gap) + gap;
    const c = newRaster(W, H, BACK);
    drawLabel(c, heading, gap, 6, 14, INK, { bold: true, maxWidth: W - 2 * gap });
    frames.forEach((f, i) => {
      const x = gap + (i % cols) * (cw + gap);
      const y = title + Math.floor(i / cols) * (label + ch + gap);
      drawLabel(c, ms(f.t - t0), x, y + 1, 13, INK, { bold: true, maxWidth: cw });
      if (f.label) drawLabel(c, f.label, x, y + 15, 11, FAINT, { maxWidth: cw });
      blit(c, pics[i]!, x, y + label);
    });
    const gy = title + rows * (label + ch + gap);
    graphs.forEach((g, i) => blitRaster(c, g, gap + (i % cols) * (cw + gap), gy + Math.floor(i / cols) * (GRAPH_H + gap)));
    return { image: toRgba(c), frames, region, scale, regions: [{ move: null, region, scale }], timeline: tl, metrics, notes: [...notes] };
  }
  // A row per move.
  const cellW = o.frameWidth ?? 170;
  const cellH = Math.round(cellW * 0.7);
  const gw = 200;
  const maxW = o.maxWidth ?? 1100;
  const t0 = Math.min(...chosen.map((s) => s.call));
  const rows = chosen.map((s) => {
    const all = keyMoments(tl, [s.index], o.maxFrames ?? 6);
    const { region, whole } = focusRegion(tl, all, [s.index], 'auto');
    const k = whole ? 1.25 : 1;
    const scale = Math.min(3, (cellW * k) / region.w, (cellH * k) / region.h);
    // As many frames as fit across the sheet (at least three).
    const cell = Math.max(96, Math.round(region.w * scale));
    const fit = Math.max(3, Math.floor((maxW - 3 * gap - gw) / (cell + gap)));
    const frames = all.length > fit ? keyMoments(tl, [s.index], fit) : all;
    return { s, frames, region, whole, scale, pics: shots(tl, frames, region, scale, whole, o, notes) };
  });
  const cellOf = (p: RgbaImage) => Math.max(p.width, 96);
  const rowH = (r: (typeof rows)[number]) => Math.max(GRAPH_H, label + Math.max(...r.pics.map((p) => p.height)));
  const rowW = (r: (typeof rows)[number]) => gw + gap + r.pics.reduce((t, p) => t + cellOf(p) + gap, 0);
  const W = gap + Math.max(...rows.map(rowW));
  const H = title + rows.reduce((t, r) => t + rowH(r) + gap, 0) + gap;
  const c = newRaster(W, H, BACK);
  drawLabel(c, heading, gap, 6, 14, INK, { bold: true, maxWidth: W - 2 * gap });
  let y = title;
  const frames: FilmFrame[] = [];
  for (const r of rows) {
    const h = rowH(r);
    const g = graphFor(r.s.index, gw, h, r.frames.map((f) => f.t));
    if (g) blitRaster(c, g, gap, y);
    let x = gap + gw + gap;
    r.frames.forEach((f, i) => {
      const pic = r.pics[i]!;
      drawLabel(c, ms(f.t - t0), x, y + 1, 13, INK, { bold: true, maxWidth: cellOf(pic) });
      drawLabel(c, f.label, x, y + 15, 11, FAINT, { maxWidth: cellOf(pic) });
      blit(c, pic, x, y + label);
      x += cellOf(pic) + gap;
      frames.push({ ...f, move: r.s.index });
    });
    y += h + gap;
  }
  return { image: toRgba(c), frames, region: rows[0]!.region, scale: rows[0]!.scale, regions: rows.map((r) => ({ move: r.s.index, region: r.region, scale: r.scale })), timeline: tl, metrics, notes: [...notes] };
}

export interface OnionSkin {
  image: RgbaImage;
  frames: FilmFrame[];
  region: Rect;
  scale: number;
  /** Each frame's centre of the main moving element, in points (null where it isn't on the screen). */
  path: Array<[number, number] | null>;
}

/**
 * Several frames over one another: the latest at full strength, earlier ones fainter, and the main element's centre
 * traced through them. Arcs, overshoot and spacing (the gaps between ghosts are its speed) read in one picture.
 */
export function onionSkin(screens: UiNode[], motions: Array<LabMotion | MockMotion>, o: FilmstripOptions & { count?: number } = {}): OnionSkin {
  const tl = compileMotion(screens, motions, o);
  const spans = tl.spans.filter((s) => (!o.only || o.only.includes(s.index)) && s.primary);
  const t0 = spans.length ? Math.min(...spans.map((s) => s.call)) : 0;
  const t1 = spans.length ? Math.max(...spans.map((s) => (s.loop ? s.start + (s.cycle ?? 1) : s.end))) : 0;
  const count = Math.max(2, o.count ?? 6);
  const frames: FilmFrame[] = o.times ? o.times.map((t) => ({ t, label: '' })) : Array.from({ length: count }, (_, i) => ({ t: t0 + ((t1 - t0) * i) / (count - 1), label: '' }));
  const { region, whole } = focusRegion(tl, frames, o.only, o.focus);
  const fw = o.frameWidth ?? (whole ? 560 : 420);
  const scale = Math.min(4, fw / region.w, (fw * 1.1) / region.h);
  const render = (nodes: LabNode[]) => renderUi(nodes as UiNode[], deviceArg(tl), { region, scale, rulers: false, guides: false, backdrop: o.backdrop, images: o.images, ...o.text }).image;
  const moving = spans.map((s) => s.primary!.path);
  // The clean plate: the last frame with the moving elements hidden.
  const plateNodes = tl.sample(t1);
  const hide = (n: LabNode, p: string) => {
    if (moving.includes(p)) n.visible = false;
    for (const k of n.kids ?? []) hide(k, `${p}.${k.name}`);
  };
  for (const s of plateNodes) hide(s, s.name);
  const plate = render(plateNodes);
  const out = newRaster(plate.width, plate.height + 22, BACK);
  blit(out, plate, 0, 0);
  const main = moving[0];
  const path: OnionSkin['path'] = [];
  frames.forEach((f, i) => {
    const img = render(tl.sample(f.t));
    const a = 0.22 + 0.78 * Math.pow(i / Math.max(1, frames.length - 1), 1.4);
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        const d = Math.max(Math.abs(img.data[s]! - plate.data[s]!), Math.abs(img.data[s + 1]! - plate.data[s + 1]!), Math.abs(img.data[s + 2]! - plate.data[s + 2]!)) / 255;
        const k = Math.min(1, d * 4) * a;
        if (k <= 0.002) continue;
        const o3 = (y * out.w + x) * 3;
        for (let ch = 0; ch < 3; ch++) out.rgb[o3 + ch] = out.rgb[o3 + ch]! * (1 - k) + (img.data[s + ch]! / 255) * k;
      }
    const b = main ? tl.layoutAt(f.t).find((x) => x.path === main) : undefined;
    path.push(b ? [b.x + b.w / 2, b.y + b.h / 2] : null);
  });
  // The centre's path through the frames.
  const pts = path.filter((p): p is [number, number] => !!p).map(([x, y]) => [(x - region.x) * scale, (y - region.y) * scale] as Pt);
  polyline(out, pts, 1.5, CURVE, 0.9, { x: 0, y: 0, w: out.w, h: plate.height });
  pts.forEach(([x, y], i) => {
    const m = fillMask([circle(x, y, i === pts.length - 1 ? 3.5 : 2.5)], { x: 0, y: 0, w: out.w, h: plate.height });
    if (m) paint(out, m, [...CURVE, 0.5 + (0.5 * i) / Math.max(1, pts.length - 1)]);
  });
  const f0 = frames[0]?.t ?? t0;
  drawLabel(out, `onion skin · ${frames.length} frames · ${ms(f0 - t0)}–${ms((frames[frames.length - 1]?.t ?? t1) - t0)} · fainter = earlier · orange = path`, 6, plate.height + 4, 12, INK, { maxWidth: out.w - 12 });
  return { image: toRgba(out), frames, region, scale, path };
}
