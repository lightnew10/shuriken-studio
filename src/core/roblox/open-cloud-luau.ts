import type { HealthCheckResult } from '@shared/domain';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { OPEN_CLOUD_KEY } from '@shared/roblox-keys';

/** Resolves a secret by name (the Electron main process decrypts it with DPAPI; tests inject values). */
export type SecretProvider = (key: string) => Promise<string | null>;

/** The default Open Cloud key's name (a project may have its own: roblox/project-keys.ts). */
export { OPEN_CLOUD_KEY };
const BASE = 'https://apis.roblox.com/cloud/v2';

export interface CloudLuauRequest {
  universeId: string;
  placeId: string;
  versionId?: string | null;
  script: string;
  timeoutSec?: number;
}

export interface CloudLuauResult {
  ok: boolean;
  state: string;
  results: unknown[];
  error: { code: string; message: string } | null;
  logs: string[];
  durationMs: number;
  retryAfterSec?: number;
}

/**
 * Open Cloud Luau Execution: headless Luau on a published place version (a CI/test backend that
 * does not need Studio). Facts from Roblox's Open Cloud docs (2026): API-key auth with scope
 * universe.place.luau-execution-session:write, 5 creates/min, an undocumented ~30/hour cap, 5 min
 * max runtime, live DataStores reachable (dangerous), results ≤ 4 MB, logs ≤ 450 KB.
 */
export class OpenCloudLuau {
  private createdAt: number[] = [];

  constructor(
    private readonly secret: SecretProvider,
    private readonly log: ScopedLogger,
  ) {}

  async configured(): Promise<boolean> {
    return !!(await this.secret(OPEN_CLOUD_KEY).catch(() => null));
  }

  /** Local guard for the documented 5/min and observed ~30/hour creation limits. */
  private budget(): { ok: boolean; reason?: string } {
    const now = Date.now();
    this.createdAt = this.createdAt.filter((t) => now - t < 3600_000);
    if (this.createdAt.filter((t) => now - t < 60_000).length >= 5) return { ok: false, reason: 'Open Cloud limit: 5 task creations per minute' };
    if (this.createdAt.length >= 28) return { ok: false, reason: 'Open Cloud hourly cap (~30 tasks/hour) nearly reached; wait before running more' };
    return { ok: true };
  }

  async run(req: CloudLuauRequest, signal?: AbortSignal): Promise<CloudLuauResult> {
    const t0 = Date.now();
    const key = await this.secret(OPEN_CLOUD_KEY).catch(() => null);
    if (!key) return { ok: false, state: 'NOT_CONFIGURED', results: [], error: { code: 'NOT_CONFIGURED', message: 'No Open Cloud API key configured (Settings → Open Cloud).' }, logs: [], durationMs: 0 };
    const budget = this.budget();
    if (!budget.ok) return { ok: false, state: 'RATE_LIMITED', results: [], error: { code: 'RATE_LIMITED', message: budget.reason! }, logs: [], durationMs: 0 };
    const url = req.versionId
      ? `${BASE}/universes/${enc(req.universeId)}/places/${enc(req.placeId)}/versions/${enc(req.versionId)}/luau-execution-session-tasks`
      : `${BASE}/universes/${enc(req.universeId)}/places/${enc(req.placeId)}/luau-execution-session-tasks`;
    const timeout = Math.max(1, Math.min(300, Math.round(req.timeoutSec ?? 120)));
    this.createdAt.push(Date.now());
    let created: Response;
    try {
      created = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ script: req.script, timeout: `${timeout}s` }),
        signal,
      });
    } catch (e) {
      return { ok: false, state: 'NETWORK_ERROR', results: [], error: { code: 'NETWORK_ERROR', message: errorMessage(e) }, logs: [], durationMs: Date.now() - t0 };
    }
    if (created.status === 429) {
      const retry = Number(created.headers.get('retry-after') ?? '60');
      return { ok: false, state: 'RATE_LIMITED', results: [], error: { code: 'RESOURCE_EXHAUSTED', message: await created.text() }, logs: [], durationMs: Date.now() - t0, retryAfterSec: retry };
    }
    if (!created.ok) {
      return { ok: false, state: `HTTP_${created.status}`, results: [], error: { code: `HTTP_${created.status}`, message: (await created.text()).slice(0, 2000) }, logs: [], durationMs: Date.now() - t0 };
    }
    const task = (await created.json()) as { path?: string; state?: string };
    if (!task.path) return { ok: false, state: 'BAD_RESPONSE', results: [], error: { code: 'BAD_RESPONSE', message: 'Create response had no task path' }, logs: [], durationMs: Date.now() - t0 };

    // Poll the returned path verbatim until a terminal state (QUEUED counts as non-terminal).
    const deadline = Date.now() + (timeout + 180) * 1000;
    let current: { state?: string; output?: { results?: unknown[] }; error?: { code?: string; message?: string } } = task;
    while (!['COMPLETE', 'FAILED', 'CANCELLED'].includes(current.state ?? '')) {
      if (Date.now() > deadline) return { ok: false, state: current.state ?? 'UNKNOWN', results: [], error: { code: 'POLL_TIMEOUT', message: 'Task did not finish in time' }, logs: [], durationMs: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 2500));
      if (signal?.aborted) return { ok: false, state: 'ABORTED', results: [], error: { code: 'ABORTED', message: 'Aborted' }, logs: [], durationMs: Date.now() - t0 };
      const res = await fetch(`${BASE}/${task.path}?view=BASIC`, { headers: { 'x-api-key': key }, signal }).catch(() => null);
      if (res?.ok) current = (await res.json()) as typeof current;
    }
    const logs = await this.logs(key, task.path, signal);
    const ok = current.state === 'COMPLETE';
    return {
      ok,
      state: current.state ?? 'UNKNOWN',
      results: current.output?.results ?? [],
      error: ok ? null : { code: current.error?.code ?? 'FAILED', message: current.error?.message ?? 'Task failed' },
      logs,
      durationMs: Date.now() - t0,
    };
  }

  private async logs(key: string, path: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await fetch(`${BASE}/${path}/logs?view=FLAT&maxPageSize=10000`, { headers: { 'x-api-key': key }, signal });
      if (!res.ok) return [];
      const body = (await res.json()) as Record<string, unknown>;
      const pages = (body.luauExecutionSessionTaskLogs ?? body.logs ?? []) as Array<{ messages?: string[] }>;
      return pages.flatMap((p) => p.messages ?? []).slice(-2000);
    } catch (e) {
      this.log.warn('Open Cloud logs fetch failed', errorMessage(e));
      return [];
    }
  }

  async healthChecks(target: { universeId: string | null; placeId: string | null }): Promise<HealthCheckResult[]> {
    const key = await this.configured();
    return [
      {
        id: 'cloud.key',
        name: 'Open Cloud API key',
        status: key ? 'healthy' : 'needs_configuration',
        message: key ? 'Configured (stored encrypted by Windows)' : 'Not configured. Needs scope universe.place.luau-execution-session:write.',
        durationMs: 0,
      },
      {
        id: 'cloud.target',
        name: 'Published place',
        status: target.universeId && target.placeId ? 'healthy' : 'needs_configuration',
        message: target.universeId && target.placeId ? `universe ${target.universeId} · place ${target.placeId}` : 'Project has no published universe/place id (Settings → Open Cloud).',
        durationMs: 0,
      },
    ];
  }
}

function enc(s: string): string {
  return encodeURIComponent(s.trim());
}
