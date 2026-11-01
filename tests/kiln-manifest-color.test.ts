import { describe, expect, it } from 'vitest';
import { colorOf, parseManifest } from '../src/core/modeling/kiln-manifest';

/**
 * Kiln 0.8.7 exports one-colour materials plain by default (no colour image, which drew grey in Roblox and made 26
 * of 58 fix turns in three days). Its plain material was first described with `color: [r, g, b]`; Shuriken has read
 * "#rrggbb". Both are read.
 */
describe('a plain material from Kiln', () => {
  it('reads its colour as hex or as a list', () => {
    expect(colorOf('#E8C39E')).toBe('#e8c39e');
    expect(colorOf([232, 195, 158])).toBe('#e8c39e');
    expect(colorOf([1, 0.5, 0])).toBe('#ff8000');
    expect(colorOf('e8c39e')).toBeNull();
    expect(colorOf([1, 2])).toBeNull();
    expect(colorOf([-1, 0, 0])).toBeNull();
  });

  it('is plain with its colour, from either form', () => {
    const { manifest } = parseManifest({ version: 1, materials: [{ name: 'Palette_e8c39e', plain: true, color: [232, 195, 158], roblox_material: null, maps: {} }, { name: 'Roof', plain: true, color: '#C04030', maps: {} }] }, null);
    expect(manifest.materials.map((m) => [m.name, m.plain, m.color, m.robloxMaterial])).toEqual([
      ['Palette_e8c39e', true, '#e8c39e', null],
      ['Roof', true, '#c04030', null],
    ]);
  });
});
