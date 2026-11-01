import { describe, expect, it } from 'vitest';
import type { Task, TestCase } from '@shared/domain';
import { VISUAL_PENDING, qualitySummary, testLabel, testsLine } from '../../src/renderer/src/lib/quality';

// The dashboard's Quality container (containers/quality.tsx): the tests, the work nobody has looked at,
// for the user who checks an overnight build in the morning.

const test = (name: string, lastStatus: TestCase['lastStatus'], more: Partial<TestCase> = {}): TestCase => ({
  id: `test_${name}`,
  name,
  kind: 'playtest',
  spec: { kind: 'critic' },
  taskId: 'task_1',
  enabled: true,
  lastStatus,
  lastRunAt: '2026-10-01T06:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  retiredReason: null,
  retiredAt: null,
  retiredBy: null,
  ...more,
});
const task = (id: string, status: Task['status'], result: string | null, completedAt: string | null = '2026-10-01T05:00:00.000Z') =>
  ({ id, title: `Task ${id}`, status, result, completedAt, updatedAt: completedAt ?? '2026-10-01T00:00:00.000Z' }) as Task;

describe('tests', () => {
  it('counts the tests that run by their last result; retired ones are left out', () => {
    const q = qualitySummary(
      [test('a', 'pass'), test('b', 'pass'), test('c', 'fail'), test('d', 'error'), test('e', null), test('f', 'skipped'), test('g', 'fail', { enabled: false, retiredBy: 'quarantine' })],
      [],
    );
    expect(q.passing).toBe(2);
    expect(q.failing.map((f) => f.label)).toEqual(['c', 'd']);
    expect(q.notRun).toBe(2);
    expect(q.retired).toBe(1);
    expect(testsLine(q)).toBe('2 passing · 2 failing · 2 not run yet');
  });

  it('names a failing test by its check, in words, once for its registered copies, newest first', () => {
    const q = qualitySummary(
      [
        test('mech_spawns_and_stands', 'fail', { lastRunAt: '2026-10-01T04:00:00.000Z', taskId: null }),
        test('kn6jxzv2:playtest:mech_spawns_and_stands', 'fail', { lastRunAt: '2026-10-01T03:00:00.000Z' }),
        test('mvq4jvsp:playtest:bots_fight', 'fail', { lastRunAt: '2026-10-01T05:00:00.000Z', taskId: 'task_bots' }),
      ],
      [],
    );
    expect(q.failing).toEqual([
      { label: 'bots fight', taskId: 'task_bots', lastRunAt: '2026-10-01T05:00:00.000Z', copies: 1 },
      { label: 'mech spawns and stands', taskId: null, lastRunAt: '2026-10-01T04:00:00.000Z', copies: 2 },
    ]);
    expect(testsLine(q)).toBe('0 passing · 3 failing');
    expect(testLabel('x1:luau_assert:road-not-green')).toBe('road not green');
  });

  it('says so when there are none', () => {
    expect(testsLine(qualitySummary([], []))).toBe('No tests yet');
  });
});

describe('work nobody has looked at', () => {
  it('lists finished tasks still marked "visual check pending", newest first; a settled one is gone', () => {
    const pending = `Built it.\n\nReview: fine.\n\n${VISUAL_PENDING} nobody has looked at it yet (Studio wasn't drawing); its looks are reviewed when Studio can draw again.`;
    const q = qualitySummary(
      [],
      [
        task('old', 'done', pending, '2026-10-01T01:00:00.000Z'),
        task('new', 'verified', pending, '2026-10-01T02:00:00.000Z'),
        task('settled', 'done', 'Built it.\n\nVisual check done: it looks right'),
        task('running', 'running', pending),
        task('plain', 'done', null),
      ],
    );
    expect(q.unseen.map((t) => t.id)).toEqual(['new', 'old']);
  });
});
