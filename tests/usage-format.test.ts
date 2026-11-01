import { describe, expect, it } from 'vitest';
import { formatAccountUsage, limitingUsage } from '@shared/usage';

// 2026-09-30 12:00 UTC, a Wednesday. Clock text is pinned to en-US / UTC so the test does not depend on the machine.
const NOW = Date.parse('2026-09-30T12:00:00Z');
const OPTS = { locale: 'en-US', timeZone: 'UTC' };
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const show = (windows: Parameters<typeof formatAccountUsage>[0], now = NOW) => formatAccountUsage(windows, now, OPTS);

describe('accounts menu usage lines', () => {
  it('shows the five-hour percent and when it resets', () => {
    const s = show({ five_hour: { utilization: 0.42, resetsAt: sec('2026-09-30T15:20:00Z') } });
    expect(s.fiveHour.text).toBe('5 h: 42% · resets 3:20 PM');
    expect(s.fiveHour).toMatchObject({ percent: 42, known: true, resetsAtMs: Date.parse('2026-09-30T15:20:00Z') });
    expect(s.weekly).toBeNull();
  });

  it('says there is no reading yet when the provider has reported nothing', () => {
    const s = show({});
    expect(s.fiveHour).toEqual({ text: '5 h: no reading yet', percent: null, resetsAtMs: null, known: false });
    expect(s.weekly).toBeNull();
  });

  it('does not count a window whose reset has passed', () => {
    const windows = { five_hour: { utilization: 0.9, resetsAt: sec('2026-09-30T11:59:59Z') }, seven_day: { utilization: 0.5, resetsAt: sec('2026-09-30T11:00:00Z') } };
    const s = show(windows);
    expect(s.fiveHour.text).toBe('5 h: no reading yet');
    expect(s.weekly).toBeNull();
    // The same reading is live a moment earlier.
    expect(show(windows, Date.parse('2026-09-30T11:00:00Z') - 1).fiveHour.text).toBe('5 h: 90% · resets 11:59 AM');
  });

  it('shows the weekly window with the day it resets', () => {
    const s = show({
      five_hour: { utilization: 0.1, resetsAt: sec('2026-09-30T14:00:00Z') },
      seven_day: { utilization: 0.183, resetsAt: sec('2026-10-04T09:00:00Z') },
    });
    expect(s.fiveHour.text).toBe('5 h: 10% · resets 2:00 PM');
    expect(s.weekly?.text).toBe('Week: 18% · resets Sun 9:00 AM');
    expect(s.weekly?.percent).toBe(18);
  });

  it('shows a weekly reset later the same day by its time alone', () => {
    expect(show({ seven_day: { utilization: 0.97, resetsAt: sec('2026-09-30T20:30:00Z') } }).weekly?.text).toBe('Week: 97% · resets 8:30 PM');
  });

  it('shows the weekly window even when the five-hour one has no reading', () => {
    const s = show({ seven_day: { utilization: 0.6, resetsAt: sec('2026-10-02T00:00:00Z') } });
    expect(s.fiveHour.text).toBe('5 h: no reading yet');
    expect(s.weekly?.text).toBe('Week: 60% · resets Fri 12:00 AM');
  });

  it('keeps a limit that was hit at 100% until it resets', () => {
    const s = show({ five_hour: { utilization: 1, resetsAt: sec('2026-09-30T13:05:00Z') } });
    expect(s.fiveHour.text).toBe('5 h: 100% · resets 1:05 PM');
  });

  it('reads utilization missing or its reset unknown without inventing either', () => {
    expect(show({ five_hour: { utilization: 0.3 } }).fiveHour.text).toBe('5 h: 30%');
    expect(show({ five_hour: { utilization: null, resetsAt: sec('2026-09-30T15:20:00Z') } }).fiveHour.text).toBe('5 h: % not reported · resets 3:20 PM');
    expect(show({ five_hour: { utilization: null, resetsAt: null } }).fiveHour).toMatchObject({ text: '5 h: no reading yet', known: false });
    // A reading outside 0-1 (never seen, but never a "250%") is held to the scale.
    expect(show({ five_hour: { utilization: 2.5, resetsAt: sec('2026-09-30T15:20:00Z') } }).fiveHour.percent).toBe(100);
  });

  it('is per account: each account is read from its own windows only', () => {
    // accounts.list hands each account the windows kept under its own usage key.
    const pc = show({ five_hour: { utilization: 0.42, resetsAt: sec('2026-09-30T15:20:00Z') } });
    const added = show({});
    expect(pc.fiveHour.text).toBe('5 h: 42% · resets 3:20 PM');
    expect(added.fiveHour.text).toBe('5 h: no reading yet');
  });

  it('labels a weekly limit that belongs to one model, and prefers the account-wide week', () => {
    const opusOnly = show({ seven_day_opus: { utilization: 0.8, resetsAt: sec('2026-10-04T09:00:00Z') } });
    expect(opusOnly.weekly?.text).toBe('Week (opus): 80% · resets Sun 9:00 AM');
    const both = show({
      seven_day_opus: { utilization: 0.8, resetsAt: sec('2026-10-04T09:00:00Z') },
      seven_day: { utilization: 0.2, resetsAt: sec('2026-10-05T09:00:00Z') },
    });
    expect(both.weekly?.text).toBe('Week: 20% · resets Mon 9:00 AM');
  });
});

describe('the account pill', () => {
  const pill = (windows: Parameters<typeof limitingUsage>[0], now = NOW) => limitingUsage(windows, now, OPTS);

  it('names the window its percent belongs to, the fullest first', () => {
    expect(pill({ five_hour: { utilization: 0.42, resetsAt: sec('2026-09-30T15:20:00Z') }, seven_day: { utilization: 0.18, resetsAt: sec('2026-10-04T09:00:00Z') } })).toMatchObject({ text: '5 h 42%', name: '5-hour window', atLimit: false });
    expect(pill({ five_hour: { utilization: 0.1, resetsAt: sec('2026-09-30T15:20:00Z') }, seven_day: { utilization: 0.6, resetsAt: sec('2026-10-04T09:00:00Z') } })?.text).toBe('Week 60%');
    expect(pill({ seven_day_opus: { utilization: 0.9, resetsAt: sec('2026-10-04T09:00:00Z') } })).toMatchObject({ text: 'Week (opus) 90%', name: 'weekly opus window' });
  });

  it('reads a weekly limit as the week and says when work resumes, not a bare 100% for days', () => {
    const p = pill({ five_hour: { utilization: 0.3, resetsAt: sec('2026-09-30T15:20:00Z') }, seven_day: { utilization: 1, resetsAt: sec('2026-10-04T09:00:00Z') } });
    expect(p).toMatchObject({ text: 'Week 100% · until Sun 9:00 AM', atLimit: true, percent: 100 });
  });

  it('leads with the limit that holds work longest when two are full', () => {
    const p = pill({ five_hour: { utilization: 1, resetsAt: sec('2026-09-30T15:20:00Z') }, seven_day: { utilization: 1, resetsAt: sec('2026-10-02T09:00:00Z') } });
    expect(p?.text).toBe('Week 100% · until Fri 9:00 AM');
    expect(pill({ five_hour: { utilization: 1, resetsAt: sec('2026-09-30T15:20:00Z') } })?.text).toBe('5 h 100% · until 3:20 PM');
  });

  it('has nothing to show without a live reading', () => {
    expect(pill({})).toBeNull();
    expect(pill({ seven_day: { utilization: 1, resetsAt: sec('2026-09-30T11:00:00Z') } })).toBeNull();
    expect(pill({ five_hour: { utilization: null, resetsAt: sec('2026-09-30T15:20:00Z') } })).toBeNull();
  });
});
