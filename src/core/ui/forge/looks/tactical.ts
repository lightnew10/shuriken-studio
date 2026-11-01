import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityVivid, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle } from '../style';

/**
 * Tactical: military (shooters, war, airsoft, army tycoons, extraction games): olive-drab painted steel worn to bare
 * metal at the edges, gunmetal recesses, chamfered corners, screws, hazard stripes, camo, corner brackets, stencil
 * type in Oswald with spray-cut gaps.
 */

const P = { olive: '#4b5320', olive2: '#363c17', khaki: '#c2b280', sand: '#d8c89a', gun: '#2a2d2a', gun2: '#1a1c1a', black: '#121310', hazard: '#f2b400', orange: '#ff6a00', red: '#c8321e', green: '#5a8a2a', hud: '#9cff5a', steel: '#8a8e86' };

/** Olive painted steel: grain, scratches, bare worn edges, a chamfer bevel. */
const painted = (base: Color, o: { wear?: number } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.1)], [1, darken(base, 0.18)]] },
  textures: [{ kind: 'noise', scale: 3, opacity: 0.25, blend: 'overlay' }, { kind: 'scratches', scale: 4, density: 0.35, color: '#d8d4c8', opacity: 0.22, angle: 15 }, { kind: 'clouds', scale: 40, opacity: 0.25, blend: 'multiply', ramp: [[0, '#2a2a20'], [1, '#ffffff']] }],
  wear: { amount: o.wear ?? 0.4, color: P.steel, width: 3.5, scale: 2 },
  bevel: { size: 2.5, style: 'chisel', highlightOpacity: 0.35, shadowOpacity: 0.55 },
  strokes: [{ width: 2, paint: P.black, position: 'outside' }],
  dropShadow: { color: '#000000', opacity: 0.55, blur: 3, offset: [0, 4] },
});

const gunmetal = (): LayerStyle => ({
  fill: { angle: 90, stops: [[0, '#343834'], [1, P.gun2]] },
  textures: [{ kind: 'carbon', scale: 2.5, opacity: 0.18, blend: 'overlay' }, { kind: 'scratches', scale: 5, density: 0.25, color: '#ffffff', opacity: 0.07 }],
  innerShadow: { color: '#000000', opacity: 0.8, size: 10, offset: [0, 3] },
  strokes: [{ width: 1.5, paint: '#000000', position: 'outside' }, { width: 1, paint: '#4a4e48', position: 'inside', opacity: 0.6 }],
});

const hazard = (): LayerStyle => ({
  fill: P.hazard,
  patterns: [{ kind: 'stripes', color: P.black, opacity: 1, size: 12, angle: -45, duty: 0.5 }],
  textures: [{ kind: 'scratches', scale: 3, density: 0.4, color: '#000000', opacity: 0.3 }],
  wear: { amount: 0.4, color: P.steel, width: 2.5, scale: 1.5 },
  strokes: [{ width: 1.5, paint: P.black, position: 'outside' }],
});

const screws = (at: ForgeLayer['at'], r = 3): ForgeLayer => one({ kind: 'rivets', radius: r, inset: 0 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#c8ccc4'], [1, '#4a4e48']] }, patterns: [{ kind: 'stripes', color: '#1a1c1a', opacity: 0.9, size: r * 2, angle: 45, duty: 0.22, offset: [r * 0.5, 0] }], strokes: [{ width: 1, paint: '#000000', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.6, blur: 0.8, offset: [0, 1] } }, at);

export const tactical: Direction = {
  id: 'tactical',
  label: 'Tactical (military olive and hazard)',
  for: 'shooters, war, airsoft, army tycoons and extraction games: olive-drab painted steel worn to bare metal, gunmetal recesses, chamfered corners, screws, hazard stripes, camo, corner brackets, stencil Oswald',
  palette: P,
  fonts: { display: 'Oswald', body: 'TitilliumWeb', weightDisplay: 700, weightBody: 700 },
  backdrop: '#3a3a30',
  text: {
    color: P.sand,
    stroke: P.black,
    strokePx: 1,
    onButton: P.black,
    title: { color: P.sand, stroke: P.black, strokePx: 2, font: 'Oswald', weight: 700, minSize: 22 },
    button: { color: P.black, font: 'Oswald', weight: 700, minSize: 18 },
    tabOn: { color: P.black, font: 'TitilliumWeb', weight: 700 },
    tabOff: { color: '#d2c492', font: 'TitilliumWeb', weight: 700 },
    onCard: { color: '#ece2c0', stroke: P.black, strokePx: 1.5, font: 'TitilliumWeb', weight: 700 },
    onPill: { color: '#ece2c0', font: 'TitilliumWeb', weight: 700 },
    muted: { color: '#a8a48c', font: 'TitilliumWeb', weight: 600 },
    disabled: { color: '#9a9c94', font: 'TitilliumWeb', weight: 700 },
    buttons: {
      primary: { color: P.black, font: 'Oswald', weight: 700, minSize: 18 },
      secondary: { color: P.sand, font: 'Oswald', weight: 700, minSize: 18 },
      danger: { color: '#ffffff', stroke: P.black, strokePx: 2, font: 'Oswald', weight: 700, minSize: 18 },
      success: { color: '#ffffff', stroke: P.black, strokePx: 2, font: 'Oswald', weight: 700, minSize: 18 },
      premium: { color: P.black, font: 'Oswald', weight: 700, minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: P.hazard, grey: '#3a3c36', greyMix: 0.5 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const ch = Math.min(h * 0.28, 12);
    switch (r.kind) {
      case 'button': {
        if (role === 'secondary') return s({ size: r.size, layers: [one({ kind: 'cut', cut: [ch, 0, ch, 0] }, { ...painted(P.olive), extrude: { depth: 3, color: P.black } })] });
        const base = role === 'danger' ? P.red : role === 'success' ? P.green : role === 'premium' ? P.orange : (accent ?? P.hazard);
        const layers: ForgeLayer[] = [one({ kind: 'cut', cut: [ch, 0, ch, 0] }, { ...painted(base, { wear: 0.5 }), patterns: [{ kind: 'chevron', color: '#000000', opacity: 0.07, size: 14, angle: 90, duty: 0.3 }], extrude: { depth: 3, color: darken(base, 0.6), stroke: { width: 2, color: P.black } } })];
        // A strip of hazard stripes at the right end.
        layers.push(one({ kind: 'polygon', points: [[0.35, 0], [1, 0], [1, 1], [0, 1]] }, { fill: P.black, fillOpacity: 0.85, patterns: [{ kind: 'stripes', color: base, opacity: 0.9, size: 7, angle: -45, duty: 0.45 }] }, [w - Math.min(30, w * 0.18) - ch * 0.2, h * 0.18, Math.min(30, w * 0.18), h * 0.64]));
        return s({ size: r.size, layers });
      }
      case 'window': {
        // Olive plate, gunmetal recess, screws, hazard band, corner brackets and a stencilled serial.
        const t = 14;
        return { size: r.size, content: [t + 10, t + 10, w - 2 * t - 20, h - 2 * t - 20], layers: [
          one({ kind: 'cut', cut: [26, 0, 26, 0] }, { ...painted(accent ?? P.olive, { wear: 0.35 }), textures: [{ kind: 'camo', scale: 40, opacity: 0.25, ramp: [[0, '#2a3010'], [0.45, '#2a3010', 0], [0.46, P.olive2, 0], [1, P.olive2, 0]], blend: 'normal' }, { kind: 'scratches', scale: 5, density: 0.35, color: '#d8d4c8', opacity: 0.2 }], dropShadow: { color: '#000000', opacity: 0.6, blur: 14, offset: [0, 12] } }),
          one({ kind: 'cut', cut: [16, 0, 16, 0] }, gunmetal(), [t, t, w - 2 * t, h - 2 * t]),
          one({ kind: 'polygon', points: [[0.06, 0], [1, 0], [0.94, 1], [0, 1]] }, hazard(), [w * 0.62, 3, w * 0.3, 8]),
          one({ kind: 'brackets', length: 24, thickness: 3, inset: t + 8 }, { fill: P.hazard, fillOpacity: 0.9 }),
          screws([30, 6, w - 60, h - 12]),
          // Hazard tape across the top-right corner.
          one({ kind: 'polygon', points: [[0.55, 0], [0.8, 0], [1, 0.2], [1, 0.45]] }, { ...hazard(), patterns: [{ kind: 'stripes', color: P.black, opacity: 1, size: 14, angle: 45, duty: 0.5 }], dropShadow: { color: '#000000', opacity: 0.5, blur: 2, offset: [0, 3] } }, [w - 150, 0, 150, 150]),
        ] };
      }
      case 'header':
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [ch * 1.5, ch * 1.5, ch * 1.5, ch * 1.5] }, { ...gunmetal(), textures: [{ kind: 'brushed', scale: 5, opacity: 0.2, blend: 'overlay' }, { kind: 'scratches', scale: 5, density: 0.25, color: '#ffffff', opacity: 0.07, angle: 0 }], innerShadow: undefined, bevel: { size: 2, style: 'chisel', highlightOpacity: 0.3, shadowOpacity: 0.5 }, dropShadow: { color: '#000000', opacity: 0.5, blur: 4, offset: [0, 5] } }),
          one({ kind: 'polygon', points: [[0, 0], [1, 0], [0.75, 1], [0, 1]] }, hazard(), [ch * 1.6, h * 0.22, Math.min(80, w * 0.14), h * 0.56]),
          one({ kind: 'polygon', points: [[0.25, 0], [1, 0], [1, 1], [0, 1]] }, hazard(), [w - ch * 1.6 - Math.min(80, w * 0.14), h * 0.22, Math.min(80, w * 0.14), h * 0.56]),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        const shape = { kind: 'cut' as const, cut: [ch * 0.8, ch * 0.8, 0, 0] as [number, number, number, number] };
        if (on) return { size: r.size, layers: [one(shape, painted(P.sand, { wear: 0.3 })), one({ kind: 'rect' }, { fill: P.hazard }, [6, h - 5, w - 12, 3])] };
        return withState({ size: r.size, layers: [one(shape, painted(P.olive2))] }, state, look);
      }
      case 'card':
      case 'slot': {
        const [top] = rarityVivid(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const k = r.kind === 'slot' ? Math.min(10, w * 0.14) : 14;
        const layers: ForgeLayer[] = [
          one({ kind: 'cut', cut: [k, 0, k, 0] }, {
            ...gunmetal(),
            textures: [{ kind: 'camo', scale: 22, opacity: 0.55, ramp: [[0, '#3a4018'], [0.38, '#3a4018'], [0.4, '#2a2e1a'], [0.6, '#2a2e1a'], [0.62, '#4a4a30'], [1, '#4a4a30']], seed: r.kind === 'slot' ? 4 : 7 }, { kind: 'scratches', scale: 4, density: 0.3, color: '#ffffff', opacity: 0.08 }],
            overlays: [{ paint: { angle: 90, stops: [[0, '#000000', 0.1], [0.6, '#000000', 0.35], [1, top, 0.35]] }, blend: 'normal' }],
            strokes: [{ width: 1.5, paint: '#000000', position: 'outside' }, { width: 1.5, paint: top, position: 'inside', opacity: 0.75 }],
            innerShadow: { color: '#000000', opacity: 0.5, size: 8, offset: [0, 3] },
            dropShadow: { color: '#000000', opacity: 0.5, blur: 3, offset: [0, 4] },
            ...(big ? { outerGlow: { color: top, opacity: 0.3, size: 6 } } : {}),
          }),
          one({ kind: 'brackets', length: Math.min(w, h) * 0.16, thickness: 2, inset: 5 }, { fill: top }),
        ];
        if (r.kind === 'card') layers.push(one({ kind: 'polygon', points: [[0, 0], [1, 0], [0.8, 1], [0, 1]] }, { fill: top, patterns: [{ kind: 'stripes', color: '#000000', opacity: 0.45, size: 6, angle: -45, duty: 0.4 }] }, [k + 4, 5, w * 0.34, 5]));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A red octagon, white-rimmed (a count or NEW reads on it).
        return { size: r.size, slice: false, layers: [one({ kind: 'cut', cut: Math.min(w, h) * 0.29 }, { ...painted(P.red, { wear: 0.3 }), strokes: [{ width: 2, paint: P.black, position: 'outside' }, { width: Math.max(1.5, w * 0.05), paint: '#f2ead0', position: 'inside' }] })] };
      case 'ribbon':
        // A gunmetal plate with hazard stripes at both ends.
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [h * 0.3, h * 0.3, h * 0.3, h * 0.3] }, { ...painted(P.olive2), dropShadow: { color: '#000000', opacity: 0.5, blur: 2, offset: [0, 4] } }),
          one({ kind: 'polygon', points: [[0, 0], [1, 0], [0.7, 1], [0, 1]] }, hazard(), [h * 0.32, h * 0.2, Math.min(h * 1.1, w * 0.18), h * 0.6]),
          one({ kind: 'polygon', points: [[0.3, 0], [1, 0], [1, 1], [0, 1]] }, hazard(), [w - h * 0.32 - Math.min(h * 1.1, w * 0.18), h * 0.2, Math.min(h * 1.1, w * 0.18), h * 0.6]),
        ] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [0, h * 0.4, 0, h * 0.4] }, { fill: '#0e0f0d', innerShadow: { color: '#000000', opacity: 0.9, size: 4, offset: [0, 2] }, strokes: [{ width: 1.5, paint: '#3a3e36', position: 'inside' }, { width: 1.5, paint: '#000000', position: 'outside' }] })] };
      case 'barFill': {
        const base = role === 'danger' ? P.red : role === 'premium' ? P.hazard : role === 'secondary' ? '#4aa0d0' : (accent ?? P.hud);
        return { size: r.size, layers: [one({ kind: 'cut', cut: [0, h * 0.4, 0, h * 0.4] }, { fill: { angle: 90, stops: [[0, lighten(base, 0.2)], [1, darken(base, 0.25)]] }, patterns: [{ kind: 'scanlines', color: '#000000', opacity: 0.3, size: 3, duty: 0.35 }], outerGlow: { color: base, opacity: 0.25, size: 4 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [h * 0.3, 0, h * 0.3, 0] }, { ...gunmetal(), textures: [{ kind: 'brushed', scale: 4, opacity: 0.2, blend: 'overlay' }], innerShadow: { color: '#000000', opacity: 0.6, size: 5, offset: [0, 2] }, dropShadow: { color: '#000000', opacity: 0.45, blur: 2, offset: [0, 3] } })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'cut', cut: Math.min(w, h) * 0.28 }, { ...gunmetal(), bevel: { size: 2, style: 'chisel', highlightOpacity: 0.3, shadowOpacity: 0.5 } }), one({ kind: 'brackets', length: Math.min(w, h) * 0.2, thickness: 2, inset: 4 }, { fill: P.hazard })] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'cut', cut: Math.min(w, h) * 0.22 }, { ...painted(P.red, { wear: 0.4 }), extrude: { depth: 3, color: '#3a0a04', stroke: { width: 2, color: P.black } } }), one({ kind: 'cross', thickness: 0.2, radius: 0 }, { fill: '#ffffff', strokes: [{ width: 1.2, paint: P.black, position: 'outside' }] }, [w * 0.24, h * 0.18, w * 0.52, h * 0.56])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: (r.text ?? 'DEPLOY').toUpperCase(), font: 'Oswald', weight: 700, tracking: 0.05 }, {
          fill: { angle: 90, stops: [[0, '#f2ead0'], [1, P.khaki]] },
          textures: [{ kind: 'noise', scale: 2, opacity: 0.35, blend: 'multiply', ramp: [[0, '#6a6040'], [1, '#ffffff']] }, { kind: 'scratches', scale: 3, density: 0.4, color: '#4a4430', opacity: 0.4 }],
          roughen: { amount: 0.6, scale: 1.5, seed: 4 },
          cutouts: [{ kind: 'stripes', color: '#000000', size: h * 3, angle: 90, duty: Math.max(0.012, 1.6 / (h * 3)), offset: [0, h * 0.47] }],
          strokes: [{ width: 2.5, paint: P.black, position: 'outside' }],
          extrude: { depth: 4, color: P.olive2, stroke: { width: 2.5, color: P.black } },
          dropShadow: { color: '#000000', opacity: 0.6, blur: 3, offset: [0, 7] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'rect' }, { fill: P.khaki, fillOpacity: 0.7, dropShadow: { color: '#000000', opacity: 0.6, blur: 0, offset: [0, 1] } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'cut', cut: [10, 0, 10, 0] }, { ...gunmetal(), innerShadow: undefined, fill: { angle: 90, stops: [[0, '#2e322e', 0.96], [1, '#1a1c1a', 0.96]] }, dropShadow: { color: '#000000', opacity: 0.5, blur: 4, offset: [0, 5] } }), one({ kind: 'rect' }, { fill: P.hazard }, [0, 10, 4, Math.max(6, h - 20)])] };
      case 'icon': {
        // Stencilled kit: a sand silhouette, sprayed, its lines dark, a faint glow in the rarity.
        const glow = isRarity(r.variant) && r.variant !== 'common' ? rarityVivid(r.variant)[1] : role === 'danger' ? P.red : null;
        const g = r.glyph ?? 'crosshair';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3, solid: true }, {
            fill: { angle: 90, stops: [[0, '#f2ead0'], [1, P.khaki]] },
            textures: [{ kind: 'noise', scale: 2, opacity: 0.4, blend: 'multiply', ramp: [[0, '#5a5236'], [1, '#ffffff']] }],
            bevel: { size: 1.5, style: 'chisel', highlightOpacity: 0.35, shadowOpacity: 0.45 },
            strokes: [{ width: 1.6, paint: P.black, position: 'outside' }],
            ...(glow ? { outerGlow: { color: glow, opacity: 0.55, size: 7 } } : {}),
            dropShadow: { color: '#000000', opacity: 0.6, blur: 1.5, offset: [0, 2.5] },
          }),
          one({ kind: 'glyph', name: g, weight: 1.6 }, { fill: '#2a2818', fillOpacity: 0.8 }),
        ] };
      }
      case 'coin':
        // A brass medal with a star.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#f2d890'], [0.55, '#c8a048'], [1, '#6a5018']] }, bevel: { size: Math.max(1.5, w * 0.09), style: 'chisel', highlightOpacity: 0.55, shadowOpacity: 0.45, specular: 0.4 }, strokes: [{ width: Math.max(1, w * 0.04), paint: P.black, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.5, blur: 1, offset: [0, Math.max(1, h * 0.05)] } }),
          one(r.glyph && r.glyph !== 'medal' ? { kind: 'glyph', name: r.glyph, weight: 2.6, solid: true } : { kind: 'star', points: 5, inner: 0.42, round: 0.3 }, { fill: { angle: 90, stops: [[0, '#fff2c0'], [1, '#d8b058']] }, bevel: { size: Math.max(0.6, w * 0.04), style: 'chisel', highlightOpacity: 0.5, shadowOpacity: 0.5 }, strokes: [{ width: Math.max(0.6, w * 0.025), paint: '#4a3808', position: 'outside' }] }, [w * 0.24, h * 0.22, w * 0.52, h * 0.52]),
        ] };
    }
  },
};
