import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Core } from '../src/core/core';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import type { Task } from '../src/shared/domain';
import { FakeProvider, fakeWrite, type FakeScript } from './helpers/fake-provider';
import { UiStore } from '../src/core/ui/ui-workshop';
import { createRouter } from '../src/core/rpc/router';
import type { UiNode } from '../src/shared/ui-layout';
import type { RenderRequest } from '../src/shared/render';

/** Toolchain stub: static analysis passes without binaries or network. */
class StubLuau extends LuauToolchain {
  constructor() {
    super(tmpdir());
  }
  override async check(): Promise<LuauCheckResult> {
    return { ok: true, problems: [], toolErrors: [], durationMs: 1 };
  }
}

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown().catch(() => {});
});

async function makeCore(script: FakeScript) {
  const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
  const provider = new FakeProvider(script);
  const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [provider], integrations: false, logToDisk: false, luau: new StubLuau() });
  cores.push(core);
  const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
  const summary = core.createProject({ name: 'Test Game', rootPath: root });
  const ctx = core.openProject(summary.id);
  ctx.updateExtras({ syncMode: 'none' });
  ctx.updateSettings({ maxConcurrentAgents: 2, autonomy: 'supervised' });
  return { core, provider, ctx, root };
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 45000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('MCP server', () => {
  it('requires a bearer token and a loopback host', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const url = new URL(core.mcp.url);
    const status = (headers: Record<string, string>) =>
      new Promise<number>((res, rej) => {
        const req = request({ host: '127.0.0.1', port: Number(url.port), path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (r) => {
          r.resume();
          res(r.statusCode ?? 0);
        });
        req.on('error', rej);
        req.end('{}');
      });
    expect(await status({})).toBe(401);
    expect(await status({ host: 'evil.example:80' })).toBe(403);
  });

  it('exposes role-filtered tools and resources to a real MCP client', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const token = core.mcp.issueToken({ kind: 'agent', runId: null, taskId: null, role: 'critic', providerId: 'fake', allowedTools: new Set(['task_get', 'knowledge_search', 'project_overview']) });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(core.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['knowledge_search', 'project_overview', 'task_get']);
    const res = await client.callTool({ name: 'project_overview', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('Test Game');
    const resources = await client.listResources();
    expect(resources.resources.some((r) => r.uri === 'shuriken://project/spec')).toBe(true);
    // Tool calls are audited with the caller's role.
    const calls = core.requireProject().audit.toolCalls();
    expect(calls.some((c) => c.tool === 'project_overview' && c.role === 'critic' && c.status === 'ok')).toBe(true);
    await client.close();
  });

  it("shows each specialist its own workshop's building tools, and everyone the shared ones", async () => {
    const { core } = await makeCore({ respond: async () => null });
    const { ROLES, hiddenToolsFor } = await import('../src/core/agents/roles');
    const seen = async (role: string) => {
      const def = ROLES[role]!;
      const token = core.mcp.issueToken({ kind: 'agent', runId: null, taskId: null, role, providerId: 'fake', allowedTools: def.appTools ? new Set(def.appTools) : null, hiddenTools: hiddenToolsFor(def) });
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(core.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const names = new Set((await client.listTools()).tools.map((t) => t.name));
      await client.close();
      return names;
    };
    const level = await seen('level-designer');
    for (const t of ['model_place', 'model_list', 'animation_list', 'audio_list', 'vfx_list', 'geometry_apply', 'ui_audit', 'roblox_playtest']) expect(level.has(t), t).toBe(true);
    for (const t of ['blender_python', 'model_view', 'animation_create', 'audio_sfx', 'vfx_create', 'plan_add_task', 'research_add_claim']) expect(level.has(t), t).toBe(false);
    const modeler = await seen('modeler');
    expect(['blender_python', 'blender_render', 'model_view', 'model_place'].every((t) => modeler.has(t))).toBe(true);
    expect(modeler.has('audio_music')).toBe(false);
    expect(['rig_build', 'model_gear'].every((t) => modeler.has(t))).toBe(true);
    // The gameplay engineer uses what the specialists made and makes none of it: in 23 projects it made ten
    // animations, three effects and no sound, and carried those workshops' 31 definitions on every turn.
    const engineer = await seen('roblox-engineer');
    expect(['animation_list', 'vfx_list', 'audio_list', 'roblox_playtest', 'roblox_sync_push'].every((t) => engineer.has(t))).toBe(true);
    for (const t of ['animation_create', 'vfx_create', 'audio_sfx', 'kiln_request', 'blender_python', 'rig_build', 'model_gear']) expect(engineer.has(t), t).toBe(false);
    // QA settles checks and builds no assets.
    const qa = await seen('qa-engineer');
    expect(['test_list', 'test_retire', 'task_update_verification', 'roblox_playtest'].every((t) => qa.has(t))).toBe(true);
    for (const t of ['audio_sfx', 'vfx_create', 'animation_create', 'blender_python', 'kiln_request']) expect(qa.has(t), t).toBe(false);
    expect(engineer.size).toBeLessThanOrEqual(70);
    expect(qa.size).toBeLessThanOrEqual(75);
    expect((await seen('animator')).has('rig_build')).toBe(true);
    expect((await seen('executive')).has('plan_add_task')).toBe(true);
    // The critic looks at models and animations itself, and can try behaviour in a playtest.
    const critic = await seen('critic');
    expect(['model_view', 'animation_view', 'animation_check', 'roblox_playtest'].every((t) => critic.has(t))).toBe(true);
    expect(critic.has('blender_python')).toBe(false);
    // A hidden tool can't be called either.
    const res = await core.tools.invoke('blender_python', { model: 'X', code: 'pass' }, { kind: 'agent', runId: null, taskId: null, role: 'level-designer', providerId: null, allowedTools: null, hiddenTools: hiddenToolsFor(ROLES['level-designer']!) });
    expect(res.isError).toBe(true);
    expect(level.size).toBeLessThan(modeler.size + 20);
  });

  it('passes the MCP self-test health check', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const h = await core.health.run('mcp-server');
    expect(h.status).toBe('healthy');
  });
});

describe('autonomous loop (fake provider)', () => {
  it('runs objective → research → plan → implement → verify → critic → repair → done', async () => {
    let reviews = 0;
    const script: FakeScript = {
      respond: async (req, kind, call) => {
        if (kind === 'research') {
          const session = /Research session id: (\S+)/.exec(req.prompt)?.[1];
          const src = (await call('research_add_source', { session_id: session!, url: 'https://create.roblox.com/docs/scripting/events/remote', title: 'Remote events', authority: 'official' })) as { content: Array<{ text: string }> };
          const sourceId = /\((src_[^)]+)\)/.exec(src.content[0]!.text)?.[1];
          const claim = (await call('research_add_claim', { session_id: session!, claim: 'RemoteEvents must be validated server-side', source_id: sourceId, confidence: 0.9, status: 'supported' })) as { content: Array<{ text: string }> };
          const claimId = /\((clm_[^)]+)\)/.exec(claim.content[0]!.text)?.[1];
          return { conclusion: 'Use a server-validated module.', findings: [{ title: 'Validate remotes on the server', body: 'Every remote argument is checked server-side.', scope: 'roblox', confidence: 0.9, claimIds: [claimId] }] };
        }
        if (kind === 'plan') {
          return {
            summary: 'Two tasks',
            tasks: [
              { key: 't1', title: 'Greeting module', kind: 'implement', role: 'luau-engineer', objective: 'Create Greeting module', acceptanceCriteria: ['Greeting.luau returns a greet function'], verification: [{ kind: 'critic' }] },
              { key: 't2', title: 'Document greeting', kind: 'document', role: 'technical-writer', objective: 'Document it', acceptanceCriteria: ['README exists'], verification: [{ kind: 'critic' }], dependsOn: ['t1'] },
            ],
          };
        }
        if (kind === 'work') {
          const isDoc = req.role === 'technical-writer';
          const ok = await fakeWrite(req, isDoc ? 'docs/GREETING.md' : 'src/Shared/Greeting.luau', isDoc ? '# Greeting\n' : '--!strict\nreturn { greet = function(n: string) return "hi " .. n end }\n');
          expect(await fakeWrite(req, '../outside.txt', 'x')).toBe(false);
          await call('task_add_evidence', { kind: 'note', title: 'wrote file', passed: ok });
          return { status: 'implemented', summary: isDoc ? 'Documented' : 'Module written', filesChanged: [], knowledge: [{ title: 'Greeting lives in Shared', body: 'Module path ReplicatedStorage.Shared.Greeting', scope: 'project', confidence: 0.9 }] };
        }
        if (kind === 'review') {
          reviews++;
          if (reviews === 1) {
            return { verdict: 'fail', summary: 'Missing type annotation on return', criteria: [{ criterion: 'Greeting.luau returns a greet function', met: false, evidence: 'no return type' }], defects: [{ severity: 'high', area: 'correctness', title: 'Types', detail: 'Add return type', fix: 'Annotate' }] };
          }
          return { verdict: 'pass', summary: 'Looks good', criteria: [{ criterion: 'met', met: true, evidence: 'file present' }], defects: [] };
        }
        return null;
      },
    };
    const { core, provider, ctx, root } = await makeCore(script);
    // Every text the chat showed, updates in place included (a progress line can be replaced by a later one).
    const said: string[] = [];
    core.bus.on('chat.message', (m) => said.push(...m.text.split('\n')));
    const objective = core.orchestrator.submitObjective({ title: 'Greeting feature', description: 'Players can be greeted.' });
    await waitFor(() => ctx.tasks.get(objective.id)?.status === 'done', 60000);

    const children = ctx.tasks.list({ parentId: objective.id });
    const byTitle = (t: string) => children.find((c) => c.title.includes(t)) as Task;
    expect(children.every((c) => c.status === 'done')).toBe(true);
    const t1 = byTitle('Greeting module');
    expect(t1.attempts).toBe(2);
    expect(ctx.tasks.failures(t1.id).some((f) => f.stage === 'review')).toBe(true);
    expect(ctx.tasks.evidence(t1.id).filter((e) => e.kind === 'critic_review').map((e) => e.passed)).toEqual([false, true]);
    expect(existsSync(join(root, 'src', 'Shared', 'Greeting.luau'))).toBe(true);
    expect(existsSync(join(root, '..', 'outside.txt'))).toBe(false);

    // Research produced provenance-tracked knowledge.
    const sessions = ctx.research.sessions();
    expect(sessions[0]!.status).toBe('concluded');
    const k = core.knowledge.search({ text: 'validate remotes server' }).find((e) => e.title === 'Validate remotes on the server');
    expect(k?.category).toBe('authoritative');
    expect(k?.scope).toBe('roblox');
    expect(k?.store).toBe('global');
    expect(k?.sources[0]?.authority).toBe('official');

    // Knowledge an agent recorded during a task that later passed review is validated by that work.
    const learned = core.knowledge.search({ text: 'Greeting lives in Shared' }).find((e) => e.title === 'Greeting lives in Shared');
    expect(learned?.validatedAt).toBeTruthy();
    expect(learned?.validation).toMatch(/Validated by verified task/);

    // Agents used MCP tools with attribution; runs and context packages persisted.
    const calls = ctx.audit.toolCalls();
    expect(calls.some((c) => c.tool === 'task_add_evidence' && c.role === 'luau-engineer' && c.runId)).toBe(true);
    const runs = core.runner.listRuns(ctx);
    expect(runs.length).toBe(provider.runs.length);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
    // Fresh runs get a compiled context package; the repair continues the implementer's own session
    // with a brief of the critic's defects, and the critic re-reviews in its own review session.
    const fresh = provider.runs.filter((r) => !r.resumeSessionId);
    const continued = provider.runs.filter((r) => r.resumeSessionId);
    expect(continued.map((r) => r.role).sort()).toEqual(['critic', 'luau-engineer']);
    expect(runs.filter((r) => !r.contextPath).length).toBe(continued.length);
    expect(runs.filter((r) => r.contextPath).every((r) => readFileSync(r.contextPath!, 'utf8').includes('Shuriken context package'))).toBe(true);
    // Every agent knows whether 3D modeling can run on this PC.
    expect(readFileSync(runs.find((r) => r.contextPath)!.contextPath!, 'utf8')).toMatch(/3D modeling: (ready|NOT available)/);
    const firstWork = fresh.find((r) => r.role === 'luau-engineer' && r.prompt.includes('Greeting module'))!;
    const repairRun = continued.find((r) => r.role === 'luau-engineer')!;
    expect(repairRun.resumeSessionId).toBe(`s-${firstWork.runId}`);
    expect(repairRun.prompt).toContain('Critic rejected');
    expect(repairRun.prompt).toContain('Add return type');
    expect(repairRun.prompt).not.toContain('Shuriken context package');
    const firstReview = fresh.find((r) => r.role === 'critic' && r.prompt.includes('Module written'))!;
    expect(continued.find((r) => r.role === 'critic')!.resumeSessionId).toBe(`s-${firstReview.runId}`);
    expect(ctx.store.all<{ continues_run_id: string | null }>('SELECT continues_run_id FROM runs WHERE continues_run_id IS NOT NULL').length).toBe(2);
    // The chat tells the story in progress messages (narration.ts): each finished task once, the send-back naming what the
    // reviewer found (and replaced in place by the task's later line), with time worked and what checked it.
    const chat = core.director.chat()!;
    const items = chat
      .list()
      .filter((m) => m.data?.digest === true)
      .flatMap((m) => m.data!.items as Array<{ kind: string; text: string; taskId?: string; passes?: number }>);
    expect(items[0]).toMatchObject({ kind: 'done', text: expect.stringMatching(/^Done: Research requirements: Greeting feature \(\d+ min of work\)\.$/) });
    expect(said).toContain('Another pass for Greeting module: the reviewer found "Types" (Add return type).');
    // The document task started when the module's work existed (before its review ended), so the two finish in either order.
    // (Its static analysis answered for none of its files: this fake agent's writes are not reported as edits, and it
    // lists no changed files. The line says what checked it: the review.)
    expect(items.slice(1).map((i) => i.text).sort()).toEqual([expect.stringMatching(/^Done: Document greeting/), expect.stringMatching(/^Done: Greeting module \(\d+ min of work; review passed, no automated checks\)\.$/)]);
    expect(items.find((i) => i.taskId === t1.id)).toMatchObject({ kind: 'done', passes: 1 });
    expect(chat.list().filter((m) => m.kind === 'status' && /^(Done|Another pass)/.test(m.text) && !m.data?.digest)).toHaveLength(0);

    // Checkpoints, decisions, exported state.
    expect(ctx.git.checkpoints().some((c) => c.kind === 'verified')).toBe(true);
    expect(ctx.governance.decisions().some((d) => d.title.startsWith('Plan:'))).toBe(true);
    expect(existsSync(join(ctx.dir, 'state', 'tasks.json'))).toBe(true);
    expect(ctx.audit.timeline({ limit: 500 }).length).toBeGreaterThan(10);

    // The project stays intelligible without the app: a markdown report from Shuriken's own records.
    const { writeProjectReport } = await import('../src/core/projects/report');
    const reportFile = writeProjectReport(ctx, core.knowledge, core.runner);
    const md = readFileSync(reportFile, 'utf8');
    expect(md).toContain('## Objective: Greeting feature [done]');
    expect(md).toMatch(/\| Greeting module \| luau-engineer \| done \| 2\/3 \|/);
  }, 90000);

  it('continues a turn-limited run in its own session, and starts fresh when that session is gone', async () => {
    let works = 0;
    const { core, provider, ctx } = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Big task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') {
          works++;
          if (works === 1) throw Object.assign(new Error('Reached maximum number of turns (120)'), { errorKind: 'max_turns' });
          if (req.resumeSessionId) throw new Error(`No conversation found with session ID: ${req.resumeSessionId}`);
          return { status: 'implemented', summary: 'ok' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const obj = core.orchestrator.submitObjective({ title: 'Big', description: 'x', skipResearch: true });
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    const work = provider.runs.filter((r) => r.role === 'roblox-engineer');
    expect(work.map((r) => !!r.resumeSessionId)).toEqual([false, true, false]);
    expect(work[1]!.resumeSessionId).toBe(`s-${work[0]!.runId}`);
    expect(work[1]!.prompt).toMatch(/turn limit before finishing\. Continue exactly where you stopped/);
    expect(ctx.audit.timeline({ limit: 200 }).some((e) => /couldn't continue its earlier session \(Error: No conversation found/.test(e.title))).toBe(true);
    // Neither the turn limit nor the missing session cost an attempt.
    expect(ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Big task')!.attempts).toBe(1);
  }, 60000);

  // A two-build night: every account reached its usage limit at once. The reviews it cut off (0 turns) counted as
  // "Critic did not return a review", a failed attempt each, and finished, checked work was to be done again.
  it('a review cut off by a usage limit is not a rejection: the work is kept and reviewed when there is room', async () => {
    let reviews = 0;
    const { core, provider, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Dress the plaza', kind: 'implement', role: 'environment-artist', objective: 'x', acceptanceCriteria: ['looks right'], verification: [] }] };
        if (kind === 'work') return { status: 'implemented', summary: 'Plaza dressed' };
        if (kind === 'review') {
          reviews++;
          if (reviews === 1) throw Object.assign(new Error("You've hit your session limit"), { errorKind: 'rate_limit' });
          return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        }
        return null;
      },
    });
    const obj = core.orchestrator.submitObjective({ title: 'Plaza', description: 'x', skipResearch: true });
    const task = await waitFor(() => (reviews === 1 ? ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Dress the plaza' && t.status === 'ready') : null));
    // Back in line with its work kept: no failure, no attempt spent, nothing to redo.
    expect(ctx.tasks.failures(task.id)).toEqual([]);
    expect(task.attempts).toBe(0);
    expect(ctx.tasks.resumeRun(task.id)).toBe(provider.runs.find((r) => r.role === 'environment-artist')!.runId);
    expect(ctx.audit.timeline({ limit: 200 }).some((e) => /Usage limit reached during the review/.test(JSON.stringify(e.detail ?? '')))).toBe(true);
    // The limit resets: the review runs, the work does not.
    core.usage.recordSuccess(provider.id);
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(provider.runs.filter((r) => r.role === 'environment-artist')).toHaveLength(1);
    expect(provider.runs.filter((r) => r.role === 'critic')).toHaveLength(2);
    expect(ctx.tasks.get(task.id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(ctx.tasks.failures(task.id)).toEqual([]);
  }, 60000);

  it('with auto-resume off, a usage limit pauses the team and says that it stays paused until the user resumes', async () => {
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Round loop', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') throw Object.assign(new Error("You've hit your session limit"), { errorKind: 'rate_limit' });
        return null;
      },
    });
    core.accounts.setPolicy({ autoResume: false });
    const obj = core.orchestrator.submitObjective({ title: 'Loop', description: 'x', skipResearch: true });
    const paused = await waitFor(() => ctx.audit.timeline({ limit: 200 }).find((e) => e.kind === 'limit.paused'));
    expect(paused.title).toMatch(/^Paused until you resume: .*usage limit.*it resets at .*"Resume automatically when a limit resets" is off \(Settings, Accounts\), so the team stays paused, also after the reset: press Resume to carry on\.$/);
    expect(paused.title).not.toMatch(/resuming at|work resumes/);
    expect(core.orchestrator.state().paused).toBe(true);
    expect(ctx.tasks.get(obj.id)?.status).not.toBe('done');
  }, 60000);

  it('picks which earlier session a task continues, and when it starts fresh', async () => {
    const { implementerContinuation } = await import('../src/core/orchestrator/continuation');
    const { ctx, core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const task = ctx.tasks.create({ parentId: null, kind: 'implement', title: 'T', objective: 'x', role: 'roblox-engineer', status: 'ready', createdBy: 'user' });
    const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
    const run = (id: string, over: Record<string, unknown>) => {
      const r = { status: 'completed', started: at(10), ended: at(9), session: `s-${id}`, error: null, version: 'test', continues: null, role: 'roblox-engineer', ...over };
      ctx.store.run('INSERT INTO runs (id, task_id, role, provider_id, status, started_at, ended_at, provider_session_id, error, app_version, continues_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, task.id, r.role, 'fake', r.status, r.started, r.ended, r.session, r.error, r.version, r.continues]);
    };
    const pick = () => implementerContinuation(ctx, ctx.tasks.get(task.id)!, 'fake', 'test');
    // Cut off by the usage limit: carry on once there is room again.
    run('run_a', { status: 'failed', error: "You've hit your session limit · resets 12:50am" });
    expect(pick()).toMatchObject({ runId: 'run_a', sessionId: 's-run_a', reason: 'interrupted' });
    expect(pick()!.brief).toMatch(/usage limit/);
    // Too old, another provider, or three continuations deep: start fresh.
    ctx.store.run("UPDATE runs SET ended_at = ?, started_at = ? WHERE id = 'run_a'", [at(25 * 60), at(25 * 60 + 1)]);
    expect(pick()).toBeNull();
    run('run_b', { status: 'interrupted', started: at(5), ended: at(4) });
    expect(implementerContinuation(ctx, ctx.tasks.get(task.id)!, 'other-provider', 'test')).toBeNull();
    expect(pick()).toMatchObject({ runId: 'run_b', reason: 'interrupted' });
    run('run_c', { status: 'interrupted', started: at(3), ended: at(3), continues: 'run_b' });
    run('run_d', { status: 'interrupted', started: at(2), ended: at(2), continues: 'run_c' });
    expect(pick()).toMatchObject({ runId: 'run_d' });
    run('run_e', { status: 'interrupted', started: at(1), ended: at(1), continues: 'run_d' });
    expect(pick()).toBeNull();
  });

  it("never continues a session another app version ran (its tools may be gone)", async () => {
    let reviews = 0;
    let older: (() => void) | null = null;
    const { core, provider, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Old work', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') return { status: 'implemented', summary: 'ok' };
        if (kind === 'review') {
          if (++reviews > 1) return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
          older!(); // as if the first attempt ran in the previous version
          return { verdict: 'fail', summary: 'Needs a fix', criteria: [{ criterion: 'works', met: false, evidence: 'no' }], defects: [{ severity: 'high', area: 'x', title: 'Fix', detail: 'd', fix: 'f' }] };
        }
        return null;
      },
    });
    older = () => ctx.store.run("UPDATE runs SET app_version = '1.7.0'");
    const obj = core.orchestrator.submitObjective({ title: 'Old', description: 'x', skipResearch: true });
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(provider.runs.filter((r) => r.role === 'roblox-engineer').map((r) => !!r.resumeSessionId)).toEqual([false, false]);
    expect(provider.runs.filter((r) => r.role === 'critic').map((r) => !!r.resumeSessionId)).toEqual([false, false]);
    expect(ctx.store.get<{ app_version: string }>("SELECT app_version FROM runs ORDER BY started_at DESC LIMIT 1")?.app_version).toBe('test');
  }, 60000);

  it('carries on an interrupted run in its own session after Stop and Resume', async () => {
    let started = 0;
    const { core, provider, ctx } = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Long task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') {
          started++;
          // The first run works until it is stopped.
          if (!req.resumeSessionId) await new Promise((_r, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          return { status: 'implemented', summary: 'ok' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const obj = core.orchestrator.submitObjective({ title: 'Long', description: 'x', skipResearch: true });
    await waitFor(() => started === 1);
    await core.orchestrator.stop();
    await waitFor(() => ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Long task')?.status === 'ready');
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    const work = provider.runs.filter((r) => r.role === 'roblox-engineer');
    expect(work).toHaveLength(2);
    expect(work[1]!.resumeSessionId).toBe(`s-${work[0]!.runId}`);
    expect(work[1]!.prompt).toMatch(/^Your run was interrupted/);
  }, 60000);

  it('runs every agent but the planner at the effort Settings give them (high by default)', async () => {
    const { core, provider, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Quick task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') return { status: 'implemented', summary: 'ok' };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    expect(core.prefs.get().agentEffort).toBe('high');
    core.prefs.set({ agentEffort: 'medium' });
    const obj = core.orchestrator.submitObjective({ title: 'Quick', description: 'x', skipResearch: true });
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(provider.runs.map((r) => [r.role, r.effort])).toEqual([
      ['executive', 'max'],
      ['roblox-engineer', 'medium'],
      ['critic', 'medium'],
    ]);
    core.prefs.set({ agentEffort: 'bogus' as never });
    expect(core.prefs.get().agentEffort).toBe('high');
  }, 60000);

  it("runs the planner at the effort Settings give it (max by default), whatever the agents' setting", async () => {
    const { core, provider, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Quick task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') return { status: 'implemented', summary: 'ok' };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    expect(core.prefs.get().plannerEffort).toBe('max');
    core.prefs.set({ plannerEffort: 'xhigh' });
    const obj = core.orchestrator.submitObjective({ title: 'Deep', description: 'x', skipResearch: true });
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(provider.runs.find((r) => r.role === 'executive')?.effort).toBe('xhigh');
    core.prefs.set({ plannerEffort: 'bogus' as never });
    expect(core.prefs.get().plannerEffort).toBe('max');
  }, 60000);

  it('asks a run that did the work but forgot its structured result for the result, instead of redoing it', async () => {
    let works = 0;
    const { core, provider, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Forgetful task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') return ++works === 1 ? null : { status: 'implemented', summary: 'ok' };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const obj = core.orchestrator.submitObjective({ title: 'Forgetful', description: 'x', skipResearch: true });
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    const work = provider.runs.filter((r) => r.role === 'roblox-engineer');
    expect(work).toHaveLength(2);
    expect(work[1]!.resumeSessionId).toBe(`s-${work[0]!.runId}`);
    expect(work[1]!.prompt).toMatch(/^Your run ended without its structured result \(Agent returned no structured result\)/);
  }, 60000);

  it('keeps Blender undo history out of an existing project’s git (its .gitignore gains the line once)', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const root = mkdtempSync(join(tmpdir(), 'shuriken-old-'));
    const older = core.createProject({ name: 'Older', rootPath: root });
    writeFileSync(join(root, '.gitignore'), '.shuriken/*.db\n*.rbxlx', 'utf8');
    core.openProject(older.id);
    core.openProject(older.id);
    const text = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(text.split('\n').filter((l) => l === '.shuriken/blender/')).toHaveLength(1);
    expect(text.startsWith('.shuriken/*.db\n*.rbxlx\n# Blender version history')).toBe(true);
  });

  it('escalates after repeated failures and resumes when the user retries', async () => {
    let fail = true;
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan')
          return {
            summary: 'two',
            tasks: [
              { key: 'a', title: 'Fragile task', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] },
              { key: 'b', title: 'Depends on it', kind: 'implement', role: 'roblox-engineer', objective: 'y', acceptanceCriteria: ['works'], verification: [], dependsOn: ['a'] },
            ],
          };
        if (kind === 'work') return fail ? { status: 'failed', summary: 'could not do it' } : { status: 'implemented', summary: 'ok' };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    ctx.updateSettings({ maxAttemptsPerTask: 2, permissionMode: 'ask' });
    const obj = core.orchestrator.submitObjective({ title: 'Fragile', description: 'x', skipResearch: true });
    const task = await waitFor(() => ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Fragile task' && t.status === 'escalated'));
    expect(task.attempts).toBe(2);
    const esc = ctx.governance.escalations('open').find((e) => e.taskId === task.id)!;
    expect(esc.kind).toBe('failure');
    await waitFor(() => ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Depends on it' && t.status === 'blocked'));
    fail = false;
    ctx.governance.resolveEscalation(esc.id, 'answered', 'retry');
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Depends on it')!.status).toBe('done');
  }, 60000);

  it('does not spend attempts when the agent runtime cannot start', async () => {
    let broken = true;
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'plan') return { summary: 'one', tasks: [{ key: 'a', title: 'Needs a runtime', kind: 'implement', role: 'roblox-engineer', objective: 'x', acceptanceCriteria: ['works'], verification: [] }] };
        if (kind === 'work') {
          if (broken) throw Object.assign(new Error('Claude Code native binary at X exists but failed to launch'), { errorKind: 'environment' });
          return { status: 'implemented', summary: 'ok' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const obj = core.orchestrator.submitObjective({ title: 'Runtime', description: 'x', skipResearch: true });
    await waitFor(() => ctx.audit.timeline({ limit: 50 }).find((e) => e.kind === 'provider.environment'));
    const task = ctx.tasks.list({ parentId: obj.id }).find((t) => t.title === 'Needs a runtime')!;
    expect(task.status).toBe('ready');
    expect(task.attempts).toBe(0);
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    broken = false;
  }, 60000);

  it('finalizes an objective left in ready once its tasks are complete', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    // e.g. after a regression repair, or an older recovery that re-queued the objective itself.
    const obj = ctx.tasks.create({ kind: 'objective', title: 'Left in ready', objective: 'x', role: 'executive', createdBy: 'user', status: 'ready' });
    const t = ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Finished work', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready' });
    for (const s of ['running', 'verifying', 'verified', 'done'] as const) ctx.tasks.setStatus(t.id, s);
    ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Follow-up idea', objective: 'y', role: 'roblox-engineer', createdBy: 'critic', status: 'proposed' });
    core.orchestrator.attach(ctx);
    core.orchestrator.resume();
    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done');
    expect(ctx.audit.timeline({ limit: 50 }).some((e) => e.kind === 'orchestrator.error')).toBe(false);
  }, 60000);

  it('re-runs an objective finalization interrupted by a restart', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const obj = ctx.tasks.create({ kind: 'objective', title: 'Interrupted suite', objective: 'x', role: 'executive', createdBy: 'user', status: 'ready' });
    const t = ctx.tasks.create({ parentId: obj.id, kind: 'implement', title: 'Finished work', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready' });
    for (const s of ['running', 'verifying', 'verified', 'done'] as const) ctx.tasks.setStatus(t.id, s);
    // The previous process died while the regression suite ran.
    ctx.tasks.setStatus(obj.id, 'running');
    ctx.tasks.setStatus(obj.id, 'verifying');
    const id = ctx.summary.id;
    core.closeProject();
    const reopened = core.openProject(id);
    // The setup pause is kept across the reopen (as for the user); resume as they would.
    core.orchestrator.resume();
    await waitFor(() => reopened.tasks.get(obj.id)?.status === 'done');
  }, 60000);

  it('recovers interrupted work after a restart', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const t = ctx.tasks.create({ kind: 'implement', title: 'Half done', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready' });
    ctx.tasks.setStatus(t.id, 'running');
    ctx.store.run(`INSERT INTO runs (id, task_id, role, provider_id, status, started_at) VALUES ('run_x', ?, 'roblox-engineer', 'fake', 'running', ?)`, [t.id, new Date().toISOString()]);
    // Simulate an app restart: reopen the project.
    const id = ctx.summary.id;
    core.closeProject();
    const reopened = core.openProject(id);
    reopened.updateSettings({ autonomy: 'manual' });
    expect(reopened.tasks.get(t.id)!.status).toBe('ready');
    expect(reopened.tasks.failures(t.id)[0]!.summary).toMatch(/interrupted/i);
    expect(core.runner.getRun(reopened, 'run_x')!.status).toBe('interrupted');
  });

  it('re-checks finished work after a restart instead of re-implementing it', async () => {
    const kinds: string[] = [];
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        kinds.push(kind);
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return { status: 'implemented', summary: 'redone' };
      },
    });
    core.orchestrator.pause();
    const t = ctx.tasks.create({ kind: 'implement', title: 'Built, not yet checked', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready' });
    ctx.tasks.setStatus(t.id, 'running');
    ctx.store.run(`INSERT INTO runs (id, task_id, role, provider_id, status, started_at, result_data) VALUES ('run_done', ?, 'roblox-engineer', 'fake', 'completed', ?, ?)`, [t.id, new Date().toISOString(), JSON.stringify({ status: 'implemented', summary: 'built the arena' })]);
    ctx.tasks.setStatus(t.id, 'implemented');
    ctx.tasks.setResumeRun(t.id, 'run_done');
    ctx.tasks.setStatus(t.id, 'verifying');
    // Simulate an app restart mid-verification.
    const id = ctx.summary.id;
    core.closeProject();
    const reopened = core.openProject(id);
    expect(reopened.tasks.get(t.id)!.status).toBe('ready');
    expect(reopened.tasks.get(t.id)!.attempts).toBe(0);
    core.orchestrator.resume();
    await waitFor(() => reopened.tasks.get(t.id)?.status === 'done');
    expect(kinds).toEqual(['review']);
    expect(reopened.tasks.get(t.id)!.result).toMatch(/built the arena/);
  }, 60000);
});

describe('director chat', () => {
  it('lists the conversation in order, newest window last', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const chat = core.director.chat()!;
    for (let i = 0; i < 5; i++) chat.add({ role: i % 2 ? 'director' : 'user', kind: 'text', text: `m${i}`, data: { i } });
    expect(chat.list().map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(chat.list(2).map((m) => m.text)).toEqual(['m3', 'm4']);
    expect(chat.findLatest('text', () => true)?.text).toBe('m4');
  });

  it('puts buttons to app pages under a reply (only pages that exist)', async () => {
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        return {
          intent: 'question',
          reply: 'The combo is ready — have a look.',
          show: [
            { page: 'animation', item: 'M1_1', label: 'See the combo' },
            { page: 'settings', label: 'Nope' },
            { page: 'viewer', label: 'Open the map' },
          ],
        };
      },
    });
    core.orchestrator.pause();
    ctx.tasks.create({ kind: 'objective', title: 'Fighting game', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    core.director.send('show me the new moves');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.kind === 'text'));
    const reply = chat.list().find((m) => m.role === 'director' && m.kind === 'text')!;
    expect(reply.data?.links).toEqual([
      { page: 'animation', item: 'M1_1', label: 'See the combo' },
      { page: 'viewer', item: undefined, label: 'Open the map' },
    ]);
  });

  it('sends a side request straight to one specialist, and controls tasks by title (no planner run)', async () => {
    let directorCalls = 0;
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        directorCalls++;
        return directorCalls === 1
          ? { intent: 'side_task', role: 'modeler', title: 'Lighthouse model', request: 'Model a stylized lighthouse in Blender; only in the Models panel, do not place it.', reply: 'A modeler is on it.' }
          : { intent: 'chat', reply: 'Done.', tasks: [{ action: 'first', task: 'arena art' }, { action: 'cancel', task: 'Old props' }, { action: 'cancel', task: 'nothing like this' }], feedback: 'The user wants approvals only for real risk.' };
      },
    });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Duels', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const art = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Arena art pass', objective: 'x', role: 'environment-artist', status: 'ready', createdBy: 'test' });
    const old = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Old props', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    const before = ctx.tasks.list({}).length;
    core.director.send('build me a lighthouse, only for the models panel');
    const chat = core.director.chat()!;
    // (The team is stopped: the reply also says the request waits for the word to go.)
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('A modeler is on it.')));
    const side = ctx.tasks.list({}).find((t) => t.title === 'Lighthouse model')!;
    expect(side).toMatchObject({ role: 'modeler', status: 'ready', parentId: goal.id, createdBy: 'director' });
    expect(side.objective).toMatch(/only in the Models panel/);
    expect(ctx.tasks.list({}).length).toBe(before + 1); // one task, no plan-update task
    core.director.send('do the arena art first and drop the old props');
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Done.')));
    expect(ctx.tasks.get(old.id)!.status).toBe('cancelled');
    // A control that names no task is admitted, not claimed.
    expect(chat.list().find((m) => m.role === 'director' && m.text.startsWith('Done.'))!.text).toMatch(/couldn't find "nothing like this"/);
    // Feedback about the app lands in the developers' log.
    expect(readFileSync(join(core.opts.dataDir, 'feedback.md'), 'utf8')).toMatch(/approvals only for real risk[\s\S]*The user wrote: do the arena art first/);
    expect(ctx.tasks.get(art.id)!.priority).toBeGreaterThan(Math.max(...ctx.tasks.list({}).filter((t) => t.id !== art.id).map((t) => t.priority)));
  });

  it('pivots at once when a change replaces work that is still being built: the old task stops and its dependents wait for the new one', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const old = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Model and rig a Griever in Kiln', objective: 'x', role: 'modeler', status: 'reviewing', createdBy: 'test' });
    const anim = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever walk and run', objective: 'x', role: 'animator', status: 'ready', createdBy: 'test', dependencies: [old.id] });
    const plan = ctx.tasks.create({ parentId: goal.id, kind: 'plan', title: 'Update plan: rework the Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const rework = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Griever rework from references', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test', dependencies: [old.id] });
    const planner = { kind: 'agent' as const, runId: 'run_plan', taskId: plan.id, role: 'executive', providerId: null, allowedTools: null };
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
    // Work in review isn't cancelled by accident...
    const refused = await core.tools.invoke('plan_cancel_task', { task: old.id, reason: 'replaced by the rework' }, planner);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/stop: true/);
    // ...but a rework stops it now, and what waited for it waits for the rework (which no longer waits for it).
    const r = await core.tools.invoke('plan_cancel_task', { task: old.id, reason: 'replaced by the rework', stop: true, replaced_by: rework.id }, planner);
    expect(r.isError, text(r)).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ cancelled: old.id, stopped: true, replacedBy: rework.id });
    expect(ctx.tasks.get(old.id)!.status).toBe('cancelled');
    expect(ctx.tasks.get(rework.id)!.dependencies).toEqual([]);
    expect(ctx.tasks.get(anim.id)!.dependencies).toEqual([rework.id]);
    // Finished work stays.
    const done = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze walls', objective: 'x', role: 'level-designer', status: 'done', createdBy: 'test' });
    expect((await core.tools.invoke('plan_cancel_task', { task: done.id, reason: 'x', stop: true }, planner)).isError).toBe(true);
  });

  it('resumes only the build the user wants: the rest is cancelled first and never starts', async () => {
    let prompt = '';
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        prompt = String(req.prompt ?? '');
        const planId = /\[ready\] Update plan: Four items[^\n]*id:(\S+)/.exec(prompt)?.[1] ?? 'missing';
        return {
          intent: 'resume',
          reply: 'Resuming only the Griever.',
          tasks: [
            { action: 'cancel', task: 'the sword-rack tasks' },
            { action: 'cancel', task: planId },
          ],
        };
      },
    });
    // Paused in an earlier session, with an older goal's work still waiting.
    core.orchestrator.pause();
    const oldGoal = ctx.tasks.create({ kind: 'objective', title: 'Ranked duels', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const rack = ctx.tasks.create({ parentId: oldGoal.id, kind: 'implement', title: 'build123d model pipeline check + test prop (duel-arena sword rack) in the Models panel', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    const planUpdate = ctx.tasks.create({ parentId: oldGoal.id, kind: 'plan', title: 'Update plan: Four items, to be folded into the plan', objective: 'x', role: 'executive', status: 'ready', createdBy: 'test' });
    const newGoal = ctx.tasks.create({ kind: 'objective', title: 'Griever', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    ctx.tasks.create({ parentId: newGoal.id, kind: 'implement', title: 'Griever model in Kiln', objective: 'x', role: 'modeler', status: 'ready', createdBy: 'test' });
    core.director.send('resume just the build I asked for, the rest can be killed');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text.startsWith('Resuming only')));
    // The director saw the older work with ids, and both controls landed before the resume.
    expect(prompt).toMatch(/Other unfinished work/);
    expect(prompt).toContain(`id:${rack.id}`);
    expect(ctx.tasks.get(rack.id)!.status).toBe('cancelled');
    expect(ctx.tasks.get(planUpdate.id)!.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 400));
    const started = core.runner.listRuns(ctx, { limit: 50 }).map((r) => r.taskId);
    expect(started).not.toContain(rack.id);
    expect(started).not.toContain(planUpdate.id);
  });

  it('opens a project blank, talks first, and starts the game from the chat like the start page', async () => {
    const before = process.env.SHURIKEN_PROJECTS_DIR;
    process.env.SHURIKEN_PROJECTS_DIR = mkdtempSync(join(tmpdir(), 'shuriken-projects-'));
    try {
      let directorCalls = 0;
      const { core } = await makeCore({
        respond: async (req) => {
          const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
          if (!('intent' in props)) return null;
          directorCalls++;
          // The director sees that no game exists yet.
          expect(req.prompt).toMatch(/No game has been started in this project yet/);
          return directorCalls === 1
            ? { intent: 'chat', reply: 'Hi! Tell me about the game you want.' }
            : { intent: 'new_goal', title: 'Lava Ninja Obby', request: 'A ninja obby over lava: wall runs, checkpoints, a timer.', reply: 'Setting it up now.' };
        },
      });
      core.orchestrator.pause();
      const blank = core.createBlankProject();
      const ctx = core.project!;
      expect(blank.name).toBe('Untitled game');
      expect(ctx.extras()).toMatchObject({ blank: true, placeFile: null });
      const chat = core.director.chat()!;
      expect(chat.list().some((m) => m.role === 'director' && /blank project/i.test(m.text))).toBe(true);

      // Small talk starts nothing.
      core.director.send('hi, what can you do?');
      await waitFor(() => chat.list().some((m) => m.text === 'Hi! Tell me about the game you want.'));
      expect(ctx.tasks.list({ kinds: ['objective'] })).toHaveLength(0);

      // A game idea names the project, creates its place and starts the build with the user's words.
      core.director.send('make a ninja obby where you wall-run over lava, with checkpoints and a speedrun timer');
      await waitFor(() => chat.list().some((m) => m.text === 'Setting it up now.'));
      const [goal] = ctx.tasks.list({ kinds: ['objective'] });
      expect(goal!.title).toBe('Lava Ninja Obby');
      expect(goal!.objective).toMatch(/A ninja obby over lava[\s\S]*In the user's own words: "make a ninja obby where you wall-run over lava/);
      expect(core.project!.summary.name).toBe('Lava Ninja Obby');
      expect(core.projects.get(blank.id)!.name).toBe('Lava Ninja Obby');
      expect(ctx.extras().blank).toBe(false);
      expect(ctx.extras().placeFile).toBe('lava-ninja-obby.rbxlx');
      expect(existsSync(join(blank.rootPath, 'lava-ninja-obby.rbxlx'))).toBe(true);
      expect(JSON.parse(readFileSync(join(blank.rootPath, '.shuriken', 'project.json'), 'utf8')).name).toBe('Lava Ninja Obby');
      // A second blank project gets a name of its own; one the user named keeps it when its game starts.
      const second = core.createBlankProject();
      expect(second.name).toBe('Untitled game');
      core.renameProject('  My   Obby  ');
      expect(core.projects.get(second.id)!.name).toBe('My Obby');
      core.director.send('make a lava obby');
      await waitFor(() => core.project!.tasks.list({ kinds: ['objective'] }).length === 1);
      expect(core.projects.get(second.id)!.name).toBe('My Obby');
      expect(core.project!.extras()).toMatchObject({ blank: false, userNamed: true, placeFile: 'my-obby.rbxlx' });
    } finally {
      if (before === undefined) delete process.env.SHURIKEN_PROJECTS_DIR;
      else process.env.SHURIKEN_PROJECTS_DIR = before;
    }
  });
});

describe('UI workshop', () => {
  it('keeps the last UI read with its audit, and the director sees the screens', async () => {
    let prompt = '';
    const { core, ctx } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        prompt = req.prompt;
        return { intent: 'question', reply: 'Here it is.', show: [{ page: 'ui', item: 'HUD', label: 'See the UI' }] };
      },
    });
    core.orchestrator.pause();
    ctx.tasks.create({ kind: 'objective', title: 'Obby', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const rpc = createRouter(core);
    expect(await rpc['ui.get']!({})).toBeNull();
    const hud: UiNode = { id: 1, name: 'HUD', cls: 'ScreenGui', enabled: true, kids: [{ id: 2, name: 'Tiny', cls: 'TextButton', pos: [0, 10, 0, 100], size: [0, 20, 0, 20], text: 'x', textSize: 14 }] };
    const saved = new UiStore(ctx.root).save({ source: 'StarterGui', screens: [hud], count: 1, truncated: false });
    expect(saved.findings.some((f) => f.path === 'HUD.Tiny' && /Small to tap/.test(f.message))).toBe(true);
    expect(((await rpc['ui.get']!({})) as { screens: UiNode[] }).screens[0]!.name).toBe('HUD');
    core.director.send('how does the UI look?');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text === 'Here it is.'));
    expect(prompt).toMatch(/UI screens \(1[^)]*\): HUD; audit: 0 problem\(s\), 1 warning\(s\)/);
    // The UI page is a page the director may link to.
    expect(chat.list().find((m) => m.text === 'Here it is.')!.data?.links).toEqual([{ page: 'ui', item: 'HUD', label: 'See the UI' }]);
  });
});

describe('model pictures', () => {
  it('shows an agent its model through the app, and says what to do where nothing can draw', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    const seen: Array<{ bytes: number; name?: string }> = [];
    const requests: RenderRequest[] = [];
    const core = await Core.create({
      dataDir,
      resourcesDir: resolve(__dirname, '..', 'resources'),
      appVersion: 'test',
      providers: [new FakeProvider({ respond: async () => null })],
      integrations: false,
      logToDisk: false,
      luau: new StubLuau(),
      render: async (req) => {
        requests.push(req);
        if (req.kind === 'model') seen.push({ bytes: Buffer.from(req.parts[0]!.glb, 'base64').length, name: req.name });
        return 'data:image/jpeg;base64,/9j/AA==';
      },
    });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    core.openProject(core.createProject({ name: 'Props', rootPath: root }).id);
    const models = join(root, 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 'Lantern.model.json'), JSON.stringify({ name: 'Lantern', hash: 'h', size: [3.8, 5.8, 3.8], triangles: 1501, vertices: 900, volume: 13.7, faces: 20, solids: 1, valid: true, tolerance: null, placements: [], updatedAt: new Date().toISOString() }));
    writeFileSync(join(models, 'Lantern.glb'), Buffer.from('glTF-fake-bytes'));
    const out = await core.invokeTool('model_view', { name: 'Lantern' }, 'ui');
    expect(out.isError).toBeFalsy();
    expect(out.content[0]).toEqual({ type: 'image', data: '/9j/AA==', mimeType: 'image/jpeg' });
    expect(out.content[1]).toMatchObject({ type: 'text', text: expect.stringMatching(/^Lantern \(no colour set, so drawn beige\): 3\.8 × 5\.8 × 3\.8 studs.*1\.1× a player's height \(tall\)/) });
    expect(seen).toEqual([{ bytes: 15, name: 'Lantern' }]);
    expect((await core.invokeTool('model_view', { name: 'Nope' }, 'ui')).isError).toBe(true);
    // Animations: a filmstrip request carries the clip, and a sword preset is drawn holding a sword.
    const anims = join(root, 'animations');
    mkdirSync(anims, { recursive: true });
    const clip = { name: 'Slash', loop: false, priority: 'Action', keys: [{ t: 0, poses: {} }, { t: 0.5, poses: {} }], markers: [{ t: 0.2, name: 'Hit' }] };
    writeFileSync(join(anims, 'Slash.anim.json'), JSON.stringify({ clip, preset: 'SwordSlash1', params: {}, updatedAt: new Date().toISOString() }));
    const strip = await core.invokeTool('animation_view', { name: 'Slash' }, 'ui');
    expect(strip.isError).toBeFalsy();
    expect(strip.content[1]).toMatchObject({ text: expect.stringMatching(/Slash: 0\.50 s, plays once, Action priority; markers Hit at 0\.20 s; drawn holding a sword \(right hand\)/) });
    expect(requests.at(-1)).toMatchObject({ kind: 'animation', sword: 'right', clip: { name: 'Slash' } });
    // Multi-part assets: a part shows with the rest of its assembly, each part at its origin in its own look.
    const part = (name: string, size: [number, number, number], origin: [number, number, number], color: string, material: string) => {
      writeFileSync(join(models, `${name}.model.json`), JSON.stringify({ name, hash: 'h', size, triangles: 100, vertices: 80, volume: 1, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], assembly: 'Chest', origin, color, material, updatedAt: new Date().toISOString() }));
      writeFileSync(join(models, `${name}.glb`), Buffer.from(`glTF-${name}`));
    };
    part('Chest_Body', [4, 2.6, 3.4], [0, 1.3, 0], '#1d3a39', 'Slate');
    part('Chest_Lid', [4.3, 0.9, 3.7], [0, 3.05, 0], '#2a2f3a', 'Metal');
    const asm = await core.invokeTool('model_view', { name: 'Chest_Lid' }, 'ui');
    expect(asm.isError).toBeFalsy();
    expect(asm.content[1]).toMatchObject({ text: expect.stringMatching(/^Chest, 2 parts \(Chest_Body: #1d3a39 Slate; Chest_Lid: #2a2f3a Metal\), assembled: 4\.3 × 3\.5 × 3\.7 studs/) });
    const req = requests.at(-1) as Extract<RenderRequest, { kind: 'model' }>;
    expect(req.name).toBe('Chest');
    expect(req.parts.map((x) => [x.origin, x.color, x.material])).toEqual([
      [[0, 1.3, 0], '#1d3a39', 'Slate'],
      [[0, 3.05, 0], '#2a2f3a', 'Metal'],
    ]);
    expect((await core.invokeTool('model_view', { name: 'Chest' }, 'ui')).isError).toBeFalsy();
    // An engine running without the app (tests, plain Node) says how to look instead.
    const { core: bare } = await makeCore({ respond: async () => null });
    const bm = join(bare.project!.root, 'models');
    mkdirSync(bm, { recursive: true });
    writeFileSync(join(bm, 'Lantern.model.json'), readFileSync(join(models, 'Lantern.model.json')));
    writeFileSync(join(bm, 'Lantern.glb'), Buffer.from('glTF-fake-bytes'));
    const bareOut = await bare.invokeTool('model_view', { name: 'Lantern' }, 'ui');
    expect(bareOut.isError).toBe(true);
    expect(JSON.stringify(bareOut.content)).toMatch(/roblox_screenshot/);
  });
});

describe('opening a project', () => {
  it('opens on hold: unfinished work waits until the user resumes or asks the director for work', async () => {
    let work = 0;
    const { core, ctx } = await makeCore({
      respond: async (req, kind) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('intent' in props) return { intent: 'change', request: 'Make the arena brighter.', reply: 'On it.' };
        if (kind === 'work') work++;
        return null;
      },
    });
    const id = ctx.summary.id;
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Arena art pass', objective: 'x', role: 'environment-artist', status: 'ready', createdBy: 'test' });
    // Leave it, and open it again the way the app does.
    core.closeProject();
    core.openProject(id, { hold: true });
    expect(core.orchestrator.state()).toMatchObject({ paused: true, held: true, queued: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(work).toBe(0);
    // Asking for work lifts the hold (a pause the user chose would stay).
    core.director.send('make the arena brighter');
    await waitFor(() => !core.orchestrator.state().paused);
    expect(core.orchestrator.state().held).toBe(false);
    // A project with nothing left to do opens as usual.
    core.orchestrator.pause();
    core.closeProject();
    const other = core.createProject({ name: 'Done', rootPath: mkdtempSync(join(tmpdir(), 'shuriken-proj-')) });
    core.openProject(other.id, { hold: true });
    expect(core.orchestrator.state()).toMatchObject({ paused: false, held: false });
  });
});

describe('manual control', () => {
  it('runs a single task on request while autonomy is manual', async () => {
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') return { status: 'implemented', summary: 'done by request' };
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    ctx.updateSettings({ autonomy: 'manual' });
    core.orchestrator.attach(ctx);
    const a = ctx.tasks.create({ kind: 'implement', title: 'Requested', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['x'], verification: [{ kind: 'critic' }] });
    const b = ctx.tasks.create({ kind: 'implement', title: 'Not requested', objective: 'y', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['y'], verification: [{ kind: 'critic' }] });
    core.orchestrator.runNow(a.id);
    await waitFor(() => ctx.tasks.get(a.id)?.status === 'done');
    expect(ctx.tasks.get(b.id)!.status).toBe('ready');
  }, 60000);
});

describe('several windows', () => {
  it('lets cores share the data folder but never the same project', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    const make = () => Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    const a = await make();
    cores.push(a);
    const b = await make();
    cores.push(b);
    const summary = a.createProject({ name: 'Shared', rootPath: mkdtempSync(join(tmpdir(), 'shuriken-proj-')) });
    a.openProject(summary.id);
    expect(() => b.openProject(summary.id)).toThrow(/already open in another Shuriken Studio window/);
    expect(b.project).toBeNull();
    a.closeProject();
    expect(b.openProject(summary.id).summary.id).toBe(summary.id);
    expect(() => a.openProject(summary.id)).toThrow(/already open/);
  });

  it('deletes a project only when no other tab has it open, and leaves its folder for the Recycle Bin', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    const make = () => Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    const a = await make();
    cores.push(a);
    const b = await make();
    cores.push(b);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const summary = a.createProject({ name: 'Doomed', rootPath: root });
    a.openProject(summary.id);
    // Open in the other tab: refused, nothing changes.
    expect(() => b.deleteProject(summary.id)).toThrow(/open in another window/);
    expect(b.projects.list().some((p) => p.id === summary.id)).toBe(true);
    // Open here: it closes, then goes; the folder is the app's to move to the Recycle Bin.
    expect(a.deleteProject(summary.id)).toEqual({ name: 'Doomed', rootPath: root });
    expect(a.project).toBeNull();
    expect(a.projects.list().some((p) => p.id === summary.id)).toBe(false);
    expect(existsSync(join(root, '.shuriken', 'project.json'))).toBe(true);
    expect(() => a.deleteProject(summary.id)).toThrow(/no longer exists/);
  });
});

describe('pausing', () => {
  it('keeps a pause across a restart and ends a timed pause by itself', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    expect(core.orchestrator.state().paused).toBe(true);
    // Reopening the project (as after an app restart) keeps it paused.
    const id = ctx.summary.id;
    core.closeProject();
    const reopened = core.openProject(id);
    expect(core.orchestrator.state().paused).toBe(true);
    expect(reopened.extras().paused).toBe(true);
    // A timed pause resumes on its own.
    core.orchestrator.pauseUntil(Date.now() + 300);
    expect(core.orchestrator.state().pausedUntil).not.toBeNull();
    await waitFor(() => !core.orchestrator.state().paused, 15000);
    expect(reopened.extras().paused).toBe(false);
    expect(reopened.extras().pausedUntil ?? null).toBeNull();
  }, 30000);
});

describe('sharing Studio', () => {
  it('runs a playtest check in one call, holds play mode only meanwhile, and waits in line', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    // A stand-in Studio: records what the tools ask of it.
    const calls: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.setPlaying = async (start: boolean) => {
      calls.push(start ? 'start' : 'stop');
      return { mode: start ? 'play' : 'edit', availableDataModels: start ? ['Server', 'Client'] : ['Edit'] };
    };
    studio.runLuau = async (code: string, dm: string) => {
      calls.push(`luau:${dm}`);
      if (code.includes('return "no character"')) return { ok: true, output: 'ready', durationMs: 1 };
      if (code.includes('GetLogHistory')) return { ok: true, output: JSON.stringify({ ok: true, errors: dm === 'Server' ? ['Boom at Combat:12'] : [] }), durationMs: 1 };
      return { ok: true, output: dm === 'Server' ? 'PASS' : 'client ok', durationMs: 1 };
    };
    const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'roblox-engineer', providerId: null, allowedTools: null };
    const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

    const r = await core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0, luau: 'return "PASS"', client_luau: 'return "client ok"' }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/Server probe: PASS\nClient probe: client ok\nErrors in the output \(1\):\n\[Server\] Boom at Combat:12/);
    expect(calls).toEqual(['start', 'luau:Server', 'luau:Server', 'luau:Client', 'luau:Server', 'luau:Client', 'stop']);
    expect(core.lease.holder).toBeNull();

    // Sleeping in Studio is refused before anything runs.
    calls.length = 0;
    const slept = await core.tools.invoke('roblox_run_luau', { code: 'task.wait(90) return os.date()' }, agent);
    expect(slept.isError).toBe(true);
    expect(text(slept)).toMatch(/waits 90 s inside Studio/);
    expect(calls).toEqual([]);

    // While another agent plays, "run" waits its turn instead of failing.
    core.lease.tryAcquire('run_other');
    const queued = core.tools.invoke('roblox_playtest', { action: 'run', seconds: 0 }, agent);
    await new Promise((res) => setTimeout(res, 100));
    expect(core.lease.waiting).toBe(1);
    expect(calls).toEqual([]);
    core.lease.release('run_other');
    expect((await queued).isError).toBeFalsy();
    expect(calls[0]).toBe('start');
    expect(core.lease.holder).toBeNull();
  }, 30000);
});

describe('an idle playtest gives way', () => {
  it("stops an agent's playtest that went a minute without Studio calls while others wait", async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const stops: boolean[] = [];
    (core.studio as unknown as Record<string, unknown>).setPlaying = async (start: boolean) => {
      stops.push(start);
      return { mode: 'edit', availableDataModels: ['Edit'] };
    };
    core.lease.tryAcquire('run_idle');
    // Up and playing (a playtest still loading is not idle).
    core.lease.markPlaying('run_idle');
    (core.lease as unknown as { lastActive: number }).lastActive = Date.now() - 61_000;
    // Someone waits: the watchdog (every 10 s) stops it and tells the owner next time.
    const waited = core.lease.waitFree('run_other', 30_000);
    expect(await waited).toBe(true);
    expect(stops).toEqual([false]);
    expect(core.lease.reclaimed.has('run_idle')).toBe(true);
  }, 30_000);
});

describe('custom rigs', () => {
  it('builds a rigged model into a template (segments, Motor6Ds, welds, attachments) and places a copy', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const { ModelStore } = await import('../src/core/modeling/model-store');
    const store = new ModelStore(root);
    const part = (name: string, segment: string, origin: [number, number, number]) =>
      store.save({ name, hash: `h-${name}`, size: [1, 1, 1], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', assembly: 'Stalker', origin, segment, upload: { assetId: String(100 + name.length), hash: `h-${name}`, at: '' } });
    part('Stalker_Body', 'Body', [0, 2, 0]);
    part('Stalker_Tail', 'Tail', [0, 2.4, 2]);
    writeFileSync(store.rigFile('Stalker'), JSON.stringify({ version: 1, model: 'Stalker', root: 'Body', joints: [{ name: 'Body', parent: null, part: 'Body', pivot: [0, 2, 0], kind: 'ball' }, { name: 'Tail', parent: 'Body', part: 'Tail', pivot: [0, 2.2, 1.5], kind: 'hinge', axis: [1, 0, 0] }], legs: [], attachments: [{ name: 'Sting', part: 'Tail', position: [0, 3, 2.5] }] }));
    const luau: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async (code: string) => {
      luau.push(code);
      if (code.includes('local RIGS = {')) return { ok: true, output: JSON.stringify({ built: ['Stalker'], failed: [] }), durationMs: 1 };
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Stalker', position: [0, 2, 0], notes: ['rests on Workspace.Baseplate (surface at y=0.00)'] }), durationMs: 1 };
    };
    const agent = { kind: 'agent' as const, runId: 'run_a', taskId: null, role: 'animator', providerId: null, allowedTools: null };
    const r = await core.tools.invoke('rig_build', { model: 'Stalker', place: { position: [0, 5, 0] } }, agent);
    expect(r.isError, r.content.map((c) => ('text' in c ? c.text : '')).join('')).toBeFalsy();
    expect(r.data).toMatchObject({ template: 'ReplicatedStorage.ShurikenRigs.Stalker', joints: ['Body', 'Tail'], attachments: ['Sting on Tail'], placed: { path: 'Workspace.Stalker' } });
    expect(luau).toHaveLength(2);
    expect(luau[0]).toMatch(/segment="Tail"/);
    expect(existsSync(join(root, 'world', 'Rigs.luau'))).toBe(true);
    // Without its rig, or before it's rigged, it says what to do.
    expect((await core.tools.invoke('rig_build', { model: 'Nope' }, agent)).content[0]).toMatchObject({ text: expect.stringMatching(/has no rig/) });
  });
});

describe('custom rig animations', () => {
  it('generates, checks and builds clips for a rigged model through the animation tools', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const { ModelStore } = await import('../src/core/modeling/model-store');
    const { griever } = await import('./rig-motion.fixtures');
    const store = new ModelStore(root);
    const g = griever();
    // The rigged model as its export leaves it: one part per segment (mesh centred on its box), and its rig.
    for (const [seg, pts] of Object.entries(g.points)) {
      const lo = [0, 1, 2].map((a) => Math.min(...pts.filter((_, i) => i % 3 === a)));
      const hi = [0, 1, 2].map((a) => Math.max(...pts.filter((_, i) => i % 3 === a)));
      const origin = [0, 1, 2].map((a) => (lo[a]! + hi[a]!) / 2) as [number, number, number];
      const name = `Griever_${seg}`;
      store.save({ name, hash: `h-${name}`, size: [0, 1, 2].map((a) => hi[a]! - lo[a]!) as [number, number, number], triangles: 12, vertices: pts.length / 3, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', assembly: 'Griever', origin, segment: seg });
      writeFileSync(store.paths(name).mesh, JSON.stringify({ v: pts.map((v, i) => v - origin[i % 3]!), n: [], t: [] }));
    }
    writeFileSync(store.rigFile('Griever'), JSON.stringify({ ...g.rig, joints: g.rig.joints.map((j) => ({ ...j, limits: j.limits ? { min: j.limits.min, max: j.limits.max } : null })) }));
    const agent = { kind: 'agent' as const, runId: 'run_a', taskId: null, role: 'animator', providerId: null, allowedTools: null };
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

    const presets = await core.tools.invoke('animation_presets', { rig: 'Griever' }, agent);
    expect(presets.data).toMatchObject({ rig: 'Griever', legs: expect.any(Array), motions: { walk: expect.any(String), sting: expect.any(String) } });
    expect((presets.data as { attachments: string[] }).attachments).toContain('Stinger_Tip on Tail_5');

    const walk = await core.tools.invoke('animation_create', { rig: 'Griever', motion: 'walk', params: { speed: 6 }, build: false }, agent);
    expect(walk.isError, text(walk)).toBeFalsy();
    expect(walk.data).toMatchObject({ name: 'GrieverWalk', rig: 'Griever', loop: true, findings: [], template: 'ReplicatedStorage.ShurikenRigs.Griever' });
    expect((walk.data as { groundSpeed: number }).groundSpeed).toBeCloseTo(6, 0);
    const saved = JSON.parse(readFileSync(join(root, 'animations', 'GrieverWalk.anim.json'), 'utf8'));
    expect(saved).toMatchObject({ preset: 'rig:walk', params: { speed: 6 }, clip: { rig: 'Griever' } });
    // The world builder carries it with its joints' parents (its root under the rig's HumanoidRootPart).
    const builder = readFileSync(join(root, 'world', 'Animations.luau'), 'utf8');
    expect(builder).toMatch(/name="GrieverWalk"/);
    expect(builder).toMatch(/\["Body"\]="HumanoidRootPart"/);

    const sting = await core.tools.invoke('animation_create', { rig: 'Griever', motion: 'sting', name: 'GrieverSting', build: false }, agent);
    expect(sting.data).toMatchObject({ markers: ['Hit @ 0.5s'], findings: [] });

    // A hand-keyed clip is checked against the rig's joints.
    const bad = await core.tools.invoke('animation_create', { rig: 'Griever', clip: { name: 'Wave', loop: false, priority: 'Action', keys: [{ t: 0, poses: { Wing: { rot: [0, 0, 0] } } }, { t: 1, poses: { Wing: { rot: [10, 0, 0] } } }] }, build: false }, agent);
    expect(text(bad)).toMatch(/unknown joint "Wing"/);
    const motionWithoutRig = await core.tools.invoke('animation_create', { motion: 'walk', build: false }, agent);
    expect(text(motionWithoutRig)).toMatch(/pass rig/);

    // An upper-body attack layers over running: only the torso, head and arms are keyed.
    const upper = await core.tools.invoke('animation_create', { name: 'SlashOnTheMove', preset: 'SwordSlash1', body_part: 'upper', build: false }, agent);
    expect(upper.isError, text(upper)).toBeFalsy();
    const upperFile = JSON.parse(readFileSync(join(root, 'animations', 'SlashOnTheMove.anim.json'), 'utf8')) as { params: object; clip: { keys: Array<{ poses: object }>; markers: unknown[] } };
    const keyed = new Set(upperFile.clip.keys.flatMap((k) => Object.keys(k.poses)));
    expect(keyed.has('RightUpperArm')).toBe(true);
    expect(['LowerTorso', 'LeftUpperLeg', 'RightFoot'].some((j) => keyed.has(j))).toBe(false);
    expect(upperFile.params).toMatchObject({ body_part: 'upper' });
    expect(upperFile.clip.markers.length).toBeGreaterThan(0);
    expect(text(await core.tools.invoke('animation_create', { rig: 'Griever', motion: 'walk', body_part: 'upper', build: false }, agent))).toMatch(/R15/);

    // Checked offline on the rig when Studio isn't there.
    const check = await core.tools.invoke('animation_check', { name: 'GrieverWalk' }, agent);
    expect(check.data).toMatchObject({ studio: expect.stringMatching(/offline/), findings: [] });
    expect((check.data as { groundSpeed: number }).groundSpeed).toBeGreaterThan(4);
    const list = await core.tools.invoke('animation_list', {}, agent);
    expect((list.data as { animations: Array<{ name: string; rig: string | null }> }).animations).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'GrieverWalk', rig: 'Griever' })]));
  });
});

describe('dock copilots', () => {
  it('shows the copilot the pictures the user attached, and keeps them with the message', async () => {
    const { core, provider, ctx } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('copilotReply' in props)) return null;
        return { copilotReply: `I see ${req.images?.length ?? 0} picture(s).` };
      },
    });
    core.orchestrator.pause();
    const png = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;
    const msg = core.copilots.send('ui', 'Make my shop look like this', { page: 'ui' }, [{ name: 'shop.png', dataUrl: png }]);
    const chat = core.copilots.chat('ui')!;
    await waitFor(() => chat.list().some((m) => m.role === 'copilot'));
    expect(chat.list().find((m) => m.role === 'copilot')!.text).toBe('I see 1 picture(s).');
    const run = provider.runs.find((r) => r.role === 'copilot-ui')!;
    expect(run.images).toEqual([{ mediaType: 'image/png', data: png.split(',')[1] }]);
    expect(run.prompt).toMatch(/They attached a picture \(above\), saved as \.shuriken\/attachments\/ui-\w+-1\.png/);
    const saved = (msg.data as { images: Array<{ file: string; name: string; mediaType: string }> }).images;
    expect(saved).toEqual([{ file: expect.stringMatching(/^attachments\/ui-\w+-1\.png$/), name: 'shop.png', mediaType: 'image/png' }]);
    expect(readFileSync(join(ctx.dir, saved[0]!.file)).toString('hex')).toBe('89504e470d0a1a0a0000000d49484452');
    // Anything but a small picture is refused, and nothing outside the attachments folder can be read back.
    expect(() => core.copilots.send('ui', 'x', {}, [{ dataUrl: 'data:text/html;base64,PGI+' }])).toThrow(/PNG, JPEG, WebP or GIF/);
    const { attachmentDataUrl } = await import('../src/core/director/attachments');
    expect(attachmentDataUrl(ctx, saved[0]!.file)).toBe(png);
    expect(() => attachmentDataUrl(ctx, '../project.db')).toThrow(/Not an attachment/);
  });

  it('talks in its own channel, continues its session, makes drafts with its tools and tells the director', async () => {
    const { core, provider, ctx } = await makeCore({
      respond: async (req, _kind, call) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('intent' in props) return { intent: 'question', reply: 'Noted.' };
        if (!('copilotReply' in props)) return null;
        if (!req.resumeSessionId) {
          await call('animation_create', { preset: 'SwordSlash1', name: 'Slash1', build: false });
          return { copilotReply: 'Made **Slash1** from the sword preset.', digest: 'Added Slash1 (sword slash preset)', show: [{ page: 'animation', item: 'Slash1', label: 'See it' }, { page: 'nowhere', label: 'x' }] };
        }
        return { copilotReply: 'That needs the combat code: hand it to the director.', handoff: 'Play Slash1 on left click in the combat script, hit on its Hit marker.' };
      },
    });
    core.orchestrator.pause();
    const channel = 'copilot:animation';
    core.copilots.send('animation', 'a quick sword slash', { page: 'animation', item: 'SwordSlash1', note: 'preset' });
    const chat = core.copilots.chat('animation')!;
    await waitFor(() => chat.list().some((m) => m.role === 'copilot'));
    const first = chat.list().find((m) => m.role === 'copilot')!;
    // A draft turn: what it made is a draft in the dock, and the digest says so to the director.
    expect(first).toMatchObject({ channel, kind: 'text', text: 'Made **Slash1** from the sword preset.', data: { mode: 'draft', drafts: [{ name: 'Slash1', draft: true }], digest: 'Draft in the dock, not in the game: Added Slash1 (sword slash preset)', links: [{ page: 'animation', item: 'Slash1', label: 'See it' }] } });
    // It used its dock's tools (the clip exists, as a draft), and its first message carried the dock and what the user looked at.
    expect(JSON.parse(readFileSync(join(ctx.root, 'animations', 'Slash1.anim.json'), 'utf8'))).toMatchObject({ draft: true, clip: { name: 'Slash1' } });
    const opening = provider.runs.find((r) => r.role === 'copilot-animation')!;
    expect(opening.prompt).toMatch(/The dock now:/);
    expect(opening.prompt).toMatch(/looking at: SwordSlash1/);
    // The director's chat is separate.
    expect(core.director.chat()!.list()).toEqual([]);

    // The next message continues the same provider session.
    core.copilots.send('animation', 'now make it play when I click');
    await waitFor(() => chat.list().filter((m) => m.role === 'copilot').length === 2);
    const runs = provider.runs.filter((r) => r.role === 'copilot-animation');
    expect(runs[1]!.resumeSessionId).toBe(`s-${runs[0]!.runId}`);
    expect(chat.list().filter((m) => m.role === 'copilot')[1]!.data).toMatchObject({ handoff: expect.stringMatching(/left click/) });

    // The director sees what was done in the docks.
    core.director.send('what did I change?');
    await waitFor(() => core.director.chat()!.list().some((m) => m.role === 'director'));
    const directorRun = provider.runs.find((r) => r.role === 'director')!;
    expect(directorRun.prompt).toMatch(/Animation copilot, \d+ min ago: Draft in the dock, not in the game: Added Slash1/);

    // "New conversation" starts a fresh session.
    core.copilots.reset('animation');
    core.copilots.send('animation', 'hello again');
    await waitFor(() => provider.runs.filter((r) => r.role === 'copilot-animation').length === 3);
    await waitFor(() => chat.list().filter((m) => m.role === 'copilot').length === 3);
    expect(provider.runs.filter((r) => r.role === 'copilot-animation')[2]!.resumeSessionId).toBeNull();
  });
});

describe('send to Studio', () => {
  it('places a model where Studio looks and an animation on a stand-in that plays it, selecting each', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const { ModelStore } = await import('../src/core/modeling/model-store');
    new ModelStore(root).save({ name: 'Crate', hash: 'h-crate', size: [3, 3, 3], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', upload: { assetId: '555', hash: 'h-crate', at: '' } });
    const luau: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async (code: string) => {
      luau.push(code);
      if (code.includes('cf.LookVector * 1000')) return { ok: true, output: '[12,0,-4]', durationMs: 1 };
      if (code.includes('Selection')) return { ok: true, output: 'Workspace.x', durationMs: 1 };
      if (code.includes('local CLIPS = {')) return { ok: true, output: JSON.stringify({ built: [{ name: 'Wave', id: 'kfs1' }], failed: [] }), durationMs: 1 };
      if (code.includes('CreateHumanoidModelFromDescription')) return { ok: true, output: 'Workspace.WavePreview', durationMs: 1 };
      if (code.includes('ShurikenPreview')) return { ok: true, output: 'ok', durationMs: 1 };
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Crate', position: [12, 1.5, -4], notes: [] }), durationMs: 1 };
    };
    const sent = await core.send.model('Crate');
    expect(sent).toMatchObject({ ok: true, placed: 'Workspace.Crate' });
    // Placed at the camera's target (resting on the ground), then selected.
    expect(luau.find((c) => c.includes('place("Crate"'))).toMatch(/pos=\{12,0,-4\}/);
    expect(luau.at(-1)).toMatch(/Selection/);

    luau.length = 0;
    await core.invokeTool('animation_create', { preset: 'SwordSlash1', name: 'Wave', build: false });
    const anim = await core.send.animation('Wave');
    expect(anim).toMatchObject({ ok: true, placed: 'Workspace.WavePreview', note: expect.stringMatching(/press Run/) });
    const preview = luau.find((c) => c.includes('sc.Name = "ShurikenPreview"'))!;
    expect(preview).toMatch(/Anims\.play\(model, \\"Wave\\"\)/);
    expect(luau.find((c) => c.includes('CreateHumanoidModelFromDescription'))).toMatch(/CFrame\.new\(12, 3, -4\)/);

    // Studio closed: it says what to do instead of failing obscurely.
    studio.availability = () => ({ ok: false, reason: 'Studio MCP disconnected' });
    expect(await core.send.model('Crate')).toMatchObject({ ok: false, error: expect.stringMatching(/isn't connected/) });
  });
});

describe('gear', () => {
  it('turns models into a Tool held by its grip and an Accessory worn where it was modeled', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const { ModelStore } = await import('../src/core/modeling/model-store');
    const store = new ModelStore(root);
    const part = (name: string, assembly: string, origin: [number, number, number], size: [number, number, number], material = 'SmoothPlastic') =>
      store.save({ name, hash: `h-${name}`, size, triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', assembly, origin, segment: 'Handle', material, upload: { assetId: String(300 + name.length), hash: `h-${name}`, at: '' } });
    part('Sword_Blade', 'Sword', [0, 2.2, 0], [0.2, 3, 0.6]);
    part('Sword_Hilt', 'Sword', [0, 0.2, 0], [0.35, 1, 0.35]);
    part('Sword_Rune', 'Sword', [0, 1.4, 0], [0.1, 0.4, 0.1], 'Neon');
    // The grip from Blender: one joint at the hilt, every part bound to it, and a Grip attachment.
    writeFileSync(store.rigFile('Sword'), JSON.stringify({ version: 1, model: 'Sword', root: 'Handle', joints: [{ name: 'Handle', parent: null, part: 'Handle', pivot: [0, 0.2, 0], kind: 'hinge' }], legs: [], attachments: [{ name: 'Grip', part: 'Handle', position: [0, 0.2, 0] }] }));
    store.save({ name: 'Helmet', hash: 'h-helmet', size: [1.5, 0.8, 1.5], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'blender', origin: [0, 5.5, 0], upload: { assetId: '399', hash: 'h-helmet', at: '' } });
    const luau: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async (code: string) => {
      luau.push(code);
      return { ok: true, output: JSON.stringify({ built: ['Sword', 'IronHelm'], failed: [], ...(code.includes('tameBloom()') ? { bloom: 'toned Lighting.Bloom down' } : {}) }), durationMs: 1 };
    };
    const agent = { kind: 'agent' as const, runId: 'run_g', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');

    const sword = await core.tools.invoke('model_gear', { model: 'Sword', kind: 'tool' }, agent);
    expect(sword.isError, text(sword)).toBeFalsy();
    expect(sword.data).toMatchObject({ gear: 'ServerStorage.ShurikenGear.Sword', kind: 'tool', point: [0, 0.2, 0], bloom: 'toned Lighting.Bloom down' });
    expect((sword.data as { usage: string }).usage).toMatch(/player\.Backpack/);
    // The hand holds the hilt (the part the grip is in): it becomes the Handle; the others weld to it.
    expect(luau[0]).toMatch(/name="Sword_Hilt"(?:(?!name=).)*handle=true/);
    expect(luau[0]).toMatch(/item\.Grip = CFrame\.new\(offset\)/);

    const helm = await core.tools.invoke('model_gear', { model: 'Helmet', kind: 'accessory', attach_to: 'HatAttachment', name: 'IronHelm' }, agent);
    expect(helm.data).toMatchObject({ gear: 'ServerStorage.ShurikenGear.IronHelm', attachTo: 'HatAttachment', point: [0, 5.456, 0] });
    expect(readFileSync(join(root, 'world', 'Gear.luau'), 'utf8')).toMatch(/attachTo="HatAttachment"/);
    expect(JSON.parse(readFileSync(join(root, 'models', 'gear.json'), 'utf8')).gear.map((g: { name: string }) => g.name)).toEqual(['IronHelm', 'Sword']);

    // What it can't do, it says.
    expect(text(await core.tools.invoke('model_gear', { model: 'Helmet', kind: 'tool' }, agent))).toMatch(/no grip point/);
    expect(text(await core.tools.invoke('model_gear', { model: 'Helmet', kind: 'tool' }, agent))).toMatch(/Ask Kiln for one: kiln_request \{model: "Helmet", kind: "fix", sockets: \[\{name: "Grip"/);
    // The Grip socket Kiln delivered for a model (read back into its record) is the grip: no coordinates typed.
    const { writeFamily } = await import('../src/core/modeling/kiln-family');
    writeFamily(root, { family: 'Helmet', projectId: 'helmet-1', members: [{ name: 'Helmet' }], fits: [], sockets: [{ name: 'Grip', joins: 'the hand holding it' }], read: { at: new Date().toISOString(), members: { Helmet: { size: [1.5, 0.8, 1.5], tris: 12, parts: 1, sockets: { Grip: { position: [0, 5.2, 0], rotation: [0, 0, 0], from: 'model' } } } }, missing: [] } });
    const held = await core.tools.invoke('model_gear', { model: 'Helmet', kind: 'tool', name: 'HeldHelm' }, agent);
    expect(held.isError, text(held)).toBeFalsy();
    expect(held.data).toMatchObject({ kind: 'tool', point: [0, 5.2, 0] });
    expect(text(await core.tools.invoke('model_gear', { model: 'Helmet', kind: 'accessory', attach_to: 'Elbow' }, agent))).toMatch(/attach_to must be one of/);
    expect(text(await core.tools.invoke('model_gear', { model: 'Helmet', kind: 'accessory', attach_to: 'HatAttachment', into: 'StarterPack' }, agent))).toMatch(/worn, not carried/);
  });
});

describe('removing models', () => {
  it('drops replaced models by part or by the whole model, for the modeler and from the Models page', async () => {
    const { core, ctx, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const { ModelStore } = await import('../src/core/modeling/model-store');
    const { ROLES, hiddenToolsFor } = await import('../src/core/agents/roles');
    const store = new ModelStore(root);
    const meta = (name: string, extra: Record<string, unknown> = {}) => store.save({ name, hash: 'h', size: [1, 1, 1], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'build123d', ...extra });
    for (const n of ['Old_Body', 'Old_Lid', 'Keep']) meta(n);
    meta('Chest_Wood', { assembly: 'Chest', source: 'blender' });
    meta('Chest_Gem', { assembly: 'Chest', source: 'blender' });
    const as = (role: string) => ({ kind: 'agent' as const, runId: 'run_x', taskId: null, role, providerId: null, allowedTools: null, hiddenTools: hiddenToolsFor(ROLES[role]!) });
    // Only the modeling workshop sees it.
    expect((await core.tools.invoke('model_remove', { names: ['Old_Body'] }, as('level-designer'))).isError).toBe(true);
    const r = await core.tools.invoke('model_remove', { names: ['Old_Body', 'Old_Lid', 'Nope'] }, as('modeler'));
    expect(r.data).toEqual({ removed: ['Old_Body', 'Old_Lid'], missing: ['Nope'] });
    expect(existsSync(join(root, 'models', 'Old_Body.model.json'))).toBe(false);
    // The Models page removes a whole multi-part model by its name.
    const router = createRouter(core);
    expect(await router['models.remove']!({ names: ['Chest'] })).toEqual({ removed: ['Chest_Gem', 'Chest_Wood'], missing: [] });
    expect(store.all().map((m) => m.name)).toEqual(['Keep']);
    void ctx;
  });
});

describe('world rebuilds while others build', () => {
  it("re-runs only the caller's own builders when other agents are working", async () => {
    const { core, ctx, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    mkdirSync(join(root, 'world'), { recursive: true });
    writeFileSync(join(root, 'world', 'Arena.luau'), 'return "arena built"');
    writeFileSync(join(root, 'world', 'Lobby.luau'), 'return "lobby built"');
    const ran: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    studio.runLuau = async (code: string) => {
      ran.push(code.includes('arena built') ? 'Arena' : code.includes('lobby built') ? 'Lobby' : 'other');
      return { ok: true, output: 'ok', durationMs: 1 };
    };
    let active = ['run_me', 'run_other'];
    (core.runner as unknown as { activeRuns: () => string[] }).activeRuns = () => active;
    const task = ctx.tasks.create({ parentId: null, kind: 'implement', title: 'Arena', objective: 'x', role: 'level-designer', status: 'ready', files: ['world/arena.luau'], createdBy: 'user' });
    const as = (taskId: string | null) => ({ kind: 'agent' as const, runId: 'run_me', taskId, role: 'level-designer', providerId: null, allowedTools: null });
    const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');

    const mine = await core.tools.invoke('world_rebuild', {}, as(task.id));
    expect(text(mine)).toMatch(/only your task's builders, Arena\.luau, because other agents are working/);
    expect(ran.filter((r) => r !== 'other')).toEqual(['Arena']);
    const unknown = await core.tools.invoke('world_rebuild', {}, as(null));
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Pass files/);
    // Alone, or with files named, it runs what was asked.
    ran.length = 0;
    active = ['run_me'];
    await core.tools.invoke('world_rebuild', {}, as(task.id));
    expect(ran.filter((r) => r !== 'other')).toEqual(['Arena', 'Lobby']);
  });
});

describe('place guard', () => {
  it('backs up recovery copies, saves on request, and rebuilds a place that lost its world', async () => {
    const { PlaceGuard } = await import('../src/core/roblox/place-guard');
    const { PlaytestLease } = await import('../src/core/roblox/playtest-lease');
    const { writeFileSync, mkdirSync, utimesSync } = await import('node:fs');
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    writeFileSync(join(ctx.root, 'arena.rbxlx'), '<roblox/>');
    ctx.updateExtras({ placeFile: 'arena.rbxlx' });
    mkdirSync(join(ctx.root, 'world'), { recursive: true });
    writeFileSync(join(ctx.root, 'world', 'Arena.luau'), 'return "built"');
    const autosaves = mkdtempSync(join(tmpdir(), 'shuriken-autosaves-'));
    const recovery = join(autosaves, 'arena_AutoRecovery_0.rbxl');
    writeFileSync(recovery, 'v1');
    const ran: string[] = [];
    const saves: string[] = [];
    let pushed = 0;
    let held = 0;
    const studio = {
      connected: true,
      binding: 'arena.rbxlx',
      luauJson: async () => ({ parts: 2 }),
      runLuau: async (code: string) => {
        ran.push(code);
        return { ok: true, output: 'ok', durationMs: 1 };
      },
    } as never;
    const deps = {
      project: () => ctx,
      studio,
      lease: new PlaytestLease(),
      bus: core.bus,
      log: core.log,
      autoSave: () => true,
      pushCode: async () => {
        pushed++;
      },
      hold: (p: Promise<unknown>) => {
        held++;
        void p;
      },
      autoSavesDir: autosaves,
      save: async (f: string) => {
        saves.push(f);
        return { ok: true, message: 'saved' };
      },
      userBusy: async () => false,
    };
    const guard = new PlaceGuard(deps);
    // Studio's recovery copy is filed once, and again when Studio writes a newer one.
    expect(await guard.backup()).toMatch(/place-.*\.rbxl$/);
    expect(await guard.backup()).toBeNull();
    writeFileSync(recovery, 'v2');
    utimesSync(recovery, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(await guard.backup()).toMatch(/place-.*\.rbxl$/);
    // An empty place with world builders is rebuilt, code pushed, the team held, then saved.
    expect(await guard.heal(ctx)).toBe('rebuilt');
    expect(ran.some((c) => c.includes('return "built"'))).toBe(true);
    expect(pushed).toBe(1);
    expect(held).toBe(1);
    expect(saves).toEqual([join(ctx.root, 'arena.rbxlx')]);
    expect(await guard.heal(ctx)).toBe('skipped');
    expect(core.director.chat()!.list().some((m) => /Rebuilt the world/.test(m.text))).toBe(true);
    // Never pull Studio in front of an app the user is working in (unless they pressed Save).
    const busy = new PlaceGuard({ ...deps, userBusy: async () => true });
    expect((await busy.saveNow('periodic')).ok).toBe(false);
    expect((await busy.saveNow('user', true)).ok).toBe(true);
  }, 30000);
});

describe('suggestion bubbles that know the game', () => {
  it('writes every place’s bubbles from the game in one small call, keeps them, and writes again only when the game changed', async () => {
    let prompt = '';
    const bubble = (label: string) => ({ label, prompt: `${label}: the full, specific request.` });
    const { core, ctx, provider } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('effects' in props && 'director' in props)) return null;
        prompt = String(req.prompt ?? '');
        return {
          director: [bubble('Make the Griever scarier'), bubble('More detail in the maze')],
          animation: [bubble('A heavier run for the Griever')],
          audio: [bubble('A roar for the Griever')],
          ui: [bubble('A maze minimap')],
          effects: [bubble('Sparks when the Griever strikes'), { label: 'x'.repeat(80), prompt: 'too long' }],
        };
      },
    });
    const { LiveSuggestions } = await import('../src/core/director/live-suggestions');
    core.orchestrator.pause();
    const live = new LiveSuggestions({ runner: core.runner, bus: core.bus, log: core.logger.scope('test'), enabled: () => true });
    // An empty game gets no call.
    expect(await live.refresh(ctx)).toBe(false);
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Maze Runner: a Griever that chases players', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Maze test map with vines', objective: 'x', role: 'level-designer', status: 'done', createdBy: 'test' });
    expect(await live.refresh(ctx)).toBe(true);
    expect(prompt).toMatch(/Maze Runner: a Griever that chases players[\s\S]*Maze test map with vines/);
    expect(live.get(ctx, 'director')!.map((s) => s.label)).toEqual(['Make the Griever scarier', 'More detail in the maze']);
    expect(live.get(ctx, 'effects')).toEqual([bubble('Sparks when the Griever strikes')]);
    expect(provider.runs.filter((r) => r.role === 'suggester')).toHaveLength(1);
    // Kept: the same game asks for nothing new, and a second set waits for the throttle.
    const again = new LiveSuggestions({ runner: core.runner, bus: core.bus, log: core.logger.scope('test'), enabled: () => true });
    expect(again.get(ctx, 'audio')).toEqual([bubble('A roar for the Griever')]);
    expect(await live.refresh(ctx)).toBe(false);
    expect(provider.runs.filter((r) => r.role === 'suggester')).toHaveLength(1);
  });

  it('keeps the director’s and a copilot’s follow-up bubbles with their replies', async () => {
    const { core } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('intent' in props) return { intent: 'question', reply: 'The Griever is being rigged.', suggestions: [{ label: 'Make it scarier', prompt: 'Make the Griever scarier: longer spikes, a wet sheen, a slower, heavier walk.' }] };
        return null;
      },
    });
    core.orchestrator.pause();
    core.director.send('how is the griever going?');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.text === 'The Griever is being rigged.'));
    const reply = chat.list().find((m) => m.role === 'director' && m.text === 'The Griever is being rigged.')!;
    expect(reply.data).toMatchObject({ suggestions: [{ label: 'Make it scarier', prompt: expect.stringMatching(/longer spikes/) }] });
  });
});

describe('audio drafts', () => {
  it('keeps what the user makes in the Audio dock a draft until they add it to the game', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    const { SoundLibrary } = await import('../src/core/audio/audio-library');
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
    const lib = new SoundLibrary(root);
    lib.save({ name: 'Jump', kind: 'sfx', source: 'generated', assetId: '123', volume: 0.6, looped: false });
    // Made in the dock under a name the game already has: a draft beside it, the game's Jump untouched.
    const made = await core.invokeTool('audio_sfx', { name: 'Jump', preset: 'jump' }, 'ui');
    expect(made.isError, text(made)).toBeFalsy();
    expect(JSON.parse(text(made))).toMatchObject({ name: 'Jump2', draft: true });
    expect(lib.get('Jump')!.assetId).toBe('123');
    expect(lib.get('Jump2')).toMatchObject({ draft: true, assetId: null, file: 'assets/audio/sfx/jump2.mp3' });
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).not.toContain('Jump2');
    // The team's sounds go straight into the game.
    const team = await core.invokeTool('audio_sfx', { name: 'Coin', preset: 'coin' }, 'agent');
    expect(team.isError, text(team)).toBeFalsy();
    expect(lib.get('Coin')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toContain('name="Coin"');
    // Added as the better take of Jump: it replaces it in the game (and needs uploading again).
    const used = await core.invokeTool('audio_use', { name: 'Jump2', as: 'Jump' }, 'ui');
    expect(used.isError, text(used)).toBeFalsy();
    expect(JSON.parse(text(used))).toMatchObject({ name: 'Jump', replaced: 'Jump', was: 'Jump2' });
    expect(lib.get('Jump2')).toBeNull();
    expect(lib.get('Jump')).toMatchObject({ file: 'assets/audio/sfx/jump2.mp3', assetId: null });
    expect(lib.get('Jump')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toContain('name="Jump"');
  }, 60000);
});

describe('agent context', () => {
  it('lists the workshop content by name with how to play it', async () => {
    const { core, ctx, root } = await makeCore({ respond: async () => null });
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    const { buildPreset } = await import('../src/core/animation/presets');
    const { EffectStore } = await import('../src/core/effects/effects-service');
    const { buildEffect } = await import('../src/core/effects/presets');
    const { SoundLibrary } = await import('../src/core/audio/audio-library');
    new AnimationStore(root).save({ clip: buildPreset('SwordSlash1', 'Slash1'), preset: 'SwordSlash1' });
    new EffectStore(root).save({ effect: buildEffect('HitSpark', 'SwordHit'), preset: 'HitSpark' });
    new SoundLibrary(root).save({ name: 'SwordSwing', kind: 'sfx', source: 'generated', assetId: null, volume: 0.6, looped: false });
    const { ROLES } = await import('../src/core/agents/roles');
    const pkg = core.compiler.compile(ctx, { runId: 'r1', role: ROLES['roblox-engineer']!, task: null, directive: 'Wire sword combat feedback' });
    const content = pkg.sections.find((s) => s.key === 'content');
    expect(content?.body).toContain('Slash1 (0.5s, Hit @0.2s)');
    expect(content?.body).toContain('require(game.ReplicatedStorage.Shared.ShurikenAnimations)');
    expect(content?.body).toContain('SwordHit (burst)');
    expect(content?.body).toContain('SwordSwing (sfx, NOT uploaded yet: silent in game)');
    const world = pkg.sections.find((s) => s.key === 'world');
    expect(world?.body).toContain('Generated by the workshops');
  });
});

describe('plugging in a game', () => {
  it('pulls its scripts in, commits them, studies it, and the director and agents work from the study', async () => {
    const { FakeStudio } = await import('./helpers/fake-studio');
    const { GameAdoption } = await import('../src/core/projects/adoption');
    const { GitService } = await import('../src/core/git/git-service');
    const { ROLES } = await import('../src/core/agents/roles');
    const { core, provider, ctx, root } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('gameSummary' in props)
          return {
            gameSummary: 'A lava obby: players climb past lava bricks to the top.',
            systems: [{ name: 'Checkpoints', purpose: 'Saves the last pad a player touched.', files: ['src/ServerScriptService/Main.server.luau'] }],
            conventions: ['Plain ModuleScripts in ReplicatedStorage'],
            risks: ['The lava brick requires a module by asset id (a backdoor)'],
            suggestions: ['Remove the backdoor in the lava brick'],
            chips: [{ label: 'Remove the backdoor in the lava', prompt: 'Remove the backdoor in the lava brick: delete the require(123456789) in Workspace/Lava/Kill and keep the lava killing players.' }, { label: 'x'.repeat(120), prompt: 'too long a label' }],
            greeting: 'I read your lava obby: checkpoints, lava, a climb to the top. One thing first: the lava brick loads a module by id, which is a backdoor. What would you like to change?',
          };
        if ('intent' in props) return { intent: 'question', reply: 'It is a lava obby.' };
        return null;
      },
    });
    core.orchestrator.pause();
    const studio = new FakeStudio();
    studio.scripts.set('ServerScriptService/Main', { className: 'Script', source: 'print("checkpoints")' });
    studio.scripts.set('ReplicatedStorage/Config', { className: 'ModuleScript', source: 'return { lives = 3 }' });
    studio.scripts.set('Workspace/Lava/Kill', { className: 'Script', source: 'require(123456789)' });
    const adoption = new GameAdoption({ studio: studio.asAdapter(), runner: core.runner, bus: core.bus, log: core.logger.scope('test') });
    await adoption.plugIn(ctx, { from: 'studio', place: 'Lava Obby', placeId: '123' });

    expect(readFileSync(join(root, 'src/ServerScriptService/Main.server.luau'), 'utf8')).toBe('print("checkpoints")');
    expect(readFileSync(join(root, 'src/Workspace/Lava/Kill.server.luau'), 'utf8')).toBe('require(123456789)');
    expect(ctx.extras()).toMatchObject({ syncMode: 'shuriken', adopted: { from: 'studio', place: 'Lava Obby', placeId: '123', pulled: 3, skipped: 0 } });
    expect(ctx.extras().adopted!.studiedAt).toBeTruthy();
    expect(readFileSync(join(ctx.dir, 'instructions.md'), 'utf8')).toMatch(/EXISTING game[\s\S]*\| src\/Workspace \| Workspace \|/);
    const dossier = JSON.parse(readFileSync(join(ctx.dir, 'dossier.json'), 'utf8')) as { complete: boolean; scan: { flags: Array<{ kind: string }> }; chips: Array<{ label: string; prompt: string }> };
    expect(dossier.complete).toBe(true);
    expect(dossier.scan.flags.map((f) => f.kind)).toEqual(['remote require']);
    expect(dossier.chips).toEqual([{ label: 'Remove the backdoor in the lava', prompt: 'Remove the backdoor in the lava brick: delete the require(123456789) in Workspace/Lava/Kill and keep the lava killing players.' }]);
    expect(readFileSync(join(ctx.dir, 'dossier.md'), 'utf8')).toMatch(/## Systems[\s\S]*Checkpoints[\s\S]*## Facts/);
    if (await GitService.version()) expect((await ctx.git.log(5)).map((l) => l.subject).join('\n')).toMatch(/Plugged in Test Game: the game as it was/);

    // The analyst read the files and the flagged line; the director greeted with its chips.
    const analyst = provider.runs.find((r) => r.role === 'analyst')!;
    expect(analyst.prompt).toMatch(/src\/Workspace\/Lava\/Kill\.server\.luau:1 \[remote require\] require\(123456789\)/);
    const greeting = core.director.chat()!.list().find((m) => m.role === 'director' && m.data?.study === true)!;
    expect(greeting.text).toMatch(/^I read your lava obby/);
    expect(greeting.data).toMatchObject({ suggestions: [{ label: 'Remove the backdoor in the lava', prompt: 'Remove the backdoor in the lava brick: delete the require(123456789) in Workspace/Lava/Kill and keep the lava killing players.' }] });

    // The director knows it's an existing game and what the study found.
    core.director.send('what is this game?');
    await waitFor(() => core.director.chat()!.list().some((m) => m.role === 'director' && m.text === 'It is a lava obby.'));
    const director = provider.runs.filter((r) => r.role === 'director').at(-1)!;
    expect(director.prompt).toMatch(/This is an EXISTING game the user plugged in \(from the Studio place "Lava Obby"\)/);
    expect(director.prompt).toMatch(/What its study found:\nA lava obby/);
    // Every agent's context carries the study.
    const pkg = core.compiler.compile(ctx, { runId: 'r1', role: ROLES['roblox-engineer']!, task: null, directive: 'Add a lives counter' });
    expect(pkg.sections.find((s) => s.key === 'study')?.body).toMatch(/Checkpoints/);
  });
});

describe('quick iterations', () => {
  it('runs a small change the director specified straight away: no planner, the usual checks, a light wrap-up', async () => {
    const { ITERATION_REASON } = await import('../src/core/orchestrator/orchestrator');
    let directorCalls = 0;
    const { core, provider, ctx, root } = await makeCore({
      respond: async (req, kind) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('intent' in props) {
          directorCalls++;
          if (directorCalls === 1)
            return {
              intent: 'iterate',
              reply: 'On it: a damage tweak and a hit spark.',
              title: 'Harder sword hits',
              request: 'Sword hits do 25 damage with a spark on impact.',
              steps: [
                { key: 's1', title: 'Sword damage 25', role: 'luau-engineer', objective: 'Set SWORD_DAMAGE to 25 in src/Shared/Combat.luau.', acceptanceCriteria: ['SWORD_DAMAGE is 25'], check: 'none' },
                { key: 's2', title: 'Spark on hit', role: 'vfx-artist', objective: 'Play the HitSpark effect where the sword hits.', acceptanceCriteria: ['A spark shows on each hit'], dependsOn: ['s1'], check: 'none' },
              ],
            };
          // An iteration that doesn't hold together is planned instead.
          return { intent: 'iterate', reply: 'Sure.', title: 'Broken steps', request: 'Add a lobby.', steps: [{ key: 'a', title: 'Lobby', role: 'level-designer', objective: 'Build a lobby', acceptanceCriteria: ['A lobby'], dependsOn: ['nope'] }] };
        }
        if (kind === 'work') {
          await fakeWrite(req, req.role === 'luau-engineer' ? 'src/Shared/Combat.luau' : 'src/Shared/Spark.luau', '--!strict\nreturn { SWORD_DAMAGE = 25 }\n');
          return { status: 'implemented', summary: 'Done', filesChanged: [] };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'Good', criteria: [{ criterion: 'met', met: true, evidence: 'file' }], defects: [] };
        if (kind === 'plan') return { summary: 'Plan', tasks: [{ key: 'l', title: 'Lobby', kind: 'implement', role: 'level-designer', objective: 'Build a lobby', acceptanceCriteria: ['A lobby'], verification: [{ kind: 'critic' }], dependsOn: [] }] };
        return null;
      },
    });
    ctx.updateSettings({ maxConcurrentAgents: 2 });
    core.director.send('make the sword hit harder and add a spark');
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.kind === 'plan' && m.data?.iteration === true));
    const card = chat.list().find((m) => m.kind === 'plan' && m.data?.iteration === true)!;
    expect(card.text).toBe('Quick change: 2 tasks, starting now.');
    const obj = ctx.tasks.get(String(card.data!.objectiveId))!;
    expect(obj).toMatchObject({ kind: 'objective', title: 'Harder sword hits', reason: ITERATION_REASON, createdBy: 'director' });
    const kids = ctx.tasks.list({ parentId: obj.id });
    expect(kids.map((k) => k.kind)).toEqual(['implement', 'implement']);
    const s1 = kids.find((k) => k.title === 'Sword damage 25')!;
    const s2 = kids.find((k) => k.title === 'Spark on hit')!;
    expect(s2.dependencies).toEqual([s1.id]);
    expect(s1.verification.map((v) => v.kind)).toEqual(['static_analysis', 'critic']);
    expect(s2.verification.map((v) => v.kind)).toEqual(['static_analysis', 'critic']);
    // Studio checks as the director asks for them (they need Studio, so this run uses none).
    const { iterationSteps } = await import('../src/core/director/director');
    const [withPlaytest, withLook, unknownRole] = iterationSteps([
      { key: 'a', title: 'A', role: 'luau-engineer', objective: 'x', acceptanceCriteria: ['y'], check: 'playtest' },
      { key: 'b', title: 'B', role: 'ui-engineer', objective: 'x', acceptanceCriteria: [], check: 'screenshot' },
      { key: 'c', title: 'C', role: 'director', objective: 'x', acceptanceCriteria: ['z'] },
    ]);
    expect(withPlaytest!.verification).toEqual([{ kind: 'playtest', name: 'Quick playtest', durationSec: 10, failOnConsoleErrors: true }]);
    expect(withLook!.verification[0]).toMatchObject({ kind: 'screenshot' });
    expect(withLook!.acceptanceCriteria[0]).toMatch(/^Done as asked/);
    expect(unknownRole!.role).toBe('roblox-engineer');

    await waitFor(() => ctx.tasks.get(obj.id)?.status === 'done', 60000).catch((e) => {
      throw new Error(`${(e as Error).message}: ${JSON.stringify(ctx.tasks.list({ parentId: obj.id }).map((k) => [k.title, k.status, k.attempts, k.failureSummary?.slice(0, 300)]))} objective ${ctx.tasks.get(obj.id)?.status}`);
    });
    // No planner ran for it, and its wrap-up offered no milestone and wrote no report.
    expect(provider.runs.some((r) => r.role === 'executive')).toBe(false);
    expect(ctx.governance.escalations('open').some((e) => /next milestone/.test(e.title))).toBe(false);
    expect(existsSync(join(root, 'src', 'Shared', 'Combat.luau'))).toBe(true);

    // A second request whose steps don't hold together becomes a planned goal instead.
    core.director.send('add a lobby');
    await waitFor(() => ctx.tasks.list({ kinds: ['objective'] }).some((o) => o.title === 'Broken steps'));
    const planned = ctx.tasks.list({ kinds: ['objective'] }).find((o) => o.title === 'Broken steps')!;
    expect(planned.reason).not.toBe(ITERATION_REASON);
    expect(ctx.tasks.list({ parentId: planned.id }).some((t) => t.kind === 'plan')).toBe(true);
  }, 90_000);
});

describe('opening a Shuriken project folder', () => {
  it('lists a project folder from another session with its own identity, and refuses other folders', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const router = createRouter(core);
    const other = mkdtempSync(join(tmpdir(), 'shuriken-other-'));
    mkdirSync(join(other, '.shuriken'), { recursive: true });
    writeFileSync(join(other, '.shuriken', 'project.json'), JSON.stringify({ id: 'proj_elsewhere1', name: 'Castle Siege', createdAt: '2026-09-01T00:00:00.000Z', format: 1 }));
    const listed = (await router['projects.register']!({ rootPath: other })) as { id: string; name: string };
    expect(listed).toMatchObject({ id: 'proj_elsewhere1', name: 'Castle Siege' });
    expect(core.projects.list().some((p) => p.id === 'proj_elsewhere1')).toBe(true);
    // Not opened, and nothing written into it.
    expect(core.project?.summary.id).not.toBe('proj_elsewhere1');
    expect(existsSync(join(other, 'src'))).toBe(false);
    const plain = mkdtempSync(join(tmpdir(), 'shuriken-plain-'));
    await expect(Promise.resolve().then(() => router['projects.register']!({ rootPath: plain }))).rejects.toThrow(/isn't a Shuriken project/);
  });
});

describe('files other agents are editing', () => {
  it('lists files that other running agents changed with Edit or Write', async () => {
    const { filesInFlight } = await import('../src/core/capabilities/app-tools');
    const { ctx, root } = await makeCore({ respond: async () => null });
    const now = new Date().toISOString();
    for (const [id, status] of [['run_other', 'running'], ['run_done', 'completed'], ['run_me', 'running']] as const) {
      ctx.store.run('INSERT INTO runs (id, task_id, role, provider_id, model, status, started_at) VALUES (?, NULL, ?, ?, NULL, ?, ?)', [id, 'luau-engineer', 'fake', status, now]);
    }
    const call = (runId: string, tool: string, file: string) => ctx.audit.beginToolCall({ runId, taskId: null, role: 'luau-engineer', providerId: 'fake', source: 'agent_builtin', tool, capability: 'fake.edit_files', args: { file_path: file } });
    call('run_other', 'Edit', join(root, 'src', 'Server', 'Combat.server.luau'));
    call('run_other', 'Read', join(root, 'src', 'Server', 'Read.server.luau'));
    call('run_done', 'Write', join(root, 'src', 'Server', 'Old.server.luau'));
    call('run_me', 'Write', join(root, 'src', 'Server', 'Mine.server.luau'));
    expect(filesInFlight(ctx, 'run_me')).toEqual(['src/Server/Combat.server.luau']);
  });
});
