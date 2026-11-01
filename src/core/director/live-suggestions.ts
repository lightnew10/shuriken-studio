import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@shared/ids';
import { suggestionsOf, type Suggestion } from '@shared/suggestions';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { ProjectContext } from '../projects/project-service';
import type { AgentRunner } from '../orchestrator/agent-runner';
import { ROLES } from '../agents/roles';
import { COPILOT_IDS, type CopilotId } from '../copilots/copilot-roles';
import { AnimationStore } from '../animation/animation-service';
import { EffectStore } from '../effects/effects-service';
import { SoundLibrary } from '../audio/audio-library';
import { ModelStore } from '../modeling/model-store';
import { UiStore } from '../ui/ui-workshop';
import { DossierStore } from '../projects/game-study';
import { ChatService } from './chat-service';
import { finishedWork } from './game-digest';

/**
 * Suggestion bubbles that know the game: for the director's chat and each dock, ideas about what this
 * game has and what the user has been asking for ("Make the Griever scarier", "More detail in the
 * maze") instead of generic templates. One small fast-model call writes every place's bubbles at once;
 * they are kept in .shuriken/suggestions.json and written again (at most every 10 minutes) once the
 * game has changed. Director and copilot replies bring their own follow-ups in between.
 */

export type SuggestionScope = 'director' | CopilotId;
export const SUGGESTION_SCOPES: readonly SuggestionScope[] = ['director', ...COPILOT_IDS];

const THROTTLE_MS = 10 * 60_000;
const DIGEST_TTL_MS = 30_000;

interface Stored {
  at: string;
  fingerprint: string;
  scopes: Partial<Record<SuggestionScope, Suggestion[]>>;
}

/** What the bubbles are written from: the game's goals, its work, its content and what the user asked; null for an empty game. */
export function gameDigest(ctx: ProjectContext, chat: ChatService): { text: string; fingerprint: string } | null {
  const root = ctx.root;
  const tasks = ctx.tasks.list({});
  const objectives = tasks.filter((t) => t.kind === 'objective');
  const work = tasks.filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && t.kind !== 'research');
  // What counts as built is the director's digest's rule too (game-digest.ts).
  const finished = finishedWork(tasks);
  const open = work.filter((t) => !['done', 'verified', 'cancelled'].includes(t.status));
  const anims = new AnimationStore(root).all().map((f) => `${f.clip.name}${f.draft ? ' (draft)' : ''}`);
  const effects = new EffectStore(root).all().map((f) => `${f.effect.name}${f.draft ? ' (draft)' : ''}`);
  const sounds = new SoundLibrary(root).all();
  const store = new ModelStore(root);
  const models = [...new Set(store.all().map((m) => m.assembly ?? m.name))];
  const rigs = Object.keys(store.rigs());
  const ui = new UiStore(root).get()?.screens.map((s) => s.name) ?? [];
  const study = ctx.extras().adopted ? new DossierStore(root).summary(1200) : null;
  if (!objectives.length && !study && !anims.length && !effects.length && !sounds.length && !models.length && !ui.length) return null;
  const asked = chat
    .list(80)
    .filter((m) => m.role === 'user')
    .slice(-6)
    .map((m) => `- ${m.text.replace(/\s+/g, ' ').slice(0, 240)}`);
  const lines = [
    `Game: ${ctx.summary.name}${ctx.summary.description ? ` — ${ctx.summary.description.slice(0, 300)}` : ''}`,
    ...(study ? ['', 'What the game is (its study):', study] : []),
    ...(objectives.length ? ['', 'Goals:', ...objectives.slice(-5).map((o) => `- ${o.title} (${o.status})`)] : []),
    ...(finished.length ? ['', 'Finished:', ...finished.slice(-12).map((t) => `- ${t.title}`)] : []),
    ...(open.length ? ['', 'Being worked on or waiting:', ...open.slice(0, 10).map((t) => `- ${t.title} (${t.status})`)] : []),
    '',
    'What the game has:',
    `- 3D models: ${models.slice(0, 20).join(', ') || 'none'}${rigs.length ? ` (rigged creatures: ${rigs.join(', ')})` : ''}`,
    `- Animations: ${anims.slice(0, 30).join(', ') || 'none'}`,
    `- Sounds: ${sounds.slice(0, 20).map((s) => `${s.name}${s.draft ? ' (draft)' : ''}`).join(', ') || 'none'}`,
    `- Effects: ${effects.slice(0, 20).join(', ') || 'none'}`,
    `- UI screens: ${ui.slice(0, 15).join(', ') || 'none read yet'}`,
    ...(asked.length ? ['', 'What the user asked lately:', ...asked] : []),
  ];
  // Written again when the game changes: goals, finished work (every few tasks), content — not every message.
  const key = JSON.stringify([objectives.map((o) => `${o.id}:${o.status}`), Math.floor(finished.length / 3), models, rigs, anims.length, effects, sounds.map((s) => s.name), ui, !!study]);
  return { text: lines.join('\n'), fingerprint: createHash('sha1').update(key).digest('hex').slice(0, 16) };
}

/** Whether the project has a game to suggest changes to: a goal, or a game it plugged in. */
export function hasGame(ctx: ProjectContext): boolean {
  return !!ctx.extras().adopted || ctx.tasks.list({}).some((t) => t.kind === 'objective');
}

export class LiveSuggestions {
  private readonly running = new Set<string>();
  private readonly lastTry = new Map<string, number>();
  private readonly digests = new Map<string, { at: number; value: { text: string; fingerprint: string } | null }>();

  constructor(
    private readonly d: {
      runner: AgentRunner;
      bus: EventBus;
      log: ScopedLogger;
      /** Off where no model may be called for bubbles. */
      enabled?: () => boolean;
      /** Game ideas (the start page's): the director's bubbles in a project with no game yet. */
      ideas?: (count: number) => Suggestion[];
    },
  ) {}

  private file(ctx: ProjectContext): string {
    return join(ctx.dir, 'suggestions.json');
  }

  private read(ctx: ProjectContext): Stored | null {
    try {
      const f = this.file(ctx);
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Stored) : null;
    } catch {
      return null;
    }
  }

  /** The game's digest, read again at most every 30 s for the UI's frequent asks (`fresh`: now). */
  private digest(ctx: ProjectContext, fresh = false): { text: string; fingerprint: string } | null {
    const hit = this.digests.get(ctx.summary.id);
    if (!fresh && hit && Date.now() - hit.at < DIGEST_TTL_MS) return hit.value;
    const value = gameDigest(ctx, new ChatService(ctx, this.d.bus));
    this.digests.set(ctx.summary.id, { at: Date.now(), value });
    return value;
  }

  /** The bubbles of `scope` for this game (null until some are written); writes new ones in the background once the game changed. */
  get(ctx: ProjectContext, scope: SuggestionScope): Suggestion[] | null {
    // No game yet (a blank project): the director's bubbles are games to start, like the start page's. What a
    // dock holds then is the user trying things, not a game to suggest changes to.
    if (scope === 'director' && this.d.ideas && !hasGame(ctx)) return this.d.ideas(4);
    const stored = this.read(ctx);
    const digest = this.digest(ctx);
    if (digest && stored?.fingerprint !== digest.fingerprint) void this.refresh(ctx, digest);
    return stored?.scopes[scope] ?? null;
  }

  /** Writes every place's bubbles for the game now (unless a set is being written or was tried within the throttle). */
  async refresh(ctx: ProjectContext, digest = this.digest(ctx, true)): Promise<boolean> {
    const id = ctx.summary.id;
    if (!digest || this.d.enabled?.() === false || this.running.has(id) || Date.now() - (this.lastTry.get(id) ?? 0) < THROTTLE_MS) return false;
    this.running.add(id);
    this.lastTry.set(id, Date.now());
    try {
      const outcome = await this.d.runner.run({
        project: ctx,
        role: ROLES.suggester!,
        task: null,
        signal: new AbortController().signal,
        directive: 'Write the suggestion bubbles for this game.',
        contextText: digest.text,
      });
      const out = outcome.structured as Record<string, unknown> | null;
      if (!outcome.completion.ok || !out) return false;
      const scopes: Stored['scopes'] = {};
      for (const s of SUGGESTION_SCOPES) {
        const list = suggestionsOf(out[s], 4, 48);
        if (list.length) scopes[s] = list;
      }
      if (!Object.keys(scopes).length) return false;
      mkdirSync(ctx.dir, { recursive: true });
      writeFileSync(this.file(ctx), `${JSON.stringify({ at: nowIso(), fingerprint: digest.fingerprint, scopes } satisfies Stored, null, 2)}\n`, 'utf8');
      this.d.bus.emit('suggestions.changed', { projectId: id });
      return true;
    } catch (e) {
      this.d.log.warn('Writing suggestion bubbles failed', errorMessage(e));
      return false;
    } finally {
      this.running.delete(id);
    }
  }
}
