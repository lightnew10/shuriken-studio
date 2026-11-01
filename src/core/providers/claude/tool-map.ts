import type { BuiltinToolClass } from '../types';

/**
 * Claude Code built-in tool names per abstract tool class. This mapping is part of the adapter's
 * repair boundary: if Claude Code renames or adds tools, only this file changes.
 */
export const CLAUDE_TOOLS: Record<BuiltinToolClass, string[]> = {
  read_files: ['Read', 'Glob', 'Grep'],
  edit_files: ['Edit', 'Write', 'NotebookEdit'],
  shell: ['Bash', 'PowerShell', 'BashOutput', 'KillShell'],
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
  subagents: ['Agent'],
  todo: ['TodoWrite'],
};

const REVERSE = new Map<string, BuiltinToolClass>();
for (const [cls, names] of Object.entries(CLAUDE_TOOLS) as Array<[BuiltinToolClass, string[]]>) {
  for (const n of names) REVERSE.set(n, cls);
}
// Aliases seen across Claude Code versions.
REVERSE.set('Task', 'subagents');
REVERSE.set('MultiEdit', 'edit_files');
REVERSE.set('LS', 'read_files');

export function classifyClaudeTool(name: string): BuiltinToolClass | 'mcp' | 'other' {
  if (name.startsWith('mcp__')) return 'mcp';
  return REVERSE.get(name) ?? 'other';
}

export function claudeToolsFor(classes: BuiltinToolClass[]): string[] {
  const out = new Set<string>();
  for (const c of classes) for (const n of CLAUDE_TOOLS[c]) out.add(n);
  return [...out];
}

/** Split `mcp__server__tool` into its parts. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}
