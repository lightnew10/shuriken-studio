import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeSync, fileForScript, SyncBase } from '../src/core/roblox/code-sync';
import { luauFnv, type SyncMap } from '../src/core/roblox/luau-toolchain';
import { merge3 } from '../src/core/roblox/merge3';
import { adoptedSyncMap, CODE_SERVICES, pullScripts, scanCode } from '../src/core/projects/game-study';
import type { ProjectContext } from '../src/core/projects/project-service';
import { FakeStudio } from './helpers/fake-studio';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-sync-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body, 'utf8');
  }
  return root;
}

const MAP: SyncMap = { 'src/Server': 'ServerScriptService/Server', 'src/Shared': 'ReplicatedStorage/Shared' };
const MAIN = 'ServerScriptService/Server/Main';
const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `print("${tag} ${i + 1}")`).join('\n');

describe('merge3', () => {
  it('keeps both sides when they changed different lines', () => {
    const base = lines(10);
    const ours = base.replace('print("line 2")', 'print("ours 2")');
    const theirs = base.replace('print("line 9")', 'print("theirs 9")');
    const m = merge3(base, ours, theirs);
    expect(m.conflicts).toBe(0);
    expect(m.text).toContain('print("ours 2")');
    expect(m.text).toContain('print("theirs 9")');
    expect(m.text.split('\n')).toHaveLength(10);
  });

  it('takes one side when only it changed, and identical changes once', () => {
    const base = lines(5);
    const changed = `${base}\nprint("added")`;
    expect(merge3(base, base, changed)).toEqual({ text: changed, conflicts: 0 });
    expect(merge3(base, changed, base)).toEqual({ text: changed, conflicts: 0 });
    expect(merge3(base, changed, changed)).toEqual({ text: changed, conflicts: 0 });
  });

  it('marks a conflict when both changed the same line', () => {
    const base = lines(6);
    const m = merge3(base, base.replace('line 3', 'mine'), base.replace('line 3', 'studio'));
    expect(m.conflicts).toBe(1);
    expect(m.text).toMatch(/<<<<<<< yours[\s\S]*print\("mine"\)[\s\S]*\|\|\|\|\|\|\| last sync[\s\S]*print\("line 3"\)[\s\S]*=======\nprint\("studio"\)\n>>>>>>> Studio/);
    expect(m.text).toContain('print("line 1")');
    expect(m.text).toContain('print("line 6")');
  });

  it('merges insertions at both ends and deletions', () => {
    const base = lines(8);
    const ours = `-- header\n${base}`;
    const theirs = base.split('\n').filter((l) => !l.includes('line 5')).join('\n');
    const m = merge3(base, ours, theirs);
    expect(m.conflicts).toBe(0);
    expect(m.text.startsWith('-- header\nprint("line 1")')).toBe(true);
    expect(m.text).not.toContain('line 5');
  });
});

describe('fileForScript and adopted maps', () => {
  const map = adoptedSyncMap(['ServerScriptService', 'Workspace']);
  it('maps classes to Rojo names, scripts with children to init files', () => {
    expect(fileForScript({ path: 'ServerScriptService/Combat/Main', className: 'Script', length: 1, hash: 'x' }, map)).toEqual({ file: 'src/ServerScriptService/Combat/Main.server.luau' });
    expect(fileForScript({ path: 'StarterPlayer/StarterPlayerScripts/Input', className: 'LocalScript', length: 1, hash: 'x' }, map)).toEqual({ file: 'src/StarterPlayer/StarterPlayerScripts/Input.client.luau' });
    expect(fileForScript({ path: 'ReplicatedStorage/Lib', className: 'ModuleScript', children: true, length: 1, hash: 'x' }, map)).toEqual({ file: 'src/ReplicatedStorage/Lib/init.luau' });
    expect(fileForScript({ path: 'ServerScriptService/Door', className: 'Script', ambiguous: true, length: 1, hash: 'x' }, map)).toHaveProperty('why');
    expect(fileForScript({ path: 'Workspace/Lava:Kill', className: 'Script', length: 1, hash: 'x' }, map)).toHaveProperty('why');
    expect(fileForScript({ path: 'Workspace/init', className: 'Script', length: 1, hash: 'x' }, map)).toHaveProperty('why');
    expect(fileForScript({ path: 'Chat/ChatModules/X', className: 'ModuleScript', length: 1, hash: 'x' }, map)).toHaveProperty('why');
  });
  it('puts Shuriken’s own folder first and always maps where new code goes', () => {
    expect(Object.entries(map)[0]).toEqual(['src/ShurikenShared', 'ReplicatedStorage/ShurikenShared']);
    expect(Object.values(map)).toEqual(expect.arrayContaining(['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'Workspace']));
    expect(Object.values(map)).not.toContain('Lighting');
  });
});

// 2026-10-01: Roblox switched on FFlagAssistantCapsRestrictDataStore2 and Studio began running MCP code without
// four script capabilities. A script made in Luau can't be parented anywhere, so the first push of a new game
// failed for every file ("The current thread cannot reparent 'Motion' to 'ReplicatedStorage.Shared' since …").
describe('CodeSync when Studio refuses scripts made in Luau', () => {
  const files = { 'src/Server/Main.server.luau': lines(5), 'src/Shared/Lib.luau': 'return { v = 1 }\n', 'src/Shared/Kit/Deep/Leaf.luau': 'return "leaf"\n' };
  const LIB = 'ReplicatedStorage/Shared/Lib';
  const INPUT = 'ReplicatedStorage/Shared/Kit/Deep/Leaf';

  it("creates them through Studio's own script tool, writes their source as before, and reports them created", async () => {
    const root = project(files);
    const studio = new FakeStudio();
    studio.refusesNewScripts = true;
    const sync = new CodeSync(studio.asAdapter());
    const first = await sync.push(root, MAP);
    expect(first.errors).toEqual([]);
    expect(first.created.sort()).toEqual([LIB, MAIN, INPUT].sort());
    expect(first.updated).toEqual([]);
    expect(studio.madeByTool.sort()).toEqual([LIB, MAIN, INPUT].sort());
    expect(studio.scripts.get(MAIN)).toEqual({ className: 'Script', source: lines(5) });
    expect(studio.scripts.get(LIB)).toEqual({ className: 'ModuleScript', source: 'return { v = 1 }\n' });
    expect(studio.scripts.get(INPUT)).toEqual({ className: 'ModuleScript', source: 'return "leaf"\n' });
    expect(new SyncBase(root).hash(LIB)).toBe(luauFnv('return { v = 1 }\n'));
    // Again: nothing to do, nothing made. A changed file is written into the script that is there.
    const second = await sync.push(root, MAP);
    expect([second.created, second.updated, second.errors]).toEqual([[], [], []]);
    expect(second.unchanged).toHaveLength(3);
    writeFileSync(join(root, 'src/Shared/Lib.luau'), 'return { v = 2 }\n', 'utf8');
    const third = await sync.push(root, MAP);
    expect(third.updated).toEqual([LIB]);
    expect(third.errors).toEqual([]);
    expect(studio.madeByTool).toHaveLength(3);
    // A Studio edit still comes back into its file.
    studio.scripts.get(MAIN)!.source = lines(5).replace('line 3', 'edited in Studio');
    const fourth = await sync.push(root, MAP);
    expect(fourth.fromStudio).toEqual([MAIN]);
  });

  it('replaces an empty script of the wrong class, and leaves one with scripts inside it alone (with the reason)', async () => {
    const root = project({ 'src/Shared/Lib.luau': 'return 1\n', 'src/Shared/Kit.luau': 'return 2\n' });
    const studio = new FakeStudio();
    studio.scripts.set(LIB, { className: 'Script', source: 'print(1)' });
    studio.scripts.set('ReplicatedStorage/Shared/Kit', { className: 'Script', source: 'print(2)' });
    studio.scripts.set('ReplicatedStorage/Shared/Kit/Inner', { className: 'ModuleScript', source: 'return 3' });
    studio.refusesNewScripts = true;
    const r = await new CodeSync(studio.asAdapter()).push(root, MAP, { only: ['src/Shared/Lib.luau', 'src/Shared/Kit.luau'] });
    expect(studio.scripts.get(LIB)).toEqual({ className: 'ModuleScript', source: 'return 1\n' });
    expect(r.created).toEqual([LIB]);
    expect(studio.scripts.get('ReplicatedStorage/Shared/Kit')!.className).toBe('Script');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ path: 'ReplicatedStorage/Shared/Kit', error: expect.stringMatching(/cannot reparent .* Capabilities property/) });
  });

  it('costs nothing when Studio allows scripts: no tool call, no extra program', async () => {
    const root = project(files);
    const studio = new FakeStudio();
    const r = await new CodeSync(studio.asAdapter()).push(root, MAP, { only: Object.keys(files) });
    expect(r.created).toHaveLength(3);
    expect(studio.madeByTool).toEqual([]);
    expect(studio.calls).toBe(1);
  });
});

describe('CodeSync never overwrites Studio edits', () => {
  it('pushes, then pulls a Studio edit into an unchanged file instead of overwriting it', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(5) });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    const first = await sync.push(root, MAP);
    expect(first.created).toEqual([MAIN]);
    expect(studio.marker).toBeTruthy();
    expect(new SyncBase(root).hash(MAIN)).toBe(luauFnv(lines(5)));
    // The user edits the script in Studio; the file is untouched.
    studio.scripts.get(MAIN)!.source = lines(5).replace('line 3', 'edited in Studio');
    const second = await sync.push(root, MAP);
    expect(second.fromStudio).toEqual([MAIN]);
    expect(second.updated).toEqual([]);
    expect(readFileSync(join(root, 'src/Server/Main.server.luau'), 'utf8')).toContain('edited in Studio');
    expect(studio.scripts.get(MAIN)!.source).toContain('edited in Studio');
    const third = await sync.push(root, MAP);
    expect(third.unchanged).toEqual([MAIN]);
    expect(third.errors).toEqual([]);
  });

  it('merges a file change with a Studio change on other lines, and pushes the merge', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(12) });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    writeFileSync(join(root, 'src/Server/Main.server.luau'), lines(12).replace('line 2', 'agent change'), 'utf8');
    studio.scripts.get(MAIN)!.source = lines(12).replace('line 11', 'user change');
    const r = await sync.push(root, MAP);
    expect(r.merged).toEqual([MAIN]);
    expect(r.errors).toEqual([]);
    for (const text of [readFileSync(join(root, 'src/Server/Main.server.luau'), 'utf8'), studio.scripts.get(MAIN)!.source]) {
      expect(text).toContain('agent change');
      expect(text).toContain('user change');
    }
  });

  it('leaves conflict markers in the file, keeps Studio’s version, and refuses to push markers', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(6) });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    const file = join(root, 'src/Server/Main.server.luau');
    writeFileSync(file, lines(6).replace('line 4', 'agent'), 'utf8');
    studio.scripts.get(MAIN)!.source = lines(6).replace('line 4', 'user');
    const r = await sync.push(root, MAP);
    expect(r.conflicts).toEqual([MAIN]);
    expect(r.errors.map((e) => e.path)).toContain(MAIN);
    expect(readFileSync(file, 'utf8')).toMatch(/<<<<<<< yours[\s\S]*agent[\s\S]*=======[\s\S]*user[\s\S]*>>>>>>> Studio/);
    expect(studio.scripts.get(MAIN)!.source).toContain('"user"');
    const again = await sync.push(root, MAP);
    expect(again.errors[0]!.error).toMatch(/conflict markers/);
    expect(studio.scripts.get(MAIN)!.source).toContain('"user"');
    // Resolved by hand: both meant something, keep both.
    writeFileSync(file, lines(6).replace('print("line 4")', 'print("agent")\nprint("user")'), 'utf8');
    const done = await sync.push(root, MAP);
    expect(done.updated).toEqual([MAIN]);
    expect(done.errors).toEqual([]);
    expect(studio.scripts.get(MAIN)!.source).toContain('print("agent")\nprint("user")');
  });

  it('deletes the file of a script deleted in Studio (kept in the trash), and recreates one whose file changed', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(3), 'src/Server/Other.server.luau': lines(2, 'other') });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    studio.scripts.delete(MAIN);
    studio.scripts.delete('ServerScriptService/Server/Other');
    writeFileSync(join(root, 'src/Server/Other.server.luau'), lines(2, 'changed since'), 'utf8');
    const r = await sync.push(root, MAP);
    expect(r.removed).toEqual([MAIN]);
    expect(existsSync(join(root, 'src/Server/Main.server.luau'))).toBe(false);
    expect(existsSync(join(root, '.shuriken/sync/trash/src/Server/Main.server.luau'))).toBe(true);
    expect(studio.scripts.get('ServerScriptService/Server/Other')!.source).toContain('changed since');
    expect(r.errors.map((e) => e.error).join(' ')).toMatch(/Deleted in Studio since the last sync, but src\/Server\/Other.server.luau changed/);
  });

  it('overwrites stale scripts when the place was reopened from an older save, but not unknown edits', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(4, 'v1'), 'src/Server/B.server.luau': lines(2, 'b1') });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    writeFileSync(join(root, 'src/Server/Main.server.luau'), lines(4, 'v2'), 'utf8');
    await sync.push(root, MAP);
    writeFileSync(join(root, 'src/Server/Main.server.luau'), lines(4, 'v3'), 'utf8');
    // Studio reopens the place as saved back at v1 (an older mark, the old text), and someone edits B there.
    studio.marker = 'an-older-save';
    studio.scripts.get(MAIN)!.source = lines(4, 'v1');
    studio.scripts.get('ServerScriptService/Server/B')!.source = lines(2, 'edited after reopening');
    const r = await sync.push(root, MAP);
    expect(r.updated).toEqual([MAIN]);
    expect(studio.scripts.get(MAIN)!.source).toContain('v3');
    expect(r.fromStudio).toEqual(['ServerScriptService/Server/B']);
    expect(readFileSync(join(root, 'src/Server/B.server.luau'), 'utf8')).toContain('edited after reopening');
  });

  // Two Studio windows had one build's place open; the one that stayed was the older copy. Agents sync their own
  // files only: the first sync set the mark, the next ones took the old scripts for edits made in Studio, wrote
  // them over newer files (eight files in five minutes) and trashed new files as "deleted in Studio".
  it('after a reopen from an older save, scripts no sync has confirmed yet stay stale for the syncs that follow', async () => {
    const A = 'ServerScriptService/Server/A';
    const B = 'ServerScriptService/Server/B';
    const C = 'ServerScriptService/Server/C';
    const root = project({ 'src/Server/A.server.luau': lines(3, 'a1'), 'src/Server/B.server.luau': lines(3, 'b1') });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    const old = { marker: studio.marker, a: studio.scripts.get(A)!.source, b: studio.scripts.get(B)!.source };
    // The team goes on: A and B change, C is new, all synced.
    writeFileSync(join(root, 'src/Server/A.server.luau'), lines(3, 'a2'), 'utf8');
    writeFileSync(join(root, 'src/Server/B.server.luau'), lines(3, 'b2'), 'utf8');
    writeFileSync(join(root, 'src/Server/C.server.luau'), lines(3, 'c1'), 'utf8');
    await sync.push(root, MAP);
    // Studio is back as it was saved before that: the old mark, the old A and B, no C.
    studio.marker = old.marker;
    studio.scripts.get(A)!.source = old.a;
    studio.scripts.get(B)!.source = old.b;
    studio.scripts.delete(C);
    // One agent syncs its own file; the others' files are left out, as they are while their agents work.
    const first = await sync.push(root, MAP, { skip: ['src/Server/B.server.luau', 'src/Server/C.server.luau'] });
    expect(first.updated).toEqual([A]);
    expect(new SyncBase(root).isSuspect(B)).toBe(true);
    expect(new SyncBase(root).isSuspect(A)).toBe(false);
    // The next sync meets the mark the first one left, and the old B, and no C: the files win; nothing is pulled or trashed.
    const second = await sync.push(root, MAP);
    expect(second.fromStudio).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.updated).toEqual([B]);
    expect(second.created).toEqual([C]);
    expect(readFileSync(join(root, 'src/Server/B.server.luau'), 'utf8')).toContain('b2');
    expect(existsSync(join(root, 'src/Server/C.server.luau'))).toBe(true);
    expect(studio.scripts.get(B)!.source).toContain('b2');
    expect(studio.scripts.get(C)!.source).toContain('c1');
    expect(new SyncBase(root).isSuspect(B)).toBe(false);
    // From here on a change made in Studio is a change made in Studio again.
    studio.scripts.get(B)!.source = lines(3, 'edited in Studio');
    expect((await sync.push(root, MAP)).fromStudio).toEqual([B]);
  });

  it('pulls nothing when Studio’s scripts look like another game', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`src/Server/S${i}.server.luau`] = lines(3, `s${i}`);
    const root = project(files);
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    studio.marker = 'someone-else';
    for (const s of studio.scripts.values()) s.source = 'print("a different game")';
    const r = await sync.push(root, MAP);
    expect(r.errors.map((e) => e.error).join(' ')).toMatch(/is the right place open/);
    expect(r.fromStudio).toEqual([]);
    expect(readFileSync(join(root, 'src/Server/S0.server.luau'), 'utf8')).toContain('s0');
  });

  it('gives new Studio scripts files, but leaves orphans from before tracking alone', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(2) });
    const studio = new FakeStudio();
    studio.scripts.set('ServerScriptService/Server/Legacy', { className: 'Script', source: 'print("old")' });
    const sync = new CodeSync(studio.asAdapter());
    const first = await sync.push(root, MAP);
    expect(first.orphans).toEqual(['ServerScriptService/Server/Legacy']);
    studio.scripts.set('ReplicatedStorage/Shared/Made', { className: 'ModuleScript', source: 'return {}' });
    studio.scripts.set('ServerScriptService/Server/Tool', { className: 'LocalScript', source: 'print("tool")' });
    const second = await sync.push(root, MAP);
    expect(second.added.sort()).toEqual(['ReplicatedStorage/Shared/Made', 'ServerScriptService/Server/Tool']);
    expect(second.orphans).toEqual(['ServerScriptService/Server/Legacy']);
    expect(readFileSync(join(root, 'src/Shared/Made.luau'), 'utf8')).toBe('return {}');
    expect(readFileSync(join(root, 'src/Server/Tool.client.luau'), 'utf8')).toBe('print("tool")');
    const third = await sync.push(root, MAP);
    expect(third.unchanged.sort()).toEqual([MAIN, 'ReplicatedStorage/Shared/Made', 'ServerScriptService/Server/Tool'].sort());
    expect(third.added).toEqual([]);
  });

  it('handles a source whose last character is a closing bracket', async () => {
    const root = project({ 'src/Server/Main.server.luau': 'local t = {1}\nreturn t[1]' });
    const studio = new FakeStudio();
    await new CodeSync(studio.asAdapter()).push(root, MAP);
    expect(studio.scripts.get(MAIN)!.source).toBe('local t = {1}\nreturn t[1]');
  });
});

describe('plugging in a game', () => {
  it('pulls every script into files, skips ambiguous ones, and marks the base', async () => {
    const root = project({});
    const studio = new FakeStudio();
    studio.scripts.set('ServerScriptService/Main', { className: 'Script', source: 'require(game.ReplicatedStorage.Lib).start()' });
    studio.scripts.set('ReplicatedStorage/Lib', { className: 'ModuleScript', source: 'return { start = function() end }' });
    studio.scripts.set('ReplicatedStorage/Lib/Util', { className: 'ModuleScript', source: 'return {}' });
    studio.scripts.set('StarterPlayer/StarterPlayerScripts/Input', { className: 'LocalScript', source: 'print("input")' });
    studio.scripts.set('Workspace/Lava/Kill', { className: 'Script', source: 'require(123456789)' });
    // Two parts named Door, each with a script: those can't be told apart by path.
    studio.scripts.set('Workspace/Door/Open', { className: 'Script', source: 'print(1)' });
    studio.others.add('Workspace/door');
    const ctx = { root, summary: { name: 'Test game' } } as unknown as ProjectContext;
    const pull = await pullScripts(ctx, studio.asAdapter());
    expect(pull.pulled.sort()).toEqual(['src/ReplicatedStorage/Lib/Util.luau', 'src/ReplicatedStorage/Lib/init.luau', 'src/ServerScriptService/Main.server.luau', 'src/StarterPlayer/StarterPlayerScripts/Input.client.luau', 'src/Workspace/Lava/Kill.server.luau'].sort());
    expect(pull.skipped.map((s) => s.path)).toEqual(['Workspace/Door/Open']);
    expect(Object.values(pull.syncMap)).toEqual(expect.arrayContaining(['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer', 'Workspace']));
    const base = new SyncBase(root);
    expect(base.marker).toBe(studio.marker);
    expect(base.unmapped()).toEqual(['Workspace/Door/Open']);
    // The first push changes nothing and reports no orphans (the skipped script is the game's own).
    const r = await new CodeSync(studio.asAdapter()).push(root, pull.syncMap);
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.errors).toEqual([]);
    const scan = scanCode(root, pull.syncMap);
    expect(scan.files).toBe(5);
    expect(scan.flags.map((f) => f.kind)).toEqual(['remote require']);
    expect(CODE_SERVICES).toContain('Workspace');
  });
});

describe('the Luau sourcemap for a plugged-in game', () => {
  it('merges a service mapped whole with Shuriken’s folder inside it', async () => {
    const { LuauToolchain } = await import('../src/core/roblox/luau-toolchain');
    const root = project({
      'src/ShurikenShared/ShurikenAnimations.luau': 'return {}',
      'src/ReplicatedStorage/Lib/init.luau': 'return {}',
      'src/ReplicatedStorage/Lib/Util.luau': 'return {}',
      'src/ServerScriptService/Main.server.luau': 'print(1)',
    });
    const out = new LuauToolchain(root).writeSourcemap(root, adoptedSyncMap(['ReplicatedStorage', 'ServerScriptService']));
    const game = JSON.parse(readFileSync(out, 'utf8')) as { children: Array<{ name: string; className: string; children?: Array<{ name: string; className: string; children?: Array<{ name: string }> }> }> };
    const rs = game.children.filter((c) => c.name === 'ReplicatedStorage');
    expect(rs).toHaveLength(1);
    expect(rs[0]!.className).toBe('ReplicatedStorage');
    expect(rs[0]!.children!.map((c) => c.name).sort()).toEqual(['Lib', 'ShurikenShared']);
    expect(rs[0]!.children!.find((c) => c.name === 'Lib')).toMatchObject({ className: 'ModuleScript', children: [{ name: 'Util' }] });
    expect(game.children.find((c) => c.name === 'ServerScriptService')!.className).toBe('ServerScriptService');
  });
});

describe('syncing while other agents work', () => {
  it('leaves files another agent is editing out of the push (not pushed half-done, not merged into)', async () => {
    const root = project({ 'src/Server/Main.server.luau': lines(3), 'src/Server/Busy.server.luau': lines(2, 'busy') });
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    writeFileSync(join(root, 'src/Server/Busy.server.luau'), lines(2, 'half-done'), 'utf8');
    studio.scripts.get('ServerScriptService/Server/Busy')!.source = lines(2, 'edited in Studio');
    const r = await sync.push(root, MAP, { skip: ['src/Server/Busy.server.luau'] });
    expect(r.skipped).toEqual(['src/Server/Busy.server.luau']);
    expect(r.orphans).toEqual([]);
    expect(r.merged).toEqual([]);
    expect(readFileSync(join(root, 'src/Server/Busy.server.luau'), 'utf8')).toContain('half-done');
    expect(studio.scripts.get('ServerScriptService/Server/Busy')!.source).toContain('edited in Studio');
    // The agent's own sync (nothing skipped) then reconciles it.
    const own = await sync.push(root, MAP);
    expect(own.conflicts.length + own.merged.length).toBe(1);
  });
});

describe('forcing the files in', () => {
  it('puts the files’ versions in when the place is right but unrecognisable', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`src/Server/S${i}.server.luau`] = lines(2, `s${i}`);
    const root = project(files);
    const studio = new FakeStudio();
    const sync = new CodeSync(studio.asAdapter());
    await sync.push(root, MAP);
    studio.marker = 'a-very-old-save';
    for (const s of studio.scripts.values()) s.source = 'print("ancient")';
    expect((await sync.push(root, MAP)).errors[0]!.error).toMatch(/force: true/);
    const r = await sync.push(root, MAP, { force: true });
    expect(r.updated).toHaveLength(5);
    expect(r.fromStudio).toEqual([]);
    expect(studio.scripts.get('ServerScriptService/Server/S0')!.source).toContain('s0');
    expect((await sync.push(root, MAP)).unchanged).toHaveLength(5);
  });
});

// Studio froze for half a minute in a build and the plugin's link dropped under a push: all eleven scripts of it
// were reported as errors ("Studio stopped answering through Shuriken Link"); the link was back eight seconds later.
describe('a push whose batch meets a dropped plugin link', () => {
  it('sends the batch once more when the link is back, and reports no error', async () => {
    const studio = new FakeStudio();
    const root = mkdtempSync(join(tmpdir(), 'shuriken-sync-back-'));
    mkdirSync(join(root, 'src/Server'), { recursive: true });
    writeFileSync(join(root, 'src/Server/Combat.server.luau'), 'print("combat")' + String.fromCharCode(10));
    studio.linkDrops = 1;
    const r = await new CodeSync(studio.asAdapter()).push(root, { 'src/Server': 'ServerScriptService/Server' });
    expect(r.errors).toEqual([]);
    expect(r.created).toEqual(['ServerScriptService/Server/Combat']);
    expect(studio.linkWaits).toBe(1);
  });

  it('reports the scripts when the link stays away', async () => {
    const studio = new FakeStudio();
    const root = mkdtempSync(join(tmpdir(), 'shuriken-sync-back-'));
    mkdirSync(join(root, 'src/Server'), { recursive: true });
    writeFileSync(join(root, 'src/Server/Combat.server.luau'), 'print("combat")' + String.fromCharCode(10));
    studio.linkDrops = 5;
    studio.linkReturns = false;
    const r = await new CodeSync(studio.asAdapter()).push(root, { 'src/Server': 'ServerScriptService/Server' });
    expect(r.errors.some((e) => /stopped answering through Shuriken Link/.test(e.error))).toBe(true);
  });
});
