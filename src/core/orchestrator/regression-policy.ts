import type { Task, TestCase, VerificationMethod } from '@shared/domain';
import type { MethodResult } from '../verification/verifier';
import { checkName } from '../verification/test-service';

/**
 * What the objective wrap-up does about a failing regression suite (pure, unit-tested). A 4.6 h build spent
 * $11.50 and seven user prompts on five "Fix regressions" tasks for one test that no state of the game could
 * pass, because a replaced task's frozen check contradicted its replacement's. The rules here keep that loop
 * from forming: one repair task per failure, then quarantine; never two open repair tasks; a cap, then the user.
 */

/** Title prefix of the repair task the wrap-up creates for a failing suite. */
export const FIX_PREFIX = 'Fix regressions';
/** A hard cap on repair tasks per objective: past it the wrap-up asks the user instead of making another. */
export const MAX_FIX_TASKS = 3;
/** Title of the question raised when the suite keeps failing. */
export const STUCK_TITLE = 'The regression suite keeps failing';

export const isFixTask = (t: Task): boolean => t.kind === 'implement' && t.title.startsWith(FIX_PREFIX);

/** The registered test a check stands for, if it references one. */
export const checkRef = (m: VerificationMethod): string | undefined => ('testId' in m ? m.testId : undefined);

export interface FailureTriage {
  /** Registered tests that still fail after a repair task had its go: quarantined, they no longer block anything. */
  quarantine: string[];
  /** Failing tests no repair task has tried yet. */
  repair: MethodResult[];
  /** Failures that are not registered tests (code sync, Studio access): one repair, then the user. */
  untracked: MethodResult[];
}

/**
 * Sorts a failed suite's failures. `repaired` holds the test ids earlier repair tasks of this objective were
 * created for: a test among them that still fails is quarantined instead of getting another repair task.
 */
export function triageFailures(failing: readonly MethodResult[], repaired: ReadonlySet<string>): FailureTriage {
  const quarantine = new Set<string>();
  const repair: MethodResult[] = [];
  const untracked: MethodResult[] = [];
  for (const r of failing) {
    const ids = r.testIds ?? [];
    if (!ids.length) {
      untracked.push(r);
      continue;
    }
    if (ids.some((id) => repaired.has(id))) ids.forEach((id) => quarantine.add(id));
    else repair.push(r);
  }
  return { quarantine: [...quarantine], repair, untracked };
}

/** The checks a repair task re-runs: the failing tests, by reference (their current spec, skipped once retired). */
export function repairChecks(tests: readonly TestCase[], failing: readonly MethodResult[]): VerificationMethod[] {
  const ids = new Set(failing.flatMap((r) => r.testIds ?? []));
  const seen = new Set<string>();
  const out: VerificationMethod[] = [];
  for (const t of tests) {
    if (!ids.has(t.id) || !t.enabled || t.spec.kind === 'static_analysis' || t.spec.kind === 'critic') continue;
    // Identical checks (copies registered by several tasks) are one check here; the reference names the first.
    const key = JSON.stringify({ ...t.spec, name: undefined, testId: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...t.spec, testId: t.id } as VerificationMethod);
  }
  return out;
}

// ─── Answers to a question about a test ──────────────────────────────────────

const VERB = /\b(retire|retiring|retired|drop|dropping|disable|remove|delete|skip|ignore|quarantine|get rid of|turn off|stop running|stop checking)\b/i;
/** "… from this task's verification": the check goes from that task only. */
const TASK_ONLY = /\b(?:from|in)\s+(?:this|the|that)\s+task(?:'s|s')?(?:\s+own)?\s+(?:verification|checks?|tests?)\b|\bfrom\s+(?:this|the|that)\s+task\b|\btask(?:'s|s')?\s+verification\b/i;
/** "drop it", "retire that test": the test the question was about (a bare "skip that" is not enough to retire anything). */
const ANAPHORIC_ACTION = /\b(?:retire|drop|disable|remove|delete|quarantine)\s+(?:it|them|those|that|this|the\s+(?:failing\s+|broken\s+)?(?:test|check)s?|(?:that|this)\s+(?:test|check))\b|\b(?:get rid of|turn off)\s+(?:it|that|this|the\s+(?:test|check))\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, name: string) => name.length >= 4 && new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'i').test(text);

export interface AnswerPlan {
  /** The tests the answer is about. */
  tests: TestCase[];
  /** 'task': the answer says the check goes from the task's verification; 'global': the test itself is retired. */
  scope: 'task' | 'global';
}

/**
 * What the user's answer to a question about a failing check asks for, when it retires or drops a test: a
 * verb (retire, drop, disable, skip, remove…) plus the test it names ("Retire road_not_green") or, with "it" /
 * "that test", the test(s) the question's own text names. "… from this task's verification" is task-scoped.
 * Static analysis is never retired by an answer. Null when the answer is about something else.
 */
export function answerPlan(response: string, tests: readonly TestCase[], questionText: string): AnswerPlan | null {
  if (!VERB.test(response)) return null;
  const candidates = tests.filter((t) => !t.retiredAt && t.spec.kind !== 'static_analysis' && t.spec.kind !== 'critic');
  const named = (text: string) => candidates.filter((t) => mentions(text, t.name) || (checkName(t.spec) !== t.spec.kind && mentions(text, checkName(t.spec))));
  let picked = named(response);
  if (!picked.length && ANAPHORIC_ACTION.test(response)) {
    // The question names what failed; prefer the ones still failing.
    const inQuestion = named(questionText);
    const failing = inQuestion.filter((t) => t.lastStatus === 'fail');
    picked = failing.length ? failing : inQuestion;
  }
  if (!picked.length) return null;
  return { tests: picked, scope: TASK_ONLY.test(response) ? 'task' : 'global' };
}
