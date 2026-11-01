import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../projects/project-service';

/**
 * The planner's notes for the whole project (.shuriken/planner-notes.md): the user's standing instructions ("use Kiln
 * for every model", "no QA passes", "phone first") and the decisions the planner wants to keep. Every planning run
 * reads them and may add to them; the director adds what the user says should hold from now on. They are the planner's
 * memory that outlives any one conversation (orchestrator/planner-session.ts): on the mech build the user had to say
 * "use Kiln" four times, because each planning run started from nothing.
 */

export const PLANNER_NOTES_FILE = 'planner-notes.md';
/** Kept short: they go into every planning run. */
export const PLANNER_NOTES_MAX = 8000;

const pathOf = (p: ProjectContext) => join(p.dir, PLANNER_NOTES_FILE);

export function readPlannerNotes(p: ProjectContext): string {
  try {
    return existsSync(pathOf(p)) ? readFileSync(pathOf(p), 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/** Adds one note ("- 2026-10-07, the user: always use Kiln for models"); the oldest planner notes go first when it is full. */
export function appendPlannerNote(p: ProjectContext, who: 'user' | 'planner', text: string): string {
  const line = `- ${new Date().toISOString().slice(0, 10)}, ${who === 'user' ? 'the user' : 'planner'}: ${text.replace(/\s+/g, ' ').trim().slice(0, 600)}`;
  const lines = readPlannerNotes(p).split('\n').filter((l) => l.trim());
  lines.push(line);
  // Over the cap: drop the planner's oldest notes first; the user's instructions stay as long as possible.
  while (lines.join('\n').length > PLANNER_NOTES_MAX && lines.length > 1) {
    const i = lines.findIndex((l) => /, planner: /.test(l));
    lines.splice(i >= 0 ? i : 0, 1);
  }
  writeNotes(p, lines.join('\n'));
  return line;
}

/** The planner rewrites its notes (merges, drops what no longer holds); the user's instructions must stay unless they withdrew them. */
export function rewritePlannerNotes(p: ProjectContext, text: string): string {
  const body = text.trim().slice(0, PLANNER_NOTES_MAX);
  writeNotes(p, body);
  return body;
}

function writeNotes(p: ProjectContext, body: string): void {
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(pathOf(p), `${body}\n`, 'utf8');
}
