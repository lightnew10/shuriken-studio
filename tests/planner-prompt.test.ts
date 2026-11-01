import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';

/**
 * The planner's brief decides how wide the task graph is (a Griever goal once ran 215 minutes with
 * agents idle 43% of the time, chains 6-7 deep for 8-10 tasks, because the brief taught a serial
 * order). These pin the rules that keep plans wide, in words robust to rewording.
 */
const planner = ROLES.executive!.instructions;

describe('the planner brief: wide plans, short chains', () => {
  it('plans a creature in parallel instead of model+rig → clips → AI', () => {
    expect(planner).not.toMatch(/Order: model\+rig/);
    expect(planner).toMatch(/creature in parallel, not as a pipeline/);
    // Model+rig, its sounds, its effects and level work start together; clips wait for the rig only.
    expect(planner).toMatch(/model\+rig \(modeler\), its sounds[^.]*its effects and any level work all\s+start together/);
    expect(planner).toMatch(/clips start when the rig exists\s+\(dependsOn the model\+rig task only\)/);
    // The AI starts with the clips and calls them (and the sounds) by their planned names.
    expect(planner).toMatch(/AI task starts together with the clips, not after them/);
    expect(planner).toMatch(/planned names/);
    expect(planner).toMatch(/"wire it in" tasks depend only on what they wire/);
  });

  it('states the general dependency rules', () => {
    for (const rule of [
      /dependsOn only when a task literally consumes another's OUTPUT/,
      /Assets are created independently of code/,
      /No QA or playtest task depends on another QA task/,
      /Modelers and Kiln requests for different models\s+run in parallel/,
      /A new version never depends on the task it replaces/,
      /Chains at most 3 tasks deep/,
      /Playable early: first a rough but working pass of the core loop/,
    ]) {
      expect(planner).toMatch(rule);
    }
  });

  it("no longer ties a whole sound task to the feature it belongs to, and denies Kiln is one-at-a-time", () => {
    // The old wording made the planner chain a sound task after the AI task (181 minutes of waiting).
    expect(planner).not.toMatch(/to\s+land right after it/);
    expect(planner).toMatch(/a whole sound or effects task never\s+waits for a feature/);
    expect(planner).toMatch(/every model has its own Blender\/Kiln project/);
  });

  it('asks for a wide first wave: sounds and effects start with the code, not after it', () => {
    expect(planner).toMatch(/audio\s+\(sound-designer\), effects \(vfx-artist\)/);
    expect(planner).not.toMatch(/after the systems, animations \(animator\) and effects/);
  });
});
