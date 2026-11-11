import type { Store } from '../db/store';

export type Subscription = 'claude' | 'codex';
export const isSubscription = (id: string): id is Subscription => id === 'claude' || id === 'codex';

function localDay(now: Date): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].join('-');
}

export class ModelQuotas {
  constructor(private readonly store: Store, private readonly clock = () => new Date()) {}

  private read(provider: Subscription, model: string, now: Date) {
    const maximum = this.store.get<{ maximum: number }>('SELECT maximum FROM model_daily_limits WHERE provider = ? AND model = ?', [provider, model])?.maximum ?? null;
    const used = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM model_launches WHERE provider = ? AND model = ? AND local_day = ?', [provider, model, localDay(now)])!.count;
    const resetAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    return { provider, model, maximum, used, resetAt, available: maximum === null || used < maximum };
  }

  status(provider: Subscription, model: string) { return this.read(provider, model, this.clock()); }

  set(provider: Subscription, model: string, maximum: number | null): void {
    if (!isSubscription(provider) || !model || model.length > 160 || (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0))) throw new Error('Invalid model quota');
    if (maximum === null) this.store.run('DELETE FROM model_daily_limits WHERE provider = ? AND model = ?', [provider, model]);
    else this.store.run('INSERT INTO model_daily_limits VALUES (?, ?, ?) ON CONFLICT(provider, model) DO UPDATE SET maximum = excluded.maximum', [provider, model, maximum]);
  }

  reserve(provider: Subscription, model: string, id: string): boolean {
    return this.store.tx(() => {
      const now = this.clock();
      if (!this.read(provider, model, now).available) return false;
      this.store.run('INSERT INTO model_launches VALUES (?, ?, ?, ?)', [id, provider, model, localDay(now)]);
      return true;
    });
  }

  release(id: string): void { this.store.run('DELETE FROM model_launches WHERE id = ?', [id]); }
}
