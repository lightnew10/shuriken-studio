import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ROBLOX_FONTS } from '../src/core/ui/ui-fonts';
import { ENUM_FONTS, findRobloxFonts, loadFont, measureFace, parseFont, placeLine, robloxFaceFor, robloxFonts, robloxLineMetrics, robloxMeasure, RobloxFontLibrary } from '../src/core/ui/lab/roblox-fonts';
import { layoutScreen, type UiNode } from '@shared/ui-layout';

// Roblox's own fonts from the Studio install on this machine (skipped where Studio isn't installed);
// SHURIKEN_ROBLOX_FONTS points at another content\fonts (or version) folder.
const lib = robloxFonts();
const node = (font: string, extra: Partial<UiNode> = {}): UiNode => ({ id: 1, name: 't', cls: 'TextLabel', font, ...extra });

// TextBounds read in Studio (Edit mode, no UIScale, 2026-10-09): [family, weight, TextSize, string, X, Y if not TextSize].
const STRINGS = ['Buy Golden Sword for 900 coins?', 'iiiii WWWWW 1,250', 'AVAWAY To. Te, Yo LT', 'Hamburgefonstiv 0123'];
const STUDIO: Array<[string, number, number, number, number, number?]> = [
  ['Inconsolata', 400, 14, 0, 217], ['Inconsolata', 400, 14, 1, 119], ['Inconsolata', 400, 28, 0, 434], ['Inconsolata', 400, 28, 1, 238], ['Inconsolata', 400, 48, 0, 713], ['Inconsolata', 400, 48, 1, 391],
  ['RobotoMono', 400, 14, 0, 217], ['RobotoMono', 400, 14, 1, 119], ['RobotoMono', 400, 28, 0, 403], ['RobotoMono', 400, 28, 1, 221], ['RobotoMono', 400, 48, 0, 682], ['RobotoMono', 400, 48, 1, 374],
  ['PressStart2P', 400, 14, 0, 248], ['PressStart2P', 400, 14, 1, 136], ['PressStart2P', 400, 28, 0, 496], ['PressStart2P', 400, 28, 1, 272], ['PressStart2P', 400, 48, 0, 837], ['PressStart2P', 400, 48, 1, 459],
  ['LegacyArial', 400, 14, 2, 194, 21], ['LegacyArial', 400, 14, 0, 291, 21], ['LegacyArial', 400, 28, 2, 382, 42], ['LegacyArial', 400, 28, 0, 571, 42], ['LegacyArial', 400, 48, 2, 647, 72], ['LegacyArial', 400, 48, 0, 971, 72],
  ['BuilderSans', 400, 12, 3, 107], ['BuilderSans', 400, 12, 2, 98], ['BuilderSans', 400, 12, 0, 154], ['BuilderSans', 400, 12, 1, 85],
  ['BuilderSans', 400, 24, 3, 199], ['BuilderSans', 400, 24, 2, 181], ['BuilderSans', 400, 24, 0, 293], ['BuilderSans', 400, 24, 1, 161],
  ['BuilderSans', 400, 60, 3, 493], ['BuilderSans', 400, 60, 2, 442], ['BuilderSans', 400, 60, 0, 725], ['BuilderSans', 400, 60, 1, 402],
  ['BuilderSans', 700, 18, 3, 162], ['BuilderSans', 700, 18, 2, 150], ['BuilderSans', 700, 18, 0, 238], ['BuilderSans', 700, 18, 1, 140],
  ['BuilderSans', 700, 36, 3, 316], ['BuilderSans', 700, 36, 2, 290], ['BuilderSans', 700, 36, 0, 457], ['BuilderSans', 700, 36, 1, 271],
  ['GothamSSm', 400, 18, 2, 163], ['GothamSSm', 400, 18, 0, 257], ['GothamSSm', 400, 36, 2, 317], ['GothamSSm', 400, 36, 0, 500],
  ['GothamSSm', 700, 24, 2, 231], ['GothamSSm', 700, 24, 0, 355], ['GothamSSm', 700, 60, 2, 557], ['GothamSSm', 700, 60, 0, 868],
  ['FredokaOne', 400, 14, 2, 131], ['FredokaOne', 400, 14, 0, 192], ['FredokaOne', 400, 48, 2, 428], ['FredokaOne', 400, 48, 0, 634],
  ['SourceSansPro', 600, 14, 3, 116], ['SourceSansPro', 600, 14, 0, 167], ['SourceSansPro', 600, 48, 3, 379], ['SourceSansPro', 600, 48, 0, 542],
  ['LuckiestGuy', 400, 28, 0, 477],
];

describe('finding the install', () => {
  it('honours SHURIKEN_ROBLOX_FONTS and is null for a folder without fonts', () => {
    expect(findRobloxFonts({ SHURIKEN_ROBLOX_FONTS: join(__dirname, 'no-such-folder') })).toBeNull();
    expect(findRobloxFonts({})).toBeNull(); // no LOCALAPPDATA, no override
    const here = findRobloxFonts();
    if (!here) return;
    expect(findRobloxFonts({ SHURIKEN_ROBLOX_FONTS: here.fonts })?.families).toBe(here.families);
    expect(findRobloxFonts({ SHURIKEN_ROBLOX_FONTS: join(here.fonts, '..', '..') })?.fonts).toBe(join(here.fonts, '..', '..', 'content', 'fonts'));
  });

  it('reads Enum.Font names, FontFace families and FontFace strings', () => {
    expect(parseFont('GothamBold')).toMatchObject({ family: 'GothamSSm', weight: 700, style: 'normal', known: true });
    expect(parseFont('Enum.Font.SourceSansItalic')).toMatchObject({ family: 'SourceSansPro', weight: 400, style: 'italic' });
    expect(parseFont('GothamSSm', true)).toMatchObject({ family: 'GothamSSm', weight: 700 });
    expect(parseFont('GothamBlack', true)).toMatchObject({ weight: 900 });
    expect(parseFont('BuilderSans', true, false, 600)).toMatchObject({ weight: 600 });
    expect(parseFont('rbxasset://fonts/families/FredokaOne.json')).toMatchObject({ family: 'FredokaOne', known: true });
    expect(parseFont('Font { Family = rbxasset://fonts/families/GothamSSm.json, Weight = Bold, Style = Italic }')).toMatchObject({ family: 'GothamSSm', weight: 700, style: 'italic' });
    expect(parseFont('rbxassetid://123')).toMatchObject({ family: 'BuilderSans', known: false });
    expect(parseFont(undefined)).toMatchObject({ family: 'BuilderSans', weight: 400, known: true });
  });
});

describe.skipIf(!lib)("Roblox's fonts from the Studio install", () => {
  const L = lib as RobloxFontLibrary;

  it('parses every font file and outlines its glyphs without throwing', () => {
    const files = L.files();
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const font = loadFont(f);
      expect(font, f).not.toBeNull();
      const step = font!.numGlyphs > 5000 ? 37 : 1;
      for (let g = 0; g < font!.numGlyphs; g += step) font!.glyphById(g);
    }
  });

  it("draws BuilderSans from its CFF outlines, with widths that match hmtx", () => {
    const face = robloxFaceFor('BuilderSans')!;
    expect(face.font.outlines).toBe('cff');
    for (const ch of 'AZaz09@&?') expect(face.glyph(ch.codePointAt(0)!).contours.length, ch).toBeGreaterThan(0);
    expect(face.glyph('O'.codePointAt(0)!).contours).toHaveLength(2);
    for (const file of ['BuilderSans-Regular.otf', 'BuilderSans-Bold.otf', 'AccanthisADFStd-Regular.otf', 'RomanAntique.otf']) {
      const font = loadFont(join(L.install.fonts, file))!;
      for (let g = 0; g < font.numGlyphs; g++) expect(font.charstringWidth(g), `${file} glyph ${g}`).toBeCloseTo(font.advanceOf(g), 3);
    }
  });

  it('kerns pairs through GPOS (BuilderSans, Montserrat) and the legacy kern table (Creepster)', () => {
    expect(robloxFaceFor('BuilderSans')!.kern(0x41, 0x56)).toBeLessThan(0); // AV
    expect(robloxFaceFor('BuilderSans')!.kern(0x54, 0x6f)).toBeLessThan(0); // To
    expect(robloxFaceFor('GothamBold')!.kern(0x41, 0x56)).toBeLessThan(0);
    const creepster = robloxFaceFor('Creepster')!;
    expect(creepster.font.kerning).toBe('kern');
    expect(creepster.kern(0x4c, 0x54)).toBeLessThan(0); // LT
    expect(robloxFaceFor('BuilderSans')!.kern(0x6f, 0x6f)).toBe(0);
  });

  it('picks the face Roblox draws each Enum.Font with, and says when it substitutes', () => {
    for (const names of Object.values(ROBLOX_FONTS))
      for (const name of names) {
        expect(ENUM_FONTS[name], name).toBeDefined();
        const req = parseFont(name, false, false, undefined, L.families.keys());
        expect(req.known, name).toBe(true);
        const face = robloxFaceFor(name)!;
        expect(face, name).not.toBeNull();
        // Every Enum.Font's own weight has a local file (Font.fromEnum faces ship with Studio).
        expect(face.exact, `${name}: ${face.why}`).toBe(true);
      }
    expect(robloxFaceFor('GothamBold')!.name).toBe('Montserrat-Bold.ttf');
    expect(robloxFaceFor('GothamSSm', true)!.name).toBe('Montserrat-Bold.ttf');
    expect(robloxFaceFor('Gotham')!.name).toBe('Montserrat-Regular.ttf');
    expect(robloxFaceFor('Arial')!.name).toBe('Arimo-Regular.ttf');
    expect(robloxFaceFor('Bodoni')!.name).toBe('AccanthisADFStd-Regular.otf');
    expect(robloxFaceFor('Fantasy')!.name).toBe('Balthazar-Regular.ttf');
    expect(robloxFaceFor('SciFi')!.name).toBe('zekton_rg.ttf');
    expect(robloxFaceFor('SourceSans', false, true)!.name).toBe('SourceSansPro-It.ttf');
    expect(robloxFaceFor('LegacyArial')!.sizeScale).toBe(1.5);
    // Cloud-only weights: Studio's own copy, else the nearest local weight; italic Roblox lacks is slanted.
    const semi = robloxFaceFor('BuilderSans', true, false, 600)!;
    expect([semi.name, semi.exact]).toEqual(['BuilderSans-SemiBold.otf', false]);
    const monoBold = robloxFaceFor('RobotoMono', true)!;
    expect([monoBold.name, monoBold.exact]).toEqual(['RobotoMono-Regular.ttf', false]);
    expect(robloxFaceFor('BuilderSans', false, true)!.synthItalic).toBe(true);
    expect(robloxFaceFor('rbxassetid://123')!.exact).toBe(false);
  });

  it('falls back through the install for characters a face lacks', () => {
    const face = robloxFaceFor('FredokaOne')!;
    expect(face.fontOf(0x65e5)?.name).toMatch(/CJK/); // 日
    expect(face.fontOf(0x1f600)?.name).toBe('TwemojiMozilla.ttf');
    expect(face.fontOf(0xe002)?.name).toBe('RobloxEmoji.ttf'); // the Robux glyph
    expect(face.fontOf(0x0e44)?.name).toMatch(/Thai/);
    expect(face.glyph(0x65e5).contours.length).toBeGreaterThan(0);
    expect(face.fontOf(0x10ffff)).toBeNull();
  });

  it("measures text as Roblox's TextBounds: monospaced faces exactly, the rest within a few pixels", () => {
    const errs: number[] = [];
    for (const [family, weight, size, s, x, y] of STUDIO) {
      const face = L.face(family, false, false, weight)!;
      const w = measureFace(face, STRINGS[s]!, size);
      if (/Inconsolata|RobotoMono|PressStart2P/.test(family)) expect(w, `${family} ${size} "${STRINGS[s]}"`).toBe(x);
      errs.push(Math.abs(w - x));
      expect(robloxLineMetrics(face, size).lineHeight).toBe(y ?? size);
    }
    expect(Math.max(...errs)).toBeLessThanOrEqual(8);
    expect(errs.reduce((t, e) => t + e, 0) / errs.length).toBeLessThan(2.5);
    // The four TextBounds pinned in ui-layout.test.ts (kit shop, bold = BuilderSansBold): within 2%.
    const near = (v: number, want: number) => expect(Math.abs(v - want) / want).toBeLessThan(0.021);
    near(robloxMeasure('Buy Golden Sword for 900 coins?', 20, node('BuilderSans')), 256);
    near(robloxMeasure('Confirm purchase', 20, node('BuilderSans', { bold: true })), 140);
    near(robloxMeasure('Golden Sword', 18, node('BuilderSans', { bold: true })), 99);
    near(robloxMeasure('SHOP', 32, node('BuilderSans', { bold: true })), 70);
  });

  it('is the sum of advances and kerning at size / (ascender − descender), snapped to whole pixels', () => {
    const face = robloxFaceFor('GothamBold')!;
    const text = 'AVAWAY To. Te, Yo LT 1,250';
    const k = 24 / (face.ascender - face.descender);
    let sum = 0;
    for (const ch of text) sum += face.advance(ch.codePointAt(0)!);
    expect(measureFace(face, text, 24, { kerning: false, pixels: false })).toBeCloseTo(sum * k, 6);
    let kern = 0;
    for (let i = 1; i < text.length; i++) kern += face.kern(text.charCodeAt(i - 1), text.charCodeAt(i));
    expect(kern).toBeLessThan(0);
    expect(measureFace(face, text, 24, { pixels: false })).toBeCloseTo((sum + kern) * k, 6);
    const snapped = measureFace(face, text, 24);
    expect(Number.isInteger(snapped)).toBe(true);
    const placed = placeLine(face, text, 24);
    expect(placed.width).toBe(snapped);
    expect(placed.x).toHaveLength([...text].length);
    expect(placed.x[1]!).toBeLessThan(face.advance(0x41) * k); // V tucked under A
    expect(Math.abs(snapped - (sum + kern) * k)).toBeLessThanOrEqual([...text].length);
    // Monotonic: bigger sizes and longer strings never measure narrower.
    let last = 0;
    for (let s = 8; s <= 80; s += 0.5) {
      const w = measureFace(face, text, s);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    last = 0;
    for (let i = 1; i <= text.length; i++) {
      const w = measureFace(face, text.slice(0, i), 24);
      expect(w).toBeGreaterThanOrEqual(last - 2); // a kerned pair can pull a glyph back
      last = w;
    }
  });

  it('places the baseline where Studio drew it (the ascender below the line top)', () => {
    // Line tops and baselines read off a Studio screenshot (TextYAlignment Center, LineHeight 1).
    const seen: Array<[string, number, number, number]> = [
      ['BuilderSans', 400, 20, 16],
      ['BuilderSans', 800, 44, 35],
      ['GothamSSm', 700, 26, 21],
      ['FredokaOne', 400, 40, 32.5],
      ['LuckiestGuy', 400, 36, 25.5],
      ['RobotoMono', 400, 18, 14.5],
    ];
    for (const [family, weight, size, baseline] of seen) {
      const m = robloxLineMetrics(L.face(family, false, false, weight)!, size);
      expect(Math.abs(m.baseline - baseline), family).toBeLessThanOrEqual(1);
      expect(m.ascent + m.descent).toBeCloseTo(size, 6);
    }
  });

  it('measures 10,000 short strings in well under 100 ms once warm', () => {
    const words = ['Coins', 'Buy', 'Rebirth', 'Level 12', 'x2 Boost', 'Settings', '1,250,000', 'Claim!', 'Daily Rewards', 'Shop'];
    const nodes = [node('BuilderSans'), node('GothamSSm', { bold: true }), node('FredokaOne'), node('LegacyArial')];
    let t = 0;
    for (let i = 0; i < 10_000; i++) t += robloxMeasure(words[i % 10]!, 14 + (i % 7), nodes[i % 4]!);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) t += robloxMeasure(words[i % 10]!, 14 + (i % 7), nodes[i % 4]!);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(t).toBeGreaterThan(0);
  });

  it('drives the layout engine as a Measure (AutomaticSize and TextScaled)', () => {
    const label: UiNode = node('BuilderSans', { name: 'Price', textSize: 20, text: 'Buy Golden Sword for 900 coins?', auto: 'X', size: [0, 10, 0, 30] });
    const scaled: UiNode = node('BuilderSans', { id: 3, name: 'Big', text: 'SHOP', scaled: true, bold: true, size: [0, 200, 0, 100] });
    const screen: UiNode = { id: 2, name: 'S', cls: 'ScreenGui', kids: [label, scaled] };
    const boxes = layoutScreen(screen, { w: 800, h: 600, topbar: 0 }, { measure: robloxMeasure });
    expect(boxes.find((b) => b.path === 'S.Price')!.w).toBe(robloxMeasure(label.text!, 20, label));
    // The biggest size whose width fits the 200-point box.
    const fs = boxes.find((b) => b.path === 'S.Big')!.fontSize;
    expect(robloxMeasure('SHOP', fs, scaled)).toBeLessThanOrEqual(200.5);
    expect(robloxMeasure('SHOP', fs + 1, scaled)).toBeGreaterThan(200.5);
  });
});
