import { describe, expect, it } from 'vitest';
import { viewerYields } from '../src/core/rpc/router';

// A viewer read of a big place held every agent's Edit Luau behind it in the plugin's one-at-a-time line.
describe("the viewer's reads of the place", () => {
  it("give way while the team's work is in the plugin's line, and only then", () => {
    expect(viewerYields({ teamWorking: true, studioBusy: true })).toBe(true);
    expect(viewerYields({ teamWorking: true, studioBusy: false })).toBe(false);
    // Nobody working: the user's own look at the place is never put off.
    expect(viewerYields({ teamWorking: false, studioBusy: true })).toBe(false);
  });
});
