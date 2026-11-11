import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { ROLES } from '../../src/core/agents/roles';
import { freeSecretName } from '../../src/core/providers/free-api';
import { FakeProvider } from '../helpers/fake-provider';

/** Explicit opt-in with disposable keys provided in the launching process environment. */
describe.runIf(process.env.SHURIKEN_FREE_API_LIVE === '1')('Live free API fallback on synthetic projects', () => {
  for (const provider of ['groq', 'openrouter'] as const) {
    it(`${provider} checks the catalog, uses a controlled project tool and returns structured output`, async () => {
      const prefix = provider === 'groq' ? 'SHURIKEN_TEST_GROQ' : 'SHURIKEN_TEST_OPENROUTER';
      const key = process.env[`${prefix}_KEY`];
      const model = process.env[`${prefix}_MODEL`];
      if (!key || !model) throw new Error(`Set ${prefix}_KEY and ${prefix}_MODEL before the live test`);
      if (provider === 'groq' && process.env.SHURIKEN_TEST_GROQ_FREE_TIER !== '1') throw new Error('Confirm the disposable Groq key uses Free Tier');
      const id = randomUUID();
      const root = resolve('.cache', `free-api-fixture-${id}`);
      mkdirSync(root, { recursive: true });
      const subscription = new FakeProvider({ respond: async () => { throw new Error('Fixture subscription is capped'); } });
      Object.defineProperty(subscription, 'id', { value: 'claude' });
      const core = await Core.create({
        dataDir: join(root, 'data'), resourcesDir: resolve('resources'), providers: [subscription],
        secrets: async (name) => name === freeSecretName(id) ? key : null,
        integrations: false, logToDisk: false, appVersion: 'free-api-fixture',
      });
      try {
        core.orchestrator.pause();
        const project = core.openProject(core.createProject({ name: 'Free API fixture', rootPath: join(root, 'project') }).id);
        project.updateExtras({ syncMode: 'none' });
        project.updateSettings({ freeApiProviders: [provider] });
        core.setSetting('provider.freeFallback', 'true');
        core.modelQuotas.set('claude', subscription.modelForTier('fast'), 0);
        await core.freeApi.add(id, provider, 'Disposable test key', provider === 'groq');
        await core.freeApi.check(id);
        core.freeApi.setModel(provider, 'fast', model);
        const result = await core.runner.run({
          project, role: { ...ROLES.critic!, id: 'free-fixture', model: 'fast', appTools: [], builtinTools: ['edit_files'], maxTurns: 5, instructions: 'Use the specified tool for this synthetic fixture. Finish with the requested JSON.' },
          task: null, signal: AbortSignal.timeout(100_000), output: 'work',
          directive: 'Use workspace_write_file to create fixture.txt with content FREE_API_VERIFIED and expectedSha256 absent. Return JSON status implemented and a short summary after the write succeeds.',
          contextText: 'This temporary project is only a free API test.',
        });
        expect(result.run.providerId).toBe(provider);
        expect(result.completion.ok, result.completion.error ?? '').toBe(true);
        expect(result.structured).toMatchObject({ status: 'implemented' });
        expect(readFileSync(join(project.root, 'fixture.txt'), 'utf8')).toBe('FREE_API_VERIFIED');
      } finally { await core.shutdown(); }
    }, 130_000);
  }
});
