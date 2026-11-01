import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';

/**
 * The planner's rules after the first single-prompt A–Z build (8 hours, about 3 agents busy on average): every wait in
 * that build came from the task graph. Wiring tasks claimed another system's folder and waited for whole systems,
 * atmosphere and set pieces waited 67 minutes for the layout's review, and 103 of 262 playtests waited 15 s for a
 * character that never spawned because the game opens in a garage.
 */
const planner = ROLES.executive!.instructions;
const rules = planner.slice(planner.indexOf('Dependency rules'), planner.indexOf('The user watches the game take shape'));

describe('the planner brief: less waiting, more at once', () => {
  it('says a dependent starts when the work exists, and keeps strict for final test and QA tasks', () => {
    expect(rules).toMatch(/A dependent starts when the work it depends on EXISTS[^.]*not when it is\s+reviewed/);
    expect(rules).toMatch(/Mark a dependency strict \(strictDependsOn\) only\s+on the final test and QA tasks/);
    expect(planner).toMatch(/a task starts running the moment the work it depends on\s+exists/);
  });

  it('has wiring tasks attach through hooks the contract spec defines, with exact files', () => {
    expect(rules).toMatch(/Wiring tasks \(sounds, effects, UI readouts into a system\) attach through hooks the contract spec\s+defines: signals, attributes, an events module/);
    expect(rules).toMatch(/Write the hooks into the spec \(spec_propose\)\s+before the tasks/);
    expect(rules).toMatch(/lists those exact files, never another system's folder/);
    expect(rules).toMatch(/depends only on the task that creates\s+the hook module, never on the whole system/);
    // The older wording that made a wiring task wait for the whole system it wires is gone.
    expect(planner).not.toMatch(/depends\s+only on the code task and the assets it wires/);
    expect(planner).not.toMatch(/only a small "wire it in" task depends on what it wires, and only on that/);
  });

  it('starts lighting, atmosphere, audio and effects without the layout, and decoration on the layout file', () => {
    expect(rules).toMatch(/Lighting, atmosphere, and the audio and effects libraries don't depend on the map layout: they\s+start at once/);
    expect(rules).toMatch(/Decoration depends only on the layout task \(its layout file existing\), never on\s+its review/);
    // The first wave has them; the second wave no longer puts all environment art behind "the finished layout".
    expect(planner).toMatch(/Right away, in parallel \(dependsOn \[\]\): the map's GRAYBOX \(level-designer/);
    expect(planner).toMatch(/lighting and atmosphere\s+\(environment-artist\)/);
    expect(planner).not.toMatch(/on the finished layout/);
  });

  it('gives a game that opens in a menu, lobby or garage a Studio-only test hook in its first gameplay task', () => {
    expect(rules).toMatch(/A game that opens in a menu, lobby or garage/);
    expect(rules).toMatch(/Studio-only test hook that goes straight into play, built by its FIRST gameplay task and named in\s+the spec/);
    expect(rules).toMatch(/every playtest and check calls it/);
  });

  it('asks every UI task for a phone layout of each screen, checked with ui_audit at phone size', () => {
    // The garage screen was built once for desktop and shrunk onto phones with a UIScale fit: tiny text and tap targets.
    expect(planner).toMatch(/Every UI task's acceptance criteria name the phone layout of each screen it builds/);
    expect(planner).toMatch(/a re-layout\s+for narrow screens: stacked panels, bigger tap targets, never the desktop layout scaled down/);
    expect(planner).toMatch(/ui_audit at phone size reports no problem for each of those screens/);
    expect(ROLES.critic!.instructions).toMatch(/A screen that is only the desktop layout scaled down to fit a phone \(tiny text and tap targets\) fails\./);
  });

  it('stays short: the rules replaced older lines instead of piling on', () => {
    // 1.9's brief was 12,000 characters before COMMON; these rules added a handful of lines, not a page.
    expect(rules.split('\n').length).toBeLessThanOrEqual(40);
  });
});
