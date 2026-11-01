import type { IAgentProvider } from './types';
import type { Store } from '../db/store';
import { pj, j } from '../db/store';
import { nowIso } from '@shared/ids';

export interface ProviderAssignments {
  /** Provider used when a role has no explicit assignment. */
  default: string;
  /** Role id → provider id (e.g. { critic: 'codex' } once another provider exists). */
  roles: Record<string, string>;
}

/**
 * Registered AI providers and which provider serves which role. Assignments are data, so
 * configurations like "Primary: Claude, Reviewer: Codex" need no code changes once a second
 * adapter exists.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, IAgentProvider>();

  constructor(private readonly global: Store) {}

  register(p: IAgentProvider): void {
    this.providers.set(p.id, p);
  }

  list(): IAgentProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): IAgentProvider | undefined {
    return this.providers.get(id);
  }

  assignments(): ProviderAssignments {
    const raw = this.global.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'providerAssignments'`);
    const first = this.list()[0]?.id ?? 'claude';
    const a = pj<Partial<ProviderAssignments>>(raw?.value, {});
    return { default: a.default && this.providers.has(a.default) ? a.default : first, roles: a.roles ?? {} };
  }

  setAssignments(a: ProviderAssignments): void {
    for (const id of [a.default, ...Object.values(a.roles)]) {
      if (!this.providers.has(id)) throw new Error(`Unknown provider ${id}`);
    }
    this.global.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('providerAssignments', ?, ?)`, [j(a), nowIso()]);
  }

  forRole(role: string): IAgentProvider {
    const a = this.assignments();
    const id = a.roles[role] ?? a.default;
    const p = this.providers.get(id) ?? this.list()[0];
    if (!p) throw new Error('No AI provider is registered');
    return p;
  }
}
