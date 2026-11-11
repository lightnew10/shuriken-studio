import { z } from 'zod';
import type { EscalationRules, PermissionMode } from '@shared/domain';
import type { AuditService } from '../audit/audit-service';
import type { ScopedLogger } from '../log';
import { decideToolCall, type PermissionClass, type PolicyDecision } from '../permissions/policy';
import { errorMessage } from '../log';
import { withStudioCaller } from '../roblox/studio-context';
import type { BuiltinToolClass, PermissionRequest, PermissionDecision } from '../providers/types';
import { isFreeApi } from '../providers/free-api';

/** Who is calling a tool. Resolved from the MCP bearer token or supplied by the UI/system. */
export interface CallerContext {
  coop?: boolean;
  projectRoot?: string;
  executeCommand?: (command: string, cwd: string, signal: AbortSignal, timeoutMs: number) => Promise<{ ok: boolean; output: string; error?: string }>;
  builtinTools?: readonly BuiltinToolClass[];
  builtinPermission?: (req: PermissionRequest) => Promise<PermissionDecision>;
  runSignal?: AbortSignal;
  fileChange?: (state: 'started' | 'completed' | 'failed', paths: string[]) => void;
  kind: 'agent' | 'ui' | 'system' | 'external' | 'probe';
  runId: string | null;
  taskId: string | null;
  role: string | null;
  providerId: string | null;
  /** If set, only these tool names are visible/callable. */
  allowedTools: ReadonlySet<string> | null;
  /** Tool names this caller doesn't see (another workshop's building tools, see roles.ts). */
  hiddenTools?: ReadonlySet<string> | null;
  /**
   * A dock copilot's draft turn (copilots/copilot-roles.ts): what this caller's workshop tools make stays a draft
   * in Shuriken, shown in its dock. They never build into Studio, upload, or write the game's code for it.
   */
  drafts?: boolean;
  /** A call this caller doesn't make although it has the tool (a dock copilot asking Kiln for a new model): why, said to it instead of running. */
  refuses?: (tool: string, args: unknown) => string | null;
  /** A note for this caller, if one is waiting (the orchestrator's: a prerequisite was reworked); added to the tool's result. */
  notes?: () => string | null;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolOutput {
  /** Human/model-readable content. */
  content: ToolContent[];
  /** Machine-readable result (stored in audit, returned as structuredContent). */
  data?: unknown;
  isError?: boolean;
  filesChanged?: string[];
}

/**
 * What a long tool call tells its caller while it works. Over MCP it becomes progress notifications, which
 * keep a client from giving up on a call that goes quiet for minutes (a client that sent no progress token
 * gets none).
 */
export type ToolProgress = (update: { message?: string }) => void;

export interface ToolInvocation<A> {
  caller: CallerContext;
  args: A;
  signal: AbortSignal;
  /** Present when the caller wants progress (an MCP client that sent a progress token). */
  progress?: ToolProgress;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  builtinClass?: BuiltinToolClass;
  providerScope?: 'codex-only' | 'exclude-codex';
  name: string;
  title: string;
  description: string;
  /** Capability id this tool exercises (links to the capability registry for health + reliability). */
  capability: string;
  permission: PermissionClass;
  input: S;
  /** Arguments the input doesn't name are refused (by name) instead of dropped: a misspelt field must not silently do nothing. */
  strict?: boolean;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Roles allowed to see this tool; omitted = all agent roles. */
  roles?: string[];
  /** Hidden from agents unless the caller is of one of these kinds. */
  callerKinds?: CallerContext['kind'][];
  /** Tool is only available when this returns true (e.g. Studio connected). Checked at call time. */
  available?: () => { ok: boolean; reason?: string };
  /**
   * The call is a wait for something outside the agent (a Kiln build, an upload, Studio's turn): while it runs,
   * the agent holds no place among the working agents (the orchestrator starts ready work beside it).
   */
  waits?: boolean;
  handler: (inv: ToolInvocation<z.infer<z.ZodObject<S>>>) => Promise<ToolOutput>;
}

export class ToolDeniedError extends Error {
  constructor(
    message: string,
    readonly escalate: boolean,
  ) {
    super(message);
  }
}

export interface PolicyContext {
  rules: () => EscalationRules;
  /**
   * The permission mode in effect (project override, else the app preference). Absent = 'ask', the behaviour
   * before permission modes. Spending and publishing ask in every mode (permissions/owner-gate.ts).
   */
  mode?: () => PermissionMode;
  /** A call of a tool that only waits (ToolDefinition.waits) started or ended. */
  waiting?: (caller: CallerContext, on: boolean) => void;
  /** Called when a call needs human approval. Returns true if already approved (e.g. standing approval). */
  requestApproval: (caller: CallerContext, tool: string, reason: string, args: unknown) => Promise<boolean>;
  notify: (caller: CallerContext, tool: string, reason: string) => void;
}

export interface CapabilityObserver {
  record(capability: string, ok: boolean, error?: string | null): void;
}

/**
 * The capability layer: one registry of high-value tools, one invocation pipeline
 * (visibility → availability → validation → policy → audit → handler → audit → reliability stats).
 * The MCP server and the UI both call tools through `invoke`.
 */
export class ToolRegistry {
  private readonly activeCalls = new Map<string, Set<Promise<ToolOutput>>>();
  private readonly approvalStops = new WeakMap<CallerContext, Set<string>>();
  private stopApprovalRetries(caller: CallerContext, tool: string): void {
    if (caller.providerId !== 'codex' && !isFreeApi(caller.providerId ?? '')) return;
    const stopped = this.approvalStops.get(caller) ?? new Set<string>();
    stopped.add(tool);
    this.approvalStops.set(caller, stopped);
  }
  private readonly tools = new Map<string, ToolDefinition<any>>();
  private audit: AuditService | null = null;

  constructor(
    private readonly policy: PolicyContext,
    private readonly observer: CapabilityObserver,
    private readonly log: ScopedLogger,
  ) {}

  /** Audit is per-project; re-attached when the active project changes. */
  attachAudit(audit: AuditService | null): void {
    this.audit = audit;
  }

  register<S extends z.ZodRawShape>(def: ToolDefinition<S>): void {
    if (this.tools.has(def.name)) throw new Error(`Duplicate tool ${def.name}`);
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(def.name)) throw new Error(`Invalid tool name ${def.name}`);
    this.tools.set(def.name, def as ToolDefinition<any>);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  visibleTo(caller: CallerContext): ToolDefinition[] {
    return [...this.tools.values()].filter((t) => this.isVisible(t, caller));
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  private isVisible(t: ToolDefinition, caller: CallerContext): boolean {
    const controlled = caller.providerId === 'codex' || isFreeApi(caller.providerId ?? '');
    if (t.providerScope === 'codex-only' && !controlled) return false;
    if ((t.providerScope === 'exclude-codex' || t.capability === 'app.plugins') && controlled) return false;
    if (t.builtinClass && !controlled) return false;
    if (t.builtinClass === 'shell' && !caller.executeCommand) return false;
    if (t.builtinClass && (!caller.builtinTools?.includes(t.builtinClass) || !caller.builtinPermission)) return false;
    if (caller.allowedTools && !caller.allowedTools.has(t.name)) return false;
    if (caller.hiddenTools?.has(t.name)) return false;
    if (t.callerKinds && !t.callerKinds.includes(caller.kind)) return false;
    if (caller.kind === 'agent' && t.roles && caller.role && !t.roles.includes(caller.role)) return false;
    return true;
  }

  async invoke(name: string, rawArgs: unknown, caller: CallerContext, signal: AbortSignal = new AbortController().signal, progress?: ToolProgress): Promise<ToolOutput> {
    const result = this.invokeTool(name, rawArgs, caller, signal, progress);
    if (!caller.runId) return result;
    const runId = caller.runId;
    const active = this.activeCalls.get(runId) ?? new Set<Promise<ToolOutput>>();
    active.add(result);
    this.activeCalls.set(runId, active);
    try { return await result; }
    finally {
      active.delete(result);
      if (!active.size) this.activeCalls.delete(runId);
    }
  }

  /** Call only after closing the run's tool gate. The next run must see settled effects. */
  async drain(runId: string): Promise<void> {
    await Promise.allSettled(this.activeCalls.get(runId) ?? []);
  }

  private async invokeTool(name: string, rawArgs: unknown, caller: CallerContext, signal: AbortSignal, progress?: ToolProgress): Promise<ToolOutput> {
    if (caller.runSignal) signal = AbortSignal.any([signal, caller.runSignal]);
    if (signal.aborted) return errorOutput('Run stopped');
    const def = this.tools.get(name);
    if (!def || !this.isVisible(def, caller)) {
      return errorOutput(`Unknown or unavailable tool: ${name}`);
    }
    // A call outside the caller's field is refused before anything else is looked at (whether the tool could run or not).
    const refusal = caller.refuses?.(name, rawArgs ?? {});
    if (refusal) return errorOutput(refusal);
    if (this.approvalStops.get(caller)?.size && def.permission !== 'read' && def.permission !== 'roblox_read') {
      return errorOutput('Approval was not granted. Continue with read-only work and do not try a different tool for the same effect.');
    }
    const avail = def.available?.();
    if (avail && !avail.ok) {
      this.observer.record(def.capability, false, avail.reason ?? 'unavailable');
      return errorOutput(`Capability ${def.capability} is unavailable: ${avail.reason ?? 'integration not healthy'}. Check capabilities_query before relying on it.`);
    }
    const parsed = (def.strict ? z.strictObject(def.input) : z.object(def.input)).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorOutput(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    }

    if (def.builtinClass) {
      const args = parsed.data as Record<string, unknown>;
      const decision = await caller.builtinPermission!({ tool: name, toolClass: def.builtinClass, input: { ...args, ...(typeof args.path === 'string' ? { file_path: args.path } : {}) } });
      if (!decision.allow) {
        if (decision.message.startsWith('Needs human approval')) this.stopApprovalRetries(caller, name);
        return errorOutput(decision.message);
      }
    }

    let decision: PolicyDecision = caller.kind === 'ui' ? { outcome: 'allow', notify: false, reason: 'user action', rule: null } : decideToolCall({ permission: def.permission, tool: name, title: def.title, args: parsed.data }, this.policy.rules(), this.policy.mode?.() ?? 'ask');
    const ordinaryCoopWrite = /^(workspace_write_file|roblox_sync_push|blender_create_box|task_update_verification|task_add_evidence)$/.test(name);
    const readOnly = (def.permission === 'read' || def.permission === 'roblox_read') && !/(run_luau|playtest|execute|publish|upload)/i.test(name);
    if (caller.coop && decision.outcome !== 'deny' && !readOnly && !ordinaryCoopWrite) {
      decision = { outcome: 'ask', notify: true, owner: true, reason: 'This collaboration action requires the project host’s approval', rule: decision.rule };
    }
    const auditId =
      this.audit?.beginToolCall({
        runId: caller.runId,
        taskId: caller.taskId,
        role: caller.role,
        providerId: caller.providerId,
        source: caller.kind === 'agent' || caller.kind === 'probe' ? 'agent_mcp' : caller.kind === 'ui' ? 'ui' : 'system',
        tool: name,
        capability: def.capability,
        args: parsed.data,
      }) ?? null;
    const started = performance.now();

    if (decision.outcome === 'deny') {
      this.audit?.endToolCall(auditId!, { status: 'denied', error: decision.reason, durationMs: 0 });
      return errorOutput(`Denied by policy: ${decision.reason}`);
    }
    if (decision.outcome === 'ask') {
      const approved = await this.policy.requestApproval(caller, name, decision.reason, parsed.data);
      if (!approved) {
        this.stopApprovalRetries(caller, name);
        this.audit?.endToolCall(auditId!, { status: 'denied', error: `awaiting approval: ${decision.reason}`, durationMs: 0 });
        return errorOutput(
          `Requires human approval: ${decision.reason}. An escalation has been filed for the user. Do not retry this call; continue with work that does not depend on it, and mention it in your final report.`,
        );
      }
    }
    if (signal.aborted) {
      this.audit?.endToolCall(auditId!, { status: 'denied', error: 'Run stopped', durationMs: 0 });
      return errorOutput('Run stopped');
    }
    if (decision.autoApproved) {
      // Autonomous mode: what would have asked the user runs, and the timeline says it was auto-approved.
      this.audit?.event({ kind: 'policy.auto_approved', severity: 'info', title: `Auto-approved: ${def.title}`, runId: caller.runId, taskId: caller.taskId, role: caller.role, detail: { tool: name, reason: decision.reason, rule: decision.rule, args: summarizeArgs(parsed.data) } });
    } else if (decision.notify) this.policy.notify(caller, name, decision.reason);

    try {
      // Studio calls made inside the handler know whose they are (see roblox/studio-context.ts).
      const studioCaller = { owner: caller.runId ?? `${caller.kind}:${caller.role ?? 'user'}`, kind: caller.kind, signal, ...(progress ? { progress: (message: string) => progress({ message }) } : {}) };
      if (def.waits) this.policy.waiting?.(caller, true);
      let out: ToolOutput;
      try {
        out = await withStudioCaller(studioCaller, () => def.handler({ caller, args: parsed.data, signal, ...(progress ? { progress } : {}) }));
      } finally {
        if (def.waits) this.policy.waiting?.(caller, false);
      }
      const ms = performance.now() - started;
      this.audit?.endToolCall(auditId!, {
        status: out.isError ? 'error' : 'ok',
        result: out.data ?? summarizeContent(out.content),
        error: out.isError ? summarizeContent(out.content) : null,
        durationMs: ms,
        filesChanged: out.filesChanged,
      });
      this.observer.record(def.capability, !out.isError, out.isError ? summarizeContent(out.content) : null);
      // Something the running agent should know now rides along with whatever it just asked for.
      const note = caller.notes?.();
      return note ? { ...out, content: [...out.content, { type: 'text', text: note }] } : out;
    } catch (e) {
      const msg = errorMessage(e);
      this.log.warn(`Tool ${name} failed`, { error: msg, caller: caller.role });
      this.audit?.endToolCall(auditId!, { status: 'error', error: msg, durationMs: performance.now() - started });
      this.observer.record(def.capability, false, msg);
      return errorOutput(`${name} failed: ${msg}`);
    }
  }
}

export function textOutput(text: string, data?: unknown): ToolOutput {
  return { content: [{ type: 'text', text }], data };
}

export function jsonOutput(data: unknown, summary?: string): ToolOutput {
  const text = JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text: summary ? `${summary}\n${text}` : text }], data };
}

export function errorOutput(text: string): ToolOutput {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The arguments of a call, short enough for a timeline entry. */
function summarizeArgs(args: unknown): string {
  try {
    return JSON.stringify(args)?.slice(0, 600) ?? '';
  } catch {
    return '';
  }
}

function summarizeContent(content: ToolContent[]): string {
  return content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType}]`))
    .join('\n')
    .slice(0, 4000);
}
