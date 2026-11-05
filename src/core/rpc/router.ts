import { nowIso } from '@shared/ids';
import { Storefront, STORE_LIMITS, checkCatalog, checkCopy, itemHash, itemStatus } from '../storefront/storefront';
import { readArt, writeArt } from '../capabilities/storefront-tools';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { sandboxPlaceXml } from '../roblox/place-template';
import { listWorldBuilders, rebuildWorld } from '../roblox/world-builder';
import type { Core } from '../core';
import { PC_ACCOUNT_ID } from '../accounts/account-service';
import { TestService } from '../verification/test-service';
import { AssetService } from '../assets/asset-service';
import { AssetCapture } from '../assets/asset-capture';
import { SUGGESTION_SCOPES, type SuggestionScope } from '../director/live-suggestions';
import { attachmentDataUrl } from '../director/attachments';
import { FEEDBACK_COMMAND, sendFeedback } from '../director/feedback';
import { LUAU_VIEW_PARTS, LUAU_VIEW_TERRAIN } from '../roblox/luau-snippets';
import { writeProjectReport } from '../projects/report';
import type { ProjectSettings, TaskStatus, EscalationRules } from '@shared/domain';
import { slimTask } from '../tasks/slim';
import type { ProjectRobloxChoice } from '@shared/roblox-keys';
import type { ProjectExtras } from '../projects/project-service';
import type { TaskPatch } from '../tasks/task-graph';
import { ROLES, roleLabels } from '../agents/roles';
import { AnimationStore } from '../animation/animation-service';
import { buildPreset, listPresets } from '../animation/presets';
import { bodyPartClip, clipMetrics, resolveAims } from '@shared/animation';
import { SoundLibrary } from '../audio/audio-library';
import { SampleLibrary } from '../audio/sample-library';
import { SFX_PRESETS } from '../audio/synth';
import { EffectStore } from '../effects/effects-service';
import { buildEffect, listEffectPresets } from '../effects/presets';
import { measureEffect } from '../effects/measure';
import { PreviewTextures } from '../effects/preview-textures';
import { ModelStore } from '../modeling/model-store';
import { knownViewerModels, viewerModelData } from '../roblox/viewer-models';
import { isStudioModeFlip } from '@shared/viewer';
import { checkRigClip, loadRigBody } from '../animation/rig-motion';
import { UiStore, uiImages } from '../ui/ui-workshop';
import { MockupStore } from '../ui/ui-mockups';
import { projectImages } from '../ui/ui-pictures';
import { encodePng } from '../modeling/png';
import { COPILOT_IDS, COPILOT_SUGGESTIONS, COPILOT_TITLES, isCopilotId, type CopilotId } from '../copilots/copilot-roles';
import { copilotChannel } from '../copilots/copilot-service';
import { DossierStore } from '../projects/game-study';
import { kilnClipName, readKilnClips } from '../animation/kiln-clips';
import { ownerLine } from '../roblox/upload-owner';
import { referenceRpc } from '../references/reference-rpc';
import { forgeRpc } from '../ui/forge/forge-rpc';
import { forgeGpuRpc } from '../ui/forge/forge-gpu-rpc';
import { buildCost, costOf } from '../costs/build-cost';

/** The dock copilot a chat channel belongs to ("copilot:animation" → animation); null for the director's. */
const copilotOf = (channel: unknown): CopilotId | null => {
  const id = typeof channel === 'string' && channel.startsWith('copilot:') ? channel.slice(8) : null;
  return isCopilotId(id) ? id : null;
};

type Handler = (params: any) => unknown | Promise<unknown>;

/** A tool's result for the UI: its data (or text) and whether it failed. */
function toolResult(out: { content: Array<{ type: string; text?: string }>; data?: unknown; isError?: boolean }) {
  const text = out.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
  return { ok: !out.isError, data: out.data ?? null, text };
}

/**
 * The RPC surface the UI uses. Every method is a thin adapter over core services; the renderer
 * never touches storage or providers directly.
 */

/** The viewer's read gave way to the team's Studio work (said to the renderer, which reads again later). */
export const VIEWER_BUSY = "Studio is busy with the team's work; the viewer reads the place again in a moment";
/** Whether a viewer read waits: the team is working and the place's Edit DataModel already has a command running or queued. */
export function viewerYields(s: { teamWorking: boolean; studioBusy: boolean }): boolean {
  return s.teamWorking && s.studioBusy;
}

/** The newest steps of a run the Agents page shows (the full transcript stays in the project). */
export const RUN_STEPS_SHOWN = 400;

export function createRouter(core: Core): Record<string, Handler> {
  const p = () => core.requireProject();
  /** When the active account's 5-hour usage window resets (epoch ms), if the provider has told us. */
  const fiveHourReset = (): number | null => {
    const acct = core.accounts.active('claude');
    const windows = core.usage.snapshot(core.accounts.usageKey('claude', acct)).windows;
    const w = Object.entries(windows).find(([k]) => /five|5h|hour/i.test(k))?.[1];
    return w?.resetsAt && w.resetsAt * 1000 > Date.now() ? w.resetsAt * 1000 : null;
  };
  /** The place the viewer reads: Edit normally; during a playtest the running game's server has the same map. */
  const viewerModel = async (): Promise<'Edit' | 'Server'> => {
    const st = await core.studio.state().catch(() => null);
    return st && !st.availableDataModels.includes('Edit') && st.availableDataModels.includes('Server') ? 'Server' : 'Edit';
  };
  /**
   * Runs viewer Luau. Studio flipping between Edit and Play ("Server datamodel is not available in Edit mode",
   * "Target is not reachable") makes the datamodel a read was aimed at vanish for a moment: the mode is read
   * again and the read tried again, twice. `pinned` reads (a later page of the parts, whose offset means one
   * datamodel's place) are not moved: they fail so the viewer starts its load over, quietly.
   */
  const viewerRead = async <T>(code: string, datamodel: 'Edit' | 'Server' | undefined, pinned: boolean): Promise<{ page: T; source: 'Edit' | 'Server' }> => {
    // The plugin runs one command at a time in each DataModel: a read of a big place (up to 2 minutes) held every
    // agent's Edit Luau behind it (20-30 s timeouts in a 20-agent build, 2026-10-03). While the team's own work waits
    // there, the viewer steps aside and reads again a little later (VIEWER_LOAD.failRetryMs).
    if (viewerYields({ teamWorking: core.runner.teamRuns().length > 0, studioBusy: !!core.studioLink?.server.list().some((s) => s.dm === 'Edit' && s.busy) })) {
      throw new Error(VIEWER_BUSY);
    }
    let dm = datamodel ?? (await viewerModel());
    for (let attempt = 0; ; attempt++) {
      try {
        // A read: play windows don't repeat it.
        return { page: await core.studio.luauJson<T>(code, dm, 120_000), source: dm };
      } catch (err) {
        if ((pinned && datamodel) || attempt >= 2 || !isStudioModeFlip((err as Error).message)) throw err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        dm = await viewerModel();
      }
    }
  };
  return {
    // ─── App ────────────────────────────────────────────────────────────────
    'app.info': () => ({
      version: core.opts.appVersion,
      dataDir: core.opts.dataDir,
      mcpUrl: core.mcp.url,
      mcpToken: core.setting('mcpExternalToken'),
      project: core.project?.summary ?? null,
      providers: core.providers.list().map((x) => ({ id: x.id, name: x.displayName, adapterVersion: x.adapterVersion, testedVersions: x.testedVersions })),
      roles: Object.values(ROLES).map((r) => ({ id: r.id, name: r.name, description: r.description, tier: r.tier })),
    }),
    // What the UI calls each role (agents, the dock copilots, Kiln builds).
    'roles.labels': () => roleLabels(),
    'app.logs': ({ limit, level }: { limit?: number; level?: 'debug' | 'info' | 'warn' | 'error' }) => core.logger.recent(limit ?? 500, level ?? 'debug'),
    'app.settings.get': ({ key }: { key: string }) => core.setting(key),
    'app.settings.set': ({ key, value }: { key: string; value: string }) => core.setSetting(key, value),

    // ─── Projects ───────────────────────────────────────────────────────────
    'projects.list': () => core.projects.list(),
    // ─── Start page & chat ────────────────────────────────────────────────────
    // A project already open here has its agents interrupted and waited for first (they carry on when it opens again).
    // roblox: the new game's community or account, chosen on the start page (its own key is saved by the renderer).
    'projects.createFromPrompt': ({ prompt, roblox }: { prompt: string; roblox?: ProjectRobloxChoice }) => {
      if (!prompt?.trim()) throw new Error('Describe what to make.');
      return core.leaveFor(() => core.createProjectFromPrompt(prompt.trim(), roblox));
    },
    'projects.createBlank': () => core.createBlankProject(),
    // "Open a game…": places open in Studio, plugging one in (or a place file), studying it again.
    'games.studioPlaces': () => core.studioPlaces(),
    'games.adopt': (input: { studio?: string; file?: string; roblox?: ProjectRobloxChoice }) => core.adoptGame(input ?? {}),
    'games.study': () => core.studyGame(),
    'games.dossier': () => {
      const proj = core.project;
      if (!proj) return null;
      const store = new DossierStore(proj.root);
      return { adopted: proj.extras().adopted ?? null, studying: core.adoption.busy(proj.summary.id), dossier: store.get(), brief: store.brief() };
    },
    'project.rename': ({ name }: { name: string }) => core.renameProject(String(name ?? '')),
    'projects.recent': ({ limit }: { limit?: number } = {}) =>
      core.projects
        .list()
        .slice(0, limit ?? 12)
        .map((s) => {
          const thumb = join(s.rootPath, '.shuriken', 'thumbnail.jpg');
          return { ...s, thumbnail: existsSync(thumb) ? `data:image/jpeg;base64,${readFileSync(thumb).toString('base64')}` : null, current: core.project?.summary.id === s.id };
        }),
    'projects.saveThumbnail': ({ dataUrl }: { dataUrl: string }) => {
      const proj = core.project;
      const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(dataUrl ?? '');
      if (!proj || !m) return false;
      writeFileSync(join(proj.dir, 'thumbnail.jpg'), Buffer.from(m[2]!, 'base64'));
      return true;
    },
    /** The start page's game ideas (director/start-ideas.ts); `suggestions.more` moves on to the next ones. */
    'suggestions.get': ({ count }: { count?: number } = {}) => core.startIdeas.get(count ?? 6),
    'suggestions.more': ({ count }: { count?: number } = {}) => core.startIdeas.more(count ?? 6),
    // The director's chat, or a dock copilot's (channel "copilot:<dock>").
    'chat.list': ({ limit, channel }: { limit?: number; channel?: string } = {}) => {
      const dock = copilotOf(channel);
      return (dock ? core.copilots.chat(dock) : core.director.chat())?.list(limit ?? 300) ?? [];
    },
    'chat.send': ({ text, channel, context, images }: { text: string; channel?: string; context?: { page?: string; item?: string; note?: string }; images?: Array<{ name?: string; dataUrl: string }> }) => {
      const pictures = Array.isArray(images) ? images : [];
      if (!text?.trim() && !pictures.length) throw new Error('Empty message');
      const dock = copilotOf(channel);
      // "/feedback …": straight to the developers' log and the session journal; no agent hears it.
      const note = FEEDBACK_COMMAND.exec(text ?? '');
      if (note) return sendFeedback(p(), core.bus, core.opts.dataDir, dock && channel ? channel : 'director', note[1] ?? '');
      const said = text?.trim() || 'Have a look at the attached picture.';
      return dock ? core.copilots.send(dock, said, context, pictures) : core.director.send(said);
    },
    /** A picture attached to a chat message, as a data URL. */
    'chat.attachment': ({ file }: { file: string }) => attachmentDataUrl(p(), String(file ?? '')),
    // Bubbles written for this game (null until the first set is written; a new one is written in the background once the game changed).
    'suggestions.live': ({ scope }: { scope: string }) => {
      const ctx = core.project;
      if (!ctx || !(SUGGESTION_SCOPES as readonly string[]).includes(scope)) return null;
      return core.liveSuggestions.get(ctx, scope as SuggestionScope);
    },
    'copilots.info': () => COPILOT_IDS.map((id) => ({ id, channel: copilotChannel(id), title: COPILOT_TITLES[id], suggestions: COPILOT_SUGGESTIONS[id], busy: core.copilots.busy(id) })),
    'copilots.stop': async ({ channel }: { channel: string }) => {
      const dock = copilotOf(channel);
      return dock ? core.copilots.stop(dock) : false;
    },
    'copilots.reset': ({ channel }: { channel: string }) => {
      const dock = copilotOf(channel);
      return dock ? core.copilots.reset(dock) : null;
    },
    'chat.answer': ({ escalationId, response }: { escalationId: string; response: string }) => {
      // Answering the team is asking it to carry on.
      core.orchestrator.wake();
      return p().governance.resolveEscalation(escalationId, 'answered', response);
    },
    'projects.create': (input: { name: string; rootPath: string; description?: string; template?: 'roblox' | 'empty'; open?: boolean }) => {
      const s = core.createProject(input);
      if (input.open !== false) core.openProject(s.id);
      return s;
    },
    'projects.open': async ({ id }: { id: string }) => (await core.switchProject(id, { hold: true })).summary,
    // A Shuriken project folder from another session or PC: listed here with its own identity (not opened).
    'projects.register': ({ rootPath }: { rootPath: string }) => {
      const root = String(rootPath ?? '');
      if (!root || !existsSync(join(root, '.shuriken', 'project.json'))) throw new Error("That folder isn't a Shuriken project (it has no .shuriken/project.json). To bring in a game, pick its place in Studio or a place file.");
      return core.projects.create({ name: '', rootPath: root, template: 'empty' });
    },
    // The viewer's "Open in Studio": the place now, even while the project is on hold.
    'project.openStudio': () => core.openPlaceInStudio(),
    'projects.close': () => core.closeProject(),
    'projects.archive': ({ id }: { id: string }) => core.projects.archive(id),
    'projects.delete': ({ id }: { id: string }) => core.deleteProject(id),
    'project.current': () => core.project?.summary ?? null,
    'app.prefs': () => core.prefs.get(),
    'app.prefs.update': (patch: { maxConcurrentAgents?: number; autoSave?: boolean; uploadAssets?: boolean; robloxCreatorId?: string; robloxGroupId?: string; keepScreenOn?: boolean; studioLink?: boolean; monetization?: boolean; copy?: boolean; plannerEffort?: import('../app-prefs').Effort; agentEffort?: import('../app-prefs').Effort; agentCap?: number; studioAgents?: number; polish?: import('../orchestrator/proposal-triage').PolishLevel }) => {
      // A raised polish setting is looked at now (proposals that waited may become tasks).
      if (patch.polish !== undefined) setTimeout(() => core.orchestrator?.kick(), 0);
      const next = core.prefs.set(patch);
      if (patch.studioLink !== undefined) void core.applyStudioLink();
      if (patch.keepScreenOn !== undefined) core.bus.emit('prefs.changed', { keepScreenOn: next.keepScreenOn });
      if (patch.monetization !== undefined || patch.copy !== undefined) core.bus.emit('storefront.changed', { part: 'prefs' });
      // The app-wide choice replaces any older per-project value in the open project.
      const open = core.project;
      if (open) {
        if (patch.maxConcurrentAgents !== undefined) open.updateSettings({ maxConcurrentAgents: 0 });
        if (patch.autoSave !== undefined) open.updateExtras({ autoSave: undefined });
      }
      core.orchestrator.kick();
      return next;
    },
    /** Shuriken Link: the Studio plugin's state (installed, linked DataModels of this project's place, calls so far). */
    'studio.link.status': () => core.studioLinkStatus(),
    // Who uploads go to now (roblox/upload-owner.ts), in words for Settings.
    // Where uploads go now and with which key (the project's own, the default, none), and the name its own key is saved under.
    'uploads.owner': async () => {
      const owner = await core.uploadOwner();
      const key = await core.openCloudKey();
      return { owner, line: ownerLine(owner), key: key.source, projectKey: key.projectKey };
    },
    // Who holds Studio's playtest turn now, and the user freeing it (Agents page).
    'studio.holder': () => core.studioHolder(),
    'studio.free': () => core.freeStudio('user'),
    'project.settings': () => ({ settings: p().settings(), extras: p().extras() }),
    'project.settings.update': ({ settings, extras }: { settings?: Partial<ProjectSettings>; extras?: Partial<ProjectExtras> }) => {
      const s = settings ? p().updateSettings(settings) : p().settings();
      const e = extras ? p().updateExtras(extras) : p().extras();
      if (settings && 'robloxStudioMatch' in settings) core.studio.bind(s.robloxStudioMatch);
      if (settings?.autonomy) {
        if (settings.autonomy === 'manual') core.orchestrator.pause();
        else core.orchestrator.resume();
      }
      // This project's own agent limit applies at the next scheduling pass (a lower one starts nobody new; running agents finish).
      if (settings && 'agentCap' in settings) core.orchestrator.kick();
      return { settings: s, extras: e };
    },
    'project.report': () => {
      const file = writeProjectReport(p(), core.knowledge, core.runner);
      return { file, markdown: readFileSync(file, 'utf8') };
    },
    'project.escalationRules.update': ({ rules }: { rules: Partial<EscalationRules> }) => p().updateSettings({ escalation: { ...p().settings().escalation, ...rules } }),

    // ─── Tasks & objectives ─────────────────────────────────────────────────
    // Lists answer empty while no project is open (a window between projects asked every list at once, and each threw).
    // `slim`: what the UI's lists read (see slimTask); the task's own page reads tasks.get.
    'tasks.list': (q: { statuses?: TaskStatus[]; parentId?: string | null; slim?: boolean } = {}) => {
      if (!core.project) return [];
      const all = core.project.tasks.list(q);
      return q.slim ? all.map(slimTask) : all;
    },
    'tasks.get': ({ id }: { id: string }) => {
      const proj = p();
      const task = proj.tasks.get(id);
      if (!task) return null;
      return {
        task,
        evidence: proj.tasks.evidence(id),
        failures: proj.tasks.failures(id),
        runs: core.runner.listRuns(proj, { taskId: id }),
        children: proj.tasks.list({ parentId: id }),
        timeline: proj.audit.timeline({ taskId: id, limit: 200 }),
      };
    },
    'tasks.update': ({ id, patch }: { id: string; patch: TaskPatch }) => p().tasks.update(id, patch),
    'tasks.retry': ({ id }: { id: string }) => core.orchestrator.retry(id),
    'tasks.runNow': ({ id }: { id: string }) => core.orchestrator.runNow(id),
    'tasks.cancel': ({ id }: { id: string }) => core.orchestrator.cancel(id),
    'tasks.pause': ({ id }: { id: string }) => core.orchestrator.pauseTask(id),
    'tasks.approveProposed': ({ id }: { id: string }) => {
      const t = p().tasks.setStatus(id, 'ready', 'Approved by user', 'user');
      core.orchestrator.kick();
      return t;
    },
    'tasks.reassign': ({ id, role }: { id: string; role: string }) => p().tasks.update(id, { role }),
    'tasks.prioritize': ({ id, priority }: { id: string; priority: number }) => p().tasks.update(id, { priority }),
    'tasks.forceResearch': ({ id, question }: { id: string; question: string }) => core.orchestrator.forceResearch(id, question),
    'tasks.forceReview': ({ id }: { id: string }) => core.orchestrator.forceReview(id),
    'objectives.submit': (input: { title: string; description: string; acceptanceCriteria?: string[]; skipResearch?: boolean }) => core.orchestrator.submitObjective(input),

    // ─── Orchestrator ───────────────────────────────────────────────────────
    'orchestrator.state': () => core.orchestrator.state(),
    'orchestrator.start': () => core.orchestrator.start(),
    'orchestrator.pause': () => core.orchestrator.pause(),
    'orchestrator.resume': () => core.orchestrator.resume(),
    /** Pause now; resume after some minutes, or when the active account's 5-hour window resets. */
    'orchestrator.pauseUntil': ({ minutes, untilReset }: { minutes?: number; untilReset?: boolean }) => {
      let until: number | null = null;
      if (untilReset) {
        const reset = fiveHourReset();
        if (!reset) throw new Error("The account's reset time isn't known yet (it appears after the first agent run).");
        until = reset + 60_000;
      } else if (minutes && minutes > 0) {
        until = Date.now() + Math.round(minutes) * 60_000;
      }
      if (!until) throw new Error('Say how long to pause.');
      core.orchestrator.pauseUntil(until);
      return { until: new Date(until).toISOString() };
    },
    /** The active account's usage windows (for "pause until the limit resets" and the account menu). */
    'usage.current': () => {
      const acct = core.accounts.active('claude');
      const snap = core.usage.snapshot(core.accounts.usageKey('claude', acct));
      return { account: acct?.label ?? null, windows: snap.windows, fiveHourResetsAt: fiveHourReset(), blocked: snap.blocked, blockedUntil: snap.blockedUntil };
    },
    'orchestrator.stop': () => core.orchestrator.stop(),

    // ─── Runs, timeline, audit ──────────────────────────────────────────────
    'runs.list': (q: { taskId?: string; limit?: number } = {}) => (core.project ? core.runner.listRuns(core.project, q) : []),
    // `lean` (the Agents page, which reloads a working run every 1.5 s): no tool calls, no context, no tool results
    // and only the newest steps. A long run sent about 1.1 MB per reload, of which the page used about a fifth.
    'runs.get': ({ id, lean }: { id: string; lean?: boolean }) => {
      const proj = p();
      const run = core.runner.getRun(proj, id);
      if (!run) return null;
      const context = !lean && run.contextPath && existsSync(run.contextPath) ? readFileSync(run.contextPath, 'utf8') : null;
      const all = proj.audit.runMessages(id);
      const messages = lean ? all.filter((m) => m.kind !== 'tool_result').slice(-RUN_STEPS_SHOWN) : all;
      const toolCalls = proj.audit.toolCalls({ runId: id });
      // What the run changed and proved: files it edited, Studio-side writes, the DataModel diff Shuriken
      // measured after it, the evidence recorded against it, and its structured result.
      const evidence = run.taskId ? proj.tasks.evidence(run.taskId).filter((e) => e.runId === id) : [];
      const files = [...new Set(toolCalls.flatMap((c) => c.filesChanged ?? []))].map((f) => {
        const rel = relative(proj.root, f);
        return rel.startsWith('..') ? f : rel.replaceAll('\\', '/');
      });
      const studioWrites = toolCalls
        .filter((c) => /^(mcp__shuriken__)?(roblox_run_luau|roblox_sync_push|roblox_call|asset_reuse|asset_analyze|cloud_luau_run|roblox_playtest)$/.test(c.tool))
        .map((c) => ({ id: c.id, tool: c.tool.replace(/^mcp__shuriken__/, ''), status: c.status, startedAt: c.startedAt, args: c.args }));
      const snapshot = evidence.find((e) => e.kind === 'datamodel_snapshot');
      const result = [...all].reverse().find((m) => m.kind === 'result')?.content ?? null;
      return { run, messages, ...(lean ? { olderSteps: all.filter((m) => m.kind !== 'tool_result').length - messages.length } : { toolCalls }), context, changes: { files, studioWrites: lean ? studioWrites.slice(-60) : studioWrites, datamodel: snapshot ? snapshot.data : null }, evidence, result };
    },
    'runs.interrupt': ({ id }: { id: string }) => core.runner.interrupt(id),
    // What the build cost at API prices, Kiln and the small calls included (costs/build-cost.ts): the open project, or
    // any project folder (read-only; the open one is read through its own store).
    'costs.build': () => (core.project ? costOf(core.project.store) : null),
    'costs.forRoot': ({ root }: { root: string }) => {
      const dir = String(root ?? '');
      const open = core.project;
      return open && dir && resolve(dir).toLowerCase() === resolve(open.root).toLowerCase() ? costOf(open.store) : buildCost(dir);
    },
    'timeline.list': (q: { limit?: number; before?: string; taskId?: string; runId?: string } = {}) => (core.project ? core.project.audit.timeline(q) : []),
    'toolcalls.list': (q: { runId?: string; taskId?: string; limit?: number } = {}) => p().audit.toolCalls(q),
    'toolcalls.get': ({ id }: { id: string }) => p().audit.toolCall(id),

    // ─── Knowledge, research, skills ────────────────────────────────────────
    'knowledge.search': (q: Parameters<typeof core.knowledge.search>[0]) => core.knowledge.search(q),
    'knowledge.get': ({ id }: { id: string }) => {
      const k = core.knowledge.get(id);
      return k ? { entry: k, links: core.knowledge.links(id) } : null;
    },
    'knowledge.add': (input: Parameters<typeof core.knowledge.add>[0]) => core.knowledge.add({ ...input, createdBy: input.createdBy ?? 'user' }),
    'knowledge.update': ({ id, patch }: { id: string; patch: Parameters<typeof core.knowledge.update>[1] }) => core.knowledge.update(id, patch),
    'knowledge.validate': ({ id, validation, confidence }: { id: string; validation: string; confidence?: number }) => core.knowledge.validate(id, validation, confidence),
    'knowledge.promote': ({ id, target, validation }: { id: string; target: Parameters<typeof core.knowledge.promote>[1]; validation?: string }) => core.knowledge.promote(id, target, { validation, actor: 'user' }),
    'knowledge.stats': () => core.knowledge.stats(),
    'knowledge.facets': () => core.knowledge.facets(),
    'knowledge.promotionCandidates': () => core.knowledge.promotionCandidates(),
    'research.sessions': () => (core.project ? core.project.research.sessions() : []),
    'research.get': ({ id }: { id: string }) => {
      const proj = p();
      const s = proj.research.session(id);
      return s ? { session: s, sources: proj.research.sources(id), claims: proj.research.claims(id) } : null;
    },
    'skills.list': () => core.skills.list(),
    'skills.get': ({ name }: { name: string }) => core.skills.get(name),
    'skills.write': ({ scope, name, meta, body }: { scope: 'global' | 'project'; name: string; meta: Record<string, unknown>; body: string }) => core.skills.write(scope, name, meta, body),

    // ─── Governance ─────────────────────────────────────────────────────────
    'spec.get': () => p().governance.spec(),
    'spec.update': ({ key, body, status, title }: { key: string; body: string; status?: 'draft' | 'approved'; title?: string }) => p().governance.updateSpec(key, body, 'user', status ?? 'draft', title),
    'decisions.list': () => p().governance.decisions(),
    'decisions.setStatus': ({ id, status }: { id: string; status: 'proposed' | 'accepted' | 'rejected' | 'superseded' }) => p().governance.setDecisionStatus(id, status),
    'escalations.list': ({ status }: { status?: 'open' | 'approved' | 'rejected' | 'answered' | 'cancelled' | 'auto_resolved' } = {}) => (core.project ? core.project.governance.escalations(status) : []),
    'escalations.resolve': ({ id, status, response }: { id: string; status: 'approved' | 'rejected' | 'answered' | 'cancelled' | 'dismissed'; response?: string }) => {
      const proj = p();
      // Dismiss (the card's own button): closed without an answer; its task is left as it is.
      if (status === 'dismissed') return proj.governance.dismiss(id, response?.trim() || 'Cleared by you.', 'user') ?? proj.governance.escalation(id);
      const e = proj.governance.escalation(id);
      if (e?.kind === 'spec_change' && status === 'approved') {
        const body = e.detail.split('\n---\n')[1];
        const key = proj.governance.spec().find((s) => e.title.endsWith(s.title))?.key;
        if (body && key) proj.governance.updateSpec(key, body.trim(), 'user', 'approved');
      }
      return proj.governance.resolveEscalation(id, status, response ?? null);
    },

    // ─── Health & capabilities ──────────────────────────────────────────────
    'health.list': () => core.health.list(),
    'health.run': ({ id, deep }: { id?: string; deep?: boolean }) => (id ? core.health.run(id, deep ?? false) : core.health.runAll(deep ?? false)),
    'health.history': ({ id, limit }: { id: string; limit?: number }) => core.health.history(id, limit),
    'capabilities.list': ({ integration }: { integration?: string } = {}) => core.capabilities.list(integration),
    'usage.snapshot': () => core.providers.list().map((x) => core.usage.snapshot(x.id)),
    'usage.clearBlock': ({ providerId }: { providerId: string }) => core.usage.clearBlock(providerId),

    // ─── Code intelligence ──────────────────────────────────────────────────
    'code.index': () => {
      const proj = p();
      const index = core.indexer.build(proj.root, proj.extras().syncMap);
      return { summary: core.indexer.summary(index), files: index.files };
    },
    'code.dependents': ({ file }: { file: string }) => {
      const proj = p();
      return core.indexer.dependents(core.indexer.build(proj.root, proj.extras().syncMap), file, true);
    },
    'code.references': ({ name }: { name: string }) => {
      const proj = p();
      return core.indexer.references(proj.root, core.indexer.build(proj.root, proj.extras().syncMap), name);
    },
    'code.read': ({ file }: { file: string }) => {
      const proj = p();
      const full = join(proj.root, file);
      if (!full.startsWith(proj.root) || !existsSync(full)) throw new Error('File not found in project');
      return readFileSync(full, 'utf8');
    },

    // ─── Terminal ───────────────────────────────────────────────────────────
    // ─── AI providers ─────────────────────────────────────────────────────────
    'providers.assignments': () => ({
      ...core.providers.assignments(),
      codexFallbackEnabled: core.providers.codexFallbackEnabled(),
      codexFallbackActive: core.providers.codexFallbackEnabled() &&
        core.providers.preferredForRole('critic').id === 'claude' &&
        core.providers.forRole('critic').id === 'codex',
      providers: core.providers.list().map((provider) => ({ id: provider.id, name: provider.displayName })),
      roleOptions: Object.values(ROLES).map((role) => ({ id: role.id, name: role.name })),
    }),
    'providers.setCodexFallback': async ({ enabled }: { enabled: boolean }) => {
      if (enabled) {
        const codex = core.providers.get('codex');
        if (!codex || !(await codex.detect()).installed)
          throw new Error('Codex CLI must be installed before enabling automatic fallback.');
        if (!(await codex.auth()).authenticated)
          throw new Error('Sign in to Codex with your ChatGPT subscription before enabling automatic fallback.');
        const health = await core.health.run('provider:codex', false);
        if (health.status !== 'healthy') throw new Error('Codex is not ready: ' + health.summary);
      }
      core.providers.setCodexFallbackEnabled(enabled);
      core.orchestrator.kick();
      return { enabled: core.providers.codexFallbackEnabled() };
    },
    'providers.setAssignments': async ({ default: selected, roles }: { default: string; roles: Record<string, string> }) => {
      const usesCodex = selected === 'codex' || Object.values(roles ?? {}).includes('codex');
      if (usesCodex) {
        const codex = core.providers.get('codex');
        if (!codex || !(await codex.detect()).installed) throw new Error('Codex CLI is not installed on this PC.');
        if (!(await codex.auth()).authenticated) throw new Error('Codex CLI is not signed in with a ChatGPT subscription. Open Settings → AI accounts → Codex account and sign in with ChatGPT.');
      }
      const allowedRoles = new Set(Object.keys(ROLES));
      const filtered: Record<string, string> = {};
      for (const [role, provider] of Object.entries(roles ?? {})) {
        if (!allowedRoles.has(role)) throw new Error('Unknown agent role: ' + role);
        if (provider !== selected) filtered[role] = provider;
      }
      core.providers.setAssignments({ default: selected, roles: filtered });
      core.orchestrator.kick();
      return core.providers.assignments();
    },
    'providers.codex.status': async () => {
      const provider = core.providers.get('codex');
      if (!provider) throw new Error('Codex provider is not registered');
      const detected = await provider.detect();
      const auth = detected.installed ? await provider.auth() : null;
      return { installed: detected.installed, version: detected.version, detail: detected.detail, signedIn: !!auth?.authenticated, authDetail: auth?.detail ?? null };
    },
    'providers.codex.signIn': async ({ cols, rows }: { cols?: number; rows?: number } = {}) => {
      const provider = core.providers.get('codex');
      const cmd = await provider?.signInCommand?.('');
      if (!cmd) throw new Error('Codex CLI not found. Install @openai/codex and restart Shuriken Studio.');
      return core.terminals.create({ cwd: core.opts.dataDir, shell: cmd.command, args: cmd.args, env: cmd.env, cols, rows });
    },

    // ─── Accounts (several subscriptions of one provider) ─────────────────────
    'accounts.list': () => {
      // The added accounts plus the PC's own Claude login (a built-in account that can't be removed).
      const eligible = new Set(core.accounts.candidates('claude').map((a) => a.id));
      const accounts = [...core.accounts.list('claude'), core.accounts.pc('claude')];
      const active = core.accounts.active('claude');
      return {
        accounts: accounts.map((a) => {
          const u = core.usage.snapshot(core.accounts.usageKey('claude', a));
          return { ...a, builtin: a.id === PC_ACCOUNT_ID, eligible: eligible.has(a.id), usage: { windows: u.windows, blocked: u.blocked, blockedUntil: u.blockedUntil, runsToday: u.runsToday, costUsdToday: u.costUsdToday } };
        }),
        // With no accounts added, runs use the PC login.
        activeId: active?.id ?? PC_ACCOUNT_ID,
        // The app-wide default (Settings), and this window's own choice (the top bar's menu; null follows the default).
        defaultId: core.accounts.activeId('claude') ?? active?.id ?? PC_ACCOUNT_ID,
        windowId: core.accounts.windowId('claude'),
        policy: core.accounts.policy(),
      };
    },
    'accounts.add': ({ label }: { label: string }) => core.accounts.add('claude', label),
    'accounts.remove': ({ id }: { id: string }) => core.accounts.remove(id),
    'accounts.rename': ({ id, label }: { id: string; label: string }) => core.accounts.update(id, { label }),
    // The top bar's menu: this window only (null: back to the app-wide default). Settings sets the default.
    'accounts.setActive': ({ id }: { id: string | null }) => core.accounts.chooseForWindow('claude', id || null),
    'accounts.setDefault': ({ id }: { id: string }) => core.accounts.setActive('claude', id),
    'accounts.setPolicy': (patch: { autoSwitch?: boolean; autoResume?: boolean; usePcLogin?: boolean }) => core.accounts.setPolicy(patch),
    'accounts.signIn': async ({ id, cols, rows }: { id: string; cols?: number; rows?: number }) => {
      const acct = core.accounts.get(id);
      if (!acct) throw new Error(`Unknown account ${id}`);
      const provider = core.providers.get('claude');
      const cmd = await provider?.signInCommand?.(acct.dir);
      if (!cmd) throw new Error('Claude Code is not available to sign in with.');
      return core.terminals.create({ cwd: acct.dir || core.opts.dataDir, shell: cmd.command, args: cmd.args, env: cmd.env, cols, rows });
    },
    'accounts.refresh': async ({ id }: { id: string }) => {
      const acct = core.accounts.get(id);
      if (!acct) throw new Error(`Unknown account ${id}`);
      const provider = core.providers.get('claude');
      const a = await (provider?.authFor ? provider.authFor(acct.dir || null) : Promise.resolve(null));
      return core.accounts.update(id, { signedIn: !!a?.authenticated, email: a?.account ?? null, plan: a?.plan ?? null, checkedAt: new Date().toISOString() });
    },

    'terminal.available': () => core.terminals.available(),
    'terminal.create': ({ cols, rows, shell }: { cols?: number; rows?: number; shell?: string } = {}) => core.terminals.create({ cwd: core.project?.root ?? core.opts.dataDir, cols, rows, shell }),
    'terminal.write': ({ id, data }: { id: string; data: string }) => core.terminals.write(id, data),
    'terminal.resize': ({ id, cols, rows }: { id: string; cols: number; rows: number }) => core.terminals.resize(id, cols, rows),
    'terminal.replay': ({ id }: { id: string }) => core.terminals.replay(id),
    'terminal.list': () => core.terminals.list(),
    'terminal.kill': ({ id }: { id: string }) => core.terminals.kill(id),

    // ─── Plugins ────────────────────────────────────────────────────────────
    'plugins.list': () => core.plugins.list(),
    'plugins.setEnabled': ({ id, enabled }: { id: string; enabled: boolean }) => core.plugins.setEnabled(id, enabled),

    // ─── Tools ──────────────────────────────────────────────────────────────
    'tools.list': () => core.tools.all().map((t) => ({ name: t.name, title: t.title, description: t.description, capability: t.capability, permission: t.permission, roles: t.roles ?? null })),
    'tools.invoke': ({ name, args }: { name: string; args: unknown }) => core.invokeTool(name, args, 'ui'),

    // ─── Roblox ─────────────────────────────────────────────────────────────
    'roblox.status': async () => {
      const base = { connection: core.studio.conn.state, error: core.studio.conn.lastError, install: core.studio.installInfo, binding: core.studio.binding, tools: core.studio.conn.listTools().length };
      if (!core.studio.connected) return { ...base, studios: [], state: null };
      const studios = await core.studio.listStudios().catch(() => []);
      const state = await core.studio.state().catch(() => null);
      return { ...base, studios, state };
    },
    'roblox.connect': () => core.studio.start(),
    'roblox.tree': ({ path, datamodel }: { path: string; datamodel?: 'Edit' | 'Server' | 'Client' }) => core.studio.tree(path, datamodel),
    'roblox.detail': ({ path, datamodel }: { path: string; datamodel?: 'Edit' | 'Server' | 'Client' }) => core.studio.detail(path, datamodel),
    'roblox.console': () => core.studio.console(),
    /** Parts of the place as renderable boxes/spheres/cylinders (read-only 3D preview). */
    'roblox.scene': async ({ roots }: { roots?: string[] } = {}) => {
      const snap = (await core.studio.snapshot(roots ?? ['Workspace'], 'Edit', 8000)) as { count: number; truncated: boolean; nodes: Record<string, Record<string, unknown>> };
      const parts: Array<{ path: string; className: string; pos: number[]; size: number[]; rot: number[]; color: string; transparency: number; shape: string | null; material: string | null }> = [];
      for (const [key, sig] of Object.entries(snap.nodes)) {
        if (!Array.isArray(sig.p) || !Array.isArray(sig.s) || !Array.isArray(sig.o)) continue;
        const [path, className] = key.split('#');
        // Terrain is a BasePart whose Size is the whole voxel region; drawing it as a box hides the map.
        if ((className ?? sig.c) === 'Terrain') continue;
        parts.push({
          path: path!,
          className: className ?? String(sig.c ?? ''),
          pos: sig.p as number[],
          size: sig.s as number[],
          rot: sig.o as number[],
          color: typeof sig.col === 'string' ? sig.col : 'a3a2a5',
          transparency: typeof sig.t === 'number' ? sig.t : 0,
          shape: typeof sig.sh === 'string' ? sig.sh : null,
          material: typeof sig.m === 'string' ? sig.m : null,
        });
      }
      return { count: snap.count, truncated: snap.truncated, parts };
    },
    'roblox.screenshot': () => core.studio.screenshot(),
    'roblox.savePlace': () => core.savePlace(),
    // ─── Viewer (live replica of the place) ───────────────────────────────────
    'viewer.parts': async ({ offset, datamodel }: { offset?: number; datamodel?: 'Edit' | 'Server' } = {}) => {
      // The project's model names let the snippet match Part + SpecialMesh pieces (no attribute) to their models.
      const known = JSON.stringify(core.project ? knownViewerModels(core.project.root) : []);
      const code = LUAU_VIEW_PARTS.replace('__OFFSET__', String(Math.max(0, Math.floor(offset ?? 0)))).replace('__KNOWN__', () => known);
      const { page, source } = await viewerRead<Record<string, unknown>>(code, datamodel, true);
      return { ...page, source };
    },
    // One modeled mesh for the viewer: geometry without the GLB's images, a thumbnail of its colour map, and
    // whether its upload is legacy (the viewer turns such a mesh like Roblox does).
    'viewer.model': ({ name }: { name: string }) => viewerModelData(p().root, String(name ?? ''), join(p().dir, 'viewer-cache')),
    'viewer.terrain': async ({ minX, minZ, maxX, maxZ, n, z0, z1, datamodel }: { minX: number; minZ: number; maxX: number; maxZ: number; n?: number; z0?: number; z1?: number; datamodel?: 'Edit' | 'Server' }) => {
      const N = Math.min(192, Math.max(16, Math.floor(n ?? 128)));
      const from = Math.max(0, Math.floor(z0 ?? 0));
      // Rows per call keep the result (up to 3 voxel intervals per cell) under Studio's 100,000-character limit.
      const to = Math.min(N - 1, Math.floor(z1 ?? from + Math.floor(6000 / N) - 1));
      // Terrain is the same in Edit and in the running server, so a flip mid-read may move to the other one.
      const { page } = await viewerRead(
        LUAU_VIEW_TERRAIN.replace('__MINX__', String(Number(minX) || -256))
          .replace('__MINZ__', String(Number(minZ) || -256))
          .replace('__MAXX__', String(Number(maxX) || 256))
          .replace('__MAXZ__', String(Number(maxZ) || 256))
          .replace('__N__', String(N))
          .replace('__Z0__', String(from))
          .replace('__Z1__', String(to)),
        datamodel,
        false,
      );
      return page;
    },
    'viewer.shot': async ({ camera, lookAt }: { camera: [number, number, number]; lookAt: [number, number, number] }) => {
      // A pixel-exact Studio render from the viewer's camera; only in Edit mode and when nobody holds a playtest
      // (the team's, or one the user started in Studio: the list of DataModels says so).
      const editOnly = async () => {
        if (!core.studio.connected || core.lease.holder) return false;
        const st = await core.studio.state().catch(() => null);
        return !!st && st.availableDataModels.includes('Edit') && !st.availableDataModels.some((d) => d !== 'Edit');
      };
      if (!(await editOnly())) return null;
      const img = await core.studio.screenshot({ camera, lookAt }).catch(() => null);
      // A playtest that began while Studio drew it: the picture is of the game starting (a grey viewport), not of this view.
      if (!img || !(await editOnly())) return null;
      return `data:${img.mimeType};base64,${img.data}`;
    },
    'roblox.syncPush': ({ deleteOrphans }: { deleteOrphans?: boolean } = {}) => core.sync.push(p().root, p().extras().syncMap, { deleteOrphans }),
    'roblox.syncVerify': () => core.sync.verify(p().root, p().extras().syncMap),
    'roblox.worldBuilders': () => listWorldBuilders(p().root),
    'roblox.rebuildWorld': async ({ files }: { files?: string[] } = {}) => {
      if (core.lease.holder) throw new Error(`Studio is in a playtest owned by ${core.lease.holder.owner}; try again when it ends.`);
      const out = await core.studioLock.run(() => rebuildWorld(core.studio, p().root, files));
      core.bus.emit('roblox.changed', { reason: 'luau' });
      p().audit.event({ kind: 'world.rebuilt', severity: out.results.every((r) => r.ok) ? 'info' : 'error', title: `World rebuilt from world/: ${out.results.filter((r) => r.ok).length}/${out.results.length} builder(s) ok`, role: 'user', detail: out });
      return out;
    },
    'roblox.openSandbox': async () => {
      const proj = p();
      const file = join(proj.root, 'sandbox.rbxlx');
      if (!existsSync(file)) writeFileSync(file, sandboxPlaceXml(proj.summary.name), 'utf8');
      const inst = await core.studio.openPlace(file, 'sandbox');
      const match = inst.name.replace(/\s*\(placeId:.*$/, '');
      proj.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      return inst;
    },
    'roblox.openProjectPlace': async () => {
      const proj = p();
      const adopted = proj.extras().adopted;
      if (adopted && !proj.extras().placeFile) {
        // A game plugged in from Studio lives in Roblox (or a file only Studio knows): never swap in a sandbox.
        throw new Error(`Open "${adopted.place}" in Roblox Studio; Shuriken reconnects to it by itself.`);
      }
      let rel = proj.extras().placeFile;
      if (!rel) {
        const found = readdirSync(proj.root).find((f) => /\.rbxlx?$/i.test(f));
        if (!found) {
          rel = `${proj.summary.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'place'}.rbxlx`;
          writeFileSync(join(proj.root, rel), sandboxPlaceXml(proj.summary.name), 'utf8');
        } else rel = found;
        proj.updateExtras({ placeFile: rel });
      }
      const file = isAbsolute(rel) ? rel : join(proj.root, rel);
      const inst = await core.studio.openPlace(file, basename(file));
      const match = inst.name.replace(/\s*\(placeId:.*$/, '');
      proj.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      return inst;
    },
    'roblox.bind': ({ match }: { match: string | null }) => {
      p().updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      return match;
    },

    // ─── Git & tests ────────────────────────────────────────────────────────
    'git.status': () => p().git.status(),
    'git.log': ({ limit }: { limit?: number } = {}) => p().git.log(limit),
    'git.diff': (q: { from?: string; to?: string; stat?: boolean } = {}) => p().git.diff(q),
    'git.checkpoints': () => p().git.checkpoints(),
    'git.checkpoint': ({ label }: { label: string }) => p().git.checkpoint({ label, kind: 'manual' }),
    'git.rollback': ({ id }: { id: string }) => p().git.rollback(id, 'user'),
    // ─── Animation workshop ─────────────────────────────────────────────────
    'animations.list': () => {
      const proj = core.project;
      if (!proj) return { animations: [], broken: [], runtime: null };
      const store = new AnimationStore(proj.root);
      return { animations: store.all().map((f) => store.summary(f)), broken: store.broken(), runtime: AnimationStore.runtimeLocation(proj.extras().syncMap) };
    },
    'animations.get': ({ name }: { name: string }) => {
      const store = new AnimationStore(p().root);
      const f = store.get(name);
      if (!f) throw new Error(`No animation named ${name}`);
      if (f.clip.rig) {
        // A custom rig's clip: shown on the rigged model itself, measured on its rig.
        const body = loadRigBody(p().root, f.clip.rig);
        const parts = new ModelStore(p().root).parts(f.clip.rig).map((m) => ({ name: m.name, color: m.color, material: m.material, origin: m.origin, segment: m.segment }));
        return { ...f, summary: store.summary(f), rig: body?.rig ?? null, rigParts: parts, rigCheck: body ? checkRigClip(body, f.clip) : null };
      }
      const clip = resolveAims(f.clip);
      return { ...f, clip, summary: store.summary(f), metrics: clipMetrics(clip) };
    },
    'animations.presets': () => listPresets(),
    'animations.preset': ({ id, intensity, speed, hand, body_part }: { id: string; intensity?: number; speed?: number; hand?: 'left' | 'right'; body_part?: 'full' | 'upper' | 'lower' }) => {
      const full = buildPreset(id, id, { intensity, speed, hand });
      const clip = body_part && body_part !== 'full' ? bodyPartClip(full, body_part) : full;
      return { clip, metrics: clipMetrics(clip) };
    },
    'animations.create': async (args: { name: string; preset: string; intensity?: number; speed?: number; hand?: 'left' | 'right'; body_part?: 'full' | 'upper' | 'lower' }) =>
      toolResult(await core.invokeTool('animation_create', args, 'ui')),
    'animations.setAsset': ({ name, assetId }: { name: string; assetId: string }) => {
      const id = String(assetId).replace(/\D/g, '');
      if (!id) throw new Error('That is not an asset id');
      const f = new AnimationStore(p().root).setUpload(name, id);
      core.bus.emit('animations.changed', { name });
      // Point the place at the uploaded asset now when Studio is there (otherwise on the next build).
      if (core.studio.connected) void core.invokeTool('animation_build', {}, 'ui').catch(() => undefined);
      return { ok: true, assetId: f.upload?.assetId, note: core.studio.connected ? 'Saved and applied in Studio.' : 'Saved. Applied the next time the animations build.' };
    },
    'animations.upload': async ({ name }: { name?: string } = {}) => toolResult(await core.invokeTool('animation_upload', name ? { name } : {}, 'ui')),
    'animations.remove': async ({ name }: { name: string }) => toolResult(await core.invokeTool('animation_remove', { name }, 'ui')),
    // Add to game: a draft made in the dock goes into the game (as: the animation it replaces).
    'animations.use': async ({ name, as }: { name: string; as?: string }) => toolResult(await core.invokeTool('animation_use', as ? { name, as } : { name }, 'ui')),
    'animations.check': async ({ name }: { name: string }) => toolResult(await core.invokeTool('animation_check', { name }, 'ui')),

    // ─── Effects ─────────────────────────────────────────────────────────────
    'effects.list': () => {
      const proj = core.project;
      if (!proj) return { effects: [], presets: listEffectPresets(), broken: [] };
      const store = new EffectStore(proj.root);
      // bounds: how far it reaches (studs) for framing a preview; usedBy: the scripts that play it; broken: files that can't be used, with why.
      const usedBy = store.usage(proj.extras().syncMap);
      return {
        effects: store.all().map((f) => ({ ...f.effect, preset: f.preset ?? null, updatedAt: f.updatedAt, ...(f.draft ? { draft: true, ...(f.draftOf ? { draftOf: f.draftOf } : {}) } : {}), bounds: measureEffect(f.effect).bounds, usedBy: usedBy.get(f.effect.name) ?? [] })),
        presets: listEffectPresets(),
        broken: store.broken(),
      };
    },
    // The pictures behind texture references, for the preview: the game's own PNGs ("tex:<Name>"), look-alikes of Roblox's built-ins.
    // have: the stamps the preview holds; a picture that hasn't changed is not sent again.
    'effects.textures': ({ refs, have }: { refs: string[]; have?: Record<string, string> }) => {
      const pictures = new PreviewTextures(core.project?.root ?? null);
      return Object.fromEntries((Array.isArray(refs) ? refs : []).slice(0, 200).map((ref) => [ref, pictures.dataUrl(String(ref), have?.[String(ref)])]));
    },
    'effects.preset': ({ id, color, color2, scale, intensity }: { id: string; color?: string; color2?: string; scale?: number; intensity?: number }) => buildEffect(id, id, { color, color2, scale, intensity }),
    'effects.create': async (args: { name: string; preset: string; color?: string; color2?: string; scale?: number; intensity?: number }) => toolResult(await core.invokeTool('vfx_create', args, 'ui')),
    'effects.remove': async ({ name }: { name: string }) => toolResult(await core.invokeTool('vfx_remove', { name }, 'ui')),
    // Add to game: a draft made in the dock goes into the game (as: the effect it replaces).
    'effects.use': async ({ name, as }: { name: string; as?: string }) => toolResult(await core.invokeTool('vfx_use', as ? { name, as } : { name }, 'ui')),

    // ─── Models workshop ─────────────────────────────────────────────────────
    // Models an agent is changing right now (each in its own Blender).
    'models.building': () =>
      core.project
        ? core.modeling
            .list(core.project.root)
            .filter((w) => w.state === 'working' || w.state === 'starting')
            .map((w) => ({ name: w.name, by: w.by ?? 'Modeler', since: w.lastUsed, step: w.step }))
        : [],
    // ─── UI workshop ────────────────────────────────────────────────────────
    // The last UI read from Studio (kept, so the panel works while Studio is closed).
    'ui.get': () => (core.project ? new UiStore(core.project.root).get() : null),
    // Read it again now (the panel's button): the same read as the agents' ui_audit.
    'ui.capture': async ({ source }: { source?: 'auto' | 'edit' | 'playtest' } = {}) => {
      if (!core.studio.availability().ok) throw new Error('Roblox Studio isn’t connected, so the UI can’t be read right now (the last read stays on screen). Open this project’s place in Studio and read again.');
      const out = await core.invokeTool('ui_audit', { source: source ?? 'auto' }, 'ui');
      if (out.isError) throw new Error(out.content.map((c) => ('text' in c ? c.text : '')).join(' ').replace(/^ui_audit could not read the UI: /, ''));
      return core.project ? new UiStore(core.project.root).get() : null;
    },
    // The project's latest viewer picture, as a backdrop for UI previews.
    'project.thumbnail': () => {
      const t = core.project ? join(core.project.dir, 'thumbnail.jpg') : null;
      return t && existsSync(t) ? `data:image/jpeg;base64,${readFileSync(t).toString('base64')}` : null;
    },
    'ui.images': ({ refs }: { refs: string[] }) => {
      const proj = core.project;
      if (!proj) return {};
      // Icons and glyphs come from the project and the app (drawn here), Roblox images from their thumbnails.
      const pictures = projectImages(proj.root, core.opts.resourcesDir ?? null);
      const local = (ref: string) => {
        const img = /^(icon|glyph):/.test(ref) ? pictures(ref, 128) : null;
        return img ? `data:image/png;base64,${encodePng(img).toString('base64')}` : null;
      };
      return uiImages(new UiStore(proj.root), Array.isArray(refs) ? refs : [], local);
    },
    // UI mockups (designs in Shuriken, not in the game): the list, one whole, and the user's pick.
    'ui.mockups': () => (core.project ? new MockupStore(core.project.root).summaries() : []),
    'ui.mockup': ({ name }: { name: string }) => (core.project ? new MockupStore(core.project.root).get(String(name ?? '')) : null),
    'ui.mockup.choose': ({ name, version }: { name: string; version: string | null }) => {
      const m = core.project ? new MockupStore(core.project.root).choose(String(name ?? ''), version ? String(version) : null) : null;
      if (m) core.bus.emit('ui.mockups', { name: m.name });
      return m;
    },
    // Retire versions (kept, hidden on the page) or bring them back.
    'ui.mockup.retire': ({ name, versions, retired }: { name: string; versions: string[]; retired: boolean }) => {
      if (!core.project) return null;
      const r = new MockupStore(core.project.root).retire(String(name ?? ''), Array.isArray(versions) ? versions.map(String) : [], retired !== false);
      if (!r.mockup) throw new Error(r.errors.join('; '));
      core.bus.emit('ui.mockups', { name: r.mockup.name });
      return r.mockup;
    },
    'models.list': () => {
      const proj = core.project;
      if (!proj) return { models: [] };
      return { models: new ModelStore(proj.root).all().map((m) => ({ ...m, assetId: ModelStore.assetId(m) })) };
    },
    // Kiln's "Use in this game" (kilnHost.useModel): a Kiln project into this project as a Roblox model.
    'models.fromKiln': async ({ kilnProjectId, name }: { kilnProjectId: string; name: string }) => {
      if (!core.modeling.importFromKiln) return { ok: false, error: 'Modeling in Kiln is not available in this setup' };
      const r = await core.modeling.importFromKiln(p().root, String(kilnProjectId ?? ''), String(name ?? ''));
      if (r.ok) core.bus.emit('assets.changed', {});
      return r;
    },
    // The Kiln project a model is (or was) built in, for the Models page's Watch in Kiln.
    'models.kilnProject': ({ name }: { name: string }) => {
      try {
        const link = JSON.parse(readFileSync(join(p().root, '.shuriken', 'kiln', `${String(name).replace(/[^A-Za-z0-9_]/g, '')}.json`), 'utf8')) as { projectId?: string };
        return link.projectId ?? null;
      } catch {
        return null;
      }
    },
    // The user deletes models from the Models page (parts, or a multi-part model by its name).
    'models.remove': ({ names }: { names: string[] }) => {
      const out = new ModelStore(p().root).removeMany(Array.isArray(names) ? names.map(String) : []);
      if (out.removed.length) core.bus.emit('assets.changed', {});
      return out;
    },
    // Blender for modeling: found or not, and how many models can be worked on at once.
    'models.env': () => core.modeling.status(),
    // Kiln builds waiting and running (Shuriken's queue), the latest finished ones, and how many run at once.
    'kiln.builds': () => {
      const m = core.modeling as { builds?: { status(): unknown; list(root?: string): unknown[] } };
      return m.builds ? { status: m.builds.status(), builds: m.builds.list(core.project?.root).slice(0, 40) } : { status: null, builds: [] };
    },
    // The models being worked on right now, each in its own Blender.
    'models.workspaces': () => (core.project ? core.modeling.list(core.project.root) : []),
    'models.get': ({ name }: { name: string }) => {
      const store = new ModelStore(p().root);
      const m = store.get(name);
      if (!m) throw new Error(`No model named ${name}`);
      return { ...m, assetId: ModelStore.assetId(m), code: store.code(name), blendPath: m.blend ? join(p().root, m.blend) : null };
    },
    'models.glb': ({ name }: { name: string }) => {
      const f = new ModelStore(p().root).paths(name).glb;
      if (!existsSync(f)) throw new Error(`${name} has not been built`);
      return `data:model/gltf-binary;base64,${readFileSync(f).toString('base64')}`;
    },
    'models.place': async (args: { name: string; position: [number, number, number]; temporary?: boolean }) => toolResult(await core.invokeTool('model_place', args, 'ui')),
    // Send to Studio: a model where Studio's camera looks, an animation on its creature or a stand-in.
    'models.sendToStudio': ({ name }: { name: string }) => core.send.model(String(name ?? '')),
    'animations.sendToStudio': ({ name }: { name: string }) => core.send.animation(String(name ?? '')),
    'effects.play': async ({ name }: { name: string }) => {
      if (!core.studio.availability().ok) throw new Error('Roblox Studio isn’t connected: open the place in Studio, then play it again.');
      return toolResult(await core.invokeTool('vfx_play', { name, position: await core.send.target() }, 'ui'));
    },
    // Kiln's "Send to Studio" (kilnHost.sendToStudio): a Kiln project's model (or clip) into this game and Studio.
    // Kiln's "Send to Studio": the Kiln project comes in as a model (parts, rig, clips as project
    // animations), then the model is placed, or the clip plays on the model's rig, in the open place.
    'kiln.sendToStudio': async ({ kind, kilnProjectId, name, clip }: { kind: 'model' | 'animation'; kilnProjectId: string; name: string; clip?: string }) => {
      if (!core.modeling.importFromKiln) return { ok: false, error: 'Kiln isn’t available in this setup' };
      const imported = await core.modeling.importFromKiln(p().root, String(kilnProjectId ?? ''), String(name ?? ''));
      if (!imported.ok) return imported;
      core.bus.emit('assets.changed', {});
      const model = imported.name ?? String(name);
      if (kind !== 'animation') return core.send.model(model);
      core.bus.emit('animations.changed', {});
      const file = readKilnClips(p().root, model);
      if (!file?.clips.length) return { ok: false, error: `${model} has no clips yet: animate it in Kiln first.` };
      const wanted = clip ? file.clips.find((c) => c.name === clip) : file.clips[0];
      if (!wanted) return { ok: false, error: `Kiln's ${model} has no clip named ${clip} (it has ${file.clips.map((c) => c.name).join(', ')}).` };
      const anim = kilnClipName(model, wanted.name, file.kind);
      const bad = imported.clips?.problems.find((x) => x.name === anim);
      if (bad) return { ok: false, error: `${anim} can't be used: ${bad.problems.join('; ')}` };
      return core.send.animation(anim);
    },

    // ─── Audio workshop ──────────────────────────────────────────────────────
    /** The Storefront (storefront/storefront.ts): the store, the copy and the pictures, with what a push would send. */
    'storefront.get': () => {
      const prefs = { monetization: core.prefs.get().monetization !== false, copy: core.prefs.get().copy !== false };
      const proj = core.project;
      if (!proj) return { prefs, catalog: null, copy: null, art: null, pending: [] };
      const sf = new Storefront(proj.root);
      const catalog = sf.catalog();
      return {
        prefs,
        catalog: { ...catalog, items: catalog.items.map((i) => ({ ...i, status: itemStatus(i), hash: itemHash(i) })) },
        copy: sf.copy(),
        art: readArt(proj.root),
        pending: core.storePush.pending(proj),
        module: Storefront.moduleLocation(proj.extras().syncMap).file,
        behind: catalog.items.length > 0 && sf.moduleBehind(proj.extras().syncMap),
        limits: STORE_LIMITS,
      };
    },
    /** A Storefront picture as a data URL ("thumbs/A.png", "icons/x.png", "items/VIP.png", "shots/x.png"). */
    'storefront.image': ({ file }: { file: string }) => {
      const proj = p();
      if (!/^(?:thumbs|icons|items|shots|subjects)\/[A-Za-z0-9_.-]+\.png$/.test(file)) throw new Error('Not a Storefront picture');
      const f = join(new Storefront(proj.root).artDir(), file);
      return existsSync(f) ? `data:image/png;base64,${readFileSync(f).toString('base64')}` : null;
    },
    /** The file on disk of a Storefront picture (the page saves it where the user chooses). */
    'storefront.path': ({ file }: { file: string }) => {
      const proj = p();
      if (!/^(?:thumbs|icons|items)\/[A-Za-z0-9_.-]+\.png$/.test(file)) throw new Error('Not a Storefront picture');
      return join(new Storefront(proj.root).artDir(), file);
    },
    /** The user picks another thumbnail than the judge did. */
    'storefront.pick': ({ name }: { name: string }) => {
      const proj = p();
      const art = readArt(proj.root);
      if (!art.thumbs.some((t) => t.name === name)) throw new Error(`No thumbnail ${name}`);
      art.pick = { ...(art.pick ?? { rounds: [], why: '', among: art.thumbs.map((t) => t.name) }), winner: name, at: nowIso(), byUser: true, why: art.pick?.why ?? '' };
      writeArt(proj.root, art);
      core.bus.emit('storefront.changed', { part: 'art' });
      return art.pick;
    },
    /** The user's own changes to an item (shown name, description, price) or to the copy. */
    'storefront.edit': ({ key, item, copy }: { key?: string; item?: { name?: string; description?: string; price?: number }; copy?: { title?: string; description?: string } }) => {
      const proj = p();
      const sf = new Storefront(proj.root);
      if (key && item) {
        const c = sf.catalog();
        const it = c.items.find((x) => x.key === key);
        if (!it) throw new Error(`No item ${key}`);
        if (item.name !== undefined) it.name = item.name.trim();
        if (item.description !== undefined) it.description = item.description.trim();
        if (item.price !== undefined) it.price = Math.round(Number(item.price));
        const check = checkCatalog(c);
        if (check.errors.length) throw new Error(check.errors.join('; '));
        // The user's own edit of an item goes into the game for that item (not a copilot's drafts on others).
        sf.saveCatalog(c, proj.extras().syncMap, { apply: [key] });
      }
      if (copy) {
        for (const f of ['title', 'description'] as const) {
          if (copy[f] === undefined) continue;
          const check = checkCopy(f, copy[f]!);
          if (check.errors.length) throw new Error(check.errors.join('; '));
        }
        sf.saveCopy(copy, 'user');
      }
      core.bus.emit('storefront.changed', { part: key ? 'catalog' : 'copy' });
      return true;
    },
    /** Puts the store on Roblox: the user's button (storefront/store-push.ts). */
    // The page sends what the user confirmed, each item with its hash: one changed since is not pushed unseen.
    'storefront.push': ({ confirmed }: { confirmed?: Array<{ key: string; hash: string }> } = {}) => core.storePush.push(p(), { confirmed: Array.isArray(confirmed) ? confirmed : [], by: 'button' }),
    /** The store as designed into the game (its ShurikenStore module written and synced), not onto Roblox: the page's button. */
    'storefront.apply': () => core.storePush.apply(p()),
    'audio.list': async () => {
      const proj = core.project;
      const presets = Object.keys(SFX_PRESETS);
      const styles = ['lofi', 'chiptune', 'epic', 'ambient', 'action', 'japanese', 'tropical', 'spooky', 'phonk'];
      const uploads = { key: await core.assetUploads.configured(), ...core.uploadsNow() };
      if (!proj) return { sounds: [], presets, styles, uploads, runtime: null };
      const assets = new AssetService(proj.store);
      const lib = new SoundLibrary(proj.root);
      const use = lib.usage(proj.extras().syncMap);
      const sounds = lib.all().map((s) => {
        const meta = s.asset ? assets.get(s.asset)?.metadata : undefined;
        return { ...s, playedBy: use.get(s.name) ?? [], peaks: Array.isArray(meta?.peaks) ? (meta!.peaks as number[]) : null };
      });
      return { sounds, presets, styles, uploads, runtime: SoundLibrary.runtimeLocation(proj.extras().syncMap) };
    },
    'audio.data': ({ name, variation }: { name: string; variation?: number }) => {
      const proj = p();
      const s = new SoundLibrary(proj.root).get(name);
      const rel = variation ? s?.variations?.[variation - 1]?.file : s?.file;
      if (!rel) throw new Error('This sound has no local file (it comes from the Creator Store).');
      const abs = join(proj.root, rel);
      if (!existsSync(abs)) throw new Error(`${rel} is missing`);
      const ext = rel.toLowerCase().split('.').pop();
      const mime = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : ext === 'flac' ? 'audio/flac' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
      return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
    },
    'audio.upload': async ({ name }: { name?: string } = {}) => toolResult(await core.invokeTool('audio_upload', name ? { name } : {}, 'ui')),
    'audio.remove': async ({ name }: { name: string }) => toolResult(await core.invokeTool('audio_remove', { name }, 'ui')),
    'audio.use': async ({ name, as }: { name: string; as?: string }) => toolResult(await core.invokeTool('audio_use', as ? { name, as } : { name }, 'ui')),
    // The sample library and song scores (the Audio page may list samples, play one, show and edit a score).
    'audio.samples': async (args: { query?: string; kind?: string; role?: string } = {}) => toolResult(await core.invokeTool('audio_samples', args, 'ui')),
    'audio.sampleFile': ({ id }: { id: string }) => {
      const wav = new SampleLibrary(join(core.opts.dataDir, 'samples'), core.project?.root ?? null).wav(id);
      if (!wav) throw new Error(`No sample ${id}`);
      return `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`;
    },
    'audio.score': async (args: { name: string; tracks?: Array<number | string>; bars?: [number, number] }) => toolResult(await core.invokeTool('audio_score', args, 'ui')),
    'audio.edit': async (args: { name: string; ops: unknown[]; as?: string }) => toolResult(await core.invokeTool('audio_music_edit', args, 'ui')),

    'assets.list': ({ query, kind }: { query?: string; kind?: string } = {}) => (core.project ? new AssetService(core.project.store).list(query, kind) : []),
    'assets.get': ({ id }: { id: string }) => {
      const svc = new AssetService(p().store);
      const a = svc.get(id);
      if (!a) throw new Error(`Unknown asset ${id}`);
      return { ...a, history: svc.history(id) };
    },
    'assets.analyze': async ({ id }: { id: string }) => {
      const svc = new AssetService(p().store);
      const a = svc.get(id);
      if (!a) throw new Error(`Unknown asset ${id}`);
      const capture = new AssetCapture(core.studio);
      const path = (await capture.usage(svc, a))[0] ?? a.instancePaths[0];
      if (!path) throw new Error('This asset has no known placement in the open place.');
      const out = svc.setAnalysis(id, await capture.analyze(path), 'user');
      core.bus.emit('assets.changed', { id });
      return out;
    },
    'assets.usage': async ({ id }: { id: string }) => {
      const svc = new AssetService(p().store);
      const a = svc.get(id);
      if (!a) throw new Error(`Unknown asset ${id}`);
      const paths = await new AssetCapture(core.studio).usage(svc, a);
      core.bus.emit('assets.changed', { id });
      return { paths };
    },
    'tests.list': () => (core.project ? new TestService(core.project.store).list() : []),
    'tests.results': ({ id }: { id: string }) => new TestService(p().store).results(id),
    'tests.setEnabled': ({ id, enabled }: { id: string; enabled: boolean }) => new TestService(p().store).setEnabled(id, enabled),
    'tests.runRegression': () => core.verifier.regression(p(), null),
    // The user's reference footage and pictures (core/references/, the References page).
    ...referenceRpc(() => core.references, () => core.project),
    // The UI page's Forge: art directions, screen templates, previews drawn by the CPU engine, mockups from them (core/ui/forge/forge-rpc.ts).
    ...forgeRpc({ dataDir: core.opts.dataDir, resourcesDir: core.opts.resourcesDir ?? null, appVersion: core.opts.appVersion, project: () => core.project, mockupsChanged: (name) => core.bus.emit('ui.mockups', { name }), forgeGpu: core.opts.forgeGpu }),
    // Forge art on the GPU: plans for a page's own GPU forge, and a preview through the app's GPU path (core/ui/forge/forge-gpu-rpc.ts).
    ...forgeGpuRpc({ resourcesDir: core.opts.resourcesDir ?? null, forgeGpu: core.opts.forgeGpu }),
  };
}
