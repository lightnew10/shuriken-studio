import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { assembledSize, type RenderInstance } from '@shared/render';
import type { V3 } from '@shared/viewer';
import { instanceMatrix, instancedMeshes } from '../../src/renderer/src/components/models/instances';
import { partMatrix, planPart } from '../../src/renderer/src/components/scene/placement';
import type { ScenePart } from '../../src/renderer/src/components/scene/engine';

// A mesh used many times (a map's trees, posts and rocks: ModelMeta.instances) is drawn at EVERY use, not only its
// first: the Models page and model_view draw one instanced mesh per part (instances.ts), and the Studio viewer draws
// each clone Studio holds from the project's mesh (placement.ts). No WebGL here: where the geometry lands.

/** R = Ry(y) Rx(x) Rz(z), degrees: what CFrame.fromOrientation builds. */
function expectAt(u: RenderInstance, v: V3): THREE.Vector3 {
  const [a, b, c] = u.rotation.map((d) => (d * Math.PI) / 180) as V3;
  const p = new THREE.Vector3(v[0] * u.scale[0], v[1] * u.scale[1], v[2] * u.scale[2]);
  p.applyAxisAngle(new THREE.Vector3(0, 0, 1), c).applyAxisAngle(new THREE.Vector3(1, 0, 0), a).applyAxisAngle(new THREE.Vector3(0, 1, 0), b);
  return p.add(new THREE.Vector3(...u.position));
}

/** A loaded GLB's scene: one mesh of a 2 x 6 x 2 box, centred, with an asymmetric extra vertex pattern. */
function source(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(2, 6, 2), new THREE.MeshStandardMaterial()));
  return g;
}

const uses = (n: number): RenderInstance[] => Array.from({ length: n }, (_, i) => ({ position: [((i * 131) % 4000) - 2000, (i % 7) * 3, ((i * 977) % 4000) - 2000], rotation: [(i % 5) * 4 - 8, (i * 37) % 360, (i % 3) * 6 - 6], scale: [1 + (i % 4) / 4, 1 + (i % 3) / 2, 1 + (i % 4) / 4] }));

describe('the Models preview: a part with instances', () => {
  it('is one instanced mesh with an instance at every use: position, turn (Y, X, Z) and scale', () => {
    const list = uses(40);
    const { group, triangles } = instancedMeshes(source(), list);
    expect(group.children).toHaveLength(1);
    const mesh = group.children[0] as THREE.InstancedMesh;
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(mesh.count).toBe(40);
    expect(triangles).toBe(12 * 40);
    const m = new THREE.Matrix4();
    const corner: V3 = [1, 3, -1];
    list.forEach((u, k) => {
      mesh.getMatrixAt(k, m);
      const got = new THREE.Vector3(...corner).applyMatrix4(m);
      const want = expectAt(u, corner);
      expect(got.distanceTo(want), `use ${k}`).toBeLessThan(1e-3);
    });
    // not only the first: the last use is far from the first
    mesh.getMatrixAt(39, m);
    expect(new THREE.Vector3().applyMatrix4(m).distanceTo(new THREE.Vector3(...list[0]!.position))).toBeGreaterThan(100);
  });

  it('frames every use: its box is the box of all of them (the same box the model\'s size is told with)', () => {
    const list: RenderInstance[] = [{ position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [100, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, { position: [0, 1, 50], rotation: [0, 0, 90], scale: [1, 1, 1] }];
    const { group } = instancedMeshes(source(), list);
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const want = assembledSize([{ size: [2, 6, 2], instances: list }]);
    expect(size.x).toBeCloseTo(want[0], 3);
    expect(size.y).toBeCloseTo(want[1], 3);
    expect(size.z).toBeCloseTo(want[2], 3);
    expect(size.x).toBeGreaterThan(100); // one use would be 2 wide
  });

  it('a GLB whose mesh sits under a transformed node keeps that transform under every use', () => {
    const g = new THREE.Group();
    const inner = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    inner.position.set(0, 2, 0);
    g.add(inner);
    const u: RenderInstance = { position: [10, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] };
    const mesh = instancedMeshes(g, [u]).group.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3(0, 0, 0).applyMatrix4(m).distanceTo(new THREE.Vector3(10, 4, 0))).toBeLessThan(1e-6);
  });

  it('a thousand placements are one mesh and take milliseconds, not a thousand objects', () => {
    const list = uses(1000);
    const t0 = performance.now();
    const { group, triangles } = instancedMeshes(source(), list);
    const ms = performance.now() - t0;
    expect(group.children).toHaveLength(1);
    expect((group.children[0] as THREE.InstancedMesh).count).toBe(1000);
    expect((group.children[0] as THREE.InstancedMesh).instanceMatrix.array.length).toBe(16000);
    expect(triangles).toBe(12_000);
    expect(ms).toBeLessThan(250);
    // the geometry is shared, not copied per use
    let geometries = 0;
    group.traverse((o) => void (o instanceof THREE.Mesh ? geometries++ : 0));
    expect(geometries).toBe(1);
  });

  it('instanceMatrix agrees with CFrame.fromOrientation for a turn about every axis', () => {
    const u: RenderInstance = { position: [5, -2, 9], rotation: [20, 130, -40], scale: [1.5, 0.5, 2] };
    const m = instanceMatrix(new THREE.Matrix4(), u);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 2, 3]] as V3[]) expect(new THREE.Vector3(...v).applyMatrix4(m).distanceTo(expectAt(u, v))).toBeLessThan(1e-9);
  });
});

describe('the Studio viewer: clones of one mesh', () => {
  // What the map import leaves in Studio: one MeshPart per placement, all showing the same project model
  // (the ShurikenModel attribute), each with its own CFrame and Size. The viewer batches them by model.
  const MESH = { center: [0, 0, 0] as V3, extent: [2, 6, 2] as V3 };
  const row = (u: RenderInstance): ScenePart => ({ cls: 'MeshPart', shape: '', pos: u.position, size: [2 * u.scale[0], 6 * u.scale[1], 2 * u.scale[2]], rot: u.rotation, color: 'a3a2a5', material: 'Plastic', transparency: 0, name: 'Pine_0001', textured: false, reflectance: 0, model: 'Pine_Trunk' });

  it('draws the model at every clone: its CFrame, and its Size as a scale of the mesh', () => {
    const list = uses(1000);
    const entry = { size: MESH.extent, legacy: false, texture: null };
    const m = new THREE.Matrix4();
    const corner: V3 = [1, 3, -1];
    const t0 = performance.now();
    list.forEach((u, k) => {
      const p = row(u);
      const d = planPart(p, entry, () => 'box');
      expect(d.kind).toBe('model');
      expect(d.model).toBe('Pine_Trunk');
      partMatrix(m, p, d, MESH);
      if (k % 50 === 0) expect(new THREE.Vector3(...corner).applyMatrix4(m).distanceTo(expectAt(u, corner)), `clone ${k}`).toBeLessThan(1e-3);
    });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('a clone of a legacy upload (Shuriken turned it back in Studio) is drawn turned the same way', () => {
    // Studio holds the turned mesh at CFrame * Angles(0, pi, 0): the row carries that orientation and the ShurikenTurned flag.
    const u: RenderInstance = { position: [7, 3, -4], rotation: [0, 30, 0], scale: [1, 1, 1] };
    const p: ScenePart = { ...row(u), rot: [0, -150, 0], flags: 1 };
    const d = planPart(p, { size: MESH.extent, legacy: true, texture: null }, () => 'box');
    expect(d.turned).toBe(true);
    const m = partMatrix(new THREE.Matrix4(), p, d, MESH);
    expect(new THREE.Vector3(1, 3, -1).applyMatrix4(m).distanceTo(expectAt(u, [1, 3, -1]))).toBeLessThan(1e-4);
  });
});
