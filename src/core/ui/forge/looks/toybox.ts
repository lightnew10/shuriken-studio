import type { ForgeLayer, ForgeSpec } from '../forge';
import { darken, isRarity, lighten, one, roleOf, withState, type Direction } from '../kit';
import type { Color, LayerStyle } from '../style';

/**
 * Toybox: bright plastic building bricks (building games, toy tycoons, kids' creative games): primary-colour ABS
 * plastic with a rounded moulded bevel and a hard specular, studs on top of every brick, darker plastic sides and
 * outlines instead of ink, a studded baseplate for windows.
 */

const P = { red: '#e3242b', yellow: '#ffcd03', blue: '#0a6ad8', green: '#00a650', orange: '#ff8a00', white: '#f4f4f0', grey: '#a0a5a9', dark: '#2b2d30', lime: '#a5ca18', purple: '#8e3fd1', azure: '#3ac0f0' };

/** Toy rarities: plastic colours rather than gem tones. */
const TOY_RARITY: Record<string, Color> = { common: P.grey, rare: P.blue, epic: P.purple, legendary: P.yellow, mythic: P.red };

/** Moulded plastic: a rounded bevel, a sharp specular, a darker side under it and a darker outline. */
const plastic = (base: Color, h: number, o: { depth?: number; outline?: number } = {}): LayerStyle => ({
  fill: { angle: 90, stops: [[0, lighten(base, 0.12)], [1, darken(base, 0.06)]] },
  bevel: { size: Math.max(2.5, Math.min(6, h * 0.12)), style: 'round', highlightOpacity: 0.55, shadowOpacity: 0.4, specular: 0.7, angle: 115, altitude: 35 },
  strokes: [{ width: o.outline ?? 2, paint: darken(base, 0.4), position: 'outside' }],
  extrude: { depth: o.depth ?? Math.max(4, Math.min(9, h * 0.13)), color: { angle: 90, stops: [[0, darken(base, 0.28)], [1, darken(base, 0.42)]] }, stroke: { width: o.outline ?? 2, color: darken(base, 0.55) } },
  dropShadow: { color: '#000000', opacity: 0.28, blur: 3, offset: [0, (o.depth ?? Math.max(4, Math.min(9, h * 0.13))) + 3] },
});

/** Studs along the top of a brick: drawn first, so the brick hides their lower halves. */
const studRow = (base: Color, w: number, h: number, at: [number, number, number, number], cols?: number): ForgeLayer => {
  const n = cols ?? Math.max(1, Math.round(at[2] / Math.max(20, at[3] * 1.5)));
  return one({ kind: 'studs', cols: n, rows: 1, radius: 0.42 }, {
    fill: { angle: 90, stops: [[0, lighten(base, 0.3)], [1, base]] },
    bevel: { size: 2, style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.35, specular: 0.6 },
    strokes: [{ width: 2, paint: darken(base, 0.4), position: 'outside' }],
    extrude: { depth: 2.5, color: darken(base, 0.3), stroke: { width: 2, color: darken(base, 0.55) } },
  }, at);
};

/** A brick: studs peeking over the top edge, then the moulded face. */
const brick = (base: Color, w: number, h: number, shape: ForgeLayer['shape'], face?: Partial<LayerStyle>, studs = true): ForgeLayer[] => {
  const sh = Math.max(8, Math.min(18, h * 0.34));
  return [
    ...(studs ? [studRow(base, w, h, [w * 0.06, -sh * 0.5, w * 0.88, sh])] : []),
    one(shape, { ...plastic(base, h), ...face }),
  ];
};

/** A brick that stretches (headers, ribbons): studs only at its two ends, so the middle is the same all along. */
const endBrick = (base: Color, w: number, h: number, radius: number): ForgeLayer[] => {
  const sh = Math.max(9, Math.min(20, h * 0.4));
  const span = Math.min(w * 0.3, sh * 3.2);
  return [
    studRow(base, w, h, [Math.min(w * 0.04, 12), -sh * 0.6, span, sh], 2),
    studRow(base, w, h, [w - Math.min(w * 0.04, 12) - span, -sh * 0.6, span, sh], 2),
    one({ kind: 'rect', radius }, plastic(base, h)),
  ];
};

export const toybox: Direction = {
  id: 'toybox',
  label: 'Toybox (plastic bricks)',
  for: 'building games, toy and brick tycoons, creative sandboxes, kids games: primary-colour moulded plastic bricks with studs on top, chunky bevels and hard highlights, studded baseplate windows',
  palette: P,
  fonts: { display: 'FredokaOne', body: 'BuilderSans', weightBody: 800 },
  backdrop: '#ffd84a',
  text: {
    color: P.dark,
    strokePx: 2.5,
    onButton: '#ffffff',
    onButtonStroke: '#1b1b1b',
    title: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 3, font: 'LuckiestGuy', minSize: 22 },
    button: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
    tabOn: { color: '#2b2d30', font: 'BuilderSans', weight: 800 },
    tabOff: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2, font: 'BuilderSans', weight: 800 },
    onCard: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2.5, font: 'BuilderSans', weight: 800 },
    onPill: { color: '#2b2d30', font: 'FredokaOne', minSize: 18 },
    muted: { color: '#55595e', font: 'BuilderSans', weight: 700 },
    disabled: { color: '#f2f2f2', stroke: '#4a4d52', strokePx: 2, font: 'BuilderSans', weight: 800 },
    buttons: {
      primary: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      secondary: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      danger: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      success: { color: '#ffffff', stroke: '#1b1b1b', strokePx: 2.5, font: 'FredokaOne', minSize: 18 },
      premium: { color: '#2b2d30', font: 'FredokaOne', minSize: 18 },
    },
  },
  element(r, accent) {
    const [w, h] = r.size;
    const { role, state } = roleOf(r);
    const look = { press: 4, ring: '#ffffff', grey: '#b8bcc0', greyMix: 0.5 };
    const s = (spec: ForgeSpec) => withState(spec, state, look);
    const rad = Math.min(8, h * 0.18);
    switch (r.kind) {
      case 'button': {
        const base = role === 'secondary' ? P.blue : role === 'danger' ? P.red : role === 'premium' ? P.yellow : role === 'success' ? P.green : (accent ?? P.green);
        return s({ size: r.size, layers: brick(base, w, h, { kind: 'rect', radius: rad }) });
      }
      case 'window': {
        // A studded baseplate frame round a smooth white tile.
        const base = accent ?? P.blue;
        const t = 22;
        return { size: r.size, content: [t + 8, t + 8, w - 2 * t - 16, h - 2 * t - 16], layers: [
          one({ kind: 'rect', radius: 14 }, { ...plastic(base, 60, { depth: 10, outline: 2.5 }), patterns: [{ kind: 'studs', color: lighten(base, 0.35), opacity: 0.55, size: 22, duty: 0.3 }], dropShadow: { color: '#000000', opacity: 0.35, blur: 12, offset: [0, 18] } }),
          one({ kind: 'rect', radius: 10 }, { fill: { angle: 90, stops: [[0, '#ffffff'], [1, '#ecebe6']] }, bevel: { size: 4, style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.25, specular: 0.4 }, strokes: [{ width: 2.5, paint: darken(base, 0.45), position: 'outside' }], innerShadow: { color: darken(base, 0.4), opacity: 0.25, size: 10, offset: [0, 4] } }, [t, t, w - 2 * t, h - 2 * t]),
        ] };
      }
      case 'header': {
        const base = accent ?? P.red;
        return { size: r.size, layers: endBrick(base, w, h, 8) };
      }
      case 'tab': {
        const on = r.variant === 'active' || state === 'selected';
        const base = on ? P.yellow : (accent ?? P.azure);
        return withState({ size: r.size, layers: brick(base, w, h, { kind: 'rect', radius: [8, 8, 4, 4] }, { extrude: { depth: on ? 5 : 4, color: darken(base, 0.35), stroke: { width: 2, color: darken(base, 0.55) } } }) }, state === 'selected' ? 'normal' : state, look);
      }
      case 'card':
      case 'slot': {
        const base = TOY_RARITY[r.variant ?? 'common'] ?? P.grey;
        const big = r.variant === 'legendary' || r.variant === 'mythic';
        const inner = r.kind === 'card' ? 10 : 7;
        const layers: ForgeLayer[] = [
          ...brick(base, w, Math.min(h, 60), { kind: 'rect', radius: 10 }, {}, r.kind === 'card'),
          // A smooth recessed tile inside the brick for the item.
          one({ kind: 'rect', radius: 6 }, { fill: { type: 'radial', center: [0.5, 0.4], stops: [[0, '#ffffff'], [1, '#e4e2da']] }, innerShadow: { color: darken(base, 0.5), opacity: 0.45, size: 6, offset: [0, 3] }, strokes: [{ width: 1.5, paint: darken(base, 0.3), position: 'outside', opacity: 0.6 }], ...(big ? { sparkles: { count: r.kind === 'slot' ? 1 : 3, size: 6, area: 'inside' as const } } : {}) }, [inner, inner, w - 2 * inner, h - 2 * inner - (r.kind === 'card' ? h * 0.24 : 0)]),
        ];
        return withState({ size: r.size, layers }, state, look);
      }
      case 'badge':
        // A round 1×1 brick seen from above: the disc and its stud.
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, plastic(P.red, h, { depth: 3 })),
          one({ kind: 'ring', thickness: Math.max(1.5, w * 0.06) }, { fill: darken(P.red, 0.25), fillOpacity: 0.7 }, [w * 0.2, h * 0.2, w * 0.6, h * 0.6]),
        ] };
      case 'ribbon': {
        const base = accent ?? P.orange;
        return { size: r.size, layers: endBrick(base, w, h, 6) };
      }
      case 'barTrack':
        return { size: r.size, layers: [one({ kind: 'rect', radius: Math.min(6, h / 2) }, { fill: P.dark, bevel: { size: 2, style: 'round', highlightOpacity: 0.2, shadowOpacity: 0.5 }, innerShadow: { color: '#000000', opacity: 0.6, size: 5, offset: [0, 2] }, strokes: [{ width: 2, paint: '#111214', position: 'outside' }] })] };
      case 'barFill': {
        const base = role === 'danger' ? P.red : role === 'premium' ? P.yellow : role === 'secondary' ? P.blue : (accent ?? P.green);
        return { size: r.size, layers: [one({ kind: 'rect', radius: Math.min(5, h / 2) }, { fill: { angle: 90, stops: [[0, lighten(base, 0.2)], [1, darken(base, 0.05)]] }, bevel: { size: 2.5, style: 'round', highlightOpacity: 0.55, shadowOpacity: 0.35, specular: 0.6 } })] };
      }
      case 'pill':
        return { size: r.size, layers: [one({ kind: 'rect', radius: Math.min(10, h * 0.3) }, plastic(P.white, h, { depth: 4 }))] };
      case 'iconFrame':
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, plastic(accent ?? P.yellow, h, { depth: 5 })),
          one({ kind: 'ellipse' }, { fill: { type: 'radial', center: [0.5, 0.4], stops: [[0, '#ffffff'], [1, '#e6e4dc']] }, innerShadow: { color: '#000000', opacity: 0.35, size: 6, offset: [0, 3] } }, [w * 0.14, h * 0.14, w * 0.72, h * 0.72]),
        ] }, state, look);
      case 'close':
        return withState({ size: r.size, slice: false, layers: [
          one({ kind: 'rect', radius: Math.min(w, h) * 0.22 }, plastic(P.red, h, { depth: 4 })),
          one({ kind: 'cross', thickness: 0.24 }, { fill: '#ffffff', bevel: { size: 1.5, style: 'round', highlightOpacity: 0.5, shadowOpacity: 0.3 }, strokes: [{ width: 1.5, paint: darken(P.red, 0.5), position: 'outside' }] }, [w * 0.24, h * 0.18, w * 0.52, h * 0.56]),
        ] }, state, look);
      case 'title':
        return { size: r.size, slice: false, layers: [one({ kind: 'text', text: r.text ?? 'TOYS', font: 'LuckiestGuy' }, {
          fill: { angle: 90, stops: [[0, '#fff27a'], [0.5, P.yellow], [1, '#f0a800']] },
          bevel: { size: 3, style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.3, specular: 0.8 },
          strokes: [{ width: 7, paint: '#1b1b1b', position: 'outside' }, { width: 4.5, paint: { angle: 90, stops: [[0, '#ff4a4f'], [1, '#b8141a']] }, position: 'outside' }],
          extrude: { depth: 7, color: { angle: 90, stops: [[0, '#2a6ae0'], [1, '#0a3a9a']] }, stroke: { width: 7, color: '#1b1b1b' } },
          dropShadow: { color: '#000000', opacity: 0.3, blur: 3, offset: [0, 12] },
        })] };
      case 'divider':
        return { size: r.size, layers: [one({ kind: 'rect', radius: Math.min(3, h / 2) }, { fill: '#d6d4cc', innerShadow: { color: '#000000', opacity: 0.3, size: 2, offset: [0, 1] } })] };
      case 'tooltip':
        return { size: r.size, layers: [...brick(P.white, w, Math.min(h, 50), { kind: 'rect', radius: 8 }, { extrude: { depth: 5, color: '#c4c2ba', stroke: { width: 2, color: '#77756e' } }, strokes: [{ width: 2, paint: '#8a8880', position: 'outside' }] })] };
      case 'icon': {
        const base = isRarity(r.variant) ? (TOY_RARITY[r.variant] ?? P.yellow) : role === 'danger' ? P.red : role === 'secondary' ? P.blue : (accent ?? P.yellow);
        const g = r.glyph ?? 'box';
        return { size: r.size, slice: false, layers: [
          one({ kind: 'glyph', name: g, weight: 3.2, solid: true }, { ...plastic(base, h * 0.5, { depth: 3, outline: 1.8 }), dropShadow: { color: '#000000', opacity: 0.25, blur: 1.5, offset: [0, 4] } }),
          one({ kind: 'glyph', name: g, weight: 1.9 }, { fill: darken(base, 0.45), fillOpacity: 0.7 }),
        ] };
      }
      case 'coin':
        // A round 1×1 plate in gold with its stud (and a glyph moulded on the stud when asked).
        return { size: r.size, slice: false, layers: [
          one({ kind: 'ellipse' }, { ...plastic(P.yellow, h, { depth: Math.max(1.5, h * 0.08), outline: Math.max(1, w * 0.04) }), dropShadow: { color: '#000000', opacity: 0.25, blur: 1, offset: [0, Math.max(1.5, h * 0.1)] } }),
          one({ kind: 'ellipse' }, { fill: { angle: 90, stops: [[0, '#fff27a'], [1, P.yellow]] }, bevel: { size: Math.max(1, w * 0.06), style: 'round', highlightOpacity: 0.6, shadowOpacity: 0.3, specular: 0.7 }, strokes: [{ width: Math.max(0.8, w * 0.03), paint: darken(P.yellow, 0.4), position: 'outside' }], dropShadow: { color: darken(P.yellow, 0.5), opacity: 0.6, blur: 0.5, offset: [0, Math.max(1, h * 0.04)] } }, [w * 0.22, h * 0.2, w * 0.56, h * 0.56]),
          ...(r.glyph ? [one({ kind: 'glyph', name: r.glyph, weight: 3, solid: true }, { fill: darken(P.yellow, 0.15), bevel: { size: Math.max(0.5, w * 0.025), style: 'round', highlightOpacity: 0.5, shadowOpacity: 0.4 } }, [w * 0.32, h * 0.3, w * 0.36, h * 0.36])] : []),
        ] };
    }
  },
};
