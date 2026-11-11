import type { AgentRun, TimelineEvent } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { roleLabel } from '../agents/roles';
import { estimateLine, estimateRemaining } from './eta';

/** One agent tool call in plain words ("editing Combat.luau", "playtesting"). */
export function describeCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const name = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  const file = typeof a.file_path === 'string' ? a.file_path.split(/[\\/]/).pop() : null;
  switch (name) {
    case 'Write':
      return file ? `writing ${file}` : 'writing a file';
    case 'Edit':
    case 'MultiEdit':
      return file ? `editing ${file}` : 'editing a file';
    case 'Read':
      return file ? `reading ${file}` : 'reading a file';
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'looking through the code';
    case 'Bash':
    case 'PowerShell':
      return 'running a command';
    case 'BashOutput':
      return "checking a command's output";
    case 'KillShell':
      return 'stopping a command';
    case 'roblox_run_luau':
      return 'running code in Studio';
    case 'roblox_playtest':
      return a.action === 'stop' ? 'stopping a playtest' : 'playtesting';
    case 'roblox_input':
      return a.device === 'mouse' ? 'clicking in a playtest' : 'pressing keys in a playtest';
    case 'roblox_screenshot':
      return 'taking a screenshot';
    case 'roblox_sync_push':
      return 'syncing code into Studio';
    case 'roblox_console':
      return 'reading Studio output';
    case 'roblox_explore':
    case 'roblox_inspect':
    case 'roblox_search':
      return 'inspecting the place';
    case 'store_search':
      return 'searching the Creator Store';
    case 'roblox_call':
      return a.tool === 'insert_asset' ? 'inserting a Creator Store asset' : a.tool === 'search_asset' ? 'searching the Creator Store' : `using Studio (${String(a.tool ?? 'tool')})`;
    case 'animation_create':
      return `animating ${typeof a.name === 'string' ? a.name : typeof a.preset === 'string' ? a.preset : 'a move'}`;
    case 'animation_check':
      return 'checking an animation on a rig';
    case 'animation_build':
      return 'building the animations into Studio';
    case 'animation_import':
      return `bringing in the game's own animation${typeof a.name === 'string' ? ` as ${a.name}` : ''}`;
    case 'kiln_clip':
      return `${typeof a.action === 'string' ? a.action : 'working on'} ${typeof a.model === 'string' ? `${a.model}'s ` : ''}${typeof a.clip === 'string' ? a.clip : 'clip'} with Kiln's animation`;
    case 'kiln_request': {
      const what = typeof a.family === 'string' ? a.family : typeof a.model === 'string' ? a.model : '';
      if (a.turn) return "waiting for Kiln's copilot";
      if (a.mode === 'interject') return `sending a correction into Kiln's build${what ? ` of ${what}` : ''}`;
      return `${a.wait === false ? 'queueing a Kiln build' : "briefing Kiln's copilot"}${what ? ` ${a.wait === false ? 'of' : 'on'} ${what}` : ''}`;
    }
    case 'kiln_builds':
      return a.wait === false ? 'checking on the Kiln builds' : 'waiting for the Kiln builds';
    case 'kiln_import':
      return `bringing ${typeof a.model === 'string' ? a.model : 'a model'} in from Kiln`;
    case 'kiln_layout_import':
      return `${a.check_only ? 'checking' : 'bringing'} ${typeof a.model === 'string' ? `the map ${a.model}` : 'a map'} ${a.check_only ? 'with Kiln' : 'in from Kiln'}`;
    case 'vfx_create':
      return `making the ${typeof a.name === 'string' ? a.name : typeof a.preset === 'string' ? a.preset : ''} effect`.replace('the  effect', 'an effect');
    case 'vfx_play':
      return 'previewing an effect in Studio';
    case 'vfx_texture':
      return `making the ${typeof a.name === 'string' ? `${a.name} ` : ''}effect texture`;
    case 'vfx_measure':
      return 'measuring an effect';
    case 'vfx_cutscene':
      return a.action === 'remove' ? 'removing a cutscene' : a.cutscene ? `staging the ${typeof a.name === 'string' ? `${a.name} ` : ''}cutscene` : "checking a cutscene's camera";
    case 'vfx_runtime':
      return 'putting the effects runtime in the game';
    case 'audio_sfx':
      return `making the ${typeof a.name === 'string' ? a.name : ''} sound`.replace('the  sound', 'a sound');
    case 'audio_ambience':
      return `making the ${typeof a.name === 'string' ? a.name : ''} ambience`.replace('the  ambience', 'an ambience bed');
    case 'audio_stinger':
      return `composing a ${typeof a.mood === 'string' ? `${a.mood} ` : ''}stinger`;
    case 'audio_music':
      return `composing ${typeof a.style === 'string' ? `${a.style} ` : ''}music`;
    case 'audio_music_edit':
      return `editing ${typeof a.name === 'string' ? `the ${a.name} song` : 'a song'}`;
    case 'audio_sample_find':
      return 'looking for samples';
    case 'audio_sample_add':
      return a.sample ? 'correcting a sample' : 'adding a sample';
    case 'audio_add':
      return 'adding a Creator Store sound';
    case 'audio_find':
      return 'looking for an existing track or sound';
    case 'audio_import':
      return 'importing a licensed track';
    case 'audio_upload':
      return 'uploading sounds to Roblox';
    case 'workspace_read_file': return 'reading a project file';
    case 'workspace_search': return 'searching project files';
    case 'workspace_write_file': return 'writing a project file';
    case 'workspace_exec': return 'running a sandboxed project command';
    case 'blender_create_box':
    case 'blender_python':
      return `modeling ${typeof a.model === 'string' ? a.model : 'a prop'} in Blender${typeof a.step === 'string' && a.step ? ` (${a.step})` : ''}`;
    case 'blender_render':
    case 'model_view':
      return `looking at ${typeof a.model === 'string' ? a.model : typeof a.name === 'string' ? a.name : 'a model'}`;
    case 'model_place':
      return 'placing a 3D model';
    case 'geometry_apply':
      return 'building geometry';
    case 'world_rebuild':
      return 'rebuilding the world';
    case 'luau_check':
      return 'checking code for errors';
    case 'test_register':
      return 'adding a test';
    case 'task_add_evidence':
      return 'recording proof';
    case 'plan_add_task':
      return 'adding a task to the plan';
    case 'planner_notes':
      return 'keeping its planning notes';
    case 'plan_cancel_task':
    case 'plan_drop_dependency':
    case 'plan_set_files':
      return 'adjusting the plan';
    case 'knowledge_search':
    case 'knowledge_get':
    case 'skill_get':
    case 'skill_list':
      return 'looking up how to do it';
    case 'WebSearch':
    case 'WebFetch':
      return 'researching online';
    case 'StructuredOutput':
      return 'writing up the result';
    // Reading and bookkeeping tools.
    case 'project_overview':
      return 'reviewing the project';
    case 'task_get':
      return 'reading the task';
    case 'task_list':
      return 'reviewing the tasks';
    case 'task_update_verification':
      return "changing a task's checks";
    case 'task_run_checks':
      return "running its task's checks";
    case 'task_fix_probe':
      return "correcting a check's probe";
    case 'test_list':
      return 'looking at the saved tests';
    case 'test_retire':
      return 'retiring an outdated test';
    case 'spec_get':
      return 'reading the spec';
    case 'spec_propose':
      return 'proposing a spec change';
    case 'decision_record':
      return 'recording a decision';
    case 'knowledge_propose':
      return 'noting what works';
    case 'research_add_source':
      return 'recording a research source';
    case 'research_add_claim':
      return 'recording a research finding';
    case 'capabilities_query':
      return 'checking what the tools can do';
    case 'evidence_view':
    case 'evidence_search':
      return 'looking at recorded proof';
    case 'test_results':
      return 'reading the test results';
    case 'decided_list':
      return 'reviewing what was decided without asking';
    case 'studio_place':
      return 'checking which place Studio has open';
    case 'ui_snapshot':
      return 'reading the last UI audit';
    case 'escalate':
      return 'asking for a decision';
    case 'git_diff':
      return 'reviewing changes';
    case 'code_query':
      return 'studying the code';
    case 'probe_submit':
      return 'running a self-check';
    case 'external_tools':
      return 'looking up plugin tools';
    case 'external_call':
      return 'using a plugin tool';
    case 'wait_for':
      return a.what === 'upload' ? 'waiting for uploads to Roblox' : a.what === 'kiln_turn' ? "waiting for Kiln's copilot" : a.what === 'studio_edit' ? 'waiting for Studio to be free' : 'waiting';
    // Studio and the world.
    case 'roblox_status':
      return 'checking the Studio connection';
    case 'roblox_snapshot':
      return 'capturing the world state';
    case 'roblox_perf':
      return 'measuring performance';
    case 'cloud_luau_run':
      return 'running code in the cloud';
    case 'geometry_read':
      return 'reading a model';
    case 'map_preview':
      return 'looking at the map';
    case 'map_audit':
      return 'checking how finished the map looks';
    case 'texture_status':
      return "checking whether Roblox approved the textures";
    case 'look_analyze':
      return 'measuring how a screenshot looks';
    case 'lighting_set':
      return typeof a.preset === 'string' ? `setting the lighting (${a.preset.replace(/_/g, ' ')})` : 'adjusting the lighting';
    case 'ui_audit':
      return 'checking the game UI';
    case 'ui_icon':
      return a.search ? 'looking for a glyph' : a.shapes ? 'drawing panel shapes' : a.list ? 'looking at the UI icons' : `drawing ${Array.isArray(a.icons) ? `${a.icons.length} UI icon${a.icons.length === 1 ? '' : 's'}` : 'UI icons'}`;
    case 'ui_mockup_create':
      return `mocking up ${typeof a.title === 'string' && a.title.trim() ? `the ${a.title.trim()}` : 'a screen'}`;
    case 'ui_mockup_update':
      return a.applied ? 'recording the mockup that went into the game' : a.revise ? 'fixing a mockup version' : a.versions ? 'revising a mockup' : 'updating a mockup';
    case 'ui_mockup_render':
      return 'looking at a mockup';
    case 'ui_lab_check':
      return 'checking the UI on 14 devices';
    case 'ui_lab_review':
      return 'having the UI reviewed on phones';
    case 'ui_lab_view':
      return 'looking at the UI on a device';
    case 'ui_lab_motion':
      return 'playing the UI motion';
    case 'ui_lab_build':
      return 'building the UI into the game';
    case 'ui_forge':
      return a.action === 'sheet' ? 'looking at an art direction' : a.action === 'element' ? 'forging UI art' : a.action === 'custom' ? 'forging custom UI art' : a.action === 'templates' ? 'looking at screen templates' : 'looking at the art directions';
    case 'match_setup':
      return Array.isArray(a.modes) && a.modes.length ? `setting up the lobby, queue and matches (${a.modes.length} mode${a.modes.length === 1 ? '' : 's'})` : 'setting up the lobby, queue and matches';
    case 'match_get':
      return 'reading the match setup';
    case 'store_catalog':
      return Array.isArray(a.set) && a.set.length ? `designing the store (${a.set.length} item${a.set.length === 1 ? '' : 's'})` : 'designing the store';
    case 'store_module':
      return 'putting the store in the game';
    case 'store_list':
      return 'looking at the Storefront';
    case 'copy_write':
      return a.title || a.description ? "writing the game's title and description" : "writing the store's texts";
    case 'copy_get':
      return "reading the game's copy";
    case 'thumb_shot':
      return 'staging a thumbnail shot in Studio';
    case 'thumb_compose':
      return a.size === 'icon' ? "composing the game's icon" : 'composing a thumbnail';
    case 'thumb_pick':
      return 'judging the thumbnails';
    case 'store_icons':
      return "drawing the store's icons";
    case 'ui_reference':
      return 'reading a reference picture';
    // The user's reference footage and pictures (references/).
    case 'reference_list':
      return "looking at the user's references";
    case 'reference_view':
      return a.detail ? 'looking closely at a moment of a reference clip' : a.part === 'sound' ? "reading a reference clip's sound" : 'looking at a reference';
    case 'ui_mockup_list':
      return 'looking at the UI mockups';
    case 'ui_mockup_audit':
      return a.compare ? 'comparing the game UI with its mockup' : 'checking a mockup on every device';
    // The asset library.
    case 'asset_search':
      return 'checking the asset library';
    case 'asset_get':
      return 'looking up an asset';
    case 'asset_analyze':
      return 'analyzing an asset';
    case 'asset_reuse':
      return 'placing an asset';
    case 'asset_usage':
      return 'finding where an asset is used';
    // Workshops: animation, effects, sounds, models, Kiln.
    case 'animation_list':
      return 'checking the animations';
    case 'animation_presets':
      return 'looking at animation presets';
    case 'animation_view':
      return 'looking at an animation';
    case 'animation_upload':
      return 'uploading animations to Roblox';
    case 'animation_use':
      return 'adding a draft animation to the game';
    case 'animation_remove':
      return 'removing an animation';
    case 'vfx_list':
      return 'checking the effects';
    case 'vfx_presets':
      return 'looking at effect presets';
    case 'vfx_build':
      return 'building the effects into Studio';
    case 'vfx_use':
      return 'adding a draft effect to the game';
    case 'vfx_remove':
      return 'removing an effect';
    case 'audio_list':
      return 'checking the sounds';
    case 'audio_score':
      return 'reading a song score';
    case 'audio_samples':
      return 'checking the samples';
    case 'audio_use':
      return 'adding a draft sound to the game';
    case 'audio_remove':
      return 'removing a sound';
    case 'blender_scene':
      return 'reading the model';
    case 'blender_check':
      return 'checking the model';
    case 'blender_undo':
      return 'undoing a model change';
    case 'model_list':
      return 'checking the 3D models';
    case 'model_remove':
      return 'removing a model';
    case 'model_gear':
      return 'turning a model into gear';
    case 'rig_build':
      return 'building a rig in Studio';
    case 'kiln_status':
      return 'checking on Kiln';
    case 'kiln_clips':
      return "checking Kiln's animation clips";
    default:
      return name.replace(/_/g, ' ');
  }
}

const ago = (iso: string, now: number) => {
  const m = Math.round((now - Date.parse(iso)) / 60000);
  return m <= 0 ? 'just now' : m === 1 ? '1 min ago' : `${m} min ago`;
};

/** Timeline events worth telling the user about (not every internal state change). */
function interesting(e: TimelineEvent): boolean {
  if (e.kind === 'task.status') return /→ (running|done|failed|escalated|cancelled)$/.test(e.title) && !/: (verified|reviewing) → done$/.test(e.title);
  return ['run.finished', 'plan.amend', 'place.saved', 'playtest.timeout', 'recovery', 'provider.environment', 'world.rebuilt', 'account.switched', 'limit.wait', 'critic.failed', 'regression.failed'].includes(e.kind);
}

/**
 * What is going on right now, for the director: each working agent's latest actions, the last
 * minutes of activity, and timing numbers for estimates. Compact on purpose (it goes into every reply).
 */
export function activitySummary(p: ProjectContext, runs: AgentRun[], parallel: { now: number; auto: boolean; why?: string }, now = Date.now()): string[] {
  const lines: string[] = [];
  const running = runs.filter((r) => r.status === 'running' || r.status === 'starting');
  if (running.length) {
    lines.push('', `Working right now (${running.length}):`);
    for (const r of running) {
      const task = r.taskId ? p.tasks.get(r.taskId) : null;
      const calls = p.audit.toolCalls({ runId: r.id, limit: 4 });
      const mins = Math.max(0, Math.round((now - Date.parse(r.startedAt)) / 60000));
      const doing = calls.length ? calls.map((c) => describeCall(c.tool, c.args)).join(' ← ') : 'starting up';
      lines.push(`- ${roleLabel(r.role)} on "${task?.title ?? 'a task'}" for ${mins} min; latest: ${doing}`);
    }
  }
  const since = now - 20 * 60_000;
  const events = p.audit
    .timeline({ limit: 150 })
    .filter((e) => Date.parse(e.ts) >= since && interesting(e))
    .reverse();
  if (events.length) {
    lines.push('', 'Last 20 minutes (oldest first):');
    for (const e of events.slice(-24)) lines.push(`- ${ago(e.ts, now)}: ${e.title.slice(0, 160)}`);
  }
  // Timing: finished work items and how long they took, so estimates rest on this project's own pace.
  const all = p.tasks.list({});
  const work = all.filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && t.kind !== 'research');
  const done = work.filter((t) => t.status === 'done' && t.startedAt && t.completedAt);
  const left = work.filter((t) => !['done', 'cancelled', 'proposed'].includes(t.status));
  const avg = done.length ? done.reduce((s, t) => s + (Date.parse(t.completedAt!) - Date.parse(t.startedAt!)), 0) / done.length / 60000 : null;
  lines.push(
    '',
    `Pace: ${done.length} tasks finished${avg != null ? ` (about ${Math.round(avg)} min each, including checks)` : ''}; ${left.length} left (${left.filter((t) => t.status === 'running' || t.status === 'verifying' || t.status === 'reviewing').length} in progress); ${parallel.auto ? `agents at once: ${parallel.now} right now, chosen automatically (3–20) from the ready work, the room in the usage windows and the queue for Studio${parallel.why ? ` (${parallel.why})` : ''}, so new independent tasks usually start straight away` : `up to ${parallel.now} agents work at once (fixed in Settings), so new tasks wait for a free agent`}. A "minimum viable game" is roughly the current goal's remaining tasks.`,
  );
  // The finish estimate comes from the longest chain of remaining tasks (more agents don't shorten a chain).
  const eta = estimateRemaining(all, now, parallel.now);
  if (eta) lines.push(estimateLine(eta));
  return lines;
}
