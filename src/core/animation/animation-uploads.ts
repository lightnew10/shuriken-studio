import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAims } from '@shared/animation';
import type { OpenCloudAssets, PollOptions, UploadResult } from '../roblox/open-cloud-assets';
import { UPLOAD_CONCURRENCY, UploadQueue, type UploadProgress } from '../roblox/upload-queue';
import { ModelStore } from '../modeling/model-store';
import { AnimationStore, clipHash, type AnimationFile } from './animation-service';
import { clipToRbxmx } from './rbxmx';
import { LEGACY_OWNER } from '../roblox/upload-owner';

/**
 * Uploads animation clips to Roblox (Open Cloud, assetType Animation) and records what came of each in its
 * clip file: the asset id (animation_upload's own code path), or the operation Roblox is still processing.
 * Like a model's parts, a clip's upload belongs to the clip, not to the run that asked: it is never aborted
 * with the run, finds a still-pending operation instead of sending the clip again, joins an upload that is
 * already running, and only clips whose current content isn't uploaded go up (up to six at a time).
 */

/** How long one upload waits for Roblox to process a clip before it is kept as pending. */
export const CLIP_UPLOAD_WAIT_MS = 120_000;
/** How long a call asks about an upload that was still pending the last time. */
export const CLIP_RESOLVE_WAIT_MS = 45_000;
const POLL: PollOptions = { maxDelayMs: 8_000 };

export interface ClipUploadDeps {
  cloud: Pick<OpenCloudAssets, 'configured' | 'upload' | 'wait'>;
  uploads: () => { enabled: boolean; creatorId: string | null };
  /** The Roblox user uploads go to (asks Studio when Settings doesn't say). */
  creator: () => Promise<string | null>;
  /**
   * Who uploads go to now (upload-owner.ts ownerKey): a clip uploaded for another owner is uploaded again, since
   * Roblox plays only animations the game's owner owns (a game moved to a community needs its clips again).
   */
  ownerKey?: () => Promise<string>;
  /** Waits and polling, for tests. */
  timing?: { uploadWaitMs?: number; resolveWaitMs?: number; poll?: PollOptions };
  concurrency?: number;
}

/** What became of one clip's upload. */
export interface ClipUpload {
  name: string;
  assetId: string | null;
  /** Roblox is still processing it: kept, the next call picks it up. */
  pending?: boolean;
  /** Why there is no asset id. */
  why?: string;
  /** Uploaded earlier for this exact content: nothing was sent. */
  reused?: boolean;
  /** What stopped it is the user's to fix (no key, no permission, unknown creator). */
  needsUser?: boolean;
}

/** The .rbxmx Roblox takes for a clip (a custom rig's clip is written against its rig). */
export function clipRbxmx(root: string, f: AnimationFile): string {
  return f.clip.rig ? clipToRbxmx(f.clip, new ModelStore(root).rig(f.clip.rig)) : clipToRbxmx(resolveAims(f.clip));
}

export class AnimationUploads {
  private readonly queue: UploadQueue<ClipUpload>;
  private creatorLookup: Promise<string | null> | null = null;

  constructor(private readonly d: ClipUploadDeps) {
    this.queue = new UploadQueue(() => d.concurrency ?? UPLOAD_CONCURRENCY);
  }

  /** Whether uploading can work at all right now, and if not why (switched off, no key). */
  async ready(): Promise<{ ok: true } | { ok: false; why: string; needsUser: boolean }> {
    if (!this.d.uploads().enabled) return { ok: false, why: 'uploading is turned off in Settings', needsUser: true };
    if (!(await this.d.cloud.configured())) return { ok: false, why: 'no Open Cloud API key with the Assets permission is set (Settings → Roblox)', needsUser: true };
    return { ok: true };
  }

  /** Clips that are uploading (or waiting their turn) right now. */
  uploading(root: string): string[] {
    const prefix = `${root}\n`;
    return this.queue
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.split('\n')[1]!);
  }

  /** The clips' asset ids: uploaded already (nothing sent), joined, or uploaded now, up to six at a time; see ModelUploads.ensureMany. */
  ensureMany(root: string, names: string[], opts: { budgetMs: number; signal?: AbortSignal; onProgress?: (p: UploadProgress) => void; heartbeatMs?: number }): Promise<{ results: ClipUpload[]; stillUploading: string[] }> {
    const store = new AnimationStore(root);
    const items = names.map((name) => {
      const f = store.get(name);
      return { name, needed: !!f && !store.summary(f).uploaded, promise: this.ensure(root, name) };
    });
    return this.queue.batch(items, { ...opts, noun: 'clip' });
  }

  /** The clip's asset id for its current content; never rejects. */
  async ensure(root: string, name: string): Promise<ClipUpload> {
    const store = new AnimationStore(root);
    const f = store.get(name);
    if (!f) return { name, assetId: null, why: `no animation named ${name}` };
    const hash = clipHash(f.clip);
    const owner = (await this.d.ownerKey?.().catch(() => null)) ?? LEGACY_OWNER;
    if (f.upload && f.upload.hash === hash && (f.upload.owner ?? LEGACY_OWNER) === owner) return { name, assetId: f.upload.assetId, reused: true };
    return this.queue.run(
      `${root}\n${name}\n${hash}\n${owner}`,
      () => this.upload(root, store, f, hash, owner),
      (e): ClipUpload => ({ name, assetId: null, why: `the upload failed: ${e.message}` }),
    );
  }

  private creatorOnce(): Promise<string | null> {
    this.creatorLookup ??= this.d.creator().finally(() => {
      this.creatorLookup = null;
    });
    return this.creatorLookup;
  }

  private async upload(root: string, store: AnimationStore, f: AnimationFile, hash: string, owner: string = LEGACY_OWNER): Promise<ClipUpload> {
    const name = f.clip.name;
    const fail = (why: string, needsUser = false): ClipUpload => ({ name, assetId: null, why, ...(needsUser ? { needsUser } : {}) });
    const ready = await this.ready();
    if (!ready.ok) return fail(ready.why, ready.needsUser);
    const operation = AnimationStore.pendingOperation(f, owner);
    let r: UploadResult;
    if (operation) {
      // Roblox took this exact version earlier and was still processing it: ask how it went, never send it again.
      r = await this.d.cloud.wait(operation, this.d.timing?.resolveWaitMs ?? CLIP_RESOLVE_WAIT_MS, undefined, this.d.timing?.poll ?? POLL);
    } else {
      const who = await this.creatorOnce();
      if (!who) return fail('the Roblox creator is unknown: sign in to Studio or set the creator id in Settings', true);
      const dir = mkdtempSync(join(tmpdir(), 'shuriken-anim-upload-'));
      try {
        const file = join(dir, `${name}.rbxmx`);
        writeFileSync(file, clipRbxmx(root, f), 'utf8');
        // No AbortSignal on purpose: the upload belongs to the clip, it finishes when its run stops.
        r = await this.d.cloud.upload({ file, type: 'Animation', name, description: f.clip.description ?? 'Animated with Shuriken Studio', creator: { userId: who }, waitMs: this.d.timing?.uploadWaitMs ?? CLIP_UPLOAD_WAIT_MS, poll: this.d.timing?.poll ?? POLL });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // Edited (or removed) while this went on: the outcome is for an older version, don't record it on the new one.
    const cur = store.get(name);
    if (!cur || clipHash(cur.clip) !== hash) return fail('it changed while it was uploading: upload again for the new version');
    if (r.ok && r.assetId) {
      store.setUpload(name, r.assetId, r.owner ?? owner);
      return { name, assetId: r.assetId };
    }
    if (r.pending && r.operation) {
      store.setUploading(name, r.operation, r.owner ?? owner);
      return { name, assetId: null, pending: true, why: 'Roblox is still processing the upload (it is kept: the next upload picks it up)' };
    }
    return fail(r.error ?? 'upload failed', !!r.needsUser);
  }
}
