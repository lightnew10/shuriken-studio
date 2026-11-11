import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelTier } from '@shared/domain';
import type { Store } from '../db/store';
import { ApiFailure, type FreeApiAccounts, type FreeApiId, type FreeModel } from '../providers/free-api';
import type { ReadyRoute } from '../providers/run-routing';
import type { CollaborationService } from './collaboration-service';

const modelSchema = z.object({ id: z.string().regex(/^[a-z0-9._:/-]{1,160}$/i), tools: z.boolean(), images: z.boolean(), maxImages: z.number().int().min(1).max(20).optional() });
const offerSchema = z.object({
  id: z.string().uuid(), label: z.string().max(80), provider: z.enum(['groq', 'openrouter']),
  maximum: z.number().int().min(1).max(10000), used: z.number().int().nonnegative(),
  ready: z.boolean(), retryAt: z.number().int().nonnegative().nullable(), resetAt: z.number().int().nonnegative(),
  models: z.object({ fast: modelSchema.nullable(), balanced: modelSchema.nullable(), deep: modelSchema.nullable() }),
}).strict();
type Offer = z.infer<typeof offerSchema>;
type Grant = { key_id: string; offer_id: string; maximum: number };
const id = z.string().uuid();
const retryTime = z.number().int().nonnegative().nullable();
const serviceWait = z.object({ groq: retryTime, openrouter: retryTime });
const chunkSchema = z.object({ kind: z.literal('chunk'), id, index: z.number().int().min(0).max(224), total: z.number().int().min(1).max(225), text: z.string().max(24_000).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offers'), offers: z.array(offerSchema).max(200), order: z.array(id).max(400).optional(), backoff: serviceWait.optional() }).strict(),
  z.object({ kind: z.literal('infer'), id, offer: id, tier: z.enum(['fast', 'balanced', 'deep']), model: z.string().max(160), body: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('reply'), id, result: z.unknown() }).strict(),
  z.object({ kind: z.literal('failure'), id, status: z.number().int().min(400).max(599), retryAt: z.number().int().nullable() }).strict(),
  z.object({ kind: z.literal('cancel'), id }).strict(),
]);

function localDay(): { day: string; resetAt: number } {
  const now = new Date();
  return {
    day: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
    resetAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(),
  };
}

export class InferencePool {
  private remote: Offer[] = [];
  private remoteOrder: string[] = [];
  private remoteBackoff: z.infer<typeof serviceWait> | undefined;
  private readonly offerWait = new Map<string, number>();
  private readonly outgoing = new Map<string, { offer: string; stop: () => void; finish: (error: ApiFailure | null, result?: unknown) => void }>();
  private readonly incoming = new Map<string, { offer: string; abort: AbortController }>();
  private readonly chunks = new Map<string, { total: number; parts: string[]; expires: number }>();

  private lastOffers = '';
  private readonly poll = setInterval(() => {
    if (this.session.ready()) this.refresh();
  }, 30_000).unref();

  constructor(private readonly db: Store, private readonly api: FreeApiAccounts, private readonly session: CollaborationService, private readonly changed: () => void, private readonly order: () => string[] = () => []) {}

  dispose(): void { clearInterval(this.poll); }

  private grants(): Grant[] {
    const room = this.session.roomId();
    return room ? this.db.all<Grant>('SELECT key_id,offer_id,maximum FROM coop_grants WHERE room = ? ORDER BY rowid', [room]) : [];
  }

  private usage(key: string, day: string): number {
    return this.db.get<{ used: number }>('SELECT count(*) AS used FROM coop_inferences WHERE key_id = ? AND local_day = ?', [key, day])!.used;
  }

  private local(): Offer[] {
    const models = this.api.selections(), { day, resetAt } = localDay();
    const accounts = new Map(this.api.list().map((key) => [key.id, key]));
    return this.grants().flatMap((grant) => {
      const key = accounts.get(grant.key_id);
      if (!key) return [];
      const choose = (tier: ModelTier) => key.models.find((m) => m.id === models[key.provider][tier]) ?? null;
      return [{
        id: grant.offer_id, label: key.label, provider: key.provider, maximum: grant.maximum,
        used: this.usage(grant.key_id, day), ready: key.enabled && key.state === 'ready',
        retryAt: key.retryAt, resetAt, models: { fast: choose('fast'), balanced: choose('balanced'), deep: choose('deep') },
      }];
    });
  }

  status() {
    const grants = this.grants();
    const order = this.session.secureRole() === 'host' ? this.order() : this.remoteOrder;
    const rank = (id: string) => order.includes(id) ? order.indexOf(id) : Number.MAX_SAFE_INTEGER;
    const now = Date.now();
    const projectId = this.session.boundProject();
    const offers = [...this.local().map((offer) => ({ ...offer, owner: 'local' as const })), ...this.remote.map((offer) => ({ ...offer, owner: 'peer' as const }))]
      .map((offer) => {
        const retryAt = Math.max(offer.retryAt ?? 0, offer.used >= offer.maximum ? offer.resetAt : 0,
          this.offerWait.get(offer.id) ?? 0, (projectId ? this.blocked(projectId, offer.provider) : this.remoteBackoff?.[offer.provider]) ?? 0);
        return { ...offer, retryAt: retryAt > now ? retryAt : null };
      });
    offers.sort((a, b) => rank(a.id) - rank(b.id));
    return {
      localKeys: this.api.list().map((key) => ({ id: key.id, label: key.label, provider: key.provider, ready: key.enabled && key.state === 'ready', maximum: grants.find((grant) => grant.key_id === key.id)?.maximum ?? null })),
      offers,
    };
  }

  share(key: string, maximum: number | null): void {
    const room = this.session.roomId();
    if (!room) throw new Error('Join a collaboration session first');
    if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000)) throw new Error('Invalid daily key limit');
    if (maximum === null) {
      const prior = this.grants().find((grant) => grant.key_id === key);
      this.db.run('DELETE FROM coop_grants WHERE room = ? AND key_id = ?', [room, key]);
      for (const call of this.incoming.values()) if (call.offer === prior?.offer_id) call.abort.abort();
    } else {
      const account = this.api.list().find((item) => item.id === key && item.enabled && item.state === 'ready');
      if (!account) throw new Error('Verify the key before contributing it');
      this.db.run('INSERT INTO coop_grants VALUES (?,?,?,?) ON CONFLICT(room,key_id) DO UPDATE SET maximum=excluded.maximum', [room, key, randomUUID(), maximum]);
    }
    this.refresh();
  }

  refresh(): void {
    const offers = this.local();
    for (const call of this.incoming.values()) if (!offers.some((offer) => offer.id === call.offer && offer.ready)) call.abort.abort();
    if (this.session.ready()) {
      const project = this.session.boundProject();
      const value = { kind: 'offers' as const, offers, ...(project ? { order: this.order(),
        backoff: { groq: this.blocked(project, 'groq'), openrouter: this.blocked(project, 'openrouter') } } : {}) };
      const serialized = JSON.stringify(value);
      if (serialized === this.lastOffers) return;
      try { this.send(value); this.lastOffers = serialized; } catch { /* pairing is closing */ }
    }
    this.changed();
  }

  onConnection(online: boolean): void {
    if (online) { this.refresh(); return; }
    this.lastOffers = '';
    this.remote = [];
    this.remoteBackoff = undefined;
    for (const call of this.incoming.values()) call.abort.abort();
    for (const call of this.outgoing.values()) call.finish(new ApiFailure('Collaborator disconnected', 409));
    this.outgoing.clear();
    this.chunks.clear();
    this.changed();
  }

  private send(value: z.infer<typeof messageSchema>): void {
    const text = Buffer.from(JSON.stringify(value)).toString('base64url');
    if (text.length > 5_400_000) throw new ApiFailure('Collaboration payload exceeds limit', 400);
    const chunkId = randomUUID(), total = Math.ceil(text.length / 24_000);
    for (let index = 0; index < total; index++) this.session.sendCoop({ kind: 'chunk', id: chunkId, index, total, text: text.slice(index * 24_000, (index + 1) * 24_000) });
  }

  receive(input: unknown): void {
    const chunk = chunkSchema.safeParse(input);
    if (!chunk.success) return;
    const data = chunk.data;
    for (const [key, saved] of this.chunks) if (saved.expires < Date.now()) this.chunks.delete(key);
    if (!this.chunks.has(data.id)) {
      if (data.index !== 0 || this.chunks.size >= 3) return;
      this.chunks.set(data.id, { total: data.total, parts: [], expires: Date.now() + 15_000 });
    }
    const saved = this.chunks.get(data.id)!;
    if (data.total !== saved.total || data.index !== saved.parts.length) { this.chunks.delete(data.id); return; }
    saved.parts.push(data.text);
    if (saved.parts.length !== saved.total) return;
    this.chunks.delete(data.id);
    let value: unknown;
    try { value = JSON.parse(Buffer.from(saved.parts.join(''), 'base64url').toString('utf8')); } catch { return; }
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.kind === 'offers') {
      this.remote = message.offers;
      for (const call of this.outgoing.values()) if (!this.remote.some((offer) => offer.id === call.offer && offer.ready)) call.stop();
      if (this.session.secureRole() === 'guest') {
        this.remoteOrder = message.order ?? [];
        this.remoteBackoff = message.backoff;
      }
      this.changed();
    }
    else if (message.kind === 'infer' && this.session.secureRole() === 'guest' && this.incoming.size < 4 && !this.incoming.has(message.id)) {
      const abort = new AbortController();
      this.incoming.set(message.id, { offer: message.offer, abort });
      void this.localInference(message.id, message.offer, message.tier, message.model, message.body, AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]))
        .then((result) => this.send({ kind: 'reply', id: message.id, result }))
        .catch((error) => {
          try { this.send({ kind: 'failure', id: message.id, status: error instanceof ApiFailure ? error.status : 409, retryAt: error instanceof ApiFailure ? error.retryAt : null }); } catch { /* offline */ }
        }).finally(() => this.incoming.delete(message.id));
    } else if (message.kind === 'cancel' && this.session.secureRole() === 'guest') this.incoming.get(message.id)?.abort.abort();
    else if (message.kind === 'reply' && this.session.secureRole() === 'host') this.outgoing.get(message.id)?.finish(null, message.result);
    else if (message.kind === 'failure' && this.session.secureRole() === 'host') this.outgoing.get(message.id)?.finish(new ApiFailure('Collaborator API request unavailable', message.status, message.retryAt));
  }

  private async localInference(id: string, offerId: string, tier: ModelTier, modelId: string, body: Record<string, unknown>, signal: AbortSignal, allowed = () => true): Promise<unknown> {
    const grant = this.grants().find((item) => item.offer_id === offerId);
    const offer = this.local().find((item) => item.id === offerId), model = offer?.models[tier];
    if (!grant || !offer?.ready || !model || model.id !== modelId) throw new ApiFailure('Key grant revoked or model changed', 409);
    if (offer.retryAt) throw new ApiFailure('Provider quota is cooling down', 429, offer.retryAt);
    const { day, resetAt } = localDay();
    signal.throwIfAborted();
    this.db.tx(() => {
      if (this.db.get('SELECT 1 FROM coop_inferences WHERE id = ?', [id])) throw new ApiFailure('Inference already submitted', 409);
      const current = this.db.get<Grant>('SELECT key_id,offer_id,maximum FROM coop_grants WHERE offer_id = ?', [offerId]);
      if (!current || this.usage(grant.key_id, day) >= current.maximum) throw new ApiFailure('Contribution quota reached', 409, resetAt);
      this.db.run("INSERT INTO coop_inferences VALUES (?,?,?,'pending')", [id, grant.key_id, day]);
    });
    try {
      const result = await this.api.contributedInference(grant.key_id, model, body, signal,
        () => allowed() && this.grants().some((entry) => entry.offer_id === offerId) && (this.session.secureRole() === 'host' || this.session.ready()));
      this.db.run("UPDATE coop_inferences SET state='completed' WHERE id=?", [id]);
      return result;
    } catch (error) {
      this.db.run("UPDATE coop_inferences SET state='failed' WHERE id=?", [id]);
      throw error;
    } finally { this.refresh(); }
  }

  private remoteInference(offer: Offer, tier: ModelTier, model: FreeModel, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const stop = () => {
        try { this.send({ kind: 'cancel', id: requestId }); } catch { /* offline */ }
        finish(new ApiFailure('Collaboration inference interrupted', 409));
      };
      const finish = (error: ApiFailure | null, result?: unknown) => {
        if (!this.outgoing.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(stop, 95_000);
      this.outgoing.set(requestId, { offer: offer.id, stop, finish });
      signal.addEventListener('abort', stop, { once: true });
      try {
        signal.throwIfAborted();
        this.send({ kind: 'infer', id: requestId, offer: offer.id, tier, model: model.id, body });
      } catch { finish(new ApiFailure('Collaborator is unavailable', 409)); }
    });
  }

  private blocked(projectId: string, provider: FreeApiId): number | null {
    const until = this.db.get<{ until_ms: number }>('SELECT until_ms FROM coop_backoff WHERE scope=?', [projectId + ':' + provider])?.until_ms;
    return until && until > Date.now() ? until : null;
  }

  pick(projectId: string, allowed: () => FreeApiId[], order: string[], tier: ModelTier, needs: { images: boolean; imageCount?: number; tools: boolean }): ReadyRoute | { ok: false; reason: string; resumeAt: number | null } {
    if (this.session.secureRole() !== 'host' || this.session.boundProject() !== projectId) return { ok: false, reason: 'Restart collaboration for this project to resume shared tasks', resumeAt: null };
    const slots = this.status().offers;
    const rank = (id: string) => order.includes(id) ? order.indexOf(id) : Number.MAX_SAFE_INTEGER;
    slots.sort((a, b) => rank(a.id) - rank(b.id));
    const times: number[] = [];
    const authorizedProviders = allowed();
    for (const offer of slots) {
      const model = offer.models[tier];
      if (!authorizedProviders.includes(offer.provider) || !offer.ready || !model || (needs.tools && !model.tools) || (needs.images && (!model.images || (model.maxImages && (needs.imageCount ?? 1) > model.maxImages)))) continue;
      const until = offer.retryAt ?? (offer.used >= offer.maximum ? Date.now() + 30_000 : null);
      if (until) { times.push(until); continue; }
      const authorized = () => this.session.boundProject() === projectId && allowed().includes(offer.provider) && (offer.owner === 'local'
        ? this.local().some((entry) => entry.id === offer.id && entry.ready)
        : this.session.ready() && this.remote.some((entry) => entry.id === offer.id && entry.ready));
      const provider = this.api.provider(offer.id, offer.provider, model, async (body, signal) => {
        if (!authorized()) throw new ApiFailure('Contribution is unavailable', 409);
        const shared = this.blocked(projectId, offer.provider);
        if (shared) throw new ApiFailure('Shared service quota is cooling down', 429, shared);
        try {
          return await (offer.owner === 'local' ? this.localInference(randomUUID(), offer.id, tier, model.id, body, signal, authorized) : this.remoteInference(offer, tier, model, body, signal));
        } catch (error) {
          if (error instanceof ApiFailure) {
            if (error.status === 429 || error.status >= 500) {
              const retry = error.retryAt ?? Date.now() + 60_000;
              this.db.run('INSERT INTO coop_backoff VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)', [projectId + ':' + offer.provider, retry]);
            }
            if (error.status === 401 || error.status === 402 || error.status === 403) this.remote = this.remote.map((item) => item.id === offer.id ? { ...item, ready: false } : item);
            if (error.status === 409) this.offerWait.set(offer.id, error.retryAt ?? Date.now() + 15_000);
            this.refresh();
          }
          throw error;
        }
      });
      return { ok: true, provider, model: model.id, account: null, usageKey: 'coop:' + offer.id,
        reason: `Shared key ${offer.label} · ${offer.owner === 'local' ? 'host' : 'collaborator'}`, api: { provider: offer.provider, keyId: offer.id, authorized } };
    }
    return { ok: false, reason: 'No authorized shared key can run this task', resumeAt: times.length ? Math.min(...times) : null };
  }
}
