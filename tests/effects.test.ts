import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { textureRefs, validateEffect, type EffectSpec } from '@shared/effects';
import { buildEffect, listEffectPresets } from '@core/effects/presets';
import { EXAMPLES, exampleEffect, listExamples } from '@core/effects/examples';
import { compileEffect } from '@core/effects/compile';
import { measureEffect } from '@core/effects/measure';
import { EffectStore, effectsBuilder, FX_RUNTIME_FILES, FX_RUNTIME_MODULE, motionFromSkill } from '@core/effects/effects-service';
import { TextureLibrary } from '@core/effects/textures/library';
import { CutsceneStore } from '@core/effects/cutscenes';

const motion = () => motionFromSkill(readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-ui-motion', 'SKILL.md'), 'utf8'));

describe('effect presets and examples', () => {
  it('are all valid and cover every kind', () => {
    const list = listEffectPresets();
    expect(list.length).toBeGreaterThanOrEqual(14);
    for (const p of list) expect(validateEffect(buildEffect(p.id, p.id)), p.id).toEqual([]);
    expect(new Set(list.map((p) => p.kind))).toEqual(new Set(['burst', 'persistent', 'trail', 'beam']));
  });

  it('take colors, scale and intensity', () => {
    const base = buildEffect('HitSpark', 'Hit');
    const big = buildEffect('HitSpark', 'Hit', { color: '#00ff00', scale: 2, intensity: 2 });
    const sparks = (e: EffectSpec) => e.emitters!.find((m) => m.name === 'Sparks')!;
    expect(sparks(big).size[0]).toBeCloseTo(sparks(base).size[0]! * 2, 5);
    expect(sparks(big).emit).toBe((sparks(base).emit ?? 0) * 2);
    expect(sparks(big).color[0]).toBe('#00ff00');
    expect(sparks(buildEffect('HitSpark', 'H', { scale: 100 })).size[0]).toBeCloseTo(sparks(base).size[0]! * 4, 5);
    expect(sparks(buildEffect('HitSpark', 'H', { color: 'red' })).color[0]).toBe(sparks(base).color[0]);
    expect(() => buildEffect('Nope', 'X')).toThrow(/Unknown effect preset/);
  });

  it('the worked examples are valid timelines that read the way the skill teaches', () => {
    expect(listExamples().map((e) => e.id)).toEqual(Object.keys(EXAMPLES));
    for (const id of Object.keys(EXAMPLES)) {
      const e = exampleEffect(id, id)!;
      expect(validateEffect(e), id).toEqual([]);
      const m = measureEffect(e);
      // No example piles into a blob, fills the view or is too heavy for phones.
      expect(m.warnings.filter((w) => /blob|fills|heavy|opaque/.test(w)), id).toEqual([]);
    }
    // The impact lands on the first frame; the lightning only after its anticipation.
    expect(measureEffect(exampleEffect('FireballImpact', 'F')!).timing.impactAt).toBe(0);
    expect(measureEffect(exampleEffect('LightningStrike', 'L')!).timing.impactAt).toBeCloseTo(0.35, 2);
  });
});

describe('validation', () => {
  it('explains what is wrong', () => {
    const bad = { name: 'x y', kind: 'burst', emitters: [{ name: 'E', texture: 'http://x', color: ['blue'], size: [], transparency: [2], lifetime: [1, 0], speed: [0, 0] }] } as unknown as EffectSpec;
    const p = validateEffect(bad).join('\n');
    expect(p).toMatch(/name must be/);
    expect(p).toMatch(/texture must be rbxasset/);
    expect(p).toMatch(/hex colors/);
    expect(p).toMatch(/size needs 1–8 values/);
    expect(p).toMatch(/transparency values must be between 0 and 1/);
    expect(p).toMatch(/lifetime/);
    expect(p).toMatch(/a burst needs emit/);
    const base = buildEffect('HitSpark', 'Boom');
    const heavy: EffectSpec = { ...base, emitters: base.emitters!.map((m) => ({ ...m, emit: 300 })) };
    expect(validateEffect(heavy).join('\n')).toMatch(/too many for mobile/);
    expect(validateEffect(buildEffect('Explosion', 'Boom', { intensity: 3 }))).toEqual([]);
  });

  it('checks tracks, curves, eases and texture names', () => {
    const e = {
      name: 'T',
      kind: 'burst',
      tracks: [
        { type: 'wobble' },
        { type: 'shell', shape: 'sphere', transparency: { keys: [[0, 0], [2, 1]] } },
        { type: 'ring', radius: { keys: [[0, 1], [1, 8]], ease: 'bouncy' } },
        { type: 'slash', texture: 'tex:my slash' },
        { type: 'spawn', effect: 'T' },
        { type: 'debris', count: 300 },
        { type: 'shell', shape: 'mesh' },
      ],
    } as unknown as EffectSpec;
    const p = validateEffect(e).join('\n');
    expect(p).toMatch(/track 1 \(wobble\): type must be one of/);
    expect(p).toMatch(/key times run 0..1/);
    expect(p).toMatch(/unknown ease "bouncy"/);
    expect(p).toMatch(/texture must be .*tex:<Name>/);
    expect(p).toMatch(/can't spawn itself/);
    expect(p).toMatch(/debris count must be 1–40/);
    expect(p).toMatch(/mesh shell needs meshId/);
    expect(validateEffect({ name: 'T', kind: 'burst', tracks: [{ type: 'flash' }, { type: 'slash', texture: 'tex:Crescent' }] } as EffectSpec)).toEqual([]);
    expect(textureRefs({ name: 'T', kind: 'burst', tracks: [{ type: 'slash', texture: 'tex:Crescent' }, { type: 'ribbon', path: { kind: 'arc', radius: 3, from: 0, to: 90 }, trail: { texture: 'tex:Streak' } }] } as EffectSpec)).toEqual(['Crescent', 'Streak']);
  });
});

describe('compiling and measuring', () => {
  it('turns the particle shorthands into emitters with the right Roblox settings', () => {
    const { emitters, tracks } = compileEffect({
      name: 'C',
      kind: 'burst',
      tracks: [
        { type: 'ring', at: 0.1, duration: 0.3, radius: [1, 8] },
        { type: 'slash', rotation: [0, 0, 35], size: [6, 8], flipbook: { layout: 'Grid4x4' } },
        { type: 'flash' },
        { type: 'light', at: 0.2 },
        { type: 'shell', shape: 'sphere', at: 0.05 },
      ],
    });
    const ring = emitters.find((m) => m.name === 'Ring1')!;
    expect(ring).toMatchObject({ orientation: 'VelocityPerpendicular', direction: 'Top', speed: [0.01, 0.01], emit: 1, lifetime: [0.3, 0.3], delay: 0.1, lightEmission: 1 });
    expect(ring.size).toEqual([[0, 2], [1, 16]]); // diameter = 2 × radius
    const slash = emitters.find((m) => m.name === 'Slash2')!;
    expect(slash.turn).toEqual([0, 0, 35]);
    expect(slash.flipbook).toEqual({ layout: 'Grid4x4', mode: 'OneShot' });
    expect(emitters.find((m) => m.name === 'Flash3')).toMatchObject({ zOffset: 1, lightEmission: 1 });
    expect(tracks.map((t) => t.type)).toEqual(['shell', 'light']); // ordered by start
  });

  it('catches the explosion smoke that turned into a black blob in a real build', () => {
    // MechExplosion's first smoke: dark brown-grey, 0.3 transparent, 16 puffs up to 9 studs, lit by the scene.
    const blob: EffectSpec = {
      name: 'MechExplosion',
      kind: 'burst',
      emitters: [{ name: 'Smoke', texture: 'rbxasset://textures/particles/explosion01_smoke_main.dds', color: ['#5a524c', '#2d2926'], size: [3, 9], transparency: [0.3, 1], lifetime: [1.2, 2], speed: [3, 8], spread: [180, 180], emit: 16, delay: 0.05, drag: 2, acceleration: [0, 3, 0], lightInfluence: 1 }],
    };
    const bad = measureEffect(blob);
    expect(bad.warnings.join('\n')).toMatch(/Smoke: dark .* opaque black blob/);
    // The fix the build had to make: a lighter grey that starts see-through.
    const fixed = measureEffect({ ...blob, emitters: [{ ...blob.emitters![0]!, color: ['#a39a92', '#8a8178'], transparency: [0.6, 1] }] });
    expect(fixed.warnings.join('\n')).not.toMatch(/blob/);
    expect(fixed.coverage.centerOpacity).toBeLessThan(bad.coverage.centerOpacity);
  });

  it('measures counts per quality level, reach, timing, and flags a slow, heavy hit', () => {
    const m = measureEffect(buildEffect('HitSpark', 'HitSpark'));
    expect(m.particles.perPlay).toBe(18);
    expect(m.particles.byQuality.low).toBeLessThan(m.particles.byQuality.medium);
    expect(m.particles.byQuality.high).toBe(18);
    expect(m.bounds.radius).toBeGreaterThan(2);
    expect(m.timing.impactAt).toBe(0);
    expect(m.line).toMatch(/18 particles \(low \d+ \/ medium \d+ \/ high 18\)/);
    const late: EffectSpec = { name: 'SwordHit', kind: 'burst', duration: 3, emitters: [{ name: 'Glow', texture: 'rbxasset://textures/particles/forcefield_glow_main.dds', color: ['#ffffff'], size: [2, 3], transparency: [0, 1], lifetime: [0.1, 0.2], speed: [0, 0], emit: 1, delay: 0.2, lightEmission: 1 }] };
    const w = measureEffect(late).warnings.join('\n');
    expect(w).toMatch(/long for a hit/);
    expect(w).toMatch(/first bright beat \(Glow\) comes at 0.2 s/);
  });
});

describe('builder and runtime', () => {
  it('generates templates for every kind, with timelines, keyed sequences and textures resolved', () => {
    const fireball = exampleEffect('FireballImpact', 'FireballImpact')!;
    const slash: EffectSpec = { name: 'Cut', kind: 'burst', tracks: [{ type: 'slash', texture: 'tex:Crescent', flipbook: { layout: 'Grid4x4' }, rotation: [0, 0, 30] }, { type: 'decal', texture: 'tex:Scorch', duration: 3 }] };
    const code = effectsBuilder([...['HitSpark', 'Fire', 'SlashTrail', 'EnergyBeam'].map((id) => buildEffect(id, id)), fireball, slash], {
      texture: (n) => (n === 'Crescent' ? 'rbxassetid://123' : 'rbxasset://textures/particles/explosion01_smoke_main.dds'),
      textures: { Crescent: 'rbxassetid://123' },
      cutscenes: [{ name: 'Intro', shots: [{ duration: 3, camera: { points: [[0, 10, 0], [10, 10, 0]] } }] }],
    });
    expect(code).toContain('name="HitSpark",kind="burst"');
    expect(code).toContain('rate=30');
    expect(code).toContain('trail={color={"#ffffff","#ff7a1a"}');
    expect(code).toContain('beam={color=');
    expect(code).toContain('Instance.new("RemoteEvent")');
    expect(code).toMatch(/name="FireballImpact",kind="burst",duration=[\d.]+,radius=[\d.]+/);
    expect(code).toContain('timeline=[==[[{"type":"shell"');
    expect(code).toContain('size={{0,0.5},{1,0}}'); // keyed sequences (FireballImpact's embers)
    expect(code).toContain('texture="rbxassetid://123"'); // tex: resolved
    expect(code).toContain('flipbook={layout="Grid4x4",mode="OneShot"}');
    expect(code).toContain('turn={0,0,30}');
    expect(code).toContain('"texture":"rbxasset://textures/particles/explosion01_smoke_main.dds"'); // in the timeline JSON
    expect(code).toContain('local TEXTURES = {["Crescent"]="rbxassetid://123"}');
    expect(code).toContain('{name="Intro",json=[==[');
    expect(FX_RUNTIME_MODULE).toContain('remote:FireAllClients(cue, a, b, o)');
  });

  it('keeps effect files, the builder, the runtime modules, Motion and the client relay in the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-fx-'));
    const store = new EffectStore(root);
    store.save({ effect: buildEffect('HitSpark', 'SwordHit'), preset: 'HitSpark' });
    store.save({ effect: buildEffect('SlashTrail', 'BladeTrail'), preset: 'SlashTrail' });
    expect(store.names()).toEqual(['BladeTrail', 'SwordHit']);
    expect(readFileSync(join(root, 'world/Effects.luau'), 'utf8')).toContain('name="SwordHit"');
    const rt = store.ensureRuntime(undefined, motion());
    expect(rt.written).toEqual([...FX_RUNTIME_FILES.map((f) => `src/Shared/${f.module}.luau`), 'src/Client/ShurikenEffects.client.luau', 'src/Shared/Motion.luau']);
    expect(rt.motion).toBe('written');
    expect(rt.files).toContain('src/Shared/Motion.luau');
    expect(readFileSync(join(root, rt.clientFile), 'utf8')).toContain('require(game.ReplicatedStorage.Shared.ShurikenEffects).listen()');
    expect(store.ensureRuntime(undefined, motion()).written).toEqual([]);
    // An older generated module is replaced; a hand-replaced one (no marker) is left alone.
    writeFileSync(join(root, 'src/Shared/ShurikenEffects.luau'), '--!strict\n-- ShurikenEffects v3 (generated by Shuriken Studio; safe to use, don\'t edit).\nreturn {}\n');
    writeFileSync(join(root, 'src/Shared/ShurikenCurves.luau'), '-- my own curves\nreturn {}\n');
    expect(store.ensureRuntime(undefined, motion()).written).toEqual(['src/Shared/ShurikenEffects.luau']);
    expect(EffectStore.runtimeLocation({ 'code/shared': 'ReplicatedStorage/Modules', 'code/client': 'StarterPlayer/StarterPlayerScripts' })).toMatchObject({
      file: 'code/shared/ShurikenEffects.luau',
      requirePath: 'game.ReplicatedStorage.Modules.ShurikenEffects',
      clientFile: 'code/client/ShurikenEffects.client.luau',
      shared: 'game.ReplicatedStorage.Modules',
    });
    expect(store.remove('SwordHit')).toBe(true);
    expect(store.remove('BladeTrail')).toBe(true);
    expect(existsSync(join(root, 'world/Effects.luau'))).toBe(false);
  });

  it('gives hand-written files a time, lists broken files with why, and finds the scripts that play each effect', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-fx-'));
    mkdirSync(join(root, 'effects'), { recursive: true });
    // An agent wrote this one by hand: no updatedAt.
    writeFileSync(join(root, 'effects', 'Spark.fx.json'), JSON.stringify({ effect: buildEffect('HitSpark', 'Spark') }));
    const when = new Date('2026-09-30T12:00:00Z');
    utimesSync(join(root, 'effects', 'Spark.fx.json'), when, when);
    writeFileSync(join(root, 'effects', 'Torn.fx.json'), '{ "effect": ');
    writeFileSync(join(root, 'effects', 'Wrong.fx.json'), JSON.stringify({ effect: { name: 'Wrong', kind: 'burst', emitters: [] } }));
    writeFileSync(join(root, 'effects', 'Aura2.fx.json'), JSON.stringify({ effect: buildEffect('Aura', 'Aura2'), updatedAt: '2026-10-01T00:00:00.000Z' }));
    const store = new EffectStore(root);
    expect(store.get('Spark')!.updatedAt).toBe(when.toISOString());
    expect(store.all().map((f) => f.effect.name)).toEqual(['Aura2', 'Spark']);
    const broken = store.broken();
    expect(broken.map((b) => b.name)).toEqual(['Torn', 'Wrong']);
    expect(broken[0]!.problems[0]).toMatch(/not valid JSON/);
    expect(broken[1]!.problems.join(' ')).toMatch(/needs emitters or tracks/);
    mkdirSync(join(root, 'src', 'Server'), { recursive: true });
    mkdirSync(join(root, 'src', 'Client'), { recursive: true });
    writeFileSync(join(root, 'src', 'Server', 'Combat.server.luau'), 'local Effects = require(game.ReplicatedStorage.Shared.ShurikenEffects)\nEffects.play("Spark", hit)\n');
    writeFileSync(join(root, 'src', 'Client', 'Aura.client.luau'), 'local fx = require(game.ReplicatedStorage.Shared.ShurikenEffects)\nlocal NAME = "Aura2"\nfx.attach(NAME, root)\n');
    writeFileSync(join(root, 'src', 'Client', 'Other.client.luau'), 'print("Spark")\n');
    const usage = store.usage(undefined);
    expect(usage.get('Spark')).toEqual(['src/Server/Combat.server.luau']);
    expect(usage.get('Aura2')).toEqual(['src/Client/Aura.client.luau']);
  });

  it('writes uploaded textures and cutscenes into the builder; nothing at all leaves no builder', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-fx-'));
    const lib = new TextureLibrary(root);
    lib.save({ name: 'Crescent', kind: 'slash', params: {}, size: 256, file: 'assets/vfx/Crescent.png', fallback: 'rbxasset://textures/particles/explosion01_shockwave_main.dds' }, Buffer.from('png'));
    const store = new EffectStore(root);
    store.save({ effect: { name: 'Cut', kind: 'burst', tracks: [{ type: 'slash', texture: 'tex:Crescent' }] } });
    expect(readFileSync(join(root, 'world/Effects.luau'), 'utf8')).toContain('texture="rbxasset://textures/particles/explosion01_shockwave_main.dds"');
    lib.update('Crescent', { imageId: '987654', decalId: '987655' });
    new CutsceneStore(root).save({ name: 'Intro', shots: [{ duration: 2, camera: { points: [[0, 5, 0], [5, 5, 0]] } }] });
    const code = store.writeBuilder();
    expect(code).toContain('texture="rbxassetid://987654"');
    expect(code).toContain('local TEXTURES = {["Crescent"]="rbxassetid://987654"}');
    expect(code).toContain('{name="Intro",json=');
    store.remove('Cut');
    expect(existsSync(join(root, 'world/Effects.luau'))).toBe(true); // the texture attribute and the cutscene remain
  });
});
