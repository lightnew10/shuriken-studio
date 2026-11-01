import { describe, expect, it } from 'vitest';
import type { UiNode } from '../../src/shared/ui-layout';
import { canvasSize, childrenInState, isSkinRef, pngSize, sliceCss, sliceInsets, slicePlan, wearsSkins, wornRefs } from '../../src/renderer/src/lib/skin-css';

// Forged skins on the Mockups view's canvases: Roblox's 9-slice as CSS border-image (insets from the SliceCenter, edges
// inset × SliceScale × UIScale points, the middle filled), and a state that wears other art laid out in that state.

/** A PNG data URL whose header says w×h (enough for pngSize). */
function pngUrl(w: number, h: number): string {
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 6, 0, 0, 0];
  return `data:image/png;base64,${btoa(String.fromCharCode(...b))}AAAA`;
}

describe('skins on the canvas', () => {
  it('reads a PNG data URL’s size from its header', () => {
    expect(pngSize(pngUrl(1062, 702))).toEqual({ w: 1062, h: 702 });
    expect(pngSize(pngUrl(48, 48))).toEqual({ w: 48, h: 48 });
    expect(pngSize('data:image/jpeg;base64,/9j/4AAQ')).toBeNull();
    expect(isSkinRef('skin:candy:button:primary@200x56')).toBe(true);
    expect(isSkinRef('rbxassetid://1')).toBe(false);
  });

  it('maps a SliceCenter to border-image: slices in image pixels, widths in points', () => {
    // A 9-slice forged at 2 px per point: 100×80 px, its middle from (24, 20) to (76, 60).
    expect(sliceInsets([24, 20, 76, 60], 100, 80)).toEqual([20, 24, 20, 24]);
    const css = sliceCss({ url: 'data:x', w: 100, h: 80, slice: [24, 20, 76, 60], sliceScale: 0.5, k: 1 });
    expect(css.borderImageSlice).toBe('20 24 20 24 fill');
    expect(css.borderImageWidth).toBe('10px 12px 10px 12px');
    expect(css.borderWidth).toBe(css.borderImageWidth);
    expect(css.borderImageSource).toBe('url("data:x")');
    expect(css).toMatchObject({ borderStyle: 'solid', borderImageRepeat: 'stretch', boxSizing: 'border-box', borderImageOutset: 0 });
    // Under a UIScale of 1.25 the edges grow with everything else.
    expect(sliceCss({ url: 'u', w: 100, h: 80, slice: [24, 20, 76, 60], sliceScale: 0.5, k: 1.25 }).borderImageWidth).toBe('12.5px 15px 12.5px 15px');
    // Uneven and out-of-range slices stay inside the picture.
    expect(sliceInsets([10, 4, 70, 60], 100, 80)).toEqual([4, 30, 20, 10]);
    expect(sliceInsets([-5, 0, 140, 80], 100, 80)).toEqual([0, 0, 0, 0]);
  });

  it('draws the nine pieces into one bitmap on whole pixels, so they meet without seams', () => {
    // A window's art at 2 px per point with a 4 px centre (it only ever stretches), shown 300×200 points at 1.5 px per point.
    const size = canvasSize(300, 200, 1.5);
    expect(size).toEqual({ cw: 450, ch: 300, zoom: 1.5 });
    const plan = slicePlan({ w: 132, h: 132, slice: [64, 64, 68, 68], sliceScale: 0.5, k: 1, ...size });
    expect(plan).toHaveLength(9);
    // Corners keep 64 px × 0.5 × 1.5 = 48 canvas pixels; the middle takes the rest.
    expect(plan[0]).toEqual([0, 0, 64, 64, 0, 0, 48, 48]);
    expect(plan[4]).toEqual([64, 64, 4, 4, 48, 48, 354, 204]);
    expect(plan[8]).toEqual([68, 68, 64, 64, 402, 252, 48, 48]);
    // Every piece starts where the one before it ends.
    for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) expect(plan[j * 3 + i]![4] + plan[j * 3 + i]![6]).toBe(plan[j * 3 + i + 1]![4]);
    // A box smaller than its corners shrinks them together, as border-image does.
    const tight = slicePlan({ w: 132, h: 132, slice: [64, 64, 68, 68], sliceScale: 0.5, k: 1, cw: 40, ch: 40, zoom: 1 });
    expect(tight.map((p) => [p[4], p[5], p[6], p[7]])).toEqual([[0, 0, 20, 20], [20, 0, 20, 20], [0, 20, 20, 20], [20, 20, 20, 20]]);
    // Very big pictures are drawn smaller.
    expect(canvasSize(4000, 4000, 2).cw).toBeLessThanOrEqual(2829);
  });

  it('finds the art a worn version shows, its states too', () => {
    expect(wearsSkins({ screens: [{ name: 'Hud', kids: [{ name: 'B', skin: 'candy:button:primary' }] }] })).toBe(true);
    expect(wearsSkins({ screens: [{ name: 'Hud', kids: [{ name: 'B', bg: '#fff' }] }] })).toBe(false);
    const worn: UiNode = { id: 1, name: 'Hud', cls: 'ScreenGui', kids: [{ id: 2, name: 'B', cls: 'TextButton', states: { press: { skinArt: { image: 'skin:b2', scaleType: 'Stretch', pos: [0, 0, 0, 0], size: [1, 0, 1, 0] } } }, kids: [{ id: 3, name: 'Skin', cls: 'ImageLabel', image: 'skin:b1' }, { id: 4, name: 'Icon', cls: 'ImageLabel', image: 'glyph:star' }] }] };
    expect(wornRefs([worn]).sort()).toEqual(['skin:b1', 'skin:b2']);
  });

  it('lays out the art and label of a pressed button in its pressed state', () => {
    const button: UiNode = {
      id: 2,
      name: 'Play',
      cls: 'TextButton',
      pos: [0, 100, 0, 100],
      size: [0, 200, 0, 60],
      bgT: 1,
      text: '',
      states: {
        press: { scale: 0.96, skinArt: { image: 'skin:candy:button:pressed@200x60', pos: [0, -4, 0, -4], size: [1, 8, 1, 8], scaleType: 'Slice', slice: [30, 30, 390, 110], sliceScale: 0.5 }, label: { pos: [0, 0, 0, 5], size: [1, 0, 1, -5] } },
        hover: { scale: 1.05 },
      },
      kids: [
        { id: 3, name: 'Skin', cls: 'ImageLabel', pos: [0, -8, 0, -8], size: [1, 16, 1, 16], bgT: 1, image: 'skin:candy:button:primary@200x60', scaleType: 'Slice', slice: [40, 40, 400, 120], sliceScale: 0.5 },
        { id: 4, name: 'Label', cls: 'TextLabel', pos: [0, 0, 0, 0], size: [1, 0, 1, 0], bgT: 1, text: 'PLAY', textSize: 24 },
      ],
    };
    const screen: UiNode = { id: 1, name: 'Hud', cls: 'ScreenGui', insets: 'None', kids: [button] };
    const device = { w: 800, h: 600 };
    const pressed = childrenInState(screen, new Map([['Hud.Play', 'press']]), device);
    const skin = pressed.get(3)!;
    expect(skin.node.image).toBe('skin:candy:button:pressed@200x60');
    expect(skin.node.slice).toEqual([30, 30, 390, 110]);
    expect([skin.x, skin.y, skin.w, skin.h]).toEqual([96, 96, 208, 68]);
    const label = pressed.get(4)!;
    expect([label.x, label.y, label.w, label.h]).toEqual([100, 105, 200, 55]);
    expect(label.node.text).toBe('PLAY');
    // The element itself keeps its place (its scale plays as a transform), and a state without art moves nothing.
    expect(pressed.has(2)).toBe(false);
    expect(childrenInState(screen, new Map([['Hud.Play', 'hover']]), device).get(3)!.node.image).toBe('skin:candy:button:primary@200x60');
    expect(childrenInState(screen, new Map(), device).size).toBe(0);
  });
});
