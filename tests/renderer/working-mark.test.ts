import { describe, expect, it } from 'vitest';
import { MARK_PIXELS, RICH_MARK_SIZE, markAnimations, markMotion } from '../../src/renderer/src/lib/working-mark';

/**
 * The "working" mark. Up to 1.12.1 every active mark animated its 52 pixels one by one; a 12-agent build put 79 of
 * them on the dashboard: 4,108 running SVG animations, the renderer's main thread busy 867 ms of every second, 9.8
 * frames a second and 200 ms from a key press to the screen (measured on that build's data; 60 fps and 28 ms with
 * the mark as one transform animation).
 */
describe('the working mark', () => {
  it('in a list turns as a whole: one animation, whatever its size there', () => {
    for (const size of [12, 14, 16, 17, 20, 22, 28]) expect(markMotion(size, true), String(size)).toBe('spin');
  });

  it('keeps the pixel fall for one big mark (a loader), or where it is asked for', () => {
    expect(RICH_MARK_SIZE).toBe(40);
    expect(markMotion(56, true)).toBe('fall');
    expect(markMotion(40, true)).toBe('fall');
    expect(markMotion(16, true, true)).toBe('fall');
    expect(markMotion(56, true, false)).toBe('spin');
  });

  it('sits still when idle', () => {
    expect(markMotion(24, false)).toBeNull();
    expect(markMotion(56, false, true)).toBeNull();
  });

  it("a busy build's dashboard runs one animation per mark, not 52", () => {
    // What the 12-agent build showed: 79 active marks of 14-22 px.
    const marks = Array.from({ length: 79 }, (_, i) => ({ size: [14, 16, 17, 20, 22][i % 5]! }));
    expect(markAnimations(marks)).toBe(79);
    expect(79 * MARK_PIXELS).toBe(4108);
    // The loading screen's one big mark still falls.
    expect(markAnimations([{ size: 56 }])).toBe(52);
  });
});
