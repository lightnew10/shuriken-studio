import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '../src/core/core';
import type { AgentRunRequest } from '../src/core/providers/types';
import type { ToolCallRecord } from '../src/shared/domain';
import { ROLES, tierFor } from '../src/core/agents/roles';
import { DIRECTOR_LOOK, HANDS_OFF_NOTE, LOOK_TOOLS, handsOff, lookTrail, noActionsAsked, trailLine } from '../src/core/director/look';
import { builtDigest, builtLines } from '../src/core/director/game-digest';
import { isRecoveryOf, placeLinkLines, readPlaceLink } from '../src/core/director/place-link';
import { gameDigest } from '../src/core/director/live-suggestions';
import { ChatService } from '../src/core/director/chat-service';
import { describeCall } from '../src/core/director/activity';
import { TestService } from '../src/core/verification/test-service';
import { coreHarness, waitFor } from './helpers/make-core';
import { fakePicture } from './helpers/studio-sim';

/**
 * The director looks before it answers. The user asked four questions about a finished mech arena (session
 * 2026-10-01_16-08-08): which Studio file the project is linked to, whether the game saves and is ready to publish,
 * what is wrong with the mobile UI ("don't take any actions"), and how Studio splits phones from desktops. Each was
 * answered in seconds from general knowledge, one of them wrongly ("no touch controls that I've seen": three
 * finished tasks had added them). Here the same four messages reach a director that has the facts in its state
 * and read-only tools to look further; the tests assert on what it is given and what it may call, not on prose.
 */

const makeCore = coreHarness();
type Harness = Awaited<ReturnType<typeof makeCore>>;
type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
const outputProps = (req: { outputSchema?: unknown }) => (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
const isDirector = (req: AgentRunRequest) => 'intent' in outputProps(req);
/** The looking pass is the run with file tools. */
const isLook = (req: AgentRunRequest) => req.builtinTools.includes('read_files');
const text = (r: unknown) => ((r as { content?: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
const failed = (r: unknown) => (r as { isError?: boolean }).isError === true;
const replies = (core: Core) => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text');
const statuses = (core: Core) => core.director.chat()!.list().filter((m) => m.kind === 'status').map((m) => m.text);
/** What a look looked at: its chat line's folded detail, never the line's text ("Looked at: … searched for "a|b|c"" was posted as chat). */
const looked = (core: Core) => core.director.chat()!.list().filter((m) => m.kind === 'status' && m.data?.look === true && Array.isArray(m.data?.trail) && m.data.trail.length);
/** The status lines about which Studio window the project is linked to. */
const linkLines = (core: Core) => core.director.chat()!.list().filter((m) => m.kind === 'status' && typeof m.data?.placeLink === 'string').map((m) => m.text);

const GARAGE = `--!strict
-- The garage: parts bin on the left, the preview in the middle, the stats panel on the right.
local Garage = {}
local DESIGN = Vector2.new(1920, 1080)
function Garage.fit(root: Frame, viewport: Vector2)
	-- One layout for every device: the three columns are scaled down until they fit.
	local scale = Instance.new("UIScale")
	scale.Scale = math.min(viewport.X / DESIGN.X, viewport.Y / DESIGN.Y)
	scale.Parent = root
end
return Garage
`;

/** A finished build like the user's: tasks with results, evidence, tests, a decision made without asking, code on disk. */
function mechGame(h: Harness) {
  const { core, ctx, root } = h;
  core.orchestrator.pause();
  const goal = ctx.tasks.create({ kind: 'objective', title: 'Complete Mech Combat Arena Game', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
  const done = (title: string, role: string, result: string) => {
    const t = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title, objective: 'x', role, status: 'done', createdBy: 'executive' });
    ctx.tasks.update(t.id, { result });
    return t;
  };
  const data = done(
    'DataStore profiles: scrap, unlocks, saved loadouts, garage→deploy flow',
    'roblox-engineer',
    'Player saves and the garage-to-arena flow work end to end in Studio playtests. Studio has no DataStore access, so ProfileStore ran on its built-in mock store and a save surviving a rejoin has not been tested.\n\n**Profiles**\n- Session-locked in store "ScrapyardTitans_Profiles_v1".',
  );
  const garage = done('Garage screen: drag-and-drop part slots, rotating 3D preview, stat comparison', 'ui-engineer', 'The garage opens with its preview; parts drag onto slots and the stats panel compares them.');
  const boost = done('Add a touch button for the boost dash on mobile', 'ui-engineer', "Phone players now get a BOOST button that triggers the same boost dash as the keyboard key. I couldn't show the real button on a touch device: Studio scripts can't emulate touch.");
  const stick = done('Let phone players move their mech with the touch thumbstick', 'roblox-engineer', 'The touch thumbstick now walks the mech camera-relative; keyboard movement is unchanged.');
  const polish = done('UI polish: touch aim-while-firing, bot name tags, deploy countdown', 'ui-engineer', 'Dragging a finger that holds FIRE now aims; bots have name tags; the Deploy button counts down.');

  ctx.tasks.addEvidence({ taskId: boost.id, runId: null, kind: 'test_result', title: 'Touch cluster layout: phone 844x390 and tablet 1180x820, no overlaps', passed: true, data: { phone: { Jump: '749,300-819,370', Boost: '752,228-816,292 (directly above jump)', problems: [] } }, path: null });
  ctx.tasks.addEvidence({ taskId: boost.id, runId: null, kind: 'console', title: 'Playtest: boost_binding_ok', passed: true, data: { output: 'Playtest 15s: PASS', console: '[ProfileStore]: Roblox API services unavailable - data will not be saved\nPlayer:Move called, but player currently has no character.' }, path: null });
  ctx.tasks.addEvidence({ taskId: data.id, runId: null, kind: 'critic_review', title: 'Critic: PASS — saves work against the mock store; a real DataStore round trip was not possible in Studio', passed: true, data: { verdict: 'pass', summary: 'Mock store only.' }, path: null });
  ctx.tasks.addEvidence({ taskId: polish.id, runId: null, kind: 'note', title: "No screenshot possible: Studio isn't drawing (minimized, the display off, or its screen capture stopped answering) (can't check visually)", passed: null, data: { environment: 'studio_not_drawing' }, path: null });
  ctx.tasks.addEvidence({ taskId: garage.id, runId: null, kind: 'diff', title: 'Code changes (12 files)', passed: null, data: { files: ['src/Client/UI/Garage/GarageController.luau', 'phone-notes.md'] }, path: null });
  mkdirSync(join(ctx.dir, 'evidence'), { recursive: true });
  const shot = join(ctx.dir, 'evidence', 'garage-desktop.jpg');
  writeFileSync(shot, Buffer.from(fakePicture(), 'base64'));
  const picture = ctx.tasks.addEvidence({ taskId: garage.id, runId: null, kind: 'screenshot', title: 'Garage at desktop size', passed: null, data: null, path: shot });

  const tests = new TestService(ctx.store);
  const saves = tests.upsertForTask(data.id, { kind: 'playtest', name: 'profile_loads_and_saves', durationSec: 10, failOnConsoleErrors: true })!;
  const loop = tests.upsertForTask(garage.id, { kind: 'playtest', name: 'full_loop_smoke', durationSec: 30, failOnConsoleErrors: true })!;
  tests.upsertForTask(stick.id, { kind: 'playtest', name: 'mech_moves_with_move_vector', durationSec: 20, failOnConsoleErrors: true });
  tests.recordResult({ testId: saves.id, runId: null, taskId: data.id, status: 'pass', output: 'Playtest 10s: PASS (mock store)', durationMs: 12000 });
  tests.recordResult({ testId: loop.id, runId: null, taskId: garage.id, status: 'fail', output: 'FAIL: no character after deploy within 15 s', durationMs: 151000 });

  ctx.governance.autoResolve({ kind: 'question', title: 'Relaunch Studio after it closed?', detail: 'Studio closed during the build.', taskId: garage.id, response: 'Yes: reopened the place and carried on.' });
  ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'The Deploy button sits under the notch on phones', objective: 'x', reason: 'Defect reported by critic while working on "UI polish"', role: 'ui-engineer', status: 'proposed', createdBy: 'critic' });

  mkdirSync(join(root, 'src', 'Client', 'UI', 'Garage'), { recursive: true });
  writeFileSync(join(root, 'src', 'Client', 'UI', 'Garage', 'GarageController.luau'), GARAGE, 'utf8');
  // The goal the chat is on now is a later, small one: the big build is not "the current goal".
  const later = ctx.tasks.create({ kind: 'objective', title: 'Improve turntable viewer quality', objective: 'x', role: 'executive', status: 'running', createdBy: 'director' });
  return { goal, later, data, garage, boost, stick, polish, picture };
}

/** A Studio the core believes is connected, with these places open (nothing real is touched or spawned). */
function fakeStudio(core: Core, open: { names: string[] }): void {
  const studio = core.studio as unknown as Record<string, unknown>;
  Object.defineProperty(studio, 'connected', { get: () => true, configurable: true });
  studio.listStudios = async () => open.names.map((name, i) => ({ id: `s${i}`, name }));
  studio.healthChecks = async () => [];
  studio.state = async () => ({ mode: 'Edit', availableDataModels: ['Edit'], focused: 'Edit', raw: '' });
}

describe('what the director may look at (pure)', () => {
  it('looks with read-only tools on the deep tier at high effort, whatever tier the chat is set to', () => {
    expect(DIRECTOR_LOOK.id).toBe('director');
    expect(DIRECTOR_LOOK.builtinTools).toEqual(['read_files']);
    expect([DIRECTOR_LOOK.effort, DIRECTOR_LOOK.maxTurns]).toEqual(['high', 40]);
    // A saved chat tier (1.9 wrote "balanced" into every project) does not hold the looking pass back.
    expect(tierFor(DIRECTOR_LOOK, { chat: 'balanced' })).toBe('deep');
    expect(tierFor(DIRECTOR_LOOK, { chat: 'fast' })).toBe('deep');
    // The quick pass: the chat tier, the agents' effort (high by default, 1.15.3), no file tools, six turns.
    const quick = ROLES.director!;
    expect([tierFor(quick, {}), tierFor(quick, { chat: 'fast' }), quick.effort, quick.maxTurns, quick.builtinTools]).toEqual(['balanced', 'fast', 'high', 6, []]);
    expect(quick.appTools).toEqual(['project_overview', 'task_list', 'task_get', 'map_preview', 'map_audit']);
  });

  it('never gets a tool that changes the game, the plan or Studio', async () => {
    const { core } = await makeCore({ respond: async () => null });
    for (const name of LOOK_TOOLS) {
      const def = core.tools.get(name);
      expect(def, name).toBeDefined();
      expect(['read', 'roblox_read'], name).toContain(def!.permission);
      expect(def!.annotations?.readOnlyHint, name).toBe(true);
    }
    // Reading the UI by playtest and moving the camera for a picture are not looking.
    for (const no of ['ui_audit', 'roblox_screenshot', 'roblox_run_luau', 'roblox_playtest', 'roblox_sync_push', 'plan_add_task', 'task_add_evidence', 'test_retire', 'spec_propose']) expect(LOOK_TOOLS, no).not.toContain(no);
    // The director's own tools are its alone: the workers' tool lists don't grow.
    const worker = { kind: 'agent' as const, runId: 'run_w', taskId: null, role: 'ui-engineer', providerId: null, allowedTools: null };
    const seen = core.tools.visibleTo(worker).map((t) => t.name);
    for (const mine of ['evidence_search', 'test_results', 'decided_list', 'studio_place', 'ui_snapshot']) expect(seen, mine).not.toContain(mine);
  });

  it('tells "look, change nothing" from a request', () => {
    for (const said of [
      'The mobile UI does not look great, lets just scope it out for a sec,  dont take any actions',
      "don't take any actions yet",
      'Do not make any changes, what is wrong with the garage?',
      "what's up with the HUD? don't change anything",
      'look at the shop without making changes',
      'Is the arena finished? No changes, just tell me.',
      'just look at the garage on phones',
      'change nothing, only report',
    ]) expect(noActionsAsked(said), said).toBe(true);
    for (const said of [
      'make the mechs faster',
      'the HUD has no action bar, add one',
      'just look at the garage and then fix what is wrong',
      'no changes needed to the arena, but add a second map',
      'just make the boost button bigger',
      'stop everything',
    ]) expect(noActionsAsked(said), said).toBe(false);
  });

  it('takes everything that acts out of a result when no actions were asked', () => {
    const acted = handsOff({ intent: 'iterate', reply: 'Fixing the garage.', steps: [{ key: 's1', title: 't', role: 'ui-engineer', objective: 'o', acceptanceCriteria: [] }], tasks: [{ action: 'cancel', task: 'x' }], restudy: true });
    expect(acted.dropped).toBe(true);
    expect(acted.out).toMatchObject({ intent: 'question', steps: [], tasks: [], restudy: false, reply: 'Fixing the garage.' });
    expect(handsOff({ intent: 'question', reply: 'It is a desktop layout scaled down.' }).dropped).toBe(false);
    expect(handsOff({ intent: 'pause', reply: 'Paused.' }).dropped).toBe(true);
  });

  it('says both in its brief: look instead of guessing, and how to answer', () => {
    const quick = ROLES.director!.instructions;
    expect(quick).toMatch(/- "look": they ask about the game as it is and your state does not settle it/);
    expect(quick).toMatch(/Never "look" for a plain instruction, a control or small\s+talk/);
    expect(quick).toMatch(/Answers about this game come from the project, never from general knowledge of Roblox games/);
    expect(quick).toMatch(/"I haven't read the code" or "I can't tell from here" is never an answer while the project\s+can be read/);
    expect(quick).toMatch(/"Don't take any actions", "just look" or "scope it out" forbid changes[\s\S]{0,80}never looking/);
    expect(quick).toMatch(/keep what was checked apart from what was not/);
    // The reply style that was there stays.
    expect(quick).toMatch(/Reply like a friendly senior game developer: short — at most about 600 characters/);
    const look = DIRECTOR_LOOK.instructions;
    expect(look.startsWith(quick)).toBe(true);
    expect(look).toMatch(/Say what you checked, by name/);
    expect(look).toMatch(/what you saw for yourself in this pass, what a task recorded as checked,\s+and what nobody has checked/);
    expect(look).toMatch(/Device emulator on the\s+Test tab/);
    expect(look).toMatch(/Never return\s+"look"/);
  });
});

describe('the game as built, in the director’s state', () => {
  it('lists what every finished task delivered, what nobody saw, open problems and the tests; cached until they change', async () => {
    const h = await makeCore({ respond: async () => null });
    const g = mechGame(h);
    const d = builtDigest(h.ctx);
    expect(d.built.map((t) => t.title)).toEqual([g.data.title, g.garage.title, g.boost.title, g.stick.title, g.polish.title]);
    expect(d.unseen).toEqual([g.polish.title]);
    expect(d.defects).toEqual(['The Deploy button sits under the notch on phones']);
    expect(d.tests).toMatchObject({ enabled: 3, pass: 1, fail: 1, neverRun: 1, failing: [{ name: 'full_loop_smoke', task: g.garage.title }] });
    const lines = builtLines(d).join('\n');
    expect(lines).toMatch(/Built so far \(5 finished tasks, every goal/);
    expect(lines).toContain('- DataStore profiles: scrap, unlocks, saved loadouts, garage→deploy flow — Player saves and the garage-to-arena flow work end to end in Studio playtests. Studio has no DataStore access, so ProfileStore ran on its built-in mock store and a save surviving a rejoin has not been tested.');
    expect(lines).toContain('- Add a touch button for the boost dash on mobile — Phone players now get a BOOST button');
    expect(lines).toMatch(/Not verified:\n- Reviewed without a look at the result \(Studio wasn't drawing[^\n]*"UI polish: touch aim-while-firing/);
    expect(lines).toMatch(/Open problems:\n- Defects agents reported that the planner hasn't looked at yet \(1\): "The Deploy button sits under the notch on phones"/);
    expect(lines).toMatch(/Regression suite[^\n]*3 checks on: 1 passed, 1 failed, 1 never run/);
    expect(lines).toMatch(/- Failing now: full_loop_smoke \(from "Garage screen/);
    expect(lines).toMatch(/- Not closed yet, so its full suite has not passed since its last change: "Complete Mech Combat Arena Game" \(running\)/);
    expect(lines).not.toMatch(/id:task_/);
    expect(builtLines(d, { ids: true }).join('\n')).toContain(`id:${g.boost.id}`);
    // Kept until something it is made of changes.
    expect(builtDigest(h.ctx)).toBe(d);
    h.ctx.tasks.update(g.polish.id, { result: 'Reworked.' });
    const next = builtDigest(h.ctx);
    expect(next).not.toBe(d);
    expect(next.built.at(-1)!.delivered).toBe('Reworked.');
    // A picture taken later settles "nobody saw it".
    h.ctx.tasks.addEvidence({ taskId: g.polish.id, runId: null, kind: 'screenshot', title: 'Bot name tags', passed: null, data: null, path: null });
    expect(builtDigest(h.ctx).unseen).toEqual([]);
    // The suggestion bubbles' digest counts the same tasks as finished.
    expect(gameDigest(h.ctx, new ChatService(h.ctx, h.core.bus))!.text).toContain(`- ${g.boost.title}`);
  });

  it('stays small and quick for a big build', async () => {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Big game', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    for (let i = 0; i < 90; i++) {
      const t = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: `Task number ${i} with a reasonably long title about a system`, objective: 'x', role: i % 3 ? 'roblox-engineer' : 'ui-engineer', status: 'done', createdBy: 'executive' });
      h.ctx.tasks.update(t.id, { result: `${'What it delivered, in a sentence that goes on for a while. '.repeat(8)}\n\nDetails.` });
    }
    const t0 = performance.now();
    const d = builtDigest(h.ctx);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) builtDigest(h.ctx);
    const again = (performance.now() - t1) / 50;
    const lines = builtLines(d);
    // The newest 60 tasks, one capped line each: about 5,000 tokens at the very most, on every message.
    expect(lines.filter((l) => l.startsWith('- Task number')).length).toBe(60);
    expect(lines.join('\n')).toContain('(the 30 earliest are left out)');
    expect(lines.join('\n').length).toBeLessThan(22_000);
    expect(first).toBeLessThan(500);
    expect(again).toBeLessThan(5);
  });
});

describe('a plain instruction stays one quick pass', () => {
  it('routes "make the mechs faster" in a single run, with the built game in its state', async () => {
    const runs: AgentRunRequest[] = [];
    let at = 0;
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        at ||= performance.now();
        runs.push(req);
        return { intent: 'side_task', role: 'roblox-engineer', title: 'Faster mechs', request: 'Raise every mech frame\'s walk speed by 20%.', reply: 'Asked the gameplay engineer to make the mechs 20% faster.' };
      },
    });
    const g = mechGame(h);
    const t0 = performance.now();
    h.core.director.send('make the mechs faster');
    await waitFor(() => replies(h.core).length === 1);
    // Building the state (the digest, Studio's facts) is not what a reply waits for.
    expect(at - t0).toBeLessThan(1500);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ role: 'director', modelTier: 'balanced', effort: 'high', maxTurns: 6, builtinTools: [] });
    expect(runs[0]!.prompt).toContain('Built so far (5 finished tasks');
    expect(runs[0]!.prompt).toContain('Studio and the place:');
    // No "Looking into it" line, and the job started.
    expect(statuses(h.core).some((s) => /^Look/.test(s))).toBe(false);
    expect(h.ctx.tasks.list({ parentId: g.later.id }).some((t) => t.title === 'Faster mechs' && t.status === 'ready')).toBe(true);
  });

  it('never waits long for a Studio that is slow to say which places are open', async () => {
    let at = 0;
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? ((at ||= performance.now()), { intent: 'chat', reply: 'Thanks!' }) : null) });
    mechGame(h);
    fakeStudio(h.core, { names: [] });
    (h.core.studio as unknown as Record<string, unknown>).listStudios = () => new Promise(() => {});
    const t0 = performance.now();
    h.core.director.send('thanks!');
    await waitFor(() => replies(h.core).length === 1);
    expect(at - t0).toBeGreaterThan(700);
    expect(at - t0).toBeLessThan(2500);
  });
});

describe('the four questions', () => {
  it('3. "the mobile UI does not look great… dont take any actions": the state says touch controls exist, the look can read the garage and the phone evidence, and nothing starts', async () => {
    const seen: { quick?: AgentRunRequest; look?: AgentRunRequest; found?: string; view?: unknown; ui?: string; refused: string[] } = { refused: [] };
    const h = await makeCore({
      respond: async (req, _kind, call: Call) => {
        if (!isDirector(req)) return null;
        if (!isLook(req)) {
          seen.quick = req;
          return { intent: 'look', lookFor: 'How each screen behaves at phone size: the garage layout code, the touch controls tasks and their phone-size evidence. The user wants no actions.', reply: 'Looking into it.' };
        }
        seen.look = req;
        seen.found = text(await call('evidence_search', { query: 'phone' }));
        const shot = /"id": "(evd_[a-z0-9]+)",\s+"task": "Garage screen[^}]*"kind": "screenshot"/.exec(text(await call('evidence_search', { query: 'garage', kind: 'screenshot' })))?.[1];
        seen.view = await call('evidence_view', { id: shot ?? 'missing' });
        seen.ui = text(await call('ui_snapshot', {}));
        for (const tool of ['ui_audit', 'roblox_screenshot', 'roblox_run_luau', 'plan_add_task', 'task_add_evidence']) if (failed(await call(tool, {}))) seen.refused.push(tool);
        // A model that wants to fix it anyway: the user said no actions.
        return {
          intent: 'iterate',
          title: 'Phone garage',
          request: 'Give the garage a phone layout.',
          steps: [{ key: 's1', title: 'Phone layout for the garage', role: 'ui-engineer', objective: 'Stack the garage panels on phones.', acceptanceCriteria: ['Fits 844x390'], check: 'screenshot' }],
          tasks: [{ action: 'cancel', task: 'The Deploy button sits under the notch on phones' }],
          reply: 'The touch controls are there (a thumbstick, a BOOST button, aim while firing; the buttons were measured at 844x390). The garage is the problem: I read GarageController.luau and it is one desktop layout scaled down with a UIScale.',
        };
      },
    });
    const g = mechGame(h);
    const before = h.ctx.tasks.list({}).length;
    h.core.director.send('The mobile UI does not look great, lets just scope it out for a sec,  dont take any actions');
    await waitFor(() => replies(h.core).length === 1);

    // The quick pass is told what was built: it can no longer say there are no touch controls.
    for (const line of ['- Add a touch button for the boost dash on mobile — Phone players now get a BOOST button', '- Let phone players move their mech with the touch thumbstick — The touch thumbstick now walks the mech', '- UI polish: touch aim-while-firing, bot name tags, deploy countdown — Dragging a finger that holds FIRE now aims']) expect(seen.quick!.prompt).toContain(line);
    expect(seen.quick).toMatchObject({ effort: 'high', builtinTools: [] });

    // The looking pass: file tools from the project folder (the garage's code is there to read), the deep tier.
    // No dollar cap: on a big project one would stop the look before it has read anything (maxTurns ends a wandering one).
    expect((seen.look as { maxBudgetUsd?: number }).maxBudgetUsd).toBeUndefined();
    expect(seen.look).toMatchObject({ role: 'director', modelTier: 'deep', effort: 'high', maxTurns: 40, builtinTools: ['read_files'], cwd: h.root });
    expect(existsSync(join(seen.look!.cwd, 'src', 'Client', 'UI', 'Garage', 'GarageController.luau'))).toBe(true);
    expect(seen.look!.prompt).toContain('dont take any actions');
    expect(seen.look!.prompt).toContain('What your first pass wants found out: How each screen behaves at phone size');
    expect(seen.look!.prompt).toContain(`id:${g.boost.id}`);
    expect(seen.look!.instructions).toContain('THE LOOKING PASS');
    // The phone-size evidence is one search away, and a screenshot comes back as a picture.
    expect(seen.found).toContain('Touch cluster layout: phone 844x390 and tablet 1180x820, no overlaps');
    expect(seen.found).toContain('Add a touch button for the boost dash on mobile');
    expect(seen.found).not.toContain('Code changes (12 files)');
    expect((seen.view as { content: Array<{ type: string; mimeType?: string }> }).content.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg')).toBe(true);
    expect(seen.ui).toMatch(/No UI audit has been saved/);
    // Nothing that changes the game, the plan or Studio can be called.
    expect(seen.refused).toEqual(['ui_audit', 'roblox_screenshot', 'roblox_run_luau', 'plan_add_task', 'task_add_evidence']);

    // "Don't take any actions": the steps and the cancel were dropped, and the reply says so.
    expect(h.ctx.tasks.list({}).length).toBe(before);
    expect(h.ctx.tasks.list({ statuses: ['cancelled'] })).toHaveLength(0);
    expect(replies(h.core)[0]!.text).toContain('I read GarageController.luau');
    expect(replies(h.core)[0]!.text.endsWith(HANDS_OFF_NOTE)).toBe(true);
    // The chat says what was looked at, from the recorded calls.
    const note = looked(h.core).at(-1)!;
    expect(note.text).toBe('Looked into 4 things before answering.');
    expect(note.data?.detail).toBe('Looked at: the tasks\' evidence (for "phone"), the tasks\' evidence (for "garage"), evidence "Garage at desktop size", the last UI audit.');
    expect(statuses(h.core).some((t) => t.startsWith('Looked at:'))).toBe(false);
  });

  it('2. "is it ready to publish? it saves between sessions, correct?": the save caveat, the unseen work and the failing check are in the state; the console line and the tests are in reach', async () => {
    const seen: { quick?: string; look?: string; store?: string; tests?: string; task?: string; decided?: string } = {};
    const h = await makeCore({
      respond: async (req, _kind, call: Call) => {
        if (!isDirector(req)) return null;
        if (!isLook(req)) {
          seen.quick = req.prompt;
          return { intent: 'look', lookFor: 'Whether saving was proven, and what stands between the game and publishing.', reply: 'Checking.' };
        }
        seen.look = req.prompt;
        seen.store = text(await call('evidence_search', { query: 'ProfileStore' }));
        seen.tests = text(await call('test_results', { failing_only: true }));
        seen.task = text(await call('task_get', { id: /DataStore profiles[^\n]*id:(\S+)/.exec(req.prompt)?.[1] ?? 'missing' }));
        seen.decided = text(await call('decided_list', {}));
        return { intent: 'question', reply: 'Not yet. Saving was only run against a mock store.' };
      },
    });
    mechGame(h);
    h.core.director.send("I've got another question, is the game mostly ready to publish? It saves between sessions, correct?");
    await waitFor(() => replies(h.core).length === 1);
    for (const prompt of [seen.quick!, seen.look!]) {
      expect(prompt).toContain('ProfileStore ran on its built-in mock store and a save surviving a rejoin has not been tested');
      expect(prompt).toMatch(/Not verified:\n- Reviewed without a look at the result/);
      expect(prompt).toMatch(/3 checks on: 1 passed, 1 failed, 1 never run/);
      expect(prompt).toMatch(/Not closed yet, so its full suite has not passed since its last change: "Complete Mech Combat Arena Game"/);
    }
    expect(seen.store).toContain('[ProfileStore]: Roblox API services unavailable - data will not be saved');
    expect(seen.store).toContain('Playtest: boost_binding_ok');
    expect(seen.tests).toMatch(/3 tests on: 1 passed, 1 failed, 1 never run/);
    expect(seen.tests).toContain('FAIL: no character after deploy within 15 s');
    expect(seen.tests).not.toContain('profile_loads_and_saves');
    expect(seen.task).toContain('Critic: PASS — saves work against the mock store');
    expect(seen.decided).toContain('Relaunch Studio after it closed?');
    expect(seen.decided).toContain('Yes: reopened the place and carried on.');
    expect(replies(h.core)[0]!.text).toBe('Not yet. Saving was only run against a mock store.');
  });

  it('4. "how does studio organize the split between mobile and desktop?": the guides the workers follow are in reach, and the brief asks for both halves', async () => {
    const seen: { skills?: string; guide?: string } = {};
    const h = await makeCore({
      respond: async (req, _kind, call: Call) => {
        if (!isDirector(req)) return null;
        if (!isLook(req)) return { intent: 'look', lookFor: 'How Roblox and Studio tell phones from desktops, and what this game\'s UI code does about it.', reply: 'Looking it up.' };
        seen.skills = text(await call('skill_list', {}));
        seen.guide = text(await call('skill_get', { name: 'roblox-ui-references' }));
        return { intent: 'question', reply: 'Studio does not split devices itself.' };
      },
    });
    mechGame(h);
    h.core.director.send('how does studio organize the split between mobile devices and desktop devices?');
    await waitFor(() => replies(h.core).length === 1);
    expect(seen.skills).toContain('roblox-ui-references');
    expect(seen.guide).toContain('PreferredInput');
    expect(seen.guide).toContain('945x415');
    expect(looked(h.core).at(-1)!.data?.trail).toEqual(['the list of guides', 'the guide roblox-ui-references']);
  });

  it('1. "the game is now an auto recovery file… can you access it?": Shuriken notices, links to the copy, says what that means for saving, and the director has the facts', async () => {
    let prompt = '';
    let runs = 0;
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        runs++;
        prompt = req.prompt;
        return { intent: 'question', reply: 'Yes: I am linked to the recovery copy. Save it over the place file with File > Save As.' };
      },
    });
    const { core, ctx, root } = h;
    mechGame(h);
    const place = join(root, 'test-game.rbxlx');
    writeFileSync(place, '<roblox/>', 'utf8');
    ctx.updateExtras({ placeFile: 'test-game.rbxlx' });
    ctx.updateSettings({ robloxStudioMatch: 'test-game.rbxlx' });
    const open = { names: ['test-game.rbxlx'] };
    fakeStudio(core, open);
    core.studio.bind('test-game.rbxlx');

    // The place file is open: linked, nothing to say.
    expect(await core.placeLink.check()).toMatchObject({ kind: 'linked', place: 'test-game.rbxlx', binding: 'test-game.rbxlx' });
    expect(linkLines(core)).toEqual([]);

    // Studio crashed and the user opened its recovery file: the place file is no longer open.
    const copy = 'test-game_AutoRecovery_0_20261001_090942.rbxl';
    open.names = [copy, 'Some other game.rbxlx'];
    expect(await core.placeLink.check()).toMatchObject({ kind: 'recovery', recoveries: [copy], binding: copy });
    expect(core.studio.binding).toBe(copy);
    expect(core.placeLink.onRecovery).toBe(true);
    // The saved setting still names the place file: the link is for now, not for good.
    expect(ctx.settings().robloxStudioMatch).toBe('test-game.rbxlx');
    const said = linkLines(core);
    expect(said).toEqual([`Studio has a recovery copy of your place open (${copy}), not the project's place file. I've linked to that window, so the team and I work in it. I can't save it for you: in Studio use File > Save As and save over ${place}. Until then nothing new reaches the place file, and auto-save is off.`]);
    // Looked at again, the same situation is not said again.
    await core.placeLink.check();
    expect(linkLines(core)).toEqual(said);

    // The question is answered by the quick pass alone: the facts are in its state.
    core.director.send('hey, the game is now an auto recovery file I have opened. Can you access it? The file name changed');
    await waitFor(() => replies(core).length === 1);
    expect(runs).toBe(1);
    expect(prompt).toContain(`- Roblox Studio: connected. Open there: "${copy}", "Some other game.rbxlx".`);
    expect(prompt).toContain(`- Studio does NOT have the project's place file open. It has a RECOVERY COPY of it: "${copy}"`);
    expect(prompt).toContain('The project is linked to that window, so the team reads and builds there.');
    expect(prompt).toContain(`nothing reaches the place file until the user does File > Save As in Studio and saves over ${place}`);
    expect(prompt).not.toContain('Roblox Studio: connected\n');
    // The same facts, read fresh, for the looking pass.
    const tool = await core.invokeTool('studio_place', {});
    expect(tool.data).toMatchObject({ connected: true, link: 'recovery', linkedTo: copy, recoveryCopies: [copy], autoSave: 'off while linked to a recovery copy', mode: 'Edit (DataModels: Edit)' });

    // The user saves the copy over the place file: the window is the place again, and so is the link.
    open.names = ['test-game.rbxlx', 'Some other game.rbxlx'];
    expect(await core.placeLink.check()).toMatchObject({ kind: 'linked', binding: 'test-game.rbxlx' });
    expect(core.placeLink.onRecovery).toBe(false);
    expect(linkLines(core).at(-1)).toBe("Studio has the project's place file open again (test-game.rbxlx). I'm linked to it, and saving works again.");
  });
});

describe('which window is the place (pure)', () => {
  const studios = (...names: string[]) => names.map((name, i) => ({ id: `s${i}`, name }));
  const file = 'C:\\Games\\mech\\complete-mech-combat-arena-game.rbxlx';
  const base = { placeFile: file, match: 'complete-mech-combat-arena-game.rbxlx', binding: 'complete-mech-combat-arena-game.rbxlx', connected: true };

  it('knows Studio’s recovery copies by name', () => {
    const stem = 'complete-mech-combat-arena-game';
    expect(isRecoveryOf('complete-mech-combat-arena-game_AutoRecovery_0.rbxl', stem)).toBe(true);
    expect(isRecoveryOf('complete-mech-combat-arena-game_AutoRecovery_0_20261001_090942.rbxl', stem)).toBe(true);
    expect(isRecoveryOf('complete-mech-combat-arena-game_AutoRecovery_0_20261001_090942', stem)).toBe(true);
    expect(isRecoveryOf('complete-mech-combat-arena-game_AutoRecovery_0.rbxl.lock', stem)).toBe(false);
    expect(isRecoveryOf('C:\\Users\\me\\AppData\\Local\\Roblox\\RobloxStudio\\AutoSaves\\Archived\\complete-mech-combat-arena-game_AutoRecovery_12.rbxl', stem)).toBe(true);
    // A published place's copies are named by its id.
    expect(isRecoveryOf('100000000000002_AutoRecovery_1_20260929_073654.rbxl (placeId: 0)', '100000000000002')).toBe(true);
    expect(isRecoveryOf('complete-mech-combat-arena-game.rbxlx', stem)).toBe(false);
    expect(isRecoveryOf('complete-mech-combat-arena-game-2_AutoRecovery_0.rbxl', stem)).toBe(false);
    expect(isRecoveryOf('other_AutoRecovery_0.rbxl', stem)).toBe(false);
    expect(isRecoveryOf('anything_AutoRecovery_0.rbxl', '')).toBe(false);
  });

  it('tells linked, a recovery copy, several copies, other places and nothing apart', () => {
    expect(readPlaceLink({ ...base, studios: studios('complete-mech-combat-arena-game.rbxlx') })).toMatchObject({ kind: 'linked', place: 'complete-mech-combat-arena-game.rbxlx', recoveries: [] });
    // Both open: linked to the place, and the copy is named.
    const both = readPlaceLink({ ...base, studios: studios('complete-mech-combat-arena-game_AutoRecovery_0.rbxl', 'complete-mech-combat-arena-game.rbxlx') });
    expect(both).toMatchObject({ kind: 'linked', recoveries: ['complete-mech-combat-arena-game_AutoRecovery_0.rbxl'] });
    expect(placeLinkLines(both).join('\n')).toMatch(/Also open: a recovery copy of the place[\s\S]*The team does NOT work there/);
    expect(readPlaceLink({ ...base, studios: studios('complete-mech-combat-arena-game_AutoRecovery_0.rbxl', 'Schism (Dev) (placeId: 12345)') })).toMatchObject({ kind: 'recovery', open: ['complete-mech-combat-arena-game_AutoRecovery_0.rbxl', 'Schism (Dev)'] });
    expect(readPlaceLink({ ...base, studios: studios('complete-mech-combat-arena-game_AutoRecovery_0.rbxl', 'complete-mech-combat-arena-game_AutoRecovery_1.rbxl') }).kind).toBe('recoveries');
    const elsewhere = readPlaceLink({ ...base, studios: studios('Schism (Dev) (placeId: 12345)', '(loading)') });
    expect(elsewhere).toMatchObject({ kind: 'elsewhere', open: ['Schism (Dev)'] });
    expect(placeLinkLines(elsewhere).join('\n')).toMatch(/The project's place is NOT open in Studio[\s\S]*saved under another name/);
    expect(readPlaceLink({ ...base, studios: [] }).kind).toBe('closed');
    const offline = readPlaceLink({ ...base, connected: false, studios: null, detail: 'disconnected' });
    expect(offline.kind).toBe('offline');
    expect(placeLinkLines(offline)[0]).toMatch(/^- Roblox Studio: NOT connected \(disconnected\)\. Which place is open there is unknown/);
    expect(readPlaceLink({ placeFile: null, match: null, binding: null, connected: true, studios: studios('x.rbxlx') }).kind).toBe('unlinked');
    // A published place plugged in by name: linked by the name, its copies known by the place id.
    expect(readPlaceLink({ placeFile: null, match: 'Schism (Dev)', placeId: '12345', binding: 'Schism (Dev)', connected: true, studios: studios('Schism (Dev) (placeId: 12345)') }).kind).toBe('linked');
    expect(readPlaceLink({ placeFile: null, match: 'Schism (Dev)', placeId: '12345', binding: 'Schism (Dev)', connected: true, studios: studios('12345_AutoRecovery_0.rbxl') }).kind).toBe('recovery');
  });

  it('links to a copy only when it is the one copy of a place file; never for several, never for a published place', async () => {
    const h = await makeCore({ respond: async () => null });
    const { core, ctx, root } = h;
    core.orchestrator.pause();
    writeFileSync(join(root, 'arena.rbxlx'), '<roblox/>', 'utf8');
    ctx.updateExtras({ placeFile: 'arena.rbxlx' });
    ctx.updateSettings({ robloxStudioMatch: 'arena.rbxlx' });
    const open = { names: ['arena_AutoRecovery_0.rbxl', 'arena_AutoRecovery_1.rbxl'] };
    fakeStudio(core, open);
    core.studio.bind('arena.rbxlx');
    expect(await core.placeLink.check()).toMatchObject({ kind: 'recoveries', binding: 'arena.rbxlx' });
    expect(core.placeLink.onRecovery).toBe(false);
    expect(linkLines(core)).toHaveLength(1);
    expect(linkLines(core)[0]).toMatch(/^Studio has recovery copies of your place open \(arena_AutoRecovery_0\.rbxl, arena_AutoRecovery_1\.rbxl\) and not the place itself, so I'm not linked to any of them/);
    // Other places only: nothing is said (a project opened on hold next to another game is the normal case).
    open.names = ['Some other game.rbxlx'];
    expect(await core.placeLink.check()).toMatchObject({ kind: 'elsewhere', binding: 'arena.rbxlx' });
    expect(linkLines(core)).toHaveLength(1);
    // One copy: linked. It closes again: back to what the setting names.
    open.names = ['arena_AutoRecovery_1.rbxl'];
    expect(await core.placeLink.check()).toMatchObject({ kind: 'recovery', binding: 'arena_AutoRecovery_1.rbxl' });
    open.names = [];
    expect(await core.placeLink.check()).toMatchObject({ kind: 'closed', binding: 'arena.rbxlx' });
    expect(core.placeLink.onRecovery).toBe(false);
    // A place without a file (a published place plugged in by name): its copy is reported, not linked.
    ctx.updateExtras({ placeFile: undefined, adopted: { from: 'studio', place: 'My Game', placeId: '777', at: new Date().toISOString() } });
    ctx.updateSettings({ robloxStudioMatch: 'My Game' });
    core.studio.bind('My Game');
    open.names = ['777_AutoRecovery_0.rbxl'];
    expect(await core.placeLink.check()).toMatchObject({ kind: 'recovery', binding: 'My Game' });
    expect(core.placeLink.onRecovery).toBe(false);
    expect(linkLines(core).at(-1)).toMatch(/^Studio has a recovery copy of your place open \(777_AutoRecovery_0\.rbxl\) and not the place itself, so I'm not linked to it/);
  });
});

describe('what was looked at', () => {
  it('is read from the recorded calls, in the user’s words', async () => {
    const h = await makeCore({ respond: async () => null });
    const g = mechGame(h);
    const calls: ToolCallRecord[] = [];
    const call = (tool: string, args: unknown, status: 'ok' | 'denied' = 'ok'): ToolCallRecord => ({ id: tool, runId: 'r', taskId: null, role: 'director', providerId: null, source: 'agent_builtin', tool, capability: null, args, result: null, status, error: null, durationMs: 1, startedAt: new Date(Date.now() + calls.length).toISOString(), filesChanged: [] });
    calls.push(call('Read', { file_path: join(h.root, 'src', 'Client', 'UI', 'Garage', 'GarageController.luau') }));
    calls.push(call('Grep', { pattern: 'UIScale' }));
    calls.push(call('mcp__shuriken__task_get', { id: g.boost.id }));
    calls.push(call('mcp__shuriken__evidence_view', { id: g.picture.id }));
    calls.push(call('mcp__shuriken__test_results', {}));
    calls.push(call('mcp__shuriken__studio_place', {}));
    calls.push(call('Read', { file_path: 'GarageController.luau' }));
    calls.push(call('mcp__shuriken__roblox_run_luau', {}, 'denied'));
    const trail = lookTrail(h.ctx, calls);
    expect(trail).toEqual(['GarageController.luau', 'the code (searched for "UIScale")', 'the task "Add a touch button for the boost dash on mobile"', 'evidence "Garage at desktop size"', 'the tests and their last results', "Studio's state"]);
    expect(trailLine(trail, true)).toBe('Looked at: GarageController.luau, the code (searched for "UIScale"), the task "Add a touch button for the boost dash on mobile", evidence "Garage at desktop size", the tests and their last results, Studio\'s state.');
    expect(trailLine([], false)).toBe('Looking into it before I answer…');
    expect(trailLine([], true)).toBe('Looked into it.');
    for (const tool of ['evidence_search', 'test_results', 'decided_list', 'studio_place', 'ui_snapshot']) expect(describeCall(`mcp__shuriken__${tool}`, {})).not.toBe(tool.replace(/_/g, ' '));
  });

  it('says so when the look fails, and still answers a look that comes back as "look"', async () => {
    let fail = true;
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        if (!isLook(req)) return { intent: 'look', lookFor: 'x', reply: 'Looking.' };
        if (fail) throw new Error('ran out of turns');
        return { intent: 'look', reply: 'The garage is one desktop layout.' };
      },
    });
    mechGame(h);
    h.core.director.send('how is the garage laid out?');
    const chat = h.core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.kind === 'error'));
    expect(chat.list().find((m) => m.kind === 'error')!.text).toMatch(/^I couldn't finish looking into that \(.*ran out of turns.*\)\. Try again, or ask about one part of it at a time\.$/);
    expect(replies(h.core)).toHaveLength(0);
    fail = false;
    h.core.director.send('how is the garage laid out?');
    await waitFor(() => replies(h.core).length === 1);
    expect(replies(h.core)[0]!.text).toBe('The garage is one desktop layout.');
  });
});
