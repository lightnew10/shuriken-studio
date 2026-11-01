import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES, hiddenToolsFor } from '@core/agents/roles';
import { PRESET_NAMES } from '@core/look/lighting-presets';
import { parseSkillFile } from '@core/skills/skill-service';
import { coreHarness } from './helpers/make-core';

// Skill roblox-environment-art v6: the craft of a senior environment artist for Roblox, and the tools that check
// it without eyes (look_analyze, map_audit) and keep it as code (lighting_set). Its Luau examples are linted in
// tests/skills-lint.test.ts.
const md = readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-environment-art', 'SKILL.md'), 'utf8');
const { meta, body } = parseSkillFile(md);

describe('skill roblox-environment-art', () => {
  it('follows the conventions of the other skills, one version up', () => {
    expect(meta.name).toBe('roblox-environment-art');
    expect(Number(meta.version)).toBe(6);
    expect(String(meta.description).length).toBeGreaterThan(300);
    expect(String(meta.description)).toMatch(/Read it before lighting, materials, terrain or dressing/);
    expect(String(meta.version_applicability)).toMatch(/^Roblox Studio 0\.7/);
    expect(meta.tags).toEqual(expect.arrayContaining(['lighting', 'atmosphere', 'materialvariant', 'kit', 'kiln', 'composition', 'cover', 'performance']));
    expect(meta.roblox_systems).toEqual(expect.arrayContaining(['Atmosphere', 'DepthOfFieldEffect', 'MaterialService', 'MaterialVariant', 'Terrain', 'PhysicsService']));
    expect(meta.required_tools).toEqual(expect.arrayContaining(['lighting_set', 'look_analyze', 'map_audit', 'kiln_request', 'kiln_layout_import']));
  });

  it('stays dense: 380-520 lines (the environment artist gets it in full)', () => {
    const lines = md.trimEnd().split(/\r?\n/).length;
    expect(lines).toBeGreaterThanOrEqual(380);
    expect(lines).toBeLessThanOrEqual(520);
  });

  it('teaches every part of the craft the brief asked for', () => {
    for (const part of [
      '## 1. The visual brief', '## 2. Composition', '## 3. Lighting', '## 4. Materials and terrain', '## 5. Set dressing at scale', '## 6. Weather and environment effects', '## 7. Look', '## 8. Performance',
      'Landmarks', 'Leading lines', 'Framing', 'Readable lanes', 'Cover that reads as cover', 'Scale against the player', 'Value first',
      'Lighting.Technology', 'LightingStyle', 'Density', 'Haze', 'Glare', 'EnvironmentDiffuseScale', 'EnvironmentSpecularScale', 'ExposureCompensation', 'ColorCorrectionEffect', 'BloomEffect', 'SunRaysEffect', 'DepthOfFieldEffect', 'Shadows', 'Time of day',
      'MaterialVariant', 'StudsPerTile', 'SetMaterialColor', 'WriteVoxels', 'WaterColor', 'Decoration',
      'kiln_layout_import', 'family', 'style sheet', 'Clutter that tells a story',
      'StreamingEnabled', 'RenderFidelity', 'CastShadow', 'CollisionFidelity', 'instance',
    ]) expect(body, part).toContain(part);
  });

  it('marks conventions as conventions and keeps the facts that broke builders', () => {
    expect((body.match(/\[convention/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(body).toMatch(/`Lighting.Technology`[\s\S]{0,60}can't be read or set from\s+scripts/);
    expect(body).toMatch(/With an Atmosphere, `Lighting.FogStart\/FogEnd\/FogColor` are ignored/);
    expect(body).toMatch(/CanQuery is ignored on a colliding part/);
    expect(body).toMatch(/Only sunny_cartoon was\s+checked in Studio/);
  });

  it('carries the lessons of the 2026-10-01 arena', () => {
    const flat = body.replace(/\s+/g, ' ');
    for (const lesson of ['77-92% one orange hue', 'a container 10 studs from the camera', '2-stud plateaus', 'let mechs walk through it', 'scaffolding boxes were left standing in the lanes']) expect(flat, lesson).toContain(lesson);
  });

  it('names only presets lighting_set has, and defers weather to skill roblox-vfx', () => {
    // The genre table's preset column.
    const table = body.slice(body.indexOf('| Genre | Preset |'), body.indexOf('## 2. Composition'));
    const named = new Set([...table.matchAll(/\b([a-z]+_[a-z]+|overcast)\b/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThanOrEqual(7);
    for (const n of named) expect(PRESET_NAMES, n).toContain(n);
    expect(body).toMatch(/skill `roblox-vfx`/);
    expect(body).not.toMatch(/ParticleEmitter\.Rate/);
  });

  it('is the environment artist’s skill', () => {
    expect(ROLES['environment-artist']!.instructions).toContain('roblox-environment-art');
  });
});

describe('the environment artist role', () => {
  const role = ROLES['environment-artist']!;
  const text = role.instructions.slice(role.instructions.indexOf('ROLE: Environment artist')).replace(/\s+/g, ' ');

  it('works in a short process, and says when to ask Kiln and when to build with parts', () => {
    expect(text).toMatch(/a brief .* → the level designer's blockout, whose lanes, cover, spawns and heights you never move \(ask\) → lighting_set .* → the map's pieces → assembly → dressing → effects → look → check/);
    // 1.13: the map players see is Kiln's, in separate pieces the artist assembles on the graybox (not one layout request, not parts and terrain).
    expect(text).toMatch(/The map players see is Kiln's, in separate pieces that you assemble/);
    expect(text).toMatch(/fit or match one Kiln family on the game's style sheet \(kiln_request \{family, models, sockets\}/);
    expect(text).toMatch(/hide the graybox \(Transparency 1, collision kept where a piece has none\)/);
    expect(text).toMatch(/A map that was built in Kiln as a layout project still comes in whole with\s+kiln_layout_import/);
    expect(text).toMatch(/screenshots at gameplay camera height .* look_analyze with the mood and the target as a region/);
    expect(text).toMatch(/map_audit \{area, step\}/);
  });

  it('hands the level designer and the VFX artist what they need', () => {
    expect(text).toMatch(/to the level designer, cover the audit flags, blockers you added, lanes your art narrowed/);
    expect(text).toMatch(/to the VFX artist \(skill roblox-vfx: weather, ambient effects\), anchor parts, mood, palette/);
    expect(ROLES['level-designer']!.instructions).toMatch(/You own the layout and its cover; the environment artist owns how it looks/);
  });

  it('briefs Kiln and checks deliveries without Blender; the level designer still leaves Kiln to others', () => {
    const hidden = hiddenToolsFor(role)!;
    for (const t of ['kiln_request', 'kiln_builds', 'kiln_import', 'model_view']) expect(hidden.has(t), t).toBe(false);
    for (const t of ['blender_python', 'blender_render', 'audio_sfx', 'vfx_create', 'animation_create']) expect(hidden.has(t), t).toBe(true);
    expect(hiddenToolsFor(ROLES['level-designer']!)!.has('kiln_request')).toBe(true);
    expect(hiddenToolsFor(ROLES.modeler!)!.has('kiln_request')).toBe(false);
  });

  it('the critic measures map looks too, also when Studio is not drawing', () => {
    expect(ROLES.critic!.instructions.replace(/\s+/g, ' ')).toMatch(/measure them with look_analyze \(a target at range must separate/);
    expect(ROLES.critic!.instructions.replace(/\s+/g, ' ')).toMatch(/look_analyze on the screenshots that exist/);
  });
});

describe('the tools the skill relies on', () => {
  const makeCore = coreHarness();
  it('are all registered', async () => {
    const { core } = await makeCore({ respond: async () => ({}) });
    for (const t of meta.required_tools as string[]) expect(core.tools.get(t), t).toBeTruthy();
  });
});
