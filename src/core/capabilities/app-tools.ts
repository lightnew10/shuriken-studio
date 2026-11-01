import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compactStoreResults } from '../roblox/store-search';
import { join } from 'node:path';
import { z } from 'zod';
import type { VerificationMethod } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { SkillService } from '../skills/skill-service';
import type { CapabilityRegistry } from './capability-registry';
import { runAgentLuau, ScreenshotUnavailableError, STUDIO_NOT_DRAWING, type RobloxStudioAdapter, type DataModelType } from '../roblox/studio-adapter';
import { mapAuditLuau, mapFindings, type MapAudit } from '../roblox/map-audit';
import { filesEditedBy, filesInFlight, planSync, type CodeSync } from '../roblox/code-sync';
import { compileProblems } from '../verification/compile-limits';
import { openReopen } from '../orchestrator/reopen';
import type { LuauToolchain } from '../roblox/luau-toolchain';
import type { ShurikenMcpServer } from '../mcp/mcp-server';
import type { Mutex } from '../util/mutex';
import { PLAYTEST_LIMITS, type PlaytestLease } from '../roblox/playtest-lease';
import type { OpenCloudLuau } from '../roblox/open-cloud-luau';
import type { EventBus } from '../events';
import { TestService, checkName, testName } from '../verification/test-service';
import { playsStudio } from '../verification/verifier';
import { PROBE_AMENDED, checkLabel, probeAmendments, retireOwnTests, splitChecks, type ProbeAmendment } from '../verification/check-edits';
import { isEmptyProbe, lintCheck, lintChecks, probesOf } from '../verification/probe-lint';
import { normalizeVerification } from '../orchestrator/orchestrator';
import { DECIDE_YOURSELF, type AutonomyHooks } from '../orchestrator/autonomy';
import { needsOwner } from '../permissions/owner-gate';
import { HANDS_ANSWER, needsUserHands, aboutStudioTurn, STUDIO_TURN_ANSWER } from '../permissions/user-hands';
import { TERMINAL } from '../tasks/task-graph';
import { LUAU_LOG_ERRORS, type VerificationReport, type Verifier } from '../verification/verifier';
import { errorOutput, jsonOutput, textOutput, type CallerContext, type ToolContent, type ToolRegistry } from './tool-registry';
import { truncate } from '../context/context-compiler';
import { extFor, mimeForPath } from '../util/mime';
import { AssetService, analysisSummary, type AssetRecord } from '../assets/asset-service';
import { AssetCapture, parseAssetResult, watchRoots } from '../assets/asset-capture';
import { LUAU_ASSET_CLONE } from '../roblox/luau-snippets';
import { CharacterHistory, awaitCharacterLuau, characterLine, type CharacterWait } from '../roblox/playtest-character';
import { fillStudioArgs, needsStudioMode } from '../roblox/studio-call-args';

/**
 * A playtest an agent drives by hand ("start") is refused while this many others use or wait for Studio: it holds play
 * mode across several turns of the agent for all of them. In the 1.14 RTS build four UI designers opened five hand
 * sessions in ten minutes while check runs waited up to ten.
 */
export const HAND_START = { busyAt: 2 };

/** A playtest of the same place right after the caller's previous one is pointed out when it comes within this. */
export const REPLAY_NOTE = { withinMs: 10 * 60_000 };

/**
 * How long a roblox_playtest call will hold Studio, roughly, for the line (shortest first: LINE_ORDER): starting and
 * stopping (about 5 s), the game time it lets pass, its probes and pictures. A session driven by hand ("start") holds
 * it as long as an agent's playtest may when others wait.
 */
export function playtestTurnMs(args: { action?: string; seconds?: number; luau?: string; client_luau?: string; screenshot?: boolean; steps?: Array<{ luau?: string; client_luau?: string; keys?: Array<Record<string, unknown>>; mouse?: Array<Record<string, unknown>>; wait?: number; screenshot?: boolean }> }): number {
  if (args.action === 'start') return 90_000;
  let ms = 5000 + (args.seconds ?? 3) * 1000 + (args.luau ? 1000 : 0) + (args.client_luau ? 1000 : 0) + (args.screenshot ? 2000 : 0);
  for (const st of args.steps ?? []) {
    ms += (st.luau ? 1000 : 0) + (st.client_luau ? 1000 : 0) + (st.screenshot ? 2000 : 0) + (st.wait ?? 0) * 1000;
    for (const k of [...(st.keys ?? []), ...(st.mouse ?? [])]) ms += typeof k.wait_time_ms === 'number' ? k.wait_time_ms : 50;
  }
  return Math.round(ms);
}

export interface AppToolDeps {
  project: () => ProjectContext | null;
  knowledge: KnowledgeService;
  skills: SkillService;
  capabilities: CapabilityRegistry;
  studio: RobloxStudioAdapter;
  sync: CodeSync;
  luau: LuauToolchain;
  mcp: () => ShurikenMcpServer | null;
  studioLock: Mutex;
  lease: PlaytestLease;
  cloud: OpenCloudLuau;
  bus: EventBus;
  /** The verifier, for a worker's rehearsal of its task's checks (task_run_checks); it is built after the tools. */
  verifier?: () => Verifier;
  /** Autonomous permission mode (orchestrator/autonomy.ts): absent = 'ask', the user answers questions and approves spec changes. */
  autonomy?: AutonomyHooks;
}

/**
 * A JSON Schema without the noise, short enough to hand back in an error. A long list of allowed values is cut to
 * its first few: the 250 key codes of user_keyboard_input used up the whole hint, and the arguments the call had
 * got wrong (datamodel_type, wait_time_ms) came after the cut.
 */
export function compactSchema(schema: unknown, max = 2500): string {
  const text = JSON.stringify(schema, (k, v) => {
    if (k === '$schema' || k === 'additionalProperties' || (k === 'studio_id' && typeof v === 'object')) return undefined;
    if (k === 'enum' && Array.isArray(v) && v.length > 12) return [...v.slice(0, 8), `… ${v.length - 8} more`];
    return v;
  });
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const authority = z.enum(['official', 'staff', 'community', 'observed', 'inference', 'user']);
const dataModel = z.enum(['Edit', 'Server', 'Client']);

/**
 * The longest fixed wait (task.wait / wait / task.delay / delay with a literal) in agent Luau. Studio
 * runs one request at a time for every agent, so a sleep inside Studio stalls everyone's Studio work
 * (in the logged runs a critic slept 90 s twice, and a plain property read queued behind it for 129 s).
 */
export function longestSleep(code: string): number {
  let max = 0;
  for (const m of code.matchAll(/\b(?:task\.)?(?:wait|delay)\s*\(\s*(\d+(?:\.\d+)?)/g)) max = Math.max(max, Number(m[1]));
  return max;
}
/** Longest fixed wait allowed in Studio: Edit work never needs one; probes during play wait for things. */
const SLEEP_LIMIT = { Edit: 5, Server: 20, Client: 20 } as const;
/** Pictures one roblox_screenshot call may take in its one turn. */
const SHOTS_PER_CALL = 6;
/** How much one roblox_playtest "run" may carry: the whole plan of a check, in one hold of Studio. */
const RUN_STEPS = { max: 16, shots: 4 };
/** What agents are told about the play-time limits (see PLAYTEST_LIMITS in roblox/playtest-lease.ts). */
const PLAY_TIME_BOX = `every playtest (a "run" too) plays at most ${Math.round(PLAYTEST_LIMITS.playMs / 1000)} s once it is up (loading the place into play is not counted) and is then stopped, with no extension; one with no Studio calls for ${Math.round(PLAYTEST_LIMITS.idleMs / 1000)} s is stopped sooner when others wait`;

export { filesInFlight };

/**
 * High-value tools Shuriken exposes to agents over MCP (and to the UI). Each maps to a capability id
 * so reliability is tracked, and each declares a permission class the policy engine enforces.
 */
export function registerAppTools(reg: ToolRegistry, d: AppToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const studioAvail = () => d.studio.availability();
  /**
   * Edit-mode work is impossible while someone else's playtest owns Studio. Playtests are short, so
   * wait for it to end (the adapter waits, with progress notes, up to STUDIO_WAIT.maxMs: this call runs
   * inside the tool call, so it knows whose it is) and only fail if it runs very long, saying who holds it.
   */
  const editBlocked = async (_caller: CallerContext, datamodel: string = 'Edit', _signal?: AbortSignal) => {
    if (datamodel !== 'Edit') return null;
    const w = await d.studio.waitForLease();
    return w.ok ? null : errorOutput(w.message);
  };
  const busyNow = (caller: CallerContext) => {
    const h = d.lease.holder;
    return !!h && h.owner !== caller.runId;
  };
  /** A Studio call from the play-mode holder keeps its playtest alive (see the core's lease watchdog). */
  const active = (caller: CallerContext) => d.lease.touch(caller.runId);
  /** The caller's hand-started playtest was stopped for others (past its time box, or idle while they waited). */
  const reclaimedNote = (caller: CallerContext): string | null => {
    if (!caller.runId || !d.lease.reclaimed.has(caller.runId)) return null;
    const why = d.lease.reclaimReasons.get(caller.runId);
    d.lease.reclaimed.delete(caller.runId);
    d.lease.reclaimReasons.delete(caller.runId);
    if (why === 'crash') return 'Your playtest is gone: Roblox Studio closed under it and Shuriken reopened the place. Play it again (one roblox_playtest "run" with the whole check) when you need it.';
    if (why === 'freed') return 'Your playtest was stopped: the user freed Studio for the others. Play it again (one roblox_playtest "run" with the whole check) when you need it.';
    const cause = why === 'long' ? `it ran past its time box (${PLAY_TIME_BOX})` : `it went ${Math.round(PLAYTEST_LIMITS.idleMs / 1000)} s without Studio calls while other agents waited for Studio`;
    return `Your playtest was stopped so other agents could use Studio: ${cause}. Plan the whole check first and play it in one call: roblox_playtest action "run" with steps (probes, key presses, waits and screenshots in order, all within ${Math.round(PLAYTEST_LIMITS.playMs / 1000)} s of play); it plays, does them, collects errors and stops.`;
  };
  const taskOf = (caller: CallerContext, explicit?: string | null) => explicit ?? caller.taskId;
  const assets = new AssetCapture(d.studio);

  // ─── Project state ────────────────────────────────────────────────────────

  reg.register({
    name: 'project_overview',
    title: 'Project overview',
    description: 'Summary of the open project: objectives, task status counts, integrations health, source layout.',
    capability: 'app.project',
    permission: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const p = proj();
      const tasks = p.tasks.list();
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      const objectives = tasks.filter((t) => t.kind === 'objective').map((t) => ({ id: t.id, title: t.title, status: t.status }));
      const unhealthy = d.capabilities.list().filter((c) => c.status !== 'healthy').map((c) => `${c.id}: ${c.status}`);
      return jsonOutput({ name: p.summary.name, root: p.root, objectives, taskCounts: counts, syncMap: p.extras().syncMap, syncMode: p.extras().syncMode, unhealthyCapabilities: unhealthy.slice(0, 40) });
    },
  });

  reg.register({
    name: 'task_list',
    title: 'List tasks',
    description: 'List project tasks, optionally filtered by status.',
    capability: 'app.tasks',
    permission: 'read',
    input: { statuses: z.array(z.string()).optional(), parent_id: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const tasks = proj().tasks.list({ statuses: args.statuses as never, parentId: args.parent_id });
      return jsonOutput(tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, role: t.role, status: t.status, dependencies: t.dependencies, attempts: t.attempts })));
    },
  });

  reg.register({
    name: 'task_get',
    title: 'Get task',
    description: 'Full task record with dependencies, evidence and failures. Defaults to your current task.',
    capability: 'app.tasks',
    permission: 'read',
    input: { id: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller }) => {
      const id = taskOf(caller, args.id);
      if (!id) return errorOutput('No task id given and the caller has no current task');
      const p = proj();
      const t = p.tasks.get(id);
      if (!t) return errorOutput(`Unknown task ${id}`);
      return jsonOutput({
        ...t,
        evidence: p.tasks.evidence(id).map((e) => ({ id: e.id, kind: e.kind, title: e.title, passed: e.passed, hasFile: !!e.path })),
        failures: p.tasks.failures(id),
      });
    },
  });

  reg.register({
    name: 'task_add_evidence',
    title: 'Record evidence',
    description: 'Record verification evidence for your task (test output, observations). Evidence is what reviewers judge.',
    capability: 'app.tasks',
    permission: 'write_project',
    input: {
      kind: z.enum(['test_result', 'console', 'note', 'static_analysis']),
      title: z.string().min(3),
      passed: z.boolean().nullable().optional(),
      data: z.unknown().optional(),
      task_id: z.string().optional(),
    },
    handler: async ({ args, caller }) => {
      const id = taskOf(caller, args.task_id);
      if (!id) return errorOutput('No task to attach evidence to');
      const ev = proj().tasks.addEvidence({ taskId: id, runId: caller.runId, kind: args.kind, title: args.title, passed: args.passed ?? null, data: args.data ?? null, path: null });
      return textOutput(`Evidence recorded (${ev.id})`, { id: ev.id });
    },
  });

  reg.register({
    name: 'evidence_view',
    title: 'View evidence',
    description: 'View a piece of task evidence by id. Screenshots are returned as images.',
    capability: 'app.tasks',
    permission: 'read',
    input: { id: z.string(), task_id: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const row = p.store.get<{ task_id: string }>('SELECT task_id FROM task_evidence WHERE id = ?', [args.id]);
      const ev = row ? p.tasks.evidence(row.task_id).find((e) => e.id === args.id) : undefined;
      if (!ev) return errorOutput(`Unknown evidence ${args.id}`);
      // Studio's screenshots are JPEG (extFor): any picture comes back as a picture.
      const mime = ev.path ? mimeForPath(ev.path) : null;
      if (ev.path && mime && existsSync(ev.path)) {
        return { content: [{ type: 'text', text: `${ev.title}\n${JSON.stringify(ev.data)}` }, { type: 'image', data: readFileSync(ev.path).toString('base64'), mimeType: mime }], data: { id: ev.id } };
      }
      return jsonOutput(ev);
    },
  });

  reg.register({
    name: 'map_preview',
    title: 'Look at the map',
    description:
      "See what the game looks like: the newest screenshots agents took of it (newest first, with what each shows and when), and with live the Studio viewport as it is right now (the camera isn't moved). For judging progress and giving visual feedback.",
    capability: 'app.tasks',
    permission: 'read',
    input: { count: z.number().int().min(1).max(4).optional(), live: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller }) => {
      const p = proj();
      const rows = p.store.all<{ id: string; task_id: string; title: string; path: string; created_at: string }>(
        "SELECT id, task_id, title, path, created_at FROM task_evidence WHERE kind = 'screenshot' AND path IS NOT NULL ORDER BY created_at DESC LIMIT 16",
      );
      const content: ToolContent[] = [];
      const ago = (iso: string) => {
        const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
        return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
      };
      for (const r of rows.filter((x) => existsSync(x.path)).slice(0, args.count ?? 3)) {
        const task = p.tasks.get(r.task_id);
        content.push({ type: 'text', text: `${r.title} — from "${task?.title ?? 'a task'}", ${ago(r.created_at)}` });
        content.push({ type: 'image', data: readFileSync(r.path).toString('base64'), mimeType: mimeForPath(r.path) ?? 'image/png' });
      }
      if (args.live) {
        if (!d.studio.connected) content.push({ type: 'text', text: 'Live view unavailable: Studio is not connected.' });
        else if (busyNow(caller)) content.push({ type: 'text', text: 'Live view skipped: an agent is playtesting right now.' });
        else {
          const shot = await d.studio.screenshot({}).catch(() => null);
          if (shot) content.push({ type: 'text', text: 'Live: the Studio viewport right now' }, { type: 'image', data: shot.data, mimeType: shot.mimeType });
          else content.push({ type: 'text', text: 'Live view unavailable (Studio returned no image; the display may be off).' });
        }
      }
      if (!content.length) return textOutput('No screenshots yet: agents take them as they build and check the world.');
      return { content };
    },
  });

  reg.register({
    name: 'test_register',
    title: 'Register permanent test',
    description:
      'Register a durable test that joins the regression suite: a luau_assert returning PASS/FAIL (datamodel "edit", or "server"/"client" for one run in a short playtest), or a playtest (luau: a probe on the server; client_luau: a probe on the player\'s client, where LocalPlayer, PlayerGui, the camera and FireServer exist). A probe that uses what only the other side has is refused.',
    capability: 'app.tests',
    permission: 'write_project',
    input: {
      name: z.string().min(3),
      kind: z.enum(['luau_assert', 'playtest']),
      luau: z.string().optional(),
      client_luau: z.string().optional().describe('playtest: a probe run in the Client DataModel'),
      datamodel: z.enum(['edit', 'server', 'client']).optional(),
      duration_sec: z.number().optional(),
    },
    handler: async ({ args, caller }) => {
      let method: VerificationMethod;
      if (args.kind === 'luau_assert') {
        if (!args.luau) return errorOutput('luau is required for luau_assert');
        method = { kind: 'luau_assert', name: args.name, luau: args.luau, datamodel: args.datamodel ?? 'edit' };
      } else method = { kind: 'playtest', name: args.name, durationSec: args.duration_sec ?? 10, luau: args.luau, ...(args.client_luau?.trim() ? { clientLuau: args.client_luau } : {}), failOnConsoleErrors: true };
      // A probe on the wrong side can never pass: refused here, with where it belongs.
      const refused = lintCheck(method);
      if (refused) return errorOutput(refused);
      const t = new TestService(proj().store).register({ name: args.name, method, taskId: caller.taskId });
      return textOutput(`Test registered: ${t.name} (${t.id})`, { id: t.id });
    },
  });

  reg.register({
    name: 'test_list',
    title: 'List regression tests',
    description:
      "List the project's registered regression tests: id, registered name, the check's own name, the task that registered it, last result and, for a retired one, why. Use it to find the test a failure or a contradiction between two checks is about.",
    capability: 'app.tests',
    permission: 'read',
    input: {
      query: z.string().optional().describe("Only tests whose name, check name or task title contains this"),
      failing_only: z.boolean().optional(),
      include_retired: z.boolean().optional().describe('Also list retired tests (default: only the ones that still run)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const q = args.query?.trim().toLowerCase();
      const rows = new TestService(p.store)
        .list()
        .filter((t) => (args.include_retired ? true : !t.retiredAt && t.enabled))
        .filter((t) => !args.failing_only || t.lastStatus === 'fail')
        .map((t) => ({ t, task: t.taskId ? p.tasks.get(t.taskId) : null }))
        .filter(({ t, task }) => !q || `${t.name} ${checkName(t.spec)} ${task?.title ?? ''}`.toLowerCase().includes(q));
      return jsonOutput(
        rows.slice(0, 100).map(({ t, task }) => ({
          id: t.id,
          name: t.name,
          check: checkName(t.spec),
          kind: t.spec.kind,
          task: task ? { id: task.id, title: task.title, status: task.status } : null,
          lastStatus: t.lastStatus,
          enabled: t.enabled,
          ...(t.retiredAt ? { retired: { reason: t.retiredReason, by: t.retiredBy, at: t.retiredAt } } : {}),
        })),
      );
    },
  });

  reg.register({
    name: 'test_retire',
    title: 'Retire a regression test',
    description:
      "Retire a regression test that no longer applies: it tests work that was replaced or dropped, encodes an assumption the current design deliberately changed, or contradicts another check so no state of the game can pass both. It stops running in the regression suite and the tasks that reference it skip it. The reason is recorded on the timeline and on your task, so make it specific (which design change or which other check). test: the test id, its registered name, or the check's own name (\"road_not_green\": every test with that check). Never retire a test only because it fails: fix the game, or explain what is wrong with the test.",
    capability: 'app.tests',
    permission: 'write_project',
    input: {
      test: z.string().min(2).describe("Test id, registered name, or the check's own name"),
      reason: z.string().min(15).describe('Why the test no longer applies (recorded)'),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const svc = new TestService(p.store);
      const found = svc.find(args.test);
      if (!found.length) return errorOutput(`No test matches "${args.test}". test_list shows the registered tests: pass an id, a registered name, or a check's own name.`);
      const by = caller.role ?? 'agent';
      const retired = found.filter((t) => !t.retiredAt).map((t) => svc.retire(t.id, `${args.reason} (retired by ${by})`, by)).filter((t): t is NonNullable<typeof t> => !!t);
      if (!retired.length) return textOutput(`Already retired: ${found.map((t) => t.name).join(', ')}.`);
      const label = [...new Set(retired.map((t) => checkName(t.spec)))].join(', ');
      p.audit.event({
        kind: 'test.retired',
        severity: 'info',
        title: `Retired regression test ${label}: ${args.reason}`.slice(0, 300),
        taskId: caller.taskId,
        runId: caller.runId,
        role: by,
        detail: { reason: args.reason, tests: retired.map((t) => ({ id: t.id, name: t.name, task: t.taskId })) },
      });
      if (caller.taskId && p.tasks.get(caller.taskId)) {
        p.tasks.addEvidence({ taskId: caller.taskId, runId: caller.runId, kind: 'note', title: `Retired regression test ${label}`, passed: null, data: { reason: args.reason, tests: retired.map((t) => t.name) }, path: null });
      }
      return textOutput(`Retired ${retired.length} test${retired.length === 1 ? '' : 's'}: ${retired.map((t) => t.name).join(', ')}. They no longer run in the suite.`, { retired: retired.map((t) => t.id) });
    },
  });

  reg.register({
    name: 'task_update_verification',
    title: "Change a task's checks",
    description:
      "Change the automated checks of a task that is not finished: remove checks (by the check's name or a test id) and/or add new ones (the same shapes as plan_add_task's verification). Use it when a check contradicts the current design or another task's check, so the task can be verified against what is actually wanted. Static analysis and the critic always stay. A removed check's registered test (the one that task registered) is retired with your reason; a reference to someone else's test is only dropped from this task (retire that test with test_retire if it is wrong). The reason is recorded on the timeline and on the task.",
    capability: 'app.tasks',
    permission: 'write_project',
    input: {
      task: z.string().describe('Task id (or a plan key of your objective)'),
      remove: z.array(z.string()).optional().describe("Checks to drop: a check's name or a test id"),
      add: z.array(z.record(z.string(), z.unknown())).optional().describe('Checks to add, e.g. {"kind":"luau_assert","name":"track_gone","luau":"return \'PASS\'"}'),
      reason: z.string().min(15).describe('Why the checks change (recorded)'),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const parent = caller.taskId ? p.tasks.get(caller.taskId)?.parentId : null;
      const t = p.tasks.get(args.task) ?? (parent ? p.tasks.byPlanKey(parent, args.task) : null);
      if (!t) return errorOutput(`No task "${args.task}".`);
      if (t.kind === 'objective') return errorOutput('An objective has no checks of its own.');
      if (TERMINAL.has(t.status)) return errorOutput(`"${t.title}" is ${t.status}: its checks no longer matter. Retire a test that is wrong with test_retire instead.`);
      const { kept, dropped, unknown } = splitChecks(t, args.remove ?? []);
      if (unknown.length) {
        return errorOutput(`The task has no check named ${unknown.map((x) => `"${x}"`).join(', ')}. Its checks: ${t.verification.map((m) => (m.kind === 'critic' || m.kind === 'static_analysis' ? m.kind : `${checkName(m)} (${m.kind})`)).join(', ') || 'none'}. (Static analysis and the critic can't be removed.)`);
      }
      const by = caller.role ?? 'agent';
      const added = normalizeVerification((args.add ?? []) as never, t.kind).filter((m) => m.kind !== 'static_analysis' && m.kind !== 'critic');
      // A new check whose probe runs on the wrong side is refused before anything changes.
      const refused = lintChecks(added);
      if (refused) return errorOutput(refused);
      const retired = retireOwnTests(p, t, dropped, `${args.reason} (check removed from its task by ${by})`, by);
      // The critic stays last: it reviews with the results of everything before it.
      const merged: VerificationMethod[] = [...kept.filter((m) => m.kind !== 'critic'), ...added];
      if (t.kind !== 'research') {
        if (!merged.some((m) => m.kind === 'static_analysis')) merged.unshift({ kind: 'static_analysis' });
        merged.push({ kind: 'critic' });
      }
      p.tasks.update(t.id, { verification: merged });
      const summary = [dropped.length ? `removed ${dropped.map((m) => checkName(m)).join(', ')}` : '', added.length ? `added ${added.map((m) => checkName(m)).join(', ')}` : ''].filter(Boolean).join('; ') || 'no change';
      p.audit.event({
        kind: 'task.verification',
        severity: 'info',
        title: `Changed the checks of "${t.title}": ${summary}`.slice(0, 300),
        taskId: t.id,
        runId: caller.runId,
        role: caller.role ?? 'agent',
        detail: { reason: args.reason, removed: dropped.map((m) => checkName(m)), added: added.map((m) => checkName(m)), retiredTests: retired },
      });
      p.tasks.addEvidence({ taskId: t.id, runId: caller.runId, kind: 'note', title: `Checks changed (${summary})`, passed: null, data: { reason: args.reason, by: caller.role, retiredTests: retired }, path: null });
      return textOutput(`Checks of "${t.title}" changed: ${summary}.${retired.length ? ` Retired its registered test${retired.length === 1 ? '' : 's'}: ${retired.join(', ')}.` : ''} Now: ${merged.map(checkLabel).join(', ')}.`);
    },
  });

  reg.register({
    name: 'task_run_checks',
    title: "Run my task's checks now",
    description:
      "Run your task's automated checks now, exactly as verification will run them when you finish: the same code sync, the same probes in the same DataModels, the same result text. Run it before you finish and fix what fails, so the task is not sent back for something you could have seen. Nothing is recorded and nobody is asked anything; screenshot and manual checks are named, not run. It takes Studio for as long as the checks need (stop your own playtest first). When a check fails because its probe is wrong, not the game (it tests something the task never asked for, calls the code in a way the game doesn't, runs on the wrong side), correct the probe with task_fix_probe and run this again.",
    capability: 'app.tests',
    permission: 'roblox_write',
    input: {},
    handler: async ({ caller, signal, progress }) => {
      const p = proj();
      const t = caller.taskId ? p.tasks.get(caller.taskId) : null;
      if (!t) return errorOutput('You have no task whose checks could be run.');
      if (!d.verifier) return errorOutput('Verification is not available here.');
      const checks = t.verification.filter((m) => m.kind !== 'critic');
      if (!checks.length) return textOutput('This task has no automated checks: the critic reviews it.');
      if (caller.runId && d.lease.isOwnedBy(caller.runId)) return errorOutput('Your own playtest is running: stop it first (roblox_playtest action "stop"); the checks start their own.');
      // Wait in line like any Studio work (progress notes, the caller's own limit), then run as the verification does.
      // Checks that neither play nor take pictures are Edit work: with the plugin linked they wait for no playtest.
      const editOnly = checks.every((m) => !playsStudio(m) && m.kind !== 'screenshot');
      const w = await d.studio.waitForLease(Infinity, "Your task's checks", !editOnly);
      if (!w.ok) return errorOutput(w.message);
      const scope = [...new Set([...t.files, ...(caller.runId ? filesEditedBy(p, caller.runId) : [])])];
      const alive = setInterval(() => progress?.({ message: "Running your task's checks as verification will…" }), 15_000);
      let report: VerificationReport;
      try {
        report = await d.verifier().rehearse(p, t, caller.runId, scope, signal);
      } finally {
        clearInterval(alive);
      }
      d.bus.emit('roblox.changed', { reason: 'checks' });
      const lines = report.results.map((r) => `${r.passed === true ? 'PASS' : r.passed === false ? 'FAIL' : 'SKIP'}  ${r.name}${r.kind !== r.name && r.name !== 'code sync' ? ` (${r.kind})` : ''}\n${r.output.split('\n').map((l) => `    ${l}`).join('\n')}`);
      const failed = report.results.filter((r) => r.passed === false);
      // A task the user reopened shows the problem before its fix counts (orchestrator/reopen.ts): a failing run of its
      // checks is that showing, recorded on the task (the one thing this tool records).
      const reopened = failed.length ? openReopen(p, t) : null;
      if (reopened) p.tasks.addEvidence({ taskId: t.id, runId: caller.runId, kind: 'test_result', title: `Reproduced before the fix: ${failed.map((r) => r.name).join(', ')} fail`.slice(0, 200), passed: false, data: { report: reopened.report, results: failed.map((r) => ({ name: r.name, output: r.output.slice(0, 1500) })) }, path: null });
      const verdict = failed.length
        ? `${failed.length} of them would fail verification now: ${failed.map((r) => r.name).join(', ')}. Fix the game; or, when a probe itself is wrong, correct it with task_fix_probe (the reason is recorded and the critic sees the old and the new probe).`
        : 'They pass as the work stands now. Finish now: a playtest check that passed here is not played again by the verification when your files are unchanged and you finish within a few minutes (Studio has one play mode and everyone waits for it); then the critic reviews.';
      return textOutput(`Your task's checks, run now as verification will run them (${reopened ? 'recorded as the reproduction of the problem the user reported' : 'nothing recorded'}):\n\n${lines.join('\n')}\n\n${verdict}`, { passed: report.passed, results: report.results.map((r) => ({ name: r.name, kind: r.kind, passed: r.passed })) });
    },
  });

  reg.register({
    name: 'task_fix_probe',
    title: "Correct a probe of my task's check",
    description:
      "Correct the Luau probe of a check on YOUR OWN task when the probe, not the game, is wrong: it was written before the code existed and assumes something the task never asked for (a fresh copy of a module the game never sees, a name that changed, the wrong side). check: the check's name. luau: the new probe (a playtest's server probe); client_luau: a playtest's probe on the player's client; datamodel: where a luau_assert runs (edit, server or client). The check keeps its name, its kind and what it stands for; it must still test what the acceptance criteria ask, and the acceptance criteria themselves can't be changed here. The reason is required and recorded, and the critic is shown the old and the new probe: a probe weakened to make broken work pass gets the task rejected. Removing or adding checks is for the planner and QA (task_update_verification).",
    capability: 'app.tasks',
    permission: 'write_project',
    input: {
      check: z.string().min(1).describe("The check's name"),
      luau: z.string().optional().describe("The corrected probe (a playtest's server probe, or the luau_assert's code)"),
      client_luau: z.string().optional().describe("A playtest's probe on the player's client"),
      datamodel: z.enum(['edit', 'server', 'client']).optional().describe('Where a luau_assert runs'),
      reason: z.string().min(20).describe('What was wrong with the probe, and why the game is right (recorded, shown to the critic)'),
    },
    handler: async ({ args, caller }) => {
      const p = proj();
      const t = caller.taskId ? p.tasks.get(caller.taskId) : null;
      if (!t) return errorOutput('You have no task: a probe is corrected by the worker of the task it belongs to.');
      if (caller.kind === 'agent' && caller.role !== t.role) return errorOutput(`Only the task's own worker (${t.role}) corrects its probes. A reviewer reports a wrong probe as a defect; the planner and QA change checks with task_update_verification.`);
      if (TERMINAL.has(t.status)) return errorOutput(`"${t.title}" is ${t.status}: its checks no longer run.`);
      const wanted = args.check.trim().toLowerCase();
      const at = t.verification.findIndex((m) => m.kind !== 'critic' && m.kind !== 'static_analysis' && checkName(m).toLowerCase() === wanted);
      const old = at >= 0 ? t.verification[at]! : null;
      if (!old) return errorOutput(`Your task has no check named "${args.check}". Its checks: ${t.verification.map(checkLabel).join(', ') || 'none'}.`);
      if ('testId' in old && old.testId) return errorOutput(`"${checkName(old)}" is a registered regression test this task re-runs, not a check of its own: its probe is not yours to change. If the test is wrong, say so in your result (QA or the planner retires it with test_retire).`);
      if (args.luau === undefined && args.client_luau === undefined && args.datamodel === undefined) return errorOutput('Give the corrected probe: luau, client_luau or datamodel.');
      let next: VerificationMethod;
      if (old.kind === 'luau_assert') {
        if (args.client_luau !== undefined) return errorOutput('A luau_assert has one probe: pass it as luau, with datamodel "client" to run it on the player\'s client.');
        next = { ...old, luau: args.luau ?? old.luau, datamodel: args.datamodel ?? old.datamodel ?? 'edit' };
      } else if (old.kind === 'playtest') {
        if (args.datamodel !== undefined) return errorOutput('A playtest runs luau on the server and client_luau on the client: pass the probe in the field of the side it belongs to (an empty string removes the other).');
        const server = args.luau !== undefined ? args.luau.trim() : (old.luau ?? '');
        const client = args.client_luau !== undefined ? args.client_luau.trim() : (old.clientLuau ?? '');
        const { luau: _l, clientLuau: _c, ...rest } = old;
        next = { ...rest, ...(server ? { luau: server } : {}), ...(client ? { clientLuau: client } : {}) };
      } else if (old.kind === 'cloud_luau') {
        if (args.luau === undefined) return errorOutput('Pass the corrected probe as luau.');
        next = { ...old, luau: args.luau };
      } else return errorOutput(`"${checkName(old)}" is a ${old.kind} check: it has no probe of yours to correct.`);
      const before = probesOf(old);
      const after = probesOf(next);
      if (before.length && !after.length) return errorOutput('A probe is corrected here, not removed: the check must still test something. Removing a check is for the planner or QA (task_update_verification).');
      const empty = after.find((x) => isEmptyProbe(x.code) || !x.code.trim());
      if (empty) return errorOutput('The new probe tests nothing (it only returns PASS). A corrected probe still checks what the acceptance criteria ask.');
      if (JSON.stringify(before) === JSON.stringify(after)) return textOutput('The probe is unchanged.');
      const refused = lintCheck(next);
      if (refused) return errorOutput(refused.replace('was not registered', 'was not changed'));
      const earlier = probeAmendments(p, t.id).filter((a) => a.check === checkName(old)).length;
      if (earlier >= 3) return errorOutput(`The probe of "${checkName(old)}" was corrected ${earlier} times already. Stop changing it: say in your result what is wrong with the check, and the planner or QA decides (task_update_verification).`);
      const verification = [...t.verification];
      verification[at] = next;
      p.tasks.update(t.id, { verification });
      // The test this task registered for the check (an earlier attempt's verification did) runs the corrected probe too.
      const tests = new TestService(p.store);
      if (tests.find(testName(t.id, old)).some((x) => x.taskId === t.id && !x.retiredAt)) tests.upsertForTask(t.id, next);
      const amendment: ProbeAmendment = { check: checkName(old), reason: args.reason, by: caller.role, before: before.map(({ side, code }) => ({ side, code })), after: after.map(({ side, code }) => ({ side, code })) };
      p.tasks.addEvidence({ taskId: t.id, runId: caller.runId, kind: 'note', title: `${PROBE_AMENDED} ${checkName(old)}`, passed: null, data: amendment, path: null });
      p.audit.event({ kind: 'task.verification', severity: 'info', title: `The worker corrected the probe of "${checkName(old)}" on "${t.title}": ${args.reason}`.slice(0, 300), taskId: t.id, runId: caller.runId, role: caller.role ?? 'agent', detail: amendment });
      return textOutput(`The probe of "${checkName(old)}" is corrected (${after.map((x) => `runs on: ${x.side}`).join(', ')}). Your reason is recorded and the critic will see the old and the new probe. Run task_run_checks to see it pass.`);
    },
  });

  // ─── Knowledge & skills ───────────────────────────────────────────────────

  reg.register({
    name: 'knowledge_search',
    title: 'Search knowledge',
    description: 'Search Shuriken knowledge (global, Roblox, domain, project). Results carry category, scope, confidence and sources.',
    capability: 'app.knowledge',
    permission: 'read',
    input: {
      query: z.string().min(2),
      scopes: z.array(z.enum(['global', 'roblox', 'domain', 'project', 'task', 'session'])).optional(),
      categories: z.array(z.enum(['authoritative', 'research', 'experimental', 'project', 'agent'])).optional(),
      authorities: z.array(authority).optional().describe('Only entries backed by a source of these authorities'),
      validated_only: z.boolean().optional().describe('Only entries validated by tests or verified work'),
      min_confidence: z.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const res = d.knowledge.search({
        text: args.query,
        scopes: args.scopes,
        categories: args.categories,
        authorities: args.authorities,
        validatedOnly: args.validated_only,
        minConfidence: args.min_confidence,
        limit: args.limit ?? 12,
      });
      return jsonOutput(res.map((k) => ({ id: k.id, title: k.title, scope: k.scope, category: k.category, confidence: k.confidence, status: k.status, version: k.versionApplicability, body: truncate(k.body, 1200), sources: k.sources.slice(0, 3) })));
    },
  });

  reg.register({
    name: 'knowledge_get',
    title: 'Get knowledge entry',
    description: 'Full knowledge entry with provenance and relationships (supports/contradicts/supersedes).',
    capability: 'app.knowledge',
    permission: 'read',
    input: { id: z.string() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const k = d.knowledge.get(args.id);
      if (!k) return errorOutput(`Unknown knowledge ${args.id}`);
      return jsonOutput({ ...k, links: d.knowledge.links(args.id) });
    },
  });

  reg.register({
    name: 'knowledge_propose',
    title: 'Record knowledge',
    description:
      'Record a reusable fact or pattern you verified. Use scope "project" for this game, "roblox" only for general platform facts backed by sources or tests. Category: "agent" (your inference), "experimental" (observed in a test), "research" (from sources).',
    capability: 'app.knowledge',
    permission: 'write_project',
    input: {
      title: z.string().min(5),
      body: z.string().min(10),
      scope: z.enum(['project', 'task', 'roblox', 'domain']),
      category: z.enum(['agent', 'experimental', 'research']),
      confidence: z.number().min(0).max(1),
      tags: z.array(z.string()).optional(),
      version_applicability: z.string().optional(),
      sources: z.array(z.object({ url: z.string(), title: z.string().optional(), authority })).optional(),
      contradicts: z.string().optional().describe('id of an existing entry this contradicts'),
    },
    handler: async ({ args, caller }) => {
      if ((args.scope === 'roblox' || args.scope === 'domain') && !args.sources?.length && args.category !== 'experimental') {
        return errorOutput('Roblox/domain-scoped knowledge needs sources (or category "experimental" with test evidence).');
      }
      const k = d.knowledge.add({
        scope: args.scope,
        category: args.category,
        title: args.title,
        body: args.body,
        tags: args.tags ?? [],
        confidence: args.category === 'agent' ? Math.min(args.confidence, 0.7) : args.confidence,
        versionApplicability: args.version_applicability ?? null,
        taskId: caller.taskId,
        createdBy: caller.role ?? caller.kind,
        sources: [
          ...(args.sources ?? []).map((s) => ({ kind: 'url' as const, ref: s.url, title: s.title, authority: s.authority })),
          ...(caller.runId ? [{ kind: 'run' as const, ref: caller.runId, authority: 'inference' as const }] : []),
        ],
      });
      if (args.contradicts) d.knowledge.link(k.id, args.contradicts, 'contradicts', 'Recorded by agent');
      return textOutput(`Knowledge recorded (${k.id})`, { id: k.id });
    },
  });

  reg.register({
    name: 'skill_list',
    title: 'List skills',
    description: 'List available skills (procedural knowledge for specialized work).',
    capability: 'app.skills',
    permission: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => jsonOutput(d.skills.list().map((s) => ({ name: s.name, description: s.description, scope: s.scope, tags: s.tags }))),
  });

  reg.register({
    name: 'skill_get',
    title: 'Get skill',
    description: 'Read a skill: purpose, preconditions, workflow, pitfalls, verification.',
    capability: 'app.skills',
    permission: 'read',
    input: { name: z.string() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const s = d.skills.get(args.name);
      return s ? textOutput(`# ${s.name}\n${s.description}\n\n${s.body}`) : errorOutput(`Unknown skill ${args.name}`);
    },
  });

  reg.register({
    name: 'capabilities_query',
    title: 'Query capabilities',
    description: 'Look up what integrations/tools can do right now: status, version, known limitations, observed reliability.',
    capability: 'app.capabilities',
    permission: 'read',
    input: { integration: z.string().optional(), search: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      let caps = args.search ? d.capabilities.search(args.search) : d.capabilities.list(args.integration);
      if (args.integration && args.search) caps = caps.filter((c) => c.integration === args.integration);
      return jsonOutput(caps.map((c) => ({ id: c.id, status: c.status, version: c.version, description: c.description, limitations: c.limitations, reliability: { ok: c.successCount, failed: c.failureCount, lastError: c.lastError?.slice(0, 200) ?? null }, detail: c.detail })));
    },
  });

  // ─── Governance ───────────────────────────────────────────────────────────

  reg.register({
    name: 'spec_get',
    title: 'Get specification',
    description: 'Read the living project specification (all sections or one).',
    capability: 'app.spec',
    permission: 'read',
    input: { key: z.string().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const spec = proj().governance.spec();
      const sel = args.key ? spec.filter((s) => s.key === args.key) : spec;
      return textOutput(sel.map((s) => `## ${s.title} [${s.key}] (${s.status}, v${s.version})\n${s.body || '(empty)'}`).join('\n\n'));
    },
  });

  reg.register({
    name: 'spec_propose',
    title: 'Propose spec change',
    description: 'Propose new text for a spec section. Draft sections update directly; approved sections require human approval.',
    capability: 'app.spec',
    permission: 'write_project',
    input: { key: z.string(), body: z.string().min(10), rationale: z.string().min(5) },
    handler: async ({ args, caller }) => {
      const p = proj();
      const section = p.governance.spec().find((s) => s.key === args.key);
      if (!section || section.status === 'draft') {
        p.governance.updateSpec(args.key, args.body, caller.role ?? 'agent', 'draft');
        return textOutput(`Spec section "${args.key}" updated (draft).`);
      }
      if (d.autonomy?.mode() === 'autonomous') {
        // Granted and logged: the system approves what its agents propose (the section stays approved, with the new text).
        p.governance.updateSpec(args.key, args.body, caller.role ?? 'agent', 'approved');
        p.governance.autoResolve({ kind: 'spec_change', title: `Spec change: ${section.title}`, detail: `${args.rationale}\n\n---\n${args.body}`, taskId: caller.taskId, runId: caller.runId, options: [], response: `Approved automatically: the "${section.title}" section now says what ${caller.role ?? 'the agent'} proposed (${args.rationale.slice(0, 160)}).` });
        return textOutput(`Section "${args.key}" is approved and your change is in (autonomous mode: no one needs to approve it).`);
      }
      p.governance.escalate({ kind: 'spec_change', title: `Spec change: ${section.title}`, detail: `${args.rationale}\n\n---\n${args.body}`, taskId: caller.taskId, runId: caller.runId, options: ['approve', 'reject'] });
      return textOutput(`Section "${args.key}" is approved; the change was sent to the user for approval.`);
    },
  });

  reg.register({
    name: 'decision_record',
    title: 'Record decision',
    description: 'Record an architectural/design decision (ADR) with context and consequences.',
    capability: 'app.decisions',
    permission: 'write_project',
    input: { title: z.string().min(5), context: z.string(), decision: z.string(), consequences: z.string().optional() },
    handler: async ({ args, caller }) => {
      const dec = proj().governance.addDecision({ title: args.title, context: args.context, decision: args.decision, consequences: args.consequences ?? '', status: caller.role === 'executive' || caller.role === 'architect' ? 'accepted' : 'proposed', createdBy: caller.role ?? 'agent', taskId: caller.taskId });
      return textOutput(`Decision recorded (${dec.id}, ${dec.status})`);
    },
  });

  reg.register({
    name: 'escalate',
    title: 'Ask the user',
    description:
      "Ask the user a question or decision that only they can make. Use sparingly; ordinary engineering decisions are yours. In autonomous mode (the default) nobody waits for an answer: the director answers at once from the user's request and the answer comes back in the result — except what spends money or publishes the game, which always goes to the owner. The owner reads the title and the options as buttons in their chat: write them in plain words about the game (\"Which side should the shop open on?\"), never ids, file paths, coordinates, tool names or error text; put the technical detail in detail (the team reads it, the owner sees it folded away).",
    capability: 'app.escalation',
    permission: 'write_project',
    input: { title: z.string().min(5), detail: z.string().min(10), options: z.array(z.string()).optional() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const asked = `${args.title}\n${args.detail}`;
      // What only the person at the PC can do (restart Studio, sign in) is put in front of them, once, and nobody
      // waits: the director would only guess whether they are there (see permissions/user-hands.ts).
      if (d.autonomy?.mode() === 'autonomous' && needsUserHands(asked) && !needsOwner({ kind: 'text', text: asked })) {
        const open = p.governance.escalations('open').find((e) => e.kind === 'question' && needsUserHands(`${e.title}\n${e.detail}`));
        const e = open ?? p.governance.escalate({ kind: 'question', title: args.title, detail: args.detail, options: args.options, taskId: caller.taskId, runId: caller.runId });
        return textOutput(`${HANDS_ANSWER} (${e.id}${open ? ', already asked by another agent' : ''})`);
      }
      // Studio's playtest turn is the app's to keep: the agent is told the facts, and nothing is decided.
      if (d.autonomy?.mode() === 'autonomous' && aboutStudioTurn(asked) && !needsUserHands(asked)) {
        const e = p.governance.autoResolve({ kind: 'question', title: args.title, detail: args.detail, options: args.options, taskId: caller.taskId, runId: caller.runId, response: "Studio's turns are kept by Shuriken itself (60 s playtests, a stuck stop gives way, a crash frees Studio); the agent waits its turn or works on." });
        return textOutput(`${STUDIO_TURN_ANSWER} (${e.id})`);
      }
      // Spending money and publishing are the owner's in every mode (see permissions/owner-gate.ts).
      if (d.autonomy?.mode() === 'autonomous' && !needsOwner({ kind: 'text', text: asked })) {
        const answer = (await d.autonomy.answer({ title: args.title, detail: args.detail, options: args.options, role: caller.role, taskId: caller.taskId }, signal).catch(() => null)) ?? null;
        const e = p.governance.autoResolve({ kind: 'question', title: args.title, detail: args.detail, options: args.options, taskId: caller.taskId, runId: caller.runId, response: answer ?? 'No answer came back in time: the agent decides for itself from the user\'s request and notes what it assumed.' });
        return textOutput(answer ? `The director answered for the user (${e.id}): ${answer}\n\nGo on with that, and note it in your result.` : `${DECIDE_YOURSELF} (${e.id})`);
      }
      const e = p.governance.escalate({ kind: 'question', title: args.title, detail: args.detail, options: args.options, taskId: caller.taskId, runId: caller.runId });
      return textOutput(`Escalated to the user (${e.id}). Continue with work that does not depend on the answer.`);
    },
  });

  // ─── Research ─────────────────────────────────────────────────────────────

  reg.register({
    name: 'research_add_source',
    title: 'Record research source',
    description: 'Record a source consulted during research, with an authority label.',
    capability: 'app.research',
    permission: 'write_project',
    input: { session_id: z.string(), url: z.string(), title: z.string(), authority, summary: z.string().optional() },
    handler: async ({ args }) => {
      const s = proj().research.addSource(args.session_id, { url: args.url, title: args.title, authority: args.authority, summary: args.summary });
      return textOutput(`Source recorded (${s.id})`, { id: s.id });
    },
  });

  reg.register({
    name: 'research_add_claim',
    title: 'Record research claim',
    description: 'Record a claim extracted from a source (or from an experiment), with confidence and status.',
    capability: 'app.research',
    permission: 'write_project',
    input: {
      session_id: z.string(),
      claim: z.string().min(5),
      source_id: z.string().optional(),
      confidence: z.number().min(0).max(1),
      status: z.enum(['supported', 'contradicted', 'unverified', 'conflicting']).optional(),
      notes: z.string().optional(),
    },
    handler: async ({ args }) => {
      const c = proj().research.addClaim(args.session_id, { claim: args.claim, sourceId: args.source_id, confidence: args.confidence, status: args.status, notes: args.notes });
      return textOutput(`Claim recorded (${c.id})`, { id: c.id });
    },
  });

  // ─── Roblox ───────────────────────────────────────────────────────────────

  reg.register({
    name: 'roblox_status',
    title: 'Studio status',
    description: 'Roblox Studio connection, open instances, bound place, play state and available DataModels.',
    capability: 'roblox.app.status',
    permission: 'roblox_read',
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const info = { connection: d.studio.conn.state, error: d.studio.conn.lastError, install: d.studio.installInfo, binding: d.studio.binding };
      if (!d.studio.connected) return jsonOutput(info);
      const studios = await d.studio.listStudios().catch((e) => String(e));
      const state = await d.studio.state().catch((e) => String(e));
      return jsonOutput({ ...info, studios, state });
    },
  });

  reg.register({
    name: 'roblox_run_luau',
    title: 'Run Luau in Studio',
    description: 'Execute Luau in Studio (Edit DataModel, or Server/Client during a playtest). Return a string (JSON-encode tables) to get data back; print() goes to the console.',
    capability: 'roblox.execute_luau',
    permission: 'roblox_write',
    available: studioAvail,
    input: { code: z.string().min(1), datamodel: dataModel.optional() },
    handler: async ({ args, signal, caller }) => {
      const dm = args.datamodel ?? 'Edit';
      const sleep = longestSleep(args.code);
      if (sleep > SLEEP_LIMIT[dm]) {
        return errorOutput(
          `Not run: this code waits ${sleep} s inside Studio. Studio runs one request at a time for every agent, so a sleep here stalls everyone's Studio work. Don't wait in Studio: Shuriken's tools wait for Studio by themselves (another agent's playtest, a verification). To let game time pass, use roblox_playtest action "run" with "seconds"; in probes, wait for a condition with an os.clock() deadline (up to ${SLEEP_LIMIT.Server} s during play).`,
        );
      }
      if (dm !== 'Edit') {
        const note = reclaimedNote(caller);
        if (note) return errorOutput(note);
      }
      active(caller);
      const blocked = await editBlocked(caller, dm, signal);
      if (blocked) return blocked;
      // Errors come back with the failing line of the agent's code (Studio's own messages have none).
      const r = await runAgentLuau(d.studio, d.luau, args.code, (args.datamodel ?? 'Edit') as DataModelType, 120000, signal);
      if (r.syntax) return errorOutput(`Luau syntax error, ${r.output}`);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      return r.ok ? textOutput(r.output || '(no return value)', { output: r.output }) : errorOutput(`Luau error: ${r.output}`);
    },
  });

  reg.register({
    name: 'roblox_explore',
    title: 'Explore DataModel',
    description: 'List the children of an instance path (e.g. "Workspace", "ReplicatedStorage.Shared"); empty path lists the main services.',
    capability: 'roblox.app.explore',
    permission: 'roblox_read',
    available: studioAvail,
    input: { path: z.string().optional(), datamodel: dataModel.optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal }) => {
      active(caller);
      return (await editBlocked(caller, args.datamodel ?? 'Edit', signal)) ?? jsonOutput(await d.studio.tree(args.path ?? '', (args.datamodel ?? 'Edit') as DataModelType));
    },
  });

  reg.register({
    name: 'roblox_inspect',
    title: 'Inspect instance',
    description: 'Properties, attributes, tags and (for scripts) source of one instance.',
    capability: 'roblox.app.inspect',
    permission: 'roblox_read',
    available: studioAvail,
    input: { path: z.string(), datamodel: dataModel.optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal }) => {
      active(caller);
      return (await editBlocked(caller, args.datamodel ?? 'Edit', signal)) ?? jsonOutput(await d.studio.detail(args.path, (args.datamodel ?? 'Edit') as DataModelType));
    },
  });

  reg.register({
    name: 'roblox_search',
    title: 'Search DataModel',
    description: 'Search the instance tree by path, class (IsA) and name keywords.',
    capability: 'roblox.search_game_tree',
    permission: 'roblox_read',
    available: studioAvail,
    input: { path: z.string().optional(), instance_type: z.string().optional(), keywords: z.string().optional(), max_depth: z.number().int().min(1).max(10).optional(), datamodel: dataModel.optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller }) => {
      active(caller);
      const a: Record<string, unknown> = { datamodel_type: args.datamodel ?? 'Edit', head_limit: 200 };
      if (args.path) a.path = args.path;
      if (args.instance_type) a.instance_type = args.instance_type;
      if (args.keywords) a.keywords = args.keywords;
      if (args.max_depth) a.max_depth = args.max_depth;
      const r = await d.studio.call('search_game_tree', a);
      return r.ok ? textOutput(truncate(r.content.map((c) => c.text ?? '').join('\n'), 30000)) : errorOutput(r.error ?? 'search failed');
    },
  });

  /** Keys or the mouse, as the player, in the playtest that is running. */
  const gameInput = async (device: 'keyboard' | 'mouse', actions: Array<Record<string, unknown>>, caller: CallerContext, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> => {
    const tool = device === 'mouse' ? 'user_mouse_input' : 'user_keyboard_input';
    const toolSchema = d.capabilities.get(`roblox.${tool}`)?.schema;
    const { args: callArgs, notes: filled } = fillStudioArgs({ actions }, toolSchema, ['Client']);
    active(caller);
    await d.studio.ensureVisible();
    // Keys and clicks Studio sends are input as far as Windows is concerned: they are Shuriken's, not the user coming back.
    const r = await d.studio.windows.idle.ownInput(() => d.studio.call(tool, { datamodel_type: 'Client', ...callArgs }, { timeoutMs: 120_000, signal }));
    const text = r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n').trim();
    const note = filled.length ? `\nFilled in for you: ${filled.join('; ')}. Pass them this way next time.` : '';
    if (r.ok) return { ok: true, text: `${text || '(sent)'}${note}` };
    const err = `${r.error ?? 'Studio refused the input'}${note}`;
    return { ok: false, text: /required|unknown|invalid|expected|missing|must be|not a valid|argument/i.test(err) && toolSchema ? `${err}\nArguments ${tool} takes: ${compactSchema(toolSchema)}` : err };
  };

  /** Play mode for `me`, waiting in line (the adapter waits with progress notes, up to STUDIO_WAIT.maxMs) while another agent or a verification plays. */
  const takePlayMode = async (me: string, _signal?: AbortSignal, estimateMs?: number) => {
    const w = await d.studio.acquirePlayMode(me, 'Your playtest', estimateMs);
    return w.ok ? null : errorOutput(w.message);
  };

  // Changes to the place (a sync, a rebuild, Edit-mode Luau, a model placed…): a playtest with none since the caller's
  // last one plays the same game again. A third of all playtests in the two long builds did, right after the same
  // agent's previous one; each stood in Studio's line again.
  let placeChanges = 0;
  d.bus.on('roblox.changed', (e) => {
    if (!/^(playtest|connection:|binding|studio-opened)/.test(e.reason)) placeChanges++;
  });
  const lastPlay = new Map<string, { at: number; changes: number }>();

  reg.register({
    name: 'roblox_playtest',
    title: 'Playtest',
    description:
      'Play Solo in Studio. Studio has ONE play mode and every other agent waits while you hold it, so a playtest is planned first and played fast: decide what you need to see, write every probe, key press and picture into ONE call, and read the answers afterwards. action "run" is that call: it starts a playtest, waits for your character (not in a game that opens in a menu and spawns none on join: it says so; expect_character overrides), lets `seconds` of game time pass (default 3, max 30; 0 when nothing has to settle), runs `luau` in the Server DataModel and `client_luau` in the Client, then your `steps` in order (each one a server probe, a client probe, key presses, mouse actions, a short wait or a screenshot; up to ' + RUN_STEPS.max + ' steps and ' + RUN_STEPS.shots + ' pictures), takes a screenshot if asked, collects errors from the output and stops. A whole check this way takes 10-30 s; driven by hand it took 35-98 s of everyone\'s Studio. Ask the same game everything at once: several questions are several probes in the steps of one run, not several runs. Example, a double jump: {action: "run", seconds: 1, steps: [{keys: [{action: "keyPress", key_code: "Space"}, {action: "wait", wait_time_ms: 250}, {action: "keyPress", key_code: "Space"}]}, {wait: 0.4}, {luau: "return tostring(game.Players:GetPlayers()[1].Character.HumanoidRootPart.Position.Y)"}, {screenshot: true}]}. "start"/"stop": only for a session whose next step truly depends on what you just saw; ' + PLAY_TIME_BOX + '. "start" and "run" wait in line while someone else plays.',
    capability: 'roblox.start_stop_play',
    permission: 'roblox_write',
    available: studioAvail,
    input: {
      action: z.enum(['run', 'start', 'stop', 'extend']),
      reason: z.string().optional().describe('action "extend": there is no extension (every playtest plays 60 s once it is up); kept so the answer says so'),
      seconds: z.number().min(0).max(30).optional(),
      luau: z.string().optional(),
      client_luau: z.string().optional(),
      screenshot: z.boolean().optional(),
      steps: z
        .array(
          z.object({
            luau: z.string().optional().describe('A probe in the Server DataModel; its return value comes back.'),
            client_luau: z.string().optional().describe('A probe in the Client DataModel.'),
            keys: z.array(z.record(z.string(), z.unknown())).min(1).max(40).optional().describe('Key presses as the player: {"action":"keyPress","key_code":"Space"}, {"action":"keyDown","key_code":"W"}, {"action":"wait","wait_time_ms":300}, {"action":"keyUp","key_code":"W"}.'),
            mouse: z.array(z.record(z.string(), z.unknown())).min(1).max(40).optional().describe('Mouse actions as the player (see roblox_input).'),
            wait: z.number().min(0).max(10).optional().describe('Seconds of game time to let pass.'),
            screenshot: z.boolean().optional().describe('A picture of the game as it is now.'),
          }),
        )
        .max(RUN_STEPS.max)
        .optional()
        .describe('action "run": the rest of the check, in order, after `seconds`, `luau` and `client_luau`. One thing per step (several in one step run in the order luau, client_luau, keys, mouse, wait, screenshot).'),
      expect_character: z.boolean().optional().describe("action \"run\": true waits for the player's character (up to 15 s) even in a game that spawns none on join (after a deploy your probe or a test hook triggers); false never waits for one. Left out, it waits unless the game doesn't spawn one on join."),
    },
    handler: async ({ args, caller, signal }) => {
      const me = caller.runId ?? `${caller.kind}:${caller.role ?? 'user'}`;
      const mine = () => d.lease;
      const holder = mine().holder;
      if (args.action === 'extend') {
        const r = mine().extend(me, args.reason ?? '');
        return r.ok ? textOutput(r.message) : errorOutput(r.message);
      }
      if (args.action === 'stop') {
        if (!holder) {
          const note = reclaimedNote(caller);
          if (note) return textOutput(note);
        } else if (holder.owner !== me && caller.kind !== 'ui') {
          return errorOutput(`This playtest belongs to ${holder.owner}; only its owner may stop it.`);
        }
        const st = await d.studio.setPlaying(false);
        mine().release(holder?.owner ?? me);
        d.bus.emit('roblox.changed', { reason: 'playtest:stop' });
        return jsonOutput(st, `Studio mode: ${st.mode}`);
      }
      const stepCode = (args.steps ?? []).flatMap((st, i) => [[`steps[${i}].luau`, st.luau], [`steps[${i}].client_luau`, st.client_luau]] as const);
      for (const [field, code] of [['luau', args.luau], ['client_luau', args.client_luau], ...stepCode] as const) {
        if (code && longestSleep(code) > SLEEP_LIMIT.Server) return errorOutput(`Not run: ${field} waits ${longestSleep(code)} s in Studio. Let game time pass with "seconds" instead, and wait for conditions with an os.clock() deadline (up to ${SLEEP_LIMIT.Server} s).`);
      }
      const ours = holder?.owner === me;
      if (args.action === 'start' && !ours && caller.kind !== 'ui') {
        const others = (holder && holder.owner !== me ? 1 : 0) + d.lease.waiting;
        if (others >= HAND_START.busyAt)
          return errorOutput(
            `Not started: ${others} others are using or waiting for Studio, and a playtest you drive by hand holds it for all of them over several of your turns. Put the whole check in ONE "run": steps carry luau and client_luau probes, keys, mouse, waits and screenshots in order, and it stops by itself. Start by hand only when Studio is quiet.`,
          );
      }
      if (!ours) {
        const refused = await takePlayMode(me, signal, playtestTurnMs(args));
        if (refused) return refused;
      }
      if (args.action === 'start') {
        try {
          const st = await d.studio.setPlaying(true);
          d.bus.emit('roblox.changed', { reason: 'playtest:start' });
          return jsonOutput(st, `Studio mode: ${st.mode} (play mode is yours; other agents wait until you stop it, so stop it as soon as you are done. It stops by itself when your run ends, and ${PLAY_TIME_BOX})`);
        } catch (e) {
          mine().release(me);
          throw e;
        }
      }
      // action "run": the whole check in one call. It is busy the whole time (never "idle" for the watchdog).
      const lines: string[] = [];
      const content: ToolContent[] = [];
      const keepAlive = setInterval(() => mine().touch(me), 5000);
      // A whole check in one call has the same 60 s of play as any playtest (PLAYTEST_LIMITS.playMs), from the moment
      // its character is in the game: Studio's load and the character's spawn are not counted.
      try {
        const current = ours ? await d.studio.state().catch(() => null) : null;
        const st = current?.availableDataModels.includes('Server') ? current : await d.studio.setPlaying(true);
        if (!st.availableDataModels.includes('Server')) return errorOutput(`The playtest did not start (Studio mode: ${st.mode}).`);
        d.bus.emit('roblox.changed', { reason: 'playtest:start' });
        // A game that opens in a menu spawns no character on join: the wait is not paid for one that isn't coming.
        const history = d.project() ? new CharacterHistory(d.project()!.dir) : null;
        const expect = args.expect_character ?? null;
        const misses = history?.misses() ?? 0;
        const answer = await d.studio.runLuau(awaitCharacterLuau(expect, misses > 0), 'Server', 30000, signal).catch(() => null);
        let character: CharacterWait | null = null;
        try {
          character = answer?.ok ? (JSON.parse(answer.output) as CharacterWait) : null;
        } catch {
          character = null;
        }
        mine().touch(me);
        mine().markPlaying(me);
        if (character && expect !== false) history?.record(character.character);
        const noCharacter = characterLine(character, expect, misses > 0, misses);
        if (noCharacter) lines.push(noCharacter);
        const wait = args.seconds ?? 3;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
        lines.push(character?.character ? `Played ${wait} s after the character spawned.` : `Played ${wait} s.`);
        for (const [label, code, dm] of [['Server probe', args.luau, 'Server'], ['Client probe', args.client_luau, 'Client']] as const) {
          if (!code) continue;
          mine().touch(me);
          const r = await runAgentLuau(d.studio, d.luau, code, dm, 60000, signal);
          lines.push(`${label}: ${r.ok ? r.output || '(no return value)' : `ERROR ${r.output}`}`);
        }
        let shots = 0;
        const takeShot = async (label: string): Promise<void> => {
          if (shots >= RUN_STEPS.shots) return void lines.push(`${label}: not taken (a run takes at most ${RUN_STEPS.shots} pictures).`);
          shots++;
          mine().touch(me);
          const shot = await d.studio.screenshot().catch((e: Error) => {
            lines.push(`${label}: ${e.message}`);
            return null;
          });
          if (!shot) return;
          content.push({ type: 'image', data: shot.data, mimeType: shot.mimeType });
          if (label !== 'Screenshot') lines.push(`${label}: picture ${content.length} below.`);
          const p = d.project();
          if (p && caller.taskId && p.tasks.get(caller.taskId)) {
            const file = join(p.dir, 'evidence', `${caller.taskId}-${Date.now()}.${extFor(shot.mimeType)}`);
            writeFileSync(file, Buffer.from(shot.data, 'base64'));
            p.tasks.addEvidence({ taskId: caller.taskId, runId: caller.runId, kind: 'screenshot', title: 'Playtest screenshot', passed: null, data: null, path: file });
          }
        };
        // The plan the caller wrote before playing, carried out at Studio's speed instead of one tool call at a time.
        const allSteps = args.steps ?? [];
        for (const [i, step] of allSteps.entries()) {
          if (signal?.aborted) break;
          // Past its 60 s of play (or taken away): what is left is said, not tried against a stopped game.
          const end = mine().isOwnedBy(me) ? mine().expiresAt() : Date.now();
          if (end !== null && Date.now() >= end) {
            lines.push(`Stopped at the ${Math.round(PLAYTEST_LIMITS.playMs / 1000)} s play cap: step${allSteps.length - i > 1 ? `s ${i + 1}-${allSteps.length} were` : ` ${i + 1} was`} not played. Put fewer seconds of waiting into one run, or play the rest in another.`);
            break;
          }
          const n = `Step ${i + 1}`;
          for (const [what, code, dm] of [['server', step.luau, 'Server'], ['client', step.client_luau, 'Client']] as const) {
            if (!code) continue;
            mine().touch(me);
            const r = await runAgentLuau(d.studio, d.luau, code, dm, 60000, signal);
            lines.push(`${n} (${what} probe): ${r.ok ? r.output || '(no return value)' : `ERROR ${r.output}`}`);
          }
          for (const [device, actions] of [['keyboard', step.keys], ['mouse', step.mouse]] as const) {
            if (!actions) continue;
            const r = await gameInput(device, actions, caller, signal).catch((e: Error) => ({ ok: false, text: e.message }));
            lines.push(`${n} (${device}): ${r.ok ? r.text : `ERROR ${r.text}`}`);
          }
          if (step.wait) {
            await new Promise((r) => setTimeout(r, step.wait! * 1000));
            lines.push(`${n}: ${step.wait} s passed.`);
          }
          if (step.screenshot) await takeShot(`${n} (screenshot)`);
        }
        if (args.screenshot) await takeShot('Screenshot');
        const errors: string[] = [];
        // Both logs at once: each read is a Studio call the playtest waits for.
        const logs = await Promise.all((['Server', 'Client'] as const).map((dm) => d.studio.runLuau(LUAU_LOG_ERRORS, dm, 20000).catch(() => null)));
        for (const [i, dm] of (['Server', 'Client'] as const).entries()) {
          const r = logs[i];
          try {
            const parsed = r?.ok ? (JSON.parse(r.output) as { errors?: string[] }) : null;
            for (const e of parsed?.errors ?? []) errors.push(`[${dm}] ${e}`);
          } catch {
            /* unreadable log */
          }
        }
        lines.push(errors.length ? `Errors in the output (${errors.length}):\n${errors.slice(-15).join('\n')}` : 'No errors in the output.');
      } finally {
        clearInterval(keepAlive);
        await d.studio.setPlaying(false).catch((e) => lines.push(`Stopping the playtest failed: ${(e as Error).message}`));
        mine().release(me);
        d.bus.emit('roblox.changed', { reason: 'playtest:stop' });
      }
      // The same game played again: said, so the next questions go into one run.
      const prev = lastPlay.get(me);
      if (prev && prev.changes === placeChanges && Date.now() - prev.at < REPLAY_NOTE.withinMs) {
        lines.push(`Note: nothing in the place changed since your previous playtest ${Math.round((Date.now() - prev.at) / 1000)} s ago, so this played the same game again. Ask a game everything you want to know in ONE run: steps can carry several luau and client_luau probes, waits, keys and screenshots. Each separate playtest puts you, and every agent behind you, back in Studio's line.`);
      }
      lastPlay.set(me, { at: Date.now(), changes: placeChanges });
      return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
    },
  });

  reg.register({
    name: 'roblox_console',
    title: 'Studio console',
    description: 'Recent Studio output (prints, warnings, errors). Returns the tail of the log.',
    capability: 'roblox.get_console_output',
    permission: 'roblox_read',
    available: studioAvail,
    input: { tail_chars: z.number().int().min(500).max(50000).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller }) => {
      active(caller);
      const text = await d.studio.console();
      return textOutput(text.slice(-(args.tail_chars ?? 12000)) || '(console empty)');
    },
  });

  reg.register({
    name: 'roblox_screenshot',
    title: 'Studio screenshot',
    description: "Capture the Studio viewport (optionally from a camera position looking at a point). The image is returned and saved as task evidence. Want several views? Pass them all as `shots` in one call: a screenshot waits its turn behind the playtests, and one call waits once. When Studio isn't drawing (minimized, the display off, or its screen capture stopped answering) the capture is retried once, then the result says so: that is not an error and not a defect of your work, it means \"can't check visually\" right now (measure instead; don't wait).",
    capability: 'roblox.screen_capture',
    permission: 'roblox_read',
    available: studioAvail,
    input: {
      camera: z.array(z.number()).length(3).optional(),
      look_at: z.array(z.number()).length(3).optional(),
      title: z.string().optional(),
      shots: z
        .array(z.object({ camera: z.array(z.number()).length(3).optional(), look_at: z.array(z.number()).length(3).optional(), title: z.string().optional() }))
        .min(1)
        .max(SHOTS_PER_CALL)
        .optional()
        .describe(`Several pictures in ONE call (up to ${SHOTS_PER_CALL}): every view you want of the scene now, each {camera, look_at, title}. Studio is shared and a screenshot waits its turn behind the playtests: six views asked one by one wait six times, asked together once.`),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal }) => {
      active(caller);
      // Studio wasn't drawing a moment ago and no capture is tried for now: said at once, before any waiting for
      // Studio (agents stood three minutes in its line to be told so).
      let notDrawing: string | null = d.studio.capturePause()?.message ?? null;
      // During another agent's playtest the viewport shows that session, not the Edit scene: wait for it.
      const blocked = notDrawing ? null : await editBlocked(caller, 'Edit', signal);
      if (blocked) return blocked;
      const wanted = args.shots?.length ? args.shots : [{ camera: args.camera, look_at: args.look_at, title: args.title }];
      const content: ToolContent[] = [];
      const lines: string[] = [];
      try {
        // One turn in Studio's line for all of them.
        if (!notDrawing) await d.studio.inEditTurn(async () => {
          for (const [i, w] of wanted.entries()) {
            if (signal?.aborted) break;
            const label = wanted.length > 1 ? `${i + 1}. ${w.title ?? 'screenshot'}` : (w.title ?? 'Screenshot');
            let shot: Awaited<ReturnType<typeof d.studio.screenshot>>;
            try {
              shot = await d.studio.screenshot({ camera: w.camera as [number, number, number] | undefined, lookAt: w.look_at as [number, number, number] | undefined });
            } catch (e) {
              if (!(e instanceof ScreenshotUnavailableError)) throw e;
              // Studio isn't drawing: the rest of the batch would only wait out the same timeouts.
              notDrawing = e.message;
              break;
            }
            if (!shot) {
              lines.push(`${label}: no image returned`);
              continue;
            }
            const p = d.project();
            let evidence = '';
            if (p && caller.taskId && p.tasks.get(caller.taskId)) {
              const file = join(p.dir, 'evidence', `${caller.taskId}-${Date.now()}-${i}.${extFor(shot.mimeType)}`);
              writeFileSync(file, Buffer.from(shot.data, 'base64'));
              const ev = p.tasks.addEvidence({ taskId: caller.taskId, runId: caller.runId, kind: 'screenshot', title: w.title ?? 'Agent screenshot', passed: null, data: { camera: w.camera, lookAt: w.look_at }, path: file });
              evidence = ` (saved as evidence ${ev.id})`;
            }
            content.push({ type: 'image', data: shot.data, mimeType: shot.mimeType });
            lines.push(wanted.length > 1 ? `${label}: captured${evidence}` : `Screenshot captured${evidence}`);
          }
        });
      } catch (e) {
        if (!content.length) return errorOutput((e as Error).message);
        lines.push(`Stopped: ${(e as Error).message}`);
      }
      if (notDrawing) {
        // Studio isn't drawing (minimized, display off, a dead capture tool): an environment condition, not a failed call and not a
        // defect of the work. It is noted on the task so the critic reads it as "can't check visually".
        const tp = d.project();
        const title = `No screenshot possible: ${STUDIO_NOT_DRAWING} (can't check visually)`;
        if (tp && caller.taskId && tp.tasks.get(caller.taskId) && !tp.tasks.evidence(caller.taskId).some((x) => x.kind === 'note' && x.title === title)) {
          tp.tasks.addEvidence({ taskId: caller.taskId, runId: caller.runId, kind: 'note', title, passed: null, data: { environment: 'studio_not_drawing' }, path: null });
        }
        if (!content.length) return textOutput(notDrawing, { environment: 'studio_not_drawing', visualCheck: 'unavailable' });
        lines.push(notDrawing);
      }
      if (!content.length) return errorOutput(lines.join('\n') || 'No image returned');
      return { content: [...content, { type: 'text', text: lines.join('\n') }] };
    },
  });

  reg.register({
    name: 'roblox_snapshot',
    title: 'DataModel snapshot',
    description: 'Serialize instances under the given roots (class, key properties, attributes, tags, script hashes) for before/after comparison.',
    capability: 'roblox.app.snapshot',
    permission: 'roblox_read',
    available: studioAvail,
    input: { roots: z.array(z.string()).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal }) => {
      const blocked = await editBlocked(caller, 'Edit', signal);
      if (blocked) return blocked;
      const p = d.project();
      const roots = args.roots ?? p?.extras().snapshotRoots ?? ['Workspace'];
      const snap = (await d.studio.snapshot(roots, 'Edit', 6000)) as { count: number; truncated: boolean; nodes: Record<string, unknown> };
      let path: string | null = null;
      if (p) {
        path = join(p.dir, 'snapshots', `manual-${Date.now()}.json`);
        writeFileSync(path, JSON.stringify(snap), 'utf8');
      }
      return jsonOutput({ count: snap.count, truncated: snap.truncated, path, sample: Object.keys(snap.nodes).slice(0, 60) });
    },
  });

  reg.register({
    name: 'roblox_sync_push',
    title: 'Sync code into Studio',
    description:
      'Push on-disk Luau into Studio and verify by content hash. Studio edits are never overwritten: a script changed in Studio since the last sync comes back into its file (fromStudio), or is merged with your change (merged); when both changed the same lines the file gets conflict markers (conflicts) — resolve them and sync again. Scripts deleted in Studio lose their unchanged files (removed); new ones made there get files (added). Reports created/updated scripts and orphans (scripts in Studio with no file); unchanged is a count.',
    capability: 'roblox.app.sync',
    permission: 'roblox_write',
    available: studioAvail,
    input: { delete_orphans: z.boolean().optional(), force: z.boolean().optional().describe("Only when the sync says Studio's scripts match nothing synced before AND this is the right place (reopened from an old save): the files' versions go in everywhere.") },
    handler: async ({ args, caller }) => {
      const p = proj();
      const extras = p.extras();
      if (extras.syncMode === 'script-sync') return textOutput('This project uses Studio Script Sync; files are synced by Studio automatically.');
      if (extras.syncMode === 'none') return errorOutput('Code sync is disabled for this project.');
      if (args.delete_orphans && extras.adopted) return errorOutput("This game was plugged in: scripts in Studio without a file are the game's own (some can't be files), so sync never deletes them. Delete a script in Studio yourself (roblox_run_luau) only when the user asked for it.");
      // Files other agents are editing right now stay out of this sync (their own sync brings them in).
      const skip = caller.runId ? filesInFlight(p, caller.runId) : [];
      // The push waits for Studio itself (someone's playtest, a verification) before it takes its place in line.
      const report = await d.sync.push(p.root, extras.syncMap, { deleteOrphans: args.delete_orphans, skip, force: args.force });
      if (report.busy) return errorOutput(report.busy);
      d.bus.emit('roblox.changed', { reason: 'sync', paths: [...report.created, ...report.updated] });
      // The scripts that did not change are counted, not listed: the list (every script of the game, about 1,000
      // tokens in a 60-script project) said nothing an agent acts on, and stayed in its context for the rest of the run.
      const told = { ...report, unchanged: report.unchanged.length };
      return report.errors.length ? { ...jsonOutput(told, 'Sync completed with errors'), isError: true } : jsonOutput(told, 'Sync complete');
    },
  });

  reg.register({
    name: 'roblox_call',
    title: 'Call Studio MCP tool',
    description:
      'Call any tool exposed by the installed Roblox Studio MCP server that has no dedicated Shuriken tool (e.g. insert_asset, search_asset, generate_mesh, generate_material, user_keyboard_input, character_navigation). studio_id is added automatically. Check capabilities_query(integration="roblox-studio") for schemas and limitations.',
    capability: 'roblox.app.call',
    permission: 'roblox_write',
    available: studioAvail,
    input: { tool: z.string(), args: z.record(z.string(), z.unknown()).optional(), timeout_sec: z.number().optional() },
    handler: async ({ args, signal, caller }) => {
      const p = d.project();
      if (args.tool === 'multi_edit' && p && p.extras().syncMode !== 'none') return errorOutput('Script edits must be made to files on disk (the source of truth), then synced with roblox_sync_push.');
      if (args.tool === 'list_roblox_studios' || args.tool === 'get_studio_state') {
        /* harmless */
      }
      // What the call plainly meant is filled in from the tool's own schema (the DataModel an input tool works in,
      // a wait's length under the name Studio wants) instead of costing a turn for "datamodel_type is required".
      const toolSchema = d.capabilities.get(`roblox.${args.tool}`)?.schema;
      const given = (args.args ?? {}) as Record<string, unknown>;
      const mode = needsStudioMode(given, toolSchema) ? await d.studio.state().catch(() => null) : null;
      const { args: callArgs, notes: filled } = fillStudioArgs(given, toolSchema, mode?.availableDataModels ?? null);
      active(caller);
      // Game input and captures need Studio's window drawn (a minimized Studio has a 1×1 viewport).
      if (/^(user_mouse_input|user_keyboard_input|screen_capture|character_navigation)$/.test(args.tool)) await d.studio.ensureVisible();
      const tracksAssets = !!p && AssetCapture.handles(args.tool);
      // Asset library: note the watched parents' children first, so placements can be found even when
      // the tool does not report where it put things.
      const before = tracksAssets && !busyNow(caller) ? await assets.childIds(watchRoots(args.tool, callArgs)) : null;
      const r = await d.studio.call(args.tool, callArgs, { timeoutMs: (args.timeout_sec ?? 120) * 1000, signal });
      d.bus.emit('roblox.changed', { reason: `call:${args.tool}` });
      const content: ToolContent[] = r.content.map((c) => (c.type === 'image' && typeof c.data === 'string' ? { type: 'image' as const, data: c.data, mimeType: String(c.mimeType ?? 'image/png') } : { type: 'text' as const, text: typeof c.text === 'string' ? c.text : JSON.stringify(c) }));
      if (r.ok && tracksAssets && p) {
        const text = r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ');
        try {
          const { report } = await assets.capture(new AssetService(p.store), { tool: args.tool, args: callArgs, text, before, actor: caller.role ?? caller.kind, taskId: caller.taskId, runId: caller.runId });
          if (report.length) content.push({ type: 'text', text: report.join('\n') });
          d.bus.emit('assets.changed', {});
        } catch (e) {
          content.push({ type: 'text', text: `Asset library: could not record this call (${(e as Error).message.slice(0, 200)}).` });
        }
      }
      if (filled.length) content.push({ type: 'text', text: `Filled in for you: ${filled.join('; ')}. Pass them this way next time.` });
      if (r.ok) return { content: content.length ? content : [{ type: 'text', text: '(ok)' }] };
      // A rejected argument costs a turn to look up; hand the schema back with the error instead.
      const err = `${r.error ?? 'Studio tool failed'}${filled.length ? `\n(Filled in for you before the call: ${filled.join('; ')}.)` : ''}`;
      const schema = /required|unknown|invalid|expected|missing|must be|not a valid|argument/i.test(err) ? toolSchema : undefined;
      return errorOutput(schema ? `${err}
Arguments ${args.tool} takes (studio_id is added for you): ${compactSchema(schema)}` : err);
    },
  });

  // A reviewer has no roblox_call (it could insert and generate things), and a probe can't fake input: in two builds
  // a critic tried VirtualInputManager from a client probe ("lacking capability RobloxScript") and then reported that
  // it "couldn't press keys" for a double jump and a dash it was asked to prove. This is the input half alone.
  reg.register({
    name: 'roblox_input',
    title: 'Game input',
    description:
      'Press keys or use the mouse as the player, in a playtest you started with roblox_playtest action "start" (probes can\'t fake input: VirtualInputManager and VirtualUser are refused there). device "keyboard": actions like {"action":"keyPress","key_code":"Space"}, {"action":"keyDown","key_code":"W"}, {"action":"wait","wait_time_ms":300}, {"action":"keyUp","key_code":"W"}. device "mouse": {"action":"moveTo","instance_path":"game.Players.LocalPlayer.PlayerGui.Shop.Buy"} or x/y, then {"action":"mouseButtonClick","mouse_button":"left"}. Afterwards read what happened with roblox_run_luau (datamodel "Client" or "Server") and stop the playtest. Keys Roblox owns (the hotbar\'s number keys, Esc) can\'t be pressed: equip with Humanoid:EquipTool in a probe instead. The mouse needs Studio\'s window drawn.',
    capability: 'roblox.app.call',
    permission: 'roblox_write',
    available: studioAvail,
    input: { device: z.enum(['keyboard', 'mouse']), actions: z.array(z.record(z.string(), z.unknown())).min(1).max(40) },
    handler: async ({ args, signal, caller }) => {
      const st = await d.studio.state().catch(() => null);
      if (st && !st.availableDataModels.includes('Client')) return errorOutput('No playtest is running: game input goes to the player\'s client. Put the input in a step of roblox_playtest action "run" (steps: [{keys: [...]}, {client_luau: "..."}, {screenshot: true}]: the whole check in one call), or start one with roblox_playtest action "start", send the input, read the result, then stop it.');
      const r = await gameInput(args.device, args.actions, caller, signal);
      return r.ok ? textOutput(r.text) : errorOutput(r.text);
    },
  });

  reg.register({
    name: 'store_search',
    title: 'Search the Creator Store (batched)',
    description:
      'Search the Roblox Creator Store with several queries in ONE call — use this instead of repeated roblox_call search_asset (each of those costs a full turn). Returns one compact line per unique asset: id | name | creator | description. For Audio, the licensed libraries (creators Roblox, APM Music/APMOfficial, Pro Sound Effects/ProSoundEffects, KPM) are cleared for any experience. Use a chosen asset with roblox_call insert_asset, or reference audio as rbxassetid://<id>.',
    capability: 'roblox.app.call',
    permission: 'roblox_read',
    available: studioAvail,
    input: {
      queries: z.array(z.string().min(2)).min(1).max(12).describe('Different targets or phrasings, e.g. ["sword swing whoosh", "metal clang block", "coin pickup chime"]'),
      asset_type: z.enum(['Audio', 'Model', 'Decal', 'MeshPart', 'Animation', 'Video', 'FontFamily', 'Plugin']),
      per_query: z.number().int().min(1).max(25).optional().describe('Results per query (default 8)'),
      verified_only: z.boolean().optional().describe('Only verified creators'),
    },
    handler: async ({ args, signal }) => {
      const per = args.per_query ?? 8;
      const seen = new Set<string>();
      const sections: string[] = [];
      let failures = 0;
      // A few at a time: Studio's MCP server handles calls one by one anyway, and this keeps it responsive.
      const queue = [...args.queries];
      const results = new Map<string, string[]>();
      const worker = async () => {
        for (let q = queue.shift(); q !== undefined; q = queue.shift()) {
          const r = await d.studio.call(
            'search_asset',
            { query: q, scope: 'creator_store', assetType: args.asset_type, priceFilter: 'free', maxResults: per, ...(args.verified_only ? { verifiedCreatorsOnly: true } : {}) },
            { timeoutMs: 60_000, signal },
          );
          if (!r.ok) {
            failures++;
            results.set(q, [`  (search failed: ${(r.error ?? 'unknown error').slice(0, 160)})`]);
            continue;
          }
          const lines = compactStoreResults(r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(''), args.asset_type, seen);
          results.set(q, lines === null ? ['  (unreadable result)'] : lines.length ? lines.map((l) => `  ${l}`) : ['  (no new results)']);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      for (const q of args.queries) sections.push(`"${q}":\n${(results.get(q) ?? ['  (not searched)']).join('\n')}`);
      const head = `${seen.size} unique free ${args.asset_type} assets from ${args.queries.length} queries${failures ? ` (${failures} failed)` : ''}. Format: id | name | creator | description`;
      return { content: [{ type: 'text', text: `${head}\n\n${sections.join('\n\n')}` }] };
    },
  });

  // ─── Asset library ────────────────────────────────────────────────────────

  const assetBrief = (a: AssetRecord) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    version: a.version,
    robloxAssetId: a.robloxAssetId,
    source: a.source,
    tags: a.tags.filter((t) => !/^(Assistant:|PrimitiveGen_|ShurikenAsset_)/.test(t)),
    placed: a.instancePaths.slice(0, 5),
    summary: a.analysis ? analysisSummary(a.analysis) : null,
    parameters: a.analysis ? Object.keys(a.analysis.parameters).filter((k) => !k.startsWith('RBX_')) : [],
    findings: a.analysis ? a.analysis.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity}: ${f.message}`) : [],
    updatedAt: a.updatedAt,
  });
  const assetKinds = z.enum(['model', 'mesh', 'material', 'texture', 'image', 'audio', 'other']);

  reg.register({
    name: 'asset_search',
    title: 'Search asset library',
    description:
      'Search the project asset library (models, meshes, materials, textures and images agents inserted, generated or registered) BEFORE inserting or generating something new. Matches names, tags, materials, procedural parameters and generation prompts. Returns summaries; asset_get has the full record.',
    capability: 'app.assets',
    permission: 'read',
    input: { query: z.string().optional(), kind: assetKinds.optional(), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const svc = new AssetService(proj().store);
      const list = args.query ? svc.search(args.query, { kind: args.kind, limit: args.limit ?? 15 }) : svc.list(undefined, args.kind).slice(0, args.limit ?? 15);
      return jsonOutput(list.map(assetBrief));
    },
  });

  reg.register({
    name: 'asset_get',
    title: 'Get asset',
    description:
      'Full asset record: source and generation parameters, analysis (geometry, materials, textures, polycount, collision, LOD, dependencies, scripts, findings), placements and history.',
    capability: 'app.assets',
    permission: 'read',
    input: { id: z.string() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const svc = new AssetService(proj().store);
      const a = svc.get(args.id);
      if (!a) return errorOutput(`Unknown asset ${args.id}`);
      return jsonOutput({ ...a, history: svc.history(a.id) });
    },
  });

  reg.register({
    name: 'asset_analyze',
    title: 'Analyze asset in Studio',
    description:
      'Measure an instance in Studio (Edit DataModel): part and mesh counts, bounding box, materials, textures, polycount (measured only for meshes this account may load; others are reported as unmeasured), collision and LOD settings, referenced asset ids, scripts with risk markers, and findings. Pass an asset id (analyzes its current placement) or an instance path; a path that is not in the library yet is registered as a reusable asset (name/tags optional).',
    capability: 'roblox.app.assets',
    permission: 'roblox_write',
    available: studioAvail,
    input: { id: z.string().optional(), path: z.string().optional(), name: z.string().optional(), tags: z.array(z.string()).optional() },
    handler: async ({ args, caller, signal }) => {
      const blocked = await editBlocked(caller, 'Edit', signal);
      if (blocked) return blocked;
      const svc = new AssetService(proj().store);
      const actor = caller.role ?? caller.kind;
      let rec = args.id ? svc.get(args.id) : args.path ? svc.byInstancePath(args.path) : null;
      if (args.id && !rec) return errorOutput(`Unknown asset ${args.id}`);
      let path = args.path ?? null;
      if (!path && rec) path = (await assets.usage(svc, rec))[0] ?? rec.instancePaths[0] ?? null;
      if (!path) return errorOutput('The asset has no known placement; pass path (an instance path such as Workspace.Props.Crate).');
      const analysis = await assets.analyze(path);
      if (!rec) {
        rec = svc.record({
          name: args.name ?? analysis.name,
          kind: analysis.meshCount && !analysis.parts ? 'mesh' : 'model',
          source: `studio:instance registered by ${actor}`,
          instancePaths: [analysis.path],
          tags: args.tags,
          metadata: { registeredFrom: analysis.path },
          event: 'registered',
          actor,
          taskId: caller.taskId,
          runId: caller.runId,
          summary: `registered existing instance ${analysis.path}`,
        });
        const usageTag = `ShurikenAsset_${rec.id}`;
        await assets.tag([analysis.path], usageTag);
        rec = svc.update(rec.id, { usageTag }) ?? rec;
      } else if (args.tags?.length) {
        rec = svc.update(rec.id, { tags: [...new Set([...rec.tags, ...args.tags])] }) ?? rec;
      }
      rec = svc.setAnalysis(rec.id, analysis, actor, caller.taskId, caller.runId) ?? rec;
      d.bus.emit('assets.changed', { id: rec.id });
      return jsonOutput({ asset: assetBrief(rec), analysis });
    },
  });

  reg.register({
    name: 'asset_usage',
    title: 'Asset usage',
    description: 'Where an asset is placed in the open place right now (found by its usage tag, so moved or renamed copies are still found).',
    capability: 'roblox.app.assets',
    permission: 'roblox_read',
    available: studioAvail,
    input: { id: z.string() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const svc = new AssetService(proj().store);
      const a = svc.get(args.id);
      if (!a) return errorOutput(`Unknown asset ${args.id}`);
      const paths = await assets.usage(svc, a);
      return jsonOutput({ id: a.id, name: a.name, usageTag: a.usageTag, count: paths.length, paths });
    },
  });

  reg.register({
    name: 'asset_reuse',
    title: 'Reuse asset',
    description:
      'Place another copy of a library asset: clones a live placement (keeping its tags and procedural parameters) or re-inserts it by Roblox asset id. Prefer this over generating or inserting a similar asset again. offset is added to the copy\'s pivot (studs).',
    capability: 'roblox.app.assets',
    permission: 'roblox_write',
    available: studioAvail,
    input: { id: z.string(), parent_path: z.string().optional(), name: z.string().optional(), offset: z.array(z.number()).length(3).optional() },
    handler: async ({ args, caller, signal }) => {
      const blocked = await editBlocked(caller, 'Edit', signal);
      if (blocked) return blocked;
      const svc = new AssetService(proj().store);
      const a = svc.get(args.id);
      if (!a) return errorOutput(`Unknown asset ${args.id}`);
      const parent = args.parent_path ?? 'Workspace';
      const live = await assets.usage(svc, a);
      let placed: string | null = null;
      if (live[0]) {
        const r = await d.studio.luauJson<{ path?: string; error?: string }>(
          LUAU_ASSET_CLONE.replace(/__PATH__/g, () => JSON.stringify(live[0]))
            .replace(/__PARENT__/g, () => JSON.stringify(parent))
            .replace(/__NAME__/g, () => JSON.stringify(args.name ?? ''))
            .replace('__OFFSET__', () => JSON.stringify(JSON.stringify(args.offset ?? []))),
        );
        if (r.error) return errorOutput(`${r.error}${r.path ? `: ${r.path}` : ''}`);
        placed = r.path ?? null;
      } else if (a.robloxAssetId) {
        const r = await d.studio.call('insert_asset', { assetId: a.robloxAssetId, assetName: args.name ?? a.name, parentPath: parent }, { timeoutMs: 120_000, signal });
        if (!r.ok) return errorOutput(r.error ?? 'insert_asset failed');
        const text = r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ');
        placed = parseAssetResult('insert_asset', {}, text).instancePaths[0] ?? null;
        if (placed && a.usageTag) await assets.tag([placed], a.usageTag);
      } else {
        return errorOutput('This asset has no live placement to clone and no Roblox asset id to re-insert.');
      }
      svc.addEvent(a.id, 'reused', caller.role ?? caller.kind, `placed a copy${placed ? ` at ${placed}` : ''}`, { parent }, caller.taskId, caller.runId);
      if (placed) svc.setInstancePaths(a.id, [...new Set([...a.instancePaths, placed])]);
      d.bus.emit('roblox.changed', { reason: 'call:asset_reuse' });
      d.bus.emit('assets.changed', { id: a.id });
      return jsonOutput({ id: a.id, placed });
    },
  });

  reg.register({
    name: 'map_audit',
    title: 'Audit a map area',
    description:
      'Measure how finished a built area looks, in numbers: surface materials and colours (plain plastic, grey), what is underfoot on a grid (holes, terrain, ground materials, flatness), how much ground has nothing nearby, the tallest landmark, giant flat ground parts, the lighting pieces, and what a builder gets wrong without seeing it: cover (a Cover attribute or tag) that characters walk through or step over or that shots pass through, unanchored parts, tiny parts that snag, precise collision on small props, shadowed lights, small shadow casters, coplanar faces that z-fight — with plain findings to fix. Pass the Workspace folder of the area ("Arena", "Map/Lobby"); without it the whole Workspace is measured. Run it before finishing map work and after each detail pass; it complements screenshots, it does not replace looking.',
    capability: 'roblox.app.inspect',
    permission: 'roblox_read',
    available: studioAvail,
    input: { area: z.string().optional(), grid: z.number().int().min(6).max(24).optional(), radius: z.number().min(4).max(40).optional(), step: z.number().min(0.5).max(40).optional().describe("Cover must collide at least this high over its base (default 3, an R15 character's step; for bigger characters their root part's bottom height + 1)") },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal }) => {
      const blocked = await editBlocked(caller, 'Edit', signal);
      if (blocked) return blocked;
      const r = await d.studio.runLuau(mapAuditLuau(args.area ?? '', args.grid ?? 12, args.radius ?? 12, args.step), 'Edit', 60_000, signal);
      if (!r.ok) return errorOutput(`map_audit failed: ${r.output}`);
      let m: MapAudit;
      try {
        m = JSON.parse(r.output) as MapAudit;
      } catch {
        return errorOutput(`map_audit returned no data: ${r.output.slice(0, 300)}`);
      }
      if (m.error) return errorOutput(m.error);
      const findings = mapFindings(m);
      return jsonOutput({ ...m, findings }, findings.length ? `${findings.length} finding(s) to fix` : 'Nothing stands out in the numbers — still look at screenshots.');
    },
  });

  reg.register({
    name: 'roblox_perf',
    title: 'Performance snapshot',
    description:
      'Measure the running place: instance/part/script counts, and during a playtest (datamodel "Server") physics, network and memory stats from the Stats service. Use before and after optimizations.',
    capability: 'roblox.app.perf',
    permission: 'roblox_read',
    available: studioAvail,
    input: { datamodel: dataModel.optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const code = `
local HttpService = game:GetService("HttpService")
local Stats = game:GetService("Stats")
local out = { instances = 0, baseParts = 0, meshParts = 0, scripts = 0, lights = 0, particleEmitters = 0, unanchoredParts = 0 }
for _, d in ipairs(game:GetDescendants()) do
  out.instances += 1
  if d:IsA("BasePart") then out.baseParts += 1; if not d.Anchored then out.unanchoredParts += 1 end end
  if d:IsA("MeshPart") then out.meshParts += 1 end
  if d:IsA("LuaSourceContainer") then out.scripts += 1 end
  if d:IsA("Light") then out.lights += 1 end
  if d:IsA("ParticleEmitter") then out.particleEmitters += 1 end
end
local function try(name, fn) local ok, v = pcall(fn) if ok then out[name] = v end end
try("memoryMb", function() return math.floor(Stats:GetTotalMemoryUsageMb()) end)
try("heartbeatMs", function() return math.floor(Stats.HeartbeatTimeMs * 100) / 100 end)
try("physicsStepMs", function() return math.floor(Stats.PhysicsStepTimeMs * 100) / 100 end)
try("dataReceiveKbps", function() return math.floor(Stats.DataReceiveKbps * 10) / 10 end)
try("dataSendKbps", function() return math.floor(Stats.DataSendKbps * 10) / 10 end)
try("awakeParts", function() return workspace:GetNumAwakeParts() end)
try("players", function() return #game:GetService("Players"):GetPlayers() end)
return HttpService:JSONEncode(out)`;
      return jsonOutput(await d.studio.luauJson(code, (args.datamodel ?? 'Edit') as DataModelType));
    },
  });

  reg.register({
    name: 'cloud_luau_run',
    title: 'Run Luau on the published place (Open Cloud)',
    description:
      'Run Luau headlessly on the project published place through Open Cloud (no Studio needed). Use for CI-style tests. It runs on a real game server: live DataStores are reachable, so never write production data. Return a table/string to get results; print() output is returned as logs. Limits: ~5 creates/min, ~30/hour, 5 min max.',
    capability: 'cloud.luau',
    permission: 'external',
    input: { script: z.string().min(1), timeout_sec: z.number().int().min(1).max(300).optional(), version: z.string().optional() },
    handler: async ({ args, signal }) => {
      const p = proj();
      const target = p.extras().cloud;
      if (!target.universeId || !target.placeId) return errorOutput('This project has no published universe/place id configured (Settings → Open Cloud).');
      const r = await d.cloud.run({ universeId: target.universeId, placeId: target.placeId, versionId: args.version ?? null, script: args.script, timeoutSec: args.timeout_sec }, signal);
      const summary = `${r.state} in ${r.durationMs} ms${r.error ? ` — ${r.error.code}: ${r.error.message}` : ''}${r.retryAfterSec ? ` (retry after ${r.retryAfterSec}s)` : ''}`;
      return r.ok ? jsonOutput({ results: r.results, logs: r.logs.slice(-200) }, summary) : { ...jsonOutput({ logs: r.logs.slice(-200) }, summary), isError: true };
    },
  });

  // ─── Code ─────────────────────────────────────────────────────────────────

  reg.register({
    name: 'luau_check',
    title: 'Luau static analysis',
    description: 'Run selene (lint) and luau-lsp (types vs the Roblox API) over the project or given paths.',
    capability: 'luau.check',
    permission: 'read',
    input: { paths: z.array(z.string()).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const checked = await d.luau.check(p.root, p.extras().syncMap, { paths: args.paths });
      // What Studio's compiler refuses and the analyzers let through (too many locals in one function: compile-limits.ts).
      // The scripts asked about (a file, or every script under a folder), or all of them.
      const asked = (args.paths ?? []).map((x) => x.replace(/\\/g, '/').replace(/\/$/, ''));
      let scripts = asked.filter((f) => /\.(?:luau|lua)$/i.test(f));
      try {
        const all = planSync(p.root, p.extras().syncMap).map((e) => e.file);
        scripts = asked.length ? [...scripts, ...all.filter((f) => asked.some((a) => f.startsWith(`${a}/`)))] : all;
      } catch {
        /* no code yet */
      }
      const r = { ...checked, problems: [...compileProblems(p.root, scripts), ...checked.problems] };
      const lines = r.problems.slice(0, 80).map((x) => `${x.file}:${x.line}:${x.column} ${x.severity} ${x.tool}/${x.code}: ${x.message}`);
      return textOutput(`${r.problems.length} problem(s) in ${r.durationMs} ms${r.toolErrors.length ? `\nTool errors: ${r.toolErrors.join('; ')}` : ''}\n${lines.join('\n')}`, r);
    },
  });

  reg.register({
    name: 'git_diff',
    title: 'Git diff',
    description: 'Show uncommitted changes (or since a commit) in the project repository.',
    capability: 'git.diff',
    permission: 'read',
    input: { since: z.string().optional(), stat: z.boolean().optional(), paths: z.array(z.string()).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const out = await p.git.diff({ from: args.since, stat: args.stat, paths: args.paths });
      const untracked = args.since ? '' : (await p.git.status()).filter((s) => s.index === '?').map((s) => s.path);
      return textOutput(truncate(`${out || '(no tracked changes)'}${untracked && untracked.length ? `\nUntracked files:\n${untracked.join('\n')}` : ''}`, 30000));
    },
  });

  // ─── Probe (integration self-test only) ───────────────────────────────────

  reg.register({
    name: 'probe_submit',
    title: 'Integration probe',
    description: 'Integration self-test: submit the nonce you were given.',
    capability: 'app.probe',
    permission: 'read',
    callerKinds: ['probe'],
    input: { nonce: z.string() },
    handler: async ({ args }) => {
      d.mcp()?.observeNonce(args.nonce);
      return textOutput(`Nonce ${args.nonce} received`);
    },
  });
}
