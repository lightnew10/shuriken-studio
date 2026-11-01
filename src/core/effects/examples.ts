import { TEXTURES as T, type EffectSpec } from '@shared/effects';

/**
 * Complete effects that show what the timeline runtime does: each is an anatomy (anticipation, impact,
 * follow-through) in layers, written the way skill roblox-vfx teaches. They are worked examples to read
 * and adapt (vfx_presets {preset: "<Name>"} returns one), not a menu: an effect for a game is designed
 * for that game's moves, palette and camera. They use only textures that ship with Roblox, so they play
 * without uploads; vfx_texture makes better ones ("tex:<Name>").
 */
export const EXAMPLES: Record<string, Omit<EffectSpec, 'name'> & { teaches: string }> = {
  FireballImpact: {
    teaches: 'An explosion in layers: a white-hot flash on the first frame, a fireball shell, a shock ring on the ground, debris, then light smoke that rises and thins (never dark and opaque), a light that dies fast, a short shake and a scorch mark.',
    description: 'A fireball hitting the ground.',
    kind: 'burst',
    duration: 2.5,
    tracks: [
      { type: 'flash', name: 'Flash', duration: 0.1, size: [4, 9], color: ['#ffffff', '#ffe2a0'], brightness: 3 },
      { type: 'shell', name: 'Fireball', shape: 'sphere', duration: 0.35, size: [6, 6, 6], scale: { keys: [[0, 0.3], [0.3, 1], [1, 1.2]], ease: 'quadOut' }, color: ['#fff4c2', '#ff9a2e', '#c2410c'], transparency: { keys: [[0, 0], [0.5, 0.3], [1, 1]] }, material: 'Neon' },
      { type: 'ring', name: 'Shock', at: 0.02, duration: 0.3, radius: { keys: [[0, 1], [1, 14]], ease: 'quartOut' }, color: '#ffd28a', transparency: [0.1, 1], facing: 'Top' },
      { type: 'particles', name: 'Embers', texture: T.spark, color: ['#fff1b0', '#ff7a1a'], size: [0.5, 0], transparency: [0, 1], lifetime: [0.4, 0.8], speed: [35, 60], spread: [180, 180], emit: 26, drag: 3, acceleration: [0, -40, 0], lightEmission: 1, orientation: 'VelocityParallel' },
      { type: 'particles', name: 'Smoke', at: 0.08, texture: T.puff, color: ['#a39a92', '#8a8178'], size: [3, 9], transparency: [0.55, 0.75, 1], lifetime: [1.2, 1.8], speed: [4, 9], spread: [180, 180], emit: 10, drag: 2, acceleration: [0, 4, 0], rotation: [0, 360], rotSpeed: [-25, 25], lightInfluence: 1, detail: 'medium' },
      { type: 'debris', name: 'Rocks', count: 7, size: [0.4, 1], speed: [25, 45], spread: 55, color: ['#5c4f45', '#3d342e'], material: 'Slate', detail: 'medium' },
      { type: 'light', name: 'Glow', duration: 0.45, color: '#ffb454', brightness: { keys: [[0, 8], [1, 0]], ease: 'quadOut' }, range: 22 },
      { type: 'shake', magnitude: 2.2, duration: 0.35, radius: 70 },
      { type: 'decal', name: 'Scorch', at: 0.05, duration: 6, texture: T.puff, size: 9, color: '#1a1410', transparency: { keys: [[0, 1], [0.03, 0.35], [0.7, 0.45], [1, 1]] } },
    ],
  },
  FireBolt: {
    teaches: 'A projectile body: a persistent effect that rides Effects.projectile; a hot core, a flame wake that trails behind (particles are not LockedToPart, so they stay where they were born) and a light.',
    description: 'The flying fireball (use as a projectile body).',
    kind: 'persistent',
    emitters: [
      { name: 'Core', texture: T.glow, color: ['#fff4c2'], size: [1.8], transparency: [0.1], lifetime: [0.08, 0.1], speed: [0, 0], rate: 40, lightEmission: 1, lockedToPart: true },
      { name: 'Wake', texture: T.fire, color: ['#ffe08a', '#ff7a1a', '#c2410c'], size: [1.6, 0.4], transparency: [0.1, 1], lifetime: [0.25, 0.4], speed: [0.5, 1.5], spread: [180, 180], rate: 70, lightEmission: 0.9, rotation: [0, 360], rotSpeed: [-120, 120] },
      { name: 'Sparks', texture: T.spark, color: ['#fff1b0', '#ff9a2e'], size: [0.2, 0], transparency: [0, 1], lifetime: [0.2, 0.4], speed: [3, 8], spread: [180, 180], rate: 25, lightEmission: 1, orientation: 'VelocityParallel', detail: 'medium' },
    ],
    tracks: [{ type: 'light', loop: true, duration: 1, color: '#ff9a2e', brightness: 3, range: 12, flicker: 0.4 }],
  },
  SwordSlash: {
    teaches: 'A melee swing: one slash particle tilted into the swing plane (a crescent texture; a ring stands in until vfx_texture makes one), a crisp circle that snaps out, and sparks flying along the swing.',
    description: 'A diagonal sword slash in front of the attacker (play at the character root CFrame).',
    kind: 'burst',
    duration: 0.8,
    tracks: [
      { type: 'slash', name: 'Arc', duration: 0.22, offset: [0, 1, -3], rotation: [0, 0, 35], size: { keys: [[0, 7], [1, 9]], ease: 'quadOut' }, color: ['#ffffff', '#9fd4ff'], spin: -30 },
      { type: 'circle', name: 'Edge', at: 0.03, duration: 0.18, offset: [0, 1, -3], rotation: [0, 0, 35], radius: { keys: [[0, 3], [1, 5]], ease: 'expoOut' }, width: [0.25, 0.02], color: '#d8f0ff', transparency: [0, 1] },
      { type: 'particles', name: 'Sparks', at: 0.05, offset: [0, 1, -4], texture: T.spark, color: ['#ffffff', '#9fd4ff'], size: [0.3, 0], transparency: [0, 1], lifetime: [0.12, 0.25], speed: [25, 40], spread: [40, 40], direction: 'Left', emit: 12, drag: 6, lightEmission: 1, orientation: 'VelocityParallel' },
    ],
  },
  LightningStrike: {
    teaches: 'A bolt from the sky: anticipation (a telegraph-like glow on the ground), then the strike on one frame — a crackling jagged beam, a white flash, a light that lights the whole area, a ring and a hard shake — and a short follow-through of sparks.',
    description: 'Lightning striking the point it plays at.',
    kind: 'burst',
    duration: 1.4,
    tracks: [
      { type: 'circle', name: 'Charge', duration: 0.35, radius: { keys: [[0, 5], [1, 2]], ease: 'quadIn' }, width: 0.3, color: '#a8d8ff', transparency: [0.6, 0] },
      { type: 'beam', name: 'Bolt', at: 0.35, duration: 0.3, from: [0, 60, 0], to: [0, 0, 0], width: [0.9, 0.5], color: '#e8f6ff', jag: { segments: 14, amplitude: 0.08, rate: 22 }, fade: { keys: [[0, 0], [0.6, 0.2], [1, 1]] }, brightness: 4 },
      { type: 'beam', name: 'BoltGlow', at: 0.35, duration: 0.3, from: [0, 60, 0], to: [0, 0, 0], width: [4, 2.5], color: '#6cb2ff', transparency: 0.55, jag: { segments: 14, amplitude: 0.08, rate: 22 }, fade: { keys: [[0, 0], [0.6, 0.3], [1, 1]] } },
      { type: 'flash', name: 'Flash', at: 0.35, duration: 0.12, size: [6, 12], color: '#ffffff', brightness: 4 },
      { type: 'light', name: 'Light', at: 0.35, duration: 0.4, color: '#bfe3ff', brightness: { keys: [[0, 10], [0.2, 3], [0.3, 8], [1, 0]] }, range: 40 },
      { type: 'ring', name: 'Ring', at: 0.36, duration: 0.3, radius: { keys: [[0, 1], [1, 12]], ease: 'expoOut' }, color: '#d8eeff', transparency: [0, 1] },
      { type: 'particles', name: 'Sparks', at: 0.36, texture: T.spark, color: ['#ffffff', '#6cb2ff'], size: [0.4, 0], transparency: [0, 1], lifetime: [0.2, 0.5], speed: [30, 55], spread: [70, 70], emit: 22, drag: 4, acceleration: [0, -50, 0], lightEmission: 1, orientation: 'VelocityParallel' },
      { type: 'shake', at: 0.35, magnitude: 3, duration: 0.3, radius: 90 },
      { type: 'screen', at: 0.35, fx: 'flash', color: '#dff2ff', strength: 0.25, duration: 0.2, within: 45 },
    ],
  },
  IceShatter: {
    teaches: 'Element by shape language: ice is angular and cold — a crystal shell (Ice material) that grows, then shards (wedge debris) and a frosty mist; pale cyan and white with a deep blue for value contrast.',
    description: 'Ice bursting out of the ground.',
    kind: 'burst',
    duration: 2,
    tracks: [
      { type: 'shell', name: 'Crystal', shape: 'wedge', duration: 0.5, size: [2, 7, 2], offset: [0, 2, 0], scale: { keys: [[0, 0], [0.25, 1.1], [0.4, 1], [1, 1]], ease: 'backOut' }, color: ['#e8fbff', '#7fd3ff'], transparency: { keys: [[0, 0.1], [0.75, 0.2], [1, 1]] }, material: 'Ice' },
      { type: 'flash', name: 'Glint', at: 0.12, duration: 0.1, size: [3, 5], color: '#e8fbff' },
      { type: 'debris', name: 'Shards', at: 0.45, count: 8, size: [0.3, 0.8], speed: [20, 35], spread: 70, color: ['#bfeaff', '#7fd3ff', '#2f6fae'], material: 'Ice', shape: 'wedge', bounce: 0.2 },
      { type: 'particles', name: 'Frost', at: 0.4, texture: T.puff, color: ['#e8fbff', '#bfeaff'], size: [2, 6], transparency: [0.6, 0.85, 1], lifetime: [0.8, 1.2], speed: [3, 6], spread: [180, 180], emit: 8, drag: 2, lightInfluence: 0.8, rotation: [0, 360] },
      { type: 'ring', name: 'Frostline', at: 0.45, duration: 0.4, radius: [1, 8], color: '#bfeaff', transparency: [0.3, 1] },
    ],
  },
  HolyPillar: {
    teaches: 'A buff or smite as a column: a tall neon pillar (cylinder shell) that grows from the ground and thins, a crisp circle at its foot, rising motes, a warm light; gold and white, soft edges.',
    description: 'A column of holy light.',
    kind: 'burst',
    duration: 2,
    tracks: [
      { type: 'circle', name: 'Base', duration: 1.2, radius: { keys: [[0, 0.5], [0.2, 4], [1, 4.5]], ease: 'quadOut' }, width: 0.3, color: '#ffe9a8', transparency: { keys: [[0, 0], [0.7, 0.2], [1, 1]] } },
      { type: 'shell', name: 'Pillar', shape: 'pillar', at: 0.1, duration: 1, size: [5, 30, 5], offset: [0, 15, 0], scale: { keys: [[0, 0.2], [0.15, 1], [1, 0.6]] }, color: ['#ffffff', '#ffd65a'], transparency: { keys: [[0, 0.5], [0.2, 0.62], [1, 1]] }, material: 'Neon' },
      { type: 'particles', name: 'Motes', at: 0.1, texture: T.sparkle, color: ['#fff4c2', '#ffd65a'], size: [0.5, 0], transparency: [0, 1], lifetime: [0.8, 1.4], speed: [6, 12], spread: [12, 12], emit: 30, lightEmission: 1, acceleration: [0, 4, 0] },
      { type: 'light', name: 'Light', at: 0.1, duration: 1, color: '#ffe9a8', brightness: { keys: [[0, 0], [0.15, 6], [1, 0]] }, range: 24 },
    ],
  },
  HealAura: {
    teaches: 'A persistent aura with looping tracks: a slow circle that breathes at the feet (a loop: true track), motes rising round the body; dim enough to wear for a whole fight.',
    description: 'A healing aura (Effects.attach to the HumanoidRootPart).',
    kind: 'persistent',
    emitters: [
      { name: 'Motes', texture: T.sparkle, color: ['#d9ffe4', '#57d68d'], size: [0.35, 0], transparency: [0.1, 1], lifetime: [0.9, 1.4], speed: [1.5, 3], spread: [180, 180], rate: 12, acceleration: [0, 4, 0], lightEmission: 1, offset: [0, -1.5, 0] },
    ],
    tracks: [
      { type: 'circle', name: 'Ring', loop: true, duration: 1.6, offset: [0, -2.8, 0], radius: { keys: [[0, 2.4], [0.5, 2.8], [1, 2.4]], ease: 'sineInOut' }, width: 0.18, color: '#7dffb0', transparency: { keys: [[0, 0.5], [0.5, 0.2], [1, 0.5]] } },
    ],
  },
  WindSpin: {
    teaches: 'A spin attack drawn with ribbons: trails swept along a rising spiral path (arc-length paced, so they move evenly), dust kicked out low, a ring at the end.',
    description: 'A whirlwind around the attacker.',
    kind: 'burst',
    duration: 1.2,
    tracks: [
      { type: 'ribbon', name: 'Swirl', duration: 0.45, path: { kind: 'spiral', r0: 3, r1: 4.5, turns: 1.25, height: 3 }, offset: [0, -2, 0], width: 1.4, ease: 'quadOut', trail: { color: ['#ffffff', '#cfe8ff'], transparency: [0.2, 1], width: [1, 0.2], lifetime: 0.25, lightEmission: 0.6 } },
      { type: 'ribbon', name: 'Swirl2', at: 0.06, duration: 0.45, path: { kind: 'spiral', r0: 2.5, r1: 4, turns: 1.25, height: 4 }, offset: [0, -2, 0], rotation: [0, 180, 0], width: 1, ease: 'quadOut', trail: { color: ['#ffffff', '#cfe8ff'], transparency: [0.35, 1], width: [1, 0.2], lifetime: 0.22, lightEmission: 0.6 } },
      { type: 'particles', name: 'Dust', at: 0.1, offset: [0, -2.5, 0], texture: T.puff, color: ['#d8cfc4'], size: [1.5, 4], transparency: [0.6, 1], lifetime: [0.4, 0.7], speed: [12, 18], spread: [85, 85], emit: 12, drag: 5, lightInfluence: 1 },
      { type: 'ring', name: 'Gust', at: 0.4, duration: 0.3, offset: [0, -2.5, 0], radius: [2, 9], color: '#e8f4ff', transparency: [0.4, 1] },
    ],
  },
};

export function listExamples(): Array<{ id: string; kind: EffectSpec['kind']; teaches: string; tracks: string[] }> {
  return Object.entries(EXAMPLES).map(([id, e]) => ({ id, kind: e.kind, teaches: e.teaches, tracks: (e.tracks ?? []).map((t) => `${t.type}${t.name ? ` ${t.name}` : ''}`) }));
}

export function exampleEffect(id: string, name: string): EffectSpec | null {
  const e = EXAMPLES[id];
  if (!e) return null;
  const { teaches: _teaches, ...spec } = e;
  return JSON.parse(JSON.stringify({ name, ...spec })) as EffectSpec;
}
