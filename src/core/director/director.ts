import { suggestionsOf } from '@shared/suggestions';
import { withoutFiller } from '@shared/plain-words';
import type { ChatMessage, Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { AgentRunner, RunOutcome } from '../orchestrator/agent-runner';
import { ROLES, roleLabel, type DirectorOutput, type PlanTaskSpec, type RoleDefinition } from '../agents/roles';
import { ChatService } from './chat-service';
import { ReferenceStore, directorLines } from '../references/reference-store';
import { activitySummary } from './activity';
import { PLAN_PENDING_NOTE, claimsPlanChanged } from './plan-claims';
import { pendingUserPlanUpdates } from '../orchestrator/plan-gate';
import { isDecisionTask } from '../orchestrator/autonomy';
import { Narrator } from './narration';
import type { PlainWordsLike } from './plain-words';
import { resetFromMessage } from '../orchestrator/usage-tracker';
import { AnimationStore } from '../animation/animation-service';
import { EffectStore } from '../effects/effects-service';
import { SoundLibrary } from '../audio/audio-library';
import { ModelStore } from '../modeling/model-store';
import { UiStore } from '../ui/ui-workshop';
import { MockupStore } from '../ui/ui-mockups';
import { planSync } from '../roblox/code-sync';
import { builtDigest, builtLines } from './game-digest';
import { placeLinkLines, type PlaceLink } from './place-link';
import { DIRECTOR_LOOK, HANDS_OFF_NOTE, handsOff, lookNote, lookTrail, noActionsAsked } from './look';
import { HALT_HELD, RESUME_HELD, STILL_STOPPED, askedAgentLimit, asksResume, asksResumeAfterPlan, asksVerbatim, asksWrapUp, claimsHalt, claimsResume, commandGate, dropRepeats, reconcileRunState, saysStopped, statesPreference, wantsSuggestions } from './commands';
import { appendPlannerNote } from '../orchestrator/planner-notes';
import { USER_FIRST } from '../orchestrator/autonomy';
import { asksClearCard, findCard, pickedOption, timesSaid } from './cards';

/** A task by id, exact title, or a unique title prefix (case-insensitive). */
const FINISHED: ReadonlySet<string> = new Set(['done', 'cancelled']);

/**
 * The director's reply, rewritten when something it meant to do didn't happen (a task it couldn't find, a push that
 * failed, a card the user's words didn't clear). The reply is written before the app acts; claims such as "I'm pushing
 * the 19 passes now" or "I stopped the final review" stood beside the app's note that it hadn't.
 */
const DIRECTOR_FINAL: RoleDefinition = {
  ...ROLES.director!,
  description: "Rewrites the director's reply so it claims nothing that didn't happen.",
  builtinTools: [],
  appTools: [],
  maxTurns: 2,
  effort: 'low',
  instructions:
    'You rewrite the Director\'s reply to the user. It was written before the app carried out what it asked for, and some of that did NOT happen (listed in your prompt). Keep everything that is still true, remove or correct every claim that something happened when it didn\'t, and say plainly what didn\'t happen and what the user can do. Keep it as short as the original, same voice. Return intent "chat" and the new text in "reply".',
};
const FILLER = new Set(['the', 'and', 'all', 'any', 'other', 'others', 'task', 'tasks', 'for', 'with', 'its', 'job', 'jobs', 'work', 'plan']);

/**
 * The tasks a control names: its id, its title (exact, or a unique beginning), or — failing those —
 * the unfinished tasks whose titles hold every word of it ("the sword-rack tasks"), at most 5.
 */
/** The user's words ask to free Studio from what holds it (a playtest lock, a stuck agent's turn). */
export function asksFreeStudio(text: string): boolean {
  const act = String.raw`(?:free|clear|release|unlock|unstick|kill|end|stop|break|drop)`;
  const what = String.raw`(?:studio|lock|playtest|hold)`;
  return new RegExp(String.raw`\b${act}\b[\s\S]{0,60}\b${what}`, 'i').test(text) || new RegExp(String.raw`\b${what}\b[\s\S]{0,40}\b(?:free|clear(?:ed)?|released?|unlock(?:ed)?)\b`, 'i').test(text);
}

export function findTasks(p: ProjectContext, ref: string): Task[] {
  const r = ref.trim().toLowerCase();
  if (!r) return [];
  const all = p.tasks.list({}).filter((t) => t.kind !== 'objective');
  const byId = all.find((t) => t.id.toLowerCase() === r || r.endsWith(t.id.toLowerCase()));
  if (byId) return [byId];
  const exact = all.filter((t) => t.title.toLowerCase() === r);
  if (exact.length === 1) return exact;
  const prefix = all.filter((t) => t.title.toLowerCase().startsWith(r));
  if (prefix.length === 1) return prefix;
  const words = r.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FILLER.has(w));
  if (!words.length) return [];
  return all.filter((t) => !FINISHED.has(t.status) && words.every((w) => t.title.toLowerCase().includes(w))).slice(0, 5);
}

/** What the workshops have made so far, and what can't play yet (so the director can say so). */
function workshopSummary(p: ProjectContext): string[] {
  return [...workshopLines(p), ...directorLines(new ReferenceStore(p.dir).list())];
}

function workshopLines(p: ProjectContext): string[] {
  // What the docks hold as drafts (the user's experiments with a copilot) is not in the game: listed apart.
  const allAnims = new AnimationStore(p.root).all();
  const allEffects = new EffectStore(p.root).all();
  const anims = allAnims.filter((f) => !f.draft).map((f) => f.clip.name);
  const effects = allEffects.filter((f) => !f.draft).map((f) => f.effect.name);
  const dockDrafts = [...allAnims.filter((f) => f.draft).map((f) => `${f.clip.name} (animation)`), ...allEffects.filter((f) => f.draft).map((f) => `${f.effect.name} (effect)`)];
  const sounds = new SoundLibrary(p.root).all();
  const models = new ModelStore(p.root).all();
  const ui = new UiStore(p.root).get();
  const mockups = new MockupStore(p.root).summaries();
  // The team's scripts (the workshops' generated runtime modules left out), so "show me the combat
  // code" can open one in the viewer.
  let scripts: string[] = [];
  try {
    scripts = planSync(p.root, p.extras().syncMap)
      .map((e) => e.file)
      .filter((f) => !/\/Shuriken[A-Z]\w*\.luau$/.test(f));
  } catch {
    /* no code yet */
  }
  if (!anims.length && !effects.length && !dockDrafts.length && !sounds.length && !models.length && !scripts.length && !ui?.screens.length && !mockups.length) return [];
  const silent = sounds.filter((s) => !s.assetId && !s.draft).map((s) => s.name);
  const drafts = sounds.filter((s) => s.draft).map((s) => s.name);
  const temporary = models.filter((m) => !ModelStore.assetId(m) && m.placements.length === 0).map((m) => m.name);
  const out = ['', 'Game content made so far:'];
  if (anims.length) out.push(`- Animations (${anims.length}): ${anims.slice(0, 20).join(', ')}`);
  if (effects.length) out.push(`- Effects (${effects.length}): ${effects.slice(0, 20).join(', ')}`);
  if (dockDrafts.length) out.push(`- Drafts in the Animation and Effects docks (the user's experiments, not in the game until they add them): ${dockDrafts.slice(0, 20).join(', ')}`);
  const inGame = sounds.filter((s) => !s.draft);
  if (inGame.length) out.push(`- Sounds (${inGame.length}): ${inGame.slice(0, 20).map((s) => s.name).join(', ')}`);
  if (drafts.length) out.push(`- Drafts in the Audio dock (the user's experiments, not in the game): ${drafts.slice(0, 20).join(', ')}`);
  if (silent.length) out.push(`  Not uploaded yet, so silent in the game: ${silent.join(', ')} (they upload by themselves with an Open Cloud key that has the Assets permission, set in Settings)`);
  if (models.length) out.push(`- 3D models (${models.length}): ${models.map((m) => m.name).join(', ')}${temporary.length ? ` (not placed yet: ${temporary.join(', ')})` : ''}`);
  if (scripts.length) out.push(`- Scripts (${scripts.length}): ${scripts.slice(0, 25).join(', ')}${scripts.length > 25 ? ', …' : ''}`);
  if (ui?.screens.length) {
    const problems = ui.findings.filter((f) => f.severity === 'problem').length;
    out.push(
      `- UI screens (${ui.screens.length}, read ${new Date(ui.capturedAt).toLocaleString()}): ${ui.screens.map((s) => `${s.name}${s.enabled === false ? ' (shown by a script)' : ''}`).join(', ')}; audit: ${problems} problem(s), ${ui.findings.length - problems} warning(s)${ui.findings.length ? ` — e.g. ${ui.findings.slice(0, 2).map((f) => `${f.path}: ${f.message}`).join('; ')}` : ''}`,
    );
  }
  if (mockups.length)
    out.push(
      `- UI mockups in the UI dock (the user's designs, in the game only where it says so): ${mockups
        .slice(0, 12)
        .map((m) => `${m.title} (${m.versions.length} version${m.versions.length === 1 ? '' : 's'}${m.chosen ? `, ${m.chosen} picked` : ''}${m.applied ? `, ${m.applied.version} in the game` : ''})`)
        .join(', ')}`,
    );
  const notUploaded = allAnims.filter((f) => !f.draft && !new AnimationStore(p.root).summary(f).uploaded).map((f) => f.clip.name);
  if (notUploaded.length) out.push(`  Animations play in Studio right away; these still need uploading for the published game (the animator uploads final moves with the Open Cloud key, or the Animation page's Upload button): ${notUploaded.slice(0, 20).join(', ')}`);
  return out;
}

export interface DirectorDeps {
  project: () => ProjectContext | null;
  orchestrator: Orchestrator;
  runner: AgentRunner;
  bus: EventBus;
  log: ScopedLogger;
  /** One line each on Studio's connection and the Claude account in use, for answering "is anything wrong?". */
  environment?: () => Promise<string[]>;
  /** Saves the user's feedback about the app for its developers. */
  feedback?: (project: string, note: string) => void;
  /** A game is starting from the chat: set up what the start page would (name, Studio place). */
  prepareBuild?: (project: ProjectContext, request: string, title: string) => void;
  /** What the user did lately in the docks with the copilots (one line each, newest first). */
  copilotDigest?: (project: ProjectContext) => string[];
  /** A plugged-in game's study, in a few lines (null before it's studied). */
  dossier?: (project: ProjectContext) => string | null;
  /** True while a plugged-in game is being pulled in or studied. */
  studying?: (project: ProjectContext) => boolean;
  /** Study a plugged-in game again (the user changed a lot in Studio). */
  restudy?: (project: ProjectContext) => void;
  /** Which Studio window the project is linked to, and whether it is the place file or a recovery copy. */
  placeLink?: PlaceLink;
  /** Who holds Studio's play mode right now (an agent's playtest, a verification), if anyone. */
  playtest?: () => string | null;
  /** Frees Studio from whoever holds its playtest turn, when the user asks (Core.freeStudio); says what it did. */
  freeStudio?: () => Promise<string>;
  /** The fast model's plain-words rewrites of cards, lines and goal titles (narration.ts); absent: the rules alone. */
  plainWords?: PlainWordsLike | null;
  /** The Storefront: its state for the director, and the push the user can ask for (storefront/store-push.ts). */
  storefront?: {
    lines: (project: ProjectContext) => string[];
    /** Pushes what the user's own words name (an item's key or name), else every item not on Roblox yet. */
    push: (project: ProjectContext, text: string) => Promise<{ ok: boolean; summary: string; needsUser?: string }>;
  };
}

/**
 * The user's own message asks to put the store on Roblox: in one sentence, a push word and a store word, or the store
 * "on Roblox", that doesn't say not to (or only ask about it). The director's "storePush" alone never pushes: a
 * model's reading of a vague message is not the user's word, and "create a VIP pass" is a design request.
 */
export function asksStorePush(text: string): boolean {
  // What the app passes on from a copilot ("From the store copilot: …") is not the user's word.
  if (/^\s*From the [\w &-]+ copilot:/i.test(text)) return false;
  const store = String.raw`(?:game ?pass(?:es)?|pass(?:es)?|dev(?:eloper)? ?products?|products?|store)`;
  const anyStore = String.raw`(?:${store}|shop|storefront|purchases?)`;
  const push = new RegExp(String.raw`\b(?:push|publish|upload|send|release|launch)\b[\s\S]{0,60}\b${store}\b`, 'i');
  const onRoblox = new RegExp(String.raw`\b${anyStore}\b[\s\S]{0,40}\b(?:on|to|onto|into)\s+roblox\b`, 'i');
  return text.split(/(?<=[.!?\n])\s+/).some((sentence) => {
    if (!push.test(sentence) && !onRoblox.test(sentence)) return false;
    // Not when it says not to, or not all of it ("but not the VIP": the page pushes exactly what is chosen).
    if (/\b(?:don'?t|do not|never|not|no need|wait|hold off|stop|shouldn'?t|except)\b/i.test(sentence)) return false;
    // A question about it is not the word to do it; "can you push the passes?" is.
    if (/\?\s*$/.test(sentence) && !/^\s*(?:ok(?:ay)?,?\s+)?(?:please\s+)?(?:can|could|would|will) you\b/i.test(sentence)) return false;
    return true;
  });
}

const OPEN = (t: Task) => t.status !== 'done' && t.status !== 'cancelled';

/** The director's iterate steps as plan tasks (implement tasks for real specialists, checks as asked). */
export function iterationSteps(raw: DirectorOutput['steps']): PlanTaskSpec[] {
  const out: PlanTaskSpec[] = [];
  for (const [i, s] of (Array.isArray(raw) ? raw : []).entries()) {
    if (!s || typeof s.objective !== 'string' || !s.objective.trim()) continue;
    const role = typeof s.role === 'string' && ROLES[s.role] && !['director', 'executive', 'critic', 'analyst', 'researcher'].includes(s.role) ? s.role : 'roblox-engineer';
    const criteria = (Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria : []).filter((c) => typeof c === 'string' && c.trim());
    const verification: Array<Record<string, unknown>> =
      s.check === 'playtest' ? [{ kind: 'playtest', name: 'Quick playtest', durationSec: 10, failOnConsoleErrors: true }] : s.check === 'screenshot' ? [{ kind: 'screenshot', name: 'How it looks', instructions: criteria.join('; ') || s.objective.slice(0, 300) }] : [];
    out.push({
      key: typeof s.key === 'string' && s.key.trim() ? s.key.trim() : `s${i + 1}`,
      title: (typeof s.title === 'string' && s.title.trim() ? s.title : s.objective).trim().slice(0, 80),
      kind: 'implement',
      role,
      objective: s.objective.trim(),
      acceptanceCriteria: criteria.length ? criteria : [`Done as asked: ${s.objective.trim().slice(0, 200)}`],
      verification,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : [],
    });
  }
  return out;
}

/** A short, human title from a free-form request ("make a ninja obby with..." → "Ninja obby"). */
const MINOR = new Set(['with', 'and', 'of', 'the', 'a', 'an', 'in', 'on', 'for', 'to', 'where', 'that', 'which', 'from', 'into', 'at', 'by', 'or', 'you', 'your']);

/** A short project name from a prompt: "A sword-fighting arena: drop in from…" → "Sword-fighting Arena". */
export function titleFromPrompt(prompt: string): string {
  // Not the user's opening words ("ugh", "also,", "Not bad!"): goals were named "Ugh the Group Rewards Label" and "Not Bad".
  const first = withoutFiller(prompt) || (prompt.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? prompt);
  let s = first
    .replace(/^(please\s+)?(can you|could you|i want( you)? to|i'd like( you)? to|let'?s|help me)\s+/i, '')
    .replace(/^(make|build|create|design|do|code|write)\s+(me\s+)?/i, '')
    .replace(/^(an?|the|my|some)\s+/i, '')
    .replace(/[.!?]+$/, '');
  // Cut at the first clause boundary when what comes before it can stand as a name on its own.
  const head = s.split(/\s*[:;,(—–]\s*|\s+-\s+|\s+(?:where|that|which|in which|with|featuring|about|set in|inspired by|like)\s+/i)[0] ?? s;
  if (head.split(' ').length >= 2) s = head;
  const words = s.split(' ').filter(Boolean).slice(0, 5);
  while (words.length > 1 && MINOR.has(words[words.length - 1]!.toLowerCase())) words.pop();
  const t = words.map((w, i) => (i === 0 || !MINOR.has(w.toLowerCase()) ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase())).join(' ');
  return t ? (t.length > 40 ? `${t.slice(0, 38).trimEnd()}…` : t) : 'New game';
}

/**
 * The director is the user's single point of contact. The first message starts a build immediately
 * (the plan appears in the chat while its first tasks already run); later messages are interpreted —
 * changes amend the running plan, questions get answers from project state, pause/resume steer work.
 * It also narrates what matters: plan ready, questions that need the user, milestones finished,
 * account switches and usage-limit waits.
 *
 * Two kinds of turn. Every message gets the quick pass (the chat tier, at the agents' effort from Settings): it
 * routes instructions and answers what the state settles. A question about the game that the state does
 * not settle comes back as intent "look" and gets the looking pass (look.ts: the deep tier with read-only
 * tools), whose result is handled exactly like the quick pass's.
 */
/** How often messages held at a usage limit are tried when its reset time isn't known. */
const HELD_RETRY_MS = 10 * 60_000;

export class Director {
  private readonly typing = new Set<string>();

  constructor(private readonly d: DirectorDeps) {
    this.wire();
  }

  chat(): ChatService | null {
    const p = this.d.project();
    return p ? new ChatService(p, this.d.bus) : null;
  }

  /** Start building from a request: an objective whose planner adds tasks that start right away. */
  startBuild(request: string, title?: string): { objective: Task; message: ChatMessage } {
    const p = this.require();
    const chat = new ChatService(p, this.d.bus);
    const objective = this.d.orchestrator.submitObjective({ title: title?.trim() || titleFromPrompt(request), description: request, skipResearch: true });
    const text = p.extras().adopted ? 'Planning it — the first tasks start as soon as they are ready.' : 'Planning your game — the first tasks start as soon as they are ready.';
    // The card belongs to the goal's first planning run, which finishes it (narration.ts).
    const planTaskId = p.tasks.list({ parentId: objective.id, kinds: ['plan'] })[0]?.id ?? null;
    const message = chat.add({ role: 'director', kind: 'plan', text, data: { objectiveId: objective.id, planTaskId, status: 'planning' } });
    return { objective, message };
  }

  /** A message from the user. Returns immediately; replies arrive as chat events. */
  send(text: string): ChatMessage {
    const p = this.require();
    const chat = new ChatService(p, this.d.bus);
    const msg = chat.add({ role: 'user', kind: 'text', text });
    // Every message is read first, the first one too: in a project opened blank, "hi" or "what can
    // you do?" is a conversation, not a game to build.
    // One reply at a time (1.15.8): messages that arrive while the director is answering are answered together next,
    // instead of in parallel replies that contradicted each other ("two windows are open" / "only one window is open").
    const id = p.summary.id;
    if (this.answering.has(id)) {
      this.queued.set(id, [...(this.queued.get(id) ?? []), text]);
      return msg;
    }
    void this.drain(p, chat, [text]);
    return msg;
  }

  private readonly answering = new Set<string>();
  private readonly queued = new Map<string, string[]>();
  /** When the messages held at a usage limit are tried again, per project. */
  private readonly heldTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Answers the user's messages, one batch at a time. Messages held at a usage limit go first, with the new ones
   * (`[]`: only the held ones, as their retry does). A batch the account's limit stops is held again, and tried
   * when it resets (1.15.9: such a message was answered "at its usage limit" and then never again).
   */
  private async drain(p: ProjectContext, chat: ChatService, first: string[]): Promise<void> {
    const id = p.summary.id;
    this.answering.add(id);
    try {
      let batch: string[] | null = first;
      while (batch !== null && this.d.project() === p) {
        const held = p.extras().heldMessages ?? [];
        const texts = [...held.map((h) => h.text), ...batch];
        if (texts.length) {
          const active = p.tasks.list({ kinds: ['objective'] }).filter(OPEN).at(-1) ?? null;
          const text = texts.length === 1 ? texts[0]! : texts.map((t, i) => `(${i + 1}) ${t}`).join('\n\n');
          const note = held.length
            ? `${held.length === texts.length ? (held.length === 1 ? 'This message was' : 'These messages were') : `The first ${held.length === 1 ? 'message was' : `${held.length} were`}`} written while the Claude account was at its usage limit (from ${new Date(held[0]!.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}), and nothing was done about ${held.length === 1 ? 'it' : 'them'} then. The limit has reset: carry ${held.length === 1 ? 'it' : 'them'} out now, from the project as it is now.`
            : '';
          const done = await this.interpret(p, chat, text, active, { note, announceLimit: batch.length > 0, held: held.length });
          if (done.limited) this.hold(p, texts, done.resetAt);
          else if (held.length) {
            p.updateExtras({ heldMessages: [] });
            this.clearHeldTimer(id);
          }
        }
        const more = this.queued.get(id) ?? [];
        this.queued.delete(id);
        batch = more.length ? more : null;
      }
    } finally {
      this.answering.delete(id);
      this.queued.delete(id);
    }
  }

  /** Keeps messages for after the limit, and when to try them again (a minute after the reset; every 10 minutes when it isn't known). */
  private hold(p: ProjectContext, texts: string[], resetAt: number | null): void {
    const before = p.extras().heldMessages ?? [];
    const at = new Date().toISOString();
    const kept = [...before, ...texts.slice(before.length).map((text) => ({ text, at }))];
    p.updateExtras({ heldMessages: kept });
    this.scheduleHeld(p.summary.id, resetAt ? Math.max(30_000, resetAt * 1000 - Date.now() + 60_000) : HELD_RETRY_MS);
  }

  private scheduleHeld(id: string, ms: number): void {
    this.clearHeldTimer(id);
    // Checked again at least every half hour (a reset that came early, a laptop that slept through the timer).
    const t = setTimeout(() => this.retryHeld(id), Math.min(ms, 30 * 60_000));
    t.unref?.();
    this.heldTimers.set(id, t);
  }

  private clearHeldTimer(id: string): void {
    const t = this.heldTimers.get(id);
    if (t) clearTimeout(t);
    this.heldTimers.delete(id);
  }

  /** Tries the held messages again (the open project's only; another project's are tried when it opens). */
  private retryHeld(id: string): void {
    this.heldTimers.delete(id);
    const p = this.d.project();
    if (!p || p.summary.id !== id || !(p.extras().heldMessages ?? []).length) return;
    // A reply in progress takes them in its next batch; looked at again shortly in case it was its last.
    if (this.answering.has(id)) return this.scheduleHeld(id, 15_000);
    void this.drain(p, new ChatService(p, this.d.bus), []);
  }

  /**
   * A new goal with nothing in progress. The project's first game gets the start page's setup (name,
   * Studio place) and the user's own words next to the director's summary, so starting from the chat
   * is no weaker than starting from the start page.
   */
  private beginBuild(p: ProjectContext, request: string, title: string | undefined, text: string): void {
    const first = p.tasks.list({ kinds: ['objective'] }).length === 0;
    const name = title?.trim() || titleFromPrompt(request);
    if (first) {
      try {
        this.d.prepareBuild?.(p, request, name);
      } catch (e) {
        this.d.log.warn('Setting up the game failed', e);
      }
    }
    const words = first && !request.includes(text.trim()) ? `${request}\n\nIn the user's own words: "${text.trim()}"` : request;
    this.startBuild(words, name);
  }

  /** `note`: said to the director with the user's words (messages held at a usage limit). `announceLimit`: a new message is answered when the limit stops it (a retry of held ones isn't). */
  private async interpret(
    p: ProjectContext,
    chat: ChatService,
    text: string,
    active: Task | null,
    opts: { note?: string; announceLimit?: boolean; held?: number } = {},
  ): Promise<{ limited: boolean; resetAt: number | null }> {
    // (A project opened on hold wakes when the user asks for work: see the intents below.)
    const projectId = p.summary.id;
    this.typing.add(projectId);
    this.d.bus.emit('chat.typing', { projectId, typing: true });
    try {
      // What is outside the project database: Studio's windows (never waited on for long) and the environment.
      const around = `${await this.studio()}${await this.environment()}`;
      let outcome = await this.d.runner.run({
        project: p,
        role: ROLES.director!,
        task: null,
        signal: new AbortController().signal,
        directive: `The user just wrote:\n"""\n${text}\n"""\n${opts.note ? `${opts.note}\n` : ''}Decide the intent and reply.`,
        contextText: `${this.state(p, chat, active)}${around}`,
      });
      // A question the state doesn't settle: the looking pass reads the project and answers (or acts on what it found).
      const first = outcome.structured as DirectorOutput | null;
      if (outcome.completion.ok && first?.intent === 'look') outcome = await this.look(p, chat, text, first, `${this.state(p, chat, active, true)}${around}`);
      let out = outcome.structured as DirectorOutput | null;
      if (!outcome.completion.ok || !out) {
        if (outcome.completion.errorKind === 'rate_limit') {
          const reset = resetFromMessage(outcome.completion.error ?? '');
          const when = reset ? ` until about ${new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
          const all = opts.held ?? 0;
          if (opts.announceLimit !== false)
            chat.add({
              role: 'director',
              kind: 'error',
              text: `Your Claude account is at its usage limit${when}. I'll answer ${all ? 'your messages' : 'this'} as soon as it resets, or right away if you switch accounts from the account menu at the top right. ${this.statusNow(p)}`,
            });
          return { limited: true, resetAt: reset };
        } else if (first?.intent === 'look') {
          chat.add({ role: 'director', kind: 'error', text: `I couldn't finish looking into that (${(outcome.completion.error ?? 'no reply').split('\n')[0]!.slice(0, 200)}). Try again, or ask about one part of it at a time.` });
        } else {
          chat.add({ role: 'director', kind: 'error', text: `I couldn't process that just now (${outcome.completion.error ?? 'no reply'}). Try again in a moment.` });
        }
        return { limited: false, resetAt: null };
      }
      // "Don't take any actions": whatever the reply wanted to start or steer is dropped, and the reply says so.
      const held = noActionsAsked(text) ? handsOff(out) : { out, dropped: false };
      out = held.out;
      // Opinions are not commands: resume, pause and stop only when the user's own words ask for them (commands.ts).
      const gate = commandGate(text, out);
      out = gate.out;
      let stillStopped = false;
      let stopping: string | null = null;
      let finalStopped: string | null = null;
      const reopened: string[] = [];
      const reopenRefused: string[] = [];
      // Task controls the user asked for (cancel, first, stop, retry), by id or title — before anything
      // resumes or wakes the team, so a task they cancel never starts.
      const missed: string[] = [];
      const failed: string[] = [];
      for (const c of Array.isArray(out.tasks) ? out.tasks.slice(0, 40) : []) {
        // A goal's final review is no task of the list: "stop the final reviewer" stops it, and the goal finishes without it.
        if ((c.action === 'stop' || c.action === 'cancel') && /\b(?:final (?:review(?:er)?|check)|regression (?:run|suite|check))\b/i.test(String(c?.task ?? ''))) {
          const title = this.d.orchestrator.stopFinalCheck();
          if (title) finalStopped = `Stopped the final review of "${title.slice(0, 80)}": it finishes without the regression run.`;
          else missed.push(String(c.task).trim().slice(0, 80));
          continue;
        }
        const found = findTasks(p, String(c?.task ?? ''));
        if (!found.length) {
          if (String(c?.task ?? '').trim()) missed.push(String(c.task).trim().slice(0, 80));
          continue;
        }
        for (const t of c.action === 'first' || c.action === 'retry' || c.action === 'reopen' ? found.slice(0, 1) : found) {
          try {
            if (c.action === 'cancel') this.d.orchestrator.cancel(t.id);
            else if (c.action === 'stop') this.d.orchestrator.pauseTask(t.id);
            else if (c.action === 'retry') this.d.orchestrator.retry(t.id);
            else if (c.action === 'start') this.d.orchestrator.runNow(t.id);
            else if (c.action === 'reopen') {
              // A finished task the user says is still broken goes back with their words, and must reproduce it first.
              const r = this.d.orchestrator.reopen(t.id, text);
              if (r.ok) reopened.push(r.message);
              else reopenRefused.push(r.message);
            }
            else if (c.action === 'first') {
              const top = Math.max(0, ...p.tasks.list({}).map((x) => x.priority));
              p.tasks.update(t.id, { priority: top + 1 });
              // Marked: a task the user put first is never dropped by an automatic decision (plan_cancel_task).
              p.tasks.addEvidence({ taskId: t.id, runId: null, kind: 'note', title: USER_FIRST, passed: null, data: null, path: null });
              this.d.orchestrator.kick();
            }
          } catch (e) {
            this.d.log.warn(`Director task action ${c.action} failed`, e);
            failed.push(t.title.slice(0, 60));
          }
        }
      }
      // Cards the user cleared or answered: their own words decide (director/cards.ts).
      const cardNotes: string[] = [];
      for (const c of Array.isArray(out.cards) ? out.cards.slice(0, 10) : []) {
        const card = findCard(p, String(c?.card ?? ''));
        if (!card) {
          if (String(c?.card ?? '').trim()) cardNotes.push('(That card is no longer open, so there was nothing to clear.)');
          continue;
        }
        if (c.action === 'dismiss') {
          if (!asksClearCard(text)) cardNotes.push(`(I left the card "${card.title.slice(0, 80)}" open: say "clear that card" if you want it gone.)`);
          else p.governance.dismiss(card.id, `Cleared at your word: "${text.trim().slice(0, 160)}"`, 'director');
        } else if (c.action === 'answer') {
          const option = pickedOption(card, text, typeof c.answer === 'string' ? c.answer : null);
          if (!option) cardNotes.push(`(I didn't answer "${card.title.slice(0, 80)}": tell me which button you pick.)`);
          else {
            this.d.orchestrator.wake();
            p.governance.resolveEscalation(card.id, 'answered', option);
          }
        }
      }
      // The user's word to the agents working right now (and a time limit, when they set one).
      let told: string | null = null;
      if (out.tell && typeof out.tell.message === 'string' && out.tell.message.trim()) {
        try {
          const names = Array.isArray(out.tell.tasks) ? out.tell.tasks.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
          const ids = names.flatMap((n) => findTasks(p, n).map((t) => t.id));
          const reached = names.length && !ids.length ? [] : this.d.orchestrator.tell(out.tell.message, { ...(ids.length ? { taskIds: ids } : {}), finishInMinutes: out.tell.finishInMinutes });
          if (!reached.length) told = '(No agent is working right now, so there was nobody to tell.)';
        } catch (e) {
          this.d.log.warn('Director could not pass a message to the agents', e);
          told = "(I couldn't pass that on to the agents.)";
        }
      }
      // The store on Roblox: the user's own words, not the model's reading of them, decide.
      let pushed: string | null = null;
      if (out.storePush && this.d.storefront) {
        if (!asksStorePush(text)) {
          this.lastPushOk = false;
          pushed = "(To put the store on Roblox, say so in plain words, \"push the passes\", or press Push on the Storefront page.)";
        }
        else {
          try {
            const r = await this.d.storefront.push(p, text);
            this.lastPushOk = r.ok;
            pushed = `${r.summary}${r.needsUser ? ` ${r.needsUser}` : ''}`;
          } catch (e) {
            this.d.log.warn('The store push failed', e);
            this.lastPushOk = false;
            pushed = `(The push failed: ${(e as Error).message})`;
          }
        }
      }
      // Studio freed from a stuck playtest: the user's own words, not the model's reading of them, decide.
      let freed: string | null = null;
      if (out.freeStudio && this.d.freeStudio) {
        if (!asksFreeStudio(text)) freed = '(To free Studio, say so in plain words: "free Studio" or "clear the playtest lock".)';
        else {
          try {
            freed = await this.d.freeStudio();
          } catch (e) {
            this.d.log.warn('Freeing Studio failed', e);
            freed = `(Freeing Studio failed: ${(e as Error).message})`;
          }
        }
      }
      // What didn't happen of what the reply meant to do: the reply is rewritten before it is sent (finalize).
      const failures: string[] = [...reopenRefused, ...missed.map((m) => `couldn't find the task "${m}"`), ...failed.map((m) => `couldn't change "${m}" (already finished)`), ...cardNotes];
      if (out.storePush && pushed && !this.lastPushOk) failures.push(`the store push did not go through: ${pushed}`);
      if (out.freeStudio && freed && !/^Freed Studio|already free/i.test(freed)) failures.push(freed);
      // Wrap-up: cancel what hasn't started, add nothing new, let running work finish.
      let wrapped: string | null = null;
      if (out.wrapUp) {
        if (!asksWrapUp(text)) failures.push('the build was not wrapped up (the message did not ask for it)');
        else {
          const w = this.d.orchestrator.wrapUp();
          wrapped = `Wrapping up: ${w.cancelled} task${w.cancelled === 1 ? '' : 's'} that hadn't started ${w.cancelled === 1 ? 'is' : 'are'} cancelled, and nothing new starts (no triage, polish or final regression run).${w.running.length ? ` Still finishing: ${w.running.slice(0, 5).map((t) => `"${t.slice(0, 60)}"`).join(', ')}${w.running.length > 5 ? ` and ${w.running.length - 5} more` : ''}.` : ' Nothing is running.'}`;
        }
      }
      // This window's number of agents at once.
      let limited: string | null = null;
      if (typeof out.agentLimit === 'number' && Number.isFinite(out.agentLimit)) {
        const n = askedAgentLimit(text);
        if (n === null) failures.push('the agent limit was not changed (the message did not give a number)');
        else {
          p.updateSettings({ agentCap: n });
          this.d.orchestrator.kick();
          limited = `This window now runs at most ${n} agent${n === 1 ? '' : 's'} at once.`;
        }
      }
      // A standing instruction goes into the planner's notes, which every planning run reads.
      if (typeof out.remember === 'string' && out.remember.trim() && statesPreference(text)) appendPlannerNote(p, 'user', out.remember.trim());
      let resumedNow = false;
      let afterPlan = false;
      const work = out.intent === 'change' || out.intent === 'new_goal' || out.intent === 'side_task' || out.intent === 'iterate';
      if (work) {
        // A new request ends a wrap-up.
        this.d.orchestrator.endWrapUp();
        // After the user's "stop", a request is planned but waits for their word to go ("resume", "start", "continue",
        // "go"). Before 1.15.8 any request resumed the team while the reply often said it was still stopped (16 times),
        // and "do not resume it yourself" was overridden. A hold from opening the project lifts quietly.
        const st = this.d.orchestrator.state();
        if (st.paused) {
          if (asksResumeAfterPlan(text)) {
            this.d.orchestrator.resumeWhenPlanned();
            afterPlan = true;
            stillStopped = true;
          } else if (st.held || asksResume(text)) {
            this.d.orchestrator.resume();
            resumedNow = !st.held;
            if (!st.held) chat.add({ role: 'system', kind: 'status', text: 'The team was stopped. It is running again for this request.' });
          } else stillStopped = true;
        }
      } else if (out.resume && out.intent !== 'resume' && out.intent !== 'pause' && out.intent !== 'stop' && asksResume(text) && !asksResumeAfterPlan(text) && this.d.orchestrator.state().paused) {
        this.d.orchestrator.resume();
        resumedNow = true;
      }
      switch (out.intent) {
        case 'change':
        case 'new_goal': {
          const request = this.requestFor(out, text, chat);
          if (active) {
            const plan = this.d.orchestrator.amendPlan(active.id, request);
            // Planning touches nothing in the game: a request made while the team is stopped is planned now, and its
            // tasks wait for the word to go (or start by themselves when the user asked for that: resumeWhenPlanned).
            if (this.d.orchestrator.state().paused) this.d.orchestrator.runNow(plan.id);
            this.d.bus.emit('plan.updated', { objectiveId: active.id, planTaskId: '', status: 'planning' });
          } else {
            this.beginBuild(p, request, out.title, text);
          }
          break;
        }
        case 'iterate': {
          const request = out.request?.trim() || text;
          const steps = iterationSteps(out.steps);
          const blank = p.tasks.list({ kinds: ['objective'] }).length === 0 && !!p.extras().blank;
          const made = steps.length && !blank ? this.d.orchestrator.submitIteration({ title: (out.title?.trim() || titleFromPrompt(request)).slice(0, 80), description: request, steps }) : 'no steps';
          if (typeof made === 'string') {
            // Not a well-formed iteration: plan it instead, as a change or a new goal.
            this.d.log.info(`Iteration not usable (${made}); planning it instead`);
            if (active) this.d.orchestrator.amendPlan(active.id, request);
            else this.beginBuild(p, request, out.title, text);
            break;
          }
          chat.add({ role: 'director', kind: 'plan', text: `Quick change: ${steps.length} task${steps.length === 1 ? '' : 's'}, starting now.`, data: { objectiveId: made.id, status: 'done', tasks: steps.length, iteration: true } });
          break;
        }
        case 'side_task': {
          // One specialist, one job, no planner: the user's "lighthouse" request (test 3).
          const role = out.role && ROLES[out.role] && !['director', 'executive', 'critic'].includes(out.role) ? out.role : null;
          const request = out.request?.trim() || text;
          if (!role) {
            if (active) this.d.orchestrator.amendPlan(active.id, request);
            else this.beginBuild(p, request, out.title, text);
            break;
          }
          p.tasks.create({
            parentId: active?.id ?? null,
            kind: 'implement',
            title: (out.title?.trim() || request).slice(0, 80),
            objective: request,
            reason: 'A standalone request from the user, outside the plan.',
            role,
            status: 'ready',
            priority: 70,
            acceptanceCriteria: [],
            verification: [{ kind: 'critic' }],
            createdBy: 'director',
            maxAttempts: p.settings().maxAttemptsPerTask,
          });
          this.d.orchestrator.kick();
          break;
        }
        case 'pause':
        case 'stop': {
          const minutes = out.resumeInMinutes && out.resumeInMinutes > 0 ? Math.min(out.resumeInMinutes, 7 * 24 * 60) : null;
          if (minutes) this.d.orchestrator.pauseUntil(Date.now() + minutes * 60_000);
          else this.d.orchestrator.pause();
          // Stop: interrupt running agents right away (their tasks pick up again on resume).
          if (out.intent === 'stop') {
            await this.d.orchestrator.stop();
            // "Stopped everything" while four tasks in verification ran on: say what is still finishing.
            for (let i = 0; i < 15 && this.d.orchestrator.state().activeRuns > 0; i++) await new Promise((r) => setTimeout(r, 200));
            const left = this.d.orchestrator.state().activeRuns;
            if (left) stopping = `(${left} ${left === 1 ? 'run is' : 'runs are'} still finishing ${left === 1 ? 'its' : 'their'} current step; nothing new starts.)`;
          }
          break;
        }
        case 'resume':
          if (asksResumeAfterPlan(text)) {
            this.d.orchestrator.resumeWhenPlanned();
            afterPlan = true;
          } else {
            this.d.orchestrator.resume();
            resumedNow = true;
          }
          break;
      }
      // Tasks the user paused one by one stay paused when the team resumes: said, never forgotten.
      const pausedTasks = resumedNow ? p.tasks.list({ statuses: ['paused'] }).filter((t) => t.kind !== 'objective') : [];
      if (out.restudy === true && p.extras().adopted) this.d.restudy?.(p);
      if (typeof out.feedback === 'string' && out.feedback.trim()) {
        try {
          this.d.feedback?.(p.summary.name, `${out.feedback.trim()}\n\n> The user wrote: ${text.slice(0, 1500)}`);
        } catch (e) {
          this.d.log.warn('Could not save feedback', e);
        }
      }
      // Buttons to app pages ("See the combo"), only for pages that exist.
      const PAGES = new Set(['animation', 'audio', 'models', 'ui', 'viewer', 'agents', 'storefront']);
      const links = (Array.isArray(out.show) ? out.show : [])
        .filter((l) => l && PAGES.has(l.page) && typeof l.label === 'string' && l.label.trim())
        .slice(0, 3)
        .map((l) => ({ page: l.page, item: typeof l.item === 'string' && l.item.trim() ? l.item.trim().slice(0, 80) : undefined, label: l.label.trim().slice(0, 40) }));
      // Never claim a control that didn't happen, nor a plan change whose plan update is still pending
      // (this reply's own included: the planner has only just been asked).
      const notes = [
        missed.length ? `(I couldn't find ${missed.map((m) => `"${m}"`).join(', ')} among the tasks, so nothing changed for ${missed.length === 1 ? 'it' : 'them'}.)` : '',
        failed.length ? `(I couldn't change ${failed.map((m) => `"${m}"`).join(', ')}: ${failed.length === 1 ? 'it was' : 'they were'} already finished.)` : '',
        claimsPlanChanged(out.reply) && pendingUserPlanUpdates(p.tasks.list({ kinds: ['plan'], statuses: ['ready', 'running'] })).length ? PLAN_PENDING_NOTE : '',
        held.dropped ? HANDS_OFF_NOTE : '',
        told ?? '',
        pushed ?? '',
        freed ?? '',
        ...cardNotes,
        wrapped ?? '',
        finalStopped ?? '',
        ...reopened,
        ...reopenRefused.map((m) => `(${m})`),
        limited ?? '',
        stopping ?? '',
        pausedTasks.length ? `(${pausedTasks.length === 1 ? 'One task you paused stays' : `${pausedTasks.length} tasks you paused stay`} paused: ${pausedTasks.slice(0, 4).map((t) => `"${t.title.slice(0, 60)}"`).join(', ')}. Say "start" with ${pausedTasks.length === 1 ? 'its' : 'a'} name to run ${pausedTasks.length === 1 ? 'it' : 'one'}.)` : '',
      ].filter(Boolean);
      // A reply that claims a resume or a stop that was held back is replaced; otherwise the reply says what stays.
      let reply = out.reply;
      if (failures.length) reply = await this.finalize(p, reply, failures);
      reply = dropRepeats(reply, chat.list(30).filter((m) => m.role === 'director' && m.kind === 'text').slice(-6).map((m) => m.text));
      if (gate.heldBack === 'resume') {
        if (claimsResume(reply)) reply = RESUME_HELD;
        else notes.push(RESUME_HELD);
      } else if (gate.heldBack === 'halt') {
        if (claimsHalt(reply)) reply = HALT_HELD;
        else notes.push(HALT_HELD);
      }
      // The reply never states a run state that isn't so (the app has acted by now).
      const after = this.d.orchestrator.state();
      reply = reconcileRunState(reply, after.paused);
      if (stillStopped && after.paused && !saysStopped(reply)) notes.push(afterPlan ? '(The team stays stopped now and starts by itself when the plan is ready.)' : STILL_STOPPED);
      else if (afterPlan && !stillStopped) notes.push('(The team starts by itself when the plan is ready.)');
      const honest = notes.length ? `${reply}\n\n${notes.join('\n')}` : reply;
      const suggestions = suggestionsOf(out.suggestions, 3, 48);
      chat.add({ role: 'director', kind: 'text', text: honest, data: links.length || suggestions.length ? { ...(links.length ? { links } : {}), ...(suggestions.length ? { suggestions } : {}) } : null });
    } catch (e) {
      this.d.log.warn('Director failed', e);
      chat.add({ role: 'director', kind: 'error', text: `Something went wrong reading your message: ${(e as Error).message}` });
    } finally {
      this.typing.delete(projectId);
      this.d.bus.emit('chat.typing', { projectId, typing: false });
    }
    return { limited: false, resetAt: null };
  }

  /**
   * The looking pass: the same message and state, read-only tools, a stronger model. A status line in the chat
   * says it is looking while it runs; what was looked at (from the recorded tool calls, not from the model's own
   * account) is the line's folded detail, not chat text.
   */
  private async look(p: ProjectContext, chat: ChatService, text: string, first: DirectorOutput, state: string): Promise<RunOutcome> {
    const note = chat.add({ role: 'system', kind: 'status', ...lookNote([], false) });
    const trail = (runId: string) => lookTrail(p, p.audit.toolCalls({ runId, limit: 300 }));
    let runId: string | null = null;
    let said = 0;
    const off = this.d.bus.on('run.stream', (e) => {
      if (!runId || e.runId !== runId || e.kind !== 'tool_use' || Date.now() - said < 1500) return;
      said = Date.now();
      chat.update(note.id, lookNote(trail(runId), false));
    });
    try {
      const want = typeof first.lookFor === 'string' && first.lookFor.trim() ? `\n\nWhat your first pass wants found out: ${first.lookFor.trim().slice(0, 1500)}` : '';
      const outcome = await this.d.runner.run({
        project: p,
        role: DIRECTOR_LOOK,
        task: null,
        signal: new AbortController().signal,
        directive: `The user just wrote:\n"""\n${text}\n"""\nLook at what answers it, then reply.`,
        contextText: `${state}${want}`,
        onRun: (id) => (runId = id),
      });
      const done = lookNote(trail(outcome.run.id), true);
      chat.update(note.id, { text: done.text, data: { ...done.data, runId: outcome.run.id } });
      // A look that returns "look" again has nothing more to hand over to: its reply is the answer.
      const out = outcome.structured as DirectorOutput | null;
      if (out?.intent === 'look') out.intent = 'question';
      return outcome;
    } finally {
      off();
    }
  }

  private lastPushOk = true;

  /** The reply rewritten so it claims nothing that didn't happen (DIRECTOR_FINAL); the original when that fails. */
  private async finalize(p: ProjectContext, reply: string, failures: string[]): Promise<string> {
    try {
      const o = await this.d.runner.run({
        project: p,
        role: DIRECTOR_FINAL,
        task: null,
        signal: new AbortController().signal,
        directive: `Your reply:\n"""\n${reply}\n"""\n\nWhat did NOT happen:\n${failures.map((f) => `- ${f}`).join('\n')}\n\nRewrite the reply.`,
        contextText: '',
      });
      const text = (o.structured as DirectorOutput | null)?.reply?.trim();
      return o.completion.ok && text ? text : reply;
    } catch (e) {
      this.d.log.warn('Rewriting the reply failed', e);
      return reply;
    }
  }

  /**
   * What goes to the planner for a change. "Verbatim" means the user's own message, exactly (the director's view of
   * earlier messages was cut at 300 characters, and a message went to the planner labelled VERBATIM cut mid-word): this
   * message, or the one before it when this one only says to pass it on. The director's own suggestions go beside it,
   * marked as such, only when the user asked for them.
   */
  private requestFor(out: DirectorOutput, text: string, chat: ChatService): string {
    const asked = out.request?.trim() || text;
    if (!asksVerbatim(text)) return asked;
    const users = chat.list(30).filter((m) => m.role === 'user' && m.kind === 'text');
    const prev = users.length > 1 ? users[users.length - 2]!.text : '';
    const own = text.length >= 200 || !prev || prev.length <= text.length ? text : prev;
    const mine = wantsSuggestions(text) && out.request?.trim() && out.request.trim() !== own.trim() ? `\n\nTHE DIRECTOR'S OWN SUGGESTIONS (separate from the user's words; take or leave them):\n${out.request.trim()}` : '';
    return `USER'S WORDS, VERBATIM (do not paraphrase; plan from these):\n"""\n${own}\n"""${mine}`;
  }

  /** The team's state in one plain sentence, from the records alone (no model): for when the account is at its limit. */
  private statusNow(p: ProjectContext): string {
    const st = this.d.orchestrator.state();
    const working = p.tasks.list({ statuses: ['running', 'verifying', 'reviewing'] }).filter((t) => t.kind !== 'objective');
    const cards = p.governance.escalations('open').length;
    return `Right now the team is ${st.paused ? 'stopped' : 'running'}, with ${working.length} task${working.length === 1 ? '' : 's'} in progress${working.length ? ` (${working.slice(0, 3).map((t) => `"${t.title.slice(0, 50)}"`).join(', ')}${working.length > 3 ? ', …' : ''})` : ''}, and ${cards} card${cards === 1 ? '' : 's'} waiting for you.`;
  }

  /** A compact picture of the project for the director (not a context package). `ids`: finished tasks with their ids, for the looking pass. */
  private state(p: ProjectContext, chat: ChatService, active: Task | null, ids = false): string {
    const objectives = p.tasks.list({ kinds: ['objective'] });
    const lines = [`Project: ${p.summary.name}`, `Work: ${this.d.orchestrator.state().paused ? 'paused' : 'running'}`];
    const why = this.d.orchestrator.whyWaiting();
    if (why.length) lines.push(`Why ready tasks aren't starting: ${why.join('; ')}.`);
    const game = p.extras().cloud?.name;
    if (game) lines.push(`Game on Roblox: "${game}" (call it that).`);
    const adopted = p.extras().adopted;
    if (adopted) {
      lines.push(
        `This is an EXISTING game the user plugged in (from ${adopted.from === 'studio' ? `the Studio place "${adopted.place}"` : 'their place file'}); Shuriken did not build it. Its scripts are files synced with Studio both ways.`,
      );
      const study = this.d.dossier?.(p) ?? null;
      if (this.d.studying?.(p)) lines.push('Its study is running right now (pulling its scripts in, reading the code): say so if they ask something the study would answer.');
      else if (study) lines.push(`What its study found:\n${study}`);
      else lines.push('It has not been studied yet (set "restudy" if they want you to read it).');
      if (objectives.length === 0)
        lines.push(
          'No changes have been requested yet. A request to change, fix or add something is "new_goal" (a focused',
          'goal on this game as it is, never a rebuild): every detail in "request", a short title for the change in',
          '"title". A single specialist job is "side_task" as usual.',
        );
    } else if (objectives.length === 0)
      lines.push(
        'No game has been started in this project yet (it was opened blank): no plan, no agents, no Studio place.',
        'If the user describes a game to make, or asks you to start building one, that is "new_goal": put the',
        'complete game description in "request" (every detail they gave in this chat, in their words, nothing',
        'dropped) and a short name for the game in "title". That names the project, sets up its Studio place and',
        'starts the team, exactly like the start page. Until then just talk: answer questions, help shape the idea.',
      );
    for (const o of objectives.slice(-3)) lines.push(`Goal: "${o.title}" — ${o.status}`);
    if (active) {
      const kids = p.tasks.list({ parentId: active.id }).filter((t) => t.status !== 'proposed' && t.kind !== 'plan');
      lines.push('', `Tasks of the current goal (${kids.length}):`);
      for (const t of kids) {
        // What a finished task delivered is in "Built so far" below, for every goal.
        const note = t.status !== 'done' && (t.status === 'failed' || t.status === 'escalated' || t.status === 'blocked' || t.attempts > 1) && t.failureSummary ? ` — last problem (attempt ${t.attempts}): ${t.failureSummary.split('\n')[0]!.slice(0, 200)}` : '';
        lines.push(`- [${t.status}] ${t.title} (${roleLabel(t.role)}) id:${t.id}${note}`);
      }
      // The planner's work on this goal is not in the list above. Until it finishes the plan has NOT
      // changed, and a plan update the user takes back can only be cancelled by its id.
      const planning = p.tasks.list({ parentId: active.id, kinds: ['plan'] }).filter((t) => !FINISHED.has(t.status) && t.status !== 'proposed' && !isDecisionTask(t));
      if (planning.length) {
        lines.push('', `Planner work not finished yet (${planning.length}) — the plan has NOT changed until each one finishes (never tell the user it has); cancel a plan update by its id if the user takes the request back:`);
        for (const t of planning) lines.push(`- [${t.status}] ${t.title.slice(0, 100)} (${t.createdBy === 'user' ? 'plan update' : 'planning'}) id:${t.id}`);
      }
    }
    // Everything else not finished (older goals, plan updates): the user may want some of it stopped.
    const others = p.tasks
      .list({})
      .filter((t) => t.kind !== 'objective' && !FINISHED.has(t.status) && t.status !== 'proposed' && (!active || t.parentId !== active.id));
    if (others.length) {
      lines.push('', `Other unfinished work (${others.length}), for task controls by id:`);
      for (const t of others.slice(0, 30)) lines.push(`- [${t.status}] ${t.title.slice(0, 100)} (${t.kind === 'plan' ? 'plan update' : roleLabel(t.role)}) id:${t.id}`);
      if (others.length > 30) lines.push(`- … and ${others.length - 30} more`);
    }
    const waiting = p.governance.escalations('open');
    if (waiting.length) {
      const replies = chat.list(80).filter((m) => m.role === 'director' && m.kind === 'text');
      lines.push('', `Cards waiting for the user (${waiting.length}): mention one only when asked, when it matters for this message, or once when it is new. Clear or answer one with "cards" at the user's word:`);
      for (const e of waiting.slice(0, 8)) {
        const t = e.taskId ? p.tasks.get(e.taskId) : null;
        const said = timesSaid(e, replies);
        lines.push(`- card id:${e.id} "${e.title}"${e.options?.length ? ` [buttons: ${e.options.join(' | ')}]` : ' [no buttons]'}${t ? ` — about "${t.title.slice(0, 80)}" (${t.status})` : ''}${said ? ` — said already (${said}×): don't repeat it unless asked` : ''}`);
      }
    }
    lines.push(...activitySummary(p, this.d.runner.listRuns(p, { limit: 40 }), this.d.orchestrator.parallelLimit()));
    // The game as built: what each finished task delivered, what nobody verified, open problems, the tests.
    lines.push(...builtLines(builtDigest(p), { ids }));
    lines.push(...workshopSummary(p));
    const docks = this.d.copilotDigest?.(p) ?? [];
    if (docks.length) lines.push('', 'Work the user did directly in the docks with the copilots (newest first):', ...docks);
    const store = this.d.storefront?.lines(p) ?? [];
    if (store.length) {
      lines.push('', ...store);
      const push = p.audit.timeline({ limit: 400 }).find((e) => e.kind === 'storefront.push');
      if (push) lines.push(`- Last store push (${push.ts.slice(0, 16).replace('T', ' ')} UTC): ${push.title}`);
    }
    const fc = this.d.orchestrator.state().finalCheck;
    if (fc) lines.push('', `Final review running for "${fc.title}" (${fc.done} of ${fc.total} checks): "stop the final review" stops it (tasks: {"action":"stop","task":"final review"}).`);
    const recent = chat.list(10).filter((m) => m.kind === 'text' && m.data?.feedback !== true);
    if (recent.length) {
      // The user's last three messages in full (a message cut at 300 characters can't be passed on as they wrote it).
      const full = new Set(recent.filter((m) => m.role === 'user').slice(-3).map((m) => m.id));
      lines.push('', 'Recent chat:');
      for (const m of recent) lines.push(`${m.role === 'user' ? 'User' : 'You'}: ${m.text.slice(0, full.has(m.id) ? 4000 : 300)}`);
    }
    return lines.join('\n');
  }

  /** Studio and the place: which window the project is linked to and what that means for saving. */
  private async studio(): Promise<string> {
    try {
      const facts = await this.d.placeLink?.soon();
      return facts ? `\n\nStudio and the place:\n${placeLinkLines(facts, { playtest: this.d.playtest?.() ?? null }).join('\n')}` : '';
    } catch {
      return '';
    }
  }

  private async environment(): Promise<string> {
    try {
      const lines = (await this.d.environment?.()) ?? [];
      return lines.length ? `\n\nEnvironment:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
    } catch {
      return '';
    }
  }

  private require(): ProjectContext {
    const p = this.d.project();
    if (!p) throw new Error('No project is open');
    return p;
  }

  /**
   * The chat's story of the build — progress lines, plan cards, question cards, goal endings — is the narrator's
   * (narration.ts): honest about what checked what, in plain words, one card per planning run.
   */
  private wire(): void {
    new Narrator({ project: this.d.project, bus: this.d.bus, log: this.d.log, plainWords: this.d.plainWords ?? null, heuristicTitle: titleFromPrompt }).wire();
    // Messages held at a usage limit: tried soon after another account is chosen, and when their project opens.
    const soon = (ms: number, onlyIfIdle: boolean) => {
      const p = this.d.project();
      if (!p || !(p.extras().heldMessages ?? []).length) return;
      if (onlyIfIdle && this.heldTimers.has(p.summary.id)) return;
      this.scheduleHeld(p.summary.id, ms);
    };
    this.d.bus.on('accounts.changed', () => soon(5_000, false));
    this.d.bus.on('project.changed', () => soon(20_000, true));
  }
}

export { sendBackLine } from './narration';
