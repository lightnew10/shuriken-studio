import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreStatus } from '../../../preload/api';
import { RpcCoalescer } from './rpc-coalescer';

export const api = window.shuriken;

export function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  return api.invoke<T>(method, params);
}

type Listener = (channel: string, payload: unknown) => void;
const listeners = new Set<Listener>();
api.on((channel, payload) => {
  for (const l of listeners) l(channel, payload);
});

export function useCoreEvent(channels: string[] | '*', fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  const key = channels === '*' ? '*' : channels.join(',');
  useEffect(() => {
    const set = channels === '*' ? null : new Set(channels);
    const l: Listener = (c, p) => {
      if (!set || set.has(c)) ref.current(c, p);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

const shared = new RpcCoalescer((m, p) => rpc(m, p));

/** How soon after a change a view reads again (at most this often while changes keep coming). */
export const REFRESH_MS = 250;

export interface RpcState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch via RPC and re-fetch (debounced) whenever one of `refreshOn` channels fires.
 * Pass method = null to skip.
 */
export function useRpc<T>(method: string | null, params?: unknown, refreshOn: string[] = [], deps: unknown[] = []): RpcState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paramsKey = JSON.stringify(params ?? null);

  const load = useCallback(() => {
    if (!method) return;
    const my = ++seq.current;
    setLoading(true);
    shared
      .fetch<T>(`${method}|${paramsKey}`, method, params)
      .then((d) => {
        if (my === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (my === seq.current) setError(e.message.replace(/^Error invoking remote method 'rpc': Error: /, ''));
      })
      .finally(() => {
        if (my === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, paramsKey, ...deps]);

  useEffect(() => {
    load();
  }, [load]);

  // A change is read REFRESH_MS after it, and a stream of changes at most that often (a timer reset on every event
  // never fired while agents worked). A hidden window reads nothing until it is shown again.
  const stale = useRef(false);
  useCoreEvent(refreshOn.length ? [...refreshOn, 'project.changed'] : ['project.changed'], () => {
    if (typeof document !== 'undefined' && document.hidden) {
      stale.current = true;
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      load();
    }, REFRESH_MS);
  });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const shown = () => {
      if (!document.hidden && stale.current) {
        stale.current = false;
        load();
      }
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load]);

  return { data, error, loading, reload: load };
}

export function useCoreStatus(): CoreStatus {
  const [s, setS] = useState<CoreStatus>({ state: 'starting' });
  useEffect(() => {
    void api.status().then(setS);
    return api.onStatus(setS);
  }, []);
  return s;
}

/** Run an action with busy/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError((e as Error).message.replace(/^Error invoking remote method 'rpc': Error: /, ''));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  );
  return { run, busy, error, clearError: () => setError(null) };
}

/** Smoke/screenshot mode: select the first (or best) item automatically so detail panels render. */
export function useAutoSelect<T>(items: T[] | undefined, selected: unknown, select: (item: T) => void, pick?: (items: T[]) => T | undefined): void {
  useEffect(() => {
    if (!(window as unknown as { __shurikenAutoSelect?: boolean }).__shurikenAutoSelect) return;
    if (selected || !items || items.length === 0) return;
    const item = pick ? pick(items) : items[0];
    if (item !== undefined) select(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selected]);
}
