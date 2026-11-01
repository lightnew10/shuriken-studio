import { LINK_LOST } from './link/link-server';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from './studio-adapter';
import { classOfFile, luauFnv, type SyncMap } from './luau-toolchain';
import { CONFLICT_MARKER, merge3 } from './merge3';
import { fmtDuration, type PlaytestLease } from './playtest-lease';
import { currentStudioCaller, detachStudioCaller } from './studio-context';

export interface SyncEntry {
  file: string;
  /** DataModel path with '/' separators, e.g. ServerScriptService/Server/Combat */
  instancePath: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  source: string;
  hash: string;
}

export interface SyncReport {
  created: string[];
  updated: string[];
  unchanged: string[];
  classChanged: string[];
  orphans: string[];
  deleted: string[];
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
  /** Edited in Studio since the last sync while their files weren't: Studio's version is now in the file. */
  fromStudio: string[];
  /** Changed in both places on different lines: both changes kept (file and Studio). */
  merged: string[];
  /** Changed in both places on the same lines: the file has conflict markers to resolve; Studio kept its version. */
  conflicts: string[];
  /** Deleted in Studio since the last sync while their files weren't changed: the files went too (kept in .shuriken/sync/trash). */
  removed: string[];
  /** New scripts made in Studio (not by a sync): now in files. */
  added: string[];
  /** Files another agent is still editing: left for its own sync. */
  skipped: string[];
  /** Nothing was pushed: Studio stayed in someone else's hands for as long as this push could wait (the message says whose). */
  busy?: string;
}

export interface PushOptions {
  deleteOrphans?: boolean;
  only?: string[];
  skip?: string[];
  force?: boolean;
  /** The lease owner the push is made for, when it isn't the tool call it runs inside. */
  owner?: string;
}

/**
 * Repo-relative files that other agents still running have edited (Edit/Write/MultiEdit): a sync leaves
 * them out, so it neither pushes another's half-done work nor merges into a file someone is in the middle
 * of changing. `runId` is the run the sync is made for (its own edits are pushed); null for a sync that is
 * nobody's (a regression suite), which leaves out what any running agent edited.
 */
export function filesInFlight(p: ProjectContext, runId: string | null): string[] {
  const running = p.store.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('starting', 'running') AND id != ?", [runId ?? '']);
  return [...new Set(running.flatMap((r) => filesEditedBy(p, r.id)))];
}

/**
 * The file an Edit/Write call names. The audit keeps long arguments cut (`{ truncated, length, head }`, db/store.ts):
 * a Write of a whole 26 KB module was stored that way, its `file_path` was not found, and the file did not count
 * as being edited: a verifier pushed it half-done and another task was failed for its errors. The path is at the
 * start of the JSON, so it is read from the head.
 */
export function editedPath(args: unknown): string | null {
  const a = args as { file_path?: unknown; truncated?: unknown; head?: unknown } | null;
  if (!a) return null;
  if (typeof a.file_path === 'string') return a.file_path;
  if (a.truncated === true && typeof a.head === 'string') {
    const m = /"file_path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(a.head);
    if (!m) return null;
    try {
      return JSON.parse(m[1]!) as string;
    } catch {
      return null;
    }
  }
  return null;
}

/** Repo-relative files a run has edited so far (its Edit/Write/MultiEdit calls in the audit). */
export function filesEditedBy(p: ProjectContext, runId: string): string[] {
  const out = new Set<string>();
  for (const c of p.audit.toolCalls({ runId, limit: 400 })) {
    if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.tool)) continue;
    const fp = editedPath(c.args);
    if (!fp) continue;
    const rel = relative(p.root, resolve(p.root, fp)).replaceAll('\\', '/');
    if (!rel.startsWith('..')) out.add(rel);
  }
  return [...out];
}

/** How long a push made by the app itself (no tool call) waits for Studio, and how soon a push that had to step out of the line looks again. An object so a test can shorten it. */
export const SYNC_WAIT = { uiMs: 20_000, retryMs: 25 };

function emptyReport(): SyncReport {
  return { created: [], updated: [], unchanged: [], classChanged: [], orphans: [], deleted: [], errors: [], durationMs: 0, fromStudio: [], merged: [], conflicts: [], removed: [], added: [], skipped: [] };
}

function busyReport(message: string): SyncReport {
  return { ...emptyReport(), errors: [{ path: '(studio)', error: message }], busy: message };
}

export interface VerifyReport {
  matched: string[];
  mismatched: string[];
  missing: string[];
  orphans: string[];
}

/** A script as Studio has it. */
export interface PlaceScript {
  /** DataModel path with '/' separators, e.g. ServerScriptService/Combat/Main. */
  path: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  runContext?: string;
  /** Scripts inside it (its file is a folder's init file). */
  children?: boolean;
  length: number;
  /** Hash of its source (line endings normalized). */
  hash: string;
  /** It, or a folder above it, shares its name with a sibling (case-insensitively): it can't be told apart by path. */
  ambiguous?: boolean;
}

const SCRIPT_SUFFIX = /\.(server|client|legacy|plugin|local)\.luau$/;
const INIT = /^init(\.(server|client|legacy|plugin|local))?\.luau$/;
/** A file an editor is still writing: "<name>.tmp.<pid>.<hash>", renamed over <name> when it is whole. */
const TEMP_FILE = /\.tmp\.\d+\.[0-9a-f]+$/i;

/** Normalize line endings so disk and Studio hashes agree. */
export function normalizeSource(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** Enumerate every script the sync map produces (Script Sync / Rojo naming conventions). */
export function planSync(root: string, map: SyncMap): SyncEntry[] {
  const out: SyncEntry[] = [];
  // Other agents write files while this looks: an editor's temporary file ("X.luau.tmp.26176.b324…", renamed over
  // X.luau a moment later) is listed and gone before it is read. With 12 agents that failed a vfx_create with
  // "ENOENT … stat". What vanished between the listing and the read is skipped, like the temporary files themselves.
  const gone = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  const walk = (dir: string, instancePath: string) => {
    for (const name of gone(() => readdirSync(dir)) ?? []) {
      if (TEMP_FILE.test(name)) continue;
      const full = join(dir, name);
      const st = gone(() => statSync(full));
      if (!st) continue;
      if (st.isDirectory()) {
        const init = (gone(() => readdirSync(full)) ?? []).find((n) => INIT.test(n));
        const text = init ? gone(() => readFileSync(join(full, init), 'utf8')) : null;
        if (init && text !== null) {
          const src = normalizeSource(text);
          out.push({ file: relative(root, join(full, init)).replaceAll('\\', '/'), instancePath: `${instancePath}/${name}`, className: classOfFile(init)!, source: src, hash: luauFnv(src) });
        }
        walk(full, `${instancePath}/${name}`);
      } else if (!INIT.test(name) && classOfFile(name)) {
        const text = gone(() => readFileSync(full, 'utf8'));
        if (text === null) continue;
        const src = normalizeSource(text);
        const inst = name.replace(SCRIPT_SUFFIX, '').replace(/\.luau$/, '');
        out.push({ file: relative(root, full).replaceAll('\\', '/'), instancePath: `${instancePath}/${inst}`, className: classOfFile(name)!, source: src, hash: luauFnv(src) });
      }
    }
  };
  for (const [disk, inst] of Object.entries(map)) {
    const dir = join(root, disk);
    if (existsSync(dir)) walk(dir, inst);
  }
  return out;
}

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|[. ]$|^ |^(con|prn|aux|nul|com\d|lpt\d)$|^init$/i;
const SUFFIXED = /\.(server|client|legacy|plugin|local|luau|lua)$/i;

/** The file a script from Studio is kept in (the naming the sync pushes back to the same class), or why it can't be one. */
export function fileForScript(s: PlaceScript, map: SyncMap): { file: string } | { why: string } {
  if (s.ambiguous) return { why: 'another instance with the same name sits beside it (or beside a folder above it), so its path is ambiguous' };
  const entry = Object.entries(map)
    .filter(([, inst]) => s.path.startsWith(`${inst}/`))
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (!entry) return { why: 'it is outside the synced folders' };
  const segs = s.path.slice(entry[1].length + 1).split('/');
  const bad = segs.find((x) => !x || BAD_NAME.test(x) || SUFFIXED.test(x));
  if (bad !== undefined) return { why: `the name "${bad}" can't be a file name` };
  const ext = s.className === 'Script' ? '.server.luau' : s.className === 'LocalScript' ? '.client.luau' : '.luau';
  const dir = [entry[0].replace(/\/$/, ''), ...segs.slice(0, -1)].join('/');
  const name = segs[segs.length - 1]!;
  const file = s.children ? `${dir}/${name}/init${ext}` : `${dir}/${name}${ext}`;
  if (file.length > 200) return { why: 'its path is too long for a file' };
  return { file };
}

function longString(s: string): string {
  let level = 0;
  // The closing bracket must not appear inside, nor be formed by the source's last character.
  while (`${s}]`.includes(`]${'='.repeat(level)}]`)) level++;
  const eq = '='.repeat(level);
  // A leading newline inside a long bracket is dropped by Luau, so always add one.
  return `[${eq}[\n${s}]${eq}]`;
}

const FNV = `local function fnv(s)
  local h = 2166136261
  for i = 1, #s do
    h = bit32.bxor(h, string.byte(s, i))
    h = (h * 16777619) % 4294967296
  end
  return string.format("%08x", h)
end`;

/** `current(script)`: the text Studio shows for it (the editor's, open or not); `hashOf`: its normalized hash. */
const CURRENT = `local ScriptEditorService = game:GetService("ScriptEditorService")
local function current(s)
  local ok, v = pcall(function() return ScriptEditorService:GetEditorSource(s) end)
  if ok and type(v) == "string" then return v end
  return s.Source
end
local function hashOf(s)
  return fnv((string.gsub(current(s), "\\r\\n", "\\n")))
end`;

const RESOLVE = `local function resolve(path)
  local inst = game
  for _, seg in string.split(path, "/") do
    local nxt = inst:FindFirstChild(seg)
    if nxt == nil and inst == game then
      local ok, svc = pcall(function() return game:GetService(seg) end)
      if ok then nxt = svc end
    end
    inst = nxt
    if inst == nil then return nil end
  end
  return inst
end`;

/** Studio refusing a script because the thread that made it has fewer script capabilities than where it goes. */
export const CAPABILITY_REFUSAL = /cannot reparent .* Capabilities property/i;

/** The attribute on ServerStorage a sync leaves: if it's still there, Studio's scripts are the ones last synced (plus edits made there since). */
const MARK_ATTR = 'ShurikenSync';

/**
 * A push program: `put`s each script unless Studio's copy changed since the last sync (`drifted`, left
 * alone) or was deleted there (`gone`). When the sync mark isn't the one last left (the place was
 * reopened from an older save), a script that matches an older synced version is just stale, and a
 * missing one is recreated. The same holds for a script marked `stale` (SyncBase.isSuspect): one that no sync has
 * confirmed since the place came back from an older save. Agents sync their own files only, so the first sync
 * after a reopen sets the mark with most scripts still old; the next ones took those for edits made in Studio,
 * wrote the old code over newer files, and moved new files to the trash as "deleted in Studio" (eight files in
 * one build, within five minutes).
 */
function pushProgram(calls: string, marker: string | null, next: string, continuity: 'check' | boolean): string {
  const cont = continuity === 'check' ? `game:GetService("ServerStorage"):GetAttribute("${MARK_ATTR}") == ${marker === null ? 'nil' : JSON.stringify(marker)} and ${marker === null ? 'false' : 'true'}` : String(continuity);
  return `local HttpService = game:GetService("HttpService")
${FNV}
${CURRENT}
${RESOLVE}
local function container(path)
  local inst = game
  local parts = string.split(path, "/")
  for i = 1, #parts - 1 do
    local seg = parts[i]
    local nxt = inst:FindFirstChild(seg)
    if nxt == nil and inst == game then
      local ok, svc = pcall(function() return game:GetService(seg) end)
      if ok then nxt = svc end
    end
    if nxt == nil then
      nxt = Instance.new("Folder")
      nxt.Name = seg
      nxt.Parent = inst
    end
    inst = nxt
  end
  return inst, parts[#parts]
end
local continuous = ${cont}
local report = { created = {}, updated = {}, unchanged = {}, classChanged = {}, errors = {}, drifted = {}, gone = {}, continuous = continuous }
local function put(path, className, source, expectedHash, baseHash, older, stale)
  local ok, err = pcall(function()
    if baseHash then
      local now = resolve(path)
      if now == nil then
        if continuous and not stale then
          table.insert(report.gone, path)
          return
        end
      elseif now:IsA("LuaSourceContainer") then
        local h = hashOf(now)
        if h ~= baseHash and h ~= expectedHash and not ((stale or not continuous) and table.find(older, h)) then
          table.insert(report.drifted, { path = path, length = #current(now) })
          return
        end
      end
    end
    local parent, name = container(path)
    local existing = parent:FindFirstChild(name)
    if existing and existing.ClassName ~= className then
      local children = existing:GetChildren()
      local replacement = Instance.new(className)
      replacement.Name = name
      for _, c in ipairs(children) do c.Parent = replacement end
      existing:Destroy()
      existing = replacement
      replacement.Parent = parent
      table.insert(report.classChanged, path)
    end
    if existing == nil then
      existing = Instance.new(className)
      existing.Name = name
      existing.Parent = parent
      table.insert(report.created, path)
    elseif fnv(existing.Source) == expectedHash then
      table.insert(report.unchanged, path)
      return
    else
      table.insert(report.updated, path)
    end
    local okUpdate = pcall(function()
      ScriptEditorService:UpdateSourceAsync(existing, function() return source end)
    end)
    if not okUpdate or fnv(existing.Source) ~= expectedHash then existing.Source = source end
    if fnv(existing.Source) ~= expectedHash then error("source hash mismatch after write") end
  end)
  if not ok then table.insert(report.errors, { path = path, error = tostring(err) }) end
end
${calls}
game:GetService("ServerStorage"):SetAttribute("${MARK_ATTR}", ${JSON.stringify(next)})
return HttpService:JSONEncode(report)`;
}

/** The syntax of a push program (for the parse test). */
export function pushProgramSample(): string {
  return pushProgram(`put("ServerScriptService/Server/Main", "Script", ${longString('print("hi")\nlocal t = {1}\nreturn t[1]')}, "0badf00d", "12345678", {"87654321"})`, 'm1', 'm2', 'check');
}

/** Luau: every script under the given roots (DataModel paths), with class, run context, length and hash. */
export function listScriptsLuau(roots: string[]): string {
  const top = roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(`${o}/`)));
  return `local HttpService = game:GetService("HttpService")
${FNV}
${CURRENT}
${RESOLVE}
local out = {}
local function below(inst)
  for _, d in inst:GetDescendants() do
    if d:IsA("LuaSourceContainer") then return true end
  end
  return false
end
local function walk(node, path, ambiguous)
  local count = {}
  for _, c in node:GetChildren() do
    local k = string.lower(c.Name)
    count[k] = (count[k] or 0) + 1
  end
  for _, c in node:GetChildren() do
    -- Send to Studio's previews are throwaway: never files, never orphans.
    if c:GetAttribute("ShurikenPreview") ~= nil then continue end
    local p = path .. "/" .. c.Name
    local amb = ambiguous or count[string.lower(c.Name)] > 1
    if c:IsA("LuaSourceContainer") then
      table.insert(out, { path = p, className = c.ClassName, runContext = if c:IsA("Script") then c.RunContext.Name else nil, children = below(c) or nil, length = #current(c), hash = hashOf(c), ambiguous = amb or nil })
    end
    if #c:GetChildren() > 0 then walk(c, p, amb) end
  end
end
for _, root in HttpService:JSONDecode(${JSON.stringify(JSON.stringify(top))}) do
  local inst = resolve(root)
  if inst then walk(inst, root, false) end
end
return HttpService:JSONEncode(out)`;
}

/** Luau: the sources of some scripts (whole, or one line-bounded chunk of a long one). */
export function fetchScriptsLuau(requests: Array<{ path: string; part?: number; size?: number }>): string {
  return `local HttpService = game:GetService("HttpService")
${FNV}
${CURRENT}
${RESOLVE}
local out = {}
for _, r in HttpService:JSONDecode(${JSON.stringify(JSON.stringify(requests))}) do
  local inst = resolve(r.path)
  if inst and inst:IsA("LuaSourceContainer") then
    local s = string.gsub(current(inst), "\\r\\n", "\\n")
    if r.part then
      -- Chunks of about r.size bytes that end at a line break.
      local chunks, cur = {}, {}
      local len = 0
      for line in string.gmatch(s .. "\\n", "([^\\n]*)\\n") do
        if len > 0 and len + #line + 1 > r.size then
          table.insert(chunks, table.concat(cur, "\\n"))
          cur, len = {}, 0
        end
        table.insert(cur, line)
        len += #line + 1
      end
      table.insert(chunks, table.concat(cur, "\\n"))
      table.insert(out, { path = r.path, part = r.part, parts = #chunks, text = chunks[r.part] or "" })
    else
      table.insert(out, { path = r.path, text = s })
    end
  end
end
return HttpService:JSONEncode(out)`;
}

/** Reads scripts' sources out of Studio: small ones in batches, long ones in line-bounded chunks. */
export async function fetchSources(studio: RobloxStudioAdapter, items: Array<{ path: string; length: number }>): Promise<Map<string, string>> {
  const BATCH = 40_000;
  const texts = new Map<string, string>();
  const small = items.filter((x) => x.length <= BATCH);
  for (let i = 0; i < small.length; ) {
    const batch: string[] = [];
    let size = 0;
    while (i < small.length && (batch.length === 0 || size + small[i]!.length <= BATCH)) {
      batch.push(small[i]!.path);
      size += small[i]!.length;
      i++;
    }
    const got = await studio.luauJson<Array<{ path: string; text: string }>>(fetchScriptsLuau(batch.map((path) => ({ path }))), 'Edit', 120_000);
    for (const g of got) texts.set(g.path, g.text);
  }
  for (const x of items.filter((y) => y.length > BATCH)) {
    const parts: string[] = [];
    for (let part = 1, total = 1; part <= total; part++) {
      const [got] = await studio.luauJson<Array<{ path: string; part: number; parts: number; text: string }>>(fetchScriptsLuau([{ path: x.path, part, size: BATCH }]), 'Edit', 120_000);
      if (!got) break;
      total = got.parts;
      parts.push(got.text);
    }
    if (parts.length) texts.set(x.path, parts.join('\n'));
  }
  return texts;
}

interface BaseFile {
  version: 1;
  /** Studio path → hash of the text both sides had at the last sync. */
  scripts: Record<string, string>;
  /** Studio path → hashes of earlier synced versions (newest first). */
  older?: Record<string, string[]>;
  /** The mark the last sync left on ServerStorage. */
  marker?: string | null;
  /** Scripts no sync has confirmed since the place came back without the last sync's mark (see SyncBase.isSuspect). */
  suspect?: string[];
  /** Scripts in Studio that were there before tracking began (never pulled; still orphans). */
  known?: string[];
  /** Scripts that can't be files (duplicate or invalid names): left alone, never orphans. */
  unmapped?: string[];
}

/**
 * What each synced script looked like when disk and Studio last agreed (`.shuriken/sync/`): its hash,
 * its text (for three-way merges) and older hashes, plus the mark that sync left in Studio.
 */
export class SyncBase {
  readonly dir: string;
  /** base.json existed when this was read (tracking was already on). */
  readonly established: boolean;
  private data: BaseFile;

  constructor(root: string) {
    this.dir = join(root, '.shuriken', 'sync');
    let data: BaseFile | null = null;
    try {
      data = JSON.parse(readFileSync(join(this.dir, 'base.json'), 'utf8')) as BaseFile;
    } catch {
      /* not tracked yet */
    }
    this.established = !!data;
    this.data = data ?? { version: 1, scripts: {} };
  }

  get marker(): string | null {
    return this.data.marker ?? null;
  }

  set marker(m: string | null) {
    this.data.marker = m;
  }

  hash(path: string): string | undefined {
    return this.data.scripts[path];
  }

  older(path: string): string[] {
    return this.data.older?.[path] ?? [];
  }

  text(path: string): string | null {
    try {
      return readFileSync(this.textFile(path), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * The copy of this script in Studio is not known to be the one last synced: the place came back without the last
   * sync's mark (reopened from an older save, or another window of it), and no sync has confirmed this script since.
   * Until one does, an older synced version found there is stale and a missing script is recreated: neither is an
   * edit made in Studio.
   */
  isSuspect(path: string): boolean {
    return !!this.data.suspect?.includes(path);
  }

  /** The place is not the one the last sync wrote to: every tracked script is suspect until a sync confirms it. */
  suspectAll(): void {
    this.data.suspect = Object.keys(this.data.scripts);
  }

  /** Both sides now have `text` at `path`. */
  record(path: string, text: string): void {
    if (this.data.suspect?.includes(path)) this.data.suspect = this.data.suspect.filter((p) => p !== path);
    const h = luauFnv(text);
    const prev = this.data.scripts[path];
    if (prev === h && existsSync(this.textFile(path))) return;
    if (prev && prev !== h) {
      const older = (this.data.older ??= {});
      older[path] = [prev, ...(older[path] ?? []).filter((x) => x !== prev && x !== h)].slice(0, 8);
    }
    this.data.scripts[path] = h;
    mkdirSync(join(this.dir, 'base'), { recursive: true });
    writeFileSync(this.textFile(path), text, 'utf8');
  }

  forget(path: string): void {
    if (this.data.suspect) this.data.suspect = this.data.suspect.filter((p) => p !== path);
    delete this.data.scripts[path];
    delete this.data.older?.[path];
    rmSync(this.textFile(path), { force: true });
  }

  /** Not a script Studio made since tracking began (so an orphan stays an orphan, never pulled). */
  knows(path: string): boolean {
    return path in this.data.scripts || !!this.data.known?.includes(path) || !!this.data.unmapped?.includes(path);
  }

  isUnmapped(path: string): boolean {
    return !!this.data.unmapped?.includes(path);
  }

  /** Scripts left in Studio only (they can't be files). */
  unmapped(): string[] {
    return [...(this.data.unmapped ?? [])];
  }

  setKnown(paths: string[]): void {
    this.data.known = [...new Set([...(this.data.known ?? []), ...paths])];
  }

  setUnmapped(paths: string[]): void {
    this.data.unmapped = [...new Set(paths)];
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'base.json'), JSON.stringify(this.data, null, 1), 'utf8');
  }

  /** A new mark for the next sync to leave in Studio. */
  static newMarker(): string {
    return randomUUID().slice(0, 13);
  }

  private textFile(path: string): string {
    return join(this.dir, 'base', `${createHash('sha1').update(path).digest('hex').slice(0, 20)}.luau`);
  }
}

/**
 * Pushes on-disk Luau (the source of truth for what the team changes) into Studio through
 * execute_luau and verifies it by content hash. Studio's side is never lost: a script edited there
 * since the last sync comes back into its file (merged with the file's own changes when both
 * changed), one deleted there is deleted on disk too, and a new one made there gets a file. Used when
 * the project is not linked with Studio's native Script Sync.
 */
export class CodeSync {
  /** Per project: whether a push is running, and the pushes waiting for their turn (the holder of Studio's first). */
  private readonly lines = new Map<string, { busy: boolean; waiting: Array<{ first: boolean; go: () => void }> }>();

  /**
   * @param lease the play-mode lease of this Studio. With it, pushes take their turn with whoever holds Studio
   *   (see push); without it (tests on a bare place) they only take turns with each other.
   */
  constructor(
    private readonly studio: RobloxStudioAdapter,
    private readonly lease: PlaytestLease | null = null,
  ) {}

  /**
   * `only` pushes just those files (repo-relative paths); the per-script hash check verifies them.
   * `skip`: files other agents are still editing — left out (not pushed half-done, not merged into);
   * their own sync brings them in when they finish.
   * `owner`: the lease owner the push is made for, when it isn't the tool call it runs inside (a verification,
   * the world's rebuild).
   *
   * One push per project at a time (the sync base is read and written around each), and the line never ties up
   * whoever holds Studio. The rule: what holds the lease must not wait behind work that needs the lease to be
   * free. So a push for the lease's holder goes to the front of the line; anyone else waits for Studio (the lease
   * free, Edit mode) BEFORE taking a place in line, steps out again if Studio was taken while it stood there, and
   * once it has begun nobody is given Studio until it is done (PlaytestLease.beginEdit), so its Studio calls never
   * wait. A push that could not get Studio in time comes back with `busy` set and nothing pushed.
   */
  async push(root: string, map: SyncMap, opts: PushOptions = {}): Promise<SyncReport> {
    const lease = this.lease;
    if (!lease) {
      const done = await this.turn(root, false);
      try {
        return await this.pushNow(root, map, opts);
      } finally {
        done();
      }
    }
    const caller = currentStudioCaller();
    const owner = opts.owner ?? caller?.owner ?? null;
    const t0 = Date.now();
    // A tool call waits as long as its client sits through; the app's own buttons answer sooner.
    const limit = caller ? this.studio.waitLimitMs() : SYNC_WAIT.uiMs;
    for (;;) {
      const holds = !!owner && lease.isOwnedBy(owner);
      // The holder's own push needs no wait, except an agent's during its own playtest (no Edit mode: it is told to stop it).
      // With the plugin linked, a push needs no turn: it writes the Edit DataModel while someone else plays (the
      // running game is the copy made when play started; the next playtest has the new code). A playtest that is
      // being started is waited for below (beginEdit), and an agent's push during its OWN playtest is still told
      // to stop it first: that playtest would go on running the old code.
      const duringPlay = this.studio.editInPlay && !holds;
      if ((!holds || caller) && !duringPlay) {
        const w = await this.studio.waitForEdit(Math.max(0, limit - (Date.now() - t0)));
        if (!w.ok) return busyReport(w.message);
      }
      const done = await this.turn(root, holds);
      if (lease.beginEdit(owner)) {
        try {
          // Its Studio calls run as nobody's tool call: the wait for Studio is over, they must not start another.
          return await detachStudioCaller(() => this.pushNow(root, map, opts));
        } finally {
          lease.endEdit();
          done();
        }
      }
      // Studio was taken (or asked for) while this push stood in line: out of the line, and wait for it again.
      done();
      if (Date.now() - t0 >= limit) return busyReport(`Studio is held by ${lease.describe() ?? 'a playtest that is starting'}; waited ${fmtDuration(Date.now() - t0)} for it. The code sync needs Studio out of play mode. Do non-Studio work (files, luau_check) and sync again later. This is not a blocker to report.`);
      await new Promise((r) => setTimeout(r, SYNC_WAIT.retryMs));
    }
  }

  /** A place in the project's line of pushes: resolves when it is this push's turn, with what to call when it is done. */
  private turn(root: string, first: boolean): Promise<() => void> {
    let line = this.lines.get(root);
    if (!line) this.lines.set(root, (line = { busy: false, waiting: [] }));
    const q = line;
    const done = () => {
      const next = q.waiting.shift();
      if (next) next.go();
      else q.busy = false;
    };
    if (!q.busy) {
      q.busy = true;
      return Promise.resolve(done);
    }
    return new Promise((resolve) => {
      const entry = { first, go: () => resolve(done) };
      const at = first ? q.waiting.findIndex((w) => !w.first) : -1;
      if (at >= 0) q.waiting.splice(at, 0, entry);
      else q.waiting.push(entry);
    });
  }

  private async pushNow(root: string, map: SyncMap, opts: PushOptions): Promise<SyncReport> {
    const t0 = Date.now();
    const report = emptyReport();
    const base = new SyncBase(root);
    const skip = new Set((opts.skip ?? []).map((f) => f.replaceAll('\\', '/').toLowerCase()));
    const all = planSync(root, map).filter((e) => {
      if (opts.only && !opts.only.includes(e.file)) return false;
      if (skip.has(e.file.toLowerCase())) {
        report.skipped.push(e.file);
        return false;
      }
      return true;
    });
    const entries: SyncEntry[] = [];
    for (const e of all) {
      if (CONFLICT_MARKER.test(e.source) && /^={7}$/m.test(e.source)) report.errors.push({ path: e.instancePath, error: `${e.file} still has merge conflict markers (<<<<<<< … >>>>>>>): keep what both sides meant, remove the markers, then sync again. Studio keeps its version until then.` });
      else entries.push(e);
    }
    const next = SyncBase.newMarker();
    // force: the files win everywhere (a place reopened from an old save the sync can't recognise).
    const put = await this.putAll(entries, base, base.marker, next, 'check', report, opts.force);
    if (put.marked) base.marker = next;

    if (put.drifted.length || put.gone.length) {
      const byPath = new Map(entries.map((e) => [e.instancePath, e]));
      const tracked = entries.filter((e) => base.hash(e.instancePath)).length;
      if (!put.continuous && put.drifted.length > 3 && put.drifted.length > tracked * 0.3) {
        // Most scripts differ from anything synced before: probably not this project's place.
        report.errors.push({ path: '(sync)', error: `${put.drifted.length} of ${tracked} scripts in Studio differ from every version synced before — is the right place open? They were left alone and nothing was pulled. If it is the right place (reopened from an old save), sync again with force: true to put the files' versions in.` });
      } else {
        const again = await this.reconcile(root, put.drifted.map((d) => ({ e: byPath.get(d.path)!, length: d.length })), put.gone.map((g) => byPath.get(g)!), base, report);
        if (again.length) {
          const second = SyncBase.newMarker();
          if ((await this.putAll(again, base, base.marker, second, true, report)).marked) base.marker = second;
        }
      }
    }
    base.save();

    if (opts.only) {
      report.durationMs = Date.now() - t0;
      return report;
    }
    let verify: VerifyReport;
    let studio: PlaceScript[];
    try {
      ({ verify, studio } = await this.check(root, map, base));
    } catch (e) {
      // e.g. Studio switched into play mode mid-sync: report it instead of throwing out of the caller.
      report.errors.push({ path: '(verify)', error: `Could not verify synced scripts: ${e instanceof Error ? e.message : String(e)}` });
      report.durationMs = Date.now() - t0;
      return report;
    }
    if (!base.established) {
      // Tracking starts now: scripts already in Studio without a file stay orphans (never pulled).
      base.setKnown(verify.orphans);
      base.save();
    } else {
      // Scripts made in Studio since the last sync come into files.
      const fresh = studio.filter((s) => verify.orphans.includes(s.path) && !base.knows(s.path));
      const planned: Array<{ s: PlaceScript; file: string }> = [];
      for (const s of fresh) {
        const f = fileForScript(s, map);
        if ('file' in f && !existsSync(join(root, f.file))) planned.push({ s, file: f.file });
      }
      if (planned.length) {
        try {
          const texts = await fetchSources(this.studio, planned.map((x) => ({ path: x.s.path, length: x.s.length })));
          for (const { s, file } of planned) {
            const text = texts.get(s.path);
            if (text === undefined) continue;
            mkdirSync(dirname(join(root, file)), { recursive: true });
            writeFileSync(join(root, file), text, 'utf8');
            base.record(s.path, normalizeSource(text));
            report.added.push(s.path);
          }
          base.save();
        } catch (e) {
          report.errors.push({ path: '(new scripts)', error: `Could not read new scripts from Studio: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
    // A skipped file's script isn't an orphan (its file exists; another agent is changing it).
    const skippedPaths = new Set(planSync(root, map).filter((e) => report.skipped.includes(e.file)).map((e) => e.instancePath));
    report.orphans = verify.orphans.filter((p) => !report.added.includes(p) && !skippedPaths.has(p));
    if (opts.deleteOrphans && report.orphans.length) {
      const program = `local paths = game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify(report.orphans))})
local deleted = {}
for _, p in ipairs(paths) do
  local inst = game
  for _, seg in ipairs(string.split(p, "/")) do
    if inst == nil then break end
    local nxt = inst:FindFirstChild(seg)
    if nxt == nil and inst == game then local ok, s = pcall(function() return game:GetService(seg) end) if ok then nxt = s end end
    inst = nxt
  end
  if inst and inst:IsA("LuaSourceContainer") then inst:Destroy() table.insert(deleted, p) end
end
return game:GetService("HttpService"):JSONEncode(deleted)`;
      const r = await this.studio.runLuau(program, 'Edit');
      if (r.ok) {
        report.deleted = JSON.parse(r.output) as string[];
        for (const p of report.deleted) base.forget(p);
        base.save();
      }
    }
    report.durationMs = Date.now() - t0;
    return report;
  }

  /** Runs `put` for each entry in bounded batches; records what now agrees. */
  private async putAll(entries: SyncEntry[], base: SyncBase, marker: string | null, next: string, continuity: 'check' | boolean, report: SyncReport, force = false, retried = false): Promise<{ drifted: Array<{ path: string; length: number }>; gone: string[]; continuous: boolean; marked: boolean }> {
    // Batch into programs of bounded size to stay well under tool payload limits.
    const batches: SyncEntry[][] = [];
    let current: SyncEntry[] = [];
    let size = 0;
    for (const e of entries) {
      if (size + e.source.length > 180_000 && current.length) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(e);
      size += e.source.length;
    }
    if (current.length) batches.push(current);

    const out = { drifted: [] as Array<{ path: string; length: number }>, gone: [] as string[], continuous: continuity === true, marked: false };
    let cont: 'check' | boolean = continuity;
    for (const batch of batches) {
      const calls = batch
        .map((e) => {
          const b = force ? undefined : base.hash(e.instancePath);
          const older = force ? [] : base.older(e.instancePath);
          return `put(${JSON.stringify(e.instancePath)}, ${JSON.stringify(e.className)}, ${longString(e.source)}, ${JSON.stringify(e.hash)}, ${b ? JSON.stringify(b) : 'nil'}, {${older.map((h) => JSON.stringify(h)).join(', ')}}, ${!force && base.isSuspect(e.instancePath) ? 'true' : 'false'})`;
        })
        .join('\n');
      let r = await this.studio.runLuau(pushProgram(calls, marker, next, cont), 'Edit', 180000);
      // Studio froze and the plugin's link dropped under the batch: every script of a push was reported as an error
      // ("Studio stopped answering through Shuriken Link") and the link was back eight seconds later. Writing a
      // script is the same the second time (its hash is compared), so the batch is sent once more when it is.
      if (!r.ok && LINK_LOST.test(r.output) && (await this.studio.linkBack('Edit'))) r = await this.studio.runLuau(pushProgram(calls, marker, next, cont), 'Edit', 180000);
      if (!r.ok) {
        for (const e of batch) report.errors.push({ path: e.instancePath, error: r.output.slice(0, 500) });
        continue;
      }
      try {
        const part = JSON.parse(r.output) as Pick<SyncReport, 'created' | 'updated' | 'unchanged' | 'classChanged' | 'errors'> & { drifted: Array<{ path: string; length: number }>; gone: string[]; continuous: boolean };
        report.created.push(...part.created);
        report.updated.push(...part.updated);
        report.unchanged.push(...part.unchanged);
        report.classChanged.push(...part.classChanged);
        report.errors.push(...part.errors);
        out.marked = true;
        out.drifted.push(...(part.drifted ?? []));
        out.gone.push(...(part.gone ?? []));
        if (cont === 'check') {
          // Later batches see the mark this one left: carry the first answer over.
          out.continuous = part.continuous;
          cont = part.continuous;
          // Not the place the last sync wrote to: whatever this sync doesn't confirm stays suspect for the next ones.
          if (!part.continuous && marker !== null) base.suspectAll();
        }
        const ok = new Set([...part.created, ...part.updated, ...part.unchanged, ...part.classChanged]);
        for (const e of batch) if (ok.has(e.instancePath)) base.record(e.instancePath, e.source);
      } catch {
        for (const e of batch) report.errors.push({ path: e.instancePath, error: `Unparseable sync response: ${r.output.slice(0, 300)}` });
      }
    }
    if (!retried) await this.createThroughEditor(entries, base, next, report);
    return out;
  }

  /**
   * Scripts Studio would not let Luau create. On 2026-10-01 Studio began running MCP code without four script
   * capabilities (LoadUnownedAsset and three more): a script made in Luau can't be parented anywhere ("The current
   * thread cannot reparent 'X' to 'ReplicatedStorage.Shared' since … has additional values for the Capabilities
   * property"), so every push of a new game failed and no code reached Studio. Measured in a scratch place the same
   * evening: Studio's own script tool (multi_edit) still creates scripts, with their folders, and Luau may then
   * write an existing script's Source, name and properties. So each refused script is created empty through that
   * tool and put again; a script of the wrong class is removed first when nothing is inside it.
   */
  private async createThroughEditor(entries: SyncEntry[], base: SyncBase, marker: string, report: SyncReport): Promise<void> {
    const refused = report.errors.filter((x) => CAPABILITY_REFUSAL.test(x.error));
    if (!refused.length) return;
    const byPath = new Map(entries.map((e) => [e.instancePath, e]));
    const todo = [...new Set(refused.map((x) => x.path))].map((p) => byPath.get(p)).filter((e): e is SyncEntry => !!e && !e.instancePath.split('/').some((seg) => seg.includes('.')));
    if (!todo.length) return;
    // A script of another class in its place goes first (only an empty one: what is inside it would go with it).
    const clear = await this.studio.runLuau(
      `local HttpService = game:GetService("HttpService")
${RESOLVE}
local out = {}
for _, it in ipairs(HttpService:JSONDecode(${JSON.stringify(JSON.stringify(todo.map((e) => ({ path: e.instancePath, className: e.className }))))})) do
  local inst = resolve(it.path)
  if inst == nil then out[it.path] = "missing"
  elseif inst.ClassName == it.className then out[it.path] = "there"
  elseif #inst:GetChildren() == 0 then inst:Destroy() out[it.path] = "missing"
  else out[it.path] = "occupied" end
end
return HttpService:JSONEncode(out)`,
      'Edit',
    );
    let state: Record<string, string> = {};
    try {
      state = clear.ok ? (JSON.parse(clear.output) as Record<string, string>) : {};
    } catch {
      state = {};
    }
    const made: SyncEntry[] = [];
    for (const e of todo) {
      const s = state[e.instancePath];
      if (s === 'there') made.push(e);
      if (s !== 'missing') continue;
      const r = await this.studio.call('multi_edit', { file_path: `game.${e.instancePath.split('/').join('.')}`, className: e.className, datamodel_type: 'Edit', edits: [{ old_string: '', new_string: '-- (being synced)\n' }] }, { timeoutMs: 30_000 });
      if (r.ok) made.push(e);
      else report.errors.push({ path: e.instancePath, error: `Studio's script tool could not create it either: ${(r.error ?? '').slice(0, 200)}` });
    }
    if (!made.length) return;
    const second = emptyReport();
    await this.putAll(made, base, marker, marker, true, second, true, true);
    const ok = new Set([...second.updated, ...second.unchanged, ...second.created]);
    report.created.push(...made.filter((e) => ok.has(e.instancePath)).map((e) => e.instancePath));
    report.errors = report.errors.filter((x) => !(CAPABILITY_REFUSAL.test(x.error) && ok.has(x.path)));
    report.errors.push(...second.errors);
  }

  /**
   * Scripts Studio changed since the last sync: unchanged files take Studio's version, changed ones are
   * merged (pushed again when clean). Scripts deleted in Studio lose their files when those weren't
   * changed; otherwise they're recreated. Returns what to push again.
   */
  private async reconcile(root: string, drifted: Array<{ e: SyncEntry; length: number }>, gone: SyncEntry[], base: SyncBase, report: SyncReport): Promise<SyncEntry[]> {
    const again: SyncEntry[] = [];
    let texts = new Map<string, string>();
    if (drifted.length) {
      try {
        texts = await fetchSources(this.studio, drifted.map((d) => ({ path: d.e.instancePath, length: d.length })));
      } catch (err) {
        for (const d of drifted) report.errors.push({ path: d.e.instancePath, error: `Changed in Studio since the last sync, and its text could not be read: ${err instanceof Error ? err.message : String(err)}. Left as it is in Studio.` });
        return again;
      }
    }
    for (const { e } of drifted) {
      const got = texts.get(e.instancePath);
      if (got === undefined) {
        report.errors.push({ path: e.instancePath, error: 'Changed in Studio since the last sync, and Studio did not return its text. Left as it is in Studio.' });
        continue;
      }
      const theirs = normalizeSource(got);
      const file = join(root, e.file);
      if (e.hash === base.hash(e.instancePath)) {
        writeFileSync(file, theirs, 'utf8');
        base.record(e.instancePath, theirs);
        report.fromStudio.push(e.instancePath);
        continue;
      }
      const ancestor = base.text(e.instancePath);
      const m = ancestor === null ? { text: '', conflicts: 1 } : merge3(ancestor, e.source, theirs);
      if (m.conflicts === 0) {
        writeFileSync(file, m.text, 'utf8');
        base.record(e.instancePath, theirs);
        again.push({ ...e, source: m.text, hash: luauFnv(m.text) });
        report.merged.push(e.instancePath);
        continue;
      }
      const text = ancestor === null ? ['<<<<<<< yours (the file)', ...e.source.split('\n'), '=======', ...theirs.split('\n'), '>>>>>>> Studio (edited there since the last sync)'].join('\n') : m.text;
      writeFileSync(file, text, 'utf8');
      base.record(e.instancePath, theirs);
      report.conflicts.push(e.instancePath);
      report.errors.push({ path: e.instancePath, error: `Changed both in ${e.file} and in Studio (someone edited it there since the last sync) on the same lines: ${e.file} now has conflict markers (<<<<<<< yours … ======= … >>>>>>> Studio). Keep what both meant, remove the markers, then sync again. Studio keeps its version until then.` });
    }
    for (const e of gone) {
      if (e.hash === base.hash(e.instancePath)) {
        const trash = join(root, '.shuriken', 'sync', 'trash', e.file);
        mkdirSync(dirname(trash), { recursive: true });
        rmSync(trash, { force: true });
        renameSync(join(root, e.file), trash);
        base.forget(e.instancePath);
        report.removed.push(e.instancePath);
      } else {
        // Deleted in Studio but changed on disk since: the newer work wins; say so.
        base.forget(e.instancePath);
        again.push(e);
        report.errors.push({ path: e.instancePath, error: `Deleted in Studio since the last sync, but ${e.file} changed since: recreated it in Studio. If it should go, delete ${e.file}.` });
      }
    }
    return again;
  }

  /** Compare disk hashes with the scripts currently in Studio. */
  async verify(root: string, map: SyncMap): Promise<VerifyReport> {
    return (await this.check(root, map, new SyncBase(root))).verify;
  }

  private async check(root: string, map: SyncMap, base: SyncBase): Promise<{ verify: VerifyReport; studio: PlaceScript[] }> {
    const entries = planSync(root, map);
    const list = await this.studio.luauJson<PlaceScript[]>(listScriptsLuau(Object.values(map)), 'Edit', 120_000);
    const studio = new Map(list.map((s) => [s.path, s]));
    const report: VerifyReport = { matched: [], mismatched: [], missing: [], orphans: [] };
    const expected = new Set<string>();
    for (const e of entries) {
      expected.add(e.instancePath);
      const s = studio.get(e.instancePath);
      if (!s) report.missing.push(e.instancePath);
      else if (s.hash !== e.hash || s.className !== e.className) report.mismatched.push(e.instancePath);
      else report.matched.push(e.instancePath);
    }
    for (const p of studio.keys()) if (!expected.has(p) && !base.isUnmapped(p)) report.orphans.push(p);
    return { verify: report, studio: [...studio.values()] };
  }
}
