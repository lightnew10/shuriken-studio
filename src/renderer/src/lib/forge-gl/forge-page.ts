import { createForgeGL, type ForgeGL } from './forge-gl';
import { planFromWire, type ForgeGLItem, type ForgeGLRequest, type ForgeGLResponse } from '@shared/forge-plan';
import type { Forged } from '@shared/forge-types';

/**
 * The GPU forge behind a page: one shared engine per page (null where WebGL2 with float targets is missing), and the
 * request the app's hidden render page answers for the core — plans in (JSON, contours as base64), straight RGBA out
 * as bytes (executeJavaScript hands a Uint8Array back whole; the core encodes the PNG, exactly as for its own forge).
 * An item the GPU can't draw comes back as an error for the core to forge on the CPU.
 */

export type { ForgeGLItem, ForgeGLRequest, ForgeGLResponse };

let engine: ForgeGL | null | undefined;
let engineError = '';

/** The page's engine, made on first use; null (and why, in forgeGLUnavailable()) when this page can't have one. */
export function sharedForgeGL(): ForgeGL | null {
  if (engine === undefined) {
    try {
      engine = createForgeGL();
    } catch (e) {
      engine = null;
      engineError = e instanceof Error ? e.message : String(e);
    }
  }
  return engine;
}

export const forgeGLUnavailable = (): string => engineError;

/** Forges a request's plans on the shared engine. */
export async function forgeRequest(req: ForgeGLRequest): Promise<ForgeGLResponse> {
  const t0 = performance.now();
  const gl = sharedForgeGL();
  if (!gl) return { gpu: null, items: req.plans.map(() => ({ error: `no GPU forge: ${engineError}` })), ms: 0 };
  const plans = req.plans.map((w) => {
    try {
      return planFromWire(w);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
  const ok = plans.filter((p) => !(p instanceof Error));
  const out = ok.length ? await gl.forgeMany(ok as Exclude<(typeof plans)[number], Error>[]) : [];
  // A lost context (driver reset, GPU process restart) is gone for good: the next request makes a new engine.
  if (gl.lost()) {
    gl.dispose();
    engine = undefined;
  }
  let k = 0;
  const items = plans.map((p): ForgeGLItem => {
    if (p instanceof Error) return { error: p.message };
    const r = out[k++]!;
    if (r instanceof Error) return { error: r.message };
    const { image, ...meta } = r;
    return { width: image.width, height: image.height, rgba: image.data, ...meta };
  });
  return { gpu: gl.renderer, items, ms: performance.now() - t0 };
}

/** Makes this page answer `window.__forge(request)` (the hidden render page; main calls it like __render). */
export function installForgePage(): void {
  (window as Window & { __forge?: (req: ForgeGLRequest) => Promise<ForgeGLResponse> }).__forge = forgeRequest;
}

/** A forged image as ImageData (straight alpha, as canvases take it) for drawing a preview. */
export function forgedImageData(f: Forged): ImageData {
  const px = new Uint8ClampedArray(f.image.data.byteLength);
  px.set(f.image.data);
  return new ImageData(px, f.image.width, f.image.height);
}
