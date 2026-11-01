/** Promise-chain mutex: serializes access to a shared resource (e.g. Studio play mode). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private held = false;

  get locked(): boolean {
    return this.held;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.held = true;
      try {
        return await fn();
      } finally {
        this.held = false;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
