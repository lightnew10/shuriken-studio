/**
 * The mechanics every batch of uploads to Roblox shares (a model's meshes, a creature's animation clips):
 * at most `concurrency` uploads at the same time, one upload per thing at a time (a second request for
 * the same thing joins the one under way instead of sending it twice), and a way for a tool call to wait
 * for a batch for a while — reporting progress, giving up when its run stops or its budget is spent —
 * while the uploads themselves carry on and record their own results.
 */

/** Things uploaded at the same time. */
export const UPLOAD_CONCURRENCY = 6;

/**
 * How long a tool call waits for a batch of uploads before it answers "still uploading, call again" (the
 * uploads carry on; the next call joins them). An MCP client gives up on a call after about 5 minutes
 * without a sign of life, so an agent's call stays under that unless it reports progress (every 15 s);
 * the user's own buttons (no MCP timeout) wait longer.
 */
export const WAIT_AGENT_MS = 230_000;
export const WAIT_WITH_PROGRESS_MS = 600_000;
export const WAIT_UI_MS = 900_000;
export const waitBudget = (callerKind: string, hasProgress: boolean): number => (callerKind === 'ui' ? WAIT_UI_MS : hasProgress ? WAIT_WITH_PROGRESS_MS : WAIT_AGENT_MS);

/** How a batch of uploads is going (for the progress a tool call reports). */
export interface UploadProgress {
  /** Things that needed an upload and have finished (uploaded, pending at Roblox or failed). */
  done: number;
  /** Things that needed an upload. */
  total: number;
  message: string;
}

export interface BatchOptions {
  /** How long to wait before answering with what has finished so far. */
  budgetMs: number;
  /** Stops the waiting (never the uploads) when it aborts. */
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  /** Progress goes out at least this often while waiting (default 15 s): a sign of life for the caller. */
  heartbeatMs?: number;
  /** What the things are called in a progress message ("part", "clip"). */
  noun?: string;
}

export class UploadQueue<R extends { name: string }> {
  private readonly inflight = new Map<string, Promise<R>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency: () => number = () => UPLOAD_CONCURRENCY) {}

  private limit(): number {
    return Math.max(1, this.concurrency());
  }

  /** Runs `task` when fewer than `concurrency` are running (the rest wait their turn, in order). */
  private slot<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.waiting.shift()?.();
          });
      };
      if (this.active < this.limit()) start();
      else this.waiting.push(start);
    });
  }

  /** The thing under way for `key`, if any. */
  joining(key: string): Promise<R> | undefined {
    return this.inflight.get(key);
  }

  /** Keys that are uploading (or waiting their turn) right now. */
  keys(): string[] {
    return [...this.inflight.keys()];
  }

  /**
   * The upload of `key`: joins the one already under way, else runs `task` in its turn. Never rejects:
   * a task that throws becomes `onError(error)`.
   */
  run(key: string, task: () => Promise<R>, onError: (e: Error) => R): Promise<R> {
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.slot(task)
      .catch((e: unknown) => onError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /**
   * Waits for a batch: resolves when every item has settled, the budget is spent or the signal aborts,
   * whichever comes first, with what has settled (in the items' order) and the names that have not.
   * Those carry on in the background. `needed` are the items that actually have something to upload;
   * progress counts only those, and goes out as they finish and on a heartbeat.
   */
  async batch(items: Array<{ name: string; needed: boolean; promise: Promise<R> }>, opts: BatchOptions): Promise<{ results: R[]; stillUploading: string[] }> {
    const results = new Map<string, R>();
    const total = items.filter((i) => i.needed).length;
    const noun = opts.noun ?? 'part';
    let finished = 0;
    const report = () => {
      if (!opts.onProgress || !total) return;
      const left = total - finished;
      try {
        opts.onProgress({ done: finished, total, message: `Uploaded ${finished} of ${total} ${noun}${total === 1 ? '' : 's'} to Roblox${left ? ` (${Math.min(left, this.limit())} at a time, ${left} to go)` : ''}` });
      } catch {
        // progress is a courtesy: it never fails an upload
      }
    };
    const runs = items.map((i) =>
      i.promise.then((r) => {
        results.set(i.name, r);
        if (i.needed) finished++;
        report();
        return r;
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    let beat: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.budgetMs);
      timer.unref?.();
    });
    const stopped = new Promise<void>((resolve) => {
      if (!opts.signal) return;
      if (opts.signal.aborted) return resolve();
      onAbort = resolve;
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });
    if (opts.onProgress && total) {
      report();
      beat = setInterval(report, opts.heartbeatMs ?? 15_000);
      beat.unref?.();
    }
    try {
      await Promise.race([Promise.all(runs), budget, stopped]);
    } finally {
      clearTimeout(timer);
      if (beat) clearInterval(beat);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    }
    return { results: items.flatMap((i) => results.get(i.name) ?? []), stillUploading: items.filter((i) => !results.has(i.name)).map((i) => i.name) };
  }
}
