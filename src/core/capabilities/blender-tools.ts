import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { ExecResult, ModelingBackend, SceneIssues, SceneSummary } from '../modeling/backend';
import type { EventBus } from '../events';
import { errorOutput, textOutput, type CallerContext, type ToolRegistry } from './tool-registry';
import { roleLabel } from '../agents/roles';
import { PLAYER_STUDS } from '../modeling/model-store';
import { formatFaces } from '../modeling/part-traits';

export interface BlenderToolDeps {
  project: () => ProjectContext | null;
  modeling: ModelingBackend;
  bus: EventBus;
  /** Whether a model lives in a Kiln project that Kiln (0.7.3) owns and Shuriken's own Blender must not change: its changes are asked of Kiln. */
  ownedByKiln?: (root: string, model: string) => boolean;
  /** Kiln first: why an agent may not hand-model this new model now (Kiln builds it), or null when Blender may take it (the fallback). */
  kilnFirst?: (root: string, model: string) => string | null;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
/** Roblox's triangle limit for one MeshPart. */
const MAX_TRIS = 20_000;
/** The export cuts parts wider than this (Roblox's limit is 2,048 studs on a side). */
const MAX_PART_STUDS = 2_000;
const VIEWS = ['iso', 'iso_back', 'hero', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;
const fmt = (n: number) => n.toLocaleString('en-US');

/** Plain-language findings of the automatic surface check. */
export function formatIssues(i: SceneIssues | null, heading = 'Check'): string {
  if (!i) return '';
  const parts: string[] = [];
  if (i.zfight_pairs) parts.push(`${i.zfight_pairs} pair(s) of coincident surfaces that will flicker (z-fighting): ${i.zfight.slice(0, 6).map((z) => `${z.a} / ${z.b}`).join(', ')}`);
  if (i.floating.length) parts.push(`not touching anything and above the floor: ${i.floating.map((f) => `${f.object} (${f.gap_below} studs up)`).join(', ')}`);
  if (i.below_ground.length) parts.push(`below the floor (z < 0): ${i.below_ground.map((b) => `${b.object} (${b.lowest_z})`).join(', ')}`);
  if (i.moved?.length) parts.push(`nudged apart: ${i.moved.map((m) => `${m.object} ${m.by_studs} studs`).join(', ')}`);
  if (!parts.length) return `${heading}: no clashing surfaces or floating parts.`;
  return `${heading}: ${parts.join('; ')}.${i.zfight_pairs && !i.moved?.length ? ' Fix by leaving a small gap (or blender_check with fix: true).' : ''}${i.floating.length ? ' Ignore parts that are meant to hover.' : ''}`;
}

function totals(s: SceneSummary | null): string {
  if (!s) return '';
  const b = s.bounds ? `, ${s.bounds.size.map((v) => v.toFixed(2)).join(' × ')} studs (X × Y × Z up)` : '';
  return `Scene: ${s.objects} objects, ${fmt(s.tris)} triangles${b}.`;
}

function formatExec(name: string, r: ExecResult): string {
  const lines = [r.ok ? `Ran in ${r.ms} ms.` : 'Failed.', r.changed ? `${name} changed: version ${r.version}, saved, and shown on the Models page.` : 'No change to the model.'];
  if (r.output.trim()) lines.push(`Output:\n${r.output.trimEnd()}`);
  if (r.error) lines.push(`Error:\n${r.error}`);
  if (r.added.length) lines.push(`Added: ${r.added.slice(0, 25).join(', ')}${r.added.length > 25 ? ` (+${r.added.length - 25} more)` : ''}`);
  if (r.removed.length) lines.push(`Removed: ${r.removed.slice(0, 25).join(', ')}`);
  lines.push(totals(r.summary));
  if (r.changed && r.parts.length) {
    lines.push(`In Roblox: ${r.parts.length === 1 ? 'one MeshPart' : `${r.parts.length} MeshParts (one per material)`}: ${r.parts.map((p) => `${p.name} (${p.material} ${p.color}${p.transparency ? `, ${p.transparency} transparent` : ''}, ${fmt(p.triangles)} tris${p.instances?.length ? ` × ${fmt(p.instances.length)} placed` : ''}${p.role ? `, ${p.role}${p.roleInferred ? ' (guessed from its name)' : ''}` : ''})`).join('; ')}.`);
    if (r.size) {
      const longest = Math.max(...r.size);
      lines.push(`Whole model ${r.size.map((v) => v.toFixed(1)).join(' × ')} studs (X × Y up × Z); its longest side is ${(longest / PLAYER_STUDS).toFixed(longest < PLAYER_STUDS ? 2 : 1)}× a player's height.`);
    }
    const heavy = r.parts.filter((p) => p.triangles > MAX_TRIS);
    const cut = r.parts.filter((p) => p.piece && p.piece[0] === 1);
    const total = r.parts.reduce((t, p) => t + p.triangles * Math.max(1, p.instances?.length ?? 1), 0);
    if (heavy.length) lines.push(`Too many triangles for one Roblox MeshPart (${fmt(MAX_TRIS)} max): ${heavy.map((p) => `${p.name} ${fmt(p.triangles)}`).join(', ')}. Lower the bevel/subdivision levels or use a Decimate modifier.`);
    else if (cut.length) {
      const tiled = r.parts.some((p) => p.tile);
      lines.push(`Cut into MeshParts of at most 10,000 triangles${tiled ? ` and at most ${fmt(MAX_PART_STUDS)} studs on a side (a Roblox part is at most 2,048 studs wide: the wide ones are tiles of a grid, cut where the triangles cross a tile's edge, UVs and maps kept)` : ''} (Roblox's limit per part is ${fmt(MAX_TRIS)}): ${cut.map((p) => `${p.blender_material ?? 'base'} in ${p.piece![1]}`).join(', ')}. It looks the same; ${fmt(total)} triangles in all${total > 30_000 ? ' is heavy for a game: lower it unless this is a centrepiece' : ''}.`);
    }
    else if (r.parts.some((p) => p.triangles > 8000)) lines.push('Heavy for a game prop (over 8,000 triangles in a part): aim lower unless it is a hero piece.');
  }
  // What the export to Roblox leaves out or approximates (told once, when it first applies to the model).
  if (r.notes?.length) lines.push(`Export notes (what Roblox can't show of this model): ${r.notes.slice(0, 8).join('; ')}${r.notes.length > 8 ? ` (+${r.notes.length - 8} more)` : ''}.`);
  const issues = r.issues && (r.issues.zfight_pairs || r.issues.floating.length || r.issues.below_ground.length) ? formatIssues(r.issues, 'Automatic check') : '';
  if (issues) lines.push(issues);
  return lines.filter(Boolean).join('\n');
}

/**
 * The Blender modeling workshop for agents (Kiln's tools, in Shuriken): each model is a scene in its
 * own headless Blender, built up with Python calls; every change is saved as an undoable version and
 * exported to Roblox MeshParts (one per material) that the Models page, model_view, model_place and
 * uploads use. Several models can be worked on at once.
 */
export function registerBlenderTools(reg: ToolRegistry, d: BlenderToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const avail = () => {
    const s = d.modeling.status();
    return s.ready ? { ok: true } : { ok: false, reason: s.detail };
  };
  const workspace = (name: string, caller: CallerContext) => {
    if (!NAME.test(name)) throw new Error('model must be letters, digits and _ (start with a letter), e.g. EnderChest');
    return d.modeling.workspace(proj().root, name, { runId: caller.runId, role: caller.role ? roleLabel(caller.role) : caller.kind });
  };
  const guard = async <T,>(fn: () => Promise<T>): Promise<T | ReturnType<typeof errorOutput>> => {
    try {
      return await fn();
    } catch (e) {
      return errorOutput((e as Error).message);
    }
  };

  reg.register({
    name: 'blender_python',
    title: 'Model in Blender',
    description:
      "Run Python in the model's own headless Blender scene (bpy, bmesh, mathutils, math, np and the kiln helpers are preloaded; variables persist between calls). The first call creates the model. Units are STUDS, Z is up, the floor is z = 0, and the model's front faces -Y (Blender's Front view). Returns printed output, errors with the failing line, objects added/removed, scene totals, the Roblox MeshParts it exports to (one per material: colour, Roblox material, triangles), its size against a Roblox character, and an automatic check for flickering coincident surfaces and floating parts. Collision: an object's custom property kiln_role (drivable | ground | barrier | decor | collider; a collider also kiln_collides_for = the object it stands in for) sets how its part collides in Roblox: road and floor surfaces are precise, leaves and tufts collide with nothing; without it the role is guessed from names (road, asphalt, rail, wall, leaves, tuft…). Every change is saved as an undoable version and appears on the Models page.",
    capability: 'app.modeling',
    permission: 'write_project',
    available: avail,
    input: {
      model: z.string().describe('The model (one asset): letters, digits and _, e.g. EnderChest. Other agents can work on other models at the same time.'),
      code: z.string().min(1).describe('Python source to run'),
      step: z.string().max(90).optional().describe('A few words shown to the user for this step, e.g. "Block out the chest body"'),
      timeout_s: z.number().min(5).max(600).optional().describe('Seconds before Blender is restarted from the last saved version (default 120)'),
    },
    handler: ({ args, caller }) =>
      guard(async () => {
        if (d.ownedByKiln?.(proj().root, args.model))
          return errorOutput(`${args.model} is a Kiln project (Kiln owns it, and a change made here would be overwritten by Kiln's next result). Ask Kiln for the change with kiln_request {model: "${args.model}", kind: "rework" or "fix", text: what it must achieve} (for a fix, attach Studio screenshots of the asset in place in images, and say in one sentence what is wrong). blender_scene, model_view and kiln_clips read it.`);
        // Agents ask Kiln for new models; the user's own panel and tests model here as before.
        const kilnsJob = caller.kind === 'agent' && NAME.test(args.model) ? d.kilnFirst?.(proj().root, args.model) : null;
        if (kilnsJob) return errorOutput(kilnsJob);
        const ws = workspace(args.model, caller);
        d.bus.emit('models.building', { name: args.model, state: 'building', by: ws.by ?? undefined });
        const r = await ws.exec(args.code, (args.timeout_s ?? 120) * 1000, args.step);
        d.bus.emit('models.building', { name: args.model, state: r.ok ? 'done' : 'failed', by: ws.by ?? undefined });
        return { ...textOutput(formatExec(args.model, r)), isError: !r.ok };
      }),
  });

  reg.register({
    name: 'blender_scene',
    title: 'Describe a Blender model',
    description: "Every object in the model's scene with location, dimensions, rotation, triangles, materials, modifiers, parent and collection; all materials (colour, metallic, roughness, emission); overall bounds (studs); and the Roblox MeshParts it exports to.",
    capability: 'app.modeling',
    permission: 'read',
    available: avail,
    input: { model: z.string(), limit: z.number().int().min(1).max(300).optional() },
    annotations: { readOnlyHint: true },
    handler: ({ args, caller }) =>
      guard(async () => {
        const ws = workspace(args.model, caller);
        const r = await ws.scene(args.limit ?? 300);
        if (!r.ok) return errorOutput(`Could not read ${args.model}: ${r.error}`);
        const s = r.summary as SceneSummary;
        return textOutput(`${totals(s)}\n${JSON.stringify({ ...s, roblox_parts: ws.parts.map((p) => ({ name: p.name, material: p.material, color: p.color, triangles: p.triangles })) })}`);
      }),
  });

  reg.register({
    name: 'blender_render',
    title: 'Look at a Blender model',
    description:
      "Render the model (or only the objects named in focus), framed automatically, and look at the image. Several views or animation frames come back as one contact sheet (cheaper than separate renders); by default the first view has a default Roblox character (5.2 studs) beside the model for scale. quality 'fast' = solid shading with material colours (about a second); 'pretty' = Eevee with lights and a floor (10–30 s), for materials and glow. Use it at milestones: after the blockout, after the main forms, before finishing.",
    capability: 'app.modeling',
    permission: 'read',
    available: avail,
    input: {
      model: z.string(),
      views: z.array(z.enum(VIEWS)).min(1).max(6).optional().describe('Default ["iso", "front", "right", "top"]. iso/iso_back = 3/4 from above, hero = low 3/4, front = the side players face'),
      quality: z.enum(['fast', 'pretty']).optional().describe('Default "fast"'),
      size: z.number().int().min(256).max(1400).optional().describe('Width of each view in pixels (default 768 for one view, 512 per view in a sheet)'),
      focus: z.array(z.string()).optional().describe('Object names to frame instead of the whole model'),
      frames: z.array(z.number().int()).max(6).optional().describe('Animation frames to render'),
      player: z.boolean().optional().describe('A Roblox character beside the model in the first view (default true)'),
    },
    annotations: { readOnlyHint: true },
    handler: ({ args, caller }) =>
      guard(async () => {
        const ws = workspace(args.model, caller);
        const views = args.views ?? ['iso', 'front', 'right', 'top'];
        const count = (args.frames?.length || 1) * views.length;
        const r = await ws.render({ views, quality: args.quality ?? 'fast', size: args.size ?? (count > 1 ? 512 : 768), focus: args.focus, frames: args.frames, player: args.player !== false && !args.focus?.length });
        if (!r.ok || !r.file) return errorOutput(`Render failed: ${r.error}`);
        const shown = r.views ?? views;
        const caption = shown.length > 1 ? `Views, left to right then top to bottom: ${shown.join(', ')}.` : `View: ${shown[0]}.`;
        return {
          content: [
            { type: 'image' as const, data: readFileSync(r.file).toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: `${caption}${args.player !== false && !args.focus?.length ? ' The blue-grey figure in the first view is a default Roblox character (5.2 studs).' : ''} Saved as evidence: ${r.file}` },
          ],
        };
      }),
  });

  reg.register({
    name: 'blender_check',
    title: 'Check a Blender model',
    description: 'Full check of the model: coincident surfaces between objects (they flicker in Roblox: z-fighting), parts floating with nothing under them, parts below the floor, and faces Roblox can\'t see (flat meshes whose faces point down; open or paper-thin meshes, which it draws double-sided). With fix: true, the smaller part of each clashing pair is nudged 0.002 studs along its surface normal (a new version). blender_python already runs a quick version after each change.',
    capability: 'app.modeling',
    permission: 'write_project',
    available: avail,
    input: { model: z.string(), fix: z.boolean().optional() },
    handler: ({ args, caller }) =>
      guard(async () => {
        const ws = workspace(args.model, caller);
        const r = await ws.check(!!args.fix);
        if (!r.ok) return errorOutput(`Check failed: ${r.error}`);
        // What the last export found about faces Roblox can't see (open sheets, flat meshes facing down).
        const faces = formatFaces(ws.parts);
        return textOutput(`${formatIssues(r as unknown as SceneIssues)}\nChecked ${fmt(Number(r.faces_checked ?? 0))} faces.${faces ? `\n${faces}` : ''}`);
      }),
  });

  reg.register({
    name: 'blender_undo',
    title: 'Undo a Blender change',
    description: 'Steps the model back one version (its scene and its Roblox parts).',
    capability: 'app.modeling',
    permission: 'write_project',
    available: avail,
    input: { model: z.string() },
    handler: ({ args, caller }) =>
      guard(async () => {
        const ws = workspace(args.model, caller);
        return (await ws.undo()) ? textOutput(`${args.model} is back at version ${ws.version}.`) : errorOutput(`${args.model} has no earlier version.`);
      }),
  });
}
