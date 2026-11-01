import * as THREE from 'three';
import { PART_FLAG, VIEWER_HUGE, hasFlag, meshTurned, specialMeshDrawSize, type V3 } from '@shared/viewer';
import type { ScenePart } from './engine';

export type Proxy = 'box' | 'ball' | 'cylinder' | 'wedge' | 'corner' | 'foliage' | 'rock' | 'trunk';

/** How one part is drawn at the moment. */
export interface Drawn {
  kind: 'model' | 'proxy' | 'ghost';
  proxy: Proxy;
  model: string | null;
  /** The size it is drawn at (a SpecialMesh piece: the mesh's own size times its Scale). */
  size: V3;
  /** Where the mesh sits from the part's centre, in the part's own axes (a SpecialMesh's Offset). */
  offset: V3 | null;
  /** The mesh's geometry is turned 180° about Y about its centre first (see meshTurned). */
  turned: boolean;
  /** Painted with the model's colour map. */
  textured: boolean;
}

/** What drawing a model's part needs to know of the model. */
export interface PlanModel {
  size: V3;
  legacy: boolean;
  texture: unknown;
}

/**
 * How a part is drawn, given the model it shows (undefined: not loaded yet, null: it can't be had).
 * A modeled mesh draws its geometry (a SpecialMesh piece at the mesh's size times its Scale), turned like
 * Roblox turns it. What can't be drawn truly gets a stand-in, and a stand-in that would be a giant slab (a mesh
 * wider than the backdrop limit, or a SpecialMesh piece of unknown size) is only a faint wire box: nothing
 * solid that isn't known to be there. `standIn` names the primitive that stands in for a mesh.
 */
export function planPart(p: ScenePart, entry: PlanModel | null | undefined, standIn: () => Proxy): Drawn {
  const flags = p.flags ?? 0;
  if (p.model && entry) {
    const fm = p.fileMesh;
    return {
      kind: 'model',
      proxy: 'box',
      model: p.model,
      size: fm ? specialMeshDrawSize(entry.size, fm.scale) : p.size,
      offset: fm ? fm.offset : null,
      turned: meshTurned(flags, entry.legacy),
      textured: !!entry.texture && hasFlag(flags, PART_FLAG.colorMap),
    };
  }
  const stand = (kind: 'proxy' | 'ghost', proxy: Proxy): Drawn => ({ kind, proxy, model: null, size: p.size, offset: null, turned: false, textured: false });
  if (p.fileMesh) {
    // Its Part.Size is not what it shows (the mesh is): small ones stay a marker, the rest a wire box.
    return Math.max(p.size[0], p.size[1], p.size[2]) > 64 || Math.max(...p.fileMesh.scale) > 20 ? stand('ghost', 'box') : stand('proxy', 'box');
  }
  const mesh = !!p.model || p.cls === 'MeshPart' || p.cls === 'UnionOperation' || p.cls === 'IntersectOperation' || p.cls === 'NegateOperation';
  if (mesh && Math.max(p.size[0], p.size[1], p.size[2]) > VIEWER_HUGE) return stand('ghost', 'box');
  return stand('proxy', standIn());
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TURN = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI);
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();
const qPart = new THREE.Quaternion();
const pos = new THREE.Vector3();
const off = new THREE.Vector3();
const scale = new THREE.Vector3();
const fit = new THREE.Matrix4();

/**
 * The thinnest a part is drawn, in studs: Roblox's own minimum part size. The viewer reads sizes rounded to 0.01 stud,
 * so a 0.001-thick part (a flat lens, a decal sheet) arrived as 0, and a zero scale makes three.js divide each normal
 * by zero (its instancing undoes non-uniform scale that way): NaN shading, which the bloom pass spreads into a solid
 * block over the view (the "grey rectangle").
 */
export const MIN_DRAWN = 0.001;

/**
 * The matrix that puts a part's geometry in the world. A primitive's geometry is a unit shape scaled to the part's
 * size. A model's geometry keeps the size and centre the project made it with (`mesh`): its box centre goes to
 * the part's centre (plus a SpecialMesh's Offset in the part's axes), its box is stretched to the size it is
 * drawn at, and, when Roblox turns the mesh (`turned`), it is first turned 180° about Y about that centre.
 */
export function partMatrix(out: THREE.Matrix4, p: Pick<ScenePart, 'pos' | 'rot'>, d: Drawn, mesh: { center: V3; extent: V3 } | null): THREE.Matrix4 {
  euler.set(THREE.MathUtils.degToRad(p.rot[0]), THREE.MathUtils.degToRad(p.rot[1]), THREE.MathUtils.degToRad(p.rot[2]), 'YXZ');
  qPart.setFromEuler(euler);
  let [sx, sy, sz] = d.size.map((v) => Math.max(MIN_DRAWN, Number.isFinite(v) ? v : MIN_DRAWN)) as [number, number, number];
  if (!mesh && d.proxy === 'ball') sx = sy = sz = Math.min(sx, sy, sz);
  if (!mesh && d.proxy === 'cylinder') sy = sz = Math.min(sy, sz);
  pos.set(p.pos[0], p.pos[1], p.pos[2]);
  if (d.offset) pos.add(off.set(d.offset[0], d.offset[1], d.offset[2]).applyQuaternion(qPart));
  quat.copy(qPart);
  if (d.turned) quat.multiply(TURN);
  if (!mesh) return out.compose(pos, quat, scale.set(sx, sy, sz));
  scale.set(sx / mesh.extent[0], sy / mesh.extent[1], sz / mesh.extent[2]);
  return out.compose(pos, quat, scale).multiply(fit.makeTranslation(-mesh.center[0], -mesh.center[1], -mesh.center[2]));
}
