import type { Task } from '@shared/domain';

/**
 * While the planner works on a change the user asked for, the work that existed when they asked may be
 * about to be cancelled, replaced or reshaped ("only the Griever, drop the rest"). Starting it
 * meanwhile burns usage on work the change drops, and once cost the user a second request (stale
 * tasks started before the planner got round to cancelling them). So the scheduler holds back the
 * not-yet-started tasks of that objective that existed when the change came in, until the plan update
 * finishes, fails or is cancelled. What already runs continues, and what the planner adds itself
 * starts as it adds it (live planning): the gate only holds the older work.
 *
 * The hold is short. In the user's builds a plan update waited up to 19 minutes for a free agent and then ran
 * 5 to 9 more, and every ready task of the goal sat still the whole time ("why are these not running?"). A plan
 * update now starts at once and cancels what the change drops in its first calls, so after PLAN_HOLD_MS the
 * older work starts: a task the planner cancels later is stopped then, which costs less than a team standing still.
 */
export const PLAN_HOLD_MS = 2 * 60_000;

/** Plan updates a user's change started (`Orchestrator.amendPlan`) that are waiting or running. */
export function pendingUserPlanUpdates(planTasks: readonly Task[]): Task[] {
  return planTasks.filter((t) => t.kind === 'plan' && t.createdBy === 'user' && !!t.parentId && (t.status === 'ready' || t.status === 'running'));
}

/**
 * The pending plan update that holds `task` back, or null. A task is held by an update of its own
 * objective that was asked for after the task was created (the update may cancel or reshape it).
 * Planners (an older update, a triage run) are never held: they are what releases the gate.
 */
export function heldByPlanUpdate(task: Task, pending: readonly Task[], now = Date.now()): Task | null {
  if (task.kind === 'plan' || task.kind === 'objective' || !task.parentId) return null;
  return pending.find((u) => u.id !== task.id && u.parentId === task.parentId && task.createdAt <= u.createdAt && now - new Date(u.createdAt).getTime() < PLAN_HOLD_MS) ?? null;
}
