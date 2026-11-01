import { describe, expect, it } from 'vitest';
import { Store } from '@core/db/store';
import { PROJECT_MIGRATIONS } from '@core/db/schema';
import { EventBus } from '@core/events';
import { TaskGraph } from '@core/tasks/task-graph';
import { AuditService } from '@core/audit/audit-service';

describe('task transitions', () => {
  it('lets finished work wait for the user (the place-change approval) instead of crashing the task', () => {
    const store = new Store(':memory:', PROJECT_MIGRATIONS);
    const bus = new EventBus();
    const tasks = new TaskGraph(store, bus, new AuditService(store, bus));
    const t = tasks.create({ kind: 'implement', title: 'Lighting', objective: 'x', role: 'environment-artist', status: 'ready', createdBy: 'test' });
    tasks.setStatus(t.id, 'running');
    tasks.setStatus(t.id, 'implemented');
    expect(tasks.setStatus(t.id, 'escalated', 'Removed 44 instances; waiting for approval').status).toBe('escalated');
    // Approved: it goes on.
    expect(tasks.setStatus(t.id, 'ready').status).toBe('ready');
  });
});

describe('playtest checks', () => {
  it('never fail on assets Roblox could not deliver to a local place (an avatar animation, a sound)', async () => {
    const { IGNORE_LINE } = await import('@core/verification/verifier');
    // Seen in every playtest of two different projects: nothing to do with the task being checked.
    expect(IGNORE_LINE.test('Failed to load animation with sanitized ID rbxassetid://100000000000008: Animation failed to load, assetId: https://assetdelivery.roblox.com/v1/asset?id=100000000000008&serverplaceid=0')).toBe(true);
    expect(IGNORE_LINE.test('Failed to load sound rbxassetid://1: Unable to download sound data')).toBe(true);
    // A script error still counts.
    expect(IGNORE_LINE.test('ServerScriptService.Drift:42: attempt to index nil with "Speed"')).toBe(false);
  });
});
