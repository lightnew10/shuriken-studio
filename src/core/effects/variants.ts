import type { EffectSpec } from '@shared/effects';

/**
 * Making an effect from another instead of writing it again: changes by path (`set`), and recolouring
 * (an exact palette swap, or turning the whole effect's hue toward a colour with its light and dark kept).
 * In the user's test game 16 of 61 vfx_create calls re-sent a whole effect to change only its colours
 * (PowerUpCollect and PowerUpPadGlow in gold, red and cyan, each sent twice), and five more to change one
 * number. A variant keeps its recipe (`VariantRecipe`), so it follows its base when the base changes.
 */
export interface VariantRecipe {
  /** The effect it is made from. */
  base: string;
  /** Exact colour swaps: {"#ffc428": "#ff3a28"}. */
  palette?: Record<string, string>;
  /** Turns every colour's hue so the effect's main colour becomes this one (white and grey stay). */
  to?: string;
  /** Turns every colour's hue by degrees. */
  hue?: number;
  /** Changes by path, applied last. */
  set?: Record<string, unknown>;
}

const HEX = /^#?[0-9a-fA-F]{6}$/;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function rgbToHsv(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 1e-9) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max > 0 ? d / max : 0, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + ((((h % 360) + 360) % 360) / 60)) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Every colour in a spec (any hex string in it), visited in place. */
function eachColor(node: unknown, fn: (hex: string) => string): unknown {
  if (typeof node === 'string') return HEX.test(node) && node.startsWith('#') ? fn(node) : node;
  if (Array.isArray(node)) return node.map((x) => eachColor(x, fn));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === 'name' || k === 'description' || k === 'texture' || k === 'sound' || k === 'effect' || k === 'text' ? v : eachColor(v, fn);
    return out;
  }
  return node;
}

/** The colours an effect uses, most used first. */
export function effectColors(e: EffectSpec): string[] {
  const count = new Map<string, number>();
  eachColor(e, (hex) => {
    const k = hex.toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
    return hex;
  });
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/** The hue its colours gather round (colourful and bright ones weigh most); null when it is all white and grey. */
export function mainHue(e: EffectSpec): number | null {
  let x = 0;
  let y = 0;
  eachColor(e, (hex) => {
    const [h, s, v] = rgbToHsv(hex);
    x += Math.cos((h * Math.PI) / 180) * s * v;
    y += Math.sin((h * Math.PI) / 180) * s * v;
    return hex;
  });
  return Math.hypot(x, y) < 1e-6 ? null : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function recolor(e: EffectSpec, r: Pick<VariantRecipe, 'palette' | 'to' | 'hue'>): EffectSpec {
  const turnTo = r.to && HEX.test(r.to) ? rgbToHsv(r.to) : null;
  const from = mainHue(e);
  const turn = (r.hue ?? 0) + (turnTo && from !== null ? turnTo[0] - from : 0);
  const swaps = new Map(Object.entries(r.palette ?? {}).map(([k, v]) => [k.toLowerCase().replace(/^(?!#)/, '#'), v]));
  return eachColor(e, (hex) => {
    // A colour the palette names goes to exactly what it says; the rest turn with the hue.
    const swap = swaps.get(hex.toLowerCase());
    if (swap) return swap;
    if (!turn) return hex;
    const [h, s, v] = rgbToHsv(hex);
    // White, grey and black have no hue to turn: a white-hot core stays white.
    return s < 0.06 ? hex : hsvToHex(h + turn, s, v);
  }) as EffectSpec;
}

type Json = Record<string, unknown>;

/** The element a path segment names in a list: by its `name`, or by its number (from 1, as the validation messages count). */
function indexIn(list: unknown[], seg: string): number {
  const byName = list.findIndex((x) => x && typeof x === 'object' && (x as Json).name === seg);
  if (byName >= 0) return byName;
  return /^\d+$/.test(seg) && Number(seg) >= 1 && Number(seg) <= list.length ? Number(seg) - 1 : -1;
}

/**
 * Applies changes by path to a copy of the effect: "duration": 2, "tracks.Core.size": [4, 9],
 * "emitters.Flames.rate": 30, "tracks.3.at": 0.1, "light.brightness": 6; null removes what the path names
 * (a field, a track, an emitter); a path that names a track or emitter that isn't there adds it (the value
 * is the whole track). Returns the problems instead when a path leads nowhere.
 */
export function applySet(e: EffectSpec, set: Record<string, unknown>): { effect: EffectSpec; problems: string[] } {
  const effect = clone(e) as unknown as Json;
  const problems: string[] = [];
  for (const [path, value] of Object.entries(set)) {
    const segs = path.split('.').filter(Boolean);
    if (!segs.length) continue;
    let node: unknown = effect;
    let failed = false;
    for (let i = 0; i < segs.length - 1 && !failed; i++) {
      const seg = segs[i]!;
      if (Array.isArray(node)) {
        const at = indexIn(node, seg);
        if (at < 0) {
          const names = node.map((x) => (x && typeof x === 'object' && typeof (x as Json).name === 'string' ? (x as Json).name : null)).filter(Boolean);
          problems.push(`${path}: nothing named "${seg}" in ${segs.slice(0, i).join('.') || 'the effect'}${names.length ? ` (it has ${names.join(', ')})` : ` (it has ${node.length} items; count from 1)`}`);
          failed = true;
        } else node = node[at];
      } else if (node && typeof node === 'object') {
        const obj = node as Json;
        if (obj[seg] === undefined) {
          // A list or part that isn't there yet (tracks on an effect that had only emitters, a trail of a ribbon).
          obj[seg] = seg === 'tracks' || seg === 'emitters' ? [] : {};
        }
        node = obj[seg];
      } else {
        problems.push(`${path}: "${segs.slice(0, i).join('.')}" is not something with parts`);
        failed = true;
      }
    }
    if (failed) continue;
    const last = segs[segs.length - 1]!;
    if (Array.isArray(node)) {
      const at = indexIn(node, last);
      if (value === null) {
        if (at < 0) problems.push(`${path}: nothing named "${last}" to remove`);
        else node.splice(at, 1);
      } else if (at >= 0) {
        // A whole track or emitter keeps its name; a number in a list is just replaced.
        node[at] = value && typeof value === 'object' && !Array.isArray(value) && node[at] && typeof node[at] === 'object' && !Array.isArray(node[at]) ? { ...(value as Json), name: (value as Json).name ?? (node[at] as Json).name } : value;
      } else if (value && typeof value === 'object' && !Array.isArray(value) && !/^\d+$/.test(last)) node.push({ ...(value as Json), name: last });
      else if (/^\d+$/.test(last) && Number(last) === node.length + 1) node.push(value);
      else problems.push(`${path}: nothing named "${last}" (to add a track or emitter, give the whole of it as the value)`);
    } else if (node && typeof node === 'object') {
      if (value === null) delete (node as Json)[last];
      else (node as Json)[last] = value;
    } else problems.push(`${path}: "${segs.slice(0, -1).join('.')}" is not something with parts`);
  }
  return { effect: effect as unknown as EffectSpec, problems };
}

/** A variant from its base and recipe: recoloured, then changed by path, under its own name. */
export function deriveEffect(base: EffectSpec, name: string, recipe: Omit<VariantRecipe, 'base'>): { effect: EffectSpec; problems: string[] } {
  let effect = clone(base);
  if (recipe.palette || recipe.to || recipe.hue) effect = recolor(effect, recipe);
  const applied = recipe.set ? applySet(effect, recipe.set) : { effect, problems: [] };
  return { effect: { ...applied.effect, name }, problems: applied.problems };
}
