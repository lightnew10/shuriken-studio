/**
 * The GPU forge's parity set, forged on the CPU: every art direction's elements (all kinds and variants), every
 * effect, pattern, texture, gradient, blend mode and finish on its own, a few elements sent as coverage bitmaps, and a
 * shop screen's 30 skins per direction at their real sizes (timed warm). Writes <data>/specs.json, screen.json and
 * the CPU's pixels (cpu-<i>.rgba, cpu-s<i>.rgba) for page.ts to compare. Run by run.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverage } from '../../src/core/ui/forge/canvas';
import { DIRECTIONS, type ElementRequest } from '../../src/core/ui/forge/directions';
import { forge, type ForgeSpec } from '../../src/core/ui/forge/forge';
import { scaleShape, shapeContours } from '../../src/core/ui/forge/shapes';
import { planForge, planToWire, type Cut, type ForgePlan } from '../../src/shared/forge-plan';

const dir = process.argv[2]!;
mkdirSync(dir, { recursive: true });
const cut: Cut = (s, x, y, w, h, k) => shapeContours(scaleShape(s, k), x, y, w, h);
const meta = (f: ReturnType<typeof forge>) => ({ width: f.image.width, height: f.image.height, margin: f.margin, scale: f.scale, slice: f.slice, drawn: f.drawn ?? null });

// Fonts, glyphs and the JIT warm first.
for (const d of Object.values(DIRECTIONS)) forge(d.element({ kind: 'title', text: 'A', size: [60, 40] }));
forge(DIRECTIONS.candy!.element({ kind: 'icon', glyph: 'star', size: [40, 40] }));

const items: unknown[] = [];
let i = 0;
const add = (name: string, spec: ForgeSpec, plan?: ForgePlan) => {
  const t0 = performance.now();
  const f = forge(spec);
  const cpuMs = performance.now() - t0;
  writeFileSync(join(dir, `cpu-${i}.rgba`), f.image.data);
  items.push({ i, name, plan: planToWire(plan ?? planForge(spec, cut)), cpu: meta(f), cpuMs });
  i++;
};

const rar = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
const reqs: Array<[ElementRequest, string?]> = [
  ...(['primary', 'secondary', 'danger', 'success', 'premium', 'pressed', 'disabled'] as const).map((v) => [{ kind: 'button', variant: v, size: [170, 56] }] as [ElementRequest]),
  [{ kind: 'tab', variant: 'active', size: [150, 48] }],
  [{ kind: 'tab', variant: 'inactive', size: [150, 48] }],
  ...rar.map((v) => [{ kind: 'card', variant: v, size: [150, 180] }] as [ElementRequest]),
  [{ kind: 'slot', variant: 'rare', size: [96, 96] }],
  [{ kind: 'badge', size: [48, 48] }],
  [{ kind: 'ribbon', size: [160, 40] }],
  [{ kind: 'barTrack', size: [220, 26] }],
  [{ kind: 'barFill', size: [200, 26] }],
  [{ kind: 'pill', size: [190, 46] }],
  [{ kind: 'iconFrame', size: [72, 72] }],
  [{ kind: 'close', size: [52, 52] }],
  [{ kind: 'divider', size: [320, 6] }],
  [{ kind: 'tooltip', size: [260, 90] }],
  [{ kind: 'title', text: 'PET SHOP', size: [340, 90] }],
  [{ kind: 'icon', glyph: 'sword', variant: 'epic', size: [96, 96] }],
  [{ kind: 'icon', glyph: 'coins', size: [96, 96] }],
  [{ kind: 'coin', size: [40, 40] }],
  [{ kind: 'header', size: [420, 70] }],
  [{ kind: 'window', size: [360, 240] }],
  [{ kind: 'button', variant: 'primary', size: [170, 56] }, '#ff7ab8'],
  [{ kind: 'barFill', size: [200, 26] }, '#4cb3ff'],
];
for (const [id, d] of Object.entries(DIRECTIONS))
  for (const [r, accent] of reqs) add(`${id}:${r.kind}${r.variant ? ':' + r.variant : ''}${r.glyph ? ':' + r.glyph : ''}${accent ?? ''}`, d.element(r, accent));

// Every effect on its own.
const PATTERNS = ['stripes', 'dots', 'checker', 'grid', 'hex', 'diamonds', 'waves', 'bricks', 'scales', 'bubbles', 'stars', 'hearts', 'chevron', 'crosshatch', 'plaid', 'confetti', 'studs', 'scanlines', 'zigzag', 'triangles', 'sparkles'] as const;
const TEXTURES = ['noise', 'clouds', 'wood', 'brushed', 'stone', 'cells', 'fabric', 'marble', 'scratches', 'rust', 'camo', 'carbon', 'caustics', 'paper', 'leather', 'hammered', 'speckle', 'pixels'] as const;
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'add', 'softlight', 'hardlight', 'lighten', 'darken', 'colordodge'] as const;
const rect = (style: object, size: [number, number] = [120, 80], shape: object = { kind: 'rect', radius: 12 }, extra: object = {}): ForgeSpec =>
  ({ size, layers: [{ shape, style: { fill: { angle: 90, stops: [[0, '#5aa0ff'], [1, '#2a4fb0']] }, ...style } }], ...extra }) as ForgeSpec;
const fx: Array<[string, ForgeSpec]> = [
  ...PATTERNS.map((k, n) => [`pattern:${k}`, rect({ patterns: [{ kind: k, color: '#ffffff', opacity: 0.6, size: 14, angle: n * 17 }] })] as [string, ForgeSpec]),
  ...TEXTURES.map((k, n) => [`texture:${k}`, rect({ textures: [{ kind: k, opacity: 0.8, scale: 10, angle: n * 13, ...(n % 3 === 0 ? { ramp: [[0, '#3a2210'], [1, '#e0b070']] } : n % 3 === 1 ? { color: '#ffe0a0' } : {}), ...(n % 4 === 0 ? { relief: 1 } : {}), ...(n % 5 === 0 ? { contrast: 1.6 } : {}) }] })] as [string, ForgeSpec]),
  ...BLENDS.map((b) => [`overlay:${b}`, rect({ overlays: [{ paint: { type: 'radial', stops: [[0, '#ff8040'], [1, '#40ff80', 0.4]] }, blend: b, opacity: 0.8 }] })] as [string, ForgeSpec]),
  ...['linear', 'radial', 'conic', 'reflected', 'diamond'].map((t) => [`gradient:${t}`, rect({ fill: { type: t, angle: 30, center: [0.4, 0.4], stops: [[0, '#ff0000'], [0.3, '#ffff00', 0.7], [0.7, '#00ffff'], [1, '#0000ff']] } })] as [string, ForgeSpec]),
  ...['smooth', 'chisel', 'pillow', 'round'].map((st) => [`bevel:${st}`, rect({ bevel: { size: 8, style: st, specular: st === 'round' ? 0.6 : 0 } })] as [string, ForgeSpec]),
  ...['arc', 'band', 'spot', 'glass'].map((st) => [`gloss:${st}`, rect({ gloss: { style: st, opacity: 0.7 } })] as [string, ForgeSpec]),
  ...['inside', 'top', 'edge', 'around'].map((a) => [`sparkles:${a}`, rect({ sparkles: { count: 5, size: 8, area: a } })] as [string, ForgeSpec]),
  ['rim', rect({ rim: { width: 6, angle: 60, shade: '#000000', shadeOpacity: 0.5 } })],
  ['wear', rect({ wear: { amount: 0.6, color: '#d0d0d0', width: 10 } })],
  ['cutouts', rect({ cutouts: [{ kind: 'dots', color: '#000', size: 16, duty: 0.25 }], strokes: [{ width: 3, paint: '#ffffff', position: 'inside' }] })],
  ['roughen', rect({ roughen: { amount: 3, scale: 8 }, strokes: [{ width: 3, paint: '#102040' }] })],
  ['grain', rect({ grain: { amount: 0.4, scale: 2, blend: 'softlight' } })],
  ['innerShadow', rect({ innerShadow: { color: '#000000', opacity: 0.7, size: 10, offset: [3, 4] } })],
  ['innerGlow', rect({ innerGlow: { color: '#ffff80', opacity: 0.8, size: 12, blend: 'add' } })],
  ['sheen', rect({ sheen: { opacity: 0.6, angle: 40, width: 0.2 } })],
  ['bigShadow', rect({ dropShadow: { color: '#000000', opacity: 0.6, blur: 14, offset: [6, 10], spread: 3 }, outerGlow: { color: '#ff00ff', opacity: 0.5, size: 9, spread: 2 } })],
  ['extrudeAngle', rect({ extrude: { depth: 7.5, angle: 60, color: { angle: 90, stops: [[0, '#203060'], [1, '#101830']] }, stroke: { width: 2, color: '#000000' } }, strokes: [{ width: 2.5, paint: '#ffffff' }] })],
  ['centerStroke', rect({ strokes: [{ width: 4, paint: { type: 'conic', stops: [[0, '#ff0000'], [0.5, '#00ff00'], [1, '#ff0000']] }, position: 'center' }] })],
  ['pixelArt', rect({ strokes: [{ width: 2, paint: '#000000' }], gloss: { opacity: 0.5 } }, [64, 40], { kind: 'rect', radius: 8 }, { pixel: { size: 2, levels: 5, dither: true } })],
  ['narrowed', DIRECTIONS.ember!.element({ kind: 'window', size: [1400, 900] })],
  ['bigWindow', rect({ bevel: { size: 4, style: 'chisel' }, dropShadow: { color: '#000', opacity: 0.6, blur: 20, offset: [0, 16] }, innerShadow: { color: '#000', size: 16, offset: [0, 6] }, patterns: [{ kind: 'grid', color: '#fff', opacity: 0.1, size: 24 }] }, [900, 560], { kind: 'cut', cut: [24, 0, 24, 0] })],
];
for (const [name, spec] of fx) add(`fx:${name}`, spec);

// Recipe libraries beside the directions (fx.ts light effects, props/ object art when there): any module exporting a
// list of kinds (…_KINDS) and a spec maker (…Spec(kind, size)) is forged at two sizes, every kind.
for (const mod of ['../../src/core/ui/forge/fx', '../../src/core/ui/forge/props/index', '../../src/core/ui/forge/props']) {
  const m = (await import(mod).catch(() => null)) as Record<string, unknown> | null;
  if (!m) continue;
  const kinds = Object.entries(m).find(([k, v]) => /_KINDS$/.test(k) && Array.isArray(v))?.[1] as string[] | undefined;
  const make = Object.entries(m).find(([k, v]) => /Spec$/.test(k) && typeof v === 'function')?.[1] as ((kind: string, size: [number, number], color?: string) => ForgeSpec) | undefined;
  if (!kinds || !make) continue;
  const lib = mod.split('/').filter((x) => x !== 'index').pop();
  for (const k of kinds)
    for (const size of [[120, 120], [220, 90]] as Array<[number, number]>) {
      try {
        add(`${lib}:${k}@${size.join('x')}`, make(k, size, '#ffd27a'));
      } catch {
        /* a kind that needs more than a size and colour */
      }
    }
}

// The coverage-bitmap path: layers sent as the CPU's own coverage instead of contours.
for (const [id, r] of [['candy', { kind: 'card', variant: 'rare', size: [150, 180] }], ['frost', { kind: 'icon', glyph: 'coins', size: [96, 96] }], ['ember', { kind: 'title', text: 'ARENA', size: [300, 80] }]] as Array<[string, ElementRequest]>) {
  const spec = DIRECTIONS[id]!.element(r);
  const plan = planForge(spec, cut);
  for (const l of plan.layers) {
    const s = l.shape as { points: Float32Array; counts: Uint32Array };
    const contours: Array<Array<[number, number]>> = [];
    let o = 0;
    for (const n of s.counts) {
      const c: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) c.push([s.points[(o + k) * 2]!, s.points[(o + k) * 2 + 1]!]);
      contours.push(c);
      o += n;
    }
    l.shape = { coverage: coverage(contours, l.region[2], l.region[3]).v, width: l.region[2], height: l.region[3] };
  }
  add(`cov:${id}:${r.kind}`, spec, plan);
}
writeFileSync(join(dir, 'specs.json'), JSON.stringify(items));

// A shop screen's 30 skins per direction, at their real sizes.
const glyphs = ['fish', 'dog', 'cat', 'rabbit', 'bird', 'turtle', 'snail', 'flame'];
const screen: ElementRequest[] = [
  { kind: 'window', size: [960, 600] },
  { kind: 'header', size: [840, 78] },
  { kind: 'title', text: 'PET SHOP', size: [340, 96] },
  { kind: 'close', size: [58, 58] },
  { kind: 'pill', size: [190, 46] },
  { kind: 'coin', glyph: 'coins', size: [52, 52] },
  { kind: 'coin', glyph: 'coins', size: [26, 26] },
  { kind: 'tab', variant: 'active', size: [150, 48] },
  { kind: 'tab', variant: 'inactive', size: [150, 48] },
  ...rar.map((v) => ({ kind: 'card', variant: v, size: [196, 214] }) as ElementRequest),
  ...glyphs.map((g, n) => ({ kind: 'icon', glyph: g, variant: rar[n % 5], size: [96, 96] }) as ElementRequest),
  { kind: 'button', variant: 'primary', size: [168, 50] },
  { kind: 'button', variant: 'secondary', size: [168, 50] },
  { kind: 'button', variant: 'danger', size: [120, 50] },
  { kind: 'badge', size: [54, 54] },
  { kind: 'barTrack', size: [240, 26] },
  { kind: 'barFill', size: [180, 26] },
  { kind: 'ribbon', size: [160, 40] },
  { kind: 'slot', variant: 'rare', size: [96, 96] },
];
const screens: unknown[] = [];
let n = 0;
for (const [id, d] of Object.entries(DIRECTIONS))
  for (const r of screen) {
    const spec = d.element(r);
    const t0 = performance.now();
    const f = forge(spec);
    const cpuMs = performance.now() - t0;
    writeFileSync(join(dir, `cpu-s${n}.rgba`), f.image.data);
    screens.push({ i: n, dir: id, name: `${id}:${r.kind}${r.variant ? ':' + r.variant : ''}${r.glyph ? ':' + r.glyph : ''}@${r.size.join('x')}`, plan: planToWire(planForge(spec, cut)), cpu: meta(f), cpuMs });
    n++;
  }
writeFileSync(join(dir, 'screen.json'), JSON.stringify(screens));
console.log(`${i} elements and ${n} screen skins forged on the CPU into ${dir}`);
