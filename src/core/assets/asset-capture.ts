import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import { LUAU_ASSET_ANALYZE, LUAU_CHILD_IDS, LUAU_TAGGED, LUAU_TAG_ADD } from '../roblox/luau-snippets';
import { ASSET_TOOLS, AssetService, analysisSummary, type AssetAnalysis, type AssetEventKind, type AssetKind, type AssetRecord } from './asset-service';

export interface ParsedAssetResult {
  robloxAssetId: string | null;
  name: string | null;
  instancePaths: string[];
  tags: string[];
  jobId: string | null;
  /** An async job was started; the asset appears when it completes (wait_job_finished). */
  pending: boolean;
  failed: boolean;
  sandboxed: boolean | null;
  isPackage: boolean | null;
  json: Record<string, unknown> | null;
}

/** Children (debug id -> path) of each watched parent, taken before and after an asset tool call. */
export type ChildIds = Record<string, Record<string, string | boolean>>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null);
const stripGame = (p: string) => p.replace(/^game\./, '');

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Pulls what the asset library needs out of a Studio asset tool result. Formats observed on
 * 2026-09-28: insert_asset returns {insertedInstances:[{fullPath}], tag, assetId, sandboxed, isPackage};
 * async tools return {jobId, status:"Running"}; wait_job_finished returns {status, jobResult:{structuredContent,
 * content:[{text}]}}; procedural models report {generationName, generationId, tag} without a path.
 */
export function parseAssetResult(tool: string, args: Record<string, unknown>, text: string): ParsedAssetResult {
  let json = parseJson(text);
  // Unwrap wait_job_finished envelopes.
  const jobResult = json?.jobResult as Record<string, unknown> | undefined;
  if (jobResult && typeof jobResult === 'object') {
    const inner = (jobResult.structuredContent as Record<string, unknown> | undefined) ?? null;
    const contentText = Array.isArray(jobResult.content) ? (jobResult.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('') : '';
    json = { ...json, ...(parseJson(contentText) ?? {}), ...(inner ?? {}) };
  }
  const paths = new Set<string>();
  const tags = new Set<string>();
  const inserted = json?.insertedInstances;
  if (Array.isArray(inserted)) for (const i of inserted as Array<Record<string, unknown>>) if (str(i.fullPath)) paths.add(stripGame(String(i.fullPath)));
  for (const k of ['fullPath', 'instancePath', 'path']) if (str(json?.[k]) && /^(game\.)?[A-Z]/.test(String(json![k]))) paths.add(stripGame(String(json![k])));
  if (str(json?.tag)) tags.add(String(json!.tag));
  if (Array.isArray(json?.tags)) for (const t of json!.tags as unknown[]) if (str(t)) tags.add(String(t));
  const status = str(json?.status);
  const jobId = str(json?.jobId) ?? (tool === 'wait_job_finished' ? str(args.jobId) : null);
  const assetId =
    str(json?.assetId) ??
    str(args.assetId) ??
    str(args.asset_id) ??
    (/rbxassetid:\/\/(\d+)/.exec(text)?.[1] ?? null);
  const name =
    str(json?.assetName) ?? str(json?.generationName) ?? str(json?.name) ?? str(args.assetName) ?? str(args.materialId) ?? str(args.textPrompt) ?? str(args.prompt) ?? str(args.query) ?? null;
  return {
    robloxAssetId: assetId,
    name,
    instancePaths: [...paths],
    tags: [...tags],
    jobId,
    pending: tool !== 'wait_job_finished' && !!jobId && (status === 'Running' || status === 'Pending' || status === 'Queued'),
    failed: status === 'Failed' || status === 'Cancelled' || json?.isError === true || (jobResult as Record<string, unknown> | undefined)?.isError === true,
    sandboxed: typeof json?.sandboxed === 'boolean' ? json.sandboxed : null,
    isPackage: typeof json?.isPackage === 'boolean' ? json.isPackage : null,
    json,
  };
}

/** Parents to diff around a call, for tools that do not report where they put things. */
export function watchRoots(tool: string, args: Record<string, unknown>): string[] {
  const roots = new Set<string>(['Workspace']);
  const parentPath = str(args.parentPath);
  if (parentPath) roots.add(stripGame(parentPath));
  const target = str(args.instance_path);
  if (target && tool === 'segment_mesh') roots.add(stripGame(target).split('.').slice(0, -1).join('.') || 'Workspace');
  if (tool === 'generate_material') roots.add('MaterialService');
  return [...roots];
}

export function diffChildren(before: ChildIds | null, after: ChildIds | null): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  for (const [root, ids] of Object.entries(after)) {
    const prev = before[root] ?? {};
    for (const [id, path] of Object.entries(ids)) if (id !== '_' && typeof path === 'string' && !(id in prev)) out.push(path);
  }
  return [...new Set(out)];
}

const EVENT_FOR: Record<string, AssetEventKind> = {
  insert_asset: 'inserted',
  upload_image: 'uploaded',
  store_image: 'uploaded',
  generate_texture: 'modified',
};

export interface CaptureCall {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  before: ChildIds | null;
  actor: string;
  taskId: string | null;
  runId: string | null;
}

/**
 * Connects Studio's asset tools to the asset library: finds the instances a call placed (reported paths,
 * CollectionService tags, or a before/after diff of the watched parents), tags them for usage tracking,
 * analyzes them in Studio, and records generation / insertion / modification history.
 */
export class AssetCapture {
  constructor(private readonly studio: RobloxStudioAdapter) {}

  static handles(tool: string): boolean {
    return tool in ASSET_TOOLS || tool === 'wait_job_finished';
  }

  async childIds(roots: string[]): Promise<ChildIds | null> {
    try {
      return await this.studio.luauJson<ChildIds>(LUAU_CHILD_IDS.replace('__ROOTS__', () => JSON.stringify(JSON.stringify(roots))));
    } catch {
      return null;
    }
  }

  async tagged(tags: string[]): Promise<string[]> {
    if (!tags.length) return [];
    const r = await this.studio.luauJson<{ paths: string[] | Record<string, never> }>(LUAU_TAGGED.replace('__TAGS__', () => JSON.stringify(JSON.stringify(tags))));
    return Array.isArray(r.paths) ? r.paths : [];
  }

  async tag(paths: string[], tag: string): Promise<string[]> {
    if (!paths.length) return [];
    const r = await this.studio.luauJson<{ tagged: string[] | Record<string, never> }>(
      LUAU_TAG_ADD.replace('__PATHS__', () => JSON.stringify(JSON.stringify(paths))).replace('__TAG__', () => JSON.stringify(tag)),
    );
    return Array.isArray(r.tagged) ? r.tagged : [];
  }

  async analyze(path: string, maxMeshes = 25): Promise<AssetAnalysis> {
    const r = await this.studio.luauJson<AssetAnalysis & { error?: string }>(
      LUAU_ASSET_ANALYZE.replace(/__PATH__/g, () => JSON.stringify(path)).replace('__MAXPOLY__', String(Math.max(0, Math.floor(maxMeshes)))),
    );
    if (r.error) throw new Error(`${r.error}: ${path}`);
    return normalizeAnalysis(r);
  }

  /** Current placed copies of an asset (by its usage tag), refreshing the recorded paths. */
  async usage(svc: AssetService, asset: AssetRecord): Promise<string[]> {
    const tags = [asset.usageTag, ...asset.tags.filter((t) => /^(Assistant:|PrimitiveGen_|ShurikenAsset_)/.test(t))].filter((t): t is string => !!t);
    const paths = tags.length ? await this.tagged([...new Set(tags)]) : [];
    if (paths.length) svc.setInstancePaths(asset.id, paths);
    return paths;
  }

  async capture(svc: AssetService, call: CaptureCall): Promise<{ records: AssetRecord[]; report: string[] }> {
    const parsed = parseAssetResult(call.tool, call.args, call.text);
    const report: string[] = [];
    const kind: AssetKind = ASSET_TOOLS[call.tool] ?? 'model';
    const meta = { tool: call.tool, args: call.args, result: call.text.slice(0, 2000), sandboxed: parsed.sandboxed, isPackage: parsed.isPackage };

    if (call.tool === 'wait_job_finished') {
      const pending = parsed.jobId ? svc.byJob(parsed.jobId) : null;
      if (parsed.failed) {
        if (pending) svc.addEvent(pending.id, 'note', call.actor, `generation job ${parsed.jobId} ended without a result`, { result: call.text.slice(0, 2000) }, call.taskId, call.runId);
        return { records: pending ? [pending] : [], report };
      }
      const paths = await this.locate(parsed, call);
      if (!pending && !paths.length) return { records: [], report };
      const rec = pending
        ? svc.update(pending.id, { name: parsed.name ?? pending.name, instancePaths: paths, metadata: { completed: meta, pending: false } })!
        : svc.record({ name: parsed.name ?? 'generated asset', kind, source: `studio:generation by ${call.actor}`, instancePaths: paths, metadata: { ...meta, jobId: parsed.jobId }, event: 'generated', actor: call.actor, taskId: call.taskId, runId: call.runId });
      if (pending) svc.addEvent(rec.id, 'generated', call.actor, `generation job ${parsed.jobId} completed${paths.length ? ` → ${paths.join(', ')}` : ''}`, null, call.taskId, call.runId);
      return { records: [await this.finish(svc, rec, paths, parsed.tags, call, report)], report };
    }

    if (parsed.pending) {
      const rec = svc.record({
        name: parsed.name ?? `${call.tool} job`,
        kind,
        source: `studio:${call.tool} by ${call.actor}`,
        metadata: { ...meta, jobId: parsed.jobId, pending: true },
        event: 'pending',
        actor: call.actor,
        taskId: call.taskId,
        runId: call.runId,
        summary: `async generation started (job ${parsed.jobId})`,
      });
      report.push(`Asset library: recorded pending generation ${rec.id} (job ${parsed.jobId}). Call wait_job_finished to place it; Shuriken records and analyzes it then.`);
      return { records: [rec], report };
    }

    if (call.tool === 'generate_texture') {
      const target = str(call.args.instance_path) ? stripGame(String(call.args.instance_path)) : null;
      const owner = target ? svc.byInstancePath(target) : null;
      let rec: AssetRecord;
      if (owner) {
        svc.addEvent(owner.id, 'modified', call.actor, `re-textured: ${str(call.args.textPrompt) ?? ''}`.trim(), meta, call.taskId, call.runId);
        rec = svc.bumpVersion(owner.id);
      } else {
        rec = svc.record({ name: parsed.name ?? 'texture', kind, source: `studio:${call.tool} by ${call.actor}`, instancePaths: target ? [target] : [], metadata: meta, event: 'modified', actor: call.actor, taskId: call.taskId, runId: call.runId });
      }
      return { records: [await this.finish(svc, rec, target ? [target] : [], [], call, report)], report };
    }

    const paths = kind === 'image' ? [] : await this.locate(parsed, call);
    const rec = svc.record({
      name: (parsed.name ?? `${call.tool} result`).slice(0, 120),
      kind,
      source: `studio:${call.tool} by ${call.actor}`,
      robloxAssetId: parsed.robloxAssetId,
      instancePaths: paths,
      metadata: meta,
      event: EVENT_FOR[call.tool] ?? 'generated',
      actor: call.actor,
      taskId: call.taskId,
      runId: call.runId,
    });
    if (kind === 'image' || kind === 'material') {
      report.push(`Asset library: recorded ${kind} "${rec.name}" (${rec.id}${rec.robloxAssetId ? `, rbxassetid://${rec.robloxAssetId}` : ''}).`);
      return { records: [rec], report };
    }
    return { records: [await this.finish(svc, rec, paths, parsed.tags, call, report)], report };
  }

  /** Where the call put things: reported paths, else tagged instances, else new children of the watched parents. */
  private async locate(parsed: ParsedAssetResult, call: CaptureCall): Promise<string[]> {
    if (parsed.instancePaths.length) return parsed.instancePaths;
    try {
      const byTag = await this.tagged(parsed.tags);
      if (byTag.length) return byTag;
    } catch {
      /* Studio busy (e.g. in a playtest): fall through */
    }
    if (!call.before) return [];
    return diffChildren(call.before, await this.childIds(Object.keys(call.before)));
  }

  /** Tags placed roots for usage tracking and analyzes the first few; failures degrade to a note. */
  private async finish(svc: AssetService, rec: AssetRecord, paths: string[], tags: string[], call: CaptureCall, report: string[]): Promise<AssetRecord> {
    const usageTag = `ShurikenAsset_${rec.id}`;
    let out = rec;
    try {
      if (paths.length) {
        await this.tag(paths, usageTag);
        out = svc.update(rec.id, { usageTag, tags: [...new Set([...rec.tags, ...tags])] }) ?? out;
      }
      const analyses: AssetAnalysis[] = [];
      for (const p of paths.slice(0, 3)) analyses.push(await this.analyze(p));
      if (analyses[0]) out = svc.setAnalysis(rec.id, analyses[0], call.actor, call.taskId, call.runId) ?? out;
      report.push(`Asset library: ${rec.name} (${rec.id}${rec.robloxAssetId ? `, rbxassetid://${rec.robloxAssetId}` : ''})${paths.length ? ` at ${paths.join(', ')}` : ' (placement not found)'}${analyses[0] ? ` — ${analysisSummary(analyses[0])}` : ''}.`);
      for (const a of analyses) for (const f of a.findings.filter((x) => x.severity !== 'info')) report.push(`  ${f.severity.toUpperCase()}: ${f.message}`);
      if (analyses[0]?.parameters && Object.keys(analyses[0].parameters).length) report.push(`  Parameters (root attributes): ${Object.keys(analyses[0].parameters).filter((k) => !k.startsWith('RBX_')).join(', ')}`);
    } catch (e) {
      svc.addEvent(rec.id, 'note', call.actor, `analysis unavailable: ${(e as Error).message}`.slice(0, 400), null, call.taskId, call.runId);
      report.push(`Asset library: recorded ${rec.name} (${rec.id}); analysis unavailable (${(e as Error).message.slice(0, 160)}). Retry with asset_analyze.`);
    }
    return out;
  }
}

/** Luau encodes empty tables as arrays; make the shape predictable for the UI and tools. */
function normalizeAnalysis(a: AssetAnalysis): AssetAnalysis {
  const obj = <T extends object>(v: unknown): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : ({} as T));
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ...a,
    counts: obj(a.counts),
    materials: obj(a.materials),
    materialVariants: arr(a.materialVariants),
    textures: arr(a.textures),
    meshes: arr(a.meshes),
    collision: { ...a.collision, fidelity: obj(a.collision?.fidelity) },
    lod: { ...a.lod, renderFidelity: obj(a.lod?.renderFidelity) },
    dependencies: arr<{ id: string; kinds: string[] }>(a.dependencies).map((d) => ({ ...d, kinds: arr(d.kinds) })),
    scripts: arr<AssetAnalysis['scripts'][number]>(a.scripts).map((s) => ({ ...s, risk: arr(s.risk) })),
    parameters: obj(a.parameters),
    tags: arr(a.tags),
    findings: arr(a.findings),
  };
}
