import type { RgbaImage } from '../modeling/png';
import { analyzeLook } from '../look/look-analysis';

/**
 * A reference picture the user holds up (a screenshot of a game whose UI they like) against a mockup drawn the
 * same size: its colours sampled (the big areas and the small loud accents an eye picks out), a theme to start
 * from, and where the mockup differs (colours it lacks, lighter or darker, calmer or louder, busier or emptier,
 * region by region). Numbers, not taste: the agent looks at both pictures and decides.
 */

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
export function labOf(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const dE = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export interface SampledColour {
  hex: string;
  /** Share of the picture (0..1). */
  share: number;
  /** CIE L* (0 black … 100 white) and chroma C* (0 grey … 100+ vivid). */
  L: number;
  C: number;
}

/** Colours of a picture: the main ones by area, and the vivid ones that cover little but catch the eye. */
export function samplePalette(img: RgbaImage, max = 8): { main: SampledColour[]; accents: SampledColour[] } {
  // A 5-bit-per-channel histogram of an evenly spaced sample (about 60k pixels).
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 60_000)));
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = 0; y < img.height; y += step)
    for (let x = 0; x < img.width; x += step) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3]! < 128) continue;
      const r = img.data[o]!;
      const g = img.data[o + 1]!;
      const b = img.data[o + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
      total++;
    }
  // Merge bins into colours, most common first: a bin within ΔE 14 of a colour joins it.
  const clusters: Array<{ n: number; r: number; g: number; b: number; lab: [number, number, number] }> = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    const r = bin.r / bin.n;
    const g = bin.g / bin.n;
    const b = bin.b / bin.n;
    const lab = labOf(r, g, b);
    const near = clusters.find((c) => dE(c.lab, lab) < 14);
    if (near) {
      near.r += bin.r;
      near.g += bin.g;
      near.b += bin.b;
      near.n += bin.n;
    } else clusters.push({ n: bin.n, r: bin.r, g: bin.g, b: bin.b, lab });
  }
  const colours = clusters
    .map((c) => {
      const r = c.r / c.n;
      const g = c.g / c.n;
      const b = c.b / c.n;
      const [L, A, B] = labOf(r, g, b);
      return { hex: hex(r, g, b), share: c.n / Math.max(1, total), L: Math.round(L), C: Math.round(Math.hypot(A, B)) };
    })
    .sort((a, b) => b.share - a.share);
  const main = colours.filter((c) => c.share >= 0.02).slice(0, max);
  const accents = colours.filter((c) => c.C >= 35 && c.share >= 0.002 && !main.some((m) => m.hex === c.hex)).sort((a, b) => b.C * Math.sqrt(b.share) - a.C * Math.sqrt(a.share)).slice(0, 5);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { main: main.map((c) => ({ ...c, share: r3(c.share) })), accents: accents.map((c) => ({ ...c, share: r3(c.share) })) };
}

/**
 * Theme tokens to start a mockup from: the darkest common colour as the background, the next as the surface, the
 * lightest common one as text, the loudest colours as accents. A start, not an answer: the screen behind the UI in
 * a game screenshot is often the 3D world.
 */
export function themeFrom(p: { main: SampledColour[]; accents: SampledColour[] }): Record<string, string> {
  const byL = [...p.main].sort((a, b) => a.L - b.L);
  const calm = p.main.filter((c) => c.C < 30);
  const theme: Record<string, string> = {};
  const darks = (calm.length ? calm : byL).filter((c) => c.L < 45).sort((a, b) => b.share - a.share);
  if (darks[0]) theme.bg = darks[0].hex;
  if (darks[1]) theme.surface = darks[1].hex;
  const light = [...p.main].filter((c) => c.L > 80).sort((a, b) => b.L - a.L)[0];
  theme.text = light?.hex ?? '#ffffff';
  const loud = [...p.accents, ...p.main.filter((c) => c.C >= 35)].sort((a, b) => b.C - a.C);
  if (loud[0]) theme.accent = loud[0].hex;
  const second = loud.find((c) => loud[0] && dE(labOf(...fromHex(c.hex)), labOf(...fromHex(loud[0].hex))) > 30);
  if (second) theme.accent2 = second.hex;
  return theme;
}

/** A copy of a picture at a size (box-filtered down, nearest up), for comparing two pictures cell by cell. */
export function resize(img: RgbaImage, w: number, h: number): RgbaImage {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          r += img.data[o]!;
          g += img.data[o + 1]!;
          b += img.data[o + 2]!;
          n++;
        }
      out.set([Math.round(r / n), Math.round(g / n), Math.round(b / n), 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

export interface ReferenceComparison {
  /** Each main and accent colour of the reference, and the nearest the mockup has (ΔE: under 5 the same to the eye, over 15 another colour). */
  colours: Array<{ reference: string; nearest: string; dE: number; share: number; accent?: boolean }>;
  /** Mean lightness (L*), colourfulness (C*) and edge density (% of pixels on a boundary): reference, mockup. */
  measures: { lightness: [number, number]; chroma: [number, number]; edges: [number, number]; vivid: [number, number] };
  /** Regions of a 3×3 grid where they differ most (top left … bottom right). */
  regions: Array<{ region: string; reference: string; mockup: string; dE: number; busier: 'reference' | 'mockup' | null }>;
  /** What stands out, in words. */
  differences: string[];
}

const REGION = ['top left', 'top', 'top right', 'left', 'middle', 'right', 'bottom left', 'bottom', 'bottom right'];

/** The reference against a mockup drawn at its shape: colours, lightness, colourfulness, busyness, region by region. */
export function compareWithReference(reference: RgbaImage, mockup: RgbaImage): ReferenceComparison {
  const W = 360;
  const H = Math.max(1, Math.round((W * reference.height) / reference.width));
  const ref = resize(reference, W, H);
  const mock = resize(mockup, W, H);
  const pr = samplePalette(ref);
  const pm = samplePalette(mock, 16);
  const mockLabs = [...pm.main, ...pm.accents].map((c) => ({ hex: c.hex, lab: labOf(...fromHex(c.hex)) }));
  const nearest = (h: string) => {
    const lab = labOf(...fromHex(h));
    let best = { hex: '#000000', d: Infinity };
    for (const m of mockLabs) {
      const d = dE(lab, m.lab);
      if (d < best.d) best = { hex: m.hex, d };
    }
    return best;
  };
  const colours = [...pr.main.map((c) => ({ c, accent: false })), ...pr.accents.map((c) => ({ c, accent: true }))].map(({ c, accent }) => {
    const n = nearest(c.hex);
    return { reference: c.hex, nearest: n.hex, dE: Math.round(n.d), share: c.share, ...(accent ? { accent: true } : {}) };
  });
  const la = analyzeLook(ref, { view: 'ui' });
  const lb = analyzeLook(mock, { view: 'ui' });
  const vivid = (p: { main: SampledColour[]; accents: SampledColour[] }) => Math.round(p.main.filter((c) => c.C >= 50).reduce((t, c) => t + c.share, 0) * 100);
  const measures: ReferenceComparison['measures'] = {
    lightness: [Math.round(la.exposure.meanL), Math.round(lb.exposure.meanL)],
    chroma: [Math.round(la.colour.meanChroma), Math.round(lb.colour.meanChroma)],
    edges: [Math.round(la.detail.edges * 10) / 10, Math.round(lb.detail.edges * 10) / 10],
    vivid: [vivid(pr), vivid(pm)],
  };
  // Region by region: mean colour and how much changes inside (busyness).
  const cell = (img: RgbaImage, i: number) => {
    const cx = i % 3;
    const cy = Math.floor(i / 3);
    const x0 = Math.floor((cx * W) / 3);
    const x1 = Math.floor(((cx + 1) * W) / 3);
    const y0 = Math.floor((cy * H) / 3);
    const y1 = Math.floor(((cy + 1) * H) / 3);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    let busy = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = (y * W + x) * 4;
        r += img.data[o]!;
        g += img.data[o + 1]!;
        b += img.data[o + 2]!;
        n++;
        if (x + 1 < x1) busy += Math.abs(img.data[o]! - img.data[o + 4]!) + Math.abs(img.data[o + 1]! - img.data[o + 5]!) + Math.abs(img.data[o + 2]! - img.data[o + 6]!) > 60 ? 1 : 0;
      }
    return { r: r / n, g: g / n, b: b / n, busy: busy / Math.max(1, n) };
  };
  const regions = REGION.map((region, i) => {
    const a = cell(ref, i);
    const b = cell(mock, i);
    const d = dE(labOf(a.r, a.g, a.b), labOf(b.r, b.g, b.b));
    const busier = a.busy > b.busy * 1.6 + 0.01 ? ('reference' as const) : b.busy > a.busy * 1.6 + 0.01 ? ('mockup' as const) : null;
    return { region, reference: hex(a.r, a.g, a.b), mockup: hex(b.r, b.g, b.b), dE: Math.round(d), busier };
  }).sort((x, y) => y.dE - x.dE);
  const differences: string[] = [];
  const missing = colours.filter((c) => c.dE > 15 && (c.share >= 0.05 || c.accent));
  for (const c of missing.slice(0, 5)) differences.push(`${c.accent ? 'Accent' : 'Colour'} ${c.reference} (${Math.round(c.share * 1000) / 10}% of the reference) has nothing close in the mockup (nearest ${c.nearest}, ΔE ${c.dE})`);
  const [lr, lm] = measures.lightness;
  if (Math.abs(lr - lm) > 10) differences.push(`The mockup is ${lm > lr ? 'lighter' : 'darker'} overall (L* ${lm} against ${lr})`);
  const [cr, cm] = measures.chroma;
  if (Math.abs(cr - cm) > 8) differences.push(`The mockup is ${cm > cr ? 'more colourful' : 'greyer'} (mean chroma ${cm} against ${cr})`);
  const [er, em] = measures.edges;
  if (er > em * 1.5 + 1) differences.push(`The reference has much more going on (edges ${er}% against ${em}%): more detail, outlines, icons or panels`);
  else if (em > er * 1.5 + 1) differences.push(`The mockup is busier than the reference (edges ${em}% against ${er}%)`);
  for (const r of regions.slice(0, 3)) if (r.dE > 20) differences.push(`${r.region}: the reference reads ${r.reference}, the mockup ${r.mockup} (ΔE ${r.dE})${r.busier ? `; the ${r.busier} is busier there` : ''}`);
  return { colours, measures, regions: regions.slice(0, 5), differences };
}
