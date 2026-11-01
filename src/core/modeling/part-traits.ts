/**
 * How an exported part is set up when it becomes a MeshPart in Studio, beyond its mesh, size, colour and
 * material: the traits the Luau Shuriken generates applies (world/Models.luau, model_place). Decided here, in
 * one place, from what the Blender export recorded about the part (modeling/model-store.ts `ModelMeta`):
 * - `doubleSided`: the export found an open or paper-thin mesh (or a flat one facing down): Roblox draws a face
 *   only from its front, so it would disappear seen from behind. MeshPart.DoubleSided draws both sides.
 * - `role`: what the part is for (the object's custom property `kiln_role`, or a guess from its name or material):
 *   drivable and ground surfaces collide exactly (PreciseConvexDecomposition: Roblox's default hull put grass 9.7
 *   studs above a road), decor (leaves, grass tufts, haze) collides with nothing and can't be hit by raycasts and
 *   casts a shadow only when it is big, a barrier collides as a box (a part that is exactly one) or a hull when it
 *   fills its box, else precisely, and a collider is invisible collision geometry (kiln_collides_for): the visuals
 *   it stands in for (`replaced`) don't collide at all.
 * - `transparency`: the part's Transparency (glass; an invisible collider is 1).
 */

export type PartRole = 'drivable' | 'ground' | 'barrier' | 'decor' | 'collider';
export const PART_ROLES: readonly PartRole[] = ['drivable', 'ground', 'barrier', 'decor', 'collider'];

/** Decor at least this long (studs) on its longest side still casts a shadow (a tree's crown does, a grass tuft doesn't). */
export const SHADOW_MIN_STUDS = 10;
/** A closed barrier that fills at least this share of its box collides as a hull (a bounded stand-in); a thinner or curved one precisely. */
export const HULL_MIN_FILL = 0.75;

/** The part of a ModelMeta the traits depend on. */
export interface TraitSource {
  doubleSided?: boolean;
  role?: PartRole;
  replaced?: boolean;
  /** The mesh is exactly an axis-aligned box (in its own frame). */
  box?: boolean;
  /** The share of its box a closed mesh fills (0-1). */
  fill?: number;
  transparency?: number;
  size?: [number, number, number];
}

export type Fidelity = 'Box' | 'Hull' | 'PreciseConvexDecomposition';

/** What the generated Luau sets on a part (short keys: the rows of world/Models.luau carry one table per part). */
export interface PartFx {
  /** CanCollide, CanQuery, CanTouch. */
  cc?: boolean;
  cq?: boolean;
  ct?: boolean;
  /** CastShadow. */
  sh?: boolean;
  /** CollisionFidelity (guarded). */
  fid?: Fidelity;
  /** MeshPart.DoubleSided (guarded: older Studios without the property still build). */
  ds?: true;
  /** Transparency. */
  tr?: number;
}

/** The collision fidelity a part of this role gets (undefined: Roblox's default). */
export function fidelityOf(m: TraitSource): Fidelity | undefined {
  switch (m.role) {
    case 'drivable':
    case 'ground':
      return 'PreciseConvexDecomposition';
    case 'collider':
      return m.box ? 'Box' : 'PreciseConvexDecomposition';
    case 'barrier':
      return m.box ? 'Box' : (m.fill ?? 0) >= HULL_MIN_FILL ? 'Hull' : 'PreciseConvexDecomposition';
    default:
      return undefined;
  }
}

/** The traits of a part, or null when it has none (the part keeps Roblox's defaults). */
export function partFx(m: TraitSource): PartFx | null {
  const fx: PartFx = {};
  const role = m.role;
  if (role === 'decor' || m.replaced) {
    // Nothing collides with it and no raycast or touch hits it (a vehicle drives through the leaves, not over them).
    fx.cc = false;
    fx.cq = false;
    fx.ct = false;
    if (role === 'decor') fx.sh = Math.max(...(m.size ?? [0, 0, 0])) >= SHADOW_MIN_STUDS;
  } else if (role === 'drivable' || role === 'ground' || role === 'barrier') {
    fx.cc = true;
    fx.cq = true;
  } else if (role === 'collider') {
    // Invisible geometry that collides and can be raycast: what the visuals it stands in for don't do any more.
    fx.cc = true;
    fx.cq = true;
    fx.ct = true;
    fx.sh = false;
  }
  const fid = m.replaced || role === 'decor' ? undefined : fidelityOf(m);
  if (fid) fx.fid = fid;
  if (m.doubleSided) fx.ds = true;
  const tr = role === 'collider' ? 1 : m.transparency;
  if (tr) fx.tr = tr;
  return Object.keys(fx).length ? fx : null;
}

/** A Luau table literal of the traits ("{cc=false,sh=true}"), or "nil". */
export function fxTable(fx: PartFx | null): string {
  if (!fx) return 'nil';
  return `{${Object.entries(fx)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join(',')}}`;
}

/**
 * Luau: applyFx(mp, fx) sets a part's traits (see PartFx). CollisionFidelity and DoubleSided are set through pcall: a
 * Studio without them (or one that won't let a plugin set them) still builds the model, with Roblox's defaults.
 */
export const FX_FN = `local function applyFx(mp, fx)
  if not fx then return end
  if fx.cc ~= nil then mp.CanCollide = fx.cc end
  if fx.cq ~= nil then mp.CanQuery = fx.cq end
  if fx.ct ~= nil then mp.CanTouch = fx.ct end
  if fx.sh ~= nil then mp.CastShadow = fx.sh end
  if fx.tr then mp.Transparency = fx.tr end
  if fx.fid then pcall(function() mp.CollisionFidelity = Enum.CollisionFidelity[fx.fid] end) end
  if fx.ds then pcall(function() mp.DoubleSided = true end) end
end`;

/**
 * What Roblox's front-faces-only drawing means for a model's parts, in words for the check tools (blender_check,
 * model_view): the flat meshes whose faces point down (invisible from above), and the parts drawn double-sided
 * because the export found them open or paper-thin. Empty when there is nothing to say.
 */
export function formatFaces(parts: Array<{ name: string; doubleSided?: boolean; facesDown?: string[] }>): string {
  const down = [...new Set(parts.flatMap((p) => p.facesDown ?? []))];
  const both = parts.filter((p) => p.doubleSided).map((p) => p.name);
  const lines: string[] = [];
  if (down.length)
    lines.push(
      `Faces Roblox can't see: ${down.slice(0, 8).join(', ')}${down.length > 8 ? ` (+${down.length - 8} more)` : ''} ${down.length === 1 ? 'is a flat mesh whose faces point' : 'are flat meshes whose faces point'} down (normals toward -Z). Roblox draws a face only from its front, so from above ${down.length === 1 ? 'it is' : 'they are'} invisible (a road that vanishes). Flip the normals so they point up (bmesh.ops.reverse_faces); until then ${down.length === 1 ? 'it is' : 'they are'} drawn double-sided.`,
    );
  if (both.length) lines.push(`Drawn double-sided (open or paper-thin meshes, which Roblox would draw from their front only: MeshPart.DoubleSided is set on them): ${both.slice(0, 10).join(', ')}${both.length > 10 ? ` (+${both.length - 10} more)` : ''}.`);
  return lines.join('\n');
}
