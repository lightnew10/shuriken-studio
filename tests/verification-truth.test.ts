import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationMethod } from '../src/shared/domain';
import { MEMORY_NOT_JUDGED } from '../src/core/verification/verifier';
import { editedPath, filesInFlight } from '../src/core/roblox/code-sync';
import { coreHarness } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * Verification that tells the truth: at least half of the failed verifications of the user's 8-hour build were
 * not defects of the work (another agent's half-written file pushed by the verifier, Studio's own memory use
 * read as the game's).
 */
const makeCore = coreHarness();
const MAP = { 'src/Server': 'ServerScriptService/Server', 'src/Client': 'StarterPlayer/StarterPlayerScripts/Client' };

async function setup(verification: VerificationMethod[]) {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  h.ctx.updateExtras({ syncMode: 'shuriken', syncMap: MAP });
  const write = (rel: string, body: string) => {
    mkdirSync(join(h.root, rel, '..'), { recursive: true });
    writeFileSync(join(h.root, rel), body, 'utf8');
  };
  const sim = attachSim(h.core);
  const task = h.ctx.tasks.create({ kind: 'implement', title: 'Audio mix', objective: 'x', role: 'sound-designer', status: 'running', createdBy: 'test', verification });
  const running = (id: string, status = 'running') => h.ctx.store.run('INSERT INTO runs (id, task_id, role, provider_id, model, status, started_at) VALUES (?, NULL, ?, ?, NULL, ?, ?)', [id, 'ui-engineer', 'fake', status, new Date().toISOString()]);
  const edited = (runId: string, rel: string) => h.ctx.audit.beginToolCall({ runId, taskId: null, role: 'ui-engineer', providerId: 'fake', source: 'agent_builtin', tool: 'Edit', capability: 'fake.edit_files', args: { file_path: join(h.root, rel) } });
  return { ...h, sim, task, write, running, edited };
}

describe("the verifier's code sync and files other agents are still writing", () => {
  it("leaves them out (Studio keeps their last synced version) and says which", async () => {
    const { core, ctx, sim, task, write, running, edited } = await setup([{ kind: 'luau_assert', name: 'mix_ready', luau: "return 'PASS'", datamodel: 'edit' }]);
    write('src/Server/Audio.server.luau', 'print("audio v1")\n');
    write('src/Client/Garage.client.luau', 'print("garage v1")\n');
    expect((await core.sync.push(ctx.root, MAP)).errors).toEqual([]);
    // The task's own work, and another agent halfway through the garage file.
    write('src/Server/Audio.server.luau', 'print("audio v2")\n');
    write('src/Client/Garage.client.luau', 'local function open(\n-- half written\n');
    running('run_garage');
    edited('run_garage', 'src/Client/Garage.client.luau');
    running('run_finished', 'completed');
    edited('run_finished', 'src/Server/Audio.server.luau');

    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, 'run_audio', ['src/Server/Audio.server.luau']);
    expect(report.passed, report.summary).toBe(true);
    expect(sim.place.scripts.get('ServerScriptService/Server/Audio')!.source).toBe('print("audio v2")\n');
    expect(sim.place.scripts.get('StarterPlayer/StarterPlayerScripts/Client/Garage')!.source).toBe('print("garage v1")\n');
    const sync = report.results.find((r) => r.name === 'code sync')!;
    expect(sync.output).toMatch(/Synced: 0 created, 1 updated, 0 unchanged/);
    expect(sync.output).toMatch(/Left out 1 file\(s\) other agents are still editing .*: src\/Client\/Garage\.client\.luau\./);
    const ev = ctx.tasks.evidence(task.id).find((e) => e.title.startsWith('Code sync into Studio'))!;
    expect(ev.title).toBe('Code sync into Studio (1 file other agents are editing left out)');
    expect((ev.data as { leftOut: string[] }).leftOut).toEqual(['src/Client/Garage.client.luau']);
  });

  // A sound designer's task (it edits no file itself: its tools write its module) failed on three errors in a script
  // an engineer was still writing.
  it("static analysis: a task that edited no file doesn't answer for the project's files, running agents' or finished", async () => {
    const { core, ctx, task, running, edited } = await setup([{ kind: 'static_analysis' }]);
    const problem = (file: string, message: string) => ({ file, line: 16, column: 1, severity: 'error' as const, tool: 'luau-lsp', code: 'TypeError', message });
    (core.verifier as unknown as { deps: { luau: unknown } }).deps.luau = {
      check: async () => ({ problems: [problem('src/Server/SlotServer.server.luau', "Value of type 'Instance?' could be nil")], toolErrors: [], durationMs: 5 }),
    };
    running('run_engineer');
    edited('run_engineer', 'src/Server/SlotServer.server.luau');
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, 'run_sound', []);
    const check = report.results.find((r) => r.kind === 'static_analysis')!;
    expect(check.passed, check.output).toBe(true);
    expect(check.output).toMatch(/^0 problem\(s\), 0 error\(s\) in this task \(it changed no Luau file\)/);
    expect(check.output).toMatch(/1 problem\(s\) in files outside this task \(not blocking here; the regression suite requires them fixed\):\nsrc\/Server\/SlotServer\.server\.luau:16:1 error/);
    // Nobody is writing that file any more: still not this task's (a modeler's task failed three times in the Pit
    // build on a finished client script's error); the regression suite and the file's writer answer for it.
    ctx.store.run("UPDATE runs SET status = 'completed' WHERE id = 'run_engineer'");
    const later = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, 'run_sound', []);
    const after = later.results.find((r) => r.kind === 'static_analysis')!;
    expect(after.passed, after.output).toBe(true);
    expect(after.output).toMatch(/1 problem\(s\) in files outside this task/);
  });

  // A ui-engineer wrote a 26 KB module in one Write; the audit keeps such arguments cut, the path was not found in
  // them, and the animator's task was failed for the module's errors (and then edited the engineer's file).
  it('knows a file is being edited when the Write that made it was too long to keep whole', async () => {
    const { ctx, running } = await setup([{ kind: 'static_analysis' }]);
    running('run_ui');
    const big = join(ctx.root, 'src/Client/UI/Kit.luau');
    ctx.audit.beginToolCall({ runId: 'run_ui', taskId: null, role: 'ui-engineer', providerId: 'fake', source: 'agent_builtin', tool: 'Write', capability: 'fake.edit_files', args: { file_path: big, content: 'local Kit = {}\n'.repeat(4000) } });
    const stored = ctx.audit.toolCalls({ runId: 'run_ui', limit: 5 })[0]!.args as { truncated?: boolean; file_path?: string };
    expect(stored.truncated).toBe(true);
    expect(stored.file_path).toBeUndefined();
    expect(editedPath(stored)).toBe(big);
    expect(filesInFlight(ctx, 'run_other')).toEqual(['src/Client/UI/Kit.luau']);
    expect(editedPath({ file_path: 'a.luau' })).toBe('a.luau');
    expect(editedPath({ truncated: true, head: '{"content":"no path here' })).toBeNull();
    expect(editedPath(null)).toBeNull();
  });

  it("says so when a file left out is one of the task's own", async () => {
    const { core, ctx, task, write, running, edited } = await setup([{ kind: 'luau_assert', name: 'mix_ready', luau: "return 'PASS'", datamodel: 'edit' }]);
    write('src/Server/Audio.server.luau', 'print("audio")\n');
    running('run_other');
    edited('run_other', 'src/Server/Audio.server.luau');
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null, ['src/Server/Audio.server.luau']);
    expect(report.results.find((r) => r.name === 'code sync')!.output).toMatch(/1 of them is also this task's \(src\/Server\/Audio\.server\.luau\): the checks ran against the version last synced\./);
  });

  it('the regression suite (nobody else at work) pushes everything', async () => {
    const { core, ctx, sim, write } = await setup([]);
    write('src/Server/Audio.server.luau', 'print("audio")\n');
    const { TestService } = await import('../src/core/verification/test-service');
    new TestService(ctx.store).register({ name: 'edit_ok', method: { kind: 'luau_assert', name: 'edit_ok', luau: "return 'PASS'", datamodel: 'edit' }, taskId: null });
    const report = await core.verifier.regression(ctx, null);
    expect(report.passed, report.summary).toBe(true);
    expect(report.results.find((r) => r.name === 'code sync')!.output).not.toMatch(/Left out/);
    expect(sim.place.scripts.has('ServerScriptService/Server/Audio')).toBe(true);
  });
});

describe('the memory budget of a perf check', () => {
  const stats = (o: Record<string, number>) => (code: string) => (code.includes('GetTotalMemoryUsageMb') ? JSON.stringify(o) : code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'PASS');

  it('never fails the check in Studio (the figure is the whole Studio process); the number is still reported, and the check says once that the budget is ignored', async () => {
    const { core, ctx, sim, task } = await setup([{ kind: 'perf', name: 'bots_perf', durationSec: 2, maxHeartbeatMs: 16, maxMemoryMb: 1500 }]);
    ctx.updateExtras({ syncMode: 'none' });
    sim.answer = stats({ heartbeatMs: 6.5, physicsStepMs: 2, memoryMb: 4212, instances: 900 });
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    const perf = report.results.find((r) => r.name === 'bots_perf')!;
    expect(perf.passed, perf.output).toBe(true);
    expect(perf.output).toMatch(/^Within budget — \{.*"memoryMb":4212/);
    expect(perf.output.split(MEMORY_NOT_JUDGED)).toHaveLength(2);
    expect(perf.output).toMatch(/\(maxMemoryMb 1500 ignored\)/);
    expect(report.passed).toBe(true);
  });

  it('heartbeat, physics and instance budgets still fail it, and a check without a memory budget says nothing about memory', async () => {
    const { core, ctx, sim, task } = await setup([{ kind: 'perf', name: 'bots_perf', durationSec: 2, maxHeartbeatMs: 16, maxPhysicsStepMs: 8, maxInstances: 500 }]);
    ctx.updateExtras({ syncMode: 'none' });
    sim.answer = stats({ heartbeatMs: 31.25, physicsStepMs: 12, memoryMb: 4212, instances: 900 });
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    const perf = report.results.find((r) => r.name === 'bots_perf')!;
    expect(perf.passed).toBe(false);
    expect(perf.output).toMatch(/^Over budget: heartbeat 31\.25 ms > 16; physics step 12\.00 ms > 8; instances 900 > 500 — /);
    expect(perf.output).not.toContain('memory ');
    expect(perf.output).not.toContain(MEMORY_NOT_JUDGED);
  });
});
