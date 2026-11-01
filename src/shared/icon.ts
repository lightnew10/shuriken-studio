/**
 * UI icons drawn from the game's own 3D models (tool ui_icon): the angle a model is looked at from, the box of
 * what was drawn, and where that goes in the square icon. The app's hidden render page draws them
 * (renderer/src/render-sheet.ts); these parts are plain arithmetic so they can be tested without a canvas.
 */

/** From where the model is seen. */
export type IconView = 'three-quarter' | 'front' | 'side' | 'top';

/** Azimuth and elevation (radians) per view: the Models page opens at three-quarter. */
export const ICON_VIEWS: Record<IconView, [number, number]> = {
  'three-quarter': [0.7, 0.42],
  front: [0, 0.1],
  side: [Math.PI / 2, 0.1],
  top: [0.5, 1.25],
};

/** An icon's name: it becomes a key of the generated UiIcons module and a file name. */
export const ICON_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Pixels on a side of a finished icon, and how thick its outline is (a share of the side). */
export const ICON_SIZE = 512;
export const ICON_OUTLINE = 0.022;
/** Empty border kept around the drawn model (a share of the side), so UICorner and ScaleType.Fit never clip it. */
export const ICON_MARGIN = 0.04;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The box of pixels that are not transparent in RGBA data, or null when nothing was drawn. */
export function alphaBounds(data: ArrayLike<number>, width: number, height: number, threshold = 8): Box | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Outline thickness in pixels for an icon of `out` pixels (0 when there is none). */
export function outlinePx(out: number, outline: boolean): number {
  return outline ? Math.max(2, Math.round(out * ICON_OUTLINE)) : 0;
}

/**
 * Where the drawn box goes in an `out` × `out` icon: scaled to fill it, centred, leaving the margin and room
 * for the outline on every side. The model keeps its proportions.
 */
export function iconFit(box: Box, out: number, stroke: number): Box {
  const room = out - 2 * (Math.round(out * ICON_MARGIN) + stroke);
  const scale = room / Math.max(box.w, box.h, 1);
  const w = box.w * scale;
  const h = box.h * scale;
  return { x: (out - w) / 2, y: (out - h) / 2, w, h };
}
