/**
 * The arithmetic of the settings page's sliders (components/step-slider.tsx): a slider has a few stops, shown as dots
 * along its track, and always rests on one of them. Pure, so it is tested in node.
 */

/** Where stop `i` of `count` sits along the track, from 0 to 1. */
export function stopFraction(i: number, count: number): number {
  return count <= 1 ? 0 : Math.max(0, Math.min(1, i / (count - 1)));
}

/** The stop nearest to a point on the track (`fraction` from 0 to 1, clamped): what a drag or a click snaps to. */
export function nearestStop(fraction: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.max(0, Math.min(1, fraction)) * (count - 1));
}

/**
 * Which stop shows a value. A value that is no stop (a number Shuriken lowered by itself, an older setting) shows on the
 * nearest stop by number, or on the first stop when the values aren't numbers.
 */
export function stopOf<T extends string | number>(value: T, stops: ReadonlyArray<T>): number {
  const exact = stops.indexOf(value);
  if (exact >= 0) return exact;
  if (typeof value !== 'number') return 0;
  let best = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(Number(stops[i]) - value) < Math.abs(Number(stops[best]) - value)) best = i;
  return best;
}

/** The stop a key moves to (arrows one stop, Page keys a quarter of the track, Home and End the ends); null for other keys. */
export function stopForKey(key: string, i: number, count: number): number | null {
  const last = Math.max(0, count - 1);
  const page = Math.max(1, Math.round(count / 4));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, i - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(last, i + 1);
    case 'PageDown':
      return Math.max(0, i - page);
    case 'PageUp':
      return Math.min(last, i + page);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/**
 * Which stops get a label under their dot: all of them when there are few, else the ends and every `every`th (one too
 * close to the last end makes way for it, so two names never touch).
 */
export function labelledStops(count: number, max = 10): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const every = Math.ceil((count - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < count; i += every) out.push(i);
  const last = count - 1;
  if (out[out.length - 1] !== last) {
    if (last - out[out.length - 1]! < every / 2) out.pop();
    out.push(last);
  }
  return out;
}
