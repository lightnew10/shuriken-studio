import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentRunRequest } from '../src/core/providers/types';
import { importTargets, turnMode } from '../src/core/copilots/intent';
import { COPILOT_IDS, COPILOT_IMPORT_ROLES, COPILOT_LOOK, COPILOT_ROLES, COPILOT_TOOLS, copilotTools, type CopilotId } from '../src/core/copilots/copilot-roles';
import { AnimationStore } from '../src/core/animation/animation-service';
import { EffectStore } from '../src/core/effects/effects-service';
import { SoundLibrary } from '../src/core/audio/audio-library';
import { ROLES } from '../src/core/agents/roles';
import { coreHarness, waitFor } from './helpers/make-core';
import { fakeWrite } from './helpers/fake-provider';

// The user, after 1.10: "the effects copilot should absolutely not be able to initiate a playtest or touch
// anything outside of its domain, except at most importing its product into studio if you explicitly ask or
// imply." "copilots should absolutely not implement a manual ask into a game automatically. It should stay in
// their respective container previews so the viewer can iterate until they choose to click the import button
// or explicitly authorize it." (The effects copilot, asked for "a crazy vfx", had playtested twice, synced code
// twice, run Luau in Studio and written a file.)

const makeCore = coreHarness();

/** The Shuriken tools a run can see: what its MCP token lists, as a real agent gets them. */
async function toolsOf(req: AgentRunRequest): Promise<string[]> {
  const server = req.toolServers[0]!;
  const client = new Client({ name: 'tool-lister', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => {});
  }
}

/** The call was refused because this run has no such tool (not because Studio is closed in tests). */
const refused = (r: unknown) => {
  const out = r as { isError?: boolean; content?: Array<{ text?: string }> };
  return !!out.isError && /Tool \w+ not found|Unknown or unavailable tool/.test(out.content?.map((c) => c.text ?? '').join(' ') ?? '');
};
const isCopilot = (req: AgentRunRequest) => 'copilotReply' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});

describe('what a message to a copilot asks for', () => {
  it('makes a draft unless the user asks for the game', () => {
    for (const t of [
      'make a crazy vfx to demonstrate your abilities',
      'why is it not playing in my viewer',
      'make me combat music, dont put it in studio yet',
      'Make an impact burst for sword hits',
      'make it bigger and add a second ring',
      'add more sparks to it',
      'add it to the effect as a second layer',
      'use warmer colours',
      'use it as a base for a darker version',
      'play it again',
      'play it in the preview',
      'calm lofi for the lobby',
      'a heavier run for the Griever',
      'how would this sound in the game?',
      "don't add it yet",
      'just a draft for now',
      'keep it a draft',
      'not in the game yet, I want to hear it first',
      'use B',
      // "It" is the thing being asked for, not a draft that exists: the copilot makes the draft and offers.
      'I want a sword slash I can do while running. Play it on left click and time the hit on the server. Just make it.',
      'make a dust puff and use it for landings',
    ])
      expect(turnMode(t, { drafts: true }), t).toBe('draft');
    // With no draft in the dock there is nothing "it" can mean.
    for (const t of ['add it', 'use it for the sword hits', 'play it in the lobby']) expect(turnMode(t), t).toBe('draft');
  });

  it('puts it in the game when the user says so', () => {
    for (const t of ['put it in the game', 'Put it in Studio', 'add it', 'Add it to the game', 'use it', 'use this one', 'import it', 'send it to studio', 'ship it', 'build it', 'add them all', 'ok add it now']) expect(turnMode(t, { drafts: true }), t).toBe('import');
    // The game named outright needs no draft to refer to.
    for (const t of ['put it in the game', 'Make a hit spark and put it in the game', 'build it', 'send it to studio']) expect(turnMode(t), t).toBe('import');
  });

  it('puts it in the game when the user clearly implies it', () => {
    for (const t of [
      'replace the hit spark in the game with this',
      'replace the jump sound with this one',
      'use it for the sword hits',
      'play it in the lobby',
      'use it as the lobby music',
      'upload it',
      'remove HitSpark from the game',
      'Compose driving combat music, then put it in the game',
    ])
      expect(turnMode(t, { drafts: true }), t).toBe('import');
  });

  it('takes a plain yes to its offer as the go-ahead, and version letters only where drafts have versions', () => {
    expect(turnMode('yes', { offered: true })).toBe('import');
    expect(turnMode('sounds good', { offered: true })).toBe('import');
    expect(turnMode('yes', { offered: false })).toBe('draft');
    expect(turnMode('yes but louder', { offered: true })).toBe('draft');
    expect(turnMode('ok, try another seed', { offered: true })).toBe('draft');
    expect(turnMode('use B', { versions: true })).toBe('import');
    expect(turnMode('Just make it.', { versions: true })).toBe('import');
    expect(turnMode('Just make it.')).toBe('draft');
  });

  it('finds the drafts meant: named, on screen, or the ones it made last', () => {
    const drafts = ['HitSpark2', 'BossAura', 'Dust'];
    expect(importTargets('put BossAura in the game', 'Dust', ['HitSpark2'], drafts)).toEqual(['BossAura']);
    expect(importTargets('add it', 'Dust', ['HitSpark2'], drafts)).toEqual(['Dust']);
    expect(importTargets('add it', 'SwordSlash', ['HitSpark2'], drafts)).toEqual(['HitSpark2']);
    expect(importTargets('yes', undefined, ['HitSpark2', 'Gone'], drafts)).toEqual(['HitSpark2']);
    expect(importTargets('add the dust and the bossaura', null, [], drafts).sort()).toEqual(['BossAura', 'Dust']);
    expect(importTargets('put a new explosion in the game', null, [], drafts)).toEqual([]);
  });
});

describe('what a copilot may touch', () => {
  // Written out, so that giving a copilot another tool takes a change here too.
  const LOOK = ['code_query', 'knowledge_search', 'project_overview', 'reference_list', 'reference_view', 'roblox_console', 'roblox_explore', 'roblox_inspect', 'roblox_search', 'roblox_status', 'skill_get', 'skill_list', 'store_search'];
  const ALLOWED: Record<CopilotId, { draft: string[]; import: string[] }> = {
    animation: {
      draft: ['animation_create', 'animation_import', 'animation_list', 'animation_presets', 'animation_remove', 'animation_view', 'kiln_clips', 'kiln_status', 'model_list', 'model_view'],
      import: ['animation_build', 'animation_check', 'animation_upload', 'animation_use', 'kiln_clip', 'kiln_import', 'kiln_request', 'rig_build', 'roblox_screenshot'],
    },
    audio: {
      draft: ['audio_add', 'audio_ambience', 'audio_find', 'audio_import', 'audio_list', 'audio_music', 'audio_music_edit', 'audio_remove', 'audio_sample_add', 'audio_sample_find', 'audio_samples', 'audio_score', 'audio_sfx', 'audio_stinger'],
      import: ['audio_upload', 'audio_use'],
    },
    ui: {
      // ui_icon in a design turn draws and saves pictures only (no upload, no UiIcons module): the test below checks it.
      draft: ['audio_list', 'look_analyze', 'ui_forge', 'ui_icon', 'ui_lab_check', 'ui_lab_motion', 'ui_lab_review', 'ui_lab_view', 'ui_mockup_audit', 'ui_mockup_create', 'ui_mockup_list', 'ui_mockup_render', 'ui_mockup_update', 'ui_reference'],
      // ui_lab_build writes game code: only in a turn that puts the design into the game.
      import: ['luau_check', 'roblox_screenshot', 'roblox_sync_push', 'ui_audit', 'ui_lab_build'],
    },
    effects: {
      draft: ['animation_list', 'audio_list', 'vfx_create', 'vfx_list', 'vfx_measure', 'vfx_presets', 'vfx_remove', 'vfx_texture'],
      import: ['roblox_screenshot', 'vfx_build', 'vfx_cutscene', 'vfx_play', 'vfx_use'],
    },
    // The Storefront's three: the design, the words and the pictures. None of them pushes to Roblox, ever.
    store: { draft: ['copy_get', 'store_catalog', 'store_list'], import: ['store_module'] },
    copy: { draft: ['copy_get', 'copy_write', 'store_list'], import: ['store_module'] },
    thumbnails: { draft: ['copy_get', 'model_list', 'store_icons', 'store_list', 'thumb_compose', 'thumb_pick', 'thumb_shot'], import: [] },
  };
  /** The capabilities that are a copilot's own workshop. */
  const OWN: Record<CopilotId, string[]> = {
    animation: ['roblox.app.animation', 'kiln.status', 'kiln.clips', 'kiln.request', 'kiln.clip', 'kiln.import'],
    audio: ['roblox.app.audio'],
    ui: ['app.mockups'],
    effects: ['roblox.app.vfx'],
    store: ['storefront.catalog'],
    copy: ['storefront.copy'],
    thumbnails: ['storefront.art'],
  };
  /** The only tools from outside its workshop that change anything, and only in a turn that puts its work in the game. */
  const BORROWED: Record<CopilotId, string[]> = { animation: ['rig_build'], audio: [], ui: ['roblox_sync_push'], effects: [], store: [], copy: ['store_module'], thumbnails: [] };
  /** What no copilot has, in any turn. */
  const NEVER = ['roblox_run_luau', 'roblox_playtest', 'roblox_call', 'cloud_luau_run', 'geometry_apply', 'world_rebuild', 'model_place', 'model_gear', 'model_remove', 'lighting_set', 'blender_python', 'kiln_layout_import', 'asset_reuse', 'task_run_checks', 'plan_add_task', 'escalate', 'vfx_runtime'];

  it('has exactly the tools written here', () => {
    expect([...COPILOT_LOOK].sort()).toEqual(LOOK);
    for (const id of COPILOT_IDS) {
      expect([...COPILOT_TOOLS[id].draft].sort(), `${id} draft`).toEqual(ALLOWED[id].draft);
      expect([...COPILOT_TOOLS[id].import].sort(), `${id} import`).toEqual(ALLOWED[id].import);
      expect(COPILOT_ROLES[id].appTools, id).toEqual(copilotTools(id, 'draft'));
      expect(COPILOT_IMPORT_ROLES[id].appTools, id).toEqual(copilotTools(id, 'import'));
      expect(COPILOT_ROLES[id].drafts, id).toBe(true);
      expect(COPILOT_IMPORT_ROLES[id].drafts, id).toBeUndefined();
      expect(COPILOT_ROLES[id].id).toBe(COPILOT_IMPORT_ROLES[id].id);
    }
  });

  it('is its own workshop plus read-only looking, by the registry (capability and permission class)', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const reads = (name: string) => ['read', 'roblox_read'].includes(core.tools.get(name)!.permission);
    for (const name of COPILOT_LOOK) expect(reads(name), `${name} only looks`).toBe(true);
    for (const id of COPILOT_IDS) {
      for (const mode of ['draft', 'import'] as const) {
        const tools = copilotTools(id, mode);
        expect(new Set(tools).size, `${id} ${mode}: no tool twice`).toBe(tools.length);
        for (const name of tools) {
          const def = core.tools.get(name);
          expect(def, `${name} (${id}) is a registered tool`).toBeTruthy();
          const own = OWN[id].includes(def!.capability);
          if (!own && !reads(name)) expect(mode === 'import' ? BORROWED[id] : [], `${id} ${mode} turn: ${name} (${def!.capability}, ${def!.permission}) is outside its field`).toContain(name);
          expect(NEVER, `${id} ${mode}`).not.toContain(name);
        }
        // Built-in tools: reading only; the UI copilot edits code when it builds a design; nobody has a shell.
        const role = (mode === 'draft' ? COPILOT_ROLES : COPILOT_IMPORT_ROLES)[id];
        expect(role.builtinTools, `${id} ${mode}`).toEqual(id === 'ui' && mode === 'import' ? ['read_files', 'edit_files', 'todo'] : ['read_files', 'todo']);
      }
      // A draft turn: besides looking, only its own workshop's tools that make drafts in Shuriken, and none that
      // syncs code, starts a playtest (ui_audit reads the UI in one), brings Studio forward or builds into the place.
      const draft = copilotTools(id, 'draft');
      for (const name of ['roblox_sync_push', 'ui_audit', 'roblox_screenshot', ...ALLOWED[id].import]) expect(draft, `${id} draft turn`).not.toContain(name);
      for (const name of draft.filter((n) => !reads(n))) expect(OWN[id], `${id} draft turn: ${name} writes, so it must be its own workshop's`).toContain(core.tools.get(name)!.capability);
    }
    // The A-Z team is not narrowed: its specialists keep building into the game.
    for (const worker of ['vfx-artist', 'sound-designer', 'animator', 'ui-engineer', 'modeler']) {
      expect(ROLES[worker]!.appTools, worker).toBeNull();
      expect(ROLES[worker]!.builtinTools, worker).toEqual(expect.arrayContaining(['edit_files', 'shell']));
      expect(ROLES[worker]!.drafts, worker).toBeUndefined();
    }
  });
});

describe('a copilot turn', () => {
  it('gives each copilot its turn\'s tools and nothing else, and no file edits outside the UI copilot\'s own code', async () => {
    const seen: Array<{ role: string; prompt: string; tools: string[]; builtin: string[]; wrote: Record<string, boolean>; refused: Record<string, boolean> }> = [];
    const { core } = await makeCore({
      respond: async (req, _kind, call) => {
        if (!isCopilot(req)) return { intent: 'question', reply: 'Noted.' };
        const wrote: Record<string, boolean> = {};
        for (const f of ['src/Client/UI/Shop.client.luau', 'src/Server/Combat.server.luau', 'world/Effects.luau', 'effects/Hack.fx.json', 'src/Shared/ShurikenEffects.luau']) wrote[f] = await fakeWrite(req, f, '-- written by a copilot\n');
        const shell = await req.permission({ tool: 'Bash', toolClass: 'shell', input: { command: 'echo hi' } });
        wrote.shell = shell.allow;
        const tried: Record<string, boolean> = {};
        for (const [tool, args] of [['roblox_playtest', { action: 'run' }], ['roblox_run_luau', { code: 'return 1' }], ['roblox_sync_push', {}], ['roblox_call', { tool: 'insert_asset' }], ['model_place', { name: 'Crate', position: [0, 0, 0] }]] as const) tried[tool] = refused(await call(tool, args));
        seen.push({ role: req.role, prompt: req.prompt, tools: await toolsOf(req), builtin: req.builtinTools, wrote, refused: tried });
        return { copilotReply: 'Done.' };
      },
    });
    core.orchestrator.pause();
    for (const id of COPILOT_IDS) {
      const replies = () => core.copilots.chat(id)!.list().filter((m) => m.role === 'copilot');
      core.copilots.send(id, 'make me something to look at');
      await waitFor(() => replies().length === 1);
      core.copilots.send(id, 'put it in the game');
      await waitFor(() => replies().length === 2);
      const [draft, imported] = seen.filter((s) => s.role === `copilot-${id}`);
      expect(draft!.prompt, id).toMatch(/This turn: (DRAFT|DESIGN)\./);
      expect(draft!.tools, `${id} draft turn`).toEqual(copilotTools(id, 'draft').sort());
      expect(draft!.builtin, id).toEqual(['read_files', 'todo']);
      expect(Object.values(draft!.wrote), `${id} draft turn writes nothing`).toEqual([false, false, false, false, false, false]);
      // The thumbnail copilot's pictures never go into the game: every turn of its is a draft.
      expect(imported!.prompt, id).toMatch(id === 'thumbnails' ? /This turn: DRAFT\./ : /This turn: PUT IT IN THE GAME\./);
      expect(imported!.tools, `${id} import turn`).toEqual(copilotTools(id, id === 'thumbnails' ? 'draft' : 'import').sort());
      // Only the UI copilot edits files, only when it builds a design, and only Luau code that isn't another dock's.
      expect(imported!.wrote, id).toEqual(
        id === 'ui'
          ? { 'src/Client/UI/Shop.client.luau': true, 'src/Server/Combat.server.luau': true, 'world/Effects.luau': false, 'effects/Hack.fx.json': false, 'src/Shared/ShurikenEffects.luau': false, shell: false }
          : { 'src/Client/UI/Shop.client.luau': false, 'src/Server/Combat.server.luau': false, 'world/Effects.luau': false, 'effects/Hack.fx.json': false, 'src/Shared/ShurikenEffects.luau': false, shell: false },
      );
      // Playtests, Luau in Studio, Studio's other tools and another field's placing are refused in both.
      for (const turn of [draft!, imported!]) for (const tool of ['roblox_playtest', 'roblox_run_luau', 'roblox_call', 'model_place']) expect(turn.refused[tool], `${id}: ${tool}`).toBe(true);
      expect(draft!.refused.roblox_sync_push, id).toBe(true);
    }
  });

  it('lets the animation copilot ask Kiln for animation only, never for a model', async () => {
    const said: Record<string, string> = {};
    const { core } = await makeCore({
      respond: async (req, _kind, call) => {
        if (!isCopilot(req)) return { intent: 'question', reply: 'Noted.' };
        const text = (r: unknown) => (r as { content?: Array<{ text?: string }> }).content?.map((c) => c.text ?? '').join(' ') ?? '';
        said.model = text(await call('kiln_request', { model: 'Griever', kind: 'new', text: 'A Griever.' }));
        said.unsaid = text(await call('kiln_request', { model: 'Griever', text: 'A Griever.' }));
        said.family = text(await call('kiln_request', { family: 'Legs', models: ['LegA', 'LegB'], kind: 'animate', text: 'Legs.' }));
        said.animate = text(await call('kiln_request', { model: 'Griever', kind: 'animate', text: 'A Walk loop; tell me its ground speed.' }));
        return { copilotReply: 'Done.' };
      },
    });
    core.orchestrator.pause();
    core.copilots.send('animation', 'put a walk for the Griever in the game');
    await waitFor(() => core.copilots.chat('animation')!.list().some((m) => m.role === 'copilot'));
    for (const k of ['model', 'unsaid', 'family']) expect(said[k], k).toMatch(/asks Kiln for animation only[\s\S]*is the modeler's work: put it in your handoff/);
    // An animation request gets through to the tool (Kiln isn't there in tests, which is another answer).
    expect(said.animate).not.toMatch(/asks Kiln for animation only/);
  });

  it('keeps an effect a draft in the preview until the user adds it, then builds only that into the game', async () => {
    const tried: Record<string, boolean> = {};
    const { core, provider, root } = await makeCore({
      respond: async (req, _kind, call) => {
        if (!isCopilot(req)) return { intent: 'question', reply: 'Noted.' };
        if (/This turn: DRAFT/.test(req.prompt)) {
          await call('vfx_create', { name: 'HitSpark', preset: 'HitSpark', build: true });
          for (const tool of ['vfx_use', 'vfx_build', 'vfx_play', 'vfx_cutscene']) tried[tool] = refused(await call(tool, { name: 'HitSpark', position: [0, 5, 0] }));
          return { copilotReply: 'HitSpark is a draft in the effects preview. Add to game puts it in.', digest: 'Made the HitSpark burst' };
        }
        await call('vfx_use', { name: 'HitSpark' });
        return { copilotReply: 'HitSpark is in the game: Effects.play("HitSpark", cframe).', digest: 'Added the HitSpark effect to the game', handoff: 'Fire HitSpark on the sword Hit marker.' };
      },
    });
    core.orchestrator.pause();
    const chat = core.copilots.chat('effects')!;
    const replies = () => chat.list().filter((m) => m.role === 'copilot');
    const fx = new EffectStore(root);

    core.copilots.send('effects', 'make a crazy vfx to demonstrate your abilities');
    await waitFor(() => replies().length === 1);
    expect(fx.get('HitSpark')).toMatchObject({ draft: true });
    expect(fx.inGame()).toEqual([]);
    // Nothing of it in the game's files: no builder, no runtime modules in the code.
    expect(existsSync(join(root, 'world', 'Effects.luau'))).toBe(false);
    expect(existsSync(join(root, 'src', 'Shared', 'ShurikenEffects.luau'))).toBe(false);
    expect(existsSync(join(root, 'src', 'Client', 'ShurikenEffects.client.luau'))).toBe(false);
    expect(tried).toEqual({ vfx_use: true, vfx_build: true, vfx_play: true, vfx_cutscene: true });
    expect(replies()[0]!.data).toMatchObject({ mode: 'draft', drafts: [{ name: 'HitSpark', draft: true }], digest: 'Draft in the dock, not in the game: Made the HitSpark burst' });
    // The effects page lists it as a draft (it plays in the preview there).
    const listed = (await core.invokeTool('vfx_list', {}, 'ui')).data as { effects: Array<{ name: string; draft?: boolean }> };
    expect(listed.effects).toMatchObject([{ name: 'HitSpark', draft: true }]);

    // The director and the team see it as a draft, not as an effect of the game.
    core.director.send('what effects do we have?');
    await waitFor(() => provider.runs.some((r) => r.role === 'director'));
    const director = provider.runs.find((r) => r.role === 'director')!.prompt;
    expect(director).toMatch(/Drafts in the Animation and Effects docks \(the user's experiments, not in the game until they add them\): HitSpark \(effect\)/);
    expect(director).not.toMatch(/- Effects \(/);
    expect(director).toMatch(/Effects copilot, \d+ min ago: Draft in the dock, not in the game: Made the HitSpark burst/);

    // "add it": the next turn may put it in, and is told which draft.
    core.copilots.send('effects', 'add it');
    await waitFor(() => replies().length === 2);
    const runs = provider.runs.filter((r) => r.role === 'copilot-effects');
    expect(runs[1]!.prompt).toMatch(/This turn: PUT IT IN THE GAME\. The user asked for it in their game: the draft "HitSpark" \(vfx_use \{name\}/);
    expect(runs[1]!.resumeSessionId).toBe(`s-${runs[0]!.runId}`);
    expect(fx.get('HitSpark')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world', 'Effects.luau'), 'utf8')).toContain('name="HitSpark"');
    expect(existsSync(join(root, 'src', 'Shared', 'ShurikenEffects.luau'))).toBe(true);
    expect(replies()[1]!.data).toMatchObject({ mode: 'import', drafts: [{ name: 'HitSpark' }], digest: 'Added the HitSpark effect to the game', handoff: 'Fire HitSpark on the sword Hit marker.' });
    expect((replies()[1]!.data!.drafts as Array<{ draft?: boolean }>)[0]!.draft).toBeUndefined();
  });

  it('never lets a draft replace or remove what the game has until the user says so', async () => {
    const out: Record<string, unknown> = {};
    const { core, root } = await makeCore({
      respond: async (req, _kind, call) => {
        if (!isCopilot(req)) return { intent: 'question', reply: 'Noted.' };
        if (req.role === 'copilot-effects') {
          out.fx = (await call('vfx_create', { name: 'HitSpark', preset: 'HitSpark', scale: 2 })) as unknown;
          out.fxRemove = JSON.stringify(await call('vfx_remove', { name: 'HitSpark' }));
          return { copilotReply: 'A bigger take, HitSpark2, is a draft.' };
        }
        out.anim = (await call('animation_create', { name: 'Slash1', preset: 'SwordSlash1', speed: 1.4 })) as unknown;
        out.animRemove = JSON.stringify(await call('animation_remove', { name: 'Slash1' }));
        return { copilotReply: 'A faster take, Slash1_2, is a draft.' };
      },
    });
    core.orchestrator.pause();
    // The game has an effect and an animation (the team's, or added on the page).
    await core.invokeTool('vfx_create', { name: 'HitSpark', preset: 'HitSpark' }, 'ui');
    await core.invokeTool('animation_create', { name: 'Slash1', preset: 'SwordSlash1' }, 'ui');
    const fx = new EffectStore(root);
    const anims = new AnimationStore(root);
    const fxBuilder = readFileSync(join(root, 'world', 'Effects.luau'), 'utf8');
    const animBuilder = readFileSync(join(root, 'world', 'Animations.luau'), 'utf8');

    core.copilots.send('effects', 'make the hit spark twice as big', { page: 'effects', item: 'HitSpark' });
    await waitFor(() => core.copilots.chat('effects')!.list().some((m) => m.role === 'copilot'));
    expect(fx.get('HitSpark')!.draft).toBeUndefined();
    expect(fx.get('HitSpark2')).toMatchObject({ draft: true, draftOf: 'HitSpark' });
    expect(out.fxRemove).toMatch(/HitSpark is in the game: removing it changes the game, which this turn can't/);
    expect(readFileSync(join(root, 'world', 'Effects.luau'), 'utf8')).toBe(fxBuilder);
    expect(JSON.stringify(out.fx)).toMatch(/NOT in the game or in Studio/);
    expect(core.copilots.chat('effects')!.list().find((m) => m.role === 'copilot')!.data).toMatchObject({ drafts: [{ name: 'HitSpark2', draft: true, of: 'HitSpark' }] });

    core.copilots.send('animation', 'make this slash faster', { page: 'animation', item: 'Slash1' });
    await waitFor(() => core.copilots.chat('animation')!.list().some((m) => m.role === 'copilot'));
    expect(anims.get('Slash1')!.draft).toBeUndefined();
    expect(anims.get('Slash1_2')).toMatchObject({ draft: true, draftOf: 'Slash1' });
    expect(anims.inGame().map((f) => f.clip.name)).toEqual(['Slash1']);
    expect(out.animRemove).toMatch(/Slash1 is in the game: removing it changes the game, which this turn can't/);
    expect(readFileSync(join(root, 'world', 'Animations.luau'), 'utf8')).toBe(animBuilder);
    expect(JSON.stringify(out.anim)).toMatch(/NOT in the game or in Studio/);

    // The page's button (Replace HitSpark): the draft takes the game effect's place, and its own file goes.
    const used = await core.invokeTool('vfx_use', { name: 'HitSpark2', as: 'HitSpark' }, 'ui');
    expect(used.isError).toBeFalsy();
    expect(fx.names()).toEqual(['HitSpark']);
    expect(fx.get('HitSpark')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world', 'Effects.luau'), 'utf8')).not.toBe(fxBuilder);
    // Add to game under its own name.
    const added = await core.invokeTool('animation_use', { name: 'Slash1_2' }, 'ui');
    expect(added.isError).toBeFalsy();
    expect(anims.inGame().map((f) => f.clip.name).sort()).toEqual(['Slash1', 'Slash1_2']);
    expect(anims.get('Slash1_2')!.draftOf).toBeUndefined();
    expect(readFileSync(join(root, 'world', 'Animations.luau'), 'utf8')).toContain('Slash1_2');
  });

  it('keeps an animation a draft on the Animation page, and a sound a draft whatever the copilot passes', async () => {
    const { core, root } = await makeCore({
      respond: async (req, _kind, call) => {
        if (!isCopilot(req)) return { intent: 'question', reply: 'Noted.' };
        if (req.role === 'copilot-animation') {
          if (/This turn: DRAFT/.test(req.prompt)) await call('animation_create', { name: 'Dodge', preset: 'SwordSlash1' });
          else await call('animation_use', { name: 'Dodge' });
          return { copilotReply: 'Done.' };
        }
        if (/This turn: DRAFT/.test(req.prompt)) await call('audio_sfx', { name: 'Jump', preset: 'jump', draft: false, upload: true });
        else await call('audio_use', { name: 'Jump' });
        return { copilotReply: 'Done.' };
      },
    });
    core.orchestrator.pause();
    const anims = new AnimationStore(root);
    const sounds = new SoundLibrary(root);
    const count = (id: CopilotId) => core.copilots.chat(id)!.list().filter((m) => m.role === 'copilot').length;

    core.copilots.send('animation', 'a quick dodge');
    await waitFor(() => count('animation') === 1);
    expect(anims.get('Dodge')).toMatchObject({ draft: true });
    expect(existsSync(join(root, 'world', 'Animations.luau'))).toBe(false);
    expect(existsSync(join(root, 'src', 'Shared', 'ShurikenAnimations.luau'))).toBe(false);
    core.copilots.send('animation', 'yes');
    await waitFor(() => count('animation') === 2);
    expect(anims.get('Dodge')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world', 'Animations.luau'), 'utf8')).toContain('Dodge');
    expect(existsSync(join(root, 'src', 'Shared', 'ShurikenAnimations.luau'))).toBe(true);

    core.copilots.send('audio', 'make me a jump sound, dont put it in studio yet');
    await waitFor(() => count('audio') === 1);
    expect(sounds.get('Jump')).toMatchObject({ draft: true, assetId: null });
    expect(sounds.inGame()).toEqual([]);
    expect(existsSync(join(root, 'world', 'Audio.luau'))).toBe(false);
    core.copilots.send('audio', 'use it for the jump');
    await waitFor(() => count('audio') === 2);
    expect(sounds.get('Jump')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world', 'Audio.luau'), 'utf8')).toContain('Jump');
  });
});
