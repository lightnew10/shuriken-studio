import { query, type Options, type SDKMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, AgentRunHandle, AgentRunRequest, CompletionErrorKind } from '../types';
import { AsyncQueue } from '../../util/async';
import { classifyClaudeTool, claudeToolsFor, CLAUDE_TOOLS } from './tool-map';

export interface ClaudeRunnerConfig {
  executablePath: string | null;
  clientApp: string;
  modelForTier: (tier: AgentRunRequest['modelTier']) => string;
}

/** Cost and tokens as the SDK counts them: totals for the whole session, which run on across a resumed one. */
export interface Totals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface ModelUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** The totals a result (or the session's usage reading) carries. Input counts what was read from the cache and written to it. */
function totalsOf(costUsd: number | undefined, modelUsage: Record<string, ModelUsageLike> | undefined): Totals {
  let input = 0;
  let output = 0;
  for (const u of Object.values(modelUsage ?? {})) {
    input += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    output += u.outputTokens ?? 0;
  }
  return { costUsd: costUsd ?? 0, inputTokens: input, outputTokens: output };
}

/** The priced weight of the tokens behind a result's totals (see `weight`). */
function weightOfUsage(modelUsage: Record<string, ModelUsageLike> | undefined): number {
  let w = 0;
  for (const u of Object.values(modelUsage ?? {})) w += weight({ input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 });
  return w;
}

/** Tokens by kind, for pricing them against each other (output costs about 5 times input, a cache read a tenth, a cache write 1.25). */
interface Use {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const weight = (u: Use) => u.input + 5 * u.output + 0.1 * u.cacheRead + 1.25 * u.cacheWrite;

/**
 * What one run cost and used. The SDK's cost and token totals belong to the SESSION: a run that resumes an
 * earlier session starts from what that session had (so a repair of a $6.77 task came back as $7.74 when it
 * cost $0.97), and a run that never gets to report (stopped, crashed) reports nothing at all. This keeps the
 * session's totals at the start of the run and what the message stream shows as it goes, and turns them into
 * the run's own numbers.
 */
export class RunAccounting {
  /** The session's totals when this run began: undefined until read, null when they could not be. */
  private before: Totals | null | undefined;
  /** API calls seen in the stream (main agent and subagents), by message id: the last usage reported for each. */
  private readonly calls = new Map<string, Use>();
  private unnamed = 0;
  /** Tool results the main agent got back: the SDK counts its turns the same way (123 results and 2 prompts were 125 turns). */
  private toolResults = 0;
  private spoke = false;

  /** The agent did some work: the model answered (an error from the API in its place doesn't count). */
  get worked(): boolean {
    return this.spoke;
  }

  constructor(private readonly resumed: boolean) {}

  /** The session's totals at the start of this run, as the SDK reported them (null: it could not say). */
  startedFrom(totals: Totals | null): void {
    this.before = totals;
  }

  observe(m: SDKMessage): void {
    if (m.type === 'assistant') {
      // A refusal or limit from the API arrives as an assistant message too, marked with its error.
      if (!(m as { error?: unknown }).error) this.spoke = true;
      const u = (m.message as { id?: string; usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } } | undefined)?.usage;
      if (!u) return;
      const id = (m.message as { id?: string }).id ?? `unnamed-${this.unnamed++}`;
      const was = this.calls.get(id);
      // One API response arrives as several messages (a text, then each tool call), the last with the final output count.
      this.calls.set(id, {
        input: Math.max(was?.input ?? 0, u.input_tokens ?? 0),
        output: Math.max(was?.output ?? 0, u.output_tokens ?? 0),
        cacheRead: Math.max(was?.cacheRead ?? 0, u.cache_read_input_tokens ?? 0),
        cacheWrite: Math.max(was?.cacheWrite ?? 0, u.cache_creation_input_tokens ?? 0),
      });
    } else if (m.type === 'user' && m.parent_tool_use_id === null && Array.isArray(m.message?.content)) {
      this.toolResults += (m.message.content as Array<{ type: string }>).filter((b) => b.type === 'tool_result').length;
    }
  }

  private seen(): Use {
    const sum: Use = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const u of this.calls.values()) {
      sum.input += u.input;
      sum.output += u.output;
      sum.cacheRead += u.cacheRead;
      sum.cacheWrite += u.cacheWrite;
    }
    return sum;
  }

  /** What the stream shows this run did: tokens as the API reported them, and the turns. No cost: the stream carries none. */
  fromStream(): { inputTokens: number; outputTokens: number; numTurns: number } {
    const s = this.seen();
    return { inputTokens: s.input + s.cacheRead + s.cacheWrite, outputTokens: s.output, numTurns: this.spoke ? 1 + this.toolResults : 0 };
  }

  /**
   * The session's totals (a result's, or a reading of its usage) → what this run added. `totalWeight` is the
   * priced weight of the tokens behind a result's totals: with it, a resumed session whose starting totals
   * could not be read still gets an estimate (the totals scaled to this run's share of the tokens), not the
   * whole session's cost.
   */
  share(total: Totals, totalWeight?: number): Totals {
    const b = this.before;
    // The totals only grow: one below where the run started means the SDK started counting again (nothing carried over).
    const minus = (now: number, then: number) => Math.max(0, now >= then ? now - then : now);
    if (b) return { costUsd: minus(total.costUsd, b.costUsd), inputTokens: minus(total.inputTokens, b.inputTokens), outputTokens: minus(total.outputTokens, b.outputTokens) };
    if (this.resumed && b === null && totalWeight && totalWeight > 0) {
      const own = this.fromStream();
      const f = Math.min(1, weight(this.seen()) / totalWeight);
      if (f > 0) return { costUsd: total.costUsd * f, inputTokens: Math.min(total.inputTokens, own.inputTokens) || total.inputTokens, outputTokens: Math.min(total.outputTokens, own.outputTokens) || total.outputTokens };
    }
    return total;
  }

  /**
   * A run that reported no result (stopped, crashed): the stream's tokens and turns, and a cost only when
   * the session's usage was read while the run worked (a floor: what it cost by then) and this run's share
   * of that is known (a fresh session, or the starting totals of a resumed one).
   */
  partial(usage: Totals | null): Totals & { numTurns: number } {
    const s = this.fromStream();
    if (usage && (!this.resumed || this.before)) {
      const mine = this.share(usage);
      return { costUsd: mine.costUsd, inputTokens: Math.max(mine.inputTokens, s.inputTokens), outputTokens: Math.max(mine.outputTokens, s.outputTokens), numTurns: s.numTurns };
    }
    return { costUsd: 0, inputTokens: s.inputTokens, outputTokens: s.outputTokens, numTurns: s.numTurns };
  }
}

/** The SDK's session-usage reading. Marked experimental there ("may change, do not rely on it"): only read from, never required. */
interface UsageReader {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: { skipBehaviors?: boolean }) => Promise<{ session?: { total_cost_usd?: number; model_usage?: Record<string, ModelUsageLike> } } | undefined>;
}

/**
 * How the session's usage is read: once at the start of a resumed run (how much the session had), and every
 * `everyMs` while a run works, so that a run that is stopped or crashes (its result never comes) can still
 * book what it had cost when last looked at. (An object so a test can shorten it.)
 */
export const USAGE_READS = { baselineTimeoutMs: 3000, sampleTimeoutMs: 5000, everyMs: 45_000 };

/** The session's totals so far, or null when the SDK can't say (no such call in this SDK, an error, too slow). Never throws. */
async function readSessionUsage(q: UsageReader, ms: number): Promise<Totals | null> {
  const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof read !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      read.call(q, { skipBehaviors: true }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    return r?.session ? totalsOf(r.session.total_cost_usd, r.session.model_usage) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translates a provider-neutral AgentRunRequest into a Claude Agent SDK query and the SDK's
 * message stream back into normalized AgentEvents. Nothing outside this adapter sees SDK types.
 */
export function runClaude(req: AgentRunRequest, cfg: ClaudeRunnerConfig): AgentRunHandle {
  const out = new AsyncQueue<AgentEvent>();
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener('abort', onAbort, { once: true });

  const stderrTail: string[] = [];
  const builtin = claudeToolsFor(req.builtinTools);
  const mcpServers: NonNullable<Options['mcpServers']> = {};
  for (const s of req.toolServers) mcpServers[s.name] = { type: 'http', url: s.url, headers: s.headers };

  // Read-only built-ins and the app's own MCP servers (which enforce policy server-side) are
  // pre-approved. Edits, shell, web and anything else flow through canUseTool → app policy.
  const allowedTools = [
    ...req.toolServers.map((s) => `mcp__${s.name}__*`),
    ...CLAUDE_TOOLS.read_files.filter((t) => builtin.includes(t)),
  ];

  const options: Options = {
    cwd: req.cwd,
    additionalDirectories: req.additionalDirectories,
    model: req.model ?? cfg.modelForTier(req.modelTier),
    effort: req.effort,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: req.instructions },
    tools: builtin,
    allowedTools,
    mcpServers,
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: 'default',
    includePartialMessages: true,
    maxTurns: req.maxTurns,
    maxBudgetUsd: req.maxBudgetUsd,
    abortController: abort,
    resume: req.resumeSessionId ?? undefined,
    // DISABLE_AUTOUPDATER: the program Shuriken ships never replaces itself (claude-provider.ts, NO_SELF_UPDATE).
    env: { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_AGENT_SDK_CLIENT_APP: cfg.clientApp, ...(req.env ?? {}) },
    stderr: (d) => {
      stderrTail.push(d);
      if (stderrTail.length > 40) stderrTail.shift();
    },
    canUseTool: async (toolName, input, opts): Promise<PermissionResult> => {
      try {
        const decision = await req.permission({
          tool: toolName,
          toolClass: classifyClaudeTool(toolName),
          input,
          mcpServer: opts.mcpServer?.name,
          blockedPath: opts.blockedPath,
        });
        return decision.allow
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny', message: decision.message, interrupt: decision.interrupt };
      } catch (e) {
        return { behavior: 'deny', message: `Permission check failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
  if (cfg.executablePath) options.pathToClaudeCodeExecutable = cfg.executablePath;
  if (req.outputSchema) options.outputFormat = { type: 'json_schema', schema: req.outputSchema };
  if (req.subagents?.length) {
    options.agents = Object.fromEntries(
      req.subagents.map((s) => [
        s.name,
        {
          description: s.description,
          prompt: s.instructions,
          tools: claudeToolsFor(s.tools).concat(req.toolServers.map((t) => `mcp__${t.name}__*`)),
          model: s.modelTier ? cfg.modelForTier(s.modelTier) : 'inherit',
        },
      ]),
    );
  }

  // Attached pictures go in with the prompt as image blocks (one streamed user message).
  const images = req.images ?? [];
  const prompt: string | AsyncIterable<SDKUserMessage> = images.length
    ? (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              ...images.flatMap((im) => [...(im.caption ? [{ type: 'text' as const, text: im.caption }] : []), { type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType, data: im.data } }]),
              { type: 'text' as const, text: req.prompt },
            ],
          },
          parent_tool_use_id: null,
        } satisfies SDKUserMessage;
      })()
    : req.prompt;
  const q = query({ prompt, options });
  const started = Date.now();
  const acct = new RunAccounting(!!req.resumeSessionId);
  const readUsage = (ms: number) => readSessionUsage(q as unknown as UsageReader, ms);
  let sawInit = false;
  /** A resumed session's totals at the start of this run, on their way. */
  let startedFrom: Promise<void> | null = null;
  /**
   * The result message, held until the stream ends: the SDK throws "Claude Code returned an error result"
   * AFTER yielding it (the process exits non-zero), and a second, empty completion for that throw used to
   * replace the real one, with its cost and turns. A run has one completion; the result is it.
   */
  let result: Extract<AgentEvent, { type: 'completed' }> | null = null;
  /** The session's usage as last read while the run worked: a floor for the cost of a run that never reports (stopped, crashed). */
  let lastRead: Totals | null = null;
  let reading = false;
  const sampler = setInterval(() => {
    if (!sawInit || result || reading) return;
    reading = true;
    void readUsage(USAGE_READS.sampleTimeoutMs)
      .then((t) => {
        if (t) lastRead = t;
      })
      .finally(() => {
        reading = false;
      });
  }, USAGE_READS.everyMs);
  sampler.unref?.();

  /** The run's one completion: the result, told it was stopped when it was, with the process's own words added when it had none. */
  const settled = (r: Extract<AgentEvent, { type: 'completed' }>, thrown?: string): AgentEvent => {
    if (r.ok) return r;
    let error = r.error;
    // A result that only names its kind ("error_during_execution") gets the SDK's own words and the process's stderr.
    if (thrown && (!error || /^error_[a-z_]+$/.test(error))) error = `${error ? `${error}: ` : ''}${thrown}${stderrTail.length ? `\n--- stderr ---\n${stderrTail.join('').slice(-1500)}` : ''}`;
    // A run that only met an error from the API (a resumed transcript it refuses) did no work: it reports no
    // turns, like a run that never got going, and the orchestrator starts that task's agent fresh instead.
    const idle = !acct.worked && r.numTurns <= 1;
    return { ...r, error, numTurns: idle ? 0 : r.numTurns, errorKind: abort.signal.aborted ? 'interrupted' : r.errorKind };
  };
  const noResult = (kind: CompletionErrorKind, error: string): AgentEvent => failure(kind, error, started, acct.partial(lastRead));

  (async () => {
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        acct.observe(m);
        if (m.type === 'system' && m.subtype === 'init') {
          if (!sawInit) req.onDispatch?.();
          sawInit = true;
          // The SDK's totals run on from the session's earlier runs: note where this run starts.
          if (req.resumeSessionId) startedFrom = readUsage(USAGE_READS.baselineTimeoutMs).then((t) => acct.startedFrom(t));
        }
        if (m.type === 'result') await startedFrom;
        for (const ev of translate(m, started, acct)) {
          if (ev.type === 'completed') result = ev;
          else out.push(ev);
        }
      }
      out.push(result ? settled(result) : noResult(abort.signal.aborted ? 'interrupted' : 'execution', abort.signal.aborted ? 'Run was interrupted' : `Claude process ended without a result. ${stderrTail.join('').slice(-1500)}`));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (result) {
        // The result is the outcome. What the SDK threw after an error result is that result again; after a good one it is news.
        if (result.ok) out.push({ type: 'notice', level: 'warn', message: `Claude Code ended with an error after finishing: ${msg}`.slice(0, 500) });
        out.push(settled(result, msg));
      } else {
        const kind: CompletionErrorKind = abort.signal.aborted ? 'interrupted' : classifyError(msg + ' ' + stderrTail.join(''));
        out.push(noResult(kind, `${msg}${stderrTail.length ? `\n--- stderr ---\n${stderrTail.join('').slice(-1500)}` : ''}`));
      }
    } finally {
      clearInterval(sampler);
      req.signal.removeEventListener('abort', onAbort);
      out.close();
    }
  })();

  return {
    events: out,
    interrupt: async () => {
      try {
        await q.interrupt();
      } catch {
        abort.abort();
      }
    },
  };
}

/** A run that ended without a result, with whatever its stream showed it had used (zeros for a run that never got going). */
function failure(kind: CompletionErrorKind, error: string, started: number, used?: Totals & { numTurns: number }): AgentEvent {
  return {
    type: 'completed',
    ok: false,
    resultText: null,
    structured: null,
    costUsd: used?.costUsd ?? 0,
    inputTokens: used?.inputTokens ?? 0,
    outputTokens: used?.outputTokens ?? 0,
    numTurns: used?.numTurns ?? 0,
    durationMs: Date.now() - started,
    stopReason: null,
    error,
    errorKind: kind,
  };
}

function classifyError(text: string): CompletionErrorKind {
  const t = text.toLowerCase();
  if (/(authentication|unauthori[sz]ed|401|invalid api key|not logged in|oauth)/.test(t)) return 'auth';
  // "You've hit your session limit · resets 12:50am", weekly limits, plan usage limits, overload.
  if (/(rate.?limit|429|usage limit|overloaded|hit your (session|weekly|usage|daily) limit|(session|weekly) limit|limit reached|resets \d{1,2}(:\d{2})?\s*(am|pm))/.test(t)) return 'rate_limit';
  if (/(maximum number of turns|max(imum)?[_ ]turns)/.test(t)) return 'max_turns';
  if (/(native binary|failed to launch|pathtoclaudecodeexecutable|spawn \S+ (enoent|eacces|eperm|unknown)|enoent[^\n]*claude|executable not found|enospc)/.test(t)) return 'environment';
  return 'execution';
}

/** SDK message → normalized events. A result's cost and tokens are the run's own share of the session's totals (see RunAccounting). */
export function translate(m: SDKMessage, started: number, acct?: RunAccounting): AgentEvent[] {
  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') {
        return [
          {
            type: 'started',
            providerSessionId: m.session_id,
            model: m.model,
            providerVersion: m.claude_code_version,
            tools: m.tools,
            toolServers: m.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
            authSource: m.apiKeySource,
          },
        ];
      }
      if (m.subtype === 'api_retry') {
        return [{ type: 'notice', level: 'warn', message: `API retry ${m.attempt}/${m.max_retries} (${m.error}${m.error_status ? ' ' + m.error_status : ''})` }];
      }
      if (m.subtype === 'compact_boundary') return [{ type: 'notice', level: 'info', message: 'Context compacted' }];
      return [];
    }
    case 'stream_event': {
      const ev = m.event as { type: string; delta?: { type: string; text?: string } };
      if (m.parent_tool_use_id === null && ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        return [{ type: 'text', text: ev.delta.text, partial: true }];
      }
      return [];
    }
    case 'assistant': {
      const events: AgentEvent[] = [];
      const content = (m.message?.content ?? []) as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
      for (const b of content) {
        if (b.type === 'text' && b.text) {
          if (m.parent_tool_use_id === null) events.push({ type: 'text', text: b.text, partial: false });
        } else if (b.type === 'thinking' && b.thinking) {
          if (m.parent_tool_use_id === null) events.push({ type: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use' && b.id && b.name) {
          events.push({ type: 'tool_call', id: b.id, tool: b.name, toolClass: classifyClaudeTool(b.name), input: b.input, parentId: m.parent_tool_use_id });
        }
      }
      if (m.error) events.push({ type: 'notice', level: 'warn', message: `Assistant error: ${m.error}` });
      return events;
    }
    case 'user': {
      const content = m.message?.content;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const b of content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          events.push({ type: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, output: b.content, parentId: m.parent_tool_use_id });
        }
      }
      return events;
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info;
      return [
        {
          type: 'rate_limit',
          status: info.status,
          window: info.rateLimitType ?? null,
          utilization: typeof info.utilization === 'number' ? info.utilization : null,
          resetsAt: info.resetsAt ?? null,
          raw: info,
        },
      ];
    }
    case 'result': {
      // The result's cost and tokens are the session's totals; this run's are what it added to them.
      const total = totalsOf(m.total_cost_usd, m.modelUsage);
      const mine = acct ? acct.share(total, weightOfUsage(m.modelUsage)) : total;
      const input = mine.inputTokens;
      const output = mine.outputTokens;
      if (m.subtype === 'success') {
        return [
          {
            type: 'completed',
            ok: !m.is_error,
            resultText: m.result ?? null,
            structured: m.structured_output ?? null,
            costUsd: mine.costUsd,
            inputTokens: input,
            outputTokens: output,
            numTurns: m.num_turns,
            durationMs: m.duration_ms ?? Date.now() - started,
            stopReason: m.stop_reason,
            error: m.is_error ? (m.result ?? 'Provider reported an error') : null,
            errorKind: m.is_error ? classifyError(m.result ?? '') : null,
          },
        ];
      }
      const kindMap: Record<string, CompletionErrorKind> = {
        error_max_turns: 'max_turns',
        error_max_budget_usd: 'budget',
        error_max_structured_output_retries: 'output_schema',
        error_during_execution: 'execution',
      };
      const errText = (m.errors ?? []).join('\n') || m.subtype;
      return [
        {
          type: 'completed',
          ok: false,
          resultText: null,
          structured: null,
          costUsd: mine.costUsd,
          inputTokens: input,
          outputTokens: output,
          numTurns: m.num_turns,
          durationMs: m.duration_ms ?? Date.now() - started,
          stopReason: m.stop_reason,
          error: errText,
          errorKind: kindMap[m.subtype] === 'execution' ? classifyError(errText) : (kindMap[m.subtype] ?? 'unknown'),
        },
      ];
    }
    default:
      return [];
  }
}
