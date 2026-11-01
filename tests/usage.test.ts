import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@core/db/store';
import { GLOBAL_MIGRATIONS } from '@core/db/schema';
import { EventBus } from '@core/events';
import { UsageTracker } from '@core/orchestrator/usage-tracker';
import { liveUtilization, windowExpired } from '@shared/usage';

/** A tracker on a clock the test moves (epoch ms). */
function setup(start = Date.parse('2026-09-30T19:11:34Z')) {
  const clock = { now: start };
  const bus = new EventBus();
  const changed: Array<string | null> = [];
  bus.on('usage.changed', (e) => changed.push(e.providerId));
  const usage = new UsageTracker(new Store(':memory:', GLOBAL_MIGRATIONS), bus, { now: () => clock.now });
  return { usage, clock, changed, sec: (ms: number) => Math.floor(ms / 1000) };
}

afterEach(() => vi.useRealTimers());

describe('usage readings end when their window resets', () => {
  it('shows a limit as 100% only until its reset time, then nothing', () => {
    const { usage, clock, sec } = setup();
    usage.recordRateLimit('claude', { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: sec(clock.now + 60_000), raw: {} });
    let s = usage.snapshot('claude');
    expect(s.blocked).toBe(true);
    expect(liveUtilization(s.windows, clock.now)).toBe(1);
    expect(usage.canStartRun('claude').ok).toBe(false);
    // Said plainly in the top bar: whose limit, and when work goes on.
    expect(usage.canStartRun('claude').reason).toMatch(/^Claude's usage limit is reached; work resumes at \d{1,2}:\d{2}\s?[AP]M$/);
    // The limit reset: the reading is gone (not a stale 100%), and work may start.
    clock.now += 61_000;
    s = usage.snapshot('claude');
    expect(s.windows.five_hour).toBeUndefined();
    expect(s.blocked).toBe(false);
    expect(liveUtilization(s.windows, clock.now)).toBeNull();
    expect(usage.canStartRun('claude').ok).toBe(true);
  });

  it('gives a rejection without a reset time an end (the 15-minute block)', () => {
    const { usage, clock } = setup();
    usage.recordRateLimit('claude', { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: null, raw: {} });
    expect(usage.snapshot('claude').windows.five_hour!.resetsAt).toBe(Math.floor((clock.now + 15 * 60_000) / 1000));
    clock.now += 15 * 60_000 + 1000;
    expect(usage.snapshot('claude').windows).toEqual({});
    expect(usage.snapshot('claude').blocked).toBe(false);
  });

  it('lifts a recorded limit when a run gets through, and keeps warnings', () => {
    const { usage, clock, changed, sec } = setup();
    usage.recordRateLimit('claude', { status: 'allowed_warning', window: 'weekly', utilization: 89, resetsAt: sec(clock.now + 3_600_000), raw: {} });
    usage.recordRateLimit('claude', { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: sec(clock.now + 600_000), raw: {} });
    usage.recordSuccess('claude');
    const s = usage.snapshot('claude');
    expect(s.blocked).toBe(false);
    expect(Object.keys(s.windows)).toEqual(['weekly']);
    // A percent arrives as 89 or as 0.89: kept as a fraction either way.
    expect(s.windows.weekly!.utilization).toBeCloseTo(0.89);
    expect(changed).toEqual(['claude']);
    // Nothing to lift: nobody is told.
    usage.recordSuccess('claude');
    expect(changed).toEqual(['claude']);
  });

  it('tells the UI when a window resets, so the badge is read again', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-30T19:11:34Z') });
    const bus = new EventBus();
    const changed: Array<string | null> = [];
    bus.on('usage.changed', (e) => changed.push(e.providerId));
    const usage = new UsageTracker(new Store(':memory:', GLOBAL_MIGRATIONS), bus);
    usage.recordRateLimit('claude', { status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 60, raw: {} });
    vi.advanceTimersByTime(30_000);
    expect(changed).toEqual([]);
    vi.advanceTimersByTime(32_000);
    expect(changed).toEqual(['claude']);
    expect(usage.snapshot('claude').windows).toEqual({});
    usage.dispose();
  });

  it('reads only windows that have not reset (shared by the badge, the scheduler and the director)', () => {
    const now = Date.parse('2026-09-30T19:30:00Z');
    const past = Math.floor(now / 1000) - 600;
    const ahead = Math.floor(now / 1000) + 600;
    expect(windowExpired({ resetsAt: past }, now)).toBe(true);
    expect(windowExpired({ resetsAt: null }, now)).toBe(false);
    expect(liveUtilization({ five_hour: { utilization: 1, resetsAt: past }, weekly: { utilization: 0.42, resetsAt: ahead } }, now)).toBe(0.42);
    expect(liveUtilization({ five_hour: { utilization: 1, resetsAt: past } }, now)).toBeNull();
  });
});
