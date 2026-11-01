import type { ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityOf, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle } from '../style';

/**
 * Candy: the chunky glossy simulator look (Pet Simulator, Adopt Me): thick ink outlines round everything, saturated
 * plastic with a crisp top-half shine and a 3D base, cream panels inside glossy coloured frames, sticker icons.
 */

const INK = '#2b1b47';
const P = { ink: INK, panel: '#fff7e8', panel2: '#ffe6c0', primary: '#3ddc6c', secondary: '#41b0ff', danger: '#ff4d61', success: '#3ddc6c', premium: '#ffc93c', accent: '#ff7ab8', frame: '#8a5cff', tabOff: '#d6c9f2' };

/** Glossy plastic: gradient, a crisp shine band, a darker inner bottom, an ink outline and a base under it. */
const plastic = (base: Color, h: number, o: { depth?: number; radius?: number; ink?: number; shine?: number } = {}): LayerStyle => {
  const depth = o.depth ?? Math.max(4, Math.min(8, h * 0.11));
  return {
    fill: { angle: 90, stops: [[0, lighten(base, 0.25)], [0.48, base], [1, darken(base, 0.12)]] },
    extrude: { depth, color: { angle: 90, stops: [[0, darken(base, 0.35)], [1, darken(base, 0.5)]] }, stroke: { width: o.ink ?? 3, color: INK } },
    strokes: [{ width: o.ink ?? 3, paint: INK, position: 'outside' }, { width: 1.5, paint: lighten(base, 0.6), position: 'inside', opacity: 0.55 }],
    gloss: { style: 'band', opacity: o.shine ?? 0.42, height: 0.5, inset: 3, curve: 0.12 },
    rim: { width: Math.max(3, h * 0.12), angle: 90, opacity: 0, shade: darken(base, 0.4), shadeOpacity: 0.4, falloff: 2 },
    dropShadow: { color: '#1a0e30', opacity: 0.28, blur: 2.5, offset: [0, depth + 2.5] },
  };
};

export const candy: Direction = {
  id: 'candy',
  label: 'Candy (chunky glossy simulator)',
  for: 'simulators, pet collecting, tycoons, obbies, kid-friendly games: thick ink outlines, glossy saturated buttons with a 3D base, cream panels in glossy frames, sticker icons',
  palette: P,
  fonts: { display: 'FredokaOne', body: 'BuilderSans', weightBody: 800 },
  backdrop: '#6fb8f0',
  text: {
    color: INK,
    strokePx: 2.5,
    onButton: '#ffffff',
    onButtonStroke: INK,
    title: { color: '#ffffff', stroke: INK, strokePx: 3, font: 'LuckiestGuy', minSize: 22 },
    button: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    tabOn: { color: '#ffffff', stroke: INK, strokePx: 2, font: 'BuilderSans', weight: 800 },
    tabOff: { color: '#45366e', font: 'BuilderSans', weight: 800 },
    onCard: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'BuilderSans', weight: 800 },
    onPill: { color: '#ffffff', stroke: INK, strokePx: 1.5, font: 'FredokaOne', minSize: 18 },
    muted: { color: '#5e4e80', font: 'BuilderSans', weight: 700 },
    disabled: { color: '#f4f2f8', stroke: '#4e4860', strokePx: 2, font: 'BuilderSans', weight: 800 },
    buttons: {
      primary: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      secondary: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      danger: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      success: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      premium: { color: '#ffffff', stroke: INK, strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const s = (spec: ForgeSpec) => withState(spec, state, { press: 3, grey: '#c4bdd0', greyMix: 0.45 });
    switch (r.kind) {
      case 'button': {
        const base = role === 'secondary' ? P.secondary : role === 'danger' ? P.danger : role === 'premium' ? P.premium : role === 'success' ? P.success : (accent ?? P.primary);
        const face = plastic(base, h);
        if (role === 'premium') face.sparkles = { count: 2, size: Math.min(7, h * 0.16), area: 'inside', opacity: 0.9 };
        return s({ size: r.size, layers: [one({ kind: 'rect', radius: Math.min(h * 0.34, 18) }, face)] });
      }
      case 'window': {
        // A glossy coloured frame round a cream inner panel: the layered window of a polished simulator.
        const frame = accent ?? P.frame;
        const t = 16;
        return { size: r.size, content: [t + 6, t + 6, w - 2 * t - 12, h - 2 * t - 12], layers: [
          one({ kind: 'rect', radius: 34 }, {
            fill: { angle: 90, stops: [[0, lighten(frame, 0.25)], [0.5, frame], [1, darken(frame, 0.18)]] },
            strokes: [{ width: 4, paint: INK, position: 'outside' }, { width: 2.5, paint: lighten(frame, 0.55), position: 'inside', opacity: 0.6 }],
            extrude: { depth: 10, color: darken(frame, 0.45), stroke: { width: 4, color: INK } },
            gloss: { style: 'band', opacity: 0.3, height: 0.09, inset: 4, curve: 0 },
            patterns: [{ kind: 'stripes', color: '#ffffff', opacity: 0.06, size: 26, angle: 45, duty: 0.5 }],
            dropShadow: { color: '#12082a', opacity: 0.4, blur: 14, offset: [0, 20] },
          }),
          one({ kind: 'rect', radius: 22 }, {
            fill: { angle: 90, stops: [[0, P.panel], [1, P.panel2]] },
            patterns: [{ kind: 'dots', color: darken(P.panel2, 0.1), opacity: 0.55, size: 18, duty: 0.14 }],
            strokes: [{ width: 3, paint: INK, position: 'outside' }],
            innerShadow: { color: darken(P.panel2, 0.55), opacity: 0.35, size: 14, offset: [0, 6] },
          }, [t, t, w - 2 * t, h - 2 * t]),
          // Twinkles on the frame's corners.
          one({ kind: 'sparkle', points: 8, pinch: 0.7 }, { fill: '#ffffff', outerGlow: { color: '#fff6b0', opacity: 0.8, size: 6 }, strokes: [{ width: 1.5, paint: INK, position: 'outside', opacity: 0.35 }] }, [-8, -8, 34, 34]),
          one({ kind: 'sparkle', points: 4, pinch: 0.7 }, { fill: '#ffffff', outerGlow: { color: '#fff6b0', opacity: 0.8, size: 5 } }, [22, 6, 16, 16]),
          one({ kind: 'sparkle', points: 8, pinch: 0.7 }, { fill: '#ffffff', outerGlow: { color: '#fff6b0', opacity: 0.8, size: 6 }, strokes: [{ width: 1.5, paint: INK, position: 'outside', opacity: 0.35 }] }, [w - 28, h - 30, 30, 30]),
        ] };
      }
      case 'header': {
        // A glossy band (headers stretch: everything along it is uniform; the ends carry the shape).
        const base = accent ?? P.secondary;
        return { size: r.size, layers: [one({ kind: 'rect', radius: Math.min(26, h * 0.42) }, {
          ...plastic(base, h, { depth: 7, shine: 0.38 }),
          strokes: [{ width: 4, paint: INK, position: 'outside' }, { width: 2.5, paint: lighten(base, 0.6), position: 'inside', opacity: 0.6 }],
          extrude: { depth: 7, color: { angle: 90, stops: [[0, darken(base, 0.35)], [1, darken(base, 0.5)]] }, stroke: { width: 4, color: INK } },
          dropShadow: { color: '#12082a', opacity: 0.28, blur: 4, offset: [0, 11] },
        })] };
      }
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        const base = on ? P.premium : (accent ? lighten(accent, 0.55) : P.tabOff);
        return withState({ size: r.size, layers: [one({ kind: 'rect', radius: [16, 16, 10, 10] }, { ...plastic(base, h, { depth: on ? 5 : 4, shine: on ? 0.45 : 0.35 }), ...(on ? { sparkles: { count: 1, size: 5, area: 'inside' as const } } : {}) })] }, state === 'selected' ? 'normal' : state, { press: 3 });
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityOf(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const rad = r.kind === 'slot' ? Math.min(16, w * 0.2) : 20;
        const face: LayerStyle = {
          fill: { type: 'radial', center: [0.5, 0.32], scale: 1.15, stops: [[0, lighten(top, 0.5)], [0.55, top], [1, bot]] },
          patterns: big ? [{ kind: 'stripes', color: '#ffffff', opacity: 0.0, size: 10 }] : [{ kind: 'diamonds', color: '#ffffff', opacity: 0.13, size: 18 }],
          overlays: big ? [{ paint: { type: 'conic', center: [0.5, 0.36], stops: Array.from({ length: 25 }, (_, i) => [i / 24, '#ffffff', i % 2 ? 0 : 0.22] as [number, string, number]) }, blend: 'screen' }] : [],
          strokes: [{ width: 3, paint: INK, position: 'outside' }, { width: 3.5, paint: '#ffffff', position: 'inside', opacity: 0.6 }],
          extrude: { depth: 5, color: darken(bot, 0.45), stroke: { width: 3, color: INK } },
          gloss: { style: 'arc', opacity: 0.3, height: 0.42, inset: 6 },
          rim: { width: 10, opacity: 0, shade: darken(bot, 0.3), shadeOpacity: 0.3 },
          ...(big ? { sparkles: { count: r.kind === 'slot' ? 2 : 4, size: r.kind === 'slot' ? 5 : 7, area: 'inside' as const } } : {}),
          dropShadow: { color: '#12082a', opacity: 0.25, blur: 3, offset: [0, 7] },
        };
        return withState({ size: r.size, layers: [one({ kind: 'rect', radius: rad }, face)] }, state, { press: 3, ring: '#ffc21a' });
      }
      case 'badge':
        return { size: r.size, slice: false, layers: [one({ kind: 'burst', points: 14, inner: 0.84, round: 1.5 }, {
          fill: { angle: 90, stops: [[0, '#ff8a96'], [1, P.danger]] },
          strokes: [{ width: 3, paint: INK, position: 'outside' }, { width: 1.5, paint: '#ffc2c8', position: 'inside', opacity: 0.6 }],
          gloss: { style: 'band', opacity: 0.4, height: 0.5, inset: 3, curve: 0.3 },
          extrude: { depth: 2.5, color: darken(P.danger, 0.45), stroke: { width: 3, color: INK } },
          dropShadow: { color: '#000000', opacity: 0.25, blur: 2, offset: [0, 5] },
        })] };
      case 'ribbon': {
        const base = accent ?? P.danger;
        return { size: r.size, layers: [one({ kind: 'ribbon', notch: h * 0.38 }, {
          fill: { angle: 90, stops: [[0, lighten(base, 0.22)], [1, base]] },
          strokes: [{ width: 3, paint: INK, position: 'outside' }, { width: 1.5, paint: lighten(base, 0.6), position: 'inside', opacity: 0.5 }],
          gloss: { style: 'band', opacity: 0.35, height: 0.5, inset: 3, curve: 0 },
          extrude: { depth: 4, color: darken(base, 0.45), stroke: { width: 3, color: INK } },
          dropShadow: { color: '#000000', opacity: 0.2, blur: 2, offset: [0, 6] },
        })] };
      }
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, {
          fill: { angle: 90, stops: [[0, '#3a2a5c'], [1, '#4f3d78']] },
          innerShadow: { color: '#000000', opacity: 0.5, size: 6, offset: [0, 3] },
          strokes: [{ width: 3, paint: INK, position: 'outside' }],
        })] };
      case 'barFill': {
        const base = role === 'danger' ? P.danger : role === 'premium' ? P.premium : role === 'secondary' ? P.secondary : (accent ?? P.primary);
        return { size: r.size, layers: [one({ kind: 'pill' }, {
          fill: { angle: 90, stops: [[0, lighten(base, 0.35)], [0.55, base], [1, darken(base, 0.1)]] },
          gloss: { style: 'band', opacity: 0.45, height: 0.48, inset: 2, curve: 0 },
          strokes: [{ width: 2, paint: darken(base, 0.35), position: 'inside', opacity: 0.5 }],
        })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, {
          fill: { angle: 90, stops: [[0, '#4a3470'], [1, '#2f2050']] },
          strokes: [{ width: 3, paint: INK, position: 'outside' }, { width: 2, paint: '#ffffff', position: 'inside', opacity: 0.16 }],
          innerShadow: { color: '#000000', opacity: 0.4, size: 5, offset: [0, 2] },
          gloss: { style: 'band', opacity: 0.12, height: 0.45, inset: 3, curve: 0 },
          dropShadow: { color: '#000000', opacity: 0.25, blur: 2, offset: [0, 4] },
        })] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, {
          fill: { type: 'radial', center: [0.5, 0.38], stops: [[0, '#ffffff'], [0.7, lighten(accent ?? P.secondary, 0.35)], [1, accent ?? P.secondary]] },
          strokes: [{ width: 3, paint: INK, position: 'outside' }, { width: 3, paint: '#ffffff', position: 'inside', opacity: 0.7 }],
          extrude: { depth: 4, color: darken(accent ?? P.secondary, 0.45), stroke: { width: 3, color: INK } },
          gloss: { style: 'arc', opacity: 0.35, height: 0.5, inset: 4 },
          dropShadow: { color: '#000000', opacity: 0.25, blur: 2, offset: [0, 6] },
        })] }, state, { press: 3 });
      case 'close':
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'rect', radius: Math.min(w, h) * 0.3 }, plastic(P.danger, h, { depth: 4 })),
          one({ kind: 'cross', thickness: 0.26 }, { fill: '#ffffff', strokes: [{ width: 2.5, paint: INK, position: 'outside' }], dropShadow: { color: INK, opacity: 0.35, blur: 0.5, offset: [0, 1.5] } }, [w * 0.22, h * 0.16, w * 0.56, h * 0.6]),
        ] }, state, { press: 3 });
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'SHOP', font: 'LuckiestGuy' }, {
          fill: { angle: 90, stops: [[0, '#ffffff'], [0.5, '#fff3b0'], [1, '#ffcf3a']] },
          strokes: [{ width: 5.5, paint: INK, position: 'outside' }],
          extrude: { depth: 7, color: { angle: 90, stops: [[0, '#8a52ff'], [1, '#5a2fd0']] }, stroke: { width: 5.5, color: INK } },
          gloss: { style: 'band', opacity: 0.35, height: 0.48, inset: 1.5, curve: 0 },
          dropShadow: { color: '#12082a', opacity: 0.35, blur: 3, offset: [0, 11] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: darken(P.panel2, 0.18), innerShadow: { color: '#000000', opacity: 0.25, size: 2, offset: [0, 1] }, strokes: [{ width: 1, paint: '#ffffff', position: 'outside', opacity: 0.8 }] })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'bubble', radius: 16, tail: [0.18, 18, 14] }, {
          fill: { angle: 90, stops: [[0, '#ffffff'], [1, '#f1ebff']] },
          strokes: [{ width: 3, paint: INK, position: 'outside' }],
          dropShadow: { color: '#12082a', opacity: 0.3, blur: 4, offset: [0, 6] },
        })] };
      case 'icon': {
        // A sticker: the glyph's silhouette filled in the colour, its lines drawn darker on it, an ink outline and a base.
        const [top, bot] = isRarity(r.variant) ? rarityOf(r.variant) : role === 'danger' ? [lighten(P.danger, 0.2), P.danger] : role === 'secondary' ? [lighten(P.secondary, 0.3), P.secondary] : [lighten(accent ?? P.premium, 0.3), accent ?? P.premium];
        const g = r.glyph ?? 'star';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3.2, solid: true }, {
            // Near white, shaded in the rarity: it reads on any card colour.
            fill: { angle: 90, stops: [[0, '#ffffff'], [0.5, lighten(top, 0.72)], [1, lighten(top, 0.25)]] },
            strokes: [{ width: 2.6, paint: INK, position: 'outside' }],
            rim: { width: 4, opacity: 0, shade: darken(bot, 0.1), shadeOpacity: 0.45 },
            extrude: { depth: 2.5, color: darken(bot, 0.5), stroke: { width: 2.6, color: INK } },
            gloss: { style: 'band', opacity: 0.35, height: 0.5, inset: 1.5, curve: 0.2 },
            dropShadow: { color: '#000000', opacity: 0.22, blur: 1.5, offset: [0, 4] },
          }),
          one({ kind: 'glyph', name: g, weight: 2.1 }, { fill: darken(bot, 0.25), fillOpacity: 0.75 }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, {
            fill: { type: 'radial', center: [0.42, 0.36], scale: 1.15, stops: [[0, '#fff6b8'], [0.5, '#ffd23f'], [1, '#f0a000']] },
            strokes: [{ width: Math.max(1.5, w * 0.06), paint: INK, position: 'outside' }],
            extrude: { depth: Math.max(1.5, h * 0.08), color: '#b86400', stroke: { width: Math.max(1.5, w * 0.06), color: INK } },
            bevel: { size: Math.max(1.5, w * 0.1), style: 'round', highlightOpacity: 0.7, shadowOpacity: 0.35, specular: 0.4 },
          }),
          one({ kind: 'ring', thickness: Math.max(1, w * 0.045) }, { fill: '#d98a00', fillOpacity: 0.8 }, [w * 0.17, h * 0.17, w * 0.66, h * 0.66]),
          one({ kind: 'glyph', name: r.glyph ?? 'star', weight: 3, solid: true }, {
            fill: { angle: 90, stops: [[0, '#fffbe0'], [1, '#ffd84a']] },
            strokes: [{ width: Math.max(0.8, w * 0.035), paint: '#c47200', position: 'outside' }],
            bevel: { size: Math.max(0.8, w * 0.04), style: 'pillow', highlightOpacity: 0.6, shadowOpacity: 0.3 },
          }, [w * 0.28, h * 0.26, w * 0.44, h * 0.44]),
        ] };
    }
  },
};
