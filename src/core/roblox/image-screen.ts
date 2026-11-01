import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROLES } from '../agents/roles';
import type { ScopedLogger } from '../log';
import { decodePng, encodePng, shrinkImage } from '../modeling/png';
import type { AgentRunner } from '../orchestrator/agent-runner';
import type { ProjectContext } from '../projects/project-service';

/**
 * A look at an image before it goes to Roblox, for what a scan can't measure: web addresses, social handles, other
 * platforms' names and logos, phone numbers, real brands, painted as lettering on a sign or a label. One short run of
 * the fast model per image (about a cent), remembered by the image's content so nothing is looked at twice. The QR
 * scan (content-rules.ts) runs first and needs no model.
 *
 * It never blocks an upload by failing itself: no answer (a usage limit, no provider, an unreadable file) lets the
 * image through.
 */

/** The widest side the model is shown (lettering stays readable, the picture stays small). */
const LOOK_PX = 1024;
/**
 * Looks at the same moment. One takes about 15 s with the real model (measured: four images in 60 s one after the
 * other), so a map's textures are looked at together, ahead of their uploads, and not one per upload lane.
 */
export const LOOKS_AT_ONCE = 6;

interface Verdict {
  /** What was found, or null when the image is fine. */
  what: string | null;
  at: string;
}

export interface ImageScreenDeps {
  runner: () => AgentRunner | null;
  project: () => ProjectContext | null;
  log: ScopedLogger;
  /** Off in tests and smoke runs. */
  enabled?: () => boolean;
}

export class ImageScreen {
  private readonly pending = new Map<string, Promise<string | null>>();
  private looking = 0;
  private readonly waiting: Array<() => void> = [];

  /** A place among the looks under way (LOOKS_AT_ONCE at a time, the rest in order). */
  private async turn<T>(fn: () => Promise<T>): Promise<T> {
    if (this.looking >= LOOKS_AT_ONCE) await new Promise<void>((ok) => this.waiting.push(ok));
    this.looking++;
    try {
      return await fn();
    } finally {
      this.looking--;
      this.waiting.shift()?.();
    }
  }

  constructor(private readonly d: ImageScreenDeps) {}

  private file(root: string): string {
    return join(root, '.shuriken', 'moderation', 'images.json');
  }

  private read(root: string): Record<string, Verdict> {
    try {
      return JSON.parse(readFileSync(this.file(root), 'utf8')) as Record<string, Verdict>;
    } catch {
      return {};
    }
  }

  /** What in the image Roblox would remove, in a few words, or null. */
  check(root: string, file: string): Promise<string | null> {
    if (this.d.enabled?.() === false || !existsSync(file)) return Promise.resolve(null);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return Promise.resolve(null);
    }
    const key = createHash('sha1').update(bytes).digest('hex');
    const known = this.read(root)[key];
    if (known) return Promise.resolve(known.what);
    const going = this.pending.get(key);
    if (going) return going;
    const p = this.turn(() => this.look(root, key, bytes)).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private async look(root: string, key: string, bytes: Buffer): Promise<string | null> {
    const runner = this.d.runner();
    const project = this.d.project();
    if (!runner || !project || project.root !== root) return null;
    let data: string;
    try {
      data = encodePng(shrinkImage(decodePng(bytes), LOOK_PX)).toString('base64');
    } catch {
      return null;
    }
    try {
      const outcome = await runner.run({
        project,
        role: ROLES['image-checker']!,
        task: null,
        signal: new AbortController().signal,
        directive: 'Look at this texture and answer.',
        contextText: 'The image is a texture atlas of a 3D model for a Roblox game: patches of its surfaces side by side, some rotated or upside down.',
        images: [{ mediaType: 'image/png', data }],
      });
      const out = outcome.structured as { flagged?: unknown; what?: unknown } | null;
      if (!outcome.completion.ok || !out || typeof out.flagged !== 'boolean') return null;
      const what = out.flagged ? String(out.what ?? '').trim().slice(0, 200) || 'something that points off Roblox or copies a real brand' : null;
      const all = this.read(root);
      all[key] = { what, at: new Date().toISOString() };
      mkdirSync(dirname(this.file(root)), { recursive: true });
      writeFileSync(this.file(root), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
      return what;
    } catch (e) {
      this.d.log.warn('Looking at a texture before its upload failed', (e as Error).message);
      return null;
    }
  }
}
