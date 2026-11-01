import { surfaceLuau, stageTextures } from '../modeling/texture-staging';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { EventBus } from '../events';
import { resolveCreator, type OpenCloudAssets } from '../roblox/open-cloud-assets';
import { errorOutput, jsonOutput, type CallerContext, type ToolOutput, type ToolProgress, type ToolRegistry } from './tool-registry';
import { BLOOM_FN, MODELS_BUILDER_REL, ModelStore, PLACE_FN, SETTLE_FN, instancesTable, isNeon, temporaryInstancesLuau, temporaryMeshLuau, meshNormals, type ModelMeta, type ModelPlacement } from '../modeling/model-store';
import { ModelUploads, type PartUpload } from '../modeling/model-uploads';
import { formatFaces, fxTable, partFx } from '../modeling/part-traits';
import { waitBudget } from '../roblox/upload-queue';
import { RIGS_BUILDER_REL, rigsBuilder, stageMeshesLuau, writeRigsBuilder } from '../modeling/rig-builder';
import { GEAR_BUILDER_REL, GearStore, R15_ATTACHMENTS, blenderToRoblox, gearParts, writeGearBuilder, type GearSpec } from '../modeling/gear';
import { familyOfModel } from '../modeling/kiln-family';
import type { RigSpec, Vec3 } from '@shared/rig';
import { AssetService } from '../assets/asset-service';
import { AnimationStore } from '../animation/animation-service';
import { assembledSize } from '@shared/render';
import { reviewNote, type ImageState } from '../roblox/image-status';

export interface ModelToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  bus: EventBus;
  cloud: OpenCloudAssets;
  uploads: () => { enabled: boolean; creatorId: string | null };
  rememberCreator: (id: string) => void;
  /** A look at a texture before its upload (roblox/image-screen.ts); absent in tests. */
  screen?: (root: string, file: string) => Promise<string | null>;
  /** A removed model's Kiln project is thrown away too (KilnModeling.discard); absent without Kiln. Returns what happened. */
  discard?: (root: string, model: string) => Promise<string | null>;
  /** Asks Roblox where images are in its review (roblox/image-status.ts); absent in tests (no network). */
  imageStates?: (ids: string[]) => Promise<Map<string, ImageState>>;
  /** Draws a picture of a model or an assembly's parts (angles with a player for scale); absent where nothing can draw. */
  render?: (parts: Array<{ glb: Buffer; color?: string; material?: string; origin?: [number, number, number]; instances?: ModelMeta['instances'] }>, opts?: { name?: string }) => Promise<string | null>;
}


const parseSettle = (out: string): { path: string; position: [number, number, number]; rotation?: [number, number, number]; notes: string[] } | null => {
  try {
    const v = JSON.parse(out.trim()) as { path?: string; position?: [number, number, number]; rotation?: [number, number, number]; notes?: string[] };
    return v.path && v.position ? { path: v.path, position: v.position, rotation: v.rotation, notes: v.notes ?? [] } : null;
  } catch {
    return null;
  }
};
const MAX_TEMP_TRIS = 12_000;

/**
 * What became of a textured model's maps after its upload. Roblox's importer gets them inside the GLB;
 * whether it keeps them wasn't verifiable when this was written, so every permanent placement says.
 */
function uploadedMapsNote(kept: number, of: number): string {
  if (kept === of) return 'Roblox kept its texture maps in the upload (a SurfaceAppearance or texture on each textured part)';
  return `Roblox's upload kept the texture maps on ${kept} of ${of} textured part${of === 1 ? '' : 's'}; the others show their texture's average colour. Place it with temporary: true to see the maps in Studio, and tell the user the upload lost them.`;
}

/**
 * The 3D modeling workshop for agents (the models themselves are made in Blender: blender-tools.ts):
 * the Roblox meshes they export, previewed in the app (model_view), uploaded to Roblox (Open Cloud)
 * and placed in Studio — or placed as a temporary EditableMesh while uploading isn't possible.
 */
export function registerModelTools(reg: ToolRegistry, d: ModelToolDeps): { uploading: (root: string) => string[]; uploader: ModelUploads } {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  /** Neon was just placed: keep Lighting's Bloom from blinding (BLOOM in model-store); the note says what changed. */
  const tameBloom = async (neon: boolean, signal?: AbortSignal): Promise<{ bloom?: string }> => {
    if (!neon) return {};
    const r = await d.studio.runLuau(`${BLOOM_FN}\nreturn tameBloom()`, 'Edit', 30_000, signal).catch(() => null);
    const note = r?.ok ? r.output.trim() : '';
    return note ? { bloom: note } : {};
  };
  const leaseBlocked = async (_caller: CallerContext, _signal?: AbortSignal) => {
    const w = await d.studio.waitForLease();
    return w.ok ? null : errorOutput(`${w.message} Placing needs Edit mode. The model is saved; place it later.`);
  };
  const creator = () => resolveCreator(d.studio, d.uploads().creatorId, d.rememberCreator);

  /**
   * Parts' uploads to Roblox. They belong to the part, not to the run that asked: an upload that started
   * finishes and records its asset id (or the operation Roblox is still processing) even when the run
   * stops, and the next call finds it (see modeling/model-uploads.ts).
   */
  const uploader = new ModelUploads({
    cloud: d.cloud,
    uploads: () => d.uploads(),
    creator,
    ...(d.screen ? { screen: d.screen } : {}),
    uploaded: (meta, assetId) => {
      const p = d.project();
      if (p && meta.asset) new AssetService(p.store).update(meta.asset, { robloxAssetId: assetId });
    },
  });
  /**
   * Whether a part's upload is a legacy one (its record has no facing marker): Roblox's importer turned its
   * mesh 180° about its own centre, so the Luau Shuriken generates turns it back (see modeling/glb.ts).
   * Uploads made now are pre-turned, and temporary meshes were never affected.
   */
  const turnOf = (m: ModelMeta): boolean => ModelStore.legacyUpload(new ModelStore(proj().root).get(m.name) ?? m);

  /**
   * Every part's asset id for its current build: parts whose mesh and maps haven't changed since their
   * last upload are left alone, the rest upload up to six at a time, and uploads another call has under
   * way are joined. When the uploads outlast this call's budget the result is `wait`: a "still uploading,
   * call again" answer to return as it is (the uploads carry on; the next call joins them).
   */
  const uploadAll = async (
    p: ProjectContext,
    parts: ModelMeta[],
    tool: string,
    inv: { caller: CallerContext; signal: AbortSignal; progress?: ToolProgress },
  ): Promise<{ by: Map<string, PartUpload>; wait: ToolOutput | null }> => {
    const budgetMs = waitBudget(inv.caller.kind, !!inv.progress);
    const r = await uploader.ensureMany(p.root, parts, { budgetMs, signal: inv.signal, onProgress: (u) => inv.progress?.({ message: u.message }) });
    const by = new Map(r.results.map((x) => [x.name, x] as const));
    if (!r.stillUploading.length) return { by, wait: null };
    const shown = r.stillUploading.slice(0, 12).join(', ') + (r.stillUploading.length > 12 ? ', …' : '');
    return {
      by,
      wait: jsonOutput({
        uploading: true,
        stillUploading: r.stillUploading,
        uploaded: parts.length - r.stillUploading.length,
        parts: parts.length,
        note: `Not done yet: ${r.stillUploading.length} of ${parts.length} part(s) are still uploading to Roblox (${shown}; up to six at a time, and each upload carries on by itself). Call ${tool} again: it joins the uploads that are running (nothing is sent twice) and goes on when they are done.`,
      }),
    };
  };

  reg.register({
    name: 'model_place',
    title: 'Place a model in Studio',
    description: `Put a built model into the place as an anchored MeshPart: position, rotation (degrees), scale, color (hex) and material. A model with several parts (one per material, e.g. Chest_Wood + Chest_Gem) is placed whole by its name (Chest): one Roblox Model, parts in their arrangement, settled as a unit. Shuriken uploads the mesh to Roblox first (free; needs an Open Cloud key) so it becomes a permanent part of the game and ${MODELS_BUILDER_REL} can rebuild it; without an upload it places a temporary mesh (EditableMesh) good for checking the look — it is NOT saved with the place. Only parts whose mesh or maps changed upload, up to six at a time; when Roblox takes longer than a few minutes the call says "still uploading" (nothing is lost, the uploads carry on) and you call model_place again to join them.`,
    capability: 'app.modeling',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: {
      name: z.string(),
      instance_name: z.string().optional().describe('Name of the placed MeshPart (default: the model name)'),
      parent: z.string().optional().describe('Parent path (default Workspace)'),
      position: z.tuple([z.number(), z.number(), z.number()]),
      rotation: z.tuple([z.number(), z.number(), z.number()]).optional(),
      scale: z.number().min(0.05).max(50).optional(),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      material: z.string().optional().describe('Enum.Material name, e.g. Slate, Wood, Metal'),
      on_ground: z.boolean().optional().describe('Rest it on the surface under the position (default true); false keeps the exact position'),
      on_wall: z.boolean().optional().describe('Mount it on the wall behind it (its back is its Blender +Y side) or the nearest wall within 16 studs, facing out, at the given height — torches, signs, shelves'),
      temporary: z.boolean().optional().describe('Skip uploading and place a temporary mesh'),
    },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const store = new ModelStore(p.root);
      let meta = store.get(args.name);
      // A Blender model of several parts owns its name, even where an older build123d model had it.
      const whole = store.parts(args.name);
      if (whole.length && (!meta || meta.instances?.length || (meta.source !== 'blender' && whole.some((x) => x.source === 'blender')))) {
        // A whole Blender model (one part per material): one Roblox Model, parts in their arrangement.
        const parts = whole;
        const blocked = await leaseBlocked(caller, signal);
        if (blocked) return blocked;
        const inst = args.instance_name ?? args.name;
        const parentPath = args.parent ?? 'Workspace';
        const container = `${parentPath}.${inst}`;
        const scale = args.scale ?? 1;
        const rot = args.rotation ?? [0, 0, 0];
        const mode = args.on_wall ? '"wall"' : args.on_ground !== false ? 'true' : 'false';
        const look = (m: ModelMeta) => ({
          ...(args.color ? { color: args.color.startsWith('#') ? args.color : `#${args.color}` } : m.color ? { color: m.color } : {}),
          ...(args.material ? { material: args.material } : m.material ? { material: m.material } : {}),
        });
        // Every part uploaded, or none: a model is never half permanent.
        const ids = new Map<string, string>();
        const whys: string[] = [];
        if (!args.temporary) {
          const up = await uploadAll(p, parts, 'model_place', { caller, signal, progress });
          if (up.wait) return up.wait;
          for (const m of parts) {
            const r = up.by.get(m.name);
            if (r?.assetId) ids.set(m.name, r.assetId);
            else whys.push(`${m.name}: ${r?.why ?? 'not uploaded'}`);
          }
        }
        const permanent = !args.temporary && ids.size === parts.length;
        const off = (m: ModelMeta) => (m.origin ?? [0, 0, 0]).map((v) => Math.round(v * scale * 1000) / 1000).join(', ');
        const head = `local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
${PLACE_FN}
${SETTLE_FN}
local parent = resolveParent(${JSON.stringify(parentPath)})
local old = parent:FindFirstChild(${JSON.stringify(inst)})
if old then
  -- Ours to replace: placed here before (its mark), or put back by the world's rebuild, whose builder makes the
  -- container without the mark and marks the parts (six placements of a rebuilt kit were refused for that).
  local mark = old:GetAttribute("ShurikenAssembly")
  local ours = mark == ${JSON.stringify(args.name)}
  if not ours and mark == nil then
    ours = old:GetAttribute("ShurikenModel") ~= nil
    if not ours then
      ours = true
      for _, c in old:GetChildren() do
        if c:GetAttribute("ShurikenModel") == nil then ours = false break end
      end
    end
  end
  if not ours then error(old:GetFullName() .. " already exists and is not this model: pick another instance_name") end
  old:Destroy()
end
local model = Instance.new("Model")
model.Name = ${JSON.stringify(inst)}
model:SetAttribute("ShurikenAssembly", ${JSON.stringify(args.name)})
local pivot = CFrame.new(${args.position.join(', ')}) * CFrame.fromOrientation(math.rad(${rot[0]}), math.rad(${rot[1]}), math.rad(${rot[2]}))
model.WorldPivot = pivot
model.Parent = parent
local rx, ry, rz = pivot:ToOrientation()
local rot = { math.deg(rx), math.deg(ry), math.deg(rz) }
local function r(v) return math.round(v * 100) / 100 end`;
        const finish = `local info = settle(model, ${mode})
info.parts = {}
for _, c in model:GetChildren() do
  if c:IsA("MeshPart") then
    -- A legacy upload was turned back about its centre by place (see glb.ts): record the modeled orientation.
    local cf = c.CFrame
    if c:GetAttribute("ShurikenTurned") then cf = cf * CFrame.Angles(0, math.pi, 0) end
    local x, y, z = cf:ToOrientation()
    info.parts[c.Name] = { pos = { r(c.Position.X), r(c.Position.Y), r(c.Position.Z) }, rot = { r(math.deg(x)), r(math.deg(y)), r(math.deg(z)) }, maps = c:FindFirstChildOfClass("SurfaceAppearance") ~= nil or c.TextureID ~= "" }
  elseif c:IsA("Folder") and c:GetAttribute("ShurikenInstances") then
    -- An instanced part: its uses sit relative to the model's pivot (recorded below), not at a spot of their own.
    local first = c:FindFirstChildWhichIsA("MeshPart")
    info.parts[c.Name] = { instances = c:GetAttribute("ShurikenInstances"), maps = first ~= nil and (first:FindFirstChildOfClass("SurfaceAppearance") ~= nil or first.TextureID ~= "") }
  end
end
-- The model's pivot after settling (more digits than a spot: the uses hang off it, a thousand studs away).
local pv = model:GetPivot()
local pvx, pvy, pvz = pv:ToOrientation()
local function r4(v) return math.round(v * 10000) / 10000 end
info.pivot = { pos = { r4(pv.X), r4(pv.Y), r4(pv.Z) }, rot = { r4(math.deg(pvx)), r4(math.deg(pvy)), r4(math.deg(pvz)) } }
return HttpService:JSONEncode(info)`;
        type Settled = { path?: string; position?: [number, number, number]; rotation?: [number, number, number]; notes?: string[]; pivot?: { pos: [number, number, number]; rot: [number, number, number] }; parts?: Record<string, { pos?: [number, number, number]; rot?: [number, number, number]; maps?: boolean; instances?: number }> };
        if (permanent) {
          const placeParts = parts
            .map((m) => {
              const lk = look(m);
              // A mesh used many times (ModelMeta.instances): its uses are placed relative to the model's pivot, one MeshPart each.
              if (m.instances?.length)
                return `do
  placeInstances(${JSON.stringify(m.name)}, ${ids.get(m.name)}, {${m.size.join(',')}}, ${instancesTable(m.instances)}, {name=${JSON.stringify(m.name)},parent=${JSON.stringify(container)},pos={pivot.X, pivot.Y, pivot.Z},rot=rot,scale=${scale}${lk.color ? `,color=${JSON.stringify(lk.color)}` : ''}${lk.material ? `,material=${JSON.stringify(lk.material)}` : ''},group=true${turnOf(m) ? ',turn=true' : ''}${partFx(m) ? `,fx=${fxTable(partFx(m))}` : ''}})
end`;
              return `do
  local cf = pivot * CFrame.new(${off(m)})
  place(${JSON.stringify(m.name)}, ${ids.get(m.name)}, {${m.size.join(',')}}, {name=${JSON.stringify(m.name)},parent=${JSON.stringify(container)},pos={cf.X, cf.Y, cf.Z},rot=rot,scale=${scale}${lk.color ? `,color=${JSON.stringify(lk.color)}` : ''}${lk.material ? `,material=${JSON.stringify(lk.material)}` : ''},group=true${turnOf(m) ? ',turn=true' : ''}${partFx(m) ? `,fx=${fxTable(partFx(m))}` : ''}})
end`;
            })
            .join('\n');
          const res = await d.studio.runLuau(`${head}\n${placeParts}\n${finish}`, 'Edit', 180_000, signal);
          if (res.ok) {
            let info: Settled | null = null;
            try {
              info = JSON.parse(res.output.trim()) as Settled;
            } catch {
              /* reported below */
            }
            // Each part's final spot is recorded, so world/Models.luau rebuilds the model exactly there.
            for (const m of parts) {
              const at = info?.parts?.[m.name];
              if (!at) continue;
              // An instanced part is recorded at the model's pivot (its uses are relative to it); any other part at its own spot.
              const where = m.instances?.length ? info?.pivot : at.pos && at.rot ? { pos: at.pos, rot: at.rot } : undefined;
              if (!where) continue;
              const placement: ModelPlacement = { name: m.name, parent: container, position: where.pos, rotation: where.rot, scale, ...look(m), group: true };
              const cur = store.get(m.name) ?? m;
              store.save({ ...cur, placements: [...cur.placements.filter((x) => !(x.name === placement.name && x.parent === placement.parent)), placement] });
            }
            d.bus.emit('roblox.changed', { reason: 'luau' });
            const bloom = await tameBloom(parts.some((m) => isNeon(look(m).material)), signal);
            const textured = parts.filter((m) => m.textures);
            const kept = textured.filter((m) => info?.parts?.[m.name]?.maps);
            const review = textured.length ? await texturesInReview(info?.path ?? container, signal) : {};
            const used = parts.filter((m) => m.instances?.length);
            return jsonOutput({
              placed: info?.path ?? container,
              parts: parts.map((m) => m.name),
              ...(used.length ? { instances: Object.fromEntries(used.map((m) => [m.name, m.instances!.length])), instancesNote: `${used.reduce((n, m) => n + m.instances!.length, 0)} placed MeshParts from ${used.length} uploaded mesh${used.length === 1 ? '' : 'es'} (each in a Folder named after its part)` } : {}),
              position: info?.position,
              rotation: info?.rotation,
              notes: info?.notes ?? [],
              ...bloom,
              permanent: true,
              ...(textured.length ? { textures: uploadedMapsNote(kept.length, textured.length) } : {}),
              ...review,
              rebuiltBy: MODELS_BUILDER_REL,
            });
          }
          whys.push(`Roblox has the uploads but Studio couldn't load them yet (${res.output.slice(0, 200)}); new uploads can take a few minutes to process`);
        }
        // Temporary meshes: the model, then each part at its spot, then the whole thing settled.
        for (const m of parts) {
          const mesh = JSON.parse(readFileSync(store.paths(m.name).mesh, 'utf8')) as { v: number[]; t: number[] };
          if (mesh.t.length / 3 > MAX_TEMP_TRIS) return errorOutput(`${whys.length ? `Not uploaded (${whys.join('; ')}). ` : ''}${m.name} (${mesh.t.length / 3} triangles) is too big for a temporary placement; simplify it or upload it.`);
        }
        const spots = await d.studio.runLuau(`${head}\nlocal spots = {}\n${parts.map((m) => `spots[${JSON.stringify(m.name)}] = (function() local p = (pivot * CFrame.new(${off(m)})).Position return { p.X, p.Y, p.Z } end)()`).join('\n')}\nreturn HttpService:JSONEncode({ spots = spots, rot = rot, pivot = { pivot.X, pivot.Y, pivot.Z } })`, 'Edit', 60_000, signal);
        if (!spots.ok) return errorOutput(`Placing ${args.name} failed: ${spots.output.slice(0, 600)}`);
        const at = JSON.parse(spots.output.trim()) as { spots: Record<string, [number, number, number]>; rot: [number, number, number]; pivot: [number, number, number] };
        for (const m of parts) {
          const mesh = JSON.parse(readFileSync(store.paths(m.name).mesh, 'utf8')) as { v: number[]; t: number[]; uv?: number[]; n?: number[] };
          const code = m.instances?.length
            ? temporaryInstancesLuau(m.name, mesh, m.instances, { name: m.name, parent: container, position: at.pivot, rotation: at.rot, scale, ...look(m), group: true }, surfaceLuau(p.root, m.textures, 'mp', m.emission), partFx(m))
            : temporaryMeshLuau(m.name, mesh, { name: m.name, parent: container, position: at.spots[m.name]!, rotation: at.rot, scale, ...look(m) }, false, surfaceLuau(p.root, m.textures, 'mp', m.emission), partFx(m));
          const r = await d.studio.runLuau(code, 'Edit', 120_000, signal);
          if (!r.ok) return errorOutput(`Placing a temporary mesh for ${m.name} failed: ${r.output.slice(0, 600)}`);
        }
        const tex = await stageTextures((code) => d.studio.runLuau(code, 'Edit', 120_000, signal), p.root, parts);
        const settled = await d.studio.runLuau(
          `local HttpService = game:GetService("HttpService")\n${PLACE_FN}\n${SETTLE_FN}\nlocal model = resolveParent(${JSON.stringify(container)}, "Model")\nlocal function r(v) return math.round(v * 100) / 100 end\n${finish}`,
          'Edit',
          60_000,
          signal,
        );
        d.bus.emit('roblox.changed', { reason: 'luau' });
        const info = settled.ok ? (parseSettle(settled.output) ?? null) : null;
        const bloom = await tameBloom(parts.some((m) => isNeon(look(m).material)), signal);
        return jsonOutput({
          placed: info?.path ?? container,
          parts: parts.map((m) => m.name),
          position: info?.position,
          notes: info?.notes ?? [],
          ...bloom,
          permanent: false,
          ...(tex.error ? { textures: `its texture maps didn't load: ${tex.error}` } : parts.some((m) => m.textures) ? { textures: 'its texture maps show on the temporary meshes (SurfaceAppearance)' } : {}),
          note: `Temporary meshes: the model shows in Studio now but is not saved with the place${whys.length ? `; not uploaded because ${whys.join('; ')}` : ''}. Upload it (model_place again once uploading works) before relying on it.`,
        });
      }
      if (!meta) return errorOutput(`No model named ${args.name}; make it with blender_python first.`);
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      const onGround: boolean | 'wall' = args.on_wall ? 'wall' : args.on_ground !== false;
      const placement: ModelPlacement = {
        name: args.instance_name ?? args.name,
        parent: args.parent ?? 'Workspace',
        position: args.position,
        rotation: args.rotation ?? [0, 0, 0],
        scale: args.scale ?? 1,
        ...(args.color ? { color: args.color.startsWith('#') ? args.color : `#${args.color}` } : meta.color ? { color: meta.color } : {}),
        ...(args.material ? { material: args.material } : meta.material ? { material: meta.material } : {}),
      };
      let assetId: string | null = null;
      let why: string | undefined;
      if (!args.temporary) {
        const up = await uploadAll(p, [meta], 'model_place', { caller, signal, progress });
        if (up.wait) return up.wait;
        const r = up.by.get(meta.name);
        assetId = r?.assetId ?? null;
        why = r?.why;
        meta = r?.meta ?? meta;
      }
      if (assetId) {
        const code = `local InsertService = game:GetService("InsertService")\n${PLACE_FN}\n${SETTLE_FN}\nlocal mp = place(${JSON.stringify(meta.name)}, ${assetId}, {${meta.size.join(',')}}, {name=${JSON.stringify(placement.name)},parent=${JSON.stringify(placement.parent)},pos={${placement.position.join(',')}},rot={${placement.rotation.join(',')}},scale=${placement.scale}${placement.color ? `,color=${JSON.stringify(placement.color)}` : ''}${placement.material ? `,material=${JSON.stringify(placement.material)}` : ''}${partFx(meta) ? `,fx=${fxTable(partFx(meta))}` : ''}})\nlocal info = settle(mp, ${onGround === 'wall' ? '"wall"' : onGround})\n${turnOf(meta) ? '-- A legacy upload arrives turned 180° about its centre (glb.ts): turned back after settling (a wall mount sets the orientation).\nmp.CFrame = mp.CFrame * CFrame.Angles(0, math.pi, 0)\nmp:SetAttribute("ShurikenTurned", true)\n' : ''}info.maps = mp:FindFirstChildOfClass("SurfaceAppearance") ~= nil or mp.TextureID ~= ""\nreturn game:GetService("HttpService"):JSONEncode(info)`;
        const r = await d.studio.runLuau(code, 'Edit', 120_000, signal);
        if (r.ok) {
          const info = parseSettle(r.output);
          // Record where it ended up (and how a wall mount turned it), so world/Models.luau rebuilds it exactly there.
          const final = { ...placement, position: info?.position ?? placement.position, rotation: onGround === 'wall' && info?.rotation ? info.rotation : placement.rotation };
          const others = meta.placements.filter((x) => !(x.name === placement.name && x.parent === placement.parent));
          store.save({ ...meta, placements: [...others, final] });
          d.bus.emit('roblox.changed', { reason: 'luau' });
          const bloom = await tameBloom(isNeon(placement.material), signal);
          const maps = (info as { maps?: boolean } | null)?.maps;
          const review = meta.textures ? await texturesInReview(info?.path ?? r.output.trim(), signal) : {};
          return jsonOutput({ placed: info?.path ?? r.output.trim(), position: final.position, notes: info?.notes ?? [], ...bloom, assetId, permanent: true, ...(meta.textures ? { textures: uploadedMapsNote(maps ? 1 : 0, 1) } : {}), ...review, rebuiltBy: MODELS_BUILDER_REL });
        }
        why = `Roblox has the upload (asset ${assetId}) but Studio couldn't load it yet (${r.output.slice(0, 200)}); new uploads can take a few minutes to process`;
      }
      const mesh = JSON.parse(readFileSync(store.paths(meta.name).mesh, 'utf8')) as { v: number[]; t: number[]; uv?: number[]; n?: number[] };
      if (mesh.t.length / 3 > MAX_TEMP_TRIS) return errorOutput(`${why ? `Not uploaded: ${why}. ` : ''}The mesh (${mesh.t.length / 3} triangles) is too big for a temporary placement; raise tolerance or upload it.`);
      const r = await d.studio.runLuau(temporaryMeshLuau(meta.name, mesh, placement, onGround, surfaceLuau(p.root, meta.textures, 'mp', meta.emission), partFx(meta)), 'Edit', 120_000, signal);
      if (!r.ok) return errorOutput(`Placing a temporary mesh failed: ${r.output.slice(0, 600)}${why ? ` (not uploaded: ${why})` : ''}`);
      const tex = await stageTextures((code) => d.studio.runLuau(code, 'Edit', 120_000, signal), p.root, [meta]);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      const info = parseSettle(r.output);
      const bloom = await tameBloom(isNeon(placement.material), signal);
      return jsonOutput({
        placed: info?.path ?? r.output.trim(),
        position: info?.position ?? placement.position,
        notes: info?.notes ?? [],
        ...bloom,
        permanent: false,
        ...(tex.error ? { textures: `its texture maps didn't load: ${tex.error}` } : meta.textures ? { textures: 'its texture maps show on the temporary mesh (SurfaceAppearance)' } : {}),
        note: `Temporary mesh: it shows in Studio now but is not saved with the place${why ? `; it wasn't uploaded because ${why}` : ''}. Upload it (model_place again once uploading works) before relying on it.`,
      });
    },
  });

  reg.register({
    name: 'model_view',
    title: 'Look at a 3D model',
    description:
      'A picture of a built model: three angles (three-quarter, front, side) with a default Roblox character (5.2 studs) standing beside it for scale, and a close-up from behind. Use it after modeling (blender_python) to judge the shape, proportions, silhouette and size the way a player will see them, and fix what looks off before placing it. The Models page shows the user the same model.',
    capability: 'app.modeling',
    permission: 'read',
    input: { name: z.string() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const store = new ModelStore(p.root);
      const m = store.get(args.name);
      // A part shows with the rest of its assembly; an assembly's name shows all its parts.
      const assembly = m?.assembly ?? (store.parts(args.name).length ? args.name : null);
      const parts = assembly ? store.parts(assembly) : m ? [m] : [];
      if (!parts.length) return errorOutput(`No model or assembly named ${args.name}`);
      const meshes = parts.map((x) => ({ meta: x, glb: modelGlb(p.root, x.name) }));
      const missing = meshes.filter((x) => !x.glb).map((x) => x.meta.name);
      if (missing.length) return errorOutput(`No mesh yet for ${missing.join(', ')}: make it with blender_python first.`);
      if (!d.render) return errorOutput('Pictures of models are drawn by the Shuriken app; this engine is running without it. Place the model in Studio and use roblox_screenshot instead.');
      const image = await d.render(
        meshes.map((x) => ({ glb: x.glb!, color: x.meta.color, material: x.meta.material, origin: assembly ? x.meta.origin : undefined, ...(x.meta.instances?.length ? { instances: x.meta.instances } : {}) })),
        { name: assembly ?? m!.name },
      );
      const data = image ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(image) : null;
      if (!data) return errorOutput('The picture could not be drawn this time. Place the model in Studio and use roblox_screenshot instead.');
      const [x, y, z] = assembly ? assembledSize(parts) : m!.size;
      const longest = Math.max(x, y, z);
      const vs = `${(longest / 5.2).toFixed(longest < 5.2 ? 2 : 1)}× a player's height (${y >= longest ? 'tall' : 'long'})`;
      const tris = parts.reduce((t, q) => t + q.triangles, 0);
      const look = (q: ModelMeta) => [q.color, q.material].filter(Boolean).join(' ') || 'no colour set, so drawn beige';
      const what = assembly
        ? `${assembly}, ${parts.length} part${parts.length === 1 ? '' : 's'} (${parts.map((q) => `${q.name}: ${look(q)}${q.role ? `, ${q.role}` : ''}${q.origin ? '' : ', no origin: rebuild it with assembly set'}`).join('; ')}), assembled`
        : `${m!.name} (${look(m!)})`;
      return {
        content: [
          { type: 'image', data: data[2]!, mimeType: data[1]! },
          { type: 'text', text: `${what}: ${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} studs (X × Y up × Z), ${tris.toLocaleString()} triangles; its longest side is ${vs}.${formatFaces(parts) ? `
${formatFaces(parts)}` : ''}` },
        ],
      };
    },
  });

  /**
   * A placed model whose textures Roblox is still reviewing renders flat grey, in Studio and in playtests, until it
   * approves them (minutes, sometimes an hour). Two builds each grew about twenty follow-ups and several whole tasks
   * about "grey, untextured" models, and agents "fixed" them by re-uploading or by replacing the textures with flat
   * colours. The placement says so itself, so nobody reads it as a defect.
   */
  const texturesInReview = async (path: string, signal?: AbortSignal): Promise<{ texturesInReview?: string }> => {
    const note = d.imageStates ? await reviewNote(d.studio, d.imageStates, path, signal) : null;
    return note ? { texturesInReview: note } : {};
  };

  /** Stages parts as temporary meshes for a preview rig (batches of about 180 KB of Luau). */
  const stageTemporaryMeshes = async (model: string, list: ModelMeta[], signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> => {
    const store = new ModelStore(proj().root);
    let batch: Array<{ name: string; v: number[]; t: number[]; uv?: number[]; n?: number[]; surface?: string }> = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await d.studio.runLuau(stageMeshesLuau(model, batch), 'Edit', 180_000, signal);
      batch = [];
      size = 0;
      if (!r.ok) throw new Error(r.output.slice(0, 400));
    };
    try {
      for (const q of list) {
        const f = store.paths(q.name).mesh;
        if (!existsSync(f)) throw new Error(`${q.name} has no mesh file (export the model again)`);
        const mesh = JSON.parse(readFileSync(f, 'utf8')) as { v: number[]; t: number[]; uv?: number[]; n?: number[] };
        const normals = meshNormals(mesh);
        const est = mesh.v.length * 8 + mesh.t.length * 6 + (mesh.uv?.length ?? 0) * 9 + (normals?.length ?? 0) * 8;
        if (size + est > 180_000 && batch.length) await flush();
        const surface = surfaceLuau(proj().root, q.textures, 'mp', q.emission);
        batch.push({ name: q.name, v: mesh.v, t: mesh.t, ...(normals ? { n: normals } : {}), ...(mesh.uv && surface ? { uv: mesh.uv, surface } : {}) });
        size += est;
      }
      await flush();
      const tex = await stageTextures((code) => d.studio.runLuau(code, 'Edit', 120_000, signal), proj().root, list);
      if (tex.error) throw new Error(`texture maps: ${tex.error}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  /**
   * A rigged model's clips that aren't uploaded for their current content go up (and the place's animations are
   * built again with their asset ids) when uploading is set up: the same build animation_build runs. What it
   * says about the uploads, or null when there is nothing to do.
   */
  const uploadCreatureClips = async (root: string, model: string): Promise<Record<string, unknown> | null> => {
    const store = new AnimationStore(root);
    const todo = store.inGame().filter((f) => f.clip.rig === model && !store.summary(f).uploaded).map((f) => f.clip.name);
    if (!todo.length || !d.uploads().enabled || !(await d.cloud.configured())) return null;
    const out = await reg.invoke('animation_build', {}, { kind: 'ui', runId: null, taskId: null, role: 'user', providerId: null, allowedTools: null });
    const uploads = (out.data as { uploads?: Record<string, unknown> } | undefined)?.uploads;
    return uploads ? { ...uploads, clips: todo } : { clips: todo, note: out.isError ? 'the animations did not build (animation_build says why)' : 'built' };
  };

  /**
   * Builds a rig template in Studio from what is uploaded; a part with no asset (not uploaded, still
   * processing at Roblox, or an asset Studio can't load yet) is staged as a temporary mesh instead, so
   * the build never waits for all-or-nothing and never leaves an older build standing. world/Rigs.luau
   * (permanent rigs only: every part uploaded) is kept in step. Says which parts are temporary and which
   * could not be shown at all.
   */
  const buildRigInStudio = async (
    root: string,
    model: string,
    rig: RigSpec,
    parts: ModelMeta[],
    why: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; uploaded: string[]; temporary: Array<{ name: string; why: string }>; leftOut: Array<{ name: string; why: string }>; note: string | null } | { ok: false; error: string }> => {
    writeRigsBuilder(root);
    const assets = Object.fromEntries(parts.map((q) => [q.name, ModelStore.assetId(q)]).filter((x): x is [string, string] => !!x[1]));
    const known = Object.keys(new ModelStore(root).rigs());
    // Parts shown as temporary meshes, with the reason: no asset yet, or one that Studio couldn't load.
    const temp = new Map<string, string>(parts.filter((q) => !assets[q.name]).map((q) => [q.name, why.get(q.name) ?? 'not uploaded']));
    type Res = { built?: string[]; failed?: Array<{ name: string; error: string }>; skipped?: Array<{ rig: string; name: string; why: string }> };
    const pass = async (): Promise<{ ok: true; res: Res; stageError: string | null } | { ok: false; error: string }> => {
      let stageError: string | null = null;
      if (temp.size) {
        const staged = await stageTemporaryMeshes(model, parts.filter((q) => temp.has(q.name)), signal);
        if (!staged.ok) stageError = staged.error;
      }
      // Nothing uploaded and nothing staged: there is no mesh to build with (and the older build stays as it was).
      if (stageError && !Object.keys(assets).length) return { ok: false, error: `None of ${model}'s ${parts.length} part(s) is uploaded (${[...temp.values()][0] ?? 'not uploaded'}) and a preview rig from temporary meshes failed too: ${stageError}` };
      const program = rigsBuilder([{ rig, parts, assets }], { temporary: temp.size > 0, skipMissing: true, known });
      const r = await d.studio.runLuau(program, 'Edit', 180_000, signal);
      if (!r.ok) return { ok: false, error: `Building the rigs failed: ${r.output.slice(0, 600)}` };
      let res: Res = {};
      try {
        res = JSON.parse(r.output.trim()) as Res;
      } catch {
        /* reported below */
      }
      return { ok: true, res, stageError };
    };
    let first = await pass();
    if (!first.ok) return first;
    // Uploaded parts Studio couldn't load yet (Roblox is still checking the asset) are shown as temporary meshes this time.
    const unloadable = (first.res.skipped ?? []).filter((s) => s.rig === model && assets[s.name]);
    if (unloadable.length && !first.res.failed?.some((f) => f.name === model)) {
      for (const s of unloadable) {
        delete assets[s.name];
        temp.set(s.name, `Studio couldn't load its uploaded asset yet (${s.why.replace(/^.*?:\d+: /, '').slice(0, 120)})`);
      }
      const again = await pass();
      if (!again.ok) return again;
      first = again;
    }
    const failed = first.res.failed?.find((f) => f.name === model);
    if (failed) return { ok: false, error: `Building ${model} failed: ${failed.error}` };
    // Parts that ended up with no mesh at all (their temporary mesh couldn't be staged either) are left out of the rig.
    const leftOut = (first.res.skipped ?? []).filter((s) => s.rig === model).map((s) => ({ name: s.name, why: `${temp.get(s.name) ?? s.why}${first.stageError ? `; its temporary mesh couldn't be staged: ${first.stageError}` : ''}` }));
    const shown = parts.filter((q) => !leftOut.some((o) => o.name === q.name));
    const temporary = shown.filter((q) => temp.has(q.name)).map((q) => ({ name: q.name, why: temp.get(q.name)! }));
    const names = (list: Array<{ name: string }>) => list.map((x) => x.name).join(', ');
    const note = temporary.length
      ? `Built with ${temporary.length} of ${parts.length} part(s) as temporary meshes — ${names(temporary.slice(0, 8))}${temporary.length > 8 ? ', …' : ''} (${temporary[0]!.why}${temporary.length > 1 ? '; …' : ''}): the rig works in this Studio session (previews, animation_check, playtests), but temporary meshes aren't saved with the place. Run rig_build again once those parts are uploaded (they upload on the next call) for the real game.`
      : null;
    return { ok: true, uploaded: shown.filter((q) => assets[q.name]).map((q) => q.name), temporary, leftOut, note };
  };

  reg.register({
    name: 'rig_build',
    title: 'Build a rigged model in Studio',
    description: `Turns a model rigged in Blender (kiln.rig: joints, segments, legs, attachment points; its export wrote models/<Model>.rig.json) into a Roblox rig template at ReplicatedStorage.ShurikenRigs.<Model>: an invisible HumanoidRootPart, one invisible part per segment at its joint's pivot (named like the joint), Motor6Ds between them, the model's MeshParts welded to their segments, the attachment points (grips, sockets) as Attachments, and an AnimationController with an Animator. Clips made for the rig (clip.rig = the model) play on it with the animations module: Anims.play(rigClone, "<clip>"). Its parts are uploaded first (only the ones whose mesh or maps changed since their last upload); the rig is built from the uploaded meshes, and a part that isn't uploaded yet (no key, Roblox still processing it, an error) is shown as a temporary mesh in this Studio session instead of failing the build — the result says which parts are temporary (they aren't saved with the place; run rig_build again once they are uploaded). ${RIGS_BUILDER_REL} rebuilds the rigs whose parts are all uploaded. place: {position, rotation?, name?} also puts a copy in Workspace, resting on the ground, to look at or test.`,
    capability: 'app.modeling',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: {
      model: z.string(),
      place: z.object({ position: z.tuple([z.number(), z.number(), z.number()]), rotation: z.tuple([z.number(), z.number(), z.number()]).optional(), name: z.string().optional() }).optional(),
    },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const store = new ModelStore(p.root);
      const rig = store.rig(args.model);
      if (!rig) return errorOutput(`${args.model} has no rig. Rig it in Blender with kiln.rig (joint, bind, leg, attach); its export then writes models/${args.model}.rig.json.`);
      const parts = store.parts(args.model);
      if (!parts.length) return errorOutput(`${args.model} has no exported parts yet.`);
      if (parts.some((q) => !q.segment)) return errorOutput(`${args.model}'s parts were exported before it was rigged: change it once in Blender so it exports again, by segment.`);
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      // Every part not uploaded for its current build goes up first (the others are left alone), together.
      const up = await uploadAll(p, parts, 'rig_build', { caller, signal, progress });
      if (up.wait) return up.wait;
      const why = new Map<string, string>(parts.filter((m) => !up.by.get(m.name)?.assetId).map((m) => [m.name, up.by.get(m.name)?.why ?? 'not uploaded']));
      const build = await buildRigInStudio(p.root, args.model, rig, store.parts(args.model), why, signal);
      if (!build.ok) return errorOutput(build.error);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      const bloom = await tameBloom(parts.some((m) => isNeon(m.material)), signal);
      let placed: unknown = null;
      if (args.place) {
        const rot = args.place.rotation ?? [0, 0, 0];
        const code = `local ReplicatedStorage = game:GetService("ReplicatedStorage")
${SETTLE_FN}
local t = ReplicatedStorage.ShurikenRigs:FindFirstChild(${JSON.stringify(args.model)})
if not t then error("the template is missing") end
local name = ${JSON.stringify(args.place.name ?? args.model)}
local old = workspace:FindFirstChild(name)
if old and old:GetAttribute("ShurikenRig") == ${JSON.stringify(args.model)} then old:Destroy() end
local m = t:Clone()
m.Name = name
m:PivotTo(CFrame.new(${args.place.position.join(', ')}) * CFrame.fromOrientation(math.rad(${rot[0]}), math.rad(${rot[1]}), math.rad(${rot[2]})))
m.Parent = workspace
return game:GetService("HttpService"):JSONEncode(settle(m, true))`;
        const pr = await d.studio.runLuau(code, 'Edit', 60_000, signal);
        placed = pr.ok ? (parseSettle(pr.output) ?? pr.output.trim()) : `not placed: ${pr.output.slice(0, 300)}`;
        d.bus.emit('roblox.changed', { reason: 'luau' });
      }
      // The creature's clips: a track a server script plays on it reaches the players only through an uploaded
      // asset, so the clips that aren't uploaded yet go up now (animation_build does it, changed clips only).
      const clips = await uploadCreatureClips(p.root, args.model);
      return jsonOutput({
        template: `ReplicatedStorage.ShurikenRigs.${args.model}`,
        parts: { total: parts.length, uploaded: build.uploaded.length, temporary: build.temporary.length, leftOut: build.leftOut.length },
        ...(build.note ? { temporary: build.note, temporaryParts: build.temporary.map((t) => t.name) } : {}),
        ...(build.leftOut.length ? { leftOut: build.leftOut } : {}),
        joints: rig.joints.map((j) => j.name),
        legs: rig.legs,
        attachments: rig.attachments.map((a) => `${a.name} on ${a.part}`),
        placed,
        ...(clips ? { clips } : {}),
        ...bloom,
        rebuiltBy: RIGS_BUILDER_REL,
        use: `local rig = game.ReplicatedStorage.ShurikenRigs.${args.model}:Clone(); rig:PivotTo(spawnCFrame); rig.Parent = workspace; Anims.play(rig, "<clip made with rig: ${args.model}>")`,
      });
    },
  });

  reg.register({
    name: 'model_gear',
    title: 'Make a model into gear',
    description: `Turn a model into gear for R15 players: a Tool they hold (weapons, tools, wands, torches) or an Accessory they wear (helmets, armour, capes, backpacks, a shield on the arm). Tool: the right hand holds the model's grip point — an attachment named Grip (or Grip_R / RightGripAttachment) made in Blender with kiln.rig (a joint "Handle" at the grip, every part bound to it, kiln.rig.attach("Grip", "Handle", point)), or grip_at — and carries it exactly as modeled: model weapons upright, their front (−Y in Blender) facing where the character looks. Accessory: worn on a character attachment (attach_to: HatAttachment, HairAttachment, FaceFrontAttachment, NeckAttachment, BodyFrontAttachment, BodyBackAttachment, Left/RightShoulderAttachment, Left/RightCollarAttachment, WaistFront/Back/CenterAttachment, Left/RightGripAttachment, Left/RightFootAttachment), exactly where it was modeled around the reference character (skill "blender-props", Gear) — or at the model's own attachment of that name. The parts are uploaded first; the gear is built into ServerStorage.ShurikenGear (or StarterPack, or ReplicatedStorage.ShurikenGear), and ${GEAR_BUILDER_REL} rebuilds it.`,
    capability: 'app.modeling',
    permission: 'roblox_write',
    available: () => d.studio.availability(),
    input: {
      model: z.string().describe('The model (one part, or a multi-part model by its name)'),
      kind: z.enum(['tool', 'accessory']),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/).optional().describe('The item\'s name in the game (default: the model name)'),
      attach_to: z.string().optional().describe('Accessory: the character attachment it is worn on'),
      grip_at: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Tool without a Grip attachment: where the hand holds it, in Blender coordinates (studs, Z up, front −Y)'),
      into: z.enum(['ServerStorage', 'StarterPack', 'ReplicatedStorage']).optional().describe('Default ServerStorage (the server gives it out); StarterPack gives a tool to every player'),
    },
    handler: async ({ args, caller, signal, progress }) => {
      const p = proj();
      const store = new ModelStore(p.root);
      const parts = gearParts(store, args.model);
      if (!parts.length) return errorOutput(`No model named ${args.model}; make it with blender_python first.`);
      const name = args.name ?? args.model;
      const atts = store.rig(parts[0]!.assembly ?? args.model)?.attachments ?? store.rig(args.model)?.attachments ?? [];
      let point: Vec3;
      let attachTo: string | undefined;
      if (args.kind === 'tool') {
        const rank = (n: string) => (/^grip$/i.test(n) ? 3 : /^(grip_?r|rightgrip(attachment)?)$/i.test(n) ? 2 : /grip/i.test(n) ? 1 : 0);
        const grip = atts.filter((a) => rank(a.name) > 0).sort((a, b) => rank(b.name) - rank(a.name))[0];
        // The Grip socket Kiln delivered for the model (kiln_request {sockets: [{name: "Grip"}]}), read back into its record.
        const fam = familyOfModel(p.root, args.model);
        const delivered = Object.entries(fam?.read?.members[args.model]?.sockets ?? {})
          .filter(([n]) => rank(n) > 0)
          .sort((a, b) => rank(b[0]) - rank(a[0]))[0]?.[1];
        if (grip) point = grip.position;
        else if (delivered) point = delivered.position;
        else if (args.grip_at) point = blenderToRoblox(args.grip_at);
        else
          return errorOutput(
            `${args.model} has no grip point. Ask Kiln for one: kiln_request {model: "${args.model}", kind: "fix", sockets: [{name: "Grip", joins: "the hand holding it", where: "on the handle"}], text: "Add the Grip socket at the handle."}, or pass grip_at: [x, y, z] (Blender coordinates, Z up; model_view shows the model's size). A model built with blender_python: kiln.rig.joint("Handle", grip), kiln.rig.bind(objects, "Handle"), kiln.rig.attach("Grip", "Handle", grip).`,
          );
      } else {
        if (!args.attach_to || !R15_ATTACHMENTS[args.attach_to]) return errorOutput(`attach_to must be one of the character's attachments: ${Object.keys(R15_ATTACHMENTS).join(', ')}`);
        if (args.into === 'StarterPack') return errorOutput('Accessories are worn, not carried: build them into ServerStorage (or ReplicatedStorage) and give them with humanoid:AddAccessory.');
        attachTo = args.attach_to;
        point = atts.find((a) => a.name === attachTo)?.position ?? R15_ATTACHMENTS[attachTo]!.pos;
      }
      const blocked = await leaseBlocked(caller, signal);
      if (blocked) return blocked;
      const up = await uploadAll(p, parts, 'model_gear', { caller, signal, progress });
      if (up.wait) return up.wait;
      const why = parts.filter((m) => !up.by.get(m.name)?.assetId).map((m) => `${m.name}: ${up.by.get(m.name)?.why ?? 'not uploaded'}`);
      if (why.length) return errorOutput(`Gear is built from uploaded meshes, and ${why.length} part(s) couldn't be uploaded: ${why.join('; ')}.`);
      const into = args.into === 'StarterPack' ? 'StarterPack' : `${args.into ?? 'ServerStorage'}.ShurikenGear`;
      const spec: GearSpec = { name, model: args.model, kind: args.kind, ...(attachTo ? { attachTo } : {}), point, into };
      new GearStore(p.root).save(spec);
      const out = writeGearBuilder(p.root);
      if (!out.file || !out.built.includes(name)) return errorOutput(`${name} isn't ready to build (${out.waiting.includes(name) ? 'parts not uploaded' : 'unknown'}).`);
      const r = await d.studio.runLuau(readFileSync(out.file, 'utf8'), 'Edit', 180_000, signal);
      if (!r.ok) return errorOutput(`Building the gear failed: ${r.output.slice(0, 600)}`);
      let res: { built?: string[]; failed?: Array<{ name: string; error: string }>; bloom?: string } = {};
      try {
        res = JSON.parse(r.output.trim()) as typeof res;
      } catch {
        /* reported below */
      }
      const failed = res.failed?.find((f) => f.name === name);
      if (failed) return errorOutput(`Building ${name} failed: ${failed.error}`);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      const path = `${into}.${name}`;
      const usage =
        args.kind === 'tool'
          ? into === 'StarterPack'
            ? `Every player spawns with it (StarterPack). Its Activated event is the swing: tool.Activated:Connect(function() … end)`
            : `local tool = game.${path}:Clone()\ntool.Parent = player.Backpack -- or humanoid:EquipTool(tool)\ntool.Activated:Connect(function() --[[ swing: play the attack, hit on its Hit marker ]] end)`
          : `humanoid:AddAccessory(game.${path}:Clone()) -- worn on its ${attachTo}`;
      return jsonOutput({ gear: path, kind: args.kind, parts: parts.map((m) => m.name), ...(attachTo ? { attachTo } : {}), point, ...(res.bloom ? { bloom: res.bloom } : {}), usage, rebuiltBy: GEAR_BUILDER_REL });
    },
  });

  reg.register({
    name: 'model_remove',
    title: 'Remove models',
    description:
      "Delete models from the project's model store and the Models page: parts by name, or every part of a multi-part model by its name. For models your work replaced, e.g. the separate build123d parts (EnderChest_A_Lid, …) of a model you rebuilt in Blender. Copies already placed in Studio stay, but world/Models.luau no longer rebuilds them. A Blender model's parts come back with its next change.",
    capability: 'app.modeling',
    permission: 'write_project',
    input: { names: z.array(z.string()).min(1).max(40) },
    handler: async ({ args }) => {
      const root = proj().root;
      const out = new ModelStore(root).removeMany(args.names);
      if (out.removed.length) d.bus.emit('assets.changed', {});
      // A model built in its own Kiln project (a variant that lost): the project goes to Kiln's trash with it.
      const kiln: string[] = [];
      for (const name of args.names) {
        const what = await d.discard?.(root, name).catch(() => null);
        if (what) kiln.push(`${name}: ${what}`);
      }
      return jsonOutput(kiln.length ? { ...out, kiln } : out, out.removed.length ? `Removed ${out.removed.length} model(s)` : 'Nothing removed');
    },
  });

  reg.register({
    name: 'model_list',
    title: 'List 3D models',
    description: "The game's models (Roblox MeshParts exported from Blender; a model with several materials is an assembly of parts): size, look, triangles, upload state, placements and each part's origin. Pass name for one.",
    capability: 'app.modeling',
    permission: 'read',
    input: { name: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const store = new ModelStore(p.root);
      if (args.name) {
        const parts = store.parts(args.name);
        if (parts.length) return jsonOutput({ assembly: args.name, parts: parts.map((m) => ({ ...m, assetId: ModelStore.assetId(m) })) });
        const m = store.get(args.name);
        return m ? jsonOutput({ ...m, assetId: ModelStore.assetId(m) }) : errorOutput(`No model named ${args.name}`);
      }
      return jsonOutput({
        models: store.all().map((m) => ({ name: m.name, assembly: m.assembly, origin: m.origin, size: m.size, look: [m.color, m.material].filter(Boolean).join(' '), ...(m.role ? { role: m.role } : {}), ...(m.instances?.length ? { instances: m.instances.length } : {}), triangles: m.triangles, assetId: ModelStore.assetId(m), placements: m.placements.length, updatedAt: m.updatedAt })),
      });
    },
  });
  /** What wait_for "upload" watches: parts of this project uploading to Roblox right now; and the queue itself, for the map import to join. */
  return { uploading: (root) => uploader.uploading(root), uploader };
}

/** For the UI: the model's mesh (GLB bytes) when it exists. */
export function modelGlb(root: string, name: string): Buffer | null {
  const f = new ModelStore(root).paths(name).glb;
  return existsSync(f) ? readFileSync(f) : null;
}
