import { describe, expect, it } from 'vitest';
import type { Escalation, Task, TaskEvidence, TimelineEvent } from '../src/shared/domain';
import { EventBus } from '../src/core/events';
import { ChatService } from '../src/core/director/chat-service';
import { titleFromPrompt } from '../src/core/director/director';
import { DIGEST, Narrator, activeMs, checkWords, deviceSensitive, reviewPoint, sendBackLine, statusChanges, timelineLine } from '../src/core/director/narration';
import { PlainWords, type PlainWordsLike } from '../src/core/director/plain-words';
import { nextMilestoneTitle } from '../src/core/orchestrator/autonomy';
import { RETIRED_BY_QUARANTINE, TestService } from '../src/core/verification/test-service';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * The chat's story of a build (director/narration.ts), from audits of the user's projects: 208 "Done:" lines and 39
 * "Another pass" lines in one, ~31 triage plan cards, cards overwritten by another planning run or stuck at "Updating
 * the plan…", "checks and review passed" where no review ran, "built and verified" with failing checks set aside,
 * durations across a night's pause, phone controls "passed" from Studio alone, and goal titles from the user's filler.
 */
const MIN = 60_000;
const ev = (ts: number, title: string, kind = 'task.status'): TimelineEvent => ({ id: `e${ts}`, ts: new Date(ts).toISOString(), kind, severity: 'info', title, detail: null, runId: null, taskId: 't', role: null });
const evidence = (kind: TaskEvidence['kind'], passed: boolean | null, at: number): TaskEvidence => ({ id: `v${at}${kind}`, taskId: 't', runId: 'r', kind, title: kind, passed, data: null, path: null, createdAt: new Date(at).toISOString() });

describe('what a finished task says', () => {
  it('counts the time it was worked on, not the time it waited, was paused or sat overnight', () => {
    const t0 = Date.parse('2026-10-05T20:00:00Z');
    const changes = statusChanges([
      ev(t0, 'Bow: ready → running'),
      ev(t0 + 10 * MIN, 'Bow: running → paused'),
      // Paused overnight: 15 hours.
      ev(t0 + 15 * 60 * MIN, 'Bow: paused → ready'),
      ev(t0 + 15 * 60 * MIN + 5 * MIN, 'Bow: ready → running'),
      ev(t0 + 15 * 60 * MIN + 12 * MIN, 'Bow: running → implemented'),
      ev(t0 + 15 * 60 * MIN + 13 * MIN, 'Bow: implemented → verifying'),
      ev(t0 + 15 * 60 * MIN + 16 * MIN, 'Bow: verifying → reviewing'),
      ev(t0 + 15 * 60 * MIN + 20 * MIN, 'Bow: reviewing → verified'),
      ev(t0 + 15 * 60 * MIN + 21 * MIN, 'Bow: verified → done'),
    ]);
    expect(activeMs(changes, t0 + 15 * 60 * MIN + 21 * MIN)! / MIN).toBe(26);
    expect(activeMs([], Date.now())).toBeNull();
  });

  it('says whether a review ran: a review skipped is not "checks and review passed"', () => {
    const t0 = 1_000_000;
    const changes = statusChanges([ev(t0, 'X: running → implemented'), ev(t0 + 1000, 'X: implemented → verifying'), ev(t0 + 5000, 'X: verifying → reviewing')]);
    const checks = [evidence('static_analysis', true, t0 + 2000), evidence('console', true, t0 + 3000)];
    const skipped = [ev(t0 + 5000, '"X": a small code fix proven by a playtest', 'review.skipped')];
    expect(checkWords({ kind: 'implement' }, checks, skipped, changes)).toBe('checks passed, review skipped');
    expect(checkWords({ kind: 'implement' }, [...checks, evidence('critic_review', true, t0 + 9000)], [], changes)).toBe('checks and review passed');
    expect(checkWords({ kind: 'implement' }, [evidence('critic_review', true, t0 + 9000)], [], changes)).toBe('review passed, no automated checks');
    // Evidence from before this attempt's checks doesn't count for them.
    expect(checkWords({ kind: 'implement' }, [evidence('console', true, t0 - 1), evidence('critic_review', true, t0 + 9000)], [], changes)).toBe('review passed, no automated checks');
    expect(checkWords({ kind: 'research' }, [], [], changes)).toBeNull();
    // A static analysis that answered for none of the task's files (it changed none) checked nothing of it.
    const blind = { ...evidence('static_analysis', true, t0 + 2000), data: { files: 0 } };
    expect(checkWords({ kind: 'implement' }, [blind, evidence('critic_review', true, t0 + 9000)], [], changes)).toBe('review passed, no automated checks');
  });

  it('knows what a playtest in Studio on a PC does not show: phones, touch, tablets, gamepads, feel', () => {
    expect(deviceSensitive({ title: 'Touch bow on phones: the reticle stays on the crosshair', acceptanceCriteria: [] })).toBe(true);
    expect(deviceSensitive({ title: 'Combat polish', acceptanceCriteria: ['A gamepad can swing with R2'] })).toBe(true);
    expect(deviceSensitive({ title: 'Combat polish', acceptanceCriteria: ['The swing feels snappy'] })).toBe(true);
    expect(deviceSensitive({ title: 'Lobby lighting', acceptanceCriteria: ['No errors in the console'] })).toBe(false);
  });

  it("names a rejected review's failing point, not its first sentence", () => {
    const review = {
      criteria: [{ criterion: 'The bow aims where the reticle is', met: false, evidence: 'off by 30 px' }],
      defects: [
        { severity: 'low' as const, area: 'ux', title: 'Label is a bit small', detail: 'x', fix: 'y' },
        { severity: 'high' as const, area: 'correctness', title: 'Arrows land right of the reticle on touch', detail: 'Measured 34 px.', fix: 'z' },
      ],
    };
    expect(sendBackLine('Touch bow', 'Critic rejected: Most of this works and looks good. But…', { review })).toBe('Another pass for Touch bow: the reviewer found "Arrows land right of the reticle on touch".');
    expect(reviewPoint({ defects: [], criteria: review.criteria })).toBe('not met yet: "The bow aims where the reticle is"');
    expect(sendBackLine('Swords', "Orchestrator error: Cannot read properties of undefined (reading 'slice')")).toBe('Another try for Swords: something inside Shuriken went wrong (a bug in Shuriken).');
    // What the user's chat already said stays as it was.
    expect(sendBackLine('Lobby', 'Critic rejected: The plaza reads as a blockout. Add props.')).toBe('Another pass for Lobby. The reviewer: The plaza reads as a blockout.');
  });
});

const makeCore = coreHarness();

async function setup() {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const chat = h.core.director.chat()!;
  const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Hypixel Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
  /** A task taken through its statuses as the orchestrator would (each change is a task.updated the chat hears). */
  const walk = (t: Task, ...to: Task['status'][]) => {
    for (const s of to) h.ctx.tasks.setStatus(t.id, s, 'test');
    return h.ctx.tasks.get(t.id)!;
  };
  const task = (title: string, extra: Partial<Parameters<typeof h.ctx.tasks.create>[0]> = {}) => h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'executive', acceptanceCriteria: ['works'], ...extra });
  const passWith = (t: Task, review = true) => {
    walk(t, 'running', 'implemented', 'verifying');
    h.ctx.tasks.addEvidence({ taskId: t.id, runId: null, kind: 'static_analysis', title: 'Static analysis', passed: true, data: null, path: null });
    walk(t, 'reviewing');
    if (review) h.ctx.tasks.addEvidence({ taskId: t.id, runId: null, kind: 'critic_review', title: 'Critic: PASS', passed: true, data: null, path: null });
    else h.ctx.audit.event({ kind: 'review.skipped', title: `"${t.title}": small fix proven by a playtest`, taskId: t.id });
    return walk(t, 'verified', 'done');
  };
  const digests = () => chat.list().filter((m) => m.data?.digest === true);
  const items = () => digests().flatMap((m) => m.data!.items as Array<{ kind: string; text: string; taskId?: string; passes?: number }>);
  return { ...h, chat, goal, walk, task, passWith, digests, items };
}

describe('the progress message', () => {
  it('gathers finished tasks and send-backs in one message updated in place, then starts a new one', async () => {
    const h = await setup();
    const a = h.passWith(h.task('Kill feed on the phone HUD'));
    const b = h.task('Combat polish');
    h.walk(b, 'running', 'implemented', 'verifying', 'reviewing');
    h.ctx.tasks.addEvidence({ taskId: b.id, runId: null, kind: 'critic_review', title: 'Critic: FAIL', passed: false, data: { verdict: 'fail', summary: 'Most of this works.', criteria: [], defects: [{ severity: 'high', area: 'visual', title: 'Hit sparks spawn at the feet', detail: 'd', fix: 'f' }] }, path: null });
    h.ctx.tasks.addFailure({ taskId: b.id, runId: null, attempt: 1, stage: 'review', summary: 'Critic rejected: Most of this works.', detail: null });
    h.walk(b, 'failed');
    const light = h.passWith(h.task('Fix the hit sound volume'), false);
    expect(h.digests()).toHaveLength(1);
    expect(h.items().map((i) => i.text)).toEqual([
      expect.stringMatching(/^Done: Kill feed on the phone HUD \(\d+ min of work; checks and review passed; not checked on a real device\)\.$/),
      'Another pass for Combat polish: the reviewer found "Hit sparks spawn at the feet".',
      expect.stringMatching(/^Done: Fix the hit sound volume \(\d+ min of work; checks passed, review skipped\)\.$/),
    ]);
    expect(h.items().map((i) => i.taskId)).toEqual([a.id, b.id, light.id]);
    // The send-back's task finishing replaces its line, in the same message.
    h.walk(b, 'ready');
    h.passWith(h.ctx.tasks.get(b.id)!);
    expect(h.digests()).toHaveLength(1);
    expect(h.items().find((i) => i.taskId === b.id)).toMatchObject({ kind: 'done', passes: 1 });
    expect(h.items()).toHaveLength(3);
    // Something the user says comes between: the next lines start a new message below it.
    h.chat.add({ role: 'user', kind: 'text', text: 'how is it going?' });
    h.passWith(h.task('Daily reward shrine'));
    expect(h.digests()).toHaveLength(2);
    // And so does time: a message takes lines for a few minutes.
    const window = DIGEST.windowMs;
    DIGEST.windowMs = -1;
    try {
      h.passWith(h.task('Storage chest'));
    } finally {
      DIGEST.windowMs = window;
    }
    expect(h.digests()).toHaveLength(3);
    // No line of its own any more for a finished task.
    expect(h.chat.list().filter((m) => m.kind === 'status' && !m.data?.digest && /^(Done|Another pass)/.test(m.text))).toHaveLength(0);
  });

  it('folds a triage run into one line, and makes no plan card for it', async () => {
    const h = await setup();
    const plan = h.ctx.tasks.create({ parentId: h.goal.id, kind: 'plan', title: 'Triage defects (3)', objective: '- [task_a] one\n- [task_b] two\n- [task_c] three', role: 'executive', status: 'ready', createdBy: 'executive' });
    h.walk(plan, 'running');
    h.core.bus.emit('plan.updated', { objectiveId: h.goal.id, planTaskId: plan.id, status: 'planning' });
    for (const id of ['task_x', 'task_y']) {
      const call = h.ctx.audit.beginToolCall({ runId: 'run_t', taskId: plan.id, role: 'executive', providerId: 'fake', source: 'agent_mcp', tool: 'plan_add_task', capability: 'app.tasks', args: {} });
      h.ctx.audit.endToolCall(call, { status: 'ok', result: { id, key: id, starts: 'now' }, durationMs: 1 });
    }
    h.walk(plan, 'done');
    h.core.bus.emit('plan.updated', { objectiveId: h.goal.id, planTaskId: plan.id, status: 'done', summary: 'I turned the three reports into two fixes.', tasks: 2 });
    expect(h.items()).toEqual([expect.objectContaining({ kind: 'triage', text: '3 reported problems looked at: 2 became tasks.' })]);
    expect(h.chat.list().filter((m) => m.kind === 'plan')).toHaveLength(0);
  });
});

describe('plan cards', () => {
  it('one card per planning run, finished by that run: never another run\'s plan, never left "Updating the plan…"', async () => {
    const h = await setup();
    const cards = () => h.chat.list().filter((m) => m.kind === 'plan');
    const update = h.ctx.tasks.create({ parentId: h.goal.id, kind: 'plan', title: 'Update plan: add a shop', objective: 'x', role: 'executive', status: 'ready', createdBy: 'user' });
    // The director's "planning" right after amendPlan names no run: it is this update's.
    h.core.bus.emit('plan.updated', { objectiveId: h.goal.id, planTaskId: '', status: 'planning' });
    expect(cards().map((c) => [c.text, c.data?.planTaskId])).toEqual([['Updating the plan…', update.id]]);
    const next = h.ctx.tasks.create({ parentId: h.goal.id, kind: 'plan', title: 'Plan: next part', objective: 'x', role: 'executive', status: 'ready', createdBy: 'executive' });
    h.walk(update, 'running');
    h.core.bus.emit('plan.updated', { objectiveId: h.goal.id, planTaskId: update.id, status: 'planning' });
    h.walk(next, 'running');
    h.core.bus.emit('plan.updated', { objectiveId: h.goal.id, planTaskId: next.id, status: 'planning' });
    expect(cards()).toHaveLength(2);
    // The later run finishes first: its own card says its plan, with its own tasks.
    const call = h.ctx.audit.beginToolCall({ runId: 'run_p', taskId: next.id, role: 'executive', providerId: 'fake', source: 'agent_mcp', tool: 'plan_add_task', capability: 'app.tasks', args: {} });
    h.ctx.audit.endToolCall(call, { status: 'ok', result: { id: 'task_new', key: 'k', starts: 'now' }, durationMs: 1 });
    h.ctx.tasks.update(next.id, { result: 'Three tasks for the arena (1 tasks)' });
    h.walk(next, 'done');
    h.core.bus.emit('plan.updated', { objectiveId: h.goal.id, planTaskId: next.id, status: 'done', summary: 'The arena gets a shop and a leaderboard.', tasks: 1 });
    const byRun = (id: string) => cards().find((c) => c.data?.planTaskId === id)!;
    expect(byRun(next.id)).toMatchObject({ text: 'The arena gets a shop and a leaderboard.', data: { status: 'done', taskIds: ['task_new'] } });
    expect(byRun(update.id)).toMatchObject({ text: 'Updating the plan…', data: { status: 'planning' } });
    // The update ends without a plan (stuck, waiting for a decision): its own card says so.
    h.walk(update, 'escalated');
    expect(byRun(update.id)).toMatchObject({ text: 'Planning stopped without a plan: it needs a decision first.', data: { status: 'failed' } });
    expect(byRun(next.id).text).toBe('The arena gets a shop and a leaderboard.');
  });

  it('settles the cards a closed session left planning when the project opens', async () => {
    const h = await setup();
    // Older builds: a card with no run that nothing will ever finish, and one whose run ended while nobody listened.
    const stuck = h.chat.add({ role: 'director', kind: 'plan', text: 'Updating the plan…', data: { objectiveId: h.goal.id, status: 'planning' } });
    const plan = h.ctx.tasks.create({ parentId: h.goal.id, kind: 'plan', title: 'Update plan: drop the hint card', objective: 'x', role: 'executive', status: 'ready', createdBy: 'user' });
    const card = h.chat.add({ role: 'director', kind: 'plan', text: 'Updating the plan…', data: { objectiveId: h.goal.id, planTaskId: plan.id, status: 'planning' } });
    h.ctx.store.run("UPDATE tasks SET status = 'cancelled' WHERE id = ?", [plan.id]);
    h.core.bus.emit('project.changed', { projectId: h.ctx.summary.id });
    expect(h.chat.get(stuck.id)).toMatchObject({ text: 'This planning run ended without a report.', data: { status: 'ended' } });
    expect(h.chat.get(card.id)).toMatchObject({ text: 'The plan update was cancelled.', data: { status: 'cancelled' } });
    // Interrupted (the app closed while it planned): it says it carries on.
    const later = h.ctx.tasks.create({ parentId: h.goal.id, kind: 'plan', title: 'Update plan: night mode', objective: 'x', role: 'executive', status: 'ready', createdBy: 'user' });
    const open = h.chat.add({ role: 'director', kind: 'plan', text: 'Updating the plan…', data: { objectiveId: h.goal.id, planTaskId: later.id, status: 'planning' } });
    h.core.bus.emit('project.changed', { projectId: h.ctx.summary.id });
    expect(h.chat.get(open.id)).toMatchObject({ text: 'Planning was interrupted; it carries on when work resumes.', data: { status: 'paused' } });
  });

  it('names a "next milestone" goal after the milestone its plan chose, and never nests the title', async () => {
    expect(nextMilestoneTitle('Hypixel Pit Style Game')).toBe('Next milestone after "Hypixel Pit Style Game"');
    expect(nextMilestoneTitle('Next milestone after "Next milestone after "Hypixel Pit""')).toBe('Next milestone after "Hypixel Pit"');
    const h = await setup();
    const goal = h.ctx.tasks.create({ kind: 'objective', title: nextMilestoneTitle('Hypixel Pit'), objective: 'Plan and execute the NEXT milestone of this project from the roadmap.', role: 'executive', status: 'running', createdBy: 'user' });
    const plan = h.ctx.tasks.create({ parentId: goal.id, kind: 'plan', title: `Plan: ${goal.title}`, objective: 'x', role: 'executive', status: 'running', createdBy: 'executive' });
    h.core.bus.emit('plan.updated', { objectiveId: goal.id, planTaskId: plan.id, status: 'done', summary: 'Next up is the Valor shop.', milestone: 'Valor shop: permanent upgrades bought with Valor at a new lobby altar', tasks: 0 });
    expect(h.ctx.tasks.get(goal.id)!.title).toBe('Valor shop');
  });
});

describe('a finished goal', () => {
  it('says "built; N checks still failing" when its wrap-up set failing checks aside, and "built and verified" only when none was', async () => {
    const h = await setup();
    h.passWith(h.task('Shop'));
    const tests = new TestService(h.ctx.store);
    const t = tests.register({ name: 'wkgkeby6:luau_assert:perk_tutorial_gone', method: { kind: 'luau_assert', name: 'perk_tutorial_gone', luau: 'return "PASS"', datamodel: 'edit' }, taskId: null });
    tests.retire(t.id, 'Still failing after its repair task: quarantined', RETIRED_BY_QUARANTINE);
    h.walk(h.goal, 'verifying', 'verified', 'done');
    const done = h.chat.list().find((m) => m.kind === 'done')!;
    expect(done.text).toMatch(/^\*\*Hypixel Pit\*\* is built; 1 check is still failing \("perk tutorial gone"\)\. It was set aside after a repair didn't fix it, so the goal could finish; 1 task passed its checks\./);
    expect(done.text).not.toMatch(/verified/);
    expect(done.data).toMatchObject({ failing: 1 });
    // Another goal, nothing set aside since it began: built and verified.
    const other = h.ctx.tasks.create({ kind: 'objective', title: 'Valor shop', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    h.walk(other, 'verifying', 'verified', 'done');
    expect(h.chat.list().find((m) => m.kind === 'done' && m.data?.objectiveId === other.id)!.text).toBe('**Valor shop** is built and verified — 0 tasks passed their checks. Tell me what to add or change next.');
  });
});

describe('plain words in the chat', () => {
  const esc = (over: Partial<Escalation> = {}): Escalation => ({
    id: 'esc_01m482s1kzcxyqhgfqn2g76vp4',
    taskId: null,
    runId: null,
    kind: 'question',
    title: 'Critic rejected the store-art carve-out: need a route to upload 19 PNGs (task_01m41d2h33abcdefgh)',
    detail: 'Following your earlier answer (esc_01m482s1kzcxyqhgfqn2g76vp4, option B), I left the 15 store card ART ids in src/Shared/Store.luau.\n\nMore detail for the team.',
    options: ['B: keep the old ART ids, report the missing group image uploader', 'retry'],
    status: 'open',
    response: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...over,
  });

  it('a question card shows plain words and button labels; the team keeps its own words in the detail, and an answer still sends the option', async () => {
    const h = await setup();
    const bus = new EventBus();
    const asked: string[] = [];
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const words: PlainWordsLike = {
      card: async (_p, e) => {
        asked.push(e.title);
        await answered;
        return { title: 'Store pictures need uploading to your group', text: 'No tool can upload them as the group yet.', labels: ['Keep the old pictures for now', 'Try again'] };
      },
      line: async () => null,
      title: async () => null,
    };
    new Narrator({ project: () => h.ctx, bus, log: h.core.log, plainWords: words }).wire();
    bus.emit('escalation.updated', esc());
    const card = new ChatService(h.ctx, bus).findLatest('question', (d) => d.escalationId === 'esc_01m482s1kzcxyqhgfqn2g76vp4')!;
    expect(card.text).toBe('Critic rejected the store-art carve-out: need a route to upload 19 PNGs\n\nFollowing your earlier answer (option B), I left the 15 store card ART ids in the Store module.');
    expect(card.data).toMatchObject({ options: ['B: keep the old ART ids, report the missing group image uploader', 'retry'], labels: ['Keep the old ART ids, report the missing group image uploader', 'Try again'] });
    expect(card.data!.technical).toMatch(/esc_01m482s1kzcxyqhgfqn2g76vp4, option B/);
    // The fast model's rewrite replaces the rules' words when it comes.
    release();
    await waitFor(() => new ChatService(h.ctx, bus).get(card.id)?.data?.plain === 'model');
    expect(new ChatService(h.ctx, bus).get(card.id)).toMatchObject({ text: 'Store pictures need uploading to your group\n\nNo tool can upload them as the group yet.', data: { labels: ['Keep the old pictures for now', 'Try again'], options: ['B: keep the old ART ids, report the missing group image uploader', 'retry'] } });
    expect(asked).toHaveLength(1);
  });

  it('a decision made without asking is a plain status line', async () => {
    const h = await setup();
    const bus = new EventBus();
    new Narrator({ project: () => h.ctx, bus, log: h.core.log }).wire();
    bus.emit('escalation.updated', esc({ status: 'auto_resolved', title: 'Push PitUI.client.luau while the Store task holds it?', response: 'Yes: roblox_sync_push it now.' }));
    const line = new ChatService(h.ctx, bus).findLatest('status', (d) => d.escalationId === 'esc_01m482s1kzcxyqhgfqn2g76vp4')!;
    expect(line.text).toBe('Decided without asking you: Push the PitUI client script while the Store task holds it? Yes: the code sync it now.');
    expect(line.data?.technical).toMatch(/PitUI\.client\.luau/);
  });

  it('raw errors become one plain sentence, with the technical text kept', async () => {
    const h = await setup();
    const m = h.chat.add({ role: 'director', kind: 'error', text: "Something went wrong reading your message: Cannot read properties of undefined (reading 'slice')" });
    expect(m.text).toBe('Something went wrong reading your message: something inside Shuriken went wrong (a bug in Shuriken).');
    expect(m.data?.technical).toMatch(/reading 'slice'/);
    expect(timelineLine({ kind: 'provider.environment', title: "Agents can't start right now; retrying automatically. Claude Code native binary not found at C:\\Users\\x\\claude.exe", detail: { error: 'Claude Code native binary not found at C:\\Users\\x\\claude.exe' } })).toBe("Agents can't start right now (the Claude Code program couldn't be found on this PC); retrying automatically.");
    // A plain line stays exactly as it is.
    const plain = h.chat.add({ role: 'director', kind: 'error', text: 'Your Claude account is at its usage limit until about 3 PM, so I can\'t answer yet.' });
    expect(plain.text).toBe('Your Claude account is at its usage limit until about 3 PM, so I can\'t answer yet.');
    expect(plain.data).toBeNull();
  });

  it("the fast model's answers go through the rules again, and a broken answer is not used", async () => {
    const h = await setup();
    let answer: unknown = null;
    const asked: string[] = [];
    const runner = { quick: async (spec: { role: { id: string }; prompt: string }) => (asked.push(`${spec.role.id}: ${spec.prompt.split('\n')[0]}`), answer === null ? null : { structured: answer, costUsd: 0.001 }) };
    const words = new PlainWords({ runner: runner as never, log: h.core.log, enabled: () => true });
    const e = { title: 'roblox_status lists two Studio instances', detail: 'ids d93090f8…', options: ['retry', 'cancel'] };
    answer = { title: 'Two Studio windows are open (task_01m41d2h33abcdefgh)', text: 'Close one in C:\\Users\\x\\place.rbxl.', options: ['Try again'] };
    // A label for every option or none of the model's: a button must say what it sends.
    expect(await words.card(h.ctx, e)).toEqual({ title: 'Two Studio windows are open', text: 'Close one in place.rbxl.', labels: ['Try again', 'Cancel it'] });
    answer = { title: 'Ugh the group rewards label' };
    expect(await words.title(h.ctx, 'ugh the group rewards label is glitching')).toBeNull();
    answer = { title: 'Fix the group rewards sign, now with sparkles and much more' };
    expect(await words.title(h.ctx, 'ugh the group rewards label is glitching')).toBe('Fix the group rewards sign, now');
    expect(asked.every((a) => a.startsWith('plain-words: '))).toBe(true);
    // Where no model may be called, nothing is asked.
    const off = new PlainWords({ runner: runner as never, log: h.core.log, enabled: () => false });
    const n = asked.length;
    expect(await off.line(h.ctx, 'x')).toBeNull();
    expect(asked).toHaveLength(n);
  });

  it("a goal named from the user's own words gets a real title from the fast model (not the game's first goal)", async () => {
    const h = await setup();
    const bus = new EventBus();
    const words: PlainWordsLike = { card: async () => null, line: async () => null, title: async () => 'Fix the group rewards sign' };
    new Narrator({ project: () => h.ctx, bus, log: h.core.log, plainWords: words, heuristicTitle: titleFromPrompt }).wire();
    const request = 'ugh the group rewards label is glitching out, get that fixed up';
    const change = h.ctx.tasks.create({ kind: 'objective', title: titleFromPrompt(request), objective: request, role: 'executive', status: 'running', createdBy: 'director' });
    expect(change.title).not.toMatch(/^ugh/i);
    bus.emit('task.updated', change);
    await waitFor(() => h.ctx.tasks.get(change.id)!.title === 'Fix the group rewards sign');
    // A title the director gave is left alone, and so is the game's own first goal.
    const given = h.ctx.tasks.create({ kind: 'objective', title: 'Daily reward streaks', objective: request, role: 'executive', status: 'running', createdBy: 'director' });
    bus.emit('task.updated', given);
    bus.emit('task.updated', h.goal);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.ctx.tasks.get(given.id)!.title).toBe('Daily reward streaks');
    expect(h.ctx.tasks.get(h.goal.id)!.title).toBe('Hypixel Pit');
  });
});
