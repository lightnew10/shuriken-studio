import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle, StrokeStyle } from '../style';

/**
 * Kawaii: soft pastel cute (pet cafés, dress-up, virtual pets, bakeries, cozy roleplay): marshmallow pastels with a
 * plum line and a white sticker border round everything, puffy cloud windows with polka dots, heart badges, big soft
 * shines and sparkles, rounded type with a pink outline.
 */

const P = { pink: '#ff9ecf', pink2: '#ff6fb1', lavender: '#c6a6ff', mint: '#8eeccc', peach: '#ffc29a', butter: '#ffea8a', sky: '#9ed6ff', cream: '#fff8f2', berry: '#ec5a9a', plum: '#7a3a6a', white: '#ffffff' };
const RAR: Record<string, Color> = { common: '#d8d4e4', rare: P.sky, epic: P.lavender, legendary: P.butter, mythic: P.pink };

/** The sticker edge: a plum line inside a white border. */
const sticker = (plum = 2.5, white = 4.5): StrokeStyle[] => [{ width: plum + white, paint: P.white, position: 'outside' }, { width: plum, paint: P.plum, position: 'outside' }];

/** Marshmallow: a soft pastel gradient, a big soft shine, a gentle bevel, the sticker edge and a soft pink shadow. */
const mallow = (base: Color, h: number, o: { depth?: number; dots?: boolean } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.35)], [0.55, base], [1, darken(base, 0.06)]] },
  ...(o.dots ? { patterns: [{ kind: 'dots' as const, color: '#ffffff', opacity: 0.4, size: Math.max(10, h * 0.32), duty: 0.16 }] } : {}),
  bevel: { size: Math.max(3, h * 0.14), style: 'pillow', highlightOpacity: 0.45, shadowOpacity: 0.18 },
  gloss: { style: 'arc', opacity: 0.6, height: 0.42, inset: 3.5, curve: 0.6 },
  rim: { width: Math.max(3, h * 0.12), opacity: 0, shade: darken(base, 0.2), shadeOpacity: 0.35 },
  strokes: sticker(),
  extrude: { depth: o.depth ?? Math.max(3, Math.min(5, h * 0.08)), color: darken(base, 0.18), stroke: { width: 7, color: P.white } },
  dropShadow: { color: P.berry, opacity: 0.28, blur: 5, offset: [0, (o.depth ?? Math.max(3, Math.min(5, h * 0.08))) + 4] },
});

export const kawaii: Direction = {
  id: 'kawaii',
  label: 'Kawaii (pastel cute)',
  for: 'pet cafés, dress-up, virtual pets, bakeries, cozy roleplay and cute collectibles: marshmallow pastels with a plum line and white sticker border, puffy cloud windows with polka dots, heart badges, soft shines and sparkles',
  palette: P,
  fonts: { display: 'FredokaOne', body: 'BuilderSans', weightBody: 800 },
  backdrop: '#ffd6ea',
  text: {
    color: P.plum,
    strokePx: 2.5,
    onButton: '#ffffff',
    onButtonStroke: '#4a1840',
    title: { color: '#ffffff', stroke: P.berry, strokePx: 3, font: 'FredokaOne', minSize: 22 },
    button: { color: '#ffffff', stroke: '#4a1840', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    tabOn: { color: '#ffffff', stroke: '#4a1840', strokePx: 2, font: 'BuilderSans', weight: 800 },
    tabOff: { color: '#6a2a5a', font: 'BuilderSans', weight: 800 },
    onCard: { color: '#5e2452', font: 'BuilderSans', weight: 800 },
    onPill: { color: '#5e2452', font: 'FredokaOne', minSize: 18 },
    muted: { color: '#8a4a7a', font: 'BuilderSans', weight: 700 },
    disabled: { color: '#ffffff', stroke: '#6e6476', strokePx: 2, font: 'BuilderSans', weight: 800 },
    buttons: {
      primary: { color: '#ffffff', stroke: '#4a1840', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      secondary: { color: '#ffffff', stroke: '#2a1a50', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      danger: { color: '#ffffff', stroke: '#4a1028', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      success: { color: '#ffffff', stroke: '#0a3a2a', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      premium: { color: '#ffffff', stroke: '#4a2a08', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 3, ring: P.butter, grey: '#d8d0dc', greyMix: 0.5 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const pink = accent ?? P.pink2;
    switch (r.kind) {
      case 'button': {
        const base = role === 'secondary' ? '#9a84f0' : role === 'danger' ? '#f2545b' : role === 'success' ? '#4fd8a8' : role === 'premium' ? '#ffc93a' : pink;
        const face = mallow(base, h, { dots: true });
        face.sparkles = { count: role === 'premium' ? 3 : 1, size: Math.min(7, h * 0.15), area: 'inside' };
        return s({ size: r.size, layers: [one({ kind: 'pill' }, face)] });
      }
      case 'window': {
        // A puffy pink cloud with a cream polka-dot panel inside, hearts floating in the corners.
        const t = 20;
        return { size: r.size, content: [t + 12, t + 12, w - 2 * t - 24, h - 2 * t - 24], layers: [
          one({ kind: 'puffy', bump: 22 }, { ...mallow(accent ?? P.pink, 80, { depth: 6 }), gloss: { style: 'band', opacity: 0.35, height: 0.06, inset: 6, curve: 0 }, patterns: [{ kind: 'hearts', color: '#ffffff', opacity: 0.35, size: 34, duty: 0.4 }], dropShadow: { color: P.berry, opacity: 0.3, blur: 16, offset: [0, 14] } }),
          one({ kind: 'rect', radius: 26 }, { fill: { angle: 90, stops: [[0, '#ffffff'], [1, P.cream]] }, patterns: [{ kind: 'dots', color: '#ffd6ea', opacity: 0.7, size: 22, duty: 0.14 }], innerShadow: { color: P.berry, opacity: 0.18, size: 12, offset: [0, 5] }, strokes: [{ width: 2.5, paint: P.plum, position: 'outside', opacity: 0.6 }] }, [t + 6, t + 6, w - 2 * t - 12, h - 2 * t - 12]),
          ...[[6, 8, 26, -14], [w - 30, h - 36, 24, 12]].map(([x, y, sz, rot]) => one({ kind: 'heart' }, { fill: { angle: 90, stops: [[0, '#ffc2de'], [1, P.pink2]] }, gloss: { style: 'spot', opacity: 0.7, height: 0.5 }, strokes: sticker(2, 3), dropShadow: { color: P.berry, opacity: 0.3, blur: 2, offset: [0, 3] } }, [x!, y!, sz!, sz! * 0.9])),
          // A bow on top.
          one({ kind: 'polygon', points: [[0, 0.1], [0.5, 0.45], [0.5, 0.55], [0, 0.95]], round: 14 }, { ...mallow(P.pink2, 40, { depth: 2 }), strokes: sticker(2, 3) }, [w / 2 - 52, -22, 52, 44]),
          one({ kind: 'polygon', points: [[1, 0.1], [0.5, 0.45], [0.5, 0.55], [1, 0.95]], round: 14 }, { ...mallow(P.pink2, 40, { depth: 2 }), strokes: sticker(2, 3) }, [w / 2, -22, 52, 44]),
          one({ kind: 'ellipse' }, { ...mallow('#ff4f9a', 20, { depth: 1.5 }), strokes: sticker(2, 3) }, [w / 2 - 11, -11, 22, 22]),
        ] };
      }
      case 'header':
        // A marshmallow band with a heart at each end.
        return { size: r.size, layers: [
          one({ kind: 'rect', radius: Math.min(30, h * 0.45) }, mallow(accent ?? P.lavender, h, { depth: 4 })),
          ...[Math.min(26, h * 0.4) - Math.min(20, h * 0.36) / 2, w - Math.min(26, h * 0.4) - Math.min(20, h * 0.36) / 2].map((x) => one({ kind: 'heart' }, { fill: { angle: 90, stops: [[0, '#ffc2de'], [1, P.pink2]] }, gloss: { style: 'spot', opacity: 0.7, height: 0.5 }, strokes: sticker(1.8, 2.5) }, [x, h * 0.32, Math.min(20, h * 0.36), Math.min(18, h * 0.32)])),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        return withState({ size: r.size, layers: [one({ kind: 'pill' }, on ? { ...mallow(pink, h), sparkles: { count: 1, size: 5, area: 'inside' as const } } : { ...mallow('#f6ecff', h, { depth: 3 }), strokes: sticker(2, 3.5) })] }, state === 'selected' ? 'normal' : state, look);
      }
      case 'card':
      case 'slot': {
        const c = RAR[r.variant ?? 'common'] ?? RAR.common!;
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const layers: ForgeLayer[] = [one({ kind: 'rect', radius: r.kind === 'slot' ? Math.min(22, w * 0.28) : 26 }, {
          ...mallow(c, Math.min(h, 80), { depth: 4 }),
          fill: { type: 'radial', center: [0.5, 0.35], scale: 1.2, stops: [[0, '#ffffff'], [0.55, lighten(c, 0.35)], [1, c]] },
          patterns: [{ kind: big ? 'stars' : 'dots', color: '#ffffff', opacity: 0.6, size: big ? 22 : 16, duty: big ? 0.45 : 0.14 }],
          gloss: { style: 'arc', opacity: 0.45, height: 0.4, inset: 5, curve: 0.5 },
          ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 7, area: 'inside' as const } } : {}),
        })];
        if (r.kind === 'card') layers.push(one({ kind: 'heart' }, { fill: { angle: 90, stops: [[0, '#ffc2de'], [1, P.pink2]] }, gloss: { style: 'spot', opacity: 0.7, height: 0.5 }, strokes: sticker(1.8, 2.5) }, [w - 26, 6, 18, 16]));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        return { size: r.size, slice: false, layers: [one({ kind: 'heart' }, { fill: { angle: 90, stops: [[0, '#ff9ac4'], [1, '#ff4f8a']] }, bevel: { size: Math.max(2, h * 0.1), style: 'pillow', highlightOpacity: 0.4, shadowOpacity: 0.2 }, gloss: { style: 'spot', opacity: 0.85, height: 0.5 }, strokes: sticker(2, 3), dropShadow: { color: P.berry, opacity: 0.3, blur: 2, offset: [0, 3] } })] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.36 }, { ...mallow(accent ?? P.pink2, h, { depth: 3 }) })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: '#fbe6f2', innerShadow: { color: P.berry, opacity: 0.3, size: 5, offset: [0, 2] }, strokes: sticker(2, 3) })] };
      case 'barFill': {
        const base = role === 'danger' ? '#f2545b' : role === 'premium' ? '#ffc93a' : role === 'secondary' ? '#9a84f0' : role === 'success' ? '#4fd8a8' : pink;
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, lighten(base, 0.4)], [0.55, base], [1, darken(base, 0.05)]] }, gloss: { style: 'band', opacity: 0.55, height: 0.45, inset: 2, curve: 0 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 90, stops: [[0, '#ffffff'], [1, '#fff0f8']] }, bevel: { size: 3, style: 'pillow', highlightOpacity: 0.3, shadowOpacity: 0.12 }, strokes: sticker(2.5, 3.5), dropShadow: { color: P.berry, opacity: 0.25, blur: 4, offset: [0, 4] } })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'puffy', bump: Math.max(5, w * 0.12) }, { ...mallow(accent ?? P.mint, h, { depth: 3 }), fill: { type: 'radial', center: [0.5, 0.4], stops: [[0, '#ffffff'], [0.6, lighten(accent ?? P.mint, 0.3)], [1, accent ?? P.mint]] } })] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, mallow('#ff7aa8', h, { depth: 3 })), one({ kind: 'cross', thickness: 0.22 }, { fill: '#ffffff', strokes: [{ width: 2, paint: P.plum, position: 'outside' }] }, [w * 0.27, h * 0.22, w * 0.46, h * 0.5])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'Cute', font: 'FredokaOne' }, {
          fill: { angle: 90, stops: [[0, '#ffffff'], [1, '#ffe8f4']] },
          strokes: [{ width: 9, paint: P.white, position: 'outside' }, { width: 6.5, paint: P.plum, position: 'outside' }, { width: 4.5, paint: { angle: 90, stops: [[0, '#ff9ecf'], [1, '#ff5fa8']] }, position: 'outside' }],
          extrude: { depth: 5, color: '#e85a9a', stroke: { width: 9, color: P.white } },
          gloss: { style: 'arc', opacity: 0.4, height: 0.5, inset: 1.5 },
          sparkles: { count: 4, size: Math.max(6, h * 0.11), area: 'around', color: '#ffffff', glow: 0.5 },
          dropShadow: { color: P.berry, opacity: 0.3, blur: 4, offset: [0, 9] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: '#ffb8d8' })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'puffy', bump: Math.min(14, h * 0.18) }, { fill: { angle: 90, stops: [[0, '#ffffff'], [1, '#fff0f8']] }, patterns: [{ kind: 'dots', color: '#ffd6ea', opacity: 0.7, size: 16, duty: 0.14 }], strokes: sticker(2.5, 3.5), dropShadow: { color: P.berry, opacity: 0.28, blur: 5, offset: [0, 6] } })] };
      case 'icon': {
        const c = isRarity(r.variant) ? (RAR[r.variant] ?? P.pink) : role === 'danger' ? '#f2545b' : (accent ?? P.pink);
        const g = r.glyph ?? 'heart';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3.2, solid: true }, { fill: { angle: 90, stops: [[0, '#ffffff'], [0.5, lighten(c, 0.25)], [1, c]] }, bevel: { size: 2, style: 'pillow', highlightOpacity: 0.4, shadowOpacity: 0.2 }, gloss: { style: 'arc', opacity: 0.4, height: 0.45, inset: 1.5 }, strokes: sticker(2.2, 3.5), dropShadow: { color: P.berry, opacity: 0.3, blur: 2, offset: [0, 3.5] } }),
          one({ kind: 'glyph', name: g, weight: 1.8 }, { fill: P.plum, fillOpacity: 0.65 }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.4, 0.35], stops: [[0, '#ffe0f0'], [1, '#ff6fb1']] }, bevel: { size: Math.max(1.5, w * 0.1), style: 'pillow', highlightOpacity: 0.5, shadowOpacity: 0.2 }, gloss: { style: 'spot', opacity: 0.6, height: 0.5 }, strokes: [{ width: Math.max(2, w * 0.1), paint: P.white, position: 'outside' }, { width: Math.max(1, w * 0.045), paint: P.plum, position: 'outside' }] }),
          one(r.glyph && r.glyph !== 'heart' ? { kind: 'glyph', name: r.glyph, weight: 3, solid: true } : { kind: 'heart' }, { fill: '#ffffff', dropShadow: { color: P.plum, opacity: 0.3, blur: 0.5, offset: [0, Math.max(0.6, h * 0.025)] } }, [w * 0.28, h * 0.29, w * 0.44, h * 0.42]),
        ] };
    }
  },
};
