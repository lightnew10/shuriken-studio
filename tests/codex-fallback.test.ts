import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/db/store';
import { GLOBAL_MIGRATIONS } from '../src/core/db/schema';
import { ProviderRegistry } from '../src/core/providers/provider-registry';
import type { IAgentProvider } from '../src/core/providers/types';

const provider = (id: string) => ({ id, displayName: id }) as IAgentProvider;

describe('Claude -> Codex quota fallback', () => {
  function setup() {
    const db = new Store(':memory:', GLOBAL_MIGRATIONS);
    const registry = new ProviderRegistry(db);
    registry.register(provider('claude'));
    registry.register(provider('codex'));
    let claudeExhausted = false;
    let codexReady = true;
    registry.setCodexFallbackAvailability(() => claudeExhausted && codexReady);
    return {
      db, registry,
      setClaudeExhausted: (v: boolean) => { claudeExhausted = v; },
      setCodexReady: (v: boolean) => { codexReady = v; },
    };
  }

  it('does not change providers without explicit opt-in', () => {
    const t = setup();
    t.setClaudeExhausted(true);
    expect(t.registry.codexFallbackEnabled()).toBe(false);
    expect(t.registry.forRole('executive').id).toBe('claude');
  });

  it('switches only future Claude runs to Codex while limited, then returns to Claude automatically', () => {
    const t = setup();
    t.registry.setCodexFallbackEnabled(true);
    const before = t.registry.forRole('executive');
    expect(before.id).toBe('claude');
    t.setClaudeExhausted(true);
    const fallback = t.registry.forRole('executive');
    expect(fallback.id).toBe('codex');
    // The provider selected for an existing run is still the original object;
    // there is no interruption, mutation or session migration.
    expect(before.id).toBe('claude');
    t.setClaudeExhausted(false);
    expect(t.registry.forRole('executive').id).toBe('claude');
    expect(t.registry.codexFallbackEnabled()).toBe(true);
  });

  it('keeps explicit Codex role overrides and respects Codex availability', () => {
    const t = setup();
    t.registry.setAssignments({ default: 'claude', roles: { critic: 'codex' } });
    t.registry.setCodexFallbackEnabled(true);
    t.setClaudeExhausted(true);
    expect(t.registry.forRole('critic').id).toBe('codex');
    expect(t.registry.forRole('executive').id).toBe('codex');
    t.setCodexReady(false);
    expect(t.registry.forRole('executive').id).toBe('claude');
    expect(t.registry.forRole('critic').id).toBe('codex');
  });

  it('persists the user's opt-in across registry instances', () => {
    const t = setup();
    t.registry.setCodexFallbackEnabled(true);
    const reopened = new ProviderRegistry(t.db);
    reopened.register(provider('claude'));
    reopened.register(provider('codex'));
    expect(reopened.codexFallbackEnabled()).toBe(true);
    reopened.setCodexFallbackEnabled(false);
    expect(t.registry.codexFallbackEnabled()).toBe(false);
  });
});
