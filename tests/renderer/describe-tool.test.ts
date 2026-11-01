import { beforeAll, describe, expect, it, vi } from 'vitest';

// The activity feed and the run steps name what an agent does in plain words (lib/project.ts describeTool).
// project.ts reaches for window.shuriken when it loads, so the bridge is stubbed before it is imported.

let describeTool: (raw: string) => string;

beforeAll(async () => {
  vi.stubGlobal('window', { shuriken: { invoke: async () => null, on: () => () => undefined } });
  ({ describeTool } = await import('../../src/renderer/src/lib/project'));
});

describe('describeTool', () => {
  it('labels the tools added in 1.9 instead of showing raw names', () => {
    expect(describeTool('test_retire {"test":"road_not_green"}')).toBe('Retiring an outdated test');
    expect(describeTool('task_update_verification {"task":"t1"}')).toBe("Changing a task's checks");
    expect(describeTool('test_list {}')).toBe('Looking at the saved tests');
    expect(describeTool('mcp__shuriken__wait_for {"what":"upload"}')).toBe('Waiting for uploads to Roblox');
    expect(describeTool('mcp__shuriken__wait_for {"what":"kiln_turn","model":"Griever"}')).toBe("Waiting for Kiln's copilot");
    expect(describeTool('mcp__shuriken__wait_for {"what":"studio_edit"}')).toBe('Waiting for Studio to be free');
    expect(describeTool('kiln_request {"turn":true}')).toBe("Waiting for Kiln's copilot");
    expect(describeTool('kiln_request {"model":"Griever","goal":"a creature"}')).toBe("Briefing Kiln's copilot");
  });

  it('keeps the existing labels and the readable fallback', () => {
    expect(describeTool('Edit {"file_path":"C:\\\\game\\\\src\\\\Combat.luau"}')).toBe('Editing Combat.luau');
    expect(describeTool('mcp__shuriken__roblox_playtest {}')).toBe('Playtesting');
    expect(describeTool('some_new_tool {}')).toBe('Using some new tool');
  });
});
