export const CLAUDE_MODEL_FAMILIES = ['haiku', 'sonnet', 'opus'] as const;
export type ClaudeModelFamily = (typeof CLAUDE_MODEL_FAMILIES)[number];
export type SubscriptionProvider = 'claude' | 'codex';
export type ModelBlocks = Record<SubscriptionProvider, string[]>;

export function claudeModelFamily(id: string): ClaudeModelFamily | undefined {
  return CLAUDE_MODEL_FAMILIES.find((family) =>
    new RegExp(`^(?:claude-(?:[0-9]+-)?)?${family}(?:$|[-.\\[])`, 'i').test(id));
}
