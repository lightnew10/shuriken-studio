import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/db/store';
import { GLOBAL_MIGRATIONS, PROJECT_MIGRATIONS } from '../src/core/db/schema';
import { EventBus } from '../src/core/events';
import { AuditService } from '../src/core/audit/audit-service';
import { TaskGraph } from '../src/core/tasks/task-graph';
import { KnowledgeService, toFtsQuery } from '../src/core/knowledge/knowledge-service';
import { seedKnowledge } from '../src/core/knowledge/seed';
import { decideFileWrite, decideShell, DEFAULT_ESCALATION, decideToolClass } from '../src/core/permissions/policy';
import { validatePlan, normalizeVerification } from '../src/core/orchestrator/orchestrator';
import { parseSkillFile } from '../src/core/skills/skill-service';
import { diffSnapshots } from '../src/core/roblox/snapshot-diff';
import { cleanLuauError, parseState, withErrorLines } from '../src/core/roblox/studio-adapter';
import { LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { classOfFile, luauFnv } from '../src/core/roblox/luau-toolchain';
import { summarize } from '../src/core/health/health-service';
import { newId } from '../src/shared/ids';
import { Logger } from '../src/core/log';
import { explicitTaskReference } from '../src/core/capabilities/plan-tools';
import { mapAuditLuau, mapFindings, type MapAudit } from '../src/core/roblox/map-audit';
import { compactSchema } from '../src/core/capabilities/app-tools';

function projectStore() {
  const store = new Store(':memory:', PROJECT_MIGRATIONS);
  const bus = new EventBus();
  const audit = new AuditService(store, bus);
  return { store, bus, audit, tasks: new TaskGraph(store, bus, audit) };
}

describe('ids', () => {
  it('are time-sortable and unique', () => {
    const a = newId('x');
    const b = newId('x');
    expect(a).not.toBe(b);
    expect(a.startsWith('x_')).toBe(true);
    expect([b, a].sort()[0]).toBe(a < b ? a : b);
  });
});

describe('store + migrations', () => {
  it('applies migrations once and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-db-'));
    const path = join(dir, 'g.db');
    const s1 = new Store(path, GLOBAL_MIGRATIONS);
    expect(s1.schemaVersion()).toBe(1);
    s1.close();
    const s2 = new Store(path, GLOBAL_MIGRATIONS);
    expect(s2.schemaVersion()).toBe(1);
    s2.close();
  });

  it('rolls back failed transactions', () => {
    const { store } = projectStore();
    expect(() =>
      store.tx(() => {
        store.run(`INSERT INTO meta (key, value) VALUES ('a', '1')`);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.get(`SELECT * FROM meta WHERE key = 'a'`)).toBeUndefined();
  });
});

describe('task graph', () => {
  it('enforces the status machine', () => {
    const { tasks } = projectStore();
    const t = tasks.create({ kind: 'implement', title: 'A', objective: 'a', role: 'roblox-engineer', createdBy: 'test', status: 'ready' });
    expect(() => tasks.setStatus(t.id, 'verified')).toThrow(/Illegal task transition/);
    tasks.setStatus(t.id, 'running');
    expect(tasks.get(t.id)!.attempts).toBe(1);
    tasks.setStatus(t.id, 'implemented');
    tasks.setStatus(t.id, 'verifying');
    tasks.setStatus(t.id, 'reviewing');
    tasks.setStatus(t.id, 'verified');
    tasks.setStatus(t.id, 'done');
    expect(tasks.get(t.id)!.completedAt).not.toBeNull();
  });

  it('rejects dependency cycles and computes runnable tasks', () => {
    const { tasks } = projectStore();
    const a = tasks.create({ kind: 'implement', title: 'A', objective: 'a', role: 'r', createdBy: 't', status: 'ready' });
    const b = tasks.create({ kind: 'implement', title: 'B', objective: 'b', role: 'r', createdBy: 't', status: 'ready', dependencies: [a.id] });
    expect(() => tasks.addDependency(a.id, b.id)).toThrow(/cycle/);
    expect(tasks.runnable().map((t) => t.id)).toEqual([a.id]);
    tasks.setStatus(a.id, 'running');
    tasks.setStatus(a.id, 'done');
    expect(tasks.runnable().map((t) => t.id)).toEqual([b.id]);
  });

  it('flags tasks whose dependency was cancelled', () => {
    const { tasks } = projectStore();
    const a = tasks.create({ kind: 'implement', title: 'A', objective: 'a', role: 'r', createdBy: 't', status: 'ready' });
    const b = tasks.create({ kind: 'implement', title: 'B', objective: 'b', role: 'r', createdBy: 't', status: 'ready', dependencies: [a.id] });
    tasks.setStatus(a.id, 'cancelled');
    expect(tasks.deadlocked().map((t) => t.id)).toEqual([b.id]);
  });

  it('records evidence and failures', () => {
    const { tasks } = projectStore();
    const a = tasks.create({ kind: 'implement', title: 'A', objective: 'a', role: 'r', createdBy: 't', status: 'ready' });
    tasks.addEvidence({ taskId: a.id, runId: null, kind: 'note', title: 'n', passed: true, data: { x: 1 }, path: null });
    tasks.addFailure({ taskId: a.id, runId: null, attempt: 1, stage: 'verify', summary: 'bad', detail: null });
    expect(tasks.evidence(a.id)[0]!.data).toEqual({ x: 1 });
    expect(tasks.get(a.id)!.failureSummary).toBe('bad');
  });
});

describe('knowledge', () => {
  function svc() {
    const global = new Store(':memory:', GLOBAL_MIGRATIONS);
    const project = new Store(':memory:', PROJECT_MIGRATIONS);
    const k = new KnowledgeService(global, new EventBus());
    k.attachProject(project);
    return k;
  }

  it('routes scopes to the right store and searches both', () => {
    const k = svc();
    const g = k.add({ scope: 'roblox', category: 'research', title: 'RemoteEvent rate limiting', body: 'Server must throttle RemoteEvent spam per player.', confidence: 0.8, createdBy: 't', sources: [{ kind: 'url', ref: 'https://create.roblox.com', authority: 'official' }] });
    const p = k.add({ scope: 'project', category: 'project', title: 'Our remotes live in ReplicatedStorage.Remotes', body: 'Project convention for RemoteEvent placement.', confidence: 0.9, createdBy: 't' });
    expect(g.store).toBe('global');
    expect(p.store).toBe('project');
    const res = k.search({ text: 'RemoteEvent' });
    expect(res.map((r) => r.id).sort()).toEqual([g.id, p.id].sort());
  });

  it('filters by source authority, agent, domain, version, date and validation', () => {
    const k = svc();
    const official = k.add({ scope: 'roblox', category: 'research', title: 'StreamingEnabled default', body: 'New places stream.', confidence: 0.8, createdBy: 'researcher', versionApplicability: 'Studio 0.715+', sources: [{ kind: 'url', ref: 'https://create.roblox.com/docs', authority: 'official' }] });
    const observed = k.add({ scope: 'project', category: 'experimental', title: 'Swing pipeline', body: 'Hit resolver order.', confidence: 0.6, createdBy: 'luau-engineer', domain: 'combat', sources: [{ kind: 'run', ref: 'run_1', authority: 'observed' }] });
    expect(k.search({ authorities: ['official'] }).map((e) => e.id)).toEqual([official.id]);
    expect(k.search({ authorities: ['observed', 'staff'] }).map((e) => e.id)).toEqual([observed.id]);
    expect(k.search({ createdBy: 'luau-engineer' }).map((e) => e.id)).toEqual([observed.id]);
    expect(k.search({ domain: 'combat' }).map((e) => e.id)).toEqual([observed.id]);
    expect(k.search({ version: '0.715' }).map((e) => e.id)).toEqual([official.id]);
    expect(k.search({ version: '100%' })).toEqual([]);
    expect(k.search({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
    expect(k.search({ validatedOnly: true })).toEqual([]);
    k.validate(observed.id, 'Playtest evidence evd_2');
    expect(k.search({ validatedOnly: true }).map((e) => e.id)).toEqual([observed.id]);
    const f = k.facets();
    expect(f.createdBy).toEqual(['luau-engineer', 'researcher']);
    expect(f.domains).toEqual(['combat']);
    expect(f.versions).toEqual(['Studio 0.715+']);
  });

  it('requires official sources for authoritative knowledge', () => {
    const k = svc();
    expect(() => k.add({ scope: 'roblox', category: 'authoritative', title: 'x', body: 'y', confidence: 0.9, createdBy: 't', sources: [{ kind: 'url', ref: 'https://forum', authority: 'community' }] })).toThrow(/official/);
  });

  it('promotes only with validation and widens scope', () => {
    const k = svc();
    const e = k.add({ scope: 'project', category: 'experimental', title: 'Touched debounce pattern', body: 'Debounce per character.', confidence: 0.7, createdBy: 't' });
    expect(() => k.promote(e.id, 'roblox', { actor: 't' })).toThrow(/validation/);
    const promoted = k.promote(e.id, 'roblox', { actor: 't', validation: 'Playtest evidence evd_1' });
    expect(promoted.scope).toBe('roblox');
    expect(promoted.promotedFrom).toBe(e.id);
    expect(k.links(promoted.id).some((l) => l.relation === 'derived_from')).toBe(true);
  });

  it('marks contradicting entries as disputed', () => {
    const k = svc();
    const a = k.add({ scope: 'project', category: 'agent', title: 'A claim', body: 'x is true', confidence: 0.5, createdBy: 't' });
    const b = k.add({ scope: 'project', category: 'agent', title: 'B claim', body: 'x is false', confidence: 0.5, createdBy: 't' });
    k.link(b.id, a.id, 'contradicts');
    expect(k.get(a.id)!.status).toBe('disputed');
    expect(k.get(b.id)!.status).toBe('disputed');
  });

  it('builds safe FTS queries', () => {
    expect(toFtsQuery('How do I use "RemoteEvents" -- safely?')).toBe('"remoteevents" OR "safely"');
    expect(toFtsQuery('a')).toBeNull();
  });
});

describe('policy', () => {
  it('flags system commands, not the same words inside scripts (test 3 false alarms)', () => {
    const ask = (cmd: string) => decideShell(cmd, DEFAULT_ESCALATION).outcome;
    // The two commands the user was asked about: a Python edit and a PowerShell timer.
    expect(ask(`cd "C:/p" && python - <<'EOF'\np='world/Lobby.luau'\ns=open(p).read()\nprint("{} lines".format(len(s)))\nEOF`)).toBe('allow');
    expect(ask(`$target = (Get-Date).Date.AddHours(7); Start-Sleep -Seconds 5; Get-Date -Format "HH:mm:ss"`)).toBe('allow');
    expect(ask('python -c "import concurrent.futures as f; e = f.ThreadPoolExecutor(); e.shutdown()"')).toBe('allow');
    // The real ones still ask.
    expect(ask('format D: /q')).toBe('ask');
    expect(ask('cmd /c format e: /fs:ntfs')).toBe('ask');
    expect(ask('shutdown /s /t 0')).toBe('ask');
    expect(ask('cmd /c shutdown -r')).toBe('ask');
    expect(ask('Restart-Computer -Force')).toBe('ask');
    expect(ask('diskpart /s script.txt')).toBe('ask');
    expect(ask('rm -rf build')).toBe('ask');
  });

  it('turns long waits away (agents slept 40–380 s for Studio) without refusing short ones', () => {
    const d = (cmd: string) => decideShell(cmd, DEFAULT_ESCALATION);
    for (const cmd of ['sleep 45; echo done', 'sleep 380', 'Start-Sleep -Seconds 50; "waited"', 'Start-Sleep 30', 'ping -n 50 127.0.0.1 > /dev/null; echo waited', 'timeout /t 60', 'Start-Sleep -Milliseconds 15000', '[System.Threading.Thread]::Sleep(20000)']) {
      expect(d(cmd).outcome, cmd).toBe('deny');
      expect(d(cmd).reason).toMatch(/no need to wait/);
    }
    for (const cmd of ['sleep 2 && git status', 'Start-Sleep -Seconds 5', 'ping -n 1 127.0.0.1', 'git log --since="45 minutes ago"', 'npx vitest run --testTimeout=60000']) expect(d(cmd).outcome, cmd).toBe('allow');
  });

  it('confines writes to the workspace and protects internals', () => {
    const root = join(tmpdir(), 'proj');
    expect(decideFileWrite(join(root, 'src', 'a.luau'), [root]).outcome).toBe('allow');
    expect(decideFileWrite(join(tmpdir(), 'elsewhere.txt'), [root]).outcome).toBe('deny');
    expect(decideFileWrite(join(root, '.git', 'config'), [root]).outcome).toBe('deny');
    expect(decideFileWrite(join(root, '.shuriken', 'project.db'), [root]).outcome).toBe('deny');
  });

  it('escalates destructive shell commands per rules', () => {
    expect(decideShell('rm -rf src', DEFAULT_ESCALATION).outcome).toBe('ask');
    expect(decideShell('Remove-Item -Recurse -Force .\\src', DEFAULT_ESCALATION).outcome).toBe('ask');
    expect(decideShell('git push origin main', DEFAULT_ESCALATION).outcome).toBe('ask');
    expect(decideShell('git status', DEFAULT_ESCALATION).outcome).toBe('allow');
    expect(decideShell('rm -rf src', { ...DEFAULT_ESCALATION, destructiveOperations: 'allow' }).outcome).toBe('allow');
    expect(decideToolClass('spending', DEFAULT_ESCALATION, 'buy').outcome).toBe('deny');
    expect(decideToolClass('roblox_write', DEFAULT_ESCALATION, 'luau').outcome).toBe('allow');
  });
});

describe('plans', () => {
  const base = { summary: 's' };
  const task = (key: string, dependsOn: string[] = []) => ({ key, title: key, kind: 'implement' as const, role: 'roblox-engineer', objective: 'o', acceptanceCriteria: ['c'], verification: [], dependsOn });
  it('orders tasks topologically', () => {
    const r = validatePlan({ ...base, tasks: [task('b', ['a']), task('a')] });
    expect(Array.isArray(r) && r.map((t) => t.key)).toEqual(['a', 'b']);
  });
  it('rejects cycles and unknown deps', () => {
    expect(validatePlan({ ...base, tasks: [task('a', ['b']), task('b', ['a'])] })).toMatch(/cycle/);
    expect(validatePlan({ ...base, tasks: [task('a', ['zzz'])] })).toMatch(/unknown/);
  });
  it('rejects plans that describe an order in prose but declare no dependencies', () => {
    const plan = { summary: 'Three waves: wave 2 needs the framework from t1.', tasks: [task('t1'), task('t2'), task('t3')] };
    expect(validatePlan(plan)).toMatch(/dependsOn/);
    const independent = { summary: 'Three independent polish items.', tasks: [task('t1'), task('t2'), task('t3')] };
    expect(Array.isArray(validatePlan(independent))).toBe(true);
  });
  it('rejects tasks that reference another task without depending on it', () => {
    const t2 = { ...task('t2'), objective: 'Build on the framework from t1.' };
    expect(validatePlan({ summary: 's', tasks: [task('t1'), t2] })).toMatch(/refers to "t1"/);
    expect(Array.isArray(validatePlan({ summary: 's', tasks: [task('t1'), { ...t2, dependsOn: ['t1'] }] }))).toBe(true);
  });
  it('always adds static analysis and critic to implementation tasks', () => {
    const v = normalizeVerification([{ kind: 'playtest', durationSec: 5 }], 'implement');
    expect(v.map((m) => m.kind)).toEqual(['static_analysis', 'playtest', 'critic']);
  });
});

describe('parsers', () => {
  it('seeds every bundled knowledge entry (invalid ones would be skipped silently)', () => {
    const global = new Store(':memory:', GLOBAL_MIGRATIONS);
    const k = new KnowledgeService(global, new EventBus());
    const entries = (JSON.parse(readFileSync(join(__dirname, '..', 'resources', 'knowledge', 'roblox-platform.json'), 'utf8')) as unknown[]).length;
    expect(seedKnowledge(k, join(__dirname, '..', 'resources'))).toBe(entries);
    expect(seedKnowledge(k, join(__dirname, '..', 'resources'))).toBe(0);
  });

  it('compacts a Studio tool schema for error hints', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { studio_id: { type: 'string' }, datamodel_type: { enum: ['Edit', 'Client'] }, actions: { type: 'array', items: { properties: { action: { type: 'string' } } } } },
      required: ['datamodel_type', 'actions'],
    };
    const text = compactSchema(schema);
    expect(text).not.toMatch(/\$schema|additionalProperties|"studio_id":\{/);
    expect(JSON.parse(text).properties.actions.items.properties.action.type).toBe('string');
    expect(compactSchema({ description: 'x'.repeat(5000) }, 100).length).toBe(101);
  });

  it('cleans Studio Luau errors and wraps code so errors carry their line', () => {
    const raw = `sabuiltin_Assistant.rbxm.Assistant.Packages._Index.AssistantUI.AssistantUI.Tools.ExecuteLuauTool:66: sabuiltin_Assistant.rbxm.Assistant.Packages._Index.AssistantUI.AssistantUI.Util.CommandExecution:54: attempt to index nil with 'b' (line 2)`;
    expect(cleanLuauError(raw)).toBe("attempt to index nil with 'b' (line 2)");
    const code = 'local x = 1\nreturn x';
    const wrapped = withErrorLines(code).split('\n');
    // The agent's code starts on line 2 unchanged (the handler subtracts 1), and its line count is known.
    expect(wrapped.slice(1, 3)).toEqual(['local x = 1', 'return x']);
    expect(wrapped[0]).toContain('__skLines = debug.info(1, "s"), 2;');
    expect(wrapped.at(-1)).toBe('return table.unpack(__sk, 2, __sk.n)');
  });

  it.skipIf(!existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene')))('finds the line of a Luau syntax error offline', async () => {
    const t = new LuauToolchain(tmpdir());
    const errs = await t.parseErrors('local x: number = 1\nx += 2\nlocal s = `v {x}`\nlocal y = (x +\nreturn y');
    expect(errs[0]).toMatchObject({ line: 4 });
    expect(await t.parseErrors('local t: { [string]: number } = {}\nfor _, v in t do if v > 1 then continue end end\nreturn t')).toEqual([]);
  });

  it.skipIf(!existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene')))('every Luau program Shuriken sends to Studio parses', async () => {
    const t = new LuauToolchain(tmpdir());
    const snippets = await import('../src/core/roblox/luau-snippets');
    const { mapAuditLuau } = await import('../src/core/roblox/map-audit');
    const { uiCaptureLuau } = await import('../src/core/roblox/ui-capture');
    const { animationCheckLuau, animationsBuilder, RUNTIME_MODULE } = await import('../src/core/animation/luau');
    const { effectsBuilder, FX_RUNTIME_MODULE, FX_CLIENT_SCRIPT } = await import('../src/core/effects/effects-service');
    const { buildEffect } = await import('../src/core/effects/presets');
    const { audioBuilder, AUDIO_RUNTIME_MODULE } = await import('../src/core/audio/audio-library');
    const { BLOOM_FN, PLACE_FN, SETTLE_FN, temporaryMeshLuau } = await import('../src/core/modeling/model-store');
    const { LUAU_LOG_ERRORS } = await import('../src/core/verification/verifier');
    const { rigsBuilder, stageMeshesLuau } = await import('../src/core/modeling/rig-builder');
    const { gearBuilder, R15_ATTACHMENTS } = await import('../src/core/modeling/gear');
    const { pushProgramSample, listScriptsLuau, fetchScriptsLuau } = await import('../src/core/roblox/code-sync');
    const { SURVEY_LUAU } = await import('../src/core/projects/game-study');
    const { readKeyframesLuau } = await import('../src/core/animation/import');
    const { surfaceLuau, mapUploadLuau, knownMapsLuau } = await import('../src/core/modeling/texture-staging');
    // A textured part's maps: a tiny PNG (RGBA 2×2) as its colour map, written by the exporter's own encoder shape.
    const texRoot = mkdtempSync(join(tmpdir(), 'shuriken-tex-'));
    mkdirSync(join(texRoot, 'models'), { recursive: true });
    const { encodePng } = await import('../src/core/modeling/png');
    const png2 = encodePng({ width: 2, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) });
    writeFileSync(join(texRoot, 'models', 'Crate__Wood.color.png'), png2);
    writeFileSync(join(texRoot, 'models', 'Crate__Wood.roughness.png'), png2);
    const texSurface = surfaceLuau(texRoot, { color: 'Crate__Wood.color.png', roughness: 'Crate__Wood.roughness.png' });
    const stalker = { version: 1, model: 'Stalker', root: 'Body', joints: [{ name: 'Body', parent: null, part: 'Body', pivot: [0, 2, 0] as [number, number, number], kind: 'ball' as const }, { name: 'Tail', parent: 'Body', part: 'Tail', pivot: [0, 2.2, 1.5] as [number, number, number], kind: 'hinge' as const }], legs: [], attachments: [{ name: 'Sting', part: 'Tail', position: [0, 3, 2.5] as [number, number, number] }] };
    const part = (name: string, segment: string) => ({ name, segment, size: [1, 1, 1] as [number, number, number], origin: [0, 2, 0] as [number, number, number], hash: 'h', triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], updatedAt: '', color: '#445566', material: 'Slate' });
    // Placeholders (__PATH__, __ROOTS__, …) are filled in at call time; nil keeps the syntax.
    const programs: Array<[string, string]> = Object.entries(snippets)
      .filter(([k, v]) => k.startsWith('LUAU_') && typeof v === 'string')
      .map(([k, v]) => [k, (v as string).replace(/__[A-Z_]+__/g, 'nil')]);
    programs.push(
      ['map audit', mapAuditLuau('Workspace.Map')],
      ['ui capture (edit)', uiCaptureLuau({})],
      ['ui capture (play)', uiCaptureLuau({ playerGui: true })],
      ['animation check', animationCheckLuau('Slash1', [{ name: 'Hit', t: 0.2 }])],
      ['animations builder', animationsBuilder([])],
      ['animation runtime', RUNTIME_MODULE],
      ['effects builder', effectsBuilder([buildEffect('HitSpark', 'HitSpark')])],
      ['effects runtime', FX_RUNTIME_MODULE],
      ['effects client', FX_CLIENT_SCRIPT],
      ['audio builder', audioBuilder([])],
      ['audio runtime', AUDIO_RUNTIME_MODULE],
      ['output errors', LUAU_LOG_ERRORS],
      ['rigs builder', rigsBuilder([{ rig: stalker, parts: [part('Stalker_Body', 'Body'), part('Stalker_Tail', 'Tail')], assets: { Stalker_Body: '101', Stalker_Tail: '102' } }])],
      ['rig clip builder', animationsBuilder([{ name: 'StalkerSting', rig: 'Stalker', loop: false, priority: 'Action', keys: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }, { t: 0.4, poses: { Tail: { rot: [-60, 0, 0], ease: 'Cubic', dir: 'In' }, Body: { pos: [0, -0.2, 0] } } }], markers: [{ t: 0.4, name: 'Hit' }] }], {}, { Stalker: stalker })],
      ['bloom', `${BLOOM_FN}
return tameBloom()`],
      [
        'gear builder',
        gearBuilder([
          { spec: { name: 'Sword', model: 'Sword', kind: 'tool', point: [0, 0.2, 0], into: 'ServerStorage.ShurikenGear' }, parts: [part('Sword_Blade', 'Handle'), { ...part('Sword_Glow', 'Handle'), material: 'Neon' }], assets: { Sword_Blade: '201', Sword_Glow: '202' } },
          { spec: { name: 'Buckler', model: 'Buckler', kind: 'accessory', attachTo: 'LeftGripAttachment', point: R15_ATTACHMENTS.LeftGripAttachment!.pos, into: 'ServerStorage.ShurikenGear' }, parts: [part('Buckler', 'Handle')], assets: { Buckler: '203' } },
        ]),
      ],
      ['place + settle', `local InsertService = game:GetService("InsertService")\n${PLACE_FN}\n${SETTLE_FN}\nlocal mp = place("Crate", 1, {1,1,1}, {name="Crate",parent="Workspace",pos={0,0,0},rot={0,0,0},scale=1})\nreturn game:GetService("HttpService"):JSONEncode(settle(mp, true))`],
      ['rigs builder (temporary meshes)', rigsBuilder([{ rig: stalker, parts: [part('Stalker_Body', 'Body'), part('Stalker_Tail', 'Tail')], assets: { Stalker_Body: '101' } }], { temporary: true })],
      ['stage temporary meshes', stageMeshesLuau('Stalker', [{ name: 'Stalker_Tail', v: [0, 0, 0, 1, 0, 0, 0, 1, 0], t: [0, 1, 2] }])],
      ['stage textured meshes', stageMeshesLuau('Stalker', [{ name: 'Stalker_Tail', v: [0, 0, 0, 1, 0, 0, 0, 1, 0], t: [0, 1, 2], uv: [0, 0, 1, 0, 0, 1], surface: texSurface }])],
      ['textured temporary mesh', temporaryMeshLuau('Crate', { v: [0, 0, 0, 1, 0, 0, 0, 1, 0], t: [0, 1, 2], uv: [0, 0, 1, 0, 0, 1] }, { name: 'Crate', parent: 'Workspace', position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 }, true, texSurface)],
      ...mapUploadLuau(texRoot, { kind: 'color', file: 'Crate__Wood.color.png', key: 'Crate__Wood.color.png#x' }).map((c, i): [string, string] => [`texture upload ${i}`, c]),
      ...mapUploadLuau(texRoot, { kind: 'roughness', file: 'Crate__Wood.roughness.png', key: 'Crate__Wood.roughness.png#x' }).map((c, i): [string, string] => [`gray texture upload ${i}`, c]),
      ['known textures', knownMapsLuau(['a#1', 'b#2'])],
      ['sync push', pushProgramSample()],
      ['script list', listScriptsLuau(['ServerScriptService', 'ReplicatedStorage/Shared'])],
      ['script fetch', fetchScriptsLuau([{ path: 'ServerScriptService/Main' }, { path: 'ReplicatedStorage/Big', part: 2, size: 40000 }])],
      ['place survey', SURVEY_LUAU],
      ['read keyframes (path)', readKeyframesLuau({ path: 'Workspace.Dummy.AnimSaves.Slash' })],
      ['read keyframes (asset)', readKeyframesLuau({ assetId: '507766666' })],
      ['temporary mesh', temporaryMeshLuau('Crate', { v: [0, 0, 0, 1, 0, 0, 0, 1, 0], t: [0, 1, 2] }, { name: 'Crate', parent: 'Workspace.Props', position: [0, 1, 0], rotation: [0, 90, 0], scale: 1, color: '#aa8844', material: 'Wood' }, 'wall')],
    );
    for (const [name, code] of programs) expect(await t.parseErrors(code), name).toEqual([]);
  }, 120_000);

  it('map_audit: findings for a bare blockout, none for a finished area (numbers measured in Studio)', () => {
    const lit = { style: 'Enum.LightingStyle.Realistic', clockTime: 13, atmosphere: 0.3, sky: true, colorCorrection: true, bloom: true, sunRays: true };
    // The scratch place's colosseum and a grey baseplate with three boxes, as the audit measured them.
    const arena: MapAudit = { area: 'Arena', parts: 3802, size: [239, 238], surface: { plainPlastic: 3, grey: 0, materials: [] }, ground: { samples: 144, void: 0, terrain: 53, materials: 8, heightSpread: 8.2, empty: 58, radius: 12 }, landmark: 98, giantFlatParts: [], lighting: lit };
    const bad: MapAudit = { area: 'AuditBad', parts: 4, size: [500, 500], surface: { plainPlastic: 100, grey: 100, greyPlastic: 100, materials: [] }, ground: { samples: 144, void: 0, terrain: 0, materials: 1, heightSpread: 0, empty: 100, radius: 12 }, landmark: 8, giantFlatParts: ['Workspace.AuditBad.Floor'], lighting: { ...lit, atmosphere: null, sky: false, colorCorrection: false, bloom: false } };
    expect(mapFindings(arena)).toEqual([]);
    const f = mapFindings(bad).join('\n');
    for (const w of ['blockout', 'grey plastic', 'grey', 'one material', 'flat', 'nothing within 12 studs', 'landmark', 'Giant flat parts', 'No Atmosphere', 'No Sky', 'post effects']) expect(f).toContain(w);
    // Area paths: "Workspace/Map.Arena" becomes the path Map/Arena, quoted for Luau.
    expect(mapAuditLuau('Workspace/Map.Arena', 10, 8)).toContain('local ROOT = "Map/Arena"');
    expect(mapAuditLuau('')).toContain('local ROOT = ""');
    expect(mapAuditLuau('A', 10, 8)).toMatch(/local GRID = 10\s+local RADIUS = 8/);
  });

  it('tells an explicit task reference from an ordinary word (planner dependsOn check)', () => {
    // Test 3's rejected objectives: places and features, not tasks.
    expect(explicitTaskReference('Place them away from the lobby (lobby is at the origin, ~160x160)', 'lobby')).toBe(false);
    expect(explicitTaskReference('3-2-1 FIGHT → combat (combo, block, hits with sparks/sounds) → round result', 'combat')).toBe(false);
    expect(explicitTaskReference('the three duel arenas are centred at (-160,0,-400)', 'arenas')).toBe(false);
    // Real references.
    expect(explicitTaskReference('RankedDataService.applyMatchResult from the elo task', 'elo')).toBe(true);
    expect(explicitTaskReference('after task lobby is done', 'lobby')).toBe(true);
    expect(explicitTaskReference('uses the pads from "lobby"', 'lobby')).toBe(true);
    expect(explicitTaskReference('Follow the map-quality-guidance section', 'map-quality-guidance')).toBe(true);
    expect(explicitTaskReference('see env-terrain-lighting-v2', 'env-terrain-lighting')).toBe(false);
  });

  it('caps a warning repeated in a loop and says how many were skipped', () => {
    const log = new Logger(null, null);
    for (let i = 0; i < 50; i++) log.write('warn', 'loop', 'same thing again');
    log.write('warn', 'other', 'something else');
    const recs = log.recent(100, 'warn');
    expect(recs.filter((r) => r.msg === 'same thing again')).toHaveLength(20);
    expect(recs.map((r) => r.msg)).toContain('previous message repeated 30 more times');
    expect(recs.at(-1)!.msg).toBe('something else');
  });

  it('parses SKILL.md frontmatter', () => {
    const { meta, body } = parseSkillFile('---\nname: roblox-networking\ndescription: "Remotes"\ntags: [net, remotes]\nversion: 2\nroblox_systems:\n  - RemoteEvent\n---\n# Body\ntext');
    expect(meta).toEqual({ name: 'roblox-networking', description: 'Remotes', tags: ['net', 'remotes'], version: 2, roblox_systems: ['RemoteEvent'] });
    expect(body).toBe('# Body\ntext');
  });

  it('parses Studio state text', () => {
    const s = parseState('- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit');
    expect(s.mode).toBe('Edit');
    expect(s.availableDataModels).toEqual(['Edit']);
    const p = parseState('- Current Studio Mode: Play\n- Available DataModels: Client, Server');
    expect(p.availableDataModels).toEqual(['Client', 'Server']);
  });

  it('diffs DataModel snapshots', () => {
    const d = diffSnapshots(
      { roots: [], count: 2, truncated: false, nodes: { 'Workspace.A#Part': { c: 'Part', p: [0, 0, 0] }, 'Workspace.B#Part': { c: 'Part' } } },
      { roots: [], count: 2, truncated: false, nodes: { 'Workspace.A#Part': { c: 'Part', p: [0, 5, 0] }, 'Workspace.C#Model': { c: 'Model' } } },
    );
    expect(d.added).toEqual(['Workspace.C#Model']);
    expect(d.removed).toEqual(['Workspace.B#Part']);
    expect(d.changed).toEqual([{ path: 'Workspace.A#Part', fields: ['p'] }]);
  });

  it('maps script file names to classes and hashes deterministically', () => {
    expect(classOfFile('Main.server.luau')).toBe('Script');
    expect(classOfFile('Input.client.luau')).toBe('LocalScript');
    expect(classOfFile('Input.local.luau')).toBe('LocalScript');
    expect(classOfFile('Util.luau')).toBe('ModuleScript');
    expect(classOfFile('README.md')).toBeNull();
    expect(luauFnv('abc')).toBe(luauFnv('abc'));
    expect(luauFnv('abc')).not.toBe(luauFnv('abd'));
  });

  it('summarizes health', () => {
    const c = (status: 'healthy' | 'unavailable' | 'needs_configuration') => ({ id: status, name: status, status, message: '', durationMs: 0 });
    expect(summarize([c('healthy'), c('healthy')])).toBe('healthy');
    expect(summarize([c('healthy'), c('unavailable')])).toBe('degraded');
    expect(summarize([c('unavailable')])).toBe('unavailable');
    expect(summarize([c('healthy'), c('needs_configuration')])).toBe('needs_configuration');
  });
});

describe('project identity', async () => {
  const { ProjectService } = await import('../src/core/projects/project-service');
  it('adopts an existing project folder without renaming it', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-adopt-'));
    const make = () => {
      const global = new Store(':memory:', GLOBAL_MIGRATIONS);
      return new ProjectService(global, new EventBus(), new KnowledgeService(global, new EventBus()));
    };
    const first = make().create({ name: 'Pit Tribes', rootPath: root });
    // Another data directory (e.g. a smoke run or a second machine) opens the same folder.
    const second = make().create({ name: 'Smoke project', rootPath: root });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Pit Tribes');
    const svc = make();
    svc.create({ name: 'Pit Tribes', rootPath: root, description: 'kept' });
    expect(svc.create({ name: 'Renamed?', rootPath: root }).description).toBe('kept');
  });
});

describe('playtest lease', async () => {
  const { PlaytestLease } = await import('../src/core/roblox/playtest-lease');
  it('grants play mode to one owner at a time and hands it over on release', async () => {
    const lease = new PlaytestLease();
    expect(lease.tryAcquire('run_a')).toBe(true);
    expect(lease.tryAcquire('run_a')).toBe(true);
    expect(lease.tryAcquire('run_b')).toBe(false);
    expect(lease.release('run_b')).toBe(false);
    const waiting = lease.acquire('verifier:t1', 5000);
    expect(lease.release('run_a')).toBe(true);
    expect(await waiting).toBe(true);
    expect(lease.isOwnedBy('verifier:t1')).toBe(true);
  });

  it('knows who waits and how long the holder has been idle, and stops waiting on abort', async () => {
    const lease = new PlaytestLease();
    expect(lease.idleMs()).toBe(0);
    lease.tryAcquire('run_a');
    const ctrl = new AbortController();
    const waiting = lease.acquire('run_b', 60_000, ctrl.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(lease.waiting).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(lease.idleMs()).toBeGreaterThanOrEqual(30);
    lease.touch('run_b'); // not the holder: no effect
    expect(lease.idleMs()).toBeGreaterThanOrEqual(30);
    lease.touch('run_a');
    expect(lease.idleMs()).toBeLessThan(30);
    ctrl.abort();
    expect(await waiting).toBe(false);
    expect(lease.waiting).toBe(0);
    expect(lease.isOwnedBy('run_a')).toBe(true);
  });

  it('spots agents sleeping inside Studio', async () => {
    const { longestSleep } = await import('../src/core/capabilities/app-tools');
    expect(longestSleep('task.wait(90) return os.date("%H:%M:%S")')).toBe(90);
    expect(longestSleep('wait(12.5)\ntask.delay(3, f)')).toBe(12.5);
    expect(longestSleep('local deadline = os.clock() + 15 while os.clock() < deadline do task.wait(0.25) end')).toBe(0.25);
    expect(longestSleep('local waitTime = 30 print(waitTime)')).toBe(0);
  });

  it('leaves a marker while held so a successor can detect an orphaned playtest', async () => {
    const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(mkdtempSync(join(tmpdir(), 'shuriken-lease-')), 'playtests');
    const own = join(dir, `${process.pid}.lease`);
    const lease = new PlaytestLease(dir);
    lease.studio = 'arena.rbxlx';
    expect(lease.takeOrphan()).toBeNull();
    lease.tryAcquire('verifier:t9');
    expect(existsSync(own)).toBe(true);
    expect(lease.takeOrphan()).toBeNull(); // our own marker is not an orphan
    lease.release('verifier:t9');
    expect(existsSync(own)).toBe(false);
    // Another window's core that is still running: its marker is left alone.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.ppid}.lease`), JSON.stringify({ owner: 'run_live', since: 1, pid: process.ppid }));
    // A process that died while holding the lease.
    writeFileSync(join(dir, '999999.lease'), JSON.stringify({ owner: 'run_dead', since: 1, pid: 999999, studio: 'arena.rbxlx' }));
    const next = new PlaytestLease(dir);
    expect(next.takeOrphan()).toMatchObject({ owner: 'run_dead', pid: 999999, studio: 'arena.rbxlx' });
    expect(existsSync(join(dir, '999999.lease'))).toBe(false);
    expect(next.takeOrphan()).toBeNull();
    expect(existsSync(join(dir, `${process.ppid}.lease`))).toBe(true);
  });
});

describe('provider accounts', async () => {
  const { AccountService } = await import('../src/core/accounts/account-service');
  const { UsageTracker } = await import('../src/core/orchestrator/usage-tracker');
  const setup = () => {
    const global = new Store(':memory:', GLOBAL_MIGRATIONS);
    const bus = new EventBus();
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-accts-'));
    return { accounts: new AccountService(global, dir, bus), usage: new UsageTracker(global, bus) };
  };
  it('does not read "no login" as signed in', async () => {
    const { hasClaudeLogin } = await import('../src/core/providers/claude/claude-provider');
    // What Claude Code 2.1 reports for a config folder with no login.
    expect(hasClaudeLogin({ tokenSource: 'none', apiProvider: 'firstParty' })).toBe(false);
    expect(hasClaudeLogin({ email: 'a@example.com', tokenSource: 'claude.ai', apiProvider: 'firstParty' })).toBe(true);
    expect(hasClaudeLogin({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toBe(true);
    expect(hasClaudeLogin({ tokenSource: 'none', apiProvider: 'bedrock' })).toBe(true);
  });
  it('uses the default login until an account is signed in', () => {
    const { accounts, usage } = setup();
    expect(accounts.pick('claude', usage)).toMatchObject({ ok: true, account: null, usageKey: 'claude' });
    const a = accounts.add('claude', 'Max 5x');
    expect(accounts.pick('claude', usage).account).toBeNull(); // not signed in yet
    accounts.update(a.id, { signedIn: true });
    expect(accounts.pick('claude', usage)).toMatchObject({ ok: true, usageKey: `claude:${a.id}` });
  });
  it('fails over to another account at a limit and reports when all are limited', () => {
    const { accounts, usage } = setup();
    accounts.setPolicy({ usePcLogin: false }); // only the added accounts in this test
    const five = accounts.add('claude', 'Max 5x');
    const twenty = accounts.add('claude', 'Max 20x');
    accounts.update(five.id, { signedIn: true });
    accounts.update(twenty.id, { signedIn: true });
    accounts.setActive('claude', five.id);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    usage.recordRateLimit(`claude:${five.id}`, { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: reset, raw: {} });
    const p1 = accounts.pick('claude', usage);
    expect(p1).toMatchObject({ ok: true, account: { id: twenty.id }, switchedFrom: { id: five.id } });
    expect(accounts.active('claude')!.id).toBe(twenty.id);
    usage.recordRateLimit(`claude:${twenty.id}`, { status: 'rejected', window: 'seven_day', utilization: 1, resetsAt: reset + 7200, raw: {} });
    const p2 = accounts.pick('claude', usage);
    expect(p2.ok).toBe(false);
    expect(p2.resumeAt).toBe(reset * 1000);
    // A reset after midnight names its day ("Sat 12:37 AM").
    expect(p2.reason).toMatch(/^Every account is at its usage limit; resuming at (?:[A-Z][a-z]{2} )?\d{1,2}:\d{2}/);
    // With auto-resume off nothing resumes at that time: it is said as the reset it is. Two builds stood paused for
    // hours behind "Paused: … resuming at 5:00 AM".
    accounts.setPolicy({ autoResume: false });
    expect(accounts.pick('claude', usage).reason).toMatch(/^Every account is at its usage limit; it resets at (?:[A-Z][a-z]{2} )?\d{1,2}:\d{2}/);
    accounts.setPolicy({ autoResume: true });
    accounts.setPolicy({ autoSwitch: false });
    usage.clearBlock(`claude:${twenty.id}`);
    accounts.setActive('claude', five.id);
    expect(accounts.pick('claude', usage).ok).toBe(false); // no switching when the policy says so
  });
  it("uses this PC's own Claude login as one more account, but never the same subscription twice", () => {
    const { accounts, usage } = setup();
    const five = accounts.add('claude', 'Max 5x');
    accounts.update(five.id, { signedIn: true, email: 'five@example.com' });
    accounts.update('pc', { signedIn: true, email: 'twenty@example.com' });
    const reset = Math.floor(Date.now() / 1000) + 3600;
    usage.recordRateLimit(`claude:${five.id}`, { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: reset, raw: {} });
    // The 5x is at its limit: work moves to the PC login (default credentials, plain usage key).
    expect(accounts.pick('claude', usage)).toMatchObject({ ok: true, account: { id: 'pc' }, usageKey: 'claude', switchedFrom: { id: five.id } });
    expect(accounts.active('claude')!.id).toBe('pc');
    // It can also be chosen by hand, and switching back works.
    accounts.setActive('claude', five.id);
    expect(accounts.active('claude')!.id).toBe(five.id);
    // Same email as an added account: the PC login is that subscription; it is not counted twice.
    accounts.update('pc', { email: 'FIVE@example.com' });
    expect(accounts.candidates('claude').map((a) => a.id)).toEqual([five.id]);
    expect(accounts.pick('claude', usage).ok).toBe(false);
  });
  it('lets each window choose its own account, apart from the default Settings sets, and moves on alone at a limit', () => {
    const { accounts, usage } = setup();
    accounts.setPolicy({ usePcLogin: false });
    const five = accounts.add('claude', 'Max 5x');
    const twenty = accounts.add('claude', 'Max 20x');
    const extra = accounts.add('claude', 'Pro');
    for (const a of [five, twenty, extra]) accounts.update(a.id, { signedIn: true });
    accounts.setActive('claude', five.id);
    // Two windows on one global store, each with its own choice (as the cores do through their projects' settings).
    const choices = { a: null as string | null, b: null as string | null };
    const second = new (accounts.constructor as typeof AccountService)((accounts as unknown as { global: Store }).global, mkdtempSync(join(tmpdir(), 'shuriken-accts-')), new EventBus());
    accounts.setScope({ get: () => choices.a, set: (_p, id) => (choices.a = id) });
    second.setScope({ get: () => choices.b, set: (_p, id) => (choices.b = id) });
    expect(accounts.active('claude')!.id).toBe(five.id);
    accounts.chooseForWindow('claude', twenty.id);
    expect(accounts.active('claude')!.id).toBe(twenty.id);
    expect(accounts.activeId('claude')).toBe(five.id); // the default is untouched
    expect(second.active('claude')!.id).toBe(five.id); // the other window still follows the default
    // Settings changes the default: a window with its own choice keeps it.
    accounts.setActive('claude', extra.id);
    expect(accounts.active('claude')!.id).toBe(twenty.id);
    expect(second.active('claude')!.id).toBe(extra.id);
    // At a limit this window moves on alone, writing nothing, and comes back when its account has room again.
    const reset = Math.floor(Date.now() / 1000) + 3600;
    usage.recordRateLimit(`claude:${twenty.id}`, { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: reset, raw: {} });
    const moved = accounts.pick('claude', usage);
    expect(moved).toMatchObject({ ok: true, switchedFrom: { id: twenty.id } });
    expect(moved.account!.id).not.toBe(twenty.id);
    expect(choices.a).toBe(twenty.id);
    expect(accounts.activeId('claude')).toBe(extra.id);
    expect(second.active('claude')!.id).toBe(extra.id);
    usage.clearBlock(`claude:${twenty.id}`);
    expect(accounts.pick('claude', usage).account!.id).toBe(twenty.id);
    // Back to the default: "Same as Settings".
    accounts.chooseForWindow('claude', null);
    expect(accounts.active('claude')!.id).toBe(extra.id);
    // A window's choice that no longer exists falls back to the default.
    choices.a = 'acct_gone';
    expect(accounts.active('claude')!.id).toBe(extra.id);
  });
  it('reads the reset time from a usage-limit message', async () => {
    const { resetFromMessage } = await import('../src/core/orchestrator/usage-tracker');
    const now = new Date(2026, 8, 28, 23, 6);
    const r = resetFromMessage("You've hit your session limit · resets 12:50am (Europe/London)", now)!;
    expect(new Date(r * 1000)).toEqual(new Date(2026, 8, 29, 0, 50));
    expect(new Date(resetFromMessage('resets 3pm', now)! * 1000)).toEqual(new Date(2026, 8, 29, 15, 0));
    expect(resetFromMessage('nothing here', now)).toBeNull();
  });
});

describe('project names from prompts', () => {
  it('keeps the name part of a prompt, short and title-cased', async () => {
    const { titleFromPrompt } = await import('../src/core/director/director');
    expect(titleFromPrompt('A sword-fighting arena: drop in from a sky lobby, pick a blade, last one standing wins.')).toBe('Sword-fighting Arena');
    expect(titleFromPrompt('make me a cozy fishing game where you catch rare fish and sell them')).toBe('Cozy Fishing Game');
    expect(titleFromPrompt('Tower defense with 5 towers and 20 waves')).toBe('Tower Defense');
    expect(titleFromPrompt('obby with lava and checkpoints')).toBe('Obby with Lava and Checkpoints');
    expect(titleFromPrompt('   ')).toBe('New game');
  });
});

describe('chat lines for sent-back work', () => {
  it('say why in plain words', async () => {
    const { sendBackLine } = await import('../src/core/director/director');
    expect(sendBackLine('Lobby', 'Critic rejected: The plaza reads as a blockout. Add props.')).toBe('Another pass for Lobby. The reviewer: The plaza reads as a blockout.');
    expect(sendBackLine('Combat', 'Verification failed: 2 check(s) failed: static analysis: src/X.luau:3: bad | hit lands: FAIL: no damage')).toBe('Another pass for Combat: its automated checks failed (static analysis, hit lands).');
    expect(sendBackLine('Swords', 'Agent run failed (execution): Claude Code returned an error result')).toBe('Another try for Swords: its run ended with an error.');
    expect(sendBackLine('Music', 'Could not reach the audio service')).toBe('Another pass for Music: Could not reach the audio service.');
  });
});

describe('director activity', () => {
  it('describes agent actions in plain words', async () => {
    const { describeCall } = await import('../src/core/director/activity');
    expect(describeCall('Edit', { file_path: String.raw`C:\game\src\Server\Combat.luau` })).toBe('editing Combat.luau');
    expect(describeCall('Write', { file_path: 'C:/game/world/Arena.luau' })).toBe('writing Arena.luau');
    expect(describeCall('mcp__shuriken__roblox_playtest', { action: 'start' })).toBe('playtesting');
    expect(describeCall('mcp__shuriken__roblox_call', { tool: 'insert_asset' })).toBe('inserting a Creator Store asset');
    expect(describeCall('mcp__shuriken__store_search', { queries: ['a'] })).toBe('searching the Creator Store');
    expect(describeCall('mcp__shuriken__some_new_tool', {})).toBe('some new tool');
  });
});

describe('PNG maps', () => {
  it('decodes what the exporter writes (every filter) and shrinks by whole pixels', async () => {
    const { decodePng, encodePng, shrinkImage } = await import('../src/core/modeling/png');
    const { deflateSync } = await import('node:zlib');
    const data = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 37) % 256);
    const img = { width: 4, height: 4, data };
    expect(decodePng(encodePng(img))).toEqual(img);
    // Rows with Sub, Up, Average and Paeth filters (an RGB image), as other tools write them.
    const rgb = [
      [10, 20, 30, 40, 50, 60],
      [11, 22, 33, 44, 55, 66],
      [200, 100, 50, 25, 12, 6],
      [1, 2, 3, 4, 5, 6],
    ];
    const filtered: number[] = [];
    const prev = (y: number, x: number) => (y > 0 ? rgb[y - 1]![x]! : 0);
    const left = (y: number, x: number) => (x >= 3 ? rgb[y]![x - 3]! : 0);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    rgb.forEach((row, y) => {
      const f = y + 1;
      filtered.push(f);
      row.forEach((v, x) => {
        const a = left(y, x);
        const b = prev(y, x);
        const c = y > 0 && x >= 3 ? rgb[y - 1]![x - 3]! : 0;
        const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        filtered.push((v - pred) & 255);
      });
    });
    const chunk = (kind: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(kind, 4, 'latin1');
      return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(filtered))), chunk('IEND', Buffer.alloc(0))]);
    const back = decodePng(file);
    expect([...back.data.subarray(4 * 5, 4 * 6)]).toEqual([...rgb[2]!.slice(3), 255]);
    expect([...back.data.subarray(4 * 7, 4 * 8)]).toEqual([...rgb[3]!.slice(3), 255]);
    // 4×4 → 2×2: each pixel the mean of its 2×2 block.
    const small = shrinkImage(img, 2);
    expect([small.width, small.height]).toEqual([2, 2]);
    expect(small.data[0]).toBe(Math.round((data[0]! + data[4]! + data[16]! + data[20]!) / 4));
  });
});
