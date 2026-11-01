import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { OPEN_CLOUD_KEY, type SecretProvider } from './open-cloud-luau';
import { COMMUNITY_KEY_HINT, ownerKey, type UploadOwner } from './upload-owner';

const BASE = 'https://apis.roblox.com/assets/v1';

export type UploadAssetType = 'Audio' | 'Model' | 'Decal' | 'Animation';

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.fbx': 'model/fbx',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'model/obj',
  '.rbxm': 'model/x-rbxm',
  '.rbxmx': 'model/x-rbxm',
};

export interface UploadResult {
  ok: boolean;
  assetId?: string;
  /** The upload's Open Cloud operation (its id: operations/<id>): poll it with `wait` to learn the asset id. */
  operation?: string;
  /**
   * Roblox took the upload and is still processing it: not a failure. Keep `operation` and resolve it
   * later with `wait` (never upload the same file again meanwhile).
   */
  pending?: boolean;
  error?: string;
  /** The key is missing or lacks the Assets API permission: the user has to fix it. */
  needsUser?: boolean;
  /** Who the upload went to (ownerKey: 'g:<community id>', 'u:<account id>' for a project's own account, or 'u'): an upload made for another owner isn't reused. */
  owner?: string;
}

/** How an operation is polled: the pause before the first question (1 s) and its ceiling as it backs off (5 s). */
export interface PollOptions {
  startDelayMs?: number;
  maxDelayMs?: number;
}

/** The id of an Open Cloud operation given as an id or as the path Roblox returns (operations/<id>). */
export const operationId = (operation: string): string => operation.split('/').filter(Boolean).pop() ?? operation;

/** One part of a multipart/form-data body: a text field or a file. */
export type MultipartPart = { name: string; value: string } | { name: string; filename: string; type: string; data: Uint8Array };

/**
 * A multipart/form-data body in one piece, with its Content-Type. Not a FormData: undici's fetch sends a
 * FormData by pumping it into the request stream from an async function nobody awaits, and a request
 * aborted before or while that pump runs makes it write to the closed stream — an unhandled rejection
 * ("Invalid state: ReadableStream is already closed", once per upload when a batch of runs is stopped).
 * A Buffer goes in synchronously and can't.
 */
export function multipartBody(parts: MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = `----ShurikenForm${randomBytes(12).toString('hex')}`;
  // Names and file names the way a browser (and undici) writes them: line breaks and quotes escaped.
  const esc = (v: string) => v.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const file = 'data' in part ? part : null;
    const head = `--${boundary}${CRLF}Content-Disposition: form-data; name="${esc(part.name)}"${file ? `; filename="${esc(file.filename)}"${CRLF}Content-Type: ${file.type}` : ''}${CRLF}${CRLF}`;
    chunks.push(Buffer.from(head), file ? Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength) : Buffer.from((part as { value: string }).value), Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Sleeps, or less when the signal aborts (a polling loop that should notice its run ending). */
const sleepUnless = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Open Cloud Assets API: uploads audio, images and models to the creator's inventory (free; Roblox
 * moderates new assets before they play for everyone). Needs an API key with the asset:read and
 * asset:write permissions for the creator. Errors are values; nothing is retried blindly.
 */
export class OpenCloudAssets {
  constructor(
    private readonly secret: SecretProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async configured(): Promise<boolean> {
    return !!(await this.secret(OPEN_CLOUD_KEY).catch(() => null));
  }

  /** Who uploads go to (upload-owner.ts); unset: the person each caller names. Set by the core. */
  private ownerOf: (() => Promise<UploadOwner>) | null = null;

  setOwner(fn: () => Promise<UploadOwner>): void {
    this.ownerOf = fn;
  }

  /** The owner uploads go to now (the person when no owner rule is set). */
  async owner(): Promise<UploadOwner> {
    return (await this.ownerOf?.().catch(() => null)) ?? { kind: 'user', source: 'user' };
  }

  /**
   * Uploads a file and waits up to `waitMs` for Roblox to process it. An upload that Roblox is still
   * processing then comes back as `{ ok: false, pending: true, operation }` — not a failure: keep the
   * operation and resolve it with `wait` later. `signal` only stops the waiting and the POST, so callers
   * whose upload should outlive their run (a model's mesh) leave it out.
   */
  async upload(input: { file: string; type: UploadAssetType; name: string; description?: string; creator: { userId: string } | { groupId: string }; waitMs?: number; poll?: PollOptions }, signal?: AbortSignal): Promise<UploadResult> {
    if (signal?.aborted) return { ok: false, error: 'Upload not sent: the run was stopped.' };
    const key = await this.secret(OPEN_CLOUD_KEY).catch(() => null);
    if (!key) return { ok: false, needsUser: true, error: 'No Open Cloud API key is set (Settings → Roblox → Open Cloud). Uploading needs one with the Assets read/write permission.' };
    const ext = extname(input.file).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return { ok: false, error: `Can't upload ${ext} files` };
    // A community the project, the game or the settings name takes the upload instead of the person the caller
    // found, and so does another account set for this project.
    const owner = this.ownerOf ? await this.owner() : null;
    const creator = owner?.kind === 'group' ? { groupId: owner.id } : owner?.id ? { userId: owner.id } : input.creator;
    // Recorded with the result once an owner rule is set (the core sets one), so a later owner change re-uploads.
    const ownedBy = owner ? { owner: ownerKey(owner) } : {};
    const request = {
      assetType: input.type,
      displayName: input.name.slice(0, 50),
      description: (input.description ?? 'Made with Shuriken Studio').slice(0, 1000),
      creationContext: { creator },
    };
    const form = multipartBody([
      { name: 'request', value: JSON.stringify(request) },
      { name: 'fileContent', filename: basename(input.file), type: mime, data: readFileSync(input.file) },
    ]);
    let res: Response;
    let text = '';
    for (let attempt = 0; ; attempt++) {
      // A run that was stopped sends nothing (and fetch is never handed a signal that has already aborted).
      if (signal?.aborted) return { ok: false, error: 'Upload not sent: the run was stopped.' };
      try {
        res = await this.fetchImpl(`${BASE}/assets`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': form.contentType }, body: form.body, signal });
      } catch (e) {
        return { ok: false, error: `Upload failed: ${(e as Error).message}` };
      }
      text = await res.text();
      // Rate limited: nothing was created, so asking again (as Retry-After says, at most 30 s) is safe.
      if (res.status !== 429 || attempt >= 2 || signal?.aborted) break;
      const asked = Number(res.headers.get('retry-after'));
      await sleepUnless(Math.min(30_000, (Number.isFinite(asked) ? asked : 3 * (attempt + 1)) * 1000), signal);
    }
    if (res.status === 401 || res.status === 403) {
      // An open moderation notice on the account blocks every upload (seen 22 times in an afternoon, reported as a key problem).
      if (/moderated/i.test(text))
        return { ok: false, needsUser: true, error: "Roblox refused the upload: the account has an open moderation notice (\"User is moderated\"). Every upload stays blocked until the user acknowledges it on roblox.com (Account → Moderation, or the red banner). No agent can fix this and nothing is wrong with the file or the key: don't retry, don't file a defect; carry on with what works without uploads and say so." };
      if ('groupId' in creator) return { ok: false, needsUser: true, error: `Roblox refused the upload to community ${creator.groupId} (${res.status}). ${COMMUNITY_KEY_HINT} ${text.slice(0, 300)}` };
      return { ok: false, needsUser: true, error: `Roblox refused the upload (${res.status}): the Open Cloud key needs the Assets API (asset:read, asset:write) for this creator. ${text.slice(0, 300)}` };
    }
    if (res.status === 429) return { ok: false, error: 'Roblox is rate limiting uploads; try again in a minute.' };
    if (!res.ok) return { ok: false, error: `Upload failed (${res.status}): ${text.slice(0, 400)}` };
    let op: { path?: string; done?: boolean; response?: { assetId?: string } };
    try {
      op = JSON.parse(text) as typeof op;
    } catch {
      return { ok: false, error: `Unexpected upload response: ${text.slice(0, 200)}` };
    }
    if (op.done && op.response?.assetId) return { ok: true, assetId: String(op.response.assetId), ...ownedBy };
    const operation = op.path ? operationId(op.path) : '';
    if (!operation) return { ok: false, error: `Upload response had no operation: ${text.slice(0, 200)}` };
    return { ...(await this.wait(operation, input.waitMs ?? 30_000, signal, input.poll)), ...ownedBy };
  }

  /**
   * Polls an upload operation (its id or path) until Roblox has the asset id or the wait runs out, backing
   * off from 1 s up to 5 s (see PollOptions). Roblox needing longer than the wait is `pending`, not a
   * failure; a rejected asset or an unknown operation is.
   */
  async wait(operation: string, waitMs = 30_000, signal?: AbortSignal, poll: PollOptions = {}): Promise<UploadResult> {
    const key = await this.secret(OPEN_CLOUD_KEY).catch(() => null);
    if (!key) return { ok: false, needsUser: true, error: 'No Open Cloud API key is set.' };
    const id = operationId(operation);
    const deadline = Date.now() + waitMs;
    const maxDelay = Math.max(10, poll.maxDelayMs ?? 5000);
    let delay = Math.min(poll.startDelayMs ?? 1000, maxDelay);
    while (Date.now() < deadline && !signal?.aborted) {
      await sleepUnless(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
      delay = Math.min(maxDelay, delay * 1.6);
      if (signal?.aborted) break;
      const res = await this.fetchImpl(`${BASE}/operations/${id}`, { headers: { 'x-api-key': key }, signal }).catch(() => null);
      if (!res) continue;
      // Roblox busy or rate limiting the polling: that says nothing about the upload, ask again later.
      if (res.status === 429 || res.status >= 500) {
        await res.text().catch(() => '');
        continue;
      }
      if (!res.ok) return { ok: false, operation: id, needsUser: res.status === 401 || res.status === 403, error: `Checking the upload failed (${res.status}): ${(await res.text()).slice(0, 300)}` };
      const op = (await res.json().catch(() => ({}))) as { done?: boolean; response?: { assetId?: string }; error?: { message?: string } };
      if (op.error) return { ok: false, operation: id, error: `Roblox rejected the asset: ${op.error.message ?? 'unknown reason'}` };
      if (op.done && op.response?.assetId) return { ok: true, assetId: String(op.response.assetId) };
      if (op.done) return { ok: false, operation: id, error: 'Roblox finished the upload but returned no asset id' };
    }
    return { ok: false, pending: true, operation: id, error: 'Roblox is still processing the upload; check again later.' };
  }
}

/**
 * The Roblox user uploads go to: the one set in Settings, else the account signed in to Studio
 * (remembered once found).
 */
export async function resolveCreator(
  studio: { connected: boolean; runLuau(code: string, dm: 'Edit' | 'Server', timeoutMs?: number): Promise<{ ok: boolean; output: string }> },
  configured: string | null,
  remember: (id: string) => void,
): Promise<string | null> {
  if (configured) return configured;
  if (!studio.connected) return null;
  const idOf = (r: { ok: boolean; output: string } | null) => {
    const id = r?.ok ? r.output.trim().replace(/^"|"$/g, '') : '';
    return /^\d+$/.test(id) && id !== '0' ? id : null;
  };
  let id = idOf(await studio.runLuau('return tostring(game:GetService("StudioService"):GetUserId())', 'Edit', 15_000).catch(() => null));
  // During a playtest the Edit DataModel isn't available (test 3's upload failed that way), but the
  // play-solo player is the Studio user.
  if (!id) id = idOf(await studio.runLuau('local p = game:GetService("Players"):GetPlayers()[1] return p and tostring(p.UserId) or ""', 'Server', 15_000).catch(() => null));
  if (id) remember(id);
  return id;
}
