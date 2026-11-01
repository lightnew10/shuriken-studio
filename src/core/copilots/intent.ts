/**
 * What a message to a dock copilot asks for. Making a draft is the default: the copilot makes or changes
 * something in its dock (an effect in the effects preview, a sound to listen to, a move on the mannequin, a
 * UI mockup) and the game, its code and Studio stay as they are. Only words that put something in the game
 * ("put it in the game", "add it", "use it for the sword hits", "replace the hit spark with this", the dock's
 * Add to game button) — or a plain yes to the copilot's offer to do that — make a turn that may change the game.
 */
export type TurnMode = 'draft' | 'import';

/** it, this, that… (what the copilot just made, or what is on screen). */
const IT = String.raw`(?:it|this|that|them|these|those)(?:\s+one)?`;
/** The game, as a place something goes. */
const GAME = String.raw`(?:(?:the|my|our)\s+)?(?:(?:actual|real|live)\s+)?(?:game|studio|roblox(?:\s+studio)?|(?<=(?:the|my|our)\s+)place)\b`;

/** "Don't put it in the game yet", "without touching the game", "dont add it". */
const NOT_YET = new RegExp(String.raw`\b(?:don'?t|do\s+not|never|no\s+need\s+to|not\s+yet|without)\b(?:\s+[\w']+){0,2}?\s+(?:(?:put|add|apply|build|touch|chang|ship|wire|implement|install|send|import|upload|plac)\w*|us(?:e|ing)\b)`, 'i');
/** "Not in the game", "just a draft", "only a preview", "keep it a draft". */
const DRAFT_ONLY = new RegExp(String.raw`\bnot\s+(?:in|into|to)\s+${GAME}|\b(?:just|only)\s+(?:a\s+|the\s+)?(?:draft|preview|mockup|sketch)\b|\bkeep\s+${IT}\s+(?:as\s+)?a\s+draft\b|\b(?:as\s+a\s+draft|preview\s+only|draft\s+only)\b`, 'i');
/** A verb that puts something somewhere, then the game (or Studio) as where it goes. */
const INTO_GAME = new RegExp(String.raw`\b(?:put|add|apply|build|implement|ship|wire|install|bring|push|move|fix|change|update|replace|use|make|send|import|place|hook|swap|drop)\b[^.?!\n]{0,80}?\b(?:in|into|to|inside|onto)\s+${GAME}`, 'i');
/** "Remove it from the game", "take the old spark out of the game". */
const OUT_OF_GAME = new RegExp(String.raw`\b(?:remove|delete|take|pull)\b[^.?!\n]{0,60}?\b(?:from|out\s+of)\s+${GAME}`, 'i');
/** "Build it", "apply this", "ship the mockup", "implement version B". */
const BUILD_IT = /\b(?:build|apply|ship|implement)\s+(?:it|this|that|them|these|those|version\s+[a-z]{1,2}\b|the\s+(?:mockup|design|draft|chosen\s+one|one\s+i\s+(?:picked|chose)|version\b|(?:[\w-]+\s+){1,3}(?:mockup|design|draft)))/i;
/** "Add it", "use this one", "import them", "use it for the sword hits" — not "add it to the effect" or "use it as a base". */
const USE_IT = new RegExp(String.raw`\b(?:add|use|import|ship)\s+${IT}(?:\s+(?:all|now|please|then|too|in|instead))*\s*(?=$|[.!,;]|\b(?:for|when|whenever|and|as\s+(?:the|my|our))\b)`, 'i');
/** "Play it in the lobby", "play it when the round starts" — not "play it again" or "play it in the preview". */
const PLAY_IT = new RegExp(String.raw`\bplay\s+${IT}\s+(?:in|on|at|when|whenever|during)\b(?!\s+(?:the\s+|your\s+)?(?:preview|viewer|dock|container|page|app|shuriken)\b)`, 'i');
/** "Replace the hit spark with this", "swap the old jump sound for it". */
const REPLACE = new RegExp(String.raw`\b(?:replace|swap)\b[^.?!\n]{0,60}?\b(?:with|for)\s+(?:${IT}|the\s+(?:new|draft)\b)`, 'i');
/** The message asks for something to be made: its "it" is the new thing, not a draft that already exists. */
const MAKES = /\b(?:make|create|compose|design|generate|write|draft|give\s+me|i\s+(?:want|need)|i'd\s+like|a\s+new)\b/i;
/** "Upload it", "upload the slash". */
const UPLOAD = /\bupload\s+(?:it|this|that|them|these|those|the\b)/i;
/** "Apply B", "build C" (a version letter, in capitals: "build a shop" is a design request). UI mockups only. */
const BUILD_LETTER = /\b(?:[Bb]uild|[Aa]pply|[Ss]hip|[Ii]mplement|[Uu]se)\s+(?:version\s+)?[A-Z]{1,2}\b(?!\s*[a-z])/;
/** A message that is only the instruction. */
const ALONE = /^\s*(?:apply|build|import|ship it|make it real|go live)\s*[.!]*\s*$/i;
/** A request that ends "…just make it." (no questions, no mockup: build it). UI only: elsewhere it means "make the draft". */
const JUST_DO_IT = /\bjust\s+(?:make|build|do)\s+it\s*[.!]*\s*$/i;
/** A plain yes, to the copilot's offer to put its draft in the game. */
const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|alright|go\s+ahead|go\s+for\s+it|do\s+it|ship\s+it|build\s+it|add\s+it|put\s+it\s+in|sounds\s+good|looks\s+good|perfect|great|nice|let'?s\s+(?:do|go|build)\b|please\s+do|y)\b[^?]{0,48}$/i;
/** …unless it asks for changes first ("yes, but bigger buttons"). */
const CHANGES = /\b(?:but|change|make|bigger|smaller|larger|louder|quieter|faster|slower|brighter|instead|except|more|less|try|another|move|swap|darker|lighter|different)\b/i;

/**
 * The kind of turn a message to a copilot gets. `offered`: its last reply made or changed a draft (so a plain
 * yes means "put it in"); `drafts`: the dock holds a draft, so "it" can mean one ("add it", "use it for the
 * sword hits", "play it in the lobby", "replace the hit spark with this" — unless the message asks for
 * something to be made, whose "it" is the new thing: "make a slash and play it on left click" is a draft);
 * `versions`: the dock's drafts have version letters ("apply B": the UI's mockups).
 */
export function turnMode(text: string, opts: { offered?: boolean; drafts?: boolean; versions?: boolean } = {}): TurnMode {
  const t = text.trim();
  if (NOT_YET.test(t) || DRAFT_ONLY.test(t)) return 'draft';
  // Said outright: the game (or Studio) as where it goes, or an instruction to build or upload what exists.
  if (INTO_GAME.test(t) || OUT_OF_GAME.test(t) || BUILD_IT.test(t) || UPLOAD.test(t) || ALONE.test(t)) return 'import';
  // Implied: "it" put to use, when there is a draft it can mean.
  if ((opts.drafts || opts.offered) && !MAKES.test(t) && (USE_IT.test(t) || PLAY_IT.test(t) || REPLACE.test(t))) return 'import';
  if (opts.versions && (BUILD_LETTER.test(t) || JUST_DO_IT.test(t))) return 'import';
  if (opts.offered && YES.test(t) && !CHANGES.test(t)) return 'import';
  return 'draft';
}

/**
 * The drafts a "put it in the game" means: the ones the message names, else the one the user is looking at,
 * else the ones the copilot made last in this conversation. Names the dock doesn't have as drafts are left out.
 */
export function importTargets(text: string, looking: string | undefined | null, last: string[], drafts: string[]): string[] {
  const known = new Set(drafts);
  const named = [...drafts].sort((a, b) => b.length - a.length).filter((n) => new RegExp(`(?<![A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i').test(text));
  if (named.length) return named;
  const shown = looking?.trim();
  if (shown && known.has(shown)) return [shown];
  return last.filter((n) => known.has(n));
}
