import { shapePolygon, type UiShape, type UiStroke } from '@shared/ui-layout';
import type { RgbaImage } from '../modeling/png';
import { fillMask, maskTimes, strokeOutline, wound, type Mask, type Pt } from './ui-raster';

/**
 * Panel shapes Roblox has no property for (corners cut at 45°, sides that lean), as the images the game builds
 * them from: a white fill and one white outline per stroke, all on one canvas (the outline's outer band in its
 * margin), drawn at two pixels per design point and 9-sliced so the cut corners keep their size whatever the
 * panel's size (a leaning side sits in the stretched edge column: it stays straight, steeper or flatter as the
 * panel grows). ImageColor3 tints them (the fill takes BackgroundColor3, each outline its stroke's colour) and a
 * UIGradient on each image fades or colours it, as on any element. The kit's Ui.shape lays them out.
 */

/** Image pixels per design point (SliceScale 0.5 brings them back to points). */
export const SHAPE_PX = 2;

export interface ShapeImages {
  fill: RgbaImage;
  /** One per stroke round the box (text strokes are the letters'), lowest ZIndex first. */
  lines: Array<{ image: RgbaImage; stroke: UiStroke }>;
  /** The design size of the panel (points) and the margin round it the images hold for outer strokes. */
  size: [number, number];
  pad: number;
  /** SliceCenter in image pixels: [minX, minY, maxX, maxY]. */
  slice: [number, number, number, number];
}

const toImage = (m: Mask | null, w: number, h: number): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, 0], i * 4);
  if (m)
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const a = m.a[y * m.w + x]!;
        if (a > 0) data[((m.y0 + y) * w + m.x0 + x) * 4 + 3] = Math.round(Math.min(1, a) * 255);
      }
  return { width: w, height: h, data };
};

/** The images of a shaped panel of `w` × `h` design points with its strokes. */
export function shapeImages(shape: UiShape, w: number, h: number, strokes: UiStroke[]): ShapeImages {
  const box = strokes.filter((s) => !s.text);
  const pad = Math.ceil(Math.max(0, ...box.map((s) => ((s.pos ?? 'Outer') === 'Outer' ? s.px : (s.pos ?? 'Outer') === 'Center' ? s.px / 2 : 0))));
  const W = Math.ceil((w + 2 * pad) * SHAPE_PX);
  const H = Math.ceil((h + 2 * pad) * SHAPE_PX);
  const bounds = { x: 0, y: 0, w: W, h: H };
  const outline: Pt[] = shapePolygon(shape, w, h).map(([x, y]) => [(x + pad) * SHAPE_PX, (y + pad) * SHAPE_PX]);
  const body = fillMask([wound(outline, 1)], bounds);
  const lines = box.map((s) => {
    const px = s.px * SHAPE_PX;
    const pos = s.pos ?? 'Outer';
    const band = fillMask(strokeOutline([outline], pos === 'Center' ? px / 2 : px), bounds);
    const m = band ? (pos === 'Center' ? band : maskTimes(band, body, pos === 'Outer')) : null;
    return { image: toImage(m, W, H), stroke: s };
  });
  // The corners and leaning sides stay in the slices that keep their size (or stretch only along the side).
  const [ctl, ctr, cbr, cbl] = shape.cut ?? [0, 0, 0, 0];
  const [sl, sr] = shape.slant ?? [0, 0];
  const inner = Math.max(0, ...box.map((s) => ((s.pos ?? 'Outer') === 'Inner' ? s.px : (s.pos ?? 'Outer') === 'Center' ? s.px / 2 : 0)));
  const left = pad + Math.max(ctl, cbl, Math.abs(sl)) + inner + 1;
  const right = pad + Math.max(ctr, cbr, Math.abs(sr)) + inner + 1;
  const top = pad + Math.max(ctl, ctr) + inner + 1;
  const bottom = pad + Math.max(cbl, cbr) + inner + 1;
  const sx = (v: number) => Math.round(v * SHAPE_PX);
  const slice: [number, number, number, number] = [sx(Math.min(left, (w + 2 * pad) / 2 - 1)), sx(Math.min(top, (h + 2 * pad) / 2 - 1)), sx(Math.max(w + 2 * pad - right, (w + 2 * pad) / 2 + 1)), sx(Math.max(h + 2 * pad - bottom, (h + 2 * pad) / 2 + 1))];
  return { fill: toImage(body, W, H), lines, size: [w, h], pad, slice };
}
