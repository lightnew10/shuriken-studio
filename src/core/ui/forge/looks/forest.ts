import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityOf, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle } from '../style';

/**
 * Forest: nature (gardening, farming, survival in the woods, camping, fairy forests): carved wood planks with real
 * grain and nails, moss growing over the top edges, leaves at the corners, tree-ring discs, berry and leaf-green
 * buttons, a cream sign-painted title.
 */

const P = { wood: '#9a6634', wood2: '#5e3818', bark: '#3a2210', pine: '#d9a86a', moss: '#5f9e2f', moss2: '#3f7a1e', leaf: '#7cc242', leaf2: '#3f8a26', cream: '#fff4d6', berry: '#d6402c', sun: '#ffc93a', sky: '#4aa8e0', ink: '#2e1a0a' };

/** Wood: grain along the plank, a relief, a rounded bevel, a dark outline. */
const plank = (base: Color, o: { angle?: number; scale?: number; outline?: number } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.1)], [1, darken(base, 0.15)]] },
  textures: [{ kind: 'wood', scale: o.scale ?? 6, angle: o.angle ?? 0, opacity: 0.7, ramp: [[0, darken(base, 0.45)], [0.55, base], [1, lighten(base, 0.18)]], relief: 0.35, seed: 3 }],
  bevel: { size: 3, style: 'round', highlightOpacity: 0.35, shadowOpacity: 0.45, specular: 0.15 },
  strokes: [{ width: o.outline ?? 2.5, paint: P.ink, position: 'outside' }],
  dropShadow: { color: '#1a0e04', opacity: 0.4, blur: 3, offset: [0, 5] },
});

/** Moss: a soft bumpy green growing along an edge. */
const moss = (): LayerStyle => ({
  fill: { angle: 90, stops: [[0, P.leaf], [1, P.moss2]] },
  textures: [{ kind: 'cells', scale: 4, opacity: 0.5, blend: 'overlay' }, { kind: 'noise', scale: 3, opacity: 0.35, blend: 'overlay' }],
  bevel: { size: 3, style: 'pillow', highlightOpacity: 0.4, shadowOpacity: 0.4 },
  strokes: [{ width: 2, paint: '#1e3a0c', position: 'outside' }],
  dropShadow: { color: '#000000', opacity: 0.25, blur: 1.5, offset: [0, 2] },
});

const leafStyle = (c: Color): LayerStyle => ({
  fill: { angle: 120, stops: [[0, lighten(c, 0.3)], [1, darken(c, 0.2)]] },
  patterns: [{ kind: 'stripes', color: darken(c, 0.35), opacity: 0.5, size: 7, angle: 35, duty: 0.12 }],
  bevel: { size: 2.5, style: 'pillow', highlightOpacity: 0.4, shadowOpacity: 0.35 },
  strokes: [{ width: 1.8, paint: '#1e3a0c', position: 'outside' }],
  dropShadow: { color: '#000000', opacity: 0.25, blur: 1.5, offset: [0, 2] },
});

/** A cluster of three leaves round a point (x, y), facing out to one side. */
const leaves = (x: number, y: number, size: number, flip: boolean): ForgeLayer[] => {
  const k = flip ? -1 : 1;
  return [
    one({ kind: 'leaf', angle: 200 * k }, leafStyle(P.leaf2), [x - size * 0.9 * k - size / 2, y - size * 0.55, size, size * 0.62]),
    one({ kind: 'leaf', angle: -150 * k }, leafStyle(P.leaf), [x - size * 0.6 * k - size / 2, y - size * 0.05, size * 0.95, size * 0.6]),
    one({ kind: 'leaf', angle: 90 + 70 * k }, leafStyle('#9ad44a'), [x - size * 0.2 * k - size * 0.35, y - size * 0.6, size * 0.7, size * 0.7]),
  ];
};

/** Glossy painted wood (buttons): colour over grain, a bevel, a darker base. */
const painted = (base: Color, h: number): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.22)], [0.5, base], [1, darken(base, 0.18)]] },
  textures: [{ kind: 'wood', scale: 5, opacity: 0.22, blend: 'multiply', ramp: [[0, '#6a4a2a'], [1, '#ffffff']], seed: 9 }],
  bevel: { size: Math.max(2.5, h * 0.1), style: 'round', highlightOpacity: 0.45, shadowOpacity: 0.4, specular: 0.4 },
  gloss: { style: 'band', opacity: 0.25, height: 0.45, inset: 3, curve: 0.1 },
  strokes: [{ width: 2.5, paint: P.ink, position: 'outside' }],
  extrude: { depth: Math.max(4, Math.min(7, h * 0.11)), color: darken(base, 0.5), stroke: { width: 2.5, color: P.ink } },
  dropShadow: { color: '#1a0e04', opacity: 0.35, blur: 3, offset: [0, Math.max(6, h * 0.13)] },
});

export const forest: Direction = {
  id: 'forest',
  label: 'Forest (wood, leaves and moss)',
  for: 'gardening, farming, woodland survival, camping and fairy-forest games: carved wood planks with real grain, moss along the edges, leaf clusters, tree-ring discs, leaf-green and berry buttons',
  palette: P,
  fonts: { display: 'FredokaOne', body: 'BuilderSans', weightBody: 800 },
  backdrop: '#6aa84a',
  text: {
    color: P.ink,
    strokePx: 2.5,
    onButton: '#ffffff',
    onButtonStroke: P.ink,
    title: { color: P.cream, stroke: P.ink, strokePx: 3, font: 'DenkOne', minSize: 22 },
    button: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    tabOn: { color: P.ink, font: 'BuilderSans', weight: 800 },
    tabOff: { color: P.cream, stroke: P.ink, strokePx: 2, font: 'BuilderSans', weight: 800 },
    onCard: { color: '#2a1606', font: 'BuilderSans', weight: 800 },
    onPill: { color: P.cream, stroke: P.ink, strokePx: 1.5, font: 'FredokaOne', minSize: 18 },
    muted: { color: '#5e4024', font: 'BuilderSans', weight: 700 },
    disabled: { color: '#f2ece2', stroke: '#3e352e', strokePx: 2, font: 'BuilderSans', weight: 800 },
    buttons: {
      primary: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      secondary: { color: P.cream, stroke: P.ink, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      danger: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      success: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      premium: { color: '#ffffff', stroke: P.ink, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: '#fff6b0', grey: '#8a8478', greyMix: 0.45 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const green = accent ?? '#5cb02e';
    switch (r.kind) {
      case 'button': {
        if (role === 'secondary') return s({ size: r.size, layers: [one({ kind: 'rect', radius: Math.min(10, h * 0.22) }, { ...plank(P.wood), extrude: { depth: Math.max(4, h * 0.1), color: darken(P.wood, 0.5), stroke: { width: 2.5, color: P.ink } } })] });
        const base = role === 'danger' ? P.berry : role === 'premium' ? '#f0a820' : role === 'success' ? green : green;
        const face = painted(base, h);
        if (role === 'premium') face.sparkles = { count: 2, size: Math.min(6, h * 0.13), area: 'inside' };
        return s({ size: r.size, layers: [one({ kind: 'rect', radius: Math.min(12, h * 0.26) }, face)] });
      }
      case 'window': {
        // A plank frame (boards run along each side), a light pine board inside, moss along the top, leaves at the
        // top corners and nails.
        const t = 20;
        const nail = (at: ForgeLayer['at']) => one({ kind: 'rivets', radius: 3.2, inset: 0 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#d8d0c8'], [1, '#5a504a']] }, strokes: [{ width: 1, paint: '#1a1008', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.6, blur: 0.8, offset: [0, 1.2] } }, at);
        return { size: r.size, content: [t + 10, t + 16, w - 2 * t - 20, h - 2 * t - 24], layers: [
          one({ kind: 'rect', radius: 16 }, { ...plank(P.wood2, { scale: 7 }), strokes: [{ width: 3, paint: P.ink, position: 'outside' }], dropShadow: { color: '#0e0802', opacity: 0.5, blur: 12, offset: [0, 14] } }),
          one({ kind: 'rect', radius: 4 }, plank(P.wood2, { angle: 90, scale: 7, outline: 1.5 }), [5, t + 4, t - 6, h - 2 * t - 8]),
          one({ kind: 'rect', radius: 4 }, plank(P.wood2, { angle: 90, scale: 7, outline: 1.5 }), [w - t + 1, t + 4, t - 6, h - 2 * t - 8]),
          one({ kind: 'rect', radius: 8 }, { fill: { angle: 90, stops: [[0, '#f6dcae'], [1, '#e2bc84']] }, textures: [{ kind: 'wood', scale: 9, opacity: 0.45, ramp: [[0, '#c89a5e'], [1, '#fbe6c0']], blend: 'normal', relief: 0.15 }], innerShadow: { color: '#4a2a0a', opacity: 0.45, size: 12, offset: [0, 5] }, strokes: [{ width: 2.5, paint: P.ink, position: 'outside' }] }, [t, t, w - 2 * t, h - 2 * t]),
          one({ kind: 'puffy', bump: 9 }, moss(), [12, -7, w - 24, 22]),
          ...leaves(26, 6, 46, false),
          ...leaves(w - 26, 6, 46, true),
          nail([10, h - 16, w - 20, 8]),
        ] };
      }
      case 'header':
        // A plank (its grain runs along it), with moss and leaves at both ends.
        return { size: r.size, layers: [
          one({ kind: 'rect', radius: 10 }, { ...plank(P.wood, { scale: 6 }), extrude: { depth: 5, color: darken(P.wood, 0.5), stroke: { width: 2.5, color: P.ink } } }),
          one({ kind: 'puffy', bump: Math.min(8, h * 0.12) }, moss(), [8, -h * 0.12, Math.min(w * 0.26, 110), Math.min(20, h * 0.3)]),
          one({ kind: 'puffy', bump: Math.min(8, h * 0.12) }, moss(), [w - 8 - Math.min(w * 0.26, 110), -h * 0.12, Math.min(w * 0.26, 110), Math.min(20, h * 0.3)]),
          ...leaves(h * 0.25, h * 0.2, Math.min(44, h * 0.6), false),
          ...leaves(w - h * 0.25, h * 0.2, Math.min(44, h * 0.6), true),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        const base = on ? P.pine : P.wood2;
        return withState({ size: r.size, layers: [one({ kind: 'rect', radius: [12, 12, 6, 6] }, { ...plank(base), extrude: { depth: on ? 5 : 4, color: darken(base, 0.5), stroke: { width: 2.5, color: P.ink } } }), ...(on ? [one({ kind: 'puffy', bump: 5 }, moss(), [w * 0.12, -5, w * 0.76, 12])] : [])] }, state === 'selected' ? 'normal' : state, look);
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityOf(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const layers: ForgeLayer[] = [one({ kind: 'rect', radius: 12 }, {
          ...plank(P.pine, { scale: 7 }),
          overlays: [{ paint: { type: 'radial', center: [0.5, 0.38], scale: 1.1, stops: [[0, lighten(top, 0.3), big ? 0.55 : 0.4], [1, top, 0]] }, blend: 'softlight' }],
          strokes: [{ width: 2.5, paint: P.ink, position: 'outside' }, { width: 3, paint: top, position: 'inside', opacity: 0.85 }],
          extrude: { depth: 4, color: darken(P.pine, 0.5), stroke: { width: 2.5, color: P.ink } },
          ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, color: '#fffbe0', area: 'inside' as const } } : {}),
        })];
        if (r.kind === 'card') layers.push(...leaves(w - 12, 10, 30, true), one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, lighten(top, 0.4)], [1, bot]] }, bevel: { size: 2, style: 'round', specular: 0.6, highlightOpacity: 0.5 }, strokes: [{ width: 1.5, paint: P.ink, position: 'outside' }] }, [w - 20, 6, 11, 11]));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A flower: rounded petals round a sunny centre.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'burst', points: 8, inner: 0.72, round: Math.min(w, h) * 0.16 }, { fill: { type: 'radial', stops: [[0, '#ff8a7a'], [1, P.berry]] }, bevel: { size: 3, style: 'pillow', highlightOpacity: 0.4 }, strokes: [{ width: 2, paint: P.ink, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.3, blur: 1.5, offset: [0, 3] } }),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#fff2a0'], [1, P.sun]] }, strokes: [{ width: 1.5, paint: '#8a5a10', position: 'outside', opacity: 0.6 }] }, [w * 0.32, h * 0.32, w * 0.36, h * 0.36]),
        ] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.35 }, { ...leafStyle(accent ?? P.moss), patterns: [], gloss: { style: 'band', opacity: 0.25, height: 0.45, inset: 2, curve: 0 }, extrude: { depth: 3, color: P.moss2, stroke: { width: 1.8, color: '#1e3a0c' } } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, { ...plank(P.bark, { scale: 4 }), innerShadow: { color: '#000000', opacity: 0.55, size: 5, offset: [0, 2] }, dropShadow: undefined })] };
      case 'barFill': {
        const base = role === 'danger' ? P.berry : role === 'premium' ? P.sun : role === 'secondary' ? P.sky : (accent ?? P.leaf);
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, lighten(base, 0.35)], [0.5, base], [1, darken(base, 0.2)]] }, gloss: { style: 'band', opacity: 0.35, height: 0.45, inset: 1.5, curve: 0 }, rim: { width: Math.max(2, h * 0.15), opacity: 0, shade: darken(base, 0.35), shadeOpacity: 0.4 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, { ...plank(P.wood2), innerShadow: { color: '#000000', opacity: 0.3, size: 4, offset: [0, 2] } })] };
      case 'iconFrame':
        // A tree-ring disc in its bark.
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: P.bark, textures: [{ kind: 'stone', scale: 3, opacity: 0.6, blend: 'overlay' }], strokes: [{ width: 2, paint: P.ink, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.35, blur: 2, offset: [0, 4] } }),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', stops: Array.from({ length: 13 }, (_, i) => [i / 12, i % 2 ? '#e8c088' : '#d2a066'] as [number, string]) }, textures: [{ kind: 'noise', scale: 6, opacity: 0.25, blend: 'overlay' }], bevel: { size: 3, style: 'round', highlightOpacity: 0.3, shadowOpacity: 0.3 }, innerShadow: { color: '#3a2008', opacity: 0.4, size: 5, offset: [0, 2] } }, [w * 0.09, h * 0.09, w * 0.82, h * 0.82]),
        ] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, painted(P.berry, h)), one({ kind: 'cross', thickness: 0.24 }, { fill: P.cream, strokes: [{ width: 2, paint: P.ink, position: 'outside' }] }, [w * 0.24, h * 0.18, w * 0.52, h * 0.56])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'GARDEN', font: 'DenkOne' }, {
          fill: { angle: 90, stops: [[0, '#fffbe8'], [0.6, P.cream], [1, '#f0d088']] },
          bevel: { size: 2, style: 'round', highlightOpacity: 0.5, shadowOpacity: 0.3 },
          strokes: [{ width: 7, paint: P.ink, position: 'outside' }, { width: 4.5, paint: { angle: 90, stops: [[0, '#8fd04a'], [1, '#3f8a26']] }, position: 'outside' }],
          extrude: { depth: 6, color: { angle: 90, stops: [[0, '#2f6a1a'], [1, '#1a3a0a']] }, stroke: { width: 7, color: P.ink } },
          dropShadow: { color: '#0e0802', opacity: 0.35, blur: 3, offset: [0, 10] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, P.leaf], [1, P.leaf2]] }, strokes: [{ width: 1, paint: '#1e3a0c', position: 'outside', opacity: 0.6 }] })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'bubble', radius: 12, tail: [0.16, 16, 12] }, { fill: { angle: 90, stops: [[0, '#fffaea'], [1, '#f2e2bc']] }, textures: [{ kind: 'paper', scale: 6, opacity: 0.25, blend: 'multiply', ramp: [[0, '#c8a878'], [1, '#ffffff']] }], strokes: [{ width: 2.5, paint: P.ink, position: 'outside' }], dropShadow: { color: '#0e0802', opacity: 0.35, blur: 4, offset: [0, 5] } })] };
      case 'icon': {
        const [top, bot] = isRarity(r.variant) ? rarityOf(r.variant) : role === 'danger' ? [lighten(P.berry, 0.3), P.berry] : [P.leaf, P.leaf2];
        const natural: Record<string, [Color, Color]> = { common: ['#d8c8a8', '#9a8460'], rare: [P.leaf, P.leaf2], epic: ['#ff8a7a', P.berry], legendary: ['#fff08a', '#f0a820'], mythic: ['#c8a0ff', '#8a40d0'] };
        const [a, b] = isRarity(r.variant) ? natural[r.variant]! : [top, bot];
        const g = r.glyph ?? 'leaf';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3.2, solid: true }, { fill: { angle: 90, stops: [[0, lighten(a, 0.4)], [0.55, a], [1, b]] }, bevel: { size: 2, style: 'pillow', highlightOpacity: 0.45, shadowOpacity: 0.35, specular: 0.3 }, strokes: [{ width: 2.4, paint: P.ink, position: 'outside' }], extrude: { depth: 2.5, color: darken(b, 0.5), stroke: { width: 2.4, color: P.ink } }, dropShadow: { color: '#0e0802', opacity: 0.3, blur: 1.5, offset: [0, 4] } }),
          one({ kind: 'glyph', name: g, weight: 1.9 }, { fill: darken(b, 0.45), fillOpacity: 0.7 }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#fff2a0'], [0.55, P.sun], [1, '#c87a10']] }, bevel: { size: Math.max(1.5, w * 0.09), style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.35, specular: 0.5 }, strokes: [{ width: Math.max(1.2, w * 0.05), paint: P.ink, position: 'outside' }], extrude: { depth: Math.max(1.2, h * 0.07), color: '#7a4a08', stroke: { width: Math.max(1.2, w * 0.05), color: P.ink } } }),
          one({ kind: 'glyph', name: r.glyph ?? 'sprout', weight: 2.8, solid: true }, { fill: { angle: 90, stops: [[0, '#9ad44a'], [1, '#3f8a26']] }, strokes: [{ width: Math.max(0.7, w * 0.03), paint: '#1e3a0c', position: 'outside' }], bevel: { size: Math.max(0.6, w * 0.03), style: 'pillow', highlightOpacity: 0.5 } }, [w * 0.25, h * 0.22, w * 0.5, h * 0.52]),
        ] };
    }
  },
};
