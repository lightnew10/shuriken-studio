import type { FinalCheck } from '@shared/events';

/** The card the Agents panel shows for a goal's final review while it runs (no agent run stands for it). */
export interface FinalReviewCard {
  objectiveId: string;
  title: string;
  role: string;
  action: string;
  elapsedMs: number;
  /** How long it has held Studio (null: not in Studio). */
  studioMs: number | null;
}

export function finalReviewCard(check: FinalCheck | null | undefined, now = Date.now()): FinalReviewCard | null {
  if (!check) return null;
  const what = check.iteration ? 'checks' : 'regression suite';
  const action = check.check
    ? `Running ${check.check} (${Math.min(check.done + 1, Math.max(check.total, 1))} of ${check.total})`
    : check.total
      ? `${check.studioSince ? 'Starting' : 'Waiting for Studio to start'} the ${what} (${check.total} check${check.total === 1 ? '' : 's'})`
      : `Running the ${what}`;
  return {
    objectiveId: check.objectiveId,
    title: `Final review · ${check.title}`,
    role: 'Final reviewer',
    action,
    elapsedMs: Math.max(0, now - Date.parse(check.startedAt)),
    studioMs: check.studioSince ? Math.max(0, now - Date.parse(check.studioSince)) : null,
  };
}
