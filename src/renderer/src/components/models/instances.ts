import * as THREE from 'three';
import type { RenderInstance } from '@shared/render';

/**
 * A part whose mesh is used many times (`ModelMeta.instances`: trees, posts, rocks of a map) drawn at every use, as
 * one instanced mesh: a thousand placements are one draw call and one copy of the geometry.
 */

const euler = new THREE.Euler();
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scale = new THREE.Vector3();

/** One use's transform: its centre, its orientation (degrees, the order CFrame.fromOrientation uses: Y, X, Z) and its scale. */
export function instanceMatrix(out: THREE.Matrix4, u: RenderInstance): THREE.Matrix4 {
  euler.set(THREE.MathUtils.degToRad(u.rotation[0]), THREE.MathUtils.degToRad(u.rotation[1]), THREE.MathUtils.degToRad(u.rotation[2]), 'YXZ');
  return out.compose(pos.set(u.position[0], u.position[1], u.position[2]), quat.setFromEuler(euler), scale.set(u.scale[0], u.scale[1], u.scale[2]));
}

/**
 * Every mesh under `source` (a loaded GLB: the part's geometry centred on its box) as an InstancedMesh with one
 * instance per use, in a group. The geometry and materials are the source's own (not copied); `triangles` is what is drawn.
 */
export function instancedMeshes(source: THREE.Object3D, instances: RenderInstance[]): { group: THREE.Group; triangles: number } {
  const group = new THREE.Group();
  let triangles = 0;
  const m = new THREE.Matrix4();
  source.updateMatrixWorld(true);
  source.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mesh = new THREE.InstancedMesh(o.geometry as THREE.BufferGeometry, o.material as THREE.Material, instances.length);
    instances.forEach((u, k) => mesh.setMatrixAt(k, instanceMatrix(m, u).multiply(o.matrixWorld)));
    mesh.instanceMatrix.needsUpdate = true;
    // The box and sphere of all the uses: what frames the camera and keeps the mesh from being culled as one use.
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    const idx = mesh.geometry.getIndex();
    triangles += ((idx ? idx.count : mesh.geometry.getAttribute('position').count) / 3) * instances.length;
    group.add(mesh);
  });
  return { group, triangles };
}
