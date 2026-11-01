import type {
  AgentRun,
  Escalation,
  IntegrationHealth,
  Task,
  TimelineEvent,
  CapabilityRecord,
  UsageObservation,
  ChatMessage,
} from './domain';

export interface LogRecord {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
  data?: unknown;
  /** The project open in the window whose core wrote it (every window's core writes to the same file). */
  project?: string;
  /** That core's process id: lines written while no project is open are told apart by it. */
  pid?: number;
}

export interface RunStreamChunk {
  runId: string;
  taskId: string | null;
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'status';
  text: string;
}

export interface OrchestratorState {
  projectId: string;
  running: boolean;
  paused: boolean;
  /** Opened on hold: the project's unfinished work waits for the user (not a pause they chose). */
  held?: boolean;
  /** A timed pause resumes by itself at this time (ISO). */
  pausedUntil: string | null;
  /** Why ready work is not starting (e.g. every account at its usage limit), or null. */
  waiting: string | null;
  activeRuns: number;
  /** Agents that hold a place among the working ones (planning and agents that only wait don't): what the app-wide ceiling counts. */
  working?: number;
  /** How many agents may work at once right now, whether Auto chose it, and why it is that number ("14 ready, usage 41% of the 5-hour window"). */
  agents?: { limit: number; auto: boolean; why: string };
  queued: number;
  phase: string;
  currentObjectiveId: string | null;
  lastDecision: string | null;
  /**
   * A goal's final review is running (its regression suite, after every task is done): shown as an agent of its own,
   * since no agent run stands for it. Null when none runs.
   */
  finalCheck?: FinalCheck | null;
}

/** A goal's final review while it runs: which check, how far, since when, and since when it holds Studio. */
export interface FinalCheck {
  objectiveId: string;
  title: string;
  /** A quick change's checks rather than a goal's full suite. */
  iteration: boolean;
  /** The check running now (null before the first, or between them). */
  check: string | null;
  done: number;
  total: number;
  startedAt: string;
  /** When it got its turn in Studio (null: not yet, or the suite needs no Studio). */
  studioSince: string | null;
}

/** Events core pushes to the UI. Keys are channel names. */
export interface CoreEventMap {
  'timeline': TimelineEvent;
  'task.updated': Task;
  'task.deleted': { id: string };
  'run.updated': AgentRun;
  'run.stream': RunStreamChunk;
  'health.updated': IntegrationHealth;
  'capabilities.updated': { integration: string; capabilities: CapabilityRecord[] };
  'escalation.updated': Escalation;
  'orchestrator.state': OrchestratorState;
  'usage.observed': UsageObservation;
  /** What an account's usage shows changed without a new reading: a window reset, a limit ended or a good run cleared it. `providerId`: the usage key (null: all). */
  'usage.changed': { providerId: string | null };
  /** A run in this project hit its account's usage limit (orchestrator/agent-runner.ts limitReached). */
  'usage.limit': { usageKey: string; projectId: string };
  'accounts.changed': { providerId: string | null; activeId: string | null };
  'chat.message': ChatMessage & { projectId: string; projectName: string };
  /** channel: which conversation (the director's when absent); runId: the run working on the reply. */
  'chat.typing': { projectId: string; typing: boolean; channel?: string; runId?: string };
  /**
   * `paused`: planning stopped for a reason outside the plan (work paused or stopped, the app closing, a usage limit); it continues by itself.
   * `cancelled`: the plan update was cancelled (the user took the request back); it does not continue.
   */
  'plan.updated': { objectiveId: string; planTaskId: string; status: 'planning' | 'done' | 'failed' | 'paused' | 'cancelled'; summary?: string; milestone?: string; tasks?: number };
  'knowledge.changed': { id: string };
  'research.changed': { sessionId: string };
  'roblox.changed': { reason: string; paths?: string[] };
  'assets.changed': { id?: string };
  /** `stale`: clips changed in the project's files (Kiln's, say) and the place's animations need building again. */
  'animations.changed': { name?: string; stale?: boolean };
  /** The effects library changed (an effect, a texture or a cutscene was saved, built or removed). */
  'effects.changed': { name?: string };
  'modeling.status': { state: string; python: string | null; detail: string | null };
  'models.building': { name: string; state: 'building' | 'done' | 'failed'; by?: string };
  /** Blender modeling workspaces opened, closed, started or finished work. */
  'blender.workspaces': Record<string, never>;
  /** Kiln builds were queued, started, changed step or ended (the `kiln.builds` RPC has them). */
  'kiln.builds': Record<string, never>;
  /** A new UI capture was saved (by ui_audit or the UI panel). */
  'ui.changed': { screens?: number; findings?: number; /** UI icons the game has (ui_icon made or changed some). */ icons?: number };
  /** A UI mockup was made or changed (a version added, picked, or built into the game). */
  'ui.mockups': { name: string };
  /** A reference clip or picture was added, moved on in its analysis, or removed (core/references/). */
  'references.changed': { id?: string; status?: string };
  'project.changed': { projectId: string | null };
  /** New suggestion bubbles were written for a project's chat and docks. */
  'suggestions.changed': { projectId: string };
  /** The Storefront changed: its catalog, its copy or its pictures (storefront/storefront.ts). */
  'storefront.changed': { part: 'catalog' | 'copy' | 'art' | 'push' | 'prefs' };
  /** The start page's game ideas were written anew (director/start-ideas.ts). */
  'start.ideas': Record<string, never>;
  'prefs.changed': { keepScreenOn: boolean };
  'terminal.data': { id: string; data: string };
  'terminal.exit': { id: string; exitCode: number };
  'log': LogRecord;
}

export type CoreEventName = keyof CoreEventMap;

export interface CoreEvent<K extends CoreEventName = CoreEventName> {
  channel: K;
  payload: CoreEventMap[K];
}
