import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityVivid, roleOf, withState, type Direction } from '../kit';
import type { Color, Gradient, LayerStyle, StrokeStyle } from '../style';

/**
 * Royal: velvet, gold and jewels (kingdoms, castles, royal high-school and dress-up, luxury VIP shops): deep velvet with
 * a soft pile sheen, gilded filigree frames in double lines with corner flourishes, faceted gem buttons with glints,
 * scalloped bunting, a crown over the window, Roman capitals in heavy gold.
 */

const P = { velvet: '#4a0f5a', velvet2: '#2a0636', crimson: '#8a0f2a', gold: '#f2c14a', goldHi: '#fff4c0', gold2: '#9a6410', ivory: '#fff6e0', ruby: '#d0103a', sapphire: '#1f4fd8', emerald: '#0fa86a', amethyst: '#9b3fe0', ink: '#1a0620' };

const GOLD: Gradient = { angle: 90, stops: [[0, P.goldHi], [0.35, P.gold], [0.7, '#c88a20'], [1, P.gold2]] };
const gilt = (width: number, position: StrokeStyle['position'] = 'outside'): StrokeStyle => ({ width, paint: GOLD, position });

/** Velvet: the pile's sheen (lighter in the middle, darker at the folds of the edges) and its fine fabric. */
const velvet = (base: Color): LayerStyle => ({
  fill: { type: 'radial', center: [0.5, 0.4], scale: 1.3, stops: [[0, lighten(base, 0.18)], [0.6, base], [1, darken(base, 0.45)]] },
  textures: [{ kind: 'fabric', scale: 1.6, opacity: 0.3, blend: 'overlay' }, { kind: 'clouds', scale: 50, opacity: 0.25, blend: 'softlight', seed: 6 }],
  innerGlow: { color: '#000000', opacity: 0.35, size: 14, blend: 'multiply' },
});

/** Polished gold metal: bright, a rounded bevel with a tight specular. */
const goldMetal = (): LayerStyle => ({
  fill: GOLD,
  textures: [{ kind: 'brushed', scale: 3, opacity: 0.15, blend: 'overlay' }],
  bevel: { size: 2.5, style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.5, specular: 0.8 },
  strokes: [{ width: 1.2, paint: '#3a2004', position: 'outside', opacity: 0.85 }],
  dropShadow: { color: '#000000', opacity: 0.45, blur: 1.5, offset: [0, 2] },
});

/** A cut gem: facets (a chiselled bevel), a hard glint, set in gold. */
const gem = (base: Color, h: number): LayerStyle => ({
  fill: { angle: 120, stops: [[0, lighten(base, 0.45)], [0.45, base], [1, darken(base, 0.45)]] },
  bevel: { size: Math.max(3, h * 0.2), style: 'chisel', highlightOpacity: 0.65, shadowOpacity: 0.55, specular: 0.9 },
  gloss: { style: 'glass', opacity: 0.25, height: 0.55, inset: 3 },
  strokes: [{ width: 1.2, paint: lighten(base, 0.6), position: 'inside', opacity: 0.5 }, gilt(3)],
  extrude: { depth: Math.max(3, h * 0.08), color: { angle: 90, stops: [[0, '#c88a20'], [1, '#5a3404']] }, stroke: { width: 1.2, color: '#2a1404' } },
  sparkles: { count: 1, size: Math.max(4, h * 0.14), area: 'inside', opacity: 0.95 },
  dropShadow: { color: '#0a0010', opacity: 0.5, blur: 3, offset: [0, Math.max(5, h * 0.1)] },
});

/** A gold flourish for a corner: a diamond, two pearls and a jewel. */
const flourish = (x: number, y: number, s: number, jewel: Color): ForgeLayer[] => [
  one({ kind: 'polygon', points: [[0.5, 0], [0.62, 0.38], [1, 0.5], [0.62, 0.62], [0.5, 1], [0.38, 0.62], [0, 0.5], [0.38, 0.38]] }, goldMetal(), [x - s / 2, y - s / 2, s, s]),
  one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#ffffff'], [0.6, lighten(jewel, 0.2)], [1, darken(jewel, 0.4)]] }, bevel: { size: s * 0.1, style: 'round', specular: 1, highlightOpacity: 0.6 }, strokes: [{ width: 1, paint: '#2a1404', position: 'outside' }] }, [x - s * 0.14, y - s * 0.14, s * 0.28, s * 0.28]),
];

export const royal: Direction = {
  id: 'royal',
  label: 'Royal (velvet, gold and jewels)',
  for: 'kingdoms, castles, royal and dress-up games, luxury VIP and premium shops: deep velvet with a pile sheen, gilded double-line frames with corner flourishes, faceted gem buttons, scalloped bunting, heavy gold Roman capitals',
  palette: P,
  fonts: { display: 'RomanAntique', body: 'Merriweather', weightBody: 700 },
  backdrop: '#2a0a30',
  text: {
    color: P.ivory,
    stroke: P.ink,
    strokePx: 1,
    onButton: '#ffffff',
    onButtonStroke: P.ink,
    title: { color: P.goldHi, stroke: P.ink, strokePx: 2, font: 'RomanAntique', minSize: 24 },
    button: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'RomanAntique', minSize: 20 },
    tabOn: { color: P.ink, font: 'Merriweather', weight: 700 },
    tabOff: { color: P.goldHi, stroke: P.ink, strokePx: 1.5, font: 'Merriweather', weight: 700 },
    onCard: { color: P.ivory, stroke: P.ink, strokePx: 2, font: 'Merriweather', weight: 700 },
    onPill: { color: P.goldHi, stroke: P.ink, strokePx: 1.5, font: 'Merriweather', weight: 700 },
    muted: { color: '#dcc4dc', font: 'Merriweather', weight: 700 },
    disabled: { color: '#e2dce2', stroke: '#2a242a', strokePx: 2, font: 'Merriweather', weight: 700 },
    buttons: {
      primary: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'RomanAntique', minSize: 20 },
      secondary: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'RomanAntique', minSize: 20 },
      danger: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'RomanAntique', minSize: 20 },
      success: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'RomanAntique', minSize: 20 },
      premium: { color: P.ink, font: 'RomanAntique', minSize: 20 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: P.goldHi, grey: '#5a5060', greyMix: 0.45 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const vel = accent ?? P.velvet;
    switch (r.kind) {
      case 'button': {
        if (role === 'premium') return s({ size: r.size, layers: [one({ kind: 'rect', radius: Math.min(10, h * 0.22) }, { ...goldMetal(), bevel: { size: Math.max(3, h * 0.12), style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.5, specular: 0.9 }, strokes: [{ width: 1.5, paint: '#3a2004', position: 'outside' }], extrude: { depth: Math.max(3, h * 0.08), color: '#5a3404', stroke: { width: 1.5, color: '#2a1404' } }, sparkles: { count: 2, size: Math.min(6, h * 0.13), area: 'inside' }, dropShadow: { color: '#0a0010', opacity: 0.5, blur: 3, offset: [0, Math.max(5, h * 0.1)] } })] });
        const base = role === 'secondary' ? P.sapphire : role === 'danger' ? P.ruby : role === 'success' ? P.emerald : (accent ?? P.amethyst);
        return s({ size: r.size, layers: [one({ kind: 'rect', radius: Math.min(10, h * 0.22) }, gem(base, h))] });
      }
      case 'window': {
        // Velvet in a gilded double frame: corner flourishes, pearls along the rail, a crown over the top.
        const t = 18;
        return { size: r.size, content: [t + 12, t + 22, w - 2 * t - 24, h - 2 * t - 30], layers: [
          one({ kind: 'rect', radius: 18 }, { ...goldMetal(), bevel: { size: 6, style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.55, specular: 0.7 }, strokes: [{ width: 2, paint: '#2a1404', position: 'outside' }], dropShadow: { color: '#0a0010', opacity: 0.6, blur: 16, offset: [0, 14] }, outerGlow: { color: P.gold, opacity: 0.15, size: 16 } }),
          one({ kind: 'rect', radius: 12 }, { ...velvet(vel), strokes: [{ width: 2, paint: '#2a1404', position: 'outside' }], innerShadow: { color: '#000000', opacity: 0.6, size: 14, offset: [0, 5] } }, [t, t, w - 2 * t, h - 2 * t]),
          one({ kind: 'frame', thickness: 1.5, radius: 8 }, { fill: GOLD, fillOpacity: 0.85 }, [t + 8, t + 8, w - 2 * t - 16, h - 2 * t - 16]),
          one({ kind: 'rivets', radius: 2.6, inset: 0, spacing: 26 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#ffffff'], [1, '#e8dcc8']] }, strokes: [{ width: 0.8, paint: '#6a5a40', position: 'outside' }] }, [40, t / 2, w - 80, h - t]),
          ...flourish(t, t, 40, P.ruby),
          ...flourish(w - t, t, 40, P.ruby),
          ...flourish(w - t, h - t, 40, P.ruby),
          ...flourish(t, h - t, 40, P.ruby),
          one({ kind: 'glyph', name: 'crown', weight: 2.6, solid: true }, { ...goldMetal(), strokes: [{ width: 1.5, paint: '#2a1404', position: 'outside' }], sparkles: { count: 1, size: 6, area: 'inside' } }, [w / 2 - 26, -30, 52, 46]),
        ] };
      }
      case 'header':
        // A velvet valance on a gold rail, a gold fringe below, a jewel at each end.
        return { size: r.size, layers: [
          one({ kind: 'rect', radius: [4, 4, Math.min(16, h * 0.3), Math.min(16, h * 0.3)] }, { ...velvet(accent ?? P.crimson), strokes: [gilt(3)], dropShadow: { color: '#0a0010', opacity: 0.45, blur: 4, offset: [0, 6] } }),
          one({ kind: 'rect', radius: 2 }, { ...goldMetal(), dropShadow: undefined }, [-4, -2, w + 8, Math.max(7, h * 0.13)]),
          one({ kind: 'rect', radius: 1 }, { fill: GOLD, fillOpacity: 0.9 }, [Math.min(16, h * 0.3), h - 9, w - 2 * Math.min(16, h * 0.3), 2]),
          ...flourish(Math.min(24, h * 0.4), h * 0.55, Math.min(30, h * 0.5), P.sapphire),
          ...flourish(w - Math.min(24, h * 0.4), h * 0.55, Math.min(30, h * 0.5), P.sapphire),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        if (on) return { size: r.size, layers: [one({ kind: 'rect', radius: [12, 12, 4, 4] }, { ...goldMetal(), bevel: { size: 3, style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.45, specular: 0.8 }, strokes: [{ width: 1.5, paint: '#2a1404', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.45, blur: 3, offset: [0, 4] } })] };
        return withState({ size: r.size, layers: [one({ kind: 'rect', radius: [12, 12, 4, 4] }, { ...velvet(darken(vel, 0.15)), strokes: [gilt(2)], dropShadow: { color: '#000000', opacity: 0.45, blur: 3, offset: [0, 4] } })] }, state, look);
      }
      case 'card':
      case 'slot': {
        // Velvet dyed in the rarity's own jewel tone, lit in its vivid colour (gold over purple would muddy).
        const [top, bot] = rarityVivid(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const dye: Record<string, Color> = { common: '#3e3450', rare: '#16286e', epic: '#4a0f6a', legendary: '#6e3e04', mythic: '#6e0a2a' };
        const layers: ForgeLayer[] = [one({ kind: 'rect', radius: 10 }, {
          ...velvet(dye[r.variant ?? 'common'] ?? vel),
          overlays: [{ paint: { type: 'radial', center: [0.5, 0.36], scale: 0.95, stops: [[0, top, big ? 0.34 : 0.28], [1, top, 0]] }, blend: 'screen' }],
          strokes: [gilt(r.kind === 'slot' ? 2.5 : 3), { width: 1.5, paint: lighten(top, 0.2), position: 'inside', opacity: 0.6 }],
          dropShadow: { color: '#0a0010', opacity: 0.5, blur: 3, offset: [0, 5] },
          ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, color: P.goldHi, area: 'inside' as const } } : {}),
        })];
        if (r.kind === 'card') layers.push(one({ kind: 'gem' }, { fill: { angle: 90, stops: [[0, lighten(top, 0.6)], [0.5, top], [1, darken(bot, 0.2)]] }, bevel: { size: 3, style: 'chisel', highlightOpacity: 0.7, shadowOpacity: 0.4, specular: 0.9 }, strokes: [gilt(1.5)], dropShadow: { color: '#000000', opacity: 0.45, blur: 1, offset: [0, 1.5] } }, [w / 2 - 10, -7, 20, 16]));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A gold star with a ruby at its heart.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'star', points: 8, inner: 0.62, round: 1.5 }, { ...goldMetal(), bevel: { size: 3, style: 'chisel', highlightOpacity: 0.7, shadowOpacity: 0.5, specular: 0.8 } }),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#ff8aa0'], [1, darken(P.ruby, 0.3)]] }, bevel: { size: 3, style: 'chisel', specular: 1, highlightOpacity: 0.6 }, strokes: [{ width: 1, paint: '#3a0410', position: 'outside' }] }, [w * 0.28, h * 0.28, w * 0.44, h * 0.44]),
        ] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.38 }, { ...velvet(accent ?? P.crimson), strokes: [gilt(2.5)], extrude: { depth: 3, color: darken(accent ?? P.crimson, 0.6), stroke: { width: 1.5, color: '#2a1404' } }, dropShadow: { color: '#000000', opacity: 0.45, blur: 3, offset: [0, 5] } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, { ...velvet(P.velvet2), strokes: [gilt(2)], innerShadow: { color: '#000000', opacity: 0.6, size: 5, offset: [0, 2] } })] };
      case 'barFill': {
        const base = role === 'danger' ? P.ruby : role === 'premium' ? P.gold : role === 'secondary' ? P.sapphire : role === 'success' ? P.emerald : (accent ?? P.amethyst);
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, lighten(base, 0.45)], [0.5, base], [1, darken(base, 0.35)]] }, bevel: { size: 2.5, style: 'round', specular: 0.8, highlightOpacity: 0.5 }, gloss: { style: 'band', opacity: 0.35, height: 0.45, inset: 1.5, curve: 0 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, { ...velvet(P.velvet2), strokes: [gilt(2.5)], innerShadow: { color: '#000000', opacity: 0.4, size: 5, offset: [0, 2] }, dropShadow: { color: '#000000', opacity: 0.4, blur: 3, offset: [0, 4] } })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { ...goldMetal(), bevel: { size: Math.max(3, w * 0.07), style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.5, specular: 0.8 } }),
          one({ kind: 'ellipse' }, { ...velvet(vel), innerShadow: { color: '#000000', opacity: 0.6, size: 6, offset: [0, 2] } }, [w * 0.11, h * 0.11, w * 0.78, h * 0.78]),
          one({ kind: 'rivets', radius: Math.max(1.5, w * 0.035), inset: 0 }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#ff9ab0'], [1, P.ruby]] }, strokes: [{ width: 0.8, paint: '#3a0410', position: 'outside' }] }, [w * 0.15, h * 0.15, w * 0.7, h * 0.7]),
        ] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, gem(P.ruby, h)), one({ kind: 'cross', thickness: 0.2 }, { ...goldMetal(), fill: { angle: 90, stops: [[0, '#ffffff'], [1, P.ivory]] }, dropShadow: { color: '#3a0410', opacity: 0.6, blur: 0.5, offset: [0, 1.5] } }, [w * 0.26, h * 0.2, w * 0.48, h * 0.54])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: (r.text ?? 'ROYAL').toUpperCase(), font: 'RomanAntique', tracking: 0.06 }, {
          fill: { angle: 90, stops: [[0, '#fffbe6'], [0.38, P.gold], [0.62, '#d89a28'], [1, '#8a5408']] },
          bevel: { size: 2.5, style: 'chisel', highlightOpacity: 0.75, shadowOpacity: 0.5, specular: 0.8 },
          strokes: [{ width: 4, paint: P.ink, position: 'outside' }, { width: 1.8, paint: { angle: 90, stops: [[0, '#ffe8a0'], [1, '#8a5408']] }, position: 'outside' }],
          extrude: { depth: 5, color: { angle: 90, stops: [[0, '#5a2a6a'], [1, '#2a0a36']] }, stroke: { width: 4, color: P.ink } },
          sparkles: { count: 3, size: Math.max(5, h * 0.1), area: 'around', color: '#fff6c8' },
          outerGlow: { color: P.gold, opacity: 0.25, size: 12 },
          dropShadow: { color: '#000000', opacity: 0.55, blur: 4, offset: [0, 9] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 0, stops: [[0, P.gold, 0], [0.2, P.gold, 1], [0.8, P.gold, 1], [1, P.gold, 0]] }, bevel: { size: 1, style: 'round', highlightOpacity: 0.6 } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'bubble', radius: 12, tail: [0.16, 16, 12] }, { ...velvet(vel), strokes: [gilt(2.5)], dropShadow: { color: '#0a0010', opacity: 0.5, blur: 4, offset: [0, 6] } })] };
      case 'icon': {
        // A jewel-cut silhouette set in gold with a glint (gold itself for the legendary).
        const jewel: Record<string, Color> = { common: '#c8c8d8', rare: P.sapphire, epic: P.amethyst, legendary: P.gold, mythic: P.ruby };
        const base = isRarity(r.variant) ? jewel[r.variant]! : role === 'danger' ? P.ruby : (accent ?? P.gold);
        const g = r.glyph ?? 'crown';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3, solid: true }, { fill: { angle: 120, stops: [[0, lighten(base, 0.6)], [0.45, base], [1, darken(base, 0.45)]] }, bevel: { size: 2.2, style: 'chisel', highlightOpacity: 0.65, shadowOpacity: 0.5, specular: 0.9 }, strokes: [{ width: 2, paint: GOLD, position: 'outside' }, { width: 3.2, paint: '#2a1404', position: 'outside' }], sparkles: { count: 1, size: Math.max(4, h * 0.1), area: 'inside' }, dropShadow: { color: '#0a0010', opacity: 0.5, blur: 1.5, offset: [0, 3] } }),
          one({ kind: 'glyph', name: g, weight: 1.6 }, { fill: GOLD, fillOpacity: 0.9 }),
        ] };
      }
      case 'coin':
        // A gold coin with a cut gem at its heart.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { ...goldMetal(), bevel: { size: Math.max(1.5, w * 0.1), style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.5, specular: 0.8 }, strokes: [{ width: Math.max(1, w * 0.04), paint: '#2a1404', position: 'outside' }], extrude: { depth: Math.max(1.2, h * 0.07), color: '#5a3404', stroke: { width: Math.max(1, w * 0.04), color: '#2a1404' } } }),
          r.glyph && r.glyph !== 'gem'
            ? one({ kind: 'glyph', name: r.glyph, weight: 2.6, solid: true }, { fill: { angle: 90, stops: [[0, '#ffffff'], [1, '#ffd6e0']] }, strokes: [{ width: Math.max(0.6, w * 0.025), paint: '#5a3404', position: 'outside' }] }, [w * 0.27, h * 0.26, w * 0.46, h * 0.46])
            : one({ kind: 'gem' }, { fill: { angle: 90, stops: [[0, '#ff9ab8'], [0.5, P.ruby], [1, '#5a0418']] }, bevel: { size: Math.max(1.5, w * 0.08), style: 'chisel', highlightOpacity: 0.7, shadowOpacity: 0.4, specular: 1 }, strokes: [{ width: Math.max(0.6, w * 0.025), paint: '#3a0410', position: 'outside' }] }, [w * 0.25, h * 0.27, w * 0.5, h * 0.44]),
        ] };
    }
  },
};
