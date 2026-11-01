import { z } from 'zod';
import { placePath, type ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import { TestService, checkName } from '../verification/test-service';
import { UiStore, uiOutline } from '../ui/ui-workshop';
import { mimeForPath } from '../util/mime';
import { placeLinkLines, readPlaceLink, type PlaceLink } from '../director/place-link';
import { jsonOutput, textOutput, type ToolRegistry } from './tool-registry';

export interface DirectorToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  /** Which Studio window the project is linked to (director/place-link.ts); built after the tools. */
  placeLink: () => PlaceLink | null;
  /** The place has changes Studio hasn't saved yet. */
  unsaved: () => boolean;
}

const EVIDENCE_KINDS = ['test_result', 'screenshot', 'console', 'diff', 'datamodel_snapshot', 'critic_review', 'static_analysis', 'note'] as const;
/** Evidence that is bookkeeping (file lists, script names), left out of a search unless its kind is asked for. */
const NOISE_KINDS = ['diff', 'datamodel_snapshot'];
const SYNC_NOTE = 'Code sync into Studio';

const like = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters]` : s);

/** The part of an evidence's data around the first of `words` (or its start), as one line. */
function excerpt(data: string | null, words: readonly string[], max = 320): string {
  if (!data || data === 'null') return '';
  const lower = data.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - 80);
  return `${from > 0 ? '…' : ''}${data.slice(from, from + max).replace(/\\n/g, ' ').replace(/\s+/g, ' ')}${from + max < data.length ? '…' : ''}`;
}

/**
 * The director's read-only look at the project: what the tasks proved, how the tests last ran, what the system
 * decided without asking, which Studio window the project is linked to, and the last UI audit. Nothing here
 * changes the game, the plan or Studio; they are visible to the director only (its looking pass, see
 * director/look.ts), so the workers' tool lists don't grow.
 */
export function registerDirectorTools(reg: ToolRegistry, d: DirectorToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const roles = ['director'];

  reg.register({
    name: 'evidence_search',
    title: 'Search the evidence',
    description:
      "Find what the tasks proved. Every task's recorded evidence (test results and measurements, the console of its playtests, the critic's review, notes, screenshots) is searched by words: each word must appear in the evidence's title, its data or its task's title. Returns the newest matches with their task, whether they passed and an excerpt around the words. evidence_view shows one in full (a screenshot comes back as a picture). File lists (kinds diff and datamodel_snapshot) are left out unless you ask for that kind.",
    capability: 'app.tasks',
    permission: 'read',
    roles,
    input: {
      query: z.string().optional().describe('Words to look for, e.g. "phone", "ProfileStore", "844x390"'),
      kind: z.enum(EVIDENCE_KINDS).optional(),
      task: z.string().optional().describe("Only this task: its id, or words of its title"),
      failed_only: z.boolean().optional().describe('Only evidence recorded as not passed'),
      limit: z.number().int().min(1).max(40).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      const where: string[] = [];
      const params: (string | number)[] = [];
      for (const w of words) {
        where.push("(e.title LIKE ? ESCAPE '\\' OR e.data LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')");
        params.push(like(w), like(w), like(w));
      }
      if (args.kind) {
        where.push('e.kind = ?');
        params.push(args.kind);
      } else {
        where.push(`e.kind NOT IN (${NOISE_KINDS.map(() => '?').join(', ')})`, 'e.title != ?');
        params.push(...NOISE_KINDS, SYNC_NOTE);
      }
      if (args.task?.trim()) {
        const ref = args.task.trim();
        const parts = ref.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
        where.push(`(t.id = ? OR (${parts.map(() => "t.title LIKE ? ESCAPE '\\'").join(' AND ')}))`);
        params.push(ref, ...parts.map(like));
      }
      if (args.failed_only) where.push('e.passed = 0');
      const limit = args.limit ?? 20;
      const rows = p.store.all<{ id: string; task_id: string; kind: string; title: string; passed: number | null; data: string | null; path: string | null; created_at: string; task: string; total: number }>(
        `SELECT e.id, e.task_id, e.kind, e.title, e.passed, e.data, e.path, e.created_at, t.title AS task, count(*) OVER () AS total
         FROM task_evidence e JOIN tasks t ON t.id = e.task_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
        [...params, limit],
      );
      const total = rows[0]?.total ?? 0;
      return jsonOutput(
        rows.map((r) => ({
          id: r.id,
          task: r.task,
          taskId: r.task_id,
          kind: r.kind,
          title: r.title,
          passed: r.passed == null ? null : r.passed === 1,
          at: r.created_at,
          ...(r.path && mimeForPath(r.path) ? { picture: true } : {}),
          ...(excerpt(r.data, words) ? { excerpt: excerpt(r.data, words) } : {}),
        })),
        total ? `${total} piece${total === 1 ? '' : 's'} of evidence match${total === 1 ? 'es' : ''}${total > rows.length ? `; the newest ${rows.length} are shown (narrow the words, or raise limit)` : ''}.` : 'No evidence matches. Try fewer or other words (a task title, a check name, a word from the console).',
      );
    },
  });

  reg.register({
    name: 'test_results',
    title: 'Test results',
    description:
      "How the project's regression tests last ran: the totals (passed, failed, never run, retired), and for each test its check, the task it came from, its last status and when, and what it last printed. test: one test by id, registered name or check name (its full last output), or words of a name or task title. failing_only: just the failures. Tests are the tasks' own automated checks, kept and run again in full before a goal closes.",
    capability: 'app.tests',
    permission: 'read',
    roles,
    input: {
      test: z.string().optional().describe('A test id, registered name, check name, or words of a test or task title'),
      failing_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(60).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const svc = new TestService(p.store);
      const all = svc.list().map((t) => ({ t, task: t.taskId ? p.tasks.get(t.taskId) : null }));
      const live = all.filter(({ t }) => t.enabled && !t.retiredAt);
      const failed = (s: string | null) => s === 'fail' || s === 'error';
      const totals = {
        on: live.length,
        passed: live.filter(({ t }) => t.lastStatus === 'pass').length,
        failed: live.filter(({ t }) => failed(t.lastStatus)).length,
        neverRun: live.filter(({ t }) => !t.lastStatus).length,
        retired: all.length - live.length,
        lastRunAt: all.reduce<string | null>((m, { t }) => (t.lastRunAt && (!m || t.lastRunAt > m) ? t.lastRunAt : m), null),
      };
      let rows = all;
      const ref = args.test?.trim();
      if (ref) {
        const found = new Set(svc.find(ref).map((t) => t.id));
        const words = ref.toLowerCase().split(/\s+/).filter(Boolean);
        rows = found.size ? all.filter(({ t }) => found.has(t.id)) : all.filter(({ t, task }) => words.every((w) => `${t.name} ${checkName(t.spec)} ${task?.title ?? ''}`.toLowerCase().includes(w)));
      }
      if (args.failing_only) rows = rows.filter(({ t }) => failed(t.lastStatus));
      // Failures first, then what never ran, then the rest: the head of a long list is what matters.
      const rank = (s: string | null) => (failed(s) ? 0 : !s ? 1 : 2);
      rows = [...rows].sort((a, b) => rank(a.t.lastStatus) - rank(b.t.lastStatus));
      const shown = rows.slice(0, args.limit ?? 30);
      const one = shown.length === 1;
      const tests = shown.map(({ t, task }) => {
        const last = p.store.get<{ status: string; output: string; duration_ms: number; created_at: string }>('SELECT status, output, duration_ms, created_at FROM test_results WHERE test_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [t.id]);
        return {
          id: t.id,
          check: checkName(t.spec),
          kind: t.spec.kind,
          task: task ? { title: task.title, status: task.status } : null,
          lastStatus: t.lastStatus,
          lastRunAt: t.lastRunAt,
          ...(t.retiredAt ? { retired: { reason: t.retiredReason, by: t.retiredBy, at: t.retiredAt } } : t.enabled ? {} : { switchedOff: true }),
          ...(last ? { lastOutput: clip(last.output, one ? 4000 : failed(last.status) ? 600 : 160), seconds: Math.round(last.duration_ms / 100) / 10 } : {}),
        };
      });
      return jsonOutput(
        { totals, tests },
        `${totals.on} tests on: ${totals.passed} passed, ${totals.failed} failed, ${totals.neverRun} never run; ${totals.retired} retired or switched off.${rows.length > shown.length ? ` Showing ${shown.length} of ${rows.length}.` : ''}`,
      );
    },
  });

  reg.register({
    name: 'decided_list',
    title: 'Decided without asking',
    description:
      "What the AI system settled for the user without asking them (autonomous mode): each question, approval or stuck task it decided, how it decided and when, newest first; the commands and tool calls it approved by itself; and the design decisions the planner recorded. The user sees the first list on the Agents page as \"Decided without asking\".",
    capability: 'app.project',
    permission: 'read',
    roles,
    input: { limit: z.number().int().min(1).max(60).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const limit = args.limit ?? 25;
      const settled = p.governance.escalations('auto_resolved');
      const approved = p.store.all<{ ts: string; title: string }>("SELECT ts, title FROM events WHERE kind = 'policy.auto_approved' ORDER BY ts DESC LIMIT ?", [limit]);
      const designs = p.governance.decisions();
      const newest = [...settled].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return jsonOutput(
        {
          decided: newest.slice(0, limit).map((e) => ({ at: e.createdAt, kind: e.kind, about: e.title, decision: clip(e.response ?? '', 600), task: (e.taskId && p.tasks.get(e.taskId)?.title) || null })),
          autoApproved: approved.map((e) => ({ at: e.ts, what: e.title.replace(/^Auto-approved:\s*/, '') })),
          designDecisions: designs.slice(0, limit).map((x) => ({ at: x.createdAt, title: x.title, decision: clip(x.decision, 400), by: x.createdBy, status: x.status })),
        },
        `${settled.length} settled without asking, ${approved.length} auto-approved action${approved.length === 1 ? '' : 's'} (latest ${limit} at most), ${designs.length} recorded design decision${designs.length === 1 ? '' : 's'}.`,
      );
    },
  });

  reg.register({
    name: 'studio_place',
    title: 'Studio and the place',
    description:
      "Roblox Studio's state for this project, read now: whether Studio is connected, which places it has open, which window the project is linked to and whether that is the project's place file, a recovery copy of it or nothing, what that means for saving, when the place file was last saved, whether the place has unsaved changes, and whether Studio is in Edit or Play mode. Reads only.",
    capability: 'roblox.app.status',
    permission: 'roblox_read',
    roles,
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const p = proj();
      const link = d.placeLink();
      const facts =
        (await link?.check()) ??
        readPlaceLink({ placeFile: placePath(p), match: p.settings().robloxStudioMatch ?? null, binding: d.studio.binding, connected: d.studio.connected, studios: d.studio.connected ? await d.studio.listStudios().catch(() => null) : null });
      // Studio answers one request at a time: a busy Studio must not hold the answer up.
      let mode: string = 'unknown (Studio is not connected to the linked place)';
      if (d.studio.connected && (facts.kind === 'linked' || (facts.kind === 'recovery' && facts.binding === facts.recoveries[0]))) {
        const st = await Promise.race([d.studio.state().catch((e: unknown) => String((e as Error)?.message ?? e)), new Promise<'busy'>((r) => setTimeout(() => r('busy'), 4000).unref())]);
        mode = st === 'busy' ? 'Studio is busy answering another request right now (an agent is using it)' : typeof st === 'string' ? `could not be read (${st.slice(0, 200)})` : `${st.mode ?? 'unknown'} (DataModels: ${st.availableDataModels.join(', ') || 'none'})`;
      }
      const playtest = d.lease.describe();
      return jsonOutput(
        {
          connected: facts.kind !== 'offline',
          openInStudio: facts.open,
          placeFile: facts.placeFile,
          linkedTo: facts.binding,
          link: facts.kind,
          recoveryCopies: facts.recoveries,
          mode,
          playtest,
          unsavedChanges: d.unsaved(),
          autoSave: link?.onRecovery ? 'off while linked to a recovery copy' : 'on when the user has it on (through Studio\'s File menu in the place file\'s window, after verified work, and every 20 minutes while agents work)',
        },
        placeLinkLines(facts, { playtest }).join('\n'),
      );
    },
  });

  reg.register({
    name: 'ui_snapshot',
    title: 'The last UI audit',
    description:
      "The game's UI as it was last read from Studio (by a ui_audit or the UI panel): when and from where (StarterGui, or a playing client's PlayerGui for UI that scripts build), every ScreenGui, where its top elements land on a phone (844x390) and on a desktop, and the findings: elements off the screen, buttons too small to tap or covering each other, text too small or cut off. Reads what is saved; it does not touch Studio. When it is old or missing, say so: a fresh audit is a job for the UI engineer.",
    capability: 'app.project',
    permission: 'read',
    roles,
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const snap = new UiStore(proj().root).get();
      if (!snap) return textOutput('No UI audit has been saved for this project yet (nobody ran ui_audit, and the UI panel was never opened with Studio connected).');
      const problems = snap.findings.filter((f) => f.severity === 'problem').length;
      return jsonOutput(
        { capturedAt: snap.capturedAt, source: snap.source, truncated: snap.truncated, screens: snap.screens.map((s) => ({ name: s.name, enabled: s.enabled !== false })), outline: uiOutline(snap, 60), findings: snap.findings.slice(0, 40) },
        `Read ${new Date(snap.capturedAt).toLocaleString()} from ${snap.source}: ${snap.screens.length} screen(s), ${problems} problem(s), ${snap.findings.length - problems} warning(s).`,
      );
    },
  });
}
