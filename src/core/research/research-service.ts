import { newId, nowIso } from '@shared/ids';
import type { ResearchClaim, ResearchSession, ResearchSource, SourceAuthority } from '@shared/domain';
import type { Store } from '../db/store';
import type { EventBus } from '../events';
import type { KnowledgeService } from '../knowledge/knowledge-service';

/**
 * Research sessions answer a question with sources, extracted claims, confidence and conflicts.
 * Conclusions can be turned into knowledge with full provenance (sources + claims).
 */
export class ResearchService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly knowledge: KnowledgeService,
  ) {}

  open(question: string, createdBy: string, taskId: string | null = null): ResearchSession {
    const id = newId('rs');
    const ts = nowIso();
    this.store.run(
      `INSERT INTO research_sessions (id, task_id, question, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)`,
      [id, taskId, question, createdBy, ts, ts],
    );
    this.bus.emit('research.changed', { sessionId: id });
    return this.session(id)!;
  }

  session(id: string): ResearchSession | null {
    const r = this.store.get<{ id: string; task_id: string | null; question: string; status: ResearchSession['status']; conclusion: string | null; created_by: string; created_at: string; updated_at: string }>(
      'SELECT * FROM research_sessions WHERE id = ?',
      [id],
    );
    return r
      ? { id: r.id, taskId: r.task_id, question: r.question, status: r.status, conclusion: r.conclusion, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at }
      : null;
  }

  sessions(limit = 100): ResearchSession[] {
    return this.store
      .all<{ id: string }>('SELECT id FROM research_sessions ORDER BY updated_at DESC LIMIT ?', [limit])
      .map((r) => this.session(r.id)!);
  }

  sessionForTask(taskId: string): ResearchSession | null {
    const r = this.store.get<{ id: string }>('SELECT id FROM research_sessions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', [taskId]);
    return r ? this.session(r.id) : null;
  }

  addSource(sessionId: string, input: { url: string; title: string; authority: SourceAuthority; summary?: string }): ResearchSource {
    this.requireOpen(sessionId);
    const existing = this.store.get<{ id: string }>('SELECT id FROM research_sources WHERE session_id = ? AND url = ?', [sessionId, input.url]);
    if (existing) return this.sources(sessionId).find((s) => s.id === existing.id)!;
    const src: ResearchSource = {
      id: newId('src'),
      sessionId,
      url: input.url,
      title: input.title,
      authority: input.authority,
      summary: input.summary ?? '',
      retrievedAt: nowIso(),
    };
    this.store.run(
      `INSERT INTO research_sources (id, session_id, url, title, authority, summary, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [src.id, sessionId, src.url, src.title, src.authority, src.summary, src.retrievedAt],
    );
    this.touch(sessionId);
    return src;
  }

  addClaim(
    sessionId: string,
    input: { claim: string; sourceId?: string | null; confidence?: number; status?: ResearchClaim['status']; notes?: string | null },
  ): ResearchClaim {
    this.requireOpen(sessionId);
    if (input.sourceId && !this.store.get('SELECT 1 FROM research_sources WHERE id = ? AND session_id = ?', [input.sourceId, sessionId])) {
      throw new Error(`Source ${input.sourceId} is not part of research session ${sessionId}`);
    }
    const c: ResearchClaim = {
      id: newId('clm'),
      sessionId,
      sourceId: input.sourceId ?? null,
      claim: input.claim,
      confidence: input.confidence ?? 0.5,
      status: input.status ?? 'unverified',
      notes: input.notes ?? null,
      knowledgeId: null,
      createdAt: nowIso(),
    };
    this.store.run(
      `INSERT INTO research_claims (id, session_id, source_id, claim, confidence, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, sessionId, c.sourceId, c.claim, c.confidence, c.status, c.notes, c.createdAt],
    );
    this.touch(sessionId);
    return c;
  }

  sources(sessionId: string): ResearchSource[] {
    return this.store
      .all<{ id: string; session_id: string; url: string; title: string; authority: SourceAuthority; summary: string; retrieved_at: string }>(
        'SELECT * FROM research_sources WHERE session_id = ? ORDER BY retrieved_at',
        [sessionId],
      )
      .map((r) => ({ id: r.id, sessionId: r.session_id, url: r.url, title: r.title, authority: r.authority, summary: r.summary, retrievedAt: r.retrieved_at }));
  }

  claims(sessionId: string): ResearchClaim[] {
    return this.store
      .all<{ id: string; session_id: string; source_id: string | null; claim: string; confidence: number; status: ResearchClaim['status']; notes: string | null; knowledge_id: string | null; created_at: string }>(
        'SELECT * FROM research_claims WHERE session_id = ? ORDER BY created_at',
        [sessionId],
      )
      .map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        sourceId: r.source_id,
        claim: r.claim,
        confidence: r.confidence,
        status: r.status,
        notes: r.notes,
        knowledgeId: r.knowledge_id,
        createdAt: r.created_at,
      }));
  }

  /**
   * Close a session with a conclusion. Each `findings` item becomes a knowledge entry whose
   * category is derived from the authority of its supporting sources (official → authoritative).
   */
  conclude(
    sessionId: string,
    input: {
      conclusion: string;
      actor: string;
      findings?: Array<{ title: string; body: string; claimIds?: string[]; scope?: 'roblox' | 'project' | 'domain' | 'global'; tags?: string[]; confidence?: number; versionApplicability?: string | null }>;
    },
  ): { session: ResearchSession; knowledgeIds: string[] } {
    this.requireOpen(sessionId);
    const sources = this.sources(sessionId);
    const claims = this.claims(sessionId);
    const knowledgeIds: string[] = [];
    for (const f of input.findings ?? []) {
      const backing = claims.filter((c) => f.claimIds?.includes(c.id));
      const srcIds = new Set(backing.map((c) => c.sourceId).filter(Boolean) as string[]);
      const backingSources = sources.filter((s) => srcIds.has(s.id));
      const usedSources = backingSources.length ? backingSources : sources;
      const official = usedSources.some((s) => s.authority === 'official');
      const conflicting = backing.some((c) => c.status === 'contradicted' || c.status === 'conflicting');
      const scope = f.scope ?? 'project';
      // Facts about this game are PROJECT knowledge regardless of which docs informed them;
      // only platform-wide facts backed by official sources are AUTHORITATIVE.
      const entry = this.knowledge.add({
        scope,
        category: scope === 'project' ? 'project' : official && !conflicting ? 'authoritative' : 'research',
        title: f.title,
        body: f.body,
        tags: f.tags ?? [],
        sources: usedSources.map((s) => ({ kind: 'url' as const, ref: s.url, title: s.title, authority: s.authority, retrievedAt: s.retrievedAt })),
        confidence: f.confidence ?? (official ? 0.85 : 0.6),
        versionApplicability: f.versionApplicability ?? null,
        createdBy: input.actor,
      });
      knowledgeIds.push(entry.id);
      for (const c of backing) this.store.run('UPDATE research_claims SET knowledge_id = ? WHERE id = ?', [entry.id, c.id]);
    }
    this.store.run(`UPDATE research_sessions SET status = 'concluded', conclusion = ?, updated_at = ? WHERE id = ?`, [
      input.conclusion,
      nowIso(),
      sessionId,
    ]);
    this.bus.emit('research.changed', { sessionId });
    return { session: this.session(sessionId)!, knowledgeIds };
  }

  private requireOpen(sessionId: string): void {
    const s = this.session(sessionId);
    if (!s) throw new Error(`Unknown research session ${sessionId}`);
    if (s.status !== 'open') throw new Error(`Research session ${sessionId} is ${s.status}`);
  }

  private touch(sessionId: string): void {
    this.store.run('UPDATE research_sessions SET updated_at = ? WHERE id = ?', [nowIso(), sessionId]);
    this.bus.emit('research.changed', { sessionId });
  }
}
