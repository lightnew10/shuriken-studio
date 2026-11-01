/**
 * Plain words for the game's owner. What the chat shows — status lines, question cards and their buttons, error
 * lines — carries no internal ids, file paths, coordinates, tool names or raw error text. Agents write for each other
 * ("roblox_status lists two Studio instances… ids d93090f8…", "esc_01m482…, option B", "(0,120,38)"), and a crash is a
 * program's ("Cannot read properties of undefined (reading 'slice')"); the user's chat showed both as they were.
 *
 * This is the rule-based half: it runs on everything, at once, and never fails. A fast model rewrites cards and lines
 * better when it is there (core/director/plain-words.ts), and its answer goes through here too. Nothing technical is
 * lost: it stays on the escalation, in the chat message's data and in the log, for the director and the agents.
 * Shared, so the renderer can tidy what it shows of older records the same way.
 */

/** Shuriken's ids (newId: a prefix, "_", then 26 time-sortable characters starting "01" in this decade), whole or cut. */
const SHURIKEN_ID = /\b[a-z]{1,6}_01[0-9a-z]{4,}(?:…|\.{2,3})?/gi;
const UUID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
/** A hex id (a commit, a Studio instance): 8+ hex characters with at least one digit and one letter. */
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b(?:…|\.{2,3})?/gi;
/** "(placeId: 70000000000001)", "(pid 5412)": a number in brackets that only a program needs. */
const ID_IN_BRACKETS = /\s*\(\s*(?:place|universe|asset|game|group|user|creator|decal|image|run|task|process|p)?\s*id\s*[:=#]?\s*\d+\s*\)/gi;
const PID = /\s*\(\s*pid\s*[:=#]?\s*\d+\s*\)/gi;
/** "group 30000001", "decal 100000000000001": the noun stays, the number goes. */
const LONG_ID_AFTER_NOUN = /\b(place|universe|asset|decal|group|user|creator|image|texture|mesh|sound|animation)(?:\s*id)?\s*[:#=]?\s*\d{6,}\b/gi;
const ASSET_URL = /\brbxassetid:\/\/\d+/gi;
/** A Windows path (C:\Users\…\claude.exe) up to the next space or quote. */
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'`<>|)]*/g;
/** A relative or absolute path with a folder and a file with an extension we know (src/Client/Combat.client.luau). */
const FILE_PATH = /(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.(?:luau|lua|ts|tsx|js|json|rbxlx?|rbxmx?|md|png|jpe?g|wav|ogg|mp3|glb|fbx|obj|toml|py|txt|anim\.json)\b/g;
/** A bare script file name (Combat.client.luau, PitUI.luau). */
const SCRIPT_FILE = /\b[\w@-]+(?:\.(?:client|server|local|legacy))?\.(?:luau|lua)\b/g;
/** A position: (0,120,38), Vector3.new(1, 2, 3), CFrame.new(…), with the preposition before it. */
const COORDS = /(?:\s+(?:at|to|near|around|from|on)\s+(?:about\s+)?)?(?:Vector3\.new|CFrame\.new|Vector3|CFrame)?\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:\s*,[^()]{0,80})?\)/g;
/** A registered test's name: "wkgkeby6:luau_assert:perk_tutorial_gone" → its check's name. */
const TEST_NAME = /\b[0-9a-z]{4,12}:(?:luau_assert|playtest|static_analysis|perf|screenshot|cloud_luau|manual):([\w-]+)/gi;
/** An agent tool's name as the provider shows it. */
const MCP_PREFIX = /\bmcp__[a-z0-9-]+__/gi;
/** snake_case words: tool names and check names. */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** What the agents' tools are, in words (the ones agents name in what they write to the user). */
const TOOL_WORDS: Record<string, string> = {
  roblox_status: "Studio's status",
  roblox_sync_push: 'the code sync',
  roblox_sync_pull: 'the code sync',
  roblox_playtest: 'a playtest',
  roblox_screenshot: 'a screenshot',
  roblox_run_luau: 'running code in Studio',
  roblox_call: 'calls into Studio',
  roblox_console: "Studio's output",
  roblox_explore: 'the place explorer',
  roblox_inspect: 'the place explorer',
  roblox_search: 'the place search',
  execute_luau: 'running code in Studio',
  task_run_checks: "the task's checks",
  task_fix_probe: 'fixing a check',
  task_update_verification: "changing a task's checks",
  task_add_evidence: 'recording evidence',
  task_list: 'the task list',
  task_get: 'the task list',
  plan_add_task: 'adding a task',
  plan_cancel_task: 'cancelling a task',
  plan_drop_dependency: 'removing a wait between tasks',
  plan_set_files: "changing a task's files",
  test_retire: 'retiring a check',
  test_list: 'the list of checks',
  test_results: 'the test results',
  test_register: 'adding a check',
  luau_check: 'the code check',
  wait_for: 'waiting',
  ui_audit: 'the UI check',
  ui_snapshot: 'the UI check',
  ui_icon: 'the icon maker',
  map_audit: 'the map check',
  map_preview: 'the map preview',
  look_analyze: 'the look analysis',
  model_view: 'the model viewer',
  kiln_request: 'a Kiln request',
  kiln_builds: "Kiln's queue",
  store_catalog: 'the store catalog',
  store_list: 'the store list',
  audio_score: 'the music composer',
  upload_image: 'an image upload',
  animation_build: 'building animations',
  animation_check: 'the animation check',
  vfx_measure: 'the effect check',
  capabilities_query: 'the capability list',
  evidence_search: 'the evidence search',
  evidence_view: 'the evidence',
  decided_list: 'the list of decisions',
  studio_place: "Studio's state",
  git_diff: 'the list of changes',
  escalate: 'a question to you',
};

/** A raw error, by what it means. The first pattern that matches says it. */
const ERROR_MEANINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/native binary not found|claude(?:\.exe)? (?:was )?not found|spawn \S*claude\S* ENOENT|could not find (?:the )?claude/i, "the Claude Code program couldn't be found on this PC"],
  [/\b(?:not logged in|unauthori[sz]ed|authentication|invalid api key|\b401\b|please run \/login|sign(?:ed)? ?in again)/i, 'the Claude account needs to be signed in again'],
  [/rate.?limit|\b429\b|usage limit|overloaded|too many requests/i, 'the account hit a usage limit, or the service was busy'],
  [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|network error|getaddrinfo/i, 'a connection dropped'],
  [/Studio(?:MCP)?\b.*\b(?:not connected|disconnected|closed|not running)|No open Studio instance|MCP error -?\d+/i, "Roblox Studio didn't answer"],
  [/EBUSY|EPERM|EACCES|resource busy or locked/i, 'a file was locked by another program'],
  [/ENOSPC|disk full/i, 'the disk is full'],
  [/\btimed? ?out\b|timeout/i, 'something took too long and was stopped'],
  [/Illegal task transition/i, "Shuriken tried to move a task to a state it can't go to (a bug in Shuriken)"],
  [/SQLITE_|database is locked|no such (?:table|column)/i, "Shuriken's project database had a problem"],
  [/Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|is not defined|is not iterable|undefined is not|TypeError|ReferenceError|RangeError|SyntaxError: Unexpected|Maximum call stack|Orchestrator error|Scheduler error/i, 'something inside Shuriken went wrong (a bug in Shuriken)'],
];

/**
 * What only a program writes: an exception's name, a stack frame, an errno code, a known internal failure. Words a
 * person also uses ("usage limit", "timed out") are not enough: a plain line saying the account is at its limit
 * must stay as it is.
 */
const RAW_SIGNATURE =
  /native binary not found|spawn \S+ E[A-Z]{3,}|\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND|BUSY|PERM|ACCES|NOENT|NOSPC|PIPE)\b|Illegal task transition|SQLITE_[A-Z]+|Cannot read propert(?:y|ies) of|is not a function|is not defined|is not iterable|undefined is not|\b[A-Z]\w*Error: |\bException: |\n\s+at \S+|\bat (?:async |new )?[\w.<>$]+ \([^)]*:\d+:\d+\)|MCP error -?\d+|No open Studio instance matches|Orchestrator error:|Scheduler error:|returned an error result|Maximum call stack|Unexpected token|socket hang up|fetch failed/i;

/** A raw error's meaning in plain words (a clause, no full stop), or null when the text isn't a raw error. */
export function errorMeaning(raw: string): string | null {
  const s = raw.trim();
  if (!s || !RAW_SIGNATURE.test(s)) return null;
  for (const [rx, meaning] of ERROR_MEANINGS) if (rx.test(s)) return meaning;
  return 'something inside Shuriken went wrong';
}

/** Whether a piece of text is (or holds) a program's error, not a person's sentence. */
export function isRawError(text: string): boolean {
  return RAW_SIGNATURE.test(text);
}

/**
 * The raw errors inside a chat line replaced by what they mean: "(Claude Code native binary not found at C:\…)" in
 * brackets, or what follows the last ": " of a line. `technical` is the line as it was (null: nothing changed).
 */
export function scrubRawErrors(text: string): { text: string; technical: string | null } {
  let changed = false;
  let out = text.replace(/\(([^()]{3,600})\)/g, (m, inner: string) => {
    if (!isRawError(inner)) return m;
    changed = true;
    return `(${errorMeaning(inner)})`;
  });
  out = out
    .split('\n')
    .map((line) => {
      const i = line.indexOf(': ');
      if (i < 0) {
        // A line that is nothing but the error.
        const meaning = isRawError(line) ? errorMeaning(line) : null;
        if (!meaning) return line;
        changed = true;
        return `${meaning[0]!.toUpperCase()}${meaning.slice(1)}.`;
      }
      const tail = line.slice(i + 2);
      if (!isRawError(tail)) return line;
      changed = true;
      return `${line.slice(0, i)}: ${errorMeaning(tail)}.`;
    })
    .join('\n');
  return { text: changed ? tidy(out) : text, technical: changed ? text : null };
}

/** A script by what it is: "src/Client/Combat.client.luau" → "the Combat client script". */
export function scriptLabel(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = base.at(-1) ?? file;
  const m = /^(.+?)(?:\.(client|local|server|legacy))?\.(?:luau|lua)$/i.exec(name);
  if (!m) return name;
  let stem = m[1]!;
  if (/^init$/i.test(stem) && base.length > 1) stem = base.at(-2)!;
  const side = m[2]?.toLowerCase();
  return side === 'server' || side === 'legacy' ? `the ${stem} server script` : side ? `the ${stem} client script` : `the ${stem} module`;
}

/** "the" when the words before don't already have an article. */
function withArticle(label: string, before: string): string {
  return /\b(?:the|a|an|my|your|our|this|that|its)\s+(?:[\w-]+\s+){0,2}$/i.test(before) ? label.replace(/^the /, '') : label;
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, ' ')
    // What is left of a bracket whose ids were taken out: "(ids and)", "(, )".
    .replace(/\s*\((?:\s|[,;:&/]|\band\b|\bor\b|\bids?\b)*\)/gi, '')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s*[,;:]?\s*/g, '(')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/,\s*\./g, '.')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Text as the game's owner reads it: ids, paths, coordinates, tool and test names and raw errors replaced or taken
 * out. Plain sentences pass unchanged (it is safe to run twice, and on text that is already plain).
 */
export function plainText(text: string): string {
  if (!text) return text;
  let s = text;
  s = scrubRawErrors(s).text;
  s = s.replace(TEST_NAME, (_m, check: string) => check);
  s = s.replace(MCP_PREFIX, '');
  s = s.replace(ASSET_URL, 'an asset');
  s = s.replace(ID_IN_BRACKETS, '').replace(PID, '');
  s = s.replace(LONG_ID_AFTER_NOUN, (_m, noun: string) => noun);
  s = s.replace(SHURIKEN_ID, '').replace(UUID, '').replace(HEX_ID, '');
  s = s.replace(WIN_PATH, (m) => {
    // A full stop or comma after the path is the sentence's, not the file's.
    const tail = /[.,;:]+$/.exec(m)?.[0] ?? '';
    const name = m.slice(0, m.length - tail.length).split('\\').filter(Boolean).at(-1) ?? '';
    return `${/\.(?:luau|lua)$/i.test(name) ? scriptLabel(name) : name}${tail}`;
  });
  s = s.replace(FILE_PATH, (m, offset: number, all: string) => {
    const label = /\.(?:luau|lua)$/i.test(m) ? scriptLabel(m) : (m.split('/').at(-1) ?? m);
    return withArticle(label, all.slice(0, offset));
  });
  s = s.replace(SCRIPT_FILE, (m, offset: number, all: string) => withArticle(scriptLabel(m), all.slice(0, offset)));
  s = s.replace(COORDS, '');
  s = s.replace(SNAKE, (m) => TOOL_WORDS[m] ?? m.replace(/_/g, ' '));
  return tidy(s);
}

/** Whether text has what plainText takes out (for tests and for deciding a rewrite is worth asking for). */
export function hasJargon(text: string): boolean {
  return plainText(text) !== text.trim();
}

/** An answer button's label for an option value (the value itself is what is sent back). */
export function plainOption(option: string): string {
  const known: Record<string, string> = {
    retry: 'Try again',
    cancel: 'Cancel it',
    approve: 'Approve',
    reject: 'Reject',
    ok: 'OK',
    saved: 'I saved it',
    verified: 'It works',
    'not verified': "It doesn't work",
    'start next milestone': 'Start the next milestone',
  };
  const k = option.trim().toLowerCase();
  if (known[k]) return known[k]!;
  const s = plainText(option.trim().replace(/^[A-Z1-9][:.)]\s+/, ''));
  return s ? s[0]!.toUpperCase() + s.slice(1) : option;
}

/** Words a title doesn't end on. */
const MINOR = new Set(['with', 'and', 'of', 'the', 'a', 'an', 'in', 'on', 'for', 'to', 'where', 'that', 'which', 'from', 'into', 'at', 'by', 'or', 'you', 'your', 'is', 'are', 'so', 'but', 'when', 'as', 'its', 'it', 'more', 'less', 'like', 'than', 'very', 'really', 'just', 'some', 'my', 'our']);

/** A title of at most `maxWords` words: cut at a colon or dash when what comes before can stand alone. */
export function shortTitle(text: string, maxWords = 6): string {
  let s = plainText(text.replace(/\s+/g, ' ').trim()).replace(/^["'“]+|["'”.!?]+$/g, '');
  const head = s.split(/\s*[:;(—–]\s*|\s+-\s+/)[0] ?? s;
  if (head.split(' ').length >= 2) s = head;
  const words = s.split(' ').filter(Boolean).slice(0, maxWords);
  while (words.length > 1 && MINOR.has(words[words.length - 1]!.toLowerCase())) words.pop();
  const t = words.join(' ').replace(/[,;:]+$/, '');
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

/**
 * Conversational openings that say nothing about the change: "ugh", "also,", "not bad,", "is it just me or", "can you",
 * "lets". A goal named from the user's first words was called "Ugh the Group Rewards Label", "Also, Is It Just Me" and
 * "Not Bad". Words that also begin real names ("Well of Souls", "Next Gen Racing") count only before a comma or a stop.
 */
const FILLER_ALWAYS = [
  'u+gh+', 'also', 'and', 'but', 'so', 'ok(?:ay)?', 'alright', 'all right', 'hey', 'hi', 'hello', 'yo', 'h+m+', 'um+', 'uh+', 'oh', 'ah', 'actually', 'btw', 'by the way',
  'lol', 'honestly', 'basically', 'not bad', 'looks good', 'looking good', 'one more thing', 'another thing', 'quick (?:one|thing|question)', 'is it just me,? or', 'i think',
  'i feel like', 'i noticed(?: that)?', 'it seems(?: like)?', 'it looks like', 'please', 'pls', 'plz', 'can you', 'could you', 'would you', 'will you', 'can we', 'could we',
  "let'?s", 'let us', "i(?:'d| would) like(?: you)? to", 'i want(?: you)? to', 'i need(?: you)? to', 'we need to', 'we should', 'you should', 'go ahead and', 'try to',
  'make sure(?: that)?', 'help me',
  // "now"/"then"/"next" before a request's verb ("Now build a tower defense"), not as the start of a name.
  String.raw`(?:now|then|next)(?= (?:make|build|create|add|fix|change|remove|give|put|let|can|could|please|do|try)\b)`,
];
const FILLER_BEFORE_PUNCTUATION = ['well', 'right', 'now', 'then', 'next', 'cool', 'nice', 'great', 'good', 'awesome', 'perfect', 'thanks', 'thank you', 'wow', 'yes', 'yeah', 'yep', 'no', 'nope'];
const PUNCT = String.raw`[\s,.!?:;—-]`;
const FILLER_OPENING = new RegExp(`^(?:(?:${FILLER_ALWAYS.join('|')})(?=${PUNCT}|$)|(?:${FILLER_BEFORE_PUNCTUATION.join('|')})(?=[,.!?:;—-]))${PUNCT}*`, 'i');
/** A sentence that is only a reaction ("Not bad!", "Nice.", "ok thanks"): the request is in the next one. */
const ONLY_FILLER = new RegExp(`^(?:${PUNCT}*(?:${[...FILLER_ALWAYS, ...FILLER_BEFORE_PUNCTUATION].join('|')})${PUNCT}*)+$`, 'i');

/**
 * The part of a message that says what is wanted: the first sentence that is more than a reaction, without its
 * conversational opening ("Not bad! But the jump is too floaty." → "the jump is too floaty.").
 */
export function withoutFiller(text: string): string {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  let s = sentences.find((x) => !ONLY_FILLER.test(x)) ?? sentences[0] ?? '';
  for (let i = 0; i < 8; i++) {
    const next = s.replace(FILLER_OPENING, '');
    if (next === s) break;
    s = next;
  }
  return s;
}
/** A question's opening that a title doesn't need ("does the sword feel slow?" → "the sword feel slow"). */
const QUESTION_OPENING = /^(?:why (?:does|do|is|are|can'?t|won'?t|doesn'?t)|how come|does|do|is|are|can|could|should|will)\s+/i;
/** "the X is glitching / doesn't work / still needs work": a problem with something named before it. */
const PROBLEM = /^(?:the |my |our |this |that |these |those )?(.{2,60}?)\s+(?:(?:is|are|was|were|keeps?|seems?|looks?|still|always|sometimes|randomly|now|kinda|kind of|totally|completely)\s+)*(glitch\w*|broken|bugg?ed|buggy|not working|doesn'?t work|don'?t work|isn'?t working|aren'?t working|not showing|missing|janky|wrong|off|weird|flicker\w*|stuck|laggy|flung|flying|falling through|clipping|overlapping|cut off|needs? (?:some )?(?:more )?work|needs? (?:to be )?(?:better|improv\w*|fix\w*|redone|revamp\w*))\b/i;

/**
 * A short goal title for a change request, from the user's own words, when nothing better is at hand (the director
 * gave none and the fast model isn't there): no filler opening, the first clause, a problem named as a fix, at most
 * six words. "ugh the group rewards label is glitching out, get that fixed up" → "Fix the group rewards label".
 */
export function goalTitle(request: string, maxWords = 6): string {
  let s = withoutFiller(request).replace(QUESTION_OPENING, '');
  // The first clause, when it can stand alone.
  const head = s.split(/\s*[,;:(—–]\s*|\s+-\s+|\s+(?:but|and then|so that|because)\s+/i)[0] ?? s;
  if (head.split(' ').length >= 2) s = head;
  s = s.replace(/[.!?]+$/, '').trim();
  const problem = PROBLEM.exec(s);
  if (problem) {
    const subject = problem[1]!;
    const improve = /needs?/i.test(problem[2]!);
    s = `${improve ? 'Improve' : 'Fix'} the ${subject}`;
  }
  const t = shortTitle(s, maxWords);
  return t || 'Requested change';
}
