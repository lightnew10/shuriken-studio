import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillSummary } from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import { nowIso } from '@shared/ids';
import type { ScopedLogger } from '../log';

/**
 * Skills are procedural knowledge stored as `<dir>/<name>/SKILL.md` (Agent Skills format:
 * YAML frontmatter with `name` + `description`, markdown body). Shuriken adds optional
 * frontmatter keys: `tags`, `roblox_systems`, `version_applicability`, `required_tools`, `version`.
 * Files are canonical; the DB table is an index for fast matching.
 */
/** Bundled skills that were replaced: removed from the skills folder on the next start. */
const RETIRED_SKILLS = ['build123d-props'];

export class SkillService {
  private projectDir: string | null = null;
  private projectId: string | null = null;
  /** Additional global skill folders contributed by plugins. */
  private readonly extraDirs: string[] = [];

  constructor(
    private readonly globalStore: Store,
    private readonly globalDir: string,
    private readonly bundledDir: string | null,
    private readonly log: ScopedLogger,
  ) {
    mkdirSync(globalDir, { recursive: true });
  }

  /** Copy bundled seed skills into the global directory when missing or older (retired ones go). */
  syncBundled(): number {
    if (!this.bundledDir || !existsSync(this.bundledDir)) return 0;
    let n = 0;
    for (const name of RETIRED_SKILLS) {
      const old = join(this.globalDir, name);
      if (existsSync(old)) {
        rmSync(old, { recursive: true, force: true });
        n++;
      }
    }
    for (const name of readdirSync(this.bundledDir)) {
      const src = join(this.bundledDir, name);
      if (!statSync(src).isDirectory() || !existsSync(join(src, 'SKILL.md'))) continue;
      const dst = join(this.globalDir, name);
      const srcMeta = parseSkillFile(readFileSync(join(src, 'SKILL.md'), 'utf8')).meta;
      const dstFile = join(dst, 'SKILL.md');
      const dstMeta = existsSync(dstFile) ? parseSkillFile(readFileSync(dstFile, 'utf8')).meta : null;
      if (!dstMeta || Number(srcMeta.version ?? 0) > Number(dstMeta.version ?? 0)) {
        cpSync(src, dst, { recursive: true });
        n++;
      }
    }
    return n;
  }

  addExtraDir(dir: string): void {
    if (!this.extraDirs.includes(dir)) this.extraDirs.push(dir);
  }

  attachProject(projectId: string | null, dir: string | null): void {
    this.projectId = projectId;
    this.projectDir = dir;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  private lastRefresh = 0;

  /** Pick up skills added or edited on disk while running (bundled seeds, plugins, the user's edits). */
  refreshIfStale(maxAgeMs = 60000): void {
    if (Date.now() - this.lastRefresh < maxAgeMs) return;
    this.lastRefresh = Date.now();
    try {
      this.syncBundled();
      this.reindex();
    } catch (e) {
      this.log.warn('Skill refresh failed', e);
    }
  }

  /** Re-scan skill directories and rebuild the index. */
  reindex(): SkillSummary[] {
    const found: SkillSummary[] = [];
    const scan = (dir: string, scope: 'global' | 'project') => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const file = join(dir, name, 'SKILL.md');
        if (!existsSync(file)) continue;
        try {
          const parsed = parseSkillFile(readFileSync(file, 'utf8'));
          found.push(toSummary(parsed.meta, name, scope, file));
        } catch (e) {
          this.log.warn(`Skipping unreadable skill ${file}`, e);
        }
      }
    };
    scan(this.globalDir, 'global');
    for (const d of this.extraDirs) scan(d, 'global');
    if (this.projectDir) scan(this.projectDir, 'project');
    this.globalStore.tx(() => {
      this.globalStore.run(`DELETE FROM skills_index WHERE scope = 'global' OR project_id IS ?`, [this.projectId]);
      for (const s of found) {
        this.globalStore.run(
          `INSERT OR REPLACE INTO skills_index (name, scope, project_id, path, description, tags, roblox_systems, version_applicability, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.name, s.scope, s.scope === 'project' ? this.projectId : null, s.path, s.description, j(s.tags), j(s.robloxSystems), s.versionApplicability, nowIso()],
        );
      }
    });
    return found;
  }

  list(): SkillSummary[] {
    return this.globalStore
      .all<{ name: string; scope: 'global' | 'project'; path: string; description: string; tags: string; roblox_systems: string; version_applicability: string | null }>(
        `SELECT * FROM skills_index WHERE scope = 'global' OR project_id IS ? ORDER BY name`,
        [this.projectId],
      )
      .map((r) => ({
        name: r.name,
        scope: r.scope,
        path: r.path,
        description: r.description,
        tags: pj(r.tags, []),
        robloxSystems: pj(r.roblox_systems, []),
        versionApplicability: r.version_applicability,
      }));
  }

  get(name: string): Skill | null {
    // Project skills shadow global skills of the same name.
    const all = this.list().filter((s) => s.name === name);
    const pick = all.find((s) => s.scope === 'project') ?? all[0];
    if (!pick || !existsSync(pick.path)) return null;
    const parsed = parseSkillFile(readFileSync(pick.path, 'utf8'));
    return { ...pick, body: parsed.body };
  }

  /** Create or replace a skill file (agents propose skills; the file is canonical). */
  write(scope: 'global' | 'project', name: string, meta: Record<string, unknown>, body: string): Skill {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error(`Invalid skill name "${name}" (lowercase, digits, hyphens)`);
    const base = scope === 'global' ? this.globalDir : this.projectDir;
    if (!base) throw new Error('No project open for project-scoped skill');
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), serializeSkill({ ...meta, name }, body), 'utf8');
    this.reindex();
    return this.get(name)!;
  }

  /**
   * Rank skills by relevance to a task: explicit requests first, then Roblox-system overlap,
   * then keyword overlap with name/description/tags.
   */
  match(input: { text: string; requested?: string[]; robloxSystems?: string[] }, limit = 4): SkillSummary[] {
    const words = new Set(input.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
    const systems = new Set((input.robloxSystems ?? []).map((s) => s.toLowerCase()));
    const requested = new Set(input.requested ?? []);
    const scored = this.list().map((s) => {
      let score = requested.has(s.name) ? 100 : 0;
      for (const sys of s.robloxSystems) if (systems.has(sys.toLowerCase())) score += 8;
      const hay = `${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/);
      for (const w of hay) if (words.has(w)) score += 1;
      for (const t of s.tags) if (words.has(t.toLowerCase())) score += 2;
      return { s, score };
    });
    return scored
      .filter((x) => x.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }
}

// ─── SKILL.md parsing (YAML frontmatter subset) ──────────────────────────────

export function parseSkillFile(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYamlSubset(m[1]!), body: m[2]!.trim() };
}

/** Supports `key: value`, `key: [a, b]`, block lists (`- item`) and quoted strings. */
export function parseYamlSubset(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(scalar(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (value === '') {
      out[key] = [];
      listKey = key;
    } else {
      listKey = null;
      if (value.startsWith('[') && value.endsWith(']')) {
        out[key] = value
          .slice(1, -1)
          .split(',')
          .map((v) => scalar(v.trim()))
          .filter((v) => v !== '');
      } else out[key] = scalar(value);
    }
  }
  return out;
}

function scalar(v: string): string | number | boolean {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function serializeSkill(meta: Record<string, unknown>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`);
    else if (typeof v === 'string') lines.push(`${k}: ${JSON.stringify(v)}`);
    else if (v !== undefined && v !== null) lines.push(`${k}: ${String(v)}`);
  }
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

function toSummary(meta: Record<string, unknown>, dirName: string, scope: 'global' | 'project', path: string): SkillSummary {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
  return {
    name: typeof meta.name === 'string' ? meta.name : dirName,
    description: typeof meta.description === 'string' ? meta.description : '',
    scope,
    path,
    tags: arr(meta.tags),
    robloxSystems: arr(meta.roblox_systems),
    versionApplicability: typeof meta.version_applicability === 'string' ? meta.version_applicability : null,
  };
}
