import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { EventBus } from '../events';
import { errorOutput, jsonOutput, type CallerContext, type ToolRegistry } from './tool-registry';
import { GEOMETRY_MARKER, compileGeometry, expandGeometry, geometryFileStem, geometrySpecSchema, geometryTag } from '../geometry/geometry';
import { LUAU_GEOMETRY_READ } from '../roblox/luau-snippets';
import { AssetService, analysisSummary } from '../assets/asset-service';
import { AssetCapture } from '../assets/asset-capture';
import { listWorldBuilders, rebuildWorld } from '../roblox/world-builder';

export interface GeometryToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  bus: EventBus;
  /** Agent runs working right now besides `runId` (a full rebuild would re-run their builders mid-edit). */
  otherAgents?: (runId: string | null) => number;
}

/**
 * Structured geometry tools: models as data (geometry_apply) and existing models back to data
 * (geometry_read), so agents edit numbers in a spec instead of writing coordinates into Luau by hand.
 */
export function registerGeometryTools(reg: ToolRegistry, d: GeometryToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  /** Building needs Edit mode: wait out another agent's (short) playtest rather than failing at once. */
  const leaseBlocked = async (_caller: CallerContext, _signal?: AbortSignal) => {
    const w = await d.studio.waitForLease();
    return w.ok ? null : errorOutput(`${w.message} Building is unavailable until it ends: do file work meanwhile.`);
  };
  const capture = new AssetCapture(d.studio);

  reg.register({
    name: 'geometry_apply',
    title: 'Build structured geometry',
    description: `Build a primitive-based model from a structured spec instead of hand-writing coordinates in Luau.
The spec: {name, parent?, pivot?[x,y,z], yaw?, defaults?{material,color,...}, parts?[{name,size,pos,rot?,shape?,color?,material?,transparency?,anchored?,canCollide?,group?,attributes?,tags?}], generators?[...], csg?[{op:"subtract"|"union"|"intersect",target,with[],name?}], attributes?, tags?}.
Positions are relative to the pivot; rot is Orientation in degrees; group nests parts in sub-models ("Walls/North").
Generators (parametric, expanded to named parts <name>_<i>): array {part,count,start,step,rotStep?}; grid {part,countX,countZ,start,spacing[dx,dz]}; ring {part,count,center,radius,startAngle?,faceCenter?}; stairs {steps,width,rise,run,start,yaw?}; arch {span,thickness,depth,segments,center,pillarHeight?,yaw?}; wall {from[x,z],to[x,z],y,height,thickness,openings?[{at,width,height,bottom?}]}.
Shuriken validates the spec, writes world/<Name>.geometry.json (the source of truth) and a generated idempotent builder world/<Name>.luau, builds it in Studio (replacing a previous build of the same spec), registers it in the asset library and returns an analysis. Re-apply an edited spec to change the model; use geometry_read to turn an existing model into a spec.`,
    capability: 'roblox.app.geometry',
    permission: 'roblox_write',
    input: {
      spec: z.record(z.string(), z.unknown()).describe('The geometry spec (see description)'),
      build: z.boolean().optional().describe('Build in Studio (default true); false only validates and writes the files'),
      replace_existing: z.boolean().optional().describe('Allow replacing a same-named model that was not built from a spec'),
    },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      let g;
      try {
        g = expandGeometry(args.spec);
      } catch (e) {
        const msg = e instanceof z.ZodError ? e.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(spec)'}: ${i.message}`).join('\n') : (e as Error).message;
        return errorOutput(`Invalid geometry spec:\n${msg}`);
      }
      const stem = geometryFileStem(g.name);
      const dir = join(p.root, 'world');
      const specRel = `world/${stem}.geometry.json`;
      const builderRel = `world/${stem}.luau`;
      const builderPath = join(dir, `${stem}.luau`);
      if (existsSync(builderPath) && !readFileSync(builderPath, 'utf8').includes(GEOMETRY_MARKER) && !args.replace_existing) {
        return errorOutput(`${builderRel} exists and is a hand-written builder; choose another model name or pass replace_existing.`);
      }
      const code = compileGeometry(g, specRel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${stem}.geometry.json`), `${JSON.stringify(geometrySpecSchema.parse(args.spec), null, 2)}\n`, 'utf8');
      writeFileSync(builderPath, code.replace('__REPLACE__', 'false'), 'utf8');
      const summary = { name: g.name, parts: g.parts.length, csg: g.csg.length, hash: g.hash, files: [specRel, builderRel] };
      if (args.build === false) return jsonOutput({ ...summary, built: false });
      if (!d.studio.connected) return jsonOutput({ ...summary, built: false, note: 'Studio is not connected; run the builder later with roblox_run_luau.' });
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      const r = await d.studio.runLuau(code.replace('__REPLACE__', args.replace_existing ? 'true' : 'false'), 'Edit', 180_000);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      if (!r.ok) return errorOutput(`Build failed: ${r.output.slice(0, 2000)}`);
      let built: { path: string; parts: number; hash: string };
      try {
        built = JSON.parse(r.output) as typeof built;
      } catch {
        return errorOutput(`Build returned unexpected output: ${r.output.slice(0, 500)}`);
      }
      // Asset library: one record per geometry model; rebuilding is a new version.
      const svc = new AssetService(p.store);
      const actor = caller.role ?? caller.kind;
      const path = built.path.replace(/^game\./, '');
      let rec = svc.list(undefined, 'model').find((a) => a.metadata.geometrySpec === specRel) ?? null;
      if (rec) {
        svc.addEvent(rec.id, 'modified', actor, `rebuilt from ${specRel} (${g.hash})`, { hash: g.hash }, caller.taskId, caller.runId);
        rec = svc.bumpVersion(rec.id);
        svc.setInstancePaths(rec.id, [path]);
      } else {
        rec = svc.record({
          name: g.name,
          kind: 'model',
          source: `shuriken:geometry by ${actor}`,
          instancePaths: [path],
          usageTag: geometryTag(g.name),
          tags: ['geometry'],
          metadata: { geometrySpec: specRel, builder: builderRel, hash: g.hash },
          event: 'generated',
          actor,
          taskId: caller.taskId,
          runId: caller.runId,
          summary: `built from ${specRel}`,
        });
      }
      let analysis = null;
      try {
        analysis = await capture.analyze(path);
        svc.setAnalysis(rec.id, analysis, actor, caller.taskId, caller.runId);
      } catch (e) {
        svc.addEvent(rec.id, 'note', actor, `analysis unavailable: ${(e as Error).message}`.slice(0, 300), null, caller.taskId, caller.runId);
      }
      d.bus.emit('assets.changed', { id: rec.id });
      return jsonOutput({
        ...summary,
        built: true,
        path,
        partsInStudio: built.parts,
        asset: rec.id,
        analysis: analysis ? analysisSummary(analysis) : null,
        findings: analysis?.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity}: ${f.message}`) ?? [],
      });
    },
  });

  reg.register({
    name: 'world_rebuild',
    title: 'Rebuild the world from world/',
    description:
      'Run the world builder scripts under world/ in order (world/world.json {"order": [...]} pins the order; otherwise alphabetical) in the Edit DataModel, so the place matches the repository. Use after editing builders, to restore an unsaved place, or to verify that the map is reproducible. Pass files to run only some builders.',
    capability: 'roblox.app.geometry',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: { files: z.array(z.string()).optional().describe('Builder file names (e.g. "Arena.luau"); default all') },
    handler: async ({ args, caller, signal }) => {
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      const p = proj();
      const builders = listWorldBuilders(p.root).files;
      if (!builders.length) return errorOutput('There are no builder scripts under world/.');
      let files = args.files?.length ? args.files : undefined;
      let only = '';
      // While others build, a full rebuild would re-run their half-edited builders (and take minutes).
      if (!files && caller.kind === 'agent' && (d.otherAgents?.(caller.runId) ?? 0) > 0) {
        const byName = new Map(builders.map((f) => [f.toLowerCase(), f]));
        const task = caller.taskId ? p.tasks.get(caller.taskId) : null;
        const own = [...new Set((task?.files ?? []).map((f) => byName.get(f.replace(/\\/g, '/').replace(/^world\//i, '').toLowerCase())).filter((f): f is string => !!f))];
        if (!own.length) {
          return errorOutput('Other agents are building right now, so a full rebuild would also re-run their builders in the middle of their edits. Pass files: the builders you changed (e.g. ["Arena.luau"]).');
        }
        files = own;
        only = ` (only your task's builders, ${own.join(', ')}, because other agents are working; pass files to choose others)`;
      }
      const out = await rebuildWorld(d.studio, p.root, files, signal);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      const failed = out.results.filter((r) => !r.ok);
      const body = { ran: out.results.length, failed: failed.length, results: out.results, problems: out.problems, ...(out.doubles.length ? { doubles: out.doubles } : {}) };
      return failed.length
        ? { ...jsonOutput(body, `${failed.length} builder(s) failed${only}`), isError: true }
        : jsonOutput(body, [`World rebuilt from world/${only}`, ...out.doubles].join('\n'));
    },
  });

  reg.register({
    name: 'geometry_read',
    title: 'Read model as geometry spec',
    description:
      'Turn an existing model (or part) in Studio into a geometry spec: primitive parts with positions relative to the model pivot, sizes, orientation, colors, materials and groups. Items a spec cannot recreate (unions, meshes) are listed under "opaque". Edit the spec and apply it with geometry_apply (same name replaces a spec-built model; hand-built models need replace_existing).',
    capability: 'roblox.app.geometry',
    permission: 'roblox_read',
    available: () => d.studio.availability(),
    input: { path: z.string().describe('Instance path, e.g. Workspace.Map.Watchtower') },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const r = await d.studio.luauJson<Record<string, unknown> & { error?: string; parts?: unknown[]; opaque?: unknown[] }>(LUAU_GEOMETRY_READ.replace(/__PATH__/g, () => JSON.stringify(args.path)));
      if (r.error) return errorOutput(`${r.error}: ${args.path}`);
      const parts = Array.isArray(r.parts) ? r.parts : [];
      const opaque = Array.isArray(r.opaque) ? r.opaque : [];
      const attributes = r.attributes && typeof r.attributes === 'object' && !Array.isArray(r.attributes) ? r.attributes : {};
      const notes: string[] = [];
      if (opaque.length) notes.push(`${opaque.length} item(s) cannot be expressed as primitives (unions, meshes); applying this spec would drop them.`);
      if (parts.length > 2000) notes.push('More than 2000 parts: split the model before re-applying.');
      return jsonOutput({ spec: { name: r.name, parent: r.parent, pivot: r.pivot, yaw: r.yaw, attributes, parts }, opaque, builtFromSpec: r.builtFromSpec ?? null, notes });
    },
  });
}
