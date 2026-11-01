/**
 * Rejections that carry no news. A write to a web stream that closed a moment before ("Invalid state:
 * ReadableStream is already closed", ERR_INVALID_STATE from Node's stream controllers) is how undici's
 * request-body pump and similar code report a request that was aborted under them: nobody is waiting for
 * what they were writing. They are not bugs to chase every time a batch of runs is stopped.
 */
export function isClosedStreamWrite(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  return e?.code === 'ERR_INVALID_STATE' && typeof e.message === 'string' && /(ReadableStream|Controller|WritableStream) is already closed/i.test(e.message);
}

/**
 * Counts events that arrive in a burst and says when to report them: the first one at once, then one
 * summary per `intervalMs` (the number since the last report). A storm of the same rejection is one log
 * line, not thirty.
 */
export class BurstReporter {
  private pending = 0;
  private lastReport = -Infinity;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one event; returns how many to report now (0 = stay quiet). */
  hit(): number {
    this.pending++;
    const t = this.now();
    if (t - this.lastReport < this.intervalMs) return 0;
    this.lastReport = t;
    const n = this.pending;
    this.pending = 0;
    return n;
  }
}
