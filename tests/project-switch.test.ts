import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreHarness, waitFor } from './helpers/make-core';
import type { FakeScript } from './helpers/fake-provider';

const makeCore = coreHarness();

/** One long task whose first run works until it is interrupted (and takes a moment to come back). */
function longTask(counter: { started: number; cameBack: number }): FakeScript {
  return {
    respond: async (req, kind) => {
      if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Long task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
      if (kind === 'work') {
        counter.started++;
        if (!req.resumeSessionId) {
          await new Promise((_r, reject) =>
            req.signal.addEventListener('abort', () => setTimeout(() => {
              counter.cameBack++;
              reject(new Error('aborted'));
            }, 400), { once: true }),
          );
        }
        return { status: 'implemented', summary: 'ok' };
      }
      if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
      return null;
    },
  };
}

describe('switching a window to another project while agents work', () => {
  it('interrupts the agents and waits for them before the project closes; the work carries on when it opens again', async () => {
    const counter = { started: 0, cameBack: 0 };
    const { core, provider, ctx } = await makeCore(longTask(counter));
    const first = ctx.summary.id;
    const obj = core.orchestrator.submitObjective({ title: 'Long', description: 'x', skipResearch: true });
    await waitFor(() => counter.started === 1);
    const other = core.createProject({ name: 'Other', rootPath: mkdtempSync(join(tmpdir(), 'shuriken-proj-')) });

    await core.switchProject(other.id, { hold: true });
    // The new project counts none of the old runs.
    expect(core.project?.summary.id).toBe(other.id);
    expect(core.orchestrator.state().activeRuns).toBe(0);
    expect(core.runner.activeRuns()).toEqual([]);

    // The run came back while the store was still open: nothing was left running for crash recovery to find.
    const back = await core.switchProject(first, { hold: true });
    const task = back.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Long task')!;
    expect(task.status).toBe('ready');
    const run = core.runner.listRuns(back, { taskId: task.id })[0]!;
    expect(run.status).toBe('interrupted');
    expect(run.error ?? '').not.toMatch(/restarted or crashed/);
    expect(back.tasks.failures(task.id).map((f) => f.summary).join('\n')).not.toMatch(/restart or crash/);
    // Opened on hold like any project; resuming continues the agent's own session.
    expect(core.orchestrator.state()).toMatchObject({ held: true });
    core.orchestrator.resume();
    await waitFor(() => back.tasks.get(obj.id)?.status === 'done');
    const work = provider.runs.filter((r) => r.role === 'roblox-engineer');
    expect(work).toHaveLength(2);
    expect(work[1]!.resumeSessionId).toBe(`s-${work[0]!.runId}`);
  }, 60000);

  it('leaves the current project open, its agents working, when the other one is open elsewhere', async () => {
    const counter = { started: 0, cameBack: 0 };
    const { core, ctx } = await makeCore(longTask(counter));
    core.orchestrator.submitObjective({ title: 'Long', description: 'x', skipResearch: true });
    await waitFor(() => counter.started === 1);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const other = core.createProject({ name: 'Elsewhere', rootPath: root });
    // Another window (a live process: this one) holds it.
    const lock = join(root, '.shuriken', 'open.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));

    await expect(core.switchProject(other.id, { hold: true })).rejects.toThrow(/already open in another Shuriken Studio window/);
    expect(core.project).toBe(ctx);
    expect(counter.cameBack).toBe(0);
    expect(core.orchestrator.state().activeRuns).toBe(1);
    rmSync(lock);
  }, 60000);
});
