import type { ForgeLayer, ForgeSpec } from './forge';
import type { Stop } from './style';

/**
 * Light and effect art in any colour, for every direction: a soft radial glow behind a hero item, light rays, a halo,
 * sparkles, a shine streak, a vignette, a spotlight. Roblox draws a UIGradient's Radial type as a plain linear one
 * (measured: the Lab warns), so a glow that must be round is an image — worn as skin "fx:<kind>#rrggbb".
 */

export const FX_KINDS = ['glow', 'rays', 'halo', 'sparkles', 'shine', 'vignette', 'spotlight'] as const;
export type FxKind = (typeof FX_KINDS)[number];

const fade = (c: string, stops: Array<[number, number]>): Stop[] => stops.map(([t, a]) => [t, c, a]);

/** The art for an effect at a size (design points), in a colour (default white; the vignette's default is black). */
export function fxSpec(kind: FxKind, size: [number, number], color?: string): ForgeSpec {
  const [w, h] = size;
  const c = color ?? (kind === 'vignette' ? '#000000' : '#ffffff');
  const all = (layer: Omit<ForgeLayer, 'at'>, at?: ForgeLayer['at']): ForgeLayer => ({ ...layer, ...(at ? { at } : {}) });
  const m = Math.min(w, h);
  let layers: ForgeLayer[];
  switch (kind) {
    case 'glow':
      layers = [all({ shape: { kind: 'ellipse' }, style: { fill: { type: 'radial', stops: fade(c, [[0, 0.95], [0.25, 0.6], [0.55, 0.22], [1, 0]]) } } })];
      break;
    case 'rays':
      layers = [
        all({ shape: { kind: 'burst', points: 12, inner: 0.22, round: 0 }, style: { fill: { type: 'radial', stops: fade(c, [[0, 0.7], [0.45, 0.32], [1, 0]]) } } }),
        all({ shape: { kind: 'ellipse' }, style: { fill: { type: 'radial', stops: fade(c, [[0, 0.8], [0.35, 0.25], [1, 0]]) } } }, [w * 0.2, h * 0.2, w * 0.6, h * 0.6]),
      ];
      break;
    case 'halo': {
      const t = Math.max(2, m * 0.06);
      layers = [
        all({ shape: { kind: 'ellipse' }, style: { fill: { type: 'radial', stops: fade(c, [[0, 0], [0.62, 0.12], [0.8, 0.35], [1, 0]]) } } }),
        all({ shape: { kind: 'ring', thickness: t }, style: { fill: c, fillOpacity: 0.85, outerGlow: { color: c, opacity: 0.7, size: t * 2.2 } } }, [w * 0.12, h * 0.12, w * 0.76, h * 0.76]),
      ];
      break;
    }
    case 'sparkles': {
      // Fixed places (the same every time): a few big four-point sparkles and small ones.
      const spots: Array<[number, number, number]> = [[0.2, 0.25, 0.22], [0.78, 0.18, 0.16], [0.68, 0.7, 0.24], [0.3, 0.78, 0.12], [0.5, 0.45, 0.1], [0.88, 0.5, 0.09], [0.1, 0.55, 0.08]];
      layers = spots.map(([x, y, r]) => {
        const s = m * r;
        return all({ shape: { kind: 'sparkle', points: 4, pinch: 0.8 }, style: { fill: { type: 'radial', stops: fade(c, [[0, 1], [1, 0.75]]) }, outerGlow: { color: c, opacity: 0.6, size: s * 0.35 } } }, [w * x - s / 2, h * y - s / 2, s, s]);
      });
      break;
    }
    case 'shine':
      layers = [all({ shape: { kind: 'rect' }, style: { fill: { type: 'linear', angle: 115, stops: fade(c, [[0, 0], [0.38, 0], [0.47, 0.55], [0.5, 0.8], [0.53, 0.55], [0.62, 0], [1, 0]]) } } })];
      break;
    case 'vignette':
      layers = [all({ shape: { kind: 'rect' }, style: { fill: { type: 'radial', scale: 1.25, stops: fade(c, [[0, 0], [0.55, 0], [0.85, 0.35], [1, 0.7]]) } } })];
      break;
    case 'spotlight':
      layers = [all({ shape: { kind: 'ellipse' }, style: { fill: { type: 'radial', center: [0.5, 0.15], scale: 1.1, stops: fade(c, [[0, 0.8], [0.4, 0.35], [1, 0]]) } } })];
      break;
  }
  return { size, slice: false, layers };
}
