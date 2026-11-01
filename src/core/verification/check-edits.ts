import type { Task, VerificationMethod } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { TestService, checkName, testName } from './test-service';

/**
 * Editing a task's own list of checks (`task_update_verification`, an answer that drops a check from a task's
 * verification). A task's checks are copies of what it asked for; the registered tests are what the regression
 * suite runs. Dropping a check also retires the test the task itself registered for it, so the suite does not
 * keep asking for what the task no longer does. A reference to someone else's test is only dropped from the task.
 */

export interface CheckSplit {
  kept: VerificationMethod[];
  dropped: VerificationMethod[];
  /** Entries of `wanted` that matched no check. */
  unknown: string[];
}

/** The keys a check answers to: its name, its registered test's name, the test id it references. */
function keysOf(taskId: string, m: VerificationMethod): string[] {
  const ref = 'testId' in m ? m.testId : undefined;
  return [checkName(m).toLowerCase(), testName(taskId, m).toLowerCase(), ...(ref ? [ref.toLowerCase()] : [])];
}

/** Splits a task's checks by what is wanted gone (names or test ids, case-insensitive). Static analysis and the critic always stay. */
export function splitChecks(task: Task, wanted: readonly string[]): CheckSplit {
  const lowered = new Set(wanted.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const matched = new Set<string>();
  const kept: VerificationMethod[] = [];
  const dropped: VerificationMethod[] = [];
  for (const m of task.verification) {
    const keys = keysOf(task.id, m);
    const hit = m.kind !== 'critic' && m.kind !== 'static_analysis' && keys.some((k) => lowered.has(k));
    if (hit) keys.filter((k) => lowered.has(k)).forEach((k) => matched.add(k));
    (hit ? dropped : kept).push(m);
  }
  return { kept, dropped, unknown: wanted.map((x) => x.trim()).filter((x) => x && !matched.has(x.toLowerCase())) };
}

/** Retires the tests the task registered itself for the dropped checks. Returns their names. */
export function retireOwnTests(p: ProjectContext, task: Task, dropped: readonly VerificationMethod[], reason: string, by: string): string[] {
  const svc = new TestService(p.store);
  const out: string[] = [];
  for (const m of dropped) {
    if ('testId' in m && m.testId) continue; // someone else's test: retire it with test_retire if it is wrong
    const name = testName(task.id, m);
    const own = svc.find(name).find((x) => x.taskId === task.id && x.name === name);
    const done = own ? svc.retire(own.id, reason, by) : null;
    if (done) out.push(done.name);
  }
  return out;
}

/** The title of the evidence a worker's change to its own check's probe leaves (the check's name follows). */
export const PROBE_AMENDED = 'Probe amended by the worker:';

export interface ProbeAmendment {
  check: string;
  reason: string;
  by: string | null;
  /** The probes before and after, each with the side it runs on. */
  before: Array<{ side: string; code: string }>;
  after: Array<{ side: string; code: string }>;
}

/** The probe amendments recorded on a task (task_fix_probe), oldest first. */
export function probeAmendments(p: ProjectContext, taskId: string): ProbeAmendment[] {
  return p.tasks
    .evidence(taskId)
    .filter((e) => e.kind === 'note' && e.title.startsWith(PROBE_AMENDED))
    .map((e) => e.data as ProbeAmendment)
    .filter((a) => !!a && typeof a.check === 'string');
}

/**
 * What the critic is shown when the worker changed a probe of its own task: the reason, the old probe and the
 * new one, and what to judge. Empty when no probe was changed.
 */
export function amendmentNotes(p: ProjectContext, taskId: string): string {
  const all = probeAmendments(p, taskId);
  if (!all.length) return '';
  const show = (probes: ProbeAmendment['before']) => probes.map((x) => `[runs on: ${x.side}]\n${x.code.length > 4000 ? `${x.code.slice(0, 4000)}\n… (cut)` : x.code}`).join('\n') || '(none)';
  return [
    `The worker changed the probe of ${all.length === 1 ? 'a check' : `${all.length} checks`} of this task (allowed when the probe, not the game, was wrong). Judge each change: the new probe must still test what the acceptance criteria ask, at least as strictly as the old one meant to. A probe weakened so that broken work passes is a defect: reject the task for it.`,
    ...all.map((a) => `Check "${a.check}" — the worker's reason: ${a.reason}\n--- old probe\n${show(a.before)}\n--- new probe\n${show(a.after)}`),
  ].join('\n\n');
}

/** What a check is called to a person: its name, or its kind for static analysis and the critic. */
export function checkLabel(m: VerificationMethod): string {
  return m.kind === 'critic' || m.kind === 'static_analysis' ? m.kind : checkName(m);
}
