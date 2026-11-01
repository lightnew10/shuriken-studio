import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCall } from '../src/core/director/activity';
import { coreHarness } from './helpers/make-core';

/**
 * Every agent tool has a plain label where the user reads what an agent is doing: the director's activity summary
 * (describeCall) and the activity feed / run steps in the UI (describeTool in the renderer). A tool added without
 * one shows its raw name ("test retire", "Using wait for"); this fails until it has a label in both.
 */

const makeCore = coreHarness();

/** The keys of describeTool's table, read from its source (the renderer can't be imported here). */
function rendererLabels(): Set<string> {
  const src = readFileSync(resolve(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'project.ts'), 'utf8');
  const body = src.slice(src.indexOf('const table: Record<string, string> = {'), src.indexOf('return table[tool]'));
  return new Set([...body.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]!));
}

describe('tool labels', () => {
  it('every registered tool has a friendly label in the director summary and in the UI', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const names = core.tools.all().map((t) => t.name);
    expect(names.length).toBeGreaterThan(80);
    const ui = rendererLabels();
    expect(ui.size).toBeGreaterThan(80);

    const rawInDirector = names.filter((n) => describeCall(`mcp__shuriken__${n}`, {}) === n.replace(/_/g, ' '));
    const missingInUi = names.filter((n) => !ui.has(n));
    expect(rawInDirector, 'tools the director summary names by their raw name').toEqual([]);
    expect(missingInUi, 'tools with no label in lib/project.ts describeTool').toEqual([]);
  });

  it('labels the tools added in 1.9 in plain words', () => {
    expect(describeCall('mcp__shuriken__test_retire', {})).toBe('retiring an outdated test');
    expect(describeCall('mcp__shuriken__task_update_verification', {})).toBe("changing a task's checks");
    expect(describeCall('mcp__shuriken__test_list', {})).toBe('looking at the saved tests');
    expect(describeCall('mcp__shuriken__wait_for', { what: 'upload' })).toBe('waiting for uploads to Roblox');
    expect(describeCall('mcp__shuriken__wait_for', { what: 'kiln_turn' })).toBe("waiting for Kiln's copilot");
    expect(describeCall('mcp__shuriken__wait_for', { what: 'studio_edit' })).toBe('waiting for Studio to be free');
    // An unknown tool still gets a readable fallback.
    expect(describeCall('mcp__shuriken__some_new_tool', {})).toBe('some new tool');
  });
});
