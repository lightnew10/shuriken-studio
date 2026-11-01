/**
 * How the "working" mark moves (brand/logo.tsx draws it).
 *
 * Up to 1.12.1 every active mark animated its 52 pixels one by one. A 12-agent build put 79 of them on the
 * dashboard: 4,108 running animations of SVG rects, none of which the compositor can run. Measured on that
 * build's data: the renderer's main thread was busy 867 ms of every second, the window drew 9.8 frames a second
 * and a key press took 200 ms to reach the screen; with the mark as one transform animation it is 60 fps and 28 ms.
 * So a mark that repeats in a list turns as a whole ('spin': one animation, on the svg element), and the pixel fall
 * ('fall') is kept for one big mark at a time: a loader.
 */

/** From this size an active mark shows the pixel fall unless told otherwise. */
export const RICH_MARK_SIZE = 40;
/** The pixels a mark has (each one an animation of its own in 'fall'). */
export const MARK_PIXELS = 52;

export type MarkMotion = 'fall' | 'spin' | null;

export function markMotion(size: number, active: boolean, rich?: boolean): MarkMotion {
  if (!active) return null;
  return (rich ?? size >= RICH_MARK_SIZE) ? 'fall' : 'spin';
}

/** Running animations for a screen with these active marks: what the page pays every frame. */
export function markAnimations(marks: Array<{ size: number; rich?: boolean }>): number {
  return marks.reduce((n, m) => n + (markMotion(m.size, true, m.rich) === 'fall' ? MARK_PIXELS : 1), 0);
}
