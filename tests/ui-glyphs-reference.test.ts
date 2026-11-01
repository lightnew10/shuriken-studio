import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drawGlyph, glyphName, glyphSet, glyphSheet, searchGlyphs, svgPath } from '../src/core/ui/ui-glyphs';
import { shapeImages, SHAPE_PX } from '../src/core/ui/ui-shapes';
import { compareWithReference, samplePalette, themeFrom } from '../src/core/ui/ui-reference';
import { fontFor, fontStyle, ROBLOX_FONTS } from '../src/core/ui/ui-fonts';
import type { RgbaImage } from '../src/core/modeling/png';

// Icons without Studio (line-art glyphs bundled with the app), panel shapes as the images the game builds them
// from, and a reference picture the user attached read into colours and compared with a mockup.

const set = glyphSet(resolve(__dirname, '..', 'resources'))!;
const alpha = (img: RgbaImage, x: number, y: number) => img.data[(Math.floor(y) * img.width + Math.floor(x)) * 4 + 3]!;

describe('glyphs', () => {
  it('ships Lucide with its licence, and finds glyphs by name, alias and game word', () => {
    expect(set.source).toMatch(/lucide-react .* \(ISC\)/);
    expect(Object.keys(set.icons).length).toBeGreaterThan(1500);
    expect(glyphName(set, 'alarm-check')).toBe('alarm-clock-check');
    expect(searchGlyphs(set, 'missile')[0]).toBe('rocket');
    expect(searchGlyphs(set, 'energy')).toContain('zap');
    expect(searchGlyphs(set, 'trade')).toContain('arrow-left-right');
    expect(searchGlyphs(set, 'shopping cart')[0]).toBe('shopping-cart');
  });

  it('reads SVG paths, arc flags packed against numbers included', () => {
    // "a1.5 1.5 0 00-2.474-1.561": flags 0 and 0, then the end point.
    const [p] = svgPath('M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9');
    const pts = p!.pts;
    const arcEnd = pts.find((q) => Math.abs(q[0] - 13.44) < 0.01 && Math.abs(q[1] - 2.439) < 0.01);
    expect(arcEnd).toBeTruthy();
    expect(pts[pts.length - 1]).toEqual([expect.closeTo(4.44, 2), expect.closeTo(11.439, 2)]);
  });

  it('draws white lines on transparency, with an outline or a glow when asked', () => {
    const plus = drawGlyph(set.icons.plus!, 96);
    expect(plus.data[(48 * 96 + 48) * 4]).toBe(255);
    expect(alpha(plus, 48, 48)).toBe(255);
    expect(alpha(plus, 20, 20)).toBe(0);
    const outlined = drawGlyph(set.icons.plus!, 96, { outline: 0.05 });
    // Just outside the line: dark outline where the plain glyph is empty.
    const x = 53;
    expect(alpha(plus, x, 30)).toBeLessThan(40);
    expect(alpha(outlined, x, 30)).toBeGreaterThan(200);
    expect(outlined.data[(30 * 96 + x) * 4]!).toBeLessThan(60);
    const sheet = glyphSheet(set, ['rocket', 'zap', 'shield']);
    expect([sheet.width, sheet.height]).toEqual([3 * 96, 96 + 18]);
  });
});

describe('panel shapes as images', () => {
  it('draws a fill and an outline per stroke, sliced so cut corners keep their size', () => {
    const img = shapeImages({ cut: [12, 0, 12, 0] }, 200, 80, [
      { color: [0, 255, 255], t: 0, px: 2, text: false },
      { color: [0, 255, 255], t: 0.7, px: 1, text: false, pos: 'Inner' },
    ]);
    expect(img.pad).toBe(2);
    expect([img.fill.width, img.fill.height]).toEqual([(200 + 4) * SHAPE_PX, (80 + 4) * SHAPE_PX]);
    // The cut corner is empty, the middle full.
    expect(alpha(img.fill, (2 + 2) * SHAPE_PX, (2 + 2) * SHAPE_PX)).toBe(0);
    expect(alpha(img.fill, 100 * SHAPE_PX, 40 * SHAPE_PX)).toBe(255);
    // The outer outline lies outside the fill, the inner one inside.
    expect(alpha(img.lines[0]!.image, 100 * SHAPE_PX, 1 * SHAPE_PX)).toBeGreaterThan(200);
    expect(alpha(img.lines[0]!.image, 100 * SHAPE_PX, 40 * SHAPE_PX)).toBe(0);
    expect(alpha(img.lines[1]!.image, 100 * SHAPE_PX, 2.5 * SHAPE_PX)).toBeGreaterThan(200);
    // SliceCenter keeps the 12-point cut, the stroke and the margin in the corners.
    expect(img.slice[0]).toBeGreaterThanOrEqual((2 + 12) * SHAPE_PX);
    expect(img.slice[2]).toBeLessThan(img.fill.width - 2 * SHAPE_PX);
  });
});

describe('a reference picture', () => {
  /** A dark screen, a big blue panel, a small yellow accent. */
  const reference = (): RgbaImage => {
    const w = 400;
    const h = 225;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = x > 40 && x < 240 && y > 40 && y < 180 ? [40, 90, 220] : x > 300 && x < 330 && y > 20 && y < 50 ? [255, 210, 0] : [16, 18, 26];
        data.set([...c, 255], (y * w + x) * 4);
      }
    return { width: w, height: h, data };
  };

  it('samples its main colours and the small loud accents, and suggests a theme', () => {
    const p = samplePalette(reference());
    expect(p.main.map((c) => c.hex)).toEqual(expect.arrayContaining(['#10121a', '#285adc']));
    expect(p.accents.map((c) => c.hex)).toContain('#ffd200');
    const theme = themeFrom(p);
    expect(theme.bg).toBe('#10121a');
    expect(theme.accent).toBe('#ffd200');
  });

  it('compares a mockup with it: the same picture matches, a grey one lacks its colours', () => {
    const ref = reference();
    expect(compareWithReference(ref, ref).differences).toEqual([]);
    const grey: RgbaImage = { ...ref, data: ref.data.map((v, i) => (i % 4 === 3 ? 255 : 90)) };
    const cmp = compareWithReference(ref, grey);
    expect(cmp.differences.join(' ')).toMatch(/Accent #ffd200 .* has nothing close in the mockup/);
    expect(cmp.differences.join(' ')).toMatch(/greyer/);
    expect(cmp.measures.chroma[0]).toBeGreaterThan(cmp.measures.chroma[1]);
  });

  it('lists the fonts a game can use by look, and draws each with a stand-in', () => {
    expect(ROBLOX_FONTS.display).toContain('FredokaOne');
    expect(ROBLOX_FONTS.sans).toContain('BuilderSans');
    expect(fontStyle('LuckiestGuy')).toBe('display');
    expect(fontStyle('Michroma')).toBe('techno');
    expect(fontStyle('RobotoMono')).toBe('mono');
    // On Windows the stand-ins are the system's fonts; elsewhere text is drawn as blocks.
    const f = fontFor('FredokaOne');
    expect(f.standIn).toMatch(/Segoe UI Black|Arial Black|blocks/);
  });
});
