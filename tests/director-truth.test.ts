import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core';
import type { AgentRunRequest } from '../src/core/providers/types';
import { askedAgentLimit, asksResume, asksResumeAfterPlan, asksVerbatim, asksWrapUp, dropRepeats, reconcileRunState, saysStopped, statesPreference } from '../src/core/director/commands';
import { PLANNER_NOTES_FILE } from '../src/core/orchestrator/planner-notes';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * The director, audited across six projects (2026-10-02 to 10-07): "the team is still stopped" in 16 replies while the
 * same second's status line said it was running again; actions claimed that never happened; a "verbatim" message sent to
 * the planner cut mid-word; contradicting replies from overlapping runs; four or five messages to wrap a build up; the
 * user's standing preferences asked again and again; boilerplate repeated a dozen times.
 */
const makeCore = coreHarness();
const isDirector = (req: AgentRunRequest) => 'intent' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const isFinal = (req: AgentRunRequest) => String(req.prompt).includes('What did NOT happen');
const replies = (core: Core) => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text').map((m) => m.text);

describe('reading the user’s words (pure)', () => {
  it('knows "go" from "not yet", and "resume when the plan is ready" from "resume"', () => {
    for (const yes of ['resume', 'please continue', 'Can you just manually start these agents?', 'do it now', 'go ahead and start them']) expect(asksResume(yes), yes).toBe(true);
    for (const no of ['do not resume it yourself', 'what is going on?', 'should I resume?']) expect(asksResume(no), no).toBe(false);
    expect(asksResumeAfterPlan('do not resume it yourself, have the planner resume when the plan is formulated')).toBe(true);
    expect(asksResumeAfterPlan('resume once the plan is ready')).toBe(true);
    expect(asksResumeAfterPlan('resume')).toBe(false);
  });

  it('wrap-up, verbatim, agent numbers and standing preferences', () => {
    for (const yes of ['wrap it up quickly', 'chop chop, no final regression suite either', 'just finish what is running']) expect(asksWrapUp(yes), yes).toBe(true);
    expect(asksWrapUp('how do I wrap a model in Kiln?')).toBe(false);
    expect(asksVerbatim('Send this to the planner verbatim')).toBe(true);
    expect(asksVerbatim('give him my words without paraphrasing')).toBe(true);
    expect(askedAgentLimit('run 6 agents in this window')).toBe(6);
    expect(askedAgentLimit('run 32 agents')).toBe(32);
    expect(askedAgentLimit('run 33 agents')).toBeNull();
    expect(askedAgentLimit('set the agent limit to 4')).toBe(4);
    expect(askedAgentLimit('the agents are slow')).toBeNull();
    expect(statesPreference('from now on always build models in Kiln')).toBe(true);
    expect(statesPreference('build a model of a tree')).toBe(false);
  });

  it('puts the true run state in place of a claim that is not so, and drops sentences the user has read twice', () => {
    const stopped = reconcileRunState('Got it, I asked for the R6 body. The team is still stopped, so nothing will start yet.', false);
    expect(stopped).toBe('Got it, I asked for the R6 body. The team is running.');
    const running = reconcileRunState('On it, starting now.', true);
    expect(running).toBe('The team is stopped: say "resume" when you want it running.');
    expect(reconcileRunState('Cards are fine.', true)).toBe('Cards are fine.');
    expect(saysStopped('The team is still stopped from your earlier "stop".')).toBe(true);
    const boiler = 'The plan changes when the planner finishes and may add or drop tasks.';
    expect(dropRepeats(`Asked for the sword change. ${boiler}`, [`A. ${boiler}`, `B. ${boiler}`])).toBe('Asked for the sword change.');
    expect(dropRepeats(`Asked for the sword change. ${boiler}`, [`A. ${boiler}`])).toBe(`Asked for the sword change. ${boiler}`);
  });
});

describe('the director tells the truth and carries out commands', () => {
  it('answers one message at a time: messages that come in meanwhile are answered together', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const prompts: string[] = [];
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        prompts.push(String(req.prompt));
        if (prompts.length === 1) await gate;
        return { intent: 'chat', reply: `Reply ${prompts.length}.` };
      },
    });
    h.core.orchestrator.pause();
    h.core.director.send('whats going on with studio right now');
    await waitFor(() => prompts.length === 1);
    h.core.director.send('so everything is good now?');
    h.core.director.send('and is the planner running?');
    open();
    await waitFor(() => replies(h.core).length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/\(1\) so everything is good now\?[\s\S]*\(2\) and is the planner running\?/);
  });

  it('passes the user’s own words on unchanged when they say "verbatim", with its suggestions apart when asked', async () => {
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'change', request: 'Make combat feel responsive under lag (prediction, lag compensation).', reply: 'Sent.' } : null) });
    h.core.orchestrator.pause();
    h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const long = 'how can we improve the combat mechanics in practice? theres just a bit too much latency for things like releasing arrows from your bow, or hitting people. These things work at a reasonable pace in studio but in an actual server seem to slow, how do we keep it fast and responsive in harsh ping conditions?';
    h.core.director.send(long);
    await waitFor(() => replies(h.core).length === 1);
    h.core.director.send('send it to the planner, give him my words without paraphrasing, and seperately provide your suggestions.');
    await waitFor(() => replies(h.core).length === 2);
    const plan = h.ctx.tasks.list({ kinds: ['plan'] }).at(-1)!;
    expect(plan.objective).toContain(`USER'S WORDS, VERBATIM (do not paraphrase; plan from these):\n"""\n${long}\n"""`);
    expect(plan.objective).toContain("THE DIRECTOR'S OWN SUGGESTIONS (separate from the user's words; take or leave them):\nMake combat feel responsive");
  });

  it('wraps a build up in one message: what hasn’t started is cancelled, nothing new is added until the next request', async () => {
    let director: Record<string, unknown> = { intent: 'chat', reply: 'Wrapping it up now.', wrapUp: true };
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? director : null) });
    h.core.orchestrator.pause();
    const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const a = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Snow flurries', objective: 'x', role: 'environment-artist', status: 'ready', createdBy: 'executive' });
    const b = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'More hedges', objective: 'x', role: 'environment-artist', status: 'proposed', createdBy: 'executive' });
    h.core.director.send('wrap it up, chop chop');
    await waitFor(() => replies(h.core).length === 1);
    expect(h.ctx.tasks.get(a.id)?.status).toBe('cancelled');
    expect(h.ctx.tasks.get(b.id)?.status).toBe('cancelled');
    expect(h.ctx.extras().wrapUp).toBe(true);
    expect(replies(h.core)[0]).toMatch(/Wrapping up: 2 tasks that hadn't started are cancelled/);
    director = { intent: 'change', request: 'Add a lobby sign', reply: 'Asked the planner.' };
    h.core.director.send('add a lobby sign');
    await waitFor(() => replies(h.core).length === 2);
    expect(h.ctx.extras().wrapUp).toBe(false);
  });

  it('sets this window’s agent limit and keeps a standing instruction in the planner’s notes', async () => {
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'chat', reply: 'Done.', agentLimit: 6, remember: 'Build every model in Kiln.' } : null) });
    h.core.orchestrator.pause();
    h.core.director.send('from now on always build models in Kiln, and run 6 agents');
    await waitFor(() => replies(h.core).length === 1);
    expect(h.ctx.settings().agentCap).toBe(6);
    expect(replies(h.core)[0]).toMatch(/This window now runs at most 6 agents at once/);
    const notes = join(h.ctx.dir, PLANNER_NOTES_FILE);
    expect(existsSync(notes) && readFileSync(notes, 'utf8')).toMatch(/the user: Build every model in Kiln\./);
  });

  it('rewrites a reply whose action did not happen, so it claims nothing that did not', async () => {
    const h = await makeCore({
      respond: async (req) => {
        if (isFinal(req)) return { intent: 'chat', reply: "I didn't stop anything: I couldn't find that task." };
        return isDirector(req) ? { intent: 'chat', reply: 'I stopped the final review.', tasks: [{ action: 'stop', task: 'task_nope' }] } : null;
      },
    });
    h.core.orchestrator.pause();
    h.core.director.send('stop the final reviewer');
    await waitFor(() => replies(h.core).length === 1);
    expect(replies(h.core)[0]).toMatch(/^I didn't stop anything: I couldn't find that task\./);
    expect(replies(h.core)[0]).not.toMatch(/I stopped the final review/);
  });

  it('reopens a finished task the user says is still broken, with their words and a reproduce-first step', async () => {
    let taskId = '';
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'chat', reply: 'Sending it back.', tasks: [{ action: 'reopen', task: taskId }] } : null) });
    h.core.orchestrator.pause();
    const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    taskId = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Touch bow aiming', objective: 'Arrows land on the reticle on phones.', role: 'roblox-engineer', status: 'done', createdBy: 'executive', acceptanceCriteria: ['Arrows land on the reticle'] }).id;
    h.core.director.send('the bow crosshair is still entirely skewed relative to the arrows on mobile');
    await waitFor(() => replies(h.core).length === 1);
    const t = h.ctx.tasks.get(taskId)!;
    expect(t.status).toBe('ready');
    expect(t.acceptanceCriteria[0]).toMatch(/^Reproduce first/);
    expect(replies(h.core)[0]).toMatch(/Sending it back./);
  });

  it("stops a goal's final review when the user asks, and the goal finishes without it", async () => {
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'chat', reply: 'Stopping it.', tasks: [{ action: 'stop', task: 'final reviewer' }] } : null) });
    h.core.orchestrator.pause();
    const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'verifying', createdBy: 'user' });
    const ctrl = new AbortController();
    const o = h.core.orchestrator as unknown as { finalCheck: unknown; inflight: Map<string, AbortController>; skipFinal: Set<string> };
    o.finalCheck = { objectiveId: goal.id, title: 'Pit', iteration: false, check: null, done: 3, total: 40, startedAt: new Date().toISOString(), studioSince: null };
    o.inflight.set(goal.id, ctrl);
    h.core.director.send('stop the final reviewer');
    await waitFor(() => replies(h.core).length === 1);
    expect(ctrl.signal.aborted).toBe(true);
    expect(o.skipFinal.has(goal.id)).toBe(true);
    expect(replies(h.core)[0]).toMatch(/Stopped the final review of "Pit": it finishes without the regression run./);
    o.inflight.delete(goal.id);
  });

  it('a request while stopped is planned now; "resume when the plan is ready" starts the team when it is', async () => {
    const h = await makeCore({
      respond: async (req, kind) => {
        if (isDirector(req)) return { intent: 'change', request: 'Add a lobby sign', reply: 'Asked the planner.' };
        if (kind === 'plan') return { summary: 'Added the sign.', tasks: [{ key: 'a', title: 'Lobby sign', kind: 'implement', role: 'level-designer', objective: 'A sign.', acceptanceCriteria: ['it is there'], verification: [] }] };
        return null;
      },
    });
    h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    await h.core.orchestrator.stop();
    h.core.director.send("add a lobby sign. do not resume it yourself, resume when the plan is ready");
    await waitFor(() => replies(h.core).length === 1);
    // (The fake planner answers at once: the team may already be running by the time the reply is posted.)
    expect(replies(h.core)[0]).toMatch(/starts by itself when the plan is ready/);
    expect(h.ctx.tasks.list({ kinds: ['plan'] }).some((t) => t.title.startsWith('Update plan'))).toBe(true);
    await waitFor(() => !h.core.orchestrator.state().paused, 20000);
    expect(h.core.director.chat()!.list().some((m) => m.kind === 'status' && m.text === 'The plan is ready, so the team is running again, as you asked.')).toBe(true);
  }, 30000);
});
