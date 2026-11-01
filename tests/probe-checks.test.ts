import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerificationMethod } from '../src/shared/domain';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { PROBE_AMENDED, amendmentNotes } from '../src/core/verification/check-edits';
import { isEmptyProbe, lintCheck, stripLuau, wrongSideUses } from '../src/core/verification/probe-lint';
import { TestService, testName } from '../src/core/verification/test-service';
import { VERIFY_CLOCK } from '../src/core/verification/verifier';
import { coreHarness, planArgs } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/**
 * Checks that match the code. In the user's 8-hour build at least six of twelve failed verifications were the
 * probe's fault: written by the planner before the code existed, stored for the wrong side
 * (mech_moves_with_move_vector: a client probe run on the server), or built on an assumption the task never had.
 */
const makeCore = coreHarness();
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const SERVER_OK = 'local p = game:GetService("Players"):GetPlayers()[1]\nreturn p and "PASS" or "FAIL: no player"';
const CLIENT_CODE = 'local lp = game:GetService("Players").LocalPlayer\nlp.PlayerScripts.Move:FireServer(Vector3.new(1, 0, 0))\nreturn "PASS"';

const savedClock = { ...VERIFY_CLOCK };
beforeEach(() => {
  VERIFY_CLOCK.secondMs = 5;
});
afterEach(() => {
  Object.assign(VERIFY_CLOCK, savedClock);
});

describe('the probe lint', () => {
  it('finds what only the client has in code that runs on the server', () => {
    expect(wrongSideUses(CLIENT_CODE, 'server').map((u) => u.what)).toEqual(['Players.LocalPlayer', ':FireServer(']);
    expect(wrongSideUses('local cam = workspace.CurrentCamera\nlocal uis = game:GetService("UserInputService")\nreturn "PASS"', 'server').map((u) => u.what)).toEqual(['workspace.CurrentCamera', 'UserInputService']);
    expect(wrongSideUses('return game.UserInputService.TouchEnabled and "PASS" or "FAIL"', 'server')).toHaveLength(1);
    expect(wrongSideUses('return remote:InvokeServer() and "PASS"', 'server')[0]!.what).toBe(':InvokeServer(');
    expect(wrongSideUses(SERVER_OK, 'server')).toEqual([]);
    // The same code is at home on the client.
    expect(wrongSideUses(CLIENT_CODE, 'client')).toEqual([]);
  });

  it("doesn't count comments, or words inside strings", () => {
    const code = '-- the client reads Players.LocalPlayer and calls :FireServer(x)\n--[[ workspace.CurrentCamera ]]\nlocal src = script.Parent.Client.Source\nreturn string.find(src, ".LocalPlayer", 1, true) and "PASS" or "FAIL: the client never reads :FireServer("';
    expect(wrongSideUses(code, 'server')).toEqual([]);
    expect(stripLuau('local a = "x.LocalPlayer" -- .LocalPlayer\nlocal b = [[ :FireServer( ]]', false)).toBe('local a = "" \nlocal b = ""');
    // Names that only start like them are something else.
    expect(wrongSideUses('return data.LocalPlayerData and cam.CurrentCameraMode and "PASS"', 'server')).toEqual([]);
  });

  it('finds what only the server has in a client probe, and what Edit mode can never have', () => {
    expect(wrongSideUses('local s = game:GetService("ServerScriptService")\nlocal d = game:GetService("DataStoreService")\nremote:FireAllClients()\nreturn "PASS"', 'client').map((u) => u.what)).toEqual(['ServerScriptService', 'DataStoreService', ':FireAllClients(']);
    expect(wrongSideUses('return game.ServerStorage.Mechs and "PASS"', 'client')[0]!.what).toBe('ServerStorage');
    expect(wrongSideUses(CLIENT_CODE, 'edit').map((u) => u.what)).toEqual(['Players.LocalPlayer', ':FireServer(']);
    // The Studio camera exists in Edit, and so do the services.
    expect(wrongSideUses('return workspace.CurrentCamera and game:GetService("ServerStorage") and "PASS"', 'edit')).toEqual([]);
  });

  it('says which check, which side, what it used and how to register it instead', () => {
    const msg = lintCheck({ kind: 'playtest', name: 'mech_moves_with_move_vector', durationSec: 10, luau: CLIENT_CODE, failOnConsoleErrors: true })!;
    expect(msg).toMatch(/^Check "mech_moves_with_move_vector" was not registered: its probe \(luau\) runs on the server but uses Players\.LocalPlayer \(it is nil on the server\), :FireServer\(/);
    expect(msg).toMatch(/Register it as a client probe: a luau_assert with "datamodel":"client", or a playtest's "clientLuau"/);
    expect(lintCheck({ kind: 'playtest', name: 'x', durationSec: 10, luau: SERVER_OK, clientLuau: CLIENT_CODE, failOnConsoleErrors: true })).toBeNull();
    expect(lintCheck({ kind: 'luau_assert', name: 'x', luau: CLIENT_CODE, datamodel: 'client' })).toBeNull();
    expect(lintCheck({ kind: 'luau_assert', name: 'x', luau: 'return game:GetService("ServerStorage").A and "PASS"', datamodel: 'client' })).toMatch(/runs on the client but uses ServerStorage.*Register it as a server probe/);
    expect(lintCheck({ kind: 'luau_assert', name: 'x', luau: CLIENT_CODE })).toMatch(/runs in Edit mode but uses .*Edit mode has no player/);
    expect(lintCheck({ kind: 'perf', name: 'p', maxHeartbeatMs: 16 })).toBeNull();
  });

  it('knows a probe that tests nothing', () => {
    expect(isEmptyProbe('return "PASS"')).toBe(true);
    expect(isEmptyProbe("-- fixed\nreturn ('PASS: fine')\n")).toBe(true);
    expect(isEmptyProbe(SERVER_OK)).toBe(false);
  });
});

async function setup(verification: VerificationMethod[] = []) {
  const h = await makeCore({ respond: async () => null });
  h.core.orchestrator.pause();
  const sim = attachSim(h.core);
  sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : 'PASS');
  const goal = h.ctx.tasks.create({ kind: 'objective', title: 'Mech arena', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const plan = h.ctx.tasks.create({ parentId: goal.id, kind: 'plan', title: 'Plan', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
  const task = h.ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Mech movement', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', acceptanceCriteria: ['The mech moves with the move vector'], verification });
  const as = (role: string, taskId: string | null, runId = `run_${role}`) => ({ kind: 'agent' as const, runId, taskId, role, providerId: null, allowedTools: null });
  const worker = as('roblox-engineer', task.id, 'run_worker');
  return { ...h, sim, goal, plan, task, as, worker };
}

describe('registering a check whose probe runs on the wrong side', () => {
  it('plan_add_task refuses it and adds nothing; with the probe on its side the task is added', async () => {
    const { core, ctx, goal, plan, as } = await setup();
    const planner = as('executive', plan.id);
    const bad = await core.tools.invoke('plan_add_task', { ...planArgs('move', 'roblox-engineer'), verification: [{ kind: 'playtest', name: 'mech_moves', durationSec: 10, luau: CLIENT_CODE }, { kind: 'critic' }] }, planner);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Check "mech_moves" was not registered: its probe \(luau\) runs on the server but uses Players\.LocalPlayer/);
    expect(text(bad)).toMatch(/The task was not added/);
    expect(ctx.tasks.byPlanKey(goal.id, 'move')).toBeNull();
    const good = await core.tools.invoke('plan_add_task', { ...planArgs('move', 'roblox-engineer'), verification: [{ kind: 'playtest', name: 'mech_moves', durationSec: 10, clientLuau: CLIENT_CODE }, { kind: 'critic' }] }, planner);
    expect(good.isError, text(good)).toBeFalsy();
    const made = ctx.tasks.byPlanKey(goal.id, 'move')!;
    expect(made.verification.find((m) => m.kind === 'playtest')).toMatchObject({ name: 'mech_moves', clientLuau: CLIENT_CODE });
    expect(made.verification.find((m) => m.kind === 'playtest')).not.toHaveProperty('luau', CLIENT_CODE);
  });

  it('test_register and task_update_verification refuse it too, before anything changes', async () => {
    const { core, ctx, task, as } = await setup([{ kind: 'static_analysis' }, { kind: 'luau_assert', name: 'old_check', luau: "return 'PASS'", datamodel: 'edit' }, { kind: 'critic' }]);
    const qa = as('qa-engineer', task.id);
    const reg = await core.tools.invoke('test_register', { name: 'camera_follows', kind: 'luau_assert', luau: 'return workspace.CurrentCamera.CameraSubject and "PASS"', datamodel: 'server' }, qa);
    expect(reg.isError).toBe(true);
    expect(text(reg)).toMatch(/runs on the server but uses workspace\.CurrentCamera/);
    expect(new TestService(ctx.store).list()).toEqual([]);
    const ok = await core.tools.invoke('test_register', { name: 'camera_follows', kind: 'playtest', client_luau: 'return workspace.CurrentCamera.CameraSubject and "PASS"' }, qa);
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(new TestService(ctx.store).list()[0]!.spec).toMatchObject({ kind: 'playtest', clientLuau: expect.stringContaining('CurrentCamera') });
    const upd = await core.tools.invoke('task_update_verification', { task: task.id, remove: ['old_check'], add: [{ kind: 'luau_assert', name: 'fires', luau: 'remote:FireServer()\nreturn "PASS"', datamodel: 'server' }], reason: 'Replace the old check with one that fires the remote' }, qa);
    expect(upd.isError).toBe(true);
    expect(text(upd)).toMatch(/Check "fires" was not registered/);
    expect(ctx.tasks.get(task.id)!.verification.map((m) => ('name' in m ? m.name : m.kind))).toEqual(['static_analysis', 'old_check', 'critic']);
  });
});

describe('client probes in verification', () => {
  it('a luau_assert with datamodel "client" runs in the Client DataModel of a short playtest, a playtest runs both probes', async () => {
    const { core, ctx, sim, task } = await setup([
      { kind: 'luau_assert', name: 'hud_there', luau: 'return game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("Hud") and "PASS" or "FAIL: no HUD"', datamodel: 'client' },
      { kind: 'playtest', name: 'move_both', durationSec: 3, luau: SERVER_OK, clientLuau: CLIENT_CODE, failOnConsoleErrors: true },
    ]);
    sim.answer = (code, dm) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : code.includes('PlayerGui') ? (dm === 'Client' ? 'PASS' : 'ERROR ran on the wrong side') : dm === 'Client' ? 'FAIL: the mech did not move' : 'PASS');
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    const hud = report.results.find((r) => r.name === 'hud_there')!;
    expect(hud.passed, hud.output).toBe(true);
    expect(hud.output).toMatch(/^Playtest 4s: PASS\nClient probe: PASS/);
    const both = report.results.find((r) => r.name === 'move_both')!;
    expect(both.passed).toBe(false);
    expect(both.output).toMatch(/^Playtest 3s: FAIL\nServer probe: PASS\nClient probe: FAIL: the mech did not move/);
    expect(sim.luau('Client').some((c) => c.code.includes('PlayerGui'))).toBe(true);
    expect(sim.luau('Server').some((c) => c.code.includes('PlayerGui'))).toBe(false);
  });
});

describe('task_run_checks: the worker runs its task\'s checks as verification will', () => {
  const CHECKS: VerificationMethod[] = [
    { kind: 'static_analysis' },
    { kind: 'luau_assert', name: 'parts_named', luau: 'return workspace:FindFirstChild("Mech") and "PASS" or "FAIL: no Mech"', datamodel: 'edit' },
    { kind: 'playtest', name: 'mech_moves', durationSec: 3, luau: SERVER_OK, failOnConsoleErrors: true },
    { kind: 'screenshot', name: 'mech_view', instructions: 'The mech stands on the pad' },
    { kind: 'manual', instructions: 'Drive it around' },
    { kind: 'critic' },
  ];

  it('gives the same result text as the verification, and records nothing', async () => {
    const { core, ctx, sim, task, worker } = await setup(CHECKS);
    sim.answer = (code, dm) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : dm === 'Edit' ? 'FAIL: no Mech' : 'PASS');
    const r = await core.tools.invoke('task_run_checks', {}, worker);
    expect(r.isError, text(r)).toBeFalsy();
    const out = text(r);
    expect(out).toMatch(/^Your task's checks, run now as verification will run them \(nothing recorded\):/);
    expect(out).toMatch(/FAIL {2}parts_named \(luau_assert\)\n {4}FAIL: no Mech/);
    expect(out).toMatch(/PASS {2}mech_moves \(playtest\)\n {4}Playtest 3s: PASS\n {4}Server probe: PASS\n {4}No runtime errors \(LogService history checked on Server and Client\)\./);
    expect(out).toMatch(/SKIP {2}mech_view \(screenshot\)\n {4}Not run here: the critic looks at this picture/);
    expect(out).toMatch(/SKIP {2}manual\n {4}Not run here: this check is put to a person/);
    expect(out).toMatch(/1 of them would fail verification now: parts_named\./);
    expect(r.data).toMatchObject({ passed: false });
    // Nothing recorded: no evidence, no registered tests, no results, nobody asked, Studio free again.
    expect(ctx.tasks.evidence(task.id)).toEqual([]);
    expect(new TestService(ctx.store).list()).toEqual([]);
    expect(ctx.governance.escalations().length).toBe(0);
    expect(core.lease.holder).toBeNull();
    // The verification itself says the same about the same checks.
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    for (const name of ['parts_named', 'mech_moves']) {
      const v = report.results.find((x) => x.name === name)!;
      expect(out).toContain(v.output.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    expect(new TestService(ctx.store).list().length).toBeGreaterThan(0);
  });

  it('is for the task of the caller, and not during its own playtest', async () => {
    const { core, task, worker, as } = await setup(CHECKS);
    expect(text(await core.tools.invoke('task_run_checks', {}, as('roblox-engineer', null)))).toMatch(/You have no task/);
    core.lease.tryAcquire(worker.runId);
    const busy = await core.tools.invoke('task_run_checks', {}, worker);
    expect(busy.isError).toBe(true);
    expect(text(busy)).toMatch(/Your own playtest is running: stop it first/);
    core.lease.release(worker.runId);
    expect(task.verification).toHaveLength(6);
  });

  it('workers are told to run it before finishing (one line in the common instructions)', async () => {
    const { ROLES } = await import('../src/core/agents/roles');
    for (const role of ['roblox-engineer', 'luau-engineer', 'ui-engineer', 'qa-engineer']) {
      expect(ROLES[role]!.instructions.replace(/\s+/g, ' ')).toMatch(/before you finish, run task_run_checks .* a probe that is itself wrong, not the game, is corrected with task_fix_probe/);
    }
  });
});

describe('task_fix_probe: the worker corrects a wrong probe of its own task', () => {
  const OLD: VerificationMethod = { kind: 'playtest', name: 'mech_moves', durationSec: 10, luau: 'local M = require(game.ServerScriptService.Server.Mechs)\nreturn M.spawn("bot") and "PASS" or "FAIL"', failOnConsoleErrors: true };
  const REASON = 'The probe required a fresh copy of the Mechs module, so the game never saw the mech it spawned.';

  it('changes the probe only: the reason is required and recorded, and the critic is shown the old and the new probe', async () => {
    const { core, ctx, task, worker } = await setup([{ kind: 'static_analysis' }, OLD, { kind: 'critic' }]);
    expect((await core.tools.invoke('task_fix_probe', { check: 'mech_moves', luau: SERVER_OK }, worker)).isError).toBe(true);
    expect((await core.tools.invoke('task_fix_probe', { check: 'mech_moves', luau: SERVER_OK, reason: 'wrong' }, worker)).isError).toBe(true);
    const r = await core.tools.invoke('task_fix_probe', { check: 'mech_moves', luau: SERVER_OK, reason: REASON }, worker);
    expect(r.isError, text(r)).toBeFalsy();
    const now = ctx.tasks.get(task.id)!;
    expect(now.verification.map((m) => m.kind)).toEqual(['static_analysis', 'playtest', 'critic']);
    expect(now.verification[1]).toEqual({ ...OLD, luau: SERVER_OK });
    expect(now.acceptanceCriteria).toEqual(['The mech moves with the move vector']);
    const ev = ctx.tasks.evidence(task.id).find((e) => e.title === `${PROBE_AMENDED} mech_moves`)!;
    expect(ev.data).toMatchObject({ check: 'mech_moves', reason: REASON, by: 'roblox-engineer', before: [{ side: 'server', code: OLD.luau }], after: [{ side: 'server', code: SERVER_OK }] });
    expect(ctx.audit.timeline({ limit: 20 }).some((e) => e.kind === 'task.verification' && /corrected the probe of "mech_moves"/.test(e.title))).toBe(true);
    const notes = amendmentNotes(ctx, task.id);
    expect(notes).toMatch(/The worker changed the probe of a check of this task/);
    expect(notes).toMatch(/A probe weakened so that broken work passes is a defect: reject the task for it\./);
    expect(notes).toContain(`Check "mech_moves" — the worker's reason: ${REASON}\n--- old probe\n[runs on: server]\n${OLD.luau}\n--- new probe\n[runs on: server]\n${SERVER_OK}`);
    // No way to touch the acceptance criteria through this tool.
    const sneaky = await core.tools.invoke('task_fix_probe', { check: 'mech_moves', luau: SERVER_OK, reason: REASON, acceptanceCriteria: ['Anything'] }, worker);
    expect(text(sneaky)).toMatch(/unchanged/);
    expect(ctx.tasks.get(task.id)!.acceptanceCriteria).toEqual(['The mech moves with the move vector']);
  });

  it('moves a probe to the side it belongs on (the stored-as-server client probe)', async () => {
    const stored: VerificationMethod = { kind: 'playtest', name: 'mech_moves_with_move_vector', durationSec: 10, luau: CLIENT_CODE, failOnConsoleErrors: true };
    const { core, ctx, task, worker } = await setup([stored, { kind: 'luau_assert', name: 'hud', luau: CLIENT_CODE, datamodel: 'server' }, { kind: 'critic' }]);
    const moved = await core.tools.invoke('task_fix_probe', { check: 'mech_moves_with_move_vector', luau: '', client_luau: CLIENT_CODE, reason: 'It is a client probe (LocalPlayer, FireServer) that was stored to run on the server.' }, worker);
    expect(moved.isError, text(moved)).toBeFalsy();
    expect(text(moved)).toMatch(/runs on: client/);
    const pt = ctx.tasks.get(task.id)!.verification[0]!;
    expect(pt).toMatchObject({ kind: 'playtest', clientLuau: CLIENT_CODE });
    expect(pt).not.toHaveProperty('luau');
    const dm = await core.tools.invoke('task_fix_probe', { check: 'hud', datamodel: 'client', reason: 'It reads LocalPlayer, which only exists on the client.' }, worker);
    expect(dm.isError, text(dm)).toBeFalsy();
    expect(ctx.tasks.get(task.id)!.verification[1]).toMatchObject({ kind: 'luau_assert', datamodel: 'client', luau: CLIENT_CODE });
  });

  it("refuses: another role, another's test, an emptied or removed probe, a probe on the wrong side, and a fourth correction", async () => {
    const { core, ctx, task, worker, as } = await setup([OLD, { kind: 'luau_assert', name: 'shared', luau: "return 'PASS'", datamodel: 'edit', testId: 'test_other' } as VerificationMethod, { kind: 'perf', name: 'fps', maxHeartbeatMs: 16 }, { kind: 'critic' }]);
    const fix = (args: Record<string, unknown>, who = worker) => core.tools.invoke('task_fix_probe', { reason: REASON, ...args }, who);
    expect(text(await fix({ check: 'mech_moves', luau: SERVER_OK }, as('critic', task.id)))).toMatch(/Only the task's own worker \(roblox-engineer\) corrects its probes/);
    expect(text(await fix({ check: 'mech_moves', luau: SERVER_OK }, as('roblox-engineer', null)))).toMatch(/You have no task/);
    expect(text(await fix({ check: 'nope', luau: SERVER_OK }))).toMatch(/Your task has no check named "nope"\. Its checks: mech_moves, shared, fps, critic/);
    expect(text(await fix({ check: 'shared', luau: SERVER_OK }))).toMatch(/registered regression test this task re-runs/);
    expect(text(await fix({ check: 'fps', luau: SERVER_OK }))).toMatch(/is a perf check: it has no probe of yours to correct/);
    expect(text(await fix({ check: 'mech_moves', luau: 'return "PASS"' }))).toMatch(/tests nothing/);
    expect(text(await fix({ check: 'mech_moves', luau: '' }))).toMatch(/corrected here, not removed/);
    expect(text(await fix({ check: 'mech_moves', luau: CLIENT_CODE }))).toMatch(/Check "mech_moves" was not changed: its probe \(luau\) runs on the server but uses Players\.LocalPlayer/);
    expect(text(await fix({ check: 'mech_moves' }))).toMatch(/Give the corrected probe/);
    expect(ctx.tasks.get(task.id)!.verification[0]).toEqual(OLD);
    for (let i = 1; i <= 3; i++) expect((await fix({ check: 'mech_moves', luau: `${SERVER_OK} -- ${i}\n` })).isError, String(i)).toBeFalsy();
    expect(text(await fix({ check: 'mech_moves', luau: `${SERVER_OK} -- 4\n` }))).toMatch(/was corrected 3 times already/);
    ctx.tasks.setStatus(task.id, 'cancelled');
    expect(text(await fix({ check: 'mech_moves', luau: SERVER_OK }))).toMatch(/is cancelled/);
  });

  it("the test the task registered for the check runs the corrected probe, and the verification passes with it", async () => {
    const { core, ctx, sim, task, worker } = await setup([OLD, { kind: 'critic' }]);
    sim.answer = (code) => (code.includes('GetLogHistory') ? '{"ok":true,"errors":[]}' : code.includes('require(') ? 'FAIL' : 'PASS');
    const first = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    expect(first.passed).toBe(false);
    const tests = new TestService(ctx.store);
    expect(tests.find(testName(task.id, OLD))[0]!.spec).toMatchObject({ luau: OLD.luau });
    expect((await core.tools.invoke('task_fix_probe', { check: 'mech_moves', luau: SERVER_OK, reason: REASON }, worker)).isError).toBeFalsy();
    expect(tests.find(testName(task.id, OLD))[0]!.spec).toMatchObject({ luau: SERVER_OK });
    const again = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null);
    expect(again.passed, again.summary).toBe(true);
  });
});
