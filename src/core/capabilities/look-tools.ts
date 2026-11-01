import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { EventBus } from '../events';
import { analyzeLook, critiqueLook, decodeImage, type LookOptions } from '../look/look-analysis';
import { LIGHTING_MARKER, LIGHTING_PRESETS, PRESET_NAMES, lightingAdjustSchema, lightingBuilderLuau, mergeAdjust, resolveLighting, type LightingAdjust, type LightingPresetName } from '../look/lighting-presets';
import { errorOutput, jsonOutput, textOutput, type ToolRegistry } from './tool-registry';
import { imageStates, imagesInUseLuau, type ImageState } from '../roblox/image-status';

export interface LookToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  bus: EventBus;
  /** Agent runs working right now besides `runId`. */
  otherAgents?: (runId: string | null) => number;
  /** Asks Roblox where images are in its review (replaced in tests). */
  imageStates?: (ids: string[]) => Promise<Map<string, ImageState>>;
}

/** The roles that judge how the world and the screens look (the critic lists the tool in its own appTools too). */
export const LOOK_ROLES = ['environment-artist', 'level-designer', 'critic', 'ui-engineer', 'copilot-ui'];
/** The roles that light the world. */
export const LIGHTING_ROLES = ['environment-artist', 'level-designer'];

/**
 * Eyes without eyes: measurements of screenshots (core/look/look-analysis.ts) for the agents who judge looks,
 * when Studio isn't drawing for them or their own glance is all they have. It reports numbers and likely
 * problems, never a verdict on beauty.
 */
export function registerLookTools(reg: ToolRegistry, d: LookToolDeps): void {
  reg.register({
    name: 'texture_status',
    title: 'Are the textures approved?',
    description:
      'Says where the images that colour the place\'s parts are in Roblox\'s review: approved, pending or blocked. A textured part whose image Roblox has not approved yet renders FLAT GREY in Studio and in the game (minutes, sometimes an hour or more after an upload). Run this before you judge, or try to fix, anything that looks grey or untextured. path: where to look ("Workspace/Map", "ReplicatedStorage/MapPieces/Warehouse"); left out, the whole place. pending: nothing is wrong with the work and nothing is to be done: never re-upload, rebuild or ask Kiln again (a new upload only waits in line again); judge the look with model_view and say the textures are pending. blocked: Roblox removed the image: that area has to be repainted (kiln_request kind "fix").',
    capability: 'roblox.app.inspect',
    permission: 'roblox_read',
    available: () => d.studio.availability(),
    input: { path: z.string().max(300).optional().describe('An instance path in the place, e.g. "Workspace/Map/Warehouse"; default: Workspace, ReplicatedStorage and ServerStorage') },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ args, signal }) => {
      const r = await d.studio.runLuau(imagesInUseLuau((args.path ?? '').trim()), 'Edit', 60_000, signal);
      if (!r.ok) return errorOutput(`Could not read the place's images: ${r.output.slice(0, 300)}`);
      let used: Array<{ id: string; at: string }> | { error: string };
      try {
        used = JSON.parse(r.output) as typeof used;
      } catch {
        return errorOutput('Could not read the place\'s images (Studio answered something else).');
      }
      if (!Array.isArray(used)) return errorOutput(used.error);
      if (!used.length) return textOutput(`No textured parts${args.path ? ` under ${args.path}` : ''}: nothing waits for Roblox's review there.`);
      const states = await (d.imageStates ?? imageStates)(used.map((u) => u.id));
      const by = (s: ImageState) => used.filter((u) => (states.get(u.id) ?? 'unknown') === s);
      const list = (rows: typeof used) => rows.slice(0, 25).map((u) => `${u.at} (${u.id})`).join('; ') + (rows.length > 25 ? `; and ${rows.length - 25} more` : '');
      const pending = by('pending');
      const blocked = by('blocked');
      const unknown = by('unknown');
      const lines = [
        `${used.length} image(s) colour parts${args.path ? ` under ${args.path}` : ''}: ${by('approved').length} approved, ${pending.length} pending, ${blocked.length} blocked${unknown.length ? `, ${unknown.length} unknown (Roblox didn't say)` : ''}.`,
        ...(pending.length ? [`PENDING (Roblox is still reviewing them; these parts render flat grey until it approves. Not a defect of the work: don't re-upload, rebuild or ask Kiln again; judge the look with model_view): ${list(pending)}`] : []),
        ...(blocked.length ? [`BLOCKED (Roblox removed these images: the part stays grey; have that texture repainted with kiln_request kind "fix"): ${list(blocked)}`] : []),
      ];
      return jsonOutput({ images: used.length, approved: by('approved').length, pending: pending.map((u) => u.id), blocked: blocked.map((u) => u.id) }, lines.join('\n'));
    },
  });

  reg.register({
    name: 'look_analyze',
    title: 'Measure how a screenshot looks',
    description:
      "Measures screenshots the way an art director checks them and returns one compact line per picture plus the likely problems, each with what to change in Roblox terms: exposure (CIE L* median and 5-95% range, clipped highlights, crushed blacks), contrast and value grouping (are there distinct dark/mid/light masses), colour (chroma, how many hue families, the dominant one, the colour cast and temperature, a 5-colour palette), the horizon and depth (contrast far against near, the far band against the sky: haze), whether the play space separates from the background, clutter (edges) and fine texture noise, the visual weight's centre, and named regions against their surroundings (pass regions [{name, box: [x0, y0, x1, y1]}] in fractions of the frame, e.g. where a target stands, to check it reads). Pictures: evidence ids (from roblox_screenshot or task_get), a project file, or latest: the newest N screenshots of a task (default: your task's newest one). Say what the frame is (view: gameplay at camera height, overview, or ui) and the intended mood (night, dusk…) so a dark night or a warm sunset isn't called a problem. It measures; it does not judge beauty: the thresholds are conventions for readable game frames. Use it on every look pass, and when Studio isn't drawing, on the newest screenshots there are.",
    capability: 'app.tasks',
    permission: 'read',
    roles: LOOK_ROLES,
    input: {
      evidence: z.array(z.string()).max(6).optional().describe('Evidence ids of screenshots'),
      file: z.string().optional().describe('An image file in the project (JPEG or PNG), relative to the project folder'),
      latest: z.number().int().min(1).max(6).optional().describe("The newest N screenshots of the task (task_id, default your task); the default when nothing else is given is 1"),
      task_id: z.string().optional(),
      view: z.enum(['gameplay', 'overview', 'ui']).optional().describe('gameplay (default): a camera at play height; overview: looking down at an area; ui: a screen of UI'),
      mood: z.enum(['day', 'golden', 'dusk', 'night', 'interior', 'overcast', 'stylized']).optional().describe('The intended mood, so its normal darkness, warmth or haze is not a problem'),
      regions: z
        .array(z.object({ name: z.string().min(1).max(40), box: z.array(z.number().min(0).max(1)).length(4).describe('[x0, y0, x1, y1], fractions of the frame from the top left') }))
        .max(6)
        .optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller }) => {
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const pics: { title: string; path: string }[] = [];
      for (const id of args.evidence ?? []) {
        const row = p.store.get<{ task_id: string }>('SELECT task_id FROM task_evidence WHERE id = ?', [id]);
        const ev = row ? p.tasks.evidence(row.task_id).find((e) => e.id === id) : undefined;
        if (!ev) return errorOutput(`Unknown evidence ${id}`);
        if (!ev.path) return errorOutput(`Evidence ${id} (${ev.title}) has no picture`);
        pics.push({ title: `${ev.title} (${id})`, path: ev.path });
      }
      if (args.file) {
        const full = resolve(p.root, args.file);
        const rel = relative(p.root, full);
        if (rel.startsWith('..') || isAbsolute(rel)) return errorOutput(`${args.file} is outside the project folder`);
        pics.push({ title: rel.replace(/\\/g, '/'), path: full });
      }
      if (args.latest || !pics.length) {
        const taskId = args.task_id ?? caller.taskId;
        if (!taskId) return errorOutput('Nothing to measure: pass evidence ids, a file, or task_id with latest');
        const shots = p.tasks
          .evidence(taskId)
          .filter((e) => e.kind === 'screenshot' && e.path && existsSync(e.path))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, args.latest ?? 1);
        if (!shots.length) return errorOutput(`Task ${taskId} has no screenshots yet: take one with roblox_screenshot (or pass a file).`);
        for (const e of shots) pics.push({ title: `${e.title} (${e.id})`, path: e.path! });
      }
      const opts: LookOptions = { view: args.view, mood: args.mood, regions: args.regions?.map((r) => ({ name: r.name, box: r.box as [number, number, number, number] })) };
      const lines: string[] = [];
      const data: unknown[] = [];
      for (const pic of pics) {
        if (!existsSync(pic.path)) {
          lines.push(`${pic.title}: the file is missing`);
          continue;
        }
        try {
          const a = analyzeLook(decodeImage(readFileSync(pic.path)), opts);
          const c = critiqueLook(a, opts);
          lines.push(`${pic.title}\nseen: ${c.seen}\n${c.problems.length ? `likely problems:\n${c.problems.map((x) => `- ${x}`).join('\n')}` : 'likely problems: none in the numbers (still look at it)'}`);
          data.push({ title: pic.title, analysis: a, problems: c.problems });
        } catch (e) {
          lines.push(`${pic.title}: can't be read (${(e as Error).message})`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n\n') }], data };
    },
  });
  reg.register({
    name: 'lighting_set',
    title: 'Set the lighting from a preset',
    description: `Sets the game's lighting and atmosphere from a starting point adapted to the brief, as code on disk: it writes world/Lighting.json (the preset and your adjustments, the source of truth) and a generated idempotent builder world/Lighting.luau (world_rebuild re-runs it), then builds it in Studio. Presets: ${PRESET_NAMES.map((n) => `${n} (${LIGHTING_PRESETS[n].intent.split(':')[0]!.replace(/\.$/, '')})`).join('; ')}. list: true shows each preset's intent, what to adapt for which brief, its values, where they come from and what look_analyze should roughly measure. adjust changes any part on top of the preset: {lighting: {ClockTime, GeographicLatitude, Brightness, ExposureCompensation, Ambient, OutdoorAmbient, ColorShift_Top, ColorShift_Bottom (colours as [r,g,b] 0-255 or "#rrggbb"), EnvironmentDiffuseScale, EnvironmentSpecularScale, GlobalShadows, ShadowSoftness, LightingStyle ("Realistic" | "Soft"), PrioritizeLightingQuality}, atmosphere: {Density, Offset, Color, Decay, Glare, Haze}, sky: {SunAngularSize, MoonAngularSize, StarCount, CelestialBodiesShown, Skybox*}, clouds: {Cover, Density, Color}, bloom: {Intensity, Size, Threshold}, colorCorrection: {Brightness, Contrast, Saturation, TintColor}, sunRays: {Intensity, Spread}, depthOfField: {FarIntensity, FocusDistance, InFocusRadius, NearIntensity}}; a section set to false removes that piece. Without preset it refines the current one (earlier adjustments stay). The builder owns Lighting's properties, its Atmosphere and its post effects (one of each); an existing Sky keeps its skybox. Lighting.Technology can't be set from scripts: the place's own setting stays. A hand-written world/Lighting.luau is only replaced with replace_existing. Then look: roblox_screenshot at gameplay camera height and look_analyze with the preset's mood.`,
    capability: 'roblox.app.geometry',
    permission: 'roblox_write',
    roles: LIGHTING_ROLES,
    input: {
      preset: z.enum(PRESET_NAMES as [LightingPresetName, ...LightingPresetName[]]).optional(),
      adjust: z.record(z.string(), z.unknown()).optional().describe('Changes on top of the preset (see description)'),
      list: z.boolean().optional().describe('Show the presets and their targets; changes nothing'),
      build: z.boolean().optional().describe('Build in Studio now (default true)'),
      replace_existing: z.boolean().optional().describe('Replace a hand-written world/Lighting.luau'),
    },
    handler: async ({ args }) => {
      if (args.list) return jsonOutput(Object.fromEntries(PRESET_NAMES.map((n) => [n, LIGHTING_PRESETS[n]])), 'Lighting presets: starting points to adapt, with what look_analyze should roughly measure at gameplay height (targets, not laws).');
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const dir = join(p.root, 'world');
      const dataPath = join(dir, 'Lighting.json');
      const builderPath = join(dir, 'Lighting.luau');
      let stored: { preset?: LightingPresetName; adjust?: LightingAdjust } = {};
      if (existsSync(dataPath)) {
        try {
          stored = JSON.parse(readFileSync(dataPath, 'utf8')) as typeof stored;
        } catch {
          stored = {};
        }
      }
      const preset = args.preset ?? (stored.preset && stored.preset in LIGHTING_PRESETS ? stored.preset : undefined);
      if (!preset) return errorOutput(`Name a preset to start from: ${PRESET_NAMES.join(', ')} (list: true describes them).`);
      const given = lightingAdjustSchema.safeParse(args.adjust ?? {});
      if (!given.success) return errorOutput(`Invalid adjust: ${given.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(adjust)'}: ${i.message}`).join('; ')}`);
      const adjust = args.preset ? given.data : mergeAdjust(stored.adjust ?? {}, given.data);
      const look = resolveLighting(preset, adjust);
      if (existsSync(builderPath) && !readFileSync(builderPath, 'utf8').includes(LIGHTING_MARKER) && !args.replace_existing) {
        return errorOutput("world/Lighting.luau is a hand-written builder. Pass replace_existing: true to replace it with the preset (it then owns Lighting's properties, Atmosphere and post effects; an existing Sky keeps its skybox), or keep editing it by hand.");
      }
      const code = lightingBuilderLuau(look, preset);
      const info = LIGHTING_PRESETS[preset];
      mkdirSync(dir, { recursive: true });
      writeFileSync(dataPath, `${JSON.stringify({ preset, adjust, look, expect: info.expect, source: info.source }, null, 2)}\n`, 'utf8');
      writeFileSync(builderPath, code, 'utf8');
      const next = `Look next: roblox_screenshot at gameplay camera height (and one overview), then look_analyze {mood: "${info.expect.mood}"}. ${preset} should measure roughly median L* ${info.expect.medianL[0]}-${info.expect.medianL[1]}; ${info.expect.note}.`;
      const summary = { preset, adjust, files: ['world/Lighting.json', 'world/Lighting.luau'] };
      if (args.build === false) return jsonOutput({ ...summary, built: false }, next);
      if (!d.studio.connected) return jsonOutput({ ...summary, built: false, note: 'Studio is not connected: world_rebuild runs the builder later.' }, next);
      const w = await d.studio.waitForLease();
      if (!w.ok) return errorOutput(`${w.message} The files are written; run world_rebuild {files: ["Lighting.luau"]} when Studio is free.`);
      const r = await d.studio.runLuau(code, 'Edit', 60_000);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      if (!r.ok) return errorOutput(`The lighting builder failed in Studio: ${r.output.slice(0, 1500)}`);
      return textOutput(`${r.output}\n${next}`, { ...summary, built: true, output: r.output });
    },
  });
}
