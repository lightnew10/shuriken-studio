import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityVivid, roleOf, withState, type Direction } from '../kit';
import { textContours, type ShapeSpec } from '../shapes';
import type { Color, Gradient, LayerStyle, Stop } from '../style';

/**
 * Motorsport: arcade racing (kart, drift, street and circuit racers, car tycoons, garages): a night garage of carbon
 * fibre under smoked glass with lit edges and chamfered corners, racing stripes and speed slashes in the game's colour,
 * slanted buttons in glossy candy paint with a hard specular streak and a dark 3D underside, chrome bezels and gauges,
 * glowing slanted speed meters, chequered-flag ribbons, and heavy italic chrome titles with a speed trail.
 */

const P = { hot: '#ff4a12', green: '#16c45a', gold: '#ffb81c', red: '#d40f2b', nitro: '#2f9dff', chrome: '#d8dee6', gun: '#3a424e', carbon: '#10141c', carbon2: '#1b2230', night: '#070a12', ice: '#cfe2ff', accent: '#ff4a12' };
const INK = '#05070b';
/** The lean of everything that moves: 12°. */
const LEAN = Math.tan((12 * Math.PI) / 180);

/** A parallelogram leaning forward, its two sharp corners clipped (buttons, tabs, bars): the slant stays in its ends. */
const slanted = (h: number, clip = 1.5, lean = LEAN): ShapeSpec => ({ kind: 'cut', cut: [0, clip, 0, clip], slant: [h * lean, -h * lean] });
/** A box leaning forward as a polygon in its own 0..1 frame (decals, stripes, the leading edge of a bar). */
const leaning = (w: number, h: number, lean = LEAN): ShapeSpec => {
  const k = Math.min(0.45, (h * lean) / Math.max(1, w));
  return { kind: 'polygon', points: [[k, 0], [1, 0], [1 - k, 1], [0, 1]] };
};

/** Polished chrome: bright above, the dark horizon across the middle, light again below. */
const CHROME: Gradient = { angle: 90, stops: [[0, '#ffffff'], [0.4, '#c7d0db'], [0.5, '#5d6877'], [0.6, '#8b97a6'], [1, '#e9eef3']] };
/** A thin chrome edge (a ring round icons, pills, gauges). */
const CHROME_EDGE: Gradient = { angle: 90, stops: [[0, '#ffffff'], [0.45, '#b6c0cc'], [0.55, '#5a6573'], [1, '#d6dde5']] };

/**
 * Carbon fibre under smoked glass: a fine twill, a diagonal reflection, a lit top edge, a recess shadow. Art that
 * stretches far (windows, headers, tooltips: `wide`) goes without the diagonal, which a 9-slice would step, and with a
 * quieter weave, which a 9-slice forged narrow smears into bands across its middle.
 */
const carbon = (o: { alpha?: number; weave?: number; top?: Color; bottom?: Color; wide?: boolean } = {}): LayerStyle => {
  const a = o.alpha ?? 0.97;
  return {
    fill: { angle: 90, stops: [[0, o.top ?? '#1a212d', a], [1, o.bottom ?? '#090c12', a]] },
    textures: [{ kind: 'carbon', scale: 2.6, opacity: o.weave ?? (o.wide ? 0.26 : 0.4), ramp: [[0, '#030407'], [1, '#262e3c']] }],
    overlays: [{ paint: { type: 'radial', center: [0.5, 0], scale: 1.3, stops: [[0, '#8fb4ff', 0.07], [1, '#8fb4ff', 0]] }, blend: 'screen' }],
    innerShadow: { color: '#000000', opacity: 0.65, size: 12, offset: [0, 4] },
    ...(o.wide ? {} : { gloss: { style: 'glass' as const, opacity: 0.07, height: 0.55, inset: 2, color: '#cfe0ff' } }),
    rim: { width: 2, color: P.ice, opacity: 0.32, angle: 90, falloff: 2 },
    strokes: [{ width: 1.5, paint: INK, position: 'outside' }, { width: 1, paint: '#ffffff', position: 'inside', opacity: 0.1 }],
  };
};

/** Brushed gunmetal (bezels, inactive tabs). */
const gunmetal = (top = '#3c4553', bottom = '#151a22'): LayerStyle => ({
  fill: { angle: 90, stops: [[0, top], [0.5, lighten(bottom, 0.12)], [1, bottom]] },
  textures: [{ kind: 'brushed', scale: 6, angle: 0, opacity: 0.22, blend: 'overlay' }],
  bevel: { size: 2, style: 'chisel', highlightOpacity: 0.35, shadowOpacity: 0.5 },
  rim: { width: 2, color: '#ffffff', opacity: 0.28, angle: 90, falloff: 2 },
  strokes: [{ width: 1.5, paint: INK, position: 'outside' }],
});

/** Candy paint: a deep two-tone gradient, a hard diagonal specular streak, a lit top edge and a dark 3D underside. */
const candyPaint = (col: Color, h: number, o: { depth?: number; brushed?: boolean; metal?: boolean } = {}): LayerStyle => {
  const depth = o.depth ?? Math.max(3, Math.min(6, h * 0.09));
  return {
    fill: o.metal
      ? { angle: 90, stops: [[0, '#b9c3cf'], [0.46, '#6c7786'], [0.54, '#48525f'], [1, '#262c35']] }
      : { angle: 90, stops: [[0, lighten(col, 0.42)], [0.46, lighten(col, 0.08)], [0.54, col], [1, darken(col, 0.4)]] },
    ...(o.brushed ? { textures: [{ kind: 'brushed' as const, scale: 5, angle: 0, opacity: 0.28, blend: 'overlay' as const }] } : {}),
    gloss: { style: 'glass', opacity: 0.3, height: 0.66, inset: 2.5 },
    rim: { width: 2.5, color: '#ffffff', opacity: 0.55, angle: 90, falloff: 2, shade: '#000000', shadeOpacity: 0.25 },
    strokes: [{ width: 1.5, paint: INK, position: 'outside' }, { width: 1.2, paint: o.metal ? '#dfe5ec' : lighten(col, 0.6), position: 'inside', opacity: 0.55 }],
    ...(depth > 0 ? { extrude: { depth, color: { angle: 90, stops: [[0, o.metal ? '#1d2229' : darken(col, 0.55)], [1, o.metal ? '#0c0f13' : darken(col, 0.78)]] }, stroke: { width: 1.5, color: INK } } } : {}),
    dropShadow: { color: '#000000', opacity: 0.55, blur: 4, offset: [0, depth + 3] },
  };
};

/**
 * A glint at a slanted face's leading end: one bright slash, inside the face and within its own corner (the slant and
 * its rim), so a 9-slice keeps it whole, even one forged narrow and only ever stretched.
 */
const glint = (h: number): ForgeLayer => {
  const lean = Math.min(h * 0.12, 6);
  const t = Math.min(Math.max(2, h * 0.06), 3);
  const x = Math.max(h * 0.185 - lean, h * 0.1) + 1.5;
  return one({ kind: 'polygon', points: [[lean / (lean + t), 0], [1, 0], [t / (lean + t), 1], [0, 1]] }, { fill: { angle: 90, stops: [[0, '#ffffff', 0.85], [1, '#ffffff', 0.12]] } }, [x, h * 0.14, lean + t, h * 0.4]);
};

/** Racing stripes across a chamfered corner (x + y from a to b, in points), top-left or (flipped) bottom-right. */
const cornerStripe = (w: number, h: number, a: number, b: number, fill: Color | Gradient, flip: boolean): ForgeLayer => {
  const S = b + 2;
  const p = (u: number, v: number): [number, number] => (flip ? [1 - u, 1 - v] : [u, v]);
  return one({ kind: 'polygon', points: [p(a / S, 0), p(b / S, 0), p(0, b / S), p(0, a / S)] }, { fill, strokes: [{ width: 1, paint: INK, position: 'outside', opacity: 0.8 }] }, flip ? [w - S, h - S, S, S] : [0, 0, S, S]);
};

/** Hard-edged conic stops: n ticks from t0 to t1 (of a turn, 0 pointing down, clockwise), each `duty` of its step. */
const ticks = (n: number, t0: number, t1: number, duty: number, color: Color, alpha = 1): Stop[] => {
  const out: Stop[] = [[0, color, 0]];
  const step = (t1 - t0) / n;
  for (let i = 0; i <= n; i++) {
    const a = t0 + i * step - (step * duty) / 2;
    const b = a + step * duty;
    out.push([Math.max(0, a), color, 0], [Math.max(0, a) + 1e-4, color, alpha], [Math.min(1, b), color, alpha], [Math.min(1, b) + 1e-4, color, 0]);
  }
  out.push([1, color, 0]);
  return out;
};

export const motorsport: Direction = {
  id: 'motorsport',
  label: 'Motorsport (arcade racing garage)',
  for: 'racing, karting, drifting, street racers, car tycoons and garages: carbon fibre under smoked glass with lit edges and chamfered corners, racing stripes in your colour, slanted glossy candy-paint buttons with a 3D underside, chrome gauges, glowing slanted speed meters, chequered ribbons, heavy italic chrome titles',
  palette: P,
  fonts: { display: 'Sarpanch', body: 'TitilliumWeb', weightDisplay: 700, weightBody: 700 },
  backdrop: P.night,
  text: {
    color: '#e8eef7',
    onButton: '#ffffff',
    onButtonStroke: INK,
    title: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'Sarpanch', weight: 700, minSize: 22 },
    button: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 18 },
    tabOn: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'TitilliumWeb', weight: 700 },
    tabOff: { color: '#b9c4d3', font: 'TitilliumWeb', weight: 700 },
    onCard: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'TitilliumWeb', weight: 700 },
    onPill: { color: '#ffffff', stroke: INK, strokePx: 1.5, font: 'Sarpanch', weight: 700, minSize: 18 },
    muted: { color: '#93a0b4', font: 'TitilliumWeb', weight: 600 },
    disabled: { color: '#e2e7ee', stroke: '#14181e', strokePx: 2, font: 'TitilliumWeb', weight: 700 },
    buttons: {
      primary: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 18 },
      secondary: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 18 },
      danger: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 18 },
      success: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 18 },
      premium: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'Sarpanch', weight: 700, minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const edge = accent ?? P.hot;
    const look = { press: 3, ring: accent ? lighten(accent, 0.45) : '#ffd60a', grey: '#262b33', greyMix: 0.72 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const roleColor = role === 'danger' ? P.red : role === 'success' ? P.green : role === 'premium' ? P.gold : role === 'secondary' ? P.nitro : edge;
    switch (r.kind) {
      case 'button': {
        const face = role === 'secondary' ? candyPaint(P.gun, h, { metal: true, brushed: true }) : candyPaint(roleColor, h);
        if (role === 'premium') face.sparkles = { count: 2, size: Math.min(6, h * 0.12), area: 'inside', opacity: 0.85 };
        return s({ size: r.size, layers: [one(slanted(h), face), glint(h)] });
      }
      case 'window': {
        // A gunmetal bezel round carbon under smoked glass, its edge lit in the game's colour (the light bleeds in a
        // little: that glow also keeps the corner stripes inside the 9-slice's corners), racing stripes across the
        // chamfered corners and a run of speed slashes on the top bezel by its right corner.
        const t = 8;
        const c = 30;
        const dash = Math.min(60, w * 0.16);
        const paint: Gradient = { angle: 90, stops: [[0, lighten(edge, 0.25)], [1, darken(edge, 0.2)]] };
        return { size: r.size, content: [t + 14, t + 14, w - 2 * t - 28, h - 2 * t - 28], layers: [
          one({ kind: 'cut', cut: [c, 0, c, 0] }, { ...gunmetal(), outerGlow: { color: edge, opacity: 0.16, size: 16 }, dropShadow: { color: '#000000', opacity: 0.65, blur: 18, offset: [0, 14] } }),
          one({ kind: 'cut', cut: [c - 4, 0, c - 4, 0] }, { ...carbon({ wide: true }), overlays: [{ paint: { type: 'radial', center: [0.5, 0], scale: 1.3, stops: [[0, '#8fb4ff', 0.07], [1, '#8fb4ff', 0]] }, blend: 'screen' }, { paint: { type: 'radial', center: [0.5, 1.05], scale: 1.1, stops: [[0, edge, 0.13], [1, edge, 0]] }, blend: 'screen' }], innerGlow: { color: edge, opacity: 0.1, size: 18 }, strokes: [{ width: 2, paint: lighten(edge, 0.15), position: 'outside' }, { width: 1, paint: '#ffffff', position: 'inside', opacity: 0.12 }], outerGlow: { color: edge, opacity: 0.6, size: 6 } }, [t, t, w - 2 * t, h - 2 * t]),
          cornerStripe(w, h, c + 6, c + 14, paint, false),
          cornerStripe(w, h, c + 17, c + 20, '#f2f5f9', false),
          cornerStripe(w, h, c + 6, c + 14, paint, true),
          cornerStripe(w, h, c + 17, c + 20, '#f2f5f9', true),
          one({ kind: 'rect' }, { fill: edge, patterns: [{ kind: 'stripes', color: INK, opacity: 1, size: 9, angle: 22, duty: 0.45 }], outerGlow: { color: edge, opacity: 0.45, size: 4 } }, [w - c - 6 - dash, 2, dash, 4]),
        ] };
      }
      case 'header': {
        // A carbon bar with chamfered ends, lit along its bottom in the colour, a pair of racing slashes in each end
        // (inside its chamfers' reach: headers stretch, and a 9-slice keeps the ends whole).
        const ch = Math.min(h * 0.42, 30);
        const sh = h * 0.5;
        const sw = Math.max(5, Math.min(h * 0.14, 12));
        const x = Math.max(3, ch + 1 - sw * 1.85);
        const slash = (at: number, fill: Color | Gradient): ForgeLayer => one(leaning(sw, sh, 0.5), { fill, strokes: [{ width: 1, paint: INK, position: 'outside', opacity: 0.7 }] }, [at, h * 0.25, sw, sh]);
        const paint: Gradient = { angle: 90, stops: [[0, lighten(edge, 0.3)], [1, darken(edge, 0.25)]] };
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [ch, 0, ch, 0] }, { ...carbon({ top: '#252d3b', bottom: '#0b0e14', wide: true }), overlays: [{ paint: { angle: 90, stops: [[0, edge, 0], [0.55, edge, 0], [1, edge, 0.24]] }, blend: 'screen' }], innerShadow: { color: '#000000', opacity: 0.4, size: 8, offset: [0, 2] }, dropShadow: { color: '#000000', opacity: 0.55, blur: 6, offset: [0, 6] } }),
          one({ kind: 'rect' }, { fill: lighten(edge, 0.2), outerGlow: { color: edge, opacity: 0.85, size: 6 } }, [ch + 4, h - 4, w - 2 * ch - 8, 2.5]),
          slash(x, paint),
          slash(x + sw * 0.85, '#f2f5f9'),
          slash(w - x - sw * 1.85, '#f2f5f9'),
          slash(w - x - sw, paint),
        ] };
      }
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        if (on) return { size: r.size, layers: [one(slanted(h), { ...candyPaint(edge, h, { depth: 2.5 }), outerGlow: { color: edge, opacity: 0.45, size: 8 } }), glint(h)] };
        return withState({ size: r.size, layers: [one(slanted(h), { ...gunmetal('#323a47', '#141920'), textures: [{ kind: 'carbon', scale: 2.4, opacity: 0.25, ramp: [[0, '#0a0d12'], [1, '#2a3240']] }], strokes: [{ width: 1.5, paint: INK, position: 'outside' }, { width: 1, paint: '#6a7688', position: 'inside', opacity: 0.6 }], dropShadow: { color: '#000000', opacity: 0.45, blur: 3, offset: [0, 3] } })] }, state, look);
      }
      case 'card':
      case 'slot': {
        // A carbon recess, its edge lit in the rarity and a soft glow of it inside (a whisper for common).
        const [top, bot] = rarityVivid(r.variant);
        const common = !isRarity(r.variant) || r.variant === 'common';
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const k = r.kind === 'slot' ? Math.min(10, w * 0.14) : 16;
        const layers: ForgeLayer[] = [
          one({ kind: 'cut', cut: [k, 0, k, 0] }, {
            ...carbon({ top: '#141a24', bottom: '#07090d', weave: 0.36 }),
            overlays: [
              { paint: { type: 'radial', center: [0.5, 0.42], scale: 1.15, stops: [[0, top, common ? 0.1 : big ? 0.36 : 0.26], [1, top, 0]] }, blend: 'screen' },
              { paint: { angle: 90, stops: [[0, top, 0], [0.75, top, 0], [1, top, common ? 0.08 : 0.22]] }, blend: 'screen' },
            ],
            innerShadow: { color: '#000000', opacity: 0.75, size: 10, offset: [0, 3] },
            // The rarity's light bleeding in from the lit edge (it also keeps the corner stripes in the 9-slice's corners).
            innerGlow: { color: top, opacity: common ? 0.06 : big ? 0.22 : 0.15, size: 14 },
            strokes: [{ width: 1.5, paint: INK, position: 'outside' }, { width: 1.6, paint: { angle: 90, stops: [[0, lighten(top, 0.45)], [1, bot]] }, position: 'inside', opacity: common ? 0.5 : 0.95 }],
            outerGlow: { color: top, opacity: common ? 0.1 : big ? 0.5 : 0.3, size: big ? 9 : 6 },
            dropShadow: { color: '#000000', opacity: 0.5, blur: 4, offset: [0, 4] },
            ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 2, size: r.kind === 'slot' ? 4 : 6, color: lighten(top, 0.6), area: 'inside' as const, opacity: 0.8 } } : {}),
          }),
        ];
        // Racing stripes across the top-left chamfer: the rarity, then a white pin-stripe.
        if (r.kind === 'card') layers.push(cornerStripe(w, h, k + 3, k + 8, { angle: 90, stops: [[0, lighten(top, 0.3)], [1, bot]] }, false), cornerStripe(w, h, k + 10, k + 12, '#f2f5f9', false));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A slanted race decal: red, a white sticker border, a dark cut line.
        return { size: r.size, slice: false, layers: [one(leaning(w, h * 0.8, 0.22), {
          fill: { angle: 90, stops: [[0, lighten(P.red, 0.35)], [0.48, lighten(P.red, 0.05)], [0.52, P.red], [1, darken(P.red, 0.35)]] },
          gloss: { style: 'glass', opacity: 0.3, height: 0.62, inset: 1.5 },
          strokes: [{ width: 4, paint: INK, position: 'outside' }, { width: 2.6, paint: '#ffffff', position: 'outside' }],
          dropShadow: { color: '#000000', opacity: 0.5, blur: 2, offset: [0, 3] },
        }, [0, h * 0.1, w, h * 0.8])] };
      case 'ribbon': {
        // A slanted banner in the colour, chequered flags at both ends.
        const k = h * 0.3;
        const fw = Math.min(h * 1.1, w * 0.18);
        const flag = (x: number): ForgeLayer => one(leaning(fw, h - 6, 0.3), { fill: '#f4f6f9', patterns: [{ kind: 'checker', color: '#0a0c10', opacity: 1, size: Math.max(3, (h - 6) / 3) }], strokes: [{ width: 1, paint: INK, position: 'outside' }] }, [x, 3, fw, h - 6]);
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [0, 1.5, 0, 1.5], slant: [k, -k] }, { ...candyPaint(edge, h, { depth: 3 }), strokes: [{ width: 1.5, paint: INK, position: 'outside' }] }),
          flag(k * 0.5 + 4),
          flag(w - k * 0.5 - 4 - fw),
        ] };
      }
      case 'barTrack':
        // A slanted recess with a lit lower lip. Bars stretch (a fill's width is the value) and a 9-slice only ever
        // stretches its middle: everything along it is uniform (segments would smear), the ends carry the shape.
        return { size: r.size, layers: [one(slanted(h, 1), {
          fill: { angle: 90, stops: [[0, '#04060a'], [1, '#121824']] },
          patterns: [{ kind: 'scanlines', color: '#2a3444', opacity: 0.55, size: Math.max(3, h * 0.16), duty: 0.3 }],
          innerShadow: { color: '#000000', opacity: 0.85, size: 4, offset: [0, 1.5] },
          rim: { width: 1.5, color: '#8fb4ff', opacity: 0.22, angle: 270 },
          strokes: [{ width: 1.5, paint: INK, position: 'outside' }, { width: 1, paint: '#3a4454', position: 'inside', opacity: 0.8 }],
        })] };
      case 'barFill': {
        // Glossy and glowing, fine LED lines along it, a white-hot leading edge at the slant (inside the end's reach).
        const col = roleColor;
        const lead = Math.min(3.5, Math.max(2.5, h * 0.15));
        const k = (h - 2) * LEAN;
        return { size: r.size, layers: [
          one(slanted(h, 1), {
            fill: { angle: 90, stops: [[0, lighten(col, 0.5)], [0.45, lighten(col, 0.1)], [0.55, col], [1, darken(col, 0.35)]] },
            patterns: [{ kind: 'scanlines', color: darken(col, 0.6), opacity: 0.2, size: Math.max(3, h * 0.16), duty: 0.3 }],
            gloss: { style: 'band', opacity: 0.3, height: 0.42, inset: 1.5, curve: 0 },
            rim: { width: 2, color: '#ffffff', opacity: 0.5, angle: 90 },
            strokes: [{ width: 1, paint: lighten(col, 0.6), position: 'inside', opacity: 0.5 }],
            outerGlow: { color: col, opacity: 0.6, size: 6 },
          }),
          one({ kind: 'polygon', points: [[k / (k + lead), 0], [1, 0], [lead / (k + lead), 1], [0, 1]] }, { fill: '#ffffff', outerGlow: { color: lighten(col, 0.4), opacity: 0.9, size: 4 } }, [w - 1.5 - k - lead, 1, k + lead, h - 2]),
        ] };
      }
      case 'pill':
        // Dark glass in a chrome rim.
        return { size: r.size, layers: [one({ kind: 'pill' }, {
          fill: { angle: 90, stops: [[0, '#1e2634', 0.96], [1, '#090c12', 0.96]] },
          textures: [{ kind: 'carbon', scale: 2.4, opacity: 0.22, ramp: [[0, '#05070a'], [1, '#232b38']] }],
          strokes: [{ width: 3.2, paint: INK, position: 'outside' }, { width: 2, paint: CHROME_EDGE, position: 'outside' }, { width: 1, paint: '#ffffff', position: 'inside', opacity: 0.1 }],
          innerShadow: { color: '#000000', opacity: 0.6, size: 6, offset: [0, 2] },
          gloss: { style: 'band', opacity: 0.1, height: 0.46, inset: 2, curve: 0 },
          dropShadow: { color: '#000000', opacity: 0.45, blur: 3, offset: [0, 3] },
        })] };
      case 'iconFrame': {
        // A gauge: a chrome bezel, a dark glass dial, ticks round it and a redline in the colour.
        const m = Math.min(w, h);
        const face = m * 0.12;
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: CHROME, bevel: { size: Math.max(1.5, m * 0.06), style: 'round', highlightOpacity: 0.55, shadowOpacity: 0.45, specular: 0.6 }, strokes: [{ width: 1.5, paint: INK, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.55, blur: 3, offset: [0, 3] } }),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.5, 0.42], stops: [[0, '#1f2836'], [1, '#05070b']] }, innerShadow: { color: '#000000', opacity: 0.85, size: Math.max(3, m * 0.08), offset: [0, 2] }, gloss: { style: 'glass', opacity: 0.12, height: 0.5, inset: 1 }, strokes: [{ width: 1, paint: INK, position: 'outside' }] }, [face, face, w - 2 * face, h - 2 * face]),
          one({ kind: 'ring', thickness: Math.max(1.5, m * 0.05) }, { fill: { type: 'conic', center: [0.5, 0.5], stops: ticks(12, 0.12, 0.88, 0.22, '#dfe6ef', 0.85) } }, [face + m * 0.04, face + m * 0.04, w - 2 * face - m * 0.08, h - 2 * face - m * 0.08]),
          one({ kind: 'ring', thickness: Math.max(1.5, m * 0.05) }, { fill: { type: 'conic', center: [0.5, 0.5], stops: [[0, edge, 0], [0.7, edge, 0], [0.7001, edge, 1], [0.86, edge, 1], [0.8601, edge, 0], [1, edge, 0]] }, outerGlow: { color: edge, opacity: 0.6, size: 3 } }, [face + m * 0.04, face + m * 0.04, w - 2 * face - m * 0.08, h - 2 * face - m * 0.08]),
        ] }, state, look);
      }
      case 'close': {
        // A slanted chrome key with a red X.
        const k = h * 0.16;
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'cut', cut: [0, 2, 0, 2], slant: [k, -k] }, candyPaint(P.chrome, h, { metal: true, brushed: true, depth: 3 })),
          one({ kind: 'cross', thickness: 0.22, radius: 0.5 }, { fill: { angle: 90, stops: [[0, '#ff5a64'], [1, '#c80a1e']] }, strokes: [{ width: 1.5, paint: INK, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.4, blur: 0.5, offset: [0, 1] } }, [w * 0.27, h * 0.2, w * 0.46, h * 0.56]),
        ] }, state, look);
      }
      case 'title': {
        // Heavy italic chrome type, outlined dark then in the colour, a glow, a dark base, and a speed trail behind.
        const text = (r.text ?? 'GARAGE').toUpperCase();
        const t: Extract<ShapeSpec, { kind: 'text' }> = { kind: 'text', text, font: 'Sarpanch', weight: 700, italic: true, tracking: 0.02 };
        // Room on the left for the trail (the italic leans the type right: the box sits left of centre).
        const box: [number, number, number, number] = [w * 0.07, 0, w * 0.93 - h * 0.14, h * 0.9];
        // Where the type lands (as big as fits, centred): the trail runs into its first letters, however wide the box.
        let x0 = Infinity;
        for (const c of textContours(t, ...box).contours) for (const p of c) x0 = Math.min(x0, p[0]);
        if (!Number.isFinite(x0)) x0 = box[0];
        const o = Math.max(3, h * 0.07);
        const ghost = (dx: number, alpha: number): ForgeLayer => one(t, { fill: edge, fillOpacity: alpha }, [box[0] - dx, box[1], box[2], box[3]]);
        const reach = Math.min(w * 0.36, h * 2.6);
        const lines: ForgeLayer[] = ([[0.26, 0.8, edge], [0.47, 1, '#ffffff'], [0.66, 0.7, edge]] as Array<[number, number, Color]>).map(([y, k, c]) => {
          const len = reach * k;
          const x = Math.max(0, x0 - len * 0.8);
          return one({ kind: 'polygon', points: [[0, 0.5], [1, 0], [1, 1]] }, { fill: { angle: 0, stops: [[0, c, 0], [0.7, c, 0.6], [1, c, 0.9]] }, outerGlow: { color: edge, opacity: 0.35, size: 3 } }, [x, h * y, x0 + len * 0.2 - x, Math.max(2, h * 0.045)]);
        });
        return { size: r.size, slice: false, layers: [
          ...lines,
          ghost(o * 3.4, 0.22),
          ghost(o * 1.9, 0.42),
          one(t, {
            fill: { angle: 90, stops: [[0, '#ffffff'], [0.45, '#dfe5ee'], [0.5, '#7d8899'], [0.62, '#b8c2cf'], [1, '#f4f7fa']] },
            bevel: { size: Math.max(1, h * 0.02), style: 'chisel', highlightOpacity: 0.5, shadowOpacity: 0.35 },
            strokes: [{ width: Math.max(3.5, h * 0.07), paint: { angle: 90, stops: [[0, lighten(edge, 0.25)], [1, darken(edge, 0.15)]] }, position: 'outside' }, { width: Math.max(2, h * 0.035), paint: INK, position: 'outside' }],
            extrude: { depth: Math.max(2.5, h * 0.05), color: darken(edge, 0.55), stroke: { width: 1.5, color: INK } },
            outerGlow: { color: edge, opacity: 0.55, size: Math.max(6, h * 0.12) },
            dropShadow: { color: '#000000', opacity: 0.6, blur: 3, offset: [0, Math.max(4, h * 0.08)] },
          }, box),
        ] };
      }
      case 'divider':
        // A speed-line streak: the colour fading in, a white-hot core.
        return { size: r.size, layers: [
          one({ kind: 'rect', radius: h / 2 }, { fill: { angle: 0, stops: [[0, edge, 0], [0.3, edge, 0.85], [0.7, edge, 0.85], [1, edge, 0]] }, outerGlow: { color: edge, opacity: 0.45, size: 4 } }),
          one({ kind: 'rect', radius: h / 4 }, { fill: { angle: 0, stops: [[0, '#ffffff', 0], [0.4, '#ffffff', 0.95], [0.85, '#ffffff', 0.6], [1, '#ffffff', 0]] } }, [w * 0.12, h * 0.33, w * 0.76, h * 0.34]),
        ] };
      case 'tooltip':
        return { size: r.size, layers: [
          one({ kind: 'cut', cut: [10, 0, 10, 0] }, { ...carbon({ alpha: 0.95, wide: true }), dropShadow: { color: '#000000', opacity: 0.55, blur: 5, offset: [0, 5] } }),
          one(leaning(4, Math.max(6, h - 20), 0.25), { fill: edge, outerGlow: { color: edge, opacity: 0.8, size: 4 } }, [1, 10, 4, Math.max(6, h - 20)]),
        ] };
      case 'icon': {
        // Candy paint over the glyph's silhouette, a chrome edge, a hard specular streak, its lines cut darker.
        const col = isRarity(r.variant) ? rarityVivid(r.variant)[0] : roleColor;
        const glow = isRarity(r.variant) && r.variant !== 'common' ? rarityVivid(r.variant)[1] : role !== 'primary' || accent ? col : null;
        const k = Math.max(0.6, Math.min(1.4, Math.min(w, h) / 64));
        const g = r.glyph ?? 'gauge';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3, solid: true }, {
            fill: { angle: 90, stops: [[0, lighten(col, 0.55)], [0.47, lighten(col, 0.12)], [0.53, col], [1, darken(col, 0.42)]] },
            gloss: { style: 'glass', opacity: 0.35, height: 0.6, inset: 1 },
            bevel: { size: 1.6 * k, style: 'round', highlightOpacity: 0.45, shadowOpacity: 0.4, specular: 0.8 },
            strokes: [{ width: 3.2 * k, paint: INK, position: 'outside' }, { width: 1.8 * k, paint: CHROME_EDGE, position: 'outside' }],
            ...(glow ? { outerGlow: { color: glow, opacity: 0.5, size: 7 * k } } : {}),
            dropShadow: { color: '#000000', opacity: 0.55, blur: 1.5 * k, offset: [0, 3 * k] },
          }),
          one({ kind: 'glyph', name: g, weight: 1.6 }, { fill: darken(col, 0.62), fillOpacity: 0.75 }),
        ] };
      }
      case 'coin':
        // A chrome rim round a gold face, the glyph struck into it.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: CHROME, bevel: { size: Math.max(1, w * 0.07), style: 'round', highlightOpacity: 0.55, shadowOpacity: 0.45, specular: 0.6 }, strokes: [{ width: Math.max(1, w * 0.035), paint: INK, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.5, blur: 1, offset: [0, Math.max(1, h * 0.05)] } }),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.32], scale: 1.1, stops: [[0, '#fff3b8'], [0.5, '#ffc21f'], [1, '#b86a00']] }, bevel: { size: Math.max(0.8, w * 0.05), style: 'round', highlightOpacity: 0.5, shadowOpacity: 0.4, specular: 0.5 }, strokes: [{ width: Math.max(0.6, w * 0.02), paint: '#5a3200', position: 'outside', opacity: 0.8 }] }, [w * 0.13, h * 0.13, w * 0.74, h * 0.74]),
          one({ kind: 'glyph', name: r.glyph ?? 'zap', weight: 2.6, solid: true }, { fill: { angle: 90, stops: [[0, '#fff8d8'], [1, '#e89a0a']] }, bevel: { size: Math.max(0.6, w * 0.03), style: 'chisel', highlightOpacity: 0.6, shadowOpacity: 0.45 }, strokes: [{ width: Math.max(0.6, w * 0.025), paint: '#6a3c00', position: 'outside' }] }, [w * 0.28, h * 0.27, w * 0.44, h * 0.44]),
        ] };
    }
  },
};
