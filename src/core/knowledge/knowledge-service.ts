import { newId, nowIso } from '@shared/ids';
import type {
  KnowledgeCategory,
  KnowledgeEntry,
  KnowledgeLink,
  KnowledgeScope,
  KnowledgeSource,
} from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';

interface KnowledgeRow {
  id: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string;
  sources: string;
  confidence: number;
  version_applicability: string | null;
  domain: string | null;
  task_id: string | null;
  created_by: string;
  status: KnowledgeEntry['status'];
  superseded_by: string | null;
  promoted_from: string | null;
  validated_at: string | null;
  validation: string | null;
  created_at: string;
  updated_at: string;
  rank?: number;
}

export interface NewKnowledge {
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags?: string[];
  sources?: KnowledgeSource[];
  confidence?: number;
  versionApplicability?: string | null;
  domain?: string | null;
  taskId?: string | null;
  createdBy: string;
}

export interface KnowledgeQuery {
  text?: string;
  scopes?: KnowledgeScope[];
  categories?: KnowledgeCategory[];
  tags?: string[];
  minConfidence?: number;
  includeInactive?: boolean;
  /** Only entries with at least one source of these authorities (official, staff, community, observed, inference, user). */
  authorities?: string[];
  /** Agent role / actor that created the entry. */
  createdBy?: string;
  taskId?: string;
  domain?: string;
  /** Substring of the version applicability (e.g. a Studio version or date). */
  version?: string;
  /** ISO timestamp: only entries updated at or after it. */
  since?: string;
  validatedOnly?: boolean;
  limit?: number;
}

/** Scopes that outlive a single project live in the global store. */
const GLOBAL_SCOPES: ReadonlySet<KnowledgeScope> = new Set(['global', 'roblox', 'domain']);
const SCOPE_RANK: Record<KnowledgeScope, number> = { session: 0, task: 1, project: 2, domain: 3, roblox: 4, global: 5 };

/**
 * Scoped, categorized, provenance-tracked knowledge. Global/Roblox/domain knowledge is shared
 * across projects; project/task/session knowledge stays inside the project. Promotion to a wider
 * scope creates a new entry linked to its origin and requires recorded validation.
 */
export class KnowledgeService {
  private projectStore: Store | null = null;

  constructor(
    private readonly globalStore: Store,
    private readonly bus: EventBus,
  ) {}

  attachProject(store: Store | null): void {
    this.projectStore = store;
  }

  private storeFor(scope: KnowledgeScope): Store {
    if (GLOBAL_SCOPES.has(scope)) return this.globalStore;
    if (!this.projectStore) throw new Error(`No project open: cannot store ${scope}-scoped knowledge`);
    return this.projectStore;
  }

  private stores(): Array<[Store, 'global' | 'project']> {
    const out: Array<[Store, 'global' | 'project']> = [[this.globalStore, 'global']];
    if (this.projectStore) out.push([this.projectStore, 'project']);
    return out;
  }

  add(input: NewKnowledge): KnowledgeEntry {
    validateConfidence(input.confidence ?? 0.5);
    if (input.category === 'authoritative' && !(input.sources ?? []).some((s) => s.authority === 'official' || s.authority === 'user')) {
      throw new Error('Authoritative knowledge requires an official (or user-provided) source');
    }
    const store = this.storeFor(input.scope);
    const id = newId('k');
    const ts = nowIso();
    store.run(
      `INSERT INTO knowledge (id, scope, category, title, body, tags, sources, confidence, version_applicability, domain, task_id,
        created_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        input.scope,
        input.category,
        input.title,
        input.body,
        j(input.tags ?? []),
        j(input.sources ?? []),
        input.confidence ?? 0.5,
        input.versionApplicability ?? null,
        input.domain ?? null,
        input.taskId ?? null,
        input.createdBy,
        ts,
        ts,
      ],
    );
    this.bus.emit('knowledge.changed', { id });
    return this.get(id)!;
  }

  get(id: string): KnowledgeEntry | null {
    for (const [store, name] of this.stores()) {
      const row = store.get<KnowledgeRow>('SELECT * FROM knowledge WHERE id = ?', [id]);
      if (row) return hydrate(row, name);
    }
    return null;
  }

  /**
   * Full-text + filter search across both stores. Results are ranked by FTS relevance, then by
   * confidence and category authority. Without text, returns the most recently updated entries.
   */
  search(q: KnowledgeQuery = {}): KnowledgeEntry[] {
    const limit = q.limit ?? 30;
    const results: Array<KnowledgeEntry & { _rank: number }> = [];
    const match = q.text ? toFtsQuery(q.text) : null;
    for (const [store, name] of this.stores()) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (!q.includeInactive) where.push(`k.status = 'active'`);
      if (q.scopes?.length) {
        where.push(`k.scope IN (${q.scopes.map(() => '?').join(',')})`);
        params.push(...q.scopes);
      }
      if (q.categories?.length) {
        where.push(`k.category IN (${q.categories.map(() => '?').join(',')})`);
        params.push(...q.categories);
      }
      if (q.minConfidence !== undefined) {
        where.push('k.confidence >= ?');
        params.push(q.minConfidence);
      }
      for (const tag of q.tags ?? []) {
        where.push(`EXISTS (SELECT 1 FROM json_each(k.tags) WHERE value = ?)`);
        params.push(tag);
      }
      if (q.authorities?.length) {
        where.push(`EXISTS (SELECT 1 FROM json_each(k.sources) WHERE json_extract(value, '$.authority') IN (${q.authorities.map(() => '?').join(',')}))`);
        params.push(...q.authorities);
      }
      if (q.createdBy) {
        where.push('k.created_by = ?');
        params.push(q.createdBy);
      }
      if (q.taskId) {
        where.push('k.task_id = ?');
        params.push(q.taskId);
      }
      if (q.domain) {
        where.push('k.domain = ?');
        params.push(q.domain);
      }
      if (q.version) {
        where.push(`k.version_applicability LIKE ? ESCAPE '!'`);
        params.push(`%${q.version.replace(/[!%_]/g, (c) => `!${c}`)}%`);
      }
      if (q.since) {
        where.push('k.updated_at >= ?');
        params.push(q.since);
      }
      if (q.validatedOnly) where.push('k.validated_at IS NOT NULL');
      let rows: KnowledgeRow[];
      if (match) {
        rows = store.all<KnowledgeRow>(
          `SELECT k.*, bm25(knowledge_fts, 5.0, 1.0, 2.0) AS rank
             FROM knowledge_fts JOIN knowledge k ON k.rowid = knowledge_fts.rowid
            WHERE knowledge_fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
            ORDER BY rank LIMIT ?`,
          [match, ...params, limit],
        );
      } else {
        rows = store.all<KnowledgeRow>(
          `SELECT k.*, 0 AS rank FROM knowledge k ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY k.updated_at DESC LIMIT ?`,
          [...params, limit],
        );
      }
      for (const r of rows) results.push({ ...hydrate(r, name), _rank: r.rank ?? 0 });
    }
    const categoryWeight: Record<KnowledgeCategory, number> = { authoritative: 1.0, project: 0.9, research: 0.8, experimental: 0.6, agent: 0.5 };
    results.sort((a, b) => {
      if (match) {
        // bm25: lower is better. Blend with trust so authoritative, confident entries float up.
        const sa = a._rank - a.confidence * categoryWeight[a.category] * 2;
        const sb = b._rank - b.confidence * categoryWeight[b.category] * 2;
        return sa - sb;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return results.slice(0, limit).map(({ _rank, ...e }) => e);
  }

  /** Distinct values for the knowledge browser's filters, across both stores. */
  facets(): { createdBy: string[]; domains: string[]; versions: string[] } {
    const createdBy = new Set<string>();
    const domains = new Set<string>();
    const versions = new Set<string>();
    for (const [store] of this.stores()) {
      for (const r of store.all<{ v: string }>('SELECT DISTINCT created_by AS v FROM knowledge')) createdBy.add(r.v);
      for (const r of store.all<{ v: string }>('SELECT DISTINCT domain AS v FROM knowledge WHERE domain IS NOT NULL')) domains.add(r.v);
      for (const r of store.all<{ v: string }>('SELECT DISTINCT version_applicability AS v FROM knowledge WHERE version_applicability IS NOT NULL LIMIT 200')) versions.add(r.v);
    }
    return { createdBy: [...createdBy].sort(), domains: [...domains].sort(), versions: [...versions].sort() };
  }

  update(
    id: string,
    patch: Partial<Pick<KnowledgeEntry, 'title' | 'body' | 'tags' | 'sources' | 'confidence' | 'versionApplicability' | 'status'>>,
  ): KnowledgeEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`Unknown knowledge ${id}`);
    if (patch.confidence !== undefined) validateConfidence(patch.confidence);
    const store = existing.store === 'global' ? this.globalStore : this.projectStore!;
    const next = { ...existing, ...patch };
    store.run(
      `UPDATE knowledge SET title = ?, body = ?, tags = ?, sources = ?, confidence = ?, version_applicability = ?, status = ?, updated_at = ?
        WHERE id = ?`,
      [next.title, next.body, j(next.tags), j(next.sources), next.confidence, next.versionApplicability, next.status, nowIso(), id],
    );
    this.bus.emit('knowledge.changed', { id });
    return this.get(id)!;
  }

  /** Record that `validation` (test evidence, authoritative confirmation) supports this entry. */
  validate(id: string, validation: string, confidence?: number): KnowledgeEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`Unknown knowledge ${id}`);
    const store = existing.store === 'global' ? this.globalStore : this.projectStore!;
    const ts = nowIso();
    store.run('UPDATE knowledge SET validated_at = ?, validation = ?, confidence = ?, updated_at = ? WHERE id = ?', [
      ts,
      validation,
      confidence ?? Math.max(existing.confidence, 0.7),
      ts,
      id,
    ]);
    this.bus.emit('knowledge.changed', { id });
    return this.get(id)!;
  }

  /**
   * Promote to a wider scope. Requires the entry to be validated (or an explicit validation
   * statement) so project-specific assumptions never silently become global truth.
   */
  promote(id: string, target: KnowledgeScope, opts: { validation?: string; actor: string; domain?: string }): KnowledgeEntry {
    const src = this.get(id);
    if (!src) throw new Error(`Unknown knowledge ${id}`);
    if (SCOPE_RANK[target] <= SCOPE_RANK[src.scope]) throw new Error(`Promotion must widen scope (${src.scope} → ${target})`);
    const validation = opts.validation ?? src.validation;
    if (!validation) throw new Error('Promotion requires validation evidence');
    if (src.confidence < 0.6) throw new Error(`Confidence ${src.confidence} too low to promote (needs ≥ 0.6)`);
    const promoted = this.add({
      scope: target,
      category: src.category === 'project' ? 'experimental' : src.category,
      title: src.title,
      body: src.body,
      tags: src.tags,
      sources: [...src.sources, { kind: 'run', ref: `knowledge:${src.id}`, title: `Promoted from ${src.scope}`, authority: 'observed' }],
      confidence: src.confidence,
      versionApplicability: src.versionApplicability,
      domain: opts.domain ?? src.domain,
      createdBy: opts.actor,
    });
    const store = this.storeFor(target);
    const ts = nowIso();
    store.run('UPDATE knowledge SET promoted_from = ?, validated_at = ?, validation = ? WHERE id = ?', [src.id, ts, validation, promoted.id]);
    this.link(promoted.id, src.id, 'derived_from', `Promoted ${src.scope} → ${target}`);
    return this.get(promoted.id)!;
  }

  supersede(oldId: string, newId_: string, note?: string): void {
    const old = this.get(oldId);
    if (!old) throw new Error(`Unknown knowledge ${oldId}`);
    const store = old.store === 'global' ? this.globalStore : this.projectStore!;
    store.run(`UPDATE knowledge SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`, [newId_, nowIso(), oldId]);
    this.link(newId_, oldId, 'supersedes', note ?? null);
  }

  link(fromId: string, toId: string, relation: KnowledgeLink['relation'], note: string | null = null): void {
    const from = this.get(fromId);
    if (!from) throw new Error(`Unknown knowledge ${fromId}`);
    const store = from.store === 'global' ? this.globalStore : this.projectStore!;
    store.run(
      'INSERT OR REPLACE INTO knowledge_links (from_id, to_id, relation, note, created_at) VALUES (?, ?, ?, ?, ?)',
      [fromId, toId, relation, note, nowIso()],
    );
    if (relation === 'contradicts') {
      // Both sides become disputed until someone resolves the conflict.
      for (const id of [fromId, toId]) {
        const e = this.get(id);
        if (e && e.status === 'active') this.update(id, { status: 'disputed' });
      }
    }
  }

  links(id: string): KnowledgeLink[] {
    const out: KnowledgeLink[] = [];
    for (const [store] of this.stores()) {
      for (const r of store.all<{ from_id: string; to_id: string; relation: KnowledgeLink['relation']; note: string | null }>(
        'SELECT * FROM knowledge_links WHERE from_id = ? OR to_id = ?',
        [id, id],
      )) {
        out.push({ fromId: r.from_id, toId: r.to_id, relation: r.relation, note: r.note });
      }
    }
    return out;
  }

  /** Knowledge recorded while working on a task, used to validate it once the task is verified. */
  byTask(taskId: string): KnowledgeEntry[] {
    const out: KnowledgeEntry[] = [];
    for (const [store, name] of this.stores()) {
      for (const r of store.all<KnowledgeRow>(`SELECT * FROM knowledge WHERE task_id = ? AND status = 'active'`, [taskId])) out.push(hydrate(r, name));
    }
    return out;
  }

  /**
   * Project knowledge that has been validated by verified work and is general enough to be worth
   * promoting to Roblox/global scope (the user or executive decides; promotion is never automatic).
   */
  promotionCandidates(limit = 50): KnowledgeEntry[] {
    if (!this.projectStore) return [];
    return this.projectStore
      .all<KnowledgeRow>(
        `SELECT * FROM knowledge WHERE scope IN ('project','task') AND status = 'active' AND validated_at IS NOT NULL
           AND confidence >= 0.7 AND category IN ('experimental','agent','research')
           AND NOT EXISTS (SELECT 1 FROM json_each(knowledge.tags) WHERE value = 'project-specific')
         ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
        [limit],
      )
      .map((r) => hydrate(r, 'project'));
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [store] of this.stores()) {
      for (const r of store.all<{ scope: string; n: number }>(`SELECT scope, COUNT(*) AS n FROM knowledge WHERE status = 'active' GROUP BY scope`)) {
        out[r.scope] = (out[r.scope] ?? 0) + r.n;
      }
    }
    return out;
  }
}

function validateConfidence(c: number): void {
  if (!(c >= 0 && c <= 1)) throw new Error(`Confidence must be within [0, 1], got ${c}`);
}

/** Turn free text into a safe FTS5 query: quoted tokens OR'ed together (prefix match on last). */
export function toFtsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

// The two-letter words matter most: a query is an OR of its words, and 'in' or 'to' alone matches nearly every
// entry. With 41 bundled entries, 'Greeting lives in Shared' returned thirty of them and not the project's own note.
const STOPWORDS = new Set([
  'in', 'on', 'of', 'to', 'is', 'it', 'at', 'by', 'or', 'as', 'an', 'be', 'do', 'if', 'so', 'we', 'no', 'up',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'into', 'not', 'but', 'you', 'your', 'can', 'how', 'what',
  'when', 'where', 'which', 'use', 'using', 'should', 'would', 'will', 'its', 'has', 'have', 'all', 'any', 'our', 'out',
]);

function hydrate(r: KnowledgeRow, store: 'global' | 'project'): KnowledgeEntry {
  return {
    id: r.id,
    scope: r.scope,
    category: r.category,
    title: r.title,
    body: r.body,
    tags: pj(r.tags, []),
    sources: pj(r.sources, []),
    confidence: r.confidence,
    versionApplicability: r.version_applicability,
    domain: r.domain,
    taskId: r.task_id,
    createdBy: r.created_by,
    status: r.status,
    supersededBy: r.superseded_by,
    promotedFrom: r.promoted_from,
    validatedAt: r.validated_at,
    validation: r.validation,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    store,
  };
}
