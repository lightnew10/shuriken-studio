import { PROJECT_MAX_AGENTS } from '../orchestrator/concurrency';
import type { DirectorOutput } from '../agents/roles';

/**
 * Opinions are not commands. On 2026-10-05, right after "stop", the user wrote "this is actually good for autonomous
 * complex builds, I've changed my mind on it" (an opinion about the automatic milestones) and the director answered
 * "I'm resuming it" and restarted the team; the user had to say "bro, no, stop". The model's reading of a message is
 * not the user's word: changing what the team is doing (resume, pause, stop) needs the user's own words to ask for
 * it, the way the store push does (asksStorePush). Anything else is answered, and nothing changes.
 */

/** What the app passes on from a copilot ("From the UI copilot: …") is not the user's word. */
const fromCopilot = (text: string) => /^\s*From the [\w &-]+ copilot:/i.test(text);

const sentences = (text: string) => text.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);

/** A question about it ("should I resume?") is not the word to do it; "can you resume?" is. */
const mereQuestion = (sentence: string) => /\?\s*$/.test(sentence) && !/^\s*(?:ok(?:ay)?,?\s+|yes,?\s+|alright,?\s+)?(?:please\s+)?(?:can|could|would|will) you\b/i.test(sentence);

const NOT = /\b(?:don'?t|do not|never|not yet|no need|not now|wait|hold off|shouldn'?t|stay (?:stopped|paused)|keep (?:it |them |the team )?(?:stopped|paused))\b/i;

const RESUME = /\b(?:resume|unpause|continue|carry on|keep going|go ahead|go on(?! about)|restart|start (?:it|them|the team|work|working|everything|again|back up|these|those|the agents|agents|up)|back to work|get (?:back to work|going|it going|them going)|let'?s go|proceed|do it now|kick (?:it|them) off|(?:get|go) to work)\b/i;

const HALT = /\b(?:stop|pause|halt|hold (?:on|up|off|it)|freeze|kill|enough|that'?s it for now|cancel everything|shut (?:it )?down)\b/i;

/** The user's own message asks for the team to run again. */
export function asksResume(text: string): boolean {
  if (fromCopilot(text)) return false;
  return sentences(text).some((s) => {
    if (!RESUME.test(s)) return false;
    // "what's going on?", "it keeps going on its own": not an order.
    if (/\bgoing on\b/i.test(s) && !/\bkeep going\b/i.test(s)) return false;
    if (NOT.test(s)) return false;
    return !mereQuestion(s);
  });
}

/** The user's own message asks for the team to pause or stop. A false yes only holds work back, so this is broad. */
export function asksHalt(text: string): boolean {
  if (fromCopilot(text)) return false;
  return sentences(text).some((s) => {
    if (!HALT.test(s)) return false;
    if (/\b(?:don'?t|do not|never|no need to|shouldn'?t)\s+(?:stop|pause|halt|kill|freeze)\b/i.test(s)) return false;
    if (/\b(?:stop|pause)\s+(?:asking|saying|explaining)\b/i.test(s)) return false;
    return !mereQuestion(s);
  });
}

/** The user's own message asks for work (a change, a fix, something new): that means "go" even for a stopped team. */
export function requestsWork(text: string): boolean {
  if (fromCopilot(text)) return true;
  return sentences(text).some((s) => {
    if (mereQuestion(s)) return false;
    return /^(?:ok(?:ay)?,?\s+|now,?\s+|also,?\s+|and\s+|then\s+)?(?:please\s+)?(?:add|make|build|fix|change|do|turn|expand|create|put|give|remove|replace|redo|rebuild|move|swap|tweak|improve|polish|finish|implement)\b/i.test(s) || /\b(?:can|could|would|will) you\b|\bplease\b|\bi (?:want|need)\b|\bi'?d like\b|\bwe need\b|\blet'?s (?:add|make|build|fix|change|do)\b/i.test(s);
  });
}

export interface CommandGate {
  out: DirectorOutput;
  /** What the model wanted and the user's words didn't ask for: the team's state is left as it is. */
  heldBack: 'resume' | 'halt' | null;
}

/** Resume, pause and stop happen only when the user's own words ask for them; otherwise the message is answered. */
export function commandGate(text: string, out: DirectorOutput): CommandGate {
  if (out.intent === 'resume' && !asksResume(text)) return { out: { ...out, intent: 'chat' }, heldBack: 'resume' };
  if ((out.intent === 'pause' || out.intent === 'stop') && !asksHalt(text)) return { out: { ...out, intent: 'chat', resumeInMinutes: undefined }, heldBack: 'halt' };
  return { out, heldBack: null };
}

/** A reply that says the team is running again (or will stop) when it didn't: replaced, never left standing. */
export const claimsResume = (reply: string) => /\b(?:resum(?:e|ed|ing)|running again|unpaus|carry(?:ing)? on|picks? up where|restart(?:ed|ing)?|starting (?:it|them|the team) again)\b/i.test(reply);
export const claimsHalt = (reply: string) => /\b(?:stopp(?:ed|ing)|paus(?:ed|ing)|halt(?:ed|ing)|holding)\b/i.test(reply);

export const RESUME_HELD = "The team stays stopped: your message didn't ask me to start it again. Say \"resume\" when you want it running.";
export const HALT_HELD = "The team keeps working: your message didn't ask me to stop it. Say \"stop\" or \"pause\" if you want it held.";
export const STILL_STOPPED = '(The team is still stopped, so this waits until you say "resume".)';

/**
 * "Don't resume yet; resume when the plan is ready" (2026-10-05, mech: "do not resume it yourself, have the planner resume
 * when the plan is formulated"). The team stays stopped now and runs again by itself when the plan update is ready.
 */
export function asksResumeAfterPlan(text: string): boolean {
  if (fromCopilot(text)) return false;
  return /\b(?:resume|start|run|go)\b[\s\S]{0,40}\b(?:when|once|after)\b[\s\S]{0,30}\b(?:plan|planner|planning)\b/i.test(text) || /\b(?:planner|plan)\b[\s\S]{0,30}\b(?:resume|start)s?\b[\s\S]{0,30}\b(?:when|once|after)\b/i.test(text);
}

/** "Wrap it up": cancel what hasn't started, add nothing, let running work finish (Orchestrator.wrapUp). */
export function asksWrapUp(text: string): boolean {
  if (fromCopilot(text)) return false;
  return sentences(text).some((x) => !mereQuestion(x) && !NOT.test(x) && /\b(?:wrap (?:it |things |this |everything )?up|wrapping (?:it )?up|wind (?:it |things )?down|finish up|finish what'?s (?:running|left)|no (?:more|new) (?:tasks|work|agents|polish)|stop adding|just finish|chop chop)\b/i.test(x));
}

/** The user wants their own words passed on unchanged ("verbatim", "word for word", "without paraphrasing"). */
export function asksVerbatim(text: string): boolean {
  return /\b(?:verbatim|word for word|word-for-word|without paraphras\w*|don'?t paraphrase|exactly as (?:i|I) (?:wrote|said|put) it|as (?:i|I) wrote it|my (?:exact |own )?words|in my words|straight to the planner)\b/i.test(text);
}

/** … and the director's own suggestions beside them ("separately provide your suggestions"). */
export const wantsSuggestions = (text: string) => /\b(?:your (?:own )?(?:suggestions|ideas|thoughts|take|recommendations)|separately)\b/i.test(text);

/** A number of agents the user sets for this window ("run 6 agents", "set the agent limit to 4"); null when none. */
export function askedAgentLimit(text: string): number | null {
  if (fromCopilot(text)) return null;
  const m = /\b(\d{1,2})\s*(?:agents?|workers?)\b/i.exec(text) ?? /\b(?:agents?|agent limit|agent cap|limit|cap|at once)\b[^.\d]{0,30}\b(\d{1,2})\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= PROJECT_MAX_AGENTS ? n : null;
}

/** A standing preference for the rest of the project ("always use Kiln", "from now on no QA passes"). */
export function statesPreference(text: string): boolean {
  if (fromCopilot(text)) return false;
  return /\b(?:always|never|from now on|going forward|in (?:the )?future|for the rest of (?:the|this) (?:project|build|game)|every time|remember (?:that|to)|keep in mind|i prefer|prefer to|make sure (?:you|to) always|don'?t ever|stop (?:adding|making|doing|using))\b/i.test(text);
}

const STOPPED_CLAIM = /\b(?:team|work|agents?|everything)\b[^.!?\n]{0,60}\b(?:is|are|stays?|remains?|still|currently)\b[^.!?\n]{0,30}\b(?:stopped|paused|on hold|held)\b|\bnothing (?:will )?(?:start|run)s?\b(?! (?:new|else))|\buntil you (?:say|tell me(?: to)?) "?resume|\bonly start once you\b|\bwon'?t start until\b/i;
const RUNNING_CLAIM = /\b(?:team|work|agents?)\b[^.!?\n]{0,40}\b(?:is|are)\b[^.!?\n]{0,20}\b(?:running|working|going|back at it)\b|\b(?:i'?ve |i have |i'?m )?resum(?:ed|ing) (?:the team|work|everything)\b|\bstarting (?:it |them |work )?now\b/i;

/** Whether a reply says the team is stopped (and waits for "resume"). */
export const saysStopped = (reply: string) => STOPPED_CLAIM.test(reply);

/**
 * A reply never states a run state that isn't so. Written before the app acted, it said "the team is still stopped"
 * in 16 replies while the same second's status line said it was running again (and agents started). Sentences that
 * claim the opposite of the real state are dropped and one true sentence takes their place.
 */
export function reconcileRunState(reply: string, paused: boolean): string {
  const parts = reply.split(/(?<=[.!?])\s+|\n+/);
  const wrong = paused ? RUNNING_CLAIM : STOPPED_CLAIM;
  const kept = parts.filter((x) => !wrong.test(x));
  if (kept.length === parts.length) return reply;
  const truth = paused ? 'The team is stopped: say "resume" when you want it running.' : 'The team is running.';
  return [...kept.filter((x) => x.trim()), truth].join(' ').trim();
}

const normal = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Boilerplate the user has already read: a sentence of this reply that appeared, word for word, in two of the recent
 * replies is dropped ("The plan changes when the planner finishes" was said 13 times in one project). The reply keeps at
 * least its first sentence.
 */
export function dropRepeats(reply: string, recent: string[]): string {
  const seen = new Map<string, number>();
  for (const r of recent) for (const x of new Set(r.split(/(?<=[.!?])\s+/).map(normal).filter((y) => y.length > 25))) seen.set(x, (seen.get(x) ?? 0) + 1);
  const parts = reply.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((x, i) => i === 0 || (seen.get(normal(x)) ?? 0) < 2);
  return kept.length === parts.length ? reply : kept.join(' ');
}
