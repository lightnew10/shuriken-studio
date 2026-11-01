import type { ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityVivid, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle, StrokeStyle } from '../style';

/**
 * Ember: forged metal and fire for combat (arenas, fighting, swords, battle royale): dark brushed and scratched steel
 * with worn bright edges, chiselled bevels, cut corners, molten orange plates that glow, rivets and hot brackets.
 */

const P = { metal: '#1c1714', metal2: '#2e2622', steel: '#8a817a', edge: '#ff7a1a', hot: '#ffcf5a', blood: '#e2322b', gold: '#ffb52e', toxic: '#8ad13a', ash: '#120d0b', accent: '#ff5a14' };
const BLACK = '#0d0604';

/** Dark brushed steel: grain along it, scratches, bare worn edges, a chiselled bevel. */
const steel = (o: { edge?: Color | null; glow?: number; tone?: number } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(P.metal2, 0.08 + (o.tone ?? 0))], [0.55, P.metal2], [1, P.metal]] },
  textures: [
    { kind: 'brushed', scale: 5, opacity: 0.32, blend: 'overlay' },
    { kind: 'scratches', scale: 5, density: 0.4, color: '#c9beb4', opacity: 0.22, angle: -8 },
  ],
  wear: { amount: 0.4, color: '#6f655e', width: 4, scale: 2.5, opacity: 0.8 },
  bevel: { size: 2.5, style: 'chisel', highlightOpacity: 0.38, shadowOpacity: 0.6, angle: 110 },
  ...(o.glow ? { innerGlow: { color: (o.edge ?? P.edge) as Color, opacity: o.glow, size: 14 } } : {}),
  strokes: [
    o.edge === null ? { width: 1.5, paint: '#4a403a', position: 'inside' } : { width: 2, paint: { angle: 0, stops: [[0, darken(o.edge ?? P.edge, 0.25)], [0.5, P.hot], [1, darken(o.edge ?? P.edge, 0.25)]] }, position: 'inside' },
    { width: 2.5, paint: BLACK, position: 'outside' },
  ] as StrokeStyle[],
  dropShadow: { color: '#000000', opacity: 0.6, blur: 5, offset: [0, 5] },
});

/** Hot metal: an orange (or any) plate, brushed, chiselled, glowing, on a dark base. */
const molten = (base: Color, h: number, glow = 0.45): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.45)], [0.32, lighten(base, 0.05)], [0.7, base], [1, darken(base, 0.42)]] },
  textures: [{ kind: 'brushed', scale: 5, opacity: 0.28, blend: 'overlay' }, { kind: 'scratches', scale: 4, density: 0.25, color: '#fff2d0', opacity: 0.18 }],
  bevel: { size: 2.5, style: 'chisel', highlightOpacity: 0.55, shadowOpacity: 0.5, angle: 110, specular: 0.35 },
  sheen: { opacity: 0.22, angle: 62, width: 0.1, at: 0.28 },
  strokes: [{ width: 1.5, paint: lighten(base, 0.6), position: 'inside', opacity: 0.75 }, { width: 2.5, paint: BLACK, position: 'outside' }],
  extrude: { depth: Math.max(3, h * 0.07), color: darken(base, 0.72), stroke: { width: 2.5, color: BLACK } },
  outerGlow: { color: base, opacity: glow, size: 10 },
  dropShadow: { color: '#000000', opacity: 0.55, blur: 4, offset: [0, Math.max(5, h * 0.12)] },
});

export const ember: Direction = {
  id: 'ember',
  label: 'Ember (forged metal and fire)',
  for: 'combat, arenas, fighting, swords, battle royale: dark brushed and scratched steel with worn edges, chiselled cut corners, molten glowing plates, rivets and hot brackets',
  palette: P,
  fonts: { display: 'Sarpanch', body: 'GothamSSm', weightDisplay: 700, weightBody: 800 },
  backdrop: '#141010',
  text: {
    color: '#f2e2d2',
    stroke: BLACK,
    strokePx: 1,
    onButton: '#fff8ee',
    onButtonStroke: '#1a0602',
    title: { color: '#ffe2b0', stroke: '#2a0a02', strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 24 },
    button: { color: '#fff8ee', stroke: '#1a0602', strokePx: 2.5, font: 'Sarpanch', weight: 700, minSize: 20 },
    tabOn: { color: '#ffecd0', stroke: '#2a0a02', strokePx: 1.5, font: 'GothamSSm', weight: 800 },
    tabOff: { color: '#bcaea0', font: 'GothamSSm', weight: 700 },
    onCard: { color: '#f6ece2', stroke: BLACK, strokePx: 1.5, font: 'GothamSSm', weight: 800 },
    onPill: { color: '#ffecd0', stroke: BLACK, strokePx: 1, font: 'GothamSSm', weight: 800 },
    muted: { color: '#a89a8e', font: 'GothamSSm', weight: 600 },
    disabled: { color: '#b0a8a2', stroke: BLACK, strokePx: 1.5, font: 'GothamSSm', weight: 700 },
    buttons: {
      primary: { color: '#fff8ee', stroke: '#1a0602', strokePx: 2.5, font: 'Sarpanch', weight: 700, minSize: 20 },
      secondary: { color: '#f2e2d2', stroke: BLACK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 20 },
      danger: { color: '#fff8ee', stroke: '#1a0602', strokePx: 2.5, font: 'Sarpanch', weight: 700, minSize: 20 },
      success: { color: '#fff8ee', stroke: '#0a1a02', strokePx: 2.5, font: 'Sarpanch', weight: 700, minSize: 20 },
      premium: { color: '#fff8ee', stroke: '#1a0e02', strokePx: 2.5, font: 'Sarpanch', weight: 700, minSize: 20 },
    },
  },
  element(r, accent) {
    const edge = accent ?? P.edge;
    const [w, h] = r.size;
    const cut = Math.min(h * 0.3, 14);
    const { role, state } = roleOf(r);
    const s = (spec: ForgeSpec) => withState(spec, state, { press: 3, ring: P.hot, grey: '#241e1a', greyMix: 0.72 });
    switch (r.kind) {
      case 'button': {
        if (role === 'secondary') return s({ size: r.size, layers: [one({ kind: 'cut', cut: [cut, 0, cut, 0] }, { ...steel({ edge: '#8a817a', tone: 0.06 }), extrude: { depth: Math.max(3, h * 0.07), color: '#080504', stroke: { width: 2.5, color: BLACK } } })] });
        const base = role === 'danger' ? P.blood : role === 'premium' ? P.gold : role === 'success' ? P.toxic : edge;
        const face = molten(base, h, state === 'hover' ? 0.7 : 0.45);
        if (role === 'premium') face.sparkles = { count: 2, size: Math.min(6, h * 0.13), area: 'inside', color: '#fff4c8' };
        return s({ size: r.size, layers: [one({ kind: 'cut', cut: [cut, 0, cut, 0] }, face)] });
      }
      case 'window': {
        // A forged frame: a worn steel rim, a recessed inner plate, rivets, a molten line along the top and hot brackets.
        const t = 14;
        return { size: r.size, content: [t + 8, t + 8, w - 2 * t - 16, h - 2 * t - 16], layers: [
          one({ kind: 'cut', cut: [28, 0, 28, 0] }, { ...steel({ glow: 0.1 }), bevel: { size: 4, style: 'chisel', highlightOpacity: 0.45, shadowOpacity: 0.65, angle: 110 }, dropShadow: { color: '#000000', opacity: 0.7, blur: 16, offset: [0, 14] }, outerGlow: { color: edge, opacity: 0.18, size: 14 } }),
          one({ kind: 'cut', cut: [18, 0, 18, 0] }, {
            fill: { angle: 90, stops: [[0, '#0f0b09'], [1, '#1a1411']] },
            textures: [{ kind: 'brushed', scale: 6, opacity: 0.25, blend: 'overlay' }, { kind: 'scratches', scale: 6, density: 0.18, color: '#ffffff', opacity: 0.06 }],
            innerShadow: { color: '#000000', opacity: 0.9, size: 16, offset: [0, 5] },
            innerGlow: { color: edge, opacity: 0.1, size: 40 },
            strokes: [{ width: 1.5, paint: '#000000', position: 'outside', opacity: 0.9 }, { width: 1, paint: '#3a2e28', position: 'inside', opacity: 0.8 }],
          }, [t, t, w - 2 * t, h - 2 * t]),
          one({ kind: 'rect', radius: 1.5 }, { fill: { angle: 0, stops: [[0, edge, 0], [0.2, edge, 1], [0.5, P.hot, 1], [0.8, edge, 1], [1, edge, 0]] }, outerGlow: { color: edge, opacity: 0.85, size: 8 } }, [w * 0.14, 3.5, w * 0.72, 3]),
          one({ kind: 'rivets', radius: 3.6, inset: 0, spacing: 150 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#efe8e2'], [0.5, '#8d847d'], [1, '#3a332e']] }, strokes: [{ width: 1, paint: '#000000', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.8, blur: 1, offset: [0, 1.5] } }, [30, 7, w - 60, h - 14]),
          one({ kind: 'brackets', length: 28, thickness: 3.5, inset: 22 }, { fill: { angle: 90, stops: [[0, P.hot], [1, edge]] }, outerGlow: { color: edge, opacity: 0.65, size: 7 }, strokes: [{ width: 1, paint: '#2a0a02', position: 'outside', opacity: 0.6 }] }),
          // Sparks drifting off the hot rim.
          one({ kind: 'rect', radius: 4 }, { fill: '#000000', fillOpacity: 0, sparkles: { count: 7, size: 5, area: 'around', color: P.hot, glow: 0.6, seed: 4 } }, [w * 0.1, 0, w * 0.8, 10]),
        ] };
      }
      case 'header':
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [cut * 1.6, cut * 1.6, cut * 1.6, cut * 1.6], slant: [0, 0] }, { ...steel({ glow: 0.32, edge }), fill: { angle: 90, stops: [[0, '#4a2010'], [0.5, '#2a1a14'], [1, '#160f0c']] } }),
          one({ kind: 'rect', radius: 1 }, { fill: { angle: 90, stops: [[0, P.hot], [1, edge]] }, outerGlow: { color: edge, opacity: 0.7, size: 6 } }, [cut * 1.6 + 4, h - 6, w - cut * 3.2 - 8, 2.5]),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        const shape = { kind: 'cut' as const, cut: [0, cut * 0.8, 0, cut * 0.8] as [number, number, number, number], slant: [Math.min(10, h * 0.25), -Math.min(10, h * 0.25)] as [number, number] };
        if (on) return { size: r.size, layers: [one(shape, { ...steel({ glow: 0.5, edge }), fill: { angle: 90, stops: [[0, '#6a2a10'], [0.6, '#3a160a'], [1, '#22100a']] }, outerGlow: { color: edge, opacity: 0.35, size: 8 } })] };
        return withState({ size: r.size, layers: [one(shape, steel({ edge: null }))] }, state, { press: 2 });
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityVivid(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const c = r.kind === 'slot' ? Math.min(12, w * 0.16) : 14;
        const face: LayerStyle = {
          ...steel({ edge: top, glow: 0 }),
          fill: { angle: 90, stops: [[0, '#2c2420'], [0.6, '#1a1512'], [1, darken(bot, 0.6)]] },
          // Molten cracks glowing through the steel.
          textures: [{ kind: 'brushed', scale: 5, opacity: 0.32, blend: 'overlay' }, { kind: 'scratches', scale: 5, density: 0.4, color: '#c9beb4', opacity: 0.2, angle: -8 }, { kind: 'scratches', scale: 10, density: 0.22, color: big ? top : P.edge, opacity: 0.95, blend: 'screen', angle: -40, seed: 17 }],
          overlays: [{ paint: { type: 'radial', center: [0.5, 0.42], scale: 1.1, stops: [[0, top, big ? 0.32 : 0.18], [1, top, 0]] }, blend: 'screen' }],
          innerGlow: { color: top, opacity: big ? 0.45 : 0.3, size: 12 },
          strokes: [{ width: 2, paint: { angle: 90, stops: [[0, lighten(top, 0.4)], [1, bot]] }, position: 'inside' }, { width: 2.5, paint: BLACK, position: 'outside' }],
          ...(big ? { outerGlow: { color: bot, opacity: 0.35, size: 8 }, sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, color: lighten(top, 0.6), area: 'inside' as const } } : {}),
        };
        const layers = [one({ kind: 'cut', cut: [c, 0, c, 0] }, face)];
        if (r.kind === 'slot') layers.push(one({ kind: 'brackets', length: Math.min(w, h) * 0.2, thickness: 2, inset: 5 }, { fill: top, fillOpacity: 0.8 }));
        return withState({ size: r.size, layers }, state, { press: 2, ring: P.hot, grey: '#241e1a', greyMix: 0.72 });
      }
      case 'badge':
        return { size: r.size, slice: false, layers: [one({ kind: 'hex' }, { ...molten(P.blood, h, 0.55), extrude: { depth: 2, color: '#3a0606', stroke: { width: 2, color: BLACK } } })] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [h / 2, h / 2, h / 2, h / 2] }, { ...molten(edge, h, 0.4), sheen: undefined, extrude: { depth: 3, color: '#2a0c04', stroke: { width: 2.5, color: BLACK } } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [0, h * 0.5, 0, h * 0.5] }, { fill: '#0b0807', textures: [{ kind: 'brushed', scale: 4, opacity: 0.2, blend: 'overlay' }], innerShadow: { color: '#000000', opacity: 0.85, size: 5, offset: [0, 2] }, strokes: [{ width: 1.5, paint: '#4a3a32', position: 'inside' }, { width: 2.5, paint: BLACK, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.5, blur: 2, offset: [0, 2] } })] };
      case 'barFill': {
        const base = role === 'danger' ? P.blood : role === 'premium' ? P.gold : role === 'secondary' ? '#4ab0ff' : (accent ?? P.edge);
        return { size: r.size, layers: [one({ kind: 'cut', cut: [0, h * 0.5, 0, h * 0.5] }, {
          fill: { angle: 90, stops: [[0, lighten(base, 0.4)], [0.45, base], [1, darken(base, 0.4)]] },
          patterns: [{ kind: 'scanlines', color: '#000000', opacity: 0.2, size: 4, duty: 0.3 }],
          gloss: { style: 'band', opacity: 0.3, height: 0.42, inset: 1, curve: 0 },
          outerGlow: { color: base, opacity: 0.35, size: 5 },
        })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [h * 0.35, 0, h * 0.35, 0] }, { ...steel({ edge: '#6a5a50' }), innerShadow: { color: '#000000', opacity: 0.5, size: 6, offset: [0, 2] } })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'hex', point: w * 0.26 }, { ...steel({ glow: 0.35, edge }), fill: { type: 'radial', center: [0.5, 0.4], stops: [[0, '#3a2a22'], [1, '#140e0b']] } })] }, state, { press: 2, ring: P.hot, grey: '#241e1a', greyMix: 0.72 });
      case 'close':
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'cut', cut: Math.min(w, h) * 0.24 }, { ...steel({ edge: '#6a5a50' }), extrude: { depth: 3, color: '#080504', stroke: { width: 2, color: BLACK } } }),
          one({ kind: 'cross', thickness: 0.22 }, { fill: { angle: 90, stops: [[0, P.hot], [1, edge]] }, bevel: { size: 1.2, style: 'chisel', highlightOpacity: 0.5 }, strokes: [{ width: 1.2, paint: '#2a0a02', position: 'outside' }], outerGlow: { color: edge, opacity: 0.7, size: 5 } }, [w * 0.22, h * 0.16, w * 0.56, h * 0.6]),
        ] }, state, { press: 3 });
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: (r.text ?? 'ARENA').toUpperCase(), font: 'Sarpanch', weight: 700, tracking: 0.04 }, {
          fill: { angle: 90, stops: [[0, '#fffbe8'], [0.42, P.hot], [0.62, edge], [1, '#b8320a']] },
          textures: [{ kind: 'scratches', scale: 3, density: 0.35, color: '#5a1a04', opacity: 0.35 }],
          bevel: { size: 2, style: 'chisel', highlightOpacity: 0.65, shadowOpacity: 0.45, angle: 110 },
          strokes: [{ width: 1.2, paint: '#ffe8b0', position: 'inside', opacity: 0.4 }, { width: 3, paint: '#1a0602', position: 'outside' }],
          extrude: { depth: 5, color: { angle: 90, stops: [[0, '#4a1406'], [1, '#1a0602']] }, stroke: { width: 3, color: '#0a0302' } },
          outerGlow: { color: edge, opacity: 0.55, size: 14 },
          dropShadow: { color: '#000000', opacity: 0.6, blur: 3, offset: [0, 8] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'rect' }, { fill: { angle: 0, stops: [[0, edge, 0], [0.5, P.hot, 1], [1, edge, 0]] }, outerGlow: { color: edge, opacity: 0.55, size: 4 } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [12, 0, 12, 0] }, { ...steel({ glow: 0.18, edge }), fill: { angle: 90, stops: [[0, '#2a221e', 0.96], [1, '#151110', 0.96]] } })] };
      case 'icon': {
        // Forged steel: the silhouette polished and chiselled, its lines etched dark, glowing in the rarity or role.
        const glow = role === 'danger' ? P.blood : isRarity(r.variant) ? rarityVivid(r.variant)[1] : (accent ?? edge);
        const g = r.glyph ?? 'sword';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3, solid: true }, {
            fill: { angle: 90, stops: [[0, '#ffffff'], [0.45, '#cfc8c2'], [1, '#6b625c']] },
            textures: [{ kind: 'brushed', scale: 3, opacity: 0.3, blend: 'overlay' }],
            bevel: { size: 1.8, style: 'chisel', highlightOpacity: 0.7, shadowOpacity: 0.55, angle: 110 },
            strokes: [{ width: 1.6, paint: '#0a0503', position: 'outside' }],
            outerGlow: { color: glow, opacity: 0.85, size: 8 },
            dropShadow: { color: '#000000', opacity: 0.6, blur: 2, offset: [0, 3] },
          }),
          one({ kind: 'glyph', name: g, weight: 1.6 }, { fill: { angle: 90, stops: [[0, lighten(glow, 0.3)], [1, glow]] }, fillOpacity: 0.85 }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'hex', point: w * 0.25 }, { ...molten(edge, h, 0.5), extrude: { depth: Math.max(1.5, h * 0.08), color: '#3a1004', stroke: { width: Math.max(1.2, w * 0.05), color: BLACK } }, strokes: [{ width: Math.max(1, w * 0.04), paint: '#ffe0a0', position: 'inside', opacity: 0.6 }, { width: Math.max(1.2, w * 0.05), paint: BLACK, position: 'outside' }], dropShadow: undefined }),
          one({ kind: 'glyph', name: r.glyph ?? 'flame', weight: 2.6, solid: true }, { fill: '#3a0f04', bevel: { size: Math.max(0.6, w * 0.03), style: 'chisel', highlightOpacity: 0.35, shadowOpacity: 0.3 }, rim: { width: Math.max(0.8, w * 0.04), color: '#ffd080', opacity: 0.5, angle: 270 } }, [w * 0.26, h * 0.22, w * 0.48, h * 0.54]),
        ] };
    }
  },
};
