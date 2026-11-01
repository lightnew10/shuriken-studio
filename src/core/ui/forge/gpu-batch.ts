import type { ForgeGLRequest, ForgeGLResponse } from '@shared/forge-plan';
import { planForge, planToWire, unknownInSpec, type Cut } from '@shared/forge-plan';
import type { Forged, ForgeSpec } from './forge';
import type { ForgeBatch } from './resolve';
import { scaleShape, shapeContours } from './shapes';

/**
 * Forge specs drawn on the GPU (src/renderer/src/lib/forge-gl, on the app's hidden render page): the core plans each
 * element (the CPU forge's layout, its shapes cut here where the fonts and glyphs are), the page draws the plans and
 * sends the pixels back. A spec it can't draw comes back null, for the caller to forge on the CPU (resolve.ts
 * SkinForge.warm). Works from any thread given a way to reach the page: the core's own (core/index.ts asks the main
 * process) or a worker's (workerForgeTransport, answered by relayForgeGpu in the thread that started it).
 */

/** Sends a request to a page with the GPU forge; null when there is none to ask. */
export type ForgeGpuTransport = (req: ForgeGLRequest) => Promise<ForgeGLResponse | null>;

export const forgeCut: Cut = (s, x, y, w, h, k) => shapeContours(scaleShape(s, k), x, y, w, h);

/** Plans per request: big enough to keep the GPU busy, small enough that one JSON request stays a few MB. */
const CHUNK = 48;

export interface GpuBatchStats {
  gpu: string | null;
  requests: number;
  drawn: number;
  failed: number;
  /** Wall time, and its parts: planning here, the page's own time (decode, draw, read back), the rest is transport. */
  ms: number;
  planMs: number;
  pageMs: number;
}

/**
 * A batch renderer for resolve.ts setForgeBatch. After a page says it has no GPU forge (no WebGL2 with float
 * targets), every later batch answers null at once: the CPU forges, nothing waits on a page that can't help.
 */
export function gpuForgeBatch(send: ForgeGpuTransport, log?: (msg: string, data?: unknown) => void): ForgeBatch & { stats: GpuBatchStats } {
  const stats: GpuBatchStats = { gpu: null, requests: 0, drawn: 0, failed: 0, ms: 0, planMs: 0, pageMs: 0 };
  let unavailable = false;
  const batch = async (specs: ForgeSpec[]): Promise<Array<Forged | null>> => {
    const out: Array<Forged | null> = specs.map(() => null);
    if (unavailable || !specs.length) return out;
    const t0 = Date.now();
    // Plans first (the CPU's share: layout and contours); a spec that can't be planned is forged on the CPU.
    const planned: Array<{ i: number; wire: ReturnType<typeof planToWire> }> = [];
    specs.forEach((spec, i) => {
      // Something the GPU forge doesn't draw yet: the CPU does (the same pixels, only slower).
      if (unknownInSpec(spec)) return;
      try {
        planned.push({ i, wire: planToWire(planForge(spec, forgeCut)) });
      } catch {
        /* left to the CPU */
      }
    });
    stats.planMs += Date.now() - t0;
    for (let at = 0; at < planned.length; at += CHUNK) {
      const part = planned.slice(at, at + CHUNK);
      let res: ForgeGLResponse | null = null;
      try {
        res = await send({ plans: part.map((p) => p.wire) });
        stats.requests++;
      } catch (e) {
        log?.('GPU forge request failed', e instanceof Error ? e.message : String(e));
      }
      if (!res) break;
      if (res.gpu === null) {
        unavailable = true;
        log?.('No GPU forge on the render page: forging on the CPU', (res.items[0] as { error?: string } | undefined)?.error);
        break;
      }
      stats.gpu = res.gpu;
      stats.pageMs += res.ms;
      part.forEach((p, k) => {
        const it = res!.items[k];
        if (!it || 'error' in it || it.rgba.length !== it.width * it.height * 4) {
          stats.failed++;
          return;
        }
        const { width, height, rgba, ...meta } = it;
        // Bytes that crossed a process boundary may be a Buffer or a view: a plain Uint8Array of exactly the pixels.
        const data = rgba instanceof Uint8Array && rgba.constructor === Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        out[p.i] = { image: { width, height, data }, ...meta };
        stats.drawn++;
      });
    }
    stats.ms += Date.now() - t0;
    return out;
  };
  return Object.assign(batch, { stats });
}

// ─── Workers ───────────────────────────────────────────────────────────────────────────────────────

interface PortLike {
  postMessage(msg: unknown): void;
  on(event: 'message', fn: (msg: unknown) => void): unknown;
}

/**
 * In a worker thread: reaches the GPU forge through the thread that started the worker (relayForgeGpu there). Its
 * messages are `{ forgeGpu: { id, req } }` out and `{ forgeGpuResult: { id, res } }` back; a worker's own message
 * handler should leave those alone.
 */
export function workerForgeTransport(port: PortLike, timeoutMs = 120_000): ForgeGpuTransport {
  const waiting = new Map<number, (r: ForgeGLResponse | null) => void>();
  let seq = 1;
  port.on('message', (msg) => {
    const r = (msg as { forgeGpuResult?: { id: number; res: ForgeGLResponse | null } } | null)?.forgeGpuResult;
    if (!r) return;
    waiting.get(r.id)?.(r.res);
    waiting.delete(r.id);
  });
  return (req) =>
    new Promise((resolve) => {
      const id = seq++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, timeoutMs);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      port.postMessage({ forgeGpu: { id, req } });
    });
}

/** In the thread that started a worker: answers its GPU forge requests through `send`. */
export function relayForgeGpu(worker: PortLike, send: ForgeGpuTransport): void {
  worker.on('message', (msg) => {
    const q = (msg as { forgeGpu?: { id: number; req: ForgeGLRequest } } | null)?.forgeGpu;
    if (!q) return;
    void send(q.req).then(
      (res) => worker.postMessage({ forgeGpuResult: { id: q.id, res } }),
      () => worker.postMessage({ forgeGpuResult: { id: q.id, res: null } }),
    );
  });
}
