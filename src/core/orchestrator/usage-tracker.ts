import { newId, nowIso } from '@shared/ids';
import type { UsageObservation } from '@shared/domain';
import { clockText, windowExpired } from '@shared/usage';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';

/** How long a rejection that names no reset time of its own blocks the account. */
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;
/** The UI is told this long after a reset time, so a clock a moment apart from the provider's can't hide it. */
const RESET_GRACE_MS = 1000;
/** The longest delay setTimeout takes (a longer one fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * "…resets 12:50am (Europe/London)" → the next such local time, in epoch seconds (null when the
 * message has no reset time). The provider's own rate-limit events are preferred when they arrive.
 */
export function resetFromMessage(msg: string, now = new Date()): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(msg);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === 'pm') h += 12;
  const t = new Date(now);
  t.setHours(h, Number(m[2] ?? 0), 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return Math.floor(t.getTime() / 1000);
}

/** A provider's utilization as a 0–1 fraction (readings have been seen as both 0.85 and 85). */
function asFraction(u: number | null): number | null {
  if (u == null || !Number.isFinite(u)) return null;
  return u > 1 ? u / 100 : u;
}

export interface UsageSnapshot {
  providerId: string;
  /**
   * Latest rate-limit signal per window, as reported by the provider (advisory): utilization as a 0–1
   * fraction, resetsAt in epoch seconds. A window is dropped once its reset time has passed.
   */
  windows: Record<string, { status: string; utilization: number | null; resetsAt: number | null; observedAt: string }>;
  costUsdToday: number;
  runsToday: number;
  /** True when the provider reported a hard rejection recently: the scheduler pauses new runs. */
  blocked: boolean;
  blockedUntil: number | null;
}

/**
 * Records provider usage signals. Rate-limit utilization numbers are treated as ADVISORY: they
 * were observed to disagree with the account dashboard, so the scheduler only reacts to explicit
 * rejections (status 'rejected'), never to utilization percentages alone.
 *
 * A provider reports a window only when its status changes, so a reading is never corrected by the
 * runs that follow it. It therefore ends by itself: at its window's reset time, or when a run gets
 * through (recordSuccess). The UI re-reads usage only when told to, so both tell it (usage.changed).
 */
export class UsageTracker {
  private readonly latest = new Map<string, UsageSnapshot>();
  /** One wake-up per account key, just after the soonest reset time among its windows and its block. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly clock: () => number;

  constructor(
    private readonly global: Store,
    private readonly bus: EventBus,
    opts: { now?: () => number } = {},
  ) {
    // Looked up at every call rather than captured, so fake timers that replace Date.now are followed.
    this.clock = opts.now ?? (() => Date.now());
  }

  /** The tracker's clock (epoch ms): what reset times are measured against. Tests inject their own. */
  now(): number {
    return this.clock();
  }

  recordRateLimit(providerId: string, info: { status: string; window: string | null; utilization: number | null; resetsAt: number | null; raw: unknown }): void {
    const obs: UsageObservation = { id: newId('use'), providerId, kind: 'rate_limit', data: info.raw, observedAt: nowIso() };
    this.global.run('INSERT INTO usage_observations (id, provider_id, kind, data, observed_at) VALUES (?, ?, ?, ?, ?)', [obs.id, providerId, obs.kind, j(obs.data), obs.observedAt]);
    const snap = this.snapshot(providerId);
    let resetsAt = info.resetsAt || null;
    if (info.status === 'rejected') {
      snap.blocked = true;
      snap.blockedUntil = resetsAt ? resetsAt * 1000 : this.now() + DEFAULT_BLOCK_MS;
      // A rejection that names no reset time still ends: its reading expires with the block.
      resetsAt ??= Math.floor(snap.blockedUntil / 1000);
    }
    snap.windows[info.window ?? 'unknown'] = { status: info.status, utilization: asFraction(info.utilization), resetsAt, observedAt: obs.observedAt };
    this.arm(providerId);
    this.bus.emit('usage.observed', obs);
  }

  /**
   * A run got through on this account, so a limit recorded for it is over: its rejected windows go and
   * so does the block. (Warnings stay: they are readings, not limits.) Without this a rejection the
   * provider never re-reports would outlive its window.
   */
  recordSuccess(providerId: string): void {
    const s = this.snapshot(providerId);
    let changed = s.blocked;
    for (const [key, w] of Object.entries(s.windows)) {
      if (w.status !== 'rejected') continue;
      delete s.windows[key];
      changed = true;
    }
    s.blocked = false;
    s.blockedUntil = null;
    if (!changed) return;
    this.arm(providerId);
    this.bus.emit('usage.changed', { providerId });
  }

  recordRun(providerId: string, costUsd: number): void {
    const obs: UsageObservation = { id: newId('use'), providerId, kind: 'cost', data: { costUsd }, observedAt: nowIso() };
    this.global.run('INSERT INTO usage_observations (id, provider_id, kind, data, observed_at) VALUES (?, ?, ?, ?, ?)', [obs.id, providerId, obs.kind, j(obs.data), obs.observedAt]);
    const snap = this.snapshot(providerId);
    snap.costUsdToday += costUsd;
    snap.runsToday += 1;
  }

  snapshot(providerId: string): UsageSnapshot {
    let s = this.latest.get(providerId);
    if (!s) {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const rows = this.global.all<{ data: string }>(`SELECT data FROM usage_observations WHERE provider_id = ? AND kind = 'cost' AND observed_at >= ?`, [providerId, since.toISOString()]);
      s = {
        providerId,
        windows: {},
        costUsdToday: rows.reduce((acc, r) => acc + (pj<{ costUsd?: number }>(r.data, {}).costUsd ?? 0), 0),
        runsToday: rows.length,
        blocked: false,
        blockedUntil: null,
      };
      this.latest.set(providerId, s);
    }
    // A reading describes its window only until the window resets, and a block ends at its reset time.
    const now = this.now();
    for (const [key, w] of Object.entries(s.windows)) {
      if (windowExpired(w, now)) delete s.windows[key];
    }
    if (s.blocked && s.blockedUntil && now >= s.blockedUntil) {
      s.blocked = false;
      s.blockedUntil = null;
    }
    return s;
  }

  canStartRun(providerId: string): { ok: boolean; reason?: string } {
    const s = this.snapshot(providerId);
    if (s.blocked) return { ok: false, reason: `Claude's usage limit is reached; work resumes ${s.blockedUntil ? `at ${clockText(s.blockedUntil, this.now())}` : 'when it resets'}` };
    return { ok: true };
  }

  clearBlock(providerId: string): void {
    const s = this.snapshot(providerId);
    s.blocked = false;
    s.blockedUntil = null;
  }

  /** Cancels the pending reset wake-ups (the core shutting down). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Wakes the UI just after the soonest reset time among a key's windows and its block: the snapshot is
   * pruned and `usage.changed` tells the UI to read it again, so a badge never keeps showing a limit that
   * is over. One timer per key, set again for the next reset when it fires; unref'd, so it never keeps
   * the process alive.
   */
  private arm(providerId: string): void {
    const old = this.timers.get(providerId);
    if (old) clearTimeout(old);
    this.timers.delete(providerId);
    const s = this.snapshot(providerId);
    const now = this.now();
    const ends = Object.values(s.windows).map((w) => (w.resetsAt ? w.resetsAt * 1000 : 0));
    if (s.blockedUntil) ends.push(s.blockedUntil);
    const next = Math.min(...ends.filter((t) => t > now));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => {
      this.timers.delete(providerId);
      this.arm(providerId);
      this.bus.emit('usage.changed', { providerId });
    }, Math.min(next - now + RESET_GRACE_MS, MAX_TIMER_MS));
    timer.unref();
    this.timers.set(providerId, timer);
  }
}
