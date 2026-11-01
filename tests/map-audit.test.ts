import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STEP, mapAuditLuau, mapFindings, type MapAudit } from '@core/roblox/map-audit';
import { LUAURC, SELENE_TOML } from '@core/projects/project-service';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '@core/roblox/luau-toolchain';

// map_audit's checks of what a builder gets wrong without seeing it (the run of 2026-10-01: mechs walked through
// 6-stud tyre stacks, stray collidable boxes stood in the lanes, critics passed maps nobody could look at).
const lit = { style: 'Enum.LightingStyle.Realistic', clockTime: 13, atmosphere: 0.3, sky: true, colorCorrection: true, bloom: true, sunRays: true };
const finished: MapAudit = { area: 'Arena', parts: 3802, size: [239, 238], surface: { plainPlastic: 3, grey: 0, materials: [] }, ground: { samples: 144, void: 0, terrain: 53, materials: 8, heightSpread: 8.2, empty: 58, radius: 12 }, landmark: 98, giantFlatParts: [], lighting: lit };
const build = { loose: 0, looseNames: [], tinyColliding: 0, tinyNames: [], invisibleColliders: 126, preciseSmall: 0, preciseNames: [], smallShadows: 40, meshParts: 300, uniqueMeshes: 40, renderPrecise: 0, lights: 38, shadowLights: 12, streaming: true, zFighting: 0, zNames: [], zChecked: 2100 };
const cover = { pieces: 36, step: 3, walkThrough: 0, walkNames: [], low: 0, lowNames: [], shotThrough: 0, shotNames: [] };

describe('map_audit: build and cover findings', () => {
  it('a clean area (and an audit from before these checks) has none', () => {
    expect(mapFindings({ ...finished, build, cover })).toEqual([]);
    expect(mapFindings(finished)).toEqual([]);
  });

  it('cover that characters walk through or step over, and cover shots pass through', () => {
    const f = mapFindings({
      ...finished,
      build,
      cover: { ...cover, walkThrough: 1, walkNames: ['Workspace.Arena.Cover.Tarp'], low: 5, lowNames: ['Workspace.Arena.Cover.TyresNorth', 'Workspace.Arena.Cover.TyresSouth', 'Workspace.Arena.Cover.Drums'], shotThrough: 1, shotNames: ['Workspace.Arena.Cover.Glass'] },
    });
    expect(f.find((x) => x.startsWith('1 cover piece(s) have no collision'))).toContain('Workspace.Arena.Cover.Tarp');
    const low = f.find((x) => x.startsWith('5 cover piece(s) look 3+ studs tall but collide lower than 3 studs'))!;
    expect(low).toContain('Workspace.Arena.Cover.TyresNorth, Workspace.Arena.Cover.TyresSouth, Workspace.Arena.Cover.Drums and 2 more');
    // CanQuery is ignored on a part that collides (measured in the run): the collision group is what lets shots pass.
    expect(low).toMatch(/invisible blocker \(Transparency 1, CanCollide on, CastShadow off\).*collision group that only the characters' group collides with: CanQuery is ignored on a part that collides/);
    expect(f.some((x) => x.startsWith('1 cover piece(s) have no visible part that raycasts can hit'))).toBe(true);
  });

  it('unanchored parts, z-fighting, tiny colliders, precise collision on small props, shadowed lights, small shadow casters', () => {
    const f = mapFindings({
      ...finished,
      cover,
      build: { ...build, loose: 2, looseNames: ['Workspace.Arena.Dressing.Drum', 'Workspace.Arena.Dressing.Crate'], zFighting: 3, zNames: ['A x B'], tinyColliding: 120, tinyNames: ['Bolt'], preciseSmall: 40, preciseNames: ['Can'], shadowLights: 31, lights: 60, smallShadows: 900 },
    }).join('\n');
    for (const w of ['2 unanchored part(s)', '3 pair(s) of block faces lie in the same plane', 'z-fighting', '120 tiny visible parts', '40 small colliding meshes', 'PreciseConvexDecomposition', '31 local lights cast shadows', '900 small parts (under 2 studs) cast shadows']) expect(f).toContain(w);
    expect(f).toContain('a convention');
    // Many lights without shadows are a softer note than shadowed ones.
    expect(mapFindings({ ...finished, cover, build: { ...build, lights: 200 } }).join('\n')).toMatch(/200 lights in the area/);
  });

  it('the step reaches the audit script; the default is an R15 character’s', () => {
    expect(DEFAULT_STEP).toBe(3);
    expect(mapAuditLuau('Arena')).toMatch(/local RADIUS = 12\s+local STEP = 3\n/);
    expect(mapAuditLuau('Arena', 12, 12, 6.04)).toContain('local STEP = 6\n');
    expect(mapAuditLuau('Arena', 12, 12, 6.25)).toContain('local STEP = 6.3\n');
    expect(mapAuditLuau('Arena')).not.toMatch(/__\w+__/);
  });
});

// The audit runs as plugin-level Luau in Studio; it must at least pass the strict checker agents' code passes.
const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

describe.skipIf(!available)('the audit script', () => {
  it('passes selene and strict luau-lsp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-audit-lint-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    mkdirSync(join(root, 'src', 'Server'), { recursive: true });
    writeFileSync(join(root, 'src/Server/Audit.server.luau'), `--!strict\n${mapAuditLuau('Arena')}`);
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    expect(r.problems.map((p) => `${p.tool} ${p.line} ${p.code} ${p.message}`)).toEqual([]);
  }, 120_000);
});
