/**
 * One real agent using the workshop tools (costs one agent session of usage):
 *
 *   E2E=workshop STUDIO_MATCH=<open scratch place name> npx vitest run -c vitest.e2e.config.ts tests/e2e/workshop.e2e.ts
 *
 * Runs in its own data dir with autosave off, binds a scratch project to an already-open Studio place
 * (never a real game), gives an animator one precise task and checks the result in Studio. Prints the
 * agent's tool calls so the tool UX can be judged.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../../src/core/core';

const MODE = process.env.E2E ?? '';
const MATCH = process.env.STUDIO_MATCH ?? '';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

const CHECK = `local rs = game:GetService("ReplicatedStorage")
local a = rs:FindFirstChild("ShurikenAnimations")
local fx = rs:FindFirstChild("ShurikenEffects")
local missing = {}
for _, n in { "E2ESlash", "E2EWave" } do
  if not (a and a:FindFirstChild(n) and a.Sequences:FindFirstChild(n)) then table.insert(missing, n) end
end
if not (fx and fx:FindFirstChild("E2EHit")) then table.insert(missing, "E2EHit") end
if #missing > 0 then return "FAIL: missing " .. table.concat(missing, ", ") end
return "PASS"`;

describe.runIf(MODE === 'workshop' && MATCH)('workshop tools with a real agent', () => {
  it('an animator builds, authors and checks animations and an effect', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-workshop-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Workshop E2E', rootPath: join(dataDir, 'project'), description: 'Live check of the workshop tools' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: MATCH, autonomy: 'autonomous', maxAttemptsPerTask: 1 });
      core.studio.bind(MATCH);
      const task = ctx.tasks.create({
        kind: 'implement',
        title: 'Sword slash, a wave and a hit spark',
        objective: `Use Shuriken's workshop tools only (no raw Luau for animations or effects):
1. Create an animation named E2ESlash from the SwordSlash1 preset at intensity 1.1, then run animation_check on it and report where the right hand is at the Hit marker.
2. Author a custom 0.8 s one-shot clip named E2EWave: the right arm raises and the hand waves side to side twice (at least 5 keys, a "Wave" marker at the top), then run animation_check on it.
3. Create a burst effect named E2EHit from the HitSpark preset in a cyan color (#44ddff).
Do not change anything else in the place and do not sync or edit other code.`,
        role: 'animator',
        status: 'ready',
        acceptanceCriteria: ['ReplicatedStorage.ShurikenAnimations has E2ESlash and E2EWave', 'ReplicatedStorage.ShurikenEffects has E2EHit', 'Both animations were checked on a rig'],
        verification: [{ kind: 'luau_assert', name: 'workshop output exists', luau: CHECK, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      log(`Task ${task.id} ready; waiting for the animator…`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 10_000));
        const t = ctx.tasks.get(task.id)!;
        if (t.status !== last) {
          log(`task: ${t.status}`);
          last = t.status;
        }
        if (['done', 'verified', 'failed', 'escalated', 'blocked'].includes(t.status)) break;
        if (Date.now() - t0 > 40 * 60_000) throw new Error('timed out after 40 min');
      }
      const runs = core.runner.listRuns(ctx, { limit: 20 });
      for (const r of runs) log(`run ${r.role} ${r.status} ${r.numTurns} turns $${r.costUsd.toFixed(2)} ${r.error ?? ''}`);
      const calls = ctx.store.all<{ tool: string; status: string; args: string | null; error: string | null; result: string | null }>(
        "SELECT tool, status, substr(COALESCE(args, ''), 1, 200) AS args, error, substr(COALESCE(result, ''), 1, 200) AS result FROM tool_calls ORDER BY started_at LIMIT 300",
      );
      for (const c of calls) log(`  ${c.status.padEnd(7)} ${c.tool} ${c.args ?? ''}${c.error ? `
      ERROR ${c.error.slice(0, 400)}` : ''}`);
      const final = ctx.tasks.get(task.id)!;
      log('result:', final.result?.slice(0, 1500));
      expect(['done', 'verified']).toContain(final.status);
    } finally {
      await core.shutdown();
    }
  }, 45 * 60_000);
});

const AV_CHECK = `local rs = game:GetService("ReplicatedStorage")
local au = rs:FindFirstChild("ShurikenAudio")
local missing = {}
for _, n in { "SwordSwing", "BattleTheme", "SwordClang" } do
  if not (au and au:FindFirstChild(n)) then table.insert(missing, n) end
end
local dummy = workspace:FindFirstChild("TrainingDummy", true)
if not (dummy and dummy:IsA("MeshPart")) then table.insert(missing, "TrainingDummy MeshPart") end
if #missing > 0 then return "FAIL: missing " .. table.concat(missing, ", ") end
return "PASS"`;

// A Blender model is placed as one MeshPart per material, named <Model> or <Model>_<Material>.
const DUMMY_CHECK = `for _, d in workspace:GetDescendants() do
  if d:IsA("MeshPart") and string.sub(tostring(d:GetAttribute("ShurikenModel") or ""), 1, 13) == "TrainingDummy" then return "PASS" end
end
return "FAIL: no TrainingDummy MeshPart in Workspace"`;

describe.runIf(MODE === 'workshop-av' && MATCH)('audio and modeling tools with real agents', () => {
  it('a sound designer and a modeler use their workshops', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-av-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Workshop AV E2E', rootPath: join(dataDir, 'project'), description: 'Live check of the audio and modeling tools' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: MATCH, autonomy: 'autonomous', maxAttemptsPerTask: 1 });
      core.studio.bind(MATCH);
      const sound = ctx.tasks.create({
        kind: 'implement',
        title: 'Sword sounds and battle music',
        objective: `Use Shuriken's audio tools:
1. Find one metal sword clang in the Creator Store (store_search, asset_type Audio, a few queries in one call) and add the best one as SwordClang with audio_add.
2. Make a swing whoosh with audio_sfx named SwordSwing.
3. Compose an 8-bar action music loop named BattleTheme with audio_music.
Report which sounds can play in the game now and what (if anything) the user must do for the rest. Do not write game code.`,
        role: 'sound-designer',
        status: 'ready',
        acceptanceCriteria: ['ReplicatedStorage.ShurikenAudio has SwordClang, SwordSwing and BattleTheme', 'The result says clearly which sounds play and what is missing'],
        verification: [{ kind: 'luau_assert', name: 'sounds exist', luau: `local au = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAudio")\nfor _, n in { "SwordSwing", "BattleTheme", "SwordClang" } do if not (au and au:FindFirstChild(n)) then return "FAIL: missing " .. n end end\nreturn "PASS"`, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      const model = ctx.tasks.create({
        kind: 'implement',
        title: 'Training dummy prop',
        objective: `Model a wooden sword-training dummy named TrainingDummy in Blender (blender_python): a post about 5 studs tall on a round base, a crossbar for arms and a ball head, wood with a darker metal band; under 3000 triangles. Place it with model_place at (12, 0, 0) on the ground. Report its size, triangle count and whether the placement is permanent.`,
        role: 'modeler',
        status: 'ready',
        acceptanceCriteria: ['A TrainingDummy MeshPart is in Workspace', 'Size and triangle count are reported'],
        verification: [{ kind: 'luau_assert', name: 'dummy placed', luau: DUMMY_CHECK, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      log(`Tasks ${sound.id}, ${model.id} ready`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 10_000));
        const states = [sound.id, model.id].map((id) => ctx.tasks.get(id)!.status);
        const line = states.join(' / ');
        if (line !== last) {
          log(`tasks: ${line}`);
          last = line;
        }
        if (states.every((s) => ['done', 'verified', 'failed', 'escalated', 'blocked'].includes(s))) break;
        if (Date.now() - t0 > 60 * 60_000) throw new Error('timed out after 60 min');
      }
      for (const id of [sound.id, model.id]) {
        const t = ctx.tasks.get(id)!;
        log(`${t.title}: ${t.status}\n${t.result?.slice(0, 1500)}`);
      }
      for (const id of [sound.id, model.id]) expect(['done', 'verified']).toContain(ctx.tasks.get(id)!.status);
    } finally {
      await core.shutdown();
    }
  }, 70 * 60_000);
});

describe.runIf(MODE === 'workshop-combat' && MATCH)('a VFX artist and a gameplay engineer use the workshops', () => {
  it('custom effect, then a sword combo wired with animations, effects and sounds', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-combat-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Combat E2E', rootPath: join(dataDir, 'project'), description: 'Sword combat wired with the workshops' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: MATCH, autonomy: 'autonomous', maxAttemptsPerTask: 1 });
      core.studio.bind(MATCH);
      // What earlier tasks would have made: moves, effects and a sound that plays without uploading.
      for (const [tool, args] of [
        ['animation_create', { preset: 'SwordSlash1' }],
        ['animation_create', { preset: 'SwordSlash2' }],
        ['animation_create', { preset: 'SwordSlash3' }],
        ['animation_create', { preset: 'HitLight' }],
        ['vfx_create', { name: 'SwordHit', preset: 'HitSpark' }],
        ['vfx_create', { name: 'BladeTrail', preset: 'SlashTrail' }],
        ['audio_add', { name: 'SwordClang', asset_id: '9119072660', kind: 'sfx' }],
      ] as const) {
        const r = await core.invokeTool(tool, args, 'system');
        log(`${tool} ${JSON.stringify(args)} -> ${r.isError ? 'ERROR ' : ''}${r.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').slice(0, 160)}`);
      }
      const vfx = ctx.tasks.create({
        kind: 'implement',
        title: 'Custom crescent slash effect',
        objective: `Author a custom burst effect named CrescentSlash with vfx_create's custom spec (not a preset): a short, bright arc of fast streak particles that reads as a sword slash (white core fading to orange), under 60 particles, lasting under 0.4 s. Check it with vfx_play. Do not edit game code.`,
        role: 'vfx-artist',
        status: 'ready',
        acceptanceCriteria: ['ReplicatedStorage.ShurikenEffects has CrescentSlash built from a custom spec', 'Under 60 particles per burst'],
        verification: [{ kind: 'luau_assert', name: 'effect exists', luau: `local fx = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenEffects")\nif not (fx and fx:FindFirstChild("CrescentSlash")) then return "FAIL: missing CrescentSlash" end\nreturn "PASS"`, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      const combat = ctx.tasks.create({
        kind: 'implement',
        title: 'Sword combo with feedback',
        objective: `Give players a sword that feels good, using the game content that already exists (see the Game content section): a Tool named "Katana" in StarterPack (a simple blade part is fine); left click plays the 3-hit combo SwordSlash1 → SwordSlash2 → SwordSlash3 (the combo resets after a pause), with the BladeTrail effect on during swings. The SERVER validates attacks (cooldown from the animation length) and checks hits at the animation's Hit marker time in front of the attacker; on a hit: 15 damage through one damage function, SwordHit effect and SwordClang sound at the contact point, and the HitLight reaction on the victim. Add a training dummy (an R15 NPC named TrainingDummy with a Humanoid, anchored root) near the spawn built by a world/ builder. Follow skill "roblox-combat-feel". Verify with a playtest: equip, attack the dummy, and show its health drop.`,
        role: 'roblox-engineer',
        status: 'ready',
        acceptanceCriteria: ['Katana tool with the 3-hit combo, trail during swings', 'Server-validated hits at the Hit marker: damage, SwordHit effect, SwordClang sound, HitLight reaction', 'Playtest evidence that hitting the dummy lowers its health'],
        verification: [{ kind: 'static_analysis' }, { kind: 'luau_assert', name: 'katana exists', luau: `local sp = game:GetService("StarterPack")\nif not sp:FindFirstChild("Katana") then return "FAIL: no Katana in StarterPack" end\nif not workspace:FindFirstChild("TrainingDummy", true) then return "FAIL: no TrainingDummy" end\nreturn "PASS"`, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      log(`Tasks ${vfx.id}, ${combat.id} ready`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 15_000));
        const states = [vfx.id, combat.id].map((id) => ctx.tasks.get(id)!.status);
        const line = states.join(' / ');
        if (line !== last) {
          log(`tasks: ${line}`);
          last = line;
        }
        if (states.every((s) => ['done', 'verified', 'failed', 'escalated', 'blocked'].includes(s))) break;
        if (Date.now() - t0 > 90 * 60_000) throw new Error('timed out after 90 min');
      }
      for (const id of [vfx.id, combat.id]) {
        const t = ctx.tasks.get(id)!;
        log(`${t.title}: ${t.status}\n${t.result?.slice(0, 2000)}`);
      }
      for (const id of [vfx.id, combat.id]) expect(['done', 'verified']).toContain(ctx.tasks.get(id)!.status);
    } finally {
      await core.shutdown();
    }
  }, 100 * 60_000);
});

const UNARMED_CHECK = `local a = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAnimations")
local missing = {}
for _, n in { "M1_1", "M1_2", "M1_3", "M1_4", "M1Idle", "Dash", "DodgeRoll", "SpinBackfist" } do
  if not (a and a:FindFirstChild(n) and a.Sequences:FindFirstChild(n)) then table.insert(missing, n) end
end
if #missing > 0 then return "FAIL: missing " .. table.concat(missing, ", ") end
return "PASS"`;

describe.runIf(MODE === 'workshop-unarmed' && MATCH)('an animator uses the unarmed and agility presets and hand reach', () => {
  it('a battlegrounds M1 combo, dodges and a custom spinning backfist', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-unarmed-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Unarmed E2E', rootPath: join(dataDir, 'project'), description: 'Battlegrounds-style unarmed moves' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: MATCH, autonomy: 'autonomous', maxAttemptsPerTask: 1 });
      core.studio.bind(MATCH);
      const task = ctx.tasks.create({
        kind: 'implement',
        title: 'Unarmed M1 combo, dodges and a spinning backfist',
        objective: `This is a battlegrounds-style fighting game (no weapons). With the animation tools only:
1. Make the 4-hit M1 combo from the unarmed presets, named M1_1 … M1_4 (jab, cross, hook, uppercut), a little snappier than the presets (speed about 1.15), plus the guard as M1Idle, and the Dash and DodgeRoll moves. Check M1_1 and M1_4 with animation_check and report which hand lands the hit and where.
2. Author one custom move, SpinBackfist (about 0.55 s, one-shot, a "Hit" marker): the fighter spins a full turn on the spot and lands a right backfist at head height in front. Place the hands with reach instead of arm angles, and check it with animation_check.
Do not change anything else in the place and do not edit game code.`,
        role: 'animator',
        status: 'ready',
        acceptanceCriteria: ['M1_1..M1_4, M1Idle, Dash, DodgeRoll and SpinBackfist are built into ReplicatedStorage.ShurikenAnimations', 'SpinBackfist turns a full circle and lands the right hand in front at its Hit marker', 'Checked on a rig'],
        verification: [{ kind: 'luau_assert', name: 'moves exist', luau: UNARMED_CHECK, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      log(`Task ${task.id} ready; waiting for the animator…`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 15_000));
        const t = ctx.tasks.get(task.id)!;
        if (t.status !== last) {
          log(`task: ${t.status}`);
          last = t.status;
        }
        if (['done', 'verified', 'failed', 'escalated', 'blocked'].includes(t.status)) break;
        if (Date.now() - t0 > 50 * 60_000) throw new Error('timed out after 50 min');
      }
      for (const r of core.runner.listRuns(ctx, { limit: 20 })) log(`run ${r.role} ${r.status} ${r.numTurns} turns $${r.costUsd.toFixed(2)} ${r.error ?? ''}`);
      const final = ctx.tasks.get(task.id)!;
      log('result:', final.result?.slice(0, 2000));
      expect(['done', 'verified']).toContain(final.status);
    } finally {
      await core.shutdown();
    }
  }, 60 * 60_000);
});

// Each prop may be several MeshParts (one per material, named <Model>_<Material>): count models, not parts.
const PROPS_CHECK = `local found = {}
for _, d in workspace:GetDescendants() do
  local m = d:IsA("MeshPart") and tostring(d:GetAttribute("ShurikenModel") or "") or ""
  for _, name in { "Barrel", "WallTorch", "StonePillar" } do
    if string.sub(m, 1, #name) == name then found[name] = true end
  end
end
for _, name in { "Barrel", "WallTorch", "StonePillar" } do
  if not found[name] then return "FAIL: " .. name .. " is not placed" end
end
return "PASS"`;

describe.runIf(MODE === 'workshop-props' && MATCH)('a modeler builds props in Blender from the blender-props skill, a sound designer makes combat hits', () => {
  it('three dungeon props placed on the ground, and punch/clang sounds', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-props-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Props E2E', rootPath: join(dataDir, 'project'), description: 'A dungeon corner dressed with modeled props' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: MATCH, autonomy: 'autonomous', maxAttemptsPerTask: 1 });
      core.studio.bind(MATCH);
      const props = ctx.tasks.create({
        kind: 'implement',
        title: 'Dungeon props',
        objective: `Model three props for a dungeon corner in Blender (blender_python), each its own model: Barrel (wooden, about 3.5 studs tall), WallTorch (about 2 studs, a glowing flame) and StonePillar (about 10 studs). Each under 2000 triangles. Place each once with model_place near (20, 0, 20), a few studs apart, resting on whatever is there. Report each one's size and triangle count, and whether its placement is permanent.`,
        role: 'modeler',
        status: 'ready',
        acceptanceCriteria: ['Three modeled props (barrel, torch, pillar) placed in Workspace', 'Each under 2000 triangles', 'Sizes and triangle counts reported'],
        verification: [{ kind: 'luau_assert', name: 'props placed', luau: PROPS_CHECK, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      const sounds = ctx.tasks.create({
        kind: 'implement',
        title: 'Combat hit sounds',
        objective: `With audio_sfx make the hit sounds for a fist-fighting game: PunchHit (a punch landing), BlockHit (a blocked hit) and SlamHit (a heavy ground slam), one take each. Report which play in the game now and what the user must do for the rest. Do not write game code.`,
        role: 'sound-designer',
        status: 'ready',
        acceptanceCriteria: ['ReplicatedStorage.ShurikenAudio has PunchHit, BlockHit and SlamHit'],
        verification: [{ kind: 'luau_assert', name: 'sounds exist', luau: `local au = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAudio")\nfor _, n in { "PunchHit", "BlockHit", "SlamHit" } do if not (au and au:FindFirstChild(n)) then return "FAIL: missing " .. n end end\nreturn "PASS"`, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      log(`Tasks ${props.id}, ${sounds.id} ready`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 15_000));
        const states = [props.id, sounds.id].map((id) => ctx.tasks.get(id)!.status);
        const line = states.join(' / ');
        if (line !== last) {
          log(`tasks: ${line}`);
          last = line;
        }
        if (states.every((s) => ['done', 'verified', 'failed', 'escalated', 'blocked'].includes(s))) break;
        if (Date.now() - t0 > 60 * 60_000) throw new Error('timed out after 60 min');
      }
      for (const r of core.runner.listRuns(ctx, { limit: 20 })) log(`run ${r.role} ${r.status} ${r.numTurns} turns $${r.costUsd.toFixed(2)} ${r.error ?? ''}`);
      for (const id of [props.id, sounds.id]) expect(['done', 'verified']).toContain(ctx.tasks.get(id)!.status);
    } finally {
      await core.shutdown();
    }
  }, 70 * 60_000);
});

describe.runIf(MODE === 'workshop-fists' && MATCH)('a gameplay engineer wires unarmed combat from the workshops and skills', () => {
  it('M1 fist combo with hit-stop, impacts and a ragdoll knockback finisher', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-e2e-fists-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '1.2.0-e2e', integrations: false });
    try {
      await core.studio.start();
      core.prefs.set({ autoSave: false, maxConcurrentAgents: 1 });
      const summary = core.createProject({ name: 'Fists E2E', rootPath: join(dataDir, 'project'), description: 'Battlegrounds-style unarmed combat' });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: MATCH, autonomy: 'autonomous', maxAttemptsPerTask: 1 });
      core.studio.bind(MATCH);
      // What the animator, VFX artist and sound designer would have made.
      for (const [tool, args] of [
        ['animation_create', { name: 'M1_1', preset: 'PunchJab', speed: 1.15 }],
        ['animation_create', { name: 'M1_2', preset: 'PunchCross', speed: 1.15 }],
        ['animation_create', { name: 'M1_3', preset: 'PunchHook', speed: 1.15 }],
        ['animation_create', { name: 'M1_4', preset: 'PunchUppercut', speed: 1.15 }],
        ['animation_create', { name: 'HitLight', preset: 'HitLight' }],
        ['vfx_create', { name: 'PunchImpact', preset: 'PunchImpact' }],
        ['vfx_create', { name: 'Shockwave', preset: 'Shockwave' }],
        ['audio_sfx', { name: 'PunchHit', preset: 'punch' }],
      ] as const) {
        const r = await core.invokeTool(tool, args, 'system');
        log(`${tool} ${JSON.stringify(args)} -> ${r.isError ? 'ERROR ' : ''}${r.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').slice(0, 120)}`);
      }
      const task = ctx.tasks.create({
        kind: 'implement',
        title: 'Unarmed M1 combat with feedback',
        objective: `Battlegrounds-style unarmed combat using the game content that already exists (see the Game content section). Left click plays the 4-hit M1 combo M1_1 → M1_4 (resets after a pause). The SERVER validates attacks and resolves hits at each move's Hit marker in front of the attacker: 6 damage per hit (10 on M1_4) through one damage function, PunchImpact effect and PunchHit sound at the contact point, HitLight on the victim; M1_4 also knocks the victim back and ragdolls it for about a second (follow skill "roblox-ragdoll-knockback"). The attacker's client gets a short hit-stop on confirmed hits and a small camera shake on the finisher. Add an unanchored R15 training dummy (server-owned) near the spawn from a world/ builder. Follow skill "roblox-combat-feel". Verify with a playtest: the dummy loses health from the combo and the finisher launches and ragdolls it.`,
        role: 'roblox-engineer',
        status: 'ready',
        acceptanceCriteria: ['4-hit M1 combo on left click using M1_1..M1_4', 'Server-side hits at the Hit markers with damage, PunchImpact, PunchHit and HitLight', 'Finisher knocks back and ragdolls the victim, which recovers', 'Playtest evidence on the dummy'],
        verification: [{ kind: 'static_analysis' }, { kind: 'luau_assert', name: 'dummy exists', luau: `if not workspace:FindFirstChild("TrainingDummy", true) then return "FAIL: no TrainingDummy" end\nreturn "PASS"`, datamodel: 'edit' }],
        maxAttempts: 1,
        createdBy: 'e2e',
      });
      log(`Task ${task.id} ready`);
      const t0 = Date.now();
      let last = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 15_000));
        const s = ctx.tasks.get(task.id)!.status;
        if (s !== last) {
          log(`task: ${s}`);
          last = s;
        }
        if (['done', 'verified', 'failed', 'escalated', 'blocked'].includes(s)) break;
        if (Date.now() - t0 > 80 * 60_000) throw new Error('timed out after 80 min');
      }
      for (const r of core.runner.listRuns(ctx, { limit: 20 })) log(`run ${r.role} ${r.status} ${r.numTurns} turns $${r.costUsd.toFixed(2)} ${r.error ?? ''}`);
      expect(['done', 'verified']).toContain(ctx.tasks.get(task.id)!.status);
    } finally {
      await core.shutdown();
    }
  }, 90 * 60_000);
});
