import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@shared/ids';
import { suggestionsOf } from '@shared/suggestions';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { ROLES } from '../agents/roles';
import type { AgentRunner } from '../orchestrator/agent-runner';
import { ChatService } from '../director/chat-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import { planSync, SyncBase } from '../roblox/code-sync';
import type { ProjectContext, AdoptedGame } from './project-service';
import { adoptedInstructions, adoptedPlaceLabel, analystBrief, DossierStore, pullScripts, scanCode, SURVEY_LUAU, type Dossier, type DossierOutput, type PlaceSurvey } from './game-study';

export interface AdoptionDeps {
  studio: RobloxStudioAdapter;
  runner: AgentRunner;
  bus: EventBus;
  log: ScopedLogger;
}

/**
 * Plugs a game Shuriken didn't build into its project: waits for its place in Studio, pulls its scripts
 * into files, commits them as the baseline, then studies it (survey, code scan, analyst) and has the
 * director greet the user with what it understood. Progress goes to the director's chat.
 */
export class GameAdoption {
  private readonly studying = new Set<string>();

  constructor(private readonly d: AdoptionDeps) {}

  busy(projectId: string): boolean {
    return this.studying.has(projectId);
  }

  async plugIn(ctx: ProjectContext, game: Omit<AdoptedGame, 'at'>): Promise<void> {
    const chat = new ChatService(ctx, this.d.bus);
    const label = adoptedPlaceLabel(game.place);
    const note = chat.add({ role: 'system', kind: 'status', text: `Plugging in ${label}: waiting for it in Studio…` });
    this.studying.add(ctx.summary.id);
    try {
      await this.waitForPlace();
      chat.update(note.id, { text: `Plugging in ${label}: reading its scripts…` });
      const pull = await pullScripts(ctx, this.d.studio, (t) => chat.update(note.id, { text: `Plugging in ${label}: ${t.charAt(0).toLowerCase()}${t.slice(1)}` }));
      ctx.updateExtras({ syncMap: pull.syncMap, syncMode: 'shuriken', adopted: { ...game, at: nowIso(), pulled: pull.pulled.length, skipped: pull.skipped.length, studiedAt: null } });
      mkdirSync(ctx.dir, { recursive: true });
      writeFileSync(join(ctx.dir, 'instructions.md'), adoptedInstructions(ctx.summary.name, pull.syncMap), 'utf8');
      await ctx.git
        .checkpoint({ label: `Plugged in ${ctx.summary.name}: the game as it was`, kind: 'manual', commit: true })
        .catch((e) => this.d.log.warn('Baseline commit failed', errorMessage(e)));
      const skipped = pull.skipped.length ? ` (${pull.skipped.length} can't be files and stay only in Studio: ${pull.skipped.slice(0, 3).map((x) => x.path.split('/').pop()).join(', ')}${pull.skipped.length > 3 ? ', …' : ''})` : '';
      const n = pull.pulled.length;
      chat.update(note.id, { text: `Plugged in ${label}: ${n === 1 ? '1 script is now a file' : `${n} scripts are now files`} the team works on${skipped}, kept in sync with Studio both ways. Now studying the game…` });
      this.d.bus.emit('project.changed', { projectId: ctx.summary.id });
      await this.studyNow(ctx, chat);
    } catch (e) {
      chat.update(note.id, { kind: 'error', text: `I couldn't plug in ${label} (${errorMessage(e)}). Make sure it's open in Roblox Studio with the MCP server on, then ask me to study the game again.` });
      this.d.log.warn('Plugging in a game failed', errorMessage(e));
    } finally {
      this.studying.delete(ctx.summary.id);
    }
  }

  /** Studies the game again (its files as they are now): survey, code scan, analyst, a fresh brief. */
  async study(ctx: ProjectContext): Promise<void> {
    if (this.studying.has(ctx.summary.id)) return;
    this.studying.add(ctx.summary.id);
    try {
      await this.studyNow(ctx, new ChatService(ctx, this.d.bus));
    } finally {
      this.studying.delete(ctx.summary.id);
    }
  }

  private async studyNow(ctx: ProjectContext, chat: ChatService): Promise<void> {
    const projectId = ctx.summary.id;
    const map = ctx.extras().syncMap;
    const survey = await this.d.studio.luauJson<PlaceSurvey>(SURVEY_LUAU, 'Edit', 120_000).catch((e) => {
      this.d.log.warn('Place survey failed', errorMessage(e));
      return null;
    });
    const scan = scanCode(ctx.root, map);
    const pulled = planSync(ctx.root, map).map((e) => e.file);
    const skipped = new SyncBase(ctx.root).unmapped().map((path) => ({ path, why: "a duplicate or invalid name: it can't be a file" }));
    const brief = analystBrief(ctx.summary.name, ctx.root, { pulled, skipped }, survey, scan);
    this.d.bus.emit('chat.typing', { projectId, typing: true });
    let out: DossierOutput | null = null;
    let failure: string | null = null;
    try {
      const outcome = await this.d.runner.run({
        project: ctx,
        role: ROLES.analyst!,
        task: null,
        signal: new AbortController().signal,
        directive: 'Study this game and write the brief everyone will work from.',
        contextText: brief,
      });
      const o = outcome.structured as DossierOutput | null;
      if (outcome.completion.ok && o && typeof o.gameSummary === 'string' && typeof o.greeting === 'string') out = o;
      else failure = outcome.completion.error ?? 'no study came back';
    } catch (e) {
      failure = errorMessage(e);
    } finally {
      this.d.bus.emit('chat.typing', { projectId, typing: false });
    }
    const dossier: Dossier = {
      name: ctx.summary.name,
      studiedAt: nowIso(),
      complete: !!out,
      gameSummary: out?.gameSummary ?? '',
      systems: Array.isArray(out?.systems) ? out.systems.filter((s) => s && typeof s.name === 'string') : [],
      conventions: strings(out?.conventions),
      risks: strings(out?.risks),
      suggestions: strings(out?.suggestions),
      chips: suggestionsOf(out?.chips, 4),
      greeting: out?.greeting ?? '',
      scripts: { pulled: pulled.length, skipped },
      survey,
      scan,
    };
    new DossierStore(ctx.root).save(dossier);
    const adopted = ctx.extras().adopted;
    if (adopted) ctx.updateExtras({ adopted: { ...adopted, studiedAt: out ? dossier.studiedAt : (adopted.studiedAt ?? null) } });
    this.d.bus.emit('project.changed', { projectId });
    if (out) {
      chat.add({ role: 'director', kind: 'text', text: out.greeting.trim(), data: { study: true, ...(dossier.chips?.length ? { suggestions: dossier.chips } : {}) } });
    } else {
      chat.add({ role: 'director', kind: 'error', text: `I read the place and its code facts, but couldn't finish studying the game (${failure}). You can still ask me for changes, or ask me to study it again.` });
    }
  }

  /** Until the bound place answers in Studio (it may still be opening). */
  private async waitForPlace(timeoutMs = 4 * 60 * 1000): Promise<void> {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      if (this.d.studio.connected && this.d.studio.binding) {
        const r = await this.d.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000).catch((e: unknown) => ({ ok: false, output: errorMessage(e) }));
        if (r.ok) return;
        last = r.output;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(last || 'Studio did not open the place in time');
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
}
