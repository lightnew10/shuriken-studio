import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { newId, nowIso } from '@shared/ids';
import type { ProjectSettings, ProjectSummary } from '@shared/domain';
import { Store, j, pj } from '../db/store';
import { PROJECT_MIGRATIONS } from '../db/schema';
import type { EventBus } from '../events';
import { AuditService } from '../audit/audit-service';
import { TaskGraph } from '../tasks/task-graph';
import { ResearchService } from '../research/research-service';
import { GovernanceService } from './governance-service';
import { GitService } from '../git/git-service';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import { DEFAULT_ESCALATION } from '../permissions/policy';
import { SCRATCH_DIR } from '../permissions/scratch';
import { DEFAULT_SYNC_MAP, type SyncMap } from '../roblox/luau-toolchain';

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  autonomy: 'supervised',
  // 0 = automatic: 3-32 agents, chosen from the ready work, usage headroom and the queue for Studio (orchestrator/concurrency.ts).
  maxConcurrentAgents: 0,
  // The planner, the workers and the critic run on the deep tier (the critic at medium effort: roles.ts); research
  // and chat on the balanced one. A project's own choice is kept; the defaults 1.9 wrote into every project are not
  // a choice (see savedSettings).
  modelTier: { executive: 'deep', worker: 'deep', critic: 'deep', research: 'balanced', chat: 'balanced' },
  maxAttemptsPerTask: 3,
  robloxStudioMatch: null,
  sourceDir: 'src',
  escalation: DEFAULT_ESCALATION,
};

/** The model tiers 1.9 saved with every project's settings (its defaults then). */
const TIERS_1_9 = { executive: 'deep', worker: 'deep', critic: 'balanced', research: 'balanced', chat: 'balanced' } as const;

export interface ProjectExtras {
  syncMap: SyncMap;
  /** 'shuriken': Shuriken pushes code into Studio. 'script-sync': Studio's native Script Sync is linked. 'none': no sync. */
  syncMode: 'shuriken' | 'script-sync' | 'none';
  /** Snapshot roots used for before/after DataModel evidence. */
  snapshotRoots: string[];
  /** Published experience for Open Cloud Luau execution (headless tests). */
  /** The published game: its universe and place, and its name on Roblox ("Voxel Pit") once Studio has shown it (followPlace). */
  cloud: { universeId: string | null; placeId: string | null; name?: string | null };
  /** Local place file (relative to the project root) Shuriken can open in Studio. */
  placeFile: string | null;
  /** Save the place in Studio (through its File menu) after verified work. Default on. */
  autoSave?: boolean;
  /** The user paused the work; it stays paused across restarts until they resume. */
  paused?: boolean;
  /**
   * Wrapping up (the user said "wrap it up"): nothing new is created or started — no triage, no polish, no look, no
   * final regression run — and what runs finishes. Ends with the user's next request (Orchestrator.endWrapUp).
   */
  wrapUp?: boolean;
  /** Resume the team once the plan update now being made is ready ("resume when the plan is ready"). */
  resumeWhenPlanned?: boolean;
  /**
   * The user's messages the director couldn't answer because the Claude account was at its usage limit, oldest first:
   * answered together when the limit resets, another account is chosen, or the project opens again (Director).
   */
  heldMessages?: Array<{ text: string; at: string }>;
  /** When a timed pause ends by itself (ISO); null for an open-ended pause. */
  pausedUntil?: string | null;
  /**
   * Opened blank ("Open blank" in the projects menu): no game started yet, so no plan and no Studio
   * place. The first game the user describes in the chat sets both up, the same as the start page.
   */
  blank?: boolean;
  /** The user named the project themselves: a game started from the chat keeps that name. */
  userNamed?: boolean;
  /**
   * A game Shuriken didn't build, plugged in from a place open in Studio or a place file: where it came
   * from, and its study (`.shuriken/dossier.md`).
   */
  adopted?: AdoptedGame;
}

export interface AdoptedGame {
  from: 'studio' | 'file';
  /** The Studio place (its name as Studio shows it) or the place file's path. */
  place: string;
  placeId?: string | null;
  at: string;
  /** Scripts pulled into files, and ones that can't be files (duplicate or invalid names). */
  pulled?: number;
  skipped?: number;
  /** When the study (survey + analyst) last finished. */
  studiedAt?: string | null;
}

export const DEFAULT_EXTRAS: ProjectExtras = {
  syncMap: DEFAULT_SYNC_MAP,
  syncMode: 'shuriken',
  snapshotRoots: ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPlayer', 'Lighting'],
  cloud: { universeId: null, placeId: null },
  placeFile: null,
};

/** The project's place file (absolute), or null. A plugged-in game's own file may live anywhere. */
export function placePath(ctx: ProjectContext): string | null {
  const f = ctx.extras().placeFile;
  return f ? (isAbsolute(f) ? f : join(ctx.root, f)) : null;
}

/** Everything that belongs to one open project. */
export class ProjectContext {
  readonly dir: string;
  readonly store: Store;
  readonly audit: AuditService;
  readonly tasks: TaskGraph;
  readonly research: ResearchService;
  readonly governance: GovernanceService;
  readonly git: GitService;

  constructor(
    public summary: ProjectSummary,
    bus: EventBus,
    knowledge: KnowledgeService,
  ) {
    this.dir = join(summary.rootPath, '.shuriken');
    for (const d of ['context', 'evidence', 'snapshots', 'state', 'skills', SCRATCH_DIR]) mkdirSync(join(this.dir, d), { recursive: true });
    this.store = new Store(join(this.dir, 'project.db'), PROJECT_MIGRATIONS);
    this.audit = new AuditService(this.store, bus);
    this.tasks = new TaskGraph(this.store, bus, this.audit);
    this.research = new ResearchService(this.store, bus, knowledge);
    this.governance = new GovernanceService(this.store, bus, this.audit, this.dir);
    this.git = new GitService(summary.rootPath, this.store, this.audit);
    this.governance.ensureSpec();
  }

  get root(): string {
    return this.summary.rootPath;
  }

  /**
   * What the project saved. Its model tiers count only when they are a choice: up to 1.9 every save (binding
   * Studio, the agent count) wrote the default tiers along, and there has never been a control for them, so a saved
   * set equal to 1.9's defaults is dropped and the current defaults apply. Tiers saved through updateSettings from
   * now on are marked as chosen and kept whatever they are.
   */
  private savedSettings(): Partial<ProjectSettings> & { modelTierChosen?: boolean } {
    const raw = this.store.get<{ value: string }>(`SELECT value FROM project_settings WHERE key = 'settings'`);
    const s = pj<Partial<ProjectSettings> & { modelTierChosen?: boolean }>(raw?.value, {});
    const t = s.modelTier as Partial<ProjectSettings['modelTier']> | undefined;
    if (t && !s.modelTierChosen && (Object.keys(TIERS_1_9) as Array<keyof typeof TIERS_1_9>).every((k) => t[k] === TIERS_1_9[k])) delete s.modelTier;
    return s;
  }

  settings(): ProjectSettings {
    const s = this.savedSettings();
    return { ...DEFAULT_PROJECT_SETTINGS, ...s, modelTier: { ...DEFAULT_PROJECT_SETTINGS.modelTier, ...(s.modelTier ?? {}) }, escalation: { ...DEFAULT_ESCALATION, ...(s.escalation ?? {}) } };
  }

  updateSettings(patch: Partial<ProjectSettings>): ProjectSettings {
    const next = { ...this.settings(), ...patch };
    // The tiers are saved only when they were chosen (now, or before): defaults stay defaults, so a later default reaches the project.
    const { modelTier: _tiers, ...rest } = next;
    const chosen = patch.modelTier ?? this.savedSettings().modelTier;
    this.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('settings', ?)`, [j(chosen ? { ...rest, modelTier: chosen, modelTierChosen: true } : rest)]);
    return next;
  }

  extras(): ProjectExtras {
    const raw = this.store.get<{ value: string }>(`SELECT value FROM project_settings WHERE key = 'extras'`);
    return { ...DEFAULT_EXTRAS, ...pj<Partial<ProjectExtras>>(raw?.value, {}) };
  }

  updateExtras(patch: Partial<ProjectExtras>): ProjectExtras {
    const next = { ...this.extras(), ...patch };
    this.store.run(`INSERT OR REPLACE INTO project_settings (key, value) VALUES ('extras', ?)`, [j(next)]);
    return next;
  }

  instructions(): string {
    const parts: string[] = [];
    const own = join(this.dir, 'instructions.md');
    if (existsSync(own)) parts.push(readFileSync(own, 'utf8'));
    const claudeMd = join(this.root, 'CLAUDE.md');
    if (existsSync(claudeMd)) parts.push(`(from CLAUDE.md)\n${readFileSync(claudeMd, 'utf8')}`);
    return parts.join('\n\n').trim();
  }

  /** Human-readable export of provider-independent state (versioned with the project). */
  exportState(): void {
    const tasks = this.tasks.list();
    writeFileSync(join(this.dir, 'state', 'tasks.json'), JSON.stringify(tasks, null, 2), 'utf8');
    writeFileSync(join(this.dir, 'state', 'decisions.json'), JSON.stringify(this.governance.decisions(), null, 2), 'utf8');
  }

  close(): void {
    this.store.close();
  }
}

/** Projects index (global DB) + creation/adoption of project folders. */
export class ProjectService {
  constructor(
    private readonly global: Store,
    private readonly bus: EventBus,
    private readonly knowledge: KnowledgeService,
  ) {}

  list(): ProjectSummary[] {
    return this.global
      .all<{ id: string; name: string; root_path: string; description: string; created_at: string; updated_at: string; last_opened_at: string | null }>(
        'SELECT * FROM projects WHERE archived = 0 ORDER BY COALESCE(last_opened_at, created_at) DESC',
      )
      .map((r) => ({ id: r.id, name: r.name, rootPath: r.root_path, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at, lastOpenedAt: r.last_opened_at }));
  }

  get(id: string): ProjectSummary | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  /**
   * Create a new Roblox project folder (or adopt an existing folder). Existing files are never
   * overwritten; template files are only written when absent.
   */
  create(input: { name: string; rootPath: string; description?: string; template?: 'roblox' | 'adopted' | 'empty' }): ProjectSummary {
    const root = resolve(input.rootPath);
    const dir = join(root, '.shuriken');
    mkdirSync(dir, { recursive: true });
    const identityFile = join(dir, 'project.json');
    let identity: { id: string; name: string; createdAt: string } | null = null;
    if (existsSync(identityFile)) identity = pj(readFileSync(identityFile, 'utf8'), null);
    // A folder that already carries a Shuriken identity is adopted as-is (its name included): opening
    // an existing project from another machine or data directory must not rename it.
    const adopted = !!identity;
    if (!identity) {
      identity = { id: newId('proj'), name: input.name || basename(root), createdAt: nowIso() };
      writeFileSync(identityFile, JSON.stringify({ ...identity, format: 1 }, null, 2), 'utf8');
    }
    const name = adopted ? identity.name : input.name || identity.name;
    const template = input.template ?? 'roblox';
    if (template !== 'empty') writeRobloxTemplate(root, name, template === 'adopted');
    const existing = this.global.get<{ id: string }>('SELECT id FROM projects WHERE root_path = ?', [root]);
    const ts = nowIso();
    // A project the user moved: its identity is listed with a folder that no longer holds it. The list follows it.
    const moved = adopted && !existing ? this.global.get<{ id: string; root_path: string }>('SELECT id, root_path FROM projects WHERE id = ?', [identity.id]) : undefined;
    if (moved && !existsSync(join(moved.root_path, '.shuriken', 'project.json'))) {
      this.global.run('UPDATE projects SET root_path = ?, updated_at = ?, archived = 0 WHERE id = ?', [root, ts, moved.id]);
      return this.get(moved.id)!;
    }
    if (existing) {
      this.global.run("UPDATE projects SET name = ?, description = COALESCE(NULLIF(?, ''), description), updated_at = ?, archived = 0 WHERE id = ?", [name, input.description ?? '', ts, existing.id]);
      return this.get(existing.id)!;
    }
    this.global.run('INSERT INTO projects (id, name, root_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      identity.id,
      name,
      root,
      input.description ?? '',
      identity.createdAt,
      ts,
    ]);
    return this.get(identity.id)!;
  }

  open(id: string): ProjectContext {
    const summary = this.get(id);
    if (!summary) throw new Error(`Unknown project ${id}`);
    if (!existsSync(summary.rootPath)) throw new Error(`Project folder is missing: ${summary.rootPath}`);
    this.global.run('UPDATE projects SET last_opened_at = ? WHERE id = ?', [nowIso(), id]);
    ensureIgnored(summary.rootPath);
    return new ProjectContext({ ...summary, lastOpenedAt: nowIso() }, this.bus, this.knowledge);
  }

  /** Renames a project (the list and its folder's identity file); the folder keeps its name. */
  rename(id: string, name: string, description?: string): ProjectSummary | null {
    const cur = this.get(id);
    if (!cur || !name.trim()) return cur;
    this.global.run("UPDATE projects SET name = ?, description = COALESCE(?, description), updated_at = ? WHERE id = ?", [name.trim(), description ?? null, nowIso(), id]);
    const identityFile = join(cur.rootPath, '.shuriken', 'project.json');
    try {
      const identity = pj<Record<string, unknown> | null>(readFileSync(identityFile, 'utf8'), null);
      if (identity) writeFileSync(identityFile, JSON.stringify({ ...identity, name: name.trim() }, null, 2), 'utf8');
    } catch {
      // The list has the new name; the identity file only matters when the folder is adopted elsewhere.
    }
    return this.get(id);
  }

  archive(id: string): void {
    this.global.run('UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
  }

  /** Forgets a project (its folder is untouched; the app moves it to the Recycle Bin when asked). */
  remove(id: string): void {
    this.global.run('DELETE FROM skills_index WHERE project_id = ?', [id]);
    this.global.run('DELETE FROM projects WHERE id = ?', [id]);
  }
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, 'utf8');
}

/** Lint configuration every Roblox project starts with (also what generated code is checked against). */
export const SELENE_TOML = 'std = "roblox"\nexclude = ["src/**/Packages/**"]\n\n# luau-lsp reports these with full type information.\n[lints]\nshadowing = "allow"\nundefined_variable = "allow"\nunused_variable = "allow"\n';
export const LUAURC = JSON.stringify({ languageMode: 'strict', lint: { LocalShadow: false } }, null, 2) + '\n';
/** A plugged-in game's code wasn't written for strict mode: check it the way Studio does (nonstrict). */
export const LUAURC_ADOPTED = JSON.stringify({ languageMode: 'nonstrict', lint: { LocalShadow: false } }, null, 2) + '\n';

/** Operational state added to Shuriken's .gitignore after projects were created (appended on open). */
const LATER_IGNORES = [
  // Every Blender change keeps a full .blend copy for undo: checkpoints must not commit them.
  { line: '.shuriken/blender/', comment: '# Blender version history (undo snapshots; models/<Name>.blend is the model)' },
  // What each script looked like at the last sync with Studio (for three-way merges), and synced-away files.
  { line: '.shuriken/sync/', comment: '# Code sync state (the last agreed version of each script)' },
  // Agents' throwaway files (see permissions/scratch.ts).
  { line: `.shuriken/${SCRATCH_DIR}/`, comment: "# Agents' scratch files (throwaway scripts and intermediate files)" },
  // The user's reference clips (up to 1 GB each, often another game's footage) and what was measured from them.
  { line: '.shuriken/references/', comment: "# Reference footage and pictures (copies of the user's files, frames, studies)" },
];

/** Add the ignore lines newer Shuriken versions need to a project's own .gitignore. */
function ensureIgnored(root: string): void {
  const file = join(root, '.gitignore');
  try {
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const add = LATER_IGNORES.filter((x) => !have.has(x.line)).flatMap((x) => [x.comment, x.line]);
    if (add.length) writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`, 'utf8');
  } catch {
    /* a read-only or locked .gitignore only costs repository size */
  }
}

/** A Roblox project's files. A plugged-in game keeps its own layout (its instructions are written when its scripts come in). */
function writeRobloxTemplate(root: string, name: string, adopted = false): void {
  for (const d of adopted ? ['src', 'world'] : ['src/Server', 'src/Shared', 'src/Client', 'world']) mkdirSync(join(root, d), { recursive: true });
  writeIfMissing(
    join(root, '.gitignore'),
    ['# Shuriken operational state (task DB, evidence, compiled contexts, snapshots)', '.shuriken/*.db', '.shuriken/*.db-*', '.shuriken/evidence/', '.shuriken/context/', '.shuriken/snapshots/', ...LATER_IGNORES.map((x) => x.line), 'sourcemap.json', '*.rbxl', '*.rbxlx', '*.rbxl.lock', '*.rbxlx.lock', ''].join('\n'),
  );
  writeIfMissing(join(root, 'selene.toml'), SELENE_TOML);
  writeIfMissing(join(root, '.luaurc'), adopted ? LUAURC_ADOPTED : LUAURC);
  if (adopted) return;
  writeIfMissing(
    join(root, '.shuriken', 'instructions.md'),
    `# ${name} — project instructions\n\nCode lives on disk and is the source of truth:\n\n| Disk | Studio |\n|---|---|\n| src/Server | ServerScriptService.Server |\n| src/Shared | ReplicatedStorage.Shared |\n| src/Client | StarterPlayer.StarterPlayerScripts.Client |\n\nNaming: X.server.luau = Script, X.client.luau = LocalScript, X.luau = ModuleScript, Folder/init.luau = ModuleScript with children.\nAfter changing code, run roblox_sync_push so Studio runs what is on disk.\n\nWorld as code: the place (parts, models, terrain, UI instances) only persists when a human saves it in Studio, so every world construction must ALSO be written as an idempotent builder script under world/<Name>.luau (returns a string; safe to re-run: it replaces what it owns) and executed with roblox_run_luau. The map can then always be rebuilt from the repository.\n`,
  );
  writeIfMissing(join(root, 'src', 'Shared', 'README.md'), 'Shared modules (ReplicatedStorage.Shared). ModuleScripts only.\n');
}
