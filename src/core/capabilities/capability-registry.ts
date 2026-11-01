import { nowIso } from '@shared/ids';
import type { CapabilityRecord, HealthStatus } from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';
import type { CapabilityObserver } from './tool-registry';

interface CapabilityRow {
  id: string;
  integration: string;
  name: string;
  status: HealthStatus;
  description: string;
  version: string | null;
  detail: string | null;
  limitations: string;
  schema: string | null;
  success_count: number;
  failure_count: number;
  last_error: string | null;
  last_checked_at: string | null;
}

export interface CapabilityInput {
  id: string;
  integration: string;
  name: string;
  status: HealthStatus;
  description?: string;
  version?: string | null;
  detail?: string | null;
  limitations?: string[];
  schema?: unknown;
}

/**
 * Live registry of everything agents can do: provider features, Studio MCP tools, toolchain
 * commands, app tools. Each record carries status, version, limitations, schema and observed
 * reliability (success/failure counters fed by the capability layer), so an agent can know a
 * tool's limits before attempting it.
 */
export class CapabilityRegistry implements CapabilityObserver {
  private pendingEmit = new Set<string>();
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {}

  upsert(input: CapabilityInput): CapabilityRecord {
    const existing = this.get(input.id);
    const limitations = mergeUnique(existing?.limitations ?? [], input.limitations ?? []);
    this.store.run(
      `INSERT INTO capabilities (id, integration, name, status, description, version, detail, limitations, schema, last_checked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET integration = excluded.integration, name = excluded.name, status = excluded.status,
         description = excluded.description, version = excluded.version, detail = excluded.detail, limitations = excluded.limitations,
         schema = COALESCE(excluded.schema, capabilities.schema), last_checked_at = excluded.last_checked_at, updated_at = excluded.updated_at`,
      [
        input.id,
        input.integration,
        input.name,
        input.status,
        input.description ?? existing?.description ?? '',
        input.version ?? existing?.version ?? null,
        input.detail ?? null,
        j(limitations),
        input.schema === undefined ? null : j(input.schema),
        nowIso(),
        nowIso(),
      ],
    );
    this.queueEmit(input.integration);
    return this.get(input.id)!;
  }

  /** Mark every capability of an integration (except the given ids) with a status, e.g. when it disconnects. */
  setIntegrationStatus(integration: string, status: HealthStatus, detail: string | null, exceptIds: string[] = []): void {
    const except = new Set(exceptIds);
    for (const c of this.list(integration)) {
      if (except.has(c.id)) continue;
      this.store.run('UPDATE capabilities SET status = ?, detail = ?, last_checked_at = ?, updated_at = ? WHERE id = ?', [status, detail, nowIso(), nowIso(), c.id]);
    }
    this.queueEmit(integration);
  }

  setStatus(id: string, status: HealthStatus, detail: string | null = null): void {
    const r = this.store.run('UPDATE capabilities SET status = ?, detail = ?, last_checked_at = ?, updated_at = ? WHERE id = ?', [status, detail, nowIso(), nowIso(), id]);
    if (r.changes) this.queueEmit(this.get(id)!.integration);
  }

  addLimitation(id: string, limitation: string): void {
    const c = this.get(id);
    if (!c) return;
    this.store.run('UPDATE capabilities SET limitations = ?, updated_at = ? WHERE id = ?', [j(mergeUnique(c.limitations, [limitation])), nowIso(), id]);
    this.queueEmit(c.integration);
  }

  /** CapabilityObserver: reliability accounting from real tool calls. */
  record(capability: string, ok: boolean, error?: string | null): void {
    if (ok) {
      this.store.run('UPDATE capabilities SET success_count = success_count + 1 WHERE id = ?', [capability]);
    } else {
      this.store.run('UPDATE capabilities SET failure_count = failure_count + 1, last_error = ? WHERE id = ?', [error?.slice(0, 2000) ?? null, capability]);
    }
  }

  get(id: string): CapabilityRecord | null {
    const r = this.store.get<CapabilityRow>('SELECT * FROM capabilities WHERE id = ?', [id]);
    return r ? hydrate(r) : null;
  }

  list(integration?: string): CapabilityRecord[] {
    const rows = integration
      ? this.store.all<CapabilityRow>('SELECT * FROM capabilities WHERE integration = ? ORDER BY id', [integration])
      : this.store.all<CapabilityRow>('SELECT * FROM capabilities ORDER BY integration, id');
    return rows.map(hydrate);
  }

  search(text: string, limit = 40): CapabilityRecord[] {
    const t = text.toLowerCase();
    return this.list()
      .filter((c) => `${c.id} ${c.name} ${c.description} ${c.limitations.join(' ')}`.toLowerCase().includes(t))
      .slice(0, limit);
  }

  isHealthy(id: string): boolean {
    const c = this.get(id);
    return !!c && (c.status === 'healthy' || c.status === 'degraded');
  }

  private queueEmit(integration: string): void {
    this.pendingEmit.add(integration);
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      try {
        for (const i of this.pendingEmit) this.bus.emit('capabilities.updated', { integration: i, capabilities: this.list(i) });
      } catch {
        /* store closed during shutdown */
      }
      this.pendingEmit.clear();
    }, 50);
  }

  dispose(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.pendingEmit.clear();
  }
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function hydrate(r: CapabilityRow): CapabilityRecord {
  return {
    id: r.id,
    integration: r.integration,
    name: r.name,
    status: r.status,
    description: r.description,
    version: r.version,
    detail: r.detail,
    limitations: pj(r.limitations, []),
    schema: pj(r.schema, null),
    successCount: r.success_count,
    failureCount: r.failure_count,
    lastError: r.last_error,
    lastCheckedAt: r.last_checked_at,
  };
}
