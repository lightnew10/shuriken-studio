import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TEXTURES as T, type EffectSpec } from '@shared/effects';
import { EffectStore, type EffectFile } from '@core/effects/effects-service';
import { VFX_WAIT } from '@core/capabilities/effects-tools';
import { applySet, deriveEffect, effectColors, mainHue, recolor } from '@core/effects/variants';
import { measureEffect } from '@core/effects/measure';
import { decodePng } from '@core/modeling/png';
import type { Core } from '@core/core';
import { coreHarness } from './helpers/make-core';

const makeCore = coreHarness();
const quick = VFX_WAIT.quickMs;
afterEach(() => {
  VFX_WAIT.quickMs = quick;
});

const pickup: EffectSpec = {
  name: 'Pickup',
  kind: 'burst',
  tracks: [
    { type: 'flash', name: 'Pop', duration: 0.1, size: [2, 5], color: ['#ffffff', '#fff1b0'] },
    { type: 'ring', name: 'Ring', duration: 0.3, radius: [1, 6], color: '#ffc428' },
    { type: 'particles', name: 'Streaks', texture: T.spark, color: ['#fff1b0', '#ff9a1a'], size: [0.6, 0], transparency: [0, 1], lifetime: [0.3, 0.5], speed: [15, 25], spread: [180, 180], emit: 14, lightEmission: 1 },
    { type: 'light', name: 'Glow', duration: 0.3, color: '#ffc428', brightness: [5, 0], range: 14 },
  ],
};

type Output = { isError?: boolean; data?: unknown; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
const data = <T>(o: Output) => o.data as T;
const text = (o: Output) => o.content.map((c) => c.text ?? `[${c.type}]`).join('\n');
const image = (o: Output) => o.content.find((c) => c.type === 'image');
const invoke = (core: Core, name: string, args: unknown) => core.invokeTool(name, args, 'ui') as Promise<Output>;

/** A stand-in Studio: connected, and it runs the effects builder (reporting every effect built). */
function fakeStudio(core: Core): { runs: string[] } {
  const runs: string[] = [];
  Object.defineProperty(core.studio, 'connected', { get: () => true });
  const studio = core.studio as unknown as Record<string, unknown>;
  studio.availability = () => ({ ok: true });
  studio.runLuau = async (code: string) => {
    runs.push(code);
    const names = [...code.matchAll(/^ {2}\{name="([^"]+)"/gm)].map((m) => m[1]!);
    return { ok: true, output: JSON.stringify({ built: names, failed: [], notes: [] }), durationMs: 1 };
  };
  return { runs };
}

describe('vfx_create: the picture and what it says', () => {
  it('returns the contact sheet with the look read off it, and saves the effect', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const out = await invoke(core, 'vfx_create', { spec: pickup });
    expect(out.isError, text(out)).toBeFalsy();
    const body = data<{ name: string; analysis: { line: string; warnings: string[]; timeline: string[]; look: { sheet: string; coverage: { peak: number }; byDay: { shows: string; againstSky: string }; inTheDark: { readsAs: string }; layers: string[]; notes: string[] } } }>(out);
    expect(body.name).toBe('Pickup');
    expect(body.analysis.look.sheet).toMatch(/Frames at 0\.02, .* s, left to right; top row by day over grass, bottom row on a dark stage\. Seen from [\d.]+ studs/);
    expect(body.analysis.look.coverage.peak).toBeGreaterThan(0.01);
    expect(body.analysis.look.byDay.againstSky).toMatch(/^\d+%$/);
    expect(body.analysis.look.inTheDark.readsAs).toMatch(/^#[0-9a-f]{6}$/);
    expect(body.analysis.look.layers.join(' ')).toMatch(/Ring: \d+% of it, shows \d+% by day \/ \d+% in the dark \/ \d+% against sky/);
    expect(body.analysis.look.notes.join(' ')).toMatch(/Lighting and Bloom are approximated/);
    const png = decodePng(Buffer.from(image(out)!.data!, 'base64'));
    expect([png.width, png.height]).toEqual([1564, 396]);
    expect(image(out)!.mimeType).toBe('image/png');
    expect(existsSync(join(root, 'effects', 'Pickup.fx.json'))).toBe(true);
    // No picture when it isn't wanted.
    const plain = await invoke(core, 'vfx_create', { spec: pickup, sheet: false });
    expect(image(plain)).toBeUndefined();
    expect(data<{ analysis: Record<string, unknown> }>(plain).analysis.look).toBeUndefined();
  }, 60_000);

  it('vfx_measure looks at an effect by name or a draft spec, at your own times, and saves nothing', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const draft = await invoke(core, 'vfx_measure', { spec: { ...pickup, name: 'Draft' }, times: [0.05, 0.2] });
    expect(data<{ look: { sheet: string } }>(draft).look.sheet).toMatch(/Frames at 0\.05, 0\.2 s/);
    expect(decodePng(Buffer.from(image(draft)!.data!, 'base64')).width).toBe(2 * 260 + 4);
    expect(existsSync(join(root, 'effects'))).toBe(false);
    const example = await invoke(core, 'vfx_measure', { name: 'FireballImpact' });
    expect(data<{ duration: number; warnings: string[] }>(example).duration).toBeGreaterThan(1);
    expect(image(example)).toBeDefined();
    expect(image(await invoke(core, 'vfx_measure', { name: 'FireballImpact', sheet: false }))).toBeUndefined();
    // A spec that isn't valid yet is measured without a picture, and says what is wrong.
    const broken = await invoke(core, 'vfx_measure', { spec: { name: 'B', kind: 'burst', tracks: [{ type: 'wobble' }] } });
    expect(data<{ problems: string[] }>(broken).problems.join(' ')).toMatch(/type must be one of/);
    expect(image(broken)).toBeUndefined();
  }, 60_000);
});

describe('vfx_create: changing and varying an effect without sending it again', () => {
  it('changes by path: a field, a track by name or number, removing and adding', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    await invoke(core, 'vfx_create', { spec: pickup, sheet: false });
    const out = await invoke(core, 'vfx_create', {
      name: 'Pickup',
      set: { 'tracks.Ring.radius': [1, 9], 'tracks.3.emit': 20, 'tracks.Glow': null, duration: 1.5, 'tracks.Rim': { type: 'circle', duration: 0.2, radius: [2, 5] } },
      sheet: false,
    });
    expect(out.isError, text(out)).toBeFalsy();
    const saved = (JSON.parse(readFileSync(join(root, 'effects', 'Pickup.fx.json'), 'utf8')) as EffectFile).effect;
    expect(saved.duration).toBe(1.5);
    expect(saved.tracks!.map((t) => t.name)).toEqual(['Pop', 'Ring', 'Streaks', 'Rim']);
    expect((saved.tracks![1] as { radius: number[] }).radius).toEqual([1, 9]);
    expect((saved.tracks![2] as { emit: number }).emit).toBe(20);
    expect(saved.tracks![3]!.type).toBe('circle');
    // A path that leads nowhere says what is there; nothing is saved.
    const bad = await invoke(core, 'vfx_create', { name: 'Pickup', set: { 'tracks.Smoke.size': [1] }, sheet: false });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/nothing named "Smoke" in tracks \(it has Pop, Ring, Streaks, Rim\)/);
    // A change that makes the effect invalid is refused with the validator's words.
    const invalid = await invoke(core, 'vfx_create', { name: 'Pickup', set: { 'tracks.Ring.color': 'red' }, sheet: false });
    expect(text(invalid)).toMatch(/color must be a hex colour/);
    expect((JSON.parse(readFileSync(join(root, 'effects', 'Pickup.fx.json'), 'utf8')) as EffectFile).effect.duration).toBe(1.5);
  }, 60_000);

  it('makes a colour variant that follows its base', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    await invoke(core, 'vfx_create', { spec: pickup, sheet: false });
    const made = await invoke(core, 'vfx_create', { from: 'Pickup', name: 'Pickup_Rage', to: '#ff3a28', set: { 'tracks.Streaks.emit': 20 }, sheet: false });
    expect(made.isError, text(made)).toBeFalsy();
    expect(data<{ variantOf: string; colors: string[] }>(made).variantOf).toBe('Pickup');
    const store = new EffectStore(root);
    const rage = () => store.get('Pickup_Rage')!;
    expect(rage().variantOf).toEqual({ base: 'Pickup', to: '#ff3a28', set: { 'tracks.Streaks.emit': 20 } });
    const colors = effectColors(rage().effect);
    // The gold became red; the white-hot core stayed white.
    expect(colors).toContain('#ffffff');
    expect(colors).not.toContain('#ffc428');
    const hue = mainHue(rage().effect)!;
    expect(Math.min(hue, 360 - hue)).toBeLessThan(12);
    expect((rage().effect.tracks![2] as { emit: number }).emit).toBe(20);
    // The base changes: the variant is made again from it, in its own colours, with its own changes.
    const changed = await invoke(core, 'vfx_create', { name: 'Pickup', set: { 'tracks.Ring.duration': 0.5 }, sheet: false });
    expect(data<{ variantsUpdated: string[] }>(changed).variantsUpdated).toEqual(['Pickup_Rage']);
    expect(rage().effect.tracks![1]!.duration).toBe(0.5);
    expect((rage().effect.tracks![2] as { emit: number }).emit).toBe(20);
    expect(effectColors(rage().effect)).not.toContain('#ffc428');
    // Changing the variant itself adds to its recipe, so it still follows.
    await invoke(core, 'vfx_create', { name: 'Pickup_Rage', set: { 'tracks.Pop.duration': 0.2 }, sheet: false });
    expect(rage().variantOf!.set).toEqual({ 'tracks.Streaks.emit': 20, 'tracks.Pop.duration': 0.2 });
    await invoke(core, 'vfx_create', { name: 'Pickup', set: { duration: 2 }, sheet: false });
    expect(rage().effect.duration).toBe(2);
    expect(rage().effect.tracks![0]!.duration).toBe(0.2);
    const listed = data<{ effects: Array<{ name: string; variantOf?: string }> }>(await invoke(core, 'vfx_list', {}));
    expect(listed.effects.find((e) => e.name === 'Pickup_Rage')!.variantOf).toBe('Pickup');
    // Sending the variant whole makes it its own effect again.
    await invoke(core, 'vfx_create', { spec: { ...rage().effect }, sheet: false });
    expect(rage().variantOf).toBeUndefined();
  }, 60_000);
});

describe('recolouring and changes by path', () => {
  it('turns the hue toward a colour and keeps light and dark; swaps exact colours', () => {
    expect(Math.round(mainHue(pickup)!)).toBeGreaterThan(30);
    expect(Math.round(mainHue(pickup)!)).toBeLessThan(50);
    const cyan = recolor(pickup, { to: '#3ce1ff' });
    const hue = mainHue(cyan)!;
    expect(hue).toBeGreaterThan(180);
    expect(hue).toBeLessThan(200);
    expect(effectColors(cyan)).toContain('#ffffff');
    expect(pickup.tracks![1]).toMatchObject({ color: '#ffc428' });
    const swapped = recolor(pickup, { palette: { '#ffc428': '#00ff00', FF9A1A: '#112233' } });
    expect((swapped.tracks![1] as { color: string }).color).toBe('#00ff00');
    expect((swapped.tracks![2] as { color: string[] }).color).toEqual(['#fff1b0', '#112233']);
    expect((recolor(pickup, { hue: 120 }).tracks![1] as { color: string }).color).not.toBe('#ffc428');
    // Names and texture references are not colours.
    const named = recolor({ ...pickup, name: 'Facade', description: '#ffc428' }, { hue: 90 });
    expect(named.name).toBe('Facade');
    expect(named.description).toBe('#ffc428');
    expect(mainHue({ name: 'W', kind: 'burst', tracks: [{ type: 'flash', color: '#ffffff' }] })).toBeNull();
  });

  it('applies changes to a copy, and says where a path fails', () => {
    const r = applySet(pickup, { 'tracks.Pop.size': [3, 6], 'light.color': '#ffffff', 'tracks.2.color': '#abcdef', 'emitters.Dust': { texture: T.puff, color: ['#888888'], size: [1], transparency: [0.5], lifetime: [1, 1], speed: [1, 2], emit: 3 } });
    expect(r.problems).toEqual([]);
    expect((r.effect.tracks![0] as { size: number[] }).size).toEqual([3, 6]);
    expect((pickup.tracks![0] as { size: number[] }).size).toEqual([2, 5]);
    expect(r.effect.light).toEqual({ color: '#ffffff' });
    expect((r.effect.tracks![1] as { color: string }).color).toBe('#abcdef');
    expect(r.effect.emitters![0]!.name).toBe('Dust');
    expect(applySet(pickup, { 'tracks.9.at': 1 }).problems[0]).toMatch(/nothing named "9"/);
    expect(applySet(pickup, { 'tracks.Nope': null }).problems[0]).toMatch(/nothing named "Nope" to remove/);
    expect(deriveEffect(pickup, 'P2', { hue: 30, set: { duration: 3 } }).effect).toMatchObject({ name: 'P2', duration: 3 });
  });
});

describe('Studio is busy', () => {
  it("saving an effect doesn't wait for another playtest; vfx_build builds what is pending", async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const { runs } = fakeStudio(core);
    VFX_WAIT.quickMs = 150;
    const store = new EffectStore(root);
    core.lease.tryAcquire('run_other');
    const t0 = Date.now();
    const out = await invoke(core, 'vfx_create', { spec: pickup, sheet: false });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.isError, text(out)).toBeFalsy();
    const body = data<{ built: boolean; pending?: boolean; note: string }>(out);
    expect(body.built).toBe(false);
    expect(body.pending).toBe(true);
    expect(body.note).toMatch(/NOT in the place yet: Studio is in a playtest.*run vfx_build once/);
    expect(runs).toEqual([]);
    expect(store.get('Pickup')).not.toBeNull();
    expect(store.builtInStudio()).toBe(false);
    expect(data<{ studio: string }>(await invoke(core, 'vfx_list', {})).studio).toMatch(/not built since the last change/);
    // The playtest ends: one build puts everything in the place.
    core.lease.release('run_other');
    const built = await invoke(core, 'vfx_build', {});
    expect(data<{ built: string[] }>(built).built).toEqual(['Pickup']);
    expect(runs).toHaveLength(1);
    expect(store.builtInStudio()).toBe(true);
    expect(data<{ studio: string }>(await invoke(core, 'vfx_list', {})).studio).toBe('built');
    // Free Studio: saving builds at once, as before.
    const again = await invoke(core, 'vfx_create', { name: 'Pickup', set: { duration: 1 }, sheet: false });
    expect(data<{ built: boolean; pending?: boolean }>(again)).toMatchObject({ built: true });
    expect(data<{ pending?: boolean }>(again).pending).toBeUndefined();
    expect(store.builtInStudio()).toBe(true);
  }, 60_000);
});

describe('vfx_texture', () => {
  it("lists a kind's parameters without making anything", async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    for (const args of [{ kind: 'ring', list: true }, { name: 'R', kind: 'ring', params: { __list: true } }, { name: 'R', kind: 'ring', params: { listParams: true } }, { kind: 'ring' }]) {
      const out = await invoke(core, 'vfx_texture', args);
      expect(out.isError, text(out)).toBeFalsy();
      const body = data<{ params: Record<string, string>; made: string }>(out);
      expect(Object.keys(body.params)).toEqual(expect.arrayContaining(['radius', 'width', 'softness']));
      expect(body.made).toMatch(/nothing/);
    }
    expect(existsSync(join(root, 'effects', 'textures'))).toBe(false);
    const made = await invoke(core, 'vfx_texture', { name: 'MyRing', kind: 'ring', params: { radius: 0.4 }, size: 128, upload: false });
    expect(made.isError, text(made)).toBeFalsy();
    expect(existsSync(join(root, 'assets', 'vfx', 'MyRing.png'))).toBe(true);
    // An effect that uses it is drawn with it.
    const fx = await invoke(core, 'vfx_create', { spec: { name: 'Shock', kind: 'burst', tracks: [{ type: 'ring', duration: 0.3, radius: [1, 8], texture: 'tex:MyRing' }] } });
    expect(data<{ analysis: { look: { notes: string[] } } }>(fx).analysis.look.notes).toHaveLength(1);
  }, 60_000);
});

describe('measuring', () => {
  it('judges a hit from 20 studs and an area effect from where it fits the view', () => {
    expect(measureEffect(pickup).coverage.at).toBe(20);
    const wave: EffectSpec = { name: 'Wave', kind: 'burst', tracks: [{ type: 'circle', duration: 1, radius: [10, 200], width: 6 }, { type: 'ring', duration: 1, radius: [10, 200] }] };
    const m = measureEffect(wave);
    expect(m.coverage.at).toBeGreaterThan(200);
    expect(m.line).toMatch(/of the view at \d+ studs/);
    expect(m.warnings.join(' ')).not.toMatch(/fills/);
  });

  it('warns that one-shot particle tracks never fire in an effect that stays on', () => {
    const aura: EffectSpec = { name: 'Aura', kind: 'persistent', emitters: [{ name: 'Motes', texture: T.sparkle, color: ['#ffffff'], size: [0.3], transparency: [0], lifetime: [1, 1], speed: [1, 2], rate: 8 }], tracks: [{ type: 'flash', name: 'Pop' }] };
    expect(measureEffect(aura).warnings.join(' ')).toMatch(/Pop: in an effect that stays on, particles need a rate/);
    expect(measureEffect({ ...aura, tracks: [] }).warnings.join(' ')).not.toMatch(/need a rate/);
  });
});
