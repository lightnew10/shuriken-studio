import type { IAgentProvider } from './types';
import type { ModelTier } from '@shared/domain';
import { isAllowedCodexModel } from './codex/codex-models';
import type { Store } from '../db/store';
import { pj, j } from '../db/store';
import { nowIso } from '@shared/ids';

export type CodexTierModels = Record<ModelTier, string>;

export const DEFAULT_CODEX_MODELS: CodexTierModels = { fast: 'default', balanced: 'default', deep: 'default' };

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
  /** Evaluated at every new run. Existing sessions are never interrupted or migrated. */
  private claudeExhaustedAndCodexReady: (() => boolean) | null = null;

  constructor(private readonly global: Store) {}

  register(p: IAgentProvider): void {
    this.providers.set(p.id, p);
  }

  /** No external calls here: the core supplies a synchronous, health-checked availability predicate. */
  setCodexFallbackAvailability(check: () => boolean): void {
    this.claudeExhaustedAndCodexReady = check;
  }

  /** Explicit opt-in persists in global settings. */
  codexFallbackEnabled(): boolean {
    const setting = this.global.get<{ value: string }>("SELECT value FROM settings WHERE key = 'provider.codexFallbackEnabled'");
    return setting?.value === 'true';
  }

  setCodexFallbackEnabled(enabled: boolean): void {
    this.global.run(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('provider.codexFallbackEnabled', ?, ?)",
      [enabled ? 'true' : 'false', nowIso()],
    );
  }

  /** Independent model assignments for Codex, shared across projects and roles. */
  codexModels(): CodexTierModels {
    const raw = this.global.get<{ value: string }>("SELECT value FROM settings WHERE key = 'provider.codexModels'");
    const chosen = pj<Partial<CodexTierModels>>(raw?.value, {});
    const result = { ...DEFAULT_CODEX_MODELS };
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      const model = chosen[tier];
      // Never run Astra even when old data or a hand-edited DB contains it.
      if (model === 'default' || (typeof model === 'string' && isAllowedCodexModel(model))) result[tier] = model;
    }
    return result;
  }

  setCodexModels(models: CodexTierModels): CodexTierModels {
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      if (models[tier] !== 'default' && !isAllowedCodexModel(models[tier]))
        throw new Error('Invalid or excluded Codex model for ' + tier + '. Astra cannot be selected.');
    }
    const next = { fast: models.fast, balanced: models.balanced, deep: models.deep };
    this.global.run(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('provider.codexModels', ?, ?)",
      [j(next), nowIso()],
    );
    return next;
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

  /** Stable preferred selection, independent of temporary quota exhaustion. */
  preferredForRole(role: string): IAgentProvider {
    const a = this.assignments();
    const id = a.roles[role] ?? a.default;
    const p = this.providers.get(id) ?? this.list()[0];
    if (!p) throw new Error('No AI provider is registered');
    return p;
  }

  forRole(role: string): IAgentProvider {
    const preferred = this.preferredForRole(role);
    // Explicit Codex assignments stay on Codex. Once Claude can start again,
    // new runs return to Claude; Codex runs already active are not interrupted.
    if (
      preferred.id === 'claude' &&
      this.codexFallbackEnabled() &&
      this.providers.has('codex') &&
      this.claudeExhaustedAndCodexReady?.()
    ) return this.providers.get('codex')!;
    return preferred;
  }
}
