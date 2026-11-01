import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../../src/core/events';
import { Logger } from '../../src/core/log';
import { KilnModeling } from '../../src/core/modeling/kiln-modeling';
import { ModelStore } from '../../src/core/modeling/model-store';
import type { ModelingBackend } from '../../src/core/modeling/backend';

// The Kiln link against a real, running Kiln (point KILN_RUNTIME at a test instance's runtime.json,
// never the user's) with real Blender: a model built through Shuriken's seam lands in the model store
// as Roblox parts made by Shuriken's own export, running in Kiln's Blender. No model calls.
//   E2E=kiln KILN_RUNTIME=<test data dir>\runtime.json npx vitest run -c vitest.e2e.config.ts tests/e2e/kiln.e2e.ts

const run = process.env.E2E === 'kiln' && !!process.env.KILN_RUNTIME;

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

const RIG = `
kiln.clear()
m = kiln.mat("Hide", "#553344")
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2)
body = kiln.mesh_object("Body", bm); body.location = (0, 0, 4); kiln.paint(body, m)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
thigh = kiln.mesh_object("Thigh", bm); thigh.scale = (0.5, 0.5, 2); thigh.location = (1.5, 0, 2.5); kiln.paint(thigh, m)
kiln.rig.joint("Body", (0, 0, 4))
kiln.rig.joint("Thigh", (1.5, 0, 3.5), parent="Body", kind="hinge", axis=(0, 1, 0), limits=(-40, 40))
kiln.rig.bind([body], "Body"); kiln.rig.bind([thigh], "Thigh")
kiln.rig.leg(["Thigh"], foot="Thigh")
kiln.rig.attach("Hitbox", "Body", (0, 0, 4))
print(kiln.rig.pose_test())
`;

describe.runIf(run)('Kiln link, live', () => {
  it('builds in Kiln and publishes Roblox parts', async () => {
    const stub = { status: () => ({ ready: false, exe: null, version: null, max: 1, running: 0, detail: 'fallback' }), workspace: () => { throw new Error('fallback used'); }, list: () => [], releaseRun: () => {}, stop: () => {} } as unknown as ModelingBackend;
    const modeling = new KilnModeling(stub, { enabled: () => true, resourcesDir: resolve(__dirname, '..', '..', 'resources'), runtimeFile: () => process.env.KILN_RUNTIME! }, new EventBus(), new Logger(null, null).scope('kiln'));
    try {
      expect((await modeling.kiln.check(true)).ok).toBe(true);
      const root = mkdtempSync(join(tmpdir(), 'kiln-live-'));
      const ws = modeling.workspace(root, 'TreasureChest', { runId: 'e2e', role: 'modeler' });
      const r = await ws.exec(CHEST, 120_000, 'Build the chest');
      expect(r.error).toBeNull();
      expect(r.changed).toBe(true);
      const store = new ModelStore(root);
      const parts = store.parts('TreasureChest');
      expect(parts.map((p) => p.material).sort()).toEqual(['Neon', 'WoodPlanks']);
      expect(existsSync(join(root, 'models', 'TreasureChest.blend'))).toBe(true);
      for (const p of parts) expect(JSON.parse(readFileSync(store.paths(p.name).mesh, 'utf8')).t.length).toBeGreaterThan(0);
      const shot = await ws.render({ views: ['iso'], player: true });
      expect(shot.ok).toBe(true);
      expect(await ws.undo()).toBe(true);

      // A rig-ready model: two segments on two joints, exported by segment with a rig.json.
      const rigged = modeling.workspace(root, 'Stalker', { runId: 'e2e', role: 'modeler' });
      const r2 = await rigged.exec(RIG, 120_000, 'Rig a leg');
      expect(r2.error).toBeNull();
      const rig = JSON.parse(readFileSync(join(root, 'models', 'Stalker.rig.json'), 'utf8')) as { root: string; joints: Array<{ name: string; parent: string | null; pivot: number[] }>; legs: unknown[]; attachments: Array<{ name: string }> };
      expect(rig.root).toBe('Body');
      expect(rig.joints.map((j) => j.name).sort()).toEqual(['Body', 'Thigh']);
      expect(rig.joints.find((j) => j.name === 'Thigh')?.parent).toBe('Body');
      expect(rig.attachments.map((a) => a.name)).toEqual(['Hitbox']);
      expect(new ModelStore(root).parts('Stalker').map((p) => p.name).sort()).toEqual(['Stalker_Body', 'Stalker_Thigh']);
    } finally {
      modeling.stop();
    }
  }, 300_000);
});
