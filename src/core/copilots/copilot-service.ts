import { runImages, saveAttachments, type Attachment } from '../director/attachments';
import { suggestionsOf } from '@shared/suggestions';
import type { ChatMessage } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import type { AgentRunner, RunOutcome } from '../orchestrator/agent-runner';
import type { SkillService } from '../skills/skill-service';
import { ChatService } from '../director/chat-service';
import { resetFromMessage } from '../orchestrator/usage-tracker';
import { AnimationStore } from '../animation/animation-service';
import { EffectStore } from '../effects/effects-service';
import { SoundLibrary } from '../audio/audio-library';
import { ModelStore } from '../modeling/model-store';
import { UiStore } from '../ui/ui-workshop';
import { MockupStore } from '../ui/ui-mockups';
import { versionLabel } from '@shared/ui-mockup';
import { Storefront, itemStatus } from '../storefront/storefront';
import { readArt } from '../capabilities/storefront-tools';
import { ReferenceStore, copilotLines } from '../references/reference-store';
import type { RoleDefinition } from '../agents/roles';
import { COPILOT_DOCKS, COPILOT_REFUSES, COPILOT_ROLES, COPILOT_SKILLS, COPILOT_TITLES, STOREFRONT_COPILOTS, copilotTurnRole, type CopilotId } from './copilot-roles';
import { importTargets, turnMode, type TurnMode } from './intent';
import { applyTarget, parseMockupItem, uiTurnMode, type MockupRef } from './ui-intent';

export interface CopilotDeps {
  project: () => ProjectContext | null;
  runner: AgentRunner;
  bus: EventBus;
  log: ScopedLogger;
  skills: SkillService;
  /** One line each on Studio's connection, the account in use, Kiln… */
  environment?: () => Promise<string[]>;
  /** What the study of an adopted game found (a summary), when there is one. */
  dossier?: (p: ProjectContext) => string | null;
  /** More state for a dock (e.g. Kiln's status for the animation copilot). */
  extraState?: (p: ProjectContext, id: CopilotId) => Promise<string[]>;
}

/** What the user is looking at in the dock when they write (the page passes it along). */
export interface CopilotContext {
  page?: string;
  item?: string;
  note?: string;
}

interface CopilotOutput {
  copilotReply: string;
  show?: Array<{ page: string; item?: string; label: string }>;
  digest?: string;
  handoff?: string;
  /** Follow-up bubbles for the dock ({label, prompt}). */
  suggestions?: unknown;
}

/** Something a copilot made or changed in its dock: a draft (not in the game), or in the game. `of`: the game's one a draft is a new take of. */
export interface DraftRef {
  name: string;
  draft?: true;
  of?: string;
}

/** The tool that puts a dock's draft in the game. */
const USE_TOOL: Record<'animation' | 'audio' | 'effects', string> = { animation: 'animation_use', audio: 'audio_use', effects: 'vfx_use' };

export const copilotChannel = (id: CopilotId) => `copilot:${id}`;

/** A copilot's conversation continues its provider session for this long (then starts afresh). */
const SESSION_MAX_AGE_MS = 24 * 3600_000;
const PAGES = new Set(['animation', 'audio', 'models', 'ui', 'viewer', 'kiln', 'storefront']);

/**
 * The dock copilots' conversations: each dock (Animation, Music & sound, UI, Effects) has its own chat
 * with its copilot, stored with the project (channel "copilot:<dock>"). A copilot keeps one provider
 * session per project and continues it message after message (a new one after a day, an app update,
 * or "New conversation"), so it remembers the conversation and its skills without re-reading them.
 * Messages to one copilot run one at a time, in order. Each reply carries a digest the director reads.
 * Every message gets a draft turn (the copilot's work stays in its dock) unless it asks for the game:
 * the guard is here (`plan`), so no message reaches a copilot with tools it shouldn't have.
 */
export class CopilotService {
  /** The last queued turn per project and copilot (turns run in order). */
  private readonly queues = new Map<string, Promise<void>>();
  /** The run working on a copilot's reply right now. */
  private readonly running = new Map<string, string>();

  constructor(private readonly d: CopilotDeps) {}

  chat(id: CopilotId): ChatService | null {
    const p = this.d.project();
    return p ? new ChatService(p, this.d.bus, copilotChannel(id)) : null;
  }

  /** A message to a copilot (with pictures the user attached). Returns at once; the reply arrives as a chat event on its channel. */
  send(id: CopilotId, text: string, context?: CopilotContext, images: Array<{ name?: string; dataUrl: string }> = []): ChatMessage {
    const p = this.require();
    const chat = new ChatService(p, this.d.bus, copilotChannel(id));
    const ctx = context && (context.item || context.note) ? { page: context.page, item: context.item, note: context.note } : null;
    const attached = images.length ? saveAttachments(p, `${id}-${Date.now().toString(36)}`, images) : [];
    const msg = chat.add({ role: 'user', kind: 'text', text, data: ctx || attached.length ? { ...(ctx ? { context: ctx } : {}), ...(attached.length ? { images: attached } : {}) } : null });
    const key = `${p.summary.id}:${id}`;
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.turn(p, id, chat, text, ctx, attached))
      .catch((e) => this.d.log.warn(`${COPILOT_TITLES[id]} failed`, e));
    this.queues.set(key, next);
    return msg;
  }

  /** Whether a copilot is working on a reply now. */
  busy(id: CopilotId): boolean {
    const p = this.d.project();
    return !!p && this.running.has(`${p.summary.id}:${id}`);
  }

  /** Stops the copilot's current reply (what it already changed stays). */
  async stop(id: CopilotId): Promise<boolean> {
    const p = this.d.project();
    const runId = p ? this.running.get(`${p.summary.id}:${id}`) : undefined;
    if (!runId) return false;
    await this.d.runner.interrupt(runId);
    return true;
  }

  /** Starts a fresh conversation (the next message opens a new session with the dock's state and skills). */
  reset(id: CopilotId): ChatMessage | null {
    return this.chat(id)?.add({ role: 'system', kind: 'status', text: 'New conversation', data: { reset: true } }) ?? null;
  }

  /** Recent work the user did with the copilots, newest first, for the director. */
  digest(p: ProjectContext, limit = 8): string[] {
    const rows = p.store.all<{ channel: string; data: string | null; created_at: string }>(
      "SELECT channel, data, created_at FROM chat_messages WHERE channel LIKE 'copilot:%' AND role = 'copilot' ORDER BY created_at DESC LIMIT 60",
    );
    const out: string[] = [];
    for (const r of rows) {
      type Data = { digest?: string; handoff?: string } | null;
      let data: Data = null;
      try {
        data = r.data ? (JSON.parse(r.data) as Data) : null;
      } catch {
        data = null;
      }
      const line = data?.digest?.trim();
      if (!line) continue;
      const id = r.channel.slice('copilot:'.length) as CopilotId;
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(r.created_at)) / 60_000));
      out.push(`- ${COPILOT_TITLES[id] ?? id}, ${mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`} ago: ${line.slice(0, 240)}`);
      if (out.length >= limit) break;
    }
    return out;
  }

  private require(): ProjectContext {
    const p = this.d.project();
    if (!p) throw new Error('No project is open');
    return p;
  }

  /** The session to continue: the copilot's latest completed run, if recent, same app version, after any reset. */
  private lastSession(p: ProjectContext, id: CopilotId, chat: ChatService): { runId: string; sessionId: string } | null {
    const row = p.store.get<{ id: string; provider_session_id: string | null; started_at: string; app_version: string | null }>(
      "SELECT id, provider_session_id, started_at, app_version FROM runs WHERE role = ? AND status = 'completed' AND provider_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      [COPILOT_ROLES[id].id],
    );
    if (!row?.provider_session_id) return null;
    const version = this.d.runner.appVersion;
    if (version && row.app_version !== version) return null;
    if (Date.now() - Date.parse(row.started_at) > SESSION_MAX_AGE_MS) return null;
    const reset = chat.findLatest('status', (d) => d.reset === true);
    if (reset && reset.createdAt > row.started_at) return null;
    return { runId: row.id, sessionId: row.provider_session_id };
  }

  private async turn(p: ProjectContext, id: CopilotId, chat: ChatService, text: string, ctx: CopilotContext | null, attached: Attachment[] = []): Promise<void> {
    const projectId = p.summary.id;
    const channel = copilotChannel(id);
    const key = `${projectId}:${id}`;
    const started = new Date().toISOString();
    this.d.bus.emit('chat.typing', { projectId, typing: true, channel });
    try {
      const state = await this.dockState(p, id);
      const looking = ctx?.item ? `The user is looking at: ${ctx.item}${ctx.note ? ` (${ctx.note})` : ''} in the ${ctx.page ?? id} dock.` : '';
      const pictures = attached.length
        ? `\n\nThey attached ${attached.length === 1 ? 'a picture' : `${attached.length} pictures`} (above), saved as ${attached.map((a) => `.shuriken/${a.file}`).join(', ')} (Read it again later if you need it)${id === 'ui' ? '; ui_reference {file} reads its colours and fonts and draws a mockup beside it' : ''}.`
        : '';
      // A copilot makes drafts in its dock unless the user asked for the game (copilots/intent.ts).
      const turn = this.plan(p, id, chat, text, ctx);
      const ask = `The user writes:\n"""\n${text}\n"""${pictures}\n\n${turn.line}`;
      const images = runImages(p, attached);
      const run = async (session: { runId: string; sessionId: string } | null): Promise<RunOutcome> =>
        this.d.runner.run({
          project: p,
          role: turn.role,
          task: null,
          signal: new AbortController().signal,
          directive: ask,
          contextText: session ? [ask, looking, `The dock now:\n${state}`].filter(Boolean).join('\n\n') : await this.opening(p, id, chat, state, looking),
          resumeSessionId: session?.sessionId ?? null,
          continuesRunId: session?.runId ?? null,
          images,
          ...(COPILOT_REFUSES[id] ? { refuses: COPILOT_REFUSES[id] } : {}),
          onRun: (runId) => {
            this.running.set(key, runId);
            this.d.bus.emit('chat.typing', { projectId, typing: true, channel, runId });
          },
        });
      const session = this.lastSession(p, id, chat);
      let outcome = await run(session);
      // A session the provider no longer has (or couldn't resume): start afresh once.
      if (session && !outcome.completion.ok && outcome.completion.errorKind !== 'rate_limit' && outcome.completion.errorKind !== 'interrupted') outcome = await run(null);
      const out = outcome.structured as CopilotOutput | null;
      if (!outcome.completion.ok || !out?.copilotReply) {
        if (outcome.completion.errorKind === 'interrupted') {
          chat.add({ role: 'system', kind: 'status', text: 'Stopped. What it changed so far stays.' });
        } else if (outcome.completion.errorKind === 'rate_limit') {
          const reset = resetFromMessage(outcome.completion.error ?? '');
          const when = reset ? ` until about ${new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
          chat.add({ role: 'copilot', kind: 'error', text: `Your Claude account is at its usage limit${when}, so I can't work on this yet. You can switch accounts from the account menu at the top right.` });
        } else {
          chat.add({ role: 'copilot', kind: 'error', text: `I couldn't finish that (${outcome.completion.error ?? 'no reply'}). Try again in a moment.` });
        }
        return;
      }
      const links = (Array.isArray(out.show) ? out.show : [])
        .filter((l) => l && PAGES.has(l.page) && typeof l.label === 'string' && l.label.trim())
        .slice(0, 3)
        .map((l) => ({ page: l.page, item: typeof l.item === 'string' && l.item.trim() ? l.item.trim().slice(0, 80) : undefined, label: l.label.trim().slice(0, 40) }));
      const mockup = id === 'ui' ? this.mockupOfTurn(p, started) : null;
      const made = this.worksOfTurn(p, id, started, turn.mode);
      // The director reads the digest as what changed: a draft turn's work is in the dock, not in the game.
      const said = typeof out.digest === 'string' ? out.digest.trim().slice(0, 300) : '';
      const stillDraft = made.some((w) => w.draft) || (!!mockup && !mockup.applied);
      const digest = said && turn.mode === 'draft' && stillDraft && !/\bdraft|mockup/i.test(said) ? `Draft in the dock, not in the game: ${said}`.slice(0, 320) : said;
      const handoff = typeof out.handoff === 'string' ? out.handoff.trim().slice(0, 2000) : '';
      const suggestions = suggestionsOf(out.suggestions, 3, 48);
      chat.add({
        role: 'copilot',
        kind: 'text',
        text: out.copilotReply,
        data: { ...(links.length ? { links } : {}), ...(digest ? { digest } : {}), ...(handoff ? { handoff } : {}), ...(suggestions.length ? { suggestions } : {}), mode: turn.mode, ...(mockup ? { mockup } : {}), ...(made.length ? { drafts: made } : {}), runId: outcome.run.id },
      });
    } catch (e) {
      this.d.log.warn(`${COPILOT_TITLES[id]} failed`, e);
      chat.add({ role: 'copilot', kind: 'error', text: `Something went wrong: ${(e as Error).message}` });
    } finally {
      this.running.delete(key);
      this.d.bus.emit('chat.typing', { projectId, typing: false, channel });
    }
  }

  /**
   * The kind of turn a message gets and what it runs as: a draft turn (the default: the dock's tools and
   * looking, nothing that changes the game, its code or Studio) or a turn that puts the copilot's work in the
   * game (only when the user said so, pressed the dock's button, or said yes to the copilot's offer).
   */
  private plan(p: ProjectContext, id: CopilotId, chat: ChatService, text: string, ctx: CopilotContext | null): { mode: TurnMode; role: RoleDefinition; line: string } {
    const replies = chat.list(40).filter((m) => m.role === 'copilot' && m.kind === 'text');
    const last = replies[replies.length - 1];
    const lastImported = last?.data?.mode === 'import' || last?.data?.mode === 'apply';
    if (id === 'ui') return this.uiPlan(p, text, ctx, (last?.data?.mockup as (MockupRef & { applied?: boolean }) | undefined) ?? null, lastImported);
    if (id === 'store' || id === 'copy' || id === 'thumbnails') return this.storefrontPlan(p, id, text, last?.data?.mode === 'draft');
    const dock = COPILOT_DOCKS[id];
    const all = this.works(p, id);
    const drafts = all.filter((w) => w.draft).map((w) => w.name);
    // What its last reply made that is still a draft: a plain yes means "put those in".
    const lastDrafts = (Array.isArray(last?.data?.drafts) ? (last!.data!.drafts as DraftRef[]) : []).map((d) => d.name).filter((n) => drafts.includes(n));
    const mode = turnMode(text, { offered: lastDrafts.length > 0 && !lastImported, drafts: drafts.length > 0 });
    const use = `${USE_TOOL[id as keyof typeof USE_TOOL]} {name}`;
    if (mode === 'import') {
      const targets = importTargets(text, ctx?.item, lastDrafts, drafts);
      const what = targets.length
        ? `: the draft${targets.length === 1 ? '' : 's'} ${targets.map((n) => `"${n}"`).join(', ')} (${use} puts a draft in; as: the ${dock.thing} of the game it replaces, when it is a new take of one)`
        : drafts.length
          ? ` (no draft is named: do what they asked; the dock's drafts are ${drafts.slice(0, 8).join(', ')})`
          : '';
      return {
        mode,
        role: copilotTurnRole(id, mode),
        line: `This turn: PUT IT IN THE GAME. The user asked for it in their game${what}. Put in what they asked for with your own tools, check it the way your field does, then say what is in the game now and the line of game code that plays it. Wiring it into the game's code and anything outside your field go in "handoff".`,
      };
    }
    const shown = ctx?.item ? all.find((w) => w.name === ctx.item) : undefined;
    const take = shown && !shown.draft ? ` They are looking at "${shown.name}", which is in the game: a change to it is made as a new draft take under its own name, and replaces "${shown.name}" only when they say so.` : '';
    return {
      mode,
      role: copilotTurnRole(id, mode),
      line: `This turn: DRAFT. Make or change what they ask as a draft in the dock (it shows ${dock.where}). The game, its code and Studio stay as they are: this turn's tools can't change them.${take} End by saying it is a draft, where they see it, and that it goes into the game with the ${dock.button} button or when they tell you. If they seem to want it in the game now, make the draft anyway and offer to put it in.`,
    };
  }

  /**
   * A Storefront copilot's turn. Its work shows on the Storefront page and goes to Roblox only by the user's push (or
   * their upload, for the pictures and the game's copy). The store's design reaches the game's ShurikenStore module
   * only when the user asks for it in the game (or a yes to the copilot's offer while the module is behind).
   */
  private storefrontPlan(p: ProjectContext, id: 'store' | 'copy' | 'thumbnails', text: string, lastWasDraft: boolean): { mode: TurnMode; role: RoleDefinition; line: string } {
    const behind = new Storefront(p.root).moduleBehind(p.extras().syncMap);
    const mode = id === 'thumbnails' ? 'draft' : turnMode(text, { offered: lastWasDraft && behind, drafts: behind });
    const role = copilotTurnRole(id, mode);
    const roblox = 'Nothing goes to Roblox from you: the store goes up with the Push button on the Storefront page (or when the user tells the director), the title, description and pictures by the user\'s own upload.';
    if (id === 'thumbnails')
      return { mode, role, line: `This turn: DRAFT. Make or change the pictures they ask for: they show on the Storefront page's Pictures tab, where the user saves them. The game and its code stay as they are. ${roblox} End by saying what you made and where they see it.` };
    if (mode === 'import')
      return {
        mode,
        role,
        line: `This turn: PUT IT IN THE GAME. The user asked for the store in their game: make the changes they asked for${id === 'copy' ? ' (copy_write)' : ' (store_catalog)'}, then store_module writes and syncs the game's ShurikenStore module. Granting new or changed items in the game's code and its shop UI are the engineers': put them in "handoff" (each key, what it grants, where the game offers it). ${roblox}`,
      };
    return {
      mode,
      role,
      line: `This turn: DRAFT. ${id === 'copy' ? 'Write or change the words they ask for (copy_write): they show on the Storefront page\'s Copy tab.' : 'Change the store\'s design as they ask (store_catalog): it shows on the Storefront page\'s Store tab.'} The game, its ShurikenStore module and Studio stay as they are: this turn's tools can't change them. ${roblox} End by saying what changed and that it is a draft on the Storefront page${id === 'store' ? ', which goes into the game with the page\'s "Put it in the game" button or when they tell you' : ''}.`,
    };
  }

  /** The UI copilot's turn: designing mockups, or building the mockup meant into the game. */
  private uiPlan(p: ProjectContext, text: string, ctx: CopilotContext | null, lastMockup: (MockupRef & { applied?: boolean }) | null, lastImported: boolean): { mode: TurnMode; role: RoleDefinition; line: string } {
    const mode = uiTurnMode(text, { offered: !!lastMockup && !lastMockup.applied && !lastImported });
    const mockups = new MockupStore(p.root).summaries();
    if (mode === 'import') {
      const target = applyTarget(text, ctx?.item, lastMockup, mockups);
      const m = target ? mockups.find((x) => x.name === target.name) : undefined;
      const what =
        target && m
          ? `: the mockup "${m.title}" (${m.name}), version ${target.version}. ui_mockup_list {name: "${m.name}", version: "${target.version}"} has all of it: build exactly that design, not a new one (if their words name another mockup or version, build that one)`
          : mockups.length
            ? ' (no mockup is named: build what they asked; if they mean one of the mockups, ui_mockup_list shows them)'
            : '';
      return {
        mode,
        role: copilotTurnRole('ui', mode),
        line: `This turn: PUT IT IN THE GAME. The user asked for it in their game${what}. Build it in code with the kits (UI code only), sync it, check it in Studio (ui_audit, then ui_mockup_audit {compare: true} for a mockup); then record it (ui_mockup_update {applied: {version, files}}). What it needs from the rest of the game goes in "handoff".`,
      };
    }
    const shown = parseMockupItem(ctx?.item);
    const m = shown ? mockups.find((x) => x.name === shown.name) : undefined;
    const seen = m ? (shown?.version ?? m.chosen ?? m.versions[m.versions.length - 1]?.id) : null;
    return {
      mode,
      role: copilotTurnRole('ui', mode),
      line: `This turn: DESIGN. Answer with a mockup in Shuriken (ui_mockup_create, or ui_mockup_update for a new version${m ? ` of "${m.title}" (${m.name}), whose version ${seen} they are looking at` : ''}). The game, its code and Studio stay as they are: this turn's tools can't change them. If they seem to want it in the game now, mock it up anyway and offer to put it in (they say "put it in the game", or press the mockup's button).`,
    };
  }

  /** What a dock holds: each animation, sound or effect with whether it is a draft, and when it last changed. */
  private works(p: ProjectContext, id: CopilotId): Array<DraftRef & { updatedAt: string; kiln?: boolean; by?: string }> {
    if (id === 'effects') return new EffectStore(p.root).all().map((f) => ({ name: f.effect.name, ...(f.draft ? { draft: true as const } : {}), ...(f.draftOf ? { of: f.draftOf } : {}), updatedAt: f.updatedAt, by: f.createdBy }));
    if (id === 'audio') return new SoundLibrary(p.root).all().map((s) => ({ name: s.name, ...(s.draft ? { draft: true as const } : {}), updatedAt: s.updatedAt }));
    if (id === 'animation') return new AnimationStore(p.root).all().map((f) => ({ name: f.clip.name, ...(f.draft ? { draft: true as const } : {}), ...(f.draftOf ? { of: f.draftOf } : {}), updatedAt: f.updatedAt, by: f.createdBy, ...(f.source?.kind === 'kiln' ? { kiln: true } : {}) }));
    return [];
  }

  /** What the copilot made or changed during a turn (the chat shows each with Open, and Add to game while it is a draft). */
  private worksOfTurn(p: ProjectContext, id: CopilotId, since: string, mode: TurnMode): DraftRef[] {
    return this.works(p, id)
      // Its own work only: the team's agents may be making things at the same time, and Kiln's clips arrive by
      // themselves while the user animates there (only a turn that asked Kiln made them).
      .filter((w) => w.updatedAt >= since && (w.kiln ? mode === 'import' : !w.by || w.by === COPILOT_ROLES[id].id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6)
      .map(({ name, draft, of }) => ({ name, ...(draft ? { draft } : {}), ...(of ? { of } : {}) }));
  }

  /** The mockup the copilot made or changed during a turn (the chat shows it with Open and Put it in the game). */
  private mockupOfTurn(p: ProjectContext, since: string): { name: string; title: string; version: string; versions: string[]; applied?: true } | null {
    const m = new MockupStore(p.root).all().find((x) => x.updatedAt >= since);
    if (!m) return null;
    const added = m.versions.filter((v) => v.createdAt >= since).map((v) => v.id);
    const version = added[added.length - 1] ?? m.chosen ?? m.versions[m.versions.length - 1]?.id;
    if (!version) return null;
    return { name: m.name, title: m.title, version, versions: added, ...(m.applied && m.applied.at >= since ? { applied: true as const } : {}) };
  }

  /** The first message of a session: the game, the dock, the conversation so far, the environment and the copilot's skills. */
  private async opening(p: ProjectContext, id: CopilotId, chat: ChatService, state: string, looking: string): Promise<string> {
    const earlier = chat
      .list(40)
      .filter((m) => m.kind === 'text' && (m.role === 'user' || m.role === 'copilot'))
      .slice(0, -1)
      .slice(-16)
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text.slice(0, 600)}`);
    let env: string[] = [];
    try {
      env = (await this.d.environment?.()) ?? [];
    } catch {
      env = [];
    }
    const skills = COPILOT_SKILLS[id]
      .map((n) => this.d.skills.get(n))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => `### Skill: ${s.name}\n${s.body}`);
    const dossier = this.d.dossier?.(p) ?? null;
    return [
      `Project: ${p.summary.name}`,
      dossier ? `The game (what its study found):\n${dossier}` : '',
      `The dock now:\n${state}`,
      looking,
      earlier.length ? `Earlier in this conversation:\n${earlier.join('\n')}` : '',
      env.length ? `Environment:\n${env.map((l) => `- ${l}`).join('\n')}` : '',
      skills.length ? `Your skills (follow them):\n\n${skills.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** A compact picture of the dock: what the game has in this field right now. */
  private async dockState(p: ProjectContext, id: CopilotId): Promise<string> {
    const lines: string[] = [];
    if (id === 'animation') {
      const store = new AnimationStore(p.root);
      const files = store.all();
      const draftCount = files.filter((f) => f.draft).length;
      lines.push(files.length ? `The dock's animations (${files.length - draftCount} in the game${draftCount ? `, ${draftCount} draft${draftCount === 1 ? '' : 's'}` : ''}):` : 'The game has no animations yet.');
      for (const f of files.slice(0, 40)) {
        const s = store.summary(f);
        const source = f.source?.kind === 'kiln' ? `made in Kiln (${f.source.model}'s ${f.source.clip}${f.source.speed ? `, moves at ${f.source.speed} studs/s` : ''})` : f.preset?.startsWith('rig:') ? `template ${f.preset.slice(4)}` : f.preset ? `preset ${f.preset}` : 'custom';
        lines.push(`- ${s.name}${s.rig ? ` (rig ${s.rig})` : ''}: ${s.duration.toFixed(2)} s, ${s.loop ? 'loops' : 'once'}, ${s.priority}, ${source}${s.markers.length ? `, markers ${s.markers.map((m) => `${m.name}@${m.t}`).join(' ')}` : ''}${f.draft ? `, a DRAFT${f.draftOf ? ` (a new take of ${f.draftOf})` : ''}: not in the game until animation_use adds it` : s.uploaded ? ', in the game, uploaded' : ', in the game'}`);
      }
      const broken = store.broken();
      if (broken.length) lines.push(`Can't build: ${broken.map((b) => `${b.name} (${b.problems[0]})`).join('; ')}`);
      const rigs = Object.entries(new ModelStore(p.root).rigs());
      if (rigs.length) lines.push(`Rigged models: ${rigs.map(([n, r]) => `${n} (${r.joints.length} joints, ${r.legs.length} legs${r.attachments.length ? `, points ${r.attachments.map((a) => a.name).join('/')}` : ''})`).join('; ')}`);
      lines.push(`Played from game code with ${AnimationStore.runtimeLocation(p.extras().syncMap).requirePath}.`);
    } else if (id === 'audio') {
      const sounds = new SoundLibrary(p.root).all();
      lines.push(sounds.length ? `The game's sounds (${sounds.length}):` : 'The game has no sounds yet.');
      for (const s of sounds.slice(0, 50))
        lines.push(`- ${s.name}: ${s.kind}, ${s.source === 'store' ? 'Creator Store' : s.source === 'imported' ? `imported from the web${s.credit ? `, ${s.credit.licenseName}` : ''}` : 'made here'}${s.looped ? ', loops' : ''}, ${s.draft ? 'a DRAFT (not in the game until audio_use adds it)' : s.assetId ? 'in the game, uploaded' : 'in the game, NOT uploaded (silent until it is)'}`);
      lines.push(`Played from game code with ${SoundLibrary.runtimeLocation(p.extras().syncMap).requirePath}.`);
    } else if (id === 'ui') {
      const ui = new UiStore(p.root).get();
      if (!ui?.screens.length) lines.push('No UI has been read from Studio yet (ui_audit reads it).');
      else {
        const problems = ui.findings.filter((f) => f.severity === 'problem').length;
        lines.push(`UI read ${new Date(ui.capturedAt).toLocaleString()}: ${ui.screens.length} screen(s) — ${ui.screens.map((s) => `${s.name}${s.enabled === false ? ' (shown by a script)' : ''}`).join(', ')}`);
        lines.push(`Audit: ${problems} problem(s), ${ui.findings.length - problems} warning(s)${ui.findings.length ? `; e.g. ${ui.findings.slice(0, 4).map((f) => `${f.path}: ${f.message}`).join('; ')}` : ''}`);
      }
      const mockups = new MockupStore(p.root).summaries();
      lines.push(
        mockups.length
          ? `Mockups (designs in Shuriken, in the game only where it says so): ${mockups
              .slice(0, 12)
              .map((m) => `"${m.title}" [${m.name}] versions ${m.versions.filter((v) => !v.retired).map((v) => versionLabel(v)).join(', ')}${m.versions.some((v) => v.retired) ? ` (retired: ${m.versions.filter((v) => v.retired).map((v) => v.id).join(', ')})` : ''}${m.chosen ? `, ${m.chosen} picked by the user` : ''}${m.applied ? `, ${m.applied.version} in the game` : ''}`)
              .join('; ')}`
          : 'No mockups yet.',
      );
    } else if (id === 'effects') {
      const fx = new EffectStore(p.root).all();
      const inGame = fx.filter((f) => !f.draft);
      const drafts = fx.filter((f) => f.draft);
      const one = (f: (typeof fx)[number]) => `${f.effect.name} (${f.effect.kind}${f.preset ? `, preset ${f.preset}` : ''}${f.draftOf ? `, a new take of ${f.draftOf}` : ''})`;
      lines.push(inGame.length ? `The game's effects (${inGame.length}): ${inGame.map(one).join(', ')}` : 'The game has no effects yet.');
      if (drafts.length) lines.push(`Drafts in the dock (playing in Shuriken's preview, NOT in the game until vfx_use adds them): ${drafts.map(one).join(', ')}`);
      const anims = new AnimationStore(p.root).inGame().filter((f) => f.clip.markers?.length);
      if (anims.length) lines.push(`Animation markers to time effects on: ${anims.slice(0, 20).map((f) => `${f.clip.name} ${f.clip.markers!.map((m) => `${m.name}@${m.t}`).join(' ')}`).join('; ')}`);
    } else if (STOREFRONT_COPILOTS.includes(id)) {
      const sf = new Storefront(p.root);
      const c = sf.catalog();
      const copy = sf.copy();
      const art = readArt(p.root);
      lines.push(
        c.items.length
          ? `The store (${c.style}${c.why ? `: ${c.why.slice(0, 200)}` : ''}), ${c.items.length} item(s):`
          : 'The store has nothing designed yet.',
      );
      for (const i of c.items.slice(0, 40))
        lines.push(`- ${i.key} (${i.kind}, R$${i.price}, ${itemStatus(i)}${i.roblox ? `, id ${i.roblox.id}` : ''}): "${i.name}" — ${i.benefit}${id === 'copy' ? ` | description: ${i.description ? `"${i.description.slice(0, 160)}"` : 'none'}` : ''}${id === 'thumbnails' ? ` | icon: ${i.icon?.file ? `drawn (${i.icon.subject ?? ''})` : i.icon?.subject ? `${i.icon.subject}, not drawn` : 'none'}` : ''}`);
      if (c.items.length && sf.moduleBehind(p.extras().syncMap)) lines.push(`The game's ${Storefront.moduleLocation(p.extras().syncMap).file} is behind this design (a draft not put in the game yet).`);
      lines.push(`Title: ${copy.title ? `"${copy.title}"` : 'not written'}; description: ${copy.description ? `${copy.description.length} characters${id === 'copy' ? `: "${copy.description.slice(0, 600)}"` : ''}` : 'not written'}.`);
      lines.push(`Pictures: ${art.thumbs.length} thumbnail(s)${art.thumbs.length ? ` (${art.thumbs.slice(-8).map((t) => `${t.name}${t.note ? `: ${t.note.slice(0, 60)}` : ''}`).join('; ')})` : ''}${art.pick ? `; the pick: ${art.pick.winner}${art.pick.byUser ? ' (by the user)' : ''}` : ''}; game icon ${art.gameIcon ?? 'not made'}; store icon template ${art.template ? 'set' : 'not set'}.`);
    }
    try {
      lines.push(...((await this.d.extraState?.(p, id)) ?? []));
    } catch {
      /* optional */
    }
    // The user's reference clips and pictures, the ones for this dock's field first.
    const refs = copilotLines(new ReferenceStore(p.dir).list(), COPILOT_ROLES[id].id);
    if (refs) lines.push(refs);
    return lines.join('\n');
  }
}
