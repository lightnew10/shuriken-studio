import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from '@shared/ids';
import { suggestionsOf, type Suggestion } from '@shared/suggestions';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { AgentRunner } from '../orchestrator/agent-runner';
import { ROLES } from '../agents/roles';
import { suggestionsFor } from './suggestions';

/**
 * The start page's game ideas, written for this user by the fast model from the games they have made: about a third
 * near what they build, the rest fresh, every one a whole new game with a detailed first message. Kept in the data
 * folder (start-ideas.json) and written again when the user's projects change or a day has passed, or when they ask
 * for more. Until then, and whenever the model can't be reached, the hand-written ideas (suggestions.ts).
 */

export const START_IDEAS = {
  /** Written again after this long even when nothing changed, so the ideas move on. */
  freshMs: 24 * 60 * 60_000,
  /** Never two writes closer than this (a failed one included). */
  throttleMs: 10 * 60_000,
  /** "More ideas" may write a new set this soon after the last. */
  moreMs: 30_000,
  /** At most this many past projects go into the prompt (the newest). */
  projects: 30,
};

interface Stored {
  at: string;
  fingerprint: string;
  ideas: Suggestion[];
}

export type ProjectLine = { name: string; description?: string | null };

export class StartIdeas {
  private running: Promise<boolean> | null = null;
  private lastTry = 0;
  /** Where "More ideas" has got to in the current set. */
  private offset = 0;

  constructor(
    private readonly d: {
      runner: AgentRunner;
      bus: EventBus;
      log: ScopedLogger;
      /** start-ideas.json in the app's data folder. */
      file: string;
      /** A folder the call may run in (no files are read or written there). */
      cwd: string;
      projects: () => ProjectLine[];
      /** Off where no model may be called (tests, smoke runs, safe mode). */
      enabled?: () => boolean;
    },
  ) {}

  private read(): Stored | null {
    try {
      return existsSync(this.d.file) ? (JSON.parse(readFileSync(this.d.file, 'utf8')) as Stored) : null;
    } catch {
      return null;
    }
  }

  private fingerprint(projects: ProjectLine[]): string {
    return createHash('sha1')
      .update(JSON.stringify(projects.map((p) => p.name).sort()))
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * `count` ideas for the start page, from where "More ideas" got to; the hand-written ones until the model has
   * written some. Writes a new set in the background when the projects changed or the set is a day old.
   */
  get(count = 6): Suggestion[] {
    const projects = this.d.projects();
    const stored = this.read();
    const stale = !stored || stored.fingerprint !== this.fingerprint(projects) || Date.now() - Date.parse(stored.at) > START_IDEAS.freshMs;
    if (stale) void this.refresh();
    const ideas = stored?.ideas.length ? stored.ideas : suggestionsFor(projects, 12);
    const at = this.offset % Math.max(1, ideas.length);
    return [...ideas.slice(at), ...ideas.slice(0, at)].slice(0, count);
  }

  /**
   * The next ideas ("More ideas"): the rest of the current set first, then a newly written one. True when the
   * page should ask again (ideas changed now, or a new set is on its way: `start.ideas` says when it lands).
   */
  more(count = 6): boolean {
    const stored = this.read();
    const size = stored?.ideas.length ?? 12;
    this.offset += count;
    if (this.offset < size) return true;
    this.offset = 0;
    void this.refresh(true);
    return true;
  }

  /** Writes a new set now (unless one is being written, or was tried within the throttle; `asked`: the shorter one). */
  refresh(asked = false): Promise<boolean> {
    if (this.running) return this.running;
    if (this.d.enabled?.() === false || Date.now() - this.lastTry < (asked ? START_IDEAS.moreMs : START_IDEAS.throttleMs)) return Promise.resolve(false);
    this.lastTry = Date.now();
    this.running = this.write().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async write(): Promise<boolean> {
    const projects = this.d.projects();
    const recent = projects.slice(0, START_IDEAS.projects);
    const before = this.read()?.ideas.map((i) => i.label) ?? [];
    const prompt = [
      'Write the start page\'s game ideas for this user.',
      '',
      recent.length ? `Games they have made, newest first (${projects.length} in all):` : 'They have not made a game yet: ideas for someone new to Shuriken, varied and easy to love.',
      ...recent.map((p) => `- ${p.name}${p.description ? `: ${p.description.replace(/\s+/g, ' ').slice(0, 260)}` : ''}`),
      ...(before.length ? ['', `Ideas they were shown last time (write different ones): ${before.join('; ')}`] : []),
    ].join('\n');
    try {
      const out = await this.d.runner.quick({ role: ROLES.ideas!, prompt, cwd: this.d.cwd, signal: new AbortController().signal });
      const ideas = suggestionsOf((out?.structured as { ideas?: unknown } | null)?.ideas, 16, 40).filter((i) => i.prompt.length >= 80);
      if (ideas.length < 6) return false;
      mkdirSync(dirname(this.d.file), { recursive: true });
      writeFileSync(this.d.file, `${JSON.stringify({ at: nowIso(), fingerprint: this.fingerprint(projects), ideas } satisfies Stored, null, 2)}\n`, 'utf8');
      this.offset = 0;
      this.d.bus.emit('start.ideas', {});
      return true;
    } catch (e) {
      this.d.log.warn('Writing the start page ideas failed', errorMessage(e));
      return false;
    }
  }
}
