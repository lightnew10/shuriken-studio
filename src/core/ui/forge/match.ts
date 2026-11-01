import { DIRECTIONS } from './directions';

/**
 * The art directions nearest a reference picture's colours: each direction's palette against the picture's main
 * colours (by area) and accents, in OKLab (distances there track how different colours look). The accent to tint the
 * direction with is the picture's loudest accent when the direction's own key colour is far from it.
 */

type Lab = [number, number, number];

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
};
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function oklab(hex: string): Lab {
  const [r, g, b] = hexRgb(hex).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dist = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const chroma = (c: Lab) => Math.hypot(c[1], c[2]);

export interface DirectionMatch {
  id: string;
  label: string;
  /** 0..1: how close its palette is to the picture's colours. */
  fit: number;
  /** "#rrggbb" to tint it with, when the picture's key colour differs from the direction's. */
  accent?: string;
}

export function matchDirections(palette: { main: Array<{ hex: string; share: number }>; accents: Array<{ hex: string }> }): DirectionMatch[] {
  const main = palette.main.map((c) => ({ lab: oklab(c.hex), w: c.share }));
  const total = main.reduce((t, c) => t + c.w, 0) || 1;
  const accents = palette.accents.map((c) => ({ hex: c.hex, lab: oklab(c.hex) }));
  const loud = [...accents, ...palette.main.map((c) => ({ hex: c.hex, lab: oklab(c.hex) }))].sort((a, b) => chroma(b.lab) - chroma(a.lab))[0];
  const out: DirectionMatch[] = [];
  for (const d of Object.values(DIRECTIONS)) {
    const colours = Object.values(d.palette)
      .filter((v): v is string => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v))
      .map(oklab);
    if (!colours.length) continue;
    // How far each of the picture's main colours is from the nearest palette colour (weighted by area)...
    let near = 0;
    for (const c of main) near += (c.w / total) * Math.min(...colours.map((p) => dist(c.lab, p)));
    // ...and whether the palette's loudest colour is the picture's (its accent family).
    const key = colours.reduce((a, b) => (chroma(b) > chroma(a) ? b : a));
    const keyGap = loud ? dist(key, loud.lab) : 0;
    const fit = Math.max(0, 1 - (near * 2.2 + keyGap * 0.8));
    out.push({ id: d.id, label: d.label, fit: Math.round(fit * 100) / 100, ...(loud && keyGap > 0.12 && chroma(loud.lab) > 0.08 ? { accent: loud.hex.toLowerCase() } : {}) });
  }
  return out.sort((a, b) => b.fit - a.fit);
}
