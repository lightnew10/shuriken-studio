import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOINTS, R15_RIG, REST_FOOT_LOW, UPPER_BODY, LOWER_BODY, bodyPartClip, aimHand, reachHand, reachMisses, resolveAims, clipDuration, ease, footLow, groundClip, mirrorClip, sampleClip, solveRig, validateClip, xfPoint, type AnimationClip, type RigPose } from '@shared/animation';
import { AIRBORNE, buildPreset, listPresets } from '@core/animation/presets';
import { animationsBuilder, animationCheckLuau, RUNTIME_MODULE } from '@core/animation/luau';
import { AnimationStore, clipHash } from '@core/animation/animation-service';

const close = (a: number, b: number, tol = 0.03) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('forward kinematics (checked against Studio measurements)', () => {
  it('puts the feet where Studio does at rest', () => {
    close(REST_FOOT_LOW, -3.19);
  });

  it('matches the right hand of the sword stance measured on a real rig', () => {
    // The exact pose that was built and measured in Studio (the presets have moved on since).
    const stance: RigPose = {
      LowerTorso: { rot: [0, -12, 0], pos: [0, -0.18, 0] }, UpperTorso: { rot: [-6, 14, 0] }, Head: { rot: [4, -8, 0] },
      RightUpperArm: { rot: [38, -10, 16] }, RightLowerArm: { rot: [38, 0, 0] }, RightHand: { rot: [12, 0, 0] },
      LeftUpperArm: { rot: [22, 8, -14] }, LeftLowerArm: { rot: [52, 0, 0] }, LeftHand: { rot: [6, 0, 0] },
      RightUpperLeg: { rot: [20, 8, 3] }, RightLowerLeg: { rot: [-30, 0, 0] }, RightFoot: { rot: [10, 0, 0] },
      LeftUpperLeg: { rot: [-8, 12, -5] }, LeftLowerLeg: { rot: [-22, 0, 0] }, LeftFoot: { rot: [12, 0, 0] },
    };
    const f = solveRig(stance);
    // Studio (x right, y up, z forward): 1.93, -0.26, 1.27 → rig space z = -1.27
    const [x, y, z] = f.RightHand.p;
    close(x, 1.93, 0.05);
    close(y, -0.26, 0.05);
    close(z, -1.27, 0.05);
    close(footLow(f) - REST_FOOT_LOW, -0.22, 0.03);
  });

  it('matches the authored landing crouch (hands and sinking feet)', () => {
    const land = buildPreset('Land', 'L', { ground: false });
    const f = solveRig(sampleClip(land, 0.08));
    // Studio: right hand 2.12, -1.1, 1.11 forward; feet 0.30 below rest.
    close(f.RightHand.p[0], 2.12, 0.05);
    close(f.RightHand.p[1], -1.1, 0.05);
    close(f.RightHand.p[2], -1.11, 0.05);
    close(footLow(f) - REST_FOOT_LOW, -0.3, 0.03);
  });
});

describe('blade aiming', () => {
  const bladeDir = (pose: RigPose, side: 'Left' | 'Right') => {
    const r = solveRig(pose)[`${side}Hand`].r;
    return [-r[2], -r[5], r[8]]; // hand -Z in x right, y up, f forward
  };
  it('solves the wrist so the blade points where asked, whatever the arm does', () => {
    for (const arm of [[0, 0, 5], [90, 0, 0], [150, 0, 40], [40, 0, -30]] as const) {
      for (const dir of [[0, 0, 1], [-0.55, -0.25, 0.8], [0.95, 0.05, -0.3], [0, 1, 0]] as const) {
        const pose: RigPose = { RightUpperArm: { rot: [...arm] }, RightLowerArm: { rot: [30, 0, 0] }, RightHand: { rot: [0, 0, 15] } };
        pose.RightHand = { rot: aimHand(pose, 'Right', [...dir]) };
        const got = bladeDir(pose, 'Right');
        const len = Math.hypot(...dir);
        dir.forEach((v, i) => close(got[i]!, v / len, 0.01));
        expect(pose.RightHand.rot![2]).toBe(15);
      }
    }
  });

  it('lets custom clips aim the blade instead of giving wrist angles', () => {
    const clip: AnimationClip = {
      name: 'Thrust',
      loop: false,
      priority: 'Action',
      keys: [
        { t: 0, poses: { RightUpperArm: { rot: [40, 0, 10] }, RightLowerArm: { rot: [60, 0, 0] }, RightHand: { aim: [0, 0.7, 0.7] } } },
        { t: 0.3, poses: { RightUpperArm: { rot: [92, 0, 0] }, RightLowerArm: { rot: [0, 0, 0] }, RightHand: { aim: [0, 0, 1] } } },
      ],
    };
    const r = resolveAims(clip);
    expect(r.keys[1]!.poses.RightHand!.aim).toBeUndefined();
    expect(r.keys[1]!.poses.RightHand!.rot).toBeDefined();
    const d = bladeDir(sampleClip(r, 0.3), 'Right');
    close(d[2]!, 1, 0.01);
    const d0 = bladeDir(sampleClip(r, 0), 'Right');
    close(d0[1]!, Math.SQRT1_2, 0.01);
    expect(validateClip(r)).toEqual([]);
  });

  it('sword presets hold the blade the way a fighter would', () => {
    const at = (id: string, t: number) => bladeDir(sampleClip(buildPreset(id, id), t), 'Right');
    expect(at('SwordIdle', 0)[2]).toBeGreaterThan(0.6); // guard: forward…
    expect(at('SwordIdle', 0)[1]).toBeGreaterThan(0.4); // …and up
    expect(at('SwordHeavy', 0.42)[2]).toBeGreaterThan(0.95); // the thrust stabs forward
    expect(at('SwordBlock', 0)[0]).toBeLessThan(-0.8); // the block lies across the body
    expect(at('SwordSlash1', 0.21)[1]).toBeLessThan(0); // the slash cuts downward…
    expect(at('SwordSlash1', 0.21)[0]).toBeLessThan(-0.3); // …across to the left
  });
});

describe('hand reach (IK)', () => {
  const handAt = (pose: RigPose, side: 'Left' | 'Right') => {
    const p = solveRig(pose)[`${side}Hand`].p;
    return [p[0], p[1], -p[2]];
  };
  it('solves shoulder and elbow to put a fist where asked, on either side and with the body turned', () => {
    const bodies: RigPose[] = [{}, { LowerTorso: { rot: [0, -22, 0], pos: [0, -0.2, 0] }, UpperTorso: { rot: [-8, -6, 0] } }, { LowerTorso: { rot: [-20, 30, 0] } }];
    const targets: Array<[number, number, number]> = [[-0.25, 1.15, 1.25], [0.05, 1.2, 2.3], [0.5, 0.2, 0.8], [0.2, 1.9, 1.1], [1.5, 0.2, 0.9]];
    for (const body of bodies) {
      for (const side of ['Left', 'Right'] as const) {
        for (const t of targets) {
          const sol = reachHand(body, side, t);
          const pose: RigPose = { ...body, [`${side}UpperArm`]: { rot: sol.upper }, [`${side}LowerArm`]: { rot: sol.lower } };
          const got = handAt(pose, side);
          close(Math.hypot(got[0]! - t[0], got[1]! - t[1], got[2]! - t[2]), sol.error, 0.001);
          // Whatever is within the arm's reach (1.86 studs from the shoulder when straight) is reached.
          const f = solveRig(body);
          const c = R15_RIG.joints[`${side}UpperArm`].child;
          const sh = xfPoint(f[`${side}UpperArm`], [c[0], c[1], c[2]]);
          const dist = Math.hypot(sh[0] - t[0], sh[1] - t[1], sh[2] + t[2]);
          if (dist < 1.7 && dist > 0.9) expect(sol.error, `${side} ${t}`).toBeLessThan(0.05);
          else if (dist >= 1.7) expect(sol.error, `${side} ${t}`).toBeLessThan(dist - 1.7 + 0.2);
        }
      }
    }
  });

  it('keeps the elbow down unless asked otherwise', () => {
    const elbowY = (hint?: 'low' | 'out' | 'high') => {
      const sol = reachHand({}, 'Left', [0.1, 1.2, 1.3], hint);
      return solveRig({ LeftUpperArm: { rot: sol.upper }, LeftLowerArm: { rot: sol.lower } }).LeftLowerArm.p[1];
    };
    expect(elbowY('high')).toBeGreaterThan(elbowY('low') + 0.3);
  });

  it('lets custom clips place hands instead of giving arm angles', () => {
    const clip: AnimationClip = {
      name: 'Jab',
      loop: false,
      priority: 'Action',
      keys: [
        { t: 0, poses: { LeftHand: { reach: [-0.25, 1.15, 1.25] } } },
        { t: 0.1, poses: { LowerTorso: { rot: [0, -30, 0] }, LeftHand: { reach: [0, 1.2, 1.9], rot: [0, 0, 0] } } },
      ],
    };
    const r = resolveAims(clip);
    expect(r.keys[1]!.poses.LeftHand!.reach).toBeUndefined();
    expect(r.keys[1]!.poses.LeftUpperArm!.rot).toBeDefined();
    const got = handAt(sampleClip(r, 0.1), 'Left');
    [0, 1.2, 1.9].forEach((v, i) => close(got[i]!, v, 0.06));
    expect(validateClip(r)).toEqual([]);
  });

  it('reports hands that cannot get to their reach points', () => {
    const clip: AnimationClip = {
      name: 'Far',
      loop: false,
      priority: 'Action',
      keys: [
        { t: 0, poses: { RightHand: { reach: [0.4, 1.1, 1.2] } } },
        { t: 0.2, poses: { RightHand: { reach: [0, 1.2, 4] } } },
      ],
    };
    const misses = reachMisses(clip, resolveAims(clip));
    expect(misses.map((m) => m.t)).toEqual([0.2]);
    expect(misses[0]!.miss).toBeGreaterThan(1);
  });

  it('unarmed presets keep the guard and land punches in front of the face', () => {
    const at = (id: string, t: number, side: 'Left' | 'Right') => handAt(sampleClip(buildPreset(id, id), t), side);
    const guardLead = at('FistIdle', 0, 'Left');
    expect(guardLead[1]).toBeGreaterThan(0.9); // fists up
    expect(guardLead[2]).toBeGreaterThan(0.8);
    expect(at('PunchJab', 0.09, 'Left')[2]).toBeGreaterThan(2.2);
    expect(at('PunchCross', 0.13, 'Right')[2]).toBeGreaterThan(2.2);
    expect(at('PunchUppercut', 0.2, 'Right')[1]).toBeGreaterThan(1.6);
  });

  it('the unarmed block covers the face with both forearms and keeps the guard stance', () => {
    const block = buildPreset('FistBlock', 'FistBlock');
    expect(block.loop).toBe(true);
    const rig = solveRig(sampleClip(block, 0));
    const idle = solveRig(sampleClip(buildPreset('FistIdle', 'FistIdle'), 0));
    const f = (p: readonly number[]): [number, number, number] => [p[0]!, p[1]!, -p[2]!];
    const head = f(rig.Head.p);
    for (const side of ['Left', 'Right'] as const) {
      const hand = f(rig[`${side}Hand`].p);
      const forearm = f(rig[`${side}LowerArm`].p);
      expect(hand[2]).toBeGreaterThan(head[2] + 0.4); // in front of the face
      expect(hand[1]).toBeGreaterThan(head[1] - 0.05); // at least eye height
      expect(hand[1] - forearm[1]).toBeGreaterThan(0.45); // forearm up, elbow below
      expect(Math.abs(hand[0])).toBeLessThan(0.4); // near the midline
      // Feet exactly where the guard puts them.
      f(rig[`${side}Foot`].p).forEach((v, i) => close(v, f(idle[`${side}Foot`].p)[i]!, 0.06));
    }
  });
});

describe('interpolation (as Roblox plays it)', () => {
  it('blends rotations like Studio does: nlerp for Linear poses, slerp for eased ones (measured on a rig)', () => {
    const at = (a: [number, number, number], b: [number, number, number], ease: 'Linear' | 'Cubic', t: number) => {
      const c: AnimationClip = { name: 'x', loop: false, priority: 'Action', keys: [{ t: 0, poses: { RightUpperArm: { rot: a, ease, dir: 'In' } } }, { t: 1, poses: { RightUpperArm: { rot: b } } }] };
      return solveRig(sampleClip(c, t)).RightUpperArm.r;
    };
    // Motor6D.Transform read back in Studio a quarter of the way through a pose blend (angles XYZ):
    // Linear at 25 % of the time, CubicV2 In at 63 % (eased progress 0.25).
    const cases: Array<[[number, number, number], [number, number, number], 'Linear' | 'Cubic', number, [number, number, number]]> = [
      [[69.2, -37.5, 23], [97, 4.7, -74], 'Linear', 0.25, [68.3, -24.3, -0.5]],
      [[0, 0, 0], [80, -20, 110], 'Linear', 0.25, [11.26, -17.31, 19.58]],
      [[97, 4.7, -74], [185.9, -25.1, 85.3], 'Linear', 0.25, [100, -19.4, -50.7]],
      [[0, 0, 0], [150, 0, 0], 'Linear', 0.25, [33.02, 0, 0]],
      [[0, 0, 0], [150, 0, 0], 'Cubic', Math.cbrt(0.25), [37.5, 0, 0]],
      [[0, 0, 0], [80, -20, 110], 'Cubic', Math.cbrt(0.25), [12.37, -18.42, 21.24]],
    ];
    for (const [a, b, ease, t, studio] of cases) {
      const got = at(a, b, ease, t);
      const want = solveRig({ RightUpperArm: { rot: studio } }).RightUpperArm.r;
      got.forEach((v, i) => close(v, want[i]!, 0.01));
    }
  });

  it('turns along the shortest arc, like CFrame lerp', () => {
    const c: AnimationClip = { name: 'x', loop: false, priority: 'Action', keys: [{ t: 0, poses: { LowerTorso: { rot: [-360, 0, 0], ease: 'Linear' } } }, { t: 1, poses: { LowerTorso: { rot: [-14, 0, 0] } } }] };
    close(sampleClip(c, 0.5).LowerTorso!.rot[0], -7, 0.01);
  });

  it('rolls the DodgeRoll along the floor (no part sinks, the ball stays in contact)', () => {
    const c = buildPreset('DodgeRoll', 'R');
    for (let t = 0.12; t <= 0.45; t += 1 / 60) {
      const f = solveRig(sampleClip(c, t));
      let low = Infinity;
      for (const j of JOINTS) {
        const h = R15_RIG.sizes[j].map((v) => v / 2);
        for (const a of [-1, 1]) for (const b of [-1, 1]) for (const d of [-1, 1]) low = Math.min(low, xfPoint(f[j], [a * h[0]!, b * h[1]!, d * h[2]!])[1]);
      }
      const gap = low - REST_FOOT_LOW;
      expect(gap, `t=${t.toFixed(3)}`).toBeGreaterThan(-0.12);
      expect(gap, `t=${t.toFixed(3)}`).toBeLessThan(0.25);
    }
  });
});

describe('easing (as Roblox plays it)', () => {
  it('In starts slow and Out ends slow, like TweenService', () => {
    close(ease('Cubic', 'In', 0.25) * 90, 1.4, 0.1);
    close(ease('Cubic', 'Out', 0.25) * 90, 52.0, 0.1);
    close(ease('Cubic', 'InOut', 0.25) * 90, 5.6, 0.1);
    close(ease('Elastic', 'In', 0.75) * 90, 8.0, 0.1);
    close(ease('Elastic', 'Out', 0.25) * 90, 82.0, 0.1);
    close(ease('Bounce', 'In', 0.5) * 90, 21.1, 0.1);
    close(ease('Bounce', 'Out', 0.25) * 90, 42.5, 0.1);
  });

  it('Constant jumps to the next pose at once', () => {
    expect(ease('Constant', 'In', 0)).toBe(0);
    expect(ease('Constant', 'In', 0.01)).toBe(1);
  });

  it('exports Cubic as CubicV2 (legacy Cubic runs backwards in Roblox)', () => {
    const code = animationsBuilder([buildPreset('SwordSlash1', 'S')]);
    expect(code).toContain('e="CubicV2"');
    expect(code).not.toContain('e="Cubic"');
  });
});

describe('presets', () => {
  it('are all valid, named and timed', () => {
    const list = listPresets();
    expect(list.length).toBeGreaterThanOrEqual(29);
    for (const p of list) {
      const c = buildPreset(p.id, p.id);
      expect(validateClip(c), p.id).toEqual([]);
      expect(clipDuration(c)).toBeGreaterThan(0.2);
    }
    expect(list.find((p) => p.id === 'SwordSlash1')?.markers).toContain('Hit');
  });

  it('keep the feet out of the floor at every key', () => {
    for (const p of listPresets().filter((x) => !AIRBORNE.has(x.id))) {
      const c = buildPreset(p.id, p.id);
      for (const k of c.keys) {
        const gap = footLow(solveRig(sampleClip(c, k.t))) - REST_FOOT_LOW;
        expect(gap, `${p.id} @ ${k.t}s`).toBeGreaterThan(-0.05);
      }
    }
  });

  it('put Hit markers where the strike reaches in front of the body', () => {
    for (const p of listPresets().filter((x) => x.markers.includes('Hit'))) {
      const c = buildPreset(p.id, p.id);
      const t = c.markers!.find((m) => m.name === 'Hit')!.t;
      const f = solveRig(sampleClip(c, t));
      const reach = Math.max(...(['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot'] as const).map((j) => -f[j].p[2]));
      expect(reach, `${p.id}: hand or foot forward at Hit`).toBeGreaterThan(1.2);
    }
  });

  it('scale, retime and mirror', () => {
    const base = buildPreset('SwordSlash1', 'A');
    const fast = buildPreset('SwordSlash1', 'B', { speed: 2 });
    expect(clipDuration(fast)).toBeCloseTo(clipDuration(base) / 2, 3);
    expect(fast.markers?.[0]?.t).toBeCloseTo((base.markers?.[0]?.t ?? 0) / 2, 3);
    const left = buildPreset('SwordSlash1', 'C', { hand: 'left' });
    const rightArm = base.keys[1]!.poses.RightUpperArm!.rot!;
    const leftArm = left.keys[1]!.poses.LeftUpperArm!.rot!;
    expect(leftArm[0]).toBeCloseTo(rightArm[0] * 1, 3);
    expect(leftArm[2]).toBeCloseTo(-rightArm[2], 3);
    expect(() => buildPreset('Nope', 'X')).toThrow(/Unknown preset/);
  });

  it('keeps only the upper or lower body of a clip (partial clips layer by joint)', () => {
    const slash = buildPreset('SwordSlash1', 'S', {});
    const up = bodyPartClip(slash, 'upper');
    const low = bodyPartClip(slash, 'lower');
    const keyed = (c: AnimationClip) => new Set(c.keys.flatMap((k) => Object.keys(k.poses)));
    expect([...keyed(up)].every((j) => (UPPER_BODY as readonly string[]).includes(j))).toBe(true);
    expect([...keyed(low)].every((j) => (LOWER_BODY as readonly string[]).includes(j))).toBe(true);
    expect(keyed(up).size + keyed(low).size).toBe(keyed(slash).size);
    expect(up.keys.map((k) => k.t)).toEqual(slash.keys.map((k) => k.t));
    expect(up.markers).toEqual(slash.markers);
    expect(validateClip(up)).toEqual([]);
    expect([...UPPER_BODY, ...LOWER_BODY].sort()).toEqual([...JOINTS].sort());
  });

  it('mirror swaps sides symmetrically in space', () => {
    const c = buildPreset('SwordSlash2', 'S');
    const m = mirrorClip(c, 'M');
    const a = solveRig(sampleClip(c, 0.2));
    const b = solveRig(sampleClip(m, 0.2));
    const pa = xfPoint(a.RightHand, [0, 0, 0]);
    const pb = xfPoint(b.LeftHand, [0, 0, 0]);
    close(pa[0], -pb[0], 0.02);
    close(pa[1], pb[1], 0.02);
    close(pa[2], pb[2], 0.02);
  });
});

describe('grounding', () => {
  it('raises hips that would push the feet into the floor', () => {
    const deep: AnimationClip = {
      name: 'Deep',
      loop: false,
      priority: 'Action',
      keys: [
        { t: 0, poses: { LowerTorso: { pos: [0, 0, 0] } } },
        { t: 0.3, poses: { LowerTorso: { pos: [0, -1, 0] }, RightUpperLeg: { rot: [10, 0, 0] }, LeftUpperLeg: { rot: [10, 0, 0] } } },
      ],
    };
    const before = footLow(solveRig(sampleClip(deep, 0.3))) - REST_FOOT_LOW;
    expect(before).toBeLessThan(-0.9);
    const fixed = groundClip(deep);
    close(footLow(solveRig(sampleClip(fixed, 0.3))) - REST_FOOT_LOW, 0, 0.01);
  });

  it('plants floating feet when asked', () => {
    const hop: AnimationClip = { name: 'Hop', loop: false, priority: 'Action', keys: [{ t: 0, poses: { LowerTorso: { pos: [0, 0.5, 0] } } }, { t: 1, poses: { LowerTorso: { pos: [0, 0.5, 0] } } }] };
    close(footLow(solveRig(sampleClip(groundClip(hop, { plant: true }), 0))) - REST_FOOT_LOW, 0, 0.01);
    close(footLow(solveRig(sampleClip(groundClip(hop), 0))) - REST_FOOT_LOW, 0.5, 0.01);
  });
});

describe('validation', () => {
  it('rejects broken clips with reasons', () => {
    const bad: AnimationClip = { name: '1bad name', loop: false, priority: 'Action', keys: [{ t: 0.2, poses: { Tail: { rot: [0, 0, 0] } } as never }] };
    const p = validateClip(bad).join('\n');
    expect(p).toMatch(/name/);
    expect(p).toMatch(/at least 2 keys/);
    expect(p).toMatch(/unknown joint "Tail"/);
    expect(p).toMatch(/first key must be at 0/);
  });
});

describe('project files', () => {
  it('saves clips, generates the builder and the runtime module, keeps uploads while unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-anim-'));
    const store = new AnimationStore(root);
    store.save({ clip: buildPreset('SwordSlash1', 'Slash'), preset: 'SwordSlash1' });
    store.save({ clip: buildPreset('Walk', 'Walk'), preset: 'Walk' });
    expect(store.names()).toEqual(['Slash', 'Walk']);
    const builder = readFileSync(join(root, 'world/Animations.luau'), 'utf8');
    expect(builder).toContain('name="Slash"');
    expect(builder).toContain('name="Walk"');
    expect(builder).toContain('markers={{t=0.2,name="Hit"');

    const rt = store.ensureRuntime(undefined);
    expect(rt).toMatchObject({ file: 'src/Shared/ShurikenAnimations.luau', requirePath: 'game.ReplicatedStorage.Shared.ShurikenAnimations', written: true });
    expect(readFileSync(join(root, rt.file), 'utf8')).toBe(RUNTIME_MODULE);
    expect(store.ensureRuntime(undefined).written).toBe(false);
    expect(AnimationStore.runtimeLocation({ 'src/shared': 'ReplicatedStorage/Common Code' }).requirePath).toBe('game.ReplicatedStorage["Common Code"].ShurikenAnimations');

    store.setUpload('Slash', '123456');
    expect(readFileSync(join(root, 'world/Animations.luau'), 'utf8')).toContain('asset="123456"');
    expect(store.summary(store.get('Slash')!).uploaded).toBe('123456');
    // Changing the clip invalidates the upload.
    store.save({ clip: buildPreset('SwordSlash1', 'Slash', { speed: 1.5 }), preset: 'SwordSlash1' });
    expect(store.summary(store.get('Slash')!).uploaded).toBeNull();
    expect(readFileSync(join(root, 'world/Animations.luau'), 'utf8')).not.toContain('asset="123456"');
    // Re-saving identical content keeps a (new) upload.
    store.setUpload('Slash', '777');
    store.save({ clip: buildPreset('SwordSlash1', 'Slash', { speed: 1.5 }), preset: 'SwordSlash1' });
    expect(store.summary(store.get('Slash')!).uploaded).toBe('777');
    expect(clipHash(buildPreset('Walk', 'Walk'))).toBe(clipHash({ ...buildPreset('Walk', 'Walk'), description: 'other words' }));

    expect(store.remove('Walk')).toBe(true);
    expect(store.remove('Slash')).toBe(true);
    expect(existsSync(join(root, 'world/Animations.luau'))).toBe(false);
  });

  it('generates a check program for a clip', () => {
    const code = animationCheckLuau('Slash', [{ name: 'Hit', t: 0.18 }]);
    expect(code).toContain('local NAME = "Slash"');
    expect(code).toContain('{name="Hit",t=0.18}');
    expect(code).toContain('StepAnimations');
  });
});

describe('animation upload file', () => {
  it('writes a KeyframeSequence model the way Studio does (validated by loading it in Studio)', async () => {
    const { clipToRbxmx, AUTHORED_HIP_HEIGHT } = await import('@core/animation/rbxmx');
    const xml = clipToRbxmx(buildPreset('SwordSlash1', 'Slash'));
    expect(xml.startsWith('<roblox ')).toBe(true);
    expect(xml).toContain('<Item class="KeyframeSequence"');
    expect(xml).toContain(`<float name="AuthoredHipHeight">${AUTHORED_HIP_HEIGHT}</float>`);
    expect(xml).toContain('<token name="Priority">2</token>');
    // 5 keys plus a keyframe for the Hit marker at 0.2 s (no key there).
    expect((xml.match(/<Item class="Keyframe" /g) ?? []).length).toBe(6);
    expect(xml).toContain('<Item class="KeyframeMarker"');
    expect(xml).toContain('<string name="Name">Hit</string>');
    // Cubic is written as CubicV2 (5); pass-through HumanoidRootPart poses have weight 0.
    expect(xml).toContain('<token name="EasingStyle">5</token>');
    expect(xml).toMatch(/<string name="Name">HumanoidRootPart<\/string>\s*<float name="Weight">0<\/float>/);
    // Referents are unique.
    const refs = xml.match(/referent="([^"]+)"/g) ?? [];
    expect(new Set(refs).size).toBe(refs.length);
    // Balanced items.
    expect((xml.match(/<Item /g) ?? []).length).toBe((xml.match(/<\/Item>/g) ?? []).length);
  });
});

describe('importing the game\'s own animations', () => {
  it('turns a KeyframeSequence back into the clip it was built from (rotations, positions, easing, markers)', async () => {
    const { anglesMatrix } = await import('../src/shared/rig');
    const { sequenceToClip, eulerXYZ } = await import('../src/core/animation/import');
    const cf = (pos: [number, number, number], rot: [number, number, number]) => [...pos, ...anglesMatrix(rot)];
    const raw = {
      name: 'Slash',
      loop: false,
      priority: 'Action',
      keyframes: [
        { t: 0.3, poses: [{ name: 'HumanoidRootPart', cf: cf([0, 0, 0], [0, 0, 0]), style: 'Linear', dir: 'In', weight: 0 }, { name: 'RightUpperArm', cf: cf([0, 0, 0], [80, -20, 35]), style: 'Cubic', dir: 'Out', weight: 1 }], markers: [{ name: 'Hit', value: '' }] },
        { t: 0, poses: [{ name: 'LowerTorso', cf: cf([0, -0.4, -0.2], [-12, 5, 0]), style: 'Linear', dir: 'In', weight: 1 }, { name: 'Tail', cf: cf([0, 0, 0], [10, 0, 0]), style: 'Linear', dir: 'In', weight: 1 }], markers: [] },
      ],
    };
    const { clip, skipped } = sequenceToClip('SwordSlashOld', raw);
    expect(skipped).toEqual(['Tail']);
    expect(clip).toMatchObject({ name: 'SwordSlashOld', loop: false, priority: 'Action', markers: [{ t: 0.3, name: 'Hit' }] });
    expect(clip.keys.map((k) => k.t)).toEqual([0, 0.3]);
    expect(clip.keys[0]!.poses.LowerTorso).toEqual({ rot: [-12, 5, 0], pos: [0, -0.4, -0.2], ease: 'Linear', dir: 'In' });
    expect(clip.keys[1]!.poses.RightUpperArm).toEqual({ rot: [80, -20, 35], ease: 'Cubic', dir: 'Out' });
    // Gimbal lock (y = ±90°) still gives a rotation that rebuilds the same matrix.
    const m = anglesMatrix([30, 90, 0]);
    const back = anglesMatrix(eulerXYZ(m));
    expect(back.map((v) => Math.round(v * 1e6) / 1e6)).toEqual(m.map((v) => Math.round(v * 1e6) / 1e6));
  });
});
