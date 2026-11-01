import type { KilnBuildInfo, KilnBuildsInfo } from '../components/kiln-builds';

/** A build as the `kiln.builds` RPC sends it: the queue's whole entry (core/modeling/kiln-queue.ts KilnBuild). */
export type KilnBuildRow = KilnBuildInfo & { family?: boolean; kilnProject?: string };

/**
 * The Models container's one line about Kiln (its own container is optional): the model or family Kiln
 * builds now, how far its copilot is (Kiln 0.8.2 progress, else the queue's step) and what waits.
 * Null when Kiln builds nothing for this project.
 */
export function kilnBuildLine(info: { builds: KilnBuildRow[] } | KilnBuildsInfo | null | undefined): { text: string; project: string | null } | null {
  const builds = (info?.builds ?? []) as KilnBuildRow[];
  const running = builds.filter((b) => b.state === 'running');
  const queued = builds.filter((b) => b.state === 'queued');
  const b = running[0] ?? queued[0];
  if (!b) return null;
  const what = `${b.name}${b.family ? ' family' : ''}`;
  const parts = [`Kiln · ${what}`];
  if (b.state === 'queued') parts[0] += ' waiting its turn';
  else {
    const p = b.progress;
    if (p?.done != null && p.total) parts.push(`${Math.min(p.done, p.total)}/${p.total}`);
    const step = p?.current ?? b.step;
    if (step) parts.push(step);
    if (p?.etaMs != null && p.etaMs >= 60_000) parts.push(`~${Math.round(p.etaMs / 60_000)} min left`);
  }
  const more = running.length - (b.state === 'running' ? 1 : 0);
  const waiting = queued.length - (b.state === 'queued' ? 1 : 0);
  if (more > 0) parts.push(`+${more} building`);
  if (waiting > 0) parts.push(`+${waiting} waiting`);
  return { text: parts.join(' · '), project: b.kilnProject ?? null };
}
