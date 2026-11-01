import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MIN_DRAWN, partMatrix, planPart } from '../../src/renderer/src/components/scene/placement';

/**
 * The viewer's "grey rectangle": the viewer reads sizes rounded to 0.01 stud, so a flat lens (a Glass MeshPart,
 * 2.8 × 4.8 × 0.001) arrived 0 thick. A zero scale made three.js divide the
 * lens's normal by zero (instancing undoes non-uniform scale by dividing each normal by the squared column lengths):
 * NaN shading, spread over the view by bloom. Reproduced in the real engine (all-black / see-through frame whenever the
 * lens faced the camera); this checks the matrix stays drawable.
 */
describe('a part thinner than the viewer can read', () => {
  // The normal three.js gives an instanced vertex (shaders/ShaderChunk/defaultnormal_vertex).
  const instancedNormal = (m: THREE.Matrix4, n: THREE.Vector3) => {
    const e = m.elements;
    const c = [new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(e[4], e[5], e[6]), new THREE.Vector3(e[8], e[9], e[10])];
    const k = n.clone().divide(new THREE.Vector3(c[0]!.lengthSq(), c[1]!.lengthSq(), c[2]!.lengthSq()));
    return c[0]!.clone().multiplyScalar(k.x).add(c[1]!.clone().multiplyScalar(k.y)).add(c[2]!.clone().multiplyScalar(k.z));
  };
  const lens = { cls: 'MeshPart', shape: '', pos: [-62.67, 264.4, -1712] as [number, number, number], size: [2.8, 4.8, 0] as [number, number, number], rot: [0, -90, 0] as [number, number, number], color: '5fdcff', material: 'Glass', transparency: 0, name: 'Scope_Lens', textured: false, reflectance: 0, model: 'Scope_Lens', flags: 0 };
  // The lens model: flat (its box is 0 deep, which the engine reads as 1e-4).
  const mesh = { center: [0, 0, 0] as [number, number, number], extent: [2.8, 4.8, 1e-4] as [number, number, number] };

  it('is drawn at least MIN_DRAWN thick, so its normals stay numbers', () => {
    const d = planPart(lens, { size: [2.8, 4.8, 0], legacy: false, texture: null }, () => 'box');
    const m = partMatrix(new THREE.Matrix4(), lens, d, mesh);
    expect(Math.abs(m.determinant())).toBeGreaterThan(0);
    const n = instancedNormal(m, new THREE.Vector3(0, 0, -1));
    expect([n.x, n.y, n.z].every(Number.isFinite)).toBe(true);
    expect(n.length()).toBeGreaterThan(0);
  });

  it('a flat primitive (a 0-thick sheet Part) too, and sizes that are not numbers', () => {
    const sheet = { ...lens, cls: 'Part', model: undefined, size: [8, 0, 8] as [number, number, number], material: 'SmoothPlastic' };
    const d = planPart(sheet, undefined, () => 'box');
    const m = partMatrix(new THREE.Matrix4(), sheet, d, null);
    expect([...instancedNormal(m, new THREE.Vector3(0, 1, 0)).toArray()].every(Number.isFinite)).toBe(true);
    const odd = partMatrix(new THREE.Matrix4(), sheet, { ...d, size: [Number.NaN, 2, 2] }, null);
    expect(odd.elements.every(Number.isFinite)).toBe(true);
    expect(MIN_DRAWN).toBe(0.001);
  });
});
