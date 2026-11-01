import { JOINTS, R15_RIG, REST_FOOT_LOW, aimHand, clipDuration, groundClip, mirrorClip, plantFoot, reachFoot, reachHand, solveRig, xfPoint, type AnimationClip, type ElbowHint, type ClipKey, type Easing, type EasingDir, type Joint, type JointPose, type Priority } from '@shared/animation';

/**
 * Hand-tuned R15 animations as starting points: sword combat (a three-hit combo, heavy thrust, block,
 * parry, guard break, equip, combat idle), unarmed combat (guard, jab, cross, hook, uppercut, kick),
 * reactions (light/heavy hit, landing), movement (idle, walk, run, sprint, jump, fall, climb) and
 * agility (dash, roll, sidesteps). They follow the classic principles — anticipation, eased acceleration into the
 * strike, follow-through, counter-rotating hips and torso, weight shift, head keeping its eyes on the
 * target — and carry markers ("Hit", "Parry", "Drawn") for gameplay timing. Right-handed by default.
 *
 * Conventions are in @shared/animation.
 */

type Poses = Partial<Record<Joint, JointPose>>;
type Vec = [number, number, number];

const R = (x: number, y = 0, z = 0): JointPose => ({ rot: [x, y, z] });
const RP = (rot: Vec, pos: Vec): JointPose => ({ rot, pos });

/** A key; `ease`/`dir` shape the motion from this key to the next. */
function key(t: number, poses: Poses, ease: Easing = 'Cubic', dir: EasingDir = 'InOut'): ClipKey {
  const withEase: Poses = {};
  for (const [j, p] of Object.entries(poses) as Array<[Joint, JointPose]>) withEase[j] = { ...p, ease, dir };
  return { t, poses: withEase };
}

/** Overlay: `base` with some joints replaced. */
const over = (base: Poses, patch: Poses): Poses => ({ ...base, ...patch });

/**
 * Points the sword in the right hand (x right, y up, f forward from the character): the wrist is
 * solved from the rest of the pose, so moves are authored by where the blade goes, not wrist angles.
 */
const blade = (poses: Poses, dir: Vec): Poses => ({ ...poses, RightHand: { ...poses.RightHand, rot: aimHand(poses, 'Right', dir) } });

/** Guard: blade forward and up at about 45°, tip slightly toward the centre line. */
const GUARD: Vec = [-0.25, 0.6, 0.76];

// ─── Sword (right hand) ─────────────────────────────────────────────────────

const STANCE_BASE: Poses = {
  LowerTorso: RP([0, -12, 0], [0, -0.18, 0]),
  UpperTorso: R(-6, 14, 0),
  Head: R(4, -8, 0),
  RightUpperArm: R(38, -10, 16),
  RightLowerArm: R(38),
  RightHand: R(12),
  LeftUpperArm: R(22, 8, -14),
  LeftLowerArm: R(52),
  LeftHand: R(6),
  RightUpperLeg: R(20, 8, 3),
  RightLowerLeg: R(-30),
  RightFoot: R(10),
  LeftUpperLeg: R(-8, 12, -5),
  LeftLowerLeg: R(-22),
  LeftFoot: R(12),
};

const BLOCK_BASE: Poses = over(STANCE_BASE, {
  LowerTorso: RP([0, -14, 0], [0, -0.22, 0]),
  UpperTorso: R(-8, 10, 0),
  Head: R(8, -6, 0),
  RightUpperArm: R(88, -20, -12),
  RightLowerArm: R(70),
  RightHand: R(0, 0, -60),
  LeftUpperArm: R(70, 20, 18),
  LeftLowerArm: R(80),
  LeftHand: R(0),
  RightUpperLeg: R(24, 8, 3),
  RightLowerLeg: R(-36),
  LeftUpperLeg: R(-10, 12, -5),
  LeftLowerLeg: R(-28),
});

const STANCE: Poses = blade(STANCE_BASE, GUARD);
/** High guard: blade across in front of the head, pointing left. */
const BLOCK: Poses = blade(BLOCK_BASE, [-0.93, 0.12, 0.35]);

const NEUTRAL: Poses = {
  LowerTorso: RP([0, 0, 0], [0, 0, 0]),
  UpperTorso: R(0),
  Head: R(0),
  RightUpperArm: R(0, 0, 5),
  RightLowerArm: R(6),
  RightHand: R(0),
  LeftUpperArm: R(0, 0, -5),
  LeftLowerArm: R(6),
  LeftHand: R(0),
  RightUpperLeg: R(0),
  RightLowerLeg: R(0),
  RightFoot: R(0),
  LeftUpperLeg: R(0),
  LeftLowerLeg: R(0),
  LeftFoot: R(0),
};

function slash1(): AnimationClip {
  return {
    name: 'SwordSlash1',
    description: 'Combo hit 1: diagonal forehand slash from high right to low left, with a lunge.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.2, name: 'Hit' }],
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.13, blade(over(STANCE, {
        LowerTorso: RP([0, -22, 0], [0.05, -0.22, 0.08]),
        UpperTorso: R(4, -30, 0),
        Head: R(2, 18, 0),
        RightUpperArm: R(150, 0, 40),
        RightLowerArm: R(60),
        RightHand: R(-25),
        LeftUpperArm: R(40, 10, -30),
        LeftLowerArm: R(60),
        RightUpperLeg: R(14, 8, 3),
        RightLowerLeg: R(-24),
        LeftUpperLeg: R(-12, 12, -5),
        LeftLowerLeg: R(-30),
      }), [0.35, 0.45, -0.82]), 'Cubic', 'In'),
      key(0.21, blade(over(STANCE, {
        LowerTorso: RP([-6, 14, 0], [-0.05, -0.32, -0.25]),
        UpperTorso: R(-14, 34, 0),
        Head: R(6, -20, 0),
        RightUpperArm: R(40, 0, -30),
        RightLowerArm: R(8),
        RightHand: R(18),
        LeftUpperArm: R(-12, 0, -28),
        LeftLowerArm: R(35),
        RightUpperLeg: R(34, 8, 3),
        RightLowerLeg: R(-40),
        LeftUpperLeg: R(-22, 12, -5),
        LeftLowerLeg: R(-14),
      }), [-0.55, -0.25, 0.8]), 'Cubic', 'Out'),
      key(0.3, blade(over(STANCE, {
        LowerTorso: RP([-7, 18, 0], [-0.06, -0.34, -0.28]),
        UpperTorso: R(-16, 40, 0),
        Head: R(6, -24, 0),
        RightUpperArm: R(22, 0, -46),
        RightLowerArm: R(14),
        RightHand: R(22),
        LeftUpperArm: R(-14, 0, -30),
        LeftLowerArm: R(35),
        RightUpperLeg: R(34, 8, 3),
        RightLowerLeg: R(-40),
        LeftUpperLeg: R(-22, 12, -5),
        LeftLowerLeg: R(-14),
      }), [-0.85, -0.45, 0.25])),
      key(0.5, STANCE),
    ],
  };
}

function slash2(): AnimationClip {
  return {
    name: 'SwordSlash2',
    description: 'Combo hit 2: backhand slash from left to right.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.18, name: 'Hit' }],
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.12, blade(over(STANCE, {
        LowerTorso: RP([0, 10, 0], [0, -0.2, 0.05]),
        UpperTorso: R(2, 32, 0),
        Head: R(2, -22, 0),
        RightUpperArm: R(75, 0, -45),
        RightLowerArm: R(95),
        RightHand: R(-15),
        LeftUpperArm: R(10, 0, -10),
        LeftLowerArm: R(40),
      }), [-0.55, 0.35, -0.75]), 'Cubic', 'In'),
      key(0.2, blade(fist(over(STANCE, {
        LowerTorso: RP([-5, -20, 0], [0.08, -0.3, -0.22]),
        UpperTorso: R(-12, -30, 0),
        Head: R(4, 20, 0),
        RightUpperArm: R(70, 0, 55),
        RightLowerArm: R(12),
        RightHand: R(10),
        RightUpperLeg: R(30, 8, 3),
        RightLowerLeg: R(-38),
      }), 'Left', [-0.75, 0.3, 1.2]), [0.45, 0, 0.89]), 'Cubic', 'Out'),
      key(0.3, blade(fist(over(STANCE, {
        LowerTorso: RP([-6, -24, 0], [0.09, -0.31, -0.24]),
        UpperTorso: R(-13, -38, 0),
        Head: R(4, 24, 0),
        RightUpperArm: R(60, 0, 72),
        RightLowerArm: R(18),
        RightHand: R(12),
        RightUpperLeg: R(30, 8, 3),
        RightLowerLeg: R(-38),
      }), 'Left', [-0.8, 0.25, 1.1]), [0.95, 0.05, -0.3])),
      key(0.5, STANCE),
    ],
  };
}

function slash3(): AnimationClip {
  return {
    name: 'SwordSlash3',
    description: 'Combo finisher: leaping overhead slam.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.31, name: 'Hit' }],
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.2, over(STANCE, {
        LowerTorso: RP([6, -6, 0], [0, 0.12, 0.1]),
        UpperTorso: R(14, 6, 0),
        Head: R(10),
        RightUpperArm: R(172, 0, 8),
        RightLowerArm: R(40),
        RightHand: R(-30),
        LeftUpperArm: R(150, 0, -20),
        LeftLowerArm: R(50),
        RightUpperLeg: R(10, 8, 3),
        RightLowerLeg: R(-12),
        LeftUpperLeg: R(-4, 12, -5),
        LeftLowerLeg: R(-10),
      }), 'Cubic', 'In'),
      key(0.32, blade(over(STANCE, {
        LowerTorso: RP([-14, 4, 0], [0, -0.55, -0.35]),
        UpperTorso: R(-30, 6, 0),
        Head: R(18),
        RightUpperArm: R(30),
        RightLowerArm: R(6),
        RightHand: R(20),
        LeftUpperArm: R(20, 0, -15),
        LeftLowerArm: R(30),
        RightUpperLeg: R(48, 8, 3),
        RightLowerLeg: R(-70),
        RightFoot: R(22),
        LeftUpperLeg: R(-18, 12, -5),
        LeftLowerLeg: R(-50),
      }), [0, -0.55, 0.83]), 'Cubic', 'Out'),
      key(0.46, blade(over(STANCE, {
        LowerTorso: RP([-13, 4, 0], [0, -0.52, -0.33]),
        UpperTorso: R(-28, 6, 0),
        Head: R(17),
        RightUpperArm: R(32),
        RightLowerArm: R(8),
        RightHand: R(20),
        LeftUpperArm: R(22, 0, -15),
        LeftLowerArm: R(32),
        RightUpperLeg: R(46, 8, 3),
        RightLowerLeg: R(-66),
        RightFoot: R(20),
        LeftUpperLeg: R(-17, 12, -5),
        LeftLowerLeg: R(-48),
      }), [0, -0.6, 0.8])),
      key(0.72, STANCE),
    ],
  };
}

function heavy(): AnimationClip {
  return {
    name: 'SwordHeavy',
    description: 'Charged heavy thrust: draw back, then lunge forward.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.42, name: 'Hit' }],
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.3, blade(over(STANCE, {
        LowerTorso: RP([0, -25, 0], [0.1, -0.25, 0.2]),
        UpperTorso: R(5, -35, 0),
        Head: R(2, 26, 0),
        RightUpperArm: R(70, 0, 30),
        RightLowerArm: R(110),
        RightHand: R(0),
        LeftUpperArm: R(70, 0, -20),
        LeftLowerArm: R(10),
      }), [0.05, 0.1, 0.99]), 'Cubic', 'In'),
      key(0.42, blade(over(STANCE, {
        LowerTorso: RP([-8, 10, 0], [0, -0.35, -0.55]),
        UpperTorso: R(-16, 20, 0),
        Head: R(8, -12, 0),
        RightUpperArm: R(92),
        RightLowerArm: R(0),
        RightHand: R(0),
        LeftUpperArm: R(-20, 0, -20),
        LeftLowerArm: R(30),
        RightUpperLeg: R(55, 8, 3),
        RightLowerLeg: R(-45),
        LeftUpperLeg: R(-30, 12, -5),
        LeftLowerLeg: R(-10),
      }), [0, 0.02, 1]), 'Cubic', 'Out'),
      key(0.55, blade(over(STANCE, {
        LowerTorso: RP([-8, 10, 0], [0, -0.35, -0.52]),
        UpperTorso: R(-15, 18, 0),
        Head: R(8, -11, 0),
        RightUpperArm: R(90),
        RightLowerArm: R(4),
        RightHand: R(2),
        LeftUpperArm: R(-18, 0, -20),
        LeftLowerArm: R(32),
        RightUpperLeg: R(53, 8, 3),
        RightLowerLeg: R(-44),
        LeftUpperLeg: R(-28, 12, -5),
        LeftLowerLeg: R(-12),
      }), [0, 0, 1])),
      key(0.8, STANCE),
    ],
  };
}

function block(): AnimationClip {
  const breathe = blade(over(BLOCK, { UpperTorso: R(-9.5, 10, 0), RightUpperArm: R(89.5, -20, -12), LeftUpperArm: R(71.5, 20, 18) }), [-0.93, 0.12, 0.35]);
  return {
    name: 'SwordBlock',
    description: 'Guard held in front of the body (loops while blocking).',
    loop: true,
    priority: 'Action',
    keys: [key(0, BLOCK), key(0.6, breathe), key(1.2, BLOCK)],
  };
}

function parry(): AnimationClip {
  return {
    name: 'SwordParry',
    description: 'Quick outward deflection.',
    loop: false,
    priority: 'Action2',
    markers: [{ t: 0.06, name: 'Parry' }],
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.07, blade(over(STANCE, { RightUpperArm: R(95, 0, 45), RightLowerArm: R(55), RightHand: R(0, 0, -40), UpperTorso: R(-4, -18, 0), Head: R(4, 10, 0) }), [0.35, 0.85, 0.4]), 'Cubic', 'Out'),
      key(0.16, blade(over(STANCE, { RightUpperArm: R(100, 0, 58), RightLowerArm: R(50), RightHand: R(0, 0, -36), UpperTorso: R(-2, -22, 0), Head: R(4, 12, 0) }), [0.45, 0.8, 0.4])),
      key(0.36, STANCE),
    ],
  };
}

function guardBreak(): AnimationClip {
  return {
    name: 'SwordGuardBreak',
    description: 'Staggered backwards when a block is broken.',
    loop: false,
    priority: 'Action3',
    keys: [
      key(0, BLOCK, 'Cubic', 'Out'),
      key(0.1, blade(over(BLOCK, {
        LowerTorso: RP([10, 12, 0], [0, -0.1, 0.45]),
        UpperTorso: R(20, -12, 6),
        Head: R(18, 10, 0),
        RightUpperArm: R(125, 0, 65),
        RightLowerArm: R(30),
        RightHand: R(0),
        LeftUpperArm: R(110, 0, -70),
        LeftLowerArm: R(25),
        RightUpperLeg: R(-10, 8, 3),
        RightLowerLeg: R(-10),
        LeftUpperLeg: R(25, 12, -5),
        LeftLowerLeg: R(-50),
      }), [0.25, 0.9, -0.35]), 'Cubic', 'Out'),
      key(0.4, blade(over(STANCE, {
        LowerTorso: RP([4, 6, 0], [0, -0.3, 0.5]),
        UpperTorso: R(-10, -6, 4),
        Head: R(-8, 4, 0),
        RightUpperArm: R(40, 0, 40),
        RightLowerArm: R(40),
        LeftUpperArm: R(30, 0, -40),
        LeftLowerArm: R(40),
        RightUpperLeg: R(26, 8, 3),
        RightLowerLeg: R(-44),
        LeftUpperLeg: R(-4, 12, -5),
        LeftLowerLeg: R(-40),
      }), [-0.2, 0.5, 0.85])),
      key(0.85, STANCE),
    ],
  };
}

function equip(): AnimationClip {
  return {
    name: 'SwordEquip',
    description: 'Draws the sword into the combat stance.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.3, name: 'Drawn' }],
    keys: [
      key(0, NEUTRAL, 'Cubic', 'In'),
      key(0.18, over(NEUTRAL, { RightUpperArm: R(-30, 0, 25), RightLowerArm: R(60), UpperTorso: R(0, -15, 0), LowerTorso: RP([0, -6, 0], [0, -0.06, 0]) }), 'Cubic', 'Out'),
      key(0.32, blade(over(STANCE, { RightUpperArm: R(110, 0, 30), RightLowerArm: R(20), RightHand: R(-10) }), [0.2, 0.9, 0.35])),
      key(0.5, STANCE),
    ],
  };
}

function combatIdle(): AnimationClip {
  const inhale = blade(over(STANCE, { UpperTorso: R(-7.5, 14, 0), RightUpperArm: R(40, -10, 17), LeftUpperArm: R(24, 8, -15), LowerTorso: RP([0, -12, 0], [0, -0.16, 0]) }), GUARD);
  return {
    name: 'SwordIdle',
    description: 'Combat stance, breathing (loops while a sword is equipped).',
    loop: true,
    priority: 'Idle',
    keys: [key(0, STANCE), key(1.2, inhale), key(2.4, STANCE)],
  };
}

// ─── Reactions ──────────────────────────────────────────────────────────────

function hitLight(): AnimationClip {
  return {
    name: 'HitLight',
    description: 'Flinch from a light hit.',
    loop: false,
    priority: 'Action2',
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.07, over(STANCE, { UpperTorso: R(12, -14, 4), Head: R(16, 10, -6), LowerTorso: RP([4, -12, 0], [0, -0.2, 0.12]), RightUpperArm: R(30, 0, 30), LeftUpperArm: R(10, 0, -30) }), 'Cubic', 'Out'),
      key(0.4, STANCE),
    ],
  };
}

function hitHeavy(): AnimationClip {
  return {
    name: 'HitHeavy',
    description: 'Knocked back by a heavy hit.',
    loop: false,
    priority: 'Action2',
    keys: [
      key(0, STANCE, 'Cubic', 'Out'),
      key(0.1, over(STANCE, {
        UpperTorso: R(24, -20, 8),
        Head: R(24, 14, -8),
        LowerTorso: RP([8, -8, 0], [0, -0.3, 0.4]),
        RightUpperArm: R(60, 0, 55),
        RightLowerArm: R(30),
        LeftUpperArm: R(50, 0, -55),
        LeftLowerArm: R(30),
        RightUpperLeg: R(4, 8, 3),
        RightLowerLeg: R(-20),
        LeftUpperLeg: R(20, 12, -5),
        LeftLowerLeg: R(-46),
      }), 'Cubic', 'Out'),
      key(0.3, over(STANCE, { UpperTorso: R(6, -6, 2), Head: R(6, 4, -2), LowerTorso: RP([2, -10, 0], [0, -0.26, 0.3]) })),
      key(0.65, STANCE),
    ],
  };
}

function land(): AnimationClip {
  return {
    name: 'Land',
    description: 'Absorbs a landing from a drop or a jump.',
    loop: false,
    priority: 'Action',
    keys: [
      key(0, NEUTRAL, 'Cubic', 'Out'),
      key(0.08, over(NEUTRAL, {
        LowerTorso: RP([-10, 0, 0], [0, -0.6, 0]),
        UpperTorso: R(-12),
        Head: R(14),
        RightUpperArm: R(30, 0, 25),
        LeftUpperArm: R(30, 0, -25),
        RightLowerArm: R(20),
        LeftLowerArm: R(20),
        RightUpperLeg: R(40, 0, 4),
        RightLowerLeg: R(-80),
        RightFoot: R(30),
        LeftUpperLeg: R(40, 0, -4),
        LeftLowerLeg: R(-80),
        LeftFoot: R(30),
      }), 'Cubic', 'Out'),
      key(0.45, NEUTRAL),
    ],
  };
}

// ─── Movement ───────────────────────────────────────────────────────────────

/** A locomotion cycle from its right-foot-forward contact pose and passing pose; the rest is mirrored. */
function cycle(name: string, description: string, period: number, contact: Poses, passing: Poses, priority: Priority = 'Movement'): AnimationClip {
  const flip = (p: Poses): Poses => mirrorClip({ name: 'x', loop: false, priority, keys: [{ t: 0, poses: p }] }).keys[0]!.poses;
  return {
    name,
    description,
    loop: true,
    priority,
    keys: [key(0, contact), key(period * 0.25, passing), key(period * 0.5, flip(contact)), key(period * 0.75, flip(passing)), key(period, contact)],
  };
}

function walk(): AnimationClip {
  return cycle(
    'Walk',
    'Relaxed walk cycle.',
    1.0,
    {
      LowerTorso: RP([0, 5, 0], [0, -0.1, 0]),
      UpperTorso: R(-2, -8, 0),
      Head: R(2, 3, 0),
      RightUpperLeg: R(26),
      RightLowerLeg: R(-8),
      RightFoot: R(12),
      LeftUpperLeg: R(-20),
      LeftLowerLeg: R(-14),
      LeftFoot: R(-14),
      RightUpperArm: R(-16, 0, 6),
      RightLowerArm: R(14),
      LeftUpperArm: R(20, 0, -6),
      LeftLowerArm: R(18),
    },
    {
      LowerTorso: RP([0, 0, 0], [0, 0.06, 0]),
      UpperTorso: R(-2, 0, 0),
      Head: R(2, 0, 0),
      RightUpperLeg: R(2),
      RightLowerLeg: R(-6),
      RightFoot: R(0),
      LeftUpperLeg: R(6),
      LeftLowerLeg: R(-48),
      LeftFoot: R(-6),
      RightUpperArm: R(0, 0, 6),
      RightLowerArm: R(14),
      LeftUpperArm: R(2, 0, -6),
      LeftLowerArm: R(14),
    },
  );
}

function run(): AnimationClip {
  return cycle(
    'Run',
    'Jogging run cycle.',
    0.7,
    {
      LowerTorso: RP([-4, 8, 0], [0, -0.12, 0]),
      UpperTorso: R(-10, -12, 0),
      Head: R(8, 4, 0),
      RightUpperLeg: R(48),
      RightLowerLeg: R(-24),
      RightFoot: R(14),
      LeftUpperLeg: R(-32),
      LeftLowerLeg: R(-40),
      LeftFoot: R(-22),
      RightUpperArm: R(-38, 0, 8),
      RightLowerArm: R(80),
      LeftUpperArm: R(42, 0, -8),
      LeftLowerArm: R(85),
    },
    {
      LowerTorso: RP([-4, 0, 0], [0, 0.14, 0]),
      UpperTorso: R(-10, 0, 0),
      Head: R(8, 0, 0),
      RightUpperLeg: R(10),
      RightLowerLeg: R(-30),
      RightFoot: R(0),
      LeftUpperLeg: R(30),
      LeftLowerLeg: R(-95),
      LeftFoot: R(-10),
      RightUpperArm: R(0, 0, 8),
      RightLowerArm: R(82),
      LeftUpperArm: R(4, 0, -8),
      LeftLowerArm: R(82),
    },
  );
}

function sprint(): AnimationClip {
  return cycle(
    'Sprint',
    'Full sprint: strong lean and arm drive.',
    0.56,
    {
      LowerTorso: RP([-6, 10, 0], [0, -0.14, 0]),
      UpperTorso: R(-16, -14, 0),
      Head: R(14, 5, 0),
      RightUpperLeg: R(58),
      RightLowerLeg: R(-30),
      RightFoot: R(16),
      LeftUpperLeg: R(-40),
      LeftLowerLeg: R(-50),
      LeftFoot: R(-28),
      RightUpperArm: R(-50, 0, 8),
      RightLowerArm: R(92),
      LeftUpperArm: R(56, 0, -8),
      LeftLowerArm: R(92),
    },
    {
      LowerTorso: RP([-6, 0, 0], [0, 0.18, 0]),
      UpperTorso: R(-16, 0, 0),
      Head: R(14, 0, 0),
      RightUpperLeg: R(12),
      RightLowerLeg: R(-34),
      RightFoot: R(0),
      LeftUpperLeg: R(36),
      LeftLowerLeg: R(-110),
      LeftFoot: R(-12),
      RightUpperArm: R(0, 0, 8),
      RightLowerArm: R(92),
      LeftUpperArm: R(4, 0, -8),
      LeftLowerArm: R(92),
    },
  );
}

function idle(): AnimationClip {
  const a: Poses = { UpperTorso: R(-1), Head: R(0), RightUpperArm: R(0, 0, 5), LeftUpperArm: R(0, 0, -5), RightLowerArm: R(8), LeftLowerArm: R(8), LowerTorso: RP([0, 0, 0], [0, 0, 0]) };
  const b: Poses = { UpperTorso: R(1.2), Head: R(1, -1.5, 0), RightUpperArm: R(0, 0, 6.5), LeftUpperArm: R(0, 0, -6.5), RightLowerArm: R(9), LeftLowerArm: R(9), LowerTorso: RP([0, 0, 0], [0, 0.03, 0]) };
  return { name: 'Idle', description: 'Relaxed standing idle with breathing.', loop: true, priority: 'Idle', keys: [key(0, a), key(1.6, b), key(3.2, a)] };
}

// ─── Air and climbing ───────────────────────────────────────────────────────

function jump(): AnimationClip {
  const takeoff: Poses = {
    LowerTorso: RP([-6, 0, 0], [0, 0, 0]),
    UpperTorso: R(-4),
    Head: R(8),
    RightUpperArm: R(70, 0, 12),
    RightLowerArm: R(24),
    LeftUpperArm: R(70, 0, -12),
    LeftLowerArm: R(24),
    RightUpperLeg: R(-2),
    RightLowerLeg: R(-4),
    RightFoot: R(-8),
    LeftUpperLeg: R(-4),
    LeftLowerLeg: R(-6),
    LeftFoot: R(-10),
  };
  const rise: Poses = {
    LowerTorso: RP([0, 0, 0], [0, 0.1, 0]),
    UpperTorso: R(2),
    Head: R(6),
    RightUpperArm: R(155, 0, 22),
    RightLowerArm: R(20),
    LeftUpperArm: R(150, 0, -24),
    LeftLowerArm: R(24),
    RightUpperLeg: R(38),
    RightLowerLeg: R(-62),
    RightFoot: R(-8),
    LeftUpperLeg: R(12),
    LeftLowerLeg: R(-34),
    LeftFoot: R(-14),
  };
  return {
    name: 'Jump',
    description: 'Takeoff into a rising pose, arms swinging up (Roblox switches to Fall on the way down).',
    loop: false,
    priority: 'Movement',
    keys: [key(0, takeoff, 'Cubic', 'Out'), key(0.18, rise, 'Cubic', 'Out'), key(0.4, over(rise, { RightUpperArm: R(148, 0, 26), LeftUpperArm: R(142, 0, -28) }))],
  };
}

function fall(): AnimationClip {
  const a: Poses = {
    LowerTorso: RP([6, 0, 0], [0, 0, 0]),
    UpperTorso: R(4),
    Head: R(-12),
    RightUpperArm: R(-10, 0, 105),
    RightLowerArm: R(30),
    LeftUpperArm: R(-10, 0, -100),
    LeftLowerArm: R(34),
    RightUpperLeg: R(24, 0, 8),
    RightLowerLeg: R(-40),
    RightFoot: R(-6),
    LeftUpperLeg: R(8, 0, -8),
    LeftLowerLeg: R(-26),
    LeftFoot: R(-10),
  };
  const b = over(a, {
    RightUpperArm: R(-14, 0, 116),
    RightLowerArm: R(22),
    LeftUpperArm: R(-14, 0, -112),
    LeftLowerArm: R(26),
    RightUpperLeg: R(12, 0, 8),
    RightLowerLeg: R(-28),
    LeftUpperLeg: R(20, 0, -8),
    LeftLowerLeg: R(-40),
  });
  return { name: 'Fall', description: 'Falling: arms out for balance, legs ready to land. Loops.', loop: true, priority: 'Movement', keys: [key(0, a), key(0.45, b), key(0.9, a)] };
}

function climb(): AnimationClip {
  return cycle(
    'Climb',
    'Climbing a ladder or truss: hands reach up in turn while the opposite knee steps up. Loops.',
    1.0,
    {
      LowerTorso: RP([-4, 0, 0], [0, 0, 0]),
      UpperTorso: R(-2),
      Head: R(18),
      RightUpperArm: R(160, 0, 12),
      RightLowerArm: R(24),
      LeftUpperArm: R(100, 0, -14),
      LeftLowerArm: R(80),
      LeftUpperLeg: R(72, 0, -4),
      LeftLowerLeg: R(-96),
      LeftFoot: R(18),
      RightUpperLeg: R(12, 0, 4),
      RightLowerLeg: R(-24),
      RightFoot: R(-6),
    },
    {
      LowerTorso: RP([-4, 0, 0], [0, 0.08, 0]),
      UpperTorso: R(-2),
      Head: R(16),
      RightUpperArm: R(128, 0, 12),
      RightLowerArm: R(56),
      LeftUpperArm: R(132, 0, -12),
      LeftLowerArm: R(52),
      LeftUpperLeg: R(40, 0, -4),
      LeftLowerLeg: R(-60),
      LeftFoot: R(8),
      RightUpperLeg: R(44, 0, 4),
      RightLowerLeg: R(-64),
      RightFoot: R(6),
    },
  );
}

// ─── Agility (pair with a short velocity push in code) ─────────────────────

function dash(): AnimationClip {
  const burst: Poses = {
    LowerTorso: RP([-22, 0, 0], [0, -0.3, -0.1]),
    UpperTorso: R(-14, -6, 0),
    Head: R(30, 4, 0),
    RightUpperArm: R(-40, 0, 18),
    RightLowerArm: R(24),
    LeftUpperArm: R(-44, 0, -18),
    LeftLowerArm: R(28),
    RightUpperLeg: R(64, 0, 4),
    RightLowerLeg: R(-76),
    RightFoot: R(14),
    LeftUpperLeg: R(-18, 0, -4),
    LeftLowerLeg: R(-40),
    LeftFoot: R(-24),
  };
  return {
    name: 'Dash',
    description: 'Burst forward: a low lean with the arms swept back, then recover.',
    loop: false,
    priority: 'Action',
    keys: [
      key(0, NEUTRAL, 'Cubic', 'Out'),
      key(0.06, burst, 'Linear'),
      key(0.26, over(burst, { LowerTorso: RP([-18, 0, 0], [0, -0.26, -0.1]), Head: R(26, 4, 0) }), 'Cubic', 'InOut'),
      key(0.45, NEUTRAL),
    ],
  };
}

/** A tucked ball, turned `pitch` degrees forward about the hips. */
const tuck = (pitch: number, pos: Vec): Poses => ({
  LowerTorso: RP([pitch, 0, 0], pos),
  UpperTorso: R(-50),
  Head: R(-45),
  RightUpperArm: R(80, 0, 25),
  RightLowerArm: R(110),
  LeftUpperArm: R(80, 0, -25),
  LeftLowerArm: R(110),
  RightUpperLeg: R(150, 0, 6),
  RightLowerLeg: R(-130),
  RightFoot: R(-10),
  LeftUpperLeg: R(150, 0, -6),
  LeftLowerLeg: R(-130),
  LeftFoot: R(-10),
});

/**
 * The tuck at `pitch`, moved so the ball touches the floor with its centre over the root: the body turns
 * about the hips, not its middle, so every key carries the offset that makes it roll instead of swing.
 */
function rolling(pitch: number): Poses {
  const f = solveRig(tuck(pitch, [0, 0, 0]));
  let low = Infinity;
  let z = 0;
  let n = 0;
  for (const j of JOINTS) {
    const [sx, sy, sz] = R15_RIG.sizes[j].map((v) => v / 2) as Vec;
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
      const p = xfPoint(f[j], [a * sx, b * sy, c * sz]);
      low = Math.min(low, p[1]);
      z += p[2];
      n++;
    }
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return tuck(pitch, [0, r(REST_FOOT_LOW - low + 0.05), r(-z / n)]);
}

function roll(): AnimationClip {
  // Diving in stays above the floor too (in-betweens where the folding legs would dip through it).
  const dive = groundClip({ name: 'Dive', loop: false, priority: 'Action', keys: [key(0, NEUTRAL, 'Linear'), key(0.12, rolling(-30), 'Linear')] }).keys;
  const turn: ClipKey[] = [];
  for (let i = 2; i <= 12; i++) turn.push(key(0.12 + (i - 1) * 0.03, rolling(-30 * i), 'Linear'));
  const crouch = over(NEUTRAL, {
    LowerTorso: RP([-14, 0, 0], [0, -0.95, 0.1]),
    UpperTorso: R(-16),
    Head: R(18),
    RightUpperArm: R(40, 0, 14),
    RightLowerArm: R(40),
    LeftUpperArm: R(40, 0, -14),
    LeftLowerArm: R(40),
    RightUpperLeg: R(70, 0, 6),
    RightLowerLeg: R(-100),
    RightFoot: R(40),
    LeftUpperLeg: R(70, 0, -6),
    LeftLowerLeg: R(-100),
    LeftFoot: R(40),
  });
  // Coming up: the crouch and the stand stay on the floor (legs bend to fit, in-betweens where needed).
  const standUp = groundClip({ name: 'StandUp', loop: false, priority: 'Action', keys: [key(0, crouch, 'Cubic', 'InOut'), key(0.22, NEUTRAL)] }).keys;
  return {
    name: 'DodgeRoll',
    description: 'Forward roll: dives into a tuck, turns once over and comes up in a crouch.',
    loop: false,
    priority: 'Action',
    keys: [...dive, ...turn, ...standUp.map((k) => ({ ...k, t: Math.round((k.t + 0.54) * 1000) / 1000 }))],
  };
}

function sidestep(): AnimationClip {
  return {
    name: 'DodgeRight',
    description: 'Quick hop to the right, leaning into it (DodgeLeft is the mirror).',
    loop: false,
    priority: 'Action',
    keys: [
      key(0, NEUTRAL, 'Cubic', 'Out'),
      key(0.07, over(NEUTRAL, {
        LowerTorso: RP([-4, 0, -14], [0, -0.3, 0]),
        UpperTorso: R(-4, 0, 6),
        Head: R(2, 0, 8),
        RightUpperArm: R(16, 0, 40),
        RightLowerArm: R(30),
        LeftUpperArm: R(24, 0, -34),
        LeftLowerArm: R(40),
        RightUpperLeg: R(16, 0, 26),
        RightLowerLeg: R(-34),
        RightFoot: R(4),
        LeftUpperLeg: R(8, 0, -8),
        LeftLowerLeg: R(-30),
        LeftFoot: R(-12),
      }), 'Linear'),
      key(0.24, over(NEUTRAL, {
        LowerTorso: RP([-6, 0, -8], [0, -0.42, 0]),
        UpperTorso: R(-6, 0, 4),
        Head: R(4, 0, 6),
        RightUpperArm: R(20, 0, 28),
        RightLowerArm: R(34),
        LeftUpperArm: R(26, 0, -26),
        LeftLowerArm: R(38),
        RightUpperLeg: R(24, 0, 14),
        RightLowerLeg: R(-48),
        RightFoot: R(14),
        LeftUpperLeg: R(20, 0, -16),
        LeftLowerLeg: R(-36),
        LeftFoot: R(6),
      }), 'Cubic', 'InOut'),
      key(0.42, NEUTRAL),
    ],
  };
}

const sidestepLeft = (): AnimationClip => ({ ...mirrorClip(sidestep(), 'DodgeLeft'), description: 'Quick hop to the left, leaning into it (DodgeRight is the mirror).' });

// ─── Unarmed (orthodox guard: left side forward) ────────────────────────────

/** Puts a hand (fist) at a point — x right, y up, f forward from the character, studs — solving the arm. */
function fist(poses: Poses, side: 'Left' | 'Right', at: Vec, elbow?: ElbowHint): Poses {
  const s = reachHand(poses, side, at, elbow);
  return { ...poses, [`${side}UpperArm`]: { ...poses[`${side}UpperArm`], rot: s.upper }, [`${side}LowerArm`]: { ...poses[`${side}LowerArm`], rot: s.lower } };
}

/** Guard: lead (left) fist forward at eye height, rear (right) fist by the chin. */
const LEAD_GUARD: Vec = [-0.25, 1.15, 1.25];
const REAR_GUARD: Vec = [0.45, 1.05, 0.8];
const guard = (poses: Poses, lead: Vec = LEAD_GUARD, rear: Vec = REAR_GUARD): Poses => fist(fist(poses, 'Left', lead), 'Right', rear);

const FIST_BASE: Poses = {
  LowerTorso: RP([0, -22, 0], [0, -0.2, 0]),
  UpperTorso: R(-8, -6, 0),
  Head: R(6, 26, 0),
  RightHand: R(-10),
  LeftHand: R(-10),
  LeftUpperLeg: R(20, 14, -6),
  LeftLowerLeg: R(-26),
  LeftFoot: R(6),
  RightUpperLeg: R(-16, 16, 6),
  RightLowerLeg: R(-26),
  RightFoot: R(14),
};
const FIST: Poses = guard(FIST_BASE);

/**
 * Keeps feet where the guard stance put them while the hips turn and dip: flat on the floor, or for
 * `pivot` feet (a heel lifting as the punch turns through) in place but at their authored angle.
 */
function planted(poses: Poses, sides: Array<'Left' | 'Right'> = ['Left', 'Right'], pivot: Array<'Left' | 'Right'> = []): Poses {
  const stance = solveRig(FIST);
  let out = poses;
  for (const side of sides) {
    if (pivot.includes(side)) {
      const p = stance[`${side}Foot`].p;
      const s = reachFoot(out, side, [p[0], p[1], -p[2]]);
      out = { ...out, [`${side}UpperLeg`]: { ...out[`${side}UpperLeg`], rot: s.upper }, [`${side}LowerLeg`]: { ...out[`${side}LowerLeg`], rot: s.lower } };
    } else {
      const s = plantFoot(out, side, stance);
      out = { ...out, [`${side}UpperLeg`]: { ...out[`${side}UpperLeg`], rot: s.upper }, [`${side}LowerLeg`]: { ...out[`${side}LowerLeg`], rot: s.lower }, [`${side}Foot`]: { ...out[`${side}Foot`], rot: s.foot } };
    }
  }
  return out;
}

function fistIdle(): AnimationClip {
  const inhale = guard(over(FIST_BASE, { UpperTorso: R(-9.5, -6, 0), LowerTorso: RP([0, -22, 0], [0, -0.17, 0]) }), [-0.25, 1.2, 1.25], [0.45, 1.1, 0.8]);
  return { name: 'FistIdle', description: 'Fighting guard with fists up, breathing (loops while fighting unarmed).', loop: true, priority: 'Idle', keys: [key(0, FIST), key(1, inhale), key(2, FIST)] };
}

/** High guard: both forearms up in front of the face, elbows down, chin tucked (the battlegrounds block). */
const BLOCK_HANDS: [Vec, Vec] = [[-0.26, 1.52, 0.95], [0.26, 1.5, 0.9]];
const FIST_BLOCK_BASE: Poses = over(FIST_BASE, {
  LowerTorso: RP([0, -12, 0], [0, -0.28, 0]),
  UpperTorso: R(-14, -4, 0),
  Head: R(14, 12, 0),
  RightHand: R(-20),
  LeftHand: R(-20),
});

function fistBlock(): AnimationClip {
  const held = planted(guard(FIST_BLOCK_BASE, ...BLOCK_HANDS));
  const breathe = planted(guard(over(FIST_BLOCK_BASE, { UpperTorso: R(-15.5, -4, 0), LowerTorso: RP([0, -12, 0], [0, -0.25, 0]) }), [-0.26, 1.56, 0.95], [0.26, 1.54, 0.9]));
  return {
    name: 'FistBlock',
    description: 'Unarmed block: both forearms up in front of the face, chin tucked (loops while blocking).',
    loop: true,
    priority: 'Action',
    keys: [key(0, held), key(0.6, breathe), key(1.2, held)],
  };
}

function jab(): AnimationClip {
  return {
    name: 'PunchJab',
    description: 'Combo hit 1: fast lead-hand (left) jab from the guard.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.09, name: 'Hit' }],
    keys: [
      key(0, FIST, 'Cubic', 'In'),
      key(0.09, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([0, -30, 0], [0, -0.22, -0.12]),
        UpperTorso: R(-8, -14, 0),
        Head: R(6, 40, 0),
        LeftHand: R(0),
      }), [-0.05, 1.2, 2.45])), 'Cubic', 'Out'),
      key(0.28, FIST),
    ],
  };
}

function cross(): AnimationClip {
  return {
    name: 'PunchCross',
    description: 'Combo hit 2: rear-hand (right) straight, hips and shoulders turning through, back heel lifting.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.13, name: 'Hit' }],
    keys: [
      key(0, FIST, 'Cubic', 'In'),
      key(0.05, planted(guard(over(FIST_BASE, { LowerTorso: RP([0, -26, 0], [0, -0.26, 0]), UpperTorso: R(-8, -10, 0) }))), 'Cubic', 'In'),
      key(0.13, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([0, 16, 0], [0, -0.24, -0.2]),
        UpperTorso: R(-10, 20, 0),
        Head: R(6, -30, 0),
        RightHand: R(0),
        RightFoot: R(-20),
      }), [-0.35, 1.1, 0.9], [0.05, 1.2, 2.5]), ['Left', 'Right'], ['Right']), 'Cubic', 'Out'),
      key(0.4, FIST),
    ],
  };
}

function hook(): AnimationClip {
  return {
    name: 'PunchHook',
    description: 'Combo hit 3: lead-hand (left) hook — loads by opening the hips, then snaps them round so the bent arm swings across.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.15, name: 'Hit' }],
    keys: [
      key(0, FIST, 'Cubic', 'In'),
      key(0.07, planted(fist(guard(over(FIST_BASE, {
        LowerTorso: RP([0, -10, 0], [0, -0.26, 0]),
        UpperTorso: R(-8, 6, 0),
        Head: R(6, 4, 0),
      })), 'Left', [-1.0, 1.15, 0.9], 'out')), 'Cubic', 'In'),
      key(0.15, planted(fist(guard(over(FIST_BASE, {
        LowerTorso: RP([0, -40, 0], [0, -0.26, -0.1]),
        UpperTorso: R(-8, -22, 0),
        Head: R(6, 56, 0),
        LeftHand: R(0),
        LeftFoot: R(-8),
      })), 'Left', [0.2, 1.3, 1.8], 'high')), 'Cubic', 'Out'),
      key(0.42, FIST),
    ],
  };
}

function uppercut(): AnimationClip {
  return {
    name: 'PunchUppercut',
    description: 'Combo finisher: dips, then drives the rear hand (right) up through the chin, rising onto the toes.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.2, name: 'Hit' }],
    keys: [
      key(0, FIST, 'Cubic', 'Out'),
      key(0.1, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([-4, -10, 0], [0, -0.55, 0]),
        UpperTorso: R(-16, 14, 0),
        Head: R(12, 0, 0),
      }), LEAD_GUARD, [0.55, 0.25, 0.85])), 'Cubic', 'In'),
      key(0.2, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([6, -8, 0], [0, -0.12, -0.1]),
        UpperTorso: R(6, 38, 0),
        Head: R(10, -22, 0),
        RightHand: R(10),
        RightFoot: R(-24),
        LeftFoot: R(-14),
      }), [-0.4, 1.2, 0.9], [0.15, 1.8, 1.35]), ['Left', 'Right'], ['Left', 'Right']), 'Cubic', 'Out'),
      key(0.55, FIST),
    ],
  };
}

function kick(): AnimationClip {
  return {
    name: 'Kick',
    description: 'Front push kick with the rear (right) leg: chamber, extend, re-chamber.',
    loop: false,
    priority: 'Action',
    markers: [{ t: 0.22, name: 'Hit' }],
    keys: [
      key(0, FIST, 'Cubic', 'Out'),
      key(0.12, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([6, -12, 0], [0, -0.24, 0.05]),
        UpperTorso: R(-4, -2, 0),
        Head: R(0, 12, 0),
        RightUpperLeg: R(96, 0, -8),
        RightLowerLeg: R(-110),
        RightFoot: R(10),
      })), ['Left']), 'Cubic', 'Out'),
      key(0.22, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([10, -10, 0], [0, -0.24, 0.12]),
        UpperTorso: R(2, 0, 0),
        Head: R(-4, 8, 0),
        RightUpperLeg: R(90, 0, -12),
        RightLowerLeg: R(-6),
        RightFoot: R(20),
      }), [-0.5, 1.2, 0.9], [0.7, 1.0, 0.5]), ['Left']), 'Cubic', 'InOut'),
      key(0.34, planted(guard(over(FIST_BASE, {
        LowerTorso: RP([6, -12, 0], [0, -0.24, 0.05]),
        RightUpperLeg: R(80, 0, -8),
        RightLowerLeg: R(-100),
        RightFoot: R(10),
      })), ['Left']), 'Cubic', 'InOut'),
      key(0.56, FIST),
    ],
  };
}

// ─── Registry ───────────────────────────────────────────────────────────────

export interface PresetInfo {
  id: string;
  category: 'combat' | 'unarmed' | 'reaction' | 'movement';
  description: string;
  loop: boolean;
  duration: number;
  markers: string[];
}

const BUILDERS: Record<string, { category: PresetInfo['category']; build: () => AnimationClip }> = {
  SwordSlash1: { category: 'combat', build: slash1 },
  SwordSlash2: { category: 'combat', build: slash2 },
  SwordSlash3: { category: 'combat', build: slash3 },
  SwordHeavy: { category: 'combat', build: heavy },
  SwordBlock: { category: 'combat', build: block },
  SwordParry: { category: 'combat', build: parry },
  SwordGuardBreak: { category: 'combat', build: guardBreak },
  SwordEquip: { category: 'combat', build: equip },
  SwordIdle: { category: 'combat', build: combatIdle },
  FistIdle: { category: 'unarmed', build: fistIdle },
  FistBlock: { category: 'unarmed', build: fistBlock },
  PunchJab: { category: 'unarmed', build: jab },
  PunchCross: { category: 'unarmed', build: cross },
  PunchHook: { category: 'unarmed', build: hook },
  PunchUppercut: { category: 'unarmed', build: uppercut },
  Kick: { category: 'unarmed', build: kick },
  HitLight: { category: 'reaction', build: hitLight },
  HitHeavy: { category: 'reaction', build: hitHeavy },
  Land: { category: 'reaction', build: land },
  Idle: { category: 'movement', build: idle },
  Walk: { category: 'movement', build: walk },
  Run: { category: 'movement', build: run },
  Sprint: { category: 'movement', build: sprint },
  Jump: { category: 'movement', build: jump },
  Fall: { category: 'movement', build: fall },
  Climb: { category: 'movement', build: climb },
  Dash: { category: 'movement', build: dash },
  DodgeRoll: { category: 'movement', build: roll },
  DodgeRight: { category: 'movement', build: sidestep },
  DodgeLeft: { category: 'movement', build: sidestepLeft },
};

/** Built presets, kept: some are solved by kinematics (fists, the roll), which takes a moment. */
const built = new Map<string, AnimationClip>();
function base(id: string): AnimationClip | undefined {
  const b = BUILDERS[id];
  if (!b) return undefined;
  let c = built.get(id);
  if (!c) built.set(id, (c = b.build()));
  return structuredClone(c);
}

export function listPresets(): PresetInfo[] {
  return Object.entries(BUILDERS).map(([id, b]) => {
    const c = base(id)!;
    return { id, category: b.category, description: c.description ?? '', loop: c.loop, duration: clipDuration(c), markers: (c.markers ?? []).map((m) => m.name) };
  });
}

export interface PresetParams {
  /** 0.5–1.5: smaller or bigger motion. */
  intensity?: number;
  /** 0.5–2: slower or faster. */
  speed?: number;
  /** Mirror for a left-handed character. */
  hand?: 'right' | 'left';
  /** Keep the feet on the ground (default true; false for Jump, Fall, Climb and DodgeRoll). */
  ground?: boolean;
}

/** Movement that never leaves the ground: the lowest foot stays planted. */
const PLANTED = new Set(['Idle', 'Walk', 'Kick']);
/** Clips played in the air or on a wall, and the roll (tuned by hand): no floor to keep the feet out of. */
export const AIRBORNE = new Set(['Jump', 'Fall', 'Climb', 'DodgeRoll']);
/** Locomotion: feet are kept out of the floor by the hips (legs keep their stride). */
const LOCOMOTION = new Set(['Idle', 'Walk', 'Run', 'Sprint']);

/** A preset as a clip, named `name`, with the motion scaled and retimed and optionally mirrored. */
export function buildPreset(id: string, name: string, params: PresetParams = {}): AnimationClip {
  let c = base(id);
  if (!c) throw new Error(`Unknown preset "${id}". Presets: ${Object.keys(BUILDERS).join(', ')}`);
  const k = Math.min(1.5, Math.max(0.5, params.intensity ?? 1));
  const s = Math.min(2, Math.max(0.5, params.speed ?? 1));
  c = {
    ...c,
    name,
    keys: c.keys.map((key) => ({
      t: Math.round((key.t / s) * 1000) / 1000,
      poses: Object.fromEntries(
        Object.entries(key.poses).map(([j, p]) => [j, { ...p, rot: p!.rot?.map((v) => v * k) as Vec | undefined, pos: p!.pos?.map((v) => v * k) as Vec | undefined }]),
      ) as ClipKey['poses'],
    })),
    markers: c.markers?.map((m) => ({ ...m, t: Math.round((m.t / s) * 1000) / 1000 })),
  };
  if (params.ground ?? !AIRBORNE.has(id)) c = groundClip(c, { plant: PLANTED.has(id), fix: LOCOMOTION.has(id) ? 'hips' : 'legs' });
  return params.hand === 'left' ? mirrorClip(c, name) : c;
}
