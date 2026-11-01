import type { Vec3 } from '../curves';
import type { FxFrame, FxLayer, FxRow, FxSolid, FxSprites } from './sim';
import { mapply, vadd, vcross, vdot, vlen, vmul, vnorm, vsub } from './math';
import { SUN, type FxCamera, type FxStage } from './stage';

/**
 * A frame of an effect as triangles, in draw order: what both renderers draw (the three.js preview on the
 * GPU, the core's software rasteriser for contact sheets), so they show the same picture.
 *
 * Blending follows Roblox's LightEmission: colour × alpha is added, and what is behind is kept by
 * 1 - alpha × (1 - emission): emission 0 is ordinary blending, 1 is purely additive.
 */
export interface FxBatch {
  name: string;
  /** A texture reference (rbxasset://…, rbxassetid://…, tex:<Name>, or GLOW_TEX), or null for flat colour. */
  tex: string | null;
  /** x, y, z per vertex, three vertices per triangle. */
  pos: number[];
  /** u, v per vertex; v = 0 is the image's top row. */
  uv: number[];
  /** r, g, b, a per vertex (straight alpha; colour may exceed 1: Brightness). */
  col: number[];
  emission: number;
  /** Solid parts that hide what is behind them. */
  opaque: boolean;
}

/** The soft glow drawn round Neon parts (what Bloom does to them in Roblox). */
export const GLOW_TEX = 'fx:glow';

const batch = (name: string, tex: string | null, emission: number, opaque = false): FxBatch => ({ name, tex, pos: [], uv: [], col: [], emission, opaque });

function vertex(b: FxBatch, p: Vec3, u: number, v: number, c: Vec3, a: number): void {
  b.pos.push(p[0], p[1], p[2]);
  b.uv.push(u, v);
  b.col.push(c[0], c[1], c[2], a);
}

function quad(b: FxBatch, p00: Vec3, p10: Vec3, p11: Vec3, p01: Vec3, uv: [number, number, number, number], c: Vec3, a: number): void {
  const [u0, v0, u1, v1] = uv;
  // p00 is the bottom-left corner: the image's bottom row is v1.
  vertex(b, p00, u0, v1, c, a);
  vertex(b, p10, u1, v1, c, a);
  vertex(b, p11, u1, v0, c, a);
  vertex(b, p00, u0, v1, c, a);
  vertex(b, p11, u1, v0, c, a);
  vertex(b, p01, u0, v0, c, a);
}

function sprites(layer: FxSprites, cam: FxCamera, stage: FxStage): FxBatch {
  const b = batch(layer.name, layer.tex, layer.emission);
  const shade = 1 - layer.lit + layer.lit * stage.lit;
  const g = layer.grid;
  const toCam = vmul(cam.forward, -1);
  for (const s of layer.items) {
    let right = cam.right;
    let up = cam.up;
    if (layer.mode === 'VelocityPerpendicular') {
      // A flat card across its velocity (ground rings, slashes).
      const n = vlen(s.v) > 1e-6 ? vnorm(s.v) : ([0, 1, 0] as Vec3);
      right = vnorm(Math.abs(n[1]) < 0.99 ? vcross(n, [0, 1, 0]) : vcross(n, [1, 0, 0]));
      up = vcross(n, right);
    } else if (layer.mode === 'VelocityParallel') {
      // Faces the camera with its up axis along the velocity as seen on screen (streaks).
      const flat = vsub(s.v, vmul(cam.forward, vdot(s.v, cam.forward)));
      if (vlen(flat) > 1e-6) {
        up = vnorm(flat);
        right = vcross(up, toCam);
      }
    } else if (layer.mode === 'FacingCameraWorldUp') {
      up = [0, 1, 0];
      right = vnorm(vcross(up, toCam), cam.right);
    }
    // Squash: positive flattens the particle (wider, shorter), negative stretches it along its up axis
    // (narrower, longer), doubling per unit: measured on Studio screenshots of squash -3 streaks.
    const sy = 2 ** -s.squash * s.size * 0.5;
    const sx = 2 ** s.squash * s.size * 0.5;
    const cr = Math.cos(s.rot);
    const sr = Math.sin(s.rot);
    const corner = (x: number, y: number): Vec3 => {
      const lx = x * sx;
      const ly = y * sy;
      const rx = cr * lx - sr * ly;
      const ry = sr * lx + cr * ly;
      return [s.p[0] + right[0] * rx + up[0] * ry, s.p[1] + right[1] * rx + up[1] * ry, s.p[2] + right[2] * rx + up[2] * ry];
    };
    const col = s.cell % g;
    const row = Math.floor(s.cell / g) % g;
    const c: Vec3 = shade === 1 ? s.color : vmul(s.color, shade);
    quad(b, corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), [col / g, row / g, (col + 1) / g, (row + 1) / g], c, s.alpha);
  }
  return b;
}

function strips(layer: { name: string; tex?: string; emission: number; strips: FxRow[][] }, cam: FxCamera): FxBatch {
  const b = batch(layer.name, layer.tex ?? null, layer.emission);
  for (const rows of layer.strips) {
    if (rows.length < 2) continue;
    const edges = rows.map((r, i): [Vec3, Vec3] => {
      let side = r.side;
      if (!side) {
        // Turned to face the camera: across both the strip's direction and the view.
        const tangent = vsub(rows[Math.min(rows.length - 1, i + 1)]!.p, rows[Math.max(0, i - 1)]!.p);
        side = vnorm(vcross(tangent, vsub(cam.pos, r.p)), cam.right);
      }
      return [vsub(r.p, vmul(side, r.half)), vadd(r.p, vmul(side, r.half))];
    });
    for (let i = 0; i < rows.length - 1; i++) {
      const r0 = rows[i]!;
      const r1 = rows[i + 1]!;
      const [l0, e0] = edges[i]!;
      const [l1, e1] = edges[i + 1]!;
      if (r0.alpha <= 0 && r1.alpha <= 0) continue;
      vertex(b, l0, r0.u, 1, r0.color, r0.alpha);
      vertex(b, e0, r0.u, 0, r0.color, r0.alpha);
      vertex(b, e1, r1.u, 0, r1.color, r1.alpha);
      vertex(b, l0, r0.u, 1, r0.color, r0.alpha);
      vertex(b, e1, r1.u, 0, r1.color, r1.alpha);
      vertex(b, l1, r1.u, 1, r1.color, r1.alpha);
    }
  }
  return b;
}

/** Unit shapes (within ±0.5) as triangles with normals: Roblox's Ball, Cylinder (along x), Block and Wedge. */
type Tri = [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
const UNIT: Record<FxSolid['shape'], Tri[]> = (() => {
  const sphere: Tri[] = [];
  const rings = 10;
  const sides = 16;
  const at = (i: number, j: number): Vec3 => {
    const phi = (i / rings) * Math.PI;
    const th = (j / sides) * 2 * Math.PI;
    return [Math.sin(phi) * Math.cos(th) * 0.5, Math.cos(phi) * 0.5, Math.sin(phi) * Math.sin(th) * 0.5];
  };
  const n2 = (p: Vec3): Vec3 => vnorm(p);
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < sides; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i > 0) sphere.push([a, d, c, n2(a), n2(d), n2(c)]);
      if (i < rings - 1) sphere.push([a, c, b, n2(a), n2(c), n2(b)]);
    }
  const cylinder: Tri[] = [];
  const n = 24;
  for (let j = 0; j < n; j++) {
    const a0 = (j / n) * 2 * Math.PI;
    const a1 = ((j + 1) / n) * 2 * Math.PI;
    const p = (x: number, a: number): Vec3 => [x, Math.cos(a) * 0.5, Math.sin(a) * 0.5];
    const nr = (a: number): Vec3 => [0, Math.cos(a), Math.sin(a)];
    cylinder.push([p(-0.5, a0), p(0.5, a0), p(0.5, a1), nr(a0), nr(a0), nr(a1)], [p(-0.5, a0), p(0.5, a1), p(-0.5, a1), nr(a0), nr(a1), nr(a1)]);
    cylinder.push([[0.5, 0, 0], p(0.5, a1), p(0.5, a0), [1, 0, 0], [1, 0, 0], [1, 0, 0]], [[-0.5, 0, 0], p(-0.5, a0), p(-0.5, a1), [-1, 0, 0], [-1, 0, 0], [-1, 0, 0]]);
  }
  const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Tri[] => {
    const nn = vnorm(vcross(vsub(b, a), vsub(c, a)));
    return [
      [a, b, c, nn, nn, nn],
      [a, c, d, nn, nn, nn],
    ];
  };
  const h = 0.5;
  const block: Tri[] = [
    ...face([h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]),
    ...face([-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h]),
    ...face([-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]),
    ...face([-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h]),
    ...face([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]),
    ...face([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]),
  ];
  // A WedgePart: a full back face (+z), its slope falling to the front edge (-z).
  const tri = (a: Vec3, b: Vec3, c: Vec3): Tri => {
    const nn = vnorm(vcross(vsub(b, a), vsub(c, a)));
    return [a, b, c, nn, nn, nn];
  };
  const wedge: Tri[] = [
    ...face([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]),
    ...face([-h, -h, h], [-h, -h, -h], [h, -h, -h], [h, -h, h]),
    ...face([-h, h, h], [h, h, h], [h, -h, -h], [-h, -h, -h]),
    tri([h, -h, -h], [h, h, h], [h, -h, h]),
    tri([-h, -h, h], [-h, h, h], [-h, -h, -h]),
  ];
  // Every triangle counter-clockwise seen from outside (its face normal points away from a point inside).
  const outward = (tris: Tri[], inside: Vec3): Tri[] =>
    tris.map((t): Tri => (vdot(vcross(vsub(t[1], t[0]), vsub(t[2], t[0])), vsub(vmul(vadd(vadd(t[0], t[1]), t[2]), 1 / 3), inside)) >= 0 ? t : [t[0], t[2], t[1], t[3], t[5], t[4]]));
  return { sphere: outward(sphere, [0, 0, 0]), cylinder: outward(cylinder, [0, 0, 0]), block: outward(block, [0, 0, 0]), wedge: outward(wedge, [0, -0.2, 0.2]) };
})();

function solid(s: FxSolid, cam: FxCamera, stage: FxStage, into: { lit: FxBatch; clear: FxBatch; field: FxBatch; glow: FxBatch }): void {
  const dims: Vec3 = s.shape === 'sphere' ? [Math.min(...s.size), Math.min(...s.size), Math.min(...s.size)] : s.shape === 'cylinder' ? [s.size[0], Math.min(s.size[1], s.size[2]), Math.min(s.size[1], s.size[2])] : s.size;
  const neon = s.material === 'Neon';
  const field = s.material === 'ForceField';
  const glass = s.material === 'Glass';
  const alpha = s.alpha * (glass ? 0.45 : 1);
  const b = field ? into.field : alpha >= 0.999 ? into.lit : into.clear;
  for (const [a0, b0, c0, na, nb, nc] of UNIT[s.shape]) {
    const pts = [a0, b0, c0].map((p) => vadd(s.p, mapply(s.r, [p[0] * dims[0], p[1] * dims[1], p[2] * dims[2]]))) as [Vec3, Vec3, Vec3];
    const faceNormal = vcross(vsub(pts[1], pts[0]), vsub(pts[2], pts[0]));
    // Back faces are not drawn (a transparent part shows its front only, as in Roblox).
    if (vdot(faceNormal, vsub(cam.pos, pts[0])) <= 0) continue;
    [na, nb, nc].forEach((n0, i) => {
      const n = mapply(s.r, n0);
      const p = pts[i]!;
      if (neon) return vertex(b, p, 0, 0, s.color, alpha);
      if (field) {
        // A ForceField shows at its rim, where the surface turns away from the camera.
        const rim = 1 - Math.abs(vdot(n, vnorm(vsub(cam.pos, p))));
        return vertex(b, p, 0, 0, s.color, s.alpha * (0.12 + 0.88 * rim * rim));
      }
      // Wrapped a little round the shape, as sky light does.
      const light = stage.ambient + stage.sun * Math.max(0, (vdot(n, SUN) + 0.35) / 1.35);
      vertex(b, p, 0, 0, vmul(s.color, light), alpha);
    });
  }
  if (neon && s.alpha > 0.02) {
    // Bloom's glow round a Neon part, as a soft additive halo.
    const size = Math.max(...dims) * 1.8;
    const r = vmul(cam.right, size / 2);
    const u = vmul(cam.up, size / 2);
    quad(into.glow, vsub(vsub(s.p, r), u), vsub(vadd(s.p, r), u), vadd(vadd(s.p, r), u), vadd(vsub(s.p, r), u), [0, 0, 1, 1], s.color, s.alpha * 0.3);
  }
}

/** A frame's triangles in draw order: solid parts first, then the ground's decals, then the rest far to near. */
export function tessellate(frame: FxFrame, cam: FxCamera, stage: FxStage, extra: FxSolid[] = []): FxBatch[] {
  const out: FxBatch[] = [];
  // The stage's own solids (the character the effect plays on) carry no name: they are not part of the effect.
  const opaque: FxBatch[] = [batch('', null, 0, true)];
  const depthOf = (l: FxLayer) => vdot(vsub(l.at, cam.pos), cam.forward) - (l.kind === 'sprites' || l.kind === 'strips' ? l.zOffset : 0);
  const scratch = { lit: opaque[0]!, clear: batch('', null, 0), field: batch('', null, 1), glow: batch('', GLOW_TEX, 1) };
  for (const s of extra) solid(s, cam, stage, scratch);
  const later: Array<{ depth: number; batches: FxBatch[] }> = [];
  if (extra.length) later.push({ depth: vdot(vsub(extra[0]!.p, cam.pos), cam.forward), batches: [scratch.clear, scratch.field, scratch.glow].filter((b) => b.pos.length) });
  const decals: FxBatch[] = [];
  for (const l of frame.layers) {
    if (l.kind === 'decal') {
      const b = batch(l.name, l.tex, 0);
      const c = (x: number, z: number): Vec3 => vadd(l.p, mapply(l.r, [(x * l.size[0]) / 2, 0.03, (z * l.size[1]) / 2]));
      quad(b, c(-1, 1), c(1, 1), c(1, -1), c(-1, -1), [0, 0, 1, 1], l.color, l.alpha);
      decals.push(b);
    } else if (l.kind === 'solids') {
      const into = { lit: batch(l.name, null, 0, true), clear: batch(l.name, null, 0), field: batch(l.name, null, 1), glow: batch(l.name, GLOW_TEX, 1) };
      for (const s of l.items) solid(s, cam, stage, into);
      opaque.push(into.lit);
      later.push({ depth: depthOf(l), batches: [into.clear, into.field, into.glow].filter((b) => b.pos.length) });
    } else if (l.kind === 'sprites') {
      if (l.items.length) later.push({ depth: depthOf(l), batches: [sprites(l, cam, stage)] });
    } else {
      const b = strips(l, cam);
      if (b.pos.length) later.push({ depth: depthOf(l), batches: [b] });
    }
  }
  out.push(...opaque.filter((b) => b.pos.length), ...decals);
  // Far to near; layers at the same depth keep the order they were written in.
  later
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => b.depth - a.depth || a.i - b.i)
    .forEach((l) => out.push(...l.batches));
  return out;
}
