import { describe, expect, it } from 'vitest';
import { roleLabels } from '@core/agents/roles';
import { COPILOT_IDS, COPILOT_ROLES } from '@core/copilots/copilot-roles';

// The UI names roles from this table (RPC roles.labels): a run of any role reads as words, never an id.
describe('role labels', () => {
  it('names every role a run can have, the dock copilots included', () => {
    const labels = roleLabels();
    const ids = ['director', 'critic', 'analyst', 'executive', 'suggester', 'researcher', 'roblox-engineer', ...COPILOT_IDS.map((c) => COPILOT_ROLES[c].id)];
    for (const id of ids) expect(labels[id], id).toMatch(/^[A-Z0-9]/);
    expect(labels['copilot-audio']).toBe('Music & sound copilot');
    expect(labels.critic).toBe('Reviewer');
  });
});
