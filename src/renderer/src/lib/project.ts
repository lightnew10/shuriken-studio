import type { OrchestratorState } from '@shared/events';
import { useEffect, useRef, useState } from 'react';
import type { AgentRun, ProjectSummary, Task } from '@shared/domain';
import { useCoreEvent, useRpc } from './rpc';

export type { OrchestratorState } from '@shared/events';

export function useCurrentProject() {
  return useRpc<ProjectSummary | null>('project.current', undefined, ['project.changed']);
}

export function useTasks(enabled = true) {
  // The lists read titles, states and a few lines (slimTask in core/tasks/slim.ts); a task's page reads tasks.get.
  return useRpc<Task[]>(enabled ? 'tasks.list' : null, { slim: true }, ['task.updated', 'task.deleted']);
}

export function useRuns(limit = 60, enabled = true) {
  return useRpc<AgentRun[]>(enabled ? 'runs.list' : null, { limit }, ['run.updated']);
}

/**
 * The orchestrator's state: read once, then taken from its events, which carry the whole state (asking the core
 * again on every event, from five mounted views, was most of the RPC traffic while agents worked).
 */
export function useOrchestrator(enabled = true) {
  const first = useRpc<OrchestratorState>(enabled ? 'orchestrator.state' : null);
  const [live, setLive] = useState<OrchestratorState | undefined>();
  useCoreEvent(['orchestrator.state', 'project.changed'], (c, p) => {
    if (!enabled) return;
    setLive(c === 'orchestrator.state' ? (p as OrchestratorState) : undefined);
  });
  // A state from an event is the newest, unless it belongs to a project this window has since left.
  const data = live && (!first.data || live.projectId === first.data.projectId || !first.data.projectId) ? live : first.data;
  return { ...first, data };
}

/** True when any agent is working (drives every animated logo in the app). */
export function useBusy(): boolean {
  const o = useOrchestrator();
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(!!o.data && o.data.activeRuns > 0), [o.data]);
  useCoreEvent(['orchestrator.state'], (_c, p) => setBusy(((p as OrchestratorState).activeRuns ?? 0) > 0));
  return busy;
}

/** A plain-language description of what a tool call does, for people who don't read tool names. */
export function describeTool(raw: string): string {
  const [name, ...rest] = raw.trim().split(' ');
  const arg = rest.join(' ');
  const tool = (name ?? '').replace(/^mcp__[a-z_]+__/, '');
  const file = /([\w./\\-]+\.(luau|lua|json|md|py|ts))/i.exec(arg)?.[1]?.split(/[\\/]/).pop();
  const table: Record<string, string> = {
    Read: file ? `Reading ${file}` : 'Reading files',
    Write: file ? `Writing ${file}` : 'Writing a file',
    Edit: file ? `Editing ${file}` : 'Editing code',
    MultiEdit: file ? `Editing ${file}` : 'Editing code',
    Glob: 'Looking through the project',
    Grep: 'Searching the code',
    LS: 'Looking through the project',
    Bash: 'Running a command',
    PowerShell: 'Running a command',
    BashOutput: "Checking a command's output",
    KillShell: 'Stopping a command',
    WebSearch: 'Searching the web',
    WebFetch: 'Reading a web page',
    TodoWrite: 'Organizing next steps',
    roblox_run_luau: 'Running code in Studio',
    roblox_sync_push: 'Syncing code into Studio',
    roblox_playtest: 'Playtesting',
    roblox_input: 'Playing as the player',
    roblox_screenshot: 'Taking a screenshot',
    roblox_console: 'Checking Studio output',
    roblox_explore: 'Looking at the game world',
    roblox_inspect: 'Inspecting an object',
    roblox_snapshot: 'Capturing the world state',
    roblox_call: /insert_asset/.test(arg) ? 'Inserting a free asset' : /search_asset/.test(arg) ? 'Searching free assets' : 'Using Studio',
    geometry_apply: 'Building structures',
    geometry_read: 'Reading a model',
    world_rebuild: 'Rebuilding the world',
    asset_search: 'Checking the asset library',
    asset_analyze: 'Analyzing an asset',
    asset_reuse: 'Placing an asset',
    blender_python: 'Modeling in Blender',
    blender_render: 'Looking at the model',
    blender_check: 'Checking the model',
    blender_scene: 'Reading the model',
    blender_undo: 'Undoing a model change',
    model_view: 'Looking at the model',
    model_place: 'Placing a model',
    model_list: 'Checking the 3D models',
    audio_sfx: 'Designing a sound effect',
    audio_ambience: 'Designing an ambience bed',
    audio_stinger: 'Composing a stinger',
    audio_music: 'Composing music',
    audio_music_edit: 'Editing a song',
    audio_score: 'Reading a song score',
    audio_sample_find: 'Looking for samples',
    audio_sample_add: 'Adding a sample',
    audio_samples: 'Checking the samples',
    audio_add: 'Adding a sound from the Creator Store',
    audio_find: 'Looking for an existing track',
    audio_import: 'Importing a licensed track',
    audio_upload: 'Uploading sounds to Roblox',
    audio_list: 'Checking the sounds',
    animation_presets: 'Looking at animation presets',
    animation_create: 'Animating',
    animation_build: 'Building the animations into Studio',
    animation_check: 'Checking an animation on a rig',
    animation_list: 'Checking the animations',
    vfx_presets: 'Looking at effect presets',
    vfx_create: 'Creating an effect',
    vfx_play: 'Previewing an effect',
    vfx_build: 'Building the effects into Studio',
    vfx_texture: 'Making an effect texture',
    vfx_measure: 'Measuring an effect',
    vfx_cutscene: 'Staging a cutscene',
    vfx_runtime: 'Putting the effects runtime in the game',
    map_preview: 'Looking at the map',
    store_search: /Audio/.test(arg) ? 'Searching free sounds' : 'Searching the Creator Store',
    luau_check: 'Checking code quality',
    task_add_evidence: 'Recording proof',
    plan_add_task: 'Adding a task to the plan',
    planner_notes: 'Keeping its planning notes',
    plan_cancel_task: 'Adjusting the plan',
    plan_drop_dependency: 'Adjusting the plan',
    plan_set_files: 'Adjusting the plan',
    knowledge_search: 'Recalling what works',
    knowledge_get: 'Recalling what works',
    knowledge_propose: 'Noting what works',
    skill_get: 'Reading a how-to guide',
    skill_list: 'Looking up how-to guides',
    project_overview: 'Reviewing the project',
    task_get: 'Reading the task',
    task_list: 'Reviewing tasks',
    git_diff: 'Reviewing changes',
    code_query: 'Studying the code',
    test_register: 'Saving a test',
    test_list: 'Looking at the saved tests',
    test_retire: 'Retiring an outdated test',
    task_update_verification: "Changing a task's checks",
    task_run_checks: "Running its task's checks",
    task_fix_probe: "Correcting a check's probe",
    spec_get: 'Reading the spec',
    spec_propose: 'Proposing a spec change',
    decision_record: 'Recording a decision',
    research_add_source: 'Recording a research source',
    research_add_claim: 'Recording a research finding',
    capabilities_query: 'Checking what the tools can do',
    evidence_view: 'Looking at recorded proof',
    evidence_search: 'Looking through recorded proof',
    test_results: 'Reading the test results',
    decided_list: 'Reviewing what was decided without asking',
    studio_place: 'Checking which place Studio has open',
    ui_snapshot: 'Reading the last UI audit',
    escalate: 'Asking for a decision',
    probe_submit: 'Running a self-check',
    external_tools: 'Looking up plugin tools',
    external_call: 'Using a plugin tool',
    wait_for: /"upload"/.test(arg) ? 'Waiting for uploads to Roblox' : /"kiln_turn"/.test(arg) ? "Waiting for Kiln's copilot" : /"studio_edit"/.test(arg) ? 'Waiting for Studio to be free' : 'Waiting',
    roblox_status: 'Checking the Studio connection',
    roblox_search: 'Inspecting the place',
    roblox_perf: 'Measuring performance',
    cloud_luau_run: 'Running code in the cloud',
    map_audit: 'Checking how finished the map looks',
    look_analyze: 'Measuring how a screenshot looks',
    texture_status: 'Checking whether Roblox approved the textures',
    lighting_set: 'Setting the lighting',
    ui_audit: 'Checking the game UI',
    ui_icon: /"list":\s*true/.test(arg) ? 'Looking at the UI icons' : 'Drawing UI icons',
    ui_mockup_create: 'Mocking up a screen',
    ui_mockup_update: /"applied"/.test(arg) ? 'Recording the mockup that went into the game' : /"revise"/.test(arg) ? 'Fixing a mockup version' : 'Revising a mockup',
    ui_mockup_list: 'Looking at the UI mockups',
    ui_mockup_render: 'Looking at a mockup',
    ui_lab_check: 'Checking the UI on 14 devices',
    ui_lab_review: 'Reviewing the UI on phones',
    ui_lab_view: 'Looking at the UI on a device',
    ui_lab_motion: 'Playing the UI motion',
    ui_lab_build: 'Building the UI into the game',
    ui_forge: /"action":\s*"(element|custom)"/.test(arg) ? 'Forging UI art' : 'Looking at UI art directions',
    match_setup: 'Setting up the lobby, queue and matches',
    match_get: 'Reading the match setup',
    store_catalog: 'Designing the store',
    store_module: 'Putting the store in the game',
    store_list: 'Looking at the Storefront',
    copy_write: 'Writing the game\'s copy',
    copy_get: 'Reading the game\'s copy',
    thumb_shot: 'Staging a thumbnail shot in Studio',
    thumb_compose: /"size":\s*"icon"/.test(arg) ? 'Composing the game\'s icon' : 'Composing a thumbnail',
    thumb_pick: 'Judging the thumbnails',
    store_icons: 'Drawing the store\'s icons',
    ui_reference: 'Reading a reference picture',
    reference_list: 'Looking at your references',
    reference_view: /"detail":\s*true/.test(arg) ? 'Looking closely at a moment of a reference clip' : /"part":\s*"sound"/.test(arg) ? "Reading a reference clip's sound" : 'Looking at a reference',
    ui_mockup_audit: /"compare":\s*true/.test(arg) ? 'Comparing the game UI with its mockup' : 'Checking a mockup on every device',
    asset_get: 'Looking up an asset',
    asset_usage: 'Finding where an asset is used',
    animation_import: "Bringing in the game's own animation",
    animation_view: 'Looking at an animation',
    animation_upload: 'Uploading animations to Roblox',
    animation_use: 'Adding a draft animation to the game',
    animation_remove: 'Removing an animation',
    vfx_list: 'Checking the effects',
    vfx_use: 'Adding a draft effect to the game',
    vfx_remove: 'Removing an effect',
    audio_use: 'Adding a draft sound to the game',
    audio_remove: 'Removing a sound',
    model_remove: 'Removing a model',
    model_gear: 'Turning a model into gear',
    rig_build: 'Building a rig in Studio',
    kiln_status: 'Checking on Kiln',
    kiln_clips: "Checking Kiln's animation clips",
    kiln_clip: "Working on a clip with Kiln's animation",
    kiln_import: 'Bringing a model in from Kiln',
    kiln_layout_import: /"check_only":\s*true/.test(arg) ? 'Checking a Kiln map' : 'Bringing a map in from Kiln',
    kiln_request: /"turn"/.test(arg) ? "Waiting for Kiln's copilot" : /"mode":\s*"interject"/.test(arg) ? "Sending a correction into Kiln's build" : /"wait":\s*false/.test(arg) ? 'Queueing a Kiln build' : "Briefing Kiln's copilot",
    kiln_builds: /"wait":\s*false/.test(arg) ? 'Checking on the Kiln builds' : 'Waiting for the Kiln builds',
    StructuredOutput: 'Writing up results',
  };
  return table[tool] ?? `Using ${tool.replace(/_/g, ' ')}`;
}

export interface LiveActivity {
  /** Latest plain-language action per run. */
  action: string;
  at: number;
}

/** Live "what is this agent doing right now" per run, from the run stream. */
export function useLiveActivity(): Record<string, LiveActivity> {
  const [acts, setActs] = useState<Record<string, LiveActivity>>({});
  const pending = useRef<Record<string, LiveActivity>>({});
  const timer = useRef<number | null>(null);
  useCoreEvent(['run.stream'], (_c, payload) => {
    const p = payload as { runId: string; kind: string; text: string };
    let action: string | null = null;
    if (p.kind === 'tool_use') action = describeTool(p.text);
    else if (p.kind === 'thinking') action = 'Thinking';
    else if (p.kind === 'text') action = 'Writing';
    if (!action) return;
    pending.current[p.runId] = { action, at: Date.now() };
    if (timer.current == null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setActs((a) => ({ ...a, ...pending.current }));
        pending.current = {};
      }, 250);
    }
  });
  return acts;
}
