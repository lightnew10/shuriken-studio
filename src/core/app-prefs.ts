import { DEFAULT_POLISH, polishLevel, type PolishLevel } from './orchestrator/proposal-triage';
import { nowIso } from '@shared/ids';
import type { PermissionMode } from '@shared/domain';
import { j, pj, type Store } from './db/store';
import { DEFAULT_AGENT_CAP, MAX_FIXED_AGENTS, PROJECT_MAX_AGENTS, STUDIO_AGENTS, studioLimit } from './orchestrator/concurrency';
import { KILN_BUILDS_DEFAULT, clampBuilds } from './modeling/kiln-queue';
import { communityId } from './roblox/upload-owner';

/** App-wide preferences: they apply to every project, and to projects created later. */
/** The efforts Settings offer, for the planner and for every other agent. */
export const EFFORTS = ['medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const PLANNER_EFFORTS = EFFORTS;
export type PlannerEffort = Effort;

export interface AppPrefs {
  /** Agents working at once: 0 = automatic (up to agentCap, chosen from the ready work and Studio's room: orchestrator/concurrency.ts), else 1–32. */
  maxConcurrentAgents: number;
  /** Save the place in Studio after verified world changes. */
  autoSave: boolean;
  /** Upload generated sounds and models to Roblox (free; needs an Open Cloud key with the Assets API). */
  uploadAssets: boolean;
  /** The Roblox user uploads go to (found from Studio when empty). */
  robloxCreatorId: string;
  /** The community (group) uploads go to by default ('' none): communities are the standard (roblox/upload-owner.ts). */
  robloxGroupId: string;
  /** Keep the screen on while agents work: Studio can only take screenshots of a visible window. */
  keepScreenOn: boolean;
  /** blender.exe for 3D modeling ('' = found automatically). */
  blenderPath: string;
  /** Models that can be worked on at once, each in its own Blender (1–8). */
  modelingWorkspaces: number;
  /**
   * Let the agents' own Blender Python (the fallback for when Kiln can't build a model) run inside Kiln's Blender when
   * Kiln runs (each model a Kiln project). Off by default (unset counts as off): that Python runs in Shuriken's own
   * Blender. Either way every model is asked of Kiln's copilot first (kiln_request).
   */
  modelInKiln: boolean;
  /** Kiln.exe ('' = the target of the Desktop's Kiln shortcut). */
  kilnPath: string;
  /** Start Kiln (in the background) when Shuriken starts, unless it's already running. */
  startKilnWithShuriken: boolean;
  /** Start Kiln (in the background) when a build needs a model and it isn't running (on by default: every model is Kiln's). */
  startKilnWhenNeeded: boolean;
  /**
   * Kiln builds (kiln_request) that run at once, 1-20; the rest wait in Shuriken's queue. Against a Kiln older than
   * 0.8.2 at most 6 run whatever this says, and the queue lowers its own limit when builds fail or slow (kiln-queue.ts).
   */
  kilnBuildsAtOnce: number;
  /**
   * Shuriken Link: keep Shuriken's plugin in Roblox Studio's Plugins folder and run Luau through it (roblox/link/
   * plugin.ts). On by default; off removes the plugin file and Luau goes through Studio's MCP server alone.
   */
  studioLink: boolean;
  /** The Kiln page shows Kiln docked in Shuriken's window (off: Kiln opens in its own window). */
  dockKiln: boolean;
  /**
   * How deeply every agent but the planner thinks (specialists, critic, researcher, analyst, copywriter, the director's
   * replies, the dock copilots): 'high' by default (1.15.3, the user's choice). Replaces 1.15.2's thorough/faster
   * switch ('faster' was medium, and is read as medium).
   */
  agentEffort: Effort;
  /**
   * The most agents at once in a project (Settings' slider, 1 to 32; 8 by default). Auto starts an agent for every ready
   * task up to it. 1.15.2's fixed number (maxConcurrentAgents) is read as this cap, and the scheduler then runs on Auto.
   * A default saved by an earlier version is read as today's (`agentCapV`, see get); a number picked otherwise stays.
   */
  agentCap: number;
  /** 3 once the agent limits were saved under this version's defaults (see get). */
  agentCapV?: number;
  /**
   * The most of a build's agents that work in Studio at once (Settings' slider, 1 to 16; 4 by default): the rest write
   * code, sounds and models meanwhile. orchestrator/concurrency.ts has the measurements behind it.
   */
  studioAgents: number;
  /** How deeply the planner thinks, for every plan and triage (its misses cost the team far more than its minutes): 'max' by default (1.15.3). */
  plannerEffort: PlannerEffort;
  /**
   * How much work a goal's follow-ups (the improvements and defects agents propose while they build) may add to its
   * plan: orchestrator/proposal-triage.ts FOLLOW_UP_BUDGET. 'light' (the default): a quarter of the plan's size in polish tasks.
   * 'unlimited': no budget, as before 1.13.5 (two builds then made 119 and 85 polish tasks for plans of 24 and 33).
   */
  polish: PolishLevel;
  /**
   * The Storefront (storefront/storefront.ts), on by default. monetization: every new game's plan has a store designed
   * for its genre (game passes and developer products, built into the game, pushed to Roblox only by the user) and
   * icons for it; off, games are built with no store at all. copy: the game's title, description and item texts are
   * written by the copywriter. With both off the Storefront disappears from the app.
   */
  monetization: boolean;
  copy: boolean;
  /**
   * 'autonomous' (default): agents never wait for the user — the AI system decides approvals, blocked tasks and
   * questions — except what spends money or publishes the game. 'ask': approval and question cards as before.
   * A project may override it (ProjectSettings.permissionMode).
   */
  permissionMode: PermissionMode;
}

export const DEFAULT_APP_PREFS: AppPrefs = { permissionMode: 'autonomous', maxConcurrentAgents: 0, autoSave: true, uploadAssets: true, robloxCreatorId: '', robloxGroupId: '', keepScreenOn: true, blenderPath: '', modelingWorkspaces: 8, modelInKiln: false, kilnPath: '', startKilnWithShuriken: false, startKilnWhenNeeded: true, kilnBuildsAtOnce: KILN_BUILDS_DEFAULT, dockKiln: true, agentEffort: 'high', agentCap: DEFAULT_AGENT_CAP, agentCapV: 3, studioAgents: STUDIO_AGENTS, plannerEffort: 'max', polish: DEFAULT_POLISH, studioLink: true, monetization: true, copy: true };

const KEY = 'app.prefs';

export class AppPrefsService {
  constructor(private readonly global: Store) {}

  get(): AppPrefs {
    const raw = this.global.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [KEY])?.value ?? null;
    // Play windows (an extra Studio per project for playtests, 1.13.3-1.13.7) were dropped: their old setting is forgotten.
    const { playWindows: _gone, agentThinking, ...stored } = pj<Partial<AppPrefs> & { playWindows?: number; agentThinking?: string }>(raw, {});
    // 1.15.2's thinking switch: 'faster' was medium effort.
    if (stored.agentEffort === undefined && agentThinking === 'faster') stored.agentEffort = 'medium';
    // 1.15.2's fixed number of agents becomes the slider's cap (Auto under it).
    if (stored.agentCap === undefined && typeof stored.maxConcurrentAgents === 'number' && stored.maxConcurrentAgents > 0) {
      stored.agentCap = stored.maxConcurrentAgents;
      stored.maxConcurrentAgents = 0;
    }
    // 1.16: a cap saved under the old rules (up to 20) above 1.16's default (4) became 4.
    if (stored.agentCapV === undefined || stored.agentCapV < 2) {
      if (typeof stored.agentCap === 'number' && stored.agentCap > 4) stored.agentCap = 4;
      if (typeof stored.maxConcurrentAgents === 'number' && stored.maxConcurrentAgents > 8) stored.maxConcurrentAgents = 8;
      stored.agentCapV = 2;
    }
    // 1.16.1: 8 agents per build by default and 4 in Studio. 1.16.0's defaults saved as they were (4 and 2: any change in
    // Settings wrote them back) become the new ones, and so does Studio's slider at its old top (3, as many as it
    // allowed, now below the default); a number picked otherwise stays.
    if (stored.agentCapV === 2) {
      if (stored.agentCap === undefined || stored.agentCap === 4) stored.agentCap = DEFAULT_AGENT_CAP;
      if (stored.studioAgents === undefined || stored.studioAgents === 2 || stored.studioAgents === 3) stored.studioAgents = STUDIO_AGENTS;
      stored.agentCapV = 3;
    }
    return { ...DEFAULT_APP_PREFS, ...stored };
  }

  set(patch: Partial<AppPrefs>): AppPrefs {
    const next = { ...this.get(), ...patch };
    next.maxConcurrentAgents = Math.max(0, Math.min(MAX_FIXED_AGENTS, Math.round(next.maxConcurrentAgents)));
    next.robloxCreatorId = /^\d{1,20}$/.test(String(next.robloxCreatorId ?? '')) ? String(next.robloxCreatorId) : '';
    next.robloxGroupId = communityId(next.robloxGroupId) ?? '';
    next.modelingWorkspaces = Math.max(1, Math.min(24, Math.round(Number(next.modelingWorkspaces) || 8)));
    next.blenderPath = String(next.blenderPath ?? '').trim();
    next.agentEffort = EFFORTS.includes(next.agentEffort) ? next.agentEffort : 'high';
    next.agentCap = Math.max(1, Math.min(PROJECT_MAX_AGENTS, Math.round(Number(next.agentCap) || DEFAULT_AGENT_CAP)));
    next.agentCapV = 3;
    next.studioAgents = studioLimit(next.studioAgents);
    next.plannerEffort = EFFORTS.includes(next.plannerEffort) ? next.plannerEffort : 'max';
    delete (next as Partial<AppPrefs> & { agentThinking?: unknown }).agentThinking;
    next.polish = polishLevel(next.polish);
    next.permissionMode = next.permissionMode === 'ask' ? 'ask' : 'autonomous';
    next.modelInKiln = next.modelInKiln === true;
    next.kilnPath = String(next.kilnPath ?? '').trim();
    next.startKilnWithShuriken = next.startKilnWithShuriken === true;
    next.startKilnWhenNeeded = next.startKilnWhenNeeded !== false;
    next.kilnBuildsAtOnce = clampBuilds(next.kilnBuildsAtOnce);
    next.dockKiln = next.dockKiln !== false;
    next.studioLink = next.studioLink !== false;
    next.monetization = next.monetization !== false;
    next.copy = next.copy !== false;
    this.global.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [KEY, j(next), nowIso()]);
    return next;
  }
}
