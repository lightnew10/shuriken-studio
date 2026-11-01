import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityVivid, roleOf, withState, type Direction } from '../kit';
import { blend, type Color, type LayerStyle } from '../style';

/** A run of light segments along an edge, fading one after another (a light chasing round the frame). */
const segments = (x: number, y: number, len: number, n: number, thick: number, color: Color, vertical = false): ForgeLayer[] =>
  Array.from({ length: n }, (_, i) => {
    const seg = (len / n) * 0.62;
    const at = x + (len / n) * i;
    return one({ kind: 'rect', radius: thick / 2 }, { fill: lighten(color, 0.35), fillOpacity: 1 - i / (n + 0.6), outerGlow: { color, opacity: 0.9 * (1 - i / (n + 0.6)), size: 6 } }, vertical ? [y, at, thick, seg] : [at, y, seg, thick]);
  });

/** The scan sheen: a soft diagonal band of brighter scanlines across a panel. */
const scanSheen = (line: Color): Partial<LayerStyle> => ({ sheen: { opacity: 0.1, angle: 62, width: 0.22, at: 0.3, color: line } });

/**
 * Neon: sci-fi glass and light (mechs, space, cyberpunk, racing): dark smoked glass with hex grids and scanlines,
 * thin lit edges, corner brackets, light bars, chromatic title type, and buttons that are light itself.
 */

const P = { glass: '#08131e', glass2: '#0e2133', line: '#3fe6ff', hot: '#ff3fd2', warn: '#ffb020', ok: '#3dff9a', deep: '#04090f' };

/** Smoked glass: hex grid, scanlines, an inner glow, a lit inner edge and a faint outer line. */
const glass = (line: Color, on = true, glow = 0.35, alpha = 0.9): LayerStyle => ({
  fill: { angle: 90, stops: [[0, P.glass2, alpha], [1, P.glass, alpha - 0.04]] },
  patterns: [{ kind: 'hex', color: line, opacity: 0.07, size: 9 }, { kind: 'scanlines', color: '#ffffff', opacity: 0.035, size: 3, duty: 0.35 }],
  innerGlow: { color: line, opacity: on ? 0.22 : 0.08, size: 16 },
  rim: { width: 3, color: line, opacity: on ? 0.35 : 0.12, angle: 90, falloff: 3 },
  strokes: [{ width: 1.5, paint: on ? line : darken(line, 0.55), position: 'inside' }, { width: 1, paint: line, position: 'outside', opacity: on ? 0.25 : 0.1 }],
  ...(on ? { outerGlow: { color: line, opacity: glow, size: 9 } } : {}),
  dropShadow: { color: '#000000', opacity: 0.55, blur: 8, offset: [0, 6] },
});

/** A button of light: the colour bright inside, white-hot edge, stripes, glow. */
const light = (col: Color, glow = 0.7): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(col, 0.25), 0.96], [0.5, col, 0.94], [1, darken(col, 0.45), 0.94]] },
  patterns: [{ kind: 'stripes', color: '#ffffff', opacity: 0.1, size: 6, angle: -60, duty: 0.35 }, { kind: 'scanlines', color: '#000000', opacity: 0.12, size: 3 }],
  innerGlow: { color: '#ffffff', opacity: 0.4, size: 7 },
  rim: { width: 4, color: '#ffffff', opacity: 0.5, angle: 90, falloff: 2.5 },
  strokes: [{ width: 1.5, paint: lighten(col, 0.7), position: 'inside' }, { width: 1, paint: lighten(col, 0.4), position: 'outside', opacity: 0.6 }],
  outerGlow: { color: col, opacity: glow, size: 12 },
  dropShadow: { color: '#000000', opacity: 0.5, blur: 6, offset: [0, 6] },
});

export const neon: Direction = {
  id: 'neon',
  label: 'Neon (sci-fi glass and light)',
  for: 'sci-fi, mechs, space, cyberpunk, racing: dark smoked glass with hex grids and scanlines, thin lit edges, corner brackets, glowing light buttons, chromatic titles',
  palette: P,
  fonts: { display: 'Michroma', body: 'TitilliumWeb', weightBody: 700 },
  backdrop: '#060b14',
  text: {
    color: '#d8f8ff',
    onButton: '#021a22',
    title: { color: '#ffffff', stroke: '#0a5a6a', strokePx: 1, font: 'Michroma', minSize: 24 },
    button: { color: '#021a22', font: 'TitilliumWeb', weight: 700 },
    tabOn: { color: '#ffffff', stroke: '#04313c', strokePx: 1.5, font: 'TitilliumWeb', weight: 700 },
    tabOff: { color: '#a8e4f2', font: 'TitilliumWeb', weight: 700 },
    onCard: { color: '#effdff', font: 'TitilliumWeb', weight: 700 },
    onPill: { color: '#effdff', font: 'TitilliumWeb', weight: 700 },
    muted: { color: '#86b8c8', font: 'TitilliumWeb', weight: 600 },
    disabled: { color: '#93a6b0', font: 'TitilliumWeb', weight: 700 },
    buttons: {
      primary: { color: '#021a22', font: 'TitilliumWeb', weight: 700 },
      secondary: { color: '#d8faff', font: 'TitilliumWeb', weight: 700 },
      danger: { color: '#1e0018', font: 'TitilliumWeb', weight: 700 },
      success: { color: '#00240f', font: 'TitilliumWeb', weight: 700 },
      premium: { color: '#261600', font: 'TitilliumWeb', weight: 700 },
    },
  },
  element(r, accent) {
    const line = accent ?? P.line;
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 2, ring: line, grey: '#16222c', greyMix: 0.5 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const cutB = (k: number): [number, number, number, number] => [k, 0, k, 0];
    switch (r.kind) {
      case 'button': {
        if (role === 'secondary') return s({ size: r.size, layers: [one({ kind: 'cut', cut: cutB(h * 0.3) }, glass(line, true, 0.25)), one({ kind: 'rect' }, { fill: line, outerGlow: { color: line, opacity: 0.8, size: 4 } }, [h * 0.3 + 6, h - 4, w * 0.3, 1.5])] });
        const col = role === 'danger' ? P.hot : role === 'success' ? P.ok : role === 'premium' ? P.warn : line;
        const face = light(col, state === 'hover' ? 0.95 : 0.7);
        if (role === 'premium') face.sparkles = { count: 2, size: Math.min(6, h * 0.13), area: 'inside' };
        return s({ size: r.size, layers: [one({ kind: 'cut', cut: cutB(h * 0.3) }, face)] });
      }
      case 'window': {
        // Smoked glass with scanlines, a lit top bar, corner brackets of light, tick marks and a striped tag.
        return { size: r.size, content: [24, 24, w - 48, h - 48], layers: [
          one({ kind: 'cut', cut: [30, 0, 30, 0] }, { ...glass(line, true, 0.22, 0.92), ...scanSheen(line), patterns: [{ kind: 'hex', color: line, opacity: 0.05, size: 12 }, { kind: 'scanlines', color: '#ffffff', opacity: 0.03, size: 3 }], overlays: [{ paint: { type: 'radial', center: [0.5, 0], scale: 1.2, stops: [[0, line, 0.12], [1, line, 0]] }, blend: 'screen' }], dropShadow: { color: '#000000', opacity: 0.6, blur: 16, offset: [0, 12] } }),
          one({ kind: 'cut', cut: [3, 3, 3, 3] }, { fill: { angle: 0, stops: [[0, line, 0], [0.12, line, 1], [0.88, line, 1], [1, line, 0]] }, outerGlow: { color: line, opacity: 0.95, size: 9 } }, [w * 0.2, -1, w * 0.6, 4]),
          one({ kind: 'brackets', length: 26, thickness: 3, inset: 9 }, { fill: lighten(line, 0.45), outerGlow: { color: line, opacity: 0.85, size: 6 } }),
          one({ kind: 'rect' }, { fill: line, fillOpacity: 0.55, patterns: [{ kind: 'stripes', color: '#000000', opacity: 1, size: 7, angle: 0, duty: 0.55 }], outerGlow: { color: line, opacity: 0.4, size: 4 } }, [16, h * 0.35, 3, h * 0.3]),
          one({ kind: 'rect' }, { fill: line, fillOpacity: 0.55, patterns: [{ kind: 'stripes', color: '#000000', opacity: 1, size: 7, angle: 0, duty: 0.55 }], outerGlow: { color: line, opacity: 0.4, size: 4 } }, [w - 19, h * 0.35, 3, h * 0.3]),
          one({ kind: 'polygon', points: [[0.12, 0], [1, 0], [0.88, 1], [0, 1]] }, { fill: line, fillOpacity: 0.85, patterns: [{ kind: 'stripes', color: '#000000', opacity: 0.85, size: 8, angle: -55, duty: 0.5 }], outerGlow: { color: line, opacity: 0.5, size: 5 } }, [w - 150, h - 12, 110, 6]),
          ...segments(40, h - 3, Math.min(220, w * 0.3), 5, 2.5, line),
          ...segments(h * 0.15, 2, Math.min(140, h * 0.3), 4, 2.5, line, true),
        ] };
      }
      case 'header':
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [0, h * 0.45, h * 0.45, 0] }, { ...glass(line, true, 0.35), patterns: [{ kind: 'scanlines', color: '#ffffff', opacity: 0.035, size: 3, duty: 0.35 }], fill: { angle: 90, stops: [[0, darken(line, 0.5), 0.95], [1, P.glass, 0.92]] } }),
          one({ kind: 'rect' }, { fill: line, outerGlow: { color: line, opacity: 0.8, size: 5 } }, [6, h - 3, w - h * 0.45 - 12, 2]),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        const shape = { kind: 'cut' as const, cut: [h * 0.35, 0, h * 0.35, 0] as [number, number, number, number] };
        if (on) return { size: r.size, layers: [one(shape, { ...glass(line, true, 0.55), fill: { angle: 90, stops: [[0, darken(line, 0.35), 0.95], [1, darken(line, 0.7), 0.95]] } }), one({ kind: 'rect' }, { fill: '#ffffff', outerGlow: { color: line, opacity: 1, size: 6 } }, [w * 0.2, h - 3, w * 0.6, 2])] };
        return withState({ size: r.size, layers: [one(shape, glass(line, false))] }, state, look);
      }
      case 'card':
      case 'slot': {
        // Glass tinted by the rarity itself (a yellow light over blue glass would read olive).
        const [top, bot] = rarityVivid(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const k = r.kind === 'slot' ? Math.min(12, w * 0.16) : 16;
        const layers: ForgeLayer[] = [
          one({ kind: 'cut', cut: [k, 0, k, 0] }, {
            ...glass(top, true, big ? 0.4 : 0.22),
            ...scanSheen(top),
            fill: { angle: 90, stops: [[0, blend(P.glass2, darken(top, 0.62), 0.6), 0.95], [1, blend(P.glass, darken(bot, 0.82), 0.6), 0.95]] },
            overlays: [{ paint: { type: 'radial', center: [0.5, 1], scale: 1.3, stops: [[0, top, big ? 0.45 : 0.3], [1, top, 0]] }, blend: 'screen' }],
            strokes: [{ width: 1.5, paint: { angle: 90, stops: [[0, lighten(top, 0.5)], [1, bot]] }, position: 'inside' }, { width: 1, paint: top, position: 'outside', opacity: 0.35 }],
            ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, color: lighten(top, 0.6), area: 'inside' as const } } : {}),
          }),
          one({ kind: 'brackets', length: Math.min(w, h) * 0.16, thickness: 2, inset: 5 }, { fill: lighten(top, 0.5), outerGlow: { color: top, opacity: 0.7, size: 4 } }),
        ];
        if (r.kind === 'card') layers.push(one({ kind: 'polygon', points: [[0, 0], [1, 0], [0.82, 1], [0, 1]] }, { fill: top, patterns: [{ kind: 'stripes', color: '#000000', opacity: 0.35, size: 5, angle: -55, duty: 0.4 }], outerGlow: { color: top, opacity: 0.6, size: 4 } }, [k + 4, 4, w * 0.32, 4]), ...segments(w * 0.55, h - 3.5, w * 0.34, 4, 2, top));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        return { size: r.size, slice: false, layers: [one({ kind: 'hex' }, { ...light(P.hot, 0.8), patterns: [] })] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [h * 0.5, h * 0.5, h * 0.5, h * 0.5] }, { ...glass(line, true, 0.45), patterns: [{ kind: 'scanlines', color: '#ffffff', opacity: 0.05, size: 3, duty: 0.35 }], fill: { angle: 90, stops: [[0, darken(line, 0.3), 0.94], [1, darken(line, 0.6), 0.94]] } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [h * 0.5, 0, h * 0.5, 0] }, { fill: '#030810', fillOpacity: 0.92, strokes: [{ width: 1, paint: darken(line, 0.4), position: 'inside' }], patterns: [{ kind: 'stripes', color: line, opacity: 0.1, size: 6, angle: 90, duty: 0.2 }], innerShadow: { color: '#000000', opacity: 0.7, size: 4, offset: [0, 1] } })] };
      case 'barFill': {
        const col = role === 'danger' ? P.hot : role === 'premium' ? P.warn : role === 'success' ? P.ok : (accent ?? line);
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [h * 0.5, 0, h * 0.5, 0] }, { fill: { angle: 90, stops: [[0, lighten(col, 0.3)], [0.5, col], [1, darken(col, 0.4)]] }, patterns: [{ kind: 'scanlines', color: '#000000', opacity: 0.35, size: 4, duty: 0.3 }], rim: { width: 3, color: '#ffffff', opacity: 0.45, angle: 90 }, outerGlow: { color: col, opacity: 0.75, size: 6 } }),
          one({ kind: 'rect' }, { fill: '#ffffff', outerGlow: { color: col, opacity: 1, size: 5 } }, [w - Math.min(4, w * 0.2), 1, Math.min(2.5, w * 0.1), h - 2]),
        ] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [h * 0.4, 0, h * 0.4, 0] }, { ...glass(line, true, 0.2), patterns: [{ kind: 'scanlines', color: '#ffffff', opacity: 0.035, size: 3, duty: 0.35 }] })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'hex', point: w * 0.25 }, glass(line, true, 0.4)), one({ kind: 'hex', point: w * 0.2 }, { fill: line, fillOpacity: 0.0001, strokes: [{ width: 1, paint: line, position: 'inside', opacity: 0.5 }] }, [w * 0.12, h * 0.12, w * 0.76, h * 0.76])] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'cut', cut: Math.min(w, h) * 0.25 }, glass(P.hot, true, 0.3)), one({ kind: 'cross', thickness: 0.16 }, { fill: '#ffd0f4', outerGlow: { color: P.hot, opacity: 0.9, size: 5 } }, [w * 0.24, h * 0.18, w * 0.52, h * 0.58])] }, state, look);
      case 'title': {
        // Chromatic: magenta and cyan ghosts either side of a white-hot core.
        const text = (r.text ?? 'HANGAR').toUpperCase();
        const t = { kind: 'text' as const, text, font: 'Michroma', tracking: 0.16 };
        const o = Math.max(2, h * 0.04);
        return { size: r.size, slice: false, layers: [
          one(t, { fill: P.hot, fillOpacity: 0.9, outerGlow: { color: P.hot, opacity: 0.55, size: 10 } }, [-o, o * 0.3, w, h]),
          one(t, { fill: line, fillOpacity: 0.9, outerGlow: { color: line, opacity: 0.55, size: 10 } }, [o, -o * 0.3, w, h]),
          one(t, { fill: { angle: 90, stops: [[0, '#ffffff'], [1, lighten(line, 0.6)]] }, strokes: [{ width: 1.5, paint: lighten(line, 0.3), position: 'outside' }], outerGlow: { color: line, opacity: 0.85, size: 7 } }),
        ] };
      }
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'rect' }, { fill: { angle: 0, stops: [[0, line, 0], [0.5, line, 1], [1, line, 0]] }, outerGlow: { color: line, opacity: 0.6, size: 4 } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [12, 0, 12, 0] }, glass(line, true, 0.3)), one({ kind: 'rect' }, { fill: line, outerGlow: { color: line, opacity: 0.9, size: 4 } }, [0, 12, 3, Math.max(6, h - 24)])] };
      case 'icon': {
        const col = role === 'danger' ? P.hot : role === 'premium' ? P.warn : role === 'success' ? P.ok : isRarity(r.variant) ? rarityVivid(r.variant)[0] : line;
        const g = r.glyph ?? 'zap';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 2.2, solid: true }, { fill: { angle: 90, stops: [[0, col, 0.35], [1, col, 0.08]] }, patterns: [{ kind: 'scanlines', color: col, opacity: 0.3, size: 3 }] }),
          one({ kind: 'glyph', name: g, weight: 2.1 }, { fill: lighten(col, 0.6), strokes: [{ width: 0.8, paint: col, position: 'outside', opacity: 0.8 }], outerGlow: { color: col, opacity: 0.95, size: 7 } }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'hex' }, { fill: { angle: 90, stops: [[0, darken(P.warn, 0.25), 0.95], [1, darken(P.warn, 0.7), 0.95]] }, strokes: [{ width: Math.max(1, w * 0.04), paint: lighten(P.warn, 0.3), position: 'inside' }], rim: { width: Math.max(1, w * 0.08), color: '#ffffff', opacity: 0.5, angle: 90 }, outerGlow: { color: P.warn, opacity: 0.65, size: Math.max(3, w * 0.15) } }),
          one({ kind: 'glyph', name: r.glyph ?? 'cpu', weight: 2.2 }, { fill: lighten(P.warn, 0.6), outerGlow: { color: P.warn, opacity: 0.8, size: Math.max(2, w * 0.08) } }, [w * 0.24, h * 0.24, w * 0.52, h * 0.52]),
        ] };
    }
  },
};
