/** Opt-in only: CODEX_LIVE=1 CODEX_LIVE_MODEL=<explicit non-Astra catalog id>.
 * Own temporary data/project/Studio only. No credential copies, plugins, publish or video.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Core } from '../../src/core/core';
import { CodexProvider } from '../../src/core/providers/codex/codex-provider';
import { FakeProvider } from '../helpers/fake-provider';
import { ROLES, type RoleDefinition } from '../../src/core/agents/roles';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import { ModelStore } from '../../src/core/modeling/model-store';

describe.runIf(process.env.CODEX_LIVE === '1')('Codex actual account, isolated Shuriken project', () => {
  let core: Core;
  let project: ReturnType<Core['openProject']>;
  let root = '';
  const evidence: Record<string, unknown> = {};
  const pids: number[] = [];
  const placeName = `shuriken-codex-live-${Date.now()}.rbxlx`;
  const model = process.env.CODEX_LIVE_MODEL;
  const role = (tools: string[], builtin: RoleDefinition['builtinTools'] = ['read_files', 'edit_files']): RoleDefinition => ({ ...ROLES.critic!, id: 'codex-live', name: 'Codex qualification', model: 'fast', builtinTools: builtin, appTools: tools, maxTurns: 12, effort: 'low', instructions: 'Perform only the explicit qualification task. Use only the listed Shuriken MCP tools. Never open another project or publish. Return the requested result promptly.' });
  const run = (directive: string, tools: string[], extra: Partial<Parameters<Core['runner']['run']>[0]> = {}) => {
    const timeout = AbortSignal.timeout(110_000);
    return core.runner.run({ project, role: role(tools), task: null, directive, contextText: directive, output: null, ...extra, signal: extra.signal ? AbortSignal.any([timeout, extra.signal]) : timeout });
  };
  beforeAll(async () => {
    if (!model || /astra|default/i.test(model)) throw new Error('Set CODEX_LIVE_MODEL to an explicit non-Astra model');
    root = resolve('.cache', `codex-qualification-${Date.now()}`); mkdirSync(root, { recursive: true });
    core = await Core.create({ dataDir: join(root, 'data'), resourcesDir: resolve('resources'), providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, appVersion: 'codex-qualification-2' });
    project = core.openProject(core.createProject({ name: 'Codex qualification', rootPath: join(root, 'project') }).id);
    core.orchestrator.pause(); project.updateExtras({ syncMode: 'none' });
    core.providers.register(new CodexProvider(() => model, undefined, (pid) => pids.push(pid)));
    core.providers.setAssignments({ default: 'fake', roles: { 'codex-live': 'codex' } });
    evidence.model = model;
  }, 60_000);
  afterAll(async () => {
    if (core) await core.shutdown();
    // Match only the uniquely named window this test opened, never the user's original place.
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${placeName}*' } | Stop-Process -Force`], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }); } catch {}
    if (root) writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  });
  it('uses real MCP tools to create and read a project file', async () => {
    const out = await run('Use workspace_write_file to create qualification.txt containing exactly CODEX_MCP_VERIFIED, expectedSha256 absent. Read it using workspace_read_file. Return the structured work result with status implemented.', ['workspace_write_file', 'workspace_read_file'], { output: 'work' });
    evidence.basic = { ok: out.completion.ok, error: out.completion.error, durationMs: out.completion.durationMs };
    expect(out.completion.ok, out.completion.error ?? '').toBe(true);
    expect(readFileSync(join(project.root, 'qualification.txt'), 'utf8')).toBe('CODEX_MCP_VERIFIED');
    expect(out.structured).toMatchObject({ status: 'implemented' });
  }, 300_000);
  it('writes Luau then confirms synchronization in an isolated Studio', async () => {
    const file = join(project.root, placeName); writeFileSync(file, sandboxPlaceXml('Codex qualification'));
    project.updateSettings({ robloxStudioMatch: placeName }); core.studio.bind(placeName);
    await core.studio.start();
    await core.studio.openPlace(file, placeName, 90_000, { background: true });
    project.updateSettings({ robloxStudioMatch: placeName }); core.studio.bind(placeName);
    const out = await run('Create src/Server/CodexQualification.server.luau using workspace_write_file, expectedSha256 absent. Its entire content must be: workspace:SetAttribute("CodexQualification", 42). Return DONE.', ['workspace_write_file']);
    expect(out.completion.ok, out.completion.error ?? '').toBe(true);
    const sync = await core.sync.push(project.root, project.extras().syncMap);
    evidence.studio = { errors: sync.errors, created: sync.created, updated: sync.updated };
    expect(sync.errors).toEqual([]);
    const check = await core.studio.runLuau('local s=game.ServerScriptService:FindFirstChild("Server"); local q=s and s:FindFirstChild("CodexQualification"); return q and q.Source or "MISSING"', 'Edit');
    expect(check.ok, check.output).toBe(true); expect(check.output).toContain('CodexQualification');
  }, 300_000);
  it('runs a real temporary Blender export through the Shuriken tool', async () => {
    const out = await run('Find the blender_create_box tool on the shuriken_controlled MCP server and call it with model "CodexFixture", width 2, depth 2, and height 2. Return DONE only if the tool succeeds. Do not use Kiln, the shell or external assets.', ['blender_create_box'], { role: { ...role(['blender_create_box']), builtinTools: [] } });
    const store = new ModelStore(project.root);
    const single = store.get('CodexFixture');
    const parts = single ? [single] : store.parts('CodexFixture');
    evidence.blender = { ok: out.completion.ok, error: out.completion.error, parts: parts.length };
    expect(out.completion.ok, out.completion.error ?? '').toBe(true); expect(parts.length).toBeGreaterThan(0);
    expect(parts.some((p) => existsSync(new ModelStore(project.root).paths(p.name).glb))).toBe(true);
  }, 300_000);
  it('cancels a real turn and resumes the same compatible session', async () => {
    const stop = new AbortController(); let runId: string | null = null;
    if (!existsSync(join(project.root, 'qualification.txt'))) writeFileSync(join(project.root, 'qualification.txt'), 'CODEX_MCP_VERIFIED');
    let cancelledAt = 0;
    const off = core.bus.on('run.stream', (event) => { if (event.runId === runId && event.kind === 'tool_use' && !stop.signal.aborted) { cancelledAt = Date.now(); stop.abort(); } });
    const begin = Date.now();
    const interrupted = await run('Read qualification.txt using workspace_read_file. Then read it four more times and report DONE.', ['workspace_read_file'], { signal: stop.signal, onRun: (id) => { runId = id; } }); off();
    expect(interrupted.completion.errorKind).toBe('interrupted');
    const pid = pids.at(-1)!;
    let stillRunning = false;
    try { stillRunning = process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    const stopMs = Date.now() - cancelledAt;
    expect(stillRunning).toBe(false);
    expect(stopMs).toBeLessThan(10_000);
    const resumed = await run('Continue your interrupted qualification. Read qualification.txt once and answer RESUMED.', ['workspace_read_file'], { resumeSessionId: interrupted.run.providerSessionId, continuesRunId: interrupted.run.id });
    evidence.resume = { interrupted: interrupted.completion.errorKind, ok: resumed.completion.ok, error: resumed.completion.error, elapsedMs: Date.now() - begin, stopMs, stillRunning, sameSession: resumed.run.providerSessionId === interrupted.run.providerSessionId };
    expect(resumed.completion.ok, resumed.completion.error ?? '').toBe(true); expect(resumed.completion.resultText).toContain('RESUMED');
    expect(resumed.run.providerSessionId).toBe(interrupted.run.providerSessionId);
  }, 300_000);
});
