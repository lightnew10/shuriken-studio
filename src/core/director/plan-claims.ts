/**
 * The director must not say a plan change is done while the plan update behind it is still pending
 * (it once told the user "scoping is done" before the planner had finished). Its brief says so; this is
 * the safety net on the reply: past-tense claims that the plan changed ("scoping is done", "the plan
 * is updated", "I've updated the plan"). Plans, futures and negations ("will be updated", "is not
 * done yet", "I've asked the planner to update the plan") don't match.
 */
const CLAIM = new RegExp(
  [
    String.raw`\bscop(?:e|ing)\b[^.!?\n]{0,30}?\b(?:is|are|was|has been|have been)\s+(?:now\s+|already\s+|all\s+)?(?:done|complete|completed|finished|set|locked|updated|trimmed|narrowed)\b`,
    String.raw`\bplan\b[^.!?\n]{0,25}?\b(?:is|was|has been|'s been)\s+(?:now\s+|already\s+)?(?:updated|changed|adjusted|trimmed|narrowed|rescoped|re-?scoped|reworked|replanned|re-?planned|ready|done|final|set|locked)\b`,
    String.raw`\b(?:i|we)(?:'ve|\s+have|\s+just|\s+already)?\s+(?:updated|changed|adjusted|trimmed|narrowed|rescoped|re-?scoped|reworked|replanned|re-?planned)\s+the\s+plan\b`,
  ].join('|'),
  'i',
);

/** Whether a reply claims the plan has already changed. */
export function claimsPlanChanged(reply: string): boolean {
  return CLAIM.test(reply);
}

/** Appended to a reply that claims a plan change while its plan update is still pending. */
export const PLAN_PENDING_NOTE = "(The planner is still working on the plan update, so it isn't in the plan yet; the plan in the chat updates when it finishes.)";
