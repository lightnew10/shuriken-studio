import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HOUSEKEEPING, compactResult, housekeep, housekeepAll } from '../src/core/projects/housekeeping';
import { coreHarness } from './helpers/make-core';

const makeCore = coreHarness();
const DAY = 24 * 3600_000;

describe('housekeeping of a long build’s history', () => {
  it('archives old transcripts of finished work and old status lines, then removes them; never the work itself', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Goal', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const doneTask = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Done work', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    for (const s of ['running', 'verifying', 'verified', 'done'] as const) ctx.tasks.setStatus(doneTask.id, s);
    // What the chat said about it is days old by this test's 'now' (it was written at the real time, which is less than
    // three days before 'now' after midday on 2026-10-07).
    ctx.store.run("UPDATE chat_messages SET created_at = ? WHERE role = 'system'", [at(4 * DAY)]);
    const openTask = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Open work', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    const run = (id: string, taskId: string, agoMs: number) => {
      ctx.store.run("INSERT INTO runs (id, task_id, role, provider_id, status, started_at, ended_at, cost_usd) VALUES (?, ?, 'roblox-engineer', 'fake', 'completed', ?, ?, 1.5)", [id, taskId, at(agoMs + 60_000), at(agoMs)]);
      for (let i = 0; i < 3; i++) ctx.audit.appendRunMessage(id, i, 'text', `step ${i} of ${id}`);
      ctx.store.run("INSERT INTO tool_calls (id, run_id, task_id, source, tool, args, result, status, started_at, files_changed) VALUES (?, ?, ?, 'mcp', 'roblox_playtest', ?, ?, 'ok', ?, '[\"src/A.luau\"]')", [`tc_${id}`, id, taskId, JSON.stringify({ code: 'x'.repeat(5000) }), JSON.stringify({ content: [{ type: 'text', text: 'Played 3 s. ' + 'y'.repeat(2000) }, { type: 'image', data: 'z'.repeat(9000) }] }), at(agoMs + 30_000)]);
    };
    run('run_old_done', doneTask.id, 3 * DAY);
    run('run_old_open', openTask.id, 3 * DAY); // its task is still open: kept
    run('run_new_done', doneTask.id, 2 * 3600_000); // a few hours old: kept
    const limits = { ...HOUSEKEEPING, keepRuns: 1 }; // keep only the newest run regardless
    // Chat: old status lines beyond the newest messages go; the user's words and the director's replies stay.
    const chatAdd = (role: string, kind: string, text: string, agoMs: number, data: unknown = null) =>
      ctx.store.run('INSERT INTO chat_messages (id, role, kind, text, data, created_at, channel) VALUES (?, ?, ?, ?, ?, ?, ?)', [`msg_${Math.random().toString(36).slice(2)}`, role, kind, text, data ? JSON.stringify(data) : null, at(agoMs), 'director']);
    for (let i = 0; i < 5; i++) chatAdd('system', 'status', `old status ${i}`, 5 * DAY + i);
    chatAdd('user', 'text', 'make the range bigger', 5 * DAY);
    chatAdd('director', 'text', 'On it.', 5 * DAY);
    chatAdd('director', 'plan', 'Plan of the finished goal', 5 * DAY, { objectiveId: 'task_gone' });
    chatAdd('director', 'plan', 'Plan of the open goal', 5 * DAY, { objectiveId: goal.id });
    for (let i = 0; i < 3; i++) chatAdd('system', 'status', `new status ${i}`, 1000 + i);
    const before = { tasks: ctx.store.get<{ n: number }>('SELECT count(*) n FROM tasks')!.n, runs: ctx.store.get<{ n: number }>('SELECT count(*) n FROM runs')!.n };

    const r = housekeep(ctx, now, { ...limits, keepChat: 3 });
    expect(r).toMatchObject({ runs: 1, messages: 3, toolCalls: 1 });
    // The six old lines here (and any status line the project wrote when it was made, days before this 'now').
    expect(r.chat).toBeGreaterThanOrEqual(6);
    // The old finished run's steps are gone from the database, the others' are all there.
    expect(ctx.audit.runMessages('run_old_done')).toEqual([]);
    expect(ctx.audit.runMessages('run_old_open')).toHaveLength(3);
    expect(ctx.audit.runMessages('run_new_done')).toHaveLength(3);
    // Its tool call keeps its row (tool, status, time, files) with the input dropped and the result cut to its words.
    const call = ctx.store.get<{ args: string | null; result: string; files_changed: string; status: string }>("SELECT args, result, files_changed, status FROM tool_calls WHERE id = 'tc_run_old_done'")!;
    expect(call.args).toBeNull();
    expect(call.status).toBe('ok');
    expect(call.files_changed).toBe('["src/A.luau"]');
    expect(call.result.length).toBeLessThan(700);
    expect(call.result).toContain('Played 3 s.');
    // Everything was written to the archive first, readable with plain gunzip.
    const transcripts = gunzipSync(readFileSync(join(ctx.dir, 'archive', 'transcripts-2026-10.jsonl.gz'))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].run.id).toBe('run_old_done');
    expect(transcripts[0].messages).toHaveLength(3);
    expect(transcripts[0].toolCalls[0].args).toContain('xxxx');
    // The chat keeps the user's words, the replies, the open goal's plan and the newest messages.
    const left = ctx.store.all<{ text: string }>('SELECT text FROM chat_messages ORDER BY created_at').map((m) => m.text);
    expect(left).toEqual(['make the range bigger', 'On it.', 'Plan of the open goal', 'new status 2', 'new status 1', 'new status 0']);
    const chatArchive = gunzipSync(readFileSync(join(ctx.dir, 'archive', 'chat-2026-10.jsonl.gz'))).toString('utf8');
    expect(chatArchive).toContain('old status 4');
    expect(chatArchive).toContain('Plan of the finished goal');
    // The work itself is untouched.
    expect(ctx.store.get<{ n: number }>('SELECT count(*) n FROM tasks')!.n).toBe(before.tasks);
    expect(ctx.store.get<{ n: number }>('SELECT count(*) n FROM runs')!.n).toBe(before.runs);
    expect(ctx.store.get<{ c: number }>("SELECT cost_usd c FROM runs WHERE id = 'run_old_done'")!.c).toBe(1.5);
    // Nothing left to do: a second pass changes nothing, and appends nothing.
    expect(housekeep(ctx, now, { ...limits, keepChat: 3 })).toMatchObject({ runs: 0, chat: 0 });
    expect(gunzipSync(readFileSync(join(ctx.dir, 'archive', 'transcripts-2026-10.jsonl.gz'))).toString('utf8').trim().split('\n')).toHaveLength(1);
  });

  it('works through a big history in short batches', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const now = Date.now() + 10 * DAY;
    const t = ctx.tasks.create({ kind: 'implement', title: 'Old', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    ctx.tasks.setStatus(t.id, 'cancelled');
    for (let i = 0; i < 130; i++) {
      ctx.store.run("INSERT INTO runs (id, task_id, role, provider_id, status, started_at, ended_at) VALUES (?, ?, 'roblox-engineer', 'fake', 'completed', ?, ?)", [`run_${i}`, t.id, new Date(Date.now() - 1000 * (200 - i)).toISOString(), new Date(Date.now() - 1000 * (199 - i)).toISOString()]);
      ctx.audit.appendRunMessage(`run_${i}`, 0, 'text', 'x');
    }
    const r = await housekeepAll(ctx, now);
    expect(r.runs).toBe(130 - HOUSEKEEPING.keepRuns);
    expect(ctx.store.get<{ n: number }>('SELECT count(*) n FROM run_messages')!.n).toBe(HOUSEKEEPING.keepRuns);
  });

  it('cuts a result to its words', () => {
    expect(JSON.parse(compactResult(JSON.stringify({ content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA' }] }))!)).toEqual({ content: [{ type: 'text', text: 'ok' }, { type: 'text', text: '[image archived]' }], archived: true });
    expect(compactResult(null)).toBeNull();
  });
});

describe('the Agents page’s run detail on a long run', () => {
  it('sends the newest steps without tool results, tool calls or context, and says how many it left out', async () => {
    const { createRouter, RUN_STEPS_SHOWN } = await import('../src/core/rpc/router');
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    ctx.store.run("INSERT INTO runs (id, task_id, role, provider_id, status, started_at) VALUES ('run_long', NULL, 'roblox-engineer', 'fake', 'running', ?)", [new Date().toISOString()]);
    for (let i = 0; i < 500; i++) ctx.audit.appendRunMessage('run_long', 2 * i, 'text', `step ${i}`);
    for (let i = 0; i < 500; i++) ctx.audit.appendRunMessage('run_long', 2 * i + 1, 'tool_result', { out: 'x'.repeat(100) });
    const rpc = createRouter(core) as unknown as Record<string, (a?: unknown) => unknown>;
    const lean = rpc['runs.get']!({ id: 'run_long', lean: true }) as { messages: Array<{ kind: string }>; olderSteps: number; toolCalls?: unknown; context: unknown };
    expect(lean.messages).toHaveLength(RUN_STEPS_SHOWN);
    expect(lean.messages.every((m) => m.kind !== 'tool_result')).toBe(true);
    expect(lean.olderSteps).toBe(500 - RUN_STEPS_SHOWN);
    expect(lean.toolCalls).toBeUndefined();
    expect(lean.context).toBeNull();
    const full = rpc['runs.get']!({ id: 'run_long' }) as { messages: unknown[]; toolCalls: unknown[] };
    expect(full.messages).toHaveLength(1000);
    expect(Array.isArray(full.toolCalls)).toBe(true);
  });
});
