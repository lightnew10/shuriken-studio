import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@core/db/store';
import { PROJECT_MIGRATIONS } from '@core/db/schema';
import { EventBus } from '@core/events';
import { TaskGraph } from '@core/tasks/task-graph';
import { AuditService } from '@core/audit/audit-service';
import { slimTask } from '@core/tasks/slim';
import { PENDING_LINE } from '@core/orchestrator/visual-checks';

const graph = (store = new Store(':memory:', PROJECT_MIGRATIONS)) => {
  const bus = new EventBus();
  return { store, tasks: new TaskGraph(store, bus, new AuditService(store, bus)) };
};
const add = (tasks: TaskGraph, title: string, status: 'ready' | 'proposed' = 'ready', parentId?: string) =>
  tasks.create({ kind: 'implement', title, objective: 'x', role: 'roblox-engineer', status, createdBy: 'test', parentId });

// A big project's scheduling pass read every task from SQLite five times: the graph keeps them while nothing writes.
describe('the task graph’s kept list', () => {
  it('sees every write: its own, direct SQL, links, and a rolled-back transaction', () => {
    const { store, tasks } = graph();
    const a = add(tasks, 'A');
    const b = add(tasks, 'B');
    expect(tasks.list().map((t) => t.title)).toEqual(['A', 'B']);
    // Direct SQL (as tests and migrations do) is seen.
    store.run('UPDATE tasks SET title = ? WHERE id = ?', ['A2', a.id]);
    expect(tasks.get(a.id)!.title).toBe('A2');
    expect(tasks.list().map((t) => t.title)).toEqual(['A2', 'B']);
    // A link changes what can run.
    tasks.addDependency(b.id, a.id);
    expect(tasks.runnable().map((t) => t.title)).toEqual(['A2']);
    expect(tasks.get(b.id)!.dependencies).toEqual([a.id]);
    // A transaction that rolls back leaves the list as it was, and a write after it is still seen.
    expect(() =>
      store.tx(() => {
        store.run('UPDATE tasks SET title = ? WHERE id = ?', ['inside', b.id]);
        expect(tasks.get(b.id)!.title).toBe('inside');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(tasks.get(b.id)!.title).toBe('B');
    store.run('UPDATE tasks SET title = ? WHERE id = ?', ['B2', b.id]);
    expect(tasks.list().map((t) => t.title)).toEqual(['A2', 'B2']);
    tasks.delete(a.id);
    expect(tasks.list().map((t) => t.title)).toEqual(['B2']);
  });

  it('gives copies, filters as SQLite did, and sees another connection’s commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-cache-'));
    try {
      const file = join(dir, 'project.db');
      const one = graph(new Store(file, PROJECT_MIGRATIONS));
      const other = graph(new Store(file, PROJECT_MIGRATIONS));
      const goal = one.tasks.create({ kind: 'objective', title: 'Goal', objective: 'x', role: 'executive', status: 'ready', createdBy: 'test' });
      add(one.tasks, 'Kid', 'proposed', goal.id);
      add(one.tasks, 'Loose');
      const first = one.tasks.list();
      first[0]!.title = 'changed by a caller';
      expect(one.tasks.list()[0]!.title).toBe('Goal');
      expect(one.tasks.list({ parentId: goal.id }).map((t) => t.title)).toEqual(['Kid']);
      expect(one.tasks.list({ parentId: null }).map((t) => t.title)).toEqual(['Goal', 'Loose']);
      expect(one.tasks.list({ statuses: ['proposed'] }).map((t) => t.title)).toEqual(['Kid']);
      expect(one.tasks.list({ kinds: ['objective'], statuses: ['ready'] }).map((t) => t.title)).toEqual(['Goal']);
      // Written through another connection to the same file.
      other.store.run("UPDATE tasks SET title = 'Loose2' WHERE title = 'Loose'");
      expect(one.tasks.list().map((t) => t.title)).toEqual(['Goal', 'Kid', 'Loose2']);
      one.store.close();
      other.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('slim task lists', () => {
  it('carry a few lines and keep the unseen-looks line', () => {
    const { tasks } = graph();
    const t = add(tasks, 'Paint');
    const long = { ...tasks.get(t.id)!, objective: 'o'.repeat(5000), result: `${'r'.repeat(2000)}\n${PENDING_LINE}`, acceptanceCriteria: ['a'], verification: [{ kind: 'static_analysis' as const, name: 'x' }] };
    const slim = slimTask(long as never);
    expect(slim.objective.length).toBeLessThanOrEqual(601);
    expect(slim.result!.length).toBeLessThan(PENDING_LINE.length + 310);
    expect(slim.result).toContain(PENDING_LINE);
    expect(slim.acceptanceCriteria).toEqual([]);
    expect(slim.verification).toEqual([]);
    expect(slimTask({ ...long, result: 'short' } as never).result).toBe('short');
  });
});
