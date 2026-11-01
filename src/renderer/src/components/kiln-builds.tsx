import { Flame } from 'lucide-react';
import { navigate } from '../lib/nav';
import { useRpc } from '../lib/rpc';
import { cx } from './ui';

/** A build in Shuriken's queue of Kiln builds, as the `kiln.builds` RPC gives it (core/modeling/kiln-queue.ts). */
export interface KilnBuildInfo {
  id: string;
  name: string;
  kind: string | null;
  by: string | null;
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  step: string | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  costUsd: number | null;
  error: string | null;
  /** How far Kiln's copilot is (Kiln 0.8.2). */
  progress?: { done: number | null; total: number | null; current: string | null; etaMs: number | null; lastRender: string | null } | null;
}

export interface KilnBuildsInfo {
  status: { running: number; queued: number; atOnce: number; setting: number; note: string | null; estimate?: { usd: number; minutes: number } } | null;
  builds: KilnBuildInfo[];
}

/** "2 building, 3 waiting" for the queue; empty when nothing is building. */
export function kilnBuildsText(s: KilnBuildsInfo['status']): string {
  if (!s || s.running + s.queued === 0) return '';
  return [s.running ? `${s.running} building` : '', s.queued ? `${s.queued} waiting` : ''].filter(Boolean).join(', ');
}

/** What each build is doing, one per line, with why fewer run than the setting allows. */
export function kilnBuildsDetail(info: KilnBuildsInfo, now: number): string {
  const lines = info.builds
    .filter((b) => b.state === 'running' || b.state === 'queued')
    .map((b) => (b.state === 'running' ? `${b.name}: ${b.step ?? 'building'} (${Math.max(0, Math.round((now - (b.startedAt ?? b.queuedAt)) / 60_000))} min)` : `${b.name}: waiting its turn`));
  const s = info.status;
  if (s?.estimate) lines.push(`About ${s.estimate.minutes} min and $${s.estimate.usd.toFixed(2)} of usage for these (from Kiln's measured builds).`);
  if (s) lines.push(`Up to ${s.atOnce} Kiln build${s.atOnce === 1 ? '' : 's'} at once (each is a turn of Kiln's copilot on your subscription).`);
  if (s?.note) lines.push(s.note);
  return lines.join('\n');
}

/** Kiln builds next to the agents' status: how many are building and waiting; opens the Kiln page. */
export function KilnBuildsBadge() {
  const info = useRpc<KilnBuildsInfo>('kiln.builds', {}, ['kiln.builds', 'project.changed']);
  const text = kilnBuildsText(info.data?.status ?? null);
  if (!text || !info.data) return null;
  return (
    <button onClick={() => navigate('kiln')} title={kilnBuildsDetail(info.data, Date.now())} className={cx('flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] ring-1 ring-line transition-colors hover:bg-white/5', info.data.status?.running ? 'text-accent2' : 'text-faint')}>
      <Flame size={11} /> Kiln: {text}
    </button>
  );
}
