import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus } from '../events';
import type { ExportedPart } from './backend';
import { ModelStore, type ModelMeta } from './model-store';
import { importKilnClips, type ClipImport } from '../animation/kiln-clips';
import { AnimationStore } from '../animation/animation-service';

/**
 * Records a model's freshly exported Roblox MeshParts in the project's model store (one entry per
 * part, grouped as an assembly when there are several) and drops parts an earlier version had. Every
 * modeling engine (Shuriken's own Blender, the user's Kiln app) publishes through this, so the Models
 * page, model_view, uploads and model_place see the same thing whichever engine built the model.
 */
export function recordParts(root: string, name: string, parts: ExportedPart[], previous: ExportedPart[], bus: EventBus, opts: { deferBuilder?: boolean } = {}): void {
  const store = new ModelStore(root);
  // An instanced mesh is an assembly even alone: model_place places its uses as one Model.
  const multi = parts.length > 1 || parts.some((p) => p.instances?.length);
  for (const part of parts) {
    const prev = store.get(part.name);
    const meshFile = store.paths(part.name).mesh;
    // The mesh and its texture maps: a repaint is a new version too (uploaded again).
    const hasher = createHash('sha1');
    if (existsSync(meshFile)) hasher.update(readFileSync(meshFile));
    for (const f of Object.values(part.textures ?? {})) {
      const file = join(store.dir(), f);
      if (existsSync(file)) hasher.update(readFileSync(file));
    }
    const hash = existsSync(meshFile) ? hasher.digest('hex').slice(0, 12) : String(Date.now());
    const meta: Omit<ModelMeta, 'updatedAt'> = {
      name: part.name,
      description: prev?.description ?? (multi ? `${name}: its ${part.blender_material ?? 'base'} part` : `${name}, modeled in Blender`),
      hash,
      size: part.size,
      triangles: part.triangles,
      vertices: part.vertices,
      volume: null,
      faces: 0,
      solids: 1,
      valid: true,
      tolerance: null,
      upload: prev?.upload && prev.upload.hash === hash ? prev.upload : undefined,
      placements: prev?.placements ?? [],
      asset: prev?.asset,
      color: part.color,
      material: part.material,
      ...(part.transparency ? { transparency: part.transparency } : {}),
      assembly: multi ? name : undefined,
      origin: multi ? part.origin : undefined,
      ...(part.segment ? { segment: part.segment } : {}),
      ...(part.own ? { own: part.own } : {}),
      ...(part.textures ? { textures: part.textures } : {}),
      ...(part.emission ? { emission: part.emission } : {}),
      ...(part.doubleSided ? { doubleSided: true } : {}),
      ...(part.facesDown?.length ? { facesDown: part.facesDown } : {}),
      ...(part.role ? { role: part.role } : {}),
      ...(part.role && part.roleInferred ? { roleInferred: true } : {}),
      ...(part.replaced ? { replaced: true } : {}),
      ...(part.box ? { box: true } : {}),
      ...(part.fill !== undefined ? { fill: part.fill } : {}),
      ...(part.instances?.length ? { instances: part.instances } : {}),
      source: 'blender',
      blend: `models/${name}.blend`,
    };
    store.save(meta, { deferBuilder: true });
  }
  // world/Models.luau reads every model: it is written once for the parts saved above, not once per part (a map has hundreds).
  // `deferBuilder`: the caller records many models in a row (a map's pieces) and writes it once after the last.
  if (!opts.deferBuilder) store.writeBuilder();
  // Texture maps no material of this model uses any more (<name>__<material>.<map>.png).
  const inUse = new Set(parts.flatMap((p) => Object.values(p.textures ?? {})));
  try {
    for (const f of readdirSync(store.dir())) if (f.startsWith(`${name}__`) && f.endsWith('.png') && !inUse.has(f)) rmSync(join(store.dir(), f), { force: true });
  } catch {
    // no models folder yet
  }
  // Parts an earlier version had and this one doesn't (a material renamed or removed).
  const now = new Set(parts.map((p) => p.name));
  for (const old of previous) if (!now.has(old.name) && old.name !== name) store.remove(old.name);
  if (!multi && parts[0]?.name === name) for (const old of previous) if (old.name !== name) store.remove(old.name);
  bus.emit('assets.changed', {});
}

/**
 * Export notes each shown once: a model's notes (from its last export) that its earlier exports didn't
 * already tell, remembered in `seen` (which the caller keeps per model).
 */
export function freshNotes(all: unknown, seen: Set<string>): { notes: string[]; seen: Set<string> } {
  const list = Array.isArray(all) ? all.filter((n): n is string => typeof n === 'string') : [];
  return { notes: list.filter((n) => !seen.has(n)), seen: new Set(list) };
}

/**
 * A rigged model's clips (models/<Model>.clips.json, from Kiln's animation) become project animations:
 * added, updated when Kiln changed them, removed when Kiln no longer has them.
 */
export function recordClips(root: string, name: string, bus: EventBus): ClipImport {
  const r = importKilnClips(root, name);
  // world/Animations.luau follows the clips — and the rig their poses nest along, which can change while the clips don't.
  const builderChanged = new AnimationStore(root).refreshBuilder();
  // The files are current; the place (Studio) is not until the animations are built again: `stale` asks for that.
  if (r.added.length || r.updated.length || r.removed.length || builderChanged) bus.emit('animations.changed', { stale: true });
  return r;
}
