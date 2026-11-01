import type { Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { roleLabel, type ReviewOutput } from '../agents/roles';
import { COMPLETE } from '../tasks/task-graph';

/**
 * Review without eyes. Studio can't take pictures while it isn't drawing (minimized, the display off, a dead capture tool), and
 * work is never held up for that: in the first A–Z build 12 of 38 critic reviews passed with no visual check. A task
 * that passed without the look it needed is marked "visual check pending" (a note on the task and a line in its
 * result). When Studio can draw again — a roblox_screenshot that returned a picture is the signal — one critic run
 * looks at all the pending tasks together, at the latest right before the objective's final regression suite. If
 * Studio still can't draw then, the objective closes and the user is told plainly which tasks nobody looked at.
 */

/** Title of the note on a task that passed review without anyone seeing its result. */
export const VISUAL_PENDING = 'Visual check pending';
/** Title of the note that settles it: the looks were reviewed (passed), or reviewed and found wanting (not passed: a fix task follows). */
export const VISUAL_DONE = 'Visual check done';
/** Title prefix of the task that fixes what the later look found. */
export const LOOKS_FIX_PREFIX = 'Fix the look of';
/** The line added to such a task's result. */
export const PENDING_LINE = `${VISUAL_PENDING}: nobody has looked at it yet (Studio wasn't drawing); its looks are reviewed when Studio can draw again.`;

const NOT_DRAWING = 'studio_not_drawing';
const env = (data: unknown): string | null => (data && typeof data === 'object' ? ((data as { environment?: string }).environment ?? null) : null);

/**
 * Whether a review that passed left the task's looks unseen: the reviewer says so (`visualCheck: "not_possible"`), or
 * a screenshot was wanted since `since` (the verifier's check or the reviewer's own roblox_screenshot said Studio
 * isn't drawing) and none was taken, and the reviewer doesn't say it looked another way or that nothing needs a look.
 */
export function passedUnseen(p: ProjectContext, task: Task, review: Pick<ReviewOutput, 'visualCheck'>, since: string, reviewRunId: string | null): boolean {
  if (review.visualCheck === 'not_possible') return true;
  if (review.visualCheck === 'done' || review.visualCheck === 'not_needed') return false;
  const evidence = p.tasks.evidence(task.id).filter((e) => e.createdAt >= since);
  if (evidence.some((e) => e.kind === 'screenshot')) return false;
  const wanted = evidence.some((e) => e.kind === 'note' && env(e.data) === NOT_DRAWING);
  const blind = !!reviewRunId && p.audit.toolCalls({ runId: reviewRunId, limit: 200 }).some((c) => c.tool === 'roblox_screenshot' && env(c.result) === NOT_DRAWING);
  return wanted || blind;
}

/** When the task was marked pending and not settled since (ISO), or null. */
export function pendingSince(p: ProjectContext, taskId: string): string | null {
  const last = p.tasks.evidence(taskId).filter((e) => e.kind === 'note' && (e.title === VISUAL_PENDING || e.title === VISUAL_DONE)).at(-1);
  return last?.title === VISUAL_PENDING ? last.createdAt : null;
}

/** The finished tasks of an objective whose looks nobody has seen yet. */
export function pendingLooks(p: ProjectContext, objectiveId: string): Task[] {
  return p.tasks.list({ parentId: objectiveId }).filter((t) => COMPLETE.has(t.status) && pendingSince(p, t.id) !== null);
}

/**
 * Whether Studio has been seen drawing since `since`: the latest screenshot sign after it is a picture (a
 * roblox_screenshot call that returned one, or a screenshot saved as evidence), not a "Studio isn't drawing".
 */
export function studioDrawsSince(p: ProjectContext, since: string): boolean {
  const call = p.store.get<{ status: string; result: string | null; started_at: string }>("SELECT status, result, started_at FROM tool_calls WHERE tool = 'roblox_screenshot' AND status != 'pending' AND started_at > ? ORDER BY started_at DESC LIMIT 1", [since]);
  const ev = p.store.get<{ kind: string; created_at: string }>(`SELECT kind, created_at FROM task_evidence WHERE created_at > ? AND (kind = 'screenshot' OR (kind = 'note' AND data LIKE '%${NOT_DRAWING}%')) ORDER BY created_at DESC LIMIT 1`, [since]);
  const signs: Array<{ at: string; drew: boolean }> = [];
  if (call) signs.push({ at: call.started_at, drew: call.status === 'ok' && !(call.result ?? '').includes(NOT_DRAWING) });
  if (ev) signs.push({ at: ev.created_at, drew: ev.kind === 'screenshot' });
  signs.sort((a, b) => a.at.localeCompare(b.at));
  return signs.at(-1)?.drew === true;
}

/** The reviewer's directive for looking at several tasks whose looks nobody has seen. */
export const LOOKS_DIRECTIVE = [
  'Look at the finished work of the tasks listed below. They passed their checks and review while Studio was not drawing, so nobody has seen them; Studio can draw again now.',
  'For each task take your own pictures (roblox_screenshot from 2-3 angles of what it built; model_view, animation_view, ui_audit or map_audit where they fit) and judge its LOOKS against its acceptance criteria and the visual quality bar. Do not review code or behaviour again, and change nothing.',
  'Return the structured review: criteria has one entry per task, criterion "[<task id>] <title>", met = it looks right, evidence = what you saw. Give each visual problem as a defect whose title starts with the task id in square brackets. verdict "fail" when any task looks wrong. visualCheck: "done".',
  'If roblox_screenshot says Studio isn\'t drawing, stop looking: return verdict "pass", empty criteria and defects, and visualCheck: "not_possible".',
].join('\n');

/** The tasks to look at, as the reviewer's context. */
export function looksContext(tasks: readonly Task[]): string {
  return tasks
    .map((t) => {
      const shots = t.verification.filter((m) => m.kind === 'screenshot').map((m) => `  - What a screenshot should show: ${m.instructions}${m.camera && m.lookAt ? ` (camera ${m.camera.join(', ')} looking at ${m.lookAt.join(', ')})` : ''}`);
      return [`- [${t.id}] ${t.title} (${roleLabel(t.role)})`, `  What was built: ${(t.result ?? t.objective).split('\n')[0]!.slice(0, 400)}`, ...t.acceptanceCriteria.slice(0, 8).map((c) => `  - Criterion: ${c}`), ...shots].join('\n');
    })
    .join('\n');
}

export interface Looks {
  /** Studio still wasn't drawing: nothing was looked at. */
  notPossible: boolean;
  /** Tasks whose looks are fine, with what the reviewer saw. */
  fine: Array<{ task: Task; seen: string }>;
  /** Tasks with visual problems, and the problems as a list for the fix task. */
  wrong: Array<{ task: Task; findings: string }>;
}

/** What a look at several tasks came to, task by task (a task the review doesn't mention stays pending). */
export function readLooks(review: ReviewOutput | null, tasks: readonly Task[]): Looks {
  const out: Looks = { notPossible: !review || review.visualCheck === 'not_possible', fine: [], wrong: [] };
  if (!review || out.notPossible) return out;
  for (const task of tasks) {
    const entry = review.criteria.find((c) => c.criterion.includes(task.id));
    const defects = review.defects.filter((d) => `${d.title} ${d.detail}`.includes(task.id));
    if (!entry && !defects.length) continue;
    if (entry?.met !== false && !defects.length) {
      out.fine.push({ task, seen: entry?.evidence ?? '' });
      continue;
    }
    const strip = (x: string) => x.replace(`[${task.id}]`, '').trim();
    const findings = [...(entry && !entry.met ? [`- ${entry.evidence}`] : []), ...defects.map((d) => `- [${d.severity}] ${strip(d.title)}: ${d.detail}\n  Fix: ${d.fix}`)].join('\n');
    out.wrong.push({ task, findings });
  }
  return out;
}

/** The plain sentence for the user about tasks nobody looked at. */
export function uncheckedLine(objectiveTitle: string, tasks: readonly Task[]): string {
  const names = tasks.slice(0, 8).map((t) => `"${t.title}"`).join(', ');
  return `Nobody has looked at ${tasks.length === 1 ? 'one task' : `${tasks.length} tasks`} of "${objectiveTitle}": Studio wasn't drawing (minimized, the display off, or its screen capture stopped answering), so ${tasks.length === 1 ? 'its' : 'their'} checks passed without a visual review: ${names}${tasks.length > 8 ? `, and ${tasks.length - 8} more` : ''}. Bring Studio into view and ask me to review how ${tasks.length === 1 ? 'it looks' : 'they look'}.`;
}
