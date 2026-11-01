import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';

/**
 * What agents are told about asking (docs/ARCHITECTURE.md, "Permission modes"): questions are settled by the
 * planner and the director, and `escalate` is for what spends money or publishes the game — true in either mode.
 */

const planner = ROLES.executive!.instructions;
const skill = readFileSync(resolve(__dirname, '..', 'resources', 'skills', 'roblox-data-persistence', 'SKILL.md'), 'utf8');

describe('the planner brief on questions', () => {
  it('has the planner settle questions itself and keeps escalate for spending and publishing', () => {
    expect(planner).toMatch(/Questions get settled, not parked/);
    expect(planner).toMatch(/the planner and the director answer for the user/);
    expect(planner).toMatch(/escalate is\s+only for what spends money \(Robux, paid services\) or publishes the game/);
    expect(planner).toMatch(/wait for the owner in\s+every mode/);
    // The tool stays available for exactly that.
    expect(ROLES.executive!.appTools).toContain('escalate');
  });

  it('says nothing that is only true in one mode: no "the user will answer", no "ask the user" as the way out', () => {
    expect(planner).not.toMatch(/ask the user|the user will answer|wait for the user/i);
  });
});

describe('skill roblox-data-persistence', () => {
  it('no longer sends the Studio API setting to the user with escalate, and its version moved', () => {
    expect(skill).not.toMatch(/That setting is the user's call/);
    expect(skill).toMatch(/never wait for it/);
    expect(skill).toMatch(/`escalate` only if the task would also publish the game or spend money/);
    expect(/^version: (\d+)$/m.exec(skill)?.[1]).toBe('2');
  });
});
