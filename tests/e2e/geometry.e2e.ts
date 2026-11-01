/**
 * Live structured-geometry check against real Roblox Studio (no model calls, no cost):
 *
 *   E2E=geometry npx vitest run -c vitest.e2e.config.ts tests/e2e/geometry.e2e.ts
 *
 * Needs the Shuriken sandbox place (sandbox.rbxlx) open in Studio. Boots a core in a throwaway data
 * directory with a throwaway project, then goes through the real tool registry: geometry_apply
 * (parts + generators + CSG) → geometry_read → edit → re-apply → asset library record, and cleans up.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { AssetService } from '../../src/core/assets/asset-service';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

const caller: CallerContext = { kind: 'ui', runId: null, taskId: null, role: 'e2e', providerId: null, allowedTools: null };
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');

const SPEC = {
  name: 'E2E Gatehouse',
  pivot: [0, 0, -120],
  yaw: 30,
  defaults: { material: 'Cobblestone', color: '#7a7468' },
  parts: [
    { name: 'Base', size: [24, 2, 16], pos: [0, 1, 0], material: 'Slate' },
    { name: 'Keep', size: [10, 14, 10], pos: [0, 9, 0] },
    { name: 'Doorway', size: [4, 7, 12], pos: [0, 5.5, 0] },
  ],
  generators: [
    { kind: 'ring', name: 'Merlon', part: { size: [1.5, 2, 1.5] }, count: 12, center: [0, 17, 0], radius: 6, faceCenter: true },
    { kind: 'stairs', name: 'Step', steps: 4, width: 6, rise: 0.5, run: 1.5, start: [0, 2, 8] },
    { kind: 'wall', name: 'Wall', from: [-12, 7], to: [12, 7], y: 2, height: 6, thickness: 1, openings: [{ at: 6, width: 3, height: 2, bottom: 2 }] },
    { kind: 'arch', name: 'Arch', span: 8, thickness: 1.5, depth: 2, segments: 9, center: [0, 2, 18], pillarHeight: 5 },
  ],
  csg: [{ op: 'subtract', target: 'Keep', with: ['Doorway'], name: 'Keep' }],
  attributes: { Level: 1 },
};

describe.runIf(process.env.E2E === 'geometry')('structured geometry (live Studio)', () => {
  it('applies, reads back, edits and re-applies a spec', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-geo-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-geo-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    let built: string | null = null;
    try {
      const summary = core.createProject({ name: 'Geometry E2E', rootPath: projectDir, template: 'empty' });
      const project = core.openProject(summary.id);
      await core.studio.start();
      core.studio.bind('sandbox');

      const t0 = Date.now();
      const applied = await core.tools.invoke('geometry_apply', { spec: SPEC }, caller);
      log('apply:', text(applied).slice(0, 800), `(${Date.now() - t0} ms)`);
      expect(applied.isError ?? false).toBe(false);
      const a = JSON.parse(text(applied)) as { built: boolean; path: string; parts: number; partsInStudio: number; asset: string; files: string[] };
      built = a.path;
      expect(a.built).toBe(true);
      expect(a.path).toBe('Workspace.E2E Gatehouse');
      // 3 parts + 12 merlons + 4 steps + wall (2 segments, sill, lintel) + arch (9 + 2 pillars) = 34; CSG consumes the doorway.
      expect(a.parts).toBe(34);
      expect(a.partsInStudio).toBe(33);
      expect(existsSync(join(projectDir, 'world', 'E2E_Gatehouse.geometry.json'))).toBe(true);
      expect(readFileSync(join(projectDir, 'world', 'E2E_Gatehouse.luau'), 'utf8')).toContain('shuriken:geometry');

      const read = await core.tools.invoke('geometry_read', { path: a.path }, caller);
      const r = JSON.parse(text(read)) as { spec: { parts: Array<{ name: string; pos: number[]; rot: number[] }>; yaw: number; pivot: number[]; attributes: Record<string, unknown> }; opaque: Array<{ name: string; class: string }> };
      log(`read: ${r.spec.parts.length} primitive parts, opaque ${r.opaque.map((o) => `${o.name}:${o.class}`).join(', ')}, yaw ${r.spec.yaw}, pivot ${r.spec.pivot.join(',')}`);
      expect(r.spec.parts.length).toBe(32);
      expect(r.opaque).toEqual([expect.objectContaining({ name: 'Keep', class: 'UnionOperation' })]);
      expect(Math.round(r.spec.yaw)).toBe(30);
      expect(r.spec.attributes.Level).toBe(1);
      const step4 = r.spec.parts.find((p) => p.name === 'Step_4')!;
      expect(step4.pos.map((n) => Math.round(n * 100) / 100)).toEqual([0, 3, 13.25]);

      // Edit the spec (taller keep, more merlons) and re-apply: same model, new version.
      const edited = { ...SPEC, parts: SPEC.parts.map((p) => (p.name === 'Keep' ? { ...p, size: [10, 18, 10], pos: [0, 11, 0] } : p)), generators: SPEC.generators.map((g) => (g.kind === 'ring' ? { ...g, count: 16, center: [0, 21, 0] } : g)) };
      const again = await core.tools.invoke('geometry_apply', { spec: edited }, caller);
      expect(again.isError ?? false).toBe(false);
      const b = JSON.parse(text(again)) as { partsInStudio: number; asset: string };
      expect(b.partsInStudio).toBe(37);
      expect(b.asset).toBe(a.asset);
      const svc = new AssetService(project.store);
      const rec = svc.get(a.asset)!;
      log('asset:', rec.name, `v${rec.version}`, rec.analysis ? `${rec.analysis.parts} parts, bbox ${rec.analysis.bbox.join('x')}` : 'no analysis');
      expect(rec.version).toBe(2);
      expect(rec.analysis?.parts).toBe(37);
      expect(svc.history(rec.id).map((e) => e.kind)).toEqual(['generated', 'analyzed', 'modified', 'analyzed']);

      // A hand-built model with the same name is protected unless replace_existing is passed.
      await core.studio.runLuau('local m = Instance.new("Model") m.Name = "E2E Handmade" m.Parent = workspace return "ok"', 'Edit');
      const clash = await core.tools.invoke('geometry_apply', { spec: { name: 'E2E Handmade', parts: [{ name: 'P', size: [1, 1, 1], pos: [0, 0, 0] }] } }, caller);
      expect(clash.isError).toBe(true);
      expect(text(clash)).toMatch(/not built from a geometry spec/);
    } finally {
      // KEEP=1 leaves the gatehouse in the sandbox for visual inspection.
      await core.studio
        .runLuau(process.env.KEEP ? 'local m = workspace:FindFirstChild("E2E Handmade") if m then m:Destroy() end return "ok"' : 'for _, n in ipairs({"E2E Gatehouse", "E2E Handmade"}) do local m = workspace:FindFirstChild(n) if m then m:Destroy() end end return "ok"', 'Edit')
        .catch(() => undefined);
      await core.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      if (built) log('cleaned up', built);
    }
  });
});
