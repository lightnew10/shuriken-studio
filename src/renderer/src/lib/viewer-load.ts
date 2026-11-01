/**
 * What the Studio viewer does with what it reads from Studio, apart from drawing it. The user saw "grey flashes
 * across the screen", and a viewer "stuck on the grey": the replica's empty scene is a grey ground under a sky, and
 * a Studio picture taken while Studio switches modes is a grey frame. Three ways in, all closed here:
 *  - a read that found no parts replaced a scene that had them (a playtest starting, Studio reopening the place);
 *  - a read that failed (120 s timeouts in a heavy place) was never tried again, and every change in Studio threw
 *    away the read under way, so in a busy build a slow read never landed;
 *  - Studio's own picture of the view was shown over the replica whenever it was not perfectly flat, and stayed
 *    until the camera moved.
 */
export const VIEWER_LOAD = {
  /** How soon an empty read is checked again. */
  emptyRetryMs: 1500,
  /** When a failed read is tried again: the first, second, … time in a row; then it waits for the next change. */
  failRetryMs: [4000, 10_000, 20_000, 40_000] as readonly number[],
};

/**
 * A read that found no parts, right after a scene that had them, is not shown: the scene stays and the place is
 * read once more. The second empty read in a row is believed (the place really is empty now).
 */
export function keepPrevious(shown: number, read: number, emptyInARow: number): boolean {
  return shown > 0 && read === 0 && emptyInARow < 1;
}

/** How long until a failed read is tried again (null: not by itself any more). */
export function failRetryDelay(failuresInARow: number): number | null {
  return VIEWER_LOAD.failRetryMs[failuresInARow - 1] ?? null;
}

/**
 * One read of the place at a time, and one more after it when something changed meanwhile. A change in Studio no
 * longer throws away the read that is under way: with playtests starting and stopping every 10 to 40 seconds, a read
 * that takes a minute would never have been shown.
 */
export class LoadGate {
  private busy = false;
  /** The read to make when this one is done (its terrain flag), or null. */
  private queued: boolean | null = null;

  constructor(private readonly run: (withTerrain: boolean) => Promise<void>) {}

  get loading(): boolean {
    return this.busy;
  }

  request(withTerrain: boolean): void {
    if (this.busy) {
      this.queued = (this.queued ?? false) || withTerrain;
      return;
    }
    this.busy = true;
    void this.run(withTerrain)
      .catch(() => undefined)
      .finally(() => {
        this.busy = false;
        const next = this.queued;
        this.queued = null;
        if (next !== null) this.request(next);
      });
  }
}

/** Mean colour, luminance and contrast of a picture (what the viewer measures on a thumbnail of it). */
export interface ImageStats {
  r: number;
  g: number;
  b: number;
  l: number;
  sd: number;
}

/** Below this contrast a picture is a blank frame, whatever it is of. */
export const FLAT_SD = 14;

/**
 * Whether Studio's picture of the view may be shown over the replica. Not a blank frame, and not one that is much
 * flatter than the replica of the same view: that is Studio caught while it switches modes or loads the place (a
 * grey viewport with a little interface on it), not this view.
 */
export function acceptShot(shot: ImageStats | null, replica: ImageStats | null): boolean {
  if (!shot || shot.sd < FLAT_SD) return false;
  if (!replica) return true;
  return !(replica.sd >= 24 && shot.sd < replica.sd * 0.4);
}
