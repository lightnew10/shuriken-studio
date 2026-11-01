import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/shared/domain';
import { ROLES, OUTPUT_SCHEMAS } from '../src/core/agents/roles';
import { ITERATION_REASON } from '../src/core/orchestrator/orchestrator';
import { budgetNotice, closedForBudget, followUpBudget, followUpCounts, followUpRoom, polishLevel, triageKind } from '../src/core/orchestrator/proposal-triage';
import { DEFECT_REASON, MAX_WRAPUP_TRIAGES, POLISH_AFTER_MS, POLISH_BATCH, TRIAGE_AFTER_MS, TRIAGE_BATCH, TRIAGE_DEFECTS_PREFIX, TRIAGE_POLISH_PREFIX, classifyFollowUp, dueBatches, duePolishBatches, isTriagePlan, listedProposalIds, polishDue, triageDue } from '../src/core/orchestrator/proposal-triage';
import { coreHarness, planArgs, waitFor } from './helpers/make-core';
import { DEFAULT_APP_PREFS } from '../src/core/app-prefs';

/**
 * A 4.6 h build: agents file cross-domain defects as `proposed` tasks, which only the objective's wrap-up
 * triaged (it never came), and quick iterations skipped triage altogether. The launch wheelspin was reported
 * by three agents an hour before the user hit it.
 */
const makeCore = coreHarness();

const T = (over: Partial<Task> & { id: string }): Task => ({
  parentId: 'obj',
  kind: 'implement',
  title: over.id,
  objective: 'x',
  reason: `${DEFECT_REASON} critic while working on "Cars"`,
  role: 'roblox-engineer',
  status: 'proposed',
  priority: 55,
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
  createdBy: 'critic',
  createdAt: new Date().toISOString(),
  updatedAt: '',
  startedAt: null,
  completedAt: null,
  ...over,
});
const OBJ = T({ id: 'obj', parentId: null, kind: 'objective', status: 'running', reason: 'Defined by the user', createdBy: 'user' });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
/** A full batch of defect reports (TRIAGE_BATCH): triaged at once. */
const FIVE_DEFECTS = ['Wheelspin at launch', 'Cars fall through the bridge', 'Lap counter errors', 'Finish gate never opens', 'Nitro bar stays empty'];

describe('what counts as a defect (pure)', () => {
  it('trusts an explicit DEFECT: / POLISH: prefix and strips it', () => {
    expect(classifyFollowUp('DEFECT: Launch wheelspin, cars lose traction for 2 s (Cars/Launch). roblox-engineer should fix.')).toEqual({ defect: true, text: 'Launch wheelspin, cars lose traction for 2 s (Cars/Launch). roblox-engineer should fix.' });
    expect(classifyFollowUp('[defect] - the shop button is off-screen on phones')).toEqual({ defect: true, text: 'the shop button is off-screen on phones' });
    expect(classifyFollowUp('POLISH: confetti at the finish line')).toEqual({ defect: false, text: 'confetti at the finish line' });
    // The prefix wins over the wording.
    expect(classifyFollowUp('POLISH: the confetti is broken on purpose').defect).toBe(false);
    expect(classifyFollowUp('DEFECT: nicer fog').defect).toBe(true);
  });

  it('reads unprefixed text by its wording: broken behaviour is a defect, "optional" ideas are not', () => {
    for (const t of ['The car wheelspins at launch and never gets traction', 'Checkpoint trigger does not fire when the car is drifting', 'Players get stuck in the pit wall', 'Throws an error when the lap resets']) expect(classifyFollowUp(t).defect, t).toBe(true);
    for (const t of ['Add confetti at the finish line', 'Would be nice to have a victory sound', 'Consider fog on the mountain level', 'Optional polish: bloom at sunset', 'Maybe a drift smoke trail, a cosmetic tweak']) expect(classifyFollowUp(t).defect, t).toBe(false);
  });
});

describe('which batches are due (pure)', () => {
  const now = Date.now();
  it(`needs ${TRIAGE_BATCH} waiting, or the oldest to have waited ${TRIAGE_AFTER_MS / 60000} minutes`, () => {
    const fresh = (id: string) => T({ id, createdAt: new Date(now - 60_000).toISOString() });
    expect(triageDue([], now)).toBe(false);
    expect(triageDue([fresh('a'), fresh('b'), fresh('c'), fresh('d')], now)).toBe(false);
    expect(triageDue([fresh('a'), fresh('b'), fresh('c'), fresh('d'), fresh('e')], now)).toBe(true);
    expect(triageDue([fresh('a'), T({ id: 'old', createdAt: new Date(now - TRIAGE_AFTER_MS - 1000).toISOString() })], now)).toBe(true);
    expect(triageDue([T({ id: 'edge', createdAt: new Date(now - TRIAGE_AFTER_MS + 5000).toISOString() })], now)).toBe(false);
  });

  it('batches by objective, only defects, only for work still being built, once at a time', () => {
    const old = (id: string, over: Partial<Task> = {}) => T({ id, createdAt: new Date(now - 25 * 60_000).toISOString(), ...over });
    const iteration = T({ id: 'iter', parentId: null, kind: 'objective', status: 'ready', reason: ITERATION_REASON, createdBy: 'director' });
    const done = T({ id: 'finished', parentId: null, kind: 'objective', status: 'done' });
    const tasks: Task[] = [
      OBJ,
      iteration,
      done,
      old('d1'),
      old('d2', { parentId: 'iter' }), // an iteration is triaged too
      old('polish', { reason: 'Follow-up proposed by critic while working on "Cars"' }),
      old('user', { createdBy: 'user' }),
      old('cancelled', { status: 'cancelled' }),
      old('orphan', { parentId: null }),
      old('closed', { parentId: 'finished' }),
    ];
    const due = dueBatches(tasks, now);
    expect(due.map((d) => [d.objectiveId, d.batch.map((t) => t.id)])).toEqual([['obj', ['d1']], ['iter', ['d2']]]);
    // A triage run that is waiting or running for the objective holds the next batch back.
    const running = T({ id: 'tri', kind: 'plan', title: `${TRIAGE_DEFECTS_PREFIX} (1)`, status: 'running', reason: '', createdBy: 'executive' });
    expect(dueBatches([...tasks, running], now).map((d) => d.objectiveId)).toEqual(['iter']);
    expect(dueBatches([...tasks, { ...running, status: 'done' }], now).map((d) => d.objectiveId)).toEqual(['obj', 'iter']);
    // An objective in the middle of its wrap-up is left to it.
    expect(dueBatches(tasks.map((t) => (t.id === 'obj' ? { ...t, status: 'verifying' as const } : t)), now).map((d) => d.objectiveId)).toEqual(['iter']);
  });

  it(`polish waits for ${POLISH_BATCH} of them or ${POLISH_AFTER_MS / 60000} minutes, by objective, one triage run at a time`, () => {
    const polish = (id: string, minutes: number, over: Partial<Task> = {}) => T({ id, reason: 'Follow-up proposed by critic while working on "Cars"', createdAt: new Date(now - minutes * 60_000).toISOString(), ...over });
    expect(polishDue([], now)).toBe(false);
    expect(polishDue([polish('a', 1), polish('b', 29)], now)).toBe(false);
    expect(polishDue([polish('a', 1), polish('b', 31)], now)).toBe(true);
    expect(polishDue(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => polish(id, 1)), now)).toBe(false);
    expect(polishDue(Array.from({ length: POLISH_BATCH }, (_, i) => polish(`p${i}`, 1)), now)).toBe(true);
    // Only polish (defects have their own, quicker batches), only for an objective still being built.
    const tasks: Task[] = [OBJ, polish('p1', 30), polish('p2', 2), T({ id: 'defect', createdAt: new Date(now - 30 * 60_000).toISOString() }), polish('user', 30, { createdBy: 'user' }), polish('gone', 30, { status: 'cancelled' })];
    expect(duePolishBatches(tasks, now).map((d) => [d.objectiveId, d.batch.map((t) => t.id)])).toEqual([['obj', ['p1', 'p2']]]);
    expect(duePolishBatches([OBJ, polish('p1', 5)], now)).toEqual([]);
    // Any triage run of the objective that is waiting or running holds the batch back; a polish triage is a triage plan.
    const running = T({ id: 'tri', kind: 'plan', title: `${TRIAGE_DEFECTS_PREFIX} (1)`, status: 'running', reason: '', createdBy: 'executive' });
    expect(duePolishBatches([...tasks, running], now)).toEqual([]);
    expect(isTriagePlan(T({ id: 'pol', kind: 'plan', title: `${TRIAGE_POLISH_PREFIX} (4)` }))).toBe(true);
    expect(duePolishBatches(tasks.map((t) => (t.id === 'obj' ? { ...t, status: 'verifying' as const } : t)), now)).toEqual([]);
  });

  it('lists the proposals a triage was given', () => {
    expect(listedProposalIds('Intro\n\n- [task_01abc] a defect (reported by QA tester)\n- [task_02def] another\n\nThen cancel them.')).toEqual(['task_01abc', 'task_02def']);
  });
});

describe('the schemas teach the DEFECT:/POLISH: split', () => {
  it('tells workers and critics how to file a defect', () => {
    const of = (key: 'work' | 'review') => (OUTPUT_SCHEMAS[key] as { properties: { followUps: { description: string } } }).properties.followUps.description;
    expect(of('work')).toMatch(/starts with "DEFECT: "/);
    expect(of('work')).toMatch(/"POLISH: ": at most two/);
    // A reviewer judges: defects outside the task only, no ideas.
    expect(of('review')).toMatch(/Each starts with "DEFECT: "/);
    expect(of('review')).toMatch(/no ideas, no improvements/);
    expect(of('review')).not.toMatch(/POLISH/);
    expect(ROLES.critic!.instructions).toMatch(/DEFECT:/);
    expect(ROLES.critic!.instructions).toMatch(/You judge; you do not design\. Do not propose improvements/);
  });
});

const passing = { passed: true, results: [], summary: '0 check(s) passed' };

async function setup(script: Parameters<typeof makeCore>[0]) {
  const h = await makeCore(script);
  h.core.orchestrator.pause();
  vi.spyOn(h.core.verifier, 'regression').mockResolvedValue(passing);
  const objective = (title: string, reason = 'Defined by the user') => h.ctx.tasks.create({ kind: 'objective', title, objective: 'x', role: 'executive', reason, status: 'running', createdBy: reason === ITERATION_REASON ? 'director' : 'user' });
  /** An unfinished task: the objective stays open while its proposals are triaged. */
  const open = (parentId: string) => h.ctx.tasks.create({ parentId, kind: 'implement', title: 'Still being built', objective: 'x', role: 'roblox-engineer', status: 'paused', createdBy: 'test' });
  const propose = (parentId: string, text: string, defect = true, by = 'critic') =>
    h.ctx.tasks.create({ parentId, kind: 'implement', title: text.slice(0, 100), objective: text, reason: `${defect ? DEFECT_REASON : 'Follow-up proposed by'} ${by} while working on "Cars"`, role: 'roblox-engineer', status: 'proposed', priority: defect ? 55 : 30, createdBy: by });
  const triagePlans = (parentId: string) => h.ctx.tasks.list({ parentId, kinds: ['plan'] }).filter((t) => /^Triage/.test(t.title));
  return { ...h, objective, open, propose, triagePlans };
}

/** A planner that turns the first listed proposal into a task and cancels every listed one (what its brief asks). */
const triagingPlanner = (added: string[]) => async (req: { prompt: string }, kind: string, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) => {
  if (kind === 'work') return { status: 'implemented', summary: 'ok' };
  if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
  if (kind !== 'plan' || !/Triage/.test(req.prompt)) return null;
  const ids = [...req.prompt.matchAll(/- \[(task_[0-9a-z]+)\]/g)].map((m) => m[1]!);
  await call('plan_add_task', planArgs('fix_launch', 'roblox-engineer', [], 'Fix the launch wheelspin'));
  added.push('fix_launch');
  for (const id of ids) await call('plan_cancel_task', { task: id, reason: 'turned into a task' });
  return { summary: 'The launch wheelspin is now a task for the gameplay engineer.' };
};

describe('defects reported during a build are triaged soon', () => {
  it('files a defect from a worker and a critic as a defect proposal, polish as plain, then triages after 20 minutes with one short planner run', async () => {
    const added: string[] = [];
    let works = 0;
    const planner = triagingPlanner(added);
    const h = await setup({
      respond: async (req, kind, call) => {
        if (kind === 'work') {
          return ++works === 1
            ? { status: 'implemented', summary: 'ok', followUps: ['DEFECT: Launch wheelspin: cars lose traction for 2 s after the start light (Cars/Launch.server.luau). roblox-engineer should fix.', 'POLISH: confetti at the finish line'] }
            : { status: 'implemented', summary: 'ok' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [], followUps: ['The checkpoint trigger does not fire when a car is drifting, so the lap never counts.', 'POLISH: a nicer skybox over the track would be lovely', 'Consider adding fog on the mountain section'] };
        return planner(req, kind, call);
      },
    });
    const obj = h.objective('Racing');
    h.open(obj.id);
    h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Cars', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    h.core.orchestrator.resume();
    const proposals = await waitFor(() => {
      const p = h.ctx.tasks.list({ parentId: obj.id, statuses: ['proposed'] });
      return p.length === 3 ? p : null;
    });
    const by = (re: RegExp) => proposals.find((t) => re.test(t.objective))!;
    expect(by(/wheelspin/)).toMatchObject({ reason: expect.stringMatching(/^Defect reported by roblox-engineer/), priority: 55 });
    expect(by(/wheelspin/).title).not.toMatch(/^DEFECT/);
    expect(by(/checkpoint trigger/).reason).toMatch(/^Defect reported by critic/);
    expect(by(/confetti/)).toMatchObject({ reason: expect.stringMatching(/^Follow-up proposed by/), priority: 30 });
    // The reviewer's ideas are not filed at all: it judges, and reports defects only.
    expect(h.ctx.tasks.list({ parentId: obj.id }).some((t) => /skybox|fog on the mountain/.test(t.objective))).toBe(false);
    // Two defects are neither five nor twenty minutes old: nobody looks yet.
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.triagePlans(obj.id)).toHaveLength(0);
    // Twenty minutes later one short planner run triages the batch.
    h.ctx.store.run('UPDATE tasks SET created_at = ? WHERE status = ?', [minutesAgo(21), 'proposed']);
    h.core.orchestrator.kick();
    const plan = await waitFor(() => h.triagePlans(obj.id)[0]);
    expect(plan.title).toBe('Triage defects (2)');
    expect(plan.objective).toMatch(/launch wheelspin|Launch wheelspin/i);
    expect(plan.objective).not.toMatch(/confetti/); // polish has its own batches, when agents are free
    await waitFor(() => h.ctx.tasks.get(plan.id)!.status === 'done');
    const kids = h.ctx.tasks.list({ parentId: obj.id });
    expect(kids.find((t) => t.title === 'Fix the launch wheelspin')).toMatchObject({ role: 'roblox-engineer', createdBy: 'executive' });
    expect(kids.filter((t) => /wheelspin|checkpoint trigger/.test(t.objective) && t.status === 'proposed')).toHaveLength(0);
    expect(by(/confetti/) && h.ctx.tasks.get(by(/confetti/).id)!.status).toBe('proposed');
    // One short planner run: a handful of turns, not a planning session.
    const run = h.provider.runs.find((r) => /Triage defects/.test(r.prompt))!;
    expect(run.maxTurns).toBeLessThanOrEqual(10);
    expect(h.provider.runs.filter((r) => /Triage defects/.test(r.prompt))).toHaveLength(1);
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'plan.triage' && /Triaging 2 defect reports/.test(e.title))).toBe(true);
    expect(added).toEqual(['fix_launch']);
  }, 90000);

  it('triages as soon as three are waiting, for a quick iteration too, and never while paused', async () => {
    const added: string[] = [];
    const h = await setup({ respond: triagingPlanner(added) });
    const iteration = h.objective('Quick tweak', ITERATION_REASON);
    h.open(iteration.id);
    for (const t of ['Launch wheelspin on the grid', 'Players fall through the pit wall', 'The lap counter errors on reset']) h.propose(iteration.id, t);
    // Paused: nothing is created, however long they wait.
    h.ctx.store.run('UPDATE tasks SET created_at = ? WHERE status = ?', [minutesAgo(60), 'proposed']);
    h.core.orchestrator.kick();
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.triagePlans(iteration.id)).toHaveLength(0);
    h.core.orchestrator.resume();
    const plan = await waitFor(() => h.triagePlans(iteration.id)[0]);
    expect(plan.title).toBe('Triage defects (3)');
    await waitFor(() => h.ctx.tasks.get(plan.id)!.status === 'done');
    expect(h.ctx.tasks.list({ parentId: iteration.id, statuses: ['proposed'] })).toHaveLength(0);
  }, 90000);

  it('triages optional polish in rolling batches while agents have spare capacity, not at the wrap-up only', async () => {
    const added: string[] = [];
    const h = await setup({ respond: triagingPlanner(added) });
    const obj = h.objective('Racing');
    h.open(obj.id);
    // Two fresh ideas: neither ten of them nor thirty minutes old, so nobody looks yet.
    const first = [h.propose(obj.id, 'Add confetti at the finish line', false), h.propose(obj.id, 'A nicer fog on the mountain level', false)];
    h.core.orchestrator.resume();
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.triagePlans(obj.id)).toHaveLength(0);
    // Half an hour later, with nothing ready to start and agents free, one short planner run triages the batch.
    h.ctx.store.run('UPDATE tasks SET created_at = ? WHERE status = ?', [minutesAgo(31), 'proposed']);
    h.core.orchestrator.kick();
    const plan = await waitFor(() => h.triagePlans(obj.id)[0]);
    expect(plan.title).toBe('Triage polish (2)');
    expect(plan.objective).toMatch(/Agents have spare capacity right now/);
    expect(plan.objective).toMatch(/confetti/);
    expect(plan.objective).toMatch(/the ones not worth doing with the reason why/);
    // It is told what the goal's budget still allows (a plan of one task: the smallest budget, two).
    expect(plan.objective).toMatch(/BUDGET: this goal may still get 2 polish tasks, in all\. So choose: the 2 improvements a player would notice most/);
    await waitFor(() => h.ctx.tasks.get(plan.id)!.status === 'done');
    // What is worth doing became a task (and runs); every proposal of the batch is closed.
    expect(h.ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Fix the launch wheelspin')).toMatchObject({ createdBy: 'executive' });
    expect(first.map((t) => h.ctx.tasks.get(t.id)!.status)).toEqual(['cancelled', 'cancelled']);
    const run = h.provider.runs.find((r) => /Triage polish/.test(r.prompt))!;
    expect(run.maxTurns).toBeLessThanOrEqual(10);
    expect(run.effort).toBe('medium'); // a triage is a short job at its own effort (1.15.8)
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'plan.triage' && /Triaging 2 improvements agents proposed in "Racing" \(agents are free\)/.test(e.title))).toBe(true);
    // Ten waiting are a batch at once.
    for (let i = 0; i < POLISH_BATCH; i++) h.propose(obj.id, `Add flourish number ${i} to the menu screen`, false);
    h.core.orchestrator.kick();
    await waitFor(() => h.triagePlans(obj.id).some((t) => t.title === `Triage polish (${POLISH_BATCH})`));
  }, 90000);

  it('leaves polish alone while ready work is waiting for an agent, and in a quick iteration', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await setup({
      respond: async (req, kind) => {
        if (kind === 'work') {
          await gate;
          return { status: 'implemented', summary: 'ok' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return kind === 'plan' && /Triage/.test(req.prompt) ? { summary: 'nothing needed' } : null;
      },
    });
    h.ctx.updateSettings({ maxConcurrentAgents: 1 });
    const obj = h.objective('Racing');
    h.open(obj.id);
    for (const title of ['Cars', 'Track']) h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title, objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    const iteration = h.objective('Quick tweak', ITERATION_REASON);
    h.open(iteration.id);
    for (let i = 0; i < 6; i++) {
      h.propose(obj.id, `Add flourish number ${i} to the menu screen`, false);
      h.propose(iteration.id, `Add sparkle number ${i} to the garage door`, false);
    }
    h.ctx.store.run('UPDATE tasks SET created_at = ? WHERE status = ?', [minutesAgo(120), 'proposed']);
    h.core.orchestrator.resume();
    // The one agent is busy and a task waits for it: no capacity to spare, so no polish triage.
    await waitFor(() => h.provider.runs.some((r) => r.role === 'roblox-engineer'));
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.triagePlans(obj.id)).toHaveLength(0);
    release();
    // Once the ready work is done and an agent is free, the goal's polish is triaged; the iteration's never is.
    await waitFor(() => h.triagePlans(obj.id).some((t) => t.title === 'Triage polish (6)'), 60000);
    await new Promise((r) => setTimeout(r, 1000));
    expect(h.triagePlans(iteration.id)).toHaveLength(0);
    expect(h.ctx.tasks.list({ parentId: iteration.id, statuses: ['proposed'] })).toHaveLength(6);
  }, 120000);

  it('keeps one triage run per objective at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await setup({
      respond: async (req, kind) => {
        if (kind === 'plan' && /Triage/.test(req.prompt)) {
          await gate;
          return { summary: 'nothing needed' };
        }
        return null;
      },
    });
    const obj = h.objective('Racing');
    h.open(obj.id);
    for (const t of FIVE_DEFECTS) h.propose(obj.id, t);
    h.core.orchestrator.resume();
    await waitFor(() => h.triagePlans(obj.id)[0]);
    // More defects arrive while the run is working: they wait for it, no second run starts.
    for (const t of ['Checkpoint is broken', 'Boost pad crashes the script', 'Camera is stuck behind the wall', 'Pit stop never ends', 'Ghost car blocks the start']) h.propose(obj.id, t);
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.triagePlans(obj.id)).toHaveLength(1);
    release();
    await waitFor(() => h.triagePlans(obj.id).length === 2);
    expect(h.triagePlans(obj.id).map((t) => t.title).sort()).toEqual(['Triage defects (5)', 'Triage defects (5)']);
  }, 90000);
});

describe('no proposal is left waiting when an objective closes', () => {
  const reasonOf = (h: Awaited<ReturnType<typeof setup>>, taskId: string) =>
    (h.ctx.audit.timeline({ limit: 500 }).find((e) => e.kind === 'task.status' && e.taskId === taskId && / → cancelled$/.test(e.title))?.detail as { reason?: string } | null)?.reason ?? '';

  it('a quick iteration triages the defect before it closes, and closes the polish proposal with a reason', async () => {
    const added: string[] = [];
    const h = await setup({ respond: triagingPlanner(added) });
    const iteration = h.objective('Quick tweak', ITERATION_REASON);
    const work = h.ctx.tasks.create({ parentId: iteration.id, kind: 'implement', title: 'Tweak', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    for (const s of ['running', 'verifying', 'verified', 'done'] as const) h.ctx.tasks.setStatus(work.id, s);
    h.propose(iteration.id, 'The finish line trigger never fires for the second lap');
    const polish = h.propose(iteration.id, 'A confetti burst would be nice', false);
    h.core.orchestrator.resume();
    const plan = await waitFor(() => h.triagePlans(iteration.id)[0]);
    expect(plan.title).toBe('Triage defects (1)');
    expect(plan.objective).toMatch(/finish line trigger/);
    expect(plan.objective).not.toMatch(/confetti/);
    await waitFor(() => h.ctx.tasks.get(plan.id)!.status === 'done');
    // The task the planner added is built, and then the iteration closes.
    await waitFor(() => h.ctx.tasks.get(iteration.id)!.status === 'done', 60000);
    expect(added).toEqual(['fix_launch']);
    // The polish is not triaged in an iteration, and not left hanging either: closed, with why.
    expect(h.ctx.tasks.get(polish.id)!.status).toBe('cancelled');
    expect(reasonOf(h, polish.id)).toMatch(/^Closed with the quick iteration: optional polish is not part of an iteration/);
    expect(h.ctx.tasks.list({ parentId: iteration.id, statuses: ['proposed'] })).toHaveLength(0);
  }, 90000);

  it('a goal triages what remains at its wrap-up until its polish budget is used, then closes the rest with that reason and finishes', async () => {
    // Every finished task proposes one more improvement, so follow-ups never stop coming by themselves.
    let works = 0;
    let triages = 0;
    const h = await setup({
      respond: async (req, kind, call) => {
        if (kind === 'work') return { status: 'implemented', summary: 'ok', followUps: [`POLISH: ${['brighter headlights on the cars', 'crowd noise near the grandstand', 'skid marks that fade slowly', 'a waving flag at the finish', 'sparks under the cars at night', 'a pit lane sign'][works++] ?? 'more bunting'}`] };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        if (kind !== 'plan' || !/Triage/.test(req.prompt)) return null;
        const ids = [...req.prompt.matchAll(/- \[(task_[0-9a-z]+)\]/g)].map((m) => m[1]!);
        triages++;
        await call('plan_add_task', planArgs(`polish_${triages}`, 'roblox-engineer', [], `Polish pass ${triages}`));
        for (const id of ids) await call('plan_cancel_task', { task: id, reason: 'turned into a task' });
        return { summary: `Polish pass ${triages} added.` };
      },
    });
    const obj = h.objective('Racing');
    h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Cars', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(obj.id)!.status === 'done', 110000);
    // A plan of one task has the smallest budget: two polish tasks, one per pass here. The third proposal is not triaged.
    expect(h.triagePlans(obj.id).map((t) => t.title)).toEqual(['Triage polish (1)', 'Triage polish (1)']);
    const kids = h.ctx.tasks.list({ parentId: obj.id });
    expect(kids.filter((t) => t.status === 'proposed')).toHaveLength(0);
    expect(kids.filter((t) => /^Polish pass/.test(t.title)).map((t) => t.status)).toEqual(['done', 'done']);
    const last = kids.find((t) => /skid marks/.test(t.objective))!;
    expect(last.status).toBe('cancelled');
    expect(reasonOf(h, last.id)).toMatch(/^Closed: this goal's polish budget is used \(2 of 2 tasks; Settings, Agents, "Polish"\)\. Ask the director if you want it done\.$/);
    // The timeline lists what was closed, and the chat says once what happened and where the setting is.
    const ev = h.ctx.audit.timeline({ limit: 500 }).find((e) => e.kind === 'plan.triage' && /^Closed 1 proposed improvement in "Racing": its polish budget is used \(2 of 2 tasks\)/.test(e.title));
    expect((ev?.detail as { proposals: Array<{ text: string }> }).proposals[0]!.text).toMatch(/skid marks/);
    const said = h.core.director.chat()!.list().filter((m) => m.data?.budgetNotice);
    expect(said.map((m) => m.text)).toEqual(['"Racing": the plan had 1 planned task, and 2 more came from improvements the team suggested, which is the limit (2). Further suggestions are now closed, not done, so the goal can finish; you can still read them on the goal. Tell me which ones you want, or raise "Polish" in Settings → Agents.']);
  }, 120000);

  it('with no limit set it is as before: two wrap-up triages, then the rest is closed', async () => {
    let works = 0;
    let triages = 0;
    const h = await setup({
      respond: async (req, kind, call) => {
        if (kind === 'work') return { status: 'implemented', summary: 'ok', followUps: [`POLISH: ${['brighter headlights on the cars', 'crowd noise near the grandstand', 'skid marks that fade slowly'][works++] ?? 'more bunting'}`] };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        if (kind !== 'plan' || !/Triage/.test(req.prompt)) return null;
        const ids = [...req.prompt.matchAll(/- \[(task_[0-9a-z]+)\]/g)].map((m) => m[1]!);
        triages++;
        await call('plan_add_task', planArgs(`polish_${triages}`, 'roblox-engineer', [], `Polish pass ${triages}`));
        for (const id of ids) await call('plan_cancel_task', { task: id, reason: 'turned into a task' });
        return { summary: `Polish pass ${triages} added.` };
      },
    });
    h.core.prefs.set({ polish: 'unlimited' });
    const obj = h.objective('Racing');
    h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Cars', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(obj.id)!.status === 'done', 90000);
    expect(h.triagePlans(obj.id).map((t) => t.title)).toEqual(['Triage follow-ups (1)', 'Triage follow-ups (1)']);
    const last = h.ctx.tasks.list({ parentId: obj.id }).find((t) => /skid marks/.test(t.objective))!;
    expect(last.status).toBe('cancelled');
    expect(reasonOf(h, last.id)).toMatch(/^Closed when the goal finished: it was proposed after the last follow-up triage/);
  }, 120000);

  it('closes what a triage run was shown and did not take up, with a reason', async () => {
    const h = await setup({
      respond: async (req, kind) => (kind === 'plan' && /Triage/.test(req.prompt) ? { summary: 'Nothing here is worth a task.' } : kind === 'work' ? { status: 'implemented', summary: 'ok' } : kind === 'review' ? { verdict: 'pass', summary: 'ok', criteria: [], defects: [] } : null),
    });
    const obj = h.objective('Racing');
    const work = h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Cars', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'test' });
    for (const s of ['running', 'verifying', 'verified', 'done'] as const) h.ctx.tasks.setStatus(work.id, s);
    const idea = h.propose(obj.id, 'A confetti burst would be nice', false);
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(obj.id)!.status === 'done', 60000);
    expect(h.ctx.tasks.get(idea.id)!.status).toBe('cancelled');
    expect(reasonOf(h, idea.id)).toMatch(/^Closed at triage: the planner did not take it up/);
  }, 90000);
});

describe("a goal's follow-ups have a budget (pure)", () => {
  it('is a share of the plan, with a floor, and none at all for polish when polish is off', () => {
    expect(followUpBudget(24, 'standard')).toEqual({ polish: 12, defects: 24 });
    expect(followUpBudget(24, 'light')).toEqual({ polish: 6, defects: 18 });
    expect(followUpBudget(24, 'thorough')).toEqual({ polish: 24, defects: 48 });
    expect(followUpBudget(24, 'none')).toEqual({ polish: 0, defects: 12 });
    expect(followUpBudget(1, 'standard')).toEqual({ polish: 4, defects: 8 });
    expect(followUpBudget(0, 'none')).toEqual({ polish: 0, defects: 6 });
    expect(followUpBudget(24, 'unlimited')).toEqual({ polish: Infinity, defects: Infinity });
    expect(polishLevel('thorough')).toBe('thorough');
    expect(polishLevel(undefined)).toBe('light');
    expect(polishLevel('everything')).toBe('light');
    expect(DEFAULT_APP_PREFS.polish).toBe('light');
  });

  it('counts what a goal was given by whose planner run added it: the two builds this was written after', () => {
    const rows = (plan: number, polish: number, defects: number, wrapUp = 0) => [
      ...Array.from({ length: plan }, () => ({ title: 'Plan: the game' })),
      ...Array.from({ length: polish }, () => ({ title: `${TRIAGE_POLISH_PREFIX} (6)` })),
      ...Array.from({ length: defects }, () => ({ title: `${TRIAGE_DEFECTS_PREFIX} (3)` })),
      ...Array.from({ length: wrapUp }, () => ({ title: 'Triage follow-ups (9)' })),
    ];
    expect(followUpCounts(rows(24, 119, 18))).toEqual({ planned: 24, polish: 119, defects: 18 });
    // A wrap-up triage's tasks are polish.
    expect(followUpCounts(rows(3, 1, 0, 2))).toEqual({ planned: 3, polish: 3, defects: 0 });
    const drone = followUpRoom(followUpCounts(rows(24, 119, 18)), 'standard');
    expect(drone).toMatchObject({ budget: { polish: 12, defects: 24 }, polishLeft: 0, defectsLeft: 6 });
    const pit = followUpRoom(followUpCounts(rows(33, 85, 43)), 'standard');
    expect(pit).toMatchObject({ budget: { polish: 17, defects: 33 }, polishLeft: 0, defectsLeft: 0 });
    expect(followUpRoom(followUpCounts(rows(24, 5, 0)), 'standard').polishLeft).toBe(7);
    expect(followUpRoom(followUpCounts(rows(24, 119, 18)), 'unlimited').polishLeft).toBe(Infinity);
    expect(closedForBudget(false, drone)).toBe('Closed: this goal\'s polish budget is used (119 of 12 tasks; Settings, Agents, "Polish"). Ask the director if you want it done.');
    // The chat's notice in plain, correct words: the Pit build's said "44 tasks have come of defects the team reported,
    // which is the limit for a plan of 34 tasks (17)".
    const over = followUpRoom(followUpCounts(rows(34, 0, 44)), 'none');
    expect(budgetNotice('Hypixel Pit Style Game', true, over)).toBe('"Hypixel Pit Style Game": the team\'s bug reports have already become 44 fix tasks, more than this goal\'s limit of 17. New reports are now closed instead of fixed, so the goal can finish; you can still read them on the goal. Tell me which ones you want fixed, or raise "Polish" in Settings → Agents.');
    const at = followUpRoom(followUpCounts(rows(8, 0, 6)), 'light');
    expect(budgetNotice('Racing', true, at)).toMatch(/^"Racing": the team's bug reports have already become 6 fix tasks, which is this goal's limit \(6, for 8 planned tasks\)\./);
    expect(budgetNotice('Racing', false, drone)).toMatch(/^"Racing": the plan had 24 planned tasks, and 119 more came from improvements the team suggested, more than the limit of 12\./);
    expect(closedForBudget(true, pit)).toMatch(/^Closed: this goal's follow-up fixes are used up \(43 tasks came of reported defects; the limit for a plan of 33 is 33\)/);
    expect(triageKind('Plan: the game')).toBeNull();
  });
});

describe('the budget in a build', () => {
  /** A planner that wants every proposal done: one task per listed proposal. */
  const greedy = (refused: string[]) => async (req: { prompt: string }, kind: string, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>) => {
    if (kind === 'work') return { status: 'implemented', summary: 'ok' };
    if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
    if (kind !== 'plan' || !/Triage/.test(req.prompt)) return null;
    const ids = [...req.prompt.matchAll(/- \[(task_[0-9a-z]+)\]/g)].map((m) => m[1]!);
    for (const [i, id] of ids.entries()) {
      const text = JSON.stringify(await call('plan_add_task', planArgs(`idea_${id.slice(-6)}_${i}`, 'roblox-engineer', [], `Do idea ${i}`)));
      if (/Not added: this goal's polish budget is used/.test(text)) refused.push(text);
    }
    for (const id of ids) await call('plan_cancel_task', { task: id, reason: 'triaged' });
    return { summary: 'Triaged.' };
  };

  it('a planner that wants everything gets what the budget allows, is refused the rest, and later proposals are closed without a planner run', async () => {
    const refused: string[] = [];
    const h = await setup({ respond: greedy(refused) });
    const obj = h.objective('Racing');
    // A plan of two tasks (finished) and one still open: the polish budget is two.
    for (const title of ['Cars', 'Track']) {
      const t = h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title, objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'executive' });
      for (const st of ['running', 'verifying', 'verified', 'done'] as const) h.ctx.tasks.setStatus(t.id, st);
    }
    h.open(obj.id);
    for (let i = 0; i < POLISH_BATCH; i++) h.propose(obj.id, `Add flourish number ${i} to the menu screen`, false);
    h.core.orchestrator.resume();
    const plan = await waitFor(() => h.triagePlans(obj.id)[0]);
    expect(plan.objective).toMatch(/BUDGET: this goal may still get 2 polish tasks, in all/);
    await waitFor(() => h.ctx.tasks.get(plan.id)!.status === 'done', 60000);
    const made = () => h.ctx.tasks.list({ parentId: obj.id }).filter((t) => /^Do idea/.test(t.title));
    expect(made()).toHaveLength(2);
    expect(refused).toHaveLength(POLISH_BATCH - 2);
    expect(refused[0]).toMatch(/polish budget is used \(2 tasks for a plan of 3\)\. Cancel the remaining proposals with plan_cancel_task/);
    expect(h.ctx.tasks.list({ parentId: obj.id, statuses: ['proposed'] })).toHaveLength(0);

    // More proposals: closed with the reason, no planner run, said once in the chat.
    for (let i = 0; i < POLISH_BATCH; i++) h.propose(obj.id, `A different garnish ${i} for the lobby`, false);
    h.core.orchestrator.kick();
    await waitFor(() => h.ctx.tasks.list({ parentId: obj.id, statuses: ['proposed'] }).length === 0, 30000);
    expect(h.triagePlans(obj.id)).toHaveLength(1);
    expect(made()).toHaveLength(2);
    const closed = h.ctx.audit.timeline({ limit: 500 }).filter((e) => e.kind === 'plan.triage' && /^Closed 10 proposed improvements in "Racing": its polish budget is used \(2 of 2 tasks\)/.test(e.title));
    expect(closed).toHaveLength(1);
    for (let i = 0; i < POLISH_BATCH; i++) h.propose(obj.id, `Yet another trim ${i} on the garage`, false);
    h.core.orchestrator.kick();
    await waitFor(() => h.ctx.tasks.list({ parentId: obj.id, statuses: ['proposed'] }).length === 0, 30000);
    expect(h.core.director.chat()!.list().filter((m) => /came from improvements the team suggested/.test(m.text))).toHaveLength(1);

    // Reported defects still become tasks: theirs is another budget.
    for (const t of FIVE_DEFECTS) h.propose(obj.id, t);
    h.core.orchestrator.kick();
    await waitFor(() => h.triagePlans(obj.id).some((t) => t.title === 'Triage defects (5)'), 30000);
  }, 120000);

  it('with polish set to none, proposals are closed and reported defects are still fixed', async () => {
    const refused: string[] = [];
    const h = await setup({ respond: greedy(refused) });
    h.core.prefs.set({ polish: 'none' });
    const obj = h.objective('Racing');
    h.open(obj.id);
    for (let i = 0; i < POLISH_BATCH; i++) h.propose(obj.id, `Add flourish number ${i} to the menu screen`, false);
    for (const t of FIVE_DEFECTS) h.propose(obj.id, t);
    h.core.orchestrator.resume();
    await waitFor(() => h.triagePlans(obj.id).some((t) => t.title === 'Triage defects (5)'), 30000);
    await waitFor(() => h.ctx.tasks.list({ parentId: obj.id, statuses: ['proposed'] }).length === 0, 30000);
    expect(h.triagePlans(obj.id).some((t) => /polish/.test(t.title))).toBe(false);
    expect(h.core.director.chat()!.list().some((m) => /improvements the team suggests are closed, not done, because "Polish" is set to none \(Settings → Agents\)/.test(m.text))).toBe(true);
  }, 90000);
});
