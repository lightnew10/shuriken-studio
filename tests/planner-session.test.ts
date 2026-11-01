import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../src/core/providers/types';
import { PLANNER_NOTES_FILE, appendPlannerNote, readPlannerNotes } from '../src/core/orchestrator/planner-notes';
import { PLANNER_SESSION } from '../src/core/orchestrator/planner-session';
import { STUDIO_TURN_ANSWER, aboutStudioTurn } from '../src/core/permissions/user-hands';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * One planner per project, with one conversation for the whole project (1.15.8): planning jobs run one at a time and
 * continue the planner's last session with what changed since; the planner's notes keep the user's standing
 * instructions. Before, several planners started in the same second, each rebuilt the project from a fresh package, and
 * the user had to repeat "use Kiln" four times.
 */
const makeCore = coreHarness();
const isPlanner = (req: AgentRunRequest) => req.role === 'executive';
const agent = (taskId: string, runId = 'run_planner') => ({ kind: 'agent' as const, runId, taskId, role: 'executive', providerId: null, allowedTools: null });
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');
const plan = (title: string) => ({ summary: `Planned ${title}.`, tasks: [{ key: title.toLowerCase().replace(/\W+/g, '-'), title, kind: 'implement', role: 'level-designer', objective: `Build ${title}.`, acceptanceCriteria: ['it is there'], verification: [] }] });

describe('one planner, one conversation for the whole project', () => {
  it('a later planning job continues the planner’s session, told what changed since its last turn', async () => {
    const seen: Array<{ resume: string | undefined; prompt: string; runId: string }> = [];
    const h = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'plan' && isPlanner(req)) {
          seen.push({ resume: req.resumeSessionId ?? undefined, prompt: String(req.prompt), runId: req.runId });
          return plan(seen.length === 1 ? 'Lobby' : 'Lobby sign');
        }
        return kind === 'work' ? { status: 'implemented', summary: 'Built it' } : kind === 'review' ? { verdict: 'pass', summary: 'ok', criteria: [], defects: [] } : null;
      },
    });
    const obj = h.core.orchestrator.submitObjective({ title: 'Lobby', description: 'Build the lobby.', skipResearch: true });
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.resume).toBeFalsy();
    await waitFor(() => h.ctx.tasks.list({ kinds: ['plan'] }).every((t) => t.status === 'done' || t.status === 'cancelled'));
    h.core.director.chat()!.add({ role: 'user', kind: 'text', text: 'also add a big sign at the lobby entrance' });
    h.core.orchestrator.amendPlan(obj.id, 'Add a big sign at the lobby entrance.');
    await waitFor(() => seen.length === 2, 20000);
    expect(seen[1]!.resume).toBe(`s-${seen[0]!.runId}`);
    expect(seen[1]!.prompt).toMatch(/A new planning job\. You keep one conversation for the whole project/);
    expect(seen[1]!.prompt).toMatch(/## Since your last turn\nThe user wrote:\n- "also add a big sign at the lobby entrance"/);
    expect(seen[1]!.prompt).toMatch(/## The job: Update plan: Add a big sign/);
    const run = h.ctx.store.get<{ continues_run_id: string | null }>('SELECT continues_run_id FROM runs WHERE id = ?', [seen[1]!.runId]);
    expect(run?.continues_run_id).toBe(seen[0]!.runId);
  }, 40000);

  it('runs one planning job at a time', async () => {
    let now = 0;
    let most = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const h = await makeCore({
      respond: async (req, kind) => {
        if (kind !== 'plan' || !isPlanner(req)) return null;
        now++;
        most = Math.max(most, now);
        await gate;
        now--;
        return { summary: 'ok', tasks: [] };
      },
    });
    const obj = h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    h.core.orchestrator.amendPlan(obj.id, 'First change.');
    h.core.orchestrator.amendPlan(obj.id, 'Second change.');
    await waitFor(() => now === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(most).toBe(1);
    expect(h.core.orchestrator.whyWaiting().join(' ')).toMatch(/waits? for the planner, who is busy with "Update plan: First change\." \(one planner per project\)/);
    open();
    await waitFor(() => h.ctx.tasks.list({ kinds: ['plan'] }).every((t) => t.status === 'done'), 20000);
    expect(most).toBe(1);
  }, 30000);

  it('starts a fresh conversation after an app update or too many jobs', () => {
    expect(PLANNER_SESSION.maxRuns).toBeGreaterThan(5);
    expect(PLANNER_SESSION.maxAgeMs).toBe(48 * 60 * 60 * 1000);
  });
});

describe("the planner's notes", () => {
  it('keep the user’s standing instructions, go into a fresh planning package, and the planner can add to them', async () => {
    let prompt = '';
    const h = await makeCore({ respond: async (req, kind) => (kind === 'plan' && isPlanner(req) ? ((prompt ||= String(req.prompt)), { summary: 'ok', tasks: [] }) : null) });
    appendPlannerNote(h.ctx, 'user', 'Build every model in Kiln.');
    expect(readPlannerNotes(h.ctx)).toMatch(/^- \d{4}-\d\d-\d\d, the user: Build every model in Kiln\.$/);
    const obj = h.core.orchestrator.submitObjective({ title: 'Forge', description: 'A forge.', skipResearch: true });
    await waitFor(() => prompt.length > 0);
    expect(prompt).toMatch(/Your notes for this project[\s\S]*the user: Build every model in Kiln\./);
    const planTask = h.ctx.tasks.list({ parentId: obj.id, kinds: ['plan'] })[0]!;
    const added = await h.core.tools.invoke('planner_notes', { action: 'add', text: 'The forge sits east of the spawn.' }, agent(planTask.id));
    expect(text(added)).toMatch(/Noted: - .*planner: The forge sits east of the spawn\./);
    expect(readFileSync(join(h.ctx.dir, PLANNER_NOTES_FILE), 'utf8')).toMatch(/the user: Build every model in Kiln\.\n- .*planner: The forge sits east/);
    expect(existsSync(join(h.ctx.dir, PLANNER_NOTES_FILE))).toBe(true);
  }, 30000);
});

describe('what the planner may and may not do', () => {
  it('adds no QA task in a window with QA passes off', async () => {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    const obj = h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const planTask = h.ctx.tasks.create({ parentId: obj.id, kind: 'plan', title: 'Plan: Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'executive' });
    h.ctx.updateSettings({ autoQa: false });
    const qa = await h.core.tools.invoke('plan_add_task', { key: 'qa', title: 'QA: play it all', role: 'qa-engineer', objective: 'Play every new feature through and report what breaks.', acceptanceCriteria: ['report'], verification: [], dependsOn: [] }, agent(planTask.id));
    expect(qa.isError).toBe(true);
    expect(text(qa)).toMatch(/QA passes turned off/);
    const ok = await h.core.tools.invoke('plan_add_task', { key: 'sign', title: 'Lobby sign', role: 'level-designer', objective: 'A big sign at the lobby entrance, readable from spawn.', acceptanceCriteria: ['sign'], verification: [], dependsOn: [] }, agent(planTask.id));
    expect(ok.isError, text(ok)).toBeFalsy();
  });

  it('a decision never drops a task the user asked for or put first', async () => {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    const obj = h.ctx.tasks.create({ kind: 'objective', title: 'Pit', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const mine = h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Group rewards sign fix', objective: 'x', role: 'ui-engineer', status: 'escalated', createdBy: 'director' });
    const theirs = h.ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Snow flurries', objective: 'x', role: 'environment-artist', status: 'escalated', createdBy: 'executive' });
    const decide = h.ctx.tasks.create({ parentId: obj.id, kind: 'plan', title: 'Decide: Group rewards sign fix', objective: 'x', role: 'executive', status: 'running', createdBy: 'executive' });
    const no = await h.core.tools.invoke('plan_cancel_task', { task: mine.id, reason: 'keeps failing' }, agent(decide.id));
    expect(no.isError).toBe(true);
    expect(text(no)).toMatch(/Not dropped: "Group rewards sign fix" is a task the user asked for/);
    const yes = await h.core.tools.invoke('plan_cancel_task', { task: theirs.id, reason: 'not worth it' }, agent(decide.id));
    expect(yes.isError, text(yes)).toBeFalsy();
  });

  it('a question about Studio’s playtest turn gets the facts, never a decision nobody can carry out', async () => {
    expect(aboutStudioTurn('Studio held by a stuck playtest lock for 80+ min')).toBe(true);
    expect(aboutStudioTurn('Studio code sync hangs for every agent')).toBe(true);
    expect(aboutStudioTurn('Which colour should the lobby sign be?')).toBe(false);
    const h = await makeCore({ respond: async () => ({ intent: 'chat', reply: 'Release the lock / stop that run.' }) });
    h.core.orchestrator.pause();
    h.ctx.updateSettings({ permissionMode: 'autonomous' });
    const r = await h.core.tools.invoke('escalate', { title: 'Studio held by a stuck playtest lock for 80+ min', detail: 'Studio is in Edit mode with no playtest running, so the lock is stale. Release it?' }, { kind: 'agent', runId: 'run_x', taskId: null, role: 'sound-designer', providerId: null, allowedTools: null });
    expect(text(r)).toContain(STUDIO_TURN_ANSWER);
    const e = h.ctx.governance.escalations('auto_resolved')[0]!;
    expect(e.response).toMatch(/kept by Shuriken itself/);
  });
});
