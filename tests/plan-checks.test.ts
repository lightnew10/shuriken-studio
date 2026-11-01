import { describe, expect, it } from 'vitest';
import { ROLES, hiddenToolsFor, WORKSHOP_TOOLS } from '../src/core/agents/roles';
import { ASSET_ROLES, CODE_ROLES, MAX_CHAIN_DEPTH, dependencyWarnings, longestChain, planNodes, planWarnings, type PlanNode } from '../src/core/orchestrator/plan-checks';
import type { PlanTaskSpec } from '../src/core/agents/roles';
import { coreHarness, planArgs } from './helpers/make-core';

const node = (id: string, role: string, deps: string[] = [], status = 'ready'): PlanNode => ({ id, ref: id, title: `Task ${id}`, role, status, deps });
const graph = (...ns: PlanNode[]) => new Map(ns.map((n) => [n.id, n]));
const warn = (id: string, ...ns: PlanNode[]) => {
  const g = graph(...ns);
  return dependencyWarnings(g.get(id)!, g);
};

describe('dependency warnings (pure)', () => {
  it('measures the chain of unfinished tasks that ends at a task', () => {
    const g = graph(node('a', 'level-designer'), node('b', 'roblox-engineer', ['a']), node('c', 'roblox-engineer', ['b']), node('d', 'qa-engineer', ['c']), node('side', 'modeler'));
    expect(longestChain('d', g).map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(longestChain('side', g).map((n) => n.id)).toEqual(['side']);
    // Finished work costs no waiting and ends a chain; so does a dependency that doesn't exist.
    const done = graph(node('a', 'x', [], 'done'), node('b', 'x', ['a'], 'verified'), node('c', 'x', ['b', 'ghost', 'z']), node('z', 'x', [], 'cancelled'));
    expect(longestChain('c', done).map((n) => n.id)).toEqual(['c']);
    // A cycle (rejected where tasks are made) never loops here.
    const cycle = graph(node('a', 'x', ['b']), node('b', 'x', ['a']));
    expect(longestChain('a', cycle).length).toBeLessThanOrEqual(2);
  });

  it(`warns when a chain is deeper than ${MAX_CHAIN_DEPTH} and says which dependency to question`, () => {
    const a = node('a', 'level-designer');
    const b = node('b', 'environment-artist', ['a']);
    const c = node('c', 'roblox-engineer', ['b']);
    expect(warn('c', a, b, c)).toEqual([]); // three deep is fine
    const d = node('d', 'qa-engineer', ['c']);
    const w = warn('d', a, b, c, d);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'deep-chain', task: 'd', dependency: 'c' });
    expect(w[0]!.message).toMatch(/waits behind a chain of 4 tasks \(Task a → Task b → Task c → Task d\)/);
    expect(w[0]!.message).toContain('plan_drop_dependency {task: "d", dependsOn: "c"}');
    // The deepest of several dependencies is the one named.
    const shallow = node('s', 'modeler');
    const e = node('e', 'luau-engineer', ['s', 'c']);
    expect(warn('e', a, b, c, shallow, e)[0]).toMatchObject({ code: 'deep-chain', dependency: 'c' });
    // Wide plans and finished upstream work don't warn.
    expect(warn('x6', ...['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((k) => node(k, 'roblox-engineer')))).toEqual([]);
    const finished = [node('a', 'x', [], 'done'), node('b', 'x', ['a'], 'done'), node('c', 'x', ['b'], 'done'), node('d', 'x', ['c'], 'verified')];
    expect(warn('e', ...finished, node('e', 'qa-engineer', ['d']))).toEqual([]);
  });

  it('warns when an asset task (sounds, effects, clips, UI) waits for gameplay code', () => {
    for (const asset of ASSET_ROLES) {
      for (const code of CODE_ROLES) {
        const w = warn('t', node('c', code), node('t', asset, ['c']));
        expect(w, `${asset} after ${code}`).toHaveLength(1);
        expect(w[0]).toMatchObject({ code: 'asset-after-code', task: 't', dependency: 'c' });
        expect(w[0]!.message).toMatch(/created independently of code/);
        expect(w[0]!.message).toContain('plan_drop_dependency {task: "t", dependsOn: "c"}');
        expect(w[0]!.message).toContain('"wire it in" task');
      }
    }
    expect([...ASSET_ROLES].sort()).toEqual(['animator', 'sound-designer', 'ui-engineer', 'vfx-artist']);
    expect([...CODE_ROLES].sort()).toEqual(['luau-engineer', 'roblox-engineer']);
    // Waiting for the rig it animates, for a layout, or for code that is already finished is fine; so is
    // code waiting for assets.
    expect(warn('t', node('m', 'modeler'), node('t', 'animator', ['m']))).toEqual([]);
    expect(warn('t', node('l', 'level-designer'), node('t', 'sound-designer', ['l']))).toEqual([]);
    expect(warn('t', node('c', 'roblox-engineer', [], 'done'), node('t', 'sound-designer', ['c']))).toEqual([]);
    expect(warn('t', node('s', 'sound-designer'), node('t', 'roblox-engineer', ['s']))).toEqual([]);
  });

  it('warns when a QA task waits for another QA task, and only then', () => {
    const w = warn('q2', node('q1', 'qa-engineer'), node('q2', 'qa-engineer', ['q1']));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'qa-after-qa', task: 'q2', dependency: 'q1' });
    expect(w[0]!.message).toMatch(/never queue behind each other/);
    expect(warn('q', node('c', 'roblox-engineer'), node('q', 'qa-engineer', ['c']))).toEqual([]);
    expect(warn('e', node('q', 'qa-engineer'), node('e', 'environment-artist', ['q']))).toEqual([]);
    expect(warn('q2', node('q1', 'qa-engineer', [], 'done'), node('q2', 'qa-engineer', ['q1']))).toEqual([]);
  });

  it('collects the warnings of a whole batch (each task once per problem)', () => {
    const batch = [node('ai', 'roblox-engineer'), node('snd', 'sound-designer', ['ai']), node('qa1', 'qa-engineer'), node('qa2', 'qa-engineer', ['qa1']), node('ok', 'modeler')];
    expect(planWarnings(batch).map((w) => `${w.task}:${w.code}`)).toEqual(['snd:asset-after-code', 'qa2:qa-after-qa']);
    expect(planWarnings([])).toEqual([]);
  });

  it('builds nodes from tasks, naming the ones the planner knows by key', () => {
    const tasks = [
      { id: 'task_1', title: 'AI', role: 'roblox-engineer', status: 'ready' as const, dependencies: [] },
      { id: 'task_2', title: 'Sounds', role: 'sound-designer', status: 'ready' as const, dependencies: ['task_1'] },
    ];
    const g = planNodes(tasks, new Map([['task_1', 'ai'], ['task_2', 'sounds']]));
    expect(dependencyWarnings(g.get('task_2')!, g)[0]!.message).toContain('plan_drop_dependency {task: "sounds", dependsOn: "ai"}');
    // Without keys the ids stand in.
    const plain = planNodes(tasks);
    expect(dependencyWarnings(plain.get('task_2')!, plain)[0]!.message).toContain('{task: "task_2", dependsOn: "task_1"}');
  });
});

const makeCore = coreHarness();

async function planning() {
  const { core, ctx } = await makeCore({ respond: async () => null });
  core.orchestrator.pause();
  const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const plan = ctx.tasks.create({ parentId: goal.id, kind: 'plan', title: 'Plan: Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const planner = { kind: 'agent' as const, runId: 'run_plan', taskId: plan.id, role: 'executive', providerId: null, allowedTools: null };
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await core.tools.invoke(tool, args, planner);
    const text = r.content.map((c) => ('text' in c ? c.text : '') ?? '').join('');
    return { error: !!r.isError, text, json: r.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { core, ctx, goal, plan, call };
}

describe('plan_add_task and plan_drop_dependency', () => {
  it('adds a task whose dependency only adds waiting with a WARNING, not a failure, and the planner can drop it', async () => {
    const { ctx, goal, call } = await planning();
    const ai = await call('plan_add_task', planArgs('ai', 'roblox-engineer', [], 'Griever AI'));
    expect(ai.error).toBe(false);
    expect(ai.json).toMatchObject({ key: 'ai', starts: 'now' });
    expect(ai.json).not.toHaveProperty('WARNING');
    // Sounds are assets: they never need the AI code first.
    const sounds = await call('plan_add_task', planArgs('sounds', 'sound-designer', ['ai'], 'Griever sounds'));
    expect(sounds.error).toBe(false);
    expect(sounds.json).toMatchObject({ key: 'sounds', starts: 'after: Griever AI' });
    expect(String(sounds.json!.WARNING)).toMatch(/was added, but its dependencies only add waiting/);
    expect(String(sounds.json!.WARNING)).toMatch(/sounds are created independently of code/);
    expect(String(sounds.json!.WARNING)).toContain('plan_drop_dependency {task: "sounds", dependsOn: "ai"}');
    const task = ctx.tasks.byPlanKey(goal.id, 'sounds')!;
    expect(task.dependencies).toEqual([ctx.tasks.byPlanKey(goal.id, 'ai')!.id]);
    // The suggested call removes it, and the task can start at once.
    const drop = await call('plan_drop_dependency', { task: 'sounds', dependsOn: 'ai' });
    expect(drop.error, drop.text).toBe(false);
    expect(drop.json).toMatchObject({ title: 'Griever sounds', dropped: 'Griever AI', starts: 'now' });
    expect(ctx.tasks.get(task.id)!.dependencies).toEqual([]);
    expect((await call('plan_drop_dependency', { task: 'sounds', dependsOn: 'ai' })).text).toMatch(/does not wait for/);
  });

  it('warns about a chain deeper than 3 and about QA behind QA, but not about justified waits', async () => {
    const { call } = await planning();
    for (const [key, deps] of [['lay', []], ['art', ['lay']], ['sys', ['art']]] as const) expect((await call('plan_add_task', planArgs(key, 'level-designer', [...deps]))).json).not.toHaveProperty('WARNING');
    const deep = await call('plan_add_task', planArgs('polish', 'environment-artist', ['sys']));
    expect(deep.error).toBe(false);
    expect(String(deep.json!.WARNING)).toMatch(/chain of 4 tasks/);
    expect(String(deep.json!.WARNING)).toContain('dependsOn: "sys"');
    // Code waiting for the model it needs, and assets waiting for a rig, are plain dependencies.
    await call('plan_add_task', planArgs('rig', 'modeler'));
    expect((await call('plan_add_task', planArgs('clips', 'animator', ['rig']))).json).not.toHaveProperty('WARNING');
    expect((await call('plan_add_task', planArgs('chase', 'roblox-engineer', ['rig']))).json).not.toHaveProperty('WARNING');
    // QA behind QA.
    await call('plan_add_task', planArgs('qa1', 'qa-engineer'));
    const qa2 = await call('plan_add_task', planArgs('qa2', 'qa-engineer', ['qa1']));
    expect(String(qa2.json!.WARNING)).toMatch(/QA and playtest tasks never queue behind each other/);
    expect((await call('plan_add_task', planArgs('qa3', 'qa-engineer', ['chase']))).json).not.toHaveProperty('WARNING');
  });

  it('does not warn about work that is already finished', async () => {
    const { ctx, goal, call } = await planning();
    const done = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Finished AI', objective: 'x', role: 'roblox-engineer', status: 'done', createdBy: 'test' });
    const r = await call('plan_add_task', planArgs('snd', 'sound-designer', [done.id]));
    expect(r.error).toBe(false);
    expect(r.json).toMatchObject({ starts: 'now' });
    expect(r.json).not.toHaveProperty('WARNING');
  });

  it('rejects a dependency on a cancelled task, and only a task that has not started can lose a dependency', async () => {
    const { core, ctx, goal, call } = await planning();
    const old = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Old model', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test', planKey: 'old' });
    core.orchestrator.cancel(old.id);
    const r = await call('plan_add_task', planArgs('anim', 'animator', ['old']));
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/"old" was cancelled/);
    expect(ctx.tasks.byPlanKey(goal.id, 'anim')).toBeNull();
    // A running task keeps its dependencies.
    const dep = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Dep', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test', planKey: 'dep' });
    const run = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Busy', objective: 'x', role: 'luau-engineer', status: 'running', createdBy: 'test', planKey: 'busy', dependencies: [dep.id] });
    expect((await call('plan_drop_dependency', { task: 'busy', dependsOn: 'dep' })).text).toMatch(/is running: only a task that has not started/);
    expect(ctx.tasks.get(run.id)!.dependencies).toEqual([dep.id]);
    expect((await call('plan_drop_dependency', { task: 'nope', dependsOn: 'dep' })).text).toMatch(/No task "nope"/);
  });

  it('frees a task that was blocked only by the dependency it drops', async () => {
    const { core, ctx, goal, call } = await planning();
    const gone = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Gone', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test', planKey: 'gone' });
    const t = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Waits', objective: 'x', role: 'animator', status: 'ready', createdBy: 'test', planKey: 'waits', dependencies: [gone.id] });
    core.orchestrator.cancel(gone.id);
    ctx.tasks.setStatus(t.id, 'blocked', 'A dependency was cancelled');
    const r = await call('plan_drop_dependency', { task: 'waits', dependsOn: 'gone' });
    expect(r.json).toMatchObject({ starts: 'now' });
    expect(ctx.tasks.get(t.id)!.status).toBe('ready');
  });

  it('shows plan_drop_dependency to the planner only', () => {
    expect(ROLES.executive!.appTools).toContain('plan_drop_dependency');
    expect(WORKSHOP_TOOLS.planning).toContain('plan_drop_dependency');
    expect(hiddenToolsFor(ROLES['level-designer']!)?.has('plan_drop_dependency')).toBe(true);
    expect(hiddenToolsFor(ROLES.modeler!)?.has('plan_drop_dependency')).toBe(true);
  });
});

describe('the batch path (the planner’s structured result, the director’s iterations)', () => {
  const spec = (key: string, role: string, dependsOn: string[] = []): PlanTaskSpec => ({ key, title: `Task ${key}`, kind: 'implement', role, objective: 'Do the piece.', acceptanceCriteria: ['Done'], verification: [], dependsOn });

  it('refuses a plan whose probe runs on the wrong side, as plan_add_task does', async () => {
    const { core, ctx, goal } = await planning();
    const clientProbe = 'local lp = game:GetService("Players").LocalPlayer\nreturn lp and "PASS" or "FAIL"';
    const bad = { ...spec('move', 'roblox-engineer'), verification: [{ kind: 'playtest', name: 'moves', durationSec: 10, luau: clientProbe }] } as PlanTaskSpec;
    const r = core.orchestrator.addTasks(ctx, goal.id, [spec('ok', 'modeler'), bad], 'executive');
    expect(typeof r).toBe('string');
    expect(r).toMatch(/^task "move": Check "moves" was not registered/);
    expect(ctx.tasks.list().some((t) => t.title === 'Task ok')).toBe(false);
    // The same probe registered for the client is fine.
    const good = { ...spec('move2', 'roblox-engineer'), verification: [{ kind: 'luau_assert', name: 'moves', luau: clientProbe, datamodel: 'client' }] } as PlanTaskSpec;
    expect(Array.isArray(core.orchestrator.addTasks(ctx, goal.id, [good], 'executive'))).toBe(true);
  });

  it('records dependency warnings on the timeline and still adds the tasks', async () => {
    const { core, ctx, goal } = await planning();
    const added = core.orchestrator.addTasks(ctx, goal.id, [spec('ai', 'roblox-engineer'), spec('snd', 'sound-designer', ['ai']), spec('ok', 'modeler')], 'executive');
    expect(Array.isArray(added) && added.map((t) => t.title)).toEqual(['Task ai', 'Task snd', 'Task ok']);
    const ev = ctx.audit.timeline({ limit: 50 }).find((e) => e.kind === 'plan.warning');
    expect(ev?.severity).toBe('warning');
    expect(ev?.title).toMatch(/1 dependency warning \(asset-after-code\)/);
    expect((ev?.detail as { warnings: string[] }).warnings[0]).toMatch(/created independently of code/);
    // A clean batch records nothing.
    const before = ctx.audit.timeline({ limit: 200 }).filter((e) => e.kind === 'plan.warning').length;
    expect(Array.isArray(core.orchestrator.addTasks(ctx, goal.id, [spec('m2', 'modeler'), spec('c2', 'animator', ['m2'])], 'executive'))).toBe(true);
    expect(ctx.audit.timeline({ limit: 200 }).filter((e) => e.kind === 'plan.warning').length).toBe(before);
  });

  it('rejects a dependency on a cancelled task', async () => {
    const { core, ctx, goal } = await planning();
    const old = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Old', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test', planKey: 'old' });
    core.orchestrator.cancel(old.id);
    const before = ctx.tasks.list({ parentId: goal.id }).length;
    const r = core.orchestrator.addTasks(ctx, goal.id, [spec('a', 'animator', ['old'])], 'executive');
    expect(r).toMatch(/depends on "old", which was cancelled/);
    expect(ctx.tasks.list({ parentId: goal.id }).length).toBe(before);
  });
});
