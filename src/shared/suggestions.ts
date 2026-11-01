/**
 * A suggestion bubble (the start page, the director's chat, every dock's copilot): the short label the
 * user sees, and the fuller, more specific request it puts in the box, which they can edit before sending.
 */
export interface Suggestion {
  label: string;
  prompt: string;
}

/** Bubbles from stored data: {label, prompt} objects, or plain strings from before bubbles had their own prompt. */
export function suggestionsOf(x: unknown, max = 4, maxLabel = 60): Suggestion[] {
  if (!Array.isArray(x)) return [];
  const out: Suggestion[] = [];
  for (const s of x) {
    const o = s && typeof s === 'object' ? (s as { label?: unknown; prompt?: unknown }) : null;
    const label = (typeof s === 'string' ? s : typeof o?.label === 'string' ? o.label : '').trim();
    const prompt = (typeof o?.prompt === 'string' ? o.prompt : '').trim() || label;
    if (!label || label.length > maxLabel) continue;
    out.push({ label, prompt: prompt.slice(0, 1500) });
    if (out.length >= max) break;
  }
  return out;
}
