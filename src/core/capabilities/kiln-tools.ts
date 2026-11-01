import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import { KilnHttpError, type KilnModeling } from '../modeling/kiln-modeling';
import type { ModelingBackend } from '../modeling/backend';
import { AnimationStore } from '../animation/animation-service';
import { AnimationRebuilder, type AnimationRebuild } from '../animation/animation-rebuild';
import { kilnClipName, readKilnClips } from '../animation/kiln-clips';
import { ModelStore } from '../modeling/model-store';
import { KILN_FIELDS_VERSION, KILN_PARTS_VERSION, briefBody, renderBrief, type FitSpec, type KilnBriefSpec, type MemberSpec } from '../modeling/kiln-brief';
import { FAMILY_NAME, SOCKETS_MODULE, SOCKETS_SPEC_TITLE, familyOfModel, listFamilies, readFamily, readStyle, writeFamily, writeStyle, type FamilyRecord } from '../modeling/kiln-family';
import { roleLabel } from '../agents/roles';
import { errorOutput, jsonOutput, type CallerContext, type ToolProgress, type ToolRegistry } from './tool-registry';
import { newId } from '@shared/ids';
import { waitBudget } from '../roblox/upload-queue';
import { estimateBuild, type BuildEnd, type KilnBuild } from '../modeling/kiln-queue';
import { parseChecks } from '../modeling/kiln-family';
import { parseCheck } from '../modeling/kiln-manifest';
import { registerRoleLabel } from '../agents/roles';

/**
 * Kiln (the user's Blender copilot app, docked in Shuriken) as a source of custom animation: its own
 * copilot rigs and animates creatures and characters on real armatures; these tools brief it, follow
 * its turn, run its clip operations, and bring the model's parts, rig and clips into the project
 * (models/, animations/), where the animation workshop builds, checks, views and uploads them like any
 * other clip.
 */

export interface KilnToolDeps {
  project: () => ProjectContext | null;
  /** Kiln's client and the modeling service that exports its models (null where Kiln can't be used, e.g. tests). */
  kiln: () => KilnModeling | null;
  /** Whichever engine holds a model (Kiln or Shuriken's own Blender): Kiln's animation helpers run in both. */
  modeling: () => ModelingBackend;
  bus: EventBus;
}

interface KilnProject {
  id: string;
  title: string;
  units?: 'm' | 'studs';
  linked?: { app: string; model: string; project?: string };
  open?: boolean;
  working?: boolean;
  updatedAt?: string;
}

/** What Kiln (0.7.3) hands over when a turn ends: the facts of the result, to be read instead of prescribed. */
export interface KilnDelivery {
  size?: number[];
  units?: string;
  objects?: number;
  tris?: number;
  joints?: number;
  /** `turn` (degrees per second, positive to the model's left) is on turning gaits: the clip stays in place and the game turns the model at that rate. */
  clips?: Array<{ name: string; length?: number | null; loop?: boolean | null; in_place?: boolean | null; speed?: number | null; turn?: number | null; priority?: string | null; markers?: Array<{ name: string; time: number }> }>;
  renders?: string[];
}

interface Turn {
  projectId: string;
  turnId: string;
  /** "queued" (Kiln 0.8.2): behind the turn its project is busy with. */
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  reply?: string;
  clips?: string[];
  effort?: string | null;
  effortWhy?: string | null;
  kind?: string | null;
  delivery?: (KilnDelivery & { models?: unknown; fit?: unknown; checks?: unknown }) | null;
  /** While it runs (Kiln 0.8.2): the copilot's plan, the step in hand, a rough time left, the newest render. */
  progress?: { steps?: { done?: number; total?: number } | null; current?: string | null; tool?: string | null; lastRender?: string | null; elapsedMs?: number; etaMs?: number | null } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A pause that ends at once when the signal aborts (a build that is stopped doesn't sit out its poll). */
const nap = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** How a build is followed: how often its turn is asked about, how long a busy project is waited for, the longest a build may take, how often a waiting call says so (tests shorten them). */
export const KILN_BUILD = { pollMs: 4000, busyPollMs: 5000, busyWaitMs: 10 * 60_000, maxMs: 60 * 60_000, lostPolls: 30, noteMs: 15_000 };
/** A failure that says nothing about load: the account is out of usage. */
const USAGE_RX = /usage limit|rate.?limit|out of (extra )?usage|limit (reached|exceeded)/i;
/** The states a turn ends in; anything else (running, or queued behind another turn on Kiln 0.8.2) is still going. */
const ENDED = new Set(['done', 'failed', 'stopped']);

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_IMAGE = 8 * 1024 * 1024;

/** A reference image for Kiln's chat (a data URL): a file of the project, or an https URL. */
export async function referenceImage(root: string, ref: string): Promise<{ name: string; dataUrl: string }> {
  if (/^https:\/\//i.test(ref)) {
    const r = await fetch(ref, { signal: AbortSignal.timeout(15_000), headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } });
    if (!r.ok) throw new Error(`${r.status} from ${new URL(ref).host}`);
    const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!Object.values(IMAGE_TYPES).includes(type)) throw new Error(`not a png, jpg, webp or gif (${type || 'no type'})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('over 8 MB');
    return { name: basename(new URL(ref).pathname) || 'reference', dataUrl: `data:${type};base64,${buf.toString('base64')}` };
  }
  const abs = resolve(root, ref);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error("not a file of this project (give a project file or an https URL)");
  const type = IMAGE_TYPES[extname(abs).slice(1).toLowerCase()];
  if (!type) throw new Error('not a png, jpg, webp or gif');
  if (!existsSync(abs)) throw new Error('no such file');
  if (statSync(abs).size > MAX_IMAGE) throw new Error('over 8 MB');
  return { name: basename(abs), dataUrl: `data:${type};base64,${readFileSync(abs).toString('base64')}` };
}

/** What survives the trip into Roblox (Shuriken's export), so Kiln designs for it instead of being told how. Only for Kiln before 0.7.3: from 0.7.3 Kiln's own Roblox rules apply. */
export const ROBLOX_TARGET =
  'Where it goes: a Roblox game — Shuriken brings it into Roblox Studio when your turn ends. Design for what survives that trip: image textures (painted or baked, up to 1024 px; procedural node textures only come through baked to images), one Roblox part per material (keep to a handful), about 10,000 triangles per material, a rig becomes rigid pieces per bone (no skin deformation in Roblox yet), clips at 30 fps with events such as Hit and Step. Roblox lights the model itself, so keep colours at a plausible brightness (flesh and hide about 0.3–0.5 mean; the mood comes from the game\'s lighting, never from darkened textures) and make wet surfaces low roughness (a Principled Coat is folded into roughness; Sheen, Subsurface, a bump without a normal map and an Ambient Occlusion node are not shown).';

/**
 * What Kiln's copilot gets: the goal as the agent wrote it, what to research, and the Roblox
 * constraints — then the design and craft are Kiln's call. A specific existing subject (a film's
 * creature, a real animal) gets Kiln's research phase explicitly instead of leaving it to chance.
 */
export function kilnBrief(text: string, references?: string, images = 0): string {
  const out = [text.trim()];
  if (images) out.push(images === 1 ? 'The attached image is a reference: match it (it wins over anything you find).' : `The ${images} attached images are references: match them (they win over anything you find).`);
  const refs = references?.trim();
  if (refs)
    out.push(
      `Research first: before the blockout, do your research phase for ${refs} — search the web and make a reference_images sheet — then study it for silhouette, proportions, signature features, materials and colours, and build to match it closely (your own model: no logos or text). Tell me in one line what you took from the references.`,
    );
  else if (!images) out.push('If this names a specific existing subject (a creature or character from a film, show, game or book; a real animal, vehicle or landmark), do your research phase first and build to match the reference images.');
  out.push(ROBLOX_TARGET);
  out.push('The goal and those constraints are what matter. The design, anatomy, proportions, materials, modeling technique, rig layout and animation craft are your call: do what gets the best result for the goal, not a literal reading of every detail above.');
  return out.join('\n\n');
}

/**
 * The brief for Kiln 0.7.3 and newer: the agent's goals exactly as written. Kiln frames the request (its kind), researches
 * a named subject first, and owns the Roblox rules, so Shuriken adds no Roblox paragraph, no research line and no "your
 * call" line. `references` (the subject to research) becomes one plain sentence.
 */
export function kilnGoalBrief(text: string, references?: string): string {
  return renderBrief({ text, references });
}

/** A turn's delivery for an agent: the facts, without the mesh lists and 4x4 matrices of Kiln 0.8.2's models (Shuriken reads those back itself). */
function slimDelivery(d: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(d.models)) return d;
  const models = (d.models as Array<Record<string, unknown>>).map((m) => {
    const { objects: _objects, min: _min, max: _max, ...rest } = m;
    return { ...rest, ...(Array.isArray(m.sockets) ? { sockets: (m.sockets as Array<Record<string, unknown>>).map((s) => ({ name: s.name, mates: s.mates, position: s.position })) } : {}) };
  });
  return { ...d, models };
}

/**
 * How much a build is worth. In the user's test a 2,900-character brief for a low-poly forge (four sockets, a
 * triangle budget, exact size, a must-have list) ran 37 minutes at max effort; Kiln makes such a prop in minutes
 * from two loose sentences. So a build says how much it matters, and Shuriken sends an effort and a brief to match:
 * quick is the default for props, dressing and anything blocky or low-poly.
 */
export type KilnDetail = 'quick' | 'standard' | 'hero';
/** The effort sent with a brief (Kiln raises what is under its own floor). Never max unless the caller says so. */
export const KILN_EFFORT: Record<KilnDetail, string> = { quick: 'low', standard: 'high', hero: 'xhigh' };
/** From this Kiln a brief may say `quick: true`: build in one call, one fast look, fix only what is plainly wrong, stop (no research, no pretty renders). Measured by Kiln: a low-poly forge in 61 s. */
export const KILN_QUICK_VERSION = '0.8.4';
/** kiln_builds answers in brief when it covers more builds than this, with this much of each reply. */
export const BRIEF_ABOVE = 2;
export const BRIEF_REPLY = 280;
/**
 * The longest brief text a new build or rework may carry, in characters: Kiln decides the design. Half of what 1.12
 * allowed (500 / 1,100 / 2,400): the best quick prop Kiln measured came from 178 characters in about a minute. Only
 * the prose counts: sockets, parts, the models of a family and the style are fields.
 */
export const KILN_BRIEF_LIMIT: Record<KilnDetail, number> = { quick: 280, standard: 600, hero: 1200 };

/** What a build is worth when the caller doesn't say: quick, unless it is a family, has sockets, or names a subject to research. */
export function kilnDetail(args: { detail?: KilnDetail; family?: string; sockets?: unknown[]; references?: string; kind?: string }): KilnDetail {
  if (args.detail) return args.detail;
  return args.family || args.sockets?.length || args.references?.trim() || args.kind === 'animate' ? 'standard' : 'quick';
}

/** Why a brief is too long for its level, or null. */
export function briefTooLong(text: string, detail: KilnDetail): string | null {
  const n = text.trim().length;
  const max = KILN_BRIEF_LIMIT[detail];
  if (n <= max) return null;
  return `The brief is ${n} characters; a ${detail} build takes at most ${max}. Kiln decides the design: say what it is, what it is for, and one phrase for its look. Drop whole sentences, adjectives first and game facts (front, pivot, clip names) last; size, sockets, parts, a family's models and the style go in their fields, not in the text, and the game's premise is not repeated in every brief. ${detail === 'hero' ? '' : `If this really is ${detail === 'quick' ? 'more than a simple prop, pass detail: "standard" (or "hero" for a centrepiece)' : 'the game\'s centrepiece, pass detail: "hero"'}.`}`.trim();
}

/** A brief that asks for a hand-held tool's grip in words, and the socket that stands for it. */
export const GRIP_IN_TEXT = /\bGrip\b|\bgrip (attachment|socket|point)\b/;
export const GRIP_SOCKET = { name: 'Grip', joins: 'the hand holding it', where: 'on the handle, where the fist closes' };

/** Who Kiln's chat shows the request is from. */
export const kilnFrom = (caller: CallerContext): string => (caller.kind === 'ui' || !caller.role ? 'Shuriken' : `Shuriken ${roleLabel(caller.role)}`).slice(0, 80);

export function registerKilnTools(reg: ToolRegistry, d: KilnToolDeps): void {
  const proj = () => {
    const p = d.project();
    if (!p) throw new Error('No project is open');
    return p;
  };
  const kiln = () => {
    const k = d.kiln();
    if (!k) throw new Error('Kiln is not available here');
    return k;
  };
  // A Kiln that isn't running is not "unavailable": the call starts it (or names the fallback), see `up`.
  const available = () => {
    const k = d.kiln();
    return !k || process.env.SHURIKEN_NO_KILN === '1' ? { ok: false, reason: 'Kiln is not available in this setup' } : { ok: true };
  };
  /** Kiln answering for this call: started in the background when it is installed but not running. Null, or why it can't be reached. */
  const up = async (): Promise<string | null> => {
    const r = await kiln().ensureRunning();
    return r.ok ? null : r.reason;
  };
  const unreachable = (why: string) => `Kiln can't be reached (${why.replace(/[.\s]+$/, '')}). The user can start it from the Kiln page (the flame in the top bar).`;
  /** How often Kiln's turn failed on a model in this session (the second time opens the Blender fallback for it). */
  const failures = new Map<string, number>();
  registerRoleLabel('kiln', 'Kiln build');
  /** This project's models linked to Kiln projects: model → Kiln project id. */
  const linked = (p: ProjectContext): Record<string, string> => {
    const dir = join(p.root, '.shuriken', 'kiln');
    const out: Record<string, string> = {};
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const model = f.slice(0, -5);
      const id = kiln().linkedProject(p.root, model);
      if (id) out[model] = id;
    }
    return out;
  };
  /** The Kiln project for a call: kiln_project as given, or the model's (made and linked when `create`; `created` says it was made now). */
  const target = async (p: ProjectContext, args: { model?: string; kiln_project?: string }, create: boolean): Promise<{ id: string; model: string | null; created: boolean }> => {
    if (args.kiln_project) {
      const model = Object.entries(linked(p)).find(([, id]) => id === args.kiln_project)?.[0] ?? null;
      return { id: args.kiln_project, model, created: false };
    }
    if (!args.model) throw new Error('Give model (a model of this game) or kiln_project (a Kiln project id from kiln_status).');
    const id = kiln().linkedProject(p.root, args.model);
    if (id) return { id, model: args.model, created: false };
    if (!create) throw new Error(`${args.model} has no Kiln project yet (kiln_request makes one, or import one with kiln_import {kiln_project}).`);
    return { id: await kiln().projectFor(p.root, args.model), model: args.model, created: true };
  };
  /** The families (or models) a request is fitted against, with their Kiln projects: they must exist, since Kiln brings a part of them in. */
  const fitsOf = (p: ProjectContext, names: string[], self: string): FitSpec[] =>
    names
      .filter((n) => n !== self)
      .map((n) => {
        const rec = familyOfModel(p.root, n);
        if (rec) return { name: rec.family, projectId: rec.projectId, members: rec.members.map((m) => m.name), sockets: rec.sockets.map((s) => s.name) };
        const id = kiln().linkedProject(p.root, n);
        if (id) return { name: n, projectId: id, members: [n], sockets: [] };
        throw new Error(`fits: ${n} has no Kiln project yet. It has to be built first (kiln_request for ${n}); a family that is fitted against another one is built after it.`);
      })
      .filter((f, i, all) => all.findIndex((x) => x.projectId === f.projectId) === i);
  type RequestArgs = { model?: string; kiln_project?: string; family?: string; models?: Array<string | MemberSpec>; fits?: string[]; sockets?: FamilyRecord['sockets']; tris?: number; size?: [number, number, number] };
  /**
   * What a request is for: one model (its own Kiln project), or a family (parts that must fit together or
   * match, built in ONE Kiln project, each member its own model in the game). The family's record keeps
   * its members, sockets and what it is fitted against as data.
   */
  const plan = async (p: ProjectContext, args: RequestArgs): Promise<{ id: string; model: string | null; created: boolean; rec: FamilyRecord | null; fits: FitSpec[] }> => {
    const members = (args.models ?? []).map((m) => (typeof m === 'string' ? { name: m } : m));
    const bad = members.find((m) => !FAMILY_NAME.test(m.name));
    if (bad) throw new Error(`models: "${bad.name}" isn't a model name (letters, digits and _, starting with a letter).`);
    if (!args.family) {
      if (members.length) throw new Error('models goes with family: several models in one Kiln project are a family (family: "MechTorsos", models: ["Torso_Light", …]). One model alone is model.');
      const t = await target(p, args, true);
      const mine = t.model ? familyOfModel(p.root, t.model) : null;
      const fits = fitsOf(p, args.fits ?? (mine?.family === t.model ? mine.fits : []), t.model ?? '');
      // A model with sockets is a family of one: the same record, the same read-back.
      if (t.model && (!mine || mine.family === t.model) && (args.sockets?.length || mine)) {
        const rec: FamilyRecord = { ...(mine ?? {}), family: t.model, projectId: t.id, members: [{ name: t.model, ...(args.size ? { size: args.size } : {}) }], fits: fits.map((f) => f.name), sockets: args.sockets ?? mine?.sockets ?? [], ...(args.tris ?? mine?.tris ? { tris: args.tris ?? mine?.tris } : {}) };
        writeFamily(p.root, rec);
        return { ...t, rec, fits };
      }
      return { ...t, rec: mine, fits };
    }
    if (args.model || args.kiln_project) throw new Error('Give family (with models) or model, not both: a family is one Kiln project holding several models.');
    if (!FAMILY_NAME.test(args.family)) throw new Error(`family: "${args.family}" isn't a name (letters, digits and _, starting with a letter).`);
    const before = readFamily(p.root, args.family);
    if (!before && members.length < 2) throw new Error('A family is two or more models built in one Kiln project so they fit and match: give models (the name each has in the game), e.g. models: ["Torso_Light", "Torso_Medium", "Torso_Heavy"]. One model alone is kiln_request {model}.');
    const taken = members.find((m) => m.name === args.family || (familyOfModel(p.root, m.name)?.family ?? args.family) !== args.family);
    if (taken) throw new Error(taken.name === args.family ? `The family and one of its models are both called ${taken.name}: give the family its own name (${taken.name}Set).` : `${taken.name} already belongs to the family ${familyOfModel(p.root, taken.name)!.family}.`);
    const fits = fitsOf(p, args.fits ?? before?.fits ?? [], args.family);
    const existing = kiln().linkedProject(p.root, args.family);
    const id = existing ?? (await kiln().projectFor(p.root, args.family));
    // Models named now join the ones the family has (a later brief can add a variant).
    const all = [...(before?.members ?? []).filter((m) => !members.some((x) => x.name === m.name)), ...members];
    const rec: FamilyRecord = { ...(before ?? {}), family: args.family, projectId: id, members: all, fits: fits.map((f) => f.name), sockets: args.sockets ?? before?.sockets ?? [], ...(args.tris ?? before?.tris ? { tris: args.tris ?? before?.tris } : {}) };
    writeFamily(p.root, rec);
    return { id, model: args.family, created: !existing, rec, fits };
  };
  /**
   * The place's animations follow the clip files: when clips change (Kiln's coming in while the user
   * animates, an agent's kiln_clip, an import) Studio's ShurikenAnimations are built again — the same build
   * animation_build runs — a moment later, and a tool that brought clips in waits for it (a little) to say
   * whether Studio was updated.
   */
  const rebuilder = new AnimationRebuilder({
    ready: () => (d.project() ? (reg.get('animation_build')?.available?.() ?? { ok: false, reason: 'the animation tools are not available' }) : { ok: false, reason: 'no project is open' }),
    build: () => reg.invoke('animation_build', {}, { kind: 'ui', runId: null, taskId: null, role: 'user', providerId: null, allowedTools: null }),
  });
  d.bus.on('animations.changed', (e) => {
    if (e.stale) rebuilder.schedule();
  });
  const refreshStudio = async (): Promise<AnimationRebuild> => {
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<AnimationRebuild>((resolve) => {
      timer = setTimeout(() => resolve({ updated: false, note: 'Still rebuilding the animations in Studio; it carries on by itself (animation_list shows them).' }), 45_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([rebuilder.now(), slow]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** What the project has from a model's Kiln clips (their names here, speeds, markers). */
  const imported = (p: ProjectContext, model: string) => {
    const file = readKilnClips(p.root, model);
    const store = new AnimationStore(p.root);
    return (file?.clips ?? []).map((c) => {
      const name = kilnClipName(model, c.name, file!.kind);
      const f = store.get(name);
      return { kiln: c.name, name, inProject: !!f && f.source?.kind === 'kiln', loop: c.loop, length: c.length, speed: c.speed, ...(c.turn ? { turn: c.turn } : {}), markers: c.markers.map((m) => `${m.name}@${m.t}s`), uploaded: !!f && !!store.summary(f).uploaded };
    });
  };
  /**
   * A project that is a MAP (a layout that places pieces built in their own projects) is not published as
   * one model: the ordinary bake would turn its placements into geometry, and kiln_layout_import would bake
   * and export it all again its own way (plain materials, the pieces cloned). Its placements, when it is one.
   */
  const layoutOf = async (id: string): Promise<number> => {
    if (!kiln().kiln.supports('0.8.0')) return 0;
    try {
      const r = (await kiln().kiln.get(`/api/v1/projects/${id}/roblox`, 60_000)) as { check?: unknown };
      return parseCheck(r.check).layout?.placements ?? 0;
    } catch {
      return 0;
    }
  };
  const bringIn = async (p: ProjectContext, id: string, model: string | null, name?: string) => {
    const placements = await layoutOf(id);
    if (placements > 0) {
      const what = model ?? name ?? id;
      return { ok: true as const, layout: true as const, model: what, placements, next: `${what} is a map (${placements} placed pieces): kiln_layout_import {${model ? `model: "${model}"` : `kiln_project: "${id}"`}} brings it into the game (its ground and roads, each piece once with its placements, markers and paths); call it again while it says done: false.` };
    }
    const r = await kiln().importFromKiln(p.root, id, model ?? name ?? '');
    if (!r.ok) return { ok: false as const, error: r.error ?? 'import failed' };
    const m = r.name ?? model ?? name ?? '';
    d.bus.emit('assets.changed', {});
    if (r.family) {
      const f = r.family;
      return {
        ok: true as const,
        family: f.family,
        parts: r.parts ?? 0,
        models: Object.fromEntries(Object.entries(f.models).map(([n, x]) => [n, { size: x.size, tris: x.tris, parts: x.parts, sockets: Object.fromEntries(Object.entries(x.sockets).map(([s, v]) => [s, v.position])) }])),
        ...(f.missing.length ? { missing: f.missing } : {}),
        socketSpread: f.spread,
        ...(f.fit ? { fit: { ok: f.fit.ok, summary: f.fit.summary, ...(f.fit.pairs.some((x) => !x.ok) ? { failing: f.fit.pairs.filter((x) => !x.ok).map((x) => `${x.child}.${x.mate} on ${x.parent}.${x.socket}${x.problem ? `: ${x.problem}` : ''}`) } : {}) } } : {}),
        ...(f.problems.length ? { problems: f.problems } : {}),
        next: f.problems.length
          ? `Kiln's result misses what the game needs (problems): send them back as one request, kiln_request {family: "${f.family}", kind: "fix", text: the problems}.`
          : `Each is a model of the game now (model_view, model_place). Their sizes and sockets are in the spec section "${SOCKETS_SPEC_TITLE}" and in the ${SOCKETS_MODULE} module: code attaches parts by them, never by numbers typed from a task.`,
      };
    }
    d.bus.emit('animations.changed', {});
    const rig = new ModelStore(p.root).rig(m);
    const animations = imported(p, m);
    // The clip files and world/Animations.luau are current; Studio keeps the old keys until it is built again.
    const studio = animations.length || r.clips?.removed.length ? await refreshStudio() : null;
    return {
      ok: true as const,
      model: m,
      parts: r.parts ?? 0,
      rig: rig ? { joints: rig.joints.length, legs: rig.legs.length, attachments: rig.attachments.map((a) => `${a.name} on ${a.part}`) } : null,
      clips: r.clips ? { added: r.clips.added, updated: r.clips.updated, removed: r.clips.removed, problems: r.clips.problems } : null,
      animations,
      // A model asked for with sockets: where Kiln put them (its own space, studs), also in the spec and the sockets module.
      ...(readFamily(p.root, m)?.read?.members[m] ? { sockets: Object.fromEntries(Object.entries(readFamily(p.root, m)!.read!.members[m]!.sockets).map(([s, v]) => [s, v.position])) } : {}),
      ...(studio ? { studio } : {}),
      next: rig
        ? `rig_build {model: "${m}"} builds its rig in Studio (uploads the parts); the clips are project animations now (animation_list)${studio?.updated ? ' and built into Studio' : ''} — animation_view shows one, animation_check {name} checks it on the rig in Studio.`
        : 'Not rigged: rig it in Kiln (kiln_request) for animation.',
    };
  };

  // ---- Builds: a brief, its turn followed to the end, the result brought in. They run in Shuriken's queue, whoever waits. ----

  /** What Kiln's transcript says the turn cost (its reply carries the usage), or null: Kiln's turn info itself has no cost. */
  const turnCost = async (projectId: string, turnId: string): Promise<number | null> => {
    try {
      const st = (await kiln().kiln.get(`/api/v1/projects/${projectId}/state`, 20_000)) as { messages?: Array<{ id?: string; usage?: { costUsd?: number } }> };
      const cost = st.messages?.find((m) => m.id === turnId)?.usage?.costUsd;
      return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
    } catch {
      return null;
    }
  };
  /**
   * A finished build as a run of the project (role "kiln"): a Kiln build is an Opus turn on the user's
   * subscription, so its time and cost stand with the agents' in the run list, the task's runs and the report's totals.
   */
  const recordRun = (p: ProjectContext, b: KilnBuild): void => {
    const store = (p as { store?: { run: (sql: string, args: unknown[]) => unknown } }).store;
    if (!store || !b.turn || !b.startedAt) return;
    const row = (taskId: string | null) => [newId('run'), taskId, 'kiln', 'kiln', b.effort ? `Kiln copilot (${b.effort})` : 'Kiln copilot', b.state === 'done' ? 'completed' : b.state === 'stopped' ? 'interrupted' : 'failed', new Date(b.startedAt!).toISOString(), new Date(b.endedAt ?? Date.now()).toISOString(), b.costUsd ?? 0, 1, `Kiln ${b.kind === 'fix' ? 'fixed' : b.kind === 'animate' ? 'animated' : 'built'} ${b.name}`, b.error];
    const sql = 'INSERT INTO runs (id, task_id, role, provider_id, model, status, started_at, ended_at, cost_usd, num_turns, result_summary, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    try {
      store.run(sql, row(b.taskId));
    } catch {
      try {
        // The task is gone: the cost still counts.
        store.run(sql, row(null));
      } catch {
        /* a project that is closing: nothing to count it in */
      }
    }
  };
  type Planned = Awaited<ReturnType<typeof plan>>;
  /** One build, as the queue runs it. */
  const buildJob =
    (p: ProjectContext, t: Planned, body: Record<string, unknown>, sent: Record<string, unknown>, family: boolean, onSent: () => void, started?: { turnId: string; effort: string | null }) =>
    async (b: KilnBuild, signal: AbortSignal): Promise<BuildEnd<Record<string, unknown>>> => {
      const km = kiln();
      const k = km.kiln;
      const step = (s: string) => {
        b.step = s;
        km.builds.touch();
      };
      const work = async (): Promise<BuildEnd<Record<string, unknown>>> => {
        // 1. The brief. A project busy with the user's own turn is waited for (Kiln before 0.8.2 answers 409).
        step('Sending the brief');
        let effortWhy: string | null = null;
        const busyUntil = Date.now() + KILN_BUILD.busyWaitMs;
        if (started) {
          b.turn = started.turnId;
          b.effort = started.effort;
        }
        while (!b.turn) {
          try {
            // The place's lighting, again when it changed since it was last sent.
            if (k.supports()) await km.syncTarget(p.root, t.model, t.id);
            const r = (await k.post(`/api/v1/projects/${t.id}/chat`, body, 60_000)) as { ok?: boolean; turnId?: string; error?: string; effort?: string | null; effortWhy?: string | null };
            if (!r.ok || !r.turnId) return { state: 'failed', error: `Kiln didn't take the request: ${r.error ?? 'no turn id'}`, evidence: { unrelated: true } };
            b.turn = r.turnId;
            b.effort = r.effort ?? null;
            effortWhy = r.effortWhy ?? null;
            break;
          } catch (e) {
            const status = e instanceof KilnHttpError ? e.status : 0;
            if (status === 409 && Date.now() < busyUntil && !signal.aborted) {
              step("Waiting: its Kiln project is busy with another turn (the user's own)");
              onSent();
              await nap(KILN_BUILD.busyPollMs, signal);
              continue;
            }
            if (status === 409) return { state: 'failed', error: "Kiln's copilot is already working on that project (the user is building in it); try again when it finishes.", evidence: { unrelated: true } };
            // 503: Kiln has no Blender to give it. With several builds running that is a sign of load.
            if (status === 503) return { state: 'failed', error: `Kiln refused the brief (503: ${(e as Error).message})`, evidence: { refused: true } };
            return { state: 'failed', error: `Kiln: ${(e as Error).message}`, evidence: { unrelated: status >= 400 && status < 500 } };
          }
        }
        onSent();
        // 2. The turn, to its end (a turn stays "running" until its delivery is in).
        step("Kiln's copilot is building");
        const t0 = Date.now();
        let turn: Turn | null = null;
        let lost = 0;
        while (!signal.aborted && Date.now() - t0 < KILN_BUILD.maxMs) {
          turn = (await k.get(`/api/v1/projects/${t.id}/turns/${b.turn}`, 15_000).catch(() => null)) as Turn | null;
          if (turn && ENDED.has(turn.state)) break;
          lost = turn ? 0 : lost + 1;
          if (lost >= KILN_BUILD.lostPolls) break;
          // How far the copilot is (Kiln 0.8.2): its plan's steps, the step in hand, a rough time left.
          if (turn?.state === 'queued') step("Waiting in Kiln: its project's copilot is busy with another turn");
          else if (turn?.progress) {
            const pr = turn.progress;
            const done = typeof pr.steps?.done === 'number' ? pr.steps.done : null;
            const total = typeof pr.steps?.total === 'number' ? pr.steps.total : null;
            b.progress = { done, total, current: pr.current ?? null, etaMs: typeof pr.etaMs === 'number' ? pr.etaMs : null, lastRender: pr.lastRender ?? null };
            const said = `${pr.current?.trim() || "Kiln's copilot is building"}${total ? ` (step ${Math.min(total, (done ?? 0) + 1)} of ${total}${b.progress.etaMs !== null ? `, about ${Math.max(1, Math.round(b.progress.etaMs / 60_000))} min left` : ''})` : ''}`;
            if (said !== b.step) step(said);
          }
          await nap(KILN_BUILD.pollMs, signal);
        }
        const turnMs = Date.now() - t0;
        const later = `kiln_import {${family ? 'kiln_project' : 'model'}: "${family ? t.id : t.model}"} brings its result in when Kiln is done`;
        if (signal.aborted) return { state: 'stopped', error: `Shuriken stopped following it; ${later}.`, evidence: { unrelated: true } };
        if (!turn || !ENDED.has(turn.state))
          return lost >= KILN_BUILD.lostPolls
            ? { state: 'failed', error: `Kiln stopped answering while it built ${b.name}; ${later}.`, evidence: { unrelated: true } }
            : { state: 'failed', error: `Kiln was still building ${b.name} after ${Math.round(KILN_BUILD.maxMs / 60_000)} min; ${later}.`, evidence: { turnMs } };
        b.effort = turn.effort ?? b.effort;
        b.costUsd = await turnCost(t.id, b.turn);
        const facts = { kilnProject: t.id, turn: b.turn, ...sent, effort: b.effort, effortWhy: turn.effortWhy ?? effortWhy, ...(b.costUsd !== null ? { costUsd: Math.round(b.costUsd * 100) / 100 } : {}), minutes: Math.round(turnMs / 6000) / 10 };
        if (turn.state !== 'done') {
          // A turn Kiln fails twice on the same model opens the fallback for it; a stopped one (the user's own Stop) doesn't.
          const said = `Kiln's turn ended ${turn.state}${turn.reply ? `: ${turn.reply.slice(0, 1200)}` : ''}`;
          const unrelated = turn.state === 'stopped' || USAGE_RX.test(turn.reply ?? '');
          if (turn.state !== 'failed' || !t.model) return { state: turn.state === 'stopped' ? 'stopped' : 'failed', error: said, evidence: { unrelated, turnMs } };
          const n = (failures.get(t.model) ?? 0) + 1;
          failures.set(t.model, n);
          if (n < 2) return { state: 'failed', error: `${said}\nAsk again (kiln_request {${family ? 'family' : 'model'}: "${t.model}", kind: "rework"}); if Kiln fails on it again, blender_python takes it as the fallback.`, evidence: { unrelated, turnMs } };
          const names = family ? (t.rec?.members ?? []).map((m) => m.name) : [t.model];
          for (const name of names) km.fallbackTo(p.root, name, 'Kiln failed on it twice');
          return { state: 'failed', error: `${said}\nKiln failed on ${t.model} twice. Fallback: build ${names.join(', ')} yourself with blender_python, and start your result with the line "Kiln couldn't build ${names.join(', ')}, so I modeled ${names.length === 1 ? 'it' : 'them'} in Blender myself."`, evidence: { unrelated, turnMs } };
        }
        if (t.model) failures.delete(t.model);
        // 3. Into the game: Kiln's bake, Shuriken's export, the sizes and sockets read back, the brief's requirements as Kiln checked them.
        step('Bringing the result into the game');
        km.noteDelivery(t.id, turn.delivery);
        const r = await bringIn(p, t.id, t.model);
        // The game's style sheet, once a build's copilot has saved it (Kiln 0.8.2): the project keeps a copy.
        if (k.supports(KILN_FIELDS_VERSION)) await km.styleSheet(p.root).catch(() => undefined);
        const failed = parseChecks(turn.delivery?.checks).filter((c) => !c.ok);
        const result = {
          ...facts,
          reply: (turn.reply ?? '').slice(0, 4000),
          clipsChanged: turn.clips ?? [],
          ...(turn.delivery ? { delivery: slimDelivery(turn.delivery as unknown as Record<string, unknown>) } : {}),
          imported: r,
          // What Kiln itself found unmet: the ground for a fix brief.
          ...(failed.length ? { failedChecks: failed.map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ''}`), next: `Kiln's own checks failed: send them back, kiln_request {${family ? 'family' : 'model'}: "${t.model}", kind: "fix", text: what failed}.` } : {}),
        };
        const bakeMs = km.lastBakeMs(t.id);
        return { state: 'done', result, evidence: { turnMs, ...(bakeMs !== undefined ? { bakeMs } : {}) } };
      };
      let end: BuildEnd<Record<string, unknown>>;
      try {
        end = await work();
      } catch (e) {
        end = { state: 'failed', error: `Kiln: ${(e as Error).message}` };
      }
      onSent();
      recordRun(p, { ...b, state: end.state, error: end.state === 'done' ? null : (end.error ?? null), endedAt: Date.now() });
      return end;
    };
  /** A build as a tool result shows it. */
  /**
   * A finished build's result at a size many fit in one answer. The whole result of 15 builds was 48,000
   * characters: the agent's client put it in a file, and the modeler spent three calls failing to read it. What is
   * left out is Kiln's own description of what it delivered (renders, per-model measurements) and most of its
   * reply; what came into the game (`imported`) and anything Kiln's checks flagged stay. One build alone still
   * comes whole.
   */
  const brief = (r: Record<string, unknown>): Record<string, unknown> => {
    const { reply, delivery, ...rest } = r as { reply?: unknown; delivery?: Record<string, unknown> | null };
    const d = delivery && typeof delivery === 'object' ? delivery : null;
    const flagged = d ? Object.fromEntries(Object.entries(d).filter(([k, v]) => /check|problem|warning|fit$/.test(k) && v != null && !(Array.isArray(v) && v.length === 0))) : {};
    return {
      ...rest,
      ...(typeof reply === 'string' ? { reply: reply.length > BRIEF_REPLY ? `${reply.slice(0, BRIEF_REPLY)}…` : reply } : {}),
      ...(d ? { delivery: { ...(typeof d.tris === 'number' ? { tris: d.tris } : {}), ...(Array.isArray(d.size) ? { size: d.size } : {}), ...flagged } } : {}),
    };
  };
  const view = (b: KilnBuild, whole = true) => {
    const km = kiln();
    const at = km.builds.position(b.id);
    const ms = (b.endedAt ?? Date.now()) - (b.startedAt ?? b.queuedAt);
    return {
      build: b.id,
      name: b.name,
      kilnProject: b.kilnProject,
      state: b.state,
      ...(at ? { position: at } : {}),
      ...(b.step ? { step: b.step } : {}),
      ...(b.progress?.total ? { stepsDone: b.progress.done ?? 0, steps: b.progress.total } : {}),
      ...(b.progress?.etaMs != null ? { minutesLeft: Math.max(1, Math.round(b.progress.etaMs / 60_000)) } : {}),
      ...(b.progress?.lastRender ? { lastRender: b.progress.lastRender } : {}),
      ...(b.state === 'queued' ? { expect: estimateBuild(b.kind, !!b.family) } : {}),
      ...(b.turn ? { turn: b.turn } : {}),
      ...(b.startedAt ? { minutes: Math.round(ms / 6000) / 10 } : {}),
      ...(b.error ? { error: b.error } : {}),
      ...(b.state === 'done' || b.state === 'failed' ? ((r) => (whole ? r : brief(r)))(km.builds.resultOf<Record<string, unknown>>(b.id) ?? {}) : {}),
    };
  };
  const queueLine = () => {
    const s = kiln().builds.status();
    return { running: s.running, queued: s.queued, atOnce: s.atOnce, ...(s.atOnce !== s.setting ? { setting: s.setting } : {}), ...(s.note ? { note: s.note } : {}), ...(s.estimate ? { expect: { usd: s.estimate.usd, minutes: s.estimate.minutes } } : {}) };
  };
  /** Waits (on the server, with progress notes) until none of these builds is waiting or running, or the time is up. */
  const follow = async (ids: string[], timeoutMin: number | undefined, caller: CallerContext, signal: AbortSignal | undefined, progress: ToolProgress | undefined): Promise<boolean> => {
    const km = kiln();
    const open = () => ids.map((id) => km.builds.get(id)).filter((b): b is KilnBuild => !!b && (b.state === 'queued' || b.state === 'running'));
    const deadline = Date.now() + Math.min((timeoutMin ?? 25) * 60_000, waitBudget(caller.kind, !!progress));
    while (open().length && Date.now() < deadline && !signal?.aborted) {
      const waits = open().map((b) => km.builds.wait(b.id)!);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.race(waits), new Promise((ok) => (timer = setTimeout(ok, Math.max(50, Math.min(KILN_BUILD.noteMs, deadline - Date.now())))))]);
      clearTimeout(timer);
      const left = open();
      if (left.length) {
        try {
          progress?.({ message: `Kiln: ${left.slice(0, 6).map((b) => (b.state === 'queued' ? `${b.name} waiting (${km.builds.position(b.id) ?? '?'} in line)` : `${b.name} ${b.step ?? 'building'} (${Math.round((Date.now() - (b.startedAt ?? b.queuedAt)) / 60_000)} min)`)).join(', ')}` });
        } catch {
          /* progress is a courtesy */
        }
      }
    }
    return open().length === 0;
  };

  reg.register({
    name: 'kiln_status',
    title: 'Kiln status',
    description: "Whether Kiln (the user's Blender copilot app, docked in Shuriken) is running (when it isn't, kiln_request starts it), its projects (id, title, units, which of this game's models it belongs to, open/working), and this game's models linked to Kiln projects.",
    capability: 'kiln.status',
    permission: 'read',
    input: {},
    handler: async () => {
      const k = d.kiln();
      if (!k || process.env.SHURIKEN_NO_KILN === '1') return jsonOutput({ running: false, detail: 'Kiln is not available in this setup' });
      const h = await k.kiln.check(true);
      const p = d.project();
      const links = p ? linked(p) : {};
      if (!h.ok) return jsonOutput({ running: false, detail: h.detail, startsWithRequest: k.startable, linkedModels: links });
      const app = (await k.kiln.get('/api/v1/app', 8000).catch(() => ({}))) as { projects?: KilnProject[] };
      const projects = (app.projects ?? []).slice(0, 40).map((x) => ({
        id: x.id,
        title: x.title,
        units: x.units ?? 'm',
        model: Object.entries(links).find(([, id]) => id === x.id)?.[0] ?? (x.linked && p && x.linked.project?.toLowerCase() === p.root.toLowerCase() ? x.linked.model : null),
        open: !!x.open,
        working: !!x.working,
        updatedAt: x.updatedAt ?? null,
      }));
      const mine = p ? k.builds.list(p.root).filter((b) => b.state === 'queued' || b.state === 'running') : [];
      const families = p ? listFamilies(p.root).filter((f) => f.members.length > 1).map((f) => ({ family: f.family, kilnProject: f.projectId, models: f.members.map((m) => m.name), sockets: f.sockets.map((s) => s.name), fits: f.fits, built: !!f.read })) : [];
      return jsonOutput({ running: true, version: h.version, projects, linkedModels: links, ...(families.length ? { families } : {}), queue: queueLine(), ...(mine.length ? { builds: mine.map((b) => view(b)) } : {}) });
    },
  });

  reg.register({
    name: 'kiln_clips',
    title: 'Kiln clips',
    description: "A model's animation clips in Kiln (name, frames, length, loop, in place, priority, speed, markers, how it was made) and which are in this game already (their names here, e.g. Griever's Walk → GrieverWalk). Give model (this game's) or kiln_project.",
    capability: 'kiln.clips',
    permission: 'read',
    available,
    input: { model: z.string().optional(), kiln_project: z.string().optional() },
    handler: async ({ args }) => {
      const p = proj();
      const down = await up();
      if (down) return errorOutput(unreachable(down));
      const t = await target(p, args, false);
      const clips = (await kiln().kiln.get(`/api/v1/projects/${t.id}/clips`, 30_000)) as unknown;
      return jsonOutput({ kilnProject: t.id, model: t.model, clips, inGame: t.model ? imported(p, t.model) : [] });
    },
  });

  reg.register({
    name: 'kiln_import',
    title: 'Bring in from Kiln',
    description:
      "Brings a Kiln project into this game as a model: its Roblox parts, its rig (models/<Model>.rig.json) and every clip as a project animation (named after the model: Walk → <Model>Walk; clips for Kiln's R15 rig keep their names and play on players). model: re-import one of this game's Kiln models (after Kiln changed it); kiln_project (+ name): a project the user made in Kiln. Clips Kiln changed are updated, ones it deleted are removed, and when Studio is connected its animations are built again (ReplicatedStorage.ShurikenAnimations, the build animation_build runs): the result's studio says whether Studio was updated.",
    capability: 'kiln.import',
    permission: 'write_project',
    available,
    input: { model: z.string().optional(), kiln_project: z.string().optional(), name: z.string().optional() },
    handler: async ({ args }) => {
      const p = proj();
      const down = await up();
      if (down) return errorOutput(unreachable(down));
      const t = await target(p, args, false);
      const r = await bringIn(p, t.id, t.model, args.name);
      return r.ok ? jsonOutput(r) : errorOutput(r.error);
    },
  });

  reg.register({
    name: 'kiln_request',
    waits: true,
    title: 'Ask Kiln',
    description:
      "Asks Kiln's own copilot for a RESULT: a new build, a rework, a fix or an animation of one of this game's models (model), or of a FAMILY of parts that must fit together or match (family + models: ONE Kiln project, each model its own in the game). Every model of the game is built this way. Kiln owns how: it researches the subject on the web, models, textures, rigs and animates in Blender, and already knows the Roblox rules (plain PBR, budgets, studs scale, the lighting of this place), so you ask for what the game needs and never for the method; the user watches it in the Kiln dock. If Kiln is installed but not running, this starts it. Write the text SHORT, as a result to a senior artist: what it IS, what it is for or how it is seen, and one phrase for its look; plus the facts the game's code depends on (which way is front, clip names and which loop, event markers such as Strike and Hit, ground speeds you want told back). One or two sentences make the best prop: Kiln's best quick build came from 178 characters in about a minute. Never repeat in the text what a field carries (size, sockets, parts, a family's models, style) or the game's premise, and give no part lists, per-part sizes, colours, materials, triangle counts, must-have lists, joint angles or steps: a method that would give a worse result is replaced. Example: \"Maze Runner Griever (2014 film), the maze's hunter: wet slug flesh on tall mechanical legs. Clips Idle, Walk, Run (loops; tell me ground speeds), Lunge (Strike and Hit markers), Roar\". kind: \"new\" (default when this call makes the Kiln project), \"rework\" (a different or better version of what exists), \"fix\" (change only what is wrong: put Studio screenshots of the asset in its real place in images (roblox_screenshot saves them under .shuriken/evidence) and say in one sentence what is wrong), \"animate\" (clips for an existing model). effort: leave it out so Kiln picks it from the brief; choose \"max\" only for a detailed hero build that truly needs it. references: the specific existing subject, as a few words (Kiln researches it first). images: reference pictures or Studio screenshots (project files or https URLs). sockets: where parts join, as names and constraints, never coordinates (Kiln places them and their positions come back in the result, the game's spec and the ShurikenSockets module). fits: families built earlier that this one must fit (Kiln brings their parts in). style: the game's shared look, kept for every later build. spec-like fields (tris, size, grounded, sockets) are checked by Kiln itself when the build ends (Kiln 0.8.2): the result's failedChecks and a family's problems are the ground for a fix. mode says what to do about a build of the same model that is still running: \"interject\" puts a correction into it without restarting it, \"queue\" (default) makes follow-on work wait its turn, \"replace\" stops it and starts over. Builds run in Shuriken's queue: several at once, the rest first in, first out. By default the call waits for the build and returns Kiln's reply, the effort it used and why, the delivery (size, units, objects, tris, joints, clips with length, loop, speed and markers, renders), what came into the game (parts, rig, clips; for a family each model with its size and socket positions, and problems: what the build still owes the game) and what it cost. Read facts there instead of guessing, and do not retune the result yourself: a result that is wrong gets another kiln_request (kind fix). Several builds: pass wait false to each (it returns the build's id at once), then kiln_builds {wait: true} waits for all of them in one call, so nothing sits idle per build. Kiln before 0.7.3 gets the same goals with Shuriken's Roblox notes added to the text.",
    capability: 'kiln.request',
    permission: 'write_project',
    available,
    input: {
      model: z.string().optional().describe('One model of this game (its own Kiln project). A member of a family goes to its family\'s project.'),
      kiln_project: z.string().optional(),
      family: z.string().optional().describe('Parts that must fit together or match (all torsos; all legs; a set of crates) are ONE Kiln project: the family\'s name, e.g. "MechTorsos". Give models with it.'),
      models: z
        .array(z.union([z.string(), z.object({ name: z.string(), what: z.string().optional(), size: z.tuple([z.number(), z.number(), z.number()]).optional() })]))
        .min(1)
        .max(12)
        .optional()
        .describe('The models of the family: the name each has in the game (it becomes its own model), optionally {name, what: a few words, size: about [width, height, depth] studs}.'),
      fits: z.array(z.string()).max(6).optional().describe('Families or models of this game, built already, that this one must fit: Kiln brings their parts in to fit against (legs fits ["MechTorsos"]).'),
      sockets: z
        .array(z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), joins: z.string(), where: z.string().optional() }))
        .max(16)
        .optional()
        .describe('Where parts join, as names and constraints, never coordinates: {name: "LegSocket", joins: "the top centre of every leg set", where: "bottom centre of every torso; the same position on all three"}. Kiln places them; their positions come back in the result.'),
      parts: z
        .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/))
        .max(12)
        .optional()
        .describe('Parts the code of the game finds or moves by name ("Door", "Lid", "Barrel"): each stays its own part in the game, named <Model>_<Name>. Everything not named here is merged by material, so name what the code needs and nothing else.'),
      style: z.string().max(400).optional().describe('The look every model of this game shares, in one or two sentences (about 200 characters). Set once: every later new build or rework of this game carries it.'),
      tris: z.number().int().min(100).max(200_000).optional().describe('A triangle budget per model, when the game needs one.'),
      size: z.tuple([z.number(), z.number(), z.number()]).optional().describe('For one model: about how big, studs [width, height, depth].'),
      footprint: z
        .tuple([z.number().min(1).max(2048), z.number().min(1).max(2048)])
        .optional()
        .describe('A piece of the map that your team assembles in Studio (a building, a kit piece, a tunnel cell): its EXACT footprint on the ground, studs [width, depth], in whole grid units. One short line tells Kiln it is a piece on its own with exactly that footprint, so pieces from separate requests line up (its origin is the bottom centre, front facing -Y: Kiln\'s own defaults). With a family: every piece\'s footprint (the kit\'s cell). The design stays Kiln\'s. Read the delivered size before placing.'),
      grounded: z.boolean().optional().describe('It stands on the ground (its lowest point is the floor).'),
      text: z.string().optional(),
      kind: z.enum(['new', 'rework', 'fix', 'animate']).optional().describe('What the request is: new (a new build), rework, fix (change only what is wrong; attach Studio screenshots) or animate (clips). Default new when this call makes the Kiln project, else omitted.'),
      detail: z
        .enum(['quick', 'standard', 'hero'])
        .optional()
        .describe('How much this build is worth. "quick" (the default): a prop, dressing, anything simple, blocky or low-poly: one or two loose sentences, done in minutes. "standard": a model the gameplay centres on, a family of parts that fit, a rigged creature. "hero": the one or two centrepieces of the game. It sets the effort Kiln spends and how long the brief may be (280 / 600 / 1,200 characters).'),
      effort: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Leave it out: detail sets it. "max" only when the user asked for the very best on this one model.'),
      references: z
        .string()
        .optional()
        .describe('The specific existing subject Kiln researches on the web first (reference images), e.g. "the Griever from The Maze Runner films" or "a snow leopard".'),
      images: z.array(z.string()).max(6).optional().describe('Reference images or Studio screenshots for Kiln: project files (png, jpg, webp, gif; roblox_screenshot evidence under .shuriken/evidence) or https URLs; they win over what it finds.'),
      mode: z
        .enum(['interject', 'queue', 'replace'])
        .optional()
        .describe('What happens when a build of this model or family is still running. "queue" (the default): a build of its own, after the running one (follow-on work: "add a third head"). "interject" (Kiln 0.8.2): the text joins the RUNNING build, which reads it at its next step and re-plans without restarting (a correction, a requirement you forgot); same build, one result. "replace": the running build is stopped and this one starts (it was aimed at the wrong thing; its unsaved work is lost).'),
      turn: z.string().optional().describe('Follow a build by its Kiln turn id (from an earlier call); kiln_builds does the same by build id.'),
      wait: z.boolean().optional().describe('false: return at once with the build id (queue several, then kiln_builds {wait: true}). Default true.'),
      timeout_min: z.number().min(1).max(45).optional(),
    },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const km = kiln();
      if (args.turn) {
        // An earlier build of this session: its state, or its result once it has ended.
        const b = km.builds.list(p.root).find((x) => x.turn === args.turn);
        if (!b) return errorOutput(`No build with turn ${args.turn} is known here (Shuriken restarted since?). kiln_import {model} brings in what Kiln has; kiln_builds lists this session's builds.`);
        if (args.wait !== false) await follow([b.id], args.timeout_min, caller, signal, progress);
        return b.state === 'failed' || b.state === 'stopped' ? errorOutput(b.error ?? `The build ended ${b.state}`) : jsonOutput({ ...view(b), queue: queueLine() });
      }
      if (!args.text?.trim()) return errorOutput('Give text (the brief), or turn to follow an earlier request.');
      const images: Array<{ name: string; dataUrl: string }> = [];
      const skippedImages: string[] = [];
      for (const ref of args.images ?? []) {
        try {
          images.push(await referenceImage(p.root, ref));
        } catch (e) {
          skippedImages.push(`${ref}: ${(e as Error).message}`);
        }
      }
      // Kiln installed but not running is started here, in the background; only a Kiln that can't be reached is a fallback.
      const down = await up();
      if (down) {
        const names = args.family ? (args.models ?? readFamily(p.root, args.family)?.members ?? []).map((m) => (typeof m === 'string' ? m : m.name)) : args.model ? [args.model] : [];
        if (!names.length) return errorOutput(unreachable(down));
        for (const n of names) km.fallbackTo(p.root, n, down);
        return errorOutput(
          `${unreachable(down)} Fallback for ${names.join(', ')}: build ${names.length === 1 ? 'it' : 'them'} yourself with blender_python (skill "blender-props", or "blender-creatures" for anything rigged), and start your result with the line "Kiln wasn't reachable, so I modeled ${names.join(', ')} in Blender myself." The chat has been told.`,
        );
      }
      // Kiln 0.7.3 and newer owns the Roblox text and the method: it gets the goals as written.
      const results = km.kiln.supports();
      const fields = km.kiln.supports(KILN_FIELDS_VERSION);
      const name = args.family ?? args.model ?? null;
      const here = (id: string) => km.builds.list(p.root).find((b) => b.kilnProject === id && b.state === 'running') ?? null;
      if (args.mode === 'interject') {
        // A message into the build that is running: no new build, no new turn; it ends with one result that covers both.
        const id = args.kiln_project ?? (name ? km.linkedProject(p.root, name) : null);
        const running = id ? here(id) : null;
        if (!id || !running?.turn) return errorOutput(`No build of ${name ?? 'that project'} is running to interject into (kiln_builds lists them). Send it as a request of its own: kind "fix" for what is wrong, "rework" for more.`);
        if (!fields) return errorOutput(`Kiln ${km.kiln.health.version ?? ''} can't take a message while it builds (Kiln 0.8.2 can). Send it as kind "fix" when the build has ended: kiln_builds {wait: true} waits for it.`);
        try {
          const r = (await km.kiln.post(`/api/v1/projects/${id}/chat`, { text: args.text.trim(), from: 'shuriken', mode: 'interject', ...(images.length ? { images } : {}) }, 60_000)) as { ok?: boolean; turnId?: string; mode?: string; error?: string; effort?: string | null };
          if (!r.ok || !r.turnId) return errorOutput(`Kiln didn't take the message: ${r.error ?? 'no turn id'}`);
          if (r.mode === 'interject' || r.turnId === running.turn)
            return jsonOutput({ interjected: true, build: running.id, name: running.name, turn: r.turnId, images: images.length, note: 'Kiln reads it at its next step and re-plans; the build ends with one result that covers it (kiln_builds waits for it).' });
          // The build ended in the meantime, so Kiln started a turn for the message: it is a build of its own now.
          const t2 = await plan(p, args);
          const { build } = km.builds.submit(
            { root: p.root, name: t2.model ?? id, kilnProject: id, kind: 'fix', by: caller.kind === 'ui' || !caller.role ? null : roleLabel(caller.role), runId: caller.runId, taskId: caller.taskId, family: !!t2.rec && t2.rec.members.length > 1 },
            buildJob(p, t2, {}, { kind: 'fix', references: null, images: images.length }, !!t2.rec && t2.rec.members.length > 1, () => undefined, { turnId: r.turnId, effort: r.effort ?? null }),
          );
          return jsonOutput({ ...view(build), note: 'The build had just ended, so Kiln started a new turn for the message: kiln_builds {wait: true} waits for it.' });
        } catch (e) {
          return errorOutput(e instanceof Error && /fits:|models|family/.test(e.message) ? e.message : `Kiln: ${(e as Error).message}`);
        }
      }
      // The game's shared look is kept once and carried by every new build.
      if (args.style?.trim()) writeStyle(p.root, args.style);
      let t: Planned;
      try {
        // A held tool whose text speaks of a Grip but names no socket: the Grip is the one fact the game needs back
        // (in two builds the words alone gave swords without one, and model_gear failed on each).
        const gear = !args.sockets?.length && args.kind !== 'fix' && args.kind !== 'animate' && GRIP_IN_TEXT.test(args.text ?? '');
        t = await plan(p, gear ? { ...args, sockets: [GRIP_SOCKET] } : args);
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const kind = args.kind ?? (t.created ? 'new' : undefined);
      // The brief as data: a new build or a rework states the whole of what the game needs; a fix or an animation only what the call names.
      const whole = kind === 'new' || kind === 'rework';
      const detail = kilnDetail({ ...args, kind });
      const long = whole ? briefTooLong(args.text, detail) : null;
      if (long) return errorOutput(long);
      // A quick build gets no checked requirements (a triangle count, a size within 20%, "on the ground"): each one
      // Kiln has to hit is a loop of measuring and reworking. A rough size goes along as words.
      const loose = detail === 'quick';
      const rough = loose && args.size ? ` About ${args.size[0]} wide, ${args.size[1]} tall, ${args.size[2]} deep (studs); close is fine.` : '';
      const brief: KilnBriefSpec = {
        text: `${args.text.trim()}${rough}`,
        references: args.references,
        ...(args.family && (whole || args.models) ? { family: args.family, members: t.rec?.members ?? [] } : {}),
        ...(t.rec?.sockets.length && (whole || args.sockets) ? { sockets: t.rec.sockets, ...(args.family ? {} : { members: t.rec.members }) } : {}),
        ...(t.fits.length && (whole || args.fits) ? { fits: t.fits } : {}),
        ...(whole ? { style: readStyle(p.root) } : {}),
        ...(!loose && (args.tris ?? (whole ? t.rec?.tris : undefined)) ? { tris: args.tris ?? t.rec?.tris } : {}),
        ...(!loose && args.size ? { size: args.size } : {}),
        ...(!loose && args.grounded ? { grounded: true } : {}),
        ...(args.parts?.length ? { parts: args.parts } : {}),
        ...(args.footprint && whole ? { footprint: args.footprint } : {}),
      };
      // The effort is always sent (left to Kiln's own rule, "detailed" or a named subject meant max).
      const effort = args.effort && args.effort !== 'auto' ? args.effort : KILN_EFFORT[detail];
      // From Kiln 0.8.2 the checkable requirements go as data (`spec`), and the game's look as the id of its style sheet.
      const sheet = fields ? await km.styleSheet(p.root) : null;
      const replacing = args.mode === 'replace' ? here(t.id) : null;
      if (replacing) {
        // The running build of this project gives way: Shuriken stops following it, and Kiln stops its turn (0.8.2 with the new brief, before that by Stop).
        km.builds.stop(replacing.id);
        if (!fields) await km.kiln.post(`/api/v1/projects/${t.id}/stop`, {}, 15_000).catch(() => undefined);
        await Promise.race([km.builds.wait(replacing.id), sleep(10_000)]);
      }
      const body = results
        ? { ...briefBody(brief, { fields, styleId: sheet?.id ?? null, styleKnown: !!sheet?.sheet, parts: km.kiln.supports(KILN_PARTS_VERSION) }), ...(replacing && fields ? { mode: 'replace' } : {}), from: 'shuriken', ...(kind ? { kind } : {}), effort, ...(loose && whole && km.kiln.supports(KILN_QUICK_VERSION) ? { quick: true } : {}), ...(images.length ? { images } : {}) }
        : { text: kilnBrief(renderBrief({ ...brief, references: undefined }), args.references, images.length), from: kilnFrom(caller), ...(images.length ? { images } : {}) };
      const sent = { kind: results ? (kind ?? null) : undefined, detail, references: args.references?.trim() || null, images: images.length, ...(skippedImages.length ? { skippedImages } : {}) };
      let sentNow!: () => void;
      const briefSent = new Promise<void>((ok) => (sentNow = ok));
      const { build, done } = km.builds.submit(
        { root: p.root, name: t.model ?? t.id, kilnProject: t.id, kind: kind ?? null, by: caller.kind === 'ui' || !caller.role ? null : roleLabel(caller.role), runId: caller.runId, taskId: caller.taskId, family: !!args.family },
        buildJob(p, t, body, sent, !!args.family, sentNow),
      );
      const model = args.family ? {} : { model: t.model };
      if (args.wait === false) {
        // A build that started at once has its turn id a moment later; one that waits in line returns right away.
        if (build.state === 'running') {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([briefSent, done, new Promise((ok) => (timer = setTimeout(ok, 70_000)))]);
          clearTimeout(timer);
        }
        if (build.state === 'failed' || build.state === 'stopped') return errorOutput(build.error ?? `The build ended ${build.state}`);
        return jsonOutput({ ...view(build), ...model, ...sent, effort: build.effort, queue: queueLine(), next: 'kiln_builds {wait: true} waits for this build (and any others you queued) in one call and returns their results; do other work meanwhile.' });
      }
      const ended = await follow([build.id], args.timeout_min, caller, signal, progress);
      if (!ended) return jsonOutput({ ...view(build), ...model, ...sent, queue: queueLine(), note: 'Still going: kiln_builds {wait: true} keeps waiting for it (the build carries on by itself and comes into the game when it ends).' });
      if (build.state !== 'done') return errorOutput(build.error ?? `The build ended ${build.state}`);
      return jsonOutput(km.builds.resultOf<Record<string, unknown>>(build.id) ?? view(build));
    },
  });

  reg.register({
    name: 'kiln_builds',
    waits: true,
    title: 'Kiln builds',
    description:
      "Shuriken's queue of Kiln builds (kiln_request): how many run at once and how many wait, and each build of this game with its state (queued with its place in line, running with its step, done with its result, failed with why). wait true (the default) waits on the server until none of the builds is waiting or running (or the time is up) and returns their results: Kiln's reply, the delivery, what came into the game, the cost. Give builds (ids from kiln_request) for some, else it covers every build of this game that is waiting or running plus the ones you started. Use it after queueing several builds with kiln_request {wait: false}: one call waits for all of them. stop: build ids to take out of the queue (a running one is no longer followed; Kiln finishes its turn).",
    capability: 'kiln.request',
    permission: 'write_project',
    available,
    input: {
      builds: z.array(z.string()).max(40).optional().describe('Build ids from kiln_request (default: the builds of this game that are waiting or running, plus yours).'),
      wait: z.boolean().optional(),
      stop: z.array(z.string()).max(40).optional().describe('Builds to take out of the queue.'),
      timeout_min: z.number().min(1).max(45).optional(),
    },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const km = kiln();
      for (const id of args.stop ?? []) km.builds.stop(id);
      const all = km.builds.list(p.root);
      const chosen = args.builds?.length ? all.filter((b) => args.builds!.includes(b.id)) : all.filter((b) => b.state === 'queued' || b.state === 'running' || (!!caller.runId && b.runId === caller.runId));
      const unknown = (args.builds ?? []).filter((id) => !all.some((b) => b.id === id));
      const ended = args.wait === false ? chosen.every((b) => b.state !== 'queued' && b.state !== 'running') : await follow(chosen.map((b) => b.id), args.timeout_min, caller, signal, progress);
      return jsonOutput({
        allEnded: ended,
        queue: queueLine(),
        // Several builds: each in brief (the whole of one: kiln_builds {builds: [its id], wait: false}).
        builds: chosen.map((b) => view(b, chosen.length <= BRIEF_ABOVE)),
        ...(chosen.length > BRIEF_ABOVE ? { brief: 'Results are shortened. One build in full: kiln_builds {builds: ["<its build id>"], wait: false}.' } : {}),
        ...(unknown.length ? { unknown } : {}),
        ...(ended ? {} : { note: 'Some are still going: call kiln_builds again, or do other work (they carry on and come into the game by themselves).' }),
      });
    },
  });

  reg.register({
    name: 'kiln_clip',
    title: 'Clip operation (Kiln animation)',
    description:
      "Runs Kiln's animation system on one of this game's rigged models, wherever the model is open (Kiln, or Shuriken's own Blender, which has the same helpers): generate a clip (generator gait|idle|attack|hit|death with params — gait {style: walk|trot|run|sneak, speed, cycle, duty, pattern, step_height, bob, sway, lean, stride, in_place}, idle {length, breathe, sway, look}, attack {kind: lunge|sting|bite|slam|swipe, reach, windup, strike, hold, recover}, hit {direction, strength, length}, death {length, side}), regenerate it with changed params, change settings (loop, in_place, priority, speed, fade), rename (to), delete, add an event (label at time: Hit, Step_<leg>, Dead, Spawn_VFX), or check it (Kiln's frame-by-frame report: feet sliding, ground, collisions, limits, jitter, loop seams). Changed clips come into the game at once as its animations (<Model><Clip>), and Studio's animations are built again when it is connected (the result's studio says whether). No copilot turn and no usage. For a model that is a Kiln project (Kiln 0.7.3 or newer; made with kiln_request) Kiln owns its clips: generate, regenerate, settings, rename, delete and event are refused there (ask Kiln for the result with kiln_request kind animate or fix) and only check works; this tool changes clips of models that live in Shuriken's own Blender.",
    capability: 'kiln.clip',
    permission: 'write_project',
    input: {
      model: z.string(),
      clip: z.string(),
      action: z.enum(['generate', 'regenerate', 'settings', 'rename', 'delete', 'event', 'check']),
      generator: z.enum(['gait', 'idle', 'attack', 'hit', 'death']).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      settings: z.object({ loop: z.boolean().optional(), in_place: z.boolean().optional(), priority: z.enum(['Idle', 'Movement', 'Action', 'Core']).optional(), speed: z.number().optional(), fade: z.number().optional() }).optional(),
      to: z.string().optional(),
      label: z.string().optional(),
      time: z.number().optional(),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      // A model that is a Kiln project (0.7.3) is Kiln's to change: its clips are asked for, and only measured here.
      const owner = d.kiln();
      if (owner && process.env.SHURIKEN_NO_KILN !== '1' && (await owner.kiln.check().catch(() => null))?.ok && owner.kilnOwns(p.root, args.model)) {
        if (args.action !== 'check')
          return errorOutput(
            `${args.model} is a Kiln project, so Kiln owns its model and clips: ${args.action} isn't done from here. Ask Kiln for the result with kiln_request {model: "${args.model}", kind: "animate", text: what the clip must be for the game (its name, whether it loops, event markers such as Strike or Hit, the ground speed you need told back; never gait parameters or keyframes)}. If a clip looks wrong in Studio, send kind: "fix" with Studio screenshots of the asset in its real place in images (roblox_screenshot saves them under .shuriken/evidence) and one sentence on what is wrong. kiln_clip {action: "check"}, kiln_clips and animation_check only read it.`,
          );
        try {
          const report = await owner.kiln.post(`/api/v1/projects/${owner.linkedProject(p.root, args.model)}/clips/${encodeURIComponent(args.clip)}`, { action: 'check' }, 120_000);
          return jsonOutput({ model: args.model, clip: args.clip, report });
        } catch (e) {
          return errorOutput(`Kiln couldn't check ${args.clip}: ${(e as Error).message}`);
        }
      }
      const m = d.modeling();
      if (!m.status().ready) return errorOutput(`3D modeling isn't available here (${m.status().detail}), so Kiln's animation can't run.`);
      if (args.action === 'generate' && !args.generator) return errorOutput('generate needs generator: gait, idle, attack, hit or death.');
      if (args.action === 'rename' && !args.to) return errorOutput('rename needs to.');
      if (args.action === 'event' && (!args.label || args.time === undefined)) return errorOutput('event needs label and time (seconds from the clip start).');
      let ws;
      try {
        ws = m.workspace(p.root, args.model, { runId: caller.runId, role: caller.role });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const payload = { action: args.action, clip: args.clip, generator: args.generator ?? null, params: args.params ?? {}, settings: args.settings ?? {}, to: args.to ?? null, label: args.label ?? null, time: args.time ?? null };
      const code = `import json
_a = json.loads(${JSON.stringify(JSON.stringify(payload))})
if kiln.rig.armature(False) is None:
    raise ValueError("${args.model} has no rig yet: rig it first (kiln.rig joints, or kiln.limb(..., rig=True))")
_act = _a["action"]
if _act == "generate":
    getattr(kiln.anim, _a["generator"])(name=_a["clip"], **_a["params"])
elif _act == "regenerate":
    kiln.anim.regenerate(_a["clip"], **_a["params"])
elif _act == "settings":
    kiln.anim.settings(_a["clip"], **_a["settings"])
elif _act == "rename":
    kiln.anim.rename(_a["clip"], _a["to"])
elif _act == "delete":
    kiln.anim.delete(_a["clip"])
elif _act == "event":
    kiln.anim.event(_a["clip"], _a["label"], time=_a["time"])
_out = kiln.anim.check(_a["clip"]) if _act == "check" else [dict(c, params=None) for c in kiln.anim.clips()]
print("KILN_CLIP_RESULT " + json.dumps(_out, default=str))`;
      const r = await ws.exec(code, 240_000, `${args.action} ${args.clip}`);
      if (!r.ok) return errorOutput(`${args.action} ${args.clip} failed: ${(r.error ?? r.output).slice(0, 1500)}`);
      const line = r.output.split('\n').find((l) => l.startsWith('KILN_CLIP_RESULT '));
      let result: unknown = null;
      try {
        result = line ? JSON.parse(line.slice('KILN_CLIP_RESULT '.length)) : null;
      } catch {
        result = line?.slice(0, 2000) ?? null;
      }
      if (args.action === 'check') return jsonOutput({ model: args.model, clip: args.clip, report: result });
      // Clip data alone may not count as a scene change for the engine: export anyway.
      if (!r.changed) await ws.republish?.();
      d.bus.emit('animations.changed', {});
      // The clip is a project animation now; Studio's copy is built again so animation_check sees the new keys.
      const studio = await refreshStudio();
      return jsonOutput({
        model: args.model,
        clip: args.clip,
        action: args.action,
        clipsInKiln: result,
        inGame: imported(p, args.model),
        studio,
        next: `animation_view {name: "${kilnClipName(args.model, args.action === 'rename' ? args.to! : args.clip, 'custom')}"} shows it; kiln_clip {action: "check"} measures it frame by frame; animation_check checks it on the rig in Studio (after rig_build).`,
      });
    },
  });
}
