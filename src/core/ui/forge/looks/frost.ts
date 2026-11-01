import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, rarityOf, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle } from '../style';

/**
 * Frost: clean modern glass for hangouts, social games, tycoon menus and settings: frosted translucent panels with a
 * whisper of grain, soft long shadows, a lit top edge, rounded pills in one calm accent, duotone icons.
 */

const P = { glass: '#ffffff', ink: '#1d2433', accent: '#3d58f0', ok: '#2ccf8a', bad: '#d92b43', gold: '#ffbf3c', violet: '#8b5cf6' };

const frosted = (opacity = 0.8, depth = 1): LayerStyle => ({
  fill: { angle: 90, stops: [[0, '#ffffff', opacity], [1, '#eef2fb', opacity - 0.06]] },
  grain: { amount: 0.04, scale: 1.2 },
  strokes: [{ width: 1.5, paint: { angle: 90, stops: [[0, '#ffffff', 1], [1, '#ffffff', 0.4]] }, position: 'inside' }, { width: 1, paint: P.ink, position: 'outside', opacity: 0.07 }],
  rim: { width: 6, color: '#ffffff', opacity: 0.6, angle: 90, falloff: 2 },
  innerGlow: { color: '#ffffff', opacity: 0.45, size: 12 },
  dropShadow: { color: '#26304a', opacity: 0.16 * depth, blur: 16, offset: [0, 12 * depth] },
});

const solid = (base: Color, h: number): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.1)], [1, darken(base, 0.1)]] },
  innerGlow: { color: '#ffffff', opacity: 0.18, size: 6 },
  rim: { width: Math.max(3, h * 0.12), color: '#ffffff', opacity: 0.5, angle: 90, falloff: 2.5, shade: darken(base, 0.3), shadeOpacity: 0.25 },
  strokes: [{ width: 1, paint: '#ffffff', position: 'inside', opacity: 0.3 }],
  dropShadow: { color: darken(base, 0.2), opacity: 0.38, blur: 9, offset: [0, 7] },
});

export const frost: Direction = {
  id: 'frost',
  label: 'Frost (clean modern glass)',
  for: 'hangouts, social, tycoon menus, settings, modern clean games: frosted translucent panels, soft depth, rounded pills in one calm accent, duotone icons',
  palette: P,
  fonts: { display: 'BuilderSans', body: 'BuilderSans', weightDisplay: 800, weightBody: 700 },
  backdrop: '#a9bad4',
  text: {
    color: P.ink,
    strokePx: 0,
    onButton: '#ffffff',
    title: { color: P.ink, font: 'BuilderSans', weight: 800, minSize: 20 },
    button: { color: '#ffffff', font: 'BuilderSans', weight: 700 },
    tabOn: { color: '#ffffff', font: 'BuilderSans', weight: 700 },
    tabOff: { color: '#36415c', font: 'BuilderSans', weight: 700 },
    onCard: { color: P.ink, font: 'BuilderSans', weight: 700 },
    onPill: { color: P.ink, font: 'BuilderSans', weight: 800 },
    muted: { color: '#566078', font: 'BuilderSans', weight: 600 },
    disabled: { color: '#4e576c', font: 'BuilderSans', weight: 700 },
    buttons: {
      primary: { color: '#ffffff', font: 'BuilderSans', weight: 700 },
      secondary: { color: '#1d2433', font: 'BuilderSans', weight: 700 },
      danger: { color: '#ffffff', font: 'BuilderSans', weight: 700 },
      success: { color: '#062e1c', font: 'BuilderSans', weight: 700 },
      premium: { color: '#3a2200', font: 'BuilderSans', weight: 700 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const acc = accent ?? P.accent;
    const { role, state } = roleOf(r);
    const look = { press: 2, ring: acc, grey: '#b4bccb', greyMix: 0.5 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    switch (r.kind) {
      case 'button': {
        if (role === 'secondary') return s({ size: r.size, layers: [one({ kind: 'pill' }, { ...frosted(0.9, 0.5), strokes: [{ width: 1.5, paint: '#ffffff', position: 'inside' }, { width: 1.5, paint: acc, position: 'outside', opacity: 0.35 }] })] });
        const base = role === 'danger' ? P.bad : role === 'success' ? P.ok : role === 'premium' ? P.gold : acc;
        const face = solid(base, h);
        if (role === 'premium') {
          face.fill = { angle: 0, stops: [[0, '#ffcf5a'], [1, '#ff9a3c']] };
          face.sparkles = { count: 2, size: Math.min(6, h * 0.12), area: 'inside' };
        }
        return s({ size: r.size, layers: [one({ kind: 'pill' }, face)] });
      }
      case 'window':
        return { size: r.size, content: [24, 24, w - 48, h - 48], layers: [
          one({ kind: 'rect', radius: 30 }, { ...frosted(0.82, 1.4), overlays: [{ paint: { type: 'radial', center: [0.1, 0.06], scale: 0.9, stops: [[0, acc, 0.16], [1, acc, 0]] }, blend: 'normal' }, { paint: { type: 'radial', center: [0.94, 0.96], scale: 0.8, stops: [[0, P.violet, 0.12], [1, P.violet, 0]] }, blend: 'normal' }] }),
          // An aurora in the glass (two soft colour pools, above) and a lit top edge.
          one({ kind: 'rect', radius: 1 }, { fill: { angle: 0, stops: [[0, '#ffffff', 0], [0.5, '#ffffff', 1], [1, '#ffffff', 0]] } }, [40, 1.5, w - 80, 1.5]),
        ] };
      case 'header':
        // A lighter frosted strip with an accent underline: dark titles read on it.
        return { size: r.size, layers: [
          one({ kind: 'rect', radius: Math.min(26, h / 2) }, { ...frosted(0.96, 0.5), overlays: [{ paint: { angle: 0, stops: [[0, acc, 0.1], [0.5, acc, 0.02], [1, P.violet, 0.1]] }, blend: 'normal' }] }),
          one({ kind: 'pill' }, { fill: { angle: 0, stops: [[0, acc], [1, P.violet]] }, outerGlow: { color: acc, opacity: 0.35, size: 4 } }, [Math.min(26, h / 2), h - 7, w - 2 * Math.min(26, h / 2), 3]),
        ] };
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        if (on) return { size: r.size, layers: [one({ kind: 'pill' }, solid(acc, h))] };
        return withState({ size: r.size, layers: [one({ kind: 'pill' }, { fill: '#ffffff', fillOpacity: 0.55, strokes: [{ width: 1, paint: '#ffffff', position: 'inside', opacity: 0.8 }], dropShadow: { color: '#26304a', opacity: 0.06, blur: 4, offset: [0, 2] } })] }, state, look);
      }
      case 'card':
      case 'slot': {
        const [top, bot] = rarityOf(r.variant);
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const layers: ForgeLayer[] = [one({ kind: 'rect', radius: r.kind === 'slot' ? Math.min(18, w * 0.24) : 22 }, {
          ...frosted(0.95, 0.6),
          overlays: [{ paint: { type: 'radial', center: [0.5, 0.25], scale: 1.1, stops: [[0, top, big ? 0.55 : 0.4], [0.7, top, 0.08], [1, top, 0]] }, blend: 'normal' }],
          strokes: [{ width: 2, paint: { angle: 90, stops: [[0, lighten(top, 0.3)], [1, '#ffffff']] }, position: 'inside' }, { width: 1, paint: P.ink, position: 'outside', opacity: 0.06 }],
          ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, color: '#ffffff', area: 'inside' as const } } : {}),
        })];
        if (r.kind === 'card') layers.push(one({ kind: 'pill' }, { fill: { angle: 0, stops: [[0, top], [1, bot]] }, outerGlow: { color: bot, opacity: 0.35, size: 4 } }, [w * 0.3, 8, w * 0.4, 5]));
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        return { size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { ...solid(P.bad, h), strokes: [{ width: 2.5, paint: '#ffffff', position: 'outside' }] })] };
      case 'ribbon':
        return { size: r.size, layers: [one({ kind: 'pill' }, { ...solid(acc, h), fill: { angle: 0, stops: [[0, acc], [1, P.violet]] } })] };
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: P.ink, fillOpacity: 0.14, innerShadow: { color: P.ink, opacity: 0.25, size: 4, offset: [0, 1.5] }, strokes: [{ width: 1, paint: '#ffffff', position: 'outside', opacity: 0.5 }] })] };
      case 'barFill': {
        const base = role === 'danger' ? P.bad : role === 'premium' ? P.gold : role === 'success' ? P.ok : acc;
        return { size: r.size, layers: [one({ kind: 'pill' }, { fill: { angle: 0, stops: [[0, base], [1, lighten(base, 0.35)]] }, rim: { width: 3, color: '#ffffff', opacity: 0.45, angle: 90 }, outerGlow: { color: base, opacity: 0.35, size: 6 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'pill' }, frosted(0.92, 0.5))] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'rect', radius: Math.min(w, h) * 0.3 }, { ...frosted(0.95, 0.6), overlays: [{ paint: { angle: 135, stops: [[0, lighten(acc, 0.82)], [1, lighten(acc, 0.6)]] }, blend: 'multiply' }] })] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, frosted(0.92, 0.4)), one({ kind: 'cross', thickness: 0.15 }, { fill: P.ink }, [w * 0.3, h * 0.25, w * 0.4, h * 0.46])] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'Settings', font: 'BuilderSans', weight: 800 }, { fill: { angle: 90, stops: [[0, '#2a3450'], [1, P.ink]] }, dropShadow: { color: '#26304a', opacity: 0.18, blur: 4, offset: [0, 4] } })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'rect' }, { fill: { angle: 0, stops: [[0, P.ink, 0], [0.5, P.ink, 0.14], [1, P.ink, 0]] } })] };
      case 'tooltip':
        return { size: r.size, layers: [one({ kind: 'bubble', radius: 16, tail: [0.15, 16, 12] }, { ...frosted(0.94, 0.7) })] };
      case 'icon': {
        // Duotone: a soft tinted silhouette under crisp lines.
        const col = role === 'danger' ? P.bad : isRarity(r.variant) ? rarityOf(r.variant)[1] : acc;
        const g = r.glyph ?? 'settings';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 2.4, solid: true }, { fill: { angle: 90, stops: [[0, lighten(col, 0.55)], [1, lighten(col, 0.3)]] }, dropShadow: { color: col, opacity: 0.25, blur: 3, offset: [0, 3] } }),
          one({ kind: 'glyph', name: g, weight: 2.2 }, { fill: darken(col, 0.1) }),
        ] };
      }
      case 'coin':
        return { size: r.size, slice: false, layers: [one({ kind: 'ellipse' }, { fill: { angle: 135, stops: [[0, '#ffe08a'], [1, '#ffa630']] }, rim: { width: Math.max(1.5, w * 0.1), color: '#ffffff', opacity: 0.6, angle: 90 }, innerGlow: { color: '#ffffff', opacity: 0.3, size: Math.max(2, w * 0.1) }, dropShadow: { color: '#c07000', opacity: 0.3, blur: Math.max(1.5, w * 0.06), offset: [0, Math.max(1, w * 0.05)] } }), one({ kind: 'glyph', name: r.glyph ?? 'star', weight: 2.6, solid: true }, { fill: '#ffffff' }, [w * 0.25, h * 0.25, w * 0.5, h * 0.5])] };
    }
  },
};
