import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXTURES as T, type EffectSpec, type TrackSpec } from '@shared/effects';
import { EffectSim } from '@shared/fx/sim';
import { lookFrom, STAGES } from '@shared/fx/stage';
import { contactSheet, renderFrame, renderStill, type LayerInk } from '@core/effects/render';
import { lookOf, lookWarnings } from '@core/effects/critique';
import { PreviewTextures } from '@core/effects/preview-textures';
import { TextureLibrary } from '@core/effects/textures/library';
import { makeTexture } from '@core/effects/textures';
import { decodePng } from '@core/modeling/png';
import { exampleEffect } from '@core/effects/examples';

const pictures = new PreviewTextures(null);
const textures = (ref: string) => pictures.get(ref);
const burst = (tracks: TrackSpec[], name = 'Test'): EffectSpec => ({ name, kind: 'burst', tracks });
const glow = (over: Record<string, unknown> = {}): TrackSpec => ({ type: 'particles', name: 'Glow', texture: T.glow, color: ['#7fe8ff'], size: [6], transparency: [0.2], lifetime: [1, 1], speed: [0, 0], emit: 1, lightEmission: 1, ...over }) as TrackSpec;

describe('the software renderer', () => {
  it('draws a contact sheet: a row per stage, a frame per time, the first frame first', () => {
    const sheet = contactSheet(exampleEffect('FireballImpact', 'F')!, { textures });
    expect(sheet.stages).toEqual(['day', 'dark']);
    expect(sheet.times).toHaveLength(6);
    expect(sheet.times[0]).toBe(0.02);
    expect([...sheet.times]).toEqual([...sheet.times].sort((a, b) => a - b));
    // Six 256 × 192 frames with 4 px between them, two rows.
    expect([sheet.image.width, sheet.image.height]).toEqual([6 * 260 + 4, 2 * 196 + 4]);
    expect(sheet.coverage.peak).toBeGreaterThan(0.03);
    expect(sheet.coverage.perFrame).toHaveLength(6);
    // The frames spread over what the effect shows, not over its long faint tail.
    expect(sheet.times[5]!).toBeLessThan(2.6);
    expect(sheet.layers.map((l) => l.name)).toEqual(expect.arrayContaining(['Fireball', 'Shock', 'Smoke', 'Embers']));
    expect(sheet.distance).toBeGreaterThan(10);
    // The day row is brighter than the dark one.
    const mean = (y0: number) => {
      let sum = 0;
      for (let y = y0; y < y0 + 192; y++) for (let x = 4; x < 260; x++) sum += sheet.image.data[(y * sheet.image.width + x) * 4 + 1]!;
      return sum / (192 * 256);
    };
    expect(mean(4)).toBeGreaterThan(mean(200) + 40);
  });

  it('takes your own times, and one stage', () => {
    const sheet = contactSheet(exampleEffect('SwordSlash', 'S')!, { textures, times: [0.3, 0.05], stages: ['dark'] });
    expect(sheet.times).toEqual([0.05, 0.3]);
    expect([sheet.image.width, sheet.image.height]).toEqual([2 * 260 + 4, 196 + 4]);
    expect(lookOf(sheet).sheet).toMatch(/Frames at 0.05, 0.3 s.*on a dark stage/);
  });

  it('is the same picture every time', () => {
    const spec = exampleEffect('LightningStrike', 'L')!;
    const a = renderStill(spec, 0.4, { textures, size: [160, 120] });
    const b = renderStill(spec, 0.4, { textures, size: [160, 120] });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(a.data.some((v, i) => i % 4 === 0 && v > 200)).toBe(true);
  });

  it('measures what each layer puts on the picture: glow adds less to a bright background', () => {
    const sheet = contactSheet(burst([glow(), glow({ name: 'Soot', color: ['#201a16'], lightEmission: 0, transparency: [0.3], offset: [9, 0, 0] })]), { textures });
    const g = sheet.layers.find((l) => l.name === 'Glow')!;
    const soot = sheet.layers.find((l) => l.name === 'Soot')!;
    expect(g.glows).toBe(true);
    expect(soot.glows).toBe(false);
    // Glow shows in the dark and far less against a bright sky; dark matter shows better by day.
    expect(g.shown[1]!).toBeGreaterThan(g.onSky! * 1.5);
    expect(soot.shown[0]!).toBeGreaterThan(soot.shown[1]! * 1.5);
    expect(soot.onSky!).toBeGreaterThan(soot.shown[1]! * 1.5);
    const read = (stage: string) => sheet.reads.find((r) => r.stage === stage)!;
    expect(read('dark').color).toMatch(/^#[0-9a-f]{6}$/);
    expect(sheet.authored).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('says what an artist would: glow that vanishes by day, parts burnt to white, layers that add nothing, nothing at all', () => {
    // Pale glows over each other: they show in the dark, and a bright sky has little left for them to add.
    const pale = contactSheet(burst([glow({ name: 'Sheath', color: ['#d8f1ff'], size: [8], transparency: [0.4], emit: 6 })]), { textures });
    expect(lookWarnings(pale).join(' ')).toMatch(/Against a bright sky only \d+% of it shows \(\d+% in the dark\); Sheath \d+%/);
    // Forty bright glows on one spot: white.
    const hot = contactSheet(burst([glow({ name: 'Core', color: ['#ffd070'], emit: 40, brightness: 3, transparency: [0] })]), { textures });
    expect(lookWarnings(hot).join(' ')).toMatch(/\d+% of it is burnt out to pure white/);
    expect(hot.reads.find((r) => r.stage === 'dark')!.whiteOut).toBeGreaterThan(0.3);
    // A second glow under one that is already white adds nothing.
    const wasted = contactSheet(burst([glow({ name: 'Core', color: ['#ffffff'], emit: 10, brightness: 3, transparency: [0], zOffset: -1 }), glow({ name: 'Extra', color: ['#ffffff'], size: [4], transparency: [0.5], zOffset: 2, emit: 6 })]), { textures, stages: ['dark'] });
    expect(lookWarnings(wasted).join(' ')).toMatch(/Core draws the same pixels \d+ times over, and only \d+% of that shows/);
    expect(lookWarnings(wasted).join(' ')).toMatch(/Extra adds almost nothing you can see/);
    expect(wasted.layers.find((l) => l.name === 'Core')!.overdraw).toBeGreaterThan(8);
    const silent = contactSheet(burst([{ type: 'sound', sound: 'Boom' }]), { textures });
    expect(silent.coverage.peak).toBe(0);
    expect(lookWarnings(silent).join(' ')).toMatch(/Nothing shows in any frame/);
    // A well-made example draws no such warning.
    expect(lookWarnings(contactSheet(exampleEffect('SwordSlash', 'S')!, { textures }))).toEqual([]);
  });

  it('hides what is behind solid parts and under the floor, and blooms what is brighter than white', () => {
    const cam = lookFrom([0, 3, 20], [0, 3, 0]);
    const ink = (spec: EffectSpec, name: string, at: [number, number, number] = [0, 3, 0]) => {
      const layers = new Map<string, LayerInk>();
      const c = renderFrame(new EffectSim(spec, { at, floor: 0 }).frame(), { width: 160, height: 120, camera: cam, stage: STAGES.dark, textures, layers });
      return { ink: layers.get(name)?.ink ?? 0, canvas: c };
    };
    const open = ink(burst([glow({ offset: [0, 0, -4] })]), 'Glow').ink;
    const blocked = ink(burst([glow({ offset: [0, 0, -4] }), { type: 'shell', name: 'Wall', shape: 'block', size: [30, 30, 1], duration: 1, transparency: 0, material: 'Plastic' }]), 'Glow').ink;
    expect(open).toBeGreaterThan(50);
    expect(blocked).toBeLessThan(open * 0.02);
    // Half of a sprite at floor height is under the floor.
    const above = ink(burst([glow()]), 'Glow').ink;
    const sunk = ink(burst([glow()]), 'Glow', [0, 0, 0]).ink;
    expect(sunk).toBeGreaterThan(above * 0.3);
    expect(sunk).toBeLessThan(above * 0.7);
    // Brightness 4 spills light past the sprite's own edge; brightness 1 doesn't.
    const edge = (brightness: number) => {
      const c = ink(burst([glow({ color: ['#ffffff'], size: [4], transparency: [0], brightness, texture: 'rbxasset://textures/particles/SquareParticle.png' })]), 'Glow').canvas;
      // A pixel just outside the square (2 studs from the centre is its edge; this is ~2.6 studs out).
      const x = Math.round(80 + (2.6 / (20 * Math.tan((20 * Math.PI) / 180))) * 60);
      return c.rgb[(60 * 160 + x) * 3]!;
    };
    expect(edge(4)).toBeGreaterThan(edge(1) + 0.05);
  });
});

describe('pictures of textures', () => {
  it("draws look-alikes for Roblox's built-in textures, and says what it can't read", () => {
    for (const ref of Object.values(T)) {
      const t = pictures.get(ref);
      expect(t.note, ref).toBeUndefined();
      expect(t.image.width, ref).toBeGreaterThanOrEqual(16);
      expect(t.image.data.some((v, i) => i % 4 === 3 && v > 100), ref).toBe(true);
    }
    expect(pictures.get('rbxassetid://123456').note).toMatch(/can't be read here/);
    expect(pictures.get('tex:Missing').note).toMatch(/has no texture in this project/);
  });

  it("reads the game's own textures by name and by uploaded id, and stamps them", () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-fxtex-'));
    const made = makeTexture('ring', {}, { size: 128 });
    new TextureLibrary(root).save({ name: 'MyRing', kind: 'ring', params: {}, size: 128, file: 'assets/vfx/MyRing.png', fallback: made.fallback, imageId: '555000111' }, made.png);
    const own = new PreviewTextures(root);
    expect(own.get('tex:MyRing').note).toBeUndefined();
    expect(own.get('tex:MyRing').image.width).toBe(128);
    expect(own.get('rbxassetid://555000111').image.width).toBe(128);
    const sent = own.dataUrl('tex:MyRing');
    expect(decodePng(Buffer.from(sent.url!.split(',')[1]!, 'base64')).width).toBe(128);
    // The same stamp: the picture doesn't travel again; new pixels: it does.
    expect(own.dataUrl('tex:MyRing', sent.stamp).url).toBeUndefined();
    writeFileSync(join(root, 'assets', 'vfx', 'MyRing.png'), makeTexture('ring', { radius: 0.3 }, { size: 64 }).png);
    const again = new PreviewTextures(root).dataUrl('tex:MyRing', sent.stamp === 'x' ? undefined : 'file:0');
    expect(again.url).toBeDefined();
    expect(own.dataUrl(T.glow).stamp).toBe('built-in');
    // An effect that uses it is drawn with it: no note about a stand-in.
    const sheet = contactSheet(burst([{ type: 'ring', name: 'R', duration: 0.4, radius: [1, 8], texture: 'tex:MyRing' }, { type: 'flash', name: 'F', texture: 'rbxassetid://9' }]), { textures: (ref) => own.get(ref) });
    expect(sheet.notes).toEqual(["rbxassetid://9 is an image on Roblox that can't be read here: a soft glow stands in."]);
  });
});
