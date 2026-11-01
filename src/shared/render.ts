import type { AnimationClip } from './animation';
import type { RigSpec } from './rig';
import type { IconView } from './icon';

/**
 * A picture for an agent that can't look at a 3D viewer, drawn by the app's hidden render page with
 * the same views the user sees: a model beside a Roblox character, or an animation's filmstrip on the
 * R15 mannequin. The core asks for one; the app answers with a JPEG data: URL (or null). An `icon` is a
 * picture FOR THE GAME: one model on a transparent background with an outline, as a PNG.
 */
export type RenderRequest =
  | { kind: 'model'; /** One model, or every part of an assembly placed at its origin. */ parts: RenderPart[]; name?: string }
  | { kind: 'animation'; clip: AnimationClip; name?: string; sword?: false | 'left' | 'right'; /** Frames on the strip (default 8). */ frames?: number }
  | { kind: 'icon'; /** A UI icon of a model (or an assembly's parts at their origins). */ parts: RenderPart[]; view?: IconView; outline?: boolean; /** Pixels on a side (512). */ size?: number }
  | { kind: 'rig-animation'; /** A clip for a custom rig, drawn on the rigged model itself (its parts moved by their segments). */ clip: AnimationClip; rig: RigSpec; parts: RenderPart[]; name?: string; frames?: number };

/** A model (or one part of an assembly) to draw: its mesh and how it looks. */
export interface RenderPart {
  /** GLB bytes, base64 */
  glb: string;
  /** Hex colour and Enum.Material name (Neon glows, Metal shines, Glass is see-through). */
  color?: string;
  material?: string;
  /** Where its centre sits in its assembly (Y-up studs). */
  origin?: [number, number, number];
  /** A mesh used many times (the part is drawn once per use, at its position, turned and scaled); `origin` is then ignored. */
  instances?: RenderInstance[];
  /** A rigged model's part: the segment (joint) it moves with. */
  segment?: string;
}

/** The box an assembly fills: each part's box (its origin ± half its size), together. */
export function assembledSize(parts: Array<{ size: [number, number, number]; origin?: [number, number, number]; instances?: RenderInstance[] }>): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    // An instanced mesh fills the boxes of all its uses (each turned and scaled), not just one box at its origin.
    const uses = p.instances?.length ? p.instances : [null];
    for (const u of uses) {
      const centre = u ? u.position : (p.origin ?? [0, 0, 0]);
      const reach = u ? instanceReach(p.size, u) : (p.size.map((v) => v / 2) as [number, number, number]);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, centre[i]! - reach[i]!);
        hi[i] = Math.max(hi[i]!, centre[i]! + reach[i]!);
      }
    }
  }
  return [0, 1, 2].map((i) => Math.max(0, hi[i]! - lo[i]!)) as [number, number, number];
}

/** One use of an instanced mesh (see ModelInstance in core/modeling/backend.ts): its centre, orientation (degrees, Y X Z) and scale. */
export interface RenderInstance {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** Half the extent, along each world axis, of a use of a mesh of the given size: the box turned (Y, X, Z order) and scaled. */
export function instanceReach(size: [number, number, number], u: RenderInstance): [number, number, number] {
  const [rx, ry, rz] = u.rotation.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // R = Ry * Rx * Rz (CFrame.fromOrientation)
  const R = [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ];
  const half = [0, 1, 2].map((i) => (size[i]! * u.scale[i]!) / 2);
  return [0, 1, 2].map((r) => Math.abs(R[r]![0]!) * half[0]! + Math.abs(R[r]![1]!) * half[1]! + Math.abs(R[r]![2]!) * half[2]!) as [number, number, number];
}

/**
 * When a filmstrip's frames fall: evenly across the clip, with the frame nearest each marker (a "Hit")
 * moved onto it, so the moments gameplay hangs on are always shown.
 */
export function filmstripTimes(duration: number, markers: Array<{ t: number }>, frames = 8): number[] {
  const n = Math.max(2, Math.min(16, frames));
  const times = Array.from({ length: n }, (_, i) => (duration * i) / (n - 1));
  for (const m of markers) {
    if (m.t < 0 || m.t > duration) continue;
    let best = -1;
    for (let i = 0; i < n; i++) if (!markers.some((x) => x.t === times[i]) && (best < 0 || Math.abs(times[i]! - m.t) < Math.abs(times[best]! - m.t))) best = i;
    if (best >= 0) times[best] = m.t;
  }
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}
