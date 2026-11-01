/**
 * Provider abstraction. The orchestrator, context compiler and every other part of core speak
 * ONLY these types. Provider adapters (src/core/providers/<id>/) translate them to a concrete AI
 * system and are the repair boundary when that system changes upstream.
 */
import type { HealthStatus, ModelTier } from '@shared/domain';

/** Capability flags a provider may support. Declared by the adapter, verified by probes. */
export interface ProviderCapabilities {
  toolUse: boolean;
  mcp: boolean;
  mcpHttp: boolean;
  subagents: boolean;
  parallelAgents: boolean;
  fileEditing: boolean;
  terminal: boolean;
  streaming: boolean;
  backgroundExecution: boolean;
  contextCompaction: boolean;
  longRunningSessions: boolean;
  structuredOutput: boolean;
  approvalWorkflow: boolean;
  sessionPersistence: boolean;
  imageInput: boolean;
  imageOutput: boolean;
  interruption: boolean;
  webResearch: boolean;
  costReporting: boolean;
  rateLimitReporting: boolean;
}

export type ProviderCapabilityKey = keyof ProviderCapabilities;

export interface ProviderDetection {
  installed: boolean;
  version: string | null;
  executable: string | null;
  detail: string;
}

export interface ProviderAuthStatus {
  authenticated: boolean;
  method: string | null;
  account: string | null;
  plan: string | null;
  detail: string;
}

/** Abstract classes of built-in agent tools; adapters map them to concrete tool names. */
export type BuiltinToolClass = 'read_files' | 'edit_files' | 'shell' | 'web_search' | 'web_fetch' | 'subagents' | 'todo';

/** An MCP server (Streamable HTTP) the agent must be connected to. */
export interface ToolServerRef {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface PermissionRequest {
  tool: string;
  toolClass: BuiltinToolClass | 'mcp' | 'other';
  input: Record<string, unknown>;
  mcpServer?: string;
  blockedPath?: string;
  reason?: string;
}

export type PermissionDecision =
  | { allow: true; updatedInput?: Record<string, unknown> }
  | { allow: false; message: string; interrupt?: boolean };

/** Specialist definition an agent may delegate to inside a single run (if subagents are supported). */
export interface SubagentSpec {
  name: string;
  description: string;
  instructions: string;
  tools: BuiltinToolClass[];
  modelTier?: ModelTier;
}

export interface AgentRunRequest {
  runId: string;
  role: string;
  /** Role instructions (provider-neutral prose). */
  instructions: string;
  /** The compiled context package + task statement. */
  prompt: string;
  cwd: string;
  additionalDirectories?: string[];
  modelTier: ModelTier;
  /** Explicit provider model id; overrides the tier mapping. */
  model?: string | null;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  toolServers: ToolServerRef[];
  builtinTools: BuiltinToolClass[];
  subagents?: SubagentSpec[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** JSON Schema the final result must satisfy. Adapters guarantee `completed.structured` natively or by emulation. */
  outputSchema?: Record<string, unknown>;
  permission: (req: PermissionRequest) => Promise<PermissionDecision>;
  signal: AbortSignal;
  /** Continue a previous provider session when the provider supports it (best effort, never required). */
  resumeSessionId?: string | null;
  /** Account-specific environment for the provider process (from IAgentProvider.accountEnv). */
  env?: Record<string, string>;
  /**
   * Pictures shown to the model with the prompt (base64): the user's attachments, a reference clip's frames. A
   * caption ("Frame at 12.40 s") goes right before its picture, so the model knows which is which.
   */
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; caption?: string }>;
}

/** `environment`: the agent runtime itself could not start or run (missing/blocked binary, spawn failure) — not the task's fault. */
export type CompletionErrorKind = 'max_turns' | 'budget' | 'execution' | 'auth' | 'rate_limit' | 'interrupted' | 'output_schema' | 'environment' | 'unknown';

export type AgentEvent =
  | {
      type: 'started';
      providerSessionId: string | null;
      model: string | null;
      providerVersion: string | null;
      tools: string[];
      toolServers: Array<{ name: string; status: string }>;
      authSource: string | null;
    }
  | { type: 'text'; text: string; partial: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; tool: string; toolClass: BuiltinToolClass | 'mcp' | 'other'; input: unknown; parentId: string | null }
  | { type: 'tool_result'; id: string; isError: boolean; output: unknown; parentId: string | null }
  | { type: 'rate_limit'; status: string; window: string | null; utilization: number | null; resetsAt: number | null; raw: unknown }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | {
      type: 'completed';
      ok: boolean;
      resultText: string | null;
      structured: unknown | null;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      numTurns: number;
      durationMs: number;
      stopReason: string | null;
      error: string | null;
      errorKind: CompletionErrorKind | null;
    };

export interface AgentRunHandle {
  readonly events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
}

export interface ProbeContext {
  /** A live MCP server URL + headers the probe can ask the agent to call (verifies tool use end-to-end). */
  probeServer: ToolServerRef | null;
  /** Resolves when the probe server observed the given nonce being submitted by the agent. */
  waitForProbeNonce: ((nonce: string, timeoutMs: number) => Promise<boolean>) | null;
  cwd: string;
  signal: AbortSignal;
}

export interface ProbeResult {
  id: string;
  name: string;
  status: HealthStatus;
  message: string;
  durationMs: number;
  /** Capabilities this probe verified (true) or disproved (false). */
  verified?: Partial<Record<ProviderCapabilityKey, boolean>>;
  data?: unknown;
}

export interface IProviderDiagnostics {
  /** Cheap checks (no model calls): install, version, compatibility. */
  quickChecks(): Promise<ProbeResult[]>;
  /** End-to-end checks that make a small model call (auth, streaming, tool use, MCP, structured output). */
  deepChecks(ctx: ProbeContext): Promise<ProbeResult[]>;
}

export interface IAgentProvider {
  readonly id: string;
  readonly displayName: string;
  /** Version of the adapter code; bump when the translation layer changes. */
  readonly adapterVersion: string;
  /** Provider versions this adapter was built and tested against (semver ranges or exact). */
  readonly testedVersions: string[];
  detect(): Promise<ProviderDetection>;
  auth(): Promise<ProviderAuthStatus>;
  /** Capabilities the adapter declares. The registry downgrades any a probe disproves. */
  declaredCapabilities(): ProviderCapabilities;
  diagnostics(): IProviderDiagnostics;
  modelForTier(tier: ModelTier): string;
  run(req: AgentRunRequest): AgentRunHandle;
  /** Environment that points the provider process at one account's credentials. */
  accountEnv?(accountDir: string): Record<string, string>;
  /** Interactive command that signs an account in (run in a terminal the user sees). */
  signInCommand?(accountDir: string): Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
  /** Auth status of one account (instead of the default login). */
  authFor?(accountDir: string | null): Promise<ProviderAuthStatus>;
  /**
   * A run is about to be continued (`resumeSessionId`) on the account in `toAccountDir` ('' = the default login):
   * when its session was left by a run on another account, bring it over. 'there': nothing to do; 'missing':
   * no account has it (the run will fail to continue and is started fresh).
   */
  carrySession?(sessionId: string, toAccountDir: string, fromAccountDirs: string[]): 'there' | 'carried' | 'missing';
}
