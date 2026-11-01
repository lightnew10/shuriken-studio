import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIGHTING_MARKER, LIGHTING_PRESETS, PRESET_NAMES, lightingAdjustSchema, lightingBuilderLuau, mergeAdjust, resolveLighting } from '@core/look/lighting-presets';
import { LUAURC, SELENE_TOML } from '@core/projects/project-service';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '@core/roblox/luau-toolchain';
import type { CallerContext } from '@core/capabilities/tool-registry';
import { coreHarness } from './helpers/make-core';

// Lighting presets as data (core/look/lighting-presets.ts): starting points the environment artist adapts, applied
// through a generated world builder so the look is code on disk.
describe('the lighting presets', () => {
  it('a small set by time of day and mood, each with an intent, what to adapt, a look_analyze target and its source', () => {
    expect(PRESET_NAMES.length).toBeGreaterThanOrEqual(6);
    expect(PRESET_NAMES.length).toBeLessThanOrEqual(10);
    for (const n of PRESET_NAMES) {
      const p = LIGHTING_PRESETS[n];
      expect(p.intent.length, n).toBeGreaterThan(30);
      expect(p.adapt.length, n).toBeGreaterThan(30);
      expect(p.expect.medianL[0], n).toBeLessThan(p.expect.medianL[1]);
      expect(p.source, n).toMatch(/checked in Studio|not yet measured in Studio/);
      const look = resolveLighting(n);
      expect(look.lighting.ClockTime, n).toBeTypeOf('number');
      // Gameplay presets never blur the play space.
      expect(look.depthOfField, n).toBe(false);
    }
    // Only what was looked at in Studio says so.
    expect(PRESET_NAMES.filter((n) => /checked in Studio/.test(LIGHTING_PRESETS[n].source))).toEqual(['sunny_cartoon']);
    // The dusk preset carries the 2026-10-01 lesson: a neutral grade (the warm one measured monochrome).
    const dusk = resolveLighting('dusk_haze');
    expect(dusk.colorCorrection && dusk.colorCorrection.TintColor).toEqual([250, 248, 246]);
    expect(LIGHTING_PRESETS.dusk_haze.expect.note).toMatch(/77-92% orange/);
  });

  it('adjustments merge property by property, false removes a piece, colours may be hex', () => {
    const adj = lightingAdjustSchema.parse({ atmosphere: { Density: 0.2 }, bloom: false, lighting: { Ambient: '#405060' } });
    const look = resolveLighting('dusk_haze', adj);
    expect(look.atmosphere).toMatchObject({ Density: 0.2, Haze: 0.9, Offset: 0.08 });
    expect(look.bloom).toBe(false);
    expect(look.lighting.Ambient).toEqual([0x40, 0x50, 0x60]);
    expect(look.lighting.ClockTime).toBe(17.4);
    // A section the preset turned off comes back when adjusted.
    expect(resolveLighting('overcast', { sunRays: { Intensity: 0.02 } }).sunRays).toEqual({ Intensity: 0.02 });
    // Refining keeps the earlier adjustments.
    expect(mergeAdjust({ atmosphere: { Density: 0.2 } }, { atmosphere: { Haze: 0.5 } })).toEqual({ atmosphere: { Density: 0.2, Haze: 0.5 } });
    expect(lightingAdjustSchema.safeParse({ atmosphere: { Density: 3 } }).success).toBe(false);
    expect(lightingAdjustSchema.safeParse({ lighting: { LightingStyle: 'Future' } }).success).toBe(false);
  });

  it('the generated builder owns Lighting, one of each effect, keeps a Sky and reports what it could not set', () => {
    const code = lightingBuilderLuau(resolveLighting('night_moon'), 'night_moon');
    expect(code.startsWith(LIGHTING_MARKER)).toBe(true);
    expect(code).toContain('local LOOK: { [string]: any } = {');
    expect(code).toMatch(/Ambient = \{ 34, 36, 52 \},/);
    expect(code).toContain('if c:IsA(e.class) then\n\t\t\tc:Destroy()');
    expect(code).toContain('local sky: Instance = Lighting:FindFirstChildOfClass("Sky") or Instance.new("Sky")');
    expect(code).toContain('table.insert(skipped');
    expect(code).not.toMatch(/Technology/);
  });
});

const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

describe.skipIf(!available)('the generated lighting builders', () => {
  it('pass selene and strict luau-lsp for every preset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-lighting-lint-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    mkdirSync(join(root, 'src', 'Server'), { recursive: true });
    for (const n of PRESET_NAMES) writeFileSync(join(root, 'src/Server', `${n}.server.luau`), `--!strict\n${lightingBuilderLuau(resolveLighting(n), n)}`);
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    expect(r.problems.map((p) => `${p.tool} ${p.file}:${p.line} ${p.code} ${p.message}`)).toEqual([]);
  }, 120_000);
});

describe('lighting_set, the tool', () => {
  const makeCore = coreHarness();

  it('writes the data and the builder, refines without a preset, and leaves a hand-written builder alone', async () => {
    const { core, root } = await makeCore({ respond: async () => ({}) });
    const caller = (role: string): CallerContext => ({ kind: 'agent', runId: 'run_x', taskId: null, role, providerId: null, allowedTools: null });
    const artist = caller('environment-artist');

    const list = await core.tools.invoke('lighting_set', { list: true }, artist);
    expect(Object.keys(out(list).data as object)).toEqual(PRESET_NAMES);

    mkdirSync(join(root, 'world'), { recursive: true });
    writeFileSync(join(root, 'world', 'Lighting.luau'), 'local Lighting = game:GetService("Lighting")\nLighting.ClockTime = 6\n');
    const refused = await core.tools.invoke('lighting_set', { preset: 'dusk_haze' }, artist);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/hand-written builder.*replace_existing/);

    const first = await core.tools.invoke('lighting_set', { preset: 'dusk_haze', adjust: { atmosphere: { Density: 0.22 } }, replace_existing: true }, artist);
    expect(first.isError).toBeFalsy();
    expect(text(first)).toMatch(/look_analyze \{mood: "dusk"\}/);
    const data = JSON.parse(readFileSync(join(root, 'world', 'Lighting.json'), 'utf8'));
    expect(data).toMatchObject({ preset: 'dusk_haze', adjust: { atmosphere: { Density: 0.22 } }, look: { atmosphere: { Density: 0.22, Haze: 0.9 } }, expect: { mood: 'dusk' } });
    expect(readFileSync(join(root, 'world', 'Lighting.luau'), 'utf8').startsWith(LIGHTING_MARKER)).toBe(true);

    // No preset: refine the current one; the generated builder is replaced without asking.
    const second = await core.tools.invoke('lighting_set', { adjust: { atmosphere: { Haze: 0.6 }, sunRays: false } }, artist);
    expect(second.isError).toBeFalsy();
    const data2 = JSON.parse(readFileSync(join(root, 'world', 'Lighting.json'), 'utf8'));
    expect(data2.look.atmosphere).toMatchObject({ Density: 0.22, Haze: 0.6 });
    expect(data2.look.sunRays).toBe(false);

    const bad = await core.tools.invoke('lighting_set', { adjust: { atmosphere: { Density: 3 } } }, artist);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Invalid adjust: atmosphere/);

    expect(core.tools.visibleTo(caller('level-designer')).some((t) => t.name === 'lighting_set')).toBe(true);
    expect(core.tools.visibleTo(caller('roblox-engineer')).some((t) => t.name === 'lighting_set')).toBe(false);
  });
});

const out = (o: { data?: unknown }) => o;
const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('\n');
