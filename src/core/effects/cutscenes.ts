import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Curve, Ease } from '@shared/effects';
import { EASES } from '@shared/effects';
import { bezier, catmullRom, easer, len, polyline, sampleCurve, type Path, type Vec3 } from '@shared/curves';

/**
 * Cutscenes as data (effects/cutscenes/<Name>.cutscene.json), played by the generated ShurikenCutscene
 * module: shots move the camera along a path at even speed looking at a point, a moving path, the player
 * or an instance; events fire effects, sounds, animations, subtitles, titles, fades, shakes and signals.
 * `sampleCutscene` computes the camera exactly as the module does, so a shot can be previewed (and
 * screenshotted) without playing it.
 */
export const CUTSCENE_DIR = 'effects/cutscenes';

export interface ShotSpec {
  at?: number;
  duration: number;
  /** Camera positions (world studs) the camera passes through, with how it moves between them. */
  camera: { points: Vec3[]; kind?: 'catmullRom' | 'bezier' | 'linear'; ease?: Ease };
  /** What it looks at: a point, a moving path, "player", or an instance path like "Workspace.Arena.Gate". */
  lookAt?: Vec3 | { points: Vec3[]; kind?: 'catmullRom' | 'bezier' | 'linear' } | string;
  /** Field of view in degrees over the shot (default 70). */
  fov?: Curve;
  /** Roll in degrees over the shot. */
  roll?: Curve;
  /** Handheld drift in studs. */
  drift?: number;
}

export interface CutsceneEvent {
  at: number;
  effect?: string;
  where?: Vec3 | string;
  facing?: Vec3;
  scale?: number;
  sound?: string;
  animation?: string;
  rig?: string;
  line?: string;
  speaker?: string;
  title?: string;
  subtitle?: string;
  fade?: 'in' | 'out';
  color?: string;
  shake?: number;
  seconds?: number;
  signal?: string;
  payload?: unknown;
  /** A signal that still fires when the cutscene is skipped (a gate that must open). */
  always?: boolean;
}

export interface CutsceneSpec {
  name: string;
  description?: string;
  duration?: number;
  letterbox?: number;
  skippable?: boolean;
  skipAfter?: number;
  hideUi?: boolean;
  blockInput?: boolean;
  shots: ShotSpec[];
  events?: CutsceneEvent[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);

export function validateCutscene(c: CutsceneSpec): string[] {
  const p: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(c.name ?? '')) p.push('name must be letters, digits and _ (start with a letter)');
  if (!Array.isArray(c.shots) || !c.shots.length) p.push('a cutscene needs at least one shot');
  (c.shots ?? []).forEach((s, i) => {
    const l = `shot ${i + 1}`;
    if (!isNum(s.duration) || s.duration <= 0 || s.duration > 60) p.push(`${l}: duration must be within 0–60 s`);
    if (s.at !== undefined && (!isNum(s.at) || s.at < 0)) p.push(`${l}: at must be ≥ 0`);
    if (!s.camera || !Array.isArray(s.camera.points) || !s.camera.points.length || !s.camera.points.every(vec3)) p.push(`${l}: camera.points must be [x, y, z] world positions`);
    else if (s.camera.kind === 'bezier' && s.camera.points.length !== 4) p.push(`${l}: a bezier camera takes exactly 4 points (start, two handles, end)`);
    if (s.camera?.ease !== undefined && typeof s.camera.ease === 'string' && !(EASES as readonly string[]).includes(s.camera.ease)) p.push(`${l}: unknown ease ${s.camera.ease}`);
    const look = s.lookAt;
    if (look !== undefined && !vec3(look) && typeof look !== 'string' && !(look && Array.isArray((look as { points?: unknown }).points) && (look as { points: unknown[] }).points.every(vec3))) p.push(`${l}: lookAt is [x, y, z], {points}, "player" or an instance path`);
    if (s.fov !== undefined && (isNum(s.fov) ? s.fov < 5 || s.fov > 120 : false)) p.push(`${l}: fov must be 5–120 degrees`);
  });
  (c.events ?? []).forEach((e, i) => {
    if (!isNum(e.at) || e.at < 0) p.push(`event ${i + 1}: at must be ≥ 0 seconds`);
    if (!(e.effect || e.sound || e.animation || e.line || e.title || e.fade || e.shake || e.signal)) p.push(`event ${i + 1}: needs one of effect, sound, animation, line, title, fade, shake, signal`);
    if (e.where !== undefined && !vec3(e.where) && typeof e.where !== 'string') p.push(`event ${i + 1}: where is [x, y, z], "player" or an instance path`);
  });
  if (c.letterbox !== undefined && !(isNum(c.letterbox) && c.letterbox >= 0 && c.letterbox <= 0.25)) p.push('letterbox is the bar height as a share of the screen (0–0.25)');
  return p;
}

export function cutsceneLength(c: CutsceneSpec): number {
  let length = c.duration ?? 0;
  for (const s of c.shots ?? []) length = Math.max(length, (s.at ?? 0) + s.duration);
  for (const e of c.events ?? []) length = Math.max(length, e.at + (e.seconds ?? 0));
  return length;
}

function pathOf(spec: { points: Vec3[]; kind?: string }): Path {
  if (spec.kind === 'bezier' && spec.points.length === 4) return bezier(spec.points[0]!, spec.points[1]!, spec.points[2]!, spec.points[3]!);
  if (spec.kind === 'linear' || spec.points.length < 3) return polyline(spec.points.length === 1 ? [spec.points[0]!, spec.points[0]!] : spec.points);
  return catmullRom(spec.points);
}

export interface CameraFrame {
  t: number;
  shot: number;
  camera: Vec3;
  /** Where it looks (null for "player" or an instance: only known in the game). */
  look_at: Vec3 | null;
  fov: number;
  roll: number;
}

/** The camera at each time, as ShurikenCutscene computes it (without handheld drift). */
export function sampleCutscene(c: CutsceneSpec, times: number[]): CameraFrame[] {
  const shots = [...(c.shots ?? [])].map((s, i) => ({ s, i, at: s.at ?? 0, path: pathOf(s.camera), look: s.lookAt && typeof s.lookAt === 'object' && !Array.isArray(s.lookAt) ? pathOf(s.lookAt) : null })).sort((a, b) => a.at - b.at);
  const r = (v: number) => Math.round(v * 100) / 100;
  return times.map((t) => {
    const cur = [...shots].reverse().find((x) => x.at <= t) ?? shots[0]!;
    const k = Math.min(1, Math.max(0, (t - cur.at) / cur.s.duration));
    const u = easer(cur.s.camera.ease ?? 'sineInOut')(k);
    const pos = cur.path.at(u);
    const look = cur.look ? cur.look.at(u) : Array.isArray(cur.s.lookAt) ? (cur.s.lookAt as Vec3) : null;
    const lookAt = look ?? (cur.s.lookAt === undefined ? (len(cur.path.tangent(u)) > 0 ? ([pos[0] + cur.path.tangent(u)[0] * 10, pos[1] + cur.path.tangent(u)[1] * 10, pos[2] + cur.path.tangent(u)[2] * 10] as Vec3) : null) : null);
    return { t: r(t), shot: cur.i + 1, camera: pos.map(r) as Vec3, look_at: lookAt ? (lookAt.map(r) as Vec3) : null, fov: r(sampleCurve(cur.s.fov ?? 70, k, 70)), roll: r(sampleCurve(cur.s.roll ?? 0, k, 0)) };
  });
}

/** How fast the camera moves in each shot (studs/s): a fast cut reads as a whip pan, a slow drift as calm. */
export function shotSpeeds(c: CutsceneSpec): Array<{ shot: number; studs: number; perSecond: number }> {
  return (c.shots ?? []).map((s, i) => {
    const p = pathOf(s.camera);
    return { shot: i + 1, studs: Math.round(p.length * 10) / 10, perSecond: Math.round((p.length / s.duration) * 10) / 10 };
  });
}

export interface CutsceneFile {
  cutscene: CutsceneSpec;
  createdBy?: string;
  updatedAt: string;
}

export class CutsceneStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, CUTSCENE_DIR);
  }

  names(): string[] {
    if (!existsSync(this.dir())) return [];
    return readdirSync(this.dir())
      .filter((f) => f.endsWith('.cutscene.json'))
      .map((f) => f.slice(0, -'.cutscene.json'.length))
      .sort((a, b) => a.localeCompare(b));
  }

  get(name: string): CutsceneFile | null {
    const f = join(this.dir(), `${name}.cutscene.json`);
    if (!existsSync(f)) return null;
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as CutsceneFile | CutsceneSpec;
      const file = 'cutscene' in raw ? raw : { cutscene: raw as CutsceneSpec, updatedAt: '' };
      return { ...file, updatedAt: file.updatedAt || statSync(f).mtime.toISOString() };
    } catch {
      return null;
    }
  }

  all(): CutsceneFile[] {
    return this.names()
      .map((n) => this.get(n))
      .filter((f): f is CutsceneFile => !!f && validateCutscene(f.cutscene).length === 0);
  }

  save(cutscene: CutsceneSpec, createdBy?: string): CutsceneFile {
    mkdirSync(this.dir(), { recursive: true });
    const file: CutsceneFile = { cutscene, createdBy, updatedAt: new Date().toISOString() };
    writeFileSync(join(this.dir(), `${cutscene.name}.cutscene.json`), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    return file;
  }

  remove(name: string): boolean {
    const f = join(this.dir(), `${name}.cutscene.json`);
    if (!existsSync(f)) return false;
    rmSync(f);
    return true;
  }
}

