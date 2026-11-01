/**
 * What a build cost at Anthropic API prices (core/costs/build-cost.ts), as the top bar's cost chip shows it. The
 * Claude SDK reports an API-price cost for every run, on a subscription too, and Kiln's transcript does for its builds:
 * this adds them up per project, so one number says what the whole build would have cost.
 */

export type CostCategoryId = 'building' | 'planning' | 'reviews' | 'director' | 'copilots' | 'kiln' | 'research' | 'helpers';

/** The groups a build's cost is shown in, in the order they are listed when they cost the same. */
export const COST_CATEGORIES: ReadonlyArray<{ id: CostCategoryId; label: string }> = [
  { id: 'building', label: 'Building' },
  { id: 'planning', label: 'Planning' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'director', label: 'Director & chat' },
  { id: 'copilots', label: 'Copilots' },
  { id: 'kiln', label: 'Kiln models' },
  { id: 'research', label: 'Research' },
  { id: 'helpers', label: 'Small helpers' },
];

export interface BuildCost {
  /** Every run and booked call of the project, Kiln's builds included, in US dollars at API prices. */
  totalUsd: number;
  /** Only the groups that have something, the most expensive first. */
  categories: Array<{ id: CostCategoryId; label: string; usd: number; runs: number }>;
  /** Each goal (objective) with what its tasks' runs cost, oldest goal first. */
  goals: Array<{ id: string; title: string; usd: number; status: string }>;
  kilnUsd: number;
  /** The first and the last run or call counted (ISO), null when there is none. */
  since: string | null;
  until: string | null;
}

export const EMPTY_BUILD_COST: BuildCost = { totalUsd: 0, categories: [], goals: [], kilnUsd: 0, since: null, until: null };

/** "$48.20"; "$0.04" under a dollar; "<$0.01" for a fraction of a cent that isn't nothing. */
export function usdText(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.005) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The line under the cost: what the number is, and that a subscription pays it in usage rather than money. */
export const COST_NOTE = "What this build would cost at Anthropic API prices, Kiln models included. On a Claude subscription it comes out of your plan's usage instead.";
