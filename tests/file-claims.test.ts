import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, WORKSHOP_TOOLS, hiddenToolsFor } from '../src/core/agents/roles';
import { claimKey, claimsOf, inFolder, isFolderClaim, sharedFiles, sharedFolders } from '../src/core/orchestrator/file-claims';
import { claimWarnings, type PlanNode } from '../src/core/orchestrator/plan-checks';
import { coreHarness, planArgs, waitFor } from './helpers/make-core';

/**
 * File claims (finding 2 of the first A–Z build): "Wire sounds", "Wire effects" and "Security pass" each listed the
 * folder src/Server/Combat and ran one after another for 100 minutes although they touched different files. Only the
 * same FILE keeps two tasks apart now; a folder is shared, and each agent is told whose files are whose.
 */
describe('file claims (pure)', () => {
  it('tells a folder from a file', () => {
    for (const f of ['src/Server/Combat', 'src/Server/Combat/', 'src\\Client\\UI', 'src', 'world/*.luau', 'src/Server/**']) expect(isFolderClaim(f), f).toBe(true);
    for (const f of ['src/Server/Combat.server.luau', 'src/Shared/Events.luau', 'world/world.json', 'src/Server/Combat/init.luau', 'README.md']) expect(isFolderClaim(f), f).toBe(false);
    // What is a directory on disk is a folder whatever its name looks like.
    expect(isFolderClaim('assets/v1.2', (rel) => rel === 'assets/v1.2')).toBe(true);
    expect(isFolderClaim('', () => true)).toBe(false);
  });

  it('compares claims without regard to slashes, case or a trailing slash', () => {
    expect(claimKey('.\\src\\Server\\Combat\\')).toBe('src/server/combat');
    const a = claimsOf(['src/Server/Combat', 'src/Server/Combat/Sounds.luau', 'SRC\\Shared\\Events.luau', 'world/*.luau']);
    expect([...a.files].sort()).toEqual(['src/server/combat/sounds.luau', 'src/shared/events.luau']);
    expect(a.folders).toEqual(['src/server/combat', 'world']);
    expect(inFolder('src/server/combat/sounds.luau', 'src/server/combat')).toBe(true);
    expect(inFolder('src/server/combatx/a.luau', 'src/server/combat')).toBe(false);
  });

  it('keeps two tasks apart only for the same file', () => {
    const sounds = claimsOf(['src/Server/Combat', 'src/Server/Combat/Sounds.luau']);
    const effects = claimsOf(['src/Server/Combat', 'src/Server/Combat/Effects.luau']);
    const security = claimsOf(['src/Server/Combat/', 'src/Client/Combat']);
    // The three tasks of the run: one folder, different files.
    expect(sharedFiles(sounds, effects)).toEqual([]);
    expect(sharedFiles(sounds, security)).toEqual([]);
    expect(sharedFolders(sounds, effects)).toEqual(['src/server/combat']);
    // A folder never excludes a file in it, either way round.
    expect(sharedFiles(claimsOf(['src/Server/Combat']), claimsOf(['src/Server/Combat/Hit.luau']))).toEqual([]);
    // The same file does, however it is written.
    expect(sharedFiles(claimsOf(['src/Shared/Events.luau']), claimsOf(['src\\shared\\events.luau', 'x.luau']))).toEqual(['src/shared/events.luau']);
    // A folder inside or around another one is shared too.
    expect(sharedFolders(claimsOf(['src/Server']), claimsOf(['src/Server/Combat']))).toEqual(['src/server']);
    expect(sharedFolders(claimsOf(['src/Client']), claimsOf(['src/Server']))).toEqual([]);
  });

  it('warns the planner about a folder another unfinished task also claims', () => {
    const node = (id: string, files: string[], status = 'ready'): PlanNode => ({ id, ref: id, title: `Task ${id}`, role: 'roblox-engineer', status, deps: [], files });
    const g = (...ns: PlanNode[]) => new Map(ns.map((n) => [n.id, n]));
    const nodes = g(node('combat', ['src/Server/Combat']), node('sounds', ['src/Server/Combat', 'src/Server/Combat/Sounds.luau']), node('ui', ['src/Client/UI/Hud.luau']), node('old', ['src/Server/Combat'], 'done'));
    const w = claimWarnings(nodes.get('sounds')!, nodes);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'shared-folder', task: 'sounds' });
    expect(w[0]!.message).toMatch(/lists the folder src\/server\/combat, and so does "Task combat"/);
    expect(w[0]!.message).toMatch(/A folder keeps nobody out/);
    expect(w[0]!.message).toContain('plan_set_files {task: "sounds", files: [...]}');
    // Exact files, other folders and finished tasks don't warn.
    expect(claimWarnings(nodes.get('ui')!, nodes)).toEqual([]);
    expect(claimWarnings(node('x', ['src/Client/Combat']), g(node('x', ['src/Client/Combat']), ...nodes.values()))).toEqual([]);
    expect(claimWarnings(node('y', ['src/Server/Combat/Hit.luau']), nodes)).toEqual([]);
  });
});

const makeCore = coreHarness();

describe('the scheduler and file claims', () => {
  it('runs tasks that share a folder at the same time, tells each whose files are whose, and makes the same file take turns', async () => {
    let releaseWork!: () => void;
    const workBlocked = new Promise<void>((r) => (releaseWork = r));
    const { core, ctx, provider, root } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          await workBlocked;
          return { status: 'implemented', summary: 'done' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    mkdirSync(join(root, 'src', 'Server', 'Combat'), { recursive: true });
    ctx.updateSettings({ maxConcurrentAgents: 8 });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const mk = (title: string, role: string, files: string[]) => ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role, status: 'ready', files, createdBy: 'test', verification: [{ kind: 'critic' }] });
    // The three tasks of the run: each lists the Combat folder, and its own file in it.
    const sounds = mk('Wire sounds', 'sound-designer', ['src/Server/Combat', 'src/Server/Combat/Sounds.luau']);
    const effects = mk('Wire effects', 'vfx-artist', ['src/Server/Combat', 'src/Server/Combat/Effects.luau']);
    const security = mk('Security pass', 'roblox-engineer', ['src/Server/Combat']);
    // Two tasks that name the same file.
    const first = mk('Events: damage', 'luau-engineer', ['src/Shared/Events.luau']);
    const second = mk('Events: score', 'luau-engineer', ['src/Shared/Events.luau']);
    core.orchestrator.resume();

    await waitFor(() => [sounds, effects, security, first].every((t) => ctx.tasks.get(t.id)!.status === 'running'), 30000);
    // The same file: the second waits for the first, with agents to spare.
    expect(ctx.tasks.get(second.id)!.status).toBe('ready');
    expect(provider.runs.filter((r) => r.role !== 'critic')).toHaveLength(4);

    // Each agent in the shared folder is told which files are someone else's.
    const promptOf = (role: string) => provider.runs.find((r) => r.role === role)!.prompt;
    expect(promptOf('roblox-engineer')).toMatch(/Other agents are working in your folders right now/);
    expect(promptOf('roblox-engineer')).toContain('- src/Server/Combat/Sounds.luau: "Wire sounds" (Sound designer)');
    expect(promptOf('roblox-engineer')).toContain('- src/Server/Combat/Effects.luau: "Wire effects"');
    expect(promptOf('roblox-engineer')).toMatch(/Don't edit them: if you need something changed in one, say exactly what in your result/);
    expect(promptOf('sound-designer')).toContain('- src/Server/Combat/Effects.luau: "Wire effects"');
    // Its own file is its own, and a neighbour with no file of its own is named.
    expect(promptOf('sound-designer')).not.toContain('- src/Server/Combat/Sounds.luau');
    expect(promptOf('sound-designer')).toMatch(/Also working somewhere in them: "Security pass"/);
    // A task with exact files only shares nothing.
    expect(promptOf('luau-engineer')).not.toMatch(/Other agents are working in your folders/);

    // A file another running agent has edited is listed too, claimed or not.
    const run = provider.runs.find((r) => r.role === 'roblox-engineer')!;
    const call = ctx.audit.beginToolCall({ runId: run.runId, taskId: security.id, role: 'roblox-engineer', providerId: 'fake', source: 'agent_builtin', tool: 'Edit', capability: 'fake.edit_files', args: { file_path: join(root, 'src', 'Server', 'Combat', 'Validate.luau') } });
    ctx.audit.endToolCall(call, { status: 'ok', durationMs: 1 });
    const late = mk('Combat tuning', 'game-designer', ['src/Server/Combat']);
    await waitFor(() => provider.runs.some((r) => r.role === 'game-designer'), 30000);
    expect(promptOf('game-designer')).toContain('- src/Server/Combat/Validate.luau: "Security pass"');

    releaseWork();
    await waitFor(() => [sounds, effects, security, first, second, late].every((t) => ctx.tasks.get(t.id)!.status === 'done'), 60000);
    // The second of the same file started only after the first was done.
    const started = (id: string) => Date.parse(ctx.tasks.get(id)!.startedAt!);
    expect(started(second.id)).toBeGreaterThanOrEqual(Date.parse(ctx.tasks.get(first.id)!.completedAt!));
  }, 120000);
});

describe('the planner and file claims', () => {
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

  it('answers plan_add_task with FILES when the task claims a folder another task claims, and plan_set_files fixes it', async () => {
    const { ctx, goal, call } = await planning();
    const combat = await call('plan_add_task', { ...planArgs('combat', 'roblox-engineer', [], 'Combat core'), files: ['src/Server/Combat'] });
    expect(combat.json).not.toHaveProperty('FILES');
    const sounds = await call('plan_add_task', { ...planArgs('sounds', 'sound-designer', [], 'Wire sounds'), files: ['src/Server/Combat', 'src/Client/Combat'] });
    expect(sounds.error).toBe(false);
    expect(sounds.json).toMatchObject({ key: 'sounds', starts: 'now' });
    expect(sounds.json).not.toHaveProperty('WARNING');
    expect(String(sounds.json!.FILES)).toMatch(/shares a folder/);
    expect(String(sounds.json!.FILES)).toMatch(/"Wire sounds" lists the folder src\/server\/combat, and so does "Combat core"/);
    expect(String(sounds.json!.FILES)).toContain('plan_set_files {task: "sounds", files: [...]}');
    // Exact files instead: no warning left, and the task has them.
    const set = await call('plan_set_files', { task: 'sounds', files: ['src/Server/Combat/SoundHooks.luau'] });
    expect(set.error, set.text).toBe(false);
    expect(set.json).not.toHaveProperty('FILES');
    expect(ctx.tasks.byPlanKey(goal.id, 'sounds')!.files).toEqual(['src/Server/Combat/SoundHooks.luau']);
    // Still a shared folder: said again.
    expect(String((await call('plan_set_files', { task: 'sounds', files: ['src/Server'] })).json!.FILES)).toMatch(/still shares a folder/);
    // Only a task that has not started.
    ctx.tasks.setStatus(ctx.tasks.byPlanKey(goal.id, 'combat')!.id, 'running');
    expect((await call('plan_set_files', { task: 'combat', files: [] })).text).toMatch(/is running: only a task that has not started/);
    expect((await call('plan_set_files', { task: 'nope', files: [] })).text).toMatch(/No task "nope"/);
  });

  it('puts a shared folder of a batch on the timeline', async () => {
    const { core, ctx, goal } = await planning();
    const spec = (key: string, files: string[]) => ({ key, title: `Task ${key}`, kind: 'implement' as const, role: 'roblox-engineer', objective: 'Do the piece.', acceptanceCriteria: ['Done'], verification: [], dependsOn: [], files });
    expect(Array.isArray(core.orchestrator.addTasks(ctx, goal.id, [spec('a', ['src/Server/Combat']), spec('b', ['src/Server/Combat'])], 'executive'))).toBe(true);
    const ev = ctx.audit.timeline({ limit: 50 }).find((e) => e.kind === 'plan.warning');
    expect(ev?.title).toMatch(/warnings? \(shared-folder\)/);
    expect((ev?.detail as { warnings: string[] }).warnings[0]).toMatch(/A folder keeps nobody out/);
  });

  it('shows plan_set_files to the planner only, and tells the planner and every agent the rule', () => {
    expect(ROLES.executive!.appTools).toContain('plan_set_files');
    expect(WORKSHOP_TOOLS.planning).toContain('plan_set_files');
    expect(hiddenToolsFor(ROLES['roblox-engineer']!)?.has('plan_set_files')).toBe(true);
    expect(ROLES.executive!.instructions).toMatch(/two tasks naming the same file take turns; a folder keeps nobody out/);
    expect(ROLES.executive!.instructions).not.toMatch(/tasks sharing files never run concurrently/);
    expect(ROLES['roblox-engineer']!.instructions).toMatch(/A file another running agent is editing[^.]*is not yours to edit/);
  });
});
