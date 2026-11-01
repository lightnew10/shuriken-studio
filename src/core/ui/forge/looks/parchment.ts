import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityOf, rarityVivid, roleOf, withState, type Direction } from '../kit';
import type { Color, Gradient, LayerStyle, StrokeStyle } from '../style';

/**
 * Parchment: fantasy, RPG, medieval and story games: aged, stained paper with burnt edges in dark wood frames with
 * gilded trims and corner studs, enamelled wax-red, royal-blue and leaf-green buttons set in gold, blackletter titles.
 */

const P = { paper: '#f1dfb2', paper2: '#d6b77a', ink: '#3b2312', gold: '#e8b54a', gold2: '#8a5a12', goldHi: '#fff1b8', wax: '#a8231c', royal: '#2c4a9f', leaf: '#3f8a3a', wood: '#4a2c18', wood2: '#2a170c' };

const GOLD: Gradient = { angle: 90, stops: [[0, P.goldHi], [0.45, P.gold], [1, P.gold2]] };
const gold = (width = 3, position: StrokeStyle['position'] = 'outside'): StrokeStyle => ({ width, paint: { angle: 90, stops: [[0, P.goldHi], [0.45, P.gold], [1, P.gold2]] }, position });

/** Aged paper: fibres, tea stains, burnt edges, a soft bevel. */
const paper = (o: { stain?: number; burn?: number } = {}): LayerStyle => ({
  fill: { type: 'radial', center: [0.5, 0.42], scale: 1.35, stops: [[0, lighten(P.paper, 0.3)], [0.65, P.paper], [1, P.paper2]] },
  textures: [
    { kind: 'paper', scale: 7, opacity: 0.35, blend: 'multiply', ramp: [[0, '#c9a46a'], [1, '#ffffff']] },
    { kind: 'clouds', scale: 60, opacity: o.stain ?? 0.22, blend: 'multiply', ramp: [[0, '#b0844a'], [0.5, '#ffffff'], [1, '#ffffff']], seed: 8 },
  ],
  innerGlow: { color: '#6a3a10', opacity: o.burn ?? 0.45, size: 18, blend: 'multiply' },
  bevel: { size: 3, highlightOpacity: 0.3, shadowOpacity: 0.2 },
});

/** Dark polished wood: grain, a rounded bevel. */
const wood = (angle = 0): LayerStyle => ({
  fill: { angle: 90, stops: [[0, '#6a4024'], [1, P.wood2]] },
  textures: [{ kind: 'wood', scale: 7, angle, opacity: 0.75, ramp: [[0, '#2a150a'], [0.5, '#5a3418'], [1, '#7a4a26']], blend: 'normal', relief: 0.4 }],
  bevel: { size: 4, style: 'round', highlightOpacity: 0.35, shadowOpacity: 0.55, specular: 0.25 },
});

/** Enamel set in gold: a domed glossy colour with a specular, a gilded rim and a dark base. */
const enamel = (base: Color, h: number): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.3)], [0.5, base], [1, darken(base, 0.35)]] },
  textures: [{ kind: 'leather', scale: 4, opacity: 0.18, blend: 'overlay' }],
  bevel: { size: Math.max(3, h * 0.12), style: 'pillow', highlightOpacity: 0.55, shadowOpacity: 0.5, specular: 0.5 },
  gloss: { style: 'arc', opacity: 0.28, height: 0.45, inset: 4, curve: 0.5 },
  strokes: [gold(3), { width: 1.2, paint: darken(base, 0.55), position: 'inside', opacity: 0.8 }],
  extrude: { depth: Math.max(3, h * 0.08), color: { angle: 90, stops: [[0, P.gold2], [1, '#3a2408']] }, stroke: { width: 1.5, color: '#2a1606' } },
  dropShadow: { color: '#1a0c04', opacity: 0.5, blur: 3, offset: [0, Math.max(4, h * 0.1) + 2] },
});

/** A rolled paper edge: a cylinder of paper (light along its middle, shaded under). */
const roll = (): LayerStyle => ({
  fill: { angle: 90, stops: [[0, '#c9a462'], [0.3, '#fff2cc'], [0.55, '#f0d9a4'], [1, '#8a6430']] },
  textures: [{ kind: 'paper', scale: 5, opacity: 0.3, blend: 'multiply', ramp: [[0, '#b08850'], [1, '#ffffff']] }],
  strokes: [{ width: 1.5, paint: '#5a3a14', position: 'outside', opacity: 0.8 }],
  dropShadow: { color: '#1a0c04', opacity: 0.45, blur: 2.5, offset: [0, 3] },
});

/** A wax seal: a lumpy pressed disc in a colour with a glyph stamped in it. */
const seal = (x: number, y: number, s: number, wax: Color, glyph: string): ForgeLayer[] => [
  one({ kind: 'burst', points: 11, inner: 0.86, round: s * 0.08 }, { fill: { type: 'radial', center: [0.42, 0.38], stops: [[0, lighten(wax, 0.3)], [1, darken(wax, 0.4)]] }, roughen: { amount: Math.max(0.4, s * 0.02), scale: 2, seed: 3 }, bevel: { size: s * 0.12, style: 'pillow', highlightOpacity: 0.45, shadowOpacity: 0.4, specular: 0.5 }, dropShadow: { color: '#1a0804', opacity: 0.5, blur: 1.5, offset: [0, 2] } }, [x, y, s, s]),
  one({ kind: 'ring', thickness: Math.max(1, s * 0.05) }, { fill: darken(wax, 0.45), fillOpacity: 0.7 }, [x + s * 0.18, y + s * 0.18, s * 0.64, s * 0.64]),
  one({ kind: 'glyph', name: glyph, weight: 2.6, solid: true }, { fill: darken(wax, 0.35), bevel: { size: Math.max(0.6, s * 0.04), style: 'chisel', highlightOpacity: 0.35, shadowOpacity: 0.5, angle: 300 } }, [x + s * 0.3, y + s * 0.28, s * 0.4, s * 0.4]),
];

export const parchment: Direction = {
  id: 'parchment',
  label: 'Parchment (fantasy, gold and paper)',
  for: 'fantasy, RPG, medieval, story games, quests: stained burnt-edge paper in dark wood frames with gilded trims, enamel buttons set in gold, blackletter titles',
  palette: P,
  fonts: { display: 'GrenzeGotisch', body: 'Merriweather', weightDisplay: 700, weightBody: 700 },
  backdrop: '#2a1f18',
  text: {
    color: '#3b2312',
    strokePx: 1.5,
    onButton: '#fff3d6',
    onButtonStroke: '#2a1606',
    title: { color: '#fff1c4', stroke: '#2a1606', strokePx: 2, font: 'GrenzeGotisch', weight: 700, minSize: 24 },
    button: { color: '#fff3d6', stroke: '#0a2008', strokePx: 2, font: 'GrenzeGotisch', weight: 700, minSize: 26 },
    tabOn: { color: '#3b2312', font: 'Merriweather', weight: 700 },
    tabOff: { color: '#f6e2b4', stroke: '#1a0c04', strokePx: 1.5, font: 'Merriweather', weight: 700 },
    onCard: { color: '#33200f', font: 'Merriweather', weight: 700 },
    onPill: { color: '#fff1c4', stroke: '#1a0c04', strokePx: 1, font: 'Merriweather', weight: 700 },
    muted: { color: '#6e4e30', font: 'Merriweather', weight: 700 },
    disabled: { color: '#e6dccb', stroke: '#3a3028', strokePx: 1.5, font: 'Merriweather', weight: 700 },
    buttons: {
      primary: { color: '#fff3d6', stroke: '#0a2008', strokePx: 2, font: 'GrenzeGotisch', weight: 700, minSize: 26 },
      secondary: { color: '#fff3d6', stroke: '#0a1030', strokePx: 2, font: 'GrenzeGotisch', weight: 700, minSize: 26 },
      danger: { color: '#fff3d6', stroke: '#2a0606', strokePx: 2, font: 'GrenzeGotisch', weight: 700, minSize: 26 },
      success: { color: '#fff3d6', stroke: '#0a2008', strokePx: 2, font: 'GrenzeGotisch', weight: 700, minSize: 26 },
      premium: { color: '#2a1606', font: 'GrenzeGotisch', weight: 700, minSize: 26 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: P.goldHi, grey: '#7a6e60', greyMix: 0.4 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const studs = (inset: number, radius: number, at?: ForgeLayer['at']) => one({ kind: 'rivets', radius, inset }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, P.goldHi], [0.55, P.gold], [1, P.gold2]] }, bevel: { size: radius * 0.5, style: 'round', highlightOpacity: 0.6, specular: 0.5 }, strokes: [{ width: 1, paint: '#2a1606', position: 'outside', opacity: 0.8 }], dropShadow: { color: '#000000', opacity: 0.55, blur: 1.5, offset: [0, 2] } }, at);
    switch (r.kind) {
      case 'button': {
        const base = role === 'danger' ? P.wax : role === 'secondary' ? P.royal : role === 'success' ? P.leaf : role === 'premium' ? '#b8860b' : (accent ?? P.leaf);
        const face = enamel(base, h);
        if (role === 'premium') {
          face.fill = { angle: 90, stops: [[0, P.goldHi], [0.5, P.gold], [1, P.gold2]] };
          face.sparkles = { count: 2, size: Math.min(6, h * 0.13), area: 'inside' };
        }
        return s({ size: r.size, layers: [one({ kind: 'rect', radius: Math.min(10, h * 0.22) }, face)] });
      }
      case 'window': {
        // Paper in a dark wood frame: a gilded line round both, gold studs and corner plates.
        const t = 18;
        return { size: r.size, content: [t + 10, t + 10, w - 2 * t - 20, h - 2 * t - 20], layers: [
          one({ kind: 'rect', radius: 14 }, { ...wood(0), strokes: [gold(3), { width: 1.5, paint: '#1a0c04', position: 'inside', opacity: 0.7 }], dropShadow: { color: '#000000', opacity: 0.6, blur: 14, offset: [0, 12] } }),
          one({ kind: 'torn', rough: 2.2, radius: 4, seed: 3 }, { ...paper(), strokes: [gold(2.5)], innerShadow: { color: '#2a1606', opacity: 0.4, size: 8, offset: [0, 3] } }, [t, t, w - 2 * t, h - 2 * t]),
          one({ kind: 'frame', thickness: 1.5, radius: 6 }, { fill: GOLD, fillOpacity: 0.7 }, [t + 9, t + 9, w - 2 * t - 18, h - 2 * t - 18]),
          ...[[0, 0], [1, 0], [1, 1], [0, 1]].map(([fx, fy]) => one({ kind: 'polygon', points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, P.goldHi], [0.6, P.gold], [1, P.gold2]] }, bevel: { size: 4, style: 'chisel', highlightOpacity: 0.6, shadowOpacity: 0.5 }, strokes: [{ width: 1.2, paint: '#2a1606', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.5, blur: 2, offset: [0, 2] } }, [fx! * (w - 34), fy! * (h - 34), 34, 34])),
          studs(0, 4.5, [w * 0.25, 6, w * 0.5, h - 12]),
          // Rolled ends of the scroll top and bottom, and a wax seal on the bottom rail.
          one({ kind: 'pill' }, roll(), [t - 6, t - 7, w - 2 * t + 12, 14]),
          one({ kind: 'pill' }, roll(), [t - 6, h - t - 7, w - 2 * t + 12, 14]),
          ...seal(w / 2 - 22, h - 34, 44, P.wax, 'crown'),
        ] };
      }
      case 'header':
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.35 }, { ...enamel(accent ?? P.wax, h * 0.6), extrude: { depth: 4, color: darken(accent ?? P.wax, 0.6), stroke: { width: 1.5, color: '#1a0c04' } }, gloss: { style: 'arc', opacity: 0.18, height: 0.5, inset: 3 } })] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        if (on) return { size: r.size, layers: [one({ kind: 'tab', radius: 10 }, { ...paper({ burn: 0.3 }), strokes: [gold(2.5)], dropShadow: { color: '#000000', opacity: 0.35, blur: 3, offset: [0, 3] } })] };
        return withState({ size: r.size, layers: [one({ kind: 'tab', radius: 10 }, { ...wood(0), bevel: { size: 3, style: 'round', highlightOpacity: 0.3, shadowOpacity: 0.5 }, strokes: [{ width: 2, paint: P.gold2, position: 'outside' }, { width: 1, paint: P.gold, position: 'inside', opacity: 0.5 }], dropShadow: { color: '#000000', opacity: 0.35, blur: 3, offset: [0, 3] } })] }, state, look);
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityOf(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const layers: ForgeLayer[] = [one({ kind: 'rect', radius: 8 }, { ...paper({ burn: 0.4 }), overlays: [{ paint: { type: 'radial', center: [0.5, 0.4], scale: 1.2, stops: [[0, top, big ? 0.35 : 0.22], [1, top, 0]] }, blend: 'multiply' }], strokes: [gold(r.kind === 'slot' ? 2.5 : 3), { width: 2, paint: bot, position: 'inside', opacity: 0.55 }], dropShadow: { color: '#000000', opacity: 0.4, blur: 3, offset: [0, 4] }, ...(big ? { sparkles: { count: 2, size: 6, color: '#fff6d0', area: 'inside' as const } } : {}) })];
        if (r.kind === 'card') layers.push(...seal(w / 2 - 12, -9, 24, rarityVivid(r.variant)[1], 'crown'));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A wax seal: a lumpy disc, domed, its edge pressed.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'burst', points: 11, inner: 0.88, round: 3 }, { fill: { type: 'radial', center: [0.45, 0.4], stops: [[0, lighten(P.wax, 0.25)], [1, darken(P.wax, 0.35)]] }, bevel: { size: 4, style: 'pillow', highlightOpacity: 0.45, specular: 0.4 }, dropShadow: { color: '#000000', opacity: 0.45, blur: 2, offset: [0, 3] } }),
          one({ kind: 'ring', thickness: 1.5 }, { fill: darken(P.wax, 0.45), fillOpacity: 0.6 }, [w * 0.2, h * 0.2, w * 0.6, h * 0.6]),
        ] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.4 }, { ...enamel(accent ?? P.royal, h * 0.7), extrude: { depth: 3, color: darken(accent ?? P.royal, 0.6), stroke: { width: 1.5, color: '#1a0c04' } } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: '#2a1606', textures: [{ kind: 'leather', scale: 3, opacity: 0.3, blend: 'overlay' }], innerShadow: { color: '#000000', opacity: 0.7, size: 5, offset: [0, 2] }, strokes: [gold(2)] })] };
      case 'barFill': {
        const base = role === 'danger' ? '#c8302a' : role === 'premium' ? P.gold : role === 'secondary' ? '#3a6ad0' : (accent ?? '#4fa83a');
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, lighten(base, 0.4)], [0.5, base], [1, darken(base, 0.3)]] }, bevel: { size: 3, style: 'pillow', highlightOpacity: 0.4, specular: 0.4 }, gloss: { style: 'band', opacity: 0.3, height: 0.45, inset: 1.5 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, { ...wood(0), strokes: [gold(2)], innerShadow: { color: '#000000', opacity: 0.4, size: 4, offset: [0, 2] } })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { ...paper({ burn: 0.35 }), strokes: [gold(3.5)], dropShadow: { color: '#000000', opacity: 0.45, blur: 2, offset: [0, 3] } }), one({ kind: 'ring', thickness: 1.2 }, { fill: P.gold2, fillOpacity: 0.6 }, [w * 0.08, h * 0.08, w * 0.84, h * 0.84])] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, enamel(P.wax, h)), one({ kind: 'cross', thickness: 0.2 }, { fill: '#fff1d0', bevel: { size: 1.2, style: 'round', highlightOpacity: 0.4 }, strokes: [{ width: 1, paint: '#4a0c08', position: 'outside', opacity: 0.6 }] }, [w * 0.25, h * 0.2, w * 0.5, h * 0.56])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'Quests', font: 'GrenzeGotisch', weight: 700 }, {
          fill: { angle: 90, stops: [[0, '#fff8d8'], [0.45, P.gold], [1, '#9a6614']] },
          bevel: { size: 2.2, style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.45, specular: 0.5 },
          strokes: [{ width: 3, paint: '#2a1606', position: 'outside' }],
          extrude: { depth: 3, color: '#1a0c04' },
          dropShadow: { color: '#000000', opacity: 0.55, blur: 4, offset: [0, 7] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 0, stops: [[0, P.gold, 0], [0.5, P.gold2, 1], [1, P.gold, 0]] } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'torn', rough: 1.6, radius: 3, seed: 9 }, { ...paper({ burn: 0.5 }), dropShadow: { color: '#000000', opacity: 0.45, blur: 4, offset: [0, 5] } })] };
      case 'icon': {
        // Illuminated: a jewel-coloured silhouette, a gilded line round it, ink lines inside.
        const [top, bot] = isRarity(r.variant) ? rarityOf(r.variant) : role === 'danger' ? [lighten(P.wax, 0.3), P.wax] : [P.goldHi, P.gold];
        const g = r.glyph ?? 'scroll';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3, solid: true }, { fill: { angle: 90, stops: [[0, lighten(top, 0.55)], [0.55, top], [1, darken(bot, 0.15)]] }, bevel: { size: 2, style: 'pillow', highlightOpacity: 0.55, shadowOpacity: 0.4, specular: 0.4 }, strokes: [{ width: 2, paint: { angle: 90, stops: [[0, P.goldHi], [0.5, P.gold], [1, P.gold2]] }, position: 'outside' }], dropShadow: { color: '#2a1606', opacity: 0.5, blur: 1.5, offset: [0, 2.5] } }),
          one({ kind: 'glyph', name: g, weight: 1.8 }, { fill: '#2a1606', fillOpacity: 0.8 }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, P.goldHi], [0.55, P.gold], [1, P.gold2]] }, bevel: { size: Math.max(1.5, w * 0.08), style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.4, specular: 0.5 }, strokes: [{ width: Math.max(1, w * 0.035), paint: '#2a1606', position: 'outside' }], extrude: { depth: Math.max(1.2, h * 0.06), color: '#5a3a08' }, dropShadow: { color: '#000000', opacity: 0.45, blur: 1.5, offset: [0, 2] } }),
          one({ kind: 'ring', thickness: Math.max(0.8, w * 0.03) }, { fill: P.gold2, fillOpacity: 0.8 }, [w * 0.13, h * 0.13, w * 0.74, h * 0.74]),
          one({ kind: 'glyph', name: r.glyph ?? 'crown', weight: 2.6, solid: true }, { fill: { angle: 90, stops: [[0, P.goldHi], [1, P.gold]] }, bevel: { size: Math.max(0.6, w * 0.03), style: 'pillow', highlightOpacity: 0.6, shadowOpacity: 0.5 }, strokes: [{ width: Math.max(0.6, w * 0.025), paint: P.gold2, position: 'outside' }] }, [w * 0.26, h * 0.24, w * 0.48, h * 0.5]),
        ] };
    }
  },
};
