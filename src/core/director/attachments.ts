import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { ProjectContext } from '../projects/project-service';

/**
 * Images the user attaches to a chat message (a reference screenshot for the UI copilot, concept art
 * for a creature): kept with the project in .shuriken/attachments/ and handed to the agent as images
 * in the same turn, so it sees them directly.
 */

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** An attachment as the chat message keeps it (the file is relative to the project's .shuriken folder). */
export interface Attachment {
  file: string;
  name: string;
  mediaType: ImageMediaType;
}

/** An image for an agent run. */
export interface RunImage {
  mediaType: ImageMediaType;
  /** base64 */
  data: string;
}

export const MAX_ATTACHMENTS = 6;
/** Anthropic's per-image limit is 5 MB; the dock downsizes pictures well below it before sending. */
const MAX_BYTES = 5 * 1024 * 1024;
const EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;

/** Saves a message's pictures (data URLs) under .shuriken/attachments; rejects anything that isn't a small image. */
export function saveAttachments(p: ProjectContext, key: string, images: Array<{ name?: string; dataUrl: string }>): Attachment[] {
  if (images.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} images per message.`);
  const dir = join(p.dir, 'attachments');
  const out: Attachment[] = [];
  images.forEach((img, i) => {
    const m = DATA_URL.exec(String(img?.dataUrl ?? ''));
    if (!m) throw new Error('Only PNG, JPEG, WebP or GIF images can be attached.');
    const mediaType = m[1] as ImageMediaType;
    const bytes = Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64');
    if (bytes.length > MAX_BYTES) throw new Error(`"${img.name ?? `image ${i + 1}`}" is over 5 MB.`);
    mkdirSync(dir, { recursive: true });
    const file = `attachments/${key.replace(/[^\w-]+/g, '_')}-${i + 1}.${EXT[mediaType]}`;
    writeFileSync(join(p.dir, file), bytes);
    out.push({ file, name: String(img.name ?? `image ${i + 1}`).slice(0, 80), mediaType });
  });
  return out;
}

/** The absolute path of an attachment, only inside .shuriken/attachments. */
function pathOf(p: ProjectContext, file: string): string {
  const abs = resolve(p.dir, file);
  const rel = relative(join(p.dir, 'attachments'), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Not an attachment of this project.');
  return abs;
}

/** An attachment as a data URL (the dock shows it in the message). */
export function attachmentDataUrl(p: ProjectContext, file: string): string {
  const abs = pathOf(p, file);
  if (!existsSync(abs)) throw new Error('That attachment is gone.');
  const ext = abs.split('.').pop()!.toLowerCase();
  const type = (Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'image/png') as ImageMediaType;
  return `data:${type};base64,${readFileSync(abs).toString('base64')}`;
}

/** A message's attachments as images for the agent's turn (missing files are skipped). */
export function runImages(p: ProjectContext, list: Attachment[]): RunImage[] {
  const out: RunImage[] = [];
  for (const a of list) {
    try {
      const abs = pathOf(p, a.file);
      if (existsSync(abs)) out.push({ mediaType: a.mediaType, data: readFileSync(abs).toString('base64') });
    } catch {
      /* not an attachment path: skipped */
    }
  }
  return out;
}
