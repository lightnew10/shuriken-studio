import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../src/core/core';
import { findBlender } from '../src/core/blender/bridge';
import { ModelStore } from '../src/core/modeling/model-store';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import type { CallerContext } from '../src/core/capabilities/tool-registry';
import { FakeProvider } from './helpers/fake-provider';

/** Toolchain stub: static analysis passes without binaries or network. */
class StubLuau extends LuauToolchain {
  constructor() {
    super(tmpdir());
  }
  override async check(): Promise<LuauCheckResult> {
    return { ok: true, problems: [], toolErrors: [], durationMs: 1 };
  }
}

// Real Blender, where it is installed (skipped elsewhere): SHURIKEN_BLENDER points at another one.
const blender = findBlender(process.env.SHURIKEN_BLENDER || null);
const cores: Core[] = [];
afterAll(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
});

const agent = (runId: string): CallerContext => ({ kind: 'agent', runId, taskId: null, role: 'modeler', providerId: null, allowedTools: null });
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');

const CHEST = `
kiln.clear()
wood = kiln.mat("ChestWood", base="#7a4a2a", roughness=0.8)
wood["roblox_material"] = "WoodPlanks"
gem = kiln.mat("Gem", base="#3dffc4", emission="#3dffc4", strength=4.0)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
body = kiln.mesh_object("Body", bm); body.scale = (4, 2.6, 2); body.location = (0, 0, 1); kiln.paint(body, wood)
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.2)
g = kiln.mesh_object("Gem", bm); g.location = (0, -1.45, 1.4); kiln.paint(g, gem)
`;
const HEAVY = `
kiln.clear()
m = kiln.mat("Glass", base="#88ccff", roughness=0.1)
bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=160, v_segments=100, radius=3.0)
o = kiln.mesh_object("Orb", bm); o.location = (0, 0, 3); kiln.paint(o, m)
`;
const GLOWING = `
kiln.clear()
lava = kiln.material("Lava", "lava", size=64)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
pool = kiln.mesh_object("LavaPool", bm); pool.location = (0, 0, 1); kiln.paint(pool, lava); kiln.uv_box(pool, 1.0)
vc = kiln.mat("Painted", base="#ffffff")
nt = vc.node_tree
node = nt.nodes.new("ShaderNodeVertexColor"); node.layer_name = "Col"
nt.links.new(node.outputs["Color"], next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"])
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
box = kiln.mesh_object("PaintedBox", bm); box.location = (4, 0, 0.5); kiln.paint(box, vc)
ca = box.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
for i, d in enumerate(ca.data):
    d.color = (1.0, 0.0, 0.0, 1.0) if i % 2 == 0 else (0.0, 0.0, 1.0, 1.0)
`;
const TEXTURED = `
kiln.clear()
n = kiln.noise(64, 4, seed=3)
stone = kiln.pbr("Stone", kiln.ramp(n, ["#3d3934", "#7b746a", "#a39a8c"]), height=n, roughness=0.5 + 0.4 * n)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2.0)
block = kiln.mesh_object("Block", bm); block.location = (0, 0, 1); kiln.paint(block, stone); kiln.uv_box(block, 1.0)
sign = kiln.textured("Sign", kiln.image("SignPixels", [["#ff0000", "#00ff00"], ["#0000ff", "#ffffff"]]), metallic=0.25)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
s = kiln.mesh_object("SignBox", bm); s.location = (3, 0, 0.5); kiln.paint(s, sign); kiln.uv_faces(s)
plain = kiln.mat("Plain", base="#446688")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
q = kiln.mesh_object("PlainBox", bm); q.location = (-3, 0, 0.5); kiln.paint(q, plain)
`;
const CRATE = `
kiln.clear()
m = kiln.mat("Crate", base="#9a6b3f", roughness=0.8)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=3.5)
c = kiln.mesh_object("Crate", bm); c.location = (0, 0, 1.75); kiln.paint(c, m)
`;

describe.skipIf(!blender)('Blender modeling', () => {
  it('cuts a material too big for one MeshPart into slabs of at most 10,000 triangles that fit together', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    process.env.SHURIKEN_BLENDER = blender!;
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    core.openProject(core.createProject({ name: 'Heavy', rootPath: root }).id);
    const made = await core.tools.invoke('blender_python', { model: 'Orb', code: HEAVY }, agent('run_heavy'));
    expect(made.isError, text(made)).toBeFalsy();
    expect(text(made)).toMatch(/Cut into MeshParts of at most 10,000 triangles/);
    const store = new ModelStore(root);
    const parts = store.parts('Orb');
    expect(parts.length).toBe(4);
    const tris = parts.map((p) => p.triangles);
    expect(Math.max(...tris)).toBeLessThanOrEqual(10_000);
    expect(tris.reduce((a, b) => a + b, 0)).toBe(160 * 98 * 2 + 160 * 2);
    // The slabs, each at its origin, make up the whole sphere (radius 3, centred 3 above the floor).
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
      const mesh = JSON.parse(readFileSync(store.paths(p.name).mesh, 'utf8')) as { v: number[] };
      for (let i = 0; i < mesh.v.length; i += 3)
        for (let a = 0; a < 3; a++) {
          const w = mesh.v[i + a]! + p.origin![a]!;
          lo[a] = Math.min(lo[a]!, w);
          hi[a] = Math.max(hi[a]!, w);
        }
    }
    expect(hi.map((h, a) => Math.round((h - lo[a]!) * 100) / 100)).toEqual([6, 6, 6]);
  }, 240_000);

  it('exports a glowing texture as an emissive map and a vertex-painted material in its average colour', async () => {
    const { decodePng } = await import('../src/core/modeling/png');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    process.env.SHURIKEN_BLENDER = blender!;
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    core.openProject(core.createProject({ name: 'Glow', rootPath: root }).id);
    const made = await core.tools.invoke('blender_python', { model: 'Glow', code: GLOWING }, agent('run_glow'));
    expect(made.isError, text(made)).toBeFalsy();
    const store = new ModelStore(root);
    // Kiln's lava: its colour image glows (Emission Strength 2.5) -> an emissive map, not Neon.
    const lava = store.get('Glow_Lava')!;
    expect(lava.textures?.emissive).toBe('Glow__Lava.emissive.png');
    expect(lava.emission).toEqual({ strength: 2.5, tint: '#ffffff' });
    expect(lava.material).not.toBe('Neon');
    const mask = decodePng(readFileSync(join(root, 'models', lava.textures!.emissive!)));
    expect(mask.width).toBe(64);
    const glb = readFileSync(store.paths('Glow_Lava').glb);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    expect(json.materials[0].emissiveTexture).toBeTruthy();
    expect(json.materials[0].extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(2.5);
    // Painted by vertex colour, half red and half blue corners: purple, not the socket's white.
    const painted = store.get('Glow_Painted')!;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(painted.color!.slice(i, i + 2), 16));
    expect(g).toBeLessThan(20);
    expect(r).toBeGreaterThan(150);
    expect(b).toBeGreaterThan(150);
    expect(painted.textures).toBeUndefined();
  }, 240_000);

  it('exports textured materials as UV-mapped meshes, PNG maps for Roblox and a textured GLB', async () => {
    const { decodePng } = await import('../src/core/modeling/png');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    process.env.SHURIKEN_BLENDER = blender!;
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    core.openProject(core.createProject({ name: 'Textures', rootPath: root }).id);
    const made = await core.tools.invoke('blender_python', { model: 'Props', code: TEXTURED }, agent('run_tex'));
    expect(made.isError, text(made)).toBeFalsy();
    const store = new ModelStore(root);
    const stone = store.get('Props_Stone')!;
    const sign = store.get('Props_Sign')!;
    expect(stone.textures).toEqual({ color: 'Props__Stone.color.png', normal: 'Props__Stone.normal.png', roughness: 'Props__Stone.roughness.png', metalness: 'Props__Stone.metalness.png' });
    expect(sign.textures).toMatchObject({ color: 'Props__Sign.color.png' });
    expect(sign.textures!.normal).toBeUndefined();
    const png = (f: string) => decodePng(readFileSync(join(root, 'models', f)));
    // The stone's maps at their size; its roughness follows 0.5 + 0.4 n.
    expect([png(stone.textures!.color!).width, png(stone.textures!.normal!).height]).toEqual([64, 64]);
    const rough = png(stone.textures!.roughness!).data;
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < rough.length; i += 4) [lo, hi] = [Math.min(lo, rough[i]!), Math.max(hi, rough[i]!)];
    expect(lo).toBeGreaterThanOrEqual(Math.floor(0.5 * 255) - 2);
    expect(hi).toBeLessThanOrEqual(Math.ceil(0.9 * 255) + 2);
    expect(hi - lo).toBeGreaterThan(20);
    // Pixel art stays crisp: enlarged by whole pixels, top-left red, top-right green.
    const art = png(sign.textures!.color!);
    expect([art.width, art.height]).toEqual([1024, 1024]);
    expect([...art.data.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...art.data.subarray(1023 * 4, 1023 * 4 + 3)]).toEqual([0, 255, 0]);
    // A metalness number becomes a constant map.
    expect(png(sign.textures!.metalness!).width).toBeLessThanOrEqual(8);
    // The mesh has a UV per vertex (0-1 on the sign's faces).
    const mesh = JSON.parse(readFileSync(store.paths('Props_Sign').mesh, 'utf8')) as { v: number[]; uv: number[] };
    expect(mesh.uv.length).toBe((mesh.v.length / 3) * 2);
    expect(Math.min(...mesh.uv)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(...mesh.uv)).toBeLessThanOrEqual(1 + 1e-6);
    // The GLB carries the maps: texture coordinates, base colour, normal and metallic-roughness textures.
    const glb = readFileSync(store.paths('Props_Stone').glb);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    expect(json.meshes[0].primitives[0].attributes.TEXCOORD_0).toBe(3);
    expect(json.images).toHaveLength(3);
    expect(json.materials[0]).toMatchObject({ normalTexture: { index: 1 }, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } } });
    // A plain material stays plain.
    expect(store.get('Props_Plain')!.textures).toBeUndefined();
    expect(JSON.parse(readFileSync(store.paths('Props_Plain').mesh, 'utf8')).uv).toBeUndefined();
  }, 240_000);

  it('models in parallel workspaces, exports Roblox parts, renders, checks, undoes and keeps models to their owner', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    process.env.SHURIKEN_BLENDER = blender!;
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    core.openProject(core.createProject({ name: 'Props', rootPath: root }).id);
    expect(core.modeling.status()).toMatchObject({ ready: true });

    // Two modelers at once, each in its own Blender.
    const t0 = Date.now();
    const [chest, crate] = await Promise.all([
      core.tools.invoke('blender_python', { model: 'Chest', code: CHEST, step: 'Block out the chest' }, agent('run_a')),
      core.tools.invoke('blender_python', { model: 'Crate', code: CRATE }, agent('run_b')),
    ]);
    const both = Date.now() - t0;
    expect(chest.isError, text(chest)).toBeFalsy();
    expect(crate.isError, text(crate)).toBeFalsy();
    expect(text(chest)).toMatch(/In Roblox: 2 MeshParts \(one per material\): Chest_Gem \(Neon #3dffc4, 20 tris\); Chest_Chestwood \(WoodPlanks #7a4a2a, 12 tris\)/);
    expect(text(chest)).toMatch(/Whole model 4\.0 × 2\.0 × 2\.9 studs/);
    expect(core.modeling.list(root).map((w) => w.name).sort()).toEqual(['Chest', 'Crate']);

    // The Roblox parts are in the model store: an assembly with origins (the gem on the front: -Z).
    const store = new ModelStore(root);
    const parts = store.parts('Chest');
    expect(parts.map((p) => [p.name, p.material, p.color])).toEqual([
      ['Chest_Chestwood', 'WoodPlanks', '#7a4a2a'],
      ['Chest_Gem', 'Neon', '#3dffc4'],
    ]);
    expect(parts.find((p) => p.name === 'Chest_Gem')!.origin![2]).toBeCloseTo(-1.45, 2);
    expect(store.get('Crate')).toMatchObject({ source: 'blender', material: 'SmoothPlastic', blend: 'models/Crate.blend' });
    expect(existsSync(join(root, 'models', 'Chest.blend'))).toBe(true);
    expect(JSON.parse(readFileSync(store.paths('Chest_Gem').mesh, 'utf8')).t.length).toBe(60);

    // Another agent can't edit a model someone else is working on.
    const clash = await core.tools.invoke('blender_python', { model: 'Chest', code: 'pass' }, agent('run_c'));
    expect(clash.isError).toBe(true);
    expect(text(clash)).toMatch(/being modeled by .* right now/);

    // A render (the character beside it in the first view), a check, a change and an undo.
    const shot = await core.tools.invoke('blender_render', { model: 'Chest', views: ['iso', 'front'] }, agent('run_a'));
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect((await core.tools.invoke('blender_check', { model: 'Chest' }, agent('run_a'))).isError).toBeFalsy();
    const lid = await core.tools.invoke('blender_python', { model: 'Chest', code: 'bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)\nl = kiln.mesh_object("Lid", bm); l.scale = (4.2, 2.8, 0.4); l.location = (0, 0, 2.2)\nkiln.paint(l, bpy.data.materials["ChestWood"])' }, agent('run_a'));
    expect(text(lid)).toMatch(/version 2/);
    expect((await core.tools.invoke('blender_undo', { model: 'Chest' }, agent('run_a'))).isError).toBeFalsy();
    expect(core.modeling.list(root).find((w) => w.name === 'Chest')!.version).toBe(1);

    // When the owner's run ends, others may take the model over.
    core.modeling.releaseRun('run_a');
    expect((await core.tools.invoke('blender_python', { model: 'Chest', code: 'pass' }, agent('run_c'))).isError).toBeFalsy();

    // model_place with the model's name places all its parts as one Roblox Model (a stand-in Studio;
    // no uploads here, so temporary meshes): the container at the pivot, each part at its offset, then
    // the whole model settled at once.
    // An older build123d model of the same name (as in projects from before Blender) doesn't shadow it.
    store.save({ name: 'Chest', description: 'build123d preview', hash: 'old', size: [3, 3, 3], triangles: 12, vertices: 8, volume: null, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], source: 'build123d' });
    const luau: string[] = [];
    const studio = core.studio as unknown as Record<string, unknown>;
    studio.availability = () => ({ ok: true });
    const bloomNote = "toned Lighting.Bloom down so the neon doesn't blind (intensity 1, size 24, threshold 2 -> intensity 0.4, size 24, threshold 2)";
    studio.runLuau = async (code: string) => {
      luau.push(code);
      if (code.includes('return tameBloom()')) return { ok: true, output: bloomNote, durationMs: 1 };
      if (code.includes('local spots = {}')) return { ok: true, output: JSON.stringify({ spots: { Chest_Chestwood: [10, 1, 0], Chest_Gem: [10, 1.4, -1.45] }, rot: [0, 90, 0] }), durationMs: 1 };
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Chest', position: [10, 0, 0], rotation: [0, 90, 0], notes: ['rests on Workspace.Baseplate (surface at y=0.00)'] }), durationMs: 1 };
    };
    const placed = await core.tools.invoke('model_place', { name: 'Chest', position: [10, 5, 0], rotation: [0, 90, 0] }, agent('run_c'));
    expect(placed.isError, text(placed)).toBeFalsy();
    const out = JSON.parse(text(placed)) as { placed: string; parts: string[]; permanent: boolean; notes: string[] };
    // The gem is Neon: Lighting's Bloom is toned down so it glows without blinding.
    expect(out).toMatchObject({ placed: 'Workspace.Chest', permanent: false, bloom: bloomNote });
    expect(out.parts.sort()).toEqual(['Chest_Chestwood', 'Chest_Gem']);
    expect(luau).toHaveLength(5);
    expect(luau[4]).toMatch(/tameBloom/);
    expect(luau[0]).toMatch(/model:SetAttribute\("ShurikenAssembly", "Chest"\)/);
    expect(luau[0]).toMatch(/CFrame\.new\(10, 5, 0\) \* CFrame\.fromOrientation\(math\.rad\(0\), math\.rad\(90\), math\.rad\(0\)\)/);
    expect(luau[0]).toMatch(/CFrame\.new\(0, 1\.4, -1\.45\)/); // the gem's offset from the model's origin
    expect(luau[1]! + luau[2]!).toMatch(/"Workspace\.Chest"/);
    expect(luau[3]).toMatch(/settle\(model, true\)/);
    const temporary = [...luau];

    // Uploaded (a stand-in Open Cloud): one Luau program places the parts; each part's final spot is
    // recorded, and world/Models.luau rebuilds the model as a Model.
    core.prefs.set({ robloxCreatorId: '42' });
    const cloud = core.assetUploads as unknown as Record<string, unknown>;
    let uploads = 0;
    cloud.configured = async () => true;
    cloud.upload = async () => ({ ok: true, assetId: String(1000 + ++uploads) });
    luau.length = 0;
    studio.runLuau = async (code: string) => {
      luau.push(code);
      if (code.includes('return tameBloom()')) return { ok: true, output: '', durationMs: 1 };
      return { ok: true, output: JSON.stringify({ path: 'Workspace.Chest', position: [10, 0, 0], rotation: [0, 90, 0], notes: [], parts: { Chest_Chestwood: { pos: [10, 1, 0], rot: [0, 90, 0] }, Chest_Gem: { pos: [8.55, 1.4, 0], rot: [0, 90, 0] } } }), durationMs: 1 };
    };
    const kept = await core.tools.invoke('model_place', { name: 'Chest', position: [10, 5, 0], rotation: [0, 90, 0] }, agent('run_c'));
    expect(JSON.parse(text(kept))).toMatchObject({ placed: 'Workspace.Chest', permanent: true });
    expect(uploads).toBe(2);
    // Placed, then the bloom check (already gentle: nothing to say).
    expect(luau).toHaveLength(2);
    expect(JSON.parse(text(kept))).not.toHaveProperty('bloom');
    expect(store.get('Chest_Gem')!.placements).toEqual([{ name: 'Chest_Gem', parent: 'Workspace.Chest', position: [8.55, 1.4, 0], rotation: [0, 90, 0], scale: 1, color: '#3dffc4', material: 'Neon', group: true }]);
    const builder = readFileSync(join(root, 'world', 'Models.luau'), 'utf8');
    expect(builder).toMatch(/parent="Workspace\.Chest".*group=true/);
    // A rebuild keeps the bloom gentle too (the place has neon in it).
    expect(builder).toMatch(/local bloom = tameBloom\(\)/);

    // Everything generated parses (selene's parser, where it is installed).
    if ((await core.luau.parseErrors('local x = (')).length) {
      for (const code of [...temporary, ...luau, builder]) expect(await core.luau.parseErrors(code)).toEqual([]);
    }
    // Logged for context: the two first builds ran side by side.
    expect(both).toBeLessThan(60_000);
  }, 180_000);
});

const BUG = `
kiln.clear()
shell = kiln.mat("Shell", base="#3f5a2a", roughness=0.6)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
body = kiln.mesh_object("Body", bm); body.scale = (1.4, 2.4, 0.7); body.location = (0, 0, 1.3); kiln.paint(body, shell)
kiln.rig.joint("Root", (0, 0, 1.3), kind="ball", limits=((-20, -20, -20), (20, 20, 20)))
kiln.rig.bind([body], "Root")
for side, x in (("L", 0.7), ("R", -0.7)):
    for i, y in enumerate((-0.8, 0.8)):
        kiln.limb("Leg%s%d" % (side, i), [(x, y, 1.1), (x * 1.9, y * 1.1, 0.9), (x * 2.2, y * 1.15, 0.0)], [0.14, 0.1, 0.06], material=shell, rig=True, parent_joint="Root")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
tail = kiln.mesh_object("Tail", bm); tail.scale = (0.3, 1.2, 0.3); tail.location = (0, 1.8, 1.4); kiln.paint(tail, shell)
kiln.rig.joint("Tail", (0, 1.2, 1.4), parent="Root", kind="ball", tail=(0, 2.4, 1.4))
kiln.rig.bind([tail], "Tail")
kiln.rig.attach("StingTip", "Tail", (0, 2.4, 1.4))
kiln.anim.gait("Walk", style="walk")
kiln.anim.attack("Sting", kind="sting")
`;

const POSED = (file: string) => `
import json
import numpy as np
import roblox_export as rx
arm = kiln.rig.armature(False)
arm.data.pose_position = "POSE"
out = {}
for clip in ("Walk", "Sting"):
    kiln.anim.use(clip)
    act = bpy.data.actions[clip]
    s, e = [int(round(v)) for v in act.frame_range]
    out[clip] = {}
    for f in (s, s + (e - s) // 2, e):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        out[clip][str(round((f - s) / 30.0, 4))] = {pb.name: [float(v) for v in rx.TO_RBX @ np.array(arm.matrix_world @ pb.tail)] for pb in arm.pose.bones}
json.dump(out, open(${JSON.stringify(file)}, "w"))
`;

describe.skipIf(!blender)('Kiln rigs and animation into Roblox', () => {
  it('exports an armature rig at rest and its clips as project animations that pose it like Blender does', async () => {
    const { AnimationStore } = await import('../src/core/animation/animation-service');
    const { forwardKinematics, apply, parseRig } = await import('../src/shared/rig');
    const { sampleClip, validateClip } = await import('../src/shared/animation');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    process.env.SHURIKEN_BLENDER = blender!;
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    core.openProject(core.createProject({ name: 'Bugs', rootPath: root }).id);

    const made = await core.tools.invoke('blender_python', { model: 'Bug', code: BUG }, agent('run_rig'));
    expect(made.isError, text(made)).toBeFalsy();
    const rigJson = JSON.parse(readFileSync(join(root, 'models', 'Bug.rig.json'), 'utf8')) as { kind: string; root: string; joints: Array<{ name: string; tail: [number, number, number] }>; legs: unknown[]; attachments: Array<{ name: string; part: string; position: number[] }> };
    expect(rigJson).toMatchObject({ kind: 'custom', root: 'Root' });
    expect(rigJson.legs).toHaveLength(4);
    // At rest, in Roblox space: the sting tip behind the body (+Z), up at 1.4.
    expect(rigJson.attachments[0]).toMatchObject({ name: 'StingTip', part: 'Tail' });
    expect(rigJson.attachments[0]!.position[1]).toBeCloseTo(1.4, 2);
    expect(rigJson.attachments[0]!.position[2]).toBeCloseTo(2.4, 2);

    // Both clips are project animations, named after the model, marked as Kiln's, valid for the rig.
    const store = new AnimationStore(root);
    const walk = store.get('BugWalk')!;
    const sting = store.get('BugSting')!;
    expect(walk.source).toMatchObject({ kind: 'kiln', model: 'Bug', clip: 'Walk', inPlace: true });
    expect(walk.source!.speed).toBeGreaterThan(0);
    expect(walk.clip).toMatchObject({ rig: 'Bug', loop: true, priority: 'Movement' });
    expect(walk.clip.markers!.some((m) => /^Step_/.test(m.name))).toBe(true);
    expect(sting.clip.markers!.map((m) => m.name)).toEqual(expect.arrayContaining(['Hit']));
    const rig = parseRig(rigJson);
    if (typeof rig === 'string') throw new Error(rig);
    expect(validateClip(walk.clip, rig)).toEqual([]);
    expect(existsSync(join(root, 'world', 'Animations.luau'))).toBe(true);

    // Shuriken's forward kinematics on the exported keys puts every bone's tip where Blender has it.
    const posedFile = join(root, 'posed.json');
    const posed = await core.tools.invoke('blender_python', { model: 'Bug', code: POSED(posedFile) }, agent('run_rig'));
    expect(posed.isError, text(posed)).toBeFalsy();
    const want = JSON.parse(readFileSync(posedFile, 'utf8')) as Record<string, Record<string, Record<string, number[]>>>;
    const tails = new Map(rigJson.joints.map((j) => [j.name, j.tail]));
    let worst = 0;
    for (const [clipName, frames] of Object.entries(want)) {
      const clip = store.get(`Bug${clipName}`)!.clip;
      for (const [t, pts] of Object.entries(frames)) {
        const xf = forwardKinematics(rig, sampleClip({ ...clip, loop: false }, Number(t)) as never);
        for (const j of rig.joints) {
          const got = apply(xf.get(j.name)!, tails.get(j.name)!);
          const w = pts[j.name]!;
          worst = Math.max(worst, Math.hypot(got[0] - w[0]!, got[1] - w[1]!, got[2] - w[2]!));
        }
      }
    }
    expect(worst).toBeLessThan(0.05);

    // A clip deleted in Kiln goes from the project's animations on the next export.
    const del = await core.tools.invoke('blender_python', { model: 'Bug', code: 'kiln.anim.delete("Sting")' }, agent('run_rig'));
    expect(del.isError, text(del)).toBeFalsy();
    expect(store.get('BugSting')).toBeNull();
    expect(store.get('BugWalk')).not.toBeNull();

    // Kiln's generators run through kiln_clip wherever the model is (here Shuriken's own Blender).
    const gen = await core.tools.invoke('kiln_clip', { model: 'Bug', clip: 'Idle', action: 'generate', generator: 'idle', params: { length: 2 } }, agent('run_rig'));
    expect(gen.isError, text(gen)).toBeFalsy();
    expect(store.get('BugIdle')).toMatchObject({ source: { kind: 'kiln', model: 'Bug', clip: 'Idle' }, clip: { loop: true, priority: 'Idle' } });
    const ev = await core.tools.invoke('kiln_clip', { model: 'Bug', clip: 'Idle', action: 'event', label: 'Blink', time: 1 }, agent('run_rig'));
    expect(ev.isError, text(ev)).toBeFalsy();
    expect(store.get('BugIdle')!.clip.markers).toEqual(expect.arrayContaining([{ t: 1, name: 'Blink' }]));
    const check = await core.tools.invoke('kiln_clip', { model: 'Bug', clip: 'Idle', action: 'check' }, agent('run_rig'));
    expect(check.isError, text(check)).toBeFalsy();
    expect(JSON.parse(text(check)).report).toHaveProperty('summary');

    // What the live refresh runs in Kiln's Blender: only the rig and its clips.
    const only = await core.tools.invoke('blender_python', { model: 'Bug', code: `import json, roblox_export
print("RIGCLIPS " + json.dumps(roblox_export.export_rig_clips(${JSON.stringify(join(root, 'models'))}, "Bug")))` }, agent('run_rig'));
    expect(only.isError, text(only)).toBeFalsy();
    const rc = JSON.parse(/RIGCLIPS (.*)/.exec(text(only))![1]!) as { rig: { joints: string[] }; clips: Array<{ name: string }>; anim_fp: string };
    expect(rc.rig.joints).toEqual(expect.arrayContaining(['Root', 'Tail']));
    expect(rc.clips.map((c) => c.name).sort()).toEqual(['Idle', 'Walk']);
    expect(rc.anim_fp).toMatch(/^[0-9a-f]{16}$/);

    // Kiln's R15 rig: its clips are ordinary R15 animations, the rig root's motion carried by LowerTorso.
    const hero = await core.tools.invoke(
      'blender_python',
      {
        model: 'Hero',
        code: `kiln.clear()
bpy.context.scene["kiln_units"] = "studs"
kiln.rig.r15(parts=True, units="studs")
kiln.anim.clip("HeroSwing", length=0.6, loop=False, in_place=True, priority="Action")
kiln.anim.pose("HeroSwing", 1, {"RightUpperArm": ("x", 0)}, root=(0, 0, 0))
kiln.anim.pose("HeroSwing", 8, {"RightUpperArm": ("x", -110)}, root=(0, -0.3, -0.2))
kiln.anim.pose("HeroSwing", 19, {"RightUpperArm": ("x", 20)}, root=(0, 0, 0))
kiln.anim.event("HeroSwing", "Hit", time=0.25)`,
      },
      agent('run_hero'),
    );
    expect(hero.isError, text(hero)).toBeFalsy();
    const swing = store.get('HeroSwing')!;
    expect(swing.clip.rig).toBeUndefined();
    expect(validateClip(swing.clip)).toEqual([]);
    // Kiln puts events on whole frames (0.25 s is between frames 8 and 9 at 30 fps).
    expect(swing.clip.markers).toEqual([{ t: 0.2333, name: 'Hit' }]);
    const at = swing.clip.keys.find((k) => Math.abs(k.t - 0.2333) < 0.02)!;
    expect(at.poses.HumanoidRootPart).toBeUndefined();
    expect(at.poses.LowerTorso!.pos![1]).toBeCloseTo(-0.2, 2);
    expect(at.poses.LowerTorso!.pos![2]).toBeCloseTo(-0.3, 2);
    // Kiln's -110° about Blender X swings the arm forward and up: +110 about Roblox X (Shuriken's convention).
    expect(at.poses.RightUpperArm!.rot![0]).toBeCloseTo(110, 0);
  }, 240_000);
});
