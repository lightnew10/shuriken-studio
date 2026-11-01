import { describe, expect, it } from 'vitest';
import { createRouter } from '../src/core/rpc/router';
import { coreHarness } from './helpers/make-core';

/**
 * The RPCs behind Settings → Agents → Permissions and the Agents page's "Decided without asking" list: the app
 * preference and a project's own choice reach the engine, and the list of auto-resolved decisions is the one the
 * page reads (docs/ARCHITECTURE.md, "Permission modes").
 */

const makeCore = coreHarness();
type Rpc = Record<string, (a?: unknown) => Promise<unknown> | unknown>;

describe('permission mode over RPC', () => {
  it('app.prefs.update carries the mode and the engine follows it', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const rpc = createRouter(core) as unknown as Rpc;
    expect(((await rpc['app.prefs']!()) as { permissionMode: string }).permissionMode).toBe('autonomous');
    await rpc['app.prefs.update']!({ permissionMode: 'ask' });
    expect(((await rpc['app.prefs']!()) as { permissionMode: string }).permissionMode).toBe('ask');
    expect(core.permissionMode()).toBe('ask');
    // Another preference changed from the same page leaves it alone.
    await rpc['app.prefs.update']!({ agentEffort: 'medium' });
    expect(core.permissionMode()).toBe('ask');
    await rpc['app.prefs.update']!({ permissionMode: 'autonomous' });
    expect(core.permissionMode()).toBe('autonomous');
  });

  it('project.settings.update sets a project override that wins over the app, and null returns to the app', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const rpc = createRouter(core) as unknown as Rpc;
    const stored = async () => ((await rpc['project.settings']!()) as { settings: { permissionMode?: string | null } }).settings.permissionMode ?? null;
    expect(await stored()).toBeNull();

    await rpc['app.prefs.update']!({ permissionMode: 'ask' });
    await rpc['project.settings.update']!({ settings: { permissionMode: 'autonomous' } });
    expect(await stored()).toBe('autonomous');
    expect(core.permissionMode()).toBe('autonomous');

    await rpc['project.settings.update']!({ settings: { permissionMode: null } });
    expect(await stored()).toBeNull();
    expect(core.permissionMode()).toBe('ask');

    await rpc['app.prefs.update']!({ permissionMode: 'autonomous' });
    await rpc['project.settings.update']!({ settings: { permissionMode: 'ask' } });
    expect(core.permissionMode()).toBe('ask');
    // Moving the app preference does not undo a project's own choice.
    await rpc['app.prefs.update']!({ permissionMode: 'autonomous' });
    expect(await stored()).toBe('ask');
    expect(core.permissionMode()).toBe('ask');
  });
});

describe('the list of decisions made without asking', () => {
  it('escalations.list { status: auto_resolved } returns only those, newest first, with their task', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    const rpc = createRouter(core) as unknown as Rpc;
    const task = ctx.tasks.create({ kind: 'implement', title: 'Build the arena', objective: 'Build it.', role: 'level-designer', createdBy: 'test' });
    const first = ctx.governance.autoResolve({ kind: 'question', title: 'Which arena size?', detail: 'Small or large.', taskId: task.id, response: 'Large: the user asked for 12 players.' });
    await new Promise((r) => setTimeout(r, 5));
    const second = ctx.governance.autoResolve({ kind: 'approval', title: 'Remove 30 old parts', detail: 'Cleanup.', taskId: task.id, response: 'Went ahead.' });
    ctx.governance.escalate({ kind: 'question', title: 'Spend 100 Robux on a banner?', detail: 'Paid asset.' });

    const list = (await rpc['escalations.list']!({ status: 'auto_resolved' })) as Array<{ id: string; status: string; taskId: string | null; response: string | null }>;
    expect(list.map((e) => e.id)).toEqual([second.id, first.id]);
    expect(list.every((e) => e.status === 'auto_resolved')).toBe(true);
    expect(list[1]).toMatchObject({ taskId: task.id, response: 'Large: the user asked for 12 players.' });
    // The question that must ask stays open and is not in the list.
    expect(((await rpc['escalations.list']!({ status: 'open' })) as unknown[]).length).toBe(1);
  });
});
