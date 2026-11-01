import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';

/**
 * A 4.6 h build: cars_integrate and env_art waited 96 minutes on the track model although the cars and
 * the physics were done. The planner's brief says integration and gameplay work starts on a placeholder.
 */
describe('the planner brief: slow assets never gate integration', () => {
  const planner = ROLES.executive!.instructions;

  it('starts integration and gameplay on a placeholder and plans the swap as a small later task', () => {
    expect(planner).toMatch(/Integration and gameplay work starts on a placeholder, never waiting for a slow asset/);
    expect(planner).toMatch(/flat pad, a stand-in model or a primitive/);
    expect(planner).toMatch(/swapping in the real asset is a\s+small later task that depends only on that asset/);
  });

  it('sits with the other dependency rules', () => {
    const rules = planner.indexOf('Dependency rules');
    const placeholder = planner.indexOf('starts on a placeholder');
    const chains = planner.indexOf('Chains at most 3 tasks deep');
    expect(rules).toBeGreaterThan(-1);
    expect(placeholder).toBeGreaterThan(rules);
    expect(placeholder).toBeLessThan(chains);
  });
});
