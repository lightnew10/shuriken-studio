import type { RgbaImage } from '../../modeling/png';

/**
 * What a VFX texture is like, measured on the PNG as Roblox will sample it: how much of each cell it
 * covers, how soft its edges are, what colour sits under its alpha (white tints cleanly; dark can only
 * darken), whether any edge texels are darker than the shape (the black fringe), whether a frame bleeds
 * into its cell's border (mipmaps would mix frames), how smoothly a flipbook's frames follow each other and
 * whether its loop closes, and whether a strip tiles end to end.
 */
export interface TextureAnalysis {
  coverage: number;
  edgeSoftness: number;
  peakAlpha: number;
  /** Mean colour brightness (0..1) under the alpha. */
  lightness: number;
  /** Partly transparent texels clearly darker than the shape's own colour (dark fringe): should be 0. */
  darkFringe: number;
  /** The most alpha in any cell's outer 2 px (0 = frames never bleed into each other). */
  cellBorder: number;
  /** Flipbooks: mean similarity of each frame to the next (1 identical, ~0.9 smooth, < 0.6 jumpy). */
  continuity: number | null;
  /** Flipbooks: similarity of the last frame to the first (a loop wants ≈ continuity). */
  loopSeam: number | null;
  /** Flipbooks: coverage of the first and last frame (grows, holds or dissipates). */
  coverageFirstLast: [number, number] | null;
  /** Strips: difference between the left and right columns (0 = tiles seamlessly). */
  tileSeam: number;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function analyzeTexture(img: RgbaImage, grid = 1): TextureAnalysis {
  const { width: w, height: h, data } = img;
  const cw = Math.floor(w / grid);
  const ch = Math.floor(h / grid);
  const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3]! / 255;
  const lumAt = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return 0.2126 * toLinear(data[i]!) + 0.7152 * toLinear(data[i + 1]!) + 0.0722 * toLinear(data[i + 2]!);
  };
  let covered = 0;
  let solid = 0;
  let partial = 0;
  let peak = 0;
  let lumSum = 0;
  let alphaSum = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = alphaAt(x, y);
      peak = Math.max(peak, a);
      if (a > 0.05) covered++;
      if (a > 0.1) solid++;
      if (a > 0.1 && a < 0.9) partial++;
      lumSum += lumAt(x, y) * a;
      alphaSum += a;
    }
  const lightness = alphaSum > 0 ? lumSum / alphaSum : 1;
  // Fringe: texels at the edge (alpha 0.02..0.5) much darker than the shape's mean colour.
  let fringe = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = alphaAt(x, y);
      if (a > 0.02 && a < 0.5 && lumAt(x, y) < lightness * 0.45) fringe++;
    }
  let border = 0;
  if (grid > 1 || w === h)
    for (let gy = 0; gy < grid; gy++)
      for (let gx = 0; gx < grid; gx++)
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++) {
            if (x > 1 && y > 1 && x < cw - 2 && y < ch - 2) continue;
            border = Math.max(border, alphaAt(gx * cw + x, gy * ch + y));
          }
  let continuity: number | null = null;
  let loopSeam: number | null = null;
  let firstLast: [number, number] | null = null;
  if (grid > 1) {
    const frames = grid * grid;
    const alphaOf = (f: number) => {
      const ox = (f % grid) * cw;
      const oy = Math.floor(f / grid) * ch;
      const out = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = alphaAt(ox + x, oy + y);
      return out;
    };
    const similarity = (a: Float32Array, b: Float32Array) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : na === nb ? 1 : 0;
    };
    const all = Array.from({ length: frames }, (_, f) => alphaOf(f));
    let sum = 0;
    for (let f = 0; f < frames - 1; f++) sum += similarity(all[f]!, all[f + 1]!);
    continuity = sum / (frames - 1);
    loopSeam = similarity(all[frames - 1]!, all[0]!);
    const cov = (a: Float32Array) => a.reduce((n, v) => n + (v > 0.05 ? 1 : 0), 0) / a.length;
    firstLast = [cov(all[0]!), cov(all[frames - 1]!)];
  }
  let seam = 0;
  for (let y = 0; y < h; y++) seam += Math.abs(alphaAt(0, y) - alphaAt(w - 1, y));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    coverage: r2(covered / (w * h)),
    edgeSoftness: r2(solid ? partial / solid : 0),
    peakAlpha: r2(peak),
    lightness: r2(lightness),
    darkFringe: fringe,
    cellBorder: r2(border),
    continuity: continuity === null ? null : r2(continuity),
    loopSeam: loopSeam === null ? null : r2(loopSeam),
    coverageFirstLast: firstLast ? [r2(firstLast[0]), r2(firstLast[1])] : null,
    tileSeam: r2(seam / h),
  };
}

/** The analysis as one line, with what to change when something is off. */
export function analysisLine(a: TextureAnalysis, kind: string, opts: { strip: boolean; variants?: boolean; fullBleed?: boolean; loop?: boolean }): { line: string; problems: string[] } {
  const strip = opts.strip;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const parts = [
    `covers ${pct(a.coverage)}`,
    `edges ${a.edgeSoftness >= 0.6 ? 'very soft' : a.edgeSoftness >= 0.3 ? 'soft' : a.edgeSoftness >= 0.12 ? 'firm' : 'hard'} (${a.edgeSoftness})`,
    `peak alpha ${a.peakAlpha}`,
    `colour under alpha ${a.lightness >= 0.8 ? 'white (tints cleanly)' : a.lightness >= 0.45 ? `light grey ${a.lightness} (shaded: keeps its volume when tinted)` : `dark ${a.lightness}`}`,
    `dark fringe texels ${a.darkFringe}`,
  ];
  if (a.continuity !== null && opts.variants) parts.push(`variants for a Random flipbook (likeness ${a.continuity})`);
  else if (a.continuity !== null) parts.push(`frame-to-frame ${a.continuity}`, ...(opts.loop ? [`loop seam ${a.loopSeam}`] : []), `coverage ${pct(a.coverageFirstLast![0])} → ${pct(a.coverageFirstLast![1])}`);
  if (a.cellBorder > 0.02 && !opts.fullBleed) parts.push(`cell border alpha ${a.cellBorder}`);
  if (strip) parts.push(`tiles ${a.tileSeam <= 0.02 ? 'seamlessly' : `with a seam (${a.tileSeam})`}`);
  const problems: string[] = [];
  if (a.darkFringe > 0) problems.push(`${a.darkFringe} edge texels are darker than the shape: they show as a dark outline.`);
  if (a.lightness < 0.45 && kind !== 'vignette') problems.push('The texture itself is dark: a Color can only darken it further (a smoke colour like #5a524c on it reads as a black blob). Keep textures light and tint with Color.');
  if (a.cellBorder > 0.02 && !opts.fullBleed) problems.push('Shapes touch their cell border: mipmaps will mix neighbouring frames. Keep shapes smaller.');
  if (a.coverage < 0.03) problems.push('Almost nothing is drawn: thicker or bigger.');
  if (a.continuity !== null && !opts.variants && a.continuity < 0.6) problems.push(`Frames jump (${a.continuity}): more frames or slower change.`);
  if (opts.loop && a.loopSeam !== null && a.continuity !== null && a.loopSeam < a.continuity - 0.15) problems.push(`The loop doesn't close (last frame to first ${a.loopSeam} against ${a.continuity} between frames).`);
  if (strip && a.tileSeam > 0.02 && kind !== 'lightshaft') problems.push('The strip does not tile: it will show a seam where it repeats along a beam.');
  return { line: parts.join(' · '), problems };
}
