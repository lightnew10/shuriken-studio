import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { LUAURC, SELENE_TOML } from '../src/core/projects/project-service';
import { parseManifest, type Mat4, type Vec3 } from '../src/core/modeling/kiln-manifest';
import { batchUnits, mulV, planLayout, rotationYXZ, toRoblox, type LayoutPart, type LayoutPlan } from '../src/core/modeling/kiln-layout';
import { MARKER_TAG, kitLuau, kitTemporaryLuau, mapDataModule, mapModuleName, markerTag, markersLuau, sweepLuau, unitChars, unitsLuau } from '../src/core/modeling/kiln-layout-luau';

// The Luau a map import runs in Studio, and the data module game code requires. What can be checked without Studio:
// every program parses (selene, as the other generated builders are checked), the data module passes the project's
// own selene + strict luau-lsp checks, the rows carry exactly the numbers of the plan in the layout the Luau reads
// them in, and a map of 1,400 placements stays within what one execute_luau call can take.

const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const SELENE = existsSync(bin('selene'));
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const STRICT = SELENE && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));
const parses = async (code: string) => expect(await new LuauToolchain(tmpdir()).parseErrors(code)).toEqual([]);

const FIXTURE = resolve(__dirname, 'fixtures', 'kiln-layout-reference');
const { manifest } = parseManifest(JSON.parse(readFileSync(join(FIXTURE, 'roblox.json'), 'utf8')), FIXTURE);
const box = (name: string, lo: Vec3, hi: Vec3, over: Partial<LayoutPart> = {}): LayoutPart => ({ name, origin: toRoblox([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]), size: [hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]], hash: `h-${name}`, asset: '1000', legacy: false, ...over });
const reference = (): LayoutPlan =>
  planLayout({
    map: 'Reference',
    manifest: { ...manifest, placements: manifest.placements.map((p) => (p.name === 'Arrow_Plain_001' ? { ...p, role: 'decor' } : p)) },
    own: [
      { name: 'Reference_Ground', origin: [0, -0.5, 0], size: [60, 1, 40], role: 'drivable', color: '#55585c', material: 'Asphalt', hash: 'g', asset: '11', legacy: false },
      { name: 'Reference_Wall', origin: [0, 1.5, 20.5], size: [60, 3, 1], role: 'barrier', box: true, color: '#b0b0b0', material: 'SmoothPlastic', hash: 'w', asset: '12', legacy: true, instances: [{ position: [0, 1.5, 20.5], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [0, 1.5, -20.5], rotation: [0, 0, 0], scale: [1, 1, 1] }] },
    ],
    pieces: {
      Arrow: { model: 'Arrow', studsPerUnit: 1, parts: [box('Arrow_Shaft', [0, -0.25, 0], [3, 0.25, 0.5], { asset: '21', color: '#d04020' }), box('Arrow_Fin', [0, 0.25, 0], [0.5, 1.25, 0.5], { asset: '22' }), box('Arrow_Post', [0, -0.25, 0.5], [0.5, 0.25, 2], { asset: '23' })] },
      Pillar: { model: 'Pillar', studsPerUnit: 1, parts: [box('Pillar_Body', [-0.5, -0.5, 0], [0.5, 0.5, 4], { asset: '31' }), box('Pillar_Step', [-0.5, -1.5, 0], [0.5, -0.5, 1], { asset: '32' })] },
      Slab: { model: 'Slab', studsPerUnit: 1, parts: [box('Slab', [0, 0, 0], [4, 2, 0.5], { asset: '41' })] },
    },
  });

/** The rows of a generated `local NAME = { ... }` table: Luau's flat arrays of strings and numbers are JSON arrays with other brackets. */
function rowsOf(code: string, table: string): Array<Array<string | number>> {
  const start = code.indexOf(`local ${table} = {\n`);
  const end = code.indexOf('\n}\n', start);
  const body = code.slice(start + `local ${table} = {\n`.length, end);
  return body.split('\n').filter(Boolean).map((line) => JSON.parse(`[${line.replace(/,$/, '').slice(1, -1)}]`) as Array<string | number>);
}
const listOf = (code: string, name: string): string[] => JSON.parse(`[${/local (\w+) = \{(.*)\}/.exec(code.split('\n').find((l) => l.startsWith(`local ${name} = {`))!)![2]}]`) as string[];

describe('the kit: one template per unique mesh', () => {
  const plan = reference();

  it('loads each asset once, sets its look and traits, and keeps a template whose stamp is unchanged', async () => {
    const code = kitLuau('Reference', plan.templates);
    await parses(code);
    expect(code.match(/InsertService:LoadAsset\(/g)).toHaveLength(1); // in the loop, once per row
    expect(code).toContain('local kit = folderIn(folderIn(ServerStorage, "ShurikenMapKit"), "Reference")');
    expect(code).toContain('if old and old:GetAttribute("ShurikenStamp") == r[3] then');
    const ground = plan.templates.find((t) => t.name === 'Reference_Ground')!;
    // Roblox's own material and the colour, no texture: Material + Color on the part
    expect(code).toContain(`{"Reference_Ground",11,"${ground.stamp}",{60,1,40},"#55585c","Asphalt",{cc=true,cq=true,fid="PreciseConvexDecomposition"},false}`);
    // a legacy upload's template is marked, so its clones are turned back
    expect(code).toMatch(/\{"Reference_Wall",12,"\w+",\{60,3,1\},"#b0b0b0","SmoothPlastic",\{cc=true,cq=true,fid="Box"\},true\}/);
    expect(code).toContain('if r[8] then mesh:SetAttribute("ShurikenTurned", true) end');
    // a part without a look or traits
    expect(code).toMatch(/\{"Slab",41,"\w+",\{4,0\.5,2\},nil,nil,nil,false\}/);
    expect(code).toContain('mesh:SetAttribute("ShurikenModel", r[1])'); // the Studio viewer draws the clones from the project's mesh
    expect(code).toContain('return HttpService:JSONEncode({ made = made, kept = kept, failed = failed, failures = failures })');
  });

  it('temporary meshes: the same rows with the mesh to build (EditableMesh), marked temporary', async () => {
    const t = plan.templates.find((x) => x.name === 'Slab')!;
    const code = kitTemporaryLuau('Reference', [{ template: { ...t, asset: null }, mesh: { v: [0, 0, 0, 1, 0, 0, 0, 0, 1], t: [0, 1, 2], n: [0, 1, 0, 0, 1, 0, 0, 1, 0] } }]);
    await parses(code);
    expect(code).toContain('AssetService:CreateMeshPartAsync(Content.fromObject(em))');
    expect(code).toContain('mesh:SetAttribute("ShurikenTemporaryMesh", true)');
    expect(code).toMatch(/\{\{"Slab",nil,"\w+",\{4,0\.5,2\},nil,nil,nil,false\},\{0,0,0,1,0,0,0,0,1\},\{0,1,2\},\{0,1,0,0,1,0,0,1,0\}\}/);
    expect(code).not.toContain('InsertService');
  });
});

describe('units: placements as clones', () => {
  const plan = reference();
  const code = unitsLuau(plan, 'run1', plan.units);

  it('parses, and is resumable: an unchanged unit is kept (and stamped with the run), a changed one replaced', async () => {
    await parses(code);
    expect(code).toContain('local MAP, RUN = "Reference", "run1"');
    expect(code).toContain('if old and old:GetAttribute("ShurikenFp") == u[2] then\n    old:SetAttribute("ShurikenRun", RUN)\n    kept += 1');
    expect(code).toContain('if old then old:Destroy() end\n      made.Parent = folder');
    expect(code).toContain('made:SetAttribute("ShurikenFp", u[2])');
    // a clone's Size is the template's times the scale; a legacy template's clone is turned back about its centre
    expect(code).toContain('mp.Size = Vector3.new(t.Size.X * u[i + 7], t.Size.Y * u[i + 8], t.Size.Z * u[i + 9])');
    expect(code).toContain('if t:GetAttribute("ShurikenTurned") then cf = cf * HALF end');
    expect(code).toContain('local HALF = CFrame.Angles(0, math.pi, 0)');
    // a piece of several parts is a Model that streams in whole; its pivot is the placement
    expect(code).toContain('made.ModelStreamingMode = Enum.ModelStreamingMode.Atomic');
    expect(code).toContain('made.WorldPivot = pivot');
    expect(code).toContain('mp.PivotOffset = cf:ToObjectSpace(pivot)');
    // a short answer, whatever the size of the batch
    expect(code).toContain('if #failures < 12 then table.insert(failures, u[1] .. ": " .. string.sub(tostring(err), 1, 160)) end');
    expect(code.trimEnd().endsWith('return HttpService:JSONEncode({ placed = placed, kept = kept, replaced = replaced, failed = failed, failures = failures })')).toBe(true);
  });

  it('the rows hold the plan in the layout the Luau reads: 4 strings, a pivot of 6, then 11 numbers a part', () => {
    const T = listOf(code, 'T');
    const rows = rowsOf(code, 'U');
    expect(rows).toHaveLength(plan.units.length);
    const FX = /local FX = \{(.*)\}/.exec(code)![1]!;
    expect(FX).toBe('{cc=false,cq=false,ct=false,sh=false}'); // the one override: Arrow_Plain_001 is tagged decor
    for (const [k, u] of rows.entries()) {
      const unit = plan.units[k]!;
      expect(u.slice(0, 4)).toEqual([unit.name, unit.fp, unit.group, unit.cell]);
      expect(u.slice(4, 10)).toEqual([...unit.pivot.p, ...unit.pivot.r]);
      // what the Luau computes: count = (#u - 10) // 11, part k at i = 11 + (k - 1) * 11 (1-based)
      expect((u.length - 10) % 11).toBe(0);
      expect((u.length - 10) / 11).toBe(unit.uses.length);
      unit.uses.forEach((use, j) => {
        const i = 10 + j * 11; // 0-based here
        expect(T[(u[i] as number) - 1]).toBe(plan.templates[use.t]!.name);
        expect(u.slice(i + 1, i + 4)).toEqual(use.p);
        expect(u.slice(i + 4, i + 7)).toEqual(use.r);
        expect(u.slice(i + 7, i + 10)).toEqual(use.s);
        expect(u[i + 10]).toBe(use.fx ? 1 : 0);
      });
    }
    const decor = rows.find((r) => r[0] === 'Arrow_Plain_001')!;
    expect([decor[20], decor[31], decor[42]]).toEqual([1, 1, 1]);
    // the numbers are what Studio places: a row's CFrame and Size put the fin's far corner where Kiln's matrix does
    const row = rows.find((r) => r[0] === 'Arrow_Turn90_001')!;
    const at = [10, 21, 32].find((i) => T[(row[i] as number) - 1] === 'Arrow_Fin')!;
    const [p, r, s] = [row.slice(at + 1, at + 4), row.slice(at + 4, at + 7), row.slice(at + 7, at + 10)] as number[][];
    const fin = box('Arrow_Fin', [0, 0.25, 0], [0.5, 1.25, 0.5]);
    const corner = toRoblox([0.5, 1.25, 0.5]).map((v, i) => (v - fin.origin[i]!) * s![i]!);
    const w = mulV(rotationYXZ(r!), corner).map((v, i) => v + p![i]!);
    const M = manifest.placements.find((x) => x.name === 'Arrow_Turn90_001')!.matrix as Mat4;
    const truth = toRoblox([0, 1, 2].map((i) => M[i]![0] * 0.5 + M[i]![1] * 1.25 + M[i]![2] * 0.5 + M[i]![3]));
    for (let i = 0; i < 3; i++) expect(w[i]).toBeCloseTo(truth[i]!, 3);
  });

  it('a batch names only the templates it uses', () => {
    const slabs = plan.units.filter((u) => u.name.startsWith('Slab_'));
    const part = unitsLuau(plan, 'run2', slabs);
    expect(listOf(part, 'T')).toEqual(['Slab']);
    expect(part).toContain('local FX = {}');
    expect(rowsOf(part, 'U').every((r) => r[10] === 1)).toBe(true);
  });

  it('the sweep removes what this run did not see and the templates the map no longer uses', async () => {
    const code2 = sweepLuau('Reference', 'run1', plan.templates.map((t) => t.name));
    await parses(code2);
    expect(code2).toContain('if c:GetAttribute("ShurikenRun") ~= RUN then');
    expect(code2).toContain('["Slab"]=true');
    expect(code2).toContain('for _, group in { "Static", "Pieces" } do');
    expect(code2).toContain('if #c:GetChildren() == 0 then c:Destroy() end');
    expect(code2).toContain('return HttpService:JSONEncode({ removed = removed, templates = templates })');
  });
});

describe('markers and the data module', () => {
  const plan = reference();

  it('markers are invisible, anchored, tagged parts in a Model that is always streamed in', async () => {
    const code = markersLuau('Reference', plan.markers);
    await parses(code);
    const m = plan.markers[0]!;
    expect(code).toContain(`  {"Spawn_A","spawn",${[...m.p, ...m.r].join(',')}}`);
    for (const line of ['p.Anchored = true', 'p.Transparency = 1', 'p.CanCollide = false', 'p.CanQuery = false', 'p.CanTouch = false', 'p:SetAttribute("Role", m[2])', `CollectionService:AddTag(p, "${MARKER_TAG}")`, 'holder.ModelStreamingMode = Enum.ModelStreamingMode.Persistent', 'if old then old:Destroy() end']) expect(code).toContain(line);
    expect(markerTag('start_grid')).toBe('MapMarker_start_grid');
    expect(markerTag('pit lane')).toBe('MapMarker_pit_lane');
    // no markers is still a program (it clears what an earlier import placed)
    await parses(markersLuau('Reference', []));
  });

  it('the data module carries paths in studs (points, width, closed, length) and markers as CFrames', () => {
    const code = mapDataModule('Reference', plan.paths, plan.markers, { studsPerUnit: 1, root: 'Workspace.Reference' });
    expect(code.startsWith('--!strict\n')).toBe(true);
    // Blender (-25, -18, 0) is Roblox (25, 0, -18)
    expect(code).toContain('{ name = "Center_Line", role = "road_centerline", width = 8, closed = false, length = 71.2488, points = points({ 25, 0, -18, 0, 0, -18, -25, 0, -10, -25, 0, 10 }) },');
    const m = plan.markers[0]!;
    expect(code).toContain(`{ name = "Spawn_A", role = "spawn", cframe = at(${[...m.p, ...m.r].join(', ')}) },`);
    expect(code).toContain('function Map.path(role: string): MapPath?');
    expect(code).toContain('function Map.markersOf(role: string): { MapMarker }');
    expect(mapModuleName('Japanese Mountain Drift Circuit')).toBe('JapaneseMountainDriftCircuit');
    expect(mapModuleName('9 Lives')).toBe('Map9Lives');
  });

  it.skipIf(!STRICT)('the data module passes selene and strict luau-lsp in a project, with paths, without, and when required', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-map-lint-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    for (const d of ['Shared/ShurikenMaps', 'Client', 'Server']) mkdirSync(join(root, 'src', d), { recursive: true });
    writeFileSync(join(root, 'src/Shared/ShurikenMaps/Reference.luau'), mapDataModule('Reference', plan.paths, plan.markers, { studsPerUnit: 1, root: 'Workspace.Reference' }));
    writeFileSync(join(root, 'src/Shared/ShurikenMaps/Empty.luau'), mapDataModule('Empty', [], [], { studsPerUnit: 3.5714, root: 'Workspace.Empty' }));
    // game code that uses it the way the tool's result says
    writeFileSync(
      join(root, 'src/Server/Race.server.luau'),
      `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Map = require(ReplicatedStorage.Shared.ShurikenMaps.Reference)
local road = Map.path("road_centerline")
if road then
	local first: Vector3 = road.points[1]
	print(first, road.width, road.closed, road.length)
end
for _, spawn in Map.markersOf("spawn") do
	print(spawn.name, spawn.cframe.LookVector)
end
`,
    );
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    expect(r.problems.map((p) => `${p.tool} ${p.file}:${p.line} ${p.code} ${p.message}`)).toEqual([]);
  }, 120_000);
});

describe('the Studio programs under luau-lsp', () => {
  // No Luau runs here; luau-lsp's analysis (nonstrict, with Roblox's types) still finds a misspelt name, a missing
  // local or a wrong member in the programs execute_luau gets: each is wrapped in a function of a ModuleScript.
  it.skipIf(!STRICT)('have no unknown names or wrong members', async () => {
    const plan = reference();
    const root = mkdtempSync(join(tmpdir(), 'shuriken-map-programs-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    for (const d of ['Shared', 'Client', 'Server']) mkdirSync(join(root, 'src', d), { recursive: true });
    const wrap = (code: string) => `--!nonstrict
local function run()
${code}
end
return run
`;
    const programs: Record<string, string> = {
      Kit: kitLuau('Reference', plan.templates),
      KitTemporary: kitTemporaryLuau('Reference', [{ template: plan.templates[0]!, mesh: { v: [0, 0, 0, 1, 0, 0, 0, 0, 1], t: [0, 1, 2], n: [0, 1, 0, 0, 1, 0, 0, 1, 0] } }]),
      Units: unitsLuau(plan, 'run1', plan.units),
      Sweep: sweepLuau('Reference', 'run1', plan.templates.map((t) => t.name)),
      Markers: markersLuau('Reference', plan.markers),
    };
    for (const [name, code] of Object.entries(programs)) writeFileSync(join(root, 'src', 'Server', `${name}.luau`), wrap(code));
    // the control: the same sweep with one name misspelt must be found, or this test proves nothing
    writeFileSync(join(root, 'src', 'Server', 'Control.luau'), wrap(programs.Sweep!.replace('if kit then', 'if kti then')));
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    // selene's style rules are for project code; the analysis is what matters here
    const found = r.problems.filter((p) => p.tool === 'luau-lsp');
    expect(found.filter((p) => !p.file.endsWith('Control.luau')).map((p) => `${p.file}:${p.line} ${p.code} ${p.message}`)).toEqual([]);
    expect(found.filter((p) => p.file.endsWith('Control.luau')).map((p) => p.message).join(' ')).toMatch(/kti/);
  }, 120_000);
});

describe('a giant map stays within what a call can take', () => {
  // 1,400 placements of 350 meshes (175 pieces of two parts) over 9.2 km in meters, one road of 4,600 points.
  const pieces: Record<string, { model: string; studsPerUnit: number; parts: LayoutPart[] }> = {};
  for (let i = 0; i < 175; i++) pieces[`Piece${i}`] = { model: `Piece${i}`, studsPerUnit: 3.5714, parts: [box(`Piece${i}_Trunk`, [-1, -1, 0], [1, 1, 3 + (i % 5)], { asset: String(5000 + i * 2) }), box(`Piece${i}_Crown`, [-2, -2, 3], [2, 2, 6], { asset: String(5001 + i * 2), role: 'decor' })] };
  const placements = Array.from({ length: 1400 }, (_, i) => {
    const a = ((i * 37) % 360) * (Math.PI / 180);
    const f = 0.8 + (i % 7) / 10;
    return { name: `Piece${i % 175}_${String(i).padStart(4, '0')}`, piece: `Piece${i % 175}`, project: `proj-${i % 175}`, matrix: [[Math.cos(a) * f, -Math.sin(a) * f, 0, ((i * 131) % 9200) - 4600.123], [Math.sin(a) * f, Math.cos(a) * f, 0, ((i * 977) % 9200) - 4600.456], [0, 0, f, (i % 13) * 2.5], [0, 0, 0, 1]] as Mat4 };
  });
  const road = Array.from({ length: 4600 }, (_, i) => [Math.cos(i / 732) * 1464.123, Math.sin(i / 732) * 1464.456, 12.345 + Math.sin(i / 50) * 30] as Vec3);
  const plan = planLayout({ map: 'Giant', manifest: { ...manifest, studsPerUnit: 3.5714, placements, markers: Array.from({ length: 40 }, (_, i) => ({ name: `Checkpoint_${i}`, role: 'checkpoint', matrix: placements[i]!.matrix })), paths: [{ name: 'Road', role: 'road_centerline', points: road, width: 8, closed: true }], colliders: [] }, own: [], pieces });

  it('batches of placements are well under the size and count limits, and every batch parses', async () => {
    const batches = batchUnits(plan.units, { maxUses: 600, maxChars: 150_000, chars: unitChars });
    expect(batches.flat()).toHaveLength(1400);
    expect(batches.length).toBeGreaterThanOrEqual(5);
    let longest = 0;
    for (const b of batches) {
      const code = unitsLuau(plan, 'big', b);
      longest = Math.max(longest, code.length);
      // the estimate used to cut batches is not below the real size of a row
      const rows = code.slice(code.indexOf('local U = {\n')).split('\n').filter((l) => l.startsWith('{"'));
      expect(rows.join('\n').length).toBeLessThanOrEqual(b.reduce((n, u) => n + unitChars(u), 0));
    }
    expect(longest).toBeLessThan(160_000);
    if (SELENE) {
      await parses(unitsLuau(plan, 'big', batches[0]!));
      await parses(kitLuau('Giant', plan.templates.slice(0, 20)));
      await parses(sweepLuau('Giant', 'big', plan.templates.map((t) => t.name)));
    }
    // the kit of 350 templates, 20 a call
    expect(Math.ceil(plan.templates.length / 20)).toBe(18);
    expect(kitLuau('Giant', plan.templates.slice(0, 20)).length).toBeLessThan(8_000);
    expect(sweepLuau('Giant', 'big', plan.templates.map((t) => t.name)).length).toBeLessThan(20_000);
  }, 60_000);

  it('a 9.2 km road (4,600 points) is a data module under Studio\'s 200,000-character source limit', async () => {
    const code = mapDataModule('Giant', plan.paths, plan.markers, { studsPerUnit: 3.5714, root: 'Workspace.Giant' });
    expect(plan.paths[0]!.points).toHaveLength(4600);
    expect(plan.paths[0]!.length).toBeGreaterThan(30_000); // about 9.2 km in studs
    expect(code.length).toBeLessThan(200_000);
    if (SELENE) await parses(code);
    if (SELENE) await parses(markersLuau('Giant', plan.markers));
  }, 60_000);
});
