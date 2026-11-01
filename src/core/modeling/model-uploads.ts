import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { uploadBlocker } from '../roblox/content-rules';
import type { OpenCloudAssets, PollOptions, UploadResult } from '../roblox/open-cloud-assets';
import { UPLOAD_CONCURRENCY, UploadQueue, WAIT_AGENT_MS, type UploadProgress } from '../roblox/upload-queue';
import { GLB_FACING, glbTurned180 } from './glb';
import { ModelStore, type ModelMeta } from './model-store';

export { UPLOAD_CONCURRENCY, WAIT_AGENT_MS, WAIT_UI_MS, WAIT_WITH_PROGRESS_MS, waitBudget, type UploadProgress } from '../roblox/upload-queue';

/**
 * Uploads a model's parts to Roblox (Open Cloud) and keeps what came of each upload in its record in the
 * model store (`ModelMeta.upload`): the asset id, or the operation Roblox is still processing, or why it
 * failed. A part's upload belongs to the part, not to the agent run that asked for it: it is never
 * aborted with the run, it records its result when it finishes, and a later call (another run, another
 * tool) finds the id, resolves the pending operation or joins the upload still running.
 */

/** How long one upload waits for Roblox to process a mesh before it is kept as pending (the next call resolves it). */
export const UPLOAD_WAIT_MS = 180_000;
/** How long a call asks about an upload that was still pending the last time. */
export const RESOLVE_WAIT_MS = 60_000;
/** Polling an upload Roblox is processing backs off to a question every 10 s. */
const POLL: PollOptions = { maxDelayMs: 10_000 };

export interface ModelUploadDeps {
  cloud: Pick<OpenCloudAssets, 'configured' | 'upload' | 'wait'>;
  uploads: () => { enabled: boolean; creatorId: string | null };
  /** The Roblox user uploads go to (asks Studio when Settings doesn't say). */
  creator: () => Promise<string | null>;
  /** A part got its asset id (the asset library records it). */
  uploaded?: (meta: ModelMeta, assetId: string) => void;
  /** A look at an image for what a scan can't measure (links, handles, real brands as lettering): what it found, or null (roblox/image-screen.ts). */
  screen?: (root: string, file: string) => Promise<string | null>;
  /** Waits and polling, for tests (defaults: UPLOAD_WAIT_MS, RESOLVE_WAIT_MS and a question every 1–10 s). */
  timing?: { uploadWaitMs?: number; resolveWaitMs?: number; poll?: PollOptions };
  /** Parts uploaded at once (default UPLOAD_CONCURRENCY). */
  concurrency?: number;
}

/** What became of one part's upload. */
export interface PartUpload {
  name: string;
  assetId: string | null;
  /** The part's record as it is now (with the upload's outcome). */
  meta: ModelMeta;
  /** Roblox is still processing it: kept, the next call picks it up. */
  pending?: boolean;
  /** Why there is no asset id (failed, switched off, still processing, changed meanwhile). */
  why?: string;
  /** Uploaded earlier for this exact build: nothing was sent. */
  reused?: boolean;
  /** What stopped it is the user's to fix (no key, no permission, unknown creator). */
  needsUser?: boolean;
}

/**
 * Why Roblox's moderation would remove one of the part's images, or null (see roblox/content-rules.ts). Only the
 * colour map is read: a glow mask is lettering in black and white, and a code in it is in the colour map too.
 */
export function moderationBlocker(store: ModelStore, part: ModelMeta): string | null {
  const file = part.textures?.color;
  if (!file) return null;
  const found = uploadBlocker(join(dirname(store.paths(part.name).glb), file));
  return found
    ? `its texture ${file} has ${found}, so it was NOT uploaded: Roblox removes images with QR codes ("Directing Users Off-Platform") and that counts against the user's account. Have that area repainted (kiln_request kind "fix": "remove the QR code from this material; a pay panel gets a contactless-wave icon or a plain reader"), then place the model again`
    : null;
}

export class ModelUploads {
  private readonly queue: UploadQueue<PartUpload>;
  private creatorLookup: Promise<string | null> | null = null;

  constructor(private readonly d: ModelUploadDeps) {
    this.queue = new UploadQueue(() => d.concurrency ?? UPLOAD_CONCURRENCY);
  }

  /** Parts of this project whose current build is being uploaded (or waits its turn) right now. */
  uploading(root: string): string[] {
    const prefix = `${root}\n`;
    return this.queue
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.split('\n')[1]!);
  }

  /**
   * Every part's asset id: the ones already uploaded for their current build are left alone (only parts
   * whose mesh or maps changed upload), the rest go up at the same time (up to `concurrency`), and parts
   * another call is already uploading are joined, never sent twice. Waits at most `budgetMs` (and not
   * after `signal` aborts): the uploads that haven't finished then carry on in the background, record
   * themselves in the model store, and come back as `stillUploading` for the caller to say "call again".
   * `onProgress` reports as parts finish and every 15 s meanwhile.
   */
  ensureMany(
    root: string,
    parts: ModelMeta[],
    opts: { budgetMs?: number; signal?: AbortSignal; onProgress?: (p: UploadProgress) => void; heartbeatMs?: number } = {},
  ): Promise<{ results: PartUpload[]; stillUploading: string[] }> {
    const store = new ModelStore(root);
    // Every new texture is looked at now, together, instead of when its part gets an upload lane: the look takes
    // about as long as the upload, and what was looked at is remembered when the upload asks.
    if (this.d.screen && this.d.uploads().enabled) {
      for (const m of parts) {
        const part = store.get(m.name) ?? m;
        if (ModelStore.assetId(part) || ModelStore.pendingOperation(part) || !part.textures?.color || moderationBlocker(store, part)) continue;
        void this.d.screen(root, join(dirname(store.paths(part.name).glb), part.textures.color)).catch(() => null);
      }
    }
    const items = parts.map((m) => ({ name: m.name, needed: !ModelStore.assetId(store.get(m.name) ?? m), promise: this.ensure(root, m) }));
    return this.queue.batch(items, { budgetMs: opts.budgetMs ?? WAIT_AGENT_MS, signal: opts.signal, onProgress: opts.onProgress, heartbeatMs: opts.heartbeatMs, noun: 'part' });
  }

  /**
   * The part's asset id for its current build: already uploaded (nothing sent), the upload another call
   * has under way (joined), the operation Roblox was still processing (asked about, not uploaded again),
   * or a new upload. Never rejects.
   */
  ensure(root: string, m: ModelMeta): Promise<PartUpload> {
    const store = new ModelStore(root);
    // The store is the truth: the part may have been exported again since the caller listed it.
    const part = store.get(m.name) ?? m;
    const have = ModelStore.assetId(part);
    if (have) return Promise.resolve({ name: part.name, assetId: have, meta: part, reused: true });
    return this.queue.run(
      `${root}\n${part.name}\n${part.hash}`,
      () => this.upload(root, store, part),
      (e): PartUpload => ({ name: part.name, assetId: null, meta: part, why: `the upload failed: ${e.message}` }),
    );
  }

  private creatorOnce(): Promise<string | null> {
    this.creatorLookup ??= this.d.creator().finally(() => {
      this.creatorLookup = null;
    });
    return this.creatorLookup;
  }

  private async upload(root: string, store: ModelStore, part: ModelMeta): Promise<PartUpload> {
    const fail = (why: string, needsUser = false): PartUpload => ({ name: part.name, assetId: null, meta: part, why, ...(needsUser ? { needsUser } : {}) });
    const removed = moderationBlocker(store, part);
    if (removed) return fail(removed);
    // Not sent yet (a pending operation was): its colour map is looked at once for links, handles and real brands.
    if (!ModelStore.pendingOperation(part) && part.textures?.color && this.d.screen && this.d.uploads().enabled) {
      const seen = await this.d.screen(root, join(dirname(store.paths(part.name).glb), part.textures.color)).catch(() => null);
      if (seen)
        return fail(`its texture ${part.textures.color} shows ${seen}, so it was NOT uploaded: Roblox removes images that point players off the platform or copy a real brand, and that counts against the user's account. Have that area repainted (kiln_request kind "fix": say what to remove; invented names and plain signage are fine), then place the model again`);
    }
    if (!this.d.uploads().enabled) return fail('uploading is turned off in Settings');
    if (!(await this.d.cloud.configured())) return fail('no Open Cloud API key with the Assets permission is set (Settings → Roblox)', true);
    const operation = ModelStore.pendingOperation(part);
    let r: UploadResult;
    // The pipeline that made the upload: a pending operation keeps the one that started it.
    let facing: number | undefined = part.upload && 'operation' in part.upload ? part.upload.facing : undefined;
    if (operation) {
      // Roblox took this exact build earlier and was still processing it: ask how it went, never send it again.
      r = await this.d.cloud.wait(operation, this.d.timing?.resolveWaitMs ?? RESOLVE_WAIT_MS, undefined, this.d.timing?.poll ?? POLL);
    } else {
      const glb = store.paths(part.name).glb;
      if (!existsSync(glb)) return fail('its mesh file is missing (export the model again)');
      const who = await this.creatorOnce();
      if (!who) return fail('the Roblox creator is unknown (sign in to Studio or set it in Settings)', true);
      // Roblox's importer turns a glTF 180° about Y (glTF's front is +Z, Roblox's -Z): the copy that goes up is
      // turned first, so the part arrives as exported. models/<part>.glb itself stays as it is (the previews read it).
      let turned: Buffer;
      try {
        turned = glbTurned180(readFileSync(glb));
      } catch (e) {
        return fail(`its mesh file couldn't be prepared for Roblox's importer (${(e as Error).message}): export the model again`);
      }
      const dir = mkdtempSync(join(tmpdir(), 'shuriken-glb-upload-'));
      try {
        const file = join(dir, `${part.name}.glb`);
        writeFileSync(file, turned);
        // No AbortSignal on purpose: the upload belongs to the part, it finishes when its run stops.
        r = await this.d.cloud.upload({ file, type: 'Model', name: part.name, description: part.description ?? 'Modeled with Shuriken Studio', creator: { userId: who }, waitMs: this.d.timing?.uploadWaitMs ?? UPLOAD_WAIT_MS, poll: this.d.timing?.poll ?? POLL });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      facing = GLB_FACING;
    }
    return this.record(root, part, r, facing);
  }

  /** Writes the outcome into the part's record (unless the part was exported again meanwhile). */
  private record(root: string, part: ModelMeta, r: UploadResult, facing?: number): PartUpload {
    const store = new ModelStore(root);
    const cur = store.get(part.name);
    // Exported again (or removed) while this went on: the outcome is for an older build, don't touch the new one.
    if (!cur || cur.hash !== part.hash) return { name: part.name, assetId: null, meta: cur ?? part, why: 'it changed while it was uploading: call again to upload the new version' };
    const at = new Date().toISOString();
    const upload: NonNullable<ModelMeta['upload']> =
      r.ok && r.assetId
        ? { assetId: r.assetId, hash: part.hash, at, ...(facing ? { facing } : {}) }
        : r.pending && r.operation
          ? { operation: r.operation, hash: part.hash, at, ...(facing ? { facing } : {}) }
          : { error: r.error ?? 'upload failed', hash: part.hash, at };
    // world/Models.luau lists placed models only: a part that is placed nowhere can't change it (a map uploads hundreds).
    const meta = store.save({ ...cur, upload }, { deferBuilder: !cur.placements.length });
    if (r.ok && r.assetId) {
      this.d.uploaded?.(meta, r.assetId);
      return { name: part.name, assetId: r.assetId, meta };
    }
    if (r.pending && r.operation) return { name: part.name, assetId: null, meta, pending: true, why: 'Roblox is still processing the upload (it is kept: the next call picks it up)' };
    return { name: part.name, assetId: null, meta, why: r.error ?? 'upload failed', ...(r.needsUser ? { needsUser: true } : {}) };
  }
}
