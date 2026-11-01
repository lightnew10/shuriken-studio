import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EASES, textureRefs, TRACK_TYPES, validateEffect, withEmitterDefaults, type EffectSpec } from '@shared/effects';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { CodeSync } from '../roblox/code-sync';
import type { EventBus } from '../events';
import { errorOutput, jsonOutput, type CallerContext, type ToolOutput, type ToolRegistry } from './tool-registry';
import { EffectStore, FX_BUILDER_REL, type EffectFile } from '../effects/effects-service';
import { buildEffect, listEffectPresets } from '../effects/presets';
import { exampleEffect, listExamples } from '../effects/examples';
import { measureEffect } from '../effects/measure';
import { compileEffect } from '../effects/compile';
import { contactSheet } from '../effects/render';
import { lookOf, lookWarnings, type EffectLook } from '../effects/critique';
import { PreviewTextures } from '../effects/preview-textures';
import { deriveEffect, effectColors, type VariantRecipe } from '../effects/variants';
import { encodePng } from '../modeling/png';
import { CutsceneStore, cutsceneLength, sampleCutscene, shotSpeeds, validateCutscene, type CutsceneSpec } from '../effects/cutscenes';
import { TextureLibrary, TEX_ASSET_DIR } from '../effects/textures/library';
import { makeTexture, TEXTURE_KINDS, type TextureKind } from '../effects/textures';
import { AssetService } from '../assets/asset-service';
import { resolveCreator, type OpenCloudAssets } from '../roblox/open-cloud-assets';

export interface EffectToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  sync: CodeSync;
  bus: EventBus;
  /** Open Cloud uploads for generated textures (absent: textures stay local, effects use their stand-ins). */
  cloud?: OpenCloudAssets;
  uploads?: () => { enabled: boolean; creatorId: string | null };
  rememberCreator?: (id: string) => void;
  /** The Motion module's source (skill roblox-ui-motion), written beside the runtime when the game has none. */
  motionSource?: () => string | null;
}

/** What every field of an effect means (Roblox ParticleEmitter/Trail/Beam semantics), for agents writing specs. */
const SPEC_REFERENCE = {
  effect: 'name, kind: burst (one-shot) | persistent (stays on until stopped) | trail | beam, emitters[], tracks[] (the timeline), light?, duration? (seconds before a burst is cleaned up)',
  emitter: {
    texture: 'tex:<Name> (a texture you made with vfx_texture), rbxassetid://<id>, or a built-in rbxasset://textures/particles/{sparkles_main.dds (star), fire_sparks_main.dds (streak), fire_main.dds, smoke_main.dds, explosion01_core_main.dds (flash), explosion01_shockwave_main.dds (ring), explosion01_smoke_main.dds (puff), forcefield_glow_main.dds (glow), forcefield_vortex_main.dds, SquareParticle.png}',
    color: 'hex colours over each particle life, evenly spaced (1-8); multiplies the texture (keep textures white)',
    size: 'studs over life (1-8 values)',
    transparency: '0 opaque … 1 invisible over life',
    lifetime: '[min, max] seconds per particle',
    speed: '[min, max] studs/s along the emission direction',
    spread: '[x, y] SpreadAngle degrees around the direction (180 = all around)',
    direction: 'Top (default) | Bottom | Front | Back | Left | Right, relative to where it plays (a CFrame orients it)',
    emit: 'particles per burst (burst kind); scaled by the quality level at runtime',
    rate: 'particles per second (persistent kind, or a burst emitter with for)',
    for: 'a burst emitter that streams at rate for this many seconds',
    delay: 'seconds after the effect starts',
    drag: 'how many times a second particles lose half their speed (5 stops fast)',
    acceleration: '[x, y, z] studs/s² (Roblox gravity is 196.2; particles get none unless you give it)',
    lightEmission: '0..1: 1 adds the particle onto what is behind it (glows, sparks, fire); 0 normal blending (smoke, dust)',
    lightInfluence: '0..1: how much scene lighting shades it (1 for smoke and dust; 0 for things that glow)',
    brightness: 'multiplies the light a particle gives when lightInfluence is below 1; above 1 blooms with Lighting.Bloom',
    orientation: 'FacingCamera (default) | FacingCameraWorldUp | VelocityParallel (streaks along motion) | VelocityPerpendicular (flat across motion: emit up with speed 0.01 to lie on the ground)',
    squash: 'NumberSequence -3..3 that stretches one axis of the quad (check the look with vfx_play)',
    rotation: '[min, max] start rotation degrees', rotSpeed: '[min, max] degrees/s',
    zOffset: 'studs toward the camera when drawn (keeps a flash in front of smoke)',
    lockedToPart: 'particles move with their attachment (auras, a projectile core)',
    flipbook: '{layout: Grid2x2|Grid4x4|Grid8x8, mode: Loop|OneShot (once over each particle life)|PingPong|Random, fps: [min, max], startRandom} for a texture made with frames',
    windAffectsDrag: 'particles drift with workspace.GlobalWind (needs drag > 0)',
    offset: '[right, up, back] studs from where the effect plays', turn: '[x, y, z] degrees tilting the emitter (a slanted slash, a forward ring)',
    detail: 'low (always) | medium | high: the lowest quality level that draws it',
  },
  tracks: {
    common: 'type, at (s), duration (s, its curves run over it), offset [r, u, b], rotation [x, y, z] deg, detail, loop (persistent effects), name',
    curves: `a number, evenly spaced numbers, or {keys: [[t 0..1, value], …], ease}; colours the same with hex. Eases: ${EASES.join(', ')}, or [x1, y1, x2, y2]`,
    particles: 'an emitter inline (all emitter fields; at = its delay)',
    flash: 'a camera-facing pop: size curve, color, texture (flash), brightness',
    ring: 'a flat ring racing out (one particle across its direction): radius curve (studs), color, transparency, facing Top (ground) | Front | Right',
    slash: 'a crescent in the plane `rotation` tilts: size curve, color, texture (tex: of a vfx_texture kind slash, or a flipbook of one), spin (deg in its plane)',
    shell: 'a part that grows and fades: shape sphere|dome|cylinder|disc|pillar|block|wedge|mesh (meshId, textureId: a SpecialMesh scaled to size), size [x, y, z] studs, scale curve, color curve, transparency curve, material Neon|ForceField|Glass|Ice|SmoothPlastic, spin [x, y, z] deg/s',
    circle: 'a crisp ring drawn by four curved beams (telegraph rims, rings of light): radius curve, width curve, color, transparency',
    ribbon: 'a trail swept along path {kind: arc (radius, from, to degrees; 0 = forward, + = left) | spiral (r0, r1, turns, height) | orbit (radius, turns, height) | points ([x,y,z]…, smooth) | line (from, to)} over duration with ease; width, across flat|upright, trail {color, transparency, width, lifetime, lightEmission, texture}',
    beam: 'from [r, u, b] to [r, u, b] or "target" (opts.to), width [start, end], widthScale curve over time, color along it, transparency along it, fade curve over time, bend [right, up] studs, texture + textureSpeed/textureLength/textureMode, jag {segments, amplitude (share of length), rate (new shapes/s)} for lightning',
    light: 'kind point|spot, color, brightness curve, range curve (≤ 60), flicker 0..1, shadows',
    sound: 'sound: a ShurikenAudio name or rbxassetid://, volume, pitch [min, max]',
    shake: 'magnitude (degrees), duration, radius (falls off to 0 there)',
    hitstop: 'seconds: freezes opts.target\'s animations',
    highlight: 'a Highlight flash on opts.target: color, outline, transparency curve (fill), outlineTransparency',
    screen: 'fx flash|tint|vignette|speedlines|banner|hitmarker|shake on the screens of players within `within` studs: color, strength, text, duration',
    debris: 'count (≤ 40 parts), size [min, max], speed [min, max], spread deg, gravity, bounce, lifetime [min, max], color(s), material, shape block|wedge|ball',
    decal: 'texture laid on the ground below: size, color curve, transparency curve, spin deg/s',
    spawn: 'effect: another effect by name at `at`',
  },
  light: '{ color, brightness, range, duration } — a PointLight flash that fades over duration (0 = stays on)',
  trail: '{ color[], transparency[], width[] (WidthScale along the trail), lifetime seconds, lightEmission?, minLength?, faceCamera?, texture? }',
  beam: '{ color[], transparency[], width: [start, end], lightEmission?, segments?, curve?: [curveSize0, curveSize1], texture?, textureSpeed?, textureLength?, faceCamera? }',
  budget: 'hits: 20-120 particles, impact on frame 0, gone in ~1 s; auras under ~60 alive; ≤ 2 lights per effect; 600 per burst is the hard limit',
};

/** How long saving an effect waits for a playtest to end before leaving the build to vfx_build (an object so a test can shorten it). */
export const VFX_WAIT = { quickMs: 8_000 };

/** What a draft's result says about where it is (a dock copilot's draft turn; see copilots/copilot-roles.ts). */
const DRAFT_WHERE =
  "A draft: it plays in Shuriken's effects preview (the Effects container and the Animation page's Effects tab). It is NOT in the game or in Studio. The user adds it with Add to game there, or by telling you to put it in the game (then vfx_use does it).";

const CLEAR = `local root = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenEffects")
if root then
  for _, c in root:GetChildren() do
    if c.Name ~= "Remote" then c:Destroy() end
  end
end
return "cleared"`;

/** The Luau path of the shared folder (game.ReplicatedStorage.Shared) as an expression that may be nil. */
const findShared = (prefix: string) => {
  const segs = prefix.replace(/^game\.ReplicatedStorage\.?/, '');
  const parts = segs ? segs.split('.').map((s) => s.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '')) : [];
  return `local shared = game:GetService("ReplicatedStorage")\nfor _, n in ${JSON.stringify(parts).replace('[', '{').replace(/]$/, '}')} do shared = shared and shared:FindFirstChild(n) end`;
};

/**
 * Plays an effect in the Edit DataModel through the game's own ShurikenEffects module (a fresh copy of it,
 * so a just-synced version plays), measures what ran, and cleans up after `seconds`. Falls back to emitting
 * the template's particles when the module isn't in Studio.
 */
const playLuau = (name: string, pos: [number, number, number], seconds: number, sharedPrefix: string, target: string | null) => `${findShared(sharedPrefix)}
local HttpService = game:GetService("HttpService")
local root = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenEffects")
local tpl = root and root:FindFirstChild(${JSON.stringify(name)})
if not tpl then return HttpService:JSONEncode({ result = "missing" }) end
local kind = tpl:GetAttribute("Kind")
if kind == "trail" or kind == "beam" then return HttpService:JSONEncode({ result = "attach trails and beams to parts in game code" }) end
local at = CFrame.new(${pos.join(', ')})
local target = ${target ? `(function() local n = game for p in string.gmatch(${JSON.stringify(target)}, "[^%.]+") do n = n and n:FindFirstChild(p) end return n end)()` : 'nil'}
local mod = shared and shared:FindFirstChild("ShurikenEffects")
local samples = {}
if mod and mod:IsA("ModuleScript") then
  -- Studio may refuse this code a copy of a script or its require (2026-10-01): then the template's particles play below.
  local ok, Effects = pcall(function()
    local copy = mod:Clone()
    copy.Name = "ShurikenEffectsPreview"
    copy.Parent = mod.Parent
    local loaded, m = pcall(require, copy)
    copy:Destroy()
    if not loaded then error(m, 0) end
    return m
  end)
  if ok and Effects and Effects.play then
    local handle = Effects.play(${JSON.stringify(name)}, at, { force = true, target = target })
    for _, wait in { 0.05, 0.25, 0.6 } do
      task.wait(wait - (samples[#samples] and samples[#samples].t or 0))
      local s = Effects.stats()
      s.t = wait
      table.insert(samples, s)
    end
    task.delay(${seconds}, function()
      if handle and kind == "persistent" then handle.destroy() end
      local fx = workspace:FindFirstChild("ShurikenFX")
      if fx and fx:GetAttribute("ShurikenEffectPreview") then fx:Destroy() end
    end)
    return HttpService:JSONEncode({ result = "playing", runtime = true, samples = samples })
  end
end
local a = Instance.new("Attachment")
a.Name = "ShurikenEffectPreview"
a.WorldCFrame = at
a.Parent = workspace.Terrain
for _, c in tpl:GetChildren() do
  if c:IsA("ParticleEmitter") or c:IsA("Light") then
    local e = c:Clone()
    e.Parent = a
    if e:IsA("ParticleEmitter") then
      if kind == "persistent" then e.Enabled = true else e:Emit(math.max(1, e:GetAttribute("EmitCount") or 10)) end
    end
  end
end
task.delay(${seconds}, function() a:Destroy() end)
return HttpService:JSONEncode({ result = "playing", runtime = false })`;

/** Creates the effects folder and remote in Studio (for games that use only the runtime's code). */
const ROOT_LUAU = `local rs = game:GetService("ReplicatedStorage")
local root = rs:FindFirstChild("ShurikenEffects")
if not root then
  root = Instance.new("Folder")
  root.Name = "ShurikenEffects"
  root.Parent = rs
end
if not root:FindFirstChild("Remote") then
  local r = Instance.new("RemoteEvent")
  r.Name = "Remote"
  r.Parent = root
end
return "ok"`;

/** Resolves an uploaded Decal's image id in Studio (the content id effects need). */
const imageIdLuau = (decalId: string) => `local ok, model = pcall(function() return game:GetService("InsertService"):LoadAsset(${Number(decalId)}) end)
if not ok then return "error: " .. tostring(model) end
local d = model:FindFirstChildWhichIsA("Decal", true)
local tex = d and d.Texture or ""
model:Destroy()
return tex`;

/** The API of the runtime modules, for vfx_runtime and the skill. */
const RUNTIME_API = {
  ShurikenEffects: 'play(name, where, opts) → handle {stop, destroy, alive, move} · burst · attach(name, part) → handle · trail(name, blade) → Trail · beam(name, a0, a1) · projectile({from, to|direction, speed, path straight|arc|homing|spiral|wave, body, impact, onHit}) + flightTime(opts) · lightning(a, b, opts) · chain(points, opts) · telegraph(where, {radius|width,length, seconds, effect, onDone}) · flash(model, opts) · shake(deg, s, player?) · hitStop(character, s) · screen(fx, params, opts) · quality() / setQuality(level?) / budget() · setShake(scale) · preload(names?) · stats(). Server calls relay (opts.players / except / radius).',
  ShurikenCurves: 'lerp, slerp(cfA, cfB, t), ease(name, t), easer, bezierEase(x1,y1,x2,y2), bezier(p0..p3), quadratic, catmullRom(points, alpha?, closed?), polyline, arc(center, r, fromDeg, toDeg), spiral, ballistic(from, to, height), launch(from, to, s, g?), flight, orbit, steer(pos, vel, target, maxDeg/s, dt), lightning(a, b, opts), noise, fbm, flicker, wobble, sample/sampleColor (data curves). Paths: path:at(u) (even speed), :tangent(u), :frame(u), :raw(s), .length.',
  ShurikenScreenFX: 'damage(position, amount, {crit, heal, color}) · hitMarker() · flash(color, peak, s) · tint(color, strength, s) · vignette(strength, color, pulse) · lowHealth(fraction) · speedLines(on) · banner(text, {sub, color, seconds}) · combo(hits) · setFlashes(on) · cue(fx, params). Animated through Motion (Reduce Motion respected).',
  ShurikenCutscene: 'play(name | data, {players, onEnded}) → {stop, finished, wait} · intro({from, seconds, title, subtitle}) · onSignal(name, fn) · playing() · stop()',
  ShurikenWeather: 'set(kind | nil, {intensity, wind, gusts}) (Rain, Storm, Snow, Blizzard, Ash, Sandstorm, Leaves) · zone(part, kind) (Fireflies, Leaves, DustMotes, Mist, Embers, Spray, Haze, LightShaft, Waterfall, Steam; or tag "ShurikenAmbient" + attribute Ambient) · wind(vector) · gust(strength, s) · stats()',
};

/**
 * The VFX workshop for agents: effects as data (effects/<Name>.fx.json, timelines of tracks), textures
 * made from parameters (effects/textures), cutscenes (effects/cutscenes), built into
 * ReplicatedStorage.ShurikenEffects and played by the generated runtime modules.
 */
export function registerEffectTools(reg: ToolRegistry, d: EffectToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const leaseBlocked = async (_caller: CallerContext, _signal?: AbortSignal) => {
    const w = await d.studio.waitForLease();
    return w.ok ? null : errorOutput(`${w.message} Effects need Edit mode to build. The files are saved; run vfx_build later.`);
  };
  const changed = (name?: string) => d.bus.emit('effects.changed', { name });

  /**
   * Reads in Studio the image id of every texture that was uploaded (a Decal) while Studio couldn't be
   * asked. True when one was found (the builder needs writing again). The caller has Edit mode.
   */
  const readImageIds = async (p: ProjectContext, signal?: AbortSignal): Promise<boolean> => {
    const lib = new TextureLibrary(p.root);
    let found = false;
    for (const t of lib.all()) {
      if (!t.decalId || t.imageId) continue;
      const q = await d.studio.runLuau(imageIdLuau(t.decalId), 'Edit', 30_000, signal).catch(() => null);
      const imageId = q?.ok ? /(\d{5,})/.exec(q.output)?.[1] : undefined;
      if (imageId) {
        lib.update(t.name, { imageId });
        found = true;
      }
    }
    return found;
  };

  /**
   * Builds every effect into the open place. `wait: false` (saving an effect or a texture): when another
   * playtest holds Studio it waits a few seconds at most, and the result says the build is still to do
   * (vfx_build does it). In the user's test game the vfx tools spent 25 minutes waiting here, a minute or
   * two at a time, while the effect was already saved and measured.
   */
  const build = async (p: ProjectContext, store: EffectStore, caller: CallerContext, signal?: AbortSignal, opts: { wait?: boolean } = {}) => {
    // A dock copilot's draft turn changes nothing in the game: no runtime modules in its code, no builder, no Studio.
    if (caller.drafts) return { built: [] as string[], failed: [] as Array<{ name: string; error: string }>, notes: [] as string[], runtime: { ...EffectStore.runtimeLocation(p.extras().syncMap), written: [] as string[], motion: 'missing' as const }, note: DRAFT_WHERE };
    const runtime = store.ensureRuntime(p.extras().syncMap, d.motionSource?.() ?? null);
    const saved = store.writeBuilder();
    const empty = { built: [] as string[], failed: [] as Array<{ name: string; error: string }>, notes: [] as string[] };
    if (!d.studio.connected) return { ...empty, runtime, note: `Studio is not connected; ${FX_BUILDER_REL} builds the effects on the next world_rebuild.` };
    const w = await d.studio.waitForLease(opts.wait === false ? VFX_WAIT.quickMs : Infinity);
    if (!w.ok) {
      if (signal?.aborted || opts.wait !== false) return { ...empty, runtime, note: `${w.message} Effects need Edit mode to build. The files are saved; run vfx_build later.` };
      return { ...empty, runtime, pending: true, note: `Saved, measured and pictured; NOT in the place yet: Studio is in a playtest (${d.lease.describe() ?? 'another one'}), and building needs Edit mode. Go on with your other effects and their pictures, then run vfx_build once (it waits for Edit mode) before you play them in Studio.` };
    }
    let out: { built: string[]; failed: Array<{ name: string; error: string }>; notes: string[] } = { ...empty };
    // Textures uploaded while Studio was busy get their image ids now, and the builder is written with them.
    const code = (await readImageIds(p, signal)) ? store.writeBuilder() : saved;
    if (!code) {
      await d.studio.runLuau(CLEAR, 'Edit', 60_000, signal);
      await d.studio.runLuau(ROOT_LUAU, 'Edit', 30_000, signal);
    } else {
      const r = await d.studio.runLuau(code, 'Edit', 180_000, signal);
      if (!r.ok) return { ...out, runtime, note: `Build failed: ${r.output.slice(0, 1500)}` };
      try {
        out = JSON.parse(r.output) as typeof out;
        out.built ??= [];
        out.failed ??= [];
        out.notes ??= [];
      } catch {
        return { ...out, runtime, note: `Unexpected build output: ${r.output.slice(0, 500)}` };
      }
      store.markBuilt(code);
    }
    d.bus.emit('roblox.changed', { reason: 'luau' });
    const mode = p.extras().syncMode;
    let sync = 'Studio Script Sync';
    if (mode === 'none') sync = `code sync is off: add ${[...runtime.files, runtime.clientFile].join(', ')} yourself`;
    else if (mode !== 'script-sync') {
      const rep = await d.sync.push(p.root, p.extras().syncMap, { only: [...runtime.files, runtime.clientFile] });
      sync = rep.errors.length ? `failed: ${rep.errors.map((e) => e.error).join('; ').slice(0, 300)}` : rep.created.length || rep.updated.length ? 'pushed' : 'up to date';
    }
    return { ...out, runtime: { ...runtime, sync } };
  };

  const record = (p: ProjectContext, f: EffectFile, caller: CallerContext) => {
    const svc = new AssetService(p.store);
    const actor = caller.role ?? caller.kind;
    const file = `effects/${f.effect.name}.fx.json`;
    const metadata = { effectFile: file, preset: f.preset ?? null, effectKind: f.effect.kind, emitters: (f.effect.emitters ?? []).map((e) => e.name), tracks: (f.effect.tracks ?? []).map((t) => t.type), params: f.params ?? null };
    let rec = svc.list(undefined, 'effect').find((a) => a.metadata.effectFile === file) ?? null;
    if (rec) {
      svc.addEvent(rec.id, 'modified', actor, `updated ${file}`, metadata, caller.taskId, caller.runId);
      rec = svc.bumpVersion(rec.id);
      svc.update(rec.id, { metadata });
    } else {
      rec = svc.record({
        name: f.effect.name,
        kind: 'effect',
        source: `shuriken:vfx by ${actor}`,
        instancePaths: [`ReplicatedStorage.ShurikenEffects.${f.effect.name}`],
        tags: ['vfx', f.effect.kind, ...(f.preset ? [f.preset] : [])],
        metadata,
        event: 'generated',
        actor,
        taskId: caller.taskId,
        runId: caller.runId,
        summary: f.preset ? `effect from ${f.preset}` : 'custom effect',
      });
    }
    d.bus.emit('assets.changed', { id: rec.id });
    return rec.id;
  };

  /** The effect's "tex:" textures: missing ones (an error) and ones not uploaded yet (a stand-in plays). */
  const textureNotes = (p: ProjectContext, e: EffectSpec) => {
    const lib = new TextureLibrary(p.root);
    const missing: string[] = [];
    const standIns: string[] = [];
    for (const n of textureRefs(e)) {
      const t = lib.get(n);
      if (!t) missing.push(n);
      else if (!t.imageId) standIns.push(`${n} (until it is uploaded: ${t.fallback || 'no texture'})`);
    }
    return { missing, standIns };
  };

  /**
   * The effect's contact sheet (frames over its time, by day and in the dark, drawn in software by the same
   * player the app's preview uses) with what its pixels say. Never fails the call it is part of.
   */
  const picture = (p: ProjectContext, effect: EffectSpec, times?: number[]): { look: EffectLook; warnings: string[]; png: Buffer } | null => {
    try {
      const store = new EffectStore(p.root);
      const pictures = new PreviewTextures(p.root);
      const sheet = contactSheet(effect, { textures: (ref) => pictures.get(ref), resolve: (n) => store.get(n)?.effect ?? exampleEffect(n, n), ...(times?.length ? { times } : {}) });
      return { look: lookOf(sheet), warnings: lookWarnings(sheet), png: encodePng(sheet.image) };
    } catch {
      return null;
    }
  };

  /** Keeps the sheet as the task's evidence for the effect: one picture per effect, the newest (the critic looks at it). */
  const keepPicture = (p: ProjectContext, caller: CallerContext, name: string, png: Buffer, look: EffectLook): string | null => {
    try {
      if (!caller.taskId || !p.tasks.get(caller.taskId)) return null;
      const dir = join(p.dir, 'evidence');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${caller.taskId}-vfx-${name}.png`);
      writeFileSync(file, png);
      const title = `Contact sheet: ${name}`;
      const had = p.tasks.evidence(caller.taskId).find((e) => e.kind === 'screenshot' && e.title === title);
      return (had ?? p.tasks.addEvidence({ taskId: caller.taskId, runId: caller.runId, kind: 'screenshot', title, passed: null, data: { effect: name, sheet: look.sheet, offline: true }, path: file })).id;
    } catch {
      return null;
    }
  };

  /** The timeline as text: what starts when and for how long. */
  const timelineText = (e: EffectSpec) => {
    const { emitters, tracks } = compileEffect(e);
    const rows = [
      ...emitters.map((m) => ({ at: m.delay, text: `${m.name}: particles ${m.emit ?? (m.rate ? `${m.rate}/s` : '?')} × ${m.lifetime[0]}–${m.lifetime[1]} s` })),
      ...tracks.map((t) => ({ at: t.at ?? 0, text: `${t.name ?? t.type}: ${t.type}${'duration' in t && t.duration ? ` ${t.duration} s` : ''}` })),
    ].sort((a, b) => a.at - b.at);
    return rows.map((r) => `${r.at.toFixed(2)} s  ${r.text}`);
  };

  /** Uploads a saved texture (Open Cloud, a Decal) and records its ids; returns what happened, in words. */
  const uploadTexture = async (p: ProjectContext, name: string, signal?: AbortSignal): Promise<string> => {
    const lib = new TextureLibrary(p.root);
    const t = lib.get(name);
    if (!t) return `no texture named ${name}`;
    if (!d.cloud || !d.uploads?.().enabled) return 'uploading is off (Settings) or unavailable: the place uses the stand-in';
    const who = await resolveCreator(d.studio, d.uploads().creatorId, d.rememberCreator ?? (() => undefined));
    if (!who) return 'uploading needs the Roblox creator (sign in to Studio, or set the creator id in Settings)';
    const r = await d.cloud.upload({ file: join(p.root, t.file), type: 'Decal', name, description: `VFX texture (${t.kind}) made with Shuriken Studio`, creator: { userId: who } }, signal);
    if (!r.ok || !r.assetId) {
      lib.update(name, { upload: { operation: r.operation, error: r.error, at: new Date().toISOString() } });
      return `not uploaded: ${r.error ?? 'unknown error'}`;
    }
    let imageId: string | undefined;
    // Its image id is read in Studio's Edit mode: not while a playtest holds it (the next build reads it then).
    const free = d.studio.connected ? await d.studio.waitForLease(VFX_WAIT.quickMs) : { ok: false };
    if (free.ok) {
      const q = await d.studio.runLuau(imageIdLuau(r.assetId), 'Edit', 30_000, signal).catch(() => null);
      imageId = q?.ok ? /(\d{5,})/.exec(q.output)?.[1] : undefined;
    }
    lib.update(name, { decalId: r.assetId, imageId, upload: undefined });
    if (imageId) return `uploaded: decal ${r.assetId}, image ${imageId}`;
    if (d.studio.connected && !free.ok) return `uploaded as decal ${r.assetId}; Studio is in a playtest, so its image id is read at the next build (vfx_build, or the next effect saved while Studio is free); the stand-in plays until then`;
    return `uploaded as decal ${r.assetId}, but its image id could not be read in Studio yet (it may still be in moderation): run vfx_texture {name, upload: true} again later; the stand-in plays meanwhile`;
  };

  reg.register({
    name: 'vfx_presets',
    title: 'Effect examples and presets',
    description:
      'Worked examples of complete effects (timelines: FireballImpact, FireBolt, SwordSlash, LightningStrike, IceShatter, HolyPillar, HealAura, WindSpin — what each teaches) and quick presets (HitSpark, BlockSpark, PunchImpact, Shockwave, ImpactDust, Explosion, Heal, LevelUp, Pickup, DashBurst, Aura, Fire, Sparkle, Smoke, SlashTrail, EnergyBeam), with the full reference of effect fields and tracks. With preset, the full spec of one: a template to read and adapt, not a menu (design each effect for its move, palette and camera; skill roblox-vfx).',
    capability: 'roblox.app.vfx',
    permission: 'read',
    input: { preset: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      if (args.preset) {
        const ex = exampleEffect(args.preset, args.preset);
        if (ex) return jsonOutput({ effect: ex, measure: measureEffect(ex).line, reference: SPEC_REFERENCE });
        try {
          return jsonOutput({ effect: buildEffect(args.preset, args.preset), reference: SPEC_REFERENCE });
        } catch (e) {
          return errorOutput(`${(e as Error).message}. Examples: ${listExamples().map((x) => x.id).join(', ')}`);
        }
      }
      return jsonOutput({ examples: listExamples(), presets: listEffectPresets(), reference: SPEC_REFERENCE });
    },
  });

  reg.register({
    name: 'vfx_create',
    title: 'Create or update an effect',
    description: `Create, change or vary one of the game's visual effects.
- New: spec, a custom effect (the way to make a game's effects: design it for the move; skill roblox-vfx): {name, kind: "burst"|"persistent"|"trail"|"beam", emitters?: [...], tracks?: [timeline: particles, flash, ring, slash, shell, circle, ribbon, beam, light, sound, shake, hitstop, highlight, screen, debris, decal, spawn — each at a time with curves], trail?, beam?, light?, duration?}; vfx_presets has every field. Textures: "tex:<Name>" for one you made with vfx_texture. Or example: "FireballImpact" (a worked one, see vfx_presets), or preset (tuned with color/color2 hex, scale 0.25–4, intensity 0.25–3).
- Change one you have (don't send it whole again): name + set, changes by path: {"tracks.Core.size": [4, 9], "emitters.Flames.rate": 30, "tracks.Smoke.transparency": [0.6, 1], "duration": 2, "tracks.Dust": null (removes it), "tracks.Rim": {type: "circle", …} (adds it)}. A track or emitter is named by its name, or its number counted from 1.
- A variant (the same effect in another colour): from: "PowerUpCollect", name: "PowerUpCollect_Rage", then to: "#ff3a28" (turns every colour's hue so the main colour becomes it; white cores stay white), hue (degrees), palette: {"#ffc428": "#ff3a28"} (exact swaps), set. A variant follows its base: change the base later and its variants are made again.
Shuriken validates it, measures it and draws it: analysis has the numbers (duration, particles per quality level, reach, screen coverage, when the impact lands), the warnings a VFX artist would give, and look, read off the picture that comes with the result — a contact sheet of frames over its time, by day over grass and on a dark stage, drawn offline exactly as ShurikenEffects plays it (no Studio needed: look at it, fix, look again). It saves effects/<name>.fx.json, regenerates ${FX_BUILDER_REL} and builds it into ReplicatedStorage.ShurikenEffects; when another playtest holds Studio it does not wait (built: false, pending: true): run vfx_build once before you play your effects in Studio.
Game code: local Effects = require(<requirePath>); Effects.play(name, cframe, {target = hitModel}) · Effects.attach(name, part) → handle.stop() · Effects.projectile({from, to, body, impact}) · Effects.trail(name, blade). Read analysis.warnings and the picture, fix what they show; the final look (real lighting, Bloom) is vfx_play + roblox_screenshot or a playtest.`,
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    input: {
      name: z.string().optional().describe('Effect name (letters, digits, _); defaults to the preset or example name'),
      spec: z.record(z.string(), z.unknown()).optional().describe('A full effect spec'),
      example: z.string().optional().describe('Start from a worked example (vfx_presets lists them)'),
      preset: z.string().optional(),
      color: z.string().optional(),
      color2: z.string().optional(),
      scale: z.number().optional(),
      intensity: z.number().optional(),
      from: z.string().optional().describe('An effect of the game (or a worked example) to make this one from: with another name it is a variant that follows it'),
      set: z.record(z.string(), z.unknown()).optional().describe('Changes by path, e.g. {"tracks.Core.size": [4, 9], "emitters.Flames.rate": 30, "tracks.Dust": null}'),
      to: z.string().optional().describe("A variant's main colour (hex): every colour's hue turns with it; white stays white"),
      hue: z.number().optional().describe('Turn every colour by this many degrees'),
      palette: z.record(z.string(), z.string()).optional().describe('Exact colour swaps {"#from": "#to"}'),
      build: z.boolean().optional().describe('false: save and measure only'),
      wait: z.boolean().optional().describe("true: wait for Studio's Edit mode when a playtest holds it (default: don't; vfx_build later)"),
      sheet: z.boolean().optional().describe('false: no picture'),
    },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const store = new EffectStore(p.root);
      let effect: EffectSpec;
      let recipe: VariantRecipe | undefined;
      let kept: Partial<EffectFile> = {};
      const changes = args.set || args.to || args.hue !== undefined || args.palette;
      const own = { ...(args.palette ? { palette: args.palette } : {}), ...(args.to ? { to: args.to } : {}), ...(args.hue !== undefined ? { hue: args.hue } : {}), ...(args.set ? { set: args.set } : {}) };
      const misfit = (source: string, spec: EffectSpec, problems: string[]) =>
        errorOutput(`Those changes don't fit ${source}:\n- ${problems.join('\n- ')}\nIts emitters: ${(spec.emitters ?? []).map((m) => m.name).join(', ') || 'none'}; its tracks: ${(spec.tracks ?? []).map((t, i) => t.name ?? `${i + 1} (${t.type})`).join(', ') || 'none'}.`);
      if (args.spec) {
        effect = { ...(args.spec as unknown as EffectSpec), ...(args.name ? { name: args.name } : {}) };
      } else if ((args.from || (changes && args.name)) && !args.example && !args.preset) {
        // From an effect the game has: itself changed (the same name), or a variant of it (another name).
        const source = args.from ?? args.name!;
        const base = store.get(source);
        const spec = base?.effect ?? exampleEffect(source, source);
        if (!spec) return errorOutput(`No effect named ${source} to start from. Existing: ${store.names().join(', ') || 'none'}; worked examples: ${listExamples().map((x) => x.id).join(', ')}`);
        const name = args.name ?? source;
        const made = deriveEffect(spec, name, own);
        if (made.problems.length) return misfit(source, spec, made.problems);
        effect = made.effect;
        if (base && name !== source) recipe = { base: source, ...own };
        else if (base) {
          // The effect itself: what it came from stays, and a variant keeps following its base with these changes on top.
          kept = { preset: base.preset, params: base.params };
          if (base.variantOf) recipe = { ...base.variantOf, ...(own.palette ? { palette: { ...base.variantOf.palette, ...own.palette } } : {}), ...(own.to ? { to: own.to } : {}), ...(own.hue !== undefined ? { hue: own.hue } : {}), ...(own.set ? { set: { ...base.variantOf.set, ...own.set } } : {}) };
        }
      } else if (args.example) {
        const ex = exampleEffect(args.example, args.name ?? args.example);
        if (!ex) return errorOutput(`No example "${args.example}". Examples: ${listExamples().map((x) => x.id).join(', ')}`);
        effect = ex;
      } else if (args.preset) {
        try {
          effect = buildEffect(args.preset, args.name ?? args.preset, { color: args.color, color2: args.color2, scale: args.scale, intensity: args.intensity });
        } catch (e) {
          return errorOutput((e as Error).message);
        }
      } else return errorOutput('Pass a spec (design it: skill roblox-vfx), name + set (changes to one you have), from (a variant), an example or a preset (see vfx_presets).');
      if (changes && (args.example || args.preset)) {
        // An example or preset with changes on top: its own effect from the start.
        const made = deriveEffect(effect, effect.name, own);
        if (made.problems.length) return misfit(args.example ?? args.preset!, effect, made.problems);
        effect = made.effect;
      }
      effect = withEmitterDefaults(effect);
      const problems = validateEffect(effect);
      if (problems.length) return errorOutput(`The effect can't be used:\n- ${problems.join('\n- ')}\nTrack types: ${TRACK_TYPES.join(', ')}; vfx_presets has the reference.`);
      const tex = textureNotes(p, effect);
      if (tex.missing.length) return errorOutput(`No texture named ${tex.missing.join(', ')}: make it with vfx_texture first (existing: ${new TextureLibrary(p.root).names().join(', ') || 'none'}).`);
      // A copilot's draft turn: saved to try out in the preview, under a free name (a draft never replaces a game effect).
      const asked = effect.name;
      if (caller.drafts) effect = { ...effect, name: store.freeName(asked) };
      const draftOf = caller.drafts ? (effect.name !== asked ? asked : store.get(effect.name)?.draftOf) : undefined;
      const file = store.save({
        effect,
        ...(caller.drafts ? { draft: true, ...(draftOf ? { draftOf } : {}) } : {}),
        // A draft is its own take: only an effect of the game follows a base.
        ...(recipe && !caller.drafts ? { variantOf: recipe } : {}),
        preset: args.preset ?? (args.example ? `example:${args.example}` : kept.preset),
        params: args.preset ? { color: args.color, color2: args.color2, scale: args.scale, intensity: args.intensity } : kept.params,
        createdBy: caller.role ?? caller.kind,
      });
      // The asset library lists what the game has: a draft is recorded when it is added (vfx_use).
      const asset = caller.drafts ? null : record(p, file, caller);
      changed(effect.name);
      // Its variants were made again from it (EffectStore.save).
      const followers = store.variantsOf(effect.name).map((f) => f.effect.name);
      const m = measureEffect(effect);
      const pic = args.sheet === false ? null : picture(p, effect);
      const evidence = pic && !caller.drafts ? keepPicture(p, caller, effect.name, pic.png, pic.look) : null;
      const analysis = { line: m.line, warnings: [...m.warnings, ...(pic?.warnings ?? [])], timeline: timelineText(effect), ...(pic ? { look: pic.look } : {}), ...(tex.standIns.length ? { standInTextures: tex.standIns } : {}) };
      const base = {
        name: effect.name,
        kind: effect.kind,
        file: `effects/${effect.name}.fx.json`,
        ...(recipe ? { variantOf: recipe.base, colors: effectColors(effect).slice(0, 8) } : {}),
        ...(followers.length ? { variantsUpdated: followers } : {}),
        analysis,
        asset,
        ...(evidence ? { evidence } : {}),
      };
      /** The result with its picture (the sheet the analysis read). */
      const withPicture = (body: Record<string, unknown>, isError = false): ToolOutput => {
        const out: ToolOutput = isError ? { ...jsonOutput(body, 'Build failed'), isError: true } : jsonOutput(body);
        if (pic) out.content.push({ type: 'image', data: pic.png.toString('base64'), mimeType: 'image/png' });
        return out;
      };
      if (caller.drafts) return withPicture({ ...base, built: false, draft: true, ...(draftOf ? { draftOf, replaces: `vfx_use {name: "${effect.name}", as: "${draftOf}"} puts it in as ${draftOf}, replacing that one` } : {}), where: DRAFT_WHERE });
      if (args.build === false) return withPicture({ ...base, built: false, runtime: store.ensureRuntime(p.extras().syncMap, d.motionSource?.() ?? null) });
      const b = await build(p, store, caller, signal, { wait: args.wait === true });
      const failed = b.failed.find((x) => x.name === effect.name);
      const call =
        effect.kind === 'burst'
          ? `Effects.play("${effect.name}", cframe, { target = hitModel }) -- Vector3, CFrame, part or attachment; the server relays it`
          : effect.kind === 'persistent'
            ? `local fx = Effects.attach("${effect.name}", part) -- fx.stop() to end it`
            : effect.kind === 'trail'
              ? `local trail = Effects.trail("${effect.name}", bladePart) -- trail.Enabled = true while swinging`
              : `Effects.beam("${effect.name}", attachmentA, attachmentB)`;
      const notes = b.notes?.filter((n) => n.startsWith(`${effect.name}:`)) ?? [];
      const body = { ...base, built: b.built.includes(effect.name), ...('pending' in b && b.pending ? { pending: true } : {}), runtime: b.runtime, usage: `local Effects = require(${b.runtime.requirePath})\n${call}`, ...('note' in b && b.note ? { note: b.note } : {}), ...(notes.length ? { buildNotes: notes } : {}), ...(failed ? { error: failed.error } : {}) };
      return withPicture(body, !!failed);
    },
  });

  reg.register({
    name: 'vfx_measure',
    title: 'Measure an effect',
    description:
      'Measure and look at an effect offline, the way ShurikenEffects plays it (by name, or a spec you are drafting; nothing is saved, Studio is not needed): duration, particles per play at each quality level and alive at the peak, parts, lights and beams, reach (bounds), how much of the view it fills from a fighting distance and how opaque its centre gets, when the impact lands and when it settles, its timeline, the warnings (a dark opaque blob, too long for a hit, nothing on the first frame, too heavy for phones, layers that vanish by day, parts burnt out to white…), and its picture: a contact sheet of frames over its time (times: your own moments, in seconds), by day over grass and on a dark stage, with look (what the pixels say). Use it while iterating and when reviewing an effect; vfx_create returns the same.',
    capability: 'roblox.app.vfx',
    permission: 'read',
    input: {
      name: z.string().optional(),
      spec: z.record(z.string(), z.unknown()).optional(),
      times: z.array(z.number().min(0).max(30)).max(12).optional().describe('Frame times in seconds (default: six where the effect shows most)'),
      sheet: z.boolean().optional().describe('false: numbers only'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      let effect: EffectSpec | null = null;
      if (args.spec) effect = args.spec as unknown as EffectSpec;
      else if (args.name) effect = new EffectStore(p.root).get(args.name)?.effect ?? exampleEffect(args.name, args.name);
      if (!effect) return errorOutput('Pass name (an effect of the game, or an example) or spec.');
      const filled: EffectSpec = withEmitterDefaults(effect);
      effect = filled;
      const problems = validateEffect({ ...filled, name: filled.name ?? 'Draft' });
      const m = measureEffect(effect);
      const pic = args.sheet === false || problems.length ? null : picture(p, { ...effect, name: effect.name ?? 'Draft' }, args.times);
      const out = jsonOutput({ ...m, warnings: [...m.warnings, ...(pic?.warnings ?? [])], timeline: timelineText(effect), ...(pic ? { look: pic.look } : {}), ...(problems.length ? { problems } : {}) });
      if (pic) out.content.push({ type: 'image', data: pic.png.toString('base64'), mimeType: 'image/png' });
      return out;
    },
  });

  reg.register({
    name: 'vfx_texture',
    title: 'Make a VFX texture',
    description: `Generate a VFX texture from parameters (a PNG, white with alpha so an emitter's Color tints it; premultiplied edges and colour bled into transparent texels, so no dark fringes) and upload it (Open Cloud, when the key allows): effects then use it as "tex:<name>". Kinds: ${Object.entries(TEXTURE_KINDS)
      .map(([k, v]) => `${k} (${v.description.split(':')[0]!.split('.')[0]})`)
      .join('; ')}. list: true gives a kind's parameters (with defaults and ranges) and makes nothing: read them before you guess. Flipbooks: frames 4, 16 or 64 (Grid2x2, Grid4x4, Grid8x8) — set the emitter's flipbook {layout, mode} to match. The result: analysis (coverage, edge softness, colour under the alpha, dark fringe texels, cell borders, frame-to-frame continuity and loop seam for flipbooks, tiling for strips), problems to fix, and a picture (on black, on a checker, tinted). Iterate with the same name. Until uploaded, the place uses a built-in stand-in.`,
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    input: {
      name: z.string().optional().describe('Texture name (letters, digits, _); effects use "tex:<name>"'),
      kind: z.enum(Object.keys(TEXTURE_KINDS) as [TextureKind, ...TextureKind[]]),
      params: z.record(z.string(), z.unknown()).optional().describe("The kind's parameters (list: true shows them)"),
      list: z.boolean().optional().describe("true: return this kind's parameters and make nothing"),
      size: z.number().int().optional().describe('Pixels on a side: 128, 256, 512 or 1024 (flipbooks: at least 64 px per frame)'),
      frames: z.number().int().optional().describe('1 (a still), 4, 16 or 64 (a flipbook)'),
      seed: z.number().int().optional(),
      upload: z.boolean().optional().describe('Upload to Roblox now (default true; pass false while iterating)'),
    },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const info = TEXTURE_KINDS[args.kind];
      // Asking what a kind takes (agents did it with a made-up parameter, which saved a texture each time).
      const asking = args.list === true || !args.name || Object.keys(args.params ?? {}).some((k) => /^_*list/i.test(k));
      if (asking) return jsonOutput({ kind: args.kind, what: info.description, params: info.params, frames: `${info.frames} by default${info.variants ? ' (variants for a Random flipbook, not frames in time)' : ''}; 1, 4, 16 or 64`, ...(info.aspect && info.aspect !== 1 ? { shape: `a strip ${info.aspect} times as wide as tall (for beams and trails)` } : {}), made: 'nothing: call again with name and params' });
      const name = args.name!;
      const unknown = Object.keys(args.params ?? {}).filter((k) => !(k in info.params));
      let made;
      try {
        made = makeTexture(args.kind, args.params ?? {}, { size: args.size, frames: args.frames, seed: args.seed });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const lib = new TextureLibrary(p.root);
      const rel = `${TEX_ASSET_DIR}/${name}.png`;
      // New pixels: a new upload (the old image id no longer matches).
      let entry;
      try {
        entry = lib.save({ name, kind: args.kind, params: args.params ?? {}, size: Math.max(made.width, made.height), grid: made.grid > 1 ? made.grid : undefined, file: rel, analysis: made.line, fallback: made.fallback, createdBy: caller.role ?? caller.kind }, made.png);
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      let uploadNote = caller.drafts ? 'not uploaded: drafts stay in Shuriken (the preview shows it); it uploads when its effect is added to the game' : 'not uploaded (upload: false): the place uses the stand-in';
      if (args.upload !== false && !caller.drafts) {
        uploadNote = await uploadTexture(p, name, signal);
        entry = lib.get(name) ?? entry;
      }
      // Effects using it pick up the new id on their next build.
      const users = new EffectStore(p.root).all().filter((f) => textureRefs(f.effect).includes(name)).map((f) => f.effect.name);
      if (users.length && entry.imageId) await build(p, new EffectStore(p.root), caller, signal, { wait: false });
      new AssetService(p.store).record({
        name,
        kind: 'texture',
        source: `shuriken:vfx_texture by ${caller.role ?? caller.kind}`,
        robloxAssetId: entry.imageId ?? null,
        path: rel,
        metadata: { textureKind: args.kind, params: args.params ?? {}, grid: made.grid, decalId: entry.decalId ?? null },
        tags: ['vfx', 'texture', args.kind],
        event: 'generated',
        actor: caller.role ?? caller.kind,
        taskId: caller.taskId,
        runId: caller.runId,
        summary: made.line,
      });
      changed();
      const flipbook = made.grid > 1 ? { layout: `Grid${made.grid}x${made.grid}`, frames: made.grid * made.grid } : null;
      const out: ToolOutput = jsonOutput({
        name,
        texture: `tex:${name}`,
        file: rel,
        size: [made.width, made.height],
        ...(flipbook ? { flipbook } : {}),
        analysis: made.line,
        problems: made.problems,
        ...(unknown.length ? { ignoredParams: unknown, params: info.params } : {}),
        upload: uploadNote,
        usedBy: users,
        standIn: entry.imageId ? null : made.fallback || 'none',
      });
      out.content.push({ type: 'image', data: made.preview.toString('base64'), mimeType: 'image/png' });
      return out;
    },
  });

  reg.register({
    name: 'vfx_cutscene',
    title: 'Cutscenes',
    description:
      'Save a cutscene as data (effects/cutscenes/<name>.cutscene.json) and build it into the place for ShurikenCutscene.play(name): {name, letterbox? (0.11), skippable?, hideUi?, blockInput?, shots: [{at, duration, camera: {points: [[x,y,z]…] world positions, kind: catmullRom|bezier (4 points)|linear, ease}, lookAt: [x,y,z] | {points} | "player" | "Workspace.Path.To.Part", fov: curve (degrees), roll: curve, drift: studs}], events: [{at, effect+where | sound | animation+rig | line+speaker | title+subtitle | fade in|out | shake | signal (+always: fires even when skipped), seconds}]}. The result has its length, camera speed per shot and camera frames (camera + look_at for roblox_screenshot) at each shot\'s start, middle and end. action "frames" gives frames at your times; "remove" deletes one; "list".',
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    input: {
      action: z.enum(['save', 'frames', 'remove', 'list']).optional(),
      name: z.string().optional(),
      cutscene: z.record(z.string(), z.unknown()).optional(),
      times: z.array(z.number()).max(40).optional(),
    },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const store = new CutsceneStore(p.root);
      const action = args.action ?? (args.cutscene ? 'save' : args.name ? 'frames' : 'list');
      if (action === 'list') return jsonOutput({ cutscenes: store.names().map((n) => ({ name: n, length: (() => { const c = store.get(n)?.cutscene; return c ? cutsceneLength(c) : null; })() })) });
      if (action === 'remove') {
        if (!args.name || !store.remove(args.name)) return errorOutput(`No cutscene named ${args.name ?? '?'}`);
        await build(p, new EffectStore(p.root), caller, signal, { wait: false });
        changed();
        return jsonOutput({ removed: args.name, remaining: store.names() });
      }
      let cutscene: CutsceneSpec | null = null;
      if (action === 'save') {
        if (!args.cutscene) return errorOutput('Pass the cutscene to save.');
        cutscene = { ...(args.cutscene as unknown as CutsceneSpec), ...(args.name ? { name: args.name } : {}) };
        const problems = validateCutscene(cutscene);
        if (problems.length) return errorOutput(`The cutscene can't be used:\n- ${problems.join('\n- ')}`);
        const missing = (cutscene.events ?? []).filter((e) => e.effect && !new EffectStore(p.root).get(e.effect)).map((e) => e.effect!);
        store.save(cutscene, caller.role ?? caller.kind);
        const b = await build(p, new EffectStore(p.root), caller, signal, { wait: false });
        changed();
        const frames = sampleCutscene(cutscene, cutscene.shots.flatMap((s) => [(s.at ?? 0) + 0.01, (s.at ?? 0) + s.duration / 2, (s.at ?? 0) + s.duration - 0.01]));
        return jsonOutput({
          name: cutscene.name,
          length: cutsceneLength(cutscene),
          shots: shotSpeeds(cutscene),
          frames,
          ...(missing.length ? { missingEffects: [...new Set(missing)] } : {}),
          usage: `local Cutscene = require(${b.runtime.shared}.ShurikenCutscene)\nCutscene.play("${cutscene.name}") -- client; on the server: Cutscene.play("${cutscene.name}", { players = { player } })`,
          ...('note' in b && b.note ? { note: b.note } : {}),
          hint: 'Look at each frame: roblox_screenshot {camera, look_at} from the frames (FOV and roll show only in play).',
        });
      }
      cutscene = args.name ? (store.get(args.name)?.cutscene ?? null) : null;
      if (!cutscene) return errorOutput(`No cutscene named ${args.name ?? '?'} (existing: ${store.names().join(', ') || 'none'})`);
      const length = cutsceneLength(cutscene);
      const times = args.times?.length ? args.times : Array.from({ length: 9 }, (_, i) => (length * i) / 8);
      return jsonOutput({ name: cutscene.name, length, frames: sampleCutscene(cutscene, times) });
    },
  });

  reg.register({
    name: 'vfx_use',
    title: 'Add a draft effect to the game',
    description:
      'Adds a draft (an effect made in the Effects dock to try out) to the game: uploads the textures it uses that are not uploaded yet (when an Open Cloud key allows), builds it into ReplicatedStorage.ShurikenEffects and keeps the runtime modules in the synced code, so game code can play it with the ShurikenEffects module. as: put it in under another name, replacing that effect (a better take of "HitSpark" made as the draft "HitSpark2"). Only when the user asked for it in their game.',
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    input: { name: z.string(), as: z.string().optional().describe('The game effect it replaces (default: its own name).') },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const store = new EffectStore(p.root);
      const f = store.get(args.name);
      if (!f) return errorOutput(`No effect named ${args.name}. Existing: ${store.names().join(', ') || 'none'}`);
      const target = args.as?.trim() || f.effect.name;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(target)) return errorOutput('as: letters, digits and _ (start with a letter, at most 48).');
      if (!f.draft && target === f.effect.name) return jsonOutput({ name: f.effect.name, note: 'It is in the game already.' });
      // Its own textures go up first, so the game shows what the preview showed.
      const lib = new TextureLibrary(p.root);
      const uploads: Record<string, string> = {};
      for (const n of textureRefs(f.effect)) if (lib.get(n) && !lib.get(n)!.imageId) uploads[n] = await uploadTexture(p, n, signal);
      const used = store.use(args.name, target)!;
      const asset = record(p, used, caller);
      changed(target);
      const b = await build(p, store, caller, signal);
      const failed = b.failed.find((x) => x.name === target);
      const tex = textureNotes(p, used.effect);
      const body = {
        name: target,
        ...(target !== args.name ? { replaced: target, was: args.name } : {}),
        kind: used.effect.kind,
        built: b.built.includes(target),
        asset,
        runtime: b.runtime,
        usage: `local Effects = require(${b.runtime.requirePath})\nEffects.play("${target}", cframe)`,
        ...(Object.keys(uploads).length ? { textures: uploads } : {}),
        ...(tex.standIns.length ? { standInTextures: tex.standIns } : {}),
        ...('note' in b && b.note ? { note: b.note } : {}),
        ...(failed ? { error: failed.error } : {}),
      };
      return failed ? { ...jsonOutput(body, 'Build failed'), isError: true } : jsonOutput(body);
    },
  });

  reg.register({
    name: 'vfx_build',
    title: 'Build all effects',
    description: `Rebuild every effect, uploaded texture and cutscene into Studio (${FX_BUILDER_REL}) and refresh the runtime modules and client script.`,
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: {},
    handler: async ({ caller, signal }) => {
      const p = proj();
      const store = new EffectStore(p.root);
      const b = await build(p, store, caller, signal);
      const broken = store.broken();
      changed();
      return b.failed.length || broken.length ? { ...jsonOutput({ ...b, broken }, 'Some effects did not build'), isError: true } : jsonOutput({ ...b, broken });
    },
  });

  reg.register({
    name: 'vfx_runtime',
    title: 'Put the effects runtime in the game',
    description:
      'Write the effects runtime into the game\'s shared code and sync it, for code that uses it without making effects: ShurikenEffects (effects, projectiles, lightning, telegraphs, flashes, shake, hit-stop), ShurikenCurves (lerp/slerp, easing, Bezier and Catmull-Rom paths at even speed, arcs, spirals, lobs, homing, noise), ShurikenScreenFX (damage numbers, hit markers, flashes, vignette, speed lines, banners, combo; through Motion), ShurikenCutscene (cutscenes and intros), ShurikenWeather (rain, snow, fog, fireflies, leaves, light shafts, waterfalls, wind) and Motion. Returns the require paths and each module\'s API. Skill roblox-vfx shows how to use them.',
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    input: {},
    handler: async ({ caller, signal }) => {
      const p = proj();
      const store = new EffectStore(p.root);
      const b = await build(p, store, caller, signal);
      return jsonOutput({ runtime: b.runtime, motion: 'motion' in b.runtime ? b.runtime.motion : undefined, requires: Object.fromEntries(Object.keys(RUNTIME_API).map((m) => [m, `require(${b.runtime.shared}.${m})`])), api: RUNTIME_API, ...('note' in b && b.note ? { note: b.note } : {}) });
    },
  });

  reg.register({
    name: 'vfx_list',
    title: 'List effects',
    description: "The game's effects (effects/*.fx.json) with kind, what plays them and a one-line measure; its textures and cutscenes; broken files with why. Pass name for one full spec.",
    capability: 'roblox.app.vfx',
    permission: 'read',
    input: { name: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const store = new EffectStore(p.root);
      if (args.name) {
        const f = store.get(args.name);
        return f ? jsonOutput({ ...f, measure: measureEffect(f.effect).line }) : errorOutput(`No effect named ${args.name}. Existing: ${store.names().join(', ') || 'none'}`);
      }
      const usage = store.usage(p.extras().syncMap);
      return jsonOutput({
        effects: store.all().map((f) => ({ name: f.effect.name, ...(f.draft ? { draft: true, ...(f.draftOf ? { draftOf: f.draftOf } : {}) } : {}), ...(f.variantOf ? { variantOf: f.variantOf.base } : {}), kind: f.effect.kind, preset: f.preset ?? null, description: f.effect.description ?? '', measure: measureEffect(f.effect).line, playedBy: usage.get(f.effect.name) ?? [], updatedAt: f.updatedAt })),
        textures: new TextureLibrary(p.root).all().map((t) => ({ name: t.name, kind: t.kind, grid: t.grid ?? 1, uploaded: !!t.imageId, analysis: t.analysis })),
        cutscenes: new CutsceneStore(p.root).names(),
        broken: store.broken(),
        // Whether the open place has every effect as it is now (saving one while Studio is in a playtest leaves the build for later).
        studio: store.builtInStudio() ? 'built' : 'not built since the last change: run vfx_build before playing effects in Studio',
        runtime: EffectStore.runtimeLocation(p.extras().syncMap),
      });
    },
  });

  reg.register({
    name: 'vfx_play',
    title: 'Play an effect in Studio',
    description: 'Play a built effect at a position in the Edit viewport through the game\'s own ShurikenEffects runtime (timelines, shells, beams and all; persistent effects for `seconds`), measure what ran (effects, particles alive, parts, lights at 0.05, 0.25 and 0.6 s), then take a roblox_screenshot with the camera and look_at it suggests. target: an instance path for highlight and hit-stop tracks. Nothing is left behind.',
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: { name: z.string(), position: z.tuple([z.number(), z.number(), z.number()]), seconds: z.number().optional(), target: z.string().optional() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      if (new EffectStore(p.root).get(args.name)?.draft) return errorOutput(`${args.name} is a draft: it plays in Shuriken's preview, and Studio doesn't have it until it is added to the game (vfx_use, when the user says so).`);
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      // Effects saved while Studio was in a playtest are built now, so what plays is what was saved.
      const store = new EffectStore(p.root);
      if (!store.builtInStudio()) await build(p, store, caller, signal);
      const loc = EffectStore.runtimeLocation(p.extras().syncMap);
      const r = await d.studio.runLuau(playLuau(args.name, args.position, Math.min(20, Math.max(1, args.seconds ?? 4)), loc.shared, args.target ?? null), 'Edit', 30_000, signal);
      if (!r.ok) return errorOutput(r.output.slice(0, 800));
      let out: { result: string; runtime?: boolean; samples?: unknown[] };
      try {
        out = JSON.parse(r.output) as typeof out;
      } catch {
        out = { result: r.output.trim() };
      }
      if (out.result === 'missing') return errorOutput(`${args.name} is not built in this place; run vfx_create or vfx_build first.`);
      const f = new EffectStore(p.root).get(args.name);
      const m = f ? measureEffect(f.effect) : null;
      const reach = m ? Math.max(4, m.bounds.radius) : 8;
      const center = m ? [args.position[0] + m.bounds.center[0], args.position[1] + m.bounds.center[1], args.position[2] + m.bounds.center[2]] : args.position;
      const camera = [center[0]! + reach * 1.6, center[1]! + reach * 0.9, center[2]! + reach * 1.9].map((v) => Math.round(v * 10) / 10);
      return jsonOutput({
        ...out,
        ...(out.runtime === false ? { note: 'The ShurikenEffects module is not in Studio (sync it: vfx_build), so only the template\'s particles played.' } : {}),
        screenshot: { camera, look_at: center.map((v) => Math.round(v * 10) / 10) },
        hint: m ? `Screenshot now; the impact is at ${m.timing.impactAt ?? 0} s and it settles by ${m.timing.settleAt} s.` : 'Screenshot now.',
      });
    },
  });

  reg.register({
    name: 'vfx_remove',
    title: 'Remove an effect',
    description: 'Delete an effect (its spec file), or a texture (kind: "texture") or cutscene (kind: "cutscene"), and rebuild so it disappears from ReplicatedStorage.ShurikenEffects.',
    capability: 'roblox.app.vfx',
    permission: 'roblox_write',
    input: { name: z.string(), kind: z.enum(['effect', 'texture', 'cutscene']).optional() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const store = new EffectStore(p.root);
      const kind = args.kind ?? 'effect';
      if (caller.drafts) {
        const inGame = kind === 'effect' ? !!store.get(args.name) && !store.get(args.name)!.draft : kind === 'cutscene' || store.inGame().some((f) => textureRefs(f.effect).includes(args.name));
        if (inGame) return errorOutput(`${args.name} is in the game: removing it changes the game, which this turn can't. It goes when the user says so ("remove ${args.name} from the game").`);
      }
      const ok = kind === 'texture' ? new TextureLibrary(p.root).remove(args.name) : kind === 'cutscene' ? new CutsceneStore(p.root).remove(args.name) : store.remove(args.name);
      if (!ok) return errorOutput(`No ${kind} named ${args.name}`);
      changed(args.name);
      const b = await build(p, store, caller, signal, { wait: false });
      return jsonOutput({ removed: args.name, kind, remaining: kind === 'effect' ? store.names() : undefined, studio: 'note' in b ? b.note : 'rebuilt' });
    },
  });
}
