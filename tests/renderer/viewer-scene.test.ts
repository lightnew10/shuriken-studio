import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PART_FLAG, specialMeshDrawSize, type V3 } from '@shared/viewer';
import { contentBox, frameScene, terrainExtent, type FramePart } from '../../src/renderer/src/components/scene/framing';
import { partMatrix, planPart, type Drawn } from '../../src/renderer/src/components/scene/placement';
import { parseRows, type PartsPage } from '../../src/renderer/src/components/scene/scene-rows';
import type { ScenePart } from '../../src/renderer/src/components/scene/engine';

// The viewer's scene logic that needs no WebGL: where a part's geometry lands (the 180° turn Roblox gives
// uploaded meshes, a SpecialMesh's size and offset), what is drawn solid and what only as a wire box, the
// rows Studio's Luau writes, and where the camera looks first.

const part = (over: Partial<ScenePart> = {}): ScenePart => ({
  cls: 'MeshPart',
  shape: '',
  pos: [0, 0, 0],
  size: [4, 2, 8],
  rot: [0, 0, 0],
  color: 'a3a2a5',
  material: 'Plastic',
  transparency: 0,
  name: 'P',
  textured: false,
  reflectance: 0,
  ...over,
});

/** A model's mesh as the project made it: centred, 4 × 2 × 8 studs. */
const MESH = { center: [0, 0, 0] as V3, extent: [4, 2, 8] as V3 };
/** A point of that mesh with nothing symmetric about it, so a half turn moves it. */
const A = new THREE.Vector3(1, 0.5, 3);

const cframe = (pos: V3, rotDeg: V3) => new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rotDeg.map(THREE.MathUtils.degToRad) as V3), 'YXZ')), new THREE.Vector3(1, 1, 1));
const drawn = (over: Partial<Drawn> = {}): Drawn => ({ kind: 'model', proxy: 'box', model: 'M', size: [4, 2, 8], offset: null, turned: false, textured: false, ...over });
const place = (p: ScenePart, d: Drawn, mesh: typeof MESH | null = MESH) => partMatrix(new THREE.Matrix4(), p, d, mesh);
const at = (m: THREE.Matrix4, v: THREE.Vector3) => v.clone().applyMatrix4(m);
const close = (a: THREE.Vector3, b: THREE.Vector3, digits = 4) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};
/** What Studio draws for a legacy upload: the GLB's point turned 180° about Y, at the part's CFrame. */
const studioLegacy = (cf: THREE.Matrix4, v: THREE.Vector3) => at(cf, new THREE.Vector3(-v.x, v.y, -v.z));

describe('where a modeled mesh is drawn', () => {
  it('a legacy upload placed with the compensating half-turn (world/Map.luau) shows at the pose it was meant for', () => {
    // The Kiln export puts the asphalt at C0; the builder gives the part C0 * HALF_TURN and Studio shows the
    // turned legacy mesh at it, which lands exactly on C0.
    const c0 = cframe([10, 5, -3], [0, 30, 0]);
    const p = part({ pos: [10, 5, -3], rot: [0, -150, 0] }); // C0 * Angles(0, π, 0): Y 30° + 180°, as ToOrientation reports it
    const got = at(place(p, drawn({ turned: true })), A);
    close(got, at(c0, A));
    close(got, studioLegacy(cframe([10, 5, -3], [0, -150, 0]), A));
    // The old drawing (the original GLB at the part's CFrame, un-turned) was half a turn about its own centre off.
    const old = at(place(p, drawn({ turned: false })), A);
    expect(old.distanceTo(got)).toBeCloseTo(2 * Math.hypot(1, 3), 4);
  });

  it('every point of a legacy mesh follows Roblox: turned about the mesh centre, then at the part', () => {
    const p = part({ pos: [-40, 12, 77], rot: [10, 200, -20] });
    const cf = cframe(p.pos, p.rot);
    for (const v of [new THREE.Vector3(2, 1, 4), new THREE.Vector3(-2, 1, 4), new THREE.Vector3(0.3, -1, -2.2)]) close(at(place(p, drawn({ turned: true })), v), studioLegacy(cf, v));
  });

  it("a marked upload (and a temporary mesh) shows the GLB at the part's CFrame, as it is", () => {
    const p = part({ pos: [10, 5, -3], rot: [0, 30, 0] });
    close(at(place(p, drawn({ turned: false })), A), at(cframe([10, 5, -3], [0, 30, 0]), A));
  });

  it("a part Shuriken's builder marked ShurikenTurned shows at the pose the model was placed at", () => {
    // place(): mp.CFrame = CFrame(pos) * fromOrientation(rot) * Angles(0, π, 0), then ShurikenTurned = true.
    const placed = cframe([4, 1, 9], [0, 45, 0]);
    const marked = placed.clone().multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    const e = new THREE.Euler().setFromRotationMatrix(marked, 'YXZ');
    const p = part({ model: 'M', pos: [4, 1, 9], rot: [e.x, e.y, e.z].map(THREE.MathUtils.radToDeg) as V3 });
    // The model's record may even say "not legacy" by now (uploaded again since): the part still holds the old mesh.
    const unmarked = planPart(p, { size: [4, 2, 8], legacy: false, texture: null }, () => 'box');
    expect(unmarked.turned).toBe(false);
    const flagged = planPart({ ...p, flags: PART_FLAG.turned }, { size: [4, 2, 8], legacy: false, texture: null }, () => 'box');
    expect(flagged.turned).toBe(true);
    close(at(place(p, flagged), A), at(placed, A));
  });

  it('a SpecialMesh piece draws the mesh at its size times Scale, its Offset in the part’s own axes', () => {
    const size: V3 = [1949.503, 1063.702, 4148.393];
    const f = 2048 / 4148.393;
    const p = part({ cls: 'Part', pos: [100, 50, -20], rot: [0, 90, 0], size: [1949, 1063, 2048], model: 'Big', fileMesh: { scale: [1 / f, 1 / f, 1 / f], offset: [5, 0, 0] } });
    const d = planPart(p, { size, legacy: false, texture: null }, () => 'box');
    expect(d.kind).toBe('model');
    d.size.forEach((v, i) => expect(v).toBeCloseTo(size[i]!, 6));
    expect(d.offset).toEqual([5, 0, 0]);
    // The model's far corner (its mesh is centred, extent = size): corner of the drawn box, offset turned with the part.
    const corner = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
    const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const want = new THREE.Vector3(5, 0, 0).add(corner).applyMatrix4(rot).add(new THREE.Vector3(100, 50, -20));
    close(at(place(p, d, { center: [0, 0, 0], extent: size }), corner), want, 3);
  });

  it('a mesh whose box is not centred on its origin lands with the box centre on the part', () => {
    const off = { center: [3, -1, 2] as V3, extent: [2, 2, 2] as V3 };
    const p = part({ pos: [7, 8, 9], rot: [0, 0, 0], size: [10, 10, 10] });
    close(at(place(p, drawn({ size: [10, 10, 10] }), off), new THREE.Vector3(3, -1, 2)), new THREE.Vector3(7, 8, 9));
    // And the box is stretched to the size: one extent along +X from the centre is half the size from the part.
    close(at(place(p, drawn({ size: [10, 10, 10] }), off), new THREE.Vector3(4, -1, 2)), new THREE.Vector3(12, 8, 9));
  });

  it('a primitive is its unit shape scaled to the part, and a ball or cylinder keeps its round section', () => {
    const p = part({ cls: 'Part', pos: [1, 2, 3], size: [4, 6, 8] });
    close(at(place(p, drawn({ kind: 'proxy', model: null, size: [4, 6, 8] }), null), new THREE.Vector3(0.5, 0.5, 0.5)), new THREE.Vector3(3, 5, 7));
    const ball = at(place(p, drawn({ kind: 'proxy', proxy: 'ball', model: null, size: [4, 6, 8] }), null), new THREE.Vector3(0.5, 0.5, 0.5));
    close(ball, new THREE.Vector3(3, 4, 5));
    const cyl = at(place(p, drawn({ kind: 'proxy', proxy: 'cylinder', model: null, size: [4, 6, 8] }), null), new THREE.Vector3(0.5, 0.5, 0.5));
    close(cyl, new THREE.Vector3(3, 5, 6));
  });
});

describe('what is drawn solid', () => {
  const model = { size: [4, 2, 8] as V3, legacy: true, texture: {} };

  it('draws a loaded model, turned when its upload is legacy, painted when Studio shows a colour map and the model has one', () => {
    const p = part({ model: 'Asphalt', flags: PART_FLAG.colorMap });
    const d = planPart(p, model, () => 'box');
    expect(d).toMatchObject({ kind: 'model', model: 'Asphalt', turned: true, textured: true, size: [4, 2, 8] });
    expect(planPart(part({ model: 'Asphalt' }), model, () => 'box').textured).toBe(false); // no SurfaceAppearance in Studio
    expect(planPart(p, { ...model, texture: null }, () => 'box').textured).toBe(false); // no map in the project
    expect(planPart({ ...p, flags: PART_FLAG.colorMap + PART_FLAG.temporary }, model, () => 'box').turned).toBe(false);
  });

  it('never draws a giant opaque slab for a mesh it has not got: a wire box for anything over 900 studs', () => {
    expect(planPart(part({ size: [1519, 92, 1079], model: 'Map_Asphalt_Track' }), undefined, () => 'rock').kind).toBe('ghost');
    expect(planPart(part({ size: [1519, 92, 1079], model: 'Map_Asphalt_Track' }), null, () => 'rock').kind).toBe('ghost');
    expect(planPart(part({ size: [60, 5, 900.5], cls: 'UnionOperation' }), undefined, () => 'rock').kind).toBe('ghost');
    // Smaller ones keep their stand-in, chosen by name and colour as before.
    expect(planPart(part({ size: [30, 40, 30], model: 'Tree' }), undefined, () => 'foliage')).toMatchObject({ kind: 'proxy', proxy: 'foliage' });
    // A real primitive that wide is a baseplate, drawn as it is.
    expect(planPart(part({ cls: 'Part', size: [2048, 1, 2048] }), undefined, () => 'box')).toMatchObject({ kind: 'proxy', proxy: 'box' });
  });

  it('a SpecialMesh piece the project cannot name is a wire box when big and a small marker when small, never a slab', () => {
    const fm = { scale: [3, 3, 3] as V3, offset: [0, 0, 0] as V3 };
    expect(planPart(part({ cls: 'Part', size: [2048, 1063, 1949], fileMesh: fm }), undefined, () => 'box').kind).toBe('ghost');
    expect(planPart(part({ cls: 'Part', size: [2048, 1063, 1949], fileMesh: fm, model: 'Big' }), undefined, () => 'box').kind).toBe('ghost'); // named, not loaded yet
    expect(planPart(part({ cls: 'Part', size: [4, 1, 2], fileMesh: fm }), null, () => 'box')).toMatchObject({ kind: 'proxy', proxy: 'box' });
    expect(planPart(part({ cls: 'Part', size: [4, 1, 2], fileMesh: { scale: [200, 200, 200], offset: [0, 0, 0] } }), null, () => 'box').kind).toBe('ghost');
  });

  it("uses the model's size for a named SpecialMesh piece, so a 4,000-stud piece is drawn at 4,000", () => {
    const p = part({ cls: 'Part', size: [1949, 1063, 2048], model: 'Foliage', fileMesh: { scale: [1, 1, 1], offset: [0, 0, 0] } });
    expect(planPart(p, { size: [1949.5, 1063.7, 4148.4], legacy: true, texture: null }, () => 'box').size).toEqual(specialMeshDrawSize([1949.5, 1063.7, 4148.4], [1, 1, 1]));
  });
});

describe('the rows Studio sends', () => {
  const page: PartsPage = { total: 3, count: 3, classes: ['Part', 'MeshPart'], materials: ['Plastic', 'SmoothPlastic'], parents: ['', 'Map/StartGrid'], rows: '' };

  it('reads the flags and the SpecialMesh scale and offset, and still reads a row from an older core', () => {
    page.rows = [
      // a MeshPart with a colour map, marked ShurikenTurned
      '1,,22.69,63.57,-118.18,1519.74,92.77,1079.21,0,-150,0,373738,1,0,Map_Asphalt_Track,0,0,Map_Asphalt_Track,0,3,',
      // a Part drawn through a SpecialMesh: FileMesh + colour map
      '0,Block,0,0,0,1949,1063,2048,0,0,0,ffffff,0,0,Map_Foliage_Autumn_Or,0,0,Map_Foliage_Autumn_Orange_1,0,6,0.5|0.5|0.5|0|10|0',
      // an older core: 19 fields
      '0,Block,1,2,3,4,5,6,0,0,0,a3a2a5,0,0.5,Slot1,0,0,,1',
    ].join(';');
    const [mesh, piece, old] = parseRows(page);
    expect(mesh).toMatchObject({ cls: 'MeshPart', name: 'Map_Asphalt_Track', model: 'Map_Asphalt_Track', flags: PART_FLAG.turned + PART_FLAG.colorMap, material: 'SmoothPlastic', parent: '' });
    expect(mesh!.fileMesh).toBeUndefined();
    expect(mesh!.size).toEqual([1519.74, 92.77, 1079.21]);
    expect(piece).toMatchObject({ cls: 'Part', model: 'Map_Foliage_Autumn_Orange_1', flags: PART_FLAG.fileMesh + PART_FLAG.colorMap, fileMesh: { scale: [0.5, 0.5, 0.5], offset: [0, 10, 0] } });
    expect(old).toMatchObject({ name: 'Slot1', parent: 'Map/StartGrid', transparency: 0.5, flags: 0 });
    expect(old!.model).toBeUndefined();
    expect(old!.fileMesh).toBeUndefined();
    expect(parseRows({ ...page, rows: '' })).toEqual([]);
  });

  it('ignores a SpecialMesh field that is not three numbers', () => {
    page.rows = '0,Block,0,0,0,1,1,1,0,0,0,ffffff,0,0,P,0,0,,0,4,1|2';
    expect(parseRows(page)[0]!.fileMesh).toBeUndefined();
  });
});

describe('where the camera looks first', () => {
  const mesh = (name: string, x: number, z: number, size = 40, over: Partial<FramePart> = {}): FramePart => ({ cls: 'MeshPart', name, pos: [x, 10, z], size: [size, 10, size], transparency: 0, ...over });
  // The user's drift map, in numbers: 110 meshes over a 1,400 × 1,000 circuit, 31 oversize backdrop pieces
  // that are only wire boxes, a start grid on the road.
  const circuit = (): FramePart[] => {
    const parts: FramePart[] = [];
    for (let i = 0; i < 110; i++) parts.push(mesh(`Map_${i}`, -700 + ((i * 137) % 1400), -500 + ((i * 251) % 1000), 20 + (i % 7) * 15));
    for (let i = 0; i < 31; i++) parts.push(mesh(`Map_Foliage_${i}`, ((i * 811) % 6000) - 3000, ((i * 397) % 6000) - 3000, 2048, { ghost: true, size: [2048, 1100, 4100] }));
    return parts;
  };
  const grid = (): FramePart[] => [
    { cls: 'Part', name: 'StartGrid', parent: 'Map', pos: [214, 49, 564], size: [2, 1, 4], transparency: 1 },
    ...[0, 1, 2, 3].map((i): FramePart => ({ cls: 'Part', name: `Slot${i + 1}`, parent: 'Map/StartGrid', pos: [214 + (i % 2) * 8, 49, 564 + Math.floor(i / 2) * 10], size: [2, 1, 2], transparency: 1 })),
  ];

  it('goes to the StartGrid, even though its parts are invisible markers, and frames its neighbourhood, not the whole map', () => {
    const f = frameScene([...circuit(), ...grid()])!;
    expect(f.kind).toBe('startgrid');
    expect(f.target[0]).toBeCloseTo(214, -1);
    expect(f.target[2]).toBeCloseTo(564, -1);
    expect(f.radius).toBeGreaterThanOrEqual(60);
    expect(f.radius).toBeLessThanOrEqual(160);
  });

  it('goes to a SpawnLocation that lies within the build, and ignores one left far away', () => {
    const spawn = (x: number, z: number): FramePart => ({ cls: 'SpawnLocation', name: 'SpawnLocation', pos: [x, 1, z], size: [6, 1, 6], transparency: 0 });
    const near = frameScene([...circuit(), spawn(300, 100)])!;
    expect(near.kind).toBe('spawn');
    expect(near.target[0]).toBeCloseTo(300, 0);
    const far = frameScene([...circuit(), spawn(9000, 9000)])!;
    expect(far.kind).toBe('content');
    expect(Math.abs(far.target[0])).toBeLessThan(800);
  });

  it('else frames the robust box of the meshes: stand-in slabs, a baseplate and a few far props do not stretch it', () => {
    const cluster: FramePart[] = [];
    for (let i = 0; i < 120; i++) cluster.push(mesh(`B${i}`, 780 + ((i * 37) % 200), 790 + ((i * 53) % 200), 20));
    const clean = frameScene(cluster)!;
    const noisy = frameScene([
      ...cluster,
      { cls: 'Part', name: 'Baseplate', pos: [0, -1, 0], size: [2048, 1, 2048], transparency: 0 },
      mesh('Slab', 0, 0, 3000, { ghost: true }),
      mesh('FarTree1', 5000, 5000),
      mesh('FarTree2', -4000, 3000),
    ])!;
    expect(clean.kind).toBe('content');
    expect(clean.target[0]).toBeGreaterThan(780);
    expect(clean.target[0]).toBeLessThan(990);
    expect(noisy.target[0]).toBeCloseTo(clean.target[0], -1);
    expect(noisy.target[2]).toBeCloseTo(clean.target[2], -1);
    expect(noisy.radius).toBeLessThan(clean.radius * 1.6);
    // Only the slabs and the baseplate: nothing to look at.
    expect(frameScene([mesh('Slab', 0, 0, 3000, { ghost: true }), { cls: 'Part', name: 'Baseplate', pos: [0, 0, 0], size: [2048, 1, 2048], transparency: 0 }])).toBeNull();
    expect(frameScene([])).toBeNull();
    // Invisible parts say nothing about where the map is.
    expect(contentBox([mesh('Hidden', 10, 10, 20, { transparency: 1 })])).toBeNull();
  });

  it('samples terrain around the content (at least ±256 studs, at most 3,000 across)', () => {
    expect(terrainExtent([mesh('A', 10, 10)])).toEqual({ minX: -320, maxX: 320, minZ: -320, maxZ: 320 });
    const wide = terrainExtent(circuit());
    expect(wide.maxX - wide.minX).toBeLessThanOrEqual(3000);
    expect(wide.minX).toBeLessThan(-500);
    expect(wide.maxX).toBeGreaterThan(500);
    const huge = terrainExtent([...Array.from({ length: 60 }, (_, i) => mesh(`F${i}`, i % 2 ? 90_000 : -90_000, 0))]);
    expect(huge.maxX - huge.minX).toBe(3000);
  });
});
