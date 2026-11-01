import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../src/shared/domain';
import { PLAN_HOLD_MS, heldByPlanUpdate, pendingUserPlanUpdates } from '../src/core/orchestrator/plan-gate';
import { DEFAULT_TASK_MINUTES, estimateLine, estimateRemaining } from '../src/core/director/eta';
import { PLAN_PENDING_NOTE, claimsPlanChanged } from '../src/core/director/plan-claims';
import { ROLES } from '../src/core/agents/roles';
import { coreHarness, planArgs, waitFor } from './helpers/make-core';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
const T = (o: Partial<Task> & { id: string }): Task => ({
  parentId: 'obj',
  kind: 'implement',
  title: o.id,
  objective: 'x',
  reason: '',
  role: 'roblox-engineer',
  status: 'ready',
  priority: 50,
  acceptanceCriteria: [],
  verification: [],
  requiredSkills: [],
  requiredKnowledge: [],
  tools: [],
  files: [],
  robloxSystems: [],
  dependencies: [],
  attempts: 0,
  maxAttempts: 3,
  result: null,
  failureSummary: null,
  createdBy: 'executive',
  createdAt: at(0),
  updatedAt: at(0),
  startedAt: null,
  completedAt: null,
  ...o,
});

describe('the plan-update gate (pure)', () => {
  const update = T({ id: 'upd', kind: 'plan', createdBy: 'user', status: 'running', createdAt: at(10) });

  it('knows the plan updates a user’s change started that are still pending', () => {
    const plans = [
      update,
      T({ id: 'ready', kind: 'plan', createdBy: 'user', status: 'ready' }),
      T({ id: 'first', kind: 'plan', createdBy: 'executive', status: 'running' }), // the first plan: its tasks start as it adds them
      T({ id: 'triage', kind: 'plan', createdBy: 'executive', status: 'ready' }),
      ...(['done', 'failed', 'escalated', 'cancelled', 'blocked', 'paused', 'proposed'] as const).map((status) => T({ id: `u-${status}`, kind: 'plan', createdBy: 'user', status })),
      T({ id: 'orphan', kind: 'plan', createdBy: 'user', status: 'ready', parentId: null }),
      T({ id: 'work', createdBy: 'user', status: 'ready' }),
    ];
    expect(pendingUserPlanUpdates(plans).map((t) => t.id)).toEqual(['upd', 'ready']);
  });

  it('holds the objective’s older tasks, not the planner’s own additions, other objectives’ tasks or planners', () => {
    const older = T({ id: 'older', createdAt: at(0) });
    // A minute after the change came in.
    const soon = new Date(update.createdAt).getTime() + 60_000;
    expect(heldByPlanUpdate(older, [update], soon)?.id).toBe('upd');
    // Added after the change came in (by the planner that is handling it): starts at once.
    expect(heldByPlanUpdate(T({ id: 'added', createdAt: at(11) }), [update], soon)).toBeNull();
    // Another objective's work is untouched; so are planners, objectives and tasks without a parent.
    expect(heldByPlanUpdate(T({ id: 'other', parentId: 'obj2' }), [update], soon)).toBeNull();
    expect(heldByPlanUpdate(T({ id: 'older-plan', kind: 'plan', createdAt: at(0) }), [update], soon)).toBeNull();
    expect(heldByPlanUpdate(T({ id: 'goal', kind: 'objective', createdAt: at(0) }), [update], soon)).toBeNull();
    expect(heldByPlanUpdate(T({ id: 'loose', parentId: null }), [update], soon)).toBeNull();
    // The hold is short: in the user's builds every ready task of a goal sat still for 9 to 24 minutes behind a plan
    // update. After two minutes the older work starts, whatever the planner is still doing.
    expect(PLAN_HOLD_MS).toBe(120_000);
    expect(heldByPlanUpdate(older, [update], new Date(update.createdAt).getTime() + PLAN_HOLD_MS - 1)?.id).toBe('upd');
    expect(heldByPlanUpdate(older, [update], new Date(update.createdAt).getTime() + PLAN_HOLD_MS)).toBeNull();
    // No pending update, nothing held.
    expect(heldByPlanUpdate(older, [])).toBeNull();
  });
});

describe('the finish estimate (pure)', () => {
  const finished = (id: string, minutes: number) => T({ id, status: 'done', startedAt: at(0), completedAt: at(minutes), createdAt: at(0) });
  const typical20 = [finished('d1', 10), finished('d2', 30)];

  it('is nothing when nothing is left', () => {
    expect(estimateRemaining([], Date.parse(at(60)), 3)).toBeNull();
    expect(estimateRemaining([...typical20, T({ id: 'x', status: 'cancelled' }), T({ id: 'y', status: 'proposed' })], Date.parse(at(60)), 3)).toBeNull();
  });

  it('follows the longest chain, whatever the number of agents', () => {
    const chain = [T({ id: 'a' }), T({ id: 'b', dependencies: ['a'] }), T({ id: 'c', dependencies: ['b'] })];
    const e = estimateRemaining([...typical20, ...chain], Date.parse(at(60)), 6)!;
    // A task starts when the work of the one before exists (three quarters of its time), not after its review: 15 + 15 + 20.
    expect(e).toMatchObject({ left: 3, chain: 3, chainTitles: ['a', 'b', 'c'], typical: 20, measured: true, low: 50, high: 90 });
    // Three agents, six independent tasks: the work shared between them (the old "tasks ÷ agents"), not a chain.
    const wide = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => T({ id }));
    expect(estimateRemaining([...typical20, ...wide], Date.parse(at(60)), 3)).toMatchObject({ chain: 1, low: 40, high: 75 });
    // With more agents than tasks a task still takes its time.
    expect(estimateRemaining([...typical20, ...wide], Date.parse(at(60)), 10)).toMatchObject({ low: 20, high: 40 });
    // A wide plan with one long chain in it is paced by the chain.
    const mixed = [...wide.slice(0, 2), ...chain];
    expect(estimateRemaining([...typical20, ...mixed], Date.parse(at(60)), 6)).toMatchObject({ chain: 3, low: 50 });
  });

  it('counts only what is left of a task under way, and finished or cancelled tasks cost nothing', () => {
    const running = T({ id: 'a', status: 'running', startedAt: at(55) });
    const next = T({ id: 'b', dependencies: ['a'] });
    expect(estimateRemaining([...typical20, running, next], Date.parse(at(60)), 3)).toMatchObject({ low: 30, high: 60 }); // 10 until a's work exists + 20
    // A task past its usual time still has the checks and review ahead.
    expect(estimateRemaining([...typical20, T({ id: 'a', status: 'running', startedAt: at(0) }), next], Date.parse(at(120)), 3)).toMatchObject({ low: 20 });
    // A dependency that is done (or gone) is no wait.
    const after = T({ id: 'c', dependencies: ['d1', 'ghost'] });
    expect(estimateRemaining([...typical20, after], Date.parse(at(60)), 3)).toMatchObject({ chain: 1, low: 20 });
  });

  it('has a default pace and says it is a guess before any task finished; counts waiting tasks and plan updates', () => {
    const e = estimateRemaining([T({ id: 'a' }), T({ id: 'b', status: 'escalated' }), T({ id: 'upd', kind: 'plan', createdBy: 'user', status: 'running' })], Date.parse(at(5)), 3)!;
    expect(e).toMatchObject({ measured: false, typical: DEFAULT_TASK_MINUTES, stuck: 1, planning: 1, left: 2 });
    const line = estimateLine(e);
    expect(line).toMatch(/^Estimate to finish what is planned: about \d+-\d+ min \(an estimate, not a promise; no task has finished yet, so about 25 min per task is a guess/);
    expect(line).toMatch(/Not counted: a plan update still running \(it may add tasks, so this can grow\); 1 task waiting for the user's answer; usage limits\./);
    // Only a plan update is left: the estimate says it may grow, with nothing counted yet.
    expect(estimateRemaining([T({ id: 'upd', kind: 'plan', createdBy: 'user', status: 'ready' })], Date.parse(at(5)), 3)).toMatchObject({ left: 0, planning: 1 });
  });

  it('says what the chain is, and that more agents do not shorten it', () => {
    const chain = [T({ id: 'a', title: 'Maze walls' }), T({ id: 'b', title: 'Griever model', dependencies: ['a'] }), T({ id: 'c', title: 'Griever AI', dependencies: ['b'] })];
    const line = estimateLine(estimateRemaining([...typical20, ...chain], Date.parse(at(60)), 6)!);
    expect(line).toMatch(/about 50-90 min \(an estimate, not a promise; about 20 min per task so far, rework margin included\)\./);
    expect(line).toMatch(/The longest chain of remaining tasks is 3 long \("Maze walls" → "Griever model" → "Griever AI"\): tasks that wait for each other don't run side by side, so more agents don't shorten it\./);
    // A single task has no chain to talk about.
    expect(estimateLine(estimateRemaining([...typical20, T({ id: 'solo' })], Date.parse(at(60)), 3)!)).not.toMatch(/longest chain/);
  });

  it('survives a cycle', () => {
    const e = estimateRemaining([T({ id: 'a', dependencies: ['b'] }), T({ id: 'b', dependencies: ['a'] })], Date.parse(at(5)), 3);
    expect(e?.left).toBe(2);
  });
});

describe('claims that the plan already changed (pure)', () => {
  it('catches past-tense claims', () => {
    for (const reply of [
      'Scoping is done: only the Griever stays.',
      'The scope has been narrowed to the Griever.',
      'The plan is updated, the rest is gone.',
      "I've updated the plan.",
      'I updated the plan so it only has the Griever.',
      'We just trimmed the plan to the essentials.',
      'The plan has been adjusted. Sounds are now independent.',
      'The plan is now ready.',
    ]) expect(claimsPlanChanged(reply), reply).toBe(true);
  });

  it('lets plans, futures and negations through', () => {
    for (const reply of [
      "I've asked the planner to update the plan; it will change when it finishes.",
      'The plan will be updated in a few minutes.',
      "Scoping isn't done yet.",
      'The plan is not updated yet.',
      'The planner is updating the plan now.',
      'I cancelled the maze walls and the sword rack right now.',
      'Planning is running.',
      "I'll update the plan once you confirm.",
    ]) expect(claimsPlanChanged(reply), reply).toBe(false);
    expect(PLAN_PENDING_NOTE).toMatch(/planner is still working on the plan update/);
  });
});

describe('the director’s brief', () => {
  const director = ROLES.director!.instructions;
  it('cancels what a narrowed scope rules out itself, in the same reply, plan updates included', () => {
    expect(director).toMatch(/Scope is yours to enforce in the SAME reply,\s+never left to the planner/);
    for (const phrase of ['only X', 'just the Griever', 'drop the rest', "don't pass\\s+it to the planner", 'never mind']) expect(director).toMatch(new RegExp(phrase));
    expect(director).toMatch(/a plan update you created that they take back \(listed\s+under "Planner work not finished yet"\)/);
    expect(director).toMatch(/Use intent\s+"change" only for work that is NEW/);
  });
  it('passes a note to the creator on and starts nothing from it, and never speaks as the creator', () => {
    expect(director).toMatch(/A message addressed to the creator or developers \("note to the\s+creator", "tell the devs"\) is for THEM, not for the team/);
    expect(director).toMatch(/put it in "feedback" and reply in one or\s+two sentences that it was passed on/);
    expect(director).toMatch(/start no task, plan change or side task from it unless the same message also asks the team\s+for something in the game/);
    expect(director).toMatch(/You are not the creator and never speak as if you were/);
  });
  it('never claims a plan change is done while its planner job is pending, and quotes the estimate line', () => {
    expect(director).toMatch(/A plan change is not done\s+while its planner job is listed under "Planner work not finished yet"/);
    expect(director).toMatch(/never say the plan\s+is updated, scoped or set before then/);
    expect(director).toMatch(/quote the "Estimate to finish" line of your state/);
    expect(director).toMatch(/called an estimate/);
    expect(director).toMatch(/Never work out a shorter\s+figure yourself/);
    expect(director).not.toMatch(/use the Pace line \(tasks left/);
  });
});

const makeCore = coreHarness();
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
const outputProps = (req: { outputSchema?: unknown }) => (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
const pass = { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };

describe('the scheduler holds a goal’s older tasks while the plan update for the user’s change runs', () => {
  it('holds them, lets new tasks and other goals start, and releases them when the planner finishes', async () => {
    let releasePlanner!: () => void;
    const plannerBlocked = new Promise<void>((r) => (releasePlanner = r));
    const { core, ctx } = await makeCore({
      respond: async (req, kind, call) => {
        if ('intent' in outputProps(req)) return null;
        if (kind === 'plan') {
          // The planner adds a task of its own, then keeps planning.
          await call('plan_add_task', planArgs('fresh', 'level-designer', [], 'Fresh task'));
          await plannerBlocked;
          return { summary: 'Updated.' };
        }
        if (kind === 'work') return { status: 'implemented', summary: 'done' };
        if (kind === 'review') return pass;
        return null;
      },
    });
    ctx.updateSettings({ maxConcurrentAgents: 6 });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const a = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze walls', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    const b = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Sword rack', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    const goal2 = ctx.tasks.create({ kind: 'objective', title: 'Lobby', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const other = ctx.tasks.create({ parentId: goal2.id, kind: 'implement', title: 'Lobby sign', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    const plan = core.orchestrator.amendPlan(goal.id, 'Only the Griever, drop the rest.');
    core.orchestrator.resume();

    // The planner starts and adds a task of its own: it starts at once, with the update still pending.
    const fresh = await waitFor(() => ctx.tasks.byPlanKey(goal.id, 'fresh'));
    await waitFor(() => ctx.tasks.get(fresh.id)!.status !== 'ready');
    expect(ctx.tasks.get(plan.id)!.status).toBe('running');
    // Another goal's work isn't held.
    await waitFor(() => ctx.tasks.get(other.id)!.status !== 'ready');
    // The older tasks of this goal wait for the planner, who may cancel them.
    await new Promise((r) => setTimeout(r, 700));
    expect(ctx.tasks.get(a.id)).toMatchObject({ status: 'ready', attempts: 0 });
    expect(ctx.tasks.get(b.id)).toMatchObject({ status: 'ready', attempts: 0 });
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'plan.hold' && e.taskId === plan.id)).toBe(true);

    // The planner finishes: the gate opens.
    releasePlanner();
    await waitFor(() => ctx.tasks.get(plan.id)!.status === 'done');
    await waitFor(() => ctx.tasks.get(a.id)!.status !== 'ready' && ctx.tasks.get(b.id)!.status !== 'ready');
    // Let them finish (checks and review included) before the core closes.
    await waitFor(() => [a, b, fresh, other].every((t) => ctx.tasks.get(t.id)!.status === 'done'), 50000);
  }, 90000);

  it('a plan update that only removes work, or finds nothing to change, is done: never "the planner did not add any tasks"', async () => {
    let plans = 0;
    const { core, ctx } = await makeCore({
      respond: async (req, kind, call) => {
        if ('intent' in outputProps(req)) return null;
        if (kind === 'plan') {
          plans++;
          if (/wrap up now/.test(req.prompt)) {
            const rack = ctx.tasks.list({}).find((t) => t.title === 'Sword rack')!;
            await call('plan_cancel_task', { task: rack.id, reason: 'The user is wrapping up: not started, no longer wanted.' });
            return { summary: 'Nothing new: I cancelled the sword rack, which had not started.' };
          }
          return { summary: 'The plan already covers this; nothing to change.' };
        }
        if (kind === 'work') return { status: 'implemented', summary: 'done' };
        if (kind === 'review') return pass;
        return null;
      },
    });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const rack = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Sword rack', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    const wrap = core.orchestrator.amendPlan(goal.id, 'The user wants to wrap up now and will test the game themselves: add nothing.');
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(wrap.id)!.status === 'done', 30000);
    expect(ctx.tasks.get(wrap.id)).toMatchObject({ attempts: 1, result: 'Nothing new: I cancelled the sword rack, which had not started.' });
    expect(ctx.tasks.get(rack.id)!.status).toBe('cancelled');
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'task.status' && e.taskId === wrap.id && /→ done$/.test(e.title) && (e.detail as { reason?: string } | null)?.reason === 'Plan updated: 1 task cancelled, none added')).toBe(true);
    // Nothing to change at all is an answer too.
    const again = core.orchestrator.amendPlan(goal.id, 'Is the plan fine as it is?');
    core.orchestrator.kick();
    await waitFor(() => ctx.tasks.get(again.id)!.status === 'done', 30000);
    expect(ctx.tasks.get(again.id)!.attempts).toBe(1);
    expect(plans).toBe(2);
    expect(ctx.tasks.failures(wrap.id)).toEqual([]);
    expect(ctx.tasks.failures(again.id)).toEqual([]);
  }, 60000);

  it('lets tasks that already run carry on', async () => {
    let releaseWork!: () => void;
    const workBlocked = new Promise<void>((r) => (releaseWork = r));
    let releasePlanner!: () => void;
    const plannerBlocked = new Promise<void>((r) => (releasePlanner = r));
    const { core, ctx } = await makeCore({
      respond: async (req, kind, call) => {
        if ('intent' in outputProps(req)) return null;
        if (kind === 'plan') {
          await call('plan_add_task', planArgs('lava', 'level-designer', [], 'Lava level'));
          await plannerBlocked;
          return { summary: 'Updated.' };
        }
        if (kind === 'work') {
          await workBlocked;
          return { status: 'implemented', summary: 'done' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    ctx.updateSettings({ maxConcurrentAgents: 6 });
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const busy = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever model', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    core.orchestrator.kick();
    await waitFor(() => ctx.tasks.get(busy.id)!.status === 'running');
    const plan = core.orchestrator.amendPlan(goal.id, 'Also add a lava level.');
    await waitFor(() => ctx.tasks.get(plan.id)!.status === 'running');
    // Already running work finishes, checks and review included, while the update is still being planned.
    releaseWork();
    await waitFor(() => ctx.tasks.get(busy.id)!.status === 'done');
    expect(ctx.tasks.get(plan.id)!.status).toBe('running');
    releasePlanner();
    await waitFor(() => ctx.tasks.get(plan.id)!.status === 'done');
    await waitFor(() => ctx.tasks.byPlanKey(goal.id, 'lava')?.status === 'done');
  }, 60000);

  it('releases them when the plan update is cancelled, and the chat says so', async () => {
    let releasePlanner!: () => void;
    const plannerBlocked = new Promise<void>((r) => (releasePlanner = r));
    const { core, ctx } = await makeCore({
      respond: async (req, kind) => {
        if ('intent' in outputProps(req)) return null;
        if (kind === 'plan') {
          await plannerBlocked;
          return { summary: 'Updated.' };
        }
        if (kind === 'work') return { status: 'implemented', summary: 'done' };
        if (kind === 'review') return pass;
        return null;
      },
    });
    ctx.updateSettings({ maxConcurrentAgents: 6 });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const a = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze walls', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    const plan = core.orchestrator.amendPlan(goal.id, 'Only the Griever.');
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(plan.id)!.status === 'running');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.kind === 'plan' && m.data?.status === 'planning'));
    await new Promise((r) => setTimeout(r, 500));
    expect(ctx.tasks.get(a.id)!.status).toBe('ready');
    // The user takes the request back: the update is cancelled, its card ends, and the task starts at once.
    core.orchestrator.cancel(plan.id);
    await waitFor(() => ctx.tasks.get(a.id)!.status !== 'ready');
    expect(ctx.tasks.get(plan.id)!.status).toBe('cancelled');
    expect(chat.list().find((m) => m.kind === 'plan')).toMatchObject({ text: 'The plan update was cancelled.', data: { status: 'cancelled' } });
    // The planner's run ends without recording anything for a cancelled update.
    releasePlanner();
    await waitFor(() => ctx.tasks.get(a.id)!.status === 'done', 50000);
    expect(ctx.tasks.get(plan.id)!.status).toBe('cancelled');
    expect(ctx.governance.decisions().some((d) => d.title.startsWith('Plan:'))).toBe(false);
  }, 90000);
});

describe('the director owns scope changes', () => {
  it('shows the planner work still pending, and cancels a plan update the user takes back with its own controls (no planner run)', async () => {
    let prompt = '';
    const { core, ctx, provider } = await makeCore({
      respond: async (req) => {
        if (!('intent' in outputProps(req))) return null;
        prompt = String(req.prompt ?? '');
        const id = /\(plan update\) id:(\S+)/.exec(prompt)?.[1] ?? 'missing';
        return { intent: 'chat', reply: 'Okay, I dropped that request.', tasks: [{ action: 'cancel', task: id }] };
      },
    });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const a = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze walls', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    const plan = core.orchestrator.amendPlan(goal.id, 'Add a lava level.');
    core.director.send("never mind, don't pass that to the planner");
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Okay, I dropped')));
    // The state lists it (the plan update of the goal in progress used to be left out), saying the plan has not changed.
    expect(prompt).toMatch(/Planner work not finished yet \(1\) — the plan has NOT changed until each one finishes/);
    expect(prompt).toContain(`[ready] ${ctx.tasks.get(plan.id)!.title} (plan update) id:${plan.id}`);
    expect(ctx.tasks.get(plan.id)!.status).toBe('cancelled');
    expect(ctx.tasks.get(a.id)!.status).toBe('ready');
    // Nothing was passed on: still the one plan update, and no planner ever ran.
    expect(ctx.tasks.list({ kinds: ['plan'] })).toHaveLength(1);
    expect(provider.runs.some((r) => r.role === 'executive')).toBe(false);
  });

  it('cancels what a narrowed scope drops in the same reply, before the plan update for what is new exists', async () => {
    let prompt = '';
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        if (!('intent' in outputProps(req))) return null;
        prompt = String(req.prompt ?? '');
        const id = (title: string) => new RegExp(`\\[ready\\] ${title}[^\\n]*id:(\\S+)`).exec(prompt)?.[1] ?? 'missing';
        return {
          intent: 'change',
          request: 'Only the Griever now; add its chase run clip.',
          reply: 'Only the Griever now: I cancelled the maze walls and the sword rack, and asked the planner for the chase clip.',
          tasks: [
            { action: 'cancel', task: id('Maze walls') },
            { action: 'cancel', task: id('Sword rack') },
          ],
        };
      },
    });
    ctx.updateSettings({ autonomy: 'manual' }); // nothing starts by itself: the plan update can be looked at before it runs
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const walls = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze walls', objective: 'x', role: 'level-designer', status: 'ready', createdBy: 'test' });
    const rack = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Sword rack', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    const griever = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever model', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    core.director.send('only the Griever from now on, drop the rest, and give it a chase clip');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Only the Griever now')));
    // Cancelled by the director itself, right away; what the user kept is untouched; the new work went to the planner.
    expect(ctx.tasks.get(walls.id)!.status).toBe('cancelled');
    expect(ctx.tasks.get(rack.id)!.status).toBe('cancelled');
    expect(ctx.tasks.get(griever.id)!.status).toBe('ready');
    const update = ctx.tasks.list({ kinds: ['plan'] }).find((t) => t.createdBy === 'user')!;
    expect(update).toMatchObject({ status: 'ready', parentId: goal.id });
    // The reply says what it did (cancelled now; the planner asked), and makes no claim the plan is done.
    expect(chat.list().find((m) => m.role === 'director' && m.text.startsWith('Only the Griever now'))!.text).not.toMatch(/still working on the plan update/);
  });

  // The user stopped everything, asked for a big update half an hour later, got "On it", and nothing ran for 32 minutes.
  it('after a stop, a request for work is planned and waits for the word to go; with it the team runs again and says so', async () => {
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        if (!('intent' in outputProps(req))) return null;
        return { intent: 'change', request: 'Turn it into a parkour PVP.', reply: 'On it: I asked the planner for a fast, wide update.' };
      },
    });
    ctx.tasks.create({ kind: 'objective', title: 'Coin Grab', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    core.orchestrator.pause();
    expect(core.orchestrator.state().paused).toBe(true);
    const chat = core.director.chat()!;
    core.director.send('do the next update rapidly: expand the map and turn this into a parkour PVP');
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('On it')));
    expect(core.orchestrator.state().paused).toBe(true);
    expect(chat.list().filter((m) => m.role === 'director').at(-1)!.text).toMatch(/still stopped/);
    core.director.send('do it now: expand the map and turn this into a parkour PVP');
    await waitFor(() => !core.orchestrator.state().paused);
    expect(chat.list().some((m) => m.kind === 'status' && m.text === 'The team was stopped. It is running again for this request.')).toBe(true);
  });

  it('adds a note to a reply that claims the plan changed while its plan update is still pending', async () => {
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        if (!('intent' in outputProps(req))) return null;
        return { intent: 'change', request: 'Only the Griever.', reply: 'Scoping is done: the plan is updated and only the Griever remains.' };
      },
    });
    ctx.updateSettings({ autonomy: 'manual' }); // nothing starts by itself: the plan update can be looked at before it runs
    ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    core.director.send('only the Griever');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Scoping is done')));
    const reply = chat.list().find((m) => m.role === 'director' && m.text.startsWith('Scoping is done'))!;
    expect(reply.text).toContain(PLAN_PENDING_NOTE);
    expect(reply.text.startsWith('Scoping is done: the plan is updated and only the Griever remains.')).toBe(true);
    expect(ctx.tasks.list({ kinds: ['plan'] }).some((t) => t.createdBy === 'user' && t.status === 'ready')).toBe(true);
  });

  it('leaves the same words alone when no plan update is pending', async () => {
    const { core, ctx } = await makeCore({
      respond: async (req) => (!('intent' in outputProps(req)) ? null : { intent: 'question', reply: 'Scoping is done: the plan is updated and only the Griever remains.' }),
    });
    core.orchestrator.pause();
    ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    core.director.send('where are we?');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Scoping is done')));
    expect(chat.list().find((m) => m.role === 'director' && m.text.startsWith('Scoping is done'))!.text).not.toContain(PLAN_PENDING_NOTE);
  });

  it('saves a note to the creator for the developers and starts nothing from it: no task, no plan update, no agent run', async () => {
    const { core, ctx, provider } = await makeCore({
      respond: async (req) => (!('intent' in outputProps(req)) ? null : { intent: 'chat', reply: 'Passed on to the creator.', feedback: 'The user ran the exporter script and wants its app details documented in a .md file.' }),
    });
    core.orchestrator.pause();
    ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const before = ctx.tasks.list({}).length;
    core.director.send("note to the creator: I've just run the script. Document that in some kind of .md with app details");
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Passed on')));
    expect(readFileSync(join(core.opts.dataDir, 'feedback.md'), 'utf8')).toMatch(/exporter script and wants its app details documented in a \.md file/);
    expect(ctx.tasks.list({}).length).toBe(before);
    expect(provider.runs.filter((r) => r.role !== 'director')).toHaveLength(0);
  });

  it('says in its reply which controls could not be done (finished work cannot be cancelled)', async () => {
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        if (!('intent' in outputProps(req))) return null;
        const id = /\[done\] Finished model[^\n]*id:(\S+)/.exec(String(req.prompt ?? ''))?.[1] ?? 'missing';
        return { intent: 'chat', reply: 'Cancelled it.', tasks: [{ action: 'cancel', task: id }] };
      },
    });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Finished model', objective: 'x', role: 'modeler', status: 'done', createdBy: 'test' });
    core.director.send('cancel the finished model');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Cancelled it.')));
    expect(chat.list().find((m) => m.text.startsWith('Cancelled it.'))!.text).toMatch(/I couldn't change "Finished model": it was already finished\./);
  });

  it('puts the finish estimate from the longest chain in the director’s state', async () => {
    let prompt = '';
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        if (!('intent' in outputProps(req))) return null;
        prompt = String(req.prompt ?? '');
        return { intent: 'question', reply: 'About an hour, an estimate.' };
      },
    });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const done = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze walls', objective: 'x', role: 'level-designer', status: 'done', createdBy: 'test' });
    ctx.store.run('UPDATE tasks SET started_at = ?, completed_at = ? WHERE id = ?', [at(0), at(20), done.id]);
    const model = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever model', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    const clips = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever clips', objective: 'x', role: 'animator', status: 'ready', createdBy: 'test', dependencies: [model.id] });
    ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever AI', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test', dependencies: [clips.id] });
    core.director.send('how long until it is done?');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('About an hour')));
    expect(prompt).toMatch(/Estimate to finish what is planned: about 50-90 min \(an estimate, not a promise; about 20 min per task so far/);
    expect(prompt).toMatch(/longest chain of remaining tasks is 3 long \("Griever model" → "Griever clips" → "Griever AI"\)/);
  });
});
