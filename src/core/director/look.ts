import type { ToolCallRecord } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { ROLES, type DirectorOutput, type RoleDefinition } from '../agents/roles';

/**
 * The director's looking pass. The director reads every message in one quick pass (the chat tier, no file tools): that routes instructions in seconds, but a question about the game got a guess. When the quick
 * pass finds that the message needs facts its state doesn't hold (intent "look"), this second pass answers it:
 * the deep tier, with the read-only file tools and the Shuriken tools below, none of which
 * changes the game, the plan or Studio. What it can do beyond reading is what the director always could through
 * its structured result (start work, task controls), and only when the user's message doesn't forbid it.
 */

/**
 * Everything the looking pass may call: reads of the project state, the tasks' evidence, the tests, what was
 * decided without asking, the guides and the project's knowledge, the code index, and Studio (its state, console
 * and instance tree, the viewport as it is). Not here on purpose: ui_audit (it starts a playtest for UI that
 * scripts build), roblox_screenshot (it moves the user's camera), and every tool that writes.
 */
export const LOOK_TOOLS: readonly string[] = [
  'project_overview', 'task_list', 'task_get', 'evidence_search', 'evidence_view', 'test_list', 'test_results', 'decided_list',
  'skill_list', 'skill_get', 'knowledge_search', 'spec_get', 'code_query',
  'studio_place', 'roblox_console', 'roblox_explore', 'roblox_inspect', 'roblox_search', 'map_preview', 'map_audit', 'ui_snapshot',
  'reference_list', 'reference_view',
];

const LOOK_INSTRUCTIONS = `THE LOOKING PASS. Your first pass found that this message needs facts your state does not hold, and
handed it to you with tools to look. Everything you can call only reads: nothing changes the game, the
plan or Studio, so "don't take any actions" never stops you from looking.
What you can look at:
- The project's files, with Read, Glob and Grep from the project folder: the game's code under the
  source folder (what is on disk is what runs in the game), world builders under world/, docs/, the
  spec. Read a file before you describe what it does.
- What the tasks proved: task_get (a task's full result, its criteria, its checks and the list of its
  evidence; ids are in "Built so far"), evidence_search (every task's test results, measurements,
  playtest consoles, critic reviews and screenshots, found by words: "phone", "ProfileStore", a check's
  name) and evidence_view (one piece in full; a screenshot comes back as a picture you can see).
- The tests: test_results (totals, each test's last status and what it printed), test_list.
- decided_list: what the system settled without asking the user, and the planner's design decisions.
- Studio: studio_place (connected or not, the open places, the window the project is linked to, the
  place file or a recovery copy, saving, Edit or Play mode), roblox_console (Studio's output),
  roblox_explore, roblox_inspect and roblox_search (the instance tree in Edit mode; they wait while an
  agent playtests, so prefer the files), map_preview (the newest screenshots; live: true is the
  viewport right now, a desktop-size picture that says nothing about a phone), map_audit, ui_snapshot
  (the last UI audit: where each screen's elements land on a phone and on a desktop, and its findings).
- The user's references (clips of other games, pictures): reference_list, and reference_view (a reference's
  study, its frames by time, its measured sound, the picture). Frames are samples and sound is measured, not
  heard; speech is not transcribed: say so when it matters.
- How Roblox does things: skill_list and skill_get are the guides the specialists follow (saving,
  UI on phones and input, networking, combat, world building), knowledge_search what the team learned
  on this project, spec_get the game's spec, code_query the code index (remotes, DataStores, who
  requires what).
How to look: start from the lines of "Built so far" that touch the question, open those tasks and
their evidence, then read the code they name. Ask for independent things in the same turn. Stop when
the question is answered (usually two to five turns); don't survey the whole project, and don't read
a file twice.
How to answer, in "reply":
- Lead with the answer, then the facts behind it. It may be longer than usual when you report
  findings (a short list is fine); keep the plain words.
- Say what you checked, by name: the file you read ("I read GarageController.luau"), the task and its
  evidence ("the touch controls task measured the buttons at 844x390"), the console line, the test.
  Naming a file you read is fine here.
- Keep three things apart: what you saw for yourself in this pass, what a task recorded as checked,
  and what nobody has checked. Never fill the third with a guess.
- A question about how Roblox or Studio does something has two halves, answer both: what Roblox and
  Studio offer (from the guides first, then what you know, said as general Roblox knowledge: e.g.
  Studio itself does not split devices, the game's UI code does, and Studio's Device emulator on the
  Test tab previews phone and tablet sizes with touch), and what THIS game does about it (read its
  code).
- If something could not be looked at (Studio not connected or not drawing, no audit saved), say
  exactly that and what would settle it.
The result: the same structured result as always. "question" when you only answer. When the message
also asks for work that depends on what you found, and does not forbid actions, use the acting intent
with every detail you now know ("iterate" with steps that name the files and numbers). Never return
"look".`;

/** The director for its looking pass: same identity and result, read-only tools, the deep tier (at the agents' effort, high by default). */
export const DIRECTOR_LOOK: RoleDefinition = {
  ...ROLES.director!,
  description: 'Looks into the project, the evidence and Studio to answer a question about the game.',
  // Whatever tier the chat is set to: an answer about the game is worth the strongest model.
  model: 'deep',
  effort: 'high',
  builtinTools: ['read_files'],
  appTools: [...LOOK_TOOLS],
  // A turn is counted per tool result; a look is two to five rounds of a few reads each. This is what stops a look that
  // wanders. No dollar cap: the director's context grows with the project, so a fixed sum cut off big projects' looks
  // before they had read anything (AI Empires, about 80,000 tokens of context: $2 gone in 6 to 17 seconds).
  maxTurns: 40,
  instructions: `${ROLES.director!.instructions}\n\n${LOOK_INSTRUCTIONS}`,
};

/**
 * The user asked for no actions ("don't take any actions", "just look", "don't change anything"): looking is
 * allowed, starting or steering work is not. Deliberately narrow: a false positive would drop a real request.
 */
export function noActionsAsked(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  if (
    /\b(?:don'?t|do not|dont|without)\s+(?:take|taking|do|doing|make|making|start|starting)\s+(?:any\s+|an\s+)?(?:actions?|changes?)\b/.test(t) ||
    /\b(?:don'?t|do not|dont)\s+(?:change|touch|edit|modify|fix|build|start|do)\s+(?:anything|a thing)\b/.test(t) ||
    /\bno\s+(?:actions?|changes?)(?:\s+(?:yet|please|for now|right now|at all))?\s*(?:[.,;:!?)]|$)/.test(t) ||
    /\b(?:change|touch|start)\s+nothing\b/.test(t)
  )
    return true;
  // "Just look" forbids actions unless the same message goes on to ask for one ("just look at it, then fix it").
  return /\b(?:just|only)\s+(?:look|looking|scope|scoping)\b/.test(t) && !/\b(?:and|then)\s+(?:fix|change|make|add|build|update|remove|redo|start)\b/.test(t);
}

/** Intents and fields of a director result that start or steer work. */
const ACTING: ReadonlySet<DirectorOutput['intent']> = new Set(['change', 'new_goal', 'iterate', 'side_task', 'pause', 'stop', 'resume']);

/** The note added when a result wanted to act although the user asked for no actions. */
export const HANDS_OFF_NOTE = '(You asked me not to take any actions, so nothing was started or changed.)';

/**
 * A director result with everything that acts taken out (for a message that asked for no actions). `dropped`
 * says whether anything was: the reply then gets HANDS_OFF_NOTE, since it may speak of work that won't happen.
 */
export function handsOff(out: DirectorOutput): { out: DirectorOutput; dropped: boolean } {
  const dropped = ACTING.has(out.intent) || (Array.isArray(out.tasks) && out.tasks.length > 0) || out.restudy === true || !!out.tell?.message || out.storePush === true || out.freeStudio === true || (Array.isArray(out.cards) && out.cards.length > 0);
  if (!dropped) return { out, dropped };
  return { out: { ...out, intent: 'question', tasks: [], steps: [], restudy: false, tell: undefined, storePush: false, freeStudio: false, cards: [] }, dropped };
}

const fileOf = (path: unknown) => (typeof path === 'string' && path ? path.split(/[\\/]/).pop()! : null);

/**
 * What a looking pass looked at, in the user's words, from its recorded tool calls (not from what the model
 * says it did): files read, tasks and evidence opened, the tests, Studio, the guides. Oldest first, no repeats.
 */
export function lookTrail(p: ProjectContext, calls: readonly ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string | null) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  const ordered = [...calls].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const c of ordered) {
    if (c.status === 'denied') continue;
    const a = (c.args ?? {}) as Record<string, unknown>;
    const name = c.tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
    switch (name) {
      case 'Read':
        add(fileOf(a.file_path));
        break;
      case 'Grep':
        add(typeof a.pattern === 'string' ? `the code (searched for "${a.pattern.slice(0, 40)}")` : 'the code');
        break;
      case 'Glob':
      case 'LS':
        add('the project folder');
        break;
      case 'task_get': {
        const t = typeof a.id === 'string' ? p.tasks.get(a.id) : null;
        add(t ? `the task "${t.title.slice(0, 60)}"` : null);
        break;
      }
      case 'task_list':
      case 'project_overview':
        add('the task list');
        break;
      case 'evidence_search':
        add(typeof a.query === 'string' && a.query.trim() ? `the tasks' evidence (for "${a.query.trim().slice(0, 40)}")` : "the tasks' evidence");
        break;
      case 'evidence_view': {
        const row = typeof a.id === 'string' ? p.store.get<{ title: string }>('SELECT title FROM task_evidence WHERE id = ?', [a.id]) : null;
        add(row ? `evidence "${row.title.slice(0, 60)}"` : null);
        break;
      }
      case 'test_results':
      case 'test_list':
        add('the tests and their last results');
        break;
      case 'decided_list':
        add('what was decided without asking');
        break;
      case 'skill_get':
        add(typeof a.name === 'string' ? `the guide ${a.name}` : null);
        break;
      case 'skill_list':
        add('the list of guides');
        break;
      case 'knowledge_search':
        add("the team's notes");
        break;
      case 'spec_get':
        add('the spec');
        break;
      case 'code_query':
        add('the code index');
        break;
      case 'studio_place':
        add("Studio's state");
        break;
      case 'roblox_console':
        add("Studio's output");
        break;
      case 'roblox_explore':
      case 'roblox_inspect':
      case 'roblox_search':
        add('the place in Studio');
        break;
      case 'map_preview':
        add(a.live ? 'the Studio viewport and the latest screenshots' : 'the latest screenshots');
        break;
      case 'map_audit':
        add('the map audit');
        break;
      case 'ui_snapshot':
        add('the last UI audit');
        break;
    }
  }
  return out;
}

/**
 * The look's chat line: short text, with what was looked at kept as its folded detail (`data.trail`, `data.detail`).
 * "Looked at: … searched for "MemoryStore|MessagingService|TeleportSer"" was posted as chat text after every look.
 */
export function lookNote(trail: readonly string[], done: boolean): { text: string; data: Record<string, unknown> } {
  const n = trail.length;
  const text = done ? (n ? `Looked into ${n} thing${n === 1 ? '' : 's'} before answering.` : 'Looked into it.') : 'Looking into it before I answer…';
  return { text, data: { look: true, trail: [...trail], detail: trailLine(trail, done) } };
}

/** What a look looked at, in one line: "Looked at: a, b, c" (or what is being looked at, while it runs). */
export function trailLine(trail: readonly string[], done: boolean): string {
  if (!trail.length) return done ? 'Looked into it.' : 'Looking into it before I answer…';
  const shown = trail.slice(0, 12).join(', ');
  const more = trail.length > 12 ? `, and ${trail.length - 12} more` : '';
  return done ? `Looked at: ${shown}${more}.` : `Looking into it: ${shown}${more}…`;
}
