import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOCALS, compileProblems, localLimitOverruns } from '../src/core/verification/compile-limits';
import { sendBackLine } from '../src/core/director/narration';
import { coreHarness } from './helpers/make-core';

/**
 * A file that doesn't compile blocks passing. In the Pit build a worker reported that Combat.client.luau no longer
 * compiled ("Out of local registers": more than 200 locals alive in its top level), the analyzers had nothing to say,
 * and the tasks that touched combat kept passing; the user heard "Combat is currently broken" 40 minutes later.
 */
const locals = (n: number, indent = '') => Array.from({ length: n }, (_, i) => `${indent}local v${i} = ${i}`).join('\n');

describe('the local limit Studio compiles against', () => {
  it('finds the function with more than 200 locals alive at once, at the local that went over', () => {
    expect(localLimitOverruns(locals(MAX_LOCALS))).toEqual([]);
    expect(localLimitOverruns(`--!strict\n${locals(MAX_LOCALS + 1)}\n`)).toEqual([{ line: MAX_LOCALS + 2, function: 'the top level of the script', locals: MAX_LOCALS + 1 }]);
    // Several names in one statement count each; types with commas inside them don't.
    expect(localLimitOverruns(`${locals(198)}\nlocal a: { x: number, y: number }, b = {x=1,y=2}, 3\n`)).toEqual([]);
    expect(localLimitOverruns(`${locals(198)}\nlocal a: { x: number, y: number }, b, c = 1, 2, 3\n`)).toHaveLength(1);
  });

  it('counts per function, and frees what a block declared when the block ends', () => {
    // Each function has its own 200; a do-block's locals are gone after its end.
    const nested = `${locals(150)}\nlocal function big(a, b)\n${locals(150, '  ')}\nend\ndo\n${locals(40, '  ')}\nend\n${locals(40)}\n`;
    expect(localLimitOverruns(nested)).toEqual([]);
    // Parameters and loop variables are locals too; a method has a self.
    const params = `${locals(197)}\nfor i, v in ipairs(t) do\n  local x = v\n  local y = i\nend\n`;
    expect(localLimitOverruns(params)).toEqual([{ line: 200, function: 'the top level of the script', locals: 201 }]);
    const method = `function Obj:go(a: number, b: string?, ...: any)\n${locals(198, '  ')}\nend\n`;
    expect(localLimitOverruns(method)).toEqual([{ line: 199, function: 'function Obj.go', locals: 201 }]);
    // Comments, strings and long strings don't confuse the blocks.
    const noise = `--[[ function end do ]]\nlocal s = "end end"\nlocal l = [==[ function ]==]\nif x then\n  local a = 1\nelseif y then\n  local b = 2\nelse\n  local c = 3\nend\n${locals(198)}\n`;
    expect(localLimitOverruns(noise)).toEqual([]);
  });

  it("follows Luau's if-expressions, which have no end (else the script's top level is lost in a block that never closes)", () => {
    // Checked against 1,233 scripts of the user's projects: every one ends back at its top level, none is reported.
    const ifExpressions = [
      'local a = if x then 1 else 2',
      'local b = f(if x then 1 else 2, if y then 3 else 4)',
      'local c = if x then 0 else if y then 0.25 else 0.6',
      'local d = if x then if y then 1 else 2 else 3',
      'if x then',
      '  local e = if y then 1 else 2',
      'elseif z then',
      '  local g = 1',
      'else',
      '  local h = if w then 1 else 2',
      'end',
    ].join('\n');
    // a b c d = 4 top-level locals; 196 more is 200, one more is too many.
    expect(localLimitOverruns(`${ifExpressions}\n${locals(196)}`)).toEqual([]);
    expect(localLimitOverruns(`${ifExpressions}\n${locals(197)}`)).toEqual([{ line: 11 + 197, function: 'the top level of the script', locals: 201 }]);
  });

  it('reports a problem the static analysis treats as an error, on the files given', () => {
    const root = join(require('node:os').tmpdir(), `shuriken-compile-${Date.now()}`);
    mkdirSync(join(root, 'src', 'Client'), { recursive: true });
    writeFileSync(join(root, 'src', 'Client', 'Combat.client.luau'), locals(205));
    writeFileSync(join(root, 'src', 'Client', 'Fine.client.luau'), locals(5));
    const problems = compileProblems(root, ['src/Client/Combat.client.luau', 'src/Client/Fine.client.luau', 'src/Client/Gone.luau', 'docs/x.md']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ tool: 'compile', file: 'src/Client/Combat.client.luau', line: 201, severity: 'error', code: 'LocalLimit' });
    expect(problems[0]!.message).toMatch(/Out of local registers: the top level of the script has 205 locals alive at once \(Luau allows 200\)/);
  });
});

const makeCore = coreHarness();

describe('verification with a file that does not compile', () => {
  async function setup(verification: Array<{ kind: 'static_analysis' } | { kind: 'critic' }>) {
    const h = await makeCore({ respond: async () => null });
    h.core.orchestrator.pause();
    h.ctx.updateExtras({ syncMode: 'none', syncMap: { 'src/Client': 'StarterPlayer/StarterPlayerScripts/Client' } });
    const write = (rel: string, body: string) => {
      mkdirSync(join(h.root, rel, '..'), { recursive: true });
      writeFileSync(join(h.root, rel), body, 'utf8');
    };
    const task = h.ctx.tasks.create({ kind: 'implement', title: 'Bow touch aim', objective: 'x', role: 'roblox-engineer', status: 'running', createdBy: 'test', verification });
    return { ...h, task, write };
  }

  it("fails the task and names the file in words, though the analyzers find nothing", async () => {
    const { core, ctx, task, write } = await setup([{ kind: 'static_analysis' }, { kind: 'critic' }]);
    write('src/Client/Combat.client.luau', locals(201));
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null, ['src/Client/Combat.client.luau']);
    expect(report.passed).toBe(false);
    const check = report.results.find((r) => r.kind === 'static_analysis')!;
    expect(check.output.split('\n')[0]).toBe("Broken: The Combat client script (src/Client/Combat.client.luau) doesn't compile (line 201: too many local variables in one function).");
    // The chat's line for the send-back says which file is broken, in plain words.
    const failure = `Verification failed: ${report.summary}`;
    expect(sendBackLine(task.title, failure, { detail: check.output })).toBe("Another pass for Bow touch aim: the Combat client script doesn't compile (line 201: too many local variables in one function).");
  });

  it('runs the static analysis anyway for a task that changed Luau files and was given none (a side task with only the critic)', async () => {
    const { core, ctx, task, write } = await setup([{ kind: 'critic' }]);
    write('src/Client/Combat.client.luau', locals(210));
    const report = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null, ['src/Client/Combat.client.luau']);
    expect(report.passed).toBe(false);
    expect(report.results.map((r) => r.kind)).toEqual(['static_analysis']);
    // A task that changed no Luau file is not given one.
    const clean = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null, ['docs/notes.md']);
    expect(clean.results).toEqual([]);
    expect(clean.passed).toBe(true);
  });

  it("checks the files the agent says it changed, beyond the ones its tool calls show", async () => {
    const { core, ctx, task, write } = await setup([{ kind: 'static_analysis' }, { kind: 'critic' }]);
    write('src/Client/Fine.client.luau', locals(3));
    write('src/Client/Combat.client.luau', locals(203));
    const quiet = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null, ['src/Client/Fine.client.luau']);
    expect(quiet.passed).toBe(true);
    const told = await core.verifier.verify(ctx, ctx.tasks.get(task.id)!, null, ['src/Client/Fine.client.luau'], undefined, ['src/Client/Combat.client.luau']);
    expect(told.passed).toBe(false);
    expect(told.summary).toMatch(/Broken: The Combat client script/);
  });

  it('the regression suite checks every script the project syncs', async () => {
    const { core, ctx, write } = await setup([]);
    write('src/Client/Combat.client.luau', locals(202));
    const { TestService } = await import('../src/core/verification/test-service');
    new TestService(ctx.store).register({ name: 'static', method: { kind: 'static_analysis' }, taskId: null });
    const report = await core.verifier.regression(ctx, null);
    expect(report.passed).toBe(false);
    expect(report.summary).toMatch(/Broken: The Combat client script \(src\/Client\/Combat\.client\.luau\) doesn't compile/);
  });
});
