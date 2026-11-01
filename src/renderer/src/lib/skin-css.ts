import type { CSSProperties } from 'react';
import { layoutScreen, withState, type Measure, type UiBox, type UiNode, type UiScreen, type UiStateName } from '@shared/ui-layout';
import type { MockVersion } from '@shared/ui-mockup';

/**
 * Forged skins on the UI page's canvases (components/ui/ui-canvas.tsx): an ImageLabel whose image is "skin:<key>"
 * with ScaleType Slice is drawn the way Roblox draws a 9-slice — the SliceCenter's insets cut the PNG into corners,
 * edges and a middle; the corners and edges keep inset × SliceScale points (times the element's UIScale, as the core's
 * renderer does), the middle stretches (forged skins have a narrow centre that only ever stretches, as Roblox needs).
 * Drawn into one canvas bitmap at the board's pixel density (slicePlan), or as CSS border-image (sliceCss) where the
 * density isn't known; Stretch art fills its box.
 */

const sizes = new Map<string, { w: number; h: number } | null>();

/** A PNG data URL's size in pixels, read from its header (IHDR); null for anything else. */
export function pngSize(url: string): { w: number; h: number } | null {
  if (!url.startsWith('data:image/png;base64,')) return null;
  const hit = sizes.get(url.slice(0, 64));
  if (hit !== undefined) return hit;
  let out: { w: number; h: number } | null = null;
  try {
    const head = atob(url.slice(22, 22 + 32));
    const at = (i: number) => ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0;
    if (head.slice(12, 16) === 'IHDR') out = { w: at(16), h: at(20) };
  } catch {
    out = null;
  }
  // The first 64 characters hold the header and the size: enough to tell images apart for this.
  sizes.set(url.slice(0, 64), out);
  return out;
}

/** A SliceCenter (min x, min y, max x, max y in image pixels) as insets from each edge: top, right, bottom, left. */
export function sliceInsets(slice: [number, number, number, number], w: number, h: number): [number, number, number, number] {
  const left = Math.max(0, Math.min(w, slice[0]));
  const top = Math.max(0, Math.min(h, slice[1]));
  const right = Math.max(0, Math.min(w - left, w - slice[2]));
  const bottom = Math.max(0, Math.min(h - top, h - slice[3]));
  return [top, right, bottom, left];
}

/**
 * The CSS for a 9-sliced image filling its box: `k` is the element's UIScale (the layout's k), so an edge is
 * inset × sliceScale × k points, as Roblox and the core's renderer draw it.
 */
export function sliceCss(o: { url: string; w: number; h: number; slice: [number, number, number, number]; sliceScale?: number; k?: number }): CSSProperties {
  const [t, r, b, l] = sliceInsets(o.slice, o.w, o.h);
  const s = (o.sliceScale ?? 1) * (o.k ?? 1);
  const px = (v: number) => `${+(v * s).toFixed(3)}px`;
  const widths = `${px(t)} ${px(r)} ${px(b)} ${px(l)}`;
  return {
    boxSizing: 'border-box',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderWidth: widths,
    borderImageSource: `url("${o.url}")`,
    borderImageSlice: `${t} ${r} ${b} ${l} fill`,
    borderImageWidth: widths,
    borderImageOutset: 0,
    borderImageRepeat: 'stretch',
  };
}

/**
 * The nine pieces of a 9-slice drawn into a canvas `cw`×`ch` pixels showing the element at `zoom` pixels per point:
 * [sx, sy, sw, sh, dx, dy, dw, dh] each, source rects in image pixels, destination rects on whole canvas pixels so
 * neighbours meet exactly. (CSS border-image paints the nine as separate quads: under the board's scale they land on
 * fractional pixels and leave hairline seams; one canvas bitmap has none.) Edges that don't fit shrink together, as
 * border-image does.
 */
export function slicePlan(o: { w: number; h: number; slice: [number, number, number, number]; sliceScale?: number; k?: number; cw: number; ch: number; zoom: number }): Array<[number, number, number, number, number, number, number, number]> {
  const [t, r, b, l] = sliceInsets(o.slice, o.w, o.h);
  const s = (o.sliceScale ?? 1) * (o.k ?? 1) * o.zoom;
  const f = Math.min(1, (l + r) * s > 0 ? o.cw / ((l + r) * s) : 1, (t + b) * s > 0 ? o.ch / ((t + b) * s) : 1);
  const x1 = Math.round(l * s * f);
  const x2 = Math.max(x1, o.cw - Math.round(r * s * f));
  const y1 = Math.round(t * s * f);
  const y2 = Math.max(y1, o.ch - Math.round(b * s * f));
  const sx = [0, l, o.w - r, o.w];
  const sy = [0, t, o.h - b, o.h];
  const dx = [0, x1, x2, o.cw];
  const dy = [0, y1, y2, o.ch];
  const out: Array<[number, number, number, number, number, number, number, number]> = [];
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      const sw = sx[i + 1]! - sx[i]!;
      const sh = sy[j + 1]! - sy[j]!;
      const dw = dx[i + 1]! - dx[i]!;
      const dh = dy[j + 1]! - dy[j]!;
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) out.push([sx[i]!, sy[j]!, sw, sh, dx[i]!, dy[j]!, dw, dh]);
    }
  return out;
}

/** The canvas size for an element of `w`×`h` points at `zoom` pixels per point (at most about 8 million pixels). */
export function canvasSize(w: number, h: number, zoom: number): { cw: number; ch: number; zoom: number } {
  let z = Math.max(0.05, zoom);
  const area = w * h * z * z;
  if (area > 8e6) z *= Math.sqrt(8e6 / area);
  return { cw: Math.max(1, Math.round(w * z)), ch: Math.max(1, Math.round(h * z)), zoom: z };
}

/** Whether a node's image is forged skin art (drawn here; its size comes with it). */
export const isSkinRef = (ref: string | undefined): boolean => !!ref && ref.startsWith('skin:');

/**
 * The children of elements in a state, laid out in it: a state that wears other art (a pressed button's own art, an
 * active tab) changes its "Skin" child's image, slice and reach and moves its "Label", as withState does before the
 * core's renderer lays a screen out. The element's own scale stays (the canvas plays it as a transform). By node id.
 */
export function childrenInState(screen: UiNode, states: ReadonlyMap<string, UiStateName>, device: UiScreen, measure?: Measure, show?: ReadonlySet<number>): Map<number, UiBox> {
  const out = new Map<number, UiBox>();
  const touched: string[] = [];
  const walk = (n: UiNode, path: string): UiNode => {
    const st = states.get(path);
    let next = n;
    if (st && n.states?.[st]) {
      next = { ...withState(n, st), scale: n.scale };
      touched.push(path);
    }
    return next.kids?.length ? { ...next, kids: next.kids.map((c) => walk(c, `${path}.${c.name}`)) } : next;
  };
  const changed = walk(screen, screen.name);
  if (!touched.length) return out;
  for (const b of layoutScreen(changed, device, { ...(measure ? { measure } : {}), ...(show ? { show } : {}) })) if (touched.some((p) => b.path.startsWith(`${p}.`))) out.set(b.node.id, b);
  return out;
}

/** Whether a version's screens wear skins ("skin": "dir:kind…" anywhere). */
export const wearsSkins = (v: Pick<MockVersion, 'screens'> | undefined): boolean => !!v && JSON.stringify(v.screens).includes('"skin":"');

/** The image refs a set of screens shows (a state's art too). */
export function wornRefs(screens: UiNode[]): string[] {
  const out = new Set<string>();
  const walk = (n: UiNode) => {
    if (n.image?.startsWith('skin:')) out.add(n.image);
    for (const p of Object.values(n.states ?? {})) if (p?.skinArt?.image) out.add(p.skinArt.image);
    n.kids?.forEach(walk);
  };
  screens.forEach(walk);
  return [...out];
}
