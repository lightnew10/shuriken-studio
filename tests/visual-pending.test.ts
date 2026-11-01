import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/shared/domain';
import type { AgentRunRequest } from '../src/core/providers/types';
import { OUTPUT_SCHEMAS, ROLES, type ReviewOutput } from '../src/core/agents/roles';
import { LOOKS_DIRECTIVE, PENDING_LINE, VISUAL_DONE, VISUAL_PENDING, pendingLooks, pendingSince, readLooks, studioDrawsSince, uncheckedLine } from '../src/core/orchestrator/visual-checks';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * Review without eyes (finding 8 of the first A–Z build): 12 of 38 critic reviews passed with no visual check because
 * Studio wasn't drawing (the user was asleep, the display off). Work is not held up for that. A task that passed
 * without the look it needed is marked "visual check pending"; when Studio draws again one critic run looks at the
 * pending tasks together, before the objective's final regression suite at the latest; and if Studio still can't
 * draw then, the objective closes and the user is told which tasks nobody looked at.
 */
const makeCore = coreHarness();
const passing = { passed: true, results: [], summary: '0 check(s) passed' };
const BLIND = { verdict: 'pass', summary: 'Measured, could not look', criteria: [], defects: [], visualCheck: 'not_possible' };
const SEEN = { verdict: 'pass', summary: 'Looks good', criteria: [], defects: [], visualCheck: 'done' };

const T = (id: string, title: string): Task => ({
  id, parentId: 'obj', kind: 'implement', title, objective: 'x', reason: '', role: 'environment-artist', status: 'done', priority: 50, acceptanceCriteria: [], verification: [], requiredSkills: [],
  requiredKnowledge: [], tools: [], files: [], robloxSystems: [], dependencies: [], attempts: 1, maxAttempts: 3, result: null, failureSummary: null, createdBy: 'test', createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
});

describe('reading a look at several tasks (pure)', () => {
  const tasks = [T('task_a', 'Arena atmosphere'), T('task_b', 'Set pieces'), T('task_c', 'Garage screen')];
  const review = (o: Partial<ReviewOutput>): ReviewOutput => ({ verdict: 'pass', summary: 's', criteria: [], defects: [], ...o });

  it('settles the tasks that look right, lists the problems of those that do not, and leaves the unmentioned pending', () => {
    const looks = readLooks(
      review({
        verdict: 'fail',
        visualCheck: 'done',
        criteria: [
          { criterion: '[task_a] Arena atmosphere', met: true, evidence: 'Warm haze, readable silhouettes' },
          { criterion: '[task_b] Set pieces', met: false, evidence: 'Two containers float above the ground' },
        ],
        defects: [{ severity: 'high', area: 'visual', title: '[task_b] Floating containers', detail: 'Containers at the north gate hover 2 studs up', fix: 'Snap them to the ground' }],
      }),
      tasks,
    );
    expect(looks.notPossible).toBe(false);
    expect(looks.fine).toEqual([{ task: tasks[0], seen: 'Warm haze, readable silhouettes' }]);
    expect(looks.wrong).toHaveLength(1);
    expect(looks.wrong[0]!.task.id).toBe('task_b');
    expect(looks.wrong[0]!.findings).toBe('- Two containers float above the ground\n- [high] Floating containers: Containers at the north gate hover 2 studs up\n  Fix: Snap them to the ground');
    // The garage screen was not looked at: it stays pending.
    expect([...looks.fine.map((x) => x.task.id), ...looks.wrong.map((x) => x.task.id)]).not.toContain('task_c');
  });

  it('is "not possible" when Studio still was not drawing, or the run gave nothing', () => {
    expect(readLooks(review({ visualCheck: 'not_possible' }), tasks)).toEqual({ notPossible: true, fine: [], wrong: [] });
    expect(readLooks(null, tasks)).toEqual({ notPossible: true, fine: [], wrong: [] });
  });

  it('tells the user plainly which tasks nobody looked at', () => {
    expect(uncheckedLine('Mech arena', tasks.slice(0, 2))).toBe(
      'Nobody has looked at 2 tasks of "Mech arena": Studio wasn\'t drawing (minimized, the display off, or its screen capture stopped answering), so their checks passed without a visual review: "Arena atmosphere", "Set pieces". Bring Studio into view and ask me to review how they look.',
    );
    expect(uncheckedLine('Mech arena', tasks.slice(0, 1))).toMatch(/^Nobody has looked at one task of "Mech arena".*so its checks passed without a visual review: "Arena atmosphere"\. Bring Studio into view and ask me to review how it looks\.$/);
  });

  it('asks the reviewer for the structured answer', () => {
    const schema = OUTPUT_SCHEMAS.review as { properties: { visualCheck: { enum: string[] } }; required: string[] };
    expect(schema.properties.visualCheck.enum).toEqual(['done', 'not_needed', 'not_possible']);
    expect(schema.required).not.toContain('visualCheck');
    expect(ROLES.critic!.instructions).toMatch(/set visualCheck to "not_possible" \(the task is then marked "visual check pending"/);
    expect(ROLES.critic!.instructions).toMatch(/never fail the work, or invent a visual defect, because of it/);
    expect(LOOKS_DIRECTIVE).toMatch(/criterion "\[<task id>\] <title>"/);
    expect(LOOKS_DIRECTIVE).toMatch(/visualCheck: "not_possible"/);
  });
});

/** A goal with two art tasks whose reviewer could not look, and one more task that keeps the goal open until released. */
async function harness(review: (req: AgentRunRequest, looking: boolean, n: number) => unknown, opts: { hold?: boolean } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reviews = 0;
  const made = await makeCore({
    respond: async (req, kind) => {
      if (kind === 'work') {
        if (opts.hold && /Match loop/.test(req.prompt)) await gate;
        return { status: 'implemented', summary: /Arena atmosphere/.test(req.prompt) ? 'Lighting and fog set' : 'Built' };
      }
      if (kind === 'review') return review(req, req.prompt.startsWith('Look at the finished work'), ++reviews);
      return null;
    },
  });
  const { core, ctx } = made;
  core.orchestrator.pause();
  ctx.updateSettings({ maxConcurrentAgents: 4 });
  vi.spyOn(core.verifier, 'regression').mockResolvedValue(passing);
  const goal = ctx.tasks.create({ kind: 'objective', title: 'Mech arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const mk = (title: string, role: string) => ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role, status: 'ready', createdBy: 'test', verification: [{ kind: 'critic' }], acceptanceCriteria: ['It looks finished'] });
  const atmosphere = mk('Arena atmosphere', 'environment-artist');
  const pieces = mk('Set pieces', 'level-designer');
  const loop = opts.hold ? mk('Match loop', 'luau-engineer') : null;
  /** As if an agent's roblox_screenshot had just come back with a picture (Studio draws), or with "isn't drawing". */
  const screenshot = (drew: boolean) => {
    const id = ctx.audit.beginToolCall({ runId: null, taskId: null, role: 'roblox-engineer', providerId: 'fake', source: 'agent_mcp', tool: 'roblox_screenshot', capability: 'roblox.screen_capture', args: {} });
    ctx.audit.endToolCall(id, drew ? { status: 'ok', result: 'Screenshot captured', durationMs: 5 } : { status: 'ok', result: { environment: 'studio_not_drawing', visualCheck: 'unavailable' }, durationMs: 5 });
  };
  const studioIsThere = () => ((core.orchestrator as unknown as { canLook: () => boolean }).canLook = () => true);
  const looks = () => made.provider.runs.filter((r) => r.role === 'critic' && r.prompt.startsWith('Look at the finished work'));
  return { ...made, goal, atmosphere, pieces, loop, release, screenshot, studioIsThere, looks };
}

describe('a task that passed without the look it needed', () => {
  it('is marked "visual check pending", and when Studio never draws the goal closes and the user is told which tasks nobody saw', async () => {
    const h = await harness(() => BLIND);
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    // Work was never held up: both tasks are done, and each says on its face that nobody looked.
    for (const t of [h.atmosphere, h.pieces]) {
      const task = h.ctx.tasks.get(t.id)!;
      expect(task.status).toBe('done');
      expect(task.result).toContain(PENDING_LINE);
      expect(h.ctx.tasks.evidence(t.id).some((e) => e.kind === 'note' && e.title === VISUAL_PENDING)).toBe(true);
      expect(pendingSince(h.ctx, t.id)).toBeTruthy();
    }
    expect(h.ctx.audit.timeline({ limit: 200 }).filter((e) => e.kind === 'visual.pending')).toHaveLength(2);
    // Studio isn't even connected here: no look is tried, the goal closes, and the summary and the chat say it plainly.
    expect(h.looks()).toHaveLength(0);
    const summary = h.ctx.tasks.get(h.goal.id)!.result!;
    expect(summary).toMatch(/Visual check pending \(nobody has looked at these: Studio wasn't drawing\):\n- Arena atmosphere\n- Set pieces/);
    const line = 'Nobody has looked at 2 tasks of "Mech arena": Studio wasn\'t drawing (minimized, the display off, or its screen capture stopped answering), so their checks passed without a visual review: "Arena atmosphere", "Set pieces". Bring Studio into view and ask me to review how they look.';
    expect(h.ctx.audit.timeline({ limit: 200 }).find((e) => e.kind === 'visual.unchecked')?.title).toBe(line);
    const chat = h.core.director.chat()!.list().map((m) => m.text);
    expect(chat).toContain(line);
    // It comes before the "is built" message, not after the user has stopped reading.
    expect(chat.indexOf(line)).toBeLessThan(chat.findIndex((t) => /is built and verified/.test(t)));
  }, 90000);

  it('is not marked when the reviewer did look, or when nothing in the task has a look', async () => {
    const h = await harness((_req, _looking, n) => (n === 1 ? SEEN : { ...SEEN, visualCheck: 'not_needed' }));
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    expect(pendingLooks(h.ctx, h.goal.id)).toEqual([]);
    expect(h.ctx.tasks.get(h.atmosphere.id)!.result).not.toContain(VISUAL_PENDING);
    expect(h.ctx.tasks.get(h.goal.id)!.result).not.toContain(VISUAL_PENDING);
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'visual.unchecked')).toBe(false);
  }, 90000);

  it('is marked from the evidence alone when the reviewer says nothing: a screenshot that said Studio isn\'t drawing and no picture since', async () => {
    const h = await harness(() => ({ verdict: 'pass', summary: 'ok', criteria: [], defects: [] }));
    // The reviewer of the atmosphere task asked for a screenshot and got "Studio isn't drawing"; the other never asked.
    const original = h.core.runner.run.bind(h.core.runner);
    vi.spyOn(h.core.runner, 'run').mockImplementation(async (spec) => {
      const outcome = await original(spec);
      if (spec.role.id === 'critic' && spec.task?.id === h.atmosphere.id) {
        const id = h.ctx.audit.beginToolCall({ runId: outcome.run.id, taskId: spec.task.id, role: 'critic', providerId: 'fake', source: 'agent_mcp', tool: 'roblox_screenshot', capability: 'roblox.screen_capture', args: {} });
        h.ctx.audit.endToolCall(id, { status: 'ok', result: { environment: 'studio_not_drawing', visualCheck: 'unavailable' }, durationMs: 5 });
      }
      return outcome;
    });
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    expect(pendingLooks(h.ctx, h.goal.id).map((t) => t.title)).toEqual(['Arena atmosphere']);
  }, 90000);
});

describe('when Studio can draw again', () => {
  it('one critic run looks at the pending tasks together as soon as a screenshot comes back with a picture', async () => {
    const h = await harness(
      (req, looking, n) => {
        // The two art tasks are reviewed blind; by the time the match loop is reviewed Studio draws.
        if (!looking) return n <= 2 ? BLIND : SEEN;
        const ids = [...req.prompt.matchAll(/- \[(task_[0-9a-z]+)\]/g)].map((m) => m[1]!);
        return { verdict: 'pass', summary: 'Both look right', defects: [], visualCheck: 'done', criteria: ids.map((id) => ({ criterion: `[${id}] looks`, met: true, evidence: 'Readable, lit, dressed' })) };
      },
      { hold: true },
    );
    h.studioIsThere();
    h.core.orchestrator.resume();
    await waitFor(() => pendingLooks(h.ctx, h.goal.id).length === 2, 60000);
    // Studio is still dark (the last screenshot said so): nobody is sent to look.
    h.screenshot(false);
    h.core.orchestrator.kick();
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.looks()).toHaveLength(0);
    expect(studioDrawsSince(h.ctx, pendingSince(h.ctx, h.atmosphere.id)!)).toBe(false);
    // A screenshot comes back with a picture: one critic run for both tasks, while the build goes on.
    h.screenshot(true);
    h.core.orchestrator.kick();
    await waitFor(() => pendingLooks(h.ctx, h.goal.id).length === 0, 30000);
    expect(h.looks()).toHaveLength(1);
    const look = h.looks()[0]!;
    expect(look.prompt).toContain(`[${h.atmosphere.id}] Arena atmosphere (Environment artist)`);
    expect(look.prompt).toContain(`[${h.pieces.id}] Set pieces`);
    expect(look.prompt).toContain('What was built: Lighting and fog set');
    expect(look.prompt).toContain('Criterion: It looks finished');
    expect(h.ctx.tasks.get(h.loop!.id)!.status).toBe('running');
    for (const t of [h.atmosphere, h.pieces]) {
      expect(h.ctx.tasks.evidence(t.id).find((e) => e.title === VISUAL_DONE)).toMatchObject({ passed: true, data: { seen: 'Readable, lit, dressed' } });
      expect(h.ctx.tasks.get(t.id)!.result).toContain('Visual check done: Readable, lit, dressed');
      expect(h.ctx.tasks.get(t.id)!.result).not.toContain(PENDING_LINE);
    }
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'visual.reviewed' && /Looked at 2 tasks of "Mech arena" that had passed unseen: all look right/.test(e.title))).toBe(true);
    // The goal finishes without anything left unseen.
    h.release();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 60000);
    expect(h.looks()).toHaveLength(1);
    expect(h.ctx.tasks.get(h.goal.id)!.result).not.toContain(VISUAL_PENDING);
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'visual.unchecked')).toBe(false);
  }, 120000);

  it('at the latest the wrap-up looks before the final suite, and what looks wrong gets a fix task the goal waits for', async () => {
    const order: string[] = [];
    const h = await harness((req, looking, n) => {
      if (!looking) return n <= 2 ? BLIND : SEEN;
      order.push('look');
      const [a, b] = [...req.prompt.matchAll(/- \[(task_[0-9a-z]+)\]/g)].map((m) => m[1]!);
      return {
        verdict: 'fail',
        summary: 'The set pieces float',
        visualCheck: 'done',
        criteria: [{ criterion: `[${a}] atmosphere`, met: true, evidence: 'Warm haze' }, { criterion: `[${b}] set pieces`, met: false, evidence: 'Two containers float above the ground' }],
        defects: [{ severity: 'high', area: 'visual', title: `[${b}] Floating containers`, detail: 'They hover 2 studs up', fix: 'Snap them to the ground' }],
      };
    });
    vi.mocked(h.core.verifier.regression).mockImplementation(async () => {
      order.push('suite');
      return passing;
    });
    h.studioIsThere();
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 90000);
    // No screenshot ever said Studio draws, so the look happened at the wrap-up: before the suite, once.
    expect(order).toEqual(['look', 'suite']);
    const fix = h.ctx.tasks.list({ parentId: h.goal.id }).find((t) => t.title === 'Fix the look of "Set pieces"')!;
    expect(fix).toMatchObject({ role: 'level-designer', status: 'done', createdBy: 'critic' });
    expect(fix.objective).toContain('Two containers float above the ground');
    expect(fix.objective).toContain('Fix: Snap them to the ground');
    expect(h.ctx.tasks.evidence(h.pieces.id).find((e) => e.title === VISUAL_DONE)).toMatchObject({ passed: false });
    expect(h.ctx.tasks.get(h.pieces.id)!.result).toContain('Visual check done: it had visual problems, fixed by a follow-up task.');
    expect(h.ctx.tasks.get(h.atmosphere.id)!.result).toContain('Visual check done: Warm haze');
    expect(h.ctx.tasks.get(h.goal.id)!.result).not.toContain(VISUAL_PENDING);
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'visual.unchecked')).toBe(false);
  }, 120000);

  it('if Studio still cannot draw at the wrap-up, the goal closes after one try and says which tasks nobody saw', async () => {
    const h = await harness(() => BLIND);
    h.studioIsThere();
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(h.goal.id)!.status === 'done', 90000);
    expect(h.looks()).toHaveLength(1);
    expect(h.ctx.tasks.get(h.goal.id)!.result).toMatch(/Visual check pending \(nobody has looked at these/);
    expect(h.ctx.audit.timeline({ limit: 200 }).some((e) => e.kind === 'visual.pending' && /Studio still isn't drawing: 2 tasks of "Mech arena" wait for a look/.test(e.title))).toBe(true);
    expect(h.core.director.chat()!.list().some((m) => /^Nobody has looked at 2 tasks of "Mech arena"/.test(m.text))).toBe(true);
  }, 120000);
});
