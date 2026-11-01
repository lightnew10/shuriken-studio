import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import type { Forged as CoreForged, ForgeSpec as CoreSpec } from '../src/core/ui/forge/forge';
import { forge, scaleStyle as coreScaleStyle } from '../src/core/ui/forge/forge';
import type { LayerStyle as CoreStyle } from '../src/core/ui/forge/style';
import { fillHoles as coreFillHoles, styleMargin as coreStyleMargin } from '../src/core/ui/forge/style';
import type { ShapeSpec as CoreShape } from '../src/core/ui/forge/shapes';
import { scaleShape, shapeContours } from '../src/core/ui/forge/shapes';
import { coverage } from '../src/core/ui/forge/canvas';
import { DIRECTIONS, type ElementRequest } from '../src/core/ui/forge/directions';
import { fillHoles, planForge, planFromWire, planToWire, scaleStyle, styleMargin, unknownInSpec, type Cut } from '../src/shared/forge-plan';
import type { Forged, ForgeSpec, LayerStyle, ShapeSpec } from '../src/shared/forge-types';
import type { ForgeGLRequest, ForgeGLResponse } from '../src/shared/forge-plan';
import { gpuForgeBatch, relayForgeGpu, workerForgeTransport } from '../src/core/ui/forge/gpu-batch';

/**
 * The GPU forge (src/renderer/src/lib/forge-gl) draws plans that mirror the CPU forge's layout and reads recipes in
 * restated types: both must keep up with src/core/ui/forge. Its pixels are checked against the CPU's by the GPU parity
 * harness (it needs Electron); these checks are the part that runs in Node.
 */

// The restated types are the core's (a failure here: update src/shared/forge-types.ts to match).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameSpec: Same<CoreSpec, ForgeSpec> = true;
const sameStyle: Same<CoreStyle, LayerStyle> = true;
const sameShape: Same<CoreShape, ShapeSpec> = true;
const sameForged: Same<CoreForged, Forged> = true;

const cut: Cut = (s, x, y, w, h, k) => shapeContours(scaleShape(s, k), x, y, w, h);

const requests: ElementRequest[] = [
  { kind: 'button', variant: 'primary', size: [170, 56] },
  { kind: 'card', variant: 'epic', size: [150, 180] },
  { kind: 'title', text: 'SHOP', size: [240, 70] },
  { kind: 'icon', glyph: 'sword', variant: 'rare', size: [72, 72] },
  { kind: 'coin', size: [40, 40] },
];

describe('forge-gl plans', () => {
  it('restates the core types', () => {
    expect([sameSpec, sameStyle, sameShape, sameForged]).toEqual([true, true, true, true]);
  });

  it('lay elements out as the CPU forge does', () => {
    const specs: ForgeSpec[] = [];
    for (const d of Object.values(DIRECTIONS)) for (const r of requests) specs.push(d.element(r));
    // Big art (capped at 1024 px and narrowed) and pixel art.
    specs.push({ ...DIRECTIONS.candy!.element({ kind: 'window', size: [1400, 900] }) });
    specs.push({ size: [64, 40], pixel: { size: 2, levels: 5, dither: true }, layers: [{ shape: { kind: 'rect', radius: 8 }, style: { fill: '#3080ff', strokes: [{ width: 2, paint: '#000000' }] } }] });
    for (const spec of specs) {
      const plan = planForge(spec, cut);
      const f = forge(spec);
      const k = plan.pixel?.k ?? 1;
      const { image, ...meta } = f;
      expect({ width: plan.width * k, height: plan.height * k, ...plan.meta }).toEqual({ width: image.width, height: image.height, ...meta });
    }
  });

  it('know every field the directions use (an unknown one sends the element to the CPU)', () => {
    for (const d of Object.values(DIRECTIONS)) for (const r of requests) expect(unknownInSpec(d.element(r))).toBeNull();
    const spec = DIRECTIONS.candy!.element({ kind: 'button', size: [120, 40] });
    expect(unknownInSpec({ ...spec, layers: [{ ...spec.layers[0]!, style: { ...spec.layers[0]!.style, halo: { size: 3 } } as LayerStyle }] })).toBe('style.halo');
    expect(unknownInSpec({ ...spec, layers: [{ ...spec.layers[0]!, style: { ...spec.layers[0]!.style, gloss: { style: 'mirror' } } as unknown as LayerStyle }] })).toBe('gloss style "mirror"');
  });

  it('scale styles and measure their margins as the core does', () => {
    for (const d of Object.values(DIRECTIONS))
      for (const r of requests)
        for (const l of d.element(r).layers) {
          expect(styleMargin(l.style)).toBe(coreStyleMargin(l.style));
          expect(scaleStyle(l.style, 1.5)).toEqual(coreScaleStyle(l.style, 1.5));
        }
  });

  it('fill a solid glyph’s holes as the core does', () => {
    const c = coverage(shapeContours({ kind: 'glyph', name: 'coins', weight: 2.4 }, 4, 4, 120, 120), 128, 128);
    const mine = c.v.slice();
    coreFillHoles(c);
    fillHoles(mine, 128, 128);
    expect(Array.from(mine)).toEqual(Array.from(c.v));
  });

  it('cross to the render page as JSON and back', () => {
    const plan = planForge(DIRECTIONS.ember!.element({ kind: 'icon', glyph: 'shield', size: [64, 64] }), cut);
    const back = planFromWire(JSON.parse(JSON.stringify(planToWire(plan))));
    expect(back.layers.length).toBe(plan.layers.length);
    back.layers.forEach((l, i) => {
      const o = plan.layers[i]!;
      expect({ ...l, shape: null }).toEqual({ ...o, shape: null });
      expect(l.shape).toEqual(o.shape);
    });
  });

  it('come back from the GPU as Forged, null where it fails, and stop asking a page without one', async () => {
    const specs: ForgeSpec[] = [DIRECTIONS.candy!.element({ kind: 'button', size: [120, 40] }), DIRECTIONS.neon!.element({ kind: 'badge', size: [40, 40] })];
    let asked = 0;
    // A page that draws the first plan (blank pixels of the plan's size) and fails the second.
    const page = async (req: ForgeGLRequest): Promise<ForgeGLResponse> => {
      asked++;
      const items = req.plans.map((w, i) => (i === 0 ? { width: w.width * (w.pixel?.k ?? 1), height: w.height * (w.pixel?.k ?? 1), rgba: new Uint8Array(w.width * w.height * 4), ...w.meta } : { error: 'nope' }));
      return { gpu: 'test GPU', items, ms: 1 };
    };
    const out = await gpuForgeBatch(page)(specs);
    const cpu = forge(specs[0]!);
    expect(out[0]).toMatchObject({ size: cpu.size, margin: cpu.margin, scale: cpu.scale, slice: cpu.slice, image: { width: cpu.image.width, height: cpu.image.height } });
    expect(out[1]).toBeNull();
    const none = gpuForgeBatch(async (req) => (asked++, { gpu: null, items: req.plans.map(() => ({ error: 'no WebGL2' })), ms: 0 }));
    asked = 0;
    expect(await none(specs)).toEqual([null, null]);
    expect(await none(specs)).toEqual([null, null]);
    expect(asked).toBe(1);
  });

  it('reach the GPU from a worker through the thread that started it', async () => {
    const { port1, port2 } = new MessageChannel();
    relayForgeGpu(port1, async (req) => ({ gpu: 'relayed', items: req.plans.map(() => ({ error: 'x' })), ms: 0 }));
    const res = await workerForgeTransport(port2)({ plans: [] });
    port1.close();
    expect(res).toEqual({ gpu: 'relayed', items: [], ms: 0 });
  });
});
