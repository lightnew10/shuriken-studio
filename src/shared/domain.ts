/**
 * Domain types shared by core and renderer. These are the application's own vocabulary:
 * nothing here may reference a specific AI provider's formats (see docs/ARCHITECTURE.md §2).
 */

export type HealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'unsupported'
  | 'needs_configuration'
  | 'unknown';

export type Severity = 'info' | 'success' | 'warning' | 'error';

// ─── Projects ────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface ProjectSettings {
  /** 'manual': never starts work on its own. 'supervised': runs, but escalations pause affected tasks. 'autonomous': runs continuously. */
  autonomy: 'manual' | 'supervised' | 'autonomous';
  maxConcurrentAgents: number;
  /** Default model alias per provider role tier; resolved by the provider adapter. */
  modelTier: { executive: ModelTier; worker: ModelTier; critic: ModelTier; research: ModelTier; chat?: ModelTier };
  maxAttemptsPerTask: number;
  /** Studio instance name/place the project is bound to (matched against list_roblox_studios). */
  robloxStudioMatch: string | null;
  /** Relative path of Luau source inside the project root. */
  sourceDir: string;
  escalation: EscalationRules;
  /** This project's permission mode; unset (or null) follows the app-wide preference. */
  permissionMode?: PermissionMode | null;
  /** This project's "Most agents at once" (1 to 32); unset (or null) follows the app-wide setting. */
  agentCap?: number | null;
  /** This project's Kiln builds at once; unset (or null) follows the app-wide setting. */
  kilnBuildsAtOnce?: number | null;
  /**
   * Keep building (this window): when a goal is done and the spec has a roadmap, the next milestone is planned and built
   * by itself, one after another (up to MAX_AUTO_MILESTONES), for a build left to run overnight. Unset or false (the
   * default): a finished goal stops there, and the director says the roadmap has more.
   */
  keepBuilding?: boolean | null;
  /**
   * Add QA passes to plans (this window): unset or true, the planner may add tasks whose job is to test other tasks; false,
   * it adds none (every task's own checks and the critic still run). The user cancelled QA tasks six times in one project.
   */
  autoQa?: boolean | null;
  /** The account this project's window uses, by provider (the top bar's menu); unset follows the app-wide default. */
  accounts?: Record<string, string>;
  /** The community (group) this project's uploads go to; unset (or null) follows the published game's owner, then Settings. */
  robloxGroupId?: string | null;
  /**
   * The Roblox account this project's uploads go to instead (set only when it has no community); unset follows the
   * published game's owner, then Settings. Its Open Cloud key, when it has one, is kept encrypted by name
   * (shared/roblox-keys.ts projectOpenCloudKey), never here.
   */
  robloxUserId?: string | null;
}

/**
 * How Shuriken's own agents ask the app's user for approval (hard safety denials are the same in both).
 * 'autonomous' (the default): nothing waits for the user — the AI system decides and logs it — except
 * what spends money or publishes the game, which asks in every mode. 'ask': the earlier behaviour, an
 * approval or question card per escalation rule.
 */
export type PermissionMode = 'autonomous' | 'ask';

export type ModelTier = 'fast' | 'balanced' | 'deep';

export interface EscalationRules {
  destructiveOperations: EscalationMode;
  publishing: EscalationMode;
  majorArchitectureChanges: EscalationMode;
  securitySensitive: EscalationMode;
  externalCommunications: EscalationMode;
  spending: EscalationMode;
  repeatedFailures: EscalationMode;
  irreversibleChanges: EscalationMode;
  scopeExpansion: EscalationMode;
}

/** 'ask': pause and wait for the user. 'notify': proceed and record. 'allow': proceed silently. 'deny': never. */
export type EscalationMode = 'ask' | 'notify' | 'allow' | 'deny';

// ─── Tasks ───────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'proposed'
  | 'ready'
  | 'running'
  | 'implemented'
  | 'verifying'
  | 'reviewing'
  | 'verified'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'escalated'
  | 'paused'
  | 'cancelled';

export type TaskKind =
  | 'objective'
  | 'research'
  | 'plan'
  | 'implement'
  | 'test'
  | 'review'
  | 'repair'
  | 'document';

/**
 * One way to check a task. `testId` (set where a task re-runs a check that is already registered, such as
 * a repair task for a failing regression test) names the registered test: its current spec runs and a
 * retired test is skipped, instead of a frozen copy of the spec running whatever the team decided since.
 */
export type VerificationMethod =
  | { kind: 'static_analysis'; paths?: string[]; testId?: string }
  | { kind: 'luau_assert'; name: string; luau: string; datamodel?: 'edit' | 'server' | 'client'; testId?: string }
  | { kind: 'playtest'; name: string; durationSec: number; luau?: string; /** A probe run in the Client DataModel (`luau` runs on the server). */ clientLuau?: string; failOnConsoleErrors: boolean; testId?: string }
  | { kind: 'screenshot'; name: string; instructions: string; camera?: [number, number, number]; lookAt?: [number, number, number]; testId?: string }
  | { kind: 'cloud_luau'; name: string; luau: string; timeoutSec?: number; testId?: string }
  | { kind: 'perf'; name: string; durationSec?: number; maxHeartbeatMs?: number; maxPhysicsStepMs?: number; maxMemoryMb?: number; maxInstances?: number; testId?: string }
  | { kind: 'critic' }
  | { kind: 'manual'; instructions: string };

export interface Task {
  id: string;
  parentId: string | null;
  kind: TaskKind;
  title: string;
  objective: string;
  reason: string;
  role: string;
  status: TaskStatus;
  priority: number;
  acceptanceCriteria: string[];
  verification: VerificationMethod[];
  requiredSkills: string[];
  requiredKnowledge: string[];
  tools: string[];
  files: string[];
  robloxSystems: string[];
  dependencies: string[];
  /** The dependencies that must be done (reviewed) before this task starts; the others only need their work to exist. */
  strictDependencies?: string[];
  /** When the task's agent last finished its work (it is on disk, checks and review may still run); null before, and once the task is cancelled or stuck. */
  landedAt?: string | null;
  attempts: number;
  maxAttempts: number;
  result: string | null;
  failureSummary: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TaskEvidence {
  id: string;
  taskId: string;
  runId: string | null;
  kind: 'test_result' | 'screenshot' | 'console' | 'diff' | 'datamodel_snapshot' | 'critic_review' | 'static_analysis' | 'note';
  title: string;
  passed: boolean | null;
  data: unknown;
  path: string | null;
  createdAt: string;
}

export interface TaskFailure {
  id: string;
  taskId: string;
  runId: string | null;
  attempt: number;
  stage: 'implement' | 'verify' | 'review' | 'provider' | 'capability';
  summary: string;
  detail: string | null;
  createdAt: string;
}

// ─── Agents & runs ───────────────────────────────────────────────────────────

export type RunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export interface AgentRun {
  id: string;
  taskId: string | null;
  role: string;
  providerId: string;
  model: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  contextPath: string | null;
  contextTokensEst: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  resultSummary: string | null;
  error: string | null;
  providerSessionId: string | null;
  /** The earlier run whose session this one carried on (a repair, a turn limit, an interruption). */
  continuesRunId: string | null;
}

export interface RunMessage {
  id: string;
  runId: string;
  seq: number;
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'result';
  content: unknown;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  runId: string | null;
  taskId: string | null;
  role: string | null;
  providerId: string | null;
  source: 'agent_mcp' | 'agent_builtin' | 'ui' | 'system';
  tool: string;
  capability: string | null;
  args: unknown;
  result: unknown;
  status: 'ok' | 'error' | 'denied' | 'pending';
  error: string | null;
  durationMs: number | null;
  startedAt: string;
  filesChanged: string[];
}

export interface TimelineEvent {
  id: string;
  ts: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: unknown;
  runId: string | null;
  taskId: string | null;
  role: string | null;
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export type KnowledgeScope = 'global' | 'roblox' | 'domain' | 'project' | 'task' | 'session';
export type KnowledgeCategory = 'authoritative' | 'research' | 'experimental' | 'project' | 'agent';
export type SourceAuthority = 'official' | 'staff' | 'community' | 'observed' | 'inference' | 'user';

export interface KnowledgeSource {
  kind: 'url' | 'file' | 'tool_call' | 'test' | 'run' | 'user';
  ref: string;
  title?: string;
  authority?: SourceAuthority;
  retrievedAt?: string;
}

export interface KnowledgeEntry {
  id: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
  sources: KnowledgeSource[];
  confidence: number;
  versionApplicability: string | null;
  domain: string | null;
  taskId: string | null;
  createdBy: string;
  status: 'active' | 'superseded' | 'disputed' | 'retracted';
  supersededBy: string | null;
  promotedFrom: string | null;
  validatedAt: string | null;
  validation: string | null;
  createdAt: string;
  updatedAt: string;
  /** Which store the entry lives in; set on read. */
  store?: 'global' | 'project';
}

export interface KnowledgeLink {
  fromId: string;
  toId: string;
  relation: 'supports' | 'contradicts' | 'supersedes' | 'relates' | 'derived_from';
  note: string | null;
}

// ─── Research ────────────────────────────────────────────────────────────────

export interface ResearchSession {
  id: string;
  taskId: string | null;
  question: string;
  status: 'open' | 'concluded' | 'abandoned';
  conclusion: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSource {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  authority: SourceAuthority;
  summary: string;
  retrievedAt: string;
}

export interface ResearchClaim {
  id: string;
  sessionId: string;
  sourceId: string | null;
  claim: string;
  confidence: number;
  status: 'supported' | 'contradicted' | 'unverified' | 'conflicting';
  notes: string | null;
  knowledgeId: string | null;
  createdAt: string;
}

// ─── Skills ──────────────────────────────────────────────────────────────────

export interface SkillSummary {
  name: string;
  description: string;
  scope: 'global' | 'project';
  path: string;
  tags: string[];
  robloxSystems: string[];
  versionApplicability: string | null;
}

export interface Skill extends SkillSummary {
  body: string;
}

// ─── Capabilities & health ───────────────────────────────────────────────────

export interface CapabilityRecord {
  id: string;
  integration: string;
  name: string;
  status: HealthStatus;
  description: string;
  version: string | null;
  detail: string | null;
  limitations: string[];
  schema: unknown;
  successCount: number;
  failureCount: number;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export interface HealthCheckResult {
  id: string;
  name: string;
  status: HealthStatus;
  message: string;
  durationMs: number;
  data?: unknown;
}

export interface IntegrationHealth {
  id: string;
  name: string;
  status: HealthStatus;
  summary: string;
  version: string | null;
  checks: HealthCheckResult[];
  checkedAt: string;
}

// ─── Governance ──────────────────────────────────────────────────────────────

export interface Decision {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  createdBy: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Escalation {
  id: string;
  taskId: string | null;
  runId: string | null;
  kind: 'approval' | 'question' | 'failure' | 'capability_missing' | 'spec_change';
  title: string;
  detail: string;
  options: string[];
  /**
   * auto_resolved: the AI system settled it itself (autonomous mode); `response` says how. It never waited for the user.
   * dismissed: closed without an answer, because it no longer applied (its task finished, was cancelled or replaced) or
   * the user (or the director at their word) cleared it; `response` says why. Nothing is done with its task.
   */
  status: 'open' | 'approved' | 'rejected' | 'answered' | 'cancelled' | 'auto_resolved' | 'dismissed';
  response: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SpecSection {
  key: string;
  title: string;
  body: string;
  status: 'draft' | 'approved';
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface Checkpoint {
  id: string;
  commitSha: string;
  label: string;
  kind: 'auto' | 'manual' | 'pre_task' | 'verified';
  taskId: string | null;
  runId: string | null;
  snapshotPath: string | null;
  createdAt: string;
}

export interface TestCase {
  id: string;
  name: string;
  kind: 'static' | 'luau' | 'playtest' | 'regression' | 'acceptance';
  spec: VerificationMethod;
  taskId: string | null;
  enabled: boolean;
  lastStatus: 'pass' | 'fail' | 'error' | 'skipped' | null;
  lastRunAt: string | null;
  createdAt: string;
  /** Why the test was retired (disabled with a record): its task was cancelled, an agent or the user retired it, or it was quarantined. */
  retiredReason: string | null;
  retiredAt: string | null;
  /** Who retired it: 'system:cancelled', 'quarantine', 'user', or an agent's role. */
  retiredBy: string | null;
}

export interface TestResult {
  id: string;
  testId: string;
  runId: string | null;
  taskId: string | null;
  status: 'pass' | 'fail' | 'error' | 'skipped';
  output: string;
  durationMs: number;
  createdAt: string;
}

export interface UsageObservation {
  id: string;
  providerId: string;
  kind: 'rate_limit' | 'cost' | 'tokens';
  data: unknown;
  observedAt: string;
}

// ─── Roblox ──────────────────────────────────────────────────────────────────

export interface RobloxStudioInstance {
  id: string;
  name: string;
}

export interface RobloxInstanceNode {
  name: string;
  className: string;
  path: string;
  childCount: number;
  children?: RobloxInstanceNode[];
}

export interface RobloxInstanceDetail {
  path: string;
  className: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  tags: string[];
  source?: string;
}

/** One message in a project's chat between the user and the director. */
export interface ChatMessage {
  id: string;
  /** copilot: a dock's copilot (see channel). */
  role: 'user' | 'director' | 'system' | 'copilot';
  /** The conversation it belongs to: "director" (the project's main chat) or "copilot:<dock>". */
  channel: string;
  /** text: plain message · plan: live plan card · question: needs an answer · status: short notice · error · done: milestone finished */
  kind: 'text' | 'plan' | 'question' | 'status' | 'error' | 'done';
  text: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

/** One of the project's animations (animations/<name>.anim.json). */
export interface AnimationSummary {
  name: string;
  description: string;
  loop: boolean;
  priority: string;
  duration: number;
  keys: number;
  joints: number;
  markers: Array<{ name: string; t: number }>;
  preset: string | null;
  /** A custom rig's model (the clip plays on ReplicatedStorage.ShurikenRigs.<rig>); null: R15. */
  rig: string | null;
  /** Roblox asset id when the current version is uploaded. */
  uploaded: string | null;
  updatedAt: string;
  /** Made in Kiln: the model and its clip there, the speed its feet travel (studs/s), in place or not. */
  kiln?: { model: string; clip: string; speed: number | null; inPlace: boolean };
  /** A draft made in the Animation dock: it plays in Shuriken and is not in the game until it is added. */
  draft?: boolean;
  /** The game's animation a draft is a new take of. */
  draftOf?: string;
}
