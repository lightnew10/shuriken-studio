import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateText, layoutScreen, type Measure, type UiNode, type UiStateName } from '@shared/ui-layout';
import { decodePng, encodePng, type RgbaImage } from '../../modeling/png';
import { fontFor } from '../ui-fonts';
import { renderUi, sideBySide, type FontPicker, type UiRenderOptions } from '../ui-render';
import type { CalText } from './calibration';

/**
 * How close a way of drawing UI comes to Roblox: the calibration screens' numbers and screenshots that
 * `tests/e2e/ui-lab-fidelity.e2e.ts` saved from Studio, against the same screens laid out and drawn here. Text
 * widths (every TextBounds), element boxes, and pixels. Run on a saved folder; writes `compare-<screen>.png`
 * pictures (Studio | each way of drawing | where the best one differs).
 */

/** A way of measuring and drawing text: the current one (stand-in fonts, estimated widths) or the Lab's. */
export interface TextKit {
  id: string;
  label: string;
  measure: Measure;
  fonts: FontPicker;
  baseline?: UiRenderOptions['baseline'];
}

export const STAND_IN_KIT: TextKit = { id: 'current', label: 'current renderer (stand-in fonts, estimated widths)', measure: estimateText, fonts: (f, b, i) => fontFor(f, b, i) };

interface Saved {
  texts: CalText[];
  measured: { texts: Record<string, [number, number, boolean]>; w: number; h: number };
  visual: Record<string, { w: number; h: number; boxes: Record<string, [number, number, number, number]>; texts: Record<string, [number, number, boolean]> }>;
  shots: Record<string, { file: string; w: number; h: number }>;
  screens: { visuals: UiNode[] };
}

export interface Stats {
  n: number;
  /** Mean of |error| */
  mean: number;
  median: number;
  p90: number;
  max: number;
}

const stats = (xs: number[]): Stats => {
  const s = [...xs].map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, mean: s.reduce((t, x) => t + x, 0) / Math.max(1, s.length), median: q(0.5), p90: q(0.9), max: s[s.length - 1] ?? 0 };
};

export interface KitResult {
  kit: string;
  label: string;
  /** Single-line text widths: error in points, and in % of Roblox's width. */
  textPx: Stats;
  textPct: Stats;
  /** Share of texts within 1 point of Roblox's width. */
  textWithin1: number;
  /** Per face (family weight): median % error. */
  byFace: Record<string, number>;
  /** The visual screens' element boxes: the largest of |dx|, |dy|, |dw|, |dh| per element. */
  boxPx: Stats;
  boxWithin2: number;
  /** Per visual screen: mean absolute pixel difference (0-255) and the share of pixels off by more than 40. */
  pixels: Record<string, { mean: number; off: number }>;
}

export interface FidelityResult {
  dir: string;
  viewport: [number, number];
  kits: KitResult[];
  pictures: string[];
}

/** Bilinear resample to an exact size. */
export function resample(img: RgbaImage, w: number, h: number): RgbaImage {
  if (img.width === w && img.height === h) return img;
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c]!;
        const b = img.data[(y0 * img.width + x1) * 4 + c]!;
        const d = img.data[(y1 * img.width + x0) * 4 + c]!;
        const e = img.data[(y1 * img.width + x1) * 4 + c]!;
        out[(y * w + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Pixel difference of two same-sized pictures, and a heat map of it. */
export function pixelDiff(a: RgbaImage, b: RgbaImage): { mean: number; off: number; heat: RgbaImage } {
  const n = a.width * a.height;
  const heat = new Uint8Array(n * 4);
  let sum = 0;
  let off = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c]! - b.data[i * 4 + c]!));
    sum += d;
    if (d > 40) off++;
    const v = Math.min(255, d * 3);
    heat[i * 4] = v;
    heat[i * 4 + 1] = Math.round(v * 0.3);
    heat[i * 4 + 2] = 0;
    heat[i * 4 + 3] = 255;
  }
  return { mean: sum / n, off: off / n, heat: { width: a.width, height: a.height, data: heat } };
}

/** Bold where a weight says so (captures carry both; the calibration's screens give the weight only). */
const withBold = (n: UiNode): UiNode => ({ ...n, ...(n.weight !== undefined && n.bold === undefined ? { bold: n.weight >= 600 } : {}), ...(n.kids ? { kids: n.kids.map(withBold) } : {}) });

const nodeOf = (t: CalText): UiNode => ({ id: 0, name: 't', cls: 'TextLabel', text: t.text, font: t.family, weight: t.weight, bold: t.weight >= 600, textSize: t.size });

/** Compares each kit against what Studio saved in `dir`. */
export function compareCalibration(dir: string, kits: TextKit[] = [STAND_IN_KIT], o: { pictures?: boolean } = {}): FidelityResult {
  const saved = JSON.parse(readFileSync(join(dir, 'studio.json'), 'utf8')) as Saved;
  saved.screens.visuals = saved.screens.visuals.map(withBold);
  const results: KitResult[] = [];
  const renders = new Map<string, Array<{ image: RgbaImage; label: string }>>();
  const shots = new Map<string, RgbaImage>();
  for (const [name, s] of Object.entries(saved.shots)) {
    const p = join(dir, s.file);
    if (existsSync(p)) shots.set(name, decodePng(readFileSync(p)));
  }
  for (const kit of kits) {
    // 1. Text widths: single-line texts only (wrapped and scaled ones are checked through the boxes and pixels).
    const px: number[] = [];
    const pct: number[] = [];
    const faces = new Map<string, number[]>();
    for (const t of saved.texts) {
      if (t.wrapped || t.scaled) continue;
      const m = saved.measured.texts[t.path];
      if (!m || m[0] <= 0) continue;
      const ours = kit.measure(t.text, t.size, nodeOf(t));
      const e = ours - m[0];
      px.push(e);
      pct.push((100 * e) / m[0]);
      const face = `${t.family} ${t.weight}`;
      faces.set(face, [...(faces.get(face) ?? []), (100 * e) / m[0]]);
    }
    const byFace: Record<string, number> = {};
    for (const [f, xs] of faces) byFace[f] = Math.round(stats(xs).median * 10) / 10;
    // 2. Boxes of the visual screens.
    const deltas: number[] = [];
    for (const screen of saved.screens.visuals) {
      const v = saved.visual[screen.name];
      if (!v) continue;
      const shown = { ...screen, enabled: true };
      const ours = new Map(layoutScreen(shown, { w: v.w, h: v.h, topbar: 0, side: 0 }, { measure: kit.measure }).map((b) => [b.path, b]));
      for (const [path, [x, y, w, h]] of Object.entries(v.boxes)) {
        const b = ours.get(path);
        if (!b) continue;
        deltas.push(Math.max(Math.abs(b.x - x), Math.abs(b.y - y), Math.abs(b.w - w), Math.abs(b.h - h)));
      }
    }
    // 3. Pixels: each visual screen drawn at the viewport's size, scaled to the screenshot's.
    const pixels: Record<string, { mean: number; off: number }> = {};
    for (const screen of saved.screens.visuals) {
      const v = saved.visual[screen.name];
      const shot = shots.get(screen.name);
      if (!v || !shot) continue;
      const scale = shot.width / v.w;
      const r = renderUi([{ ...screen, enabled: true }], { w: v.w, h: v.h, topbar: 0, side: 0 }, { scale, rulers: false, guides: false, backdrop: 'dark', measure: kit.measure, fonts: kit.fonts, ...(kit.baseline ? { baseline: kit.baseline } : {}) });
      const ours = resample(r.image, shot.width, shot.height);
      const d = pixelDiff(ours, shot);
      pixels[screen.name] = { mean: Math.round(d.mean * 10) / 10, off: Math.round(d.off * 1000) / 10 };
      renders.set(screen.name, [...(renders.get(screen.name) ?? []), { image: ours, label: kit.label }]);
    }
    const within = (xs: number[], lim: number) => (xs.length ? xs.filter((x) => Math.abs(x) <= lim).length / xs.length : 0);
    results.push({ kit: kit.id, label: kit.label, textPx: stats(px), textPct: stats(pct), textWithin1: within(px, 1), byFace, boxPx: stats(deltas), boxWithin2: within(deltas, 2), pixels });
  }
  const pictures: string[] = [];
  if (o.pictures !== false) {
    for (const [name, list] of renders) {
      const shot = shots.get(name)!;
      const best = [...list].sort((a, b) => pixelDiff(a.image, shot).mean - pixelDiff(b.image, shot).mean)[0]!;
      const file = join(dir, `compare-${name}.png`);
      writeFileSync(file, encodePng(sideBySide([{ image: shot, label: 'Roblox Studio' }, ...list, { image: pixelDiff(best.image, shot).heat, label: `difference: ${best.label}` }])));
      pictures.push(file);
    }
  }
  const first = Object.values(saved.visual)[0];
  return { dir, viewport: [first?.w ?? saved.measured.w, first?.h ?? saved.measured.h], kits: results, pictures };
}

/** The comparison in a few lines. */
export function fidelityReport(r: FidelityResult): string {
  const f = (x: number) => (Math.round(x * 10) / 10).toString();
  const lines = [`Against Roblox Studio (viewport ${r.viewport[0]}×${r.viewport[1]}):`];
  for (const k of r.kits) {
    lines.push(`- ${k.label}`);
    lines.push(`  text widths: median ${f(k.textPct.median)}%, p90 ${f(k.textPct.p90)}%, max ${f(k.textPct.max)}% (${f(k.textPx.median)} pt median); ${Math.round(k.textWithin1 * 100)}% within 1 pt (${k.textPx.n} texts)`);
    lines.push(`  element boxes: ${Math.round(k.boxWithin2 * 100)}% within 2 pt, median ${f(k.boxPx.median)}, max ${f(k.boxPx.max)} (${k.boxPx.n} elements)`);
    lines.push(`  pixels: ${Object.entries(k.pixels).map(([s, p]) => `${s} mean ${p.mean}, ${p.off}% off`).join('; ')}`);
  }
  return lines.join('\n');
}

// ─── Out of sample: texts the model wasn't fitted on, and real screens ────────────────────────────

interface VerifySaved {
  texts: CalText[];
  measured: Record<string, [number, number, boolean]>;
  visual: Record<string, { w: number; h: number; x?: number; y?: number; boxes: Record<string, [number, number, number, number]> }>;
  shots: Record<string, { file: string; w: number; h: number }>;
  fixture: Array<{ title: string; screen: UiNode; states?: Record<string, UiStateName> }>;
  backdrop: [number, number, number];
  probes: unknown;
  /** Where the screens' rbxasset://shuriken-forge/<file> images came from (the forge run). */
  imagesDir?: string;
}

export interface VerifyResult {
  dir: string;
  probes: unknown;
  kits: Array<{ kit: string; label: string; textPct: Stats; textPx: Stats; textWithin1: number; boxPx: Stats; boxWithin2: number; screens: Record<string, { title: string; boxWithin2: number; mean: number; off: number }> }>;
  pictures: string[];
}

const solid = (w: number, h: number, c: [number, number, number]): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([c[0], c[1], c[2], 255], i * 4);
  return { width: w, height: h, data };
};

/** Each kit against Studio on what the font model never saw: new texts, and real screens built by the Lab's builder. */
export function compareVerify(dir: string, kits: TextKit[] = [STAND_IN_KIT], o: { pictures?: boolean } = {}): VerifyResult {
  const saved = JSON.parse(readFileSync(join(dir, 'verify.json'), 'utf8')) as VerifySaved;
  const shots = new Map<string, RgbaImage>();
  for (const [name, s] of Object.entries(saved.shots)) if (existsSync(join(dir, s.file))) shots.set(name, decodePng(readFileSync(join(dir, s.file))));
  const renders = new Map<string, Array<{ image: RgbaImage; label: string }>>();
  const imageCache = new Map<string, RgbaImage | null>();
  const images = (ref: string): RgbaImage | null => {
    const m = /^rbxasset:\/\/shuriken-forge\/(.+)$/.exec(ref);
    if (!m || !saved.imagesDir) return null;
    if (!imageCache.has(m[1]!)) {
      const p = join(saved.imagesDir, m[1]!);
      imageCache.set(m[1]!, existsSync(p) ? decodePng(readFileSync(p)) : null);
    }
    return imageCache.get(m[1]!) ?? null;
  };
  const kitsOut: VerifyResult['kits'] = [];
  for (const kit of kits) {
    const px: number[] = [];
    const pct: number[] = [];
    for (const t of saved.texts) {
      const m = saved.measured[t.path];
      if (!m || m[0] <= 0) continue;
      const e = kit.measure(t.text, t.size, nodeOf(t)) - m[0];
      px.push(e);
      pct.push((100 * e) / m[0]);
    }
    const allBoxes: number[] = [];
    const screens: Record<string, { title: string; boxWithin2: number; mean: number; off: number }> = {};
    for (const f of saved.fixture) {
      const v = saved.visual[f.screen.name];
      if (!v) continue;
      const ox = v.x ?? 0;
      const oy = v.y ?? 0;
      const vw = v.w + ox;
      const vh = v.h + oy;
      const screen = withBold({ ...f.screen, enabled: true });
      const dev = { w: vw, h: vh, topbar: oy, side: 0 };
      const ours = new Map(layoutScreen(screen, dev, { measure: kit.measure }).map((b) => [b.path, b]));
      const deltas: number[] = [];
      for (const [path, [x, y, w, h]] of Object.entries(v.boxes)) {
        const b = ours.get(path);
        if (!b) continue;
        deltas.push(Math.max(Math.abs(b.x - (x + ox)), Math.abs(b.y - (y + oy)), Math.abs(b.w - w), Math.abs(b.h - h)));
      }
      allBoxes.push(...deltas);
      const shot = shots.get(f.screen.name);
      let mean = 0;
      let off = 0;
      if (shot) {
        const scale = shot.width / vw;
        const r = renderUi([screen], { ...dev, label: f.title }, { scale, rulers: false, guides: false, backdrop: solid(Math.round(vw * scale), Math.round(vh * scale), saved.backdrop), measure: kit.measure, fonts: kit.fonts, images, ...(f.states ? { states: f.states } : {}) });
        const img = resample(r.image, shot.width, shot.height);
        const d = pixelDiff(img, shot);
        mean = Math.round(d.mean * 10) / 10;
        off = Math.round(d.off * 1000) / 10;
        renders.set(f.screen.name, [...(renders.get(f.screen.name) ?? []), { image: img, label: kit.label }]);
      }
      screens[f.screen.name] = { title: f.title, boxWithin2: deltas.length ? deltas.filter((d) => d <= 2).length / deltas.length : 0, mean, off };
    }
    kitsOut.push({ kit: kit.id, label: kit.label, textPct: stats(pct), textPx: stats(px), textWithin1: px.length ? px.filter((x) => Math.abs(x) <= 1).length / px.length : 0, boxPx: stats(allBoxes), boxWithin2: allBoxes.length ? allBoxes.filter((d) => d <= 2).length / allBoxes.length : 0, screens });
  }
  const pictures: string[] = [];
  if (o.pictures !== false)
    for (const [name, list] of renders) {
      const shot = shots.get(name)!;
      const file = join(dir, `compare-${name}.png`);
      writeFileSync(file, encodePng(sideBySide([{ image: shot, label: 'Roblox Studio' }, ...list])));
      pictures.push(file);
    }
  return { dir, probes: saved.probes, kits: kitsOut, pictures };
}

export function verifyReport(r: VerifyResult): string {
  const f = (x: number) => (Math.round(x * 10) / 10).toString();
  const lines = ['Out of sample (texts and screens the font model never saw):'];
  for (const k of r.kits) {
    lines.push(`- ${k.label}`);
    lines.push(`  text widths: median ${f(k.textPct.median)}%, p90 ${f(k.textPct.p90)}%, max ${f(k.textPct.max)}%; ${Math.round(k.textWithin1 * 100)}% within 1 pt (${k.textPx.n} texts)`);
    lines.push(`  real screens' boxes: ${Math.round(k.boxWithin2 * 100)}% within 2 pt (${k.boxPx.n} elements), max ${f(k.boxPx.max)}`);
    for (const [name, s] of Object.entries(k.screens)) lines.push(`  ${s.title}: boxes ${Math.round(s.boxWithin2 * 100)}% within 2 pt, pixels mean ${s.mean}, ${s.off}% off`);
  }
  return lines.join('\n');
}
