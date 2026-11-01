import { colorKeys, curveKeys } from '../curves';
import { TEXTURES, type EffectSpec, type EmitterSpec, type TrackSpec } from '../effects';

/**
 * An effect as the builder and the runtime see it: every particle emitter in one list (the spec's emitters,
 * inline `particles` tracks and the particle shorthands ring, slash and flash), and the tracks the runtime
 * steps (shells, circles, ribbons, beams, lights, sounds, shake, hit-stop, highlights, screen, debris,
 * decals, spawns), ordered by start time.
 */
export interface CompiledEffect {
  emitters: CompiledEmitter[];
  tracks: TrackSpec[];
}

/** An emitter whose curves may be keyed: sequences are [t, value] keypoints over a particle's life. */
export interface CompiledEmitter extends Omit<EmitterSpec, 'size' | 'transparency' | 'color' | 'squash'> {
  size: Array<[number, number]>;
  transparency: Array<[number, number]>;
  color: Array<[number, string]>;
  squash?: Array<[number, number]>;
  delay: number;
}


const even = (v: number[]): Array<[number, number]> => v.map((x, i) => [v.length > 1 ? i / (v.length - 1) : 0, x]);
const evenColors = (v: string[]): Array<[number, string]> => v.map((x, i) => [v.length > 1 ? i / (v.length - 1) : 0, x]);

function fromEmitter(m: EmitterSpec): CompiledEmitter {
  return { ...m, size: even(m.size), transparency: even(m.transparency), color: evenColors(m.color), squash: m.squash ? even(m.squash) : undefined, delay: m.delay ?? 0 };
}

/** The particle shorthands as emitters (their track curves run over the particle's life). */
function sugar(t: TrackSpec, i: number): CompiledEmitter | null {
  const name = t.name ?? `${t.type[0]!.toUpperCase()}${t.type.slice(1)}${i + 1}`;
  const at = t.at ?? 0;
  if (t.type === 'particles') {
    const { type: _type, at: _at, duration: _d, loop: _loop, ...rest } = t;
    return { ...fromEmitter({ ...(rest as unknown as EmitterSpec), name }), delay: at };
  }
  const life = t.duration ?? (t.type === 'flash' ? 0.12 : t.type === 'slash' ? 0.25 : 0.35);
  if (t.type === 'ring') {
    return {
      name,
      texture: t.texture ?? TEXTURES.ring,
      color: colorKeys(t.color ?? '#ffffff'),
      size: curveKeys(t.radius ?? [1, 8], 2),
      transparency: curveKeys(t.transparency ?? [0.1, 1]),
      lifetime: [life, life],
      speed: [0.01, 0.01],
      emit: 1,
      delay: at,
      orientation: 'VelocityPerpendicular',
      direction: t.facing ?? 'Top',
      lightEmission: t.lightEmission ?? 1,
      lightInfluence: 0,
      brightness: t.brightness,
      rotation: [0, 360],
      zOffset: 0.5,
      offset: t.offset,
      turn: t.rotation,
      detail: t.detail,
    };
  }
  if (t.type === 'slash') {
    return {
      name,
      texture: t.texture ?? TEXTURES.ring,
      color: colorKeys(t.color ?? '#ffffff'),
      size: curveKeys(t.size ?? [5, 7]),
      transparency: curveKeys(t.transparency ?? { keys: [[0, 0], [0.55, 0.15], [1, 1]] }),
      lifetime: [life, life],
      speed: [0.01, 0.01],
      emit: 1,
      delay: at,
      orientation: 'VelocityPerpendicular',
      direction: 'Top',
      lightEmission: t.lightEmission ?? 1,
      lightInfluence: 0,
      brightness: t.brightness,
      rotation: [t.spin ?? 0, t.spin ?? 0],
      flipbook: t.flipbook ? { ...t.flipbook, mode: t.flipbook.mode ?? 'OneShot' } : undefined,
      zOffset: 0.5,
      offset: t.offset,
      turn: t.rotation,
      detail: t.detail,
    };
  }
  if (t.type === 'flash') {
    return {
      name,
      texture: t.texture ?? TEXTURES.flash,
      color: colorKeys(t.color ?? '#fff8e6'),
      size: curveKeys(t.size ?? [2, 4]),
      transparency: curveKeys(t.transparency ?? [0, 1]),
      lifetime: [life, life],
      speed: [0, 0],
      emit: 1,
      delay: at,
      lightEmission: 1,
      lightInfluence: 0,
      brightness: t.brightness ?? 2,
      rotation: [0, 360],
      zOffset: 1,
      offset: t.offset,
      turn: t.rotation,
      detail: t.detail,
    };
  }
  return null;
}

export function compileEffect(e: EffectSpec): CompiledEffect {
  const emitters = (e.emitters ?? []).map(fromEmitter);
  const tracks: TrackSpec[] = [];
  (e.tracks ?? []).forEach((t, i) => {
    const m = sugar(t, i);
    if (m) emitters.push(m);
    else tracks.push(t);
  });
  tracks.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { emitters, tracks };
}
