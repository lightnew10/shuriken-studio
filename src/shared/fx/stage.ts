import type { Vec3 } from '../curves';
import type { EffectSpec } from '../effects';
import type { FxBounds, FxLight, FxSolid } from './sim';
import { I3, vadd, vcross, vmul, vnorm, vsub } from './math';

/**
 * The stage an effect is shown on: a floor with a 4-stud grid under a sky, by day (grass under a bright
 * sky, like a Roblox baseplate: where additive colours wash out) or in the dark (where everything
 * glows). The three.js preview and the software renderer shade it with the same numbers.
 */
export interface FxStage {
  name: 'day' | 'dark';
  skyTop: Vec3;
  skyHorizon: Vec3;
  floor: Vec3;
  /** How much darker the grid lines are (0..1). */
  grid: number;
  /** Light on surfaces facing away from the sun, and the sun's share. */
  ambient: number;
  sun: number;
  /** How bright scene-lit particles (LightInfluence 1) come out. */
  lit: number;
}

export const STAGES: Record<FxStage['name'], FxStage> = {
  day: { name: 'day', skyTop: [0.36, 0.6, 0.93], skyHorizon: [0.78, 0.88, 0.97], floor: [0.33, 0.55, 0.27], grid: 0.1, ambient: 0.62, sun: 0.5, lit: 1 },
  dark: { name: 'dark', skyTop: [0.075, 0.068, 0.064], skyHorizon: [0.12, 0.108, 0.1], floor: [0.14, 0.125, 0.11], grid: 0.22, ambient: 0.42, sun: 0.4, lit: 0.62 },
};

export const SUN: Vec3 = vnorm([-0.45, 0.8, 0.4]);

/**
 * Bloom, roughly as a Roblox place has it: light brighter than white (`threshold`; layers adding up, or
 * Brightness above 1), up to `most` above it, is blurred (a gaussian whose sigma is `radius` of the picture's
 * height) and comes back at `strength`. Both renderers use these numbers.
 */
export const BLOOM = { threshold: 1, most: 2.5, radius: 0.03, strength: 0.6 };
/** Floor grid spacing in studs. */
export const GRID_STUDS = 4;

/** A light's share at a distance: full at its centre, none at its range. */
export const lightFalloff = (distance: number, range: number) => {
  const k = Math.max(0, 1 - distance / Math.max(range, 1e-3));
  return k * k;
};

/** How much of a light's colour the floor takes at its centre, from its Brightness. */
export const lightStrength = (brightness: number) => Math.min(brightness, 12) * 0.09;
/** How strongly the grid shows where a pixel spans `pixelStuds` studs: all of it up close, none once a square is under 6 pixels. */
export const gridFade = (pixelStuds: number) => Math.min(1, Math.max(0, (GRID_STUDS / Math.max(pixelStuds, 1e-6) - 6) / 18));

/** The floor's colour at a point: the stage's colour, its grid, and the effect's lights on it. */
export function floorColor(stage: FxStage, x: number, z: number, y: number, lights: FxLight[], pixelStuds: number): Vec3 {
  // Grid lines one pixel wide at least, gone where a square is smaller than a few pixels.
  const w = Math.max(0.04, pixelStuds * 0.75);
  const gx = Math.abs(((x / GRID_STUDS + 0.5) % 1 + 1) % 1 - 0.5) * GRID_STUDS;
  const gz = Math.abs(((z / GRID_STUDS + 0.5) % 1 + 1) % 1 - 0.5) * GRID_STUDS;
  const line = Math.min(gx, gz) < w ? stage.grid * gridFade(pixelStuds) : 0;
  let r = stage.floor[0] * (1 - line);
  let g = stage.floor[1] * (1 - line);
  let b = stage.floor[2] * (1 - line);
  for (const l of lights) {
    const k = lightFalloff(Math.hypot(x - l.p[0], y - l.p[1], z - l.p[2]), l.range) * lightStrength(l.brightness);
    if (k <= 0) continue;
    // A light brightens the floor's own colour and adds a little of its own.
    r += (stage.floor[0] * 1.6 + 0.12) * l.color[0] * k;
    g += (stage.floor[1] * 1.6 + 0.12) * l.color[1] * k;
    b += (stage.floor[2] * 1.6 + 0.12) * l.color[2] * k;
  }
  return [r, g, b];
}

/** The sky's colour for a view direction's height (-1 down … 1 up). */
export const skyColor = (stage: FxStage, dirY: number): Vec3 => {
  const k = Math.min(1, Math.max(0, dirY * 1.6));
  return [stage.skyHorizon[0] + (stage.skyTop[0] - stage.skyHorizon[0]) * k, stage.skyHorizon[1] + (stage.skyTop[1] - stage.skyHorizon[1]) * k, stage.skyHorizon[2] + (stage.skyTop[2] - stage.skyHorizon[2]) * k];
};

export interface FxPlacement {
  /** How high above the floor the effect plays (a character's root is 3 studs up). */
  height: number;
  /** A character stands where it plays (auras, and tracks that act on a target). */
  dummy: boolean;
}

/**
 * Where an effect is shown: on a character (persistent effects, and ones with a highlight or hit-stop),
 * on the ground (it lays a decal, throws debris, or draws a flat ring or circle at its own height), else
 * at a character's height in the air, as a hit plays.
 */
export function placementOf(spec: EffectSpec): FxPlacement {
  const tracks = spec.tracks ?? [];
  const dummy = spec.kind === 'persistent' || tracks.some((t) => t.type === 'highlight' || t.type === 'hitstop');
  if (dummy || spec.kind === 'trail' || spec.kind === 'beam') return { height: 3, dummy };
  const level = (t: { offset?: [number, number, number]; rotation?: [number, number, number] }) => Math.abs(t.offset?.[1] ?? 0) < 0.5 && !(t.rotation && (Math.abs(t.rotation[0]) > 1 || Math.abs(t.rotation[2]) > 1));
  const ground = tracks.some((t) => (t.type === 'decal' && t.ground !== false) || t.type === 'debris' || (t.type === 'circle' && level(t)) || (t.type === 'ring' && (t.facing ?? 'Top') === 'Top' && level(t)));
  return { height: ground ? 0.05 : 3, dummy: false };
}

/** A blocky character 5 studs tall, its root at `root`: the target effects play on, and a sense of scale. */
export function dummySolids(root: Vec3, tint?: { color: Vec3; fill: number }): FxSolid[] {
  const base: Vec3 = [0.6, 0.6, 0.63];
  const k = tint ? Math.min(1, Math.max(0, tint.fill)) : 0;
  const color: Vec3 = tint ? [base[0] + (tint.color[0] - base[0]) * k, base[1] + (tint.color[1] - base[1]) * k, base[2] + (tint.color[2] - base[2]) * k] : base;
  const part = (offset: Vec3, size: Vec3, shape: FxSolid['shape'] = 'block'): FxSolid => ({ shape, p: vadd(root, offset), r: I3, size, color, alpha: 1, material: k > 0.5 ? 'Neon' : 'Plastic' });
  return [part([0, 0, 0], [2, 2, 1]), part([0, 1.6, 0], [1.2, 1.2, 1.2], 'sphere'), part([-1.55, 0, 0], [0.95, 2, 0.95]), part([1.55, 0, 0], [0.95, 2, 0.95]), part([-0.52, -2, 0], [0.94, 2, 0.95]), part([0.52, -2, 0], [0.94, 2, 0.95])];
}

export interface FxCamera {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  /** The direction it looks. */
  forward: Vec3;
  /** Vertical field of view, degrees. */
  fov: number;
}

export function lookFrom(pos: Vec3, target: Vec3, fov = 40): FxCamera {
  const forward = vnorm(vsub(target, pos), [0, 0, -1]);
  const right = vnorm(vcross(forward, [0, 1, 0]), [1, 0, 0]);
  return { pos, right, up: vcross(right, forward), forward, fov };
}

export interface FxFraming {
  target: Vec3;
  distance: number;
  /** Radians round the target: 0 looks along -z (from behind whoever plays it). */
  azimuth: number;
  /** Radians above the horizon. */
  elevation: number;
}

/**
 * A camera that holds what the effect shows: from behind and to the side of whoever plays it (effects
 * point along -z), or from the side when it reaches far ahead (a beam, a wave), just far enough for
 * the corners of its box to fit the picture.
 */
export function frameEffect(bounds: FxBounds, aspect = 1.4, fov = 40, dummy: Vec3 | null = null): FxFraming {
  // The floor is at y = 0; nothing shows below it.
  const min: Vec3 = [bounds.focus.min[0], Math.max(0, bounds.focus.min[1]), bounds.focus.min[2]];
  const max: Vec3 = [bounds.focus.max[0], Math.max(1, bounds.focus.max[1]), bounds.focus.max[2]];
  if (dummy) {
    // The character it plays on stays in the picture.
    const lo: Vec3 = [dummy[0] - 2, dummy[1] - 3, dummy[2] - 0.6];
    const hi: Vec3 = [dummy[0] + 2, dummy[1] + 2.3, dummy[2] + 0.6];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, lo[i]!);
      max[i] = Math.max(max[i]!, hi[i]!);
    }
  }
  const target = vmul(vadd(min, max), 0.5);
  const size = vsub(max, min);
  const azimuth = size[2] > Math.max(size[0], size[1]) * 1.8 ? 1.15 : 0.5;
  const elevation = 0.24;
  // From the target toward the camera.
  const back: Vec3 = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
  const right = vnorm(vcross([0, 1, 0], back), [1, 0, 0]);
  const up = vcross(back, right);
  const tan = Math.tan(((fov / 2) * Math.PI) / 180) * 0.86;
  let distance = 6;
  for (let k = 0; k < 8; k++) {
    const corner: Vec3 = [k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]];
    const v = vsub(corner, target);
    const toward = v[0] * back[0] + v[1] * back[1] + v[2] * back[2];
    distance = Math.max(distance, toward + Math.abs(v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / (tan * aspect), toward + Math.abs(v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / tan);
  }
  return { target, distance, azimuth, elevation };
}

export function cameraOf(f: FxFraming, fov = 40): FxCamera {
  const flat = Math.cos(f.elevation) * f.distance;
  const pos: Vec3 = [f.target[0] + Math.sin(f.azimuth) * flat, Math.max(0.6, f.target[1] + Math.sin(f.elevation) * f.distance), f.target[2] + Math.cos(f.azimuth) * flat];
  return lookFrom(pos, f.target, fov);
}
