import { PART_FLAG, hasFlag, type V3 } from '@shared/viewer';
import type { SceneLighting, ScenePart } from './engine';

/** A page of `viewer.parts` (rows: see LUAU_VIEW_PARTS in core/roblox/luau-snippets.ts). */
export interface PartsPage {
  total: number;
  count: number;
  next?: number | null;
  classes: string[];
  materials: string[];
  /** Folder/model paths under Workspace that rows point to (older cores don't send them). */
  parents?: string[];
  rows: string;
  lighting?: SceneLighting;
  camera?: { pos: V3; look: V3 };
  /** Which place was read: Edit, or the running game's server during a playtest. */
  source?: 'Edit' | 'Server';
}

const triple = (text: string | undefined, at: number): V3 | null => {
  if (!text) return null;
  const f = text.split('|').map(Number);
  if (f.length < at + 3 || f.slice(at, at + 3).some((x) => !Number.isFinite(x))) return null;
  return [f[at]!, f[at + 1]!, f[at + 2]!];
};

export function parseRows(page: PartsPage): ScenePart[] {
  if (!page.rows) return [];
  return page.rows.split(';').map((row) => {
    const f = row.split(',');
    const n = (i: number) => Number(f[i]);
    const flags = Number(f[19]) || 0;
    // "sx|sy|sz|ox|oy|oz": a Part drawn through a SpecialMesh FileMesh (its Scale and Offset).
    const scale = hasFlag(flags, PART_FLAG.fileMesh) ? triple(f[20], 0) : null;
    return {
      cls: page.classes[n(0)] ?? 'Part',
      shape: f[1] ?? '',
      pos: [n(2), n(3), n(4)],
      size: [n(5), n(6), n(7)],
      rot: [n(8), n(9), n(10)],
      color: f[11] ?? 'a3a2a5',
      material: page.materials[n(12)] ?? 'Plastic',
      transparency: n(13),
      name: f[14] ?? '',
      textured: f[15] === '1',
      reflectance: n(16) || 0,
      model: f[17] || undefined,
      parent: f[18] != null && f[18] !== '' ? (page.parents?.[n(18)] ?? '') : '',
      flags,
      fileMesh: scale ? { scale, offset: triple(f[20], 3) ?? [0, 0, 0] } : undefined,
    } satisfies ScenePart;
  });
}
