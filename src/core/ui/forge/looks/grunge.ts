import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityOf, roleOf, withState, type Direction } from '../kit';
import { blend, type Color, type LayerStyle } from '../style';

/**
 * Grunge: horror and survival (Doors-likes, escape rooms, haunted houses, infection games): rusted, scratched and
 * dented sheet metal with ragged edges, grime, bone-coloured paper notes, wet blood-red paint that drips, a sick glow
 * round rare things, and Creepster titles bleeding down. (Flicker is motion: pair these with a flicker tween.)
 */

const P = { metal: '#2a2522', metal2: '#3a322c', rust: '#7a3412', rust2: '#b0561c', bone: '#d8cdb2', bone2: '#a8987a', blood: '#8a0b0b', blood2: '#c0150f', sick: '#9db36a', black: '#0b0908', brass: '#9a7a3a' };

/** Rusted sheet metal: rust blotches, scratches, grime, a ragged edge, worn bright edges. */
const rusted = (o: { rust?: number; rough?: number; tone?: Color } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(o.tone ?? P.metal2, 0.04)], [1, darken(o.tone ?? P.metal, 0.15)]] },
  textures: [
    { kind: 'noise', scale: 30, opacity: 0.5, blend: 'multiply', ramp: [[0, '#000000'], [0.55, '#ffffff'], [1, '#ffffff']] },
    { kind: 'brushed', scale: 9, angle: 90, opacity: 0.22, color: '#6a2a0c' },
    { kind: 'rust', scale: 22, density: o.rust ?? 0.3, opacity: 0.85, ramp: [[0, P.rust, 0], [0.35, '#5a2408', 0.55], [0.75, P.rust, 0.8], [1, '#3a1404', 0.9]], seed: 5 },
    { kind: 'scratches', scale: 5, density: 0.45, color: '#c8bcae', opacity: 0.22, angle: -20 },
  ],
  wear: { amount: 0.35, color: '#8a817a', width: 3, scale: 2, opacity: 0.6 },
  bevel: { size: 2, style: 'chisel', highlightOpacity: 0.25, shadowOpacity: 0.55 },
  overlays: [{ paint: { type: 'radial', center: [0.5, 0.45], scale: 1.4, stops: [[0, '#000000', 0], [1, '#000000', 0.55]] }, blend: 'normal' }],
  roughen: { amount: o.rough ?? 1, scale: 4, seed: 7 },
  strokes: [{ width: 2, paint: P.black, position: 'outside', opacity: 0.9 }],
  dropShadow: { color: '#000000', opacity: 0.75, blur: 5, offset: [0, 6] },
});

/** Wet paint over metal: a colour smeared on, rust bleeding through, scuffed off at the edges. */
const painted = (base: Color, h: number): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.1)], [0.55, base], [1, darken(base, 0.4)]] },
  textures: [
    { kind: 'clouds', scale: 30, opacity: 0.16, blend: 'multiply', ramp: [[0, '#2a0604'], [1, '#ffffff']] },
    { kind: 'rust', scale: 14, density: 0.12, opacity: 0.7, ramp: [[0, P.rust, 0], [1, '#2a0a02', 0.85]], seed: 11 },
    { kind: 'scratches', scale: 4, density: 0.4, color: '#000000', opacity: 0.3, angle: 10 },
  ],
  wear: { amount: 0.45, color: '#3a3430', width: 4, scale: 2.5 },
  bevel: { size: 2, style: 'smooth', highlightOpacity: 0.3, shadowOpacity: 0.5, specular: 0.35 },
  roughen: { amount: 1, scale: 3.5, seed: 3 },
  strokes: [{ width: 2, paint: P.black, position: 'outside' }],
  extrude: { depth: Math.max(3, h * 0.07), color: '#120c0a', stroke: { width: 2, color: P.black } },
  dropShadow: { color: '#000000', opacity: 0.7, blur: 4, offset: [0, Math.max(5, h * 0.1)] },
});

/** Old paper: bone-coloured, stained, torn. */
const note = (): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(P.bone, 0.1)], [1, P.bone2]] },
  textures: [{ kind: 'paper', scale: 6, opacity: 0.4, blend: 'multiply', ramp: [[0, '#8a7a5a'], [1, '#ffffff']] }, { kind: 'clouds', scale: 30, opacity: 0.45, blend: 'multiply', ramp: [[0, '#6a4a2a'], [0.55, '#ffffff'], [1, '#ffffff']], seed: 4 }],
  innerGlow: { color: '#4a3018', opacity: 0.5, size: 10, blend: 'multiply' },
  dropShadow: { color: '#000000', opacity: 0.6, blur: 4, offset: [0, 5] },
});

/** Blood that runs: glossy, dark at its edge. */
const blood = (): LayerStyle => ({
  fill: { angle: 90, stops: [[0, P.blood2], [1, P.blood]] },
  roughen: { amount: 0.6, scale: 3, seed: 2 },
  gloss: { style: 'spot', opacity: 0.25, height: 0.4 },
  bevel: { size: 2.5, style: 'round', highlightOpacity: 0.45, shadowOpacity: 0.5, specular: 0.8, angle: 120 },
  strokes: [{ width: 1, paint: '#3a0202', position: 'inside', opacity: 0.6 }],
});

export const grunge: Direction = {
  id: 'grunge',
  label: 'Grunge (rust, scratches and blood)',
  for: 'horror, survival, escape and haunted games: rusted scratched sheet metal with ragged edges, grime, bone paper notes, wet dripping blood-red paint, sick glows, Creepster titles (add a flicker tween at runtime)',
  palette: P,
  fonts: { display: 'Creepster', body: 'Oswald', weightBody: 600 },
  backdrop: '#141412',
  text: {
    color: '#d8cdb2',
    stroke: '#000000',
    strokePx: 1.5,
    onButton: '#f2e8d8',
    onButtonStroke: '#140404',
    title: { color: '#d81a12', stroke: '#140202', strokePx: 2, font: 'Creepster', minSize: 26 },
    button: { color: '#f2e8d8', stroke: '#140404', strokePx: 2.5, font: 'Oswald', weight: 700 },
    tabOn: { color: '#1a1410', font: 'Oswald', weight: 700 },
    tabOff: { color: '#cfc4ae', stroke: '#000000', strokePx: 1.5, font: 'Oswald', weight: 600 },
    onCard: { color: '#ece2cc', stroke: '#000000', strokePx: 2, font: 'Oswald', weight: 600 },
    onPill: { color: '#ece2cc', stroke: '#000000', strokePx: 1.5, font: 'Oswald', weight: 600 },
    muted: { color: '#a0968a', font: 'Oswald', weight: 600 },
    disabled: { color: '#9a948c', stroke: '#000000', strokePx: 1.5, font: 'Oswald', weight: 600 },
    buttons: {
      primary: { color: '#f2e8d8', stroke: '#140404', strokePx: 2.5, font: 'Oswald', weight: 700 },
      secondary: { color: '#1a1410', font: 'Oswald', weight: 700 },
      danger: { color: '#f2e8d8', stroke: '#140404', strokePx: 2.5, font: 'Oswald', weight: 700 },
      success: { color: '#f2f0d8', stroke: '#0e1404', strokePx: 2.5, font: 'Oswald', weight: 700 },
      premium: { color: '#f8ecd0', stroke: '#140c02', strokePx: 2.5, font: 'Oswald', weight: 700 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: P.sick, grey: '#2a2826', greyMix: 0.55 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const red = accent ?? P.blood2;
    switch (r.kind) {
      case 'button': {
        if (role === 'secondary') return s({ size: r.size, layers: [one({ kind: 'torn', rough: 2, seed: 5 }, { ...note(), extrude: { depth: 2.5, color: '#3a3020' }, strokes: [{ width: 1, paint: '#2a2010', position: 'outside', opacity: 0.6 }] })] });
        const base = role === 'danger' ? '#c2410c' : role === 'success' ? '#5f7a22' : role === 'premium' ? P.brass : (accent ?? '#8e1410');
        return s({ size: r.size, layers: [one({ kind: 'rect', radius: 3 }, painted(base, h))] });
      }
      case 'window': {
        // A battered rusted plate, a grimy recess, bolts, and blood running from the top edge.
        const t = 16;
        return { size: r.size, content: [t + 8, t + 14, w - 2 * t - 16, h - 2 * t - 22], layers: [
          one({ kind: 'rect', radius: 6 }, { ...rusted({ rough: 2 }), dropShadow: { color: '#000000', opacity: 0.8, blur: 18, offset: [0, 14] } }),
          one({ kind: 'rect', radius: 4 }, { fill: { angle: 90, stops: [[0, '#151210'], [1, '#0c0a09']] }, textures: [{ kind: 'noise', scale: 30, opacity: 0.6, blend: 'multiply', ramp: [[0, '#000000'], [1, '#ffffff']] }, { kind: 'scratches', scale: 6, density: 0.3, color: '#ffffff', opacity: 0.06 }], innerShadow: { color: '#000000', opacity: 0.95, size: 18, offset: [0, 6] }, innerGlow: { color: P.sick, opacity: 0.06, size: 50 }, roughen: { amount: 1, scale: 4, seed: 12 }, strokes: [{ width: 1.5, paint: '#000000', position: 'outside' }] }, [t, t, w - 2 * t, h - 2 * t]),
          one({ kind: 'rivets', radius: 4.5, inset: 0 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#8a7a6a'], [0.6, '#4a3a2e'], [1, '#1a1210']] }, textures: [{ kind: 'rust', scale: 4, density: 0.6, opacity: 0.8, ramp: [[0, P.rust, 0], [1, P.rust2, 1]] }], strokes: [{ width: 1, paint: '#000000', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.8, blur: 1, offset: [0, 1.5] } }, [8, 8, w - 16, h - 16]),
          one({ kind: 'drip', drips: Math.max(4, Math.round(w / 70)), length: 0.9, seed: 9 }, blood(), [w * 0.06, 1, w * 0.88, Math.min(110, h * 0.3)]),
          // Claw marks gouged through the plate, bottom right.
          ...[0, 1, 2].map((i) => one({ kind: 'polygon', points: [[0.08, 0], [0.2, 0.02], [1, 0.92], [0.96, 1]] }, { fill: '#050403', bevel: { size: 1.5, style: 'chisel', highlightOpacity: 0.5, shadowOpacity: 0.2, angle: 300 }, strokes: [{ width: 1.2, paint: '#8a7a6a', position: 'outside', opacity: 0.5 }] }, [w - 120 + i * 22, h - 110 + i * 6, 70 - i * 8, 86 - i * 6])),
        ] };
      }
      case 'header':
        // A rusted bar (it stretches: the rust runs along it), bolted at both ends, a smear of blood at the left.
        return { size: r.size, layers: [
          one({ kind: 'rect', radius: 4 }, { ...rusted({ rust: 0.35, rough: 1 }), textures: [{ kind: 'noise', scale: 30, opacity: 0.5, blend: 'multiply', ramp: [[0, '#000000'], [0.55, '#ffffff'], [1, '#ffffff']] }, { kind: 'brushed', scale: 9, opacity: 0.35, color: '#6a2a0c' }, { kind: 'scratches', scale: 5, density: 0.45, color: '#c8bcae', opacity: 0.22, angle: 0 }] }),
          one({ kind: 'rivets', radius: 4, inset: 0 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#8a7a6a'], [0.6, '#4a3a2e'], [1, '#1a1210']] }, strokes: [{ width: 1, paint: '#000000', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.8, blur: 1, offset: [0, 1.5] } }, [10, 10, 14, h - 20]),
          one({ kind: 'rivets', radius: 4, inset: 0 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#8a7a6a'], [0.6, '#4a3a2e'], [1, '#1a1210']] }, strokes: [{ width: 1, paint: '#000000', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.8, blur: 1, offset: [0, 1.5] } }, [w - 24, 10, 14, h - 20]),
          one({ kind: 'drip', drips: 2, length: 0.75, seed: 4 }, blood(), [30, 2, Math.min(70, w * 0.2), h * 0.95]),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        if (on) return { size: r.size, layers: [one({ kind: 'torn', rough: 2, seed: 8 }, { ...note(), strokes: [{ width: 1, paint: '#2a2010', position: 'outside', opacity: 0.5 }] })] };
        return withState({ size: r.size, layers: [one({ kind: 'rect', radius: 3 }, rusted({ rust: 0.25 }))] }, state, look);
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityOf(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const glow = r.variant === 'mythic' ? P.blood2 : r.variant === 'legendary' ? '#d8a020' : r.variant === 'epic' ? '#8a40c0' : r.variant === 'rare' ? P.sick : '#6a6a60';
        // A rusted rim round a dark grimy well: the texture stays on the frame, so what sits in the well (an icon, a
        // name) is what the eye finds, and the rarity is a light in the well rather than more rust.
        const rim = Math.max(4, Math.min(r.kind === 'card' ? 11 : 7, Math.min(w, h) * 0.09));
        const layers: ForgeLayer[] = [
          one({ kind: 'rect', radius: 4 }, {
            ...rusted({ rust: big ? 0.34 : 0.26, rough: 1.2 }),
            strokes: [{ width: 2, paint: P.black, position: 'outside' }],
            ...(big ? { outerGlow: { color: glow, opacity: 0.45, size: 9 } } : {}),
          }),
          one({ kind: 'rect', radius: 3 }, {
            fill: { angle: 90, stops: [[0, '#1c1916'], [1, '#100e0c']] },
            textures: [{ kind: 'noise', scale: 26, opacity: 0.35, blend: 'multiply', ramp: [[0, '#000000'], [1, '#ffffff']] }, { kind: 'scratches', scale: 6, density: 0.25, color: '#ffffff', opacity: 0.05 }],
            overlays: [{ paint: { type: 'radial', center: [0.5, 0.45], scale: 0.95, stops: [[0, glow, big ? 0.5 : r.variant === 'common' || !r.variant ? 0.1 : 0.32], [1, glow, 0]] }, blend: 'screen' }],
            innerShadow: { color: '#000000', opacity: 0.9, size: Math.max(4, rim * 1.2), offset: [0, 2] },
            strokes: [{ width: 1.5, paint: darken(top, 0.35), position: 'inside', opacity: isRarity(r.variant) && r.variant !== 'common' ? 0.8 : 0.35 }],
          }, [rim, rim, w - 2 * rim, h - 2 * rim]),
        ];
        if (r.kind === 'card') layers.push(one({ kind: 'rivets', radius: 2.6, inset: 0 }, { fill: { type: 'radial', center: [0.38, 0.32], stops: [[0, '#8a7a6a'], [1, '#1a1210']] }, strokes: [{ width: 0.8, paint: '#000000', position: 'outside' }] }, [rim / 2 - 2.6, rim / 2 - 2.6, w - rim + 5.2, h - rim + 5.2]));
        void bot;
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A blood splat.
        return { size: r.size, slice: false, layers: [one({ kind: 'burst', points: 9, inner: 0.62, round: 3 }, { ...blood(), roughen: { amount: 1.5, scale: 3, seed: 5 }, dropShadow: { color: '#000000', opacity: 0.6, blur: 2, offset: [0, 3] } })] };
      case 'ribbon':
        // A torn strip of old paper (red writing reads on it).
        return { size: r.size, layers: [one({ kind: 'torn', rough: Math.min(2.5, h * 0.06), seed: 6 }, { ...note(), textures: [{ kind: 'paper', scale: 6, opacity: 0.4, blend: 'multiply', ramp: [[0, '#8a7a5a'], [1, '#ffffff']] }], innerGlow: { color: '#4a3018', opacity: 0.45, size: 6, blend: 'multiply' } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'rect', radius: 2 }, { fill: '#0a0807', textures: [{ kind: 'scratches', scale: 3, density: 0.4, color: '#ffffff', opacity: 0.08 }], innerShadow: { color: '#000000', opacity: 0.9, size: 5, offset: [0, 2] }, strokes: [{ width: 1.5, paint: '#3a2e26', position: 'inside' }, { width: 2, paint: P.black, position: 'outside' }] })] };
      case 'barFill': {
        const base = role === 'danger' ? P.blood2 : role === 'premium' ? '#c8a040' : role === 'success' ? P.sick : role === 'secondary' ? '#6a8aa0' : (accent ?? P.sick);
        return { size: r.size, layers: [one({ kind: 'rect', radius: 2 }, { fill: { angle: 90, stops: [[0, lighten(base, 0.2)], [1, darken(base, 0.35)]] }, textures: [{ kind: 'clouds', scale: 10, opacity: 0.4, blend: 'multiply', ramp: [[0, '#200000'], [1, '#ffffff']] }], bevel: { size: 2, style: 'round', highlightOpacity: 0.4, specular: 0.6 }, outerGlow: { color: base, opacity: 0.3, size: 5 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'rect', radius: 4 }, { ...rusted({ rust: 0.25, rough: 0.8 }), innerShadow: { color: '#000000', opacity: 0.6, size: 6, offset: [0, 2] } })] };
      case 'iconFrame':
        // A rusted porthole: a ring of bolts round dark glass.
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, rusted({ rust: 0.4, rough: 0.8 })),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#2a3028'], [1, '#050605']] }, innerShadow: { color: '#000000', opacity: 0.9, size: 6, offset: [0, 2] }, innerGlow: { color: P.sick, opacity: 0.12, size: 12 }, gloss: { style: 'spot', opacity: 0.15, height: 0.5 } }, [w * 0.15, h * 0.15, w * 0.7, h * 0.7]),
        ] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'rect', radius: 3 }, { ...rusted({ rust: 0.4, rough: 0.8 }), extrude: { depth: 3, color: '#0a0807' } }),
          one({ kind: 'cross', thickness: 0.2 }, { fill: P.bone, textures: [{ kind: 'scratches', scale: 2, density: 0.6, color: '#000000', opacity: 0.4 }], roughen: { amount: 0.8, scale: 2, seed: 4 }, strokes: [{ width: 1, paint: '#000000', position: 'outside' }] }, [w * 0.24, h * 0.2, w * 0.52, h * 0.56]),
        ] }, state, look);
      case 'title': {
        // Creepster in wet red, bleeding down from the letters, a dim sick halo behind.
        const text = r.text ?? 'ESCAPE';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'drip', drips: Math.max(4, text.length), length: 0.9, seed: 13 }, blood(), [w * 0.22, h * 0.45, w * 0.56, h * 0.52]),
          one({ kind: 'text', text, font: 'Creepster', tracking: 0.03 }, {
            fill: { angle: 90, stops: [[0, '#ff3a2a'], [0.55, P.blood2], [1, '#5a0404']] },
            textures: [{ kind: 'scratches', scale: 3, density: 0.5, color: '#2a0000', opacity: 0.5 }],
            bevel: { size: 2.2, style: 'round', highlightOpacity: 0.45, shadowOpacity: 0.55, specular: 0.7 },
            strokes: [{ width: 2.5, paint: '#140202', position: 'outside' }],
            outerGlow: { color: '#ff1a0a', opacity: 0.35, size: 14 },
            dropShadow: { color: '#000000', opacity: 0.8, blur: 3, offset: [0, 5] },
          }, [0, 0, w, h * 0.82]),
        ] };
      }
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'torn', rough: Math.min(1.2, h * 0.3), seed: 3 }, { fill: { angle: 0, stops: [[0, P.bone2, 0], [0.5, P.bone2, 0.8], [1, P.bone2, 0]] } })] };
      case 'tooltip':
        return { size: r.size, layers: [
          one({ kind: 'torn', rough: 2.5, seed: 14 }, note()),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#d8c8b0'], [1, '#6a5a4a']] }, strokes: [{ width: 1, paint: '#000000', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.6, blur: 1, offset: [0, 2] } }, [w / 2 - 5, 3, 10, 10]),
        ] };
      case 'icon': {
        // Bone and grime: a dirty silhouette, its lines dark, a sick or bloody glow for the rare.
        const glow = role === 'danger' ? P.blood2 : r.variant === 'mythic' ? P.blood2 : r.variant === 'legendary' ? '#e0a830' : r.variant === 'epic' ? '#a050e0' : r.variant === 'rare' ? P.sick : null;
        // Bone stained in the thing's colour (its accent, rarity or role), so a key card, a pill and a battery tell
        // apart at a glance; plain bone when it has none.
        const stain = accent ?? (role === 'danger' ? P.blood2 : role === 'success' ? P.sick : role === 'premium' ? '#d8a020' : role === 'secondary' ? '#6a8aa0' : isRarity(r.variant) && r.variant !== 'common' ? glow : null);
        const bone = (c: Color, t: number): Color => (stain ? blend(c, stain, t) : c);
        const g = r.glyph ?? 'skull';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3, solid: true }, {
            fill: { angle: 90, stops: [[0, bone('#efe6d0', 0.35)], [0.6, bone(P.bone, 0.55)], [1, bone('#8a7a5e', 0.6)]] },
            textures: [{ kind: 'noise', scale: 6, opacity: 0.55, blend: 'multiply', ramp: [[0, '#4a3a28'], [0.6, '#ffffff'], [1, '#ffffff']] }, { kind: 'scratches', scale: 2.5, density: 0.4, color: '#3a2a1a', opacity: 0.4 }],
            bevel: { size: 1.5, style: 'smooth', highlightOpacity: 0.4, shadowOpacity: 0.5 },
            roughen: { amount: 0.5, scale: 2, seed: 3 },
            strokes: [{ width: 1.5, paint: '#0a0604', position: 'outside' }],
            ...(glow && isRarity(r.variant) ? { outerGlow: { color: glow, opacity: 0.6, size: 8 } } : glow ? { outerGlow: { color: glow, opacity: 0.6, size: 8 } } : {}),
            dropShadow: { color: '#000000', opacity: 0.7, blur: 2, offset: [0, 3] },
          }),
          one({ kind: 'glyph', name: g, weight: 1.6 }, { fill: '#1a0e08', fillOpacity: 0.75 }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#c8a868'], [0.6, P.brass], [1, '#4a3a18']] }, textures: [{ kind: 'rust', scale: Math.max(4, w * 0.3), density: 0.4, opacity: 0.8, ramp: [[0, '#2a5a3a', 0], [1, '#3a6a4a', 0.8]] }], bevel: { size: Math.max(1, w * 0.07), style: 'round', highlightOpacity: 0.45, shadowOpacity: 0.5 }, strokes: [{ width: Math.max(1, w * 0.035), paint: '#140c04', position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.6, blur: 1, offset: [0, Math.max(1, h * 0.05)] } }),
          one({ kind: 'glyph', name: r.glyph ?? 'skull', weight: 2.6, solid: true }, { fill: '#2a1e0c', bevel: { size: Math.max(0.5, w * 0.02), style: 'chisel', highlightOpacity: 0.3 } }, [w * 0.24, h * 0.22, w * 0.52, h * 0.54]),
        ] };
    }
  },
};
