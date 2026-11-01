import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillMask, roundedRect, strokeOutline } from '../src/core/ui/ui-raster';
import { renderUi, richRuns, withState, type FontPicker } from '../src/core/ui/ui-render';
import { fontFor } from '../src/core/ui/ui-fonts';
import { projectImages, renderVersion, statesSheet } from '../src/core/ui/ui-pictures';
import { resolveVersion, type MockNode } from '../src/shared/ui-mockup';
import type { UiNode } from '../src/shared/ui-layout';
import type { RgbaImage } from '../src/core/modeling/png';
import { scifiVersion } from './fixtures/ui-mockup-scifi';

// Pictures of UI drawn in the core (no browser, no Studio): the mockup tools hand them to agents. Checked here by
// pixels at known places, not by comparing whole pictures.

const RULER = 22;
/** The colour at a point of the screen (points, scale 1 pictures with rulers). */
const at = (img: RgbaImage, x: number, y: number): [number, number, number] => {
  const i = ((RULER + Math.floor(y)) * img.width + RULER + Math.floor(x)) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
};
const near = (a: [number, number, number], b: [number, number, number], tol = 12) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
/** A screen with no kit and no inset (points are the phone's own). */
const screen = (kids: MockNode[]): UiNode[] => resolveVersion({ screens: [{ name: 'S', ignoreInset: true, kids }] }, 'phone').screens;
const draw = (kids: MockNode[], o: Parameters<typeof renderUi>[2] = {}) => renderUi(screen(kids), 'phone', { guides: false, scale: 1, ...o }).image;
/** What is behind the UI at a point (the backdrop alone). */
const blank = draw([]);
const BACK = (_img: RgbaImage, x: number, y: number) => at(blank, x, y);

describe('the rasteriser', () => {
  it('covers a shape exactly, half pixels at its edges', () => {
    const m = fillMask([roundedRect(2.5, 2.5, 10, 10)], { x: 0, y: 0, w: 20, h: 20 })!;
    const cov = (x: number, y: number) => m.a[(y - m.y0) * m.w + (x - m.x0)] ?? 0;
    expect(cov(7, 7)).toBeCloseTo(1, 3);
    expect(cov(2, 7)).toBeCloseTo(0.5, 3);
    expect(cov(12, 12)).toBeCloseTo(0.25, 3);
    expect(m.a.reduce((t, v) => t + v, 0)).toBeCloseTo(100, 2);
    // A band of 2 round a 10×10 square: its area is the outer rounded square minus the inner one.
    const band = fillMask(strokeOutline([roundedRect(5, 5, 10, 10)], 1), { x: 0, y: 0, w: 30, h: 30 })!;
    expect(band.a.reduce((t, v) => t + v, 0)).toBeGreaterThan(78);
    expect(band.a.reduce((t, v) => t + v, 0)).toBeLessThan(82);
  });
});

describe('a UI drawn as a picture', () => {
  it('is the device at its size with rulers and a caption, the element where the layout puts it', () => {
    const pic = renderUi(screen([{ name: 'Box', cls: 'Frame', pos: [0, 100, 0, 50], size: [0, 200, 0, 100], bg: '#ff0000' }]), 'phone', { scale: 1, caption: 'Phone' });
    expect([pic.image.width, pic.image.height]).toEqual([844 + RULER, 390 + RULER + 24]);
    expect(at(pic.image, 200, 100)).toEqual([255, 0, 0]);
    expect(at(pic.image, 99, 100)).not.toEqual([255, 0, 0]);
    expect(at(pic.image, 301, 100)).not.toEqual([255, 0, 0]);
    // A desktop is drawn at three quarters by default.
    expect(renderUi([], 'desktop').scale).toBe(0.75);
  });

  it('draws transparency, gradients (colour and fade), corners and strokes as Roblox does', () => {
    const img = draw([
      { name: 'Half', cls: 'Frame', pos: [0, 20, 0, 20], size: [0, 100, 0, 60], bg: '#ffffff', bgT: 0.5 },
      { name: 'Grad', cls: 'Frame', pos: [0, 140, 0, 20], size: [0, 200, 0, 60], bg: '#ffffff', gradient: { colors: [[0, '#ff0000'], [1, '#0000ff']] } },
      { name: 'Fade', cls: 'Frame', pos: [0, 360, 0, 20], size: [0, 200, 0, 60], bg: '#00ff00', gradient: { transp: [[0, 0], [1, 1]] } },
      { name: 'Round', cls: 'Frame', pos: [0, 20, 0, 120], size: [0, 100, 0, 100], bg: '#ffffff', corner: [0.5, 0] },
      { name: 'Out', cls: 'Frame', pos: [0, 160, 0, 120], size: [0, 100, 0, 100], bg: '#ffffff', stroke: { color: '#ff0000', px: 4 } },
      { name: 'In', cls: 'Frame', pos: [0, 300, 0, 120], size: [0, 100, 0, 100], bg: '#ffffff', stroke: { color: '#0000ff', px: 4, pos: 'Inner' } },
    ]);
    const back = BACK(img, 70, 50);
    // Half see-through: halfway between white and what is behind.
    const half = at(img, 70, 50);
    expect(half[0]).toBeGreaterThan(back[0] + 60);
    expect(half[0]).toBeLessThan(230);
    // The gradient multiplies white: red at the left, blue at the right.
    expect(near(at(img, 142, 50), [255, 0, 0], 20)).toBe(true);
    expect(near(at(img, 337, 50), [0, 0, 255], 20)).toBe(true);
    // A fade: green at the left, the backdrop at the right.
    expect(near(at(img, 362, 50), [0, 255, 0], 20)).toBe(true);
    expect(near(at(img, 558, 50), BACK(img, 558, 50), 12)).toBe(true);
    // A circle: its box's corner shows what is behind.
    expect(near(at(img, 22, 122), BACK(img, 22, 122), 6)).toBe(true);
    expect(at(img, 70, 170)).toEqual([255, 255, 255]);
    // UIStroke is outside the box unless it says Inner.
    expect(near(at(img, 158, 170), [255, 0, 0], 30)).toBe(true);
    expect(at(img, 163, 170)).toEqual([255, 255, 255]);
    expect(near(at(img, 302, 170), [0, 0, 255], 30)).toBe(true);
    expect(near(at(img, 297, 170), BACK(img, 297, 170), 12)).toBe(true);
  });

  it('turns an element and its children about its centre, and clips to ClipsDescendants', () => {
    const img = draw([
      { name: 'Bar', cls: 'Frame', pos: [0, 100, 0, 150], size: [0, 200, 0, 20], bg: '#ff0000', rot: 90, kids: [{ name: 'Tip', cls: 'Frame', pos: [0, 180, 0, 0], size: [0, 20, 0, 20], bg: '#00ff00' }] },
      { name: 'Clip', cls: 'Frame', pos: [0, 400, 0, 100], size: [0, 100, 0, 100], bgT: 1, clips: true, kids: [{ name: 'Big', cls: 'Frame', pos: [0, 50, 0, 50], size: [0, 200, 0, 200], bg: '#0000ff' }] },
    ]);
    // Turned 90° about (200, 160): it stands upright, 20 wide and 200 tall.
    expect(near(at(img, 200, 80), [255, 0, 0], 20)).toBe(true);
    expect(near(at(img, 120, 160), [255, 0, 0], 20)).not.toBe(true);
    // Its child turns with it: the tip at its right end is now at the bottom.
    expect(near(at(img, 200, 252), [0, 255, 0], 30)).toBe(true);
    // The child is cut at its clipping parent's edge.
    expect(near(at(img, 480, 180), [0, 0, 255], 10)).toBe(true);
    expect(near(at(img, 520, 180), [0, 0, 255], 10)).toBe(false);
  });

  it('draws text with its outline, a soft shadow cut out under its element, shapes and images', () => {
    const images = projectImages('Z:/no-project', resolve(__dirname, '..', 'resources'));
    const img = draw(
      [
        { name: 'Title', cls: 'TextLabel', pos: [0, 20, 0, 20], size: [0, 300, 0, 60], bgT: 1, text: 'HELLO', textSize: 48, font: 'FredokaOne', textColor: '#ffffff', stroke: { color: '#ff0000', px: 3, text: true } },
        { name: 'Glow', cls: 'Frame', pos: [0, 420, 0, 40], size: [0, 100, 0, 40], bgT: 1, shadow: { color: '#00ffff', t: 0, blur: 16 } },
        { name: 'Panel', cls: 'Frame', pos: [0, 20, 0, 150], size: [0, 300, 0, 120], bg: '#ffffff', shape: { slant: [60, 0] } },
        { name: 'Icon', cls: 'ImageLabel', pos: [0, 420, 0, 150], size: [0, 120, 0, 120], bgT: 1, image: 'glyph:plus', imageColor: '#ffff00' },
      ],
      { images },
    );
    const px = (x0: number, y0: number, w: number, h: number, test: (c: [number, number, number]) => boolean) => {
      let n = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (test(at(img, x, y))) n++;
      return n;
    };
    // White letters inside a red outline.
    expect(px(20, 20, 300, 60, (c) => near(c, [255, 255, 255], 20))).toBeGreaterThan(400);
    expect(px(20, 20, 300, 60, (c) => near(c, [255, 0, 0], 40))).toBeGreaterThan(200);
    // A glow round an empty box: cyan around it, nothing inside (UIShadow is cut out under its element).
    expect(at(img, 470, 37)[2]).toBeGreaterThan(BACK(img, 470, 37)[2] + 25);
    expect(near(at(img, 470, 60), BACK(img, 470, 60), 6)).toBe(true);
    // The panel leans: its top-left corner is empty, its bottom-left full.
    expect(near(at(img, 24, 154), BACK(img, 24, 154), 8)).toBe(true);
    expect(at(img, 24, 266)).toEqual([255, 255, 255]);
    // A glyph tinted yellow: the plus's middle.
    expect(near(at(img, 480, 210), [255, 255, 0], 30)).toBe(true);
    expect(near(at(img, 425, 155), [255, 255, 0], 30)).toBe(false);
  });

  it('reads rich text and draws states', () => {
    expect(richRuns('a<b>b</b><s>c</s>', true).map((r) => [r.ch, r.bold, r.strike])).toEqual([
      ['a', false, false],
      ['b', true, false],
      ['c', false, true],
    ]);
    const node: UiNode = { id: 1, name: 'B', cls: 'TextButton', bg: [0, 0, 0], states: { press: { scale: 0.95, bg: [255, 0, 0] } } };
    expect(withState(node, 'press')).toMatchObject({ bg: [255, 0, 0], scale: 0.95 });
    expect(withState(node, 'hover')).toBe(node);
  });

  it("slants a label set in italic (its FontFace style), not only rich text's <i>", () => {
    const label = (o: Partial<MockNode>): MockNode => ({ name: 'L', cls: 'TextLabel', pos: [0, 100, 0, 100], size: [0, 300, 0, 60], bgT: 1, text: 'IIIIII', textSize: 40, textColor: '#ffffff', ...o });
    const ink = (img: RgbaImage) => {
      // The columns the letters ink: a slanted I covers more of them than an upright one.
      let cols = 0;
      for (let x = 0; x < img.width; x++) for (let y = 0; y < img.height; y++) if (img.data[(y * img.width + x) * 4]! > 128) { cols++; break; }
      return cols;
    };
    // A family with no italic face (Sarpanch): Studio slants the upright one.
    const face = fontFor(undefined, false, false).font!;
    const fonts: FontPicker = (_f, _b, italic) => ({ font: Object.assign(Object.create(face) as typeof face, { synthItalic: italic }), standIn: '' });
    const upright = ink(draw([label({})], { rulers: false, fonts }));
    expect(ink(draw([label({ italic: true })], { rulers: false, fonts }))).toBeGreaterThan(upright * 1.2);
    expect(ink(draw([label({ text: '<i>IIIIII</i>', rich: true })], { rulers: false, fonts }))).toBeGreaterThan(upright * 1.2);
  });
});

describe('a mockup version as pictures', () => {
  it('draws the worked example on every device, and a button in each of its states', () => {
    const images = projectImages('Z:/no-project', resolve(__dirname, '..', 'resources'));
    const v = scifiVersion();
    for (const d of ['phone', 'phonePortrait', 'tablet', 'desktop', 'tv'] as const) {
      const pic = renderVersion({ name: 'scifi', title: 'Sci-fi' }, v, d, { images });
      expect(pic.unknown).toEqual([]);
      expect(pic.image.width).toBeLessThanOrEqual(1500);
      expect(pic.caption).toMatch(/Sci-fi A/);
    }
    const zoom = renderVersion({ name: 'scifi', title: 'Sci-fi' }, v, 'desktop', { images, focus: 'Combat.Weapon' });
    expect(zoom.scale).toBeGreaterThan(1);
    expect(zoom.region.w).toBeLessThan(600);
    const sheet = statesSheet({ name: 'scifi', title: 'Sci-fi' }, v, 'phone', 'Menu.Row.Shop', images)!;
    expect(sheet.states).toEqual(['hover', 'press', 'selected']);
    expect(sheet.image.width).toBeGreaterThan(4 * 100);
  });
});
