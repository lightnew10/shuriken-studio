import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Core } from '../src/core/core';
import { REMOVAL_RECHECK, type DataModelSnapshot } from '../src/core/roblox/snapshot-diff';
import { autoResolvedLine, decisionLink, DECISION_PREFIX, isDecisionTask, MAX_AUTO_DECISIONS } from '../src/core/orchestrator/autonomy';
import type { PermissionMode } from '../src/shared/domain';
import type { AgentRunRequest } from '../src/core/providers/types';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * Autonomous permission mode, the escalations side (docs/ARCHITECTURE.md, "Permission modes"): approvals are granted
 * and logged, a blocked task or one out of attempts goes to the planner as a small decision task, an agent's
 * question is answered by the director, and the director's chat gets plain status lines — never a question card.
 * "ask" mode keeps the cards. (The tool and shell gate: tests/autonomous-mode.test.ts.)
 */

const makeCore = coreHarness();
afterEach(() => {
  REMOVAL_RECHECK.delayMs = 4000;
});

const pass = { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
const oneTask = (title: string, extra: Record<string, unknown> = {}) => ({ summary: 'one', tasks: [{ key: 'a', title, kind: 'implement', role: 'roblox-engineer', objective: `Do ${title}.`, acceptanceCriteria: ['works'], verification: [], ...extra }] });
const isDecisionRun = (req: AgentRunRequest) => req.prompt.includes('Nobody is available to ask');
const lines = (core: Core) => core.director.chat()!.list();
const statusLines = (core: Core) => lines(core).filter((m) => m.kind === 'status').map((m) => m.text);

/** A project whose agents report `blocked`/`failed` until the planner's decision, then succeed. */
async function stuckProject(mode: PermissionMode, stuck: 'blocked' | 'failed') {
  let decided = false;
  let decisions = 0;
  const h = await makeCore({
    respond: async (req, kind) => {
      if (kind === 'plan') {
        if (isDecisionRun(req)) {
          decided = true;
          decisions++;
          return { summary: 'Use a placeholder sword model and move on.' };
        }
        return oneTask('Build the sword');
      }
      if (kind === 'work') {
        if (decided) return { status: 'implemented', summary: 'Built it with a placeholder model' };
        return stuck === 'blocked' ? { status: 'blocked', summary: 'Which sword model should I use?', blockers: ['no model was chosen'] } : { status: 'failed', summary: 'could not do it' };
      }
      if (kind === 'review') return pass;
      return null;
    },
  });
  h.ctx.updateSettings({ permissionMode: mode, maxAttemptsPerTask: 2 });
  return { ...h, decisions: () => decisions };
}

describe('a task an agent reports blocked', () => {
  it('goes to the planner to decide, not to the user: no open question, a decision task, an auto-resolved record and a status line', async () => {
    const { core, ctx, provider, decisions } = await stuckProject('autonomous', 'blocked');
    const obj = core.orchestrator.submitObjective({ title: 'Sword', description: 'A sword the player swings.', skipResearch: true });
    // Parked for the decision while it is made…
    await waitFor(() => ctx.tasks.list({ parentId: obj.id }).some((t) => isDecisionTask(t)));
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    // …then retried with the decision in its brief, and the goal finishes on its own.
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(decisions()).toBe(1);
    expect(ctx.governance.escalations('open')).toHaveLength(0);

    const kids = ctx.tasks.list({ parentId: obj.id });
    const sword = kids.find((t) => t.title === 'Build the sword')!;
    const decision = kids.find((t) => t.title === `${DECISION_PREFIX}Build the sword`)!;
    expect(decision).toMatchObject({ kind: 'plan', status: 'done', role: 'executive', createdBy: 'executive' });
    expect(decision.objective).toContain('Which sword model should I use?');
    expect(decision.objective).toContain('plan_cancel_task');
    expect(decisionLink(ctx, decision)).toMatchObject({ targetId: sword.id });
    expect(sword.status).toBe('done');
    expect(sword.objective).toContain('Use a placeholder sword model and move on.');
    expect(provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(2);

    // The escalations table keeps it, resolved by the system, with what was decided.
    const all = ctx.governance.escalations();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'capability_missing', status: 'auto_resolved', taskId: sword.id, title: 'Blocked: Build the sword' });
    expect(all[0]!.response).toBe('Retrying with a different approach: Use a placeholder sword model and move on.');
    expect(all[0]!.resolvedAt).toBeTruthy();

    // The director's chat: one plain status line (updated with the decision), never a question card.
    expect(lines(core).some((m) => m.kind === 'question')).toBe(false);
    expect(statusLines(core).filter((t) => t.startsWith('Blocked: Build the sword'))).toEqual(['Blocked: Build the sword. Retrying with a different approach: Use a placeholder sword model and move on.']);
    expect(autoResolvedLine(all[0]!)).toBe(statusLines(core).find((t) => t.startsWith('Blocked'))!);
  }, 90000);

  it('ask mode still parks the task on a question card, with no decision task', async () => {
    const { core, ctx } = await stuckProject('ask', 'blocked');
    const obj = core.orchestrator.submitObjective({ title: 'Sword', description: 'A sword the player swings.', skipResearch: true });
    const task = await waitFor(() => ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Build the sword' && t.status === 'escalated'));
    const open = ctx.governance.escalations('open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'capability_missing', taskId: task.id, options: ['retry', 'cancel'] });
    expect(ctx.tasks.list({ parentId: obj.id }).some((t) => isDecisionTask(t))).toBe(false);
    expect(lines(core).some((m) => m.kind === 'question')).toBe(true);
  }, 60000);
});

describe('a task out of attempts', () => {
  it('goes to the planner too: no open question, and a decision task retries it', async () => {
    const { core, ctx, decisions } = await stuckProject('autonomous', 'failed');
    const obj = core.orchestrator.submitObjective({ title: 'Sword', description: 'A sword the player swings.', skipResearch: true });
    await waitFor(() => ctx.tasks.list({ parentId: obj.id }).some(isDecisionTask));
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(decisions()).toBe(1);
    const esc = ctx.governance.escalations();
    expect(esc.map((e) => [e.kind, e.status, e.title])).toEqual([['failure', 'auto_resolved', 'Repeated failure: Build the sword']]);
    expect(esc[0]!.response).toMatch(/^Retrying with a different approach: Use a placeholder sword model/);
    expect(lines(core).some((m) => m.kind === 'question')).toBe(false);
    // The retry after the decision has two attempts, not a fresh three.
    expect(ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Build the sword')!.maxAttempts).toBe(2);
  }, 90000);

  it('ask mode still escalates after repeated failures, as before', async () => {
    const { core, ctx } = await stuckProject('ask', 'failed');
    const obj = core.orchestrator.submitObjective({ title: 'Sword', description: 'A sword the player swings.', skipResearch: true });
    const task = await waitFor(() => ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Build the sword' && t.status === 'escalated'));
    expect(task.attempts).toBe(2);
    expect(ctx.governance.escalations('open')[0]).toMatchObject({ kind: 'failure', options: ['retry', 'cancel'] });
    expect(ctx.tasks.list({ parentId: obj.id }).some((t) => isDecisionTask(t))).toBe(false);
  }, 60000);

  it('a repeatedFailures rule of deny still ends it as failed for good, in both modes', async () => {
    const { core, ctx } = await stuckProject('autonomous', 'failed');
    ctx.updateSettings({ escalation: { ...ctx.settings().escalation, repeatedFailures: 'deny' } });
    const obj = core.orchestrator.submitObjective({ title: 'Sword', description: 'x', skipResearch: true });
    const task = await waitFor(() => ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Build the sword' && t.status === 'failed' && t.attempts === 2));
    await new Promise((r) => setTimeout(r, 400));
    expect(ctx.tasks.get(task.id)!.status).toBe('failed');
    expect(ctx.governance.escalations()).toHaveLength(0);
  }, 60000);

  it('a task that keeps getting stuck is dropped after the allowed decisions, and what waited for it carries on', async () => {
    let decisions = 0;
    // eslint-disable-next-line prefer-const
    let ctx!: Awaited<ReturnType<typeof makeCore>>['ctx'];
    const made = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'plan') {
          if (isDecisionRun(req)) {
            decisions++;
            return { summary: 'Try again, simpler.' };
          }
          return {
            summary: 'two',
            tasks: [
              { key: 'a', title: 'Impossible task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] },
              { key: 'b', title: 'Waits for it', kind: 'implement', role: 'roblox-engineer', objective: 'y', acceptanceCriteria: ['works'], verification: [], dependsOn: ['a'] },
            ],
          };
        }
        if (kind === 'work') return ctx.tasks.list({ statuses: ['running'] }).some((t) => t.title === 'Impossible task') ? { status: 'failed', summary: 'cannot be done' } : { status: 'implemented', summary: 'ok' };
        if (kind === 'review') return pass;
        return null;
      },
    });
    ctx = made.ctx;
    const core = made.core;
    ctx.updateSettings({ maxAttemptsPerTask: 2 });
    const obj = core.orchestrator.submitObjective({ title: 'Stuck', description: 'x', skipResearch: true });
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done', 120000).catch((e) => {
      throw new Error(`${(e as Error).message}: ${JSON.stringify(ctx.tasks.list({ parentId: obj.id }).map((k) => [k.title, k.status, k.attempts, k.maxAttempts, k.dependencies.length]))} objective ${ctx.tasks.get(obj.id)?.status}; escalations ${JSON.stringify(ctx.governance.escalations().map((x) => [x.status, x.title, x.response]))}`);
    });
    expect(decisions).toBe(MAX_AUTO_DECISIONS);
    const kids = ctx.tasks.list({ parentId: obj.id });
    const impossible = kids.find((t) => t.title === 'Impossible task')!;
    expect(impossible.status).toBe('cancelled');
    const waits = kids.find((t) => t.title === 'Waits for it')!;
    expect(waits.status).toBe('done');
    expect(waits.dependencies).toEqual([]);
    expect(waits.objective).toContain('was dropped');
    // Nothing ever asked the user; the last one says it was dropped.
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    const esc = ctx.governance.escalations();
    expect(esc).toHaveLength(MAX_AUTO_DECISIONS + 1);
    expect(esc.every((e) => e.status === 'auto_resolved')).toBe(true);
    expect(esc[0]!.response).toMatch(/^Dropped: it got stuck again after 2 automatic decision/);
    expect(lines(core).some((m) => m.kind === 'question')).toBe(false);
  }, 150000);
});

describe('a provider sign-in problem', () => {
  it('autonomous: no card, the task goes back to ready and is retried with backoff', async () => {
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') throw Object.assign(new Error('Invalid API key · Please run /login'), { errorKind: 'auth' });
        return null;
      },
    });
    ctx.updateSettings({ autonomy: 'manual' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create({ kind: 'implement', title: 'Needs sign-in', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['works'], verification: [] });
    core.orchestrator.runNow(task.id);
    await waitFor(() => ctx.audit.timeline({ limit: 50 }).find((e) => e.kind === 'provider.environment'));
    expect(ctx.tasks.get(task.id)).toMatchObject({ status: 'ready', attempts: 0 });
    expect(ctx.governance.escalations()).toHaveLength(0);
  }, 40000);

  it('ask mode: the task is parked and the user is asked to fix the sign-in, as before', async () => {
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') throw Object.assign(new Error('Invalid API key · Please run /login'), { errorKind: 'auth' });
        return null;
      },
    });
    ctx.updateSettings({ autonomy: 'manual', permissionMode: 'ask' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create({ kind: 'implement', title: 'Needs sign-in', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['works'], verification: [] });
    core.orchestrator.runNow(task.id);
    await waitFor(() => ctx.governance.escalations('open')[0]);
    expect(ctx.tasks.get(task.id)!.status).toBe('escalated');
  }, 40000);
});

describe('the large-removal guard', () => {
  /** A Studio whose place is a set of scenery models; a task's run deletes some. */
  function fakePlace(core: Core, count = 60) {
    const nodes: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < count; i++) nodes[`ServerStorage.Scenery.Tree_${i}#Model`] = { c: 'Model' };
    const studio = core.studio as unknown as Record<string, unknown>;
    core.studio.conn.state = 'connected';
    studio.state = async () => ({ mode: 'Edit', availableDataModels: ['Edit'], focused: null, raw: '' });
    studio.snapshot = async (): Promise<DataModelSnapshot> => ({ roots: ['ServerStorage'], count: Object.keys(nodes).length, truncated: false, nodes: structuredClone(nodes) });
    return nodes;
  }

  async function clearing(mode: PermissionMode) {
    REMOVAL_RECHECK.delayMs = 20;
    let nodes: Record<string, Record<string, unknown>> = {};
    const h = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          for (const k of Object.keys(nodes).slice(0, 30)) delete nodes[k];
          return { status: 'implemented', summary: 'Cleared the old trees' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    nodes = fakePlace(h.core);
    h.ctx.updateSettings({ autonomy: 'manual', permissionMode: mode });
    h.core.orchestrator.attach(h.ctx);
    const task = h.ctx.tasks.create({ kind: 'implement', title: 'Clear the old scenery', objective: 'Clear.', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['It is done'], verification: [{ kind: 'critic' }] });
    h.core.orchestrator.runNow(task.id);
    return { ...h, task };
  }

  it('autonomous: does not park the task: approved on the spot, logged, and the task goes on to its checks', async () => {
    const { ctx, task, provider } = await clearing('autonomous');
    await waitFor(() => ctx.tasks.get(task.id)?.status === 'done');
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    const all = ctx.governance.escalations();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'approval', status: 'auto_resolved', taskId: task.id, title: 'Clear the old scenery removed 30 instances from the place' });
    expect(all[0]!.detail).toContain('ServerStorage.Scenery.Tree_0#Model');
    expect(all[0]!.response).toMatch(/^Went ahead \(autonomous mode\)/);
    // It was never redone: one work run, then the critic.
    expect(provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(1);
    expect(provider.runs.some((r) => r.role === 'critic')).toBe(true);
  }, 60000);

  it('ask mode: asks for approval and parks the task, as before', async () => {
    const { ctx, task } = await clearing('ask');
    const open = await waitFor(() => ctx.governance.escalations('open')[0]);
    expect(open).toMatchObject({ kind: 'approval', options: ['approve', 'reject'] });
    expect(ctx.tasks.get(task.id)!.status).toBe('escalated');
  }, 60000);
});

describe('what an agent asks the owner', () => {
  /** Calls an agent tool the way an agent in a run of the project does. */
  async function asAgent(core: Core, role: string, tool: string, args: Record<string, unknown>, taskId: string | null = null) {
    const token = core.mcp.issueToken({ kind: 'agent', runId: null, taskId, role, providerId: 'fake', allowedTools: null });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(core.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      return { text: JSON.stringify(res.content), isError: !!res.isError };
    } finally {
      await client.close();
    }
  }

  it('autonomous: a question is answered by the director from the user\'s request, and recorded as auto-resolved', async () => {
    const asked: AgentRunRequest[] = [];
    const { core, ctx } = await makeCore({
      respond: async (req, kind) => {
        if (req.role === 'director' && kind === 'other') {
          asked.push(req);
          return null;
        }
        return null;
      },
    });
    ctx.tasks.create({ kind: 'objective', title: 'Sword fight arena', objective: 'A medieval sword fighting arena where players duel.', role: 'executive', createdBy: 'user', status: 'running', acceptanceCriteria: [], verification: [] });
    const out = await asAgent(core, 'level-designer', 'escalate', { title: 'Should the arena be stone or wood?', detail: 'The user did not say which material the arena floor uses.', options: ['stone', 'wood'] });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('The director answered for the user');
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    const [rec] = ctx.governance.escalations();
    expect(rec).toMatchObject({ kind: 'question', status: 'auto_resolved', title: 'Should the arena be stone or wood?' });
    expect(rec!.response).toBeTruthy();
    // The director run was told the question, the options and what the user asked for.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toContain('Should the arena be stone or wood?');
    expect(asked[0]!.prompt).toContain('Options: stone | wood');
    expect(asked[0]!.prompt).toContain('A medieval sword fighting arena where players duel.');
    expect(lines(core).some((m) => m.kind === 'question')).toBe(false);
    expect(statusLines(core).some((t) => t.startsWith('Decided without asking you: Should the arena be stone or wood?'))).toBe(true);
  }, 40000);

  it('autonomous: a question about spending or publishing still goes to the owner as a card', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    for (const [title, detail] of [
      ['Buy the paid asset pack?', 'The pack costs 400 Robux; should I spend it?'],
      ['Ready to go live?', 'The game is finished. Shall I publish the game to Roblox now?'],
    ]) {
      const out = await asAgent(core, 'game-designer', 'escalate', { title: title!, detail: detail! });
      expect(out.text).toContain('Escalated to the user');
    }
    const open = ctx.governance.escalations('open');
    expect(open).toHaveLength(2);
    expect(open.every((e) => e.status === 'open' && e.kind === 'question')).toBe(true);
    expect(lines(core).filter((m) => m.kind === 'question')).toHaveLength(2);
  }, 40000);

  // Studio refused every synced script. Two agents asked for a restart; the director answered "restart Studio now"
  // to one and "the user isn't available, carry on" to the other; the user sat at the PC and saw neither.
  it("autonomous: what only the user's hands can do is put in front of them once, and nobody waits or guesses", async () => {
    let asked = 0;
    const { core, ctx } = await makeCore({
      respond: async (req, kind) => {
        if (req.role === 'director' && kind === 'other') asked++;
        return null;
      },
    });
    const first = await asAgent(core, 'environment-artist', 'escalate', { title: 'Studio refuses all synced scripts (MCP capability sandbox)', detail: 'roblox_sync_push fails for every script. Needed: the user closes and reopens Roblox Studio on the place, then any agent can sync again.' });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('Shown to the user: only they can do this');
    expect(first.text).toContain('Nobody waits for it');
    const second = await asAgent(core, 'roblox-engineer', 'escalate', { title: 'Studio refuses all script sync: please restart Roblox Studio', detail: 'Please save the place, close Roblox Studio completely and reopen the project.' });
    expect(second.text).toContain('already asked by another agent');
    const open = ctx.governance.escalations('open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'question', status: 'open', title: 'Studio refuses all synced scripts (MCP capability sandbox)' });
    expect(lines(core).filter((m) => m.kind === 'question')).toHaveLength(1);
    // The director was not asked to guess.
    expect(asked).toBe(0);
    expect(ctx.governance.escalations('auto_resolved')).toHaveLength(0);
  }, 40000);

  it('ask mode: a question is escalated to the user as before', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    ctx.updateSettings({ permissionMode: 'ask' });
    const out = await asAgent(core, 'level-designer', 'escalate', { title: 'Should the arena be stone or wood?', detail: 'The user did not say which material the arena floor uses.' });
    expect(out.text).toContain('Escalated to the user');
    expect(ctx.governance.escalations('open')).toHaveLength(1);
  }, 40000);

  it('autonomous: a change to an approved spec section is approved and applied; ask mode asks', async () => {
    for (const mode of ['autonomous', 'ask'] as const) {
      const { core, ctx } = await makeCore({ respond: async () => null });
      ctx.updateSettings({ permissionMode: mode });
      ctx.governance.updateSpec('vision', 'A cozy farming game.', 'user', 'approved');
      const out = await asAgent(core, 'game-designer', 'spec_propose', { key: 'vision', body: 'A cozy farming game with seasons and festivals.', rationale: 'Seasons were in the pitch.' });
      expect(out.isError).toBe(false);
      const section = ctx.governance.spec().find((s) => s.key === 'vision')!;
      if (mode === 'autonomous') {
        expect(section).toMatchObject({ body: 'A cozy farming game with seasons and festivals.', status: 'approved', updatedBy: 'game-designer' });
        expect(ctx.governance.escalations('open')).toHaveLength(0);
        expect(ctx.governance.escalations()[0]).toMatchObject({ kind: 'spec_change', status: 'auto_resolved' });
        expect(statusLines(core).some((t) => t.startsWith('Spec change approved automatically: Vision'))).toBe(true);
      } else {
        expect(section.body).toBe('A cozy farming game.');
        expect(ctx.governance.escalations('open')[0]).toMatchObject({ kind: 'spec_change', options: ['approve', 'reject'] });
      }
    }
  }, 60000);
});

describe('a manual verification step', () => {
  it('autonomous: nobody is asked to check by hand; ask mode asks', async () => {
    for (const mode of ['autonomous', 'ask'] as const) {
      const { core, ctx } = await makeCore({
        respond: async (_req, kind) => (kind === 'work' ? { status: 'implemented', summary: 'done' } : kind === 'review' ? pass : null),
      });
      ctx.updateSettings({ autonomy: 'manual', permissionMode: mode });
      core.orchestrator.attach(ctx);
      const task = ctx.tasks.create({ kind: 'implement', title: 'Looks right', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['It looks right'], verification: [{ kind: 'manual', instructions: 'Look at the lobby.' }] });
      core.orchestrator.runNow(task.id);
      await waitFor(() => ctx.governance.escalations().find((e) => e.title === 'Manual verification: Looks right'));
      const e = ctx.governance.escalations().find((x) => x.title === 'Manual verification: Looks right')!;
      expect(e.status, mode).toBe(mode === 'autonomous' ? 'auto_resolved' : 'open');
      expect(ctx.governance.escalations('open').length, mode).toBe(mode === 'autonomous' ? 0 : 1);
    }
  }, 60000);
});

describe('finishing a goal', () => {
  /** A project with a roadmap in its spec whose one task changed the world; the planner has nothing left after it. */
  async function finishing(mode: PermissionMode, keepBuilding?: boolean) {
    const h = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'plan') return req.prompt.includes('NEXT milestone') ? { summary: 'The roadmap is complete: every milestone is delivered.', tasks: [] } : oneTask('Build the lobby');
        if (kind === 'work') return { status: 'implemented', summary: 'Built it' };
        if (kind === 'review') return pass;
        if (kind === 'research') return { conclusion: 'Nothing to look up.', findings: [] };
        return null;
      },
    });
    h.ctx.updateSettings({ permissionMode: mode, ...(keepBuilding === undefined ? {} : { keepBuilding }) });
    h.ctx.governance.updateSpec('gameplay', 'Roadmap: milestone 1 the lobby, milestone 2 combat.', 'user', 'draft');
    // Agents changed the world, and the place can't be saved here (no place file): the save-the-place note.
    const obj = h.core.orchestrator.submitObjective({ title: 'Lobby', description: 'Build the lobby.', skipResearch: true });
    await waitFor(() => h.ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Build the lobby'));
    const task = h.ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Build the lobby')!;
    h.ctx.tasks.addEvidence({ taskId: task.id, runId: null, kind: 'datamodel_snapshot', title: 'DataModel: 4 added', passed: null, data: {}, path: null });
    return { ...h, obj };
  }

  it('by default the build stops at the finished goal: nothing more is planned, and the chat says the roadmap has more', async () => {
    const { core, ctx, obj } = await finishing('autonomous');
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    await waitFor(() => statusLines(core).find((t) => t.startsWith('"Lobby" is done and checked. The roadmap in the spec has more')));
    expect(ctx.tasks.list({ kinds: ['objective'] }).some((o) => o.title.startsWith('Next milestone'))).toBe(false);
    expect(ctx.governance.escalations().some((e) => e.title.startsWith('Continue with the next milestone'))).toBe(false);
    expect(statusLines(core).find((t) => t.startsWith('"Lobby" is done'))).toMatch(/turn on Keep building for this window in Settings → Agents/);
  }, 90000);

  it('with Keep building on (this window): the next milestone starts by itself and the unsaved place is a note, never a card', async () => {
    const { core, ctx, obj } = await finishing('autonomous', true);
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    const next = await waitFor(() => ctx.tasks.list({ kinds: ['objective'] }).find((o) => o.title === 'Next milestone after "Lobby"'));
    expect(next.id).not.toBe(obj.id);
    // (It has nothing left to plan: the roadmap is complete, and that ends it rather than failing the planner.)
    await waitFor(() => ctx.tasks.get(next.id)?.status === 'cancelled');
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    const titles = ctx.governance.escalations().map((e) => `${e.status}: ${e.title}`).sort();
    expect(titles).toEqual(['auto_resolved: Continue with the next milestone after "Lobby"?', 'auto_resolved: Save the place in Studio to keep "Lobby" world changes']);
    const cont = ctx.governance.escalations().find((e) => e.title.startsWith('Continue'))!;
    expect(cont.response).toMatch(/^Yes: planning and building the next milestone/);
    expect(lines(core).some((m) => m.kind === 'question')).toBe(false);
    expect(statusLines(core).some((t) => t.startsWith('Decided without asking you: Continue with the next milestone after "Lobby"?'))).toBe(true);
    expect(statusLines(core).some((t) => /Save the place in Studio to keep "Lobby" world changes\. The save didn't go through yet/.test(t))).toBe(true);
  }, 90000);

  it('ask mode: asks to save the place, and asks nothing about continuing (Keep building is off)', async () => {
    const { core, ctx, obj } = await finishing('ask');
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    const open = await waitFor(() => {
      const o = ctx.governance.escalations('open');
      return o.length >= 1 ? o : null;
    });
    await waitFor(() => statusLines(core).find((t) => t.startsWith('"Lobby" is done and checked')));
    expect(open.map((e) => e.title)).toEqual(['Save the place in Studio to keep "Lobby" world changes']);
    expect(ctx.tasks.list({ kinds: ['objective'] }).some((o) => o.title.startsWith('Next milestone'))).toBe(false);
    expect(lines(core).filter((m) => m.kind === 'question')).toHaveLength(1);
  }, 90000);

  it('ask mode with Keep building on: the next milestone starts by itself too (left to run overnight)', async () => {
    const { ctx, obj } = await finishing('ask', true);
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    await waitFor(() => ctx.tasks.list({ kinds: ['objective'] }).find((o) => o.title === 'Next milestone after "Lobby"'));
  }, 90000);
});
