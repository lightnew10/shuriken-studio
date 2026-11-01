import { newId, nowIso } from '@shared/ids';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';

export type AssetKind = 'model' | 'mesh' | 'material' | 'texture' | 'image' | 'audio' | 'animation' | 'effect' | 'other';

/** What Shuriken measured about an asset instance in Studio (see LUAU_ASSET_ANALYZE). */
export interface AssetAnalysis {
  path: string;
  className: string;
  name: string;
  instanceCount: number;
  counts: Record<string, number>;
  parts: number;
  anchored: number;
  mass: number;
  bbox: number[];
  maxDim: number;
  materials: Record<string, number>;
  materialVariants: string[];
  textures: string[];
  meshCount: number;
  meshes: Array<{ path: string; meshId: string; textureId: string; size: number[]; meshSize: number[]; collision: string; render: string; triangles?: number }>;
  polycount: { triangles: number; measuredMeshes: number; unmeasuredMeshes: number; reason?: string | null };
  collision: { canCollide: number; preciseDecomposition: number; fidelity: Record<string, number> };
  lod: { renderFidelity: Record<string, number>; modelStreaming?: string | null; levelOfDetail?: string | null };
  dependencies: Array<{ id: string; kinds: string[] }>;
  dependencyCount: number;
  scripts: Array<{ path: string; class: string; lines: number; enabled: boolean; risk: string[] }>;
  scriptCount: number;
  lights: number;
  particles: number;
  sounds: number;
  /** Root attributes: the tunable parameters of procedural models. */
  parameters: Record<string, unknown>;
  tags: string[];
  sandboxed?: boolean | null;
  findings: Array<{ severity: 'info' | 'warn' | 'high'; message: string }>;
}

export interface AssetRecord {
  id: string;
  name: string;
  kind: AssetKind;
  version: number;
  source: string;
  robloxAssetId: string | null;
  path: string | null;
  previewPath: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  /** Where the asset was placed in the DataModel when Shuriken last saw it. */
  instancePaths: string[];
  /** CollectionService tag that marks every placed copy (usage tracking). */
  usageTag: string | null;
  analysis: AssetAnalysis | null;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AssetEventKind = 'inserted' | 'generated' | 'uploaded' | 'registered' | 'reused' | 'modified' | 'analyzed' | 'pending' | 'note';

export interface AssetEvent {
  id: string;
  assetId: string;
  kind: AssetEventKind;
  actor: string;
  taskId: string | null;
  runId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecordInput {
  name: string;
  kind: AssetKind;
  source: string;
  robloxAssetId?: string | null;
  path?: string | null;
  previewPath?: string | null;
  metadata?: Record<string, unknown>;
  tags?: string[];
  instancePaths?: string[];
  usageTag?: string | null;
  event: AssetEventKind;
  actor: string;
  taskId?: string | null;
  runId?: string | null;
  summary?: string;
}

interface AssetRow {
  id: string;
  name: string;
  kind: AssetKind;
  version: number;
  source: string;
  roblox_asset_id: string | null;
  path: string | null;
  preview_path: string | null;
  metadata: string | null;
  tags: string;
  instance_paths: string;
  usage_tag: string | null;
  analysis: string | null;
  analyzed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One-line description of an analysis, used in history entries and tool output. */
export function analysisSummary(a: AssetAnalysis): string {
  const bits = [`${a.className}`, `${a.parts} part${a.parts === 1 ? '' : 's'}`];
  if (a.meshCount) bits.push(`${a.meshCount} mesh${a.meshCount === 1 ? '' : 'es'}`);
  if (a.polycount.measuredMeshes) bits.push(`${a.polycount.triangles} tris measured`);
  if (a.scriptCount) bits.push(`${a.scriptCount} script${a.scriptCount === 1 ? '' : 's'}`);
  bits.push(`bbox ${a.bbox.map((n) => Math.round(n * 10) / 10).join('×')}`);
  const high = a.findings.filter((f) => f.severity === 'high').length;
  const warn = a.findings.filter((f) => f.severity === 'warn').length;
  if (high || warn) bits.push(`${high ? `${high} high` : ''}${high && warn ? ', ' : ''}${warn ? `${warn} warn` : ''} finding(s)`);
  return bits.join(' · ');
}

/**
 * Project asset library. Every asset agents insert, generate or upload is recorded with its source and
 * generation parameters; Shuriken analyzes placed instances in Studio (geometry, materials, polycount,
 * collision, LOD, dependencies, scripts) and keeps a history of generation, reuse and modification, so
 * agents can find and reuse assets instead of regenerating them.
 */
export class AssetService {
  constructor(private readonly store: Store) {}

  /**
   * Records an asset event. The same Roblox asset inserted again is a reuse of the existing record
   * (usage grows, version stays); `modified` bumps the version.
   */
  record(input: RecordInput): AssetRecord {
    const ts = nowIso();
    const existing = input.robloxAssetId
      ? this.store.get<{ id: string }>('SELECT id FROM assets WHERE roblox_asset_id = ? ORDER BY created_at LIMIT 1', [input.robloxAssetId])
      : undefined;
    if (existing) {
      const cur = this.get(existing.id)!;
      const paths = [...new Set([...cur.instancePaths, ...(input.instancePaths ?? [])])];
      const kind: AssetEventKind = input.event === 'inserted' || input.event === 'generated' ? 'reused' : input.event;
      this.store.run('UPDATE assets SET instance_paths = ?, usage_tag = COALESCE(usage_tag, ?), version = version + ?, updated_at = ? WHERE id = ?', [
        j(paths),
        input.usageTag ?? null,
        kind === 'modified' ? 1 : 0,
        ts,
        cur.id,
      ]);
      this.addEvent(cur.id, kind, input.actor, input.summary ?? `${kind} via ${input.source}`, { ...(input.metadata ?? {}), instancePaths: input.instancePaths ?? [] }, input.taskId, input.runId);
      return this.get(cur.id)!;
    }
    const id = newId('asset');
    this.store.run(
      `INSERT INTO assets (id, name, kind, version, source, roblox_asset_id, path, preview_path, metadata, tags, instance_paths, usage_tag, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.kind,
        input.source,
        input.robloxAssetId ?? null,
        input.path ?? null,
        input.previewPath ?? null,
        j(input.metadata ?? {}),
        j(input.tags ?? []),
        j(input.instancePaths ?? []),
        input.usageTag ?? null,
        ts,
        ts,
      ],
    );
    this.addEvent(id, input.event, input.actor, input.summary ?? `${input.event} via ${input.source}`, input.metadata ?? null, input.taskId, input.runId);
    return this.get(id)!;
  }

  /** Updates fields of an existing record (e.g. when an async generation completes). */
  update(id: string, patch: { name?: string; robloxAssetId?: string | null; instancePaths?: string[]; usageTag?: string | null; metadata?: Record<string, unknown>; tags?: string[] }): AssetRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.store.run('UPDATE assets SET name = ?, roblox_asset_id = ?, instance_paths = ?, usage_tag = ?, metadata = ?, tags = ?, updated_at = ? WHERE id = ?', [
      patch.name ?? cur.name,
      patch.robloxAssetId !== undefined ? patch.robloxAssetId : cur.robloxAssetId,
      j(patch.instancePaths ?? cur.instancePaths),
      patch.usageTag !== undefined ? patch.usageTag : cur.usageTag,
      j(patch.metadata ? { ...cur.metadata, ...patch.metadata } : cur.metadata),
      j(patch.tags ?? cur.tags),
      nowIso(),
      id,
    ]);
    return this.get(id);
  }

  setAnalysis(id: string, analysis: AssetAnalysis, actor: string, taskId?: string | null, runId?: string | null): AssetRecord | null {
    const ts = nowIso();
    const cur = this.get(id);
    if (!cur) return null;
    const paths = cur.instancePaths.includes(analysis.path) ? cur.instancePaths : [...cur.instancePaths, analysis.path];
    this.store.run('UPDATE assets SET analysis = ?, analyzed_at = ?, instance_paths = ?, updated_at = ? WHERE id = ?', [j(analysis), ts, j(paths), ts, id]);
    this.addEvent(id, 'analyzed', actor, analysisSummary(analysis), { path: analysis.path, findings: analysis.findings }, taskId, runId);
    return this.get(id);
  }

  /** A new version of the asset (its content changed, e.g. re-textured in place). */
  bumpVersion(id: string): AssetRecord {
    this.store.run('UPDATE assets SET version = version + 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
    return this.get(id)!;
  }

  setInstancePaths(id: string, paths: string[]): void {
    this.store.run('UPDATE assets SET instance_paths = ?, updated_at = ? WHERE id = ?', [j(paths), nowIso(), id]);
  }

  addEvent(assetId: string, kind: AssetEventKind, actor: string, summary: string, data?: Record<string, unknown> | null, taskId?: string | null, runId?: string | null): void {
    this.store.run('INSERT INTO asset_events (id, asset_id, kind, actor, task_id, run_id, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      newId('aev'),
      assetId,
      kind,
      actor,
      taskId ?? null,
      runId ?? null,
      summary.slice(0, 500),
      data ? j(data) : null,
      nowIso(),
    ]);
  }

  history(assetId: string): AssetEvent[] {
    return this.store
      .all<{ id: string; asset_id: string; kind: AssetEventKind; actor: string; task_id: string | null; run_id: string | null; summary: string; data: string | null; created_at: string }>(
        'SELECT * FROM asset_events WHERE asset_id = ? ORDER BY created_at, rowid',
        [assetId],
      )
      .map((r) => ({ id: r.id, assetId: r.asset_id, kind: r.kind, actor: r.actor, taskId: r.task_id, runId: r.run_id, summary: r.summary, data: r.data ? pj(r.data, null) : null, createdAt: r.created_at }));
  }

  get(id: string): AssetRecord | null {
    const r = this.store.get<AssetRow>('SELECT * FROM assets WHERE id = ?', [id]);
    return r ? this.fromRow(r) : null;
  }

  /** Finds the pending record of an async generation by its Studio job id. */
  byJob(jobId: string): AssetRecord | null {
    const rows = this.store.all<AssetRow>("SELECT * FROM assets WHERE metadata LIKE ? ORDER BY created_at DESC LIMIT 5", [`%${jobId}%`]);
    const hit = rows.map((r) => this.fromRow(r)).find((a) => a.metadata.jobId === jobId);
    return hit ?? null;
  }

  /** The record that owns a placed instance (by exact path, or the nearest recorded ancestor). */
  byInstancePath(path: string): AssetRecord | null {
    let best: AssetRecord | null = null;
    for (const a of this.list()) {
      for (const p of a.instancePaths) {
        if ((path === p || path.startsWith(`${p}.`)) && (!best || p.length > Math.max(...best.instancePaths.map((x) => x.length)))) best = a;
      }
    }
    return best;
  }

  list(query?: string, kind?: string): AssetRecord[] {
    const rows = this.store.all<AssetRow>('SELECT * FROM assets ORDER BY updated_at DESC LIMIT 1000');
    let all = rows.map((r) => this.fromRow(r));
    if (kind) all = all.filter((a) => a.kind === kind);
    if (!query) return all;
    return this.rank(all, query);
  }

  /** Relevance search: every term must match somewhere; name and tag hits rank above metadata hits. */
  search(query: string, opts: { kind?: string; limit?: number } = {}): AssetRecord[] {
    return this.list(query, opts.kind).slice(0, opts.limit ?? 20);
  }

  /**
   * Assets related to a free-text description (e.g. a task), for context packages: any-term matching,
   * ranked by how many terms hit and where. Small libraries are returned whole.
   */
  relevant(text: string, limit = 6): AssetRecord[] {
    const all = this.list();
    if (all.length <= limit) return all;
    // Light plural stemming so "trees" finds "Oak Tree".
    const stem = (t: string) => (t.endsWith('ies') && t.length > 5 ? `${t.slice(0, -3)}y` : t.endsWith('s') && !t.endsWith('ss') && t.length > 4 ? t.slice(0, -1) : t);
    const terms = [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((t) => !STOPWORDS.has(t)).map(stem))].slice(0, 60);
    const scored = all
      .map((a) => {
        const name = a.name.toLowerCase();
        const rest = `${a.tags.join(' ')} ${a.kind} ${JSON.stringify(a.metadata).slice(0, 2000)} ${a.analysis ? Object.keys(a.analysis.parameters).join(' ') : ''}`.toLowerCase();
        let s = 0;
        for (const t of terms) s += (name.includes(t) ? 3 : 0) + (rest.includes(t) ? 1 : 0);
        return { a, s };
      })
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || y.a.updatedAt.localeCompare(x.a.updatedAt));
    return scored.slice(0, limit).map((x) => x.a);
  }

  count(): number {
    return this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM assets')?.n ?? 0;
  }

  private rank(all: AssetRecord[], query: string): AssetRecord[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: Array<{ a: AssetRecord; s: number }> = [];
    for (const a of all) {
      const name = a.name.toLowerCase();
      const tags = a.tags.join(' ').toLowerCase();
      const rest = `${a.kind} ${a.source} ${a.robloxAssetId ?? ''} ${a.instancePaths.join(' ')} ${JSON.stringify(a.metadata)} ${a.analysis ? `${a.analysis.className} ${Object.keys(a.analysis.materials).join(' ')} ${Object.keys(a.analysis.parameters).join(' ')}` : ''}`.toLowerCase();
      let s = 0;
      let all = true;
      for (const t of terms) {
        const hit = (name.includes(t) ? 5 : 0) + (tags.includes(t) ? 3 : 0) + (rest.includes(t) ? 1 : 0);
        if (!hit) all = false;
        s += hit;
      }
      if (all) scored.push({ a, s });
    }
    return scored.sort((x, y) => y.s - x.s || y.a.updatedAt.localeCompare(x.a.updatedAt)).map((x) => x.a);
  }

  private fromRow(r: AssetRow): AssetRecord {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      version: r.version,
      source: r.source,
      robloxAssetId: r.roblox_asset_id,
      path: r.path,
      previewPath: r.preview_path,
      metadata: pj(r.metadata, {}),
      tags: pj(r.tags, []),
      instancePaths: pj(r.instance_paths, []),
      usageTag: r.usage_tag,
      analysis: r.analysis ? pj<AssetAnalysis | null>(r.analysis, null) : null,
      analyzedAt: r.analyzed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'into', 'must', 'should', 'each', 'every', 'when', 'then', 'than', 'have', 'will', 'your', 'task', 'tasks', 'server', 'client', 'player', 'players', 'test', 'tests', 'using', 'used', 'only', 'also', 'more', 'less', 'make', 'sure', 'verify', 'verified', 'data', 'code', 'file', 'files']);

/** Studio MCP tools that bring assets into a place (or change them), and what kind of asset they produce. */
export const ASSET_TOOLS: Record<string, AssetKind> = {
  insert_asset: 'model',
  generate_mesh: 'mesh',
  generate_procedural_model: 'model',
  generate_material: 'material',
  generate_texture: 'texture',
  segment_mesh: 'model',
  upload_image: 'image',
  store_image: 'image',
};
