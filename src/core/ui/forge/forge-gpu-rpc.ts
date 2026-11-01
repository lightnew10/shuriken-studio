import { resolveVersion } from '@shared/ui-mockup';
import { planForge, planToWire, unknownInSpec, type ForgePlanItem, type ForgePlansParams, type ForgePlansResult } from '@shared/forge-plan';
import { encodePng, type RgbaImage } from '../../modeling/png';
import { renderLab } from '../lab/core-overlays';
import { labDevice } from '../lab/devices';
import { formDevice } from '../lab/lab';
import { robloxFontPicker } from '../lab/lab-text';
import { robloxMeasure } from '../lab/roblox-fonts';
import { projectImages } from '../ui-pictures';
import { DIRECTIONS } from './directions';
import { SAMPLE_DEVICE, sampleScreens } from './forge-sample';
import { forgeCut, gpuForgeBatch, type ForgeGpuTransport } from './gpu-batch';
import { prepareSkins, skinsNeeded, SkinForge, warmSkins } from './resolve';
import { parseSkin, requestOf } from './spec';
import { TEMPLATES } from './templates';

/**
 * The GPU forge's RPCs. `forge.plans`: skins planned here (layout and contours: the fonts and glyphs are the core's)
 * for a page to draw on its own GPU forge (src/renderer/src/lib/forge-gl useForgePlans) — a live preview that redraws
 * as an accent is dragged. `forge.gpuPreview`: a template (or a direction's sample screen) worn with skins forged
 * through the app's GPU path (warmSkins → the render page) and through the CPU, timed, the two pictures compared:
 * the proof the path works in the app, and what it buys.
 */

export interface ForgeGpuHost {
  resourcesDir: string | null;
  /** The app's GPU forge (core/index.ts asks the main process); absent in tests and plain Node. */
  forgeGpu?: ForgeGpuTransport;
}

export function forgeGpuRpc(host: ForgeGpuHost): Record<string, (params: any) => unknown> {
  const plans = (params: ForgePlansParams): ForgePlansResult => {
    const t0 = Date.now();
    const items = (params?.skins ?? []).slice(0, 400).map((s): ForgePlanItem => {
      const size: [number, number] = [Math.max(4, Math.min(1600, Number(s.size?.[0]) || 0)), Math.max(4, Math.min(1200, Number(s.size?.[1]) || 0))];
      const p = parseSkin(String(s.spec ?? ''));
      if ('error' in p) return { spec: s.spec, size, error: p.error };
      try {
        const spec = DIRECTIONS[p.spec.direction]!.element(requestOf(p.spec, size), p.spec.accent);
        const why = unknownInSpec(spec);
        if (why) return { spec: s.spec, size, error: `the GPU forge doesn't draw ${why} yet` };
        return { spec: s.spec, size, plan: planToWire(planForge(s.scale ? { ...spec, scale: s.scale } : spec, forgeCut)) };
      } catch (e) {
        return { spec: s.spec, size, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { items, ms: Date.now() - t0 };
  };

  const gpuPreview = async (params: { template?: string; direction?: string; accent?: string; device?: string; forgeScale?: number; scale?: number }) => {
    const direction = params?.direction && DIRECTIONS[params.direction] ? params.direction : 'candy';
    const accent = params?.accent && /^#[0-9a-f]{6}$/i.test(params.accent) ? params.accent : undefined;
    const t = params?.template && TEMPLATES[params.template] ? TEMPLATES[params.template]! : null;
    const mock = t ? t.build({ direction, ...(accent ? { accent } : {}) }).screens : sampleScreens(direction, accent);
    const dev = labDevice(params?.device ?? (t ? 'desktop' : SAMPLE_DEVICE));
    if (!dev) throw new Error(`No device "${params?.device}"`);
    const screens = resolveVersion({ screens: mock }, formDevice(dev)).screens;
    const forgeScale = Math.max(0.5, Math.min(2, Number(params?.forgeScale) || 2));
    const needed = skinsNeeded(screens);
    const glyphs = projectImages('', host.resourcesDir);
    const draw = (sf: SkinForge) => {
      const p = prepareSkins(screens, sf);
      const art = new Map<string, RgbaImage>();
      for (const [k, f] of p.used) art.set(`skin:${k}`, f.image);
      const view = renderLab(p.screens, dev, { images: (ref, px) => art.get(ref) ?? glyphs(ref, px), roblox: 'controls', core: { chat: false, playerList: false }, backdrop: 'dark', scale: Number(params?.scale) || 1, rulers: false, measure: robloxMeasure, fonts: robloxFontPicker });
      return { image: view.image, used: p.used.size, errors: p.errors };
    };

    // The GPU path as the app uses it, from cold: every skin in one batch through the registered renderer (warmSkins),
    // then worn from the cache and drawn.
    const t0 = Date.now();
    const sfGpu = new SkinForge(null, forgeScale);
    await warmSkins(screens, sfGpu);
    const viaGpu = draw(sfGpu);
    const gpuPathMs = Date.now() - t0;
    // The batch again on its own (the page's fields now cached): what a colour change costs, the round trip included.
    let gpu: string | null = null;
    let gpuDrawn = 0;
    let gpuBatchMs = 0;
    let gpuParts: { planMs: number; pageMs: number } | null = null;
    if (host.forgeGpu) {
      const b = gpuForgeBatch(host.forgeGpu);
      const specs = needed.flatMap((n) => {
        const p = parseSkin(n.spec);
        return 'error' in p ? [] : [{ ...DIRECTIONS[p.spec.direction]!.element(requestOf(p.spec, n.size), p.spec.accent), scale: forgeScale }];
      });
      const tb = Date.now();
      const out = await b(specs);
      gpuBatchMs = Date.now() - tb;
      gpuDrawn = out.filter(Boolean).length;
      gpu = b.stats.gpu;
      gpuParts = { planMs: b.stats.planMs, pageMs: Math.round(b.stats.pageMs) };
    }
    const t1 = Date.now();
    const viaCpu = draw(new SkinForge(null, forgeScale));
    const cpuPathMs = Date.now() - t1;

    // The two pictures, pixel by pixel (they differ only where the GPU and CPU art differ).
    const a = viaGpu.image.data;
    const c = viaCpu.image.data;
    let sum = 0;
    let off = 0;
    for (let i = 0; i < a.length; i += 4) {
      let px = 0;
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(a[i + k]! - c[i + k]!);
        sum += d / 3;
        if (d > px) px = d;
      }
      if (px > 8) off++;
    }
    const n = a.length / 4;
    return {
      gpu,
      template: t?.id ?? 'sample',
      direction,
      device: dev.id,
      skins: needed.length,
      gpuDrawn,
      gpuBatchMs,
      gpuParts,
      gpuPathMs,
      cpuPathMs,
      speedup: Math.round((cpuPathMs / Math.max(1, gpuPathMs)) * 10) / 10,
      picture: { w: viaGpu.image.width, h: viaGpu.image.height, meanDiff: Math.round((sum / n) * 1000) / 1000, pctOff: Math.round(((100 * off) / n) * 1000) / 1000 },
      errors: viaGpu.errors.slice(0, 5),
      content: [{ type: 'image', mimeType: 'image/png', data: encodePng(viaGpu.image).toString('base64') }],
    };
  };

  return {
    'forge.plans': (params: ForgePlansParams) => plans(params),
    'forge.gpuPreview': (params: { template?: string; direction?: string; accent?: string; device?: string; forgeScale?: number; scale?: number }) => gpuPreview(params),
  };
}
