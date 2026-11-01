import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityOf, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle } from '../style';

/**
 * Aqua: the ocean (fishing, sea and island games, water parks, mermaids): glossy water-drop buttons with caustic light
 * swimming inside, foam-white rims, wave-topped headers and frames, bubbles rising everywhere, jelly icons, pearls.
 */

const P = { deep: '#063a6b', sea: '#0a7fd0', aqua: '#1fb8ec', foam: '#e8fdff', coral: '#ff5f6d', sand: '#ffd27a', kelp: '#1fc48a', pearl: '#f6f0ff', navy: '#04254a' };

/** Glossy water: a gradient, caustic light swimming in it, a glassy shine, a foam rim and a deep outline. */
const water = (base: Color, h: number, o: { depth?: number; bubbles?: boolean } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.35)], [0.5, base], [1, darken(base, 0.3)]] },
  textures: [{ kind: 'caustics', scale: Math.max(10, h * 0.45), opacity: 0.35, color: '#ffffff', blend: 'screen', seed: 4 }],
  ...(o.bubbles !== false ? { patterns: [{ kind: 'bubbles' as const, color: '#ffffff', opacity: 0.35, size: Math.max(10, h * 0.42), duty: 0.45, seed: 3 }] } : {}),
  gloss: { style: 'arc', opacity: 0.55, height: 0.5, inset: 3, curve: 0.5 },
  rim: { width: Math.max(3, h * 0.12), color: '#ffffff', opacity: 0, shade: darken(base, 0.45), shadeOpacity: 0.35 },
  strokes: [{ width: 2, paint: P.foam, position: 'inside', opacity: 0.7 }, { width: 2.5, paint: P.navy, position: 'outside' }],
  extrude: { depth: o.depth ?? Math.max(3, Math.min(7, h * 0.1)), color: darken(base, 0.55), stroke: { width: 2.5, color: P.navy } },
  dropShadow: { color: '#021428', opacity: 0.35, blur: 4, offset: [0, (o.depth ?? Math.max(3, Math.min(7, h * 0.1))) + 3] },
});

/** A soap bubble: almost clear, an iridescent rim, a bright spot. */
const bubble = (): LayerStyle => ({
  fill: { type: 'radial', center: [0.5, 0.5], stops: [[0, '#ffffff', 0.05], [0.75, '#bff4ff', 0.18], [1, '#ffffff', 0.6]] },
  overlays: [{ paint: { type: 'conic', stops: [[0, '#ff9ad8', 0.35], [0.33, '#9af0ff', 0.35], [0.66, '#fff59a', 0.35], [1, '#ff9ad8', 0.35]] }, blend: 'screen' }],
  gloss: { style: 'spot', opacity: 0.9, height: 0.5 },
  strokes: [{ width: 1.2, paint: '#ffffff', position: 'inside', opacity: 0.8 }],
});

export const aqua: Direction = {
  id: 'aqua',
  label: 'Aqua (ocean water and bubbles)',
  for: 'fishing, ocean, island, water-park and mermaid games: glossy water-drop buttons with caustic light, foam rims, wave-topped frames, rising bubbles, jelly icons and pearl coins',
  palette: P,
  fonts: { display: 'FredokaOne', body: 'BuilderSans', weightBody: 800 },
  backdrop: '#0b6ea8',
  text: {
    color: P.navy,
    strokePx: 2.5,
    onButton: '#ffffff',
    onButtonStroke: P.navy,
    title: { color: '#ffffff', stroke: P.navy, strokePx: 3, font: 'FredokaOne', minSize: 22 },
    button: { color: '#ffffff', stroke: P.navy, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    tabOn: { color: '#ffffff', stroke: P.navy, strokePx: 2, font: 'BuilderSans', weight: 800 },
    tabOff: { color: '#073e6c', font: 'BuilderSans', weight: 800 },
    onCard: { color: '#ffffff', stroke: P.navy, strokePx: 2.5, font: 'BuilderSans', weight: 800 },
    onPill: { color: '#ffffff', stroke: P.navy, strokePx: 1.5, font: 'FredokaOne', minSize: 18 },
    muted: { color: '#2a5678', font: 'BuilderSans', weight: 700 },
    disabled: { color: '#f2f6fa', stroke: '#3e4e5e', strokePx: 2, font: 'BuilderSans', weight: 800 },
    buttons: {
      primary: { color: '#ffffff', stroke: P.navy, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      secondary: { color: '#ffffff', stroke: P.navy, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      danger: { color: '#ffffff', stroke: '#3a0410', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      success: { color: '#ffffff', stroke: '#023020', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      premium: { color: '#ffffff', stroke: '#4a2800', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: '#ffffff', grey: '#9ab0c0', greyMix: 0.45 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const sea = accent ?? P.aqua;
    switch (r.kind) {
      case 'button': {
        const base = role === 'secondary' ? '#2f7fe8' : role === 'danger' ? P.coral : role === 'success' ? P.kelp : role === 'premium' ? '#ffb02e' : sea;
        const face = water(base, h);
        if (role === 'premium') face.sparkles = { count: 2, size: Math.min(6, h * 0.13), area: 'inside' };
        return s({ size: r.size, layers: [one({ kind: 'pill' }, face)] });
      }
      case 'window': {
        // Deep water in a foam-rimmed frame whose top is a wave, with bubbles rising in the light.
        const t = 16;
        return { size: r.size, content: [t + 10, t + 18, w - 2 * t - 20, h - 2 * t - 26], layers: [
          one({ kind: 'rect', radius: 30 }, { ...water(P.sea, 80, { depth: 10, bubbles: false }), textures: [{ kind: 'caustics', scale: 40, opacity: 0.25, color: '#ffffff', blend: 'screen' }], gloss: { style: 'band', opacity: 0.25, height: 0.06, inset: 4, curve: 0 }, dropShadow: { color: '#021428', opacity: 0.45, blur: 14, offset: [0, 18] } }),
          one({ kind: 'wave', amplitude: 5, period: 70, side: 'top', radius: 20 }, {
            fill: { angle: 90, stops: [[0, '#d8f8ff'], [0.25, '#9ee6fa'], [1, '#56c4ec']] },
            textures: [{ kind: 'caustics', scale: 36, opacity: 0.5, color: '#ffffff', blend: 'screen', seed: 7 }],
            patterns: [{ kind: 'bubbles', color: '#ffffff', opacity: 0.45, size: 34, duty: 0.4, seed: 8 }],
            innerShadow: { color: P.deep, opacity: 0.35, size: 14, offset: [0, 6] },
            strokes: [{ width: 3, paint: P.foam, position: 'outside' }, { width: 1.5, paint: '#ffffff', position: 'inside', opacity: 0.6 }],
          }, [t, t - 4, w - 2 * t, h - 2 * t + 4]),
          ...[[0.04, 0.2, 18], [0.02, 0.55, 12], [0.95, 0.32, 14], [0.965, 0.7, 9]].map(([fx, fy, r0]) => one({ kind: 'ellipse' }, bubble(), [fx! * w - r0! / 2, fy! * h, r0!, r0!])),
          // A starfish on the bottom-left corner.
          one({ kind: 'star', points: 5, inner: 0.42, round: 4 }, { fill: { type: 'radial', center: [0.5, 0.45], stops: [[0, '#ffb08a'], [1, P.coral]] }, textures: [{ kind: 'speckle', scale: 3, density: 0.6, color: '#fff0e0', opacity: 0.9 }], bevel: { size: 5, style: 'pillow', highlightOpacity: 0.45, shadowOpacity: 0.4, specular: 0.4 }, strokes: [{ width: 2.5, paint: P.navy, position: 'outside' }], dropShadow: { color: '#021428', opacity: 0.4, blur: 2, offset: [0, 4] } }, [-10, h - 52, 60, 58]),
        ] };
      }
      case 'header':
        return { size: r.size, layers: [one({ kind: 'rect', radius: Math.min(28, h * 0.45) }, { ...water(accent ?? P.sea, h, { depth: 5, bubbles: false }), gloss: { style: 'band', opacity: 0.35, height: 0.42, inset: 3, curve: 0 } })] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        if (on) return { size: r.size, layers: [one({ kind: 'pill' }, water(sea, h, { depth: 4 }))] };
        return withState({ size: r.size, layers: [one({ kind: 'pill' }, { ...water('#bfeeff', h, { depth: 3, bubbles: false }), textures: [], strokes: [{ width: 2, paint: '#ffffff', position: 'inside', opacity: 0.7 }, { width: 2, paint: '#2a6a9a', position: 'outside' }], extrude: { depth: 3, color: '#6aaed0', stroke: { width: 2, color: '#2a6a9a' } } })] }, state, look);
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityOf(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const tint = r.variant === 'common' || !r.variant ? '#5aa8d0' : top;
        const face: LayerStyle = {
          ...water(tint, Math.min(h, 80), { depth: 5 }),
          fill: { type: 'radial', center: [0.5, 0.3], scale: 1.2, stops: [[0, lighten(tint, 0.55)], [0.6, tint], [1, darken(bot, 0.2)]] },
          textures: [{ kind: 'caustics', scale: 30, opacity: 0.4, color: '#ffffff', blend: 'screen', seed: 5 }],
          patterns: [{ kind: 'bubbles', color: '#ffffff', opacity: 0.4, size: 26, duty: 0.4, seed: 6 }],
          gloss: { style: 'glass', opacity: 0.25, height: 0.5, inset: 5 },
          ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, area: 'inside' as const } } : {}),
        };
        return withState({ size: r.size, layers: [one({ kind: 'rect', radius: r.kind === 'slot' ? Math.min(20, w * 0.26) : 24 }, face)] }, state, look);
      }
      case 'badge':
        return { size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { ...water(P.coral, h, { depth: 2.5, bubbles: false }), gloss: { style: 'spot', opacity: 0.85, height: 0.55 } })] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.36 }, { ...water(accent ?? P.kelp, h, { depth: 4, bubbles: false }), gloss: { style: 'band', opacity: 0.4, height: 0.45, inset: 2.5, curve: 0 } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, P.navy], [1, '#0a3a6a']] }, innerShadow: { color: '#000000', opacity: 0.55, size: 5, offset: [0, 2] }, strokes: [{ width: 2.5, paint: P.navy, position: 'outside' }, { width: 1, paint: '#ffffff', position: 'outside', opacity: 0 }] })] };
      case 'barFill': {
        const base = role === 'danger' ? P.coral : role === 'premium' ? '#ffb02e' : role === 'success' ? P.kelp : (accent ?? P.aqua);
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, lighten(base, 0.4)], [0.55, base], [1, darken(base, 0.2)]] }, textures: [{ kind: 'caustics', scale: Math.max(8, h * 0.8), opacity: 0.3, color: '#ffffff', blend: 'screen' }], gloss: { style: 'band', opacity: 0.5, height: 0.45, inset: 2, curve: 0 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, '#0e4f8a'], [1, P.navy]] }, textures: [{ kind: 'caustics', scale: 20, opacity: 0.18, color: '#ffffff', blend: 'screen' }], strokes: [{ width: 2.5, paint: P.navy, position: 'outside' }, { width: 1.5, paint: '#8fe4ff', position: 'inside', opacity: 0.45 }], innerShadow: { color: '#000000', opacity: 0.35, size: 5, offset: [0, 2] }, gloss: { style: 'band', opacity: 0.15, height: 0.45, inset: 3, curve: 0 } })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { ...water(accent ?? P.sea, h, { depth: 4, bubbles: false }), fill: { type: 'radial', center: [0.5, 0.4], stops: [[0, '#bff4ff'], [0.7, accent ?? P.aqua], [1, P.sea]] }, gloss: { style: 'spot', opacity: 0.7, height: 0.5 } })] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { ...water(P.coral, h, { depth: 3.5, bubbles: false }), gloss: { style: 'spot', opacity: 0.8, height: 0.5 } }), one({ kind: 'cross', thickness: 0.24 }, { fill: '#ffffff', strokes: [{ width: 2, paint: '#7a1020', position: 'outside' }] }, [w * 0.24, h * 0.18, w * 0.52, h * 0.58])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'OCEAN', font: 'FredokaOne' }, {
          fill: { angle: 90, stops: [[0, '#ffffff'], [0.45, '#9af0ff'], [1, '#1fa8e8']] },
          textures: [{ kind: 'caustics', scale: Math.max(10, h * 0.3), opacity: 0.45, color: '#ffffff', blend: 'screen' }],
          strokes: [{ width: 6.5, paint: P.navy, position: 'outside' }, { width: 3.5, paint: '#ffffff', position: 'outside' }],
          gloss: { style: 'arc', opacity: 0.5, height: 0.5, inset: 1.5, curve: 0.3 },
          extrude: { depth: 6, color: { angle: 90, stops: [[0, '#0a6ac0'], [1, '#043a7a']] }, stroke: { width: 6.5, color: P.navy } },
          sparkles: { count: 3, size: Math.max(5, h * 0.09), area: 'around', color: '#ffffff' },
          dropShadow: { color: '#021428', opacity: 0.4, blur: 3, offset: [0, 10] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 0, stops: [[0, P.aqua, 0], [0.5, P.sea, 0.8], [1, P.aqua, 0]] } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'bubble', radius: 20, tail: [0.16, 18, 14] }, { fill: { angle: 90, stops: [[0, '#f4fdff', 0.97], [1, '#d6f4ff', 0.95]] }, patterns: [{ kind: 'bubbles', color: P.aqua, opacity: 0.3, size: 26, duty: 0.4 }], strokes: [{ width: 2.5, paint: P.navy, position: 'outside' }, { width: 2, paint: '#ffffff', position: 'inside' }], dropShadow: { color: '#021428', opacity: 0.35, blur: 4, offset: [0, 6] } })] };
      case 'icon': {
        // Jelly: a glossy translucent-looking silhouette with a bright spot and a navy line round it.
        const [top, bot] = isRarity(r.variant) ? rarityOf(r.variant) : role === 'danger' ? [lighten(P.coral, 0.3), P.coral] : [lighten(P.aqua, 0.4), P.aqua];
        const tint = r.variant === 'common' ? ['#e8f4fa', '#9ab8c8'] : [top, bot];
        const g = r.glyph ?? 'fish';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3.2, solid: true }, {
            fill: { angle: 90, stops: [[0, lighten(tint[0]!, 0.6)], [0.55, tint[0]!], [1, tint[1]!]] },
            bevel: { size: 2.5, style: 'pillow', highlightOpacity: 0.5, shadowOpacity: 0.35, specular: 0.8 },
            gloss: { style: 'arc', opacity: 0.45, height: 0.45, inset: 1.5 },
            strokes: [{ width: 1.5, paint: '#ffffff', position: 'outside' }, { width: 3.5, paint: P.navy, position: 'outside' }],
            dropShadow: { color: '#021428', opacity: 0.35, blur: 1.5, offset: [0, 3.5] },
          }),
          one({ kind: 'glyph', name: g, weight: 1.9 }, { fill: darken(tint[1]!, 0.45), fillOpacity: 0.6 }),
        ] };
      }
      case 'coin':
        // A pearl: white with a rainbow sheen and a hard highlight (a glyph pressed into it when asked).
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, {
            fill: { type: 'radial', center: [0.38, 0.32], scale: 1.1, stops: [[0, '#ffffff'], [0.55, P.pearl], [1, '#b8a8d8']] },
            overlays: [{ paint: { type: 'conic', stops: [[0, '#ffc8e8', 0.4], [0.33, '#c8f4ff', 0.4], [0.66, '#fff4c8', 0.4], [1, '#ffc8e8', 0.4]] }, blend: 'softlight' }],
            bevel: { size: Math.max(1.5, w * 0.12), style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.3, specular: 0.9 },
            strokes: [{ width: Math.max(1.2, w * 0.05), paint: P.navy, position: 'outside' }],
            dropShadow: { color: '#021428', opacity: 0.35, blur: 1, offset: [0, Math.max(1, h * 0.06)] },
          }),
          ...(r.glyph ? [one({ kind: 'glyph', name: r.glyph, weight: 2.6 }, { fill: '#8a78b8', fillOpacity: 0.85 }, [w * 0.26, h * 0.26, w * 0.48, h * 0.48])] : []),
        ] };
    }
  },
};
