/**
 * One request at a time per method and parameters, shared by every view that asks: the task list was fetched four
 * times per change by four mounted views, the orchestrator state five times. A view that asks while a request is in
 * flight gets one more request after it (shared by all who asked meanwhile), so nobody gets data older than its ask.
 */
export class RpcCoalescer {
  private readonly inflight = new Map<string, { p: Promise<unknown>; next?: Promise<unknown> }>();
  constructor(private readonly call: (method: string, params: unknown) => Promise<unknown>) {}

  fetch<T>(key: string, method: string, params: unknown): Promise<T> {
    const cur = this.inflight.get(key);
    if (cur) {
      cur.next ??= cur.p.catch(() => undefined).then(() => this.start(key, method, params));
      return cur.next as Promise<T>;
    }
    return this.start(key, method, params) as Promise<T>;
  }

  private start(key: string, method: string, params: unknown): Promise<unknown> {
    const p: Promise<unknown> = this.call(method, params).finally(() => {
      if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
    });
    this.inflight.set(key, { p });
    return p;
  }
}
