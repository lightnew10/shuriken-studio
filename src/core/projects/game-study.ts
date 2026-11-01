import type { Suggestion } from '@shared/suggestions';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProjectContext } from './project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { SyncMap } from '../roblox/luau-toolchain';
import { fetchSources, fileForScript, listScriptsLuau, normalizeSource, planSync, SyncBase, type PlaceScript } from '../roblox/code-sync';

/**
 * Plugging in an existing game (one Shuriken didn't build, or built in another session): its scripts
 * come out of Studio into files the team works on (kept in sync both ways: CodeSync never overwrites an
 * edit made in Studio), a survey reads the place, and an analyst writes the brief every agent and
 * copilot reads (`.shuriken/dossier.json` + `dossier.md`).
 */

/** Services games keep scripts in (read in this order). */
export const CODE_SERVICES = ['ServerScriptService', 'ServerStorage', 'ReplicatedStorage', 'ReplicatedFirst', 'StarterPlayer', 'StarterGui', 'StarterPack', 'Workspace', 'Lighting', 'SoundService', 'Teams', 'TextChatService'];

/** Where Shuriken's own runtime modules go in a plugged-in game (a folder of its own, first in the map). */
export const ADOPTED_SHARED: [string, string] = ['src/ShurikenShared', 'ReplicatedStorage/ShurikenShared'];

/** Services a plugged-in game always maps (where new code goes), even without scripts there yet. */
const ALWAYS = ['ServerScriptService', 'ReplicatedStorage', 'StarterPlayer'];

/** The sync map of a plugged-in game: Shuriken's own folder, then each service that has scripts. */
export function adoptedSyncMap(services: string[]): SyncMap {
  const map: SyncMap = { [ADOPTED_SHARED[0]]: ADOPTED_SHARED[1] };
  for (const s of CODE_SERVICES) if (services.includes(s) || ALWAYS.includes(s)) map[`src/${s}`] = s;
  return map;
}

export interface PullReport {
  pulled: string[];
  skipped: Array<{ path: string; why: string }>;
  syncMap: SyncMap;
}

/**
 * Reads every script in the bound Studio place's code services into files (the sync's naming) and
 * records them as the sync base, so the first push changes nothing and later Studio edits are noticed.
 */
export async function pullScripts(ctx: ProjectContext, studio: RobloxStudioAdapter, progress?: (text: string) => void): Promise<PullReport> {
  const scripts = await studio.luauJson<PlaceScript[]>(listScriptsLuau(CODE_SERVICES), 'Edit', 180_000);
  const map = adoptedSyncMap([...new Set(scripts.map((s) => s.path.split('/')[0]!))]);
  const skipped: PullReport['skipped'] = [];
  const planned: Array<{ s: PlaceScript; file: string }> = [];
  const taken = new Set<string>();
  for (const s of scripts) {
    const f = fileForScript(s, map);
    if ('why' in f) skipped.push({ path: s.path, why: f.why });
    else if (taken.has(f.file.toLowerCase())) skipped.push({ path: s.path, why: 'another script maps to the same file' });
    else {
      taken.add(f.file.toLowerCase());
      planned.push({ s, file: f.file });
    }
  }
  progress?.(`Reading ${planned.length} script${planned.length === 1 ? '' : 's'} out of Studio…`);
  const texts = await fetchSources(studio, planned.map((x) => ({ path: x.s.path, length: x.s.length })));
  const base = new SyncBase(ctx.root);
  const pulled: string[] = [];
  for (const { s, file } of planned) {
    const text = texts.get(s.path);
    if (text === undefined) {
      skipped.push({ path: s.path, why: 'Studio did not return its source' });
      continue;
    }
    const full = join(ctx.root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    pulled.push(file);
    base.record(s.path, normalizeSource(text));
  }
  base.setUnmapped(skipped.map((x) => x.path));
  // The sync's mark: Studio's scripts are now exactly what the files say.
  const marker = SyncBase.newMarker();
  const mark = await studio.runLuau(`game:GetService("ServerStorage"):SetAttribute("ShurikenSync", ${JSON.stringify(marker)}) return "ok"`, 'Edit', 30_000);
  if (mark.ok) base.marker = marker;
  base.save();
  return { pulled, skipped, syncMap: map };
}

/** Luau: a survey of the place — what's in each service, remotes, UI, map, lighting, sounds, animations, tools, teams, tags. */
export const SURVEY_LUAU = `local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")
local r1 = function(v) return math.round(v * 10) / 10 end
local out = { place = { placeId = game.PlaceId, gameId = game.GameId, name = game.Name }, services = {}, remotes = {}, ui = {}, map = {}, spawns = {}, lighting = {}, sounds = { count = 0, sample = {} }, animations = {}, sequences = {}, tools = {}, teams = {}, tags = {}, player = {} }
for _, name in { "Workspace", "ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "Teams" } do
  local ok, svc = pcall(function() return game:GetService(name) end)
  if ok and svc then
    local c = { total = 0, parts = 0, meshes = 0, models = 0, scripts = 0 }
    for _, d in svc:GetDescendants() do
      c.total += 1
      if d:IsA("BasePart") then
        c.parts += 1
        if d:IsA("MeshPart") then c.meshes += 1 end
      elseif d:IsA("Model") then c.models += 1
      elseif d:IsA("LuaSourceContainer") then c.scripts += 1 end
      if (d:IsA("RemoteEvent") or d:IsA("RemoteFunction") or d:IsA("UnreliableRemoteEvent")) and #out.remotes < 150 then table.insert(out.remotes, d:GetFullName() .. " (" .. d.ClassName .. ")") end
      if d:IsA("Sound") then
        out.sounds.count += 1
        if #out.sounds.sample < 25 then table.insert(out.sounds.sample, d:GetFullName() .. " " .. d.SoundId) end
      end
      if d:IsA("Animation") and #out.animations < 40 then table.insert(out.animations, d:GetFullName() .. " " .. d.AnimationId) end
      if d:IsA("KeyframeSequence") and #out.sequences < 40 then table.insert(out.sequences, d:GetFullName()) end
      if d:IsA("SpawnLocation") and #out.spawns < 20 then table.insert(out.spawns, { d:GetFullName(), r1(d.Position.X), r1(d.Position.Y), r1(d.Position.Z) }) end
    end
    out.services[name] = c
  end
end
for _, g in game:GetService("StarterGui"):GetChildren() do
  if g:IsA("LayerCollector") then table.insert(out.ui, { name = g.Name, class = g.ClassName, elements = #g:GetDescendants(), enabled = g.Enabled }) end
end
for _, c in workspace:GetChildren() do
  if #out.map >= 60 then break end
  if c:IsA("Terrain") or c:IsA("Camera") then continue end
  if c:IsA("Model") or c:IsA("Folder") or c:IsA("BasePart") then
    local n = if c:IsA("BasePart") then 1 else 0
    for _, d in c:GetDescendants() do if d:IsA("BasePart") then n += 1 end end
    local size = nil
    if c:IsA("Model") then
      local ok, s = pcall(function() return c:GetExtentsSize() end)
      if ok then size = { r1(s.X), r1(s.Y), r1(s.Z) } end
    elseif c:IsA("BasePart") then size = { r1(c.Size.X), r1(c.Size.Y), r1(c.Size.Z) } end
    table.insert(out.map, { name = c.Name, class = c.ClassName, parts = n, size = size })
  end
end
local okCells, cells = pcall(function() return workspace.Terrain:CountCells() end)
out.terrainCells = if okCells then cells else nil
local L = game:GetService("Lighting")
out.lighting = { clock = L.ClockTime, brightness = L.Brightness, effects = {} }
local okTech, tech = pcall(function() return tostring(L.Technology) end)
if okTech then out.lighting.technology = tech end
for _, e in L:GetChildren() do table.insert(out.lighting.effects, e.ClassName) end
for _, t in game:GetService("StarterPack"):GetChildren() do table.insert(out.tools, t.Name) end
for _, t in game:GetService("Teams"):GetChildren() do table.insert(out.teams, t.Name) end
-- Only the game's own tags (Studio and plugins tag their own UI too).
local GAME = { workspace, game:GetService("ReplicatedStorage"), game:GetService("ServerStorage"), game:GetService("ServerScriptService"), game:GetService("StarterGui"), game:GetService("StarterPlayer"), game:GetService("StarterPack"), game:GetService("Lighting"), game:GetService("SoundService") }
for _, tag in CollectionService:GetAllTags() do
  if #out.tags >= 60 then break end
  for _, inst in CollectionService:GetTagged(tag) do
    local mine = false
    for _, root in GAME do
      if inst == root or inst:IsDescendantOf(root) then mine = true break end
    end
    if mine then
      table.insert(out.tags, tag)
      break
    end
  end
end
local sp = game:GetService("StarterPlayer")
out.player = { walkSpeed = sp.CharacterWalkSpeed, jumpPower = sp.CharacterJumpPower, jumpHeight = sp.CharacterJumpHeight, useJumpPower = sp.CharacterUseJumpPower }
return HttpService:JSONEncode(out)`;

export interface PlaceSurvey {
  place: { placeId: number; gameId: number; name: string };
  services: Record<string, { total: number; parts: number; meshes: number; models: number; scripts: number }>;
  remotes: string[];
  ui: Array<{ name: string; class: string; elements: number; enabled?: boolean }>;
  map: Array<{ name: string; class: string; parts: number; size?: number[] }>;
  spawns: Array<[string, number, number, number]>;
  lighting: { clock: number; brightness: number; technology?: string; effects: string[] };
  sounds: { count: number; sample: string[] };
  animations: string[];
  /** KeyframeSequences in the place (Animation Editor saves): animation_import brings them in. */
  sequences?: string[];
  tools: string[];
  teams: string[];
  tags: string[];
  player: Record<string, unknown>;
  terrainCells?: number;
}

export interface CodeScan {
  files: number;
  lines: number;
  /** Libraries recognized by module name (Knit, ProfileService, Roact, Fusion…). */
  frameworks: string[];
  /** Platform services the code uses, with how many files use each. */
  uses: Record<string, number>;
  /** Code worth a careful look (backdoors, obfuscation, web calls), file:line. */
  flags: Array<{ file: string; line: number; kind: string; why: string; text: string }>;
}

const FRAMEWORKS = /^(Knit|ProfileService|ProfileStore|DataStore2|Roact|React|ReactRoblox|Fusion|Vide|Rodux|Promise|Signal|GoodSignal|FastSignal|Janitor|Maid|Trove|Cmdr|ReplicaService|Replica|Nevermore|Matter|Iris|TopbarPlus|Zone|ZonePlus|BridgeNet2|ByteNet|Zap|Warp|Comm|Flamework|TableUtil|Spring|Blend|Charm|Reflex|Lapis)$/i;
const USES: Record<string, RegExp> = {
  DataStores: /DataStoreService|ProfileService|ProfileStore|DataStore2/,
  Purchases: /MarketplaceService/,
  Teleports: /TeleportService/,
  Badges: /BadgeService/,
  MessagingService: /MessagingService/,
  MemoryStores: /MemoryStoreService/,
  'Web requests': /HttpService\s*:\s*(PostAsync|GetAsync|RequestAsync)/,
  Pathfinding: /PathfindingService/,
  Remotes: /OnServerEvent|FireServer|OnClientEvent|FireClient|FireAllClients|OnServerInvoke|InvokeServer/,
  TextChatService: /TextChatService/,
};
const RISKY: Array<{ kind: string; re: RegExp; why: string }> = [
  { kind: 'remote require', re: /\brequire\s*\(\s*\d{6,}\s*\)/, why: 'loads a module by asset id at run time (a common free-model backdoor)' },
  { kind: 'loadstring', re: /\bloadstring\s*\(/, why: 'runs code from a string (a backdoor unless deliberate; needs LoadStringEnabled)' },
  { kind: 'environment', re: /\b(getfenv|setfenv)\s*\(/, why: 'rewrites environments (often obfuscation)' },
  { kind: 'obfuscated', re: /(\\\d{1,3}){24,}/, why: 'long runs of escaped bytes (obfuscated code)' },
  { kind: 'web call', re: /HttpService\s*:\s*(PostAsync|RequestAsync)\b/, why: 'sends data to a web server (check where, and what)' },
];

/** Deterministic facts from the game's files: libraries, services used, and code that needs a careful look. */
export function scanCode(root: string, map: SyncMap): CodeScan {
  const entries = planSync(root, map);
  const scan: CodeScan = { files: entries.length, lines: 0, frameworks: [], uses: {}, flags: [] };
  const fw = new Set<string>();
  for (const e of entries) {
    const lines = e.source.split('\n');
    scan.lines += lines.length;
    for (const seg of e.instancePath.split('/')) if (FRAMEWORKS.test(seg)) fw.add(seg);
    for (const [k, re] of Object.entries(USES)) if (re.test(e.source)) scan.uses[k] = (scan.uses[k] ?? 0) + 1;
    for (let i = 0; i < lines.length && scan.flags.length < 40; i++) {
      const hit = RISKY.find((r) => r.re.test(lines[i]!));
      if (hit) scan.flags.push({ file: e.file, line: i + 1, kind: hit.kind, why: hit.why, text: lines[i]!.trim().slice(0, 160) });
    }
  }
  scan.frameworks = [...fw].sort();
  return scan;
}

/** The analyst's structured result (see OUTPUT_SCHEMAS.dossier). */
export interface DossierOutput {
  gameSummary: string;
  systems: Array<{ name: string; purpose: string; files?: string[]; notes?: string }>;
  conventions: string[];
  risks: string[];
  suggestions: string[];
  /** Requests the user might send next (bubbles above the director's chat box: a label, and the fuller prompt). */
  chips?: Suggestion[];
  greeting: string;
}

export interface Dossier extends DossierOutput {
  name: string;
  studiedAt: string;
  /** False when the analyst couldn't finish: only the survey and scan are in. */
  complete: boolean;
  scripts: { pulled: number; skipped: Array<{ path: string; why: string }> };
  survey: PlaceSurvey | null;
  scan: CodeScan;
}

/** The study's results: `.shuriken/dossier.json` (data) and `.shuriken/dossier.md` (the brief). */
export class DossierStore {
  constructor(private readonly root: string) {}

  private file(ext: 'json' | 'md'): string {
    return join(this.root, '.shuriken', `dossier.${ext}`);
  }

  get(): Dossier | null {
    try {
      return JSON.parse(readFileSync(this.file('json'), 'utf8')) as Dossier;
    } catch {
      return null;
    }
  }

  brief(): string | null {
    return existsSync(this.file('md')) ? readFileSync(this.file('md'), 'utf8') : null;
  }

  save(d: Dossier): void {
    mkdirSync(join(this.root, '.shuriken'), { recursive: true });
    writeFileSync(this.file('json'), JSON.stringify(d, null, 2), 'utf8');
    writeFileSync(this.file('md'), dossierMarkdown(d), 'utf8');
  }

  /** A few lines for prompts (the director, copilots): what the game is, its systems, conventions and risks. */
  summary(max = 1800): string | null {
    const d = this.get();
    if (!d) return null;
    const lines = [d.gameSummary.trim()];
    if (d.systems.length) lines.push(`Systems: ${d.systems.map((s) => `${s.name}${s.files?.length ? ` (${s.files.slice(0, 3).join(', ')})` : ''}: ${s.purpose}`).join('; ')}`);
    if (d.conventions.length) lines.push(`Conventions: ${d.conventions.join('; ')}`);
    if (d.risks.length) lines.push(`Watch out: ${d.risks.join('; ')}`);
    const text = lines.join('\n');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
}

export function dossierMarkdown(d: Dossier): string {
  const s = d.survey;
  const out: string[] = [`# ${d.name} — what this game is (the study)`, '', `Studied ${d.studiedAt.slice(0, 16).replace('T', ' ')}. Everyone working on this game reads this first and keeps to its conventions.${d.complete ? '' : ' The code reading did not finish: only the facts below are in.'}`, ''];
  if (d.gameSummary.trim()) out.push('## The game', '', d.gameSummary.trim(), '');
  if (d.systems.length) {
    out.push('## Systems', '');
    for (const x of d.systems) out.push(`- **${x.name}** — ${x.purpose}${x.files?.length ? ` (${x.files.join(', ')})` : ''}${x.notes ? ` ${x.notes}` : ''}`);
    out.push('');
  }
  if (d.conventions.length) out.push('## Conventions (new code follows these)', '', ...d.conventions.map((c) => `- ${c}`), '');
  if (d.risks.length) out.push('## Risks and fragile spots', '', ...d.risks.map((c) => `- ${c}`), '');
  if (d.suggestions.length) out.push('## Worth offering the user', '', ...d.suggestions.map((c) => `- ${c}`), '');
  out.push('## Facts', '');
  out.push(`- Code: ${d.scan.files} scripts, ${d.scan.lines} lines in files${d.scripts.skipped.length ? `; ${d.scripts.skipped.length} left in Studio only (${d.scripts.skipped.slice(0, 6).map((x) => `${x.path}: ${x.why}`).join('; ')}${d.scripts.skipped.length > 6 ? '; …' : ''})` : ''}.`);
  if (d.scan.frameworks.length) out.push(`- Libraries: ${d.scan.frameworks.join(', ')}.`);
  const uses = Object.entries(d.scan.uses).sort((a, b) => b[1] - a[1]);
  if (uses.length) out.push(`- Uses: ${uses.map(([k, n]) => `${k} (${n} file${n === 1 ? '' : 's'})`).join(', ')}.`);
  if (d.scan.flags.length) out.push(`- Code to look at carefully: ${d.scan.flags.slice(0, 12).map((f) => `${f.file}:${f.line} ${f.kind}`).join('; ')}.`);
  if (s) {
    const svc = Object.entries(s.services)
      .filter(([, c]) => c.total > 0)
      .map(([k, c]) => `${k} ${c.total} (${c.parts} parts, ${c.models} models, ${c.scripts} scripts)`);
    out.push(`- Place: ${s.place.name}${s.place.placeId ? ` (place ${s.place.placeId})` : ''}. ${svc.join('; ')}.`);
    if (s.map.length) out.push(`- Workspace: ${s.map.slice(0, 30).map((m) => `${m.name} (${m.class}, ${m.parts} parts${m.size ? `, ${m.size.join('×')}` : ''})`).join('; ')}${s.terrainCells ? `; terrain ${s.terrainCells} cells` : ''}.`);
    if (s.remotes.length) out.push(`- Remotes (${s.remotes.length}): ${s.remotes.slice(0, 40).join('; ')}.`);
    if (s.ui.length) out.push(`- UI: ${s.ui.map((u) => `${u.name} (${u.elements} elements${u.enabled === false ? ', off' : ''})`).join('; ')}.`);
    out.push(`- Lighting: clock ${s.lighting.clock}, brightness ${s.lighting.brightness}${s.lighting.technology ? `, ${s.lighting.technology.replace('Enum.Technology.', '')}` : ''}; ${s.lighting.effects.join(', ') || 'no effects'}.`);
    if (s.sounds.count) out.push(`- Sounds: ${s.sounds.count}.`);
    if (s.animations.length) out.push(`- Animations: ${s.animations.slice(0, 12).join('; ')}.`);
    if (s.sequences?.length) out.push(`- Animation saves (KeyframeSequences; animation_import brings one in to edit): ${s.sequences.slice(0, 12).join('; ')}.`);
    if (s.tools.length) out.push(`- Starter tools: ${s.tools.join(', ')}.`);
    if (s.teams.length) out.push(`- Teams: ${s.teams.join(', ')}.`);
    if (s.tags.length) out.push(`- Tags: ${s.tags.join(', ')}.`);
    out.push(`- Character: ${Object.entries(s.player).map(([k, v]) => `${k} ${String(v)}`).join(', ')}.`);
  }
  return `${out.join('\n')}\n`;
}

/** Project instructions for a plugged-in game: its own structure rules, and how files map to Studio. */
export function adoptedInstructions(name: string, map: SyncMap): string {
  const rows = Object.entries(map)
    .map(([disk, inst]) => `| ${disk} | ${inst.replaceAll('/', '.')} |`)
    .join('\n');
  return `# ${name} — project instructions

This is an EXISTING game the user plugged in: it was built before Shuriken (by the user, other people or
another session). Work WITH it, not around it:
- Read the study first (.shuriken/dossier.md): what the game is, its systems, conventions and risks.
- Extend its systems where they live; follow its code style, libraries and naming. Don't rewrite or
  "clean up" what you weren't asked to change, and never delete its scripts or instances unless asked.
- Its world was built by hand in Studio: change it in place, carefully. New content you add is also
  written as an idempotent builder under world/ so it can be rebuilt.

Code is in files, kept in sync with Studio both ways (roblox_sync_push after changing files). A script
someone edits in Studio meanwhile is never overwritten: its file takes Studio's version, or both changes
are merged; when both changed the same lines the file gets conflict markers to resolve.

| Disk | Studio |
|---|---|
${rows}

Naming: X.server.luau = Script (the existing one keeps its RunContext), X.client.luau = LocalScript,
X.luau = ModuleScript, Folder/init(.server|.client).luau = a script with children. Scripts in Studio
that can't be files (duplicate names) are left alone there; the study lists them.
Shuriken's own generated modules (animations, sounds, effects) go in ${ADOPTED_SHARED[1].replaceAll('/', '.')}.
`;
}

/** The analyst's brief: what was pulled, the survey, the code scan. */
export function analystBrief(name: string, root: string, pull: { pulled: string[]; skipped: Array<{ path: string; why: string }> }, survey: PlaceSurvey | null, scan: CodeScan): string {
  const files = pull.pulled.map((f) => {
    let lines = 0;
    try {
      lines = readFileSync(join(root, f), 'utf8').split('\n').length;
    } catch {
      /* gone */
    }
    return `${f} (${lines})`;
  });
  const shown = files.length > 450 ? [...files.slice(0, 450), `… and ${files.length - 450} more (Glob src/**)`] : files;
  return [
    `Study the Roblox game "${name}" the user just plugged in. Shuriken did not build it. Its scripts are now files under src/ (mirroring where they live in Studio) and the place is open in Studio.`,
    `Files (lines):\n${shown.join('\n') || '(no scripts)'}`,
    pull.skipped.length ? `Left in Studio only (can't be files): ${pull.skipped.slice(0, 30).map((x) => `${x.path} — ${x.why}`).join('; ')}` : '',
    `Code scan: ${scan.files} scripts, ${scan.lines} lines. Libraries: ${scan.frameworks.join(', ') || 'none recognized'}. Uses: ${Object.entries(scan.uses).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}.${scan.flags.length ? `\nFlagged lines (judge each; free-model backdoors are common):\n${scan.flags.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text}`).join('\n')}` : ''}`,
    survey ? `Survey of the place (JSON):\n${JSON.stringify(survey).slice(0, 14000)}` : 'The place survey failed; probe Studio yourself if you need to.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** How to name the place in messages: a file's name, or the Studio place's. */
export function adoptedPlaceLabel(place: string): string {
  return /\.rbxlx?$/i.test(place) ? basename(place) : place;
}
