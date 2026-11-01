import { describe, expect, it } from 'vitest';
import { GEOMETRY_MARKER, compileGeometry, expandGeometry, geometryFileStem, geometryTag, rotateY } from '../src/core/geometry/geometry';

const close = (a: readonly number[], b: readonly number[], eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe('geometry specs', () => {
  it('applies defaults and keeps explicit parts', () => {
    const g = expandGeometry({
      name: 'Hut',
      pivot: [10, 0, 5],
      defaults: { material: 'WoodPlanks', color: '#8B5A2B' },
      parts: [
        { name: 'Floor', size: [10, 1, 10], pos: [0, 0.5, 0] },
        { name: 'Roof', size: [12, 1, 12], pos: [0, 8, 0], material: 'Slate', color: [60, 60, 70], shape: 'Wedge' },
      ],
    });
    expect(g.parent).toBe('Workspace');
    expect(g.pivot).toEqual([10, 0, 5]);
    expect(g.parts[0]).toMatchObject({ name: 'Floor', material: 'WoodPlanks', color: '8b5a2b', anchored: true, canCollide: true, shape: 'Block', rot: [0, 0, 0] });
    expect(g.parts[1]).toMatchObject({ material: 'Slate', color: '3c3c46', shape: 'Wedge' });
    expect(g.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(expandGeometry({ name: 'Hut', pivot: [10, 0, 5], defaults: { material: 'WoodPlanks', color: '#8B5A2B' }, parts: [{ name: 'Floor', size: [10, 1, 10], pos: [0, 0.5, 0] }, { name: 'Roof', size: [12, 1, 12], pos: [0, 8, 0], material: 'Slate', color: [60, 60, 70], shape: 'Wedge' }] }).hash).toBe(g.hash);
  });

  it('expands array, grid and ring generators', () => {
    const g = expandGeometry({
      name: 'Gen',
      generators: [
        { kind: 'array', name: 'Post', part: { size: [1, 4, 1] }, count: 3, start: [0, 2, 0], step: [5, 0, 0] },
        { kind: 'grid', name: 'Tile', part: { size: [4, 1, 4] }, countX: 2, countZ: 3, start: [0, 0, 0], spacing: [4, 4] },
        { kind: 'ring', name: 'Pillar', part: { size: [2, 10, 2] }, count: 4, center: [0, 5, 0], radius: 20, faceCenter: true },
      ],
    });
    const byName = new Map(g.parts.map((p) => [p.name, p]));
    expect(byName.get('Post_3')!.pos).toEqual([10, 2, 0]);
    expect(g.parts.filter((p) => p.name.startsWith('Tile_'))).toHaveLength(6);
    expect(byName.get('Tile_2_3')!.pos).toEqual([4, 0, 8]);
    // Pillar_1 at angle 0 sits on +X; facing the center means looking toward -X: ry = 90.
    expect(close(byName.get('Pillar_1')!.pos, [20, 5, 0])).toBe(true);
    expect(byName.get('Pillar_1')!.rot).toEqual([0, 90, 0]);
    // Pillar_2 at 90° sits on +Z; it must look toward -Z: ry = 0.
    expect(close(byName.get('Pillar_2')!.pos, [0, 5, 20])).toBe(true);
    expect(byName.get('Pillar_2')!.rot[1]).toBe(0);
  });

  it('builds stairs that climb along the yaw direction', () => {
    const g = expandGeometry({ name: 'S', generators: [{ kind: 'stairs', name: 'Step', steps: 3, width: 6, rise: 1, run: 2, start: [0, 0, 0], yaw: 90 }] });
    expect(g.parts).toHaveLength(3);
    const last = g.parts[2]!;
    expect(last.size).toEqual([6, 3, 2]);
    // Local (0, 1.5, 5) rotated by 90° about Y → (5, 1.5, 0).
    expect(close(last.pos, [5, 1.5, 0])).toBe(true);
    expect(last.rot).toEqual([0, 90, 0]);
    expect(close(rotateY([0, 0, 1], 90), [1, 0, 0])).toBe(true);
  });

  it('builds arches with pillars and walls with openings', () => {
    const g = expandGeometry({
      name: 'Gate',
      generators: [
        { kind: 'arch', name: 'Arch', span: 10, thickness: 2, depth: 3, segments: 6, center: [0, 0, 0], pillarHeight: 8 },
        { kind: 'wall', name: 'Wall', from: [0, 20], to: [30, 20], y: 0, height: 10, thickness: 1, openings: [{ at: 10, width: 4, height: 7 }, { at: 22, width: 3, height: 3, bottom: 4 }] },
      ],
    });
    const arch = g.parts.filter((p) => p.name.startsWith('Arch_'));
    expect(arch).toHaveLength(8); // 6 segments + 2 pillars
    const top = arch.find((p) => p.name === 'Arch_3')!;
    expect(top.pos[1]).toBeGreaterThan(8 + 5); // above the springline
    const wall = g.parts.filter((p) => p.name.startsWith('Wall_'));
    // Seg1 [0,8], door lintel, Seg2 [12,20.5], window sill + lintel, Seg3 [23.5,30]; the door has no sill.
    expect(wall.map((p) => p.name).sort()).toEqual(['Wall_Lintel1', 'Wall_Lintel2', 'Wall_Seg1', 'Wall_Seg2', 'Wall_Seg3', 'Wall_Sill2']);
    const seg1 = wall.find((p) => p.name === 'Wall_Seg1')!;
    expect(seg1.size).toEqual([8, 10, 1]);
    expect(close(seg1.pos, [4, 5, 20])).toBe(true);
    expect(seg1.rot[1]).toBe(0);
    const lintel = wall.find((p) => p.name === 'Wall_Lintel1')!;
    expect(lintel.size).toEqual([4, 3, 1]);
    expect(lintel.pos[1]).toBe(8.5);
  });

  it('rejects bad specs with actionable errors', () => {
    expect(() => expandGeometry({ name: 'X', parts: [] })).toThrow(/no parts/);
    expect(() => expandGeometry({ name: 'X', parts: [{ name: 'A', size: [1, 1, 1], pos: [0, 0, 0] }, { name: 'A', size: [1, 1, 1], pos: [0, 0, 0] }] })).toThrow(/Duplicate part names: A/);
    expect(() => expandGeometry({ name: 'X', parts: [{ name: 'A', size: [1, 1, 1], pos: [0, 0, 0] }], csg: [{ op: 'subtract', target: 'A', with: ['B'] }] })).toThrow(/no part named "B"/);
    expect(() =>
      expandGeometry({
        name: 'X',
        parts: [
          { name: 'A', size: [2, 2, 2], pos: [0, 0, 0] },
          { name: 'B', size: [1, 3, 1], pos: [0, 0, 0] },
        ],
        csg: [
          { op: 'subtract', target: 'A', with: ['B'], name: 'Hollow' },
          { op: 'union', target: 'A', with: ['Hollow'] },
        ],
      }),
    ).toThrow(/no part named "A"/);
    expect(() => expandGeometry({ name: 'X', parts: [{ name: 'A', size: [0, 1, 1], pos: [0, 0, 0] }] })).toThrow();
    expect(() => expandGeometry({ name: 'X', parts: [{ name: 'A', size: [1, 1, 1], pos: [0, 0, 0], material: 'Lava' }] })).toThrow();
    expect(() => expandGeometry({ name: 'X]==]', parts: [{ name: 'A', size: [1, 1, 1], pos: [0, 0, 0] }] })).toThrow();
    expect(() => expandGeometry({ name: 'X', generators: [{ kind: 'wall', name: 'W', from: [0, 0], to: [10, 0], y: 0, height: 5, thickness: 1, openings: [{ at: 9.5, width: 2, height: 2 }] }] })).toThrow(/overlaps/);
    expect(() => expandGeometry({ name: 'X', generators: [{ kind: 'grid', name: 'T', part: { size: [1, 1, 1] }, countX: 50, countZ: 50, start: [0, 0, 0], spacing: [1, 1] }] })).toThrow(/limit is 2000/);
  });

  it('compiles a marked, idempotent builder with the spec embedded as data', () => {
    const g = expandGeometry({ name: 'Crate Stack', parts: [{ name: 'A', size: [2, 2, 2], pos: [0, 1, 0] }, { name: 'B', size: [1, 3, 1], pos: [0, 1, 0] }], csg: [{ op: 'subtract', target: 'A', with: ['B'] }] });
    const code = compileGeometry(g, 'world/Crate_Stack.geometry.json');
    expect(code.split('\n')[1]).toBe(`${GEOMETRY_MARKER} ${g.hash}`);
    expect(code).toContain('HttpService:JSONDecode([==[{');
    expect(code).toContain('SubtractAsync');
    expect(code).toContain('local REPLACE_FOREIGN = __REPLACE__');
    expect(code).not.toContain('\\n'); // no escape sequences leak into the Luau source
    expect(geometryFileStem('Crate Stack')).toBe('Crate_Stack');
    expect(geometryTag('Crate Stack')).toBe('ShurikenGeometry_Crate_Stack');
  });
});

describe('world builders', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { listWorldBuilders } = await import('../src/core/roblox/world-builder');
  it('orders builders by world/world.json, then alphabetically', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-world-'));
    expect(listWorldBuilders(root)).toEqual({ files: [], manifest: false, problems: [] });
    mkdirSync(join(root, 'world'));
    for (const f of ['Arena.luau', 'Zone.luau', 'Beacon.luau', 'notes.md']) writeFileSync(join(root, 'world', f), '-- x');
    expect(listWorldBuilders(root).files).toEqual(['Arena.luau', 'Beacon.luau', 'Zone.luau']);
    writeFileSync(join(root, 'world', 'world.json'), JSON.stringify({ order: ['world/Zone.luau', 'Arena.luau', 'Missing.luau'] }));
    const ordered = listWorldBuilders(root);
    expect(ordered.files).toEqual(['Zone.luau', 'Arena.luau', 'Beacon.luau']);
    expect(ordered.manifest).toBe(true);
    expect(ordered.problems).toEqual(['world/world.json lists Missing.luau, which does not exist']);
  });
});
