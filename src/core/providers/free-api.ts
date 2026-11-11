import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelTier } from '@shared/domain';
import type { Store } from '../db/store';
import type { SecretProvider } from '../roblox/open-cloud-luau';
import { AsyncQueue } from '../util/async';
import type { AgentEvent, AgentRunRequest, CompletionErrorKind, IAgentProvider } from './types';

export const FREE_API_IDS = ['groq', 'openrouter'] as const;
export type FreeApiId = (typeof FREE_API_IDS)[number];
export const isFreeApi = (id: string): id is FreeApiId => id === 'groq' || id === 'openrouter';
const endpoint = { groq: 'https://api.groq.com/openai/v1', openrouter: 'https://openrouter.ai/api/v1' };
const tiers = ['fast', 'balanced', 'deep'] as const;
const GROQ_CHAT = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'minimaxai/minimax-m2.7', 'meta-models/muse-spark-open', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
const GROQ_VISION_LIMIT: Record<string, number> = { 'qwen/qwen3.8-27b': 3, 'meta-models/muse-spark-open': 5 };
const toolGateway = [
  { name: 'shuriken_find_tools', description: 'Find up to 5 authorized Shuriken tools and their argument schemas. Search names such as workspace, studio, model, task or verify.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'shuriken_call', description: 'Call an authorized Shuriken tool discovered with shuriken_find_tools. Set arguments_json to a JSON object encoded as a string.', parameters: { type: 'object', properties: { name: { type: 'string' }, arguments_json: { type: 'string' } }, required: ['name', 'arguments_json'], additionalProperties: false } },
];

export interface FreeModel { id: string; tools: boolean; images: boolean; maxImages?: number }
type CatalogRow = { id?: unknown; active?: boolean; pricing?: Record<string, unknown>; supported_parameters?: string[]; architecture?: { input_modalities?: string[]; output_modalities?: string[] } };
type KeyRow = { id: string; provider: FreeApiId; label: string; position: number; enabled: number; free_declared: number; state: string; catalog: string; checked_at: number | null };
export const freeSecretName = (id: string) => `ai-free:${id}`;

export function eligibleFreeModels(provider: FreeApiId, rows: CatalogRow[]): FreeModel[] {
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const id = row.id;
    if (typeof id !== 'string' || !/^[a-z0-9._:/-]{1,160}$/i.test(id) || /astra/i.test(id)) return [];
    if (provider === 'groq') {
      const maxImages = GROQ_VISION_LIMIT[id];
      return GROQ_CHAT.has(id) && row.active !== false ? [{ id, tools: true, images: !!maxImages, ...(maxImages ? { maxImages } : {}) }] : [];
    }
    const pricing = row.pricing ?? {};
    const zero = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number(value) === 0;
    if (!id.endsWith(':free') || !zero(pricing.prompt) || !zero(pricing.completion) || !Object.values(pricing).every(zero)) return [];
    if (!Array.isArray(row.architecture?.output_modalities) || !row.architecture.output_modalities.includes('text')) return [];
    return [{ id, tools: Array.isArray(row.supported_parameters) && row.supported_parameters.includes('tools'), images: Array.isArray(row.architecture.input_modalities) && row.architecture.input_modalities.includes('image') }];
  });
}

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly retryAt: number | null = null) { super(message); }
}

async function readResponse(response: Response): Promise<any> {
  if (!response.body) throw new Error('Empty API response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4_000_000) throw new Error('API response exceeds limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

export class FreeApiAccounts {
  constructor(private readonly store: Store, private readonly secret: SecretProvider, private readonly request = fetch, private readonly now = Date.now) {}

  private row(id: string) { return this.store.get<KeyRow>('SELECT * FROM free_api_keys WHERE id = ?', [id]); }
  private rows() { return this.store.all<KeyRow>('SELECT * FROM free_api_keys ORDER BY position, id'); }
  private models(row: KeyRow): FreeModel[] { return JSON.parse(row.catalog); }
  private wait(provider: FreeApiId): number | null {
    const at = this.store.get<{ until_ms: number }>('SELECT until_ms FROM free_api_backoffs WHERE scope = ?', [provider])?.until_ms;
    return at && at > this.now() ? at : null;
  }

  list() {
    return this.rows().map((row) => ({ id: row.id, provider: row.provider, label: row.label, enabled: !!row.enabled, state: row.state, freeDeclared: !!row.free_declared, retryAt: this.wait(row.provider), models: this.models(row) }));
  }

  async add(id: string, provider: FreeApiId, label: string, freeDeclared: boolean): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(id) || !isFreeApi(provider) || typeof label !== 'string' || !label.trim() || label.length > 80 || (provider === 'groq' && freeDeclared !== true)) throw new Error('Invalid free API account');
    if (!(await this.secret(freeSecretName(id)))) throw new Error('Key is missing from the encrypted vault');
    this.store.run('INSERT INTO free_api_keys(id,provider,label,position,enabled,free_declared) VALUES (?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM free_api_keys),1,?)', [id, provider, label.trim(), Number(provider === 'groq')]);
  }

  update(id: string, patch: { label?: string; enabled?: boolean; move?: -1 | 1 }): void {
    this.store.tx(() => {
      const row = this.row(id);
      if (!row) throw new Error('Unknown API key');
      if (patch.label !== undefined) {
        if (typeof patch.label !== 'string' || !patch.label.trim() || patch.label.length > 80) throw new Error('Invalid key label');
        this.store.run('UPDATE free_api_keys SET label = ? WHERE id = ?', [patch.label.trim(), id]);
      }
      if (typeof patch.enabled === 'boolean') this.store.run('UPDATE free_api_keys SET enabled = ? WHERE id = ?', [Number(patch.enabled), id]);
      if (patch.move === -1 || patch.move === 1) {
        const rows = this.rows(), other = rows[rows.findIndex((r) => r.id === id) + patch.move];
        if (other) {
          this.store.run('UPDATE free_api_keys SET position = ? WHERE id = ?', [row.position, other.id]);
          this.store.run('UPDATE free_api_keys SET position = ? WHERE id = ?', [other.position, id]);
        }
      }
    });
  }

  remove(id: string): void { this.store.run('DELETE FROM free_api_keys WHERE id = ?', [id]); }

  selections(): Record<FreeApiId, Record<ModelTier, string>> {
    return Object.fromEntries(FREE_API_IDS.map((id) => {
      const value = this.store.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [`provider.${id}.models`]);
      return [id, { fast: '', balanced: '', deep: '', ...JSON.parse(value?.value ?? '{}') }];
    })) as Record<FreeApiId, Record<ModelTier, string>>;
  }

  setModel(provider: FreeApiId, tier: ModelTier, model: string): void {
    if (!isFreeApi(provider) || !tiers.includes(tier) || typeof model !== 'string' || (model && !this.list().some((key) => key.provider === provider && key.state === 'ready' && key.models.some((entry) => entry.id === model)))) throw new Error('Choose a model from a verified free catalog');
    this.store.tx(() => {
      const models = this.selections()[provider];
      models[tier] = model;
      this.store.run('INSERT OR REPLACE INTO settings VALUES (?,?,?)', [`provider.${provider}.models`, JSON.stringify(models), new Date().toISOString()]);
    });
  }

  pick(allowed: readonly FreeApiId[], tier: ModelTier, needs: { images: boolean; imageCount?: number; tools: boolean }) {
    const models = this.selections(), times: number[] = [];
    for (const key of this.list()) {
      if (!allowed.includes(key.provider) || !key.enabled || key.state !== 'ready') continue;
      const model = key.models.find((m) => m.id === models[key.provider][tier] && (!needs.images || m.images && (!m.maxImages || (needs.imageCount ?? 1) <= m.maxImages)) && (!needs.tools || m.tools));
      if (!model) continue;
      if (key.retryAt) { times.push(key.retryAt); continue; }
      return { key, model, resumeAt: null };
    }
    return { key: null, model: null, resumeAt: times.length ? Math.min(...times) : null };
  }

  async check(id: string, signal = AbortSignal.timeout(12_000)): Promise<void> {
    const row = this.row(id);
    if (!row) throw new Error('Unknown API key');
    if (this.wait(row.provider)) throw new Error('This provider is waiting for its rate limit to reset');
    try {
      if (row.provider === 'openrouter') {
        const { data: details } = await this.call(row, '/key', undefined, signal);
        if (!details || typeof details !== 'object' || details.is_management_key === true) throw new ApiFailure('Enter an OpenRouter inference key', 401);
      }
      const data = await this.call(row, '/models', undefined, signal);
      const catalog = eligibleFreeModels(row.provider, Array.isArray(data.data) ? data.data : []);
      this.store.run('UPDATE free_api_keys SET state = ?, catalog = ?, checked_at = ? WHERE id = ?', [catalog.length ? 'ready' : 'no_models', JSON.stringify(catalog), this.now(), id]);
    } catch (error) {
      this.recordFailure(row, error);
      throw error;
    }
  }

  private recordFailure(row: KeyRow, error: unknown): void {
    if (!(error instanceof ApiFailure)) return;
    if ([401, 402, 403].includes(error.status)) {
      this.store.run("UPDATE free_api_keys SET state = 'rejected' WHERE id = ?", [row.id]);
    }
    if (error.status === 429 || error.status >= 500) {
      this.store.tx(() => {
        const prior = this.store.get<{ failures: number; until_ms: number }>('SELECT failures, until_ms FROM free_api_backoffs WHERE scope = ?', [row.provider]);
        const failures = Math.min(8, (prior?.failures ?? 0) + 1);
        const retry = error.retryAt ?? this.now() + Math.min(900_000, 15_000 * 2 ** (failures - 1));
        this.store.run('INSERT OR REPLACE INTO free_api_backoffs VALUES (?,?,?)', [row.provider, Math.max(prior?.until_ms ?? 0, retry), failures]);
      });
    }
  }

  private async call(row: KeyRow, path: '/key' | '/models' | '/chat/completions', body: object | undefined, signal: AbortSignal, authorized?: () => boolean): Promise<any> {
    const key = await this.secret(freeSecretName(row.id));
    if (!key) throw new ApiFailure('Key missing from encrypted storage', 401);
    signal.throwIfAborted();
    if (authorized && !authorized()) throw new ApiFailure('API use was revoked', 409);
    let response: Response;
    try {
      response = await this.request(endpoint[row.provider] + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      if (signal.aborted) throw new Error('API request stopped');
      throw new ApiFailure('The API service could not be reached', 503);
    }
    if (!response.ok) {
      const hint = response.headers.get('retry-after');
      const seconds = hint && /^\d+(\.\d+)?$/.test(hint) ? this.now() + Number(hint) * 1000 : NaN;
      const at = Number.isFinite(seconds) ? seconds : hint ? Date.parse(hint) : NaN;
      await response.body?.cancel().catch(() => {});
      throw new ApiFailure(`The API service returned HTTP ${response.status}`, response.status, Number.isFinite(at) && at > this.now() ? at : null);
    }
    const data = await readResponse(response);
    if (data?.error) {
      const code = Number(data.error.code);
      throw new ApiFailure('The API service returned an error', Number.isInteger(code) ? code : 500);
    }
    return data;
  }

  provider(id: string, provider: FreeApiId, selected: FreeModel, remote?: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>): IAgentProvider {
    const service = this;
    return {
      id: provider, displayName: provider === 'groq' ? 'Groq' : 'OpenRouter', adapterVersion: '1', testedVersions: [],
      detect: async () => ({ installed: true, version: null, executable: null, detail: 'HTTPS API' }),
      auth: async () => ({ authenticated: !!remote || service.row(id)?.state === 'ready', method: 'apiKey', account: null, plan: null, detail: 'Configured in Shuriken' }),
      modelForTier: () => selected.id,
      declaredCapabilities: () => ({ toolUse: selected.tools, mcp: true, mcpHttp: false, subagents: false, parallelAgents: false, fileEditing: selected.tools, terminal: false, streaming: false, backgroundExecution: false, contextCompaction: false, longRunningSessions: false, structuredOutput: true, approvalWorkflow: true, sessionPersistence: false, imageInput: selected.images, imageOutput: false, interruption: true, webResearch: false, costReporting: false, rateLimitReporting: true }),
      diagnostics: () => ({ quickChecks: async () => [], deepChecks: async () => [] }),
      run(req) { return service.run(id, provider, selected, req, remote); },
    };
  }

  /** A contributed key can only call its verified inference endpoint. Tools remain local to the host. */
  async contributedInference(id: string, selected: FreeModel, input: Record<string, unknown>, signal: AbortSignal, authorized: () => boolean): Promise<unknown> {
    const row = this.row(id);
    if (!row?.enabled || row.state !== 'ready' || (row.provider === 'groq' && !row.free_declared)) throw new ApiFailure('Contributed key unavailable', 401);
    const until = this.wait(row.provider);
    if (until) throw new ApiFailure('Provider quota is cooling down', 429, until);
    const permitted = () => authorized() && !!this.row(id)?.enabled;
    const toolCall = z.object({ id: z.string().max(200), type: z.literal('function'), function: z.object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), arguments: z.string().max(1_050_000),
    }) });
    const image = z.object({ type: z.literal('image_url'), image_url: z.object({
      url: z.string().max(1_400_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
    }) });
    const content = z.union([z.string(), z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }), image])).max(32)]);
    const request = z.object({
      model: z.literal(selected.id),
      messages: z.array(z.discriminatedUnion('role', [
        z.object({ role: z.literal('system'), content: z.string() }),
        z.object({ role: z.literal('user'), content }),
        z.object({ role: z.literal('assistant'), content: z.string().nullable(), tool_calls: z.array(toolCall).max(16) }),
        z.object({ role: z.literal('tool'), tool_call_id: z.string().max(200), content: z.string() }),
      ])).min(1).max(160),
      tools: z.array(z.object({ type: z.literal('function'), function: z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()),
      }) })).max(10).optional(),
    }).safeParse(input);
    if (!request.success) throw new ApiFailure('Invalid inference request', 400);
    try {
      const catalog = await this.call(row, '/models', undefined, signal, permitted);
      const models = eligibleFreeModels(row.provider, Array.isArray(catalog?.data) ? catalog.data : []);
      this.store.run('UPDATE free_api_keys SET catalog = ?, checked_at = ? WHERE id = ?', [JSON.stringify(models), this.now(), row.id]);
      const model = models.find((entry) => entry.id === selected.id);
      if (!model || (selected.tools && !model.tools) || (selected.images && !model.images)) throw new ApiFailure('Contributed model is unavailable or incompatible', 409);
      const imageCount = request.data.messages.reduce((count, message) =>
        count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url').length : 0), 0);
      if (imageCount && (!model.images || imageCount > (model.maxImages ?? 20))) throw new ApiFailure('Contributed model cannot accept these images', 409);
      const body = {
        model: selected.id,
        messages: request.data.messages,
        max_completion_tokens: row.provider === 'groq' ? 1536 : 4096,
        ...(model.tools && request.data.tools ? { tools: request.data.tools } : {}),
        ...(row.provider === 'openrouter' ? { provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, image: 0, request: 0 } } } : {}),
      };
      const reply = await this.call(row, '/chat/completions', body, signal, permitted);
      // Return only fields needed by the host adapter, never account or provider routing metadata.
      const message = reply?.choices?.[0]?.message;
      const calls = z.array(toolCall).max(16).nullish().safeParse(message?.tool_calls);
      if (!calls.success) throw new ApiFailure('Invalid inference tool response', 400);
      return { model: reply?.model, usage: { prompt_tokens: reply?.usage?.prompt_tokens, completion_tokens: reply?.usage?.completion_tokens },
        choices: [{ message: { content: typeof message?.content === 'string' ? message.content : null, tool_calls: calls.data } }] };
    } catch (error) {
      this.recordFailure(row, error);
      if (error instanceof ApiFailure && (error.status === 429 || error.status >= 500))
        throw new ApiFailure(error.message, error.status, this.wait(row.provider) ?? error.retryAt);
      throw error;
    }
  }

  private run(id: string, provider: FreeApiId, selected: FreeModel, req: AgentRunRequest, remote?: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) {
    const events = new AsyncQueue<AgentEvent>();
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, req.signal, AbortSignal.timeout(req.maxDurationMs ?? 300_000)]);
    const row = this.row(id), start = this.now();
    void (async () => {
      let text: string | null = null, error: string | null = null, kind: CompletionErrorKind | null = null, structured: unknown = null;
      let turns = 0, inputTokens = 0, outputTokens = 0;
      try {
        if (!remote && (!row?.enabled || row.state !== 'ready' || (row.provider === 'groq' && !row.free_declared))) throw new ApiFailure('API key is unavailable', 401);
        if (!req.apiAllowed?.()) throw new ApiFailure('API use was revoked or unauthorized', 409);
        if (!remote && this.wait(provider)) throw new ApiFailure('API quota is waiting for a reset', 409);
        const stored = remote ? selected : this.models(row!).find((m) => m.id === selected.id);
        if (!stored || req.images?.length && !stored.images) throw new Error('Selected model is incompatible');
        const catalog = remote ? null : await this.call(row!, '/models', undefined, signal);
        const current = remote ? [selected] : eligibleFreeModels(provider, Array.isArray(catalog.data) ? catalog.data : []);
        if (!remote) this.store.run('UPDATE free_api_keys SET catalog = ?, checked_at = ? WHERE id = ?', [JSON.stringify(current), this.now(), id]);
        const model = current.find((m) => m.id === selected.id);
        if (!model || (req.images?.length && (!model.images || (model.maxImages && req.images.length > model.maxImages))) || (req.localTools?.definitions.length && !model.tools)) throw new ApiFailure('Free model became unavailable or incompatible', 409);
        const availableTools = req.localTools?.definitions ?? [];
        const byName = new Map(availableTools.map((tool) => [tool.name, tool]));
        // Keep provider input small. Larger workshops are discoverable by name or keyword on demand.
        const tools = availableTools.length ? [...toolGateway, ...availableTools.filter((tool) => /^(workspace_read_file|workspace_write_file|workspace_search|project_overview|git_diff)$/.test(tool.name))] : [];
        const advertised = new Set(tools.map((tool) => tool.name)), callIds = new Set<string>();
        const images = req.images?.flatMap((img) => [
          ...(img.caption ? [{ type: 'text', text: img.caption }] : []),
          { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } },
        ]) ?? [];
        const output = req.outputSchema ? '\nReturn only JSON conforming to this schema when finished: ' + JSON.stringify(req.outputSchema) : '';
        const messages: Array<Record<string, unknown>> = [
          { role: 'system', content: req.instructions + output },
          { role: 'user', content: images.length ? [{ type: 'text', text: req.prompt }, ...images] : req.prompt },
        ];
        const maxTurns = Math.min(req.maxTurns ?? 12, 32);
        events.push({ type: 'started', providerSessionId: null, model: model.id, providerVersion: null, tools: [...advertised], toolServers: [], authSource: provider });
        for (; turns < maxTurns;) {
          signal.throwIfAborted();
          if (!req.apiAllowed?.() || (!remote && !this.row(id)?.enabled)) throw new ApiFailure('API use was revoked', 409);
          if (!remote && this.wait(provider)) throw new ApiFailure('API quota is waiting for a reset', 409);
          const body = {
            model: model.id, messages, max_completion_tokens: provider === 'groq' ? 1536 : 4096,
            ...(tools.length ? { tools: tools.map((definition) => ({ type: 'function', function: definition })) } : {}),
            ...(provider === 'openrouter' ? { provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, image: 0, request: 0 } } } : {}),
          };
          if (Buffer.byteLength(JSON.stringify(body)) > 6_000_000) throw new Error('API context exceeds the request size limit');
          turns++;
          const reply: any = remote ? await remote(body, signal) : await this.call(row!, '/chat/completions', body, signal, () => req.apiAllowed?.() === true && !!this.row(id)?.enabled);
          inputTokens += Number.isSafeInteger(reply.usage?.prompt_tokens) ? Math.max(0, reply.usage.prompt_tokens) : 0;
          outputTokens += Number.isSafeInteger(reply.usage?.completion_tokens) ? Math.max(0, reply.usage.completion_tokens) : 0;
          const message = reply.choices?.[0]?.message;
          if (!message || (reply.model && reply.model !== model.id)) throw new Error('API did not return the selected model');
          const calls = message.tool_calls;
          if (!Array.isArray(calls) || !calls.length) {
            text = typeof message.content === 'string' ? message.content : null;
            if (!text) throw new Error('The API returned no text');
            if (req.outputSchema) {
              const raw = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '');
              const parsed = z.fromJSONSchema(req.outputSchema).safeParse(JSON.parse(raw));
              if (!parsed.success) throw new Error('The API returned an invalid structured result');
              structured = parsed.data;
            }
            events.push({ type: 'text', text, partial: false });
            if (!remote) this.store.run('DELETE FROM free_api_backoffs WHERE scope = ? AND until_ms <= ?', [provider, this.now()]);
            break;
          }
          if (calls.length > 16 || callIds.size + calls.length > maxTurns) { kind = 'max_turns'; throw new Error('Maximum number of tool calls reached'); }
          const normalized = calls.map((call: any) => {
            if (typeof call.id !== 'string' || call.id.length > 200 || callIds.has(call.id) || !advertised.has(call.function?.name) || typeof call.function?.arguments !== 'string' || call.function.arguments.length > 1_050_000) throw new Error('Invalid API tool call');
            callIds.add(call.id);
            return { id: call.id as string, type: 'function', function: { name: call.function.name as string, arguments: call.function.arguments as string } };
          });
          messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, tool_calls: normalized });
          const toolImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
          for (const call of normalized) {
            signal.throwIfAborted();
            if (!req.apiAllowed?.() || (!remote && !this.row(id)?.enabled)) throw new ApiFailure('API use was revoked', 409);
            const input: unknown = JSON.parse(call.function.arguments);
            let name = call.function.name;
            let args = input;
            if (name === 'shuriken_find_tools') {
              const { query } = z.object({ query: z.string().max(120) }).parse(input);
              const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
              const matches = availableTools.filter((tool) => terms.every((term) => `${tool.name} ${tool.description}`.toLowerCase().includes(term)));
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(matches.slice(0, 5)).slice(0, 6000) });
              continue;
            }
            if (name === 'shuriken_call') {
              const parsed = z.object({ name: z.string().max(100), arguments_json: z.string().max(1_050_000) }).parse(input);
              name = parsed.name;
              args = JSON.parse(parsed.arguments_json);
            }
            if (!byName.has(name)) throw new Error('API requested an unauthorized tool');
            const callId = randomUUID();
            events.push({ type: 'tool_call', id: callId, tool: 'mcp__shuriken__' + name, toolClass: 'mcp', input: args, parentId: null });
            const result = await req.localTools!.invoke(name, args, signal);
            events.push({ type: 'tool_result', id: callId, isError: result.error, output: result.text, parentId: null });
            const maxResult = provider === 'groq' ? 3200 : 12_000;
            messages.push({ role: 'tool', tool_call_id: call.id, content: result.text.length > maxResult ? result.text.slice(0, maxResult) + '\n[Truncated. Request a smaller result if needed.]' : result.text });
            if (model.images) for (const image of result.images ?? []) {
              if (toolImages.length + (req.images?.length ?? 0) >= (model.maxImages ?? 6) || image.data.length > 1_300_000) break;
              toolImages.push({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
            }
          }
          if (toolImages.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the Shuriken tools above.' }, ...toolImages] });
        }
        if (!text) { kind = 'max_turns'; throw new Error('Maximum number of API turns reached'); }
      } catch (cause) {
        if (row) this.recordFailure(row, cause);
        kind ??= signal.aborted ? 'interrupted' : cause instanceof ApiFailure && ([401, 402, 403, 409, 429].includes(cause.status) || cause.status >= 500) ? 'rate_limit' : 'execution';
        error = cause instanceof ApiFailure ? cause.message : kind === 'interrupted' ? 'API run interrupted' : 'API run could not complete or validate its response';
      }
      events.push({ type: 'completed', ok: !error, resultText: text, structured, costUsd: 0, costKnown: false, inputTokens, outputTokens, numTurns: turns, durationMs: this.now() - start, stopReason: null, error, errorKind: kind });
      events.close();
    })();
    return { events, interrupt: async () => { abort.abort(); } };
  }
}
