import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sandboxPlaceXml } from './roblox/place-template';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nowIso } from '@shared/ids';
import { liveWindows } from '@shared/usage';
import type { HealthCheckResult, PermissionMode, ProjectSummary } from '@shared/domain';
import { effectivePermissionMode } from './permissions/owner-gate';
import { answerQuestion } from './orchestrator/autonomy';
import type { RenderRequest } from '@shared/render';
import { EventBus } from './events';
import { Logger, errorMessage, type ScopedLogger } from './log';
import { Store, pj, j } from './db/store';
import { GLOBAL_MIGRATIONS } from './db/schema';
import { CapabilityRegistry } from './capabilities/capability-registry';
import { ToolRegistry, type CallerContext } from './capabilities/tool-registry';
import { registerAppTools } from './capabilities/app-tools';
import { HealthService, providerCheck, filesystemCheck } from './health/health-service';
import { KnowledgeService } from './knowledge/knowledge-service';
import { SkillService } from './skills/skill-service';
import { ProjectService, placePath, type ProjectContext } from './projects/project-service';
import { acquireLock } from './projects/project-lock';
import { GameAdoption } from './projects/adoption';
import { DossierStore } from './projects/game-study';
import { ProviderRegistry } from './providers/provider-registry';
import { ClaudeProvider, DEFAULT_CLAUDE_SETTINGS } from './providers/claude/claude-provider';
import { CodexProvider } from './providers/codex/codex-provider';
import type { IAgentProvider, ProbeContext } from './providers/types';
import { ShurikenMcpServer } from './mcp/mcp-server';
import { createMcpContent } from './mcp/mcp-content';
import { ENFORCE, RobloxStudioAdapter, STUDIO_INTEGRATION } from './roblox/studio-adapter';
import { StudioLink, studioPluginsDir, type StudioLinkStatus } from './roblox/link/studio-link';
import { studioRightsLine } from './roblox/probe-bridge';
import type { LinkPlace } from './roblox/link/link-server';
import { LuauToolchain } from './roblox/luau-toolchain';
import { CodeSync } from './roblox/code-sync';
import { ContextCompiler } from './context/context-compiler';
import { kilnDirectorLine, modelingEnvironment, type KilnFacts } from './context/environment';
import { AgentRunner } from './orchestrator/agent-runner';
import { ImageScreen } from './roblox/image-screen';
import { UsageTracker } from './orchestrator/usage-tracker';
import { AccountService } from './accounts/account-service';
import { Orchestrator } from './orchestrator/orchestrator';
import { Verifier } from './verification/verifier';
import { GitService } from './git/git-service';
import { Mutex } from './util/mutex';
import { PLAYTEST_LIMITS, PlaytestLease, ownerLabel, playCapped, type LeaseMarker } from './roblox/playtest-lease';
import { IdleTracker } from './roblox/studio-window';
import { imageStates } from './roblox/image-status';
import { OpenCloudLuau, type SecretProvider } from './roblox/open-cloud-luau';
import { DEFAULT_ESCALATION } from './permissions/policy';
import { seedKnowledge } from './knowledge/seed';
import { PluginService } from './plugins/plugin-service';
import { LuauIndexer } from './code/luau-index';
import { registerCodeTools } from './code/code-tools';
import { registerGeometryTools } from './capabilities/geometry-tools';
import { registerAnimationTools } from './capabilities/animation-tools';
import { registerEffectTools } from './capabilities/effects-tools';
import { motionFromSkill } from './effects/effects-service';
import { registerAudioTools } from './capabilities/audio-tools';
import { OpenCloudAssets, resolveCreator } from './roblox/open-cloud-assets';
import { registerModelTools } from './capabilities/model-tools';
import { registerUiTools } from './capabilities/ui-tools';
import { registerUiLabReviewTool } from './capabilities/ui-lab-review-tool';
import { UiStore, uiImages } from './ui/ui-workshop';
import { registerLookTools } from './capabilities/look-tools';
import { registerDirectorTools } from './capabilities/director-tools';
import { registerWaitTools } from './capabilities/wait-tools';
import { registerKilnTools } from './capabilities/kiln-tools';
import { registerLayoutTools } from './capabilities/layout-tools';
import { LiveSuggestions, type SuggestionScope } from './director/live-suggestions';
import { StartIdeas } from './director/start-ideas';
import { ROLES } from './agents/roles';
import { readArt, registerStorefrontTools } from './capabilities/storefront-tools';
import { Storefront, storefrontLines } from './storefront/storefront';
import { MatchSetup } from './match/match-config';
import { registerMatchTools } from './capabilities/match-tools';
import { StorePush, namedItems } from './storefront/store-push';
import { OpenCloudStore } from './storefront/open-cloud-store';
import type { ThumbRuling } from './storefront/store-art';
import { PlaceLink } from './director/place-link';
import { BlenderModeling } from './blender/modeling';
import { KilnModeling } from './modeling/kiln-modeling';
import { publishSockets } from './modeling/kiln-family';
import { readPlaceLighting } from './modeling/kiln-lighting';
import type { ModelingBackend } from './modeling/backend';
import { registerBlenderTools } from './capabilities/blender-tools';
import { registerPlanTools } from './capabilities/plan-tools';
import { Director, titleFromPrompt } from './director/director';
import { PlainWords } from './director/plain-words';
import { CopilotService } from './copilots/copilot-service';
import { StudioSend } from './roblox/studio-send';
import { AppPrefsService } from './app-prefs';
import { PlaceGuard } from './roblox/place-guard';
import { PC_ACCOUNT_ID } from './accounts/account-service';
import { ChatService } from './director/chat-service';
import { TerminalService } from './terminal/terminal-service';
import { GAME_OWNER_LUAU, parseGameOwner, resolveUploadOwner, type UploadOwner } from './roblox/upload-owner';
import { keySource, projectSecrets } from './roblox/project-keys';
import { choiceSettings, projectOpenCloudKey, robloxId, type OpenCloudKeySource, type ProjectRobloxChoice } from '@shared/roblox-keys';
import { HOUSEKEEPING, housekeepAll } from './projects/housekeeping';
import { registerReferenceTools } from './capabilities/reference-tools';
import { ReferenceService, type MediaRunner } from './references/reference-service';
import { gpuForgeBatch, type ForgeGpuTransport } from './ui/forge/gpu-batch';
import { setForgeBatch } from './ui/forge/resolve';

export interface CoreOptions {
  dataDir: string;
  resourcesDir: string | null;
  appVersion: string;
  /** Preferred loopback port for the MCP server (0 = random). */
  mcpPort?: number;
  /** Replace the default providers (tests inject fakes). */
  providers?: IAgentProvider[];
  /** Connect to Roblox Studio and run background health checks (disabled in unit tests). */
  integrations?: boolean;
  logToDisk?: boolean;
  /** Replace the Luau toolchain (tests use a stub so they need no network or binaries). */
  luau?: LuauToolchain;
  /** Secret lookup (the app asks the Electron main process, which decrypts with DPAPI). */
  secrets?: SecretProvider;
  /** Safe mode: open projects without starting the orchestrator (inspection, screenshots). */
  safeMode?: boolean;
  /**
   * Which project to open at startup: 'last' (default) reopens the previous one, an id opens that
   * project, null starts on the start page. Each app window runs its own core and says which it wants.
   */
  /** Draws a picture for an agent (the app's main process does; absent in tests and plain Node). */
  render?: (req: RenderRequest) => Promise<string | null>;
  /** Open at start: a project id, the last one, a new blank project, or none. */
  openProject?: string | null | 'last' | 'blank';
  /** Restarted after a crash in the middle of a build: the project opened at start carries on instead of waiting on hold. */
  resumeBuild?: boolean;
  /** The fetch the audio tools search and download with (tests pass a fake: no network). */
  webFetch?: typeof fetch;
  /** Decodes reference videos and pictures on the app's hidden media page (the main process does; absent in plain Node). */
  media?: MediaRunner;
  /** Draws forge plans on the GPU (the app's hidden render page, through the main process; absent in tests and plain Node). */
  forgeGpu?: ForgeGpuTransport;
}

/**
 * Composition root of the headless engine. Owns every service and the currently open project.
 * Runs inside an Electron utilityProcess in the app and directly under Node in tests.
 */
/**
 * The Storefront's switches as every agent reads them (Settings: monetization and copy). The planner plans the store,
 * the copy and the art from it; everyone else knows whether the game sells things.
 */
export function storefrontLine(p: { monetization?: boolean; copy?: boolean }): string {
  const m = p.monetization !== false;
  const c = p.copy !== false;
  if (!m && !c) return 'Storefront: off (no monetization, no copy): the game is built with no store, and nothing is planned for its page.';
  return `Storefront: monetization ${m ? 'ON (the game gets a store designed for its genre, built in through ShurikenStore; pushed to Roblox only by the user)' : 'OFF (no store, no purchases, no offers)'}; copy ${c ? 'ON (the copywriter writes the title, the description and the item texts)' : 'OFF'}; thumbnails and the icon by the thumbnail artist.`;
}

export class Core {
  readonly bus = new EventBus();
  readonly logger: Logger;
  readonly log: ScopedLogger;
  readonly global: Store;
  readonly capabilities: CapabilityRegistry;
  readonly health: HealthService;
  readonly knowledge: KnowledgeService;
  readonly skills: SkillService;
  readonly projects: ProjectService;
  readonly providers: ProviderRegistry;
  readonly usage: UsageTracker;
  readonly accounts: AccountService;
  readonly prefs: AppPrefsService;
  readonly assetUploads: OpenCloudAssets;
  /** 3D modeling: each model in its own headless Blender today (modeling/backend.ts is the seam to swap the engine). */
  readonly modeling: ModelingBackend;
  readonly placeGuard: PlaceGuard;
  readonly tools: ToolRegistry;
  readonly mcp: ShurikenMcpServer;
  readonly studio: RobloxStudioAdapter;
  /** Shuriken Link (roblox/link): null in tests, smoke runs and where there is no Studio to write a plugin for. */
  studioLink: StudioLink | null = null;
  readonly luau: LuauToolchain;
  readonly sync: CodeSync;
  readonly compiler: ContextCompiler;
  readonly runner: AgentRunner;
  /** Looks at textures before they are uploaded (links, handles, real brands painted as lettering). */
  get imageScreen(): ImageScreen {
    return (this.imageScreenMade ??= new ImageScreen({ runner: () => this.runner ?? null, project: () => this.project, log: this.logger.scope('moderation') }));
  }
  private imageScreenMade: ImageScreen | null = null;
  readonly verifier: Verifier;
  readonly orchestrator: Orchestrator;
  readonly director: Director;
  /** The dock copilots (Animation, Music & sound, UI, Effects) the user talks to directly. */
  readonly copilots: CopilotService;
  /** Suggestion bubbles written for this game (the director's chat and each dock). */
  readonly liveSuggestions: LiveSuggestions;
  readonly startIdeas: StartIdeas;
  /** Puts the game's store on Roblox, on the user's word only (storefront/store-push.ts). */
  readonly storePush: StorePush;
  /** Which Studio window the project is linked to: its place file, or a recovery copy the user opened instead. */
  readonly placeLink: PlaceLink;
  /** The docks' one-click "Send to Studio". */
  readonly send: StudioSend;
  /** Plugging in games Shuriken didn't build: pull their scripts, study them. */
  readonly adoption: GameAdoption;
  /** The user's reference footage and pictures: decoded, measured and studied (references/). */
  readonly references: ReferenceService;
  readonly plugins: PluginService;
  readonly indexer = new LuauIndexer();
  readonly terminals: TerminalService;
  readonly studioLock = new Mutex();
  readonly lease: PlaytestLease;
  /** Play mode a crashed predecessor may have left running; stopped once Studio is reachable. */
  private orphanPlaytest: LeaseMarker | null = null;
  readonly cloud: OpenCloudLuau;
  /** Secrets as the main process gives them (the default key, a project's own key by its name). */
  private readonly secrets: SecretProvider;
  readonly approvals = new Set<string>();
  project: ProjectContext | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly healthDebounce = new Map<string, NodeJS.Timeout>();

  private constructor(readonly opts: CoreOptions) {
    this.logger = new Logger(opts.logToDisk === false ? null : join(opts.dataDir, 'logs'), this.bus);
    this.log = this.logger.scope('core');
    this.lease = new PlaytestLease(join(opts.dataDir, 'playtests'));
    this.orphanPlaytest = this.lease.takeOrphan();
    this.global = new Store(join(opts.dataDir, 'global.db'), GLOBAL_MIGRATIONS);
    this.capabilities = new CapabilityRegistry(this.global, this.bus);
    this.health = new HealthService(this.global, this.bus, this.logger.scope('health'));
    this.knowledge = new KnowledgeService(this.global, this.bus);
    this.skills = new SkillService(this.global, join(opts.dataDir, 'skills'), opts.resourcesDir ? join(opts.resourcesDir, 'skills') : null, this.logger.scope('skills'));
    this.projects = new ProjectService(this.global, this.bus, this.knowledge);
    this.providers = new ProviderRegistry(this.global);
    const providers = opts.providers ?? [
      new ClaudeProvider({ ...DEFAULT_CLAUDE_SETTINGS, ...pj(this.setting('claude'), {}), appVersion: opts.appVersion }),
      new CodexProvider(),
    ];
    for (const p of providers) this.providers.register(p);
    this.usage = new UsageTracker(this.global, this.bus);
    this.accounts = new AccountService(this.global, opts.dataDir, this.bus);
    // Provider fallback is consulted at the start of each new run, not by
    // reassigning active agents. Quota exhaustion must be confirmed, and
    // Codex must have passed the latest local CLI/authentication health check.
    this.providers.setCodexFallbackAvailability(() =>
      !this.accounts.anyCanStart('claude', this.usage) &&
      this.usage.canStartRun('codex').ok &&
      this.health.get('provider:codex')?.status === 'healthy',
    );
    // This window's own account (the top bar's menu): kept with its open project, in memory when none is open.
    const windowAccounts = new Map<string, string>();
    this.accounts.setScope({
      get: (providerId) => (this.project ? (this.project.settings().accounts?.[providerId] ?? null) : (windowAccounts.get(providerId) ?? null)),
      set: (providerId, id) => {
        if (!this.project) {
          if (id) windowAccounts.set(providerId, id);
          else windowAccounts.delete(providerId);
          return;
        }
        const next = { ...(this.project.settings().accounts ?? {}) };
        if (id) next[providerId] = id;
        else delete next[providerId];
        this.project.updateSettings({ accounts: next });
      },
    });
    this.prefs = new AppPrefsService(this.global);

    this.tools = new ToolRegistry(
      {
        rules: () => this.project?.settings().escalation ?? DEFAULT_ESCALATION,
        mode: () => this.permissionMode(),
        waiting: (caller, on) => this.orchestrator.park(caller.taskId, on),
        requestApproval: async (caller, tool, reason, args) => {
          const sig = `${caller.taskId ?? caller.runId}|${tool}|${JSON.stringify(args).slice(0, 500)}`;
          if (this.approvals.has(sig)) return true;
          this.project?.governance.escalate({
            kind: 'approval',
            title: `Approve ${tool}`,
            detail: `${reason}\n\nRequested by ${caller.role ?? caller.kind}.\n\nArguments:\n${JSON.stringify(args, null, 2).slice(0, 3000)}\n\nsignature:${sig}`,
            taskId: caller.taskId,
            runId: caller.runId,
            options: ['approve', 'reject'],
          });
          return false;
        },
        notify: (caller, tool, reason) => this.project?.audit.event({ kind: 'policy.notify', severity: 'warning', title: `${tool}: ${reason}`, runId: caller.runId, taskId: caller.taskId, role: caller.role }),
      },
      this.capabilities,
      this.logger.scope('tools'),
    );

    this.studio = new RobloxStudioAdapter(this.capabilities, this.bus, this.logger.scope('studio'), opts.appVersion);
    // Every project window notes the input it makes itself where the others can read it (studio-window.ts).
    if (opts.integrations !== false) IdleTracker.shared = join(opts.dataDir, 'own-input.json');
    // Studio calls made inside an agent's tool call wait for play mode through the lease (studio-adapter.ts).
    this.studio.useLease(this.lease, ({ owner, reason }) =>
      this.project?.audit.event({
        kind: 'playtest.timeout',
        severity: 'warning',
        title:
          reason === 'long'
            ? playCapped(owner)
              ? `Stopped a playtest at its ${Math.round(PLAYTEST_LIMITS.playMs / 1000)} s of play (or still not up after ${Math.round(PLAYTEST_LIMITS.loadMs / 60000)} min) so other agents can use Studio`
              : `Stopped a hold of Studio past its time so other agents can use it`
            : `Stopped an idle playtest (no Studio calls for ${Math.round(PLAYTEST_LIMITS.idleMs / 1000)} s) so waiting work could use Studio`,
        detail: { owner },
      }),
    );
    // With "Keep the screen on" set, a display that fell asleep is woken for a capture nobody is there to see.
    this.studio.keepScreenOn = () => this.prefs.get().keepScreenOn !== false;
    // The project's published place, for finding its window when Studio lists it under the game's name.
    this.studio.projectPlaceId = () => this.project?.extras().cloud?.placeId ?? null;
    this.studio.projectPlaceFile = () => {
      const f = this.project ? placePath(this.project) : null;
      return f ? basename(f) : null;
    };
    this.studio.onAutoBind = (match) => {
      const ctx = this.project;
      if (!ctx || ctx.settings().robloxStudioMatch) return;
      ctx.updateSettings({ robloxStudioMatch: match });
      this.lease.studio = match;
      this.log.info(`Linked to ${match}: the project's own place, opened in Studio by hand`);
      new ChatService(ctx, this.bus).add({ role: 'system', kind: 'status', text: `Roblox Studio is connected: ${match} is open, and this project works in it.` });
    };
    // Shuriken Link: the Studio plugin and this core's end of it. Only in the real app: tests and smoke runs write
    // nothing into Studio's Plugins folder and open no port.
    if (opts.integrations !== false && process.env.SHURIKEN_SMOKE !== '1' && process.env.SHURIKEN_NO_LINK !== '1') {
      this.studioLink = new StudioLink({
        dataDir: opts.dataDir,
        pluginsDir: studioPluginsDir(),
        enabled: () => this.prefs.get().studioLink !== false,
        binding: () => this.studio.binding,
        renamed: (display, now, before) => this.followPlace(display, now, before),
        changed: () => this.bus.emit('roblox.changed', { reason: 'link' }),
        log: this.logger.scope('link'),
      });
      this.studio.link = this.studioLink;
    }
    this.luau = opts.luau ?? new LuauToolchain(join(opts.dataDir, 'luau-types'));
    this.sync = new CodeSync(this.studio, this.lease);
    // The open project's own Open Cloud key wins over the default one (roblox/project-keys.ts).
    this.secrets = opts.secrets ?? (async () => null);
    const keyed = projectSecrets(this.secrets, () => this.project?.summary.id ?? null);
    this.cloud = new OpenCloudLuau(keyed, this.logger.scope('open-cloud'));
    this.assetUploads = new OpenCloudAssets(keyed);
    // Uploads go to a community when the project, the published game or Settings names one (roblox/upload-owner.ts).
    this.assetUploads.setOwner(() => this.uploadOwner());
    // Models are built in Shuriken's own Blender; the user's Kiln app is asked for results (kiln_request), and only when
    // Settings let the modeler work inside Kiln's Blender (off by default) do the agents' Python calls run there.
    this.modeling = new KilnModeling(
      new BlenderModeling(
        { resourcesDir: opts.resourcesDir ?? null, configured: () => ({ path: this.prefs.get().blenderPath || process.env.SHURIKEN_BLENDER || '', max: this.prefs.get().modelingWorkspaces }) },
        this.bus,
        this.logger.scope('blender'),
      ),
      {
        enabled: () => this.prefs.get().modelInKiln === true && process.env.SHURIKEN_NO_KILN !== '1',
        resourcesDir: opts.resourcesDir ?? null,
        lighting: () => readPlaceLighting(this.studio),
        // Kiln builds every model: when it is installed but not running, the first request starts it (Settings can switch that off).
        launch: { configured: () => this.prefs.get().kilnPath, allowed: () => this.prefs.get().startKilnWhenNeeded !== false },
        // The open project's own limit when it set one, else the app-wide setting.
        buildsAtOnce: () => this.project?.settings().kilnBuildsAtOnce ?? this.prefs.get().kilnBuildsAtOnce,
        note: (text, id) => {
          if (!this.project) return null;
          const chat = new ChatService(this.project, this.bus);
          return (id ? chat.update(id, { text })?.id : null) ?? chat.add({ role: 'system', kind: 'status', text }).id;
        },
        // Sizes and sockets read back from Kiln go into the game's spec and a data module, so code and models agree.
        onSockets: (root, families) => {
          if (this.project && this.project.root.toLowerCase() === root.toLowerCase()) publishSockets(this.project, families);
        },
      },
      this.bus,
      this.logger.scope('kiln'),
    );
    this.compiler = new ContextCompiler(this.knowledge, this.skills, this.capabilities, () => [
      ...modelingEnvironment(this.modeling.status(), this.kilnFacts()),
      studioRightsLine(!!this.studioLink?.has('Edit'), this.studio.mcpRestricted),
      storefrontLine(this.prefs.get()),
    ]);
    this.mcp = new ShurikenMcpServer(
      this.tools,
      createMcpContent({ project: () => this.project, knowledge: this.knowledge, skills: this.skills, capabilities: this.capabilities, compiler: this.compiler }),
      this.logger.scope('mcp'),
      { name: 'shuriken', version: opts.appVersion },
    );
    registerAppTools(this.tools, {
      project: () => this.project,
      knowledge: this.knowledge,
      skills: this.skills,
      capabilities: this.capabilities,
      studio: this.studio,
      sync: this.sync,
      luau: this.luau,
      mcp: () => this.mcp,
      studioLock: this.studioLock,
      lease: this.lease,
      cloud: this.cloud,
      bus: this.bus,
      verifier: () => this.verifier,
      // Autonomous mode: an agent's question is answered by the director from the user's request, never parked on the user.
      autonomy: {
        mode: () => this.permissionMode(),
        answer: (q, signal) => (this.project ? answerQuestion(this.runner, this.project, q, signal) : Promise.resolve(null)),
      },
    });
    registerCodeTools(this.tools, { project: () => this.project, indexer: this.indexer });
    registerGeometryTools(this.tools, { project: () => this.project, studio: this.studio, lease: this.lease, bus: this.bus, otherAgents: (runId) => this.runner.activeRuns().filter((r) => r !== runId).length });
    registerAnimationTools(this.tools, {
      render: opts.render,
      project: () => this.project,
      studio: this.studio,
      lease: this.lease,
      sync: this.sync,
      bus: this.bus,
      cloud: this.assetUploads,
      uploads: () => this.uploadsNow(),
      rememberCreator: (id) => {
        if (!this.prefs.get().robloxCreatorId) this.prefs.set({ robloxCreatorId: id });
      },
    });
    registerEffectTools(this.tools, {
      project: () => this.project,
      studio: this.studio,
      lease: this.lease,
      sync: this.sync,
      bus: this.bus,
      cloud: this.assetUploads,
      uploads: () => this.uploadsNow(),
      rememberCreator: (id) => {
        if (!this.prefs.get().robloxCreatorId) this.prefs.set({ robloxCreatorId: id });
      },
      motionSource: () => motionFromSkill(this.skills.get('roblox-ui-motion')?.body),
    });
    registerKilnTools(this.tools, { project: () => this.project, kiln: () => (this.modeling instanceof KilnModeling ? this.modeling : null), modeling: () => this.modeling, bus: this.bus });
    registerAudioTools(this.tools, {
      project: () => this.project,
      studio: this.studio,
      lease: this.lease,
      sync: this.sync,
      bus: this.bus,
      cloud: this.assetUploads,
      uploads: () => this.uploadsNow(),
      rememberCreator: (id) => {
        if (!this.prefs.get().robloxCreatorId) this.prefs.set({ robloxCreatorId: id });
      },
      samplesDir: join(opts.dataDir, 'samples'),
      ...(opts.webFetch ? { fetch: opts.webFetch } : {}),
    });
    const modelTools = registerModelTools(this.tools, {
      render: opts.render ? (parts, o) => opts.render!({ kind: 'model', parts: parts.map((x) => ({ ...x, glb: x.glb.toString('base64') })), name: o?.name }) : undefined,
      project: () => this.project,
      studio: this.studio,
      lease: this.lease,
      bus: this.bus,
      cloud: this.assetUploads,
      uploads: () => this.uploadsNow(),
      rememberCreator: (id) => {
        if (!this.prefs.get().robloxCreatorId) this.prefs.set({ robloxCreatorId: id });
      },
      discard: (root, model) => (this.modeling instanceof KilnModeling && process.env.SHURIKEN_NO_KILN !== '1' ? this.modeling.discard(root, model) : Promise.resolve(null)),
      // Only the real app asks Roblox (tests and smoke runs make no network calls).
      ...(opts.integrations !== false && process.env.SHURIKEN_SMOKE !== '1' ? { imageStates: (ids: string[]) => imageStates(ids) } : {}),
      // Only with the real provider: tests and smoke runs upload nothing a model should look at.
      ...(opts.integrations !== false && process.env.SHURIKEN_SMOKE !== '1' ? { screen: (root: string, file: string) => this.imageScreen.check(root, file) } : {}),
    });
    registerUiTools(this.tools, {
      project: () => this.project,
      studio: this.studio,
      lease: this.lease,
      bus: this.bus,
      renderIcon: opts.render ? (parts, o) => opts.render!({ kind: 'icon', parts: parts.map((x) => ({ ...x, glb: x.glb.toString('base64') })), view: o.view, outline: o.outline }) : undefined,
      cloud: this.assetUploads,
      uploads: () => this.uploadsNow(),
      rememberCreator: (id) => {
        if (!this.prefs.get().robloxCreatorId) this.prefs.set({ robloxCreatorId: id });
      },
      sync: this.sync,
      resourcesDir: opts.resourcesDir ?? null,
      // Only the real app asks Roblox for thumbnails (tests and smoke runs make no network calls).
      ...(opts.integrations !== false && process.env.SHURIKEN_SMOKE !== '1' ? { fetchImages: async (root: string, refs: string[]) => void (await uiImages(new UiStore(root), refs)) } : {}),
    });
    // The phone reviewer asks the fast model: only the real app (tests, smoke runs and safe mode get "unavailable").
    registerUiLabReviewTool(this.tools, {
      project: () => this.project,
      runner: () => (opts.integrations !== false && !opts.safeMode && process.env.SHURIKEN_SMOKE !== '1' ? (this.runner ?? null) : null),
      resourcesDir: opts.resourcesDir ?? null,
      ...(opts.integrations !== false && process.env.SHURIKEN_SMOKE !== '1' ? { fetchImages: async (root: string, refs: string[]) => void (await uiImages(new UiStore(root), refs)) } : {}),
    });
    registerLookTools(this.tools, { project: () => this.project, studio: this.studio, bus: this.bus, lease: this.lease, otherAgents: (runId) => this.runner.activeRuns().filter((r) => r !== runId).length });
    registerDirectorTools(this.tools, { project: () => this.project, studio: this.studio, lease: this.lease, placeLink: () => this.placeLink ?? null, unsaved: () => this.placeGuard?.unsaved ?? false });
    registerWaitTools(this.tools, { project: () => this.project, studio: this.studio, uploading: modelTools.uploading, kiln: () => (this.modeling instanceof KilnModeling ? this.modeling : null) });
    registerLayoutTools(this.tools, { project: () => this.project, kiln: () => (this.modeling instanceof KilnModeling ? this.modeling : null), studio: this.studio, sync: this.sync, bus: this.bus, uploader: modelTools.uploader, blender: () => ({ path: this.prefs.get().blenderPath || process.env.SHURIKEN_BLENDER || null, resourcesDir: opts.resourcesDir ?? null }) });
    registerBlenderTools(this.tools, { project: () => this.project, modeling: this.modeling, bus: this.bus, ownedByKiln: (root, model) => this.modeling instanceof KilnModeling && !this.modeling.modelsInKiln && this.modeling.kilnOwns(root, model), kilnFirst: (root, model) => (this.modeling instanceof KilnModeling ? this.modeling.kilnFirst(root, model) : null) });
    registerPlanTools(this.tools, { project: () => this.project, bus: this.bus, kick: () => this.orchestrator?.kick(), stop: (id, reason) => void this.orchestrator?.cancel(id, reason, 'executive'), polish: () => this.prefs.get().polish });
    registerMatchTools(this.tools, { project: () => this.project });
    this.references = new ReferenceService({
      project: () => this.project,
      runner: () => this.runner,
      bus: this.bus,
      log: this.logger.scope('references'),
      media: opts.media ?? null,
      // Smoke runs and safe mode measure but start no agent: the study waits.
      agentsAllowed: () => !opts.safeMode && process.env.SHURIKEN_SMOKE !== '1',
    });
    registerReferenceTools(this.tools, { references: () => (this.project ? this.references : null), canDecode: !!opts.media, capabilities: this.capabilities });
    registerStorefrontTools(this.tools, {
      project: () => this.project,
      studio: this.studio,
      bus: this.bus,
      prefs: () => ({ monetization: this.prefs.get().monetization !== false, copy: this.prefs.get().copy !== false }),
      resourcesDir: opts.resourcesDir ?? null,
      sync: this.sync,
      apply: (p) => this.storePush.apply(p),
      renderIcon: opts.render ? (parts, o) => opts.render!({ kind: 'icon', parts: parts.map((x) => ({ ...x, glb: x.glb.toString('base64') })), view: o.view, outline: o.outline }) : undefined,
      // A judge that didn't make them, on the balanced model, looks at the candidates (none in tests or smoke runs).
      ...(opts.integrations !== false && process.env.SHURIKEN_SMOKE !== '1'
        ? {
            judge: async (prompt: string, images: Array<{ mediaType: 'image/png'; data: string }>) => {
              // Booked in the open project: judging its thumbnails is part of what the build cost.
              const out = await this.runner.quick({ role: ROLES['thumb-judge']!, prompt, cwd: this.project?.root ?? opts.dataDir, signal: new AbortController().signal, images, project: this.project, label: 'Picking the best thumbnail' });
              const r = out?.structured as ThumbRuling | null | undefined;
              return r && typeof r.winner === 'string' && Array.isArray(r.rounds) ? r : null;
            },
          }
        : {}),
    });
    this.storePush = new StorePush({ cloud: new OpenCloudStore(keyed), studio: this.studio, sync: this.sync, bus: this.bus, log: this.logger.scope('storefront') });
    this.terminals = new TerminalService(this.bus, this.logger.scope('terminal'));
    this.plugins = new PluginService(join(opts.dataDir, 'plugins'), {
      tools: this.tools,
      capabilities: this.capabilities,
      skills: this.skills,
      knowledge: this.knowledge,
      log: this.logger.scope('plugins'),
      bus: this.bus,
      appVersion: opts.appVersion,
    });
    this.verifier = new Verifier({ studio: this.studio, sync: this.sync, luau: this.luau, studioLock: this.studioLock, lease: this.lease, cloud: this.cloud, log: this.logger.scope('verify'), permissionMode: (project) => this.permissionMode(project) });
    // A run that ends while holding play mode (crash, forgot to stop) must not leave Studio playing.
    this.bus.on('run.updated', (run) => {
      if (run.status === 'running' || run.status === 'starting') return;
      // Its models are free for other agents.
      this.modeling.releaseRun(run.id);
      if (!this.lease.isOwnedBy(run.id)) return;
      // Studio is given back within ENFORCE.stopMs even when the stop never comes back (a Studio that hung): the run the
      // user stopped on 2026-10-06 kept its playtest's turn because the stop waited behind a start that never ended.
      void Promise.race([this.studio.setPlaying(false), new Promise((r) => setTimeout(r, ENFORCE.stopMs))])
        .catch((e) => this.log.warn('Could not stop leaked playtest', errorMessage(e)))
        .finally(() => this.lease.release(run.id));
    });
    // Nobody keeps Studio in play mode for long: every other agent's Edit-mode work waits on it. The limits
    // (PLAYTEST_LIMITS) are enforced by the adapter, at once by whoever waits and by this look every 10 s.
    this.leaseWatchdog = setInterval(() => {
      void this.studio.enforceLease().catch((e) => this.log.warn('Could not stop a playtest', errorMessage(e)));
    }, 10_000);
    this.runner = new AgentRunner({
      providers: this.providers,
      mcp: this.mcp,
      compiler: this.compiler,
      bus: this.bus,
      log: this.logger.scope('runner'),
      usage: this.usage,
      approvals: this.approvals,
      accounts: this.accounts,
      // The planner thinks as Settings say for it (max by default), every other agent as Settings say for them (high);
      // roles that take no effort (the small fixed-model jobs) are left as they are.
      // A decision or a triage is a short job at its own effort: the planner's "max" made each of them as slow as a plan.
      effortFor: (role) => (role.ownEffort ? role.effort : role.id === 'executive' ? this.prefs.get().plannerEffort : role.effort ? this.prefs.get().agentEffort : role.effort),
      appVersion: opts.appVersion,
      permissionMode: (project) => this.permissionMode(project),
      dataDir: opts.dataDir,
      robloxStatus: async () => {
        if (!this.studio.connected) return `not connected (${this.studio.conn.lastError ?? this.studio.conn.state})`;
        // Studio answers one request at a time: a busy Studio must not hold up an agent's start.
        const st = await Promise.race([this.studio.state().catch(() => 'unknown' as const), new Promise<'busy'>((r) => setTimeout(() => r('busy'), 3000).unref())]);
        if (st === 'unknown') throw new Error('Studio state unavailable');
        if (st === 'busy') return `connected · busy right now (other agents are using it; Studio tools wait their turn)${this.studio.binding ? ` · bound to "${this.studio.binding}"` : ''}`;
        return `connected · mode ${st.mode} · DataModels ${st.availableDataModels.join(', ')}${this.studio.binding ? ` · bound to "${this.studio.binding}"` : ''}`;
      },
    });
    this.orchestrator = new Orchestrator({
      providerBlocked: (id) => {
        const h = this.health.get(`provider:${id}`);
        return h && h.status === 'unavailable' ? `${h.name} is unavailable (${h.summary})` : null;
      },
      runner: this.runner,
      verifier: this.verifier,
      // A Kiln build is an Opus turn on the same subscription: the agent limit leaves room for the ones running.
      kilnBuilds: () => this.kilnBuilds(),
      knowledge: this.knowledge,
      studio: this.studio,
      usage: this.usage,
      providers: this.providers,
      bus: this.bus,
      log: this.logger.scope('orchestrator'),
      approvals: this.approvals,
      lease: this.lease,
      accounts: this.accounts,
      savePlace: (reason) => this.placeGuard.saveNow(reason),
      checkpoint: () => this.placeGuard.checkpoint(),
      appPrefs: () => this.prefs.get(),
      elsewhere: () => this.agentsElsewhere,
      permissionMode: (project) => this.permissionMode(project),
    });
    // A Studio this project started hangs at its login behind another Studio that holds Roblox's login lock
    // (roblox/studio-login-lock.ts): said once in the chat, with which window it is. When that window is another
    // Shuriken project's own Studio, that project reopens it by itself (StudioRecovery.letGoOfLoginLock).
    this.studio.onLoginLock = ({ holder }) => {
      const ctx = this.project;
      if (!ctx) return;
      const which = holder.title.split(/[\\/]/).pop()?.replace(/ - Roblox Studio$/i, '') || 'a Studio window with no place open';
      ctx.audit.event({ kind: 'studio.login.lock', severity: 'warning', title: `Studio could not start: "${which}" holds Roblox's login lock`.slice(0, 300) });
      new ChatService(ctx, this.bus).add({
        role: 'system',
        kind: 'status',
        text: `Studio could not start for this project: another Studio window, "${which}", holds Roblox's login lock (a fault in Studio: it took the lock when it started and never let go, so every Studio started after it waits at its login). If it is another Shuriken project's window, that project saves and reopens it by itself within a minute or two. Otherwise save in it, close it and open it again; this project's Studio then starts.`,
      });
    };
    this.placeGuard = new PlaceGuard({
      project: () => this.project,
      studio: this.studio,
      lease: this.lease,
      bus: this.bus,
      log: this.logger.scope('place'),
      // Linked to a recovery copy of the place (director/place-link.ts): saving it is the user's (File > Save As).
      autoSave: () => this.prefs.get().autoSave !== false && this.project?.extras().autoSave !== false && !this.placeLink.onRecovery,
      pushCode: (ctx) => (ctx.extras().syncMode === 'shuriken' ? this.sync.push(ctx.root, ctx.extras().syncMap, { owner: 'healer' }) : Promise.resolve(null)),
      hold: (until, reason) => this.orchestrator.hold(until, reason),
      // Studio closing while the team works is a crash: the place is reopened (roblox/studio-recovery.ts). Not for the
      // chat helpers or a copilot: a project that just opened runs its suggestion writer.
      working: () => this.runner.teamRuns().length > 0,
    });
    this.bus.on('orchestrator.state', (st) => {
      const ctx = this.studioOnWake;
      if (!ctx || st.paused || this.project !== ctx) return;
      this.studioOnWake = null;
      void this.ensureStudio(ctx).catch((e) => this.log.warn('Could not open the place in Studio', errorMessage(e)));
    });
    this.send = new StudioSend({ project: () => this.project, studio: this.studio, invokeTool: (name, args) => this.invokeTool(name, args, 'ui') });
    this.adoption = new GameAdoption({ studio: this.studio, runner: this.runner, bus: this.bus, log: this.logger.scope('adoption') });
    // Clips the user makes in Kiln on this game's models show up here while they work (see syncClips).
    this.kilnClipsTimer = setInterval(() => void this.syncKilnClips(), 15_000);
    this.kilnClipsTimer.unref?.();
    // The databases' write-ahead logs go into their files every few minutes (Store.checkpoint): a hard stop of the app
    // then loses minutes at most (a month of global.db changes once lived only in its -wal, and a hard stop lost them).
    this.checkpointTimer = setInterval(() => this.checkpointNow(), 5 * 60_000);
    this.checkpointTimer.unref?.();
    // Housekeeping (projects/housekeeping.ts): old transcripts and status lines leave the database for an archive
    // file, a few minutes after the window starts and every half hour, and only while no agent is working.
    if (opts.integrations !== false) {
      this.housekeepingTimer = setInterval(() => void this.housekeepNow(), HOUSEKEEPING.everyMs);
      this.housekeepingTimer.unref?.();
      setTimeout(() => void this.housekeepNow(), 3 * 60_000).unref?.();
    }
    this.copilots = new CopilotService({
      project: () => this.project,
      runner: this.runner,
      bus: this.bus,
      log: this.logger.scope('copilots'),
      skills: this.skills,
      dossier: (p) => new DossierStore(p.root).summary(),
      // The animation copilot knows at once whether Kiln can take work and which models are Kiln's.
      extraState: async (p, id) => {
        if (id !== 'animation' || !(this.modeling instanceof KilnModeling) || process.env.SHURIKEN_NO_KILN === '1') return [];
        const h = await this.modeling.kiln.check();
        const dir = join(p.root, '.shuriken', 'kiln');
        const linked = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
        return [
          h.ok ? `Kiln: running (${h.version ?? 'Kiln'}) — kiln_request and kiln_import work${this.modeling.kiln.supports() ? "; a Kiln project's clips are asked for with kiln_request (kind animate or fix), kiln_clip only checks them" : '; so does kiln_clip'}.` : `Kiln: not running (${h.detail}) — kiln_clip still works on models in Shuriken's own Blender; kiln_request needs Kiln (the user starts it from the Kiln page).`,
          linked.length ? `Models with a Kiln project: ${linked.join(', ')}.` : '',
        ].filter(Boolean);
      },
      environment: async () => [
        this.studio.connected ? 'Roblox Studio: connected' : `Roblox Studio: NOT connected (${this.studio.conn.lastError ?? this.studio.conn.state}) — building into the place waits until the user opens it`,
        `3D modeling: ${this.modeling.status().ready ? 'ready' : 'not available'}`,
      ],
    });
    const ideasAllowed = () => this.opts.integrations !== false && !this.opts.safeMode && process.env.SHURIKEN_SMOKE !== '1';
    this.startIdeas = new StartIdeas({
      runner: this.runner,
      bus: this.bus,
      log: this.logger.scope('ideas'),
      file: join(opts.dataDir, 'start-ideas.json'),
      cwd: opts.dataDir,
      // The newest first: what the user opened last says most about what they like now.
      projects: () => [...this.projects.list()].sort((a, b) => (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt)),
      enabled: ideasAllowed,
    });
    this.liveSuggestions = new LiveSuggestions({ runner: this.runner, bus: this.bus, log: this.logger.scope('suggestions'), enabled: ideasAllowed, ideas: (n) => this.startIdeas.get(n) });
    this.placeLink = new PlaceLink({ project: () => this.project, studio: this.studio, bus: this.bus, log: this.logger.scope('place-link') });
    this.director = new Director({
      project: () => this.project,
      orchestrator: this.orchestrator,
      runner: this.runner,
      bus: this.bus,
      log: this.logger.scope('director'),
      // Question cards, status lines and goal titles in plain words, by the fast model where one may be called.
      plainWords: new PlainWords({ runner: this.runner, log: this.logger.scope('plain-words'), enabled: ideasAllowed }),
      placeLink: this.placeLink,
      playtest: () => this.lease.describe(),
      freeStudio: () => this.freeStudio('director'),
      storefront: {
        lines: (p) => {
          const art = readArt(p.root);
          return storefrontLines(p.root, { monetization: this.prefs.get().monetization !== false, copy: this.prefs.get().copy !== false }, { thumbs: art.thumbs.length, picked: art.pick?.winner ?? null, icon: art.gameIcon ?? null });
        },
        push: (p, text) => {
          // Only the items the user named, when they named some ("push the VIP pass"); else everything not on Roblox yet.
          const keys = namedItems(text, new Storefront(p.root).catalog().items);
          return this.storePush.push(p, { by: 'director', ...(keys.length ? { keys } : {}) });
        },
      },
      prepareBuild: (ctx, request, title) => this.prepareBuild(ctx, request, title),
      copilotDigest: (ctx) => this.copilots.digest(ctx),
      dossier: (ctx) => new DossierStore(ctx.root).summary(),
      studying: (ctx) => this.adoption.busy(ctx.summary.id),
      restudy: (ctx) => void this.adoption.study(ctx).catch((e) => this.log.warn('Studying the game failed', errorMessage(e))),
      // Notes for the developers, one file for every project (Settings has no inbox for them yet).
      feedback: (project, note) => {
        appendFileSync(join(this.opts.dataDir, 'feedback.md'), `## ${new Date().toLocaleString()} · ${project}\n\n${note}\n\n`);
      },
      environment: async () => {
        const acct = this.accounts.active('claude');
        const usageKey = acct ? this.accounts.usageKey('claude', acct) : 'claude';
        const usage = this.usage.canStartRun(usageKey);
        // Headroom as the provider last reported it (it reports as a window nears its limit): only windows
        // that haven't reset, so the director is never told an account is full when its limit is over.
        const windows = liveWindows(this.usage.snapshot(usageKey).windows, this.usage.now()).map(([w, v]) => {
          const pct = v.utilization == null ? null : Math.round(v.utilization <= 1 ? v.utilization * 100 : v.utilization);
          const when = v.resetsAt ? `, resets ${new Date(v.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
          return `${w.replace(/_/g, ' ')}: ${pct == null ? v.status : `${pct}% used`}${when}`;
        });
        const modeling = this.modeling.status();
        const benches = this.project ? this.modeling.list(this.project.root).filter((w) => w.state !== 'closed') : [];
        return [
          windows.length ? `Usage limits (last reported): ${windows.join('; ')}` : 'Usage limits: nothing reported yet (the provider reports only as a window nears its limit).',
          `3D modeling (Blender, for the Models panel): ${modeling.ready ? `ready — ${modeling.detail}` : `NOT available — ${modeling.detail}`}.${benches.length ? ` Models open now: ${benches.map((w) => `${w.name} (${w.by ?? 'someone'}, ${w.state}${w.step ? `: ${w.step}` : ''})`).join(', ')}.` : ''}`,
          kilnDirectorLine(this.kilnFacts()),
          acct
            ? `Claude account in use: ${acct.label}${usage.ok ? '' : ` — can't start runs: ${usage.reason ?? 'limit reached'}`}`
            : `Claude account: the Claude login already on this PC (no accounts added in Settings → Claude accounts)${usage.ok ? '' : ` — can't start runs: ${usage.reason ?? 'limit reached'}`}`,
        ].filter(Boolean);
      },
    });
    this.registerHealthChecks();
    this.registerAppCapabilities();
  }

  /**
   * How agents ask the owner for approval in `project` (the open one by default): the project's own setting,
   * else the app preference (Settings → Agents), else autonomous. Spending money and publishing ask in every mode.
   */
  permissionMode(project: ProjectContext | null = this.project): PermissionMode {
    return effectivePermissionMode(project?.settings().permissionMode, this.prefs.get().permissionMode);
  }

  /** Whether Kiln's copilot can take a kiln_request right now (the same test the tool makes); null when this setup has no Kiln. */
  private kilnFacts(): KilnFacts | null {
    if (!(this.modeling instanceof KilnModeling) || process.env.SHURIKEN_NO_KILN === '1') return null;
    const h = this.modeling.kiln.health;
    const q = this.modeling.builds.status();
    return { available: h.ok, detail: h.detail, startable: this.modeling.startable, buildsAtOnce: q.atOnce, queue: { running: q.running, queued: q.queued, ...(q.estimate ?? {}) } };
  }

  /** Kiln builds running now: each is a copilot turn on the user's subscription (the agent limit takes its share off). */
  kilnBuilds(): number {
    return this.modeling instanceof KilnModeling ? this.modeling.builds.running : 0;
  }

  /**
   * Several cores may share a data directory (one per app window); what must never be shared is a
   * project, so each open project is locked to its core (see openProject).
   */
  static async create(opts: CoreOptions): Promise<Core> {
    const core = new Core(opts);
    await core.init();
    return core;
  }

  private releaseProjectLock: (() => void) | null = null;
  private agentsElsewhere = 0;
  private leaseWatchdog: NodeJS.Timeout | null = null;

  /** How many agents work in the app's other project windows right now (the app-wide ceiling takes them off this one's). */
  setAgentsElsewhere(n: number): void {
    const next = Math.max(0, Math.round(n));
    if (next === this.agentsElsewhere) return;
    this.agentsElsewhere = next;
    this.orchestrator.kick();
  }

  private async init(): Promise<void> {
    const synced = this.skills.syncBundled();
    this.skills.reindex();
    if (this.opts.integrations !== false) await this.plugins.loadAll().catch((e) => this.log.warn('Plugin loading failed', errorMessage(e)));
    const seeded = seedKnowledge(this.knowledge, this.opts.resourcesDir);
    this.log.info('Core starting', { version: this.opts.appVersion, skillsSynced: synced, knowledgeSeeded: seeded });
    // Skins forge in batches on the GPU where the app has one (resolve.ts warmSkins); anything it can't draw, on the CPU.
    if (this.opts.forgeGpu) setForgeBatch(gpuForgeBatch(this.opts.forgeGpu, (msg, data) => this.log.warn(msg, data)));
    let port = Number(this.setting('mcpPort') ?? this.opts.mcpPort ?? 0);
    if (!Number.isFinite(port)) port = 0;
    await this.mcp.start(port);
    this.setSetting('mcpPort', String(Number(new URL(this.mcp.url).port)));
    // Persistent token for the user's own MCP clients (shown in Integrations → MCP).
    let external = this.setting('mcpExternalToken');
    if (!external) {
      external = randomBytes(24).toString('base64url');
      this.setSetting('mcpExternalToken', external);
    }
    this.mcp.registerPersistentToken(external, { kind: 'external', runId: null, taskId: null, role: null, providerId: null, allowedTools: null });

    if (this.opts.integrations !== false) {
      // Before Studio is opened for the project: a Studio window loads the plugins it finds when it starts.
      await this.studioLink?.start().catch((e) => this.log.warn('Shuriken Link start failed', errorMessage(e)));
      void this.studio.start().catch((e) => this.log.warn('Studio MCP start failed', errorMessage(e)));
      if (!this.opts.safeMode) this.placeGuard.start();
      if (!this.opts.safeMode) this.placeLink.start();
      setTimeout(() => void this.health.runAll(false).then(() => this.verifyProviderVersions()).catch((e) => this.log.warn('Health run failed', e)), 1500);
      // Who the PC's own Claude login is (so it can serve as one more account, unless it duplicates one).
      setTimeout(() => void this.refreshPcLogin().catch((e) => this.log.warn('Could not read the PC Claude login', errorMessage(e))), 4000);
      this.healthTimer = setInterval(() => void this.health.runAll(false).catch(() => {}), 10 * 60 * 1000);
      const want = this.opts.openProject === undefined ? 'last' : this.opts.openProject;
      const target = want === 'last' ? this.setting('lastProjectId') : want;
      if (want === 'blank') {
        // A new project window opened blank: its project exists before its page asks for it.
        try {
          this.createBlankProject();
        } catch (e) {
          this.log.warn('Could not open a blank project', errorMessage(e));
        }
      } else if (target && this.projects.get(target)) {
        try {
          this.openProject(target, { hold: !this.opts.resumeBuild });
        } catch (e) {
          this.log.warn('Could not open the project at startup', errorMessage(e));
        }
      }
    }
  }

  /**
   * Upstream-change guard: when a provider's installed version differs from the last version that
   * passed live probes, mark its capabilities unverified and run the (cheap) deep probe once. The
   * orchestrator will not start runs on a provider whose health is unavailable.
   */
  async verifyProviderVersions(): Promise<void> {
    for (const p of this.providers.list()) {
      const h = this.health.get(`provider:${p.id}`);
      const version = h?.version ?? null;
      if (!version) continue;
      const key = `provider.${p.id}.verifiedVersion`;
      const verified = this.setting(key);
      if (verified === version) continue;
      this.log.warn(`${p.displayName} version ${verified ?? '(never verified)'} → ${version}: running live compatibility probe`);
      for (const c of this.capabilities.list(`provider:${p.id}`)) {
        if (c.status === 'healthy') this.capabilities.setStatus(c.id, 'unknown', `Version changed to ${version}; verification pending`);
      }
      const deep = await this.health.run(`provider:${p.id}`, true);
      if (deep.status === 'healthy') {
        this.setSetting(key, version);
        this.log.info(`${p.displayName} ${version} verified by live probe`);
      } else {
        this.log.error(`${p.displayName} ${version} failed compatibility probe`, deep.summary);
      }
    }
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  setting(key: string): string | null {
    return this.global.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.global.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, value, nowIso()]);
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(input: { name: string; rootPath: string; description?: string; template?: 'roblox' | 'adopted' | 'empty' }): ProjectSummary {
    const summary = this.projects.create(input);
    return summary;
  }

  /** Where new projects are created: Documents/Shuriken Studio/Projects (or SHURIKEN_PROJECTS_DIR). */
  projectsRoot(): string {
    return process.env.SHURIKEN_PROJECTS_DIR ?? join(homedir(), 'Documents', 'Shuriken Studio', 'Projects');
  }

  /**
   * The start page's one action: a prompt becomes a project with its own place file, Studio opens it,
   * and the director starts building. Returns as soon as the project exists; Studio and planning
   * continue in the background and report through the chat.
   */
  createProjectFromPrompt(prompt: string, roblox?: ProjectRobloxChoice): ProjectSummary {
    const name = titleFromPrompt(prompt);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
    let dir = join(this.projectsRoot(), slug);
    for (let i = 2; existsSync(dir); i++) dir = join(this.projectsRoot(), `${slug}-${i}`);
    const summary = this.projects.create({ name, rootPath: dir, description: prompt });
    const ctx = this.openProject(summary.id);
    ctx.updateSettings({ autonomy: 'supervised' });
    // Its community or account is set before anything is built or uploaded.
    this.applyRobloxChoice(ctx, roblox);
    const placeFile = join(ctx.root, `${basename(dir)}.rbxlx`);
    writeFileSync(placeFile, sandboxPlaceXml(name), 'utf8');
    ctx.updateExtras({ placeFile: basename(placeFile) });
    this.director.startBuild(prompt, name);
    void this.openStudioFor(ctx, placeFile);
    return this.projects.get(summary.id)!;
  }

  /**
   * "Open blank": a new project straight into its workspace, with nothing started — no plan, no Studio
   * place, no agents. The first game the user describes to the director sets those up (prepareBuild),
   * the same as the start page.
   */
  createBlankProject(): ProjectSummary {
    const taken = new Set(this.projects.list().map((s) => s.name.toLowerCase()));
    let name = 'Untitled game';
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `Untitled game ${i}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    let dir = join(this.projectsRoot(), slug);
    for (let i = 2; existsSync(dir); i++) dir = join(this.projectsRoot(), `${slug}-${i}`);
    const summary = this.projects.create({ name, rootPath: dir, description: '' });
    const ctx = this.openProject(summary.id);
    ctx.updateSettings({ autonomy: 'supervised' });
    ctx.updateExtras({ blank: true });
    new ChatService(ctx, this.bus).add({
      role: 'director',
      kind: 'text',
      text: 'A blank project: nothing is running and Studio stays closed until you want it. Look around, or tell me about the game you want to make and I’ll set up its Studio place and get the team building, the same as from the start page.',
    });
    return this.projects.get(summary.id)!;
  }

  /**
   * A game is starting from the chat. A project opened blank gets what the start page gives one: the
   * game's name, its sandbox place, and Studio opened on it. Projects that have a place (or a linked
   * Studio place) are left as they are.
   */
  private prepareBuild(ctx: ProjectContext, request: string, title: string): void {
    const extras = ctx.extras();
    let name = ctx.summary.name;
    if (extras.blank && extras.userNamed) ctx.updateExtras({ blank: false });
    else if (extras.blank) {
      name = title.trim() || titleFromPrompt(request);
      const renamed = this.projects.rename(ctx.summary.id, name, request);
      if (renamed) ctx.summary = { ...ctx.summary, name: renamed.name, description: renamed.description };
      ctx.updateExtras({ blank: false });
      this.bus.emit('project.changed', { projectId: ctx.summary.id });
    }
    if (extras.placeFile || ctx.settings().robloxStudioMatch) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
    const placeFile = join(ctx.root, `${slug}.rbxlx`);
    if (!existsSync(placeFile)) writeFileSync(placeFile, sandboxPlaceXml(name), 'utf8');
    ctx.updateExtras({ placeFile: basename(placeFile) });
    if (this.opts.integrations !== false && !this.opts.safeMode) void this.openStudioFor(ctx, placeFile);
  }

  /**
   * Places open in Studio right now, for "Open a game…": each with the project that already works on
   * it (a game plugged in before, or a Shuriken project's own place file).
   */
  async studioPlaces(): Promise<Array<{ name: string; placeId: string | null; project: { id: string; name: string } | null }>> {
    const studios = await this.studio.listStudios();
    const projects = this.projects.list();
    return studios
      .filter((s) => s.name && s.name !== '(loading)')
      .map((s) => {
        const name = s.name.replace(/\s*\(placeId:.*$/, '');
        const placeId = /\(placeId:\s*(\d+)/.exec(s.name)?.[1] ?? null;
        const adopted = this.setting(`adopted:${name.toLowerCase()}`);
        const own = adopted ? projects.find((p) => p.id === adopted) : /\.rbxlx?$/i.test(name) ? projects.find((p) => existsSync(join(p.rootPath, name))) : undefined;
        return { name, placeId, project: own ? { id: own.id, name: own.name } : null };
      });
  }

  /**
   * Plugs in a game Shuriken didn't build: a place open in Studio (by its name there) or a place file.
   * Makes a project for it bound to that place and opens it here; its scripts come in as files and the
   * game is studied in the background (progress in the director's chat). A place plugged in before
   * reopens its project instead.
   */
  async adoptGame(input: { studio?: string; file?: string; roblox?: ProjectRobloxChoice }): Promise<ProjectSummary> {
    let from: 'studio' | 'file';
    let place: string;
    let placeId: string | null = null;
    let name: string;
    if (input.file) {
      place = resolve(String(input.file));
      if (!/\.rbxlx?$/i.test(place) || !existsSync(place)) throw new Error('Choose a Roblox place file (.rbxl or .rbxlx).');
      from = 'file';
      name = basename(place).replace(/\.rbxlx?$/i, '').replace(/[-_]+/g, ' ').trim() || 'My game';
    } else if (input.studio) {
      const wanted = String(input.studio).replace(/\s*\(placeId:.*$/, '');
      // A new window's core may still be connecting to Studio's MCP server.
      for (let i = 0; i < 30 && !this.studio.connected; i++) await new Promise((r) => setTimeout(r, 500));
      const studios = await this.studio.listStudios().catch(() => []);
      const s = studios.find((x) => x.name.replace(/\s*\(placeId:.*$/, '') === wanted);
      if (!s) throw new Error(`"${wanted}" isn't open in Roblox Studio right now.`);
      from = 'studio';
      place = wanted;
      placeId = /\(placeId:\s*(\d+)/.exec(s.name)?.[1] ?? null;
      name = wanted.replace(/\.rbxlx?$/i, '');
    } else throw new Error('Pick a place open in Studio, or a place file.');
    const key = `adopted:${(from === 'file' ? basename(place) : place).toLowerCase()}`;
    const before = this.setting(key);
    if (before && this.projects.get(before)) {
      this.applyRobloxChoice(this.openProject(before, { hold: true }), input.roblox);
      return this.projects.get(before)!;
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
    let dir = join(this.projectsRoot(), slug);
    for (let i = 2; existsSync(dir); i++) dir = join(this.projectsRoot(), `${slug}-${i}`);
    const summary = this.projects.create({ name, rootPath: dir, description: from === 'file' ? `Plugged in from ${place}` : `Plugged in from the Studio place "${place}"`, template: 'adopted' });
    const ctx = this.openProject(summary.id, { hold: true });
    ctx.updateSettings({ autonomy: 'supervised' });
    this.applyRobloxChoice(ctx, input.roblox);
    ctx.updateExtras({ syncMode: 'shuriken', userNamed: true, adopted: { from, place, placeId, at: nowIso() } });
    this.setSetting(key, summary.id);
    const game = { from, place, placeId };
    if (from === 'file') {
      // Its own file stays where it is (the user's game); a copy of it as it was goes with the project.
      try {
        mkdirSync(join(ctx.dir, 'backups'), { recursive: true });
        copyFileSync(place, join(ctx.dir, 'backups', `original-${basename(place)}`));
      } catch (e) {
        this.log.warn('Could not copy the place file', errorMessage(e));
      }
      ctx.updateExtras({ placeFile: place });
      void (async () => {
        if (this.opts.integrations !== false && !this.opts.safeMode) await this.openStudioFor(ctx, place);
        if (this.project === ctx) await this.adoption.plugIn(ctx, game);
      })();
    } else {
      ctx.updateSettings({ robloxStudioMatch: place });
      this.lease.studio = place;
      this.studio.bind(place);
      void this.adoption.plugIn(ctx, game);
    }
    this.bus.emit('project.changed', { projectId: summary.id });
    return this.projects.get(summary.id)!;
  }

  private kilnClipsTimer: NodeJS.Timeout | null = null;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private checkpointWarned = 0;

  /** Saves the app's and the open project's write-ahead logs into their files; says so when a reader held one back. */
  private checkpointNow(): void {
    for (const [what, store] of [['global.db', this.global], ['project.db', this.project?.store]] as const) {
      const r = store?.checkpoint();
      if (r && r.done < r.log && Date.now() - this.checkpointWarned > 60 * 60_000) {
        this.checkpointWarned = Date.now();
        this.log.warn(`${what}: ${r.log - r.done} of ${r.log} log pages could not be saved yet (another connection is reading)`, r);
      }
    }
  }
  /** The last publish the chat was told about (the plugin's link of the published window can come back more than once). */
  private publishNoted: { key: string; at: number } | null = null;
  private housekeeping = false;

  /** One round of housekeeping for the open project, when nobody works on it (see HOUSEKEEPING). */
  async housekeepNow(): Promise<void> {
    const p = this.project;
    if (!p || this.housekeeping || (this.orchestrator.state().working ?? this.orchestrator.state().activeRuns) > 0) return;
    this.housekeeping = true;
    try {
      const r = await housekeepAll(p);
      if (r.runs || r.chat) this.logger.scope('housekeeping').info(`Archived ${r.runs} finished run${r.runs === 1 ? '' : 's'}' transcripts (${r.messages} steps) and ${r.chat} old chat line${r.chat === 1 ? '' : 's'} to ${r.archive ?? 'the archive'}`);
    } catch (e) {
      this.logger.scope('housekeeping').warn('Housekeeping failed', errorMessage(e));
    } finally {
      this.housekeeping = false;
    }
  }
  private syncingClips = false;

  /** Brings in clips the user changed in Kiln on this project's linked models. */
  async syncKilnClips(): Promise<string[]> {
    const ctx = this.project;
    if (!ctx || this.syncingClips || process.env.SHURIKEN_NO_KILN === '1' || !(this.modeling instanceof KilnModeling)) return [];
    this.syncingClips = true;
    try {
      const models = await this.modeling.syncClips(ctx.root);
      if (models.length) this.log.info(`Clips from Kiln updated: ${models.join(', ')}`);
      return models;
    } catch (e) {
      this.log.warn('Syncing clips from Kiln failed', errorMessage(e));
      return [];
    } finally {
      this.syncingClips = false;
    }
  }

  /** Studies the open plugged-in game again (after big changes made in Studio). */
  studyGame(): void {
    const ctx = this.requireProject();
    if (!ctx.extras().adopted) throw new Error('Only a game plugged in from Studio or a place file is studied.');
    void this.adoption.study(ctx).catch((e) => this.log.warn('Studying the game failed', errorMessage(e)));
  }

  /** Renames the open project (the user's choice: a game started later from the chat keeps it). */
  renameProject(name: string): ProjectSummary {
    const ctx = this.requireProject();
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!n) throw new Error('Give the project a name.');
    const renamed = this.projects.rename(ctx.summary.id, n);
    if (!renamed) throw new Error('That project is gone.');
    ctx.summary = { ...ctx.summary, name: renamed.name };
    this.logger.setProject(renamed.name);
    ctx.updateExtras({ userNamed: true });
    this.bus.emit('project.changed', { projectId: ctx.summary.id });
    return renamed;
  }

  /** Saves the open project's place file through Studio (its File menu, Ctrl+S where it has none; verified by the file's time). */
  /** The user pressed Save: save the place now (even if another app is in front). */
  async savePlace(): Promise<{ ok: boolean; message: string }> {
    return this.placeGuard.saveNow('user', true);
  }

  /** Opens a project's place in Studio and binds to it; progress and problems go to the chat. */
  async openStudioFor(ctx: ProjectContext, placeFile: string): Promise<void> {
    const chat = new ChatService(ctx, this.bus);
    const note = chat.add({ role: 'system', kind: 'status', text: 'Opening your place in Roblox Studio…' });
    try {
      // The build's own open: Studio comes up behind the window the user is in.
      const inst = await this.studio.openPlace(placeFile, basename(placeFile), undefined, { background: true });
      const match = inst.name.replace(/\s*\(placeId:.*$/, '');
      ctx.updateSettings({ robloxStudioMatch: match });
      this.studio.bind(match);
      chat.update(note.id, { text: 'Roblox Studio is open and connected.' });
    } catch (e) {
      chat.update(note.id, { kind: 'error', text: `Couldn't open Roblox Studio automatically (${errorMessage(e)}). Open ${basename(placeFile)} in Studio with its MCP server enabled; work continues once it connects.` });
    }
  }

  async refreshPcLogin(): Promise<void> {
    const provider = this.providers.get('claude');
    if (!provider?.authFor) return;
    const a = await provider.authFor(null);
    this.accounts.update(PC_ACCOUNT_ID, { signedIn: !!a?.authenticated, email: a?.account ?? null, plan: a?.plan ?? null, checkedAt: nowIso() });
  }

  /**
   * Opening a project brings its place up in Studio when it is not open yet, so reopening a project
   * (or restoring its window) needs no manual Studio step. Quiet when the place is already open; never
   * launches Studio while the Studio connection is still unknown (that could open a duplicate).
   */
  private async ensureStudio(ctx: ProjectContext): Promise<void> {
    const file = placePath(ctx);
    if (!file || this.opts.integrations === false || this.opts.safeMode) return;
    if (!existsSync(file)) return;
    for (let i = 0; i < 30 && !this.studio.connected; i++) await new Promise((r) => setTimeout(r, 500));
    if (!this.studio.connected || this.project !== ctx) return;
    const studios = await this.studio.listStudios().catch(() => null);
    if (!studios || this.project !== ctx) return;
    // A recovery copy of the place open instead (the user opened Studio's auto-recovery file): the team works there, and
    // the place file is not opened in a second window next to it.
    const onCopy = (await this.placeLink.check())?.kind === 'recovery' && this.placeLink.onRecovery;
    // Open under the game's name once Studio knows the place is published, and proven to be this file's document: not
    // opened a second time next to it.
    const open = studios.some((s) => s.name.toLowerCase().includes(basename(file).toLowerCase())) || !!(await this.studio.samePlaceById(studios).catch(() => null));
    // Opened by hand while the project had no link yet: linked now (RobloxStudioAdapter.linkOwnPlace).
    if (open && !ctx.settings().robloxStudioMatch) this.studio.linkOwnPlace(studios);
    if (!onCopy && !open) {
      // Studio may have closed without the crash being seen (no team run at that moment): its recovery copy, when newer
      // than the place file, is what opens, as after a crash (PlaceGuard.recoverCopy).
      const recovered = (() => {
        try {
          return this.placeGuard.recoverCopy(ctx, file);
        } catch (e) {
          this.log.warn("Studio's recovery copy could not be used", errorMessage(e));
          return null;
        }
      })();
      if (recovered) ctx.audit.event({ kind: 'place.recovered', severity: 'info', title: `Opening ${basename(file)} from Studio's recovery copy of ${new Date(recovered.copyAt).toLocaleTimeString()} (its last save was at ${new Date(recovered.savedAt).toLocaleTimeString()})` });
      await this.openStudioFor(ctx, file);
    }
    // A place file in the other format than its name (binary in .rbxlx) is said once, with how to fix it.
    if (this.project === ctx) this.placeGuard.checkFormat(ctx);
    // The place may have opened without its world (never saved): rebuild it from world/ before work continues.
    if (this.project === ctx && this.studio.binding) await this.placeGuard.heal(ctx).catch((e) => this.log.warn('Place check failed', errorMessage(e)));
  }

  /**
   * Opens a project. With `hold` (the user opening one, or a window restored at launch) nothing is set
   * off: unfinished work waits for Resume (or a request to the director) and Studio isn't launched
   * until work starts or the user asks for it. A project that can't open (its folder gone, open in another
   * window) is refused before anything closes: the current project stays open.
   */
  openProject(id: string, opts: { hold?: boolean } = {}): ProjectContext {
    if (this.project?.summary.id === id) return this.project;
    const summary = this.openable(id);
    return this.openLocked(summary, this.lockProject(summary), opts);
  }

  /**
   * The user opens another project in this window (the Projects menu, Open a game): once it is known to be free
   * to open, agents still working on the current one are interrupted and waited for (Orchestrator.letGo), so
   * their tasks come back as interrupted and carry on when it is opened again, as after a restart.
   */
  async switchProject(id: string, opts: { hold?: boolean } = {}): Promise<ProjectContext> {
    if (this.project?.summary.id === id) return this.project;
    const summary = this.openable(id);
    const release = this.lockProject(summary);
    return this.leaveFor(() => this.openLocked(summary, release, opts)).catch((e: unknown) => {
      release();
      throw e;
    });
  }

  /** Runs `open` (another project into this window) once the current one's agents have come back; if it fails, they carry on. */
  async leaveFor<T>(open: () => T): Promise<T> {
    if (this.project) await this.orchestrator.letGo();
    try {
      return open();
    } catch (e) {
      this.orchestrator.stay();
      throw e;
    }
  }

  /** A known project whose folder still holds it: a moved or deleted one is reported, never made again empty. */
  private openable(id: string): ProjectSummary {
    const summary = this.projects.get(id);
    if (!summary) throw new Error(`Unknown project ${id}`);
    if (!existsSync(join(summary.rootPath, '.shuriken', 'project.json'))) {
      throw new Error(
        existsSync(summary.rootPath)
          ? `"${summary.name}" isn't a Shuriken project any more: ${summary.rootPath} has no .shuriken folder.`
          : `"${summary.name}" isn't where it was: ${summary.rootPath} was moved or deleted. If you moved it, open its new folder from Open a game… (Choose its folder…).`,
      );
    }
    return summary;
  }

  private lockProject(summary: ProjectSummary): () => void {
    return acquireLock(join(summary.rootPath, '.shuriken', 'open.lock'), (pid) => `"${summary.name}" is already open in another Shuriken Studio window (process ${pid}).`);
  }

  /** Opens a project whose lock this core holds (see openProject), closing the current one once it has opened. */
  private openLocked(summary: ProjectSummary, release: () => void, opts: { hold?: boolean }): ProjectContext {
    const id = summary.id;
    let ctx: ProjectContext;
    try {
      ctx = this.projects.open(id);
    } catch (e) {
      release();
      throw e;
    }
    this.closeProject();
    this.releaseProjectLock = release;
    this.project = ctx;
    this.logger.setProject(ctx.summary.name);
    this.placeGuard.reset();
    this.lease.studio = ctx.settings().robloxStudioMatch ?? null;
    this.knowledge.attachProject(ctx.store);
    this.skills.attachProject(ctx.summary.id, join(ctx.dir, 'skills'));
    this.skills.reindex();
    this.tools.attachAudit(ctx.audit);
    this.studio.bind(ctx.settings().robloxStudioMatch);
    void ctx.git.ensureRepo().catch((e) => this.log.warn('git init failed', errorMessage(e)));
    this.orchestrator.attach(ctx, { autostart: !this.opts.safeMode, hold: opts.hold });
    this.setSetting('lastProjectId', id);
    ctx.audit.event({ kind: 'project.opened', title: `Project opened: ${ctx.summary.name}` });
    // A store or match module written by an older runtime is written again (what it holds stays as it was put in the game).
    if (!this.opts.safeMode) {
      try {
        const sf = new Storefront(ctx.root);
        if (sf.catalog().items.length && sf.moduleStale(ctx.extras().syncMap)) sf.writeModule(ctx.extras().syncMap);
        const ms = new MatchSetup(ctx.root);
        const mc = ms.get();
        if (mc && ms.moduleStale(ctx.extras().syncMap)) ms.writeModule(mc, ctx.extras().syncMap);
      } catch (e) {
        this.log.warn('Could not renew a generated module', errorMessage(e));
      }
    }
    this.scheduleHealth('app');
    this.bus.emit('project.changed', { projectId: id });
    if (opts.hold) this.studioOnWake = ctx;
    else void this.ensureStudio(ctx).catch((e) => this.log.warn('Could not open the place in Studio', errorMessage(e)));
    return ctx;
  }

  /** A project opened on hold opens its place in Studio once work starts (see openProject). */
  private studioOnWake: ProjectContext | null = null;

  /** The user asked for the place (the viewer's button): open it in Studio now. */
  async openPlaceInStudio(): Promise<void> {
    const ctx = this.requireProject();
    this.studioOnWake = null;
    await this.ensureStudio(ctx);
  }

  /**
   * Deletes a project from Shuriken: closes it here first, and refuses while another window has it open
   * (its agents may be working). Returns the folder, which the app moves to the Recycle Bin if asked.
   */
  deleteProject(id: string): { name: string; rootPath: string } {
    const summary = this.projects.get(id);
    if (!summary) throw new Error('That project no longer exists.');
    if (this.project?.summary.id === id) this.closeProject();
    // Taking the lock proves no other tab has it open; let go of it straight away.
    const lock = join(summary.rootPath, '.shuriken', 'open.lock');
    if (existsSync(summary.rootPath)) {
      const release = acquireLock(lock, () => `"${summary.name}" is open in another window. Close it there first, then delete it.`);
      release();
    }
    this.projects.remove(id);
    this.logger.scope('projects').info('Project deleted', { id, name: summary.name, rootPath: summary.rootPath });
    return { name: summary.name, rootPath: summary.rootPath };
  }

  closeProject(): void {
    if (!this.project) return;
    this.references.stop();
    this.orchestrator.attach(null);
    this.tools.attachAudit(null);
    this.knowledge.attachProject(null);
    this.skills.attachProject(null, null);
    this.project.close();
    this.project = null;
    this.releaseProjectLock?.();
    this.releaseProjectLock = null;
    this.lease.studio = null;
    this.logger.setProject(null);
    this.bus.emit('project.changed', { projectId: null });
  }

  requireProject(): ProjectContext {
    if (!this.project) throw new Error('No project is open');
    return this.project;
  }

  /** Invoke a capability-layer tool on behalf of the user (UI) or system. */
  invokeTool(name: string, args: unknown, kind: CallerContext['kind'] = 'ui') {
    return this.tools.invoke(name, args, { kind, runId: null, taskId: null, role: kind === 'ui' ? 'user' : 'system', providerId: null, allowedTools: null });
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  private registerHealthChecks(): void {
    this.health.register({
      id: 'app',
      name: 'Shuriken Studio core',
      run: async () => ({
        version: this.opts.appVersion,
        checks: [
          { id: 'app.db', name: 'Global database', status: 'healthy', message: `schema v${this.global.schemaVersion()} · ${this.global.path}`, durationMs: 0 },
          {
            id: 'app.project',
            name: 'Project database',
            status: 'healthy',
            message: this.project ? `schema v${this.project.store.schemaVersion()} · ${this.project.summary.name}` : 'No project open',
            durationMs: 0,
          },
        ],
      }),
    });
    this.health.register(filesystemCheck([{ name: 'App data', path: this.opts.dataDir }]));
    for (const p of this.providers.list()) this.health.register(providerCheck(p, this.capabilities, () => this.probeContext()));
    this.health.register({
      id: 'mcp-server',
      name: 'Shuriken MCP server',
      run: async () => ({ checks: await this.mcpSelfTest(), version: this.opts.appVersion }),
    });
    this.health.register({
      id: STUDIO_INTEGRATION,
      name: 'Roblox Studio',
      run: async () => {
        await this.stopOrphanedPlaytest();
        const checks = await this.studio.healthChecks();
        return { checks, version: this.studio.installInfo.studioVersion };
      },
    });
    this.health.register({
      id: 'studio-link',
      name: 'Shuriken Link (Studio plugin)',
      run: async () => {
        const s = this.studioLinkStatus();
        const calls = this.studio.linkStats;
        if (!s.available) return { checks: [{ id: 'link.state', name: 'Studio plugin', status: 'unsupported' as const, message: 'Not used here (only in the app on Windows)', durationMs: 0 }] };
        if (!s.enabled) return { checks: [{ id: 'link.state', name: 'Studio plugin', status: 'degraded' as const, message: "Switched off in Settings → Roblox: Luau goes through Studio's MCP server alone, which can't create scripts or load game modules since 2026-10-01 (Shuriken works around it)", durationMs: 0 }] };
        return {
          checks: [
            { id: 'link.plugin', name: 'Plugin file', status: s.installed ? ('healthy' as const) : ('degraded' as const), message: s.installed ? `In Studio's Plugins folder (${s.pluginFile})` : `Could not be written to ${s.pluginFile ?? "Studio's Plugins folder"}`, durationMs: 0 },
            { id: 'link.port', name: 'Listening', status: s.port ? ('healthy' as const) : ('degraded' as const), message: s.port ? `127.0.0.1:${s.port}` : 'No free port: Luau goes through Studio MCP', durationMs: 0 },
            {
              id: 'link.session',
              name: "This project's place",
              status: s.linked.includes('Edit') ? ('healthy' as const) : ('needs_configuration' as const),
              message: s.linked.length
                ? `Linked: ${s.linked.join(', ')} · ${calls.calls} Luau calls through the plugin (${calls.failed} failed)`
                : this.studio.binding
                  ? "Not linked yet: a Studio window loads the plugin when it starts, so close and reopen the place's Studio window once"
                  : 'No place is bound to this project yet',
              durationMs: 0,
            },
          ],
          version: String(s.version),
        };
      },
    });
    this.health.register({
      id: 'git',
      name: 'Git',
      run: async () => {
        const v = await GitService.version();
        const checks: HealthCheckResult[] = [{ id: 'git.installed', name: 'git', status: v ? 'healthy' : 'unavailable', message: v ? `git ${v}` : 'git not found on PATH', durationMs: 0 }];
        if (v && this.project) {
          checks.push({ id: 'git.repo', name: 'Project repository', status: this.project.git.isRepo() ? 'healthy' : 'needs_configuration', message: this.project.git.isRepo() ? `branch ${(await this.project.git.branch()) ?? '?'}` : 'Not a git repository yet', durationMs: 0 });
        }
        this.capabilities.upsert({ id: 'git.checkpoint', integration: 'git', name: 'Checkpoints', status: v ? 'healthy' : 'unavailable', version: v });
        this.capabilities.upsert({ id: 'git.diff', integration: 'git', name: 'Diff', status: v ? 'healthy' : 'unavailable', version: v });
        return { checks, version: v };
      },
    });
    this.health.register({ id: 'plugins', name: 'Plugins', run: async () => ({ checks: await this.plugins.healthChecks() }) });
    this.health.register({
      id: 'open-cloud',
      name: 'Open Cloud Luau',
      run: async () => {
        const cloud = this.project?.extras().cloud ?? { universeId: null, placeId: null };
        const checks = await this.cloud.healthChecks(cloud);
        const ok = checks.every((c) => c.status === 'healthy');
        this.capabilities.upsert({ id: 'cloud.luau', integration: 'open-cloud', name: 'Headless Luau execution', status: ok ? 'healthy' : 'needs_configuration', description: 'Run Luau on a published place version without Studio (CI/testing backend)', limitations: ['5 task creations/min and an undocumented ~30/hour cap per API-key owner', 'Max 5 min per task; results <= 4 MB; logs <= 450 KB', 'Runs against the published place: live DataStores are reachable, never write production data from tests', 'No physics simulation; place scripts do not auto-run'] });
        return { checks };
      },
    });
    this.health.register({
      id: 'luau-toolchain',
      name: 'Luau toolchain',
      run: async () => {
        const checks = await this.luau.healthChecks();
        const ok = checks.filter((c) => c.id !== 'luau.types').every((c) => c.status === 'healthy');
        this.capabilities.upsert({ id: 'luau.check', integration: 'luau-toolchain', name: 'Static analysis', status: ok ? 'healthy' : 'degraded', detail: checks.map((c) => c.message).join(' · ') });
        return { checks };
      },
    });
  }

  private registerAppCapabilities(): void {
    for (const [id, name] of [
      ['app.project', 'Project overview'],
      ['app.tasks', 'Task graph'],
      ['app.tests', 'Test registry'],
      ['app.knowledge', 'Knowledge base'],
      ['app.skills', 'Skills'],
      ['app.capabilities', 'Capability registry'],
      ['app.spec', 'Specification'],
      ['app.decisions', 'Decisions'],
      ['app.escalation', 'Human escalation'],
      ['app.research', 'Research records'],
      ['app.probe', 'Integration probe'],
      ['app.plugins', 'Plugin tools (external MCP servers)'],
      ['app.assets', 'Asset library'],
      ['app.modeling', '3D modeling (headless Blender → Roblox meshes)'],
      ['app.wait', 'Waiting for Studio, uploads and Kiln (wait_for)'],
      ['code.index', 'Luau code index'],
    ] as const) {
      this.capabilities.upsert({ id, integration: 'shuriken', name, status: 'healthy', version: this.opts.appVersion });
    }
    for (const [id, name] of [
      ['roblox.app.status', 'Studio status'],
      ['roblox.app.explore', 'DataModel explorer'],
      ['roblox.app.inspect', 'Instance inspector'],
      ['roblox.app.snapshot', 'DataModel snapshots'],
      ['roblox.app.sync', 'Code sync (disk → Studio)'],
      ['roblox.app.call', 'Studio tool passthrough'],
      ['roblox.app.perf', 'Performance snapshot'],
      ['roblox.app.assets', 'Asset analysis, usage and reuse'],
      ['roblox.app.geometry', 'Structured geometry (spec → world/ builder → Studio)'],
      ['roblox.app.animation', 'Animation workshop (clips → KeyframeSequences → Studio)'],
      ['roblox.app.vfx', 'Effects workshop (specs → particle/trail/beam templates → Studio)'],
      ['roblox.app.audio', 'Audio workshop (synthesized/Creator Store sounds → uploads → Studio)'],
    ] as const) {
      this.capabilities.upsert({ id, integration: STUDIO_INTEGRATION, name, status: 'unknown', version: this.opts.appVersion, description: 'Shuriken capability built on Studio MCP' });
    }
    this.bus.on('roblox.changed', (e) => {
      // The Studio check depends on which place the project is bound to.
      if (e.reason === 'binding') {
        this.scheduleHealth(STUDIO_INTEGRATION);
        this.lease.studio = this.studio.binding ?? null;
      }
      if (!e.reason.startsWith('connection:')) return;
      if (this.studio.connected) void this.stopOrphanedPlaytest();
      // Learn who uploads go to while Studio is idle, so an upload during a playtest doesn't fail.
      if (this.studio.connected && !this.prefs.get().robloxCreatorId) {
        void resolveCreator(this.studio, null, (id) => {
          if (!this.prefs.get().robloxCreatorId) this.prefs.set({ robloxCreatorId: id });
        }).catch(() => null);
      }
      // Studio came up after the project opened: check the place still has its world.
      if (this.studio.connected && this.project && this.studio.binding && !this.opts.safeMode) void this.placeGuard.heal(this.project).catch(() => undefined);
      const status = this.studio.connected ? 'healthy' : 'unavailable';
      for (const id of ['roblox.app.status', 'roblox.app.explore', 'roblox.app.inspect', 'roblox.app.snapshot', 'roblox.app.sync', 'roblox.app.call', 'roblox.app.perf', 'roblox.app.assets', 'roblox.app.geometry', 'roblox.app.animation', 'roblox.app.vfx', 'roblox.app.audio']) {
        this.capabilities.setStatus(id, status, this.studio.connected ? null : this.studio.conn.lastError);
      }
    });
  }

  /** Re-run one integration's health check soon (coalesced), e.g. after the project or binding changed. */
  private scheduleHealth(id: string): void {
    const prev = this.healthDebounce.get(id);
    if (prev) clearTimeout(prev);
    this.healthDebounce.set(
      id,
      setTimeout(() => {
        this.healthDebounce.delete(id);
        void this.health.run(id).catch((e) => this.log.warn(`Health re-check ${id} failed`, errorMessage(e)));
      }, 500),
    );
  }

  /**
   * A core that died holding play mode leaves Studio playing, which blocks every Edit-mode tool and the
   * next session's health check. Stop that playtest once Studio is reachable and bound.
   */
  async stopOrphanedPlaytest(): Promise<void> {
    const orphan = this.orphanPlaytest;
    if (!orphan || !this.studio.connected || !this.studio.binding || this.lease.holder) return;
    // Another window's Studio: not ours to stop (that project's core picks it up when it opens).
    if (orphan.studio && orphan.studio !== this.studio.binding) return;
    this.orphanPlaytest = null;
    try {
      const st = await this.studio.state();
      if (st.availableDataModels.includes('Edit')) return;
      await this.studio.setPlaying(false);
      const title = `Stopped a playtest left running by an interrupted session (${orphan.owner})`;
      this.log.warn(title);
      this.project?.audit.event({ kind: 'recovery', severity: 'warning', title });
    } catch (e) {
      this.orphanPlaytest = orphan; // retry on the next connection or health check
      this.log.warn('Could not stop an orphaned playtest', errorMessage(e));
    }
  }

  private async probeContext(): Promise<ProbeContext> {
    const token = this.mcp.issueToken({ kind: 'probe', runId: null, taskId: null, role: 'probe', providerId: null, allowedTools: new Set(['probe_submit']) }, 10 * 60 * 1000);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
    return {
      probeServer: this.mcp.refFor(token, 'shuriken_probe'),
      waitForProbeNonce: (nonce, ms) => this.mcp.waitForNonce(nonce, ms),
      cwd: this.project?.root ?? this.opts.dataDir,
      signal: ctrl.signal,
    };
  }

  /** Connect to our own MCP server as a client: proves the transport, auth and tool listing work. */
  private async mcpSelfTest(): Promise<HealthCheckResult[]> {
    const t0 = Date.now();
    if (!this.mcp.running) return [{ id: 'mcp.listening', name: 'Listening', status: 'unavailable', message: 'Server not started', durationMs: 0 }];
    const token = this.mcp.issueToken({ kind: 'system', runId: null, taskId: null, role: 'health', providerId: null, allowedTools: null }, 60000);
    const client = new Client({ name: 'shuriken-selftest', version: this.opts.appVersion });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(this.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      await client.connect(transport);
      const tools = await client.listTools();
      const resources = await client.listResources();
      await client.close();
      return [
        { id: 'mcp.listening', name: 'Listening', status: 'healthy', message: this.mcp.url, durationMs: 0 },
        { id: 'mcp.roundtrip', name: 'Client round-trip', status: 'healthy', message: `${tools.tools.length} tools, ${resources.resources.length} resources (${Date.now() - t0} ms)`, durationMs: Date.now() - t0 },
      ];
    } catch (e) {
      return [{ id: 'mcp.roundtrip', name: 'Client round-trip', status: 'unavailable', message: errorMessage(e), durationMs: Date.now() - t0 }];
    } finally {
      this.mcp.revokeToken(token);
    }
  }

  /** Shuriken Link's state for Settings and the health check. */
  studioLinkStatus(): StudioLinkStatus & { available: boolean; calls: number; failed: number } {
    const s = this.studioLink?.status() ?? { enabled: this.prefs.get().studioLink !== false, installed: false, pluginFile: null, port: null, linked: [], places: [], version: 0 };
    return { ...s, available: !!this.studioLink, calls: this.studio.linkStats.calls, failed: this.studio.linkStats.failed };
  }

  /** The "Studio plugin" setting changed: write or remove the plugin file, open or close the port. */
  async applyStudioLink(): Promise<void> {
    await this.studioLink?.apply().catch((e) => this.log.warn('Applying the Studio plugin setting failed', errorMessage(e)));
    this.bus.emit('roblox.changed', { reason: 'link' });
  }

  /**
   * The project's place came back under another name: Studio reloads a place it has just published (the window's
   * title and the name its MCP server lists change), and the plugin recognises the place by the mark its last link
   * left in it. The project follows: it is bound to the new name, and its place file is no longer the place the team
   * works in (the published place saves to Roblox). In the user's first build after 1.11 a publish was taken for a
   * crash: the old file was reopened in a second window and the team built there while the user tested the first.
   */
  private followPlace(display: string, now: LinkPlace, before: LinkPlace | null): void {
    const ctx = this.project;
    if (!ctx) return;
    const file = ctx.extras().placeFile;
    // Local first: a project with its own place file keeps working on it after a publish. The local file is what is
    // saved, backed up and reopened after a crash; the published game is overwritten by publishing the file again.
    // Following the published place left a project with no saves, no backups and no crash recovery, bound to the
    // plugin's name for the place ("Place2"), which Studio lists under the game's ("Voxel Pit"): attached to nothing.
    if (file && !now.placeId) {
      // Saved under another name, or another place opened in the window: the project keeps its own file (and opens it
      // again for the team), instead of following the window somewhere its saves, backups and recovery don't go.
      const text = `Studio's window of ${file} now shows "${now.place}". The team keeps working on ${file}, and I'm opening it again in Studio; the "${now.place}" window is yours.`;
      ctx.audit.event({ kind: 'studio.place.left', severity: 'info', title: text, detail: { display, before: before?.place ?? null } });
      new ChatService(ctx, this.bus).add({ role: 'system', kind: 'status', text });
      this.placeGuard.recovery.afterMove(now.place);
      return;
    }
    if (now.placeId && file) {
      const was = ctx.extras().cloud;
      // The game's name as Studio shows it ("Voxel Pit"); a default place name ("Place2") is not a name for the user.
      const shown = display.replace(/\s*\(placeId:.*\)\s*$/i, '').trim();
      const name = shown && !/^Place\d*$/i.test(shown) ? shown : (was?.name ?? null);
      const cloud = { universeId: now.gameId ? String(now.gameId) : null, placeId: String(now.placeId), name };
      ctx.updateExtras({ cloud });
      const key = `${cloud.universeId}:${cloud.placeId}`;
      if (this.publishNoted?.key === key && Date.now() - this.publishNoted.at < 10 * 60_000) return;
      this.publishNoted = { key, at: Date.now() };
      // The window it was published from is the published game now: the local file is opened again for the team.
      this.placeGuard.recovery.afterMove(now.place);
      const text = `You published ${file} to Roblox${name ? ` as "${name}"` : ''}. The team keeps working on ${file}, your local copy (saved, backed up and reopened after a crash), and I'm opening it again in Studio. The window you published from is now the published game: close it when you're done with it. Publish from the local file again whenever players should get the changes.`;
      ctx.audit.event({ kind: 'studio.place.published', severity: 'info', title: text, detail: { display, placeId: now.placeId, gameId: now.gameId, before: before?.place ?? null, cloudBefore: was ?? null } });
      new ChatService(ctx, this.bus).add({ role: 'system', kind: 'status', text });
      this.bus.emit('roblox.changed', { reason: 'place-published' });
      return;
    }
    ctx.updateSettings({ robloxStudioMatch: display });
    ctx.updateExtras(now.placeId ? { placeFile: null, cloud: { universeId: now.gameId ? String(now.gameId) : null, placeId: String(now.placeId) } } : { placeFile: null });
    this.lease.studio = display;
    this.studio.bind(display);
    const was = before ? before.place : (file ?? 'the place');
    const text = now.placeId
      ? `You published this place as "${now.place}". The team now works in the published place${file ? `; ${file} stays as it was at that moment` : ''}.`
      : `This place is now "${now.place}" (it was ${was}). The team works there${file ? `; ${file} is no longer the project's place` : ''}.`;
    ctx.audit.event({ kind: 'studio.place.followed', severity: 'info', title: text, detail: { display, placeId: now.placeId, gameId: now.gameId, before: before?.place ?? null } });
    new ChatService(ctx, this.bus).add({ role: 'system', kind: 'status', text });
    this.bus.emit('roblox.changed', { reason: 'place-followed' });
  }

  /**
   * The user frees Studio (Agents page, or the director when they ask): whoever holds it loses its turn, its playtest is
   * stopped when Studio answers within ENFORCE.freeMs, and the starts and stops still waiting on Studio are dropped. An agent whose
   * playtest it was is told at its next call. Returns what was done, in words.
   */
  async freeStudio(by: 'user' | 'director'): Promise<string> {
    const holder = this.lease.holder;
    if (!holder) {
      // Nobody holds it; a start or stop that never came back may still be in the line.
      this.studio.resetPlayLine();
      this.lease.forfeit('freed');
      return 'Studio was already free: nobody held it. Anything still waiting on an old start or stop was dropped.';
    }
    const what = this.lease.describe() ?? ownerLabel(holder.owner);
    await Promise.race([this.studio.setPlaying(false).catch(() => null), new Promise((r) => setTimeout(r, ENFORCE.freeMs))]);
    this.lease.forfeit('freed');
    this.studio.resetPlayLine();
    const text = `Freed Studio from ${what}.`;
    this.project?.audit.event({ kind: 'studio.freed', severity: 'warning', title: `${by === 'director' ? 'The director freed Studio for you' : 'You freed Studio'}: ${what}`.slice(0, 300), detail: { owner: holder.owner } });
    this.bus.emit('roblox.changed', { reason: 'playtest:stop' });
    return text;
  }

  /** Who holds Studio now, in words (null when it is free). */
  studioHolder(): { owner: string; text: string; since: number } | null {
    const h = this.lease.holder;
    return h ? { owner: h.owner, text: this.lease.describe() ?? ownerLabel(h.owner), since: h.since } : null;
  }

  /** Whether uploads are on, and the account they go to when they go to a person: this project's own, else the default. */
  uploadsNow(): { enabled: boolean; creatorId: string | null } {
    return { enabled: this.prefs.get().uploadAssets !== false, creatorId: robloxId(this.project?.settings().robloxUserId) ?? (this.prefs.get().robloxCreatorId || null) };
  }

  /** Which Open Cloud key the open project's calls use (its own, the default, none) and the name its own is kept under. */
  async openCloudKey(): Promise<{ source: OpenCloudKeySource; projectKey: string | null }> {
    const id = this.project?.summary.id ?? null;
    return { source: await keySource(this.secrets, id), projectKey: id ? projectOpenCloudKey(id) : null };
  }

  /** A new project's Roblox side, chosen before it started: its community, or another account (start page, Open a game). */
  private applyRobloxChoice(ctx: ProjectContext, choice: ProjectRobloxChoice | undefined): void {
    const patch = choiceSettings(choice);
    if (patch) ctx.updateSettings(patch);
  }

  /** The published game's owner per project, read from Studio (kept 10 minutes; unpublished: null). */
  private readonly gameOwners = new Map<string, { at: number; owner: { type: 'Group' | 'User'; id: string } | null }>();

  /** Who uploads go to now: this project's community, the published game's owner, the default community, the person. */
  uploadOwner(): Promise<UploadOwner> {
    return resolveUploadOwner({
      projectGroup: () => this.project?.settings().robloxGroupId ?? null,
      projectUser: () => this.project?.settings().robloxUserId ?? null,
      defaultUser: () => this.prefs.get().robloxCreatorId || null,
      defaultGroup: () => this.prefs.get().robloxGroupId || null,
      gameOwner: async () => {
        const p = this.project;
        if (!p || !this.studio.connected) return null;
        const hit = this.gameOwners.get(p.root);
        if (hit && Date.now() - hit.at < 10 * 60_000) return hit.owner;
        const r = await this.studio.runLuau(GAME_OWNER_LUAU, 'Edit', 15_000).catch(() => null);
        if (!r?.ok) return hit?.owner ?? null;
        const owner = parseGameOwner(r.output);
        this.gameOwners.set(p.root, { at: Date.now(), owner });
        return owner;
      },
    });
  }

  async shutdown(): Promise<void> {
    if (this.opts.forgeGpu) setForgeBatch(null);
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.studioLink?.stop().catch(() => {});
    if (this.kilnClipsTimer) clearInterval(this.kilnClipsTimer);
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.leaseWatchdog) clearInterval(this.leaseWatchdog);
    this.placeGuard.stop();
    this.placeLink.stop();
    this.modeling.stop();
    this.usage.dispose();
    for (const t of this.healthDebounce.values()) clearTimeout(t);
    this.healthDebounce.clear();
    await this.orchestrator.stop().catch(() => {});
    this.closeProject();
    await this.studio.conn.disconnect().catch(() => {});
    await this.plugins.shutdown().catch(() => {});
    this.terminals.dispose();
    await this.mcp.stop().catch(() => {});
    this.capabilities.dispose();
    this.global.close();
  }

  settingJson<T>(key: string, fallback: T): T {
    return pj(this.setting(key), fallback);
  }

  setSettingJson(key: string, value: unknown): void {
    this.setSetting(key, j(value));
  }
}
