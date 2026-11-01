import { z } from 'zod';
import { EASING_ALIASES, JOINTS, bodyPartClip, clipDuration, clipJointNames, clipJoints, clipMetrics, groundClip, reachMisses, resolveAims, validateClip, type AnimationClip } from '@shared/animation';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { CodeSync } from '../roblox/code-sync';
import type { EventBus } from '../events';
import { resolveCreator, type OpenCloudAssets } from '../roblox/open-cloud-assets';
import { AnimationUploads } from '../animation/animation-uploads';
import { waitBudget } from '../roblox/upload-queue';
import { existsSync, readFileSync } from 'node:fs';
import { errorOutput, jsonOutput, type CallerContext, type ToolRegistry } from './tool-registry';
import type { RenderRequest } from '@shared/render';
import { AnimationStore, BUILDER_REL, clipHash, type AnimationFile } from '../animation/animation-service';
import { buildPreset, listPresets } from '../animation/presets';
import { animationCheckLuau, rigAnimationCheckLuau } from '../animation/luau';
import { RIG_MOTION_GUIDE, RIG_MOTIONS, checkRigClip, generateRigClip, loadRigBody, type RigBody, type RigMotionParams } from '../animation/rig-motion';
import { AssetService } from '../assets/asset-service';
import { readKeyframesLuau, sequenceToClip, type RawSequence } from '../animation/import';
import { ModelStore } from '../modeling/model-store';
import { ownerKey } from '../roblox/upload-owner';

export interface AnimationToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  sync: CodeSync;
  bus: EventBus;
  /** Uploading (optional: without it animations stay Studio-only until an id is set by hand). */
  cloud?: OpenCloudAssets;
  uploads?: () => { enabled: boolean; creatorId: string | null };
  rememberCreator?: (id: string) => void;
  /** Draws a filmstrip of a clip on the R15 mannequin; absent where nothing can draw. */
  render?: (req: RenderRequest) => Promise<string | null>;
}

/** How long a build waits for the creature clips it uploads (they go up while the place builds; slower ones land by themselves). */
const AUTO_UPLOAD_WAIT_MS = 30_000;

/** What building the animations into the place came to. */
interface BuildResult {
  built: Array<{ name: string; id: string }>;
  failed: Array<{ name: string; error: string }>;
  runtime: { file: string; requirePath: string; written: boolean; sync?: string };
  note?: string;
  /** The creature clips this build uploaded (or could not): see buildInStudio. */
  uploads?: {
    uploaded?: Array<{ name: string; assetId: string }>;
    pending?: string[];
    stillUploading?: string[];
    failed?: Array<{ name: string; error: string }>;
    skipped?: string;
    clips?: string[];
    note?: string;
  };
}

/** Whether a clip is shown with a sword in its hand (and which): sword presets, or a custom clip named like a sword move. */
export function swordFor(f: AnimationFile): false | 'left' | 'right' {
  const armed = f.preset ? /^Sword/.test(f.preset) : /sword|slash|thrust|parry|lunge/i.test(f.clip.name) && !/fist|punch|unarmed|kick|jab|hook|uppercut/i.test(f.clip.name);
  return armed ? ((f.params as { hand?: string } | undefined)?.hand === 'left' ? 'left' : 'right') : false;
}

const CONVENTIONS = `Rotations are degrees [x, y, z] about each joint (like CFrame.Angles), on the default R15 rig facing -Z:
shoulders (…UpperArm) +X raises the arm forward, +Z swings the right arm out (left arm: -Z); elbows (…LowerArm) +X bends; wrists (…Hand) +X tilts up;
hips (…UpperLeg) +X lifts the thigh forward; knees (…LowerLeg) -X bends; ankles (…Foot) +X lifts the toes;
waist (UpperTorso) -X leans forward, +Y twists left; neck (Head) +X looks up, +Y looks left;
root (LowerTorso) -X pitches forward, pos [x, y, z] moves the hips (y down to crouch, z < 0 lunges forward).
Hands by position: give RightHand/LeftHand {reach: [x right, y up, f forward]} (studs from the root; head ≈ [0, 1.5, 0.2], a jab lands ≈ [0, 1.2, 2.4], a guard fist ≈ [-0.25, 1.15, 1.25]) and Shuriken solves the shoulder and elbow (elbow: "low" default, "out", or "high" for hooks); the unarmed presets are authored this way.
Held weapons: give RightHand/LeftHand {aim: [x right, y up, f forward]} instead of rot and Shuriken solves the wrist so the blade points there (e.g. guard [-0.25, 0.6, 0.76], thrust [0, 0, 1], slash contact [-0.55, -0.25, 0.8]); the sword presets are authored this way. reach and aim combine (reach first).
Rolls and flips: angles past ±180 are fine (a forward roll keys the root at -30, -60 … -360); Roblox turns between keys along the shortest way, so keep keys under 180° apart.
Joints: ${JOINTS.join(', ')}. A joint a clip never keys is left to lower-priority animations (e.g. legs keep walking under an arm-only swing).`;

const RIG_CONVENTIONS = `Custom rigs (clip.rig = the rigged model): poses name the rig's joints. rot is degrees [x, y, z] about the model's own axes at rest (x right, y up, z back: the model faces -Z), applied like CFrame.Angles about the joint's pivot; pos (studs) moves a joint within its parent segment, and the root joint's pos moves the whole body (y down to crouch, z < 0 forward).
Hinges turn only about their axis, within limits (degrees about the axis); balls within per-axis limits; fixed joints don't move. Legs (rig.json legs) are hip to ankle.
Prefer a generator (animation_create {rig, motion, params}) and adjust its clip (animation_list {name}) rather than keying frames by hand. animation_create reports the clip's metrics and findings (sinking into the ground, planted feet sliding, limits, a strike that doesn't land in front); animation_check measures it on the rig in Studio too; animation_view shows it.`;

const CLEAR_ANIMATIONS = `local root = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAnimations")
if root then
  for _, c in root:GetChildren() do
    if c:IsA("Animation") then c:Destroy() end
  end
  local seqs = root:FindFirstChild("Sequences")
  if seqs then seqs:ClearAllChildren() end
end
return "cleared"`;

const poseSchema = z.object({
  rot: z.tuple([z.number(), z.number(), z.number()]).optional(),
  aim: z.tuple([z.number(), z.number(), z.number()]).optional(),
  reach: z.tuple([z.number(), z.number(), z.number()]).optional(),
  elbow: z.enum(['low', 'out', 'high']).optional(),
  pos: z.tuple([z.number(), z.number(), z.number()]).optional(),
  // TweenService names (Sine, Quad, Back…) are accepted and mapped to the nearest pose easing.
  ease: z.preprocess((v) => (typeof v === 'string' ? (EASING_ALIASES[v] ?? v) : v), z.enum(['Linear', 'Constant', 'Cubic', 'Elastic', 'Bounce', 'CubicV2'])).optional(),
  dir: z.enum(['In', 'Out', 'InOut']).optional(),
});
const clipSchema = z.object({
  name: z.string(),
  rig: z.string().optional(),
  description: z.string().optional(),
  loop: z.boolean(),
  priority: z.enum(['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4']),
  keys: z.array(z.object({ t: z.number(), poses: z.record(z.string(), poseSchema) })).min(2),
  markers: z.array(z.object({ t: z.number(), name: z.string(), value: z.string().optional() })).optional(),
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** What a draft's result says about where it is (a dock copilot's draft turn; see copilots/copilot-roles.ts). */
const DRAFT_WHERE =
  "A draft: it plays on the Animation page in Shuriken (animation_view shows it to you). It is NOT in the game or in Studio. The user adds it with the page's Add to game button, or by telling you to put it in the game (then animation_use does it).";
const noRig = (model: string) => `${model} has no rig (models/${model}.rig.json): rig it in Blender with kiln.rig (joint, bind, leg, attach) or kiln.limb(..., rig=True), and export it.`;

/** A rigged model's parts as a picture needs them (GLB bytes, look, where it sits, its segment). */
function rigParts(root: string, rig: string) {
  const store = new ModelStore(root);
  return store
    .parts(rig)
    .filter((m) => existsSync(store.paths(m.name).glb))
    .map((m) => ({ glb: readFileSync(store.paths(m.name).glb).toString('base64'), color: m.color, material: m.material, origin: m.origin, segment: m.segment }));
}

/**
 * The animation workshop for agents: R15 animations as data (animations/<Name>.anim.json), built into
 * the place as KeyframeSequences with Animation objects (ReplicatedStorage.ShurikenAnimations), played by
 * games through the generated ShurikenAnimations module, and measured on a real rig in Studio.
 */
export function registerAnimationTools(reg: ToolRegistry, d: AnimationToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const leaseBlocked = async (_caller: CallerContext, _signal?: AbortSignal) => {
    const w = await d.studio.waitForLease();
    return w.ok ? null : errorOutput(`${w.message} Building animations needs Edit mode. The files are saved; run animation_build later.`);
  };

  /** Builds every clip into the place and pushes the runtime module; returns what happened. */
  const buildOnce = async (p: ProjectContext, store: AnimationStore, caller: CallerContext, signal?: AbortSignal): Promise<BuildResult> => {
    const runtime = store.ensureRuntime(p.extras().syncMap);
    const code = store.writeBuilder();
    if (!d.studio.connected) return { built: [], failed: [], runtime, note: `Studio is not connected; ${BUILDER_REL} builds the animations on the next world_rebuild.` };
    const blocked = await leaseBlocked(caller, signal);
    if (blocked) return { built: [], failed: [], runtime, note: blocked.content[0]?.type === 'text' ? blocked.content[0].text : 'Studio busy' };
    if (!code) {
      // Nothing left: clear what earlier builds put in the place.
      await d.studio.runLuau(CLEAR_ANIMATIONS, 'Edit', 60_000, signal);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      return { built: [], failed: [], runtime, note: 'no animations left; cleared ReplicatedStorage.ShurikenAnimations' };
    }
    const r = await d.studio.runLuau(code, 'Edit', 180_000, signal);
    d.bus.emit('roblox.changed', { reason: 'luau' });
    let out: { built: Array<{ name: string; id: string }>; failed: Array<{ name: string; error: string }> } = { built: [], failed: [] };
    if (!r.ok) return { ...out, runtime, note: `Build failed: ${r.output.slice(0, 1500)}` };
    try {
      out = JSON.parse(r.output) as typeof out;
      out.built ??= [];
      out.failed ??= [];
    } catch {
      return { ...out, runtime, note: `Unexpected build output: ${r.output.slice(0, 500)}` };
    }
    // The module lives in synced code: push just that file (Script Sync projects get it from Studio itself).
    let runtimeSync = 'not needed';
    const mode = p.extras().syncMode;
    if (mode === 'script-sync') runtimeSync = 'Studio Script Sync';
    else if (mode === 'none') runtimeSync = `code sync is off: add ${runtime.file} to the place yourself`;
    else {
      const rep = await d.sync.push(p.root, p.extras().syncMap, { only: [runtime.file] });
      runtimeSync = rep.errors.length ? `failed: ${rep.errors.map((e) => e.error).join('; ').slice(0, 300)}` : rep.created.length || rep.updated.length ? 'pushed' : 'up to date';
    }
    return { ...out, runtime: { ...runtime, sync: runtimeSync } };
  };

  /** Uploads of clips: the same code for animation_upload and for the creature clips every build uploads. */
  const uploader = d.cloud && d.uploads ? new AnimationUploads({ cloud: d.cloud, uploads: d.uploads, creator: () => resolveCreator(d.studio, d.uploads!().creatorId, d.rememberCreator ?? (() => undefined)), ownerKey: async () => ownerKey(await d.cloud!.owner()) }) : null;

  /**
   * Builds every clip into the place — and uploads the creature clips (custom rigs) whose current content
   * isn't uploaded while it does: a track a server script plays on a creature reaches the players only
   * through an uploaded asset (a Studio-local id exists in the one DataModel that registered it). Only
   * changed clips go up (up to six at a time, they never block the build); once they have, the place is
   * built again so the Animation objects carry their AssetId. `uploads` reports what happened, clips that
   * could not upload included. autoUpload: false builds without any of that.
   */
  const buildInStudio = async (p: ProjectContext, store: AnimationStore, caller: CallerContext, signal?: AbortSignal, opts: { autoUpload?: boolean } = {}): Promise<BuildResult> => {
    const todo = opts.autoUpload === false || !uploader ? [] : store.inGame().filter((f) => f.clip.rig && !store.summary(f).uploaded).map((f) => f.clip.name);
    const ready = todo.length && uploader ? await uploader.ready() : null;
    // Started now, so the uploads overlap with the build.
    const going = todo.length && uploader && ready?.ok ? uploader.ensureMany(p.root, todo, { budgetMs: AUTO_UPLOAD_WAIT_MS }) : null;
    let b = await buildOnce(p, store, caller, signal);
    if (!todo.length) return b;
    if (!going) {
      const why = ready && !ready.ok ? ready.why : 'uploading is not available';
      return { ...b, uploads: { skipped: why, clips: todo, note: `${todo.length} creature clip${todo.length === 1 ? '' : 's'} (${todo.slice(0, 6).join(', ')}) ${todo.length === 1 ? "isn't" : "aren't"} uploaded (${why}): a server script that plays ${todo.length === 1 ? 'it' : 'them'} shows nothing to the players — upload ${todo.length === 1 ? 'it' : 'them'} with animation_upload once that is fixed.` } };
    }
    const { results, stillUploading } = await going;
    const uploaded = results.filter((r) => r.assetId && !r.reused).map((r) => ({ name: r.name, assetId: r.assetId! }));
    const pending = results.filter((r) => r.pending).map((r) => r.name);
    const failed = results.filter((r) => !r.assetId && !r.pending).map((r) => ({ name: r.name, error: r.why ?? 'upload failed' }));
    // The Animation objects get their AssetId from the builder: build again now that the uploads are recorded.
    if (uploaded.length) b = await buildOnce(p, store, caller, signal);
    // Uploads that outlast this call land by themselves; the place is built again when they have.
    if (stillUploading.length) {
      void Promise.all(stillUploading.map((n) => uploader!.ensure(p.root, n))).then((rs) => {
        if (rs.some((r) => r.assetId)) d.bus.emit('animations.changed', { stale: true });
      });
    }
    return { ...b, uploads: { uploaded, ...(pending.length ? { pending } : {}), ...(stillUploading.length ? { stillUploading } : {}), ...(failed.length ? { failed } : {}) } };
  };

  const recordAsset = (p: ProjectContext, f: AnimationFile, caller: CallerContext) => {
    const svc = new AssetService(p.store);
    const actor = caller.role ?? caller.kind;
    const clipFile = `animations/${f.clip.name}.anim.json`;
    const metadata = {
      clipFile,
      preset: f.preset ?? null,
      duration: clipDuration(f.clip),
      loop: f.clip.loop,
      priority: f.clip.priority,
      markers: (f.clip.markers ?? []).map((m) => m.name),
      joints: clipJointNames(f.clip),
      rig: f.clip.rig ?? null,
      hash: clipHash(f.clip),
    };
    let rec = svc.list(undefined, 'animation').find((a) => a.metadata.clipFile === clipFile) ?? null;
    if (rec) {
      svc.addEvent(rec.id, 'modified', actor, `updated ${clipFile}${f.preset ? ` (preset ${f.preset})` : ''}`, metadata, caller.taskId, caller.runId);
      rec = svc.bumpVersion(rec.id);
      svc.update(rec.id, { metadata });
    } else {
      rec = svc.record({
        name: f.clip.name,
        kind: 'animation',
        source: `shuriken:animation by ${actor}`,
        instancePaths: [`ReplicatedStorage.ShurikenAnimations.${f.clip.name}`],
        tags: ['animation', ...(f.preset ? [f.preset] : [])],
        metadata,
        event: 'generated',
        actor,
        taskId: caller.taskId,
        runId: caller.runId,
        summary: f.preset ? `from preset ${f.preset}` : 'custom clip',
      });
    }
    d.bus.emit('assets.changed', { id: rec.id });
    return rec.id;
  };

  reg.register({
    name: 'animation_presets',
    title: 'Animation presets',
    description:
      'List the built-in R15 animation presets (sword combo, heavy, block, parry, guard break, equip, combat idle, hit reactions, landing, idle, walk, run, sprint) with durations and markers, the joint conventions for custom clips, and (with preset) the full clip of one preset to use as a template. With rig (a rigged model): its joints, legs and attachment points, the motions Shuriken generates for it (walk, run, slither, idle, lunge, sting, slam, hit, death) and their parameters.',
    capability: 'roblox.app.animation',
    permission: 'read',
    input: {
      preset: z.string().optional().describe('Return this preset as a full clip (a template for custom animations)'),
      rig: z.string().optional().describe('A rigged model (models/<Model>.rig.json): its joints and the motions to generate for it'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      if (args.rig) {
        const body = loadRigBody(proj().root, args.rig);
        if (!body) return errorOutput(noRig(args.rig));
        const r = body.rig;
        return jsonOutput({
          rig: r.model,
          root: r.root,
          joints: r.joints.map((j) => ({ name: j.name, parent: j.parent, kind: j.kind, ...(j.kind === 'hinge' && j.axis ? { axis: j.axis } : {}), ...(j.limits ? { limits: j.limits } : {}) })),
          legs: r.legs,
          attachments: r.attachments.map((a) => `${a.name} on ${a.part}`),
          template: `ReplicatedStorage.ShurikenRigs.${r.model} (rig_build)`,
          motions: RIG_MOTION_GUIDE,
          conventions: RIG_CONVENTIONS,
        });
      }
      if (args.preset) {
        try {
          return jsonOutput({ clip: buildPreset(args.preset, args.preset), conventions: CONVENTIONS });
        } catch (e) {
          return errorOutput((e as Error).message);
        }
      }
      return jsonOutput({ presets: listPresets(), conventions: CONVENTIONS });
    },
  });

  reg.register({
    name: 'animation_create',
    title: 'Create or update an animation',
    description: `Create (or replace) one of the game's animations, from a preset or as a custom clip, and build it into Studio.
From a preset: {name, preset, intensity? 0.5–1.5, speed? 0.5–2, hand? "left"}. body_part "upper" keeps only the torso, head and arms (R15): at Action priority it plays over walking or running, whose legs carry on — attacks, blocks, casts and reloads on the move. Custom: {clip: {name, description?, loop, priority, keys: [{t, poses: {Joint: {rot?[x,y,z], pos?[x,y,z], ease?, dir?}}}], markers?: [{t, name}]}} (see animation_presets for conventions and templates).
Custom rigs (creatures, machines: a model rigged with kiln.rig, see animation_presets {rig}): {name, rig, motion: walk|run|slither|idle|lunge|sting|slam|hit|death, params?} generates the clip (feet planted, limits kept, markers placed); or {rig, clip} with the rig's joint names. The result has the clip's metrics and findings, and for walk/run/slither the groundSpeed to move the model at.
Shuriken validates the clip, saves animations/<name>.anim.json (the source of truth), regenerates ${BUILDER_REL}, builds it (KeyframeSequence + Animation in ReplicatedStorage.ShurikenAnimations), keeps the runtime module up to date and records it in the asset library.
Play it from game code with the module: local Anims = require(<requirePath from the result>); local track = Anims.play(character, "<name>"); Anims.onMarker(track, "Hit", fn). In Studio it plays without uploading; animation_check measures it on a real rig.`,
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    input: {
      name: z.string().optional().describe('Animation name (letters, digits, _); defaults to the preset name'),
      preset: z.string().optional(),
      intensity: z.number().optional(),
      speed: z.number().optional(),
      hand: z.enum(['right', 'left']).optional(),
      clip: z.record(z.string(), z.unknown()).optional().describe('A full custom clip instead of a preset'),
      rig: z.string().optional().describe('A rigged model (models/<Model>.rig.json): the clip is for it, not an R15 character'),
      motion: z.enum(RIG_MOTIONS).optional().describe('With rig: generate the clip (see animation_presets {rig} for each motion and its params)'),
      params: z.record(z.string(), z.unknown()).optional().describe("The motion's parameters: speed (studs/s), stride, lift, gait, phases, period, duration, chain, distance, height, amplitude, waves, from, side"),
      description: z.string().optional(),
      ground: z.boolean().optional().describe('Raise the hips wherever a pose would push the feet into the floor (default true)'),
      build: z.boolean().optional().describe('Build in Studio (default true)'),
      body_part: z
        .enum(['full', 'upper', 'lower'])
        .optional()
        .describe('R15: keep only the upper body (UpperTorso, head, arms: layers over walking/running) or the lower body (hips and legs). Default full.'),
    },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      let clip: AnimationClip;
      let preset: string | undefined;
      let authored: AnimationClip | null = null;
      const rigName = args.rig ?? (typeof args.clip?.rig === 'string' ? args.clip.rig : undefined);
      if (args.motion && !rigName) return errorOutput('motion generates clips for custom rigs: pass rig (the rigged model). R15 characters use a preset.');
      let body: RigBody | null = null;
      if (rigName) {
        body = loadRigBody(p.root, rigName);
        if (!body) return errorOutput(noRig(rigName));
      }
      let generated: ReturnType<typeof generateRigClip> | null = null;
      const invalid = (issues: z.ZodIssue[]) => errorOutput(`Invalid clip:\n${issues.slice(0, 12).map((i) => `${i.path.join('.') || '(clip)'}: ${i.message}`).join('\n')}`);
      if (args.motion && body) {
        const params = { ...(args.params as RigMotionParams | undefined), ...(args.intensity !== undefined ? { intensity: args.intensity } : {}) };
        try {
          generated = generateRigClip(body, args.motion, args.name ?? `${body.rig.model}${cap(args.motion)}`, params);
        } catch (e) {
          return errorOutput((e as Error).message);
        }
        clip = generated.clip;
        preset = `rig:${args.motion}`;
      } else if (args.clip && body) {
        const parsed = clipSchema.safeParse(args.clip);
        if (!parsed.success) return invalid(parsed.error.issues);
        clip = { ...(parsed.data as AnimationClip), rig: body.rig.model, ...(args.name ? { name: args.name } : {}) };
      } else if (args.clip) {
        const parsed = clipSchema.safeParse(args.clip);
        if (!parsed.success) return errorOutput(`Invalid clip:\n${parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(clip)'}: ${i.message}`).join('\n')}`);
        authored = parsed.data as AnimationClip;
        clip = resolveAims(authored);
        if (args.name) clip = { ...clip, name: args.name };
        if (args.ground !== false && validateClip(clip).length === 0) clip = groundClip(clip);
      } else if (args.preset) {
        try {
          clip = buildPreset(args.preset, args.name ?? args.preset, { intensity: args.intensity, speed: args.speed, hand: args.hand, ground: args.ground });
        } catch (e) {
          return errorOutput((e as Error).message);
        }
        preset = args.preset;
      } else return errorOutput('Pass a preset (see animation_presets) or a custom clip.');
      if (args.description) clip = { ...clip, description: args.description };
      if (args.body_part && args.body_part !== 'full') {
        if (body) return errorOutput("body_part is for R15 characters' clips; a custom rig's clip keys the joints it needs.");
        clip = bodyPartClip(clip, args.body_part);
        if (!clip.keys.some((k) => Object.keys(k.poses).length)) return errorOutput(`That clip doesn't move the ${args.body_part} body: nothing is left.`);
      }
      const problems = validateClip(clip, body?.rig);
      if (problems.length) return errorOutput(`The clip can't be used:\n- ${problems.join('\n- ')}`);
      const store = new AnimationStore(p.root);
      // A copilot's draft turn: saved to try out in the dock, under a free name (a draft never replaces a game animation).
      const asked = clip.name;
      if (caller.drafts) clip = { ...clip, name: store.freeName(asked) };
      const draftOf = caller.drafts ? (clip.name !== asked ? asked : store.get(clip.name)?.draftOf) : undefined;
      const file = store.save({
        clip,
        ...(caller.drafts ? { draft: true, ...(draftOf ? { draftOf } : {}) } : {}),
        preset,
        params: generated ? (args.params as RigMotionParams | undefined) : preset ? { intensity: args.intensity, speed: args.speed, hand: args.hand, ...(args.body_part && args.body_part !== 'full' ? { body_part: args.body_part } : {}) } : undefined,
        createdBy: caller.role ?? caller.kind,
      });
      const checked = body ? checkRigClip(body, clip) : null;
      // The asset library lists what the game has: a draft is recorded when it is added (animation_use).
      const asset = caller.drafts ? null : recordAsset(p, file, caller);
      d.bus.emit('animations.changed', { name: clip.name });
      const base = {
        name: clip.name,
        file: `animations/${clip.name}.anim.json`,
        duration: clipDuration(clip),
        loop: clip.loop,
        priority: clip.priority,
        markers: (clip.markers ?? []).map((m) => `${m.name} @ ${m.t}s`),
        asset,
        ...(body && checked
          ? {
              rig: body.rig.model,
              template: `ReplicatedStorage.ShurikenRigs.${body.rig.model}`,
              // Measured on the rig itself (x right, y up, f forward; studs from its root joint).
              metrics: checked.metrics,
              findings: checked.findings,
              ...(generated?.groundSpeed ? { groundSpeed: generated.groundSpeed, moveHint: `Move the model at ${generated.groundSpeed} studs/s while this plays (or scale the track's speed to the model's speed) so the feet don't slide.` } : {}),
              ...(generated?.notes.length ? { notes: generated.notes } : {}),
            }
          : {
              // Measured on the default rig (x right, y up, z forward, studs from the root).
              metrics: clipMetrics(clip),
            }),
        ...(() => {
          const misses = authored ? reachMisses(authored, clip) : [];
          return misses.length
            ? { reachMisses: misses, reachHint: 'These hands could not get to their reach points: an arm reaches about 1.8 studs from its shoulder and not behind the body. Move the point closer, or turn/lean the torso toward it.' }
            : {};
        })(),
      };
      if (caller.drafts) return jsonOutput({ ...base, built: false, draft: true, ...(draftOf ? { draftOf, replaces: `animation_use {name: "${clip.name}", as: "${draftOf}"} puts it in as ${draftOf}, replacing that one` } : {}), where: DRAFT_WHERE });
      if (args.build === false) return jsonOutput({ ...base, built: false, runtime: store.ensureRuntime(p.extras().syncMap) });
      const b = await buildInStudio(p, store, caller, signal);
      const mine = b.built.find((x) => x.name === clip.name);
      const failed = b.failed.find((x) => x.name === clip.name);
      const target = body ? 'creature' : 'character';
      const spawn = body ? `local creature = game.ReplicatedStorage.ShurikenRigs.${body.rig.model}:Clone() -- rig_build makes the template\ncreature:PivotTo(spawnCFrame)\ncreature.Parent = workspace\n` : '';
      const usage = `local Anims = require(${b.runtime.requirePath})\n${spawn}local track = Anims.play(${target}, "${clip.name}")${(clip.markers ?? []).length ? `\nAnims.onMarker(track, "${clip.markers![0]!.name}", function() --[[ gameplay at this moment ]] end)` : ''}`;
      const result = { ...base, built: !!mine, animationId: mine?.id ?? null, runtime: b.runtime, usage, ...(b.note ? { note: b.note } : {}), ...(b.uploads ? { uploads: b.uploads } : {}), ...(failed ? { error: failed.error } : {}) };
      return failed ? { ...jsonOutput(result, 'Build failed'), isError: true } : jsonOutput(result);
    },
  });

  reg.register({
    name: 'animation_build',
    title: 'Build all animations',
    description: `Rebuild every animation from animations/*.anim.json into Studio (${BUILDER_REL}) and refresh the runtime module. Use after editing clip files by hand or when the place lost them. Creature clips (custom rigs) whose current content isn't uploaded are uploaded as part of the build when uploading is set up (changed clips only, together), and the place is built again so they carry their asset ids — a track a server script plays on a creature reaches the players only through an uploaded asset; the result's uploads says what went up, or why not.`,
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: {},
    handler: async ({ caller, signal }) => {
      const p = proj();
      const store = new AnimationStore(p.root);
      const broken = store.broken();
      const b = await buildInStudio(p, store, caller, signal);
      const body = { ...b, broken };
      return b.failed.length || broken.length ? { ...jsonOutput(body, 'Some animations did not build'), isError: true } : jsonOutput(body);
    },
  });

  reg.register({
    name: 'animation_view',
    title: 'Look at an animation',
    description:
      `A filmstrip of an animation on a default R15 character (a custom rig's clip: on the rigged model itself): 8 frames across the clip (the frame nearest each marker, like "Hit", lands exactly on it), drawn with the same joint math Roblox uses and a sword in hand for sword moves. Use it after animation_create to judge the poses the way a player will see them — anticipation, the strike, follow-through, weight, balance, arcs — and fix what looks stiff, floaty or wrong before it goes in the game. The Animation page shows the user the same character.`,
    capability: 'roblox.app.animation',
    permission: 'read',
    input: {
      name: z.string(),
      frames: z.number().int().min(4).max(12).optional().describe('frames on the strip (default 8)'),
      sword: z.enum(['auto', 'none', 'right', 'left']).optional().describe('auto (default): sword presets and sword-named clips hold one'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const root = proj().root;
      const f = new AnimationStore(root).get(args.name);
      if (!f) return errorOutput(`No animation named ${args.name}`);
      if (!d.render) return errorOutput('Filmstrips are drawn by the Shuriken app; this engine is running without it. Check the clip with animation_check and a playtest screenshot instead.');
      const rig = f.clip.rig ? new ModelStore(root).rig(f.clip.rig) : null;
      if (f.clip.rig && !rig) return errorOutput(noRig(f.clip.rig));
      const sword = rig ? false : !args.sword || args.sword === 'auto' ? swordFor(f) : args.sword === 'none' ? false : args.sword;
      const image = rig
        ? await d.render({ kind: 'rig-animation', clip: f.clip, rig, parts: rigParts(root, rig.model), name: f.clip.name, frames: args.frames })
        : await d.render({ kind: 'animation', clip: f.clip, name: f.clip.name, sword, frames: args.frames });
      const data = image ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(image) : null;
      if (!data) return errorOutput('The filmstrip could not be drawn this time. Check the clip with animation_check and a playtest screenshot instead.');
      const markers = f.clip.markers ?? [];
      return {
        content: [
          { type: 'image', data: data[2]!, mimeType: data[1]! },
          {
            type: 'text',
            text: `${f.clip.name}${rig ? ` on ${rig.model}` : ''}: ${clipDuration(f.clip).toFixed(2)} s, ${f.clip.loop ? 'loops' : 'plays once'}, ${f.clip.priority} priority${markers.length ? `; markers ${markers.map((m) => `${m.name} at ${m.t.toFixed(2)} s`).join(', ')}` : ''}${sword ? `; drawn holding a sword (${sword} hand)` : ''}.`,
          },
        ],
      };
    },
  });

  reg.register({
    name: 'animation_list',
    title: 'List animations',
    description: "The game's animations (animations/*.anim.json): duration, loop, priority, markers, preset and upload state. Pass name for one full clip (to edit it and re-apply with animation_create).",
    capability: 'roblox.app.animation',
    permission: 'read',
    input: { name: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const store = new AnimationStore(p.root);
      if (args.name) {
        const f = store.get(args.name);
        return f ? jsonOutput({ ...store.summary(f), clip: f.clip, params: f.params ?? null }) : errorOutput(`No animation named ${args.name}. Existing: ${store.names().join(', ') || 'none'}`);
      }
      return jsonOutput({ animations: store.all().map((f) => store.summary(f)), broken: store.broken(), runtime: AnimationStore.runtimeLocation(p.extras().syncMap) });
    },
  });

  /** A custom rig's clip: measured offline on its rig, and on a copy of its template in Studio when it's connected. */
  const checkRigClipTool = async (p: ProjectContext, f: AnimationFile, caller: CallerContext, signal?: AbortSignal) => {
    const body = loadRigBody(p.root, f.clip.rig!);
    if (!body) return errorOutput(noRig(f.clip.rig!));
    const offline = checkRigClip(body, f.clip);
    const findings = [...offline.findings];
    let studio: Record<string, unknown> | string = 'Studio is not connected: measured offline on the rig only';
    if (f.draft) studio = 'a draft: not built in Studio, measured offline on the rig only';
    else if (d.studio.connected && !(await leaseBlocked(caller, signal))) {
      type Measured = { error?: string; length?: number; markers?: Array<{ name: string; t: number; attachments: Record<string, number[]> }>; turned?: Record<string, number>; sink?: number };
      const r = await d.studio.luauJson<Measured>(rigAnimationCheckLuau(f.clip.name, f.clip.rig!, f.clip.markers ?? []), 'Edit').catch((e: Error) => ({ error: e.message }) as Measured);
      if (r.error) {
        studio = `not measured: ${r.error}${/not built/.test(r.error) ? ' (animation_build)' : ''}`;
      } else {
        studio = r as Record<string, unknown>;
        const expected = clipDuration(f.clip);
        if (typeof r.length === 'number' && Math.abs(r.length - expected) > 0.05) findings.push(`Roblox reports a length of ${r.length}s but the clip is ${expected}s`);
        // Joints the clip turns that don't move in Studio: the template doesn't match the rig.
        const keyed = clipJointNames(f.clip).filter((n) => f.clip.keys.some((k) => (k.poses[n]?.rot ?? [0, 0, 0]).some((v) => Math.abs(v) > 3)));
        const still = keyed.filter((n) => (r.turned?.[n] ?? 0) < 0.5);
        if (still.length) findings.push(`in Studio ${still.slice(0, 6).join(', ')} don't move although the clip turns them: rebuild the rig (rig_build) and the animations (animation_build)`);
        // Attachments where the rig says they'll be.
        for (const [i, m] of (r.markers ?? []).entries()) {
          const want = offline.metrics.markers[i]?.attachments ?? {};
          for (const [name, got] of Object.entries(m.attachments ?? {})) {
            const w = want[name];
            if (!w) continue;
            const off = Math.hypot(got[0]! - w[0], got[1]! - w[1], got[2]! - w[2]);
            if (off > 0.3) findings.push(`in Studio ${name} is ${off.toFixed(2)} studs from where the rig puts it at "${m.name}": the template doesn't match models/${f.clip.rig}.rig.json (rig_build rebuilds it)`);
          }
        }
      }
    }
    return jsonOutput({ ...offline.metrics, studio, findings });
  };

  reg.register({
    name: 'animation_check',
    title: 'Measure an animation on a rig',
    description:
      `Play a built animation on a temporary default R15 rig in Studio (Edit mode, nothing is left behind; a custom rig's clip plays on a copy of its rig template and is measured on its rig offline too) and measure it: whether Roblox loads it and its length, hand/head positions at each marker (x right, y up, z forward, studs from the root), the right hand arc, how far the hands reach forward and how far the feet sink into or lift off the ground. Use it to check that a strike connects in front of the character at its Hit marker and that nothing clips or floats.`,
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    input: { name: z.string() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const f = new AnimationStore(p.root).get(args.name);
      if (!f) return errorOutput(`No animation named ${args.name}`);
      // A custom rig's clip is measured on its rig offline too; an R15 clip needs Studio.
      if (f.clip.rig) return checkRigClipTool(p, f, caller, signal);
      if (f.draft) return errorOutput(`${args.name} is a draft: it isn't built in Studio, so there is nothing to measure there. animation_view shows it; animation_use puts it in the game when the user says so.`);
      const av = d.studio.availability();
      if (!av.ok) return errorOutput(`animation_check plays the clip in Studio, which isn't available: ${av.reason ?? 'not connected'}. animation_view shows it meanwhile.`);
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      const r = await d.studio.luauJson<Record<string, unknown> & { error?: string; length?: number; extremes?: Record<string, number> }>(animationCheckLuau(f.clip.name, f.clip.markers ?? []), 'Edit');
      if (r.error) return errorOutput(`${r.error}${/not built/.test(r.error) ? ' — run animation_build first' : ''}`);
      const findings: string[] = [];
      const expected = clipDuration(f.clip);
      if (typeof r.length === 'number' && Math.abs(r.length - expected) > 0.05) findings.push(`Roblox reports a length of ${r.length}s but the clip is ${expected}s`);
      const x = r.extremes ?? {};
      if ((x.footSink ?? 0) < -0.3) findings.push(`the feet sink ${Math.abs(x.footSink!).toFixed(2)} studs below their rest height: bend the knees more or lower LowerTorso pos y less`);
      if ((x.footLift ?? 0) > 0.6 && !/jump|leap|land|slam|dodge|roll|fall|climb|flip|dash|air/i.test(f.clip.name)) findings.push(`both feet leave the ground by up to ${x.footLift!.toFixed(2)} studs`);
      // A strike should land in front: some hand or foot at least a stud forward at its Hit marker.
      type Limbs = { rightHand?: number[]; leftHand?: number[]; rightFoot?: number[]; leftFoot?: number[] };
      for (const m of (r.markers as Array<Limbs & { name: string; t: number }> | undefined) ?? []) {
        if (!/hit|impact|strike/i.test(m.name)) continue;
        const reach = Math.max(...[m.rightHand, m.leftHand, m.rightFoot, m.leftFoot].map((v) => (Array.isArray(v) ? Number(v[2]) : -Infinity)));
        if (reach < 1) findings.push(`at "${m.name}" (${m.t}s) no hand or foot is even a stud in front of the body (furthest ${reach.toFixed(2)}): the strike won't reach a target`);
      }
      if ((x.rightHandTravel ?? 1) < 0.1 && clipJoints(f.clip).some((j) => j.startsWith('Right'))) findings.push('the right hand barely moves: the poses may not be applied');
      return jsonOutput({ ...r, expectedLength: expected, findings });
    },
  });

  reg.register({
    name: 'animation_import',
    title: "Bring in one of the game's own animations",
    description:
      "Reads one of the game's own Roblox animations in Studio and makes it a clip here, so it can be looked at (animation_view), checked, changed (animation_list {name} for its keys, then animation_create {clip}) and rebuilt: path — a KeyframeSequence (an Animation Editor save, e.g. Workspace.Dummy.AnimSaves.Slash) or an Animation instance (e.g. ReplicatedStorage.Anims.Slash) — or asset_id (an animation the user or their group owns). R15 by default; rig: a rigged model here whose joints the animation moves. The game keeps playing its original animation until its code plays the new clip (Anims.play) or the clip is uploaded (animation_upload) and its id swapped in.",
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: { name: z.string(), path: z.string().optional(), asset_id: z.string().optional(), rig: z.string().optional(), replace: z.boolean().optional() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      if (!args.path && !args.asset_id) return errorOutput('Give path (a KeyframeSequence or Animation in the place) or asset_id.');
      if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(args.name)) return errorOutput('name: letters, digits and _ (start with a letter, at most 48).');
      const store = new AnimationStore(p.root);
      const name = caller.drafts ? store.freeName(args.name) : args.name;
      if (store.get(name) && !args.replace && !store.get(name)?.draft) return errorOutput(`An animation named ${name} exists; pick another name or pass replace: true.`);
      const rig = args.rig ? new ModelStore(p.root).rig(args.rig) : null;
      if (args.rig && !rig) return errorOutput(noRig(args.rig));
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      let raw: RawSequence & { error?: string };
      try {
        raw = await d.studio.luauJson<RawSequence & { error?: string }>(readKeyframesLuau({ path: args.path, assetId: args.asset_id }), 'Edit', 60_000);
      } catch (e) {
        return errorOutput(`Reading the animation failed: ${(e as Error).message.slice(0, 400)}`);
      }
      if (raw.error) return errorOutput(raw.error);
      if (!raw.keyframes?.length) return errorOutput('That animation has no keyframes.');
      const { clip, skipped } = sequenceToClip(name, raw, rig);
      const problems = validateClip(clip, rig ?? undefined);
      if (problems.length) return errorOutput(`It can't be used as a clip yet: ${problems.slice(0, 6).join('; ')}${skipped.length ? `. Poses for joints this ${rig ? 'rig' : 'R15 character'} doesn't have: ${skipped.join(', ')}${rig ? '' : ' (a custom rig? pass rig)'}` : ''}`);
      store.save({ clip, createdBy: caller.role ?? caller.kind, imported: { from: args.path ?? `rbxassetid://${String(args.asset_id).replace(/\D/g, '')}`, at: new Date().toISOString() }, ...(caller.drafts ? { draft: true } : {}) });
      d.bus.emit('animations.changed', { name: clip.name });
      return jsonOutput({
        name: clip.name,
        from: raw.name,
        duration: clipDuration(clip),
        keys: clip.keys.length,
        joints: clipJointNames(clip).length,
        markers: clip.markers ?? [],
        loop: clip.loop,
        priority: clip.priority,
        ...(skipped.length ? { skipped: `poses for joints ${rig ? `${rig.model}` : 'an R15 character'} doesn't have: ${skipped.join(', ')}` } : {}),
        ...(caller.drafts ? { draft: true, where: DRAFT_WHERE } : {}),
        next: caller.drafts ? 'animation_view shows it; animation_list {name} gives its keys to change with animation_create {clip}.' : 'animation_view shows it; animation_list {name} gives its keys to change with animation_create {clip}; animation_build puts it in the place.',
      });
    },
  });

  reg.register({
    name: 'animation_upload',
    title: 'Upload animations to Roblox',
    description:
      "Upload finished animations as Roblox Animation assets so they play in the published game too (in Studio they already play). Uploads the named one, or every animation whose current version isn't uploaded. Needs the user's Open Cloud key with the Assets permission; reports exactly what's missing when it can't. Upload when a move is final: every change to a clip needs a new upload.",
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    input: { name: z.string().optional() },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const store = new AnimationStore(p.root);
      if (!uploader) return errorOutput('Uploading is not available in this build.');
      const ready = await uploader.ready();
      if (!ready.ok) return errorOutput(ready.why.startsWith('uploading is turned off') ? 'Uploading is turned off in Settings.' : 'No Open Cloud API key is set (Settings → Roblox). Uploading needs one with the Assets read/write permission. The animations keep playing in Studio.');
      const todo = store.inGame().filter((f) => (!args.name || f.clip.name === args.name) && !store.summary(f).uploaded);
      if (!todo.length) return jsonOutput({ uploaded: [], note: args.name ? `${args.name} is already uploaded (or doesn't exist)` : 'every animation is uploaded' });
      // Together (up to six at a time), without the run's abort signal: an upload that started finishes and records its asset id.
      const up = await uploader.ensureMany(p.root, todo.map((f) => f.clip.name), { budgetMs: waitBudget(caller.kind, !!progress), signal, onProgress: (u) => progress?.({ message: u.message }) });
      const done = up.results.filter((r) => r.assetId).map((r) => ({ name: r.name, assetId: r.assetId! }));
      const pending = up.results.filter((r) => r.pending).map((r) => r.name);
      const failed = up.results.filter((r) => !r.assetId && !r.pending).map((r) => ({ name: r.name, error: r.why ?? 'upload failed' }));
      if (done.length) d.bus.emit('animations.changed', {});
      // The uploads are recorded: build again so the Animation objects carry their AssetId.
      const b = done.length ? await buildInStudio(p, store, caller, signal, { autoUpload: false }) : null;
      const body = {
        uploaded: done,
        ...(pending.length ? { pending, pendingNote: 'Roblox is still processing these (each is kept): call animation_upload again to pick them up.' } : {}),
        ...(up.stillUploading.length ? { stillUploading: up.stillUploading, stillUploadingNote: 'These are still uploading and carry on by themselves: call animation_upload again to join them.' } : {}),
        failed,
        studio: b && b.note ? b.note : done.length ? 'rebuilt: the game now uses the uploaded ids' : 'unchanged',
      };
      return failed.length ? { ...jsonOutput(body, 'Some animations did not upload'), isError: true } : jsonOutput(body);
    },
  });

  reg.register({
    name: 'animation_use',
    title: 'Add a draft animation to the game',
    description:
      'Adds a draft (an animation made in the Animation dock to try out) to the game: builds it into ReplicatedStorage.ShurikenAnimations and keeps the runtime module in the synced code, so game code can play it with the ShurikenAnimations module (Anims.play). as: put it in under another name, replacing that animation (a better take of "Slash1" made as the draft "Slash1_2"). Only when the user asked for it in their game.',
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    input: { name: z.string(), as: z.string().optional().describe('The game animation it replaces (default: its own name).') },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const store = new AnimationStore(p.root);
      const f = store.get(args.name);
      if (!f) return errorOutput(`No animation named ${args.name}`);
      const target = args.as?.trim() || f.clip.name;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(target)) return errorOutput('as: letters, digits and _ (start with a letter, at most 48).');
      if (!f.draft && target === f.clip.name) return jsonOutput({ name: f.clip.name, note: 'It is in the game already.' });
      const used = store.use(args.name, target)!;
      const asset = recordAsset(p, used, caller);
      d.bus.emit('animations.changed', { name: target });
      const b = await buildInStudio(p, store, caller, signal);
      const mine = b.built.find((x) => x.name === target);
      const failed = b.failed.find((x) => x.name === target);
      const who = used.clip.rig ? 'creature' : 'character';
      const result = {
        name: target,
        ...(target !== args.name ? { replaced: target, was: args.name } : {}),
        built: !!mine,
        animationId: mine?.id ?? null,
        asset,
        runtime: b.runtime,
        usage: `local Anims = require(${b.runtime.requirePath})\nlocal track = Anims.play(${who}, "${target}")`,
        ...(b.note ? { note: b.note } : {}),
        ...(b.uploads ? { uploads: b.uploads } : {}),
        ...(failed ? { error: failed.error } : {}),
      };
      return failed ? { ...jsonOutput(result, 'Build failed'), isError: true } : jsonOutput(result);
    },
  });

  reg.register({
    name: 'animation_remove',
    title: 'Remove an animation',
    description: 'Delete an animation (its clip file) and rebuild, so it disappears from ReplicatedStorage.ShurikenAnimations. Game code that plays it gets nil back.',
    capability: 'roblox.app.animation',
    permission: 'roblox_write',
    input: { name: z.string() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const store = new AnimationStore(p.root);
      const was = store.get(args.name);
      if (caller.drafts && was && !was.draft) return errorOutput(`${args.name} is in the game: removing it changes the game, which this turn can't. It goes when the user says so ("remove ${args.name} from the game").`);
      if (!store.remove(args.name)) return errorOutput(`No animation named ${args.name}`);
      d.bus.emit('animations.changed', { name: args.name });
      if (was?.draft) return jsonOutput({ removed: args.name, draft: true, remaining: store.names() });
      const b = await buildInStudio(p, store, caller, signal, { autoUpload: false });
      return jsonOutput({ removed: args.name, remaining: store.names(), studio: b.note ?? 'rebuilt' });
    },
  });
}
