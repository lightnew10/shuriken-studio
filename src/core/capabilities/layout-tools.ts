import { join } from 'node:path';
import { z } from 'zod';
import { findBlender } from '../blender/bridge';
import type { EventBus } from '../events';
import type { KilnModeling } from '../modeling/kiln-modeling';
import { LayoutImporter, exportBakedBlend, linkedByProject, type LayoutImportDeps, type LayoutImportResult } from '../modeling/layout-import';
import type { ProjectContext } from '../projects/project-service';
import type { CodeSync } from '../roblox/code-sync';
import { DEFAULT_SYNC_MAP, type SyncMap } from '../roblox/luau-toolchain';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import { waitBudget } from '../roblox/upload-queue';
import { errorOutput, jsonOutput, type ToolRegistry } from './tool-registry';

/**
 * Whole maps from Kiln (docs/ARCHITECTURE.md, "Kiln maps"): one tool that brings a Kiln layout project (its own
 * geometry, the pieces it places, its markers and paths) into the game, for the roles that build the world.
 */

export interface LayoutToolDeps {
  project: () => ProjectContext | null;
  /** Kiln's client (null where Kiln can't be used). */
  kiln: () => KilnModeling | null;
  studio: RobloxStudioAdapter;
  sync: CodeSync;
  bus: EventBus;
  /** The parts' upload queue that model_place, rig_build and model_gear share. */
  uploader: LayoutImportDeps['uploader'];
  /** Shuriken's own Blender (the configured path, or none to look for it) and the folder of its bridge script. */
  blender: () => { path: string | null; resourcesDir: string | null };
  /** Tests: the exporter stand-in. */
  exportBlend?: LayoutImportDeps['exportBlend'];
}

/** The roles that bring maps in (the tool is hidden from the others). */
export const LAYOUT_ROLES = ['modeler', 'environment-artist', 'level-designer'];

/** Where a map's data module goes: the synced folder that maps into ReplicatedStorage (as the animations module does). */
export function mapDataLocation(syncMap: SyncMap | undefined, module: string): { file: string; requirePath: string } {
  const map = syncMap && Object.keys(syncMap).length ? syncMap : DEFAULT_SYNC_MAP;
  const entry = Object.entries(map).find(([, inst]) => inst === 'ReplicatedStorage' || inst.startsWith('ReplicatedStorage/')) ?? ['src/Shared', 'ReplicatedStorage/Shared'];
  const segs = entry[1].split('/').slice(1);
  return {
    file: `${entry[0].replace(/\/$/, '')}/ShurikenMaps/${module}.luau`,
    requirePath: ['game.ReplicatedStorage', ...segs.map((s) => (/^[A-Za-z_]\w*$/.test(s) ? s : `[${JSON.stringify(s)}]`)), 'ShurikenMaps', module].join('.').replace(/\.\[/g, '['),
  };
}

/** One line about how an import went, above its JSON. */
function headline(r: LayoutImportResult): string {
  if (r.check && !r.check.ready && !r.manifest) return `Not imported: Kiln's check lists ${r.check.blocking.length + r.check.look.length} problem(s) with ${r.map}.`;
  if (r.done) return `${r.map} is in Studio: ${r.studio?.units?.total ?? 0} placements (${r.studio?.units?.parts ?? 0} parts) from ${(r.studio?.templates?.made ?? 0) + (r.studio?.templates?.kept ?? 0)} meshes${r.studio?.units?.kept ? `; ${r.studio.units.kept} were already there` : ''}.`;
  return `${r.map ?? 'The map'}: not finished yet.`;
}

export function registerLayoutTools(reg: ToolRegistry, d: LayoutToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const available = () => {
    const k = d.kiln();
    if (!k || process.env.SHURIKEN_NO_KILN === '1') return { ok: false, reason: 'Kiln is not available in this setup' };
    return k.kiln.health.ok ? { ok: true } : { ok: false, reason: `Kiln isn't running (${k.kiln.health.detail}). The user can start it from the Kiln page (the flame in the top bar).` };
  };

  reg.register({
    name: 'kiln_layout_import',
    title: 'Bring a Kiln map into the game',
    description:
      "Brings a whole map built in Kiln into Studio in one call: a Kiln layout project (ground, road, one-off buildings) with the pieces it places (each piece is its own Kiln project: trees, houses, props placed tens or thousands of times), its markers and its paths. Give model (the map's model in this game, linked to its Kiln project) or kiln_project (its id from kiln_status; name sets the model and folder name). What it does: reads Kiln's own Roblox check (when Kiln lists problems the map is NOT imported and the problems come back: send them to Kiln with kiln_request kind \"fix\", or pass accept_problems: true to import it as it is; mirrored placements always block); exports each piece's project and the map's own geometry once (only what changed since the last import; a material left to a Roblox material becomes MeshPart.Material plus Color with no texture, other one-colour materials are colour only); uploads each unique mesh once (the same upload queue as model_place); then places everything in Studio in batches: Workspace.<Map>.Static (the map's own parts), Workspace.<Map>.Pieces.c_<x>_<z> (placements in 512-stud grid cells; a piece of several parts is one Model that streams in whole), Workspace.<Map>.Markers (invisible anchored parts named after the markers, tagged MapMarker and MapMarker_<role> — spawn, start_grid, checkpoint, camera… — whose LookVector is the way the marker faces), with one template per mesh in ServerStorage.ShurikenMapKit.<Map>. Collision follows the roles (drivable and ground precise, barrier box or hull, decor none) and Kiln's colliders (invisible collision for the visuals they stand for). The paths (a road's centre line: points in studs, width, closed, length) and the markers also become a data module game code requires (the result's data.require): Map.path(\"road_centerline\"), Map.markersOf(\"checkpoint\"). A big map takes more than one call: when the result says done: false, call it again with the same arguments and it goes on where it stopped (nothing is exported, uploaded or placed twice; a later import places only what is missing or changed and removes what the map no longer has). check_only: only Kiln's check and the map's numbers. temporary: place temporary meshes without uploading (to look at it; not saved with the place). refresh: export everything again. Never build the map's placements yourself with model_place or hand-written Luau.",
    capability: 'kiln.layout',
    permission: 'roblox_write',
    roles: LAYOUT_ROLES,
    available,
    input: {
      model: z.string().optional().describe("The map's model in this game (linked to its Kiln layout project, e.g. made with kiln_request)"),
      kiln_project: z.string().optional().describe('The Kiln project id of the layout (kiln_status lists them)'),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).optional().describe('With kiln_project: the model and Workspace folder name the map gets (default: its linked model, else its Kiln title)'),
      accept_problems: z.boolean().optional().describe("Import although Kiln's check lists problems with how the map will look in Roblox (say so in your result)"),
      check_only: z.boolean().optional().describe("Only Kiln's check and the map's numbers: nothing is exported, uploaded or placed"),
      temporary: z.boolean().optional().describe('Place temporary meshes instead of uploading (not saved with the place)'),
      refresh: z.boolean().optional().describe('Export every piece and the map again, even where nothing seems to have changed'),
    },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const km = d.kiln();
      if (!km) return errorOutput('Kiln is not available here.');
      await km.kiln.check().catch(() => undefined);
      const project = args.kiln_project ?? (args.model ? km.linkedProject(p.root, args.model) : null);
      if (!project) return errorOutput(args.model ? `${args.model} has no Kiln project (kiln_status lists the Kiln projects and this game's linked models): pass kiln_project.` : 'Give model (a model of this game linked to the Kiln layout) or kiln_project (its id from kiln_status).');
      const bl = d.blender();
      const exe = findBlender(bl.path);
      const script = bl.resourcesDir ? join(bl.resourcesDir, 'blender', 'bridge.py') : null;
      const importer = new LayoutImporter({
        kiln: km.kiln,
        gpu: km.gpu,
        exportBlend: d.exportBlend ?? ((blend, dir, name, prepare) => exportBakedBlend(exe, script, blend, dir, name, prepare)),
        uploader: d.uploader,
        studio: d.studio,
        bus: d.bus,
        linked: linkedByProject,
        dataLocation: (_root, module) => mapDataLocation(p.extras().syncMap, module),
        pushFile: async (root, file) => {
          const mode = p.extras().syncMode;
          if (mode === 'script-sync') return 'Studio Script Sync brings it in';
          if (mode === 'none') return `code sync is off: add ${file} to the place yourself`;
          if (!d.studio.connected) return 'written; it is pushed with the next code sync';
          const rep = await d.sync.push(root, p.extras().syncMap, { only: [file] });
          return rep.errors.length ? `not pushed: ${rep.errors.map((e) => e.error).join('; ').slice(0, 300)}` : rep.created.length || rep.updated.length ? 'pushed' : 'up to date';
        },
      });
      const r = await importer.run(p.root, {
        project,
        name: args.name ?? args.model,
        acceptProblems: args.accept_problems,
        checkOnly: args.check_only,
        temporary: args.temporary,
        refresh: args.refresh,
        // The call answers before its MCP client gives up; what is left is the next call's.
        budgetMs: waitBudget(caller.kind, !!progress) - 20_000,
        signal,
        progress: progress ? (message) => progress({ message }) : undefined,
      });
      if (!r.ok) return errorOutput(`${r.error ?? 'The import failed.'}${r.notes.length ? `\n${r.notes.join('\n')}` : ''}`);
      return jsonOutput(r, headline(r));
    },
  });
}
