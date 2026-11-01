import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BlenderBridge, findBlender } from '../../src/core/blender/bridge';

/**
 * A real headless Blender running Shuriken's bridge, for tests of the Roblox export (roblox_export.py):
 * build a scene with Python (the kiln helpers are loaded), export it, read what was written. No Core, no
 * project: the export's own files go into a temporary folder. Skipped (blender is null) where Blender isn't installed.
 */
export const blender = findBlender(process.env.SHURIKEN_BLENDER || null);

/** One exported part as roblox_export.export returns it (a loose shape: tests check the fields they need). */
export interface ExportPart {
  name: string;
  blender_material: string | null;
  color: string;
  material: string;
  transparency: number;
  origin: [number, number, number];
  size: [number, number, number];
  triangles: number;
  vertices: number;
  piece?: [number, number];
  tile?: [number, number, number];
  role?: string;
  roleInferred?: boolean;
  replaced?: boolean;
  doubleSided?: boolean;
  facesDown?: string[];
  fill?: number;
  textures?: Record<string, string>;
  instances?: Array<{ position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }>;
  [key: string]: unknown;
}

export interface ExportReply {
  ok: boolean;
  error?: string | null;
  parts: ExportPart[];
  tris: number;
  size: [number, number, number];
  notes?: string[];
  [key: string]: unknown;
}

export interface MeshJson {
  v: number[];
  n: number[];
  t: number[];
  uv?: number[];
}

export class ExportHarness {
  readonly dir = mkdtempSync(join(tmpdir(), 'shuriken-export-'));
  private readonly bridge: BlenderBridge;

  constructor(exe: string = blender!) {
    this.bridge = new BlenderBridge(exe, resolve(__dirname, '..', '..', 'resources', 'blender', 'bridge.py'));
  }

  /** Runs Python in the scene (a new empty scene first when `fresh`); throws with Blender's message when it fails. */
  async python(code: string, fresh = true): Promise<string> {
    if (fresh) {
      const n = await this.bridge.call('new', {}, 60_000);
      if (!n.ok) throw new Error(`new scene: ${n.error}`);
    }
    const r = await this.bridge.call('exec', { code }, 180_000);
    if (!r.ok) throw new Error(`${r.error}\n${r.output}`);
    return String(r.output ?? '');
  }

  /** The Roblox export of the scene as it is (the bridge's "roblox" op). */
  async export(name: string): Promise<ExportReply> {
    const r = await this.bridge.call('roblox', { dir: this.dir, name }, 300_000);
    if (!r.ok) throw new Error(`export: ${r.error}`);
    return r as unknown as ExportReply;
  }

  mesh(part: string): MeshJson {
    return JSON.parse(readFileSync(join(this.dir, `${part}.mesh.json`), 'utf8')) as MeshJson;
  }

  has(file: string): boolean {
    return existsSync(join(this.dir, file));
  }

  stop(): void {
    this.bridge.stop();
  }
}

/** Triangle surface area of a mesh JSON (studs²), optionally the signed part facing +Y only. */
export function meshArea(m: MeshJson): number {
  let a = 0;
  for (let i = 0; i < m.t.length; i += 3) {
    const [p, q, r] = [m.t[i]!, m.t[i + 1]!, m.t[i + 2]!].map((k) => [m.v[k * 3]!, m.v[k * 3 + 1]!, m.v[k * 3 + 2]!]) as [number[], number[], number[]];
    const u = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!];
    const w = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!];
    const c = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    a += Math.hypot(c[0]!, c[1]!, c[2]!) / 2;
  }
  return a;
}
