import type { Task } from '@shared/domain';
import type { MethodResult } from '../verification/verifier';

/**
 * When a task's automated checks are review enough. The critic is an independent agent run (about half a dollar and
 * a minute or two each, with playtests of its own): in the user's simple parkour game it ran 30 times and was a
 * quarter of the build's cost, most of it on one- and two-file fixes whose playtest check had just passed. Its
 * rejections (4 of 64 reviews that afternoon) were all on larger work. So a small code fix that a functional check
 * already proved skips the critic; everything that has to be looked at, and everything large, keeps it.
 */

/** Roles whose work is code and is proven by running it (looks, levels, models and security always get eyes). */
const CODE_ROLES: ReadonlySet<string> = new Set(['roblox-engineer', 'luau-engineer']);
/** Checks that run the game or assert on it. */
const FUNCTIONAL: ReadonlySet<string> = new Set(['playtest', 'luau_assert']);
/**
 * The most files a small fix touches. Four since 1.13.5 (was two): in two builds the reviewer looked at 47 finished
 * tasks of the code roles, most of them three to six files, and rejected none; reviews cost about $0.70 each.
 */
export const SMALL_FIX_FILES = 4;

export interface LightReview {
  /** Why no critic ran, for the task's result and the timeline. */
  why: string;
}

/**
 * The reason this task needs no critic run, or null (the critic reviews it). All of: a code role, its first attempt,
 * at most SMALL_FIX_FILES files edited (and at least one), a functional check that passed, no check that needs a
 * look (a screenshot, or one left undecided), and none of its acceptance criteria about looks.
 */
export function lightReview(task: Pick<Task, 'kind' | 'role' | 'attempts' | 'acceptanceCriteria'>, editedFiles: readonly string[], results: readonly MethodResult[]): LightReview | null {
  if (task.kind !== 'implement' || !CODE_ROLES.has(task.role)) return null;
  if (task.attempts > 1) return null;
  const files = [...new Set(editedFiles)].filter((f) => /\.(luau|lua|json)$/i.test(f));
  if (files.length === 0 || files.length > SMALL_FIX_FILES || files.length !== new Set(editedFiles).size) return null;
  const decided = results.filter((r) => r.kind !== 'critic');
  if (decided.some((r) => r.passed !== true)) return null;
  if (decided.some((r) => r.kind === 'screenshot')) return null;
  const proven = decided.filter((r) => FUNCTIONAL.has(r.kind));
  if (proven.length === 0) return null;
  if (task.acceptanceCriteria.some((c) => /\b(looks?|visual\w*|visibl\w*|screenshot|readable|reads|colou?rs?|layout|animat\w*|feels?)\b/i.test(c))) return null;
  return { why: `A small code change (${files.length} file${files.length === 1 ? '' : 's'}) proven by ${proven.length === 1 ? `its check ${proven[0]!.name}` : `${proven.length} checks that run the game`}: no separate review was needed.` };
}
