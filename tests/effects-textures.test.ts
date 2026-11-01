import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXTURE_REF } from '@shared/effects';
import { contactSheet, makeTexture, TEXTURE_KINDS, type TextureKind } from '@core/effects/textures';
import { analysisLine, analyzeTexture } from '@core/effects/textures/analyze';
import { gridFor } from '@core/effects/textures/generators';
import { TextureLibrary } from '@core/effects/textures/library';
import { decodePng, type RgbaImage } from '@core/modeling/png';

const kinds = Object.keys(TEXTURE_KINDS) as TextureKind[];
const alphaAt = (img: RgbaImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3]! / 255;

describe('the texture generator', () => {
  it('draws every kind: something in it, white under the alpha, no dark fringe, a look-alike named', () => {
    for (const kind of kinds) {
      const info = TEXTURE_KINDS[kind];
      const t = makeTexture(kind, {}, { size: 128, frames: 1 });
      const img = decodePng(t.png);
      expect([img.width, img.height], kind).toEqual([t.width, t.height]);
      expect(Math.max(t.width, t.height), kind).toBe(128);
      expect(t.grid, kind).toBe(1);
      expect(t.analysis.coverage, kind).toBeGreaterThan(0.02);
      expect(t.analysis.peakAlpha, kind).toBeGreaterThan(0.3);
      // Transparent texels carry the edge's colour, never black.
      expect(t.analysis.darkFringe, kind).toBe(0);
      // Textures are white (the emitter's Color tints them); a vignette is the one dark by design.
      if (kind !== 'vignette') expect(t.analysis.lightness, kind).toBeGreaterThan(0.45);
      expect(t.line, kind).toMatch(/^covers \d+% · edges /);
      expect(info.description.length, kind).toBeGreaterThan(10);
      expect(info.fallback === '' || TEXTURE_REF.test(info.fallback), kind).toBe(true);
      // The picture agents look at: three panels (on black, on a checker, tinted).
      const preview = decodePng(t.preview);
      expect(preview.width, kind).toBeGreaterThan(img.width * 3);
    }
  }, 120_000);

  it('is the same for the same seed and parameters, and changes with them', () => {
    const a = makeTexture('smoke', {}, { size: 128, frames: 1, seed: 5 });
    const b = makeTexture('smoke', {}, { size: 128, frames: 1, seed: 5 });
    const c = makeTexture('smoke', {}, { size: 128, frames: 1, seed: 6 });
    expect(a.png.equals(b.png)).toBe(true);
    expect(a.png.equals(c.png)).toBe(false);
    const thin = makeTexture('ring', { width: 0.02 }, { size: 128 });
    const thick = makeTexture('ring', { width: 0.2 }, { size: 128 });
    expect(thick.analysis.coverage).toBeGreaterThan(thin.analysis.coverage * 1.5);
    // The ring is a ring: clear in the middle, drawn at its radius.
    const ring = decodePng(makeTexture('ring', { radius: 0.4, width: 0.06, inner: 0 }, { size: 128 }).png);
    expect(alphaAt(ring, 64, 64)).toBeLessThan(0.05);
    const row = Array.from({ length: 64 }, (_, i) => alphaAt(ring, 64 + i, 64));
    const peak = row.indexOf(Math.max(...row));
    expect(Math.max(...row)).toBeGreaterThan(0.5);
    expect(peak).toBeGreaterThan(12);
    expect(peak).toBeLessThan(60);
    // A wider radius puts the band further out.
    const wide = decodePng(makeTexture('ring', { radius: 0.45, width: 0.06, inner: 0 }, { size: 128 }).png);
    const wideRow = Array.from({ length: 64 }, (_, i) => alphaAt(wide, 64 + i, 64));
    expect(wideRow.indexOf(Math.max(...wideRow))).toBeGreaterThan(peak);
    expect(alphaAt(ring, 2, 2)).toBe(0);
  });

  it('makes flipbooks whose frames stay inside their cells and follow each other', () => {
    expect([1, 4, 16, 64].map(gridFor)).toEqual([1, 2, 4, 8]);
    const smoke = makeTexture('smoke', {}, { frames: 16 });
    expect(smoke.grid).toBe(4);
    expect(smoke.width).toBe(512);
    expect(smoke.analysis.cellBorder).toBeLessThanOrEqual(0.02);
    expect(smoke.analysis.continuity!).toBeGreaterThan(0.6);
    // It thins out: the last frame covers less than the first.
    expect(smoke.analysis.coverageFirstLast![1]).toBeLessThan(smoke.analysis.coverageFirstLast![0]);
    expect(smoke.line).toMatch(/frame-to-frame [\d.]+/);
    const fire = makeTexture('fire', {}, { frames: 16 });
    expect(fire.line).toMatch(/loop seam/);
    expect(fire.problems.filter((p) => /loop doesn't close/.test(p))).toEqual([]);
    // Variants (a Random flipbook) are not frames in time.
    const chips = makeTexture('debris', {}, { frames: 4 });
    expect(chips.grid).toBe(2);
    expect(chips.line).toMatch(/variants for a Random flipbook/);
    // An 8x8 flipbook keeps 64 px cells at least: 1024 wide.
    expect(makeTexture('smoke', {}, { frames: 64, size: 256 }).width).toBeGreaterThanOrEqual(512);
  }, 120_000);

  it('makes strips for beams and trails that tile end to end', () => {
    const strip = makeTexture('trail', {}, { size: 256 });
    expect(strip.width).toBeGreaterThan(strip.height);
    expect(strip.line).toMatch(/tiles seamlessly/);
    expect(strip.problems).toEqual([]);
    expect(makeTexture('energy', { shape: 'tile' }, { size: 256 }).line).toMatch(/tiles/);
  });

  it('snaps sizes to what Roblox handles and refuses an unknown kind', () => {
    expect(makeTexture('glow', {}, { size: 300 }).width).toBe(256);
    expect(makeTexture('glow', {}, { size: 5000 }).width).toBe(1024);
    expect(() => makeTexture('lava' as TextureKind)).toThrow(/Unknown texture kind "lava"\. Kinds: soft, glow/);
  });

  it('reads a texture the way an artist would', () => {
    // A hard white square touching its cell: the border is flagged; a dark one: it can only darken.
    const square = (v: number, inset: number): RgbaImage => {
      const data = new Uint8Array(64 * 64 * 4);
      for (let y = inset; y < 64 - inset; y++) for (let x = inset; x < 64 - inset; x++) data.set([v, v, v, 255], (y * 64 + x) * 4);
      return { width: 64, height: 64, data };
    };
    const full = analyzeTexture(square(255, 0));
    expect(full.coverage).toBe(1);
    expect(full.cellBorder).toBe(1);
    expect(full.edgeSoftness).toBe(0);
    expect(analysisLine(full, 'soft', { strip: false }).problems.join(' ')).toMatch(/touch their cell border/);
    const dark = analyzeTexture(square(40, 8));
    expect(dark.lightness).toBeLessThan(0.1);
    expect(analysisLine(dark, 'smoke', { strip: false }).problems.join(' ')).toMatch(/texture itself is dark/);
    expect(analysisLine(analyzeTexture(square(255, 30)), 'soft', { strip: false }).problems.join(' ')).toMatch(/Almost nothing is drawn/);
    const sheet = contactSheet(square(255, 8));
    expect(sheet.width).toBeGreaterThan(64 * 3);
  });
});

describe('the texture library', () => {
  it('keeps a texture beside its image, resolves it to its upload or its stand-in, and removes both', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-texlib-'));
    const lib = new TextureLibrary(root);
    const made = makeTexture('star', {}, { size: 128 });
    lib.save({ name: 'HitStar', kind: 'star', params: {}, size: 128, file: 'assets/vfx/HitStar.png', analysis: made.line, fallback: made.fallback }, made.png);
    expect(lib.names()).toEqual(['HitStar']);
    expect(existsSync(join(root, 'assets', 'vfx', 'HitStar.png'))).toBe(true);
    expect(lib.resolve('HitStar')).toEqual({ id: made.fallback, uploaded: false });
    lib.update('HitStar', { imageId: '123456789' });
    expect(lib.resolve('HitStar')).toEqual({ id: 'rbxassetid://123456789', uploaded: true });
    expect(lib.resolve('Nope')).toBeNull();
    expect(() => lib.save({ name: 'bad name', kind: 'star', params: {}, size: 64, file: 'x.png', fallback: '' })).toThrow(/letters, digits and _/);
    expect(lib.remove('HitStar')).toBe(true);
    expect(lib.names()).toEqual([]);
    expect(existsSync(join(root, 'assets', 'vfx', 'HitStar.png'))).toBe(false);
  });
});
