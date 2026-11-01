/** Kiln's version numbers, compared as numbers (kept apart from the client so settings and the build queue can use them). */

/** The first Kiln that takes briefs for results, the Roblox target and its baked Roblox export (docs/ARCHITECTURE.md, Kiln 0.7.3 contract). */
export const KILN_RESULTS_VERSION = '0.7.3';

/** "0.7.3" or "0.7.3-beta.1" as numbers [0, 7, 3]; null when it isn't a version. */
export function versionParts(v: string | null | undefined): number[] | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** Whether version `v` is at least `min`, compared number by number (0.10.0 is newer than 0.7.3); an unknown version is not. */
export function kilnAtLeast(v: string | null | undefined, min: string = KILN_RESULTS_VERSION): boolean {
  const a = versionParts(v);
  const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}
