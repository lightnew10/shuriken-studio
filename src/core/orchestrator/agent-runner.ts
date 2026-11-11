import { relative, resolve, sep } from 'node:path';
import { newId, nowIso } from '@shared/ids';
import type { AgentRun, PermissionMode, RunStatus, Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { ProviderRegistry } from '../providers/provider-registry';
import type { AgentEvent, AgentRunRequest, IAgentProvider, PermissionDecision, PermissionRequest } from '../providers/types';
import type { ShurikenMcpServer } from '../mcp/mcp-server';
import type { ContextCompiler, ContextPackage } from '../context/context-compiler';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import { resetFromMessage, type UsageTracker } from './usage-tracker';
import type { AccountService } from '../accounts/account-service';
import { hiddenToolsFor, OUTPUT_SCHEMAS, tierFor, type RoleDefinition } from '../agents/roles';
import { approvalSignature, decideFileWrite, decideShell } from '../permissions/policy';
import { j, pj } from '../db/store';
import { releaseMutations, reserveMutation } from './mutations';
import { WORKSPACE_TOOLS, workspacePath } from '../capabilities/workspace-tools';

export type Completion = Extract<AgentEvent, { type: 'completed' }>;

export interface RunSpec {
  project: ProjectContext;
  role: RoleDefinition;
  task: Task | null;
  directive: string;
  /** Override the output contract (defaults to the role's). Pass null for free-form runs. */
  output?: RoleDefinition['output'] | null;
  signal: AbortSignal;
  maxBudgetUsd?: number;
  /**
   * A ready-made prompt that replaces the compiled context package (for light, fast runs such as
   * chat replies, which need a few hundred tokens of state rather than the full package).
   */
  contextText?: string;
  /**
   * Continue this provider session (see orchestrator/continuation.ts): the agent already has its
   * context, so the prompt is only `contextText` (or the directive), a brief for what comes next.
   */
  resumeSessionId?: string | null;
  /** The run whose session this one continues (recorded on the run). */
  continuesRunId?: string | null;
  /** Told the run's id as soon as it exists (a copilot's dock shows what it's doing live). */
  onRun?: (runId: string) => void;
  /** Pictures the user attached to the message this run answers. */
  images?: AgentRunRequest['images'];
  /** Calls the run doesn't make although its role has the tool (see CallerContext.refuses): the reason, or null to let it run. */
  refuses?: (tool: string, args: unknown) => string | null;
  /** Asked at each of the agent's Shuriken tool calls: a note for it (e.g. a prerequisite was reworked), added to that tool's result. */
  notes?: () => string | null;
}

export interface RunOutcome {
  run: AgentRun;
  completion: Completion;
  structured: unknown;
  context: ContextPackage;
  /** Files the agent edited through built-in tools (as observed in the stream). */
  editedFiles: string[];
  /** Usage/limit key of the account the run used. */
  usageKey: string;
}

interface RunRow {
  id: string;
  task_id: string | null;
  role: string;
  provider_id: string;
  model: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  context_path: string | null;
  context_tokens_est: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  num_turns: number;
  result_summary: string | null;
  error: string | null;
  provider_session_id: string | null;
  continues_run_id?: string | null;
  provider_session_meta?: string | null;
  cost_known?: number;
}

export function hydrateRun(r: RunRow): AgentRun {
  return {
    id: r.id,
    taskId: r.task_id,
    role: r.role,
    providerId: r.provider_id,
    model: r.model,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    contextPath: r.context_path,
    contextTokensEst: r.context_tokens_est,
    costUsd: r.cost_usd,
    costKnown: r.cost_known !== 0,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    numTurns: r.num_turns,
    resultSummary: r.result_summary,
    error: r.error,
    providerSessionId: r.provider_session_id,
    continuesRunId: r.continues_run_id ?? null,
  };
}

export interface RunnerDeps {
  providers: ProviderRegistry;
  mcp: ShurikenMcpServer;
  compiler: ContextCompiler;
  bus: EventBus;
  log: ScopedLogger;
  usage: UsageTracker;
  robloxStatus: () => Promise<string | null>;
  /** Approval signatures granted by the user (task-scoped) so an approved command can proceed on retry. */
  approvals: Set<string>;
  /** Signed-in provider accounts; runs use the active one (none = the provider's default login). */
  accounts?: AccountService;
  /** The effort a role runs at now (Settings → Agents → thinking); the role's own when absent. */
  effortFor?: (role: RoleDefinition) => RoleDefinition['effort'];
  /** The app version, recorded on every run: a session is only continued by the version that ran it. */
  appVersion?: string;
  /** The permission mode of a project (its own setting, else the app preference). Absent = 'ask', as before permission modes. */
  permissionMode?: (project: ProjectContext) => PermissionMode;
  /** The app's data folder: a shell command in autonomous mode may delete inside it (and the project) without asking. */
  dataDir?: string;
}

/**
 * Executes one agent run: compiles context, issues a scoped MCP token, runs the provider, and
 * turns the provider's event stream into persistent run records, audit entries and live UI events.
 */
/** The account's own usage limit (a session, weekly or plan limit with its reset), not overload or a passing 429. */
export function isUsageLimit(error: string | null | undefined): boolean {
  const t = (error ?? '').toLowerCase();
  if (/overloaded|\b5\d\d\b/.test(t)) return false;
  return /hit your (?:session|weekly|usage|daily|monthly) limit|usage limit|(?:session|weekly) limit|limit reached|resets \d{1,2}(?::\d{2})?\s*(?:am|pm)/.test(t);
}

/** What a run's calls get once its account is at its usage limit (AgentRunner.limitReached). */
export const AT_LIMIT = 'Your account is at its usage limit: nothing more runs until it resets. Stop here; your task carries on in this session after the reset.';

export class AgentRunner {
  private readonly active = new Map<string, { interrupt: () => Promise<void>; abort: AbortController; team: boolean; usageKey: string; pending: () => number }>();
  /** Accounts (usage keys) a run found at their usage limit, and when: their runs' calls are refused until there is room again. */
  private readonly atLimit = new Map<string, number>();
  /** Runs being interrupted from here (interrupt()): they end as interrupted, not failed. */
  private readonly interrupting = new Set<string>();
  /** Runs stopped because their account reached its usage limit: they end as cut off by the limit (work kept, attempt given back). */
  private readonly stoppedAtLimit = new Set<string>();

  constructor(private readonly deps: RunnerDeps) {}

  activeRuns(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Runs of the team building the game: not the chat-tier helpers (director, suggestion and idea writers, the image
   * check) nor the docks' copilots. Opening a project starts a suggestion writer at once, and Studio's recovery read
   * that as the team working and reopened a place the user had closed (the shooting-range project, 3 October).
   */
  teamRuns(): string[] {
    return [...this.active].filter(([, a]) => a.team).map(([id]) => id);
  }

  /** The app version runs are recorded with (see continuation.ts). */
  get appVersion(): string | null {
    return this.deps.appVersion ?? null;
  }

  async interrupt(runId: string): Promise<void> {
    const a = this.active.get(runId);
    if (!a) return;
    // Known before the provider stops: the run ends as interrupted however its stream ends.
    this.interrupting.add(runId);
    a.abort.abort();
    await a.interrupt().catch(() => {});
  }

  async interruptAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.interrupt(id)));
  }

  /**
   * A run hit its account's usage limit. Every other run on that account fails at its next request, yet what it already
   * asked for would still run: a playtest or checks waiting minutes in Studio's line, the rest of a batch of placements,
   * for answers no agent can read (a build drove Studio for four minutes after its limit). So from now on the account's
   * runs are refused every call, and the team's runs waiting on one stop now: interrupted, their tasks are ready again and
   * carry on in their own sessions after the reset. A run that is writing its answer is left to finish it.
   */
  private limitReached(project: ProjectContext, usageKey: string, runId: string): void {
    this.atLimit.set(usageKey, Date.now());
    const waiting = [...this.active].filter(([id, a]) => id !== runId && a.usageKey === usageKey && a.team && a.pending() > 0).map(([id]) => id);
    for (const id of waiting) {
      this.stoppedAtLimit.add(id);
      void this.interrupt(id);
    }
    if (waiting.length)
      project.audit.event({
        kind: 'limit.standdown',
        severity: 'warning',
        title: `Usage limit reached: ${waiting.length} agent${waiting.length === 1 ? '' : 's'} waiting on Studio or a tool stopped now, so nothing more runs for answers no agent can read; ${waiting.length === 1 ? 'it carries' : 'they carry'} on after the reset`,
        detail: { runs: waiting },
      });
    this.deps.bus.emit('usage.limit', { usageKey, projectId: project.summary.id });
  }

  getRun(project: ProjectContext, runId: string): AgentRun | null {
    const r = project.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', [runId]);
    return r ? hydrateRun(r) : null;
  }

  listRuns(project: ProjectContext, opts: { taskId?: string; limit?: number } = {}): AgentRun[] {
    const rows = opts.taskId
      ? project.store.all<RunRow>('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?', [opts.taskId, opts.limit ?? 100])
      : project.store.all<RunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', [opts.limit ?? 100]);
    return rows.map(hydrateRun);
  }

  async run(spec: RunSpec): Promise<RunOutcome> {
    const { project, role, task } = spec;
    const previous = spec.continuesRunId ? this.getRun(project, spec.continuesRunId) : null;
    const provider: IAgentProvider = spec.resumeSessionId && previous
      ? this.deps.providers.get(previous.providerId) ?? this.deps.providers.preferredForRole(role.id)
      : this.deps.providers.forRole(role.id);
    const resumeId = previous && previous.providerId !== provider.id ? null : spec.resumeSessionId ?? null;
    const account = this.deps.accounts?.active(provider.id) ?? null;
    const usageKey = this.deps.accounts ? this.deps.accounts.usageKey(provider.id, account) : provider.id;
    const startedMs = Date.now();
    // A run starting where there is room again lifts the refusal (a task assigned just before the limit may still start
    // its run after it: that one's calls stay refused).
    if (this.deps.usage.canStartRun(usageKey).ok) this.atLimit.delete(usageKey);
    // The PC's own login (dir '') needs no override: the provider uses its default credentials.
    const accountEnv = provider.id !== 'codex' && account?.dir && provider.accountEnv ? provider.accountEnv(account.dir) : undefined;
    const runId = newId('run');
    const settings = project.settings();
    const startedAt = nowIso();
    project.store.run(`INSERT INTO runs (id, task_id, role, provider_id, status, started_at, continues_run_id, app_version) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?)`, [runId, task?.id ?? null, role.id, provider.id, startedAt, spec.continuesRunId ?? null, this.deps.appVersion ?? null]);
    this.emitRun(project, runId);
    spec.onRun?.(runId);

    const sessionMeta = spec.continuesRunId ? pj<import('../providers/types').ProviderSessionMetadata | null>(project.store.get<{ provider_session_meta: string | null }>('SELECT provider_session_meta FROM runs WHERE id = ?', [spec.continuesRunId])?.provider_session_meta, null) : null;
    // Codex must always have a reconstructible full context if compatibility checks reject its cache.
    const brief = resumeId && provider.id !== 'codex' ? (spec.contextText ?? spec.directive) : null;
    const context: ContextPackage = brief
      ? { runId, role: role.id, taskId: task?.id ?? null, sections: [], text: brief, tokensEst: Math.round(brief.length / 4), budget: 0, omitted: [], path: null }
      : spec.contextText
      ? { runId, role: role.id, taskId: task?.id ?? null, sections: [], text: `${spec.directive}\n\n${spec.contextText}`, tokensEst: Math.round((spec.directive.length + spec.contextText.length) / 4), budget: 0, omitted: [], path: null }
      : this.deps.compiler.compile(project, {
          runId,
          role,
          task,
          directive: spec.directive,
          robloxStatus: await this.deps.robloxStatus().catch(() => null),
        });
    project.store.run('UPDATE runs SET context_path = ?, context_tokens_est = ? WHERE id = ?', [context.path, context.tokensEst, runId]);
    // A run continued after a switch of accounts: its session lives with the account that ran it, and is brought
    // over to the one that runs now (otherwise the provider finds no session and the agent starts over).
    if (resumeId && provider.carrySession && this.deps.accounts) {
      try {
        const dirs = [...this.deps.accounts.list(provider.id).map((a) => a.dir), ''];
        const how = provider.carrySession(resumeId, account?.dir ?? '', dirs);
        if (how === 'carried') project.audit.event({ kind: 'run.notice', title: `${role.name} continues on ${account?.label ?? 'the default login'} a session that began on another account`, runId, taskId: task?.id ?? null, role: role.id });
      } catch (e) {
        this.deps.log.warn('Could not bring a session over to the active account', errorMessage(e));
      }
    }
    project.audit.event({ kind: 'run.started', title: `${role.name} ${spec.continuesRunId ? 'continued' : 'started'}${task ? `: ${task.title}` : ''}`, runId, taskId: task?.id ?? null, role: role.id, detail: { provider: provider.id, account: account?.label ?? null, contextTokens: context.tokensEst, omitted: context.omitted, continues: spec.continuesRunId ?? null } });

    const abort = new AbortController();
    const toolsAbort = new AbortController();
    let calls = 0;
    let limitHit = false;
    const token = this.deps.mcp.issueToken({
      kind: 'agent',
      runId,
      taskId: task?.id ?? null,
      role: role.id,
      providerId: provider.id,
      projectRoot: project.root,
      allowedTools: role.appTools ? new Set(provider.id === 'codex'
        ? [...role.appTools, ...WORKSPACE_TOOLS, ...(role.appTools.includes('blender_python') ? ['blender_create_box'] : [])]
        : role.appTools) : null,
      builtinTools: role.builtinTools,
      executeCommand: provider.executeCommand?.bind(provider),
      builtinPermission: (req) => this.decide(project, req, { runId, taskId: task?.id ?? null, role: role.id, builtin: role.builtinTools, editOnly: role.editOnly }),
      runSignal: AbortSignal.any([abort.signal, toolsAbort.signal]),
      fileChange: (state, paths) => {
        project.audit.appendRunMessage(runId, seq++, 'system', { event: 'file_change', state, paths });
        for (const path of paths) if (state === 'completed') editedFiles.add(path);
      },
      hiddenTools: hiddenToolsFor(role),
      ...(role.drafts ? { drafts: true } : {}),
      // Once its account is at its usage limit, nothing more the run asks for is done (limitReached).
      refuses: (tool: string, args: unknown) => {
        if (abort.signal.aborted) return 'Run stopped';
        if (provider.id === 'codex' && ++calls > (role.maxTurns ?? 100)) { limitHit = true; abort.abort(); return 'Maximum tool calls reached'; }
        return this.atLimit.has(usageKey) ? AT_LIMIT : (spec.refuses?.(tool, args) ?? null);
      },
      ...(spec.notes ? { notes: spec.notes } : {}),
    });
    const onOuterAbort = () => abort.abort();
    // A stop that came in while the run was being set up must still stop it (the listener alone would miss it).
    if (spec.signal.aborted) abort.abort();
    else spec.signal.addEventListener('abort', onOuterAbort, { once: true });
    const output = spec.output === undefined ? role.output : spec.output;
    const editedFiles = new Set<string>();
    const pendingTools = new Map<string, { auditId: string; tool: string; input: unknown; started: number }>();
    // Every call the run is waiting on (Shuriken's own tools too): the usage limit's stand-down stops runs that wait.
    const waitingOn = new Set<string>();
    let seq = 0;
    let completion: Completion | null = null;

    try {
      const handle = provider.run({
        runId,
        role: role.id,
        instructions: role.instructions,
        prompt: context.text,
        cwd: project.root,
        modelTier: tierFor(role, settings.modelTier),
        ...(provider.id === 'codex' ? {
          providerSandbox: 'read-only' as const,
          stopTools: () => toolsAbort.abort(),
          permissionFingerprint: JSON.stringify([this.deps.permissionMode?.(project) ?? 'ask', project.settings().escalation, role.appTools, role.drafts, [...(hiddenToolsFor(role) ?? [])], role.editOnly?.toString()]),
        } : {}),
        effort: this.deps.effortFor?.(role) ?? role.effort,
        toolServers: [this.deps.mcp.refFor(token, 'shuriken')],
        builtinTools: role.builtinTools,
        maxTurns: role.maxTurns,
        maxBudgetUsd: spec.maxBudgetUsd,
        outputSchema: output ? OUTPUT_SCHEMAS[output] : undefined,
        permission: (req) => this.decide(project, req, { runId, taskId: task?.id ?? null, role: role.id, builtin: role.builtinTools, editOnly: role.editOnly }),
        signal: abort.signal,
        env: accountEnv,
        resumeSessionId: resumeId,
        sessionMetadata: sessionMeta,
        ...(spec.images?.length ? { images: spec.images } : {}),
      });
      this.active.set(runId, { interrupt: () => handle.interrupt(), abort, team: role.tier !== 'chat' && !role.id.startsWith('copilot'), usageKey, pending: () => waitingOn.size });

      let partialSaidAt = 0;
      for await (const ev of handle.events) {
        switch (ev.type) {
          case 'started': {
            if (ev.sessionMetadata) project.store.run('UPDATE runs SET provider_session_meta = ? WHERE id = ?', [j(ev.sessionMetadata), runId]);
            project.store.run(`UPDATE runs SET status = 'running', model = ?, provider_session_id = ? WHERE id = ?`, [ev.model, ev.providerSessionId, runId]);
            this.emitRun(project, runId);
            const shuriken = ev.toolServers.find((s) => s.name === 'shuriken');
            if (shuriken && shuriken.status !== 'connected') {
              project.audit.event({ kind: 'run.notice', severity: 'warning', title: `Shuriken MCP server status "${shuriken.status}" at agent start`, runId, taskId: task?.id ?? null, role: role.id });
            }
            project.audit.appendRunMessage(runId, seq++, 'system', { model: ev.model, providerVersion: ev.providerVersion, toolServers: ev.toolServers, authSource: ev.authSource, tools: ev.tools.length });
            break;
          }
          case 'text':
            // Every word an agent typed went to the window as its own message (no view reads the words: they only
            // show that the agent is writing): partial text goes out at most once a second per run.
            if (!ev.partial || Date.now() - partialSaidAt >= 1000) {
              if (ev.partial) partialSaidAt = Date.now();
              this.deps.bus.emit('run.stream', { runId, taskId: task?.id ?? null, kind: 'text', text: ev.text });
            }
            if (!ev.partial) project.audit.appendRunMessage(runId, seq++, 'text', ev.text);
            break;
          case 'thinking':
            project.audit.appendRunMessage(runId, seq++, 'thinking', ev.text.slice(0, 8000));
            this.deps.bus.emit('run.stream', { runId, taskId: task?.id ?? null, kind: 'thinking', text: ev.text.slice(0, 400) });
            break;
          case 'tool_call': {
            waitingOn.add(ev.id);
            project.audit.appendRunMessage(runId, seq++, 'tool_use', { id: ev.id, tool: ev.tool, input: ev.input, parentId: ev.parentId });
            this.deps.bus.emit('run.stream', { runId, taskId: task?.id ?? null, kind: 'tool_use', text: `${ev.tool} ${summarizeInput(ev.input)}` });
            // Shuriken MCP tools are audited server-side; built-in provider tools are audited here.
            if (!ev.tool.startsWith('mcp__shuriken__')) {
              const auditId = project.audit.beginToolCall({ runId, taskId: task?.id ?? null, role: role.id, providerId: provider.id, source: 'agent_builtin', tool: ev.tool, capability: `${provider.id}.${ev.toolClass}`, args: ev.input });
              pendingTools.set(ev.id, { auditId, tool: ev.tool, input: ev.input, started: Date.now() });
            }
            if (ev.toolClass === 'edit_files') {
              const input = ev.input as { file_path?: string; notebook_path?: string; changes?: Array<{ path?: string }> } | null;
              const fp = input?.file_path ?? input?.notebook_path;
              if (fp) editedFiles.add(fp);
              // Codex CLI emits one file_change item with all paths, rather than Claude's
              // individual Edit/Write tool calls. Preserve those paths for sync and audit.
              for (const change of input?.changes ?? []) if (typeof change.path === 'string') editedFiles.add(change.path);
            }
            break;
          }
          case 'tool_result': {
            waitingOn.delete(ev.id);
            project.audit.appendRunMessage(runId, seq++, 'tool_result', { id: ev.id, isError: ev.isError, output: clipOutput(ev.output) });
            const p = pendingTools.get(ev.id);
            if (p) {
              pendingTools.delete(ev.id);
              const fp = (p.input as { file_path?: string } | null)?.file_path;
              project.audit.endToolCall(p.auditId, { status: ev.isError ? 'error' : 'ok', result: clipOutput(ev.output), error: ev.isError ? String(clipOutput(ev.output)).slice(0, 2000) : null, durationMs: Date.now() - p.started, filesChanged: fp && !ev.isError && /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(p.tool) ? [fp] : [] });
            }
            break;
          }
          case 'rate_limit':
            this.deps.usage.recordRateLimit(usageKey, ev);
            break;
          case 'notice':
            project.audit.event({ kind: 'run.notice', severity: ev.level === 'warn' ? 'warning' : 'info', title: ev.message, runId, taskId: task?.id ?? null, role: role.id });
            break;
          case 'completed':
            completion = ev;
            break;
          case 'file_change':
            for (const path of ev.paths) if (ev.state === 'completed') editedFiles.add(path);
            break;
        }
      }
    } catch (e) {
      completion = { type: 'completed', ok: false, resultText: null, structured: null, costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, stopReason: null, error: errorMessage(e), errorKind: 'unknown' };
    } finally {
      spec.signal.removeEventListener('abort', onOuterAbort);
      this.active.delete(runId);
      toolsAbort.abort();
      this.deps.mcp.revokeToken(token);
      releaseMutations(project.root, runId);
      for (const p of pendingTools.values()) project.audit.endToolCall(p.auditId, { status: 'error', error: 'No result (run ended)', durationMs: Date.now() - p.started });
    }

    let comp: Completion = completion ?? { type: 'completed', ok: false, resultText: null, structured: null, costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, durationMs: 0, stopReason: null, error: 'Provider produced no completion', errorKind: 'unknown' };
    if (limitHit) comp = { ...comp, ok: false, errorKind: 'max_turns', error: 'Maximum number of tool calls reached' };
    project.store.run('UPDATE runs SET cost_known = ?, provider_session_meta = COALESCE(?, provider_session_meta) WHERE id = ?', [comp.costKnown === false ? 0 : 1, comp.sessionMetadata ? j(comp.sessionMetadata) : null, runId]);
    // Stopped from here (interrupt, a stop, the usage limit's stand-down): an interruption, whatever the provider made of it.
    const atLimit = this.stoppedAtLimit.delete(runId);
    if (!comp.ok && atLimit) comp = { ...comp, errorKind: 'rate_limit', error: 'Stopped at the usage limit: its account had reached it' };
    else if (!limitHit && !comp.ok && (abort.signal.aborted || this.interrupting.has(runId)) && comp.errorKind !== 'rate_limit' && comp.errorKind !== 'interrupted') comp = { ...comp, errorKind: 'interrupted', error: comp.error ?? 'Interrupted' };
    this.interrupting.delete(runId);
    const interrupted = comp.errorKind === 'interrupted' || spec.signal.aborted;
    const status: RunStatus = comp.ok ? 'completed' : interrupted ? 'interrupted' : 'failed';
    const summary = summarizeResult(comp);
    project.store.run(
      `UPDATE runs SET status = ?, ended_at = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, num_turns = ?, result_summary = ?, result_data = ?, error = ? WHERE id = ?`,
      [status, nowIso(), comp.costUsd, comp.inputTokens, comp.outputTokens, comp.numTurns, summary, j(comp.structured), comp.error, runId],
    );
    project.audit.appendRunMessage(runId, seq++, 'result', { ok: comp.ok, error: comp.error, errorKind: comp.errorKind, structured: comp.structured, text: comp.resultText?.slice(0, 4000) });
    this.deps.usage.recordRun(usageKey, comp.costUsd);
    if (comp.ok) {
      // A run that got through proves its account is not at a limit: the provider reports a limit only
      // when its status changes, so nothing else would lift one it recorded earlier.
      // A run that started before its account hit the limit and finished after proves nothing about now (its last
      // request went in before): lifting the limit for it would start tasks only to fail them again.
      const hit = this.atLimit.get(usageKey);
      if (hit === undefined || startedMs > hit) {
        this.deps.usage.recordSuccess(usageKey);
        this.atLimit.delete(usageKey);
      }
    } else if (comp.errorKind === 'rate_limit') {
      // Any run that hits a usage limit marks its account as limited, so the next pick switches accounts
      // (or waits for the reset) — for task runs and the director alike.
      // (A run this stopped at the limit adds nothing: the run that hit it recorded it.)
      if (!atLimit) {
        this.deps.usage.recordRateLimit(usageKey, { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: resetFromMessage(comp.error ?? ''), raw: { error: comp.error } });
        // Only the account's own usage limit stands the team down, not a moment of overload or a stray 429.
        if (isUsageLimit(comp.error)) this.limitReached(project, usageKey, runId);
      }
    }
    project.audit.event({
      kind: 'run.finished',
      severity: comp.ok ? 'success' : interrupted ? 'warning' : 'error',
      title: `${role.name} ${comp.ok ? 'finished' : interrupted ? 'interrupted' : 'failed'}${task ? `: ${task.title}` : ''}`,
      runId,
      taskId: task?.id ?? null,
      role: role.id,
      detail: { costUsd: comp.costUsd, turns: comp.numTurns, durationMs: comp.durationMs, error: comp.error, errorKind: comp.errorKind },
    });
    const run = this.emitRun(project, runId)!;
    return { run, completion: comp, structured: comp.structured, context, editedFiles: [...editedFiles], usageKey };
  }

  /**
   * A small call: one role, no tools, its structured answer (null when it failed). For what belongs to the app rather
   * than a game (the start page's game ideas) and for small jobs inside one (plain words, the thumbnail judge).
   * Counted in the account's usage like any run; not a run of the project. Given its `project`, its cost is booked
   * there (`cost_entries`, source = the role) so the build's API-equivalent cost includes it (costs/build-cost.ts).
   */
  async quick(spec: { role: RoleDefinition; prompt: string; cwd: string; signal: AbortSignal; images?: AgentRunRequest['images']; project?: ProjectContext | null; label?: string; taskId?: string | null }): Promise<{ structured: unknown; costUsd: number } | null> {
    const { role } = spec;
    const provider: IAgentProvider = this.deps.providers.forRole(role.id);
    const account = this.deps.accounts?.active(provider.id) ?? null;
    const usageKey = this.deps.accounts ? this.deps.accounts.usageKey(provider.id, account) : provider.id;
    const accountEnv = account?.dir && provider.accountEnv ? provider.accountEnv(account.dir) : undefined;
    let completion: Completion | null = null;
    try {
      const handle = provider.run({
        runId: newId('run'),
        role: role.id,
        instructions: role.instructions,
        prompt: spec.prompt,
        cwd: spec.cwd,
        modelTier: tierFor(role, {}),
        effort: role.effort,
        toolServers: [],
        builtinTools: [],
        maxTurns: role.maxTurns,
        outputSchema: role.output ? OUTPUT_SCHEMAS[role.output] : undefined,
        permission: async (): Promise<PermissionDecision> => ({ allow: false, message: 'No tools in this call.' }),
        signal: spec.signal,
        env: accountEnv,
        ...(spec.images?.length ? { images: spec.images } : {}),
      });
      for await (const ev of handle.events) {
        if (ev.type === 'rate_limit') this.deps.usage.recordRateLimit(usageKey, ev);
        else if (ev.type === 'completed') completion = ev;
      }
    } catch (e) {
      this.deps.log.warn(`${role.name} failed`, errorMessage(e));
      return null;
    }
    if (!completion) return null;
    this.deps.usage.recordRun(usageKey, completion.costUsd);
    if (completion.ok) this.deps.usage.recordSuccess(usageKey);
    if (spec.project && completion.costUsd > 0) this.book(spec.project, { source: role.id, label: spec.label ?? role.name, costUsd: completion.costUsd, taskId: spec.taskId ?? null });
    return completion.ok && completion.structured ? { structured: completion.structured, costUsd: completion.costUsd } : null;
  }

  /** A cost of the project that is not a run (a quick call): counted in the build's API-equivalent cost. */
  private book(project: ProjectContext, e: { source: string; label: string; costUsd: number; taskId: string | null }): void {
    try {
      project.store.run('INSERT INTO cost_entries (id, at, source, label, cost_usd, task_id) VALUES (?, ?, ?, ?, ?, ?)', [newId('cost'), nowIso(), e.source, e.label.slice(0, 200), e.costUsd, e.taskId]);
    } catch (err) {
      // A project that closed while the call ran: the account's usage still counts it.
      this.deps.log.warn('Could not book a call in the project', errorMessage(err));
    }
  }

  private emitRun(project: ProjectContext, runId: string): AgentRun | null {
    const run = this.getRun(project, runId);
    if (run) this.deps.bus.emit('run.updated', run);
    return run;
  }

  /** Policy for provider built-in tools (file edits, shell, web). */
  private async decide(project: ProjectContext, req: PermissionRequest, who: { runId: string; taskId: string | null; role: string; builtin?: RoleDefinition['builtinTools']; editOnly?: RoleDefinition['editOnly'] }): Promise<PermissionDecision> {
    const rules = project.settings().escalation;
    let decision: ReturnType<typeof decideShell> | null = null;
    let what = req.tool;
    if ((req.toolClass === 'edit_files' || req.toolClass === 'shell') && who.builtin && !who.builtin.includes(req.toolClass)) {
      // A class of built-in tool the role doesn't have (a dock copilot: no shell, and no file edits in a draft turn) is refused, whatever offered it.
      decision = { outcome: 'deny', notify: false, reason: `${who.role} has no ${req.toolClass === 'shell' ? 'shell' : 'file edits'} in this turn`, rule: null };
    } else if (req.toolClass === 'edit_files') {
      let path: string;
      try { path = workspacePath(project.root, String(req.input.file_path ?? req.input.notebook_path ?? ''), true, req.tool === 'workspace_write_file'); }
      catch (e) { return { allow: false, message: errorMessage(e) }; }
      decision = decideFileWrite(path, [project.root]);
      // A role that may edit only some files (a dock copilot putting its work in the game): everything else is refused.
      if (decision.outcome === 'allow' && who.editOnly && !who.editOnly(relative(project.root, resolve(path)).split(sep).join('/'))) decision = { outcome: 'deny', notify: false, reason: `${who.role} may not edit ${path}: it is outside its own field's files. Put what is needed there in your handoff for the director`, rule: null };
      if (decision.outcome === 'allow' && req.tool !== 'workspace_write_file') {
        try { reserveMutation(project.root, who.runId, [path]); }
        catch { decision = { outcome: 'deny', notify: false, reason: 'Another run owns this file', rule: null }; }
      }
      what = `${req.tool} ${path}`;
    } else if (req.toolClass === 'shell') {
      const cmd = String(req.input.command ?? '');
      decision = decideShell(cmd, rules, { mode: this.deps.permissionMode?.(project) ?? 'ask', roots: [project.root, ...(this.deps.dataDir ? [this.deps.dataDir] : [])], cwd: project.root });
      what = `${req.tool}: ${cmd.slice(0, 200)}`;
    } else if (req.toolClass === 'mcp' && !req.tool.startsWith('mcp__shuriken__')) {
      decision = { outcome: 'deny', notify: true, reason: 'Only the Shuriken MCP server is permitted for agents', rule: null };
    } else {
      decision = { outcome: 'allow', notify: false, reason: 'allowed', rule: null };
    }
    const signature = approvalSignature(who.taskId ?? who.runId, req.tool, req.input);
    if (decision.outcome === 'ask' && this.deps.approvals.has(signature)) decision = { ...decision, outcome: 'allow' };
    if (decision.outcome === 'allow') {
      if (req.toolClass === 'shell' && req.tool !== 'workspace_exec') {
        try { reserveMutation(project.root, who.runId, ['*']); }
        catch { return { allow: false, message: 'Another run owns a project mutation lease' }; }
      }
      // Autonomous mode: what would have asked the user runs, and the timeline records it as auto-approved.
      if (decision.autoApproved) project.audit.event({ kind: 'policy.auto_approved', severity: 'info', title: `Auto-approved: ${what}`.slice(0, 300), runId: who.runId, taskId: who.taskId, role: who.role, detail: { what, command: req.toolClass === 'shell' ? String(req.input.command ?? '').slice(0, 2000) : undefined, reason: decision.reason, rule: decision.rule } });
      else if (decision.notify) project.audit.event({ kind: 'policy.notify', severity: 'warning', title: decision.reason, runId: who.runId, taskId: who.taskId, role: who.role, detail: { what } });
      return { allow: true };
    }
    if (decision.outcome === 'ask') {
      project.governance.escalate({
        kind: 'approval',
        title: `Approve ${what}`,
        detail: `${decision.reason}\n\nRequested by ${who.role} during run ${who.runId}.\n\nInput:\n${JSON.stringify(req.input, null, 2).slice(0, 3000)}\n\nsignature:${signature}`,
        taskId: who.taskId,
        runId: who.runId,
        options: ['approve', 'reject'],
      });
      return { allow: false, message: `Needs human approval (${decision.reason}). An escalation was filed; do not retry. Continue with other work and mention this in your result.` };
    }
    project.audit.event({ kind: 'policy.denied', severity: 'warning', title: `Denied: ${what}`, runId: who.runId, taskId: who.taskId, role: who.role, detail: { reason: decision.reason } });
    return { allow: false, message: `Denied by Shuriken policy: ${decision.reason}` };
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const key = ['file_path', 'command', 'path', 'pattern', 'query', 'url', 'code', 'name'].find((k) => typeof o[k] === 'string');
  return key ? String(o[key]).slice(0, 160) : JSON.stringify(input).slice(0, 160);
}

function clipOutput(out: unknown): unknown {
  const s = typeof out === 'string' ? out : JSON.stringify(out);
  if (!s) return out;
  return s.length > 6000 ? `${s.slice(0, 6000)}…[${s.length - 6000} more]` : out;
}

function summarizeResult(c: Completion): string {
  const s = c.structured as { summary?: string; conclusion?: string; verdict?: string } | null;
  if (s?.summary) return `${s.verdict ? `[${s.verdict}] ` : ''}${s.summary}`.slice(0, 2000);
  if (s?.conclusion) return s.conclusion.slice(0, 2000);
  return (c.resultText ?? c.error ?? '').slice(0, 2000);
}

export function parseRunData<T>(raw: string | null): T | null {
  return pj<T | null>(raw, null);
}
