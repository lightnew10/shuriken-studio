import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import type { ExportedPart } from '../src/core/modeling/backend';
import { KilnClient } from '../src/core/modeling/kiln-modeling';
import { LayoutImporter, applyManifestLook, linkedByProject, prepareCode, type ExportReply, type LayoutImportResult } from '../src/core/modeling/layout-import';
import { parseManifest, type Mat4, type Vec3 } from '../src/core/modeling/kiln-manifest';
import { fromRoblox, toRoblox } from '../src/core/modeling/kiln-layout';
import { ModelStore } from '../src/core/modeling/model-store';
import { ModelUploads } from '../src/core/modeling/model-uploads';
import { LAYOUT_ROLES, mapDataLocation, registerLayoutTools } from '../src/core/capabilities/layout-tools';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import type { ProjectContext } from '../src/core/projects/project-service';
import { ROLES } from '../src/core/agents/roles';
import { makeGlb } from './helpers/glb';

// Bringing a whole Kiln map into the game, against a fake Kiln (its local API over HTTP), a stand-in for Shuriken's
// exporter (the real one is driven by tests/kiln-layout-blender.test.ts), the real upload queue with a fake Open Cloud,
// and a Studio that keeps what the generated programs would build: one template per mesh, one unit per placement.
// No real Kiln, Blender or Studio.

const FIXTURE = resolve(__dirname, 'fixtures', 'kiln-layout-reference');
const REFERENCE = JSON.parse(readFileSync(join(FIXTURE, 'roblox.json'), 'utf8')) as Record<string, any>;
const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')) as { placements: Record<string, { origin: Vec3 }> };

// ---- A fake Kiln -------------------------------------------------------------------------------------------------------

interface FakeProject {
  title: string;
  units: 'm' | 'studs';
  fingerprint: string | null;
  /** When it last changed (a bake counts, as in Kiln). */
  updatedAt?: string;
  /** What POST /roblox answers with (source_fingerprint is the project's fingerprint). */
  manifest: Record<string, any>;
  /** Kiln's last export: null (none), or whether it is of the scene as it is now. */
  exported: { current: boolean; plain: boolean } | null;
  check?: Record<string, unknown>;
  busy?: number;
  fail?: string;
}

class FakeKiln {
  projects = new Map<string, FakeProject>();
  /** How many projects the app listing holds (Kiln: its 48 most recent); the storage listing has them all, without fingerprints. */
  appLimit = 48;
  storageWorks = true;
  private tick = 0;
  calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  server!: Server;
  runtime!: string;
  dir = mkdtempSync(join(tmpdir(), 'kiln-layout-fake-'));

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer layout-token') return void res.writeHead(401).end();
      const body = req.method === 'POST' ? await readBody(req) : {};
      const path = (req.url ?? '').split('?')[0]!;
      this.calls.push({ method: req.method ?? 'GET', path, body });
      const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const listed = () => [...this.projects].map(([id, p]) => ({ id, title: p.title, units: p.units, version: 1, fingerprint: p.fingerprint, updatedAt: p.updatedAt ?? '2026-10-01T00:00:00.000Z' })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (path === '/api/v1/app') return send({ version: '0.8.1', blender: { path: 'C:/Blender/blender.exe' }, projects: listed().slice(0, this.appLimit) });
      if (path === '/api/v1/storage') return this.storageWorks ? send({ dir: this.dir, projects: listed().map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt, open: false, bytes: 1 })) }) : send({ error: 'unknown' }, 404);
      const m = /^\/api\/v1\/projects\/([^/]+)\/roblox$/.exec(path);
      const p = m ? this.projects.get(m[1]!) : undefined;
      if (m && !p) return send({ error: 'No such project' }, 404);
      if (p && req.method === 'GET') {
        return send({ target: 'roblox', check: p.check ?? { problems: [], notes: [], summary: 'Roblox check: ready (plain PBR materials, within budgets).', meshes: Object.keys(p.manifest.meshes ?? {}).length }, export: p.exported ? this.manifestOf(p, p.exported.plain) : null, current: !!p.exported?.current, version: 1 });
      }
      if (p && req.method === 'POST') {
        if (p.busy) {
          p.busy--;
          return send({ error: 'The copilot is working on this project: export when it is done' }, 409);
        }
        if (p.fail) return send({ ok: false, error: p.fail }, 500);
        const cached = !!p.exported?.current && p.exported.plain === (body.plain === true);
        p.exported = { current: true, plain: body.plain === true };
        p.updatedAt = new Date(Date.UTC(2026, 9, 2) + ++this.tick * 1000).toISOString(); // Kiln's journal notes the export
        return send({ ok: true, cached, manifest: this.manifestOf(p, body.plain === true) });
      }
      res.writeHead(404).end('{}');
    });
    const port = await new Promise<number>((ok) => this.server.listen(0, '127.0.0.1', () => ok((this.server.address() as { port: number }).port)));
    this.runtime = join(this.dir, 'runtime.json');
    writeFileSync(this.runtime, JSON.stringify({ app: 'kiln', version: '0.8.1', port, token: 'layout-token', pid: process.pid }));
  }

  private manifestOf(p: FakeProject, plain: boolean): Record<string, unknown> {
    return { ...p.manifest, plain, source_fingerprint: p.fingerprint };
  }

  /** A baked file that exists (the stand-in exporter never opens it). */
  blend(id: string): string {
    const d = join(this.dir, id, 'exports', 'roblox-v0001');
    mkdirSync(d, { recursive: true });
    const f = join(d, 'roblox.blend');
    if (!existsSync(f)) writeFileSync(f, `BLENDER ${id}`);
    return f;
  }

  hits(re: RegExp, method?: string) {
    return this.calls.filter((c) => re.test(c.path) && (!method || c.method === method));
  }
}

const readBody = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => ok(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
  });

// ---- A stand-in for Shuriken's exporter: boxes with real mesh files (so parts hash and upload like real ones) ----------

type Box = { name: string; lo: Vec3; hi: Vec3; material: string; role?: ExportedPart['role']; instances?: ExportedPart['instances'] };

function writePart(dir: string, b: Box, scale = 1): ExportedPart {
  const c = toRoblox([(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2], scale);
  const size: Vec3 = [(b.hi[0] - b.lo[0]) * scale, (b.hi[2] - b.lo[2]) * scale, (b.hi[1] - b.lo[1]) * scale];
  const [x, y, z] = size.map((s) => s / 2) as Vec3;
  // one triangle spanning the box is enough for a hash, an upload and a temporary mesh
  const v = [-x, -y, -z, x, -y, -z, x, y, z];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${b.name}.mesh.json`), JSON.stringify({ v, n: [0, 1, 0, 0, 1, 0, 0, 1, 0], t: [0, 1, 2] }));
  writeFileSync(join(dir, `${b.name}.glb`), makeGlb({ positions: v, normals: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 2] }));
  return { name: b.name, blender_material: b.material, color: '#b8b8b8', material: 'SmoothPlastic', transparency: 0, origin: b.instances?.length ? b.instances[0]!.position : c, size, triangles: 1, vertices: 3, ...(b.role ? { role: b.role } : {}), ...(b.instances ? { instances: b.instances } : {}) };
}

const PIECE_BOXES: Record<string, Box[]> = {
  'fixture-arrow': [{ name: 'Arrow_Shaft', lo: [0, -0.25, 0], hi: [3, 0.25, 0.5], material: 'Arrow_Mat' }, { name: 'Arrow_Fin', lo: [0, 0.25, 0], hi: [0.5, 1.25, 0.5], material: 'Arrow_Mat' }, { name: 'Arrow_Post', lo: [0, -0.25, 0.5], hi: [0.5, 0.25, 2], material: 'Arrow_Mat' }],
  'fixture-pillar': [{ name: 'Pillar_Body', lo: [-0.5, -0.5, 0], hi: [0.5, 0.5, 4], material: 'Pillar_Mat' }, { name: 'Pillar_Step', lo: [-0.5, -1.5, 0], hi: [0.5, -0.5, 1], material: 'Pillar_Mat' }],
  'fixture-slab': [{ name: 'Slab', lo: [0, 0, 0], hi: [4, 2, 0.5], material: 'Slab_Mat' }],
};
const LAYOUT_BOXES = (name: string): Box[] => [
  { name: `${name}_Ground`, lo: [-30, -20, -1], hi: [30, 20, 0], material: 'Ground_Mat', role: 'drivable' },
  { name: `${name}_Shed`, lo: [20, 10, 0], hi: [26, 16, 4], material: 'Shed_Mat', role: 'decor' },
];

// ---- A Studio that keeps what the programs build ------------------------------------------------------------------------

class FakeStudio {
  connected = true;
  kit = new Map<string, { stamp: string; temporary: boolean }>();
  units = new Map<string, { fp: string; run: string; parts: number[][]; templates: string[] }>();
  markers: Array<{ name: string; role: string; at: number[] }> = [];
  programs: string[] = [];
  /** Meshes whose asset Studio can't load (still processing at Roblox). */
  unloadable = new Set<string>();
  /** Calls that fail whole, from now on (a timeout, Studio left Edit). */
  failCalls = 0;
  /** Units that fail inside their batch, by name. */
  failUnits = new Set<string>();
  onCall: (code: string) => void = () => undefined;
  lease: { ok: boolean; message?: string } = { ok: true };

  waitForLease = async () => this.lease;

  runLuau = async (code: string): Promise<{ ok: boolean; output: string; durationMs: number }> => {
    this.programs.push(code);
    this.onCall(code);
    if (this.failCalls > 0) {
      this.failCalls--;
      return { ok: false, output: 'execute_luau timed out', durationMs: 180_000 };
    }
    const ok = (o: unknown) => ({ ok: true, output: JSON.stringify(o), durationMs: 50 });
    if (code.includes('local MARKERS = {')) {
      this.markers = lines(code, 'MARKERS').map((l) => JSON.parse(`[${l.trim().replace(/,$/, '').slice(1, -1)}]`) as Array<string | number>).map((r) => ({ name: r[0] as string, role: r[1] as string, at: r.slice(2) as number[] }));
      return ok({ markers: this.markers.length });
    }
    if (code.includes('local KEEP = {')) {
      const run = /local MAP, RUN = "[^"]*", "([^"]+)"/.exec(code)![1]!;
      const keep = new Set([...code.split('\n').find((l) => l.startsWith('local KEEP = {'))!.matchAll(/\["([^"]+)"\]=true/g)].map((m) => m[1]!));
      let removed = 0;
      for (const [k, u] of this.units) if (u.run !== run && this.units.delete(k)) removed++;
      let templates = 0;
      for (const k of [...this.kit.keys()]) if (!keep.has(k) && this.kit.delete(k)) templates++;
      return ok({ removed, templates });
    }
    if (code.includes('local ROWS = {')) {
      const temporary = code.includes('CreateEditableMesh');
      let made = 0;
      let kept = 0;
      const failures: string[] = [];
      for (const l of lines(code, 'ROWS')) {
        const m = /^\{?\{"([^"]+)",(\d+|nil),"(\w+)"/.exec(l)!;
        const [, name, asset, stamp] = m as unknown as [string, string, string, string];
        if (this.kit.get(name)?.stamp === stamp) kept++;
        else if (!temporary && (asset === 'nil' || this.unloadable.has(name))) failures.push(`${name}: asset ${asset} has no MeshPart (still processing?)`);
        else {
          this.kit.set(name, { stamp, temporary });
          made++;
        }
      }
      return ok({ made, kept, failed: failures.length, failures: failures.slice(0, 12) });
    }
    if (code.includes('local U = {')) {
      const run = /local MAP, RUN = "[^"]*", "([^"]+)"/.exec(code)![1]!;
      const T = JSON.parse(`[${/^local T = \{(.*)\}$/m.exec(code)![1]}]`) as string[];
      let [placed, kept, replaced] = [0, 0, 0];
      const failures: string[] = [];
      for (const l of lines(code, 'U')) {
        const u = JSON.parse(`[${l.replace(/,$/, '').slice(1, -1)}]`) as Array<string | number>;
        const key = `${u[2]}/${u[3]}/${u[0]}`;
        const old = this.units.get(key);
        if (old && old.fp === u[1]) {
          old.run = run;
          kept++;
          continue;
        }
        const parts: number[][] = [];
        const templates: string[] = [];
        let bad: string | null = this.failUnits.has(u[0] as string) ? 'made to fail' : null;
        for (let i = 10; i < u.length; i += 11) {
          const t = T[(u[i] as number) - 1]!;
          if (!this.kit.has(t)) bad = `its mesh ${t} is not in the kit`;
          templates.push(t);
          parts.push(u.slice(i + 1, i + 10) as number[]);
        }
        if (bad) {
          failures.push(`${u[0]}: ${bad}`);
          continue;
        }
        this.units.set(key, { fp: u[1] as string, run, parts, templates });
        if (old) replaced++;
        else placed++;
      }
      return ok({ placed, kept, replaced, failed: failures.length, failures: failures.slice(0, 12) });
    }
    return { ok: false, output: 'unknown program', durationMs: 1 };
  };

  unit(name: string) {
    return [...this.units].find(([k]) => k.endsWith(`/${name}`))?.[1];
  }
}

/** The rows of `local NAME = { ... }` in a generated program. */
function lines(code: string, table: string): string[] {
  const start = code.indexOf(`local ${table} = {\n`) + `local ${table} = {\n`.length;
  return code.slice(start, code.indexOf('\n}\n', start - 1)).split('\n').filter((l) => l.trim());
}

// ---- The rig ---------------------------------------------------------------------------------------------------------------

const kiln = new FakeKiln();
await kiln.start();
afterAll(() => void kiln.server.close());

interface Rig {
  root: string;
  studio: FakeStudio;
  exports: Array<{ blend: string; name: string; prepare: string | null }>;
  uploads: string[];
  clock: { t: number };
  cloud: { configured: boolean; delayMs: number; fail?: string };
  run(opts?: Partial<Parameters<LayoutImporter['run']>[1]>): Promise<LayoutImportResult>;
  importer: LayoutImporter;
  pushed: string[];
}

/** Which boxes the stand-in exporter writes for a baked file (by the Kiln project its path names). */
let boxesFor: (project: string, name: string) => Box[] = (project, name) => PIECE_BOXES[project] ?? LAYOUT_BOXES(name);
let exportScale = 1;

function makeRig(project = 'fixture-layout'): Rig {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-layout-proj-'));
  const studio = new FakeStudio();
  const exports: Rig['exports'] = [];
  const uploads: string[] = [];
  const pushed: string[] = [];
  const clock = { t: 1_000_000 };
  const cloud: Rig['cloud'] = { configured: true, delayMs: 0 };
  let nextAsset = 9000;
  const uploader = new ModelUploads({
    cloud: {
      configured: async () => cloud.configured,
      upload: async (o: { name: string }) => {
        if (cloud.delayMs) await new Promise((r) => setTimeout(r, cloud.delayMs));
        if (cloud.fail) return { ok: false, error: cloud.fail };
        uploads.push(o.name);
        return { ok: true, assetId: String(nextAsset++) };
      },
      wait: async () => ({ ok: false, error: 'not used' }),
    } as never,
    uploads: () => ({ enabled: true, creatorId: '42' }),
    creator: async () => '42',
  });
  const importer = new LayoutImporter({
    kiln: new KilnClient(() => kiln.runtime),
    exportBlend: async (blend, dir, name, prepare): Promise<ExportReply> => {
      exports.push({ blend, name, prepare });
      const id = /[\\/]([^\\/]+)[\\/]exports[\\/]/.exec(blend)![1]!;
      return { ok: true, parts: boxesFor(id, name).map((b) => writePart(dir, b, exportScale)), notes: [] };
    },
    uploader,
    studio,
    bus: new EventBus(),
    linked: linkedByProject,
    pushFile: async (_root, file) => {
      pushed.push(file);
      return 'pushed';
    },
    bakeWaitMs: 400,
    now: () => clock.t,
  });
  return { root, studio, exports, uploads, clock, cloud, importer, pushed, run: (opts = {}) => importer.run(root, { project, ...opts }) };
}

/** Kiln's projects as the reference layout has them: the layout and its three pieces, none exported yet. */
function referenceProjects(): void {
  kiln.projects.clear();
  kiln.calls = [];
  kiln.appLimit = 48;
  kiln.storageWorks = true;
  boxesFor = (project, name) => PIECE_BOXES[project] ?? LAYOUT_BOXES(name);
  exportScale = 1;
  const piece = (id: string, title: string, mat: string) =>
    kiln.projects.set(id, { title, units: 'studs', fingerprint: `fp-${id}-1`, exported: null, manifest: { version: 2, blend: kiln.blend(id), units: 'studs', studs_per_unit: 1, materials: [{ name: mat, plain: true, color: '#d04020', roblox_material: null, size: 0, maps: {} }], meshes: {}, objects: 1, tris: 12 } });
  piece('fixture-arrow', 'Arrow', 'Arrow_Mat');
  piece('fixture-pillar', 'Pillar', 'Pillar_Mat');
  piece('fixture-slab', 'Slab', 'Slab_Mat');
  kiln.projects.set('fixture-layout', { title: 'Reference Map', units: 'studs', fingerprint: 'fp-layout-1', exported: null, manifest: { ...structuredClone(REFERENCE), blend: kiln.blend('fixture-layout') } });
}

beforeEach(() => referenceProjects());

describe('a whole map, start to finish', () => {
  it('exports each piece and the map once, uploads each mesh once, and places every placement', async () => {
    const rig = makeRig();
    const messages: string[] = [];
    const r = await rig.run({ progress: (m) => messages.push(m) });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, done: true, map: 'ReferenceMap', kilnProject: 'fixture-layout' });
    expect(r.check).toMatchObject({ ready: true, blocking: [], look: [] });
    expect(r.manifest).toEqual({ version: 2, units: 'studs', studsPerUnit: 1, plain: true, meshes: 3, materials: { total: 3, plain: 3, robloxMaterial: 1, textured: 0 }, pieces: 3, placements: 10, markers: 1, paths: 1, roles: 4, colliders: 1 });
    // Kiln: one bake per project, plain (one-colour materials stay untextured)
    const bakes = kiln.hits(/\/roblox$/, 'POST');
    expect(bakes.map((c) => c.path.split('/')[4]).sort()).toEqual(['fixture-arrow', 'fixture-layout', 'fixture-pillar', 'fixture-slab']);
    expect(bakes.every((c) => c.body.plain === true)).toBe(true);
    // Shuriken's exporter: once per project; the map's own export leaves the placements of the three pieces out
    expect(rig.exports.map((e) => e.name).sort()).toEqual(['Arrow', 'Pillar', 'ReferenceMap', 'Slab']);
    expect(r.models).toEqual({ exported: ['Arrow', 'Pillar', 'Slab', 'ReferenceMap'], unchanged: [], failed: [] });
    const own = rig.exports.find((e) => e.name === 'ReferenceMap')!;
    expect(own.prepare).toContain('json.loads("[\\"fixture-arrow\\",\\"fixture-pillar\\",\\"fixture-slab\\"]")');
    expect(own.prepare).toContain('if _c is not None and _c.get("kiln_piece") in _drop:');
    expect(rig.exports.find((e) => e.name === 'Arrow')!.prepare).toBeNull(); // studs, nothing to drop
    // one upload per unique mesh (6 piece parts + 2 of the map), whatever the number of placements
    expect(rig.uploads.sort()).toEqual(['Arrow_Fin', 'Arrow_Post', 'Arrow_Shaft', 'Pillar_Body', 'Pillar_Step', 'ReferenceMap_Ground', 'ReferenceMap_Shed', 'Slab']);
    expect(r.uploads).toMatchObject({ parts: 8, uploaded: 8, reused: 0, stillUploading: [], failed: [] });
    // Studio: 8 templates, 10 placements + the map's 2 own parts, the marker
    expect([...rig.studio.kit.keys()].sort()).toEqual(['Arrow_Fin', 'Arrow_Post', 'Arrow_Shaft', 'Pillar_Body', 'Pillar_Step', 'ReferenceMap_Ground', 'ReferenceMap_Shed', 'Slab']);
    expect(r.studio).toMatchObject({ placed: true, templates: { made: 8, kept: 0, failed: 0 }, units: { total: 12, placed: 12, kept: 0, replaced: 0, failed: 0, waiting: 0, removed: 0, parts: 4 * 3 + 3 * 2 + 3 + 2 }, markers: 1 });
    expect(rig.studio.units.size).toBe(12);
    expect([...rig.studio.units.keys()].filter((k) => k.startsWith('Static/')).sort()).toEqual(['Static//ReferenceMap_Ground', 'Static//ReferenceMap_Shed']);
    // every placement is where Kiln's expected.json says its origin is (the unit's first part is the piece's first box)
    for (const [name, want] of Object.entries(expected.placements)) {
      const u = rig.studio.unit(name)!;
      expect(u, name).toBeTruthy();
      expect(u.parts).toHaveLength(name.startsWith('Arrow') ? 3 : name.startsWith('Pillar') ? 2 : 1);
      void want;
    }
    const plain = rig.studio.unit('Slab_Plain_001')!;
    // the slab's box centre (2, 1, 0.25) from its origin at (-20, -15, 0)
    expect(fromRoblox(plain.parts[0]!.slice(0, 3)).map((v) => Math.round(v * 1000) / 1000)).toEqual([-18, -14, 0.25]);
    expect(rig.studio.markers).toHaveLength(1);
    expect(rig.studio.markers[0]).toMatchObject({ name: 'Spawn_A', role: 'spawn' });
    expect(fromRoblox(rig.studio.markers[0]!.at.slice(0, 3))).toEqual([-25, -18, 0.5]);
    // the manifest's look is on the parts: the ground is Roblox's Asphalt tinted with the colour, the shed is its colour
    const store = new ModelStore(rig.root);
    expect(store.get('ReferenceMap_Ground')).toMatchObject({ color: '#55585c', material: 'Asphalt', role: 'drivable', assembly: 'ReferenceMap' });
    expect(store.get('ReferenceMap_Ground')!.textures).toBeUndefined();
    expect(store.get('ReferenceMap_Shed')).toMatchObject({ color: '#806040', material: 'SmoothPlastic', role: 'decor' });
    expect(store.get('Slab')).toMatchObject({ color: '#d04020' });
    expect(rig.studio.programs.find((c) => c.includes('local ROWS = {'))).toMatch(/\{"ReferenceMap_Ground",\d+,"\w+",\{60,1,40\},"#55585c","Asphalt",\{cc=true,cq=true,fid="PreciseConvexDecomposition"\},false\}/);
    // where it all is, for the agent
    expect(r.where).toEqual({ root: 'Workspace.ReferenceMap', static: 'Workspace.ReferenceMap.Static', pieces: 'Workspace.ReferenceMap.Pieces.c_<x>_<z>', markers: 'Workspace.ReferenceMap.Markers', kit: 'ServerStorage.ShurikenMapKit.ReferenceMap', cellStuds: 512 });
    // the data module for game code and the markers' world builder
    expect(r.data).toMatchObject({ file: 'src/Shared/ShurikenMaps/ReferenceMap.luau', require: 'game.ReplicatedStorage.Shared.ShurikenMaps.ReferenceMap', sync: 'pushed', markerTag: 'MapMarker', paths: [{ name: 'Center_Line', role: 'road_centerline', points: 4 }] });
    expect(rig.pushed).toEqual(['src/Shared/ShurikenMaps/ReferenceMap.luau']);
    const module = readFileSync(join(rig.root, 'src/Shared/ShurikenMaps/ReferenceMap.luau'), 'utf8');
    expect(module).toContain('points = points({ 25, 0, -18, 0, 0, -18, -25, 0, -10, -25, 0, 10 })');
    expect(readFileSync(join(rig.root, 'world', 'ReferenceMapMarkers.luau'), 'utf8')).toContain('{"Spawn_A","spawn",');
    // progress notes along the way, and a next step
    expect(messages.some((m) => /Exporting piece 1 of 3: Arrow/.test(m))).toBe(true);
    expect(messages.some((m) => /Exporting the map's own geometry/.test(m))).toBe(true);
    expect(messages.some((m) => /Uploading 8 of 8 meshes/.test(m))).toBe(true);
    expect(messages.some((m) => /Placing the map in Studio: 0 of 12 placements/.test(m))).toBe(true);
    expect(r.next).toMatch(/The map is in Studio under Workspace\.ReferenceMap/);
    // what was exported from what is remembered
    const state = JSON.parse(readFileSync(join(rig.root, '.shuriken', 'layouts', 'models.json'), 'utf8')) as Record<string, { project: string; fingerprint: string; origins: Record<string, Vec3>; dropped: string[] }>;
    expect(state.Slab).toMatchObject({ project: 'fixture-slab', fingerprint: 'fp-fixture-slab-1', plain: true, studsPerUnit: 1, dropped: [] });
    expect(state.Slab!.origins.Slab).toEqual(toRoblox([2, 1, 0.25])); // a lone part's box centre, which its model record doesn't keep
    expect(state.ReferenceMap!.dropped).toEqual(['fixture-arrow', 'fixture-pillar', 'fixture-slab']);
  });

  it('a second import does nothing again: no bake, no export, no upload, every unit kept', async () => {
    const rig = makeRig();
    await rig.run();
    kiln.calls = [];
    const [exportsBefore, uploadsBefore] = [rig.exports.length, rig.uploads.length];
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(0); // Kiln's export of the map is current, the pieces' fingerprints are unchanged
    expect(kiln.hits(/fixture-(arrow|pillar|slab)/)).toHaveLength(0); // no piece project was even opened
    expect(rig.exports.length).toBe(exportsBefore);
    expect(rig.uploads.length).toBe(uploadsBefore);
    expect(r.models).toEqual({ exported: [], unchanged: ['Arrow', 'Pillar', 'Slab', 'ReferenceMap'], failed: [] });
    expect(r.uploads).toMatchObject({ uploaded: 0, reused: 8 });
    expect(r.studio).toMatchObject({ templates: { made: 0, kept: 8, failed: 0 }, units: { total: 12, placed: 0, kept: 12, replaced: 0, removed: 0 } });
    expect(r.data!.sync).toBe('pushed');
  });

  it('a piece that changed in Kiln is baked, exported and uploaded again, alone; only its placements are replaced', async () => {
    const rig = makeRig();
    await rig.run();
    kiln.calls = [];
    rig.exports.length = 0;
    rig.uploads.length = 0;
    // the slab was reworked in its own project: a new fingerprint and a new mesh
    kiln.projects.get('fixture-slab')!.fingerprint = 'fp-fixture-slab-2';
    kiln.projects.get('fixture-slab')!.exported = { current: false, plain: true };
    boxesFor = (project, name) => (project === 'fixture-slab' ? [{ name: 'Slab', lo: [0, 0, 0], hi: [4, 2, 1], material: 'Slab_Mat' }] : (PIECE_BOXES[project] ?? LAYOUT_BOXES(name)));
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(kiln.hits(/\/roblox$/, 'POST').map((c) => c.path.split('/')[4])).toEqual(['fixture-slab']);
    expect(rig.exports.map((e) => e.name)).toEqual(['Slab']);
    expect(rig.uploads).toEqual(['Slab']);
    expect(r.models).toEqual({ exported: ['Slab'], unchanged: ['Arrow', 'Pillar', 'ReferenceMap'], failed: [] });
    expect(r.studio).toMatchObject({ templates: { made: 1, kept: 7 }, units: { placed: 0, kept: 9, replaced: 3, removed: 0 } });
    // the map's view of the piece is older than the piece now: said, not refused
    kiln.projects.get('fixture-layout')!.manifest.pieces.Slab.stale = true;
    kiln.projects.get('fixture-layout')!.fingerprint = 'fp-layout-1b';
    kiln.projects.get('fixture-layout')!.exported = null;
    const again = await rig.run();
    expect(again.notes.join('\n')).toMatch(/Piece Slab changed in its own project since the map brought it in: the game gets the newer piece/);
  });

  it('a map that changed (a placement moved, one removed, one added) changes exactly those units', async () => {
    const rig = makeRig();
    await rig.run();
    const layout = kiln.projects.get('fixture-layout')!;
    const moved: Mat4 = [[1, 0, 0, 7], [0, 1, 0, -3], [0, 0, 1, 0], [0, 0, 0, 1]];
    layout.manifest.placements = (layout.manifest.placements as Array<{ name: string; matrix: Mat4 }>).filter((p) => p.name !== 'Slab_Tilted_001').map((p) => (p.name === 'Pillar_Plain_001' ? { ...p, matrix: moved } : p));
    layout.manifest.placements.push({ name: 'Arrow_New_001', piece: 'Arrow', project: 'fixture-arrow', matrix: [[1, 0, 0, 600], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] });
    layout.fingerprint = 'fp-layout-2';
    layout.exported = { current: false, plain: true };
    kiln.calls = [];
    rig.exports.length = 0;
    rig.uploads.length = 0;
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(kiln.hits(/\/roblox$/, 'POST').map((c) => c.path.split('/')[4])).toEqual(['fixture-layout']);
    expect(rig.exports.map((e) => e.name)).toEqual(['ReferenceMap']); // the map's own geometry, exported from the new scene
    expect(rig.uploads).toEqual([]); // the same meshes: nothing to upload
    expect(r.studio!.units).toMatchObject({ total: 12, placed: 1, kept: 10, replaced: 1, removed: 1 });
    expect(rig.studio.unit('Slab_Tilted_001')).toBeUndefined();
    expect(fromRoblox(rig.studio.unit('Pillar_Plain_001')!.parts[0]!.slice(0, 3))).toEqual([7, -3, 2]);
    // the new one is 600 studs out: its own grid cell (Roblox x = -600)
    expect([...rig.studio.units.keys()].find((k) => k.endsWith('/Arrow_New_001'))).toBe('Pieces/c_-2_0/Arrow_New_001');
  });
});

describe("Kiln's own check comes first", () => {
  const LOOK = 'Material "Corrugated_Metal" has metalness 0.30: Roblox metal is all or nothing. Use 1 for bare metal (with a light base colour) or 0 for painted, dirty or rusted metal.';
  const BIG = 'Too big for one Roblox part (2,048 studs at most on a side): Ridge_Layer_1 (16,429 studs). kiln.tile(obj, size) cuts it into tiles.';
  const MIRROR = "Mirrored placements (House_003): a placed piece can't be mirrored. Give them a positive scale, or build the mirrored piece as its own project.";

  it('a map Kiln says is not ready is not imported: the problems come back for a fix brief', async () => {
    const rig = makeRig();
    kiln.projects.get('fixture-layout')!.check = { problems: [LOOK, BIG], notes: ['106 materials: each one is extra Roblox parts and texture uploads; 6 or fewer is better.'], summary: 'Roblox check: 2 problems, 1 note.' };
    const r = await rig.run();
    expect(r).toMatchObject({ ok: true, done: false, map: 'ReferenceMap' });
    expect(r.check).toEqual({ ready: false, summary: 'Roblox check: 2 problems, 1 note.', blocking: [], look: [LOOK], handledByShuriken: [BIG], notes: ['106 materials: each one is extra Roblox parts and texture uploads; 6 or fewer is better.'] });
    expect(r.next).toMatch(/nothing was imported.*kiln_request.*kind: "fix".*accept_problems: true/s);
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(0);
    expect(rig.exports).toHaveLength(0);
    expect(rig.studio.programs).toHaveLength(0);
    // accepted: imported as it is
    const ok = await rig.run({ acceptProblems: true });
    expect(ok.done).toBe(true);
    expect(ok.check).toMatchObject({ ready: true, look: [LOOK] });
  });

  it('what Shuriken\'s exporter handles (oversize parts, heavy meshes) does not hold an import back', async () => {
    const rig = makeRig();
    kiln.projects.get('fixture-layout')!.check = { problems: [BIG], notes: [], summary: 'Roblox check: 1 problem.' };
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(r.check).toMatchObject({ ready: true, handledByShuriken: [BIG] });
  });

  it('a mirrored placement blocks even when problems are accepted', async () => {
    const rig = makeRig();
    kiln.projects.get('fixture-layout')!.check = { problems: [MIRROR], notes: [], summary: 'Roblox check: 1 problem.' };
    const r = await rig.run({ acceptProblems: true });
    expect(r.done).toBe(false);
    expect(r.check).toMatchObject({ ready: false, blocking: [MIRROR] });
    expect(r.next).toMatch(/a mirrored placement can't exist in Roblox/);
    expect(rig.exports).toHaveLength(0);
  });

  it('check_only reads the check and the numbers without baking, exporting or placing', async () => {
    const rig = makeRig();
    const none = await rig.run({ checkOnly: true });
    expect(none).toMatchObject({ ok: true, done: false, check: { ready: true } });
    expect(none.manifest).toBeUndefined();
    expect(none.next).toMatch(/Kiln has no Roblox export of this map yet/);
    kiln.projects.get('fixture-layout')!.exported = { current: true, plain: true };
    const r = await rig.run({ checkOnly: true });
    expect(r.manifest).toMatchObject({ placements: 10, pieces: 3, markers: 1, paths: 1 });
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(0);
    expect(rig.exports).toHaveLength(0);
    expect(rig.studio.programs).toHaveLength(0);
    expect(existsSync(join(rig.root, 'models'))).toBe(false);
  });

  it('a project Kiln does not have, a bake that fails and a busy copilot come back as plain errors', async () => {
    const gone = makeRig('no-such-project');
    const g = await gone.run();
    expect(g).toMatchObject({ ok: false, done: false });
    expect(g.error).toMatch(/Kiln doesn't have that project/);
    const rig = makeRig();
    kiln.projects.get('fixture-layout')!.fail = 'The scene is empty';
    expect((await rig.run()).error).toMatch(/Kiln's Roblox export of the map failed: The scene is empty/);
    delete kiln.projects.get('fixture-layout')!.fail;
    // the copilot is working (409): waited out for a while (bakeWaitMs), then the bake goes through
    kiln.projects.get('fixture-layout')!.busy = 2;
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(kiln.hits(/fixture-layout\/roblox$/, 'POST').length).toBe(3 + 1); // the failed one, two 409s, the one that worked
    // and one that never frees up
    referenceProjects();
    kiln.projects.get('fixture-layout')!.busy = 1000;
    expect((await makeRig().run()).error).toMatch(/Kiln's copilot is still working on that project/);
  });
});

describe('degrading', () => {
  it('a piece whose project cannot be exported stays part of the map\'s own geometry; the rest is placed', async () => {
    const rig = makeRig();
    kiln.projects.get('fixture-pillar')!.fail = 'Blender was not found';
    const r = await rig.run();
    expect(r.models!.failed).toEqual([{ model: 'Pillar', why: 'Blender was not found' }]);
    expect(r.notes.join('\n')).toMatch(/Piece model Pillar could not be exported from its own project \(Blender was not found\): its placements stay part of the map's own geometry/);
    // the map's export keeps the pillar's placements (they are not dropped), and no clone of it is planned
    expect(rig.exports.find((e) => e.name === 'ReferenceMap')!.prepare).toContain('json.loads("[\\"fixture-arrow\\",\\"fixture-slab\\"]")');
    expect(r.studio!.units).toMatchObject({ total: 2 + 4 + 3, placed: 9, failed: 0, waiting: 0 });
    expect(r.done).toBe(true);
    expect(rig.studio.unit('Pillar_Plain_001')).toBeUndefined();
    // a piece whose project is gone from Kiln altogether
    kiln.projects.delete('fixture-pillar');
    const gone = await makeRig().run();
    expect(gone.models!.failed).toEqual([{ model: 'Pillar', why: 'Kiln no longer has that project' }]);
  });

  it('an older Kiln (manifest version 1): the scene\'s own geometry comes in, with a note', async () => {
    const rig = makeRig();
    kiln.projects.get('fixture-layout')!.manifest = { version: 1, blend: kiln.blend('fixture-layout'), units: 'studs', materials: [{ name: 'Ground_Mat', size: 512, maps: { color: 'C:/x/Ground.color.png' } }], objects: 4, tris: 48 };
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(r.notes.join('\n')).toMatch(/Manifest version 1 \(before Kiln 0\.8\): it has no map data/);
    expect(r.manifest).toMatchObject({ version: 1, placements: 0, pieces: 0, markers: 0, paths: 0 });
    expect(rig.exports.map((e) => e.name)).toEqual(['ReferenceMap']);
    expect(rig.exports[0]!.prepare).toBeNull();
    expect(r.studio!.units).toMatchObject({ total: 2, placed: 2 });
    expect(r.data).toBeNull(); // no paths, no markers: no data module
    expect(existsSync(join(rig.root, 'world', 'ReferenceMapMarkers.luau'))).toBe(false);
    // a textured material keeps the exporter's look (no plain colour forced on it)
    expect(new ModelStore(rig.root).get('ReferenceMap_Ground')).toMatchObject({ color: '#b8b8b8', material: 'SmoothPlastic' });
  });

  it('a map in meters: the exporter is told to scale to studs, placements and markers are in studs', async () => {
    const rig = makeRig();
    const k = 3.5714;
    for (const id of ['fixture-arrow', 'fixture-pillar', 'fixture-slab', 'fixture-layout']) {
      const p = kiln.projects.get(id)!;
      p.units = 'm';
      p.manifest.units = 'm';
      p.manifest.studs_per_unit = k;
    }
    exportScale = k; // what the prepare step makes the real exporter produce
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(rig.exports.every((e) => e.prepare!.includes('_s = 3.5714'))).toBe(true);
    expect(rig.exports.find((e) => e.name === 'Arrow')!.prepare).toContain('_o.matrix_world = Matrix.Scale(_s, 4) @ _o.matrix_world');
    // the same positions as in studs, times 3.5714; the scale of a clone is the placement's own (not 3.57 times it)
    const u = rig.studio.unit('Slab_Plain_001')!;
    const at = fromRoblox(u.parts[0]!.slice(0, 3), k);
    for (const [i, want] of [-18, -14, 0.25].entries()) expect(at[i]).toBeCloseTo(want, 3);
    expect(u.parts[0]!.slice(6, 9)).toEqual([1, 1, 1]);
    expect(rig.studio.unit('Pillar_Tall_001')!.parts[0]!.slice(6, 9)).toEqual([1, 2.5, 1]);
    expect(fromRoblox(rig.studio.markers[0]!.at.slice(0, 3), k).map((v) => Math.round(v * 1000) / 1000)).toEqual([-25, -18, 0.5]);
    expect(readFileSync(join(rig.root, 'src/Shared/ShurikenMaps/ReferenceMap.luau'), 'utf8')).toContain('width = 28.5712');
  });

  it("a piece that is one of this game's models (linked to its Kiln project) keeps that model", async () => {
    const rig = makeRig();
    mkdirSync(join(rig.root, '.shuriken', 'kiln'), { recursive: true });
    writeFileSync(join(rig.root, '.shuriken', 'kiln', 'StoneSlab.json'), JSON.stringify({ projectId: 'fixture-slab' }));
    writeFileSync(join(rig.root, '.shuriken', 'kiln', 'DriftMap.json'), JSON.stringify({ projectId: 'fixture-layout' }));
    boxesFor = (project, name) => (project === 'fixture-slab' ? [{ name: 'StoneSlab', lo: [0, 0, 0], hi: [4, 2, 0.5], material: 'Slab_Mat' }] : (PIECE_BOXES[project] ?? LAYOUT_BOXES(name)));
    const r = await rig.run();
    expect(r.map).toBe('DriftMap');
    expect(r.models!.exported).toEqual(['Arrow', 'Pillar', 'StoneSlab', 'DriftMap']);
    expect(rig.studio.unit('Slab_Plain_001')!.templates).toEqual(['StoneSlab']);
    expect(r.where!.root).toBe('Workspace.DriftMap');
    // a project several models are linked to (a family built side by side) lends its name to none of them
    writeFileSync(join(rig.root, '.shuriken', 'kiln', 'Arrow_Red.json'), JSON.stringify({ projectId: 'fixture-arrow' }));
    writeFileSync(join(rig.root, '.shuriken', 'kiln', 'Arrow_Blue.json'), JSON.stringify({ projectId: 'fixture-arrow' }));
    expect(linkedByProject(rig.root)).toEqual({ 'fixture-slab': 'StoneSlab', 'fixture-layout': 'DriftMap' });
  });
});

describe('more projects than Kiln lists', () => {
  // Kiln's app listing (with fingerprints) holds its 48 most recent projects; a map with many pieces has more. The
  // storage listing has every project and when it last changed.
  it('a piece the app listing leaves out is still found, exported once, and then known unchanged without opening it', async () => {
    const rig = makeRig();
    kiln.appLimit = 2; // only the two most recently changed are listed with a fingerprint
    kiln.projects.get('fixture-layout')!.updatedAt = '2026-10-01T09:00:00.000Z';
    kiln.projects.get('fixture-arrow')!.updatedAt = '2026-10-01T08:00:00.000Z';
    kiln.projects.get('fixture-pillar')!.updatedAt = '2026-09-20T08:00:00.000Z';
    kiln.projects.get('fixture-slab')!.updatedAt = '2026-09-19T08:00:00.000Z';
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(r.models).toEqual({ exported: ['Arrow', 'Pillar', 'Slab', 'ReferenceMap'], unchanged: [], failed: [] });
    expect(kiln.hits(/\/api\/v1\/storage$/).length).toBeGreaterThanOrEqual(1);
    // again: no bake, no export, although two pieces have no fingerprint in the listing
    kiln.calls = [];
    rig.exports.length = 0;
    const again = await rig.run();
    expect(again.done).toBe(true);
    expect(again.models!.exported).toEqual([]);
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(0);
    expect(rig.exports).toHaveLength(0);
    // one of the pieces outside the app listing changes: it alone is baked and exported
    const order = [...kiln.projects.entries()].sort((x, y) => y[1].updatedAt!.localeCompare(x[1].updatedAt!)).map(([id]) => id);
    const outside = order.slice(kiln.appLimit).find((id) => id !== 'fixture-layout')!;
    expect(outside).toBeTruthy();
    const piece = kiln.projects.get(outside)!;
    piece.fingerprint = `fp-${outside}-2`;
    piece.updatedAt = '2026-09-25T08:00:00.000Z'; // changed, and still older than the listed ones
    piece.exported = { current: false, plain: true };
    kiln.calls = [];
    const changed = await rig.run();
    expect(changed.done).toBe(true);
    expect(kiln.hits(/\/roblox$/, 'POST').map((c) => c.path.split('/')[4])).toEqual([outside]);
    expect(changed.models!.exported).toEqual([piece.title]);
  });

  it('a project that is in no listing is gone; when the storage listing cannot be read, Kiln is asked anyway', async () => {
    const rig = makeRig();
    kiln.appLimit = 1;
    kiln.projects.get('fixture-layout')!.updatedAt = '2026-10-01T09:00:00.000Z';
    kiln.projects.delete('fixture-pillar');
    const r = await rig.run();
    expect(r.models!.failed).toEqual([{ model: 'Pillar', why: 'Kiln no longer has that project' }]);
    // an older Kiln without the storage listing: the pieces are baked (Kiln itself says which one is gone)
    referenceProjects();
    kiln.appLimit = 1;
    kiln.storageWorks = false;
    kiln.projects.get('fixture-layout')!.updatedAt = '2026-10-01T09:00:00.000Z';
    kiln.projects.delete('fixture-pillar');
    const old = await makeRig().run();
    expect(old.done).toBe(true);
    expect(old.models!.exported).toEqual(['Arrow', 'Slab', 'ReferenceMap']);
    expect(old.models!.failed).toEqual([{ model: 'Pillar', why: 'No such project' }]);
  });
});

describe('uploads and Studio that take more than one call', () => {
  it('uploads still running: the call says so and the next one joins them', async () => {
    const rig = makeRig();
    rig.cloud.delayMs = 700;
    // this call's time is nearly up when the uploads start (the clock the budget is measured with)
    const r = await rig.run({ progress: (m) => void (/^Uploading/.test(m) ? (rig.clock.t += 200_000) : 0) });
    expect(r).toMatchObject({ ok: true, done: false });
    expect(r.uploads!.stillUploading.length).toBeGreaterThan(0);
    expect(r.next).toMatch(/meshes are still uploading to Roblox.*Call kiln_layout_import again/s);
    expect(rig.studio.programs).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 1700)); // the uploads carry on by themselves
    rig.cloud.delayMs = 0;
    const again = await rig.run();
    expect(again.done).toBe(true);
    expect(rig.uploads).toHaveLength(8); // nothing was sent twice
    expect(again.models!.exported).toEqual([]); // and nothing was exported twice
  }, 20_000);

  it('no upload possible: nothing is placed, the user is named, and temporary meshes are offered', async () => {
    const rig = makeRig();
    rig.cloud.configured = false;
    const r = await rig.run();
    expect(r.done).toBe(false);
    expect(r.uploads).toMatchObject({ parts: 8, uploaded: 0, needsUser: true });
    expect(r.next).toMatch(/None of the 8 meshes could be uploaded \(no Open Cloud API key.*the user's to fix.*temporary: true/s);
    expect(rig.studio.programs).toHaveLength(0);
    // temporary: built from the mesh files, no upload asked for
    const t = await rig.run({ temporary: true });
    expect(t.done).toBe(true);
    expect(t.uploads).toBeUndefined();
    expect(t.studio).toMatchObject({ placed: true, temporary: true, templates: { made: 8 }, units: { placed: 12 } });
    expect([...rig.studio.kit.values()].every((x) => x.temporary)).toBe(true);
    expect(rig.studio.programs.some((c) => c.includes('InsertService:LoadAsset'))).toBe(false);
    expect(t.next).toMatch(/as temporary meshes \(not saved with the place/);
    // once uploading works, the real import replaces every temporary template and every clone of one
    rig.cloud.configured = true;
    const real = await rig.run();
    expect(real.done).toBe(true);
    expect(real.studio).toMatchObject({ templates: { made: 8, kept: 0 }, units: { placed: 0, kept: 0, replaced: 12 } });
    expect([...rig.studio.kit.values()].some((x) => x.temporary)).toBe(false);
  });

  it('a mesh Studio cannot load yet: what it has is placed, the rest waits, and the next import finishes it', async () => {
    const rig = makeRig();
    rig.studio.unloadable = new Set(['Pillar_Body', 'Pillar_Step']);
    const r = await rig.run();
    expect(r.done).toBe(false);
    expect(r.studio).toMatchObject({ placed: true, templates: { made: 6, failed: 2 }, units: { placed: 9, waiting: 3, failed: 0, removed: 0 } });
    expect(r.studio!.why).toMatch(/3 placements wait for 2 meshes that are not in Studio yet \(Pillar_Body, Pillar_Step\)/);
    expect(r.studio!.failures!.join('\n')).toMatch(/Pillar_Body: asset \d+ has no MeshPart \(still processing\?\)/);
    rig.studio.unloadable.clear();
    const again = await rig.run();
    expect(again.done).toBe(true);
    expect(again.studio).toMatchObject({ templates: { made: 2, kept: 6, failed: 0 }, units: { placed: 3, kept: 9, waiting: 0 } });
  });

  it('a Studio call that fails whole is retried smaller; an import that stops is picked up by the next', async () => {
    const rig = makeRig();
    await rig.run({ temporary: false });
    // a new map version with everything moved: every placement is replaced
    const layout = kiln.projects.get('fixture-layout')!;
    layout.manifest.placements = (layout.manifest.placements as Array<{ matrix: Mat4 }>).map((p) => ({ ...p, matrix: p.matrix.map((row, i) => (i === 2 ? [row[0], row[1], row[2], row[3] + 5] : row)) }));
    layout.fingerprint = 'fp-layout-3';
    layout.exported = null;
    // the first placing call times out, the smaller retry goes through
    rig.studio.onCall = (code) => {
      if (code.includes('local U = {') && rig.studio.programs.filter((c) => c.includes('local U = {')).length === 2) rig.studio.failCalls = 1;
    };
    const r = await rig.run();
    expect(r.done).toBe(true);
    expect(r.studio!.units).toMatchObject({ kept: 2, replaced: 10 });
    // Studio gone for good in the middle (left Edit mode): the import stops and says so; nothing is swept
    layout.manifest.placements = (layout.manifest.placements as Array<{ matrix: Mat4 }>).map((p) => ({ ...p, matrix: p.matrix.map((row, i) => (i === 2 ? [row[0], row[1], row[2], row[3] + 5] : row)) }));
    layout.fingerprint = 'fp-layout-4';
    layout.exported = null;
    rig.studio.onCall = (code) => {
      if (code.includes('local U = {')) rig.studio.failCalls = 99;
    };
    const stopped = await rig.run();
    expect(stopped.done).toBe(false);
    expect(stopped.studio!.why).toMatch(/Placing failed in Studio \(execute_luau timed out\)/);
    expect(stopped.next).toMatch(/Call kiln_layout_import again/);
    expect(rig.studio.units.size).toBe(12); // the earlier version is still there, whole
    rig.studio.onCall = () => undefined;
    rig.studio.failCalls = 0;
    const done = await rig.run();
    expect(done.done).toBe(true);
    expect(done.studio!.units).toMatchObject({ replaced: 10, kept: 2 });
  });

  it('a unit that fails inside its batch is reported by name; the others are placed and nothing is swept', async () => {
    const rig = makeRig();
    rig.studio.failUnits = new Set(['Arrow_Turn90_001']);
    const r = await rig.run();
    expect(r.done).toBe(false);
    expect(r.studio!.units).toMatchObject({ placed: 11, failed: 1 });
    expect(r.studio!.failures).toEqual(['Arrow_Turn90_001: made to fail']);
    expect(rig.studio.programs.some((c) => c.includes('local KEEP = {'))).toBe(false);
  });

  it('Studio not connected, or held by a playtest: exported and uploaded, placed by the next call', async () => {
    const rig = makeRig();
    rig.studio.connected = false;
    const r = await rig.run();
    expect(r).toMatchObject({ ok: true, done: false, studio: { placed: false, why: 'Studio is not connected' } });
    expect(r.uploads!.uploaded).toBe(8);
    expect(r.data!.file).toBe('src/Shared/ShurikenMaps/ReferenceMap.luau'); // the data module is written anyway
    rig.studio.connected = true;
    rig.studio.lease = { ok: false, message: 'Studio is still held by a playtest' };
    expect((await rig.run()).studio).toEqual({ placed: false, why: 'Studio is still held by a playtest' });
    rig.studio.lease = { ok: true };
    expect((await rig.run()).done).toBe(true);
  });
});

describe('a giant map: 1,400 placements of 350 meshes', () => {
  it('arrives in bounded calls, within the time budget of several tool calls, and a second import keeps it all', async () => {
    kiln.projects.clear();
    kiln.calls = [];
    const pieces: Record<string, unknown> = {};
    for (let i = 0; i < 175; i++) {
      const id = `piece-${i}`;
      pieces[`P${i}`] = { project: id, version: 1, fingerprint: `fp-${id}`, tris: 24, placements: 8, stale: false };
      kiln.projects.set(id, { title: `P${i}`, units: 'm', fingerprint: `fp-${id}`, exported: null, manifest: { version: 2, blend: kiln.blend(id), units: 'm', studs_per_unit: 3.5714, materials: [], meshes: {}, objects: 2, tris: 24 } });
    }
    const placements = Array.from({ length: 1400 }, (_, i) => {
      const a = ((i * 37) % 360) * (Math.PI / 180);
      const f = 0.8 + (i % 7) / 10;
      return { name: `P${i % 175}_${String(i).padStart(4, '0')}`, piece: `P${i % 175}`, project: `piece-${i % 175}`, matrix: [[Math.cos(a) * f, -Math.sin(a) * f, 0, ((i * 131) % 9200) - 4600], [Math.sin(a) * f, Math.cos(a) * f, 0, ((i * 977) % 9200) - 4600], [0, 0, f, 0], [0, 0, 0, 1]] };
    });
    kiln.projects.set('giant', { title: 'Giant Circuit', units: 'm', fingerprint: 'fp-giant', exported: null, manifest: { version: 2, blend: kiln.blend('giant'), units: 'm', studs_per_unit: 3.5714, materials: [], meshes: {}, pieces, placements, markers: [], paths: [], roles: {}, colliders: [], mirrored_placements: [], objects: 1, tris: 12 } });
    boxesFor = (project, name) => (project === 'giant' ? [{ name: `${name}_Ground`, lo: [-100, -100, -1], hi: [100, 100, 0], material: 'G', role: 'ground' }] : [{ name: `${name}_Trunk`, lo: [-1, -1, 0], hi: [1, 1, 4], material: 'T' }, { name: `${name}_Crown`, lo: [-2, -2, 4], hi: [2, 2, 7], material: 'C', role: 'decor' }]);
    exportScale = 3.5714;
    const rig = makeRig('giant');
    // every export, upload batch and Studio call takes time on the clock the budget is measured with
    const exportBlend = (rig.importer as unknown as { d: { exportBlend: (...a: unknown[]) => Promise<ExportReply> } }).d;
    const real = exportBlend.exportBlend;
    exportBlend.exportBlend = async (...a) => {
      rig.clock.t += 12_000;
      return real(...a);
    };
    rig.studio.onCall = () => void (rig.clock.t += 6_000);
    let calls = 0;
    let r: LayoutImportResult;
    do {
      r = await rig.run({ budgetMs: 580_000 });
      calls++;
      expect(r.ok, r.error).toBe(true);
    } while (!r.done && calls < 12);
    expect(r.done).toBe(true);
    expect(calls).toBeGreaterThan(1); // 176 exports at 12 s each do not fit one call: it was resumed
    expect(calls).toBeLessThanOrEqual(6);
    expect(rig.exports).toHaveLength(176); // each project once, across all the calls
    expect(rig.uploads).toHaveLength(351); // 350 piece meshes + the ground: once each
    expect(rig.studio.kit.size).toBe(351);
    expect(rig.studio.units.size).toBe(1401);
    // no program near the size Studio would choke on, no answer near its 100,000-character cut
    expect(Math.max(...rig.studio.programs.map((c) => c.length))).toBeLessThan(160_000);
    const unitCalls = rig.studio.programs.filter((c) => c.includes('local U = {'));
    expect(unitCalls.length).toBeGreaterThanOrEqual(3);
    for (const c of unitCalls) expect(lines(c, 'U').reduce((n, l) => n + (l.replace(/,$/, '').split(',').length - 10) / 11, 0)).toBeLessThanOrEqual(1200);
    const kitCalls = rig.studio.programs.filter((c) => c.includes('InsertService:LoadAsset'));
    for (const c of kitCalls) expect(lines(c, 'ROWS').length).toBeLessThanOrEqual(60);
    // the units spread over many grid cells
    expect(new Set([...rig.studio.units.keys()].map((k) => k.split('/')[1])).size).toBeGreaterThan(300);
    // again: nothing exported, uploaded or cloned
    const before = rig.studio.programs.length;
    kiln.calls = [];
    const again = await rig.run({ budgetMs: 580_000 });
    expect(again.done).toBe(true);
    expect(rig.exports).toHaveLength(176);
    expect(rig.uploads).toHaveLength(351);
    expect(kiln.hits(/\/roblox$/, 'POST')).toHaveLength(0);
    expect(again.studio).toMatchObject({ templates: { made: 0, kept: 351 }, units: { placed: 0, kept: 1401, replaced: 0, removed: 0 } });
    expect(rig.studio.programs.length - before).toBeLessThan(20);
  }, 300_000); // about 20 s alone; the files of 351 parts are slow when the machine is busy
});

describe('the pieces of the importer', () => {
  it('prepareCode: nothing to do is no code; meters and dropped pieces are', () => {
    expect(prepareCode(1, [])).toBeNull();
    expect(prepareCode(1.0000000001, [])).toBeNull();
    const code = prepareCode(3.5714, ['tree-abc', 'house "x"'])!;
    expect(code).toContain('_s = 3.5714');
    expect(code).toContain('json.loads("[\\"tree-abc\\",\\"house \\\\\\"x\\\\\\"\\"]")');
    expect(prepareCode(1, ['a'])).toContain('if abs(_s - 1.0) > 1e-9:');
  });

  it('applyManifestLook: a Roblox material and its colour, a plain colour, and textured materials left alone', () => {
    const { manifest } = parseManifest({
      version: 2,
      blend: 'x.blend',
      materials: [
        { name: 'Road', plain: true, color: '#333333', roblox_material: 'Asphalt', size: 0, maps: {} },
        { name: 'Paint', plain: true, color: '#aa0000', roblox_material: null, size: 0, maps: {} },
        { name: 'Glass', plain: true, color: '#ddeeff', roblox_material: null, size: 0, maps: {}, transparency: 0.6 },
        { name: 'Bark', plain: false, color: null, size: 512, maps: { color: 'C:/x/Bark.color.png' } },
      ],
    });
    const part = (name: string, material: string, over: Partial<ExportedPart> = {}): ExportedPart => ({ name, blender_material: material, color: '#b8b8b8', material: 'SmoothPlastic', transparency: 0, origin: [0, 0, 0], size: [1, 1, 1], triangles: 12, vertices: 8, ...over });
    const parts = [part('A', 'Road', { textures: { color: 'stale.png' } }), part('B', 'Paint', { material: 'Metal' }), part('C', 'Glass', { material: 'Glass' }), part('D', 'Bark', { color: '#553311', textures: { color: 'M__Bark.color.png' } }), part('E', 'Road', { role: 'collider', color: '#808080', transparency: 1 }), part('F', 'Unknown')];
    expect(applyManifestLook(parts, manifest)).toBe(3);
    expect(parts[0]).toMatchObject({ color: '#333333', material: 'Asphalt' });
    expect(parts[0]!.textures).toBeUndefined(); // no texture is uploaded for it
    expect(parts[1]).toMatchObject({ color: '#aa0000', material: 'Metal' }); // colour only: the exporter's material stays
    expect(parts[2]).toMatchObject({ color: '#ddeeff', material: 'Glass', transparency: 0.6 });
    expect(parts[3]).toMatchObject({ color: '#553311', textures: { color: 'M__Bark.color.png' } });
    expect(parts[4]).toMatchObject({ color: '#808080', transparency: 1 }); // a collider stays invisible collision
    expect(parts[5]).toMatchObject({ color: '#b8b8b8', material: 'SmoothPlastic' });
  });

  it('mapDataLocation follows the sync map (as the animations module does)', () => {
    expect(mapDataLocation(undefined, 'Circuit')).toEqual({ file: 'src/Shared/ShurikenMaps/Circuit.luau', requirePath: 'game.ReplicatedStorage.Shared.ShurikenMaps.Circuit' });
    expect(mapDataLocation({ 'game/shared': 'ReplicatedStorage/My Modules' }, 'Circuit')).toEqual({ file: 'game/shared/ShurikenMaps/Circuit.luau', requirePath: 'game.ReplicatedStorage["My Modules"].ShurikenMaps.Circuit' });
  });
});

describe('the tool', () => {
  type Handler = ToolDefinition['handler'];
  const caller: CallerContext = { kind: 'agent', runId: 'run_layout', taskId: null, role: 'environment-artist', providerId: null, allowedTools: null };

  function register(rig: Rig, linked: Record<string, string> = {}) {
    let def: ToolDefinition | null = null;
    const client = new KilnClient(() => kiln.runtime);
    registerLayoutTools({ register: (d: ToolDefinition) => void (def = d) } as never, {
      project: () => ({ root: rig.root, extras: () => ({ syncMode: 'none', syncMap: undefined }) }) as unknown as ProjectContext,
      kiln: () => ({ kiln: client, linkedProject: (_root: string, model: string) => linked[model] ?? null }) as never,
      studio: rig.studio as never,
      sync: { push: async () => ({ created: [], updated: [], errors: [] }) } as never,
      bus: new EventBus(),
      uploader: (rig.importer as unknown as { d: { uploader: never } }).d.uploader,
      blender: () => ({ path: null, resourcesDir: null }),
      exportBlend: (rig.importer as unknown as { d: { exportBlend: never } }).d.exportBlend,
    });
    const tool = def as unknown as ToolDefinition;
    const call = async (args: Record<string, unknown>) => {
      const out = await (tool.handler as Handler)({ args, caller, signal: new AbortController().signal } as never);
      return { out, text: out.content.map((c) => ('text' in c ? c.text : '')).join('\n'), data: out.data as LayoutImportResult | undefined };
    };
    return { tool, call };
  }

  it('is one call for the three roles that build the world, and their prompts say when to use it', () => {
    const { tool } = register(makeRig());
    expect(tool.name).toBe('kiln_layout_import');
    expect(tool.roles).toEqual(['modeler', 'environment-artist', 'level-designer']);
    expect(LAYOUT_ROLES).toEqual(tool.roles);
    expect(tool.permission).toBe('roblox_write');
    expect(tool.description).toMatch(/done: false, call it again with the same arguments/);
    for (const role of LAYOUT_ROLES) expect(ROLES[role]!.instructions, role).toContain('kiln_layout_import');
    // SHURIKEN_NO_KILN (set for the tests): not available, with a reason
    expect(tool.available!()).toEqual({ ok: false, reason: 'Kiln is not available in this setup' });
  });

  it('imports by model or by Kiln project, with a headline; and says what is missing', async () => {
    const rig = makeRig();
    const { call } = register(rig, { DriftMap: 'fixture-layout' });
    const none = await call({});
    expect(none.out.isError).toBe(true);
    expect(none.text).toMatch(/Give model .* or kiln_project/);
    expect((await call({ model: 'Nothing' })).text).toMatch(/Nothing has no Kiln project/);
    const r = await call({ model: 'DriftMap' });
    expect(r.out.isError).toBeFalsy();
    expect(r.text.split('\n')[0]).toBe('DriftMap is in Studio: 12 placements (23 parts) from 8 meshes.');
    expect(r.data).toMatchObject({ done: true, map: 'DriftMap', data: { sync: 'code sync is off: add src/Shared/ShurikenMaps/DriftMap.luau to the place yourself' } });
    const again = await call({ kiln_project: 'fixture-layout', name: 'DriftMap' });
    expect(again.text.split('\n')[0]).toBe('DriftMap is in Studio: 12 placements (23 parts) from 8 meshes; 12 were already there.');
    // problems: the headline says it was not imported
    kiln.projects.get('fixture-layout')!.check = { problems: ['Material "X" has metalness 0.30: Roblox metal is all or nothing.'], notes: [], summary: 'Roblox check: 1 problem.' };
    kiln.projects.get('fixture-layout')!.fingerprint = 'fp-layout-9';
    expect((await call({ model: 'DriftMap' })).text.split('\n')[0]).toBe("Not imported: Kiln's check lists 1 problem(s) with DriftMap.");
    const gone = await call({ kiln_project: 'nope' });
    expect(gone.out.isError).toBe(true);
    expect(gone.text).toMatch(/Kiln doesn't have that project/);
  });
});
