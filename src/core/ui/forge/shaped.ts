import { strokesOf, type RGB, type UiGradient, type UiNode } from '@shared/ui-layout';
import { forge, type ForgeSpec } from './forge';
import type { SkinForge } from './resolve';
import type { Paint, Stop } from './style';

/**
 * Panel shapes (corners cut at 45°, sides that lean) as forged art, for the exact build: Roblox has no shape property,
 * so ui_lab_build wears each shaped panel's look — its fill, its UIGradient and its outlines on the cut outline — as a
 * "custom:shape-…" skin, 9-sliced like any other (the cuts keep their size; a leaning side stretches with the height,
 * as the Ui kit's Ui.shape does). An element that wears a skin keeps it: the skin's art is the shape.
 */

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** A UIGradient's value at t along its keypoints. */
function at<T extends number[]>(keys: Array<[number, ...T]>, t: number, fallback: T): T {
  if (!keys.length) return fallback;
  const sorted = [...keys].sort((x, y) => x[0] - y[0]);
  if (t <= sorted[0]![0]) return sorted[0]!.slice(1) as T;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (t <= b[0]) {
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a.slice(1).map((v, j) => mix(v as number, b[j + 1] as number, k)) as T;
    }
  }
  return sorted[sorted.length - 1]!.slice(1) as T;
}

/** The panel's fill as the forge paints it: its colour times its UIGradient's, faded by the gradient's transparency. */
function fillOf(bg: RGB, g: UiGradient | undefined): Paint {
  if (!g) return bg;
  const ts = [...new Set([0, 1, ...g.colors.map((c) => c[0]), ...(g.transp ?? []).map((x) => x[0])])].sort((a, b) => a - b);
  const stops: Stop[] = ts.map((t) => {
    const [r, gg, b] = at<[number, number, number]>(g.colors, t, [255, 255, 255]);
    const [tr] = at<[number]>(g.transp ?? [], t, [0]);
    return [t, [Math.round((bg[0] * r) / 255), Math.round((bg[1] * gg) / 255), Math.round((bg[2] * b) / 255)], 1 - tr];
  });
  return { type: g.type === 'Radial' ? 'radial' : 'linear', angle: g.rot, stops };
}

/** The forge recipe for a shaped panel, at its offset size (else a nominal one 9-slicing stretches). */
export function shapeSpec(n: UiNode): ForgeSpec | null {
  const sh = n.shape;
  if (!sh || !(sh.cut?.some((c) => c > 0) || sh.slant?.some((s) => s !== 0))) return null;
  const size = n.size ?? [0, 100, 0, 100];
  const w = Math.max(24, Math.min(1000, size[0] === 0 && size[1] > 0 ? size[1] : 240));
  const h = Math.max(16, Math.min(1000, size[2] === 0 && size[3] > 0 ? size[3] : 120));
  const lines = strokesOf(n).filter((s) => !s.text);
  const opacity = 1 - (n.bgT ?? 0);
  if (opacity <= 0.001 && !lines.length) return null;
  return {
    size: [w, h],
    layers: [
      {
        shape: { kind: 'cut', cut: sh.cut ?? [0, 0, 0, 0], ...(sh.slant ? { slant: sh.slant } : {}) },
        style: {
          fill: fillOf(n.bg ?? [255, 255, 255], n.gradient),
          ...(opacity < 1 ? { fillOpacity: Math.max(0, opacity) } : {}),
          strokes: lines.map((s) => ({ width: s.px, paint: s.color, position: s.pos === 'Inner' ? ('inside' as const) : s.pos === 'Center' ? ('center' as const) : ('outside' as const), opacity: 1 - s.t })),
        },
      },
    ],
  };
}

const hashOf = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

/** Screens whose shaped panels wear their shape as forged art (kept in the project's skin cache). */
export function shapesAsSkins(screens: UiNode[], sf: SkinForge): { screens: UiNode[]; made: number } {
  let made = 0;
  const walk = (n: UiNode): UiNode => {
    const out: UiNode = n.kids ? { ...n, kids: n.kids.map(walk) } : n;
    if (n.skin) return out;
    const spec = shapeSpec(n);
    if (!spec) return out;
    const wear = (sp: ForgeSpec): string => {
      const name = `shape-${hashOf(JSON.stringify(sp))}`;
      if (!sf.forged(`custom:${name}`)) sf.saveCustom(name, forge(sp), sp);
      return `custom:${name}`;
    };
    // States that change what the art draws (a hover colour, a selected outline) wear their own shape art.
    let states = out.states;
    if (states) {
      const next: NonNullable<UiNode['states']> = {};
      for (const [st, p] of Object.entries(states) as Array<[keyof NonNullable<UiNode['states']>, NonNullable<NonNullable<UiNode['states']>[keyof NonNullable<UiNode['states']>]>]>) {
        if (!p || p.skin || !(p.bg || p.bgT !== undefined || p.gradient || p.stroke || p.strokes)) {
          if (p) next[st] = p;
          continue;
        }
        const { bg, bgT, gradient, stroke, strokes, ...keep } = p;
        const patched: UiNode = { ...n, ...(bg ? { bg } : {}), ...(bgT !== undefined ? { bgT } : {}), ...(gradient ? { gradient } : {}), ...(stroke || strokes ? { stroke: stroke ?? strokes?.[0], strokes: strokes ?? (stroke ? [stroke] : undefined) } : {}) };
        const ps = shapeSpec(patched);
        next[st] = ps ? { ...keep, skin: wear(ps) } : p;
      }
      states = next;
    }
    // The art carries the fill, the gradient and the outlines; the letters' own outlines stay on the text.
    const { shape: _shape, gradient: _gradient, stroke: _stroke, strokes: _strokes, corner: _corner, ...rest } = out;
    const text = strokesOf(n).filter((s) => s.text);
    made++;
    return { ...rest, skin: wear(spec), ...(states ? { states } : {}), ...(text.length ? { strokes: text, stroke: text[0] } : {}) };
  };
  return { screens: screens.map(walk), made };
}
