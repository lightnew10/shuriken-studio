import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runClaude, translate, RunAccounting, USAGE_READS } from '../src/core/providers/claude/claude-runner';
import type { AgentEvent, AgentRunRequest } from '../src/core/providers/types';
import { couldNotContinue } from '../src/core/orchestrator/continuation';

type Completed = Extract<AgentEvent, { type: 'completed' }>;
type Step = SDKMessage | Error | ((o: Options) => Promise<void>);

// ─── Messages as the SDK streams them (the numbers are a real repair: $6.77 for the task, $0.97 for its repair) ───
const init = (session = 's1') => ({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5', claude_code_version: '2.1.284', tools: [], mcp_servers: [{ name: 'shuriken', status: 'connected' }], apiKeySource: 'none' }) as unknown as SDKMessage;
const assistant = (id: string, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }, content: unknown[] = [{ type: 'text', text: 'working' }], parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content, usage: { input_tokens: usage.input ?? 0, output_tokens: usage.output ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0 } } }) as unknown as SDKMessage;
const apiError = (kind = 'invalid_request') => ({ type: 'assistant', parent_tool_use_id: null, error: kind, message: { id: 'err', content: [{ type: 'text', text: 'API Error: 400 invalid request' }], usage: { input_tokens: 0, output_tokens: 0 } } }) as unknown as SDKMessage;
const toolCall = (id: string) => ({ type: 'tool_use', id, name: 'mcp__shuriken__task_get', input: {} });
const toolResult = (id: string, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }) as unknown as SDKMessage;
const model = (inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number) => ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens });
const result = (o: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.5, duration_ms: 1000, stop_reason: 'end_turn', result: 'done', structured_output: { status: 'implemented', summary: 'ok' }, modelUsage: { 'claude-opus-5-5': model(10, 100, 1000, 50) }, errors: [], ...o }) as unknown as SDKMessage;

/** The session after the first run (what `get_usage` says at the start of the repair)... */
const AFTER_FIRST_RUN = { total_cost_usd: 6.7676968, model_usage: { 'claude-opus-5-5': model(128, 122388, 11125329, 259640), 'claude-haiku-4-5': model(17179, 12, 0, 0) } };
/** ...and the repair's result, which still counts everything from the start of the session. */
const AFTER_REPAIR = result({ total_cost_usd: 7.7373456, num_turns: 18, modelUsage: { 'claude-opus-5-5': model(150, 134331, 14078833, 277140), 'claude-haiku-4-5': model(17179, 12, 0, 0) } });

const usageOf = (session: unknown) => async () => ({ session });

/** A query that streams the steps (a step may wait; an Error is what the SDK throws), with the SDK's session-usage call. */
function stream(steps: Step[], opts: { usage?: (() => Promise<unknown>) | null; log?: string[]; stderr?: string } = {}) {
  vi.mocked(query).mockImplementation(((arg: { options: Options }) => {
    const options = arg.options;
    if (opts.stderr) options.stderr?.(opts.stderr);
    options.abortController?.signal.addEventListener('abort', () => opts.log?.push('abort'));
    const gen = (async function* () {
      for (const s of steps) {
        if (s instanceof Error) throw s;
        if (typeof s === 'function') await s(options);
        else yield s;
      }
    })();
    return Object.assign(gen, {
      interrupt: vi.fn(async () => undefined),
      ...(opts.usage === null
        ? {}
        : {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
              opts.log?.push('usage');
              return opts.usage ? opts.usage() : undefined;
            },
          }),
    });
  }) as never);
}

/** Waits until the run is stopped, the way the SDK's stream ends with an AbortError. */
const untilAborted = (o: Options) =>
  new Promise<void>((_, reject) => {
    o.abortController?.signal.addEventListener('abort', () => reject(new Error('Operation aborted')));
  });

function start(req: Partial<AgentRunRequest> = {}) {
  const ac = new AbortController();
  const handle = runClaude({ runId: 'run_1', role: 'level-designer', instructions: '', prompt: 'go', cwd: '.', modelTier: 'balanced', toolServers: [], builtinTools: [], permission: async () => ({ allow: true }), signal: ac.signal, ...req } as AgentRunRequest, { executablePath: null, clientApp: 'test', modelForTier: () => 'm' });
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const e of handle.events) events.push(e);
  })();
  return { ac, handle, events, done, completions: () => events.filter((e): e is Completed => e.type === 'completed') };
}
const finish = async (r: ReturnType<typeof start>) => {
  await r.done;
  expect(r.completions()).toHaveLength(1); // one completion per run, whatever the SDK did after its result
  return r.completions()[0]!;
};

afterEach(() => {
  Object.assign(USAGE_READS, { everyMs: 45_000 });
});
beforeEach(() => {
  vi.mocked(query).mockReset(); // (not returned: vitest would run a returned function as a cleanup hook)
});

describe('a run that failed after the SDK reported its result', () => {
  const limit = "You've hit your session limit · resets 12:20pm (Europe/London)";

  it('keeps the result (cost, turns, tokens, kind) when the SDK throws "returned an error result" after it', async () => {
    stream([init(), assistant('m1', { input: 5, output: 40, cacheRead: 900, cacheWrite: 10 }), result({ is_error: true, result: limit, structured_output: null, total_cost_usd: 0.254, num_turns: 4, modelUsage: { 'claude-opus-5-5': model(5, 40, 900, 10) } }), new Error(`Claude Code returned an error result: ${limit}`)]);
    const c = await finish(start());
    expect(c).toMatchObject({ ok: false, costUsd: 0.254, numTurns: 4, inputTokens: 915, outputTokens: 40, errorKind: 'rate_limit' });
    expect(c.error).toContain('hit your session limit');
  });

  it("a resumed run that hit the limit reports only the cost it added (the animator: $2.110 → $2.364 was $0 in the book)", async () => {
    stream([init('s2'), assistant('m1', { input: 5, output: 40, cacheRead: 900 }), result({ is_error: true, result: limit, total_cost_usd: 2.364, num_turns: 9, modelUsage: { 'claude-opus-5-5': model(305, 4040, 3900, 10) } }), new Error(`Claude Code returned an error result: ${limit}`)], {
      usage: usageOf({ total_cost_usd: 2.11, model_usage: { 'claude-opus-5-5': model(300, 4000, 3000, 0) } }),
    });
    const c = await finish(start({ resumeSessionId: 's2' }));
    expect(c.costUsd).toBeCloseTo(0.254, 6);
    expect(c).toMatchObject({ numTurns: 9, inputTokens: 915, outputTokens: 40, errorKind: 'rate_limit', ok: false });
  });

  it('keeps the max-turns and budget kinds, and what an error result that only names its kind gets from the process', async () => {
    stream([init(), assistant('m1', { input: 1, output: 1 }), result({ subtype: 'error_max_turns', is_error: true, errors: [], total_cost_usd: 3.2, num_turns: 60, structured_output: null }), new Error('Claude Code process exited with code 1')], { stderr: 'tool loop detected\n' });
    const c = await finish(start());
    expect(c).toMatchObject({ ok: false, errorKind: 'max_turns', costUsd: 3.2, numTurns: 60 });
    expect(c.error).toMatch(/^error_max_turns: Claude Code process exited with code 1\n--- stderr ---\ntool loop detected/);
  });

  it('a good result stands, with a notice, when the process then exits badly', async () => {
    stream([init(), result(), new Error('Claude Code process exited with code 1')]);
    const r = start();
    const c = await finish(r);
    expect(c).toMatchObject({ ok: true, costUsd: 0.5, structured: { status: 'implemented' } });
    expect(r.events.some((e) => e.type === 'notice' && /after finishing/.test(e.message))).toBe(true);
  });

  it('calls an error result interrupted when the run was being stopped', async () => {
    stream([init(), (o) => new Promise<void>((resolve) => { o.abortController?.signal.addEventListener('abort', () => resolve()); }), result({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.'], total_cost_usd: 0.9, num_turns: 5, structured_output: null })]);
    const r = start();
    await vi.waitFor(() => expect(r.events.some((e) => e.type === 'started')).toBe(true));
    r.ac.abort();
    const c = await finish(r);
    expect(c).toMatchObject({ ok: false, errorKind: 'interrupted', costUsd: 0.9, numTurns: 5 });
  });
});

describe('a run that only met an error from the API', () => {
  const refused = result({ is_error: true, result: 'API Error: 400 {"type":"error","error":{"message":"messages.3: tool_use ids were found without tool_result blocks"}}', structured_output: null, total_cost_usd: 0.012, num_turns: 1, modelUsage: { 'claude-opus-5-5': model(8, 0, 0, 0) } });

  it('reports no turns (it did no work), keeps its cost, and the orchestrator starts the task fresh instead of continuing the refused session', async () => {
    stream([init('s9'), apiError(), refused, new Error('Claude Code returned an error result: API Error: 400')], { usage: null });
    const c = await finish(start({ resumeSessionId: 's9' }));
    expect(c).toMatchObject({ ok: false, numTurns: 0, errorKind: 'execution' });
    expect(c.costUsd).toBeCloseTo(0.012, 6);
    expect(couldNotContinue(c, false)).toBe(true);
  });

  it('but a run that did work keeps the turns its result reports, however few', async () => {
    stream([init('s9'), assistant('m1', { input: 4, output: 9 }), refused, new Error('Claude Code returned an error result: API Error: 400')], { usage: null });
    const c = await finish(start({ resumeSessionId: 's9' }));
    expect(c).toMatchObject({ ok: false, numTurns: 1 });
    expect(couldNotContinue(c, false)).toBe(false);
  });
});

describe('a run that was stopped or crashed before it reported a result', () => {
  const work = [init(), assistant('m1', { input: 10, output: 50, cacheRead: 1000, cacheWrite: 100 }), assistant('m1', { input: 10, output: 80, cacheRead: 1000, cacheWrite: 100 }, [toolCall('t1')]), toolResult('t1'), assistant('m2', { input: 5, output: 20, cacheRead: 1200 }, [toolCall('t2'), toolCall('t3')]), toolResult('t2'), toolResult('t3'), assistant('s1', { input: 3, output: 7, cacheRead: 50 }, [], 'tool_x'), toolResult('t9', 'tool_x')];

  it('shows the turns and tokens its stream carried, and no cost it cannot know', async () => {
    stream([...work, untilAborted], { usage: null });
    const r = start();
    await vi.waitFor(() => expect(r.events.filter((e) => e.type === 'tool_result')).toHaveLength(4));
    r.ac.abort();
    const c = await finish(r);
    // Two API calls of the agent (the last count of each) and one of a subagent; 1 prompt + 3 tool results.
    expect(c).toMatchObject({ ok: false, errorKind: 'interrupted', error: expect.stringContaining('aborted'), numTurns: 4, costUsd: 0, inputTokens: 1110 + 1205 + 53, outputTokens: 80 + 20 + 7 });
  });

  it("books the cost last read while it worked, when it is stopped before it reports", async () => {
    vi.useFakeTimers();
    try {
      USAGE_READS.everyMs = 1000;
      const log: string[] = [];
      stream([...work, untilAborted], { log, usage: usageOf({ total_cost_usd: 1.5, model_usage: { 'claude-opus-5-5': model(25, 120, 2250, 100), 'claude-haiku-4-5': model(900, 5, 0, 0) } }) });
      const r = start();
      await vi.advanceTimersByTimeAsync(1100); // the stream is consumed and the first reading is taken
      expect(log).toEqual(['usage']);
      r.ac.abort(); // nothing is asked or waited for at the stop: the process is cut at once
      const c = await finish(r);
      expect(log).toEqual(['usage', 'abort']);
      expect(c.costUsd).toBeCloseTo(1.5, 6);
      expect(c).toMatchObject({ ok: false, errorKind: 'interrupted', numTurns: 4 });
      // The session's own count includes the helper model's calls the stream doesn't show.
      expect(c.inputTokens).toBe(25 + 2250 + 100 + 900);
      expect(c.outputTokens).toBe(125);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the latest reading, stops reading once the result is in, and never has two readings under way', async () => {
    vi.useFakeTimers();
    try {
      USAGE_READS.everyMs = 1000;
      const log: string[] = [];
      let n = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      stream([init(), assistant('m1', { input: 1, output: 1 }), () => gate, result({ total_cost_usd: 2.5 })], {
        log,
        usage: async () => ({ session: { total_cost_usd: ++n, model_usage: {} } }),
      });
      const r = start();
      await vi.advanceTimersByTimeAsync(3100);
      expect(log).toEqual(['usage', 'usage', 'usage']);
      release();
      await vi.advanceTimersByTimeAsync(10);
      const c = await finish(r);
      await vi.advanceTimersByTimeAsync(5000);
      expect(log).toEqual(['usage', 'usage', 'usage']); // none after the end
      expect(c.costUsd).toBe(2.5); // the result's own number, not a reading
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reading that never answers is waited for only so long, and doesn't pile up", async () => {
    vi.useFakeTimers();
    try {
      USAGE_READS.everyMs = 1000;
      const log: string[] = [];
      stream([init(), assistant('m1', { input: 1, output: 1 }), untilAborted], { log, usage: () => new Promise(() => undefined) });
      const r = start();
      await vi.advanceTimersByTimeAsync(4500);
      expect(log).toEqual(['usage']); // one reading under way, the later ticks skipped it
      await vi.advanceTimersByTimeAsync(3000); // its time (5 s after the first tick) is up at 6 s; the tick at 7 s asks again
      expect(log).toEqual(['usage', 'usage']);
      r.ac.abort();
      const c = await finish(r);
      expect(c).toMatchObject({ ok: false, errorKind: 'interrupted', costUsd: 0, numTurns: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a crash gets the same: what the stream showed', async () => {
    stream([...work.slice(0, 5), new Error('Claude Code process exited with code 1')], { usage: null, stderr: 'segfault\n' });
    const c = await finish(start());
    expect(c).toMatchObject({ ok: false, errorKind: 'execution', numTurns: 2, costUsd: 0, inputTokens: 1110 + 1205, outputTokens: 100 });
    expect(c.error).toContain('segfault');
  });

  it("a run that never got going stays at zeros (the resume failure that must start fresh looks like this)", async () => {
    stream([new Error('No conversation found with session ID: x')], { usage: null });
    const c = await finish(start({ resumeSessionId: 'x' }));
    expect(c).toMatchObject({ ok: false, numTurns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
  });
});

describe("a resumed session's cost belongs to the session, not to the run", () => {
  it('reports what the run added: the repair that cost $0.97 is not booked at $7.74', async () => {
    stream([init(), assistant('m1', { input: 22, output: 11943, cacheRead: 2953504, cacheWrite: 17500 }), AFTER_REPAIR], { usage: usageOf(AFTER_FIRST_RUN) });
    const c = await finish(start({ resumeSessionId: 's1' }));
    expect(c.costUsd).toBeCloseTo(0.9696488, 6);
    expect(c).toMatchObject({ ok: true, numTurns: 18, inputTokens: 14373302 - 11402276, outputTokens: 134343 - 122400 });
  });

  it('a fresh session reports the totals as they are, and asks nothing', async () => {
    const log: string[] = [];
    stream([init(), AFTER_REPAIR], { log, usage: usageOf(AFTER_FIRST_RUN) });
    const c = await finish(start());
    expect(log).toEqual([]);
    expect(c.costUsd).toBeCloseTo(7.7373456, 6);
    expect(c.inputTokens).toBe(14373302);
  });

  it('takes totals that are below where the run started as the run\'s own (the SDK began counting again)', async () => {
    stream([init(), result({ total_cost_usd: 0.4, modelUsage: { 'claude-opus-5-5': model(10, 100, 1000, 50) } })], { usage: usageOf(AFTER_FIRST_RUN) });
    const c = await finish(start({ resumeSessionId: 's1' }));
    expect(c).toMatchObject({ costUsd: 0.4, inputTokens: 1060, outputTokens: 100 });
  });

  it("estimates the run's share from its own tokens when the session's starting totals can't be read, instead of booking the whole session", async () => {
    stream([init(), assistant('m1', { input: 20, output: 12000, cacheRead: 3000000, cacheWrite: 18000 }), AFTER_REPAIR], { usage: null });
    const c = await finish(start({ resumeSessionId: 's1' }));
    // 16% of the session's weighted tokens: about $1.2 of the $7.74 (it was $0.97).
    expect(c.costUsd).toBeGreaterThan(0.8);
    expect(c.costUsd).toBeLessThan(1.6);
    expect(c.inputTokens).toBe(20 + 3000000 + 18000);
    expect(c.outputTokens).toBe(12000);
  });

  it('waits for the starting totals before it books a result that comes right after the start', async () => {
    let answer: (v: unknown) => void = () => undefined;
    stream([init(), AFTER_REPAIR], { usage: () => new Promise((r) => (answer = r)) });
    const r = start({ resumeSessionId: 's1' });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.completions()).toHaveLength(0);
    answer({ session: AFTER_FIRST_RUN });
    expect((await finish(r)).costUsd).toBeCloseTo(0.9696488, 6);
  });
});

describe('RunAccounting', () => {
  it("counts a response's text and tool-call messages as one API call, and subagents' calls in the tokens but not the turns", () => {
    const a = new RunAccounting(false);
    for (const m of [assistant('m1', { input: 1, output: 5, cacheRead: 10, cacheWrite: 2 }), assistant('m1', { input: 1, output: 9, cacheRead: 10, cacheWrite: 2 }), assistant('sub', { input: 4, output: 4 }, [], 'tool_x'), toolResult('x', 'tool_x'), toolResult('y')]) a.observe(m);
    expect(a.fromStream()).toEqual({ inputTokens: 13 + 4, outputTokens: 9 + 4, numTurns: 2 });
  });

  it('does not count an error from the API as the agent answering', () => {
    const a = new RunAccounting(false);
    a.observe(apiError());
    expect(a.worked).toBe(false);
    expect(a.fromStream().numTurns).toBe(0);
    a.observe(assistant('m1', { input: 1, output: 1 }));
    expect(a.worked).toBe(true);
    expect(a.fromStream().numTurns).toBe(1);
  });

  it("says no turns before the agent has spoken", () => {
    expect(new RunAccounting(false).fromStream()).toEqual({ inputTokens: 0, outputTokens: 0, numTurns: 0 });
  });
});

describe('translate', () => {
  it('still turns the stream into events as before', () => {
    expect(translate(init(), 0)).toMatchObject([{ type: 'started', providerSessionId: 's1', model: 'claude-opus-5-5' }]);
    expect(translate(assistant('m1', {}, [{ type: 'text', text: 'hi' }, toolCall('t1')]), 0)).toMatchObject([{ type: 'text', text: 'hi', partial: false }, { type: 'tool_call', id: 't1', toolClass: 'mcp' }]);
    expect(translate(toolResult('t1'), 0)).toMatchObject([{ type: 'tool_result', id: 't1', isError: false }]);
    expect(translate(result(), 0)).toMatchObject([{ type: 'completed', ok: true, costUsd: 0.5, inputTokens: 1060, outputTokens: 100, numTurns: 3 }]);
  });
});
