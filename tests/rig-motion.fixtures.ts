import { parseRig, type Vec3 } from '@shared/rig';
import type { RigBody } from '../src/core/animation/rig-motion';

/** Points on a tube from a to b (radius r): a segment's surface, like a mesh's vertices. */
export function tube(a: Vec3, b: Vec3, r: number): number[] {
  const out: number[] = [];
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d) || 1;
  const u: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
  const t: Vec3 = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const n1: Vec3 = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
  const nl = Math.hypot(...n1);
  const p: Vec3 = [n1[0] / nl, n1[1] / nl, n1[2] / nl];
  const q: Vec3 = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
  for (let i = 0; i <= 10; i++) {
    const c: Vec3 = [a[0] + d[0] * (i / 10), a[1] + d[1] * (i / 10), a[2] + d[2] * (i / 10)];
    for (let k = 0; k < 8; k++) {
      const w = (k / 8) * Math.PI * 2;
      out.push(c[0] + r * (Math.cos(w) * p[0] + Math.sin(w) * q[0]), c[1] + r * (Math.cos(w) * p[1] + Math.sin(w) * q[1]), c[2] + r * (Math.cos(w) * p[2] + Math.sin(w) * q[2]));
    }
  }
  return out;
}

export const box = (lo: Vec3, hi: Vec3): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) for (let k = 0; k <= 4; k++) if ([i, j, k].some((v) => v === 0 || v === 4)) out.push(lo[0] + ((hi[0] - lo[0]) * i) / 4, lo[1] + ((hi[1] - lo[1]) * j) / 4, lo[2] + ((hi[2] - lo[2]) * k) / 4);
  return out;
};

export function body(raw: unknown, points: Record<string, number[]>): RigBody {
  const rig = parseRig(raw);
  if (typeof rig === 'string') throw new Error(rig);
  return { rig, points };
}

/** Like Kiln's Griever: 8 mech legs from kiln.limb(rig=True) (ball hips, hinged knees and ankles), a stinger tail, mandibles. */
export function griever(): RigBody {
  const joints: unknown[] = [{ name: 'Body', parent: null, part: 'Body', pivot: [0, 2, 0], kind: 'ball', axis: [-1, 0, 0], limits: null }];
  const points: Record<string, number[]> = { Body: box([-1, 1.5, -1.6], [1, 2.6, 1.6]) };
  const legs: unknown[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const n = `Leg${side < 0 ? 'L' : 'R'}${i}`;
      const z = -1.2 + i * 0.8;
      const hip: Vec3 = [side * 0.9, 2, z];
      const knee: Vec3 = [side * 2.0, 2.9, z];
      const ankle: Vec3 = [side * 3.0, 1.3, z];
      const tip: Vec3 = [side * 3.4, 0, z];
      joints.push(
        // Kiln writes a ball's limits about Blender's axes and a hinge's as [min, max].
        { name: `${n}_0`, parent: 'Body', part: `${n}_0`, pivot: hip, kind: 'ball', axis: [0, 0, 1], limits: [[-35, -25, -35], [35, 25, 35]] },
        { name: `${n}_1`, parent: `${n}_0`, part: `${n}_1`, pivot: knee, kind: 'hinge', axis: [0, 0, 1], limits: [-45, 45] },
        { name: `${n}_2`, parent: `${n}_1`, part: `${n}_2`, pivot: ankle, kind: 'hinge', axis: [0, 0, 1], limits: [-45, 45] },
      );
      points[`${n}_0`] = tube(hip, knee, 0.15);
      points[`${n}_1`] = tube(knee, ankle, 0.12);
      points[`${n}_2`] = tube(ankle, tip, 0.08);
      legs.push({ joints: [`${n}_0`, `${n}_1`, `${n}_2`], foot: `${n}_2` });
    }
  }
  const tail: Vec3[] = [[0, 2.3, 1.5], [0, 2.8, 2.2], [0, 3.5, 2.6], [0, 4.2, 2.6], [0, 4.8, 2.2], [0, 5.1, 1.6], [0, 4.9, 1.0]];
  for (let i = 0; i < 6; i++) {
    joints.push({ name: `Tail_${i}`, parent: i ? `Tail_${i - 1}` : 'Body', part: `Tail_${i}`, pivot: tail[i], kind: 'hinge', axis: [-1, 0, 0], limits: [-45, 45] });
    points[`Tail_${i}`] = tube(tail[i]!, tail[i + 1]!, 0.25 - i * 0.02);
  }
  for (const side of [-1, 1]) {
    const n = `Mandible_${side < 0 ? 'L' : 'R'}`;
    joints.push({ name: n, parent: 'Body', part: n, pivot: [side * 0.3, 2, -1.5], kind: 'hinge', axis: [0, 1, 0], limits: [-30, 30] });
    points[n] = tube([side * 0.3, 2, -1.5], [side * 0.2, 1.9, -2.1], 0.08);
  }
  return body(
    {
      version: 1,
      model: 'Griever',
      root: 'Body',
      joints,
      legs,
      attachments: [
        { name: 'Mandible_L_Tip', part: 'Mandible_L', position: [-0.2, 1.9, -2.1] },
        { name: 'Stinger_Tip', part: 'Tail_5', position: [0, 4.9, 1.0] },
        { name: 'Bite_Point', part: 'Body', position: [0, 1.9, -2.0] },
      ],
    },
    points,
  );
}

/** A two-legged creature: ball hips, knees that bend back, ankles, flat feet. */
export function biped(): RigBody {
  const joints: unknown[] = [{ name: 'Hips', parent: null, part: 'Hips', pivot: [0, 3, 0], kind: 'ball' }];
  const points: Record<string, number[]> = { Hips: box([-0.7, 2.8, -0.4], [0.7, 4.6, 0.4]) };
  const legs: unknown[] = [];
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'L' : 'R';
    joints.push(
      { name: `Thigh${s}`, parent: 'Hips', part: `Thigh${s}`, pivot: [side * 0.45, 3, 0], kind: 'ball', limits: { min: [-70, -30, -30], max: [70, 30, 30] } },
      { name: `Shin${s}`, parent: `Thigh${s}`, part: `Shin${s}`, pivot: [side * 0.45, 1.6, 0], kind: 'hinge', axis: [1, 0, 0], limits: { min: -140, max: 0 } },
      { name: `Foot${s}`, parent: `Shin${s}`, part: `Foot${s}`, pivot: [side * 0.45, 0.3, 0], kind: 'hinge', axis: [1, 0, 0], limits: { min: -40, max: 40 } },
    );
    points[`Thigh${s}`] = tube([side * 0.45, 3, 0], [side * 0.45, 1.6, 0], 0.25);
    points[`Shin${s}`] = tube([side * 0.45, 1.6, 0], [side * 0.45, 0.3, 0], 0.2);
    points[`Foot${s}`] = box([side * 0.45 - 0.22, 0, -0.6], [side * 0.45 + 0.22, 0.3, 0.2]);
    legs.push({ joints: [`Thigh${s}`, `Shin${s}`, `Foot${s}`], foot: `Foot${s}` });
  }
  joints.push({ name: 'Head', parent: 'Hips', part: 'Head', pivot: [0, 4.6, -0.1], kind: 'ball' });
  points.Head = box([-0.4, 4.6, -0.8], [0.4, 5.4, 0.2]);
  return body({ version: 1, model: 'Walker', root: 'Hips', joints, legs, attachments: [{ name: 'Bite_Tip', part: 'Head', position: [0, 4.9, -0.8] }] }, points);
}

/** A snake: ten segments head (root) to tail along +Z. */
export function snake(): RigBody {
  const joints: unknown[] = [];
  const points: Record<string, number[]> = {};
  for (let i = 0; i < 10; i++) {
    joints.push({ name: `S${i}`, parent: i ? `S${i - 1}` : null, part: `S${i}`, pivot: [0, 0.3, -4 + i * 0.8], kind: 'ball', limits: { min: [-20, -35, -20], max: [20, 35, 20] } });
    points[`S${i}`] = tube([0, 0.3, -4 + i * 0.8], [0, 0.3, -4 + (i + 1) * 0.8], 0.3);
  }
  return body({ version: 1, model: 'Snake', root: 'S0', joints, legs: [], attachments: [{ name: 'Bite_Tip', part: 'S0', position: [0, 0.3, -4.2] }] }, points);
}

