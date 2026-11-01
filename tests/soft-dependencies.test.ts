import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '../src/shared/domain';
import type { AgentRunRequest } from '../src/core/providers/types';
import { estimateRemaining } from '../src/core/director/eta';
import { dependencyWarnings, longestChain, strictWarnings, type PlanNode } from '../src/core/orchestrator/plan-checks';
import { dependencyMet } from '../src/core/tasks/task-graph';
import { coreHarness, planArgs, waitFor } from './helpers/make-core';

/**
 * Dependents start when the work exists (finding 3 of the first A–Z build): a task used to unlock its dependents
 * only at `done`, after verification and the critic, and 1,650 task-minutes were spent `ready`. Now a dependent
 * starts when its dependency is `implemented` (the agent finished, the result is on disk) while the checks and the
 * review of the dependency go on; a strict dependency (final test and QA tasks) still needs `done`.
 */
describe('when a dependency lets its dependents start (pure)', () => {
  const dep = (status: TaskStatus, landedAt: string | null = null) => ({ status, landedAt });
  const NOW = '2026-10-01T10:00:00.000Z';

  it('is met by work that exists, and strictly only by reviewed work', () => {
    for (const s of ['implemented', 'verifying', 'reviewing'] as const) {
      expect(dependencyMet(dep(s, NOW), false), s).toBe(true);
      expect(dependencyMet(dep(s, NOW), true), `${s} strict`).toBe(false);
    }
    for (const s of ['verified', 'done'] as const) {
      expect(dependencyMet(dep(s), false), s).toBe(true);
      expect(dependencyMet(dep(s), true), `${s} strict`).toBe(true);
    }
    // Not started yet, or working on its first version: nothing exists.
    for (const s of ['proposed', 'ready', 'running', 'failed', 'paused'] as const) expect(dependencyMet(dep(s), false), s).toBe(false);
    // Rejected and being reworked: the first version is still on disk, a dependent may start on it.
    for (const s of ['failed', 'ready', 'running', 'paused'] as const) {
      expect(dependencyMet(dep(s, NOW), false), `${s} after landing`).toBe(true);
      expect(dependencyMet(dep(s, NOW), true), `${s} after landing, strict`).toBe(false);
    }
    // A dependency that is gone or stuck never unlocks anything, whatever it once produced.
    for (const s of ['cancelled', 'escalated', 'blocked'] as const) expect(dependencyMet(dep(s, NOW), false), s).toBe(false);
    expect(dependencyMet(null, false)).toBe(false);
    expect(dependencyMet(undefined, true)).toBe(false);
  });
});

describe('plan checks and soft dependencies (pure)', () => {
  const node = (id: string, role: string, deps: string[] = [], extra: Partial<PlanNode> = {}): PlanNode => ({ id, ref: id, title: `Task ${id}`, role, status: 'ready', deps, ...extra });
  const graph = (...ns: PlanNode[]) => new Map(ns.map((n) => [n.id, n]));

  it('counts a dependency whose work exists as no waiting, unless it is strict', () => {
    const landed = { status: 'reviewing', landed: true };
    const g = graph(node('a', 'level-designer', [], landed), node('b', 'environment-artist', ['a']), node('c', 'roblox-engineer', ['b']), node('d', 'ui-engineer', ['c']), node('qa', 'qa-engineer', ['a'], { strict: ['a'] }));
    // a's work exists: the chain to d is b → c → d, not four deep.
    expect(longestChain('d', g).map((n) => n.id)).toEqual(['b', 'c', 'd']);
    expect(dependencyWarnings(g.get('d')!, g).filter((w) => w.code === 'deep-chain')).toEqual([]);
    // A strict dependency still waits for the review.
    expect(longestChain('qa', g).map((n) => n.id)).toEqual(['a', 'qa']);
    // An asset task behind code that has landed costs nothing.
    const assets = graph(node('code', 'roblox-engineer', [], landed), node('snd', 'sound-designer', ['code']));
    expect(dependencyWarnings(assets.get('snd')!, assets)).toEqual([]);
  });

  it('warns when a task that is not a final test or QA task marks a dependency strict', () => {
    const g = graph(node('core', 'roblox-engineer'), node('ui', 'ui-engineer', ['core'], { strict: ['core'] }), node('qa', 'qa-engineer', ['core'], { strict: ['core'] }), node('t', 'roblox-engineer', ['core'], { strict: ['core'], kind: 'test' }), node('soft', 'ui-engineer', ['core']));
    const w = strictWarnings(g.get('ui')!, g);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'strict-dependency', task: 'ui', dependency: 'core' });
    expect(w[0]!.message).toMatch(/waits for the checks and the review of "Task core"/);
    expect(w[0]!.message).toContain('plan_drop_dependency {task: "ui", dependsOn: "core", strictOnly: true}');
    // QA and test tasks are what strict is for; a plain dependency is not strict; finished work costs nothing.
    expect(strictWarnings(g.get('qa')!, g)).toEqual([]);
    expect(strictWarnings(g.get('t')!, g)).toEqual([]);
    expect(strictWarnings(g.get('soft')!, g)).toEqual([]);
    const done = graph(node('core', 'roblox-engineer', [], { status: 'done' }), node('ui', 'ui-engineer', ['core'], { strict: ['core'] }));
    expect(strictWarnings(done.get('ui')!, done)).toEqual([]);
  });
});

describe('the finish estimate and soft dependencies (pure)', () => {
  const NOW = Date.parse('2026-10-01T12:00:00.000Z');
  const task = (id: string, status: TaskStatus, dependencies: string[] = [], extra: Partial<Task> = {}): Task => ({
    id, parentId: 'obj', kind: 'implement', title: `Task ${id}`, objective: 'x', reason: '', role: 'roblox-engineer', status, priority: 50, acceptanceCriteria: [], verification: [], requiredSkills: [],
    requiredKnowledge: [], tools: [], files: [], robloxSystems: [], dependencies, attempts: 0, maxAttempts: 3, result: null, failureSummary: null, createdBy: 'test', createdAt: '2026-10-01T11:00:00.000Z',
    updatedAt: '2026-10-01T11:00:00.000Z', startedAt: null, completedAt: null, ...extra,
  });

  it('lets a dependent start when the work of its dependency exists, so a chain is shorter than the sum of its tasks', () => {
    // Three tasks in a row, none started: 25 min each by default.
    const soft = estimateRemaining([task('a', 'ready'), task('b', 'ready', ['a']), task('c', 'ready', ['b'])], NOW, 10)!;
    const strict = estimateRemaining([task('a', 'ready'), task('b', 'ready', ['a'], { strictDependencies: ['a'] }), task('c', 'ready', ['b'], { strictDependencies: ['b'] })], NOW, 10)!;
    // Strict: each waits for the whole of the one before (3 × 25). Soft: only for its work (the review overlaps).
    expect(strict.low).toBe(75);
    expect(soft.low).toBeLessThan(strict.low);
    expect(soft.low).toBeGreaterThanOrEqual(60);
    expect(soft.chain).toBe(3);
    // A dependency whose work has landed delays its dependents by nothing.
    const landed = estimateRemaining([task('a', 'reviewing', [], { startedAt: '2026-10-01T11:40:00.000Z', landedAt: '2026-10-01T11:55:00.000Z' }), task('b', 'ready', ['a'])], NOW, 10)!;
    expect(landed.low).toBe(25);
    expect(landed.chain).toBe(1);
  });
});

type Gate = { wait: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
/** Resolves when `g` opens; rejects (as an interrupted run) when the run is stopped first. */
const held = (req: AgentRunRequest, g: Gate) =>
  new Promise<void>((resolve, reject) => {
    req.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { errorKind: 'interrupted' })), { once: true });
    void g.wait.then(resolve);
  });

const PASS = { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
const FAIL = { verdict: 'fail', summary: 'The API is wrong', criteria: [{ criterion: 'works', met: false, evidence: 'no' }], defects: [{ severity: 'high', area: 'correctness', title: 'Wrong API', detail: 'd', fix: 'Rename it' }] };

const makeCore = coreHarness();

/** A core whose fake agents answer per task title: `script(title, kind, req, n)` (n: that task's nth run of that kind). */
async function harness(script: (title: string, kind: 'work' | 'review', req: AgentRunRequest, n: number, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>) {
  const counts = new Map<string, number>();
  let titleOf: (runId: string) => string = () => '';
  const made = await makeCore({
    respond: async (req, kind, call) => {
      if (kind !== 'work' && kind !== 'review') return null;
      const title = titleOf(req.runId);
      const key = `${title}:${kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return script(title, kind, req, counts.get(key)!, call);
    },
  });
  const { core, ctx } = made;
  titleOf = (runId) => {
    const row = ctx.store.get<{ task_id: string | null }>('SELECT task_id FROM runs WHERE id = ?', [runId]);
    return row?.task_id ? (ctx.tasks.get(row.task_id)?.title ?? '') : '';
  };
  // Questions and stuck tasks go to the user here (cards), so nothing is decided by a planner run.
  core.prefs.set({ permissionMode: 'ask' });
  ctx.updateSettings({ maxConcurrentAgents: 6 });
  core.orchestrator.pause();
  const goal = ctx.tasks.create({ kind: 'objective', title: 'Arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const mk = (title: string, role: string, dependencies: string[] = [], extra: { strict?: boolean; maxAttempts?: number } = {}) =>
    ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role, status: 'ready', dependencies, strictDependencies: extra.strict ? dependencies : [], maxAttempts: extra.maxAttempts, createdBy: 'test', verification: [{ kind: 'critic' }] });
  const status = (t: Task) => ctx.tasks.get(t.id)!.status;
  return { ...made, goal, mk, status };
}

describe('dependents start when the work exists', () => {
  it('starts a dependent while its dependency is still in review, and a strict one only when it is done', async () => {
    const review = gate();
    const xWork = gate();
    const h = await harness(async (title, kind) => {
      if (title === 'Mech core' && kind === 'work') return { status: 'implemented', summary: 'Mech core v1: Mech.spawn(player) in src/Server/Mech.luau' };
      if (title === 'Mech core' && kind === 'review') {
        await review.wait;
        return PASS;
      }
      if (title === 'Garage' && kind === 'work') {
        await xWork.wait;
        return { status: 'implemented', summary: 'Garage built' };
      }
      if (kind === 'work') return { status: 'implemented', summary: 'done' };
      return PASS;
    });
    const core = h.mk('Mech core', 'luau-engineer');
    const garage = h.mk('Garage', 'roblox-engineer', [core.id]);
    const qa = h.mk('Final QA', 'qa-engineer', [core.id], { strict: true });
    h.core.orchestrator.resume();

    // The garage starts while the mech core is under review: its work exists.
    await waitFor(() => h.status(garage) === 'running' && h.status(core) === 'reviewing', 30000);
    expect(h.ctx.tasks.get(core.id)!.landedAt).toBeTruthy();
    // The final QA needs reviewed work: it waits.
    expect(h.status(qa)).toBe('ready');
    expect(h.provider.runs.some((r) => r.role === 'qa-engineer')).toBe(false);
    // The garage's agent knows what the mech core produced, and that it is still being checked.
    const prompt = h.provider.runs.find((r) => r.role === 'roblox-engineer')!.prompt;
    expect(prompt).toContain('Mech core v1: Mech.spawn(player) in src/Server/Mech.luau');
    expect(prompt).toMatch(/Prerequisites still being checked: "Mech core"/);
    expect(prompt).toMatch(/build on it as it is[^.]*don't wait for (its|their) review/);

    review.open();
    await waitFor(() => h.status(core) === 'done', 30000);
    // Reviewed: now the QA task starts, while the garage is still at work.
    await waitFor(() => h.provider.runs.some((r) => r.role === 'qa-engineer'), 30000);
    expect(h.status(garage)).toBe('running');
    xWork.open();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    expect([core, garage, qa].map(h.status)).toEqual(['done', 'done', 'done']);
  }, 120000);

  it('keeps a running dependent going when its dependency is rejected, and tells it what changed when the rework lands', async () => {
    const review = gate();
    const rework = gate();
    const xWork = gate();
    const yWork = gate();
    let toolResult = '';
    const h = await harness(async (title, kind, _req, n, call) => {
      if (title === 'Mech core' && kind === 'work') {
        if (n === 1) return { status: 'implemented', summary: 'Mech core v1' };
        await rework.wait;
        return { status: 'implemented', summary: 'Mech core v2: Mech.spawn is now Mech.deploy(player, loadout)' };
      }
      if (title === 'Mech core' && kind === 'review') {
        if (n === 1) {
          await review.wait;
          return FAIL;
        }
        return PASS;
      }
      if (title === 'Garage' && kind === 'work') {
        await xWork.wait;
        // The agent's next tool call after the rework landed carries the note.
        const res = (await call('task_list', {})) as { content: Array<{ text?: string }> };
        toolResult = res.content.map((c) => c.text ?? '').join('\n');
        return { status: 'implemented', summary: 'Garage built' };
      }
      if (title === 'Match loop' && kind === 'work') {
        await yWork.wait;
        return { status: 'implemented', summary: 'Loop built' };
      }
      return kind === 'work' ? { status: 'implemented', summary: 'done' } : PASS;
    });
    const core = h.mk('Mech core', 'luau-engineer');
    const garage = h.mk('Garage', 'roblox-engineer', [core.id]);
    h.core.orchestrator.resume();
    await waitFor(() => h.status(garage) === 'running' && h.status(core) === 'reviewing', 30000);

    // The critic rejects the mech core: it goes back to its agent; the garage's agent keeps working.
    review.open();
    await waitFor(() => h.status(core) === 'running' && h.ctx.tasks.get(core.id)!.attempts === 2, 30000);
    expect(h.status(garage)).toBe('running');
    expect(h.provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(1);
    // A dependent that had not started yet starts on the version that exists, during the rework.
    const loop = h.mk('Match loop', 'ui-engineer', [core.id]);
    h.core.orchestrator.kick();
    await waitFor(() => h.status(loop) === 'running', 30000);
    expect(h.status(core)).toBe('running');
    expect(h.provider.runs.find((r) => r.role === 'ui-engineer')!.prompt).toMatch(/Prerequisites still being checked: "Mech core"/);

    // The rework lands: both running dependents get a note about what changed.
    rework.open();
    await waitFor(() => h.status(core) === 'done', 30000);
    const notes = (t: Task) => h.ctx.tasks.evidence(t.id).filter((e) => e.kind === 'note' && e.title.startsWith('Prerequisite reworked'));
    expect(notes(garage)).toHaveLength(1);
    expect(notes(garage)[0]!.title).toBe('Prerequisite reworked: "Mech core"');
    expect(JSON.stringify(notes(garage)[0]!.data)).toContain('Mech.deploy(player, loadout)');
    expect(notes(loop)).toHaveLength(1);
    expect([h.status(garage), h.status(loop)]).toEqual(['running', 'running']);

    xWork.open();
    yWork.open();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    // The garage's agent read the note in its next tool result: what was rejected and what changed.
    expect(toolResult).toMatch(/Note from Shuriken: the prerequisite task "Mech core" was reworked while you worked/);
    expect(toolResult).toContain('Mech core v2: Mech.spawn is now Mech.deploy(player, loadout)');
    expect(toolResult).toContain('The API is wrong');
    // The garage ran once: it was never restarted for the rework.
    expect(h.provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(1);
    // The match loop's agent called no tool after the rework: its reviewer is told instead.
    const loopReview = h.provider.runs.filter((r) => r.role === 'critic').map((r) => r.prompt).find((p) => p.includes('Loop built'))!;
    expect(loopReview).toMatch(/Prerequisite "Mech core" was reworked while this task ran/);
  }, 120000);

  it('lets a running dependent finish when its dependency is cancelled, and blocks the ones that had not started', async () => {
    const review = gate();
    const xWork = gate();
    const h = await harness(async (title, kind, req) => {
      if (title === 'Mech core' && kind === 'review') {
        await held(req, review);
        return PASS;
      }
      if (title === 'Garage' && kind === 'work') {
        await xWork.wait;
        return { status: 'implemented', summary: 'Garage built' };
      }
      return kind === 'work' ? { status: 'implemented', summary: 'done' } : PASS;
    });
    const core = h.mk('Mech core', 'luau-engineer');
    const garage = h.mk('Garage', 'roblox-engineer', [core.id]);
    const qa = h.mk('Final QA', 'qa-engineer', [core.id], { strict: true });
    h.core.orchestrator.resume();
    await waitFor(() => h.status(garage) === 'running' && h.status(core) === 'reviewing', 30000);

    h.core.orchestrator.cancel(core.id, 'Dropped by the user');
    await waitFor(() => h.status(qa) === 'blocked', 30000);
    expect(h.status(core)).toBe('cancelled');
    expect(h.ctx.tasks.get(core.id)!.landedAt).toBeNull();
    // The garage's agent is not stopped: it finishes, is checked and reviewed.
    expect(h.status(garage)).toBe('running');
    xWork.open();
    await waitFor(() => h.status(garage) === 'done', 30000);
    // A task added now that waits for the cancelled one can never start either.
    const late = h.mk('Shop', 'ui-engineer', [core.id]);
    h.core.orchestrator.kick();
    await waitFor(() => h.status(late) === 'blocked', 30000);
    expect(h.provider.runs.some((r) => r.role === 'qa-engineer' || r.role === 'ui-engineer')).toBe(false);
    // The objective stays open (blocked tasks are the user's to settle).
    expect(h.ctx.tasks.get(h.goal.id)!.status).toBe('running');
  }, 120000);

  it('a dependency that fails all its attempts stops unlocking: running dependents finish, new ones wait for the retry', async () => {
    const review = gate();
    const xWork = gate();
    const h = await harness(async (title, kind, _req, n) => {
      if (title === 'Mech core' && kind === 'review') {
        if (n === 1) {
          await review.wait;
          return FAIL;
        }
        return PASS;
      }
      if (title === 'Garage' && kind === 'work') {
        await xWork.wait;
        return { status: 'implemented', summary: 'Garage built' };
      }
      return kind === 'work' ? { status: 'implemented', summary: 'done' } : PASS;
    });
    const core = h.mk('Mech core', 'luau-engineer', [], { maxAttempts: 1 });
    const garage = h.mk('Garage', 'roblox-engineer', [core.id]);
    h.core.orchestrator.resume();
    await waitFor(() => h.status(garage) === 'running' && h.status(core) === 'reviewing', 30000);

    // Its only attempt is rejected: the user is asked, and its work no longer counts as existing.
    review.open();
    await waitFor(() => h.status(core) === 'escalated', 30000);
    expect(h.ctx.tasks.get(core.id)!.landedAt).toBeNull();
    expect(h.status(garage)).toBe('running');
    // A dependent that had not started is blocked, not started on work that failed for good.
    const shop = h.mk('Shop', 'ui-engineer', [core.id]);
    h.core.orchestrator.kick();
    await waitFor(() => h.status(shop) === 'blocked', 30000);
    // The running dependent finishes on its own.
    xWork.open();
    await waitFor(() => h.status(garage) === 'done', 30000);
    expect(h.ctx.tasks.get(h.goal.id)!.status).toBe('running');

    // The user retries the dependency: the blocked dependent is free again and starts when the new work exists.
    h.core.orchestrator.retry(core.id);
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    expect([core, garage, shop].map(h.status)).toEqual(['done', 'done', 'done']);
    const shopStart = Date.parse(h.ctx.tasks.get(shop.id)!.startedAt!);
    expect(shopStart).toBeGreaterThanOrEqual(Date.parse(h.ctx.tasks.get(core.id)!.landedAt!));
  }, 120000);

  it('honours pause and stop during the overlap: nothing starts while paused, and after a stop the dependent starts again without waiting for the review', async () => {
    const coreWork = gate();
    const review = gate();
    const xWork = gate();
    const h = await harness(async (title, kind, req) => {
      if (title === 'Mech core' && kind === 'work') {
        await held(req, coreWork);
        return { status: 'implemented', summary: 'Mech core v1' };
      }
      if (title === 'Mech core' && kind === 'review') {
        await held(req, review);
        return PASS;
      }
      if (title === 'Garage' && kind === 'work') {
        await held(req, xWork);
        return { status: 'implemented', summary: 'Garage built' };
      }
      return kind === 'work' ? { status: 'implemented', summary: 'done' } : PASS;
    });
    const core = h.mk('Mech core', 'luau-engineer');
    const garage = h.mk('Garage', 'roblox-engineer', [core.id]);
    h.core.orchestrator.resume();
    await waitFor(() => h.status(core) === 'running', 30000);

    // Paused while the dependency is still at work: it finishes and goes to review, the dependent does not start.
    h.core.orchestrator.pause();
    coreWork.open();
    await waitFor(() => h.status(core) === 'reviewing', 30000);
    await new Promise((r) => setTimeout(r, 400));
    h.core.orchestrator.kick();
    await new Promise((r) => setTimeout(r, 400));
    expect(h.status(garage)).toBe('ready');
    expect(h.provider.runs.some((r) => r.role === 'roblox-engineer')).toBe(false);

    // Resumed: the dependent starts at once, during the review.
    h.core.orchestrator.resume();
    await waitFor(() => h.status(garage) === 'running', 30000);
    expect(h.status(core)).toBe('reviewing');

    // Stopped during the overlap: both agents are interrupted and both tasks wait.
    await h.core.orchestrator.stop();
    await waitFor(() => h.status(core) === 'ready' && h.status(garage) === 'ready', 30000);
    expect(h.ctx.tasks.get(core.id)!.landedAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(1);

    // Resumed: the dependency goes back to its checks (its work is not redone) and the dependent starts again
    // while that review is still open.
    h.core.orchestrator.resume();
    await waitFor(() => h.status(garage) === 'running' && h.status(core) === 'reviewing', 30000);
    expect(h.provider.runs.filter((r) => r.role === 'luau-engineer')).toHaveLength(1);
    review.open();
    xWork.open();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    expect([core, garage].map(h.status)).toEqual(['done', 'done']);
  }, 120000);
});

describe('the planner marks a dependency strict', () => {
  async function planning() {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const plan = ctx.tasks.create({ parentId: goal.id, kind: 'plan', title: 'Plan: Arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const planner = { kind: 'agent' as const, runId: 'run_plan', taskId: plan.id, role: 'executive', providerId: null, allowedTools: null };
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await core.tools.invoke(tool, args, planner);
      const text = r.content.map((c) => ('text' in c ? c.text : '') ?? '').join('');
      return { error: !!r.isError, text, json: r.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
    };
    return { core, ctx, goal, call };
  }

  it('with strictDependsOn on plan_add_task; the task then waits for the review, and says so', async () => {
    const { ctx, goal, call } = await planning();
    await call('plan_add_task', planArgs('core', 'roblox-engineer', [], 'Mech core'));
    const coreTask = ctx.tasks.byPlanKey(goal.id, 'core')!;
    const qa = await call('plan_add_task', { ...planArgs('qa', 'qa-engineer', ['core'], 'Final QA'), strictDependsOn: ['core'] });
    expect(qa.error, qa.text).toBe(false);
    expect(qa.json).toMatchObject({ starts: 'after: Mech core (reviewed)' });
    expect(qa.json).not.toHaveProperty('WARNING');
    expect(ctx.tasks.byPlanKey(goal.id, 'qa')!.strictDependencies).toEqual([coreTask.id]);
    const garage = await call('plan_add_task', planArgs('garage', 'ui-engineer', ['core'], 'Garage'));
    expect(garage.json).toMatchObject({ starts: 'after: Mech core' });
    expect(ctx.tasks.byPlanKey(goal.id, 'garage')!.strictDependencies ?? []).toEqual([]);
    // A strict key that is not a dependency is a mistake.
    expect((await call('plan_add_task', { ...planArgs('x', 'qa-engineer', ['core']), strictDependsOn: ['garage'] })).text).toMatch(/strictDependsOn "garage" is not in dependsOn/);

    // Once the work exists, the plain dependent can start; the strict one still waits.
    ctx.tasks.setStatus(coreTask.id, 'running');
    ctx.tasks.setStatus(coreTask.id, 'implemented');
    expect(ctx.tasks.runnable().map((t) => t.title)).toEqual(['Garage']);
    expect((await call('plan_add_task', planArgs('shop', 'ui-engineer', ['core'], 'Shop'))).json).toMatchObject({ starts: 'now' });
    expect((await call('plan_add_task', { ...planArgs('qa2', 'qa-engineer', ['core'], 'Perf QA'), strictDependsOn: ['core'] })).json).toMatchObject({ starts: 'after: Mech core (reviewed)' });
  });

  it('warns about a strict dependency on a task that is not a final test or QA task, and strictOnly drops just the strictness', async () => {
    const { ctx, goal, call } = await planning();
    await call('plan_add_task', planArgs('core', 'roblox-engineer', [], 'Mech core'));
    const ui = await call('plan_add_task', { ...planArgs('ui', 'ui-engineer', ['core'], 'Garage'), strictDependsOn: ['core'] });
    expect(String(ui.json!.WARNING)).toMatch(/waits for the checks and the review of "Mech core"/);
    const drop = await call('plan_drop_dependency', { task: 'ui', dependsOn: 'core', strictOnly: true });
    expect(drop.error, drop.text).toBe(false);
    const t = ctx.tasks.byPlanKey(goal.id, 'ui')!;
    expect(t.dependencies).toEqual([ctx.tasks.byPlanKey(goal.id, 'core')!.id]);
    expect(t.strictDependencies ?? []).toEqual([]);
  });

  it('keeps a dependency strict when the task it waits for is replaced', async () => {
    const { ctx, goal, call } = await planning();
    await call('plan_add_task', planArgs('core', 'roblox-engineer', [], 'Mech core'));
    await call('plan_add_task', { ...planArgs('qa', 'qa-engineer', ['core'], 'Final QA'), strictDependsOn: ['core'] });
    await call('plan_add_task', planArgs('garage', 'ui-engineer', ['core'], 'Garage'));
    await call('plan_add_task', planArgs('core2', 'roblox-engineer', [], 'Mech core, redone'));
    const r = await call('plan_cancel_task', { task: 'core', reason: 'The user wants it redone', replaced_by: 'core2' });
    expect(r.error, r.text).toBe(false);
    const next = ctx.tasks.byPlanKey(goal.id, 'core2')!.id;
    expect(ctx.tasks.byPlanKey(goal.id, 'qa')).toMatchObject({ dependencies: [next], strictDependencies: [next] });
    expect(ctx.tasks.byPlanKey(goal.id, 'garage')!.dependencies).toEqual([next]);
    expect(ctx.tasks.byPlanKey(goal.id, 'garage')!.strictDependencies ?? []).toEqual([]);
  });

  it('through the batch path too (strictDependsOn in a plan result)', async () => {
    const { core, ctx, goal } = await planning();
    const spec = (key: string, role: string, dependsOn: string[] = [], strictDependsOn?: string[]) => ({ key, title: `Task ${key}`, kind: 'implement' as const, role, objective: 'Do the piece.', acceptanceCriteria: ['Done'], verification: [], dependsOn, strictDependsOn });
    const added = core.orchestrator.addTasks(ctx, goal.id, [spec('a', 'roblox-engineer'), spec('b', 'ui-engineer', ['a']), spec('q', 'qa-engineer', ['a', 'b'], ['a', 'b'])], 'executive');
    expect(Array.isArray(added)).toBe(true);
    const id = (k: string) => ctx.tasks.byPlanKey(goal.id, k)!.id;
    expect(ctx.tasks.byPlanKey(goal.id, 'q')!.strictDependencies!.sort()).toEqual([id('a'), id('b')].sort());
    expect(ctx.tasks.byPlanKey(goal.id, 'b')!.strictDependencies ?? []).toEqual([]);
  });
});
