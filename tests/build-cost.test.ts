import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/db/store';
import { PROJECT_MIGRATIONS } from '../src/core/db/schema';
import { buildCost, costCategory, costOf } from '../src/core/costs/build-cost';
import { ROLES } from '../src/core/agents/roles';
import { PlainWords } from '../src/core/director/plain-words';
import { createRouter } from '../src/core/rpc/router';
import { usdText, type BuildCost } from '../src/shared/costs';
import { coreHarness } from './helpers/make-core';

/**
 * One API-equivalent cost per build (1.16): one number for everything a build used, Kiln and every process included.
 * Runs carry the SDK's API-price cost, Kiln's builds are runs with role "kiln", and the small quick calls of a project
 * are booked in cost_entries.
 */

function task(store: Store, id: string, kind: string, parent: string | null, title = id, status = 'running', at = '2026-10-20T10:00:00.000Z') {
  store.run(`INSERT INTO tasks (id, parent_id, kind, title, objective, role, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'executive', ?, 'test', ?, ?)`, [id, parent, kind, title, status, at, at]);
}
let n = 0;
function run(store: Store, role: string, cost: number, taskId: string | null = null, started = '2026-10-20T10:00:00.000Z', ended: string | null = started) {
  store.run(`INSERT INTO runs (id, task_id, role, provider_id, status, started_at, ended_at, cost_usd) VALUES (?, ?, ?, 'claude', 'completed', ?, ?, ?)`, [`run_${++n}`, taskId, role, started, ended, cost]);
}

describe('what each role counts as', () => {
  it('groups every role of the app, the copilots and Kiln', () => {
    const cases: Record<string, string> = {
      'roblox-engineer': 'building',
      'luau-engineer': 'building',
      'level-designer': 'building',
      modeler: 'building',
      'game-designer': 'building',
      'thumbnail-artist': 'building',
      'qa-engineer': 'building',
      executive: 'planning',
      architect: 'planning',
      planner: 'planning',
      critic: 'reviews',
      'image-checker': 'reviews',
      'ui-phone-reviewer': 'reviews',
      'thumb-judge': 'reviews',
      director: 'director',
      suggester: 'director',
      'copilot-animation': 'copilots',
      'copilot-ui': 'copilots',
      kiln: 'kiln',
      researcher: 'research',
      'reference-analyst': 'research',
      analyst: 'research',
      'plain-words': 'helpers',
      'something-new': 'helpers',
    };
    for (const [role, cat] of Object.entries(cases)) expect(costCategory(role), role).toBe(cat);
    // Every specialist the planner can hand a task to is building, without a list to keep up to date.
    for (const r of Object.values(ROLES).filter((x) => x.output === 'work' && x.id !== 'architect')) expect(costCategory(r.id), r.id).toBe('building');
  });
});

describe('a build’s cost', () => {
  it('adds runs, Kiln and booked calls, by group and by goal (a run’s task followed up to its objective)', () => {
    const store = new Store(':memory:', PROJECT_MIGRATIONS);
    task(store, 'goal1', 'objective', null, 'Drift game', 'done', '2026-10-20T09:00:00.000Z');
    task(store, 'plan1', 'plan', 'goal1');
    task(store, 'impl1', 'implement', 'plan1');
    task(store, 'impl2', 'implement', 'goal1');
    task(store, 'goal2', 'objective', null, 'Add a garage', 'running', '2026-10-21T09:00:00.000Z');
    task(store, 'impl3', 'implement', 'goal2');
    task(store, 'goal3', 'objective', null, 'Dropped idea', 'cancelled', '2026-10-22T09:00:00.000Z');
    run(store, 'executive', 1.5, 'plan1', '2026-10-20T09:01:00.000Z', '2026-10-20T09:10:00.000Z');
    run(store, 'roblox-engineer', 4.25, 'impl1');
    run(store, 'critic', 0.75, 'impl1');
    run(store, 'kiln', 2, 'impl2');
    run(store, 'modeler', 3, 'impl3', '2026-10-21T10:00:00.000Z', '2026-10-21T12:30:00.000Z');
    run(store, 'director', 0.2, null);
    run(store, 'copilot-audio', 0.35, null);
    run(store, 'director', 0, null);
    store.run(`INSERT INTO cost_entries (id, at, source, label, cost_usd, task_id) VALUES ('c1', '2026-10-21T13:00:00.000Z', 'plain-words', 'A status line', 0.01, NULL)`);
    store.run(`INSERT INTO cost_entries (id, at, source, label, cost_usd, task_id) VALUES ('c2', '2026-10-21T13:05:00.000Z', 'thumb-judge', 'Picking', 0.05, 'impl3')`);

    const c = costOf(store);
    expect(c.totalUsd).toBeCloseTo(12.11, 4);
    expect(c.kilnUsd).toBe(2);
    expect(c.since).toBe('2026-10-20T09:01:00.000Z');
    expect(c.until).toBe('2026-10-21T13:05:00.000Z');
    const cat = Object.fromEntries(c.categories.map((x) => [x.id, x]));
    expect(cat.building).toMatchObject({ label: 'Building', usd: 7.25, runs: 2 });
    expect(cat.planning).toMatchObject({ usd: 1.5, runs: 1 });
    expect(cat.reviews).toMatchObject({ usd: 0.8, runs: 2 });
    expect(cat.director).toMatchObject({ label: 'Director & chat', usd: 0.2, runs: 2 });
    expect(cat.copilots!.usd).toBe(0.35);
    expect(cat.kiln).toMatchObject({ label: 'Kiln models', usd: 2 });
    expect(cat.helpers).toMatchObject({ usd: 0.01, runs: 1 });
    expect(cat.research).toBeUndefined();
    // The most expensive first; the shares add up to the total.
    expect(c.categories[0]!.id).toBe('building');
    expect(c.categories.reduce((a, x) => a + x.usd, 0)).toBeCloseTo(c.totalUsd, 4);
    expect(c.goals).toEqual([
      { id: 'goal1', title: 'Drift game', usd: 8.5, status: 'done' },
      { id: 'goal2', title: 'Add a garage', usd: 3.05, status: 'running' },
      { id: 'goal3', title: 'Dropped idea', usd: 0, status: 'cancelled' },
    ]);
    store.close();
  });

  it('is nothing for a project with no runs, and reads a project from before cost_entries', () => {
    const empty = new Store(':memory:', PROJECT_MIGRATIONS);
    expect(costOf(empty)).toMatchObject({ totalUsd: 0, categories: [], goals: [], since: null });
    empty.close();
    const old = new Store(':memory:', PROJECT_MIGRATIONS.filter((m) => m.version < 11));
    run(old, 'roblox-engineer', 1.25);
    expect(costOf(old)).toMatchObject({ totalUsd: 1.25, categories: [{ id: 'building', usd: 1.25, runs: 1 }] });
    old.close();
  });

  it('reads another project folder read-only, and a folder that is no project as nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-cost-'));
    const file = join(root, '.shuriken', 'project.db');
    const store = new Store(file, PROJECT_MIGRATIONS);
    run(store, 'kiln', 3.5);
    run(store, 'critic', 0.5);
    // Still open in "another window": the read goes in beside it.
    expect(buildCost(root)).toMatchObject({ totalUsd: 4, kilnUsd: 3.5 });
    store.close();
    const before = statSync(file).mtimeMs;
    expect(buildCost(root).totalUsd).toBe(4);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(buildCost(join(root, 'nope'))).toMatchObject({ totalUsd: 0, categories: [] });
    expect(buildCost('')).toMatchObject({ totalUsd: 0 });
    // A database with none of the tables (not a project) is nothing too, and stays untouched.
    const other = mkdtempSync(join(tmpdir(), 'shuriken-cost-'));
    mkdirSync(join(other, '.shuriken'));
    new DatabaseSync(join(other, '.shuriken', 'project.db')).close();
    expect(buildCost(other)).toMatchObject({ totalUsd: 0, goals: [] });
  });

  it('says the amount plainly', () => {
    expect(usdText(48.2)).toBe('$48.20');
    expect(usdText(1234.5)).toBe('$1,234.50');
    expect(usdText(0.004)).toBe('<$0.01');
    expect(usdText(0)).toBe('$0.00');
  });
});

describe('the small calls of a project', () => {
  const makeCore = coreHarness();

  it('quick books its cost in the project it is given (plain words), and nothing without one', async () => {
    const { core, ctx } = await makeCore({ respond: async (req) => (req.role === 'plain-words' ? { title: 'The shop screen is ready', text: 'The shop screen is ready.' } : null) });
    core.orchestrator.pause();
    await core.runner.quick({ role: ROLES['plain-words']!, prompt: 'x', cwd: ctx.root, signal: new AbortController().signal });
    expect(ctx.store.all('SELECT * FROM cost_entries')).toHaveLength(0);
    const words = new PlainWords({ runner: core.runner, log: core.logger.scope('test'), enabled: () => true });
    expect(await words.line(ctx, 'task_123 done: ui-engineer finished the ShopGui')).toBe('The shop screen is ready.');
    const rows = ctx.store.all<{ source: string; label: string; cost_usd: number }>('SELECT source, label, cost_usd FROM cost_entries');
    expect(rows).toEqual([{ source: 'plain-words', label: 'A status line in plain words', cost_usd: 0.001 }]);
    const c = costOf(ctx.store);
    expect(c.categories.find((x) => x.id === 'helpers')).toMatchObject({ usd: 0.001, runs: 1 });
  });

  it('costs.build reads the open project, costs.forRoot any folder', async () => {
    const { core, ctx, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    run(ctx.store, 'kiln', 2.5);
    const rpc = createRouter(core) as unknown as Record<string, (a?: unknown) => unknown>;
    expect((rpc['costs.build']!() as BuildCost).totalUsd).toBe(2.5);
    expect((rpc['costs.forRoot']!({ root }) as BuildCost).kilnUsd).toBe(2.5);
    const other = mkdtempSync(join(tmpdir(), 'shuriken-cost-'));
    const s = new Store(join(other, '.shuriken', 'project.db'), PROJECT_MIGRATIONS);
    run(s, 'researcher', 0.75);
    s.close();
    expect((rpc['costs.forRoot']!({ root: other }) as BuildCost).categories).toEqual([{ id: 'research', label: 'Research', usd: 0.75, runs: 1 }]);
    core.closeProject();
    expect(rpc['costs.build']!()).toBeNull();
  });
});
