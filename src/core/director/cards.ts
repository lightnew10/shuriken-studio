import type { ChatMessage, Escalation } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';

/**
 * The director and the cards waiting for the user (escalations). Since 1.15.8 it can clear a card at the user's word and
 * answer one with the button the user picks; cards whose task finished close by themselves (Orchestrator). Like the store
 * push and freeing Studio, the user's own words decide, not the model's reading of them.
 */

/** A card by its id ("esc_…") or by words of its title, among the open ones. */
export function findCard(p: ProjectContext, ref: string): Escalation | null {
  const open = p.governance.escalations('open');
  const r = ref.trim().replace(/^id:/i, '');
  if (!r) return null;
  const byId = open.find((e) => e.id === r);
  if (byId) return byId;
  const low = r.toLowerCase();
  return open.find((e) => e.title.toLowerCase() === low) ?? open.find((e) => e.title.toLowerCase().includes(low) || low.includes(e.title.toLowerCase())) ?? null;
}

/** The user's own message asks for a card (or cards) to be cleared, or says one no longer applies. */
export function asksClearCard(text: string): boolean {
  if (/^\s*From the [\w &-]+ copilot:/i.test(text)) return false;
  return (
    /\b(?:dismiss|clear|close|remove|delete|forget|ignore|drop|get rid of|scrap|discard|cancel)\b[\s\S]{0,60}\b(?:cards?|questions?|prompts?|approvals?|requests?|notices?|it|that|this|them|those|these)\b/i.test(text) ||
    /\b(?:no longer (?:applies|apply|relevant|needed)|(?:is|are|it'?s|that'?s) (?:outdated|out of date|stale|old|obsolete|irrelevant|not relevant)|doesn'?t apply|don'?t apply|not needed any ?more)\b/i.test(text)
  );
}

const ORDINALS: Record<string, number> = { first: 0, '1st': 0, one: 0, second: 1, '2nd': 1, two: 1, third: 2, '3rd': 2, three: 2, fourth: 3, '4th': 3, four: 3 };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The button the user picks for this card in their own words: the button's own words ("go with split into a follow-up"),
 * "option 2" / "button 2" / "the second one", or, when the director names a button, one the user's words point to.
 * Null when their message doesn't say which.
 */
export function pickedOption(card: Escalation, text: string, proposed?: string | null): string | null {
  const options = card.options ?? [];
  if (!options.length) return null;
  const t = norm(text);
  const n = /\b(?:option|button|choice|number|#)\s*(\d)\b/i.exec(text)?.[1] ?? /\b(\d)\b/.exec(t.length < 12 ? t : '')?.[1];
  if (n && options[Number(n) - 1]) return options[Number(n) - 1]!;
  const ord = /\b(first|1st|second|2nd|third|3rd|fourth|4th)\b(?:\s+(?:one|option|button|choice))?/i.exec(text)?.[1]?.toLowerCase();
  if (ord && ORDINALS[ord] !== undefined && options[ORDINALS[ord]!]) return options[ORDINALS[ord]!]!;
  // The button's own words in the message (all of a short one, the first three words of a long one).
  const named = options.find((o) => {
    const words = norm(o).split(' ').filter(Boolean);
    const probe = words.slice(0, Math.min(3, words.length)).join(' ');
    return probe.length >= 2 && (t === norm(o) || (` ${t} `).includes(` ${probe} `));
  });
  if (named) return named;
  // What the director proposed, when it is a button and the user's words agree with it in a word that tells it apart.
  const want = proposed ? options.find((o) => norm(o) === norm(proposed)) : null;
  if (want) {
    const distinct = norm(want).split(' ').filter((w) => w.length >= 4 && !options.some((o) => o !== want && norm(o).split(' ').includes(w)));
    if (distinct.some((w) => (` ${t} `).includes(` ${w} `))) return want;
  }
  return null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'about', 'into', 'still', 'needs', 'need', 'card', 'cards', 'task', 'tasks', 'user']);
const keyWords = (title: string) => [...new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];

/** How many of the director's replies since the card opened talked about it (two of its title's words, at least). */
export function timesSaid(card: Escalation, replies: ChatMessage[]): number {
  const words = keyWords(card.title);
  if (words.length < 2) return 0;
  return replies.filter((m) => m.createdAt >= card.createdAt && words.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(m.text)).length >= 2).length;
}
