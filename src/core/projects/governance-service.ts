import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, nowIso } from '@shared/ids';
import type { Decision, Escalation, SpecSection } from '@shared/domain';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';
import type { AuditService } from '../audit/audit-service';

export const DEFAULT_SPEC_SECTIONS: Array<[string, string]> = [
  ['vision', 'Vision'],
  ['gameplay', 'Gameplay'],
  ['systems', 'Systems'],
  ['world', 'World'],
  ['ui', 'UI'],
  ['art', 'Art Direction'],
  ['audio', 'Audio'],
  ['animation', 'Animation'],
  ['networking', 'Networking'],
  ['security', 'Security'],
  ['persistence', 'Persistence'],
  ['performance', 'Performance'],
  ['monetization', 'Monetization'],
  ['platforms', 'Platform Support'],
  ['architecture', 'Technical Architecture'],
  ['testing', 'Testing'],
  ['constraints', 'Constraints'],
];

/**
 * Living project specification, architectural decisions (ADRs) and human escalations.
 * Spec sections and decisions are mirrored to markdown under `.shuriken/` so they stay
 * readable without the app.
 */
export class GovernanceService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
    private readonly docsDir: string,
  ) {
    mkdirSync(join(docsDir, 'spec'), { recursive: true });
    mkdirSync(join(docsDir, 'decisions'), { recursive: true });
  }

  // ─── Spec ──────────────────────────────────────────────────────────────────

  ensureSpec(): void {
    for (const [key, title] of DEFAULT_SPEC_SECTIONS) {
      if (!this.store.get('SELECT 1 FROM spec_sections WHERE key = ?', [key])) {
        this.store.run(
          `INSERT INTO spec_sections (key, title, body, status, version, updated_by, updated_at) VALUES (?, ?, '', 'draft', 1, 'system', ?)`,
          [key, title, nowIso()],
        );
      }
    }
  }

  spec(): SpecSection[] {
    const order = new Map(DEFAULT_SPEC_SECTIONS.map(([k], i) => [k, i]));
    return this.store
      .all<{ key: string; title: string; body: string; status: SpecSection['status']; version: number; updated_by: string; updated_at: string }>('SELECT * FROM spec_sections')
      .map((r) => ({ key: r.key, title: r.title, body: r.body, status: r.status, version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at }))
      .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  }

  updateSpec(key: string, body: string, actor: string, status: SpecSection['status'] = 'draft', title?: string): SpecSection {
    const existing = this.store.get<{ version: number; title: string }>('SELECT version, title FROM spec_sections WHERE key = ?', [key]);
    const ts = nowIso();
    if (existing) {
      this.store.run('UPDATE spec_sections SET body = ?, status = ?, version = version + 1, updated_by = ?, updated_at = ?, title = ? WHERE key = ?', [
        body,
        status,
        actor,
        ts,
        title ?? existing.title,
        key,
      ]);
    } else {
      this.store.run('INSERT INTO spec_sections (key, title, body, status, version, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', [
        key,
        title ?? key,
        body,
        status,
        actor,
        ts,
      ]);
    }
    const section = this.spec().find((s) => s.key === key)!;
    writeFileSync(join(this.docsDir, 'spec', `${key}.md`), `# ${section.title}\n\n_Status: ${section.status} · v${section.version} · ${section.updatedBy} · ${section.updatedAt}_\n\n${section.body}\n`, 'utf8');
    this.audit.event({ kind: 'spec.updated', title: `Spec updated: ${section.title}`, role: actor, detail: { key, version: section.version } });
    return section;
  }

  // ─── Decisions ─────────────────────────────────────────────────────────────

  addDecision(input: Omit<Decision, 'id' | 'createdAt' | 'updatedAt'>): Decision {
    const d: Decision = { ...input, id: newId('dec'), createdAt: nowIso(), updatedAt: nowIso() };
    this.store.run(
      `INSERT INTO decisions (id, title, context, decision, consequences, status, created_by, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, d.title, d.context, d.decision, d.consequences, d.status, d.createdBy, d.taskId, d.createdAt, d.updatedAt],
    );
    this.writeDecisionFile(d);
    this.audit.event({ kind: 'decision.recorded', title: `Decision: ${d.title}`, role: d.createdBy, taskId: d.taskId, detail: { status: d.status } });
    return d;
  }

  setDecisionStatus(id: string, status: Decision['status']): Decision {
    this.store.run('UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
    const d = this.decisions().find((x) => x.id === id);
    if (!d) throw new Error(`Unknown decision ${id}`);
    this.writeDecisionFile(d);
    return d;
  }

  decisions(): Decision[] {
    return this.store
      .all<{ id: string; title: string; context: string; decision: string; consequences: string; status: Decision['status']; created_by: string; task_id: string | null; created_at: string; updated_at: string }>(
        'SELECT * FROM decisions ORDER BY created_at DESC',
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        context: r.context,
        decision: r.decision,
        consequences: r.consequences,
        status: r.status,
        createdBy: r.created_by,
        taskId: r.task_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  private writeDecisionFile(d: Decision): void {
    const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    writeFileSync(
      join(this.docsDir, 'decisions', `${d.createdAt.slice(0, 10)}-${slug}-${d.id.slice(-6)}.md`),
      `# ${d.title}\n\n- Status: ${d.status}\n- By: ${d.createdBy}\n- Date: ${d.createdAt}\n${d.taskId ? `- Task: ${d.taskId}\n` : ''}\n## Context\n\n${d.context}\n\n## Decision\n\n${d.decision}\n\n## Consequences\n\n${d.consequences}\n`,
      'utf8',
    );
  }

  // ─── Escalations ───────────────────────────────────────────────────────────

  escalate(input: Pick<Escalation, 'kind' | 'title' | 'detail'> & { taskId?: string | null; runId?: string | null; options?: string[] }): Escalation {
    const e: Escalation = {
      id: newId('esc'),
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      options: input.options ?? [],
      status: 'open',
      response: null,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.store.run(
      `INSERT INTO escalations (id, task_id, run_id, kind, title, detail, options, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [e.id, e.taskId, e.runId, e.kind, e.title, e.detail, j(e.options), e.createdAt],
    );
    this.bus.emit('escalation.updated', e);
    this.audit.event({ kind: 'escalation.opened', severity: 'warning', title: `Needs you: ${e.title}`, taskId: e.taskId, runId: e.runId, detail: { kind: e.kind } });
    return e;
  }

  /**
   * What the AI system settled itself in autonomous mode (an approval granted, a question answered, a stuck task
   * handed to the planner): recorded with status `auto_resolved` and how it was settled in `response`, so the
   * Agents page and the timeline keep the history, while nothing ever waits for the user.
   */
  autoResolve(input: Pick<Escalation, 'kind' | 'title' | 'detail'> & { taskId?: string | null; runId?: string | null; options?: string[]; response: string }): Escalation {
    const ts = nowIso();
    const e: Escalation = {
      id: newId('esc'),
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      options: input.options ?? [],
      status: 'auto_resolved',
      response: input.response,
      createdAt: ts,
      resolvedAt: ts,
    };
    this.store.run(
      `INSERT INTO escalations (id, task_id, run_id, kind, title, detail, options, status, response, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto_resolved', ?, ?, ?)`,
      [e.id, e.taskId, e.runId, e.kind, e.title, e.detail, j(e.options), e.response, e.createdAt, e.resolvedAt],
    );
    this.bus.emit('escalation.updated', e);
    this.audit.event({ kind: 'escalation.auto_resolved', severity: 'info', title: `Decided without asking: ${e.title}`, taskId: e.taskId, runId: e.runId, detail: { kind: e.kind, response: e.response } });
    return e;
  }

  /** The decision behind an auto-resolved escalation is now known (or changed): its record and the chat line follow. */
  setAutoResolution(id: string, response: string): Escalation | null {
    const cur = this.escalation(id);
    if (!cur || cur.status !== 'auto_resolved') return cur;
    this.store.run('UPDATE escalations SET response = ?, resolved_at = ? WHERE id = ?', [response, nowIso(), id]);
    const e = this.escalation(id)!;
    this.bus.emit('escalation.updated', e);
    this.audit.event({ kind: 'escalation.auto_resolved', severity: 'info', title: `Decided: ${e.title}`, taskId: e.taskId, runId: e.runId, detail: { kind: e.kind, response } });
    return e;
  }

  resolveEscalation(id: string, status: 'approved' | 'rejected' | 'answered' | 'cancelled', response: string | null): Escalation {
    this.store.run('UPDATE escalations SET status = ?, response = ?, resolved_at = ? WHERE id = ?', [status, response, nowIso(), id]);
    const e = this.escalation(id);
    if (!e) throw new Error(`Unknown escalation ${id}`);
    this.bus.emit('escalation.updated', e);
    this.audit.event({ kind: 'escalation.resolved', title: `Resolved (${status}): ${e.title}`, taskId: e.taskId, role: 'user', detail: { response } });
    return e;
  }

  /**
   * Closes an open card without an answer: it no longer applies, or the user cleared it. Its task is left as it is (an
   * answer would re-queue it). Returns the card, or null when it was not open.
   */
  dismiss(id: string, reason: string, actor: 'user' | 'director' | 'system' = 'system'): Escalation | null {
    const cur = this.escalation(id);
    if (!cur || cur.status !== 'open') return null;
    this.store.run("UPDATE escalations SET status = 'dismissed', response = ?, resolved_at = ? WHERE id = ?", [reason.slice(0, 500), nowIso(), id]);
    const e = this.escalation(id)!;
    this.bus.emit('escalation.updated', e);
    this.audit.event({ kind: 'escalation.dismissed', title: `Card closed: ${e.title}`.slice(0, 300), taskId: e.taskId, role: actor === 'system' ? null : actor, detail: { reason, actor } });
    return e;
  }

  /** Closes every open card of `taskIds` (their task finished, was cancelled or replaced): the cards closed. */
  dismissForTasks(taskIds: string[], reason: string): Escalation[] {
    const ids = new Set(taskIds);
    return this.escalations('open')
      .filter((e) => e.taskId && ids.has(e.taskId))
      .map((e) => this.dismiss(e.id, reason))
      .filter((e): e is Escalation => !!e);
  }

  escalation(id: string): Escalation | null {
    const r = this.store.get<{ id: string; task_id: string | null; run_id: string | null; kind: Escalation['kind']; title: string; detail: string; options: string; status: Escalation['status']; response: string | null; created_at: string; resolved_at: string | null }>(
      'SELECT * FROM escalations WHERE id = ?',
      [id],
    );
    return r
      ? {
          id: r.id,
          taskId: r.task_id,
          runId: r.run_id,
          kind: r.kind,
          title: r.title,
          detail: r.detail,
          options: pj(r.options, []),
          status: r.status,
          response: r.response,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
        }
      : null;
  }

  escalations(status?: Escalation['status']): Escalation[] {
    return this.store
      .all<{ id: string }>(`SELECT id FROM escalations ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 200`, status ? [status] : [])
      .map((r) => this.escalation(r.id)!);
  }
}
