/**
 * Visual effects as data: particle bursts and auras, weapon trails and beams, built from Roblox's own
 * instances (ParticleEmitter, Trail, Beam, PointLight) with textures that ship with every Roblox client
 * (rbxasset://textures/particles/…) or the game's own generated textures ("tex:<Name>", see vfx_texture).
 *
 * An effect is a timeline: its emitters fire at their `delay`, and its `tracks` (shells, rings, slashes,
 * ribbons along paths, beams and lightning, lights, sounds, camera shake, hit-stop, highlights, debris,
 * ground decals, screen FX, other effects) start at their `at` and run their curves over their `duration`.
 * The generated ShurikenEffects runtime plays them on the clients.
 */

export type EffectKind = 'burst' | 'persistent' | 'trail' | 'beam';

/** Named easings (Penner's set), the same in the TypeScript sampler and ShurikenCurves. */
export const EASES = [
  'linear', 'step', 'sineIn', 'sineOut', 'sineInOut', 'quadIn', 'quadOut', 'quadInOut', 'cubicIn', 'cubicOut', 'cubicInOut',
  'quartIn', 'quartOut', 'quartInOut', 'quintIn', 'quintOut', 'quintInOut', 'expoIn', 'expoOut', 'expoInOut', 'circIn', 'circOut',
  'circInOut', 'backIn', 'backOut', 'backInOut', 'elasticIn', 'elasticOut', 'bounceIn', 'bounceOut',
] as const;
export type EaseName = (typeof EASES)[number];
/** A named easing or a CSS-style cubic-bezier [x1, y1, x2, y2]. */
export type Ease = EaseName | [number, number, number, number];

/**
 * A number over a track's life (0..1): a constant, evenly spaced values (linear between them), or keys
 * [[t, value], …] with an easing between each pair.
 */
export type Curve = number | number[] | { keys: Array<[number, number]>; ease?: Ease };
/** Colours over a track's life, the same shapes with hex strings. */
export type ColorCurve = string | string[] | { keys: Array<[number, string]>; ease?: Ease };

export interface FlipbookSpec {
  /** Frames in the texture: 2x2, 4x4 or 8x8 cells (the texture is split evenly). */
  layout: 'Grid2x2' | 'Grid4x4' | 'Grid8x8';
  /** Loop at fps; OneShot plays once over each particle's lifetime; PingPong; Random frames at fps. */
  mode?: 'Loop' | 'OneShot' | 'PingPong' | 'Random';
  /** Frames per second [min, max] (Loop, PingPong, Random). */
  fps?: [number, number];
  /** Each particle starts on a random frame. */
  startRandom?: boolean;
}

export interface EmitterSpec {
  name: string;
  texture: string;
  /** Colors over each particle's life (evenly spaced). */
  color: string[];
  /** Size over life (studs, evenly spaced). */
  size: number[];
  /** Transparency over life (0 opaque … 1 invisible). */
  transparency: number[];
  lifetime: [number, number];
  speed: [number, number];
  /** SpreadAngle (degrees, x/y). */
  spread?: [number, number];
  /** Particles per second for persistent effects (and bursts with `for`). */
  rate?: number;
  /** Particles per burst. */
  emit?: number;
  /** Seconds after the burst starts (layered explosions). */
  delay?: number;
  /** A burst emitter that streams at `rate` for this many seconds instead of emitting at once. */
  for?: number;
  drag?: number;
  acceleration?: [number, number, number];
  lightEmission?: number;
  lightInfluence?: number;
  brightness?: number;
  rotation?: [number, number];
  rotSpeed?: [number, number];
  orientation?: 'FacingCamera' | 'FacingCameraWorldUp' | 'VelocityParallel' | 'VelocityPerpendicular';
  squash?: number[];
  zOffset?: number;
  lockedToPart?: boolean;
  shape?: 'Box' | 'Sphere' | 'Cylinder' | 'Disc';
  shapeStyle?: 'Volume' | 'Surface';
  direction?: 'Top' | 'Bottom' | 'Front' | 'Back' | 'Left' | 'Right';
  flipbook?: FlipbookSpec;
  /** Particles follow workspace.GlobalWind (needs drag > 0). */
  windAffectsDrag?: boolean;
  /** Share of the host's velocity particles inherit (0..1). */
  velocityInheritance?: number;
  /** Simulation speed (0..10; 0.5 = slow motion). */
  timeScale?: number;
  /** Studs [right, up, back] from where the effect plays, and degrees [x, y, z] turning the emitter. */
  offset?: [number, number, number];
  turn?: [number, number, number];
  /** Lowest quality that draws it (default low: always). */
  detail?: Detail;
}

export type Detail = 'low' | 'medium' | 'high';

export interface TrailSpec {
  color: string[];
  transparency: number[];
  /** WidthScale over the trail's length. */
  width: number[];
  lifetime: number;
  lightEmission?: number;
  minLength?: number;
  faceCamera?: boolean;
  texture?: string;
}

export interface BeamSpec {
  color: string[];
  transparency: number[];
  width: [number, number];
  lightEmission?: number;
  segments?: number;
  curve?: [number, number];
  texture?: string;
  textureSpeed?: number;
  textureLength?: number;
  faceCamera?: boolean;
}

/** What every track has: when it starts, how long its curves run, where it sits in the effect. */
export interface TrackBase {
  /** Seconds after the effect starts. */
  at?: number;
  /** Seconds its curves run over (default 0.3). */
  duration?: number;
  /** Studs [right, up, back] from where the effect plays (its CFrame's axes). */
  offset?: [number, number, number];
  /** Degrees [x, y, z] turning the track. */
  rotation?: [number, number, number];
  /** Lowest quality that plays it. */
  detail?: Detail;
  /** Persistent effects: repeat the track until the effect stops. */
  loop?: boolean;
  name?: string;
}

/** A path in the effect's own space: arc (about its up axis, 0° = forward, + = left), spiral, orbit, points, line. */
export type PathSpec =
  | { kind: 'arc'; radius: number; from: number; to: number }
  | { kind: 'spiral'; r0: number; r1: number; turns: number; height: number }
  | { kind: 'orbit'; radius: number; turns?: number; height?: number }
  | { kind: 'points'; points: Array<[number, number, number]>; smooth?: boolean }
  | { kind: 'line'; from: [number, number, number]; to: [number, number, number] };

export type TrackSpec =
  /** Particles: an emitter inline (its `at` is its delay; rotation is the particles' own [min, max], turn tilts it). */
  | (Omit<TrackBase, 'rotation'> & { type: 'particles' } & Omit<EmitterSpec, 'delay' | 'name'> & { name?: string })
  /** A flat ring of light racing out: one particle lying across its direction (VelocityPerpendicular). */
  | (TrackBase & { type: 'ring'; radius?: Curve; color?: ColorCurve; transparency?: Curve; texture?: string; lightEmission?: number; brightness?: number; facing?: 'Top' | 'Front' | 'Right' })
  /** A slash: one textured particle (a crescent, or a flipbook of one sweeping) in a plane tilted by `rotation`. */
  | (TrackBase & { type: 'slash'; size?: Curve; color?: ColorCurve; transparency?: Curve; texture?: string; flipbook?: FlipbookSpec; spin?: number; lightEmission?: number; brightness?: number })
  /** A bright pop facing the camera (the first frames of an impact). */
  | (TrackBase & { type: 'flash'; size?: Curve; color?: ColorCurve; transparency?: Curve; texture?: string; brightness?: number })
  /** A part that grows, fades and changes colour: flash spheres, domes, discs, pillars, shields, a custom mesh. */
  | (TrackBase & { type: 'shell'; shape: 'sphere' | 'dome' | 'cylinder' | 'disc' | 'pillar' | 'block' | 'wedge' | 'mesh'; size?: [number, number, number]; scale?: Curve; color?: ColorCurve; transparency?: Curve; material?: 'Neon' | 'ForceField' | 'Glass' | 'SmoothPlastic' | 'Plastic' | 'Ice' | 'Foil'; spin?: [number, number, number]; meshId?: string; textureId?: string })
  /** A crisp circle drawn by four curved beams: telegraph rims, expanding rings of light. */
  | (TrackBase & { type: 'circle'; radius?: Curve; width?: Curve; color?: ColorCurve; transparency?: Curve; lightEmission?: number; brightness?: number; texture?: string })
  /** A ribbon swept along a path by a moving trail (spin attacks, spirals, orbits, wind swirls). */
  | (TrackBase & { type: 'ribbon'; path: PathSpec; width?: number; across?: 'flat' | 'upright'; ease?: Ease; trail?: { color?: ColorCurve; transparency?: Curve; width?: Curve; lifetime?: number; lightEmission?: number; brightness?: number; texture?: string } })
  /** A beam from `from` to `to` (offsets, or "target" = opts.to), bent by `bend`; `jag` makes it crackling lightning. */
  | (TrackBase & { type: 'beam'; from?: [number, number, number]; to?: [number, number, number] | 'target'; width?: [number, number]; widthScale?: Curve; color?: ColorCurve; transparency?: Curve; fade?: Curve; bend?: [number, number]; segments?: number; texture?: string; textureSpeed?: number; textureLength?: number; textureMode?: 'Stretch' | 'Wrap' | 'Static'; lightEmission?: number; lightInfluence?: number; brightness?: number; faceCamera?: boolean; zOffset?: number; jag?: { segments?: number; amplitude?: number; rate?: number } })
  /** A light: brightness and range over the track, flicker 0..1. */
  | (TrackBase & { type: 'light'; kind?: 'point' | 'spot'; color?: string; brightness?: Curve; range?: Curve; flicker?: number; shadows?: boolean; angle?: number })
  /** A sound by ShurikenAudio name, or an rbxassetid:// id. */
  | (TrackBase & { type: 'sound'; sound: string; volume?: number; pitch?: [number, number] })
  /** Camera shake (degrees), falling off over `radius` studs from the effect. */
  | (TrackBase & { type: 'shake'; magnitude?: number; radius?: number })
  /** Freezes opts.target's animations for `seconds`. */
  | (TrackBase & { type: 'hitstop'; seconds?: number })
  /** A Highlight flash on opts.target. */
  | (TrackBase & { type: 'highlight'; color?: string; outline?: string; transparency?: Curve; outlineTransparency?: Curve })
  /** A 2D cue on the screen of players near it (ShurikenScreenFX): flash, tint, vignette, speedlines, banner, hitmarker. */
  | (TrackBase & { type: 'screen'; fx: 'flash' | 'tint' | 'vignette' | 'speedlines' | 'banner' | 'hitmarker' | 'shake'; color?: string; strength?: number; text?: string; within?: number })
  /** Chunks thrown out under gravity that bounce, settle and fade. */
  | (TrackBase & { type: 'debris'; count?: number; size?: [number, number]; speed?: [number, number]; spread?: number; gravity?: number; bounce?: number; lifetime?: [number, number]; color?: string | string[]; material?: string; shape?: 'block' | 'wedge' | 'ball' })
  /** A decal laid on the ground under it: scorch marks, cracks, magic circles. */
  | (TrackBase & { type: 'decal'; texture: string; size?: [number, number] | number; color?: ColorCurve; transparency?: Curve; spin?: number; ground?: boolean })
  /** Another effect by name, at `at`. */
  | (TrackBase & { type: 'spawn'; effect: string });

export type TrackType = TrackSpec['type'];
export const TRACK_TYPES: TrackType[] = ['particles', 'ring', 'slash', 'flash', 'shell', 'circle', 'ribbon', 'beam', 'light', 'sound', 'shake', 'hitstop', 'highlight', 'screen', 'debris', 'decal', 'spawn'];

export interface EffectSpec {
  name: string;
  description?: string;
  kind: EffectKind;
  emitters?: EmitterSpec[];
  /** Everything else on the timeline (and inline particles). */
  tracks?: TrackSpec[];
  trail?: TrailSpec;
  beam?: BeamSpec;
  /** A short light flash with the burst. */
  light?: { color: string; brightness: number; range: number; duration: number };
  /** Seconds before a burst's leftovers are cleaned up. */
  duration?: number;
}

export const TEXTURES = {
  sparkle: 'rbxasset://textures/particles/sparkles_main.dds',
  spark: 'rbxasset://textures/particles/fire_sparks_main.dds',
  fire: 'rbxasset://textures/particles/fire_main.dds',
  smoke: 'rbxasset://textures/particles/smoke_main.dds',
  flash: 'rbxasset://textures/particles/explosion01_core_main.dds',
  implosion: 'rbxasset://textures/particles/explosion01_implosion_main.dds',
  ring: 'rbxasset://textures/particles/explosion01_shockwave_main.dds',
  puff: 'rbxasset://textures/particles/explosion01_smoke_main.dds',
  glow: 'rbxasset://textures/particles/forcefield_glow_main.dds',
  vortex: 'rbxasset://textures/particles/forcefield_vortex_main.dds',
  square: 'rbxasset://textures/particles/SquareParticle.png',
} as const;

const HEX = /^#?[0-9a-fA-F]{6}$/;
/** A texture: a Roblox content id, or "tex:<Name>" for one of the game's generated textures. */
export const TEXTURE_REF = /^(rbxasset|rbxassetid|rbxthumb):\/\/|^tex:[A-Za-z][A-Za-z0-9_]{0,47}$/;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Problems with a curve (empty when fine). */
function curveProblems(label: string, c: unknown, lo: number, hi: number): string[] {
  if (c === undefined) return [];
  if (isNum(c)) return c < lo || c > hi ? [`${label} must be between ${lo} and ${hi}`] : [];
  if (Array.isArray(c)) {
    if (c.length < 1 || c.length > 20) return [`${label} needs 1–20 values`];
    return c.some((x) => !isNum(x) || x < lo || x > hi) ? [`${label} values must be between ${lo} and ${hi}`] : [];
  }
  if (c && typeof c === 'object' && Array.isArray((c as { keys?: unknown }).keys)) {
    const keys = (c as { keys: unknown[] }).keys;
    if (keys.length < 1 || keys.length > 20) return [`${label} needs 1–20 keys`];
    for (const k of keys) {
      if (!Array.isArray(k) || k.length !== 2 || !isNum(k[0]) || !isNum(k[1])) return [`${label} keys are [t, value] pairs`];
      if (k[0] < 0 || k[0] > 1) return [`${label} key times run 0..1 (the track's life)`];
      if (k[1] < lo || k[1] > hi) return [`${label} values must be between ${lo} and ${hi}`];
    }
    return easeProblems(label, (c as { ease?: unknown }).ease);
  }
  return [`${label} must be a number, an array of numbers or {keys: [[t, v], …]}`];
}

function easeProblems(label: string, e: unknown): string[] {
  if (e === undefined) return [];
  if (typeof e === 'string') return (EASES as readonly string[]).includes(e) ? [] : [`${label}: unknown ease "${e}" (${EASES.join(', ')}, or [x1, y1, x2, y2])`];
  if (Array.isArray(e) && e.length === 4 && e.every(isNum)) return [];
  return [`${label}: ease is a name or [x1, y1, x2, y2]`];
}

function colorCurveProblems(label: string, c: unknown): string[] {
  if (c === undefined) return [];
  if (typeof c === 'string') return HEX.test(c) ? [] : [`${label} must be a hex colour like "#ffb454"`];
  if (Array.isArray(c)) return c.length < 1 || c.length > 20 || c.some((x) => typeof x !== 'string' || !HEX.test(x)) ? [`${label} needs 1–20 hex colours`] : [];
  if (c && typeof c === 'object' && Array.isArray((c as { keys?: unknown }).keys)) {
    const keys = (c as { keys: unknown[] }).keys;
    if (keys.some((k) => !Array.isArray(k) || k.length !== 2 || !isNum(k[0]) || typeof k[1] !== 'string' || !HEX.test(k[1]))) return [`${label} keys are [t, "#hex"] pairs`];
    return easeProblems(label, (c as { ease?: unknown }).ease);
  }
  return [`${label} must be a hex colour, an array of them or {keys: [[t, "#hex"], …]}`];
}

const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(isNum);

function emitterProblems(m: EmitterSpec, kind: EffectKind, label: string): string[] {
  const p: string[] = [];
  const seq = (l: string, v: unknown, lo: number, hi: number) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 8) p.push(`${l} needs 1–8 values`);
    else if (v.some((x) => !isNum(x) || x < lo || x > hi)) p.push(`${l} values must be between ${lo} and ${hi}`);
  };
  if (!m.texture || !TEXTURE_REF.test(m.texture)) p.push(`${label}: texture must be rbxasset://…, rbxassetid://… or tex:<Name>`);
  if (!Array.isArray(m.color) || m.color.length < 1 || m.color.length > 8 || m.color.some((c) => typeof c !== 'string' || !HEX.test(c))) p.push(`${label} color needs 1–8 hex colors like "#ffb454"`);
  seq(`${label} size`, m.size, 0, 100);
  seq(`${label} transparency`, m.transparency, 0, 1);
  if (!(m.lifetime?.[0] >= 0 && m.lifetime[1] >= m.lifetime[0] && m.lifetime[1] <= 20)) p.push(`${label}: lifetime must be [min, max] within 0–20 s`);
  if (!(Array.isArray(m.speed) && isNum(m.speed[0]) && isNum(m.speed[1]))) p.push(`${label}: speed must be [min, max] studs/s`);
  if (kind === 'burst' && !m.for && !(m.emit! >= 1 && m.emit! <= 400)) p.push(`${label}: a burst needs emit between 1 and 400`);
  if ((kind === 'persistent' || m.for) && !(m.rate! > 0 && m.rate! <= 400)) p.push(`${label}: ${m.for ? 'streaming for a while' : 'a persistent effect'} needs rate between 1 and 400 per second`);
  if (m.flipbook) {
    if (!['Grid2x2', 'Grid4x4', 'Grid8x8'].includes(m.flipbook.layout)) p.push(`${label}: flipbook layout is Grid2x2, Grid4x4 or Grid8x8`);
    if (m.flipbook.mode && !['Loop', 'OneShot', 'PingPong', 'Random'].includes(m.flipbook.mode)) p.push(`${label}: flipbook mode is Loop, OneShot, PingPong or Random`);
  }
  if (m.offset && !vec3(m.offset)) p.push(`${label}: offset is [right, up, back] studs`);
  if (m.turn && !vec3(m.turn)) p.push(`${label}: turn is [x, y, z] degrees`);
  return p;
}

function trackProblems(t: TrackSpec, i: number, names: Set<string>): string[] {
  const label = `track ${i + 1} (${(t as { type?: string }).type ?? '?'}${t.name ? ` ${t.name}` : ''})`;
  const p: string[] = [];
  if (!TRACK_TYPES.includes(t.type)) return [`${label}: type must be one of ${TRACK_TYPES.join(', ')}`];
  if (t.at !== undefined && !(isNum(t.at) && t.at >= 0 && t.at <= 30)) p.push(`${label}: at must be 0–30 s`);
  if (t.duration !== undefined && !(isNum(t.duration) && t.duration > 0 && t.duration <= 30)) p.push(`${label}: duration must be within 0–30 s`);
  if (t.offset && !vec3(t.offset)) p.push(`${label}: offset is [right, up, back] studs`);
  if (t.type !== 'particles' && t.rotation && !vec3(t.rotation)) p.push(`${label}: rotation is [x, y, z] degrees`);
  const any = t as unknown as Record<string, unknown>;
  for (const k of ['transparency', 'fade', 'outlineTransparency']) p.push(...curveProblems(`${label} ${k}`, any[k], 0, 1));
  for (const k of ['scale', 'radius', 'width', 'widthScale', 'brightness', 'range']) if (!(t.type === 'beam' && k === 'width') && !(t.type === 'particles')) p.push(...curveProblems(`${label} ${k}`, any[k], 0, 500));
  if (t.type !== 'particles' && t.type !== 'debris') p.push(...colorCurveProblems(`${label} color`, any.color));
  if ('texture' in t && t.texture !== undefined && !TEXTURE_REF.test(t.texture)) p.push(`${label}: texture must be rbxasset://…, rbxassetid://… or tex:<Name>`);
  if (t.type === 'particles') p.push(...emitterProblems({ ...(t as unknown as EmitterSpec), name: t.name ?? `track${i + 1}` }, 'burst', label));
  if (t.type === 'ribbon' && !(t.path && typeof t.path === 'object' && ['arc', 'spiral', 'orbit', 'points', 'line'].includes(t.path.kind))) p.push(`${label}: path needs kind arc, spiral, orbit, points or line`);
  if (t.type === 'ribbon') p.push(...easeProblems(label, t.ease));
  if (t.type === 'sound' && (typeof t.sound !== 'string' || !t.sound)) p.push(`${label}: sound is a ShurikenAudio name or an rbxassetid:// id`);
  if (t.type === 'spawn' && (typeof t.effect !== 'string' || !t.effect)) p.push(`${label}: effect names another effect`);
  if (t.type === 'spawn' && names.has(t.effect)) p.push(`${label}: an effect can't spawn itself`);
  if (t.type === 'decal' && !t.texture) p.push(`${label}: a decal needs a texture`);
  if (t.type === 'debris' && t.count !== undefined && !(t.count >= 1 && t.count <= 40)) p.push(`${label}: debris count must be 1–40 (pieces are parts)`);
  if (t.type === 'shell' && t.shape === 'mesh' && !t.meshId) p.push(`${label}: a mesh shell needs meshId`);
  if (t.type === 'beam' && t.to !== undefined && t.to !== 'target' && !vec3(t.to)) p.push(`${label}: to is [right, up, back] studs or "target"`);
  return p;
}

/**
 * An emitter that says nothing about its transparency fades out over its life. Three effects in one build were
 * refused for leaving the list out ("transparency needs 1–8 values"), each costing its author a round trip.
 */
export function withEmitterDefaults(e: EffectSpec): EffectSpec {
  const fill = (m: Record<string, unknown>): Record<string, unknown> => (m.transparency === undefined ? { ...m, transparency: [0, 1] } : m);
  const any = e as unknown as { emitters?: Array<Record<string, unknown>>; tracks?: Array<Record<string, unknown>> };
  return {
    ...e,
    ...(Array.isArray(any.emitters) ? { emitters: any.emitters.map(fill) } : {}),
    ...(Array.isArray(any.tracks) ? { tracks: any.tracks.map((t) => (t && t.type === 'particles' ? fill(t) : t)) } : {}),
  } as EffectSpec;
}

export function validateEffect(e: EffectSpec): string[] {
  const p: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(e.name)) p.push('name must be letters, digits and _ (start with a letter, ≤ 48 chars)');
  const seq = (label: string, v: unknown[], lo: number, hi: number) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 8) p.push(`${label} needs 1–8 values`);
    else if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi)) p.push(`${label} values must be between ${lo} and ${hi}`);
  };
  const colors = (label: string, v: unknown[]) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 8 || v.some((c) => typeof c !== 'string' || !HEX.test(c))) p.push(`${label} needs 1–8 hex colors like "#ffb454"`);
  };
  if (e.kind === 'burst' || e.kind === 'persistent') {
    if (!e.emitters?.length && !e.tracks?.length) p.push(`a ${e.kind} effect needs emitters or tracks`);
    for (const m of e.emitters ?? []) p.push(...emitterProblems(m, e.kind, `emitter ${m.name}`));
  }
  if (e.tracks !== undefined) {
    if (!Array.isArray(e.tracks)) p.push('tracks must be an array');
    else {
      if (e.tracks.length > 40) p.push(`${e.tracks.length} tracks is too many (40 at most)`);
      e.tracks.forEach((t, i) => p.push(...trackProblems(t, i, new Set([e.name]))));
    }
  }
  if (e.kind === 'trail') {
    if (!e.trail) p.push('a trail effect needs trail');
    else {
      colors('trail color', e.trail.color);
      seq('trail transparency', e.trail.transparency, 0, 1);
      seq('trail width', e.trail.width, 0, 1);
      if (!(e.trail.lifetime > 0 && e.trail.lifetime <= 10)) p.push('trail lifetime must be within 0–10 s');
      if (e.trail.texture && !TEXTURE_REF.test(e.trail.texture)) p.push('trail texture must be rbxasset://…, rbxassetid://… or tex:<Name>');
    }
  }
  if (e.kind === 'beam') {
    if (!e.beam) p.push('a beam effect needs beam');
    else {
      colors('beam color', e.beam.color);
      seq('beam transparency', e.beam.transparency, 0, 1);
      if (e.beam.texture && !TEXTURE_REF.test(e.beam.texture)) p.push('beam texture must be rbxasset://…, rbxassetid://… or tex:<Name>');
    }
  }
  const inline = (e.tracks ?? []).filter((t) => t.type === 'particles').reduce((n, t) => n + ((t as { emit?: number }).emit ?? 0), 0);
  const total = (e.emitters ?? []).reduce((n, m) => n + (m.emit ?? 0), 0) + inline;
  if (total > 600) p.push(`${total} particles per burst is too many for mobile players (keep it under 600)`);
  return [...new Set(p)];
}

/** Every "tex:<Name>" an effect uses. */
export function textureRefs(e: EffectSpec): string[] {
  const out = new Set<string>();
  const add = (t: unknown) => {
    if (typeof t === 'string' && t.startsWith('tex:')) out.add(t.slice(4));
  };
  for (const m of e.emitters ?? []) add(m.texture);
  for (const t of e.tracks ?? []) {
    add((t as { texture?: string }).texture);
    if (t.type === 'ribbon') add(t.trail?.texture);
  }
  add(e.trail?.texture);
  add(e.beam?.texture);
  return [...out];
}
