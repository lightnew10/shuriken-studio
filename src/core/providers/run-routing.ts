import type { ModelTier } from '@shared/domain';
import type { ProviderAccount, AccountService } from '../accounts/account-service';
import type { ProjectContext } from '../projects/project-service';
import type { UsageTracker } from '../orchestrator/usage-tracker';
import type { IAgentProvider } from './types';
import type { ProviderRegistry } from './provider-registry';
import type { FreeApiAccounts, FreeApiId } from './free-api';
import { isSubscription, type ModelQuotas } from './model-quotas';

export interface ReadyRoute {
  ok: true;
  provider: IAgentProvider;
  model: string | null;
  account: ProviderAccount | null;
  usageKey: string;
  reason: string | null;
  api?: { provider: FreeApiId; keyId: string; authorized?: () => boolean };
}
export type Route = ReadyRoute | { ok: false; reason: string; resumeAt: number | null };

export class RunRouting {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly quotas: ModelQuotas,
    private readonly accounts: AccountService,
    private readonly usage: UsageTracker,
    private readonly free: FreeApiAccounts,
    private readonly freeEnabled: () => boolean,
    private readonly blocked: (id: string, fallback: boolean) => string | null,
    private readonly coop?: (project: ProjectContext, tier: ModelTier, needs: { tools: boolean; images: boolean; imageCount?: number }) => Route,
  ) {}

  pick(project: ProjectContext | null, role: string, tier: ModelTier, needs: { tools: boolean; images: boolean; imageCount?: number }, commit = false, allowFree = true, sharedTask = false): Route {
    if (project && (project.settings().coopEnabled || sharedTask)) return this.coop?.(project, tier, needs) ?? { ok: false, reason: 'Shared API pool is unavailable', resumeAt: null };
    const preferred = this.providers.preferredForRole(role);
    const alternate = isSubscription(preferred.id) && this.providers.codexFallbackEnabled() ? this.providers.get(preferred.id === 'claude' ? 'codex' : 'claude') : undefined;
    const reasons: string[] = [], resets: number[] = [];
    for (const provider of alternate ? [preferred, alternate] : [preferred]) {
      let model: string | null = null;
      if (isSubscription(provider.id)) {
        try { model = provider.modelForTier(tier); } catch { /* Missing explicit model choice. */ }
        if (!model) { reasons.push(`Choose a ${tier} model for ${provider.displayName}`); continue; }
        const quota = this.quotas.status(provider.id, model);
        if (!quota.available) {
          reasons.push(`${model}: daily launch limit reached`);
          resets.push(quota.resetAt);
          continue;
        }
      }
      const blocked = this.blocked(provider.id, provider !== preferred);
      if (blocked) { reasons.push(blocked); continue; }
      if (commit || !this.accounts.anyCanStart(provider.id, this.usage)) {
        const account = this.accounts.pick(provider.id, this.usage);
        if (!account.ok) {
          reasons.push(account.reason ?? `${provider.displayName} is at its quota`);
          if (account.resumeAt) resets.push(account.resumeAt);
          continue;
        }
        const reason = reasons.length ? reasons.join(' · ') : account.switchedFrom ? `${account.switchedFrom.label} reached its usage limit` : null;
        return { ok: true, provider, model, account: account.account, usageKey: account.usageKey, reason };
      }
      const account = this.accounts.active(provider.id);
      return { ok: true, provider, model, account, usageKey: this.accounts.usageKey(provider.id, account), reason: reasons.join(' · ') || null };
    }
    if (allowFree && project && isSubscription(preferred.id) && this.freeEnabled()) {
      const allowed = project.settings().freeApiProviders ?? [];
      const free = this.free.pick(allowed, tier, needs);
      if (free.key && free.model) {
        return {
          ok: true, provider: this.free.provider(free.key.id, free.key.provider, free.model), model: free.model.id,
          account: null, usageKey: `${free.key.provider}:${free.key.id}`, reason: reasons.join(' · '),
          api: { provider: free.key.provider, keyId: free.key.id },
        };
      }
      reasons.push(allowed.length ? `No compatible free ${tier} model or key is available` : 'This project has not authorized a free API provider');
      if (free.resumeAt) resets.push(free.resumeAt);
    }
    return { ok: false, reason: reasons.join(' · ') || 'No provider is available', resumeAt: resets.length ? Math.min(...resets) : null };
  }
}
