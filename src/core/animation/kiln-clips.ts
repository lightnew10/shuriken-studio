import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateClip, type AnimationClip, type ClipKey, type Priority } from '@shared/animation';
import { parseRig } from '@shared/rig';
import { AnimationStore, type AnimationFile } from './animation-service';

/**
 * Animations authored in Kiln: its export (roblox_export.py) writes every clip of a rigged model to
 * models/<Model>.clips.json, already in Roblox space (a Motor6D.Transform per joint as CFrame.Angles
 * degrees + a pivot offset, keys reduced per joint, events as markers). They become the project's
 * animations like any other (animations/<Name>.anim.json, built by world/Animations.luau, played with
 * the animations module), marked as Kiln's so the next export updates them and a clip deleted in Kiln
 * goes too. Clips for Kiln's R15 rig are ordinary R15 animations.
 */

export interface KilnClip {
  name: string;
  loop: boolean;
  in_place: boolean;
  priority: string;
  /** Studs per second the feet travel (move the model at this speed for in-place movement clips). */
  speed: number | null;
  /**
   * A turning gait (Kiln 0.8.1; "TurnLeft", a curving walk): degrees per second, positive to the model's left. The clip
   * stays in place and the game turns the model at this rate while it plays (a positive yaw in Roblox).
   */
  turn?: number | null;
  fade: number;
  length: number;
  generator: string | null;
  fp: string | null;
  markers: Array<{ t: number; name: string }>;
  keys: ClipKey[];
}

export interface KilnClipsFile {
  version: number;
  model: string;
  kind: 'r15' | 'custom';
  fps: number;
  clips: KilnClip[];
}

/** Where a clip came from, when Kiln made it. */
export interface KilnSource {
  kind: 'kiln';
  model: string;
  clip: string;
  fp: string | null;
  speed: number | null;
  /** Degrees per second the game turns the model while the clip plays (positive: to its left); absent for a clip that doesn't turn. */
  turn?: number;
  inPlace: boolean;
  fade: number;
  generator: string | null;
}

const PRIORITIES = new Set<Priority>(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']);

/** A Kiln clip's name in the project: the model's first (Griever's Walk → GrieverWalk), R15 clips as named. */
export function kilnClipName(model: string, clip: string, kind: 'r15' | 'custom'): string {
  const base = clip.replace(/[^A-Za-z0-9_]/g, '');
  const name = kind === 'r15' || base.toLowerCase().startsWith(model.toLowerCase()) ? base : `${model}${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  return (/^[A-Za-z]/.test(name) ? name : `Anim${name}`).slice(0, 48);
}

export function readKilnClips(root: string, model: string): KilnClipsFile | null {
  const f = join(root, 'models', `${model}.clips.json`);
  if (!existsSync(f)) return null;
  try {
    const o = JSON.parse(readFileSync(f, 'utf8')) as KilnClipsFile;
    return Array.isArray(o?.clips) ? o : null;
  } catch {
    return null;
  }
}

export interface ClipImport {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  problems: Array<{ name: string; problems: string[] }>;
}

/** The project's AnimationClip for a Kiln clip. */
export function toAnimationClip(model: string, kind: 'r15' | 'custom', c: KilnClip): AnimationClip {
  // Kiln offers Roblox's four priorities; a hit reaction and a death left at "Action" go above attacks
  // (Action2, Action4) so they interrupt them, as Shuriken's own creature clips do.
  const base: Priority = PRIORITIES.has(c.priority as Priority) ? (c.priority as Priority) : 'Action';
  const priority: Priority = base === 'Action' && c.generator === 'hit' ? 'Action2' : base === 'Action' && c.generator === 'death' ? 'Action4' : base;
  return {
    name: kilnClipName(model, c.name, kind),
    description: `Made in Kiln: ${model}'s ${c.name}${c.generator ? ` (${c.generator})` : ''}${c.speed ? `; move the model at ${c.speed} studs/s` : ''}${c.turn ? `; turn the model at ${c.turn} degrees/s (positive is to its left) while it plays` : ''}`,
    ...(kind === 'custom' ? { rig: model } : {}),
    loop: !!c.loop,
    priority,
    keys: c.keys,
    markers: (c.markers ?? []).map((m) => ({ t: m.t, name: m.name })),
  };
}

/**
 * Brings a model's Kiln clips into the project's animations. A clip is rewritten only when Kiln's
 * fingerprint changed (an upload stays valid otherwise); clips this model's Kiln export no longer has
 * are removed; animations that aren't Kiln's are never touched (a name clash is reported instead).
 */
export function importKilnClips(root: string, model: string): ClipImport {
  const out: ClipImport = { added: [], updated: [], unchanged: [], removed: [], problems: [] };
  const file = readKilnClips(root, model);
  const store = new AnimationStore(root);
  const mine = (f: AnimationFile | null) => f?.source?.kind === 'kiln' && f.source.model === model;
  const kept = new Set<string>();
  if (file) {
    const kind = file.kind === 'r15' ? 'r15' : 'custom';
    let rig: ReturnType<typeof parseRig> | null = null;
    if (kind === 'custom') {
      try {
        rig = parseRig(JSON.parse(readFileSync(join(root, 'models', `${model}.rig.json`), 'utf8')));
      } catch {
        rig = 'no rig.json';
      }
    }
    for (const c of file.clips) {
      const clip = toAnimationClip(model, kind, c);
      kept.add(clip.name);
      const prev = store.get(clip.name);
      if (prev && !mine(prev)) {
        out.problems.push({ name: clip.name, problems: [`an animation named ${clip.name} already exists that isn't ${model}'s Kiln clip: rename one of them`] });
        continue;
      }
      const problems = validateClip(clip, kind === 'custom' ? (typeof rig === 'string' ? null : rig) : undefined);
      if (problems.length) {
        out.problems.push({ name: clip.name, problems });
        continue;
      }
      if (prev && prev.source?.fp && prev.source.fp === c.fp) {
        out.unchanged.push(clip.name);
        continue;
      }
      const source: KilnSource = { kind: 'kiln', model, clip: c.name, fp: c.fp ?? null, speed: c.speed ?? null, ...(typeof c.turn === 'number' && c.turn ? { turn: c.turn } : {}), inPlace: c.in_place !== false, fade: typeof c.fade === 'number' ? c.fade : 0.2, generator: c.generator ?? null };
      store.save({ clip, createdBy: 'kiln', source });
      (prev ? out.updated : out.added).push(clip.name);
    }
  }
  for (const n of store.names()) {
    if (kept.has(n)) continue;
    const f = store.get(n);
    if (mine(f) && store.remove(n)) out.removed.push(n);
  }
  return out;
}
