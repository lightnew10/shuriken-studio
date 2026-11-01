import { encodePng, type RgbaImage } from '../../modeling/png';
import { analysisLine, analyzeTexture, type TextureAnalysis } from './analyze';
import { draw, gridFor, TEXTURE_KINDS, type Params, type TextureKind } from './generators';

export { TEXTURE_KINDS, type TextureKind } from './generators';
export type { TextureAnalysis } from './analyze';

export interface MadeTexture {
  png: Buffer;
  /** The texture over a dark and a light checker, tinted once, for looking at it. */
  preview: Buffer;
  width: number;
  height: number;
  grid: number;
  analysis: TextureAnalysis;
  line: string;
  problems: string[];
  fallback: string;
}

/** Sizes Roblox handles well (powers of two, at most 1024). */
const SIZES = [64, 128, 256, 512, 1024];

export function makeTexture(kind: TextureKind, params: Params = {}, opts: { size?: number; frames?: number; seed?: number } = {}): MadeTexture {
  const info = TEXTURE_KINDS[kind];
  if (!info) throw new Error(`Unknown texture kind "${kind}". Kinds: ${Object.keys(TEXTURE_KINDS).join(', ')}`);
  const frames = opts.frames ?? info.frames;
  const grid = gridFor(frames);
  // A flipbook keeps cells of at least 64 px; 8x8 needs 1024.
  const wanted = opts.size ?? (grid >= 8 ? 1024 : grid >= 4 ? 512 : grid >= 2 ? 256 : 256);
  const size = SIZES.reduce((best, s) => (Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best), 256);
  const drawn = draw(kind, params, Math.max(size, grid * 64), frames, opts.seed ?? 1);
  const img = drawn.raster.toImage(drawn.grid);
  const analysis = analyzeTexture(img, drawn.grid);
  const loop = kind === 'fire' ? params.loop !== false : params.loop === true;
  const { line, problems } = analysisLine(analysis, kind, { strip: kind === 'trail' || kind === 'water' || (kind === 'energy' && params.shape === 'tile'), variants: info.variants, fullBleed: info.fullBleed || (kind === 'energy' && params.shape === 'tile'), loop });
  return { png: encodePng(img), preview: encodePng(contactSheet(img)), width: img.width, height: img.height, grid: drawn.grid, analysis, line, problems, fallback: info.fallback };
}

/** Three panels side by side: on black, on a light checker, and tinted orange on black (how it reads in game). */
export function contactSheet(img: RgbaImage): RgbaImage {
  const scale = Math.max(1, Math.floor(256 / Math.max(img.width, img.height)));
  const pw = img.width * scale;
  const ph = img.height * scale;
  const gap = 8;
  const w = pw * 3 + gap * 4;
  const h = ph + gap * 2;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([40, 40, 46, 255], i * 4);
  const panels: Array<{ ox: number; bg: (x: number, y: number) => number[]; tint: number[] }> = [
    { ox: gap, bg: () => [0, 0, 0], tint: [1, 1, 1] },
    { ox: gap * 2 + pw, bg: (x, y) => ((Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? [200, 200, 200] : [235, 235, 235]), tint: [1, 1, 1] },
    { ox: gap * 3 + pw * 2, bg: () => [10, 12, 20], tint: [1, 0.55, 0.15] },
  ];
  for (const p of panels)
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const si = (Math.floor(y / scale) * img.width + Math.floor(x / scale)) * 4;
        const a = img.data[si + 3]! / 255;
        const bg = p.bg(x, y);
        const di = ((gap + y) * w + p.ox + x) * 4;
        for (let c = 0; c < 3; c++) out[di + c] = Math.round(img.data[si + c]! * p.tint[c]! * a + bg[c]! * (1 - a));
        out[di + 3] = 255;
      }
  return { width: w, height: h, data: out };
}
