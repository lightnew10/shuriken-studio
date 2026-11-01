import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/core/db/store';
import { PROJECT_MIGRATIONS } from '../src/core/db/schema';
import { AssetService, analysisSummary, type AssetAnalysis } from '../src/core/assets/asset-service';
import { diffChildren, parseAssetResult, watchRoots } from '../src/core/assets/asset-capture';

// Result formats observed from Studio MCP on 2026-09-28 (sandbox place).
const INSERT_RESULT = JSON.stringify({
  insertGuid: 'd4d20009-e823-45ce-979f-8b0e954b2135',
  insertedInstances: [{ fullPath: 'game.Workspace.Low Poly Rock Pack', name: 'Low Poly Rock Pack', className: 'Model' }],
  sandboxed: false,
  assetType: 'Model',
  assetId: '2128776869',
  assetName: 'Low Poly Rock Pack',
  status: 'success',
  isPackage: false,
  tag: 'Assistant:d4d20009-e823-45ce-979f-8b0e954b2135',
});
const ASYNC_START = JSON.stringify({ jobId: '1ffe6dbe-ac9a-448f-a0e6-4f4f484bebc4', status: 'Running' });
const JOB_DONE = JSON.stringify({
  status: 'Completed',
  jobResult: {
    structuredContent: { generationName: 'Crate', generationId: 'e0f38d1e', tag: 'PrimitiveGen_e0f38d1e' },
    content: [{ text: JSON.stringify({ generationName: 'Crate', generationId: 'e0f38d1e', tag: 'PrimitiveGen_e0f38d1e' }), type: 'text' }],
    isError: false,
  },
});

function analysis(over: Partial<AssetAnalysis> = {}): AssetAnalysis {
  return {
    path: 'Workspace.Crate',
    className: 'ProceduralModel',
    name: 'Crate',
    instanceCount: 80,
    counts: { Part: 68 },
    parts: 68,
    anchored: 68,
    mass: 120,
    bbox: [4, 4, 4],
    maxDim: 4,
    materials: { WoodPlanks: 40, CorrodedMetal: 28 },
    materialVariants: [],
    textures: [],
    meshCount: 0,
    meshes: [],
    polycount: { triangles: 0, measuredMeshes: 0, unmeasuredMeshes: 0 },
    collision: { canCollide: 68, preciseDecomposition: 0, fidelity: {} },
    lod: { renderFidelity: {}, modelStreaming: 'Default', levelOfDetail: 'Automatic' },
    dependencies: [],
    dependencyCount: 0,
    scripts: [{ path: 'Workspace.Crate.Generator', class: 'Script', lines: 120, enabled: true, risk: [] }],
    scriptCount: 1,
    lights: 0,
    particles: 0,
    sounds: 0,
    parameters: { WoodColor: 'b48250', RBX_AI_GENERATED: true },
    tags: ['PrimitiveGen_e0f38d1e'],
    findings: [{ severity: 'warn', message: '1 script(s) inside' }],
    ...over,
  };
}

describe('asset result parsing', () => {
  it('reads insert_asset placements, tag and asset id', () => {
    const r = parseAssetResult('insert_asset', { assetId: '2128776869' }, INSERT_RESULT);
    expect(r.instancePaths).toEqual(['Workspace.Low Poly Rock Pack']);
    expect(r.tags).toEqual(['Assistant:d4d20009-e823-45ce-979f-8b0e954b2135']);
    expect(r.robloxAssetId).toBe('2128776869');
    expect(r.name).toBe('Low Poly Rock Pack');
    expect(r.pending).toBe(false);
    expect(r.sandboxed).toBe(false);
  });

  it('recognizes an async start and a finished job envelope', () => {
    const start = parseAssetResult('generate_procedural_model', { prompt: 'a crate', async: true }, ASYNC_START);
    expect(start.pending).toBe(true);
    expect(start.jobId).toBe('1ffe6dbe-ac9a-448f-a0e6-4f4f484bebc4');
    const done = parseAssetResult('wait_job_finished', { jobId: '1ffe6dbe-ac9a-448f-a0e6-4f4f484bebc4' }, JOB_DONE);
    expect(done.pending).toBe(false);
    expect(done.failed).toBe(false);
    expect(done.jobId).toBe('1ffe6dbe-ac9a-448f-a0e6-4f4f484bebc4');
    expect(done.tags).toEqual(['PrimitiveGen_e0f38d1e']);
    expect(done.name).toBe('Crate');
    expect(done.instancePaths).toEqual([]);
  });

  it('flags failed jobs and tolerates non-JSON text', () => {
    expect(parseAssetResult('wait_job_finished', { jobId: 'x' }, JSON.stringify({ status: 'Failed' })).failed).toBe(true);
    const plain = parseAssetResult('upload_image', {}, 'uploaded: rbxassetid://123456789');
    expect(plain.robloxAssetId).toBe('123456789');
    expect(plain.json).toBeNull();
  });

  it('diffs children and picks watched parents', () => {
    const before = { Workspace: { _: true, '1': 'Workspace.Baseplate' } };
    const after = { Workspace: { _: true, '1': 'Workspace.Baseplate', '2': 'Workspace.Crate' } };
    expect(diffChildren(before, after)).toEqual(['Workspace.Crate']);
    expect(diffChildren(null, after)).toEqual([]);
    expect(watchRoots('insert_asset', { parentPath: 'game.Workspace.Props' })).toEqual(['Workspace', 'Workspace.Props']);
    expect(watchRoots('segment_mesh', { instance_path: 'Workspace.Props.Tree' })).toContain('Workspace.Props');
    expect(watchRoots('generate_material', {})).toContain('MaterialService');
  });
});

describe('asset library', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('records insertions, treats re-insertion as reuse, versions modifications and keeps history', () => {
    const svc = new AssetService(new Store(':memory:', PROJECT_MIGRATIONS));
    const a = svc.record({ name: 'Low Poly Rock Pack', kind: 'model', source: 'studio:insert_asset by roblox-engineer', robloxAssetId: '2128776869', instancePaths: ['Workspace.Rocks'], event: 'inserted', actor: 'roblox-engineer', taskId: 't1' });
    expect(a.version).toBe(1);
    const again = svc.record({ name: 'Low Poly Rock Pack', kind: 'model', source: 'studio:insert_asset by roblox-engineer', robloxAssetId: '2128776869', instancePaths: ['Workspace.Rocks2'], event: 'inserted', actor: 'roblox-engineer' });
    expect(again.id).toBe(a.id);
    expect(again.version).toBe(1);
    expect(again.instancePaths).toEqual(['Workspace.Rocks', 'Workspace.Rocks2']);
    expect(svc.bumpVersion(a.id).version).toBe(2);
    const analyzed = svc.setAnalysis(a.id, analysis({ path: 'Workspace.Rocks3' }), 'qa-engineer')!;
    expect(analyzed.analysis?.parts).toBe(68);
    expect(analyzed.instancePaths).toContain('Workspace.Rocks3');
    expect(svc.history(a.id).map((e) => e.kind)).toEqual(['inserted', 'reused', 'analyzed']);
    expect(svc.history(a.id)[0]!.taskId).toBe('t1');
  });

  it('finds assets by relevance, job id and placement', () => {
    const svc = new AssetService(new Store(':memory:', PROJECT_MIGRATIONS));
    const crate = svc.record({ name: 'Crate', kind: 'model', source: 'studio:generate_procedural_model by x', metadata: { jobId: 'job-1', args: { prompt: 'wooden supply crate' } }, event: 'pending', actor: 'x' });
    svc.record({ name: 'Rock', kind: 'mesh', source: 'studio:generate_mesh by x', metadata: { args: { textPrompt: 'mossy rock, wooden sign' } }, event: 'generated', actor: 'x' });
    svc.setAnalysis(crate.id, analysis(), 'x');
    expect(svc.search('crate')[0]!.id).toBe(crate.id);
    expect(svc.search('wooden').map((a) => a.name)).toEqual(['Crate', 'Rock']);
    expect(svc.search('woodplanks')[0]!.id).toBe(crate.id); // material from the analysis
    expect(svc.search('woodcolor')[0]!.id).toBe(crate.id); // procedural parameter
    expect(svc.search('wooden', { kind: 'mesh' }).map((a) => a.name)).toEqual(['Rock']);
    expect(svc.search('nothing-matches')).toEqual([]);
    expect(svc.byJob('job-1')?.id).toBe(crate.id);
    expect(svc.byInstancePath('Workspace.Crate.Lid.Hinge')?.id).toBe(crate.id);
    expect(svc.byInstancePath('Workspace.Other')).toBeNull();
    expect(analysisSummary(analysis())).toContain('68 parts');
  });

  it('picks assets relevant to a task description for context packages', () => {
    const svc = new AssetService(new Store(':memory:', PROJECT_MIGRATIONS));
    for (const n of ['Oak Tree', 'Pine Tree', 'Boulder', 'Crate', 'Barrel', 'Lantern', 'Fence', 'Torch']) {
      svc.record({ name: n, kind: 'model', source: 'x', event: 'generated', actor: 'x' });
    }
    expect(svc.count()).toBe(8);
    const hits = svc.relevant('Place harvestable trees and a boulder field in the Wildrim; trees drop wood', 6).map((a) => a.name);
    expect(hits.slice(0, 3).sort()).toEqual(['Boulder', 'Oak Tree', 'Pine Tree']);
    expect(hits).not.toContain('Lantern');
    expect(svc.relevant('nothing in common here', 6)).toEqual([]);
  });

  it('migrates a v1 project database without losing assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-assets-'));
    dirs.push(dir);
    const path = join(dir, 'project.db');
    const v1 = new Store(path, PROJECT_MIGRATIONS.filter((m) => m.version === 1));
    v1.run("INSERT INTO assets (id, name, kind, version, source, roblox_asset_id, path, preview_path, metadata, created_at, updated_at) VALUES ('asset_old', 'Old', 'model', 3, 'studio:insert_asset', '42', NULL, NULL, '{}', '2026-01-01', '2026-01-01')");
    v1.close();
    const v2 = new Store(path, PROJECT_MIGRATIONS);
    const svc = new AssetService(v2);
    const old = svc.get('asset_old')!;
    expect(old.version).toBe(3);
    expect(old.instancePaths).toEqual([]);
    expect(old.tags).toEqual([]);
    expect(old.analysis).toBeNull();
    svc.addEvent(old.id, 'note', 'user', 'migrated');
    expect(svc.history(old.id)).toHaveLength(1);
    v2.close();
  });
});

describe('Creator Store search results', () => {
  it('compacts raw results to one line per new free asset', async () => {
    const { compactStoreResults } = await import('../src/core/roblox/store-search');
    const raw = JSON.stringify({
      status: 'success',
      results: [
        { assetId: '1', name: 'sword   swing', creatorName: 'ProSoundEffects', description: 'Audio', isFree: true },
        { assetId: '2', name: 'clang', creatorName: 'APMOfficial', description: 'A heavy metal clang\nfor blocks', isFree: true },
        { assetId: '3', name: 'paid', creatorName: 'x', isFree: false },
        { assetId: '1', name: 'dupe', creatorName: 'y', isFree: true },
      ],
    });
    const seen = new Set<string>();
    expect(compactStoreResults(raw, 'Audio', seen)).toEqual(['1 | sword swing | ProSoundEffects', '2 | clang | APMOfficial | A heavy metal clang for blocks']);
    expect(compactStoreResults(raw, 'Audio', seen)).toEqual([]);
    expect(compactStoreResults('not json', 'Audio', seen)).toBeNull();
  });
});
