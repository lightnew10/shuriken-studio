import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../src/core/providers/types';
import { NOT_REPRODUCED, REOPEN_FAILURE, REOPENED_NOTE, REPRODUCE_FIRST, openReopen, reproduced } from '../src/core/orchestrator/reopen';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * Orchestrator.reopen: the user says a finished task is still broken. In the Pit build the touch bow "passed its
 * checks and review" five times while the user reported it broken five times; each report became a new task that
 * started from the same assumptions. A reopened task keeps its history, carries the report, and its next attempt
 * must show the failure in Studio before its work counts.
 */
const makeCore = coreHarness();
const pass = { verdict: 'pass', summary: 'Looks right.', criteria: [{ criterion: 'works', met: true, evidence: 'seen' }], defects: [] };
const REPORT = 'The bow still shoots right of the reticle on my phone';

type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
const textOf = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

async function finishedTask(worker: (req: AgentRunRequest, attempt: number, call: Call) => Promise<unknown>) {
  let attempts = 0;
  const reviews: AgentRunRequest[] = [];
  const h = await makeCore({
    respond: async (req, kind, call) => {
      if (kind === 'work') return worker(req, ++attempts, call);
      if (kind === 'review') {
        reviews.push(req);
        return pass;
      }
      return null;
    },
  });
  const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Bow combat', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
  const task = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Touch bow aiming on phones', objective: 'Aim the bow with one finger on phones.', role: 'roblox-engineer', status: 'ready', acceptanceCriteria: ['The arrow lands on the reticle'], verification: [{ kind: 'critic' }], createdBy: 'executive', maxAttempts: 3 });
  await waitFor(() => h.ctx.tasks.get(goal.id)!.status === 'done', 60000);
  return { ...h, goal, task: h.ctx.tasks.get(task.id)!, reviews, attempts: () => attempts };
}

describe('reopening a finished task the user says is still broken', () => {
  it('comes back with the report and "reproduce first", keeps its history, and its work counts only once the failure was shown', async () => {
    const prompts: string[] = [];
    const h = await finishedTask(async (req, attempt, call) => {
      prompts.push(req.prompt);
      // Attempt 3 (the second after the reopen) shows the failure first, as asked.
      if (attempt === 3) await call('task_add_evidence', { kind: 'test_result', title: 'Reproduced: the arrow lands 34 px right of the reticle with a touch drag', passed: false });
      return { status: 'implemented', summary: attempt === 1 ? 'Touch aiming done' : 'Aim offset fixed' };
    });
    expect(h.task.status).toBe('done');
    const before = { evidence: h.ctx.tasks.evidence(h.task.id).length, runs: h.core.runner.listRuns(h.ctx).length };
    h.core.orchestrator.pause();

    const r = h.core.orchestrator.reopen(h.task.id, REPORT);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Reopened "Touch bow aiming on phones"\. Its next attempt first shows the problem in Studio/);
    const t = h.ctx.tasks.get(h.task.id)!;
    expect(t.status).toBe('ready');
    expect(t.acceptanceCriteria[0]).toMatch(new RegExp(`^${REPRODUCE_FIRST} before changing any code, show in Studio the problem the user reported \\("${REPORT}"\\)`));
    expect(t.acceptanceCriteria.slice(1)).toEqual(['The arrow lands on the reticle']);
    // Its history stays: the earlier evidence and runs, the attempt it used; it gets a fresh allowance on top.
    expect(h.ctx.tasks.evidence(t.id).length).toBe(before.evidence + 1);
    expect(h.ctx.tasks.evidence(t.id).at(-1)!.title).toBe(`${REOPENED_NOTE}: ${REPORT}`);
    expect(h.core.runner.listRuns(h.ctx).length).toBe(before.runs);
    expect(t.attempts).toBe(1);
    expect(t.maxAttempts).toBeGreaterThanOrEqual(1 + h.ctx.settings().maxAttemptsPerTask);
    expect(h.ctx.tasks.failures(t.id).at(-1)!.summary).toBe(`${REOPEN_FAILURE}: ${REPORT}`);
    expect(openReopen(h.ctx, t)).toMatchObject({ report: REPORT });
    // The goal it belongs to is open again, so its wrap-up runs again.
    expect(h.ctx.tasks.get(h.goal.id)!.status).toBe('ready');

    h.core.orchestrator.resume();
    // Attempt 2 changed code without showing the problem: sent back before its checks, and the chat says why.
    await waitFor(() => h.ctx.tasks.failures(t.id).some((f) => f.summary === NOT_REPRODUCED), 60000);
    expect(prompts[1]).toContain(`STILL BROKEN: "${REPORT}"`);
    expect(prompts[1]).toContain('Reproduce first');
    await waitFor(() => h.ctx.tasks.get(t.id)!.status === 'done', 60000);
    const said = h.core.director
      .chat()!
      .list()
      .flatMap((m) => (m.data?.digest ? (m.data.items as Array<{ text: string }>).map((i) => i.text) : []));
    expect(h.attempts()).toBe(3);
    // Attempt 3 showed it, then passed; the reviewer was told what the user reported (a reopened task is always reviewed).
    expect(reproduced(h.ctx, t.id, openReopenAt(h))).toBe(true);
    expect(h.reviews.at(-1)!.prompt).toContain(`the user reported it STILL BROKEN: "${REPORT}"`);
    expect(said.some((l) => /^Done: Touch bow aiming on phones .*not checked on a real device/.test(l))).toBe(true);
    // Settled: done again since the report.
    expect(openReopen(h.ctx, h.ctx.tasks.get(t.id)!)).toBeNull();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    // The goal finishing again is said again.
    expect(h.core.director.chat()!.list().filter((m) => m.kind === 'done' && m.data?.objectiveId === h.goal.id)).toHaveLength(2);
  }, 120000);

  it('a failing run of its checks is recorded as the reproduction', async () => {
    const h = await finishedTask(async () => ({ status: 'implemented', summary: 'Done' }));
    h.core.orchestrator.pause();
    h.core.orchestrator.reopen(h.task.id, REPORT);
    const at = openReopen(h.ctx, h.ctx.tasks.get(h.task.id)!)!.at;
    expect(reproduced(h.ctx, h.task.id, at)).toBe(false);
    // What task_run_checks records for a reopened task when its checks fail (app-tools.ts).
    h.ctx.tasks.addEvidence({ taskId: h.task.id, runId: 'run_x', kind: 'test_result', title: 'Reproduced before the fix: bow_lands_on_reticle fail', passed: false, data: null, path: null });
    expect(reproduced(h.ctx, h.task.id, at)).toBe(true);
  }, 90000);

  it('reaches a task still being worked on: the report is on it and its agent reads it with its next tool result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seen = '';
    let started = false;
    const h = await makeCore({
      respond: async (_req, kind, call) => {
        if (kind === 'work') {
          if (!started) {
            started = true;
            await gate;
          }
          seen += textOf(await call('task_add_evidence', { kind: 'test_result', title: 'Reproduced: lands right of the reticle', passed: false }));
          return { status: 'implemented', summary: 'Fixed' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Bow combat', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const task = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Touch bow', objective: 'x', role: 'roblox-engineer', status: 'ready', acceptanceCriteria: ['works'], verification: [{ kind: 'critic' }], createdBy: 'executive' });
    await waitFor(() => h.ctx.tasks.get(task.id)!.status === 'running');
    const r = h.core.orchestrator.reopen(task.id, REPORT);
    expect(r).toEqual({ ok: true, message: '"Touch bow" is being worked on right now: the report is on it, and its agent was told. Its work counts only once the problem is shown in Studio and then fixed.' });
    release();
    await waitFor(() => h.ctx.tasks.get(task.id)!.status === 'done', 60000);
    expect(seen).toContain(`STILL BROKEN: "${REPORT}"`);
  }, 90000);

  it("says no, plainly, to what can't be reopened", async () => {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Bow combat', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const gone = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Old bow', objective: 'x', role: 'roblox-engineer', status: 'cancelled', createdBy: 'executive' });
    expect(h.core.orchestrator.reopen('task_nope', REPORT)).toEqual({ ok: false, message: 'There is no task task_nope.' });
    expect(h.core.orchestrator.reopen(goal.id, REPORT).ok).toBe(false);
    expect(h.core.orchestrator.reopen(gone.id, REPORT)).toEqual({ ok: false, message: '"Old bow" was cancelled, so there is nothing to reopen: ask for it again as a change.' });
    expect(h.core.orchestrator.reopen(gone.id, '   ').ok).toBe(false);
    expect(h.ctx.tasks.get(gone.id)!.status).toBe('cancelled');
  });
});

function openReopenAt(h: { ctx: { tasks: { evidence: (id: string) => Array<{ title: string; createdAt: string }> } }; task: { id: string } }): string {
  return h.ctx.tasks.evidence(h.task.id).filter((e) => e.title.startsWith(REOPENED_NOTE)).at(-1)!.createdAt;
}
