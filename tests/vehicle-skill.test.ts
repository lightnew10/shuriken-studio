import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@core/agents/roles';
import { parseSkillFile } from '@core/skills/skill-service';

// Skill roblox-vehicle-handling: the lessons of the first drift build (launch, steering sized by grip, balance,
// assists, differential, stability) with a reference model, a chassis and the acceptance checks. Its Luau is
// linted in tests/skills-lint.test.ts.
const md = readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-vehicle-handling', 'SKILL.md'), 'utf8');
const { meta, body } = parseSkillFile(md);

describe('skill roblox-vehicle-handling', () => {
  it('follows the conventions of the other skills', () => {
    expect(meta.name).toBe('roblox-vehicle-handling');
    expect(String(meta.description).length).toBeGreaterThan(200);
    expect(String(meta.description)).toMatch(/Read before building or tuning any vehicle/);
    expect(Number(meta.version)).toBeGreaterThanOrEqual(1);
    expect(meta.tags).toEqual(expect.arrayContaining(['vehicle', 'car', 'drift', 'racing', 'kart']));
    expect(meta.roblox_systems).toEqual(expect.arrayContaining(['VehicleSeat', 'RaycastParams']));
    expect(String(meta.version_applicability)).toMatch(/^Roblox Studio 0\.7/);
  });

  it('stays dense: 250-400 lines', () => {
    const lines = md.trimEnd().split(/\r?\n/).length;
    expect(lines).toBeGreaterThanOrEqual(250);
    expect(lines).toBeLessThanOrEqual(400);
  });

  it('has every part: architecture, units and gravity, the model, tuning, presets, drift, input, acceptance, traps, sources', () => {
    for (const part of ['## Pick the architecture', '## Units and gravity', '## Reference implementation', '## Tuning', '## Presets', '## Drift', '## Input, camera, feedback', '## Acceptance checks', '## Traps', '## Sources']) {
      expect(body, part).toContain(part);
    }
    for (const fact of ['0.28 m', '196.2', 'friction circle', 'launchLimit', 'atan(L·mu·g_v/v²)', 'limited slip', 'SetNetworkOwner', 'VehicleSeat', 'SpringConstraint', 'https://create.roblox.com/docs/']) {
      expect(body, fact).toContain(fact);
    }
  });

  it('lists the acceptance checks a playtest driver runs', () => {
    for (const check of ['0-100 and 0-60 mph', 'Hands-off straight', 'Symmetry', 'No limit cycle', 'Held drift follows the throttle', 'Keyboard tap vs hold', 'Reset/respawn', 'A full lap']) {
      expect(body, check).toContain(check);
    }
  });

  it('ships Luau in strict mode: the model, the chassis and the scripted driver', () => {
    const blocks = [...md.matchAll(/```lua\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBe(3);
    for (const b of blocks) expect(b.startsWith('--!strict')).toBe(true);
    expect(blocks[0]).toContain('function Vehicle.step');
    expect(blocks[1]).toContain('ApplyImpulseAtPosition');
    expect(blocks[2]).toContain('SetAttribute');
  });

  it('is wired in: the engineer follows it and the executive plans it into vehicle tasks', () => {
    expect(ROLES['roblox-engineer']!.instructions).toContain('roblox-vehicle-handling');
    expect(ROLES['roblox-engineer']!.instructions).toContain('acceptance checks');
    expect(ROLES['executive']!.instructions).toContain('roblox-vehicle-handling');
    expect(ROLES['executive']!.instructions).toContain('requiredSkills');
  });
});
