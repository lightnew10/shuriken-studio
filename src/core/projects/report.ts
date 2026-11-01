import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from './project-service';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { AgentRunner } from '../orchestrator/agent-runner';
import { TestService } from '../verification/test-service';

/**
 * Human-readable project report (markdown) written to .shuriken/reports/. It summarizes the project
 * from Shuriken's own records, so the project stays intelligible without the app or any AI session.
 */
export function writeProjectReport(project: ProjectContext, knowledge: KnowledgeService, runner: AgentRunner): string {
  const tasks = project.tasks.list();
  const objectives = tasks.filter((t) => t.kind === 'objective');
  const runs = runner.listRuns(project, { limit: 5000 });
  const tests = new TestService(project.store).list();
  const decisions = project.governance.decisions();
  const spec = project.governance.spec().filter((s) => s.body.trim());
  const cost = runs.reduce((a, r) => a + r.costUsd, 0);
  const byRole = new Map<string, { runs: number; cost: number; turns: number }>();
  for (const r of runs) {
    const e = byRole.get(r.role) ?? { runs: 0, cost: 0, turns: 0 };
    e.runs++;
    e.cost += r.costUsd;
    e.turns += r.numTurns;
    byRole.set(r.role, e);
  }
  const lines: string[] = [];
  const now = new Date();
  lines.push(`# ${project.summary.name} — project report`, '', `Generated ${now.toISOString()} by Shuriken from the project's own records.`, '');
  lines.push('## Summary', '');
  lines.push(`- Objectives: ${objectives.length} (${objectives.filter((o) => o.status === 'done').length} done)`);
  lines.push(`- Tasks: ${tasks.length - objectives.length} (${tasks.filter((t) => t.kind !== 'objective' && t.status === 'done').length} done, ${tasks.filter((t) => t.status === 'proposed').length} proposed, ${tasks.filter((t) => t.status === 'escalated' || t.status === 'blocked').length} waiting on you)`);
  lines.push(`- Agent runs: ${runs.length} · estimated $${cost.toFixed(2)} at API prices`);
  lines.push(`- Tests: ${tests.length} (${tests.filter((t) => t.lastStatus === 'pass').length} passing, ${tests.filter((t) => t.lastStatus === 'fail').length} failing)`);
  lines.push(`- Decisions: ${decisions.length} · Spec sections written: ${spec.length}`);
  lines.push('');
  for (const o of objectives) {
    lines.push(`## Objective: ${o.title} [${o.status}]`, '', o.objective.split('\n')[0] ?? '', '');
    const kids = tasks.filter((t) => t.parentId === o.id && t.status !== 'proposed');
    if (kids.length) {
      lines.push('| Task | Role | Status | Attempts | Evidence |', '|---|---|---|---|---|');
      for (const k of kids) {
        const ev = project.tasks.evidence(k.id);
        const ok = ev.filter((e) => e.passed === true).length;
        const bad = ev.filter((e) => e.passed === false).length;
        lines.push(`| ${k.title.replace(/\|/g, '/')} | ${k.role} | ${k.status} | ${k.attempts}/${k.maxAttempts} | ${ok} passed, ${bad} failed |`);
      }
      lines.push('');
    }
    if (o.result) lines.push('**Result**', '', o.result, '');
    const proposals = tasks.filter((t) => t.parentId === o.id && t.status === 'proposed');
    if (proposals.length) {
      lines.push('**Proposed follow-ups (not started)**', '');
      for (const p of proposals) lines.push(`- ${p.title}`);
      lines.push('');
    }
  }
  lines.push('## Agents', '', '| Role | Runs | Turns | Est. cost |', '|---|---|---|---|');
  for (const [role, e] of [...byRole].sort((a, b) => b[1].cost - a[1].cost)) lines.push(`| ${role} | ${e.runs} | ${e.turns} | $${e.cost.toFixed(2)} |`);
  lines.push('');
  if (decisions.length) {
    lines.push('## Decisions', '');
    for (const d of decisions) lines.push(`- **${d.title}** [${d.status}] — ${d.decision.split('\n')[0]!.slice(0, 240)}`);
    lines.push('');
  }
  if (tests.length) {
    lines.push('## Tests', '', '| Test | Kind | Last result |', '|---|---|---|');
    for (const t of tests) lines.push(`| ${t.name.replace(/\|/g, '/')} | ${t.kind} | ${t.lastStatus ?? '—'} |`);
    lines.push('');
  }
  const learned = knowledge.search({ scopes: ['project'], limit: 40 });
  if (learned.length) {
    lines.push('## What the project knows', '');
    for (const k of learned) lines.push(`- [${k.category}, conf ${k.confidence.toFixed(2)}${k.validatedAt ? ', validated' : ''}] **${k.title}**`);
    lines.push('');
  }
  const dir = join(project.dir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `report-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}
