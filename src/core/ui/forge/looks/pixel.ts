import type { ForgeLayer, ForgeSpec } from '../forge';
import { isRarity, one, roleOf, withState, type Direction } from '../kit';
import type { Color, Gradient, LayerStyle } from '../style';

/**
 * Pixel: retro 8-bit (platformers, arcade and roguelike games, retro tycoons): drawn one art pixel per three design
 * points with hard edges and scaled up nearest-neighbour, stair-stepped corners, one-pixel black outlines, one-pixel
 * light and shadow bevels, hard drop shadows, a 16-colour palette, dithered gradients and Press Start 2P type.
 */

/** Design points per art pixel. */
const PX = 3;
/** Sweetie 16. */
const P = { black: '#1a1c2c', plum: '#5d275d', red: '#b13e53', orange: '#ef7d57', yellow: '#ffcd75', lime: '#a7f070', green: '#38b764', teal: '#257179', navy: '#29366f', blue: '#3b5dc9', sky: '#41a6f6', cyan: '#73eff7', white: '#f4f4f4', grey: '#94b0c2', slate: '#566c86', dark: '#333c57' };
const RAR: Record<string, Color> = { common: P.grey, rare: P.sky, epic: '#b55af0', legendary: P.yellow, mythic: P.red };

const px = (spec: ForgeSpec, _flat = true): ForgeSpec => ({ ...spec, pixel: { size: PX } });
/** Hard colour bands (pixel art has no smooth gradients): each colour from its stop to the next. */
const bands = (...cs: Array<[number, Color]>): Gradient => ({ angle: 90, stops: cs.flatMap(([t, c], i) => { const next = cs[i + 1]?.[0] ?? 1; return [[t, c], [Math.max(t, next - 0.0001), c]] as Array<[number, Color]>; }) });

/** A chunky pixel block: flat colour, a 1-pixel light top-left and dark bottom-right bevel, a black outline. */
const block = (c: Color, o: { base?: boolean; shadow?: boolean; light?: Color } = {}): LayerStyle => ({
  fill: c,
  rim: { width: PX, color: o.light ?? '#ffffff', opacity: 0.45, angle: 135, hard: true, shade: '#000000', shadeOpacity: 0.35 },
  strokes: [{ width: PX, paint: P.black, position: 'outside' }],
  ...(o.base !== false ? { extrude: { depth: PX, color: P.black } } : {}),
  ...(o.shadow !== false ? { dropShadow: { color: '#000000', opacity: 0.45, blur: 0, offset: [PX, PX * (o.base !== false ? 2 : 1)] } } : {}),
});

const stairs = (steps = 1): ForgeLayer['shape'] => ({ kind: 'stairs', step: PX, steps });

export const pixel: Direction = {
  id: 'pixel',
  label: 'Pixel (retro 8-bit)',
  for: 'retro, arcade, platformer, roguelike and 8-bit tycoon games: hard-edged pixel art at 3 points per pixel, stair-step corners, one-pixel outlines and bevels, a 16-colour palette with dithered gradients, Press Start 2P',
  palette: P,
  fonts: { display: 'PressStart2P', body: 'PressStart2P' },
  backdrop: '#5c94fc',
  text: {
    color: P.white,
    stroke: P.black,
    strokePx: 2,
    onButton: P.white,
    onButtonStroke: P.black,
    title: { color: P.yellow, stroke: P.black, strokePx: 3, font: 'PressStart2P', minSize: 16 },
    button: { color: P.white, stroke: P.black, strokePx: 3, font: 'PressStart2P', minSize: 8 },
    tabOn: { color: P.black, font: 'PressStart2P', minSize: 8 },
    tabOff: { color: P.white, stroke: P.black, strokePx: 2, font: 'PressStart2P', minSize: 8 },
    onCard: { color: P.white, stroke: P.black, strokePx: 2, font: 'PressStart2P', minSize: 8 },
    onPill: { color: P.white, stroke: P.black, strokePx: 2, font: 'PressStart2P', minSize: 8 },
    muted: { color: P.grey, font: 'PressStart2P', minSize: 8 },
    disabled: { color: P.grey, stroke: P.black, strokePx: 2, font: 'PressStart2P', minSize: 8 },
    buttons: {
      primary: { color: P.white, stroke: P.black, strokePx: 3, font: 'PressStart2P', minSize: 8 },
      secondary: { color: P.white, stroke: P.black, strokePx: 3, font: 'PressStart2P', minSize: 8 },
      danger: { color: P.white, stroke: P.black, strokePx: 3, font: 'PressStart2P', minSize: 8 },
      success: { color: P.black, font: 'PressStart2P', minSize: 8 },
      premium: { color: P.black, font: 'PressStart2P', minSize: 8 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: PX, ring: P.white, grey: P.slate, greyMix: 0.5 };
    const s = (spec: ForgeSpec) => withState(px(spec), state, look);
    switch (r.kind) {
      case 'button': {
        const c = role === 'secondary' ? P.blue : role === 'danger' ? P.red : role === 'success' ? P.lime : role === 'premium' ? P.yellow : (accent ?? P.green);
        return s({ size: r.size, layers: [one(stairs(1), block(c))] });
      }
      case 'window': {
        // A classic dialog: deep blue dithered down, a white rule inside a black outline, a grey inner rule.
        return px({ size: r.size, content: [PX * 5, PX * 5, w - PX * 10, h - PX * 10], layers: [
          one(stairs(2), { fill: bands([0, accent ?? P.blue], [0.07, P.navy]), strokes: [{ width: PX, paint: P.black, position: 'outside' }, { width: PX, paint: P.white, position: 'inside' }], dropShadow: { color: '#000000', opacity: 0.5, blur: 0, offset: [PX * 2, PX * 2] } }),
          one(stairs(1), { fill: '#000000', fillOpacity: 0, strokes: [{ width: PX, paint: P.grey, position: 'inside' }] }, [PX * 2, PX * 2, w - PX * 4, h - PX * 4]),
          // The dialog's 'more' cursor.
          one({ kind: 'polygon', points: [[0, 0], [1, 0], [0.5, 1]] }, { fill: P.white, strokes: [{ width: PX, paint: P.black, position: 'outside' }] }, [w - PX * 10, h - PX * 8, PX * 5, PX * 3]),
        ] }, true);
      }
      case 'header':
        return px({ size: r.size, layers: [one(stairs(1), { ...block(accent ?? P.red), fill: bands([0, P.orange], [0.45, accent ?? P.red]) })] }, true);
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        return withState(px({ size: r.size, layers: [one(stairs(1), block(on ? P.yellow : P.slate, { base: on }))] }), state === 'selected' ? 'normal' : state, look);
      }
      case 'card':
      case 'slot': {
        const c = RAR[r.variant ?? 'common'] ?? P.grey;
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const layers: ForgeLayer[] = [
          one(stairs(1), { fill: P.dark, strokes: [{ width: PX, paint: P.black, position: 'outside' }, { width: PX, paint: c, position: 'inside' }, ...(big ? [{ width: PX * 2, paint: P.white, position: 'inside' as const, opacity: 0.18 }] : [])], rim: { width: PX * 2, color: '#ffffff', opacity: 0, angle: 135, hard: true, shade: '#000000', shadeOpacity: 0.25 }, dropShadow: { color: '#000000', opacity: 0.45, blur: 0, offset: [PX, PX] } }),
        ];
        if (r.kind === 'card') layers.push(one({ kind: 'rect' }, { fill: c }, [PX * 2, PX * 2, w - PX * 4, PX * 2]));
        return withState(px({ size: r.size, layers }, true), state, look);
      }
      case 'badge':
        return px({ size: r.size, slice: false, layers: [one({ kind: 'star', points: 5, inner: 0.5, round: 0 }, block(P.yellow, { base: false }))] });
      case 'ribbon':
        return px({ size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.35 }, block(accent ?? P.red))] });
      case 'barTrack':
        return px({ size: r.size, layers: [one({ kind: 'rect' }, { fill: P.black, strokes: [{ width: PX, paint: P.white, position: 'inside' }, { width: PX, paint: P.black, position: 'outside' }] })] });
      case 'barFill': {
        const c = role === 'danger' ? P.red : role === 'premium' ? P.yellow : role === 'secondary' ? P.sky : (accent ?? P.green);
        return px({ size: r.size, layers: [one({ kind: 'rect' }, { fill: c, rim: { width: PX, color: '#ffffff', opacity: 0.5, angle: 90, hard: true, shade: '#000000', shadeOpacity: 0.3 } })] });
      }
      case 'pill':
        return px({ size: r.size, layers: [one(stairs(1), { fill: P.black, strokes: [{ width: PX, paint: P.white, position: 'inside' }, { width: PX, paint: P.black, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.45, blur: 0, offset: [PX, PX] } })] });
      case 'iconFrame':
        return withState(px({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { ...block(P.dark), fill: P.dark, strokes: [{ width: PX, paint: P.black, position: 'outside' }, { width: PX, paint: P.grey, position: 'inside' }] })] }, true), state, look);
      case 'close':
        return withState(px({ size: r.size, slice: false, layers: [one(stairs(1), block(P.red)), one({ kind: 'cross', thickness: 0.22, radius: 0 }, { fill: P.white, strokes: [{ width: PX, paint: P.black, position: 'outside' }] }, [w * 0.26, h * 0.2, w * 0.48, h * 0.52])] }), state, look);
      case 'title': {
        const text = (r.text ?? 'PLAY').toUpperCase();
        return px({ size: r.size, slice: false, layers: [one({ kind: 'text', text, font: 'PressStart2P', snap: 8 }, {
          fill: bands([0, P.white], [0.3, P.yellow], [0.62, P.orange]),
          strokes: [{ width: PX, paint: P.black, position: 'outside' }],
          extrude: { depth: PX * 2, color: P.red, stroke: { width: PX, color: P.black } },
          dropShadow: { color: '#000000', opacity: 0.5, blur: 0, offset: [PX, PX * 3] },
        })] }, true);
      }
      case 'divider':
        return px({ size: r.size, layers: [one({ kind: 'rect' }, { fill: P.white, dropShadow: { color: P.black, opacity: 1, blur: 0, offset: [0, PX] } })] });
      case 'tooltip':
        return px({ size: r.size, layers: [one(stairs(1), { fill: P.white, strokes: [{ width: PX, paint: P.black, position: 'outside' }, { width: PX, paint: P.grey, position: 'inside' }], dropShadow: { color: '#000000', opacity: 0.5, blur: 0, offset: [PX, PX] } })] });
      case 'icon': {
        const c = isRarity(r.variant) ? RAR[r.variant]! : role === 'danger' ? P.red : role === 'secondary' ? P.sky : (accent ?? P.yellow);
        const g = r.glyph ?? 'star';
        return px({ size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 2.4, solid: true }, { fill: c, rim: { width: PX, color: '#ffffff', opacity: 0.55, angle: 135, hard: true, shade: '#000000', shadeOpacity: 0.3 }, strokes: [{ width: PX, paint: P.black, position: 'outside' }], dropShadow: { color: '#000000', opacity: 0.4, blur: 0, offset: [PX, PX] } }),
          one({ kind: 'glyph', name: g, weight: 2 }, { fill: P.black, fillOpacity: 0.55 }),
        ] });
      }
      case 'coin':
        return px({ size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: P.yellow, rim: { width: PX, color: '#ffffff', opacity: 0.6, angle: 135, hard: true, shade: P.orange, shadeOpacity: 0.8 }, strokes: [{ width: PX, paint: P.black, position: 'outside' }] }),
          ...(w >= PX * 10 ? [one({ kind: 'rect' }, { fill: P.orange }, [w / 2 - PX / 2, h * 0.28, PX, h * 0.44])] : []),
        ] });
    }
  },
};
