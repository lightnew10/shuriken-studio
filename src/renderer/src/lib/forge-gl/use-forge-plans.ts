import { useEffect, useRef, useState } from 'react';
import { planFromWire, type ForgePlansParams, type ForgePlansResult } from '@shared/forge-plan';
import type { Forged } from '@shared/forge-types';
import { rpc } from '../rpc';
import { forgedImageData, forgeGLUnavailable, sharedForgeGL } from './forge-page';

/**
 * Skins drawn live on this page's own GPU: the core plans them (forge.plans: layout and contours, about a millisecond
 * each), this page's forge draws them (a millisecond or so each, less when only colours changed: the shapes' fields
 * are cached). For previews that follow a dragged accent without a round trip through the core's CPU forge. Without
 * a GPU here (`gpu` null), every item carries an error and the page shows the core's CPU pictures instead.
 */

export interface ForgedSkin {
  spec: string;
  size: [number, number];
  /** The art (and what Forged reports: margin, scale, 9-slice), or why there is none. */
  forged: Forged | null;
  bitmap: ImageBitmap | null;
  error?: string;
}

export interface ForgePlansState {
  skins: ForgedSkin[];
  /** The GPU drawing them, or null when this page has none. */
  gpu: string | null;
  loading: boolean;
  /** The core's share and this page's, ms (the last draw). */
  ms: { plans: number; gpu: number };
}

/** Draws `skins` (asked again after `delay` ms when they change; answers to replaced asks are dropped). */
export function useForgePlans(skins: ForgePlansParams['skins'] | null, delay = 0): ForgePlansState {
  const key = skins ? JSON.stringify(skins) : '';
  const [state, setState] = useState<ForgePlansState>({ skins: [], gpu: null, loading: false, ms: { plans: 0, gpu: 0 } });
  const seq = useRef(0);
  useEffect(() => {
    if (!skins) return;
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      void forgeSkins(skins).then((r) => {
        if (my !== seq.current) {
          for (const s of r.skins) s.bitmap?.close();
          return;
        }
        setState((old) => {
          for (const s of old.skins) s.bitmap?.close();
          return { ...r, loading: false };
        });
      });
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay]);
  return state;
}

/** Plans `skins` in the core and draws them on this page's GPU forge. */
export async function forgeSkins(skins: ForgePlansParams['skins']): Promise<Omit<ForgePlansState, 'loading'>> {
  const gl = sharedForgeGL();
  if (!gl) return { skins: skins.map((s) => ({ spec: s.spec, size: s.size, forged: null, bitmap: null, error: `no GPU forge: ${forgeGLUnavailable()}` })), gpu: null, ms: { plans: 0, gpu: 0 } };
  let res: ForgePlansResult;
  try {
    res = await rpc<ForgePlansResult>('forge.plans', { skins } satisfies ForgePlansParams);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { skins: skins.map((s) => ({ spec: s.spec, size: s.size, forged: null, bitmap: null, error })), gpu: gl.renderer, ms: { plans: 0, gpu: 0 } };
  }
  const t0 = performance.now();
  const planned = res.items.map((it) => ('plan' in it ? planFromWire(it.plan) : null));
  const drawn = await gl.forgeMany(planned.filter((p) => p !== null));
  let k = 0;
  const out = await Promise.all(
    res.items.map(async (it, i): Promise<ForgedSkin> => {
      if (!planned[i]) return { spec: it.spec, size: it.size, forged: null, bitmap: null, error: 'error' in it ? it.error : 'not planned' };
      const f = drawn[k++]!;
      if (f instanceof Error) return { spec: it.spec, size: it.size, forged: null, bitmap: null, error: f.message };
      return { spec: it.spec, size: it.size, forged: f, bitmap: await createImageBitmap(forgedImageData(f)) };
    }),
  );
  return { skins: out, gpu: gl.renderer, ms: { plans: res.ms, gpu: performance.now() - t0 } };
}
