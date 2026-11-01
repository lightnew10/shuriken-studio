import { VIEWER_HUGE, type V3 } from '@shared/viewer';

/** What the camera framing needs of a part: where it is drawn, how big, and whether it counts. */
export interface FramePart {
  cls: string;
  name: string;
  /** Folder path under Workspace ("Map/StartGrid"). */
  parent?: string;
  pos: V3;
  /** The size it is drawn at. */
  size: V3;
  transparency: number;
  /** Drawn only as a faint wire box (a stand-in too big to trust): says nothing about where the map is. */
  ghost?: boolean;
}

export interface Box {
  min: V3;
  max: V3;
}

export interface Framing {
  target: V3;
  /** Studs the view should take in around the target. */
  radius: number;
  kind: 'startgrid' | 'spawn' | 'content';
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
};

const median = (values: number[]): number => quantile([...values].sort((a, b) => a - b), 0.5);

/**
 * The parts that tell where the map is: drawn solid, visible, and not a primitive wider than the backdrop
 * limit (a baseplate, a water slab, a sky box) — those span the world whatever is built on them. Meshes of any
 * size stay: a 1,500-stud circuit is the map.
 */
export function contentParts(parts: FramePart[]): FramePart[] {
  return parts.filter((p) => !p.ghost && p.transparency < 0.95 && !(p.cls !== 'MeshPart' && p.cls !== 'UnionOperation' && Math.max(p.size[0], p.size[2]) >= VIEWER_HUGE));
}

/**
 * The robust bounding box of the content: the 5th to 95th percentile of the parts' centres on each axis
 * (a few far props or a lone spawn don't stretch it), widened by a typical part's half size. Null when
 * nothing counts.
 */
export function contentBox(parts: FramePart[]): Box | null {
  const c = contentParts(parts);
  if (!c.length) return null;
  const trim = c.length >= 40 ? 0.05 : c.length >= 10 ? 0.02 : 0;
  const lo: number[] = [];
  const hi: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const centres = c.map((p) => p.pos[axis]!).sort((a, b) => a - b);
    const margin = Math.min(150, Math.max(2, median(c.map((p) => Math.abs(p.size[axis]!) / 2))));
    lo.push(quantile(centres, trim) - margin);
    hi.push(quantile(centres, 1 - trim) + margin);
  }
  return { min: lo as V3, max: hi as V3 };
}

const GRID = /(^|\/)startgrid(\/|$)/i;

/**
 * Where the camera should look at the first load: the place's StartGrid (the parts named so or inside a folder
 * named so), else its SpawnLocation, as long as it lies within the content (a default spawn left far from the
 * build must not pull the view off it); else the content's robust box. Stand-in slabs never count.
 */
export function frameScene(parts: FramePart[]): Framing | null {
  const box = contentBox(parts);
  const size: V3 = box ? [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]] : [0, 0, 0];
  const contentRadius = Math.hypot(size[0], size[2]) / 2;
  const anchors = (list: FramePart[]) => {
    if (!list.length) return null;
    const near = box
      ? list.filter((p) => {
          const m = Math.max(50, 0.15 * Math.max(size[0], size[2]));
          return p.pos[0] >= box.min[0] - m && p.pos[0] <= box.max[0] + m && p.pos[2] >= box.min[2] - m && p.pos[2] <= box.max[2] + m;
        })
      : list;
    return near.length ? near : null;
  };
  const candidates: Array<[Framing['kind'], FramePart[] | null]> = [
    ['startgrid', anchors(parts.filter((p) => GRID.test(`${p.parent ?? ''}/${p.name}`)))],
    ['spawn', anchors(parts.filter((p) => p.cls === 'SpawnLocation' && !p.ghost))],
  ];
  for (const [kind, found] of candidates) {
    if (!found) continue;
    const target: V3 = [median(found.map((p) => p.pos[0])), median(found.map((p) => p.pos[1])), median(found.map((p) => p.pos[2]))];
    const spread = Math.max(0, ...found.map((p) => Math.hypot(p.pos[0] - target[0], p.pos[2] - target[2]) + Math.max(p.size[0], p.size[2]) / 2));
    // About the neighbourhood a driver or a player sees from there, not the whole map.
    const radius = Math.max(spread * 1.1, Math.min(160, Math.max(60, contentRadius * 0.15)));
    return { target, radius, kind };
  }
  if (!box) return null;
  const centre: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  // Look at the lower-middle of the build (where players stand), not the top of its tallest spire.
  const ys = contentParts(parts).map((p) => p.pos[1]).sort((a, b) => a - b);
  centre[1] = Math.min(centre[1], quantile(ys, 0.4) + 4);
  return { target: centre, radius: Math.max(24, contentRadius, size[1] * 0.45), kind: 'content' };
}

/**
 * The ground the terrain should be sampled over: the content box with room around it, at least ±256 studs
 * about the origin (as before) and at most `cap` studs across so a stretched backdrop can't thin the sample.
 */
export function terrainExtent(parts: FramePart[], pad = 64, cap = 3000): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const box = contentBox(parts);
  let minX = Math.min(-256, box ? box.min[0] : 0) - pad;
  let maxX = Math.max(256, box ? box.max[0] : 0) + pad;
  let minZ = Math.min(-256, box ? box.min[2] : 0) - pad;
  let maxZ = Math.max(256, box ? box.max[2] : 0) + pad;
  const clamp = (lo: number, hi: number): [number, number] => {
    if (hi - lo <= cap) return [lo, hi];
    const mid = (lo + hi) / 2;
    return [mid - cap / 2, mid + cap / 2];
  };
  [minX, maxX] = clamp(minX, maxX);
  [minZ, maxZ] = clamp(minZ, maxZ);
  return { minX, maxX, minZ, maxZ };
}
