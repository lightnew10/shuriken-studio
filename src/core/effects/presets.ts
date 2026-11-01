import { TEXTURES as T, type EffectSpec, type EmitterSpec } from '@shared/effects';

/**
 * Effect presets tuned for a stylized Roblox look: short, bright, readable bursts (hits, blocks,
 * punches, explosions, heals, level-ups, pickups, dashes, landing dust, ground shockwaves), persistent auras, fire, sparkles and
 * smoke, a weapon trail and an energy beam. Each takes a main/second color, a scale and an intensity.
 */

export interface EffectParams {
  /** Main color (hex). */
  color?: string;
  /** Second color (hex). */
  color2?: string;
  /** Size multiplier (0.25–4). */
  scale?: number;
  /** Particle-count multiplier (0.25–3). */
  intensity?: number;
}

interface Ctx {
  c1: string;
  c2: string;
  s: number;
  i: number;
}

const n = (v: number) => Math.round(v * 1000) / 1000;
const count = (base: number, i: number) => Math.max(1, Math.round(base * i));
const sz = (vals: number[], s: number) => vals.map((v) => n(v * s));

type Builder = { category: 'combat' | 'magic' | 'world' | 'movement'; description: string; defaults: [string, string]; build: (x: Ctx) => Omit<EffectSpec, 'name'> };

const BUILDERS: Record<string, Builder> = {
  HitSpark: {
    category: 'combat',
    description: 'A weapon connecting: bright flash, sparks and a quick shockwave.',
    defaults: ['#ffd98a', '#ff7a1a'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 1,
      light: { color: c2, brightness: 4, range: n(10 * s), duration: 0.15 },
      emitters: [
        { name: 'Flash', texture: T.flash, color: ['#fff8e6', c1], size: sz([2.2, 3.2], s), transparency: [0, 1], lifetime: [0.08, 0.11], speed: [0, 0], emit: 1, lightEmission: 1, brightness: 2, zOffset: 1 },
        { name: 'Sparks', texture: T.spark, color: [c1, c2], size: sz([0.4, 0], s), transparency: [0, 0.15, 1], lifetime: [0.15, 0.32], speed: [n(22 * s), n(40 * s)], spread: [180, 180], emit: count(16, i), drag: 7, lightEmission: 1, orientation: 'VelocityParallel' },
        { name: 'Ring', texture: T.ring, color: [c1], size: sz([0.6, 4.5], s), transparency: [0.25, 1], lifetime: [0.16, 0.2], speed: [0, 0], emit: 1, lightEmission: 1, zOffset: 0.5 },
      ],
    }),
  },
  BlockSpark: {
    category: 'combat',
    description: 'Steel on steel: a cold flash and fast metallic sparks for blocks and parries.',
    defaults: ['#e8f6ff', '#6cb2ff'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 1,
      light: { color: c2, brightness: 3, range: n(8 * s), duration: 0.12 },
      emitters: [
        { name: 'Flash', texture: T.flash, color: ['#ffffff', c1], size: sz([1.6, 2.4], s), transparency: [0, 1], lifetime: [0.06, 0.09], speed: [0, 0], emit: 1, lightEmission: 1, brightness: 3, zOffset: 1 },
        { name: 'Sparks', texture: T.spark, color: ['#ffffff', c2], size: sz([0.3, 0], s), transparency: [0, 1], lifetime: [0.12, 0.25], speed: [n(28 * s), n(48 * s)], spread: [180, 180], emit: count(22, i), drag: 5, acceleration: [0, -25, 0], lightEmission: 1, orientation: 'VelocityParallel' },
      ],
    }),
  },
  PunchImpact: {
    category: 'combat',
    description: 'A fist or kick landing (battlegrounds style): a white-hot pop, a snapping ring and short impact streaks.',
    defaults: ['#ffffff', '#9fd4ff'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 0.8,
      light: { color: c2, brightness: 2.5, range: n(8 * s), duration: 0.1 },
      emitters: [
        { name: 'Pop', texture: T.flash, color: [c1, c2], size: sz([1.4, 2.6], s), transparency: [0, 1], lifetime: [0.06, 0.08], speed: [0, 0], emit: 1, lightEmission: 1, brightness: 2, zOffset: 1 },
        { name: 'Ring', texture: T.ring, color: [c1, c2], size: sz([0.4, 3.6], s), transparency: [0.1, 1], lifetime: [0.12, 0.14], speed: [0, 0], emit: 1, lightEmission: 1, zOffset: 0.8 },
        { name: 'Streaks', texture: T.square, color: [c1, c2], size: sz([0.12, 0], s), transparency: [0, 1], lifetime: [0.1, 0.18], speed: [n(30 * s), n(46 * s)], spread: [180, 180], emit: count(10, i), drag: 8, lightEmission: 1, orientation: 'VelocityParallel', squash: [-3] },
      ],
    }),
  },
  Shockwave: {
    category: 'movement',
    description: 'A flat ring racing out over the ground with a skirt of dust, for slams, landings and ground pounds (play it at floor level).',
    defaults: ['#fff4e0', '#b8a58f'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 1.4,
      emitters: [
        { name: 'Ring', texture: T.ring, color: [c1], size: sz([1, 16], s), transparency: [0.15, 1], lifetime: [0.35, 0.4], speed: [0.01, 0.01], emit: 1, lightEmission: 0.6, orientation: 'VelocityPerpendicular' },
        { name: 'Dust', texture: T.puff, color: [c2, c2], size: sz([1.2, 3.6], s), transparency: [0.4, 1], lifetime: [0.5, 0.8], speed: [n(10 * s), n(16 * s)], spread: [88, 88], emit: count(18, i), drag: 5, acceleration: [0, -8, 0], rotation: [0, 360], rotSpeed: [-40, 40], lightInfluence: 1 },
      ],
    }),
  },
  ImpactDust: {
    category: 'movement',
    description: 'A dust puff where something heavy lands or slams the ground.',
    defaults: ['#cbbba7', '#8c7c69'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 1.6,
      emitters: [
        { name: 'Dust', texture: T.puff, color: [c1, c2], size: sz([1, 3.4], s), transparency: [0.35, 1], lifetime: [0.5, 0.9], speed: [n(5 * s), n(10 * s)], spread: [80, 80], emit: count(14, i), drag: 4, acceleration: [0, 1.5, 0], rotation: [0, 360], rotSpeed: [-40, 40], lightInfluence: 1 },
        { name: 'Grit', texture: T.square, color: [c2], size: sz([0.18, 0.1], s), transparency: [0, 1], lifetime: [0.3, 0.6], speed: [n(8 * s), n(16 * s)], spread: [60, 60], emit: count(10, i), acceleration: [0, -40, 0], lightInfluence: 1 },
      ],
    }),
  },
  Explosion: {
    category: 'world',
    description: 'A fireball with smoke, sparks, a shockwave and a light flash.',
    defaults: ['#ffb454', '#d4380d'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 3,
      light: { color: c1, brightness: 8, range: n(24 * s), duration: 0.4 },
      emitters: [
        { name: 'Flash', texture: T.flash, color: ['#fff6d8'], size: sz([4, 9], s), transparency: [0, 1], lifetime: [0.12, 0.16], speed: [0, 0], emit: 1, lightEmission: 1, brightness: 2, zOffset: 2 },
        { name: 'Fireball', texture: T.fire, color: ['#fff1b0', c1, c2, '#3a2a22'], size: sz([2, 6.5], s), transparency: [0.05, 0.35, 1], lifetime: [0.35, 0.6], speed: [n(6 * s), n(14 * s)], spread: [180, 180], emit: count(26, i), drag: 5, lightEmission: 0.8, rotation: [0, 360], rotSpeed: [-90, 90] },
        { name: 'Smoke', texture: T.puff, color: ['#5a524c', '#2d2926'], size: sz([3, 9], s), transparency: [0.3, 1], lifetime: [1.2, 2], speed: [n(3 * s), n(8 * s)], spread: [180, 180], emit: count(16, i), delay: 0.05, drag: 2, acceleration: [0, 3, 0], rotation: [0, 360], rotSpeed: [-20, 20], lightInfluence: 1 },
        { name: 'Sparks', texture: T.spark, color: ['#fff1b0', c1], size: sz([0.5, 0], s), transparency: [0, 1], lifetime: [0.4, 0.8], speed: [n(30 * s), n(55 * s)], spread: [180, 180], emit: count(30, i), drag: 3, acceleration: [0, -30, 0], lightEmission: 1, orientation: 'VelocityParallel' },
        { name: 'Ring', texture: T.ring, color: [c1], size: sz([1, 13], s), transparency: [0.3, 1], lifetime: [0.25, 0.3], speed: [0, 0], emit: 1, lightEmission: 1, zOffset: 1 },
      ],
    }),
  },
  Heal: {
    category: 'magic',
    description: 'Rising motes and a soft glow for healing and buffs.',
    defaults: ['#57d68d', '#d9ffe4'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 2,
      light: { color: c1, brightness: 3, range: n(10 * s), duration: 0.6 },
      emitters: [
        { name: 'Motes', texture: T.sparkle, color: [c2, c1], size: sz([0.5, 0.15], s), transparency: [0, 1], lifetime: [0.8, 1.3], speed: [n(2 * s), n(5 * s)], spread: [35, 35], emit: count(24, i), acceleration: [0, 6, 0], lightEmission: 1 },
        { name: 'Glow', texture: T.glow, color: [c1], size: sz([2, 4.5], s), transparency: [0.4, 1], lifetime: [0.5, 0.6], speed: [0, 0], emit: 1, lightEmission: 1 },
      ],
    }),
  },
  LevelUp: {
    category: 'magic',
    description: 'A golden fountain, ring and glow for level-ups and big rewards.',
    defaults: ['#ffd65a', '#fff4c2'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 3,
      light: { color: c1, brightness: 5, range: n(16 * s), duration: 0.8 },
      emitters: [
        { name: 'Fountain', texture: T.sparkle, color: [c2, c1], size: sz([0.6, 0], s), transparency: [0, 1], lifetime: [1, 1.6], speed: [n(14 * s), n(22 * s)], spread: [18, 18], emit: count(40, i), drag: 1, acceleration: [0, -20, 0], lightEmission: 1 },
        { name: 'Ring', texture: T.ring, color: [c1], size: sz([1, 10], s), transparency: [0.2, 1], lifetime: [0.4, 0.5], speed: [0, 0], emit: 1, lightEmission: 1 },
        { name: 'Glow', texture: T.glow, color: [c1], size: sz([3, 6], s), transparency: [0.3, 1], lifetime: [0.6, 0.8], speed: [0, 0], emit: 1, lightEmission: 1 },
      ],
    }),
  },
  Pickup: {
    category: 'world',
    description: 'A small sparkling pop for coins and collectibles.',
    defaults: ['#ffc83d', '#fff7cf'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 1,
      emitters: [
        { name: 'Pop', texture: T.sparkle, color: [c2, c1], size: sz([0.45, 0], s), transparency: [0, 1], lifetime: [0.3, 0.5], speed: [n(6 * s), n(10 * s)], spread: [180, 180], emit: count(12, i), drag: 5, lightEmission: 1 },
        { name: 'Glint', texture: T.flash, color: [c2], size: sz([1.2, 2], s), transparency: [0.2, 1], lifetime: [0.12, 0.15], speed: [0, 0], emit: 1, lightEmission: 1 },
      ],
    }),
  },
  DashBurst: {
    category: 'movement',
    description: 'Speed streaks and a puff behind a dash (play it at the character, facing the dash).',
    defaults: ['#ffffff', '#ffb454'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'burst',
      duration: 1,
      emitters: [
        { name: 'Streaks', texture: T.square, color: [c1, c2], size: sz([0.14, 0], s), transparency: [0.2, 1], lifetime: [0.18, 0.3], speed: [n(40 * s), n(60 * s)], spread: [14, 14], emit: count(16, i), direction: 'Back', lightEmission: 1, orientation: 'VelocityParallel', squash: [-2.5] },
        { name: 'Puff', texture: T.puff, color: ['#e6dfd8'], size: sz([1.2, 3], s), transparency: [0.5, 1], lifetime: [0.35, 0.5], speed: [n(2 * s), n(4 * s)], spread: [180, 180], emit: count(8, i), drag: 4, lightInfluence: 1 },
      ],
    }),
  },
  Aura: {
    category: 'magic',
    description: 'A glow with drifting motes around a character or object (persistent).',
    defaults: ['#ff7a1a', '#ffffff'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'persistent',
      emitters: [
        { name: 'Glow', texture: T.glow, color: [c1], size: sz([3, 3.4], s), transparency: [0.75, 0.85, 1], lifetime: [0.8, 1], speed: [0, 0], rate: 6, lightEmission: 1, lockedToPart: true },
        { name: 'Motes', texture: T.sparkle, color: [c2, c1], size: sz([0.25, 0], s), transparency: [0.1, 1], lifetime: [0.8, 1.4], speed: [n(1 * s), n(2.5 * s)], spread: [180, 180], rate: count(14, i), acceleration: [0, 2.5, 0], lightEmission: 1 },
      ],
    }),
  },
  Fire: {
    category: 'world',
    description: 'Flames with embers, smoke and a warm light (torches, campfires; persistent).',
    defaults: ['#ff9a2e', '#fff0a8'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'persistent',
      light: { color: c1, brightness: 2, range: n(14 * s), duration: 0 },
      emitters: [
        { name: 'Flames', texture: T.fire, color: [c2, c1, '#c2410c'], size: sz([1.6, 0.4], s), transparency: [0.2, 1], lifetime: [0.6, 0.9], speed: [n(2 * s), n(4 * s)], spread: [12, 12], rate: count(30, i), acceleration: [0, 4, 0], lightEmission: 0.9, rotation: [0, 360], rotSpeed: [-30, 30] },
        { name: 'Embers', texture: T.spark, color: ['#ffcf73', c1], size: sz([0.12, 0], s), transparency: [0, 1], lifetime: [1, 1.8], speed: [n(3 * s), n(6 * s)], spread: [25, 25], rate: count(6, i), acceleration: [0, 3, 0], lightEmission: 1 },
        { name: 'Smoke', texture: T.puff, color: ['#3b3431'], size: sz([1.5, 4], s), transparency: [0.7, 1], lifetime: [1.5, 2.5], speed: [n(2 * s), n(3 * s)], spread: [10, 10], rate: 4, acceleration: [0, 2, 0], rotation: [0, 360], lightInfluence: 1 },
      ],
    }),
  },
  Sparkle: {
    category: 'world',
    description: 'A gentle twinkle that marks collectibles and interactables (persistent).',
    defaults: ['#fff4c2', '#ffc83d'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'persistent',
      emitters: [{ name: 'Twinkle', texture: T.sparkle, color: [c1, c2], size: sz([0, 0.55, 0], s), transparency: [0, 1], lifetime: [0.6, 1], speed: [n(0.5 * s), n(1.5 * s)], spread: [180, 180], rate: count(6, i), rotation: [0, 360], rotSpeed: [-60, 60], lightEmission: 1 }],
    }),
  },
  Smoke: {
    category: 'world',
    description: 'Slow rising smoke for chimneys, ruins and wreckage (persistent).',
    defaults: ['#6b625c', '#35302c'],
    build: ({ c1, c2, s, i }) => ({
      kind: 'persistent',
      emitters: [{ name: 'Smoke', texture: T.puff, color: [c1, c2], size: sz([2, 6], s), transparency: [0.45, 1], lifetime: [3, 5], speed: [n(2 * s), n(4 * s)], spread: [8, 8], rate: count(5, i), acceleration: [0.6, 1.2, 0], rotation: [0, 360], rotSpeed: [-10, 10], lightInfluence: 1 }],
    }),
  },
  SlashTrail: {
    category: 'combat',
    description: 'A bright swing trail for weapons (attach to the blade; enable during swings).',
    defaults: ['#ffffff', '#ff7a1a'],
    build: ({ c1, c2 }) => ({
      kind: 'trail',
      trail: { color: [c1, c2], transparency: [0.15, 1], width: [1, 0], lifetime: 0.16, lightEmission: 1, minLength: 0.05, faceCamera: false },
    }),
  },
  EnergyBeam: {
    category: 'magic',
    description: 'A glowing beam between two points (lasers, tethers, links).',
    defaults: ['#6cb2ff', '#ffffff'],
    build: ({ c1, c2, s }) => ({
      kind: 'beam',
      beam: { color: [c1, c2, c1], transparency: [0.15, 0.35, 0.15], width: [n(1.2 * s), n(1.2 * s)], lightEmission: 1, segments: 12, curve: [0, 0], faceCamera: true },
    }),
  },
};

const HEX = /^#?[0-9a-fA-F]{6}$/;
const hex = (v: string | undefined, d: string) => (v && HEX.test(v) ? (v.startsWith('#') ? v : `#${v}`).toLowerCase() : d);

export interface EffectPresetInfo {
  id: string;
  category: Builder['category'];
  kind: EffectSpec['kind'];
  description: string;
  colors: [string, string];
}

export function listEffectPresets(): EffectPresetInfo[] {
  return Object.entries(BUILDERS).map(([id, b]) => ({ id, category: b.category, kind: b.build({ c1: b.defaults[0], c2: b.defaults[1], s: 1, i: 1 }).kind, description: b.description, colors: b.defaults }));
}

export function buildEffect(id: string, name: string, params: EffectParams = {}): EffectSpec {
  const b = BUILDERS[id];
  if (!b) throw new Error(`Unknown effect preset "${id}". Presets: ${Object.keys(BUILDERS).join(', ')}`);
  const x: Ctx = {
    c1: hex(params.color, b.defaults[0]),
    c2: hex(params.color2, b.defaults[1]),
    s: Math.min(4, Math.max(0.25, params.scale ?? 1)),
    i: Math.min(3, Math.max(0.25, params.intensity ?? 1)),
  };
  return { name, description: b.description, ...b.build(x) };
}

export type { EmitterSpec };
