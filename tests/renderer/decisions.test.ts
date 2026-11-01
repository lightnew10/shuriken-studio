import { describe, expect, it } from 'vitest';
import type { AgentRun, Escalation, Task } from '../../src/shared/domain';
import { NO_WORDS, autoResolved, dayKey, dayLabel, decisionDays, decisionRows, decisionsSummary } from '../../src/renderer/src/lib/decisions';

// "Decided without asking" on the Agents page: only what the system settled itself, newest first, by day, with the task.

/** A local time (the lib groups by the viewer's own days), as an ISO string. */
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 30, 9, 0).getTime();

let n = 0;
const esc = (over: Partial<Escalation> = {}): Escalation => ({
  id: `esc_${String(++n).padStart(3, '0')}`,
  taskId: null,
  runId: null,
  kind: 'question',
  title: 'Which arena size?',
  detail: 'Small or large.',
  options: [],
  status: 'auto_resolved',
  response: 'Large.',
  createdAt: at(30, 3),
  resolvedAt: at(30, 3),
  ...over,
});
const task = (id: string, title: string) => ({ id, title }) as Task;
const run = (id: string, taskId: string | null) => ({ id, taskId }) as AgentRun;

describe('which escalations are listed', () => {
  it('keeps only auto_resolved ones, newest decision first', () => {
    const a = esc({ id: 'a', createdAt: at(29, 23), resolvedAt: at(29, 23) });
    const b = esc({ id: 'b', createdAt: at(30, 2), resolvedAt: at(30, 2) });
    const open = esc({ id: 'open', status: 'open', resolvedAt: null });
    const answered = esc({ id: 'answered', status: 'answered' });
    expect(autoResolved([a, open, b, answered]).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('orders by when it was decided: a stuck task settled later by the planner moves up', () => {
    const early = esc({ id: 'early', createdAt: at(30, 1), resolvedAt: at(30, 1) });
    const stuck = esc({ id: 'stuck', createdAt: at(30, 0, 30), resolvedAt: at(30, 4), response: 'Retrying it with a different approach.' });
    expect(autoResolved([early, stuck]).map((e) => e.id)).toEqual(['stuck', 'early']);
    // Same moment: the one that came up last first, and the order does not depend on the input order.
    const x = esc({ id: 'esc_x', createdAt: at(30, 5), resolvedAt: at(30, 5) });
    const y = esc({ id: 'esc_y', createdAt: at(30, 5), resolvedAt: at(30, 5) });
    expect(autoResolved([x, y]).map((e) => e.id)).toEqual(autoResolved([y, x]).map((e) => e.id));
  });

  it('does not change the list it is given', () => {
    const list = [esc({ id: 'a', resolvedAt: at(29, 1) }), esc({ id: 'b', resolvedAt: at(30, 1) })];
    autoResolved(list);
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('a decision row', () => {
  it('names what came up, what was decided, when, and links the task through its latest run', () => {
    const e = esc({ taskId: 't1', kind: 'capability_missing', title: 'Blocked: Build the arena', detail: 'The agent reported a blocker.', response: 'Retrying with a placeholder model.', resolvedAt: at(30, 3, 5) });
    const [row] = decisionRows([e], [task('t1', 'Build the arena')], [run('r2', 't1'), run('r1', 't1')]);
    expect(row).toMatchObject({
      id: e.id,
      kindLabel: 'Blocked',
      question: 'Blocked: Build the arena',
      decided: 'Retrying with a placeholder model.',
      detail: 'The agent reported a blocker.',
      taskId: 't1',
      taskTitle: 'Build the arena',
      runId: 'r2',
    });
    expect(row!.time).toMatch(/\d/);
    expect(Date.parse(row!.at)).toBe(Date.parse(at(30, 3, 5)));
  });

  it('has no task link when there is no task, the task is gone, or it never ran', () => {
    const rows = decisionRows([esc({ id: 'none', resolvedAt: at(30, 3) }), esc({ id: 'gone', taskId: 'missing', resolvedAt: at(30, 2) }), esc({ id: 'objective', taskId: 'obj', resolvedAt: at(30, 1) })], [task('obj', 'Arena')], []);
    expect(rows.map((r) => [r.id, r.taskTitle, r.runId])).toEqual([
      ['none', null, null],
      ['gone', null, null],
      ['objective', 'Arena', null],
    ]);
  });

  it('tidies words and falls back when there are none', () => {
    const [row] = decisionRows([esc({ title: '  Save the place\n in Studio ', response: '  Auto-save is off.\n\nPress Ctrl+S.  ' })], [], []);
    expect(row!.question).toBe('Save the place in Studio');
    expect(row!.decided).toBe('Auto-save is off. Press Ctrl+S.');
    expect(decisionRows([esc({ response: null })], [], [])[0]!.decided).toBe(NO_WORDS);
    expect(decisionRows([esc({ response: '   ' })], [], [])[0]!.decided).toBe(NO_WORDS);
  });

  it('labels every kind of escalation in plain words', () => {
    const kinds = ['approval', 'question', 'failure', 'capability_missing', 'spec_change'] as const;
    const labels = decisionRows(kinds.map((kind) => esc({ kind })), [], []).map((r) => r.kindLabel);
    expect(new Set(labels).size).toBe(kinds.length);
    for (const l of labels) expect(l).not.toMatch(/_/);
  });
});

describe('grouping by day', () => {
  it('groups a night into Today and Yesterday, newest first, with older days named', () => {
    const list = [
      esc({ id: 'tonight', resolvedAt: at(29, 23, 40), createdAt: at(29, 23, 40) }),
      esc({ id: 'morning', resolvedAt: at(30, 6), createdAt: at(30, 6) }),
      esc({ id: 'late', resolvedAt: at(29, 21), createdAt: at(29, 21) }),
      esc({ id: 'old', resolvedAt: at(27, 12), createdAt: at(27, 12) }),
    ];
    const days = decisionDays(list, [], [], NOW);
    expect(days.map((d) => [d.label === 'Today' || d.label === 'Yesterday' ? d.label : 'older', d.rows.map((r) => r.id)])).toEqual([
      ['Today', ['morning']],
      ['Yesterday', ['tonight', 'late']],
      ['older', ['old']],
    ]);
    expect(days[2]!.label).toMatch(/27/);
  });

  it('is empty when nothing was decided', () => {
    expect(decisionDays([], [], [], NOW)).toEqual([]);
    expect(decisionDays([esc({ status: 'open' })], [], [], NOW)).toEqual([]);
  });

  it('names days relative to now, across midnight', () => {
    const justAfterMidnight = new Date(2026, 9, 1, 0, 10).getTime();
    expect(dayLabel(new Date(2026, 8, 30, 23, 50).getTime(), justAfterMidnight)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 1, 0, 1).getTime(), justAfterMidnight)).toBe('Today');
    expect(dayKey(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });
});

describe('the entry that opens the list', () => {
  it('counts the decisions, and says so plainly when there are none', () => {
    expect(decisionsSummary([])).toBe('Nothing yet');
    expect(decisionsSummary([esc({ status: 'open' })])).toBe('Nothing yet');
    expect(decisionsSummary([esc()])).toBe('1 decision');
    expect(decisionsSummary([esc(), esc(), esc({ status: 'answered' })])).toBe('2 decisions');
  });
});
