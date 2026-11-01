import { accessSync, constants, mkdirSync } from 'node:fs';
import { newId, nowIso } from '@shared/ids';
import type { HealthCheckResult, HealthStatus, IntegrationHealth } from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { CapabilityRegistry } from '../capabilities/capability-registry';
import type { IAgentProvider, ProbeContext, ProviderCapabilityKey } from '../providers/types';

export interface IntegrationCheck {
  id: string;
  name: string;
  /** Deep checks may spend money/time (model calls); they are run on demand or on a slow schedule. */
  run: (opts: { deep: boolean }) => Promise<{ checks: HealthCheckResult[]; version?: string | null }>;
}

const RANK: Record<HealthStatus, number> = { healthy: 0, unknown: 1, degraded: 2, needs_configuration: 3, unsupported: 4, unavailable: 5 };

/** Worst status among checks, with 'degraded' when some but not all checks fail. */
export function summarize(checks: HealthCheckResult[]): HealthStatus {
  if (checks.length === 0) return 'unknown';
  const statuses = checks.map((c) => c.status);
  if (statuses.every((s) => s === 'healthy')) return 'healthy';
  const worst = statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  if (worst === 'unavailable' && statuses.some((s) => s === 'healthy')) return 'degraded';
  return worst;
}

/**
 * Runs integration diagnostics. A failing integration never throws out of here: each check is
 * isolated, results are persisted with history, and capability statuses are updated so the
 * orchestrator only plans with what actually works.
 */
export class HealthService {
  private readonly checks = new Map<string, IntegrationCheck>();
  private running = new Map<string, Promise<IntegrationHealth>>();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly log: ScopedLogger,
  ) {}

  register(check: IntegrationCheck): void {
    this.checks.set(check.id, check);
  }

  ids(): string[] {
    return [...this.checks.keys()];
  }

  async run(id: string, deep = false): Promise<IntegrationHealth> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const p = this.doRun(id, deep).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  async runAll(deep = false): Promise<IntegrationHealth[]> {
    return Promise.all(this.ids().map((id) => this.run(id, deep)));
  }

  private async doRun(id: string, deep: boolean): Promise<IntegrationHealth> {
    const check = this.checks.get(id);
    if (!check) throw new Error(`Unknown integration ${id}`);
    let checks: HealthCheckResult[];
    let version: string | null = null;
    try {
      const r = await check.run({ deep });
      checks = r.checks;
      version = r.version ?? null;
    } catch (e) {
      checks = [{ id: `${id}.error`, name: 'Diagnostics', status: 'unavailable', message: errorMessage(e), durationMs: 0 }];
    }
    const status = summarize(checks);
    const failing = checks.filter((c) => c.status !== 'healthy');
    const summary = status === 'healthy' ? `All ${checks.length} checks passed` : failing.map((c) => `${c.name}: ${c.message}`).join(' · ').slice(0, 600);
    const health: IntegrationHealth = { id, name: check.name, status, summary, version, checks, checkedAt: nowIso() };
    const prev = this.get(id);
    this.store.run(
      `INSERT INTO integration_health (id, name, status, summary, version, checks, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, summary = excluded.summary, version = excluded.version, checks = excluded.checks, checked_at = excluded.checked_at`,
      [id, health.name, status, summary, version, j(checks), health.checkedAt],
    );
    this.store.run('INSERT INTO health_history (id, integration, status, summary, version, checked_at) VALUES (?, ?, ?, ?, ?, ?)', [newId('hh'), id, status, summary, version, health.checkedAt]);
    if (prev && prev.version && version && prev.version !== version) {
      this.log.warn(`${check.name} version changed ${prev.version} → ${version}`);
    }
    if (prev && prev.status !== status) this.log.info(`${check.name}: ${prev.status} → ${status}`, { summary });
    this.bus.emit('health.updated', health);
    return health;
  }

  get(id: string): IntegrationHealth | null {
    const r = this.store.get<{ id: string; name: string; status: HealthStatus; summary: string; version: string | null; checks: string; checked_at: string }>(
      'SELECT * FROM integration_health WHERE id = ?',
      [id],
    );
    return r ? { id: r.id, name: r.name, status: r.status, summary: r.summary, version: r.version, checks: pj(r.checks, []), checkedAt: r.checked_at } : null;
  }

  list(): IntegrationHealth[] {
    return this.ids().map(
      (id) => this.get(id) ?? { id, name: this.checks.get(id)!.name, status: 'unknown' as HealthStatus, summary: 'Not checked yet', version: null, checks: [], checkedAt: '' },
    );
  }

  history(id: string, limit = 50): Array<{ status: HealthStatus; summary: string; version: string | null; checkedAt: string }> {
    return this.store
      .all<{ status: HealthStatus; summary: string; version: string | null; checked_at: string }>('SELECT * FROM health_history WHERE integration = ? ORDER BY checked_at DESC LIMIT ?', [id, limit])
      .map((r) => ({ status: r.status, summary: r.summary, version: r.version, checkedAt: r.checked_at }));
  }
}

/** Standard check for an AI provider: quick checks always, deep (model-calling) probes on demand. */
export function providerCheck(provider: IAgentProvider, registry: CapabilityRegistry, probeCtx: () => Promise<ProbeContext>): IntegrationCheck {
  return {
    id: `provider:${provider.id}`,
    name: provider.displayName,
    run: async ({ deep }) => {
      const diag = provider.diagnostics();
      const quick = await diag.quickChecks();
      const results: HealthCheckResult[] = quick.map((q) => ({ id: q.id, name: q.name, status: q.status, message: q.message, durationMs: q.durationMs, data: q.data }));
      const verified: Partial<Record<ProviderCapabilityKey, boolean>> = {};
      const installed = quick.every((q) => q.status === 'healthy');
      if (deep && installed) {
        const ctx = await probeCtx();
        for (const d of await diag.deepChecks(ctx)) {
          results.push({ id: d.id, name: d.name, status: d.status, message: d.message, durationMs: d.durationMs, data: d.data });
          Object.assign(verified, d.verified ?? {});
        }
      }
      const declared = provider.declaredCapabilities();
      const version = (quick.find((q) => q.id.endsWith('.executable'))?.data as { version?: string } | undefined)?.version ?? null;
      for (const [key, supported] of Object.entries(declared) as Array<[ProviderCapabilityKey, boolean]>) {
        const v = verified[key];
        let status: HealthStatus;
        let detail: string;
        if (!supported) {
          status = 'unsupported';
          detail = 'Not supported by this provider adapter';
        } else if (!installed) {
          status = 'unavailable';
          detail = 'Provider not installed or not runnable';
        } else if (v === true) {
          status = 'healthy';
          detail = 'Verified by live probe';
        } else if (v === false) {
          status = 'degraded';
          detail = 'Declared by the adapter but the live probe could not confirm it';
        } else {
          status = 'healthy';
          detail = deep ? 'Declared by adapter (not probed)' : 'Declared by adapter; run deep diagnostics to verify';
        }
        registry.upsert({ id: `${provider.id}.${key}`, integration: `provider:${provider.id}`, name: key, status, detail, version, description: `${provider.displayName}: ${key}` });
      }
      return { checks: results, version };
    },
  };
}

export function filesystemCheck(dirs: Array<{ name: string; path: string }>): IntegrationCheck {
  return {
    id: 'filesystem',
    name: 'Filesystem',
    run: async () => ({
      checks: dirs.map((d) => {
        const t0 = Date.now();
        try {
          mkdirSync(d.path, { recursive: true });
          accessSync(d.path, constants.R_OK | constants.W_OK);
          return { id: `fs.${d.name}`, name: d.name, status: 'healthy' as HealthStatus, message: d.path, durationMs: Date.now() - t0 };
        } catch (e) {
          return { id: `fs.${d.name}`, name: d.name, status: 'unavailable' as HealthStatus, message: `${d.path}: ${errorMessage(e)}`, durationMs: Date.now() - t0 };
        }
      }),
    }),
  };
}
