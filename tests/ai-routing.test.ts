import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/db/store';
import { GLOBAL_MIGRATIONS } from '../src/core/db/schema';
import { ModelQuotas } from '../src/core/providers/model-quotas';
import { eligibleFreeModels, FreeApiAccounts } from '../src/core/providers/free-api';
import { RunRouting } from '../src/core/providers/run-routing';
import { ProviderRegistry } from '../src/core/providers/provider-registry';
import { CodexProvider } from '../src/core/providers/codex/codex-provider';
import { runClaude } from '../src/core/providers/claude/claude-runner';
import type { AgentEvent, AgentRunRequest } from '../src/core/providers/types';
import { AccountService } from '../src/core/accounts/account-service';
import { UsageTracker } from '../src/core/orchestrator/usage-tracker';
import { EventBus } from '../src/core/events';
import { FakeProvider } from './helpers/fake-provider';
import { Core } from '../src/core/core';
import { waitFor } from './helpers/make-core';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function store(path = ':memory:') {
  const db = new Store(path, GLOBAL_MIGRATIONS);
  cleanups.push(() => db.close());
  return db;
}

const groqModel = 'openai/gpt-oss-20b';
const routerModel = 'test/work:free';
const groqCatalog = { data: [{ id: groqModel, active: true }] };
const routerEntry = { id: routerModel, pricing: { prompt: '0', completion: '0', image: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } };
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] as const;
const json = (value: unknown, status = 200, headers?: Record<string, string>) => Response.json(value, { status, headers });

function services(request: typeof fetch, now = Date.now) {
  const db = store();
  const free = new FreeApiAccounts(db, async (key) => 'secret-' + key, request, now);
  return { db, free };
}

async function collect(free: FreeApiAccounts, id: string, provider: 'groq' | 'openrouter', req: Partial<AgentRunRequest> = {}) {
  const model = provider === 'groq' ? { id: groqModel, tools: true, images: false } : { id: routerModel, tools: true, images: true };
  const handle = free.provider(id, provider, model).run({
    role: 'fixture', runId: 'run-fixture', cwd: process.cwd(), instructions: 'synthetic', prompt: 'synthetic context',
    modelTier: 'fast', toolServers: [], builtinTools: [], signal: new AbortController().signal,
    permission: async () => ({ allow: false, message: 'denied' }), apiAllowed: () => true, ...req,
  });
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

it('shares quota reservations across database connections and resets at local midnight', () => {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-ai-quota-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'global.db');
  let now = new Date(2026, 10, 11, 23, 59);
  const first = new ModelQuotas(store(path), () => now);
  const other = new ModelQuotas(store(path), () => now);
  first.set('claude', 'fast-id', 1);
  expect(first.reserve('claude', 'fast-id', 'first')).toBe(true);
  expect(other.reserve('claude', 'fast-id', 'second')).toBe(false);
  expect(other.reserve('codex', 'fast-id', 'codex')).toBe(true);
  first.release('first');
  expect(other.reserve('claude', 'fast-id', 'second')).toBe(true);
  const restarted = new ModelQuotas(store(path), () => now);
  expect(restarted.status('claude', 'fast-id')).toMatchObject({ used: 1, available: false, resetAt: new Date(2026, 10, 12).getTime() });
  now = new Date(2026, 10, 12, 0, 1);
  expect(restarted.reserve('claude', 'fast-id', 'next-day')).toBe(true);
});

it('accepts only exact zero-price OpenRouter variants and excludes unsupported Groq endpoints', () => {
  expect(eligibleFreeModels('openrouter', [
    routerEntry, { ...routerEntry, id: 'test/paid:free', pricing: { ...routerEntry.pricing, image: '0.01' } },
    { ...routerEntry, id: 'test/not-free' }, { ...routerEntry, id: 'test/unverified:free', pricing: { prompt: '0' } },
  ])).toEqual([{ id: routerModel, tools: true, images: true }]);
  expect(eligibleFreeModels('groq', [...groqCatalog.data, { id: 'groq/compound', active: true }]).map((model) => model.id)).toEqual([groqModel]);
});

it('rotates invalid keys but shares unknown-scope quota cooldowns across keys', async () => {
  let now = 1_000_000, mode = 'catalog';
  const request = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/models')) return json(groqCatalog);
    if (mode === 'invalid' && String((options?.headers as Record<string, string>).Authorization).includes(ids[0])) return json({ error: 'secret-must-not-appear' }, 401);
    return json({}, 429, { 'retry-after': '30' });
  });
  const { free } = services(request, () => now);
  await free.add(ids[0], 'groq', 'first', true);
  await free.add(ids[1], 'groq', 'second', true);
  for (const id of ids.slice(0, 2)) await free.check(id);
  free.setModel('groq', 'fast', groqModel);
  expect(free.pick(['groq'], 'fast', { tools: true, images: false }).key?.id).toBe(ids[0]);
  mode = 'invalid';
  const failed = await collect(free, ids[0], 'groq');
  expect(failed.at(-1)).toMatchObject({ errorKind: 'rate_limit', error: 'The API service returned HTTP 401' });
  expect(JSON.stringify(failed)).not.toContain('secret');
  expect(free.pick(['groq'], 'fast', { tools: true, images: false }).key?.id).toBe(ids[1]);
  await collect(free, ids[1], 'groq');
  expect(free.pick(['groq'], 'fast', { tools: true, images: false })).toMatchObject({ key: null, resumeAt: now + 30_000 });
  now += 30_001;
  expect(free.pick(['groq'], 'fast', { tools: true, images: false }).key?.id).toBe(ids[1]);
});

it('checks consent and current price before sending context, then runs only locally advertised tools', async () => {
  let catalog = routerEntry, turn = 0;
  const request = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).endsWith('/key')) return json({ data: { is_management_key: false } });
    if (String(url).endsWith('/models')) return json({ data: [catalog] });
    const body = JSON.parse(String(options?.body));
    expect(body.provider).toMatchObject({ allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } });
    expect(JSON.stringify(body)).not.toContain('secret-');
    turn++;
    if (turn === 1) return json({ model: routerModel, choices: [{ message: { tool_calls: [
      { id: 'call1', function: { name: 'workspace_write_file', arguments: '{"path":"fixture.txt"}' } },
    ] } }] });
    expect(body.messages.at(-1)).toMatchObject({ role: 'tool', content: 'Denied by local policy' });
    return json({ model: routerModel, choices: [{ message: { content: '{"status":"blocked"}' } }] });
  });
  const { free } = services(request);
  await free.add(ids[2], 'openrouter', 'router', false);
  await free.check(ids[2]);
  const before = request.mock.calls.length;
  await collect(free, ids[2], 'openrouter', { apiAllowed: () => false });
  expect(request).toHaveBeenCalledTimes(before);
  catalog = { ...routerEntry, pricing: { ...routerEntry.pricing, completion: '1' } };
  expect((await collect(free, ids[2], 'openrouter')).at(-1)).toMatchObject({ ok: false });
  expect(turn).toBe(0);
  catalog = routerEntry;
  await free.check(ids[2]);
  const invoke = vi.fn(async () => ({ text: 'Denied by local policy', error: true }));
  const events = await collect(free, ids[2], 'openrouter', {
    localTools: { definitions: [{ name: 'workspace_write_file', description: 'Controlled write', parameters: { type: 'object' } }], invoke },
    outputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ ok: true, structured: { status: 'blocked' }, costKnown: false });
});

it('respects both switches independently, project authorization, and bidirectional preference', async () => {
  const { db, free } = services(async () => json(groqCatalog));
  await free.add(ids[0], 'groq', 'Groq', true);
  await free.check(ids[0]);
  free.setModel('groq', 'fast', groqModel);
  const bus = new EventBus();
  const usage = new UsageTracker(db, bus);
  cleanups.push(() => usage.dispose());
  const accounts = new AccountService(db, tmpdir(), bus);
  const providers = new ProviderRegistry(db);
  for (const id of ['claude', 'codex'] as const) {
    const adapter = new FakeProvider({ respond: async () => null });
    Object.defineProperty(adapter, 'id', { value: id });
    providers.register(adapter);
  }
  let freeEnabled = false, allowed = true;
  const quotas = new ModelQuotas(db);
  const routing = new RunRouting(providers, quotas, accounts, usage, free, () => freeEnabled, () => null);
  const project = { settings: () => ({ freeApiProviders: allowed ? ['groq'] : [] }) } as never;
  const pick = () => routing.pick(project, 'fixture', 'fast', { tools: true, images: false });
  const chosen = () => { const route = pick(); return route.ok ? route.provider.id : null; };
  for (const preferred of ['claude', 'codex'] as const) {
    const alternate = preferred === 'claude' ? 'codex' : 'claude';
    providers.setAssignments({ default: preferred, roles: {} });
    quotas.set(preferred, 'fake-fast', 0);
    quotas.set(alternate, 'fake-fast', null);
    for (const subscriptions of [false, true]) {
      providers.setCodexFallbackEnabled(subscriptions);
      for (const freeOn of [false, true]) {
        freeEnabled = freeOn;
        expect(chosen()).toBe(subscriptions ? alternate : freeOn ? 'groq' : null);
      }
    }
    quotas.set(alternate, 'fake-fast', 0);
    expect(chosen()).toBe('groq');
    allowed = false;
    expect(chosen()).toBeNull();
    allowed = true;
    quotas.set(preferred, 'fake-fast', null);
    expect(chosen()).toBe(preferred);
  }
  vi.spyOn(providers.get('claude')!, 'modelForTier').mockReturnValue('claude-opus-4-8');
  vi.spyOn(providers.get('codex')!, 'modelForTier').mockReturnValue('gpt-test-codex');
  providers.setAssignments({ default: 'claude', roles: {} });
  providers.setCodexFallbackEnabled(true);
  providers.setModelBlocked('claude', 'opus', true);
  expect(chosen()).toBe('codex');
  providers.setModelBlocked('codex', 'GPT-test-Codex', true);
  expect(chosen()).toBe('groq');
  freeEnabled = false;
  expect(pick()).toMatchObject({ ok: false, reason: expect.stringMatching(/opus.*blocked.*gpt-test-codex.*blocked/) });
  expect(new ProviderRegistry(db).modelRejection('claude', 'claude-3-opus-20240229')).toContain('blocked');
  expect(providers.modelRejection('claude', 'claude-sonnet-4-6')).toBeNull();
  expect(providers.modelRejection('codex', 'gpt-astra')).toContain('blocked');
  providers.setModelBlocked('claude', 'opus', false);
  expect(chosen()).toBe('claude');
});

it('refuses a blocked explicit model on a resumed provider request before dispatch', async () => {
  const db = new Store(':memory:', GLOBAL_MIGRATIONS);
  cleanups.push(() => db.close());
  const providers = new ProviderRegistry(db);
  const onDispatch = vi.fn();
  const request: AgentRunRequest = {
    runId: 'fixture', role: 'fixture', cwd: process.cwd(), instructions: '', prompt: 'synthetic',
    modelTier: 'deep', resumeSessionId: 'previous-session', toolServers: [], builtinTools: [],
    signal: new AbortController().signal, permission: async () => ({ allow: false, message: 'fixture' }), onDispatch,
  };
  providers.setModelBlocked('claude', 'opus', true);
  providers.setModelBlocked('codex', 'gpt-test-codex', true);
  const claude = runClaude({ ...request, model: 'claude-opus-4-8' }, {
    clientApp: 'fixture', executablePath: null, modelForTier: () => 'sonnet',
    rejectModel: (model) => providers.modelRejection('claude', model), restrictModels: true,
  });
  const codex = new CodexProvider(() => 'gpt-other', undefined, undefined, (model) => providers.modelRejection('codex', model));
  for (const handle of [claude, codex.run({ ...request, model: 'gpt-test-codex' })]) {
    const events: AgentEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: 'completed', ok: false, error: expect.stringContaining('blocked') })]);
  }
  expect(onDispatch).not.toHaveBeenCalled();
});

it('automatically resumes a task on another API after a shared quota, preserving the first write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-ai-resume-'));
  const originalFetch = fetch;
  let groqTurns = 0, resumed = 0;
  const writes = (id: string, content: string) => [{ id, function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'quota-fixture.txt', content, expectedSha256: 'absent' }) } }];
  const modelResponse = (model: string, message: object) => json({ model, choices: [{ message }] });
  const adapter = new FakeProvider({ respond: async () => { throw new Error('Subscription was already capped'); } });
  Object.defineProperty(adapter, 'id', { value: 'claude' });
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const target = String(url);
    const groq = target.startsWith('https://api.groq.com/');
    if (!groq && !target.startsWith('https://openrouter.ai/')) return originalFetch(url, options);
    if (target.endsWith('/key')) return json({ data: { is_management_key: false } });
    if (target.endsWith('/models')) return json(groq ? groqCatalog : { data: [routerEntry] });
    if (groq) {
      if (++groqTurns === 1) return modelResponse(groqModel, { tool_calls: writes('first', 'confirmed') });
      core?.orchestrator.pause();
      return json({}, 429, { 'retry-after': '120' });
    }
    const body = JSON.parse(String(options?.body));
    if (JSON.stringify(body.messages[0]).includes('"verdict"')) return modelResponse(routerModel, { content: '{"verdict":"pass","summary":"Fixture reviewed","findings":[]}' });
    if (!body.messages.some((message: { role: string }) => message.role === 'tool')) {
      expect(JSON.stringify(body.messages)).toContain('Resume task from the current project state');
      resumed++;
      return modelResponse(routerModel, { tool_calls: writes('repeat', 'must not overwrite') });
    }
    expect(body.messages.at(-1).content).toContain('File changed');
    return modelResponse(routerModel, { content: '{"status":"implemented","summary":"Saved work preserved","filesChanged":["quota-fixture.txt"]}' });
  });
  let core: Core | undefined;
  try {
    const openCore = () => Core.create({ dataDir: join(root, 'data'), resourcesDir: resolve('resources'), providers: [adapter], secrets: async () => 'synthetic-key', integrations: false, logToDisk: false, appVersion: 'test' });
    core = await openCore();
    core.orchestrator.pause();
    const projectId = core.createProject({ name: 'Quota recovery fixture', rootPath: join(root, 'project') }).id;
    let project = core.openProject(projectId);
    project.updateExtras({ syncMode: 'none' });
    project.updateSettings({ freeApiProviders: ['groq', 'openrouter'], autoQa: false });
    core.setSetting('provider.freeFallback', 'true');
    await core.freeApi.add(ids[0], 'groq', 'Groq', true);
    await core.freeApi.add(ids[2], 'openrouter', 'Router', false);
    await core.freeApi.check(ids[0]);
    await core.freeApi.check(ids[2]);
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      core.modelQuotas.set('claude', adapter.modelForTier(tier), 0);
      core.freeApi.setModel('groq', tier, groqModel);
      core.freeApi.setModel('openrouter', tier, routerModel);
    }
    const task = project.tasks.create({ kind: 'implement', role: 'roblox-engineer', title: 'Quota recovery', objective: 'Write and preserve the fixture', createdBy: 'user', status: 'ready', files: ['quota-fixture.txt'] });
    core.orchestrator.resume();
    await waitFor(() => project.tasks.get(task.id)?.status === 'ready' && !!project.store.get(
      "SELECT id FROM runs WHERE task_id = ? AND provider_id = 'groq' AND outcome_kind = 'rate_limit'", [task.id],
    ), 12_000);
    await core.shutdown();
    core = await openCore();
    project = core.openProject(projectId);
    core.orchestrator.resume();
    const completed = await waitFor(() => project.store.get<{ id: string; continues_run_id: string | null }>(
      "SELECT id, continues_run_id FROM runs WHERE task_id = ? AND provider_id = 'openrouter' AND role = 'roblox-engineer' AND status = 'completed'", [task.id],
    ), 15_000);
    expect(completed.continues_run_id).toBeTruthy();
    expect(readFileSync(join(project.root, 'quota-fixture.txt'), 'utf8')).toBe('confirmed');
    expect(resumed).toBe(1);
    expect(project.audit.toolCalls({ taskId: task.id }).filter((call) => call.tool === 'workspace_write_file' && call.status === 'ok')).toHaveLength(1);
  } finally {
    await core?.shutdown();
    vi.unstubAllGlobals();
  }
}, 22_000);
