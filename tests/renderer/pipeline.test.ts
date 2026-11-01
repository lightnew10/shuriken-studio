import { describe, expect, it } from 'vitest';
import { finalReviewCard } from '../../src/renderer/src/lib/pipeline';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const base = { objectiveId: 'task_goal', title: 'Hoverboard Racing', iteration: false, check: null, done: 0, total: 118, startedAt: '2026-10-05T11:52:00.000Z', studioSince: null };

describe('the final reviewer in the Agents panel', () => {
  it('is no card when no final review runs', () => {
    expect(finalReviewCard(null, NOW)).toBeNull();
    expect(finalReviewCard(undefined, NOW)).toBeNull();
  });

  it('shows the goal, the check it runs, how far it is, how long it has run and held Studio', () => {
    const card = finalReviewCard({ ...base, check: 'lobby_spawn_walk', done: 102, studioSince: '2026-10-05T11:54:00.000Z' }, NOW)!;
    expect(card).toEqual({ objectiveId: 'task_goal', title: 'Final review · Hoverboard Racing', role: 'Final reviewer', action: 'Running lobby_spawn_walk (103 of 118)', elapsedMs: 8 * 60_000, studioMs: 6 * 60_000 });
  });

  it('says it waits for Studio before its turn, and names a quick change\'s checks', () => {
    expect(finalReviewCard(base, NOW)!.action).toBe('Waiting for Studio to start the regression suite (118 checks)');
    expect(finalReviewCard({ ...base, iteration: true, total: 3, studioSince: '2026-10-05T11:59:00.000Z' }, NOW)!.action).toBe('Starting the checks (3 checks)');
    expect(finalReviewCard({ ...base, total: 0 }, NOW)!.action).toBe('Running the regression suite');
  });
});
