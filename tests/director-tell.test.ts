import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core';
import type { AgentRunRequest } from '../src/core/providers/types';
import { OUTPUT_SCHEMAS, ROLES } from '../src/core/agents/roles';
import { handsOff } from '../src/core/director/look';
import { TELL } from '../src/core/orchestrator/orchestrator';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * The user told the director "tell the agents to finish within 5 minutes" and was answered "I can't set a timer on
 * agents that are already running"; four agents worked on for as long as their tasks took. A running agent can be
 * told something (it reads a note with its next tool result), and a time limit can be kept.
 */
const makeCore = coreHarness();
const saved = { ...TELL };
afterEach(() => {
  Object.assign(TELL, saved);
});
const isDirector = (req: AgentRunRequest) => 'intent' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const replies = (core: Core) => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text');

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

async function setup(director: Record<string, unknown>) {
  const work = gate();
  let toolResult = '';
  const h = await makeCore({
    respond: async (req, kind, call) => {
      if (isDirector(req)) return director;
      if (kind === 'work') {
        await work.wait;
        const res = (await call('task_list', {})) as { content: Array<{ text?: string }> };
        toolResult = res.content.map((c) => c.text ?? '').join('\n');
        return { status: 'implemented', summary: 'Built what there was time for.' };
      }
      return kind === 'review' ? { verdict: 'pass', summary: 'ok', criteria: [], defects: [] } : null;
    },
  });
  const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Racing', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
  const mk = (title: string, role: string) => h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role, status: 'ready', createdBy: 'executive' });
  return { ...h, goal, mk, work, toolResult: () => toolResult };
}

describe('the director can speak to agents that are working', () => {
  it('knows it can, and the schema carries the message', () => {
    const tell = (OUTPUT_SCHEMAS.director as { properties: { tell: { properties: Record<string, unknown>; required: string[] } } }).properties.tell;
    expect(Object.keys(tell.properties)).toEqual(['message', 'tasks', 'finishInMinutes']);
    expect(tell.required).toEqual(['message']);
    expect(ROLES.director!.instructions).toMatch(/You can speak to the agents that are working right now: "tell"/);
    expect(ROLES.director!.instructions).toMatch(/never\s+answer that you cannot reach or time agents that are running/);
    // "Don't take any actions" drops it, like every other action.
    expect(handsOff({ intent: 'chat', reply: 'ok', tell: { message: 'hurry' } })).toMatchObject({ dropped: true, out: { tell: undefined } });
  });

  it('passes the user’s words to the running agents with their next tool result, and says so on the task', async () => {
    const h = await setup({ intent: 'chat', reply: 'Told both of them.', tell: { message: 'The sky is too dark: brighten it before anything else.' } });
    const cars = h.mk('Cars', 'roblox-engineer');
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(cars.id)!.status === 'running', 30000);
    h.core.director.send('tell them the sky is too dark');
    await waitFor(() => replies(h.core).length === 1);
    expect(replies(h.core)[0]!.text).toBe('Told both of them.');
    const notes = h.ctx.tasks.evidence(cars.id).filter((e) => e.kind === 'note');
    expect(notes.map((n) => n.title)).toEqual(['The user, through the director: The sky is too dark: brighten it before anything else.']);
    expect(h.ctx.audit.timeline({ limit: 50 }).some((e) => e.kind === 'task.note' && /^Told 1 working agent: The sky is too dark/.test(e.title))).toBe(true);
    h.work.open();
    await waitFor(() => h.toolResult() !== '', 30000);
    expect(h.toolResult()).toMatch(/Message from the director, passing on what the user just asked: The sky is too dark: brighten it before anything else\./);
    expect(h.toolResult()).toMatch(/Act on it in the work you are doing now, and say in your result what you did about it\./);
  }, 90000);

  it('keeps a time limit: the agents are told the time, and a run still going after it is stopped with its task paused', async () => {
    Object.assign(TELL, { graceMs: 300, minuteMs: 100 });
    const h = await setup({ intent: 'pause', reply: 'They have five minutes.', tell: { message: 'Wrap up.', finishInMinutes: 5 } });
    const cars = h.mk('Cars', 'roblox-engineer');
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(cars.id)!.status === 'running', 30000);
    // The limit itself, on the orchestrator (a "minute" is a tenth of a second here).
    const told = h.core.orchestrator.tell('Wrap up.', { finishInMinutes: 1 });
    expect(told.map((t) => t.id)).toEqual([cars.id]);
    await waitFor(() => h.ctx.tasks.get(cars.id)!.status === 'paused', 30000);
    const stopped = h.ctx.audit.timeline({ limit: 80 }).find((e) => e.kind === 'task.note' && /was stopped at the 1-minute limit the user set; its files stay as they are$/.test(e.title));
    expect(stopped).toBeTruthy();
    h.work.open();
  }, 90000);

  it('the wording of a limit, and the honest answer when nobody is working', async () => {
    const h = await setup({ intent: 'chat', reply: 'Told them to finish in five minutes.', tell: { message: 'Finish up.', finishInMinutes: 5 } });
    // Nobody is working: the reply says so instead of claiming it.
    h.core.director.send('tell the agents to finish within 5 minutes');
    await waitFor(() => replies(h.core).length === 1);
    expect(replies(h.core)[0]!.text).toBe('Told them to finish in five minutes.\n\n(No agent is working right now, so there was nobody to tell.)');
    const cars = h.mk('Cars', 'roblox-engineer');
    h.core.orchestrator.resume();
    await waitFor(() => h.ctx.tasks.get(cars.id)!.status === 'running', 30000);
    h.core.director.send('tell the agents to finish within 5 minutes');
    await waitFor(() => replies(h.core).length === 2);
    expect(replies(h.core)[1]!.text).toBe('Told them to finish in five minutes.');
    h.work.open();
    await waitFor(() => h.toolResult() !== '', 30000);
    expect(h.toolResult()).toMatch(/Time limit: finish within 5 minutes \(by \d\d:\d\d:\d\d\)\. Bring what you have to a working state now, leave out what is optional, sync, run task_run_checks once, and return your result/);
    // A task named that no agent works on reaches nobody.
    expect(h.core.orchestrator.tell('x', { taskIds: ['task_nope'] })).toEqual([]);
  }, 90000);
});
