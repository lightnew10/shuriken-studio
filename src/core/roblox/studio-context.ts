import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is behind the Studio calls made inside one tool call. The tool registry runs every handler inside
 * `withStudioCaller`, so the Studio adapter knows (without every tool passing it along) which run is calling:
 * its own playtest never makes it wait, someone else's does, and a wait can tell the caller what it is
 * waiting for. Calls made outside a tool call (verification, auto-save, the app's own views) carry no
 * caller and are never held back.
 */
export interface StudioCaller {
  /** The id this caller holds play mode under: a run id, or "kind:role" for the UI and the system. */
  owner: string | null;
  /** 'agent' | 'ui' | …: how long it may wait (an MCP client without progress notes gives up after ~5 minutes). */
  kind: string;
  /** Tells the caller what the call is waiting for (MCP progress notes); absent when the client wants none. */
  progress?: (message: string) => void;
  signal?: AbortSignal;
  /** The tool call is over: work it left running in the background is not its caller any more. */
  ended?: boolean;
}

const store = new AsyncLocalStorage<StudioCaller | null>();

/** Runs `fn` as `caller`'s tool call. */
export async function withStudioCaller<T>(caller: StudioCaller, fn: () => Promise<T>): Promise<T> {
  const ctx: StudioCaller = { ...caller };
  try {
    return await store.run(ctx, fn);
  } finally {
    ctx.ended = true;
  }
}

/** The tool call this code runs inside, if it is still going. */
export function currentStudioCaller(): StudioCaller | null {
  const c = store.getStore();
  return c && !c.ended ? c : null;
}

/** Runs `fn` as nobody's tool call (code that holds Studio on its own account, e.g. verification). */
export function detachStudioCaller<T>(fn: () => T): T {
  return store.run(null, fn);
}
